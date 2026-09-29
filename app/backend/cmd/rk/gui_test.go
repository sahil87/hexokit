package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"rk/internal/daemon"
	"rk/internal/gui"
	"rk/internal/settings"

	"github.com/spf13/cobra"
)

// withGuiCLISeams points every gui-family seam at hermetic stubs and isolates
// persistence (RK_CONFIG_DIR) and the GUI state dir (XDG_STATE_HOME) into temp
// dirs, so no test touches a live tmux server, the real config, or /proc
// unintentionally. Returns the ensure/kill/restart call counters.
func withGuiCLISeams(t *testing.T) (ensures, kills, restarts *int) {
	t.Helper()
	ensures, kills, restarts = new(int), new(int), new(int)

	t.Setenv("RK_CONFIG_DIR", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	origDaemonRunning := guiDaemonRunningFn
	origEnsure, origKill, origRestart := guiEnsureFn, guiKillFn, guiRestartFn
	origExists, origOptions, origCreated := guiSessionExistsFn, guiSessionOptionsFn, guiSessionCreatedFn
	origPanePids := guiPanePidsFn
	origProbe, origApps, origLookPath := guiProbeFn, guiRunningAppsFn, guiLookPathFn
	origTTY, origViewers, origNow := guiStdinTTYFn, guiViewersFn, guiNowFn
	origStampWait, origStampTick := guiStampWaitTimeout, guiStampPollTick
	origSetLock, origLocked, origFetch := guiSetLockFn, guiLockedFn, guiFetchDaemonStatusFn
	t.Cleanup(func() {
		guiDaemonRunningFn = origDaemonRunning
		guiEnsureFn, guiKillFn, guiRestartFn = origEnsure, origKill, origRestart
		guiSessionExistsFn, guiSessionOptionsFn, guiSessionCreatedFn = origExists, origOptions, origCreated
		guiPanePidsFn = origPanePids
		guiProbeFn, guiRunningAppsFn, guiLookPathFn = origProbe, origApps, origLookPath
		guiStdinTTYFn, guiViewersFn, guiNowFn = origTTY, origViewers, origNow
		guiStampWaitTimeout, guiStampPollTick = origStampWait, origStampTick
		guiSetLockFn, guiLockedFn, guiFetchDaemonStatusFn = origSetLock, origLocked, origFetch
	})

	// Hermetic defaults: daemon up, session present and stamped, backend
	// reachable — tests override the one seam their branch hinges on.
	guiDaemonRunningFn = func() bool { return true }
	guiEnsureFn = func() (daemon.GUIEnsureOutcome, error) {
		*ensures++
		return daemon.GUIEnsureStarted, nil
	}
	guiKillFn = func() (bool, error) { *kills++; return true, nil }
	guiRestartFn = func() error { *restarts++; return nil }
	guiSessionExistsFn = func(context.Context) bool { return true }
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "", true }
	guiSessionCreatedFn = func(context.Context) (time.Time, bool) { return guiNowFn().Add(-4*time.Hour - 12*time.Minute), true }
	guiPanePidsFn = func(context.Context) map[int]bool { return map[int]bool{4242: true} }
	guiProbeFn = func(context.Context, string, string) (gui.Info, error) {
		return gui.Info{Reachable: true, Width: 1920, Height: 1080}, nil
	}
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) { return nil, nil }
	guiLookPathFn = func(name string) (string, error) { return "/usr/bin/" + name, nil }
	guiStdinTTYFn = func(io.Reader) bool { return false }
	guiViewersFn = func() int { return 0 }
	guiStampWaitTimeout, guiStampPollTick = 50*time.Millisecond, 5*time.Millisecond
	guiLockedFn = func(context.Context) bool { return false }
	guiSetLockFn = func(context.Context, bool) error { return nil }
	// No daemon document by default: the guard fails open and status prints
	// the local assembly (tests script the document through this seam).
	guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) { return gui.Status{}, false }
	return ensures, kills, restarts
}

// bareCmdIn is bareCmd plus an inbound reader (the off confirm's stdin).
func bareCmdIn(out, errOut *bytes.Buffer, in io.Reader) *cobra.Command {
	cmd := bareCmd(out, errOut)
	if in != nil {
		cmd.SetIn(in)
	}
	return cmd
}

