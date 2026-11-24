package autopilot

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"rk/internal/operator"
)

func TestDerivedStatePrecedence(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("",
		Entry{ID: "a", Repo: foo.Dir, Task: "a"},
		Entry{ID: "b", Repo: foo.Dir, Task: "b"},
	)
	if got := h.stateOf(h.item("a")); got != QueuePending {
		t.Errorf("a = %s, want pending", got)
	}
	if got := h.stateOf(h.item("b")); got != QueueHeld {
		t.Errorf("b = %s, want held", got)
	}
	e := newEngine(h.env)
	if err := e.mutateEngine(func(st *engineState) error {
		st.Queue[0].Paused = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := h.stateOf(h.item("a")); got != QueuePaused {
		t.Errorf("a = %s, want paused", got)
	}
	// A pane does not lift the hold: a dependency still unsatisfied wins.
	h.attachBranch("b", "bb")
	if got := h.stateOf(h.item("b")); got != QueueHeld {
		t.Errorf("b = %s, want held (a spawned item with an unsatisfied dependency)", got)
	}
	h.attachBranch("a", "a-branch")
	h.gh.add(1, "a-branch")
	h.setDone("a")
	if got := h.stateOf(h.item("a")); got != QueueDone {
		t.Errorf("a = %s, want done (above paused)", got)
	}
	if got := h.stateOf(h.item("b")); got != QueueSpawned {
		t.Errorf("b = %s, want spawned once its dependency is done", got)
	}
}

func TestHeldItemWithADeadPaneIsNotRespawned(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.attachBranch("b", "bb")
	delete(h.panes.panes, "%900") // b's pane is gone, a is still unfinished
	h.step()
	for _, r := range h.spawn.reqs {
		if r.WorktreeName == "b" {
			t.Fatalf("a held item was respawned: %+v", r)
		}
	}
	if v, _ := h.item("b").Scope[scopeRespawned].(bool); v {
		t.Fatal("the respawn marker was written for a held item")
	}
}

func gateOf(t *testing.T, h *harness, id string) (bool, string) {
	t.Helper()
	e := newEngine(h.env)
	e.readOnly = true
	st, f, err := e.observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	q := f.queueFor(id)
	why := unmetDep(st, f, st.Tracked[operator.IndexOf(st.Tracked, id)],
		func(d operator.TrackedItem, branch string) bool { return branch != "" && q.depPR[d.ID] },
		func(d operator.TrackedItem, branch string) bool { return branch != "" && q.depMerged[d.ID] })
	return why == "", why
}

func TestGateSameRepoDependencyNeedsItsPR(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")

	if ok, why := gateOf(t, h, "b"); ok || !strings.Contains(why, "no PR yet") {
		t.Fatalf("done dependency without a PR: ok=%v why=%q, want held", ok, why)
	}
	h.gh.add(7, "a-branch")
	if ok, why := gateOf(t, h, "b"); !ok {
		t.Fatalf("dependency with a PR: held by %q", why)
	}
}

func TestGateDependencyNotDoneHolds(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.attachBranch("a", "a-branch")
	h.gh.add(7, "a-branch").Checks = []checkRun{{State: "PENDING"}}
	if ok, why := gateOf(t, h, "b"); ok || why != "a" {
		t.Fatalf("ok=%v why=%q, want held by a", ok, why)
	}
}

func TestGateStopStageDependencyNeedsNoPR(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a", StopStage: ptr("hydrate")}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	if ok, why := gateOf(t, h, "b"); !ok {
		t.Fatalf("held by %q: a dependency that stops before ship has no PR to wait for", why)
	}
}

func TestGateCrossRepoDependencyIsOrderingOnly(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: bar.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	// No PR exists for a-branch, and none is needed: nothing moves across repos.
	if ok, why := gateOf(t, h, "b"); !ok {
		t.Fatalf("cross-repo dependency held by %q", why)
	}
}

func TestGateDependencyOnlyInBranchMapPasses(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	one := []string{"gone"}
	h.queue("", Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.BranchMap["gone"] = operator.BranchMapEntry{Branch: "gone-branch", Repo: foo.Dir}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e := newEngine(h.env)
	if err := e.patch("b", func(it *operator.TrackedItem) { it.DependsOn = one }); err != nil {
		t.Fatal(err)
	}
	if ok, why := gateOf(t, h, "b"); !ok {
		t.Fatalf("a dep removed on its own done and kept in branch_map is held by %q", why)
	}
	if err := e.patch("b", func(it *operator.TrackedItem) { it.DependsOn = []string{"unknown"} }); err != nil {
		t.Fatal(err)
	}
	if ok, why := gateOf(t, h, "b"); ok || why != "unknown" {
		t.Fatalf("an unknown dep id: ok=%v why=%q, want unsatisfied", ok, why)
	}
}

// mergeAutoPair queues merge-auto a→b in one repo, with a done and its branch
// recorded.
func mergeAutoPair(t *testing.T) (*harness, *testRepo) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	return h, foo
}

func spawnedNames(h *harness) []string {
	var names []string
	for _, r := range h.spawn.reqs {
		names = append(names, r.WorktreeName)
	}
	return names
}

func TestMergeAutoSuccessorWaitsForThePredecessorsMergedPR(t *testing.T) {
	h, _ := mergeAutoPair(t)
	h.attachBranch("a", "a-branch")
	pr := h.gh.add(1, "a-branch")

	res := h.step()
	if got := h.stateOf(h.item("b")); got != QueueHeld || len(spawnedNames(h)) != 0 || len(res.Escalations) != 0 {
		t.Fatalf("dependency done with its PR open: b = %s, spawned %v, %+v", got, spawnedNames(h), res)
	}
	if h.run.called("gh pr view a-branch --json url,state") == 0 {
		t.Fatal("the barrier did not read the dependency's PR state")
	}
	if ok, why := gateOf(t, h, "b"); ok || !strings.Contains(why, "PR not merged") {
		t.Fatalf("gate ok=%v why=%q, want held on the unmerged PR", ok, why)
	}

	pr.State = "MERGED"
	res = h.step()
	if !hasAction(res, ActSpawned, "b") || strings.Join(spawnedNames(h), ",") != "b" {
		t.Fatalf("dependency PR merged: %+v, spawned %v", res, spawnedNames(h))
	}
}

func TestMergeAutoBarrierWithNoPRIsAPlainHeldState(t *testing.T) {
	h, _ := mergeAutoPair(t)
	h.attachBranch("a", "a-branch")
	for i := 0; i < 2; i++ {
		res := h.step()
		if len(res.Escalations) != 0 || len(spawnedNames(h)) != 0 || h.stateOf(h.item("b")) != QueueHeld {
			t.Fatalf("pass %d: no PR yet must hold quietly: %+v", i, res)
		}
	}
}

func TestMergeAutoBarrierReadFailureEscalatesOncePerReasonAndHolds(t *testing.T) {
	h, _ := mergeAutoPair(t)
	h.attachBranch("a", "a-branch")
	h.run.fail("gh pr view a-branch", "API unavailable")
	for i := 0; i < 2; i++ {
		res := h.step()
		assertEscalationNote(t, h, res, "b", "dependency a PR lookup failed: API unavailable")
		if len(spawnedNames(h)) != 0 {
			t.Fatal("a failed barrier read spawned the successor")
		}
	}
}

func TestMergeAutoBarrierWithoutABranchEscalatesAndHolds(t *testing.T) {
	h, _ := mergeAutoPair(t)
	for i := 0; i < 2; i++ {
		res := h.step()
		assertEscalationNote(t, h, res, "b", "dependency a has no branch recorded")
		if len(spawnedNames(h)) != 0 {
			t.Fatal("a barrier without a branch spawned the successor")
		}
	}
}

func TestMergeAutoBarrierIsSilentAndWritesNothingInStatus(t *testing.T) {
	h, _ := mergeAutoPair(t)
	h.attachBranch("a", "a-branch")
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != QueueHeld {
		t.Fatalf("a PR that does not exist yet is a held item, not a failure: %+v, %v", res.Items, err)
	}
	h.gh.add(1, "a-branch")
	res, err = Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != QueueHeld {
		t.Fatalf("an open PR holds the successor: %+v, %v", res.Items, err)
	}
	h.gh.prs[1].State = "MERGED"
	res, err = Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != QueuePending {
		t.Fatalf("a merged PR releases the successor: %+v, %v", res.Items, err)
	}
	h.run.fail("gh pr view a-branch", "API unavailable")
	res, err = Status(context.Background(), h.env)
	if err == nil || !strings.Contains(err.Error(), "API unavailable") || res.Items[1].State != QueueHeld {
		t.Fatalf("a failed read is plain error text, and holds: %+v, %v", res.Items, err)
	}
	after, _ := os.ReadFile(h.env.StatePath)
	if string(before) != string(after) || len(h.item("b").Notes) != 0 {
		t.Fatal("status wrote the state or a note")
	}
}

// The barrier is merge-auto's: a ladder or stacked dependent waits only for the
// PR to exist, never for its merge.
func TestOtherModesDoNotWaitForTheMerge(t *testing.T) {
	for _, mode := range []string{operator.MergeModeCherryPickLadder, operator.MergeModeStackedPRs} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			h.queue(mode, Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
			h.setDone("a")
			h.attachBranch("a", "a-branch")
			h.gh.add(1, "a-branch")
			if ok, why := gateOf(t, h, "b"); !ok {
				t.Fatalf("an open dependency PR held a %s item: %q", mode, why)
			}
		})
	}
}

