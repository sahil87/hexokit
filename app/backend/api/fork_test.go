package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/riff"
	"rk/internal/sessions"
	"rk/internal/tmux"
)

// Fork endpoint coverage (260806-s4av) — POST /api/windows/{windowId}/fork.
// The endpoint reads NO body: every input (session, agent session ref,
// directory, window name) is derived server-side from one FetchSessions walk, so
// the tests drive it entirely through the mock SessionFetcher + the dedicated
// mock RiffEngine (api/riff_test.go), asserting on the recorded engine Options.

const testForkRef = "5d80479e-8f25-46cd-a0d4-e51435508a37"

// forkSessions builds a one-session/one-window fetch result whose window carries
// the given reconciled agent session identity on its ACTIVE pane (the source of
// truth sessions.ResolveAgentPane rolls up) and whose active pane cwd is `cwd`.
func forkSessions(sessionName, windowID, windowName, provider, ref, cwd string) []sessions.ProjectSession {
	return []sessions.ProjectSession{
		{Name: sessionName, Windows: []tmux.WindowInfo{
			{
				WindowID:        windowID,
				Name:            windowName,
				WorktreePath:    cwd,
				IsActiveWindow:  true,
				AgentProvider:   provider,
				AgentSessionRef: ref,
				Panes: []tmux.PaneInfo{
					{PaneID: "%1", IsActive: true, Cwd: cwd, AgentProvider: provider, AgentSessionRef: ref},
				},
			},
		}},
	}
}

// postFork issues the fork POST against a router wired with the given fetcher and
// engine. The path segment is percent-encoded like a real client's ('@' → %40).
func postFork(t *testing.T, sf SessionFetcher, engine RiffEngine, windowID string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouterWithRiff(sf, &mockTmuxOps{}, engine)
	req := httptest.NewRequest(http.MethodPost, "/api/windows/"+strings.Replace(windowID, "@", "%40", 1)+"/fork?server=work", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestForkSuccess: a claude-chat window in a git repo returns 200 with riff's
// result shape, and every engine input is DERIVED (checkout mode, the owning
// session, the pane's cwd, the resolved uuid, `<windowName>-fork`).
func TestForkSuccess(t *testing.T) {
	repo := gitRepoDir(t)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "feature-work", "claude", testForkRef, repo)}
	engine := &mockRiffEngine{result: riff.Result{
		Server:     "work",
		Session:    "dev",
		WindowName: "feature-work-fork",
		WindowID:   "@9",
	}}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !engine.called {
		t.Fatal("engine.Spawn was not called")
	}
	got := engine.gotOpts
	if got.Where != "checkout" {
		t.Errorf("engine Where = %q, want checkout (a fork is same-worktree)", got.Where)
	}
	if got.Server != "work" {
		t.Errorf("engine Server = %q, want work", got.Server)
	}
	if got.Session != "dev" {
		t.Errorf("engine Session = %q, want the source window's owning session dev", got.Session)
	}
	if got.RepoRoot != repo {
		t.Errorf("engine RepoRoot = %q, want the pane cwd %q", got.RepoRoot, repo)
	}
	if got.ForkProvider != "claude" {
		t.Errorf("fork provider = %q", got.ForkProvider)
	}
	if got.ResumeSessionRef != testForkRef {
		t.Errorf("engine ResumeSessionRef = %q, want the resolved uuid %q", got.ResumeSessionRef, testForkRef)
	}
	if got.WindowNameBase != "feature-work-fork" {
		t.Errorf("engine WindowNameBase = %q, want feature-work-fork", got.WindowNameBase)
	}
	// A fork never creates a worktree and never carries a tier (v1 = default tier).
	if got.WorktreeName != "" || got.Tier != "" || got.Task != "" || got.Preset != "" {
		t.Errorf("engine got unexpected spawn-shaping inputs: %+v", got)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if body["server"] != "work" || body["session"] != "dev" || body["window"] != "feature-work-fork" || body["windowId"] != "@9" {
		t.Errorf("response = %v, want the engine result's {server, session, window, windowId}", body)
	}
}

// TestForkRootsAtPaneCwdNotGitRoot: a pane cwd inside a repo SUBDIRECTORY reaches
// the engine verbatim. Claude keys its transcript store by the exact cwd, so
// rooting the fork at the walked-up git root would break `--resume` for every
// agent working below the repo root (verified empirically 2026-08-06). The
// git-root walk is only the not-a-repo gate — TestForkNonRepoCwd covers that half.
func TestForkRootsAtPaneCwdNotGitRoot(t *testing.T) {
	repo := gitRepoDir(t)
	deep := repo + "/app/backend"
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, deep)}
	engine := &mockRiffEngine{result: riff.Result{Server: "work", Session: "dev", WindowName: "w-fork", WindowID: "@9"}}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.RepoRoot != deep {
		t.Errorf("engine RepoRoot = %q, want the pane cwd %q verbatim (NOT the walked-up root %q)", engine.gotOpts.RepoRoot, deep, repo)
	}
}

