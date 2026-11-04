// Package codexstate projects Codex lifecycle facts from bounded transcript reads.
// It serves both hook writes and read-time reconciliation without cached state.
package codexstate

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const (
	// These are the existing agent-state wire tokens; this leaf package cannot
	// import internal/tmux, which consumes its read-side projection.
	stateActive            = "active"
	stateWaiting           = "waiting"
	stateIdle              = "idle"
	codexHookHeadLimit     = 64 << 10
	codexHookTailLimit     = 8 << 20
	codexQuestionTool      = "request_user_input"
	codexAsyncQuestionTool = "request_user_input_async"
	codexReplyStart        = "<send_user_message_question_reply>"
	codexReplyEnd          = "</send_user_message_question_reply>"
)

// Input is the Codex subset of a lifecycle hook payload.
type Input struct {
	SessionID      string
	TranscriptPath string
	TurnID         string
	Event          string
	Source         string
	ToolName       string
	ToolUseID      string
	ToolInput      json.RawMessage
	ToolResponse   json.RawMessage
	Prompt         string
}

// Context is a point-in-time projection. An unknown projection can preserve a
// known pending question but cannot prove the absence of questions.
type Context struct {
	known             bool
	reject            bool
	reviewer          string
	mode              string
	questions         map[string]bool
	blockingQuestions map[string]bool
	projectBlocking   bool
}

// PermissionRequest precedes Codex's reviewer decision, not necessarily a human
// dialog. Only the effective turn context can distinguish a human reviewer from
// auto_review; reading global config would miss session and turn overrides.
func HookState(in Input, token string) (string, bool) {
	c := Read(in.TranscriptPath, in.SessionID, in.TurnID)
	if c.reject {
		return "", false
	}
	switch in.Event {
	case "Interrupt", "SessionEnd":
		return stateIdle, true
	case "UserPromptSubmit":
		c.answer(in.Prompt)
	case "Stop":
		clear(c.blockingQuestions)
	case "SessionStart":
		if in.Source != "compact" {
			return token, true
		}
	case "PreToolUse":
		if in.ToolName == codexQuestionTool && c.mode == "plan" && codexHasQuestions(in.ToolInput) {
			return stateWaiting, true
		}
	case "PostToolUse":
		if in.ToolName == codexQuestionTool {
			delete(c.blockingQuestions, in.ToolUseID)
		}
		if in.ToolName == codexAsyncQuestionTool && codexQuestionAccepted(in.ToolResponse) && codexHasQuestions(in.ToolInput) {
			return stateWaiting, true
		}
	}
	if c.HasPendingQuestion() {
		return stateWaiting, true
	}
	if token == stateWaiting && c.reviewer != "user" {
		return stateActive, true
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

// Read projects a transcript without a caller deadline; work remains byte bounded.
func Read(path, sessionID, turnID string) Context {
	return ReadContext(context.Background(), path, sessionID, turnID)
}

// ReadContext reads at most a 64 KiB metadata head and an 8 MiB tail. Empty
// turnID projects all turns in order, ending with the latest effective context.
// Only a complete validated root transcript can prove no questions are pending.
func ReadContext(ctx context.Context, path, sessionID, turnID string) Context {
	c := Context{questions: map[string]bool{}, blockingQuestions: map[string]bool{}}
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil || !filepath.IsAbs(path) || sessionID == "" {
		return c
	}
	// O_NONBLOCK prevents a raced-in FIFO from hanging before f.Stat rejects it.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return c
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return c
	}
	head, err := io.ReadAll(io.LimitReader(f, codexHookHeadLimit))
	if err != nil || ctx.Err() != nil {
		return c
	}
	valid, reject := codexTranscriptOwner(head, sessionID)
	c.reject = reject
	if !valid || reject {
		return c
	}
	offset := max(int64(0), info.Size()-codexHookTailLimit)
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return c
	}
	tail, err := io.ReadAll(io.LimitReader(f, codexHookTailLimit))
	if err != nil || ctx.Err() != nil {
		return c
	}
	c.known = offset == 0
	if offset > 0 {
		_, tail, _ = bytes.Cut(tail, []byte{'\n'})
	}
	c.consumeLines(ctx, tail, turnID)
	// A writer advancing the file while it is read invalidates a negative
	// answer; a subsequent read will observe the complete new snapshot.
	if after, err := f.Stat(); err != nil || after.Size() != info.Size() {
		c.known = false
	}
	return c
}

