package tmux

import (
	"context"
	"fmt"
	"strings"

	"rk/internal/validate"
)

// operator_run.go — the ephemeral run window of the operator loop: one window
// per scheduled run in the server's _rk-operator session, stamped with
// RoleOperatorRun plus its run id so "a run window exists" is the busy signal
// and survives a daemon restart (tmux holds it).

// RunWindow is one live operator-loop run window: stamped with RoleOperatorRun
// and a valid run id, and holding at least one live pane.
type RunWindow struct {
	WindowID string
	Session  string
	Name     string
	RunID    string
	// PaneIDs are the window's live (not pane_dead) panes.
	PaneIDs []string
}

// runWindowsFormat lists every pane with the fields the run-window filter and
// parse need: its window's identity and stamps, and whether the pane is dead.
var runWindowsFormat = strings.Join([]string{
	"#{window_id}", "#{session_name}", "#{window_name}",
	"#{" + RoleOption + "}", "#{" + OperatorRunOption + "}",
	"#{pane_id}", "#{pane_dead}",
}, listDelim)

// runWindowsFields is the field count of one runWindowsFormat line.
const runWindowsFields = 7

// parseRunWindows folds the pane lines into the run windows: role
// RoleOperatorRun, a valid run id, and at least one live pane. A role-only
// window (no run id) or one whose panes are all dead (a user's
// `remain-on-exit on` keeping a finished run's husk) is not a run in flight.
// Pure so the filter is unit-testable without a live server.
func parseRunWindows(lines []string) []RunWindow {
	var out []RunWindow
	byWindow := map[string]int{}
	for _, line := range lines {
		parts := strings.Split(line, listDelim)
		if len(parts) < runWindowsFields || strings.TrimSpace(parts[3]) != RoleOperatorRun {
			continue
		}
		runID := strings.TrimSpace(parts[4])
		if !validate.ValidRunID(runID) || strings.TrimSpace(parts[6]) != "0" {
			continue
		}
		id := strings.TrimSpace(parts[0])
		i, seen := byWindow[id]
		if !seen {
			i = len(out)
			byWindow[id] = i
			out = append(out, RunWindow{WindowID: id, Session: parts[1], Name: parts[2], RunID: runID})
		}
		out[i].PaneIDs = append(out[i].PaneIDs, strings.TrimSpace(parts[5]))
	}
	return out
}

// ListOperatorRunWindows returns every live run window on the server, in tmux
// order. An empty result means no run is in flight.
func ListOperatorRunWindows(ctx context.Context, server string) ([]RunWindow, error) {
	ctx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-panes", "-a", "-F", runWindowsFormat)
	if err != nil {
		return nil, err
	}
	return parseRunWindows(lines), nil
}

// LaunchOperatorRunWindow creates the run window in _rk-operator (creating the
// session detached when absent), named name, rooted at cwd, running shellCmd
// directly — no shell-fallback tail, so the window dies when the command
// exits — and stamps it with RoleOperatorRun and runID in the same tmux
// invocation, so a daemon crash between creation and stamping cannot leave an
// unstamped running wrapper. The window is created detached (-d): a client
// attached to _rk-operator (viewing the chat window) is never switched to
// background work; a detached creation is not the invocation's current
// window, so the stamps target it by its unique name. It also sets
// remain-on-exit off, so a user's global `remain-on-exit on` cannot leave a
// dead run window behind. A failed invocation kills any window of that name,
// so no unstamped run window survives. When this call created the session,
// tmux's placeholder default-shell window is killed once the run window
// exists, so the session holds only run windows and stays hidden. shellCmd is
// one opaque argv element the caller composes from quoted tokens.
func LaunchOperatorRunWindow(ctx context.Context, server, name, cwd, shellCmd, runID string) (WindowBirth, error) {
	prefix := serverArgs(server)
	ensureCtx, ensureCancel := context.WithTimeout(ctx, TmuxTimeout)
	placeholder, err := ensureSessionCapturingPlaceholder(ensureCtx, prefix, OperatorSessionName)
	ensureCancel()
	if err != nil {
		return WindowBirth{}, fmt.Errorf("ensure %s session: %w", OperatorSessionName, err)
	}
	createCtx, cancel := context.WithTimeout(ctx, TmuxTimeout)
	defer cancel()
	lines, err := tmuxExecServer(createCtx, server, buildRunWindowArgs(name, cwd, shellCmd, runID)...)
	if err == nil && len(lines) == 0 {
		err = fmt.Errorf("new-window -P returned no output, want session, window id, pane id")
	}
	var birth WindowBirth
	if err == nil {
		birth, err = parseWindowBirth(lines[0])
	}
	if err != nil {
		// A fresh bound: createCtx may be the very deadline that failed, and
		// tmux can still finish the create server-side after the client gives up.
		killCtx, killCancel := context.WithTimeout(context.WithoutCancel(ctx), TmuxTimeout)
		_, _ = tmuxExecServer(killCtx, server, "kill-window", "-t", runWindowTarget(name))
		killCancel()
		return WindowBirth{}, fmt.Errorf("creating run window %s: %w", name, err)
	}
	if placeholder != "" && placeholder != birth.WindowID {
		// Best-effort: a stray placeholder is cosmetic and never fails a launch.
		_, _ = tmuxExecServer(createCtx, server, "kill-window", "-t", placeholder)
	}
	return birth, nil
}

// runWindowTarget addresses the run window by its unique name, exact-match on
// both the session and the window.
func runWindowTarget(name string) string {
	return exactWindowInSession(OperatorSessionName, "="+name)
}

// buildRunWindowArgs is one tmux invocation: the shared new-window builder
// with -d added (the window is created without becoming the session's current
// window), chained with the set-options that stamp it and pin remain-on-exit
// off, each aimed at the window by name. Pure.
func buildRunWindowArgs(name, cwd, shellCmd, runID string) []string {
	args := buildCreateWindowWithCommandArgs(OperatorSessionName, name, cwd, shellCmd, nil)
	args = append([]string{args[0], "-d"}, args[1:]...)
	role, run, off := RoleOperatorRun, runID, "off"
	return appendOptionOps(args, runWindowTarget(name), []WindowOptionOp{
		{Key: RoleOption, Value: &role},
		{Key: OperatorRunOption, Value: &run},
		{Key: remainOnExitOption, Value: &off},
	})
}

// remainOnExitOption is the tmux window option that keeps a dead pane's
// window around after its command exits.
const remainOnExitOption = "remain-on-exit"
