package daemon

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"

	"rk/internal/config"
	"rk/internal/settings"
	"rk/internal/testutil"
	"rk/internal/tmux"
)

// testSocketName builds a unified test socket name: rk-test-<role>-<pid>-<ns>.
// Local copy of the helper in internal/tmux/main_test.go (Go _test.go symbols
// are package-private and cannot be shared across packages). PID-stamping the
// former fixed name rk-daemon-test makes the socket parseable by the automatic
// post-sweep instead of relying on t.Cleanup alone.
func testSocketName(role string) string {
	return fmt.Sprintf("rk-test-%s-%d-%d", role, os.Getpid(), time.Now().UnixNano())
}

// testSocket is the daemon package's isolated test socket. Was a fixed
// rk-daemon-test; now PID-stamped under the unified umbrella. Computed once per
// test binary so every helper that targets it (useTestSocket, withServerSocket,
// startOn/stopOn) shares the same name.
var testSocket = testSocketName("daemon")

func hasTmux() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

// useTestSocket swaps the daemon socket to an isolated test socket and restores it on cleanup.
func useTestSocket(t *testing.T) {
	t.Helper()
	// Kill any leftover test session from a prior run.
	_ = exec.Command("tmux", "-L", testSocket, "kill-server").Run()
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", testSocket, "kill-server").Run()
	})
}

// withServerSocket redirects the daemon package's runTmux to the test socket
// for the duration of the test, so IsRunning/Stop can be exercised without
// touching a real production daemon.
func withServerSocket(t *testing.T, socket string) {
	t.Helper()
	orig := serverSocket
	serverSocket = socket
	t.Cleanup(func() { serverSocket = orig })
}

// withStopTiming shrinks Stop()'s grace period and poll interval for the
// duration of the test and restores them on cleanup. Shrinking the grace
// period lets a test deterministically drive Stop() into its timeout/kill
// branch — the code path the rk-update restart bug lived in — without burning
// the full 12s wall-clock. Mirrors the withServerSocket test seam.
func withStopTiming(t *testing.T, grace, poll time.Duration) {
	t.Helper()
	origGrace, origPoll := stopGracePeriod, stopPollInterval
	stopGracePeriod, stopPollInterval = grace, poll
	t.Cleanup(func() { stopGracePeriod, stopPollInterval = origGrace, origPoll })
}

func TestConstants(t *testing.T) {
	if ServerSocket != "rk-daemon" {
		t.Errorf("ServerSocket = %q, want %q", ServerSocket, "rk-daemon")
	}
	if SessionName != "rk-daemon" {
		t.Errorf("SessionName = %q, want %q", SessionName, "rk-daemon")
	}
	if LegacySessionName != "rk" {
		t.Errorf("LegacySessionName = %q, want %q", LegacySessionName, "rk")
	}
	if WindowName != "serve" {
		t.Errorf("WindowName = %q, want %q", WindowName, "serve")
	}
}

func TestTarget(t *testing.T) {
	got := target()
	want := "=rk-daemon:=serve"
	if got != want {
		t.Errorf("target() = %q, want %q", got, want)
	}
}

func TestTargetFor_Legacy(t *testing.T) {
	got := targetFor(LegacySessionName)
	want := "=rk:=serve"
	if got != want {
		t.Errorf("targetFor(legacy) = %q, want %q", got, want)
	}
}

// hasSessionOn checks if the given session exists on the socket using exact match.
func hasSessionOn(socket, session string) bool {
	cmd := exec.Command("tmux", "-L", socket, "has-session", "-t", "="+session)
	return cmd.Run() == nil
}

// isRunningOn checks if the current-name session exists on the given socket.
func isRunningOn(socket string) bool {
	return hasSessionOn(socket, SessionName)
}

// startOn creates a session with the given name on the socket using a harmless command.
func startOn(socket, session string) error {
	return exec.Command("tmux", "-L", socket,
		"new-session", "-d", "-s", session, "-n", WindowName,
		"sleep", "300").Run()
}

// startSelfExitingOn creates a session whose inner command HONORS SIGINT (C-c)
// AND also self-exits after a fixed short delay, so the session vanishes on its
// own within a bounded, signal-delivery-independent window. Unlike startOn's
// `sleep 300` (ignores C-c, stays alive), and unlike a pure `trap … INT` shell
// (whose exit timing depends on C-c delivery latency and so races a short grace
// period under load), the fixed `sleep` bounds teardown deterministically:
// pair it with a grace period several times larger and the session is reliably
// gone before the grace timer fires — no wall-clock race. delaySec is the
// fixed self-exit delay in seconds (fractional ok, e.g. "0.2").
func startSelfExitingOn(socket, session, delaySec string) error {
	return exec.Command("tmux", "-L", socket,
		"new-session", "-d", "-s", session, "-n", WindowName,
		"sh", "-c", "trap 'exit 0' INT; sleep "+delaySec+"; exit 0").Run()
}

// startIntHonoringOn creates a session whose inner command HONORS SIGINT (C-c)
// but otherwise stays alive indefinitely (a `sleep`-loop under `trap … INT`, no
// self-exit). Unlike startSelfExitingOn (which also self-exits after a fixed
// delay) this session vanishes ONLY when C-c is actually delivered to the
// process — so it is the right fixture for the copy-mode regression test, which
// must prove the pre-cancel is what lets the interrupt reach the process. If
// C-c is consumed by a pane mode (the pre-fix bug) instead of reaching the
// process, the session stays alive.
func startIntHonoringOn(socket, session string) error {
	return exec.Command("tmux", "-L", socket,
		"new-session", "-d", "-s", session, "-n", WindowName,
		"sh", "-c", "trap 'exit 0' INT; while true; do sleep 0.05; done").Run()
}

// startOnWithWindow creates a session on the socket with an explicitly named
// window (NOT WindowName) using a harmless C-c-ignoring command. Used by the
// send-failure fall-through test: the daemon target Stop() computes is
// `=<session>:=serve`, so a window named anything other than "serve" makes
// send-keys/copy-mode to that target fail with "can't find window: serve" while
// has-session/kill-session against `=<session>` still resolve — a deterministic
// send failure that needs no attached read-only -CC client.
func startOnWithWindow(socket, session, window string) error {
	return exec.Command("tmux", "-L", socket,
		"new-session", "-d", "-s", session, "-n", window,
		"sleep", "300").Run()
}

// enterCopyModeOn drives the given session's WindowName pane into tmux
// copy-mode on the socket — reproducing the operator-box state that wedged
// `rk daemon stop`.
func enterCopyModeOn(socket, session string) error {
	return exec.Command("tmux", "-L", socket, "copy-mode",
		"-t", "="+session+":="+WindowName).Run()
}

