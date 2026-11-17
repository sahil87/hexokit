package sessions

import (
	"context"
	"os"
	"sync"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/tmux"
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

// runInFlightFn reports whether an operator-loop run window is alive on the
// server — the evaluator's own busy signal (cron facts' RunInFlight).
var runInFlightFn = func(ctx context.Context, server string) (bool, error) {
	runs, err := tmux.ListOperatorRunWindows(ctx, server)
	return len(runs) > 0, err
}

// operatorLoopLiveness is the operator watchdog for a server whose clock is
// rk's `run: operator-loop` cron entry. rk's state file never carries
// last_tick_at — the loop's fires live in the cron delivery log — so the
// watchdog reads the loop entry instead. ok is false when the server has no
// loop entry (the typed-tick era); the caller then keeps the state file's
// last_tick_at rule. lastFired is the entry's newest delivery (0 = never).
//
// stale is measured from the entry's next due fire, not from lastFired: the
// backoff ladder legitimately idles up to its max (24m by default), longer
// than DefaultWatchlistStaleThreshold, so only a fire overdue by more than
// that threshold means the clock stopped. Two states are never stale: an
// effectively-muted entry (the clock was told to stop) and a run in flight
// (a launch writes no line and the evaluator skips the entry while the run
// window lives, so a long run leaves the next fire looking overdue). The
// run-window probe runs only when the entry would otherwise read stale, and
// a failed probe keeps that verdict. Read-only and tolerant: any unreadable
// file reads as "no loop entry".
func operatorLoopLiveness(ctx context.Context, server string, now time.Time) (lastFired int64, stale, ok bool) {
	loop, log, ok := readLoopFiles(server)
	if !ok {
		return 0, false, false
	}
	d := cron.DeriveEntry(loop, log, cron.TargetFacts{}, now)
	stale = !loop.EffectivelyMuted(now) && d.HasNextFire && now.Sub(d.NextFire) > cron.DefaultWatchlistStaleThreshold
	if stale {
		if inFlight, err := runInFlightFn(ctx, server); err == nil && inFlight {
			stale = false
		}
	}
	return d.LastFired, stale, true
}

// loopFilesStamp identifies one version of a server's cron entries file and
// delivery log by (mtime, size); a zero stamp is an absent log.
type loopFilesStamp struct {
	entriesMod, logMod   time.Time
	entriesSize, logSize int64
}

type loopFilesCached struct {
	stamp loopFilesStamp
	loop  cron.Entry
	found bool
	log   []cron.LogLine
}

// loopFilesCache holds the parsed loop entry and delivery log per server so a
// sessions fetch (every tmux event, behind the SSE hub's 500ms cache) re-parses
// the up-to-512KB log only after a write. It is a read cache over the files,
// never a source of truth: a changed stamp always re-reads.
var (
	loopFilesMu    sync.Mutex
	loopFilesCache = map[string]loopFilesCached{}
)

// readLoopFiles returns the server's loop entry and delivery log, or ok=false
// when the entries file is absent, unreadable, or holds no loop entry.
func readLoopFiles(server string) (cron.Entry, []cron.LogLine, bool) {
	dir, err := cron.DefaultDir()
	if err != nil {
		return cron.Entry{}, nil, false
	}
	entriesPath, err := cron.EntriesPath(dir, server)
	if err != nil {
		return cron.Entry{}, nil, false
	}
	logPath, err := cron.LogPath(dir, server)
	if err != nil {
		return cron.Entry{}, nil, false
	}
	entriesInfo, err := os.Stat(entriesPath)
	if err != nil {
		return cron.Entry{}, nil, false
	}
	stamp := loopFilesStamp{entriesMod: entriesInfo.ModTime(), entriesSize: entriesInfo.Size()}
	if logInfo, err := os.Stat(logPath); err == nil {
		stamp.logMod, stamp.logSize = logInfo.ModTime(), logInfo.Size()
	}

	loopFilesMu.Lock()
	cached, hit := loopFilesCache[entriesPath]
	loopFilesMu.Unlock()
	if hit && cached.stamp == stamp {
		return cached.loop, cached.log, cached.found
	}

	fresh := loopFilesCached{stamp: stamp}
	entries, _ := cron.LoadEntries(entriesPath)
	for _, e := range entries {
		if e.IsLoop() {
			fresh.loop, fresh.found = e, true
			break
		}
	}
	if fresh.found {
		fresh.log = cron.ReadLog(logPath)
	}
	loopFilesMu.Lock()
	loopFilesCache[entriesPath] = fresh
	loopFilesMu.Unlock()
	return fresh.loop, fresh.log, fresh.found
}
