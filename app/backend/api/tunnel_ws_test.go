package api

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"rk/internal/testutil"
)

func tunnelTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newTunnelTestServer serves the real router (the tunnel rides its
// registered /ws/tunnel route) over httptest.
func newTunnelTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(NewTestRouter(tunnelTestLogger(), nil, nil, "test-host"))
	t.Cleanup(ts.Close)
	return ts
}

// startTunnelEchoUpstream starts a raw-TCP echo server on loopback. It
// accepts ONE connection, echoes bytes until EOF, delivers the accepted conn
// on accepted, and closes closed when the echo loop exits (the
// close-cleanup signal).
func startTunnelEchoUpstream(t *testing.T) (addr string, accepted <-chan net.Conn, closed <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	acceptedCh := make(chan net.Conn, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		acceptedCh <- conn
		io.Copy(conn, conn)
		conn.Close()
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().String(), acceptedCh, done
}

func tunnelURL(ts *httptest.Server, target string) string {
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/tunnel?target=" + url.QueryEscape(target)
}

// dialTunnel dials the tunnel endpoint and fails the test unless the
// handshake completes.
func dialTunnel(t *testing.T, ts *httptest.Server, target string, header http.Header) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(tunnelURL(ts, target), header)
	if err != nil {
		t.Fatalf("dial /ws/tunnel: %v (status %v)", err, respStatus(resp))
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func respStatus(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}

// dialTunnelStatus dials expecting the handshake to FAIL with the given HTTP
// status (pre-upgrade rejections arrive as plain HTTP errors).
func dialTunnelStatus(t *testing.T, ts *httptest.Server, target string, header http.Header, want int) {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(tunnelURL(ts, target), header)
	if err == nil {
		conn.Close()
		t.Fatalf("dial /ws/tunnel?target=%q succeeded, want a %d rejection", target, want)
	}
	if !errors.Is(err, websocket.ErrBadHandshake) {
		t.Fatalf("dial error = %v, want ErrBadHandshake", err)
	}
	if got := respStatus(resp); got != want {
		t.Fatalf("rejection status = %d, want %d", got, want)
	}
}

// writeEcho writes one binary message and requires its echo back verbatim.
func writeEcho(t *testing.T, conn *websocket.Conn, msg []byte) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if mt != websocket.BinaryMessage || string(got) != string(msg) {
		t.Fatalf("echo = (%d, %q), want (%d, %q)", mt, got, websocket.BinaryMessage, msg)
	}
}

func TestTunnelEchoRoundTrip(t *testing.T) {
	upstreamAddr, _, _ := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	writeEcho(t, conn, []byte("hello-tunnel"))
	writeEcho(t, conn, []byte("second-round-trip"))

	// Text frames are ignored (forward-compat): the echo still works after.
	if err := conn.WriteMessage(websocket.TextMessage, []byte("{}")); err != nil {
		t.Fatalf("write text: %v", err)
	}
	writeEcho(t, conn, []byte("after-text"))
}

// tunnelWSConn adapts the tunnel client WebSocket to net.Conn so a second
// WebSocket handshake can ride INSIDE the tunnel (the HMR case).
type tunnelWSConn struct {
	conn *websocket.Conn
	buf  []byte
}

func (c *tunnelWSConn) Read(p []byte) (int, error) {
	for len(c.buf) == 0 {
		mt, msg, err := c.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		c.buf = msg
	}
	n := copy(p, c.buf)
	c.buf = c.buf[n:]
	return n, nil
}

func (c *tunnelWSConn) Write(p []byte) (int, error) {
	if err := c.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *tunnelWSConn) Close() error                     { return c.conn.Close() }
func (c *tunnelWSConn) LocalAddr() net.Addr              { return c.conn.LocalAddr() }
func (c *tunnelWSConn) RemoteAddr() net.Addr             { return c.conn.RemoteAddr() }
func (c *tunnelWSConn) SetDeadline(time.Time) error      { return nil }
func (c *tunnelWSConn) SetReadDeadline(time.Time) error  { return nil }
func (c *tunnelWSConn) SetWriteDeadline(time.Time) error { return nil }

// A WebSocket upgrade echoes INSIDE the established tunnel — the bytes are
// opaque to the relay, so a nested handshake and its frames pass verbatim.
func TestTunnelWebSocketUpgradeInside(t *testing.T) {
	up := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			mt, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			if err := c.WriteMessage(mt, msg); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	upstreamAddr := strings.TrimPrefix(upstream.URL, "http://")

	ts := newTunnelTestServer(t)
	tunnel := dialTunnel(t, ts, upstreamAddr, nil)

	wsURL := &url.URL{Scheme: "ws", Host: upstreamAddr, Path: "/"}
	inner, resp, err := websocket.NewClient(&tunnelWSConn{conn: tunnel}, wsURL, nil, 1024, 1024)
	if err != nil {
		t.Fatalf("websocket handshake inside tunnel: %v", err)
	}
	defer inner.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Errorf("inner upgrade status = %d, want %d", resp.StatusCode, http.StatusSwitchingProtocols)
	}

	if err := inner.WriteMessage(websocket.TextMessage, []byte("ws-inside-tunnel")); err != nil {
		t.Fatalf("inner write: %v", err)
	}
	inner.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := inner.ReadMessage()
	if err != nil {
		t.Fatalf("inner read: %v", err)
	}
	if mt != websocket.TextMessage || string(msg) != "ws-inside-tunnel" {
		t.Errorf("inner echo = (%d, %q), want (%d, %q)", mt, msg, websocket.TextMessage, "ws-inside-tunnel")
	}
}

