package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"rk/internal/riff"
	"rk/internal/snapshot"
)

// Recently-closed surface coverage — GET /api/windows/closed and the
// reopen/dismiss/resume mutations. The snapshot store is a REAL temp-dir store
// (recovery_test.go's pattern); the tmux-touching engine paths ride the
// captureWindowFn/reopenWindowFn package-var seams and the dedicated mock
// RiffEngine (riff_test.go), so no test needs a live tmux server.

// newClosedRouter builds a router with an injected snapshot store (and optional
// riff engine); mirrors how recovery_test.go wires SetSnapshotStore.
func newClosedRouter(sf SessionFetcher, ops TmuxOps, engine RiffEngine, store *snapshot.Store) http.Handler {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	s := &Server{logger: logger, sessions: sf, tmux: ops, riff: engine, hostname: "test-host"}
	s.SetSnapshotStore(store)
	return s.buildRouter()
}

// stubCaptureWindow pins the kill-seam capture seam for the test's duration.
func stubCaptureWindow(t *testing.T, win snapshot.Window, session string, err error) {
	t.Helper()
	prev := captureWindowFn
	captureWindowFn = func(ctx context.Context, server, windowID string) (snapshot.Window, string, error) {
		return win, session, err
	}
	t.Cleanup(func() { captureWindowFn = prev })
}

// stubReopenWindow pins the reopen engine seam, recording its args.
func stubReopenWindow(t *testing.T, windowID string, err error) *snapshot.ClosedWindow {
	t.Helper()
	var got snapshot.ClosedWindow
	prev := reopenWindowFn
	reopenWindowFn = func(ctx context.Context, server string, rec snapshot.ClosedWindow) (string, error) {
		got = rec
		return windowID, err
	}
	t.Cleanup(func() { reopenWindowFn = prev })
	return &got
}

// closedRecord builds a record fixture with one pane at cwd.
func closedRecord(server, session, name, cwd string) snapshot.ClosedWindow {
	return snapshot.ClosedWindow{
		Server:  server,
		Session: session,
		Window: snapshot.Window{
			Index: 2, ID: "@7", Name: name, Color: "4",
			Panes: []snapshot.Pane{{ID: "%0", Index: 0, Cwd: cwd, Command: "zsh", Active: true}},
		},
	}
}

// pushClosed seeds one record onto the store's ring, failing the test on error.
func pushClosed(t *testing.T, store *snapshot.Store, rec snapshot.ClosedWindow) snapshot.ClosedWindow {
	t.Helper()
	pushed, err := store.PushClosed(rec)
	if err != nil {
		t.Fatalf("seed ring: %v", err)
	}
	return pushed
}

// --- GET /api/windows/closed ---

// TestClosedListNilStoreIsEmpty: an unwired store lists an empty array, never
// an error (the recovery endpoints' nil-safe posture).
func TestClosedListNilStoreIsEmpty(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/windows/closed?server=work", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if body := strings.TrimSpace(rec.Body.String()); body != `{"closed":[]}` {
		t.Errorf("body = %q, want {\"closed\":[]}", body)
	}
}

// TestClosedListNewestFirstPerServer: the list is newest-first and scoped to
// the ?server= ring.
func TestClosedListNewestFirstPerServer(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	pushClosed(t, store, closedRecord("work", "dev", "old", "/tmp"))
	pushClosed(t, store, closedRecord("work", "dev", "new", "/tmp"))
	pushClosed(t, store, closedRecord("other", "ops", "stray", "/tmp"))

	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/windows/closed?server=work", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Closed []snapshot.ClosedWindow `json:"closed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Closed) != 2 {
		t.Fatalf("closed = %+v, want exactly the 2 work records", got.Closed)
	}
	if got.Closed[0].Window.Name != "new" || got.Closed[1].Window.Name != "old" {
		t.Errorf("order = [%s, %s], want newest-first [new, old]",
			got.Closed[0].Window.Name, got.Closed[1].Window.Name)
	}
	if got.Closed[0].ID == "" || got.Closed[0].ClosedAt.IsZero() {
		t.Errorf("record missing store-stamped identity: %+v", got.Closed[0])
	}
}

// --- POST /api/windows/closed/{id}/reopen ---

