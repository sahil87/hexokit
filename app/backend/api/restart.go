package api

import (
	"net/http"
)

// devVersion is the sentinel running version for local (non-ldflags) builds.
// Under `just dev` the serve process runs under air (not the daemon), so a
// `rk daemon restart` spawned from it would stop/start the REAL daemon — never
// what a dev tab intends. handleRestart refuses to spawn for this version.
const devVersion = "dev"

// handleRestart bounces the run-kit daemon. POST per Constitution IX.
//
// Flow: (1) refuse (409) when the running version is "dev" — a
// defense-in-depth mirror of the palette-side dev gate (see intake §2);
// (2) refuse (409) when the rk-daemon tmux server is down — the restart runs
// in the managed `restart` job window of the rk-jobs sibling session
// (260812-z1ya), which requires the daemon socket; (3) run `rk daemon
// restart` in that window via the shared runJobFn seam. The window survives
// the daemon session bounce it triggers (daemon.Stop()'s exact-match
// =rk-daemon kill never touches rk-jobs), so the spawn runs BEFORE the
// response: 202 {"status":"restarting","watch":{…}} on a fresh spawn, 200
// already-running with the live window's target, 502 on a spawn error. There
// is NO brew requirement (restart works for any install method).
//
// Accepted caveat (user-decided): if daemon.Start() fails after the stop, the
// web UI is down and SSH is needed — a narrow, accepted failure window; the
// job window's remained pane and the ~/.local/state/hexokit/logs/restart.log
// tee make it diagnosable.
//
// POST /api/restart → 202/200 {"status":...,"watch":{...}} | 409 {"error":...} | 502 {"error":...}
func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if s.version == devVersion {
		writeError(w, http.StatusConflict,
			"restart is disabled for dev builds — under `just dev` the serve process is air-managed, not the daemon")
		return
	}

	// Daemon gate: the managed job window is the only spawn mechanism (intake
	// decision 1 — no detached-spawn fallback).
	if !daemonRunningFn() {
		writeError(w, http.StatusConflict,
			"restart requires the rk daemon — start it with `rk serve -d`")
		return
	}

	selfPath, err := resolveSelfPathFn()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not determine executable path")
		return
	}

	s.runJobAndRespond(w, r, "restarting", "restart", []string{selfPath, "daemon", "restart"})
}
