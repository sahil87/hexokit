package cron

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"rk/internal/push"
	"rk/internal/tmux"
)

// tick.go — the tick orchestrator (R12–R15). Tick is short-lived, idempotent,
// and serialized by the non-blocking flock: flock → live-server set from
// tmux.ListServers (entry files for dead servers are skipped entirely — zero
// tmux commands target them, so a tick can never resurrect a dead socket) →
// load entries → gather facts → Evaluate → deliver through the caller-supplied
// Deliverer seam → append one log line per attempted delivery → persist the
// wake cursor.

// Outcome is what a Deliverer reports for one attempted delivery.
type Outcome struct {
	Status string // e.g. "delivered", "failed"
	Detail string
	// Held marks a deferred delivery (the when-idle gate found the target
	// busy). Held outcomes MUST NOT reach the delivery log: the log is the
	// anchor-derivation source for `every` and the backoff anchor-join streak,
	// so logging a held attempt would advance anchors and silently delay the
	// fire by a full period. Skipping the append makes re-evaluation the retry
	// mechanism — the fire recomputes as due on the next tick. The busy-pane
	// skip (skip-if-busy, outcome skipped-busy) is the deliberate
	// counter-example: a busy-pane outcome that MUST be logged because
	// advancing the anchor is its purpose.
	Held bool
}

func (o Outcome) String() string {
	if o.Detail == "" {
		return o.Status
	}
	return o.Status + ": " + o.Detail
}

// Deliverer is the delivery seam (R15): this change ships no delivery
// implementation (C3 substitutes the injection engine); tests use fakes.
type Deliverer interface {
	Deliver(ctx context.Context, fire Fire) Outcome
}

// Deps are Tick's seams. Zero values select the production defaults
// (DefaultDir, tmux.ListServers, the real tmux seam, time.Now, runRespawnExec,
// push.Notify). A nil Deliverer records outcome "no-deliverer" — the
// fire/log/cursor choreography still exercises.
type Deps struct {
	Dir         string
	Now         func() time.Time
	ListServers func(ctx context.Context) ([]string, error)
	Tmux        TmuxSeam
	Deliverer   Deliverer
	// Notifier backs the if_absent notify disposition. Fail-silent by
	// contract: a notify failure is a diagnostic, never a tick error.
	Notifier func(ctx context.Context, title, body, url string) error
	// RunRespawn executes an entry's caller-supplied respawn argv (role or
	// session targets with if_absent: respawn and a non-empty respawn). Exit
	// 0 within the timeout ⇒ the outcome is "respawned" (no delivery that
	// tick); anything else ⇒ "respawn-failed: <detail>". Nil selects the
	// production runRespawnExec.
	RunRespawn RunRespawnFunc
	// SessionRespawner brings a dead session target back (session targets
	// only — pane targets can never respawn). It is consulted only for an
	// if_absent: respawn entry whose target kind is session and whose respawn
	// argv is empty; nil keeps the notify-degrade path, byte-for-byte. The
	// returned Outcome is logged as the disposition (respawned /
	// respawn-failed), and the absent-fire rate cap applies as before.
	SessionRespawner func(ctx context.Context, fire Fire) Outcome
	// LoopRunner handles a due `run: operator-loop` fire (probe-and-diff, then
	// a run window) instead of the Deliverer. Nil logs `no-deliverer`, leaving
	// a daemon built without it unchanged. A Held outcome is not logged: the
	// run's single line is written later by transcription.
	LoopRunner func(ctx context.Context, fire Fire) Outcome
	// LoopTranscribe returns, once per swept server per tick before
	// evaluation, the log lines for finished run records not yet logged. The
	// tick appends them — it is the log's only writer — then reports each back
	// through LoopLogged. Nil disables transcription.
	LoopTranscribe func(ctx context.Context, server string) []LogLine
	// LoopLogged marks a transcribed run id as logged once its line is on
	// disk. Nil leaves records unmarked (they transcribe again).
	LoopLogged func(ctx context.Context, server, runID string)
	// LoopSeed reports whether rk's operator state file exists for the
	// server — the switch for seeding the loop entry (SeedOperatorLoop). Nil
	// disables seeding.
	LoopSeed func(ctx context.Context, server string) bool
}