// stopOn sends C-c and kills the named session on the given socket.
func stopOn(socket, session string) {
	_ = exec.Command("tmux", "-L", socket, "send-keys",
		"-t", "="+session+":="+WindowName, "C-c").Run()
	_ = exec.Command("tmux", "-L", socket, "kill-session", "-t", "="+session).Run()
}

func TestIsRunning_NoSession(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	useTestSocket(t)

	if isRunningOn(testSocket) {
		t.Error("isRunningOn() = true, want false when no session exists")
	}
}

func TestStartAndStop(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)

	// Start a session on the test socket.
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() error: %v", err)
	}
	if !isRunningOn(testSocket) {
		t.Fatal("isRunningOn() = false after startOn()")
	}

	// Starting again should fail (session already exists).
	if err := startOn(testSocket, SessionName); err == nil {
		t.Error("startOn() should error when session already exists")
	}

	// Stop should succeed.
	stopOn(testSocket, SessionName)
	if isRunningOn(testSocket) {
		t.Error("isRunningOn() = true after stopOn()")
	}
}

func TestRestart_WhenNotRunning(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)

	// Start on test socket (simulates restart when not running).
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() error: %v", err)
	}
	if !isRunningOn(testSocket) {
		t.Error("isRunningOn() = false after startOn()")
	}
}

func TestStartWithBinary_InvalidPath(t *testing.T) {
	if IsRunning() {
		t.Skip("skipping — production daemon is running")
	}

	// Pin RK_HOST/RK_PORT to a known-free port so the port-probe guard
	// (added by the deterministic-daemon-lifecycle change) passes and we
	// reach the symlink-resolution path this test is asserting against.
	port := freeTCPPort(t)
	t.Setenv("RK_HOST", "127.0.0.1")
	t.Setenv("RK_PORT", fmt.Sprintf("%d", port))

	// Satisfy the tmux-presence precheck hermetically — this test asserts
	// the symlink-resolution path and must pass on tmux-less hosts too.
	stubTmuxLookPath(t, "tmux")

	// StartWithBinary should return an error for a nonexistent path.
	err := StartWithBinary("/nonexistent/path/rk")
	if err == nil {
		t.Fatal("StartWithBinary with invalid path should return error")
	}
	wantMsg := "resolving executable symlinks"
	if !strings.Contains(err.Error(), wantMsg) {
		t.Errorf("error = %q, want it to contain %q", err, wantMsg)
	}
}

// stubTmuxLookPath swaps daemonTmuxLookPath for a stub resolving exactly the
// given binaries, restoring the real exec.LookPath at cleanup. When tmux is
// among the resolved binaries the version probe is stubbed to unknown too, so
// precheck-passing tests stay hermetic (no real `tmux -V` on the host).
func stubTmuxLookPath(t *testing.T, found ...string) {
	t.Helper()
	set := make(map[string]bool, len(found))
	for _, f := range found {
		set[f] = true
	}
	orig := daemonTmuxLookPath
	t.Cleanup(func() { daemonTmuxLookPath = orig })
	daemonTmuxLookPath = func(name string) (string, error) {
		if set[name] {
			return "/usr/bin/" + name, nil
		}
		return "", errors.New("not found")
	}
	if set["tmux"] {
		stubTmuxVersion(t, tmux.Version{}, false)
	}
}

// stubTmuxVersion swaps daemonTmuxVersion for a stub returning the given
// version/known pair (unknown when known is false), restoring at cleanup.
func stubTmuxVersion(t *testing.T, v tmux.Version, known bool) {
	t.Helper()
	orig := daemonTmuxVersion
	t.Cleanup(func() { daemonTmuxVersion = orig })
	daemonTmuxVersion = func(context.Context) (tmux.Version, bool) { return v, known }
}

// captureWarnWriter swaps daemonWarnWriter for a buffer, restored at cleanup.
func captureWarnWriter(t *testing.T) *bytes.Buffer {
	t.Helper()
	buf := new(bytes.Buffer)
	orig := daemonWarnWriter
	t.Cleanup(func() { daemonWarnWriter = orig })
	daemonWarnWriter = buf
	return buf
}

func TestCheckTmuxPresent_BelowFloorWarnsOnceAndContinues(t *testing.T) {
	stubTmuxLookPath(t, "tmux")
	stubTmuxVersion(t, tmux.Version{Major: 3, Minor: 2, Raw: "3.2a"}, true)
	buf := captureWarnWriter(t)

	// The warning is not a gate: below floor, the precheck still passes.
	if err := checkTmuxPresent(); err != nil {
		t.Fatalf("checkTmuxPresent below floor = %v, want nil (warn-don't-block)", err)
	}
	want := tmux.UpgradeHint(runtime.GOOS, daemonTmuxLookPath, "3.2a")
	got := strings.TrimSpace(buf.String())
	if got != want {
		t.Errorf("warning = %q, want exactly %q", got, want)
	}
}

func TestCheckTmuxPresent_AtFloorAndUnknownStaySilent(t *testing.T) {
	cases := []struct {
		name  string
		v     tmux.Version
		known bool
	}{
		// Exactly 3.4 passes silently — the >= comparison is load-bearing.
		{"at floor", tmux.Version{Major: 3, Minor: 4, Raw: "3.4"}, true},
		{"above floor", tmux.Version{Major: 3, Minor: 6, Raw: "3.6a"}, true},
		{"unknown", tmux.Version{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubTmuxLookPath(t, "tmux")
			stubTmuxVersion(t, tc.v, tc.known)
			buf := captureWarnWriter(t)

			if err := checkTmuxPresent(); err != nil {
				t.Fatalf("checkTmuxPresent = %v, want nil", err)
			}
			if buf.Len() != 0 {
				t.Errorf("warning writer got %q, want silence", buf.String())
			}
		})
	}
}

func TestStart_TmuxMissingFailsFastWithHint(t *testing.T) {
	stubTmuxLookPath(t)

	// The hint half of the message is GOOS-dependent (darwin answers with the
	// brew hint before any manager probe), so derive the expectation from the
	// same inputs the precheck uses instead of hard-coding one branch.
	wantHint := tmux.InstallHint(runtime.GOOS, daemonTmuxLookPath)

	for name, start := range map[string]func() error{
		"Start":           Start,
		"StartWithBinary": func() error { return StartWithBinary("/nonexistent/path/rk") },
	} {
		err := start()
		if err == nil {
			t.Fatalf("%s with tmux missing should return error", name)
		}
		for _, want := range []string{"tmux not found on PATH", wantHint, "rk doctor"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s error = %q, want it to contain %q", name, err, want)
			}
		}
	}
}

