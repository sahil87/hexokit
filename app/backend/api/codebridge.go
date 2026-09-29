package api

// GET /api/windows/{windowId}/code-bridge — the first-boot rescue's signal
// read: whether the bridge extension is installed, the newest pid-alive
// tab-keyed host record's startedAt (the good-boot confirmation), and the
// newest pid-alive empty-boot marker's stamp (the positive broken-boot
// signal) for (server, windowId). Everything is derived from the filesystem
// at request time (Constitution II) and the route is read-shaped, so it is a
// GET (Constitution IX). The registry reads are kill-0-filtered only — no
// socket dial, no prune (LiveHosts does both and is the CLI's verb, never a
// request path's).

import (
	"net/http"
	"os"

	"rk/internal/codebridge"
	"rk/internal/codeserver"
	"rk/internal/validate"
)

// handleCodeBridge serves GET /api/windows/{windowId}/code-bridge:
// 200 {"installed","startedAt","emptyBootAt"} / 400 on an invalid window id
// or an explicitly invalid server / 500 on an unexpected registry read error.
// A missing hosts or boots dir or an unresolvable state dir degrades to ""
// stamps (the absent-is-empty read posture), and an unresolvable home dir
// degrades to installed false — a degenerate box fires no rescue anyway.
func (s *Server) handleCodeBridge(w http.ResponseWriter, r *http.Request) {
	windowID, ok := parseWindowID(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid window ID")
		return
	}

	// Same contract as the code-workspace GET: the server names a path segment
	// on disk, so an explicitly invalid value is a 400 rather than a silent
	// default.
	server := r.URL.Query().Get("server")
	if server == "" {
		server = "default"
	} else if msg := validate.ValidateServerName(server); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	// The rk doctor derivation, verbatim: installed = a version scans out of
	// the extensions dir.
	installed := false
	if home, err := os.UserHomeDir(); err == nil {
		version, err := codeserver.InstalledBridgeVersion(codeserver.ExtensionsDir(home))
		installed = err == nil && version != ""
	}

	startedAt := ""
	if _, err := codebridge.StateDir(); err == nil {
		records, err := codebridge.ReadRecordsMerged()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		startedAt = codebridge.TabStartedAt(records, server, windowID, codebridge.PIDAlive)
	}

	emptyBootAt := ""
	if _, err := codebridge.StateDir(); err == nil {
		markers, err := codebridge.ReadBootMarkersMerged()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		emptyBootAt = codebridge.TabEmptyBootAt(markers, server, windowID, codebridge.PIDAlive)
	}

	writeJSON(w, http.StatusOK, map[string]any{"installed": installed, "startedAt": startedAt, "emptyBootAt": emptyBootAt})
}
