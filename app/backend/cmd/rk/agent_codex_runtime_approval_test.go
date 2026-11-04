package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/tmux"

	"github.com/gorilla/websocket"
)

// TestCodexRuntimeHumanApproval spends one real model turn in an owned Codex
// app-server with a temporary CODEX_HOME, copied login, read-only sandbox, and
// private tmux server. It approves only the exact harmless command/cwd below.
// The two disposable marker files prove active is observed AFTER execution
// starts and BEFORE the approved long-running command finishes.
//
// The initial PermissionRequest hook is replayed through the production handler
// using the real request's thread/turn/transcript metadata; app-server hook trust
// is not part of this test. Approval, execution, and read-side reconciliation use
// the real runtime. No live daemon, user configuration, or user tmux is changed.
//
// Run: RK_CODEX_RUNTIME_TEST=1 GOFLAGS='-run=^TestCodexRuntimeHumanApproval$' just test-backend
func TestCodexRuntimeHumanApproval(t *testing.T) {
	if os.Getenv("RK_CODEX_RUNTIME_TEST") != "1" {
		t.Skip("set RK_CODEX_RUNTIME_TEST=1 to exercise real manual approval in a temporary app-server")
	}
	for _, tool := range []string{"codex", "tmux"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatalf("runtime test requires %s: %v", tool, err)
		}
	}

	rig, home, workspace := codexApprovalRig(t)
	t.Setenv("CODEX_HOME", home)
	server := fmt.Sprintf("rk-test-codex-approval-%d-%d", os.Getpid(), time.Now().UnixNano())
	runTmux := func(args ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "tmux", append([]string{"-L", server}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("private tmux command failed: %v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	runTmux("new-session", "-d", "-s", "approval", "-c", workspace, "sleep", "240")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "tmux", "-L", server, "kill-server").Run()
	})
	runTmux("set-option", "-s", "@rk_srv_ephemeral", "1")
	pane := runTmux("display-message", "-p", "#{pane_id}")
	t.Setenv("TMUX_PANE", pane)
	setOriginalTMUX(t, runTmux("display-message", "-p", "#{socket_path}")+",1,0")

	socket := filepath.Join(home, "app-server-control", "app-server-control.sock")
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	t.Cleanup(cancel)
	codexApprovalServer(t, ctx, cancel, rig, workspace, socket)
	conn := codexApprovalConnect(t, ctx, socket)
	t.Cleanup(func() { _ = conn.Close() })
	client := codexApprovalRPC{t: t, conn: conn}
	client.send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{
		"clientInfo":   map[string]string{"name": "hexokit_approval_test", "version": "0.1"},
		"capabilities": map[string]bool{"experimentalApi": true},
	}})
	client.response(1)
	client.send(map[string]any{"method": "initialized", "params": map[string]any{}})
	client.send(map[string]any{"id": 2, "method": "thread/start", "params": map[string]any{
		"cwd": workspace, "sandbox": "read-only", "approvalPolicy": "on-request", "approvalsReviewer": "user",
		"config": map[string]any{"model_reasoning_effort": "low"},
	}})
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(client.response(2), &started); err != nil || started.Thread.ID == "" {
		t.Fatalf("thread/start returned no thread identity: %v", err)
	}
	const command = "printf hook-started > started.txt; sleep 8; printf hook-probe > probe.txt"
	prompt := "This is an isolated approval compatibility test. Use the shell tool exactly once to run this exact command, without modification: " + command +
		" . Request require_escalated permission because the sandbox is read-only. Both files belong only to this disposable workspace. Do not inspect or modify any other path, and do not use other tools. After the command succeeds, reply DONE."
	client.send(map[string]any{"id": 3, "method": "turn/start", "params": map[string]any{
		"threadId": started.Thread.ID, "effort": "low",
		"input": []map[string]string{{"type": "text", "text": prompt}},
	}})
	approval := client.approval(started.Thread.ID, workspace, command)
	client.send(map[string]any{"id": 4, "method": "thread/read", "params": map[string]string{"threadId": started.Thread.ID}})
	var read struct {
		Thread struct {
			Path string `json:"path"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(client.response(4), &read); err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(home, read.Thread.Path)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatal("thread/read did not identify a transcript inside the disposable Codex home")
	}
	payload, _ := json.Marshal(map[string]any{
		"session_id": started.Thread.ID, "turn_id": approval.TurnID, "transcript_path": read.Thread.Path,
		"cwd": workspace, "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": map[string]string{"command": command},
	})
	setHookStdin(t, string(payload))
	runAgentHook(ctx, "codex", "waiting")
	state, err := tmux.PaneAgentState(ctx, pane, server)
	if err != nil || state != "waiting" {
		t.Fatalf("before real approval: state=%q, error=%v; expected waiting", state, err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "started.txt")); !os.IsNotExist(err) {
		t.Fatal("probe started before the test approved it")
	}
	t.Log("real manual approval pending; replayed PermissionRequest establishes waiting")
	client.send(map[string]any{"id": approval.ID, "result": map[string]string{"decision": "accept"}})
	codexApprovalEventually(t, 3*time.Second, func() bool {
		_, err := os.Stat(filepath.Join(workspace, "started.txt"))
		return err == nil
	}, "approved command did not start")
	codexApprovalEventually(t, 3*time.Second, func() bool {
		state, err := tmux.PaneAgentState(ctx, pane, server)
		return err == nil && state == "active"
	}, "approved running command retained waiting")
	if _, err := os.Stat(filepath.Join(workspace, "probe.txt")); !os.IsNotExist(err) {
		t.Fatal("active was not observed before command completion")
	}
	t.Log("real command started; production reader is active while its completion marker is absent")
	client.completed(started.Thread.ID)
	probe, err := os.ReadFile(filepath.Join(workspace, "probe.txt"))
	if err != nil || string(probe) != "hook-probe" {
		t.Fatalf("approved command did not complete its harmless probe: %v", err)
	}
	codexApprovalEventually(t, 3*time.Second, func() bool {
		state, err := tmux.PaneAgentState(ctx, pane, server)
		return err == nil && state == "idle"
	}, "completed runtime did not reconcile to idle")
	t.Log("real turn completed; production reader is idle without replaying a completion hook")
}

func codexApprovalRig(t *testing.T) (rig, home, workspace string) {
	t.Helper()
	loginHome := os.Getenv("CODEX_HOME")
	if loginHome == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
		loginHome = filepath.Join(userHome, ".codex")
	}
	auth, err := os.ReadFile(filepath.Join(loginHome, "auth.json"))
	if err != nil {
		t.Fatal("runtime test requires an existing Codex auth.json login")
	}
	// A short /tmp root keeps the control-socket path below sockaddr_un's limit.
	rig, err = os.MkdirTemp("/tmp", "rk-codex-approval-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(rig) })
	home, workspace = filepath.Join(rig, "codex"), filepath.Join(rig, "workspace")
	for _, dir := range []string{home, workspace} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), auth, 0o600); err != nil {
		t.Fatal(err)
	}
	config := "approvals_reviewer = \"user\"\napproval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\nmodel_reasoning_effort = \"low\"\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	return rig, home, workspace
}

func codexApprovalServer(t *testing.T, ctx context.Context, cancel context.CancelFunc, rig, workspace, socket string) {
	t.Helper()
	log, err := os.OpenFile(filepath.Join(rig, "app-server.log"), os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "codex", "app-server", "--listen", "unix://"+socket)
	cmd.Dir = workspace
	shellHome := filepath.Join(rig, "shell-home")
	if err := os.Mkdir(shellHome, 0o700); err != nil {
		_ = log.Close()
		t.Fatal(err)
	}
	cmd.Env = append(os.Environ(), "HOME="+shellHome, "XDG_CONFIG_HOME="+filepath.Join(shellHome, ".config"),
		"XDG_DATA_HOME="+filepath.Join(shellHome, ".local/share"), "XDG_STATE_HOME="+filepath.Join(shellHome, ".local/state"))
	cmd.Stdout, cmd.Stderr = log, log
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		_ = log.Close()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(6 * time.Second):
			_ = cmd.Process.Kill()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Errorf("owned app-server did not exit after cancellation and kill")
			}
		}
		_ = log.Close()
	})
}

func codexApprovalConnect(t *testing.T, ctx context.Context, socket string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{HandshakeTimeout: 2 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	var conn *websocket.Conn
	codexApprovalEventually(t, 15*time.Second, func() bool {
		var err error
		conn, _, err = dialer.DialContext(ctx, "ws://localhost/", http.Header{})
		return err == nil
	}, "owned Codex app-server did not expose its control socket")
	conn.SetReadLimit(2 << 20)
	return conn
}

type codexApprovalMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type codexApprovalRequest struct {
	ID       json.RawMessage `json:"-"`
	ThreadID string          `json:"threadId"`
	TurnID   string          `json:"turnId"`
	Command  string          `json:"command"`
	CWD      string          `json:"cwd"`
}

type codexApprovalRPC struct {
	t    *testing.T
	conn *websocket.Conn
}

func (c codexApprovalRPC) send(value any) {
	c.t.Helper()
	_ = c.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if err := c.conn.WriteJSON(value); err != nil {
		c.t.Fatal(err)
	}
}

func (c codexApprovalRPC) next() codexApprovalMessage {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	var msg codexApprovalMessage
	if err := c.conn.ReadJSON(&msg); err != nil {
		c.t.Fatal(err)
	}
	if len(msg.Error) > 0 && string(msg.Error) != "null" {
		c.t.Fatalf("Codex RPC error: %.500s", msg.Error)
	}
	return msg
}

func (c codexApprovalRPC) reject(msg codexApprovalMessage) {
	c.t.Helper()
	if msg.Method == "item/commandExecution/requestApproval" {
		c.send(map[string]any{"id": msg.ID, "result": map[string]string{"decision": "cancel"}})
	} else {
		c.send(map[string]any{"id": msg.ID, "error": map[string]any{"code": -32601, "message": "unexpected request in isolated approval test"}})
	}
	c.t.Fatalf("refused unexpected server request %q", msg.Method)
}

func (c codexApprovalRPC) response(id int) json.RawMessage {
	c.t.Helper()
	for {
		msg := c.next()
		if msg.Method != "" && len(msg.ID) > 0 {
			c.reject(msg)
		}
		if string(msg.ID) == fmt.Sprint(id) {
			return msg.Result
		}
	}
}

func (c codexApprovalRPC) approval(thread, cwd, command string) codexApprovalRequest {
	c.t.Helper()
	for {
		msg := c.next()
		if msg.Method == "turn/completed" {
			c.t.Fatal("turn completed without requesting the required manual approval")
		}
		if msg.Method == "" || len(msg.ID) == 0 {
			continue
		}
		var request codexApprovalRequest
		if msg.Method != "item/commandExecution/requestApproval" || json.Unmarshal(msg.Params, &request) != nil ||
			request.ThreadID != thread || !codexApprovalExactCommand(request.Command, command) || filepath.Clean(request.CWD) != cwd || request.TurnID == "" {
			c.t.Logf("approval guard: command=%.500q cwd=%.300q matchingThread=%t turnPresent=%t", request.Command, request.CWD, request.ThreadID == thread, request.TurnID != "")
			c.reject(msg)
		}
		request.ID = msg.ID
		return request
	}
}

// Codex's approval API displays its shell argv as one quoted string. Match
// fixed known wrappers around the COMPLETE fixed probe, never a prefix or a
// parsed free-form shell expression. The owned server also has a temporary
// shell HOME, so a login shell cannot load the user's startup configuration.
func codexApprovalExactCommand(display, command string) bool {
	if display == command {
		return true
	}
	for _, shell := range []string{"/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"} {
		for _, flag := range []string{"-lc", "-c"} {
			if display == shell+" "+flag+" '"+command+"'" {
				return true
			}
		}
	}
	return false
}

func (c codexApprovalRPC) completed(thread string) {
	c.t.Helper()
	for {
		msg := c.next()
		if msg.Method != "" && len(msg.ID) > 0 {
			c.reject(msg)
		}
		if msg.Method == "turn/completed" {
			var event struct {
				ThreadID string `json:"threadId"`
				Turn     struct {
					Status string `json:"status"`
				} `json:"turn"`
			}
			if json.Unmarshal(msg.Params, &event) != nil || event.ThreadID != thread || event.Turn.Status != "completed" {
				c.t.Fatal("probe turn did not complete successfully")
			}
			return
		}
	}
}

func codexApprovalEventually(t *testing.T, duration time.Duration, check func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(duration)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal(message)
}
