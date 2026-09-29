package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/present"
	"rk/internal/tmux"
)

// presentTestEnv installs the present command's seams with fakes and returns
// observers for the faked tmux/notify interactions. The default fake session
// is pane %3 on window @7 of server "dev" (socket /tmp/tmux-1000/dev).
type presentFake struct {
	displayArgs  [][]string
	webAdds      []presentWebAdd
	family       tmux.WebTabFamily
	createdID    []presentCreatedID
	layoutWrites []presentLayoutWrite
	selects      []presentWebSelect
	notified     []string
	probed       []int
	wakes        []string
}

type presentWebAdd struct {
	windowID, server, url, root string
	index                       int
	existed                     bool
}

type presentCreatedID struct {
	session, name, server string
	ops                   []tmux.WindowOptionOp
}

type presentLayoutWrite struct {
	windowID, server string
	ops              []tmux.WindowOptionOp
}

type presentWebSelect struct {
	windowID, server string
	n                int
}

func installPresentFakes(t *testing.T) *presentFake {
	t.Helper()
	f := &presentFake{}

	ownTabOriginalTMUXFn = func() string { return "/tmp/tmux-1000/dev,123,0" }
	ownTabRunOutputFn = func(_ context.Context, args []string) ([]byte, error) {
		f.displayArgs = append(f.displayArgs, args)
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "#{window_id}"):
			return []byte("@7\n"), nil
		case strings.Contains(joined, "#{session_name}"):
			return []byte("work\n"), nil
		}
		return nil, fmt.Errorf("unexpected tmux read: %s", joined)
	}
	// The fake WebAdd honors the contract the production tmux.WebAdd owns: the
	// slot is len(family)+1 on a fresh append (an empty family lands slot 1 and
	// arms _active), and an identical stored URL is an idempotent hit on its
	// existing slot. Tests assert the (windowID, server, url, root) it was
	// driven with — the invariants themselves are tmux.WebAdd's (webtabs_test).
	presentWebAddFn = func(_ context.Context, windowID, server, url, root string) (int, bool, error) {
		for i, tab := range f.family.Tabs {
			if tab == url {
				f.webAdds = append(f.webAdds, presentWebAdd{windowID, server, url, root, i + 1, true})
				return i + 1, true, nil
			}
		}
		n := len(f.family.Tabs) + 1
		f.webAdds = append(f.webAdds, presentWebAdd{windowID, server, url, root, n, false})
		return n, false, nil
	}
	presentReadFamilyFn = func(_ context.Context, windowID, server string) (tmux.WebTabFamily, error) {
		return f.family, nil
	}
	presentCreateWindowIDFn = func(session, name, cwd, server string, ops []tmux.WindowOptionOp) (string, error) {
		f.createdID = append(f.createdID, presentCreatedID{session, name, server, ops})
		return "@42", nil
	}
	tabCreateWindowIDFn = presentCreateWindowIDFn
	tabSetWindowOptionsFn = func(_ context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
		f.layoutWrites = append(f.layoutWrites, presentLayoutWrite{windowID, server, ops})
		return nil
	}
	webSelectFn = func(_ context.Context, windowID, server string, n int) error {
		f.selects = append(f.selects, presentWebSelect{windowID, server, n})
		return nil
	}
	presentProbeFn = func(_ context.Context, port int) error {
		f.probed = append(f.probed, port)
		return nil
	}
	presentNotifyFn = func(_ context.Context, title, body string) bool {
		f.notified = append(f.notified, body)
		return true
	}
	tabWakeFn = func(_ context.Context, server string) {
		f.wakes = append(f.wakes, server)
	}
	presentNowFn = func() int64 { return 1700000000 }

	t.Cleanup(func() {
		ownTabOriginalTMUXFn = func() string { return tmux.OriginalTMUX }
		ownTabRunOutputFn = func(ctx context.Context, args []string) ([]byte, error) {
			return tmux.RunOutput(ctx, args, tmux.RunOpts{})
		}
		presentWebAddFn = func(ctx context.Context, windowID, server, url, root string) (int, bool, error) {
			return tmux.WebAdd(ctx, windowID, server, url, root)
		}
		presentReadFamilyFn = func(ctx context.Context, windowID, server string) (tmux.WebTabFamily, error) {
			return tmux.ReadWebTabFamily(ctx, windowID, server)
		}
		presentCreateWindowIDFn = func(session, name, cwd, server string, ops []tmux.WindowOptionOp) (string, error) {
			return tmux.CreateWindowWithOptionsID(session, name, cwd, server, ops)
		}
		tabCreateWindowIDFn = presentCreateWindowIDFn
		tabSetWindowOptionsFn = func(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
			return tmux.SetWindowOptions(ctx, windowID, server, ops)
		}
		webSelectFn = func(ctx context.Context, windowID, server string, n int) error {
			return tmux.WebSelect(ctx, windowID, server, n)
		}
		presentProbeFn = func(ctx context.Context, port int) error { return present.ProbePort(ctx, port) }
		presentNotifyFn = sendNotify
		tabWakeFn = wakeTabHub
		presentNowFn = func() int64 { return time.Now().Unix() }
	})
	return f
}