// TestForkInvalidWindowID: a malformed {windowId} is a 400 before any resolve.
func TestForkInvalidWindowID(t *testing.T) {
	engine := &mockRiffEngine{}
	rec := postFork(t, &mockSessionFetcher{}, engine, "notawindow")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called for a malformed window id")
	}
}

// TestForkWindowNotFound: a well-formed id matching no live window is a 404
// (distinct from the FetchSessions-fault 500 below).
func TestForkWindowNotFound(t *testing.T) {
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, gitRepoDir(t))}
	engine := &mockRiffEngine{}

	rec := postFork(t, sf, engine, "@99")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called for an absent window")
	}
}

// TestForkNoAgentSession: a plain shell window (no reconciled
// @rk_pane_agent_session) is a 404 — there is no conversation to fork.
func TestForkNoAgentSession(t *testing.T) {
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "", "", gitRepoDir(t))}
	engine := &mockRiffEngine{}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no agent session") {
		t.Errorf("body = %q, want the no-agent-session message", rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called for a window with no agent session")
	}
}

// TestForkUnsupportedProvider: a well-formed but non-forkable provider is a 404
// with a message DISTINCT from the no-agent-session case (the window has an
// agent session, just not one --fork-session applies to).
func TestForkUnsupportedProvider(t *testing.T) {
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "gemini", testForkRef, gitRepoDir(t))}
	engine := &mockRiffEngine{}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "gemini") || strings.Contains(body, "no agent session") {
		t.Errorf("body = %q, want a provider-specific message distinct from the no-agent-session one", body)
	}
	if engine.called {
		t.Error("engine.Spawn was called for a non-claude provider")
	}
}

// TestForkMalformedRef: a reconciled ref failing the strict UUID shape is a
// 404-class result and NEVER reaches the engine — the gate that keeps
// shell-significant input out of the launcher string (Constitution I).
func TestForkMalformedRef(t *testing.T) {
	for _, ref := range []string{
		"",
		"not-a-uuid",
		"../../etc/passwd",
		"foo; rm -rf /",
		"5D80479E-8F25-46CD-A0D4-E51435508A37", // uppercase
		testForkRef + " --dangerously-skip-permissions", // trailing content
	} {
		t.Run(ref, func(t *testing.T) {
			sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", ref, gitRepoDir(t))}
			engine := &mockRiffEngine{}

			rec := postFork(t, sf, engine, "@7")

			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404 for ref %q; body=%s", rec.Code, ref, rec.Body.String())
			}
			if engine.called {
				t.Errorf("engine.Spawn was called with a non-uuid ref %q", ref)
			}
		})
	}
}

// TestForkNonRepoCwd: a window whose cwd is not inside a git repo is a 400 naming
// the offending directory, with nothing created.
func TestForkNonRepoCwd(t *testing.T) {
	nonRepo := t.TempDir()
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, nonRepo)}
	engine := &mockRiffEngine{}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), nonRepo) {
		t.Errorf("body = %q, want it to name the non-repo cwd %q", rec.Body.String(), nonRepo)
	}
	if engine.called {
		t.Error("engine.Spawn was called for a non-repo cwd")
	}
}

// TestForkSessionsFetchError: a FetchSessions fault is an infrastructure 500,
// NOT a "no agent session" 404 — the split that keeps a transient tmux fault
// from being misreported (mirrors the transcript-read routes).
func TestForkSessionsFetchError(t *testing.T) {
	sf := &mockSessionFetcher{err: errors.New("tmux: connection refused")}
	engine := &mockRiffEngine{}

	rec := postFork(t, sf, engine, "@7")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called after a FetchSessions fault")
	}
}

// TestForkEngineNotConfigured: an unwired RiffEngine is a server
// misconfiguration (500), not a client fault — the riff handler's nil-safe
// pattern. NewTestRouter (no engine) is the vehicle.
func TestForkEngineNotConfigured(t *testing.T) {
	repo := gitRepoDir(t)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, repo)}
	router := newTestRouter(sf, &mockTmuxOps{})
	req := httptest.NewRequest(http.MethodPost, "/api/windows/%407/fork?server=work", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Riff engine not configured") {
		t.Errorf("body = %q, want the unwired-engine message", rec.Body.String())
	}
}

