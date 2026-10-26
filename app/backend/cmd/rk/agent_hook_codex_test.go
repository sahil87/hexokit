package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const codexTestSession = "01a1760c-a599-77f1-a822-c9cd7ad96626"

func codexTestTranscript(t *testing.T, source, reviewer string, records ...string) hookInput {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	body := fmt.Sprintf("{\"type\":\"session_meta\",\"payload\":{\"id\":%q,\"source\":%s}}\n", codexTestSession, source)
	body += fmt.Sprintf("{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"turn1\",\"approvals_reviewer\":%q,\"collaboration_mode\":{\"mode\":\"default\"}}}\n", reviewer)
	body += strings.Join(records, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return hookInput{SessionID: codexTestSession, TranscriptPath: path, TurnID: "turn1"}
}

func codexAppend(t *testing.T, in hookInput, record string) {
	t.Helper()
	f, err := os.OpenFile(in.TranscriptPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := fmt.Fprintln(f, record); err != nil {
		t.Fatal(err)
	}
}

func codexExpectState(t *testing.T, in hookInput, event, token, want string) {
	t.Helper()
	in.Event = event
	got, accept := codexHookState(in, token)
	if !accept || got != want {
		t.Fatalf("%s: state=%q accept=%v; want %q", event, got, accept, want)
	}
}

func TestCodexHookPermissionLifecycle(t *testing.T) {
	for _, reviewer := range []string{"auto_review", "user", "unknown", ""} {
		t.Run(reviewer, func(t *testing.T) {
			in := codexTestTranscript(t, `"cli"`, reviewer)
			codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateActive)
			want := agentStateActive
			if reviewer == "user" {
				want = agentStateWaiting
			}
			codexExpectState(t, in, "PermissionRequest", agentStateWaiting, want)
			codexExpectState(t, in, "PostToolUse", agentStateActive, agentStateActive)
			codexExpectState(t, in, "Stop", agentStateIdle, agentStateIdle)
		})
	}
	// A prior turn's reviewer is never used for a current permission event.
	in := codexTestTranscript(t, `"cli"`, "user")
	in.TurnID = "other-turn"
	codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateActive)
}

const codexAsyncQuestionRecord = `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"call1","delivery":"async","questions":[{"title":"Red or blue?"},{"title":"Tea or coffee?"}]}}}`

func codexReply(indices ...int) string {
	answers := []map[string]string{}
	for _, index := range indices {
		id, _ := json.Marshal([]any{codexAsyncQuestionTool, "call1", index})
		answers = append(answers, map[string]string{"questionItemId": string(id), "answer": "Red"})
	}
	raw, _ := json.Marshal(answers)
	return codexReplyStart + string(raw) + codexReplyEnd
}

func TestCodexHookAsyncQuestionLifecycle(t *testing.T) {
	in := codexTestTranscript(t, `"cli"`, "auto_review")
	in.ToolName = codexAsyncQuestionTool
	in.ToolInput = json.RawMessage(`{"questions":[{"title":"Red or blue?"}]}`)
	// An attempted call is not proof a question was accepted/displayed.
	codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateActive)
	in.ToolResponse = json.RawMessage(`"request_user_input_async is unavailable"`)
	codexExpectState(t, in, "PostToolUse", agentStateActive, agentStateActive)
	in.ToolResponse = json.RawMessage(`"{\"accepted\":true}"`)
	codexExpectState(t, in, "PostToolUse", agentStateActive, agentStateWaiting)
	codexAppend(t, in, codexAsyncQuestionRecord)
	in.ToolName = "Bash"
	for _, event := range []string{"PreToolUse", "PostToolUse", "PermissionRequest", "Stop"} {
		token := agentStateActive
		if event == "Stop" {
			token = agentStateIdle
		}
		codexExpectState(t, in, event, token, agentStateWaiting)
	}
	// A reply may arrive before the transcript flushes, and may answer only one
	// of several questions. The hook payload must win over stale disk contents.
	in.Prompt = codexReply(0)
	codexExpectState(t, in, "UserPromptSubmit", agentStateActive, agentStateWaiting)
	in.Prompt = codexReply(0, 1)
	codexExpectState(t, in, "UserPromptSubmit", agentStateActive, agentStateActive)
	replyRecord, _ := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": in.Prompt}}}})
	codexAppend(t, in, string(replyRecord))
	codexExpectState(t, in, "PostToolUse", agentStateActive, agentStateActive)
	codexExpectState(t, in, "Stop", agentStateIdle, agentStateIdle)
}

