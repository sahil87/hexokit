package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/gui"
	"rk/internal/settings"
	"rk/internal/testutil"
)

// guiSupLogBuf is a goroutine-safe log capture for the supervisor's log seam.
type guiSupLogBuf struct {
	mu sync.Mutex
	sb strings.Builder
}

func (b *guiSupLogBuf) write(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sb.WriteString(line + "\n")
}

func (b *guiSupLogBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sb.String()
}

// captureGuiSuperviseLog swaps the log seam for a buffer for one test.
func captureGuiSuperviseLog(t *testing.T) *guiSupLogBuf {
	t.Helper()
	buf := &guiSupLogBuf{}
	orig := guiSuperviseLog
	t.Cleanup(func() { guiSuperviseLog = orig })
	guiSuperviseLog = buf.write
	return buf
}

// captureGuiStamps swaps the tmux stamp seam for an argv recorder.
func captureGuiStamps(t *testing.T) *[][]string {
	t.Helper()
	stamps := &[][]string{}
	orig := guiSuperviseTmuxRun
	t.Cleanup(func() { guiSuperviseTmuxRun = orig })
	guiSuperviseTmuxRun = func(_ context.Context, args ...string) error {
		*stamps = append(*stamps, append([]string(nil), args...))
		return nil
	}
	return stamps
}

// withGuiSuperviseGOOS forks the OS dispatch for one test.
func withGuiSuperviseGOOS(t *testing.T, goos string) {
	t.Helper()
	orig := guiSuperviseGOOS
	t.Cleanup(func() { guiSuperviseGOOS = orig })
	guiSuperviseGOOS = goos
}

// withGuiSuperviseLookPath scripts the binary-resolution seam for one test.
func withGuiSuperviseLookPath(t *testing.T, resolvable map[string]string) {
	t.Helper()
	orig := guiSuperviseLookPath
	t.Cleanup(func() { guiSuperviseLookPath = orig })
	guiSuperviseLookPath = func(name string) (string, error) {
		if p, ok := resolvable[name]; ok {
			return p, nil
		}
		return "", fmt.Errorf("%s not found", name)
	}
}

// withGuiSuperviseSettingsLoad stubs the settings seam with the given gui.wm
// pin ("" = no pin) and gui.geometry value so supervisor tests never read a
// real config file.
func withGuiSuperviseSettingsLoad(t *testing.T, pin, geometry string) {
	t.Helper()
	orig := guiSuperviseSettingsLoad
	t.Cleanup(func() { guiSuperviseSettingsLoad = orig })
	guiSuperviseSettingsLoad = func() settings.Settings {
		return settings.Settings{GUIWM: pin, GUIGeometry: geometry}
	}
}

// waitForGuiLog polls until the captured log contains want (deadline-bounded).
func waitForGuiLog(t *testing.T, buf *guiSupLogBuf, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buf.String(), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("log did not gain %q within 5s; got:\n%s", want, buf.String())
}

// --- line formats ---