func TestStart_TmuxMissingHintIsPackageManagerAware(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("package-manager probe is linux-only")
	}
	stubTmuxLookPath(t, "apt-get")

	err := Start()
	if err == nil {
		t.Fatal("Start with tmux missing should return error")
	}
	want := "install with: sudo apt-get install tmux"
	if !strings.Contains(err.Error(), want) {
		t.Errorf("error = %q, want it to contain %q", err, want)
	}
}

func TestRestart_BinaryInvalidPath(t *testing.T) {
	if IsRunning() {
		t.Skip("skipping — production daemon is running")
	}

	// Pin RK_HOST/RK_PORT to a known-free port (see TestStartWithBinary_InvalidPath).
	port := freeTCPPort(t)
	t.Setenv("RK_HOST", "127.0.0.1")
	t.Setenv("RK_PORT", fmt.Sprintf("%d", port))

	// Satisfy the tmux-presence precheck hermetically (see TestStartWithBinary_InvalidPath).
	stubTmuxLookPath(t, "tmux")

	err := Restart(RestartOptions{Binary: "/nonexistent/path/rk"})
	if err == nil {
		t.Fatal("Restart with an invalid Binary path should return error")
	}
	wantMsg := "resolving executable symlinks"
	if !strings.Contains(err.Error(), wantMsg) {
		t.Errorf("error = %q, want it to contain %q", err, wantMsg)
	}
}

// TestIsRunning_IgnoresPrefixCollision is the regression test for the bug
// that motivated the SessionName rename + `=` anchors. A leftover relay-style
// session "rk-relay-deadbeef" (prefix-matches the legacy name "rk") must not
// be misidentified as a running daemon.
func TestIsRunning_IgnoresPrefixCollision(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	// Plant a session whose name only collides under prefix matching.
	if err := startOn(testSocket, "rk-relay-deadbeef"); err != nil {
		t.Fatalf("startOn(relay) error: %v", err)
	}

	if IsRunning() {
		t.Error("IsRunning() = true; expected false — relay session must not " +
			"prefix-match the daemon session lookup")
	}
}

// TestStop_LegacySessionName verifies the upgrade path: a daemon started by
// an older binary under the legacy name "rk" can still be stopped by the new
// Stop() implementation.
func TestStop_LegacySessionName(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	// Simulate a legacy daemon running under the old session name.
	if err := startOn(testSocket, LegacySessionName); err != nil {
		t.Fatalf("startOn(legacy) error: %v", err)
	}
	if !IsRunning() {
		t.Fatal("IsRunning() = false; expected true for legacy-named daemon")
	}

	if err := Stop(); err != nil {
		t.Fatalf("Stop() error: %v", err)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); legacy session should be gone")
	}
}

// TestStop_TimeoutThenSessionVanished is the regression test for the rk-update
// restart bug: Stop() reported a non-nil error on a graceful shutdown that
// actually SUCCEEDED, aborting the upgrade restart before the new binary
// launched.
//
// The bug lived ONLY in the timeout/kill branch: when the inner serve's graceful
// shutdown outlasted Stop()'s budget, the grace timer fired, and by kill-time the
// session had finished exiting — so `kill-session` returned `can't find session`,
// which old code wrapped as a fatal error.
//
// Reaching that branch deterministically requires the session to be LIVE at the
// initial lookup, then GONE by the kill-branch re-probe — without a wall-clock
// race. We construct that ordering with a wide margin:
//   - poll interval set huge (1h) so the happy-path poll arm can never fire;
//     the grace timer is the only select arm that can win.
//   - the session self-exits at a FIXED 200ms (startSelfExitingOn), independent
//     of C-c delivery latency, so teardown completes in a tight, bounded window.
//   - the grace period is 2s — 10x the self-exit delay — so the session is
//     reliably gone (≈1.8s margin) before the grace timer fires and Stop()
//     re-probes. No event-ordering race remains even under CPU/tmux load.
//
// Why this is the real guard: the PRE-EXISTING TestStop_LegacySessionName uses
// `sleep 300` (ignores C-c) and always hits the kill path with a LIVE session,
// which old code handled fine. The very first version of THIS test used the full
// 12s grace, so the session vanished in the happy-path poll loop and the test
// passed against buggy code — proving nothing. Here the huge poll interval
// bypasses the happy path and forces the timeout/kill branch — the only code the
// fix touches. This test FAILS against pre-fix daemon.go (kill against the
// vanished session → `can't find session` error) and PASSES against the fix.
func TestStop_TimeoutThenSessionVanished(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	// Grace (2s) ≫ the session's fixed 200ms self-exit, and poll interval huge so
	// only the grace timer fires. Stop() therefore takes the timeout/kill branch
	// with the session already gone — the exact bug condition — with no race.
	withStopTiming(t, 2*time.Second, time.Hour)

	if err := startSelfExitingOn(testSocket, SessionName, "0.2"); err != nil {
		t.Fatalf("startSelfExitingOn() error: %v", err)
	}
	if !IsRunning() {
		t.Fatal("IsRunning() = false; expected true for the freshly started session")
	}

	// Stop() sends C-c and waits; the session self-exits at ~200ms, well before
	// the 2s grace timer. When the timer fires, the fix's re-probe under a fresh
	// context finds the session already gone and returns nil. Pre-fix code ran
	// kill-session against the vanished session and returned a `can't find
	// session` error — aborting the rk-update restart.
	err := Stop()
	if err != nil {
		t.Fatalf("Stop() = %v; a session that exits on its own during the wait must report success, not a kill error", err)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the self-exiting session should be gone")
	}
}

// TestStop_TimeoutStuckSessionIsKilled pins the OTHER side of the kill branch: a
// session that does NOT honor C-c and is STILL ALIVE when the grace timer fires
// must be force-killed (not silently reported as a successful stop). Uses
// startOn's `sleep 300` (ignores C-c) so the session is reliably alive at the
// timeout; Stop()'s re-probe finds it present, kill-session succeeds, and Stop()
// returns nil. A restart round-trip then confirms a fresh session comes back up.
// Guards against an over-broad "always return nil" regression of the fix.
//
// (The remaining sub-branch — kill-session itself failing while the session is
// still alive, which surfaces a wrapped error — is correct by inspection but not
// unit-tested: provoking a kill failure on a genuinely live session would
// require process/IPC injection beyond this integration test's reach.)
func TestStop_TimeoutStuckSessionIsKilled(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	withStopTiming(t, time.Nanosecond, time.Hour)

	// sleep 300 ignores C-c, so the session is still alive when the (instantly
	// expired) grace period sends Stop() into the kill branch.
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() error: %v", err)
	}
	if !IsRunning() {
		t.Fatal("IsRunning() = false; expected true for the freshly started session")
	}

	// Re-probe finds the session alive → kill-session runs and succeeds → nil.
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; killing a live stuck session should succeed", err)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the stuck session should have been killed")
	}

	// Restart round-trip: after a successful stop, a fresh session must come
	// back up — the end-to-end behavior `rk update` relies on.
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() after Stop() error: %v; restart round-trip must bring a fresh session back up", err)
	}
	if !IsRunning() {
		t.Error("IsRunning() = false after restart; a fresh session should be up")
	}
}