// TestClosedReopenSuccess: reopen drives the engine with the loaded record,
// drops it from the ring, and responds riff-shaped.
func TestClosedReopenSuccess(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, closedRecord("work", "dev", "serve", "/tmp"))

	got := stubReopenWindow(t, "@42", nil)
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+rec.ID+"/reopen?server=work", nil))

	if r.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", r.Code, r.Body.String())
	}
	if got.ID != rec.ID || got.Session != "dev" {
		t.Errorf("engine got record = %+v, want the stored one", got)
	}
	var body map[string]string
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["server"] != "work" || body["session"] != "dev" || body["window"] != "serve" || body["windowId"] != "@42" {
		t.Errorf("response = %v, want riff-shaped {server, session, window, windowId}", body)
	}
	if list, _ := store.ListClosed("work"); len(list) != 0 {
		t.Errorf("record still on ring after reopen: %+v", list)
	}
}

// TestClosedReopenKeepsAgentRecord: a record carrying an agent identity stays
// on the ring after a plain reopen — the post-reopen toast's "Resume agent"
// action resolves the same id, and dismiss/resume are what drop it.
func TestClosedReopenKeepsAgentRecord(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	rec := closedRecord("work", "dev", "serve", "/tmp")
	rec.AgentProvider = forkProviderClaude
	rec.AgentRef = "0f0e1d2c-3b4a-4596-8778-99aabbccddee"
	rec = pushClosed(t, store, rec)

	stubReopenWindow(t, "@42", nil)
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+rec.ID+"/reopen?server=work", nil))

	if r.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", r.Code, r.Body.String())
	}
	if got, _ := store.LoadClosed("work", rec.ID); got == nil {
		t.Fatalf("agent record dropped by plain reopen; resume would 404")
	}
}

// TestClosedReopenMalformedID: a non-record-shaped id is a 404, never a 500 —
// input validation is not a server fault.
func TestClosedReopenMalformedID(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)
	for _, id := range []string{"abc", "12..34", "%2e%2e"} {
		r := httptest.NewRecorder()
		router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+id+"/reopen?server=work", nil))
		if r.Code != http.StatusNotFound {
			t.Errorf("id %q: status = %d, want 404; body=%s", id, r.Code, r.Body.String())
		}
	}
}

// TestClosedReopenUnknownID: an id with no record is a 404 and the engine is
// never driven. A nil store behaves the same.
func TestClosedReopenUnknownID(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	got := stubReopenWindow(t, "@42", nil)
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/123/reopen?server=work", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", r.Code, r.Body.String())
	}
	if got.ID != "" {
		t.Error("engine driven for an unknown id")
	}

	router = newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	r = httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/123/reopen?server=work", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("nil store: status = %d, want 404", r.Code)
	}
}

// TestClosedReopenSessionGone: the engine's typed session-gone error is a 409
// naming the session, and the record is DROPPED (it can never reopen).
func TestClosedReopenSessionGone(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, closedRecord("work", "ghost-sess", "serve", "/tmp"))

	stubReopenWindow(t, "", &snapshot.SessionGoneError{Session: "ghost-sess"})
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+rec.ID+"/reopen?server=work", nil))

	if r.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), "ghost-sess") {
		t.Errorf("409 body must name the session: %s", r.Body.String())
	}
	if list, _ := store.ListClosed("work"); len(list) != 0 {
		t.Errorf("session-gone record kept on ring: %+v", list)
	}
}

// TestClosedReopenEngineErrorKeepsRecord: any other engine failure is a 500
// and the record STAYS (a transient fault must not lose it).
func TestClosedReopenEngineErrorKeepsRecord(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, closedRecord("work", "dev", "serve", "/tmp"))

	stubReopenWindow(t, "", errors.New("tmux: connection refused"))
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+rec.ID+"/reopen?server=work", nil))

	if r.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", r.Code, r.Body.String())
	}
	if list, _ := store.ListClosed("work"); len(list) != 1 {
		t.Errorf("record lost after engine error: %+v", list)
	}
}

// --- POST /api/windows/closed/{id}/dismiss ---

// TestClosedDismiss: dismiss drops the record and returns {"ok": true}; an
// unknown id is a 404; a nil store is a 404.
func TestClosedDismiss(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, closedRecord("work", "dev", "serve", "/tmp"))

	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/"+rec.ID+"/dismiss?server=work", nil))
	if r.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", r.Code, r.Body.String())
	}
	if strings.TrimSpace(r.Body.String()) != `{"ok":true}` {
		t.Errorf("body = %q, want {\"ok\":true}", r.Body.String())
	}
	if list, _ := store.ListClosed("work"); len(list) != 0 {
		t.Errorf("record still on ring after dismiss: %+v", list)
	}

	r = httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/999/dismiss?server=work", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("unknown id: status = %d, want 404", r.Code)
	}

	router = newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	r = httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost, "/api/windows/closed/999/dismiss?server=work", nil))
	if r.Code != http.StatusNotFound {
		t.Fatalf("nil store: status = %d, want 404", r.Code)
	}
}

