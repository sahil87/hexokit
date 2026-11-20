package snapshot

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"rk/internal/tmux"
)

// fakeSource is a mutable ServerSource for snapshotter tests.
type fakeSource struct {
	mu   sync.Mutex
	gens map[string]int64
}

func newFakeSource() *fakeSource { return &fakeSource{gens: map[string]int64{}} }

func (f *fakeSource) Sockets() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.gens))
	for s := range f.gens {
		out = append(out, s)
	}
	return out
}

func (f *fakeSource) Generation(name string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gens[name]
}

func (f *fakeSource) set(name string, gen int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gens[name] = gen
}

// countingCapture returns a captureFunc yielding a snapshot whose content is
// derived from the server's current generation (so generation bumps change
// content) and counts invocations.
type countingCapture struct {
	mu    sync.Mutex
	calls int
	src   *fakeSource
}

func (c *countingCapture) fn(ctx context.Context, server string) (*Snapshot, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	gen := c.src.Generation(server)
	return &Snapshot{
		Server:  server,
		TakenAt: time.Now().UTC(),
		Sessions: []Session{{
			Name:      "s",
			CreatedAt: gen, // content varies with generation
			Windows:   []Window{{Index: 1, ID: "@1", Name: "w"}},
		}},
	}, nil
}

func (c *countingCapture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// newTestSnapshotter builds a snapshotter with tiny intervals over a temp
// store. The tick loop is driven manually via tick() for determinism.
func newTestSnapshotter(t *testing.T, src *fakeSource) (*Snapshotter, *countingCapture, *Store) {
	t.Helper()
	store := NewStore(t.TempDir())
	cap := &countingCapture{src: src}
	s := NewSnapshotter(src, store)
	s.capture = cap.fn
	s.checkInterval = time.Millisecond
	s.safetyInterval = time.Hour // safety disabled unless a test moves the clock
	// Neutralize the per-tick git-info stamp for capture-focused tests: no live
	// tmux exists behind a fakeSource, so return no panes and stamp nothing.
	// Stamp-specific tests override these seams.
	s.listPanes = func(context.Context, string) (map[string][]tmux.LayoutPane, error) { return nil, nil }
	s.resolveBranches = func(context.Context, []string) map[string]string { return nil }
	s.setPaneOption = func(context.Context, string, string, string, string) error { return nil }
	return s, cap, store
}

func TestSnapshotterFirstObservationSnapshotsImmediately(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, store := newTestSnapshotter(t, src)

	s.tick(context.Background())
	if cap.count() != 1 {
		t.Fatalf("capture calls = %d, want 1", cap.count())
	}
	snap, err := store.LoadLatest("kit")
	if err != nil || snap == nil {
		t.Fatalf("latest missing after first tick: %v %v", snap, err)
	}
}

func TestSnapshotterDebounceCoalescesBursts(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, _ := newTestSnapshotter(t, src)
	s.tick(context.Background()) // first observation write
	if cap.count() != 1 {
		t.Fatalf("setup capture calls = %d", cap.count())
	}

	// Burst: generation moves on every tick — no write while churning.
	for gen := int64(2); gen <= 5; gen++ {
		src.set("kit", gen)
		s.tick(context.Background())
	}
	if cap.count() != 1 {
		t.Fatalf("captures during churn = %d, want still 1", cap.count())
	}

	// Quiescence: one stable tick → exactly one write.
	s.tick(context.Background())
	if cap.count() != 2 {
		t.Fatalf("captures after quiescence = %d, want 2", cap.count())
	}
	// Further quiet ticks (safety not due) → no more writes.
	s.tick(context.Background())
	s.tick(context.Background())
	if cap.count() != 2 {
		t.Fatalf("captures after quiet ticks = %d, want 2", cap.count())
	}
}

func TestSnapshotterMaxHoldBoundsContinuousChurn(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, _ := newTestSnapshotter(t, src)

	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.maxHold = 10 * time.Second

	s.tick(context.Background()) // first observation
	if cap.count() != 1 {
		t.Fatal("setup")
	}

	// Generation moves on EVERY tick (continuous churn) — quiescence never
	// arrives, but maxHold forces a write once the dirty window exceeds it.
	gen := int64(1)
	for i := 0; i < 4; i++ {
		gen++
		src.set("kit", gen)
		now = now.Add(2 * time.Second)
		s.tick(context.Background())
	}
	if cap.count() != 1 {
		t.Fatalf("captures before maxHold = %d, want 1", cap.count())
	}
	gen++
	src.set("kit", gen)
	now = now.Add(5 * time.Second) // dirty since t0+2s → 11s > maxHold
	s.tick(context.Background())
	if cap.count() != 2 {
		t.Fatalf("captures after maxHold = %d, want 2", cap.count())
	}
}

func TestSnapshotterSafetyPassAndDedup(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, store := newTestSnapshotter(t, src)

	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.safetyInterval = time.Minute

	s.tick(context.Background()) // first observation
	if cap.count() != 1 {
		t.Fatal("setup")
	}

	// Quiet server before the safety interval: no capture.
	now = now.Add(30 * time.Second)
	s.tick(context.Background())
	if cap.count() != 1 {
		t.Fatalf("capture before safety due = %d", cap.count())
	}

	// Safety due: capture runs, but identical content dedups (no history churn).
	now = now.Add(31 * time.Second)
	s.tick(context.Background())
	if cap.count() != 2 {
		t.Fatalf("capture at safety = %d, want 2", cap.count())
	}
	if ts, _ := store.historyTimestamps("kit"); len(ts) != 1 {
		t.Fatalf("history after dedup safety pass = %d, want 1", len(ts))
	}
}

func TestSnapshotterTombstoneOnRemovalWithAuditWindow(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, store := newTestSnapshotter(t, src)
	s.tick(context.Background())

	// Audited kill noted, then removal within the window.
	s.NoteAuditedKill("kit")
	s.OnServerRemoved("kit")

	if snap, _ := store.LoadLatest("kit"); snap != nil {
		t.Fatal("latest should be tombstoned away")
	}
	resolved, err := store.Resolve("kit", 0)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.DiedAt == nil || !resolved.AuditedKill {
		t.Errorf("tombstone = diedAt %v audited %v, want stamped+audited", resolved.DiedAt, resolved.AuditedKill)
	}
}

func TestSnapshotterTombstoneUnauditedAndExpiredWindow(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, store := newTestSnapshotter(t, src)

	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.tick(context.Background())

	// Audit note EXPIRES (older than the window) → unaudited tombstone.
	s.NoteAuditedKill("kit")
	now = now.Add(defaultAuditWindow + time.Second)
	s.OnServerRemoved("kit")

	resolved, err := store.Resolve("kit", 0)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.AuditedKill {
		t.Error("expired audit note must not mark the tombstone audited")
	}
	if resolved.DiedAt == nil || !resolved.DiedAt.Equal(now) {
		t.Errorf("diedAt = %v, want %v", resolved.DiedAt, now)
	}
}

func TestSnapshotterDropsStateForUncoveredServers(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, _ := newTestSnapshotter(t, src)
	s.tick(context.Background())

	s.mu.Lock()
	_, tracked := s.servers["kit"]
	s.mu.Unlock()
	if !tracked {
		t.Fatal("kit should be tracked after tick")
	}

	// Server disappears from the covered set (socket removed) — bookkeeping
	// dropped on the next tick.
	src.mu.Lock()
	delete(src.gens, "kit")
	src.mu.Unlock()
	s.tick(context.Background())

	s.mu.Lock()
	_, tracked = s.servers["kit"]
	s.mu.Unlock()
	if tracked {
		t.Error("kit bookkeeping should be dropped once uncovered")
	}
}

func TestSnapshotterCaptureFailureDegrades(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	store := NewStore(t.TempDir())
	s := NewSnapshotter(src, store)
	s.checkInterval = time.Millisecond
	s.capture = func(ctx context.Context, server string) (*Snapshot, error) {
		return nil, context.DeadlineExceeded
	}

	// Must not panic; nothing written.
	s.tick(context.Background())
	if snap, _ := store.LoadLatest("kit"); snap != nil {
		t.Error("failed capture must not write")
	}
}

func TestSnapshotterFailedCaptureRetriesNextTick(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	store := NewStore(t.TempDir())
	s := NewSnapshotter(src, store)
	s.safetyInterval = time.Hour // retry must come from the event path, not safety

	var calls, failures int
	s.capture = func(ctx context.Context, server string) (*Snapshot, error) {
		calls++
		if failures > 0 {
			failures--
			return nil, errors.New("transient capture failure")
		}
		return &Snapshot{
			Server:  server,
			TakenAt: time.Now().UTC(),
			Sessions: []Session{{
				Name:      "s",
				CreatedAt: src.Generation(server), // content varies with generation
				Windows:   []Window{{Index: 1, ID: "@1", Name: "w"}},
			}},
		}, nil
	}

	ctx := context.Background()
	s.tick(ctx) // first observation succeeds
	if calls != 1 {
		t.Fatalf("setup captures = %d, want 1", calls)
	}

	// Event: generation bumps, then the due (post-debounce) capture FAILS.
	failures = 1
	src.set("kit", 2)
	s.tick(ctx) // dirty, not yet stable → no capture
	s.tick(ctx) // stable → due → capture fails
	if calls != 2 {
		t.Fatalf("captures after failed pass = %d, want 2", calls)
	}

	// The failure must NOT be bookkept as written: the very next tick retries
	// (were writtenGen advanced on failure, this would park until safety).
	s.tick(ctx)
	if calls != 3 {
		t.Fatalf("captures after retry tick = %d, want 3 (failed capture not retried)", calls)
	}
	latest, err := store.LoadLatest("kit")
	if err != nil || latest == nil {
		t.Fatalf("latest after retry: %v %v", latest, err)
	}
	if latest.Sessions[0].CreatedAt != 2 {
		t.Errorf("latest content generation = %d, want 2", latest.Sessions[0].CreatedAt)
	}
}

func TestSnapshotterRemovalMidCaptureDropsWrite(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	store := NewStore(t.TempDir())

	// Seed a good latest so the tombstone has real content to preserve.
	seed := &Snapshot{
		Server:  "kit",
		TakenAt: time.Now().UTC(),
		Sessions: []Session{{
			Name:      "s",
			CreatedAt: 100,
			Windows:   []Window{{Index: 1, ID: "@1", Name: "good"}},
		}},
	}
	if _, err := store.Write(seed); err != nil {
		t.Fatal(err)
	}

	s := NewSnapshotter(src, store)
	s.safetyInterval = time.Hour

	started := make(chan struct{})
	release := make(chan struct{})
	s.capture = func(ctx context.Context, server string) (*Snapshot, error) {
		close(started)
		<-release
		return &Snapshot{
			Server:  server,
			TakenAt: time.Now().UTC(),
			Sessions: []Session{{
				Name:      "s",
				CreatedAt: 200,
				Windows:   []Window{{Index: 1, ID: "@1", Name: "stale"}},
			}},
		}, nil
	}

	done := make(chan struct{})
	go func() {
		s.tick(context.Background()) // first observation → capture in flight
		close(done)
	}()
	<-started
	s.OnServerRemoved("kit") // tombstones the seeded latest, bumps the epoch
	close(release)
	<-done

	// The in-flight capture must be dropped — never resurrect a "live" latest
	// for a dead server.
	if snap, _ := store.LoadLatest("kit"); snap != nil {
		t.Fatalf("post-removal write resurrected a latest: %+v", snap)
	}
	resolved, err := store.Resolve("kit", 0)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.DiedAt == nil {
		t.Error("tombstone missing diedAt")
	}
	if resolved.Sessions[0].Windows[0].Name != "good" {
		t.Errorf("tombstone content = %+v, want the pre-death snapshot", resolved.Sessions[0].Windows[0])
	}
}

func TestSnapshotterStartStopsWithContext(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, _ := newTestSnapshotter(t, src)

	// Start is `go s.run(ctx)`; running the loop here gives the test a join
	// point. Returning while a tick is still writing into the store's
	// t.TempDir races the TempDir cleanup ("directory not empty").
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.run(ctx)
		close(done)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for cap.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ticker loop did not stop after context cancel")
	}
	if cap.count() == 0 {
		t.Fatal("ticker loop never captured before deadline")
	}
}

