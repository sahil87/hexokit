package api

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strconv"
	"time"

	"rk/internal/daemon"
	"rk/internal/selfpath"
	"rk/internal/updatecheck"
	"rk/internal/validate"
)

// postRemediationRecheckDelay is how long after a scoped `shll update` spawn the
// handler asks the checker to re-run its fetch+match pass (R17). A brew upgrade
// of a few tools comfortably finishes inside this window, so the consumed match
// propagates as a cleared/changed verdict within minutes instead of waiting for
// the 6h ticker. Single-shot, daemon-context-bound (see Checker.RecheckAfter).
const postRemediationRecheckDelay = 2 * time.Minute

// maxUpdatesCheckBodyBytes bounds the POST /api/updates/check request body
// (mirroring push.go's MaxBytesReader cap). The body is a tiny source selector,
// so 4KB is generous; an oversized body fails the tolerant decode and falls
// back to the released default — no new error path.
const maxUpdatesCheckBodyBytes = 4 * 1024

// resolveSelfPathFn resolves this daemon's own on-disk executable path. Package
// var seam (mirrors cmd/rk/upgrade.go's resolveExeFn) so tests can return a
// synthetic Cellar (or non-Cellar) path without depending on the test binary's
// real location. Default: the shared selfpath.Resolve (os.Executable +
// EvalSymlinks) — the same resolver upgrade.go uses, so brew-install detection
// cannot drift between the two entry points.
var resolveSelfPathFn = selfpath.Resolve

// lookShllFn resolves the `shll` binary on PATH, returning its absolute path.
// Package var seam so handler tests can force shll present/absent without a real
// binary. Default wraps exec.LookPath. When it errors, remediation degrades to
// the run-kit-self `rk update` path (§5) — fail-silent per the toolkit rule.
var lookShllFn = func() (string, error) { return exec.LookPath("shll") }

// daemonRunningFn probes the rk-daemon tmux server. Package var seam so
// handler tests drive the daemon-not-running 409 without a live tmux server.
var daemonRunningFn = daemon.IsRunning

// runJobFn is the spawn seam over daemon.RunJob (260812-z1ya): the update and
// restart handlers run their job in a managed window of the rk-jobs sibling
// session on the rk-daemon socket instead of the removed detached-child spawn. The window survives the daemon restart the job itself triggers
// (Constitution VI), so the spawn is honest — it runs BEFORE the response and
// a failure is a reportable 502, not a logged-after-202. Package var seam so
// handler tests record the window + argv without a live tmux server.
var runJobFn = daemon.RunJob

// daemonRequiredError is the 409 body for update/restart when the rk-daemon
// tmux server is down (intake decision 1: no fallback fork — the managed
// window IS the spawn mechanism).
const daemonRequiredError = "updates require the rk daemon — start it with `rk serve -d`"

// jobWatchPayload is the `watch` key of the update/restart responses: where
// the job window lives, so the client can offer jump-to-window (terminal route
// /$server/$window, window param = the @N id).
type jobWatchPayload struct {
	Server   string `json:"server"`
	Session  string `json:"session"`
	Window   string `json:"window"`
	WindowID string `json:"window_id"`
}

// jobResponse is the response body for a successful update/restart trigger.
type jobResponse struct {
	Status string          `json:"status"`
	Watch  jobWatchPayload `json:"watch"`
}

// runJobAndRespond runs the job through the runJobFn seam and writes the
// response: 202 on a fresh spawn, 200 already-running when a live window
// exists (the second click becomes navigation, intake decision 4), 502 on a
// spawn error. Returns false when it wrote an error response.
func (s *Server) runJobAndRespond(w http.ResponseWriter, r *http.Request, status string, window string, argv []string) bool {
	target, started, err := runJobFn(r.Context(), window, argv)
	if err != nil {
		s.logger.Error("failed to spawn job window", "window", window, "error", err)
		writeError(w, http.StatusBadGateway, "could not start the "+window+" job — "+err.Error())
		return false
	}
	code := http.StatusAccepted
	if !started {
		status = "already-running"
		code = http.StatusOK
	}
	writeJSON(w, code, jobResponse{
		Status: status,
		Watch: jobWatchPayload{
			Server:   target.Server,
			Session:  target.Session,
			Window:   target.Window,
			WindowID: target.WindowID,
		},
	})
	return true
}

// updateRequest is the tolerant body of POST /api/update. An absent body, empty
// body, or `{}` all decode to force=false (the existing client POSTs `{}`, which
// MUST keep working unchanged). `force=true` skips the qualify check.
type updateRequest struct {
	Force bool `json:"force"`
}

