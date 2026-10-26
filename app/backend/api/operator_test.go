package api

import (
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rk/internal/sessions"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// operatorReq builds a POST /operator-request request for subject window @1
// with the given body.
func operatorReq(body string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/windows/@1/operator-request", strings.NewReader(body))
}

// operatorSessions builds the two-window fixture: subject window @1 with a
// reconciled claude chat session plus worktree/fab facts, and the operator
// window @9 (Role "operator", rollup AgentState as given) with its chat on
// pane %9 — the only pane delivery may target.
func operatorSessions(agentState string) []sessions.ProjectSession {
	return []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "zsh", WorktreePath: "/wt/project",
				AgentProvider: "claude", AgentSessionRef: testTranscriptRef,
				FabChange: "260822-fih1-operator-request-fix-tab-name", FabStage: "apply",
				Panes: []tmux.PaneInfo{{PaneID: "%1", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", AgentState: agentState,
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
	}
}

// --- 400s: validation happens before any fetch or tmux call -----------------

// Invalid window IDs and bodies are rejected before injection.
func TestOperatorRequestGuards(t *testing.T) {
	cases := []struct {
		name string
		req  func() *http.Request
	}{
		{name: "invalid window ID", req: func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/api/windows/not-a-window/operator-request", strings.NewReader(`{"template":"fix-tab-name"}`))
		}},
		{name: "invalid JSON", req: func() *http.Request { return operatorReq(`{not json`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sf := &mockSessionFetcher{result: operatorSessions("idle")}
			ops := &mockTmuxOps{}
			router := NewTestRouter(slog.Default(), sf, ops, "host")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, tc.req())
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if len(ops.agentSendCalls) != 0 {
				t.Errorf("injection ran for invalid request: %v", ops.agentSendCalls)
			}
		})
	}
}

// TestOperatorRequestUnknownTemplate: a template id outside the closed registry
// is a 400 naming the id — the /options key-allowlist posture.
func TestOperatorRequestUnknownTemplate(t *testing.T) {
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"nuke-everything"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "nuke-everything") {
		t.Errorf("400 body = %s, want it to name the unknown template id", rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for an unknown template", ops.agentSendCalls)
	}
}

// --- 404s: resolution failures, no injection --------------------------------

// TestOperatorRequestSubjectNotFound: a subject window absent from the server is
// a 404 with no injection.
func TestOperatorRequestSubjectNotFound(t *testing.T) {
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Role: "operator"},
		}},
	}}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) with no subject window", ops.agentSendCalls)
	}
}

// TestOperatorRequestNoOperator: a server with no operator window is a 404
// ("no operator on this server") with no injection — the race backstop for the
// UI's degrade-to-absent gating.
func TestOperatorRequestNoOperator(t *testing.T) {
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", AgentProvider: "claude", AgentSessionRef: testTranscriptRef},
		}},
	}}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no operator on this server") {
		t.Errorf("404 body = %s, want the no-operator message", rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) with no operator", ops.agentSendCalls)
	}
}

// TestOperatorRequestSubjectNoAgentSessionRef: the fix-tab-name template
// declares the agent session ref as a required fact — a subject without a
// reconciled agent session is a 404 with no injection.
func TestOperatorRequestSubjectNoAgentSessionRef(t *testing.T) {
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "zsh"},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Role: "operator", AgentState: "idle",
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
	}}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for a chatless subject", ops.agentSendCalls)
	}
}

// TestOperatorRequestTranscriptNotFound: a resolvable-looking ref whose
// transcript is absent on disk is a 404 (same vocabulary as the chat read
// endpoints) with no injection.
func TestOperatorRequestTranscriptNotFound(t *testing.T) {
	stageEmptyConfigDir(t)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) with an unresolvable transcript", ops.agentSendCalls)
	}
}

// TestOperatorRequestOperatorNoAgentPane: an operator window with no reconciled
// agent pane cannot receive requests — 404, no injection.
func TestOperatorRequestOperatorNoAgentPane(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", AgentProvider: "claude", AgentSessionRef: testTranscriptRef,
				Panes: []tmux.PaneInfo{{PaneID: "%1", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Role: "operator", AgentState: "idle",
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true}}},
		}},
	}}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for a chatless operator", ops.agentSendCalls)
	}
}

// --- 409s: busy gate + probe failure ----------------------------------------