// fakeEphemeral is a mutable ephemeralFunc with an invocation counter, so
// tests can prove reads happen only at due passes.
type fakeEphemeral struct {
	mu      sync.Mutex
	marked  map[string]bool
	calls   int
	failFor map[string]error
}

func newFakeEphemeral() *fakeEphemeral {
	return &fakeEphemeral{marked: map[string]bool{}}
}

func (f *fakeEphemeral) fn(_ context.Context, server string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if err := f.failFor[server]; err != nil {
		return false, err
	}
	return f.marked[server], nil
}

func (f *fakeEphemeral) mark(server string, marked bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.marked[server] = marked
}

func (f *fakeEphemeral) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestSnapshotterEphemeralSkipsWritesAndRetires(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, store := newTestSnapshotter(t, src)
	eph := newFakeEphemeral()
	s.ephemeral = eph.fn

	// Pin the clock BEFORE the first tick: bookkeeping (lastPass) must be
	// stamped on the pinned timeline, or the later advance computes a
	// negative elapsed against real wall time and the safety pass is never
	// due (the fixed date sits in the past once the calendar passes it).
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.safetyInterval = time.Minute

	// First observation lands a latest before the mark is set.
	s.tick(context.Background())
	if cap.count() != 1 {
		t.Fatalf("setup captures = %d, want 1", cap.count())
	}
	if snap, _ := store.LoadLatest("kit"); snap == nil {
		t.Fatal("setup latest missing")
	}

	// Mark the server ephemeral; the next due pass (safety) must retire the
	// lingering latest and capture nothing.
	eph.mark("kit", true)
	now = now.Add(2 * time.Minute)
	s.tick(context.Background())

	if cap.count() != 1 {
		t.Errorf("captures after mark = %d, want still 1 (no capture for marked server)", cap.count())
	}
	if snap, _ := store.LoadLatest("kit"); snap != nil {
		t.Error("lingering latest should be retired once the mark is observed")
	}
	// Retire is NOT a tombstone.
	if ts, _ := store.tombstoneTimestamps("kit"); len(ts) != 0 {
		t.Errorf("tombstones after retire = %v, want none", ts)
	}

	// Bookkeeping advanced on the skip: further quiet ticks do NOT re-read
	// the option (the safety cadence bounds un-mark detection).
	reads := eph.count()
	s.tick(context.Background())
	s.tick(context.Background())
	if eph.count() != reads {
		t.Errorf("ephemeral re-read on quiet ticks: reads %d → %d, want no per-tick read", reads, eph.count())
	}
}