func TestGuiSuperviseLineFormats(t *testing.T) {
	if got, want := guiBackendUpLine("Xtigervnc", ":11", "/x/gui/host.sock"),
		"gui: Xtigervnc up on :11 (socket /x/gui/host.sock)"; got != want {
		t.Errorf("up line = %q, want %q", got, want)
	}
	if got, want := guiDesktopLine("1600x900", false),
		"gui: desktop 1600x900 (gui.geometry)"; got != want {
		t.Errorf("fixed desktop line = %q, want %q", got, want)
	}
	if got, want := guiDesktopLine("1920x1080", true),
		"gui: desktop 1920x1080 (auto — follows the focused viewer)"; got != want {
		t.Errorf("auto desktop line = %q, want %q", got, want)
	}
	if got, want := guiDesktopInvalidLine("abc"),
		`gui: desktop 1920x1080 (default — invalid gui.geometry "abc")`; got != want {
		t.Errorf("invalid desktop line = %q, want %q", got, want)
	}
	if got, want := guiNoWMLine("sudo apt install --no-install-recommends icewm"),
		"gui: no window manager found (tried icewm-session, openbox, xfwm4, i3, kwin_x11, x-session-manager); running bare — sudo apt install --no-install-recommends icewm, then rk gui restart"; got != want {
		t.Errorf("no-WM line = %q, want %q", got, want)
	}
	if got, want := guiPinMissLine("xfwm4", "sudo apt install --no-install-recommends icewm"),
		"gui: gui.wm=xfwm4 not on PATH; falling back to the ladder — sudo apt install --no-install-recommends icewm"; got != want {
		t.Errorf("pin-miss line = %q, want %q", got, want)
	}
	if got, want := guiSeedFailedLine("/s/gui/icewm", errors.New("disk full")),
		"gui: seeding the IceWM profile at /s/gui/icewm failed: disk full; starting icewm with its defaults"; got != want {
		t.Errorf("seed-failed line = %q, want %q", got, want)
	}
	if got, want := guiWMLine("icewm-session", "/s/gui/icewm", true),
		"gui: window manager icewm-session (config /s/gui/icewm, seeded preferences)"; got != want {
		t.Errorf("icewm seeded line = %q, want %q", got, want)
	}
	if got, want := guiWMLine("icewm-session", "/s/gui/icewm", false),
		"gui: window manager icewm-session (config /s/gui/icewm)"; got != want {
		t.Errorf("icewm re-run line = %q, want %q (no seeded suffix)", got, want)
	}
	if got, want := guiWMLine("openbox", "", false),
		"gui: window manager openbox"; got != want {
		t.Errorf("non-icewm line = %q, want %q (no config segment)", got, want)
	}
	if got, want := guiWMLine("startlxqt", "", false),
		"gui: window manager startlxqt (session under dbus-run-session)"; got != want {
		t.Errorf("session-starter line = %q, want %q", got, want)
	}
	if got, want := guiWMLine("startlxqt", "/s/gui/lxqt/etc", true),
		"gui: window manager startlxqt (session under dbus-run-session; defaults /s/gui/lxqt/etc, seeded)"; got != want {
		t.Errorf("lxqt seeded line = %q, want %q", got, want)
	}
	if got, want := guiWMLine("lxqt-session", "/s/gui/lxqt/etc", false),
		"gui: window manager lxqt-session (session under dbus-run-session; defaults /s/gui/lxqt/etc)"; got != want {
		t.Errorf("lxqt re-run line = %q, want %q (no seeded suffix)", got, want)
	}
	if got, want := guiLXQtSeedFailedLine("/s/gui/lxqt/etc", "startlxqt", errors.New("disk full")),
		"gui: seeding the LXQt defaults at /s/gui/lxqt/etc failed: disk full; starting startlxqt with its defaults"; got != want {
		t.Errorf("lxqt-seed-failed line = %q, want %q", got, want)
	}
	if got, want := guiLXQtDefaultsDirFailedLine("lxqt-session", errors.New("no home")),
		"gui: resolving the LXQt defaults dir failed: no home; starting lxqt-session with its defaults"; got != want {
		t.Errorf("lxqt-dir-failed line = %q, want %q", got, want)
	}
	if got, want := guiToolbarLine("x-terminal-emulator", ""),
		"gui: toolbar: terminal=x-terminal-emulator browser=none"; got != want {
		t.Errorf("toolbar line = %q, want %q", got, want)
	}
	if got, want := guiBackendExitLine("Xtigervnc", 1, ":10"),
		"gui: Xtigervnc exited (status 1) — display :10 is down; run 'rk gui restart' or turn the GUI off"; got != want {
		t.Errorf("exit line = %q, want %q", got, want)
	}
	if got, want := guiNoRootBackgroundLine(),
		"gui: no xsetroot on PATH; the empty desktop stays black — apt install x11-xserver-utils"; got != want {
		t.Errorf("no-xsetroot line = %q, want %q", got, want)
	}
	if got, want := guiRootBackgroundFailedLine(errors.New("exit status 1")),
		"gui: xsetroot failed: exit status 1; the empty desktop stays black"; got != want {
		t.Errorf("xsetroot-failed line = %q, want %q", got, want)
	}
	if got, want := guiScreenSharingLine(true),
		"Screen Sharing: reachable on 127.0.0.1:5900"; got != want {
		t.Errorf("reachable line = %q, want %q", got, want)
	}
	if got, want := guiScreenSharingLine(false),
		"Screen Sharing: not reachable — enable System Settings › General › Sharing › Screen Sharing"; got != want {
		t.Errorf("unreachable line = %q, want %q", got, want)
	}
}

// --- validation ---

func TestGuiSuperviseRejectsBadID(t *testing.T) {
	err := runGuiSupervise("nope", ":10")
	if err == nil || err.Error() != `gui id must be "host"` {
		t.Errorf("err = %v, want the ValidateGUIID refusal", err)
	}
}

func TestGuiSuperviseRejectsBadDisplay(t *testing.T) {
	for _, display := range []string{"", "10", ":10a", "::1"} {
		if err := runGuiSupervise("host", display); err == nil || !strings.Contains(err.Error(), ":N") {
			t.Errorf("display %q: err = %v, want the :N form error", display, err)
		}
	}
}

// --- darwin dispatch ---