// runPresentCmd drives `rk present <args...>` through the real cobra Execute()
// seam (the skill_test.go runSkill pattern) so arg/flag validation and exit
// classification run exactly as in production. Present's local flags and the
// root persistent --quiet are reset before and after so no state bleeds.
func runPresentCmd(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	resetRootFlagState(t)
	resetPresentFlagState(t)
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"present"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	err := rootCmd.Execute()
	return stdout.String(), stderr.String(), err
}

func resetPresentFlagState(t *testing.T) {
	t.Helper()
	reset := func() {
		for _, name := range []string{"window", "notify"} {
			if f := presentCmd.Flags().Lookup(name); f != nil {
				_ = presentCmd.Flags().Set(name, "")
				f.Changed = false
			}
		}
		presentWindowFlag, presentNotifyFlag = "", ""
		if f := rootCmd.PersistentFlags().Lookup("quiet"); f != nil {
			_ = rootCmd.PersistentFlags().Set("quiet", "false")
			f.Changed = false
		}
		quiet = false
	}
	reset()
	t.Cleanup(reset)
}

// opValue finds a set op (non-nil Value) by key.
func opValue(ops []tmux.WindowOptionOp, key string) (string, bool) {
	for _, op := range ops {
		if op.Key == key && op.Value != nil {
			return *op.Value, true
		}
	}
	return "", false
}

func TestPresentHelpDocumentsSameOriginTarget(t *testing.T) {
	for _, want := range []string{"$(rk url)/path", "same-origin /path targets"} {
		if !strings.Contains(presentCmd.Long, want) {
			t.Errorf("present help missing %q", want)
		}
	}
}

