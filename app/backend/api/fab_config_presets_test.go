package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"rk/internal/fabsysconfig"
	"rk/internal/tmux"
)

const presetsWithYours = `[
 {"name":"claude","description":"All roles on Claude","source":"built-in","session":"claude","workers":"claude"},
 {"name":"codex-review","description":"Only the review role on Codex","source":"built-in","profiles":{"review":{"cli":"codex"}}},
 {"name":"night-shift","description":"Overnight","source":"system","workers":"codex"}
]`

const showWithDefault = `[
 {"key":"agent.preset","value":"night-shift","origin":"system","origin_detail":"/home/u/.fab-kit/config.yaml","status":"effective"},
 {"key":"agent.session","value":"claude","origin":"default","origin_detail":"","status":"effective"},
 {"key":"agent.workers","value":"claude","origin":"default","origin_detail":"","status":"effective"},
 {"key":"providers.claude.interactive_command","value":"claude","origin":"default","origin_detail":""},
 {"key":"providers.codex.interactive_command","value":"codex","origin":"default","origin_detail":""}
]`

// twoServerTmux is a daemon covering two tmux servers: a workspace option and
// a group naming night-shift on "default", a group on "work".
type twoServerTmux struct {
	*mockTmuxOps
	sessions map[string][]tmux.SessionInfo
}

func (p twoServerTmux) ListServers(context.Context) ([]string, error) {
	return []string{"default", "work"}, nil
}

func (p twoServerTmux) ListSessions(_ context.Context, server string) ([]tmux.SessionInfo, error) {
	return p.sessions[server], nil
}

func newTwoServerTmux() twoServerTmux {
	return twoServerTmux{
		mockTmuxOps: &mockTmuxOps{agentPresetOptions: map[string]string{"server:default": "night-shift"}},
		sessions: map[string][]tmux.SessionInfo{
			"default": {{Name: "hexokit", AgentPreset: "night-shift"}, {Name: "other", AgentPreset: "claude"}, {Name: "bare"}},
			"work":    {{Name: "api", AgentPreset: "night-shift"}},
		},
	}
}

func presetOpServer(stub *fabStub, ops TmuxOps) *Server {
	s := fabConfigServer(stub)
	s.tmux = ops
	return s
}

func post(h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return rec
}

