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

// readOnlyState makes the state directory unwritable until the test ends, so
// every durable write of the pass fails.
func readOnlyState(t *testing.T, h *harness) {
	t.Helper()
	dir := filepath.Dir(h.env.StatePath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
}

// restoreStateWrites makes the state directory writable again mid-test.
func restoreStateWrites(t *testing.T, h *harness) {
	t.Helper()
	if err := os.Chmod(filepath.Dir(h.env.StatePath), 0o700); err != nil {
		t.Fatal(err)
	}
}

// execOne runs one decision through the executors.
func execOne(t *testing.T, e *engine, d Decision) {
	t.Helper()
	if err := e.execute(context.Background(), []Decision{d}); err != nil {
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

func TestStateReloadFailuresEscalate(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	write(t, h.env.StatePath, "tracked: [broken")
	e := newEngine(h.env)
	if _, _, err := e.observe(context.Background()); err == nil || !hasEscalation(e.res, "state load failed") {
		t.Fatalf("reload hidden: err=%v %+v", err, e.res)
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

func TestAlreadyAbortedCleanupConverges(t *testing.T) {
	if !noCherryPickInProgress(errors.New("error: no cherry-pick or revert in progress")) {
		t.Fatal("completed abort rejected")
	}
	if noCherryPickInProgress(errors.New("fatal: cannot open .git/CHERRY_PICK_HEAD")) {
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
