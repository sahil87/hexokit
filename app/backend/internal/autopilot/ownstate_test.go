package autopilot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

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

func TestStopWithIdentityProjectionDoesNotSpawnAfterCauseIsFixed(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	e := newEngine(h.env)
	if err := e.setScope("a", map[string]interface{}{"repo": ""}); err != nil {
		t.Fatal(err)
	}
	h.step() // pre-spawn escalation creates the identity-only projection
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if !h.item("a").Paused || h.stateOf(h.item("a")) != QueuePaused {
		t.Fatalf("stop pause was lost in the view: %+v", h.item("a"))
	}
	if err := e.setScope("a", map[string]interface{}{"repo": foo.Dir}); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	if h.spawn.n != 0 || hasAction(res, ActSpawned, "a") || h.stateOf(h.item("a")) != QueuePaused {
		t.Fatalf("stop was circumvented: spawns=%d result=%+v", h.spawn.n, res)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || !engine.Queue[0].Paused {
		t.Fatalf("engine pause was overwritten: %+v, %v", engine.Queue, err)
	}
}

func TestGuardedPatchDoesNotStoreProjectionPause(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	h.attachBranch("a", "a-branch")
	if err := operator.Pause(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	e := newEngine(h.env)
	if err := e.patch("a", func(it *operator.TrackedItem) { it.Scope["branch"] = "new-branch" }); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if engine.Queue[0].Paused {
		t.Fatal("projection pause was persisted as engine intent")
	}
}

func TestRemoveHaltedSequenceRefusesArmedOrUnreadablePR(t *testing.T) {
	for _, scenario := range []string{"armed", "unreadable"} {
		t.Run(scenario, func(t *testing.T) {
			h, pr, head := armableFixture(t)
			if _, err := Stop(context.Background(), h.env); err != nil {
				t.Fatal(err)
			}
			if scenario == "armed" {
				pr.Armed = true
			} else {
				h.run.fail("gh pr view 1", "API unavailable")
			}
			_, err := Remove(context.Background(), h.env, head.ID)
			var invalid *InvalidError
			if err == nil || errors.As(err, &invalid) || !strings.Contains(err.Error(), "PR #1") {
				t.Fatalf("rm error = %v", err)
			}
			if !h.has(head.ID) {
				t.Fatal("refusal dropped the halted sequence")
			}
			engine, loadErr := loadEngineFile(h.env.StatePath)
			if loadErr != nil || len(engine.PRs) != 2 {
				t.Fatalf("refusal changed PR items: %+v, %v", engine.PRs, loadErr)
			}
		})
	}
}

func TestRespawnDoesNotRecreateRemovedProjection(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	h.step()
	if err := operator.Remove(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	delete(h.panes.panes, "%101")
	h.step()        // removed-projection escalation
	res := h.step() // respawn from engine state only
	if !hasAction(res, ActRespawned, "a") || h.spawn.n != 2 {
		t.Fatalf("respawn = %+v, launches=%d", res, h.spawn.n)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || len(engine.Queue) != 1 || engine.Queue[0].Pane != "%102" {
		t.Fatalf("respawn binding = %+v, %v", engine.Queue, err)
	}
	ledger, err := operator.Load(h.env.StatePath)
	if err != nil || operator.IndexOf(ledger.Tracked, "a") >= 0 {
		t.Fatalf("respawn recreated the projection: %+v, %v", ledger.Tracked, err)
	}
}

type failingPanes struct{}

func (failingPanes) Snapshot(context.Context) (map[string]operator.PaneInfo, error) {
	return nil, errors.New("snapshot unavailable")
}
func (failingPanes) PID(context.Context, string) (int, error) { return 123, nil }
func (failingPanes) Send(context.Context, string, string) error {
	return errors.New("send unavailable")
}

func TestQueuePassErrorReceiptReportsSuccessAndEscalation(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.env.Panes = failingPanes{}
	rec, err := Enqueue(context.Background(), h.env, []Entry{{ID: "a", Repo: foo.Dir, Task: "work"}}, QueueOptions{}, "")
	if err != nil {
		t.Fatalf("queue failed after its engine write: %v", err)
	}
	if len(rec.Items) != 1 || len(rec.Escalations) == 0 {
		t.Fatalf("receipt = %+v", rec)
	}
	found := false
	for _, escalation := range rec.Escalations {
		if strings.Contains(escalation.Reason, "snapshot unavailable") {
			found = true
		}
	}
	if !found {
		t.Fatalf("pass error missing from receipt: %+v", rec.Escalations)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || len(engine.Queue) != 1 {
		t.Fatalf("engine write missing: %+v, %v", engine.Queue, err)
	}
}

func TestRemoveHaltedMergeAutoSequenceNeverRetracksOrRearms(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	pr := pendingPR(h.shipped(1, "a")[0])
	h.step() // track PR
	h.step() // arm it
	if !pr.Armed {
		t.Fatal("fixture did not arm the merge-auto PR")
	}
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if _, err := Remove(context.Background(), h.env, "pr-1"); err != nil {
		t.Fatal(err)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || len(engine.Queue) != 1 || !engine.Queue[0].PRDropped || len(engine.PRs) != 0 {
		t.Fatalf("drop state = %+v, %v", engine, err)
	}
	for i := 0; i < 3; i++ {
		res := h.step()
		if hasAction(res, ActPRTracked, "") || hasAction(res, ActArmed, "") || h.has("pr-1") {
			t.Fatalf("pass %d retracked the dropped PR: %+v", i, res)
		}
	}
	if pr.Armed || pr.MergeCalls != 0 {
		t.Fatalf("drop was re-armed or merged: %+v", pr)
	}

	h.startMerge()
	engine, err = loadEngineFile(h.env.StatePath)
	if err != nil || engine.Queue[0].PRDropped || len(engine.PRs) != 1 {
		t.Fatalf("explicit merge did not re-chain: %+v, %v", engine, err)
	}
}

func TestCheckWrittenDoneAtIsCachedBeforeProjectionRemoval(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "work"})
	h.attachBranch("a", "a-branch")
	now := time.Now().UTC().Format(time.RFC3339)
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[operator.IndexOf(st.Tracked, "a")].DoneAt = &now
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if res := h.step(); !hasAction(res, ActDone, "a") {
		t.Fatalf("completion was not recorded: %+v", res)
	}
	engine, err := loadEngineFile(h.env.StatePath)
	if err != nil || engine.Queue[0].DoneAt == nil {
		t.Fatalf("engine completion was not cached: %+v, %v", engine.Queue, err)
	}
	if err := operator.Remove(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	h.panes.panes = map[string]operator.PaneInfo{}
	for i := 0; i < 3; i++ {
		res := h.step()
		if hasAction(res, ActRespawned, "a") || len(res.Escalations) != 0 {
			t.Fatalf("finished item respawned or escalated after projection cleanup: %+v", res)
		}
	}
	if got := h.stateOf(h.item("a")); got != QueueDone {
		t.Fatalf("finished item became %s", got)
	}
}

func pendingPR(pr *simPR) *simPR {
	pending(pr)
	return pr
}
