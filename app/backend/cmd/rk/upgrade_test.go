package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/codeserver"
	"rk/internal/desktop"
	"rk/internal/testutil"
)

// withResolveExe swaps resolveExeFn to return the given path/err for the test's
// duration. Tests use this to satisfy the Cellar-keg Homebrew-install guard
// without depending on the test binary's real location.
func withResolveExe(t *testing.T, path string, err error) {
	t.Helper()
	orig := resolveExeFn
	resolveExeFn = func() (string, error) { return path, err }
	t.Cleanup(func() { resolveExeFn = orig })
}

// withNoCodeServerLeg pins the umbrella's code-server leg off (home pointed at
// an empty temp dir ⇒ no ~/.rk/code-server-bin ⇒ silent skip) for tests that
// exercise the other legs in isolation — without it, a test run on a machine
// WITH a managed code-server install would let the leg hit the real GitHub
// API. Mirrors withNoDesktopLeg.
func withNoCodeServerLeg(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	orig := codeServerUserHomeFn
	codeServerUserHomeFn = func() (string, error) { return home, nil }
	t.Cleanup(func() { codeServerUserHomeFn = orig })
}

// withBrewRecorder swaps runBrewFn for a recording stub. Each invocation appends
// its subcommand (args[0]) to *rec. For "info" it returns the supplied JSON; all
// other subcommands return (nil, nil). No real `brew` is spawned.
func withBrewRecorder(t *testing.T, rec *[]string, infoJSON string) {
	t.Helper()
	orig := runBrewFn
	runBrewFn = func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) > 0 {
			*rec = append(*rec, args[0])
			if args[0] == "info" {
				return []byte(infoJSON), nil
			}
		}
		return nil, nil
	}
	t.Cleanup(func() { runBrewFn = orig })
}

// withRestartRecorder swaps restartDaemonFn for a recording stub returning nil.
// It records the call count and the bin path of the last call.
func withRestartRecorder(t *testing.T, calls *int, lastPath *string) {
	t.Helper()
	orig := restartDaemonFn
	restartDaemonFn = func(binPath string) error {
		*calls++
		*lastPath = binPath
		return nil
	}
	t.Cleanup(func() { restartDaemonFn = orig })
}

// resetSkipFlag forces skipBrewUpdate back to false after the test. Cobra does
// not reset package-global flag vars between Execute() calls, so tests that set
// it must restore it.
func resetSkipFlag(t *testing.T) {
	t.Helper()
	orig := skipBrewUpdate
	t.Cleanup(func() { skipBrewUpdate = orig })
}

// brewInfoJSON builds a canned `brew info --json=v2` payload with the given
// stable version, exercising the real parseBrewVersion.
func brewInfoJSON(stable string) string {
	return fmt.Sprintf(`{"formulae":[{"versions":{"stable":%q}}]}`, stable)
}

// withNoDesktopLeg pins the umbrella's desktop leg off (unsupported platform)
// for tests that exercise the CLI leg in isolation — without it, a test run
// on a real Mac or Linux box would let the desktop leg probe the machine's
// actual install root.
func withNoDesktopLeg(t *testing.T) {
	t.Helper()
	orig := desktopGOOS
	desktopGOOS = "windows"
	t.Cleanup(func() { desktopGOOS = orig })
}

// withUmbrellaDesktopStub forces the desktop leg on (darwin) and swaps the
// installer factory for one wired to the given httptest release server,
// runner, and install dir. Unlike withDesktopStub (whose tests pass --path),
// the umbrella has no path flag, so the temp install dir must come from the
// factory itself — which also pins that the leg honors the factory default
// rather than overriding InstallDir.
func withUmbrellaDesktopStub(t *testing.T, srv *httptest.Server, run desktop.Runner, installDir string) {
	t.Helper()
	origGOOS := desktopGOOS
	desktopGOOS = "darwin"
	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		ins := desktop.New()
		ins.Client = srv.Client()
		ins.APIBase = srv.URL
		ins.Arch = "arm64"
		ins.Token = ""
		ins.Run = run
		ins.InstallDir = installDir
		return ins
	}
	t.Cleanup(func() {
		desktopGOOS = origGOOS
		newDesktopInstallerFn = origFactory
	})
}