func TestPresentUsageErrorsExitTwo(t *testing.T) {
	installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	stdout, stderr, err := runPresentCmd(t) // no target
	if err == nil || exitCode(err) != exitUsage {
		t.Errorf("no target: err = %v (code %d), want usage exit 2", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("no target wrote to stdout: %q", stdout)
	}
	if stderr == "" {
		t.Error("no target wrote nothing to stderr, want usage diagnostic")
	}

	if _, _, err := runPresentCmd(t, ":5173", "--bogus"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("unknown flag: err = %v (code %d), want usage exit 2", err, exitCode(err))
	}
}

func TestPresentOutsideTmuxExitsOne(t *testing.T) {
	installPresentFakes(t)
	t.Setenv("TMUX_PANE", "") // not in a pane; no --window

	dir := t.TempDir()
	file := filepath.Join(dir, "mock.html")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, _, err := runPresentCmd(t, file)
	if err == nil || exitCode(err) != 1 {
		t.Errorf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on failure", stdout)
	}
}

func TestPresentUnreachablePortExitsOne(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")
	presentProbeFn = func(_ context.Context, port int) error {
		f.probed = append(f.probed, port)
		return fmt.Errorf("nothing is listening on port %d (127.0.0.1): connection refused", port)
	}

	stdout, _, err := runPresentCmd(t, ":59999")
	if err == nil || exitCode(err) != 1 {
		t.Errorf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	if !strings.Contains(err.Error(), "59999") {
		t.Errorf("diagnostic %q does not name the unreachable port", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on failure", stdout)
	}
	if len(f.webAdds) != 0 {
		t.Error("unreachable port still added a web tab")
	}
}

// TestPresentAttachComposition pins the default arm's WebAdd call per target
// kind: file/dir targets pass the slot URL + the serve root; port/URL targets
// pass root "" (WebAdd clears any stale serve root from a previous file/dir
// present). stdout carries exactly the URL of the slot WebAdd returned. The
// family invariants (_active arming, dense append, ?v= refresh) are
// tmux.WebAdd's, pinned in webtabs_test — here only the arm's contract.
func TestPresentAttachComposition(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "mock.html")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		arg       string
		wantURL   string
		wantRoot  string // "" = root cleared (non-file/dir kind)
		wantProbe bool
	}{
		{"file", file, "/present/dev/" + present.RootHash(dir) + "/mock.html?v=1700000000", dir, false},
		{"dir", dir, "/present/dev/" + present.RootHash(dir) + "/?v=1700000000", dir, false},
		{"port", ":5173", "/proxy/5173/", "", true},
		{"local URL", "http://localhost:8080/docs?x=1", "/proxy/8080/docs?x=1", "", true},
		{"external URL", "https://staging.example.com/app", "https://staging.example.com/app", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := installPresentFakes(t)
			t.Setenv("TMUX_PANE", "%3")

			stdout, _, err := runPresentCmd(t, tc.arg)
			if err != nil {
				t.Fatalf("runPresent: %v", err)
			}
			if stdout != tc.wantURL+"\n" {
				t.Errorf("stdout = %q, want exactly %q", stdout, tc.wantURL+"\n")
			}
			if len(f.webAdds) != 1 {
				t.Fatalf("WebAdd calls = %d, want 1", len(f.webAdds))
			}
			add := f.webAdds[0]
			if add.windowID != "@7" || add.server != "dev" {
				t.Errorf("attach target = (%q, %q), want (@7, dev)", add.windowID, add.server)
			}
			if add.url != tc.wantURL {
				t.Errorf("WebAdd url = %q, want %q", add.url, tc.wantURL)
			}
			if add.root != tc.wantRoot {
				t.Errorf("WebAdd root = %q, want %q", add.root, tc.wantRoot)
			}
			// Empty family ⇒ the fresh append lands slot 1 (and production
			// WebAdd arms _active=1 — its own invariant).
			if add.index != 1 || add.existed {
				t.Errorf("WebAdd returned (index=%d, existed=%v), want (1, false)", add.index, add.existed)
			}
			if tc.wantProbe && len(f.probed) == 0 {
				t.Error("expected a reachability probe, got none")
			}
			if !tc.wantProbe && len(f.probed) != 0 {
				t.Errorf("unexpected probes: %v", f.probed)
			}
			// URL targets carry no cache-buster.
			if tc.wantRoot == "" && strings.Contains(tc.wantURL, "v=") {
				t.Errorf("URL target %q carries a buster, want none", tc.wantURL)
			}
		})
	}
}

// TestPresentAttachNonEmptyFamily pins the dense-append contract: on a window
// already holding two tabs the default arm appends at slot 3 (it never evicts
// tab 1), and the printed URL carries the new slot.
func TestPresentAttachNonEmptyFamily(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")
	f.family = tmux.WebTabFamily{Tabs: []string{"/proxy/3000/", "/proxy/3001/"}, Active: 1}

	stdout, _, err := runPresentCmd(t, ":5173")
	if err != nil {
		t.Fatalf("runPresent: %v", err)
	}
	if stdout != "/proxy/5173/\n" {
		t.Errorf("stdout = %q, want /proxy/5173/", stdout)
	}
	if len(f.webAdds) != 1 || f.webAdds[0].index != 3 || f.webAdds[0].existed {
		t.Errorf("WebAdd = %+v, want one call landing slot 3 (dense append, tab 1 untouched)", f.webAdds)
	}
}

