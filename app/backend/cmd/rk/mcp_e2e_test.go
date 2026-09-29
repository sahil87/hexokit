package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"rk/internal/snapshot"
	"rk/internal/testutil"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcp_e2e_test.go — the MCP end-to-end proof: a REAL rk binary (go build into
// t.TempDir — the server child calls os.Executable() per tool, so the
// RK_RIFF_SUBPROC test-binary re-exec pattern cannot serve here) serving stdio
// MCP to a real SDK client (CommandTransport), against an isolated tmux server
// (rk-test-mcp-<pid>-<ns>, never a user server). Skips when tmux or go are
// absent. Asserts the tool list, annotations, schema shape, the instructions
// block, and the full sessions → send → capture loop plus the two negative
// classes (schema rejection, verb failure).

// TestMCPEndToEnd drives the whole proxy shape: policy table → Cobra-derived
// schema → argv exec → bare-JSON/text → MCP content.
func TestMCPEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping MCP e2e test")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not available — skipping MCP e2e test")
	}

	// Build the real binary. The tmux.conf embed input is generated (see
	// scripts/build.sh), so seed it the same way when absent — and remove a
	// seeded copy on cleanup so the test never leaves the working tree dirty.
	backendRoot := filepath.Join("..", "..")
	confPath := filepath.Join(backendRoot, "build", "tmux.conf")
	if _, err := os.Stat(confPath); os.IsNotExist(err) {
		src, err := os.ReadFile(filepath.Join("..", "..", "..", "configs", "tmux", "default.conf"))
		if err != nil {
			t.Fatalf("read canonical tmux.conf: %v", err)
		}
		if err := os.WriteFile(confPath, src, 0o644); err != nil {
			t.Fatalf("seed build/tmux.conf: %v", err)
		}
		t.Cleanup(func() { _ = os.Remove(confPath) })
	}
	bin := filepath.Join(t.TempDir(), "rk")
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer buildCancel()
	if out, err := exec.CommandContext(buildCtx, "go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, string(out))
	}

	// Isolated tmux server with one shell session.
	server := fmt.Sprintf("rk-test-mcp-%d-%d", os.Getpid(), time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-session", "-d", "-s", "boot").CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})
	paneOut, err := exec.CommandContext(ctx, "tmux", "-L", server, "display-message", "-p", "#{pane_id}").CombinedOutput()
	if err != nil {
		t.Fatalf("display-message: %v\n%s", err, string(paneOut))
	}
	pane := strings.TrimSpace(string(paneOut))

	// Connect a real MCP client over the command transport, TMUX/TMUX_PANE
	// unset in the child (the stdio server has no pane of its own) and
	// XDG_STATE_HOME pointed at an isolated snapshot store.
	xdgState := t.TempDir()
	serverCmd := exec.Command(bin, "mcp")
	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "TMUX=") || strings.HasPrefix(kv, "TMUX_PANE=") || strings.HasPrefix(kv, "XDG_STATE_HOME=") ||
			strings.HasPrefix(kv, "RK_HOST=") || strings.HasPrefix(kv, "RK_PORT=") {
			continue
		}
		env = append(env, kv)
	}
	// The cron tools write under XDG_STATE_HOME too; notify must find no daemon,
	// so its origin resolves to a refused loopback port.
	serverCmd.Env = append(env, "XDG_STATE_HOME="+xdgState, "RK_HOST=127.0.0.1", "RK_PORT=1")

	// Seed one snapshot in the isolated store so snapshot_list round-trips a
	// real entry (the store API writes under XDG_STATE_HOME/hexokit/snapshots).
	store := snapshot.NewStore(filepath.Join(xdgState, "hexokit", "snapshots"))
	written, err := store.Write(&snapshot.Snapshot{
		Server:  "e2esnap",
		TakenAt: time.Now().UTC(),
		Sessions: []snapshot.Session{{
			Name:    "boot",
			Windows: []snapshot.Window{{Index: 0, ID: "@1", Name: "shell"}},
		}},
	})
	if err != nil || !written {
		t.Fatalf("seed snapshot store: written=%v err=%v", written, err)
	}
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "rk-e2e"}, nil)
	connectCtx, connectCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer connectCancel()
	session, err := client.Connect(connectCtx, &mcpsdk.CommandTransport{Command: serverCmd}, nil)
	if err != nil {
		t.Fatalf("MCP connect: %v", err)
	}
	defer session.Close()

	// Instructions are the core skill bundle, verbatim.
	if got := session.InitializeResult().Instructions; got != string(skillBundle) {
		t.Errorf("instructions mismatch: got %d bytes, want the %d-byte skill bundle", len(got), len(skillBundle))
	}

	// ListTools: exactly the thirteen seeded tools, with annotations and schemas.
	tools, err := session.ListTools(connectCtx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	byName := map[string]*mcpsdk.Tool{}
	var names []string
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	want := []string{"answer", "await", "board", "capture", "code_exec", "cron_add", "cron_list", "cron_mute", "cron_rm", "gui_exec", "gui_shot", "gui_status", "kill", "new_window", "notify", "operator", "operator_request", "panes", "process", "riff", "send", "sessions", "snapshot_list", "status", "tab_code", "tab_layout", "tab_show", "tab_web", "tab_web_ls"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v, want %v", names, want)
	}
	for _, banned := range []string{"serve", "mcp"} {
		if _, ok := byName[banned]; ok {
			t.Errorf("never-tool %q must not be listed", banned)
		}
	}
	for _, name := range []string{"sessions", "capture", "await"} {
		ann := byName[name].Annotations
		if ann == nil || !ann.ReadOnlyHint {
			t.Errorf("%s must carry readOnlyHint:true", name)
		}
	}
	if ann := byName["send"].Annotations; ann != nil && ann.ReadOnlyHint {
		t.Error("send must not be read-only")
	}
	for name, tool := range byName {
		schema, ok := tool.InputSchema.(map[string]any)
		if !ok || schema["type"] != "object" {
			t.Errorf("%s inputSchema is not an object schema: %v", name, tool.InputSchema)
		}
	}
	captureSchema := byName["capture"].InputSchema.(map[string]any)
	captureProps := captureSchema["properties"].(map[string]any)
	if req, _ := captureSchema["required"].([]any); len(req) != 1 || req[0] != "target" {
		t.Errorf("capture required = %v, want [target]", captureSchema["required"])
	}
	lines := captureProps["lines"].(map[string]any)
	if lines["minimum"] != float64(1) || lines["maximum"] != float64(2000) {
		t.Errorf("capture lines bounds = %v", lines)
	}
	if !strings.Contains(byName["send"].Description, "does NOT mean the agent has acted") {
		t.Errorf("send description missing the interim-receipt caveat: %q", byName["send"].Description)
	}

	call := func(name string, args map[string]any) *mcpsdk.CallToolResult {
		t.Helper()
		callCtx, callCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer callCancel()
		res, err := session.CallTool(callCtx, &mcpsdk.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("CallTool %s: %v", name, err)
		}
		return res
	}
	textOf := func(res *mcpsdk.CallToolResult) string {
		t.Helper()
		if len(res.Content) != 1 {
			t.Fatalf("content blocks = %d, want 1", len(res.Content))
		}
		tc, ok := res.Content[0].(*mcpsdk.TextContent)
		if !ok {
			t.Fatalf("content[0] is %T, want *TextContent", res.Content[0])
		}
		return tc.Text
	}

	// sessions: the isolated server's boot session appears in the bare JSON.
	res := call("sessions", map[string]any{"server": server})
	if res.IsError {
		t.Fatalf("sessions IsError: %s", textOf(res))
	}
	var sessionRows []map[string]any
	if err := json.Unmarshal([]byte(textOf(res)), &sessionRows); err != nil {
		t.Fatalf("sessions text is not a JSON array: %v\n%s", err, textOf(res))
	}
	foundBoot := false
	for _, row := range sessionRows {
		if row["name"] == "boot" {
			foundBoot = true
		}
	}
	if !foundBoot {
		t.Errorf("sessions rows = %v, want one named boot", sessionRows)
	}

	// send: an uninstrumented shell pane is unknown-state — the verb warns on
	// stderr and sends; the tool returns the --json envelope's receipt (the
	// report word is a structured field now, not a text line).
	res = call("send", map[string]any{"server": server, "target": pane, "message": "echo MCP_E2E_OK"})
	if res.IsError {
		t.Fatalf("send IsError: %s", textOf(res))
	}
	var sendReceipt map[string]any
	if err := json.Unmarshal([]byte(textOf(res)), &sendReceipt); err != nil {
		t.Fatalf("send receipt is not JSON: %v\n%s", err, textOf(res))
	}
	if sendReceipt["report"] != "delivered" || sendReceipt["target"] != pane || sendReceipt["enter"] != true {
		t.Errorf("send receipt = %v, want delivered on %s with enter true", sendReceipt, pane)
	}

	// answer: a key press on the shell pane rides the plain gate (unknown ⇒
	// warn + send) and receipts report sent.
	res = call("answer", map[string]any{"server": server, "target": pane, "key": "Enter"})
	if res.IsError {
		t.Fatalf("answer IsError: %s", textOf(res))
	}
	var answerReceipt map[string]any
	if err := json.Unmarshal([]byte(textOf(res)), &answerReceipt); err != nil {
		t.Fatalf("answer receipt is not JSON: %v\n%s", err, textOf(res))
	}
	if answerReceipt["report"] != "sent" || answerReceipt["target"] != pane || answerReceipt["enter"] != false {
		t.Errorf("answer receipt = %v, want sent on %s with enter false", answerReceipt, pane)
	}

	// await: the shell pane is uninstrumented — the verb's
	// nothing-observable diagnostic passes through as IsError.
	res = call("await", map[string]any{"server": server, "target": pane, "timeout": 1})
	if !res.IsError {
		t.Errorf("await on an uninstrumented pane = %q, want IsError", textOf(res))
	} else if text := textOf(res); !strings.Contains(text, "nothing observable") || !strings.Contains(text, "operational") {
		t.Errorf("await text = %q, want the verb's diagnostic as an operational error", text)
	}

	// capture: poll until the echo lands in the scrollback.
	var captured string
	ok := testutil.WaitUntil(t, 10*time.Second, func() bool {
		res := call("capture", map[string]any{"server": server, "target": pane, "lines": 50})
		if res.IsError {
			return false
		}
		captured = textOf(res)
		var doc map[string]any
		if err := json.Unmarshal([]byte(captured), &doc); err != nil {
			return false
		}
		content, _ := doc["content"].(string)
		return strings.Contains(content, "MCP_E2E_OK")
	})
	if !ok {
		t.Fatalf("capture never showed MCP_E2E_OK; last capture: %s", captured)
	}

	// Negative 1: the schema pattern rejects a bogus target before exec.
	res = call("capture", map[string]any{"server": server, "target": "bogus"})
	if !res.IsError || !strings.Contains(textOf(res), `"target"`) {
		t.Errorf("bogus target = IsError %v, text %q", res.IsError, textOf(res))
	}

	// Negative 2: a well-formed but nonexistent pane surfaces the verb's stderr.
	res = call("capture", map[string]any{"server": server, "target": "%999"})
	if !res.IsError {
		t.Error("nonexistent pane must be IsError")
	}
	if text := textOf(res); !strings.Contains(text, "operational") || !strings.Contains(text, "%999") {
		t.Errorf("nonexistent pane text = %q, want the verb's diagnostic", text)
	}

	// Negative 3: answer's key input is a closed enum — a control chord is
	// rejected by the schema before exec.
	res = call("answer", map[string]any{"server": server, "target": pane, "key": "C-c"})
	if !res.IsError || !strings.Contains(textOf(res), `"key"`) {
		t.Errorf("key C-c = IsError %v, text %q, want a schema rejection", res.IsError, textOf(res))
	}

	// Negative 4: answer requires exactly one payload — both and neither are
	// rejected by the one-of check before exec.
	for name, args := range map[string]map[string]any{
		"both":    {"server": server, "target": pane, "message": "yes", "key": "Enter"},
		"neither": {"server": server, "target": pane},
	} {
		res = call("answer", args)
		if !res.IsError || !strings.Contains(textOf(res), "exactly one") {
			t.Errorf("answer with %s payload = IsError %v, text %q, want the one-of rejection", name, res.IsError, textOf(res))
		}
	}

	// snapshot_list: the seeded entry round-trips through the envelope — the
	// text content is the unwrapped result array, one row per store entry.
	res = call("snapshot_list", nil)
	if res.IsError {
		t.Fatalf("snapshot_list IsError: %s", textOf(res))
	}
	var snapRows []map[string]any
	if err := json.Unmarshal([]byte(textOf(res)), &snapRows); err != nil {
		t.Fatalf("snapshot_list text is not a JSON array: %v\n%s", err, textOf(res))
	}
	if len(snapRows) != 1 {
		t.Fatalf("snapshot_list rows = %v, want exactly the seeded entry", snapRows)
	}
	row := snapRows[0]
	if row["server"] != "e2esnap" || row["sessions"] != float64(1) || row["windows"] != float64(1) {
		t.Errorf("snapshot_list row = %v, want server e2esnap with 1 session / 1 window", row)
	}
	if diedAt, present := row["died_at"]; !present || diedAt != nil {
		t.Errorf("snapshot_list died_at = %v (present %v), want an explicit null for a live row", diedAt, present)
	}

	// The mutating loop: new_window → tab_layout → tab_web add → kill on the
	// isolated server, with each receipt's ids chaining into the next call.
	res = call("new_window", map[string]any{"server": server, "session": "=boot"})
	if res.IsError {
		t.Fatalf("new_window IsError: %s", textOf(res))
	}
	var newWin struct {
		Session  string `json:"session"`
		WindowID string `json:"window_id"`
		PaneID   string `json:"pane_id"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &newWin); err != nil {
		t.Fatalf("new_window text is not the bare JSON document: %v\n%s", err, textOf(res))
	}
	if newWin.Session != "boot" || !strings.HasPrefix(newWin.WindowID, "@") || !strings.HasPrefix(newWin.PaneID, "%") {
		t.Fatalf("new_window receipt = %+v, want session boot + @N/%%N ids", newWin)
	}

	res = call("tab_layout", map[string]any{"server": server, "window": newWin.WindowID, "layout": "split-h:tty,web"})
	if res.IsError {
		t.Fatalf("tab_layout IsError: %s", textOf(res))
	}
	var layoutRcpt struct {
		Window string `json:"window"`
		Layout string `json:"layout"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &layoutRcpt); err != nil {
		t.Fatalf("tab_layout text is not the receipt: %v\n%s", err, textOf(res))
	}
	if layoutRcpt.Window != newWin.WindowID || layoutRcpt.Layout != "h(tty,web)" {
		t.Errorf("tab_layout receipt = %+v, want the chained window and the set layout in tree form", layoutRcpt)
	}

	res = call("tab_web", map[string]any{"action": "add", "server": server, "window": newWin.WindowID, "target": "https://example.com"})
	if res.IsError {
		t.Fatalf("tab_web add IsError: %s", textOf(res))
	}
	var webRcpt struct {
		Window string `json:"window"`
		Index  int    `json:"index"`
		URL    string `json:"url"`
		Tabs   []struct {
			Index int    `json:"index"`
			URL   string `json:"url"`
		} `json:"tabs"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &webRcpt); err != nil {
		t.Fatalf("tab_web add text is not the receipt: %v\n%s", err, textOf(res))
	}
	if webRcpt.Window != newWin.WindowID || webRcpt.Index != 1 || webRcpt.URL != "https://example.com" || len(webRcpt.Tabs) != 1 {
		t.Errorf("tab_web add receipt = %+v, want {window, index 1, url, one tab}", webRcpt)
	}

	res = call("kill", map[string]any{"server": server, "target": newWin.PaneID})
	if res.IsError {
		t.Fatalf("kill IsError: %s", textOf(res))
	}
	var killRcpt struct {
		Report string `json:"report"`
		Target string `json:"target"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &killRcpt); err != nil {
		t.Fatalf("kill text is not the receipt: %v\n%s", err, textOf(res))
	}
	if killRcpt.Report != "killed" || killRcpt.Target != newWin.PaneID {
		t.Errorf("kill receipt = %+v, want {report killed, target %s}", killRcpt, newWin.PaneID)
	}
	// The created window is gone after the kill.
	winOut, err := exec.CommandContext(ctx, "tmux", "-L", server, "list-windows", "-F", "#{window_id}").CombinedOutput()
	if err != nil {
		t.Fatalf("list-windows: %v\n%s", err, string(winOut))
	}
	for _, id := range strings.Split(string(winOut), "\n") {
		if strings.TrimSpace(id) == newWin.WindowID {
			t.Errorf("window %s survives the kill", newWin.WindowID)
		}
	}

	// The cron loop under the temp XDG_STATE_HOME: add → mute --for → rm, the
	// id chaining across the three receipts.
	res = call("cron_add", map[string]any{"server": server, "prompt": "check PRs", "every": "1h", "role": "operator"})
	if res.IsError {
		t.Fatalf("cron_add IsError: %s", textOf(res))
	}
	var addRcpt struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Schedule string `json:"schedule"`
		Target   string `json:"target"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &addRcpt); err != nil {
		t.Fatalf("cron_add text is not the receipt: %v\n%s", err, textOf(res))
	}
	if addRcpt.ID == "" || addRcpt.Schedule != "every 1h" || addRcpt.Target != "role:operator" {
		t.Fatalf("cron_add receipt = %+v, want an id with schedule/target", addRcpt)
	}

	res = call("cron_mute", map[string]any{"server": server, "id": addRcpt.ID, "for": "30m"})
	if res.IsError {
		t.Fatalf("cron_mute IsError: %s", textOf(res))
	}
	var muteRcpt struct {
		ID    string `json:"id"`
		Muted bool   `json:"muted"`
		Until string `json:"until"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &muteRcpt); err != nil {
		t.Fatalf("cron_mute text is not the receipt: %v\n%s", err, textOf(res))
	}
	if muteRcpt.ID != addRcpt.ID || !muteRcpt.Muted || muteRcpt.Until == "" {
		t.Errorf("cron_mute receipt = %+v, want the chained id, muted, and a lease until", muteRcpt)
	}

	res = call("cron_rm", map[string]any{"server": server, "id": addRcpt.ID})
	if res.IsError {
		t.Fatalf("cron_rm IsError: %s", textOf(res))
	}
	var rmRcpt struct {
		ID      string `json:"id"`
		Removed bool   `json:"removed"`
	}
	if err := json.Unmarshal([]byte(textOf(res)), &rmRcpt); err != nil {
		t.Fatalf("cron_rm text is not the receipt: %v\n%s", err, textOf(res))
	}
	if rmRcpt.ID != addRcpt.ID || !rmRcpt.Removed {
		t.Errorf("cron_rm receipt = %+v, want {id, removed:true}", rmRcpt)
	}

	// notify with no daemon reachable: delivered:false, no error (fail-silent).
	res = call("notify", map[string]any{"message": "hi"})
	if res.IsError {
		t.Fatalf("notify IsError: %s", textOf(res))
	}
	if got := textOf(res); got != `{"delivered":false}` {
		t.Errorf("notify receipt = %q, want %q", got, `{"delivered":false}`)
	}

	// Close ends the server process — CommandTransport closes stdin, escalates
	// to SIGTERM, and reaps the child itself (a second Wait errors).
	if err := session.Close(); err != nil {
		t.Errorf("session Close: %v", err)
	}
	if serverCmd.Process != nil {
		testutil.MustWaitUntil(t, 10*time.Second, func() bool {
			return serverCmd.Process.Signal(syscall.Signal(0)) != nil
		}, "mcp server process %d still alive after Close", serverCmd.Process.Pid)
	}
}
