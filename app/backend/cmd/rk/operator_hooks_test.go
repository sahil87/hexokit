package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/daemon"
	"rk/internal/ghhooks"
	"rk/internal/operator"
	"rk/internal/portpolicy"
)

func TestOperatorHooksSurface(t *testing.T) {
	var visible, hidden []string
	for _, c := range operatorHooksCmd.Commands() {
		if c.Hidden {
			hidden = append(hidden, c.Name())
		} else {
			visible = append(visible, c.Name())
		}
	}
	if !reflect.DeepEqual(visible, []string{"stop"}) || !reflect.DeepEqual(hidden, []string{"forward", "serve"}) {
		t.Fatalf("visible = %v, hidden = %v; want stop visible, serve and forward hidden", visible, hidden)
	}
	out, _, err := runOperatorCLI(t, "", "hooks", "--help")
	if err != nil {
		t.Fatalf("hooks --help: %v", err)
	}
	_, listed, _ := strings.Cut(out, "Available Commands:")
	listed, _, _ = strings.Cut(listed, "Flags:")
	for _, line := range strings.Split(listed, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "serve ") || strings.HasPrefix(strings.TrimSpace(line), "forward ") {
			t.Errorf("help lists a hidden verb: %q", line)
		}
	}
	if !strings.Contains(listed, "stop ") {
		t.Errorf("help must list stop:\n%s", listed)
	}
	for _, c := range []*struct {
		name string
		long string
	}{{"stop", operatorHooksStopCmd.Long}, {"serve", operatorHooksServeCmd.Long}, {"forward", operatorHooksForwardCmd.Long}} {
		for _, section := range []string{"Examples:", "Exit codes:"} {
			if !strings.Contains(c.long, section) {
				t.Errorf("%s long help lacks %q", c.name, section)
			}
		}
	}
	if !strings.Contains(operatorHooksStopCmd.Long, "unless the setting is emptied") {
		t.Error("stop help must say the session returns unless operator.pr_hooks is emptied")
	}
	if got, _ := operatorHooksServeCmd.Flags().GetInt("port"); got != portpolicy.GHHooks {
		t.Errorf("serve --port default = %d, want the port policy's %d", got, portpolicy.GHHooks)
	}
}

// hooksSource is a fake world: one live server "work" tracking o/r#12.
func hooksSource(t *testing.T) ghhooks.Source {
	t.Helper()
	it, err := operator.NewGitHubPRItem("pr-12", nil, map[string]interface{}{"pr": float64(12)}, "o/r")
	if err != nil {
		t.Fatal(err)
	}
	st := &operator.State{Tracked: []operator.TrackedItem{it}, BranchMap: map[string]operator.BranchMapEntry{}}
	return ghhooks.Source{
		Servers: func(context.Context) ([]string, error) { return []string{"work", "play"}, nil },
		State: func(_ context.Context, server string) (*operator.State, error) {
			if server == "work" {
				return st, nil
			}
			return &operator.State{BranchMap: map[string]operator.BranchMapEntry{}}, nil
		},
		OriginNWO: func(context.Context, string) (string, error) { return "", errors.New("unused") },
	}
}

