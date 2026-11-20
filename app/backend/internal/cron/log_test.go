package cron

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestParseLogTolerant(t *testing.T) {
	data := []byte(`{"ts":100,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
not json at all
{"ts":200,"entry":"k7q2","target":"%31","reason":"wake","outcome":"delivered"}
{"ts":300,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"failed: pane gone"}

`)
	lines := ParseLog(data)
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3 (corrupt line skipped)", len(lines))
	}
	if lines[0].TS != 100 || lines[2].TS != 300 {
		t.Errorf("lines = %+v", lines)
	}
}

func TestLastDeliveryAndOwnDeliveries(t *testing.T) {
	lines := ParseLog([]byte(`{"ts":100,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
{"ts":200,"entry":"k7q2","target":"%31","reason":"schedule","outcome":"delivered"}
{"ts":300,"entry":"a3f9","target":"%12","reason":"wake","outcome":"delivered"}
`))
	last, ok := LastDelivery(lines, "a3f9")
	if !ok || last.TS != 300 {
		t.Errorf("LastDelivery = %+v, %v", last, ok)
	}
	own := OwnDeliveries(lines, "a3f9")
	if len(own) != 2 || own[0].TS != 100 || own[1].TS != 300 {
		t.Errorf("OwnDeliveries = %+v", own)
	}
	if _, ok := LastDelivery(lines, "zzzz"); ok {
		t.Error("LastDelivery found an absent entry")
	}
}

// TestScheduleHistoryCutsAtReschedule: own lines newer than the entry's
// newest `rescheduled` line are kept (the boundary line itself is excluded);
// another entry's `rescheduled` line is not a boundary; with no boundary the
// view equals OwnDeliveries.
func TestScheduleHistoryCutsAtReschedule(t *testing.T) {
	lines := ParseLog([]byte(`{"ts":100,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
{"ts":200,"entry":"a3f9","reason":"edit","outcome":"rescheduled"}
{"ts":250,"entry":"k7q2","reason":"edit","outcome":"rescheduled"}
{"ts":300,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
{"ts":400,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"failed: pane gone"}
`))

	history := ScheduleHistory(lines, "a3f9")
	if len(history) != 2 || history[0].TS != 300 || history[1].TS != 400 {
		t.Errorf("ScheduleHistory = %+v, want only the two lines newer than the reschedule", history)
	}

	// The boundary must be the entry's OWN rescheduled line: k7q2's line at
	// 250 does not cut a3f9's history, and for k7q2 it is the newest own line.
	if history := ScheduleHistory(lines, "k7q2"); len(history) != 0 {
		t.Errorf("ScheduleHistory(k7q2) = %+v, want empty (the boundary is its newest own line)", history)
	}

	// No boundary: identical to the unfiltered view.
	noBoundary := ParseLog([]byte(`{"ts":100,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
{"ts":250,"entry":"k7q2","reason":"edit","outcome":"rescheduled"}
{"ts":300,"entry":"a3f9","target":"%12","reason":"schedule","outcome":"delivered"}
`))
	history = ScheduleHistory(noBoundary, "a3f9")
	own := OwnDeliveries(noBoundary, "a3f9")
	if len(history) != len(own) || history[0].TS != own[0].TS || history[len(history)-1].TS != own[len(own)-1].TS {
		t.Errorf("no boundary: ScheduleHistory = %+v, want %+v (OwnDeliveries)", history, own)
	}
}

func TestAppendLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.log")
	line := LogLine{TS: 100, Entry: "a3f9", Target: "%12", Reason: "schedule", Outcome: "delivered"}
	if err := AppendLog(path, line); err != nil {
		t.Fatal(err)
	}
	if err := AppendLog(path, LogLine{TS: 200, Entry: "a3f9", Target: "%12", Reason: "wake", Outcome: "delivered"}); err != nil {
		t.Fatal(err)
	}
	lines := ParseLog(mustRead(t, path))
	if len(lines) != 2 || lines[1].TS != 200 {
		t.Errorf("lines = %+v", lines)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != fileMode {
		t.Errorf("mode = %o, want %o", st.Mode().Perm(), fileMode)
	}
}

