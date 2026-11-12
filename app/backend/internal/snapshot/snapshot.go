// Package snapshot persists per-tmux-server layout snapshots as
// disaster-recovery backups and restores them onto dead servers.
//
// Snapshots are disaster-recovery backups, never live state (Constitution
// II): no snapshot read ever answers a live-state query — live state stays
// derived from tmux and the filesystem. The sanctioned readers are the
// user-initiated `rk mux snapshot` CLI and the read-only /api/recovery
// endpoints (offer listing plus user-initiated restore/dismiss). The daemon
// never restores automatically (Constitution VI). This is the same category
// as the daemon's log file: an artifact about the past, not a database about
// the present.
package snapshot

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"rk/internal/tmux"
)

// Snapshot is one server's persisted layout at a point in time. The capture
// set is derived entirely from tmux at snapshot time; scrollback contents,
// environment variables, and running processes are deliberately NOT captured.
type Snapshot struct {
	Server  string    `json:"server"`
	TakenAt time.Time `json:"takenAt"`
	// ServerRank mirrors the @rk_srv_rank server option (nil when unset).
	ServerRank *int `json:"serverRank,omitempty"`
	// SessionOrder mirrors the @rk_srv_session_order server option.
	SessionOrder []string  `json:"sessionOrder,omitempty"`
	Sessions     []Session `json:"sessions"`
	// DiedAt / AuditedKill are tombstone-only fields, stamped by
	// Store.Tombstone when the server's socket is removed. AuditedKill marks a
	// death preceded by a kill through run-kit's audited kill path
	// (POST /api/servers/kill).
	DiedAt      *time.Time `json:"diedAt,omitempty"`
	AuditedKill bool       `json:"auditedKill,omitempty"`
}

// Session is one user-facing tmux session in a snapshot.
type Session struct {
	Name string `json:"name"`
	// CreatedAt is the session's creation time in unix seconds.
	CreatedAt int64 `json:"createdAt"`
	// Color is the raw @rk_ses_color option value ("" when unset).
	Color   string   `json:"color,omitempty"`
	Windows []Window `json:"windows"`
}