func TestGuiSuperviseDarwinProbesAndSpawnsNothing(t *testing.T) {
	withGuiSuperviseGOOS(t, "darwin")
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	origProbe := guiSuperviseProbe
	t.Cleanup(func() { guiSuperviseProbe = origProbe })
	guiSuperviseProbe = func(context.Context, string, string) (gui.Info, error) {
		return gui.Info{Reachable: true}, nil
	}
	backendStarts := 0
	origStart := guiSuperviseStartBackend
	t.Cleanup(func() { guiSuperviseStartBackend = origStart })
	guiSuperviseStartBackend = func(context.Context, []string) (*exec.Cmd, error) {
		backendStarts++
		return nil, fmt.Errorf("darwin spawns nothing")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already signalled: probe once, log, exit 0
	if err := runGuiSuperviseCtx(ctx, "host", ":10"); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(buf.String(), "Screen Sharing: reachable on 127.0.0.1:5900") {
		t.Errorf("log =\n%s\nwant the reachable line", buf.String())
	}
	want := []string{"set-option", "-t", "=rk-gui:", "@rk_gui_backend", "screen-sharing"}
	if len(*stamps) != 1 || strings.Join((*stamps)[0], " ") != strings.Join(want, " ") {
		t.Errorf("stamps = %v, want exactly [%v]", *stamps, want)
	}
	if backendStarts != 0 {
		t.Errorf("backend starts = %d, want 0 — darwin spawns nothing", backendStarts)
	}
}

func TestGuiSuperviseDarwinUnreachableLine(t *testing.T) {
	withGuiSuperviseGOOS(t, "darwin")
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	origProbe := guiSuperviseProbe
	t.Cleanup(func() { guiSuperviseProbe = origProbe })
	guiSuperviseProbe = func(context.Context, string, string) (gui.Info, error) {
		return gui.Info{Reachable: false, Reason: "not running"}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runGuiSuperviseCtx(ctx, "host", ":10"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "Screen Sharing: not reachable — enable System Settings › General › Sharing › Screen Sharing") {
		t.Errorf("log =\n%s\nwant the not-reachable line", buf.String())
	}
}

// --- linux dispatch ---

// guiBackendStub is a fake Xvnc: it creates the socket named by its
// -rfbunixpath argv element, then either sleeps (stays up) or exits 3
// (self-exit), per the tail.
const guiBackendStubUp = `#!/bin/sh
sock=""
while [ $# -gt 0 ]; do
  case "$1" in -rfbunixpath) sock="$2"; shift ;; esac
  shift
done
touch "$sock"
exec sleep 60
`

const guiBackendStubExit = `#!/bin/sh
sock=""
while [ $# -gt 0 ]; do
  case "$1" in -rfbunixpath) sock="$2"; shift ;; esac
  shift
done
touch "$sock"
exit 3
`

func TestGuiSuperviseLinuxNoBackendErrors(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	withGuiSuperviseLookPath(t, map[string]string{})
	t.Setenv("XDG_STATE_HOME", t.TempDir())

	err := runGuiSuperviseCtx(context.Background(), "host", ":10")
	if err == nil || !strings.Contains(err.Error(), "no VNC backend installed") {
		t.Errorf("err = %v, want the no-backend error naming the install hint", err)
	}
}

func TestGuiSuperviseLinuxSignalTeardown(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		// no WM resolves ⇒ the bare line must be logged (the no-manager hint —
		// no apt-get/dnf/pacman on the fake PATH)
	})
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)

	sock, err := gui.SocketPath("host")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":11") }()

	waitForGuiLog(t, buf, guiBackendUpLine("Xtigervnc", ":11", sock))
	wantStamp := []string{"set-option", "-t", "=rk-gui:", "@rk_gui_display", ":11"}
	found := false
	for _, s := range *stamps {
		if strings.Join(s, " ") == strings.Join(wantStamp, " ") {
			found = true
		}
	}
	if !found {
		t.Errorf("stamps = %v, want one %v", *stamps, wantStamp)
	}
	if !strings.Contains(buf.String(), guiNoWMLine("install icewm with your package manager")) {
		t.Errorf("log =\n%s\nwant the bare-WM line", buf.String())
	}
	// The socket must be 0600 in a 0700 dir.
	info, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("socket mode = %o, want 600", info.Mode().Perm())
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("signal teardown err = %v, want nil (exit 0)", err)
	}
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Errorf("socket still present after teardown: %v", err)
	}
}

// withGuiSuperviseBackendArgvRec wraps the backend-start seam so the test sees
// the argv while the stub backend still starts.
func withGuiSuperviseBackendArgvRec(t *testing.T) *[][]string {
	t.Helper()
	argvs := &[][]string{}
	orig := guiSuperviseStartBackend
	t.Cleanup(func() { guiSuperviseStartBackend = orig })
	guiSuperviseStartBackend = func(ctx context.Context, argv []string) (*exec.Cmd, error) {
		*argvs = append(*argvs, append([]string(nil), argv...))
		return orig(ctx, argv)
	}
	return argvs
}