// TestForkEngineErrorMapping: engine failures map exactly as riff's do —
// ExitValidation → 400, everything else → 500.
func TestForkEngineErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{name: "validation error → 400", err: riff.ValidationErr("bad input"), want: http.StatusBadRequest},
		{name: "subprocess error → 500", err: riff.SubprocessErr("tmux new-window failed"), want: http.StatusInternalServerError},
		{name: "plain error → 500", err: errors.New("boom"), want: http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := gitRepoDir(t)
			sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, repo)}
			engine := &mockRiffEngine{err: tc.err}

			rec := postFork(t, sf, engine, "@7")

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestForkCodexSuccess(t *testing.T) {
	repo := gitRepoDir(t)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "codex-work", "codex", testForkRef, repo)}
	engine := &mockRiffEngine{}
	rec := postFork(t, sf, engine, "@7")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if engine.gotOpts.ForkProvider != "codex" || engine.gotOpts.ResumeSessionRef != testForkRef || engine.gotOpts.RepoRoot != repo || engine.gotOpts.Where != "checkout" {
		t.Fatalf("unexpected fork options: %+v", engine.gotOpts)
	}
}

func TestForkUsesResolvedAgentPaneDirectory(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		for _, cwdKind := range []string{"repo", "outside repo", "missing"} {
			t.Run(provider+"/"+cwdKind, func(t *testing.T) {
				repo := gitRepoDir(t)
				agentCwd := repo + "/app/backend"
				wantStatus := http.StatusOK
				switch cwdKind {
				case "outside repo":
					agentCwd = t.TempDir()
					wantStatus = http.StatusBadRequest
				case "missing":
					agentCwd = ""
					wantStatus = http.StatusBadRequest
				}
				sess := forkSessions("dev", "@7", "work", provider, testForkRef, repo)
				sess[0].Windows[0].Panes = []tmux.PaneInfo{
					{PaneID: "%1", IsActive: true, Cwd: repo},
					{PaneID: "%2", Cwd: agentCwd, AgentProvider: provider, AgentSessionRef: testForkRef},
				}
				engine := &mockRiffEngine{}
				rec := postFork(t, &mockSessionFetcher{result: sess}, engine, "@7")
				if rec.Code != wantStatus {
					t.Fatalf("status = %d, want %d; body=%s", rec.Code, wantStatus, rec.Body.String())
				}
				if wantStatus != http.StatusOK {
					if engine.called {
						t.Fatal("spawn called without a valid agent directory")
					}
					return
				}
				if engine.gotOpts.RepoRoot != agentCwd || engine.gotOpts.ForkProvider != provider || engine.gotOpts.ResumeSessionRef != testForkRef {
					t.Fatalf("fork inputs must all come from the agent pane: %+v", engine.gotOpts)
				}
			})
		}
	}
}

// postForkWhere is postFork with an explicit `where` query value.
func postForkWhere(t *testing.T, sf SessionFetcher, engine RiffEngine, windowID, where string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouterWithRiff(sf, &mockTmuxOps{}, engine)
	req := httptest.NewRequest(http.MethodPost, "/api/windows/"+strings.Replace(windowID, "@", "%40", 1)+"/fork?server=work&where="+where, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// stubForkHead replaces forkHeadCommit for one test, recording the directory it
// was asked about.
func stubForkHead(t *testing.T, sha string, err error) *string {
	t.Helper()
	var gotDir string
	orig := forkHeadCommit
	forkHeadCommit = func(_ context.Context, dir string) (string, error) {
		gotDir = dir
		return sha, err
	}
	t.Cleanup(func() { forkHeadCommit = orig })
	return &gotDir
}

const testForkHead = "3c51d2991ad5f1b1e1e375ecf09b9a8ae175e946"

// TestForkWorktreeMode: where=worktree asks the engine for a NEW worktree whose
// branch starts at the source checkout's HEAD, run from the source's git root,
// and rooted at the pane's repo-relative subdirectory — while the conversation
// inputs (provider, ref, window name, session) stay those of a checkout fork.
// The engine's worktree path is echoed in the response.
func TestForkWorktreeMode(t *testing.T) {
	repo := gitRepoDir(t)
	deep := filepath.Join(repo, "app", "backend")
	gotDir := stubForkHead(t, testForkHead, nil)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "feature-work", "codex", testForkRef, deep)}
	engine := &mockRiffEngine{result: riff.Result{
		Server:       "work",
		Session:      "dev",
		WindowName:   "feature-work-fork",
		WindowID:     "@9",
		WorktreePath: "/tmp/repo.worktrees/smart-dugong",
	}}

	rec := postForkWhere(t, sf, engine, "@7", "worktree")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	got := engine.gotOpts
	if got.Where != "worktree" {
		t.Errorf("engine Where = %q, want worktree", got.Where)
	}
	if got.RepoRoot != repo {
		t.Errorf("engine RepoRoot = %q, want the git root %q (wt runs from the source checkout)", got.RepoRoot, repo)
	}
	if *gotDir != repo {
		t.Errorf("HEAD resolved in %q, want the source git root %q", *gotDir, repo)
	}
	if got.WorktreeBase != testForkHead {
		t.Errorf("engine WorktreeBase = %q, want the source HEAD %q", got.WorktreeBase, testForkHead)
	}
	if got.WorktreeSubdir != filepath.Join("app", "backend") {
		t.Errorf("engine WorktreeSubdir = %q, want app/backend", got.WorktreeSubdir)
	}
	if got.ForkProvider != "codex" || got.ResumeSessionRef != testForkRef || got.WindowNameBase != "feature-work-fork" || got.Session != "dev" {
		t.Errorf("conversation inputs drifted from a checkout fork: %+v", got)
	}
	if got.WorktreeName != "" {
		t.Errorf("engine WorktreeName = %q, want empty (wt generates the name + branch)", got.WorktreeName)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal body: %v", err)
	}
	if body["windowId"] != "@9" || body["worktreePath"] != "/tmp/repo.worktrees/smart-dugong" {
		t.Errorf("response = %v, want windowId @9 + the engine's worktreePath", body)
	}
}