func TestHooksReceiverWritesTheDoor(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	prevNow, prevSrc := hooksNowFn, hooksSourceFn
	t.Cleanup(func() { hooksNowFn, hooksSourceFn = prevNow, prevSrc })
	hooksNowFn = func() time.Time { return time.Unix(1_700_000_000, 0) }
	hooksSourceFn = func() ghhooks.Source { return hooksSource(t) }

	recv, err := newHooksReceiver()
	if err != nil {
		t.Fatal(err)
	}
	ln, err := listenHooks(0)
	if err != nil {
		t.Fatal(err)
	}
	if !ln.Addr().(*net.TCPAddr).IP.IsLoopback() {
		t.Fatalf("receiver bound %v, want loopback only", ln.Addr())
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveHooks(ctx, ln, recv) }()
	url := "http://" + ln.Addr().String() + ghhooks.HookPath

	send := func(event, body string) int {
		req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
		req.Header.Set(ghhooks.EventHeader, event)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	dir, _ := cron.DefaultDir()

	if code := send("pull_request", `{"repository":{"full_name":"o/r"},"pull_request":{"number":99,"head":{"ref":"x"}}}`); code/100 != 2 {
		t.Errorf("untracked PR status = %d", code)
	}
	recv.Wait()
	if _, ok, _ := cron.ReadWakeMarker(dir, "work"); ok {
		t.Error("an untracked PR wrote a marker")
	}

	if code := send("check_suite", `{"repository":{"full_name":"o/r"},"check_suite":{"head_branch":"b","pull_requests":[{"number":12}]}}`); code/100 != 2 {
		t.Errorf("tracked PR status = %d", code)
	}
	recv.Wait()
	m, ok, err := cron.ReadWakeMarker(dir, "work")
	if err != nil || !ok || m.Reason != "pr:o/r#12:check_suite" || m.At != 1_700_000_000 {
		t.Errorf("work marker = %+v ok=%v err=%v, want pr:o/r#12:check_suite at the pinned clock", m, ok, err)
	}
	if _, ok, _ := cron.ReadWakeMarker(dir, "play"); ok {
		t.Error("a server that tracks nothing was woken")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("serveHooks after cancel: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serveHooks did not stop on cancel")
	}
}

func TestOperatorHooksServeRejectsABadPort(t *testing.T) {
	for _, port := range []string{"0", "70000", "-1"} {
		_, _, err := runOperatorCLI(t, "", "hooks", "serve", "--port", port)
		if err == nil || exitCode(err) != 2 {
			t.Errorf("--port %s: err = %v exit %d, want a usage error", port, err, exitCode(err))
		}
	}
}

func TestOperatorHooksServeReportsAPortInUse(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	port := strconv.Itoa(busy.Addr().(*net.TCPAddr).Port)
	_, _, err = runOperatorCLI(t, "", "hooks", "serve", "--port", port)
	if err == nil || exitCode(err) != 1 {
		t.Errorf("err = %v exit %d, want an operational failure (exit 1)", err, exitCode(err))
	}
}

func TestOperatorHooksForward(t *testing.T) {
	prev := hooksRunForwarderFn
	t.Cleanup(func() { hooksRunForwarderFn = prev })
	var gotRepo string
	var gotPort int
	hooksRunForwarderFn = func(_ context.Context, repo string, port int, _ func(string, ...any)) error {
		gotRepo, gotPort = repo, port
		return nil
	}
	if _, _, err := runOperatorCLI(t, "", "hooks", "forward", "--repo", "o/r", "--port", "21901"); err != nil {
		t.Fatalf("forward: %v", err)
	}
	if gotRepo != "o/r" || gotPort != 21901 {
		t.Errorf("forwarder got %q:%d, want o/r:21901", gotRepo, gotPort)
	}
	hooksRunForwarderFn = func(context.Context, string, int, func(string, ...any)) error {
		t.Fatal("the forwarder must not start on a usage error")
		return nil
	}
	for _, args := range [][]string{
		{"hooks", "forward"},
		{"hooks", "forward", "--repo", "no-slash"},
		{"hooks", "forward", "--repo", "a/b; rm"},
		{"hooks", "forward", "--repo", "o/r", "--port", "0"},
	} {
		_, _, err := runOperatorCLI(t, "", args...)
		if err == nil || exitCode(err) != 2 {
			t.Errorf("%v: err = %v exit %d, want a usage error", args, err, exitCode(err))
		}
	}
}

// stopSeams fakes the session, the setting, the probe and the hook sweep.
type stopSeams struct {
	killed      bool
	killErr     error
	repos       []string
	probes      map[string]ghhooks.ProbeResult
	removed     map[string][]int64
	removeErr   map[string]error
	probedRepos []string
	sweptRepos  []string
}

func withStopSeams(t *testing.T, s *stopSeams) {
	t.Helper()
	pk, pr, pp, ph := hooksKillSessionFn, hooksReposFn, hooksProbeAdminFn, hooksRemoveHooksFn
	t.Cleanup(func() { hooksKillSessionFn, hooksReposFn, hooksProbeAdminFn, hooksRemoveHooksFn = pk, pr, pp, ph })
	hooksKillSessionFn = func() (bool, error) { return s.killed, s.killErr }
	hooksReposFn = func() []string { return s.repos }
	hooksProbeAdminFn = func(_ context.Context, nwo string) ghhooks.ProbeResult {
		s.probedRepos = append(s.probedRepos, nwo)
		return s.probes[nwo]
	}
	hooksRemoveHooksFn = func(_ context.Context, nwo string) ([]int64, error) {
		s.sweptRepos = append(s.sweptRepos, nwo)
		return s.removed[nwo], s.removeErr[nwo]
	}
}

func TestOperatorHooksStopRemovesOnlyAdminRepoHooks(t *testing.T) {
	s := &stopSeams{
		killed: true,
		repos:  []string{"a/admin", "b/noadmin", "c/failed"},
		probes: map[string]ghhooks.ProbeResult{
			"a/admin":   {Admin: ghhooks.AdminYes},
			"b/noadmin": {Admin: ghhooks.AdminNo},
			"c/failed":  {Err: errors.New("gh down")},
		},
		removed: map[string][]int64{"a/admin": {7}},
	}
	withStopSeams(t, s)
	out, _, err := runOperatorCLI(t, "", "hooks", "stop")
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if !reflect.DeepEqual(s.sweptRepos, []string{"a/admin"}) {
		t.Errorf("hook sweep ran on %v, want only the admin repo", s.sweptRepos)
	}
	for _, want := range []string{"killed the rk-gh-hooks session", "a/admin: removed 1 forwarder hook(s)", "b/noadmin: polled — no admin", "c/failed: polled — no admin"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
}

func TestOperatorHooksStopJSON(t *testing.T) {
	s := &stopSeams{
		repos:   []string{"a/admin"},
		probes:  map[string]ghhooks.ProbeResult{"a/admin": {Admin: ghhooks.AdminYes}},
		removed: map[string][]int64{"a/admin": {1, 5}},
	}
	withStopSeams(t, s)
	out, _, err := runOperatorCLI(t, "", "hooks", "stop", "--json")
	if err != nil {
		t.Fatalf("stop --json: %v", err)
	}
	assertEnvelopeResult(t, out, map[string]any{
		"session_killed": false,
		"repos": []any{map[string]any{
			"repo": "a/admin", "admin": true, "removed": []any{float64(1), float64(5)},
		}},
	})
}

func TestOperatorHooksStopNothingListedIsSuccess(t *testing.T) {
	withStopSeams(t, &stopSeams{})
	out, _, err := runOperatorCLI(t, "", "hooks", "stop")
	if err != nil || !strings.Contains(out, "no rk-gh-hooks session running") {
		t.Errorf("out = %q err = %v, want a clean no-op", out, err)
	}
}

func TestOperatorHooksStopFailureIsOperational(t *testing.T) {
	s := &stopSeams{
		repos:     []string{"a/admin"},
		probes:    map[string]ghhooks.ProbeResult{"a/admin": {Admin: ghhooks.AdminYes}},
		removeErr: map[string]error{"a/admin": errors.New("deleting hook 4 on a/admin: HTTP 403")},
	}
	withStopSeams(t, s)
	out, _, err := runOperatorCLI(t, "", "hooks", "stop")
	if err == nil || exitCode(err) != 1 || !strings.Contains(out, "HTTP 403") {
		t.Errorf("out = %q err = %v exit %d, want the failure shown and exit 1", out, err, exitCode(err))
	}

	withStopSeams(t, &stopSeams{killErr: errors.New("tmux gone")})
	if _, _, err := runOperatorCLI(t, "", "hooks", "stop"); err == nil || exitCode(err) != 1 {
		t.Errorf("a failed session kill must be exit 1, got %v", err)
	}

	withStopSeams(t, s)
	jsonOut, _, err := runOperatorCLI(t, "", "hooks", "stop", "--json")
	var doc struct {
		OK    bool `json:"ok"`
		Error struct{ Code string }
	}
	if err == nil || json.Unmarshal([]byte(jsonOut), &doc) != nil || doc.OK || doc.Error.Code != "operational" {
		t.Errorf("--json failure: out = %q err = %v, want one ok:false operational envelope", jsonOut, err)
	}
}

func TestOperatorHooksStopRejectsExtraArguments(t *testing.T) {
	withStopSeams(t, &stopSeams{})
	if _, _, err := runOperatorCLI(t, "", "hooks", "stop", "extra"); err == nil || exitCode(err) != 2 {
		t.Errorf("err = %v, want a usage error", err)
	}
}

func TestPRHooksChecksRows(t *testing.T) {
	cases := []struct {
		name string
		in   []daemon.GHHooksRepoStatus
		want []doctorCheck
	}{
		{
			name: "off is one row",
			in:   []daemon.GHHooksRepoStatus{{State: daemon.GHHooksStateOff}},
			want: []doctorCheck{{Name: "pr hooks", OK: true, Note: "off"}},
		},
		{
			name: "one row per repo, every state",
			in: []daemon.GHHooksRepoStatus{
				{Repo: "a/admin", State: daemon.GHHooksStateRunning},
				{Repo: "b/noadmin", State: daemon.GHHooksStatePolledNoAdmin},
				{Repo: "c/failed", State: daemon.GHHooksStatePolledNoAdmin, Detail: "probe failed: gh: timeout"},
				{Repo: "d/noext", State: daemon.GHHooksStateForwarderLost, Detail: "gh extension install cli/gh-webhook"},
				{Repo: "e/down", State: daemon.GHHooksStateForwarderLost, Detail: "rk daemon is not running (rk serve -d)"},
			},
			want: []doctorCheck{
				{Name: "pr hooks a/admin", OK: true, Note: "running"},
				{Name: "pr hooks b/noadmin", OK: true, Note: "polled — no admin"},
				{Name: "pr hooks c/failed", OK: true, Note: "polled — no admin (probe failed: gh: timeout)"},
				{Name: "pr hooks d/noext", OK: true, Note: "forwarder missing — gh extension install cli/gh-webhook"},
				{Name: "pr hooks e/down", OK: true, Note: "forwarder missing — rk daemon is not running (rk serve -d)"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := prHooksChecks(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("rows = %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

func TestPRHooksDoctorChecksReadTheProbe(t *testing.T) {
	prev := hooksDoctorProbeFn
	t.Cleanup(func() { hooksDoctorProbeFn = prev })
	hooksDoctorProbeFn = func(context.Context) []daemon.GHHooksRepoStatus {
		return []daemon.GHHooksRepoStatus{{Repo: "b/noadmin", State: daemon.GHHooksStatePolledNoAdmin}}
	}
	rows := prHooksDoctorChecks()
	if len(rows) != 1 || rows[0].Name != "pr hooks b/noadmin" || !rows[0].OK || rows[0].Note != "polled — no admin" {
		t.Errorf("rows = %+v, want one OK-shaped no-admin row for b/noadmin", rows)
	}
}
