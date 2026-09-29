package api

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"rk/internal/testutil"
	"rk/internal/tmux"
)

// These tests exercise the terminals mux (/ws/terminals, api/terminals_ws.go),
// which absorbed the retired per-pane /relay/{windowId} handler's per-stream
// semantics VERBATIM: window-ID validation → ResolveWindowSession →
// session-scoped SelectWindowInSession → direct PTY attach at the open op's
// initial size → forceTERM. They are the per-stream equivalents of the former
// handleRelay behavior assertions (direct-attach render, no ephemeral session
// leak, 4004-on-bad-window, initial-size attach).

// withTerminalsTmux starts an isolated tmux server with a single real session
// containing two windows whose payloads are deterministic (echo + sleep) so a
// relay client can identify which window it is attached to from the PTY bytes.
// Skips the test if tmux is not on PATH. Returns the live window IDs (@N) for
// the two windows in list-order so callers can address them by stable ID.
func withTerminalsTmux(t *testing.T) (server, real, win0ID, win1ID string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}

	server = testSocketName("relay")
	real = "real"

	bootCtx, cancelBoot := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelBoot()
	// Window 0: print WINDOW_ZERO then idle for the test duration.
	cmd := exec.CommandContext(bootCtx, "tmux", "-L", server,
		"new-session", "-d", "-s", real, "-x", "80", "-y", "24",
		"-n", "win0", "sh", "-c", "printf 'WINDOW_ZERO\\n'; sleep 30")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}

	// Window 1: print WINDOW_ONE then idle.
	addCtx, cancelAdd := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelAdd()
	addCmd := exec.CommandContext(addCtx, "tmux", "-L", server,
		"new-window", "-t", real, "-n", "win1", "sh", "-c", "printf 'WINDOW_ONE\\n'; sleep 30")
	if out, err := addCmd.CombinedOutput(); err != nil {
		t.Fatalf("create second window: %v\n%s", err, string(out))
	}

	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	// Resolve the live window IDs (@N) by index so tests can address windows by
	// their stable ID rather than a mutable index.
	listCtx, cancelList := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelList()
	windows, err := tmux.ListWindows(listCtx, real, server)
	if err != nil {
		t.Fatalf("list windows: %v", err)
	}
	for _, win := range windows {
		switch win.Index {
		case 0:
			win0ID = win.WindowID
		case 1:
			win1ID = win.WindowID
		}
	}
	if win0ID == "" || win1ID == "" {
		t.Fatalf("could not resolve window IDs (got win0=%q win1=%q) from %+v", win0ID, win1ID, windows)
	}
	return server, real, win0ID, win1ID
}

// terminalsServerWithProdTmux returns an httptest.Server whose router is wired
// against the real tmux package (prodTmuxOps). A live tmux server is required.
func terminalsServerWithProdTmux(t *testing.T) *httptest.Server {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	router := NewTestRouter(logger, &prodSessionFetcher{}, &prodTmuxOps{}, "test-host")
	return httptest.NewServer(router)
}

// dialTerminals opens a WebSocket to the terminals mux (/ws/terminals). The
// returned connection carries all streams; callers issue `open` ops via
// openStream below.
func dialTerminals(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	httpURL, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	wsURL := url.URL{Scheme: "ws", Host: httpURL.Host, Path: "/ws/terminals"}
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		body := ""
		if resp != nil {
			body = fmt.Sprintf(" status=%d", resp.StatusCode)
		}
		t.Fatalf("dial terminals %s: %v%s", wsURL.String(), err, body)
	}
	return conn
}

