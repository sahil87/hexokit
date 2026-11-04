package api

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"rk/internal/sessions"
	"rk/internal/tmux"
	"rk/internal/validate"
)

// Terminals socket — `/ws/terminals` (change 260717-803u-relay-mux).
//
// One WebSocket per browser tab carries ALL pane relay streams that previously
// rode per-pane `/relay/{windowId}` connections (the retired handleRelay). A
// board with N panes therefore holds ONE terminals socket instead of N, giving
// one reconnect path and one upgrade handshake instead of N (connection
// hygiene — see docs/findings/socket-pool-accounting.md; the user-facing pool
// fix rode change 1's state socket).
//
// Wire protocol (lifted verbatim from fab/plans/sahil/26-07-16-socket-unification.md
// §Terminal socket):
//
//   - Binary data frames `[u32 BE streamId][payload]` in both directions —
//     server→client PTY output, client→server keystrokes.
//   - JSON text frames for control:
//       client → server: {"op":"open","id":7,"server":..,"windowId":"@42","cols":120,"rows":32,"isolate":true}
//                        {"op":"resize","id":7,"cols":100,"rows":40}
//                        {"op":"close","id":7}
//       server → client: {"op":"opened","id":7}
//                        {"op":"closed","id":7,"code":4004|4001|1000,"reason":..}
//
// Per-stream behavior preserves handleRelay (relay.go): window-ID validation via
// the shared validate.ValidateWindowID (the same validator decodeWindowID wraps —
// REST and mux entry points cannot drift; constitution §I), then session
// resolution → session-scoped SelectWindowInSession → forceTERM →
// pty.StartWithSize at the open op's cols/rows (the managed-only conf reload is
// once-per-server and fully async — never a subprocess on this path). Session
// resolution picks pin → iso → home: the window's `_rk-pin-*` pin-session when
// it exists (a pinned window is linked into both its pin-session and its home
// session, and attaching to the pin-session leaves home's active-window pointer
// untouched); else, when the open op carries `isolate: true`, the window's
// `_rk-iso-*` session via EnsureIsoSession (the same independent-pointer effect,
// on demand — a borrowed or popped-out tile never fights home's pointer); else
// the home session via ResolveWindowSession (5s). The iso attach chains
// `destroy-unattached on` onto its own argv (setting it at creation would
// destroy the never-attached session immediately), so tmux reaps the iso
// session when its last client leaves. A stream-level failure (bad window,
// attach failure, ensure failure) emits a `closed` control event — the SOCKET
// itself never closes for a single stream's failure (today's 4004/4001 WS close
// codes become per-stream `closed` events).
//
// Write path (decision D3, a v1 protocol requirement — NOT an optimization):
// per-stream bounded send queues drained by a SINGLE writer goroutine that
// schedules control/short frames ahead of bulk output and round-robins across
// ready streams (never FIFO across streams). A shared FIFO gives 1.66s
// interactive echo p50 under a co-stream flood; per-stream queues + this
// scheduler give 32ms at identical goodput (docs/findings/relay-mux-hol.md). A
// full per-stream queue PAUSES that stream's PTY reader (backpressure into
// tmux's per-client buffering — the same mechanism a stalled per-pane TCP
// socket exerts today), NEVER dropping bytes (dropping mid-stream corrupts VT
// state).

const (
	// streamQueueDepth is the per-stream bounded send-queue depth. Combined with
	// streamFrameSize (the PTY read chunk) this bounds each stream's in-flight
	// backlog to streamQueueDepth×streamFrameSize (8×4096B) — spike-measured to
	// hold interactive echo RTT to ~1-2 in-flight frames under a co-stream flood.
	streamQueueDepth = 8
	// streamFrameSize is the PTY read chunk (matches relay.go's 4096B read
	// buffer, which the per-stream producer replaces).
	streamFrameSize = 4096
	// shortFrameMax classifies a frame as "short/interactive" for scheduling
	// priority. A keystroke echo is a handful of bytes; a redraw or a program's
	// burst output fills a full streamFrameSize chunk. Short frames are drained
	// ahead of bulk so an echo never queues behind another stream's flood.
	shortFrameMax = 256

	// terminalsWriteWait bounds a single WebSocket write. A stuck client must not
	// block the writer pump forever (mirrors state_ws.go's stateWSWriteWait).
	terminalsWriteWait = 10 * time.Second
	// terminalsCleanupWait is the short read deadline set on the connection when
	// a write fails, so the read loop's blocked conn.ReadMessage() returns
	// promptly and runs teardown (mirrors relay.go / state_ws.go).
	terminalsCleanupWait = 100 * time.Millisecond
	// resolveTimeout bounds ResolveWindowSession per stream open (matches
	// relay.go's 5s resolve context).
	resolveTimeout = 5 * time.Second
	// terminalsReadLimit caps a single inbound WebSocket message. ReadMessage()
	// buffers the whole frame in memory, so an unbounded limit lets a malicious
	// (or accidental) giant input/paste frame drive unbounded allocation — a
	// memory-DoS. 4 MiB comfortably holds a large clipboard paste (the only
	// legitimately large client frame — control ops are tiny and PTY chunks are
	// server→client) while capping any single allocation. A client that exceeds
	// it trips gorilla's ErrReadLimit, which surfaces as a read error and tears
	// down that socket (the other tabs' sockets are unaffected).
	terminalsReadLimit = 4 << 20 // 4 MiB
)

