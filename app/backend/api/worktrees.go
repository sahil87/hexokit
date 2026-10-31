package api

import (
	"net/http"

	"rk/internal/gitinfo"
	"rk/internal/validate"
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
// an error. Worktrees outside $HOME are dropped, since the create endpoints
// reject such cwds.
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
		if _, outside := validate.ExpandTilde(wt.Path); outside != "" {
			continue
		}
		resp.Worktrees = append(resp.Worktrees, worktreeEntry{Path: wt.Path, Branch: wt.Branch})
	}
	writeJSON(w, http.StatusOK, resp)
}
