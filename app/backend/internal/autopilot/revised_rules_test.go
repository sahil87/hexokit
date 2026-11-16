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
	h.setDone("bare")
	res, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if err != nil || len(res.Actions) != 0 || h.run.called("gh pr view") != 0 {
		t.Fatalf("ordinary pane selected for merge: %+v %v", res, err)
	}
}

func TestLegacyMergeModeItemRemainsQueueWork(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "legacy", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": operator.MergeModeCherryPickLadder, "task": "work"})
	if !operator.IsQueueItem(h.state(), h.item("legacy")) {
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

func TestLegacyDependencyChainRemainsQueueWork(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "base", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "aaaa"})
	addLegacyPane(t, h, "child", []string{"base"}, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "bbbb"})
	addLegacyPane(t, h, "isolated", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": nil, "change": "cccc"})
	st := h.state()
	if !operator.IsQueueItem(st, h.item("base")) || !operator.IsQueueItem(st, h.item("child")) || operator.IsQueueItem(st, h.item("isolated")) {
		t.Fatal("legacy dependency membership is wrong")
	}
	status, err := Status(context.Background(), h.env)
	if err != nil || len(status.Items) != 2 {
		t.Fatalf("legacy chain status=%+v %v", status, err)
	}
	if res := h.step(); !hasAction(res, ActSpawned, "base") || hasAction(res, ActSpawned, "isolated") {
		t.Fatalf("legacy chain spawn=%+v", res)
	}
	h.shipped(1, "base", "child")
	if res := h.startMerge(); !hasAction(res, ActPRTracked, "base") || !hasAction(res, ActPRTracked, "child") {
		t.Fatalf("legacy chain merge=%+v", res)
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
		if operator.IsQueueItem(h.state(), it) {
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
			if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
				if source == "scope" {
					st.Tracked[0].Scope["branch"] = "bad..branch"
				} else {
					st.Tracked = st.Tracked[1:]
					st.BranchMap["dep"] = operator.BranchMapEntry{Repo: repo.Dir, Branch: "--force"}
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			h.run.reset()
			if err := e.spawnPending(context.Background()); err != nil {
				t.Fatal(err)
			}
			assertNoBranchMutations(t, h, e.res)
		})
	}
}

func TestMarkedQueueItemWithMissingRepoIsRejectedRatherThanHidden(t *testing.T) {
	h := newHarness(t)
	addLegacyPane(t, h, "queued", nil, map[string]interface{}{scopeQueue: "queue-1"})
	if !operator.IsQueueItem(h.state(), h.item("queued")) {
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
			if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
				if source == "branch-map" {
					st.BranchMap["aaaa"] = operator.BranchMapEntry{Repo: repo.Dir, Branch: "--force"}
				} else {
					st.Tracked[0].Scope["branch"] = "bad..branch"
					st.Tracked[0].Scope["pane"] = "%dead"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			h.run.reset()
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
