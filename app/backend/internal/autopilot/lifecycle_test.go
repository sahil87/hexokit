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

func recoveryFixture(t *testing.T) (*harness, *simPR) {
	t.Helper()
	h := newHarness(t)
	repo := newRepo(t, "repo")
	repo.branch("a-branch", "main", "a.txt", "work")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "ab12"})
	pr := h.shipped(1, "a")[0]
	h.startMerge()
	pr.Checks = []checkRun{{Name: "CI", State: "FAILURE"}}
	return h, pr
}

func restoreStateWrites(t *testing.T, h *harness) {
	t.Helper()
	if err := os.Chmod(filepath.Dir(h.env.StatePath), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestOverlappingStepsClaimOnlyOneRespawn(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	h.step()
	h.spawn.during = func() {
		it := h.item("a")
		if claimToken(it) == "" || !scopeBool(it, scopeRespawned) {
			t.Fatal("respawn allowance and claim not atomic")
		}
		if res := h.step(); hasAction(res, ActRespawned, "") {
			t.Fatalf("overlap respawned: %+v", res)
		}
	}
	res := h.step()
	if h.spawn.n != 2 || !hasAction(res, ActRespawned, "a") || claimToken(h.item("a")) != "" {
		t.Fatalf("result=%+v launches=%d", res, h.spawn.n)
	}
}

func TestOverlappingStepsClaimOnlyOneRecoverySpawn(t *testing.T) {
	h, _ := recoveryFixture(t)
	h.spawn.during = func() {
		if claimToken(h.item("pr-1")) == "" {
			t.Fatal("recovery has no claim")
		}
		if res := h.step(); hasAction(res, ActRecoverySpawn, "") {
			t.Fatalf("overlap launched recovery: %+v", res)
		}
	}
	res := h.step()
	if h.spawn.n != 1 || !hasAction(res, ActRecoverySpawn, "pr-1") || !h.has("ab12-fix") {
		t.Fatalf("result=%+v launches=%d", res, h.spawn.n)
	}
}

func TestRecoveryAndRespawnAttachFailuresAreAdopted(t *testing.T) {
	for _, kind := range []string{"recovery", "respawn"} {
		t.Run(kind, func(t *testing.T) {
			var h *harness
			owner, action, wantLaunches := "pr-1", ActRecoverySpawn, 1
			if kind == "recovery" {
				h, _ = recoveryFixture(t)
			} else {
				h = newHarness(t)
				repo := newRepo(t, "repo")
				h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
				h.step()
				owner, action, wantLaunches = "a", ActRespawned, 2
			}
			h.spawn.afterOpened = func(res SpawnResult) {
				if operator.ScopeString(claimOf(h.item(owner)), "pane") != res.PaneID {
					t.Fatal("pane not durably recorded")
				}
				h.panes.panes[res.PaneID] = operator.PaneInfo{PaneID: res.PaneID}
				readOnlyState(t, h)
			}
			res := h.step()
			if hasAction(res, action, owner) || !hasEscalation(res, "attaching the pane failed") {
				t.Fatalf("failed attach acknowledged: %+v", res)
			}
			restoreStateWrites(t, h)
			h.spawn.afterOpened = nil
			res = h.step()
			if h.spawn.n != wantLaunches || !hasAction(res, action, owner) || claimToken(h.item(owner)) != "" {
				t.Fatalf("adoption=%+v launches=%d", res, h.spawn.n)
			}
			if kind == "recovery" && (!h.has("ab12-fix") || operator.ScopeString(h.item(owner).Scope, scopeFixItem) != "ab12-fix") {
				t.Fatal("recovery adoption did not commit both links")
			}
		})
	}
}

type faultPanes struct {
	Panes
	snapshotErr error
	send        func() error
	pidErr      error
}

func (p faultPanes) Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error) {
	if p.snapshotErr != nil {
		return nil, p.snapshotErr
	}
	return p.Panes.Snapshot(ctx)
}
func (p faultPanes) Send(ctx context.Context, pane, text string) error {
	if p.send != nil {
		return p.send()
	}
	return p.Panes.Send(ctx, pane, text)
}
func (p faultPanes) PID(ctx context.Context, pane string) (int, error) {
	if p.pidErr != nil {
		return 0, p.pidErr
	}
	return p.Panes.PID(ctx, pane)
}

type faultSpawner struct {
	Spawner
	spawn      func(context.Context, SpawnRequest) (SpawnResult, error)
	cleanupErr error
}

func (f faultSpawner) Spawn(ctx context.Context, req SpawnRequest) (SpawnResult, error) {
	if f.spawn != nil {
		return f.spawn(ctx, req)
	}
	return f.Spawner.Spawn(ctx, req)
}
func (f faultSpawner) Worktree(ctx context.Context, repo, branch string) (string, func() error, error) {
	path, cleanup, err := f.Spawner.Worktree(ctx, repo, branch)
	if err != nil {
		return "", nil, err
	}
	return path, func() error {
		if f.cleanupErr != nil {
			return f.cleanupErr
		}
		return cleanup()
	}, nil
}

func TestPaneSnapshotErrorsNeverLaunchRecovery(t *testing.T) {
	h, pr := recoveryFixture(t)
	h.env.Panes = faultPanes{Panes: h.panes, snapshotErr: errors.New("snapshot unavailable")}
	e := newEngine(h.env)
	e.ciFailed(context.Background(), h.state(), h.item("pr-1"), prView{HeadRefOid: pr.HeadOid}, pr.Checks[0])
	assertEscalationNote(t, h, e.res, "pr-1", "snapshot unavailable")
	if h.spawn.n != 0 || claimToken(h.item("pr-1")) != "" || operator.ScopeString(h.item("pr-1").Scope, scopeRecovery) != "" {
		t.Fatal("failed snapshot consumed recovery")
	}
	if err := e.respawnDead(context.Background(), h.state()); err == nil {
		t.Fatal("respawn swallowed snapshot error")
	}
	if _, err := Step(context.Background(), h.env); err == nil {
		t.Fatal("step swallowed completion snapshot error")
	}
}

func TestBusyRecoveryRollbackFailureKeepsRoundPending(t *testing.T) {
	h, _ := recoveryFixture(t)
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "ab12"}
	h.env.Panes = faultPanes{Panes: h.panes, send: func() error { readOnlyState(t, h); return ErrPaneBusy }}
	res := h.step()
	if !hasEscalation(res, "busy recovery rollback failed") || claimToken(h.item("pr-1")) == "" || hasAction(res, ActRecoverySent, "") {
		t.Fatalf("result=%+v", res)
	}
	restoreStateWrites(t, h)
	h.env.Panes = h.panes
	h.step()
	if len(h.panes.sent) != 0 || scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatal("pending request consumed a fix round")
	}
	h.clock = h.clock.Add(recoveryWindow + time.Minute)
	h.step() // Expired pending send rolls back, rather than halting a spent round.
	h.step()
	if len(h.panes.sent) != 1 || scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatal("undelivered round did not recover")
	}
}

