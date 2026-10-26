// Package codexstatus reads the local Codex daemon without loading, resuming,
// or subscribing to conversations. Missing daemons and unknown protocol data
// leave callers' hook state authoritative.
package codexstatus

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	Timeout          = 300 * time.Millisecond
	maxMessageBytes  = 2 << 20
	maxThreads       = 32
	maxNotifications = 64
)

var (
	sessionIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	errUnavailable   = errors.New("Codex status unavailable")
)

// Thread contains only the summary fields needed to reconcile attention.
type Thread struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Status struct {
		Type        string   `json:"type"`
		ActiveFlags []string `json:"activeFlags"`
	} `json:"status"`
}

// ResumedState returns a lifecycle state only when runtime positively reports
// no human wait. Unknown flags and missing activeFlags must not hide attention.
func (t Thread) ResumedState() string {
	switch t.Status.Type {
	case "idle":
		if len(t.Status.ActiveFlags) == 0 {
			return "idle"
		}
	case "active":
		if t.Status.ActiveFlags != nil && len(t.Status.ActiveFlags) == 0 {
			return "active"
		}
	}
	return ""
}

// Read queries at most 32 distinct valid session IDs over one connection. Its
// entire batch, including handshake and initialization, shares a 300 ms budget.
// An absent socket (including standalone --no-daemon Codex) is ordinary fallback;
// this reader never starts a daemon. Partial successes survive a later failure.
func Read(ctx context.Context, sessionIDs []string) map[string]Thread {
	ids := uniqueSessionIDs(sessionIDs)
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	root := os.Getenv("CODEX_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		root = filepath.Join(home, ".codex")
	}
	socket := filepath.Join(root, "app-server-control", "app-server-control.sock")
	dialer := websocket.Dialer{
		HandshakeTimeout: Timeout,
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	conn, _, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if err != nil {
		return nil
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	conn.SetReadLimit(maxMessageBytes)
	_, err = request(conn, 0, "initialize", map[string]any{
		"clientInfo": map[string]string{"name": "hexokit_status", "version": "1"},
	})
	if err != nil || conn.WriteJSON(map[string]any{"method": "initialized", "params": map[string]any{}}) != nil {
		return nil
	}
	result := make(map[string]Thread)
	for i, id := range ids {
		if ctx.Err() != nil {
			break
		}
		raw, err := request(conn, i+1, "thread/read", map[string]any{"threadId": id})
		if errors.Is(err, errUnavailable) {
			continue
		}
		if err != nil {
			break
		}
		var response struct {
			Thread Thread `json:"thread"`
		}
		if json.Unmarshal(raw, &response) == nil && strings.EqualFold(response.Thread.ID, id) {
			result[id] = response.Thread
		}
	}
	return result
}

func uniqueSessionIDs(sessionIDs []string) []string {
	var ids []string
	seen := make(map[string]bool)
	for _, id := range sessionIDs {
		if !sessionIDPattern.MatchString(id) || seen[strings.ToLower(id)] {
			continue
		}
		seen[strings.ToLower(id)] = true
		ids = append(ids, id)
		if len(ids) == maxThreads {
			break
		}
	}
	return ids
}

func request(conn *websocket.Conn, id int, method string, params any) (json.RawMessage, error) {
	if err := conn.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	for range maxNotifications {
		var reply struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := conn.ReadJSON(&reply); err != nil {
			return nil, err
		}
		if reply.ID == nil || *reply.ID != id {
			continue
		}
		if len(reply.Error) != 0 && string(reply.Error) != "null" {
			return nil, errUnavailable
		}
		return reply.Result, nil
	}
	return nil, errors.New("Codex status response limit")
}
