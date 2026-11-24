package api

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// Auto-name on idle (260822-q675; operator-session.md Phase 3 item 9). Window
// names go stale the moment an agent's work drifts from the spawn-time name;
// the natural moment to fix one is right after a work burst ends, when the
// transcript says what the tab actually did. This tracker rides the SAME SSE
// per-tick assembly seam as waitingPushTracker (its structure mirrors
// waiting_push.go: own mutex, clock + deliver seams for tests, pure decision,
// detached fan-out, post-loop retain) and detects the per-window transition
// busy → idle (busy = `active` or `waiting`; idle = exactly `idle`;
// empty/unknown is neither — a window with no agent hooks never triggers, and
// a first-ever observation is not a transition).
//
// On a transition it hands the server's operator window a fix-tab-name request
// through the SAME delivery core the HTTP endpoint uses (deliverOperatorRequest
// in operator.go) — run-kit owns the derivable trigger, the operator owns the
// rename judgment (the actuation-loop razor). Eligibility is derived entirely
// from the tick's already-fetched snapshot (no second FetchSessions): the
// server must HAVE an operator window, the subject must not BE the operator,
// and the subject must carry a session ref or an agent pane.
// No operator ⇒ the feature degrades to absent: nothing fires, nothing logs at
// error level.
//
// Rate limits: a per-window cooldown (stamps on every ATTEMPT — including one
// the delivery core skips because the operator is busy — so a busy operator
// never converts deferred transitions into a later burst), a per-server
// min-gap (the operator's AgentState lags a delivery by a hook round-trip, so
// back-to-back transitions must not double-deliver), and at most ONE candidate
// per server per tick (excess transitions are dropped, NOT stamped — their next
// transition may fire). In-memory only: no queue, no persistence, no retry — a
// daemon restart forgets cooldowns, exactly like the waiting-push episode map
// (Constitution II).

const (
	// autoNameCooldown is the per-window spacing between auto-name attempts —
	// an agent flapping busy/idle in a work loop does not spam rename requests.
	autoNameCooldown = 15 * time.Minute
	// autoNameMinGap is the per-server spacing between consecutive
	// auto-deliveries; the operator's rolled-up state lags an injection by a
	// hook round-trip, so without the gap two idle transitions within one hook
	// interval would double-deliver.
	autoNameMinGap = 60 * time.Second
)

// autoNameTracker holds the in-memory per-window transition/cooldown state.
// Guarded by its own mutex, independent of the hub lock (delivery fan-out runs
// outside any hub critical section).
type autoNameTracker struct {
	mu        sync.Mutex
	prev      map[string]string    // waitingKey(server, windowID) → last observed rollup AgentState
	attempted map[string]time.Time // waitingKey → last auto-request attempt (stamps even on busy-skip)
	lastSent  map[string]time.Time // server → last emitted auto-delivery candidate
	cooldown  time.Duration
	minGap    time.Duration
	now       func() time.Time // clock seam for tests
	// deliver is the delivery seam (waiting-push `notify` pattern), wired at hub
	// construction over deliverOperatorRequest; nil in test hubs — tracking and
	// live keys still advance, fan-out is skipped.
	deliver func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error
}

func newAutoNameTracker() *autoNameTracker {
	return &autoNameTracker{
		prev:      make(map[string]string),
		attempted: make(map[string]time.Time),
		lastSent:  make(map[string]time.Time),
		cooldown:  autoNameCooldown,
		minGap:    autoNameMinGap,
		now:       time.Now,
	}
}

// autoNameCandidate is the pure decision output (before fan-out): the ONE
// window that earns an auto-name request this tick, plus the operator window
// delivery targets.
type autoNameCandidate struct {
	subject  *tmux.WindowInfo
	operator *tmux.WindowInfo
}

