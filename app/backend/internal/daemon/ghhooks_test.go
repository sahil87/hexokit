package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rk/internal/ghhooks"
	"rk/internal/portpolicy"
)

// fakeGHHooksTmux models the rk-gh-hooks session: its windows, and every tmux
// argv the ensure issued.
type fakeGHHooksTmux struct {
	windows   []ghHooksWindow
	argv      [][]string
	daemonUp  bool
	probes    map[string]ghhooks.ProbeResult
	extension bool
	extChecks int
	nextID    int
}

func (f *fakeGHHooksTmux) names() []string {
	var out []string
	for _, w := range f.windows {
		out = append(out, w.name)
	}
	sort.Strings(out)
	return out
}

func (f *fakeGHHooksTmux) add(name string, dead bool) {
	f.nextID++
	f.windows = append(f.windows, ghHooksWindow{id: fmt.Sprintf("@%d", f.nextID), name: name, dead: dead})
}

func (f *fakeGHHooksTmux) run(_ context.Context, args ...string) error {
	f.argv = append(f.argv, append([]string(nil), args...))
	flag := func(name string) string {
		for i, a := range args {
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	switch args[0] {
	case "new-session":
		if len(f.windows) > 0 {
			return errors.New("duplicate session")
		}
		f.add(flag("-n"), false)
	case "new-window":
		f.add(flag("-n"), false)
	case "kill-window":
		id := flag("-t")
		for i, w := range f.windows {
			if w.id == id {
				f.windows = append(f.windows[:i], f.windows[i+1:]...)
				break
			}
		}
	case "kill-session":
		f.windows = nil
	}
	return nil
}

func (f *fakeGHHooksTmux) output(_ context.Context, args ...string) ([]byte, error) {
	f.argv = append(f.argv, append([]string(nil), args...))
	var lines []string
	for _, w := range f.windows {
		dead := "0"
		if w.dead {
			dead = "1"
		}
		lines = append(lines, w.id+" "+dead+" "+w.name)
	}
	return []byte(strings.Join(lines, "\n") + "\n"), nil
}

// spawned returns the shell-free argv tails of every new-session/new-window.
func (f *fakeGHHooksTmux) spawned() [][]string {
	var out [][]string
	for _, a := range f.argv {
		if a[0] == "new-session" || a[0] == "new-window" {
			out = append(out, a)
		}
	}
	return out
}

func (f *fakeGHHooksTmux) issued(verb string) int {
	n := 0
	for _, a := range f.argv {
		if a[0] == verb {
			n++
		}
	}
	return n
}

func withGHHooksSeams(t *testing.T, repos ...string) *fakeGHHooksTmux {
	t.Helper()
	f := &fakeGHHooksTmux{daemonUp: true, extension: true, probes: map[string]ghhooks.ProbeResult{}}
	origDaemon, origExists := jobDaemonRunning, ghHooksSessionExists
	origTmux, origOut, origSelf := ghHooksTmux, ghHooksTmuxOutput, ghHooksSelfPath
	origProbe, origExt := ghHooksProbeAdmin, ghHooksExtension
	t.Cleanup(func() {
		jobDaemonRunning, ghHooksSessionExists = origDaemon, origExists
		ghHooksTmux, ghHooksTmuxOutput, ghHooksSelfPath = origTmux, origOut, origSelf
		ghHooksProbeAdmin, ghHooksExtension = origProbe, origExt
	})
	jobDaemonRunning = func(context.Context) bool { return f.daemonUp }
	ghHooksSessionExists = func(context.Context) bool { return len(f.windows) > 0 }
	ghHooksTmux, ghHooksTmuxOutput = f.run, f.output
	ghHooksSelfPath = func() (string, error) { return "/opt/rk dir/rk", nil }
	ghHooksProbeAdmin = func(_ context.Context, nwo string) ghhooks.ProbeResult { return f.probes[nwo] }
	ghHooksExtension = func(context.Context) bool { f.extChecks++; return f.extension }

	dir := t.TempDir()
	t.Setenv("RK_CONFIG_DIR", dir)
	var b strings.Builder
	if len(repos) > 0 {
		b.WriteString("operator.pr_hooks:\n")
		for _, r := range repos {
			b.WriteString("  - \"" + r + "\"\n")
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

var (
	probeAdmin   = ghhooks.ProbeResult{Admin: ghhooks.AdminYes}
	probeNoAdmin = ghhooks.ProbeResult{Admin: ghhooks.AdminNo}
)

func TestEnsureGHHooksBuildsReceiverAndAdminForwardersOnly(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin", "b/noadmin", "c/failed")
	f.probes = map[string]ghhooks.ProbeResult{
		"a/admin": probeAdmin, "b/noadmin": probeNoAdmin,
		"c/failed": {Err: errors.New("gh: timeout")},
	}
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if want := []string{"fwd-a--admin", "receiver"}; !reflect.DeepEqual(f.names(), want) {
		t.Fatalf("windows = %v, want %v (no window for a repo without admin)", f.names(), want)
	}
	port := fmt.Sprint(portpolicy.GHHooks)
	want := [][]string{
		{"new-session", "-d", "-s", "rk-gh-hooks", "-n", "receiver", "/opt/rk dir/rk", "operator", "hooks", "serve", "--port", port},
		{"new-window", "-d", "-t", "=rk-gh-hooks:", "-n", "fwd-a--admin", "/opt/rk dir/rk", "operator", "hooks", "forward", "--repo", "a/admin", "--port", port},
	}
	if got := f.spawned(); !reflect.DeepEqual(got, want) {
		t.Errorf("spawns = %v\nwant %v", got, want)
	}
}

func TestEnsureGHHooksNonAdminRepoBuildsNothing(t *testing.T) {
	f := withGHHooksSeams(t, "b/noadmin")
	f.probes["b/noadmin"] = probeNoAdmin
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(f.spawned()) != 0 || len(f.windows) != 0 {
		t.Errorf("spawns = %v windows = %v, want no process for a repo without admin", f.spawned(), f.names())
	}
	if f.extChecks != 0 {
		t.Error("the extension is only checked when there is a forwarder to start")
	}
}

func TestEnsureGHHooksEmptyListKillsStaleSession(t *testing.T) {
	f := withGHHooksSeams(t)
	f.add("receiver", false)
	f.add("fwd-a--admin", false)
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(f.windows) != 0 {
		t.Errorf("windows = %v, want the session killed", f.names())
	}
	want := []string{"kill-session", "-t", "=rk-gh-hooks"}
	if last := f.argv[len(f.argv)-1]; !reflect.DeepEqual(last, want) {
		t.Errorf("last tmux call = %v, want an exact-match kill %v", last, want)
	}
}

func TestEnsureGHHooksEmptyListNoSessionTouchesNoTmux(t *testing.T) {
	f := withGHHooksSeams(t)
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if f.issued("kill-session")+f.issued("new-session")+f.issued("new-window") != 0 {
		t.Errorf("tmux argv = %v, want no mutation", f.argv)
	}
}

func TestEnsureGHHooksReconcilesStaleWindows(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin", "now/noadmin")
	f.probes = map[string]ghhooks.ProbeResult{"a/admin": probeAdmin, "now/noadmin": probeNoAdmin}
	f.add("receiver", false)
	f.add("fwd-a--admin", false)
	f.add("fwd-now--noadmin", false) // was admin, no longer
	f.add("fwd-gone--repo", false)   // no longer listed
	f.add("someone-elses-window", false)
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if want := []string{"fwd-a--admin", "receiver", "someone-elses-window"}; !reflect.DeepEqual(f.names(), want) {
		t.Errorf("windows = %v, want %v", f.names(), want)
	}
	if len(f.spawned()) != 0 {
		t.Errorf("a fully reconciled session spawned %v", f.spawned())
	}
	if f.extChecks != 0 {
		t.Error("no forwarder was missing, so the extension must not be checked")
	}
}

func TestEnsureGHHooksProbeFailureKeepsAWorkingForwarder(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = ghhooks.ProbeResult{Err: errors.New("gh: network unreachable")}
	f.add("receiver", false)
	f.add("fwd-a--admin", false)
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if want := []string{"fwd-a--admin", "receiver"}; !reflect.DeepEqual(f.names(), want) {
		t.Errorf("windows = %v, want a network blip to leave the forwarder alone", f.names())
	}
}

func TestEnsureGHHooksReplacesDeadWindows(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = probeAdmin
	f.add("receiver", false)
	f.add("fwd-a--admin", true)
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	spawned := f.spawned()
	if len(spawned) != 1 || spawned[0][0] != "new-window" || !slices.Contains(spawned[0], "fwd-a--admin") {
		t.Errorf("spawns = %v, want the dead forwarder window replaced", spawned)
	}
	if f.issued("kill-window") != 1 {
		t.Errorf("kill-window calls = %d, want the dead window removed once", f.issued("kill-window"))
	}
	for _, w := range f.windows {
		if w.dead {
			t.Errorf("dead window %q left behind", w.name)
		}
	}
}

func TestEnsureGHHooksAllWindowsDeadBirthsANewSession(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = probeAdmin
	f.add("receiver", true)
	// Killing the last window ends the real session; the fake models that.
	run := f.run
	ghHooksTmux = func(ctx context.Context, args ...string) error {
		err := run(ctx, args...)
		if args[0] == "kill-window" && len(f.windows) == 0 {
			return nil
		}
		return err
	}
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if want := []string{"fwd-a--admin", "receiver"}; !reflect.DeepEqual(f.names(), want) {
		t.Errorf("windows = %v, want %v", f.names(), want)
	}
	if got := f.spawned(); got[0][0] != "new-session" {
		t.Errorf("first spawn = %v, want a new session once no live window remains", got[0])
	}
}

func TestEnsureGHHooksExtensionAbsentSpawnsNoForwarder(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = probeAdmin
	f.extension = false
	if err := ensureGHHooksCore(context.Background()); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(f.windows) != 0 || len(f.spawned()) != 0 {
		t.Errorf("windows = %v, want nothing built without the extension", f.names())
	}
}

func TestEnsureGHHooksDaemonDownTouchesNoTmux(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = probeAdmin
	f.daemonUp = false
	if err := ensureGHHooksCore(context.Background()); !errors.Is(err, errGHHooksDaemonDown) {
		t.Errorf("err = %v, want the daemon-down error", err)
	}
	if len(f.argv) != 0 {
		t.Errorf("tmux argv = %v, want none with the daemon down", f.argv)
	}
	ensureGHHooks() // best-effort wrapper: must neither panic nor fail
}

func TestEnsureGHHooksSpawnFailureIsAnErrorNotAPanic(t *testing.T) {
	f := withGHHooksSeams(t, "a/admin")
	f.probes["a/admin"] = probeAdmin
	ghHooksTmux = func(context.Context, ...string) error { return errors.New("tmux: no space") }
	if err := ensureGHHooksCore(context.Background()); err == nil {
		t.Error("a failed spawn must be reported to the caller")
	}
	ensureGHHooks() // logged and swallowed
}

func TestGHHooksForwarderWindowName(t *testing.T) {
	cases := map[string]string{
		"sahil87/hexokit":                 "fwd-sahil87--hexokit",
		"sahil-noon/conductor-playground": "fwd-sahil-noon--conductor-playground",
		"o/dot.name":                      "fwd-o--dot_name",
	}
	for nwo, want := range cases {
		if got := ghHooksForwarderWindow(nwo); got != want {
			t.Errorf("window(%q) = %q, want %q", nwo, got, want)
		}
	}
	if ghHooksForwarderWindow("a-b/c") == ghHooksForwarderWindow("a/b-c") {
		t.Error("owner/name pairs that differ only by where the hyphen falls must not share a window")
	}
}

func TestKillGHHooksSession(t *testing.T) {
	f := withGHHooksSeams(t)
	if killed, err := KillGHHooksSession(); err != nil || killed {
		t.Errorf("absent session: killed=%v err=%v, want a no-op success", killed, err)
	}
	f.add("receiver", false)
	killed, err := KillGHHooksSession()
	if err != nil || !killed {
		t.Fatalf("killed=%v err=%v", killed, err)
	}
	if want := []string{"kill-session", "-t", "=rk-gh-hooks"}; !reflect.DeepEqual(f.argv[len(f.argv)-1], want) {
		t.Errorf("last tmux call = %v, want %v", f.argv[len(f.argv)-1], want)
	}
}

func TestClassifyGHHooks(t *testing.T) {
	up := ghHooksRepoProbe{probe: probeAdmin, receiverLive: true, forwarderLive: true}
	mut := func(f func(*ghHooksRepoProbe)) ghHooksRepoProbe { p := up; f(&p); return p }
	cases := []struct {
		name       string
		p          ghHooksRepoProbe
		state      string
		wantDetail string
	}{
		{"running", up, GHHooksStateRunning, ""},
		{"no admin", mut(func(p *ghHooksRepoProbe) { p.probe = probeNoAdmin }), GHHooksStatePolledNoAdmin, ""},
		{"probe failed reads as no admin", mut(func(p *ghHooksRepoProbe) { p.probe = ghhooks.ProbeResult{Err: errors.New("gh: auth")} }), GHHooksStatePolledNoAdmin, "probe failed: gh: auth"},
		{"no admin wins over a down daemon", mut(func(p *ghHooksRepoProbe) { p.probe = probeNoAdmin; p.daemonDown = true }), GHHooksStatePolledNoAdmin, ""},
		{"daemon down", mut(func(p *ghHooksRepoProbe) { p.daemonDown = true }), GHHooksStateForwarderLost, "rk serve -d"},
		{"extension absent", mut(func(p *ghHooksRepoProbe) { p.extensionAbsent = true }), GHHooksStateForwarderLost, "gh extension install cli/gh-webhook"},
		{"receiver missing", mut(func(p *ghHooksRepoProbe) { p.receiverLive = false }), GHHooksStateForwarderLost, "receiver"},
		{"forwarder missing", mut(func(p *ghHooksRepoProbe) { p.forwarderLive = false }), GHHooksStateForwarderLost, "forwarder window"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyGHHooks("o/r", tc.p)
			if got.State != tc.state || got.Repo != "o/r" || !strings.Contains(got.Detail, tc.wantDetail) {
				t.Errorf("classify = %+v, want state %q detail containing %q", got, tc.state, tc.wantDetail)
			}
		})
	}
}

func TestProbeGHHooks(t *testing.T) {
	t.Run("empty list is one off row and touches nothing", func(t *testing.T) {
		f := withGHHooksSeams(t)
		got := ProbeGHHooks(context.Background())
		if !reflect.DeepEqual(got, []GHHooksRepoStatus{{State: GHHooksStateOff}}) {
			t.Errorf("status = %+v", got)
		}
		if len(f.argv) != 0 {
			t.Errorf("tmux argv = %v, want none", f.argv)
		}
	})
	t.Run("one row per repo", func(t *testing.T) {
		f := withGHHooksSeams(t, "a/admin", "b/noadmin", "c/lost")
		f.probes = map[string]ghhooks.ProbeResult{"a/admin": probeAdmin, "b/noadmin": probeNoAdmin, "c/lost": probeAdmin}
		f.add("receiver", false)
		f.add("fwd-a--admin", false)
		got := ProbeGHHooks(context.Background())
		states := []string{got[0].State, got[1].State, got[2].State}
		if want := []string{GHHooksStateRunning, GHHooksStatePolledNoAdmin, GHHooksStateForwarderLost}; !reflect.DeepEqual(states, want) {
			t.Errorf("states = %v, want %v", states, want)
		}
		for _, a := range f.argv {
			if a[0] != "list-windows" {
				t.Errorf("doctor issued a mutating tmux call: %v", a)
			}
		}
	})
	t.Run("daemon down reads tmux not at all", func(t *testing.T) {
		f := withGHHooksSeams(t, "a/admin")
		f.probes["a/admin"] = probeAdmin
		f.daemonUp = false
		got := ProbeGHHooks(context.Background())
		if got[0].State != GHHooksStateForwarderLost || !strings.Contains(got[0].Detail, "rk serve -d") {
			t.Errorf("status = %+v", got[0])
		}
		if len(f.argv) != 0 {
			t.Errorf("tmux argv = %v, want none", f.argv)
		}
	})
}

func TestWatchGHHooksRunsOnStampChangeAndPeriodically(t *testing.T) {
	var stamp atomic.Value
	stamp.Store("a")
	var listed atomic.Bool
	origStamp, origListed := ghHooksStamp, ghHooksListed
	t.Cleanup(func() { ghHooksStamp, ghHooksListed = origStamp, origListed })
	ghHooksStamp = func() string { return stamp.Load().(string) }
	ghHooksListed = func() bool { return listed.Load() }

	var runs atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchGHHooks(ctx, 5*time.Millisecond, 40*time.Millisecond, func() { runs.Add(1) })
		close(done)
	}()
	waitFor := func(cond func() bool, what string) {
		t.Helper()
		for i := 0; i < 400; i++ {
			if cond() {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s", what)
	}

	time.Sleep(120 * time.Millisecond)
	if n := runs.Load(); n != 0 {
		t.Fatalf("ran %d times with nothing listed and no edit, want 0", n)
	}
	stamp.Store("b")
	waitFor(func() bool { return runs.Load() == 1 }, "a run after a settings edit")
	listed.Store(true)
	waitFor(func() bool { return runs.Load() >= 2 }, "a periodic run once repos are listed")
	cancel()
	<-done
}
