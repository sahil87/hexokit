package api

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"rk/internal/gui"
	"rk/internal/settings"
)

// fakeGuiBackend is an in-process echoing RFB stand-in on a temp unix
// socket. Accepted conns are recorded so tests can observe teardown (EOF on
// client disconnect) and drive backend-first closes.
type fakeGuiBackend struct {
	ln       net.Listener
	accepted chan net.Conn

	mu    sync.Mutex
	conns []net.Conn
}

func newFakeGuiBackend(t *testing.T) *fakeGuiBackend {
	t.Helper()
	ln, err := net.Listen("unix", filepath.Join(t.TempDir(), "host.sock"))
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	fb := &fakeGuiBackend{ln: ln, accepted: make(chan net.Conn, 8)}
	t.Cleanup(func() {
		ln.Close()
		fb.mu.Lock()
		for _, c := range fb.conns {
			c.Close()
		}
		fb.mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			fb.mu.Lock()
			fb.conns = append(fb.conns, c)
			fb.mu.Unlock()
			fb.accepted <- c
			go io.Copy(c, c) // echo until the relay hangs up
		}
	}()
	return fb
}

// stubGuiDial routes the relay's backend dial at the fake listener.
func stubGuiDial(t *testing.T, fb *fakeGuiBackend) {
	t.Helper()
	orig := guiDial
	guiDial = func(network, addr string) (net.Conn, error) {
		return net.DialTimeout("unix", fb.ln.Addr().String(), time.Second)
	}
	t.Cleanup(func() { guiDial = orig })
}

// newGuiRelayServer builds a real routed server (the relay rides the
// registered /ws/gui/{id} route) with gui.enabled persisted as given.
func newGuiRelayServer(t *testing.T, enabled bool) (*Server, *httptest.Server) {
	t.Helper()
	isolateSettings(t)
	st := settings.Load()
	st.GUIEnabled = enabled
	if err := settings.Save(st); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	server := &Server{logger: logger, sessions: &mockSessionFetcher{}, tmux: &mockTmuxOps{}, hostname: "test-host"}
	ts := httptest.NewServer(server.buildRouter())
	t.Cleanup(ts.Close)
	return server, ts
}

func dialGuiWS(t *testing.T, ts *httptest.Server, id string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/gui/" + id
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial /ws/gui/%s: %v", id, err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func waitGuiViewerCount(t *testing.T, server *Server, id string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		server.initSSEHub()
		if got := server.sseHub.guiViewerCount(id); got == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("viewer count for %q never reached %d (now %d)", id, want, server.sseHub.guiViewerCount(id))
}

// readGuiCloseCode reads until the server-sent close frame and returns its
// code and reason.
func readGuiCloseCode(t *testing.T, conn *websocket.Conn) (int, string) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if errors.As(err, &ce) {
			return ce.Code, ce.Text
		}
		t.Fatalf("read: %v (want a close frame)", err)
	}
}

func TestGuiRelayEchoRoundTrip(t *testing.T) {
	fb := newFakeGuiBackend(t)
	server, ts := newGuiRelayServer(t, true)
	stubGuiDial(t, fb)

	conn := dialGuiWS(t, ts, "host")
	waitGuiViewerCount(t, server, "host", 1)

	banner := []byte("RFB 003.008\n")
	if err := conn.WriteMessage(websocket.BinaryMessage, banner); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type = %d, want BinaryMessage", mt)
	}
	if string(msg) != string(banner) {
		t.Fatalf("echo = %q, want %q", msg, banner)
	}

	// Text frames are ignored (forward-compat): the echo still works after.
	if err := conn.WriteMessage(websocket.TextMessage, []byte("{}")); err != nil {
		t.Fatalf("write text: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, banner); err != nil {
		t.Fatalf("write 2: %v", err)
	}
	if _, msg, err := conn.ReadMessage(); err != nil || string(msg) != string(banner) {
		t.Fatalf("read 2 = %q, %v; want %q", msg, err, banner)
	}

	conn.Close()
	waitGuiViewerCount(t, server, "host", 0)
}