func TestObserveDonePlainAgent(t *testing.T) {
	cases := []struct {
		name   string
		pr     func(*simPR)
		isDone bool
	}{
		{"open PR with green checks", func(p *simPR) { p.Checks = []checkRun{{State: "SUCCESS"}} }, true},
		{"no required checks", func(p *simPR) {}, true},
		{"failing checks", func(p *simPR) { p.Checks = []checkRun{{State: "FAILURE"}} }, false},
		{"pending checks", func(p *simPR) { p.Checks = []checkRun{{State: "PENDING"}} }, false},
		{"merged", func(p *simPR) { p.State = "MERGED"; p.Checks = []checkRun{{State: "FAILURE"}} }, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
			h.attachBranch("a", "a-branch")
			c.pr(h.gh.add(3, "a-branch"))
			h.step()
			if got := operator.ItemDone(h.item("a")); got != c.isDone {
				t.Fatalf("done = %v, want %v", got, c.isDone)
			}
		})
	}
}

func TestObserveDoneFabItemFromPaneSnapshot(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "a"})
	h.attachBranch("a", "a-branch")
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "260101-a-x", Stage: "hydrate", DisplayState: "done"}
	h.step()
	if operator.ItemDone(h.item("a")) {
		t.Fatal("hydrate done is mid-pipeline for a change with no stop_stage")
	}
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "260101-a-x", Stage: "ship", DisplayState: "done"}
	h.step()
	if !operator.ItemDone(h.item("a")) {
		t.Fatal("ship done must persist done_at")
	}
}