// --- POST /api/windows/closed/{id}/resume ---

// postResume issues the resume POST with the given body.
func postResume(router http.Handler, id, body string) *httptest.ResponseRecorder {
	r := httptest.NewRecorder()
	router.ServeHTTP(r, httptest.NewRequest(http.MethodPost,
		"/api/windows/closed/"+id+"/resume?server=work", strings.NewReader(body)))
	return r
}

// resumeRecord builds a claude-agent record rooted at cwd (a git repo in the
// success-path tests).
func resumeRecord(server, cwd string) snapshot.ClosedWindow {
	rec := closedRecord(server, "dev", "agent", cwd)
	rec.AgentProvider = "claude"
	rec.AgentRef = testForkRef
	return rec
}

// TestClosedResumeSuccess: resume spawns through the riff seam with
// fork-identical options, re-stamps the record's option set onto the spawned
// window, kills the placeholder DIRECTLY (no phantom ring record), drops the
// record, and responds riff-shaped.
func TestClosedResumeSuccess(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", repo))

	ops := &mockTmuxOps{}
	engine := &mockRiffEngine{result: riff.Result{
		Server: "work", Session: "dev", WindowName: "agent", WindowID: "@9",
	}}
	router := newClosedRouter(&mockSessionFetcher{}, ops, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)

	if r.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", r.Code, r.Body.String())
	}
	if !engine.called {
		t.Fatal("engine.Spawn was not called")
	}
	got := engine.gotOpts
	if got.Server != "work" || got.Session != "dev" || got.Where != "checkout" ||
		got.RepoRoot != repo || got.ResumeSessionRef != testForkRef || got.WindowNameBase != "agent" {
		t.Errorf("engine options = %+v, want fork-identical wiring", got)
	}
	if got.WorktreeName != "" || got.Tier != "" || got.Task != "" || got.RiffPreset != "" {
		t.Errorf("engine got unexpected spawn-shaping inputs: %+v", got)
	}
	// The record's @rk_win_* set is re-stamped onto the SPAWNED window.
	if !ops.setWindowOptionsCalled || ops.setWindowOptionsWindowID != "@9" {
		t.Errorf("re-stamp = called %v on %q, want @9", ops.setWindowOptionsCalled, ops.setWindowOptionsWindowID)
	}
	wantOps := snapshot.WindowOptionOps(rec.Window)
	if len(ops.setWindowOptionsOps) != len(wantOps) {
		t.Errorf("re-stamp ops = %v, want exactly WindowOptionOps(record) %v", ops.setWindowOptionsOps, wantOps)
	}
	// The placeholder was killed directly.
	if !ops.killWindowCalled || ops.killWindowID != "@41" {
		t.Errorf("placeholder kill = called %v on %q, want @41", ops.killWindowCalled, ops.killWindowID)
	}
	// Record dropped; no phantom record for the placeholder.
	if list, _ := store.ListClosed("work"); len(list) != 0 {
		t.Errorf("ring after resume = %+v, want empty", list)
	}

	var body map[string]string
	if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["server"] != "work" || body["session"] != "dev" || body["window"] != "agent" || body["windowId"] != "@9" {
		t.Errorf("response = %v, want the engine result's riff shape", body)
	}
}

