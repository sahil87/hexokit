package tmux

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/codexstatus"
)

const codexStatusSession = "11111111-2222-4333-8444-555555555555"

func codexStatusTranscript(t *testing.T, records ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	head := `{"type":"session_meta","payload":{"id":"` + codexStatusSession + `","source":"cli"}}` + "\n"
	if err := os.WriteFile(path, []byte(head+strings.Join(records, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func codexThread(t *testing.T, path, status string) codexstatus.Thread {
	t.Helper()
	var thread codexstatus.Thread
	if err := json.Unmarshal([]byte(`{"status":`+status+`}`), &thread); err != nil {
		t.Fatal(err)
	}
	thread.ID, thread.Path = codexStatusSession, path
	return thread
}

func TestReconcileCodexWaiting(t *testing.T) {
	const stateEpoch int64 = 1700000000
	for _, tc := range []struct {
		name, status, want string
		records            []string
	}{
		{"approved tool still running", `{"type":"active","activeFlags":[]}`, AgentStateActive, nil},
		{"completed", `{"type":"idle"}`, AgentStateIdle, nil},
		{"approval pending", `{"type":"active","activeFlags":["waitingOnApproval"]}`, AgentStateWaiting, nil},
		{"runtime unknown", `{"type":"notLoaded"}`, AgentStateWaiting, nil},
		{"async question during tool", `{"type":"active","activeFlags":[]}`, AgentStateWaiting, []string{
			`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"question","delivery":"async","questions":[{}]}}}`,
		}},
		{"async question after steering", `{"type":"active","activeFlags":[]}`, AgentStateWaiting, []string{
			`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"question","delivery":"async","questions":[{}]}}}`,
			`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Also check the mobile layout."}]}}`,
		}},
		{"async question after turn", `{"type":"idle"}`, AgentStateWaiting, []string{
			`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"question","delivery":"async","questions":[{}]}}}`,
			`{"type":"event_msg","payload":{"type":"task_complete"}}`,
		}},
		{"blocking Plan question", `{"type":"active","activeFlags":[]}`, AgentStateWaiting, []string{
			`{"type":"turn_context","payload":{"turn_id":"turn","collaboration_mode":{"mode":"plan"}}}`,
			`{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call","arguments":"{\"questions\":[{}]}"}}`,
		}},
		{"malformed transcript", `{"type":"active","activeFlags":[]}`, AgentStateWaiting, []string{"{"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			thread := codexThread(t, codexStatusTranscript(t, tc.records...), tc.status)
			original := readCodexStatus
			t.Cleanup(func() { readCodexStatus = original })
			var called int
			readCodexStatus = func(_ context.Context, ids []string) map[string]codexstatus.Thread {
				called++
				if len(ids) != 1 || ids[0] != codexStatusSession {
					t.Errorf("queried IDs = %v", ids)
				}
				return map[string]codexstatus.Thread{codexStatusSession: thread}
			}
			panes := []PaneInfo{
				{AgentState: AgentStateWaiting, AgentStateEpoch: stateEpoch, AgentProvider: "codex", AgentSessionRef: codexStatusSession},
				{AgentState: AgentStateWaiting, AgentStateEpoch: stateEpoch, AgentProvider: "claude", AgentSessionRef: codexStatusSession},
				{AgentState: AgentStateActive, AgentStateEpoch: stateEpoch, AgentProvider: "codex", AgentSessionRef: codexStatusSession},
			}
			reconcileCodexWaiting(context.Background(), panes)
			if called != 1 || panes[0].AgentState != tc.want || panes[1].AgentState != AgentStateWaiting || panes[2].AgentState != AgentStateActive {
				t.Errorf("reconciled=%+v,calls=%d,want=%s", panes, called, tc.want)
			}
			wantEpoch := stateEpoch
			if tc.want != AgentStateWaiting {
				wantEpoch = 0
			}
			if panes[0].AgentStateEpoch != wantEpoch || panes[1].AgentStateEpoch != stateEpoch || panes[2].AgentStateEpoch != stateEpoch {
				t.Errorf("reconciled epochs=%d,%d,%d,want=%d,%d,%d", panes[0].AgentStateEpoch, panes[1].AgentStateEpoch, panes[2].AgentStateEpoch, wantEpoch, stateEpoch, stateEpoch)
			}
		})
	}
}

func TestReconcileCodexWaitingRequiresTranscriptOwnership(t *testing.T) {
	for _, kind := range []string{"missing", "different-session", "subagent", "partial-record"} {
		t.Run(kind, func(t *testing.T) {
			path := codexStatusTranscript(t)
			switch kind {
			case "missing":
				path = filepath.Join(t.TempDir(), "absent")
			case "different-session":
				_ = os.WriteFile(path, []byte(`{"type":"session_meta","payload":{"id":"another-session","source":"cli"}}`+"\n"), 0600)
			case "subagent":
				_ = os.WriteFile(path, []byte(`{"type":"session_meta","payload":{"id":"`+codexStatusSession+`","source":{"subagent":{"thread_spawn":{}}}}}`+"\n"), 0600)
			case "partial-record":
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = f.WriteString(`{"type":`)
				_ = f.Close()
			}
			original := readCodexStatus
			t.Cleanup(func() { readCodexStatus = original })
			readCodexStatus = func(context.Context, []string) map[string]codexstatus.Thread {
				return map[string]codexstatus.Thread{codexStatusSession: codexThread(t, path, `{"type":"active","activeFlags":[]}`)}
			}
			panes := []PaneInfo{{AgentState: AgentStateWaiting, AgentProvider: "codex", AgentSessionRef: codexStatusSession}}
			reconcileCodexWaiting(context.Background(), panes)
			if panes[0].AgentState != AgentStateWaiting {
				t.Fatalf("%s cleared waiting", kind)
			}
		})
	}
}

func TestCodexWaitingReadPathsAgree(t *testing.T) {
	for _, tc := range []struct {
		name, status, want string
		wantEpoch          int64
	}{
		{"resumed", `{"type":"active","activeFlags":[]}`, AgentStateActive, 0},
		{"completed", `{"type":"idle"}`, AgentStateIdle, 0},
		{"approval pending", `{"type":"active","activeFlags":["waitingOnApproval"]}`, AgentStateWaiting, 1700000000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server, _ := withRealSessionTmux(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
			if err != nil {
				t.Fatal(err)
			}
			paneID := lines[0]
			stateRaw := fmt.Sprintf("waiting:1700000000:%d", os.Getpid())
			for option, value := range map[string]string{AgentStateOption: stateRaw, AgentSessionOption: "codex:" + codexStatusSession} {
				if _, err := tmuxExecServer(ctx, server, "set-option", "-pt", paneID, option, value); err != nil {
					t.Fatal(err)
				}
			}
			thread := codexThread(t, codexStatusTranscript(t), tc.status)
			original := readCodexStatus
			t.Cleanup(func() { readCodexStatus = original })
			readCodexStatus = func(context.Context, []string) map[string]codexstatus.Thread {
				return map[string]codexstatus.Thread{codexStatusSession: thread}
			}
			facts, err := PaneFactsCtx(ctx, paneID, server)
			if err != nil || facts.AgentState != tc.want || facts.AgentStateEpoch != tc.wantEpoch || facts.AgentSessionRef != codexStatusSession {
				t.Fatalf("PaneFactsCtx=%+v,%v", facts, err)
			}
			state, err := PaneAgentState(ctx, paneID, server)
			if err != nil || state != tc.want {
				t.Fatalf("PaneAgentState=%q,%v", state, err)
			}
			windows, err := ListWindows(ctx, "real", server)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, window := range windows {
				for _, pane := range window.Panes {
					if pane.PaneID == paneID {
						found = true
						if pane.AgentState != tc.want || pane.AgentStateEpoch != tc.wantEpoch {
							t.Fatalf("ListWindows=%+v", pane)
						}
					}
				}
			}
			if !found {
				t.Fatal("target pane missing")
			}
			raw, err := tmuxExecRawServer(ctx, server, "show-options", "-pqv", "-t", paneID, AgentStateOption)
			if err != nil || strings.TrimSpace(raw) != stateRaw {
				t.Fatalf("read changed durable hook state: %q,%v", raw, err)
			}
		})
	}
}