func TestPlainAgentCompletionIgnoresOptionalChecks(t *testing.T) {
	for _, required := range []string{"SUCCESS", "FAILURE", "PENDING", "none", "unavailable"} {
		t.Run(required, func(t *testing.T) {
			h := newHarness(t)
			repo := newRepo(t, "repo")
			h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
			h.attachBranch("a", "a-branch")
			h.run.reply("gh pr view a-branch", `{"url":"https://example.test/pull/3","state":"OPEN","statusCheckRollup":[{"state":"FAILURE"},{"state":"PENDING"}]}`)
			switch required {
			case "none":
				h.run.fail("gh pr checks a-branch --required", "no required checks reported")
			case "unavailable":
				h.run.fail("gh pr checks a-branch --required", "HTTP 502")
			default:
				h.run.reply("gh pr checks a-branch --required", `[{"name":"ci","state":"`+required+`"}]`)
			}
			h.step()
			want := required == "SUCCESS" || required == "none"
			if operator.ItemDone(h.item("a")) != want || h.run.called("gh pr checks a-branch --required") != 1 {
				t.Fatalf("done = %v; want %v", operator.ItemDone(h.item("a")), want)
			}
		})
	}
}

// Status applies the live gate's rule, so it never calls pending an item that
// step would hold.
func TestStatusHoldsAnItemWhoseSameRepoDependencyHasNoPR(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}

	res, err := Status(context.Background(), h.env)
	if err != nil {
		t.Fatalf("a missing PR is a held item, not a failure: %v", err)
	}
	if got := res.Items[1]; got.ID != "b" || got.State != QueueHeld {
		t.Fatalf("b = %+v, want held while a has no PR", got)
	}

	h.gh.add(1, "a-branch")
	res, err = Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != QueuePending {
		t.Fatalf("with a's PR, b = %+v err %v", res.Items[1], err)
	}
	after, _ := os.ReadFile(h.env.StatePath)
	if string(before) != string(after) {
		t.Fatal("status wrote the state file")
	}
	if ok, _ := gateOf(t, h, "b"); !ok {
		t.Fatal("live gate and status disagree")
	}
}

