package cron

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// TestParseWatchlist is the tolerant-parse table over both file shapes,
// re-pointed at the join projection: ParseOperatorState(...).WatchlistEntries()
// must yield exactly the entry set the reader has always joined by pane
// (pane-bearing, not-done items, sorted by id) — the fab-kit ≥ 2.25 tracked:
// list and the legacy monitored: map (parsed only when tracked is absent).
// Unknown keys are ignored; corrupt YAML fails.
func TestParseWatchlist(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantEntries []WatchlistEntry
		wantTickAt  int64
		wantOK      bool
	}{
		{
			name: "populated monitored map (verified fab-kit schema)",
			body: `# fab-owned schema; unknown keys must be tolerated
unrelated_key: 42
last_tick_at: 1700000000
monitored:
  gmcp:
    pane: "%23"
    repo: /home/user/repo
    session: s1
    stage: active
    agent: active
    branch: feat/gmcp
    stop_stage: done
    spawned_by: autopilot
    depends_on: [a, b]
    enrolled_at: "2026-09-07T10:00:00Z"
    last_transition: "2026-09-07T11:00:00Z"
  pending-c5:
    pane: "%31"
    repo: /home/user/other
    session: s2
    branch: main
`,
			wantEntries: []WatchlistEntry{
				{ChangeID: "gmcp", Pane: "%23", Repo: "/home/user/repo", Session: "s1", Stage: "active", Agent: "active", Branch: "feat/gmcp"},
				{ChangeID: "pending-c5", Pane: "%31", Repo: "/home/user/other", Session: "s2", Branch: "main"},
			},
			wantTickAt: 1700000000,
			wantOK:     true,
		},
		{
			name: "entry missing pane is skipped",
			body: `monitored:
  good: {pane: "%7", repo: /r, session: s, branch: b}
  no-pane: {repo: /r2, session: s2, branch: b2}
  scalar-entry: just-a-string
`,
			wantEntries: []WatchlistEntry{{ChangeID: "good", Pane: "%7", Repo: "/r", Session: "s", Branch: "b"}},
			wantOK:      true,
		},
		{
			name:        "empty file parses as present with nothing",
			body:        "",
			wantEntries: nil,
			wantTickAt:  0,
			wantOK:      true,
		},
		{
			name:        "list-shaped monitored yields no entries",
			body:        "monitored:\n  - {change: x, pane: \"%12\"}\n",
			wantEntries: nil,
			wantOK:      true,
		},
		{
			name:       "RFC3339 last_tick_at",
			body:       "last_tick_at: \"2026-09-07T12:00:00Z\"\n",
			wantOK:     true,
			wantTickAt: time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC).Unix(),
		},
		{
			name:   "corrupt YAML fails the parse",
			body:   "{{{{ not yaml",
			wantOK: false,
		},
		// --- fab-kit ≥ 2.25 tracked: list ---
		{
			name: "tracked list mirroring a live 2.25 state file",
			body: `branch_map:
    pa9n:
        branch: 260911-pa9n-gk-cleanup-10-cursio-owns-cursor
        repo: /home/sahil/code/wvrdz/loom
last_full_at: "2026-09-11T13:38:24Z"
last_tick_at: "2026-09-11T13:38:24Z"
tick_count: 2816
tracked:
    - id: pa9n
      kind: fab-change
      probe:
        mode: pane
      check_every: null
      done_when: null
      then: null
      depends_on: []
      scope:
        agent: idle
        branch: 260911-pa9n-gk-cleanup-10-cursio-owns-cursor
        merge_mode: null
        pane: '%180'
        repo: /home/sahil/code/wvrdz/loom
        session: loom
        spawned_by: null
        stage: apply
        stop_stage: null
      last: {}
      checked_at: null
      unchanged: 0
      failures: 0
      paused: false
      done_at: null
      added_at: "2026-09-11T13:20:14Z"
      updated_at: "2026-09-11T13:20:14Z"
`,
			wantEntries: []WatchlistEntry{{
				ChangeID: "pa9n", Pane: "%180", Repo: "/home/sahil/code/wvrdz/loom", Session: "loom",
				Stage: "apply", Agent: "idle", Branch: "260911-pa9n-gk-cleanup-10-cursio-owns-cursor", Kind: "fab-change",
			}},
			wantTickAt: time.Date(2026, 9, 11, 13, 38, 24, 0, time.UTC).Unix(),
			wantOK:     true,
		},
		{
			name: "tracked: pane-less items join nothing, null scope fields read as empty",
			body: `tracked:
  - {id: queued, kind: fab-change, scope: {pane: null, repo: /r, branch: b}}
  - {id: pr77, kind: github-pr, scope: {repo: /r, pr: 77}}
  - {id: live, kind: fab-change, scope: {pane: "%5", repo: /r, session: s, stage: null, agent: null, branch: b}}
`,
			wantEntries: []WatchlistEntry{{ChangeID: "live", Pane: "%5", Repo: "/r", Session: "s", Branch: "b", Kind: "fab-change"}},
			wantOK:      true,
		},
		{
			name: "tracked: done items are excluded from the join, paused items stay",
			body: `tracked:
  - {id: finished, kind: fab-change, scope: {pane: "%1"}, done_at: "2026-09-11T12:00:00Z"}
  - {id: napping, kind: fab-change, scope: {pane: "%2"}, paused: true, failures: 3, done_at: null}
`,
			wantEntries: []WatchlistEntry{{ChangeID: "napping", Pane: "%2", Kind: "fab-change"}},
			wantOK:      true,
		},
		{
			name:        "tracked: kind is not a filter — any item with a pane is watched",
			body:        "tracked:\n  - {id: probe, kind: shell, scope: {pane: \"%9\", repo: /r}}\n",
			wantEntries: []WatchlistEntry{{ChangeID: "probe", Pane: "%9", Repo: "/r", Kind: "shell"}},
			wantOK:      true,
		},
		{
			name: "tracked: malformed items are skipped, the well-formed sibling parses",
			body: `tracked:
  - just-a-string
  - {kind: fab-change, scope: {pane: "%3"}}
  - {id: badscope, kind: fab-change, scope: "not-a-map"}
  - {id: good, kind: fab-change, scope: {pane: "%4"}}
`,
			// badscope is kept in Items (a non-map scope no longer skips) but
			// joins nothing — the join still requires a pane.
			wantEntries: []WatchlistEntry{{ChangeID: "good", Pane: "%4", Kind: "fab-change"}},
			wantOK:      true,
		},
		{
			name:        "tracked: a map-shaped value yields no entries",
			body:        "tracked:\n  pa9n: {id: pa9n, scope: {pane: \"%1\"}}\n",
			wantEntries: nil,
			wantOK:      true,
		},
		{
			name:        "tracked: a scalar value yields no entries",
			body:        "tracked: 3\n",
			wantEntries: nil,
			wantOK:      true,
		},
		{
			name: "both present: tracked wins, the legacy map is ignored",
			body: `monitored:
  legacy: {pane: "%1", repo: /old}
tracked:
  - {id: new, kind: fab-change, scope: {pane: "%2"}}
`,
			wantEntries: []WatchlistEntry{{ChangeID: "new", Pane: "%2", Kind: "fab-change"}},
			wantOK:      true,
		},
		{
			name:        "both present: an empty tracked list still wins by key presence",
			body:        "monitored:\n  legacy: {pane: \"%1\"}\ntracked: []\n",
			wantEntries: nil,
			wantOK:      true,
		},
		{
			name: "tracked: entries sort by id, not list order",
			body: `tracked:
  - {id: zz, kind: fab-change, scope: {pane: "%2"}}
  - {id: aa, kind: fab-change, scope: {pane: "%1"}}
`,
			wantEntries: []WatchlistEntry{{ChangeID: "aa", Pane: "%1", Kind: "fab-change"}, {ChangeID: "zz", Pane: "%2", Kind: "fab-change"}},
			wantOK:      true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, ok := ParseOperatorState([]byte(tc.body))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			entries := state.WatchlistEntries()
			if !reflect.DeepEqual(entries, tc.wantEntries) {
				t.Errorf("entries = %+v, want %+v", entries, tc.wantEntries)
			}
			if state.LastTickAt != tc.wantTickAt {
				t.Errorf("lastTickAt = %d, want %d", state.LastTickAt, tc.wantTickAt)
			}
		})
	}
}