// TestStop_CopyModePaneStopsGracefully guards the copy-mode wedge: a daemon
// pane left in tmux copy-mode does not receive C-c as a literal key (the mode
// key table intercepts it), which historically made graceful shutdown silently
// fail. Signal-first delivery covers the state outright — SIGINT to the pane
// PID is mode-independent — and the fallback keeps its copy-mode pre-cancel
// for panes the signal path cannot reach.
//
// The fixture (startIntHonoringOn) HONORS SIGINT but otherwise stays alive
// forever, so the ONLY way the session vanishes is a real SIGINT delivery. We
// drive its pane into copy-mode, then call Stop() with a generous grace period
// (3s) and a tight poll interval (20ms). We assert both the session is gone AND
// Stop() returned far under the grace period, so the success came from graceful
// delivery, not the grace-expiry kill fallback (a copy-mode-wedged stop makes
// elapsed ≈ grace and trips the elapsed assertion).
func TestStop_CopyModePaneStopsGracefully(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	if err := startIntHonoringOn(testSocket, SessionName); err != nil {
		t.Fatalf("startIntHonoringOn() error: %v", err)
	}
	if !IsRunning() {
		t.Fatal("IsRunning() = false; expected true for the freshly started session")
	}

	// Reproduce the wedged state: pane in copy-mode.
	if err := enterCopyModeOn(testSocket, SessionName); err != nil {
		t.Fatalf("enterCopyModeOn() error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; a copy-mode pane must stop cleanly after the pre-cancel", err)
	}
	elapsed := time.Since(start)

	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the copy-mode pane's process should have received SIGINT and exited")
	}
	// Graceful delivery finishes in a few ms; the grace-expiry kill fallback
	// would only run at ~grace. A comfortably-under-grace bound proves the
	// pre-cancel made C-c effective rather than the kill fallback masking it.
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); expected graceful C-c delivery well under grace — "+
			"a near-grace stop means C-c was consumed by copy-mode and only the kill fallback stopped the session (the pre-fix bug)", elapsed, grace)
	}
}

// TestStop_SendFailureFallsThroughToKill is the regression test for the
// compounding bug: Stop() early-returned on a send-keys failure, so its
// grace-timer → kill-session fallback never ran and Stop() (plus restart, rk
// update, POST /api/restart) wedged whenever graceful delivery could not
// happen.
//
// The wrong-window-name proxy fails EVERY graceful rung deterministically: the
// session is started with its window named "other", so the target Stop()
// computes (`=<session>:=serve`) resolves for none of the PID lookup, the
// copy-mode pre-cancel, or the C-c send ("can't find window: serve") — while
// has-session and kill-session against `=<session>` still succeed. All rungs
// must be non-fatal so Stop() falls through to the kill branch.
// (The read-only "client is read-only" rejection itself is reproduced by
// TestStop_ReadOnlyControlClientStopsGracefully.)
//
// withStopTiming's nanosecond grace forces the kill branch immediately (like
// TestStop_TimeoutStuckSessionIsKilled). Pre-fix code returned the wrapped
// "sending C-c to daemon" error before ever reaching the grace loop; the fix
// logs and falls through, the kill removes the session, and Stop() returns nil.
func TestStop_SendFailureFallsThroughToKill(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	withStopTiming(t, time.Nanosecond, time.Hour)

	// Window "other" (not "serve") → send-keys/copy-mode to =<session>:=serve
	// fail; sleep 300 ignores C-c so the session is reliably alive at kill-time.
	if err := startOnWithWindow(testSocket, SessionName, "other"); err != nil {
		t.Fatalf("startOnWithWindow() error: %v", err)
	}
	if !IsRunning() {
		t.Fatal("IsRunning() = false; expected true for the freshly started session")
	}

	// The C-c send fails (wrong window), but the fix must NOT surface that error:
	// it logs and falls through to the kill fallback, which removes the session.
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; a send-keys failure must degrade to the kill fallback, not abort Stop()", err)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the kill fallback should have removed the session")
	}
}

// withInnerServePIDFor stubs the session-parameterized PID-lookup seam Stop()
// uses for signal-first delivery, restoring it on cleanup.
func withInnerServePIDFor(t *testing.T, fn func(session string) (int, error)) {
	t.Helper()
	orig := innerServePIDForFn
	innerServePIDForFn = fn
	t.Cleanup(func() { innerServePIDForFn = orig })
}

// withSignalPID stubs the signal-delivery seam and restores it on cleanup.
func withSignalPID(t *testing.T, fn func(pid int, sig syscall.Signal) error) {
	t.Helper()
	orig := signalPID
	signalPID = fn
	t.Cleanup(func() { signalPID = orig })
}

// attachReadOnlyControlClient attaches a read-only control-mode client
// (`tmux -CC attach-session -r`) to the session through a PTY — the exact
// client shape run-kit's own tmuxctl bridge holds against the production
// daemon socket (internal/tmuxctl productionDial). Blocks until tmux reports
// an attached read-only client so the wedge state is established before the
// test proceeds. Client, PTY, and drain goroutine are torn down on cleanup.
func attachReadOnlyControlClient(t *testing.T, socket, session string) {
	t.Helper()
	cmd := exec.Command("tmux", "-L", socket, "-CC", "attach-session", "-t", "="+session, "-r")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("pty.Start(-CC attach -r) error: %v", err)
	}
	// Drain the control client's output so it never blocks on a full PTY
	// buffer; the copy ends when the PTY is closed in cleanup.
	go func() { _, _ = io.Copy(io.Discard, ptmx) }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		_ = cmd.Wait()
	})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("tmux", "-L", socket, "list-clients",
			"-t", "="+session, "-F", "#{client_readonly}").Output()
		if err == nil && strings.Contains(string(out), "1") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("read-only -CC client did not attach within 5s")
}