// argvFlagValue returns the element following flag in argv, or "".
func argvFlagValue(argv []string, flag string) string {
	for i, arg := range argv {
		if arg == flag && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

// The -geometry argv and the desktop log line read gui.geometry once at
// supervise start: a fixed value passes verbatim, auto and an unparsable value boot at the default.
func TestGuiSuperviseLinuxGeometryFromSettings(t *testing.T) {
	for name, tc := range map[string]struct {
		geometry string
		wantArgv string
		wantLine string
	}{
		"fixed": {"1600x900", "1600x900", "gui: desktop 1600x900 (gui.geometry)"},
		"auto":  {"auto", "1920x1080", "gui: desktop 1920x1080 (auto — follows the focused viewer)"},
		// A hand-edited, unparsable value boots at the default and says so —
		// never attributed to gui.geometry as if the setting had asked for it.
		"invalid": {"abc", "1920x1080", `gui: desktop 1920x1080 (default — invalid gui.geometry "abc")`},
	} {
		t.Run(name, func(t *testing.T) {
			withGuiSuperviseGOOS(t, "linux")
			t.Setenv("XDG_STATE_HOME", t.TempDir())
			stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
			withGuiSuperviseLookPath(t, map[string]string{
				"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
			})
			buf := captureGuiSuperviseLog(t)
			captureGuiStamps(t)
			withGuiSuperviseSettingsLoad(t, "", tc.geometry)
			argvs := withGuiSuperviseBackendArgvRec(t)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- runGuiSuperviseCtx(ctx, "host", ":21") }()

			waitForGuiLog(t, buf, tc.wantLine)
			if len(*argvs) != 1 {
				t.Fatalf("backend starts = %d, want 1", len(*argvs))
			}
			if got := argvFlagValue((*argvs)[0], "-geometry"); got != tc.wantArgv {
				t.Errorf("backend argv -geometry = %q, want %q (argv %v)", got, tc.wantArgv, (*argvs)[0])
			}

			cancel()
			if err := <-done; err != nil {
				t.Errorf("teardown err = %v, want nil", err)
			}
		})
	}
}

func TestGuiSuperviseLinuxLaunchesWMWithDisplay(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	displayFile := filepath.Join(t.TempDir(), "wm-display")
	t.Setenv("GUI_WM_DISPLAY_FILE", displayFile)
	wmDir := testutil.StubOnPath(t, "kwin_x11", "#!/bin/sh\necho \"$DISPLAY\" > \"$GUI_WM_DISPLAY_FILE\"\nexec sleep 60\n")
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"kwin_x11":  filepath.Join(wmDir, "kwin_x11"),
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":12") }()

	waitForGuiLog(t, buf, "gui: Xtigervnc up on :12")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(displayFile); err == nil && strings.TrimSpace(string(data)) == ":12" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	data, err := os.ReadFile(displayFile)
	if err != nil || strings.TrimSpace(string(data)) != ":12" {
		t.Errorf("WM DISPLAY file = %q (%v), want :12", data, err)
	}
	if strings.Contains(buf.String(), "gui: no window manager found") {
		t.Errorf("log =\n%s\nwant no bare-WM line when kwin_x11 resolves", buf.String())
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

// The root-background step: xsetroot present ⇒ it runs after the WM with
// DISPLAY set; absent ⇒ the hint line, backend still up; failing ⇒ the failure
// line, supervisor still alive.
func TestGuiSuperviseLinuxPaintsRootBackground(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"xsetroot":  "/usr/bin/xsetroot",
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)

	type run struct {
		argv    []string
		display string
	}
	var (
		mu   sync.Mutex
		runs []run
	)
	orig := guiSuperviseRunOnDisplay
	t.Cleanup(func() { guiSuperviseRunOnDisplay = orig })
	guiSuperviseRunOnDisplay = func(_ context.Context, argv []string, display string) error {
		mu.Lock()
		defer mu.Unlock()
		runs = append(runs, run{append([]string(nil), argv...), display})
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":12") }()

	waitForGuiLog(t, buf, "gui: Xtigervnc up on :12")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(runs)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	got := append([]run(nil), runs...)
	mu.Unlock()
	want := run{[]string{"xsetroot", "-solid", gui.RootBackground}, ":12"}
	if len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Errorf("root-background runs = %+v, want exactly %+v", got, want)
	}
	if strings.Contains(buf.String(), guiNoRootBackgroundLine()) {
		t.Errorf("log =\n%s\nwant no hint line when xsetroot resolves", buf.String())
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxNoXsetrootLogsHint(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	orig := guiSuperviseRunOnDisplay
	t.Cleanup(func() { guiSuperviseRunOnDisplay = orig })
	guiSuperviseRunOnDisplay = func(context.Context, []string, string) error {
		t.Error("xsetroot must not run when it is not on PATH")
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":13") }()

	waitForGuiLog(t, buf, "gui: Xtigervnc up on :13")
	waitForGuiLog(t, buf, guiNoRootBackgroundLine())
	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxXsetrootFailureIsLogged(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"xsetroot":  "/usr/bin/xsetroot",
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	orig := guiSuperviseRunOnDisplay
	t.Cleanup(func() { guiSuperviseRunOnDisplay = orig })
	guiSuperviseRunOnDisplay = func(context.Context, []string, string) error {
		return errors.New("exit status 1")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":14") }()

	waitForGuiLog(t, buf, guiRootBackgroundFailedLine(errors.New("exit status 1")))
	// Still alive after the failure: the socket is up and teardown is clean.
	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxBackendExitStaysIdle(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubExit)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)

	sock, err := gui.SocketPath("host")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":10") }()

	waitForGuiLog(t, buf, "gui: Xtigervnc exited (status 3) — display :10 is down; run 'rk gui restart' or turn the GUI off")
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Errorf("socket still present after the backend exit: %v", err)
	}
	// R6: the supervisor BLOCKS after the backend's own exit — no auto-respawn,
	// no process exit, so the pane keeps the exit line readable.
	select {
	case err := <-done:
		t.Fatalf("supervise returned %v after the backend exit, want it to block until signalled", err)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("err = %v, want nil on signal", err)
	}
}