func TestPrelaunchRollbackWriteFailuresKeepClaims(t *testing.T) {
	for _, kind := range []string{"spawn", "respawn", "recovery"} {
		t.Run(kind, func(t *testing.T) {
			var h *harness
			owner := "a"
			if kind == "recovery" {
				h, _ = recoveryFixture(t)
				owner = "pr-1"
			} else {
				h = newHarness(t)
				repo := newRepo(t, "repo")
				h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
				if kind == "respawn" {
					h.step()
				}
			}
			calls := 0
			h.env.Spawn = faultSpawner{Spawner: h.spawn, spawn: func(context.Context, SpawnRequest) (SpawnResult, error) {
				calls++
				readOnlyState(t, h)
				return SpawnResult{}, errors.New("launcher failed")
			}}
			res := h.step()
			if !hasEscalation(res, "claim rollback failed") || claimToken(h.item(owner)) == "" {
				t.Fatalf("rollback not reported: %+v", res)
			}
			restoreStateWrites(t, h)
			h.step()
			if calls != 1 {
				t.Fatal("rollback failure allowed another launch")
			}
		})
	}
}

func TestRecoveryDeliveryWriteFailureKeepsPendingClaim(t *testing.T) {
	h, _ := recoveryFixture(t)
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "ab12"}
	h.panes.onSend = func(string, string) { readOnlyState(t, h) }
	res := h.step()
	if !hasEscalation(res, "CI fix delivery completion not written") || hasAction(res, ActRecoverySent, "") || claimToken(h.item("pr-1")) == "" {
		t.Fatalf("result=%+v", res)
	}
	restoreStateWrites(t, h)
	h.panes.onSend = nil
	h.step()
	if len(h.panes.sent) != 1 {
		t.Fatal("pending send repeated before reconciliation")
	}
}

func TestFixRoundCleanupWriteFailureIsAtomic(t *testing.T) {
	h, _ := recoveryFixture(t)
	h.step()
	head := h.item("pr-1")
	readOnlyState(t, h)
	e := newEngine(h.env)
	if e.resolveFixRound(head, "fixed-head", []checkRun{{State: "SUCCESS"}}) || !hasEscalation(e.res, "fix round cleanup not written") {
		t.Fatalf("cleanup=%+v", e.res)
	}
	if !h.has("ab12-fix") || operator.ScopeString(h.item(head.ID).Scope, scopeFixItem) != "ab12-fix" {
		t.Fatal("partial cleanup")
	}
	restoreStateWrites(t, h)
	if !e.resolveFixRound(head, "fixed-head", []checkRun{{State: "SUCCESS"}}) || h.has("ab12-fix") || operator.ScopeString(h.item(head.ID).Scope, scopeFixItem) != "" {
		t.Fatal("cleanup did not retry atomically")
	}
}