// TestParseOperatorStateItems covers the full-list projection: every
// id-bearing tracked: item lands in Items (pane-less, done, paused,
// scope-less) with its display fields, in list order — while
// WatchlistEntries() still yields only the pane-bearing not-done subset.
func TestParseOperatorStateItems(t *testing.T) {
	added := time.Date(2026, 9, 3, 6, 19, 19, 0, time.UTC).Unix()
	updated := time.Date(2026, 9, 3, 9, 57, 8, 0, time.UTC).Unix()

	t.Run("live-file note shape: text, refs, timestamps, no pane, not in the join", func(t *testing.T) {
		body := `last_tick_at: 1700000000
tracked:
  - id: n1
    kind: note
    probe: {mode: none}
    check_every: null
    done_when: null
    then: null
    depends_on: []
    scope:
      refs: [y60c, np2w]
    last: {}
    text: "A=71yx PR #834 still open — archive once merged"
    checked_at: null
    unchanged: 0
    failures: 0
    paused: false
    done_at: null
    added_at: "2026-09-03T06:19:19Z"
    updated_at: "2026-09-03T09:57:08Z"
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok {
			t.Fatal("parse failed")
		}
		want := []TrackedItem{{
			ID: "n1", Kind: "note", Text: "A=71yx PR #834 still open — archive once merged",
			Refs: []string{"y60c", "np2w"}, DoneAt: 0, AddedAt: added, UpdatedAt: updated,
			Notes: []Note{{At: updated, By: "user", Text: "A=71yx PR #834 still open — archive once merged"}},
		}}
		if !reflect.DeepEqual(state.Items, want) {
			t.Errorf("Items = %+v, want %+v", state.Items, want)
		}
		if entries := state.WatchlistEntries(); len(entries) != 0 {
			t.Errorf("WatchlistEntries() = %+v, want empty for a pane-less note", entries)
		}
	})

	t.Run("done pane-bearing item: in Items with DoneAt, out of the join", func(t *testing.T) {
		body := `tracked:
  - {id: finished, kind: fab-change, scope: {pane: "%1", repo: /r}, done_at: "2026-09-11T10:00:00Z"}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		item := state.Items[0]
		if item.DoneAt != time.Date(2026, 9, 11, 10, 0, 0, 0, time.UTC).Unix() {
			t.Errorf("DoneAt = %d, want the RFC3339 done_at as unix seconds", item.DoneAt)
		}
		if entries := state.WatchlistEntries(); len(entries) != 0 {
			t.Errorf("WatchlistEntries() = %+v, want empty — a done item never joins", entries)
		}
	})

	t.Run("paused pane-bearing item: in both projections", func(t *testing.T) {
		body := `tracked:
  - {id: napping, kind: fab-change, scope: {pane: "%2"}, paused: true, done_at: null}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 || !state.Items[0].Paused {
			t.Fatalf("ok=%v Items=%+v, want one paused item", ok, state.Items)
		}
		entries := state.WatchlistEntries()
		if len(entries) != 1 || entries[0].ChangeID != "napping" {
			t.Errorf("WatchlistEntries() = %+v, want the paused item in the join", entries)
		}
	})

	t.Run("an item with no scope key is kept with empty scope fields", func(t *testing.T) {
		body := "tracked:\n  - {id: chore, kind: task, text: \"sweep the board\"}\n"
		state, ok := ParseOperatorState([]byte(body))
		if !ok {
			t.Fatal("parse failed")
		}
		want := []TrackedItem{{ID: "chore", Kind: "task", Text: "sweep the board"}}
		if !reflect.DeepEqual(state.Items, want) {
			t.Errorf("Items = %+v, want %+v", state.Items, want)
		}
	})

	t.Run("refs keeps string elements only", func(t *testing.T) {
		body := `tracked:
  - {id: n3, kind: note, scope: {refs: [y60c, 42, {nested: map}, np2w]}}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		if want := []string{"y60c", "np2w"}; !reflect.DeepEqual(state.Items[0].Refs, want) {
			t.Errorf("Refs = %v, want %v", state.Items[0].Refs, want)
		}
	})

	t.Run("Items keep list order; WatchlistEntries sorts by id", func(t *testing.T) {
		body := `tracked:
  - {id: zz, kind: fab-change, scope: {pane: "%2"}}
  - {id: note-mid, kind: note, text: middle}
  - {id: aa, kind: fab-change, scope: {pane: "%1"}}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok {
			t.Fatal("parse failed")
		}
		var gotOrder []string
		for _, item := range state.Items {
			gotOrder = append(gotOrder, item.ID)
		}
		if want := []string{"zz", "note-mid", "aa"}; !reflect.DeepEqual(gotOrder, want) {
			t.Errorf("Items order = %v, want list order %v", gotOrder, want)
		}
		entries := state.WatchlistEntries()
		if len(entries) != 2 || entries[0].ChangeID != "aa" || entries[1].ChangeID != "zz" {
			t.Errorf("WatchlistEntries() = %+v, want aa, zz", entries)
		}
	})

	t.Run("legacy monitored map: kind empty, pane-bearing, sorted by key", func(t *testing.T) {
		body := `monitored:
  zz: {pane: "%2"}
  aa: {pane: "%1", repo: /r}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok {
			t.Fatal("parse failed")
		}
		want := []TrackedItem{{ID: "aa", Pane: "%1", Repo: "/r"}, {ID: "zz", Pane: "%2"}}
		if !reflect.DeepEqual(state.Items, want) {
			t.Errorf("Items = %+v, want %+v", state.Items, want)
		}
		if entries := state.WatchlistEntries(); len(entries) != 2 || entries[0].ChangeID != "aa" {
			t.Errorf("WatchlistEntries() = %+v, want both legacy entries", entries)
		}
	})

	t.Run("malformed siblings skipped, the valid item kept", func(t *testing.T) {
		body := `tracked:
  - just-a-string
  - {kind: note, text: "no id"}
  - {id: good, kind: note, text: kept}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok {
			t.Fatal("parse failed")
		}
		want := []TrackedItem{{ID: "good", Kind: "note", Text: "kept", Notes: []Note{{By: "user", Text: "kept"}}}}
		if !reflect.DeepEqual(state.Items, want) {
			t.Errorf("Items = %+v, want %+v", state.Items, want)
		}
	})

	t.Run("an unparseable done_at reads as live", func(t *testing.T) {
		// The binary writes RFC3339 and nothing else; a bare word decodes to 0
		// (tolerant read — the item stays in the operator's set and in the join).
		body := `tracked:
  - {id: odd, kind: fab-change, scope: {pane: "%7"}, done_at: eventually}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		if state.Items[0].DoneAt != 0 {
			t.Errorf("DoneAt = %d, want 0 for an unparseable done_at", state.Items[0].DoneAt)
		}
		if entries := state.WatchlistEntries(); len(entries) != 1 || entries[0].ChangeID != "odd" {
			t.Errorf("WatchlistEntries() = %+v, want the item in the join (reads as live)", entries)
		}
	})

	t.Run("a non-list tracked value yields no items", func(t *testing.T) {
		state, ok := ParseOperatorState([]byte("tracked: 3\n"))
		if !ok || state.Items != nil {
			t.Errorf("ok=%v Items=%v, want true/nil", ok, state.Items)
		}
	})
}

