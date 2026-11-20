package autopilot

import (
	"context"
	"testing"

	"rk/internal/operator"
)

func TestStopIntentWriteFailureDoesNotAct(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "pending", Repo: repo.Dir, Task: "work"})
	readOnlyState(t, h)
	res, err := Stop(context.Background(), h.env)
	if err == nil || len(res.Actions) != 0 || h.item("pending").Paused {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestObservedCompletionWriteFailureDoesNotReportDone(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	h.attachBranch("a", "a-branch")
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "aaaa", Stage: "ship", DisplayState: "done"}
	e, d := h.decideFor("a")
	if d.Action != ActionRecordDone {
		t.Fatalf("decision = %+v", d)
	}
	readOnlyState(t, h)
	if err := e.execute(context.Background(), []Decision{d}); err == nil {
		t.Fatal("write failure swallowed")
	}
	if hasAction(e.res, ActDone, "") {
		t.Fatal("completion reported before persistence")
	}
}
