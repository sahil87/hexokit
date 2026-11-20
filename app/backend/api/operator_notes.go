package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/sessions"
	"rk/internal/validate"
)

// operator_notes.go — GET /api/operator/notes?server=<slug>&id=<item-id>: one
// tracked item's full notes list, oldest → newest. The sessions payload
// carries only the newest note and a count; the Operator Tasks row fetches
// this on expand. Read-only (notes are written by `rk operator track note`,
// runs and chat) and read through sessions.ReadOperatorStateForServer, the
// same source selection as the payload, so the two cannot disagree. `id` is
// only compared for equality — never part of a path.

type operatorNotesJSON struct {
	ID    string                  `json:"id"`
	Notes []sessions.OperatorNote `json:"notes"`
}

// readOperatorState reads the server's operator state through the injectable
// seam (nil in the test router would otherwise reach a live tmux socket query).
func (s *Server) readOperatorState(ctx context.Context, server string) (cron.OperatorState, bool) {
	if s.operatorStateFn != nil {
		return s.operatorStateFn(ctx, server)
	}
	return sessions.ReadOperatorStateForServer(ctx, server)
}

// handleOperatorNotes serves GET /api/operator/notes. 400 for a missing id;
// 404 when no state file is readable or no item carries the id.
func (s *Server) handleOperatorNotes(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	state, present := s.readOperatorState(r.Context(), serverFromRequest(r))
	if !present {
		writeError(w, http.StatusNotFound, "no operator state")
		return
	}
	for _, item := range state.Items {
		if item.ID != id {
			continue
		}
		notes := make([]sessions.OperatorNote, len(item.Notes))
		for i, n := range item.Notes {
			notes[i] = sessions.OperatorNote{At: n.At, By: n.By, Text: n.Text}
		}
		writeJSON(w, http.StatusOK, operatorNotesJSON{ID: item.ID, Notes: notes})
		return
	}
	writeError(w, http.StatusNotFound, "no tracked item with that id")
}

// maxNoteBodyBytes bounds the POST body: a server name, an item id and a note
// capped at operator.NoteTextCap runes (up to 4 bytes each) plus JSON framing.
const maxNoteBodyBytes = 8 * operator.NoteTextCap

type operatorNoteBody struct {
	Server string `json:"server"`
	ID     string `json:"id"`
	Text   string `json:"text"`
}

type operatorNoteReceipt struct {
	ID   string                `json:"id"`
	Note sessions.OperatorNote `json:"note"`
}

// operatorStatePath resolves rk's state file for a server through the test seam.
func (s *Server) operatorStatePath(ctx context.Context, server string) (string, error) {
	if s.operatorStatePathFn != nil {
		return s.operatorStatePathFn(ctx, server)
	}
	return operator.StatePathForServer(ctx, server)
}

// handleOperatorNoteAdd serves POST /api/operator/notes. 400 for a malformed
// body, a bad server, an empty id or a note the validator rejects; 404 when
// rk's state file does not exist or no item carries the id; 500 otherwise. A
// 200 is sent only after the atomic write.
func (s *Server) handleOperatorNoteAdd(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxNoteBodyBytes)
	var body operatorNoteBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if msg := validate.ValidateServerName(body.Server); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if body.ID == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	path, err := s.operatorStatePath(r.Context(), body.Server)
	if err != nil {
		s.logger.Error("failed to resolve operator state path", "server", body.Server, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to resolve operator state")
		return
	}
	// Mutate creates a missing file; a server still on fab's legacy ledger has
	// no rk file and must not get one from a note.
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "no rk operator state for this server")
			return
		}
		s.logger.Error("failed to stat operator state", "server", body.Server, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read operator state")
		return
	}
	st, err := operator.Load(path)
	if err != nil {
		s.logger.Error("failed to load operator state", "server", body.Server, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read operator state")
		return
	}
	if !hasTrackedItem(st.Tracked, body.ID) {
		writeError(w, http.StatusNotFound, "no tracked item with that id")
		return
	}
	at := time.Now().Unix()
	if err := operator.AddNote(path, body.ID, operator.ByUser, body.Text); err != nil {
		var invalid *operator.InvalidError
		if errors.As(err, &invalid) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		s.logger.Error("failed to write operator note", "server", body.Server, "id", body.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to write note")
		return
	}
	writeJSON(w, http.StatusOK, operatorNoteReceipt{
		ID:   body.ID,
		Note: sessions.OperatorNote{At: at, By: operator.ByUser, Text: strings.TrimSpace(body.Text)},
	})
}

func hasTrackedItem(items []operator.TrackedItem, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}
