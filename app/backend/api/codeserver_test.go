package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rk/internal/daemon"
)

func postCodeServerRestart(t *testing.T, version string, fn func() (daemon.EnsureOutcome, error)) *httptest.ResponseRecorder {
	t.Helper()
	orig := restartCodeServerFn
	t.Cleanup(func() { restartCodeServerFn = orig })
	restartCodeServerFn = fn
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/code-server/restart", nil)
	newRestartServer(version).handleCodeServerRestart(rec, req)
	return rec
}

func TestHandleCodeServerRestartStatusMapping(t *testing.T) {
	for outcome, want := range map[daemon.EnsureOutcome]string{
		daemon.EnsureStarted:           "started",
		daemon.EnsureInstallJobSpawned: "installing",
		daemon.EnsureExternallyManaged: "external",
	} {
		res := postCodeServerRestart(t, "0.5.3", func() (daemon.EnsureOutcome, error) { return outcome, nil })
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"status":"`+want+`"`) {
			t.Errorf("outcome %v: got %d %s, want 200 status %q", outcome, res.Code, res.Body.String(), want)
		}
	}
}

func TestHandleCodeServerRestartErrorIs500(t *testing.T) {
	res := postCodeServerRestart(t, "0.5.3", func() (daemon.EnsureOutcome, error) {
		return daemon.EnsureStarted, errors.New("code-server did not come up")
	})
	if res.Code != http.StatusInternalServerError || !strings.Contains(res.Body.String(), "did not come up") {
		t.Errorf("got %d %s, want 500 with the error text", res.Code, res.Body.String())
	}
}

func TestHandleCodeServerRestartDevBuildRefused(t *testing.T) {
	called := false
	res := postCodeServerRestart(t, devVersion, func() (daemon.EnsureOutcome, error) { called = true; return daemon.EnsureStarted, nil })
	if res.Code != http.StatusConflict || called {
		t.Errorf("got %d (restart called=%v), want 409 without consulting the restart seam", res.Code, called)
	}
}