// offCmdWith builds a bare command carrying the off verb's --yes flag.
func offCmdWith(out, errOut *bytes.Buffer, in io.Reader, yes bool) *cobra.Command {
	cmd := bareCmdIn(out, errOut, in)
	cmd.Flags().Bool("yes", false, "")
	if yes {
		_ = cmd.Flags().Set("yes", "true")
	}
	return cmd
}

// statusCmdWith builds a bare command carrying the status verb's --json flag.
func statusCmdWith(out, errOut *bytes.Buffer, jsonOut bool) *cobra.Command {
	cmd := bareCmdIn(out, errOut, nil)
	cmd.Flags().Bool("json", false, "")
	if jsonOut {
		_ = cmd.Flags().Set("json", "true")
	}
	return cmd
}

// --- family shape (R15) ---

func TestGuiTreeRegistered(t *testing.T) {
	var parent *cobra.Command
	for _, c := range rootCmd.Commands() {
		if c.Name() == "gui" {
			parent = c
		}
	}
	if parent == nil {
		t.Fatal("rk gui is not registered on rootCmd")
	}
	if parent.Long == "" {
		t.Error("parent command has no Long block")
	}
	want := map[string]bool{
		"on": false, "off": false, "status": false, "env": false, "restart": false,
		"exec": false, "shot": false, "launch": false, "open": false,
		"windows": false, "focus": false, "wait": false,
		"click": false, "move": false, "scroll": false, "type": false, "key": false, "clip": false,
		"lock": false, "unlock": false, "wm": false,
	}
	var supervise *cobra.Command
	for _, c := range parent.Commands() {
		if c.Name() == "supervise" {
			supervise = c
			continue
		}
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
			if c.Long == "" {
				t.Errorf("%s has no Long block", c.Name())
			}
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("subcommand %q not registered", name)
		}
	}
	if supervise == nil {
		t.Fatal("supervise is not attached to the gui family")
	}
	if !supervise.Hidden {
		t.Error("supervise must be Hidden")
	}
}

// --- rk gui on (R10) ---

func TestGuiOnDaemonDownPersistsAndSkipsTmux(t *testing.T) {
	ensures, _, _ := withGuiCLISeams(t)
	guiDaemonRunningFn = func() bool { return false }

	var out bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled not persisted with the daemon down")
	}
	if *ensures != 0 {
		t.Errorf("ensure called %d times with the daemon down, want 0 (no tmux on a dead socket)", *ensures)
	}
	if got, want := out.String(), "enabled — the daemon starts the GUI on 'rk serve -d'\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiOnStartedNamesBackendAndDisplay(t *testing.T) {
	ensures, _, _ := withGuiCLISeams(t)

	var out bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *ensures != 1 {
		t.Errorf("ensure calls = %d, want 1", *ensures)
	}
	if got, want := out.String(), "started (Xtigervnc :10)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled not persisted")
	}
}

func TestGuiOnStartedNamesWindowManager(t *testing.T) {
	withGuiCLISeams(t)
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }

	var out, errOut bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "started (Xtigervnc :10)\n"; got != want {
		t.Errorf("stdout = %q, want %q (the datum stays one line)", got, want)
	}
	if got, want := errOut.String(), "  window manager: icewm-session\n"; got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

func TestGuiOnBarePrintsWMHint(t *testing.T) {
	withGuiCLISeams(t)
	// The default seams stamp wm "" (bare) and resolve apt-get on PATH.

	var out, errOut bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "started (Xtigervnc :10)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	want := "  no window manager — running bare. Install one: sudo apt install --no-install-recommends icewm\n" +
		"  then: rk gui restart\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want exactly %q", got, want)
	}
}

func TestGuiOnStartedFallsBackWhenStampsLag(t *testing.T) {
	withGuiCLISeams(t)
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return "", "", "", false }

	var out, errOut bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "started\n"; got != want {
		t.Errorf("stdout = %q, want %q (generic fallback when stamps are not yet readable)", got, want)
	}
	if got := errOut.String(); got != "" {
		t.Errorf("stderr = %q, want empty — no WM lines without the stamps", got)
	}
}

