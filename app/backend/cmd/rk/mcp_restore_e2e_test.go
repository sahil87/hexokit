package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"rk/internal/snapshot"
)

// mcp_restore_e2e_test.go is the black-box proof that an MCP-only agent can
// run the `rk skill restore` procedure. A REAL rk binary serves `rk mcp` over
// stdio to a REAL MCP client, and the client walks the page's "Over MCP"
// steps against a REAL tmux server:
//
//  1. skill_topic(topic: restore) returns the page; a non-topic is rejected
//     by the schema before anything execs;
//  2. snapshot_list shows a live-latest row while inventory finds no server
//     (the daemon died with it);
//  3. snapshot_show prints the stored layout with the former command;
//  4. snapshot_restore recreates it, and a second call refuses;
//  5. await(ready) reports the fresh shell ready, send types a command into
//     it, which runs at the recorded cwd, and capture reads it back;
//  6. inventory(server) shows the restored pane.
//
// Hermetic like TestSkillRestoreProcedureE2E: temp HOME and XDG_STATE_HOME,
// an rk-test- server the real daemon never snapshots, RK_SERVER_ALLOWLIST
// scoping inventory to it, a refused loopback daemon origin, and bash with no
// rc files as the restored shell.
//
// Skips when go, tmux, or bash is absent.