func (c *Context) consumeLines(ctx context.Context, tail []byte, turnID string) {
	for {
		if ctx.Err() != nil {
			c.known = false
			return
		}
		line, rest, complete := bytes.Cut(tail, []byte{'\n'})
		if !complete {
			if len(bytes.TrimSpace(tail)) != 0 {
				c.known = false
			}
			return
		}
		if len(bytes.TrimSpace(line)) != 0 {
			c.consume(line, turnID)
		}
		tail = rest
	}
}

// QuestionStateKnown reports whether the projection can establish that no
// question is pending. False means callers must preserve existing attention.
func (c Context) QuestionStateKnown() bool { return c.known && !c.reject }

// HasPendingQuestion includes both queued async questions and unresolved
// blocking question calls; their independent completion boundaries are retained.
func (c Context) HasPendingQuestion() bool {
	return len(c.questions) > 0 || len(c.blockingQuestions) > 0
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
	if json.Unmarshal(meta.Payload.Source, &source) == nil {
		if _, child := source["subagent"]; child {
			return true, true
		}
	}
	if meta.Payload.ID != sessionID {
		return true, true
	}
	var root string
	return json.Unmarshal(meta.Payload.Source, &root) == nil && root != "", false
}

func (c *Context) consume(line []byte, turnID string) {
	var record struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil || record.Type == "" || len(record.Payload) == 0 {
		c.known = false
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
		if json.Unmarshal(record.Payload, &turn) == nil {
			matches := turnID == "" || turn.TurnID == turnID
			c.projectBlocking = matches && turn.Mode.Mode == "plan"
			if matches {
				c.reviewer, c.mode = turn.Reviewer, turn.Mode.Mode
			}
		} else {
			c.known = false
		}
	case "event_msg":
		c.consumeEvent(record.Payload)
	case "response_item":
		c.consumeResponse(record.Payload)
	}
}

func (c *Context) consumeResponse(raw json.RawMessage) {
	var item struct {
		Type      string `json:"type"`
		Role      string `json:"role"`
		Name      string `json:"name"`
		CallID    string `json:"call_id"`
		Arguments string `json:"arguments"`
		Content   []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &item) != nil || item.Type == "" {
		c.known = false
		return
	}
	switch item.Type {
	case "function_call":
		if item.Name == codexQuestionTool && c.mode == "" {
			c.known = false
		}
		if c.projectBlocking && item.Name == codexQuestionTool && item.CallID != "" && codexHasQuestions([]byte(item.Arguments)) {
			c.blockingQuestions[item.CallID] = true
		}
	case "function_call_output":
		// Errors and cancellations resolve the invocation too. The result's
		// call ID prevents unrelated tool completions from clearing attention.
		delete(c.blockingQuestions, item.CallID)
	case "message":
		if item.Role != "user" {
			return
		}
		for _, part := range item.Content {
			c.answer(part.Text)
		}
	}
}

func (c *Context) consumeEvent(raw json.RawMessage) {
	var event struct {
		Type string `json:"type"`
		Item struct {
			Type      string            `json:"type"`
			ID        string            `json:"id"`
			Delivery  string            `json:"delivery"`
			Questions []json.RawMessage `json:"questions"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &event) != nil || event.Type == "" {
		c.known = false
		return
	}
	if event.Type == "turn_aborted" {
		clear(c.questions)
		clear(c.blockingQuestions)
	}
	if event.Type == "task_complete" {
		clear(c.blockingQuestions)
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
// Ordinary steering does not prove that a displayed question was dismissed.
func (c *Context) answer(text string) {
	_, body, ok := bytes.Cut([]byte(text), []byte(codexReplyStart))
	if !ok {
		return
	}
	body, _, ok = bytes.Cut(body, []byte(codexReplyEnd))
	if !ok {
		return
	}
	var answers []struct {
		ID string `json:"questionItemId"`
	}
	if json.Unmarshal(body, &answers) != nil {
		return
	}
	for _, answer := range answers {
		var key []any
		if json.Unmarshal([]byte(answer.ID), &key) == nil {
			canonical, _ := json.Marshal(key)
			delete(c.questions, string(canonical))
		}
	}
}