// terminalsLivenessTimeout is the inbound-silence deadline on a terminals
// socket. The client heartbeats {op:"ping"} every 30s (relay-mux.ts
// HEARTBEAT_INTERVAL_MS) while it has live streams and gives up on a silent
// server after 60s (LIVENESS_TIMEOUT_MS); 90s is three missed heartbeats and
// strictly longer than the client's own give-up, so a live client always
// disconnects itself first and this deadline only ever fires on a peer that
// has stopped running JS (a frozen phone tab, a proxy-kept TCP peer). Expiry
// surfaces as a ReadMessage error → teardown → every stream's attach client
// is killed and reaped, releasing its sized tmux client — without it a ghost
// client clamps every co-viewer's window width (window-size smallest) for as
// long as the kernel or a reverse proxy keeps the TCP peer alive. A var, not a
// const, so in-package tests can shorten it.
var terminalsLivenessTimeout = 90 * time.Second

// Stream-level close codes — mirror the WS close codes handleRelay used, now
// carried as per-stream `closed` control events (the socket stays open).
const (
	closeWindowNotFound = 4004 // ResolveWindowSession / SelectWindowInSession failed
	closeAttachFailed   = 4001 // pty.StartWithSize failed
	closeNormal         = 1000 // graceful client close op / PTY EOF
)

// openOp / resizeOp / closeOp are the client → server control frames.
type openOp struct {
	Op       string `json:"op"`
	ID       uint32 `json:"id"`
	Server   string `json:"server"`
	WindowID string `json:"windowId"`
	Cols     uint16 `json:"cols"`
	Rows     uint16 `json:"rows"`
	// Isolate requests an attach through the window's own single-window
	// `_rk-iso-*` session instead of its home session, giving the stream an
	// active-window pointer independent of home's (a borrowed or popped-out
	// tile must not fight the home tab's window). Absent ⇒ false (back-compat:
	// a non-isolated open behaves exactly as before). Ignored for a pinned
	// window — its pin-session already isolates.
	Isolate bool `json:"isolate,omitempty"`
}

// controlIn is the shape read from every JSON control frame to discriminate the
// op before unmarshalling into the specific op struct. `id`/`cols`/`rows` are
// shared across resize/close so one decode covers them; `isolate` rides the
// open op (an open is rebuilt from this decode field-by-field, so a field added
// to openOp must be added here too or it is silently dropped).
type controlIn struct {
	Op       string `json:"op"`
	ID       uint32 `json:"id"`
	Server   string `json:"server"`
	WindowID string `json:"windowId"`
	Cols     uint16 `json:"cols"`
	Rows     uint16 `json:"rows"`
	Isolate  bool   `json:"isolate,omitempty"`
}

// openedFrame / closedFrame are the server → client control frames.
type openedFrame struct {
	Op string `json:"op"` // "opened"
	ID uint32 `json:"id"`
}

type closedFrame struct {
	Op     string `json:"op"` // "closed"
	ID     uint32 `json:"id"`
	Code   int    `json:"code"`
	Reason string `json:"reason"`
}

// outFrame is a unit queued for the single writer. `control` (a pre-marshalled
// JSON text frame) rides the priority tier; `data` (a binary payload, already
// prefixed with the u32 BE stream id) is bulk unless len ≤ shortFrameMax.
type outFrame struct {
	control []byte // non-nil ⇒ a JSON text control frame (always priority)
	data    []byte // non-nil ⇒ a binary data frame (already stream-id-prefixed)
}

func (f outFrame) isText() bool { return f.control != nil }
func (f outFrame) short() bool  { return f.control != nil || len(f.data) <= 4+shortFrameMax }

// stream is one muxed pane relay. It owns the attach process + PTY and a bounded
// send queue drained by the connection's single writer.
//
// The queue is created at REGISTRATION time (before the async attach runs), so
// the `opened` control frame can be enqueued onto the stream's OWN queue ahead
// of any data frame — channel FIFO + the scheduler's short-frame priority then
// guarantees the client sees `opened` before the first PTY byte (fixing the
// data-before-opened race that wiped the client's deferred reset). A stream is a
// PLACEHOLDER (ptmx/cancel/cmd nil) between registration and a successful
// attach; a failed attach removes it before it ever produces data.
type stream struct {
	id    uint32
	queue chan outFrame // bounded (streamQueueDepth); full ⇒ PTY reader pauses

	ptmx    *os.File
	cancel  context.CancelFunc
	cmd     *exec.Cmd
	cleanup sync.Once
	closed  chan struct{} // closed by teardown; the PTY reader selects on it
	// unregister removes the attach's pid from the Server's attach registry.
	// Set at publish alongside cmd; nil on a placeholder, the control
	// pseudo-stream, or a failed attach — teardown's call is a no-op then.
	unregister func()
}

// attachRegistry maps the pid of each relay-forked attach process to the facts
// its conn knows (peer, device, live lastInbound). It is NOT a state store
// (Constitution §II): it annotates only pids `tmux list-clients` already
// reported, describing processes the daemon itself forked and dying with them
// — a daemon restart empties it and kills every attach anyway (each is a child
// PTY of the daemon). All methods are nil-receiver safe so a zero-value Server
// (tests) needs no registry.
type attachRegistry struct {
	mu    sync.Mutex
	byPID map[int]sessions.AttachMeta
}

func (r *attachRegistry) register(pid int, m sessions.AttachMeta) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.byPID[pid] = m
	r.mu.Unlock()
}

func (r *attachRegistry) unregister(pid int) {
	if r == nil {
		return
	}
	r.mu.Lock()
	delete(r.byPID, pid)
	r.mu.Unlock()
}

