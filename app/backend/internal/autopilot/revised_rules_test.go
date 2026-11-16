package autopilot

import (
	"context"
	"reflect"
	"testing"

	"rk/internal/operator"
)

func addLegacyPane(t *testing.T, h *harness, id string, deps []string, scope map[string]interface{}) {
	t.Helper()
	it, err := operator.NewPaneItem(id, deps, scope)
	if err != nil {
		t.Fatal(err)
	}
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error { st.Tracked = append(st.Tracked, it); return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestBareTrackedPaneNeverRespawns(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "bare", nil, map[string]interface{}{"repo": repo.Dir, "pane": "%5", "branch": "ordinary"})
	before := h.item("bare")
	before.Scope = projectionScope(before)
	for i := 0; i < 3; i++ {
		res := h.step()
		if len(res.Actions) != 0 {
			t.Fatalf("ordinary pane received queue actions: %+v", res)
		}
	}
	if h.spawn.n != 0 || !reflect.DeepEqual(before, h.item("bare")) {
		t.Fatal("bare pane was respawned, skipped, or otherwise changed")
	}
	status, err := Status(context.Background(), h.env)
	if err != nil || len(status.Items) != 0 {
		t.Fatalf("ordinary pane listed: %+v, %v", status, err)
	}
	res, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if err != nil || len(res.Actions) != 0 || h.run.called("gh pr view") != 0 {
		t.Fatalf("ordinary pane selected for merge: %+v %v", res, err)
	}
}

func TestLegacyMergeModeItemRemainsQueueWork(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "legacy", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": operator.MergeModeCherryPickLadder, "task": "work"})
	if !legacyQueueItem(h.state(), h.item("legacy")) {
		t.Fatal("legacy mode was ignored")
	}
	if res := h.step(); !hasAction(res, ActSpawned, "legacy") {
		t.Fatalf("legacy spawn=%+v", res)
	}
	if res := h.step(); !hasAction(res, ActRespawned, "legacy") {
		t.Fatalf("legacy respawn=%+v", res)
	}
	status, err := Status(context.Background(), h.env)
	if err != nil || len(status.Items) != 1 {
		t.Fatalf("legacy status=%+v %v", status, err)
	}
	h.shipped(1, "legacy")
	res := h.startMerge()
	if !hasAction(res, ActPRTracked, "legacy") {
		t.Fatalf("legacy merge=%+v", res)
	}
}

func TestEdgeOnlyDependencyChainIsNotQueueWork(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "base", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "aaaa"})
	addLegacyPane(t, h, "child", []string{"base"}, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "bbbb"})
	addLegacyPane(t, h, "isolated", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "cccc"})
	st := h.state()
	for _, it := range st.Tracked {
		if legacyQueueItem(st, it) {
			t.Fatalf("edge-only pane %s was absorbed as queue work", it.ID)
		}
	}
	status, err := Status(context.Background(), h.env)
	if err != nil || len(status.Items) != 0 {
		t.Fatalf("ordinary chain status=%+v %v", status, err)
	}
	if res := h.step(); len(res.Actions) != 0 {
		t.Fatalf("ordinary chain received queue actions: %+v", res.Actions)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || len(engine.Queue) != 0 {
		t.Fatalf("migration absorbed ordinary panes: %+v, %v", engine, err)
	}
}

func TestQueueMembershipDoesNotUseUnknownOrSelfEdges(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	for _, id := range []string{"unknown", "self"} {
		deps := []string{"missing"}
		if id == "self" {
			deps = []string{id}
		}
		addLegacyPane(t, h, id, deps, map[string]interface{}{"repo": repo.Dir})
	}
	for _, it := range h.state().Tracked {
		if legacyQueueItem(h.state(), it) {
			t.Fatalf("non-queue edge made %s eligible", it.ID)
		}
	}
}

func assertNoBranchMutations(t *testing.T, h *harness, res *StepResult) {
	t.Helper()
	for _, prefix := range []string{"git fetch", "git push", "git cherry-pick", "gh pr ready", "gh pr merge"} {
		if h.run.called(prefix) != 0 {
			t.Errorf("invalid branch reached %s", prefix)
		}
	}
	if h.spawn.n != 0 {
		t.Error("invalid branch created a worktree or pane")
	}
	if !hasEscalation(res, "branch") {
		t.Fatalf("missing branch escalation: %+v", res)
	}
}

func TestSpawnRejectsSharedDependencyBranchesBeforeFetch(t *testing.T) {
	for _, source := range []string{"scope", "branch-map"} {
		t.Run(source, func(t *testing.T) {
			h, repo := depFixture(t, "cherry-pick-ladder")
			e := newEngine(h.env)
			if source == "scope" {
				if err := e.patch("dep", func(it *operator.TrackedItem) { it.Scope["branch"] = "bad..branch" }); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := e.mutateEngine(func(st *engineState) error { st.remove("dep"); return nil }); err != nil {
					t.Fatal(err)
				}
				if err := removeProjection(h.env.StatePath, "dep"); err != nil {
					t.Fatal(err)
				}
				if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
					st.BranchMap["dep"] = operator.BranchMapEntry{Repo: repo.Dir, Branch: "--force"}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			h.run.reset()
			ds := h.decisions(e)
			if err := e.execute(context.Background(), e.facts, ds); err != nil {
				t.Fatal(err)
			}
			assertNoBranchMutations(t, h, e.res)
		})
	}
}

func TestMarkedQueueItemWithMissingRepoIsRejectedRatherThanHidden(t *testing.T) {
	h := newHarness(t)
	addLegacyPane(t, h, "queued", nil, map[string]interface{}{scopeQueue: "queue-1"})
	if !legacyQueueItem(h.state(), h.item("queued")) {
		t.Fatal("repo validation replaced queue membership")
	}
	if res := h.step(); !hasEscalation(res, "repo is empty") || h.spawn.n != 0 {
		t.Fatalf("invalid repo result=%+v", res)
	}
}

func TestOwnBranchMapAndRespawnBranchesAreValidatedBeforeMutation(t *testing.T) {
	for _, source := range []string{"branch-map", "respawn"} {
		t.Run(source, func(t *testing.T) {
			h := newHarness(t)
			repo := newRepo(t, "repo")
			h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
			e := newEngine(h.env)
			if source == "branch-map" {
				if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
					st.BranchMap["aaaa"] = operator.BranchMapEntry{Repo: repo.Dir, Branch: "--force"}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			} else if err := e.patch("a", func(it *operator.TrackedItem) {
				it.Scope["branch"] = "bad..branch"
				it.Scope["pane"] = "%dead"
			}); err != nil {
				t.Fatal(err)
			}
			h.run.reset()
			h.step() // repair the missing projection before the respawn row
			res := h.step()
			assertNoBranchMutations(t, h, res)
			if spawningSet(h.item("a")) || scopeBool(h.item("a"), scopeRespawned) || skipped(h.item("a")) {
				t.Fatal("malformed branch consumed spawn state")
			}
		})
	}
}

func TestEmptyBranchCannotSelectDetachedWorktree(t *testing.T) {
	h, _, head := armFixture(t)
	e := newEngine(h.env)
	repo := operator.ScopeString(head.Scope, "repo")
	h.run.reset()
	if _, err := e.worktreeForBranch(context.Background(), repo, ""); err == nil {
		t.Fatal("empty branch accepted")
	}
	if h.run.called("git worktree list") != 0 || h.spawn.n != 0 {
		t.Fatal("empty branch consulted or created worktrees")
	}
}