// TestStop_ReadOnlyControlClientStopsGracefully is the regression test for the
// production wedge this package's signal-first delivery exists to fix: with the
// session's only attached client being a read-only `-CC` control client (the
// tmuxctl bridge's shape), tmux rejects `send-keys … C-c` with "client is
// read-only" — on tmux ≥3.7 outright, whether or not the pane is in a mode —
// so key-based graceful delivery can never reach the serve process and every
// stop used to burn the full grace period before the kill fallback. The pane
// is additionally driven into copy-mode to compound the state with the
// previously-shipped wedge.
//
// The fixture honors SIGINT but never self-exits, so the session vanishing
// quickly proves a real signal delivery. Pre-fix code (C-c-first) fails the
// elapsed assertion: the rejected send leaves the process running until the
// grace-expiry kill, making elapsed ≈ grace.
func TestStop_ReadOnlyControlClientStopsGracefully(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	if err := startIntHonoringOn(testSocket, SessionName); err != nil {
		t.Fatalf("startIntHonoringOn() error: %v", err)
	}
	attachReadOnlyControlClient(t, testSocket, SessionName)
	if err := enterCopyModeOn(testSocket, SessionName); err != nil {
		t.Fatalf("enterCopyModeOn() error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; a read-only -CC client must not break graceful shutdown", err)
	}
	elapsed := time.Since(start)

	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the process should have received SIGINT and exited")
	}
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); expected signal-first delivery well under grace — "+
			"a near-grace stop means graceful delivery failed and only the kill fallback stopped the session", elapsed, grace)
	}
}

// TestStop_SignalFirstStopsQuickly proves the happy path: Stop() resolves the
// pane PID and delivers SIGINT through the signal seam, and the session is
// gone well before the grace deadline. The recording stub delegates to the
// real syscall.Kill so delivery (not just the call) is verified.
func TestStop_SignalFirstStopsQuickly(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	calls := 0
	gotPID := 0
	var gotSig syscall.Signal
	withSignalPID(t, func(pid int, sig syscall.Signal) error {
		calls++
		gotPID, gotSig = pid, sig
		return syscall.Kill(pid, sig)
	})

	if err := startIntHonoringOn(testSocket, SessionName); err != nil {
		t.Fatalf("startIntHonoringOn() error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v", err)
	}
	elapsed := time.Since(start)

	if calls != 1 {
		t.Errorf("signalPID called %d times, want 1", calls)
	}
	if gotPID <= 0 {
		t.Errorf("signalPID pid = %d, want a real pane PID", gotPID)
	}
	if gotSig != syscall.SIGINT {
		t.Errorf("signalPID sig = %v, want SIGINT", gotSig)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop()")
	}
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); signal-first delivery should finish well under grace", elapsed, grace)
	}
}

// TestStop_PIDFailureFallsBackToKeys pins the first rung of the fallback
// ladder: when the pane PID cannot be resolved, Stop() falls back to tmux key
// delivery, which still stops a SIGINT-honoring process quickly (no attached
// read-only client in this environment, so send-keys works).
func TestStop_PIDFailureFallsBackToKeys(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	withInnerServePIDFor(t, func(string) (int, error) {
		return 0, errors.New("stub: pane pid unavailable")
	})

	if err := startIntHonoringOn(testSocket, SessionName); err != nil {
		t.Fatalf("startIntHonoringOn() error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; a PID-lookup failure must degrade to key delivery, not abort", err)
	}
	elapsed := time.Since(start)

	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the C-c fallback should have stopped the session")
	}
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); the key fallback should deliver well under grace here", elapsed, grace)
	}
}

// TestStop_SignalFailureFallsBackToKeys pins the second rung: PID resolution
// succeeds but the kill syscall fails, and Stop() degrades to key delivery.
func TestStop_SignalFailureFallsBackToKeys(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	withSignalPID(t, func(pid int, sig syscall.Signal) error {
		return errors.New("stub: kill refused")
	})

	if err := startIntHonoringOn(testSocket, SessionName); err != nil {
		t.Fatalf("startIntHonoringOn() error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v; a signal failure must degrade to key delivery, not abort", err)
	}
	elapsed := time.Since(start)

	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the C-c fallback should have stopped the session")
	}
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); the key fallback should deliver well under grace here", elapsed, grace)
	}
}

// TestStop_LegacySessionSignalDelivery proves the signal path targets the
// RESOLVED session: a legacy-named (`rk`) daemon's pane PID is looked up via
// targetFor(session), not the current-name target.
func TestStop_LegacySessionSignalDelivery(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	grace := 3 * time.Second
	withStopTiming(t, grace, 20*time.Millisecond)

	calls := 0
	withSignalPID(t, func(pid int, sig syscall.Signal) error {
		calls++
		return syscall.Kill(pid, sig)
	})

	if err := startIntHonoringOn(testSocket, LegacySessionName); err != nil {
		t.Fatalf("startIntHonoringOn(legacy) error: %v", err)
	}

	start := time.Now()
	if err := Stop(); err != nil {
		t.Fatalf("Stop() = %v", err)
	}
	elapsed := time.Since(start)

	if calls != 1 {
		t.Errorf("signalPID called %d times, want 1 (legacy session PID must resolve)", calls)
	}
	if IsRunning() {
		t.Error("IsRunning() = true after Stop(); the legacy session should be gone")
	}
	if elapsed >= grace/2 {
		t.Errorf("Stop() took %v (grace=%v); legacy-session signal delivery should finish well under grace", elapsed, grace)
	}
}

