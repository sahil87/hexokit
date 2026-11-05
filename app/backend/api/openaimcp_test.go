package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/daemon"
	"rk/internal/metrics"
	"rk/internal/openaimcp"
	"rk/internal/ports"
	"rk/internal/sessions"
	"rk/internal/settings"
)

const testOpenAIKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"

type openAIMCPCalls struct {
	ensures, kills, restarts int
	restartErr               error
}

// newOpenAIMCPServer builds a routed server whose connector lifecycle seams
// count calls and whose layout lives in a temp dir.
func newOpenAIMCPServer(t *testing.T) (*Server, *openAIMCPCalls, openaimcp.Layout) {
	t.Helper()
	isolateSettings(t)
	calls := &openAIMCPCalls{}
	layout := openaimcp.Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}
	server := &Server{
		logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		sessions: &mockSessionFetcher{},
		tmux:     &mockTmuxOps{},
		hostname: "test-host",
		openAIMCPEnsureFn: func() (daemon.OpenAIMCPEnsureOutcome, error) {
			calls.ensures++
			return daemon.OpenAIMCPEnsureStarted, nil
		},
		openAIMCPKillFn:    func() (bool, error) { calls.kills++; return true, nil },
		openAIMCPRestartFn: func() error { calls.restarts++; return calls.restartErr },
		openAIMCPLayoutFn:  func() (openaimcp.Layout, error) { return layout, nil },
	}
	return server, calls, layout
}

func enableConnector(t *testing.T) {
	t.Helper()
	s := settings.Load()
	s.OpenAIMCPEnabled = true
	s.OpenAIMCPTunnelID = "tunnel_abc123"
	if err := settings.Save(s); err != nil {
		t.Fatal(err)
	}
}

func decodeBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("body %q: %v", body, err)
	}
	return m
}

