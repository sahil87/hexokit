package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// writeHostRecord plants one cb/hosts/<hostId>.json under the test's
// XDG_STATE_HOME with the given tab/server/pid/stamp.
func writeHostRecord(t *testing.T, stateHome, hostID, tab, server string, pid int, startedAt string) {
	t.Helper()
	dir := filepath.Join(stateHome, "hexokit", "cb", "hosts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	record := fmt.Sprintf(
		`{"hostId":%q,"folder":"/repo","pid":%d,"sock":"/tmp/x.sock","extVersion":"1.0.0","startedAt":%q,"tab":%q,"server":%q}`,
		hostID, pid, startedAt, tab, server,
	)
	if err := os.WriteFile(filepath.Join(dir, hostID+".json"), []byte(record), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeBootMarker plants one cb/boots/<hostId>.json under the test's
// XDG_STATE_HOME with the given tab/server/pid/stamp.
func writeBootMarker(t *testing.T, stateHome, hostID, tab, server string, pid int, startedAt string) {
	t.Helper()
	dir := filepath.Join(stateHome, "hexokit", "cb", "boots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := fmt.Sprintf(
		`{"hostId":%q,"workspaceFile":"/state/@7-x.code-workspace","tab":%q,"server":%q,"pid":%d,"extVersion":"1.0.0","startedAt":%q}`,
		hostID, tab, server, pid, startedAt,
	)
	if err := os.WriteFile(filepath.Join(dir, hostID+".json"), []byte(marker), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeBridgeExtFixture plants an installed rk-code-bridge manifest under the
// test's XDG_DATA_HOME extensions dir (the writeBridgeFixture layout).
func writeBridgeExtFixture(t *testing.T, dataHome, version string) {
	t.Helper()
	pkgDir := filepath.Join(dataHome, "code-server", "extensions", "run-kit.rk-code-bridge-"+version)
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := fmt.Sprintf(`{"name":"rk-code-bridge","publisher":"run-kit","version":%q}`, version)
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

func getCodeBridge(t *testing.T, router http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func decodeCodeBridge(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	return body
}

func TestCodeBridgeOK(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	stamp := "2026-09-10T02:45:39.941Z"
	writeHostRecord(t, state, "host-a", "@7", "default", os.Getpid(), stamp)
	// A same-tab record on ANOTHER server must not leak into the answer.
	writeHostRecord(t, state, "host-b", "@7", "other", os.Getpid(), "2026-09-10T03:00:00.000Z")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge?server=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	body := decodeCodeBridge(t, rec)
	if body["startedAt"] != stamp {
		t.Errorf("startedAt = %v, want %q", body["startedAt"], stamp)
	}
	if body["emptyBootAt"] != "" {
		t.Errorf("emptyBootAt = %v, want \"\" (no markers)", body["emptyBootAt"])
	}
	if body["installed"] != false {
		t.Errorf("installed = %v, want false (empty extensions dir)", body["installed"])
	}
}

func TestCodeBridgeEmptyBootMarker(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	stamp := "2026-09-10T02:45:39.941Z"
	writeBootMarker(t, state, "boot-a", "@7", "default", os.Getpid(), stamp)
	// A same-tab marker on ANOTHER server must not leak into the answer.
	writeBootMarker(t, state, "boot-b", "@7", "other", os.Getpid(), "2026-09-10T03:00:00.000Z")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge?server=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	body := decodeCodeBridge(t, rec)
	if body["emptyBootAt"] != stamp {
		t.Errorf("emptyBootAt = %v, want %q", body["emptyBootAt"], stamp)
	}
	if body["startedAt"] != "" {
		t.Errorf("startedAt = %v, want \"\" (no host records)", body["startedAt"])
	}
}

func TestCodeBridgeDeadPidMarker(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	// PID 2**30-1 cannot exist (kill -0 fails), so the marker is invisible.
	writeBootMarker(t, state, "boot-dead", "@7", "default", 1<<30-1, "2026-09-10T02:45:39.941Z")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge?server=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	if body := decodeCodeBridge(t, rec); body["emptyBootAt"] != "" {
		t.Errorf("emptyBootAt = %v, want \"\" for a dead pid", body["emptyBootAt"])
	}
}

func TestCodeBridgeInstalledFromExtensionsDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	writeBridgeExtFixture(t, data, "1.2.3")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	body := decodeCodeBridge(t, rec)
	if body["installed"] != true {
		t.Errorf("installed = %v, want true", body["installed"])
	}
	if body["startedAt"] != "" {
		t.Errorf("startedAt = %v, want \"\" (no hosts dir)", body["startedAt"])
	}
}

func TestCodeBridgeMissingHostsDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir()) // no hexokit/cb/hosts at all
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	body := decodeCodeBridge(t, rec)
	if body["startedAt"] != "" {
		t.Errorf("startedAt = %v, want \"\"", body["startedAt"])
	}
}

func TestCodeBridgeDeadPidRecord(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	// PID 2**30-1 cannot exist (kill -0 fails), so the record is invisible.
	writeHostRecord(t, state, "host-dead", "@7", "default", 1<<30-1, "2026-09-10T02:45:39.941Z")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge?server=default")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %q)", rec.Code, rec.Body.String())
	}
	if body := decodeCodeBridge(t, rec); body["startedAt"] != "" {
		t.Errorf("startedAt = %v, want \"\" for a dead pid", body["startedAt"])
	}
}

func TestCodeBridgeBadWindowID(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/7/code-bridge")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %q)", rec.Code, rec.Body.String())
	}
}

func TestCodeBridgeBadServer(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	rec := getCodeBridge(t, router, "/api/windows/@7/code-bridge?server=../etc")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %q)", rec.Code, rec.Body.String())
	}
}
