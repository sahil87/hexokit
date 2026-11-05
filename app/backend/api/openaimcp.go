package api

import (
	"encoding/json"
	"net/http"

	"rk/internal/daemon"
	"rk/internal/openaimcp"
	"rk/internal/settings"
)

// openAIMCPKeyRequest is the POST /api/openai-mcp/key body. Key is a pointer
// so an absent or null field is told apart from "" (the clear request).
type openAIMCPKeyRequest struct {
	Key *string `json:"key"`
}

// handleOpenAIMCPKey writes or clears the connector's runtime API key
// (docs/specs/openai-mcp.md § Settings). A non-empty key is validated before
// touching disk; "" deletes the file. When the connector is on, a new key
// restarts tunnel-client and a cleared key stops it. The response carries
// only keySet: no route ever returns the key.
func (s *Server) handleOpenAIMCPKey(w http.ResponseWriter, r *http.Request) {
	var req openAIMCPKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Key == nil {
		writeError(w, http.StatusBadRequest, `body must be {"key": "<sk-…>"} or {"key": ""} to clear`)
		return
	}
	layout, err := s.openAIMCPLayout()
	if err != nil {
		s.logger.Error("chatgpt connector: state dir unresolvable", "error", err)
		writeError(w, http.StatusInternalServerError, "connector state dir unresolvable")
		return
	}
	if *req.Key == "" {
		if err := layout.ClearKey(); err != nil {
			s.logger.Error("chatgpt connector: clearing the key failed", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to clear the key")
			return
		}
	} else {
		if msg := openaimcp.ValidateKey(*req.Key); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if err := layout.WriteKey(*req.Key); err != nil {
			s.logger.Error("chatgpt connector: writing the key failed", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save the key")
			return
		}
	}

	if settings.Load().OpenAIMCPEnabled {
		if *req.Key == "" {
			if _, err := s.openAIMCPKill(); err != nil {
				s.logger.Warn("chatgpt connector: stopping after key clear failed", "error", err)
			}
		} else if err := s.openAIMCPRestart(); err != nil {
			s.logger.Warn("chatgpt connector: restart after key save failed (the stream reports the state)", "error", err)
		}
	}
	s.refreshOpenAIMCPStatus()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "keySet": layout.KeySet()})
}

// handleOpenAIMCPRestart kills and re-ensures tunnel-client. 409 while the
// connector is off: a restart never flips the switch.
func (s *Server) handleOpenAIMCPRestart(w http.ResponseWriter, r *http.Request) {
	if !settings.Load().OpenAIMCPEnabled {
		writeError(w, http.StatusConflict, "chatgpt connector is off")
		return
	}
	err := s.openAIMCPRestart()
	s.refreshOpenAIMCPStatus()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// applyOpenAIMCPSettings runs the openai_mcp.* settings POST side effects on
// the saved settings. Called only when the patch carried openai_mcp.enabled
// or changed the tunnel ID: off (in the patch) stops tunnel-client; a tunnel
// change while on restarts it; on with the same tunnel ensures it; a tunnel
// change while off does nothing (it applies on the next start). Failures log
// and never fail the request; the status stream reports the resulting state.
func (s *Server) applyOpenAIMCPSettings(current settings.Settings, enabledInPatch, tunnelChanged bool) {
	switch {
	case !current.OpenAIMCPEnabled:
		if enabledInPatch {
			if _, err := s.openAIMCPKill(); err != nil {
				s.logger.Warn("openai_mcp.enabled off: session kill failed", "error", err)
			}
		}
	case tunnelChanged:
		if err := s.openAIMCPRestart(); err != nil {
			s.logger.Warn("openai_mcp.tunnel_id changed: restart failed (the stream reports the state)", "error", err)
		}
	case enabledInPatch:
		if _, err := s.openAIMCPEnsure(); err != nil {
			s.logger.Warn("openai_mcp.enabled on: ensure failed (the stream reports the state)", "error", err)
		}
	}
	s.refreshOpenAIMCPStatus()
}

// refreshOpenAIMCPStatus makes the hub's next tick re-probe the connector
// inside the TTL, so a POST's effect reaches the UI within one tick.
func (s *Server) refreshOpenAIMCPStatus() {
	s.initSSEHub()
	s.sseHub.refreshOpenAIMCP()
}

func (s *Server) openAIMCPEnsure() (daemon.OpenAIMCPEnsureOutcome, error) {
	if s.openAIMCPEnsureFn != nil {
		return s.openAIMCPEnsureFn()
	}
	// The in-daemon posture: installs a missing tunnel-client, restarts a
	// running one onto a changed profile.
	return daemon.EnsureOpenAIMCPFromDaemon()
}

func (s *Server) openAIMCPKill() (bool, error) {
	if s.openAIMCPKillFn != nil {
		return s.openAIMCPKillFn()
	}
	return daemon.KillOpenAIMCPSession()
}

func (s *Server) openAIMCPRestart() error {
	if s.openAIMCPRestartFn != nil {
		return s.openAIMCPRestartFn()
	}
	return daemon.RestartOpenAIMCP()
}

func (s *Server) openAIMCPLayout() (openaimcp.Layout, error) {
	if s.openAIMCPLayoutFn != nil {
		return s.openAIMCPLayoutFn()
	}
	return openaimcp.DefaultLayout()
}
