package tmux

import (
	"context"
	"fmt"
	"strings"
)

// operator_run.go — the ephemeral run window of the operator loop: one window
// per scheduled run in the server's _rk-operator session, stamped with
// RoleOperatorRun plus its run id so "a run window exists" is the busy signal
// and survives a daemon restart (tmux holds it).

// RunWindow is one live operator-loop run window.
type RunWindow struct {
	WindowID string
	Session  string
	Name     string
	RunID    string
}

// runWindowsFormat lists every window with the fields the run-window filter
// and parse need.
var runWindowsFormat = strings.Join([]string{
	"#{window_id}", "#{session_name}", "#{window_name}",
	"#{" + RoleOption + "}", "#{" + OperatorRunOption + "}",
}, listDelim)

// parseRunWindows keeps the lines whose role is RoleOperatorRun. Pure so the
// filter is unit-testable without a live server.
func parseRunWindows(lines []string) []RunWindow {
	var out []RunWindow
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < 5 || strings.TrimSpace(parts[3]) != RoleOperatorRun {
			continue
		}
		out = append(out, RunWindow{
			WindowID: strings.TrimSpace(parts[0]),
			Session:  parts[1],
			Name:     parts[2],
			RunID:    strings.TrimSpace(parts[4]),
		})
	}
	return out
}

// ListOperatorRunWindows returns every live run window on the server, in tmux
// window order. An empty result means no run is in flight.
func ListOperatorRunWindows(ctx context.Context, server string) ([]RunWindow, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-a", "-F", runWindowsFormat)
	if err != nil {
		return nil, err
	}
	return parseRunWindows(lines), nil
}

// LaunchOperatorRunWindow creates the run window in _rk-operator (creating the
// session detached when absent), named name, rooted at cwd, running shellCmd
// directly — no shell-fallback tail, so the window dies when the command
// exits — and stamped with RoleOperatorRun and runID in the same tmux
// invocation as the creation, so no reader ever sees an unstamped run window.
// shellCmd is one opaque argv element the caller composes from quoted tokens.
// A failure after tmux may have created the window (the stamp chain) kills any
// window of that name before returning, so a failed launch leaves nothing
// behind.
func LaunchOperatorRunWindow(ctx context.Context, server, name, cwd, shellCmd, runID string) (WindowBirth, error) {
	if err := EnsureOperatorSession(ctx, serverArgs(server)); err != nil {
		return WindowBirth{}, fmt.Errorf("ensure %s session: %w", OperatorSessionName, err)
	}
	role, run := RoleOperatorRun, runID
	birth, err := CreateWindowWithCommandID(OperatorSessionName, name, cwd, server, shellCmd, []WindowOptionOp{
		{Key: RoleOption, Value: &role},
		{Key: OperatorRunOption, Value: &run},
	})
	if err != nil {
		killOperatorWindowsNamed(ctx, server, name)
		return WindowBirth{}, err
	}
	return birth, nil
}

// killOperatorWindowsNamed best-effort kills the _rk-operator windows with the
// given name — the cleanup for a launch that failed part-way.
func killOperatorWindowsNamed(ctx context.Context, server, name string) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(OperatorSessionName),
		"-F", "#{window_id}"+listDelim+"#{window_name}")
	if err != nil {
		return
	}
	for _, line := range lines {
		id, wname, ok := strings.Cut(line, listDelim)
		if ok && wname == name {
			_, _ = tmuxExecServer(ctx, server, "kill-window", "-t", strings.TrimSpace(id))
		}
	}
}
