package main

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/inject"
)

// Shared plumbing for the agent-launching commands (`rk tutorial`,
// `rk operator`): both spawn a window with the restored caller $TMUX and hand
// a kickoff prompt to the inject composite through a per-command delivery
// seam. The helpers are parameterized on the captured $TMUX value so each
// command keeps its own OriginalTMUX test seam.

// kickoffDeliverFn is the per-command delivery seam shape (tutorialDeliverFn /
// operatorDeliverFn): production drives inject.DeliverWhenReady; tests
// substitute a recorder so the command path runs tmux-free. opts carries the
// readiness wait's deadline and posture (e.g. WaitThroughWalls); the seam's
// production body merges its own invariants (the reconciled State reader) in.
type kickoffDeliverFn = func(ctx context.Context, engine *inject.Engine, t inject.Tmux, server, paneID, text string, opts inject.ReadyOpts) (inject.Readiness, error)

// deliverAgentKickoff hands a kickoff prompt to the shared inject composite:
// inject.DeliverWhenReady waits for boot readiness (agent state present, else
// a sentinel echo probe classifies the settled screen — a parked verdict is an
// error, so a walled pane is never delivered into) and then runs the engine's
// verified send (named-buffer bracketed paste, echo probe, probe-gated
// Enter). serverLabel is the tmux server the delivery's calls are addressed at
// (the caller derives it: cliServerLabel from a captured $TMUX, or the -L flag
// value). The CLI's per-invocation buffer (rk-send-<pid>, the `rk mux send`
// pattern) keeps a kickoff delivery from ever clobbering a concurrent
// daemon/mux-send buffer. The returned error is informational — callers
// degrade, it never fails the command. The context budget is opts.Deadline +
// cmdTimeout, so opts.Deadline must be set by the caller (zero would bound the
// whole delivery by cmdTimeout alone while AwaitReady's own default ran longer).
func deliverAgentKickoff(parent context.Context, deliver kickoffDeliverFn, serverLabel, paneID, prompt string, opts inject.ReadyOpts, cmdTimeout time.Duration) error {
	// The context outlives the readiness wait by one command timeout so the
	// engine's own bounded subprocesses still fit after a slow boot.
	ctx, cancel := context.WithTimeout(parent, opts.Deadline+cmdTimeout)
	defer cancel()
	engine := inject.NewEngine(muxBufferNameFn())
	_, err := deliver(ctx, engine, awaitReadyTmux{}, serverLabel, paneID, prompt, opts)
	return err
}

// cliServerLabel derives the tmux server label the delivery calls target from
// a captured $TMUX value (the muxServer derivation): the socket basename is
// the -L label, and an empty/default socket means the default server.
func cliServerLabel(originalTMUX string) string {
	socket := originalTMUX
	if i := strings.IndexByte(socket, ','); i >= 0 {
		socket = socket[:i]
	}
	if socket == "" {
		return "default"
	}
	return filepath.Base(socket)
}

// isPaneGoneErr is the inject.ReadyOpts.IsGone predicate shared by the
// pane-targeting waits (kickoff deliveries, rk mux await): tmux reports a
// vanished pane as "can't find pane", and the wait must end on it promptly
// rather than tolerate it until the deadline.
func isPaneGoneErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "can't find pane")
}
