package cron

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

// seed.go — the daemon-side seeding of the operator-loop entry. The switch is
// rk's operator state file for the server (the same existence rule the
// operator display read uses): before one exists a server keeps fab's typed
// `operator tick` entry untouched; once it exists, the next tick seeds the
// loop entry and mutes — never deletes — the legacy entry, so rollback is one
// unmute and fab's reconcile still sees a role:operator row.

// Seeded loop entry shape: today's operator ladder and wake, now target-less.
const (
	LoopSeedName     = "operator loop"
	loopSeedMin      = 3 * time.Minute
	loopSeedMax      = 24 * time.Minute
	loopSeedDebounce = 60 * time.Second

	// legacyOperatorPayload is the text of fab's typed operator-tick entry.
	legacyOperatorPayload = "operator tick"
)

// isLegacyOperatorTick reports a fab-seeded typed-prompt operator entry.
func isLegacyOperatorTick(e Entry) bool {
	return e.Run == "" && e.Target.Kind == TargetRole && e.Target.Role == RoleOperator &&
		e.Payload == legacyOperatorPayload
}

// SeedOperatorLoop adds the loop entry to the server's cron file and mutes
// every legacy operator-tick entry in the same atomic write — one write, so a
// crash can never leave the loop live beside an unmuted typed tick. It is a
// no-op when the file already holds a loop entry (muted or not: a user who
// muted it and unmuted the legacy entry has rolled back, and stays rolled
// back). A corrupt file errors without writing.
func SeedOperatorLoop(dir, slug string, now time.Time) (bool, error) {
	path, entries, err := loadForMutate(dir, slug)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		if e.IsLoop() {
			return false, nil
		}
	}
	if len(entries) >= MaxEntriesPerServer {
		return false, errEntryCap(slug)
	}
	taken := make(map[string]bool, len(entries))
	for _, e := range entries {
		taken[e.ID] = true
	}
	id, err := newID(taken)
	if err != nil {
		return false, err
	}
	seeded := Entry{
		ID:   id,
		Name: LoopSeedName,
		Run:  RunOperatorLoop,
		Schedule: Schedule{Kind: ScheduleBackoff,
			Min: Duration{loopSeedMin}, Max: Duration{loopSeedMax}},
		WakeOn: &WakeOn{Event: WakeAgentStateChange, Scope: WakeScopeServer,
			Debounce: Duration{loopSeedDebounce}},
		Pinned:    true,
		CreatedBy: CreatedBy{At: now.Unix()},
	}
	if err := seeded.validate(); err != nil {
		return false, err
	}
	for i := range entries {
		if isLegacyOperatorTick(entries[i]) {
			entries[i].Muted = true
			entries[i].MutedUntil = 0
		}
	}
	return true, saveEntries(path, append(entries, seeded))
}

// seedLoop runs the per-tick seed step for one server: a no-op without the
// seam or without rk's operator state file.
func seedLoop(ctx context.Context, slug, dir string, now time.Time, exists func(context.Context, string) bool) []Diagnostic {
	if exists == nil || !exists(ctx, slug) {
		return nil
	}
	seeded, err := SeedOperatorLoop(dir, slug, now)
	if err != nil {
		return []Diagnostic{{Server: slug, Reason: "loop-seed-failed", Detail: err.Error()}}
	}
	if seeded {
		slog.Info("operator loop entry seeded", "server", slug)
	}
	return nil
}

// withSeedableServers extends the swept slugs with live servers that have no
// cron file yet but whose rk operator state file exists, so a server adopted
// before it ever held a cron entry still gets its loop entry. Entry-file
// slugs keep their order; the additions follow sorted. A nil seam adds none.
func withSeedableServers(ctx context.Context, slugs, live []string, exists func(context.Context, string) bool) []string {
	if exists == nil {
		return slugs
	}
	have := make(map[string]bool, len(slugs))
	for _, s := range slugs {
		have[s] = true
	}
	var extra []string
	for _, s := range live {
		if !have[s] && ValidSlug(s) && exists(ctx, s) {
			extra = append(extra, s)
		}
	}
	sort.Strings(extra)
	return append(slugs, extra...)
}

// runLogged reports whether the log already carries a line for the run id.
func runLogged(lines []LogLine, runID string) bool {
	if runID == "" {
		return false
	}
	for _, l := range lines {
		if l.Run == runID {
			return true
		}
	}
	return false
}