// openStream sends an `open` control op for a stream over the terminals socket.
func openStream(t *testing.T, conn *websocket.Conn, id uint32, tmuxServer, windowID string, cols, rows uint16) {
	t.Helper()
	op := openOp{Op: "open", ID: id, Server: tmuxServer, WindowID: windowID, Cols: cols, Rows: rows}
	body, err := json.Marshal(op)
	if err != nil {
		t.Fatalf("marshal open op: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, body); err != nil {
		t.Fatalf("write open op: %v", err)
	}
}

// readStreamUntilContains reads frames from the terminals socket up to deadline,
// concatenating the BINARY payloads addressed to `id` (stripping the u32 prefix)
// and returning once the buffer contains needle. JSON control frames and frames
// for other stream ids are skipped. Returns the accumulated bytes for `id`.
func readStreamUntilContains(t *testing.T, conn *websocket.Conn, id uint32, needle string, deadline time.Duration) []byte {
	t.Helper()
	end := time.Now().Add(deadline)
	var buf bytes.Buffer
	for time.Now().Before(end) {
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			if strings.Contains(err.Error(), "i/o timeout") || strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			return buf.Bytes()
		}
		if msgType != websocket.BinaryMessage || len(msg) < 4 {
			continue // control frame or short frame — skip
		}
		if binary.BigEndian.Uint32(msg[:4]) != id {
			continue // another stream's output
		}
		buf.Write(msg[4:])
		if bytes.Contains(buf.Bytes(), []byte(needle)) {
			return buf.Bytes()
		}
	}
	return buf.Bytes()
}

// awaitOpened reads frames until the `opened` control event for `id` arrives (or
// the deadline elapses). Returns (sawData, ok): sawData is true if ANY binary
// data frame for `id` was seen BEFORE the `opened` — the head-of-line ordering
// bug (M2) — and ok is true if `opened` arrived at all.
func awaitOpened(t *testing.T, conn *websocket.Conn, id uint32, deadline time.Duration) (sawDataFirst bool, ok bool) {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return sawDataFirst, false
		}
		if msgType == websocket.BinaryMessage && len(msg) >= 4 && binary.BigEndian.Uint32(msg[:4]) == id {
			sawDataFirst = true // a data frame for this id arrived before `opened`
			continue
		}
		if msgType != websocket.TextMessage {
			continue
		}
		var frame openedFrame
		if json.Unmarshal(msg, &frame) != nil {
			continue
		}
		if frame.Op == "opened" && frame.ID == id {
			return sawDataFirst, true
		}
	}
	return sawDataFirst, false
}

// listClients returns the tmux clients attached to `server` as
// "<width>x<height> <termname>" lines. Used to prove the relay attaches a client
// at the open op's initial size and with TERM forced to xterm-256color.
func listClients(t *testing.T, server string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	args := []string{}
	if server != "default" {
		args = append(args, "-L", server)
	}
	args = append(args, "list-clients", "-F", "#{client_width}x#{client_height} #{client_termname}")
	out, err := exec.CommandContext(ctx, "tmux", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("list-clients: %v\n%s", err, string(out))
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	result := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			result = append(result, strings.TrimSpace(l))
		}
	}
	return result
}

// awaitClosed reads control frames until a `closed` event for `id` arrives (or
// the deadline elapses), returning the close code (0 if none seen).
func awaitClosed(t *testing.T, conn *websocket.Conn, id uint32, deadline time.Duration) int {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return 0
		}
		if msgType != websocket.TextMessage {
			continue
		}
		var frame closedFrame
		if json.Unmarshal(msg, &frame) != nil {
			continue
		}
		if frame.Op == "closed" && frame.ID == id {
			return frame.Code
		}
	}
	return 0
}

// realSessionNames returns the non-pin, non-anchor session names on a tmux
// server. Used to assert the relay creates NO extra (ephemeral) session — the
// relay attaches the PTY directly to the window's owning session (its home
// session for an unpinned window, its pin-session for a pinned one).
func realSessionNames(t *testing.T, server string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sessions, err := tmux.ListSessions(ctx, server)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	names := make([]string, 0, len(sessions))
	for _, s := range sessions {
		names = append(names, s.Name)
	}
	return names
}

