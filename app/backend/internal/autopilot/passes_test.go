package autopilot

import (
	"os"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

// A stage that has not moved for a long time and a queue that has been open for
// hours are not engine business: the check's aged conditions cover a stuck
// agent, so the pass decides nothing for such an item.
func TestALongRunningQueueNeverEscalatesFromThePass(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.attachBranch("a", "a-branch")
	h.gh.add(1, "a-branch").Checks = []checkRun{{State: "PENDING"}}
	h.clock = h.clock.Add(3 * time.Hour)
	for i := 0; i < 2; i++ {
		res := h.step()
		if len(res.Actions) != 0 || len(res.Escalations) != 0 {
			t.Fatalf("pass %d acted on an aged, working queue: %+v", i, res)
		}
	}
	if got := h.stateOf(h.item("a")); got != QueueSpawned {
		t.Fatalf("a = %s, want spawned", got)
	}
}

// A respawn that crashed between its marker and its attach leaves the old pane
// id and `spawning`: it is escalated for a person, never skipped as a second
// death and never launched over a window that may exist.
func TestCrashedRespawnIsEscalatedNotSkippedOrRelaunched(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.attachBranch("a", "a-branch")
	delete(h.panes.panes, "%900")
	if err := h.envPatch("a", map[string]interface{}{scopeRespawned: true, scopeSpawning: "2026-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	res := h.step()
	if !hasEscalation(res, "spawn interrupted: a") || skipped(h.item("a")) || h.spawn.n != 0 || h.run.called("git fetch") != 0 {
		t.Fatalf("res = %+v skipped=%v launches=%d", res, skipped(h.item("a")), h.spawn.n)
	}
}

// Rows act on one snapshot and execute in ledger order: a completion is
// recorded, and the item it was holding is spawned, in the same pass.
func TestExecutorsRunInLedgerOrderFromOneSnapshot(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: bar.Dir, Task: "b"})
	h.attachBranch("a", "a-branch")
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "260101-aaaa-x", Stage: "ship", DisplayState: "done"}
	res := h.step()
	var kinds []string
	for _, a := range res.Actions {
		kinds = append(kinds, a.Kind+" "+a.Item)
	}
	if got := strings.Join(kinds, "|"); got != "done a|spawned b" {
		t.Fatalf("actions = %q, want the completion recorded, then its dependent spawned", got)
	}
	if !operator.ItemDone(h.item("a")) {
		t.Fatal("completion not persisted")
	}
}

// A pass with nothing to do changes nothing and reports nothing.
func TestAnIdleStepIsIdempotent(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.attachBranch("a", "a-branch")
	h.gh.add(1, "a-branch").Checks = []checkRun{{State: "PENDING"}}
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeEngine, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	res := h.step()
	if len(res.Actions)+len(res.Escalations) != 0 {
		t.Fatalf("an idle step did something: %+v", res)
	}
	for _, c := range h.run.calls {
		for _, mutation := range []string{"gh pr merge", "gh pr ready", "git push", "git rebase"} {
			if strings.HasPrefix(c, mutation) {
				t.Fatalf("an idle step mutated: %q", c)
			}
		}
	}
	after, _ := os.ReadFile(h.env.StatePath)
	afterEngine, _ := os.ReadFile(engineFilePath(h.env.StatePath))
	if string(before) != string(after) || string(beforeEngine) != string(afterEngine) {
		t.Fatalf("an idle step rewrote state:\n%s\n---\n%s", before, after)
	}
}

// The dry run lists every chosen row and runs none of them.
func TestDryRunListsTheChosenRowsAndRunsNone(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: foo.Dir, Task: "b", DependsOn: &[]string{}})
	h.attachBranch("a", "a-branch")
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "260101-aaaa-x", Stage: "ship", DisplayState: "done"}
	h.env.DryRun = true
	h.run.reset()
	res := h.step()
	var got []string
	for _, a := range res.Actions {
		got = append(got, a.Kind+" "+a.Item+" "+a.Detail)
	}
	if !res.DryRun || strings.Join(got, "|") != "record-done a (Q1)|spawn b (Q2)" {
		t.Fatalf("dry-run actions = %q", got)
	}
	if operator.ItemDone(h.item("a")) || h.spawn.n != 0 {
		t.Fatal("dry-run changed state or spawned")
	}
}
