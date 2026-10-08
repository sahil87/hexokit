package mcp

import (
	"rk/internal/layoutspec"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestTableShape pins the seeded allowlist: exactly the thirty-one tools (the
// ten W1 seeds, inventory, board, operator_request, the answer/await messaging pair,
// snapshot_list, gui_shot, and the thirteen W2c rows), every timeout within the
// cap, and no row exposing a forbidden flag form.
func TestTableShape(t *testing.T) {
	want := []string{"sessions", "panes", "inventory", "capture", "process", "status", "cron_list", "gui_status", "tab_show", "tab_web_ls", "send", "board", "operator_request", "answer", "await", "snapshot_list", "gui_shot", "notify", "riff", "new_server", "new_window", "operator", "cron_add", "tab_layout", "tab_web", "tab_code", "code_exec", "gui_exec", "kill", "cron_rm", "cron_mute"}
	if len(Table) != len(want) {
		t.Fatalf("Table has %d rows, want %d", len(Table), len(want))
	}
	for i, name := range want {
		if Table[i].Tool != name {
			t.Errorf("Table[%d].Tool = %q, want %q", i, Table[i].Tool, name)
		}
	}
	if ToolTimeoutCap != 45*time.Second {
		t.Errorf("ToolTimeoutCap = %s, want 45s", ToolTimeoutCap)
	}
	for _, row := range Table {
		if row.Timeout > ToolTimeoutCap {
			t.Errorf("row %q timeout %s exceeds cap", row.Tool, row.Timeout)
		}
		for _, arg := range row.Args {
			// --force and --await stay unexposed on every row; --answer/--key
			// are the answer row's own surface.
			banned := []string{"--force", "--await", "--cmd", "--respawn"}
			if row.Tool != "answer" {
				banned = append(banned, "--answer", "--key")
			}
			if row.Tool != "await" {
				// --ready is await's boot-readiness input; on tab new it would
				// be a bounded wait a chat client must not start.
				banned = append(banned, "--ready")
			}
			for _, b := range banned {
				if arg.Flag == b || arg.Literal == b {
					t.Errorf("row %q exposes %s", row.Tool, b)
				}
			}
		}
	}
}

// findRow locates a table row by tool name — positional assertions
// (Table[len-1]) are brittle once the table grows past its seed ordering.
func findRow(t *testing.T, tool string) Row {
	t.Helper()
	for _, row := range Table {
		if row.Tool == tool {
			return row
		}
	}
	t.Fatalf("no row named %q", tool)
	return Row{}
}

// TestTableSendRow pins the stdin-driven mutating row: body on stdin, the
// --json envelope receipt, non-read-only annotations, and the receipt
// description override keeping the load-bearing caveat.
func TestTableSendRow(t *testing.T) {
	row := findRow(t, "send")
	if row.Stdin != "message" {
		t.Errorf("send.Stdin = %q, want message", row.Stdin)
	}
	if row.Result != ResultJSON {
		t.Errorf("send.Result = %v, want ResultJSON", row.Result)
	}
	if row.Annotations.ReadOnly || row.Annotations.Destructive || row.Annotations.Idempotent || row.Annotations.OpenWorld {
		t.Errorf("send annotations = %+v, want all false", row.Annotations)
	}
	if last := row.Args[len(row.Args)-1]; last.Literal != "--json" {
		t.Errorf("send's last arg = %+v, want the --json literal", last)
	}
	if !strings.Contains(row.Description, "does NOT mean the agent has acted") {
		t.Errorf("send description missing the receipt caveat: %q", row.Description)
	}
}

// TestTableAnswerRow pins the answer row: the message/key one-of, the closed
// key enum, the When-conditional --answer and - literals, stdin on message,
// JSON result, and no annotations.
func TestTableAnswerRow(t *testing.T) {
	row := findRow(t, "answer")
	if row.Path != "mux send" {
		t.Errorf("answer.Path = %q, want mux send", row.Path)
	}
	if row.Result != ResultJSON || row.Stdin != "message" {
		t.Errorf("answer Result/Stdin = %v/%q, want ResultJSON/message", row.Result, row.Stdin)
	}
	if row.Annotations != (Annotations{}) {
		t.Errorf("answer annotations = %+v, want all false (a Talk row)", row.Annotations)
	}
	if strings.Join(row.OneOf, ",") != "message,key" {
		t.Errorf("answer.OneOf = %v, want [message key]", row.OneOf)
	}

	argsByName := map[string]Arg{}
	var literals []Arg
	for _, arg := range row.Args {
		if arg.Literal != "" {
			literals = append(literals, arg)
			continue
		}
		argsByName[arg.Name] = arg
	}
	msg, ok := argsByName["message"]
	if !ok || msg.Type != ArgString || msg.Required {
		t.Errorf("message arg = %+v (present %v), want an optional string (OneOf owns the requirement)", msg, ok)
	}
	key, ok := argsByName["key"]
	if !ok || key.Flag != "--key" || key.Type != ArgString {
		t.Errorf("key arg = %+v (present %v), want an optional --key string flag", key, ok)
	}
	if !slices.Equal(key.Enum, answerKeyEnum) {
		t.Errorf("key enum = %v, want the closed set %v", key.Enum, answerKeyEnum)
	}
	if len(literals) != 3 || literals[0].Literal != "--answer" || literals[0].When != "message" ||
		literals[1].Literal != "-" || literals[1].When != "message" || literals[2].Literal != "--json" {
		t.Errorf("literals = %v, want [--answer(when message) -(when message) --json]", literals)
	}
}

// TestTableAwaitRow pins the await row: the until pattern, the structurally
// clamped timeout (1–40, default 40), the ready boolean, JSON result, and the
// read-only annotations (read-only even though it blocks).
func TestTableAwaitRow(t *testing.T) {
	row := findRow(t, "await")
	if row.Path != "mux await" {
		t.Errorf("await.Path = %q, want mux await", row.Path)
	}
	if row.Result != ResultJSON {
		t.Errorf("await.Result = %v, want ResultJSON", row.Result)
	}
	if row.Annotations != readOnlyAnn {
		t.Errorf("await annotations = %+v, want readOnlyAnn", row.Annotations)
	}
	if row.Timeout != 0 {
		t.Errorf("await.Timeout = %v, want 0 (the cap)", row.Timeout)
	}

	argsByName := map[string]Arg{}
	for _, arg := range row.Args {
		if arg.Literal == "" {
			argsByName[arg.Name] = arg
		}
	}
	until, ok := argsByName["until"]
	if !ok || until.Flag != "--until" || until.Pattern != `^(idle|waiting|active)(,(idle|waiting|active)){0,2}$` {
		t.Errorf("until arg = %+v (present %v), want --until with the state-set pattern", until, ok)
	}
	timeout, ok := argsByName["timeout"]
	if !ok || timeout.Flag != "--timeout" || timeout.Type != ArgInteger {
		t.Errorf("timeout arg = %+v (present %v), want an integer --timeout flag", timeout, ok)
	}
	if timeout.Minimum == nil || *timeout.Minimum != 1 || timeout.Maximum == nil || *timeout.Maximum != 40 || timeout.Default != "40" {
		t.Errorf("timeout bounds/default = %v/%v/%q, want 1/40/\"40\"", timeout.Minimum, timeout.Maximum, timeout.Default)
	}
	ready, ok := argsByName["ready"]
	if !ok || ready.Flag != "--ready" || ready.Type != ArgBoolean {
		t.Errorf("ready arg = %+v (present %v), want a boolean --ready flag", ready, ok)
	}
	for _, desc := range []string{row.Description} {
		for _, want := range []string{"running", "ready", "parked", "narrow", "gone"} {
			if !strings.Contains(desc, want) {
				t.Errorf("await description missing the report word %q: %q", want, desc)
			}
		}
	}
}

// TestTableBoardRow pins the action-enum row: parent path, arg order and
// shapes (enum, patterns), all-false annotations (mixed read/write), JSON
// result, and the description override. Flags precede positionals in Args
// because BuildArgv emits each arg where it sits and the row's historical
// argv puts flags first.
func TestTableBoardRow(t *testing.T) {
	row := findRow(t, "board")
	if row.Path != "board" {
		t.Errorf("board.Path = %q, want board (the parent — flags resolve there)", row.Path)
	}
	if row.Result != ResultJSON {
		t.Errorf("board.Result = %v, want ResultJSON", row.Result)
	}
	if row.Annotations != (Annotations{}) {
		t.Errorf("board annotations = %+v, want all false", row.Annotations)
	}
	if row.Description != boardDescription || row.Description == "" {
		t.Errorf("board description = %q, want the boardDescription override", row.Description)
	}

	wantShapes := []struct {
		name     string
		flag     string
		pos      int
		required bool
		enum     []string
		pattern  string
	}{
		{name: "server", flag: "-L"},
		{name: "before", flag: "--before", pattern: `^@\d+$`},
		{name: "after", flag: "--after", pattern: `^@\d+$`},
		{name: "action", pos: 1, required: true, enum: []string{"show", "pin", "unpin", "reorder"}},
		{name: "name", pos: 2, pattern: `^[A-Za-z0-9_-]{1,32}$`},
		{name: "window", pos: 3, pattern: `^@\d+$`},
	}
	if len(row.Args) != len(wantShapes)+1 { // + jsonLiteral
		t.Fatalf("board args = %d, want %d", len(row.Args), len(wantShapes)+1)
	}
	for i, want := range wantShapes {
		arg := row.Args[i]
		if arg.Name != want.name || arg.Flag != want.flag || arg.Positional != want.pos ||
			arg.Required != want.required || arg.Pattern != want.pattern {
			t.Errorf("board.Args[%d] = %+v, want name=%q flag=%q pos=%d required=%v pattern=%q",
				i, arg, want.name, want.flag, want.pos, want.required, want.pattern)
		}
		if want.enum != nil && strings.Join(arg.Enum, ",") != strings.Join(want.enum, ",") {
			t.Errorf("board.Args[%d].Enum = %v, want %v", i, arg.Enum, want.enum)
		}
	}
	if last := row.Args[len(row.Args)-1]; last.Literal != "--json" {
		t.Errorf("board's last arg = %+v, want the --json literal", last)
	}
}

// TestTableOperatorRequestRow pins the operator_request Talk row: the path,
// the closed template enum on the positional, the conditional window flag,
// the acceptor flags, the --json literal, and the description override naming
// the window-scoped templates and the queued posture.
func TestTableOperatorRequestRow(t *testing.T) {
	row := findRow(t, "operator_request")
	if row.Path != "operator request" {
		t.Errorf("path = %q, want %q", row.Path, "operator request")
	}
	if row.Result != ResultJSON {
		t.Errorf("result = %v, want ResultJSON", row.Result)
	}
	if row.Annotations.ReadOnly || row.Annotations.Destructive || row.Annotations.Idempotent || row.Annotations.OpenWorld {
		t.Errorf("annotations = %+v, want all false (a Talk row)", row.Annotations)
	}

	argsByName := make(map[string]Arg, len(row.Args))
	var positional *Arg
	var literals []string
	for i, arg := range row.Args {
		if arg.Literal != "" {
			literals = append(literals, arg.Literal)
			continue
		}
		if arg.Positional != 0 {
			if positional != nil {
				t.Errorf("second positional arg %q; want exactly one", arg.Name)
			}
			a := row.Args[i]
			positional = &a
			continue
		}
		argsByName[arg.Name] = arg
	}

	if positional == nil || positional.Name != "template" || positional.Positional != 1 {
		t.Fatalf("positional = %+v, want template at slot 1", positional)
	}
	if !positional.Required || positional.Type != ArgString {
		t.Errorf("template = %+v, want a required string", positional)
	}
	if !slices.Equal(positional.Enum, operatorTemplateIDs) {
		t.Errorf("template enum = %v, want the mirrored registry ids %v", positional.Enum, operatorTemplateIDs)
	}
	if !slices.IsSorted(operatorTemplateIDs) {
		t.Errorf("operatorTemplateIDs = %v, want sorted (mirrors the api list order)", operatorTemplateIDs)
	}
	if len(operatorTemplateIDs) != 9 {
		t.Errorf("operatorTemplateIDs has %d ids, want the 9-entry registry", len(operatorTemplateIDs))
	}

	window, ok := argsByName["window"]
	if !ok || window.Flag != "--window" || window.Required {
		t.Errorf("window arg = %+v (present %v), want an optional --window flag", window, ok)
	}
	if window.Pattern != `^@\d+$` {
		t.Errorf("window pattern = %q, want ^@\\d+$", window.Pattern)
	}
	for _, name := range []string{"text", "session"} {
		arg, ok := argsByName[name]
		if !ok || arg.Flag != "--"+name || arg.Type != ArgString || arg.Required {
			t.Errorf("%s arg = %+v (present %v), want an optional string flag", name, arg, ok)
		}
	}
	server, ok := argsByName["server"]
	if !ok || server.Flag != "-L" || server.Required {
		t.Errorf("server arg = %+v (present %v), want the optional -L mapping", server, ok)
	}
	if !slices.Equal(literals, []string{"--json"}) {
		t.Errorf("literals = %v, want [--json]", literals)
	}

	for _, want := range []string{"fix-tab-name", "annotate-tab", "user-message", "queued", "--list"} {
		if !strings.Contains(row.Description, want) {
			t.Errorf("description missing %q: %q", want, row.Description)
		}
	}
}

// TestTableNeverTools asserts no row's path names a never-tool.
func TestTableNeverTools(t *testing.T) {
	for _, row := range Table {
		for _, nt := range neverTools {
			if row.Path == nt || strings.HasPrefix(row.Path, nt+" ") {
				t.Errorf("row %q path %q is a never-tool", row.Tool, row.Path)
			}
		}
	}
}

// TestReadOnlyAnnotations pins the annotation semantics of every See row plus
// await (read-only even though it blocks) — readOnlyAnn, and ResultJSON for all
// but gui_shot (the one ResultImage row); the mutating rows carry all-false (or
// destructive/idempotent) annotations instead.
func TestReadOnlyAnnotations(t *testing.T) {
	seen := 0
	for _, row := range Table {
		if !row.Annotations.ReadOnly {
			continue
		}
		seen++
		if row.Annotations != readOnlyAnn {
			t.Errorf("row %q annotations = %+v, want readOnlyAnn", row.Tool, row.Annotations)
		}
		wantResult := ResultJSON
		if row.Tool == "gui_shot" {
			wantResult = ResultImage
		}
		if row.Result != wantResult {
			t.Errorf("row %q result = %v, want %v", row.Tool, row.Result, wantResult)
		}
	}
	if seen != 13 {
		t.Errorf("%d read-only rows, want the nine See rows plus inventory, await, snapshot_list and gui_shot", seen)
	}
}

// TestMutationAnnotations pins the destructive/idempotent hints of the W2c
// mutation rows: kill and cron_rm are destructive, operator and cron_mute are
// idempotent, everything else carries no hints.
func TestMutationAnnotations(t *testing.T) {
	want := map[string]Annotations{
		"kill":      {Destructive: true},
		"cron_rm":   {Destructive: true},
		"operator":  {Idempotent: true},
		"cron_mute": {Idempotent: true},
	}
	for tool, ann := range want {
		if row := findRow(t, tool); row.Annotations != ann {
			t.Errorf("row %q annotations = %+v, want %+v", tool, row.Annotations, ann)
		}
	}
	for _, tool := range []string{"notify", "riff", "new_server", "new_window", "cron_add", "tab_layout", "tab_web", "tab_code", "code_exec", "gui_exec"} {
		if row := findRow(t, tool); row.Annotations != (Annotations{}) {
			t.Errorf("row %q annotations = %+v, want all false", tool, row.Annotations)
		}
	}
}

// The tab tool's surface enums are DERIVED from the layout registry, not
// restated. They were a hand-kept copy, and by the time this was noticed they
// still read {tty, web, code, gui} — so an agent driving run-kit over MCP could
// not add or remove the review or working tiles, while `rk tab layout --add`
// from a terminal could. This pins the derivation so the copy cannot come back.
func TestTabSurfaceEnumsTrackTheRegistry(t *testing.T) {
	want := layoutspec.SurfaceKinds()
	if len(want) < 5 {
		t.Fatalf("registry looks wrong: %v", want)
	}
	seen := 0
	for _, row := range Table {
		for _, arg := range row.Args {
			switch arg.Name {
			case "add", "rm", "promote":
				seen++
				if !slices.Equal(arg.Enum, want) {
					t.Errorf("%s.%s enum = %v, want the registry %v", row.Tool, arg.Name, arg.Enum, want)
				}
			}
		}
	}
	if seen == 0 {
		t.Fatal("found no add/rm/promote surface args to check — has the tool been renamed?")
	}
}