func TestTunnelBadTarget(t *testing.T) {
	ts := newTunnelTestServer(t)
	for _, target := range []string{"", "not-a-target", "127.0.0.1:notaport", ":8080", "127.0.0.1:0", "127.0.0.1:65536"} {
		dialTunnelStatus(t, ts, target, nil, http.StatusBadRequest)
	}
}

func TestTunnelDialFailure(t *testing.T) {
	ts := newTunnelTestServer(t)
	// Port 1 on loopback refuses immediately — the handshake MUST NOT
	// complete (dial-before-upgrade: the client reads 502, never 101).
	dialTunnelStatus(t, ts, "127.0.0.1:1", nil, http.StatusBadGateway)
}

func TestTunnelOriginRejected(t *testing.T) {
	upstreamAddr, _, _ := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	dialTunnelStatus(t, ts, upstreamAddr, http.Header{"Origin": {"http://example.com"}}, http.StatusForbidden)
	dialTunnelStatus(t, ts, upstreamAddr, http.Header{"Sec-Fetch-Site": {"same-origin"}}, http.StatusForbidden)
}

// Closing the client side of an established tunnel MUST close the upstream
// connection and let the handler return — close-driven lifetime, no
// deadline, no leaked goroutine.
func TestTunnelClientCloseCleansUp(t *testing.T) {
	upstreamAddr, _, upstreamClosed := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	before := runtime.NumGoroutine()

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	writeEcho(t, conn, []byte("ping"))

	conn.Close()

	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		select {
		case <-upstreamClosed:
			return true
		default:
			return false
		}
	}, "upstream conn did not close after client disconnect")
	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		return runtime.NumGoroutine() <= before
	}, "goroutine count did not settle: before=%d now=%d", before, runtime.NumGoroutine())
}

// An upstream close MUST surface to the client as a normal close frame (not
// just a dead TCP conn), and the handler must return.
func TestTunnelUpstreamCloseCleansUp(t *testing.T) {
	upstreamAddr, accepted, _ := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	before := runtime.NumGoroutine()

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	upstreamConn := <-accepted
	writeEcho(t, conn, []byte("ping"))

	upstreamConn.Close()

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("read: %v (want a close frame)", err)
		}
		if ce.Code != websocket.CloseNormalClosure {
			t.Fatalf("close code = %d, want %d", ce.Code, websocket.CloseNormalClosure)
		}
		break
	}
	conn.Close()

	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		return runtime.NumGoroutine() <= before
	}, "goroutine count did not settle: before=%d now=%d", before, runtime.NumGoroutine())
}

// A byte-quiet tunnel MUST NOT be cut by any fixed deadline — the lifetime
// is close-driven only (HMR WebSockets and long-polls are long-lived).
func TestTunnelQuietTunnelSurvives(t *testing.T) {
	upstreamAddr, _, _ := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	time.Sleep(300 * time.Millisecond)
	writeEcho(t, conn, []byte("still-alive"))
}

// The server pings an established tunnel on tunnelPingInterval so front-end
// idle timeouts do not sever a quiet tunnel.
func TestTunnelPingKeepalive(t *testing.T) {
	orig := tunnelPingInterval.get()
	tunnelPingInterval.set(50 * time.Millisecond)
	t.Cleanup(func() { tunnelPingInterval.set(orig) })

	upstreamAddr, _, _ := startTunnelEchoUpstream(t)
	ts := newTunnelTestServer(t)

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	gotPing := make(chan struct{}, 1)
	conn.SetPingHandler(func(appData string) error {
		select {
		case gotPing <- struct{}{}:
		default:
		}
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
	})
	// Control frames are processed inside ReadMessage; a reader must be
	// parked for the ping handler to fire.
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, _ = conn.ReadMessage()
	}()
	defer func() {
		conn.Close()
		<-readDone
	}()

	select {
	case <-gotPing:
	case <-time.After(2 * time.Second):
		t.Fatal("no ping within 2s on a quiet tunnel")
	}
}

