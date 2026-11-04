package main

import (
	"fmt"
	"io"
	"strings"
	"time"

	"rk/internal/snapshot"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// snapshotListCap is the default per-list display cap (Toolkit Principle 9),
// mirroring reaperListCap. Display-only: it bounds rendered rows, never what
// exists in the store; --all restores the full list.
const snapshotListCap = 10

// snapshotNow is the clock used for age rendering — a seam so unit tests can
// pin it.
var snapshotNow = time.Now

// newSnapshotStore resolves the production store. A var seam so command tests
// can point it at a temp directory.
var newSnapshotStore = func() (*snapshot.Store, error) {
	dir, err := snapshot.DefaultDir()
	if err != nil {
		return nil, err
	}
	snapshot.MigrateLegacyDir(dir)
	return snapshot.NewStore(dir), nil
}

// snapshotRestoreFn is the restore engine seam (production: snapshot.Restore)
// so the command layer is testable without a live tmux server.
var snapshotRestoreFn = snapshot.Restore

// newSnapshotCmd builds one instance of the snapshot parent and its three
// subcommands. A cobra command object cannot have two parents, so the family
// member (`rk mux snapshot`) and the hidden root alias (`rk snapshot`) are two
// full subtrees; the flag variables bind per-instance so the two never share
// state. Args validators are pre-wrapped with usageArgs because root's init
// loop (root.go) wraps only DIRECT children's validators — an unwrapped
// violation at this depth would exit 1 instead of usage-class 2.
//
// When deprecated, the children carry the same Deprecated pointer as the
// parent: cobra fires it only on the EXECUTED command, so a parent-only notice
// would never print for `rk snapshot <sub>`. Hidden on the parent alone
// suffices — it drops the whole subtree from help and the help-dump.
func newSnapshotCmd(deprecated bool) *cobra.Command {
	var listAll, listJSON bool
	var showAt, restoreAt int64

	parent := &cobra.Command{
		Use:   "snapshot",
		Short: "Inspect and restore tmux server layout snapshots",
		Long: `The run-kit daemon periodically snapshots the layout of every tmux server it
covers — sessions, windows, pane working directories, and run-kit presentation
options — into ` + "`~/.local/state/hexokit/snapshots/`" + ` (recovery backups; live state is
still derived from tmux — the /api/recovery endpoints serve them read-only). When a server dies, its last snapshot
is kept as a ` + "`{server}.died-{ts}.json`" + ` tombstone.

Subcommands:
  list     show available snapshots (live + died) with ages and counts
           (--json emits the machine form — every row, no cap)
  show     print a stored layout without touching tmux
  restore  recreate a dead server's layout (fresh shells at the recorded
           working directories — former commands are reported, never relaunched)`,
	}

	list := &cobra.Command{
		Use:   "list [<server>] [--json]",
		Short: "List available layout snapshots (live + died)",
		Args:  usageArgs(cobra.MaximumNArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := muxRejectInheritedServerFlag(cmd); err != nil {
				return err
			}
			filter := ""
			if len(args) == 1 {
				if msg := validate.ValidateServerName(args[0]); msg != "" {
					return usageError(fmt.Errorf("invalid server name: %s", msg))
				}
				filter = args[0]
			}
			store, err := newSnapshotStore()
			if err != nil {
				return err
			}
			rows, err := store.List(filter)
			if err != nil {
				return err
			}
			// --json carries every row: snapshotListCap and --all bound only the
			// rendered table.
			if listJSON {
				return newSink(cmd).Envelope(snapshotListJSONRows(rows), nil)
			}
			renderSnapshotList(cmd.OutOrStdout(), rows, listAll)
			return nil
		},
	}

	show := &cobra.Command{
		Use:   "show <server>",
		Short: "Print a stored layout (sessions → windows → pane cwds) without acting",
		Args:  usageArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := muxRejectInheritedServerFlag(cmd); err != nil {
				return err
			}
			snap, err := resolveSnapshotArg(args[0], showAt)
			if err != nil {
				return err
			}
			renderSnapshotShow(cmd.OutOrStdout(), snap)
			return nil
		},
	}

	restore := &cobra.Command{
		Use:   "restore <server>",
		Short: "Recreate a dead server's layout from its snapshot",
		Long: `Recreate a dead tmux server from its stored snapshot: sessions and windows
with their original names and indexes, panes as FRESH SHELLS at the recorded
working directories, split layouts where possible, and run-kit options
(server rank, session order, colors, markers).

No process is ever relaunched — each window's former command is printed in the
restore report so you can decide what to resume (e.g. ` + "`claude -c`" + ` per agent
window). Refuses to run when the target server is alive with sessions.`,
		Args: usageArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := muxRejectInheritedServerFlag(cmd); err != nil {
				return err
			}
			snap, err := resolveSnapshotArg(args[0], restoreAt)
			if err != nil {
				return err
			}
			// The validated CLI argument — not the JSON-embedded server field — is
			// the operative restore target; the engine rejects a snapshot whose
			// own Server field disagrees.
			report, err := snapshotRestoreFn(cmd.Context(), args[0], snap)
			if err != nil {
				return err
			}
			// The report is the record of a destructive mutation — data channel,
			// unaffected by --quiet (mirrors the reaper's stance).
			renderRestoreReport(cmd.OutOrStdout(), snap, report)
			return nil
		},
	}

	list.Flags().BoolVar(&listAll, "all", false,
		"print the full list instead of the default 10-row cap (display-only)")
	list.Flags().BoolVar(&listJSON, "json", false,
		"emit the snapshot list as a JSON envelope (every row; the cap and --all are display-only)")
	show.Flags().Int64Var(&showAt, "at", 0,
		"select a history/tombstone entry by its unix timestamp (default: latest)")
	restore.Flags().Int64Var(&restoreAt, "at", 0,
		"restore a history/tombstone entry by its unix timestamp (default: latest)")
	parent.AddCommand(list)
	parent.AddCommand(show)
	parent.AddCommand(restore)
	if deprecated {
		parent.Hidden = true
		parent.Deprecated = "use `rk mux snapshot` instead"
		for _, sub := range parent.Commands() {
			sub.Deprecated = parent.Deprecated
		}
	}
	return parent
}

