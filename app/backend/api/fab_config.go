package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"rk/internal/fabsysconfig"
)

// fabSysClient returns the injected fab wrapper, or the real one.
func (s *Server) fabSysClient() *fabsysconfig.Client {
	if s.fabSys != nil {
		return s.fabSys
	}
	return fabsysconfig.NewClient()
}

// handleGetFabConfig returns fab-kit's machine-wide config document, re-read
// from the fab CLI on every request (no cache — external writers win).
// GET /api/fab-config → 200 {"installed": bool, "systemPath", "tools", "fields", "roles", "agent_presets"?, ...}
// agent_presets is `fab agent presets --json`, absent on a fab that cannot list
// presets; fields["agent.preset"] is absent while no preset is selected.
func (s *Server) handleGetFabConfig(w http.ResponseWriter, r *http.Request) {
	doc, err := s.fabSysClient().Read(r.Context())
	if err != nil {
		s.writeFabConfigError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// handlePostFabConfig applies a partial-merge patch per Constitution IX:
// present keys `fab config set --system`, null keys `fab config unset
// --system`. The whole patch is validated before any fab write; the response
// is the freshly re-read document plus fab's stderr warnings. A fab failure
// mid-patch leaves earlier keys written (fab has no multi-key transaction).
// A role's tool leaf is neutral (`.tool`); the wrapper writes it in the
// installed fab's spelling (`.cli`, or `.provider` before fab's rename).
// agent.preset is validated against fab's own preset list (or the reserved
// "none") before any write; null unsets it.
// POST /api/fab-config ← {"agent.preset": "codex-review", "agent.workers": "codex", "agent.profiles.review.tool": "codex", "agent.profiles.review.model": null}
func (s *Server) handlePostFabConfig(w http.ResponseWriter, r *http.Request) {
	var patch map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil || patch == nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	doc, err := s.fabSysClient().Apply(r.Context(), patch)
	if err != nil {
		s.writeFabConfigError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// writeFabConfigError maps wrapper errors to statuses: validation → 400 (no
// exec happened), fab absent → 503, fab non-zero exit → 502 carrying fab's own
// stderr so the row that triggered it can show it verbatim.
func (s *Server) writeFabConfigError(w http.ResponseWriter, err error) {
	var ve *fabsysconfig.ValidationError
	var ce *fabsysconfig.CommandError
	switch {
	case errors.As(err, &ve):
		writeError(w, http.StatusBadRequest, ve.Msg)
	case errors.Is(err, fabsysconfig.ErrNotInstalled):
		writeError(w, http.StatusServiceUnavailable, "fab is not installed on this host")
	case errors.As(err, &ce):
		s.logger.Warn("fab config command failed", "argv", ce.Argv, "stderr", ce.Stderr)
		writeError(w, http.StatusBadGateway, ce.Error())
	default:
		s.logger.Error("fab config failed", "error", err)
		writeError(w, http.StatusInternalServerError, "fab config failed")
	}
}
