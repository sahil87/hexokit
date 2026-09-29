package snapshot

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testSnap(server string, takenAt time.Time, windowName string) *Snapshot {
	return &Snapshot{
		Server:  server,
		TakenAt: takenAt,
		Sessions: []Session{{
			Name:      "s1",
			CreatedAt: 100,
			Windows: []Window{{
				Index: 1, ID: "@1", Name: windowName,
				Panes: []Pane{{ID: "%0", Index: 0, Cwd: "/tmp", Command: "zsh"}},
			}},
		}},
	}
}

func TestDefaultDirXDGOverride(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(state, "hexokit", "snapshots") {
		t.Errorf("dir = %s", dir)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	dir, err = DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(home, ".local", "state", "hexokit", "snapshots") {
		t.Errorf("default dir = %s", dir)
	}
}

// TestMigrateLegacyDirMovesBackups: the legacy <state>/rk/snapshots tree is
// renamed into the resolved home dir intact (real store artifacts survive)
// and a MOVED-to-run-kit breadcrumb naming the new path is left behind.
func TestMigrateLegacyDirMovesBackups(t *testing.T) {
	state := t.TempDir()
	legacy := filepath.Join(state, "rk", "snapshots")
	if _, err := NewStore(legacy).Write(testSnap("srv", time.Now(), "work")); err != nil {
		t.Fatalf("seed legacy store: %v", err)
	}

	dir := filepath.Join(state, "hexokit", "snapshots")
	MigrateLegacyDir(dir)

	snap, err := NewStore(dir).LoadLatest("srv")
	if err != nil {
		t.Fatalf("LoadLatest from moved dir: %v", err)
	}
	if snap == nil || snap.Sessions[0].Windows[0].Name != "work" {
		t.Errorf("moved snapshot = %+v, want the legacy backup intact", snap)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Errorf("legacy dir still present after move: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(state, "rk", "MOVED-to-run-kit"))
	if err != nil {
		t.Fatalf("breadcrumb missing: %v", err)
	}
	if !strings.Contains(string(data), dir) {
		t.Errorf("breadcrumb %q does not name the new path %q", data, dir)
	}
}

// TestMigrateLegacyDirKeepsExistingTarget: when the new dir already exists the
// legacy dir is never merged into it or clobbered — no move, no breadcrumb.
func TestMigrateLegacyDirKeepsExistingTarget(t *testing.T) {
	state := t.TempDir()
	legacy := filepath.Join(state, "rk", "snapshots")
	dir := filepath.Join(state, "hexokit", "snapshots")
	for _, d := range []string{legacy, dir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, d := range map[string]string{"old.json": legacy, "new.json": dir} {
		if err := os.WriteFile(filepath.Join(d, name), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	MigrateLegacyDir(dir)

	if _, err := os.Stat(filepath.Join(legacy, "old.json")); err != nil {
		t.Errorf("legacy dir clobbered: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old.json")); !os.IsNotExist(err) {
		t.Error("legacy file merged into existing new dir")
	}
	if _, err := os.Stat(filepath.Join(state, "rk", "MOVED-to-run-kit")); !os.IsNotExist(err) {
		t.Error("breadcrumb written without a move")
	}
}

// TestMigrateLegacyDirNoLegacy: with no legacy dir the move is a silent no-op
// that creates nothing.
func TestMigrateLegacyDirNoLegacy(t *testing.T) {
	state := t.TempDir()
	MigrateLegacyDir(filepath.Join(state, "hexokit", "snapshots"))
	entries, err := os.ReadDir(state)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("state root gained entries: %v", entries)
	}
}

// TestMigrateLegacyDirFailureDegrades: when the move cannot happen (target
// parent obstructed by a regular file, so the rename can never land) the
// failure surfaces nothing — the legacy tree is left intact, no breadcrumb is
// written, and the store cold-starts at the new path once it can.
func TestMigrateLegacyDirFailureDegrades(t *testing.T) {
	state := t.TempDir()
	legacy := filepath.Join(state, "rk", "snapshots")
	if _, err := NewStore(legacy).Write(testSnap("srv", time.Now(), "work")); err != nil {
		t.Fatalf("seed legacy store: %v", err)
	}
	dir := filepath.Join(state, "hexokit", "snapshots")

	blocker := filepath.Join(state, "hexokit")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	MigrateLegacyDir(dir)

	if _, err := os.Stat(filepath.Join(legacy, "srv.json")); err != nil {
		t.Errorf("legacy backups lost on failed move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(state, "rk", "MOVED-to-run-kit")); !os.IsNotExist(err) {
		t.Error("breadcrumb written without a move")
	}

	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(dir).Write(testSnap("srv", time.Now(), "work")); err != nil {
		t.Fatalf("store cold start after failed move: %v", err)
	}
}

func TestWriteLatestHistoryAndDedup(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

	wrote, err := s.Write(testSnap("kit", base, "serve"))
	if err != nil || !wrote {
		t.Fatalf("first write: wrote=%v err=%v", wrote, err)
	}

	// Identical content, later timestamp → dedup skip (no latest rewrite, no
	// history entry).
	wrote, err = s.Write(testSnap("kit", base.Add(time.Minute), "serve"))
	if err != nil {
		t.Fatal(err)
	}
	if wrote {
		t.Error("identical-content write should dedup to a no-op")
	}
	if ts, _ := s.historyTimestamps("kit"); len(ts) != 1 {
		t.Errorf("history count after dedup = %d, want 1", len(ts))
	}

	// Changed content → latest replaced + history appended.
	wrote, err = s.Write(testSnap("kit", base.Add(2*time.Minute), "renamed"))
	if err != nil || !wrote {
		t.Fatalf("changed write: wrote=%v err=%v", wrote, err)
	}
	latest, err := s.LoadLatest("kit")
	if err != nil {
		t.Fatal(err)
	}
	if latest.Sessions[0].Windows[0].Name != "renamed" {
		t.Errorf("latest not replaced: %+v", latest.Sessions[0].Windows[0])
	}
	if ts, _ := s.historyTimestamps("kit"); len(ts) != 2 {
		t.Errorf("history count = %d, want 2", len(ts))
	}

	// History entries are loadable via LoadAt.
	at, err := s.LoadAt("kit", base.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if at.Sessions[0].Windows[0].Name != "serve" {
		t.Errorf("LoadAt returned wrong entry: %+v", at.Sessions[0].Windows[0])
	}
}

func TestWriteZeroSessionSnapshotSkipped(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	if _, err := s.Write(testSnap("kit", base, "serve")); err != nil {
		t.Fatal(err)
	}

	// The alive-but-empty floor case: the _rk-ctl anchor keeps the socket up
	// after the last user-facing session closes, so capture succeeds with zero
	// sessions. The write must be skipped — never overwrite a good latest.
	wrote, err := s.Write(&Snapshot{Server: "kit", TakenAt: base.Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if wrote {
		t.Error("zero-session write must be skipped")
	}
	latest, err := s.LoadLatest("kit")
	if err != nil {
		t.Fatal(err)
	}
	if latest == nil || len(latest.Sessions) != 1 || latest.Sessions[0].Windows[0].Name != "serve" {
		t.Errorf("good latest was clobbered: %+v", latest)
	}
	if ts, _ := s.historyTimestamps("kit"); len(ts) != 1 {
		t.Errorf("history churned on zero-session write: %d entries", len(ts))
	}

	// A zero-session write with no existing latest is skipped too.
	wrote, err = s.Write(&Snapshot{Server: "fresh", TakenAt: base})
	if err != nil || wrote {
		t.Errorf("fresh zero-session write: wrote=%v err=%v, want skip", wrote, err)
	}
	if latest, _ := s.LoadLatest("fresh"); latest != nil {
		t.Errorf("zero-session snapshot landed: %+v", latest)
	}
}

func TestWriteSameSecondHistoryCollisionBumpsForward(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

	// Two content-DIFFERENT writes within the same second: without the
	// collision guard the second would overwrite the first's history entry.
	if _, err := s.Write(testSnap("kit", base, "w1")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(testSnap("kit", base, "w2")); err != nil {
		t.Fatal(err)
	}

	ts, err := s.historyTimestamps("kit")
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 2 {
		t.Fatalf("history entries = %d, want 2 (same-second write clobbered)", len(ts))
	}
	if ts[0] != base.Unix() || ts[1] != base.Unix()+1 {
		t.Errorf("history timestamps = %v, want [%d %d]", ts, base.Unix(), base.Unix()+1)
	}
	first, err := s.LoadAt("kit", ts[0])
	if err != nil {
		t.Fatal(err)
	}
	if first.Sessions[0].Windows[0].Name != "w1" {
		t.Errorf("earlier entry clobbered: %+v", first.Sessions[0].Windows[0])
	}
	second, err := s.LoadAt("kit", ts[1])
	if err != nil {
		t.Fatal(err)
	}
	if second.Sessions[0].Windows[0].Name != "w2" {
		t.Errorf("bumped entry wrong: %+v", second.Sessions[0].Windows[0])
	}
}

func TestHistoryPruneToRetention(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	for i := 0; i < historyRetention+5; i++ {
		snap := testSnap("kit", base.Add(time.Duration(i)*time.Minute), "w"+strconv.Itoa(i))
		if _, err := s.Write(snap); err != nil {
			t.Fatal(err)
		}
	}
	ts, err := s.historyTimestamps("kit")
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != historyRetention {
		t.Errorf("history count = %d, want %d", len(ts), historyRetention)
	}
	// The oldest entries are the pruned ones.
	if ts[0] != base.Add(5*time.Minute).Unix() {
		t.Errorf("oldest surviving = %d, want %d", ts[0], base.Add(5*time.Minute).Unix())
	}
}

func TestTombstoneStampsAndRenames(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	if _, err := s.Write(testSnap("kit", base, "serve")); err != nil {
		t.Fatal(err)
	}

	died := base.Add(time.Hour)
	created, err := s.Tombstone("kit", died, true)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Error("Tombstone should report created=true when a latest existed")
	}

	// Latest is gone.
	if snap, err := s.LoadLatest("kit"); err != nil || snap != nil {
		t.Fatalf("latest should be gone: snap=%v err=%v", snap, err)
	}
	// Tombstone exists, stamped.
	tomb, err := s.LoadAt("kit", died.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if tomb.DiedAt == nil || !tomb.DiedAt.Equal(died) {
		t.Errorf("diedAt = %v, want %v", tomb.DiedAt, died)
	}
	if !tomb.AuditedKill {
		t.Error("auditedKill not stamped")
	}
	// Resolve falls back to the newest tombstone when no latest exists.
	resolved, err := s.Resolve("kit", 0)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.DiedAt == nil {
		t.Error("Resolve did not return the tombstone")
	}

	// Tombstoning a server with no latest is a no-op.
	created, err = s.Tombstone("ghost", died, false)
	if err != nil {
		t.Fatalf("no-latest tombstone should be a no-op: %v", err)
	}
	if created {
		t.Error("Tombstone should report created=false when no latest existed")
	}
}

func TestTombstonePruneToRetention(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	for i := 0; i < tombstoneRetention+3; i++ {
		if _, err := s.Write(testSnap("kit", base.Add(time.Duration(i)*time.Minute), "w"+strconv.Itoa(i))); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Tombstone("kit", base.Add(time.Duration(i)*time.Minute+30*time.Second), false); err != nil {
			t.Fatal(err)
		}
	}
	ts, err := s.tombstoneTimestamps("kit")
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != tombstoneRetention {
		t.Errorf("tombstone count = %d, want %d", len(ts), tombstoneRetention)
	}
}

func TestListMixesLiveAndTombstones(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

	if _, err := s.Write(testSnap("kit", base.Add(time.Hour), "serve")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write(testSnap("fabKit1", base, "agents")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Tombstone("fabKit1", base.Add(time.Minute), false); err != nil {
		t.Fatal(err)
	}

	rows, err := s.List("")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v", rows)
	}
	// Newest-first: kit (base+1h) before fabKit1 (base).
	if rows[0].Server != "kit" || rows[0].DiedAt != nil || rows[0].HistoryCount != 1 {
		t.Errorf("row 0 = %+v", rows[0])
	}
	if rows[1].Server != "fabKit1" || rows[1].DiedAt == nil {
		t.Errorf("row 1 = %+v", rows[1])
	}
	if rows[1].Sessions != 1 || rows[1].Windows != 1 {
		t.Errorf("row 1 counts = %+v", rows[1])
	}

	// Filtered listing.
	rows, err = s.List("fabKit1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Server != "fabKit1" {
		t.Errorf("filtered rows = %+v", rows)
	}

	// Missing dir lists empty.
	empty := NewStore(filepath.Join(t.TempDir(), "missing"))
	rows, err = empty.List("")
	if err != nil || rows != nil {
		t.Errorf("missing-dir list = %v, %v", rows, err)
	}
}

func TestContentEqualIgnoresTakenAt(t *testing.T) {
	base := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	a := testSnap("kit", base, "serve")
	b := testSnap("kit", base.Add(time.Hour), "serve")
	if !ContentEqual(a, b) {
		t.Error("snapshots differing only in takenAt should be content-equal")
	}
	c := testSnap("kit", base, "other")
	if ContentEqual(a, c) {
		t.Error("different layouts should not be content-equal")
	}
	if ContentEqual(a, nil) || !ContentEqual(nil, nil) {
		t.Error("nil handling wrong")
	}
}

func TestDismissTombstonesAuditedAndNeverReOffers(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	if _, err := s.Write(testSnap("kit", base, "serve")); err != nil {
		t.Fatal(err)
	}

	if err := s.Dismiss("kit"); err != nil {
		t.Fatal(err)
	}

	// Latest is gone; an audited tombstone stands in its place.
	if snap, err := s.LoadLatest("kit"); err != nil || snap != nil {
		t.Fatalf("latest should be gone after dismiss: snap=%v err=%v", snap, err)
	}
	ts, err := s.tombstoneTimestamps("kit")
	if err != nil || len(ts) != 1 {
		t.Fatalf("tombstones = %v, %v — want exactly 1", ts, err)
	}
	tomb, err := s.LoadAt("kit", ts[0])
	if err != nil {
		t.Fatal(err)
	}
	if tomb.DiedAt == nil || !tomb.AuditedKill {
		t.Errorf("tombstone = diedAt %v audited %v, want stamped + audited", tomb.DiedAt, tomb.AuditedKill)
	}
	// History is left intact.
	if hist, _ := s.historyTimestamps("kit"); len(hist) != 1 {
		t.Errorf("history count = %d, want 1 (untouched)", len(hist))
	}
	// The dismissed server never re-qualifies as an offer.
	offers, err := s.RestorableOffers(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(offers) != 0 {
		t.Errorf("offers after dismiss = %+v, want none", offers)
	}

	// Idempotent: dismissing again (no latest) is a no-op success.
	if err := s.Dismiss("kit"); err != nil {
		t.Fatalf("repeat dismiss should be a no-op success: %v", err)
	}
	if ts, _ := s.tombstoneTimestamps("kit"); len(ts) != 1 {
		t.Errorf("tombstone count after repeat dismiss = %d, want 1", len(ts))
	}
	// Dismissing a server with no snapshot at all is a no-op success.
	if err := s.Dismiss("ghost"); err != nil {
		t.Fatalf("ghost dismiss should succeed: %v", err)
	}
}

func TestRetireLatestRemovesLatestOnly(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	if _, err := s.Write(testSnap("kit", base, "serve")); err != nil {
		t.Fatal(err)
	}

	if err := s.RetireLatest("kit"); err != nil {
		t.Fatal(err)
	}

	// Latest is gone; NO tombstone is created (retire ≠ "server died").
	if snap, err := s.LoadLatest("kit"); err != nil || snap != nil {
		t.Fatalf("latest should be gone after retire: snap=%v err=%v", snap, err)
	}
	if ts, err := s.tombstoneTimestamps("kit"); err != nil || len(ts) != 0 {
		t.Errorf("tombstones after retire = %v, %v — want none", ts, err)
	}
	// History is left intact (the existing prune owns it).
	if hist, _ := s.historyTimestamps("kit"); len(hist) != 1 {
		t.Errorf("history count = %d, want 1 (untouched)", len(hist))
	}
	// The retired server leaves nothing for RestorableOffers to offer.
	offers, err := s.RestorableOffers(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(offers) != 0 {
		t.Errorf("offers after retire = %+v, want none", offers)
	}

	// Idempotent: retiring again (no latest) is a no-op success.
	if err := s.RetireLatest("kit"); err != nil {
		t.Fatalf("repeat retire should be a no-op success: %v", err)
	}
	// Retiring a server with no snapshot at all is a no-op success.
	if err := s.RetireLatest("ghost"); err != nil {
		t.Fatalf("ghost retire should succeed: %v", err)
	}
}