func TestPresentAndTabWebAddUseRunKitOrigin(t *testing.T) {
	const target = "http://0.0.0.0:3000/tutorial/ch1-orientation.html?chapter=1"
	const wantURL = "/tutorial/ch1-orientation.html?chapter=1"
	t.Setenv("RK_HOST", "0.0.0.0")
	t.Setenv("RK_PORT", "3000")
	t.Setenv("TMUX_PANE", "%3")

	t.Run("present", func(t *testing.T) {
		f := installPresentFakes(t)
		stdout, _, err := runPresentCmd(t, target)
		if err != nil {
			t.Fatalf("present: %v", err)
		}
		if stdout != wantURL+"\n" {
			t.Errorf("stdout = %q, want %q", stdout, wantURL+"\n")
		}
		if len(f.webAdds) != 1 || f.webAdds[0].url != wantURL {
			t.Errorf("WebAdd calls = %+v, want one call with %q", f.webAdds, wantURL)
		}
		if len(f.probed) != 0 {
			t.Errorf("same-origin target probes = %v, want none", f.probed)
		}
	})

	t.Run("tab web add", func(t *testing.T) {
		f := installPresentFakes(t)
		stdout, stderr, err := runTabCmd(t, "web", "add", target)
		if err != nil {
			t.Fatalf("tab web add: %v", err)
		}
		if stdout != "@7/web/1\n" {
			t.Errorf("stdout = %q, want @7/web/1", stdout)
		}
		if !strings.Contains(stderr, "url: "+wantURL) {
			t.Errorf("stderr = %q, want URL note for %q", stderr, wantURL)
		}
		if len(f.webAdds) != 1 || f.webAdds[0].url != wantURL {
			t.Errorf("WebAdd calls = %+v, want one call with %q", f.webAdds, wantURL)
		}
	})
}

// --show gates on the BARE web leaf (HasBare, the frontend toggle's
// semantics): a window whose layout shows web only as a foreign @N/web tile
// still grows its own bare web slot.
func TestTabWebAddShowForeignWebDoesNotSuppressBareSlot(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")
	f.family = tmux.WebTabFamily{Layout: "h(tty,@3/web)"}

	if _, _, err := runTabCmd(t, "web", "add", "https://example.com", "--show"); err != nil {
		t.Fatalf("web add --show: %v", err)
	}
	if len(f.layoutWrites) != 1 {
		t.Fatalf("layout writes = %+v, want exactly one (the bare web slot add)", f.layoutWrites)
	}
	w := f.layoutWrites[0]
	if w.windowID != "@7" {
		t.Errorf("write window = %q, want @7", w.windowID)
	}
	if len(w.ops) != 1 || w.ops[0].Key != tmux.LayoutOption || w.ops[0].Value == nil ||
		*w.ops[0].Value != "h(tty,v(@3/web,web))" {
		t.Errorf("write ops = %+v, want @rk_win_layout = h(tty,v(@3/web,web))", w.ops)
	}
}

func TestPresentURLStillPrintsUnderQuiet(t *testing.T) {
	installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	stdout, _, err := runPresentCmd(t, "--quiet", ":5173")
	if err != nil {
		t.Fatalf("runPresent: %v", err)
	}
	if stdout != "/proxy/5173/\n" {
		t.Errorf("stdout = %q, want the URL even under --quiet (stdout is data)", stdout)
	}
}

func TestPresentNotifyDefaultMessage(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	dir := t.TempDir()
	file := filepath.Join(dir, "mock.html")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, _, err := runPresentCmd(t, "--notify", file); err != nil {
		t.Fatalf("runPresent --notify: %v", err)
	}
	if len(f.notified) != 1 || f.notified[0] != "presenting mock.html" {
		t.Errorf("notified = %v, want [presenting mock.html]", f.notified)
	}

	resetPresentFlagState(t)
	if _, _, err := runPresentCmd(t, file, "--notify=look at this"); err != nil {
		t.Fatalf("runPresent --notify=msg: %v", err)
	}
	if len(f.notified) != 2 || f.notified[1] != "look at this" {
		t.Errorf("notified = %v, want second message \"look at this\"", f.notified)
	}

	// Without the flag, nothing is sent.
	resetPresentFlagState(t)
	if _, _, err := runPresentCmd(t, file); err != nil {
		t.Fatalf("runPresent: %v", err)
	}
	if len(f.notified) != 2 {
		t.Errorf("notify sent without the flag: %v", f.notified)
	}
}

