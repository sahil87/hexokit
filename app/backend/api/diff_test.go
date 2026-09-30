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

	"rk/internal/sessions"
	"rk/internal/tmux"
	"rk/internal/wtdiff"
)

// One session holding a window inside a repo and one outside — the surface's
// only two reachable states.
func diffFixtureSessions(root string) []sessions.ProjectSession {
	return []sessions.ProjectSession{{
		Name: "work",
		Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "in-repo", GitRoot: root},
			{WindowID: "@2", Name: "no-repo"},
		},
	}}
}

func newDiffServer(t *testing.T, git func(dir string, args ...string) ([]byte, error)) (http.Handler, *[]string) {
	t.Helper()
	sf := &mockSessionFetcher{result: diffFixtureSessions("/repo")}
	router, server := NewTestRouterAndServer(slog.New(slog.NewTextHandler(io.Discard, nil)), sf, &mockTmuxOps{}, "host")
	var mu sync.Mutex
	calls := &[]string{}
	server.wtDiff = wtdiff.NewTestReader(func(_ context.Context, dir string, args ...string) ([]byte, error) {
		mu.Lock()
		*calls = append(*calls, dir+" "+strings.Join(args, " "))
		mu.Unlock()
		return git(dir, args...)
	})
	return router, calls
}

func gitStub(dir string, args ...string) ([]byte, error) {
	joined := strings.Join(args, " ")
	switch {
	case strings.HasPrefix(joined, "status"):
		return []byte(" M a.go\x00?? new.txt\x00"), nil
	case strings.Contains(joined, "--no-index"):
		return []byte("diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n"), nil
	case strings.HasPrefix(joined, "diff HEAD"):
		return []byte("diff --git a/a.go b/a.go\nindex 1..2 100644\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,2 @@\n package a\n-var X = 1\n+var X = 2\n"), nil
	}
	return []byte(""), nil
}

func TestDiffServesTheWorkingTreeWithRowsAndStatus(t *testing.T) {
	router, calls := newDiffServer(t, gitStub)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff?window=@1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body wtdiff.Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Root != "/repo" || body.Clean || len(body.Files) != 2 {
		t.Fatalf("snapshot = %+v", body)
	}
	byPath := map[string]wtdiff.FileEntry{}
	for _, f := range body.Files {
		byPath[f.Path] = f
	}
	if got := byPath["a.go"]; got.Status != wtdiff.StatusModified || len(got.Rows) == 0 {
		t.Errorf("a.go = %+v, want modified with rows", got)
	}
	if got := byPath["new.txt"]; got.Status != wtdiff.StatusUntracked || len(got.Rows) == 0 {
		t.Errorf("new.txt = %+v, want untracked with rows", got)
	}
	// Every git call is scoped to the window's OWN repo root — a read that ran
	// anywhere else would be reading someone else's tree.
	for _, call := range *calls {
		if !strings.HasPrefix(call, "/repo ") {
			t.Errorf("a git call escaped the window's root: %q", call)
		}
	}
}

// The surface is repo-backed: a window outside any repository has no tile, not
// an empty one.
func TestDiffOnAWindowWithNoRepoIs404(t *testing.T) {
	router, _ := newDiffServer(t, gitStub)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff?window=@2", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// THE AUTHORIZATION GUARD.
//
// `path` arrives from the query string. Without the changed-file membership
// check the route would serve any file in the repository — and a `..` segment
// would take it outside. The closed set IS the authorization.
func TestDiffFileRefusesAPathOutsideTheChangeSet(t *testing.T) {
	router, _ := newDiffServer(t, gitStub)
	for _, path := range []string{"secrets.env", "../../etc/passwd", "a.go/../../x"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
			"/api/diff/file?window=@1&path="+path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("path %q = %d, want 404", path, rec.Code)
		}
	}
	// A path that IS in the change set is served.
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff/file?window=@1&path=a.go", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("a.go = %d, body = %s", rec.Code, rec.Body.String())
	}
}

// The freshness seam: a fingerprint, not the document. The tile polls this on a
// short cadence, so it must stay small and must not carry the file list.
func TestDiffDigestAnswersAFingerprintNotTheDocument(t *testing.T) {
	router, _ := newDiffServer(t, gitStub)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff/digest?window=@1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Digest == "" {
		t.Error("empty digest")
	}
	if strings.Contains(rec.Body.String(), "a.go") {
		t.Errorf("the digest response carried the file list: %s", rec.Body.String())
	}
	// Small enough to poll. The document it stands in for is a megabyte.
	if rec.Body.Len() > 128 {
		t.Errorf("digest response is %d bytes; it is polled every few seconds", rec.Body.Len())
	}
	// Same window, unchanged tree — the client must not refetch for nothing.
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/diff/digest?window=@1", nil))
	if rec2.Body.String() != rec.Body.String() {
		t.Errorf("digest is unstable on an unchanged tree: %s then %s", rec.Body.String(), rec2.Body.String())
	}
}

// A window outside a repo has no tile, so it has no freshness seam either.
func TestDiffDigestOnAWindowWithNoRepoIs404(t *testing.T) {
	router, _ := newDiffServer(t, gitStub)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff/digest?window=@2", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

// A subprocess error reaches the client as a banner it can act on, never as
// "exit status 128".
func TestDiffClassifiesGitFailures(t *testing.T) {
	router, _ := newDiffServer(t, func(string, ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/diff?window=@1", nil))
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "exit status") {
		t.Errorf("a subprocess error leaked to the client: %s", rec.Body.String())
	}
}
