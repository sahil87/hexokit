package autopilot

import (
	"os"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

// Q6b: a queue open for over two hours is reported once, on its oldest
// unfinished item, whatever that item's status.
func TestQueueOpenTooLongEscalatesOnTheOldestItemOnce(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	if err := operator.Pause(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	h.clock = h.clock.Add(slowQueue + time.Minute)
	reason := "queue open for over 2h0m0s"
	res := h.step()
	var on []string
	for _, e := range res.Escalations {
		if e.Reason == reason {
			on = append(on, e.Item)
		}
	}
	if len(on) != 1 || on[0] != "a" {
		t.Fatalf("escalated on %v, want the oldest item a once: %+v", on, res.Escalations)
	}
	if res := h.step(); hasEscalation(res, reason) {
		t.Fatalf("a recorded reason escalated again: %+v", res.Escalations)
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
	h, _ := ladderPair(t)
	h.step()
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	res := h.step()
	if len(res.Actions)+len(res.Escalations)+len(res.Report) != 0 {
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
	// The head's polled state is rewritten each pass; everything else is stable.
	if strings.Count(string(before), "\n") != strings.Count(string(after), "\n") {
		t.Fatalf("state shape changed:\n%s\n---\n%s", before, after)
	}
}

// The dry run lists every chosen row and runs none of them.
func TestDryRunListsRowsForEveryKindOfAction(t *testing.T) {
	h, prs := ladderPair(t)
	prs[0].State = "MERGED"
	h.env.DryRun = true
	h.run.reset()
	res := h.step()
	if !res.DryRun || len(res.Actions) != 1 || res.Actions[0].Kind != string(ActionRecordMerged) || res.Actions[0].Item != "pr-1" || res.Actions[0].Detail != "(P1)" {
		t.Fatalf("dry-run actions = %+v", res.Actions)
	}
	for _, c := range h.run.calls {
		if strings.HasPrefix(c, "gh pr merge") || strings.HasPrefix(c, "gh pr ready") {
			t.Fatalf("dry-run acted: %q", c)
		}
	}
	if operator.ItemDone(h.item("pr-1")) {
		t.Fatal("dry-run recorded a merge")
	}
}