// TestReadOperatorStateTrackedRoundTrip: a 2.25 tracked:-shaped file reads
// back present with its items and last_tick_at through the file path.
func TestReadOperatorStateTrackedRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.yaml")
	body := "last_tick_at: 1700000000\ntracked:\n  - {id: pa9n, kind: fab-change, scope: {pane: \"%180\", stage: apply}}\n  - {id: queued, kind: fab-change, scope: {pane: null}}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	state, present := ReadOperatorState(path)
	if !present || state.LastTickAt != 1700000000 {
		t.Fatalf("present=%v LastTickAt=%d, want true/1700000000", present, state.LastTickAt)
	}
	if len(state.Items) != 2 {
		t.Fatalf("Items = %+v, want both items (pane-bearing and pane-less)", state.Items)
	}
	want := []WatchlistEntry{{ChangeID: "pa9n", Pane: "%180", Stage: "apply", Kind: "fab-change"}}
	if entries := state.WatchlistEntries(); !reflect.DeepEqual(entries, want) {
		t.Errorf("WatchlistEntries() = %+v, want %+v", entries, want)
	}
}

// TestReadOperatorStateAbsentAndCorrupt: both degrade to (zero, false) —
// never an error, never a panic.
func TestReadOperatorStateAbsentAndCorrupt(t *testing.T) {
	if state, present := ReadOperatorState(filepath.Join(t.TempDir(), "nope.yaml")); present || state.Items != nil || state.LastTickAt != 0 {
		t.Errorf("absent: (%+v, %v), want (zero, false)", state, present)
	}
	path := filepath.Join(t.TempDir(), "dev.yaml")
	if err := os.WriteFile(path, []byte("{{{{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state, present := ReadOperatorState(path); present || state.Items != nil || state.LastTickAt != 0 {
		t.Errorf("corrupt: (%+v, %v), want (zero, false)", state, present)
	}
}

// TestReadOperatorStateRoundTrip: a populated legacy file reads back present
// with its items and last_tick_at.
func TestReadOperatorStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.yaml")
	body := "last_tick_at: 1700000000\nmonitored:\n  gmcp: {pane: \"%23\", stage: active}\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	state, present := ReadOperatorState(path)
	if !present || state.LastTickAt != 1700000000 {
		t.Fatalf("present=%v LastTickAt=%d, want true/1700000000", present, state.LastTickAt)
	}
	want := []WatchlistEntry{{ChangeID: "gmcp", Pane: "%23", Stage: "active"}}
	if entries := state.WatchlistEntries(); !reflect.DeepEqual(entries, want) {
		t.Errorf("WatchlistEntries() = %+v, want %+v", entries, want)
	}
}

