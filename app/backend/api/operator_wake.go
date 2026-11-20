package api

import (
	"encoding/json"
	"net/http"

	"rk/internal/cron"
	"rk/internal/validate"
)

// operator_wake.go — POST /api/operator/wake {"server": "<name>", "reason":
// "<text>"}: the HTTP half of the trigger door (`rk operator wake` is the CLI
// half). It writes the server's cron/<slug>.wake marker through the same cron
// helpers before answering, so a 200 means the trigger is durable and the next
// cron tick fires the operator loop with `trigger:<reason>`. The daemon keeps
// no state of its own for it.

// maxWakeBodyBytes bounds the request body (a server name and a one-line
// reason).
const maxWakeBodyBytes = 4 * 1024

type operatorWakeBody struct {
	Server string `json:"server"`
	Reason string `json:"reason"`
}

type operatorWakeReceipt struct {
	Server string `json:"server"`
	Reason string `json:"reason"`
}

// cronDir resolves the cron state dir through the test seam.
func (s *Server) cronDir() (string, error) {
	if s.cronDirFn != nil {
		return s.cronDirFn()
	}
	return cron.DefaultDir()
}

// handleOperatorWake serves POST /api/operator/wake. 400 for a malformed body,
// a bad server name or a bad reason; 500 when the marker cannot be written.
func (s *Server) handleOperatorWake(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxWakeBodyBytes)
	var body operatorWakeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if msg := validate.ValidateServerName(body.Server); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	reason, err := cron.NormalizeWakeReason(body.Reason)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	dir, err := s.cronDir()
	if err == nil {
		err = cron.EnsureDir(dir)
	}
	if err == nil {
		err = cron.WriteWakeMarker(dir, body.Server, reason, s.now())
	}
	if err != nil {
		s.logger.Error("failed to write operator wake marker", "server", body.Server, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to write wake marker")
		return
	}
	writeJSON(w, http.StatusOK, operatorWakeReceipt{Server: body.Server, Reason: reason})
}
