package api

import (
	"context"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// worktreesTimeout bounds the one `git worktree list` call so a wedged
// filesystem or a held lock cannot pin a request goroutine.
const worktreesTimeout = 5 * time.Second

type worktreeEntry struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

type worktreesResponse struct {
	Repo      string          `json:"repo"`
	Worktrees []worktreeEntry `json:"worktrees"`
}

// GET /api/worktrees?path=<folder> — the git worktrees of the folder's repo,
// feeding the New sheet's folder list. A folder outside any repository (or an
// unreadable one) answers 200 with an empty list: "no worktrees" is a normal
// state for the sheet, not an error.
func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	empty := worktreesResponse{Worktrees: []worktreeEntry{}}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	dir, errMsg := resolveWorkingDir(path)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), worktreesTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain").Output()
	if err != nil {
		writeJSON(w, http.StatusOK, empty)
		return
	}
	writeJSON(w, http.StatusOK, parseWorktrees(string(out)))
}

// parseWorktrees reads `git worktree list --porcelain`: blank-line-separated
// records of `worktree <path>`, `HEAD <sha>`, then `branch refs/heads/<name>`,
// `detached`, or `bare`. The first record is the main worktree, whose basename
// names the repo (a linked worktree's own toplevel would mislabel it). Bare
// records are skipped from the list. Detached HEADs carry an empty branch.
func parseWorktrees(porcelain string) worktreesResponse {
	resp := worktreesResponse{Worktrees: []worktreeEntry{}}
	var cur *worktreeEntry
	bare := false
	first := true

	flush := func() {
		if cur == nil {
			return
		}
		if first {
			name := filepath.Base(cur.Path)
			resp.Repo = strings.TrimSuffix(name, ".git")
			first = false
		}
		if !bare {
			resp.Worktrees = append(resp.Worktrees, *cur)
		}
		cur, bare = nil, false
	}

	for _, line := range strings.Split(porcelain, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur = &worktreeEntry{Path: strings.TrimPrefix(line, "worktree ")}
		case cur != nil && strings.HasPrefix(line, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
		case cur != nil && line == "bare":
			bare = true
		}
	}
	flush()
	return resp
}
