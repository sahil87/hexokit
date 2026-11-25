package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"rk/internal/fabsysconfig"
	"rk/internal/tmux"
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
	var pe *fabsysconfig.PartialWriteError
	var be *fabsysconfig.BindingsError
	switch {
	case errors.As(err, &ve):
		writeError(w, http.StatusBadRequest, ve.Msg)
	case errors.As(err, &pe):
		s.logger.Warn("fab config operation stopped part-way", "failed", pe.Failed, "landed", pe.Landed, "stderr", pe.Stderr)
		writeJSON(w, http.StatusBadGateway, partialWriteBody{Error: pe.Error(), Landed: pe.Landed, Failed: pe.Failed})
	case errors.As(err, &be):
		s.logger.Warn("agent-preset option listing failed", "error", be.Err)
		writeError(w, http.StatusBadGateway, be.Error())
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

// partialWriteBody is the 502 body of a multi-write operation that stopped at
// its first failing step: Landed are the steps already durable, Failed the one
// that did not.
type partialWriteBody struct {
	Error  string   `json:"error"`
	Landed []string `json:"landed"`
	Failed string   `json:"failed"`
}

// decodeFabConfigBody decodes a JSON request body into v, answering 400 itself.
func decodeFabConfigBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return false
	}
	return true
}

// respondFabConfigOp writes an operation's outcome: the re-read document on
// success (200), the mapped error otherwise.
func (s *Server) respondFabConfigOp(w http.ResponseWriter, doc *fabsysconfig.Document, err error) {
	if err != nil {
		s.writeFabConfigError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// handleDuplicateAgentPreset copies every field of a listed preset (built-in or
// yours) to a new name; the optional description replaces the copied one.
// POST /api/fab-config/presets/duplicate ← {"from": "codex-review", "to": "night-review", "description": "..."}
func (s *Server) handleDuplicateAgentPreset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From        string `json:"from"`
		To          string `json:"to"`
		Description string `json:"description"`
	}
	if !decodeFabConfigBody(w, r, &body) {
		return
	}
	doc, err := s.fabSysClient().DuplicatePreset(r.Context(), body.From, body.To, body.Description)
	s.respondFabConfigOp(w, doc, err)
}

// handleRenameAgentPreset renames one of your presets in one request: the new
// preset is written, the machine default and every workspace and group option
// naming the old name are repointed, then the old preset is removed.
// POST /api/fab-config/presets/rename ← {"from": "night-shift", "to": "late-shift"}
func (s *Server) handleRenameAgentPreset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if !decodeFabConfigBody(w, r, &body) {
		return
	}
	doc, err := s.fabSysClient().RenamePreset(r.Context(), body.From, body.To, s.presetBindings())
	s.afterPresetBindingsChange(err)
	s.respondFabConfigOp(w, doc, err)
}

// handleDeleteAgentPreset removes one of your presets in one request: the
// machine default and every workspace and group option naming it are cleared,
// then the preset is unset.
// POST /api/fab-config/presets/delete ← {"name": "night-shift"}
func (s *Server) handleDeleteAgentPreset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeFabConfigBody(w, r, &body) {
		return
	}
	doc, err := s.fabSysClient().DeletePreset(r.Context(), body.Name, s.presetBindings())
	s.afterPresetBindingsChange(err)
	s.respondFabConfigOp(w, doc, err)
}

// handleMoveLeftoverSettings moves the loose machine-wide values into a new
// preset (the machine default's fields overlaid with them), makes it the
// machine default and unsets the loose keys.
// POST /api/fab-config/leftovers/move ← {"name": "my-overrides", "description": "Moved from loose machine-wide settings"}
func (s *Server) handleMoveLeftoverSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeFabConfigBody(w, r, &body) {
		return
	}
	doc, err := s.fabSysClient().MoveLeftovers(r.Context(), body.Name, body.Description)
	s.respondFabConfigOp(w, doc, err)
}

// handleClearLeftoverSettings unsets the loose machine-wide values.
// POST /api/fab-config/leftovers/clear ← {}
func (s *Server) handleClearLeftoverSettings(w http.ResponseWriter, r *http.Request) {
	doc, err := s.fabSysClient().ClearLeftovers(r.Context())
	s.respondFabConfigOp(w, doc, err)
}

// handleResolveAgentPreset returns what each role resolves to under one preset,
// per `fab agent <role> --preset <name> -o yaml`; a role fab cannot resolve is
// empty.
// GET /api/fab-config/presets/resolve?name=<preset> → 200 {"roles": {"review": {"cli", "model", "effort"}, ...}}
func (s *Server) handleResolveAgentPreset(w http.ResponseWriter, r *http.Request) {
	roles, err := s.fabSysClient().ResolvePreset(r.Context(), r.URL.Query().Get("name"))
	if err != nil {
		s.writeFabConfigError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

// afterPresetBindingsChange wakes every SSE client unless the request was
// rejected before any write: set-option emits no control-mode event, so the
// repaint would otherwise wait for the safety tick.
func (s *Server) afterPresetBindingsChange(err error) {
	var ve *fabsysconfig.ValidationError
	if errors.As(err, &ve) {
		return
	}
	s.wakeAllSSE()
}

// presetBindings adapts the tmux wrappers to the workspace and group options
// naming an agent preset, on every server the daemon covers.
func (s *Server) presetBindings() fabsysconfig.PresetBindings {
	return tmuxPresetBindings{s: s}
}

type tmuxPresetBindings struct{ s *Server }

func (b tmuxPresetBindings) List(ctx context.Context) ([]fabsysconfig.PresetBinding, error) {
	servers, err := b.s.tmux.ListServers(ctx)
	if err != nil {
		return nil, err
	}
	var out []fabsysconfig.PresetBinding
	for _, server := range servers {
		name, err := b.s.tmux.GetServerAgentPreset(ctx, server)
		if err != nil {
			return nil, fmt.Errorf("read workspace %s: %w", server, err)
		}
		if name != "" {
			out = append(out, fabsysconfig.PresetBinding{Server: server, Preset: name})
		}
		sessions, err := b.s.tmux.ListSessions(ctx, server)
		if err != nil {
			if tmux.IsServerGone(err) {
				continue
			}
			return nil, fmt.Errorf("list groups on %s: %w", server, err)
		}
		for _, si := range sessions {
			if si.AgentPreset != "" {
				out = append(out, fabsysconfig.PresetBinding{Server: server, Session: si.Name, Preset: si.AgentPreset})
			}
		}
	}
	return out, nil
}

func (b tmuxPresetBindings) Set(ctx context.Context, pb fabsysconfig.PresetBinding, name string) error {
	if pb.Session == "" {
		return b.s.tmux.SetServerAgentPreset(ctx, pb.Server, name)
	}
	return b.s.tmux.SetSessionAgentPreset(pb.Session, name, pb.Server)
}

func (b tmuxPresetBindings) Clear(ctx context.Context, pb fabsysconfig.PresetBinding) error {
	if pb.Session == "" {
		return b.s.tmux.UnsetServerAgentPreset(ctx, pb.Server)
	}
	return b.s.tmux.UnsetSessionAgentPreset(pb.Session, pb.Server)
}