func TestCodexHookQuestionCancellationAndBlockingMode(t *testing.T) {
	in := codexTestTranscript(t, `"cli"`, "user", codexAsyncQuestionRecord)
	codexExpectState(t, in, "Interrupt", agentStateIdle, agentStateIdle)
	codexExpectState(t, in, "SessionEnd", agentStateIdle, agentStateIdle)
	codexAppend(t, in, `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn1"}}`)
	codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateActive)
	in.ToolName = codexQuestionTool
	in.ToolInput = json.RawMessage(`{"questions":[{"question":"Red or blue?"}]}`)
	// Codex emits PreToolUse but no PostToolUse for this rejected Default-mode
	// tool. Do not leave it waiting for a dialog that cannot open.
	codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateActive)
	codexAppend(t, in, `{"type":"turn_context","payload":{"turn_id":"turn1","approvals_reviewer":"user","collaboration_mode":{"mode":"plan"}}}`)
	codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateWaiting)
	codexExpectState(t, in, "PostToolUse", agentStateActive, agentStateActive)
}

func TestCodexHookPlainReplySupersedesAsyncQuestions(t *testing.T) {
	in := codexTestTranscript(t, `"cli"`, "auto_review", codexAsyncQuestionRecord)
	in.Prompt = "Red, and continue with the task."
	codexExpectState(t, in, "UserPromptSubmit", agentStateActive, agentStateActive)
	codexAppend(t, in, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Red, and continue with the task."}]}}`)
	codexExpectState(t, in, "PreToolUse", agentStateActive, agentStateActive)
	codexExpectState(t, in, "Stop", agentStateIdle, agentStateIdle)
}

func TestCodexHookRejectsChildAndMismatchedIdentity(t *testing.T) {
	for _, source := range []string{`{"subagent":{"other":"guardian"}}`, `{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}`} {
		t.Run(source, func(t *testing.T) {
			in := codexTestTranscript(t, source, "auto_review")
			in.Event = "Stop"
			raw, _ := json.Marshal(in)
			t.Setenv("TMUX_PANE", "%7")
			state, session := captureWrite(t), captureAgentSession(t)
			setHookStdin(t, string(raw))
			runAgentHook(context.Background(), "codex", agentStateIdle)
			if state.called || session.called {
				t.Fatal("child wrote pane state or root identity")
			}
		})
	}
	in := codexTestTranscript(t, `"cli"`, "user")
	in.SessionID = "another-session"
	if _, accept := codexHookState(in, agentStateWaiting); accept {
		t.Fatal("mismatched transcript accepted")
	}
	for _, source := range []string{"startup", "resume", "clear", "compact"} {
		in := codexTestTranscript(t, `"cli"`, "user")
		in.Source = source
		codexExpectState(t, in, "SessionStart", agentHookStampToken, agentHookStampToken)
	}
}

func TestCodexHookTranscriptBounds(t *testing.T) {
	in := codexTestTranscript(t, `"cli"`, "user")
	for _, path := range []string{"", "relative.jsonl", filepath.Join(t.TempDir(), "missing"), t.TempDir()} {
		in.TranscriptPath = path
		codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateActive)
	}
	in = codexTestTranscript(t, `"cli"`, "user")
	codexAppend(t, in, strings.Repeat("x", codexHookTailLimit))
	// The retained metadata is still read, but a reviewer outside the bounded
	// tail is unknown. A later matching context restores verified waiting.
	codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateActive)
	codexAppend(t, in, `{"type":"turn_context","payload":{"turn_id":"turn1","approvals_reviewer":"user"}}`)
	codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateWaiting)
	codexAppend(t, in, `{"type":"turn_context","payload":`)
	codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateWaiting)
	// Opening a FIFO without a writer must return immediately.
	fifo := filepath.Join(t.TempDir(), "fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	in.TranscriptPath = fifo
	codexExpectState(t, in, "PermissionRequest", agentStateWaiting, agentStateActive)
}

func TestClaudeHookLifecycleUnaffectedByCodexContext(t *testing.T) {
	t.Setenv("TMUX_PANE", "%7")
	rec := captureWrite(t)
	captureAgentSession(t)
	installFakeProcTree(t, map[int]fakeProc{})
	// Codex metadata fields on another provider must have no effect.
	in := codexTestTranscript(t, `{"subagent":{"other":"guardian"}}`, "auto_review")
	raw, _ := json.Marshal(in)
	setHookStdin(t, string(raw))
	for _, state := range []string{agentStateActive, agentStateWaiting, agentStateActive, agentStateIdle} {
		rec.called = false
		runAgentHook(context.Background(), "claude", state)
		if !rec.called || rec.state != state {
			t.Fatalf("Claude state=%q called=%v, want %q", rec.state, rec.called, state)
		}
	}
}
