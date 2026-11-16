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
	if got := h.stateOf(h.item("a")); got != StatePending {
		t.Errorf("a = %s, want pending", got)
	}
	if got := h.stateOf(h.item("b")); got != StateHeld {
		t.Errorf("b = %s, want held", got)
	}
	if err := operator.Pause(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	if got := h.stateOf(h.item("a")); got != StatePaused {
		t.Errorf("a = %s, want paused", got)
	}
	// A pane does not lift the hold: a dependency still unsatisfied wins.
	h.attachBranch("b", "bb")
	if got := h.stateOf(h.item("b")); got != StateHeld {
		t.Errorf("b = %s, want held (a spawned item with an unsatisfied dependency)", got)
	}
	h.attachBranch("a", "a-branch")
	h.gh.add(1, "a-branch")
	h.setDone("a")
	if got := h.stateOf(h.item("a")); got != StateDone {
		t.Errorf("a = %s, want done (above paused)", got)
	}
	if got := h.stateOf(h.item("b")); got != StateSpawned {
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
			e := newEngine(h.env)
			if err := e.observeDone(context.Background()); err != nil {
				t.Fatal(err)
			}
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
	if got := res.Items[1]; got.ID != "b" || got.State != StateHeld {
		t.Fatalf("b = %+v, want held while a has no PR", got)
	}

	h.gh.add(1, "a-branch")
	res, err = Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != StatePending {
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
	if res.Items[1].State != StateHeld {
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
