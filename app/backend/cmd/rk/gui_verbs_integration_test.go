//go:build linux

package main

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"rk/internal/gui"
	"rk/internal/settings"
)

// TestGuiVerbsIntegration drives the G3 agent verbs end-to-end on a
// THROWAWAY display (gui.FreeDisplay(90), temp socket, temp ICEWM_PRIVCFG) —
// never the live rk-gui session: real Xtigervnc + icewm-session + xterm,
// real xdotool through the production guiXdoRunFn, real capture ladder.
// Skipped unless all three tools resolve. Every spawned process is SIGTERM'd
// then SIGKILLed on cleanup.
func TestGuiVerbsIntegration(t *testing.T) {
	for _, bin := range []string{"Xtigervnc", "xdotool", "icewm-session", "xterm"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}

	n, err := gui.FreeDisplay(90)
	if err != nil {
		t.Fatalf("no free display: %v", err)
	}
	display := fmt.Sprintf(":%d", n)
	t.Cleanup(func() {
		_ = os.Remove(fmt.Sprintf("/tmp/.X%d-lock", n))
		_ = os.Remove(filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", n)))
	})

	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	// Process tracking: every child is killed (TERM, then KILL) at teardown.
	var procs []*exec.Cmd
	start := func(argv []string, extraEnv ...string) {
		t.Helper()
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Env = append(os.Environ(), append([]string{"DISPLAY=" + display}, extraEnv...)...)
		if err := cmd.Start(); err != nil {
			t.Fatalf("start %v: %v", argv, err)
		}
		procs = append(procs, cmd)
	}
	t.Cleanup(func() {
		for _, cmd := range procs {
			_ = cmd.Process.Signal(syscall.SIGTERM)
		}
		deadline := time.Now().Add(3 * time.Second)
		for _, cmd := range procs {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-done:
			case <-time.After(time.Until(deadline)):
			}
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	// The backend on a temp socket; the WM on rk's seeded preferences (meters
	// off — a ticking taskbar clock would keep wait --stable from converging).
	dir := filepath.Join(stateHome, "hexokit", "gui")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "host.sock")
	bin, _ := gui.ResolveBackend(exec.LookPath)
	start(gui.BackendArgv(bin, display, sock, gui.GeometryDefault))
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("backend did not bind %s within 10s", sock)
		}
		time.Sleep(100 * time.Millisecond)
	}
	profileDir := filepath.Join(dir, "icewm")
	if _, err := gui.SeedProfile(profileDir, "xterm", ""); err != nil {
		t.Fatalf("seed icewm profile: %v", err)
	}
	// The rig's desktop must be pixel-quiet for wait --stable: the seeded
	// profile keeps a minute-resolution clock, which still flips once a minute
	// and could race a capture pair, so the rig hides it outright.
	pf, err := os.OpenFile(filepath.Join(profileDir, "preferences"), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open preferences: %v", err)
	}
	if _, err := pf.WriteString("TaskBarShowClock=0\n"); err != nil {
		t.Fatalf("append preferences: %v", err)
	}
	pf.Close()
	start([]string{"icewm-session", "--nobg", "--notray"}, "ICEWM_PRIVCFG="+profileDir)

	// The verb seams point at the throwaway display: the gate assembles a
	// reachable status for it, tool probes and runners are the real ones, and
	// the guard's daemon fetch fails open (no daemon in this rig).
	withGuiCLISeams(t)
	seedGuiOn(t)
	guiSessionOptionsFn = func(context.Context) (string, string, string, bool) {
		return display, bin, "icewm-session", true
	}
	guiLookPathFn = exec.LookPath
	guiShotLookPathFn = exec.LookPath

	ctx := context.Background()

	// Launch xterm with a pinned title, a non-blinking cursor (a blinking
	// cursor would keep wait --stable from ever converging), and a
	// non-interactive payload — an interactive shell's prompt would overwrite
	// the title with the cwd.
	start([]string{"xterm", "-T", "rkinteg", "+bc", "-e", "sh", "-c", "sleep 300"})
	var xtermWin *gui.Window
	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		windows, err := guiCollectWindows(ctx, display)
		if err != nil {
			t.Fatalf("collect windows: %v", err)
		}
		for i, w := range windows {
			if strings.Contains(w.Title, "rkinteg") {
				xtermWin = &windows[i]
			}
		}
		if xtermWin != nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if xtermWin == nil {
		windows, _ := guiCollectWindows(ctx, display)
		t.Fatalf("xterm never appeared in the window inventory; last scan: %+v", windows)
	}
	if xtermWin.PID == 0 {
		t.Errorf("xterm row pid = 0, want a resolved _NET_WM_PID")
	}
	if xtermWin.Width == 0 || xtermWin.Height == 0 {
		t.Errorf("xterm row geometry = %+v, want non-zero", xtermWin)
	}

	// focus --title, then type + key into the focused xterm.
	focusCmd := bareCmd(&bytes.Buffer{}, &bytes.Buffer{})
	focusCmd.Flags().String("title", "", "")
	focusCmd.Flags().Bool("force", false, "")
	_ = focusCmd.Flags().Set("title", "rkinteg")
	if err := runGuiFocus(focusCmd, nil); err != nil {
		t.Fatalf("focus --title rkinteg: %v", err)
	}

	typeCmd := bareCmd(&bytes.Buffer{}, &bytes.Buffer{})
	typeCmd.Flags().Bool("stdin", false, "")
	typeCmd.Flags().Bool("force", false, "")
	if err := runGuiType(typeCmd, []string{"echo hi"}); err != nil {
		t.Fatalf("type: %v", err)
	}
	keyCmd := bareCmd(&bytes.Buffer{}, &bytes.Buffer{})
	keyCmd.Flags().Bool("force", false, "")
	if err := runGuiKey(keyCmd, []string{"Return"}); err != nil {
		t.Fatalf("key Return: %v", err)
	}

	// wait --stable converges on the settled desktop.
	waitCmd := bareCmd(&bytes.Buffer{}, &bytes.Buffer{})
	waitCmd.Flags().String("window", "", "")
	waitCmd.Flags().Bool("stable", false, "")
	waitCmd.Flags().Duration("timeout", 10*time.Second, "")
	waitCmd.Flags().Duration("interval", 500*time.Millisecond, "")
	_ = waitCmd.Flags().Set("stable", "true")
	if err := runGuiWait(waitCmd, nil); err != nil {
		t.Fatalf("wait --stable: %v", err)
	}

	// shot --scale 0.5 --window <id> yields a PNG half the window's size.
	out := filepath.Join(t.TempDir(), "win.png")
	shotCmd := bareCmd(&bytes.Buffer{}, &bytes.Buffer{})
	shotCmd.Flags().StringP("out", "o", "", "")
	shotCmd.Flags().Float64("scale", 0, "")
	shotCmd.Flags().Int("max-width", 0, "")
	shotCmd.Flags().Uint64("window", 0, "")
	_ = shotCmd.Flags().Set("out", out)
	_ = shotCmd.Flags().Set("scale", "0.5")
	_ = shotCmd.Flags().Set("window", strconv.FormatUint(xtermWin.ID, 10))
	if err := runGuiShot(shotCmd, nil); err != nil {
		t.Fatalf("shot --scale 0.5 --window %d: %v", xtermWin.ID, err)
	}
	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatalf("decode %s: %v", out, err)
	}
	wantW := int(math.Round(float64(xtermWin.Width) * 0.5))
	wantH := int(math.Round(float64(xtermWin.Height) * 0.5))
	if got := img.Bounds().Size(); got.X != wantW || got.Y != wantH {
		t.Errorf("scaled PNG = %dx%d, want %dx%d (half of %dx%d)", got.X, got.Y, wantW, wantH, xtermWin.Width, xtermWin.Height)
	}
}
