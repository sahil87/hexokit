package autopilot

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operator"
	"rk/internal/riff"
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
	want := "spawn interrupted: a — check for an orphaned window before resuming or removing the queue item"
	notified := 0
	h.env.Notify = func(context.Context, string, string) { notified++ }
	for i := 0; i < 3; i++ {
		res := h.step()
		if got := hasEscalation(res, want); got != (i == 0) {
			t.Fatalf("pass %d escalation = %v, want first sighting only: %+v", i, got, res.Escalations)
		}
	}
	if notes := len(h.item("a").Notes); notes != 1 || notified != 1 {
		t.Fatalf("interrupted spawn wrote %d notes and %d notifications, want one each", notes, notified)
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
	if !hasEscalation(res, "spawn failed: wt create failed") || spawningSet(h.item("a")) || h.stateOf(h.item("a")) != QueuePending {
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
	if !hasEscalation(res, "window %101 opened but recording its engine binding failed") || hasAction(res, ActSpawned, "") {
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

// A raw-task or bare spawn fixes no branch: wt names it after the worktree and
// reports it in its receipt. The window-opened record must still carry it; only
// a window opened in an existing worktree has no receipt and reads git.
func TestOpenedBranchTakesTheReceiptWhenTheRequestFixedNone(t *testing.T) {
	foo := newRepo(t, "foo")
	wt := filepath.Join(t.TempDir(), "fix-login")
	runGit(t, foo.Dir, "worktree", "add", "-b", "fix-login", wt, "main")
	ctx := context.Background()

	got, err := openedBranch(ctx, nil, SpawnRequest{Repo: foo.Dir, WorktreeName: "fix-login"}, riff.OpenedWindow{WorktreePath: wt, Branch: "fix-login"})
	if err != nil || got != "fix-login" {
		t.Fatalf("branch = %q err %v", got, err)
	}
	if got, _ := openedBranch(ctx, nil, SpawnRequest{NewBranch: "260101-ab12-folder"}, riff.OpenedWindow{Branch: "fix-login"}); got != "260101-ab12-folder" {
		t.Fatalf("a fixed branch must win: %q", got)
	}
	if _, err := openedBranch(ctx, nil, SpawnRequest{}, riff.OpenedWindow{WorktreePath: wt}); err == nil {
		t.Fatal("a receipt without a branch (detached or temp) has none to record")
	}
	if _, err := openedBranch(ctx, nil, SpawnRequest{}, riff.OpenedWindow{Branch: "bad branch name"}); err == nil {
		t.Fatal("a receipt branch must pass the branch-name rules")
	}

	existing := SpawnRequest{ExistingWorktree: wt}
	if got, err := openedBranch(ctx, ExecRunner{}, existing, riff.OpenedWindow{}); err != nil || got != "fix-login" {
		t.Fatalf("an existing worktree reads its branch from git: %q err %v", got, err)
	}
	runGit(t, wt, "checkout", "--detach")
	if _, err := openedBranch(ctx, ExecRunner{}, existing, riff.OpenedWindow{}); err == nil {
		t.Fatal("a detached worktree has no branch to record")
	}
	if _, err := openedBranch(ctx, nil, existing, riff.OpenedWindow{}); err == nil {
		t.Fatal("no runner, no branch")
	}
}

// Both the raw-task and the bare spawn must leave the created branch on the
// item and in branch_map.
func TestRawTaskAndBareSpawnsRecordTheCreatedBranch(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "raw", Repo: foo.Dir, Task: "do it"}, Entry{ID: "bare", Repo: foo.Dir, DependsOn: &[]string{}})
	h.step()
	for _, id := range []string{"raw", "bare"} {
		it := h.item(id)
		if operator.ScopeString(it.Scope, "branch") != id || h.state().BranchMap[id].Branch != id {
			t.Fatalf("%s: scope=%+v branch_map=%+v", id, it.Scope, h.state().BranchMap[id])
		}
	}
}

func TestProjectionAttachErrorDoesNotClaimSpawningWasLeftSet(t *testing.T) {
	got := attachEscalation("%12", &projectionWriteError{err: errors.New("ledger unavailable")})
	if strings.Contains(got, "spawning left set") || !strings.Contains(got, "engine binding was recorded") || !strings.Contains(got, "projection update failed") {
		t.Fatalf("projection error = %q", got)
	}
	if got := attachEscalation("%12", errors.New("engine write failed")); !strings.Contains(got, "spawning left set") {
		t.Fatalf("engine-binding error = %q", got)
	}
}