func TestPresentWindowExternalURL(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	stdout, _, err := runPresentCmd(t, "--window", "https://staging.example.com")
	if err != nil {
		t.Fatalf("runPresent --window: %v", err)
	}
	if stdout != "https://staging.example.com\n" {
		t.Errorf("stdout = %q, want the verbatim URL", stdout)
	}
	if len(f.createdID) != 1 {
		t.Fatalf("CreateWindowWithOptionsID calls = %d, want 1", len(f.createdID))
	}
	c := f.createdID[0]
	if c.session != "work" || c.server != "dev" {
		t.Errorf("created in (%q, %q), want (work, dev)", c.session, c.server)
	}
	if c.name != "staging-example-com" {
		t.Errorf("window name = %q, want sanitized host staging-example-com", c.name)
	}
	// Creation carries the layout alone; the URL lands via WebAdd on the new
	// window's empty family (slot 1 + _active=1, WebAdd's invariant).
	if tp, ok := opValue(c.ops, tmux.LayoutOption); !ok || tp != "web" {
		t.Errorf("@rk_win_layout = %q (set=%v), want web", tp, ok)
	}
	if len(c.ops) != 1 {
		t.Errorf("creation ops = %+v, want @rk_win_layout alone (the URL follows via WebAdd)", c.ops)
	}
	if len(f.webAdds) != 1 {
		t.Fatalf("WebAdd calls = %d, want 1", len(f.webAdds))
	}
	if f.webAdds[0].url != "https://staging.example.com" {
		t.Errorf("WebAdd url = %q, want the verbatim URL", f.webAdds[0].url)
	}
	if f.webAdds[0].windowID != "@42" {
		t.Errorf("WebAdd window = %q, want @42 (the id creation returned — never a session:name re-resolution)", f.webAdds[0].windowID)
	}
	if f.webAdds[0].index != 1 || f.webAdds[0].existed {
		t.Errorf("WebAdd returned (index=%d, existed=%v), want (1, false)", f.webAdds[0].index, f.webAdds[0].existed)
	}
}

// TestPresentWindowFileTwoStep pins the file/dir --window flow: the /present/
// URL embeds the NEW window's id, so creation sets @rk_win_layout alone and
// WebAdd adds the id-addressed URL + serve root on the returned id's empty
// family (slot 1).
func TestPresentWindowFileTwoStep(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	dir := t.TempDir()
	file := filepath.Join(dir, "mock.report.html")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, _, err := runPresentCmd(t, "--window", file)
	if err != nil {
		t.Fatalf("runPresent --window file: %v", err)
	}
	wantURL := "/present/dev/" + present.RootHash(dir) + "/mock.report.html?v=1700000000"
	if stdout != wantURL+"\n" {
		t.Errorf("stdout = %q, want %q (new window's id in the URL)", stdout, wantURL)
	}
	if len(f.createdID) != 1 {
		t.Fatalf("CreateWindowWithOptionsID calls = %d, want 1", len(f.createdID))
	}
	c := f.createdID[0]
	if c.name != "mock-report-html" {
		t.Errorf("window name = %q, want mock-report-html (periods sanitized)", c.name)
	}
	if len(c.ops) != 1 {
		t.Errorf("creation ops = %+v, want @rk_win_layout alone (URL needs the new id)", c.ops)
	}
	if len(f.webAdds) != 1 {
		t.Fatalf("WebAdd calls = %d, want 1", len(f.webAdds))
	}
	add := f.webAdds[0]
	if add.windowID != "@42" {
		t.Errorf("WebAdd window = %q, want @42 (the new window)", add.windowID)
	}
	if add.url != wantURL {
		t.Errorf("WebAdd url = %q, want %q", add.url, wantURL)
	}
	if add.root != dir {
		t.Errorf("WebAdd root = %q, want %q", add.root, dir)
	}
	if add.index != 1 || add.existed {
		t.Errorf("WebAdd returned (index=%d, existed=%v), want (1, false)", add.index, add.existed)
	}
}

