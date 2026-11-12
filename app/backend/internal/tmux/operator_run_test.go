package tmux

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseRunWindows(t *testing.T) {
	d := listDelim
	lines := []string{
		"@1" + d + OperatorSessionName + d + "chat" + d + "operator" + d + "",
		"@2" + d + OperatorSessionName + d + "run-ab12" + d + RoleOperatorRun + d + "20261112T101500-ab12",
		"@3" + d + "work" + d + "main" + d + "" + d + "",
		"@4" + d + OperatorSessionName + d + "run-cd34" + d + RoleOperatorRun + d + "20261112T102000-cd34",
		"malformed",
	}
	got := parseRunWindows(lines)
	want := []RunWindow{
		{WindowID: "@2", Session: OperatorSessionName, Name: "run-ab12", RunID: "20261112T101500-ab12"},
		{WindowID: "@4", Session: OperatorSessionName, Name: "run-cd34", RunID: "20261112T102000-cd34"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseRunWindows = %+v, want %+v", got, want)
	}
	if len(parseRunWindows(nil)) != 0 {
		t.Error("no lines must parse to no windows")
	}
}

func TestRunWindowsFormatCarriesStamps(t *testing.T) {
	for _, want := range []string{"#{" + RoleOption + "}", "#{" + OperatorRunOption + "}", "#{window_id}"} {
		if !strings.Contains(runWindowsFormat, want) {
			t.Errorf("format %q missing %q", runWindowsFormat, want)
		}
	}
}

func TestBuildRunWindowArgvChainsStamps(t *testing.T) {
	role, run := RoleOperatorRun, "20261112T101500-ab12"
	args := buildCreateWindowWithCommandArgs(OperatorSessionName, "run-ab12", "/home/u", "'rk' 'operator' 'run-exec'", []WindowOptionOp{
		{Key: RoleOption, Value: &role},
		{Key: OperatorRunOption, Value: &run},
	})
	joined := strings.Join(args, " ")
	for _, want := range []string{"new-window", "-n run-ab12", "-c /home/u", RoleOption + " " + RoleOperatorRun, OperatorRunOption + " " + run} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q missing %q", joined, want)
		}
	}
	if strings.Contains(joined, "exec \"${SHELL") {
		t.Error("a run window must have no shell-fallback tail")
	}
}
