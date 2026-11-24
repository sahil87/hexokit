package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

func newTestOperatorQueueTracker() (*operatorQueueTracker, *time.Time) {
	clock := time.Unix(1_000_000, 0)
	tracker := newOperatorQueueTracker()
	tracker.now = func() time.Time { return clock }
	return tracker, &clock
}

type operatorQueueSessionFetcher struct {
	mu     sync.Mutex
	result []sessions.ProjectSession
	err    error
	calls  int
}

func (f *operatorQueueSessionFetcher) FetchSessions(context.Context, string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.result, f.err
}

func (f *operatorQueueSessionFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *operatorQueueSessionFetcher) setResult(result []sessions.ProjectSession, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.result = result
	f.err = err
}

func operatorQueueSnapshot(state string) []sessions.ProjectSession {
	return []sessions.ProjectSession{
		{Name: "work", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "one", AgentState: tmux.AgentStateIdle},
			{WindowID: "@2", Name: "two", AgentState: tmux.AgentStateIdle},
		}},
		{Name: "operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", AgentState: state,
				Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true, AgentProvider: "claude", AgentSessionRef: testTranscriptRef}}},
		}},
	}
}

func operatorQueueState(tracker *operatorQueueTracker, server string) ([]queuedOperatorRequest, bool) {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	queue := append([]queuedOperatorRequest(nil), tracker.queues[server]...)
	return queue, tracker.inFlight[server] != nil
}

func waitForOperatorQueueSettled(t *testing.T, tracker *operatorQueueTracker, server string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, inFlight := operatorQueueState(tracker, server)
		if !inFlight {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("operator queue delivery did not settle")
}

func TestOperatorQueueEnqueueCoalescesAndBounds(t *testing.T) {
	tracker, clock := newTestOperatorQueueTracker()
	request := queuedOperatorRequest{template: "fix-tab-name", windowID: "@1", text: "same"}
	if err := tracker.enqueue("srv", request); err != nil {
		t.Fatal(err)
	}
	firstQueuedAt := tracker.queues["srv"][0].enqueuedAt
	*clock = clock.Add(10 * time.Minute)
	if err := tracker.enqueue("srv", request); err != nil {
		t.Fatal(err)
	}
	queue, _ := operatorQueueState(tracker, "srv")
	if len(queue) != 1 {
		t.Fatalf("coalesced queue length = %d, want 1", len(queue))
	}
	if !queue[0].enqueuedAt.Equal(firstQueuedAt) {
		t.Fatalf("duplicate refreshed enqueuedAt: got %s, want %s", queue[0].enqueuedAt, firstQueuedAt)
	}
	for i := 2; i <= operatorQueueCap; i++ {
		if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: fmt.Sprintf("@%d", i)}); err != nil {
			t.Fatalf("enqueue %d: %v", i, err)
		}
	}
	if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: "@9"}); !errors.Is(err, errOperatorQueueFull) {
		t.Fatalf("overflow error = %v, want queue-full", err)
	}
}

func TestOperatorQueueAdvanceIsFIFOLevelTriggeredAndPaced(t *testing.T) {
	tracker, clock := newTestOperatorQueueTracker()
	delivered := make(chan string, 2)
	tracker.deliver = func(_ context.Context, _ string, request queuedOperatorRequest) error {
		delivered <- request.windowID
		return nil
	}
	for _, id := range []string{"@1", "@2"} {
		if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: id}); err != nil {
			t.Fatal(err)
		}
	}

	tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
	if got := <-delivered; got != "@1" {
		t.Fatalf("first delivery = %s, want @1", got)
	}
	waitForOperatorQueueSettled(t, tracker, "srv")
	tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
	select {
	case got := <-delivered:
		t.Fatalf("delivery inside min-gap = %s", got)
	case <-time.After(25 * time.Millisecond):
	}
	*clock = clock.Add(operatorQueueMinGap)
	tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
	if got := <-delivered; got != "@2" {
		t.Fatalf("second delivery = %s, want @2", got)
	}
	waitForOperatorQueueSettled(t, tracker, "srv")

	for _, state := range []string{tmux.AgentStateActive, tmux.AgentStateWaiting, ""} {
		if err := tracker.enqueue("blocked", queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err != nil {
			t.Fatal(err)
		}
		tracker.advance("blocked", operatorQueueSnapshot(state))
		queue, inFlight := operatorQueueState(tracker, "blocked")
		if len(queue) != 1 || inFlight {
			t.Fatalf("state %q drained: queue=%d inFlight=%v", state, len(queue), inFlight)
		}
		tracker.queues["blocked"] = nil
	}
}

func TestOperatorQueueAdvancePreservesQueueWithoutDeliver(t *testing.T) {
	tracker, _ := newTestOperatorQueueTracker()
	if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err != nil {
		t.Fatal(err)
	}
	tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
	queue, inFlight := operatorQueueState(tracker, "srv")
	if len(queue) != 1 || inFlight {
		t.Fatalf("nil deliver drained: queue=%d inFlight=%v", len(queue), inFlight)
	}
}

