package autopilot

import (
	"context"
	"testing"

	"rk/internal/operator"
)

func TestMergedWriteFailureDoesNotReportCompletion(t *testing.T) {
	h, pr, head := armFixture(t)
	changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.Scope[scopeDeferred] = false })
	pr.State = "MERGED"
	e, d := h.decideFor(head.ID)
	if d.Action != ActionRecordMerged {
		t.Fatalf("decision = %+v", d)
	}
	readOnlyState(t, h)
	execOne(t, e, d)
	if hasAction(e.res, ActMerged, "") || len(e.res.Report) != 0 || len(e.res.Unreviewed) != 0 || !hasEscalation(e.res, "merged completion not written") {
		t.Fatalf("result = %+v", e.res)
	}
	if operator.ItemDone(h.item(head.ID)) {
		t.Fatal("failed write changed completion")
	}
}

func TestHaltWriteFailureIsNotAcknowledged(t *testing.T) {
	h, pr, head := armFixture(t)
	changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.Scope[scopeDeferred] = false })
	pr.State = "CLOSED"
	pr.Armed = true
	e, d := h.decideFor(head.ID)
	if d.Action != ActionHalt {
		t.Fatalf("decision = %+v", d)
	}
	readOnlyState(t, h)
	execOne(t, e, d)
	if hasEscalation(e.res, "halted:") || !hasEscalation(e.res, "halt marker not written") || pr.Disarms != 0 {
		t.Fatalf("result = %+v", e.res)
	}
}

func TestStopIntentWriteFailureDoesNotAct(t *testing.T) {
	h, pr, head := armFixture(t)
	pr.Armed = true
	h.queue("", Entry{ID: "pending", Repo: operator.ScopeString(head.Scope, "repo"), Task: "work"})
	readOnlyState(t, h)
	res, err := Stop(context.Background(), h.env)
	if err == nil || len(res.Actions) != 0 || pr.Disarms != 0 || h.item("pending").Paused {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestStopPersistsIntentBeforeDisarming(t *testing.T) {
	h, pr, head := armFixture(t)
	pr.Armed = true
	h.run.on("gh pr merge --disable-auto", func(_ string, argv []string) (string, error) {
		if !scopeBool(h.item(head.ID), scopeHalted) {
			t.Fatal("stop not durable before disarm")
		}
		return h.gh.handle("", argv)
	})
	res, err := Stop(context.Background(), h.env)
	if err != nil || !hasAction(res, ActDisarmed, head.ID) || pr.Armed {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestStopLeavesAMergedPRItemAlone(t *testing.T) {
	h, pr, head := armFixture(t)
	h.setDone(head.ID)
	pr.State = "MERGED"
	res, err := Stop(context.Background(), h.env)
	if err != nil || pr.Disarms != 0 || scopeBool(h.item(head.ID), scopeHalted) || hasAction(res, ActDisarmed, "") {
		t.Fatalf("stop touched a merged PR item: %+v, err = %v", res, err)
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
	if err := e.execute(context.Background(), e.facts, []Decision{d}); err == nil {
		t.Fatal("write failure swallowed")
	}
	if hasAction(e.res, ActDone, "") {
		t.Fatal("completion reported before persistence")
	}
}