// updatesCheckRequest is the tolerant body of POST /api/updates/check
// (mirroring updateRequest's posture): an absent body, empty body, `{}`, or an
// absent/empty `source` key all mean the released default — existing clients
// POSTing `{}` are unchanged. `"source":"github"` requests the GitHub backend;
// any other non-empty value is a 400 (see handleUpdatesCheck).
type updatesCheckRequest struct {
	Source string `json:"source"`
}

// handleUpdate triggers a one-click toolkit upgrade. POST per Constitution IX.
//
// The FIRST gate is daemon liveness: the update runs in a managed `update`
// window of the rk-jobs session on the rk-daemon socket (260812-z1ya), so a
// daemon that isn't running 409s — there is deliberately no detached-spawn
// fallback (intake decision 1).
//
// Remediation then branches on whether `shll` is on PATH:
//
//   - shll PRESENT → a SCOPED toolkit update. Non-force: require a non-empty
//     match set from the in-memory checker — else 409 — then run
//     `shll update <matched tools…>` in the job window (argv from the checker
//     snapshot). Force: skip the match 409 and run a full-roster `shll update`
//     (no tool args). `shll update` normalizes subset order to roster order and
//     preserves run-kit's daemon-restart side effect by delegating to
//     `rk update --skip-brew-update`. There is NO brew-409 on this path — a
//     run-kit-not-brew daemon simply never matches its own row (§2), while
//     sibling tools remain updatable.
//
//   - shll ABSENT → the run-kit-self behavior: (1) require a Homebrew install
//     (Cellar keg) — else 409; (2) unless force, require a qualifying
//     pending update — else 409; (3) run `rk update` (self) in the job window.
//     The brew-409 (which also covers dev builds — a dev binary never lives
//     under a brew Cellar keg) applies ONLY here.
//
// Response shapes: fresh spawn → 202 {"status":"updating","watch":{…}}; a live
// in-flight window → 200 {"status":"already-running","watch":{…}} (the second
// click becomes navigation, not an error); spawn failure → 502.
//
// POST /api/update → 202/200 {"status":...,"watch":{...}} | 409 {"error":...} | 502 {"error":...}
func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	// Tolerant body parse: absent/empty/`{}` ⇒ force=false. A malformed body is
	// treated as force=false rather than erroring — the endpoint's default has
	// always been the non-force path and existing clients POST `{}`.
	force := false
	if r.Body != nil {
		var req updateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			force = req.Force
		}
	}

	// Daemon gate first: the managed job window is the only spawn mechanism.
	if !daemonRunningFn() {
		writeError(w, http.StatusConflict, daemonRequiredError)
		return
	}

	// shll present → scoped toolkit update. The lookup is fail-silent (an error
	// simply routes to the run-kit-self fallback below).
	if shllPath, err := lookShllFn(); err == nil {
		s.handleShllUpdate(w, r, shllPath, force)
		return
	}

	s.handleSelfUpdate(w, r, force)
}

// handleShllUpdate runs a scoped (or full-roster, on force) `shll update` in
// the `update` job window. The match set is read from the checker snapshot; on
// the non-force path an empty match set 409s before spawning (mirroring today's
// qualify-409 gate). After spawning it schedules a ~2min post-remediation
// re-check (R17) so a consumed match clears promptly on the siblings-only path
// (no daemon restart).
//
// `--yes` is mandatory on both paths: the job window has a TTY but no operator,
// so shll's terminal agent-setup refresh would otherwise park the job forever
// at its interactive `Write these changes? [y/N]` consent prompt (rk's own
// non-TTY refusal never fires inside a pane). The append is unconditional — a
// shll predating the flag (shll backlog [3ovi]) hard-errors visibly in the job
// window, which is the accepted trade over the silent hang.
func (s *Server) handleShllUpdate(w http.ResponseWriter, r *http.Request, shllPath string, force bool) {
	args := []string{shllPath, "update", "--yes"}
	if !force {
		var matched []string
		if s.updateChecker != nil {
			for _, m := range s.updateChecker.Snapshot().Matched {
				// Tool names come from the REMOTE shll.ai manifest, so validate each
				// before it reaches `shll update` argv — a name starting with `-` (or
				// carrying whitespace/control chars) could be misread as a flag by
				// shll's arg parser (constitution §I). A rejected name is dropped and
				// logged, not passed through.
				if msg := validate.ValidateToolName(m.Tool); msg != "" {
					s.logger.Warn("dropping invalid manifest tool name from shll update argv", "tool", m.Tool, "reason", msg)
					continue
				}
				matched = append(matched, m.Tool)
			}
		}
		if len(matched) == 0 {
			writeError(w, http.StatusConflict, "no update available")
			return
		}
		args = append(args, matched...)
	}
	// force keeps args == [shll update --yes] — a full-roster sweep with no tool args.

	if !s.runJobAndRespond(w, r, "updating", "update", args) {
		return
	}

	// Schedule a delayed re-check so a consumed match clears within minutes
	// instead of waiting for the 6h ticker (R17). Applies to BOTH scoped paths
	// (non-force scoped + force sweep). When run-kit was in the spawned scope the
	// daemon restarts and this process-local timer dies with it — harmless. The
	// shll-absent `rk update` fallback (handleSelfUpdate) needs no re-check: it
	// always restarts the daemon, which resets state.
	if s.updateChecker != nil {
		s.updateChecker.RecheckAfter(postRemediationRecheckDelay)
	}
}

