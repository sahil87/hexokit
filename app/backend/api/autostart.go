package api

import (
	"context"
	"net/http"
	"runtime"
	"time"

	"rk/internal/daemon/autostart"
)

// autostartProbeTimeout bounds the service-manager probe behind
// GET /api/daemon/autostart.
const autostartProbeTimeout = 10 * time.Second

// autostartUnavailable is the summary of the supported:false response.
const autostartUnavailable = "unavailable"

// autostartResponse is the GET /api/daemon/autostart body. Status is present
// only when supported; Error only when not.
type autostartResponse struct {
	Supported bool              `json:"supported"`
	Summary   string            `json:"summary"`
	Status    *autostart.Status `json:"status,omitempty"`
	Error     string            `json:"error,omitempty"`
}

// handleDaemonAutostart serves the daemon autostart state, read-only: it
// never calls the backend's On or Off. An unresolvable backend or a failed
// probe is data (200, supported:false) so the UI can render it.
func (s *Server) handleDaemonAutostart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), autostartProbeTimeout)
	defer cancel()

	probe := s.autostartStatusFn
	if probe == nil {
		probe = productionAutostartStatus
	}
	st, err := probe(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, autostartResponse{Summary: autostartUnavailable, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, autostartResponse{Supported: true, Summary: st.Summary(), Status: &st})
}

func productionAutostartStatus(ctx context.Context) (autostart.Status, error) {
	b, err := autostart.For(runtime.GOOS)
	if err != nil {
		return autostart.Status{}, err
	}
	return b.Status(ctx)
}
