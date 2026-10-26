package cron

import (
	"testing"
	"time"
)

func backoffEntry() Entry {
	return Entry{
		ID:       "a3f9",
		Schedule: Schedule{Kind: ScheduleBackoff, Min: Duration{Duration: 60 * time.Second}, Max: Duration{Duration: 30 * time.Minute}},
		Target:   Target{Kind: TargetRole, Role: RoleOperator},
	}
}

// TestDeriveEntryBackoffScenario is R1's worked scenario projected through
// DeriveEntry: deliveries at T+1m and T+3m, raw idle epoch 5s after T+3m,
// derived at T+3m+10s ⇒ rung 3, next-fire T+7m — the exact JoinAnchor/Ladder
// result the Backoff anchor-join scenario pins (no reimplementation, no
// divergence).
func TestDeriveEntryBackoffScenario(t *testing.T) {
	T := backoffBase
	e := backoffEntry()
	log := own(unix(T, time.Minute), unix(T, 3*time.Minute))
	facts := TargetFacts{PaneID: "%5", AgentState: "idle", StateEpoch: unix(T, 3*time.Minute+5*time.Second)}

	d := DeriveEntry(e, log, facts, T.Add(3*time.Minute+10*time.Second))
	if !d.HasNextFire {
		t.Fatal("HasNextFire = false, want true")
	}
	if want := T.Add(7 * time.Minute); !d.NextFire.Equal(want) {
		t.Errorf("NextFire = %v, want %v", d.NextFire, want)
	}
	if d.Rung != 3 {
		t.Errorf("Rung = %d, want 3 (the rung of the upcoming fire)", d.Rung)
	}
	if d.Orphaned {
		t.Error("Orphaned = true, want false (target resolved)")
	}
	if want := unix(T, 3*time.Minute); d.LastFired != want {
		t.Errorf("LastFired = %d, want %d", d.LastFired, want)
	}
}

// TestDeriveEntryEvery: next-fire is anchor + interval — the newest delivery,
// else created_by.at — and rung is always 0.
func TestDeriveEntryEvery(t *testing.T) {
	T := backoffBase
	e := Entry{
		ID:        "a3f9",
		Schedule:  Schedule{Kind: ScheduleEvery, Interval: Duration{Duration: time.Hour}},
		Target:    Target{Kind: TargetRole, Role: RoleOperator},
		CreatedBy: CreatedBy{At: unix(T, -2*time.Hour)},
	}
	facts := TargetFacts{PaneID: "%5", AgentState: "idle", StateEpoch: unix(T, 0)}

	// Newest delivery at T, derived at T+30m ⇒ next-fire T+1h.
	log := own(unix(T, 0))
	d := DeriveEntry(e, log, facts, T.Add(30*time.Minute))
	if !d.HasNextFire || !d.NextFire.Equal(T.Add(time.Hour)) {
		t.Errorf("NextFire = %v (has %v), want %v", d.NextFire, d.HasNextFire, T.Add(time.Hour))
	}
	if d.Rung != 0 {
		t.Errorf("Rung = %d, want 0 for every", d.Rung)
	}
	if d.LastFired != unix(T, 0) {
		t.Errorf("LastFired = %d, want %d", d.LastFired, unix(T, 0))
	}

	// No deliveries ⇒ the anchor is created_by.at.
	d = DeriveEntry(e, nil, facts, T)
	if want := time.Unix(e.CreatedBy.At, 0).Add(time.Hour); !d.HasNextFire || !d.NextFire.Equal(want) {
		t.Errorf("pre-delivery NextFire = %v (has %v), want created_by.at+interval %v", d.NextFire, d.HasNextFire, want)
	}
	if d.LastFired != 0 {
		t.Errorf("LastFired = %d, want 0 (never delivered)", d.LastFired)
	}
}

// TestDeriveEntryCronKindNextFire: a cron-kind entry reports its next
// occurrence after now as next-fire; an unparseable expression keeps
// HasNextFire false — never a fabricated time.
func TestDeriveEntryCronKindNextFire(t *testing.T) {
	e := Entry{
		ID:       "a3f9",
		Schedule: Schedule{Kind: ScheduleCron, Expr: "0 9 * * *"},
		Target:   Target{Kind: TargetRole, Role: RoleOperator},
	}
	facts := TargetFacts{PaneID: "%5", AgentState: "idle", StateEpoch: backoffBase.Unix()}
	now := localTime(2026, 9, 9, 10, 0, 0)
	d := DeriveEntry(e, own(backoffBase.Unix()), facts, now)
	if !d.HasNextFire || !d.NextFire.Equal(localTime(2026, 9, 10, 9, 0, 0)) {
		t.Errorf("cron-kind NextFire = %v (has %v), want tomorrow 09:00 local", d.NextFire, d.HasNextFire)
	}
	if d.Rung != 0 {
		t.Errorf("cron-kind Rung = %d, want 0", d.Rung)
	}

	e.Schedule.Expr = "not an expr"
	d = DeriveEntry(e, own(backoffBase.Unix()), facts, now)
	if d.HasNextFire || !d.NextFire.IsZero() {
		t.Errorf("unparseable NextFire = %v (has %v), want none", d.NextFire, d.HasNextFire)
	}
}

