package api

import (
	"context"
	"net/http"

	"rk/internal/cron"
	"rk/internal/sessions"
)

// operator_notes.go — GET /api/operator/notes?server=<slug>&id=<item-id>: one
// tracked item's full notes list, oldest → newest. The sessions payload
// carries only the newest note and a count; the Operator Tasks row fetches
// this on expand. Read-only (notes are written by `rk operator track note`,
// runs and chat) and read through sessions.ReadOperatorStateForServer, the
// same source selection as the payload, so the two cannot disagree. `id` is
// only compared for equality — never part of a path.

// operatorNoteJSON is the wire shape of one note (unix-second at).
type operatorNoteJSON struct {
	At   int64  `json:"at"`
	By   string `json:"by"`
	Text string `json:"text"`
}

type operatorNotesJSON struct {
	ID    string             `json:"id"`
	Notes []operatorNoteJSON `json:"notes"`
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
		notes := make([]operatorNoteJSON, len(item.Notes))
		for i, n := range item.Notes {
			notes[i] = operatorNoteJSON{At: n.At, By: n.By, Text: n.Text}
		}
		writeJSON(w, http.StatusOK, operatorNotesJSON{ID: item.ID, Notes: notes})
		return
	}
	writeError(w, http.StatusNotFound, "no tracked item with that id")
}