func TestGuiOnAlreadyRunning(t *testing.T) {
	withGuiCLISeams(t)
	guiEnsureFn = func() (daemon.GUIEnsureOutcome, error) { return daemon.GUIEnsureAlreadyRunning, nil }

	var out bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "already running\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiOnNoBackendStillEnables(t *testing.T) {
	withGuiCLISeams(t)
	guiEnsureFn = func() (daemon.GUIEnsureOutcome, error) { return daemon.GUIEnsureNoBackend, nil }

	var out bytes.Buffer
	if err := runGuiOn(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	want := "enabled — no VNC backend installed: " + gui.InstallHint(guiLookPathFn) + "\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled not persisted on the no-backend outcome")
	}
}

func TestGuiOnSaveErrorFails(t *testing.T) {
	withGuiCLISeams(t)
	orig := guiSettingsSave
	guiSettingsSave = func(settings.Settings) error { return fmt.Errorf("disk full") }
	t.Cleanup(func() { guiSettingsSave = orig })

	err := runGuiOn(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Errorf("err = %v, want the save error", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

// --- rk gui off (R11) ---

// seedGuiOn persists gui.enabled=true through the isolated config dir.
func seedGuiOn(t *testing.T) {
	t.Helper()
	st := settings.Load()
	st.GUIEnabled = true
	if err := settings.Save(st); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
}

// seedGuiGeometry persists the gui.geometry setting through the isolated
// config dir.
func seedGuiGeometry(t *testing.T, geometry string) {
	t.Helper()
	st := settings.Load()
	st.GUIGeometry = geometry
	if err := settings.Save(st); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
}

func TestGuiOffNonTTYWithAppsRefuses(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}}, nil
	}
	// guiStdinTTYFn defaults to false in withGuiCLISeams — the non-tty shape.

	var out, errOut bytes.Buffer
	err := runGuiOff(offCmdWith(&out, &errOut, strings.NewReader(""), false), nil)
	if err == nil || !strings.Contains(err.Error(), "re-run with --yes") {
		t.Errorf("err = %v, want the re-run-with---yes refusal", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if *kills != 0 {
		t.Errorf("kills = %d, want 0 — the refusal fires before any kill", *kills)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled flipped despite the refusal")
	}
}

func TestGuiOffYesKillsAndPersists(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}}, nil
	}

	var out bytes.Buffer
	if err := runGuiOff(offCmdWith(&out, &bytes.Buffer{}, nil, true), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 {
		t.Errorf("kills = %d, want 1", *kills)
	}
	if settings.Load().GUIEnabled {
		t.Error("gui.enabled still true after off --yes")
	}
	if got, want := out.String(), "gui off — rk-gui session killed\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiOffPassesPaneTreeExclude(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	var gotExclude map[int]bool
	guiRunningAppsFn = func(_ string, _ string, exclude map[int]bool) ([]gui.App, error) {
		gotExclude = exclude
		return nil, nil
	}

	var out bytes.Buffer
	if err := runGuiOff(offCmdWith(&out, &bytes.Buffer{}, nil, true), nil); err != nil {
		t.Fatal(err)
	}
	if !gotExclude[4242] {
		t.Errorf("exclude = %v, want the guiPanePidsFn set {4242} (the WM must not count as an app)", gotExclude)
	}
	if *kills != 1 {
		t.Errorf("kills = %d, want 1", *kills)
	}
}

func TestGuiOffConfirmCopyAndAbort(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	guiStdinTTYFn = func(io.Reader) bool { return true }
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}, {Name: "xterm", Count: 1}}, nil
	}
	now := time.Now()
	guiNowFn = func() time.Time { return now }
	guiSessionCreatedFn = func(context.Context) (time.Time, bool) {
		return now.Add(-4*time.Hour - 12*time.Minute), true
	}

	var out, errOut bytes.Buffer
	err := runGuiOff(offCmdWith(&out, &errOut, strings.NewReader("n\n"), false), nil)
	if err == nil || err.Error() != "aborted" {
		t.Errorf("err = %v, want aborted", err)
	}
	wantPrompt := "Turning the GUI off kills the rk-gui session and every app on display :10:\n" +
		"  chromium ×3, xterm ×1  (up 4h 12m)\n" +
		"Continue? [y/N]\n"
	if got := errOut.String(); got != wantPrompt {
		t.Errorf("stderr = %q, want exactly %q", got, wantPrompt)
	}
	if *kills != 0 {
		t.Errorf("kills = %d, want 0 — abort touches nothing", *kills)
	}
	if !settings.Load().GUIEnabled {
		t.Error("gui.enabled flipped on abort")
	}
}

