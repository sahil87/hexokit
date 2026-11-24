package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/fabsysconfig"
	"rk/internal/riff"
	"rk/internal/settings"
	"rk/internal/tmux"
)

// mockRiffEngine records the Options it was called with and returns a canned
// Result/err. This is the DEDICATED riff mock — the shared mockTmuxOps is not
// touched (the RiffEngine seam is a separate Server dependency).
type mockRiffEngine struct {
	called  bool
	gotOpts riff.Options
	result  riff.Result
	err     error
}

func (m *mockRiffEngine) Spawn(ctx context.Context, opts riff.Options) (riff.Result, error) {
	m.called = true
	m.gotOpts = opts
	if m.err != nil {
		return riff.Result{}, m.err
	}
	return m.result, nil
}

func newTestRouterWithRiff(sf SessionFetcher, ops TmuxOps, engine RiffEngine) http.Handler {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	return NewTestRouterWithRiff(logger, sf, ops, engine, "test-host")
}

// gitRepoDir creates a temp dir containing a .git marker so config.FindGitRoot
// resolves it as a repo root. Returns the dir.
func gitRepoDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	return dir
}

// windowsWithActivePaneCwd builds a one-window, one-active-pane ListWindows
// result whose active pane cwd is `cwd` — the repo-root derivation input.
func windowsWithActivePaneCwd(cwd string) []tmux.WindowInfo {
	return []tmux.WindowInfo{
		{
			Index:          0,
			WindowID:       "@0",
			Name:           "main",
			WorktreePath:   cwd,
			IsActiveWindow: true,
			Panes: []tmux.PaneInfo{
				{PaneID: "%0", PaneIndex: 0, Cwd: cwd, IsActive: true},
			},
		},
	}
}