func TestObservationFailureDoesNotDriveMerge(t *testing.T) {
	h, pr, head := armFixture(t)
	e := newEngine(h.env)
	if err := e.setScope(head.ID, map[string]interface{}{scopeDeferred: false}); err != nil {
		t.Fatal(err)
	}
	h.run.on("gh pr view 1", func(dir string, argv []string) (string, error) { readOnlyState(t, h); return h.gh.handle(dir, argv) })
	res := h.step()
	if !hasEscalation(res, "PR observation not written") || pr.Armed || hasAction(res, ActArmed, "") {
		t.Fatalf("observation failure advanced: %+v", res)
	}
}

func TestStateReloadFailuresEscalate(t *testing.T) {
	h, _, head := armFixture(t)
	write(t, h.env.StatePath, "tracked: [broken")
	e := newEngine(h.env)
	var unreviewed []string
	e.advanceSeq(context.Background(), seqOf(head), &unreviewed)
	if !hasEscalation(e.res, "state load failed") {
		t.Fatalf("reload hidden: %+v", e.res)
	}
}

func TestWorktreeCleanupFailureRetainsRecoverableClaim(t *testing.T) {
	h, _, head := armFixture(t)
	repo := operator.ScopeString(head.Scope, "repo")
	branch := operator.ScopeString(head.Scope, "branch")
	runGit(t, repo, "branch", branch, "main")
	h.env.Spawn = faultSpawner{Spawner: h.spawn, cleanupErr: errors.New("cleanup unavailable")}
	e := newEngine(h.env)
	e.conflicting(context.Background(), h.state(), head, prView{})
	if !hasEscalation(e.res, "worktree cleanup failed") || claimToken(h.item(head.ID)) == "" {
		t.Fatalf("cleanup ownership lost: %+v", e.res)
	}
	path := operator.ScopeString(claimOf(h.item(head.ID)), "worktree")
	if path == "" {
		t.Fatal("worktree not recorded")
	}
	h.env.Spawn = h.spawn
	h.clock = h.clock.Add(spawnClaimTTL + time.Minute)
	e = newEngine(h.env)
	e.reconcileClaim(context.Background(), h.item(head.ID))
	if claimToken(h.item(head.ID)) != "" {
		t.Fatal("expired worktree claim not reconciled")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("claimed worktree remains: %v", err)
	}
}

func TestClaimReleaseWriteFailureEscalates(t *testing.T) {
	h, _, head := armFixture(t)
	e := newEngine(h.env)
	claimed, ok, err := e.claimWork(head.ID, h.state(), claimStacked, "", nil)
	if err != nil || !ok {
		t.Fatalf("claim=%v %v", ok, err)
	}
	readOnlyState(t, h)
	e.finishWorkClaim(claimed)
	if !hasEscalation(e.res, "operation claim release failed") || claimToken(h.item(head.ID)) == "" {
		t.Fatalf("release failure lost: %+v", e.res)
	}
}

func TestPaneFingerprintFailureIsReportedWithAttachedPane(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	h.env.Panes = faultPanes{Panes: h.panes, pidErr: errors.New("PID unavailable")}
	res := h.step()
	assertEscalationNote(t, h, res, "a", "PID unavailable")
	if operator.ScopeString(h.item("a").Scope, "pane") == "" {
		t.Fatal("fingerprint failure lost pane ownership")
	}
}

func TestMergeRepoFilterValidation(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	other := newRepo(t, "other")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	for _, path := range []string{"relative", filepath.Join(t.TempDir(), "missing"), t.TempDir(), other.Dir} {
		res, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: path})
		var invalid *InvalidError
		if !errors.As(err, &invalid) || len(res.Actions) != 0 {
			t.Fatalf("filter=%q result=%+v error=%v", path, res, err)
		}
	}
	if h.run.called("gh pr merge") != 0 {
		t.Fatal("invalid filter acted")
	}
}

func TestAlreadyDisabledStopConverges(t *testing.T) {
	for _, message := range []string{"auto-merge is already disabled", "Pull request Auto merge is not currently enabled", "auto-merge is not enabled"} {
		t.Run(message, func(t *testing.T) {
			h, _, head := armFixture(t)
			armOnce(t, h, head)
			h.run.fail("gh pr merge --disable-auto", message)
			res, err := Stop(context.Background(), h.env)
			if err != nil || !hasAction(res, ActDisarmed, head.ID) || scopeBool(h.item(head.ID), scopeArmed) {
				t.Fatalf("stop=%+v err=%v", res, err)
			}
			count := h.run.called("gh pr merge --disable-auto")
			_, err = Stop(context.Background(), h.env)
			if err != nil || count != h.run.called("gh pr merge --disable-auto") {
				t.Fatal("converged stop called GitHub again")
			}
		})
	}
}

