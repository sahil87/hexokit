package snapshot

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"rk/internal/tmux"
)

// restoreOps is the tmux mutation surface the restore engine drives.
// Production wiring is ProductionRestoreOps (thin adapters over internal/tmux);
// tests inject fakes so the engine's ordering/fallback logic is unit-testable
// without a live tmux server.
type restoreOps struct {
	listSessions   func(ctx context.Context, server string) ([]tmux.SessionInfo, error)
	createSession  func(name, windowName, cwd, server string) (windowID string, bornIndex int, err error)
	createWindowAt func(session string, index int, name, cwd, server string) (windowID string, err error)
	// createWindowAppend creates the window after the session's current window
	// (new-window -a) — the documented fallback when the stored index is now
	// occupied (the restore engine's append posture, minus MoveWindow: a reopen
	// never renumbers a live session's neighbours).
	createWindowAppend func(session, name, cwd, server string) (windowID string, err error)
	renumberWindow     func(session, windowID string, index int, server string) error
	splitWindow        func(windowID string, horizontal bool, cwd, server string) (paneID string, err error)
	selectLayout       func(windowID, layout, server string) error
	selectPane         func(paneID, server string) error
	selectWindow       func(session, windowID, server string) error
	setSessionColor    func(session, color, server string) error
	setWindowOpts      func(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error
	setSessionOrder    func(ctx context.Context, server string, order []string) error
	setServerRank      func(ctx context.Context, server string, rank int) error
	// dirExists reports whether a stored pane cwd still exists on disk (a
	// deleted worktree falls back to the server default dir with a note).
	dirExists func(path string) bool
}

// ProductionRestoreOps returns the restoreOps wired to internal/tmux.
func productionRestoreOps() restoreOps {
	return restoreOps{
		listSessions:   tmux.ListSessions,
		createSession:  tmux.CreateSessionForRestore,
		createWindowAt: tmux.CreateWindowAtIndex,
		// Append passes nil options: the @rk_win_* re-stamp runs as a follow-up
		// setWindowOpts once the new id is known, so it can degrade per-step.
		createWindowAppend: func(session, name, cwd, server string) (string, error) {
			return tmux.CreateWindowWithOptionsID(session, name, cwd, server, nil)
		},
		renumberWindow:  tmux.RenumberWindow,
		splitWindow:     tmux.SplitWindow,
		selectLayout:    tmux.SelectLayout,
		selectPane:      tmux.SelectPane,
		selectWindow:    tmux.SelectWindowInSession,
		setSessionColor: tmux.SetSessionColor,
		setWindowOpts:   tmux.SetWindowOptions,
		setSessionOrder: tmux.SetSessionOrder,
		setServerRank:   tmux.SetServerRank,
		dirExists: func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.IsDir()
		},
	}
}

// RestoredWindow is one recreated window in the restore report.
type RestoredWindow struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Panes int    `json:"panes"`
	// FormerCommands lists each recreated pane's captured command (pane-index
	// order). Purely informational — restore NEVER relaunches them; the user
	// decides what to resume (e.g. `claude -c` per agent window).
	FormerCommands []string `json:"formerCommands"`
	// Notes records per-window degradations (missing cwd fallback, layout
	// apply skipped).
	Notes []string `json:"notes"`
}

// RestoredSession is one recreated session in the restore report.
type RestoredSession struct {
	Name    string           `json:"name"`
	Windows []RestoredWindow `json:"windows"`
}

// Report describes what a restore recreated and what it skipped.
type Report struct {
	Server   string            `json:"server"`
	Sessions []RestoredSession `json:"sessions"`
	// Skipped records whole units that could not be recreated.
	Skipped []string `json:"skipped"`
	// Notes records server-level degradations (options that failed to apply).
	Notes []string `json:"notes"`
}

// Restore recreates a dead server's layout from a snapshot onto the named
// server: sessions (oldest-first, original names), windows (original
// indexes), pane cwds as fresh shells, split geometry from the stored layout
// string (best-effort), and the rk-owned presentation options. The server
// argument is the caller-validated target (the CLI runs ValidateServerName on
// it) and MUST match the snapshot's own Server field — a snapshot is never
// restored onto a server it was not captured from. Restore refuses to touch a
// server that is alive with user-facing sessions — restore is for dead
// servers (no --force in v1). Every tmux invocation goes through
// internal/tmux with the explicit server socket (Constitution §I); restore is
// user-initiated only, never daemon-automatic (Constitution §VI).
func Restore(ctx context.Context, server string, snap *Snapshot) (*Report, error) {
	return restore(ctx, server, snap, productionRestoreOps())
}