func TestGuiSuperviseLinuxRemovesStaleSocket(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
	})
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)

	// A stale socket from a crashed supervisor must not block the bind.
	sock, err := gui.SocketPath("host")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(sock), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sock, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":13") }()

	waitForGuiLog(t, buf, "gui: Xtigervnc up on :13")
	cancel()
	if err := <-done; err != nil {
		t.Errorf("err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxSocketWaitTimeoutKillsBackend(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	// Backend that never creates the socket.
	stubDir := testutil.StubOnPath(t, "Xtigervnc", "#!/bin/sh\nexec sleep 60\n")
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
	})
	captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	origTimeout, origPoll := guiSocketWaitTimeout, guiSocketWaitPoll
	t.Cleanup(func() { guiSocketWaitTimeout, guiSocketWaitPoll = origTimeout, origPoll })
	guiSocketWaitTimeout = 100 * time.Millisecond
	guiSocketWaitPoll = 10 * time.Millisecond

	sock, err := gui.SocketPath("host")
	if err != nil {
		t.Fatal(err)
	}
	err = runGuiSuperviseCtx(context.Background(), "host", ":14")
	if err == nil || !strings.Contains(err.Error(), "did not create "+sock) {
		t.Errorf("err = %v, want the socket-wait timeout naming %s", err, sock)
	}
}

// --- window-manager resolution, seeding, stamps (R2) ---

// guiWMStartRec records guiSuperviseStartWM calls for one test and starts
// nothing.
type guiWMStartRec struct {
	mu       sync.Mutex
	argv     []string
	display  string
	extraEnv []string
	ownGroup bool
	calls    int
}

func withGuiSuperviseStartWMRec(t *testing.T) *guiWMStartRec {
	t.Helper()
	rec := &guiWMStartRec{}
	orig := guiSuperviseStartWM
	t.Cleanup(func() { guiSuperviseStartWM = orig })
	guiSuperviseStartWM = func(_ context.Context, argv []string, display string, extraEnv []string, ownGroup bool) (*exec.Cmd, error) {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		rec.calls++
		rec.argv = append([]string(nil), argv...)
		rec.display = display
		rec.extraEnv = append([]string(nil), extraEnv...)
		rec.ownGroup = ownGroup
		return nil, nil
	}
	return rec
}

// stampIndex returns the position of the stamp argv carrying option=value, or
// -1.
func stampIndex(stamps [][]string, option, value string) int {
	for i, s := range stamps {
		joined := strings.Join(s, " ")
		if strings.Contains(joined, option+" "+value) {
			return i
		}
	}
	return -1
}