func TestAlreadyAppliedReadyArmAndRetarget(t *testing.T) {
	h, _, head := armFixture(t)
	repo := operator.ScopeString(head.Scope, "repo")
	h.run.fail("gh pr ready", "Pull request is already ready for review")
	h.run.fail("gh pr merge --auto", "auto-merge is already enabled")
	h.run.fail("gh pr edit", "Base branch was not changed")
	e := newEngine(h.env)
	view := prView{IsDraft: true}
	if !e.readyDraft(context.Background(), head, &view) || view.IsDraft {
		t.Fatal("ready did not converge")
	}
	e.arm(context.Background(), h.state(), head, view)
	if !scopeBool(h.item(head.ID), scopeArmed) || !hasAction(e.res, ActArmed, head.ID) {
		t.Fatal("arm did not converge")
	}
	if err := e.retarget(context.Background(), repo, "1", "main"); err != nil {
		t.Fatal(err)
	}
	if err := e.retarget(context.Background(), repo, "1", "wrong-base"); err == nil {
		t.Fatal("retarget accepted a different base")
	}
	for _, op := range []string{"ready", "arm", "disarm", "merge"} {
		if alreadyApplied(errors.New("HTTP 502: action may already have completed"), op) {
			t.Fatalf("%s classified an uncertain outcome as success", op)
		}
	}
	if len(e.res.Escalations) != 0 {
		t.Fatalf("idempotent outcomes escalated: %+v", e.res)
	}
}

func TestStaleRecoverySnapshotCannotClaim(t *testing.T) {
	h, pr := recoveryFixture(t)
	st := h.state()
	head := h.item("pr-1")
	e := newEngine(h.env)
	if err := e.patch(head.ID, func(it *operator.TrackedItem) { it.Scope[scopeHalted] = true }); err != nil {
		t.Fatal(err)
	}
	e.recoverySpawn(context.Background(), st, head, operator.ScopeString(head.Scope, "repo"), "ab12", "fix", pr.HeadOid)
	if h.spawn.n != 0 || claimToken(h.item(head.ID)) != "" {
		t.Fatal("stale recovery launched")
	}
}

func TestEscalationNoteWriteFailureIsVisible(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	readOnlyState(t, h)
	e := newEngine(h.env)
	e.escalate("a", "operation failed")
	if len(e.res.Escalations) != 2 || !strings.Contains(e.res.Escalations[1].Reason, "note not written") {
		t.Fatalf("note failure hidden: %+v", e.res)
	}
}

func TestArmRollbackWriteFailureRetainsMarker(t *testing.T) {
	h, _, head := armFixture(t)
	h.run.on("gh pr merge --auto", func(_ string, argv []string) (string, error) {
		readOnlyState(t, h)
		return "", ghErr(argv, "Pull request is not in the correct state to enable auto-merge")
	})
	res := armOnce(t, h, head)
	if !hasEscalation(res, "armed marker could not be cleared") || !scopeBool(h.item(head.ID), scopeArmed) || hasAction(res, ActArmed, "") {
		t.Fatalf("rollback=%+v", res)
	}
}

func TestAlreadyAbortedCleanupConverges(t *testing.T) {
	if !alreadyApplied(errors.New("fatal: no rebase in progress"), "rebase-abort") || !alreadyApplied(errors.New("error: no cherry-pick or revert in progress"), "cherry-pick-abort") {
		t.Fatal("completed abort rejected")
	}
	if alreadyApplied(errors.New("fatal: cannot open .git/rebase-merge"), "rebase-abort") {
		t.Fatal("filesystem failure mistaken for completed abort")
	}
}

func TestPaneRecordFailureClosesUnownedWindow(t *testing.T) {
	for _, closeFails := range []bool{false, true} {
		closed := false
		err := persistOpened(SpawnRequest{Opened: func(SpawnResult) error { return errors.New("state write failed") }}, SpawnResult{PaneID: "%12"}, func() error {
			closed = true
			if closeFails {
				return errors.New("tmux unavailable")
			}
			return nil
		})
		if !closed || err == nil || !strings.Contains(err.Error(), "%12") || !strings.Contains(err.Error(), "state write failed") {
			t.Fatalf("ownership failure not compensated: %v", err)
		}
		if closeFails && !strings.Contains(err.Error(), "window rollback failed") {
			t.Fatalf("cleanup failure hidden: %v", err)
		}
	}
}
