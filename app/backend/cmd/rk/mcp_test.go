package main

import (
	"bytes"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"

	"rk/api"
	"rk/internal/mcp"
)

// TestMCPTableResolves is the drift guard against the real Cobra tree: every
// policy row's path and flags resolve (docs/specs/mcp.md § Policy table rules
// — a renamed or re-flagged verb fails the build, never the model). Also pins
// the thirteen seeded tool names, the timeout cap, and the never-tools exclusion.
func TestMCPTableResolves(t *testing.T) {
	resolved, err := mcp.Resolve(rootCmd, mcp.Table)
	if err != nil {
		t.Fatalf("Resolve(rootCmd, Table): %v", err)
	}
	var names []string
	for _, res := range resolved {
		names = append(names, res.Row.Tool)
		if res.Row.Timeout > mcp.ToolTimeoutCap {
			t.Errorf("row %q timeout %s exceeds the cap", res.Row.Tool, res.Row.Timeout)
		}
	}
	sort.Strings(names)
	want := []string{"answer", "await", "board", "capture", "code_exec", "cron_add", "cron_list", "cron_mute", "cron_rm", "gui_exec", "gui_shot", "gui_status", "kill", "new_window", "notify", "operator", "operator_request", "panes", "process", "riff", "send", "sessions", "snapshot_list", "status", "tab_code", "tab_layout", "tab_show", "tab_web", "tab_web_ls"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("tool names = %v, want %v", names, want)
	}

	// The send description override carries the receipt caveat (the plan's
	// named risk: `delivered` is submission verification, not the agent
	// acting).
	for _, res := range resolved {
		if res.Row.Tool == "send" {
			if desc := res.Row.Description; !strings.Contains(desc, "does NOT mean the agent has acted") {
				t.Errorf("send description missing the caveat: %q", desc)
			}
		}
	}

	// The answer/await schemas: answer's key enum is the closed set and both
	// payloads stay optional (the one-of is handler-enforced); await's timeout
	// is bounded 1–40 with the structural default 40.
	var answer, await *mcp.Resolved
	for i := range resolved {
		switch resolved[i].Row.Tool {
		case "answer":
			answer = &resolved[i]
		case "await":
			await = &resolved[i]
		}
	}
	if answer == nil || await == nil {
		t.Fatal("answer/await rows missing from the resolved table")
	}
	answerProps := mcp.InputSchema(*answer)["properties"].(map[string]any)
	if got := fmt.Sprint(answerProps["key"].(map[string]any)["enum"]); got != "[Enter Escape Tab Up Down Left Right Space BSpace y n 1 2 3 4 5 6 7 8 9]" {
		t.Errorf("answer key enum = %v, want the closed set", got)
	}
	if got := fmt.Sprint(mcp.InputSchema(*answer)["required"]); got != "[target]" {
		t.Errorf("answer required = %v, want [target] — the message/key one-of is handler-enforced", got)
	}
	awaitProps := mcp.InputSchema(*await)["properties"].(map[string]any)
	timeout := awaitProps["timeout"].(map[string]any)
	if timeout["minimum"] != 1 || timeout["maximum"] != 40 || timeout["default"] != 40 {
		t.Errorf("await timeout schema = %v, want min 1, max 40, default 40", timeout)
	}
}

// TestMCPBoardSchema asserts the resolved board row's generated input schema
// against the REAL Cobra tree (the enum/pattern/required assertions need the
// row; resolving here is what proves the parent's persistent flags exist).
func TestMCPBoardSchema(t *testing.T) {
	resolved, err := mcp.Resolve(rootCmd, mcp.Table)
	if err != nil {
		t.Fatalf("Resolve(rootCmd, Table): %v", err)
	}
	var board *mcp.Resolved
	for i := range resolved {
		if resolved[i].Row.Tool == "board" {
			board = &resolved[i]
			break
		}
	}
	if board == nil {
		t.Fatal("no board row in the resolved table")
	}
	if board.Row.Annotations != (mcp.Annotations{}) {
		t.Errorf("board annotations = %+v, want no read-only hint (mixed read/write)", board.Row.Annotations)
	}

	schema := mcp.InputSchema(*board)
	required, ok := schema["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "action" {
		t.Errorf("required = %v, want [action]", schema["required"])
	}
	props := schema["properties"].(map[string]any)
	action := props["action"].(map[string]any)
	if got := fmt.Sprint(action["enum"]); got != "[show pin unpin reorder]" {
		t.Errorf("action enum = %v", action["enum"])
	}
	for name, pattern := range map[string]string{
		"name":   `^[A-Za-z0-9_-]{1,32}$`,
		"window": `^@\d+$`,
		"before": `^@\d+$`,
		"after":  `^@\d+$`,
	} {
		prop, ok := props[name].(map[string]any)
		if !ok {
			t.Errorf("property %q missing", name)
			continue
		}
		if prop["pattern"] != pattern {
			t.Errorf("%s pattern = %v, want %q", name, prop["pattern"], pattern)
		}
	}
	if _, ok := props["server"]; !ok {
		t.Error("server property missing (the -L flag input)")
	}
	if _, ok := props["--json"]; ok {
		t.Error("literal --json leaked into properties")
	}
}

// TestMCPVisibleInHelpDump: `rk mcp` is a visible root verb, present in the
// help-dump tree (cli-layering.md § Root).
func TestMCPVisibleInHelpDump(t *testing.T) {
	if mcpCmd.Hidden {
		t.Error("mcpCmd must be visible")
	}
	tree := buildDump(rootCmd, "test")
	found := false
	for _, child := range tree.Root.Commands {
		if child.Name == "mcp" {
			found = true
			if child.Path != "hexokit mcp" {
				t.Errorf("mcp node path = %q", child.Path)
			}
		}
	}
	if !found {
		t.Error("help-dump tree missing the mcp node")
	}
}

// TestMCPHelpNamesConnectorCommand: `rk mcp --help` names the connector
// command a chat client is configured with.
func TestMCPHelpNamesConnectorCommand(t *testing.T) {
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetArgs([]string{"mcp", "--help"})
	defer rootCmd.SetArgs(nil)
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("mcp --help: %v", err)
	}
	if !strings.Contains(buf.String(), "ssh <box> rk mcp") {
		t.Errorf("mcp --help does not name the connector command:\n%s", buf.String())
	}
}

// TestOperatorRequestEnumMatchesRegistry pins the policy row's mirrored
// template enum to the daemon's closed registry: internal/mcp must not import
// rk/api (the /mcp route would close an import cycle), so this cmd/rk test is
// the drift guard — a registry edit that forgets the mirror fails the build.
func TestOperatorRequestEnumMatchesRegistry(t *testing.T) {
	var enum []string
	for _, row := range mcp.Table {
		if row.Tool != "operator_request" {
			continue
		}
		for _, arg := range row.Args {
			if arg.Name == "template" {
				enum = arg.Enum
			}
		}
	}
	if enum == nil {
		t.Fatal("operator_request row has no template arg")
	}
	var ids []string
	for _, info := range api.OperatorTemplateList() {
		ids = append(ids, info.ID)
	}
	if !slices.Equal(enum, ids) {
		t.Errorf("policy enum = %v, want the registry ids %v", enum, ids)
	}
}