// Lookup answers the sessions.AttachResolver question; a nil registry resolves
// nothing (every viewer stays kind "tty").
func (r *attachRegistry) Lookup(pid int) (sessions.AttachMeta, bool) {
	if r == nil {
		return sessions.AttachMeta{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	m, ok := r.byPID[pid]
	return m, ok
}

// snapshot returns a read-only copy of the registry for tests.
func (r *attachRegistry) snapshot() map[int]sessions.AttachMeta {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[int]sessions.AttachMeta, len(r.byPID))
	for pid, m := range r.byPID {
		out[pid] = m
	}
	return out
}

// terminalsConn is the per-socket state: the stream registry + the writer's
// ready set. All mutation of `streams` and the scheduler's ready set is guarded
// by mu; the writer goroutine is the sole reader of the queues.
type terminalsConn struct {
	conn *websocket.Conn
	s    *Server

	mu      sync.Mutex
	streams map[uint32]*stream

	// wake signals the writer that a queue transitioned non-empty (a producer
	// enqueued) so it can re-scan without busy-looping. Buffered depth 1 —
	// coalesces bursts into one wake.
	wake chan struct{}

	// writeFrame is the injectable write seam. Production writes to the socket;
	// the HOL unit test substitutes a paced writer. Returns an error to stop the
	// writer (dead socket).
	writeFrame func(f outFrame) error

	// writerDead is set by runWriter before it arms the short cleanup read
	// deadline, so the read loop can tell that deadline's expiry from the
	// liveness deadline's — both surface as the same net.Error timeout.
	writerDead atomic.Bool

	// Per-connection identity facts, captured once at upgrade. Display-only —
	// see peerFromRequest for the trust boundary.
	peer        string
	device      string
	connectedAt time.Time
	// lastInbound is the unix-second time of the last inbound frame, stored
	// where the liveness deadline is re-armed; the attach registry reads it
	// through a closure so viewer idle is never a copied stale value.
	lastInbound atomic.Int64

	done chan struct{} // closed on socket teardown; stops the writer + producers
}

// peerFromRequest derives the display peer for a terminals connection: the
// first comma-separated hop of X-Forwarded-For when present, else the host
// half of RemoteAddr (the raw value when it carries no port). X-Forwarded-For
// is trusted for DISPLAY ONLY — it is client-controlled and never feeds an
// authorization decision.
func peerFromRequest(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// deviceClass classifies a User-Agent into the closed set phone / tablet /
// desktop / desktop-shell / unknown. Order matters: Electron/ first (the
// desktop shell does not override Electron's default UA), then tablet, then
// phone, then desktop. Known limitation: iPadOS Safari sends a Macintosh UA by
// default, so a default-settings iPad classifies as desktop.
func deviceClass(ua string) string {
	switch {
	case ua == "":
		return "unknown"
	case strings.Contains(ua, "Electron/"):
		return "desktop-shell"
	case strings.Contains(ua, "iPad") ||
		(strings.Contains(ua, "Android") && !strings.Contains(ua, "Mobile")) ||
		strings.Contains(ua, "Tablet"):
		return "tablet"
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPod") || strings.Contains(ua, "Mobi"):
		return "phone"
	default:
		return "desktop"
	}
}

// streamCount returns the number of registered pane streams, excluding the
// reserved control pseudo-stream (registered lazily by the first pong or
// failed-open `closed`, so it would otherwise inflate the count by one).
func (tc *terminalsConn) streamCount() int {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	n := len(tc.streams)
	if _, ok := tc.streams[controlStreamID]; ok {
		n--
	}
	return n
}

// handleTerminalsWS upgrades a `/ws/terminals` request and runs the mux: a read
// loop dispatching binary data frames + JSON control ops while a single writer
// goroutine schedules all streams' output onto the socket.
func (s *Server) handleTerminalsWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("terminals ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	// Own lifecycle context rooted at Background — NOT r.Context(): after the WS
	// upgrade the connection is hijacked and some servers cancel the request
	// context, which would kill the writer immediately (same rationale as
	// state_ws.go). The read loop's error drives teardown.
	tc := &terminalsConn{
		conn:    conn,
		s:       s,
		streams: map[uint32]*stream{},
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
		// Identity facts derived once from the upgrade request (display-only).
		peer:        peerFromRequest(r),
		device:      deviceClass(r.UserAgent()),
		connectedAt: time.Now(),
	}
	tc.writeFrame = func(f outFrame) error {
		conn.SetWriteDeadline(time.Now().Add(terminalsWriteWait))
		if f.isText() {
			return conn.WriteMessage(websocket.TextMessage, f.control)
		}
		return conn.WriteMessage(websocket.BinaryMessage, f.data)
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		tc.runWriter()
	}()

	// Read loop: dispatch until the socket closes. On exit, tear down all
	// streams and stop the writer. Bound each inbound message so an oversized
	// input/paste frame can't drive unbounded allocation (memory-DoS).
	conn.SetReadLimit(terminalsReadLimit)
	// Liveness: any inbound frame — data, control op, ping — re-arms the
	// deadline. A peer that stops running JS (frozen tab) stops heartbeating,
	// the deadline expires, and the read error below runs teardown.
	conn.SetReadDeadline(time.Now().Add(terminalsLivenessTimeout))
	for {
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() && !tc.writerDead.Load() {
				slog.Info("terminals: liveness deadline expired; tearing down",
					"streams", tc.streamCount(), "peer", tc.peer, "device", tc.device)
			}
			break
		}
		conn.SetReadDeadline(time.Now().Add(terminalsLivenessTimeout))
		tc.lastInbound.Store(time.Now().Unix())
		// The writer may have died between ReadMessage returning and the
		// re-arm above, in which case its short cleanup deadline was just
		// overwritten. writerDead is stored BEFORE the writer arms its
		// deadline, so a false here means the writer's arm is still ahead
		// and will win; a true means it may have lost — re-arm cleanup.
		if tc.writerDead.Load() {
			conn.SetReadDeadline(time.Now().Add(terminalsCleanupWait))
		}
		if msgType == websocket.BinaryMessage {
			tc.handleDataFrame(msg)
			continue
		}
		// Text frame — a JSON control op.
		var ctl controlIn
		if json.Unmarshal(msg, &ctl) != nil {
			continue // ignore malformed control frames rather than tearing down
		}
		switch ctl.Op {
		case "open":
			tc.startStream(openOp{
				Op:       ctl.Op,
				ID:       ctl.ID,
				Server:   ctl.Server,
				WindowID: ctl.WindowID,
				Cols:     ctl.Cols,
				Rows:     ctl.Rows,
				Isolate:  ctl.Isolate,
			})
		case "resize":
			tc.resizeStream(ctl.ID, ctl.Cols, ctl.Rows)
		case "close":
			tc.closeStream(ctl.ID, closeNormal, "closed")
		case "ping":
			// Client liveness probe (change 260723-rma2): an app-level ping/pong
			// control op carrying NO stream id. Reply {op:"pong"} through the
			// reserved control pseudo-stream so the single writer performs the
			// write (gorilla forbids concurrent writes) with short-frame priority.
			if b, e := json.Marshal(pongFrame{Op: "pong"}); e == nil {
				tc.enqueueControl(b)
			}
		default:
			// Unknown op — ignore (forward-compat; the socket stays live).
		}
	}

	tc.teardown()
	<-writerDone
}

// handleDataFrame routes a binary `[u32 BE streamId][payload]` client frame to
// the addressed stream's PTY. Frames for unknown/closed streams are dropped
// (the stream may have closed between the client's send and this read).
func (tc *terminalsConn) handleDataFrame(msg []byte) {
	if len(msg) < 4 {
		return
	}
	id := binary.BigEndian.Uint32(msg[:4])
	tc.mu.Lock()
	st := tc.streams[id]
	var ptmx *os.File
	if st != nil {
		ptmx = st.ptmx // read under the lock (attachStream publishes it under the lock)
	}
	tc.mu.Unlock()
	// A nil ptmx is a PLACEHOLDER stream still attaching — drop the keystroke
	// (the PTY isn't ready; the client re-sends interactively).
	if ptmx == nil {
		return
	}
	// Writes to the PTY are keystroke-sized and non-blocking in practice; a
	// write error means the PTY died — the reader goroutine will observe EOF and
	// tear the stream down, so drop here rather than blocking the read loop.
	_, _ = ptmx.Write(msg[4:])
}

// startStream reproduces handleRelay's per-connection setup, per stream. It runs
// on the socket READ LOOP but does only cheap, synchronous work there — validate
// + register a placeholder stream under tc.mu — then dispatches the blocking
// tmux work (resolve ≤5s, session-scoped select, managed-only pre-attach
// reload, PTY
// attach) to a goroutine so it never serializes behind other panes' keystrokes
// or opens (S2). The placeholder registration makes duplicate-id checks and
// racing resize/close ops deterministic: a resize/close arriving before the
// attach finishes finds the (placeholder) stream and is handled correctly.
//
// A stream-level failure emits a `closed` control event WITHOUT closing the
// socket. On success it enqueues `opened` onto the stream's OWN queue (ahead of
// any data — M2) and starts the per-stream PTY reader as the send-queue producer.
func (tc *terminalsConn) startStream(op openOp) {
	// Validate the (already JSON-decoded) window ID through the same validator
	// decodeWindowID wraps, so the REST and mux entry points cannot drift
	// (constitution §I — Security First; validate before any tmux interaction).
	if validate.ValidateWindowID(op.WindowID, "Window ID") != "" {
		tc.emitClosed(op.ID, closeWindowNotFound, "Window not found")
		return
	}

	// Register a placeholder stream synchronously under the lock BEFORE the
	// blocking attach. This is what keeps duplicate-id / racing resize / racing
	// close deterministic (S2): a later op for this id finds the placeholder.
	// A duplicate id for a still-live stream is ignored (client bug); the client
	// allocates unique ids per connection.
	tc.mu.Lock()
	if _, exists := tc.streams[op.ID]; exists {
		tc.mu.Unlock()
		return
	}
	select {
	case <-tc.done:
		tc.mu.Unlock()
		return
	default:
	}
	st := &stream{
		id:     op.ID,
		queue:  make(chan outFrame, streamQueueDepth),
		closed: make(chan struct{}),
	}
	tc.streams[op.ID] = st
	tc.mu.Unlock()

	go tc.attachStream(op, st)
}

// forceTERM returns a copy of env with TERM set to xterm-256color, replacing
// any inherited value. A relay PTY is always an xterm-256color terminal
// (xterm.js), and tmux matches terminal-overrides against this value to enable
// true-color (RGB/Tc).
func forceTERM(env []string) []string {
	result := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, "TERM=") {
			result = append(result, e)
		}
	}
	return append(result, "TERM=xterm-256color")
}