// A busy operator queues the validated window request without running any
// injection subprocesses.
func TestOperatorRequestBusyGate(t *testing.T) {
	for _, state := range []string{"active", "waiting"} {
		t.Run(state, func(t *testing.T) {
			stageFixtureTranscript(t, testTranscriptRef)
			sf := &mockSessionFetcher{result: operatorSessions(state)}
			ops := &mockTmuxOps{}
			server := &Server{logger: slog.Default(), sessions: sf, tmux: ops, hostname: "host"}
			router := server.buildRouter()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"queued":true`) {
				t.Errorf("202 body = %s, want queued outcome", rec.Body.String())
			}
			if len(ops.agentSendCalls) != 0 {
				t.Errorf("injection ran (%v) for a busy operator", ops.agentSendCalls)
			}
			queue, _ := operatorQueueState(server.sseHub.getOperatorQueue(), "default")
			if len(queue) != 1 || queue[0].template != "fix-tab-name" || queue[0].windowID != "@1" {
				t.Fatalf("queued requests = %+v, want fix-tab-name for @1", queue)
			}
		})
	}
}

func TestOperatorRequestBusyCoalescesDuplicate(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	server := &Server{
		logger:   slog.Default(),
		sessions: &mockSessionFetcher{result: operatorSessions(tmux.AgentStateActive)},
		tmux:     &mockTmuxOps{},
		hostname: "host",
	}
	router := server.buildRouter()
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("request %d status = %d, want 202; body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	queue, _ := operatorQueueState(server.sseHub.getOperatorQueue(), "default")
	if len(queue) != 1 {
		t.Fatalf("duplicate busy requests produced %d entries, want 1", len(queue))
	}
}

func TestOperatorRequestQueueFull(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	server := &Server{
		logger:   slog.Default(),
		sessions: &mockSessionFetcher{result: operatorSessions(tmux.AgentStateActive)},
		tmux:     &mockTmuxOps{},
		hostname: "host",
	}
	server.initSSEHub()
	queue := server.sseHub.getOperatorQueue()
	for i := 0; i < operatorQueueCap; i++ {
		if err := queue.enqueue("default", queuedOperatorRequest{
			template: "fix-tab-name",
			windowID: fmt.Sprintf("@%d", i+10),
		}); err != nil {
			t.Fatal(err)
		}
	}
	rec := httptest.NewRecorder()
	server.buildRouter().ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "operator queue is full") {
		t.Fatalf("body = %s, want queue-full message", rec.Body.String())
	}
}

func TestOperatorRequestValidationFailuresDoNotQueue(t *testing.T) {
	cases := []struct {
		name   string
		result []sessions.ProjectSession
		body   string
		server bool
		want   int
	}{
		{name: "unknown template", result: operatorSessions(tmux.AgentStateActive), body: `{"template":"unknown"}`, want: http.StatusBadRequest},
		{name: "missing subject", result: operatorSessions(tmux.AgentStateActive)[1:], body: `{"template":"fix-tab-name"}`, want: http.StatusNotFound},
		{name: "missing chat ref", result: []sessions.ProjectSession{
			{Name: "work", Windows: []tmux.WindowInfo{{WindowID: "@1"}}},
			{Name: "operator", Windows: []tmux.WindowInfo{{WindowID: "@9", Role: "operator", AgentState: tmux.AgentStateActive}}},
		}, body: `{"template":"fix-tab-name"}`, want: http.StatusNotFound},
		{name: "nothing waiting", result: operatorSessions(tmux.AgentStateActive), body: `{"template":"whats-stuck"}`, server: true, want: http.StatusConflict},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			server := &Server{
				logger:   slog.Default(),
				sessions: &mockSessionFetcher{result: test.result},
				tmux:     &mockTmuxOps{},
				hostname: "host",
			}
			server.initSSEHub()
			req := operatorReq(test.body)
			if test.server {
				req = serverOperatorReq(test.body)
			}
			rec := httptest.NewRecorder()
			server.buildRouter().ServeHTTP(rec, req)
			if rec.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, test.want, rec.Body.String())
			}
			queue, inFlight := operatorQueueState(server.sseHub.getOperatorQueue(), "default")
			if len(queue) != 0 || inFlight {
				t.Fatalf("validation failure queued work: queue=%+v inFlight=%v", queue, inFlight)
			}
		})
	}
}

// TestOperatorRequestProbeFailureWithholdsEnter: the pasted prompt never echoes
// → the structured 409 agent-send returns, and NO Enter reaches the operator
// pane.
func TestOperatorRequestProbeFailureWithholdsEnter(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{capturePaneResult: "some unrelated pane output"}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if ops.sendEnterCalled {
		t.Error("Enter was sent despite a failed probe (must be withheld)")
	}
	if !strings.Contains(rec.Body.String(), "Enter withheld") {
		t.Errorf("409 body = %s, want the structured probe error", rec.Body.String())
	}
}

func TestOperatorRequestSubmitUnverifiedConflict(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := unverifiedSubmitOps(t, "❯ ", "❯ [Pasted text #1 +9 lines]")
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "may or may not have been submitted") {
		t.Fatalf("body = %s, want submit-unconfirmed guidance", rec.Body.String())
	}
}

func TestOperatorRequestStagedFailureCode(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{
		capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"},
		sendEnterErr:       errors.New("client is read-only"),
	}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	assertConflictCode(t, rec, "staged_send_failure")
}

// --- 500 + 200 ---------------------------------------------------------------

// TestOperatorRequestFetchError: a FetchSessions failure is a 500
// (infrastructure fault), NOT a 404 — mirroring the chat endpoints.
func TestOperatorRequestFetchError(t *testing.T) {
	sf := &mockSessionFetcher{err: errors.New("tmux exploded")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestOperatorRequestSuccess: an idle operator receives the rendered prompt
// through the full injection sequence — baseline capture → set-buffer → paste →
// probe → Enter — every step targeting the OPERATOR's resolved pane %9 (never
// the subject's %1), and the rendered prompt carries the server-derived facts
// and NO client-supplied text (the body's extra field never reaches it).
func TestOperatorRequestSuccess(t *testing.T) {
	for _, state := range []string{"idle", ""} {
		t.Run("state="+state, func(t *testing.T) {
			fastAgentSendProbe(t)
			stageFixtureTranscript(t, testTranscriptRef)
			sf := &mockSessionFetcher{result: operatorSessions(state)}
			// The multiline prompt collapses into a fresh paste chip post-paste
			// (absent from the baseline) — a legitimate probe pass.
			ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
			router := NewTestRouter(slog.Default(), sf, ops, "host")

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, operatorReq(`{"template":"fix-tab-name"}`))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"ok":true`) {
				t.Errorf("200 body = %s, want {\"ok\":true}", rec.Body.String())
			}
			want := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer", "capture-pane", "send-keys", "capture-pane"}
			if strings.Join(ops.agentSendCalls, ",") != strings.Join(want, ",") {
				t.Errorf("injection order = %v, want %v", ops.agentSendCalls, want)
			}
			if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
				t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9 (never the subject's %%1)",
					ops.pasteAgentPaneID, ops.sendEnterPaneID)
			}
			prompt := ops.setAgentBufferText
			for _, want := range []string{
				"tmux window @1", `"zsh"`,
				"projects/someproj/" + testTranscriptRef + ".jsonl",
				"worktree /wt/project",
				"fab change 260822-fih1-operator-request-fix-tab-name at stage apply",
				"tmux rename-window -t @1",
				"Do not reply",
			} {
				if !strings.Contains(prompt, want) {
					t.Errorf("prompt missing %q:\n%s", want, prompt)
				}
			}
		})
	}
}

// --- the fix-tab-name render func --------------------------------------------

// TestRenderFixTabName: the template renders every derived fact plus the exact
// actuation command and the do-not-reply bound; the fab clause appears only
// when FabChange is non-empty.
func TestRenderFixTabName(t *testing.T) {
	facts := operatorFacts{
		WindowID:       "@5",
		Name:           "zsh",
		TranscriptPath: "/home/u/.claude/projects/p/ref.jsonl",
		WorktreePath:   "/wt/project",
	}
	prompt := renderFixTabName(facts)
	for _, want := range []string{
		"tmux window @5", `"zsh"`, "/home/u/.claude/projects/p/ref.jsonl",
		"worktree /wt/project", "tmux rename-window -t @5", "Do not reply",
		"already accurately describes",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "fab change") {
		t.Errorf("empty FabChange rendered a fab clause:\n%s", prompt)
	}

	facts.FabChange, facts.FabStage = "260822-fih1-operator-request-fix-tab-name", "apply"
	prompt = renderFixTabName(facts)
	if !strings.Contains(prompt, "fab change 260822-fih1-operator-request-fix-tab-name at stage apply") {
		t.Errorf("non-empty FabChange did not render the fab clause:\n%s", prompt)
	}
}

// --- the acceptsText lane ----------------------------------------------------

// serverOperatorReq builds a POST /api/operator-request request with the given
// body (server-scoped route — no subject window).
func serverOperatorReq(body string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "/api/operator-request", strings.NewReader(body))
}

// assertNoFetch posts body to the given route and asserts a 400 with ZERO
// session fetches — validation happens before any FetchSessions call.
func assertNoFetch(t *testing.T, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if sf.calls != 0 {
		t.Errorf("FetchSessions ran (%d times) for a rejected body", sf.calls)
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for a rejected body", ops.agentSendCalls)
	}
	return rec
}

// TestOperatorRequestTextOnClosedTemplate: text on a template that does not
// declare acceptsText is a 400 naming the closed template, with no fetch and
// no injection (the closed posture is the default).
func TestOperatorRequestTextOnClosedTemplate(t *testing.T) {
	rec := assertNoFetch(t, operatorReq(`{"template":"fix-tab-name","text":"evil client text"}`))
	if !strings.Contains(rec.Body.String(), "fix-tab-name") {
		t.Errorf("400 body = %s, want it to name the closed template", rec.Body.String())
	}
}

// TestServerOperatorRequestTextValidation: an acceptsText template with empty
// or whitespace-only text, or text over the 4096-byte cap, is a 400 with no
// fetch and no injection.
func TestServerOperatorRequestTextValidation(t *testing.T) {
	bodies := map[string]string{
		"missing text":    `{"template":"spawn-task"}`,
		"empty text":      `{"template":"spawn-task","text":""}`,
		"whitespace text": `{"template":"spawn-task","text":"   "}`,
		"over cap":        `{"template":"spawn-task","text":"` + strings.Repeat("x", operatorTextLimit+1) + `"}`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			assertNoFetch(t, serverOperatorReq(body))
		})
	}
	// Exactly at the cap passes validation (the request then proceeds to the
	// fetch/delivery path — asserted elsewhere).
}

// TestServerOperatorRequestWindowScopedTemplate: the server-scoped route 400s
// a window-scoped template id; the window-scoped route 400s a server-scoped id
// — each route serves exactly its scope.
func TestServerOperatorRequestCrossScope400(t *testing.T) {
	rec := assertNoFetch(t, serverOperatorReq(`{"template":"fix-tab-name"}`))
	if !strings.Contains(rec.Body.String(), "fix-tab-name") {
		t.Errorf("400 body = %s, want it to name the window-scoped id", rec.Body.String())
	}
	rec = assertNoFetch(t, operatorReq(`{"template":"spawn-task","text":"fix the flaky test"}`))
	if !strings.Contains(rec.Body.String(), "spawn-task") {
		t.Errorf("400 body = %s, want it to name the server-scoped id", rec.Body.String())
	}
}