func TestSnapshotterUnmarkResumesCoverage(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, store := newTestSnapshotter(t, src)
	eph := newFakeEphemeral()
	s.ephemeral = eph.fn

	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.safetyInterval = time.Minute

	// Marked from the start: first observation skips, nothing is written.
	eph.mark("kit", true)
	s.tick(context.Background())
	if cap.count() != 0 {
		t.Fatalf("captures for marked first observation = %d, want 0", cap.count())
	}
	if snap, _ := store.LoadLatest("kit"); snap != nil {
		t.Fatal("marked server must not get a latest")
	}

	// Un-mark; the next safety-due pass resumes coverage with no other action.
	eph.mark("kit", false)
	now = now.Add(2 * time.Minute)
	s.tick(context.Background())
	if cap.count() != 1 {
		t.Fatalf("captures after un-mark = %d, want 1", cap.count())
	}
	if snap, _ := store.LoadLatest("kit"); snap == nil {
		t.Fatal("coverage should resume after un-mark")
	}
}

func TestSnapshotterEphemeralReadErrorDegradesToDurable(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, cap, store := newTestSnapshotter(t, src)
	eph := newFakeEphemeral()
	eph.failFor = map[string]error{"kit": errors.New("transient read failure")}
	s.ephemeral = eph.fn

	// A failed read must not crash the tick and must not skip the snapshot:
	// coverage is the safer default.
	s.tick(context.Background())
	if cap.count() != 1 {
		t.Fatalf("captures after read error = %d, want 1", cap.count())
	}
	if snap, _ := store.LoadLatest("kit"); snap == nil {
		t.Fatal("read error should degrade to durable — snapshot expected")
	}
}

