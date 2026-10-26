package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const (
	codexHookHeadLimit     = 64 << 10
	codexHookTailLimit     = 8 << 20
	codexQuestionTool      = "request_user_input"
	codexAsyncQuestionTool = "request_user_input_async"
	codexReplyStart        = "<send_user_message_question_reply>"
	codexReplyEnd          = "</send_user_message_question_reply>"
)

type codexHookContext struct {
	reject    bool
	reviewer  string
	mode      string
	questions map[string]bool
}

// PermissionRequest precedes Codex's reviewer decision, not necessarily a human
// dialog. Only the effective turn context can distinguish a human reviewer from
// auto_review; reading global config would miss session and turn overrides.
func codexHookState(in hookInput, token string) (string, bool) {
	c := readCodexHookContext(in)
	if c.reject {
		return "", false
	}
	switch in.Event {
	case "Interrupt", "SessionEnd":
		return agentStateIdle, true
	case "UserPromptSubmit":
		if !c.answer(in.Prompt) {
			return agentStateActive, true
		}
	case "SessionStart":
		if in.Source != "compact" {
			return token, true
		}
	case "PreToolUse":
		if in.ToolName == codexQuestionTool && c.mode == "plan" && codexHasQuestions(in.ToolInput) {
			return agentStateWaiting, true
		}
	case "PostToolUse":
		if in.ToolName == codexAsyncQuestionTool && codexQuestionAccepted(in.ToolResponse) && codexHasQuestions(in.ToolInput) {
			return agentStateWaiting, true
		}
	}
	if len(c.questions) > 0 {
		return agentStateWaiting, true
	}
	if token == agentStateWaiting && c.reviewer != "user" {
		return agentStateActive, true
	}
	return token, true
}

func codexHasQuestions(raw json.RawMessage) bool {
	var in struct {
		Questions []json.RawMessage `json:"questions"`
	}
	return json.Unmarshal(raw, &in) == nil && len(in.Questions) > 0
}

func codexQuestionAccepted(raw json.RawMessage) bool {
	// Hook tool_response is a string; tolerate a native JSON object as well.
	var s string
	if json.Unmarshal(raw, &s) == nil {
		raw = []byte(s)
	}
	var result struct {
		Accepted bool `json:"accepted"`
	}
	return json.Unmarshal(raw, &result) == nil && result.Accepted
}

// The metadata head proves ownership; the bounded tail provides current facts.
// Missing, truncated, or old context never manufactures a human permission wait.
// Questions/context older than the tail are intentionally unknown, not inferred
// from a different turn or from stale global configuration.
func readCodexHookContext(in hookInput) codexHookContext {
	c := codexHookContext{questions: map[string]bool{}}
	if !filepath.IsAbs(in.TranscriptPath) || !isValidSessionID(in.SessionID) {
		return c
	}
	// O_NONBLOCK prevents a raced-in FIFO from hanging before f.Stat can reject
	// it. Regular files ignore the flag. No transcript data is ever printed.
	f, err := os.OpenFile(in.TranscriptPath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return c
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return c
	}
	head, err := io.ReadAll(io.LimitReader(f, codexHookHeadLimit))
	if err != nil {
		return c
	}
	valid, reject := codexTranscriptOwner(head, in.SessionID)
	c.reject = reject
	if !valid || reject {
		return c
	}
	offset := max(int64(0), info.Size()-codexHookTailLimit)
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return c
	}
	tail, err := io.ReadAll(io.LimitReader(f, codexHookTailLimit))
	if err != nil {
		return c
	}
	if offset > 0 {
		_, tail, _ = bytes.Cut(tail, []byte{'\n'})
	}
	for {
		line, rest, complete := bytes.Cut(tail, []byte{'\n'})
		if !complete {
			break
		}
		c.consume(line, in.TurnID)
		tail = rest
	}
	return c
}

func codexTranscriptOwner(head []byte, sessionID string) (valid, reject bool) {
	line, _, complete := bytes.Cut(head, []byte{'\n'})
	if !complete {
		return false, false
	}
	var meta struct {
		Type    string `json:"type"`
		Payload struct {
			ID     string          `json:"id"`
			Source json.RawMessage `json:"source"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &meta) != nil || meta.Type != "session_meta" {
		return false, false
	}
	var source map[string]json.RawMessage
	_ = json.Unmarshal(meta.Payload.Source, &source)
	_, child := source["subagent"]
	return true, meta.Payload.ID != sessionID || child
}

func (c *codexHookContext) consume(line []byte, turnID string) {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil {
		return
	}
	switch record.Type {
	case "turn_context":
		var turn struct {
			TurnID   string `json:"turn_id"`
			Reviewer string `json:"approvals_reviewer"`
			Mode     struct {
				Mode string `json:"mode"`
			} `json:"collaboration_mode"`
		}
		if json.Unmarshal(record.Payload, &turn) == nil && turnID != "" && turn.TurnID == turnID {
			c.reviewer, c.mode = turn.Reviewer, turn.Mode.Mode
		}
	case "event_msg":
		c.consumeEvent(record.Payload)
	case "response_item":
		var item struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(record.Payload, &item) != nil || item.Type != "message" || item.Role != "user" {
			return
		}
		for _, part := range item.Content {
			if part.Text != "" && !c.answer(part.Text) {
				// A normal follow-up can answer or supersede a question without
				// using the question UI. It must not reappear on the next hook.
				clear(c.questions)
			}
		}
	}
}

func (c *codexHookContext) consumeEvent(raw json.RawMessage) {
	var event struct {
		Type string `json:"type"`
		Item struct {
			Type      string            `json:"type"`
			ID        string            `json:"id"`
			Delivery  string            `json:"delivery"`
			Questions []json.RawMessage `json:"questions"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return
	}
	if event.Type == "turn_aborted" {
		clear(c.questions)
	}
	if event.Type == "item_completed" && event.Item.Type == "AgentMessage" && event.Item.Delivery == "async" {
		for i := range event.Item.Questions {
			key, _ := json.Marshal([]any{codexAsyncQuestionTool, event.Item.ID, i})
			c.questions[string(key)] = true
		}
	}
}

// Replies identify individual questions, so answering one of several pending
// prompts must not clear the others. The hook prompt is consumed directly too:
// UserPromptSubmit can run before that message is flushed to the transcript.
func (c *codexHookContext) answer(text string) bool {
	_, body, ok := bytes.Cut([]byte(text), []byte(codexReplyStart))
	if !ok {
		return false
	}
	body, _, ok = bytes.Cut(body, []byte(codexReplyEnd))
	if !ok {
		return false
	}
	var answers []struct {
		ID string `json:"questionItemId"`
	}
	if json.Unmarshal(body, &answers) != nil {
		return false
	}
	for _, answer := range answers {
		var key []any
		if json.Unmarshal([]byte(answer.ID), &key) == nil {
			canonical, _ := json.Marshal(key)
			delete(c.questions, string(canonical))
		}
	}
	return true
}
