package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"rk/internal/wtdiff"
)

// diffRequestTimeout bounds a working-tree read. Generous for two local git
// calls (measured at ~0.05 s on a 216-file tree) — it exists so a wedged
// filesystem or a held index lock cannot pin a request goroutine, not because
// the read is expected to be slow.
const diffRequestTimeout = 10 * time.Second

// diffReader lazily builds the process-wide working-tree reader, for the same
// reason reviewFetcher is lazy: a daemon whose user never opens the tile should
// never allocate it.
func (s *Server) diffReader() *wtdiff.Reader {
	s.wtDiffOnce.Do(func() {
		if s.wtDiff == nil {
			s.wtDiff = wtdiff.NewReader()
		}
	})
	return s.wtDiff
}

// resolveDiffRoot reads the window's repo root from one request-scoped session
// snapshot. `gitRoot` is the window's active-pane cwd walked to its repo root,
// already derived server-side and already on the SSE payload — the same trick
// the review surface plays with `prUrl`, so this adds no new derivation.
//
// A window outside any repository is a 404: the surface is repo-backed, so
// there is no tile rather than an empty one.
func (s *Server) resolveDiffRoot(ctx context.Context, r *http.Request, windowID string) (string, error) {
	sessions, err := s.sessions.FetchSessions(ctx, serverFromRequest(r))
	if err != nil {
		return "", err
	}
	for si := range sessions {
		for wi := range sessions[si].Windows {
			window := &sessions[si].Windows[wi]
			if window.WindowID != windowID {
				continue
			}
			if window.GitRoot == "" {
				return "", wtdiff.ErrNoRepo
			}
			return window.GitRoot, nil
		}
	}
	return "", wtdiff.ErrNoRepo
}

// GET /api/diff?window={id}
func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	windowID, ok := windowIDParam(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), diffRequestTimeout)
	defer cancel()

	root, err := s.resolveDiffRoot(ctx, r, windowID)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	snapshot, err := s.diffReader().Read(ctx, root)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// GET /api/diff/digest?window={id}
//
// The tile's freshness seam. It answers one fingerprint of everything the tile
// renders, so a client can ask "has anything changed?" on a short cadence
// without pulling the document each time.
//
// The PR surface deliberately owns no timer — its refresh costs GraphQL points,
// so freshness there is PUSHED off the SSE thread digest. Neither half of that
// reasoning survives here: a working-tree read is two local subprocesses and no
// API budget at all, and a file edit produces no tmux event, so the SSE tick
// would not carry the signal even if we put it there. Asking is both affordable
// and the only thing that actually sees an editor-side change.
func (s *Server) handleDiffDigest(w http.ResponseWriter, r *http.Request) {
	windowID, ok := windowIDParam(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), diffRequestTimeout)
	defer cancel()

	root, err := s.resolveDiffRoot(ctx, r, windowID)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	digest, err := s.diffReader().Digest(ctx, root)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"digest": digest})
}

// GET /api/diff/file?window={id}&path=…
//
// `path` is shape-validated here and then checked against the snapshot's OWN
// changed-file list. That closed set is the authorization and is not optional:
// without it the route would serve any file in the repository, and through a
// `..` segment, any file outside it.
func (s *Server) handleDiffFile(w http.ResponseWriter, r *http.Request) {
	windowID, ok := windowIDParam(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "Missing path")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), diffRequestTimeout)
	defer cancel()

	root, err := s.resolveDiffRoot(ctx, r, windowID)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	snapshot, err := s.diffReader().Read(ctx, root)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	file := snapshot.FindFile(path)
	if file == nil {
		writeError(w, http.StatusNotFound, "File is not in the working tree's changes")
		return
	}
	body, err := s.diffReader().FileRows(ctx, root, file)
	if err != nil {
		writeDiffError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// writeDiffError maps the reader's states onto HTTP. A window with no
// repository is a STATE, not an error worth a banner.
func writeDiffError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, wtdiff.ErrNoRepo):
		writeError(w, http.StatusNotFound, "Window is not in a git repository")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, "git took too long to respond — try again")
	default:
		// The detail is for the log, NOT the banner: it is a subprocess error,
		// and the reader can do nothing with "exit status 128".
		slog.Warn("working diff: git failed", "err", err)
		writeError(w, http.StatusBadGateway, "Could not read the working tree")
	}
}