// TestForkWorktreeAtRepoRoot: a pane at the git root carries no subdir ("."),
// which the engine treats as the worktree root.
func TestForkWorktreeAtRepoRoot(t *testing.T) {
	repo := gitRepoDir(t)
	stubForkHead(t, testForkHead, nil)
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, repo)}
	engine := &mockRiffEngine{result: riff.Result{WindowID: "@9"}}

	rec := postForkWhere(t, sf, engine, "@7", "worktree")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if s := engine.gotOpts.WorktreeSubdir; s != "." && s != "" {
		t.Errorf("engine WorktreeSubdir = %q, want the root (\".\")", s)
	}
}

// TestForkCheckoutOmitsWorktreeInputs: the default (and explicit where=checkout)
// fork never resolves HEAD and sends no worktree inputs — today's contract.
func TestForkCheckoutOmitsWorktreeInputs(t *testing.T) {
	for _, where := range []string{"", "checkout"} {
		t.Run("where="+where, func(t *testing.T) {
			repo := gitRepoDir(t)
			gotDir := stubForkHead(t, testForkHead, nil)
			sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, repo)}
			engine := &mockRiffEngine{result: riff.Result{WindowID: "@9"}}

			rec := postForkWhere(t, sf, engine, "@7", where)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			got := engine.gotOpts
			if got.Where != "checkout" || got.WorktreeBase != "" || got.WorktreeSubdir != "" {
				t.Errorf("checkout fork carried worktree inputs: %+v", got)
			}
			if *gotDir != "" {
				t.Errorf("checkout fork resolved HEAD in %q; it must not", *gotDir)
			}
			if strings.Contains(rec.Body.String(), "worktreePath") {
				t.Errorf("checkout response carries worktreePath: %s", rec.Body.String())
			}
		})
	}
}

// TestForkInvalidWhere: an unknown where is a 400 before anything resolves.
func TestForkInvalidWhere(t *testing.T) {
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, gitRepoDir(t))}
	engine := &mockRiffEngine{}

	rec := postForkWhere(t, sf, engine, "@7", "elsewhere")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called on an invalid where")
	}
}

// TestForkWorktreeHeadFailure: an unresolvable HEAD (e.g. a repo with no
// commits) is a 500 and creates nothing.
func TestForkWorktreeHeadFailure(t *testing.T) {
	stubForkHead(t, "", errors.New("no HEAD"))
	sf := &mockSessionFetcher{result: forkSessions("dev", "@7", "w", "claude", testForkRef, gitRepoDir(t))}
	engine := &mockRiffEngine{}

	rec := postForkWhere(t, sf, engine, "@7", "worktree")

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if engine.called {
		t.Error("engine.Spawn was called after the HEAD resolve failed")
	}
}

// TestForkHeadCommitRealRepo: the production resolver reads a real checkout's
// HEAD as a full SHA.
func TestForkHeadCommitRealRepo(t *testing.T) {
	dir := t.TempDir()
	for _, argv := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, argv...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", argv, err, out)
		}
	}
	want, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	got, err := forkHeadCommit(context.Background(), dir)
	if err != nil {
		t.Fatalf("forkHeadCommit: %v", err)
	}
	if got != strings.TrimSpace(string(want)) {
		t.Errorf("forkHeadCommit = %q, want %q", got, want)
	}
}
