//go:build linux

package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"rk/internal/daemon"
	"rk/internal/gui"
	"rk/internal/settings"
)

// guiIntegStamps is a mutex-guarded guiSuperviseTmuxRun recorder. The
// integration run drives the real supervisor (real Xtigervnc, real
// icewm-session), so this seam swap is load-bearing: no tmux command may ever
// be sent — the live rk-gui session and the rk-daemon socket are off-limits.
type guiIntegStamps struct {
	mu   sync.Mutex
	args [][]string
}

func (r *guiIntegStamps) run(_ context.Context, args ...string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.args = append(r.args, append([]string(nil), args...))
	return nil
}

// stampValue returns the value recorded for one option, ok=false when no stamp
// for it has landed yet.
func (r *guiIntegStamps) stampValue(option string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, a := range r.args {
		for i, v := range a {
			if v == option && i+1 < len(a) {
				return a[i+1], true
			}
		}
	}
	return "", false
}

type guiIntegProc struct {
	pid  int
	ppid int
	comm string
}

// procsOnDisplay scans /proc for processes whose environ carries
// DISPLAY=<display> as an exact entry and whose comm starts with prefix (""
// matches all). Vanished or unreadable pids are skipped — the scan races the
// process table by nature.
func procsOnDisplay(display, prefix string) []guiIntegProc {
	want := []byte("DISPLAY=" + display)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []guiIntegProc
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		env, err := os.ReadFile(filepath.Join("/proc", e.Name(), "environ"))
		if err != nil {
			continue
		}
		found := false
		for _, entry := range bytes.Split(env, []byte{0}) {
			if bytes.Equal(entry, want) {
				found = true
				break
			}
		}
		if !found {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "comm"))
		if err != nil {
			continue
		}
		comm := strings.TrimSpace(string(raw))
		if prefix != "" && !strings.HasPrefix(comm, prefix) {
			continue
		}
		out = append(out, guiIntegProc{pid: pid, ppid: procPpid(pid), comm: comm})
	}
	return out
}

// procPpid reads the parent pid out of /proc/<pid>/stat (the ppid field
// follows the parenthesized comm, which may itself contain spaces).
func procPpid(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return -1
	}
	s := string(data)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return -1
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 2 {
		return -1
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return -1
	}
	return ppid
}

// xtigervncOnDisplay scans /proc cmdlines for an Xtigervnc serving display
// (the display is argv[1] in BackendArgv; the server carries no DISPLAY env).
func xtigervncOnDisplay(display string) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		fields := strings.Split(string(data), "\x00")
		if len(fields) >= 2 && filepath.Base(fields[0]) == "Xtigervnc" && fields[1] == display {
			pids = append(pids, pid)
		}
	}
	return pids
}

