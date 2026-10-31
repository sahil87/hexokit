package api

import (
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"rk/internal/config"
	"rk/internal/riff"
	"rk/internal/sessions"
)

// fork.go — the conversation-FORK surface (260806-s4av). One endpoint:
//
//	POST /api/windows/{windowId}/fork?server=<name>[&where=worktree]
//
// It branches a live agent's conversation into a NEW tmux window, by spawning a
// riff window whose launcher uses the source provider's fork command. The
// original conversation is untouched. Two isolation modes, riff's vocabulary:
//
//   - where=checkout (the default): the fork opens in the SAME directory.
//   - where=worktree: the fork opens in a NEW worktree on a NEW branch started
//     at the source checkout's HEAD commit, at the same repo-relative
//     subdirectory. Conversation lookup is by session id, not cwd, for both
//     providers (claude --resume <uuid> resolves across directories; codex fork
//     <id> is id-keyed), so the forked agent continues from the new checkout.
//     Uncommitted changes in the source checkout are not carried over.
//
// The endpoint is WINDOW-KEYED and derives everything else server-side — the
// client supplies only {windowId} + server, and no request body is read
// (Constitution X: derivation wins; never trust a client-supplied session ref).
// Compare the send endpoint (api/send.go), whose contract this mirrors.
//
// TIMEOUT: the engine spawn shares handleRiffSpawn's documented 5s-review-rule
// exception (api/riff.go file header) — it is the same synchronous engine call
// (checkout mode skips `wt create`; worktree mode runs it, as riff does),
// bounded by the same riffSpawnTimeout.

// forkSessionUUIDRe matches the strict Claude session-UUID shape — the SAME rule
// as internal/transcript's uuidRe. The resolved @rk_pane_agent_session ref MUST
// pass it BEFORE it
// reaches the engine, because downstream it becomes part of the launcher string,
// the one deliberately-unescaped element of the spawn shell string (Constitution
// I). internal/riff re-checks the shape at that composition seam; this is the
// primary gate.
var forkSessionUUIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// forkProviderClaude is also used by the Claude-only closed-window resume route.
const forkProviderClaude = "claude"

// forkResolveTimeout bounds the FetchSessions read that resolves the fork source.
// Dedicated (not r.Context()) because the resolved values feed the subsequent
// engine spawn — a client disconnect must not truncate the resolve mid-way and
// leave a half-derived spawn. Mirrors riffRepoRootTimeout.
const forkResolveTimeout = 5 * time.Second

// forkSource is everything the fork needs about its source window, all derived
// server-side from one FetchSessions walk.
type forkSource struct {
	// Session is the tmux session owning the window — the session the forked
	// window is created in.
	Session string
	// WindowName is the source window's name, the base for `<name>-fork`.
	WindowName string
	// Provider / Ref are the window's reconciled @rk_pane_agent_session halves
	// (sessions.ResolveAgentPane's active-pane-first rollup).
	Provider string
	Ref      string
	// Cwd is the resolved agent pane's working directory — the directory
	// the fork window is rooted at VERBATIM. It is only gate-checked against
	// FindGitRoot, never replaced by the walked-up root: claude's transcript store
	// is keyed by the exact cwd, so a subdirectory must stay a subdirectory.
	Cwd string
}

// resolveForkSource resolves a window's fork inputs from a single FetchSessions
// walk: the owning session name, the window name, the reconciled agent-session
// identity, and the window's cwd.
//
// A non-nil error means FetchSessions itself failed (an infrastructure fault the
// caller maps to 500, mirroring handleSessionsList). ok=false
// with a nil error means the fetch succeeded but no window carries that id (a
// genuine 404). The two are distinct so a transient tmux fault is never
// misreported as "no such window".
//
// This deliberately does NOT compose an agent-session-rollup resolver +
// deriveRepoRoot:
// the fork is window-keyed and needs the ENCLOSING SESSION NAME plus the cwd of
// the REQUESTED window (deriveRepoRoot, being session-keyed, would take it from
// the session's ACTIVE window instead — the wrong pane when forking a
// background window). One walk yields all four.
func (s *Server) resolveForkSource(ctx context.Context, server, windowID string) (forkSource, bool, error) {
	sess, err := s.sessions.FetchSessions(ctx, server)
	if err != nil {
		return forkSource{}, false, err
	}
	for si := range sess {
		for wi := range sess[si].Windows {
			w := &sess[si].Windows[wi]
			if w.WindowID != windowID {
				continue
			}
			provider, ref, paneID := sessions.ResolveAgentPane(w.Panes)
			// Keep the conversation and directory tied to the same pane. The
			// active pane can be a shell in a different checkout. A missing
			// agent cwd must fail the directory gate rather than borrow that cwd.
			var cwd string
			for _, pane := range w.Panes {
				if paneID != "" && pane.PaneID == paneID {
					cwd = pane.Cwd
					break
				}
			}
			return forkSource{
				Session:    sess[si].Name,
				WindowName: w.Name,
				Provider:   provider,
				Ref:        ref,
				Cwd:        cwd,
			}, true, nil
		}
	}
	return forkSource{}, false, nil
}