// TestClosedResumeUnknownID: an id with no record is a 404 before the body is
// even consulted.
func TestClosedResumeUnknownID(t *testing.T) {
	store := snapshot.NewStore(t.TempDir())
	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, engine, store)

	r := postResume(router, "123", `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", r.Code, r.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn called for an unknown id")
	}
}

// TestClosedResumeInvalidReplaceWindowID: a malformed replaceWindowId is a 400
// and never reaches a kill (the @N validation keeps tmux targets clean).
func TestClosedResumeInvalidReplaceWindowID(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", repo))

	ops := &mockTmuxOps{}
	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, ops, engine, store)

	for _, body := range []string{
		`{"replaceWindowId":"notawindow"}`,
		`{"replaceWindowId":""}`,
		`{"replaceWindowId":"1; rm -rf /"}`,
		`not-json`,
	} {
		r := postResume(router, rec.ID, body)
		if r.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, r.Code)
		}
	}
	if engine.called || ops.killWindowCalled {
		t.Error("engine/kill reached with an invalid replaceWindowId")
	}
}

// TestClosedResumeNoAgentRecorded: a record with no agent identity is a 404 —
// there is no conversation to resume.
func TestClosedResumeNoAgentRecorded(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, closedRecord("work", "dev", "shell", repo))

	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), "no agent session recorded") {
		t.Errorf("body = %q, want the no-agent message", r.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn called with no recorded agent")
	}
}

// TestClosedResumeNonClaudeProvider: a well-formed but non-resumable provider
// is a 404 (fork's non-claude posture).
func TestClosedResumeNonClaudeProvider(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := resumeRecord("work", repo)
	rec.AgentProvider = "codex"
	rec = pushClosed(t, store, rec)

	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), "codex") {
		t.Errorf("body = %q, want it to name the provider", r.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn called for a non-claude provider")
	}
}

// TestClosedResumeBadRef: a recorded ref failing the strict UUID shape is a
// 404 and NEVER reaches the engine (the gate keeping shell-significant input
// out of the launcher string, Constitution I).
func TestClosedResumeBadRef(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := resumeRecord("work", repo)
	rec.AgentRef = "not-a-uuid; rm -rf /"
	rec = pushClosed(t, store, rec)

	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", r.Code, r.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn called with a non-uuid ref")
	}
}

// TestClosedResumeNonRepoCwd: a record whose first-pane cwd is not inside a
// git repo is a 400 naming the directory (forkNonRepoMsg), nothing spawned.
func TestClosedResumeNonRepoCwd(t *testing.T) {
	nonRepo := t.TempDir()
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", nonRepo))

	engine := &mockRiffEngine{}
	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), nonRepo) {
		t.Errorf("body = %q, want it to name the non-repo cwd %q", r.Body.String(), nonRepo)
	}
	if engine.called {
		t.Error("engine.Spawn called for a non-repo cwd")
	}
}

// TestClosedResumeEngineNotConfigured: an unwired engine is a 500 (the riff
// handler's nil-safe pattern), and the record stays.
func TestClosedResumeEngineNotConfigured(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", repo))

	router := newClosedRouter(&mockSessionFetcher{}, &mockTmuxOps{}, nil, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", r.Code, r.Body.String())
	}
	if list, _ := store.ListClosed("work"); len(list) != 1 {
		t.Errorf("record lost after nil-engine 500: %+v", list)
	}
}

// TestClosedResumeEngineErrorKeepsRecord: an engine failure maps via
// riffStatusForError and keeps the record; the placeholder is never killed.
func TestClosedResumeEngineErrorKeepsRecord(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", repo))

	ops := &mockTmuxOps{}
	engine := &mockRiffEngine{err: riff.ValidationErr("bad launcher")}
	router := newClosedRouter(&mockSessionFetcher{}, ops, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (validation-class engine error); body=%s", r.Code, r.Body.String())
	}
	if ops.killWindowCalled {
		t.Error("placeholder killed despite engine failure")
	}
	if list, _ := store.ListClosed("work"); len(list) != 1 {
		t.Errorf("record lost after engine error: %+v", list)
	}
}

// TestClosedResumePlaceholderKillFailureKeepsRecord: when the placeholder kill
// fails the resume did NOT complete (both windows exist) — a 500 with the
// record kept so the user can retry or dismiss.
func TestClosedResumePlaceholderKillFailureKeepsRecord(t *testing.T) {
	repo := gitRepoDir(t)
	store := snapshot.NewStore(t.TempDir())
	rec := pushClosed(t, store, resumeRecord("work", repo))

	ops := &mockTmuxOps{err: errors.New("no such window")}
	engine := &mockRiffEngine{result: riff.Result{
		Server: "work", Session: "dev", WindowName: "agent", WindowID: "@9",
	}}
	router := newClosedRouter(&mockSessionFetcher{}, ops, engine, store)

	r := postResume(router, rec.ID, `{"replaceWindowId":"@41"}`)
	if r.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", r.Code, r.Body.String())
	}
	if list, _ := store.ListClosed("work"); len(list) != 1 {
		t.Errorf("record lost after placeholder kill failure: %+v", list)
	}
}
