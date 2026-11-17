package api

import (
	"encoding/json"
	"net/http"

	"rk/internal/sessions"
	"rk/internal/tmux"
	"rk/internal/validate"
)

func blockTargetOrder(windows []tmux.WindowInfo, members []string, before string) []tmux.WindowInfo {
	memberSet := make(map[string]struct{}, len(members))
	memberWindows := make(map[string]tmux.WindowInfo, len(members))
	for _, id := range members {
		memberSet[id] = struct{}{}
	}

	remaining := make([]tmux.WindowInfo, 0, len(windows)-len(members))
	for _, window := range windows {
		if _, ok := memberSet[window.WindowID]; ok {
			memberWindows[window.WindowID] = window
			continue
		}
		remaining = append(remaining, window)
	}

	beforeIndex := len(remaining)
	for i, window := range remaining {
		if window.WindowID == before {
			beforeIndex = i
			break
		}
	}

	target := make([]tmux.WindowInfo, 0, len(windows))
	target = append(target, remaining[:beforeIndex]...)
	for _, id := range members {
		target = append(target, memberWindows[id])
	}
	target = append(target, remaining[beforeIndex:]...)
	return target
}

func findSessionWindows(result []sessions.ProjectSession, name string) ([]tmux.WindowInfo, bool) {
	for _, session := range result {
		if session.Name == name {
			return session.Windows, true
		}
	}
	return nil, false
}

func (s *Server) handleWindowMoveBlock(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WindowIDs      []string `json:"windowIds"`
		BeforeWindowID string   `json:"beforeWindowId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}
	if len(body.WindowIDs) == 0 {
		writeError(w, http.StatusBadRequest, "windowIds must not be empty")
		return
	}
	if errMsg := validate.ValidateWindowID(body.BeforeWindowID, "Before window ID"); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	seen := make(map[string]struct{}, len(body.WindowIDs))
	for _, id := range body.WindowIDs {
		if errMsg := validate.ValidateWindowID(id, "Window ID"); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		if _, ok := seen[id]; ok {
			writeError(w, http.StatusBadRequest, "windowIds must not contain duplicates")
			return
		}
		if id == body.BeforeWindowID {
			writeError(w, http.StatusBadRequest, "beforeWindowId must not be in windowIds")
			return
		}
		seen[id] = struct{}{}
	}

	server := serverFromRequest(r)
	result, err := s.sessions.FetchSessions(r.Context(), server)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	windowSessions := make(map[string]string)
	var targetSession string
	for _, session := range result {
		for _, window := range session.Windows {
			windowSessions[window.WindowID] = session.Name
			if window.WindowID == body.BeforeWindowID {
				targetSession = session.Name
			}
		}
	}
	if targetSession == "" {
		writeError(w, http.StatusNotFound, "Before window not found")
		return
	}
	for _, id := range body.WindowIDs {
		if _, ok := windowSessions[id]; !ok {
			writeError(w, http.StatusBadRequest, "Window not found: "+id)
			return
		}
	}

	moved := false
	for _, id := range body.WindowIDs {
		if windowSessions[id] == targetSession {
			continue
		}
		if err := s.tmux.MoveWindowToSession(id, targetSession, server); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		moved = true
	}

	windows, _ := findSessionWindows(result, targetSession)
	if moved {
		result, err = s.sessions.FetchSessions(r.Context(), server)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		var found bool
		windows, found = findSessionWindows(result, targetSession)
		if !found {
			writeError(w, http.StatusNotFound, "Target session not found")
			return
		}
	}

	target := blockTargetOrder(windows, body.WindowIDs, body.BeforeWindowID)
	moves := planSortMoves(windows, target)
	for _, move := range moves {
		if err := s.tmux.MoveWindow(move.windowID, move.dstIndex, server); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	if moved || len(moves) > 0 {
		s.initSSEHub()
		s.sseHub.wake(server)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