func restore(ctx context.Context, server string, snap *Snapshot, ops restoreOps) (*Report, error) {
	if snap == nil || snap.Server == "" {
		return nil, fmt.Errorf("restore: empty snapshot")
	}
	// Confused-deputy guard: the validated CLI argument — not the
	// JSON-embedded field — is the operative target, and the two must agree.
	if snap.Server != server {
		return nil, fmt.Errorf(
			"restore: snapshot belongs to server %q, not %q — refusing to restore it onto a different server",
			snap.Server, server)
	}
	if len(snap.Sessions) == 0 {
		return nil, fmt.Errorf("restore: snapshot for %q has no sessions", server)
	}

	// Refusal: never clobber a live server. ListSessions maps a dead server
	// to (nil, nil), so any returned user-facing session means alive.
	live, err := ops.listSessions(ctx, server)
	if err != nil {
		return nil, fmt.Errorf("restore: probing server %q: %w", server, err)
	}
	if len(live) > 0 {
		return nil, fmt.Errorf(
			"server %q is alive with %d session(s) — refusing to restore over it (restore is for dead servers)",
			server, len(live))
	}

	report := &Report{Server: server}

	for _, sess := range snap.Sessions {
		if len(sess.Windows) == 0 {
			report.Skipped = append(report.Skipped,
				fmt.Sprintf("session %q: no windows in snapshot", sess.Name))
			continue
		}
		rs := RestoredSession{Name: sess.Name}

		// Track the new window id per stored window id, for the active-window
		// re-select below.
		newIDs := map[string]string{}

		for wi, win := range sess.Windows {
			var rw RestoredWindow
			var windowID string
			var werr error
			cwd, cwdNote := restoreCwd(ops, firstPaneCwd(win))

			if wi == 0 {
				// First window rides the session create (which may birth the
				// server). Renumber it from the born base-index to the stored
				// index when they differ (RenumberWindow, not MoveWindow —
				// the target index is unoccupied on a fresh session).
				var born int
				windowID, born, werr = ops.createSession(sess.Name, win.Name, cwd, server)
				if werr == nil && born != win.Index {
					if merr := ops.renumberWindow(sess.Name, windowID, win.Index, server); merr != nil {
						rw.Notes = append(rw.Notes,
							fmt.Sprintf("kept index %d (renumber to %d failed: %v)", born, win.Index, merr))
					}
				}
			} else {
				windowID, werr = ops.createWindowAt(sess.Name, win.Index, win.Name, cwd, server)
			}
			if werr != nil {
				report.Skipped = append(report.Skipped,
					fmt.Sprintf("session %q window %d (%s): %v", sess.Name, win.Index, win.Name, werr))
				if wi == 0 {
					// Session create failed — nothing to hang the remaining
					// windows on.
					break
				}
				continue
			}
			if cwdNote != "" {
				rw.Notes = append(rw.Notes, cwdNote)
			}
			newIDs[win.ID] = windowID
			rw.Index = win.Index
			rw.Name = win.Name
			rw.Panes = 1
			rw.FormerCommands = formerCommands(win)

			// Additional panes: fresh shells at the recorded cwds, appended as
			// sequential splits. Fidelity note: select-layout below maps panes
			// to layout cells POSITIONALLY (by pane order), so geometry is
			// restored, but a window whose original panes were created in a
			// different split order can see panes occupy different cells than
			// they originally did — each pane's cwd/former-command stays with
			// the pane, not the cell.
			//
			// newPaneIDs tracks the created pane id per stored-pane position
			// for the active-pane re-select: position 0 rides the window
			// create (no id handle), later positions are the split returns.
			newPaneIDs := make([]string, len(win.Panes))
			for pi, pane := range win.Panes {
				if pi == 0 {
					continue // rides the window create
				}
				pcwd, pnote := restoreCwd(ops, pane.Cwd)
				paneID, serr := ops.splitWindow(windowID, false, pcwd, server)
				if serr != nil {
					rw.Notes = append(rw.Notes,
						fmt.Sprintf("pane %d not recreated: %v", pane.Index, serr))
					continue
				}
				newPaneIDs[pi] = paneID
				rw.Panes++
				if pnote != "" {
					rw.Notes = append(rw.Notes, fmt.Sprintf("pane %d: %s", pane.Index, pnote))
				}
			}

			// Split geometry: best-effort replay of the stored layout string —
			// valid only when every pane came back.
			if rw.Panes > 1 && win.Layout != "" {
				if lerr := ops.selectLayout(windowID, win.Layout, server); lerr != nil {
					rw.Notes = append(rw.Notes, fmt.Sprintf("layout not reapplied: %v", lerr))
				}
			}

			// Re-select the stored active pane. Splits are created detached
			// (-d), so the first pane is active by default — only a stored
			// active pane beyond position 0 needs an explicit select (and its
			// id is in hand from the split; a failed split's position has no
			// id and its failure note above already covers it).
			for pi, pane := range win.Panes {
				if !pane.Active {
					continue
				}
				if pi > 0 && newPaneIDs[pi] != "" {
					if perr := ops.selectPane(newPaneIDs[pi], server); perr != nil {
						rw.Notes = append(rw.Notes, fmt.Sprintf("active pane not re-selected: %v", perr))
					}
				}
				break
			}

			// rk presentation options ride one chained set-option call.
			if wops := WindowOptionOps(win); len(wops) > 0 {
				if oerr := ops.setWindowOpts(ctx, windowID, server, wops); oerr != nil {
					rw.Notes = append(rw.Notes, fmt.Sprintf("window options not reapplied: %v", oerr))
				}
			}

			rs.Windows = append(rs.Windows, rw)
		}

		// Re-select the stored active window.
		for _, win := range sess.Windows {
			if win.Active {
				if id, ok := newIDs[win.ID]; ok {
					if serr := ops.selectWindow(sess.Name, id, server); serr != nil {
						report.Notes = append(report.Notes,
							fmt.Sprintf("session %q: active window not re-selected: %v", sess.Name, serr))
					}
				}
				break
			}
		}

		if sess.Color != "" && len(rs.Windows) > 0 {
			if cerr := ops.setSessionColor(sess.Name, sess.Color, server); cerr != nil {
				report.Notes = append(report.Notes,
					fmt.Sprintf("session %q: color not reapplied: %v", sess.Name, cerr))
			}
		}

		if len(rs.Windows) > 0 {
			report.Sessions = append(report.Sessions, rs)
		}
	}

	if len(report.Sessions) == 0 {
		return report, fmt.Errorf("restore: no sessions could be recreated on %q", server)
	}

	// Server-scoped rk options.
	if len(snap.SessionOrder) > 0 {
		if err := ops.setSessionOrder(ctx, server, snap.SessionOrder); err != nil {
			report.Notes = append(report.Notes, fmt.Sprintf("session order not reapplied: %v", err))
		}
	}
	if snap.ServerRank != nil {
		if err := ops.setServerRank(ctx, server, *snap.ServerRank); err != nil {
			report.Notes = append(report.Notes, fmt.Sprintf("server rank not reapplied: %v", err))
		}
	}

	return report, nil
}

