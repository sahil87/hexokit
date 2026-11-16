package autopilot

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

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
	if !isQueueItem(h.state(), h.item("legacy")) {
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
	if !isQueueItem(st, h.item("base")) || !isQueueItem(st, h.item("child")) || isQueueItem(st, h.item("isolated")) {
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

func TestQueueMembershipDoesNotUseUnknownSelfOrRecoveryEdges(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	addLegacyPane(t, h, "fix", nil, map[string]interface{}{"repo": repo.Dir, "merge_mode": "cherry-pick-ladder", scopeQueue: "q", scopeFixFor: "pr-1"})
	for _, id := range []string{"unknown", "self", "fix-edge"} {
		deps := []string{"missing"}
		if id == "self" {
			deps = []string{id}
		}
		if id == "fix-edge" {
			deps = []string{"fix"}
		}
		addLegacyPane(t, h, id, deps, map[string]interface{}{"repo": repo.Dir})
	}
	for _, it := range h.state().Tracked {
		if isQueueItem(h.state(), it) {
			t.Fatalf("non-queue edge made %s eligible", it.ID)
		}
	}
}

func assertFixOpen(t *testing.T, h *harness, fixHead string) {
	t.Helper()
	head := h.item("pr-1")
	if !h.has("ab12-fix") || operator.ScopeString(head.Scope, scopeFixItem) != "ab12-fix" || operator.ScopeString(head.Scope, scopeFixHead) != fixHead || scopeBool(head, scopeHalted) {
		t.Fatalf("active fix lost: %+v", head)
	}
}

func TestFixRoundFailedPendingGreen(t *testing.T) {
	for _, mode := range []string{"armed", "direct", "already-merged"} {
		t.Run(mode, func(t *testing.T) {
			h, pr := recoveryFixture(t)
			h.step()
			oldHead := pr.HeadOid
			if mode == "direct" {
				if err := newEngine(h.env).setScope("pr-1", map[string]interface{}{scopeDirect: true}); err != nil {
					t.Fatal(err)
				}
			}
			// Green on the original head is not evidence that the requested fix landed.
			pr.Checks = []checkRun{{Name: "CI", State: "SUCCESS"}}
			h.step()
			assertFixOpen(t, h, oldHead)
			pr.HeadOid = "new-fix-head"
			pr.Checks = []checkRun{{Name: "CI", State: "PENDING"}}
			if mode == "already-merged" {
				pr.State = "MERGED"
			}
			h.step()
			assertFixOpen(t, h, oldHead)
			if h.spawn.n != 1 {
				t.Fatal("pending fix spawned another worker")
			}
			pr.Checks = []checkRun{{Name: "CI", State: "SUCCESS"}}
			h.step()
			if h.has("ab12-fix") || operator.ScopeString(h.item("pr-1").Scope, scopeFixItem) != "" {
				t.Fatal("green new head did not resolve fix")
			}
		})
	}
}

func TestFixRoundFailedPendingRedOnNewHead(t *testing.T) {
	for _, direct := range []bool{false, true} {
		h, pr := recoveryFixture(t)
		h.step()
		oldHead := pr.HeadOid
		if direct {
			if err := newEngine(h.env).setScope("pr-1", map[string]interface{}{scopeDirect: true}); err != nil {
				t.Fatal(err)
			}
		}
		pr.HeadOid = "new-fix-head"
		pr.Checks = []checkRun{{Name: "CI", State: "PENDING"}}
		h.step()
		assertFixOpen(t, h, oldHead)
		pr.Checks = []checkRun{{Name: "CI", State: "FAILURE"}}
		res := h.step()
		if !scopeBool(h.item("pr-1"), scopeHalted) || pr.Armed || !hasEscalation(res, "after the fix round") {
			t.Fatalf("new red head did not halt: %+v", res)
		}
		if h.has("ab12-fix") || operator.ScopeString(h.item("pr-1").Scope, scopeFixItem) != "" {
			t.Fatal("terminal halt did not close fix tracking")
		}
	}
}

func TestFixRoundNoPushBoundIncludesPendingChecks(t *testing.T) {
	h, pr := recoveryFixture(t)
	h.step()
	pr.Checks = []checkRun{{Name: "CI", State: "PENDING"}}
	h.clock = h.clock.Add(recoveryWindow + time.Minute)
	res := h.step()
	if !scopeBool(h.item("pr-1"), scopeHalted) || !hasEscalation(res, "no new push") || h.has("ab12-fix") {
		t.Fatalf("no-push bound=%+v", res)
	}
}

func assertNoBranchMutations(t *testing.T, h *harness, res *StepResult) {
	t.Helper()
	for _, prefix := range []string{"git fetch", "git rebase", "git push", "git cherry-pick", "gh pr edit", "gh pr ready", "gh pr merge"} {
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

func TestStackedRejectsMalformedCurrentAndPredecessorBranches(t *testing.T) {
	for _, target := range []string{"current", "predecessor"} {
		for _, value := range []interface{}{"", "--force", "bad..branch", 42} {
			t.Run(target+"-"+strings.ReplaceAll(strings.TrimSpace(fmt.Sprint(value)), "/", "_"), func(t *testing.T) {
				h := newHarness(t)
				repo := newRepo(t, "repo")
				h.queue("stacked-prs", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: repo.Dir, Change: "bbbb"})
				h.shipped(1, "a", "b")
				e := newEngine(h.env)
				items, err := e.buildPRChains(context.Background(), h.state(), h.state().Tracked, map[string]bool{"a": true, "b": true})
				if err != nil {
					t.Fatal(err)
				}
				if err := e.addPRItems(items); err != nil {
					t.Fatal(err)
				}
				id := "pr-2"
				if target == "predecessor" {
					id = "pr-1"
				}
				if err := e.patch(id, func(it *operator.TrackedItem) { it.Scope["branch"] = value }); err != nil {
					t.Fatal(err)
				}
				h.run.reset()
				e.prepareStacked(context.Background(), h.state(), h.item("pr-1"), h.item("pr-2"), prView{BaseRefName: "other"})
				assertNoBranchMutations(t, h, e.res)
				if claimToken(h.item("pr-2")) != "" || scopeBool(h.item("pr-2"), scopePrepared) {
					t.Fatal("invalid branch consumed preparation")
				}
			})
		}
	}
}

func TestConflictingRejectsMalformedSharedBranch(t *testing.T) {
	for _, branch := range []string{"", "--force", "bad..branch"} {
		t.Run(branch, func(t *testing.T) {
			h, _, head := armFixture(t)
			e := newEngine(h.env)
			if err := e.patch(head.ID, func(it *operator.TrackedItem) { it.Scope["branch"] = branch }); err != nil {
				t.Fatal(err)
			}
			h.run.reset()
			e.conflicting(context.Background(), h.state(), h.item(head.ID), prView{})
			assertNoBranchMutations(t, h, e.res)
			if claimToken(h.item(head.ID)) != "" || operator.ScopeString(h.item(head.ID).Scope, scopeRecovery) != "" {
				t.Fatal("invalid branch consumed recovery")
			}
		})
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
	if !isQueueItem(h.state(), h.item("queued")) {
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
			if claimToken(h.item("a")) != "" || scopeBool(h.item("a"), scopeRespawned) || skipped(h.item("a")) {
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
	if _, _, err := e.worktreeFor(context.Background(), head, repo, ""); err == nil {
		t.Fatal("empty branch accepted")
	}
	if h.run.called("git worktree list") != 0 || h.spawn.n != 0 {
		t.Fatal("empty branch consulted or created worktrees")
	}
}