func TestOperatorQueueExpiresWhileOperatorWaits(t *testing.T) {
	tracker, clock := newTestOperatorQueueTracker()
	called := false
	tracker.deliver = func(context.Context, string, queuedOperatorRequest) error {
		called = true
		return nil
	}
	if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(operatorQueueTTL + time.Second)
	tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateWaiting))
	queue, inFlight := operatorQueueState(tracker, "srv")
	if len(queue) != 0 || inFlight || called {
		t.Fatalf("expired request survived: queue=%d inFlight=%v delivered=%v", len(queue), inFlight, called)
	}
}

func TestOperatorQueueDeliveryFailurePolicy(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)

	t.Run("busy returns entry to head", func(t *testing.T) {
		fetcher := &operatorQueueSessionFetcher{result: operatorSessions(tmux.AgentStateActive)}
		ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
		server := &Server{logger: slog.Default(), sessions: fetcher, tmux: ops, hostname: "host"}
		tracker, clock := newTestOperatorQueueTracker()
		tracker.deliver = server.operatorQueueDeliver()
		for _, id := range []string{"@1", "@2"} {
			if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: id}); err != nil {
				t.Fatal(err)
			}
		}
		tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
		waitForOperatorQueueSettled(t, tracker, "srv")
		queue, _ := operatorQueueState(tracker, "srv")
		if len(queue) != 2 || queue[0].windowID != "@1" || queue[1].windowID != "@2" {
			t.Fatalf("busy-race queue = %+v, want @1 then @2", queue)
		}
		if got := fetcher.callCount(); got != 1 {
			t.Fatalf("fresh fetch calls = %d, want 1", got)
		}
		if len(ops.agentSendCalls) != 0 {
			t.Fatalf("busy delivery reached injection: %v", ops.agentSendCalls)
		}

		fetcher.setResult(operatorSessions(tmux.AgentStateIdle), nil)
		*clock = clock.Add(operatorQueueMinGap)
		tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
		waitForOperatorQueueSettled(t, tracker, "srv")
		queue, _ = operatorQueueState(tracker, "srv")
		if len(queue) != 1 || queue[0].windowID != "@2" {
			t.Fatalf("recovered queue = %+v, want only @2", queue)
		}
		if got := fetcher.callCount(); got != 2 {
			t.Fatalf("fresh fetch calls after recovery = %d, want 2", got)
		}
	})

	t.Run("fetch failure returns entry to head", func(t *testing.T) {
		fetcher := &operatorQueueSessionFetcher{err: errors.New("sessions unavailable")}
		server := &Server{logger: slog.Default(), sessions: fetcher, tmux: &mockTmuxOps{}, hostname: "host"}
		tracker, _ := newTestOperatorQueueTracker()
		tracker.deliver = server.operatorQueueDeliver()
		for _, id := range []string{"@1", "@2"} {
			if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: id}); err != nil {
				t.Fatal(err)
			}
		}
		tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
		waitForOperatorQueueSettled(t, tracker, "srv")
		queue, _ := operatorQueueState(tracker, "srv")
		if len(queue) != 2 || queue[0].windowID != "@1" || queue[1].windowID != "@2" {
			t.Fatalf("fetch-failure queue = %+v, want @1 then @2", queue)
		}
		if got := fetcher.callCount(); got != 1 {
			t.Fatalf("fresh fetch calls = %d, want 1", got)
		}
	})

	t.Run("injection failure consumes entry", func(t *testing.T) {
		fetcher := &operatorQueueSessionFetcher{result: operatorSessions(tmux.AgentStateIdle)}
		server := &Server{
			logger:   slog.Default(),
			sessions: fetcher,
			tmux:     &mockTmuxOps{setAgentBufferErr: errors.New("set buffer failed")},
			hostname: "host",
		}
		tracker, _ := newTestOperatorQueueTracker()
		tracker.deliver = server.operatorQueueDeliver()
		for _, id := range []string{"@1", "@2"} {
			if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: id}); err != nil {
				t.Fatal(err)
			}
		}
		tracker.advance("srv", operatorQueueSnapshot(tmux.AgentStateIdle))
		waitForOperatorQueueSettled(t, tracker, "srv")
		queue, _ := operatorQueueState(tracker, "srv")
		if len(queue) != 1 || queue[0].windowID != "@2" {
			t.Fatalf("failure queue = %+v, want only @2", queue)
		}
		if got := fetcher.callCount(); got != 1 {
			t.Fatalf("fresh fetch calls = %d, want 1", got)
		}
	})
}

func TestOperatorQueueRetainReapsOnlyObservedDeadServers(t *testing.T) {
	tracker, _ := newTestOperatorQueueTracker()
	if err := tracker.enqueue("dead", queuedOperatorRequest{template: "brief-me"}); err != nil {
		t.Fatal(err)
	}
	if err := tracker.enqueue("transient", queuedOperatorRequest{template: "brief-me"}); err != nil {
		t.Fatal(err)
	}
	tracker.lastSent["dead"] = tracker.now()
	tracker.lastSent["transient"] = tracker.now()
	tracker.retain(map[string]bool{}, map[string]bool{"dead": true})
	if _, ok := tracker.queues["dead"]; ok {
		t.Fatal("dead server queue was not reaped")
	}
	if _, ok := tracker.lastSent["dead"]; ok {
		t.Fatal("dead server min-gap stamp was not reaped")
	}
	if len(tracker.queues["transient"]) != 1 {
		t.Fatal("transiently unobserved server queue was reaped")
	}
}