func TestGuiSuperviseLinuxIcewmSeedsStampsAndStarts(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc":           filepath.Join(stubDir, "Xtigervnc"),
		"icewm-session":       "/usr/bin/icewm-session",
		"x-terminal-emulator": "/usr/bin/x-terminal-emulator",
	})
	origStat := guiSuperviseStat
	t.Cleanup(func() { guiSuperviseStat = origStat })
	guiSuperviseStat = func(string) (os.FileInfo, error) { return nil, nil }
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	wmRec := withGuiSuperviseStartWMRec(t)

	type seedCall struct {
		dir, term, browser string
	}
	var seeds []seedCall
	origSeed := guiSuperviseSeed
	t.Cleanup(func() { guiSuperviseSeed = origSeed })
	guiSuperviseSeed = func(dir, terminal, browser string) (bool, error) {
		seeds = append(seeds, seedCall{dir, terminal, browser})
		return true, nil
	}

	profileDir := filepath.Join(stateHome, "hexokit", "gui", "icewm")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":15") }()

	waitForGuiLog(t, buf, "gui: toolbar: terminal=x-terminal-emulator browser=none")
	waitForGuiLog(t, buf, "gui: window manager icewm-session (config "+profileDir+", seeded preferences)")

	if len(seeds) != 1 || seeds[0] != (seedCall{profileDir, "x-terminal-emulator", ""}) {
		t.Errorf("seed calls = %+v, want one (%s, x-terminal-emulator, \"\")", seeds, profileDir)
	}

	got := *stamps
	di, bi, wi := stampIndex(got, "@rk_gui_display", ":15"), stampIndex(got, "@rk_gui_backend", "Xtigervnc"), stampIndex(got, "@rk_gui_wm", "icewm-session")
	if di < 0 || bi < 0 || wi < 0 {
		t.Fatalf("stamps = %v, want display/backend/wm stamps", got)
	}
	if !(di < bi && bi < wi) {
		t.Errorf("stamp order = display@%d backend@%d wm@%d, want display before backend before wm (one burst)", di, bi, wi)
	}

	wmRec.mu.Lock()
	defer wmRec.mu.Unlock()
	if wmRec.calls != 1 {
		t.Fatalf("WM starts = %d, want 1", wmRec.calls)
	}
	if want := []string{"icewm-session", "--nobg", "--notray"}; !reflect.DeepEqual(wmRec.argv, want) {
		t.Errorf("WM argv = %v, want %v", wmRec.argv, want)
	}
	if want := []string{"ICEWM_PRIVCFG=" + profileDir}; !reflect.DeepEqual(wmRec.extraEnv, want) {
		t.Errorf("WM extra env = %v, want %v", wmRec.extraEnv, want)
	}
	if wmRec.ownGroup {
		t.Error("WM ownGroup = true, want false for icewm (direct-child teardown)")
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxIcewmUnseededLogVariant(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc":     filepath.Join(stubDir, "Xtigervnc"),
		"icewm-session": "/usr/bin/icewm-session",
	})
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseStartWMRec(t)

	origSeed := guiSuperviseSeed
	t.Cleanup(func() { guiSuperviseSeed = origSeed })
	guiSuperviseSeed = func(string, string, string) (bool, error) { return false, nil }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":16") }()

	profileDir := filepath.Join(stateHome, "hexokit", "gui", "icewm")
	waitForGuiLog(t, buf, "gui: window manager icewm-session (config "+profileDir+")")
	if strings.Contains(buf.String(), "seeded preferences") {
		t.Errorf("log =\n%s\nwant no seeded suffix when seeded=false", buf.String())
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxNoWMStampsEmptyAndLogsHint(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"apt-get":   "/usr/bin/apt-get",
	})
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	wmRec := withGuiSuperviseStartWMRec(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":17") }()

	waitForGuiLog(t, buf, guiNoWMLine("sudo apt install --no-install-recommends icewm"))
	line := guiNoWMLine("sudo apt install --no-install-recommends icewm")
	if !strings.Contains(line, "tried icewm-session, openbox, xfwm4, i3, kwin_x11, x-session-manager") ||
		!strings.HasSuffix(line, ", then rk gui restart") {
		t.Errorf("no-WM line = %q, want the six-rung ladder and the restart suffix", line)
	}

	got := *stamps
	if i := stampIndex(got, "@rk_gui_wm", ""); i < 0 {
		t.Errorf("stamps = %v, want an @rk_gui_wm \"\" stamp (bare is stamped deliberately)", got)
	} else if joined := strings.Join(got[i], " "); !strings.HasSuffix(joined, "@rk_gui_wm ") && !strings.HasSuffix(joined, "@rk_gui_wm") {
		t.Errorf("wm stamp argv = %v, want the value empty", got[i])
	}

	wmRec.mu.Lock()
	calls := wmRec.calls
	wmRec.mu.Unlock()
	if calls != 0 {
		t.Errorf("WM starts = %d with nothing resolved, want 0 (no ICEWM_PRIVCFG either)", calls)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxPinMissFallsBackToLadder(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"openbox":   "/usr/bin/openbox",
	})
	withGuiSuperviseSettingsLoad(t, "xfwm4", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	wmRec := withGuiSuperviseStartWMRec(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":18") }()

	waitForGuiLog(t, buf, "gui: gui.wm=xfwm4 not on PATH; falling back to the ladder — install icewm with your package manager")
	waitForGuiLog(t, buf, "gui: window manager openbox")

	wmRec.mu.Lock()
	argv, extraEnv := wmRec.argv, wmRec.extraEnv
	wmRec.mu.Unlock()
	if !reflect.DeepEqual(argv, []string{"openbox"}) {
		t.Errorf("WM argv = %v, want [openbox] (the ladder result, not the missed pin)", argv)
	}
	if len(extraEnv) != 0 {
		t.Errorf("WM extra env = %v, want none for a non-icewm rung", extraEnv)
	}
	if wmRec.ownGroup {
		t.Error("WM ownGroup = true, want false for a bare WM (direct-child teardown)")
	}
	if i := stampIndex(*stamps, "@rk_gui_wm", "openbox"); i < 0 {
		t.Errorf("stamps = %v, want @rk_gui_wm openbox", *stamps)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxSessionStarterPinMissNamesDEHint(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"openbox":   "/usr/bin/openbox",
		"apt-get":   "/usr/bin/apt-get",
	})
	withGuiSuperviseSettingsLoad(t, "startlxqt", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	withGuiSuperviseStartWMRec(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":19") }()

	waitForGuiLog(t, buf, "gui: gui.wm=startlxqt not on PATH; falling back to the ladder — sudo apt install --no-install-recommends lxqt-core")
	waitForGuiLog(t, buf, "gui: window manager openbox")

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxSessionStarterResolvesUnderDBus(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc":  filepath.Join(stubDir, "Xtigervnc"),
		"startxfce4": "/usr/bin/startxfce4",
	})
	withGuiSuperviseSettingsLoad(t, "startxfce4", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	stamps := captureGuiStamps(t)
	wmRec := withGuiSuperviseStartWMRec(t)
	seedCalls := 0
	origSeed := guiSuperviseSeedLXQt
	t.Cleanup(func() { guiSuperviseSeedLXQt = origSeed })
	guiSuperviseSeedLXQt = func(string, gui.LaunchResolution) (bool, error) {
		seedCalls++
		return false, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":20") }()

	waitForGuiLog(t, buf, "gui: window manager startxfce4 (session under dbus-run-session)")

	wmRec.mu.Lock()
	argv, extraEnv := wmRec.argv, wmRec.extraEnv
	wmRec.mu.Unlock()
	if want := []string{"dbus-run-session", "--", "startxfce4"}; !reflect.DeepEqual(argv, want) {
		t.Errorf("WM argv = %v, want %v (the dbus wrap)", argv, want)
	}
	if len(extraEnv) != 0 {
		t.Errorf("WM extra env = %v, want none — XFCE is never seeded (LXQt is the one seeded DE)", extraEnv)
	}
	if seedCalls != 0 {
		t.Errorf("LXQt seed calls = %d, want 0 for the xfce rung", seedCalls)
	}
	if !wmRec.ownGroup {
		t.Error("WM ownGroup = false, want true for a session starter (process-group teardown)")
	}
	if i := stampIndex(*stamps, "@rk_gui_wm", "startxfce4"); i < 0 {
		t.Errorf("stamps = %v, want @rk_gui_wm startxfce4", *stamps)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

// withGuiSuperviseSeedLXQtRec swaps the LXQt seed seam for a recorder that
// appends "seed" to events; the WM-start recorder appends "wm", so the test
// proves the seed runs before the WM starts.
func withGuiSuperviseSeedLXQtRec(t *testing.T, events *[]string, mu *sync.Mutex, seeded bool, err error) *int {
	t.Helper()
	calls := new(int)
	orig := guiSuperviseSeedLXQt
	t.Cleanup(func() { guiSuperviseSeedLXQt = orig })
	guiSuperviseSeedLXQt = func(string, gui.LaunchResolution) (bool, error) {
		mu.Lock()
		defer mu.Unlock()
		*calls++
		*events = append(*events, "seed")
		return seeded, err
	}
	return calls
}

// withGuiSuperviseStartWMRecEvents is withGuiSuperviseStartWMRec plus an
// "wm" event appended to the shared ordering log.
func withGuiSuperviseStartWMRecEvents(t *testing.T, events *[]string, mu *sync.Mutex) *guiWMStartRec {
	t.Helper()
	rec := &guiWMStartRec{}
	orig := guiSuperviseStartWM
	t.Cleanup(func() { guiSuperviseStartWM = orig })
	guiSuperviseStartWM = func(_ context.Context, argv []string, display string, extraEnv []string, ownGroup bool) (*exec.Cmd, error) {
		mu.Lock()
		defer mu.Unlock()
		rec.calls++
		rec.argv = append([]string(nil), argv...)
		rec.display = display
		rec.extraEnv = append([]string(nil), extraEnv...)
		rec.ownGroup = ownGroup
		*events = append(*events, "wm")
		return nil, nil
	}
	return rec
}

func TestGuiSuperviseLinuxLxqtSeedsAndSetsConfigDirs(t *testing.T) {
	for i, wmName := range []string{"startlxqt", "lxqt-session"} {
		t.Run(wmName, func(t *testing.T) {
			withGuiSuperviseGOOS(t, "linux")
			stateHome := t.TempDir()
			t.Setenv("XDG_STATE_HOME", stateHome)
			// An empty XDG_CONFIG_DIRS must behave as unset (the /etc/xdg
			// substitution in LXQtConfigDirsEnv).
			t.Setenv("XDG_CONFIG_DIRS", "")
			stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
			withGuiSuperviseLookPath(t, map[string]string{
				"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
				wmName:      "/usr/bin/" + wmName,
			})
			withGuiSuperviseSettingsLoad(t, wmName, gui.GeometryDefault)
			buf := captureGuiSuperviseLog(t)
			captureGuiStamps(t)
			var mu sync.Mutex
			var events []string
			seedCalls := withGuiSuperviseSeedLXQtRec(t, &events, &mu, true, nil)
			wmRec := withGuiSuperviseStartWMRecEvents(t, &events, &mu)

			display := fmt.Sprintf(":%d", 22+i)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- runGuiSuperviseCtx(ctx, "host", display) }()

			defaultsDir := filepath.Join(stateHome, "hexokit", "gui", "lxqt", "etc")
			waitForGuiLog(t, buf, "gui: window manager "+wmName+" (session under dbus-run-session; defaults "+defaultsDir+", seeded)")

			mu.Lock()
			gotEvents := append([]string(nil), events...)
			gotSeedCalls := *seedCalls
			extraEnv, ownGroup, argv := wmRec.extraEnv, wmRec.ownGroup, wmRec.argv
			calls := wmRec.calls
			mu.Unlock()

			if gotSeedCalls != 1 {
				t.Errorf("seed calls = %d, want exactly 1", gotSeedCalls)
			}
			if want := []string{"seed", "wm"}; !reflect.DeepEqual(gotEvents, want) {
				t.Errorf("events = %v, want %v (the seed runs before the WM starts)", gotEvents, want)
			}
			if calls != 1 {
				t.Errorf("WM starts = %d, want 1", calls)
			}
			if want := []string{"dbus-run-session", "--", wmName}; !reflect.DeepEqual(argv, want) {
				t.Errorf("WM argv = %v, want %v", argv, want)
			}
			if want := []string{"XDG_CONFIG_DIRS=" + defaultsDir + ":/etc/xdg"}; !reflect.DeepEqual(extraEnv, want) {
				t.Errorf("extraEnv = %v, want %v", extraEnv, want)
			}
			if !ownGroup {
				t.Error("ownGroup = false, want true for a session starter")
			}

			cancel()
			if err := <-done; err != nil {
				t.Errorf("teardown err = %v, want nil", err)
			}
		})
	}
}

