package operatorloop

import (
	"context"
	"log/slog"

	"rk/internal/cron"
	"rk/internal/tmux"
)

// transcribe.go — turns finished run records into the one cron-log line per
// fire. The cron tick is the log's only writer (AppendLog's cap trim rewrites
// the file by rename, so a second writer could lose lines): the wrapper writes
// its record, the tick calls Transcribe, appends what it returns, then calls
// MarkLogged for each run. A run id already present in the log is marked
// without a second line (cron.Tick checks), so a crash between append and mark
// still yields exactly one line.

// listRunWindowsFn lists a server's live run windows; a test seam.
var listRunWindowsFn = tmux.ListOperatorRunWindows

// lostWindowGone is the reason for a run whose window vanished without the
// wrapper recording an end (the tmux server died, or the window was killed).
const lostWindowGone = "window gone"

// Transcribe returns the cron log lines for the server's finished,
// not-yet-logged runs, oldest first: `ran · <outcome> · <dur>` for a clean
// exit with an outcome line, `run-failed: …` otherwise, and `run-lost: …` for a
// run whose record never ended and whose window is gone (the record is marked
// ended on the spot). It then prunes old records. A record that fails to parse
// is skipped with a warning, never failing the tick. The lines carry the run id
// and its entry; the tick stamps their time.
func Transcribe(ctx context.Context, server string) []cron.LogLine {
	dir, err := Dir(ctx, server)
	if err != nil {
		slog.Debug("operator loop transcribe: no runs dir", "server", server, "err", err)
		return nil
	}
	ids, err := listRunIDs(dir)
	if err != nil {
		slog.Warn("operator loop transcribe: listing runs failed", "server", server, "err", err)
		return nil
	}

	// The window list is read once, and only when a record has not ended: a
	// nil result means the list failed, so no run is judged lost this tick.
	var live map[string]bool
	listed := false
	liveRuns := func() map[string]bool {
		if listed {
			return live
		}
		listed = true
		wins, werr := listRunWindowsFn(ctx, server)
		if werr != nil {
			slog.Debug("operator loop transcribe: listing run windows failed", "server", server, "err", werr)
			return nil
		}
		live = make(map[string]bool, len(wins))
		for _, w := range wins {
			live[w.RunID] = true
		}
		return live
	}

	var lines []cron.LogLine
	for _, id := range ids {
		path, _ := RecordPath(dir, id)
		rec, err := ReadRecord(path)
		if err != nil {
			slog.Warn("operator loop: skipping unreadable run record", "server", server, "run", id, "err", err)
			continue
		}
		if rec.Logged {
			continue
		}
		if !rec.Ended() {
			if running := liveRuns(); running == nil || running[id] {
				continue
			}
			rec = markLost(path, rec, lostWindowGone)
		}
		lines = append(lines, cron.LogLine{
			Entry:   rec.Entry,
			Reason:  string(cron.FireSchedule),
			Outcome: outcomeFor(rec),
			Run:     rec.ID,
		})
	}
	if err := Prune(dir); err != nil {
		slog.Warn("operator loop: pruning run records failed", "server", server, "err", err)
	}
	return lines
}

// markLost records that a run ended without an exit status.
func markLost(path string, rec Record, reason string) Record {
	mut := func(r *Record) {
		if r.EndedAt == "" {
			r.EndedAt = FormatTime(nowTime())
		}
		r.Lost = reason
	}
	if err := UpdateRecord(path, mut); err != nil {
		slog.Warn("operator loop: marking run lost failed", "run", rec.ID, "err", err)
		mut(&rec)
		return rec
	}
	updated, err := ReadRecord(path)
	if err != nil {
		mut(&rec)
		return rec
	}
	return updated
}

// outcomeFor renders an ended record as its cron log outcome.
func outcomeFor(r Record) string {
	d := r.Duration()
	switch {
	case r.Lost != "":
		return cron.OutcomeRunLost(r.Lost)
	case r.ExitCode != nil && *r.ExitCode == 0 && r.Outcome != "":
		return cron.OutcomeRan(r.Outcome, d)
	case r.ExitCode != nil && *r.ExitCode != 0:
		return cron.OutcomeRunFailed(*r.ExitCode, d)
	default:
		return cron.OutcomeRunFailedNoOutcome(d)
	}
}

// MarkLogged flags a run's record as transcribed so the next tick skips it.
func MarkLogged(ctx context.Context, server, runID string) {
	dir, err := Dir(ctx, server)
	if err != nil {
		return
	}
	path, err := RecordPath(dir, runID)
	if err != nil {
		return
	}
	if err := UpdateRecord(path, func(r *Record) { r.Logged = true }); err != nil {
		slog.Warn("operator loop: marking run logged failed", "server", server, "run", runID, "err", err)
	}
}
