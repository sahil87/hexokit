package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rk/internal/mcp"
	"rk/internal/operatorloop"
)

// runExecCmd drives `rk operator run-exec` with operatorloop.Exec stubbed.
func runExecCmd(t *testing.T, stub func(context.Context, operatorloop.ExecOptions) (operatorloop.ExecResult, error), args ...string) (string, string, error) {
	t.Helper()
	saved := operatorRunExecFn
	operatorRunExecFn = stub
	t.Cleanup(func() { operatorRunExecFn = saved })
	prevTmux := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = prevTmux })
	return runOperatorCLI(t, "", append([]string{"run-exec"}, args...)...)
}

const execTestRun = "20261112T101500-ab12"

func TestOperatorRunExecIsHidden(t *testing.T) {
	if !operatorRunExecCmd.Hidden {
		t.Fatal("run-exec must be hidden")
	}
	op, ok := childByName(buildDump(rootCmd, displayVersion()).Root, "operator")
	if !ok {
		t.Fatal("help-dump has no operator command")
	}
	if _, leaked := childByName(op, "run-exec"); leaked {
		t.Error("run-exec leaked into help-dump")
	}
	for _, row := range mcp.Table {
		if strings.HasPrefix(row.Path, "operator run-exec") {
			t.Errorf("run-exec must not be in the MCP table: %+v", row)
		}
	}
}

func TestOperatorRunExecPassesArgvAndMirrorsExit(t *testing.T) {
	var got operatorloop.ExecOptions
	stub := func(_ context.Context, o operatorloop.ExecOptions) (operatorloop.ExecResult, error) {
		got = o
		return operatorloop.ExecResult{ExitCode: 0, Outcome: "ok"}, nil
	}
	if _, _, err := runExecCmd(t, stub, "--server", "dev", "--run", execTestRun, "--", "sh", "-c", "claude -p"); err != nil {
		t.Fatal(err)
	}
	if got.Server != "dev" || got.RunID != execTestRun || len(got.Argv) != 3 || got.Argv[0] != "sh" || got.Argv[2] != "claude -p" {
		t.Fatalf("options = %+v", got)
	}

	failing := func(context.Context, operatorloop.ExecOptions) (operatorloop.ExecResult, error) {
		return operatorloop.ExecResult{ExitCode: 7, Failed: true}, nil
	}
	_, _, err := runExecCmd(t, failing, "--server", "dev", "--run", execTestRun, "--", "false")
	if code := exitCode(err); code != 7 {
		t.Fatalf("exit code = %d (err %v), want the child's 7", code, err)
	}
}

func TestOperatorRunExecUsageErrors(t *testing.T) {
	stub := func(context.Context, operatorloop.ExecOptions) (operatorloop.ExecResult, error) {
		t.Fatal("exec must not run on a usage error")
		return operatorloop.ExecResult{}, nil
	}
	cases := map[string][]string{
		"no server":   {"--run", execTestRun, "--", "true"},
		"bad server":  {"--server", "a/b", "--run", execTestRun, "--", "true"},
		"bad run id":  {"--server", "dev", "--run", "../x", "--", "true"},
		"no launcher": {"--server", "dev", "--run", execTestRun},
	}
	for name, args := range cases {
		_, _, err := runExecCmd(t, stub, args...)
		if exitCode(err) != 2 {
			t.Errorf("%s: exit code = %d (err %v), want 2", name, exitCode(err), err)
		}
	}
}

func TestOperatorRunExecOperationalError(t *testing.T) {
	stub := func(context.Context, operatorloop.ExecOptions) (operatorloop.ExecResult, error) {
		return operatorloop.ExecResult{}, errors.New("run record missing")
	}
	_, _, err := runExecCmd(t, stub, "--server", "dev", "--run", execTestRun, "--", "true")
	if exitCode(err) != 1 {
		t.Fatalf("exit code = %d (err %v), want 1", exitCode(err), err)
	}
}