// loopSeams groups the operator-loop seams handed to tickServer.
type loopSeams struct {
	run        func(context.Context, Fire) Outcome
	transcribe func(context.Context, string) []LogLine
	logged     func(context.Context, string, string)
	seed       func(context.Context, string) bool
}

// notifyDefault is the production Notifier: the daemon-side push fan-out.
func notifyDefault(ctx context.Context, title, body, url string) error {
	_, err := push.Notify(ctx, title, body, url)
	return err
}

// TickResult summarizes one tick. Held reports that the flock was held by
// another invoker (the clean, quiet no-op — callers that print a summary use
// it to stay silent); Servers counts the live servers actually swept.
type TickResult struct {
	Held    bool
	Servers int
	Fires   int
	Diags   []Diagnostic
}

// entrySlugs lists the server slugs with entry files in dir, in deterministic
// (filename) order. Non-slug file stems are skipped.
func entrySlugs(dir string) ([]string, error) {
	fis, err := os.ReadDir(dir) // sorted by name
	if err != nil {
		return nil, err
	}
	var slugs []string
	for _, fi := range fis {
		name := fi.Name()
		if fi.IsDir() || !strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".cursor.yaml") {
			continue
		}
		slug := strings.TrimSuffix(name, ".yaml")
		if ValidSlug(slug) {
			slugs = append(slugs, slug)
		}
	}
	return slugs, nil
}

// DefaultTargetRatePerHour is the per-target delivery cap: at or past this
// many counted deliveries to the same target within rateWindow, a fire is
// suppressed with a logged "rate-capped" outcome (and a Warn — the one cron
// signal above debug, since tripping must be visible). It bounds tick storms
// and delivery feedback loops.
const DefaultTargetRatePerHour = 30

// rateWindow is the trailing window the rate cap counts over.
const rateWindow = time.Hour

// countsTowardRate classifies a log outcome for the rate cap: delivery-attempt
// classes count (delivered/failed/notified/respawned); suppressions and
// recorded misses do not — and neither do skipped-busy (a dropped fire, not a
// delivery attempt) or rescheduled (schedule history, not delivery). Held
// outcomes never reach the log at all, so they are inherently excluded. The
// operator-loop classes that cost a run or a probe failure count; `no change`
// does not.
func countsTowardRate(outcome string) bool {
	switch {
	case outcome == "delivered":
		return true
	case strings.HasPrefix(outcome, "failed"):
		return true
	case outcome == "notified-absent":
		return true
	case strings.HasPrefix(outcome, "respawned"), strings.HasPrefix(outcome, "respawn-failed"):
		return true
	}
	return isLoopRateOutcome(outcome)
}

// rateCount counts trailing-window log lines for one cap key. Resolved fires
// key on the target pane (matching Target, across ALL entries aimed at that
// pane); absent fires key on the entry id (their lines carry no pane).
func rateCount(lines []LogLine, key string, byPane bool, now time.Time) int {
	cutoff := now.Add(-rateWindow).Unix()
	n := 0
	for _, l := range lines {
		if l.TS < cutoff {
			continue
		}
		match := l.Entry == key
		if byPane {
			match = l.Target == key
		}
		if match && countsTowardRate(l.Outcome) {
			n++
		}
	}
	return n
}

