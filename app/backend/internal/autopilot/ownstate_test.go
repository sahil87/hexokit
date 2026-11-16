package autopilot

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rk/internal/operator"
)

func TestPausedPRProjectionWaitsWithoutDisarm(t *testing.T) {
	h, _, head := armableFixture(t)
	if err := operator.Pause(h.env.StatePath, head.ID); err != nil {
		t.Fatal(err)
	}
	e, d := h.decideFor(head.ID)
	h.run.reset()
	if d.Status != string(PRPaused) || d.Action != ActionWait {
		t.Fatalf("decision = %+v", d)
	}
	execOne(t, e, d)
	if len(h.run.calls) != 0 {
		t.Fatalf("paused PR reached a mutation: %q", h.run.calls)
	}
}

func TestRemovedProjectionNotifiesOnceAndIsNotReadded(t *testing.T) {
	h, _, head := armableFixture(t)
	var notified []string
	h.env.Notify = func(_ context.Context, title, body string) { notified = append(notified, title+": "+body) }
	if err := operator.Remove(h.env.StatePath, head.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		res := h.step()
		if i == 0 && !hasEscalation(res, "projection removed: "+head.ID) {
			t.Fatalf("first pass = %+v", res.Escalations)
		}
	}
	if len(notified) != 1 || !strings.Contains(notified[0], "projection removed") {
		t.Fatalf("notifications = %v", notified)
	}
	ledger, err := operator.Load(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if operator.IndexOf(ledger.Tracked, head.ID) >= 0 {
		t.Fatal("removed projection was recreated")
	}
	if !h.has(head.ID) {
		t.Fatal("engine item was lost with its projection")
	}
}

func TestPreSpawnEscalationProjectionLaterBindsPaneAndAlwaysUsesRunNotes(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	e := newEngine(h.env)
	if err := e.setScope("a", map[string]interface{}{"repo": ""}); err != nil {
		t.Fatal(err)
	}
	h.env.By = operator.ByChat
	var notified int
	h.env.Notify = func(context.Context, string, string) { notified++ }
	res := h.step()
	if !hasEscalation(res, "repo is empty") {
		t.Fatalf("result = %+v", res.Escalations)
	}
	projection := h.item("a")
	if operator.ScopeString(projection.Scope, "pane") != "" || len(projection.Notes) != 1 {
		t.Fatalf("identity projection = %+v", projection)
	}
	if projection.Notes[0].By != operator.ByRun || !strings.HasPrefix(projection.Notes[0].Text, "escalated: ") {
		t.Fatalf("note = %+v", projection.Notes[0])
	}
	if err := e.setScope("a", map[string]interface{}{"repo": foo.Dir}); err != nil {
		t.Fatal(err)
	}
	h.step()
	projection = h.item("a")
	if operator.ScopeString(projection.Scope, "pane") == "" || !scopeBool(projection, scopeProjected) {
		t.Fatalf("spawn did not bind the existing projection: %+v", projection)
	}
	for _, key := range []string{scopeQueue, scopeMergeMode, scopeSpawning, scopeEscalated} {
		ledger, loadErr := operator.Load(h.env.StatePath)
		if loadErr != nil {
			t.Fatal(loadErr)
		}
		raw := ledger.Tracked[operator.IndexOf(ledger.Tracked, "a")]
		if _, exists := raw.Scope[key]; exists {
			t.Fatalf("projection carries engine key %s", key)
		}
	}
	if notified != 1 {
		t.Fatalf("notifications = %d", notified)
	}
}

func TestItemlessEscalationNotifiesWithoutLedgerWrite(t *testing.T) {
	h := newHarness(t)
	var title, body string
	h.env.Notify = func(_ context.Context, gotTitle, gotBody string) { title, body = gotTitle, gotBody }
	e := newEngine(h.env)
	e.escalate("", "step failed: test")
	if title != "autopilot" || body != "step failed: test" || len(e.res.Escalations) != 1 {
		t.Fatalf("title=%q body=%q result=%+v", title, body, e.res)
	}
	if _, err := operator.Load(h.env.StatePath); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveRejectsDependentsAndResumeUndoesStop(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	_, err := Remove(context.Background(), h.env, "a")
	var invalid *InvalidError
	if !errors.As(err, &invalid) || !strings.Contains(err.Error(), "unfinished dependents") || !h.has("a") {
		t.Fatalf("dependent removal: err=%v engine=%+v", err, h.state().Tracked)
	}
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if !h.item("a").Paused || !h.item("b").Paused {
		t.Fatal("stop did not pause the unspawned items")
	}
	res, err := Resume(context.Background(), h.env, "a")
	if err != nil || !hasAction(res, ActSpawned, "a") {
		t.Fatalf("resume = %+v, err=%v", res, err)
	}
}

func TestRemoveUnspawnedQueueItemAndHaltedSequence(t *testing.T) {
	t.Run("queue", func(t *testing.T) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
		if _, err := Remove(context.Background(), h.env, "a"); err != nil {
			t.Fatal(err)
		}
		if h.has("a") {
			t.Fatal("unspawned item survived rm")
		}
	})
	t.Run("sequence", func(t *testing.T) {
		h, _, head := armFixture(t)
		if _, err := Stop(context.Background(), h.env); err != nil {
			t.Fatal(err)
		}
		if _, err := Remove(context.Background(), h.env, head.ID); err != nil {
			t.Fatal(err)
		}
		if h.has("pr-1") || !h.has("pr-2") {
			t.Fatalf("rm changed more than the named sequence: %v", ids(h.state().Tracked))
		}
		ledger, err := operator.Load(h.env.StatePath)
		if err != nil {
			t.Fatal(err)
		}
		if operator.IndexOf(ledger.Tracked, "pr-1") >= 0 || operator.IndexOf(ledger.Tracked, "pr-2") < 0 {
			t.Fatal("sequence projection removal did not match the engine change")
		}
	})
}
