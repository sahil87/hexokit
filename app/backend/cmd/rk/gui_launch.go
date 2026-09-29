package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"rk/internal/gui"

	"github.com/spf13/cobra"
)

// Package seams (the gui.go idiom) so tests drive every branch without an X
// server or a real PATH: the resolved-path stat (the launcher ladders'
// dangling Debian-alternative guard), the detached start, the symlink
// resolution behind the --cdp family check, and the CDP port dial.
var (
	guiStatFn         = os.Stat
	guiLaunchStartFn  = gui.StartDetached
	guiEvalSymlinksFn = filepath.EvalSymlinks
	guiDialFn         = func(ctx context.Context, addr string) error {
		var d net.Dialer
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return err
		}
		return conn.Close()
	}
)

const (
	// guiCDPDefaultPort is the DevTools protocol port --cdp binds unless
	// --port says otherwise.
	guiCDPDefaultPort = 9222
)

var (
	// guiCDPWaitTimeout / guiCDPWaitPoll bound the post-launch wait for the
	// CDP port to accept TCP. Vars so tests shrink them (the
	// guiSocketFreeTimeout idiom).
	guiCDPWaitTimeout = 5 * time.Second
	guiCDPWaitPoll    = 200 * time.Millisecond
)

// guiCDPFamily is the Chromium-family name set --cdp accepts — Playwright's
// connectOverCDP is Chromium-only, and --user-data-dir is a Chromium flag, so
// a Firefox CDP endpoint would serve no documented consumer.
var guiCDPFamily = map[string]bool{
	"chromium":             true,
	"chromium-browser":     true,
	"google-chrome":        true,
	"google-chrome-stable": true,
}

var guiLaunchCmd = &cobra.Command{
	Use:   "launch <terminal|browser>",
	Short: "Open a terminal or browser on the GUI display",
	Long: `Open a terminal or browser on the GUI display — the allowlisted
launcher: the argument is a role, never an arbitrary command (use 'rk gui
exec' for that). The role resolves server-side through a fixed ladder of
known binaries (the first one on PATH wins); the app starts detached on the
rk-gui display with DISPLAY and RK_GUI_SOCKET set and rk returns immediately.

When no binary on the role's ladder is installed, the verb prints the install
line and exits 1. Refuses (exit 1) when the GUI is off or enabled but not
running ('rk gui status' has the reason); on macOS the surface mirrors your
live session view-only, so there is no display to launch on.

'launch browser --cdp [--port 9222]' adds --remote-debugging-port with a
dedicated profile dir (<state>/hexokit/gui/cdp-<N> — the flag takes effect
even when another instance of the browser is already running), waits for the
port, and prints 'cdp http://127.0.0.1:<N>' as a second line: the Playwright
connectOverCDP endpoint. Chromium-family only — a Firefox resolution refuses
(exit 1); --cdp on the terminal role is a usage error (exit 2).`,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runGuiLaunch,
}

func init() {
	guiLaunchCmd.Flags().Bool("cdp", false, "Browser only: open a CDP endpoint (Chromium-family) and print its URL")
	guiLaunchCmd.Flags().Int("port", guiCDPDefaultPort, "CDP port for --cdp")
}

func runGuiLaunch(cmd *cobra.Command, args []string) error {
	if guiGOOS == "darwin" {
		return guiDarwinRefusal("launch")
	}
	ctx, cancel := context.WithTimeout(guiCmdCtx(cmd), 10*time.Second)
	defer cancel()
	st, err := guiRequireReachable(ctx)
	if err != nil {
		return err
	}
	role, err := gui.ParseAppRole(args[0])
	if err != nil {
		return usageError(err)
	}
	cdp, _ := cmd.Flags().GetBool("cdp")
	port, _ := cmd.Flags().GetInt("port")
	if cdp && role != gui.AppBrowser {
		return usageError(errors.New("--cdp applies to the browser role only"))
	}
	if cdp && (port < 1 || port > 65535) {
		return usageError(fmt.Errorf("--port %d is not a valid TCP port", port))
	}
	name, path, ok := gui.ResolveApp(role, guiLookPathFn, guiStatFn)
	if !ok {
		return errors.New(gui.LaunchHint(role, guiLookPathFn))
	}
	argv := []string{path}
	if cdp {
		if !guiCDPChromium(name, path) {
			return fmt.Errorf("--cdp needs a Chromium-family browser (resolved %s)", name)
		}
		dir, derr := gui.StateDir()
		if derr != nil {
			return fmt.Errorf("error: resolving the gui state dir: %w", derr)
		}
		argv = append(argv,
			fmt.Sprintf("--remote-debugging-port=%d", port),
			fmt.Sprintf("--user-data-dir=%s", filepath.Join(dir, fmt.Sprintf("cdp-%d", port))),
		)
	}
	pid, err := guiLaunchStartFn(argv, gui.LaunchEnv(os.Environ(), st.Display, st.Socket))
	if err != nil {
		return fmt.Errorf("error: %s: %w", name, err)
	}
	sink := newSink(cmd)
	sink.Dataf("started %s (pid %d) on %s\n", name, pid, st.Display)
	if !cdp {
		return nil
	}
	if err := guiWaitCDPPort(ctx, port); err != nil {
		return fmt.Errorf("cdp port %d did not open within %s (browser pid %d is running)", port, guiCDPWaitTimeout, pid)
	}
	sink.Dataf("cdp http://127.0.0.1:%d\n", port)
	return nil
}

// guiCDPChromium reports whether the resolved ladder entry is Chromium-family:
// by name, or — for the x-www-browser alternative — by the basename of its
// symlink target.
func guiCDPChromium(name, path string) bool {
	if guiCDPFamily[name] {
		return true
	}
	if name != "x-www-browser" {
		return false
	}
	resolved, err := guiEvalSymlinksFn(path)
	if err != nil {
		return false
	}
	return guiCDPFamily[filepath.Base(resolved)]
}

// guiWaitCDPPort polls 127.0.0.1:<port> until it accepts TCP, the budget
// expires, or ctx is canceled — the poll sleep is a select so an interrupt
// returns at once instead of running out the remaining budget.
func guiWaitCDPPort(ctx context.Context, port int) error {
	deadline := time.Now().Add(guiCDPWaitTimeout)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	for {
		if err := guiDialFn(ctx, addr); err == nil {
			return nil
		}
		if !time.Now().Before(deadline) {
			return errors.New("timeout")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(guiCDPWaitPoll):
		}
	}
}