func TestStatusReportsNoEscalationsAndWritesNoNotes(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	h.run.fail("gh pr view", "gh unavailable")
	res, err := Status(context.Background(), h.env)
	if err == nil || !strings.Contains(err.Error(), "gh unavailable") {
		t.Fatalf("a failed lookup must be returned as error text: %v", err)
	}
	if res.Items[1].State != QueueHeld {
		t.Fatalf("b = %+v", res.Items[1])
	}
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), "escalation") {
		t.Fatalf("status result carries escalations: %s", raw)
	}
	for _, id := range []string{"a", "b"} {
		if n := len(h.item(id).Notes); n != 0 {
			t.Fatalf("status wrote %d notes on %s", n, id)
		}
	}
}

func TestPlainTaskInAFabRepoIsAPlainAgent(t *testing.T) {
	h := newHarness(t)
	fabRepo := newRepo(t, "fabbed")
	commitFile(t, fabRepo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	h.queue("merge-auto",
		Entry{ID: "plain", Repo: fabRepo.Dir, Task: "bump deps", Plain: true},
		Entry{ID: "piped", Repo: fabRepo.Dir, Task: "build it"},
	)
	st := h.state()
	if got, err := isPlainAgent(st, h.item("plain")); err != nil || !got {
		t.Fatalf("a plain task item in a fab repo: isPlainAgent = %v, %v", got, err)
	}
	if got, err := isPlainAgent(st, h.item("piped")); err != nil || got {
		t.Fatalf("a non-plain task item in a fab repo: isPlainAgent = %v, %v", got, err)
	}
}

func TestObserveDonePlainAgentInAFabRepo(t *testing.T) {
	cases := []struct {
		name   string
		pr     func(*simPR)
		isDone bool
	}{
		{"merged", func(p *simPR) { p.State = "MERGED" }, true},
		{"open PR with required checks passing", func(p *simPR) { p.Checks = []checkRun{{State: "SUCCESS"}} }, true},
		{"open PR with required checks pending", func(p *simPR) { p.Checks = []checkRun{{State: "PENDING"}} }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
			h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "bump deps", Plain: true})
			h.attachBranch("a", "a-branch")
			c.pr(h.gh.add(3, "a-branch"))
			h.step()
			if got := operator.ItemDone(h.item("a")); got != c.isDone {
				t.Fatalf("done = %v, want %v", got, c.isDone)
			}
		})
	}
}

func TestNonPlainTaskInAFabRepoIsNotDoneByItsPR(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "build it"})
	h.attachBranch("a", "a-branch")
	h.gh.add(3, "a-branch").State = "MERGED"
	h.step()
	if operator.ItemDone(h.item("a")) {
		t.Fatal("a pipeline item's completion is its change reaching the terminus, not its PR")
	}
}