// attachIsManaged / attachReloadConfig / attachMigrateLegacy are the
// pre-attach reload seams — tests substitute them to pin the managed-only
// gate without a live server. attachMigrateLegacy is the NON-re-marking
// entry: the sweep once-guard is taken inside the reload goroutine, so the
// seam must not mark again.
var (
	attachIsManaged     = tmux.IsManagedServer
	attachReloadConfig  = tmux.ReloadConfig
	attachMigrateLegacy = tmux.MigrateLegacyOptionsReport
)

// reloadConfigForAttach reloads the managed tmux.conf on the target server —
// at most once per server per daemon lifetime, and entirely off the attach
// path (the switch mask lifts on the first PTY byte, so this function must
// never cost the attach goroutine a subprocess). Managed servers only: an
// external (unmarked) server never receives rk's conf; a managed-check read
// failure fails closed (skip) and releases the once-guard so a later attach
// retries. Never fails — a reload error only means attaches proceed with the
// server's current conf. Servers rk creates get the conf at birth via `-f`,
// and the daemon-start RefreshSweep propagates a stale conf to live servers,
// so repeating the reload per attach bought nothing but forks.
//
// The per-server guard is taken synchronously (LoadOrStore) so concurrent
// attaches spawn at most one goroutine per server; that single-goroutine
// guarantee is also what lets the legacy-sweep once-guard move inside the
// goroutine, where — as before — it is consumed only after the managed gate
// passes (a transient check failure leaves both guards retryable). The seams
// are captured before the spawn so a test restoring them never races an
// in-flight goroutine. When the sweep changed something the SSE hub is woken
// so the sidebar repaints without waiting for the safety poll (set-option is
// invisible to the control-mode parser).
func (s *Server) reloadConfigForAttach(server string) {
	if _, loaded := s.attachReloaded.LoadOrStore(server, struct{}{}); loaded {
		return
	}
	isManaged, reload, migrate := attachIsManaged, attachReloadConfig, attachMigrateLegacy
	go func() {
		managed, err := isManaged(context.Background(), server)
		if err != nil {
			slog.Debug("terminals: managed check failed; skipping pre-attach reload", "server", server, "err", err)
			s.attachReloaded.Delete(server)
			return
		}
		if !managed {
			slog.Debug("terminals: external server; skipping pre-attach reload", "server", server)
			return
		}
		if err := reload(server); err != nil {
			slog.Debug("terminals: config reload before attach (best-effort)", "server", server, "err", err)
		}
		if !tmux.MarkLegacyMigrationAttempt(server) {
			return
		}
		changed, err := migrate(context.Background(), server)
		if err != nil {
			slog.Warn("terminals: legacy option sweep failed (best-effort)", "server", server, "err", err)
		}
		if changed {
			s.initSSEHub()
			s.sseHub.wake(server)
		}
	}()
}

