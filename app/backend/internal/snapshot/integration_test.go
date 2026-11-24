package snapshot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

// tmuxCmd runs one tmux command against the isolated test socket.
func tmuxCmd(t *testing.T, socket string, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	full := append([]string{"-L", socket}, args...)
	if out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput(); err != nil {
		t.Fatalf("tmux %v: %v\n%s", args, err, out)
	}
}

// waitServerDead blocks until the killed server's socket stops answering.
// kill-server returns before the server process exits and unlinks its socket,
// and a client connecting mid-teardown reports "server exited unexpectedly" —
// so a Restore (or capture) issued immediately after kill-server races the
// death throes on a loaded box (the CI flake this guards against).
func waitServerDead(t *testing.T, socket string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("tmux", "-L", socket, "list-sessions").CombinedOutput()
		if err != nil && !strings.Contains(string(out), "server exited unexpectedly") {
			return // dead-socket error: no server running / failed to connect / ENOENT
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("server %s still answering 5s after kill-server", socket)
}

// TestCaptureRestoreRoundTripLiveTmux is the end-to-end proof over a real
// tmux server: build a layout on an isolated rk-test-* socket, capture it,
// kill the server, restore from the snapshot, re-capture, and compare the
// structural content (session names, window indexes/names, pane counts and
// cwds, rk options). Uses the rk-test-* namespace so leaked servers are
// covered by the standard test-socket reaping.
func TestCaptureRestoreRoundTripLiveTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	socket := fmt.Sprintf("rk-test-snaproundtrip-%d-%d", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
		// kill-server can leave the dead socket file behind; remove it so
		// repeated runs don't accumulate residue in /tmp/tmux-<uid>/.
		_ = os.Remove(fmt.Sprintf("/tmp/tmux-%d/%s", os.Getuid(), socket))
	})

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	tmpCwd := t.TempDir()

	// Layout: session alpha (2 windows, one split), session beta (1 window),
	// plus rk options.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", socket,
		"new-session", "-d", "-s", "alpha", "-n", "serve", "-c", home, "-x", "120", "-y", "40").CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server: %v\n%s", err, out)
	}
	tmuxCmd(t, socket, "set-option", "-g", "exit-empty", "off")
	tmuxCmd(t, socket, "new-window", "-d", "-t", "=alpha:", "-n", "agent", "-c", tmpCwd)
	tmuxCmd(t, socket, "split-window", "-d", "-t", "=alpha:agent", "-c", home)
	tmuxCmd(t, socket, "new-session", "-d", "-s", "beta", "-n", "b", "-c", home, "-x", "120", "-y", "40")
	tmuxCmd(t, socket, "set-option", "-t", "=alpha:", "@rk_ses_color", "4")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_marker", "manual:1")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_role", "operator")
	// A full web-tab family: 3 dense tabs, roots on 1 and 3, active=2, layout
	// and code root — the round trip must reproduce it identically.
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_layout", "split-h:tty,web")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_1", "/proxy/1/")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_1_root", "/r1")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_2", "/present/@9/2/a.html?server=s&v=1")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_3", "https://x/")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_3_root", "/r3")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_web_active", "2")
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=alpha:agent", "@rk_win_code_root", "/w")
	tmuxCmd(t, socket, "set-option", "-s", "@rk_srv_rank", "7")
	tmuxCmd(t, socket, "set-option", "-t", "=alpha:", "@rk_ses_agent_preset", "codex-review")
	tmuxCmd(t, socket, "set-option", "-s", "@rk_srv_agent_preset", "claude")

	before, err := CaptureServer(context.Background(), socket)
	if err != nil {
		t.Fatalf("capture before: %v", err)
	}
	if before.SessionCount() != 2 || before.WindowCount() != 3 {
		t.Fatalf("before counts: %d sessions / %d windows\n%+v",
			before.SessionCount(), before.WindowCount(), before)
	}

	if before.ServerAgentPreset != "claude" || before.Sessions[0].AgentPreset != "codex-review" {
		t.Fatalf("capture missed the agent presets: server %q, alpha %q", before.ServerAgentPreset, before.Sessions[0].AgentPreset)
	}

	tmuxCmd(t, socket, "kill-server")
	waitServerDead(t, socket)

	// Dead server: capture must error, not read as empty.
	if _, err := CaptureServer(context.Background(), socket); err == nil {
		t.Fatal("capture of dead server must error")
	}

	report, err := Restore(context.Background(), socket, before)
	if err != nil {
		t.Fatalf("restore: %v\nreport: %+v", err, report)
	}
	if len(report.Skipped) != 0 {
		t.Errorf("restore skipped: %v", report.Skipped)
	}

	after, err := CaptureServer(context.Background(), socket)
	if err != nil {
		t.Fatalf("capture after: %v", err)
	}

	// Structural comparison (ids/timestamps/layout checksums legitimately
	// differ across the round trip).
	if after.SessionCount() != 2 || after.WindowCount() != 3 {
		t.Fatalf("after counts: %d sessions / %d windows\n%+v",
			after.SessionCount(), after.WindowCount(), after)
	}
	if after.ServerRank == nil || *after.ServerRank != 7 {
		t.Errorf("server rank after restore = %v, want 7", after.ServerRank)
	}
	if after.ServerAgentPreset != "claude" {
		t.Errorf("server agent preset after restore = %q, want claude", after.ServerAgentPreset)
	}
	for si, sess := range before.Sessions {
		got := after.Sessions[si]
		if got.Name != sess.Name {
			t.Errorf("session[%d] = %q, want %q", si, got.Name, sess.Name)
			continue
		}
		if got.Color != sess.Color {
			t.Errorf("session %s color = %q, want %q", sess.Name, got.Color, sess.Color)
		}
		if got.AgentPreset != sess.AgentPreset {
			t.Errorf("session %s agent preset = %q, want %q", sess.Name, got.AgentPreset, sess.AgentPreset)
		}
		if len(got.Windows) != len(sess.Windows) {
			t.Errorf("session %s windows = %d, want %d", sess.Name, len(got.Windows), len(sess.Windows))
			continue
		}
		for wi, win := range sess.Windows {
			gw := got.Windows[wi]
			if gw.Index != win.Index || gw.Name != win.Name {
				t.Errorf("session %s window[%d] = (%d,%q), want (%d,%q)",
					sess.Name, wi, gw.Index, gw.Name, win.Index, win.Name)
			}
			if gw.Marker != win.Marker {
				t.Errorf("window %s marker = %q, want %q", win.Name, gw.Marker, win.Marker)
			}
			if gw.Role != win.Role {
				t.Errorf("window %s role = %q, want %q", win.Name, gw.Role, win.Role)
			}
			if gw.RkLayout != win.RkLayout {
				t.Errorf("window %s rkLayout = %q, want %q", win.Name, gw.RkLayout, win.RkLayout)
			}
			if !slices.Equal(gw.WebTabs, win.WebTabs) {
				t.Errorf("window %s webTabs = %v, want %v", win.Name, gw.WebTabs, win.WebTabs)
			}
			if !slices.Equal(gw.WebRoots, win.WebRoots) {
				t.Errorf("window %s webRoots = %v, want %v", win.Name, gw.WebRoots, win.WebRoots)
			}
			if gw.WebActive != win.WebActive {
				t.Errorf("window %s webActive = %d, want %d", win.Name, gw.WebActive, win.WebActive)
			}
			if gw.CodeRoot != win.CodeRoot {
				t.Errorf("window %s codeRoot = %q, want %q", win.Name, gw.CodeRoot, win.CodeRoot)
			}
			if len(gw.Panes) != len(win.Panes) {
				t.Errorf("window %s panes = %d, want %d", win.Name, len(gw.Panes), len(win.Panes))
				continue
			}
			for pi, pane := range win.Panes {
				if gw.Panes[pi].Cwd != pane.Cwd {
					t.Errorf("window %s pane[%d] cwd = %q, want %q",
						win.Name, pi, gw.Panes[pi].Cwd, pane.Cwd)
				}
			}
		}
	}

	// The restored window carries the renamed (scope-prefixed) option names
	// only — restore writes the new names, never the legacy literals.
	optsOut, optsErr := exec.CommandContext(ctx, "tmux", "-L", socket,
		"show-options", "-w", "-t", "=alpha:agent").CombinedOutput()
	if optsErr != nil {
		t.Fatalf("show restored window options: %v\n%s", optsErr, optsOut)
	}
	opts := string(optsOut)
	for _, want := range []string{"@rk_win_role operator", "@rk_win_marker manual:1",
		"@rk_win_layout split-h:tty,web", "@rk_win_web_1 /proxy/1/", "@rk_win_web_1_root /r1",
		"@rk_win_web_2 /present/@9/2/a.html?server=s&v=1", "@rk_win_web_3 https://x/",
		"@rk_win_web_3_root /r3", "@rk_win_web_active 2", "@rk_win_code_root /w"} {
		if !strings.Contains(opts, want) {
			t.Errorf("restored window options missing %q:\n%s", want, opts)
		}
	}
	for _, legacy := range []string{"@rk_role", "@rk_marker"} {
		if strings.Contains(opts, legacy) {
			t.Errorf("restored window options carry the legacy literal %q:\n%s", legacy, opts)
		}
	}
}