func TestRenameAgentPreset_repointsMachineDefaultWorkspaceAndGroupsAcrossServers(t *testing.T) {
	stub := &fabStub{presets: presetsWithYours, show: showWithDefault}
	ops := newTwoServerTmux()
	s := presetOpServer(stub, ops)
	rec := post(s.handleRenameAgentPreset, "/api/fab-config/presets/rename", `{"from":"night-shift","to":"late-shift"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	wantFab := []string{
		"config set agent_presets.late-shift.description Overnight --system",
		"config set agent_presets.late-shift.workers codex --system",
		"config set agent.preset late-shift --system",
		"config unset agent_presets.night-shift --system",
	}
	if got := stub.mutations(); !reflect.DeepEqual(got, wantFab) {
		t.Errorf("fab mutations = %v, want %v", got, wantFab)
	}
	wantTmux := []string{"set-server default late-shift", "set-session hexokit late-shift default", "set-session api late-shift work"}
	if !reflect.DeepEqual(ops.agentPresetCalls, wantTmux) {
		t.Errorf("tmux calls = %v, want %v", ops.agentPresetCalls, wantTmux)
	}
	var doc fabsysconfig.Document
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil || !doc.Installed {
		t.Errorf("response must be the re-read document, got %s (%v)", rec.Body.String(), err)
	}
}

func TestDeleteAgentPreset_clearsMachineDefaultWorkspaceAndGroups(t *testing.T) {
	stub := &fabStub{presets: presetsWithYours, show: showWithDefault}
	ops := newTwoServerTmux()
	s := presetOpServer(stub, ops)
	rec := post(s.handleDeleteAgentPreset, "/api/fab-config/presets/delete", `{"name":"night-shift"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	wantFab := []string{"config unset agent.preset --system", "config unset agent_presets.night-shift --system"}
	if got := stub.mutations(); !reflect.DeepEqual(got, wantFab) {
		t.Errorf("fab mutations = %v, want %v", got, wantFab)
	}
	wantTmux := []string{"unset-server default", "unset-session hexokit default", "unset-session api work"}
	if !reflect.DeepEqual(ops.agentPresetCalls, wantTmux) {
		t.Errorf("tmux calls = %v, want %v", ops.agentPresetCalls, wantTmux)
	}
}

func TestPresetOps_validationIs400WithoutExec(t *testing.T) {
	cases := map[string]struct {
		h    func(*Server) http.HandlerFunc
		body string
	}{
		"duplicate bad name": {func(s *Server) http.HandlerFunc { return s.handleDuplicateAgentPreset }, `{"from":"claude","to":"a b","description":"d"}`},
		"rename bad name":    {func(s *Server) http.HandlerFunc { return s.handleRenameAgentPreset }, `{"from":"night-shift","to":"--x"}`},
		"rename built-in":    {func(s *Server) http.HandlerFunc { return s.handleRenameAgentPreset }, `{"from":"claude","to":"x"}`},
		"delete built-in":    {func(s *Server) http.HandlerFunc { return s.handleDeleteAgentPreset }, `{"name":"claude"}`},
		"move taken":         {func(s *Server) http.HandlerFunc { return s.handleMoveLeftoverSettings }, `{"name":"claude","description":"d"}`},
		"invalid json":       {func(s *Server) http.HandlerFunc { return s.handleRenameAgentPreset }, `nope`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			stub := &fabStub{presets: presetsWithYours, show: showWithDefault}
			ops := newTwoServerTmux()
			s := presetOpServer(stub, ops)
			rec := post(tc.h(s), "/x", tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if m := stub.mutations(); len(m) != 0 || len(ops.agentPresetCalls) != 0 {
				t.Errorf("mutations = %v, tmux = %v, want none", m, ops.agentPresetCalls)
			}
		})
	}
}

func TestRenameAgentPreset_partialFailureIs502NamingWhatLanded(t *testing.T) {
	stub := &fabStub{presets: presetsWithYours, show: showWithDefault, failOn: "config set agent.preset", failMsg: "disk full"}
	s := presetOpServer(stub, newTwoServerTmux())
	rec := post(s.handleRenameAgentPreset, "/x", `{"from":"night-shift","to":"late-shift"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error  string   `json:"error"`
		Landed []string `json:"landed"`
		Failed string   `json:"failed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	wantLanded := []string{"set agent_presets.late-shift.description Overnight", "set agent_presets.late-shift.workers codex"}
	if !reflect.DeepEqual(body.Landed, wantLanded) || body.Failed != "set agent.preset late-shift" || !strings.Contains(body.Error, "disk full") {
		t.Errorf("body = %+v", body)
	}
	for _, m := range stub.mutations() {
		if strings.HasPrefix(m, "config unset agent_presets.night-shift") {
			t.Errorf("the old preset was removed: %v", stub.mutations())
		}
	}
}

func TestLeftovers_moveAndClear(t *testing.T) {
	show := `[
 {"key":"agent.workers","value":"codex","origin":"system","origin_detail":"/home/u/.fab-kit/config.yaml","status":"effective"},
 {"key":"agent.profiles.review.model","value":"m","origin":"system","origin_detail":"/home/u/.fab-kit/config.yaml","status":"effective"},
 {"key":"providers.codex.interactive_command","value":"codex","origin":"default","origin_detail":""}
]`
	t.Run("move", func(t *testing.T) {
		stub := &fabStub{presets: presetsWithYours, show: show}
		s := presetOpServer(stub, newTwoServerTmux())
		rec := post(s.handleMoveLeftoverSettings, "/x", `{"name":"my-overrides","description":"Moved from loose machine-wide settings"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		want := []string{
			"config set agent_presets.my-overrides.description Moved from loose machine-wide settings --system",
			"config set agent_presets.my-overrides.workers codex --system",
			"config set agent_presets.my-overrides.profiles.review.model m --system",
			"config set agent.preset my-overrides --system",
			"config unset agent.workers --system",
			"config unset agent.profiles.review.model --system",
		}
		if got := stub.mutations(); !reflect.DeepEqual(got, want) {
			t.Errorf("mutations = %v, want %v", got, want)
		}
	})
	t.Run("clear", func(t *testing.T) {
		stub := &fabStub{presets: presetsWithYours, show: show}
		s := presetOpServer(stub, newTwoServerTmux())
		rec := post(s.handleClearLeftoverSettings, "/x", `{}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		want := []string{"config unset agent.workers --system", "config unset agent.profiles.review.model --system"}
		if got := stub.mutations(); !reflect.DeepEqual(got, want) {
			t.Errorf("mutations = %v, want %v", got, want)
		}
	})
}

func TestDuplicateAgentPreset_copiesABuiltIn(t *testing.T) {
	stub := &fabStub{presets: presetsWithYours}
	s := presetOpServer(stub, newTwoServerTmux())
	rec := post(s.handleDuplicateAgentPreset, "/x", `{"from":"codex-review","to":"codex-review-copy","description":"Mine"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	want := []string{
		"config set agent_presets.codex-review-copy.description Mine --system",
		"config set agent_presets.codex-review-copy.profiles.review.cli codex --system",
	}
	if got := stub.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestResolveAgentPreset(t *testing.T) {
	stub := &fabStub{resolved: map[string]string{
		"review codex-review": "cli: codex\nmodel: gpt-5.6-sol\neffort: xhigh\n",
	}}
	s := fabConfigServer(stub)
	rec := httptest.NewRecorder()
	s.handleResolveAgentPreset(rec, httptest.NewRequest(http.MethodGet, "/api/fab-config/presets/resolve?name=codex-review", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Roles map[string]fabsysconfig.ResolvedRole `json:"roles"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if got := body.Roles["review"]; got != (fabsysconfig.ResolvedRole{CLI: "codex", Model: "gpt-5.6-sol", Effort: "xhigh"}) {
		t.Errorf("review = %+v", got)
	}
	if got := body.Roles["doing"]; got != (fabsysconfig.ResolvedRole{}) {
		t.Errorf("a role fab cannot resolve must be empty, got %+v", got)
	}
	if len(body.Roles) != len(fabsysconfig.Roles) {
		t.Errorf("roles = %d, want %d", len(body.Roles), len(fabsysconfig.Roles))
	}

	bad := httptest.NewRecorder()
	s.handleResolveAgentPreset(bad, httptest.NewRequest(http.MethodGet, "/api/fab-config/presets/resolve?name=a%20b", nil))
	if bad.Code != http.StatusBadRequest {
		t.Errorf("bad name status = %d, want 400", bad.Code)
	}
}

func TestPresetRoutes_verbs(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	for _, path := range []string{
		"/api/fab-config/presets/duplicate", "/api/fab-config/presets/rename", "/api/fab-config/presets/delete",
		"/api/fab-config/leftovers/move",
	} {
		get := httptest.NewRecorder()
		router.ServeHTTP(get, httptest.NewRequest(http.MethodGet, path, nil))
		if get.Code < 400 {
			t.Errorf("GET %s = %d, want a refusal (writes are POST-only)", path, get.Code)
		}
		bad := httptest.NewRecorder()
		router.ServeHTTP(bad, httptest.NewRequest(http.MethodPost, path, strings.NewReader("not json")))
		if bad.Code != http.StatusBadRequest {
			t.Errorf("POST %s = %d, want 400 (routed, body rejected before fab)", path, bad.Code)
		}
	}
	post := httptest.NewRecorder()
	router.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/fab-config/presets/resolve", nil))
	if post.Code < 400 {
		t.Errorf("POST resolve = %d, want a refusal (the read is GET-only)", post.Code)
	}
}

// brokenSessionsTmux fails the group listing of one server.
type brokenSessionsTmux struct {
	twoServerTmux
	failServer string
	err        error
}

func (p brokenSessionsTmux) ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
	if server == p.failServer {
		return nil, p.err
	}
	return p.twoServerTmux.ListSessions(ctx, server)
}

func TestPresetOps_aTmuxListingFailureIs502BeforeAnyWrite(t *testing.T) {
	for name, h := range map[string]struct {
		call func(*Server) http.HandlerFunc
		body string
	}{
		"rename": {func(s *Server) http.HandlerFunc { return s.handleRenameAgentPreset }, `{"from":"night-shift","to":"late-shift"}`},
		"delete": {func(s *Server) http.HandlerFunc { return s.handleDeleteAgentPreset }, `{"name":"night-shift"}`},
	} {
		t.Run(name, func(t *testing.T) {
			stub := &fabStub{presets: presetsWithYours, show: showWithDefault}
			ops := brokenSessionsTmux{twoServerTmux: newTwoServerTmux(), failServer: "work", err: errors.New("protocol error")}
			s := presetOpServer(stub, ops)
			rec := post(h.call(s), "/x", h.body)
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "nothing was changed") || !strings.Contains(rec.Body.String(), "work") {
				t.Errorf("body = %s", rec.Body.String())
			}
			if m := stub.mutations(); len(m) != 0 {
				t.Errorf("mutations = %v, want none", m)
			}
		})
	}
}

func TestPresetOps_aGoneServerIsSkippedWhenListingOptions(t *testing.T) {
	stub := &fabStub{presets: presetsWithYours, show: showWithDefault}
	base := newTwoServerTmux()
	ops := brokenSessionsTmux{twoServerTmux: base, failServer: "work", err: errors.New("no server running on /tmp/tmux-1000/work")}
	s := presetOpServer(stub, ops)
	rec := post(s.handleDeleteAgentPreset, "/x", `{"name":"night-shift"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if len(base.agentPresetCalls) != 2 {
		t.Errorf("tmux calls = %v, want the workspace and group on the live server", base.agentPresetCalls)
	}
}
