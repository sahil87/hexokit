package main

import "rk/internal/codexstate"

// The same transcript projection is used by the hook and by tmux's live Codex
// reconciliation, so a pending question cannot be mistaken for an approval.
func codexHookState(in hookInput, token string) (string, bool) {
	return codexstate.HookState(codexstate.Input{
		SessionID: in.SessionID, TranscriptPath: in.TranscriptPath,
		TurnID: in.TurnID, Event: in.Event, Source: in.Source,
		ToolName: in.ToolName, ToolUseID: in.ToolUseID,
		ToolInput: in.ToolInput, ToolResponse: in.ToolResponse, Prompt: in.Prompt,
	}, token)
}