// TestServerOperatorRequestNoOperator: a server with no operator window is a
// 404 ("no operator on this server") with no injection.
func TestServerOperatorRequestNoOperator(t *testing.T) {
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{{WindowID: "@1", Name: "zsh"}}},
	}}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"spawn-task","text":"fix the flaky test"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no operator on this server") {
		t.Errorf("404 body = %s, want the no-operator message", rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) with no operator", ops.agentSendCalls)
	}
}

// The server-scoped route maps the same busy rejection to a queued outcome.
func TestServerOperatorRequestBusyGate(t *testing.T) {
	for _, state := range []string{"active", "waiting"} {
		t.Run(state, func(t *testing.T) {
			sf := &mockSessionFetcher{result: operatorSessions(state)}
			ops := &mockTmuxOps{}
			server := &Server{logger: slog.Default(), sessions: sf, tmux: ops, hostname: "host"}
			router := server.buildRouter()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, serverOperatorReq(`{"template":"spawn-task","text":"fix the flaky test"}`))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"queued":true`) {
				t.Errorf("202 body = %s, want queued outcome", rec.Body.String())
			}
			if len(ops.agentSendCalls) != 0 {
				t.Errorf("injection ran (%v) for a busy operator", ops.agentSendCalls)
			}
			queue, _ := operatorQueueState(server.sseHub.getOperatorQueue(), "default")
			if len(queue) != 1 || queue[0].template != "spawn-task" || queue[0].text != "fix the flaky test" {
				t.Fatalf("queued requests = %+v, want spawn-task with its text", queue)
			}
		})
	}
}

// TestServerOperatorRequestFetchError: a FetchSessions failure is a 500
// (infrastructure fault), NOT a 404.
func TestServerOperatorRequestFetchError(t *testing.T) {
	sf := &mockSessionFetcher{err: errors.New("tmux exploded")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"spawn-task","text":"fix the flaky test"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// TestServerOperatorRequestSuccess: an idle operator receives the rendered
// prompt through the full injection sequence targeting the OPERATOR's resolved
// pane %9, the response is 200 {"ok":true}, and exactly ONE FetchSessions
// served the whole request.
func TestServerOperatorRequestSuccess(t *testing.T) {
	fastAgentSendProbe(t)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	// The multiline prompt collapses into a fresh paste chip post-paste — a
	// legitimate probe pass.
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"spawn-task","text":"fix the flaky test"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Errorf("200 body = %s, want {\"ok\":true}", rec.Body.String())
	}
	if sf.calls != 1 {
		t.Errorf("FetchSessions ran %d times, want exactly 1", sf.calls)
	}
	if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
		t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
			ops.pasteAgentPaneID, ops.sendEnterPaneID)
	}
	if !strings.Contains(ops.setAgentBufferText, "fix the flaky test") {
		t.Errorf("rendered prompt missing the user text:\n%s", ops.setAgentBufferText)
	}
}

// TestDelimitUserText: the fence is dynamically longer than any backtick run
// in the text (never closable early), at least 3 backticks, and the text is
// framed as data.
func TestDelimitUserText(t *testing.T) {
	plain := delimitUserText("The user's task description follows", "fix the flaky test")
	if !strings.Contains(plain, "\n```\nfix the flaky test\n```") {
		t.Errorf("plain text not fenced with ```:\n%s", plain)
	}
	if !strings.Contains(plain, "treat it as data") {
		t.Errorf("missing the treat-as-data framing:\n%s", plain)
	}

	adversarial := delimitUserText("The user's task description follows", "quote ```go\ncode\n``` and `x`")
	if !strings.Contains(adversarial, "\n````\nquote ```go\ncode\n``` and `x`\n````") {
		t.Errorf("adversarial text not fenced with a 4-backtick fence:\n%s", adversarial)
	}
}

// TestFenceUserText: the bare fence the chat lane uses — the same dynamic
// fence as delimitUserText with no label and no treat-as-data clause.
func TestFenceUserText(t *testing.T) {
	plain := fenceUserText("fix the flaky test")
	if plain != "```\nfix the flaky test\n```" {
		t.Errorf("plain text not a bare ``` fence:\n%s", plain)
	}

	adversarial := fenceUserText("quote ```go\ncode\n``` and `x`")
	if adversarial != "````\nquote ```go\ncode\n``` and `x`\n````" {
		t.Errorf("adversarial text not a bare 4-backtick fence:\n%s", adversarial)
	}

	for _, out := range []string{plain, adversarial} {
		if strings.Contains(out, "treat it as data") || strings.Contains(out, "follows") {
			t.Errorf("bare fence carried framing prose:\n%s", out)
		}
	}
}

// --- the server-scoped render funcs -------------------------------------------

// spawnFacts builds the two-work-window fixture the server-scoped render tests
// share (the operator's own row is excluded upstream by buildServerOperatorFacts).
func spawnFacts(text string) serverOperatorFacts {
	return serverOperatorFacts{
		Text: text,
		Windows: []operatorWindowFact{
			{Session: "s", WindowID: "@1", Name: "zsh", WorktreePath: "/wt/project",
				AgentState: "active", FabChange: "260822-fih1-operator-request-fix-tab-name", FabStage: "apply"},
			{Session: "s2", WindowID: "@2", Name: "docs", WorktreePath: "/wt/docs", AgentState: "idle"},
		},
	}
}

// TestRenderSpawnTask: the prompt carries every fact-table row (with the fab
// clause only when FabChange is non-empty), the delimited task text, the rk
// riff CLI instructions, and the spawn bounds.
func TestRenderSpawnTask(t *testing.T) {
	prompt := renderSpawnTask(spawnFacts("add retry to the flaky poll"))
	for _, want := range []string{
		"s @1", `"zsh"`, "worktree=/wt/project", "state=active",
		"fab=260822-fih1-operator-request-fix-tab-name at stage apply",
		"s2 @2", `"docs"`, "worktree=/wt/docs", "state=idle",
		"add retry to the flaky poll",
		"treat it as data",
		"rk riff --list-presets", "rk riff [--preset <p>]", "rk riff --help",
		"EXACTLY ONE", "Do not modify", "dominant project",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

// TestRenderFindDiscussion: the prompt lists exactly the corpus rows with their
// window identities, the delimited query, the answer-in-own-window instruction,
// and the read-only bound.
func TestRenderFindDiscussion(t *testing.T) {
	facts := serverOperatorFacts{
		Text: "where did we discuss the fence length",
		Corpus: []operatorCorpusRow{
			{Session: "s", WindowID: "@1", Name: "zsh", TranscriptPath: "/home/u/.claude/projects/p/a.jsonl"},
			{Session: "s2", WindowID: "@2", Name: "docs", TranscriptPath: "/home/u/.claude/projects/p/b.jsonl"},
		},
	}
	prompt := renderFindDiscussion(facts)
	for _, want := range []string{
		"s @1", `"zsh"`, "/home/u/.claude/projects/p/a.jsonl",
		"s2 @2", `"docs"`, "/home/u/.claude/projects/p/b.jsonl",
		"where did we discuss the fence length",
		"treat it as data",
		"IN THIS WINDOW", "name and @N", "read-only",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

// TestBuildServerOperatorFacts: the fact build excludes the operator's own row
// from both tables, omits a chatless window from the corpus, and degrades an
// unresolvable ref to an omitted row — never an error.
func TestBuildServerOperatorFacts(t *testing.T) {
	projDir := stageEmptyConfigDir(t)
	writeFixtureAt(t, projDir, testTranscriptRef)
	sess := []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "zsh", WorktreePath: "/wt/project", AgentState: "active",
				AgentProvider: "claude", AgentSessionRef: testTranscriptRef,
				FabChange: "260822-fih1-operator-request-fix-tab-name", FabStage: "apply"},
			{WindowID: "@2", Name: "plain", WorktreePath: "/wt/plain"},
			{WindowID: "@3", Name: "broken", AgentProvider: "claude", AgentSessionRef: "not-a-uuid"},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator",
				AgentProvider: "claude", AgentSessionRef: testTranscriptRef},
		}},
	}
	facts := buildServerOperatorFacts(sess, "the task")
	if len(facts.Windows) != 3 {
		t.Fatalf("Windows rows = %d, want 3 (all non-operator windows)", len(facts.Windows))
	}
	for _, row := range facts.Windows {
		if row.WindowID == "@9" {
			t.Errorf("operator's own row leaked into the routing table: %+v", row)
		}
	}
	if facts.Windows[0].FabChange != "260822-fih1-operator-request-fix-tab-name" {
		t.Errorf("fab facts not carried: %+v", facts.Windows[0])
	}
	if len(facts.Corpus) != 1 {
		t.Fatalf("Corpus rows = %d, want 1 (chatless and broken-ref windows omitted)", len(facts.Corpus))
	}
	row := facts.Corpus[0]
	if row.WindowID != "@1" || row.Session != "s" || row.Name != "zsh" {
		t.Errorf("corpus row identity = %+v, want s @1 zsh", row)
	}
	if !strings.Contains(row.TranscriptPath, "projects/someproj/"+testTranscriptRef+".jsonl") {
		t.Errorf("corpus row path = %q, want the resolved JSONL path", row.TranscriptPath)
	}
}

