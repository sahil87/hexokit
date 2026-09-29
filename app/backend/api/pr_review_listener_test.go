package api

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/prreview"
	"rk/internal/prstatus"
	"rk/internal/sessions"
	"rk/internal/tmux"
)

// listenerFixture builds a tracker with a recording deliver closure and a
// deterministic clock.
type listenerFixture struct {
	tracker   *prReviewListenerTracker
	mu        sync.Mutex
	delivered []prListenEntry
	err       error
	disarmed  []string
	clock     time.Time
}

func newListenerFixture(threads []prstatus.ReviewThread) *listenerFixture {
	f := &listenerFixture{clock: time.Unix(1_700_000_000, 0)}
	f.tracker = newPRReviewListenerTracker()
	f.tracker.now = func() time.Time { return f.clock }
	f.tracker.unhandled = func(string) []prstatus.ReviewThread { return threads }
	f.tracker.enabled = func() bool { return true }
	f.tracker.disarm = func(server, windowID string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.disarmed = append(f.disarmed, server+"/"+windowID)
	}
	f.tracker.deliver = func(_ context.Context, entry prListenEntry) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.delivered = append(f.delivered, entry)
		return f.err
	}
	return f
}

func (f *listenerFixture) deliveredThreads() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.delivered))
	for _, entry := range f.delivered {
		out = append(out, entry.threadID)
	}
	return out
}

