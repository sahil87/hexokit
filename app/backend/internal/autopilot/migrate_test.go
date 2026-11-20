package autopilot

import (
	"path/filepath"
	"testing"

	"rk/internal/operator"
)

func TestMigrateEngineStateMovesKeysAndKeepsNotes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.yaml")
	now := operator.NowRFC3339()
	seed := operator.TrackedItem{ID: "a1", Kind: operator.KindPane, DependsOn: []string{"a0"}, Scope: map[string]interface{}{
		"queue": "a1-q", "merge_mode": operator.MergeModeCherryPickLadder, "pane": "%1", "session": "repo",
		"repo": "/repo", "change": "a1", "branch": "feature", "spawning": now, "respawned": true,
		"escalated": map[string]interface{}{"old": now}, "stage": "apply",
	}, Last: map[string]interface{}{}, Notes: []operator.Note{{At: now, By: operator.ByUser, Text: "keep me"}}}
	other := operator.TrackedItem{ID: "ordinary", Kind: operator.KindPane, Scope: map[string]interface{}{"pane": "%9"}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, seed, other)
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(engine.Queue) != 1 || engine.Queue[0].ID != "a1" || !engine.Queue[0].Projected || engine.Queue[0].Spawning != now {
		t.Fatalf("engine = %#v", engine.Queue)
	}
	ledger, err := operator.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger.Tracked) != 2 || len(ledger.Tracked[0].Notes) != 1 || ledger.Tracked[0].Scope["stage"] != "apply" {
		t.Fatalf("ledger = %#v", ledger.Tracked)
	}
	for _, key := range []string{"queue", "merge_mode", "spawning", "respawned", "escalated"} {
		if _, ok := ledger.Tracked[0].Scope[key]; ok {
			t.Fatalf("engine key %s left in projection", key)
		}
	}
	if len(ledger.Tracked[0].DependsOn) != 0 {
		t.Fatal("projection kept dependency edges")
	}
}

func TestMigrateEngineStateFileWinsAfterCrash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.yaml")
	original := operator.TrackedItem{ID: "legacy", Kind: operator.KindPane, Scope: map[string]interface{}{
		"merge_mode": operator.MergeModeMergeAuto, "repo": "/repo", "change": "legacy",
	}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, original)
	if err := writeEngineFile(path, &engineState{Version: 1, Queue: []engineItem{{ID: "legacy", MergeMode: operator.MergeModeStackedPRs, Repo: "/engine", Escalated: map[string]interface{}{}}}}); err != nil {
		t.Fatal(err)
	}
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(engine.Queue) != 1 || engine.Queue[0].MergeMode != operator.MergeModeStackedPRs || engine.Queue[0].Repo != "/engine" {
		t.Fatalf("ledger overwrote engine values: %#v", engine.Queue)
	}
	ledger, err := operator.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger.Tracked) != 0 {
		t.Fatalf("note-less unspawned item not removed: %#v", ledger.Tracked)
	}
}

// A github-pr item carrying scope.merge_seq is an ordinary ledger item: the
// migration moves the queue pane item and leaves the PR item exactly as it was.
func TestMigrateEngineStateLeavesSequencePRItemsInTheLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.yaml")
	pr, err := operator.NewGitHubPRItem("pr-41", []string{"pr-40"}, map[string]interface{}{
		"repo": "/repo", "pr": 41, "change": "a1", "merge_seq": "repo", "item": "a1", "halted": true,
	}, "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	queue := operator.TrackedItem{ID: "a1", Kind: operator.KindPane, Scope: map[string]interface{}{"merge_mode": operator.MergeModeCherryPickLadder, "pane": "%1"}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, queue, pr)
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(engine.Queue) != 1 || engine.Queue[0].ID != "a1" {
		t.Fatalf("migration = %#v", engine)
	}
	ledger, err := operator.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	got := ledger.Tracked[operator.IndexOf(ledger.Tracked, "pr-41")]
	if got.Scope["merge_seq"] != "repo" || got.Scope["item"] != "a1" || got.Scope["halted"] != true || len(got.DependsOn) != 1 || got.DependsOn[0] != "pr-40" {
		t.Fatalf("the PR item was rewritten by the migration: %#v", got)
	}
}

func writeOperatorItems(t *testing.T, path string, items ...operator.TrackedItem) {
	t.Helper()
	if err := operator.Mutate(path, func(st *operator.State) error {
		st.Tracked = append(st.Tracked, items...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationRunsOnlyOnceAndLaterScopeKeysAreIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.yaml")
	original := operator.TrackedItem{ID: "first", Kind: operator.KindPane, Scope: map[string]interface{}{
		"queue": "q1", "merge_mode": operator.MergeModeMergeAuto, "repo": "/repo",
	}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, original)
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(path)
	if err != nil || !engine.Migrated || len(engine.Queue) != 1 {
		t.Fatalf("initial migration = %+v, %v", engine, err)
	}
	later := operator.TrackedItem{ID: "later", Kind: operator.KindGitHubPR, Scope: map[string]interface{}{
		"queue": "later", "merge_mode": operator.MergeModeMergeAuto, "merge_seq": "later-seq", "pr": 99,
	}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, later)
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err = loadEngineFile(path)
	if err != nil || len(engine.Queue) != 1 {
		t.Fatalf("later write was migrated: %+v, %v", engine, err)
	}
	view, _, err := engineView(path)
	if err != nil {
		t.Fatal(err)
	}
	if legacyQueueItem(view, view.Tracked[operator.IndexOf(view.Tracked, "later")]) {
		t.Fatal("post-migration scope keys created queue work")
	}
	ledger, err := operator.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := ledger.Tracked[operator.IndexOf(ledger.Tracked, "later")].Scope["queue"]; got != "later" {
		t.Fatalf("one-time migration rewrote a later ledger item: %v", got)
	}
}
