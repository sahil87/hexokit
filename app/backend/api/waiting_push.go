package api

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// Web Push on sustained waiting (260706-y1ar; status-pyramid.md § Attention
// Propagation — the Web Push row). When a window's rolled-up agentState has been
// `waiting` (an agent blocked on a HUMAN — the most notification-worthy state)
// sustained for at least waitingPushSustain, send exactly ONE push per waiting
// episode. `idle`/`active` never push.
//
// Episode model: a waiting EPISODE is a maximal run of consecutive `waiting`
// ticks for one window. The tracker stamps when a window first entered its
// current waiting run, and whether that episode has already pushed. It pushes
// once the run has lasted >= the sustain threshold; any non-waiting tick clears
// the run so the NEXT `waiting` starts a fresh episode that can push again
// (re-arm on state change). This is poll-derived, in-memory only — no durable
// store beyond the hub's episode map (Constitution II applies to durable state;
// this mirrors the in-memory prstatus/metrics collectors). It rides the SSE
// per-tick assembly seam where the rolled-up window state already exists — no
// new goroutine, no new poller.

const (
	// waitingPushSustain is how long a window must stay `waiting` before its one
	// push fires. Sized so a quick permission prompt the human answers within a
	// few seconds does not notify — only a genuinely-blocked agent does.
	waitingPushSustain = 15 * time.Second
)

// waitingKey identifies a window across servers (window ids are unique only
// within a server).
func waitingKey(server, windowID string) string { return server + "\x00" + windowID }

// waitingPushURL builds the deep-link target for a waiting-window push: the
// plain window URL `/{server}/{N}` where the URL segment is the window id's
// numeric part (the tmux `@N` sans `@`, per `windowIdToUrlSegment` in
// router.tsx); the window resolves its own layout on load. Server and the
// numeric segment are path-escaped so a name with reserved characters stays a
// valid same-origin relative URL.
func waitingPushURL(server, windowID string) string {
	seg := strings.TrimPrefix(windowID, "@")
	return "/" + url.PathEscape(server) + "/" + url.PathEscape(seg)
}

// waitingEpisode is the per-window tracked state: when the current waiting run
// began and whether it has already pushed. Absent from the map == the window is
// not currently waiting.
type waitingEpisode struct {
	since  time.Time // first tick this window was seen `waiting` in the current run
	pushed bool      // whether this episode has already sent its one push
}

// waitingPushTracker holds the in-memory per-window waiting episodes. Guarded by
// its own mutex so it is independent of the hub lock (the push fan-out runs
// outside any hub critical section).
type waitingPushTracker struct {
	mu       sync.Mutex
	episodes map[string]waitingEpisode
	sustain  time.Duration
	now      func() time.Time                                         // clock seam for tests
	notify   func(ctx context.Context, title, body, url string) error // push seam for tests
	// sends counts in-flight detached notify goroutines. Production code never
	// waits on it; tests drain it before returning so the fire-and-forget
	// writer cannot outlive a t.TempDir HOME (the push store lives under
	// ~/.local/state/hexokit, and a write racing the TempDir cleanup fails it
	// "directory not empty").
	sends sync.WaitGroup
}

func newWaitingPushTracker(
	notify func(ctx context.Context, title, body, url string) error,
) *waitingPushTracker {
	return &waitingPushTracker{
		episodes: make(map[string]waitingEpisode),
		sustain:  waitingPushSustain,
		now:      time.Now,
		notify:   notify,
	}
}

// waitingPush is one decided push (the pure decision output, before fan-out).
// `url` is the deep-link target for the notification click (always the plain
// window URL).
type waitingPush struct {
	title string
	body  string
	url   string
}

// pushWindow is the minimal per-window shape the decision needs — extracted so
// the decision is pure and unit-testable without building full ProjectSessions.
type pushWindow struct {
	server   string
	windowID string
	name     string
	waiting  bool
}