// TestGuiSuperviseLxqtIntegration runs runGuiSuperviseLinux for real with an
// LXQt session starter — real Xtigervnc on a high display, real startlxqt
// under dbus-run-session — and proves the seeded rung end-to-end: the
// @rk_gui_wm stamp, the five seed files at 0600 under the XDG_CONFIG_DIRS
// dir, lxqt-panel and pcmanfm-qt on the display, an empty RunningApps (the
// widened wmHelperComms), the seeded #3b4252 desktop with a rendered bottom
// panel in a root screenshot, and clean teardown with no DISPLAY=:N or
// Xtigervnc survivor. Capability-gated on the four binaries. The temp XDG
// homes are load-bearing: the WM inherits os.Environ(), so they keep LXQt's
// first-start writes and startlxqt's mkdir -p "$XDG_DESKTOP_DIR" out of the
// real home.
func TestGuiSuperviseLxqtIntegration(t *testing.T) {
	for _, bin := range []string{"Xtigervnc", "dbus-run-session", "import"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
	lxqtName := ""
	for _, bin := range []string{"startlxqt", "lxqt-session"} {
		if _, err := exec.LookPath(bin); err == nil {
			lxqtName = bin
			break
		}
	}
	if lxqtName == "" {
		t.Skip("neither startlxqt nor lxqt-session on PATH")
	}

	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	// LXQt's first-start writes (liblxqt __userfile__ stubs, the panel's own
	// panel1 block, globalkeyshortcuts.conf) and startlxqt's
	// mkdir -p "$XDG_DESKTOP_DIR" must never touch the real home.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_DESKTOP_DIR", t.TempDir())

	n, err := gui.FreeDisplay(90)
	if err != nil {
		t.Fatalf("no free display: %v", err)
	}
	display := fmt.Sprintf(":%d", n)
	// A SIGKILLed X server leaks its claim artifacts; a stale lock would poison
	// later FreeDisplay probes.
	t.Cleanup(func() {
		_ = os.Remove(fmt.Sprintf("/tmp/.X%d-lock", n))
		_ = os.Remove(filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", n)))
	})

	withGuiSuperviseSettingsLoad(t, lxqtName, gui.GeometryDefault)
	stamps := &guiIntegStamps{}
	origTmux := guiSuperviseTmuxRun
	t.Cleanup(func() { guiSuperviseTmuxRun = origTmux })
	guiSuperviseTmuxRun = stamps.run
	buf := captureGuiSuperviseLog(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseLinux(ctx, "host", display) }()

	// The stamps land in one burst after the backend socket is up; a supervisor
	// that returns early has failed before the assertion point.
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, ok := stamps.stampValue(daemon.GUIOptionWM); ok {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("supervisor exited before stamping: %v\nlog:\n%s", err, buf.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("no @rk_gui_wm stamp within 15s\nlog:\n%s", buf.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if wm, _ := stamps.stampValue(daemon.GUIOptionWM); wm != lxqtName {
		t.Errorf("@rk_gui_wm = %q, want %s (the pinned LXQt name)", wm, lxqtName)
	}

	defaultsDir := filepath.Join(stateHome, "hexokit", "gui", "lxqt", "etc")
	for _, rel := range []string{
		"lxqt/session.conf",
		"lxqt/panel.conf",
		"lxqt/lxqt.conf",
		"pcmanfm-qt/lxqt/settings.conf",
		"autostart/lxqt-xscreensaver-autostart.desktop",
	} {
		info, err := os.Stat(filepath.Join(defaultsDir, filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("seed file %s: %v", rel, err)
			continue
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", rel, info.Mode().Perm())
		}
	}

	// The session is up once the panel and the desktop manager hold the
	// display; the seeded panel is what the screenshot check below proves.
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if len(procsOnDisplay(display, "lxqt-panel")) > 0 && len(procsOnDisplay(display, "pcmanfm-qt")) > 0 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("supervisor exited before the session came up: %v\nlog:\n%s", err, buf.String())
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}
	if procs := procsOnDisplay(display, "lxqt-panel"); len(procs) == 0 {
		t.Fatalf("no lxqt-panel process on %s within 15s\nlog:\n%s", display, buf.String())
	}
	if procs := procsOnDisplay(display, "pcmanfm-qt"); len(procs) == 0 {
		t.Fatalf("no pcmanfm-qt process on %s within 15s\nlog:\n%s", display, buf.String())
	}

	apps, err := gui.RunningApps("/proc", display, nil)
	if err != nil {
		t.Fatalf("RunningApps: %v", err)
	}
	// Settle window: host XDG autostart entries (snap userd on snapd hosts)
	// launch one-shot processes that carry DISPLAY and linger a few seconds;
	// the assertion holds once the session has settled.
	deadline = time.Now().Add(5 * time.Second)
	for len(apps) != 0 && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		if apps, err = gui.RunningApps("/proc", display, nil); err != nil {
			t.Fatalf("RunningApps: %v", err)
		}
	}
	if len(apps) != 0 {
		t.Errorf("RunningApps = %+v with the LXQt session on %s, want empty (helpers excluded by name, no pid excludes)", apps, display)
	}

	// The seeded look: pcmanfm-qt paints the solid #3b4252 desktop (the
	// xsetroot ground alone would pass the centre check, so the bottom-band
	// pixel is what proves the seeded panel rendered). The panel paints after
	// its process appears, so the capture retries until it shows.
	shot := filepath.Join(t.TempDir(), "root.png")
	ground := [3]uint32{0x3b, 0x42, 0x52}
	nearGround := func(x, y int, img image.Image) bool {
		r, g, b, _ := img.At(x, y).RGBA()
		d := func(a, b uint32) uint32 {
			if a > b {
				return a - b
			}
			return b - a
		}
		return d(r>>8, ground[0]) <= 8 && d(g>>8, ground[1]) <= 8 && d(b>>8, ground[2]) <= 8
	}
	var img image.Image
	deadline = time.Now().Add(10 * time.Second)
	for {
		shotCtx, shotCancel := context.WithTimeout(context.Background(), 15*time.Second)
		out, err := exec.CommandContext(shotCtx, "import", "-display", display, "-window", "root", shot).CombinedOutput()
		shotCancel()
		if err != nil {
			t.Fatalf("import -window root: %v (%s)", err, out)
		}
		f, err := os.Open(shot)
		if err != nil {
			t.Fatal(err)
		}
		img, err = png.Decode(f)
		_ = f.Close()
		if err != nil {
			t.Fatalf("decoding the root capture: %v", err)
		}
		bounds := img.Bounds()
		if !nearGround(bounds.Dx()/2, bounds.Dy()-16, img) {
			break
		}
		if time.Now().After(deadline) {
			r, g, b, _ := img.At(bounds.Dx()/2, bounds.Dy()-16).RGBA()
			t.Fatalf("bottom-panel pixel = #%02x%02x%02x after 10s, want it to differ from the #3b4252 ground (the seeded 32px bottom panel)", r>>8, g>>8, b>>8)
		}
		time.Sleep(250 * time.Millisecond)
	}
	bounds := img.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if r, g, b, _ := img.At(w/2, h/2).RGBA(); !nearGround(w/2, h/2, img) {
		t.Errorf("centre pixel = #%02x%02x%02x, want #3b4252 ±8 per channel (pcmanfm-qt WallpaperMode=none BgColor)", r>>8, g>>8, b>>8)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("teardown err = %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("supervisor did not return within 10s of cancel")
	}

	// No process may outlive the supervisor: the process-group teardown takes
	// the session down with it; the settle window is part of the check.
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(procsOnDisplay(display, "")) == 0 && len(xtigervncOnDisplay(display)) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	if procs := procsOnDisplay(display, ""); len(procs) > 0 {
		t.Errorf("processes survived teardown on %s: %+v", display, procs)
	}
	if pids := xtigervncOnDisplay(display); len(pids) > 0 {
		t.Errorf("Xtigervnc survived teardown on %s: pids %v", display, pids)
	}
}
// Xtigervnc on a high display, real icewm-session with the seeded profile as
// ICEWM_PRIVCFG — and proves the rung end-to-end: the @rk_gui_wm stamp, the
// 0600 profile files, WM helpers excluded from RunningApps by name, and clean
// teardown with no icewm*/Xtigervnc survivor. Capability-gated on both
// binaries. The startup/shutdown probe scripts double as the ICEWM_PRIVCFG
// relocation check: if icewm-session never runs the private startup script,
// the icewm rung's argv needs explicit --config flags instead of the env var.
func TestGuiSuperviseIcewmIntegration(t *testing.T) {
	for _, bin := range []string{"Xtigervnc", "icewm-session"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}

	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	// An empty config dir keeps the gui.wm pin unset without reading the real
	// config file.
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	n, err := gui.FreeDisplay(90)
	if err != nil {
		t.Fatalf("no free display: %v", err)
	}
	display := fmt.Sprintf(":%d", n)
	// A SIGKILLed X server leaks its claim artifacts; a stale lock would poison
	// later FreeDisplay probes.
	t.Cleanup(func() {
		_ = os.Remove(fmt.Sprintf("/tmp/.X%d-lock", n))
		_ = os.Remove(filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", n)))
	})

	// Probe scripts land before the supervisor seeds — SeedProfile never
	// removes foreign files from the profile dir.
	profileDir := filepath.Join(stateHome, "hexokit", "gui", "icewm")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	markerDir := t.TempDir()
	startupMarker := filepath.Join(markerDir, "startup-privcfg")
	shutdownMarker := filepath.Join(markerDir, "shutdown-privcfg")
	writeProbe := func(name, marker string) {
		script := fmt.Sprintf("#!/bin/sh\nprintf '%%s' \"$ICEWM_PRIVCFG\" > %s\n", marker)
		if err := os.WriteFile(filepath.Join(profileDir, name), []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeProbe("startup", startupMarker)
	writeProbe("shutdown", shutdownMarker)

	stamps := &guiIntegStamps{}
	origTmux := guiSuperviseTmuxRun
	t.Cleanup(func() { guiSuperviseTmuxRun = origTmux })
	guiSuperviseTmuxRun = stamps.run
	buf := captureGuiSuperviseLog(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runGuiSuperviseLinux(ctx, "host", display) }()

	// The stamps land in one burst after the backend socket is up; a supervisor
	// that returns early has failed before the assertion point.
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, ok := stamps.stampValue(daemon.GUIOptionWM); ok {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("supervisor exited before stamping: %v\nlog:\n%s", err, buf.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("no @rk_gui_wm stamp within 15s\nlog:\n%s", buf.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if wm, _ := stamps.stampValue(daemon.GUIOptionWM); wm != "icewm-session" {
		t.Errorf("@rk_gui_wm = %q, want icewm-session", wm)
	}

	for _, f := range []string{"preferences", "toolbar", "menu"} {
		info, err := os.Stat(filepath.Join(profileDir, f))
		if err != nil {
			t.Errorf("profile file %s: %v", f, err)
			continue
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", f, info.Mode().Perm())
		}
	}

	// The private startup script runs before icewm comes up; its absence after
	// the WM is running means ICEWM_PRIVCFG is not the one config home.
	deadline = time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(startupMarker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("icewm-session never ran %s/startup — ICEWM_PRIVCFG not honored for the session scripts; the icewm rung needs explicit --config flags\nlog:\n%s", profileDir, buf.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if data, err := os.ReadFile(startupMarker); err != nil || string(data) != profileDir {
		t.Errorf("startup script saw ICEWM_PRIVCFG=%q (%v), want %q", data, err, profileDir)
	}

	// The WM is up once an icewm* process holds the display.
	deadline = time.Now().Add(10 * time.Second)
	var icewmProcs []guiIntegProc
	for time.Now().Before(deadline) {
		if icewmProcs = procsOnDisplay(display, "icewm"); len(icewmProcs) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(icewmProcs) == 0 {
		t.Fatalf("no icewm* process on %s within 10s\nlog:\n%s", display, buf.String())
	}
	for _, p := range icewmProcs {
		t.Logf("icewm proc on %s: pid=%d ppid=%d comm=%s", display, p.pid, p.ppid, p.comm)
	}
	apps, err := gui.RunningApps("/proc", display, nil)
	if err != nil {
		t.Fatalf("RunningApps: %v", err)
	}
	if len(apps) != 0 {
		t.Errorf("RunningApps = %+v with icewm running on %s, want empty (helpers excluded by name, no pid excludes)", apps, display)
	}

	// Shutdown probe: SIGTERMing icewm is a graceful session exit, the only
	// path that can run the shutdown script — the supervisor's own teardown
	// SIGKILLs the WM. Observation only; the startup marker above is the
	// load-bearing proof.
	icewmPid := -1
	for _, p := range icewmProcs {
		if p.comm == "icewm" {
			icewmPid = p.pid
		}
	}
	if icewmPid > 0 {
		if err := syscall.Kill(icewmPid, syscall.SIGTERM); err != nil {
			t.Logf("SIGTERM icewm (pid %d): %v", icewmPid, err)
		} else {
			deadline = time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(shutdownMarker); err == nil {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
			if _, err := os.Stat(shutdownMarker); err == nil {
				t.Logf("ICEWM_PRIVCFG relocates shutdown too: the script ran on a graceful icewm exit")
			} else {
				t.Logf("shutdown script did not run on a graceful icewm exit — shutdown relocation unconfirmed")
			}
		}
	} else {
		t.Logf("no standalone icewm process found (procs: %+v) — shutdown probe skipped", icewmProcs)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("teardown err = %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("supervisor did not return within 10s of cancel")
	}

	// No process may outlive the supervisor: icewm* clients exit with their X
	// server, so the settle window is part of the check.
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(procsOnDisplay(display, "icewm")) == 0 && len(xtigervncOnDisplay(display)) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	if procs := procsOnDisplay(display, "icewm"); len(procs) > 0 {
		t.Errorf("icewm* processes survived teardown on %s: %+v", display, procs)
	}
	if pids := xtigervncOnDisplay(display); len(pids) > 0 {
		t.Errorf("Xtigervnc survived teardown on %s: pids %v", display, pids)
	}
}
