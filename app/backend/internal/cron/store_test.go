package cron

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLoadEntriesTolerant(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.yaml")
	content := `
unknown_top_level: ignored
entries:
  - id: a3f9
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%12" }
    payload: "tick"
    unknown_entry_key: ignored
  - id: b4d2
    schedule: { kind: bogus }
    target: { kind: pane, pane: "%12" }
    payload: "bad kind"
  - id: c5e3
    schedule: { kind: every, interval: not-a-duration }
    target: { kind: pane, pane: "%12" }
    payload: "bad duration"
  - just-a-scalar
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(entries) != 1 || entries[0].ID != "a3f9" {
		t.Fatalf("entries = %+v, want only a3f9", entries)
	}
	if entries[0].Schedule.Interval.Duration != time.Hour {
		t.Errorf("interval = %v", entries[0].Schedule.Interval)
	}
	var reasons []string
	for _, d := range diags {
		reasons = append(reasons, d.Reason)
	}
	// b4d2 (bogus kind), c5e3 (bad duration), and the scalar node.
	if len(diags) != 3 {
		t.Fatalf("diags = %v", reasons)
	}
	for _, d := range diags {
		if d.Reason != "entry-invalid" {
			t.Errorf("diag reason = %q", d.Reason)
		}
	}
}

func TestLoadEntriesAbsentFile(t *testing.T) {
	entries, diags := LoadEntries(filepath.Join(t.TempDir(), "nope.yaml"))
	if entries != nil || diags != nil {
		t.Errorf("absent file: entries=%v diags=%v, want nil/nil", entries, diags)
	}
}

func TestLoadEntriesCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.yaml")
	if err := os.WriteFile(path, []byte("{{{{ not yaml: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(entries) != 0 {
		t.Errorf("entries = %v, want empty", entries)
	}
	if len(diags) != 1 || diags[0].Reason != "entry-file-corrupt" {
		t.Errorf("diags = %+v, want one entry-file-corrupt", diags)
	}
}

func TestAddGeneratesIDAndWritesAtomically(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	e, err := Add(dir, "dev", Entry{
		Name:     "hourly PR sweep",
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Hour}},
		Target:   Target{Kind: TargetSession, Session: "4fe2"},
		Payload:  "check open PRs",
		Deliver:  DeliverWhenIdle,
		IfAbsent: IfAbsentSkip,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(e.ID) != 4 {
		t.Fatalf("id = %q, want 4 chars", e.ID)
	}
	want := filepath.Join(dir, "dev.yaml")
	st, err := os.Stat(want)
	if err != nil {
		t.Fatalf("entry file not written: %v", err)
	}
	if st.Mode().Perm() != fileMode {
		t.Errorf("mode = %o, want %o", st.Mode().Perm(), fileMode)
	}
	entries, diags := LoadEntries(want)
	if len(diags) != 0 || len(entries) != 1 {
		t.Fatalf("reload: entries=%v diags=%v", entries, diags)
	}
	if !reflect.DeepEqual(entries[0], e) {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", entries[0], e)
	}
	// Intent only: no runtime facts leak into the file.
	data, _ := os.ReadFile(want)
	for _, fact := range []string{"last_fired", "next_fire", "rung"} {
		if strings.Contains(string(data), fact) {
			t.Errorf("file contains runtime fact %q", fact)
		}
	}
	// A second add gets a distinct id.
	e2, err := Add(dir, "dev", Entry{
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
		Target:   Target{Kind: TargetPane, Pane: "%1"},
		Payload:  "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if e2.ID == e.ID {
		t.Errorf("duplicate id %q", e2.ID)
	}
}

func TestAddRejectsTraversalSlug(t *testing.T) {
	dir := t.TempDir()
	_, err := Add(dir, "../escape", Entry{
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
		Target:   Target{Kind: TargetPane, Pane: "%1"},
		Payload:  "x",
	})
	if err == nil {
		t.Fatal("Add accepted traversal slug")
	}
	// No path outside dir was built.
	if _, err := os.Stat(filepath.Join(dir, "..", "escape.yaml")); !os.IsNotExist(err) {
		t.Errorf("traversal file exists")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("dir not empty: %v", entries)
	}
}

func TestMutations(t *testing.T) {
	dir := t.TempDir()
	entry := Entry{
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
		Target:   Target{Kind: TargetPane, Pane: "%1"},
		Payload:  "x",
	}
	e, err := Add(dir, "dev", entry)
	if err != nil {
		t.Fatal(err)
	}

	ok, err := SetMuted(dir, "dev", e.ID, true)
	if err != nil || !ok {
		t.Fatalf("SetMuted: ok=%v err=%v", ok, err)
	}
	ok, err = SetPinned(dir, "dev", e.ID, true)
	if err != nil || !ok {
		t.Fatalf("SetPinned: ok=%v err=%v", ok, err)
	}
	entries, _ := LoadEntries(filepath.Join(dir, "dev.yaml"))
	if !entries[0].Muted || !entries[0].Pinned {
		t.Errorf("after mutations: %+v", entries[0])
	}

	// Absent id ⇒ false, no error, file untouched.
	ok, err = SetMuted(dir, "dev", "zzzz", true)
	if err != nil || ok {
		t.Errorf("SetMuted absent id: ok=%v err=%v", ok, err)
	}
	ok, err = Remove(dir, "dev", "zzzz")
	if err != nil || ok {
		t.Errorf("Remove absent id: ok=%v err=%v", ok, err)
	}

	ok, err = Remove(dir, "dev", e.ID)
	if err != nil || !ok {
		t.Fatalf("Remove: ok=%v err=%v", ok, err)
	}
	entries, _ = LoadEntries(filepath.Join(dir, "dev.yaml"))
	if len(entries) != 0 {
		t.Errorf("entries after remove = %v", entries)
	}
}

func TestMutateRefusesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.yaml")
	if err := os.WriteFile(path, []byte("{{{{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Add(dir, "dev", Entry{
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
		Target:   Target{Kind: TargetPane, Pane: "%1"},
		Payload:  "x",
	})
	if err == nil {
		t.Fatal("Add over corrupt file succeeded — existing intent would be dropped")
	}
}

// TestAddEntryCap: Add refuses past MaxEntriesPerServer with a named-cap
// error and leaves the file unchanged; at cap-1 it still adds.
func TestAddEntryCap(t *testing.T) {
	dir := t.TempDir()
	newEntry := func() Entry {
		return Entry{
			Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
			Target:   Target{Kind: TargetPane, Pane: "%1"},
			Payload:  "x",
		}
	}

	// Fill to the cap directly (Add assigns ids; building via saveEntries
	// keeps the fixture deterministic).
	entries := make([]Entry, MaxEntriesPerServer)
	for i := range entries {
		e := newEntry()
		e.ID = fmt.Sprintf("e%03d", i)
		entries[i] = e
	}
	path, err := EntriesPath(dir, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveEntries(path, entries); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	_, err = Add(dir, "dev", newEntry())
	if err == nil || !strings.Contains(err.Error(), "50") {
		t.Fatalf("Add past the cap: err = %v, want a refusal naming the cap", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("entry file changed despite the refused Add")
	}

	// Cap-1 still adds.
	if _, err := Remove(dir, "dev", entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(dir, "dev", newEntry()); err != nil {
		t.Errorf("Add at cap-1: %v", err)
	}
}

// TestMuteWriteRules is the lease write matrix: a lease replaces an indefinite
// flag; an indefinite mute replaces a lease; unmuting clears both; all through
// the atomic read-modify-write, and a corrupt file refuses to mutate.
func TestMuteWriteRules(t *testing.T) {
	newEntry := func(t *testing.T, dir string) Entry {
		t.Helper()
		e, err := Add(dir, "dev", Entry{
			Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Minute}},
			Target:   Target{Kind: TargetPane, Pane: "%1"},
			Payload:  "x",
		})
		if err != nil {
			t.Fatal(err)
		}
		return e
	}

	t.Run("lease after flag leaves only muted_until", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		if ok, err := SetMuted(dir, "dev", e.ID, true); err != nil || !ok {
			t.Fatalf("SetMuted: ok=%v err=%v", ok, err)
		}
		until := time.Now().Add(5 * time.Minute).Unix()
		if ok, err := SetMuteLease(dir, "dev", e.ID, until); err != nil || !ok {
			t.Fatalf("SetMuteLease: ok=%v err=%v", ok, err)
		}
		entries, _ := LoadEntries(filepath.Join(dir, "dev.yaml"))
		if entries[0].Muted || entries[0].MutedUntil != until {
			t.Errorf("after lease: muted=%v muted_until=%d, want false/%d", entries[0].Muted, entries[0].MutedUntil, until)
		}
		data, _ := os.ReadFile(filepath.Join(dir, "dev.yaml"))
		if strings.Contains(string(data), "muted:") {
			t.Errorf("file still carries the muted: key:\n%s", data)
		}
	})

	t.Run("flag after lease leaves only muted", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		if ok, err := SetMuteLease(dir, "dev", e.ID, time.Now().Add(5*time.Minute).Unix()); err != nil || !ok {
			t.Fatalf("SetMuteLease: ok=%v err=%v", ok, err)
		}
		if ok, err := SetMuted(dir, "dev", e.ID, true); err != nil || !ok {
			t.Fatalf("SetMuted: ok=%v err=%v", ok, err)
		}
		entries, _ := LoadEntries(filepath.Join(dir, "dev.yaml"))
		if !entries[0].Muted || entries[0].MutedUntil != 0 {
			t.Errorf("after mute: muted=%v muted_until=%d, want true/0", entries[0].Muted, entries[0].MutedUntil)
		}
	})

	t.Run("unmute clears both", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		if ok, err := SetMuteLease(dir, "dev", e.ID, time.Now().Add(5*time.Minute).Unix()); err != nil || !ok {
			t.Fatalf("SetMuteLease: ok=%v err=%v", ok, err)
		}
		if ok, err := SetMuted(dir, "dev", e.ID, false); err != nil || !ok {
			t.Fatalf("SetMuted(false): ok=%v err=%v", ok, err)
		}
		data, _ := os.ReadFile(filepath.Join(dir, "dev.yaml"))
		if strings.Contains(string(data), "muted") {
			t.Errorf("file still carries a mute key:\n%s", data)
		}
	})

	t.Run("corrupt file refuses the lease mutation", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "dev.yaml"), []byte("{{{{"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := SetMuteLease(dir, "dev", "a3f9", time.Now().Unix()); err == nil {
			t.Fatal("SetMuteLease over a corrupt file succeeded")
		}
	})
}

// TestUpdateMergesFields: an apply that sets Schedule and Deliver leaves every
// other field identical after reload; a merged entry that fails validate()
// writes nothing; an absent id is (Entry{}, false, nil); a corrupt file
// refuses to mutate.
func TestUpdateMergesFields(t *testing.T) {
	newEntry := func(t *testing.T, dir string) Entry {
		t.Helper()
		e, err := Add(dir, "dev", Entry{
			Name:     "sweep",
			Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Hour}},
			Target:   Target{Kind: TargetSession, Session: "4fe2"},
			Payload:  "check open PRs",
			IfAbsent: IfAbsentRespawn,
			Respawn:  []string{"rk", "operator"},
			CreatedBy: CreatedBy{
				Session: "4fe2",
				Pane:    "%7",
				At:      time.Now().Add(-time.Hour).Unix(),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return e
	}

	t.Run("merge leaves every other field identical", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		if ok, err := SetMuted(dir, "dev", e.ID, true); err != nil || !ok {
			t.Fatalf("SetMuted: ok=%v err=%v", ok, err)
		}
		until := time.Now().Add(5 * time.Minute).Unix()
		if ok, err := SetMuteLease(dir, "dev", e.ID, until); err != nil || !ok {
			t.Fatalf("SetMuteLease: ok=%v err=%v", ok, err)
		}
		if ok, err := SetPinned(dir, "dev", e.ID, true); err != nil || !ok {
			t.Fatalf("SetPinned: ok=%v err=%v", ok, err)
		}
		path := filepath.Join(dir, "dev.yaml")
		before := mustOnlyEntry(t, path)

		newSchedule := Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{3 * time.Minute}}
		merged, ok, err := Update(dir, "dev", e.ID, func(e *Entry) {
			e.Schedule = newSchedule
			e.Deliver = DeliverWhenIdle
		})
		if err != nil || !ok {
			t.Fatalf("Update: ok=%v err=%v", ok, err)
		}
		if merged.Schedule != newSchedule || merged.Deliver != DeliverWhenIdle {
			t.Errorf("merged = %+v, want the new schedule and deliver", merged)
		}

		after := mustOnlyEntry(t, path)
		if after.Schedule != newSchedule || after.Deliver != DeliverWhenIdle {
			t.Errorf("reloaded schedule/deliver = %v/%q", after.Schedule, after.Deliver)
		}
		if after.ID != before.ID || after.Name != before.Name ||
			after.Target != before.Target || after.Payload != before.Payload ||
			after.IfAbsent != before.IfAbsent || !reflect.DeepEqual(after.Respawn, before.Respawn) ||
			after.Pinned != before.Pinned || after.Muted != before.Muted ||
			after.MutedUntil != before.MutedUntil || after.CreatedBy != before.CreatedBy {
			t.Errorf("identity fields drifted:\nbefore %+v\nafter  %+v", before, after)
		}
	})

	t.Run("a merge failing validate writes nothing", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		path := filepath.Join(dir, "dev.yaml")
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		_, _, err = Update(dir, "dev", e.ID, func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleBackoff, Min: Duration{5 * time.Minute}, Max: Duration{time.Minute}}
		})
		if err == nil {
			t.Fatal("Update with max < min succeeded")
		}
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(before) != string(after) {
			t.Error("entry file changed despite the rejected merge")
		}
	})

	t.Run("absent id is the Remove shape", func(t *testing.T) {
		dir := t.TempDir()
		newEntry(t, dir)
		merged, ok, err := Update(dir, "dev", "zzzz", func(e *Entry) { e.Name = "nope" })
		if err != nil || ok || !reflect.DeepEqual(merged, Entry{}) {
			t.Errorf("Update absent id: merged=%+v ok=%v err=%v, want zero/false/nil", merged, ok, err)
		}
	})

	t.Run("apply cannot move identity fields", func(t *testing.T) {
		dir := t.TempDir()
		e := newEntry(t, dir)
		path := filepath.Join(dir, "dev.yaml")
		before := mustOnlyEntry(t, path)

		merged, ok, err := Update(dir, "dev", e.ID, func(e *Entry) {
			e.ID = "zzzz"
			e.Target = Target{Kind: TargetPane, Pane: "%99"}
			e.CreatedBy = CreatedBy{}
			e.Muted = true
			e.MutedUntil = 123
			e.Pinned = true
			e.Name = "renamed"
		})
		if err != nil || !ok {
			t.Fatalf("Update: ok=%v err=%v", ok, err)
		}
		if merged.Name != "renamed" {
			t.Errorf("merged.Name = %q, want the apply's edit kept", merged.Name)
		}
		after := mustOnlyEntry(t, path)
		if after.ID != before.ID || after.Target != before.Target ||
			after.CreatedBy != before.CreatedBy || after.Muted != before.Muted ||
			after.MutedUntil != before.MutedUntil || after.Pinned != before.Pinned {
			t.Errorf("identity fields moved:\nbefore %+v\nafter  %+v", before, after)
		}
	})

	t.Run("corrupt file refuses to mutate", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "dev.yaml"), []byte("{{{{"), 0o600); err != nil {
			t.Fatal(err)
		}
		_, _, err := Update(dir, "dev", "a3f9", func(e *Entry) { e.Name = "nope" })
		if err == nil || !strings.Contains(err.Error(), "refusing to mutate") {
			t.Errorf("Update over a corrupt file: err = %v, want refusing to mutate", err)
		}
	})
}

func mustOnlyEntry(t *testing.T, path string) Entry {
	t.Helper()
	entries, diags := LoadEntries(path)
	if len(diags) != 0 || len(entries) != 1 {
		t.Fatalf("reload: entries=%v diags=%v", entries, diags)
	}
	return entries[0]
}

func TestLoadEntriesMixedLoopFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.yaml")
	content := `
entries:
  - id: lp01
    run: operator-loop
    payload: "should not be here"
    schedule: { kind: backoff, min: 3m, max: 24m }
  - id: lp02
    run: operator-loop
    schedule: { kind: backoff, min: 3m, max: 24m }
  - id: a3f9
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%12" }
    payload: "tick"
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(entries) != 2 || entries[0].ID != "lp02" || entries[1].ID != "a3f9" {
		t.Fatalf("entries = %+v", entries)
	}
	if len(diags) != 1 || diags[0].Reason != "entry-invalid" || diags[0].EntryID != "lp01" {
		t.Fatalf("diags = %+v", diags)
	}
}

