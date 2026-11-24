package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rk/internal/fabsysconfig"
)

var testAgentPresets = []fabsysconfig.AgentPreset{
	{Name: "claude", Source: "built-in"},
	{Name: "codex-review", Source: "built-in"},
}

// stubAgentPresets installs a fixed preset table and records the dirs asked.
func stubAgentPresets(t *testing.T, presets []fabsysconfig.AgentPreset, err error) *[]string {
	t.Helper()
	orig := listAgentPresets
	var dirs []string
	listAgentPresets = func(_ context.Context, dir string) ([]fabsysconfig.AgentPreset, error) {
		dirs = append(dirs, dir)
		return presets, err
	}
	t.Cleanup(func() { listAgentPresets = orig })
	return &dirs
}

func postAgentPreset(t *testing.T, ops TmuxOps, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouter(&mockSessionFetcher{}, ops)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestSessionAgentPreset_setAndClear(t *testing.T) {
	repo := gitRepoDir(t)
	dirs := stubAgentPresets(t, testAgentPresets, nil)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}

	if rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset?server=s1", `{"agent_preset":"codex-review"}`); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Fatalf("set: status %d body %s", rec.Code, rec.Body.String())
	}
	if len(*dirs) != 1 || (*dirs)[0] != repo {
		t.Errorf("membership read in %v, want the session's repo root %q", *dirs, repo)
	}
	if rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset?server=s1", `{"agent_preset":null}`); rec.Code != 200 {
		t.Fatalf("clear null: status %d", rec.Code)
	}
	if rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset?server=s1", `{"agent_preset":""}`); rec.Code != 200 {
		t.Fatalf("clear empty: status %d", rec.Code)
	}
	want := []string{"set-session proj codex-review s1", "unset-session proj s1", "unset-session proj s1"}
	if strings.Join(ops.agentPresetCalls, "|") != strings.Join(want, "|") {
		t.Errorf("tmux calls = %v, want %v", ops.agentPresetCalls, want)
	}
	if len(*dirs) != 1 {
		t.Errorf("clearing consulted fab (%v), want only the set to", *dirs)
	}
}

func TestSessionAgentPreset_noneAndMachineFallback(t *testing.T) {
	dirs := stubAgentPresets(t, testAgentPresets, nil)
	// No windows → no repo → the machine-wide list.
	ops := &mockTmuxOps{}
	if rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset", `{"agent_preset":"none"}`); rec.Code != 200 {
		t.Fatalf("none: status %d body %s", rec.Code, rec.Body.String())
	}
	if len(*dirs) != 1 || (*dirs)[0] != machinePresetDir() {
		t.Errorf("membership read in %v, want machine dir %q", *dirs, machinePresetDir())
	}
}

func TestSessionAgentPreset_rejectsWithoutWriting(t *testing.T) {
	cases := []struct {
		name    string
		presets []fabsysconfig.AgentPreset
		err     error
		body    string
		wantMsg string
		fabRuns int
	}{
		{"bad charset", testAgentPresets, nil, `{"agent_preset":"--x"}`, "must not start with a hyphen", 0},
		{"semicolon", testAgentPresets, nil, `{"agent_preset":"a;b"}`, "alphanumeric", 0},
		{"unknown", testAgentPresets, nil, `{"agent_preset":"nope"}`, `unknown agent preset "nope" (available: claude, codex-review)`, 1},
		{"unsupported fab", nil, fabsysconfig.ErrPresetsUnsupported, `{"agent_preset":"claude"}`, "agent presets are not supported by the installed fab", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dirs := stubAgentPresets(t, tc.presets, tc.err)
			ops := &mockTmuxOps{}
			rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset", tc.body)
			body := strings.ReplaceAll(rec.Body.String(), `\"`, `"`)
			if rec.Code != http.StatusBadRequest || !strings.Contains(body, tc.wantMsg) {
				t.Fatalf("status %d body %s, want 400 containing %q", rec.Code, body, tc.wantMsg)
			}
			if len(ops.agentPresetCalls) != 0 {
				t.Errorf("tmux written on a 400: %v", ops.agentPresetCalls)
			}
			if len(*dirs) != tc.fabRuns {
				t.Errorf("fab consulted %d times, want %d", len(*dirs), tc.fabRuns)
			}
		})
	}
}

func TestSessionAgentPreset_clearWorksOnOlderFab(t *testing.T) {
	stubAgentPresets(t, nil, fabsysconfig.ErrPresetsUnsupported)
	ops := &mockTmuxOps{}
	if rec := postAgentPreset(t, ops, "/api/sessions/proj/agent-preset", `{"agent_preset":null}`); rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if len(ops.agentPresetCalls) != 1 || !strings.HasPrefix(ops.agentPresetCalls[0], "unset-session proj ") {
		t.Errorf("calls = %v, want one unset", ops.agentPresetCalls)
	}
}

func TestServerAgentPreset_setClearAndReject(t *testing.T) {
	dirs := stubAgentPresets(t, testAgentPresets, nil)
	ops := &mockTmuxOps{}

	if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":"claude"}`); rec.Code != 200 {
		t.Fatalf("set: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":"none"}`); rec.Code != 200 {
		t.Fatalf("none: status %d", rec.Code)
	}
	if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":null}`); rec.Code != 200 {
		t.Fatalf("clear: status %d", rec.Code)
	}
	want := "set-server s1 claude|set-server s1 none|unset-server s1"
	if got := strings.Join(ops.agentPresetCalls, "|"); got != want {
		t.Errorf("calls = %q, want %q", got, want)
	}
	for _, d := range *dirs {
		if d != machinePresetDir() {
			t.Errorf("membership read in %q, want the machine dir", d)
		}
	}

	ops = &mockTmuxOps{}
	for _, body := range []string{
		`{"name":"s1","agent_preset":"nope"}`,
		`{"name":"s1","agent_preset":"a b"}`,
		`{"name":"bad/name","agent_preset":"claude"}`,
		`not json`,
	} {
		if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status %d, want 400", body, rec.Code)
		}
	}
	if len(ops.agentPresetCalls) != 0 {
		t.Errorf("tmux written on a 400: %v", ops.agentPresetCalls)
	}
}

func TestServerAgentPreset_unsupportedAndWriteFailure(t *testing.T) {
	stubAgentPresets(t, nil, fabsysconfig.ErrPresetsUnsupported)
	ops := &mockTmuxOps{}
	rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":"claude"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "not supported by the installed fab") {
		t.Fatalf("status %d body %s, want 400 unsupported", rec.Code, rec.Body.String())
	}
	if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":null}`); rec.Code != 200 {
		t.Fatalf("clear on older fab: status %d", rec.Code)
	}

	stubAgentPresets(t, testAgentPresets, nil)
	ops = &mockTmuxOps{agentPresetErr: context.DeadlineExceeded}
	if rec := postAgentPreset(t, ops, "/api/servers/agent-preset", `{"name":"s1","agent_preset":"claude"}`); rec.Code != http.StatusInternalServerError {
		t.Errorf("tmux failure: status %d, want 500", rec.Code)
	}
}
