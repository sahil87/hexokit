package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"rk/internal/config"
	"rk/internal/fabconfig"
	"rk/internal/riff"
	"rk/internal/settings"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// riff.go — the web-UI agent-spawn surface (260713-sbk1). It surfaces the
// extracted internal/riff engine as two endpoints:
//
//   - POST /api/riff           — spawn a riff window (worktree + tmux window +
//                                agent launcher) in the target session's repo.
//   - GET  /api/riff/presets   — list the merged riff presets (run-kit's
//                                riff_presets: built-ins + user).
//
// Both derive the REPO ROOT from the target session's active-pane cwd (the
// daemon's own cwd is not the target repo). The engine does the wt+tmux work;
// these handlers do validation + repo-root derivation + response shaping.
//
// TIMEOUT EXCEPTION (constitution §Process Execution / code-review 5s rule):
// handleRiffSpawn is SYNCHRONOUS and its aggregate MAY exceed the 5s
// tmux-blocking review rule — `wt create` alone is a 30s build-class op. Each
// INDIVIDUAL subprocess inside the engine keeps its own bound (wt: 30s, each
// tmux call: ≤10s, fab: 10s); it is only the sum that can run long, which is
// inherent to a one-shot worktree+window+agent spawn. Documented here per the
// intake's explicit carve-out.

// riffRepoRootTimeout bounds the ListWindows call used to derive the target
// session's repo root. Dedicated (not r.Context()) because the derived root
// feeds the subsequent engine spawn — a client disconnect must not truncate it.
const riffRepoRootTimeout = 5 * time.Second

// deriveRepoRoot resolves the git repo root for a target session by inspecting
// its active-pane cwd: ListWindows(session) → the active window (IsActiveWindow,
// else the first window) → that window's active pane (PaneInfo.IsActive, else
// the first pane) → Cwd → config.FindGitRoot. It returns both the repo root and
// the inspected cwd (so a non-repo caller can name the offending directory in
// its 400):
//
//   - (root, cwd, nil)  — cwd is inside a git repo (root is a dir containing .git)
//   - ("", cwd, nil)    — a cwd was derived but is NOT inside a git repo
//   - ("", "",  nil)    — the session has no window/pane to derive a cwd from
//     (nonexistent/empty session — the real ListWindows swallows its tmux error
//     into an empty result, so this is the practical nonexistent-session path)
//   - ("", "",  err)    — the tmux read itself failed (infrastructure error)
func deriveRepoRoot(ctx context.Context, ops TmuxOps, server, session string) (string, string, error) {
	windows, err := ops.ListWindows(ctx, session, server)
	if err != nil {
		return "", "", err
	}
	if len(windows) == 0 {
		return "", "", nil
	}

	// Pick the active window, else the first.
	win := windows[0]
	for _, w := range windows {
		if w.IsActiveWindow {
			win = w
			break
		}
	}

	cwd := windowCwd(win)
	if cwd == "" {
		return "", "", nil
	}
	return config.FindGitRoot(cwd), cwd, nil
}

// windowCwd picks a window's working directory: the ACTIVE pane's cwd, else the
// first pane's, else the window's worktree path (the list-windows
// #{pane_current_path}). Only a NON-EMPTY pane cwd overrides the WorktreePath
// seed — a pane whose #{pane_current_path} came back blank (or an empty Panes
// slice when list-panes failed non-fatally) must fall through to WorktreePath
// rather than clobber it with "". Returns "" when no directory can be derived.
// Pure. Used by deriveRepoRoot (session-keyed, riff). Conversation forks use
// the resolved agent pane's cwd instead, which may differ from the active pane.
func windowCwd(win tmux.WindowInfo) string {
	cwd := win.WorktreePath
	if len(win.Panes) > 0 {
		if first := win.Panes[0].Cwd; first != "" {
			cwd = first
		}
		for _, p := range win.Panes {
			if p.IsActive {
				if p.Cwd != "" {
					cwd = p.Cwd
				}
				break
			}
		}
	}
	return cwd
}