func TestPresentWindowExplicitNameAndOutsideTmux(t *testing.T) {
	installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3")

	if _, _, err := runPresentCmd(t, "--window=my mock", ":5173"); err == nil {
		t.Fatal("--window with a space in the explicit name: err = nil, want ValidateNewName rejection")
	}
}

// TestPresentEquivalentToWebAddShow: `rk present <t>` and `rk tab web add
// <t> --show` leave byte-identical @rk_win_* state on two fresh windows
// (modulo the window id embedded in /present/ URLs — the windows differ by
// construction) — the R12 one-code-path contract, asserted on a real test
// socket.
func TestPresentEquivalentToWebAddShow(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)
	target := fmt.Sprintf(":%d", port)

	// Present onto the boot window (own tab), then web add --show onto a
	// second fresh window; both families start empty.
	idB := strings.TrimSpace(tabTmuxOut(t, env.server, "new-window", "-d", "-t", "=boot:", "-P", "-F", "#{window_id}"))

	presentURL, _, err := runPresentCmd(t, target)
	if err != nil {
		t.Fatalf("present: %v", err)
	}
	addrOut, _, err := runTabCmd(t, "web", "add", idB, target, "--show")
	if err != nil {
		t.Fatalf("web add --show: %v", err)
	}
	if addrOut != idB+"/web/1\n" {
		t.Errorf("web add stdout = %q, want %s/web/1", addrOut, idB)
	}

	optsA := tmuxShowOptions(t, env.server, env.bootID)
	optsB := tmuxShowOptions(t, env.server, idB)
	if len(optsA) == 0 || len(optsB) == 0 {
		t.Fatalf("options: A=%v B=%v", optsA, optsB)
	}
	if len(optsA) != len(optsB) {
		t.Errorf("option sets differ: A=%v B=%v", optsA, optsB)
	}
	for k, va := range optsA {
		vb, ok := optsB[k]
		if !ok {
			t.Errorf("option %s present on the present window, missing on the web-add window (A=%v B=%v)", k, optsA, optsB)
			continue
		}
		// /present/ URLs embed the window id; normalize before comparing.
		if strings.ReplaceAll(va, env.bootID, "@W") != strings.ReplaceAll(vb, idB, "@W") {
			t.Errorf("option %s differs: present=%q web-add=%q", k, va, vb)
		}
	}
	// present's stdout stays the URL of the slot it landed in.
	if want := fmt.Sprintf("/proxy/%d/\n", port); presentURL != want {
		t.Errorf("present stdout = %q, want %q", presentURL, want)
	}
}

// TestPresentShowsWebTile: presenting onto a fresh tty-only window writes
// @rk_win_layout (h(tty,web)) and selects the added slot — the documented
// behaviour change (R12).
func TestPresentShowsWebTile(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)

	stdout, _, err := runPresentCmd(t, fmt.Sprintf(":%d", port))
	if err != nil {
		t.Fatalf("present: %v", err)
	}
	if want := fmt.Sprintf("/proxy/%d/\n", port); stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	id := env.bootID
	if got := tabWindowOption(t, env.server, id, tmux.LayoutOption); got != "h(tty,web)" {
		t.Errorf("@rk_win_layout = %q, want h(tty,web)", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebActiveOption); got != "1" {
		t.Errorf("@rk_win_web_active = %q, want 1", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(1)); got != fmt.Sprintf("/proxy/%d/", port) {
		t.Errorf("@rk_win_web_1 = %q", got)
	}
}

// tmuxShowOptions dumps a window's options as a key→value map.
func tmuxShowOptions(t *testing.T, server, windowID string) map[string]string {
	t.Helper()
	raw := tabTmuxOut(t, server, "show-options", "-w", "-t", windowID)
	opts := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		k, v, found := strings.Cut(line, " ")
		if found {
			opts[k] = v
		}
	}
	return opts
}