// attachStream performs the blocking tmux setup for a registered placeholder
// stream off the read loop (S2). On failure it removes the placeholder and emits
// a `closed` control event (a failed open produced no data, so its `closed` on
// the control pseudo-stream has no ordering concern). On success it fills in the
// stream's ptmx/cancel/cmd, enqueues `opened` onto the stream's OWN queue (so it
// precedes every data frame — M2), and starts the PTY reader.
func (tc *terminalsConn) attachStream(op openOp, st *stream) {
	server := serverFromRequestValue(op.Server)

	// Abandon the attach if the stream was closed (client close / socket
	// teardown) while we were dispatched but before we started.
	failClosed := func(code int, reason string) {
		tc.mu.Lock()
		if tc.streams[op.ID] == st {
			delete(tc.streams, op.ID)
		}
		tc.mu.Unlock()
		st.teardown()
		tc.emitClosed(op.ID, code, reason)
	}
	stillLive := func() bool {
		select {
		case <-st.closed:
			return false
		case <-tc.done:
			return false
		default:
			return true
		}
	}

	// Resolve the session to attach to, in pick order pin → iso → home. A
	// board-pinned window is a member of BOTH its home session AND its
	// single-window `_rk-pin-*` pin-session (Pin uses link-window). Prefer the
	// pin-session when it exists: its sole window is permanently active, so
	// attaching there gives this stream an independent current-window pointer
	// and — crucially — merely VIEWING a pinned window (board pane or direct
	// URL) never moves the home session's active-window pointer. A pinned
	// window already isolates, so `isolate` never creates an iso session for
	// it. Otherwise, an `isolate: true` open ensures the window's `_rk-iso-*`
	// session and attaches there (same independent-pointer effect, on demand);
	// an ensure failure is a per-stream `closed` (4004 when the window is
	// missing, 4001 otherwise) — the socket stays up. Every other open
	// resolves the home session and attaches there as before. A missing window
	// (resolve fails / empty) is a per-stream 4004.
	resolveCtx, resolveCancel := context.WithTimeout(context.Background(), resolveTimeout)
	var session string
	var iso bool
	if pinSession, ok := tmux.PinSessionName(op.WindowID); ok && tc.s.tmux.HasSession(resolveCtx, server, pinSession) {
		session = pinSession
	} else if op.Isolate {
		ensured, err := tc.s.tmux.EnsureIsoSession(resolveCtx, server, op.WindowID)
		if err != nil {
			resolveCancel()
			if !stillLive() {
				failClosed(closeNormal, "closed")
				return
			}
			// EnsureIsoSession maps a missing window to ResolveWindowSession's
			// `window %q not found` contract; every other ensure failure is an
			// attach-class failure.
			if strings.Contains(err.Error(), "not found") {
				slog.Warn("terminals: window not found", "windowID", op.WindowID, "err", err)
				failClosed(closeWindowNotFound, "Window not found")
			} else {
				slog.Error("terminals: iso ensure failed", "windowID", op.WindowID, "err", err)
				failClosed(closeAttachFailed, "Failed to create isolated session")
			}
			return
		}
		session = ensured
		iso = true
	} else {
		resolved, err := tc.s.tmux.ResolveWindowSession(resolveCtx, server, op.WindowID)
		if err != nil || resolved == "" {
			resolveCancel()
			if !stillLive() {
				failClosed(closeNormal, "closed")
				return
			}
			slog.Warn("terminals: window not found", "windowID", op.WindowID, "err", err)
			failClosed(closeWindowNotFound, "Window not found")
			return
		}
		session = resolved
	}
	resolveCancel()
	if !stillLive() {
		if iso {
			tc.rollbackIsoAttach(server, session)
		}
		failClosed(closeNormal, "closed")
		return
	}

	// Select the window on the resolved session so the attach renders the right
	// window. Scope the select to the resolved session — a bare window-id target
	// is ambiguous inside a tmux session group and must agree with the
	// attach-session below (the group-ambiguity rationale at relay.go:88-99). For a
	// pin-session the select is effectively a no-op (its sole window is already
	// active), but scoping keeps the code path uniform.
	if err := tc.s.tmux.SelectWindowInSession(session, op.WindowID, server); err != nil {
		slog.Error("terminals: select-window failed", "err", err, "session", session, "windowID", op.WindowID)
		if iso {
			tc.rollbackIsoAttach(server, session)
		}
		failClosed(closeWindowNotFound, "Window not found")
		return
	}

	// Initial size rides the open op (replacing relay.go's wait-for-first-resize
	// dance). Fall back to 80x24 if the client sent zeros.
	initialSize := pty.Winsize{Cols: 80, Rows: 24}
	if op.Cols > 0 && op.Rows > 0 {
		initialSize.Cols = op.Cols
		initialSize.Rows = op.Rows
	}

	ctx, cancel := context.WithCancel(context.Background())
	// Pre-attach reload so terminal-overrides (true color) and styles are live
	// on this server. Managed servers only — rk never pushes its conf onto an
	// external server. Once per server, fully async: never a subprocess on the
	// attach path (the switch mask sits on this goroutine's latency).
	tc.s.reloadConfigForAttach(server)

	cmd := exec.CommandContext(ctx, "tmux", attachArgv(server, session, iso)...)
	cmd.Env = forceTERM(os.Environ())

	ptmx, err := pty.StartWithSize(cmd, &initialSize)
	if err != nil {
		cancel()
		slog.Error("terminals: pty start failed", "err", err, "session", session, "windowID", op.WindowID)
		if iso {
			tc.rollbackIsoAttach(server, session)
		}
		failClosed(closeAttachFailed, "Failed to attach to tmux session")
		return
	}

	// Publish the attach into the placeholder under the lock. If the stream was
	// closed/torn down while attaching, clean up the just-started attach instead
	// of leaving an orphan (mirrors the old socket-torn-down guard).
	tc.mu.Lock()
	if tc.streams[op.ID] != st {
		// The cmd was never published into the stream (st.cmd is still nil), so
		// teardown cannot reap it — this branch is the fork's sole owner.
		tc.mu.Unlock()
		cancel()
		ptmx.Close()
		killAndReapAttach(cmd)
		return
	}
	st.ptmx = ptmx
	st.cancel = cancel
	st.cmd = cmd
	// Register immediately at publish, while the publication lock is still
	// held: teardown invokes st.unregister BEFORE killAndReapAttach, and both
	// must stay ordered against this registration so a torn-down attach can
	// never leave a stale registry entry (nor a reused pid briefly alias the
	// dead attach). The publish-race branch above never registers (its cmd is
	// reaped there directly).
	pid := cmd.Process.Pid
	st.unregister = func() { tc.s.attachRegistry.unregister(pid) }
	tc.s.attachRegistry.register(pid, sessions.AttachMeta{
		Peer:        tc.peer,
		Device:      tc.device,
		ConnectedAt: tc.connectedAt,
		LastInbound: tc.lastInbound.Load,
	})
	tc.mu.Unlock()

	// Enqueue `opened` onto the stream's OWN queue BEFORE starting the PTY reader.
	// Channel FIFO + the scheduler's short-frame priority guarantees the client
	// sees `opened` before the first data frame (M2). Best-effort: if the stream
	// closed between the publish and here, teardown handles it.
	select {
	case st.queue <- outFrame{control: mustMarshalOpened(op.ID)}:
		tc.signalWake()
	case <-st.closed:
		return
	case <-tc.done:
		return
	}

	// Per-stream PTY reader = the send-queue producer. A full queue blocks this
	// goroutine on the channel send (backpressure — the PTY reader pauses,
	// pushing the stall into tmux's per-client buffering), never dropping bytes.
	go tc.pumpPTY(st)
}

