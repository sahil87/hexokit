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
// loop entry and mutes the legacy entry — an unmute is the rollback while the
// muted row lasts. Once the loop entry exists the tick sweeps the muted legacy
// rows away (SweepLegacyOperatorTicks); an unmuted one is a deliberate
// rollback and stays.

// Seeded loop entry shape: today's operator ladder and wake, now target-less.
const (
	LoopSeedName     = "operator loop"
	loopSeedMin      = 3 * time.Minute
	loopSeedMax      = 24 * time.Minute
	loopSeedDebounce = 60 * time.Second

	// legacyOperatorPayload is the text of fab's typed operator-tick entry.
	legacyOperatorPayload = "operator tick"

	// OutcomeExpiredLegacy is the log line for a swept legacy operator-tick
	// entry.
	OutcomeExpiredLegacy = "expired-legacy"
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

// SweepLegacyOperatorTicks removes every muted legacy operator-tick entry in
// one atomic write, when the server's cron file holds a loop entry (muted or
// not), and returns the removed ids. An unmuted legacy entry stays (a rollback
// on purpose). It writes nothing when there is no loop entry or nothing to
// remove, and a corrupt file errors without writing.
func SweepLegacyOperatorTicks(dir, slug string) ([]string, error) {
	path, entries, err := loadForMutate(dir, slug)
	if err != nil {
		return nil, err
	}
	hasLoop := false
	for _, e := range entries {
		if e.IsLoop() {
			hasLoop = true
			break
		}
	}
	if !hasLoop {
		return nil, nil
	}
	var removed []string
	kept := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if isLegacyOperatorTick(e) && e.Muted {
			removed = append(removed, e.ID)
			continue
		}
		kept = append(kept, e)
	}
	if len(removed) == 0 {
		return nil, nil
	}
	return removed, saveEntries(path, kept)
}

// seedLoop runs the per-tick seed step for one server: a no-op without the
// seam or without rk's operator state file. It returns the ids of the legacy
// entries it swept, for the caller to log.
func seedLoop(ctx context.Context, slug, dir string, now time.Time, exists func(context.Context, string) bool) (swept []string, diags []Diagnostic) {
	if exists == nil || !exists(ctx, slug) {
		return nil, nil
	}
	seeded, err := SeedOperatorLoop(dir, slug, now)
	if err != nil {
		return nil, []Diagnostic{{Server: slug, Reason: "loop-seed-failed", Detail: err.Error()}}
	}
	if seeded {
		slog.Info("operator loop entry seeded", "server", slug)
	}
	swept, err = SweepLegacyOperatorTicks(dir, slug)
	if err != nil {
		return nil, []Diagnostic{{Server: slug, Reason: "legacy-sweep-failed", Detail: err.Error()}}
	}
	return swept, nil
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