// handleUpdatesCheck runs one immediate update-check pass inline and returns
// the fresh verdict synchronously so the palette check commands can report
// without waiting on SSE. POST per Constitution IX. The ~1-2s exec latency is
// acceptable for a synchronous response; the checker's exec timeout is the
// bound (API routes must not block unbounded).
//
// The tolerant body selects the check backend (see updatesCheckRequest):
//
//   - released default (absent/empty/`{}` body, absent/empty `source`) — the
//     same code path the 6h ambient loop uses (`shll check-updates` exec +
//     cached verdict update + SSE broadcast via the checker's OnQualify seam).
//   - `"source":"github"` — a SIDE-CHANNEL query against shll's GitHub backend:
//     exec + verdict computation + synchronous response only; the shared cached
//     verdict and the OnQualify/SSE broadcast are deliberately untouched (the
//     github contract has no notify policy, so caching it would wipe a legit
//     released chip and starve the scoped `shll update` argv).
//
// The handler maps the request onto the closed updatecheck.Source* enum —
// nothing user-controlled reaches argv (Constitution I). An unrecognized
// non-empty `source` → 400 (fail-loud; a silent released fallback would mask a
// client bug). The response echoes the report's self-identified `source`.
//
// Failure mapping (the manual check is deliberately fail-LOUD, unlike the
// fail-silent ambient loop): a nil or suppressed checker (dev build) → 409; a
// failed check (shll missing / non-zero exit / unparseable JSON) → 502 with the
// reason, so the client can raise an honest error toast. No in-flight lock —
// mirrors /api/update's no-lock posture (a concurrent pass is idempotent).
//
// POST /api/updates/check → 200 {tools,key,current,latest,source} | 400/409/502 {"error":...}
func (s *Server) handleUpdatesCheck(w http.ResponseWriter, r *http.Request) {
	if s.updateChecker == nil || s.updateChecker.Suppressed() {
		writeError(w, http.StatusConflict, "update checks are disabled for this daemon (dev build)")
		return
	}

	// Tolerant body parse mirroring handleUpdate's: absent/empty/malformed body
	// ⇒ the released default. A successfully-parsed unknown source is a client
	// bug and 400s; only the validated enum value selects the github backend.
	source := updatecheck.SourceReleased
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxUpdatesCheckBodyBytes)
		var req updatesCheckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			switch req.Source {
			case "":
				// released default
			case updatecheck.SourceGithub:
				source = updatecheck.SourceGithub
			default:
				writeError(w, http.StatusBadRequest, "unknown update-check source "+strconv.Quote(req.Source)+" (supported: \"github\")")
				return
			}
		}
	}

	verdict, err := s.updateChecker.CheckNow(r.Context(), source)
	if err != nil {
		writeError(w, http.StatusBadGateway, "update check unavailable — "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, buildUpdateAvailablePayload(verdict))
}

// handleSelfUpdate is the shll-absent fallback — the run-kit-self gates
// verbatim (brew-409, qualify/force 409), then `rk update` (self) in the
// `update` job window.
func (s *Server) handleSelfUpdate(w http.ResponseWriter, r *http.Request, force bool) {
	selfPath, err := resolveSelfPathFn()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not determine executable path")
		return
	}

	if !selfpath.IsBrewInstalled(selfPath) {
		writeError(w, http.StatusConflict,
			"hexokit was not installed via Homebrew — update manually with `rk update` in a shell, or `brew install "+selfpath.BrewFormula+"`")
		return
	}

	if !force && (s.updateChecker == nil || len(s.updateChecker.Snapshot().Matched) == 0) {
		writeError(w, http.StatusConflict, "no update available")
		return
	}

	s.runJobAndRespond(w, r, "updating", "update", []string{selfPath, "update"})
}