func TestAddLoopEntryOnePerServer(t *testing.T) {
	dir := t.TempDir()
	loop := Entry{Run: RunOperatorLoop, Name: "operator loop", Pinned: true,
		Schedule:  Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{24 * time.Minute}},
		CreatedBy: CreatedBy{At: 1}}
	first, err := Add(dir, "dev", loop)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Add(dir, "dev", loop); err == nil || !strings.Contains(err.Error(), first.ID) {
		t.Fatalf("second loop Add err = %v, want refusal naming %s", err, first.ID)
	}
	// A typed entry still adds beside it, and a loop entry on another server.
	if _, err := Add(dir, "dev", Entry{Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Hour}},
		Target: Target{Kind: TargetPane, Pane: "%1"}, Payload: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Add(dir, "other", loop); err != nil {
		t.Fatal(err)
	}
}

func TestLoopEntryMutationsWork(t *testing.T) {
	dir := t.TempDir()
	e, err := Add(dir, "dev", Entry{Run: RunOperatorLoop,
		Schedule: Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{24 * time.Minute}}})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := SetMuted(dir, "dev", e.ID, true); err != nil || !ok {
		t.Fatalf("mute: %v %v", ok, err)
	}
	if ok, err := SetPinned(dir, "dev", e.ID, true); err != nil || !ok {
		t.Fatalf("pin: %v %v", ok, err)
	}
	got, ok, err := Update(dir, "dev", e.ID, func(m *Entry) {
		m.Schedule = Schedule{Kind: ScheduleBackoff, Min: Duration{time.Minute}, Max: Duration{10 * time.Minute}}
	})
	if err != nil || !ok || got.Schedule.Min.Duration != time.Minute || !got.IsLoop() {
		t.Fatalf("edit: %+v %v %v", got, ok, err)
	}
	if _, _, err := Update(dir, "dev", e.ID, func(m *Entry) { m.Payload = "x" }); err == nil {
		t.Error("edit adding a payload to a loop entry must fail validation")
	}
	if ok, err := Remove(dir, "dev", e.ID); err != nil || !ok {
		t.Fatalf("rm: %v %v", ok, err)
	}
}
