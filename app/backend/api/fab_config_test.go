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
	"sync"
	"testing"

	"rk/internal/fabsysconfig"
)

// fabStub is a scripted fab runner for the handler tests: it records every
// argv and never reaches the real binary or ~/.fab-kit/config.yaml.
type fabStub struct {
	mu      sync.Mutex
	calls   []string
	failOn  string
	failMsg string
	// presets is the stdout of `agent presets --json`; empty exits non-zero,
	// like a fab without the verb.
	presets string
}

const fabStubShow = `[
 {"key":"agent.session","value":"claude","origin":"system","origin_detail":"/home/u/.fab-kit/config.yaml","status":"effective"},
 {"key":"agent.workers","value":"claude","origin":"default","origin_detail":"","status":"effective"},
 {"key":"dispatch.mode","value":"pane","origin":"default","origin_detail":"","status":"effective"},
 {"key":"providers.claude.interactive_command","value":"claude","origin":"default","origin_detail":""},
 {"key":"providers.codex.interactive_command","value":"codex","origin":"default","origin_detail":""}
]`

func (f *fabStub) run(_ context.Context, argv ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	joined := strings.Join(argv, " ")
	f.calls = append(f.calls, joined)
	if f.failOn != "" && strings.HasPrefix(joined, f.failOn) {
		return nil, []byte(f.failMsg), errors.New("exit 1")
	}
	switch {
	case joined == "config show --origin --json":
		return []byte(fabStubShow), nil, nil
	case joined == "config explain --json":
		return []byte(`[]`), nil, nil
	case joined == "agent presets --json" && f.presets != "":
		return []byte(f.presets), nil, nil
	case strings.HasPrefix(joined, "config set "), strings.HasPrefix(joined, "config unset "):
		return nil, nil, nil
	}
	return nil, []byte("unscripted: " + joined), errors.New("exit 1")
}

func (f *fabStub) mutations() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, "config set ") || strings.HasPrefix(c, "config unset ") {
			out = append(out, c)
		}
	}
	return out
}

func fabConfigServer(stub *fabStub) *Server {
	s := &Server{logger: slog.New(slog.NewTextHandler(os.Stderr, nil)), hostname: "test"}
	if stub != nil {
		s.fabSys = fabsysconfig.New(stub.run)
	}
	return s
}

func fabPost(s *Server, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/fab-config", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.handlePostFabConfig(rec, req)
	return rec
}

