package api

import (
	"net/http"

	"rk/internal/daemon"
)

// restartCodeServerFn is the seam over daemon.RestartCodeServer so tests drive
// the handler without a live tmux server.
var restartCodeServerFn = daemon.RestartCodeServer

// handleCodeServerRestart serves POST /api/code-server/restart — the code
// lens empty state's "Restart code-server" action: kill + re-ensure the
// daemon-managed session (see daemon.RestartCodeServer). 409 on dev builds —
// the dev serve process resolves the DEV code-server port, and a restart
// would kill the real daemon's session to spawn on it (the handleRestart
// devVersion guard's twin). 500 with the error text on failure.
//
// POST /api/code-server/restart → 200 {"status":"started"|"installing"|"external"} | 409 | 500
func (s *Server) handleCodeServerRestart(w http.ResponseWriter, r *http.Request) {
	if s.version == devVersion {
		writeError(w, http.StatusConflict,
			"code-server restart is disabled for dev builds — restart `just dev` instead")
		return
	}
	outcome, err := restartCodeServerFn()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := "started"
	switch outcome {
	case daemon.EnsureInstallJobSpawned:
		status = "installing"
	case daemon.EnsureExternallyManaged:
		status = "external"
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}
