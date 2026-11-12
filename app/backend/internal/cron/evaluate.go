package cron

import (
	"fmt"
	"time"
)

// Diagnostic is a structured skip/suppression note — never an error. Ticks and
// loads surface these (and log them at debug level); nothing about a
// diagnostic aborts evaluation.
type Diagnostic struct {
	Server  string
	EntryID string
	Reason  string
	Detail  string
}

// FireReason is why a fire is due: the schedule predicate or the wake edge.
type FireReason string

const (
	FireSchedule FireReason = "schedule"
	FireWake     FireReason = "wake"
)

// TargetFacts is one entry's resolved fire-time target (T010's gatherer is the
// producer). Unresolved is "" when the target resolved; otherwise it carries
// the resolution failure detail and the entry's fires are unresolvable this
// tick.
type TargetFacts struct {
	PaneID string
	// AgentState and StateEpoch are the target pane's reconciled
	// @rk_pane_agent_state read — StateEpoch is the backoff anchor input (the
	// raw idle epoch joined against the delivery log).
	AgentState string
	StateEpoch int64
	Unresolved string
}

// Resolved reports whether the target resolved to a live pane.
func (f TargetFacts) Resolved() bool { return f.Unresolved == "" }

// Fire is one due delivery: the entry, the resolved reason, and the resolved
// target pane.
type Fire struct {
	Server string
	Entry  Entry
	Reason FireReason
	PaneID string
	// Rung is the backoff ladder rung being fired (0 for wake fires and
	// other schedules).
	Rung int
	// DueAt is the scheduled time the fire came due (every: anchor+interval;
	// backoff: the ladder's next-fire; cron: the occurrence; wake fires and
	// catch-up late fires: now). It feeds the deliverer's when-idle hold
	// bound, so a held fire expires on ITS schedule time, not the tick's.
	DueAt time.Time
	At    time.Time
}

// EvalInput is everything the stateless evaluator needs, all disk-derivable:
// the server's entries, per-entry resolved target facts, the server agent-state
// map (pane id → state; each wake_on entry fingerprints its own view of it),
// the parsed delivery log, the previous wake cursor, and now.
type EvalInput struct {
	Server  string
	Now     time.Time
	Entries []Entry
	Facts   map[string]TargetFacts
	States  map[string]string
	Log     []LogLine
	Cursor  WakeCursor
	// RunPanes is the set of pane ids inside operator-run windows. A loop
	// entry's wake fingerprint excludes them so the run's own agent going idle
	// or vanishing never wakes the loop that launched it.
	RunPanes map[string]bool
}

// EvalResult carries the due fires, the due-but-target-unresolved fires, the
// skip diagnostics, and the next wake cursor (to be persisted by the tick
// orchestrator).
type EvalResult struct {
	Fires []Fire
	// Absent carries due fires whose target did not resolve (empty PaneID),
	// emitted exactly like resolved fires — the tick orchestrator applies the
	// entry's if_absent policy to each.
	Absent []Fire
	// Missed carries one fire per cron-kind entry whose latest occurrence fell
	// stale past its window without catch_up — schedule history, not delivery:
	// emitted through the same muted gating as fires but regardless of target
	// resolution. The tick appends one `missed` log line per entry, advancing
	// the anchor past the gap.
	Missed     []Fire
	Diags      []Diagnostic
	NextCursor WakeCursor
}