func TestGuiOffConfirmYesProceeds(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	guiStdinTTYFn = func(io.Reader) bool { return true }
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}}, nil
	}

	var out bytes.Buffer
	if err := runGuiOff(offCmdWith(&out, &bytes.Buffer{}, strings.NewReader("yes\n"), false), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 {
		t.Errorf("kills = %d, want 1 after a confirmed prompt", *kills)
	}
	if settings.Load().GUIEnabled {
		t.Error("gui.enabled still true after a confirmed off")
	}
}

func TestGuiOffNothingRunningSkipsPrompt(t *testing.T) {
	_, kills, _ := withGuiCLISeams(t)
	seedGuiOn(t)
	guiSessionExistsFn = func(context.Context) bool { return false }
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return "", "", "", false }
	guiSessionCreatedFn = func(context.Context) (time.Time, bool) { return time.Time{}, false }
	guiKillFn = func() (bool, error) { *kills++; return false, nil }

	var out bytes.Buffer
	if err := runGuiOff(offCmdWith(&out, &bytes.Buffer{}, nil, false), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 {
		t.Errorf("kills = %d, want 1 (the absent-session no-op kill)", *kills)
	}
	if got, want := out.String(), "gui off\n"; got != want {
		t.Errorf("stdout = %q, want %q when nothing was running", got, want)
	}
	if settings.Load().GUIEnabled {
		t.Error("gui.enabled still true")
	}
}

// --- rk gui status (R12) ---
// The reason strings and assembly precedence are covered by the internal/gui
// assembler tests; here the CLI asserts seam wiring and its own rendering.

func TestGuiStatusOff(t *testing.T) {
	withGuiCLISeams(t)

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "gui: off\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiStatusReachable(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 2 }
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}, {Name: "xterm", Count: 1}}, nil
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	want := "gui: on (Xtigervnc, :10, 1920x1080 fixed, 2 viewers, no window manager)\n  apps: chromium ×3, xterm ×1\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

// The status line pluralizes the viewer count (singular at exactly 1) and
// names the stamped WM; the bare form stays hint-free (the hint suffix is
// doctor-only).
func TestGuiStatusSingularViewerNamesWM(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 1 }
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "gui: on (Xtigervnc, :10, 1920x1080 fixed, 1 viewer, icewm-session)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiStatusPassesPaneTreeExclude(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	var gotExclude map[int]bool
	guiRunningAppsFn = func(_ string, _ string, exclude map[int]bool) ([]gui.App, error) {
		gotExclude = exclude
		return nil, nil
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if !gotExclude[4242] {
		t.Errorf("exclude = %v, want the guiPanePidsFn set {4242} (the WM must not count as an app)", gotExclude)
	}
}

func TestGuiStatusDaemonDownReadsSessionAbsent(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiDaemonRunningFn = func() bool { return false }
	guiSessionExistsFn = func(context.Context) bool {
		t.Error("session probed with the daemon down — a tmux command on a dead socket births a server")
		return false
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	want := "gui: on — not running (rk-gui session absent; the daemon starts it on 'rk daemon start')\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiStatusJSONDocument(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 1 }
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "chromium", Count: 3}}, nil
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, true), nil); err != nil {
		t.Fatalf("runGuiStatus: %v, want exit 0", err)
	}
	var st gui.Status
	unwrapEnvelopeResult(t, out.String(), &st)
	if st.ID != "host" || !st.Enabled || !st.Reachable || !st.Session {
		t.Errorf("document = %+v, want id=host enabled/reachable/session", st)
	}
	if st.Backend != "Xtigervnc" || st.Display != ":10" || st.Width != 1920 || st.Height != 1080 || st.Viewers != 1 {
		t.Errorf("document = %+v, want Xtigervnc/:10/1920x1080/1 viewer", st)
	}
	wantSock := filepath.Join("hexokit", "gui", "host.sock")
	if !strings.HasSuffix(st.Socket, wantSock) {
		t.Errorf("socket = %q, want suffix %q", st.Socket, wantSock)
	}
	if len(st.Apps) != 1 || st.Apps[0].Name != "chromium" || st.Apps[0].Count != 3 {
		t.Errorf("apps = %+v, want [{chromium 3}]", st.Apps)
	}
	if st.UptimeSeconds <= 0 {
		t.Errorf("uptime_seconds = %d, want > 0 (stamped session_created)", st.UptimeSeconds)
	}
}