// attachArgv composes the tmux attach argv for a stream: server selection and
// the managed conf exactly as a non-isolated attach has always used, then
// `attach-session -t <session>`. An iso attach chains the lifecycle option onto
// the SAME invocation — `; set-option -t <iso> destroy-unattached on` as
// discrete argv elements (Constitution I: no shell strings; the ";" is its own
// element). Setting destroy-unattached on a never-attached session destroys it
// immediately (tmux 3.7c probe), so it can only be set by an attach as it
// connects; tmux then reaps the iso session when its last client leaves —
// stream close, socket teardown, or daemon crash — with no rk bookkeeping. The
// set-option target is the bare session name (tmux rejects the `=name` exact
// form here); the name derives from a validated window id, so it carries no
// glob/injection surface. Pure for testability.
func attachArgv(server, session string, iso bool) []string {
	var args []string
	if server != "default" {
		args = []string{"-L", server}
	}
	if confPath := tmux.ConfigPath(); confPath != "" {
		args = append(args, "-f", confPath)
	}
	args = append(args, "attach-session", "-t", session)
	if iso {
		args = append(args, ";", "set-option", "-t", session, "destroy-unattached", "on")
	}
	return args
}

// rollbackIsoAttach kills a just-ensured iso session when the attach path
// fails before the attach argv runs — destroy-unattached was never chained, so
// the session would otherwise leak. Every pre-attach exit after a successful
// ensure (stream closed mid-attach, select-window failure, PTY start failure)
// routes here. The kill is conditional on ZERO attached clients: another
// isolated viewer may share the session, and it must never be killed out from
// under a live stream. The kill is rooted in context.Background() — the
// failing stream's deadlines must not no-op the teardown (Pin's rollback
// pattern). A probe or kill failure only logs: the next ensure for the window
// reuses the stranded session.
func (tc *terminalsConn) rollbackIsoAttach(server, isoSession string) {
	probeCtx, probeCancel := context.WithTimeout(context.Background(), resolveTimeout)
	clients, err := tc.s.tmux.SessionClientCount(probeCtx, server, isoSession)
	probeCancel()
	if err != nil {
		slog.Warn("terminals: iso rollback client probe failed — leaving the session for the next ensure", "session", isoSession, "err", err)
		return
	}
	if clients > 0 {
		return
	}
	if err := tc.s.tmux.KillSessionCtx(context.Background(), server, isoSession); err != nil {
		slog.Warn("terminals: iso rollback kill failed", "session", isoSession, "err", err)
	}
}

