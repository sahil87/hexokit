package api

import (
	"net/http"

	"rk/internal/gitinfo"
)

type worktreeEntry struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

type worktreesResponse struct {
	Repo      string          `json:"repo"`
	Worktrees []worktreeEntry `json:"worktrees"`
}

// GET /api/worktrees?path=<folder> — the git worktrees of the folder's repo,
// feeding the New sheet's folder list. A folder outside any repository answers
// 200 with an empty list: "no worktrees" is a normal state for the sheet, not
// an error. A worktree the create endpoints would reject as a cwd (outside
// $HOME, or a path ValidatePath refuses) is dropped, so the sheet never offers
// a destination it cannot create in.
func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	resp := worktreesResponse{Worktrees: []worktreeEntry{}}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	dir, errMsg := resolveWorkingDir(path)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	list := gitinfo.ListWorktrees(r.Context(), dir)
	resp.Repo = list.Repo
	for _, wt := range list.Worktrees {
		if _, errMsg := resolveWorkingDir(wt.Path); errMsg != "" {
			continue
		}
		resp.Worktrees = append(resp.Worktrees, worktreeEntry{Path: wt.Path, Branch: wt.Branch})
	}
	writeJSON(w, http.StatusOK, resp)
}
