package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"rk/internal/prreview"
	"rk/internal/sessions"
	"rk/internal/tmux"
)

// prReviewFixtureSessions is one session holding two windows: one whose branch
// resolved to a PR (the review surface's only reachable state) and one without.
func prReviewFixtureSessions(prURL string, listening bool) []sessions.ProjectSession {
	return []sessions.ProjectSession{{
		Name: "work",
		Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "with-pr", PrURL: &prURL, PrListen: listening},
			{WindowID: "@2", Name: "no-pr"},
		},
	}}
}

// newPRReviewServer builds a router whose review fetcher runs against a
// recording gh seam — no subprocess, no network.
func newPRReviewServer(t *testing.T, ops TmuxOps, gh func(stdin []byte, args ...string) ([]byte, error)) (http.Handler, *Server) {
	t.Helper()
	const prURL = "https://github.com/acme/tool/pull/7"
	sf := &mockSessionFetcher{result: prReviewFixtureSessions(prURL, false)}
	router, server := NewTestRouterAndServer(slog.New(slog.NewTextHandler(io.Discard, nil)), sf, ops, "host")
	server.prReview = prreview.NewTestFetcher(
		func(context.Context) bool { return true },
		func(_ context.Context, stdin []byte, args ...string) ([]byte, error) {
			return gh(stdin, args...)
		},
	)
	return router, server
}

// ghStub answers the three reads one review document needs plus a generic OK
// for every write. There is deliberately NO `/pulls/7` case: the PR meta rides
// the GraphQL node now, and a stub that still answered the REST path would let
// a re-added meta call pass unnoticed.
// callRecorder collects the argv+stdin of every stubbed gh invocation.
//
// It owns its lock because the detail fetch reads files and threads
// CONCURRENTLY, so the stub is entered from two goroutines at once. A bare
// slice plus a mutex at each call site does not work — the whole point is that
// one slice has exactly one guard, wherever it is written from.
type callRecorder struct {
	mu    sync.Mutex
	calls []string
}

func (r *callRecorder) add(call string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}

