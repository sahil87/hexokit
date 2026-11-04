package codexstate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const session = "01a1760c-a599-77f1-a822-c9cd7ad96626"
const metadata = `{"type":"session_meta","payload":{"id":"01a1760c-a599-77f1-a822-c9cd7ad96626","source":"cli"}}`
const planContext = `{"type":"turn_context","payload":{"turn_id":"turn1","approvals_reviewer":"user","collaboration_mode":{"mode":"plan"}}}`
const blockingQuestion = `{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"question1","arguments":"{\"questions\":[{\"question\":\"Red or blue?\"}]}"}}`
const asyncQuestion = `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"question2","delivery":"async","questions":[{"title":"Tea or coffee?"}]}}}`

func transcript(t *testing.T, records ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(records, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadLatestContextPreservesQuestionLifetimes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		records []string
		pending bool
	}{
		{"no questions", nil, false},
		{"blocking", []string{blockingQuestion}, true},
		{"async", []string{asyncQuestion}, true},
		{"blocking result", []string{blockingQuestion, `{"type":"response_item","payload":{"type":"function_call_output","call_id":"question1","output":"done"}}`}, false},
		{"blocking turn complete", []string{blockingQuestion, `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn1"}}`}, false},
		{"async turn complete", []string{asyncQuestion, `{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn1"}}`}, true},
		{"newer plan turn", []string{strings.Replace(planContext, "turn1", "turn2", 1), blockingQuestion}, true},
		{"newer default turn", []string{strings.Replace(planContext, "plan", "default", 1), blockingQuestion}, false},
		{"interrupted", []string{blockingQuestion, asyncQuestion, `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn1"}}`}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			records := append([]string{metadata, planContext}, tc.records...)
			got := ReadContext(context.Background(), transcript(t, records...), session, "")
			if !got.QuestionStateKnown() || got.HasPendingQuestion() != tc.pending {
				t.Fatalf("known=%v pending=%v, want known=true pending=%v", got.QuestionStateKnown(), got.HasPendingQuestion(), tc.pending)
			}
		})
	}
}

func TestReadAsyncQuestionsRequireMatchingReplies(t *testing.T) {
	message := func(parts ...string) string {
		content := make([]map[string]string, 0, len(parts))
		for _, text := range parts {
			content = append(content, map[string]string{"type": "input_text", "text": text})
		}
		raw, err := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": content}})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	reply := func(index int) string {
		id, _ := json.Marshal([]any{codexAsyncQuestionTool, "question2", index})
		raw, _ := json.Marshal([]map[string]string{{"questionItemId": string(id), "answer": "Tea"}})
		return codexReplyStart + string(raw) + codexReplyEnd
	}
	questions := strings.Replace(asyncQuestion, `[{"title":"Tea or coffee?"}]`, `[{"title":"Tea or coffee?"},{"title":"Red or blue?"}]`, 1)
	for _, tc := range []struct {
		name    string
		records []string
		pending []int
	}{
		{"ordinary steering", []string{message("Also check the mobile layout.")}, []int{0, 1}},
		{"partial reply", []string{message(reply(0))}, []int{1}},
		{"mixed content partial reply", []string{message("Keep going.", reply(0), "Report the results.")}, []int{1}},
		{"steering after partial reply", []string{message(reply(0)), message("Keep going.")}, []int{1}},
		{"unmatched reply", []string{message(reply(2))}, []int{0, 1}},
		{"malformed reply", []string{message(codexReplyStart + "not JSON" + codexReplyEnd)}, []int{0, 1}},
		{"remaining reply", []string{message(reply(0)), message("Keep going."), message(reply(1))}, nil},
		{"explicit cancellation", []string{message("Keep going."), `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn1"}}`}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			records := append([]string{metadata, planContext, questions}, tc.records...)
			got := ReadContext(context.Background(), transcript(t, records...), session, "")
			if !got.QuestionStateKnown() || got.HasPendingQuestion() != (len(tc.pending) > 0) || len(got.questions) != len(tc.pending) {
				t.Fatalf("known=%v questions=%v, want pending indices=%v", got.QuestionStateKnown(), got.questions, tc.pending)
			}
			for _, index := range tc.pending {
				key, _ := json.Marshal([]any{codexAsyncQuestionTool, "question2", index})
				if !got.questions[string(key)] {
					t.Errorf("pending question %d was cleared", index)
				}
			}
		})
	}
}

func TestUnknownProjectionCannotClearAttention(t *testing.T) {
	for _, tc := range []struct {
		name    string
		records []string
	}{
		{"malformed JSON", []string{metadata, "not JSON"}},
		{"malformed event payload", []string{metadata, `{"type":"event_msg","payload":3}`}},
		{"malformed turn payload", []string{metadata, `{"type":"turn_context","payload":3}`}},
		{"malformed response payload", []string{metadata, `{"type":"response_item","payload":3}`}},
		{"missing metadata source", []string{`{"type":"session_meta","payload":{"id":"01a1760c-a599-77f1-a822-c9cd7ad96626"}}`}},
		{"child metadata", []string{strings.Replace(metadata, `"cli"`, `{"subagent":{"other":"guardian"}}`, 1)}},
		{"mismatched metadata", []string{strings.Replace(metadata, session, "another-session", 1)}},
		{"unverified blocking mode", []string{metadata, blockingQuestion}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Read(transcript(t, tc.records...), session, "")
			if got.QuestionStateKnown() {
				t.Fatal("unverified context could clear attention")
			}
		})
	}
	path := transcript(t, metadata, planContext)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.WriteString(`{"type":"response_item","payload":`); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	if Read(path, session, "").QuestionStateKnown() {
		t.Fatal("partial final record could clear attention")
	}
}

func TestProjectionBoundsAndCancellation(t *testing.T) {
	// A full root transcript can prove absence, while a bounded tail that has
	// discarded history cannot rule out an older unanswered async question.
	large := transcript(t, metadata, strings.Repeat("x", codexHookTailLimit), planContext)
	if Read(large, session, "").QuestionStateKnown() {
		t.Fatal("truncated history could clear attention")
	}
	for _, path := range []string{"", "relative.jsonl", t.TempDir(), filepath.Join(t.TempDir(), "missing")} {
		if Read(path, session, "").QuestionStateKnown() {
			t.Fatalf("unreadable %q could clear attention", path)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if ReadContext(ctx, transcript(t, metadata, planContext), session, "").QuestionStateKnown() {
		t.Fatal("cancelled read could clear attention")
	}
}