// Tick runs one evaluation sweep. A held lock is a clean, quiet exit
// (TickResult{Held: true}, nil) — the idempotent-tick contract makes
// skip-on-contention correct.
func Tick(ctx context.Context, deps Deps) (TickResult, error) {
	var res TickResult
	dir := deps.Dir
	if dir == "" {
		var err error
		dir, err = DefaultDir()
		if err != nil {
			return res, err
		}
	}
	if err := EnsureDir(dir); err != nil {
		return res, err
	}
	release, err := acquireLock(LockPath(dir))
	if err != nil {
		if errors.Is(err, ErrTickHeld) {
			slog.Debug("cron tick: lock held, skipping", "dir", dir)
			res.Held = true
			return res, nil
		}
		return res, err
	}
	defer release()

	now := time.Now
	if deps.Now != nil {
		now = deps.Now
	}
	listServers := deps.ListServers
	if listServers == nil {
		listServers = tmux.ListServers
	}
	seam := deps.Tmux
	if seam == nil {
		seam = realTmux{}
	}
	runRespawn := deps.RunRespawn
	if runRespawn == nil {
		runRespawn = runRespawnExec
	}
	notifier := deps.Notifier
	if notifier == nil {
		notifier = notifyDefault
	}

	// R12: the live-server filter comes first — every tmux touch below is for
	// a server in this set.
	liveServers, err := listServers(ctx)
	if err != nil {
		return res, err
	}
	live := make(map[string]bool, len(liveServers))
	for _, s := range liveServers {
		live[s] = true
	}

	slugs, err := entrySlugs(dir)
	if err != nil {
		return res, err
	}
	loop := loopSeams{run: deps.LoopRunner, transcribe: deps.LoopTranscribe, logged: deps.LoopLogged, seed: deps.LoopSeed}
	slugs = withSeedableServers(ctx, slugs, liveServers, loop.seed)
	for _, slug := range slugs {
		if !live[slug] {
			// Dead server: skip entirely — diagnostic only, ZERO tmux commands.
			res.Diags = append(res.Diags, Diagnostic{Server: slug, Reason: "server-not-live",
				Detail: "entry file skipped: server not in the live set"})
			continue
		}
		fires, diags := tickServer(ctx, slug, dir, now(), seam, deps.Deliverer, notifier, runRespawn, deps.SessionRespawner, loop)
		res.Servers++
		res.Fires += fires
		res.Diags = append(res.Diags, diags...)
	}
	for _, d := range res.Diags {
		slog.Debug("cron tick diagnostic", "server", d.Server, "entry", d.EntryID, "reason", d.Reason, "detail", d.Detail)
	}
	return res, nil
}

