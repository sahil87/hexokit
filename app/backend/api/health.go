package api

import (
	"net/http"

	"rk/internal/settings"
)

// handleHealth is the frontend's one-shot bootstrap surface as well as a
// liveness probe: alongside `status`/`hostname` it carries the optional
// `sshHost` (the SSH destination remote clients use to reach this host) and
// the derived `sshUser` (os/user.Current at startup), which together feed the
// Open button's editor ssh-remote deeplinks: the destination is used verbatim
// when set, else remote clients derive `${sshUser}@${location.hostname}`.
//
// sshHost resolves from the `ssh_host` setting per request (Constitution II —
// derive at request time, so a settings-dialog edit takes effect on the next
// health fetch without restart); that setting is the ONLY source — there is
// no env form. The optional `instanceName` (the display-name override,
// settings `instance_name`) rides alongside. `tunnel` (the daemon's listen
// port — the WebSocket tunnel endpoint's capability signal for the desktop
// shell) is the startup-seeded listenPort: the listener is bound at startup,
// so a mid-run config.yaml `port:` edit takes effect only on the next daemon
// restart and must not move the advertisement away from the bound port. It is
// ALWAYS present as a JSON number; the other optional fields are omitted when
// empty — a new /api/config route for these fields would grow surface against
// Constitution IV.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":   "ok",
		"hostname": s.hostname,
		// The daemon's listen port doubles as the tunnel capability
		// advertisement: the desktop's probe targets the tunnel at this
		// host's own listen port, so the field is always present on this
		// build and its absence marks an older server. Startup-seeded — the
		// bound listener cannot move mid-run.
		"tunnel": s.listenPort,
	}
	stored := settings.Load()
	if stored.SSHHost != "" {
		body["sshHost"] = stored.SSHHost
	}
	if s.sshUser != "" {
		body["sshUser"] = s.sshUser
	}
	if stored.InstanceName != "" {
		body["instanceName"] = stored.InstanceName
	}
	writeJSON(w, http.StatusOK, body)
}