// paneOptionRecorder records SetPaneOption calls behind the snapshotter's
// setPaneOption seam.
type paneOptionRecorder struct {
	mu    sync.Mutex
	calls []struct{ paneID, option, value string }
	// fail: options for which fn returns an error (the attempt is still
	// recorded). Lets a test drive the failed-write-retries path.
	fail map[string]bool
}

func (r *paneOptionRecorder) fn(_ context.Context, paneID, _ /*server*/, option, value string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, struct{ paneID, option, value string }{paneID, option, value})
	if r.fail[option] {
		return errors.New("injected set-option failure")
	}
	return nil
}

// setFail toggles injected failure for one option.
func (r *paneOptionRecorder) setFail(option string, on bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail == nil {
		r.fail = map[string]bool{}
	}
	r.fail[option] = on
}

func (r *paneOptionRecorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = nil
}

func (r *paneOptionRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

// countFor returns how many recorded writes targeted the given option.
func (r *paneOptionRecorder) countFor(option string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, c := range r.calls {
		if c.option == option {
			n++
		}
	}
	return n
}

// TestSnapshotterStampGitInfoOnlyOnChange proves the only-on-change write gate:
// a second tick with identical derived values issues zero set-option calls, and
// a branch change re-stamps only the branch option.
func TestSnapshotterStampGitInfoOnlyOnChange(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, _ := newTestSnapshotter(t, src)

	rec := &paneOptionRecorder{}
	s.setPaneOption = rec.fn
	s.listPanes = func(context.Context, string) (map[string][]tmux.LayoutPane, error) {
		return map[string][]tmux.LayoutPane{"@1": {{PaneID: "%1", Cwd: "/home/user/proj"}}}, nil
	}
	branch := "main"
	s.resolveBranches = func(context.Context, []string) map[string]string {
		return map[string]string{"/home/user/proj": branch}
	}

	// First tick stamps the changed (non-empty) options at least once.
	s.tick(context.Background())
	if rec.count() == 0 {
		t.Fatal("first tick issued no set-option calls, want the initial stamp")
	}
	if rec.countFor(tmux.PaneGitBranchOption) != 1 {
		t.Errorf("first tick branch writes = %d, want 1", rec.countFor(tmux.PaneGitBranchOption))
	}

	// Second tick with identical derived values: only-on-change gate → zero writes.
	rec.reset()
	s.tick(context.Background())
	if got := rec.count(); got != 0 {
		t.Errorf("identical second tick issued %d set-option calls, want 0", got)
	}

	// A branch change re-stamps only the branch option.
	rec.reset()
	branch = "feat-x"
	s.tick(context.Background())
	if rec.count() != 1 || rec.countFor(tmux.PaneGitBranchOption) != 1 {
		t.Errorf("branch-change tick calls = %d (branch %d), want exactly 1 branch write",
			rec.count(), rec.countFor(tmux.PaneGitBranchOption))
	}
}

// TestSnapshotterStampGitInfoRetriesFailedWrite proves a set-option write that
// fails is NOT recorded as stamped: the next tick re-attempts exactly that
// option, and once it succeeds the only-on-change gate goes quiet again.
func TestSnapshotterStampGitInfoRetriesFailedWrite(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, _ := newTestSnapshotter(t, src)

	rec := &paneOptionRecorder{}
	s.setPaneOption = rec.fn
	s.listPanes = func(context.Context, string) (map[string][]tmux.LayoutPane, error) {
		return map[string][]tmux.LayoutPane{"@1": {{PaneID: "%1", Cwd: "/home/user/proj"}}}, nil
	}
	s.resolveBranches = func(context.Context, []string) map[string]string {
		return map[string]string{"/home/user/proj": "main"}
	}

	// Branch writes fail. Tick 1 attempts the branch write (and lands pathtail).
	rec.setFail(tmux.PaneGitBranchOption, true)
	s.tick(context.Background())
	if rec.countFor(tmux.PaneGitBranchOption) != 1 {
		t.Fatalf("tick 1 branch writes = %d, want 1 (attempted)", rec.countFor(tmux.PaneGitBranchOption))
	}

	// Tick 2 (still failing): the failed branch is NOT cached, so it retries;
	// pathtail succeeded on tick 1, so it is NOT rewritten.
	rec.reset()
	s.tick(context.Background())
	if rec.countFor(tmux.PaneGitBranchOption) != 1 {
		t.Errorf("tick 2 branch retries = %d, want 1", rec.countFor(tmux.PaneGitBranchOption))
	}
	if got := rec.countFor(tmux.PanePathTailOption); got != 0 {
		t.Errorf("tick 2 pathtail writes = %d, want 0 (already stamped ok)", got)
	}

	// Writes recover: tick 3 lands the branch and commits it.
	rec.reset()
	rec.setFail(tmux.PaneGitBranchOption, false)
	s.tick(context.Background())
	if rec.countFor(tmux.PaneGitBranchOption) != 1 {
		t.Errorf("tick 3 branch writes = %d, want 1 (recovered)", rec.countFor(tmux.PaneGitBranchOption))
	}

	// Tick 4: everything stamped and unchanged → the gate goes quiet.
	rec.reset()
	s.tick(context.Background())
	if got := rec.count(); got != 0 {
		t.Errorf("tick 4 writes = %d, want 0 (branch now cached)", got)
	}
}

// TestSnapshotterStampGitInfoPrunesClosedPanes proves the last-stamped cache
// drops a pane once it disappears, keeping the cache bounded.
func TestSnapshotterStampGitInfoPrunesClosedPanes(t *testing.T) {
	src := newFakeSource()
	src.set("kit", 1)
	s, _, _ := newTestSnapshotter(t, src)
	s.setPaneOption = (&paneOptionRecorder{}).fn
	s.resolveBranches = func(context.Context, []string) map[string]string { return nil }

	panes := map[string][]tmux.LayoutPane{"@1": {{PaneID: "%1", Cwd: "/a/b"}, {PaneID: "%2", Cwd: "/c/d"}}}
	s.listPanes = func(context.Context, string) (map[string][]tmux.LayoutPane, error) { return panes, nil }
	s.tick(context.Background())

	s.stampMu.Lock()
	n := len(s.stamped["kit"])
	s.stampMu.Unlock()
	if n != 2 {
		t.Fatalf("after first tick, stamped panes = %d, want 2", n)
	}

	// %2 closes: the next tick sees only %1 and prunes %2.
	panes = map[string][]tmux.LayoutPane{"@1": {{PaneID: "%1", Cwd: "/a/b"}}}
	s.tick(context.Background())

	s.stampMu.Lock()
	_, has1 := s.stamped["kit"]["%1"]
	_, has2 := s.stamped["kit"]["%2"]
	n = len(s.stamped["kit"])
	s.stampMu.Unlock()
	if !has1 || has2 || n != 1 {
		t.Errorf("after prune tick: has1=%v has2=%v n=%d, want has1=true has2=false n=1", has1, has2, n)
	}
}
