package api

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

const testCodexRef = "01a06319-6a63-7791-84df-86736cd58e2e"

// stageCodexTranscript writes a fixture rollout under an isolated $CODEX_HOME.
func stageCodexTranscript(t *testing.T, ref string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	dayDir := filepath.Join(dir, "sessions", "2026", "09", "09")
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dayDir, "rollout-2026-09-09T10-00-00-"+ref+".jsonl")
	if err := os.WriteFile(path, []byte("{\"type\":\"session_meta\",\"session_id\":\""+ref+"\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// codexOperatorSessions mirrors operatorSessions("idle") with a codex subject.
func codexOperatorSessions() []sessions.ProjectSession {
	return []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "codex", WorktreePath: "/wt/project",
				AgentProvider: "codex", AgentSessionRef: testCodexRef,
				Panes: []tmux.PaneInfo{{PaneID: "%1", IsActive: true, AgentProvider: "codex", AgentSessionRef: testCodexRef}}},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", AgentState: "idle",
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
	}
}

// TestOperatorRequestCodexSubject: the fix-tab-name request for a codex
// subject resolves the codex rollout and delivers a prompt carrying its path.
func TestOperatorRequestCodexSubject(t *testing.T) {
	rollout := stageCodexTranscript(t, testCodexRef)
	stageFixtureTranscript(t, testTranscriptRef) // the operator's own transcript seam
	fastAgentSendProbe(t)
	// The multiline prompt collapses into a fresh paste chip post-paste
	// (absent from the baseline) — a legitimate probe pass.
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
	sf := &mockSessionFetcher{result: codexOperatorSessions()}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(ops.setAgentBufferText, rollout) {
		t.Errorf("delivered prompt must carry the codex rollout path %q, got: %s", rollout, ops.setAgentBufferText)
	}
	if strings.Contains(ops.setAgentBufferText, "capture-pane") {
		t.Errorf("prompt used pane capture despite a readable transcript: %s", ops.setAgentBufferText)
	}
}

func TestOperatorRequestCopilotSubjectUsesAgentPane(t *testing.T) {
	fastAgentSendProbe(t)
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "copilot", AgentProvider: "copilot", AgentSessionRef: "0dd0cf59-31dd-4565-9973-3b34f665b354",
				Panes: []tmux.PaneInfo{
					{PaneID: "%2", IsActive: true},
					{PaneID: "%1", AgentProvider: "copilot", AgentSessionRef: "0dd0cf59-31dd-4565-9973-3b34f665b354", AltScreen: true},
				}},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Role: "operator", AgentState: "idle",
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
	}}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(ops.setAgentBufferText, "tmux capture-pane -p -t %1 -S -30") {
		t.Errorf("prompt must target the agent pane in the split: %s", ops.setAgentBufferText)
	}
	if ops.pasteAgentPaneID != "%9" {
		t.Errorf("prompt delivered to %q, want operator pane %%9", ops.pasteAgentPaneID)
	}
}

// TestServerFactsCodexCorpus: a codex window with a resolvable rollout joins
// the server-scoped transcript corpus exactly like a claude window.
func TestServerFactsCodexCorpus(t *testing.T) {
	rollout := stageCodexTranscript(t, testCodexRef)
	facts := buildServerOperatorFacts(codexOperatorSessions(), "")
	if len(facts.Corpus) != 1 {
		t.Fatalf("corpus rows = %d, want 1 (the codex window)", len(facts.Corpus))
	}
	if facts.Corpus[0].TranscriptPath != rollout {
		t.Errorf("corpus path = %q, want %q", facts.Corpus[0].TranscriptPath, rollout)
	}
	if facts.Windows[0].TranscriptPath != rollout {
		t.Errorf("window fact path = %q, want %q", facts.Windows[0].TranscriptPath, rollout)
	}
}

// TestAutoNameEligibilityCodex: a busy→idle transition on a codex window earns
// an auto-name candidate exactly like claude — eligibility keys on the
// reconciled identity, not the provider.
func TestAutoNameEligibilityCodex(t *testing.T) {
	tr := newAutoNameTracker()
	server := "default"
	wins := []*tmux.WindowInfo{
		{WindowID: "@9", Role: "operator", AgentState: "idle"},
		{WindowID: "@1", AgentState: "active", AgentProvider: "codex", AgentSessionRef: testCodexRef},
	}
	tr.decide(server, wins) // baseline observation
	wins[1].AgentState = "idle"
	cand := tr.decide(server, wins)
	if cand == nil || cand.subject.WindowID != "@1" {
		t.Fatalf("a codex busy→idle transition must earn a candidate, got %+v", cand)
	}
}
