package operatorloop

import (
	"context"
	"os"
	"strings"
	"testing"

	"rk/internal/tmux"
)

const (
	runA = "20261112T101500-aaaa"
	runB = "20261112T102000-bbbb"
	runC = "20261112T102500-cccc"
)

func intp(n int) *int { return &n }

func ended(id string, exit *int, outcome string) Record {
	return Record{ID: id, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z",
		StartedAt: "2026-11-12T10:15:02Z", EndedAt: "2026-11-12T10:17:15Z", ExitCode: exit, Outcome: outcome}
}

func TestTranscribeOutcomeClasses(t *testing.T) {
	r := newRig(t)
	r.writeRun(ended(runA, intp(0), "nudged pr-41, noted"))
	r.writeRun(ended(runB, intp(1), ""))
	noOutcome := ended(runC, intp(0), "")
	r.writeRun(noOutcome)

	lines := Transcribe(context.Background(), testServer)
	if len(lines) != 3 {
		t.Fatalf("lines = %+v", lines)
	}
	want := []string{
		"ran · nudged pr-41, noted · 2m13s",
		"run-failed: exit 1 · 2m13s",
		"run-failed: no outcome line · 2m13s",
	}
	for i, l := range lines {
		if l.Outcome != want[i] || l.Entry != "lp01" || l.Reason != "schedule" || l.Run != []string{runA, runB, runC}[i] {
			t.Errorf("line %d = %+v, want outcome %q", i, l, want[i])
		}
	}
}

func TestTranscribeExactlyOnceAcrossRestart(t *testing.T) {
	r := newRig(t)
	path := r.writeRun(ended(runA, intp(0), "stub acted"))

	if lines := Transcribe(context.Background(), testServer); len(lines) != 1 {
		t.Fatalf("first transcribe = %+v", lines)
	}
	// The tick crashed before MarkLogged: the next (fresh daemon) tick sees it
	// again; the tick's own dedupe handles the log, MarkLogged closes it out.
	if lines := Transcribe(context.Background(), testServer); len(lines) != 1 {
		t.Fatalf("unmarked record must transcribe again: %+v", lines)
	}
	MarkLogged(context.Background(), testServer, runA)
	if rec, _ := ReadRecord(path); !rec.Logged {
		t.Fatal("MarkLogged did not set logged")
	}
	if lines := Transcribe(context.Background(), testServer); len(lines) != 0 {
		t.Fatalf("logged record transcribed again: %+v", lines)
	}
}

func TestTranscribeLostWhenWindowGone(t *testing.T) {
	r := newRig(t)
	path := r.writeRun(Record{ID: runA, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:10:00Z", Window: "run-aaaa"})
	r.writeRun(Record{ID: runB, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:12:00Z", Window: "run-bbbb"})
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) {
		return []tmux.RunWindow{{WindowID: "@9", RunID: runB}}, nil
	}

	lines := Transcribe(context.Background(), testServer)
	if len(lines) != 1 || lines[0].Run != runA || lines[0].Outcome != "run-lost: window gone" {
		t.Fatalf("lines = %+v", lines)
	}
	rec, _ := ReadRecord(path)
	if !rec.Ended() || rec.Lost != "window gone" {
		t.Fatalf("lost run not marked ended: %+v", rec)
	}
	// The live run is untouched.
	recB, _ := ReadRecord(mustRecordPath(t, r, runB))
	if recB.Ended() {
		t.Fatalf("live run was marked ended: %+v", recB)
	}
}

func TestTranscribeWindowListFailureJudgesNothingLost(t *testing.T) {
	r := newRig(t)
	r.writeRun(Record{ID: runA, Server: testServer, Entry: "lp01"})
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) { return nil, errBoom }
	if lines := Transcribe(context.Background(), testServer); len(lines) != 0 {
		t.Fatalf("a failed window listing must not declare runs lost: %+v", lines)
	}
}

func TestTranscribeLaunchFailureRecord(t *testing.T) {
	r := newRig(t)
	rec := Record{ID: runA, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z", EndedAt: "2026-11-12T10:15:00Z", Lost: "launch: tmux said no"}
	r.writeRun(rec)
	lines := Transcribe(context.Background(), testServer)
	if len(lines) != 1 || lines[0].Outcome != "run-lost: launch: tmux said no" {
		t.Fatalf("lines = %+v", lines)
	}
}

func TestTranscribeSkipsMalformedRecord(t *testing.T) {
	r := newRig(t)
	good := r.writeRun(ended(runA, intp(0), "ok"))
	_ = good
	dir := r.runsDir()
	bad, _ := RecordPath(dir, runB)
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines := Transcribe(context.Background(), testServer)
	if len(lines) != 1 || lines[0].Run != runA {
		t.Fatalf("lines = %+v, want only the good record", lines)
	}
}

func TestTranscribePrunesAfterwards(t *testing.T) {
	r := newRig(t)
	dir := r.runsDir()
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < RunRetention+3; i++ {
		id, _ := NewRunID(r.now.Add(secs(i)))
		r.writeRun(Record{ID: id, Server: testServer, Logged: true})
	}
	Transcribe(context.Background(), testServer)
	ids, _ := listRunIDs(dir)
	if len(ids) != RunRetention {
		t.Fatalf("records after prune = %d, want %d", len(ids), RunRetention)
	}
}

func TestTranscribeNoRunsDir(t *testing.T) {
	newRig(t)
	if lines := Transcribe(context.Background(), testServer); len(lines) != 0 {
		t.Fatalf("lines = %+v", lines)
	}
	if lines := Transcribe(context.Background(), "../bad"); len(lines) != 0 {
		t.Fatalf("bad server transcribed: %+v", lines)
	}
}

func mustRecordPath(t *testing.T, r *rig, id string) string {
	t.Helper()
	p, err := RecordPath(r.runsDir(), id)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// TestMarkLostDoesNotOverwriteACleanEnd: the wrapper records a clean end
// between Transcribe's read (no end yet) and the window-gone write; the run
// must still transcribe as `ran`, not `run-lost`.
func TestMarkLostDoesNotOverwriteACleanEnd(t *testing.T) {
	r := newRig(t)
	stale := Record{ID: runA, Server: testServer, Entry: "lp01", FiredAt: "2026-11-12T10:15:00Z"}
	path := r.writeRun(ended(runA, intp(0), "stub acted"))

	got := markLost(path, stale, lostWindowGone)
	if got.Lost != "" || !got.Ended() || got.Outcome != "stub acted" {
		t.Fatalf("record = %+v", got)
	}
	if out := outcomeFor(got); !strings.HasPrefix(out, "ran · stub acted") {
		t.Errorf("outcome = %q", out)
	}
	if onDisk, _ := ReadRecord(path); onDisk.Lost != "" {
		t.Errorf("on-disk record was rewritten as lost: %+v", onDisk)
	}
}