func TestGuiRelayCloseCodes(t *testing.T) {
	t.Run("invalid id → 4400", func(t *testing.T) {
		fb := newFakeGuiBackend(t)
		_, ts := newGuiRelayServer(t, true)
		stubGuiDial(t, fb)
		conn := dialGuiWS(t, ts, "nope")
		code, reason := readGuiCloseCode(t, conn)
		if code != guiCloseInvalidID || reason != "invalid gui id" {
			t.Fatalf("close = %d %q, want %d %q", code, reason, guiCloseInvalidID, "invalid gui id")
		}
	})

	t.Run("disabled → 4403", func(t *testing.T) {
		fb := newFakeGuiBackend(t)
		_, ts := newGuiRelayServer(t, false)
		stubGuiDial(t, fb)
		conn := dialGuiWS(t, ts, "host")
		code, reason := readGuiCloseCode(t, conn)
		if code != guiCloseDisabled || reason != "gui disabled" {
			t.Fatalf("close = %d %q, want %d %q", code, reason, guiCloseDisabled, "gui disabled")
		}
	})

	t.Run("no listener → 4404", func(t *testing.T) {
		_, ts := newGuiRelayServer(t, true)
		orig := guiDial
		guiDial = func(network, addr string) (net.Conn, error) {
			return nil, errors.New("boom")
		}
		t.Cleanup(func() { guiDial = orig })
		conn := dialGuiWS(t, ts, "host")
		code, reason := readGuiCloseCode(t, conn)
		if code != guiCloseNotRunning || !strings.HasPrefix(reason, "gui not running: ") {
			t.Fatalf("close = %d %q, want %d with a %q reason prefix", code, reason, guiCloseNotRunning, "gui not running: ")
		}
	})
}

func TestGuiRelayClientDisconnectClosesBackend(t *testing.T) {
	fb := newFakeGuiBackend(t)
	server, ts := newGuiRelayServer(t, true)
	stubGuiDial(t, fb)

	conn := dialGuiWS(t, ts, "host")
	waitGuiViewerCount(t, server, "host", 1)
	backendConn := <-fb.accepted

	conn.Close()

	// The relay must close the backend conn promptly — no orphaned sockets.
	backendConn.SetReadDeadline(time.Now().Add(1 * time.Second))
	_, err := backendConn.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("backend conn still readable 1s after the client closed")
	}
	waitGuiViewerCount(t, server, "host", 0)
}

func TestGuiRelayBackendDisconnectClosesClient(t *testing.T) {
	fb := newFakeGuiBackend(t)
	_, ts := newGuiRelayServer(t, true)
	stubGuiDial(t, fb)

	conn := dialGuiWS(t, ts, "host")
	backendConn := <-fb.accepted

	backendConn.Close()

	// The client must observe a close frame (not just a dead TCP conn).
	conn.SetReadDeadline(time.Now().Add(1 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("read: %v (want a close frame)", err)
		}
		break
	}
}

// TestGuiRelayRealXtigervnc relays a REAL Xtigervnc through /ws/gui/host: the
// server is launched with the fixed gui.BackendArgv on a temp unix socket (a
// high display, so nothing real is collided with), guiDial is NOT stubbed —
// the production dial path (guiBackendAddr → XDG_STATE_HOME-redirected state
// dir) is what connects — and the first 12 bytes through the WS relay must be
// the RFB 003.008 banner. Capability-gated on Xtigervnc being installed.
// Cleanup SIGTERMs the X server (escalating to SIGKILL) and asserts no
// listener remains.
func TestGuiRelayRealXtigervnc(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the unix-socket backend is Linux-only")
	}
	bin, err := exec.LookPath("Xtigervnc")
	if err != nil {
		t.Skip("Xtigervnc not installed")
	}

	// Redirect the GUI state dir so the production dial path finds the temp
	// socket (gui.SocketPath reads XDG_STATE_HOME at call time).
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	stateDir := filepath.Join(stateHome, "hexokit", "gui")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	sock := filepath.Join(stateDir, "host.sock")
	if err := gui.ValidateSocketPath(sock); err != nil {
		t.Fatalf("temp socket path unusable: %v", err)
	}
	n, err := gui.FreeDisplay(90)
	if err != nil {
		t.Fatalf("no free display: %v", err)
	}
	display := fmt.Sprintf(":%d", n)

	argv := gui.BackendArgv(bin, display, sock, gui.GeometryDefault)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting Xtigervnc: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		// No listener may remain on the socket after the backend is down.
		if conn, err := net.DialTimeout("unix", sock, 200*time.Millisecond); err == nil {
			conn.Close()
			t.Errorf("socket %s still accepts connections after the backend exit", sock)
		}
		// Sweep the X lock artifacts so later FreeDisplay probes stay honest
		// even if the kill skipped the server's own cleanup.
		_ = os.Remove(fmt.Sprintf("/tmp/.X%d-lock", n))
		_ = os.Remove(filepath.Join("/tmp/.X11-unix", fmt.Sprintf("X%d", n)))
	})

	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Xtigervnc did not create %s within 10s", sock)
		}
		time.Sleep(100 * time.Millisecond)
	}

	_, ts := newGuiRelayServer(t, true)
	conn := dialGuiWS(t, ts, "host")
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type = %d, want BinaryMessage", mt)
	}
	if string(msg) != "RFB 003.008\n" {
		t.Fatalf("banner = %q, want %q", msg, "RFB 003.008\n")
	}
}