// decide advances the episode tracker for one server's windows at `now` and
// returns the pushes to send this tick. Pure w.r.t. its inputs + the tracker's
// stored state (the only side effect is mutating the tracker map, which IS the
// episode memory). Rules per window:
//   - waiting, no run yet          → start the run (stamp `since`), no push.
//   - waiting, run < sustain       → keep waiting, no push.
//   - waiting, run >= sustain, !pushed → PUSH once, mark pushed.
//   - waiting, run >= sustain, pushed  → already pushed this episode, no push.
//   - not waiting                  → clear the run (re-arm for the next episode).
//
// Windows are keyed per (server, windowID); a server's windows that are absent
// from `wins` this tick are NOT cleared here — the caller sweeps stale keys via
// `retain` after collecting the full live set (a window that vanished stops
// being waiting and its episode is reaped, so a re-created window id can't
// inherit a stale "pushed" flag).
func (t *waitingPushTracker) decide(wins []pushWindow) []waitingPush {
	now := t.now()
	var out []waitingPush
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, w := range wins {
		key := waitingKey(w.server, w.windowID)
		if !w.waiting {
			delete(t.episodes, key) // re-arm: a fresh waiting run can push again
			continue
		}
		ep, ok := t.episodes[key]
		if !ok {
			t.episodes[key] = waitingEpisode{since: now}
			continue
		}
		if !ep.pushed && now.Sub(ep.since) >= t.sustain {
			out = append(out, waitingPush{
				title: w.name,
				body:  "waiting for input",
				url:   waitingPushURL(w.server, w.windowID),
			})
			ep.pushed = true
			t.episodes[key] = ep
		}
	}
	return out
}

// retain drops tracked episodes whose key is not in `live` — reaping windows
// that disappeared (killed/closed) so a reused window id never inherits a stale
// episode. The sweep is SCOPED to servers that were successfully polled this
// tick (`polled`): an episode is reaped only when its server was polled AND its
// key is not live. A server whose fetch failed transiently (a non-IsServerGone
// error) contributes no live keys, so scoping the sweep leaves its episodes
// untouched — otherwise its windows' `since`/`pushed` state would be wrongly
// reset every failing tick, re-arming them and firing a DUPLICATE push the
// moment the server recovers. Episode keys are `server\x00windowID`, so the
// server is recovered by splitting on the NUL separator.
func (t *waitingPushTracker) retain(live map[string]bool, polled map[string]bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for key := range t.episodes {
		server, _, _ := strings.Cut(key, "\x00")
		if polled[server] && !live[key] {
			delete(t.episodes, key)
		}
	}
}

// pushWindowsForServer flattens a server's rolled-up sessions into the minimal
// per-window shape the decision consumes. A window is `waiting` when its
// server-side rolled-up AgentState (waiting > active > idle) is `waiting`.
func pushWindowsForServer(server string, sess []sessions.ProjectSession) []pushWindow {
	var out []pushWindow
	for si := range sess {
		for wi := range sess[si].Windows {
			w := &sess[si].Windows[wi]
			out = append(out, pushWindow{
				server:   server,
				windowID: w.WindowID,
				name:     w.Name,
				waiting:  w.AgentState == tmux.AgentStateWaiting,
			})
		}
	}
	return out
}

// notifyWaiting runs one server's waiting-push decision and fans out any
// resulting pushes. The pure decision (`decide`) runs SYNCHRONOUSLY — it only
// mutates the in-memory episode map, no I/O — so the caller observes the
// tracker's state advance in-tick. The actual push sends are fired off in a
// detached goroutine (fire-and-forget) so a slow/hung Web Push endpoint can
// never stall the SSE poll loop, which is a documented ZERO-network hot path
// (each SSE tick is serialized per window with a short timeout). Push errors are
// logged, never surfaced, matching the /api/notify posture. Returns the
// per-window live keys observed (so the caller can accumulate the cross-server
// live set for retain()). Takes no context: the pure decision needs none and
// the detached send deliberately uses context.Background() so it outlives the
// tick.
func (t *waitingPushTracker) notifyWaiting(server string, sess []sessions.ProjectSession) map[string]bool {
	wins := pushWindowsForServer(server, sess)
	live := make(map[string]bool, len(wins))
	for _, w := range wins {
		live[waitingKey(w.server, w.windowID)] = true
	}
	pushes := t.decide(wins)
	if len(pushes) > 0 && t.notify != nil {
		// Detach the network sends from the hot path. Snapshot `pushes` (it is a
		// fresh slice from decide, not shared) and hand it to a goroutine. Using
		// context.Background() rather than the tick ctx: the send outlives the
		// tick by design, so it must not be cancelled when the poll iteration
		// returns.
		t.sends.Add(1)
		go func(ps []waitingPush) {
			defer t.sends.Done()
			for _, p := range ps {
				if err := t.notify(context.Background(), p.title, p.body, p.url); err != nil {
					slog.Warn("waiting-push notify failed", "err", err, "window", p.title)
				}
			}
		}(pushes)
	}
	return live
}