// TestTerminals_DirectAttachRendersSelectedWindow proves a stream attaches the
// PTY DIRECTLY to the real session and renders the window it selected — once per
// window. The streams are opened SEQUENTIALLY (not concurrently): both (unpinned)
// windows live in the SAME real session with a single shared active-window
// pointer (the accepted multi-client tradeoff #1), so two SIMULTANEOUS attaches
// would fight over that pointer. Sequential attaches exercise the direct-attach +
// select-window path per window without that race.
func TestTerminals_DirectAttachRendersSelectedWindow(t *testing.T) {
	tmuxServer, real, win0ID, win1ID := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	connA := dialTerminals(t, ts)
	openStream(t, connA, 1, tmuxServer, win0ID, 80, 24)
	bytesA := readStreamUntilContains(t, connA, 1, "WINDOW_ZERO", 5*time.Second)
	connA.Close()
	if !bytes.Contains(bytesA, []byte("WINDOW_ZERO")) {
		t.Errorf("stream for win0 did not receive WINDOW_ZERO marker; got: %q", string(bytesA))
	}

	connB := dialTerminals(t, ts)
	openStream(t, connB, 1, tmuxServer, win1ID, 80, 24)
	bytesB := readStreamUntilContains(t, connB, 1, "WINDOW_ONE", 5*time.Second)
	connB.Close()
	if !bytes.Contains(bytesB, []byte("WINDOW_ONE")) {
		t.Errorf("stream for win1 did not receive WINDOW_ONE marker; got: %q", string(bytesB))
	}

	// The mux must NOT create any extra (ephemeral) session — it attaches the
	// PTY directly to the real session. Only `real` should remain user-facing.
	names := realSessionNames(t, tmuxServer)
	for _, n := range names {
		if n != real {
			t.Errorf("unexpected extra session %q after stream open (no ephemeral expected); sessions=%v", n, names)
		}
	}
}

// activeWindowID returns the active window's @N for a session (via display-message).
func activeWindowID(t *testing.T, server, session string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server,
		"display-message", "-t", "="+session+":", "-p", "#{window_id}").CombinedOutput()
	if err != nil {
		t.Fatalf("display-message active window for %q: %v\n%s", session, err, string(out))
	}
	return strings.TrimSpace(string(out))
}

// TestTerminals_PinPreferenceAttachesPinSession proves the relay attach prefers a
// window's `_rk-pin-*` pin-session when it exists, and that merely VIEWING the
// pinned window does NOT move the home session's active-window pointer (the
// decided side benefit — R7). win1 is pinned (so it is linked into both `real`
// and its pin-session); `real`'s active window is left on win0. Opening a stream
// for win1 must render its content (attach worked) while `real` still points at
// win0.
func TestTerminals_PinPreferenceAttachesPinSession(t *testing.T) {
	tmuxServer, real, win0ID, win1ID := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	// Ensure real's active window is win0, then pin win1 (dual membership).
	if err := tmux.SelectWindowInSession(real, win0ID, tmuxServer); err != nil {
		t.Fatalf("select win0 in real: %v", err)
	}
	pinCtx, pinCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pinCancel()
	if err := tmux.Pin(pinCtx, tmuxServer, win1ID, "main"); err != nil {
		t.Fatalf("Pin win1: %v", err)
	}
	pinSession, _ := tmux.PinSessionName(win1ID)

	// Open a stream for the pinned window. The relay must prefer its pin-session.
	conn := dialTerminals(t, ts)
	openStream(t, conn, 1, tmuxServer, win1ID, 80, 24)
	got := readStreamUntilContains(t, conn, 1, "WINDOW_ONE", 5*time.Second)
	conn.Close()
	if !bytes.Contains(got, []byte("WINDOW_ONE")) {
		t.Errorf("stream for pinned win1 did not receive WINDOW_ONE marker; got: %q", string(got))
	}

	// The pin-session's sole window is win1 and is permanently active.
	if a := activeWindowID(t, tmuxServer, pinSession); a != win1ID {
		t.Errorf("pin-session active window = %q, want %q", a, win1ID)
	}
	// Side benefit: viewing the pinned window did NOT move home's active-window
	// pointer — `real` still points at win0.
	if a := activeWindowID(t, tmuxServer, real); a != win0ID {
		t.Errorf("home session active window moved to %q after viewing pinned window; want %q (viewing must not touch home's pointer)", a, win0ID)
	}
}

