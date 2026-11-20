package operatorloop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/tmux"
)

func readCheckJSON(t *testing.T, r *rig, id string) map[string]any {
	t.Helper()
	path, err := CheckRecordPath(r.runsDir(), id)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("check record %s: %v", id, err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("check record perm = %v, want 0600", st.Mode().Perm())
	}
	return out
}

func TestRunNoChangeWritesCheckRecord(t *testing.T) {
	r := newRig(t)
	newRunIDFn = func() (string, error) { return runA, nil }
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		return operator.CheckResult{CheckedAt: "2026-11-12T10:15:01Z",
			Open: []operator.CheckDelta{{Kind: operator.DeltaStale, ID: "pr-41", Age: "3d"}}}, nil
	}
	f := fire()
	f.Reason = cron.TriggerFireReason("manual")
	if got := Run(context.Background(), f); got.String() != cron.OutcomeNoChange {
		t.Fatalf("outcome = %q", got.String())
	}
	rec := readCheckJSON(t, r, runA)
	if rec["changed"] != false || rec["reason"] != "trigger:manual" || rec["fired_at"] != "2026-11-12T10:15:00Z" ||
		rec["checked_at"] != "2026-11-12T10:15:01Z" {
		t.Errorf("record = %v", rec)
	}
	if _, has := rec["run"]; has {
		t.Error("a no-change record carries no run key")
	}
	if changes, ok := rec["changes"].([]any); !ok || len(changes) != 0 {
		t.Errorf("changes = %v, want []", rec["changes"])
	}
	if open, ok := rec["open"].([]any); !ok || len(open) != 1 {
		t.Errorf("open = %v", rec["open"])
	} else if first := open[0].(map[string]any); first["kind"] != "stale" || first["age"] != "3d" {
		t.Errorf("open[0] = %v", first)
	}
	if notices, ok := rec["notices"].([]any); !ok || len(notices) != 0 {
		t.Errorf("notices = %v, want []", rec["notices"])
	}
}

func TestRunChangedCheckRecordCarriesRunID(t *testing.T) {
	r := newRig(t)
	r.addNoteItem("pr-41")
	checkFn = changedCheck("pr-41")
	newRunIDFn = func() (string, error) { return runA, nil }
	stubLaunch(t, r, nil)
	Run(context.Background(), fire())
	rec := readCheckJSON(t, r, runA)
	if rec["changed"] != true || rec["run"] != runA || rec["reason"] != "schedule" {
		t.Errorf("record = %v", rec)
	}
	if !exists(t, mustRecordPath(t, r, runA)) {
		t.Error("the run record must share the fire id")
	}
}

// TestRunFailedLaunchStillWritesCheckRecord: the check ran, so it is recorded
// whether or not the launch succeeds; the run key follows the run record.
func TestRunFailedLaunchStillWritesCheckRecord(t *testing.T) {
	r := newRig(t)
	r.addNoteItem("pr-41")
	checkFn = changedCheck("pr-41")
	newRunIDFn = func() (string, error) { return runA, nil }
	stubLaunch(t, r, errBoom)
	Run(context.Background(), fire())
	if rec := readCheckJSON(t, r, runA); rec["changed"] != true || rec["run"] != runA {
		t.Errorf("record = %v", rec)
	}
}

func TestRunWithoutCheckResultWritesNoCheckRecord(t *testing.T) {
	r := newRig(t)
	newRunIDFn = func() (string, error) { return runA, nil }

	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) {
		return []tmux.RunWindow{{WindowID: "@3", RunID: runB}}, nil
	}
	if got := Run(context.Background(), fire()); got.String() != "skipped-busy: run "+runB {
		t.Fatalf("outcome = %q", got.String())
	}
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) { return nil, nil }
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		return operator.CheckResult{}, errBoom
	}
	if got := Run(context.Background(), fire()); got.String() != "check-failed: boom" {
		t.Fatalf("outcome = %q", got.String())
	}
	if ids, _ := ListCheckIDs(r.runsDir()); len(ids) != 0 {
		t.Fatalf("check records written for skipped-busy/check-failed fires: %v", ids)
	}
}

// TestRunCheckRecordWriteFailureKeepsOutcome: a runs dir that cannot be
// created only costs the record.
func TestRunCheckRecordWriteFailureKeepsOutcome(t *testing.T) {
	r := newRig(t)
	newRunIDFn = func() (string, error) { return runA, nil }
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		return operator.CheckResult{}, nil
	}
	runs := filepath.Dir(r.runsDir())
	if err := os.MkdirAll(runs, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.runsDir(), []byte("not a dir"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Run(context.Background(), fire()); got.String() != cron.OutcomeNoChange || got.Held {
		t.Fatalf("outcome = %+v, want a plain no change", got)
	}
}

// TestPruneKeepsNewestTwoHundredCheckRecords: check records prune on their own
// count and leave run records alone.
func TestPruneKeepsNewestTwoHundredCheckRecords(t *testing.T) {
	r := newRig(t)
	dir := r.runsDir()
	run := "20261112T000001-aaaa"
	r.writeRun(Record{ID: run, Server: testServer, Logged: true})
	var ids []string
	for i := 0; i < CheckRetention+5; i++ {
		id := fmt.Sprintf("20261112T%06d-bbbb", i+10)
		ids = append(ids, id)
		if err := WriteCheckRecord(dir, id, newCheckRecord("2026-11-12T10:15:00Z", "schedule", operator.CheckResult{}, "")); err != nil {
			t.Fatal(err)
		}
	}
	if err := Prune(dir); err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		p, _ := CheckRecordPath(dir, id)
		if want := i >= 5; exists(t, p) != want {
			t.Errorf("check record %d kept=%v, want %v", i, exists(t, p), want)
		}
	}
	if !exists(t, mustRecordPath(t, r, run)) {
		t.Error("pruning check records removed a run record")
	}
	if got, _ := ListCheckIDs(dir); len(got) != CheckRetention {
		t.Errorf("check records left = %d, want %d", len(got), CheckRetention)
	}
	if got, _ := listRunIDs(dir); len(got) != 1 {
		t.Errorf("run listing sees check records: %v", got)
	}
}