// --- the digest/triage/retire templates -------------------------------------

// TestServerOperatorRequestWhatsStuckNothingWaiting: a requiresWaiting template
// on a server with ZERO waiting fact rows is a 409 ("nothing is waiting on
// this server") with no injection — no no-op delivery.
func TestServerOperatorRequestWhatsStuckNothingWaiting(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"whats-stuck"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "nothing is waiting on this server") {
		t.Errorf("409 body = %s, want the nothing-waiting message", rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) with nothing waiting", ops.agentSendCalls)
	}
}

func TestServerOperatorRequestSubmitUnverifiedConflict(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sess := operatorSessions("idle")
	sess[0].Windows[0].AgentState = "waiting"
	sf := &mockSessionFetcher{result: sess}
	ops := unverifiedSubmitOps(t, "❯ ", "❯ [Pasted text #1 +9 lines]")
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"whats-stuck"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "may or may not have been submitted") {
		t.Fatalf("body = %s, want submit-unconfirmed guidance", rec.Body.String())
	}
}

func TestServerOperatorRequestStagedFailureCode(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sess := operatorSessions("idle")
	sess[0].Windows[0].AgentState = "waiting"
	sf := &mockSessionFetcher{result: sess}
	ops := &mockTmuxOps{
		capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"},
		sendEnterErr:       errors.New("client is read-only"),
	}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"whats-stuck"}`))
	assertConflictCode(t, rec, "staged_send_failure")
}

// TestServerOperatorRequestWhatsStuckSuccess: with a waiting window present the
// request delivers, and the rendered prompt carries ONLY the waiting row, both
// rk verbs (verified against `rk mux send --help` / `rk notify --help`), and
// the never-answer list.
func TestServerOperatorRequestWhatsStuckSuccess(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sess := operatorSessions("idle")
	sess[0].Windows[0].AgentState = "waiting"
	sess[0].Windows[0].AgentIdleDuration = "3m"
	sf := &mockSessionFetcher{result: sess}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"whats-stuck"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	prompt := ops.setAgentBufferText
	for _, want := range []string{
		"s @1", `"zsh"`, "state=waiting 3m",
		"projects/someproj/" + testTranscriptRef + ".jsonl",
		`rk mux send @N "<answer>" --answer`,
		`rk notify --title "<window-name>: stuck"`,
		"NEVER answer", "credential", "destructive", "ambiguous",
		"touch only the waiting windows listed",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "@9") {
		t.Errorf("operator's own row leaked into the triage prompt:\n%s", prompt)
	}
}

// TestServerOperatorRequestNewScopeGuards: the scope discriminator covers the
// new ids both directions — brief-me (server-scoped) on the window route and
// retire-tab (now retired — an unknown id) on the server route are 400s before
// any fetch.
func TestServerOperatorRequestNewScopeGuards(t *testing.T) {
	rec := assertNoFetch(t, operatorReq(`{"template":"brief-me"}`))
	if !strings.Contains(rec.Body.String(), "brief-me") {
		t.Errorf("400 body = %s, want it to name the server-scoped id", rec.Body.String())
	}
	rec = assertNoFetch(t, serverOperatorReq(`{"template":"retire-tab"}`))
	if !strings.Contains(rec.Body.String(), "unknown operator template") {
		t.Errorf("400 body = %s, want the unknown-template rejection", rec.Body.String())
	}
}

// TestServerOperatorRequestTextOnDigestTemplates: client text on brief-me /
// whats-stuck hits the closed-lane 400 (neither declares acceptsText) before
// any fetch.
func TestServerOperatorRequestTextOnDigestTemplates(t *testing.T) {
	for _, id := range []string{"brief-me", "whats-stuck"} {
		t.Run(id, func(t *testing.T) {
			rec := assertNoFetch(t, serverOperatorReq(`{"template":"`+id+`","text":"evil client text"}`))
			if !strings.Contains(rec.Body.String(), id) {
				t.Errorf("400 body = %s, want it to name the closed template", rec.Body.String())
			}
		})
	}
}

// TestBuildServerOperatorFactsDigestFields: the fact row carries the rolled-up
// duration, the PR rollup (PrURL-gated), and the per-row transcript path from
// the SAME resolution that fills the corpus; a broken ref degrades to a
// path-less row (still present), and the operator stays excluded.
func TestBuildServerOperatorFactsDigestFields(t *testing.T) {
	projDir := stageEmptyConfigDir(t)
	writeFixtureAt(t, projDir, testTranscriptRef)
	prURL := "https://github.com/o/r/pull/7"
	sess := []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "zsh", AgentState: "waiting", AgentIdleDuration: "3m",
				AgentProvider: "claude", AgentSessionRef: testTranscriptRef,
				PrURL: &prURL, PrState: "open", PrChecks: "pass", PrReview: "approved"},
			{WindowID: "@2", Name: "plain"},
			{WindowID: "@3", Name: "broken", AgentProvider: "claude", AgentSessionRef: "not-a-uuid"},
			// PR facts with NO PrURL must not leak into the row.
			{WindowID: "@4", Name: "orphan-pr", PrState: "open", PrChecks: "pass"},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", AgentState: "waiting"},
		}},
	}
	facts := buildServerOperatorFacts(sess, "")
	if len(facts.Windows) != 4 {
		t.Fatalf("Windows rows = %d, want 4 (all non-operator windows)", len(facts.Windows))
	}
	row := facts.Windows[0]
	if row.AgentIdleDuration != "3m" {
		t.Errorf("row @1 AgentIdleDuration = %q, want %q", row.AgentIdleDuration, "3m")
	}
	if row.PrState != "open" || row.PrChecks != "pass" || row.PrReview != "approved" {
		t.Errorf("row @1 PR rollup = %+v, want open/pass/approved", row)
	}
	if !strings.Contains(row.TranscriptPath, "projects/someproj/"+testTranscriptRef+".jsonl") {
		t.Errorf("row @1 TranscriptPath = %q, want the resolved JSONL path", row.TranscriptPath)
	}
	if row.TranscriptPath != facts.Corpus[0].TranscriptPath {
		t.Errorf("row path %q != corpus path %q (one resolution fills both)", row.TranscriptPath, facts.Corpus[0].TranscriptPath)
	}
	if row := facts.Windows[1]; row.TranscriptPath != "" || row.PrState != "" {
		t.Errorf("chatless row @2 = %+v, want no path and no PR facts", row)
	}
	if row := facts.Windows[2]; row.WindowID != "@3" || row.TranscriptPath != "" {
		t.Errorf("broken-ref row = %+v, want @3 present with an empty path", row)
	}
	if row := facts.Windows[3]; row.PrState != "" || row.PrChecks != "" || row.PrReview != "" {
		t.Errorf("row @4 (PrState without PrURL) = %+v, want the PR rollup withheld", row)
	}
	for _, row := range facts.Windows {
		if row.WindowID == "@9" {
			t.Errorf("operator's own row leaked into the fact table: %+v", row)
		}
	}
}

// TestRenderBriefMe: the prompt lists every row waiting-first (then active,
// then idle/unknown), with the fab/PR clauses when present, the transcript
// path or the unavailable note per row, the transcript-tail instruction (never
// capture-pane), the waiting-on-me-first digest spec, the own-window
// instruction, and the read-only bounds. An empty table stays deliverable.
func TestRenderBriefMe(t *testing.T) {
	facts := serverOperatorFacts{Windows: []operatorWindowFact{
		{Session: "s", WindowID: "@3", Name: "idle-tab", AgentState: "idle", TranscriptPath: "/t/idle.jsonl"},
		{Session: "s", WindowID: "@1", Name: "wait-tab", AgentState: "waiting", AgentIdleDuration: "3m",
			TranscriptPath: "/t/wait.jsonl",
			FabChange:      "260822-rfz2-operator-digest-stuck-retire", FabStage: "apply",
			PrState: "open", PrChecks: "pass", PrReview: "approved"},
		{Session: "s", WindowID: "@2", Name: "active-tab", AgentState: "active"},
	}}
	prompt := renderBriefMe(facts)
	i1, i2, i3 := strings.Index(prompt, "@1"), strings.Index(prompt, "@2"), strings.Index(prompt, "@3")
	if i1 < 0 || i2 < 0 || i3 < 0 || !(i1 < i2 && i2 < i3) {
		t.Errorf("rows not ordered waiting → active → idle (@1=%d @2=%d @3=%d):\n%s", i1, i2, i3, prompt)
	}
	for _, want := range []string{
		"state=waiting 3m", "state=active", "state=idle",
		"fab=260822-rfz2-operator-digest-stuck-retire at stage apply",
		"pr=open checks=pass review=approved",
		"/t/wait.jsonl", "/t/idle.jsonl", "transcript unavailable",
		"NEVER capture-pane", "one line per tab", "waiting-on-me first",
		"suggested next action", "IN THIS WINDOW", "read-only",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}

	empty := renderBriefMe(serverOperatorFacts{})
	if !strings.Contains(empty, "nothing to report") {
		t.Errorf("empty table prompt = %q, want a trivially-answerable nothing-to-report prompt", empty)
	}
}

// TestRenderWhatsStuck: the prompt filters to ONLY the waiting rows, names
// both rk verbs verbatim, and carries the hard never-answer list.
func TestRenderWhatsStuck(t *testing.T) {
	facts := serverOperatorFacts{Windows: []operatorWindowFact{
		{Session: "s", WindowID: "@1", Name: "wait-a", AgentState: "waiting", TranscriptPath: "/t/a.jsonl"},
		{Session: "s", WindowID: "@2", Name: "active-b", AgentState: "active"},
		{Session: "s2", WindowID: "@3", Name: "wait-c", AgentState: "waiting", AgentIdleDuration: "5m"},
	}}
	prompt := renderWhatsStuck(facts)
	for _, want := range []string{
		"s @1", `"wait-a"`, "/t/a.jsonl",
		"s2 @3", `"wait-c"`, "state=waiting 5m", "transcript unavailable",
		`rk mux send @N "<answer>" --answer`,
		`rk notify --title "<window-name>: stuck" "<the pending question>"`,
		"NEVER answer", "credential", "destructive", "ambiguous", "escalate",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "@2") || strings.Contains(prompt, "active-b") {
		t.Errorf("non-waiting row leaked into the triage prompt:\n%s", prompt)
	}
}

// --- the color-tabs template -------------------------------------------------

// TestRenderColorTabs: the prompt carries every row with its labels clause
// (unset channels as "-"), the transcript path or the fallback instruction,
// the suggested scheme, all three closed vocabularies verbatim, the unset
// form, the judgment clauses, the repaint note, and the bounds.
func TestRenderColorTabs(t *testing.T) {
	facts := serverOperatorFacts{Windows: []operatorWindowFact{
		{Session: "s", WindowID: "@1", Name: "feature-work", WorktreePath: "/wt/project",
			AgentState: "active", Color: "blue", Marker: "manual:1",
			TranscriptPath: "/t/feature.jsonl",
			FabChange:      "260824-4940-operator-semantic-tab-coloring", FabStage: "apply"},
		{Session: "s2", WindowID: "@2", Name: "scratch", WorktreePath: "/wt/scratch", AgentState: "idle"},
	}}
	prompt := renderColorTabs(facts)
	for _, want := range []string{
		"s @1", `"feature-work"`, "worktree=/wt/project", "state=active",
		"fab=260824-4940-operator-semantic-tab-coloring at stage apply",
		"labels: color=blue marker=manual:1 flair=-",
		"/t/feature.jsonl",
		"s2 @2", `"scratch"`, "labels: color=- marker=- flair=-",
		"transcript unavailable",
		"NEVER capture-pane", "rk mux capture @N",
		"feature → blue", "bugfix → red", "infra/tooling → slate", "docs → teal", "experiments → purple",
		"ONE coherent scheme",
		"tmux set-option -t @N '@rk_win_color' '<value>'",
		"red orange amber olive green teal blue purple magenta slate",
		"-dark or -light",
		"tmux set-option -t @N '@rk_win_marker' '<value>'",
		"manual manual:1 manual:2 manual:3 auto auto:1 auto:2 auto:3 blocked blocked:1 blocked:2 blocked:3",
		"Marker mode describes how the label was assigned",
		"tmux set-option -t @N '@rk_win_flair' '<value>'",
		"rain scan nyan naruto onepiece pacman matrix aquarium nemo roadrunner invaders cube warp spidey ironman noon",
		"tmux set-option -t @N -u '@rk_win_color'",
		"DO NOTHING", "already fit", "reversible via the label picker",
		"~15 seconds",
		"set only the three named options", "Do not rename, kill, or send keys", "Do not reply",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}

	// The prompt's marker/flair vocabularies must match the validate closed
	// sets exactly (drift guard — the renderer writes them as literals). The
	// rendered list is the parenthesized run after the option's set-option
	// line; parse it and compare sets so an extra, removed, or misspelled
	// token fails — a bare substring check would not.
	promptVocab := func(option string) map[string]bool {
		t.Helper()
		anchor := "'" + option + "' '<value>'"
		i := strings.Index(prompt, anchor)
		if i < 0 {
			t.Fatalf("prompt missing set-option line for %s:\n%s", option, prompt)
		}
		rest := prompt[i+len(anchor):]
		open, close := strings.Index(rest, "("), strings.Index(rest, ")")
		if open < 0 || close < open {
			t.Fatalf("prompt missing vocabulary list for %s:\n%s", option, prompt)
		}
		vocab := make(map[string]bool)
		for _, token := range strings.Fields(rest[open+1 : close]) {
			vocab[token] = true
		}
		return vocab
	}
	closedSetTokens := func(set map[string]bool) map[string]bool {
		tokens := make(map[string]bool)
		for token := range set {
			if token != "" {
				tokens[token] = true
			}
		}
		return tokens
	}
	if got, want := promptVocab("@rk_win_marker"), closedSetTokens(validate.MarkerValues); !maps.Equal(got, want) {
		t.Errorf("prompt marker vocabulary = %v, want validate.MarkerValues %v", got, want)
	}
	if got, want := promptVocab("@rk_win_flair"), closedSetTokens(validate.FlairValues); !maps.Equal(got, want) {
		t.Errorf("prompt flair vocabulary = %v, want validate.FlairValues %v", got, want)
	}

	empty := renderColorTabs(serverOperatorFacts{})
	if !strings.Contains(empty, "nothing to color") {
		t.Errorf("empty table prompt = %q, want a trivially-answerable nothing-to-color prompt", empty)
	}
}

// TestRenderDigestTemplatesIgnoreLabelFields: the fact-row label extension
// must not drift the existing templates — digest/spawn renders are
// byte-identical whether or not the label fields are populated.
func TestRenderDigestTemplatesIgnoreLabelFields(t *testing.T) {
	base := operatorWindowFact{Session: "s", WindowID: "@1", Name: "zsh", WorktreePath: "/wt/project",
		AgentState: "waiting", AgentIdleDuration: "3m", TranscriptPath: "/t/a.jsonl"}
	labeled := base
	labeled.Color, labeled.Marker, labeled.Flair = "blue", "manual:1", "nyan"

	for name, render := range map[string]func(serverOperatorFacts) string{
		"brief-me":   renderBriefMe,
		"spawn-task": renderSpawnTask,
	} {
		plain := render(serverOperatorFacts{Windows: []operatorWindowFact{base}})
		withLabels := render(serverOperatorFacts{Windows: []operatorWindowFact{labeled}})
		if plain != withLabels {
			t.Errorf("%s output drifted when label fields were populated:\n--- without ---\n%s\n--- with ---\n%s", name, plain, withLabels)
		}
		if strings.Contains(withLabels, "labels:") || strings.Contains(withLabels, "nyan") {
			t.Errorf("%s rendered the label fields:\n%s", name, withLabels)
		}
	}
}

// TestBuildServerOperatorFactsLabelFields: the fact row carries the window's
// current Color (dereferenced, "" when nil), Marker, and Flair from the same
// fetch.
func TestBuildServerOperatorFactsLabelFields(t *testing.T) {
	blue := "blue"
	sess := []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "labeled", Color: &blue, Marker: "manual:1"},
			{WindowID: "@2", Name: "unlabeled"},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", Color: &blue, Marker: "blocked:3", Flair: "nyan"},
		}},
	}
	facts := buildServerOperatorFacts(sess, "")
	if len(facts.Windows) != 2 {
		t.Fatalf("Windows rows = %d, want 2 (operator excluded)", len(facts.Windows))
	}
	if row := facts.Windows[0]; row.Color != "blue" || row.Marker != "manual:1" || row.Flair != "" {
		t.Errorf("row @1 labels = %+v, want color=blue marker=manual:1 flair=\"\"", row)
	}
	if row := facts.Windows[1]; row.Color != "" || row.Marker != "" || row.Flair != "" {
		t.Errorf("row @2 labels = %+v, want all empty (nil Color derefs to \"\")", row)
	}
}

// TestServerOperatorRequestColorTabsSuccess: color-tabs on the server route
// delivers through the unchanged seam — 200 {"ok":true}, exactly ONE
// FetchSessions, injection targeting the operator's pane, and the rendered
// prompt carrying the rows' labels clauses and the actuation commands.
func TestServerOperatorRequestColorTabsSuccess(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sess := operatorSessions("idle")
	blue := "blue"
	sess[0].Windows[0].Color = &blue
	sess[0].Windows[0].Marker = "manual:1"
	sf := &mockSessionFetcher{result: sess}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"color-tabs"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Errorf("200 body = %s, want {\"ok\":true}", rec.Body.String())
	}
	if sf.calls != 1 {
		t.Errorf("FetchSessions ran %d times, want exactly 1", sf.calls)
	}
	if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
		t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
			ops.pasteAgentPaneID, ops.sendEnterPaneID)
	}
	prompt := ops.setAgentBufferText
	for _, want := range []string{
		"s @1", `"zsh"`, "labels: color=blue marker=manual:1 flair=-",
		"projects/someproj/" + testTranscriptRef + ".jsonl",
		"tmux set-option -t @N '@rk_win_color' '<value>'",
		"Do not reply",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "@9") {
		t.Errorf("operator's own row leaked into the color-tabs prompt:\n%s", prompt)
	}
}

// TestServerOperatorRequestColorTabsGuards: client text on color-tabs hits the
// closed-lane 400, and color-tabs on the window-scoped route is a 400 — both
// before any fetch.
func TestServerOperatorRequestColorTabsGuards(t *testing.T) {
	rec := assertNoFetch(t, serverOperatorReq(`{"template":"color-tabs","text":"evil client text"}`))
	if !strings.Contains(rec.Body.String(), "color-tabs") {
		t.Errorf("400 body = %s, want it to name the closed template", rec.Body.String())
	}
	rec = assertNoFetch(t, operatorReq(`{"template":"color-tabs"}`))
	if !strings.Contains(rec.Body.String(), "color-tabs") {
		t.Errorf("400 body = %s, want it to name the server-scoped id", rec.Body.String())
	}
}

// --- the annotate-tab template ----------------------------------------------

// TestRenderAnnotateTab: the template renders every derived fact plus the exact
// epoch-prefixed set-option actuation, the ~100-char bound, the skip-when-
// nothing-meaningful clause, and the do-not-reply bound; the fab clause appears
// only when FabChange is non-empty.
func TestRenderAnnotateTab(t *testing.T) {
	facts := operatorFacts{
		WindowID:       "@5",
		Name:           "zsh",
		TranscriptPath: "/home/u/.claude/projects/p/ref.jsonl",
		WorktreePath:   "/wt/project",
	}
	prompt := renderAnnotateTab(facts)
	for _, want := range []string{
		"tmux window @5", `"zsh"`, "/home/u/.claude/projects/p/ref.jsonl",
		"worktree /wt/project",
		`tmux set-option -wt @5 @rk_win_note "$(date +%s):<one-line note>"`,
		"100 characters", "nothing meaningful", "Do not reply",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "fab change") {
		t.Errorf("empty FabChange rendered a fab clause:\n%s", prompt)
	}

	facts.FabChange, facts.FabStage = "260824-bb5n-tab-status-note", "apply"
	prompt = renderAnnotateTab(facts)
	if !strings.Contains(prompt, "fab change 260824-bb5n-tab-status-note at stage apply") {
		t.Errorf("non-empty FabChange did not render the fab clause:\n%s", prompt)
	}
}

// TestAnnotateTabScopeGuards: annotate-tab is window-scoped — the server-scoped
// route 400s it before any fetch, and client text hits the closed-lane 400
// (no acceptsText).
func TestAnnotateTabScopeGuards(t *testing.T) {
	rec := assertNoFetch(t, serverOperatorReq(`{"template":"annotate-tab"}`))
	if !strings.Contains(rec.Body.String(), "annotate-tab") {
		t.Errorf("400 body = %s, want it to name the window-scoped id", rec.Body.String())
	}
	rec = assertNoFetch(t, operatorReq(`{"template":"annotate-tab","text":"evil client text"}`))
	if !strings.Contains(rec.Body.String(), "annotate-tab") {
		t.Errorf("400 body = %s, want it to name the closed template", rec.Body.String())
	}
}

// --- the update-annotations template -----------------------------------------

// TestRenderUpdateAnnotations: the prompt carries every row via the digest row
// writer (with the operator's own row excluded by construction — renders only
// receive non-operator facts), the transcript-tail read instruction with the
// capture fallback, the exact epoch-prefixed @rk_win_note actuation with the
// ~100-char bound, the skip-if-nothing-meaningful clause, the repaint note,
// and the write-only bounds. An empty table stays deliverable.
func TestRenderUpdateAnnotations(t *testing.T) {
	facts := serverOperatorFacts{Windows: []operatorWindowFact{
		{Session: "s", WindowID: "@1", Name: "zsh", AgentState: "waiting", AgentIdleDuration: "3m",
			TranscriptPath: "/t/zsh.jsonl", WorktreePath: "/wt/project",
			FabChange: "260827-8n6k-update-annotations-tile-note", FabStage: "apply"},
		{Session: "s", WindowID: "@2", Name: "plain", AgentState: "idle"},
	}}
	prompt := renderUpdateAnnotations(facts)
	for _, want := range []string{
		"s @1", `"zsh"`, "state=waiting 3m", "/t/zsh.jsonl",
		"fab=260827-8n6k-update-annotations-tile-note at stage apply",
		"s @2", `"plain"`, "transcript unavailable",
		"NEVER capture-pane", "rk mux capture @N",
		`tmux set-option -wt @N @rk_win_note "$(date +%s):<one-line note>"`,
		"100 characters", "skip its write", "repaint within ~15 seconds",
		"only @rk_win_note", "Do not reply",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "-u @rk_win_note") {
		t.Errorf("the unset form leaked into the write-only prompt:\n%s", prompt)
	}

	empty := renderUpdateAnnotations(serverOperatorFacts{})
	if !strings.Contains(empty, "nothing to annotate") {
		t.Errorf("empty table prompt = %q, want a trivially-answerable prompt", empty)
	}
}

// TestUpdateAnnotationsGuards: the template is server-scoped (window route
// 400s it naming the id) and carries no acceptsText (client text hits the
// closed-lane 400) — both before any fetch.
func TestUpdateAnnotationsGuards(t *testing.T) {
	rec := assertNoFetch(t, operatorReq(`{"template":"update-annotations"}`))
	if !strings.Contains(rec.Body.String(), "update-annotations") {
		t.Errorf("400 body = %s, want it to name the server-scoped id", rec.Body.String())
	}
	rec = assertNoFetch(t, serverOperatorReq(`{"template":"update-annotations","text":"evil client text"}`))
	if !strings.Contains(rec.Body.String(), "update-annotations") {
		t.Errorf("400 body = %s, want it to name the closed template", rec.Body.String())
	}
}

// TestServerOperatorRequestUpdateAnnotationsSuccess: the template delivers
// through the unchanged seam — 200 {"ok":true}, exactly ONE FetchSessions,
// injection targeting the operator's pane, and the rendered prompt carrying
// the row and the @rk_win_note actuation.
func TestServerOperatorRequestUpdateAnnotationsSuccess(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"update-annotations"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if sf.calls != 1 {
		t.Errorf("FetchSessions ran %d times, want exactly 1", sf.calls)
	}
	if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
		t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
			ops.pasteAgentPaneID, ops.sendEnterPaneID)
	}
	prompt := ops.setAgentBufferText
	for _, want := range []string{
		"s @1", `"zsh"`,
		"projects/someproj/" + testTranscriptRef + ".jsonl",
		`tmux set-option -wt @N @rk_win_note "$(date +%s):<one-line note>"`,
		"Do not reply",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "@9") {
		t.Errorf("operator's own row leaked into the prompt:\n%s", prompt)
	}
}

// TestServerOperatorRequestSessionLane: the optional session field scopes the
// fact rows on a declaring template — a known name is filtered consumer-side
// (only that session's rows render), an unknown name is the route's
// absent-entity 404, and a non-empty session on a non-declaring template is
// the closed-lane 400 BEFORE any fetch.
func TestServerOperatorRequestSessionLane(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sess := operatorSessions("idle")
	sess[0].Name = "run-kit"
	sess = append(sess, sessions.ProjectSession{Name: "other", Windows: []tmux.WindowInfo{
		{WindowID: "@3", Name: "elsewhere"},
	}})

	// Known session — only its rows render.
	sf := &mockSessionFetcher{result: sess}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"update-annotations","session":"run-kit"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	prompt := ops.setAgentBufferText
	if !strings.Contains(prompt, "run-kit @1") {
		t.Errorf("scoped prompt missing the run-kit row:\n%s", prompt)
	}
	if strings.Contains(prompt, "elsewhere") {
		t.Errorf("scoped prompt carried another session's row:\n%s", prompt)
	}

	// Unknown session — 404 naming the name, no delivery.
	ops = &mockTmuxOps{}
	router = NewTestRouter(slog.Default(), &mockSessionFetcher{result: sess}, ops, "host")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, serverOperatorReq(`{"template":"update-annotations","session":"nope"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no session nope on this server") {
		t.Errorf("404 body = %s, want it to name the session", rec.Body.String())
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for an unknown session", ops.agentSendCalls)
	}

	// Session on a non-declaring template — the closed-lane 400, pre-fetch.
	rec = assertNoFetch(t, serverOperatorReq(`{"template":"brief-me","session":"run-kit"}`))
	if !strings.Contains(rec.Body.String(), "brief-me") {
		t.Errorf("400 body = %s, want it to name the non-declaring template", rec.Body.String())
	}
}