// TestTerminals_NoEphemeralCreated asserts a stream attaches directly to the
// real session and leaves NO ephemeral or extra session behind.
func TestTerminals_NoEphemeralCreated(t *testing.T) {
	tmuxServer, real, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()
	openStream(t, conn, 1, tmuxServer, win0ID, 80, 24)

	// Give the attach a moment to establish.
	_ = readStreamUntilContains(t, conn, 1, "WINDOW_ZERO", 3*time.Second)

	names := realSessionNames(t, tmuxServer)
	if len(names) != 1 || names[0] != real {
		t.Errorf("expected only the real session %q, got %v (mux must not create an ephemeral)", real, names)
	}
}

// TestTerminals_MissingWindowClosed4004 exercises the error path: opening a
// stream to a well-formed but non-existent window ID must yield a per-stream
// `closed` control event with code 4004 (session resolution fails), the SOCKET
// itself must stay open (a stream-level failure never closes the mux), and no
// extra session may leak on the tmux server.
func TestTerminals_MissingWindowClosed4004(t *testing.T) {
	tmuxServer, real, _, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	openStream(t, conn, 1, tmuxServer, "@9999", 80, 24)
	code := awaitClosed(t, conn, 1, 3*time.Second)
	if code != closeWindowNotFound {
		t.Errorf("closed code = %d, want %d (4004)", code, closeWindowNotFound)
	}

	// The socket must still be alive after a stream-level failure: a second
	// stream open on the SAME socket must succeed and render its window (proves
	// the 4004 was per-stream, not a socket teardown).
	windows, err := tmux.ListWindows(context.Background(), real, tmuxServer)
	if err != nil {
		t.Fatalf("list windows: %v", err)
	}
	var win0ID string
	for _, w := range windows {
		if w.Index == 0 {
			win0ID = w.WindowID
		}
	}
	if win0ID == "" {
		t.Fatalf("could not resolve win0 id from %+v", windows)
	}
	openStream(t, conn, 3, tmuxServer, win0ID, 80, 24)
	got := readStreamUntilContains(t, conn, 3, "WINDOW_ZERO", 5*time.Second)
	if !bytes.Contains(got, []byte("WINDOW_ZERO")) {
		t.Errorf("socket dead after per-stream 4004: second stream got %q", string(got))
	}

	// Verify no extra session leaked — only the real session should remain.
	names := realSessionNames(t, tmuxServer)
	for _, n := range names {
		if n != real {
			t.Errorf("unexpected extra session %q after missing-window stream; sessions=%v", n, names)
		}
	}
}

// TestTerminals_BadWindowIDClosed4004 is a regression on the validation gate:
// a malformed window ID in the `open` op must be rejected with a per-stream
// `closed` 4004 (via the shared validate.ValidateWindowID) rather than reaching
// any tmux interaction — the mux equivalent of handleRelay's pre-upgrade 400.
// Uses the mock tmux ops so no live server is required.
func TestTerminals_BadWindowIDClosed4004(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	router := NewTestRouter(logger, &mockSessionFetcher{}, &mockTmuxOps{}, "test-host")
	ts := httptest.NewServer(router)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	// A window ID that fails validate.ValidateWindowID (no leading '@').
	openStream(t, conn, 7, "default", "not-a-window-id", 80, 24)
	code := awaitClosed(t, conn, 7, 3*time.Second)
	if code != closeWindowNotFound {
		t.Errorf("closed code = %d, want %d (4004) for a malformed window ID", code, closeWindowNotFound)
	}
}

// TestTerminals_OpenedPrecedesData proves the server replies `opened` for a
// successful stream open AND that `opened` is delivered BEFORE the stream's
// first data frame (M2 — the client arms its deferred per-stream reset on
// `opened`, so a data-before-opened frame would repaint over un-reset content).
func TestTerminals_OpenedPrecedesData(t *testing.T) {
	tmuxServer, _, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	openStream(t, conn, 1, tmuxServer, win0ID, 80, 24)
	sawDataFirst, ok := awaitOpened(t, conn, 1, 5*time.Second)
	if !ok {
		t.Fatal("never received `opened` for a successful stream open")
	}
	if sawDataFirst {
		t.Error("a data frame arrived BEFORE `opened` (head-of-line ordering bug — M2)")
	}
}