func TestGuiSuperviseLinuxLxqtUnseededLogVariant(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	t.Setenv("XDG_CONFIG_DIRS", "")
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"startlxqt": "/usr/bin/startlxqt",
	})
	withGuiSuperviseSettingsLoad(t, "startlxqt", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	var mu sync.Mutex
	var events []string
	withGuiSuperviseSeedLXQtRec(t, &events, &mu, false, nil)
	wmRec := withGuiSuperviseStartWMRecEvents(t, &events, &mu)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":24") }()

	defaultsDir := filepath.Join(stateHome, "hexokit", "gui", "lxqt", "etc")
	waitForGuiLog(t, buf, "gui: window manager startlxqt (session under dbus-run-session; defaults "+defaultsDir+")")
	if strings.Contains(buf.String(), ", seeded)") {
		t.Errorf("log =\n%s\nwant no seeded suffix when seeded=false", buf.String())
	}
	wmRec.mu.Lock()
	extraEnv := wmRec.extraEnv
	wmRec.mu.Unlock()
	if want := []string{"XDG_CONFIG_DIRS=" + defaultsDir + ":/etc/xdg"}; !reflect.DeepEqual(extraEnv, want) {
		t.Errorf("extraEnv = %v, want %v (the env rides a present seed dir, seeded or not)", extraEnv, want)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxLxqtSeedFailureStartsWithDefaults(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc": filepath.Join(stubDir, "Xtigervnc"),
		"startlxqt": "/usr/bin/startlxqt",
	})
	withGuiSuperviseSettingsLoad(t, "startlxqt", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	var mu sync.Mutex
	var events []string
	withGuiSuperviseSeedLXQtRec(t, &events, &mu, false, os.ErrPermission)
	wmRec := withGuiSuperviseStartWMRecEvents(t, &events, &mu)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":25") }()

	defaultsDir := filepath.Join(stateHome, "hexokit", "gui", "lxqt", "etc")
	waitForGuiLog(t, buf, guiLXQtSeedFailedLine(defaultsDir, "startlxqt", os.ErrPermission))
	waitForGuiLog(t, buf, "gui: window manager startlxqt (session under dbus-run-session)\n")

	wmRec.mu.Lock()
	defer wmRec.mu.Unlock()
	if wmRec.calls != 1 {
		t.Fatalf("WM starts = %d, want 1 (LXQt still runs on its defaults)", wmRec.calls)
	}
	if len(wmRec.extraEnv) != 0 {
		t.Errorf("WM extra env = %v after a seed failure, want none (a failed seed is never handed to LXQt)", wmRec.extraEnv)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}

