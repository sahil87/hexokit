package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"sync"

	"rk/internal/tmux"
	"rk/internal/validate"
)

// daemonServerName is the tmux server name of the live production daemon
// (mirrors internal/daemon.ServerSocket, kept as a local literal to avoid a
// new import edge for one string — the same trade-off internal/tmux's
// productionDaemonServer makes). Protected by derivation; the protect toggle
// endpoint rejects it.
const daemonServerName = "rk-daemon"

// serverInfo is the per-server response entry from GET /api/servers.
type serverInfo struct {
	Name         string `json:"name"`
	SessionCount int    `json:"sessionCount"`
	// WindowCount is the total window count across this server's sessions
	// (#{session_windows} summed over the sessions parseSessions keeps —
	// group copies are already filtered, so shared windows are not
	// double-counted). Derived from tmux at request time, no cache.
	WindowCount int `json:"windowCount"`
	// Rank is this server's user-defined display rank (@rk_srv_rank).
	// nil (JSON null) when unset or unreadable — the frontend sorts unranked
	// servers after ranked ones. The array's alphabetical order is unchanged
	// (an asserted API contract); rank drives display order client-side only.
	Rank *int `json:"rank"`
	// Ephemeral is true when the server carries the @rk_ephemeral mark (a
	// scratch server the reaper sweeps with `rk mux reap --ephemeral`). Read
	// at request time; a read failure or a server gone mid-walk yields false.
	Ephemeral bool `json:"ephemeral"`
	// Protected is true when the server is kill-guarded: the rk-daemon
	// production server by derivation, or any server carrying the
	// @rk_protected mark. Read at request time; a read failure or a server
	// gone mid-walk yields false.
	Protected bool `json:"protected"`
	// Managed is true when the server is rk-managed: the rk-daemon
	// production server by derivation, or any server carrying the
	// @rk_srv_managed provenance mark (rk-born or adopted). Read at request
	// time; a read failure or a server gone mid-walk yields false.
	Managed bool `json:"managed"`
}

func (s *Server) handleServersList(w http.ResponseWriter, r *http.Request) {
	// Surface EVERY tmux server discovered, including leaked rk-test-*
	// orphans. The test-socket hide filter was deleted: `rk mux reap` is now
	// the sole mechanism that keeps this list clean, so the dev UI shows the
	// operator exactly what the reaper will reap. Accepted cost: a per-orphan
	// state-socket subscription until the operator runs `rk mux reap`.
	names, err := s.tmux.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if len(names) == 0 {
		writeJSON(w, http.StatusOK, []serverInfo{})
		return
	}

	// Fan out ListSessions + ReadServerMarks concurrently — exactly two tmux
	// execs per server (the marks read is one batched show-options dump). A
	// failure for one server yields sessionCount: 0 / windowCount: 0 /
	// rank: null / ephemeral: false / protected: false / managed: false for
	// that entry; no 5xx to the client. The rk-daemon production server's
	// protected and managed flags are DERIVED from its constant socket name
	// (IsGuardedServer/IsManagedServer's short-circuit), so they hold even
	// when the marks read fails. The window count sums #{session_windows}
	// over the sessions ListSessions already returns — no extra subprocess.
	counts := make(map[string]int, len(names))
	windowCounts := make(map[string]int, len(names))
	ranks := make(map[string]*int, len(names))
	ephemeral := make(map[string]bool, len(names))
	protected := make(map[string]bool, len(names))
	managed := make(map[string]bool, len(names))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, name := range names {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			sessions, err := s.tmux.ListSessions(r.Context(), name)
			n, windows := 0, 0
			if err == nil {
				n = len(sessions)
				for _, sess := range sessions {
					windows += sess.Windows
				}
			} else {
				s.logger.Warn("servers: ListSessions failed", "server", name, "err", err)
			}
			marks, merr := s.tmux.ReadServerMarks(r.Context(), name)
			if merr != nil {
				s.logger.Warn("servers: ReadServerMarks failed", "server", name, "err", merr)
				marks = tmux.ServerMarks{}
			}
			mu.Lock()
			counts[name] = n
			windowCounts[name] = windows
			ranks[name] = marks.Rank
			ephemeral[name] = marks.Ephemeral
			protected[name] = marks.Protected || name == daemonServerName
			managed[name] = marks.Managed || name == daemonServerName
			mu.Unlock()
		}(name)
	}
	wg.Wait()

	out := make([]serverInfo, 0, len(names))
	for _, name := range names {
		out = append(out, serverInfo{Name: name, SessionCount: counts[name], WindowCount: windowCounts[name], Rank: ranks[name], Ephemeral: ephemeral[name], Protected: protected[name], Managed: managed[name]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	writeJSON(w, http.StatusOK, out)
}

// legacyFirstGroup is the first group of a workspace created without a folder.
const legacyFirstGroup = "0"

// fallbackFirstGroup names the first group when the folder yields no usable
// name (the home directory itself).
const fallbackFirstGroup = "main"

// handleServerCreate creates a workspace (tmux server) by birthing its first
// group (tmux session). With an optional cwd the group is named after the
// folder and starts there; without one it is the legacy "0" at $HOME.
// POST /api/servers ← {"name": "srv", "cwd": "~/code/x"?} → 201 {"ok": true, "group": "x"}
func (s *Server) handleServerCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		CWD  string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	resolvedCwd, errMsg := resolveWorkingDir(body.CWD)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	group := legacyFirstGroup
	if body.CWD != "" {
		group = validate.SessionNameFromPath(body.CWD)
		if group == "" {
			group = fallbackFirstGroup
		}
	} else {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not determine home directory")
			return
		}
		resolvedCwd = homeDir
	}

	if err := s.tmux.CreateSession(group, resolvedCwd, body.Name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "group": group})
}