// startTunnelSilentUpstream starts a raw-TCP server that accepts ONE
// connection and never reads or writes, delivering the accepted conn on
// accepted. The upstream's receive buffer fills quickly, so the tunnel's
// WS→upstream writes eventually stall (the backpressure scenario).
func startTunnelSilentUpstream(t *testing.T) (addr string, accepted <-chan net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	acceptedCh := make(chan net.Conn, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		acceptedCh <- conn
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().String(), acceptedCh
}

// A WS→upstream write stalled on a backpressured destination MUST NOT park
// the read loop: closing the client still unwinds the handler (the upstream
// write deadline turns the stall into an error, so teardown runs).
func TestTunnelBackpressuredUpstreamUnwinds(t *testing.T) {
	orig := tunnelUpstreamWriteWait.get()
	tunnelUpstreamWriteWait.set(200 * time.Millisecond)
	t.Cleanup(func() { tunnelUpstreamWriteWait.set(orig) })

	upstreamAddr, accepted := startTunnelSilentUpstream(t)
	ts := newTunnelTestServer(t)

	before := runtime.NumGoroutine()

	conn := dialTunnel(t, ts, upstreamAddr, nil)
	upstreamConn := <-accepted
	defer upstreamConn.Close()

	// Fill the upstream socket's buffers; the writer stalls once no
	// destination buffer remains (two identical samples = parked in Write).
	var written atomic.Int64
	writeErr := make(chan error, 1)
	go func() {
		chunk := make([]byte, 64<<10)
		for {
			conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				writeErr <- err
				return
			}
			written.Add(1)
		}
	}()
	testutil.MustWaitUntil(t, 10*time.Second, func() bool {
		prev := written.Load()
		time.Sleep(300 * time.Millisecond)
		return prev > 0 && written.Load() == prev
	}, "writer never stalled: upstream buffers did not fill")

	// The client goes away while the server-side read loop is stalled in
	// upstream.Write; only the write deadline lets the handler run teardown.
	conn.Close()
	<-writeErr

	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		return runtime.NumGoroutine() <= before
	}, "goroutine count did not settle: before=%d now=%d", before, runtime.NumGoroutine())
}

// failWriteConn errors every Write once armed while reads pass through — a
// silently dead socket: the read loop's ReadMessage stays parked, but the
// next ping write fails.
type failWriteConn struct {
	net.Conn
	armed atomic.Bool
}

func (c *failWriteConn) Write(p []byte) (int, error) {
	if c.armed.Load() {
		return 0, errors.New("tunnel test: write failed")
	}
	return c.Conn.Write(p)
}

// wrapListener delivers each accepted conn through wrap.
type wrapListener struct {
	net.Listener
	wrap func(net.Conn) net.Conn
}

func (l *wrapListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return l.wrap(conn), nil
}

// A failed ping means the WebSocket is dead: the handler MUST return even
// when the read loop and the pump stay parked (closing both conns, not just
// cancelling the lifecycle context).
func TestTunnelPingFailureTearsDown(t *testing.T) {
	orig := tunnelPingInterval.get()
	tunnelPingInterval.set(20 * time.Millisecond)
	t.Cleanup(func() { tunnelPingInterval.set(orig) })

	upstreamAddr, _, upstreamClosed := startTunnelEchoUpstream(t)

	// Serve the real router on our own listener so the server-side conn can
	// be armed to fail writes after the handshake.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	serverConns := make(chan *failWriteConn, 1)
	srv := &http.Server{Handler: NewTestRouter(tunnelTestLogger(), nil, nil, "test-host")}
	go srv.Serve(&wrapListener{ln, func(conn net.Conn) net.Conn {
		wrapped := &failWriteConn{Conn: conn}
		serverConns <- wrapped
		return wrapped
	}})
	t.Cleanup(func() { srv.Close() })

	before := runtime.NumGoroutine()

	wsURL := "ws://" + ln.Addr().String() + "/ws/tunnel?target=" + url.QueryEscape(upstreamAddr)
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial /ws/tunnel: %v (status %v)", err, respStatus(resp))
	}
	t.Cleanup(func() { conn.Close() })
	var serverConn *failWriteConn
	select {
	case serverConn = <-serverConns:
	case <-time.After(2 * time.Second):
		t.Fatal("server never accepted the tunnel conn")
	}
	writeEcho(t, conn, []byte("before-arm"))

	// The socket dies silently: reads stay parked, writes fail. The next
	// ping errors and must close BOTH conns so the read loop and the pump
	// (blocked in upstream.Read on the byte-quiet echo conn) join.
	serverConn.armed.Store(true)

	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		select {
		case <-upstreamClosed:
			return true
		default:
			return false
		}
	}, "upstream conn did not close after the ping failure")
	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		return runtime.NumGoroutine() <= before
	}, "goroutine count did not settle: before=%d now=%d", before, runtime.NumGoroutine())
}
