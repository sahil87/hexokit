package autopilot

import (
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

// A person's note that happens to read like an escalation must not suppress
// the engine's own: repeat-suppression lives in scope.escalated.
func TestEscalationDedupReadsTheStructuredRecordNotNoteText(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	h.panes.panes["%101"] = operator.PaneInfo{PaneID: "%101"}

	reason := "stage (unknown) over 30m0s without moving"
	if err := operator.AddNote(h.env.StatePath, "a", operator.ByUser, "escalated: "+reason); err != nil {
		t.Fatal(err)
	}
	h.clock = h.clock.Add(slowStage + time.Minute)

	res := h.step()
	if !hasEscalation(res, reason) {
		t.Fatalf("a user note suppressed the escalation: %+v", res.Escalations)
	}
	seen, _ := h.item("a").Scope[scopeEscalated].(map[string]interface{})
	if _, ok := seen[reason]; !ok {
		t.Fatalf("scope.escalated = %v, want %q recorded", seen, reason)
	}

	if res := h.step(); hasEscalation(res, reason) {
		t.Fatalf("a recorded reason escalated again: %+v", res.Escalations)
	}
}

// Deleting every note (or overflowing the ring) must not re-open a recorded
// escalation, and the note is written only on the first sighting.
func TestEscalationNoteWrittenOncePerReasonAndSurvivesNoteLoss(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	e := newEngine(h.env)
	for i := 0; i < 3; i++ {
		e.escalate("a", "something stuck")
	}
	count := func() int {
		n := 0
		for _, note := range h.item("a").Notes {
			if strings.Contains(note.Text, "something stuck") {
				n++
			}
		}
		return n
	}
	if count() != 1 {
		t.Fatalf("notes for the reason = %d, want 1", count())
	}
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[operator.IndexOf(st.Tracked, "a")].Notes = nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	e.escalate("a", "something stuck")
	if count() != 0 {
		t.Fatalf("a recorded reason must not rewrite its note: %d", count())
	}
	if len(e.res.Escalations) != 4 {
		t.Fatalf("every call still reports the escalation: %d", len(e.res.Escalations))
	}
}

// A queue item removed after the pass read it gets nothing written: no
// re-created item, and the opened window is named in an escalation.
func TestAttachForARemovedItemRecreatesNothingAndEscalatesThePane(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b", DependsOn: &[]string{}})
	h.spawn.during = func() {
		if len(h.spawn.reqs) == 1 {
			if err := operator.Remove(h.env.StatePath, "a", false); err != nil {
				t.Fatal(err)
			}
		}
	}
	res := h.step()
	if h.has("a") {
		t.Fatal("attach re-created the removed item")
	}
	found := false
	for _, esc := range res.Escalations {
		if esc.Item == "a" && strings.Contains(esc.Reason, "window %101 opened but a was removed") {
			found = true
		}
	}
	if !found || hasAction(res, ActSpawned, "a") {
		t.Fatalf("res = %+v", res)
	}
	if len(h.state().BranchMap) != 0 && h.state().BranchMap["a"].Branch != "" {
		t.Fatalf("branch_map gained the removed item: %+v", h.state().BranchMap)
	}
}
