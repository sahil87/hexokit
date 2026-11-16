package autopilot

import (
	"context"
	"strings"
	"testing"

	"rk/internal/operator"
)

func TestMergedWriteFailureDoesNotReportCompletion(t *testing.T) {
	h, _, head := armFixture(t)
	readOnlyState(t, h)
	e := newEngine(h.env)
	var unreviewed []string
	if e.markMerged(context.Background(), head, prView{State: "MERGED"}, 1, 1, &unreviewed) {
		t.Fatal("acknowledged failed write")
	}
	if hasAction(e.res, ActMerged, "") || len(e.res.Report) != 0 || len(unreviewed) != 0 || !hasEscalation(e.res, "merged completion not written") {
		t.Fatalf("result = %+v", e.res)
	}
	if operator.ItemDone(h.item(head.ID)) {
		t.Fatal("failed write changed completion")
	}
}

func TestStackedPushWriteFailureDoesNotReportRebased(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	repo.branch("a-branch", "main", "a.txt", "a")
	repo.branch("b-branch", "a-branch", "b.txt", "b")
	repo.pushBranch("a-branch")
	repo.pushBranch("b-branch")
	h.queue(operator.MergeModeStackedPRs, Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: repo.Dir, Change: "bbbb"})
	h.shipped(1, "a", "b")
	e := newEngine(h.env)
	st := h.state()
	items, err := e.buildPRChains(context.Background(), st, st.Tracked, map[string]bool{"a": true, "b": true})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.addPRItems(items); err != nil {
		t.Fatal(err)
	}
	h.run.onRun = func(argv []string) {
		if strings.HasPrefix(strings.Join(argv, " "), "git push --force-with-lease") {
			readOnlyState(t, h)
		}
	}
	e.prepareStacked(context.Background(), h.state(), items[0], items[1], prView{BaseRefName: "main"})
	if h.run.called("git push --force-with-lease") != 1 || hasAction(e.res, ActRebased, "") || !hasEscalation(e.res, "prepared marker not written") {
		t.Fatalf("result = %+v", e.res)
	}
	if scopeBool(h.item("pr-2"), scopePrepared) {
		t.Fatal("failed write marked prepared")
	}
}

func TestHaltWriteFailureIsNotAcknowledged(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	st := h.state()
	readOnlyState(t, h)
	e := newEngine(h.env)
	e.haltCone(context.Background(), st, h.item("pr-1"), "stop this cone")
	if hasEscalation(e.res, "halted:") || !hasEscalation(e.res, "halt marker not written") || pr.Disarms != 0 {
		t.Fatalf("result = %+v", e.res)
	}
}

func TestStopIntentWriteFailureDoesNotAct(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	h.queue("", Entry{ID: "pending", Repo: operator.ScopeString(head.Scope, "repo"), Task: "work"})
	readOnlyState(t, h)
	res, err := Stop(context.Background(), h.env)
	if err == nil || len(res.Actions) != 0 || pr.Disarms != 0 || h.item("pending").Paused {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
}

func TestStopPersistsIntentBeforeDisarmingAndPropagatesFailure(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	h.run.on("gh pr merge --disable-auto", func(_ string, argv []string) (string, error) {
		if !scopeBool(h.item(head.ID), scopeHalted) {
			t.Fatal("stop not durable before disarm")
		}
		pr.Armed = false
		readOnlyState(t, h)
		return "", nil
	})
	res, err := Stop(context.Background(), h.env)
	if err == nil || hasAction(res, ActDisarmed, "") || !hasEscalation(res, "disarmed marker not written") {
		t.Fatalf("result = %+v, err = %v", res, err)
	}
	if !scopeBool(h.item(head.ID), scopeArmed) {
		t.Fatal("uncertain marker lost")
	}
}

func TestStopDisarmsMarkedMergedItems(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	h.setDone(head.ID)
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if pr.Disarms != 1 || scopeBool(h.item(head.ID), scopeArmed) {
		t.Fatal("stop skipped a done item carrying an arm marker")
	}
}

func TestObservedCompletionWriteFailureDoesNotReportDone(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	h.attachBranch("a", "a-branch")
	h.panes.panes["%900"] = operator.PaneInfo{PaneID: "%900", Change: "aaaa", Stage: "ship", DisplayState: "done"}
	readOnlyState(t, h)
	e := newEngine(h.env)
	if err := e.observeDone(context.Background()); err == nil {
		t.Fatal("write failure swallowed")
	}
	if hasAction(e.res, ActDone, "") {
		t.Fatal("completion reported before persistence")
	}
}