// advanceAndSettle runs one tick and waits for the detached delivery goroutine
// the reservation spawned.
func (f *listenerFixture) advanceAndSettle(t *testing.T, snapshot []sessions.ProjectSession) {
	t.Helper()
	before := len(f.deliveredThreads())
	f.tracker.advance("default", snapshot)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		inFlight := len(f.delivered)
		f.mu.Unlock()
		if inFlight > before {
			// Give finishDelivery its turn at the lock.
			time.Sleep(5 * time.Millisecond)
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func listenSnapshot(agentState string, armed bool) []sessions.ProjectSession {
	prURL := "https://github.com/acme/tool/pull/7"
	window := tmux.WindowInfo{WindowID: "@1", Name: "work", AgentState: agentState, PrListen: armed}
	if armed {
		window.PrURL = &prURL
	} else {
		window.PrURL = &prURL
		window.PrListen = false
	}
	return []sessions.ProjectSession{{Name: "s", Windows: []tmux.WindowInfo{window}}}
}

func digest(ids ...string) []prstatus.ReviewThread {
	out := make([]prstatus.ReviewThread, 0, len(ids))
	for _, id := range ids {
		out = append(out, prstatus.ReviewThread{ID: id})
	}
	return out
}

// One thread per idle observation, in order — a twenty-comment review must not
// arrive as a wall.
func TestPRListenerDeliversOneThreadPerIdleObservation(t *testing.T) {
	f := newListenerFixture(digest("T1", "T2", "T3"))
	snapshot := listenSnapshot(tmux.AgentStateIdle, true)

	f.advanceAndSettle(t, snapshot)
	if got := f.deliveredThreads(); len(got) != 1 || got[0] != "T1" {
		t.Fatalf("first tick delivered %v, want [T1]", got)
	}
	// A second tick inside the min gap delivers nothing: the rolled-up agent
	// state lags an injection by a hook round-trip.
	f.advanceAndSettle(t, snapshot)
	if got := f.deliveredThreads(); len(got) != 1 {
		t.Fatalf("second tick inside the min gap delivered %v", got)
	}
	f.clock = f.clock.Add(prListenMinGap + time.Second)
	f.advanceAndSettle(t, snapshot)
	f.clock = f.clock.Add(prListenMinGap + time.Second)
	f.advanceAndSettle(t, snapshot)
	if got := f.deliveredThreads(); len(got) != 3 || got[1] != "T2" || got[2] != "T3" {
		t.Fatalf("delivered %v, want [T1 T2 T3] in order", got)
	}
}

func TestPRListenerHoldsWhileTheAgentIsBusy(t *testing.T) {
	for _, state := range []string{tmux.AgentStateActive, tmux.AgentStateWaiting} {
		f := newListenerFixture(digest("T1"))
		f.advanceAndSettle(t, listenSnapshot(state, true))
		if got := f.deliveredThreads(); len(got) != 0 {
			t.Errorf("state %q delivered %v, want nothing", state, got)
		}
		if f.tracker.pending("default", "@1") != 1 {
			t.Errorf("state %q: the thread was dropped rather than held", state)
		}
	}
}

func TestPRListenerIgnoresDisarmedAndPRlessWindows(t *testing.T) {
	f := newListenerFixture(digest("T1"))
	f.advanceAndSettle(t, listenSnapshot(tmux.AgentStateIdle, false))
	if got := f.deliveredThreads(); len(got) != 0 {
		t.Errorf("a disarmed window delivered %v", got)
	}

	// Armed but with no PR: the surface is PR-backed only, so there is nothing
	// to listen to.
	snapshot := listenSnapshot(tmux.AgentStateIdle, true)
	snapshot[0].Windows[0].PrURL = nil
	f.advanceAndSettle(t, snapshot)
	if got := f.deliveredThreads(); len(got) != 0 {
		t.Errorf("a PR-less window delivered %v", got)
	}
}

// The settings key gates every tick, so a flip takes effect without a restart.
func TestPRListenerSettingsGate(t *testing.T) {
	f := newListenerFixture(digest("T1"))
	enabled := false
	f.tracker.enabled = func() bool { return enabled }

	f.advanceAndSettle(t, listenSnapshot(tmux.AgentStateIdle, true))
	if got := f.deliveredThreads(); len(got) != 0 {
		t.Fatalf("delivered %v while the settings gate was off", got)
	}
	enabled = true
	f.advanceAndSettle(t, listenSnapshot(tmux.AgentStateIdle, true))
	if got := f.deliveredThreads(); len(got) != 1 {
		t.Errorf("delivered %v after the gate opened, want one", got)
	}
}

// Busy and absent are "not now": the entry goes back to the FRONT of the queue
// so nothing is lost and nothing is marked.
func TestPRListenerRequeuesBusyAndAbsentRejections(t *testing.T) {
	for _, rejection := range []error{errPRListenBusy, errPRListenAbsent} {
		f := newListenerFixture(digest("T1"))
		f.err = rejection
		f.advanceAndSettle(t, listenSnapshot(tmux.AgentStateIdle, true))
		if f.tracker.pending("default", "@1") != 1 {
			t.Errorf("%v: the entry was consumed, want requeued", rejection)
		}
	}
}

// Three consecutive failures trip the circuit breaker and disarm the window.
func TestPRListenerAutoDisarmsAfterRepeatedFailures(t *testing.T) {
	f := newListenerFixture(digest("T1", "T2", "T3", "T4"))
	f.err = errors.New("pane is wedged")
	snapshot := listenSnapshot(tmux.AgentStateIdle, true)
	for i := 0; i < prListenFailureLimit; i++ {
		f.advanceAndSettle(t, snapshot)
		f.clock = f.clock.Add(prListenMinGap + time.Second)
	}
	f.mu.Lock()
	disarmed := append([]string(nil), f.disarmed...)
	f.mu.Unlock()
	if len(disarmed) != 1 || disarmed[0] != "default/@1" {
		t.Errorf("disarmed = %v, want [default/@1]", disarmed)
	}
}

func TestPRListenerRateCapAndTTL(t *testing.T) {
	f := newListenerFixture(digest("T1"))
	state := &prListenWindow{}
	now := f.clock
	for i := 0; i < prListenRatePerHour; i++ {
		state.sends = append(state.sends, now.Add(-time.Duration(i)*time.Minute))
	}
	state.queue = []prListenEntry{{threadID: "T1", queuedAt: now}}
	window := &tmux.WindowInfo{WindowID: "@1", AgentState: tmux.AgentStateIdle}
	f.tracker.deliver = func(context.Context, prListenEntry) error { return nil }
	if entry := f.tracker.reserveLocked(state, window, now); entry != nil {
		t.Errorf("reserved %+v at the hourly cap, want nil", entry)
	}

	// An entry older than the TTL is dropped rather than delivered late.
	state.queue = []prListenEntry{{threadID: "T1", queuedAt: now.Add(-2 * prListenTTL)}}
	f.tracker.expireLocked(state, "default", "@1", now)
	if len(state.queue) != 0 {
		t.Errorf("queue after expiry = %+v, want empty", state.queue)
	}
}

// A queue never grows past the cap, and re-deriving from the digest never
// duplicates a thread already queued or in flight.
func TestPRListenerQueueIsBoundedAndDeduped(t *testing.T) {
	ids := make([]string, 0, prListenQueueCap+5)
	for i := 0; i < prListenQueueCap+5; i++ {
		ids = append(ids, "T"+string(rune('a'+i)))
	}
	f := newListenerFixture(digest(ids...))
	f.tracker.deliver = nil // track without fanning out
	snapshot := listenSnapshot(tmux.AgentStateIdle, true)
	f.tracker.advance("default", snapshot)
	f.tracker.advance("default", snapshot)
	if got := f.tracker.pending("default", "@1"); got != prListenQueueCap {
		t.Errorf("queue depth = %d, want the cap %d", got, prListenQueueCap)
	}
}

// retain reaps only servers whose tick was observed AND whose socket is gone —
// a transient fetch failure must not drop a queue.
func TestPRListenerRetainReapsOnlyConfirmedDeadServers(t *testing.T) {
	f := newListenerFixture(digest("T1"))
	f.tracker.deliver = nil
	f.tracker.advance("default", listenSnapshot(tmux.AgentStateIdle, true))
	if f.tracker.pending("default", "@1") == 0 {
		t.Fatal("nothing queued")
	}
	f.tracker.retain(map[string]bool{"default": true}, map[string]bool{"default": true})
	if f.tracker.pending("default", "@1") == 0 {
		t.Error("a live server's queue was reaped")
	}
	f.tracker.retain(map[string]bool{}, map[string]bool{"default": true})
	if f.tracker.pending("default", "@1") != 0 {
		t.Error("a confirmed-dead server's queue survived")
	}
}

// The payload carries the whole thread — the agent needs the argument, not just
// the last line — with every body in a dynamic bare fence.
func TestRenderPRReviewThreadPayload(t *testing.T) {
	got := renderPRReviewThread(prReviewThreadFacts{
		PRNumber: 7,
		PRURL:    "https://github.com/acme/tool/pull/7",
		Repo:     "acme/tool",
		Path:     "a.go",
		Side:     prreview.SideRight,
		Line:     12,
		Hunk:     "@@ -1,2 +1,2 @@\n-old\n+new",
		Comments: []prreview.Comment{
			{Author: "reviewer", Body: "this is wrong"},
			{Author: "", Body: "a fence ``` inside the body"},
		},
		ThreadURL: "https://github.com/acme/tool/pull/7#discussion_r42",
	})
	for _, want := range []string{
		"acme/tool#7",
		"https://github.com/acme/tool/pull/7",
		// The agent is asked to RESOLVE the thread, so it needs the thread's
		// own address, not just the PR's.
		"thread:       https://github.com/acme/tool/pull/7#discussion_r42",
		"a.go:12 (right/new side)",
		"@@ -1,2 +1,2 @@",
		"@reviewer wrote:",
		"A reviewer wrote:",
		"this is wrong",
		"resolve the thread",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("payload missing %q:\n%s", want, got)
		}
	}
	// The body containing a triple backtick must not be able to close its own
	// fence — the dynamic fence grows past it.
	if !strings.Contains(got, "````") {
		t.Errorf("a body containing ``` did not widen its fence:\n%s", got)
	}
}

func TestSideWordNamesGitHubsOwnSides(t *testing.T) {
	if got := sideWord(prreview.SideLeft); got != "left/old" {
		t.Errorf("sideWord(L) = %q", got)
	}
	if got := sideWord(prreview.SideRight); got != "right/new" {
		t.Errorf("sideWord(R) = %q", got)
	}
}

// MARKING IS ORDERED AFTER DELIVERY. A failed injection must leave the thread
// UNMARKED so it re-dispatches next tick — marking first would strand the
// comment silently, with the thread reading as claimed while nothing had been
// said to any agent.
func TestPRListenerDoesNotMarkOnAFailedInjection(t *testing.T) {
	fastAgentSendProbe(t)
	prURL := "https://github.com/acme/tool/pull/7"
	window := tmux.WindowInfo{
		WindowID: "@1", Name: "work", AgentState: tmux.AgentStateIdle,
		PrListen: true, PrURL: &prURL,
		Panes: []tmux.PaneInfo{{PaneID: "%1", IsActive: true, AgentProvider: "claude", AgentSessionRef: "ref"}},
	}
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s", Windows: []tmux.WindowInfo{window}}}}
	// A capture that never echoes the pasted text fails the novelty probe.
	ops := &mockTmuxOps{capturePaneResult: "some unrelated pane output"}

	var calls callRecorder
	_, server := newPRReviewServer(t, ops, ghStub(&calls))
	server.sessions = sf

	err := server.deliverPRReviewThread(context.Background(), prListenEntry{
		server: "default", windowID: "@1", prURL: prURL, threadID: "T1",
	})
	if err == nil {
		t.Fatal("delivery reported success despite a failed probe")
	}
	if ops.sendEnterCalled {
		t.Error("Enter was sent despite a failed probe")
	}
	for _, call := range calls.all() {
		if strings.Contains(call, "/reactions") {
			t.Fatalf("the 👀 marker was posted after a failed injection: %s", call)
		}
	}
}

// A thread that resolved, went outdated, or turned out to be suggestion-only
// between the digest and the delivery is dropped WITHOUT marking and without
// reaching any agent — the detail document is the authority, and the digest can
// lag it by up to one collector tick.
func TestPRListenerRechecksThreadStateAgainstTheDetailDocument(t *testing.T) {
	prURL := "https://github.com/acme/tool/pull/7"
	window := tmux.WindowInfo{
		WindowID: "@1", AgentState: tmux.AgentStateIdle, PrListen: true, PrURL: &prURL,
		Panes: []tmux.PaneInfo{{PaneID: "%1", IsActive: true, AgentProvider: "claude", AgentSessionRef: "ref"}},
	}
	sf := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s", Windows: []tmux.WindowInfo{window}}}}

	states := map[string]string{
		"resolved":        `"isResolved":true,"isOutdated":false`,
		"outdated":        `"isResolved":false,"isOutdated":true`,
		"suggestion-only": `"isResolved":false,"isOutdated":false`,
	}
	for name, flags := range states {
		t.Run(name, func(t *testing.T) {
			body := "fix this"
			if name == "suggestion-only" {
				body = "```suggestion\\nreturn nil\\n```"
			}
			var calls callRecorder
			ops := &mockTmuxOps{}
			base := ghStub(&calls)
			_, server := newPRReviewServer(t, ops, func(stdin []byte, args ...string) ([]byte, error) {
				if strings.Contains(strings.Join(args, " "), "graphql") {
					calls.add(strings.Join(args, " ") + "\x00" + string(stdin))
					return []byte(`{"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{"reviewThreads":{"nodes":[
						{"id":"T1",` + flags + `,"path":"a.go","line":2,"diffSide":"RIGHT",
						 "comments":{"nodes":[{"id":"C1","databaseId":101,"body":"` + body + `","createdAt":"2026-09-19T10:00:00Z",
						   "author":{"login":"reviewer"},"reactions":{"totalCount":0}}]}}
					]}}}}}`), nil
				}
				return base(stdin, args...)
			})
			server.sessions = sf

			if err := server.deliverPRReviewThread(context.Background(), prListenEntry{
				server: "default", windowID: "@1", prURL: prURL, threadID: "T1",
			}); err != nil {
				t.Fatalf("delivery = %v, want a quiet drop", err)
			}
			if len(ops.setAgentBufferTexts) != 0 {
				t.Error("the payload was injected for an ineligible thread")
			}
			for _, call := range calls.all() {
				if strings.Contains(call, "/reactions") {
					t.Fatalf("an ineligible thread was marked: %s", call)
				}
			}
		})
	}
}

// An absent target window HOLDS without marking, so nothing is lost. v1 does
// not respawn.
func TestPRListenerAbsentTargetHoldsWithoutMarking(t *testing.T) {
	var calls callRecorder
	_, server := newPRReviewServer(t, &mockTmuxOps{}, ghStub(&calls))
	server.sessions = &mockSessionFetcher{result: nil}

	err := server.deliverPRReviewThread(context.Background(), prListenEntry{
		server: "default", windowID: "@gone", prURL: "https://github.com/acme/tool/pull/7", threadID: "T1",
	})
	if !errors.Is(err, errPRListenAbsent) {
		t.Fatalf("delivery = %v, want errPRListenAbsent", err)
	}
	for _, call := range calls.all() {
		if strings.Contains(call, "/reactions") {
			t.Fatalf("an absent target was marked: %s", call)
		}
	}
}

// A tripped breaker LATCHES. The disarm write is best-effort, so a failed one
// must not let `advance` rebuild a fresh zero-failure state on the next tick
// and re-trip forever; only the option actually going false clears it.
func TestPRListenerBreakerLatchesUntilTheOptionClears(t *testing.T) {
	f := newListenerFixture(digest("T1", "T2", "T3", "T4", "T5"))
	f.err = errors.New("pane is wedged")
	// The disarm seam does nothing — the write "failed".
	f.tracker.disarm = func(string, string) {}
	armed := listenSnapshot(tmux.AgentStateIdle, true)

	for i := 0; i < prListenFailureLimit; i++ {
		f.advanceAndSettle(t, armed)
		f.clock = f.clock.Add(prListenMinGap + time.Second)
	}
	tripped := len(f.deliveredThreads())

	// Several more ticks with the option STILL set deliver nothing.
	for i := 0; i < 3; i++ {
		f.advanceAndSettle(t, armed)
		f.clock = f.clock.Add(prListenMinGap + time.Second)
	}
	if got := len(f.deliveredThreads()); got != tripped {
		t.Errorf("delivered %d after the breaker tripped, want it latched at %d", got, tripped)
	}

	// The option going false drops the state; re-arming starts clean.
	f.err = nil
	f.tracker.advance("default", listenSnapshot(tmux.AgentStateIdle, false))
	f.advanceAndSettle(t, armed)
	if got := len(f.deliveredThreads()); got != tripped+1 {
		t.Errorf("delivered %d after a disarm/re-arm cycle, want %d", got, tripped+1)
	}
}

// A gh outage HOLDS. It is not evidence that this window is broken, so it must
// requeue rather than count toward the circuit breaker — disarming a user's tab
// over someone else's network is the wrong response.
func TestPRListenerGhOutageHoldsRatherThanTripping(t *testing.T) {
	f := newListenerFixture(digest("T1"))
	f.err = errPRListenUnavailable
	snapshot := listenSnapshot(tmux.AgentStateIdle, true)
	for i := 0; i < prListenFailureLimit+1; i++ {
		f.advanceAndSettle(t, snapshot)
		f.clock = f.clock.Add(prListenMinGap + time.Second)
	}
	f.mu.Lock()
	disarmed := len(f.disarmed)
	f.mu.Unlock()
	if disarmed != 0 {
		t.Errorf("the breaker tripped on a gh outage (disarmed %d times), want none", disarmed)
	}
	if f.tracker.pending("default", "@1") != 1 {
		t.Error("the thread was consumed by a gh outage, want it requeued")
	}
}
