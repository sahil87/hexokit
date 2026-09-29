package main

import (
	"context"
	"fmt"
	"text/tabwriter"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux panes — a whole-server ENUMERATION query: one row per pane across all
// sessions of the resolved server, carrying substrate facts only (session,
// window, pane identity, command, cwd, reconciled @rk_agent_state + duration).
// Choreography fields (change/stage) are deliberately absent — enrichment is
// the fab layer's job (cli-layering.md delegation rule). No daemon dependency:
// tmux is addressed directly from the caller's context (the rk present
// pattern).
//
// Enumeration flows through the same ListSessions/parseSessions chokepoint as
// the dashboard, so `_rk-pin-*` pin-sessions, `_rk-iso-*` isolated relay
// sessions and the `_rk-ctl` anchor contribute no rows and a pinned window appears exactly once, via its home
// session. As a query it CONSUMES the family's inherited -L/--server (it does
// not call muxRejectInheritedServerFlag).
//
// Output shapes: default is an aligned one-pane-per-row table (rows are data —
// stdout; diagnostics go to stderr); --json wraps a two-space-indented array in
// the standard {"ok","result"} envelope, with agent_state/agent_state_duration
// null for uninstrumented panes and the
// duration present only for idle/waiting (the mux capture --json semantics),
// plus a trailing tri-state has_agent: the pane-pid process-tree liveness walk
// (paneHasAgent, shared with rk mux process) runs only for rows whose
// foreground command is a shell — the one case where "did the agent exit?" is
// open, since an agent TUI owning the tty is not a candidate — and yields
// true/false there; every other row, and a shell row whose walk failed, is
// null (no evidence). A consumer's exited predicate is therefore
// `IsShellCommand(command) && has_agent == false`. The walk never fails the
// enumeration and never writes to stderr. Exit codes follow the toolkit
// convention: 0 success — including an alive server with nothing to list
// ("result": [] under --json), 1 operational (no server on the resolved socket,
// tmux failure — carrying tmux's diagnostic), 2 usage.

var muxPanesJSONFlag bool

var muxPanesCmd = &cobra.Command{
	Use:   "panes [--json]",
	Short: "Enumerate every pane on the server with substrate facts",
	Long: "List one row per pane across all sessions of the resolved tmux server: " +
		"session, window (index:name), pane id, active markers, command, cwd, and " +
		"the pane's reconciled " + tmux.AgentStateOption + " with idle/waiting duration. " +
		"Internal sessions (`_rk-pin-*` pin-sessions, `_rk-iso-*` isolated relay sessions, the `_rk-ctl` anchor) are " +
		"excluded; a pinned window lists once, via its home session. Substrate " +
		"facts only — no change/stage fields. Under --json each row also carries " +
		"has_agent: true/false for shell-foreground panes (a process-tree walk for " +
		"a live agent), null otherwise.\n\n" +
		"--json emits the machine-readable array, wrapped in the standard " +
		"{\"ok\":true,\"result\":…} envelope. The server resolves via the " +
		"family's -L/--server flag (default: your own server, from $TMUX).",
	Example: `  rk mux panes
  rk mux panes --json
  rk mux panes -L foo`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, _ []string) error {
		return runMuxPanes(cmd)
	},
}

func init() {
	muxPanesCmd.Flags().BoolVar(&muxPanesJSONFlag, "json", false,
		"Output as JSON")
}

// muxPanes*Fn are package-level seams so runMuxPanes can be tested without a
// live tmux server (the mux_send.go pattern); the defaults delegate to
// internal/tmux. muxPanesNowFn anchors duration math so tests are
// deterministic.
var (
	muxPanesSessionsFn = func(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
		return tmux.ListSessions(ctx, server)
	}
	muxPanesWindowsFn = func(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
		return tmux.ListWindows(ctx, session, server)
	}
	muxPanesAliveFn = func(ctx context.Context, server string) error {
		return tmux.ServerAlive(ctx, server)
	}
	muxPanesNowFn = func() time.Time { return time.Now() }
)