// TestProbeHost verifies loopback substitution for wildcard/empty/IPv6
// unspecified hosts. A serve bound to those wildcards is reachable on
// loopback, and dialing the wildcard itself is platform-inconsistent — so
// the port-probe must rewrite to 127.0.0.1.
func TestProbeHost(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", "127.0.0.1"},
		{"0.0.0.0", "127.0.0.1"},
		{"::", "127.0.0.1"},
		{"127.0.0.1", "127.0.0.1"},
		{"10.0.0.1", "10.0.0.1"},
		{"example.com", "example.com"},
	}
	for _, tc := range tests {
		t.Run(fmt.Sprintf("host=%q", tc.in), func(t *testing.T) {
			if got := probeHost(tc.in); got != tc.want {
				t.Errorf("probeHost(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// freeTCPPort grabs an ephemeral port, closes the listener, and returns the
// port number. The window between Close and the next bind is racy in theory,
// but in practice the kernel does not immediately re-issue the port — good
// enough for a unit test asserting "port is free."
func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatalf("listener Close: %v", err)
	}
	return port
}

// TestPortInUse_Free asserts the probe returns false when nothing is bound.
func TestPortInUse_Free(t *testing.T) {
	port := freeTCPPort(t)
	if portInUse("127.0.0.1", port) {
		t.Errorf("portInUse(127.0.0.1, %d) = true, want false (port should be free)", port)
	}
}

// TestPortInUse_Held asserts the probe returns true when a listener is
// accepting connections on the target.
func TestPortInUse_Held(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	if !portInUse("127.0.0.1", port) {
		t.Errorf("portInUse(127.0.0.1, %d) = false, want true (listener is bound)", port)
	}
}

// TestPortInUse_LoopbackSubstitution verifies that probing host "0.0.0.0"
// dials loopback — exercising the wildcard-substitution path against a real
// listener bound to 127.0.0.1.
func TestPortInUse_LoopbackSubstitution(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	if !portInUse("0.0.0.0", port) {
		t.Errorf("portInUse(0.0.0.0, %d) = false; expected loopback substitution to detect 127.0.0.1 listener", port)
	}
}

// TestStart_RefusesWhenPortInUse verifies the port-probe guard in Start():
// when something is already listening on the configured port (foreground-serve
// scenario), Start() must refuse with an error containing the spec-mandated
// substrings, and must NOT create a tmux session on the daemon socket.
func TestStart_RefusesWhenPortInUse(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if IsRunning() {
		t.Skip("skipping — production daemon is running")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	t.Setenv("RK_HOST", "127.0.0.1")
	t.Setenv("RK_PORT", fmt.Sprintf("%d", port))

	err = Start()
	if err == nil {
		t.Fatal("Start() returned nil; expected port-in-use refusal")
	}
	msg := err.Error()
	for _, want := range []string{"already serving on", "not under the rk-daemon", "RK_PORT"} {
		if !strings.Contains(msg, want) {
			t.Errorf("Start() error = %q; want it to contain %q", msg, want)
		}
	}
	if isRunningOn(testSocket) {
		t.Error("Start() created a daemon session despite port-in-use refusal")
	}
}

// TestReapStaleDaemonSocket_NoOp asserts that reaping when no server is
// running on the daemon socket does not panic, block, or otherwise misbehave.
// Each per-session `kill-session` returns "no server running on …" which the
// reap suppresses to slog.Debug — the caller observes no signal at all.
func TestReapStaleDaemonSocket_NoOp(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()

	// Sanity: no server should be running on the test socket.
	if isRunningOn(testSocket) {
		t.Fatal("test socket unexpectedly has a running session")
	}

	// Should not panic or block.
	reapStaleDaemonSocket(ctx)
}

// TestReapStaleDaemonSocket_SparesSiblings asserts the reap is session-scoped:
// sibling sessions on the daemon socket (rk-jobs, rk-code-server, rk-remotes —
// plus anything a prefix-match could hijack, e.g. rk-daemon-x) survive, while
// stale current-name and legacy-name daemon sessions are killed. The historical
// `kill-server` here destroyed the siblings on every restart — the rk-jobs
// update window SIGHUPed itself mid-run and code-server never came back after
// auto-updates.
func TestReapStaleDaemonSocket_SparesSiblings(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	siblings := []string{"rk-jobs", "rk-code-server", "rk-daemon-x"}
	stale := []string{SessionName, LegacySessionName}
	for _, session := range append(append([]string{}, siblings...), stale...) {
		if err := startOn(testSocket, session); err != nil {
			t.Fatalf("startOn(%q): %v", session, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	reapStaleDaemonSocket(ctx)

	for _, session := range siblings {
		if !hasSessionOn(testSocket, session) {
			t.Errorf("sibling session %q was killed by the reap; want it spared", session)
		}
	}
	for _, session := range stale {
		if hasSessionOn(testSocket, session) {
			t.Errorf("stale daemon session %q survived the reap; want it killed", session)
		}
	}
}

// TestInnerServePID_NoSession verifies that the helper errors out cleanly when
// no daemon session exists.
func TestInnerServePID_NoSession(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	pid, err := InnerServePID()
	if err == nil {
		t.Errorf("InnerServePID() = (%d, nil); expected error when no daemon session exists", pid)
	}
	if pid != 0 {
		t.Errorf("InnerServePID() pid = %d; expected 0 on error", pid)
	}
}

// TestInnerServePID_Running verifies the helper returns a positive PID for a
// live daemon session on the test socket.
func TestInnerServePID_Running(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() error: %v", err)
	}

	pid, err := InnerServePID()
	if err != nil {
		t.Fatalf("InnerServePID() error: %v", err)
	}
	if pid <= 0 {
		t.Errorf("InnerServePID() = %d; expected positive PID", pid)
	}
}

func TestRestart_WhenRunning(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)

	// Start first.
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() error: %v", err)
	}

	// Stop and re-start (simulates restart).
	stopOn(testSocket, SessionName)
	if err := startOn(testSocket, SessionName); err != nil {
		t.Fatalf("startOn() after stop error: %v", err)
	}
	if !isRunningOn(testSocket) {
		t.Error("isRunningOn() = false after restart")
	}
}

// sessionPathOn reads #{session_path} for an exact-match session on the
// daemon socket (which withServerSocket points at the test socket).
func sessionPathOn(t *testing.T, session string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	out, err := runTmuxOutput(ctx, "display-message", "-t", "="+session+":", "-p", "#{session_path}")
	if err != nil {
		t.Fatalf("read session_path of %q: %v", session, err)
	}
	return strings.TrimSpace(string(out))
}

// resolveSymlinks normalizes a path for comparison with tmux-reported paths
// (tmux records the client's physical getcwd; $HOME / TempDir may be symlinked).
func resolveSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", path, err)
	}
	return resolved
}

// TestRunTmuxInDir_SetsClientCwd proves the dir-carrying runTmux variant
// (change 260720-ji0k) actually runs the tmux client from the given directory:
// a new-session created through it (no -c) records that directory as its
// session_path.
func TestRunTmuxInDir_SetsClientCwd(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)

	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if err := runTmuxInDir(ctx, dir, "new-session", "-d", "-s", "cwdtest", "sleep", "300"); err != nil {
		t.Fatalf("runTmuxInDir new-session: %v", err)
	}

	got := resolveSymlinks(t, sessionPathOn(t, "cwdtest"))
	want := resolveSymlinks(t, dir)
	if got != want {
		t.Errorf("session_path = %q, want %q (runTmuxInDir must run the client from dir)", got, want)
	}
}

// TestStartSession_BirthCwdIsHome proves the daemon server-birth pin (change
// 260720-ji0k): startSession births the rk-daemon tmux server with the client
// CWD anchored to tmux.ServerBirthDir(), so the daemon session's start dir is
// the operator's home — NOT wherever the rk process happens to run (this test
// binary runs from the package dir, so a missing pin fails the assertion).
func TestStartSession_BirthCwdIsHome(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	useTestSocket(t)
	withServerSocket(t, testSocket)
	withGUISetting(t, false) // fresh settings root: gui.enabled is off
	rec := withGUISeams(t, false)

	// A fake serve binary that just stays alive: startSession runs `<exe> serve`,
	// and the session (and with it the birthed server) must survive long enough
	// to be inspected.
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "fake-serve", "#!/bin/sh\nsleep 300\n")
	script := filepath.Join(dir, "fake-serve")

	if err := startSession(script); err != nil {
		t.Fatalf("startSession: %v", err)
	}

	got := resolveSymlinks(t, sessionPathOn(t, SessionName))
	want := resolveSymlinks(t, tmux.ServerBirthDir())
	if got != want {
		t.Errorf("daemon session_path = %q, want %q (server birth must be anchored to home)", got, want)
	}

	// The gui boot hook is gated on gui.enabled: with a fresh (disabled)
	// settings root, startSession must issue zero gui spawn calls (R2's
	// never-on-by-default invariant).
	if len(rec.spawnArgs) != 0 {
		t.Errorf("gui spawn calls = %d, want 0 with gui.enabled off: %v", len(rec.spawnArgs), rec.spawnArgs)
	}
	if rec.existsProbes != 0 {
		t.Errorf("gui session-exists probes = %d, want 0 — the disabled gate fires before any tmux probe", rec.existsProbes)
	}
}

