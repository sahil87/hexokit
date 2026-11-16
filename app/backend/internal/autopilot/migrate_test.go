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
	if err := writeEngineFile(path, &engineState{Version: 1, Queue: []engineItem{{ID: "legacy", MergeMode: operator.MergeModeStackedPRs, Repo: "/engine", Escalated: map[string]interface{}{}}}, PRs: []engineItem{}}); err != nil {
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

func TestMigrateEngineStateAdoptShapeAndSequencePR(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.yaml")
	pr, err := operator.NewGitHubPRItem("pr-41", []string{"pr-40"}, map[string]interface{}{
		"repo": "/repo", "pr": 41, "change": "a1", "merge_seq": "repo", "item": "a1", "halted": true,
	}, "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	adopted := operator.TrackedItem{ID: "a1", Kind: operator.KindPane, Scope: map[string]interface{}{"merge_mode": operator.MergeModeCherryPickLadder}, Last: map[string]interface{}{}}
	writeOperatorItems(t, path, adopted, pr)
	if err := migrateEngineState(path); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(engine.Queue) != 1 || len(engine.PRs) != 1 || !engine.PRs[0].Halted || engine.PRs[0].NWO != "owner/repo" {
		t.Fatalf("migration = %#v", engine)
	}
	ledger, err := operator.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger.Tracked) != 1 || ledger.Tracked[0].ID != "pr-41" || ledger.Tracked[0].Scope["repo"] != "/repo" || len(ledger.Tracked[0].DependsOn) != 0 {
		t.Fatalf("projection = %#v", ledger.Tracked)
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
	if err != nil || len(engine.Queue) != 1 || len(engine.PRs) != 0 {
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