func containsStr(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func TestUpdate_SkipBrewUpdateFlag_Registered(t *testing.T) {
	f := updateCmd.Flags().Lookup("skip-brew-update")
	if f == nil {
		t.Fatal("updateCmd has no --skip-brew-update flag")
	}
	if f.Value.Type() != "bool" {
		t.Errorf("--skip-brew-update type = %q, want bool", f.Value.Type())
	}
	if f.DefValue != "false" {
		t.Errorf("--skip-brew-update default = %q, want false", f.DefValue)
	}
}

func TestUpdate_SkipBrewUpdate_OmitsUpdateButUpgradesAndRestarts(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/hexokit/9.9.9/bin/hexokit", nil)

	var rec []string
	// stable 9.9.9 differs from compiled-in version ("dev"), so the up-to-date
	// short-circuit is skipped and brew upgrade is reached.
	withBrewRecorder(t, &rec, brewInfoJSON("9.9.9"))

	var restartCalls int
	var restartPath string
	withRestartRecorder(t, &restartCalls, &restartPath)

	skipBrewUpdate = true
	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}

	if containsStr(rec, "update") {
		t.Errorf("brew update was invoked with --skip-brew-update set; recorded subcommands: %v", rec)
	}
	if !containsStr(rec, "info") {
		t.Errorf("brew info was not invoked; recorded subcommands: %v", rec)
	}
	if !containsStr(rec, "upgrade") {
		t.Errorf("brew upgrade was not invoked; recorded subcommands: %v", rec)
	}
	if restartCalls != 1 {
		t.Errorf("restartDaemonFn called %d times, want 1", restartCalls)
	}
	if restartPath != "/opt/homebrew/bin/hexokit" {
		t.Errorf("restart bin path = %q, want /opt/homebrew/bin/hexokit", restartPath)
	}
}

// TestUpdate_BrewCallsTargetHexokitFormula pins the formula the CLI leg queries
// and upgrades, for both the hexokit keg and a legacy run-kit keg: brew calls
// always name the hexokit formula, and the restart path follows the keg the
// binary actually lives in.
func TestUpdate_BrewCallsTargetHexokitFormula(t *testing.T) {
	cases := []struct{ name, exe, wantRestart string }{
		{"hexokit keg", "/home/linuxbrew/.linuxbrew/Cellar/hexokit/9.9.9/bin/hexokit", "/home/linuxbrew/.linuxbrew/bin/hexokit"},
		{"legacy run-kit keg", "/opt/homebrew/Cellar/run-kit/9.9.9/bin/run-kit", "/opt/homebrew/bin/run-kit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetSkipFlag(t)
			withNoCodeServerLeg(t)
			withNoDesktopLeg(t)
			withResolveExe(t, tc.exe, nil)

			var calls [][]string
			orig := runBrewFn
			runBrewFn = func(ctx context.Context, args ...string) ([]byte, error) {
				calls = append(calls, args)
				if len(args) > 0 && args[0] == "info" {
					return []byte(brewInfoJSON("9.9.9")), nil
				}
				return nil, nil
			}
			t.Cleanup(func() { runBrewFn = orig })

			var restartCalls int
			var restartPath string
			withRestartRecorder(t, &restartCalls, &restartPath)

			skipBrewUpdate = true
			if err := updateCmd.RunE(updateCmd, nil); err != nil {
				t.Fatalf("updateCmd.RunE returned error: %v", err)
			}

			want := [][]string{
				{"info", "--json=v2", "sahil87/tap/hexokit"},
				{"upgrade", "sahil87/tap/hexokit"},
			}
			if fmt.Sprint(calls) != fmt.Sprint(want) {
				t.Errorf("brew calls = %v, want %v", calls, want)
			}
			if restartPath != tc.wantRestart {
				t.Errorf("restart bin path = %q, want %q", restartPath, tc.wantRestart)
			}
		})
	}
}

func TestUpdate_Default_RunsUpdateAndUpgradeAndRestarts(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/9.9.9/bin/run-kit", nil)

	var rec []string
	withBrewRecorder(t, &rec, brewInfoJSON("9.9.9"))

	var restartCalls int
	var restartPath string
	withRestartRecorder(t, &restartCalls, &restartPath)

	skipBrewUpdate = false
	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}

	if !containsStr(rec, "update") {
		t.Errorf("brew update was NOT invoked on the default path; recorded subcommands: %v", rec)
	}
	if !containsStr(rec, "upgrade") {
		t.Errorf("brew upgrade was NOT invoked; recorded subcommands: %v", rec)
	}
	if restartCalls != 1 {
		t.Errorf("restartDaemonFn called %d times, want 1", restartCalls)
	}
}

// setUpdateBuffers wires updateCmd's stdout/stderr to the given buffers for the
// test's duration, so a quiet-gating test can observe the data vs chatter split.
func setUpdateBuffers(t *testing.T, stdout, stderr *bytes.Buffer) {
	t.Helper()
	updateCmd.SetOut(stdout)
	updateCmd.SetErr(stderr)
	t.Cleanup(func() { updateCmd.SetOut(nil); updateCmd.SetErr(nil) })
}

