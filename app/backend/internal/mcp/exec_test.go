package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"rk/internal/testutil"
)

// TestBuildArgvOrder pins argv assembly: flags in Args order, then positionals
// by slot, then literals in Args order.
func TestBuildArgvOrder(t *testing.T) {
	row := syntheticRows()[0] // capture
	got := BuildArgv(row, map[string]any{"server": "s", "target": "%3", "lines": float64(100)})
	want := []string{"mux", "capture", "-L", "s", "-l", "100", "%3", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
}

// TestBuildArgvSeededNewRows pins argv assembly for the snapshot_list and
// gui_shot rows against the shipped table.
func TestBuildArgvSeededNewRows(t *testing.T) {
	byName := map[string]Row{}
	for _, row := range Table {
		byName[row.Tool] = row
	}
	got := BuildArgv(byName["snapshot_list"], map[string]any{"server": "runkit"})
	want := []string{"mux", "snapshot", "list", "runkit", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("snapshot_list argv = %v, want %v", got, want)
	}
	got = BuildArgv(byName["gui_shot"], map[string]any{"max_width": float64(800)})
	want = []string{"gui", "shot", "--max-width", "800", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("gui_shot argv = %v, want %v", got, want)
	}
}

// Fleet discovery must omit -L rather than inherit the default-server scope;
// all input validation happens before the one CLI child is started.
func TestInventoryArgvAndBounds(t *testing.T) {
	row := findRow(t, "inventory")
	for _, tc := range []struct {
		input string
		argv  []string
	}{
		{`{}`, []string{"mux", "inventory", "--limit", "500", "--json"}},
		{`{"server":"work","agents_only":true,"limit":25}`, []string{"mux", "inventory", "-L", "work", "--agents-only", "--limit", "25", "--json"}},
	} {
		args, err := ValidateArgs(row, json.RawMessage(tc.input))
		if err != nil {
			t.Fatal(err)
		}
		if got := BuildArgv(row, args); !reflect.DeepEqual(got, tc.argv) {
			t.Errorf("argv=%v want=%v", got, tc.argv)
		}
	}
	for _, input := range []string{`{"server":""}`, `{"server":"bad/name"}`, `{"limit":0}`, `{"limit":5001}`, `{"limit":1.5}`} {
		if _, err := ValidateArgs(row, json.RawMessage(input)); err == nil {
			t.Errorf("accepted %s", input)
		}
	}
}

// TestValidateArgsSnapshotListServer: the positional server filter rejects
// anything ValidateServerName would, before exec.
func TestValidateArgsSnapshotListServer(t *testing.T) {
	var row Row
	for _, r := range Table {
		if r.Tool == "snapshot_list" {
			row = r
			break
		}
	}
	if row.Tool == "" {
		t.Fatal("Table has no snapshot_list row")
	}
	if _, err := ValidateArgs(row, json.RawMessage(`{"server":"bad name"}`)); err == nil || !strings.Contains(err.Error(), `"server"`) {
		t.Errorf("bad server name = %v, want a rejection naming \"server\"", err)
	}
	if _, err := ValidateArgs(row, json.RawMessage(`{"server":"runkit"}`)); err != nil {
		t.Errorf("valid server name rejected: %v", err)
	}
}

// TestBuildArgvOmissions: absent optionals and false booleans contribute
// nothing; the stdin input never becomes an argv element.
func TestBuildArgvOmissions(t *testing.T) {
	row := Row{
		Tool: "sessions", Path: "mux sessions",
		Args: []Arg{serverArg, {Name: "all", Flag: "--all", Type: ArgBoolean}, jsonLiteral},
	}
	got := BuildArgv(row, map[string]any{"all": false})
	want := []string{"mux", "sessions", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
	got = BuildArgv(row, map[string]any{"all": true})
	want = []string{"mux", "sessions", "--all", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}

	send := syntheticRows()[1]
	got = BuildArgv(send, map[string]any{"target": "%3", "message": "hi"})
	want = []string{"mux", "send", "%3", "-"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("send argv = %v, want %v (message rides stdin)", got, want)
	}
}

// TestBuildArgvBoardActionEnum pins argv assembly for the action-enum row:
// flags (in Args order) before positionals (by slot), then the literal — the
// reorder call yields `board -L s --after @3 reorder work @7 --json`, which
// Cobra parses on the reorder child because the flags are persistent on the
// parent.
func TestBuildArgvBoardActionEnum(t *testing.T) {
	row := findRow(t, "board")
	got := BuildArgv(row, map[string]any{
		"action": "reorder", "name": "work", "window": "@7", "after": "@3", "server": "s",
	})
	want := []string{"board", "-L", "s", "--after", "@3", "reorder", "work", "@7", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
}

// TestBuildArgvDefaultEmittedWhenAbsent: an absent Flag input carrying a
// Default emits `flag Default` at its Args position; a supplied value wins
// over the Default.
func TestBuildArgvDefaultEmittedWhenAbsent(t *testing.T) {
	row := findRow(t, "await")
	got := BuildArgv(row, map[string]any{"server": "s", "target": "%3"})
	want := []string{"mux", "await", "-L", "s", "--timeout", "40", "%3", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}

	got = BuildArgv(row, map[string]any{"server": "s", "target": "%3", "timeout": float64(12)})
	want = []string{"mux", "await", "-L", "s", "--timeout", "12", "%3", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv with supplied timeout = %v, want %v", got, want)
	}
}

// TestBuildArgvWhenConditionalLiterals: a Literal whose When input is absent is
// skipped — the answer row's `--answer`/`-` pair rides the message form only.
func TestBuildArgvWhenConditionalLiterals(t *testing.T) {
	row := findRow(t, "answer")

	got := BuildArgv(row, map[string]any{"target": "%3", "message": "yes"})
	want := []string{"mux", "send", "%3", "--answer", "-", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("message form argv = %v, want %v", got, want)
	}

	got = BuildArgv(row, map[string]any{"target": "%3", "key": "Enter"})
	want = []string{"mux", "send", "--key", "Enter", "%3", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("key form argv = %v, want %v", got, want)
	}
}

// TestExecutorStdinRoundTrip: a stub that cats stdin proves the plumbing, and
// echoing argv proves no shell string is involved.
func TestExecutorStdinRoundTrip(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\nprintf '%s\n' \"$@\"\ncat\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	out := exe.Run(context.Background(), []string{"mux", "send", "%3", "-"}, "hello\nworld", 5*time.Second)
	if out.TimedOut || out.ExitCode != 0 {
		t.Fatalf("outcome = %+v", out)
	}
	if got := string(out.Stdout); got != "mux\nsend\n%3\n-\nhello\nworld" {
		t.Errorf("stdout = %q", got)
	}
}

// TestExecutorStdinEmpty: an empty stdin leaves the child with no piped input
// beyond EOF — the stub must see an empty read.
func TestExecutorStdinEmpty(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\nout=$(cat)\nprintf '[%s]' \"$out\"\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	out := exe.Run(context.Background(), nil, "", 5*time.Second)
	if string(out.Stdout) != "[]" {
		t.Errorf("stdout = %q, want [] (no stdin content)", out.Stdout)
	}
}

// TestExecutorTimeout: a sleeping stub under a 200 ms deadline is killed
// promptly and reported TimedOut.
func TestExecutorTimeout(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\nexec sleep 5\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	start := time.Now()
	out := exe.Run(context.Background(), nil, "", 200*time.Millisecond)
	elapsed := time.Since(start)
	if !out.TimedOut {
		t.Error("TimedOut = false, want true")
	}
	if elapsed > time.Second {
		t.Errorf("took %s, want the deadline kill well under 1s", elapsed)
	}
}

// TestExecutorTimeoutWedgeBound: when a killed child's own child keeps the
// captured pipes open (a sleeping grandchild), Run still returns within
// WaitDelay rather than wedging the tool call.
func TestExecutorTimeoutWedgeBound(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\nsleep 5\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	start := time.Now()
	out := exe.Run(context.Background(), nil, "", 200*time.Millisecond)
	elapsed := time.Since(start)
	if !out.TimedOut {
		t.Error("TimedOut = false, want true")
	}
	if elapsed > waitDelay+time.Second {
		t.Errorf("took %s, want within the %s WaitDelay bound", elapsed, waitDelay)
	}
}

// TestExecutorStripsTmuxEnv: TMUX/TMUX_PANE set in the parent never reach the
// child (the target rule); the rest of the environment does.
func TestExecutorStripsTmuxEnv(t *testing.T) {
	t.Setenv("TMUX", "/tmp/fake,1,0")
	t.Setenv("TMUX_PANE", "%42")
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\nprintf 'tmux=[%s] pane=[%s] home=[%s]\n' \"$TMUX\" \"$TMUX_PANE\" \"$HOME\"\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	out := exe.Run(context.Background(), nil, "", 5*time.Second)
	got := string(out.Stdout)
	if !strings.Contains(got, "tmux=[] pane=[]") {
		t.Errorf("stdout = %q, want TMUX/TMUX_PANE stripped", got)
	}
	if !strings.Contains(got, "home=[/") {
		t.Errorf("stdout = %q, want the rest of the environment inherited", got)
	}
}

// TestExecutorFailureExit: a stub exiting 3 with a stderr diagnostic surfaces
// both, separately.
func TestExecutorFailureExit(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\necho out\necho err >&2\nexit 3\n")
	exe := Executor{Exe: dir + "/rk-stub"}
	out := exe.Run(context.Background(), nil, "", 5*time.Second)
	if out.ExitCode != 3 || out.TimedOut {
		t.Errorf("outcome = %+v", out)
	}
	if string(out.Stdout) != "out\n" || string(out.Stderr) != "err\n" {
		t.Errorf("stdout=%q stderr=%q", out.Stdout, out.Stderr)
	}
}

// TestBuildArgvStringArrayFlag pins the repeated-flag mapping of a
// string-array input: one `--skill <item>` pair per item, in array order.
func TestBuildArgvStringArrayFlag(t *testing.T) {
	row := Row{
		Tool: "riff", Path: "riff",
		Args: []Arg{
			{Name: "skill", Flag: "--skill", Type: ArgStringArray},
			jsonLiteral,
		},
	}
	got := BuildArgv(row, map[string]any{"skill": []any{"/a", "/b"}})
	want := []string{"riff", "--skill", "/a", "--skill", "/b", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
}

// TestBuildArgvOrderedWalk pins the single ordered walk: literals emit where
// they sit in Args, so the gui_exec row places `--detach --json --` before
// its positionals, and a positional string array expands one element per item.
func TestBuildArgvOrderedWalk(t *testing.T) {
	row := Row{
		Tool: "gui_exec", Path: "gui exec",
		Args: []Arg{
			{Literal: "--detach"},
			jsonLiteral,
			{Literal: "--"},
			{Name: "command", Positional: 1, Type: ArgString, Required: true},
			{Name: "args", Positional: 2, Type: ArgStringArray},
		},
	}
	got := BuildArgv(row, map[string]any{"command": "chromium", "args": []any{"--kiosk", "https://x"}})
	want := []string{"gui", "exec", "--detach", "--json", "--", "chromium", "--kiosk", "https://x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
}

// TestBuildArgvFormatPositional pins Format rendering: {name} substitutes the
// named input (integers via Itoa), the […] segment drops when an input inside
// it is absent, and an absent non-optional input drops the whole token.
func TestBuildArgvFormatPositional(t *testing.T) {
	row := Row{
		Tool: "tab_web", Path: "tab web",
		Args: []Arg{
			{Name: "action", Positional: 1, Type: ArgString, Required: true, Enum: []string{"add", "rm", "select", "mv"}},
			{Name: "window", Type: ArgString, Required: true, Pattern: `^@\d+$`},
			{Name: "slot", Type: ArgInteger, Minimum: intPtr(1)},
			{Positional: 2, Format: "{window}[/web/{slot}]"},
			jsonLiteral,
		},
	}
	got := BuildArgv(row, map[string]any{"action": "rm", "window": "@3", "slot": float64(2)})
	want := []string{"tab", "web", "rm", "@3/web/2", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}

	got = BuildArgv(row, map[string]any{"action": "add", "window": "@3"})
	want = []string{"tab", "web", "add", "@3", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv without slot = %v, want %v (optional segment dropped)", got, want)
	}

	got = BuildArgv(row, map[string]any{"action": "add"})
	want = []string{"tab", "web", "add", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv without window = %v, want %v (formatted positional contributes nothing)", got, want)
	}
}

// TestBuildArgvW2cRows pins the W2c rows' argv shapes end to end: the
// gui_exec literal prefix before its positionals, the tab_web composite
// address per action, and the riff row's flag set (no --cmd).
func TestBuildArgvW2cRows(t *testing.T) {
	cases := []struct {
		name string
		tool string
		args map[string]any
		want []string
	}{
		{
			"gui_exec", "gui_exec",
			map[string]any{"command": "chromium", "args": []any{"--kiosk", "https://x"}},
			[]string{"gui", "exec", "--detach", "--json", "--", "chromium", "--kiosk", "https://x"},
		},
		{
			"tab_web add", "tab_web",
			map[string]any{"action": "add", "window": "@3", "target": "https://example.com", "show": true},
			[]string{"tab", "web", "add", "@3", "https://example.com", "--show", "--json"},
		},
		{
			"tab_web rm", "tab_web",
			map[string]any{"action": "rm", "window": "@3", "slot": float64(2)},
			[]string{"tab", "web", "rm", "@3/web/2", "--json"},
		},
		{
			"tab_web select", "tab_web",
			map[string]any{"action": "select", "window": "@3", "slot": float64(1)},
			[]string{"tab", "web", "select", "@3/web/1", "--json"},
		},
		{
			"tab_web mv", "tab_web",
			map[string]any{"action": "mv", "window": "@3", "slot": float64(2), "to": float64(1)},
			[]string{"tab", "web", "mv", "@3/web/2", "1", "--json"},
		},
		{
			"riff", "riff",
			map[string]any{"server": "s", "repo": "/r", "session": "=boot", "preset": "ship", "skill": []any{"/a", "/b"}},
			[]string{"riff", "-L", "s", "--repo", "/r", "--session", "=boot", "ship", "--skill", "/a", "--skill", "/b", "--json"},
		},
		{
			"cron_mute lease", "cron_mute",
			map[string]any{"id": "a3f9", "for": "30m"},
			[]string{"cron", "mute", "a3f9", "--for", "30m", "--json"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BuildArgv(findRow(t, tc.tool), tc.args)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("argv = %v, want %v", got, tc.want)
			}
		})
	}
}
