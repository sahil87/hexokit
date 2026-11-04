package tmux

import (
	"context"

	"rk/internal/codexstate"
	"rk/internal/codexstatus"
)

var readCodexStatus = codexstatus.Read

// PermissionRequest has no matching approval-answer hook. The existing read
// paths reconcile its waiting value against Codex's read-only runtime summary.
// Async questions can coexist with an active thread, so runtime alone cannot
// clear attention: the owning transcript must also prove no pending questions.
// No tmux write is made here; a later hook remains authoritative on every read.
func reconcileCodexWaiting(ctx context.Context, groups ...[]PaneInfo) {
	var ids []string
	for _, panes := range groups {
		for _, pane := range panes {
			if pane.AgentState == AgentStateWaiting && pane.AgentProvider == "codex" {
				ids = append(ids, pane.AgentSessionRef)
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, codexstatus.Timeout)
	defer cancel()
	states := make(map[string]string)
	for id, thread := range readCodexStatus(ctx, ids) {
		state := thread.ResumedState()
		if state == "" || ctx.Err() != nil {
			continue
		}
		projection := codexstate.ReadContext(ctx, thread.Path, id, "")
		if projection.QuestionStateKnown() && !projection.HasPendingQuestion() && ctx.Err() == nil {
			states[id] = state
		}
	}
	for _, panes := range groups {
		for i := range panes {
			pane := &panes[i]
			if pane.AgentState == AgentStateWaiting && pane.AgentProvider == "codex" && states[pane.AgentSessionRef] != "" {
				pane.AgentState = states[pane.AgentSessionRef]
				// The runtime summary has no transition timestamp; the previous
				// waiting epoch cannot date this active or idle state.
				pane.AgentStateEpoch = 0
			}
		}
	}
}