// TestTerminals_InitialSizeAndTERM proves the stream attaches a tmux client at
// the open op's initial cols/rows (replacing the wait-for-first-resize dance)
// and with TERM forced to xterm-256color (forceTERM). Both are read directly
// from tmux via list-clients after the stream opens.
func TestTerminals_InitialSizeAndTERM(t *testing.T) {
	tmuxServer, _, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	// A distinctive non-default size so the assertion can't pass by accident on
	// tmux's 80x24 default.
	const cols, rows = 100, 40
	openStream(t, conn, 1, tmuxServer, win0ID, cols, rows)
	if _, ok := awaitOpened(t, conn, 1, 5*time.Second); !ok {
		t.Fatal("stream never opened")
	}

	// Give the attach a beat to register its client, then assert size + TERM.
	var clients []string
	if !testutil.WaitUntil(t, 3*time.Second, func() bool {
		clients = listClients(t, tmuxServer)
		return len(clients) > 0
	}) {
		t.Fatal("no tmux client attached after stream open")
	}
	want := "100x40 xterm-256color"
	found := false
	for _, c := range clients {
		if c == want {
			found = true
		}
	}
	if !found {
		t.Errorf("no client at initial size + forced TERM; want %q, clients=%v", want, clients)
	}
}

// TestTerminals_ResizeSetsClientSize proves a `resize` control op re-sizes the
// live stream's PTY (observed via the attached tmux client's dimensions).
func TestTerminals_ResizeSetsClientSize(t *testing.T) {
	tmuxServer, _, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	openStream(t, conn, 1, tmuxServer, win0ID, 80, 24)
	if _, ok := awaitOpened(t, conn, 1, 5*time.Second); !ok {
		t.Fatal("stream never opened")
	}

	// Send a resize to a distinctive new size.
	resize, _ := json.Marshal(map[string]any{"op": "resize", "id": 1, "cols": 120, "rows": 50})
	if err := conn.WriteMessage(websocket.TextMessage, resize); err != nil {
		t.Fatalf("write resize: %v", err)
	}

	if !testutil.WaitUntil(t, 3*time.Second, func() bool {
		for _, c := range listClients(t, tmuxServer) {
			if strings.HasPrefix(c, "120x50 ") {
				return true // resize applied
			}
		}
		return false
	}) {
		t.Errorf("resize op did not re-size the PTY to 120x50; clients=%v", listClients(t, tmuxServer))
	}
}

// TestTerminals_ClientCloseYields1000 proves a client `close` op tears the
// stream down and replies `closed` with code 1000 (graceful), and leaves no
// extra session behind.
func TestTerminals_ClientCloseYields1000(t *testing.T) {
	tmuxServer, real, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	openStream(t, conn, 1, tmuxServer, win0ID, 80, 24)
	if _, ok := awaitOpened(t, conn, 1, 5*time.Second); !ok {
		t.Fatal("stream never opened")
	}

	closeOp, _ := json.Marshal(map[string]any{"op": "close", "id": 1})
	if err := conn.WriteMessage(websocket.TextMessage, closeOp); err != nil {
		t.Fatalf("write close: %v", err)
	}

	code := awaitClosed(t, conn, 1, 3*time.Second)
	if code != closeNormal {
		t.Errorf("closed code = %d, want %d (1000) for a client close op", code, closeNormal)
	}

	// No ephemeral session leaked by the direct-attach + teardown.
	names := realSessionNames(t, tmuxServer)
	for _, n := range names {
		if n != real {
			t.Errorf("unexpected extra session %q after client close; sessions=%v", n, names)
		}
	}
}

// --- Isolated relay sessions (`isolate: true` on the open op) ---

// openStreamIsolate sends an `open` control op with isolate:true.
func openStreamIsolate(t *testing.T, conn *websocket.Conn, id uint32, tmuxServer, windowID string, cols, rows uint16) {
	t.Helper()
	op := openOp{Op: "open", ID: id, Server: tmuxServer, WindowID: windowID, Cols: cols, Rows: rows, Isolate: true}
	body, err := json.Marshal(op)
	if err != nil {
		t.Fatalf("marshal open op: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, body); err != nil {
		t.Fatalf("write open op: %v", err)
	}
}

// isoDestroyUnattached reads the session's destroy-unattached option value.
func isoDestroyUnattached(t *testing.T, server, session string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server,
		"show-options", "-t", session, "-v", "destroy-unattached").CombinedOutput()
	if err != nil {
		t.Fatalf("show-options destroy-unattached on %q: %v\n%s", session, err, string(out))
	}
	return strings.TrimSpace(string(out))
}