// Evaluate is the pure core (R4): no package-level mutable state, no I/O —
// equal inputs return deep-equal results. Composition order per entry (R9):
// muted (flag or live lease) → schedule/wake due math → target resolution →
// emit.
func Evaluate(in EvalInput) EvalResult {
	res := EvalResult{NextCursor: in.Cursor.clone()}
	for i, e := range in.Entries {
		// Eval-time defense of the per-server entry cap: a hand-edited file
		// past the cap processes only its first cap-many entries.
		if i >= MaxEntriesPerServer {
			res.Diags = append(res.Diags, Diagnostic{Server: in.Server, EntryID: e.ID, Reason: "entry-cap-exceeded",
				Detail: fmt.Sprintf("entry beyond the %d-per-server cap; skipped", MaxEntriesPerServer)})
			continue
		}
		diag := func(reason, detail string) {
			res.Diags = append(res.Diags, Diagnostic{Server: in.Server, EntryID: e.ID, Reason: reason, Detail: detail})
		}

		if e.EffectivelyMuted(in.Now) {
			detail := "entry is muted"
			if !e.Muted {
				detail = "entry is muted until " + time.Unix(e.MutedUntil, 0).Format(time.RFC3339)
			}
			diag("muted", detail)
			continue
		}

		facts := in.Facts[e.ID]
		if e.IsLoop() {
			// A loop entry fires a Go function: there is no target to resolve,
			// so it can never reach Absent or trigger if_absent.
			facts = TargetFacts{}
		}

		// Schedule predicate. dueAt tracks when the due fire came due on its own
		// schedule; missedAt marks a stale cron occurrence (logged, not fired).
		schedDue := false
		missed := false
		dueAt := in.Now
		rung := 0
		switch e.Schedule.Kind {
		case ScheduleEvery:
			var anchor time.Time
			schedDue, anchor = everyDue(e, in.Log, in.Now)
			dueAt = anchor.Add(e.Schedule.Interval.Duration)
		case ScheduleBackoff:
			switch {
			case e.IsLoop():
				ladder := LoopLadder(e, in.Log)
				schedDue = ladder.Due(in.Now, e.Schedule.Min.Duration, e.Schedule.Max.Duration)
				dueAt = ladder.NextFire(e.Schedule.Min.Duration, e.Schedule.Max.Duration)
				rung = ladder.Rung + 1
			case !facts.Resolved():
				// Diagnosed unconditionally: backoff due-ness is unknowable
				// without the epoch, so the anchor gap is reported every tick.
				diag("anchor-unavailable", "backoff target unresolved: "+facts.Unresolved)
			case facts.StateEpoch <= 0:
				diag("anchor-unavailable", "target pane carries no agent-state epoch")
			default:
				ladder := JoinAnchor(facts.StateEpoch, ScheduleHistory(in.Log, e.ID),
					e.Schedule.Min.Duration, e.Schedule.Max.Duration)
				schedDue = ladder.Due(in.Now, e.Schedule.Min.Duration, e.Schedule.Max.Duration)
				dueAt = ladder.NextFire(e.Schedule.Min.Duration, e.Schedule.Max.Duration)
				rung = ladder.Rung + 1
			}
		case ScheduleCron:
			schedDue, missed, dueAt = cronScheduleDue(e, in.Log, in.Now)
		default:
			diag("unknown-schedule-kind", e.Schedule.Kind)
		}

		// Wake predicate (OR'd with the schedule). The entry's own target pane
		// is excluded from its fingerprint: a delivery makes the target busy,
		// and that flip must never read as the next edge (the wake analogue of
		// the anchor-join rule). The hold window runs from the entry's newest
		// own log line — the only moment "our own effect" can date from.
		wakeDue := false
		if e.WakeOn != nil {
			if e.WakeOn.Event != WakeAgentStateChange {
				diag("unknown-wake-event", e.WakeOn.Event)
			} else {
				obs, hasObs := in.Cursor.Entries[e.ID]
				fp := fingerprintExcluding(in.States, facts.PaneID)
				if e.IsLoop() {
					fp = fingerprintExcludingSet(in.States, in.RunPanes)
				}
				var lastDelivery time.Time
				last, hasDelivery := LastDelivery(in.Log, e.ID)
				if hasDelivery {
					lastDelivery = time.Unix(last.TS, 0)
				}
				edge, next, wd := wakeEdge(e.WakeOn.Debounce.Duration, fp, obs, hasObs, lastDelivery, hasDelivery, in.Now)
				res.NextCursor.Entries[e.ID] = next
				if wd != "" {
					diag(wd, "wake_on "+WakeAgentStateChange)
				}
				wakeDue = edge
			}
		}

		if !schedDue && !wakeDue && !missed {
			continue
		}

		resolved := facts.Resolved()
		if !resolved && (schedDue || wakeDue) {
			diag("target-unresolved", facts.Unresolved)
		}

		if missed {
			// Schedule history, not delivery: no PaneID, no if_absent
			// disposition — the tick logs one `missed` line and moves on.
			res.Missed = append(res.Missed, Fire{
				Server: in.Server,
				Entry:  e,
				Reason: FireSchedule,
				DueAt:  dueAt,
				At:     in.Now,
			})
		}
		if !schedDue && !wakeDue {
			continue
		}

		reason := FireSchedule
		if !schedDue {
			reason = FireWake
			// A wake fire is not firing the ladder — it carries no rung, and
			// its due time is the edge observation, not a schedule point.
			rung = 0
			dueAt = in.Now
		}
		fire := Fire{
			Server: in.Server,
			Entry:  e,
			Reason: reason,
			PaneID: facts.PaneID,
			Rung:   rung,
			DueAt:  dueAt,
			At:     in.Now,
		}
		if !resolved {
			res.Absent = append(res.Absent, fire)
			continue
		}
		res.Fires = append(res.Fires, fire)
	}
	return res
}
