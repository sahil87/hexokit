package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"

	"rk/internal/fabsysconfig"
	"rk/internal/validate"
)

// agent_preset.go — set/clear routes for the group (@rk_ses_agent_preset) and
// workspace (@rk_srv_agent_preset) agent presets, plus the membership checks
// every surface naming a preset shares. A name is charset-checked before any
// subprocess, then must be one fab lists for the relevant scope or the
// reserved "none"; clearing never consults fab.

// listAgentPresets reads fab's preset list rooted at a directory (the session's
// repo root, or $HOME for the machine view). A var so tests inject a fixed table
// without running fab — mirrors loadRiffPresets.
var listAgentPresets = fabsysconfig.ListAgentPresets

// machinePresetDir is the directory whose preset list is the machine-wide view.
func machinePresetDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}

// checkPresetMembership validates a non-empty preset name against fab's list
// rooted at dir. It returns an HTTP status and message on rejection (400 for an
// unsupported fab or an unknown name), or (0, "") when the name is acceptable.
// Charset validation (ValidateAgentPresetName) is the caller's, and runs first.
func (s *Server) checkPresetMembership(ctx context.Context, name, dir string) (int, string) {
	presets, err := listAgentPresets(ctx, dir)
	if err != nil {
		return http.StatusBadRequest, err.Error()
	}
	if err := fabsysconfig.CheckPresetMember(name, presets); err != nil {
		return http.StatusBadRequest, err.Error()
	}
	return 0, ""
}

// validateOptionalPresetName is the charset rule for a settable value: an
// explicit "" is the clear form, so it passes here.
func validateOptionalPresetName(value string) string {
	if value == "" {
		return ""
	}
	return validate.ValidateAgentPresetName(value)
}

// groupPresetDir is the directory whose preset list applies to a group: the
// session's derived repo root, else the machine view.
func (s *Server) groupPresetDir(ctx context.Context, server, session string) string {
	if root, _, err := deriveRepoRoot(ctx, s.tmux, server, session); err == nil && root != "" {
		return root
	}
	return machinePresetDir()
}

// handleSessionAgentPreset sets or clears the @rk_ses_agent_preset session option.
// POST /api/sessions/{session}/agent-preset?server=<s> ← {"agent_preset": "codex-review"}
// sets; null or "" clears.
func (s *Server) handleSessionAgentPreset(w http.ResponseWriter, r *http.Request) {
	s.handleSessionStringOption(w, r, sessionStringOption{
		decode: func(r *http.Request) (*string, error) {
			var body struct {
				AgentPreset *string `json:"agent_preset"`
			}
			err := json.NewDecoder(r.Body).Decode(&body)
			return body.AgentPreset, err
		},
		validate: validateOptionalPresetName,
		check: func(ctx context.Context, session, value, server string) (int, string) {
			rootCtx, cancel := context.WithTimeout(ctx, riffRepoRootTimeout)
			defer cancel()
			return s.checkPresetMembership(ctx, value, s.groupPresetDir(rootCtx, server, session))
		},
		set:   s.tmux.SetSessionAgentPreset,
		unset: s.tmux.UnsetSessionAgentPreset,
	})
}

// handleServerAgentPreset sets or clears the @rk_srv_agent_preset server option.
// POST /api/servers/agent-preset ← {"name": "<server>", "agent_preset": "claude" | null}
// → 200 {"ok": true}. Membership is checked against the machine-wide list.
func (s *Server) handleServerAgentPreset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string  `json:"name"`
		AgentPreset *string `json:"agent_preset"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}
	set := body.AgentPreset != nil && *body.AgentPreset != ""
	if body.AgentPreset != nil {
		if errMsg := validateOptionalPresetName(*body.AgentPreset); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}
	if set {
		if status, msg := s.checkPresetMembership(r.Context(), *body.AgentPreset, machinePresetDir()); msg != "" {
			writeError(w, status, msg)
			return
		}
	}

	var err error
	if set {
		err = s.tmux.SetServerAgentPreset(r.Context(), body.Name, *body.AgentPreset)
	} else {
		err = s.tmux.UnsetServerAgentPreset(r.Context(), body.Name)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// set-option emits no control-mode event; wake the hub so the repaint does
	// not wait for the safety tick. initSSEHub is idempotent.
	s.initSSEHub()
	s.sseHub.wake(body.Name)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