// pumpPTY reads the stream's PTY and enqueues stream-id-prefixed binary frames.
// It blocks on a full queue (backpressure) and exits on PTY EOF/error or socket
// teardown, tearing the stream down + emitting a graceful `closed`.
//
// Each read chunk passes through the per-stream Device Attributes filter
// (terminals_da.go, change 260801-f715): tmux's DA1/DA2 identification queries
// are answered at the relay (written back to the ptmx) and stripped from the
// browser-bound stream, so xterm.js never sees or answers them — replies are
// synchronous and exactly-once per attach. The filter carries a bounded
// partial-match prefix across the streamFrameSize read boundary; whatever it
// still holds when this pump exits is dropped with it (the pane is closing).
func (tc *terminalsConn) pumpPTY(st *stream) {
	buf := make([]byte, streamFrameSize)
	filter := newDAFilter(st.ptmx)
	for {
		n, err := st.ptmx.Read(buf)
		if err != nil {
			if err != io.EOF {
				slog.Debug("terminals: pty read error", "err", err, "id", st.id)
			}
			tc.closeStream(st.id, closeNormal, "closed")
			return
		}
		payload := filter.process(buf[:n])
		if len(payload) == 0 {
			// The chunk was entirely query/held bytes — nothing browser-bound.
			continue
		}
		// Prefix a fresh copy with the u32 BE stream id (buf is reused, and the
		// filter's output may alias it).
		frame := make([]byte, 4+len(payload))
		binary.BigEndian.PutUint32(frame[:4], st.id)
		copy(frame[4:], payload)
		select {
		case st.queue <- outFrame{data: frame}:
			tc.signalWake()
		case <-st.closed:
			return
		case <-tc.done:
			return
		}
	}
}

// runWriter is the single writer goroutine: the fair scheduler. It drains every
// ready stream's queue, short/control frames first (so an echo never queues
// behind another stream's bulk output), round-robin across streams (so no
// stream starves), and blocks on `wake` when nothing is ready. Extracted so the
// HOL unit test can drive it directly with a paced writeFrame.
func (tc *terminalsConn) runWriter() {
	for {
		wrote, err := tc.drainReady()
		if err != nil {
			// Dead socket (or a paced-writer stop). Set a short read deadline so
			// the read loop's blocked ReadMessage() returns and runs teardown
			// (mirrors relay.go / state_ws.go). Best-effort — the test's paced
			// writer has no real conn deadline, which is harmless.
			tc.writerDead.Store(true)
			tc.conn.SetReadDeadline(time.Now().Add(terminalsCleanupWait))
			return
		}
		if wrote {
			continue // keep draining while there is ready output
		}
		// Nothing ready — wait for a producer to wake us or the socket to close.
		select {
		case <-tc.done:
			return
		case <-tc.wake:
		}
	}
}

// drainReady performs ONE scheduling pass in two phases so that short/control
// frames are written ahead of bulk output ACROSS streams, not merely within a
// stream: phase 1 drains every stream's head-of-queue short/control frames
// (stashing the ONE bulk frame that surfaces per stream), then phase 2 writes
// the stashed bulk frames round-robin. This prevents an earlier stream's bulk
// from being written before a later stream's echo/control in the same pass.
// Returns (wrote, err): wrote is true if at least one frame was written this
// pass (so the caller re-scans); err stops the writer.
func (tc *terminalsConn) drainReady() (bool, error) {
	streams := tc.snapshotStreams()
	wrote := false

	// stashedBulk holds the (at most) one bulk frame dequeued per stream during
	// phase 1, written in phase 2. Parallel to `streams` by index.
	stashedBulk := make([]outFrame, len(streams))
	hasBulk := make([]bool, len(streams))

	// Phase 1 — priority tier: drain every stream's ready short/control frames
	// across ALL streams first. A stream may hold several; drain its short
	// frames until it yields a bulk frame (stash it) or empties, so control +
	// echo never wait behind ANY stream's bulk.
	for i, st := range streams {
		for {
			select {
			case f := <-st.queue:
				if !f.short() {
					// A bulk frame surfaced — already dequeued, so stash it for
					// phase 2 (preserving per-stream order) and move on. At most
					// one bulk per stream per pass keeps the round-robin fair.
					stashedBulk[i] = f
					hasBulk[i] = true
					goto nextStreamShort
				}
				if err := tc.writeFrame(f); err != nil {
					return wrote, err
				}
				wrote = true
			default:
				goto nextStreamShort
			}
		}
	nextStreamShort:
	}

	// Phase 2 — bulk tier: write the stashed bulk frames round-robin (one per
	// stream), now that every stream's short/control frames are already out.
	for i := range streams {
		if !hasBulk[i] {
			continue
		}
		if err := tc.writeFrame(stashedBulk[i]); err != nil {
			return wrote, err
		}
		wrote = true
	}

	return wrote, nil
}

// snapshotStreams returns the current streams under the lock (order is map
// iteration order — non-deterministic, which is acceptable for round-robin
// fairness across a small pane set).
func (tc *terminalsConn) snapshotStreams() []*stream {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	out := make([]*stream, 0, len(tc.streams))
	for _, st := range tc.streams {
		out = append(out, st)
	}
	return out
}