func TestGetFabConfig_returnsFreshDocument(t *testing.T) {
	stub := &fabStub{}
	s := fabConfigServer(stub)
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		s.handleGetFabConfig(rec, httptest.NewRequest(http.MethodGet, "/api/fab-config", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		var doc fabsysconfig.Document
		if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		if !doc.Installed || len(doc.Tools) != 2 || doc.Fields["agent.session"].Origin != "system" {
			t.Errorf("document = %+v", doc)
		}
	}
	shows := 0
	for _, c := range stub.calls {
		if c == "config show --origin --json" {
			shows++
		}
	}
	if shows != 2 {
		t.Errorf("show calls = %d, want 2 (every GET re-reads fab)", shows)
	}
}

func TestGetFabConfig_notInstalled(t *testing.T) {
	s := fabConfigServer(nil)
	s.fabSys = fabsysconfig.New(func(context.Context, ...string) ([]byte, []byte, error) {
		t.Fatal("fab must not run when absent")
		return nil, nil, nil
	}).WithLookPath(func(string) (string, error) { return "", errors.New("missing") })

	rec := httptest.NewRecorder()
	s.handleGetFabConfig(rec, httptest.NewRequest(http.MethodGet, "/api/fab-config", nil))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"installed":false}` {
		t.Errorf("got %d %s, want 200 {\"installed\":false}", rec.Code, rec.Body.String())
	}
}

func TestPostFabConfig_partialMergeAndNullUnset(t *testing.T) {
	stub := &fabStub{}
	rec := fabPost(fabConfigServer(stub), `{"agent.workers":"codex","agent.profiles.review.model":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	got := stub.mutations()
	want := []string{"config unset agent.profiles.review.model --system", "config set agent.workers codex --system"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("mutations = %v, want %v", got, want)
	}
	var doc fabsysconfig.Document
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil || !doc.Installed {
		t.Errorf("response must be the re-read document, got %s (%v)", rec.Body.String(), err)
	}
}

func TestPostFabConfig_validationIs400WithoutExec(t *testing.T) {
	for _, body := range []string{
		`{"dispatch.mode":"weird"}`,
		`{"providers.codex.native":true}`,
		`{"agent.workers":"bogus"}`,
		`not json`,
		`null`,
	} {
		stub := &fabStub{}
		rec := fabPost(fabConfigServer(stub), body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", body, rec.Code)
		}
		if m := stub.mutations(); len(m) != 0 {
			t.Errorf("%s: mutations = %v, want none", body, m)
		}
	}
}

func TestPostFabConfig_fabFailureIs502WithStderr(t *testing.T) {
	stub := &fabStub{failOn: "config set dispatch.mode", failMsg: "fab: refusing to set dispatch.mode"}
	rec := fabPost(fabConfigServer(stub), `{"dispatch.mode":"pane"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "refusing to set dispatch.mode") {
		t.Errorf("body = %s, want fab's stderr verbatim", rec.Body.String())
	}
}

func TestPostFabConfig_notInstalledIs503(t *testing.T) {
	s := fabConfigServer(nil)
	s.fabSys = fabsysconfig.New(func(context.Context, ...string) ([]byte, []byte, error) {
		t.Fatal("must not run")
		return nil, nil, nil
	}).WithLookPath(func(string) (string, error) { return "", errors.New("missing") })
	if rec := fabPost(s, `{"agent.workers":"codex"}`); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

const fabStubPresets = `[
 {"name":"claude","description":"All roles on Claude","source":"built-in","session":"claude","workers":"claude"},
 {"name":"codex-review","description":"Only the review role on Codex","source":"built-in","profiles":{"review":{"cli":"codex"}}}
]`

func TestGetFabConfig_carriesAgentPresets(t *testing.T) {
	s := fabConfigServer(&fabStub{presets: fabStubPresets})
	rec := httptest.NewRecorder()
	s.handleGetFabConfig(rec, httptest.NewRequest(http.MethodGet, "/api/fab-config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var doc fabsysconfig.Document
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.AgentPresets) != 2 || doc.AgentPresets[1].Name != "codex-review" || doc.AgentPresets[1].Profiles["review"]["cli"] != "codex" {
		t.Errorf("agent_presets = %+v", doc.AgentPresets)
	}
	if _, ok := doc.Fields["agent.preset"]; ok {
		t.Errorf("fields[agent.preset] present while unset: %+v", doc.Fields["agent.preset"])
	}
}

func TestGetFabConfig_olderFabHasNoAgentPresetsKey(t *testing.T) {
	s := fabConfigServer(&fabStub{})
	rec := httptest.NewRecorder()
	s.handleGetFabConfig(rec, httptest.NewRequest(http.MethodGet, "/api/fab-config", nil))
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "agent_presets") {
		t.Errorf("got %d %s, want 200 without agent_presets", rec.Code, rec.Body.String())
	}
}

func TestPostFabConfig_agentPreset(t *testing.T) {
	t.Run("a listed preset is written", func(t *testing.T) {
		stub := &fabStub{presets: fabStubPresets}
		rec := fabPost(fabConfigServer(stub), `{"agent.preset":"codex-review"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if got := stub.mutations(); len(got) != 1 || got[0] != "config set agent.preset codex-review --system" {
			t.Errorf("mutations = %v", got)
		}
	})
	t.Run("an unknown preset is 400 without a write", func(t *testing.T) {
		stub := &fabStub{presets: fabStubPresets}
		rec := fabPost(fabConfigServer(stub), `{"agent.preset":"bogus"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `unknown agent preset \"bogus\" (available: claude, codex-review)`) {
			t.Errorf("body = %s", rec.Body.String())
		}
		if m := stub.mutations(); len(m) != 0 {
			t.Errorf("mutations = %v, want none", m)
		}
	})
	t.Run("an older fab is 400 without a write", func(t *testing.T) {
		stub := &fabStub{}
		rec := fabPost(fabConfigServer(stub), `{"agent.preset":"claude"}`)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "not supported by the installed fab") {
			t.Errorf("got %d %s", rec.Code, rec.Body.String())
		}
		if m := stub.mutations(); len(m) != 0 {
			t.Errorf("mutations = %v, want none", m)
		}
	})
	t.Run("null unsets", func(t *testing.T) {
		stub := &fabStub{}
		rec := fabPost(fabConfigServer(stub), `{"agent.preset":null}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		if got := stub.mutations(); len(got) != 1 || got[0] != "config unset agent.preset --system" {
			t.Errorf("mutations = %v", got)
		}
	})
}
