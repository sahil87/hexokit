package api

import (
	"encoding/json"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// newTestWaitingTracker builds a tracker with a controllable clock and a short
// sustain, and no real push (the decision is pure; fan-out is tested via the
// notify seam elsewhere).
func newTestWaitingTracker(sustain time.Duration) (*waitingPushTracker, *time.Time) {
	base := time.Unix(1_000_000, 0)
	t := &waitingPushTracker{
		episodes: make(map[string]waitingEpisode),
		sustain:  sustain,
	}
	clock := base
	t.now = func() time.Time { return clock }
	return t, &clock
}

func win(server, id, name string, waiting bool) pushWindow {
	return pushWindow{server: server, windowID: id, name: name, waiting: waiting}
}

// TestWaitingPush_SustainedFiresOnce: a window that stays `waiting` past the
// sustain threshold fires exactly ONE push, and no further push while the
// episode continues.
func TestWaitingPush_SustainedFiresOnce(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	w := []pushWindow{win("s", "@1", "agent-win", true)}

	// t0: enters waiting — starts the run, no push.
	if got := tr.decide(w); len(got) != 0 {
		t.Fatalf("no push on first waiting tick, got %d", len(got))
	}
	// t0+10s: still under sustain — no push.
	*clock = clock.Add(10 * time.Second)
	if got := tr.decide(w); len(got) != 0 {
		t.Fatalf("no push under sustain, got %d", len(got))
	}
	// t0+16s: past sustain — exactly one push.
	*clock = clock.Add(6 * time.Second)
	got := tr.decide(w)
	if len(got) != 1 {
		t.Fatalf("expected 1 push past sustain, got %d", len(got))
	}
	if got[0].title != "agent-win" || got[0].body != "waiting for input" {
		t.Errorf("push payload = %+v, want title=agent-win body=waiting for input", got[0])
	}
	// t0+30s: same episode continues — no further push.
	*clock = clock.Add(14 * time.Second)
	if got := tr.decide(w); len(got) != 0 {
		t.Fatalf("no second push in the same episode, got %d", len(got))
	}
}

// TestWaitingPush_ShortEpisodeNoPush: a waiting run shorter than the sustain
// (the human answers a quick prompt) never pushes.
func TestWaitingPush_ShortEpisodeNoPush(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	waiting := []pushWindow{win("s", "@1", "w", true)}
	notWaiting := []pushWindow{win("s", "@1", "w", false)}

	tr.decide(waiting) // t0: starts run
	*clock = clock.Add(5 * time.Second)
	if got := tr.decide(notWaiting); len(got) != 0 { // resolved before sustain
		t.Fatalf("short episode must not push, got %d", len(got))
	}
	// Stays not-waiting well past the old threshold — still no push.
	*clock = clock.Add(30 * time.Second)
	if got := tr.decide(notWaiting); len(got) != 0 {
		t.Fatalf("idle/active never pushes, got %d", len(got))
	}
}

// TestWaitingPush_ReArmsOnNewEpisode: after a window leaves waiting and re-enters
// (a new episode), a second sustained waiting fires a fresh push.
func TestWaitingPush_ReArmsOnNewEpisode(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	waiting := []pushWindow{win("s", "@1", "w", true)}
	active := []pushWindow{win("s", "@1", "w", false)}

	// Episode 1: sustain → push.
	tr.decide(waiting)
	*clock = clock.Add(16 * time.Second)
	if got := tr.decide(waiting); len(got) != 1 {
		t.Fatalf("episode 1 must push, got %d", len(got))
	}
	// Agent finishes the turn → active clears the run (re-arm).
	*clock = clock.Add(5 * time.Second)
	tr.decide(active)
	// Episode 2: waits again and sustains → a fresh push.
	*clock = clock.Add(1 * time.Second)
	tr.decide(waiting) // starts episode 2's run
	*clock = clock.Add(16 * time.Second)
	if got := tr.decide(waiting); len(got) != 1 {
		t.Fatalf("episode 2 (new epoch) must push again, got %d", len(got))
	}
}

// TestWaitingPush_IdleAndActiveNeverPush: only `waiting` pushes; idle/active
// windows never do regardless of how long they persist.
func TestWaitingPush_IdleAndActiveNeverPush(t *testing.T) {
	tr, clock := newTestWaitingTracker(1 * time.Second)
	wins := []pushWindow{win("s", "@1", "a", false), win("s", "@2", "b", false)}
	for i := 0; i < 5; i++ {
		*clock = clock.Add(10 * time.Second)
		if got := tr.decide(wins); len(got) != 0 {
			t.Fatalf("non-waiting windows must never push, got %d on pass %d", len(got), i)
		}
	}
}

// TestWaitingPush_RetainReapsVanishedWindow: a window that disappears has its
// episode reaped by retain, so a re-created window id starts fresh (no stale
// pushed flag suppressing its first push).
func TestWaitingPush_RetainReapsVanishedWindow(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	w := []pushWindow{win("s", "@1", "w", true)}
	tr.decide(w)
	*clock = clock.Add(16 * time.Second)
	if got := tr.decide(w); len(got) != 1 {
		t.Fatalf("episode must push, got %d", len(got))
	}
	// Window vanishes: retain with an empty live set (but its server WAS polled)
	// reaps its episode.
	tr.retain(map[string]bool{}, map[string]bool{"s": true})
	if len(tr.episodes) != 0 {
		t.Fatalf("vanished window's episode must be reaped, got %d entries", len(tr.episodes))
	}
	// A re-created window with the same id starts a fresh episode and can push.
	tr.decide(w)
	*clock = clock.Add(16 * time.Second)
	if got := tr.decide(w); len(got) != 1 {
		t.Fatalf("re-created window must push again after reap, got %d", len(got))
	}
}

// TestWaitingPush_RetainSkipsUnpolledServer: a server that failed to poll this
// tick (transient fetch error) contributes NO live keys, but its episodes MUST
// survive the sweep — otherwise its waiting run is reset every failing tick and
// fires a duplicate push on recovery. retain only reaps keys of polled servers.
func TestWaitingPush_RetainSkipsUnpolledServer(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	// Two servers each have a sustained-waiting window that has already pushed.
	winsA := []pushWindow{win("a", "@1", "wa", true)}
	winsB := []pushWindow{win("b", "@1", "wb", true)}
	tr.decide(winsA)
	tr.decide(winsB)
	*clock = clock.Add(16 * time.Second)
	if got := tr.decide(winsA); len(got) != 1 {
		t.Fatalf("server a must push once, got %d", len(got))
	}
	if got := tr.decide(winsB); len(got) != 1 {
		t.Fatalf("server b must push once, got %d", len(got))
	}

	// This tick: server a polled fine (its window still live+waiting); server b's
	// fetch failed transiently — it contributes NO live keys and is NOT in the
	// polled set. Sweep must keep b's episode untouched.
	live := map[string]bool{waitingKey("a", "@1"): true}
	polled := map[string]bool{"a": true}
	tr.retain(live, polled)
	if _, ok := tr.episodes[waitingKey("b", "@1")]; !ok {
		t.Fatalf("unpolled server b's episode must survive the sweep")
	}
	// And b must NOT re-push once it recovers (its `pushed` flag was preserved).
	*clock = clock.Add(20 * time.Second)
	if got := tr.decide(winsB); len(got) != 0 {
		t.Fatalf("recovered server b must not duplicate-push, got %d", len(got))
	}
}

// TestWaitingPush_MultipleWindowsIndependent: two windows sustain independently;
// each fires its own single push with its own name.
func TestWaitingPush_MultipleWindowsIndependent(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	wins := []pushWindow{win("s", "@1", "one", true), win("s", "@2", "two", true)}
	tr.decide(wins)
	*clock = clock.Add(16 * time.Second)
	got := tr.decide(wins)
	if len(got) != 2 {
		t.Fatalf("both windows must push, got %d", len(got))
	}
	names := map[string]bool{got[0].title: true, got[1].title: true}
	if !names["one"] || !names["two"] {
		t.Errorf("each push carries its window name, got %+v", got)
	}
}

// TestWaitingPushURL: the deep-link URL strips the tmux `@` from the window id
// (mirroring the frontend's `windowIdToUrlSegment`) and is always the plain
// window URL. Server and segment are path-escaped.
func TestWaitingPushURL(t *testing.T) {
	cases := []struct {
		server, windowID string
		want             string
	}{
		{"default", "@1", "/default/1"},
		{"default", "@12", "/default/12"},
		// A server name with a reserved character is path-escaped.
		{"my server", "@3", "/my%20server/3"},
	}
	for _, c := range cases {
		if got := waitingPushURL(c.server, c.windowID); got != c.want {
			t.Errorf("waitingPushURL(%q,%q) = %q, want %q", c.server, c.windowID, got, c.want)
		}
	}
}

// TestWaitingPush_PlainWindowURL: a sustained-waiting window's push carries the
// plain window URL whether or not the window is chat-capable.
func TestWaitingPush_PlainWindowURL(t *testing.T) {
	tr, clock := newTestWaitingTracker(15 * time.Second)
	wins := []pushWindow{
		{server: "s", windowID: "@1", name: "chatty", waiting: true},
		{server: "s", windowID: "@2", name: "plain", waiting: true},
	}
	tr.decide(wins)
	*clock = clock.Add(16 * time.Second)
	got := tr.decide(wins)
	if len(got) != 2 {
		t.Fatalf("both windows must push, got %d", len(got))
	}
	byTitle := map[string]waitingPush{}
	for _, p := range got {
		byTitle[p.title] = p
	}
	if byTitle["chatty"].url != "/s/1" {
		t.Errorf("chat window url = %q, want /s/1", byTitle["chatty"].url)
	}
	if byTitle["plain"].url != "/s/2" {
		t.Errorf("plain window url = %q, want /s/2", byTitle["plain"].url)
	}
}

func TestWaitingPushBroadcastsNotifyEvent(t *testing.T) {
	isolatePush(t)
	hub := newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
	// Drain the detached notify goroutine before the TempDir HOME is removed —
	// the real push seam writes the state home, and a write racing cleanup
	// fails it.
	t.Cleanup(func() { hub.waitingPush.sends.Wait() })
	conn := newTestStateConn(hub, "waiting-client", 16)
	hub.replayGlobalSlots(conn)
	t.Cleanup(func() { hub.dropStateConn(conn) })

	clock := time.Unix(1_000_000, 0)
	hub.waitingPush.sustain = 15 * time.Second
	hub.waitingPush.now = func() time.Time { return clock }
	snapshot := []sessions.ProjectSession{{
		Windows: []tmux.WindowInfo{{
			WindowID:     "@5",
			Name:         "agent-win",
			AgentState:   tmux.AgentStateWaiting,
			AgentProvider: "codex",
		}},
	}}
	hub.waitingPush.notifyWaiting("utils2", snapshot)
	clock = clock.Add(16 * time.Second)
	hub.waitingPush.notifyWaiting("utils2", snapshot)

	select {
	case event := <-conn.ch:
		frame := event.renderEnvelope()
		var envelope eventFrame
		if err := json.Unmarshal(frame, &envelope); err != nil {
			t.Fatalf("decode event envelope: %v", err)
		}
		if envelope.Kind != kindGlobal || envelope.Type != "notify" {
			t.Fatalf("event = kind %q type %q, want global notify", envelope.Kind, envelope.Type)
		}
		var payload notifyPayload
		if err := json.Unmarshal(envelope.Data, &payload); err != nil {
			t.Fatalf("decode notify payload: %v", err)
		}
		if payload.Title != "agent-win" || payload.Body != "waiting for input" || payload.URL != "/utils2/5" {
			t.Errorf("notify payload = %+v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiting push did not broadcast a notify event")
	}
}