// TestUpdate_Quiet_OutcomeSurvivesProgressDropped pins R3: under --quiet the
// outcome line ("Updated to v…") survives on stdout (data) while progress lines
// ("Current version", "Updating", "Restarting") are dropped from stderr
// (chatter). Errors and exit codes are unaffected.
func TestUpdate_Quiet_OutcomeSurvivesProgressDropped(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withQuiet(t, true)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/9.9.9/bin/run-kit", nil)

	var rec []string
	withBrewRecorder(t, &rec, brewInfoJSON("9.9.9"))
	var restartCalls int
	var restartPath string
	withRestartRecorder(t, &restartCalls, &restartPath)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}

	// Outcome line is data — survives --quiet on stdout.
	if !strings.Contains(stdout.String(), "Updated to v9.9.9.") {
		t.Errorf("--quiet must keep the outcome line on stdout, got: %q", stdout.String())
	}
	// Progress/decoration lines are chatter — dropped under --quiet.
	for _, chatter := range []string{"Current version", "Updating v", "Restarting run-kit daemon", "run-kit daemon started"} {
		if strings.Contains(stderr.String(), chatter) {
			t.Errorf("--quiet must drop chatter %q, got stderr: %q", chatter, stderr.String())
		}
	}
	// The mutation still happened — --quiet changes output only, never behavior.
	if restartCalls != 1 {
		t.Errorf("restartDaemonFn called %d times, want 1 (--quiet must not change behavior)", restartCalls)
	}
}

// TestUpdate_NonQuiet_ProgressOnStderrOutcomeOnStdout pins A-009: without
// --quiet, progress lines route to stderr (the convention re-routes update's
// former stdout progress onto stderr) while the outcome line stays on stdout.
func TestUpdate_NonQuiet_ProgressOnStderrOutcomeOnStdout(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withQuiet(t, false)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/9.9.9/bin/run-kit", nil)

	var rec []string
	withBrewRecorder(t, &rec, brewInfoJSON("9.9.9"))
	var restartCalls int
	var restartPath string
	withRestartRecorder(t, &restartCalls, &restartPath)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}

	if !strings.Contains(stdout.String(), "Updated to v9.9.9.") {
		t.Errorf("outcome line must be on stdout, got stdout: %q", stdout.String())
	}
	if strings.Contains(stdout.String(), "Current version") {
		t.Errorf("progress must NOT be on stdout (convention: stdout is data), got: %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "Current version") {
		t.Errorf("progress must be on stderr, got stderr: %q", stderr.String())
	}
}

// TestUpdate_Quiet_NotBrewGuidanceSurvives pins R3's guidance clause: the
// not-a-brew-install guidance is data (it explains why nothing happened) and
// survives --quiet on stdout.
func TestUpdate_Quiet_NotBrewGuidanceSurvives(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withQuiet(t, true)
	// A non-Cellar path → IsBrewInstalled is false → guidance block prints.
	withResolveExe(t, "/usr/local/bin/run-kit", nil)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "was not installed via Homebrew") {
		t.Errorf("--quiet must keep the not-brew guidance on stdout, got: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), "brew install sahil87/tap/hexokit") {
		t.Errorf("--quiet must keep the reinstall hint, got: %q", stdout.String())
	}
}

// TestBrewStreams_QuietGating pins that under --quiet the brew subprocess stdout
// (the definitional "raw brew output" chatter) is discarded while stderr is
// BUFFERED into the returned *bytes.Buffer (so a failing quiet run can surface
// the diagnostic detail in its error), and that a non-quiet run streams to the
// real process streams with a nil errBuf. This is the seam the default runBrewFn
// uses, tested without spawning a real `brew`.
func TestBrewStreams_QuietGating(t *testing.T) {
	stdout, stderr, errBuf := brewStreams(true)
	if stdout != io.Discard {
		t.Errorf("brewStreams(true) stdout = %v, want io.Discard", stdout)
	}
	if errBuf == nil {
		t.Fatal("brewStreams(true) errBuf = nil, want a buffer to capture stderr under --quiet")
	}
	// Under --quiet stderr and errBuf are the SAME buffer (captured, not discarded).
	if stderr != io.Writer(errBuf) {
		t.Errorf("brewStreams(true) stderr must be the errBuf capture buffer, got %v", stderr)
	}

	stdout, stderr, errBuf = brewStreams(false)
	if stdout != io.Writer(os.Stdout) || stderr != io.Writer(os.Stderr) {
		t.Errorf("brewStreams(false) must return the real os.Stdout/os.Stderr, got (%v, %v)", stdout, stderr)
	}
	if errBuf != nil {
		t.Errorf("brewStreams(false) errBuf = %v, want nil (non-quiet streams live, buffers nothing)", errBuf)
	}
}