// handleWindowFork forks the window's agent conversation into a new window in the
// same session — in the same directory (where=checkout, default) or in a new
// worktree + branch (where=worktree).
//
//	POST /api/windows/{windowId}/fork?server=<name>[&where=checkout|worktree]
//	(no request body — every input is derived server-side)
//	200: {"server","session","window","windowId"} (riff's result shape), plus
//	     "worktreePath" for where=worktree
//	400: malformed windowId; unknown where; the window's cwd is not inside a
//	     git repo; engine validation fails
//	500: … also: the source checkout's HEAD cannot be resolved (worktree mode)
//	404: no such window; no reconciled agent session; an unsupported provider; a
//	     non-UUID reconciled ref (all properties of the pane's
//	     @rk_pane_agent_session, not server faults — internal/transcript's
//	     ErrInvalidRef posture)
//	500: FetchSessions fault; unwired engine; engine subprocess failure
//
// Mutation ⇒ POST (Constitution IX). Nothing is created on any 4xx path — every
// gate short-circuits before the engine call, and the engine's own launcher gate
// fires before its first subprocess (riff's 400-before-subprocess discipline).
func (s *Server) handleWindowFork(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}
	server := serverFromRequest(r)
	where := r.URL.Query().Get("where")
	if where == "" {
		where = forkWhereCheckout
	}
	if where != forkWhereCheckout && where != forkWhereWorktree {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid where %q — must be %q or %q", where, forkWhereCheckout, forkWhereWorktree))
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), forkResolveTimeout)
	src, found, err := s.resolveForkSource(ctx, server, windowID)
	cancel()
	if err != nil {
		// FetchSessions itself failed — an infrastructure fault, not a missing
		// window. Mirror handleSessionsList rather than reporting "no such window".
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such window")
		return
	}
	if src.Provider == "" {
		writeError(w, http.StatusNotFound, "no agent session for this window — nothing to fork")
		return
	}
	if src.Provider != forkProviderClaude && src.Provider != "codex" {
		// A well-formed but non-forkable provider: the window HAS an agent
		// session, so this is deliberately a distinct message from the
		// no-agent-session 404 above.
		writeError(w, http.StatusNotFound, fmt.Sprintf("cannot fork a %q session — conversation fork requires claude or codex", src.Provider))
		return
	}
	// Strict UUID gate BEFORE the ref can reach any argv/shell composition
	// (Constitution I). A malformed ref is a property of the pane's reconciled
	// @rk_pane_agent_session, not a server fault — 404-class, matching
	// transcript's ErrInvalidRef.
	if !forkSessionUUIDRe.MatchString(src.Ref) {
		writeError(w, http.StatusNotFound, "malformed agent session ref for this window")
		return
	}

	// The git-root walk is a GATE, not a relocation: claude keys its transcript
	// store by the EXACT cwd, and its resume lookup covers the project directory
	// and its git worktrees but NOT parent directories. So the fork must open in
	// the source pane's OWN directory — rooting it at the walked-up repo root
	// breaks `--resume` for every agent working in a repo subdirectory (verified
	// empirically 2026-08-06: a session started in <repo>/app/backend resumes from
	// <repo>/app/backend and errors from <repo>). FindGitRoot only answers "is
	// this inside a repo at all", the same question riff's non-repo 400 asks.
	gitRoot := config.FindGitRoot(src.Cwd)
	if gitRoot == "" {
		writeError(w, http.StatusBadRequest, forkNonRepoMsg(src.Cwd))
		return
	}

	// Guard the optional engine (NewTestRouter leaves it nil) — an unwired engine
	// is a server misconfiguration (500), not a client fault. Mirrors
	// handleRiffSpawn.
	if s.riff == nil {
		writeError(w, http.StatusInternalServerError, "Riff engine not configured")
		return
	}

	// Background context (not r.Context()) bounded by the engine's aggregate
	// budget, so a client disconnect never orphans a half-created window —
	// handleRiffSpawn's rationale, same constant.
	engineCtx, engineCancel := context.WithTimeout(context.Background(), riffSpawnTimeout)
	defer engineCancel()

	opts := riff.Options{
		Server:  server,
		Session: src.Session,
		// Where=checkout is what makes this a SAME-DIRECTORY fork: no wt create, the
		// window is rooted at the passed directory.
		Where: forkWhereCheckout,
		// The pane's cwd ITSELF, not a walked-up root — see the gate above. In
		// checkout mode RepoRoot is simply "the directory the window is rooted at",
		// so a subdirectory is a legitimate value.
		RepoRoot:         src.Cwd,
		ResumeSessionRef: src.Ref,
		ForkProvider:     src.Provider,
		WindowNameBase:   src.WindowName + forkWindowNameSuffix,
	}
	if where == forkWhereWorktree {
		// Branch the new worktree from the commit the source checkout is on, so
		// the forked agent sees the code its conversation was about — not wt's
		// default start point. Resolved here (not `--base HEAD`) because wt may
		// resolve HEAD against the main repo rather than this worktree.
		base, err := forkHeadCommit(engineCtx, gitRoot)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		subdir, err := filepath.Rel(gitRoot, src.Cwd)
		if err != nil {
			subdir = ""
		}
		opts.Where = forkWhereWorktree
		opts.RepoRoot = gitRoot
		opts.WorktreeBase = base
		opts.WorktreeSubdir = subdir
	}

	res, err := s.riff.Spawn(engineCtx, opts)
	if err != nil {
		writeError(w, riffStatusForError(err), err.Error())
		return
	}

	body := map[string]string{
		"server":   res.Server,
		"session":  res.Session,
		"window":   res.WindowName,
		"windowId": res.WindowID,
	}
	if res.WorktreePath != "" {
		body["worktreePath"] = res.WorktreePath
	}
	writeJSON(w, http.StatusOK, body)
}