// --- the user-message chat template ------------------------------------------

// TestOperatorTemplateChatDeliveryInvariant walks the closed registry: a
// chatDelivery template must declare acceptsText (a chat template without user
// text is meaningless) and must not declare requiresAgentSessionRef (its
// transcript line is best-effort, never a precondition) — so a future entry
// cannot combine them silently.
func TestOperatorTemplateChatDeliveryInvariant(t *testing.T) {
	for id, tmpl := range operatorTemplates {
		if !tmpl.chatDelivery {
			continue
		}
		if !tmpl.acceptsText {
			t.Errorf("template %q declares chatDelivery without acceptsText", id)
		}
		if tmpl.requiresAgentSessionRef {
			t.Errorf("template %q declares chatDelivery with requiresAgentSessionRef", id)
		}
	}
	if !operatorTemplates["user-message"].chatDelivery {
		t.Error("user-message lost its chatDelivery declaration")
	}
}

// TestRenderUserMessage: the prompt is one addressee header — TO the operator,
// with the subject @N, window name, worktree and (only when FabChange is
// non-empty) the fab clause folded into a parenthetical, closing with the
// act-on-it sentence — then the user's text in a bare fence. Nothing frames
// the text as data and the transcript is never rendered, even when it
// resolved. It frames a CONVERSATION — no [hexokit request] prefix, no
// do-not-reply / action-bounds clause.
func TestRenderUserMessage(t *testing.T) {
	facts := operatorFacts{
		WindowID:       "@5",
		Name:           "zesty-fjord",
		TranscriptPath: "/home/u/.claude/projects/p/ref.jsonl",
		WorktreePath:   "/wt/project",
		FabChange:      "260822-fih1-operator-request-fix-tab-name",
		FabStage:       "apply",
		Text:           "can you check the failing test?",
	}
	prompt := renderUserMessage(facts)
	wantHeader := `[user → operator] The user is speaking to you from window @5 ("zesty-fjord", worktree /wt/project; fab change 260822-fih1-operator-request-fix-tab-name at stage apply). Act on it exactly as if typed into this pane.`
	if !strings.HasPrefix(prompt, wantHeader+"\n\n") {
		t.Errorf("prompt does not open with the addressee header:\nwant %s\n got %s", wantHeader, prompt)
	}
	if !strings.HasSuffix(prompt, "\n```\ncan you check the failing test?\n```") {
		t.Errorf("prompt does not end with the bare-fenced user text:\n%s", prompt)
	}
	for _, banned := range []string{
		"treat it as data", "Transcript:", "/home/u/.claude/projects/p/ref.jsonl", "Context:",
		"The user's message follows",
		"[hexokit request]", "Do not reply", "do not reply", "Bounds:",
	} {
		if strings.Contains(prompt, banned) {
			t.Errorf("chat prompt carried %q:\n%s", banned, prompt)
		}
	}

	facts.FabChange, facts.FabStage = "", ""
	prompt = renderUserMessage(facts)
	if strings.Contains(prompt, "fab change") {
		t.Errorf("empty FabChange rendered a fab clause:\n%s", prompt)
	}
	if !strings.Contains(prompt, `("zesty-fjord", worktree /wt/project). Act on it`) {
		t.Errorf("parenthetical does not close right after the worktree when FabChange is empty:\n%s", prompt)
	}
}