// all returns a copy, so a ranging caller cannot race a late write.
func (r *callRecorder) all() []string {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

func ghStub(recorder *callRecorder) func(stdin []byte, args ...string) ([]byte, error) {
	return func(stdin []byte, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		recorder.add(joined + "\x00" + string(stdin))
		switch {
		case strings.Contains(joined, "/pulls/7/files"):
			return []byte(`[[{"filename":"a.go","status":"modified","additions":2,"deletions":1,
				"sha":"headblob","patch":"@@ -1,2 +1,3 @@\n ctx\n-gone\n+added\n+more"}]]`), nil
		case strings.Contains(joined, "graphql"):
			return []byte(`{"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{
				"title":"A change","state":"OPEN","headRefOid":"headsha","baseRefOid":"basesha",
				"reviewThreads":{"nodes":[
				{"id":"T1","isResolved":false,"isOutdated":false,"path":"a.go","line":2,"diffSide":"RIGHT",
				 "comments":{"nodes":[{"id":"C1","databaseId":101,"body":"fix this","createdAt":"2026-09-19T10:00:00Z",
				   "author":{"login":"reviewer"},"reactions":{"totalCount":0}}]}}
			]}}}}}`), nil
		case strings.Contains(joined, "/contents/"):
			return []byte(`{"type":"file","encoding":"base64","content":"Y3R4CmFkZGVkCm1vcmUK"}`), nil
		}
		return []byte(`{}`), nil
	}
}

func TestPRReviewListServesFilesThreadsAndViewer(t *testing.T) {
	var calls callRecorder
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(&calls))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/pr/review?window=@1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Number  int    `json:"number"`
		Viewer  string `json:"viewer"`
		HeadSha string `json:"headSha"`
		Files   []struct {
			Path     string `json:"path"`
			HasPatch bool   `json:"hasPatch"`
		} `json:"files"`
		Threads   []prreview.Thread `json:"threads"`
		Listening bool              `json:"listening"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Number != 7 || body.Viewer != "me" || body.HeadSha != "headsha" {
		t.Errorf("document = %+v", body)
	}
	if len(body.Files) != 1 || body.Files[0].Path != "a.go" || !body.Files[0].HasPatch {
		t.Errorf("files = %+v", body.Files)
	}
	if len(body.Threads) != 1 || body.Threads[0].ID != "T1" || len(body.Threads[0].Comments) != 1 {
		t.Errorf("threads = %+v", body.Threads)
	}
	// The list carries structure for the files inside the eager budget — that is
	// what lets the tile open expanded on one request (§ R6a) — and, since R5's
	// tier 0.5, colour too.
	//
	// Text MUST be there: a LineRow has no text field, so rows without spans
	// render as blank lines and the expanded file shows nothing.
	if !strings.Contains(rec.Body.String(), `"t":`) {
		t.Error("the list response carries no text; every eager row would render blank")
	}
	// Classes must be there too. This assertion used to be its exact inverse, on
	// the reasoning that "tokenizing at mount is the cost the digest/detail split
	// exists to avoid" — but that cost was the blob FETCH, and tier 0.5 lexes the
	// patch text the response already holds. The call count below is what still
	// holds that promise; the class is now just colour the reader gets for free.
	if !strings.Contains(rec.Body.String(), `"c":`) {
		t.Error("the list response carries no token classes; the first paint would be monochrome")
	}
	if body.Listening {
		t.Error("listening = true; the fixture window is disarmed")
	}
	// THE COST PROMISE. Colour on the list read is only defensible because it
	// costs no round trip: a cold document is the file list plus one GraphQL
	// call, and nothing tier 0.5 does may add to that.
	if got := len(calls.all()); got != 2 {
		for _, call := range calls.all() {
			t.Logf("  call: %s", call)
		}
		t.Errorf("the list read made %d gh calls, want 2", got)
	}
}

func TestPRReviewWithoutAPullRequestIs404(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	for _, target := range []string{"/api/pr/review?window=@2", "/api/pr/review?window=@99"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", target, rec.Code)
		}
	}
}

func TestPRReviewRejectsBadParams(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	cases := []string{
		"/api/pr/review?window=not-a-window",
		"/api/pr/review/file?window=@1",                      // no path
		"/api/pr/review/file?window=@1&path=%20",             // whitespace-only path
		"/api/pr/review/file?window=@1&path=a%00.go",         // NUL in the path
		"/api/pr/review/file?window=@1&path=a.go&start=-1",   // negative start
		"/api/pr/review/file?window=@1&path=a.go&count=huge", // unparseable count
	}
	for _, target := range cases {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", target, rec.Code)
		}
	}
}

// Rows carry GitHub's own (side, line) address, and a deletion carries the
// post-image line it sat before — the anchoring contract the comment layer
// renders as data-side / data-l / data-at.
func TestPRReviewFileServesPerLineRowsWithAnchoring(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/pr/review/file?window=@1&path=a.go", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body prreview.FileBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Rows) != 5 {
		t.Fatalf("rows = %d (%+v), want 5", len(body.Rows), body.Rows)
	}
	if body.Rows[0].Kind != "hunk" {
		t.Errorf("row 0 = %+v, want the hunk header", body.Rows[0])
	}
	del := body.Rows[2]
	if del.Kind != "del" || del.Side != "L" || del.L != 2 || del.At != 2 {
		t.Errorf("deleted row = %+v, want side L / l 2 / at 2", del)
	}
	add := body.Rows[3]
	if add.Kind != "add" || add.Side != "R" || add.L != 2 {
		t.Errorf("added row = %+v, want side R / l 2", add)
	}
	// Spans, never one HTML blob: the comment layer has to splice between rows.
	if len(add.Spans) == 0 {
		t.Error("added row carries no spans")
	}
}

func TestPRReviewFileContextRowsExpandFromTheBlob(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/pr/review/file?window=@1&path=a.go&start=1&count=2", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body prreview.FileBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(body.Rows))
	}
	for i, row := range body.Rows {
		if row.Kind != "ctx" || row.Side != "R" || row.L != i+1 {
			t.Errorf("context row %d = %+v", i, row)
		}
	}
	if body.TotalLines != 3 {
		t.Errorf("totalLines = %d, want 3", body.TotalLines)
	}
}

// The closed set is the endpoint's authorization: a path that is not one of the
// PR's own changed files is a 404 on BOTH branches. Without the gate on the
// context-expansion branch, `start`/`count` would serve any blob in the
// repository at the head sha.
func TestPRReviewFileRefusesAPathOutsideThePR(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	for _, target := range []string{
		"/api/pr/review/file?window=@1&path=secrets/.env",
		"/api/pr/review/file?window=@1&path=secrets/.env&start=1&count=1",
		"/api/pr/review/file?window=@1&path=../../etc/passwd&start=1&count=1",
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404 (path is not a file in the PR)", target, rec.Code)
		}
	}
}

// Constitution I: user-authored prose reaches gh on stdin, never argv.
func TestPRReviewCommentSendsBodyOnStdin(t *testing.T) {
	var calls callRecorder
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(&calls))
	body := `this is "wrong"; $(rm -rf /)`
	payload, _ := json.Marshal(prReviewCommentBody{
		Window: "@1", Path: "a.go", Line: 2, Side: "R", Body: body, Mode: "single",
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/comment", strings.NewReader(string(payload))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	found := false
	for _, call := range calls.all() {
		argv, stdin, _ := strings.Cut(call, "\x00")
		if strings.Contains(argv, "rm -rf") {
			t.Fatalf("comment body leaked into argv: %s", argv)
		}
		if strings.Contains(stdin, "rm -rf") && strings.Contains(argv, "--input -") {
			found = true
		}
	}
	if !found {
		t.Errorf("no gh call carried the body on stdin; calls = %v", calls.all())
	}
}

func TestPRReviewCommentValidatesItsBody(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	cases := []string{
		`{"window":"@1","path":"a.go","line":2,"body":""}`,     // empty body
		`{"window":"bogus","path":"a.go","line":2,"body":"x"}`, // bad window
		`{"window":"@1","body":"x"}`,                           // no anchor
		`{`,                                                    // malformed JSON
	}
	for _, payload := range cases {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/comment", strings.NewReader(payload)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", payload, rec.Code)
		}
	}
}

func TestPRReviewThreadResolveUsesGraphQLOnStdin(t *testing.T) {
	var calls callRecorder
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(&calls))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/thread",
		strings.NewReader(`{"window":"@1","threadId":"T1","resolved":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	found := false
	for _, call := range calls.all() {
		if _, stdin, _ := strings.Cut(call, "\x00"); strings.Contains(stdin, "resolveReviewThread") {
			found = true
		}
	}
	if !found {
		t.Errorf("no resolveReviewThread mutation was sent; calls = %v", calls.all())
	}
}

// Arm state is the @rk_win_pr_listen window option — shared across viewers,
// because arming is a fact about the work, not a viewing posture.
func TestPRReviewListenWritesTheWindowOption(t *testing.T) {
	ops := &mockTmuxOps{}
	router, _ := newPRReviewServer(t, ops, ghStub(nil))

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/listen",
		strings.NewReader(`{"window":"@1","listening":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("arm: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !ops.setWindowOptionCalled || ops.setWindowOptionOption != tmux.PrListenOption || ops.setWindowOptionValue != "1" {
		t.Errorf("arm wrote %q=%q (called=%v)", ops.setWindowOptionOption, ops.setWindowOptionValue, ops.setWindowOptionCalled)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/listen",
		strings.NewReader(`{"window":"@1","listening":false}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("disarm: status = %d", rec.Code)
	}
	if !ops.unsetWindowOptionCalled || ops.unsetWindowOptionOption != tmux.PrListenOption {
		t.Errorf("disarm unset %q (called=%v)", ops.unsetWindowOptionOption, ops.unsetWindowOptionCalled)
	}
}

// The refresh endpoint mirrors /api/status/refresh: always 202, with the fate
// in the body so the client can tell a spinner from an "already fresh" flash.
func TestPRReviewRefreshIsTriState(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	read := func() string {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/pr/review/refresh?window=@1", nil))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", rec.Code)
		}
		var body struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body.Status
	}
	if got := read(); got != string(refreshStarted) {
		t.Errorf("first refresh = %q, want started", got)
	}
	if got := read(); got == string(refreshStarted) {
		t.Error("second refresh started again; want coalesced or throttled")
	}
}

// Constitution IX: reads are GET, every mutation is POST. The assertion is that
// the wrong verb never REACHES a handler; chi answers 405 where a sibling
// method is registered on the same pattern and 404 where none is, and which of
// the two it picks is routing trivia, not contract.
func TestPRReviewRoutesUseTheUniformVerbs(t *testing.T) {
	router, _ := newPRReviewServer(t, &mockTmuxOps{}, ghStub(nil))
	cases := []struct {
		method, target string
	}{
		{http.MethodPost, "/api/pr/review?window=@1"},
		{http.MethodPost, "/api/pr/review/file?window=@1&path=a.go"},
		{http.MethodGet, "/api/pr/review/comment"},
		{http.MethodGet, "/api/pr/review/thread"},
		{http.MethodGet, "/api/pr/review/listen"},
		{http.MethodGet, "/api/pr/review/refresh?window=@1"},
		{http.MethodDelete, "/api/pr/review/thread"},
		{http.MethodPut, "/api/pr/review/comment"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.target, nil))
		if rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: status = %d, want 405 or 404 (the verb must not resolve)", tc.method, tc.target, rec.Code)
		}
	}
}