// TestOperatorPromotionRoundTripLiveTmux proves a snapshot taken with a
// PROMOTED operator (the window physically moved into `_rk-operator`, the
// content-hidden home) restores the `_rk-operator` session containing the
// window with its `@rk_win_role=operator` option — the restored state is
// hidden+pinned, not a visible stray. Capture is session-generic (no pin-style
// session filtering) and restore re-applies `@rk_win_role` per window
// (restore.go), so the round trip is the load-bearing behavior.
func TestOperatorPromotionRoundTripLiveTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	socket := fmt.Sprintf("rk-test-snapoperator-%d-%d", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
		_ = os.Remove(fmt.Sprintf("/tmp/tmux-%d/%s", os.Getuid(), socket))
	})

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}

	// Layout: a work session with a shell + the operator window, and the
	// operator window physically promoted into `_rk-operator`.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", socket,
		"new-session", "-d", "-s", "work", "-n", "shell", "-c", home, "-x", "120", "-y", "40").CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server: %v\n%s", err, out)
	}
	tmuxCmd(t, socket, "new-window", "-d", "-t", "=work:", "-n", "operator", "-c", home)
	tmuxCmd(t, socket, "set-option", "-w", "-t", "=work:operator", "@rk_win_role", "operator")
	// Physical promotion: create the operator home and move the window in.
	tmuxCmd(t, socket, "new-session", "-d", "-s", "_rk-operator", "-c", home)
	opWinID := ""
	{
		out, err := exec.CommandContext(ctx, "tmux", "-L", socket,
			"list-windows", "-t", "=work:", "-F", "#{window_id}\t#{window_name}").CombinedOutput()
		if err != nil {
			t.Fatalf("list work windows: %v\n%s", err, out)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) == 2 && parts[1] == "operator" {
				opWinID = parts[0]
			}
		}
	}
	if opWinID == "" {
		t.Fatal("operator window not found in work session")
	}
	tmuxCmd(t, socket, "move-window", "-s", opWinID, "-t", "=_rk-operator:")

	before, err := CaptureServer(context.Background(), socket)
	if err != nil {
		t.Fatalf("capture before: %v", err)
	}
	found := false
	for _, sess := range before.Sessions {
		if sess.Name != "_rk-operator" {
			continue
		}
		found = true
		if len(sess.Windows) == 0 {
			t.Fatal("captured _rk-operator has no windows")
		}
	}
	if !found {
		t.Fatal("captured snapshot is missing the _rk-operator session")
	}

	tmuxCmd(t, socket, "kill-server")
	waitServerDead(t, socket)

	report, err := Restore(context.Background(), socket, before)
	if err != nil {
		t.Fatalf("restore: %v\nreport: %+v", err, report)
	}
	if len(report.Skipped) != 0 {
		t.Errorf("restore skipped: %v", report.Skipped)
	}

	after, err := CaptureServer(context.Background(), socket)
	if err != nil {
		t.Fatalf("capture after: %v", err)
	}

	// `_rk-operator` exists containing the window with its role restored.
	foundAfter := false
	restoredRole := ""
	for _, sess := range after.Sessions {
		if sess.Name != "_rk-operator" {
			continue
		}
		foundAfter = true
		for _, w := range sess.Windows {
			if w.Name == "operator" {
				restoredRole = w.Role
			}
		}
	}
	if !foundAfter {
		t.Fatal("restored server is missing the _rk-operator session")
	}
	if restoredRole != "operator" {
		t.Errorf("restored operator window role = %q, want %q", restoredRole, "operator")
	}
}