// TestRunBrewFn_QuietFailureSurfacesStderrDetail pins T004's fix: a failing brew
// under --quiet must not destroy diagnostics. The default runBrewFn buffers brew
// stderr under --quiet and wraps the captured detail into the returned error, so
// a caller sees the actual failure reason — not just "exit status 1". Uses a
// fake `brew` on PATH that writes to stderr and exits non-zero.
func TestRunBrewFn_QuietFailureSurfacesStderrDetail(t *testing.T) {
	const detail = "Error: brew-upgrade-boom-detail"
	withFakeBrew(t, detail, 1)
	withQuiet(t, true)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := runBrewFn(ctx, "upgrade", "sahil87/tap/hexokit")
	if err == nil {
		t.Fatal("failing brew under --quiet must return an error")
	}
	// The captured stderr detail must be wrapped into the error (not discarded).
	if !strings.Contains(err.Error(), detail) {
		t.Errorf("--quiet failure must surface the captured brew stderr detail, got: %v", err)
	}
}

// withFakeBrew installs a fake `brew` executable on PATH (prepended) for the
// test's duration. The fake writes stderrText to stderr and exits with exitCode,
// so runBrewFn's real exec.CommandContext path is exercised without a real brew.
func withFakeBrew(t *testing.T, stderrText string, exitCode int) {
	t.Helper()
	installFakeBrew(t, fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' %q 1>&2\nexit %d\n", stderrText, exitCode))
}

// installFakeBrew writes the given shell script as a `brew` executable in a
// temp dir and prepends that dir to PATH for the test's duration.
func installFakeBrew(t *testing.T, script string) {
	t.Helper()
	testutil.StubOnPath(t, "brew", script)
}

// TestNewBrewCmd_GracefulCancelConfig pins the per-subcommand-class cancel
// configuration (shll update standard, brew-handling safety clause): mutating
// brew subcommands (update, upgrade) get the SIGTERM-with-grace treatment
// (WaitDelay == brewCancelGrace), while read-only queries (info) keep Go's
// default cancel with no grace window (WaitDelay zero). WaitDelay is the
// observable discriminator — exec.CommandContext always sets a non-nil default
// Kill cancel, so Cancel != nil distinguishes nothing; the SIGTERM (not
// SIGKILL) semantics are pinned behaviorally by
// TestNewBrewCmd_ContextCancelDeliversSIGTERM.
func TestNewBrewCmd_GracefulCancelConfig(t *testing.T) {
	for _, sub := range []string{"update", "upgrade"} {
		cmd := newBrewCmd(context.Background(), sub, "sahil87/tap/hexokit")
		if cmd.WaitDelay != brewCancelGrace {
			t.Errorf("newBrewCmd(%q).WaitDelay = %v, want %v (mutating brew subcommands must get a SIGTERM grace window)", sub, cmd.WaitDelay, brewCancelGrace)
		}
		if cmd.Cancel == nil {
			t.Errorf("newBrewCmd(%q).Cancel = nil, want the SIGTERM cancel func", sub)
		}
	}

	cmd := newBrewCmd(context.Background(), "info", "--json=v2", "sahil87/tap/hexokit")
	if cmd.WaitDelay != 0 {
		t.Errorf("newBrewCmd(\"info\").WaitDelay = %v, want 0 (read-only queries keep default fast-fail cancel)", cmd.WaitDelay)
	}
}

// TestBrewMutationTimeouts_Generous pins the generous bounds so a future
// refactor cannot silently reintroduce a short hard cap — the exact regression
// the update standard's failure-mode paragraph warns about (a 120s hard kill
// landed mid keg-swap and corrupted the install, observed 2026-07-19).
func TestBrewMutationTimeouts_Generous(t *testing.T) {
	if brewUpgradeTimeout < 30*time.Minute {
		t.Errorf("brewUpgradeTimeout = %v, want >= 30m (bound must be sized for a network transfer, never a short hard cap)", brewUpgradeTimeout)
	}
	if brewUpdateTimeout < 10*time.Minute {
		t.Errorf("brewUpdateTimeout = %v, want >= 10m (brew update is also a network-bound package-manager mutation)", brewUpdateTimeout)
	}
}

// TestNewBrewCmd_ContextCancelDeliversSIGTERM behaviorally pins that context
// expiry on a mutating brew subcommand delivers a trappable SIGTERM — never an
// untrappable SIGKILL. A fake `brew` installs a TERM trap (writes a marker,
// exits 0), signals readiness, then loops; the test cancels the context and
// asserts the process exits within the grace window with the trap having run.
// Under SIGKILL the trap could never run and the marker would be absent.
func TestNewBrewCmd_ContextCancelDeliversSIGTERM(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns a real subprocess; skipped under -short")
	}

	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	marker := filepath.Join(dir, "graceful")
	installFakeBrew(t, fmt.Sprintf(`#!/bin/sh
trap 'touch "%s"; exit 0' TERM
touch "%s"
while :; do sleep 0.1; done
`, marker, ready))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := newBrewCmd(ctx, "upgrade", "sahil87/tap/hexokit")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start fake brew: %v", err)
	}

	// Wait for the fake brew to install its trap before canceling, so an
	// early SIGTERM can't hit the shell pre-trap and false-negative the test.
	readyDeadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(readyDeadline) {
			t.Fatal("fake brew never signaled readiness")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait() // returns ctx err after a clean post-Cancel exit — expected
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("process did not exit within the grace window after context cancel")
	}

	if _, err := os.Stat(marker); err != nil {
		t.Error("SIGTERM trap did not run (marker missing) — the process was killed, not gracefully terminated")
	}
}

