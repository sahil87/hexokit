package cron

import (
	"time"

	robfigcron "github.com/robfig/cron/v3"
)

// derive.go — the read-side per-entry derivation the HTTP API wave surfaces
// (R1): next-fire, backoff rung, orphaned status, and last-fired, computed by
// CALLING the evaluator's own primitives (JoinAnchor, Ladder.NextFire,
// everyAnchor, cronScheduleDue, LastDelivery, robfig Schedule.Next) so the
// projection can never diverge from the tick's math. Orphaned is a live
// per-call snapshot of target resolution; OrphanedSince/ExpiresAt surface the
// orphan.go streak derivation behind the same snapshot.

// DerivedEntry is the live projection of one entry's schedule state.
type DerivedEntry struct {
	// NextFire is when the schedule next comes due (valid only when
	// HasNextFire). It may be in the past — that means due now.
	NextFire    time.Time
	HasNextFire bool
	// Rung is the rung of the UPCOMING backoff fire (the same rung the
	// evaluator records on the fire), 0 for every/cron-kind entries and for a
	// backoff entry whose anchor is unknowable.
	Rung int
	// Orphaned is true when the entry's target failed resolution this call.
	Orphaned bool
	// OrphanedSince is the start of the entry's continuous-unresolved streak
	// (unix seconds), the orphan.go trailing-run derivation. Zero unless the
	// entry is currently orphaned — and always zero for role entries (never
	// GC subjects), so consumers can read nonzero as expirable.
	OrphanedSince int64
	// ExpiresAt is when the streak reaches OrphanTTL (unix seconds). Zero
	// whenever OrphanedSince is zero and for pinned entries.
	ExpiresAt int64
	// LastFired is the newest delivery-log timestamp for the entry
	// (unix seconds; 0 = never delivered).
	LastFired int64
}

// DeriveEntry computes one entry's live schedule facts. log is the server's
// full delivery log (the entry's own lines are filtered internally); facts is
// the entry's resolved target facts (unresolved ⇒ orphaned, and a backoff
// entry's next-fire is unknowable without the anchor epoch). now drives the
// cron-kind next-fire (a due occurrence, else the next occurrence after now).
func DeriveEntry(e Entry, log []LogLine, facts TargetFacts, now time.Time) DerivedEntry {
	d := DerivedEntry{Orphaned: !e.IsLoop() && !facts.Resolved()}
	if d.Orphaned && e.Target.Kind != TargetRole {
		d.OrphanedSince = OrphanedSince(log, e)
		d.ExpiresAt = OrphanExpiresAt(d.OrphanedSince, e.Pinned)
	}
	if last, ok := LastDelivery(log, e.ID); ok {
		d.LastFired = last.TS
	}
	switch e.Schedule.Kind {
	case ScheduleEvery:
		d.NextFire = everyAnchor(e, log).Add(e.Schedule.Interval.Duration)
		d.HasNextFire = true
	case ScheduleBackoff:
		if e.IsLoop() {
			ladder := LoopLadder(e, log)
			d.Rung = ladder.Rung + 1
			d.NextFire = ladder.NextFire(e.Schedule.Min.Duration, e.Schedule.Max.Duration)
			d.HasNextFire = true
		} else if facts.Resolved() && facts.StateEpoch > 0 {
			ladder := JoinAnchor(facts.StateEpoch, ScheduleHistory(log, e.ID),
				e.Schedule.Min.Duration, e.Schedule.Max.Duration)
			d.Rung = ladder.Rung + 1
			d.NextFire = ladder.NextFire(e.Schedule.Min.Duration, e.Schedule.Max.Duration)
			d.HasNextFire = true
		}
	case ScheduleCron:
		// A due occurrence reports its own DueAt — past means due now, the
		// DerivedEntry contract — via the evaluator's due math so a
		// currently-due entry never shows a future next-fire. An unparseable
		// expression (or one with no occurrence inside robfig's 5-year
		// horizon) keeps HasNextFire false — never a fabricated time.
		if sched, err := robfigcron.ParseStandard(e.Schedule.Expr); err == nil {
			if due, _, dueAt := cronScheduleDue(e, log, now); due {
				d.NextFire = dueAt
				d.HasNextFire = true
			} else if next := sched.Next(now); !next.IsZero() {
				d.NextFire = next
				d.HasNextFire = true
			}
		}
	}
	return d
}
