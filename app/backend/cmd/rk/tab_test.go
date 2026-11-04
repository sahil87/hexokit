package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/inject"
	"rk/internal/tmux"

	"github.com/spf13/pflag"
)

// tabTestServer starts an isolated tmux server ("boot" session) and points
// the own-tab seams at it: $TMUX reads as the server's socket and
// display-message reads run for real through the ownTabRunOutputFn seam.
// Skips when tmux is unavailable; the server is killed on cleanup.
type tabTestEnv struct {
	server string
	socket string
	bootID string // the boot window's @N
	paneID string // the boot window's initial pane (%N)
	wakes  []string
}

func withTabTestServer(t *testing.T) *tabTestEnv {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := fmt.Sprintf("rk-test-tab-%d-%d", os.Getpid(), time.Now().UnixNano())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-session", "-d", "-s", "boot").CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	// Ask tmux for its own socket path rather than deriving it: -L sockets live
	// under TMUX_TMPDIR or /tmp (not os.TempDir(), which differs on macOS).
	socket := tabTmuxOut(t, server, "display-message", "-p", "#{socket_path}")
	env := &tabTestEnv{server: server, socket: socket}
	env.bootID = tabTmuxOut(t, server, "display-message", "-p", "#{window_id}")
	env.paneID = tabTmuxOut(t, server, "display-message", "-p", "#{pane_id}")

	origTMUX := ownTabOriginalTMUXFn
	ownTabOriginalTMUXFn = func() string { return socket + ",1,0" }
	t.Setenv("TMUX_PANE", env.paneID)
	// Record wakes instead of POSTing them: keeps the integration tests
	// network-free and lets them assert the wake wiring per verb.
	tabWakeFn = func(_ context.Context, server string) {
		env.wakes = append(env.wakes, server)
	}
	t.Cleanup(func() {
		ownTabOriginalTMUXFn = origTMUX
		tabWakeFn = wakeTabHub
	})
	return env
}

// tabTmuxOut runs a raw tmux command on the test server, failing on error.
func tabTmuxOut(t *testing.T, server string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	full := append([]string{"-L", server}, args...)
	out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("tmux %v: %v\n%s", args, err, string(out))
	}
	return strings.TrimSpace(string(out))
}

// tabWindowOption reads one window option via show-options -wqv ("" = unset).
func tabWindowOption(t *testing.T, server, windowID, option string) string {
	t.Helper()
	return tabTmuxOut(t, server, "show-options", "-wqv", "-t", windowID, option)
}

// tabTmuxDo runs a raw tmux command, ignoring its output.
func tabTmuxDo(t *testing.T, server string, args ...string) {
	t.Helper()
	tabTmuxOut(t, server, args...)
}

// runTabCmd drives `rk tab <args...>` through the real cobra Execute() seam
// (the present_test.go runPresentCmd pattern) so arg/flag validation and exit
// classification run exactly as in production.
func runTabCmd(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	resetRootFlagState(t)
	resetTabFlagState(t)
	var stdout, stderr strings.Builder
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"tab"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	err := rootCmd.Execute()
	return stdout.String(), stderr.String(), err
}

func TestTabHelpNamesWebMove(t *testing.T) {
	if !strings.Contains(tabCmd.Long, "Add, remove, move, select, or list web tabs") {
		t.Errorf("tab Long text omits the web move verb; got:\n%s", tabCmd.Long)
	}
}

// resetTabFlagState clears every tab-family flag value and Changed marker so
// one Execute() run never bleeds into the next (the present_test.go idiom).
func resetTabFlagState(t *testing.T) {
	t.Helper()
	reset := func() {
		resetFlagChanged(tabCmd, "server")
		resetFlagChanged(tabNewCmd, "session", "cwd", "name", "layout", "json", "ready", "timeout", "no-shell-fallback")
		// pflag resets argsLenAtDash only in Init, never in Parse, so a `--`
		// from one Execute() run leaks into the next on the shared global
		// commands. Init re-applies the name/error-handling cobra created the
		// set with and clears the stale dash marker; registered flags and
		// their values are untouched.
		tabNewCmd.Flags().Init(tabNewCmd.DisplayName(), pflag.ContinueOnError)
		resetFlagChanged(tabLayoutCmd, "add", "rm", "promote", "cycle", "json")
		resetFlagChanged(tabCodeSetCmd, "json")
		resetFlagChanged(tabWebCmd, "show", "json")
		resetFlagChanged(tabWebLsCmd, "json")
		resetFlagChanged(tabShowCmd, "json")
		resetFlagChanged(tabMarkCmd, "off")
		resetFlagChanged(tabNoteCmd, "off")
		resetFlagChanged(tabColorCmd, "off")
		resetFlagChanged(tabFlairCmd, "off")
		resetFlagChanged(tabOwnerCmd, "off")
		tabServerFlag = ""
		tabNewSessionFlag, tabNewCwdFlag, tabNewNameFlag, tabNewLayoutFlag = "", "", "", ""
		tabNewJSONFlag, tabNewReadyFlag, tabNewNoShellFallbackFlag = false, false, false
		tabNewTimeoutFlag = awaitDefaultTimeoutSec
		tabLayoutAddFlag, tabLayoutRmFlag, tabLayoutPromoteFlag, tabLayoutCycleFlag = "", "", "", false
		tabLayoutJSONFlag = false
		tabCodeSetJSONFlag = false
		tabWebAddShowFlag, tabWebLsJSONFlag = false, false
		tabWebJSONFlag = false
		tabShowJSONFlag = false
	}
	reset()
	t.Cleanup(reset)
}