func postRiff(t *testing.T, ops *mockTmuxOps, engine RiffEngine, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouterWithRiff(&mockSessionFetcher{}, ops, engine)
	req := httptest.NewRequest(http.MethodPost, "/api/riff?server=work", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestRiffSpawnSuccess: a valid POST with a repo-backed session returns 200 with
// {server, session, window, windowId} and feeds the engine the derived repo root.
func TestRiffSpawnSuccess(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{
		Server:     "work",
		Session:    "mysess",
		WindowName: "riff-swift-fox",
		WindowID:   "@7",
	}}

	rec := postRiff(t, ops, engine, `{"task":"fix the bug","session":"mysess"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !engine.called {
		t.Fatal("engine.Spawn was not called")
	}
	if engine.gotOpts.RepoRoot != repo {
		t.Errorf("engine RepoRoot = %q, want derived %q", engine.gotOpts.RepoRoot, repo)
	}
	if engine.gotOpts.Server != "work" {
		t.Errorf("engine Server = %q, want work", engine.gotOpts.Server)
	}
	if engine.gotOpts.Session != "mysess" {
		t.Errorf("engine Session = %q, want mysess", engine.gotOpts.Session)
	}
	// Task text reaches the engine verbatim (the shell-escape happens inside the
	// engine's buildSkillShellString, unit-tested in internal/riff).
	if engine.gotOpts.Task != "fix the bug" {
		t.Errorf("engine Task = %q, want 'fix the bug'", engine.gotOpts.Task)
	}

	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if got["server"] != "work" || got["session"] != "mysess" || got["window"] != "riff-swift-fox" || got["windowId"] != "@7" {
		t.Errorf("response = %v, want {server:work, session:mysess, window:riff-swift-fox, windowId:@7}", got)
	}
}

// TestRiffSpawnDefaultsWhereWorktree: omitting `where` defaults it to "worktree"
// at the handler, so the engine always sees an explicit mode (mockup-v2 R5).
func TestRiffSpawnDefaultsWhereWorktree(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@1"}}
	rec := postRiff(t, ops, engine, `{"session":"s"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.Where != "worktree" {
		t.Errorf("engine Where = %q, want defaulted \"worktree\"", engine.gotOpts.Where)
	}
}

// TestRiffSpawnCheckoutTierForwarded: where=checkout + tier reach the engine
// verbatim (mockup-v2 R5); worktreeName is omitted for checkout.
func TestRiffSpawnCheckoutTierForwarded(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-repo", WindowID: "@3"}}
	rec := postRiff(t, ops, engine, `{"session":"s","where":"checkout","tier":"doing"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.Where != "checkout" {
		t.Errorf("engine Where = %q, want checkout", engine.gotOpts.Where)
	}
	if engine.gotOpts.Tier != "doing" {
		t.Errorf("engine Tier = %q, want doing", engine.gotOpts.Tier)
	}
	if engine.gotOpts.WorktreeName != "" {
		t.Errorf("engine WorktreeName = %q, want empty for checkout", engine.gotOpts.WorktreeName)
	}
}

// TestRiffSpawnWorktreeNameForwarded: a worktree-mode name reaches the engine.
func TestRiffSpawnWorktreeNameForwarded(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-my-agent", WindowID: "@4"}}
	rec := postRiff(t, ops, engine, `{"session":"s","where":"worktree","worktreeName":"my-agent"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.WorktreeName != "my-agent" {
		t.Errorf("engine WorktreeName = %q, want my-agent", engine.gotOpts.WorktreeName)
	}
}

// TestRiffSpawnTierNonFabPermissive: the tier gate is a PRESETS-only, display
// concern (gsmu R3) — POST /api/riff stays permissive. A well-formed tier
// against a NON-FAB repo (no fab/project/config.yaml) is still accepted (no new
// 400) and reaches the engine, which resolves it via the documented silent
// DefaultLauncher fallback. The dialog never sends a tier when the field is
// hidden, but the endpoint must not depend on that.
func TestRiffSpawnTierNonFabPermissive(t *testing.T) {
	repo := gitRepoDir(t) // git repo, no fab config → not a fab project
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@2"}}
	rec := postRiff(t, ops, engine, `{"session":"s","tier":"doing"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (permissive tier on a non-fab repo); body=%s", rec.Code, rec.Body.String())
	}
	if !engine.called {
		t.Fatal("engine.Spawn should be called — the tier is accepted, not gated, on POST")
	}
	if engine.gotOpts.Tier != "doing" {
		t.Errorf("engine Tier = %q, want doing (forwarded verbatim)", engine.gotOpts.Tier)
	}
}

// TestRiffSpawnNewFieldValidation: the three mockup-v2 fields are validated
// BEFORE any subprocess/repo derivation — each bad input is a 400 with no engine
// call (nothing created). A gitRepoDir cwd is supplied so a passing field-check
// would proceed; the 400 must come from the field validation, not the repo check.
func TestRiffSpawnNewFieldValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "unknown where", body: `{"session":"s","where":"sideways"}`},
		{name: "worktreeName with checkout", body: `{"session":"s","where":"checkout","worktreeName":"x"}`},
		{name: "forbidden worktreeName char", body: `{"session":"s","worktreeName":"bad;name"}`},
		{name: "worktreeName with colon", body: `{"session":"s","worktreeName":"a:b"}`},
		{name: "worktreeName leading hyphen", body: `{"session":"s","worktreeName":"-agent"}`},
		{name: "worktreeName with slash", body: `{"session":"s","worktreeName":"a/b"}`},
		{name: "worktreeName with space", body: `{"session":"s","worktreeName":"a b"}`},
		{name: "forbidden tier char", body: `{"session":"s","tier":"a b"}`},
		{name: "tier leading hyphen", body: `{"session":"s","tier":"-doing"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := gitRepoDir(t)
			ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
			engine := &mockRiffEngine{}
			rec := postRiff(t, ops, engine, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if engine.called {
				t.Error("engine.Spawn should NOT be called on an invalid new-field value")
			}
		})
	}
}

// TestRiffSpawnTaskWithSingleQuote: a task containing a single quote reaches the
// engine verbatim (the escaping is the engine's concern; the handler must not
// mangle it).
func TestRiffSpawnTaskWithSingleQuote(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@1"}}

	rec := postRiff(t, ops, engine, `{"task":"it's a test","session":"s"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.Task != "it's a test" {
		t.Errorf("engine Task = %q, want \"it's a test\"", engine.gotOpts.Task)
	}
}

// TestRiffSpawnEmptySession: an empty/invalid session is a 400 before any engine
// call.
func TestRiffSpawnEmptySession(t *testing.T) {
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(gitRepoDir(t))}
	engine := &mockRiffEngine{}
	rec := postRiff(t, ops, engine, `{"task":"x","session":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if engine.called {
		t.Error("engine.Spawn should NOT be called on invalid session")
	}
}

// TestRiffSpawnNonRepoCwd: a session whose active-pane cwd is not inside a git
// repo is a 400 whose message NAMES the offending cwd (R5), and the engine is
// never called (nothing created).
func TestRiffSpawnNonRepoCwd(t *testing.T) {
	nonRepo := t.TempDir() // no .git
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(nonRepo)}
	engine := &mockRiffEngine{}
	rec := postRiff(t, ops, engine, `{"session":"mysess"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), nonRepo) {
		t.Errorf("400 body should name the non-repo cwd %q; got %s", nonRepo, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn should NOT be called when cwd is not a git repo")
	}
}

// TestRiffSpawnEmptyPaneCwdFallsBackToWorktreePath: a window whose panes report
// an empty #{pane_current_path} must fall through to the window's WorktreePath
// rather than clobber it with "" (which would produce a spurious "no active
// pane" 400 even though a repo-backed WorktreePath was present). Regression
// guard for the deriveRepoRoot pane-cwd override bug.
func TestRiffSpawnEmptyPaneCwdFallsBackToWorktreePath(t *testing.T) {
	repo := gitRepoDir(t)
	windows := []tmux.WindowInfo{
		{
			Index:          0,
			WindowID:       "@0",
			Name:           "main",
			WorktreePath:   repo,
			IsActiveWindow: true,
			// Active pane exists but its cwd came back blank — the fallback to
			// WorktreePath must still resolve the repo root.
			Panes: []tmux.PaneInfo{
				{PaneID: "%0", PaneIndex: 0, Cwd: "", IsActive: true},
			},
		},
	}
	ops := &mockTmuxOps{listWindowsResult: windows}
	engine := &mockRiffEngine{result: riff.Result{
		Server: "work", Session: "mysess", WindowName: "riff-x", WindowID: "@1",
	}}
	rec := postRiff(t, ops, engine, `{"session":"mysess"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !engine.called {
		t.Fatal("engine.Spawn was not called — WorktreePath fallback did not resolve the repo root")
	}
	if engine.gotOpts.RepoRoot != repo {
		t.Errorf("engine RepoRoot = %q, want WorktreePath fallback %q", engine.gotOpts.RepoRoot, repo)
	}
}

// TestRiffSpawnSessionReadError: a tmux read failure for the target session
// (nonexistent/gone session) is a 400 naming the session, not a raw 500, and the
// engine is never called.
func TestRiffSpawnSessionReadError(t *testing.T) {
	ops := &mockTmuxOps{listWindowsErr: errors.New("no such session: ghost")}
	engine := &mockRiffEngine{}
	rec := postRiff(t, ops, engine, `{"session":"ghost"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ghost") {
		t.Errorf("400 body should name the session %q; got %s", "ghost", rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn should NOT be called when the session read fails")
	}
}

// TestRiffSpawnUnknownPreset: the engine returns a validation-class ExitCodeError
// for an unknown riff preset; the handler maps it to 400.
func TestRiffSpawnUnknownPreset(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{err: riff.ValidationErr("run-kit riff: unknown riff preset %q (defined: %s)", "nope", "blank, discuss, incognito")}
	rec := postRiff(t, ops, engine, `{"riff_preset":"nope","session":"mysess"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestRiffSpawnRiffPresetBodyField: the body field `riff_preset` reaches the
// engine as Options.RiffPreset; the legacy `preset` field is read when
// `riff_preset` is absent and accepted alongside it when the two agree.
func TestRiffSpawnRiffPresetBodyField(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"riff_preset", `{"session":"mysess","riff_preset":"discuss"}`, "discuss"},
		{"legacy preset only", `{"session":"mysess","preset":"discuss"}`, "discuss"},
		{"both equal", `{"session":"mysess","preset":"discuss","riff_preset":"discuss"}`, "discuss"},
		{"neither", `{"session":"mysess"}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := gitRepoDir(t)
			ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
			engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "mysess", WindowName: "riff-x", WindowID: "@7"}}
			rec := postRiff(t, ops, engine, tc.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			if engine.gotOpts.RiffPreset != tc.want {
				t.Errorf("engine RiffPreset = %q, want %q", engine.gotOpts.RiffPreset, tc.want)
			}
		})
	}
}

// TestRiffSpawnPresetDisagreement: a legacy `preset` that differs from
// `riff_preset` is a 400 before the repo root is derived or the engine runs.
func TestRiffSpawnPresetDisagreement(t *testing.T) {
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(gitRepoDir(t))}
	engine := &mockRiffEngine{}
	rec := postRiff(t, ops, engine, `{"session":"mysess","preset":"a","riff_preset":"b"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "riff_preset and preset disagree") {
		t.Errorf("body = %s, want the disagreement message", rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn ran despite the disagreement")
	}
}

// TestRiffSpawnSubprocessError: a subprocess-class engine failure maps to 500.
func TestRiffSpawnSubprocessError(t *testing.T) {
	repo := gitRepoDir(t)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	engine := &mockRiffEngine{err: riff.SubprocessErr("run-kit riff: wt create failed")}
	rec := postRiff(t, ops, engine, `{"session":"mysess"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// --- GET /api/riff/presets ---

func getRiffPresets(t *testing.T, ops *mockTmuxOps, session string) *httptest.ResponseRecorder {
	t.Helper()
	// Isolate the config root so the default preset source (the settings-backed
	// merged view) deterministically returns the built-ins; tests wanting a
	// custom table override the seam via stubLoadRiffPresets.
	t.Setenv(settings.ConfigDirEnv, t.TempDir())
	router := newTestRouterWithRiff(&mockSessionFetcher{}, ops, &mockRiffEngine{})
	req := httptest.NewRequest(http.MethodGet, "/api/riff/presets?server=work&session="+session, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// stubLoadRiffPresets points the presets endpoint's source seam at a fixed
// table for the test's duration.
func stubLoadRiffPresets(t *testing.T, presets []settings.RiffPreset) {
	t.Helper()
	orig := loadRiffPresets
	loadRiffPresets = func() []settings.RiffPreset { return presets }
	t.Cleanup(func() { loadRiffPresets = orig })
}

// TestRiffPresetsSuccess: the endpoint returns the merged presets — the three
// built-ins in canonical order, then user additions — each {name, layout: "",
// paneCount: 1} (every preset is exactly one skill pane).
func TestRiffPresetsSuccess(t *testing.T) {
	repo := gitRepoDir(t)
	stubLoadRiffPresets(t, append(append([]settings.RiffPreset{}, settings.BuiltinRiffPresets...),
		settings.RiffPreset{Name: "review", Skill: "/code-review high"}))
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}

	rec := getRiffPresets(t, ops, "mysess")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("unmarshal keys: %v", err)
	}
	if _, ok := keys["riff_presets"]; !ok {
		t.Errorf("response keys = %v, want riff_presets", keys)
	}
	if _, ok := keys["presets"]; ok {
		t.Errorf("response carries a legacy presets key: %s", rec.Body.String())
	}
	var got struct {
		Presets []riffPresetSummary `json:"riff_presets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	wantNames := []string{"discuss", "incognito", "blank", "review"}
	if len(got.Presets) != len(wantNames) {
		t.Fatalf("presets = %v, want %d", got.Presets, len(wantNames))
	}
	for i, want := range wantNames {
		if got.Presets[i].Name != want {
			t.Errorf("presets[%d].Name = %q, want %q (canonical order, additions last)", i, got.Presets[i].Name, want)
		}
		if got.Presets[i].Layout != "" || got.Presets[i].PaneCount != 1 {
			t.Errorf("presets[%d] = %+v, want layout \"\" and paneCount 1", i, got.Presets[i])
		}
	}
}

// TestRiffPresetsTiers: for a FAB PROJECT (config.yaml present) the presets
// response carries a non-empty tiers array (mockup-v2 R8) with the fab-kit
// built-ins first (`default` first), plus any config-defined names appended.
// The fab gate (gsmu R2) is satisfied because writeFabConfig creates the config
// — the non-fab tiers:[] case is TestRiffPresetsNonFabRepoTiersEmpty.
func TestRiffPresetsTiers(t *testing.T) {
	repo := gitRepoDir(t)
	writeFabConfig(t, repo, `agent:
    tiers:
        default: {model: a}
        custom: {model: b}
`)
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	rec := getRiffPresets(t, ops, "mysess")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Presets []riffPresetSummary `json:"riff_presets"`
		Tiers   []string            `json:"tiers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Tiers) == 0 || got.Tiers[0] != "default" {
		t.Fatalf("tiers = %v, want built-ins first (default first)", got.Tiers)
	}
	// Built-ins present and the config-only "custom" appended.
	joined := strings.Join(got.Tiers, ",")
	for _, want := range []string{"default", "doing", "fast", "operator", "review", "custom"} {
		if !strings.Contains(joined, want) {
			t.Errorf("tiers %v missing %q", got.Tiers, want)
		}
	}
}

// TestRiffPresetsBuiltinsOnly: with no user config the endpoint returns the
// three built-ins in canonical order — the list is never empty. A gitRepoDir
// with no fab config is ALSO a non-fab project, so tiers is [] too (the tier
// gate — see TestRiffPresetsNonFabRepoTiersEmpty for the dedicated gate
// assertion).
func TestRiffPresetsBuiltinsOnly(t *testing.T) {
	repo := gitRepoDir(t) // no fab config → non-fab project
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	rec := getRiffPresets(t, ops, "mysess")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Presets []riffPresetSummary `json:"riff_presets"`
		Tiers   []string            `json:"tiers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	wantNames := []string{"discuss", "incognito", "blank"}
	if len(got.Presets) != len(wantNames) {
		t.Fatalf("presets = %v, want the 3 built-ins", got.Presets)
	}
	for i, want := range wantNames {
		if got.Presets[i].Name != want {
			t.Errorf("presets[%d].Name = %q, want %q", i, got.Presets[i].Name, want)
		}
	}
	if got.Tiers == nil {
		t.Error("tiers should be [] (non-nil), not null, on a non-fab repo")
	}
	if len(got.Tiers) != 0 {
		t.Errorf("tiers = %v, want [] on a non-fab repo", got.Tiers)
	}
}

// TestRiffPresetsNonFabRepoTiersEmpty: the tier gate (gsmu R2) — a git repo that
// is NOT a fab project (no fab/project/config.yaml) returns tiers: [] (present,
// empty), even though ReadTiers alone would return the built-ins. This is the
// behavior CHANGE: pre-gate, every repo returned the built-ins; now a non-fab
// repo returns []. The presets endpoint's other behavior is unchanged.
func TestRiffPresetsNonFabRepoTiersEmpty(t *testing.T) {
	repo := gitRepoDir(t) // git repo, but no fab config → not a fab project
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
	rec := getRiffPresets(t, ops, "mysess")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	// The tiers key MUST be present (Constitution IX additive shape) and empty.
	if !strings.Contains(rec.Body.String(), `"tiers":[]`) {
		t.Errorf("body should carry tiers:[] for a non-fab repo; got %s", rec.Body.String())
	}
}

// TestRiffPresetsNonRepoCwd: a non-repo cwd is a 400 whose message names the cwd.
func TestRiffPresetsNonRepoCwd(t *testing.T) {
	nonRepo := t.TempDir()
	ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(nonRepo)}
	rec := getRiffPresets(t, ops, "mysess")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), nonRepo) {
		t.Errorf("400 body should name the non-repo cwd %q; got %s", nonRepo, rec.Body.String())
	}
}

// writeFabConfig writes a fab/project/config.yaml at repo with the given body.
func writeFabConfig(t *testing.T, repo, body string) {
	t.Helper()
	dir := filepath.Join(repo, "fab", "project")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir fab/project: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
}

// agent_preset on POST /api/riff: an explicit pick is charset-checked, then
// checked against fab's list in the session's repo (or "none") BEFORE the
// engine runs, and a valid one reaches riff.Options.AgentPreset.
func TestRiffSpawnAgentPreset(t *testing.T) {
	t.Run("valid pick reaches the engine, membership read in the repo root", func(t *testing.T) {
		repo := gitRepoDir(t)
		dirs := stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
		engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@1"}}
		rec := postRiff(t, ops, engine, `{"session":"s","agent_preset":"codex-review"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		if engine.gotOpts.AgentPreset != "codex-review" {
			t.Errorf("Options.AgentPreset = %q, want codex-review", engine.gotOpts.AgentPreset)
		}
		if len(*dirs) != 1 || (*dirs)[0] != repo {
			t.Errorf("membership read in %v, want the repo root %q", *dirs, repo)
		}
	})

	t.Run("none is accepted", func(t *testing.T) {
		repo := gitRepoDir(t)
		stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
		engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@1"}}
		if rec := postRiff(t, ops, engine, `{"session":"s","agent_preset":"none"}`); rec.Code != http.StatusOK || engine.gotOpts.AgentPreset != "none" {
			t.Fatalf("status %d preset %q, want 200 and none", rec.Code, engine.gotOpts.AgentPreset)
		}
	})

	t.Run("absent pick sends nothing and never consults fab", func(t *testing.T) {
		repo := gitRepoDir(t)
		dirs := stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
		engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "s", WindowName: "riff-x", WindowID: "@1"}}
		if rec := postRiff(t, ops, engine, `{"session":"s"}`); rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if engine.gotOpts.AgentPreset != "" || len(*dirs) != 0 {
			t.Errorf("preset %q, fab reads %v; want none", engine.gotOpts.AgentPreset, *dirs)
		}
	})

	rejects := []struct {
		name    string
		presets []fabsysconfig.AgentPreset
		err     error
		body    string
		wantMsg string
		fabRuns int
	}{
		{"bad charset (no fab read)", testAgentPresets, nil, `{"session":"s","agent_preset":"a;b"}`, "alphanumeric", 0},
		{"leading hyphen (no fab read)", testAgentPresets, nil, `{"session":"s","agent_preset":"--x"}`, "must not start with a hyphen", 0},
		{"unknown", testAgentPresets, nil, `{"session":"s","agent_preset":"bogus"}`, "unknown agent preset", 1},
		{"older fab", nil, fabsysconfig.ErrPresetsUnsupported, `{"session":"s","agent_preset":"claude"}`, "not supported by the installed fab", 1},
	}
	for _, tc := range rejects {
		t.Run("400 "+tc.name+": nothing created", func(t *testing.T) {
			repo := gitRepoDir(t)
			dirs := stubAgentPresets(t, tc.presets, tc.err)
			ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
			engine := &mockRiffEngine{}
			rec := postRiff(t, ops, engine, tc.body)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), tc.wantMsg) {
				t.Fatalf("status %d body %s, want 400 containing %q", rec.Code, rec.Body.String(), tc.wantMsg)
			}
			if engine.called {
				t.Error("the engine ran on a 400 — a worktree/window would have been created")
			}
			if len(*dirs) != tc.fabRuns {
				t.Errorf("fab consulted %d times, want %d", len(*dirs), tc.fabRuns)
			}
		})
	}
}

// GET /api/riff/presets carries the dialog's agent-preset data: the repo-scoped
// list (omitted when fab cannot list presets) and the pick the ladder would make
// with no explicit pick.
func TestRiffPresetsAgentPresetFields(t *testing.T) {
	decode := func(t *testing.T, rec *httptest.ResponseRecorder) map[string]json.RawMessage {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
		}
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
			t.Fatal(err)
		}
		return keys
	}

	t.Run("workspace default and the repo-scoped list", func(t *testing.T) {
		repo := gitRepoDir(t)
		dirs := stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{
			listWindowsResult:  windowsWithActivePaneCwd(repo),
			agentPresetOptions: map[string]string{"server:work": "claude"},
		}
		keys := decode(t, getRiffPresets(t, ops, "proj"))
		if got := string(keys["agent_preset_inherited"]); got != `{"from":"workspace","name":"claude"}` {
			t.Errorf("agent_preset_inherited = %s", got)
		}
		var presets []fabsysconfig.AgentPreset
		if err := json.Unmarshal(keys["agent_presets"], &presets); err != nil || len(presets) != 2 || presets[0].Name != "claude" {
			t.Errorf("agent_presets = %s (%v)", keys["agent_presets"], err)
		}
		if len(*dirs) != 1 || (*dirs)[0] != repo {
			t.Errorf("list read in %v, want the repo root %q", *dirs, repo)
		}
	})

	t.Run("group beats workspace", func(t *testing.T) {
		repo := gitRepoDir(t)
		stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{
			listWindowsResult:  windowsWithActivePaneCwd(repo),
			agentPresetOptions: map[string]string{"server:work": "claude", "session:work/proj": "codex-review"},
		}
		keys := decode(t, getRiffPresets(t, ops, "proj"))
		if got := string(keys["agent_preset_inherited"]); got != `{"from":"group","name":"codex-review"}` {
			t.Errorf("agent_preset_inherited = %s", got)
		}
	})

	t.Run("nothing set and an older fab: both keys omitted", func(t *testing.T) {
		repo := gitRepoDir(t)
		stubAgentPresets(t, nil, fabsysconfig.ErrPresetsUnsupported)
		ops := &mockTmuxOps{listWindowsResult: windowsWithActivePaneCwd(repo)}
		keys := decode(t, getRiffPresets(t, ops, "proj"))
		for _, k := range []string{"agent_presets", "agent_preset_inherited"} {
			if _, ok := keys[k]; ok {
				t.Errorf("key %s present, want it omitted: %s", k, keys[k])
			}
		}
	})

	t.Run("garbage option is not offered as inherited", func(t *testing.T) {
		repo := gitRepoDir(t)
		stubAgentPresets(t, testAgentPresets, nil)
		ops := &mockTmuxOps{
			listWindowsResult:  windowsWithActivePaneCwd(repo),
			agentPresetOptions: map[string]string{"session:work/proj": "a;b"},
		}
		keys := decode(t, getRiffPresets(t, ops, "proj"))
		if _, ok := keys["agent_preset_inherited"]; ok {
			t.Errorf("garbage option surfaced as inherited: %s", keys["agent_preset_inherited"])
		}
	})
}
