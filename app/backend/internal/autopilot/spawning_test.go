package autopilot

import (
	"errors"
	"testing"

	"rk/internal/operator"
)

func TestSpawnMarkerIsDurableBeforeTheLaunchAndClearedByTheAttach(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	var atLaunch operator.TrackedItem
	h.spawn.during = func() { atLaunch = h.item("a") }
	h.step()
	if !spawningSet(atLaunch) || operator.ScopeString(atLaunch.Scope, "pane") != "" {
		t.Fatalf("the marker must be durable, with no pane, when the window opens: %+v", atLaunch.Scope)
	}
	it := h.item("a")
	if spawningSet(it) || operator.ScopeString(it.Scope, "pane") == "" || operator.ScopeString(it.Scope, "session") == "" || operator.ScopeString(it.Scope, "branch") == "" {
		t.Fatalf("the attach must record pane, session and branch and clear the marker: %+v", it.Scope)
	}
}

func TestMarkerWithoutAPaneEscalatesAndNeverLaunches(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	if err := h.envPatch("a", map[string]interface{}{scopeSpawning: "2026-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	for i := 0; i < 2; i++ {
		res := h.step()
		if !hasEscalation(res, "spawn interrupted: a — check for an orphaned window, then clear scope.spawning with rk operator track update") {
			t.Fatalf("pass %d escalations = %+v", i, res.Escalations)
		}
	}
	if h.spawn.n != 0 || h.run.called("git fetch") != 0 {
		t.Fatalf("an interrupted spawn was relaunched: launches=%d calls=%q", h.spawn.n, h.run.calls)
	}
	if operator.ScopeString(h.item("a").Scope, "pane") != "" || !spawningSet(h.item("a")) {
		t.Fatal("the item was changed")
	}
}

func TestSpawnFailureBeforeAWindowClearsTheMarkerAndRetries(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.spawn.failWith = errors.New("wt create failed")
	res := h.step()
	if !hasEscalation(res, "spawn failed: wt create failed") || spawningSet(h.item("a")) || derivedState(h.state(), h.item("a")) != StatePending {
		t.Fatalf("res=%+v scope=%+v", res, h.item("a").Scope)
	}
	h.spawn.failWith = nil
	if res := h.step(); !hasAction(res, ActSpawned, "a") {
		t.Fatalf("the cleared item was not retried: %+v", res)
	}
}

func TestAttachWriteFailureEscalatesNamingThePaneAndNeverRelaunches(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.spawn.during = func() { readOnlyState(t, h) }
	res := h.step()
	if !hasEscalation(res, "window %101 opened but recording it failed") || hasAction(res, ActSpawned, "") {
		t.Fatalf("res=%+v", res)
	}
	restoreStateWrites(t, h)
	h.spawn.during = nil
	if !spawningSet(h.item("a")) || operator.ScopeString(h.item("a").Scope, "pane") != "" {
		t.Fatalf("the marker must stay set: %+v", h.item("a").Scope)
	}
	res = h.step()
	if h.spawn.n != 1 || !hasEscalation(res, "spawn interrupted: a") {
		t.Fatalf("launches=%d res=%+v", h.spawn.n, res)
	}
}

func TestRespawnWritesItsMarkersFirstAndASecondDeathEscalates(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	var atLaunch operator.TrackedItem
	h.spawn.during = func() { atLaunch = h.item("a") }
	if res := h.step(); !hasAction(res, ActRespawned, "a") {
		t.Fatalf("no respawn: %+v", res)
	}
	if !spawningSet(atLaunch) || !scopeBool(atLaunch, scopeRespawned) {
		t.Fatalf("respawned and spawning must both be durable before the window opens: %+v", atLaunch.Scope)
	}
	if spawningSet(h.item("a")) || !scopeBool(h.item("a"), scopeRespawned) {
		t.Fatalf("after the respawn: %+v", h.item("a").Scope)
	}
	launches := h.spawn.n
	res := h.step()
	if h.spawn.n != launches || !hasEscalation(res, "after its one respawn") {
		t.Fatalf("launches=%d res=%+v", h.spawn.n, res)
	}
}

func TestRespawnFailureBeforeAWindowDoesNotSpendTheRespawn(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	h.spawn.failWith = errors.New("launcher failed")
	h.step()
	it := h.item("a")
	if spawningSet(it) || scopeBool(it, scopeRespawned) {
		t.Fatalf("a respawn that opened no window must clear both markers: %+v", it.Scope)
	}
	h.spawn.failWith = nil
	if res := h.step(); !hasAction(res, ActRespawned, "a") {
		t.Fatalf("the respawn was not retried: %+v", res)
	}
}

func (h *harness) envPatch(id string, kv map[string]interface{}) error {
	return newEngine(h.env).setScope(id, kv)
}