// TestKillServer_DeadSocketIsSuccess proves KillServer's idempotence: a socket
// with no live server (never started, or already killed) is success, because
// the caller's next step is birthing a fresh server anyway. The pre-kill
// sibling probe against the dead socket reports no rk-code-server session, so
// no port wait runs.
func TestKillServer_DeadSocketIsSuccess(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}
	socket := testSocketName("killsrv-dead")
	withServerSocket(t, socket)
	probes := stubCodeServerPortBusy(t, func(int) bool { return true })

	if err := KillServer(); err != nil {
		t.Errorf("KillServer on dead socket = %v, want nil", err)
	}
	if *probes != 0 {
		t.Errorf("port probes = %d, want 0 — a dead server has no dying sibling to wait for", *probes)
	}
}

// TestKillServer_KillsLiveServerAndSiblings proves KillServer takes down the
// whole server — every session on the socket, not just the daemon session —
// which is exactly the sibling-killing behavior the session-scoped reap avoids
// and the --full restart opts into.
func TestKillServer_KillsLiveServerAndSiblings(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}
	socket := testSocketName("killsrv-live")
	withServerSocket(t, socket)
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })

	for _, session := range []string{SessionName, "rk-jobs-sibling"} {
		if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", session, "sleep", "300").Run(); err != nil {
			t.Fatalf("creating session %s: %v", session, err)
		}
	}

	if err := KillServer(); err != nil {
		t.Fatalf("KillServer: %v", err)
	}
	if err := exec.Command("tmux", "-L", socket, "has-session", "-t", "="+SessionName).Run(); err == nil {
		t.Error("daemon session still present after KillServer")
	}
	if err := exec.Command("tmux", "-L", socket, "has-session", "-t", "=rk-jobs-sibling").Run(); err == nil {
		t.Error("sibling session still present after KillServer (whole server should be gone)")
	}
	// Idempotent re-run against the now-dead server.
	if err := KillServer(); err != nil {
		t.Errorf("KillServer re-run after kill = %v, want nil", err)
	}
}

// TestKillServer_WaitsForCodeServerPortWhenSiblingExisted pins the
// release-synchronous half of the --full contract: when an rk-code-server
// sibling existed pre-kill, KillServer returns only after the code-server port
// stops accepting connections — a Start() composed right after can no longer
// misclassify the dying instance as externally managed (the --full bug).
func TestKillServer_WaitsForCodeServerPortWhenSiblingExisted(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}
	socket := testSocketName("killsrv-wait")
	withServerSocket(t, socket)
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", SessionName, "sleep", "300").Run(); err != nil {
		t.Fatalf("creating session: %v", err)
	}

	_, _, _ = withCodeServerSeams(t, true) // the sibling existed pre-kill
	probes := stubCodeServerPortBusy(t, func(p int) bool { return p <= 2 })

	if err := KillServer(); err != nil {
		t.Fatalf("KillServer: %v", err)
	}
	if *probes != 3 {
		t.Errorf("port probes = %d, want 3 (busy, busy, free) — the kill must wait out the dying sibling", *probes)
	}
}

// TestKillServer_NoWaitWhenSiblingNeverExisted pins the conditionality: with
// no rk-code-server session pre-kill, a busy code-server port belongs to a
// genuinely externally managed instance that will not release it — probing it
// would burn the full wait budget on every --full restart for those users.
func TestKillServer_NoWaitWhenSiblingNeverExisted(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not available")
	}
	socket := testSocketName("killsrv-nowait")
	withServerSocket(t, socket)
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", SessionName, "sleep", "300").Run(); err != nil {
		t.Fatalf("creating session: %v", err)
	}

	_, _, _ = withCodeServerSeams(t, false) // no sibling — externally managed port stays untouched
	probes := stubCodeServerPortBusy(t, func(int) bool { return true })

	if err := KillServer(); err != nil {
		t.Fatalf("KillServer: %v", err)
	}
	if *probes != 0 {
		t.Errorf("port probes = %d, want 0 — no sibling died, so no release to wait for", *probes)
	}
}

// --- born-with-environment probe (the resolved-port -e pass) ----------------

// envProbeStub writes a stub "serve" script that records its RK_PORT,
// RK_HOST, and RK_CODE_SERVER_PORT into files in a temp dir and then stays
// alive, returning (scriptPath, outputDir). An unset variable records as an
// empty file.
func envProbeStub(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "fake-serve", "#!/bin/sh\n"+
		"printf '%s' \"$RK_PORT\" > "+filepath.Join(dir, "port")+"\n"+
		"printf '%s' \"$RK_HOST\" > "+filepath.Join(dir, "host")+"\n"+
		"printf '%s' \"$RK_CODE_SERVER_PORT\" > "+filepath.Join(dir, "codeserver")+"\n"+
		"sleep 300\n")
	return filepath.Join(dir, "fake-serve"), dir
}

// probeValue waits for the env probe's output file for name to appear and
// returns its content (empty = the variable was unset in the pane).
func probeValue(t *testing.T, dir, name string) string {
	t.Helper()
	content := ""
	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return false
		}
		content = string(data)
		return true
	}, "timed out waiting for the probe's %s file", name)
	return content
}

// globalEnvOn reads one key from the given socket's global environment. tmux
// reports an unset key as a `-KEY` line or a non-zero "unknown variable" exit
// — both map to set=false.
func globalEnvOn(t *testing.T, socket, key string) (string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", socket, "show-environment", "-g", key).Output()
	if err != nil {
		return "", false
	}
	line := strings.TrimSpace(string(out))
	if strings.HasPrefix(line, "-") {
		return "", false
	}
	k, v, ok := strings.Cut(line, "=")
	if !ok || k != key {
		t.Fatalf("show-environment -g %s = %q, want KEY=VALUE", key, line)
	}
	return v, true
}

// birthPlaceholderWithEnv births the test server (via a placeholder session)
// so its global environment carries the caller's current RK_PORT.
func birthPlaceholderWithEnv(t *testing.T, socket string) {
	t.Helper()
	if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", "placeholder", "sleep", "300").Run(); err != nil {
		t.Fatalf("birthing placeholder session: %v", err)
	}
}