// handleRiffSpawn spawns a riff window in the target session's repo.
//
//	POST /api/riff?server=<name>
//	body: {"task"?: string, "preset"?: string, "session": string,
//	       "where"?: "worktree"|"checkout", "worktreeName"?: string, "tier"?: string}
//	200: {"server","session","window","windowId"}
//	400: invalid session; unknown where; worktreeName+checkout; forbidden
//	     worktreeName/tier chars; non-repo cwd; or unknown preset (nothing created)
//
// See the file header for the documented 5s-review-rule timeout exception.
func (s *Server) handleRiffSpawn(w http.ResponseWriter, r *http.Request) {
	server := serverFromRequest(r)

	var body struct {
		Task         string `json:"task"`
		Preset       string `json:"preset"`
		Session      string `json:"session"`
		Where        string `json:"where"`
		WorktreeName string `json:"worktreeName"`
		Tier         string `json:"tier"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if errMsg := validate.ValidateName(body.Session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}
	// Validate the mockup-v2 fields BEFORE deriving the repo root or touching any
	// subprocess (constitution §I — nothing is created on a 400). where/
	// worktreeName/tier are all optional and additive over the shipped body.
	where := body.Where
	if where == "" {
		where = "worktree"
	}
	if where != "worktree" && where != "checkout" {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid where %q — must be \"worktree\" or \"checkout\"", body.Where))
		return
	}
	if body.WorktreeName != "" {
		if where == "checkout" {
			writeError(w, http.StatusBadRequest, "worktreeName has no meaning with where=\"checkout\" — omit it or use where=\"worktree\"")
			return
		}
		if errMsg := validate.ValidateWorktreeName(body.WorktreeName); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}
	if body.Tier != "" {
		if errMsg := validate.ValidateTier(body.Tier); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), riffRepoRootTimeout)
	repoRoot, cwd, err := deriveRepoRoot(ctx, s.tmux, server, body.Session)
	cancel()
	if err != nil {
		// A tmux read failure for a named session is most likely a
		// nonexistent/gone session (client-correctable), not a server fault.
		writeError(w, http.StatusBadRequest, riffSessionReadErrorMsg(body.Session, err))
		return
	}
	if repoRoot == "" {
		writeError(w, http.StatusBadRequest, riffNonRepoMsg(body.Session, cwd, "riff needs a repo to create a worktree. Open the session in a git checkout and try again."))
		return
	}

	// Guard the optional engine (NewTestRouter leaves it nil; only NewProdRouter /
	// NewTestRouterWithRiff wire one). Mirrors the prStatus nil-safe house pattern
	// — an unwired engine is a server misconfiguration (500), not a client fault.
	if s.riff == nil {
		writeError(w, http.StatusInternalServerError, "Riff engine not configured")
		return
	}

	// The engine runs the full worktree → window → agent pipeline synchronously
	// (see the file-header timeout exception). Use a background context bounded
	// by the aggregate of the engine's own per-subprocess timeouts rather than
	// r.Context(), so a client disconnect never orphans a half-created worktree.
	engineCtx, engineCancel := context.WithTimeout(context.Background(), riffSpawnTimeout)
	defer engineCancel()

	res, err := s.riff.Spawn(engineCtx, riff.Options{
		Server:       server,
		Session:      body.Session,
		RepoRoot:     repoRoot,
		Task:         body.Task,
		Preset:       body.Preset,
		Where:        where,
		WorktreeName: body.WorktreeName,
		Tier:         body.Tier,
	})
	if err != nil {
		writeError(w, riffStatusForError(err), err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"server":   res.Server,
		"session":  res.Session,
		"window":   res.WindowName,
		"windowId": res.WindowID,
	})
}

// riffSpawnTimeout bounds the whole engine spawn. Sized above the sum of the
// engine's worst-case subprocess timeouts (wt 30s + a handful of ≤10s tmux
// calls + fab 10s) so a healthy spawn never trips it; it exists only to cap a
// wedged subprocess chain.
const riffSpawnTimeout = 90 * time.Second

// loadRiffPresets is the preset-source seam for the presets endpoint
// (production: the settings-backed merged view) — tests inject a fixed table
// without touching the config root.
var loadRiffPresets = settings.LoadRiffPresets

// handleRiffPresets lists the riff presets the spawn dialog offers.
//
//	GET /api/riff/presets?server=<name>&session=<name>
//	200: {"presets":[{"name","layout","paneCount"}], "tiers":[...]}
//	     (presets come from run-kit's riff_presets — the built-ins plus user
//	     entries in ~/.config/hexokit/config.yaml — never empty; every row is
//	     one skill pane: layout "", paneCount 1; tiers gated on
//	     fabconfig.IsFabProject — fab-kit built-ins ∪ the repo's agent.tiers
//	     ("default" first) for a fab project, [] for a non-fab repo)
//	400: invalid session or non-repo cwd
func (s *Server) handleRiffPresets(w http.ResponseWriter, r *http.Request) {
	server := serverFromRequest(r)
	session := r.URL.Query().Get("session")
	if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), riffRepoRootTimeout)
	repoRoot, cwd, err := deriveRepoRoot(ctx, s.tmux, server, session)
	cancel()
	if err != nil {
		writeError(w, http.StatusBadRequest, riffSessionReadErrorMsg(session, err))
		return
	}
	if repoRoot == "" {
		writeError(w, http.StatusBadRequest, riffNonRepoMsg(session, cwd, "no riff presets available."))
		return
	}

	merged := loadRiffPresets()
	presets := make([]riffPresetSummary, 0, len(merged))
	for _, p := range merged {
		presets = append(presets, riffPresetSummary{
			Name:      p.Name,
			Layout:    "",
			PaneCount: 1,
		})
	}
	// tiers rides this one preflight fetch (mockup-v2) so the dialog populates
	// both dropdowns without a second endpoint (constitution §IV). Gated on
	// fab-project detection: a repo with no fab/project/config.yaml is not a fab
	// project, so tiers would be inert noise (every option resolves to the same
	// DefaultLauncher) — return [] and let the dialog hide the field. A fab
	// project (even one with a malformed config) gets ReadTiers's built-ins ∪
	// agent.tiers, default first. Empty slice, not nil, so the JSON key is [].
	tiers := []string{}
	if fabconfig.IsFabProject(repoRoot) {
		tiers = fabconfig.ReadTiers(repoRoot)
	}
	writeJSON(w, http.StatusOK, map[string]any{"presets": presets, "tiers": tiers})
}

// riffPresetSummary is the per-preset shape returned by GET /api/riff/presets —
// just what the dialog's dropdown needs (name + a one-line layout/paneCount
// summary).
type riffPresetSummary struct {
	Name      string `json:"name"`
	Layout    string `json:"layout"`
	PaneCount int    `json:"paneCount"`
}

// riffNonRepoMsg builds the 400 message for a session whose repo root could not
// be derived. It NAMES the offending cwd (R5: "message names the non-repo cwd")
// when one was found; when no cwd could be derived at all (an empty/nonexistent
// session), it says so instead of pointing at a blank directory. suffix is the
// caller-specific tail (spawn vs. presets).
func riffNonRepoMsg(session, cwd, suffix string) string {
	if cwd == "" {
		return fmt.Sprintf("Session %q has no active pane to derive a working directory from — %s", session, suffix)
	}
	return fmt.Sprintf("The session's working directory %q is not inside a git repository — %s", cwd, suffix)
}

// riffSessionReadErrorMsg builds the 400 message for a failed tmux read of a
// named session — most likely a nonexistent/gone session (client-correctable).
func riffSessionReadErrorMsg(session string, err error) string {
	return fmt.Sprintf("Could not read session %q (does it exist?): %v", session, err)
}

// riffStatusForError maps an engine error to an HTTP status. A validation-class
// ExitCodeError (unknown preset, invalid layout) is a 400 (client-correctable,
// nothing created); everything else (subprocess failure, etc.) is a 500.
func riffStatusForError(err error) int {
	var ece *riff.ExitCodeError
	if errors.As(err, &ece) && ece.Code == riff.ExitValidation {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}