// tabTestListener opens a throwaway TCP listener so ProbePort succeeds for a
// :port target.
func tabTestListener(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

// ── rk tab new ──────────────────────────────────────────────────────────────

func TestTabNewPrintsIDAndWritesLayoutAtCreation(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "new", "--layout", "split-h:tty,web", "--name", "newtab")
	if err != nil {
		t.Fatalf("tab new: %v", err)
	}
	id := strings.TrimSpace(stdout)
	if !strings.HasPrefix(id, "@") {
		t.Fatalf("stdout = %q, want @N", stdout)
	}
	if got := tabWindowOption(t, env.server, id, tmux.LayoutOption); got != "h(tty,web)" {
		t.Errorf("@rk_win_layout = %q, want h(tty,web) (legacy canonicalized to the tree form)", got)
	}
	if got := tabTmuxOut(t, env.server, "display-message", "-pt", id, "#{window_name}"); got != "newtab" {
		t.Errorf("window name = %q, want newtab", got)
	}
	// The default session is the caller's own (boot — TMUX_PANE is set).
	if got := tabTmuxOut(t, env.server, "display-message", "-pt", id, "#{session_name}"); got != "boot" {
		t.Errorf("session = %q, want boot", got)
	}

	// The tree grammar validates and stores verbatim too.
	stdout, _, err = runTabCmd(t, "new", "--layout", "h(tty,v(code,web))")
	if err != nil {
		t.Fatalf("tab new --layout tree: %v", err)
	}
	id = strings.TrimSpace(stdout)
	if got := tabWindowOption(t, env.server, id, tmux.LayoutOption); got != "h(tty,v(code,web))" {
		t.Errorf("@rk_win_layout = %q, want h(tty,v(code,web))", got)
	}
}

func TestTabNewBadLayoutExitsTwoAndCreatesNothing(t *testing.T) {
	env := withTabTestServer(t)
	before := tabTmuxOut(t, env.server, "list-windows", "-t", "=boot:", "-F", "#{window_id}")

	stdout, _, err := runTabCmd(t, "new", "--layout", "bogus")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("err = %v (code %d), want usage exit 2", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on failure", stdout)
	}
	if after := tabTmuxOut(t, env.server, "list-windows", "-t", "=boot:", "-F", "#{window_id}"); after != before {
		t.Errorf("windows changed on a failed new: %q → %q", before, after)
	}
}

// tabPollUntil polls cond every 50ms until it holds or the budget expires —
// tmux applies command exits and window deaths asynchronously, so pane
// liveness/death assertions poll instead of sleeping a fixed duration.
func tabPollUntil(budget time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return cond()
}

// tabWindowExists reports whether window @N is still listed on the server.
func tabWindowExists(t *testing.T, server, windowID string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "list-windows", "-a", "-F", "#{window_id}").CombinedOutput()
	if err != nil {
		t.Fatalf("list-windows: %v\n%s", err, string(out))
	}
	for line := range strings.Lines(string(out)) {
		if strings.TrimSpace(line) == windowID {
			return true
		}
	}
	return false
}

func TestTabNewCommandRunsArgvVerbatim(t *testing.T) {
	withTabTestServer(t)
	dir := t.TempDir()

	stdout, _, err := runTabCmd(t, "new", "--cwd", dir, "--",
		"sh", "-c", `printf %s "$1" > OUT`, "_", "$(echo pwned)")
	if err != nil {
		t.Fatalf("tab new: %v", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(stdout), "@") {
		t.Fatalf("stdout = %q, want @N", stdout)
	}
	outPath := filepath.Join(dir, "OUT")
	if !tabPollUntil(3*time.Second, func() bool {
		_, statErr := os.Stat(outPath)
		return statErr == nil
	}) {
		t.Fatalf("%s never appeared — the command did not run", outPath)
	}
	content, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read OUT: %v", err)
	}
	if string(content) != "$(echo pwned)" {
		t.Errorf("OUT = %q, want the literal $(echo pwned) — a token is never expanded", string(content))
	}
}

func TestTabNewShellFallbackKeepsPaneAlive(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "new", "--", "sh", "-c", "exit 0")
	if err != nil {
		t.Fatalf("tab new: %v", err)
	}
	id := strings.TrimSpace(stdout)
	// Give the command time to exit and the fallback exec to land, then the
	// window must still exist — the pane dropped into a shell instead of dying.
	time.Sleep(1500 * time.Millisecond)
	if !tabWindowExists(t, env.server, id) {
		t.Errorf("window %s gone after the command exited — the fallback should keep a shell alive", id)
	}
	if got := tabTmuxOut(t, env.server, "display-message", "-pt", id, "#{pane_dead}"); got != "0" {
		t.Errorf("pane_dead = %q, want 0 (fallback shell running)", got)
	}
}

func TestTabNewNoShellFallbackPaneDies(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "new", "--no-shell-fallback", "--", "sh", "-c", "exit 0")
	if err != nil {
		t.Fatalf("tab new: %v", err)
	}
	id := strings.TrimSpace(stdout)
	if !tabPollUntil(3*time.Second, func() bool { return !tabWindowExists(t, env.server, id) }) {
		t.Errorf("window %s still alive 3s after the command exited — --no-shell-fallback should let the pane die", id)
	}
}

func TestTabNewJSONEnvelope(t *testing.T) {
	withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "new", "--json", "--", "sh", "-c", "sleep 30")
	if err != nil {
		t.Fatalf("tab new --json: %v, want exit 0", err)
	}
	if !strings.Contains(stdout, "\n    \"session\":") {
		t.Errorf("stdout = %q, want the identity object nested under result", stdout)
	}
	var obj map[string]string
	unwrapEnvelopeResult(t, stdout, &obj)
	if obj["session"] != "boot" {
		t.Errorf("session = %q, want boot (tmux-reported)", obj["session"])
	}
	if obj["session_rung"] != sessionRungCaller {
		t.Errorf("session_rung = %q, want caller (a user-role caller keeps its own session)", obj["session_rung"])
	}
	if !strings.HasPrefix(obj["window_id"], "@") {
		t.Errorf("window_id = %q, want @N", obj["window_id"])
	}
	if !strings.HasPrefix(obj["pane_id"], "%") {
		t.Errorf("pane_id = %q, want %%N", obj["pane_id"])
	}
	if _, ok := obj["ready"]; ok {
		t.Errorf("json = %q, want no ready key without --ready", stdout)
	}
	if len(obj) != 4 {
		t.Errorf("json keys = %v, want exactly session/session_rung/window_id/pane_id", obj)
	}
}