func TestUpdate_SkipBrewUpdate_ShortCircuitsWhenUpToDate(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/dev/bin/run-kit", nil)

	var rec []string
	// stable equals compiled-in version ("dev"): up-to-date short-circuit fires.
	withBrewRecorder(t, &rec, brewInfoJSON(version))

	var restartCalls int
	var restartPath string
	withRestartRecorder(t, &restartCalls, &restartPath)

	skipBrewUpdate = true
	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}

	if containsStr(rec, "update") {
		t.Errorf("brew update was invoked with --skip-brew-update set; recorded subcommands: %v", rec)
	}
	if !containsStr(rec, "info") {
		t.Errorf("brew info was not invoked; recorded subcommands: %v", rec)
	}
	if containsStr(rec, "upgrade") {
		t.Errorf("brew upgrade was invoked despite being up to date; recorded subcommands: %v", rec)
	}
	if restartCalls != 0 {
		t.Errorf("restartDaemonFn called %d times, want 0 (up to date)", restartCalls)
	}
}

// ─── Umbrella (two-leg) tests ────────────────────────────────────────────────

// TestUpdate_Umbrella_NonBrewContinuesToDesktopLeg pins R7: a non-brew CLI
// install prints the manual guidance but no longer ends the command — the
// desktop leg still runs and updates a stale app.
func TestUpdate_Umbrella_NonBrewContinuesToDesktopLeg(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	// Non-Cellar path → CLI leg is the guidance skip.
	withResolveExe(t, "/usr/local/bin/run-kit", nil)

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir()
	writeDesktopBundle(t, dir)
	withUmbrellaDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", false), dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "was not installed via Homebrew") {
		t.Errorf("stdout = %q, want the not-brew guidance (still data)", stdout.String())
	}
	if !strings.Contains(stdout.String(), "Updated HexoKit v3.12.2 -> v3.13.0") {
		t.Errorf("stdout = %q, want the desktop leg to have run and updated", stdout.String())
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
}

// TestUpdate_Umbrella_NoAppSilentSkip pins R8: with no desktop app installed,
// the desktop leg is a silent exit-0 skip — no output, no error — while the
// CLI leg's outcome prints normally.
func TestUpdate_Umbrella_NoAppSilentSkip(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/dev/bin/run-kit", nil)

	var rec []string
	withBrewRecorder(t, &rec, brewInfoJSON(version)) // CLI leg: already up to date

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir() // no bundle → InstalledVersion "" → skip
	withUmbrellaDesktopStub(t, srv, desktopFakeRunner(t, "", false), dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	if got := strings.Count(stdout.String(), "Already up to date"); got != 1 {
		t.Errorf("want exactly the CLI leg's up-to-date line, got %d in %q", got, stdout.String())
	}
	if strings.Contains(stdout.String(), "HexoKit") {
		t.Errorf("stdout = %q, want no desktop-leg output on the silent skip", stdout.String())
	}
	if assetHits != 0 {
		t.Errorf("asset downloaded %d times despite no installed app", assetHits)
	}
}

// TestUpdate_Umbrella_UnsupportedPlatformNeverConstructsInstaller pins R8's
// platform gate: on a platform with no desktop package the desktop leg
// no-ops before the installer factory is even called.
func TestUpdate_Umbrella_UnsupportedPlatformNeverConstructsInstaller(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/usr/local/bin/run-kit", nil) // CLI leg: guidance skip

	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		t.Fatal("installer constructed despite the unsupported-platform gate")
		return nil
	}
	t.Cleanup(func() { newDesktopInstallerFn = origFactory })

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
}