func TestGuiSuperviseLinuxIcewmSeedFailureStartsWithDefaults(t *testing.T) {
	withGuiSuperviseGOOS(t, "linux")
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stubDir := testutil.StubOnPath(t, "Xtigervnc", guiBackendStubUp)
	withGuiSuperviseLookPath(t, map[string]string{
		"Xtigervnc":     filepath.Join(stubDir, "Xtigervnc"),
		"icewm-session": "/usr/bin/icewm-session",
	})
	withGuiSuperviseSettingsLoad(t, "", gui.GeometryDefault)
	buf := captureGuiSuperviseLog(t)
	captureGuiStamps(t)
	wmRec := withGuiSuperviseStartWMRec(t)
	origSeed := guiSuperviseSeed
	t.Cleanup(func() { guiSuperviseSeed = origSeed })
	guiSuperviseSeed = func(string, string, string) (bool, error) { return false, os.ErrPermission }

	profileDir := filepath.Join(stateHome, "hexokit", "gui", "icewm")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseCtx(ctx, "host", ":16") }()

	waitForGuiLog(t, buf, guiSeedFailedLine(profileDir, os.ErrPermission))
	waitForGuiLog(t, buf, "gui: window manager icewm-session\n")

	wmRec.mu.Lock()
	defer wmRec.mu.Unlock()
	if wmRec.calls != 1 {
		t.Fatalf("WM starts = %d, want 1 (icewm still runs on its defaults)", wmRec.calls)
	}
	if len(wmRec.extraEnv) != 0 {
		t.Errorf("WM extra env = %v after a seed failure, want none (ICEWM_PRIVCFG must not name the failed profile)", wmRec.extraEnv)
	}

	cancel()
	if err := <-done; err != nil {
		t.Errorf("teardown err = %v, want nil", err)
	}
}
