package autopilot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rk/internal/operator"
)

func TestOverlappingStepsClaimOnlyOneSpawn(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	h.spawn.during = func() {
		if claimToken(h.item("a")) == "" {
			t.Fatal("spawn has no durable claim")
		}
		res := h.step()
		if hasAction(res, ActSpawned, "") {
			t.Fatal("overlapping step spawned claimed item")
		}
	}
	res := h.step()
	if h.spawn.n != 1 || !hasAction(res, ActSpawned, "a") || claimToken(h.item("a")) != "" {
		t.Fatalf("result = %+v, spawns = %d", res, h.spawn.n)
	}
}

func TestFailedAttachAdoptsRecordedPane(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	h.spawn.afterOpened = func(res SpawnResult) {
		if operator.ScopeString(claimOf(h.item("a")), "pane") != res.PaneID {
			t.Fatal("pane not recorded before attach")
		}
		h.panes.panes[res.PaneID] = operator.PaneInfo{PaneID: res.PaneID}
		readOnlyState(t, h)
	}
	res := h.step()
	if hasAction(res, ActSpawned, "a") || !hasEscalation(res, "attaching the pane failed") {
		t.Fatalf("result = %+v", res)
	}
	if err := os.Chmod(filepath.Dir(h.env.StatePath), 0700); err != nil {
		t.Fatal(err)
	}
	h.spawn.afterOpened = nil
	res = h.step()
	if h.spawn.n != 1 || !hasAction(res, ActSpawned, "a") || operator.ScopeString(h.item("a").Scope, "pane") != "%101" {
		t.Fatalf("result = %+v, spawns = %d", res, h.spawn.n)
	}
}

func TestExternalPaneWinsSpawnAttach(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	h.spawn.during = func() { h.attachBranch("a", "external") }
	res := h.step()
	if hasAction(res, ActSpawned, "a") || !hasEscalation(res, "orphan pane") {
		t.Fatalf("result = %+v", res)
	}
	it := h.item("a")
	if operator.ScopeString(it.Scope, "pane") != "%900" || h.state().BranchMap["a"].Branch != "external" {
		t.Fatal("external attachment was overwritten")
	}
	if operator.ScopeString(claimOf(it), "pane") != "%101" {
		t.Fatal("orphan evidence was lost")
	}
}

func TestStaleClaimReleasedWithoutSpawningInSamePass(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	if _, ok, err := newEngine(h.env).claimSpawn("a", h.state()); err != nil || !ok {
		t.Fatalf("claim = %v, %v", ok, err)
	}
	h.clock = h.clock.Add(16 * time.Minute)
	res := h.step()
	if h.spawn.n != 0 || claimToken(h.item("a")) != "" || !hasEscalation(res, "released spawn claim") {
		t.Fatalf("result = %+v", res)
	}
}

func TestClaimCASRejectsChangedOrOwnedItem(t *testing.T) {
	for _, state := range []string{"paused", "pane", "claim"} {
		t.Run(state, func(t *testing.T) {
			h := newHarness(t)
			repo := newRepo(t, "repo")
			h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
			e := newEngine(h.env)
			if err := e.patch("a", func(it *operator.TrackedItem) {
				switch state {
				case "paused":
					it.Paused = true
				case "pane":
					it.Scope["pane"] = "%9"
				case "claim":
					it.Scope[scopeClaim] = map[string]interface{}{"token": "other"}
				}
			}); err != nil {
				t.Fatal(err)
			}
			if _, ok, err := e.claimSpawn("a", h.state()); err != nil || ok {
				t.Fatalf("claim = %v, %v", ok, err)
			}
		})
	}
}

func TestAttachRejectsChangedClaim(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	e := newEngine(h.env)
	it, _, err := e.claimSpawn("a", h.state())
	if err != nil {
		t.Fatal(err)
	}
	if err := e.setScope("a", map[string]interface{}{scopeClaim: map[string]interface{}{"token": "other"}}); err != nil {
		t.Fatal(err)
	}
	if err := e.attach(context.Background(), it, repo.Dir, SpawnResult{PaneID: "%9"}, "work"); err == nil {
		t.Fatal("attach accepted another owner's claim")
	}
}