var (
	// snapshotFamilyCmd is the `rk mux snapshot` family member.
	snapshotFamilyCmd = newSnapshotCmd(false)
	// snapshotAliasCmd is the hidden deprecation alias kept at the root so the
	// old human-typed form keeps working while pointing at the new one.
	snapshotAliasCmd = newSnapshotCmd(true)
)

// resolveSnapshotArg validates the server argument and the --at value, then
// resolves the snapshot to act on. Validation runs BEFORE any filesystem use —
// the server name feeds path construction and, on restore, tmux targets (§I).
func resolveSnapshotArg(server string, at int64) (*snapshot.Snapshot, error) {
	if msg := validate.ValidateServerName(server); msg != "" {
		return nil, usageError(fmt.Errorf("invalid server name: %s", msg))
	}
	if at < 0 {
		return nil, usageError(fmt.Errorf("--at must be a non-negative unix timestamp"))
	}
	store, err := newSnapshotStore()
	if err != nil {
		return nil, err
	}
	return store.Resolve(server, at)
}

// formatSnapshotAge renders a duration since t compactly ("42s", "5m", "3h",
// "2d"). Future or zero timestamps render as "-".
func formatSnapshotAge(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := snapshotNow().Sub(t)
	switch {
	case d < 0:
		return "-"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// snapshotListJSONRow is one `list --json` row: a snapshot.Entry with
// snake_case keys and RFC 3339 UTC timestamps; died_at is null exactly when
// the server is live.
type snapshotListJSONRow struct {
	Server       string  `json:"server"`
	TakenAt      string  `json:"taken_at"`
	DiedAt       *string `json:"died_at"`
	AuditedKill  bool    `json:"audited_kill"`
	Sessions     int     `json:"sessions"`
	Windows      int     `json:"windows"`
	HistoryCount int     `json:"history_count"`
}

// snapshotListJSONRows maps Store.List's newest-first entries to --json rows.
// The result is never nil, so an empty store emits "result": [] — never null.
func snapshotListJSONRows(entries []snapshot.Entry) []snapshotListJSONRow {
	rows := make([]snapshotListJSONRow, 0, len(entries))
	for _, e := range entries {
		row := snapshotListJSONRow{
			Server:       e.Server,
			TakenAt:      e.TakenAt.UTC().Format(time.RFC3339),
			AuditedKill:  e.AuditedKill,
			Sessions:     e.Sessions,
			Windows:      e.Windows,
			HistoryCount: e.HistoryCount,
		}
		if e.DiedAt != nil {
			died := e.DiedAt.UTC().Format(time.RFC3339)
			row.DiedAt = &died
		}
		rows = append(rows, row)
	}
	return rows
}

// renderSnapshotList prints one row per snapshot entry, capped at
// snapshotListCap unless all is set (header count stays exact).
func renderSnapshotList(w io.Writer, rows []snapshot.Entry, all bool) {
	if len(rows) == 0 {
		fmt.Fprintln(w, "No snapshots found.")
		return
	}
	fmt.Fprintf(w, "%d snapshot(s):\n", len(rows))
	shown := rows
	if !all && len(rows) > snapshotListCap {
		shown = rows[:snapshotListCap]
	}
	fmt.Fprintf(w, "  %-20s %-22s %-6s %8s %8s %8s\n", "SERVER", "STATE", "AGE", "SESSIONS", "WINDOWS", "HISTORY")
	for _, r := range shown {
		state := "live"
		if r.DiedAt != nil {
			state = "died " + formatSnapshotAge(*r.DiedAt) + " ago"
			if r.AuditedKill {
				state += " (audited)"
			}
		}
		fmt.Fprintf(w, "  %-20s %-22s %-6s %8d %8d %8d\n",
			r.Server, state, formatSnapshotAge(r.TakenAt), r.Sessions, r.Windows, r.HistoryCount)
	}
	renderTruncationNotice(w, "  ", len(rows), len(shown))
}

// renderSnapshotShow prints a snapshot's layout tree: sessions → windows →
// panes with cwds and former commands.
func renderSnapshotShow(w io.Writer, snap *snapshot.Snapshot) {
	fmt.Fprintf(w, "Snapshot of server %q taken %s (%s ago)\n",
		snap.Server, snap.TakenAt.Format(time.RFC3339), formatSnapshotAge(snap.TakenAt))
	if snap.DiedAt != nil {
		audited := ""
		if snap.AuditedKill {
			audited = ", audited kill"
		}
		fmt.Fprintf(w, "Server DIED %s (%s ago%s)\n",
			snap.DiedAt.Format(time.RFC3339), formatSnapshotAge(*snap.DiedAt), audited)
	}
	if snap.ServerRank != nil {
		fmt.Fprintf(w, "Server rank: %d\n", *snap.ServerRank)
	}
	if len(snap.SessionOrder) > 0 {
		fmt.Fprintf(w, "Session order: %s\n", strings.Join(snap.SessionOrder, ", "))
	}
	for _, sess := range snap.Sessions {
		color := ""
		if sess.Color != "" {
			color = fmt.Sprintf(", color %s", sess.Color)
		}
		fmt.Fprintf(w, "session %s (created %s%s)\n",
			sess.Name, time.Unix(sess.CreatedAt, 0).UTC().Format(time.RFC3339), color)
		for _, win := range sess.Windows {
			active := ""
			if win.Active {
				active = "  (active)"
			}
			fmt.Fprintf(w, "  window %d: %s%s\n", win.Index, win.Name, active)
			for _, p := range win.Panes {
				cmd := p.Command
				if cmd == "" {
					cmd = "-"
				}
				fmt.Fprintf(w, "    pane %d: %s  [%s]\n", p.Index, p.Cwd, cmd)
			}
		}
	}
}

// renderRestoreReport prints what the restore recreated, what it skipped, and
// each window's former command so the user can decide what to resume.
func renderRestoreReport(w io.Writer, snap *snapshot.Snapshot, report *snapshot.Report) {
	fmt.Fprintf(w, "Restored server %q from snapshot taken %s:\n",
		report.Server, snap.TakenAt.Format(time.RFC3339))
	for _, sess := range report.Sessions {
		fmt.Fprintf(w, "  session %s (%d window(s)):\n", sess.Name, len(sess.Windows))
		for _, win := range sess.Windows {
			former := ""
			if len(win.FormerCommands) > 0 {
				former = "  was running: " + strings.Join(win.FormerCommands, ", ")
			}
			fmt.Fprintf(w, "    window %d: %s — %d pane(s)%s\n", win.Index, win.Name, win.Panes, former)
			for _, note := range win.Notes {
				fmt.Fprintf(w, "      note: %s\n", note)
			}
		}
	}
	if len(report.Skipped) > 0 {
		fmt.Fprintln(w, "Skipped:")
		for _, sk := range report.Skipped {
			fmt.Fprintf(w, "  %s\n", sk)
		}
	}
	for _, note := range report.Notes {
		fmt.Fprintf(w, "note: %s\n", note)
	}
	fmt.Fprintf(w, "Panes are fresh shells — nothing was relaunched. Attach with: tmux -L %s attach\n", report.Server)
}