// Window is one tmux window in a snapshot.
type Window struct {
	Index  int    `json:"index"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Active bool   `json:"active,omitempty"`
	// Layout is the tmux layout string, replayed best-effort on restore.
	Layout string `json:"layout,omitempty"`
	Color  string `json:"color,omitempty"`
	// RkLayout is the raw @rk_win_layout value ("<shape>:<surface>[,<surface>…]")
	// — named RkLayout because Layout already holds the tmux pane-layout string.
	RkLayout string `json:"rkLayout,omitempty"`
	// WebTabs is the dense @rk_win_web_<n> family (index 0 is tmux slot 1);
	// WebRoots is parallel to WebTabs ("" = no root); WebActive is the 1-based
	// active index (0 = unset). /present/ URLs are stored and restored VERBATIM
	// — a restore never rewrites them to the new window's @N id.
	WebTabs   []string `json:"webTabs,omitempty"`
	WebRoots  []string `json:"webRoots,omitempty"`
	WebActive int      `json:"webActive,omitempty"`
	CodeRoot  string   `json:"codeRoot,omitempty"`
	Marker    string   `json:"marker,omitempty"`
	Flair     string   `json:"flair,omitempty"`
	Role      string   `json:"role,omitempty"`
	Owner     string   `json:"owner,omitempty"`
	// Note is the raw @rk_win_note value ("<unix-epoch>:<text>") — the epoch rides
	// along so the note's age stays honest across a restore.
	Note  string `json:"note,omitempty"`
	Panes []Pane `json:"panes"`
}

// Pane is one tmux pane in a snapshot. Command is informational only —
// restore recreates fresh shells at Cwd and reports the former command so the
// user can decide what to resume; it is never relaunched.
type Pane struct {
	ID      string `json:"id"`
	Index   int    `json:"index"`
	Cwd     string `json:"cwd,omitempty"`
	Command string `json:"command,omitempty"`
	Active  bool   `json:"active,omitempty"`
}

// SessionCount / WindowCount summarize a snapshot for list rendering.
func (s *Snapshot) SessionCount() int { return len(s.Sessions) }

// WindowCount returns the total number of windows across all sessions.
func (s *Snapshot) WindowCount() int {
	n := 0
	for _, sess := range s.Sessions {
		n += len(sess.Windows)
	}
	return n
}

// Injectable tmux read seams so CaptureServer is unit-testable without a live
// tmux server (mirrors the internal/tmux agentProcessAlive var-seam pattern).
var (
	listLayoutSessions = tmux.ListLayoutSessions
	listLayoutWindows  = tmux.ListLayoutWindows
	listLayoutPanes    = tmux.ListLayoutPanes
	getSessionOrder    = tmux.GetSessionOrder
	getServerRank      = tmux.GetServerRank
	// Single-window variants for the kill-seam capture (CaptureWindow) — a kill
	// must not walk every window on the server.
	listLayoutWindow         = tmux.ListLayoutWindow
	listLayoutPanesForWindow = tmux.ListLayoutPanesForWindow
)

// CaptureServer derives a full layout snapshot of the named server from tmux.
// A dead/unreachable server returns an error (the layout reads never map
// dead-server to empty), so a capture racing server death can never overwrite
// a good snapshot with an empty one.
//
// The rk option reads (@rk_srv_session_order / @rk_srv_rank) are best-effort:
// a malformed stored value must not sink the layout capture, so their errors
// degrade to slog.Debug with the field left empty.
func CaptureServer(ctx context.Context, server string) (*Snapshot, error) {
	sessions, err := listLayoutSessions(ctx, server)
	if err != nil {
		return nil, fmt.Errorf("capture %s: %w", server, err)
	}
	windows, err := listLayoutWindows(ctx, server)
	if err != nil {
		return nil, fmt.Errorf("capture %s: %w", server, err)
	}
	panes, err := listLayoutPanes(ctx, server)
	if err != nil {
		return nil, fmt.Errorf("capture %s: %w", server, err)
	}

	snap := &Snapshot{
		Server:  server,
		TakenAt: time.Now().UTC(),
	}

	if order, err := getSessionOrder(ctx, server); err != nil {
		slog.Debug("snapshot: session order read failed", "server", server, "err", err)
	} else if len(order) > 0 {
		snap.SessionOrder = order
	}
	if rank, err := getServerRank(ctx, server); err != nil {
		slog.Debug("snapshot: server rank read failed", "server", server, "err", err)
	} else {
		snap.ServerRank = rank
	}

	// Group windows (and their panes) under their owning sessions,
	// deterministically ordered: sessions by creation time then name, windows
	// and panes by index. Determinism matters — the store's write dedup
	// compares serialized content, so equal layouts must serialize equally.
	bySession := map[string][]Window{}
	runOnly := map[string]bool{} // sessions that held run windows and nothing else
	for _, w := range windows {
		if w.Role == tmux.RoleOperatorRun {
			if _, seen := bySession[w.Session]; !seen {
				runOnly[w.Session] = true
			}
			continue
		}
		win := layoutWindowToSnapshot(w, panes[w.WindowID])
		bySession[w.Session] = append(bySession[w.Session], win)
		delete(runOnly, w.Session)
	}

	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Created != sessions[j].Created {
			return sessions[i].Created < sessions[j].Created
		}
		return sessions[i].Name < sessions[j].Name
	})
	for _, ls := range sessions {
		if runOnly[ls.Name] {
			continue
		}
		sess := Session{
			Name:      ls.Name,
			CreatedAt: ls.Created,
			Color:     ls.Color,
			Windows:   bySession[ls.Name],
		}
		sort.Slice(sess.Windows, func(i, j int) bool { return sess.Windows[i].Index < sess.Windows[j].Index })
		snap.Sessions = append(snap.Sessions, sess)
	}

	return snap, nil
}

// Run windows (tmux.RoleOperatorRun) are never captured: a run is an ephemeral
// process whose wrapper a restore cannot resume, and a restored shell window
// carrying the role would read as a run in flight forever.

// layoutWindowToSnapshot maps one layout-read window plus its panes onto the
// snapshot Window shape. The single mapping shared by CaptureServer and
// CaptureWindow — the kill-seam record must capture exactly what a server
// snapshot would (panes sorted by index).
func layoutWindowToSnapshot(w tmux.LayoutWindow, panes []tmux.LayoutPane) Window {
	win := Window{
		Index:     w.Index,
		ID:        w.WindowID,
		Name:      w.Name,
		Active:    w.Active,
		Layout:    w.Layout,
		Color:     w.Color,
		RkLayout:  w.RkLayout,
		WebTabs:   w.WebTabs,
		WebRoots:  w.WebRoots,
		WebActive: w.WebActive,
		CodeRoot:  w.CodeRoot,
		Marker:    w.Marker,
		Flair:     w.Flair,
		Role:      w.Role,
		Owner:     w.Owner,
		Note:      w.Note,
	}
	for _, p := range panes {
		win.Panes = append(win.Panes, Pane{
			ID:      p.PaneID,
			Index:   p.Index,
			Cwd:     p.Cwd,
			Command: p.Command,
			Active:  p.Active,
		})
	}
	sort.Slice(win.Panes, func(i, j int) bool { return win.Panes[i].Index < win.Panes[j].Index })
	return win
}

// CaptureWindow derives the snapshot Window for ONE window plus its owning
// (non-pin) session name — the kill-seam capture behind the recently-closed
// ring. It reads only that window (the single-window layout reads), never the
// whole server. A window that is already gone and any tmux read failure both
// surface as errors; the caller (the kill handler) treats every failure alike
// (record nothing, kill anyway), so the two are deliberately not
// distinguished. The reads carry no @rk_pane_agent_session — agent identity is
// the caller's separate FetchSessions walk.
func CaptureWindow(ctx context.Context, server, windowID string) (Window, string, error) {
	lw, found, err := listLayoutWindow(ctx, server, windowID)
	if err != nil {
		return Window{}, "", fmt.Errorf("capture %s window %s: %w", server, windowID, err)
	}
	if !found {
		return Window{}, "", fmt.Errorf("capture %s: window %s is gone", server, windowID)
	}
	if lw.Role == tmux.RoleOperatorRun {
		return Window{}, "", fmt.Errorf("capture %s: window %s is an operator run window", server, windowID)
	}
	panes, err := listLayoutPanesForWindow(ctx, server, windowID)
	if err != nil {
		return Window{}, "", fmt.Errorf("capture %s window %s: %w", server, windowID, err)
	}
	return layoutWindowToSnapshot(lw, panes), lw.Session, nil
}