// TestUpdate_Umbrella_CLIFailureStillRunsDesktopLeg pins R9: a CLI-leg
// failure does not prevent the desktop leg; the returned error is
// CLI-leg-labelled and the exit is non-zero while the desktop update
// completes.
func TestUpdate_Umbrella_CLIFailureStillRunsDesktopLeg(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/dev/bin/run-kit", nil)

	// brew update fails → the CLI leg errors before info/upgrade.
	origBrew := runBrewFn
	runBrewFn = func(_ context.Context, args ...string) ([]byte, error) {
		return nil, errors.New("brew-update-boom")
	}
	t.Cleanup(func() { runBrewFn = origBrew })

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir()
	writeDesktopBundle(t, dir)
	withUmbrellaDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", false), dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	err := updateCmd.RunE(updateCmd, nil)
	if err == nil {
		t.Fatal("want a non-nil error when the CLI leg fails")
	}
	if !strings.Contains(err.Error(), "CLI update:") || !strings.Contains(err.Error(), "brew-update-boom") {
		t.Errorf("error = %q, want it CLI-leg-labelled with the underlying cause", err.Error())
	}
	if strings.Contains(err.Error(), "desktop update:") {
		t.Errorf("error = %q, must not blame the (successful) desktop leg", err.Error())
	}
	if !strings.Contains(stdout.String(), "Updated HexoKit v3.12.2 -> v3.13.0") {
		t.Errorf("stdout = %q, want the desktop leg to have run despite the CLI failure", stdout.String())
	}
}

