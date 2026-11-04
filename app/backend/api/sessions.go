package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"rk/internal/validate"
)

func (s *Server) handleSessionsList(w http.ResponseWriter, r *http.Request) {
	result, err := s.sessions.FetchSessions(r.Context(), serverFromRequest(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// resolveWorkingDir validates a user-supplied working directory and expands
// its leading "~" to $HOME. An empty cwd means "unset" and resolves to "" with
// no error. Returns the resolved path, or "" and a 400-ready message.
func resolveWorkingDir(cwd string) (string, string) {
	if cwd == "" {
		return "", ""
	}
	if errMsg := validate.ValidatePath(cwd, "Working directory"); errMsg != "" {
		return "", errMsg
	}
	return validate.ExpandTilde(cwd)
}

func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		CWD  string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateNewName(body.Name, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	resolvedCwd, errMsg := resolveWorkingDir(body.CWD)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if err := s.tmux.CreateSession(body.Name, resolvedCwd, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (s *Server) handleSessionRename(w http.ResponseWriter, r *http.Request) {
	session := chi.URLParam(r, "session")
	if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	// Only the renamed-TO name gets the tightened new-name rule: the URL-param
	// source above stays on permissive ValidateName so a pre-existing spacey
	// session (created outside run-kit) can still be renamed.
	if errMsg := validate.ValidateNewName(body.Name, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if err := s.tmux.RenameSession(session, body.Name, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// sessionStringOption describes one session-scoped string-option channel for
// handleSessionStringOption. Adding a channel is a new descriptor plus a
// route registration — not a new handler.
type sessionStringOption struct {
	// decode extracts the channel's value pointer via a per-channel struct
	// decode, deliberately preserving encoding/json's field-matching semantics
	// (unknown keys ignored, case-insensitive key fold).
	decode func(r *http.Request) (*string, error)
	// validate is the channel's value rule (empty return = valid). It also
	// decides whether an explicit "" is settable: a closed set admitting ""
	// (flair) falls through to the unset arm, while one rejecting it (color)
	// 400s — so null is color's only clear form.
	validate func(value string) string
	set      func(session, value, server string) error
	unset    func(session, server string) error
}

// handleSessionStringOption is the shared handler behind the session-scoped
// string-option endpoints (color, flair): decode {"<field>": <string|null>}
// (an absent field reads as null), then set (non-empty) or unset (null/empty).
func (s *Server) handleSessionStringOption(w http.ResponseWriter, r *http.Request, opt sessionStringOption) {
	session := chi.URLParam(r, "session")
	if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	value, err := opt.decode(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if value != nil {
		if errMsg := opt.validate(*value); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}

	server := serverFromRequest(r)

	if value != nil && *value != "" {
		err = opt.set(session, *value, server)
	} else {
		err = opt.unset(session, server)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Wake the SSE hub: set-option is invisible to the tmuxctl control-mode
	// parser, so without this the change waits for the 12s safety tick.
	// initSSEHub is idempotent.
	s.initSSEHub()
	s.sseHub.wake(server)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleSessionColor sets or clears the @rk_ses_color session option.
// POST /api/sessions/{session}/color ← {"color": "1+3"} sets; null clears.
func (s *Server) handleSessionColor(w http.ResponseWriter, r *http.Request) {
	s.handleSessionStringOption(w, r, sessionStringOption{
		decode: func(r *http.Request) (*string, error) {
			var body struct {
				Color *string `json:"color"`
			}
			err := json.NewDecoder(r.Body).Decode(&body)
			return body.Color, err
		},
		validate: validate.ValidateColorValue,
		set:      s.tmux.SetSessionColor,
		unset:    s.tmux.UnsetSessionColor,
	})
}

// handleSessionFlair sets or clears the @rk_ses_flair session option
// (scope-split from the window @rk_win_flair — see tmux.SetSessionFlair).
// POST /api/sessions/{session}/flair ← {"flair": "onepiece"} sets; null/"" clears.
func (s *Server) handleSessionFlair(w http.ResponseWriter, r *http.Request) {
	s.handleSessionStringOption(w, r, sessionStringOption{
		decode: func(r *http.Request) (*string, error) {
			var body struct {
				Flair *string `json:"flair"`
			}
			err := json.NewDecoder(r.Body).Decode(&body)
			return body.Flair, err
		},
		validate: validate.ValidateFlairValue,
		set:      s.tmux.SetSessionFlair,
		unset:    s.tmux.UnsetSessionFlair,
	})
}

// handleSessionOrderGet returns the persisted session order for the active server.
// GET /api/sessions/order?server=<name> → 200 {"order": [...]}
// Unset option returns 200 {"order": []} — never a 404.
func (s *Server) handleSessionOrderGet(w http.ResponseWriter, r *http.Request) {
	server := serverFromRequest(r)
	order, err := s.tmux.GetSessionOrder(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if order == nil {
		order = []string{}
	}
	writeJSON(w, http.StatusOK, map[string][]string{"order": order})
}

// handleSessionOrderPost persists the session order and broadcasts it to SSE clients.
// POST /api/sessions/order?server=<name> ← {"order": [...]} → 200 {"ok": true}
func (s *Server) handleSessionOrderPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Order []string `json:"order"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body — expected {\"order\": [\"name\", ...]}")
		return
	}
	if body.Order == nil {
		body.Order = []string{}
	}
	for _, name := range body.Order {
		if errMsg := validate.ValidateName(name, "Session name"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
	}

	server := serverFromRequest(r)
	if err := s.tmux.SetSessionOrder(r.Context(), server, body.Order); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// initSSEHub is idempotent — a hub created here picks up future clients.
	s.initSSEHub()
	s.sseHub.broadcastSessionOrder(server, body.Order)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSessionKill(w http.ResponseWriter, r *http.Request) {
	session := chi.URLParam(r, "session")
	if errMsg := validate.ValidateName(session, "Session name"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if err := s.tmux.KillSession(session, serverFromRequest(r)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