// handleServerOrderPost persists the user-defined server display order by
// writing rank i to the i-th listed server, then broadcasts the new order to
// every connected SSE client (server-global — see broadcastServerOrder).
// POST /api/servers/order ← {"order": ["srv-a", "srv-b", ...]} → 200 {"ok": true}
//
// Best-effort per server: one unreachable server logs a warning and is skipped
// — the next full write self-heals. The array itself is validated up front, so
// a malformed body or an invalid server name is a 400 before any tmux write.
func (s *Server) handleServerOrderPost(w http.ResponseWriter, r *http.Request) {
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
	seen := make(map[string]struct{}, len(body.Order))
	for _, name := range body.Order {
		if errMsg := validate.ValidateServerName(name); errMsg != "" {
			writeError(w, http.StatusBadRequest, errMsg)
			return
		}
		if _, dup := seen[name]; dup {
			writeError(w, http.StatusBadRequest, "Duplicate server name in order: "+name)
			return
		}
		seen[name] = struct{}{}
	}

	// Write rank i to the i-th listed server, best-effort. A per-server failure
	// (server killed mid-reorder, momentary timeout) warns and skips — the next
	// full write self-heals — and never fails the whole request (mirrors the
	// no-5xx fan-out stance of handleServersList).
	for i, name := range body.Order {
		if err := s.tmux.SetServerRank(r.Context(), name, i); err != nil {
			s.logger.Warn("servers: SetServerRank failed", "server", name, "rank", i, "err", err)
		}
	}

	// Broadcast the new order to every connected state-socket client
	// (host-global, so even a zero-attached-server Host tab with only a
	// metrics subscription hears it).
	s.initSSEHub()
	s.sseHub.broadcastServerOrder(body.Order)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleServerKill(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Force bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	// Protected servers (rk-daemon by derivation, or @rk_protected) refuse a
	// kill without force — 409 before the kill-notify audit fires, so a
	// refused attempt never records an audited kill. The structured
	// "protected" flag lets clients branch without string-matching.
	guarded, err := s.tmux.IsGuardedServer(r.Context(), body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if guarded && !body.Force {
		// The restart alternative applies only to the daemon; an
		// option-marked server's alternatives are unmark or force.
		msg := body.Name + " is protected (" + tmux.ProtectedOption + "). Unprotect it first, or pass force to kill anyway."
		if body.Name == daemonServerName {
			msg = body.Name + " is protected — it hosts the run-kit daemon. Use Restart (POST /api/restart) instead, or pass force to kill anyway."
		}
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error":     msg,
			"protected": true,
		})
		return
	}

	// Note the audited kill BEFORE it lands so the snapshotter's tombstone
	// (triggered by the socket-removal event) records it as audited even when
	// the removal races this request.
	if s.serverKillNotify != nil {
		s.serverKillNotify(body.Name)
	}

	if err := s.tmux.KillServer(body.Name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleServerProtect sets or clears the @rk_protected mark on a server —
// the mutation endpoint behind the UI Protect/Unprotect toggle.
// POST /api/servers/protect ← {"name": "srv", "protected": true} → 200 {"ok": true}
//
// The rk-daemon production server is rejected with 400: its protection is
// derived from its constant name and is not togglable. The SSE hub is woken
// after the write — user-option mutations emit no control-mode event, so
// without the wake the repaint waits for the safety poll.
func (s *Server) handleServerProtect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		Protected bool   `json:"protected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	if body.Name == daemonServerName {
		writeError(w, http.StatusBadRequest, daemonServerName+" is protected by derivation — its protection is not togglable")
		return
	}

	var err error
	if body.Protected {
		err = s.tmux.MarkServerProtected(r.Context(), body.Name)
	} else {
		err = s.tmux.UnmarkServerProtected(r.Context(), body.Name)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Wake the SSE hub: set-option is invisible to the tmuxctl control-mode
	// parser, so without this the change waits for the safety tick.
	// initSSEHub is idempotent.
	s.initSSEHub()
	s.sseHub.wake(body.Name)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleServerWake wakes the SSE hub's derive tick for one server — the
// mutation-signal endpoint for out-of-process writers (the rk tab CLI) whose
// direct tmux option writes emit no control-mode event and would otherwise
// wait for the safety poll.
// POST /api/servers/wake ← {"name": "srv"} → 200 {"ok": true}
//
// Never touches tmux: a wake for a server with no connected clients is a
// harmless no-op inside the hub, so no existence check is needed.
func (s *Server) handleServerWake(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	s.initSSEHub()
	s.sseHub.wake(body.Name)

	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// adoptMigrateLegacy is the adopt handler's legacy-option sweep seam — tests
// substitute it to prove the sweep runs on a successful adopt without a live
// tmux server.
var adoptMigrateLegacy = tmux.MigrateLegacyOptionsOnce

// handleServerAdopt converts an external (unmarked) server to rk-managed: the
// @rk_srv_managed stamp lands first, then the managed conf is sourced via
// ReloadConfig; a failed reload best-effort unmarks, so a stamped server whose
// conf never applied is never left behind.
// POST /api/servers/adopt ← {"name": "srv"} → 200 {"status":"ok"}
//
// Adopt is idempotent by contract (the CLI's bulk-migration role needs it): an
// already-managed target — including rk-daemon by derivation — returns
// 200 {"status":"already-managed"} with no tmux mutation (deliberately unlike
// protect's 400 for the daemon). Adopt never auto-assigns a server color, and
// no un-adopt verb exists. The SSE hub is woken on success (the
// protect-endpoint precedent: user-option mutations emit no control-mode
// event).
func (s *Server) handleServerAdopt(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if errMsg := validate.ValidateServerName(body.Name); errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	managed, err := s.tmux.IsManagedServer(r.Context(), body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if managed {
		writeJSON(w, http.StatusOK, map[string]string{"status": "already-managed"})
		return
	}

	if err := s.tmux.MarkServerManaged(r.Context(), body.Name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.tmux.ReloadConfig(body.Name); err != nil {
		// Best-effort rollback: a stamped server whose conf never applied is
		// never left behind. Fresh context, not r.Context() — a canceled or
		// deadline-exhausted request must not abort the unmark (the CLI
		// adopt's fresh-bound rollback pattern); the tmux layer applies its
		// own TmuxTimeout.
		_ = s.tmux.UnmarkServerManaged(context.Background(), body.Name)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Legacy-option sweep after the conf lands — adoption is the explicit
	// retry path for a server whose attach-time sweep never ran. Best-effort:
	// a sweep failure never fails the adopt.
	if _, err := adoptMigrateLegacy(r.Context(), body.Name); err != nil {
		slog.Warn("legacy option sweep failed (best-effort)", "err", err, "server", body.Name)
	}

	// Wake the SSE hub: set-option and source-file are invisible to the
	// tmuxctl control-mode parser, so without this the change waits for the
	// safety tick. initSSEHub is idempotent.
	s.initSSEHub()
	s.sseHub.wake(body.Name)

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
