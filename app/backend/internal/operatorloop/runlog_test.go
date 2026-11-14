package operatorloop

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var runLogTestTime = time.Date(2026, 11, 14, 11, 10, 20, 0, time.UTC)

func runLogTestInvocation() Invocation {
	return Invocation{
		Time: runLogTestTime, PID: 12345, ExitCode: 1,
		Argv:   []string{"mux", "capture", "-L", "loom", "%27", "--lines", "40"},
		Err:    errors.New("tmux socket error"),
		Stderr: "Error: tmux socket error\n", Stdout: `{"ok":false}`,
	}
}

func TestAppendInvocation_Format(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	AppendInvocation(path, runLogTestInvocation())
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "--- rk 2026-11-14T11:10:20Z pid=12345 exit=1\n" +
		"argv: 'rk' 'mux' 'capture' '-L' 'loom' '%27' '--lines' '40'\n" +
		"error: tmux socket error\n" +
		"stderr: Error: tmux socket error\n" +
		"stdout: {\"ok\":false}\n"
	if string(got) != want {
		t.Errorf("record =\n%s\nwant\n%s", got, want)
	}
}

func TestAppendInvocation_OmitsEmptyStreamsAndError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	AppendInvocation(path, Invocation{Time: runLogTestTime, PID: 7, Argv: []string{"notify", "hi"}})
	got, _ := os.ReadFile(path)
	for _, label := range []string{"error:", "stderr:", "stdout:"} {
		if strings.Contains(string(got), label) {
			t.Errorf("record carries %q for an empty value:\n%s", label, got)
		}
	}
	if !strings.HasPrefix(string(got), "--- rk 2026-11-14T11:10:20Z pid=7 exit=0\nargv: 'rk' 'notify' 'hi'\n") {
		t.Errorf("record = %q", got)
	}
}

func TestAppendInvocation_AppendsAndIndentsContinuationLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	inv := runLogTestInvocation()
	inv.Stderr = "line one\nline two\n"
	AppendInvocation(path, inv)
	AppendInvocation(path, inv)
	got, _ := os.ReadFile(path)
	if n := strings.Count(string(got), "--- rk "); n != 2 {
		t.Errorf("records = %d, want 2", n)
	}
	if !strings.Contains(string(got), "stderr: line one\n  line two\n") {
		t.Errorf("continuation not indented:\n%s", got)
	}
}

func TestAppendInvocation_IsFailSilent(t *testing.T) {
	dir := t.TempDir()
	AppendInvocation("relative.log", runLogTestInvocation())
	AppendInvocation("", runLogTestInvocation())
	AppendInvocation(filepath.Join(dir, "missing", "run.log"), runLogTestInvocation())
	if _, err := os.Stat("relative.log"); !os.IsNotExist(err) {
		t.Error("a relative path wrote a file")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("an unwritable path left %d entries", len(entries))
	}
}

func TestTailBuffer_KeepsTheTailAndMarksTruncation(t *testing.T) {
	b := NewTailBuffer(5)
	_, _ = b.Write([]byte("abc"))
	if got := b.String(); got != "abc" {
		t.Errorf("under cap = %q", got)
	}
	_, _ = b.Write([]byte("defgh"))
	if got, want := b.String(), truncatedMarker+"defgh"; got != want {
		t.Errorf("over cap = %q, want %q", got, want)
	}
}

func TestTailBuffer_DropsASplitRune(t *testing.T) {
	b := NewTailBuffer(4)
	_, _ = b.Write([]byte("é→ab"))
	if got, want := b.String(), truncatedMarker+"ab"; got != want {
		t.Errorf("tail = %q, want %q", got, want)
	}
}

func TestRunLogPath(t *testing.T) {
	cases := map[string]bool{"": false, "rel/run.log": false, "/abs/run.log": true}
	for val, want := range cases {
		t.Setenv(RunLogEnv, val)
		if got, ok := RunLogPath(); ok != want || got != val {
			t.Errorf("RunLogPath() with %q = %q, %v; want enabled=%v", val, got, ok, want)
		}
	}
}