// TestParseOperatorStateNotes covers the notes projection: rk's per-item
// notes: list in file order, the skip rules for malformed elements, and the
// synthesized user note for a fab note item that carries only text.
func TestParseOperatorStateNotes(t *testing.T) {
	t.Run("rk shape: pane kind, three notes in file order with unix at", func(t *testing.T) {
		body := `tracked:
  - id: x
    kind: pane
    scope: {pane: "%5", repo: /r}
    done_at: null
    notes:
      - {at: "2026-11-10T08:00:00Z", by: user, text: "watch the review"}
      - {at: "2026-11-10T09:00:00Z", by: run, text: "review passed"}
      - {at: 1762851600, by: chat, text: "merge when green"}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		want := []Note{
			{At: time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC).Unix(), By: "user", Text: "watch the review"},
			{At: time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC).Unix(), By: "run", Text: "review passed"},
			{At: 1762851600, By: "chat", Text: "merge when green"},
		}
		if !reflect.DeepEqual(state.Items[0].Notes, want) {
			t.Errorf("Notes = %+v, want %+v", state.Items[0].Notes, want)
		}
		entries := state.WatchlistEntries()
		if len(entries) != 1 || entries[0].Kind != "pane" || entries[0].Pane != "%5" {
			t.Errorf("WatchlistEntries() = %+v, want the kind: pane item joined", entries)
		}
	})

	t.Run("malformed note elements are skipped, never fatal", func(t *testing.T) {
		body := `tracked:
  - id: x
    kind: task
    notes:
      - "just a string"
      - {at: 1700000000, by: run}
      - {at: 1700000001, by: run, text: ""}
      - {at: 1700000002, by: user, text: kept}
      - 7
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 1 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		want := []Note{{At: 1700000002, By: "user", Text: "kept"}}
		if !reflect.DeepEqual(state.Items[0].Notes, want) {
			t.Errorf("Notes = %+v, want %+v", state.Items[0].Notes, want)
		}
	})

	t.Run("a non-list notes value yields none", func(t *testing.T) {
		state, ok := ParseOperatorState([]byte("tracked:\n  - {id: x, kind: task, notes: nope}\n"))
		if !ok || len(state.Items) != 1 || state.Items[0].Notes != nil {
			t.Errorf("ok=%v Items=%+v, want one item without notes", ok, state.Items)
		}
	})

	t.Run("fab note text becomes one user note at updated_at, falling back to added_at", func(t *testing.T) {
		body := `tracked:
  - {id: n1, kind: note, text: "archive once merged", added_at: 1700000000, updated_at: 1700000500}
  - {id: n2, kind: note, text: "only added", added_at: 1700000000}
  - {id: t1, kind: task, text: "not a note kind"}
`
		state, ok := ParseOperatorState([]byte(body))
		if !ok || len(state.Items) != 3 {
			t.Fatalf("ok=%v Items=%+v", ok, state.Items)
		}
		if want := []Note{{At: 1700000500, By: "user", Text: "archive once merged"}}; !reflect.DeepEqual(state.Items[0].Notes, want) {
			t.Errorf("n1 Notes = %+v, want %+v", state.Items[0].Notes, want)
		}
		if want := []Note{{At: 1700000000, By: "user", Text: "only added"}}; !reflect.DeepEqual(state.Items[1].Notes, want) {
			t.Errorf("n2 Notes = %+v, want %+v", state.Items[1].Notes, want)
		}
		if state.Items[2].Notes != nil {
			t.Errorf("task item Notes = %+v, want none", state.Items[2].Notes)
		}
	})

	t.Run("an explicit notes list wins over the item text", func(t *testing.T) {
		body := `tracked:
  - id: n1
    kind: note
    text: stale prose
    notes:
      - {at: 1700000000, by: run, text: real note}
`
		state, _ := ParseOperatorState([]byte(body))
		want := []Note{{At: 1700000000, By: "run", Text: "real note"}}
		if !reflect.DeepEqual(state.Items[0].Notes, want) {
			t.Errorf("Notes = %+v, want %+v", state.Items[0].Notes, want)
		}
	})
}