// decide advances the tracker for one server's windows at `now` and returns the
// single candidate to deliver this tick (nil when none). Pure w.r.t. its inputs
// + the tracker's stored state (the only side effect is mutating the tracker
// maps, which ARE the transition/cooldown memory). Rules per window:
//   - first observation, idle→idle, ""→idle, busy→busy, →active/→waiting →
//     record state, no candidate.
//   - busy→idle, ineligible (no operator on the server / subject IS the
//     operator / no agent session or pane) → consumed silently, no stamp.
//   - busy→idle, eligible, inside the per-window cooldown or per-server min-gap
//     → suppressed, no stamp.
//   - busy→idle, eligible, limits clear, no candidate yet this tick → stamp
//     BOTH limits and emit. Later eligible transitions this tick are dropped
//     UNSTAMPED (their next busy→idle may fire).
func (t *autoNameTracker) decide(server string, wins []*tmux.WindowInfo) *autoNameCandidate {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()

	// The operator window comes from the same tick's snapshot — no fetch.
	var operator *tmux.WindowInfo
	for _, w := range wins {
		if w.Role == "operator" {
			operator = w
			break
		}
	}

	var cand *autoNameCandidate
	for _, w := range wins {
		key := waitingKey(server, w.WindowID)
		prev, seen := t.prev[key]
		t.prev[key] = w.AgentState
		if cand != nil || !seen {
			continue
		}
		wasBusy := prev == tmux.AgentStateActive || prev == tmux.AgentStateWaiting
		if !wasBusy || w.AgentState != tmux.AgentStateIdle {
			continue
		}
		// busy→idle transition. Eligibility, all derivable from this snapshot.
		if operator == nil || w.Role == "operator" || (w.AgentSessionRef == "" && fixTabNamePane(w.Panes) == "") {
			continue
		}
		if last, ok := t.attempted[key]; ok && now.Sub(last) < t.cooldown {
			continue
		}
		if last, ok := t.lastSent[server]; ok && now.Sub(last) < t.minGap {
			continue
		}
		// Stamp at DECISION time, not delivery: the cooldown must hold even when
		// the delivery core skips on a busy operator (reject-never-queue), so a
		// busy operator can't accumulate deferred transitions into a later burst.
		t.attempted[key] = now
		t.lastSent[server] = now
		cand = &autoNameCandidate{subject: w, operator: operator}
	}
	return cand
}

// retain drops tracked state whose key is not in `live` — reaping windows that
// disappeared (killed/closed) so the maps can't grow unboundedly and a re-used
// window id never inherits a stale previous-state/cooldown. Mirrors
// waitingPushTracker.retain: the sweep is SCOPED to servers that were
// successfully polled (or confirmed gone) this tick — a transiently-failing
// server contributes no live keys and keeps its state, so a recovery tick can't
// re-fire transitions from a wrongly-reset baseline. The per-server lastSent
// stamp is reaped when its server was reapable and has no live windows left.
func (t *autoNameTracker) retain(live map[string]bool, polled map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	reapKey := func(key string) bool {
		server, _, _ := strings.Cut(key, "\x00")
		return polled[server] && !live[key]
	}
	for key := range t.prev {
		if reapKey(key) {
			delete(t.prev, key)
			delete(t.attempted, key)
		}
	}
	for key := range t.attempted {
		if reapKey(key) {
			delete(t.attempted, key)
		}
	}
	liveServers := make(map[string]bool, len(live))
	for key := range live {
		server, _, _ := strings.Cut(key, "\x00")
		liveServers[server] = true
	}
	for server := range t.lastSent {
		if polled[server] && !liveServers[server] {
			delete(t.lastSent, server)
		}
	}
}

// advance runs one server's auto-name decision on the tick and fans out any
// resulting delivery. The pure decision (`decide`) runs SYNCHRONOUSLY — it only
// mutates the in-memory maps, no I/O — so the caller observes the tracker's
// state advance in-tick. Delivery (tmux subprocesses under the delivery core's
// own agentSendTotalBudget deadline) is fired off in a detached goroutine so it
// can never stall the SSE poll loop. Errors — including the routine busy-skip —
// are logged at debug and dropped: a background trigger has no surfacing
// channel, and the next eligible transition retries naturally after the
// cooldown. Returns the per-window live keys observed (so the caller can
// accumulate the cross-server live set for retain()). Takes no context: the
// pure decision needs none and the detached delivery deliberately uses
// context.Background() so it outlives the tick.
func (t *autoNameTracker) advance(server string, sess []sessions.ProjectSession) map[string]bool {
	var wins []*tmux.WindowInfo
	for si := range sess {
		for wi := range sess[si].Windows {
			wins = append(wins, &sess[si].Windows[wi])
		}
	}
	live := make(map[string]bool, len(wins))
	for _, w := range wins {
		live[waitingKey(server, w.WindowID)] = true
	}
	cand := t.decide(server, wins)
	if cand != nil && t.deliver != nil {
		// Detach the injection sequence from the hot path (fire-and-forget,
		// mirroring notifyWaiting). The candidate is a fresh struct from decide;
		// its window pointers ride the tick's snapshot, which the poll loop
		// treats as read-only after assembly.
		go func(c *autoNameCandidate) {
			if err := t.deliver(context.Background(), server, c.subject, c.operator); err != nil {
				slog.Debug("auto-name delivery skipped", "err", err, "server", server, "window", c.subject.WindowID)
			}
		}(cand)
	}
	return live
}