// signalWake nudges the writer that output is ready (coalesced — a full buffer
// means a wake is already pending).
func (tc *terminalsConn) signalWake() {
	select {
	case tc.wake <- struct{}{}:
	default:
	}
}

// resizeStream sets a live stream's PTY size (ignored for unknown ids and for a
// placeholder still attaching — the open op's initial cols/rows already sized
// the PTY, so a resize racing the attach is safely dropped).
func (tc *terminalsConn) resizeStream(id uint32, cols, rows uint16) {
	if cols == 0 || rows == 0 {
		return
	}
	tc.mu.Lock()
	st := tc.streams[id]
	var ptmx *os.File
	if st != nil {
		ptmx = st.ptmx
	}
	tc.mu.Unlock()
	if ptmx == nil {
		return
	}
	_ = pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// closeStream tears down a live stream and emits a `closed` control event. Safe
// to call repeatedly and from multiple goroutines (removal + teardown are
// idempotent).
func (tc *terminalsConn) closeStream(id uint32, code int, reason string) {
	tc.mu.Lock()
	st := tc.streams[id]
	if st != nil {
		delete(tc.streams, id)
	}
	tc.mu.Unlock()
	if st == nil {
		return
	}
	st.teardown()
	tc.emitClosed(id, code, reason)
}

// teardown closes all streams and stops the writer. Called once on read-loop
// exit (socket death / client close).
func (tc *terminalsConn) teardown() {
	tc.mu.Lock()
	select {
	case <-tc.done:
		tc.mu.Unlock()
		return
	default:
		close(tc.done)
	}
	streams := make([]*stream, 0, len(tc.streams))
	for id, st := range tc.streams {
		streams = append(streams, st)
		delete(tc.streams, id)
	}
	tc.mu.Unlock()
	for _, st := range streams {
		st.teardown()
	}
	tc.signalWake() // unblock the writer if parked on wake
}

// mustMarshalOpened marshals the `opened` control frame for a stream. Unlike
// `closed` (which rides the reserved control pseudo-stream), `opened` is
// enqueued onto the stream's OWN queue in attachStream, ahead of any data frame,
// so channel FIFO + short-frame priority guarantees the client sees opened→data
// (M2).
func mustMarshalOpened(id uint32) []byte {
	b, _ := json.Marshal(openedFrame{Op: "opened", ID: id})
	return b
}

// emitClosed enqueues a `closed` control frame onto a synthetic priority path.
// Control frames must ride the writer (gorilla forbids concurrent writes) but a
// `closed` does not belong to a stream's bounded queue (the stream is being torn
// down) — so it goes through a tiny dedicated control stream the scheduler
// always treats as short/priority. Ordering vs a stream's trailing data does not
// matter: the client retires the stream on `closed` and drops any later data.
func (tc *terminalsConn) emitClosed(id uint32, code int, reason string) {
	b, _ := json.Marshal(closedFrame{Op: "closed", ID: id, Code: code, Reason: reason})
	tc.enqueueControl(b)
}

// controlStreamID is a reserved pseudo-stream carrying only control frames. It
// is never a real tmux stream (client ids are for panes); the scheduler drains
// it with the same short-frame priority as any stream's control output.
const controlStreamID = ^uint32(0) // math.MaxUint32 — reserved, never a pane id

// enqueueControl appends a control frame to the reserved control stream's queue,
// lazily creating it. Control frames are small and priority; the queue is
// generously sized so a burst of opened/closed events never blocks.
func (tc *terminalsConn) enqueueControl(b []byte) {
	tc.mu.Lock()
	st := tc.streams[controlStreamID]
	if st == nil {
		st = &stream{
			id:     controlStreamID,
			queue:  make(chan outFrame, 64),
			closed: make(chan struct{}),
		}
		tc.streams[controlStreamID] = st
	}
	tc.mu.Unlock()
	select {
	case st.queue <- outFrame{control: b}:
		tc.signalWake()
	case <-tc.done:
	}
}

// teardown cancels the attach context, closes the ptmx, and kills AND reaps
// the attach process (sync.Once-guarded) — no orphaned attach processes
// (review rule: WS connections must have corresponding cleanup) and no
// zombies. The control pseudo-stream has no ptmx/cmd, so those steps no-op.
func (st *stream) teardown() {
	st.cleanup.Do(func() {
		close(st.closed)
		if st.cancel != nil {
			st.cancel()
		}
		if st.ptmx != nil {
			st.ptmx.Close()
		}
		// Unregister BEFORE the kill: the pid stays allocated until the
		// process is reaped, so removing the registry entry first means a
		// reused pid can never briefly alias this dead attach.
		if st.unregister != nil {
			st.unregister()
		}
		killAndReapAttach(st.cmd)
	})
}

// killAndReapAttach kills a forked attach client and waits on it (the
// internal/tmuxctl kill→Wait contract). The Wait is load-bearing: without it
// every closed stream leaves a <defunct> zombie PID plus a permanently parked
// os/exec watchCtx goroutine, and at the fork ceiling every exec in the daemon
// fails at once. Kill-first means Wait returns promptly — an attach client
// never exits on its own. Exactly one goroutine per Cmd may call this:
// teardown's sync.Once owns a published cmd; the publish-race branch owns its
// never-published one.
func killAndReapAttach(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
}

// serverFromRequestValue mirrors serverFromRequest (router.go) for a raw server
// value carried in an `open` op rather than a URL query param: empty or invalid
// falls back to "default".
func serverFromRequestValue(s string) string {
	if s == "" {
		return "default"
	}
	if validate.ValidateServerName(s) != "" {
		return "default"
	}
	return s
}