// TestDeriveEntryOrphanStreak: the orphan streak surfaces only for a
// currently-orphaned session/pane entry — zero for a resolved target,
// ExpiresAt zero for pinned, both zero for role entries (never GC subjects).
func TestDeriveEntryOrphanStreak(t *testing.T) {
	T := backoffBase
	entry := Entry{
		ID:        "a3f9",
		Schedule:  Schedule{Kind: ScheduleEvery, Interval: Duration{Duration: time.Hour}},
		Target:    Target{Kind: TargetSession, Session: "4fe2"},
		CreatedBy: CreatedBy{At: unix(T, -time.Hour)},
	}
	log := []LogLine{
		orphanLine(unix(T, -30*time.Minute), "delivered"),
		orphanLine(unix(T, -10*time.Minute), "skipped-absent"),
	}
	unresolved := TargetFacts{Unresolved: "no pane carries session 4fe2"}
	since := unix(T, -10*time.Minute)

	// Orphaned and unpinned: both fields populated.
	d := DeriveEntry(entry, log, unresolved, T)
	if !d.Orphaned || d.OrphanedSince != since {
		t.Errorf("OrphanedSince = %d (orphaned %v), want %d", d.OrphanedSince, d.Orphaned, since)
	}
	if want := since + int64(OrphanTTL/time.Second); d.ExpiresAt != want {
		t.Errorf("ExpiresAt = %d, want %d (OrphanedSince + OrphanTTL)", d.ExpiresAt, want)
	}

	// Resolved: both zero even with absent-class lines in the log.
	d = DeriveEntry(entry, log, TargetFacts{PaneID: "%5", AgentState: "idle", StateEpoch: unix(T, 0)}, T)
	if d.OrphanedSince != 0 || d.ExpiresAt != 0 {
		t.Errorf("resolved entry OrphanedSince/ExpiresAt = %d/%d, want 0/0", d.OrphanedSince, d.ExpiresAt)
	}

	// Pinned: the streak still shows, but expiry never fires.
	pinned := entry
	pinned.Pinned = true
	d = DeriveEntry(pinned, log, unresolved, T)
	if d.OrphanedSince != since || d.ExpiresAt != 0 {
		t.Errorf("pinned entry OrphanedSince/ExpiresAt = %d/%d, want %d/0", d.OrphanedSince, d.ExpiresAt, since)
	}

	// Role: never a GC subject — both zero even when unresolved.
	role := entry
	role.Target = Target{Kind: TargetRole, Role: RoleOperator}
	d = DeriveEntry(role, log, unresolved, T)
	if d.OrphanedSince != 0 || d.ExpiresAt != 0 {
		t.Errorf("role entry OrphanedSince/ExpiresAt = %d/%d, want 0/0", d.OrphanedSince, d.ExpiresAt)
	}
}

// TestDeriveEntryCronKindDueNow: an occurrence inside its due window projects
// as the (past) occurrence itself — past next-fire means due now, the
// DerivedEntry contract — and a stale occurrence past its window (missed, no
// catch-up) projects the next future occurrence.
func TestDeriveEntryCronKindDueNow(t *testing.T) {
	facts := TargetFacts{PaneID: "%5", AgentState: "idle", StateEpoch: backoffBase.Unix()}
	anchor := localTime(2026, 9, 9, 10, 0, 30)
	log := own(anchor.Unix())

	e := cronEntry("*/5 * * * *", "", "", anchor)
	d := DeriveEntry(e, log, facts, localTime(2026, 9, 9, 10, 5, 20))
	if want := localTime(2026, 9, 9, 10, 5, 0); !d.HasNextFire || !d.NextFire.Equal(want) {
		t.Errorf("due-now NextFire = %v (has %v), want the due occurrence %v", d.NextFire, d.HasNextFire, want)
	}

	d = DeriveEntry(e, log, facts, localTime(2026, 9, 9, 10, 9, 0))
	if want := localTime(2026, 9, 9, 10, 10, 0); !d.HasNextFire || !d.NextFire.Equal(want) {
		t.Errorf("missed NextFire = %v (has %v), want the next future occurrence %v", d.NextFire, d.HasNextFire, want)
	}
}

// TestDeriveEntryOrphaned: an unresolved target is orphaned, and a backoff
// entry's next-fire is unknowable without the anchor epoch.
func TestDeriveEntryOrphaned(t *testing.T) {
	T := backoffBase
	e := backoffEntry()
	log := own(unix(T, time.Minute))
	unresolved := TargetFacts{Unresolved: "no window carries role operator"}

	d := DeriveEntry(e, log, unresolved, T)
	if !d.Orphaned {
		t.Error("Orphaned = false, want true for an unresolved target")
	}
	if d.HasNextFire {
		t.Errorf("HasNextFire = true with an unresolved target, want false (anchor unknowable)")
	}
	if d.Rung != 0 {
		t.Errorf("Rung = %d, want 0 with an unresolved target", d.Rung)
	}
	// Last-fired still derives from the log — delivery history survives an
	// unresolved target.
	if want := unix(T, time.Minute); d.LastFired != want {
		t.Errorf("LastFired = %d, want %d", d.LastFired, want)
	}

	// A resolved target carrying no agent-state epoch is not orphaned but
	// still cannot anchor a backoff ladder.
	for _, state := range []string{"unknown", "idle"} {
		t.Run(state, func(t *testing.T) {
			d := DeriveEntry(e, log, TargetFacts{PaneID: "%5", AgentState: state}, T)
			if d.Orphaned {
				t.Error("Orphaned = true for a resolved target, want false")
			}
			if d.HasNextFire || d.Rung != 0 {
				t.Errorf("unknown epoch yielded a backoff schedule: %+v", d)
			}
		})
	}
}