// firstPaneCwd returns the stored cwd of the window's first pane ("" when the
// window has no panes recorded).
func firstPaneCwd(win Window) string {
	if len(win.Panes) == 0 {
		return ""
	}
	return win.Panes[0].Cwd
}

// restoreCwd validates a stored cwd against the live filesystem. A missing
// directory (deleted worktree) falls back to "" (the server default dir) with
// a report note — a dead cwd must never fail the restore.
func restoreCwd(ops restoreOps, cwd string) (string, string) {
	if cwd == "" {
		return "", ""
	}
	if ops.dirExists(cwd) {
		return cwd, ""
	}
	return "", fmt.Sprintf("cwd %s missing on disk — pane at server default dir", cwd)
}

// formerCommands lists the window's captured per-pane commands, pane order.
func formerCommands(win Window) []string {
	var out []string
	for _, p := range win.Panes {
		if p.Command != "" {
			out = append(out, p.Command)
		}
	}
	return out
}

// WindowOptionOps maps a snapshot window's stored rk options onto the chained
// set-option ops SetWindowOptions applies. Exported so every re-stamp path
// (restore, closed-window reopen/resume) shares the ONE option mapping — no
// second option list anywhere. Empty values are omitted (never unset — a
// restore only reapplies what was captured). The web-tab family is emitted
// slot by slot (URL and root together); the active pointer only when > 0. A
// snapshot written by an older binary (whose retired web keys this struct no
// longer declares) decodes with those keys ignored and simply restores without
// web state — no on-disk migration.
func WindowOptionOps(win Window) []tmux.WindowOptionOp {
	var ops []tmux.WindowOptionOp
	add := func(key, value string) {
		if value != "" {
			v := value
			ops = append(ops, tmux.WindowOptionOp{Key: key, Value: &v})
		}
	}
	add(tmux.ColorOption, win.Color)
	add(tmux.LayoutOption, win.RkLayout)
	for i, tab := range win.WebTabs {
		add(tmux.WebTabOption(i+1), tab)
		if i < len(win.WebRoots) {
			add(tmux.WebTabRootOption(i+1), win.WebRoots[i])
		}
	}
	if win.WebActive > 0 {
		add(tmux.WebActiveOption, strconv.Itoa(win.WebActive))
	}
	add(tmux.CodeRootOption, win.CodeRoot)
	add(tmux.MarkerOption, tmux.NormalizeMarker(win.Marker))
	add(tmux.FlairOption, win.Flair)
	if win.Role != tmux.RoleOperatorRun {
		// A run window is an ephemeral process: restoring its role onto a
		// fresh shell would read as a run in flight forever.
		add(tmux.RoleOption, win.Role)
	}
	add(tmux.OwnerOption, win.Owner)
	add(tmux.NoteOption, win.Note)
	return ops
}
