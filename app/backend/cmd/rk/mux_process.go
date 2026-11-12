package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"rk/internal/proctree"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux process <target> — discover the process tree running in a pane (the
// pane's shell PID from #{pane_pid}, then its descendants) and print it with a
// per-process classification: agent / node / git / other. The agent set is the
// agent setup registry's binary and comm names (plus claude-code), matched on
// the comm basename or on either of the first two cmdline token basenames (the
// bounded fallback that catches node-hosted CLIs such as gemini).
// Agent-state-aware: when the pane's reconciled @rk_agent_state carries a live
// pid (a 3-segment value), the tree node with that PID is classified agent
// regardless of comm — the instrumentation is authoritative, comm heuristics
// are the fallback. `has_agent` is true iff any node classifies agent by
// either route; the same walk (paneHasAgent) backs the `rk mux panes` row
// field. No daemon dependency (the rk present pattern). Exit codes follow the
// toolkit convention: 0 success, 1 operational (missing pane, tmux failure,
// discovery failure), 2 usage.
//
// Human output:
//
//	Pane %5 (PID 1234)
//	1234 zsh
//	  1250 claude [agent]
//
//	Agent process detected.

var muxProcessJSONFlag bool

var muxProcessCmd = &cobra.Command{
	Use:   "process <target> [--json]",
	Short: "Show the process tree running in a pane",
	Long: "Discover the process tree running in the target pane: the pane's shell " +
		"PID (#{pane_pid}) and its descendants, classified agent / node / git / " +
		"other. Agent names are the `rk agent setup` registry's binaries and comm " +
		"literals, matched on the comm or on the first two command-line tokens. " +
		"A pane whose " + tmux.AgentStateOption + " carries a live agent pid has that " +
		"tree node classified agent regardless of its comm — the instrumentation " +
		"is authoritative, comm heuristics are the fallback. Prints the tree, " +
		"plus a trailing `Agent process detected.` when any node classifies " +
		"agent; --json emits the machine-readable shape wrapped in the standard " +
		"{\"ok\":true,\"result\":…} envelope.\n\n" +
		"Targets: %N (pane), @N (window — resolves to its agent pane), " +
		"=session:window (exact). Bare session:window names are rejected.",
	Example: `  rk mux process %5
  rk mux process %5 --json`,
	Args: usageArgs(cobra.ExactArgs(1)),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runMuxProcess(cmd, args[0])
	},
}

func init() {
	muxProcessCmd.Flags().BoolVar(&muxProcessJSONFlag, "json", false,
		"Output as JSON")
}

// processNode is a single process in the discovered tree.
type processNode = proctree.Node

// muxProcessJSON is the --json output shape.
type muxProcessJSON struct {
	Pane      string        `json:"pane"`
	PanePID   int           `json:"pane_pid"`
	Processes []processNode `json:"processes"`
	HasAgent  bool          `json:"has_agent"`
}

// muxProcess*Fn are package-level seams so runMuxProcess can be tested without
// a live tmux server (the mux_send.go pattern); the defaults delegate to
// internal/tmux / the platform discovery in internal/proctree.
var (
	muxProcessPanePIDFn = func(ctx context.Context, paneID, server string) (int, error) {
		return tmux.PanePIDCtx(ctx, paneID, server)
	}
	muxProcessFactsFn = func(ctx context.Context, paneID, server string) (tmux.PaneFacts, error) {
		return tmux.PaneFactsCtx(ctx, paneID, server)
	}
	muxProcessDiscoverFn proctree.DiscoverFunc = proctree.Discover
)

// agentCommNames is the set of process basenames that identify an agent
// process: every runtime's binary and comm literal from the agent setup
// registry (the one source of harness names — a new harness registered there
// is recognized by the walk without a second table), plus `claude-code`. `node`
// is excluded even though it is gemini's comm: a bare node process is not
// agent evidence, and node-hosted CLIs are caught by the cmdline fallback
// instead. It is handed to internal/proctree at init.
func buildAgentCommNames() map[string]bool {
	names := map[string]bool{"claude-code": true}
	for _, rt := range agentRuntimes() {
		for _, n := range []string{rt.binary, rt.comm} {
			if n != "" && n != "node" {
				names[strings.ToLower(n)] = true
			}
		}
	}
	return names
}

func init() {
	proctree.SetAgentCommNames(buildAgentCommNames())
}

// paneHasAgent is the process walk shared by `rk mux process` and `rk mux
// panes`; discovery goes through muxProcessDiscoverFn so both verbs share one
// seam and one fake.
func paneHasAgent(ctx context.Context, pid, agentPID int) ([]processNode, bool, error) {
	return proctree.PaneHasAgentVia(ctx, muxProcessDiscoverFn, pid, agentPID)
}

// runMuxProcess is the testable core: parse → resolve → pid → tree →
// cross-check → render (human / json).
func runMuxProcess(cmd *cobra.Command, target string) error {
	pt, err := tmux.ParsePaneTarget(target)
	if err != nil {
		return usageError(err)
	}

	parent := cmd.Context()
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, muxCmdTimeout)
	defer cancel()

	server := muxServer()
	sink := newSink(cmd)

	paneID, err := resolvePaneTarget(ctx, pt, server)
	if err != nil {
		return err
	}

	pid, err := muxProcessPanePIDFn(ctx, paneID, server)
	if err != nil {
		return fmt.Errorf("get pane PID: %w", err)
	}

	// Agent-state pid cross-check: a reconciled 3-segment @rk_agent_state
	// carries the instrumented agent's live pid — reclassify that node as
	// agent regardless of comm. A failed state read degrades to comm-only
	// classification (the tree is still the data); the pane's existence was
	// already proven by the pid read.
	agentPID := 0
	if facts, ferr := muxProcessFactsFn(ctx, paneID, server); ferr != nil {
		sink.Notef("warning: agent-state read failed (%v) — comm heuristics only\n", ferr)
	} else if facts.AgentState != "" {
		agentPID = facts.AgentPID
	}

	tree, hasAgent, err := paneHasAgent(ctx, pid, agentPID)
	if err != nil {
		return fmt.Errorf("process discovery: %w", err)
	}

	if muxProcessJSONFlag {
		out := muxProcessJSON{
			Pane:      paneID,
			PanePID:   pid,
			Processes: tree,
			HasAgent:  hasAgent,
		}
		return sink.Envelope(out, nil)
	}

	printProcessTree(sink.data, paneID, pid, tree, hasAgent)
	return nil
}

// printProcessTree prints the human-readable process tree.
func printProcessTree(w io.Writer, paneID string, panePID int, nodes []processNode, hasAgent bool) {
	fmt.Fprintf(w, "Pane %s (PID %d)\n", paneID, panePID)
	for _, n := range nodes {
		printProcessNode(w, n, "")
	}
	if hasAgent {
		fmt.Fprintln(w, "\nAgent process detected.")
	}
}

// printProcessNode prints a single process node with indentation; the class
// tag is omitted for `other`.
func printProcessNode(w io.Writer, node processNode, indent string) {
	classification := ""
	if node.Classification != "other" {
		classification = fmt.Sprintf(" [%s]", node.Classification)
	}
	fmt.Fprintf(w, "%s%d %s%s\n", indent, node.PID, node.Comm, classification)
	for _, child := range node.Children {
		printProcessNode(w, child, indent+"  ")
	}
}
