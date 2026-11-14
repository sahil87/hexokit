package autopilot

import (
	"context"
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
	st := h.state()
	if got := derivedState(st, h.item("a")); got != StatePending {
		t.Errorf("a = %s, want pending", got)
	}
	if got := derivedState(st, h.item("b")); got != StateHeld {
		t.Errorf("b = %s, want held", got)
	}
	if err := operator.Pause(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	if got := derivedState(h.state(), h.item("a")); got != StatePaused {
		t.Errorf("a = %s, want paused", got)
	}
	h.attachBranch("b", "bb")
	if got := derivedState(h.state(), h.item("b")); got != StateSpawned {
		t.Errorf("b = %s, want spawned", got)
	}
	h.setDone("a")
	if got := derivedState(h.state(), h.item("a")); got != StateDone {
		t.Errorf("a = %s, want done (above paused)", got)
	}
}

func gateOf(t *testing.T, h *harness, id string) (bool, string) {
	t.Helper()
	e := newEngine(h.env)
	st := h.state()
	return e.gate(context.Background(), st, h.item(id))
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
	h.gh.add(7, "a-branch")
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
		st.Tracked[0].DependsOn = one
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if ok, why := gateOf(t, h, "b"); !ok {
		t.Fatalf("a dep removed on its own done and kept in branch_map is held by %q", why)
	}
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[0].DependsOn = []string{"unknown"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if ok, why := gateOf(t, h, "b"); ok || why != "unknown" {
		t.Fatalf("an unknown dep id: ok=%v why=%q, want unsatisfied", ok, why)
	}
}

func TestMergeAutoDependencyWaitsForVerifiedMerge(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	if ok, _ := gateOf(t, h, "b"); ok {
		t.Fatal("merge-auto: the dependency shipped but its PR is not merged yet")
	}
}

func TestObserveDonePlainAgent(t *testing.T) {
	cases := []struct {
		name   string
		pr     func(*simPR)
		isDone bool
	}{
		{"draft PR with green checks", func(p *simPR) { p.IsDraft = true; p.Checks = []checkRun{{Name: "ci", State: "SUCCESS"}} }, true},
		{"no required checks", func(p *simPR) {}, true},
		{"failing checks", func(p *simPR) { p.Checks = []checkRun{{Name: "ci", State: "FAILURE"}} }, false},
		{"pending checks", func(p *simPR) { p.Checks = []checkRun{{Name: "ci", State: "PENDING"}} }, false},
		{"merged", func(p *simPR) { p.State = "MERGED"; p.Checks = []checkRun{{Name: "ci", State: "FAILURE"}} }, true},
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
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[0].Scope["pane"] = "%5"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	h.panes.panes["%5"] = operator.PaneInfo{PaneID: "%5", Change: "260101-a-x", Stage: "hydrate", DisplayState: "done"}
	h.step()
	if operator.ItemDone(h.item("a")) {
		t.Fatal("hydrate done is mid-pipeline for a change with no stop_stage")
	}
	h.panes.panes["%5"] = operator.PaneInfo{PaneID: "%5", Change: "260101-a-x", Stage: "ship", DisplayState: "done"}
	h.step()
	if !operator.ItemDone(h.item("a")) {
		t.Fatal("ship done must persist done_at")
	}
}