// TestUpdate_Umbrella_DesktopFailureAfterCLISuccess pins R9's other
// direction: the CLI leg's outcome stands and the desktop leg's failure is
// desktop-leg-labelled in the returned (non-zero) error.
func TestUpdate_Umbrella_DesktopFailureAfterCLISuccess(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/dev/bin/run-kit", nil)

	var rec []string
	withBrewRecorder(t, &rec, brewInfoJSON(version)) // CLI leg: already up to date

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir()
	writeDesktopBundle(t, dir)
	// codesign failure → the desktop leg's Install errors.
	failingRunner := func(_ context.Context, name string, args ...string) ([]byte, error) {
		switch name {
		case "plutil":
			return []byte("3.12.2\n"), nil
		case "pgrep":
			return nil, errors.New("exit status 1")
		case "hdiutil":
			if len(args) > 4 && args[0] == "attach" {
				if err := os.MkdirAll(filepath.Join(args[4], desktop.AppBundleName), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			return nil, nil
		case "codesign":
			return nil, errors.New("code object is not signed at all")
		}
		return nil, nil
	}
	withUmbrellaDesktopStub(t, srv, failingRunner, dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	err := updateCmd.RunE(updateCmd, nil)
	if err == nil {
		t.Fatal("want a non-nil error when the desktop leg fails")
	}
	if !strings.Contains(err.Error(), "desktop update:") || !strings.Contains(err.Error(), "signature verification failed") {
		t.Errorf("error = %q, want it desktop-leg-labelled with the underlying cause", err.Error())
	}
	if strings.Contains(err.Error(), "CLI update:") {
		t.Errorf("error = %q, must not blame the (successful) CLI leg", err.Error())
	}
	if !strings.Contains(stdout.String(), "Already up to date") {
		t.Errorf("stdout = %q, want the CLI leg's outcome to stand", stdout.String())
	}
}

// TestUpdate_Umbrella_BothLegsFail pins the errors.Join aggregation: when
// both legs fail, the returned error carries both leg labels with each leg's
// underlying cause — neither failure masks the other.
func TestUpdate_Umbrella_BothLegsFail(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/opt/homebrew/Cellar/run-kit/dev/bin/run-kit", nil)

	// brew update fails → the CLI leg errors before info/upgrade.
	origBrew := runBrewFn
	runBrewFn = func(_ context.Context, args ...string) ([]byte, error) {
		return nil, errors.New("brew-update-boom")
	}
	t.Cleanup(func() { runBrewFn = origBrew })

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir()
	writeDesktopBundle(t, dir)
	// codesign failure → the desktop leg's Install errors.
	failingRunner := func(_ context.Context, name string, args ...string) ([]byte, error) {
		switch name {
		case "plutil":
			return []byte("3.12.2\n"), nil
		case "pgrep":
			return nil, errors.New("exit status 1")
		case "hdiutil":
			if len(args) > 4 && args[0] == "attach" {
				if err := os.MkdirAll(filepath.Join(args[4], desktop.AppBundleName), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			return nil, nil
		case "codesign":
			return nil, errors.New("code object is not signed at all")
		}
		return nil, nil
	}
	withUmbrellaDesktopStub(t, srv, failingRunner, dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	err := updateCmd.RunE(updateCmd, nil)
	if err == nil {
		t.Fatal("want a non-nil error when both legs fail")
	}
	for _, want := range []string{
		"CLI update:", "brew-update-boom",
		"desktop update:", "signature verification failed",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to carry %q (both legs labelled with their causes)", err.Error(), want)
		}
	}
}

// TestUpdate_Umbrella_QuietKeepsBothLegsData pins R5/R10 for the umbrella:
// under --quiet both legs' data lines survive on stdout — including the
// desktop restart announcement — while all chatter is dropped.
func TestUpdate_Umbrella_QuietKeepsBothLegsData(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withQuiet(t, true)
	withResolveExe(t, "/usr/local/bin/run-kit", nil) // CLI leg: guidance skip

	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	dir := t.TempDir()
	writeDesktopBundle(t, dir)
	// Running app → the auto-restart path, so the announcement is exercised.
	withUmbrellaDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", true), dir)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	for _, want := range []string{
		"was not installed via Homebrew",
		"Updated HexoKit v3.12.2 -> v3.13.0",
		"HexoKit was running — restarted on the new version.",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("--quiet must keep the data line %q on stdout, got: %q", want, stdout.String())
		}
	}
	if stderr.String() != "" {
		t.Errorf("stderr = %q, want empty under --quiet", stderr.String())
	}
}

// --- Code-server leg (R12) ---

// withManagedCodeServer points the CLI's code-server seams at a managed
// install under a temp home, wired to the given release server, returning
// kill/start recorders. Restores via t.Cleanup.
func withManagedCodeServer(t *testing.T, srv *httptest.Server, installedVersion string) (kills, starts *int, home string) {
	t.Helper()
	home = t.TempDir()
	kills, starts = withCodeServerCLISeams(t, home, srv)

	if installedVersion != "" {
		bin := filepath.Join(codeserver.VersionDir(home, installedVersion), "bin")
		if err := os.MkdirAll(bin, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, "code-server"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(installedVersion, codeserver.CurrentPath(home)); err != nil {
			t.Fatal(err)
		}
	} else {
		// Managed dir present but empty (a crashed first install) — still owned.
		if err := os.MkdirAll(codeserver.BinDir(home), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return kills, starts, home
}

// TestUpdate_CodeServerLeg_NotManagedSilentSkip pins the ownership gate: no
// ~/.rk/code-server-bin ⇒ the leg is a SILENT exit-0 skip (no output, no
// installer construction, no session touch).
func TestUpdate_CodeServerLeg_NotManagedSilentSkip(t *testing.T) {
	withNoCodeServerLeg(t) // empty temp home — no managed dir

	installerBuilt := false
	origNew := newCodeServerInstallerFn
	newCodeServerInstallerFn = func() *codeserver.Installer {
		installerBuilt = true
		return codeserver.New()
	}
	t.Cleanup(func() { newCodeServerInstallerFn = origNew })

	var stdout, stderr bytes.Buffer
	runUpdateCodeServerLeg(bareCmd(&stdout, &stderr), newSinkWriters(&stdout, &stderr))

	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Errorf("leg output = %q / %q, want a silent skip", stdout.String(), stderr.String())
	}
	if installerBuilt {
		t.Error("installer constructed despite the not-managed skip")
	}
}

// TestUpdate_CodeServerLeg_StatErrorWarns pins the non-ENOENT half of the
// ownership gate: a Stat failure that is NOT "does not exist" (here ENOTDIR)
// is no proof of non-ownership — the leg warns instead of silently skipping,
// and still never joins the exit code.
func TestUpdate_CodeServerLeg_StatErrorWarns(t *testing.T) {
	home := t.TempDir()
	orig := codeServerUserHomeFn
	codeServerUserHomeFn = func() (string, error) { return home, nil }
	t.Cleanup(func() { codeServerUserHomeFn = orig })
	// A regular file where the .rk directory would be makes Stat on
	// .rk/code-server-bin fail with ENOTDIR — a real error, not ENOENT.
	if err := os.WriteFile(filepath.Join(home, ".rk"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	runUpdateCodeServerLeg(bareCmd(&stdout, &stderr), newSinkWriters(&stdout, &stderr))

	if !strings.Contains(stderr.String(), "warning: code-server leg skipped (checking") {
		t.Errorf("stderr = %q, want the stat-error warning", stderr.String())
	}
}

// TestUpdate_CodeServerLeg_UpdatesAndRespawns pins the happy path: a managed
// install behind latest gets updated and the session respawned.
func TestUpdate_CodeServerLeg_UpdatesAndRespawns(t *testing.T) {
	resetSkipFlag(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/usr/local/bin/run-kit", nil) // CLI leg: guidance skip

	srv := csReleaseServer(t, "4.133.0")
	kills, starts, _ := withManagedCodeServer(t, srv, "4.132.0")

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "Updated code-server v4.132.0 -> v4.133.0") {
		t.Errorf("stdout = %q, want the code-server update line", stdout.String())
	}
	if *kills != 1 || *starts != 1 {
		t.Errorf("kills=%d starts=%d, want 1/1 — the leg owns the respawn", *kills, *starts)
	}
}

// TestUpdate_CodeServerLeg_FailureStillExitZero pins the best-effort
// constraint: a failing code-server leg warns but NEVER contributes to the
// command's exit code (the CLI leg here succeeds as the guidance skip).
func TestUpdate_CodeServerLeg_FailureStillExitZero(t *testing.T) {
	resetSkipFlag(t)
	withNoDesktopLeg(t)
	withResolveExe(t, "/usr/local/bin/run-kit", nil)

	// A release server that 500s — the leg's download/resolve fails.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	withManagedCodeServer(t, srv, "4.132.0")

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	err := updateCmd.RunE(updateCmd, nil)
	if err != nil {
		t.Fatalf("RunE err = %v, want nil — the code-server leg never joins the exit code", err)
	}
	if !strings.Contains(stderr.String(), "warning: code-server update failed") {
		t.Errorf("stderr = %q, want the leg failure warning", stderr.String())
	}
	if !strings.Contains(stdout.String(), "was not installed via Homebrew") {
		t.Errorf("stdout = %q, want the CLI leg's guidance (it still ran)", stdout.String())
	}
}

// TestUpdate_CodeServerLeg_AlreadyCurrentSkipsRespawn pins that an up-to-date
// managed install costs no download and no session touch.
func TestUpdate_CodeServerLeg_AlreadyCurrentSkipsRespawn(t *testing.T) {
	srv := csReleaseServer(t, "4.132.0")
	kills, starts, _ := withManagedCodeServer(t, srv, "4.132.0")

	var stdout, stderr bytes.Buffer
	runUpdateCodeServerLeg(bareCmd(&stdout, &stderr), newSinkWriters(&stdout, &stderr))

	if !strings.Contains(stdout.String(), "already current") {
		t.Errorf("stdout = %q, want the already-current line", stdout.String())
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0", *kills, *starts)
	}
}

// TestUpdate_Umbrella_LinuxDesktopLegUpdates pins R8 on linux: the desktop
// leg runs against the platform default root (~/.rk/desktop under the pinned
// home — the factory deliberately sets NO InstallDir), updates a stale
// install, and prints the shared outcome line.
func TestUpdate_Umbrella_LinuxDesktopLegUpdates(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/usr/local/bin/run-kit", nil) // CLI leg: guidance skip

	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)

	root := filepath.Join(home, ".rk", "desktop")
	if err := os.MkdirAll(filepath.Join(root, "3.20.9"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.9", filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	want := "Updated HexoKit v3.20.9 -> v3.21.0 (" + filepath.Join(root, "3.21.0") + ")"
	if !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
	if target, _ := os.Readlink(filepath.Join(root, "current")); target != "3.21.0" {
		t.Errorf("current -> %q, want 3.21.0", target)
	}
}

// TestUpdate_Umbrella_LinuxDesktopLegSilentSkip: nothing installed under the
// linux default root ⇒ the desktop leg is a silent exit-0 skip.
func TestUpdate_Umbrella_LinuxDesktopLegSilentSkip(t *testing.T) {
	resetSkipFlag(t)
	withNoCodeServerLeg(t)
	withResolveExe(t, "/usr/local/bin/run-kit", nil) // CLI leg: guidance skip

	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir() // no install
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)

	var stdout, stderr bytes.Buffer
	setUpdateBuffers(t, &stdout, &stderr)

	if err := updateCmd.RunE(updateCmd, nil); err != nil {
		t.Fatalf("updateCmd.RunE returned error: %v", err)
	}
	if strings.Contains(stdout.String(), "HexoKit") {
		t.Errorf("stdout = %q, want no desktop-leg output on the silent skip", stdout.String())
	}
	if assetHits != 0 {
		t.Errorf("asset downloaded %d times despite no installed app", assetHits)
	}
}
