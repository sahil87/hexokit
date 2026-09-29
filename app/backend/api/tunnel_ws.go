package api

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Web-tile tunnel — `GET /ws/tunnel?target=host:port`.
//
// The server exposes ONE primitive for the desktop's loopback proxy: open
// TCP to host:port from this host (DNS resolves here) and pipe bytes over
// the socket. Dial-before-upgrade means a completed handshake signals
// "connected", so the desktop maps open/failure directly onto Chromium's
// `200 Connection Established` / `502 Bad Gateway` with no in-band
// signalling. Every rejection happens BEFORE the upgrade as a plain HTTP
// error: Origin policy → 403, bad target → 400, dial failure → 502.
//
// The byte pipe mirrors the gui_ws.go relay: the lifecycle context is rooted
// at Background — NOT r.Context(), which some servers cancel at upgrade —
// the TCP→WS pump is the ONLY message writer (gorilla forbids concurrent
// writes), and teardown is close-driven: either side ending closes BOTH
// conns and the handler joins the pump and ping goroutines before returning
// (no goroutine or socket outlives the handler). There is no idle cap and no
// read deadline on an established tunnel — HMR WebSockets and long-polls are
// long-lived; WebSocket has no half-close, so an upstream FIN ends the
// tunnel. Writes on both directions carry a deadline (the terminalsWriteWait
// posture) so a backpressured peer cannot park the close-driven teardown.
// Periodic ping frames keep front-end idle timeouts (nginx 60 s default,
// Cloudflare ~100 s) from severing a byte-quiet tunnel.
//
// There is NO destination policy (anyone who can reach rk already has a
// shell through the terminal relay, so a policy is security theater), no
// subprocess (net dialing only, Constitution I), and no state beyond live
// connections (Constitution II).

const (
	// tunnelDialTimeout bounds the upstream dial (the forward proxy's CONNECT
	// dial budget: refused is instant — the timeout covers a filtered/hung
	// endpoint).
	tunnelDialTimeout = 10 * time.Second
	// tunnelReadChunk is the upstream→WS read buffer size (the
	// guiBackendReadChunk precedent).
	tunnelReadChunk = 64 << 10 // 64 KiB
	// tunnelReadLimit caps a single inbound WS message: ReadMessage buffers
	// the whole frame, and an unbounded limit is a memory-DoS (the
	// guiReadLimit rationale). Headroom over the client's 64 KiB write
	// chunks.
	tunnelReadLimit = 1 << 20 // 1 MiB
)

// durationKnob is a test-tunable duration. Atomic because tunnel handler
// goroutines can outlive the test that tuned them (hijacked connections are
// not joined by httptest.Server.Close), so a plain var races with the next
// test's write under -race.
type durationKnob struct{ ns atomic.Int64 }

func newDurationKnob(d time.Duration) *durationKnob {
	k := &durationKnob{}
	k.ns.Store(int64(d))
	return k
}

func (k *durationKnob) get() time.Duration  { return time.Duration(k.ns.Load()) }
func (k *durationKnob) set(d time.Duration) { k.ns.Store(int64(d)) }

// tunnelPingInterval is the ping cadence on an established tunnel.
var tunnelPingInterval = newDurationKnob(30 * time.Second)

// tunnelUpstreamWriteWait bounds a single WS→upstream write: without a
// deadline a backpressured destination parks the read loop forever, and the
// close-driven teardown never runs.
var tunnelUpstreamWriteWait = newDurationKnob(terminalsWriteWait)

// tunnelUpgrader is the tunnel's dedicated upgrader — NOT the shared one:
// the tunnel admits only Origin-less, Sec-Fetch-Site-less clients
// (ws_origin.go).
var tunnelUpgrader = websocket.Upgrader{
	CheckOrigin: checkTunnelWSOrigin,
}

// handleTunnelWS gates (origin, target, dial), upgrades, then pipes binary
// frames both ways until either side ends.
func (s *Server) handleTunnelWS(w http.ResponseWriter, r *http.Request) {
	// The upgrader enforces the same policy at upgrade time, but the check
	// must short-circuit BEFORE any dialing.
	if !checkTunnelWSOrigin(r) {
		writeError(w, http.StatusForbidden, "tunnel: origin not allowed")
		return
	}
	target := r.URL.Query().Get("target")
	host, portStr, err := net.SplitHostPort(target)
	if err != nil || host == "" {
		writeError(w, http.StatusBadRequest, "target must be host:port")
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		writeError(w, http.StatusBadRequest, "target must be host:port with a numeric port in 1-65535")
		return
	}
	upstream, err := (&net.Dialer{Timeout: tunnelDialTimeout}).DialContext(r.Context(), "tcp", target)
	if err != nil {
		slog.Warn("tunnel: dial failed", "target", target, "err", err)
		writeError(w, http.StatusBadGateway, "tunnel: connect failed")
		return
	}
	conn, err := tunnelUpgrader.Upgrade(w, r, nil)
	if err != nil {
		upstream.Close()
		slog.Error("tunnel ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Ping keepalive: WriteControl is documented concurrency-safe with the
	// pump writer. A failed ping means the socket is gone — Close unblocks
	// the read loop (gorilla documents Close as safe alongside all methods),
	// and closing upstream unblocks the pump's Read; cancel joins both.
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(tunnelPingInterval.get())
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(terminalsWriteWait)); err != nil {
					conn.Close()
					upstream.Close()
					cancel()
					return
				}
			}
		}
	}()

	// Upstream → WS pump: the ONLY writer on the socket (gorilla forbids
	// concurrent writes). An upstream read error (EOF = upstream closed) or
	// a write failure cancels the lifecycle and sets a short read deadline
	// so the read loop's blocked ReadMessage returns promptly and runs
	// teardown (the terminalsCleanupWait idiom). On upstream EOF the client
	// first gets a real close frame — a clean close, not a network cut.
	pumpDone := make(chan struct{})
	go func() {
		defer close(pumpDone)
		defer cancel()
		buf := make([]byte, tunnelReadChunk)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, rerr := upstream.Read(buf)
			if rerr != nil {
				conn.SetWriteDeadline(time.Now().Add(terminalsWriteWait))
				_ = conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "tunnel upstream closed"))
				conn.SetReadDeadline(time.Now().Add(terminalsCleanupWait))
				return
			}
			conn.SetWriteDeadline(time.Now().Add(terminalsWriteWait))
			if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
				conn.SetReadDeadline(time.Now().Add(terminalsCleanupWait))
				return
			}
		}
	}()

	// Read loop: WS → upstream. Text frames are ignored (forward-compat).
	// Bound each inbound frame (memory-DoS). Upstream writes carry a write
	// deadline so a backpressured destination cannot park the read loop
	// forever — without it a client close would never be read and teardown
	// would never run. On exit, close BOTH conns and wait for the pump and
	// ping goroutines so neither outlives the handler.
	conn.SetReadLimit(tunnelReadLimit)
	for {
		msgType, msg, rerr := conn.ReadMessage()
		if rerr != nil {
			break
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		upstream.SetWriteDeadline(time.Now().Add(tunnelUpstreamWriteWait.get()))
		if _, werr := upstream.Write(msg); werr != nil {
			break
		}
	}

	cancel()
	upstream.Close()
	<-pumpDone
	<-pingDone
}