// TestLogLineFireRoundTrip: the fire id survives a write/read, stays out of
// lines that have none, and a line written before the field parses with it empty.
func TestLogLineFireRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.log")
	if err := AppendLog(path, LogLine{TS: 1, Entry: "lp01", Reason: "schedule", Outcome: OutcomeNoChange, Fire: "20261112T101500-ab12"}); err != nil {
		t.Fatal(err)
	}
	if err := AppendLog(path, LogLine{TS: 2, Entry: "lp01", Reason: "schedule", Outcome: "skipped-busy: x"}); err != nil {
		t.Fatal(err)
	}
	data := mustRead(t, path)
	if got := bytes.Count(data, []byte(`"fire"`)); got != 1 {
		t.Errorf("fire key appears %d times, want once (omitempty)", got)
	}
	lines := ParseLog(append(data, []byte(`{"ts":3,"entry":"lp01","target":"","reason":"schedule","outcome":"no change"}`+"\n")...))
	if len(lines) != 3 || lines[0].Fire != "20261112T101500-ab12" || lines[1].Fire != "" || lines[2].Fire != "" {
		t.Errorf("lines = %+v", lines)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestLogCapTrim: an append past the cap atomically trims to the newest tail —
// the file ends with the new line, is under the cap, starts at a line
// boundary, and every retained line is newer than every dropped one.
func TestLogCapTrim(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.log")

	// Fill to just over the cap with monotonically newer lines.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, fileMode)
	if err != nil {
		t.Fatal(err)
	}
	ts := int64(1)
	for {
		payload := fmt.Sprintf(`{"ts":%d,"entry":"a3f9","target":"%%12","reason":"schedule","outcome":"%s"}`,
			ts, string(bytes.Repeat([]byte("x"), 200)))
		if _, err := f.WriteString(payload + "\n"); err != nil {
			t.Fatal(err)
		}
		st, _ := f.Stat()
		if st.Size() > logCapBytes {
			break
		}
		ts++
	}
	f.Close()
	sizeBefore, _ := os.Stat(path)
	if sizeBefore.Size() <= logCapBytes {
		t.Fatalf("setup: log size %d not over cap", sizeBefore.Size())
	}

	// The append that pushes past the cap triggers the trim.
	newLine := LogLine{TS: ts + 1, Entry: "a3f9", Target: "%12", Reason: "schedule", Outcome: "delivered"}
	if err := AppendLog(path, newLine); err != nil {
		t.Fatal(err)
	}

	data := mustRead(t, path)
	if int64(len(data)) > logCapBytes {
		t.Errorf("trimmed size = %d, over cap %d", len(data), logCapBytes)
	}
	// Ends with the new line.
	lines := bytes.Split(bytes.TrimRight(data, "\n"), []byte{'\n'})
	var last LogLine
	if err := json.Unmarshal(lines[len(lines)-1], &last); err != nil {
		t.Fatalf("last line unparseable: %v", err)
	}
	if last != newLine {
		t.Errorf("last line = %+v, want %+v", last, newLine)
	}
	// Starts at a line boundary: first line parses.
	var first LogLine
	if err := json.Unmarshal(lines[0], &first); err != nil {
		t.Fatalf("first line unparseable (not cut at a boundary): %v", err)
	}
	// Every retained line parses and is newer than the dropped prefix.
	var prevTS int64
	for _, raw := range lines {
		var l LogLine
		if err := json.Unmarshal(raw, &l); err != nil {
			t.Fatalf("retained line unparseable: %v", err)
		}
		if l.TS < prevTS {
			t.Errorf("retained lines out of order at ts %d", l.TS)
		}
		prevTS = l.TS
	}
	// Oldest lines were dropped (the trim actually removed history).
	if first.TS == 1 {
		t.Error("trim retained the oldest line — nothing was dropped")
	}
	// The retained window is the NEWEST tail: roughly half the cap.
	if int64(len(data)) < logCapBytes/3 {
		t.Errorf("trimmed too aggressively: %d bytes retained", len(data))
	}
}

func TestReadLogAbsent(t *testing.T) {
	if lines := ReadLog(filepath.Join(t.TempDir(), "nope.log")); lines != nil {
		t.Errorf("ReadLog absent = %v, want nil", lines)
	}
}
