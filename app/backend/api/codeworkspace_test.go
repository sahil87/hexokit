package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/codeworkspace"
	"rk/internal/tmux"
)

// stubCodeRootOption installs the shared handler tmux read seam (the
// present_test.go idiom) returning root for the @rk_win_code_root read, or
// err when set. Any other option read fails the test.
func stubCodeRootOption(t *testing.T, root string, err error) {
	t.Helper()
	getWindowOptionFn = func(_ context.Context, _ /* windowID */, _, option string) (string, error) {
		if option != tmux.CodeRootOption {
			t.Errorf("handler read option %q, want %q", option, tmux.CodeRootOption)
		}
		return root, err
	}
	t.Cleanup(func() { getWindowOptionFn = defaultGetWindowOption })
}

func getCodeWorkspace(t *testing.T, router http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestCodeWorkspaceOK(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	root := "/home/u/code/x"
	stubCodeRootOption(t, root, nil)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace?server=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["root"] != root {
		t.Errorf("root = %q, want %q", body["root"], root)
	}
	stateDir, err := codeworkspace.StateDir()
	if err != nil {
		t.Fatalf("StateDir: %v", err)
	}
	wantPath := codeworkspace.Path(stateDir, "default", "@7", root)
	if body["path"] != wantPath {
		t.Errorf("path = %q, want %q", body["path"], wantPath)
	}
	content, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("workspace file missing on disk: %v", err)
	}
	if string(content) != string(codeworkspace.Content(root, "@7", "default")) {
		t.Errorf("file content = %q, want %q", content, codeworkspace.Content(root, "@7", "default"))
	}
}

func TestCodeWorkspaceIdempotentSecondCall(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	root := "/home/u/code/x"
	stubCodeRootOption(t, root, nil)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace")
	if rec.Code != http.StatusOK {
		t.Fatalf("first GET status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	path := body["path"]
	// Pin an unmistakable mtime so a rewrite is detectable regardless of
	// filesystem timestamp granularity.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	rec = getCodeWorkspace(t, router, "/api/windows/@7/code-workspace")
	if rec.Code != http.StatusOK {
		t.Fatalf("second GET status = %d, want 200", rec.Code)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("second GET rewrote the file: mtime %v → %v", before.ModTime(), after.ModTime())
	}
}

func TestCodeWorkspaceEmptyRootConflict(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubCodeRootOption(t, "", nil)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body: %q)", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["error"] != "window has no code root" {
		t.Errorf("error = %q, want %q", body["error"], "window has no code root")
	}
	stateDir, err := codeworkspace.StateDir()
	if err != nil {
		t.Fatalf("StateDir: %v", err)
	}
	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Errorf("state dir exists after a 409 — nothing may be written")
	}
}

func TestCodeWorkspaceBadWindowID(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	reached := false
	getWindowOptionFn = func(context.Context, string, string, string) (string, error) {
		reached = true
		return "", nil
	}
	t.Cleanup(func() { getWindowOptionFn = defaultGetWindowOption })
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/7/code-workspace")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %q)", rec.Code, rec.Body.String())
	}
	if reached {
		t.Error("tmux read ran for an invalid window id")
	}
}

func TestCodeWorkspaceBadServer(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubCodeRootOption(t, "/home/u/code/x", nil)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace?server=../etc")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %q)", rec.Code, rec.Body.String())
	}
}

func TestCodeWorkspaceUnknownWindow(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubCodeRootOption(t, "", errors.New(`can't find window: @99`))
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@99/code-workspace")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body: %q)", rec.Code, rec.Body.String())
	}
}

func TestCodeWorkspaceTmuxFailure(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	stubCodeRootOption(t, "", errors.New("tmux server gone"))
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body: %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "tmux server gone") {
		t.Errorf("body = %q, want the error text", rec.Body.String())
	}
}

func TestCodeWorkspaceEnsureFailure(t *testing.T) {
	// A file (not a dir) at the hexokit state path makes the server-dir
	// MkdirAll fail, surfacing the Ensure error text as a 500.
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "hexokit"), []byte("x"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	t.Setenv("XDG_STATE_HOME", state)
	stubCodeRootOption(t, "/home/u/code/x", nil)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeWorkspace(t, router, "/api/windows/@7/code-workspace")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body: %q)", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	if body["error"] == "" {
		t.Error("500 body carries no error text")
	}
}