func TestTabNewUsageErrorsCreateNothing(t *testing.T) {
	env := withTabTestServer(t)
	before := tabTmuxOut(t, env.server, "list-windows", "-t", "=boot:", "-F", "#{window_id}")

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"positional without --", []string{"new", "claude"}, "command must follow --"},
		{"positional before --", []string{"new", "claude", "--", "--model", "opus"}, "command must follow --"},
		{"--ready without --json", []string{"new", "--ready", "--", "true"}, "--ready reports through --json"},
		{"--ready without a command", []string{"new", "--json", "--ready"}, "--ready needs a command after --"},
		{"--timeout without --ready", []string{"new", "--timeout", "5", "--", "true"}, "--timeout requires --ready"},
		{"--no-shell-fallback without a command", []string{"new", "--no-shell-fallback"}, "--no-shell-fallback needs a command after --"},
		{"negative timeout", []string{"new", "--json", "--ready", "--timeout=-5", "--", "true"}, "--timeout must be >= 0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stdout, _, err := runTabCmd(t, tc.args...)
			if err == nil || exitCode(err) != exitUsage {
				t.Fatalf("err = %v (code %d), want usage exit 2", err, exitCode(err))
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to name %q", err, tc.want)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty on failure", stdout)
			}
		})
	}
	if after := tabTmuxOut(t, env.server, "list-windows", "-t", "=boot:", "-F", "#{window_id}"); after != before {
		t.Errorf("windows changed on failed news: %q → %q", before, after)
	}
}

// TestTabNewReadyReports drives --ready through the stubAwaitReady seam (the
// mux_await_test.go idiom): the creation is real, the readiness verdict is
// stubbed per word, and the JSON envelope must carry it — `gone` still prints
// the envelope before exiting 1.
func TestTabNewReadyReports(t *testing.T) {
	cases := []struct {
		name       string
		readiness  inject.Readiness
		stubErr    error
		wantWord   string
		wantExit   int
		wantStderr string
	}{
		{"state signal", inject.ReadyByState, nil, "ready", 0, ""},
		{"echo signal", inject.ReadyByEcho, nil, "ready", 0, ""},
		{"parked", 0, &inject.ParkedError{Snippet: "Do you trust this folder?"}, "parked", 0, "Do you trust this folder?"},
		{"narrow", 0, &inject.NarrowError{Width: 60, Height: 10}, "narrow", 0, "60x10"},
		{"timeout reports running", 0, fmt.Errorf("%w after 5s", inject.ErrNotReady), "running", 0, ""},
		{"gone exits 1 after the JSON", 0, fmt.Errorf("%w: can't find pane", inject.ErrGone), "gone", 1, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withTabTestServer(t)
			stubAwaitReady(t, tc.readiness, tc.stubErr)

			stdout, stderr, err := runTabCmd(t, "new", "--json", "--ready", "--", "sh", "-c", "sleep 30")
			if got := exitCode(err); got != tc.wantExit {
				t.Fatalf("err = %v (code %d), want exit %d", err, got, tc.wantExit)
			}
			var env struct {
				OK     bool              `json:"ok"`
				Result map[string]string `json:"result"`
				Error  *envelopeError    `json:"error"`
			}
			if jerr := json.Unmarshal([]byte(stdout), &env); jerr != nil {
				t.Fatalf("stdout is not the envelope: %v\n%s", jerr, stdout)
			}
			if env.OK != (tc.wantExit == 0) {
				t.Errorf("ok = %v, want it to mirror exit %d (stdout %s)", env.OK, tc.wantExit, stdout)
			}
			if env.Result["ready"] != tc.wantWord {
				t.Errorf("ready = %q, want %q (stdout %s)", env.Result["ready"], tc.wantWord, stdout)
			}
			if tc.wantExit != 0 {
				if env.Error == nil || env.Error.Message != err.Error() {
					t.Errorf("error = %+v, want the verdict message %q beside result", env.Error, err.Error())
				}
			}
			if tc.wantStderr != "" && !strings.Contains(stderr, tc.wantStderr) {
				t.Errorf("stderr = %q, want it to carry %q", stderr, tc.wantStderr)
			}
		})
	}
}

// TestTabNewReadyTimeoutReachesSeam: --timeout seconds reach the wait seam as
// a duration (default 300s, 0 = indefinite), aimed at the created pane.
func TestTabNewReadyTimeoutReachesSeam(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want time.Duration
	}{
		{"default", nil, 300 * time.Second},
		{"explicit", []string{"--timeout", "120"}, 120 * time.Second},
		{"zero is indefinite", []string{"--timeout", "0"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withTabTestServer(t)
			rec := stubAwaitReady(t, inject.ReadyByState, nil)

			args := append([]string{"new", "--json", "--ready"}, tc.args...)
			args = append(args, "--", "sh", "-c", "sleep 30")
			stdout, _, err := runTabCmd(t, args...)
			if err != nil {
				t.Fatalf("tab new: %v", err)
			}
			if rec.timeout != tc.want {
				t.Errorf("wait timeout = %s, want %s", rec.timeout, tc.want)
			}
			var obj map[string]string
			unwrapEnvelopeResult(t, stdout, &obj)
			if rec.pane != obj["pane_id"] {
				t.Errorf("wait pane = %q, want the created pane %q", rec.pane, obj["pane_id"])
			}
		})
	}
}

// ── rk tab layout ───────────────────────────────────────────────────────────