// Fork isolation modes — the `where` query values, riff's vocabulary.
const (
	forkWhereCheckout = "checkout"
	forkWhereWorktree = "worktree"
)

// forkHeadTimeout bounds the `git rev-parse HEAD` that resolves a worktree
// fork's start point.
const forkHeadTimeout = 5 * time.Second

// forkHeadCommitRe is the full-SHA shape `git rev-parse HEAD` prints (SHA-1 or
// SHA-256 object format).
var forkHeadCommitRe = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// forkHeadCommit resolves the commit the checkout at dir is on. Package var so
// handler tests can stub it without a real repo.
var forkHeadCommit = func(parent context.Context, dir string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, forkHeadTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("cannot resolve HEAD of %q for the worktree fork: %w", dir, err)
	}
	sha := strings.TrimSpace(string(out))
	if !forkHeadCommitRe.MatchString(sha) {
		return "", fmt.Errorf("unexpected HEAD %q in %q", sha, dir)
	}
	return sha, nil
}

// forkWindowNameSuffix is appended to the source window's name to form the forked
// window's name base (`<source>-fork`). The engine's resolveWindowName then
// applies its usual `-2`, `-3`, … collision suffixing, so repeated forks of one
// window read `x-fork`, `x-fork-2`, ….
const forkWindowNameSuffix = "-fork"

// forkNonRepoMsg builds the 400 message for a window whose cwd is not inside a
// git repo. It NAMES the offending directory (riffNonRepoMsg's convention); when
// no cwd could be derived at all it says so rather than pointing at a blank path.
func forkNonRepoMsg(cwd string) string {
	if cwd == "" {
		return "The window has no pane to derive a working directory from — a fork needs a directory to open in."
	}
	return fmt.Sprintf("The window's working directory %q is not inside a git repository — a fork opens a new window in the same repo checkout.", cwd)
}