// muxPanesRow is one pane's row, and the --json object shape: agent_state and
// agent_state_duration are null when the pane is uninstrumented (or carries no
// duration-bearing state).
type muxPanesRow struct {
	Session            string  `json:"session"`
	SessionID          string  `json:"session_id"`
	WindowIndex        int     `json:"window_index"`
	WindowID           string  `json:"window_id"`
	WindowName         string  `json:"window_name"`
	WindowActive       bool    `json:"window_active"`
	Pane               string  `json:"pane"`
	PaneIndex          int     `json:"pane_index"`
	PaneActive         bool    `json:"pane_active"`
	Command            string  `json:"command"`
	CWD                string  `json:"cwd"`
	AgentState         *string `json:"agent_state"`
	AgentStateDuration *string `json:"agent_state_duration"`
	// HasAgent is last so the preceding key set stays byte-stable for
	// consumers that decode a prefix of the row.
	HasAgent *bool `json:"has_agent"`
}

// runMuxPanes is the testable core: resolve server → enumerate → render
// (table / json).
func runMuxPanes(cmd *cobra.Command) error {
	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, muxCmdTimeout)
	defer cancel()

	server := muxServer()
	sink := newSink(cmd)

	sessionInfos, err := muxPanesSessionsFn(ctx, server)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}
	// ListSessions degrades a dead socket to (nil, nil) for its dashboard
	// callers; for a CLI query a dead server is an operational failure, so an
	// empty enumeration is liveness-probed to separate "no server" (exit 1,
	// tmux's diagnostic) from "alive, nothing to list" (exit 0, empty output).
	if len(sessionInfos) == 0 {
		if err := muxPanesAliveFn(ctx, server); err != nil {
			return fmt.Errorf("list sessions: %w", err)
		}
	}

	nowUnix := muxPanesNowFn().Unix()
	rows := []muxPanesRow{}
	for _, si := range sessionInfos {
		windows, err := muxPanesWindowsFn(ctx, si.Name, server)
		if err != nil {
			return fmt.Errorf("list windows (%s): %w", si.Name, err)
		}
		for _, w := range windows {
			for _, p := range w.Panes {
				row := muxPanesRow{
					Session:      si.Name,
					SessionID:    si.ID,
					WindowIndex:  w.Index,
					WindowID:     w.WindowID,
					WindowName:   w.Name,
					WindowActive: w.IsActiveWindow,
					Pane:         p.PaneID,
					PaneIndex:    p.PaneIndex,
					PaneActive:   p.IsActive,
					Command:      p.Command,
					CWD:          p.Cwd,
				}
				// Duration follows the sessions rollup semantics: emitted for
				// any known state with epoch > 0, active included — a lost
				// write on a live agent is otherwise invisible downstream.
				if p.AgentState != "" {
					state := p.AgentState
					row.AgentState = &state
					if p.AgentStateEpoch > 0 {
						if d := sessions.FormatAgentDuration(nowUnix - p.AgentStateEpoch); d != "" {
							row.AgentStateDuration = &d
						}
					}
				}
				// Liveness walk, lazily: only a shell foreground leaves the
				// question open (a wrapper shell over a live agent, or the
				// shell left behind by one that exited). PanePID 0 has no walk
				// root; a discovery error leaves null — the consumer decides
				// how to treat missing evidence, and one bad row never fails
				// the enumeration.
				if tmux.IsShellCommand(p.Command) && p.PanePID > 0 {
					if _, has, err := paneHasAgent(ctx, p.PanePID, p.AgentPID); err == nil {
						row.HasAgent = &has
					}
				}
				rows = append(rows, row)
			}
		}
	}

	if muxPanesJSONFlag {
		return sink.Envelope(rows, nil)
	}

	w := tabwriter.NewWriter(sink.data, 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "SESSION\tWINDOW\tPANE\tACTIVE\tAGENT\tCOMMAND\tCWD")
	for _, r := range rows {
		active := "-"
		switch {
		case r.WindowActive && r.PaneActive:
			active = "window+pane"
		case r.WindowActive:
			active = "window"
		case r.PaneActive:
			active = "pane"
		}
		agent := "-"
		if r.AgentState != nil {
			agent = *r.AgentState
			if r.AgentStateDuration != nil {
				agent += " (" + *r.AgentStateDuration + ")"
			}
		}
		fmt.Fprintf(w, "%s\t%d:%s\t%s\t%s\t%s\t%s\t%s\n",
			r.Session, r.WindowIndex, r.WindowName, r.Pane, active, agent, r.Command, r.CWD)
	}
	return w.Flush()
}