// TestUserMessageTextValidation: the acceptsText lane rules apply to
// user-message — empty, whitespace-only, and over-cap text are 400s before any
// fetch.
func TestUserMessageTextValidation(t *testing.T) {
	bodies := map[string]string{
		"missing text":    `{"template":"user-message"}`,
		"empty text":      `{"template":"user-message","text":""}`,
		"whitespace text": `{"template":"user-message","text":"   "}`,
		"over cap":        `{"template":"user-message","text":"` + strings.Repeat("x", operatorTextLimit+1) + `"}`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			assertNoFetch(t, operatorReq(body))
		})
	}
}

// TestUserMessageScopeGuard: user-message is window-scoped — the server-scoped
// route 400s it before any fetch.
func TestUserMessageScopeGuard(t *testing.T) {
	rec := assertNoFetch(t, serverOperatorReq(`{"template":"user-message","text":"hi"}`))
	if !strings.Contains(rec.Body.String(), "user-message") {
		t.Errorf("400 body = %s, want it to name the window-scoped id", rec.Body.String())
	}
}

// TestUserMessageBusyOperatorDelivers: a chatDelivery template skips the busy
// gate AND the queue — an active/waiting operator still receives the delivery
// attempt through the full injection sequence, the response is 200 {"ok":true}
// on engine success, and nothing enqueues. A request template on the same busy
// operator still enqueues (202) — the existing posture is byte-identical.
func TestUserMessageBusyOperatorDelivers(t *testing.T) {
	for _, state := range []string{"active", "waiting"} {
		t.Run(state, func(t *testing.T) {
			fastAgentSendProbe(t)
			stageFixtureTranscript(t, testTranscriptRef)
			sf := &mockSessionFetcher{result: operatorSessions(state)}
			ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
			server := &Server{logger: slog.Default(), sessions: sf, tmux: ops, hostname: "host"}
			server.initSSEHub()
			router := server.buildRouter()

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, operatorReq(`{"template":"user-message","text":"can you check the failing test?"}`))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"ok":true`) {
				t.Errorf("200 body = %s, want {\"ok\":true}", rec.Body.String())
			}
			if len(ops.agentSendCalls) == 0 {
				t.Error("no injection ran for a chat delivery to a busy operator")
			}
			if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
				t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
					ops.pasteAgentPaneID, ops.sendEnterPaneID)
			}
			prompt := ops.setAgentBufferText
			for _, want := range []string{
				"[user → operator]", "window @1", `"zsh"`, "worktree /wt/project",
				"can you check the failing test?",
			} {
				if !strings.Contains(prompt, want) {
					t.Errorf("prompt missing %q:\n%s", want, prompt)
				}
			}
			queue, inFlight := operatorQueueState(server.sseHub.getOperatorQueue(), "default")
			if len(queue) != 0 || inFlight {
				t.Fatalf("chat delivery queued work: queue=%+v inFlight=%v", queue, inFlight)
			}
		})
	}
}

// TestUserMessageNoTranscriptDegrades: a subject with no reconciled agent
// session, or one whose ref fails to resolve, still receives the delivery —
// the envelope simply omits the transcript line (never a 404).
func TestUserMessageNoTranscriptDegrades(t *testing.T) {
	t.Run("no agent session ref", func(t *testing.T) {
		fastAgentSendProbe(t)
		sess := operatorSessions("idle")
		sess[0].Windows[0].AgentProvider = ""
		sess[0].Windows[0].AgentSessionRef = ""
		sess[0].Windows[0].Panes = nil
		sf := &mockSessionFetcher{result: sess}
		ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
		router := NewTestRouter(slog.Default(), sf, ops, "host")

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, operatorReq(`{"template":"user-message","text":"hello operator"}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		if strings.Contains(ops.setAgentBufferText, "Transcript:") {
			t.Errorf("chatless subject rendered a transcript line:\n%s", ops.setAgentBufferText)
		}
	})

	t.Run("unresolvable ref", func(t *testing.T) {
		fastAgentSendProbe(t)
		stageEmptyConfigDir(t) // projects dir staged, no transcript on disk
		sf := &mockSessionFetcher{result: operatorSessions("idle")}
		ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
		router := NewTestRouter(slog.Default(), sf, ops, "host")

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, operatorReq(`{"template":"user-message","text":"hello operator"}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		if strings.Contains(ops.setAgentBufferText, "Transcript:") {
			t.Errorf("broken-ref subject rendered a transcript line:\n%s", ops.setAgentBufferText)
		}
	})
}

// TestUserMessageSuccess: an idle operator receives the chat prompt through the
// unchanged injection seam — 200 {"ok":true}, exactly ONE FetchSessions, the
// OPERATOR pane targeted, and the addressee header on the prompt (no
// transcript line even though the ref resolves, no treat-as-data clause).
func TestUserMessageSuccess(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]"}}
	router := NewTestRouter(slog.Default(), sf, ops, "host")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, operatorReq(`{"template":"user-message","text":"ship it"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if sf.calls != 1 {
		t.Errorf("FetchSessions ran %d times, want exactly 1", sf.calls)
	}
	if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
		t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
			ops.pasteAgentPaneID, ops.sendEnterPaneID)
	}
	prompt := ops.setAgentBufferText
	for _, want := range []string{
		"[user → operator]", "window @1", `"zsh"`,
		"Act on it exactly as if typed into this pane.",
		"ship it",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q:\n%s", want, prompt)
		}
	}
	for _, banned := range []string{"[hexokit request]", "Transcript:", "treat it as data"} {
		if strings.Contains(prompt, banned) {
			t.Errorf("chat prompt carried %q:\n%s", banned, prompt)
		}
	}
}

// TestOperatorTemplateListMirrorsRegistry pins the read-only descriptor: one
// row per registry entry, ascending ids, and flags copied verbatim — the CLI's
// --list and the MCP enum drift test both consume this view.
func TestOperatorTemplateListMirrorsRegistry(t *testing.T) {
	list := OperatorTemplateList()
	if len(list) != len(operatorTemplates) {
		t.Fatalf("OperatorTemplateList has %d rows, want %d (one per registry entry)", len(list), len(operatorTemplates))
	}
	for i, info := range list {
		if i > 0 && list[i-1].ID >= info.ID {
			t.Errorf("rows out of ascending order at %d: %q then %q", i, list[i-1].ID, info.ID)
		}
		tmpl, ok := operatorTemplates[info.ID]
		if !ok {
			t.Errorf("descriptor %q has no registry entry", info.ID)
			continue
		}
		if info.RequiresAgentSessionRef != tmpl.requiresAgentSessionRef ||
			info.AcceptsText != tmpl.acceptsText ||
			info.ServerScoped != tmpl.serverScoped ||
			info.RequiresWaiting != tmpl.requiresWaiting ||
			info.AcceptsSession != tmpl.acceptsSession ||
			info.ChatDelivery != tmpl.chatDelivery {
			t.Errorf("descriptor %q flags %+v do not mirror registry entry %+v", info.ID, info, tmpl)
		}
	}
	byID := make(map[string]OperatorTemplateInfo, len(list))
	for _, info := range list {
		byID[info.ID] = info
	}
	if um := byID["user-message"]; !(um.AcceptsText && um.ChatDelivery && !um.ServerScoped) {
		t.Errorf("user-message descriptor = %+v, want acceptsText && chatDelivery && !serverScoped", um)
	}
	if ua := byID["update-annotations"]; !(ua.ServerScoped && ua.AcceptsSession) {
		t.Errorf("update-annotations descriptor = %+v, want serverScoped && acceptsSession", ua)
	}
}