func TestTabLayoutSetAndReadForm(t *testing.T) {
	env := withTabTestServer(t)

	// A legacy preset string parses and is stored + printed in the tree form.
	stdout, _, err := runTabCmd(t, "layout", env.bootID, "main-left:tty,code,web")
	if err != nil {
		t.Fatalf("layout set: %v", err)
	}
	if stdout != "h(tty,v(code,web))\n" {
		t.Errorf("stdout = %q", stdout)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "h(tty,v(code,web))" {
		t.Errorf("@rk_win_layout = %q", got)
	}

	// A tree value sets verbatim.
	stdout, _, err = runTabCmd(t, "layout", env.bootID, "v(tty,h(code,web))")
	if err != nil {
		t.Fatalf("layout set tree: %v", err)
	}
	if stdout != "v(tty,h(code,web))\n" {
		t.Errorf("stdout = %q", stdout)
	}

	// Read-only form prints the value and writes nothing.
	stdout, _, err = runTabCmd(t, "layout", env.bootID)
	if err != nil {
		t.Fatalf("layout read: %v", err)
	}
	if stdout != "v(tty,h(code,web))\n" {
		t.Errorf("read stdout = %q", stdout)
	}

	// Malformed positional is a usage error, option untouched.
	if _, _, err := runTabCmd(t, "layout", env.bootID, "bogus"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("malformed: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "v(tty,h(code,web))" {
		t.Errorf("@rk_win_layout = %q after a failed set", got)
	}
}

func TestTabLayoutUnsetReadsAsTty(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "layout", env.bootID)
	if err != nil {
		t.Fatalf("layout read: %v", err)
	}
	if stdout != "tty\n" {
		t.Errorf("stdout = %q, want tty", stdout)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "" {
		t.Errorf("@rk_win_layout = %q, want untouched (unset)", got)
	}
}

func TestTabLayoutMutationsRoundTrip(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID

	// Unset + --add web reads as tty and grows through the tree verbs.
	stdout, _, err := runTabCmd(t, "layout", id, "--add", "web")
	if err != nil {
		t.Fatalf("--add web: %v", err)
	}
	if stdout != "h(tty,web)\n" {
		t.Errorf("stdout = %q, want h(tty,web)", stdout)
	}
	if got := tabWindowOption(t, env.server, id, tmux.LayoutOption); got != "h(tty,web)" {
		t.Errorf("@rk_win_layout = %q", got)
	}

	// The last leaf (web) is taller than wide on the nominal box → splits
	// vertically.
	if stdout, _, err = runTabCmd(t, "layout", id, "--add", "code"); err != nil || stdout != "h(tty,v(web,code))\n" {
		t.Errorf("--add code: stdout = %q, err = %v, want h(tty,v(web,code))", stdout, err)
	}
	if _, _, err = runTabCmd(t, "layout", id, "--add", "chat"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("--add chat (unknown surface): err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if stdout, _, err = runTabCmd(t, "layout", id, "--rm", "code"); err != nil || stdout != "h(tty,web)\n" {
		t.Errorf("--rm code: stdout = %q, err = %v, want h(tty,web)", stdout, err)
	}
	if _, _, err = runTabCmd(t, "layout", id, "--rm", "web"); err != nil {
		t.Fatalf("--rm web: %v", err)
	}
	// The bare tty leaf refuses to close its last tile.
	if _, _, err = runTabCmd(t, "layout", id, "--rm", "tty"); err == nil || exitCode(err) != 1 {
		t.Errorf("--rm tty on single: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	// An unknown surface is user input — usage error.
	if _, _, err = runTabCmd(t, "layout", id, "--add", "bogus"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("--add bogus: err = %v (code %d), want exit 2", err, exitCode(err))
	}

	// --promote and --cycle on a 3-tile layout.
	if _, _, err = runTabCmd(t, "layout", id, "main-left:tty,web,code"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if stdout, _, err = runTabCmd(t, "layout", id, "--promote", "code"); err != nil || stdout != "h(code,v(web,tty))\n" {
		t.Errorf("--promote code: stdout = %q, err = %v, want h(code,v(web,tty))", stdout, err)
	}
	if stdout, _, err = runTabCmd(t, "layout", id, "--cycle"); err != nil || stdout != "h(v(web,tty),code)\n" {
		t.Errorf("--cycle: stdout = %q, err = %v, want h(v(web,tty),code)", stdout, err)
	}
	// --promote of an unknown surface is user input — usage error.
	if _, _, err = runTabCmd(t, "layout", id, "--promote", "chat"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("--promote chat: err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

func TestTabLayoutUnparseableStoredValueReplaced(t *testing.T) {
	env := withTabTestServer(t)
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.LayoutOption, "bogus")

	stdout, stderr, err := runTabCmd(t, "layout", env.bootID, "--add", "web")
	if err != nil {
		t.Fatalf("--add web over garbage: %v", err)
	}
	if stdout != "h(tty,web)\n" {
		t.Errorf("stdout = %q, want h(tty,web)", stdout)
	}
	if !strings.Contains(stderr, "bogus") {
		t.Errorf("stderr = %q, want a note naming the replaced value", stderr)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "h(tty,web)" {
		t.Errorf("@rk_win_layout = %q", got)
	}
}

// A set introducing a foreign leaf another window already holds is refused
// (exit 1, naming the holder); a self-naming leaf is a usage error. The
// holder check enumerates the server's windows for real — the test server
// carries the boot window plus two created ones.
func TestTabLayoutSetLiveInOnePlace(t *testing.T) {
	env := withTabTestServer(t)
	tabTmuxDo(t, env.server, "new-window", "-t", "boot", "-n", "holder")
	tabTmuxDo(t, env.server, "new-window", "-t", "boot", "-n", "taker")
	holderID := tabTmuxOut(t, env.server, "display-message", "-pt", "boot:holder", "#{window_id}")
	takerID := tabTmuxOut(t, env.server, "display-message", "-pt", "boot:taker", "#{window_id}")

	// The holder window holds the boot window's tty as a foreign leaf.
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", holderID, tmux.LayoutOption, "h(tty,"+env.bootID+"/tty)")

	// The same leaf written to the taker is a conflict, and nothing is stored.
	_, _, err := runTabCmd(t, "layout", takerID, "h(tty,"+env.bootID+"/tty)")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("held-leaf set: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	if !strings.Contains(err.Error(), holderID) || !strings.Contains(err.Error(), env.bootID+"/tty") {
		t.Errorf("err = %q, want it naming the holder %s and the leaf %s/tty", err, holderID, env.bootID)
	}
	if got := tabWindowOption(t, env.server, takerID, tmux.LayoutOption); got != "" {
		t.Errorf("taker @rk_win_layout = %q after a refused write, want unset", got)
	}

	// The holder rewriting its own holding passes.
	if _, _, err := runTabCmd(t, "layout", holderID, "h(tty,"+env.bootID+"/tty)"); err != nil {
		t.Errorf("holder rewriting its own holding: %v", err)
	}

	// An unheld foreign leaf passes.
	if _, _, err := runTabCmd(t, "layout", takerID, "h(tty,"+holderID+"/tty)"); err != nil {
		t.Errorf("unheld-leaf set: %v", err)
	}

	// A leaf naming the layout's own window is a usage error.
	if _, _, err := runTabCmd(t, "layout", takerID, "h(tty,"+takerID+"/tty)"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("self-leaf set: err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

// ── rk tab web add ──────────────────────────────────────────────────────────

func TestTabWebAddPrintsAddressAndShowGrowsLayout(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)

	stdout, stderr, err := runTabCmd(t, "web", "add", env.bootID, fmt.Sprintf(":%d", port), "--show")
	if err != nil {
		t.Fatalf("web add: %v", err)
	}
	wantURL := fmt.Sprintf("/proxy/%d/", port)
	if stdout != env.bootID+"/web/1\n" {
		t.Errorf("stdout = %q, want %s/web/1", stdout, env.bootID)
	}
	if !strings.Contains(stderr, "url: "+wantURL) {
		t.Errorf("stderr = %q, want a url: note", stderr)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.WebTabOption(1)); got != wantURL {
		t.Errorf("@rk_win_web_1 = %q, want %q", got, wantURL)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.WebActiveOption); got != "1" {
		t.Errorf("@rk_win_web_active = %q, want 1", got)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "h(tty,web)" {
		t.Errorf("@rk_win_layout = %q, want h(tty,web)", got)
	}
}

func TestTabWebAddIdempotent(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)
	target := fmt.Sprintf(":%d", port)

	if _, _, err := runTabCmd(t, "web", "add", env.bootID, target); err != nil {
		t.Fatalf("web add: %v", err)
	}
	stdout, _, err := runTabCmd(t, "web", "add", env.bootID, target)
	if err != nil {
		t.Fatalf("web re-add: %v", err)
	}
	if stdout != env.bootID+"/web/1\n" {
		t.Errorf("stdout = %q, want the existing slot", stdout)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.WebTabOption(2)); got != "" {
		t.Errorf("@rk_win_web_2 = %q, want no duplicate append", got)
	}
}

func TestTabWebAddFullExitsOne(t *testing.T) {
	env := withTabTestServer(t)
	for n := 1; n <= tmux.MaxWebTabs; n++ {
		tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.WebTabOption(n), fmt.Sprintf("/proxy/%d/", n))
	}

	_, _, err := runTabCmd(t, "web", "add", env.bootID, "https://new.example.com")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
	}
	if !strings.Contains(err.Error(), "full") {
		t.Errorf("err = %v, want a full message", err)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.WebTabOption(tmux.MaxWebTabs)); got != fmt.Sprintf("/proxy/%d/", tmux.MaxWebTabs) {
		t.Errorf("family changed on a full add: %s = %q", tmux.WebTabOption(tmux.MaxWebTabs), got)
	}
}

// --show on a full layout without web replaces the LAST leaf in reading order
// with web in place (slot A untouched); a full layout that already holds web
// is left alone.
func TestTabWebAddShowAddsTile(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.LayoutOption, "h(tty,v(code,gui))")

	stdout, _, err := runTabCmd(t, "web", "add", env.bootID, fmt.Sprintf(":%d", port), "--show")
	if err != nil {
		t.Fatalf("web add --show: %v", err)
	}
	if stdout != env.bootID+"/web/1\n" {
		t.Errorf("stdout = %q", stdout)
	}
	// No tile cap: the last leaf splits on its longer axis for the web tile.
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "h(tty,v(code,h(gui,web)))" {
		t.Errorf("@rk_win_layout = %q, want h(tty,v(code,h(gui,web)))", got)
	}

	// web already in the layout: the second add leaves it untouched.
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.LayoutOption, "main-left:tty,code,web")
	if _, _, err := runTabCmd(t, "web", "add", env.bootID, fmt.Sprintf(":%d", port), "--show"); err != nil {
		t.Fatalf("web re-add --show: %v", err)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.LayoutOption); got != "main-left:tty,code,web" {
		t.Errorf("@rk_win_layout = %q, want main-left:tty,code,web (verbatim, untouched)", got)
	}
}

// ── rk tab web rm / select ─────────────────────────────────────────────────

func TestTabWebRmRenumbersAndRepoints(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	for i, u := range []string{"/proxy/1/", "/proxy/2/", "/proxy/3/"} {
		tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(i+1), u)
	}
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabRootOption(3), "/r3")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebActiveOption, "3")

	stdout, _, err := runTabCmd(t, "web", "rm", id+"/web/2")
	if err != nil {
		t.Fatalf("web rm: %v", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on success", stdout)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(1)); got != "/proxy/1/" {
		t.Errorf("web_1 = %q", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(2)); got != "/proxy/3/" {
		t.Errorf("web_2 = %q, want /proxy/3/ (shifted)", got)
	}
	t.Logf("options after rm:\n%s", tabTmuxOut(t, env.server, "show-options", "-w", "-t", id))
	if got := tabWindowOption(t, env.server, id, tmux.WebTabRootOption(2)); got != "/r3" {
		t.Errorf("web_2_root = %q, want /r3 (moved with its URL)", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabRootOption(3)); got != "" {
		t.Errorf("web_3_root = %q, want unset", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(3)); got != "" {
		t.Errorf("web_3 = %q, want unset", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebActiveOption); got != "2" {
		t.Errorf("active = %q, want 2", got)
	}
}

func TestTabWebSelectAndBounds(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(1), "/proxy/1/")

	stdout, _, err := runTabCmd(t, "web", "select", id+"/web/1")
	if err != nil || stdout != "" {
		t.Errorf("select 1: stdout = %q, err = %v", stdout, err)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebActiveOption); got != "1" {
		t.Errorf("active = %q", got)
	}

	// Out-of-range <n> is operational and names the family length.
	if _, _, err := runTabCmd(t, "web", "select", "3"); err == nil || exitCode(err) != 1 {
		t.Errorf("select 3: err = %v (code %d), want exit 1", err, exitCode(err))
	} else if !strings.Contains(err.Error(), "family has 1") {
		t.Errorf("err = %v, want the family length named", err)
	}
	// A slot-less address is usage.
	if _, _, err := runTabCmd(t, "web", "rm", id); err == nil || exitCode(err) != exitUsage {
		t.Errorf("rm with no <n>: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	// Out-of-range rm is operational.
	if _, _, err := runTabCmd(t, "web", "rm", "web/5"); err == nil || exitCode(err) != 1 {
		t.Errorf("rm web/5: err = %v (code %d), want exit 1", err, exitCode(err))
	}
}

// ── rk tab web mv ───────────────────────────────────────────────────────────

// mv permutes URL+root pairs, repoints the active pointer to follow the moved
// or affected slots, and prints the resulting address.
func TestTabWebMvPermutesAndRepoints(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	for i, u := range []string{"/proxy/1/", "/proxy/2/", "/proxy/3/"} {
		tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(i+1), u)
	}
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabRootOption(3), "/r3")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebActiveOption, "3")

	stdout, _, err := runTabCmd(t, "web", "mv", id+"/web/1", "3")
	if err != nil {
		t.Fatalf("web mv: %v", err)
	}
	if stdout != id+"/web/3\n" {
		t.Errorf("stdout = %q, want the resulting address %s/web/3", stdout, id)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(2)); got != "/proxy/3/" {
		t.Errorf("web_2 = %q, want /proxy/3/", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabRootOption(2)); got != "/r3" {
		t.Errorf("web_2_root = %q, want /r3 (moved with its URL)", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(3)); got != "/proxy/1/" {
		t.Errorf("web_3 = %q, want /proxy/1/", got)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebActiveOption); got != "2" {
		t.Errorf("active = %q, want 2 (follows the shifted slot)", got)
	}
}

func TestTabWebMvBareIndexGrammar(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(1), "/proxy/1/")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(2), "/proxy/2/")

	stdout, _, err := runTabCmd(t, "web", "mv", "web/2", "1")
	if err != nil {
		t.Fatalf("web mv web/2 1: %v", err)
	}
	if stdout != id+"/web/1\n" {
		t.Errorf("stdout = %q, want %s/web/1", stdout, id)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(1)); got != "/proxy/2/" {
		t.Errorf("web_1 = %q, want /proxy/2/", got)
	}
}

func TestTabWebMvBounds(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(1), "/proxy/1/")

	// Out-of-range <to> names the destination, not the source.
	if _, _, err := runTabCmd(t, "web", "mv", "1", "5"); err == nil || exitCode(err) != 1 {
		t.Errorf("mv 1 5: err = %v (code %d), want exit 1", err, exitCode(err))
	} else if !strings.Contains(err.Error(), "no web tab 5") {
		t.Errorf("err = %v, want the destination named", err)
	}
	// A missing <m> is usage-class.
	if _, _, err := runTabCmd(t, "web", "mv", "1"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("mv with no <m>: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	// A non-numeric <m> is usage-class.
	if _, _, err := runTabCmd(t, "web", "mv", "1", "x"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("mv 1 x: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	// n == to succeeds and leaves the family untouched.
	if stdout, _, err := runTabCmd(t, "web", "mv", "1", "1"); err != nil {
		t.Fatalf("mv 1 1: %v", err)
	} else if stdout != id+"/web/1\n" {
		t.Errorf("stdout = %q, want unchanged address", stdout)
	}
	if got := tabWindowOption(t, env.server, id, tmux.WebTabOption(1)); got != "/proxy/1/" {
		t.Errorf("web_1 = %q, want untouched", got)
	}
}

func TestTabWebLsHumanAndJSON(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(1), "/proxy/1/")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(2), "/proxy/2/")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebActiveOption, "2")

	stdout, _, err := runTabCmd(t, "web", "ls", id)
	if err != nil {
		t.Fatalf("web ls: %v", err)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout = %q, want 2 rows", stdout)
	}
	if !strings.Contains(lines[0], "1") || strings.Contains(lines[0], "*") {
		t.Errorf("row 1 = %q, want unmarked", lines[0])
	}
	if !strings.Contains(lines[1], "*") || !strings.Contains(lines[1], "/proxy/2/") {
		t.Errorf("row 2 = %q, want * and /proxy/2/", lines[1])
	}

	stdout, _, err = runTabCmd(t, "web", "ls", id, "--json")
	if err != nil {
		t.Fatalf("web ls --json: %v, want exit 0", err)
	}
	if !strings.Contains(stdout, `"windowId": "`+id+`"`) || !strings.Contains(stdout, `"active": 2`) ||
		!strings.Contains(stdout, `"index": 1`) || !strings.Contains(stdout, `"url": "/proxy/2/"`) {
		t.Errorf("json = %q", stdout)
	}
	if strings.Contains(stdout, "root") {
		t.Errorf("json = %q, want root omitted when empty", stdout)
	}
}

func TestTabWebLsEmpty(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "web", "ls", env.bootID)
	if err != nil || stdout != "" {
		t.Errorf("ls: stdout = %q, err = %v, want empty output exit 0", stdout, err)
	}
	stdout, _, err = runTabCmd(t, "web", "ls", env.bootID, "--json")
	if err != nil {
		t.Fatalf("ls --json: %v, want exit 0", err)
	}
	if !strings.Contains(stdout, `"tabs": []`) {
		t.Errorf("json = %q, want tabs: []", stdout)
	}
}

// ── rk tab code set ─────────────────────────────────────────────────────────

func TestTabCodeSet(t *testing.T) {
	env := withTabTestServer(t)
	dir := t.TempDir()

	stdout, _, err := runTabCmd(t, "code", "set", env.bootID, dir)
	if err != nil {
		t.Fatalf("code set: %v", err)
	}
	abs, _ := filepath.Abs(dir)
	if stdout != abs+"\n" {
		t.Errorf("stdout = %q, want %q", stdout, abs)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.CodeRootOption); got != abs {
		t.Errorf("@rk_win_code_root = %q, want %q", got, abs)
	}

	if _, _, err := runTabCmd(t, "code", "set", env.bootID, filepath.Join(dir, "missing")); err == nil || exitCode(err) != 1 {
		t.Errorf("missing dir: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.CodeRootOption); got != abs {
		t.Errorf("@rk_win_code_root = %q after a failed set, want untouched", got)
	}
}

// ── rk tab show ─────────────────────────────────────────────────────────────

func TestTabShow(t *testing.T) {
	env := withTabTestServer(t)
	id := env.bootID

	// Nothing set: empty stdout, exit 0.
	stdout, _, err := runTabCmd(t, "show", id)
	if err != nil || stdout != "" {
		t.Errorf("empty show: stdout = %q, err = %v", stdout, err)
	}

	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.LayoutOption, "split-h:tty,web")
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", id, tmux.WebTabOption(1), "/proxy/8080/")

	stdout, _, err = runTabCmd(t, "show", id)
	if err != nil {
		t.Fatalf("show: %v", err)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout = %q, want 2 sorted rows", stdout)
	}
	if !strings.HasPrefix(lines[0], tmux.LayoutOption) || !strings.Contains(lines[0], "split-h:tty,web") {
		t.Errorf("row 1 = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], tmux.WebTabOption(1)) {
		t.Errorf("row 2 = %q, want sorted by key", lines[1])
	}

	stdout, _, err = runTabCmd(t, "show", id, "--json")
	if err != nil {
		t.Fatalf("show --json: %v, want exit 0", err)
	}
	if !strings.Contains(stdout, `"@rk_win_layout": "split-h:tty,web"`) ||
		!strings.Contains(stdout, `"@rk_win_web_1": "/proxy/8080/"`) {
		t.Errorf("json = %q", stdout)
	}
}

// ── server and own-tab resolution ───────────────────────────────────────────

func TestTabServerFlagWithoutAddressExitsTwo(t *testing.T) {
	withTabTestServer(t)

	if _, _, err := runTabCmd(t, "-L", "other", "web", "ls"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

func TestTabForeignServerAddress(t *testing.T) {
	env := withTabTestServer(t)

	// -L names the caller's own test server explicitly: an @N address
	// resolves there without a pane.
	stdout, _, err := runTabCmd(t, "-L", env.server, "web", "ls", env.bootID, "--json")
	if err != nil {
		t.Fatalf("ls -L: %v, want exit 0", err)
	}
	if !strings.Contains(stdout, `"windowId": "`+env.bootID+`"`) {
		t.Errorf("json = %q", stdout)
	}
}

func TestTabOutsideTmuxWithoutAddressExitsOne(t *testing.T) {
	env := withTabTestServer(t)
	t.Setenv("TMUX_PANE", "")

	_, _, err := runTabCmd(t, "web", "ls")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
	}
	if !strings.Contains(err.Error(), "@N") {
		t.Errorf("err = %v, want the fix named (pass @N)", err)
	}
	_ = env
}

func TestTabOwnTabAddressForms(t *testing.T) {
	env := withTabTestServer(t)
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.WebTabOption(1), "/proxy/1/")

	// Bare <n> and web/<n> address the caller's own tab (TMUX_PANE set).
	if _, _, err := runTabCmd(t, "web", "select", "1"); err != nil {
		t.Errorf("select 1: %v", err)
	}
	if _, _, err := runTabCmd(t, "web", "select", "web/1"); err != nil {
		t.Errorf("select web/1: %v", err)
	}
	if got := tabWindowOption(t, env.server, env.bootID, tmux.WebActiveOption); got != "1" {
		t.Errorf("active = %q", got)
	}
	// =session:window resolves exactly like @N.
	if _, _, err := runTabCmd(t, "web", "ls", "=boot:0", "--json"); err != nil {
		t.Errorf("ls =boot:0: %v", err)
	}
	// A bare session:window is rejected (the rk mux rule).
	if _, _, err := runTabCmd(t, "web", "ls", "boot:0"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("ls boot:0: err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

func TestTabUsageArgCounts(t *testing.T) {
	withTabTestServer(t)

	if _, _, err := runTabCmd(t, "web", "add"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("web add with no target: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if _, _, err := runTabCmd(t, "web", "rm"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("web rm with no address: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if _, _, err := runTabCmd(t, "code", "set"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("code set with no folder: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if _, _, err := runTabCmd(t, "show", "@1", "@2"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("show with two args: err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

// TestTabLayoutJSONReceipt: --json prints one envelope {window, layout} on
// the set, read, and flag-mutation forms alike; the human line is unchanged
// without the flag (pinned by the tests above).
func TestTabLayoutJSONReceipt(t *testing.T) {
	env := withTabTestServer(t)

	stdout, _, err := runTabCmd(t, "layout", env.bootID, "split-h:tty,web", "--json")
	if err != nil {
		t.Fatalf("layout set: %v", err)
	}
	want := map[string]any{"window": env.bootID, "layout": "h(tty,web)"}
	assertEnvelopeResult(t, stdout, want)

	stdout, _, err = runTabCmd(t, "layout", env.bootID, "--json")
	if err != nil {
		t.Fatalf("layout read: %v", err)
	}
	assertEnvelopeResult(t, stdout, want) // read and mutate share the receipt

	stdout, _, err = runTabCmd(t, "layout", env.bootID, "--add", "code", "--json")
	if err != nil {
		t.Fatalf("layout --add: %v", err)
	}
	assertEnvelopeResult(t, stdout, map[string]any{"window": env.bootID, "layout": "h(tty,v(web,code))"})

	// A usage failure under --json is the usage envelope with exit 2.
	stdout, _, err = runTabCmd(t, "layout", env.bootID, "bogus", "--json")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("malformed: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	stdout = centralFailureEnvelope(t, stdout, err)
	var doc struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if jsonErr := json.Unmarshal([]byte(stdout), &doc); jsonErr != nil {
		t.Fatalf("stdout is not one JSON document: %v (%q)", jsonErr, stdout)
	}
	if doc.OK || doc.Error.Code != "usage" {
		t.Errorf("envelope = %q, want ok:false usage", stdout)
	}
}

// TestTabCodeSetJSONReceipt: --json prints one envelope {window, code_root};
// the failure under --json is the operational envelope with exit 1.
func TestTabCodeSetJSONReceipt(t *testing.T) {
	env := withTabTestServer(t)
	dir := t.TempDir()

	stdout, _, err := runTabCmd(t, "code", "set", env.bootID, dir, "--json")
	if err != nil {
		t.Fatalf("code set: %v", err)
	}
	abs, _ := filepath.Abs(dir)
	assertEnvelopeResult(t, stdout, map[string]any{"window": env.bootID, "code_root": abs})
	if got := tabWindowOption(t, env.server, env.bootID, tmux.CodeRootOption); got != abs {
		t.Errorf("@rk_win_code_root = %q, want %q", got, abs)
	}

	stdout, _, err = runTabCmd(t, "code", "set", env.bootID, filepath.Join(dir, "missing"), "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("missing dir: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	stdout = centralFailureEnvelope(t, stdout, err)
	var doc struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if jsonErr := json.Unmarshal([]byte(stdout), &doc); jsonErr != nil {
		t.Fatalf("stdout is not one JSON document: %v (%q)", jsonErr, stdout)
	}
	if doc.OK || doc.Error.Code != "operational" {
		t.Errorf("envelope = %q, want ok:false operational", stdout)
	}
}

// TestTabWebJSONReceipts: the four mutations print one envelope each under
// --json — {window, index, url?, tabs} with tabs holding the post-mutation
// family in the ls entry shape; mv's index is the destination slot.
func TestTabWebJSONReceipts(t *testing.T) {
	env := withTabTestServer(t)
	port := tabTestListener(t)

	stdout, _, err := runTabCmd(t, "web", "add", env.bootID, fmt.Sprintf(":%d", port), "--json")
	if err != nil {
		t.Fatalf("web add: %v", err)
	}
	var addDoc struct {
		OK     bool `json:"ok"`
		Result struct {
			Window string `json:"window"`
			Index  int    `json:"index"`
			URL    string `json:"url"`
			Tabs   []struct {
				Index int    `json:"index"`
				URL   string `json:"url"`
			} `json:"tabs"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(stdout), &addDoc); err != nil {
		t.Fatalf("add stdout is not one JSON document: %v (%q)", err, stdout)
	}
	wantURL := fmt.Sprintf("/proxy/%d/", port)
	if !addDoc.OK || addDoc.Result.Window != env.bootID || addDoc.Result.Index != 1 || addDoc.Result.URL != wantURL {
		t.Errorf("add receipt = %+v, want {window %s, index 1, url %s}", addDoc, env.bootID, wantURL)
	}
	if len(addDoc.Result.Tabs) != 1 || addDoc.Result.Tabs[0].URL != wantURL {
		t.Errorf("add tabs = %+v, want the one-entry family", addDoc.Result.Tabs)
	}

	// A second slot so rm's family read-back has a remaining entry.
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.WebTabOption(2), "https://example.com")

	stdout, _, err = runTabCmd(t, "web", "rm", env.bootID+"/web/1", "--json")
	if err != nil {
		t.Fatalf("web rm: %v", err)
	}
	var mutDoc struct {
		OK     bool `json:"ok"`
		Result struct {
			Window string `json:"window"`
			Index  int    `json:"index"`
			Tabs   []struct {
				Index int    `json:"index"`
				URL   string `json:"url"`
			} `json:"tabs"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(stdout), &mutDoc); err != nil {
		t.Fatalf("rm stdout is not one JSON document: %v (%q)", err, stdout)
	}
	if !mutDoc.OK || mutDoc.Result.Window != env.bootID || mutDoc.Result.Index != 1 {
		t.Errorf("rm receipt = %+v, want {window %s, index 1}", mutDoc, env.bootID)
	}
	if len(mutDoc.Result.Tabs) != 1 || mutDoc.Result.Tabs[0].URL != "https://example.com" {
		t.Errorf("rm tabs = %+v, want the post-removal family (one entry)", mutDoc.Result.Tabs)
	}

	stdout, _, err = runTabCmd(t, "web", "select", env.bootID+"/web/1", "--json")
	if err != nil {
		t.Fatalf("web select: %v", err)
	}
	if err := json.Unmarshal([]byte(stdout), &mutDoc); err != nil {
		t.Fatalf("select stdout is not one JSON document: %v (%q)", err, stdout)
	}
	if !mutDoc.OK || mutDoc.Result.Index != 1 || len(mutDoc.Result.Tabs) != 1 {
		t.Errorf("select receipt = %+v", mutDoc)
	}

	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.WebTabOption(2), "https://two.example.com")
	stdout, _, err = runTabCmd(t, "web", "mv", env.bootID+"/web/2", "1", "--json")
	if err != nil {
		t.Fatalf("web mv: %v", err)
	}
	if err := json.Unmarshal([]byte(stdout), &mutDoc); err != nil {
		t.Fatalf("mv stdout is not one JSON document: %v (%q)", err, stdout)
	}
	if !mutDoc.OK || mutDoc.Result.Index != 1 || len(mutDoc.Result.Tabs) != 2 || mutDoc.Result.Tabs[0].URL != "https://two.example.com" {
		t.Errorf("mv receipt = %+v, want index 1 (the destination) and the reordered family", mutDoc)
	}
}

// TestTabWebShowRejectedOnNonAdd: --show is a persistent family flag, but
// rm/select/mv reject it as a usage error (exit 2) — under --json with the
// usage envelope on stdout.
func TestTabWebShowRejectedOnNonAdd(t *testing.T) {
	env := withTabTestServer(t)
	tabTmuxDo(t, env.server, "set-option", "-w", "-t", env.bootID, tmux.WebTabOption(1), "/proxy/1/")

	for _, verb := range []string{"rm", "select"} {
		stdout, _, err := runTabCmd(t, "web", verb, env.bootID+"/web/1", "--show", "--json")
		if err == nil || exitCode(err) != exitUsage {
			t.Errorf("web %s --show: err = %v (code %d), want exit 2", verb, err, exitCode(err))
		}
		stdout = centralFailureEnvelope(t, stdout, err)
		var doc struct {
			OK    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if jsonErr := json.Unmarshal([]byte(stdout), &doc); jsonErr != nil {
			t.Fatalf("web %s --show stdout is not one JSON document: %v (%q)", verb, jsonErr, stdout)
		}
		if doc.OK || doc.Error.Code != "usage" {
			t.Errorf("web %s --show envelope = %q, want ok:false usage", verb, stdout)
		}
	}
	stdout, _, err := runTabCmd(t, "web", "mv", env.bootID+"/web/1", "1", "--show")
	if err == nil || exitCode(err) != exitUsage {
		t.Errorf("web mv --show: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("web mv --show stdout = %q, want empty without --json", stdout)
	}
}
