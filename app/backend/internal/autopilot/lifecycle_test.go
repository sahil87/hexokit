package autopilot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operator"
)

func restoreStateWrites(t *testing.T, h *harness) {
	t.Helper()
	if err := os.Chmod(filepath.Dir(h.env.StatePath), 0700); err != nil {
		t.Fatal(err)
	}
}

type faultPanes struct {
	Panes
	snapshotErr error
	pidErr      error
}

func (p faultPanes) Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error) {
	if p.snapshotErr != nil {
		return nil, p.snapshotErr
	}
	return p.Panes.Snapshot(ctx)
}
func (p faultPanes) PID(ctx context.Context, pane string) (int, error) {
	if p.pidErr != nil {
		return 0, p.pidErr
	}
	return p.Panes.PID(ctx, pane)
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

func TestAlreadyAppliedReadyAndArm(t *testing.T) {
	h, _, head := armFixture(t)
	h.run.fail("gh pr ready", "Pull request is already ready for review")
	h.run.fail("gh pr merge --auto", "auto-merge is already enabled")
	e := newEngine(h.env)
	view := prView{IsDraft: true}
	if !e.readyDraft(context.Background(), head, &view) || view.IsDraft {
		t.Fatal("ready did not converge")
	}
	e.arm(context.Background(), head, view)
	if !scopeBool(h.item(head.ID), scopeArmed) || !hasAction(e.res, ActArmed, head.ID) {
		t.Fatal("arm did not converge")
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
	if !alreadyApplied(errors.New("error: no cherry-pick or revert in progress"), "cherry-pick-abort") {
		t.Fatal("completed abort rejected")
	}
	if alreadyApplied(errors.New("fatal: cannot open .git/CHERRY_PICK_HEAD"), "cherry-pick-abort") {
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