func TestOperatorQueueWiring(t *testing.T) {
	testHub := newSSEHub(&mockSessionFetcher{}, nil, nil, nil)
	if testHub.getOperatorQueue() == nil {
		t.Fatal("test hub did not construct the operator queue")
	}
	if testHub.getOperatorQueue().deliver != nil {
		t.Fatal("test hub unexpectedly wired production delivery")
	}

	server := &Server{logger: slog.Default(), sessions: &mockSessionFetcher{}, tmux: &mockTmuxOps{}, hostname: "host"}
	server.initSSEHub()
	if server.sseHub.getOperatorQueue() == nil || server.sseHub.getOperatorQueue().deliver == nil {
		t.Fatal("server hub did not wire operator queue delivery")
	}
}

func TestOperatorQueueDeliveryRendersFromFreshSnapshot(t *testing.T) {
	fastAgentSendProbe(t)
	fresh := operatorSessions(tmux.AgentStateIdle)
	subject := &fresh[0].Windows[0]
	subject.Name = "fresh-name"
	subject.AgentProvider, subject.AgentSessionRef = "", ""
	subject.Panes = []tmux.PaneInfo{{PaneID: "%3", AgentState: tmux.AgentStateIdle}}
	fetcher := &operatorQueueSessionFetcher{result: fresh}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
	server := &Server{logger: slog.Default(), sessions: fetcher, tmux: ops, hostname: "host"}
	tracker, _ := newTestOperatorQueueTracker()
	tracker.deliver = server.operatorQueueDeliver()
	if err := tracker.enqueue("srv", queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err != nil {
		t.Fatal(err)
	}
	tickSnapshot := operatorQueueSnapshot(tmux.AgentStateIdle)
	tickSnapshot[0].Windows[0].Name = "tick-name"
	tracker.advance("srv", tickSnapshot)
	waitForOperatorQueueSettled(t, tracker, "srv")
	if got := fetcher.callCount(); got != 1 {
		t.Fatalf("fresh fetch calls = %d, want 1", got)
	}
	if !strings.Contains(ops.setAgentBufferText, `currently "fresh-name"`) ||
		!strings.Contains(ops.setAgentBufferText, "tmux capture-pane -p -t %3 -S -30") {
		t.Fatalf("prompt did not use fresh snapshot facts:\n%s", ops.setAgentBufferText)
	}
	if strings.Contains(ops.setAgentBufferText, "tick-name") {
		t.Fatalf("prompt retained tick snapshot facts:\n%s", ops.setAgentBufferText)
	}
}

func TestOperatorQueueDeliveryRevalidatesGates(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	deliver := func(snapshot []sessions.ProjectSession, request queuedOperatorRequest) error {
		server := &Server{
			logger:   slog.Default(),
			sessions: &operatorQueueSessionFetcher{result: snapshot},
			tmux:     &mockTmuxOps{},
			hostname: "host",
		}
		return server.operatorQueueDeliver()(context.Background(), "srv", request)
	}

	t.Run("subject gone", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		snapshot[0].Windows = nil
		if err := deliver(snapshot, queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err == nil {
			t.Fatal("missing subject was delivered")
		}
	})

	t.Run("subject became operator", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		snapshot[0].Windows[0].Role = "operator"
		if err := deliver(snapshot, queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"}); err == nil {
			t.Fatal("operator subject was delivered")
		}
	})

	t.Run("subject lost agent context", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		subject := &snapshot[0].Windows[0]
		subject.AgentProvider, subject.AgentSessionRef = "", ""
		subject.Panes = []tmux.PaneInfo{{PaneID: "%1"}}
		err := deliver(snapshot, queuedOperatorRequest{template: "fix-tab-name", windowID: "@1"})
		var rejection *operatorReject
		if !errors.As(err, &rejection) || rejection.msg != "no agent pane or transcript for this window" {
			t.Fatalf("want an agent context rejection, got %v", err)
		}
	})

	t.Run("nothing remains waiting", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		if err := deliver(snapshot, queuedOperatorRequest{template: "whats-stuck"}); err == nil {
			t.Fatal("empty waiting scope was delivered")
		}
	})

	t.Run("session died", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		if err := deliver(snapshot, queuedOperatorRequest{template: "update-annotations", session: "gone"}); err == nil {
			t.Fatal("dead session scope was delivered")
		}
	})

	t.Run("operator agent pane disappeared", func(t *testing.T) {
		snapshot := operatorSessions(tmux.AgentStateIdle)
		snapshot[1].Windows[0].Panes = nil
		if err := deliver(snapshot, queuedOperatorRequest{template: "brief-me"}); err == nil {
			t.Fatal("sessionless operator received a delivery")
		}
	})
}