func TestOpenAIMCPKeySaveAndClear(t *testing.T) {
	server, calls, layout := newOpenAIMCPServer(t)
	router := server.buildRouter()

	rec := postJSON(t, router, "/api/openai-mcp/key", `{"key":"`+testOpenAIKey+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status %d, body %s", rec.Code, rec.Body.String())
	}
	if got := decodeBody(t, rec.Body.String()); got["keySet"] != true || got["ok"] != true {
		t.Errorf("save body = %v, want ok + keySet true", got)
	}
	if strings.Contains(rec.Body.String(), testOpenAIKey) {
		t.Error("the response echoed the key")
	}
	if !layout.KeySet() {
		t.Error("key not written")
	}
	if calls.restarts != 0 || calls.kills != 0 {
		t.Errorf("connector off, yet restarts=%d kills=%d", calls.restarts, calls.kills)
	}

	rec = postJSON(t, router, "/api/openai-mcp/key", `{"key":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear: status %d", rec.Code)
	}
	if got := decodeBody(t, rec.Body.String()); got["keySet"] != false {
		t.Errorf("clear body = %v, want keySet false", got)
	}
	if layout.KeySet() {
		t.Error("key not cleared")
	}
}

func TestOpenAIMCPKeyRestartsWhenOn(t *testing.T) {
	server, calls, _ := newOpenAIMCPServer(t)
	enableConnector(t)
	router := server.buildRouter()

	if rec := postJSON(t, router, "/api/openai-mcp/key", `{"key":"`+testOpenAIKey+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("save: status %d", rec.Code)
	}
	if calls.restarts != 1 {
		t.Errorf("save while on: restarts = %d, want 1", calls.restarts)
	}
	if rec := postJSON(t, router, "/api/openai-mcp/key", `{"key":""}`); rec.Code != http.StatusOK {
		t.Fatalf("clear: status %d", rec.Code)
	}
	if calls.kills != 1 || calls.restarts != 1 {
		t.Errorf("clear while on: kills=%d restarts=%d, want the session stopped, not restarted", calls.kills, calls.restarts)
	}
}

func TestOpenAIMCPKeyRejectsBadInput(t *testing.T) {
	server, calls, layout := newOpenAIMCPServer(t)
	enableConnector(t)
	router := server.buildRouter()
	for _, body := range []string{`{"key":"sk-short"}`, `{"key":"not-a-key-at-all-xxxxxxxxxxxxxxxx"}`, `{}`, `{"key":null}`, `{"key":42}`, `not json`} {
		rec := postJSON(t, router, "/api/openai-mcp/key", body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s: status %d, want 400", body, rec.Code)
		}
	}
	if layout.KeySet() {
		t.Error("a rejected key touched disk")
	}
	if calls.restarts != 0 || calls.kills != 0 {
		t.Errorf("rejected input caused restarts=%d kills=%d", calls.restarts, calls.kills)
	}
}

func TestOpenAIMCPRestartRoute(t *testing.T) {
	server, calls, _ := newOpenAIMCPServer(t)
	router := server.buildRouter()

	if rec := postJSON(t, router, "/api/openai-mcp/restart", `{}`); rec.Code != http.StatusConflict {
		t.Errorf("restart while off: status %d, want 409", rec.Code)
	}
	if calls.restarts != 0 {
		t.Errorf("restart while off called the restart seam %d times", calls.restarts)
	}

	enableConnector(t)
	if rec := postJSON(t, router, "/api/openai-mcp/restart", `{}`); rec.Code != http.StatusOK {
		t.Errorf("restart while on: status %d, body %s", rec.Code, rec.Body.String())
	}
	calls.restartErr = errors.New("no API key saved")
	rec := postJSON(t, router, "/api/openai-mcp/restart", `{}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "no API key saved") {
		t.Errorf("failed restart: status %d body %s, want 500 naming the cause", rec.Code, rec.Body.String())
	}
}

func TestPostSettingsOpenAIMCPSideEffects(t *testing.T) {
	t.Run("on ensures", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.enabled": true}`); rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		if calls.ensures != 1 || calls.kills != 0 || calls.restarts != 0 {
			t.Errorf("calls = %+v, want one ensure", *calls)
		}
	})
	t.Run("off kills", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		enableConnector(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.enabled": false}`); rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		if calls.kills != 1 || calls.ensures != 0 {
			t.Errorf("calls = %+v, want one kill", *calls)
		}
	})
	t.Run("tunnel change while on restarts", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		enableConnector(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.tunnel_id": "tunnel_def456"}`); rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		if calls.restarts != 1 {
			t.Errorf("calls = %+v, want one restart", *calls)
		}
	})
	t.Run("tunnel change while off does nothing", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.tunnel_id": "tunnel_def456"}`); rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		if *calls != (openAIMCPCalls{}) {
			t.Errorf("calls = %+v, want none", *calls)
		}
	})
	t.Run("off and a tunnel change in one patch still kills", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		enableConnector(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.enabled": false, "openai_mcp.tunnel_id": "tunnel_def456"}`); rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		if calls.kills != 1 || calls.restarts != 0 || calls.ensures != 0 {
			t.Errorf("calls = %+v, want exactly one kill", *calls)
		}
	})
	t.Run("malformed tunnel ID is a 400 with no side effect", func(t *testing.T) {
		server, calls, _ := newOpenAIMCPServer(t)
		enableConnector(t)
		if rec := postJSON(t, server.buildRouter(), "/api/settings", `{"openai_mcp.tunnel_id": "nope"}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("status %d, want 400", rec.Code)
		}
		if *calls != (openAIMCPCalls{}) {
			t.Errorf("calls = %+v, want none", *calls)
		}
	})
}

// TestSSEHubOpenAIMCPEmitsOnRefresh: a forced refresh makes the next tick
// re-probe inside the TTL, and a changed status ships exactly once.
func TestSSEHubOpenAIMCPEmitsOnRefresh(t *testing.T) {
	isolateSettings(t)
	hub := newSSEHub(&slowSessionFetcher{result: []sessions.ProjectSession{}}, metrics.NewCollector(2500*time.Millisecond), ports.NewCollector(2500*time.Millisecond), nil)
	hub.safetyInterval = 50 * time.Millisecond
	state := daemon.OpenAIMCPStateStopped
	hub.openAIMCPProbeFn = func() daemon.OpenAIMCPStatus {
		return daemon.OpenAIMCPStatus{Enabled: true, TunnelIDSet: true, KeySet: true, State: state}
	}

	client := hub.addTestClient(make(chan hubEvent, 64), metricsOnlyServer)
	defer hub.removeClient(client)
	time.Sleep(200 * time.Millisecond)
	first := openAIMCPFrames(drainConnEvents(client.ch))
	if len(first) != 1 || !strings.Contains(first[0], `"state":"stopped"`) {
		t.Fatalf("first frames = %q, want one stopped frame", first)
	}

	state = daemon.OpenAIMCPStateReady
	hub.refreshOpenAIMCP()
	time.Sleep(200 * time.Millisecond)
	second := openAIMCPFrames(drainConnEvents(client.ch))
	if len(second) != 1 || !strings.Contains(second[0], `"state":"ready"`) {
		t.Fatalf("after refresh frames = %q, want one ready frame (inside the TTL)", second)
	}
	if strings.Contains(second[0], "sk-") {
		t.Error("status payload carries key material")
	}
}

func openAIMCPFrames(frames []string) []string {
	var out []string
	for _, f := range frames {
		if strings.HasPrefix(f, "event: openai-mcp") {
			out = append(out, f)
		}
	}
	return out
}