// A session-starter WM carries the (session) suffix on the human summary only;
// --json keeps the plain binary name.
func TestGuiStatusSessionStarterSuffix(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 1 }
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "startlxqt", true }

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "gui: on (Xtigervnc, :10, 1920x1080 fixed, 1 viewer, startlxqt (session))\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}

	out.Reset()
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, true), nil); err != nil {
		t.Fatalf("runGuiStatus: %v, want exit 0", err)
	}
	var st gui.Status
	unwrapEnvelopeResult(t, out.String(), &st)
	if st.WM != "startlxqt" {
		t.Errorf("--json wm = %q, want the plain binary name (no suffix)", st.WM)
	}

	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }
	out.Reset()
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); strings.Contains(got, "(session)") {
		t.Errorf("stdout = %q, want no (session) suffix for a bare WM", got)
	}
}

// --- rk gui env (R13) ---

func TestGuiEnvOffRefuses(t *testing.T) {
	withGuiCLISeams(t)

	err := runGuiEnv(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || err.Error() != "gui is off — turn it on with 'rk gui on'" {
		t.Errorf("err = %v, want the off refusal", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestGuiEnvNotRunningRefuses(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiProbeFn = func(context.Context, string, string) (gui.Info, error) {
		return gui.Info{Reason: "not running"}, nil
	}

	err := runGuiEnv(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || err.Error() != "gui is on but not running — see 'rk gui status'" {
		t.Errorf("err = %v, want the not-running refusal", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestGuiEnvPrintsExports(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)

	var out bytes.Buffer
	if err := runGuiEnv(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(out.String(), "\n")
	if len(lines) < 2 || lines[0] != "export DISPLAY=:10" {
		t.Errorf("stdout = %q, want the DISPLAY export first", out.String())
	}
	wantSockSuffix := filepath.Join("hexokit", "gui", "host.sock")
	if !strings.HasPrefix(lines[1], "export RK_GUI_SOCKET='") || !strings.HasSuffix(lines[1], wantSockSuffix+"'") {
		t.Errorf("socket export = %q, want export RK_GUI_SOCKET='<…%s>'", lines[1], wantSockSuffix)
	}
}

// The env output is eval'd by shell startup blocks, so the socket path must
// survive spaces and shell metacharacters as one inert word.
func TestShellSingleQuote(t *testing.T) {
	cases := map[string]string{
		"/plain/host.sock":         "'/plain/host.sock'",
		"/with space/host.sock":    "'/with space/host.sock'",
		"/it's/$(rm -rf x)/h.sock": `'/it'\''s/$(rm -rf x)/h.sock'`,
	}
	for in, want := range cases {
		if got := shellSingleQuote(in); got != want {
			t.Errorf("shellSingleQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

// --- rk gui restart (R14) ---

func TestGuiRestartRefusesWhenDisabled(t *testing.T) {
	_, _, restarts := withGuiCLISeams(t)

	err := runGuiRestart(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || err.Error() != "gui is off — turn it on with 'rk gui on'" {
		t.Errorf("err = %v, want the disabled refusal", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if *restarts != 0 {
		t.Errorf("restart seam called %d times while disabled", *restarts)
	}
}

func TestGuiRestartRefusesWhenDaemonDown(t *testing.T) {
	_, _, restarts := withGuiCLISeams(t)
	seedGuiOn(t)
	guiDaemonRunningFn = func() bool { return false }

	err := runGuiRestart(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || !strings.Contains(err.Error(), "rk serve -d") {
		t.Errorf("err = %v, want the daemon-down refusal naming rk serve -d", err)
	}
	if *restarts != 0 {
		t.Errorf("restart seam called %d times with the daemon down", *restarts)
	}
}

func TestGuiRestartSuccess(t *testing.T) {
	_, _, restarts := withGuiCLISeams(t)
	seedGuiOn(t)

	var out bytes.Buffer
	if err := runGuiRestart(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *restarts != 1 {
		t.Errorf("restart calls = %d, want 1", *restarts)
	}
	if got, want := out.String(), "restarted (Xtigervnc :10)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiRestartNamesWindowManager(t *testing.T) {
	_, _, restarts := withGuiCLISeams(t)
	seedGuiOn(t)
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }

	var out, errOut bytes.Buffer
	if err := runGuiRestart(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if *restarts != 1 {
		t.Errorf("restart calls = %d, want 1", *restarts)
	}
	if got, want := out.String(), "restarted (Xtigervnc :10)\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
	if got, want := errOut.String(), "  window manager: icewm-session\n"; got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
}

func TestGuiRestartBarePrintsWMHint(t *testing.T) {
	_, _, _ = withGuiCLISeams(t)
	seedGuiOn(t)

	var out, errOut bytes.Buffer
	if err := runGuiRestart(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	want := "  no window manager — running bare. Install one: sudo apt install --no-install-recommends icewm\n" +
		"  then: rk gui restart\n"
	if got := errOut.String(); got != want {
		t.Errorf("stderr = %q, want exactly %q", got, want)
	}
}

// --- the human-input guard (R4) ---

func TestGuiRequireNoHumanInput(t *testing.T) {
	withGuiCLISeams(t)
	cases := []struct {
		name    string
		agoMS   int64
		force   bool
		fetch   bool // false = daemon document unreachable (fail-open)
		wantErr string
	}{
		{"absent proceeds", 0, false, true, ""},
		{"1ms refuses", 1, false, true, "human input 1s ago — retry or pass --force"},
		{"2999ms refuses", 2999, false, true, "human input 2s ago — retry or pass --force"},
		{"3000ms proceeds", 3000, false, true, ""},
		{"whole seconds floored", 1200, false, true, "human input 1s ago — retry or pass --force"},
		{"force proceeds", 100, true, true, ""},
		{"daemon down fails open", 1500, false, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) {
				return gui.Status{HumanInputAgoMS: tc.agoMS}, tc.fetch
			}
			err := guiRequireNoHumanInput(context.Background(), tc.force)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("err = %v, want nil", err)
				}
				return
			}
			if err == nil || err.Error() != tc.wantErr {
				t.Errorf("err = %v, want exactly %q", err, tc.wantErr)
			}
			if code := exitCode(err); code != 1 {
				t.Errorf("exit code = %d, want 1", code)
			}
		})
	}
}

// --- rk gui lock / unlock (R8) ---

func TestGuiLockUnlockHappyPath(t *testing.T) {
	for _, tc := range []struct {
		name    string
		run     func(*cobra.Command, []string) error
		wantSet bool
		wantOut string
	}{
		{"lock", runGuiLock, true, "locked\n"},
		{"unlock", runGuiUnlock, false, "unlocked\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withGuiCLISeams(t)
			seedGuiOn(t)
			var sets []bool
			guiSetLockFn = func(_ context.Context, locked bool) error {
				sets = append(sets, locked)
				return nil
			}

			var out bytes.Buffer
			if err := tc.run(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
				t.Fatal(err)
			}
			if got := out.String(); got != tc.wantOut {
				t.Errorf("stdout = %q, want %q", got, tc.wantOut)
			}
			if len(sets) != 1 || sets[0] != tc.wantSet {
				t.Errorf("guiSetLockFn calls = %v, want [%v]", sets, tc.wantSet)
			}
		})
	}
}

func TestGuiLockOffRefuses(t *testing.T) {
	withGuiCLISeams(t)
	called := false
	guiSetLockFn = func(context.Context, bool) error { called = true; return nil }

	err := runGuiLock(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || err.Error() != guiErrOff {
		t.Errorf("err = %v, want the off refusal", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	if called {
		t.Error("guiSetLockFn called while the GUI is off")
	}
}

func TestGuiLockDarwinRefusesBeforeStatusRead(t *testing.T) {
	withGuiCLISeams(t)
	origGOOS := guiGOOS
	guiGOOS = "darwin"
	t.Cleanup(func() { guiGOOS = origGOOS })
	guiDaemonRunningFn = func() bool {
		t.Error("status seams consulted on darwin — the OS refusal must fire first")
		return false
	}

	err := runGuiLock(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || err.Error() != guiDarwinRefusal("lock").Error() {
		t.Errorf("err = %v, want the macOS refusal for lock", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

func TestGuiLockSetErrorPropagates(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiSetLockFn = func(context.Context, bool) error { return fmt.Errorf("tmux exited 1") }

	err := runGuiLock(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || !strings.Contains(err.Error(), "tmux exited 1") {
		t.Errorf("err = %v, want the set error propagated", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
}

// --- status: locked segment and the fetched daemon document (R7/R8) ---

func TestGuiStatusLockedSegment(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 1 }
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }
	guiLockedFn = func(context.Context) bool { return true }

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	want := "gui: on (Xtigervnc, :10, 1920x1080 fixed, 1 viewer, icewm-session, locked)\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q (locked rides last in the paren list)", got, want)
	}
}

// The fetched document's human-input age renders as an indented line after
// the summary (and after the apps line when apps exist), only inside the
// grace window.
// The geometry segment carries the gui.geometry setting's fixed/auto marker
// next to the probe's live WxH (the two may disagree transiently mid-resize).
func TestGuiStatusGeometrySegment(t *testing.T) {
	cases := []struct {
		name          string
		geometry      string
		width, height int
		want          string
	}{
		{"fixed", "1600x900", 1600, 900, "gui: on (Xtigervnc, :10, 1600x900 fixed, 1 viewer, icewm-session)\n"},
		{"auto", "auto", 1920, 1080, "gui: on (Xtigervnc, :10, 1920x1080 auto, 1 viewer, icewm-session)\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withGuiCLISeams(t)
			seedGuiOn(t)
			seedGuiGeometry(t, tc.geometry)
			guiViewersFn = func() int { return 1 }
			guiSessionOptionsFn = func(context.Context) (string, string, string, bool) { return ":10", "Xtigervnc", "icewm-session", true }
			guiProbeFn = func(context.Context, string, string) (gui.Info, error) {
				return gui.Info{Reachable: true, Width: tc.width, Height: tc.height}, nil
			}

			var out bytes.Buffer
			if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
				t.Fatal(err)
			}
			if got := out.String(); got != tc.want {
				t.Errorf("stdout = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestGuiStatusHumanInputLine(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiRunningAppsFn = func(string, string, map[int]bool) ([]gui.App, error) {
		return []gui.App{{Name: "xterm", Count: 1}}, nil
	}
	guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) {
		return gui.Status{HumanInputAgoMS: 1200}, true
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	want := "gui: on (Xtigervnc, :10, 1920x1080 fixed, 0 viewers, no window manager)\n" +
		"  apps: xterm ×1\n" +
		"  human input 1s ago\n"
	if got := out.String(); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestGuiStatusHumanInputLineOutsideGrace(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) {
		return gui.Status{HumanInputAgoMS: 5000}, true
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, false), nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "human input") {
		t.Errorf("stdout = %q, want no human-input line at 5s (past the 3s grace)", out.String())
	}
}

// --json prints the fetched daemon document when the fetch answers (the live
// viewers count is hub-local), else the local assembly.
func TestGuiStatusJSONPrefersFetchedDocument(t *testing.T) {
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiViewersFn = func() int { return 3 }
	guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) {
		return gui.Status{ID: "host", Enabled: true, Reachable: true, Display: ":10", Viewers: 7}, true
	}

	var out bytes.Buffer
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, true), nil); err != nil {
		t.Fatalf("runGuiStatus: %v, want exit 0", err)
	}
	var st gui.Status
	unwrapEnvelopeResult(t, out.String(), &st)
	if st.Viewers != 7 {
		t.Errorf("viewers = %d, want 7 from the fetched daemon document", st.Viewers)
	}

	guiFetchDaemonStatusFn = func(context.Context) (gui.Status, bool) { return gui.Status{}, false }
	out.Reset()
	if err := runGuiStatus(statusCmdWith(&out, &bytes.Buffer{}, true), nil); err != nil {
		t.Fatalf("runGuiStatus: %v, want exit 0", err)
	}
	st = gui.Status{}
	unwrapEnvelopeResult(t, out.String(), &st)
	if st.Viewers != 3 {
		t.Errorf("viewers = %d, want 3 from the local assembly when the fetch fails", st.Viewers)
	}
}

// --- help grouping (R12) ---

func TestGuiHelpGroupsNewVerbs(t *testing.T) {
	for _, label := range []string{"display:", "look:", "drive:", "guard:"} {
		if !strings.Contains(guiCmd.Long, label) {
			t.Errorf("gui Long lacks the %q group label", label)
		}
	}
	for _, verb := range []string{"windows", "focus", "wait", "click", "move", "scroll", "type", "key", "clip", "open", "lock", "unlock"} {
		n := len(regexp.MustCompile(`\b`+verb+`\b`).FindAllString(guiCmd.Long, -1))
		if n != 1 {
			t.Errorf("gui Long lists %q %d times, want exactly once", verb, n)
		}
	}
}
