package main

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"text/tabwriter"
	"time"

	"rk/internal/tmux"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

var (
	muxInventoryJSONFlag       bool
	muxInventoryAgentsOnlyFlag bool
	muxInventoryLimitFlag      int
)

var muxInventoryCmd = &cobra.Command{
	Use:   "inventory [--agents-only] [--limit N] [--json]",
	Short: "Read a live session and pane inventory across tmux servers",
	Long: "Discover live tmux servers and read their sessions and panes in one " +
		"bounded, read-only query, with no daemon dependency. Unlike panes/sessions, " +
		"the default covers every discovered server; -L selects one named server. " +
		"Recovery snapshots are never used as live state. Sessions include derived " +
		"infrastructure roles; panes use the same visibility and agent liveness " +
		"rules as mux panes (pin/iso/control relay sessions are omitted). " +
		"--agents-only keeps panes with agent evidence, excluding shells whose " +
		"agent has exited. No terminal contents, task text, git or PR state are " +
		"queried; process arguments used by liveness are never returned. " +
		"Use capture/process for selected panes.\n\n" +
		"--json returns {observed_at, partial, servers}, sorted by server name. " +
		"Each server carries {server, sessions, panes, pane_count, truncated, error}. " +
		"--limit caps returned panes per server after filtering (default 500); " +
		"pane_count is the visible count before filtering. A per-server failure " +
		"preserves observed rows and sets error and partial, exiting 0 so healthy " +
		"servers remain usable. Discovery failure exits 1, invalid input exits 2. " +
		"Observation is a bounded walk, not an atomic tmux snapshot.",
	Example: `  rk mux inventory --json
  rk mux inventory --agents-only --json
  rk mux inventory -L work --limit 100 --json`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, _ []string) error { return runMuxInventory(cmd) },
}

func init() {
	muxInventoryCmd.Flags().BoolVar(&muxInventoryJSONFlag, "json", false, "Output as JSON")
	muxInventoryCmd.Flags().BoolVar(&muxInventoryAgentsOnlyFlag, "agents-only", false, "Only return panes with agent evidence")
	muxInventoryCmd.Flags().IntVar(&muxInventoryLimitFlag, "limit", 500, "Maximum returned panes per server after filtering (1-5000)")
}

// The enumeration uses live socket probes, not the recovery snapshot store.
var (
	muxInventoryServersFn = tmux.ListServersStrict
	muxInventoryWindowsFn = tmux.ListWindowsStrict
)

type muxInventoryServer struct {
	Server    string              `json:"server"`
	Sessions  []tmux.SessionFacts `json:"sessions"`
	Panes     []muxPanesRow       `json:"panes"`
	PaneCount int                 `json:"pane_count"`
	Truncated bool                `json:"truncated"`
	Error     *string             `json:"error"`
}

type muxInventoryResult struct {
	ObservedAt string               `json:"observed_at"`
	Partial    bool                 `json:"partial"`
	Servers    []muxInventoryServer `json:"servers"`
}

func inventoryAgentPane(p muxPanesRow) bool {
	// A negative walk overrides a stale hook state on a leftover shell.
	if p.HasAgent != nil {
		return *p.HasAgent
	}
	return p.AgentState != nil || classifyProcess(p.Command, "") == "agent"
}

func readInventoryServer(ctx context.Context, server string, now int64) muxInventoryServer {
	r := muxInventoryServer{Server: server, Sessions: []tmux.SessionFacts{}, Panes: []muxPanesRow{}}
	fail := func(err error) muxInventoryServer {
		msg := err.Error()
		r.Error = &msg
		return r
	}
	ctx, cancel := context.WithTimeout(ctx, muxCmdTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	facts, err := muxSessionsFactsFn(ctx, server)
	if err != nil {
		return fail(fmt.Errorf("list sessions: %w", err))
	}
	if len(facts) == 0 {
		if err := muxSessionsAliveFn(ctx, server); err != nil {
			return fail(fmt.Errorf("list sessions: %w", err))
		}
	}
	if facts != nil {
		r.Sessions = facts
	}
	rows, err := collectMuxPanesWith(ctx, server, now, muxInventoryWindowsFn)
	r.PaneCount = len(rows)
	for _, p := range rows {
		if muxInventoryAgentsOnlyFlag && !inventoryAgentPane(p) {
			continue
		}
		if len(r.Panes) == muxInventoryLimitFlag {
			r.Truncated = true
			continue
		}
		r.Panes = append(r.Panes, p)
	}
	if err != nil {
		return fail(err)
	}
	return r
}

func runMuxInventory(cmd *cobra.Command) error {
	if muxInventoryLimitFlag < 1 || muxInventoryLimitFlag > 5000 {
		return usageError(fmt.Errorf("--limit must be between 1 and 5000"))
	}
	selected := cmd.Flags().Changed("server") || muxServerFlag != ""
	if selected {
		if msg := validate.ValidateServerName(muxServerFlag); msg != "" {
			return usageError(fmt.Errorf("invalid --server: %s", msg))
		}
	}
	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	// Return before the MCP proxy's 45s deadline, even on a large estate.
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	now := muxPanesNowFn()
	names := []string{muxServerFlag}
	if !selected {
		var err error
		names, err = muxInventoryServersFn(ctx)
		if err != nil {
			return fmt.Errorf("discover live tmux servers: %w", err)
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("discover live tmux servers: %w", err)
	}
	sort.Strings(names)
	result := muxInventoryResult{ObservedAt: now.UTC().Format(time.RFC3339Nano), Servers: make([]muxInventoryServer, len(names))}
	// Bounded fan-out. Each worker owns one slice slot, so no append lock or
	// nondeterministic output order is needed.
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
			}
			result.Servers[i] = readInventoryServer(ctx, name, now.Unix())
		}(i, name)
	}
	wg.Wait()
	for _, s := range result.Servers {
		result.Partial = result.Partial || s.Error != nil
	}
	sink := newSink(cmd)
	if muxInventoryJSONFlag {
		return sink.Envelope(result, nil)
	}
	w := tabwriter.NewWriter(sink.data, 2, 8, 2, ' ', 0)
	fmt.Fprintf(w, "Observed: %s\nSERVER\tSESSION\tWINDOW\tPANE\tAGENT\tCOMMAND\tCWD\n", result.ObservedAt)
	for _, s := range result.Servers {
		for _, p := range s.Panes {
			state := "-"
			if p.AgentState != nil {
				state = *p.AgentState
				if p.AgentStateDuration != nil {
					state += " (" + *p.AgentStateDuration + ")"
				}
			}
			fmt.Fprintf(w, "%s\t%s\t%s:%s\t%s\t%s\t%s\t%s\n", s.Server, p.Session, p.WindowID, p.WindowName, p.Pane, state, p.Command, p.CWD)
		}
		if len(s.Panes) == 0 {
			fmt.Fprintf(w, "%s\t-\t-\t-\t-\t-\t-\n", s.Server)
		}
		if s.Error != nil {
			fmt.Fprintf(cmd.ErrOrStderr(), "%s: %s\n", s.Server, *s.Error)
		}
		if s.Truncated {
			fmt.Fprintf(cmd.ErrOrStderr(), "%s: pane output truncated at --limit %d\n", s.Server, muxInventoryLimitFlag)
		}
	}
	return w.Flush()
}