// TestNewSession_BornWithEnvHazard is the empirical probe for the
// born-with-environment hazard: a tmux server builds a new session's
// environment from the GLOBAL environment it was born with, ignoring client
// env outside update-environment. The server is birthed with RK_PORT=A; a
// later new-session from a caller whose env has RK_PORT=B — WITHOUT an
// explicit -e — is expected to yield A in the pane. If this tmux does not
// behave that way the observed value is logged instead of failing (the -e
// pass stays as defense in depth).
func TestNewSession_BornWithEnvHazard(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	socket := testSocketName("bornwith")
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })

	t.Setenv(config.PortEnvVar, "3990")
	birthPlaceholderWithEnv(t, socket)

	t.Setenv(config.PortEnvVar, "3991")
	script, dir := envProbeStub(t)
	if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", "probe", script).Run(); err != nil {
		t.Fatalf("creating probe session: %v", err)
	}

	switch got := probeValue(t, dir, "port"); got {
	case "3990":
		// Hazard confirmed: the pane saw the server's born-with value.
	case "3991":
		t.Logf("born-with-env hazard did not reproduce on this tmux: the new session saw the caller's RK_PORT")
	default:
		t.Errorf("pane RK_PORT = %q, want the born-with 3990 (hazard) or the caller 3991 (not reproduced)", got)
	}
}

// TestStartSession_ResolvedPortReachesPane proves the fix: against a server
// born with RK_PORT=A, startSession from a caller whose env has RK_PORT=B
// passes the resolved value via -e, so the spawned serve sees B — and the
// caller's raw env is mirrored into the server's global environment, so later
// rk-jobs windows re-resolve the same value. The same -e pass covers RK_HOST
// (always) and RK_CODE_SERVER_PORT (an explicit override).
func TestStartSession_ResolvedPortReachesPane(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	socket := testSocketName("fixenv")
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	withServerSocket(t, socket)
	withGUISetting(t, false)
	withGUISeams(t, false)
	withCodeServerSeams(t, true) // session-exists skip: no port or binary probes

	// Birth the server with a stale born-with deployment env.
	t.Setenv(config.PortEnvVar, "3990")
	t.Setenv(config.HostEnvVar, "192.0.2.1")
	birthPlaceholderWithEnv(t, socket)

	// The caller resolves a different deployment binding.
	t.Setenv(config.PortEnvVar, "3991")
	t.Setenv(config.HostEnvVar, "10.9.9.9")
	t.Setenv(config.CodeServerPortEnvVar, "4999")
	script, dir := envProbeStub(t)
	if err := startSession(script); err != nil {
		t.Fatalf("startSession: %v", err)
	}
	for name, want := range map[string]string{"port": "3991", "host": "10.9.9.9", "codeserver": "4999"} {
		if got := probeValue(t, dir, name); got != want {
			t.Errorf("pane %s = %q, want %q (the caller-resolved value via -e)", name, got, want)
		}
	}
	// The caller's raw env is mirrored into the server's global env.
	for key, want := range map[string]string{config.PortEnvVar: "3991", config.HostEnvVar: "10.9.9.9", config.CodeServerPortEnvVar: "4999"} {
		if val, set := globalEnvOn(t, socket, key); !set || val != want {
			t.Errorf("global %s = (%q, set=%v), want (%s, true) — the caller's raw env must be mirrored", key, val, set, want)
		}
	}
}

// TestStartSession_ConfigOnlyPort proves the config.yaml rung end to end: a
// caller with no RK_PORT whose config.yaml pins port: C spawns a serve that
// sees C (via -e, against a server born with RK_PORT=A), and the sync REMOVES
// the stale born-with RK_PORT from the server's global env, so job windows
// re-resolve from config like the caller did. The same pass covers the other
// two keys: RK_HOST still goes via -e (the default, since the caller has no
// override), while RK_CODE_SERVER_PORT gets no -e (no override) and is
// rescued from the born-with value by the sync's -gu arm alone.
func TestStartSession_ConfigOnlyPort(t *testing.T) {
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	socket := testSocketName("cfgport")
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	withServerSocket(t, socket)

	cfgDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte("port: 4000\n"), 0o644); err != nil {
		t.Fatalf("writing config.yaml: %v", err)
	}
	t.Setenv(settings.ConfigDirEnv, cfgDir)
	withGUISeams(t, false)
	withCodeServerSeams(t, true)

	// Birth the server with a stale born-with value on all three keys.
	t.Setenv(config.PortEnvVar, "3990")
	t.Setenv(config.HostEnvVar, "192.0.2.1")
	t.Setenv(config.CodeServerPortEnvVar, "4990")
	birthPlaceholderWithEnv(t, socket)

	// Set-but-empty reads as unset at every consumer: config.Load ignores it,
	// and the sync takes the -gu branch.
	t.Setenv(config.PortEnvVar, "")
	t.Setenv(config.HostEnvVar, "")
	t.Setenv(config.CodeServerPortEnvVar, "")

	script, dir := envProbeStub(t)
	if err := startSession(script); err != nil {
		t.Fatalf("startSession: %v", err)
	}
	if got := probeValue(t, dir, "port"); got != "4000" {
		t.Errorf("pane RK_PORT = %q, want 4000 (config.yaml via -e)", got)
	}
	if got := probeValue(t, dir, "host"); got != localhostAddr {
		t.Errorf("pane RK_HOST = %q, want %q (the default — RK_HOST passes via -e even without an override)", got, localhostAddr)
	}
	if got := probeValue(t, dir, "codeserver"); got != "" {
		t.Errorf("pane RK_CODE_SERVER_PORT = %q, want unset (no override → no -e; the +2 convention stays a convention, and the sync's -gu removed the born-with 4990)", got)
	}
	for _, key := range []string{config.PortEnvVar, config.HostEnvVar, config.CodeServerPortEnvVar} {
		if val, set := globalEnvOn(t, socket, key); set {
			t.Errorf("global %s = %q after a config-only start, want unset (the stale born-with value must go)", key, val)
		}
	}
}

// TestGuardPortAvailable_MessageNamesBothHomes pins the refusal text: the
// substrings scripts pattern-match on, plus the config.yaml `port:` home.
func TestGuardPortAvailable_MessageNamesBothHomes(t *testing.T) {
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	t.Setenv(config.PortEnvVar, strconv.Itoa(ln.Addr().(*net.TCPAddr).Port))

	err = guardPortAvailable()
	if err == nil {
		t.Fatal("guardPortAvailable on a held port = nil, want the refusal error")
	}
	for _, sub := range []string{"already serving on", "not under the rk-daemon", "RK_PORT", "port:"} {
		if !strings.Contains(err.Error(), sub) {
			t.Errorf("refusal %q missing substring %q", err, sub)
		}
	}
}
