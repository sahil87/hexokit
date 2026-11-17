package sessions

import (
	"context"
	"os"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
)

// operatorstate.go — which operator state file the display reads use. rk's own
// file (operator.StatePath) is the source as soon as it exists on disk, even
// when empty or corrupt; fab's file (cron.FabOperatorStatePath) is read only
// while no rk file exists. Existence alone is the switch: after adopt, rk's
// file is the ledger, so a corrupt or empty one must never fall back to fab's
// frozen copy. Read-only — nothing here creates, locks, converts or writes
// either file. internal/cron cannot hold this because internal/operator
// imports it.

// resolveOperatorStatePath picks the file for one server's socket path ("" =
// the socket-path query failed; both candidates then use the "default" slug).
// ok is false when neither path resolves.
func resolveOperatorStatePath(socketPath string) (path string, ok bool) {
	if rkPath, err := operator.StatePath(socketPath); err == nil {
		if _, statErr := os.Stat(rkPath); statErr == nil {
			return rkPath, true
		}
	}
	fabPath, err := cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))
	if err != nil {
		return "", false
	}
	return fabPath, true
}

// ReadOperatorState is the one tolerant read behind the sessions payload and
// the notes route: absent or corrupt ⇒ (zero, false).
func ReadOperatorState(socketPath string) (cron.OperatorState, bool) {
	path, ok := resolveOperatorStatePath(socketPath)
	if !ok {
		return cron.OperatorState{}, false
	}
	return cron.ReadOperatorState(path)
}

// ReadOperatorStateForServer reads the operator state of the named tmux
// server through the same source selection FetchSessions uses.
func ReadOperatorStateForServer(ctx context.Context, server string) (cron.OperatorState, bool) {
	sock, err := socketPathFn(ctx, server)
	if err != nil {
		sock = ""
	}
	return ReadOperatorState(sock)
}

// operatorLoopLivenessFn is the FetchSessions seam over operatorLoopLiveness.
var operatorLoopLivenessFn = operatorLoopLiveness

// operatorLoopLiveness is the operator watchdog for a server whose clock is
// rk's `run: operator-loop` cron entry. rk's state file never carries
// last_tick_at — the loop's fires live in the cron delivery log — so the
// watchdog reads the loop entry instead. ok is false when the server has no
// loop entry (the typed-tick era); the caller then keeps the state file's
// last_tick_at rule. lastFired is the entry's newest delivery (0 = never).
// stale is measured from the entry's next due fire, not from lastFired: the
// backoff ladder legitimately idles up to its max (24m by default), longer
// than DefaultWatchlistStaleThreshold, so only a fire overdue by more than
// that threshold means the clock stopped. An effectively-muted entry is never
// stale — the clock was told to stop. Read-only and tolerant: any unreadable
// file reads as "no loop entry".
func operatorLoopLiveness(server string, now time.Time) (lastFired int64, stale, ok bool) {
	dir, err := cron.DefaultDir()
	if err != nil {
		return 0, false, false
	}
	entriesPath, err := cron.EntriesPath(dir, server)
	if err != nil {
		return 0, false, false
	}
	entries, _ := cron.LoadEntries(entriesPath)
	var loop cron.Entry
	for _, e := range entries {
		if e.IsLoop() {
			loop, ok = e, true
			break
		}
	}
	if !ok {
		return 0, false, false
	}
	logPath, err := cron.LogPath(dir, server)
	if err != nil {
		return 0, false, false
	}
	d := cron.DeriveEntry(loop, cron.ReadLog(logPath), cron.TargetFacts{}, now)
	stale = !loop.EffectivelyMuted(now) && d.HasNextFire && now.Sub(d.NextFire) > cron.DefaultWatchlistStaleThreshold
	return d.LastFired, stale, true
}