func TestStaleReleaseCannotEraseNewlyRecordedPane(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	e := newEngine(h.env)
	it, _, err := e.claimSpawn("a", h.state())
	if err != nil {
		t.Fatal(err)
	}
	if err := e.recordClaimPane(it, SpawnResult{PaneID: "%9", Branch: "actual"}, "work"); err != nil {
		t.Fatal(err)
	}
	if err := e.releaseClaim(it); err != nil {
		t.Fatal(err)
	}
	if operator.ScopeString(claimOf(h.item("a")), "pane") != "%9" {
		t.Fatal("stale observation erased the recorded pane")
	}
}

func TestAdoptResolvesBranchWhenOnlyPaneWasRecorded(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	e := newEngine(h.env)
	it, _, err := e.claimSpawn("a", h.state())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "worktree")
	runGit(t, repo.Dir, "worktree", "add", "-b", "actual-branch", path, "main")
	if err := e.recordClaimPane(it, SpawnResult{PaneID: "%9", WorktreePath: path}, "work"); err != nil {
		t.Fatal(err)
	}
	h.panes.panes["%9"] = operator.PaneInfo{PaneID: "%9"}
	e.reconcileClaim(context.Background(), h.item("a"))
	if !hasAction(e.res, ActSpawned, "a") || h.state().BranchMap["a"].Branch != "actual-branch" {
		t.Fatalf("result = %+v", e.res)
	}
}

func TestConcurrentClaimCASHasOneWinner(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	type result struct {
		ok  bool
		err error
	}
	results := make(chan result, 8)
	start := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() { <-start; _, ok, err := newEngine(h.env).claimSpawn("a", h.state()); results <- result{ok, err} }()
	}
	close(start)
	winners := 0
	for i := 0; i < 8; i++ {
		res := <-results
		if res.err != nil {
			t.Fatal(res.err)
		}
		if res.ok {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("claim winners = %d", winners)
	}
}

func TestDependencyUpdateBetweenGateAndClaimDefersSpawn(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	none := []string{}
	deps := []string{"a"}
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"}, Entry{ID: "c", Repo: repo.Dir, Change: "cccc", DependsOn: &none}, Entry{ID: "b", Repo: repo.Dir, Change: "bbbb", DependsOn: &deps})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	e := newEngine(h.env)
	if err := e.patch("c", func(it *operator.TrackedItem) { it.Paused = true }); err != nil {
		t.Fatal(err)
	}
	h.run.on("gh pr view a-branch", func(_ string, _ []string) (string, error) {
		// A real locked write during the gate also proves no subprocess holds the lock.
		err := e.patch("b", func(it *operator.TrackedItem) { it.DependsOn = []string{"c"} })
		return `{"url":"https://example.test/pull/1"}`, err
	})
	if err := e.spawnPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.spawn.n != 0 || h.run.called("git fetch") != 0 || claimToken(h.item("b")) != "" {
		t.Fatalf("spawned from stale readiness: %+v", e.res)
	}
	if got := h.item("b").DependsOn; len(got) != 1 || got[0] != "c" {
		t.Fatalf("external dependencies lost: %v", got)
	}
	if err := e.spawnPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.spawn.n != 0 {
		t.Fatal("dependent did not wait for its new dependency")
	}
}

func TestSpawnClaimRejectsChangedDependencyEvidence(t *testing.T) {
	for _, change := range []string{"completion", "branch-map", "branch", "merge-auto-barrier"} {
		t.Run(change, func(t *testing.T) {
			h := newHarness(t)
			repo := newRepo(t, "repo")
			h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: repo.Dir, Change: "bbbb"})
			h.setDone("a")
			h.attachBranch("a", "a-branch")
			ready := h.state()
			if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
				switch change {
				case "completion":
					st.Tracked[0].DoneAt = nil
				case "branch-map":
					st.BranchMap["aaaa"] = operator.BranchMapEntry{Repo: repo.Dir, Branch: "new-branch"}
				case "branch":
					st.Tracked[0].Scope["branch"] = "new-branch"
				case "merge-auto-barrier":
					st.Tracked[0].Scope["merge_mode"] = operator.MergeModeMergeAuto
					st.Tracked[1].Scope["merge_mode"] = operator.MergeModeMergeAuto
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if _, ok, err := newEngine(h.env).claimSpawn("b", ready); err != nil || ok {
				t.Fatalf("stale claim accepted: ok=%v err=%v", ok, err)
			}
		})
	}
}
