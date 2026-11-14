package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operatorloop"

	"github.com/spf13/cobra"
)

const runLogSubprocEnv = "RK_RUNLOG_SUBPROC"

// runLoggedCommand runs a throwaway root through attachRunLog the way
// execute() does and returns what reached the real streams.
func runLoggedCommand(t *testing.T, argv []string, run func(*cobra.Command) error) (stdout string, tee *runLogTee, err error) {
	t.Helper()
	var realOut bytes.Buffer
	root := &cobra.Command{Use: "rk", SilenceUsage: true, RunE: func(cmd *cobra.Command, _ []string) error { return run(cmd) }}
	tracker := &writeTracker{w: &realOut}
	tee = attachRunLog(root, tracker)
	root.SetArgs(argv)
	err = root.Execute()
	tee.record(argv, err)
	return realOut.String(), tee, err
}

func TestRunLog_RecordsAFailingInvocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	t.Setenv(operatorloop.RunLogEnv, path)
	argv := []string{"mux", "capture", "%27"}
	stdout, _, err := runLoggedCommand(t, argv, func(cmd *cobra.Command) error {
		cmd.Println("progress line")
		cmd.PrintErrln("tmux socket error")
		return errors.New("capture failed")
	})
	if err == nil || stdout != "progress line\n" {
		t.Fatalf("stdout = %q, err = %v; the tee must not change the command's output", stdout, err)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	for _, want := range []string{
		" exit=1\n", "argv: 'rk' 'mux' 'capture' '%27'\n", "error: capture failed\n",
		"stderr: tmux socket error\n", "stdout: progress line\n",
	} {
		if !strings.Contains(string(got), want) {
			t.Errorf("record missing %q in:\n%s", want, got)
		}
	}
}

func TestRunLog_RecordsASuccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	t.Setenv(operatorloop.RunLogEnv, path)
	if _, _, err := runLoggedCommand(t, []string{"notify"}, func(*cobra.Command) error { return nil }); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !strings.Contains(string(got), " exit=0\n") || strings.Contains(string(got), "error:") {
		t.Errorf("record = %q", got)
	}
}

func TestRunLog_DisabledLeavesTheRootStreamsAlone(t *testing.T) {
	for _, val := range []string{"", "relative/run.log"} {
		t.Setenv(operatorloop.RunLogEnv, val)
		dir := t.TempDir()
		t.Chdir(dir)
		stdout, tee, err := runLoggedCommand(t, []string{"notify"}, func(cmd *cobra.Command) error {
			cmd.Println("out")
			return nil
		})
		if err != nil || tee != nil || stdout != "out\n" {
			t.Errorf("value %q: stdout=%q tee=%v err=%v", val, stdout, tee, err)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Errorf("value %q wrote %d files", val, len(entries))
		}
	}
}

func TestRunLog_UnwritablePathChangesNothing(t *testing.T) {
	t.Setenv(operatorloop.RunLogEnv, filepath.Join(t.TempDir(), "missing", "run.log"))
	stdout, _, err := runLoggedCommand(t, []string{"notify"}, func(cmd *cobra.Command) error {
		cmd.Println("out")
		return errors.New("boom")
	})
	if stdout != "out\n" || err == nil || err.Error() != "boom" {
		t.Errorf("stdout=%q err=%v", stdout, err)
	}
}

func TestRunLog_ExecuteExitsAndLogsTheUsageError(t *testing.T) {
	if os.Getenv(runLogSubprocEnv) == "1" {
		rootCmd.SetArgs([]string{"riff", "--nope"})
		execute()
		os.Exit(0)
	}
	path := filepath.Join(t.TempDir(), "run.log")
	cmd := exec.Command(os.Args[0], "-test.run", "^TestRunLog_ExecuteExitsAndLogsTheUsageError$")
	cmd.Env = append(os.Environ(), runLogSubprocEnv+"=1", operatorloop.RunLogEnv+"="+path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	var ee *exec.ExitError
	if err := cmd.Run(); !errors.As(err, &ee) || ee.ExitCode() != exitUsage {
		t.Fatalf("child err = %v, want exit %d", err, exitUsage)
	}
	if !strings.Contains(stderr.String(), "Error: unknown flag: --nope") {
		t.Errorf("stderr = %q; the tee must keep cobra's error line on the real stderr", stderr.String())
	}
	got, _ := os.ReadFile(path)
	for _, want := range []string{" exit=2\n", "error: unknown flag: --nope\n", "stderr: Error: unknown flag: --nope\n"} {
		if !strings.Contains(string(got), want) {
			t.Errorf("record missing %q in:\n%s", want, got)
		}
	}
}