// isoSessionAlive reports whether the named session exists on the server.
func isoSessionAlive(t *testing.T, server, session string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return tmux.HasSession(ctx, server, session)
}

// TestTerminals_IsolatedStreamsKeepOwnWindows proves two isolated streams on
// SIBLING windows of one session each keep rendering their own window — the
// fight over home's single active-window pointer is gone because each stream
// attaches through its own `_rk-iso-*` session — and that the isolated opens
// never move the home session's active window (the SPA reads that as
// navigation). It also pins the lifecycle: the chained attach argv sets
// destroy-unattached on each iso session, and closing the socket (both attach
// clients die) lets tmux reap both iso sessions while the windows stay in home.
func TestTerminals_IsolatedStreamsKeepOwnWindows(t *testing.T) {
	tmuxServer, real, win0ID, win1ID := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	iso0, _ := tmux.IsoSessionName(win0ID)
	iso1, _ := tmux.IsoSessionName(win1ID)

	// Home's active window starts on win0.
	if err := tmux.SelectWindowInSession(real, win0ID, tmuxServer); err != nil {
		t.Fatalf("select win0 in home: %v", err)
	}

	conn := dialTerminals(t, ts)
	openStreamIsolate(t, conn, 1, tmuxServer, win0ID, 80, 24)
	openStreamIsolate(t, conn, 2, tmuxServer, win1ID, 80, 24)

	// One tolerant read loop collects both streams' markers (sequential
	// readStreamUntilContains calls would discard the other stream's frames and
	// a real read error on the first call would poison the second).
	var buf0, buf1 []byte
	end := time.Now().Add(6 * time.Second)
	for time.Now().Before(end) && (!bytes.Contains(buf0, []byte("WINDOW_ZERO")) || !bytes.Contains(buf1, []byte("WINDOW_ONE"))) {
		conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			if strings.Contains(err.Error(), "i/o timeout") || strings.Contains(err.Error(), "deadline exceeded") {
				continue
			}
			t.Fatalf("read error before both markers (buf0=%q buf1=%q): %v", string(buf0), string(buf1), err)
		}
		if msgType != websocket.BinaryMessage || len(msg) < 4 {
			continue
		}
		switch binary.BigEndian.Uint32(msg[:4]) {
		case 1:
			buf0 = append(buf0, msg[4:]...)
		case 2:
			buf1 = append(buf1, msg[4:]...)
		}
	}
	if !bytes.Contains(buf0, []byte("WINDOW_ZERO")) {
		t.Errorf("isolated stream 1 did not render win0; got: %q", string(buf0))
	}
	if !bytes.Contains(buf1, []byte("WINDOW_ONE")) {
		t.Errorf("isolated stream 2 did not render win1; got: %q", string(buf1))
	}

	// Each iso session holds exactly its own window, permanently active.
	if a := activeWindowID(t, tmuxServer, iso0); a != win0ID {
		t.Errorf("%s active window = %q, want %q", iso0, a, win0ID)
	}
	if a := activeWindowID(t, tmuxServer, iso1); a != win1ID {
		t.Errorf("%s active window = %q, want %q", iso1, a, win1ID)
	}
	// The isolated opens did not move home's active-window pointer.
	if a := activeWindowID(t, tmuxServer, real); a != win0ID {
		t.Errorf("home active window = %q after isolated opens, want %q (opens must not touch home's pointer)", a, win0ID)
	}
	// The chained attach argv set the lifecycle option on both iso sessions.
	if v := isoDestroyUnattached(t, tmuxServer, iso0); v != "on" {
		t.Errorf("%s destroy-unattached = %q after attach, want on", iso0, v)
	}
	if v := isoDestroyUnattached(t, tmuxServer, iso1); v != "on" {
		t.Errorf("%s destroy-unattached = %q after attach, want on", iso1, v)
	}

	// Socket teardown kills both attach clients; as the last clients of their
	// iso sessions, tmux reaps both sessions while the windows stay in home.
	conn.Close()
	if !testutil.WaitUntil(t, 5*time.Second, func() bool {
		return !isoSessionAlive(t, tmuxServer, iso0) && !isoSessionAlive(t, tmuxServer, iso1)
	}) {
		t.Errorf("iso sessions %q/%q survived socket teardown — destroy-unattached must reap them", iso0, iso1)
	}
	windows, err := tmux.ListWindows(context.Background(), real, tmuxServer)
	if err != nil {
		t.Fatalf("list home windows: %v", err)
	}
	alive := map[string]bool{}
	for _, w := range windows {
		alive[w.WindowID] = true
	}
	if !alive[win0ID] || !alive[win1ID] {
		t.Errorf("windows missing from home after iso reap: win0=%v win1=%v (windows must stay in home)", alive[win0ID], alive[win1ID])
	}
}