// tickServer runs the per-server pipeline: load → facts → Evaluate → deliver →
// log → GC → cursor. A per-file failure is a diagnostic, never an aborted tick.
func tickServer(ctx context.Context, slug, dir string, now time.Time, seam TmuxSeam, deliverer Deliverer, notifier func(context.Context, string, string, string) error, runRespawn RunRespawnFunc, sessionRespawner func(context.Context, Fire) Outcome, loop loopSeams) (fires int, diags []Diagnostic) {
	entriesPath, err := EntriesPath(dir, slug)
	if err != nil {
		return 0, []Diagnostic{{Server: slug, Reason: "path-invalid", Detail: err.Error()}}
	}
	diags = append(diags, seedLoop(ctx, slug, dir, now, loop.seed)...)
	entries, loadDiags := LoadEntries(entriesPath)
	for _, d := range loadDiags {
		d.Server = slug
		diags = append(diags, d)
	}

	facts := GatherFacts(ctx, slug, entries, seam)
	diags = append(diags, facts.Diags...)

	logPath, err := LogPath(dir, slug)
	if err != nil {
		return fires, append(diags, Diagnostic{Server: slug, Reason: "path-invalid", Detail: err.Error()})
	}
	cursorPath, err := CursorPath(dir, slug)
	if err != nil {
		return fires, append(diags, Diagnostic{Server: slug, Reason: "path-invalid", Detail: err.Error()})
	}
	cursor, _ := ReadWakeCursor(cursorPath) // absent/corrupt = cold start

	logLines := ReadLog(logPath)

	// appendLine mirrors every on-disk append into logLines so the rate cap
	// (and the evaluation below) sees lines written earlier in this same tick.
	// It reports whether the line is on disk.
	appendLine := func(entryID string, line LogLine) bool {
		if err := AppendLog(logPath, line); err != nil {
			diags = append(diags, Diagnostic{Server: slug, EntryID: entryID, Reason: "log-append-failed", Detail: err.Error()})
			return false
		}
		logLines = append(logLines, line)
		fires++
		return true
	}

	// Finished operator-loop runs go first, before evaluation: the tick is the
	// cron log's only writer, so run outcomes reach it only here, and a run's
	// line must already be in the log the evaluator reads (it re-anchors the
	// loop's ladder, so the entry is not due again in this same tick). A run is
	// marked logged only once its line is on disk: either appended just now or
	// already present (a crash between append and mark) — a failed append
	// leaves the record unmarked so the next tick retries it.
	if loop.transcribe != nil {
		for _, line := range loop.transcribe(ctx, slug) {
			onDisk := runLogged(logLines, line.Run)
			if !onDisk {
				line.TS = now.Unix()
				onDisk = appendLine(line.Entry, line)
			}
			if onDisk && loop.logged != nil && line.Run != "" {
				loop.logged(ctx, slug, line.Run)
			}
		}
	}

	// gcLog is the pre-disposition log view the orphan-GC pass derives from.
	// The capped full-slice keeps the appendLine mirror from writing into it.
	gcLog := logLines[:len(logLines):len(logLines)]
	eval := Evaluate(EvalInput{
		Server:  slug,
		Now:     now,
		Entries: entries,
		Facts:   facts.Targets,
		States:  facts.States,
		Log:     logLines,
		Cursor:  cursor,

		RunPanes:    facts.RunPanes,
		RunInFlight: facts.RunInFlight,
	})
	diags = append(diags, eval.Diags...)

	// rateCapped reports (and records) a suppression when the target is at or
	// past the per-target cap. The rate-capped line IS appended: it is the
	// derivation source for future surfaces, and advancing the anchor
	// self-throttles the storm.
	rateCapped := func(fire Fire, key string, byPane bool) bool {
		if rateCount(logLines, key, byPane, now) < DefaultTargetRatePerHour {
			return false
		}
		slog.Warn("cron delivery rate-capped", "server", slug, "entry", fire.Entry.ID, "target", fire.PaneID, "cap_key", key, "cap", DefaultTargetRatePerHour)
		appendLine(fire.Entry.ID, LogLine{
			TS:      now.Unix(),
			Entry:   fire.Entry.ID,
			Target:  fire.PaneID,
			Reason:  string(fire.Reason),
			Outcome: "rate-capped",
		})
		return true
	}

	// Missed cron occurrences: one `missed` line per entry per gap, independent
	// of target resolution and if_absent (schedule history, not delivery). The
	// append advances the entry's anchor past the gap, so subsequent ticks log
	// nothing until the next occurrence.
	for _, fire := range eval.Missed {
		appendLine(fire.Entry.ID, LogLine{
			TS:      now.Unix(),
			Entry:   fire.Entry.ID,
			Reason:  string(fire.Reason),
			Outcome: "missed",
		})
	}

	for _, fire := range eval.Fires {
		// A loop fire keys the rate cap on its entry id (it has no target
		// pane) and routes to the LoopRunner seam instead of the Deliverer.
		isLoop := fire.Entry.IsLoop()
		capKey, byPane := fire.PaneID, true
		if isLoop {
			capKey, byPane = fire.Entry.ID, false
		}
		if rateCapped(fire, capKey, byPane) {
			continue
		}
		outcome := Outcome{Status: "no-deliverer"}
		switch {
		case isLoop:
			if loop.run != nil {
				outcome = loop.run(ctx, fire)
			}
		case deliverer != nil:
			outcome = deliverer.Deliver(ctx, fire)
		}
		if outcome.Held {
			// Held outcomes never reach the log (see Outcome.Held) — the hold
			// is realized as cross-tick retry: anchors stay put, so the fire
			// recomputes as due next tick.
			diags = append(diags, Diagnostic{Server: slug, EntryID: fire.Entry.ID, Reason: "delivery-held", Detail: outcome.String()})
			continue
		}
		appendLine(fire.Entry.ID, LogLine{
			TS:      now.Unix(),
			Entry:   fire.Entry.ID,
			Target:  fire.PaneID,
			Reason:  string(fire.Reason),
			Outcome: outcome.String(),
		})
	}

	// Due-but-absent fires: apply the entry's if_absent policy. Every
	// disposition appends one log line, so the anchor advances and a dead
	// target produces one line per due period, not one per tick.
	// respawnedThisTick marks entries whose disposition came back
	// resolved-class (a successful respawn): the gathered facts and gcLog both
	// predate the respawn, so without this the GC pass below would expire the
	// entry in the same tick its agent was just revived.
	respawnedThisTick := map[string]bool{}
	for _, fire := range eval.Absent {
		if rateCapped(fire, fire.Entry.ID, false) {
			continue
		}
		line := LogLine{TS: now.Unix(), Entry: fire.Entry.ID, Reason: string(fire.Reason)}
		isRespawn := fire.Entry.IfAbsent == IfAbsentRespawn
		switch {
		case isRespawn && len(fire.Entry.Respawn) > 0 &&
			(fire.Entry.Target.Kind == TargetRole || fire.Entry.Target.Kind == TargetSession):
			// Caller-supplied argv: run it under the respawn timeout from the
			// user's home dir (the daemon has no project cwd; its env is
			// already TMUX-scrubbed by internal/tmux's init). Exit 0 ⇒
			// respawned — NO delivery this tick (a fresh session has no tick
			// convention in context; the payload lands on the next resolved
			// fire). Pane targets never reach this branch: a dead pane id
			// never re-resolves, so a respawn could never land its payload.
			argv := RespawnArgv(fire.Entry, fire.Server)
			rctx, cancel := context.WithTimeout(ctx, DefaultRespawnTimeout)
			out, err := func() ([]byte, error) {
				home, herr := os.UserHomeDir()
				if herr != nil {
					return nil, fmt.Errorf("resolving home dir: %w", herr)
				}
				return runRespawn(rctx, argv, home)
			}()
			cancel()
			if err != nil {
				line.Outcome = "respawn-failed: " + respawnDetail(err, out)
			} else {
				line.Outcome = respawnSuccessOutcome(out)
			}
		case isRespawn && fire.Entry.Target.Kind == TargetSession && sessionRespawner != nil:
			// Session-target respawn without a respawn command routes to the
			// session seam (closed-ring plain resume), same logged-outcome
			// contract as the argv path. A nil seam (and pane targets, always)
			// falls through to the notify-degrade.
			line.Outcome = sessionRespawner(ctx, fire).String()
		case fire.Entry.IfAbsent == IfAbsentNotify || isRespawn:
			if isRespawn {
				// A respawn policy with no command to run (and no session
				// seam): degrade to notify, loudly.
				diags = append(diags, Diagnostic{Server: slug, EntryID: fire.Entry.ID, Reason: "respawn-uncommanded",
					Detail: "if_absent respawn has no respawn command; degraded to notify"})
			}
			name := fire.Entry.Name
			if name == "" {
				name = fire.Entry.ID
			}
			if err := notifier(ctx, "cron: "+name, "target absent on "+slug, operatorPushURL(ctx, slug, seam)); err != nil {
				diags = append(diags, Diagnostic{Server: slug, EntryID: fire.Entry.ID, Reason: "notify-failed", Detail: err.Error()})
			}
			line.Outcome = "notified-absent"
		default:
			line.Outcome = "skipped-absent"
		}
		if resolvedOutcome(line.Outcome) {
			respawnedThisTick[fire.Entry.ID] = true
		}
		appendLine(fire.Entry.ID, line)
	}

	// Orphan GC (R5), after the dispositions under the same flock: expire an
	// unpinned session/pane entry whose target is unresolved in THIS tick's
	// facts and whose derived orphan streak reaches the TTL. The streak
	// derives from gcLog, the PRE-disposition view: a just-appended absent
	// line would otherwise reset a never-fired entry's streak to now,
	// defeating the created_by.at fallback. For an entry that already has a
	// trailing run both views agree — this tick's lines only extend the run's
	// newest end, and OrphanedSince takes the run's OLDEST timestamp.
	for _, e := range entries {
		if e.Pinned || e.IsLoop() || (e.Target.Kind != TargetSession && e.Target.Kind != TargetPane) {
			continue // pinned never expires; role targets never orphan; loop entries have no target
		}
		if tf, ok := facts.Targets[e.ID]; !ok || tf.Resolved() {
			continue // resolved this tick is never expired, whatever the history
		}
		if respawnedThisTick[e.ID] {
			continue // a successful respawn is resolution the stale facts can't see
		}
		since := OrphanedSince(gcLog, e)
		if since <= 0 || now.Unix()-since < int64(OrphanTTL/time.Second) {
			continue
		}
		removed, err := Remove(dir, slug, e.ID)
		if err != nil {
			diags = append(diags, Diagnostic{Server: slug, EntryID: e.ID, Reason: "orphan-expire-failed", Detail: err.Error()})
			continue
		}
		if !removed {
			continue
		}
		// The expired-orphan line is the audit trail — expiry is never silent,
		// and never push-notified.
		slog.Warn("cron entry expired as orphan", "server", slug, "entry", e.ID, "orphaned_since", since)
		appendLine(e.ID, LogLine{TS: now.Unix(), Entry: e.ID, Outcome: "expired-orphan"})
	}

	if err := WriteWakeCursor(cursorPath, eval.NextCursor); err != nil {
		diags = append(diags, Diagnostic{Server: slug, Reason: "cursor-write-failed", Detail: err.Error()})
	}
	return fires, diags
}
