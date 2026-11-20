package autopilot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

func TestRemovedProjectionNotifiesOnceAndIsNotReadded(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "aaaa"})
	h.step()
	h.livePanes()
	var notified []string
	h.env.Notify = func(_ context.Context, title, body string) { notified = append(notified, title+": "+body) }
	if err := operator.Remove(h.env.StatePath, "a"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		res := h.step()
		if i == 0 && !hasEscalation(res, "projection removed: a") {
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
	if operator.IndexOf(ledger.Tracked, "a") >= 0 {
		t.Fatal("removed projection was recreated")
	}
	if !h.has("a") {
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

func TestRemoveUnspawnedQueueItem(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	res, err := Remove(context.Background(), h.env, "a")
	if err != nil || !hasAction(res, ActRemoved, "a") || h.has("a") {
		t.Fatalf("rm = %+v, %v, items %v", res, err, ids(h.state().Tracked))
	}
}

func TestRemoveRefusesASpawnedItem(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	_, err := Remove(context.Background(), h.env, "a")
	var invalid *InvalidError
	if !errors.As(err, &invalid) || !h.has("a") {
		t.Fatalf("rm of a spawned item: %v", err)
	}
}

// A former PR or fix item in a legacy engine file or the ledger is no engine
// item: rm and resume name it as unknown and write nothing.
func TestRmAndResumeOfAFormerPRIDAreUnknownIDs(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	pr, err := operator.NewGitHubPRItem("pr-41", nil, map[string]interface{}{"repo": foo.Dir, "pr": 41, "merge_seq": "s", "halted": true}, "o/foo")
	if err != nil {
		t.Fatal(err)
	}
	writeOperatorItems(t, h.env.StatePath, pr)
	if err := operator.Pause(h.env.StatePath, "pr-41"); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(h.env.StatePath)
	beforeEngine, _ := os.ReadFile(engineFilePath(h.env.StatePath))
	for name, call := range map[string]func() error{
		"rm":     func() error { _, err := Remove(context.Background(), h.env, "pr-41"); return err },
		"resume": func() error { _, err := Resume(context.Background(), h.env, "pr-41"); return err },
		"rm seq": func() error { _, err := Remove(context.Background(), h.env, "s"); return err },
	} {
		var invalid *InvalidError
		if err := call(); !errors.As(err, &invalid) || !strings.Contains(err.Error(), "unknown autopilot item") {
			t.Errorf("%s: err = %v, want an unknown-item usage error", name, err)
		}
	}
	after, _ := os.ReadFile(h.env.StatePath)
	afterEngine, _ := os.ReadFile(engineFilePath(h.env.StatePath))
	if string(before) != string(after) || string(beforeEngine) != string(afterEngine) {
		t.Fatal("a refused rm or resume wrote state")
	}
}

// A queue item that carries only the retired `halted` marker has nothing to
// resume.
func TestResumeOfAHaltedOnlyItemIsAUsageError(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	legacy := "version: 1\nmigrated: true\nqueue:\n  - id: a\n    queue: q\n    repo: " + foo.Dir + "\n    task: work\n    depends_on: []\n    halted: true\n"
	if err := os.MkdirAll(filepath.Dir(h.env.StatePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engineFilePath(h.env.StatePath), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Resume(context.Background(), h.env, "a")
	var invalid *InvalidError
	if !errors.As(err, &invalid) || !strings.Contains(err.Error(), "not skipped or paused") {
		t.Fatalf("resume of a halted-only item: %v", err)
	}
}

// stop pauses every unspawned, unfinished item, leaves live panes alone, and
// neither reads nor writes any PR state.
func TestStopPausesUnspawnedItemsAndWritesNoHalt(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "aaaa", DependsOn: &[]string{}}, Entry{ID: "b", Repo: foo.Dir, Change: "bbbb", DependsOn: &[]string{}})
	h.step() // both spawn
	h.livePanes()
	h.queue("", Entry{ID: "c", Repo: foo.Dir, Change: "cccc", DependsOn: &[]string{"a"}})
	h.run.reset()
	res, err := Stop(context.Background(), h.env)
	if err != nil || !hasAction(res, ActPaused, "c") || hasAction(res, ActPaused, "a") || hasAction(res, ActPaused, "b") {
		t.Fatalf("stop = %+v, %v", res, err)
	}
	if !h.item("c").Paused || h.item("a").Paused || h.item("b").Paused {
		t.Fatal("stop must pause only the unspawned item")
	}
	if h.run.called("gh ") != 0 {
		t.Fatalf("stop reached GitHub: %q", h.run.calls)
	}
	data, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil || strings.Contains(string(data), "halted") {
		t.Fatalf("stop wrote a halt marker: %s, %v", data, err)
	}
}
