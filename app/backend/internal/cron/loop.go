package cron

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// loop.go — the operator-loop entry kind's cron-side contract: the delivery-log
// outcome strings its runner and transcriber write, and the log-derived
// backoff ladder for an entry with no agent pane to read an idle epoch from.

// Loop outcome classes (docs/specs/cron.md § Operator Loop). The classes with
// a free-form tail are built by the Outcome* helpers below.
const (
	OutcomeNoChange = "no change"

	outcomeSkippedBusyPrefix = "skipped-busy: run "
	outcomeRanPrefix         = "ran · "
	outcomeRunFailedPrefix   = "run-failed: "
	outcomeRunLostPrefix     = "run-lost: "
	outcomeCheckFailedPrefix = "check-failed: "
	outcomeNoOutcomeLine     = "no outcome line"
	outcomeSeparator         = " · "
	maxRunOutcomeRunes       = 200
)

// OutcomeSkippedBusy is the line for a fire that found a live run window.
func OutcomeSkippedBusy(runID string) string { return outcomeSkippedBusyPrefix + runID }

// OutcomeRan is the line for a finished run: `ran · <outcome> · <duration>`,
// the run's own outcome capped at maxRunOutcomeRunes.
func OutcomeRan(outcome string, d time.Duration) string {
	return outcomeRanPrefix + capRunes(outcome, maxRunOutcomeRunes) + outcomeSeparator + DurationShort(d)
}

// OutcomeRunFailed is the line for a launcher that exited non-zero.
func OutcomeRunFailed(exitCode int, d time.Duration) string {
	return fmt.Sprintf("%sexit %d%s%s", outcomeRunFailedPrefix, exitCode, outcomeSeparator, DurationShort(d))
}

// OutcomeRunFailedNoOutcome is the line for an exit-0 run that printed no
// `outcome:` line.
func OutcomeRunFailedNoOutcome(d time.Duration) string {
	return outcomeRunFailedPrefix + outcomeNoOutcomeLine + outcomeSeparator + DurationShort(d)
}

// OutcomeRunLost is the line for a run that never recorded an end.
func OutcomeRunLost(reason string) string { return outcomeRunLostPrefix + reason }

// OutcomeCheckFailed is the line for a probe-and-diff error.
func OutcomeCheckFailed(detail string) string { return outcomeCheckFailedPrefix + detail }

func capRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// DurationShort renders a duration compactly, dropping zero-valued components
// (1h, 30m, 2m13s, 45s) where time.Duration.String would print "1h0m0s".
func DurationShort(d time.Duration) string {
	if d == 0 {
		return "0s"
	}
	if d%time.Second != 0 {
		return d.String()
	}
	out := ""
	if h := d / time.Hour; h > 0 {
		out += fmt.Sprintf("%dh", h)
		d %= time.Hour
	}
	if m := d / time.Minute; m > 0 {
		out += fmt.Sprintf("%dm", m)
		d %= time.Minute
	}
	if s := d / time.Second; s > 0 {
		out += fmt.Sprintf("%ds", s)
	}
	return out
}

// isLoopRateOutcome reports the loop outcome classes that count toward the
// rate cap: a transcribed run (ran, run-failed, run-lost) or a probe failure.
// `no change` and `skipped-busy` are cheap and never count.
func isLoopRateOutcome(outcome string) bool {
	return strings.HasPrefix(outcome, outcomeRanPrefix) ||
		strings.HasPrefix(outcome, outcomeRunFailedPrefix) ||
		strings.HasPrefix(outcome, outcomeRunLostPrefix) ||
		strings.HasPrefix(outcome, outcomeCheckFailedPrefix)
}

// LoopLadder derives a loop entry's backoff ladder purely from its own log:
// the anchor is the newest own line that is not `no change` (any run outcome,
// `rescheduled`, `skipped-busy`, …) — created_by.at when there is none — and
// each consecutive `no change` line after it climbs one rung. A pure function
// of (entry, log), so the evaluator stays stateless.
func LoopLadder(e Entry, log []LogLine) Ladder {
	own := OwnDeliveries(log, e.ID)
	rung := 0
	anchor := time.Unix(e.CreatedBy.At, 0)
	for i := len(own) - 1; i >= 0; i-- {
		if own[i].Outcome == OutcomeNoChange {
			rung++
			continue
		}
		anchor = time.Unix(own[i].TS, 0)
		break
	}
	return Ladder{Anchor: anchor, Rung: rung}
}