func TestMCPRestoreProcedureE2E(t *testing.T) {
	for _, tool := range []string{"go", "tmux", "bash"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not available: %v", tool, err)
		}
	}
	bash, _ := exec.LookPath("bash")

	bin := filepath.Join(t.TempDir(), "rk")
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer buildCancel()
	if out, err := exec.CommandContext(buildCtx, "go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, string(out))
	}

	root := t.TempDir()
	home := filepath.Join(root, "home")
	stateHome := filepath.Join(root, "state")
	workDir := filepath.Join(root, "work")
	for _, dir := range []string{home, stateHome, workDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	server := fmt.Sprintf("rk-test-mcprestore-%d-%d", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() {
		killCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	store := snapshot.NewStore(filepath.Join(stateHome, "hexokit", "snapshots"))
	if written, err := store.Write(&snapshot.Snapshot{
		Server:  server,
		TakenAt: time.Now().UTC(),
		Sessions: []snapshot.Session{{
			Name: "work",
			Windows: []snapshot.Window{{
				Index: 1, ID: "@1", Name: "agent", Active: true,
				Panes: []snapshot.Pane{{ID: "%1", Index: 1, Cwd: workDir, Command: "claude", Active: true}},
			}},
		}},
	}); err != nil || !written {
		t.Fatalf("seed snapshot: written=%v err=%v", written, err)
	}

	serverCmd := exec.Command(bin, "mcp")
	serverCmd.Env = hmChildEnv(home, stateHome,
		"RK_SERVER_ALLOWLIST="+server, "SHELL="+bash, "RK_HOST=127.0.0.1", "RK_PORT=1")
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "rk-restore-e2e"}, nil)
	connectCtx, connectCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer connectCancel()
	session, err := client.Connect(connectCtx, &mcpsdk.CommandTransport{Command: serverCmd}, nil)
	if err != nil {
		t.Fatalf("MCP connect: %v", err)
	}
	defer session.Close()

	call := func(name string, args map[string]any) (string, bool) {
		t.Helper()
		callCtx, callCancel := context.WithTimeout(context.Background(), 50*time.Second)
		defer callCancel()
		res, err := session.CallTool(callCtx, &mcpsdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("CallTool %s: %v", name, err)
		}
		if len(res.Content) != 1 {
			t.Fatalf("%s: content blocks = %d, want 1", name, len(res.Content))
		}
		tc, ok := res.Content[0].(*mcpsdk.TextContent)
		if !ok {
			t.Fatalf("%s: content[0] is %T, want *TextContent", name, res.Content[0])
		}
		return tc.Text, res.IsError
	}
	mustCall := func(name string, args map[string]any) string {
		t.Helper()
		text, isErr := call(name, args)
		if isErr {
			t.Fatalf("%s(%v) IsError: %s", name, args, text)
		}
		return text
	}

	// Step 1: the page itself, over MCP.
	canonical, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "site", "skill", "restore.md"))
	if err != nil {
		t.Fatalf("read canonical restore page: %v", err)
	}
	if got := mustCall("skill_topic", map[string]any{"topic": "restore"}); got != strings.TrimRight(string(canonical), "\n") {
		t.Fatalf("skill_topic(restore) differs from docs/site/skill/restore.md (%d vs %d bytes)", len(got), len(canonical))
	}
	if text, isErr := call("skill_topic", map[string]any{"topic": "topics"}); !isErr {
		t.Errorf("skill_topic(topics) = %q, want a schema rejection of the reserved name", text)
	}

	// Step 2: the snapshot says live; inventory finds no server.
	var listRows []struct {
		Server string  `json:"server"`
		DiedAt *string `json:"died_at"`
	}
	if err := json.Unmarshal([]byte(mustCall("snapshot_list", nil)), &listRows); err != nil {
		t.Fatalf("parse snapshot_list: %v", err)
	}
	if len(listRows) != 1 || listRows[0].Server != server || listRows[0].DiedAt != nil {
		t.Fatalf("snapshot_list = %+v, want one live-latest row for %s", listRows, server)
	}
	if servers := mcpRestoreInventoryServers(t, mustCall("inventory", nil)); len(servers) != 0 {
		t.Fatalf("inventory before restore = %v, want no live server", servers)
	}

	// Step 3: the stored layout, touching no tmux.
	shown := mustCall("snapshot_show", map[string]any{"server": server})
	for _, want := range []string{"window 1: agent", workDir, "[claude]"} {
		if !strings.Contains(shown, want) {
			t.Errorf("snapshot_show lacks %q:\n%s", want, shown)
		}
	}

	// Step 4: restore, then the refusal on a live server.
	report := mustCall("snapshot_restore", map[string]any{"server": server})
	for _, want := range []string{"was running: claude", "fresh shells"} {
		if !strings.Contains(report, want) {
			t.Errorf("snapshot_restore report lacks %q:\n%s", want, report)
		}
	}
	if text, isErr := call("snapshot_restore", map[string]any{"server": server}); !isErr || !strings.Contains(text, "refusing to restore") {
		t.Errorf("second snapshot_restore = IsError %v, text %q, want the live-server refusal", isErr, text)
	}

	// Step 5: readiness, a typed command, and the pane read back.
	pane := restoreSkillPaneAt(t, server, "work", workDir)
	restoreSkillWaitForShell(t, server, pane, filepath.Base(bash))
	var ready struct {
		Report string `json:"report"`
	}
	if err := json.Unmarshal([]byte(mustCall("await", map[string]any{"server": server, "target": pane, "ready": true, "timeout": 30})), &ready); err != nil || ready.Report != "ready" {
		t.Fatalf("await(ready) report = %q (err %v), want ready", ready.Report, err)
	}
	var receipt struct {
		Report string `json:"report"`
	}
	if err := json.Unmarshal([]byte(mustCall("send", map[string]any{"server": server, "target": pane, "message": "printf ok > resumed"})), &receipt); err != nil || receipt.Report != "delivered" {
		t.Fatalf("send report = %q (err %v), want delivered", receipt.Report, err)
	}
	marker := filepath.Join(workDir, "resumed")
	deadline := time.Now().Add(10 * time.Second)
	for {
		b, err := os.ReadFile(marker)
		if err == nil && string(b) == "ok" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("command sent over MCP never ran at the recorded cwd (marker %s: %v)", marker, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// The pane is a detached 80-column default, so a long prompt wraps the
	// echoed command across rows, and a wrap that lands on a space loses it
	// (capture trims each row's trailing blanks). Compare with all whitespace
	// removed so the match holds wherever the wrap falls.
	var captured struct {
		Content string `json:"content"`
		Cwd     string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(mustCall("capture", map[string]any{"server": server, "target": pane})), &captured); err != nil {
		t.Fatalf("parse capture result: %v", err)
	}
	if !strings.Contains(strings.Join(strings.Fields(captured.Content), ""), "printfok>resumed") || captured.Cwd != workDir {
		t.Errorf("capture = cwd %q content %q, want the sent command at %s", captured.Cwd, captured.Content, workDir)
	}

	// Step 6: inventory sees the restored server.
	if servers := mcpRestoreInventoryServers(t, mustCall("inventory", map[string]any{"server": server})); len(servers) != 1 || servers[0] != server {
		t.Errorf("inventory after restore = %v, want [%s]", servers, server)
	}
}

// mcpRestoreInventoryServers returns the server names in an inventory tool
// result (the envelope's result object, already unwrapped by the proxy).
func mcpRestoreInventoryServers(t *testing.T, text string) []string {
	t.Helper()
	var inv struct {
		Servers []struct {
			Server string `json:"server"`
		} `json:"servers"`
	}
	if err := json.Unmarshal([]byte(text), &inv); err != nil {
		t.Fatalf("parse inventory result: %v\n%s", err, text)
	}
	var names []string
	for _, s := range inv.Servers {
		names = append(names, s.Server)
	}
	return names
}
