package main

import (
	"context"
	"fmt"
	"text/tabwriter"

	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux sessions — the session-grain sibling of `rk mux panes`: one row per
// session of the resolved server, carrying substrate facts only (name, derived
// role, attached viewer count, window count, start path). The role is derived
// from the session name against run-kit's reserved constants at request time
// (tmux.SessionRole) — the fact surface external orchestrators consume instead
// of hard-coding the `_rk-*` reserved prefix. Choreography fields are
// deliberately absent (cli-layering.md delegation rule). No daemon dependency;
// as a query it CONSUMES the family's inherited -L/--server.
//
// The default listing is the user-facing candidate set (`role: user` only);
// --all includes infrastructure sessions labeled with their roles. Output
// shapes and exit codes mirror `rk mux panes`: aligned table by default
// (stdout carries rows, stderr diagnostics), --json the two-space-indented
// array inside the standard {"ok","result"} envelope; exit 0 on success
// including an alive-but-empty server ("result": [] under
// --json, liveness-probed to separate it from a dead socket), 1 operational,
// 2 usage.

var (
	muxSessionsJSONFlag bool
	muxSessionsAllFlag  bool
)

var muxSessionsCmd = &cobra.Command{
	Use:   "sessions [--json] [--all]",
	Short: "Enumerate the server's sessions with derived roles",
	Long: "List one row per session on the resolved tmux server: name, derived role, " +
		"attached viewer count, window count, and start path. Roles derive from the " +
		"session name at request time — `user` for ordinary sessions, and `pin` " +
		"(`_rk-pin-*` board pin-sessions), `control` (the `_rk-ctl` anchor), " +
		"`operator` (`_rk-operator`), or `reserved` (any other `_rk-*` name) for " +
		"run-kit infrastructure. By default only `user` sessions list — the " +
		"spawn-candidate set an orchestrator wants; --all includes infrastructure " +
		"rows labeled with their roles. Session-group copies fold onto their " +
		"leader, and the attached count credits viewers to the leader row. " +
		"Substrate facts only — no change/stage fields.\n\n" +
		"--json emits the machine-readable array, wrapped in the standard " +
		"{\"ok\":true,\"result\":…} envelope. The server resolves via the " +
		"family's -L/--server flag (default: your own server, from $TMUX).",
	Example: `  rk mux sessions
  rk mux sessions --all
  rk mux sessions --json
  rk mux sessions -L foo --all --json`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runMuxSessions(cmd)
	},
}

func init() {
	muxSessionsCmd.Flags().BoolVar(&muxSessionsJSONFlag, "json", false,
		"Output as JSON")
	muxSessionsCmd.Flags().BoolVar(&muxSessionsAllFlag, "all", false,
		"Include infrastructure sessions (pin/iso/control/operator/reserved roles)")
}

// muxSessions*Fn are package-level seams so runMuxSessions can be tested
// without a live tmux server (the mux_panes.go pattern); the defaults delegate
// to internal/tmux.
var (
	muxSessionsFactsFn = func(ctx context.Context, server string) ([]tmux.SessionFacts, error) {
		return tmux.ListSessionFacts(ctx, server)
	}
	muxSessionsAliveFn = func(ctx context.Context, server string) error {
		return tmux.ServerAlive(ctx, server)
	}
)

// runMuxSessions is the testable core: resolve server → enumerate → filter →
// render (table / json).
func runMuxSessions(cmd *cobra.Command) error {
	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, muxCmdTimeout)
	defer cancel()

	server := muxServer()
	sink := newSink(cmd)

	facts, err := muxSessionsFactsFn(ctx, server)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	// ListSessionFacts degrades a dead socket to (nil, nil) like ListSessions;
	// for a CLI query a dead server is an operational failure, so an empty
	// enumeration is liveness-probed to separate "no server" (exit 1, tmux's
	// diagnostic) from "alive, nothing to list" (exit 0, empty output).
	if len(facts) == 0 {
		if err := muxSessionsAliveFn(ctx, server); err != nil {
			return fmt.Errorf("list sessions: %w", err)
		}
	}

	rows := []tmux.SessionFacts{}
	for _, f := range facts {
		if !muxSessionsAllFlag && f.Role != tmux.SessionRoleUser {
			continue
		}
		rows = append(rows, f)
	}

	if muxSessionsJSONFlag {
		return sink.Envelope(rows, nil)
	}

	w := tabwriter.NewWriter(sink.data, 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tROLE\tATTACHED\tWINDOWS\tPATH")
	for _, r := range rows {
		fmt.Fprintf(w, "%s\t%s\t%d\t%d\t%s\n",
			r.Name, r.Role, r.Attached, r.Windows, r.Path)
	}
	return w.Flush()
}
