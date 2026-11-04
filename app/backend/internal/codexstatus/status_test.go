package codexstatus

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const testSession = "11111111-2222-4333-8444-555555555555"

func serveCodexStatus(t *testing.T, handle func(*websocket.Conn)) *atomic.Int32 {
	t.Helper()
	// The Unix socket path must fit the platform's sockaddr_un limit.
	root, err := os.MkdirTemp("/tmp", "rk-codex-status-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("CODEX_HOME", root)
	dir := filepath.Join(root, "app-server-control")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "app-server-control.sock"))
	if err != nil {
		t.Fatal(err)
	}
	connections := &atomic.Int32{}
	server := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		connections.Add(1)
		handle(conn)
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close(); _ = listener.Close() })
	return connections
}

type testRequest struct {
	ID     int            `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

func initializedStatusServer(t *testing.T, conn *websocket.Conn) bool {
	t.Helper()
	var req testRequest
	if err := conn.ReadJSON(&req); err != nil {
		t.Error(err)
		return false
	}
	if req.Method != "initialize" {
		t.Errorf("first method = %q", req.Method)
		return false
	}
	if err := conn.WriteJSON(map[string]any{"id": req.ID, "result": map[string]any{}}); err != nil {
		return false
	}
	if err := conn.ReadJSON(&req); err != nil {
		t.Error(err)
		return false
	}
	if req.Method != "initialized" {
		t.Errorf("second method = %q", req.Method)
		return false
	}
	return true
}

func TestCodexStatusBatchIsReadOnly(t *testing.T) {
	second := "66666666-7777-4888-8999-000000000000"
	connections := serveCodexStatus(t, func(conn *websocket.Conn) {
		if !initializedStatusServer(t, conn) {
			return
		}
		for _, id := range []string{testSession, second} {
			var req testRequest
			if err := conn.ReadJSON(&req); err != nil {
				t.Error(err)
				return
			}
			if req.Method != "thread/read" || req.Params["threadId"] != id || len(req.Params) != 1 {
				t.Errorf("unexpected read-only request: %+v", req)
			}
			_ = conn.WriteJSON(map[string]any{"method": "thread/status/changed", "params": map[string]any{}})
			_ = conn.WriteJSON(map[string]any{"id": req.ID, "result": map[string]any{"thread": map[string]any{
				"id": id, "path": "/tmp/rollout.jsonl", "status": map[string]any{"type": "active", "activeFlags": []string{}},
			}}})
		}
	})
	got := Read(context.Background(), []string{"../../invalid", testSession, testSession, second})
	if len(got) != 2 || got[testSession].ResumedState() != "active" || got[second].Path != "/tmp/rollout.jsonl" {
		t.Fatalf("Read = %+v", got)
	}
	if connections.Load() != 1 {
		t.Fatalf("connections = %d, want1", connections.Load())
	}
}

func TestCodexStatusUnknownKeepsAttention(t *testing.T) {
	for _, tc := range []struct{ status, want string }{
		{`{"type":"active","activeFlags":[]}`, "active"},
		{`{"type":"idle"}`, "idle"},
		{`{"type":"active","activeFlags":["waitingOnApproval"]}`, ""},
		{`{"type":"active","activeFlags":["waitingOnUserInput"]}`, ""},
		{`{"type":"active","activeFlags":["futureFlag"]}`, ""},
		{`{"type":"active"}`, ""},
		{`{"type":"notLoaded"}`, ""},
		{`{"type":"systemError"}`, ""},
	} {
		var thread Thread
		if err := json.Unmarshal([]byte(`{"status":`+tc.status+`}`), &thread); err != nil {
			t.Fatal(err)
		}
		if got := thread.ResumedState(); got != tc.want {
			t.Errorf("status %s = %q, want%q", tc.status, got, tc.want)
		}
	}
}

func TestCodexStatusUnavailableThreadDoesNotBlockBatch(t *testing.T) {
	missing := "66666666-7777-4888-8999-000000000000"
	serveCodexStatus(t, func(conn *websocket.Conn) {
		if !initializedStatusServer(t, conn) {
			return
		}
		for _, id := range []string{missing, testSession} {
			var req testRequest
			if err := conn.ReadJSON(&req); err != nil {
				t.Error(err)
				return
			}
			if id == missing {
				_ = conn.WriteJSON(map[string]any{"id": req.ID, "error": map[string]any{"code": -1}})
			} else {
				_ = conn.WriteJSON(map[string]any{"id": req.ID, "result": map[string]any{"thread": map[string]any{"id": id, "status": map[string]any{"type": "idle"}}}})
			}
		}
	})
	got := Read(context.Background(), []string{missing, testSession})
	if len(got) != 1 || got[testSession].ResumedState() != "idle" {
		t.Fatalf("available thread lost after missing thread: %+v", got)
	}
}

func TestCodexStatusFailures(t *testing.T) {
	for _, kind := range []string{"wrong-owner", "rpc-error", "oversized", "malformed", "notification-flood", "no-reply"} {
		t.Run(kind, func(t *testing.T) {
			serveCodexStatus(t, func(conn *websocket.Conn) {
				if !initializedStatusServer(t, conn) {
					return
				}
				var req testRequest
				if err := conn.ReadJSON(&req); err != nil {
					return
				}
				switch kind {
				case "wrong-owner":
					_ = conn.WriteJSON(map[string]any{"id": req.ID, "result": map[string]any{"thread": map[string]any{"id": "another-thread", "status": map[string]any{"type": "idle"}}}})
				case "rpc-error":
					_ = conn.WriteJSON(map[string]any{"id": req.ID, "error": map[string]any{"code": -1}})
				case "oversized":
					_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"id":%d,"result":"%s"}`, req.ID, strings.Repeat("x", maxMessageBytes))))
				case "malformed":
					_ = conn.WriteMessage(websocket.TextMessage, []byte("{"))
				case "notification-flood":
					for range maxNotifications + 1 {
						_ = conn.WriteJSON(map[string]any{"method": "unrelated"})
					}
				case "no-reply":
					_, _, _ = conn.ReadMessage() // unblocks when the bounded client closes
				}
			})
			start := time.Now()
			if got := Read(context.Background(), []string{testSession}); len(got) != 0 {
				t.Errorf("Read = %+v, want no trusted status", got)
			}
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Errorf("unbounded read: %v", elapsed)
			}
		})
	}
}

func TestCodexStatusMissingDaemonAndCancellation(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	if got := Read(context.Background(), []string{testSession}); len(got) != 0 {
		t.Fatalf("missing daemon = %+v", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := Read(ctx, []string{testSession}); len(got) != 0 {
		t.Fatalf("cancelled read = %+v", got)
	}
}

func TestCodexStatusBatchBound(t *testing.T) {
	var ids []string
	for i := range 100 {
		ids = append(ids, fmt.Sprintf("%08x-2222-4333-8444-555555555555", i))
	}
	if got := uniqueSessionIDs(ids); len(got) != maxThreads {
		t.Fatalf("batch size=%d,want%d", len(got), maxThreads)
	}
}