// TestTerminals_IsoSharedSessionSurvivesFirstClientDeath proves the sharing
// contract: two isolated viewers of the SAME window share one `_rk-iso-*`
// session, killing the first viewer's attach client leaves the session alive
// for the second, and the session is reaped only when the LAST client dies.
func TestTerminals_IsoSharedSessionSurvivesFirstClientDeath(t *testing.T) {
	tmuxServer, _, win0ID, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	iso, _ := tmux.IsoSessionName(win0ID)

	connA := dialTerminals(t, ts)
	openStreamIsolate(t, connA, 1, tmuxServer, win0ID, 80, 24)
	if _, ok := awaitOpened(t, connA, 1, 5*time.Second); !ok {
		t.Fatal("stream A never opened")
	}
	connB := dialTerminals(t, ts)
	defer connB.Close()
	openStreamIsolate(t, connB, 1, tmuxServer, win0ID, 80, 24)
	if _, ok := awaitOpened(t, connB, 1, 5*time.Second); !ok {
		t.Fatal("stream B never opened")
	}
	if !isoSessionAlive(t, tmuxServer, iso) {
		t.Fatalf("iso session %q missing after two isolated opens", iso)
	}

	// Kill the first viewer (socket teardown SIGKILLs its attach client): the
	// second viewer still holds the session, so it must survive.
	connA.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !isoSessionAlive(t, tmuxServer, iso) {
			t.Fatalf("iso session %q reaped while a second client was still attached", iso)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got := readStreamUntilContains(t, connB, 1, "WINDOW_ZERO", 3*time.Second); !bytes.Contains(got, []byte("WINDOW_ZERO")) {
		t.Errorf("surviving viewer's stream lost its window content; got: %q", string(got))
	}

	// The last client's death reaps the session; the window stays in home.
	connB.Close()
	if !testutil.WaitUntil(t, 5*time.Second, func() bool { return !isoSessionAlive(t, tmuxServer, iso) }) {
		t.Errorf("iso session %q survived its last client's death", iso)
	}
	if !isoSessionAlive(t, tmuxServer, "real") {
		t.Error("home session missing after iso reap")
	}
}

// TestTerminals_IsoMissingWindowClosed4004 proves an isolated open on a
// well-formed but nonexistent window id yields a per-stream `closed` 4004 and
// leaks no `_rk-iso-*` session (the ensure rolls its creation back).
func TestTerminals_IsoMissingWindowClosed4004(t *testing.T) {
	tmuxServer, _, _, _ := withTerminalsTmux(t)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()

	openStreamIsolate(t, conn, 1, tmuxServer, "@9999", 80, 24)
	if code := awaitClosed(t, conn, 1, 3*time.Second); code != closeWindowNotFound {
		t.Errorf("closed code = %d, want %d (4004)", code, closeWindowNotFound)
	}
	iso, _ := tmux.IsoSessionName("@9999")
	if isoSessionAlive(t, tmuxServer, iso) {
		t.Errorf("iso session %q leaked after a missing-window ensure", iso)
	}
}
