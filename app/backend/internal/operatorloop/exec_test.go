package operatorloop

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

// execRig stores a launched-run record + brief and returns the run's paths.
func execRig(t *testing.T, r *rig, changed ...string) (recPath, logPath string) {
	t.Helper()
	for _, id := range changed {
		if id != "gone" {
			r.addNoteItem(id)
		}
	}
	recPath = r.writeRun(Record{ID: runA, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z",
		Changed: changed, Window: "run-aaaa"})
	dir := r.runsDir()
	briefPath, _ := BriefPath(dir, runA)
	if err := os.WriteFile(briefPath, []byte("the brief\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	logPath, _ = LogPath(dir, runA)
	return recPath, logPath
}

func doExec(t *testing.T, argv ...string) (ExecResult, string, string, []string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	var pushed []string
	res, err := Exec(context.Background(), ExecOptions{
		Server: testServer, RunID: runA, Argv: argv, Stdout: &stdout, Stderr: &stderr,
		Notify: func(_ context.Context, title, body string) { pushed = append(pushed, title+"|"+body) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return res, stdout.String(), stderr.String(), pushed
}

func itemNotes(t *testing.T, r *rig, id string) []operator.Note {
	t.Helper()
	st, err := operator.Load(r.statePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range st.Tracked {
		if it.ID == id {
			return it.Notes
		}
	}
	t.Fatalf("no item %s", id)
	return nil
}

// TestExecSuccessRecordsOutcomeAndNoNote: a launcher that reads the brief on
// stdin, prints the exit-contract line and exits 0 ends the run cleanly.
func TestExecSuccessRecordsOutcomeAndNoNote(t *testing.T) {
	r := newRig(t)
	recPath, logPath := execRig(t, r, "pr-41")

	res, stdout, _, pushed := doExec(t, "sh", "-c", `cat; echo working; echo "outcome: first"; echo "outcome: stub acted"`)
	if res.Failed || res.ExitCode != 0 || res.Outcome != "stub acted" {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(stdout, "the brief") || !strings.Contains(stdout, "outcome: stub acted") {
		t.Errorf("window stdout = %q (the brief must reach the launcher's stdin, output tee'd to the window)", stdout)
	}
	log, _ := os.ReadFile(logPath)
	if !strings.Contains(string(log), "working") || !strings.Contains(string(log), "the brief") {
		t.Errorf("run log = %q", log)
	}
	if st, _ := os.Stat(logPath); st.Mode().Perm() != 0o600 {
		t.Errorf("log perm = %v", st.Mode().Perm())
	}
	rec, _ := ReadRecord(recPath)
	if rec.ExitCode == nil || *rec.ExitCode != 0 || rec.Outcome != "stub acted" || !rec.Ended() || rec.StartedAt == "" || rec.Logged {
		t.Fatalf("record = %+v", rec)
	}
	if notes := itemNotes(t, r, "pr-41"); len(notes) != 1 {
		t.Errorf("a clean run must write no failure note: %+v", notes)
	}
	if len(pushed) != 0 {
		t.Errorf("clean run pushed: %v", pushed)
	}
}

// TestExecNonZeroWithoutOutcomeNotesChangedItems: exit 1 with no outcome line leaves a `by: run` note on every
// changed item still present, records exit 1 and pushes once.
func TestExecNonZeroWithoutOutcomeNotesChangedItems(t *testing.T) {
	r := newRig(t)
	recPath, _ := execRig(t, r, "pr-41", "gone", "pr-42")
	// "gone" was in the check's changed list but has since been removed.

	res, _, stderr, pushed := doExec(t, "sh", "-c", `echo "401 unauthorized" >&2; exit 1`)
	if !res.Failed || res.ExitCode != 1 || res.Outcome != "" {
		t.Fatalf("result = %+v", res)
	}
	if !strings.Contains(stderr, "401 unauthorized") {
		t.Errorf("stderr must reach the window: %q", stderr)
	}
	for _, id := range []string{"pr-41", "pr-42"} {
		notes := itemNotes(t, r, id)
		last := notes[len(notes)-1]
		if last.By != "run" || !strings.HasPrefix(last.Text, "run failed: exit 1 — ") || !strings.Contains(last.Text, "401 unauthorized") {
			t.Errorf("%s note = %+v", id, last)
		}
	}
	rec, _ := ReadRecord(recPath)
	if rec.ExitCode == nil || *rec.ExitCode != 1 || !rec.Ended() {
		t.Fatalf("record = %+v", rec)
	}
	if len(pushed) != 1 || !strings.Contains(pushed[0], "run failed: exit 1") {
		t.Errorf("pushed = %v", pushed)
	}
}

func TestExecExitZeroWithoutOutcomeIsFailure(t *testing.T) {
	r := newRig(t)
	execRig(t, r, "pr-41")
	res, _, _, _ := doExec(t, "sh", "-c", `echo done`)
	if !res.Failed || res.ExitCode != 0 {
		t.Fatalf("result = %+v", res)
	}
	notes := itemNotes(t, r, "pr-41")
	if !strings.HasPrefix(notes[len(notes)-1].Text, "run failed: exit 0 — ") {
		t.Errorf("notes = %+v", notes)
	}
}

func TestExecTailIsBoundedSingleLine(t *testing.T) {
	r := newRig(t)
	_, logPath := execRig(t, r, "pr-41")
	doExec(t, "sh", "-c", `i=0; while [ $i -lt 300 ]; do echo "line $i é"; i=$((i+1)); done; exit 3`)
	notes := itemNotes(t, r, "pr-41")
	text := notes[len(notes)-1].Text
	tail := strings.TrimPrefix(text, "run failed: exit 3 — ")
	if len(tail) > failureTailBytes || strings.ContainsAny(tail, "\n\r") || !strings.Contains(tail, "line 299") {
		t.Errorf("tail = %q", tail)
	}
	if got := logTail(logPath + ".missing"); got != "no output" {
		t.Errorf("missing log tail = %q", got)
	}
}

func TestExecCeilingKillsHungLauncher(t *testing.T) {
	r := newRig(t)
	recPath, _ := execRig(t, r, "pr-41")
	var stdout, stderr bytes.Buffer
	start := time.Now()
	res, err := Exec(context.Background(), ExecOptions{Server: testServer, RunID: runA, Ceiling: 300 * time.Millisecond,
		Argv: []string{"sh", "-c", "sleep 30"}, Stdout: &stdout, Stderr: &stderr})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 10*time.Second || res.ExitCode != exitTimedOut || !res.Failed {
		t.Fatalf("result = %+v after %v", res, time.Since(start))
	}
	if rec, _ := ReadRecord(recPath); rec.ExitCode == nil || *rec.ExitCode != exitTimedOut {
		t.Fatalf("record = %+v", rec)
	}
}

func TestExecMissingLauncherBinary(t *testing.T) {
	r := newRig(t)
	execRig(t, r, "pr-41")
	res, _, stderr, _ := doExec(t, "/no/such/launcher")
	if res.ExitCode != exitStartFailed || !strings.Contains(stderr, "starting launcher") {
		t.Fatalf("result = %+v stderr = %q", res, stderr)
	}
}

func TestExecRejectsBadInputs(t *testing.T) {
	r := newRig(t)
	execRig(t, r, "pr-41")
	var buf bytes.Buffer
	for name, opts := range map[string]ExecOptions{
		"no argv":    {Server: testServer, RunID: runA, Stdout: &buf, Stderr: &buf},
		"bad run id": {Server: testServer, RunID: "../../x", Argv: []string{"true"}, Stdout: &buf, Stderr: &buf},
		"bad server": {Server: "a/b", RunID: runA, Argv: []string{"true"}, Stdout: &buf, Stderr: &buf},
		"no record":  {Server: testServer, RunID: runB, Argv: []string{"true"}, Stdout: &buf, Stderr: &buf},
	} {
		if _, err := Exec(context.Background(), opts); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestOutcomeCaptureAcrossWrites(t *testing.T) {
	c := &outcomeCapture{}
	for _, chunk := range []string{"noise\nout", "come: spl", "it\r\nmore\nout", "come: last, no newline"} {
		if _, err := c.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if got := c.Outcome(); got != "last, no newline" {
		t.Errorf("outcome = %q", got)
	}
	d := &outcomeCapture{}
	d.Write([]byte("  outcome: not at line start\nxoutcome: no\n"))
	if d.Outcome() != "" {
		t.Errorf("only a line STARTING with outcome: counts, got %q", d.Outcome())
	}
}
