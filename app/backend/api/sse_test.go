package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/metrics"
	"rk/internal/ports"
	"rk/internal/sessions"
	"rk/internal/tmux"
	"rk/internal/updatecheck"
)

// addTestClient wires a state-socket-style test connection into the hub: it
// creates a stateConn wrapping `ch`, registers it for host-global fan-out, adds
// a per-server subscription record (sharing `ch`), and replays the cached global
// slots — mirroring the real hello + subscribe flow. It returns the per-server
// subscription record whose `.ch` is the shared channel, so both per-server
// events (via h.clients) and host-global events (via h.stateConns) land on it.
// Since the state-socket migration (260716-qf3j) host-global events fan out over
// connections, so a bare sseClient not registered as a stateConn would miss them.
func (h *sseHub) addTestClient(ch chan hubEvent, server string) *sseClient {
	sc := &stateConn{ch: ch, subs: map[string]*sseClient{}}
	rec := &sseClient{ch: ch, server: server, conn: sc, expanded: map[string]bool{}}
	sc.subs[server] = rec
	h.addClient(rec)
	h.replayGlobalSlots(sc)
	return rec
}

// drainConnEvents non-blockingly drains a channel and renders each event to its
// SSE-style string form (hubEvent.String) so existing string-based assertions
// keep working against the new hubEvent channel.
func drainConnEvents(ch chan hubEvent) []string {
	var out []string
	for len(ch) > 0 {
		out = append(out, (<-ch).String())
	}
	return out
}

// slowSessionFetcher returns canned data with a small delay.
type slowSessionFetcher struct {
	result []sessions.ProjectSession
}

func (s *slowSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	return s.result, nil
}

// The initial-snapshot delivery (subscribe → ack with sessions snapshot) is
// covered end-to-end over the real WebSocket in state_ws_test.go
// (TestStateWS_SubscribeServerAcksWithSnapshot). The former SSE-endpoint
// TestSSEInitialSnapshot was retired with GET /api/sessions/stream.

// goneSessionFetcher returns a tmux.IsServerGone-matching error so the poll
// loop reaps the server. result is returned for any server not in goneServers.
type goneSessionFetcher struct {
	mu          sync.Mutex
	goneServers map[string]bool
	result      []sessions.ProjectSession
}

func (f *goneSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.goneServers[server] {
		return nil, fmt.Errorf("exit status 1: error connecting to /tmp/tmux-1001/%s (No such file or directory)", server)
	}
	return f.result, nil
}

func TestSSEHubReapsDeadServer(t *testing.T) {
	sf := &goneSessionFetcher{goneServers: map[string]bool{"dead": true}}
	hub := newSSEHub(sf, nil, nil, nil)
	// Short safety interval so the poll loop cycles quickly for the test.
	hub.safetyInterval = 50 * time.Millisecond

	client := &sseClient{ch: make(chan hubEvent, 8), server: "dead"}
	hub.addClient(client) // starts the poll goroutine

	// The poll loop's first tick fetches "dead", gets an IsServerGone error,
	// reaps it, and emits server-gone to the registered client.
	gotGone := false
	deadline := time.After(2 * time.Second)
	for !gotGone {
		select {
		case ev := <-client.ch:
			if strings.HasPrefix(ev.String(), "event: server-gone") {
				gotGone = true
			}
		case <-deadline:
			t.Fatal("client did not receive server-gone event")
		}
	}

	// After reaping its last client, the server must be gone from h.clients
	// and the poll goroutine must stop (it observes zero clients).
	stoppedPolling := false
	for i := 0; i < 40; i++ {
		hub.mu.RLock()
		_, present := hub.clients["dead"]
		polling := hub.polling
		hub.mu.RUnlock()
		if !present && !polling {
			stoppedPolling = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !stoppedPolling {
		hub.mu.RLock()
		_, present := hub.clients["dead"]
		polling := hub.polling
		hub.mu.RUnlock()
		t.Fatalf("server not reaped / poll not stopped: present=%v polling=%v", present, polling)
	}

	// All per-server maps must be cleared for the reaped server.
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	if _, ok := hub.cache["dead"]; ok {
		t.Error("cache not cleared for reaped server")
	}
	if _, ok := hub.previousJSON["dead"]; ok {
		t.Error("previousJSON not cleared for reaped server")
	}
	if _, ok := hub.previousRealSessions["dead"]; ok {
		t.Error("previousRealSessions not cleared for reaped server")
	}
	if _, ok := hub.orderBootstrapAttempts["dead"]; ok {
		t.Error("orderBootstrapAttempts not cleared for reaped server")
	}
	if _, ok := hub.previousOrderJSON["dead"]; ok {
		t.Error("previousOrderJSON not cleared for reaped server")
	}
}

// TestSSEHubMetricsOnlyClientNotReaped proves the server-neutral, metrics-only
// client (key = metricsOnlyServer) receives the server-independent metrics
// broadcast and is NEVER session-polled or reaped — even when every real server
// the fetcher knows about is IsServerGone. This backs the Host host-console
// home (`/`), which must show host health with zero attached tmux servers.
func TestSSEHubMetricsOnlyClientNotReaped(t *testing.T) {
	// Any real server would be reaped, but the metrics-only key must survive.
	sf := &goneSessionFetcher{goneServers: map[string]bool{"anything": true}}
	mc := metrics.NewCollector(2500 * time.Millisecond) // pre-fills a valid zero snapshot
	hub := newSSEHub(sf, mc, nil, nil)
	hub.safetyInterval = 50 * time.Millisecond // cycle the poll loop quickly

	client := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer) // starts the poll goroutine

	// The client must receive an `event: metrics` and must NOT receive a
	// `server-gone` (it has no server to reap).
	gotMetrics := false
	deadline := time.After(2 * time.Second)
	for !gotMetrics {
		select {
		case ev := <-client.ch:
			s := ev.String()
			if strings.HasPrefix(s, "event: server-gone") {
				t.Fatal("metrics-only client received server-gone (was wrongly reaped)")
			}
			if strings.HasPrefix(s, "event: metrics") {
				gotMetrics = true
			}
		case <-deadline:
			t.Fatal("metrics-only client did not receive an event: metrics")
		}
	}

	// The metrics-only key must remain registered (not reaped) and polling
	// continues (the client is still connected).
	hub.mu.RLock()
	_, present := hub.clients[metricsOnlyServer]
	hub.mu.RUnlock()
	if !present {
		t.Error("metrics-only client was reaped from h.clients")
	}
}

// TestSSEHubServicesBroadcast proves the server-neutral, metrics-only client
// (key = metricsOnlyServer) receives the server-independent `event: services`
// broadcast that carries the host's listening ports — the discovery half of the
// Host host-console services zone.
func TestSSEHubServicesBroadcast(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	svc := ports.NewCollector(2500 * time.Millisecond) // pre-fills a valid snapshot
	hub := newSSEHub(sf, nil, svc, nil)
	hub.safetyInterval = 50 * time.Millisecond // cycle the poll loop quickly

	client := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer) // starts the poll goroutine

	gotServices := false
	deadline := time.After(2 * time.Second)
	for !gotServices {
		select {
		case ev := <-client.ch:
			s := ev.String()
			if strings.HasPrefix(s, "event: services") {
				// The payload must carry a JSON object with a (possibly empty)
				// services array — never `null`.
				if !strings.Contains(s, `"services"`) {
					t.Fatalf("services event missing services field: %q", s)
				}
				gotServices = true
			}
		case <-deadline:
			t.Fatal("metrics-only client did not receive an event: services")
		}
	}
}

// TestSSEHubCodeServerBroadcast proves the host-global `event: code-server`
// signal (260811-k3vp; portless payload since 260811-a2bo): when a port is
// resolved the poll loop broadcasts {"reachable"} from the TTL-cached probe to
// EVERY connection (including the metrics-only sentinel), flips to
// reachable:false after the listener dies and the TTL expires, and stays
// silent when unresolvable.
func TestSSEHubCodeServerBroadcast(t *testing.T) {
	newHub := func(port int) *sseHub {
		hub := newSSEHub(&slowSessionFetcher{result: []sessions.ProjectSession{}}, nil, nil, nil)
		hub.codeServerPort = port
		hub.safetyInterval = 50 * time.Millisecond // cycle the poll loop quickly
		return hub
	}
	waitFor := func(t *testing.T, ch chan hubEvent, want string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case ev := <-ch:
				if s := ev.String(); strings.HasPrefix(s, "event: code-server") && strings.Contains(s, want) {
					return
				}
			case <-deadline:
				t.Fatalf("no code-server event containing %s", want)
			}
		}
	}

	t.Run("listener up → reachable true, down → false after TTL", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		hub := newHub(port)
		client := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)

		// The payload carries reachability only — the port is server-private
		// behind the /code route and must never appear on the wire.
		waitFor(t, client.ch, `{"reachable":true}`)

		// Kill the listener; the probe TTL (5s) must expire before the flip.
		ln.Close()
		hub.mu.Lock()
		hub.codeServerProbeAt = time.Now().Add(-2 * codeServerProbeTTL) // expire the cache
		hub.mu.Unlock()
		waitFor(t, client.ch, `{"reachable":false}`)
	})

	t.Run("late joiner gets the replay slot", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		port := ln.Addr().(*net.TCPAddr).Port
		hub := newHub(port)
		first := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
		waitFor(t, first.ch, `{"reachable":true}`)

		// A second connection is replayed the cached payload from
		// replayGlobalSlots without waiting for the next tick.
		sc := &stateConn{ch: make(chan hubEvent, 16), subs: map[string]*sseClient{}}
		hub.replayGlobalSlots(sc)
		waitFor(t, sc.ch, `{"reachable":true}`)
	})

	t.Run("unconfigured port broadcasts nothing", func(t *testing.T) {
		hub := newHub(0)
		client := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
		select {
		case ev := <-client.ch:
			if strings.HasPrefix(ev.String(), "event: code-server") {
				t.Fatalf("unconfigured port broadcast %q", ev.String())
			}
		case <-time.After(300 * time.Millisecond):
			// pass — several ticks at the 50ms test cadence, no code-server event
		}
	})
}

func TestSSEHubDeduplication(t *testing.T) {
	sf := &slowSessionFetcher{
		result: []sessions.ProjectSession{
			{Name: "static", Windows: []tmux.WindowInfo{}},
		},
	}

	hub := newSSEHub(sf, nil, nil, nil)
	client := &sseClient{ch: make(chan hubEvent, 16), server: "default"}

	hub.addClient(client)
	defer hub.removeClient(client)

	// Wait for initial snapshot delivery
	select {
	case <-client.ch:
		// Got initial snapshot (may be empty or from first poll)
	case <-time.After(4 * time.Second):
		// First poll may take up to legacyPollInterval
	}

	// Drain any pending events from the first poll cycle
	time.Sleep(100 * time.Millisecond)
drainLoop:
	for {
		select {
		case <-client.ch:
		default:
			break drainLoop
		}
	}

	// Wait for another poll cycle — since data hasn't changed, no event should be sent
	time.Sleep(legacyPollInterval + 500*time.Millisecond)

	select {
	case <-client.ch:
		t.Error("received duplicate event when data didn't change")
	default:
		// Expected: no event
	}
}

func TestSSEHubStopsPollingWhenNoClients(t *testing.T) {
	sf := &slowSessionFetcher{
		result: []sessions.ProjectSession{},
	}

	hub := newSSEHub(sf, nil, nil, nil)
	client := &sseClient{ch: make(chan hubEvent, 8), server: "default"}

	hub.addClient(client)

	// Wait a bit for polling to start
	time.Sleep(100 * time.Millisecond)

	hub.mu.RLock()
	isPolling := hub.polling
	hub.mu.RUnlock()
	if !isPolling {
		t.Error("hub should be polling with a client connected")
	}

	hub.removeClient(client)

	// Wait for poll loop to detect no clients
	time.Sleep(legacyPollInterval + 500*time.Millisecond)

	hub.mu.RLock()
	isPolling = hub.polling
	hub.mu.RUnlock()
	if isPolling {
		t.Error("hub should stop polling when no clients")
	}
}

// countingSessionFetcher returns incrementing data so each poll produces a new event.
type countingSessionFetcher struct {
	mu    sync.Mutex
	count int
}

func (f *countingSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.count++
	return []sessions.ProjectSession{
		{Name: fmt.Sprintf("session-%d", f.count), Windows: []tmux.WindowInfo{}},
	}, nil
}

func TestSSEHubDropLogging(t *testing.T) {
	sf := &countingSessionFetcher{}
	hub := newSSEHub(sf, nil, nil, nil)

	// Use a buffer of 1 so it fills immediately
	client := &sseClient{ch: make(chan hubEvent, 1), server: "default"}
	hub.addClient(client)
	defer hub.removeClient(client)

	// Wait for at least two poll cycles to fill the tiny buffer and trigger drops
	time.Sleep(legacyPollInterval*3 + 500*time.Millisecond)

	hub.mu.RLock()
	dropped := client.dropped
	hub.mu.RUnlock()

	if !dropped {
		t.Error("expected client.dropped to be true after buffer overflow")
	}

	// Drain the channel to simulate recovery
	for len(client.ch) > 0 {
		<-client.ch
	}

	// Wait for another poll cycle — successful send should reset dropped
	time.Sleep(legacyPollInterval + 500*time.Millisecond)

	hub.mu.RLock()
	dropped = client.dropped
	hub.mu.RUnlock()

	if dropped {
		t.Error("expected client.dropped to be reset to false after successful send")
	}
}

// perServerSessionFetcher returns different data per server so we can verify isolation.
type perServerSessionFetcher struct {
	mu   sync.Mutex
	data map[string][]sessions.ProjectSession
}

func (f *perServerSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.data[server], nil
}

func TestSSEHubMultiServerIsolation(t *testing.T) {
	sf := &perServerSessionFetcher{
		data: map[string][]sessions.ProjectSession{
			"runkit":  {{Name: "rk-session", Windows: []tmux.WindowInfo{}}},
			"default": {{Name: "default-session", Windows: []tmux.WindowInfo{}}},
		},
	}

	hub := newSSEHub(sf, nil, nil, nil)
	rkClient := hub.addTestClient(make(chan hubEvent, 16), "runkit")
	dfClient := hub.addTestClient(make(chan hubEvent, 16), "default")

	defer hub.removeClient(rkClient)
	defer hub.removeClient(dfClient)

	// Wait for at least one poll cycle
	time.Sleep(legacyPollInterval + 500*time.Millisecond)

	// Drain both channels and check content
	var rkEvents, dfEvents []string
	for len(rkClient.ch) > 0 {
		rkEvents = append(rkEvents, (<-rkClient.ch).String())
	}
	for len(dfClient.ch) > 0 {
		dfEvents = append(dfEvents, (<-dfClient.ch).String())
	}

	if len(rkEvents) == 0 {
		t.Fatal("runkit client received no events")
	}
	if len(dfEvents) == 0 {
		t.Fatal("default client received no events")
	}

	// Verify isolation: runkit client only sees rk-session, default only sees default-session.
	// Scope assertions to "event: sessions" frames; the hub also emits "event: session-order"
	// frames whose payload doesn't carry session names — those are checked separately below.
	rkSessionEvents := filterSSEEvents(rkEvents, "sessions")
	dfSessionEvents := filterSSEEvents(dfEvents, "sessions")
	if len(rkSessionEvents) == 0 {
		t.Fatal("runkit client received no sessions events")
	}
	if len(dfSessionEvents) == 0 {
		t.Fatal("default client received no sessions events")
	}
	for _, ev := range rkSessionEvents {
		if strings.Contains(ev, "default-session") {
			t.Errorf("runkit client received default server data: %s", ev)
		}
		if !strings.Contains(ev, "rk-session") {
			t.Errorf("runkit client event missing rk-session: %s", ev)
		}
	}
	for _, ev := range dfSessionEvents {
		if strings.Contains(ev, "rk-session") {
			t.Errorf("default client received runkit server data: %s", ev)
		}
		if !strings.Contains(ev, "default-session") {
			t.Errorf("default client event missing default-session: %s", ev)
		}
	}

	// Cross-server isolation also holds for session-order events.
	for _, ev := range filterSSEEvents(rkEvents, "session-order") {
		if strings.Contains(ev, `"server":"default"`) {
			t.Errorf("runkit client received default's session-order: %s", ev)
		}
	}
	for _, ev := range filterSSEEvents(dfEvents, "session-order") {
		if strings.Contains(ev, `"server":"runkit"`) {
			t.Errorf("default client received runkit's session-order: %s", ev)
		}
	}
}

// TestBroadcastServerOrderFansOutToAllClients verifies the server-global
// contract for `event: server-order`: a single broadcast reaches EVERY
// connected client regardless of server key — including the metrics-only
// (`?metrics=1`) client that has no attached tmux server — and the payload is
// cached and replayed to a client that connects AFTER the broadcast.
func TestBroadcastServerOrderFansOutToAllClients(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	rkClient := hub.addTestClient(make(chan hubEvent, 16), "runkit")
	dfClient := hub.addTestClient(make(chan hubEvent, 16), "default")
	moClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(rkClient)
	defer hub.removeClient(dfClient)
	defer hub.removeClient(moClient)

	hub.broadcastServerOrder([]string{"a", "b"})

	// Every connected client — including the metrics-only stream — must have
	// received the server-order frame with the exact payload.
	for name, c := range map[string]*sseClient{"runkit": rkClient, "default": dfClient, "metrics-only": moClient} {
		var events []string
		for len(c.ch) > 0 {
			events = append(events, (<-c.ch).String())
		}
		got := filterSSEEvents(events, "server-order")
		if len(got) == 0 {
			t.Fatalf("%s client received no server-order event (all: %v)", name, events)
		}
		if !strings.Contains(got[0], `{"order":["a","b"]}`) {
			t.Errorf("%s client server-order payload = %q, want order [a,b]", name, got[0])
		}
	}

	// A client that connects AFTER the broadcast must receive the cached
	// snapshot on connect (server-global cache, not per-server).
	lateClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(lateClient)
	var lateEvents []string
	for len(lateClient.ch) > 0 {
		lateEvents = append(lateEvents, (<-lateClient.ch).String())
	}
	replay := filterSSEEvents(lateEvents, "server-order")
	if len(replay) == 0 {
		t.Fatalf("late client did not receive cached server-order snapshot (all: %v)", lateEvents)
	}
	if !strings.Contains(replay[0], `{"order":["a","b"]}`) {
		t.Errorf("late client cached snapshot = %q, want order [a,b]", replay[0])
	}
}

// TestBroadcastBoardOrderFansOutToAllClients verifies the server-global contract
// for `event: board-order`: a single broadcast reaches EVERY connected client
// regardless of server key — including the metrics-only (`?metrics=1`) client —
// and the payload is cached and replayed to a client that connects AFTER the
// broadcast. Mirrors TestBroadcastServerOrderFansOutToAllClients.
func TestBroadcastBoardOrderFansOutToAllClients(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	rkClient := hub.addTestClient(make(chan hubEvent, 16), "runkit")
	dfClient := hub.addTestClient(make(chan hubEvent, 16), "default")
	moClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(rkClient)
	defer hub.removeClient(dfClient)
	defer hub.removeClient(moClient)

	hub.broadcastBoardOrder([]string{"reviews", "deploys"})

	for name, c := range map[string]*sseClient{"runkit": rkClient, "default": dfClient, "metrics-only": moClient} {
		var events []string
		for len(c.ch) > 0 {
			events = append(events, (<-c.ch).String())
		}
		got := filterSSEEvents(events, "board-order")
		if len(got) == 0 {
			t.Fatalf("%s client received no board-order event (all: %v)", name, events)
		}
		if !strings.Contains(got[0], `{"order":["reviews","deploys"]}`) {
			t.Errorf("%s client board-order payload = %q, want order [reviews,deploys]", name, got[0])
		}
	}

	// A client that connects AFTER the broadcast must receive the cached snapshot.
	lateClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(lateClient)
	var lateEvents []string
	for len(lateClient.ch) > 0 {
		lateEvents = append(lateEvents, (<-lateClient.ch).String())
	}
	replay := filterSSEEvents(lateEvents, "board-order")
	if len(replay) == 0 {
		t.Fatalf("late client did not receive cached board-order snapshot (all: %v)", lateEvents)
	}
	if !strings.Contains(replay[0], `{"order":["reviews","deploys"]}`) {
		t.Errorf("late client cached board-order snapshot = %q, want order [reviews,deploys]", replay[0])
	}
}

// TestBroadcastStatusRefreshFansOutToAllClients verifies the server-global
// contract for `event: status-refresh`: a single broadcast reaches EVERY
// connected client regardless of server key — including the metrics-only
// (`?metrics=1`) client — and carries a `completedAt` field. Unlike
// server-order/board-order it is broadcast-ONLY: a client that connects AFTER
// the broadcast must NOT receive a replayed status-refresh frame (no cached slot).
func TestBroadcastStatusRefreshFansOutToAllClients(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	rkClient := hub.addTestClient(make(chan hubEvent, 16), "runkit")
	dfClient := hub.addTestClient(make(chan hubEvent, 16), "default")
	moClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(rkClient)
	defer hub.removeClient(dfClient)
	defer hub.removeClient(moClient)

	hub.broadcastStatusRefresh(time.Date(2026, 7, 15, 10, 23, 41, 0, time.UTC))

	for name, c := range map[string]*sseClient{"runkit": rkClient, "default": dfClient, "metrics-only": moClient} {
		var events []string
		for len(c.ch) > 0 {
			events = append(events, (<-c.ch).String())
		}
		got := filterSSEEvents(events, "status-refresh")
		if len(got) == 0 {
			t.Fatalf("%s client received no status-refresh event (all: %v)", name, events)
		}
		if !strings.Contains(got[0], `"completedAt":"2026-07-15T10:23:41Z"`) {
			t.Errorf("%s client status-refresh payload = %q, want completedAt 2026-07-15T10:23:41Z", name, got[0])
		}
	}

	// Broadcast-only: a client connecting AFTER the broadcast gets NO replay
	// (there is no cached slot, unlike server-order/board-order/update-available).
	lateClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(lateClient)
	var lateEvents []string
	for len(lateClient.ch) > 0 {
		lateEvents = append(lateEvents, (<-lateClient.ch).String())
	}
	if replay := filterSSEEvents(lateEvents, "status-refresh"); len(replay) != 0 {
		t.Errorf("late client received a replayed status-refresh (should be broadcast-only): %v", replay)
	}
}

// TestBroadcastBoardOrderNilNormalizedToEmpty verifies a nil order broadcasts
// (and caches) as "[]" rather than "null", matching broadcastServerOrder.
func TestBroadcastBoardOrderNilNormalizedToEmpty(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)
	c := hub.addTestClient(make(chan hubEvent, 16), "default")
	defer hub.removeClient(c)

	hub.broadcastBoardOrder(nil)

	var events []string
	for len(c.ch) > 0 {
		events = append(events, (<-c.ch).String())
	}
	got := filterSSEEvents(events, "board-order")
	if len(got) == 0 {
		t.Fatalf("no board-order event (all: %v)", events)
	}
	if !strings.Contains(got[0], `{"order":[]}`) {
		t.Errorf("nil order payload = %q, want {\"order\":[]}", got[0])
	}
}

// TestVersionSlotReplayedOnConnect verifies the server-global `event: version`
// cached slot: after setVersion, EVERY client (incl. `?metrics=1`) receives the
// version frame on connect, carrying the additive `boot` + `brew` + `started` +
// `port` fields. There is no broadcast path — the slot is delivered on connect
// only.
func TestVersionSlotReplayedOnConnect(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)
	hub.setVersion("0.5.3", "abc123", true, 1700000000, 3000)

	for name, server := range map[string]string{"default": "default", "metrics-only": metricsOnlyServer} {
		c := hub.addTestClient(make(chan hubEvent, 16), server)
		var events []string
		for len(c.ch) > 0 {
			events = append(events, (<-c.ch).String())
		}
		hub.removeClient(c)
		got := filterSSEEvents(events, "version")
		if len(got) == 0 {
			t.Fatalf("%s client received no version event (all: %v)", name, events)
		}
		// Assert each required field independently rather than the exact
		// serialized object — this tolerates JSON key-order changes and
		// additive fields (the payload is explicitly additive; see setVersion).
		for _, want := range []string{`"version":"0.5.3"`, `"boot":"abc123"`, `"brew":true`, `"started":1700000000`, `"port":3000`} {
			if !strings.Contains(got[0], want) {
				t.Errorf("%s client version payload = %q, missing %s", name, got[0], want)
			}
		}
	}
}

// TestVersionSlotEmptyWhenUnset verifies no `event: version` is sent when
// setVersion was never called (empty slot).
func TestVersionSlotEmptyWhenUnset(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)
	c := hub.addTestClient(make(chan hubEvent, 16), "default")
	defer hub.removeClient(c)
	var events []string
	for len(c.ch) > 0 {
		events = append(events, (<-c.ch).String())
	}
	if got := filterSSEEvents(events, "version"); len(got) != 0 {
		t.Errorf("expected no version event when unset, got %v", got)
	}
}

// TestVersionSlotEmptyVersionSuppressed verifies an empty version leaves the
// slot empty (no `event: version` sent) even when boot/brew are provided.
func TestVersionSlotEmptyVersionSuppressed(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)
	hub.setVersion("", "abc123", true, 1700000000, 3000)
	c := hub.addTestClient(make(chan hubEvent, 16), "default")
	defer hub.removeClient(c)
	var events []string
	for len(c.ch) > 0 {
		events = append(events, (<-c.ch).String())
	}
	if got := filterSSEEvents(events, "version"); len(got) != 0 {
		t.Errorf("expected no version event when version is empty, got %v", got)
	}
}

// TestBroadcastUpdateAvailableFansOutAndReplays verifies the server-global
// contract for `event: update-available`: a single broadcast reaches EVERY
// connected client (incl. `?metrics=1`), and the payload is cached + replayed to
// a client that connects AFTER the broadcast. Mirrors the server-order/board-order
// fan-out tests.
func TestBroadcastUpdateAvailableFansOutAndReplays(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	rkClient := hub.addTestClient(make(chan hubEvent, 16), "runkit")
	moClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(rkClient)
	defer hub.removeClient(moClient)

	hub.broadcastUpdateAvailable(updatecheck.Result{
		Tools:   []updatecheck.ToolVerdict{{Tool: "run-kit", Installed: "0.5.3", Latest: "0.6.0", UpdateAvailable: true, Notable: true}},
		Matched: []updatecheck.ToolUpdate{{Tool: "run-kit", Installed: "0.5.3", Latest: "0.6.0"}},
		Key:     "run-kit@0.6.0",
		Current: "0.5.3",
		Latest:  "0.6.0",
	})

	// The payload carries the full per-tool verdict list (updateAvailable +
	// notable), the composite key, and the legacy top-level current/latest
	// (from the run-kit row).
	wantPayload := `"tools":[{"tool":"run-kit","current":"0.5.3","latest":"0.6.0","updateAvailable":true,"notable":true}]`
	wantKey := `"key":"run-kit@0.6.0"`
	wantLegacy := `"current":"0.5.3","latest":"0.6.0"`

	for name, c := range map[string]*sseClient{"runkit": rkClient, "metrics-only": moClient} {
		var events []string
		for len(c.ch) > 0 {
			events = append(events, (<-c.ch).String())
		}
		got := filterSSEEvents(events, "update-available")
		if len(got) == 0 {
			t.Fatalf("%s client received no update-available event (all: %v)", name, events)
		}
		if !strings.Contains(got[0], wantPayload) || !strings.Contains(got[0], wantKey) || !strings.Contains(got[0], wantLegacy) {
			t.Errorf("%s client update-available payload = %q", name, got[0])
		}
	}

	// A client connecting AFTER the broadcast must receive the cached snapshot.
	lateClient := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(lateClient)
	var lateEvents []string
	for len(lateClient.ch) > 0 {
		lateEvents = append(lateEvents, (<-lateClient.ch).String())
	}
	replay := filterSSEEvents(lateEvents, "update-available")
	if len(replay) == 0 {
		t.Fatalf("late client did not receive cached update-available snapshot (all: %v)", lateEvents)
	}
	if !strings.Contains(replay[0], wantPayload) || !strings.Contains(replay[0], wantKey) {
		t.Errorf("late client cached update-available snapshot = %q", replay[0])
	}
}

func TestBroadcastNotifyFansOutWithoutReplay(t *testing.T) {
	hub := newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
	first := hub.addTestClient(make(chan hubEvent, 16), "first")
	second := hub.addTestClient(make(chan hubEvent, 16), metricsOnlyServer)
	defer hub.removeClient(first)
	defer hub.removeClient(second)

	hub.broadcastNotify("RunKit", "agent waiting", "/utils2/5")

	for name, client := range map[string]*sseClient{"first": first, "second": second} {
		frames := decodeEnvelopes(drainFrames(client.ch))
		var got []notifyPayload
		for _, frame := range frames {
			if rawStr(frame, "type") != "notify" || rawStr(frame, "kind") != kindGlobal {
				continue
			}
			var payload notifyPayload
			if err := json.Unmarshal(frame["data"], &payload); err != nil {
				t.Fatalf("%s client decode notify payload: %v", name, err)
			}
			got = append(got, payload)
		}
		if len(got) != 1 {
			t.Fatalf("%s client received %d notify events, want 1", name, len(got))
		}
		if got[0].Title != "RunKit" || got[0].Body != "agent waiting" || got[0].URL != "/utils2/5" {
			t.Errorf("%s client payload = %+v", name, got[0])
		}
		if len(got[0].ID) != 16 {
			t.Errorf("%s client id length = %d, want 16", name, len(got[0].ID))
		} else if _, err := hex.DecodeString(got[0].ID); err != nil {
			t.Errorf("%s client id = %q, want hex: %v", name, got[0].ID, err)
		}
	}

	late := hub.addTestClient(make(chan hubEvent, 16), "late")
	defer hub.removeClient(late)
	for _, frame := range decodeEnvelopes(drainFrames(late.ch)) {
		if rawStr(frame, "type") == "notify" {
			t.Fatal("late client received a replayed notify event")
		}
	}
}

// filterSSEEvents returns only the SSE frames whose first line is `event: <name>`.
func filterSSEEvents(events []string, name string) []string {
	var out []string
	prefix := "event: " + name
	for _, ev := range events {
		if strings.HasPrefix(ev, prefix) {
			out = append(out, ev)
		}
	}
	return out
}

func TestSSEHubRemoveClientSwapDelete(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	c1 := &sseClient{ch: make(chan hubEvent, 8), server: "runkit"}
	c2 := &sseClient{ch: make(chan hubEvent, 8), server: "runkit"}
	c3 := &sseClient{ch: make(chan hubEvent, 8), server: "runkit"}

	hub.addClient(c1)
	hub.addClient(c2)
	hub.addClient(c3)

	hub.mu.RLock()
	if len(hub.clients["runkit"]) != 3 {
		t.Fatalf("expected 3 clients, got %d", len(hub.clients["runkit"]))
	}
	hub.mu.RUnlock()

	// Remove the middle client
	hub.removeClient(c2)

	hub.mu.RLock()
	remaining := hub.clients["runkit"]
	hub.mu.RUnlock()

	if len(remaining) != 2 {
		t.Fatalf("expected 2 clients after remove, got %d", len(remaining))
	}

	// c1 and c3 should still be present (order may differ due to swap-delete)
	found1, found3 := false, false
	for _, c := range remaining {
		if c == c1 {
			found1 = true
		}
		if c == c3 {
			found3 = true
		}
	}
	if !found1 {
		t.Error("c1 should still be in the slice after removing c2")
	}
	if !found3 {
		t.Error("c3 should still be in the slice after removing c2")
	}
}

func TestSSEHubRemoveLastClientDeletesKey(t *testing.T) {
	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, nil, nil, nil)

	c1 := &sseClient{ch: make(chan hubEvent, 8), server: "runkit"}
	c2 := &sseClient{ch: make(chan hubEvent, 8), server: "default"}

	hub.addClient(c1)
	hub.addClient(c2)

	hub.mu.RLock()
	if len(hub.clients) != 2 {
		t.Fatalf("expected 2 server keys, got %d", len(hub.clients))
	}
	hub.mu.RUnlock()

	// Remove the only runkit client
	hub.removeClient(c1)

	hub.mu.RLock()
	_, exists := hub.clients["runkit"]
	defaultLen := len(hub.clients["default"])
	hub.mu.RUnlock()

	if exists {
		t.Error("runkit key should be deleted after removing its last client")
	}
	if defaultLen != 1 {
		t.Errorf("default slice should still have 1 client, got %d", defaultLen)
	}
}

func TestSSEHubConcurrentAddRemove(t *testing.T) {
	sf := &slowSessionFetcher{
		result: []sessions.ProjectSession{
			{Name: "s", Windows: []tmux.WindowInfo{}},
		},
	}

	hub := newSSEHub(sf, nil, nil, nil)

	// Seed one client to start polling
	seed := &sseClient{ch: make(chan hubEvent, 32), server: "default"}
	hub.addClient(seed)

	var wg sync.WaitGroup
	const n = 20

	// Concurrently add and remove clients while polling is active
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := &sseClient{ch: make(chan hubEvent, 32), server: "default"}
			hub.addClient(c)
			time.Sleep(10 * time.Millisecond)
			hub.removeClient(c)
		}()
	}

	// Also add clients on a different server concurrently
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := &sseClient{ch: make(chan hubEvent, 32), server: "runkit"}
			hub.addClient(c)
			time.Sleep(10 * time.Millisecond)
			hub.removeClient(c)
		}()
	}

	wg.Wait()
	hub.removeClient(seed)

	// Wait for polling to stop
	time.Sleep(legacyPollInterval + 500*time.Millisecond)

	hub.mu.RLock()
	totalClients := 0
	for _, cs := range hub.clients {
		totalClients += len(cs)
	}
	isPolling := hub.polling
	hub.mu.RUnlock()

	if totalClients != 0 {
		t.Errorf("expected 0 clients after all removed, got %d", totalClients)
	}
	if isPolling {
		t.Error("hub should have stopped polling after all clients removed")
	}
}

// stubOrderFetcher returns a canned order per server.
type stubOrderFetcher struct {
	mu     sync.Mutex
	orders map[string][]string
	calls  int
	err    error
}

func (s *stubOrderFetcher) GetSessionOrder(ctx context.Context, server string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.orders[server], nil
}

func TestSSE_BroadcastSessionOrderReachesMatchingClients(t *testing.T) {
	hub := newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
	hub.orderFetcher = &stubOrderFetcher{orders: map[string][]string{}}

	cDefault := &sseClient{ch: make(chan hubEvent, 32), server: "default"}
	cStaging := &sseClient{ch: make(chan hubEvent, 32), server: "staging"}
	hub.mu.Lock()
	hub.clients["default"] = append(hub.clients["default"], cDefault)
	hub.clients["staging"] = append(hub.clients["staging"], cStaging)
	hub.mu.Unlock()

	hub.broadcastSessionOrder("default", []string{"main", "dev"})

	// The default client must receive a session-order event
	select {
	case ev := <-cDefault.ch:
		if !strings.Contains(ev.String(), "event: session-order") {
			t.Errorf("default client got %q, want session-order event", ev.String())
		}
		if !strings.Contains(ev.String(), `"order":["main","dev"]`) {
			t.Errorf("default client payload missing order: %s", ev.String())
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("default client did not receive event")
	}

	// The staging client must NOT receive anything
	select {
	case ev := <-cStaging.ch:
		t.Errorf("staging client unexpectedly got: %s", ev.String())
	case <-time.After(100 * time.Millisecond):
		// expected — no event
	}
}

func TestSSE_SessionOrderCachedOnConnect(t *testing.T) {
	hub := newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
	hub.orderFetcher = &stubOrderFetcher{orders: map[string][]string{}}

	// Broadcast before any client connects — the payload should be cached.
	hub.broadcastSessionOrder("default", []string{"main", "dev"})

	c := &sseClient{ch: make(chan hubEvent, 32), server: "default"}
	hub.addClient(c)
	defer hub.removeClient(c)

	// addClient should have queued the cached session-order event in the channel.
	// First event may be sessions snapshot if previousJSON is set, then session-order.
	deadline := time.After(500 * time.Millisecond)
	gotOrder := false
	for !gotOrder {
		select {
		case ev := <-c.ch:
			if strings.Contains(ev.String(), "event: session-order") {
				if !strings.Contains(ev.String(), `"order":["main","dev"]`) {
					t.Errorf("cached event payload missing order: %s", ev.String())
				}
				gotOrder = true
			}
		case <-deadline:
			t.Fatal("client did not receive cached session-order event on connect")
		}
	}
}

func TestSSE_HubBootstrapReadsOrderOnFirstPoll(t *testing.T) {
	stub := &stubOrderFetcher{orders: map[string][]string{
		"default": {"alpha", "beta"},
	}}
	hub := newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
	hub.orderFetcher = stub

	c := &sseClient{ch: make(chan hubEvent, 32), server: "default"}
	hub.addClient(c)
	defer hub.removeClient(c)

	// Poll loop should bootstrap the order on first iteration. Wait up to
	// legacyPollInterval + slack for the broadcast to land.
	deadline := time.After(legacyPollInterval + 1*time.Second)
	gotOrder := false
	for !gotOrder {
		select {
		case ev := <-c.ch:
			if strings.Contains(ev.String(), "event: session-order") &&
				strings.Contains(ev.String(), `"order":["alpha","beta"]`) {
				gotOrder = true
			}
		case <-deadline:
			t.Fatal("client did not receive bootstrapped session-order event")
		}
	}

	stub.mu.Lock()
	calls := stub.calls
	stub.mu.Unlock()
	if calls < 1 {
		t.Errorf("orderFetcher calls = %d, want >= 1", calls)
	}
}

// TestRealSessionNameSet verifies the snapshot→real-session-name extraction
// excludes board pin-sessions and the control anchor (which are not sessions a
// user would notice losing and must not trip the disappearance log) while
// keeping user-facing sessions.
func TestRealSessionNameSet(t *testing.T) {
	in := []sessions.ProjectSession{
		{Name: "shll", Windows: []tmux.WindowInfo{}},
		{Name: "wt", Windows: []tmux.WindowInfo{}},
		{Name: tmux.PinSessionPrefix + "42", Windows: []tmux.WindowInfo{}},
		{Name: tmux.ControlAnchorSessionName, Windows: []tmux.WindowInfo{}},
		{Name: "", Windows: []tmux.WindowInfo{}}, // defensive: empty name ignored
	}
	got := realSessionNameSet(in)
	want := map[string]bool{"shll": true, "wt": true}
	if len(got) != len(want) {
		t.Fatalf("realSessionNameSet size = %d, want %d (got %v)", len(got), len(want), got)
	}
	for name := range want {
		if !got[name] {
			t.Errorf("realSessionNameSet missing real session %q", name)
		}
	}
	if got[tmux.PinSessionPrefix+"42"] {
		t.Error("realSessionNameSet must exclude board pin-sessions")
	}
	if got[tmux.ControlAnchorSessionName] {
		t.Error("realSessionNameSet must exclude the control anchor")
	}
}

// TestDetectDisappearedSessions verifies the pure prev→current diff: only names
// present before and absent now are reported, and a grown/equal set yields none.
func TestDetectDisappearedSessions(t *testing.T) {
	cases := []struct {
		name          string
		prev, current map[string]bool
		want          []string
	}{
		{
			name:    "one disappeared",
			prev:    map[string]bool{"shll": true, "wt": true},
			current: map[string]bool{"wt": true},
			want:    []string{"shll"},
		},
		{
			name:    "none disappeared (stable)",
			prev:    map[string]bool{"shll": true},
			current: map[string]bool{"shll": true},
			want:    nil,
		},
		{
			name:    "session added, none gone",
			prev:    map[string]bool{"shll": true},
			current: map[string]bool{"shll": true, "new": true},
			want:    nil,
		},
		{
			name:    "all gone (server emptied)",
			prev:    map[string]bool{"shll": true, "wt": true},
			current: map[string]bool{},
			want:    []string{"shll", "wt"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectDisappearedSessions(tc.prev, tc.current)
			gotSet := map[string]bool{}
			for _, g := range got {
				gotSet[g] = true
			}
			if len(got) != len(tc.want) {
				t.Fatalf("detectDisappearedSessions = %v, want %v", got, tc.want)
			}
			for _, w := range tc.want {
				if !gotSet[w] {
					t.Errorf("detectDisappearedSessions missing %q (got %v)", w, got)
				}
			}
		})
	}
}

// blockingSessionFetcher blocks FetchSessions for servers with an entry in
// release until that channel is closed; servers in gone fail with a
// tmux.IsServerGone-matching error; all others return result immediately. It
// tracks per-server concurrent in-flight count (cur), its high-water mark
// (max), and total call count (calls) for fan-out assertions.
type blockingSessionFetcher struct {
	mu      sync.Mutex
	result  []sessions.ProjectSession
	release map[string]chan struct{}
	gone    map[string]bool
	cur     map[string]int
	max     map[string]int
	calls   map[string]int
}

func newBlockingSessionFetcher(result []sessions.ProjectSession, blocked ...string) *blockingSessionFetcher {
	f := &blockingSessionFetcher{
		result:  result,
		release: map[string]chan struct{}{},
		gone:    map[string]bool{},
		cur:     map[string]int{},
		max:     map[string]int{},
		calls:   map[string]int{},
	}
	for _, s := range blocked {
		f.release[s] = make(chan struct{})
	}
	return f
}

func (f *blockingSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	f.cur[server]++
	f.calls[server]++
	if f.cur[server] > f.max[server] {
		f.max[server] = f.cur[server]
	}
	ch := f.release[server]
	gone := f.gone[server]
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.cur[server]--
		f.mu.Unlock()
	}()
	if ch != nil {
		<-ch
	}
	if gone {
		return nil, fmt.Errorf("exit status 1: error connecting to /tmp/tmux-1001/%s (No such file or directory)", server)
	}
	return f.result, nil
}

// waitForCond polls cond until it holds, failing the test after timeout.
func waitForCond(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// waitForEvent waits for an event on ch whose rendered form starts with
// prefix and (when substr is non-empty) contains substr, failing the test
// after timeout. Non-matching events are discarded.
func waitForEvent(t *testing.T, ch chan hubEvent, prefix, substr string, timeout time.Duration) string {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev := <-ch:
			s := ev.String()
			if strings.HasPrefix(s, prefix) && (substr == "" || strings.Contains(s, substr)) {
				return s
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q containing %q", prefix, substr)
			return ""
		}
	}
}

// TestSSEHubSlowServerDoesNotDelayOthers proves the poll loop's bounded
// fan-out removes head-of-line blocking across servers: while one server's
// FetchSessions is hung, another server's unit completes and its `sessions`
// event is delivered without waiting for the hung server.
func TestSSEHubSlowServerDoesNotDelayOthers(t *testing.T) {
	sf := newBlockingSessionFetcher(
		[]sessions.ProjectSession{{Name: "fast-session", Windows: []tmux.WindowInfo{}}},
		"slow",
	)
	hub := newSSEHub(sf, nil, nil, nil)
	hub.safetyInterval = 50 * time.Millisecond

	slowClient := hub.addTestClient(make(chan hubEvent, 16), "slow")
	fastClient := hub.addTestClient(make(chan hubEvent, 16), "fast")
	defer hub.removeClient(slowClient)
	defer hub.removeClient(fastClient)

	// Wait until the slow server's unit is genuinely blocked inside
	// FetchSessions, then require the fast server's sessions event to arrive
	// while it is still blocked.
	waitForCond(t, "slow server in flight", 2*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.cur["slow"] > 0
	})
	waitForEvent(t, fastClient.ch, "event: sessions", "fast-session", 2*time.Second)

	sf.mu.Lock()
	stillBlocked := sf.cur["slow"] > 0
	sf.mu.Unlock()
	if !stillBlocked {
		t.Fatal("slow server's fetch completed before the assertion — test did not exercise the overlap")
	}
	close(sf.release["slow"])
}

// TestSSEHubSlowServerDoesNotDelayMetrics proves the host-global metrics
// broadcast is independent of per-server work: the first emit lands even
// while one server's FetchSessions is hung (later ticks are deduped on the
// unchanged snapshot, so the assertion is on the first frame).
func TestSSEHubSlowServerDoesNotDelayMetrics(t *testing.T) {
	sf := newBlockingSessionFetcher(
		[]sessions.ProjectSession{{Name: "some-session", Windows: []tmux.WindowInfo{}}},
		"slow",
	)
	mc := metrics.NewCollector(2500 * time.Millisecond) // pre-fills a valid zero snapshot
	hub := newSSEHub(sf, mc, nil, nil)
	hub.safetyInterval = 50 * time.Millisecond

	client := hub.addTestClient(make(chan hubEvent, 16), "slow")
	defer hub.removeClient(client)

	// Once the slow server's unit is hung, further ticks must still broadcast
	// metrics (the broadcast runs ahead of and independent of unit dispatch).
	waitForCond(t, "slow server in flight", 2*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.cur["slow"] > 0
	})
	waitForEvent(t, client.ch, "event: metrics", "", 2*time.Second)

	sf.mu.Lock()
	stillBlocked := sf.cur["slow"] > 0
	sf.mu.Unlock()
	if !stillBlocked {
		t.Fatal("slow server's fetch completed before the assertion — test did not exercise the overlap")
	}
	close(sf.release["slow"])
}

// TestSSEHubSingleFlightPerServerAcrossTicks proves a server never has two
// poll units in flight at once: while one server's FetchSessions is hung,
// repeated ticks skip re-dispatching it (its concurrent count never exceeds
// 1) while other servers keep being polled.
func TestSSEHubSingleFlightPerServerAcrossTicks(t *testing.T) {
	sf := newBlockingSessionFetcher(
		[]sessions.ProjectSession{{Name: "fast-session", Windows: []tmux.WindowInfo{}}},
		"slow",
	)
	hub := newSSEHub(sf, nil, nil, nil)
	hub.safetyInterval = 20 * time.Millisecond

	slowClient := hub.addTestClient(make(chan hubEvent, 16), "slow")
	fastClient := hub.addTestClient(make(chan hubEvent, 16), "fast")
	defer hub.removeClient(slowClient)
	defer hub.removeClient(fastClient)

	waitForCond(t, "slow server in flight", 2*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.cur["slow"] > 0
	})
	// Let many ticks elapse with the slow server hung: it must never be
	// double-dispatched, and the fast server must keep being polled (its
	// fetch count grows past the 500ms fetch-cache TTL).
	waitForCond(t, "fast server re-polled while slow is hung", 3*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.calls["fast"] >= 2
	})
	sf.mu.Lock()
	slowMax := sf.max["slow"]
	slowCur := sf.cur["slow"]
	sf.mu.Unlock()
	if slowMax > 1 {
		t.Fatalf("slow server had %d concurrent units in flight (single-flight violated)", slowMax)
	}
	if slowCur != 1 {
		t.Fatalf("slow server should still be hung (cur=%d) — test did not exercise the overlap", slowCur)
	}
	close(sf.release["slow"])

	// After release, the slow server is re-dispatched on a later tick and
	// still never exceeds one in-flight unit.
	waitForCond(t, "slow server re-polled after release", 3*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.calls["slow"] >= 2 && sf.max["slow"] <= 1
	})
}

// TestSSEHubRetainScopingUnderFanOut proves the retain sweeps keep their
// observed-server scoping when results fold asynchronously: a server whose
// unit is still IN FLIGHT at fold time counts as not observed (its
// waiting-push episodes survive), while a server whose folded unit reported
// the socket gone IS swept.
func TestSSEHubRetainScopingUnderFanOut(t *testing.T) {
	sf := newBlockingSessionFetcher(nil, "blocked")
	sf.gone["dead"] = true
	hub := newSSEHub(sf, nil, nil, nil)
	hub.safetyInterval = 50 * time.Millisecond

	blockedClient := hub.addTestClient(make(chan hubEvent, 16), "blocked")
	deadClient := hub.addTestClient(make(chan hubEvent, 16), "dead")
	defer hub.removeClient(blockedClient)
	defer hub.removeClient(deadClient)

	// Seed waiting-push episodes on both servers.
	blockedKey := waitingKey("blocked", "@1")
	deadKey := waitingKey("dead", "@2")
	hub.waitingPush.mu.Lock()
	hub.waitingPush.episodes[blockedKey] = waitingEpisode{since: time.Now(), pushed: true}
	hub.waitingPush.episodes[deadKey] = waitingEpisode{since: time.Now(), pushed: true}
	hub.waitingPush.mu.Unlock()

	// Wait until the blocked server's unit is hung mid-fetch, then until the
	// dead server's unit completes, folds, and is reaped from the poll set.
	waitForCond(t, "blocked server in flight", 2*time.Second, func() bool {
		sf.mu.Lock()
		defer sf.mu.Unlock()
		return sf.cur["blocked"] > 0
	})
	waitForCond(t, "dead server reaped", 2*time.Second, func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		_, present := hub.clients["dead"]
		return !present
	})

	// The dead server's episode was swept (observed-gone); the blocked
	// server's episode survives (not observed — its unit is still in flight).
	hub.waitingPush.mu.Lock()
	_, blockedAlive := hub.waitingPush.episodes[blockedKey]
	_, deadAlive := hub.waitingPush.episodes[deadKey]
	hub.waitingPush.mu.Unlock()
	if !blockedAlive {
		t.Error("in-flight server's waiting-push episode was wrongly reaped")
	}
	if deadAlive {
		t.Error("dead server's waiting-push episode was not reaped")
	}
	close(sf.release["blocked"])
}

// TestSSEHubGlobalsNotRebroadcastWhenUnchanged proves change-only emission:
// with static collector snapshots, a run of dispatch ticks yields exactly one
// frame of each host-global per client, and a client joining afterwards is
// replayed each cached slot exactly once.
func TestSSEHubGlobalsNotRebroadcastWhenUnchanged(t *testing.T) {
	isolateSettings(t) // gui disabled: a stable all-zero payload
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	sf := &slowSessionFetcher{result: []sessions.ProjectSession{}}
	hub := newSSEHub(sf, metrics.NewCollector(2500*time.Millisecond), ports.NewCollector(2500*time.Millisecond), nil)
	hub.codeServerPort = ln.Addr().(*net.TCPAddr).Port
	hub.safetyInterval = 50 * time.Millisecond // ~8 dispatch ticks over the window below

	client := hub.addTestClient(make(chan hubEvent, 64), metricsOnlyServer)
	defer hub.removeClient(client)

	time.Sleep(400 * time.Millisecond)
	counts := map[string]int{}
	for _, s := range drainConnEvents(client.ch) {
		for _, typ := range []string{"metrics", "services", "code-server", "gui", "openai-mcp"} {
			if strings.HasPrefix(s, "event: "+typ) {
				counts[typ]++
			}
		}
	}
	for _, typ := range []string{"metrics", "services", "code-server", "gui", "openai-mcp"} {
		if counts[typ] != 1 {
			t.Errorf("%s frames over ~8 dispatch ticks = %d, want exactly 1 (the first emit)", typ, counts[typ])
		}
	}

	// A late joiner is replayed each non-empty slot once, and the still-static
	// ticks send it nothing further.
	second := hub.addTestClient(make(chan hubEvent, 64), metricsOnlyServer)
	defer hub.removeClient(second)
	time.Sleep(150 * time.Millisecond)
	replayed := map[string]int{}
	for _, s := range drainConnEvents(second.ch) {
		for _, typ := range []string{"metrics", "services", "code-server", "gui", "openai-mcp"} {
			if strings.HasPrefix(s, "event: "+typ) {
				replayed[typ]++
			}
		}
	}
	for _, typ := range []string{"metrics", "services", "code-server", "gui", "openai-mcp"} {
		if replayed[typ] != 1 {
			t.Errorf("late joiner %s frames = %d, want exactly 1 (the replay)", typ, replayed[typ])
		}
	}
}

// TestSSEHubGlobalsEmitOnChange proves the changed half of the contract: when
// a global's payload moves, exactly one new frame ships and repetition stops
// again. The code-server probe flip is the driver — a non-started metrics
// collector's snapshot is static, so it cannot exercise the changed branch in
// a unit hub; the three inline emitters share one shape.
func TestSSEHubGlobalsEmitOnChange(t *testing.T) {
	isolateSettings(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	hub := newSSEHub(&slowSessionFetcher{result: []sessions.ProjectSession{}}, nil, nil, nil)
	hub.codeServerPort = port
	hub.safetyInterval = 50 * time.Millisecond

	client := hub.addTestClient(make(chan hubEvent, 64), metricsOnlyServer)
	defer hub.removeClient(client)

	waitForEvent(t, client.ch, "event: code-server", `{"reachable":true}`, 2*time.Second)
	time.Sleep(150 * time.Millisecond) // let the first-tick stragglers (gui etc.) land
	drainConnEvents(client.ch)

	ln.Close()
	hub.mu.Lock()
	hub.codeServerProbeAt = time.Now().Add(-2 * codeServerProbeTTL) // expire the probe cache
	hub.mu.Unlock()

	waitForEvent(t, client.ch, "event: code-server", `{"reachable":false}`, 2*time.Second)
	time.Sleep(300 * time.Millisecond) // ~6 more dispatch ticks
	for _, s := range drainConnEvents(client.ch) {
		if strings.HasPrefix(s, "event: code-server") {
			t.Fatalf("duplicate code-server frame after the change: %q", s)
		}
	}
}

// TestSSEHubGlobalsSkipFoldOnlyTicks proves the gate placement: a tick whose
// wait ended solely on a unit completion (resultsOnly) emits NO host-global
// event — even when a global's payload has changed in the meantime — and the
// next full tick still evaluates the emitters. Harness shape mirrors
// TestSSE_PendingEventDrivenDispatchSurvivesResultsOnlyTick.
func TestSSEHubGlobalsSkipFoldOnlyTicks(t *testing.T) {
	isolateSettings(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	fetcher := &midFlightFetcher{
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
		baseline: []sessions.ProjectSession{{Name: "s1"}},
		changed:  []sessions.ProjectSession{{Name: "s1"}, {Name: "s2"}},
	}
	sub := newStubSubscriber()
	hub := newSSEHub(fetcher, nil, nil, nil)
	hub.subscriber = sub
	hub.codeServerPort = port
	hub.safetyInterval = 10 * time.Second // ticks are bump/wake-driven only

	client := hub.addTestClient(make(chan hubEvent, 64), "kits")
	t.Cleanup(func() { hub.removeClient(client) })

	// Bootstrap full tick: the first code-server frame and the baseline
	// sessions snapshot land.
	waitForEvent(t, client.ch, "event: code-server", `{"reachable":true}`, 2*time.Second)
	waitForEvent(t, client.ch, "event: sessions", "s1", 2*time.Second)
	time.Sleep(200 * time.Millisecond)
	drainConnEvents(client.ch)

	// Full tick 2: the bump dispatches the unit that blocks in FetchSessions;
	// the emitter re-evaluates with the probe TTL fresh, so nothing new ships.
	sub.Bump("kits")
	select {
	case <-fetcher.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("poll unit never entered the blocking fetch")
	}

	// The code-server payload flips while the unit is in flight.
	ln.Close()
	hub.mu.Lock()
	hub.codeServerProbeAt = time.Now().Add(-2 * codeServerProbeTTL)
	hub.mu.Unlock()

	// The completion's results wake yields a fold-only tick: it must emit no
	// global, changed payload or not. The unit returned the baseline, so no
	// sessions frame is owed either — any frame here is a violation.
	close(fetcher.release)
	select {
	case ev := <-client.ch:
		t.Fatalf("fold-only tick emitted %q", ev.String())
	case <-time.After(500 * time.Millisecond):
	}

	// The next full tick evaluates the emitters and ships the pending flip.
	sub.Bump("kits")
	waitForEvent(t, client.ch, "event: code-server", `{"reachable":false}`, 2*time.Second)
}

// scriptedSessionFetcher returns results[i] on the i-th FetchSessions call
// (the last entry repeats), stepping a server's snapshot through a scripted
// sequence of changes.
type scriptedSessionFetcher struct {
	mu      sync.Mutex
	calls   int
	results [][]sessions.ProjectSession
}

func (f *scriptedSessionFetcher) FetchSessions(ctx context.Context, server string) ([]sessions.ProjectSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	if i >= len(f.results) {
		i = len(f.results) - 1
	}
	f.calls++
	return f.results[i], nil
}

// TestSSEHubSessionsDedupIgnoresActiveActivityTimestamp proves the sessions
// dedup key contract: an ActivityTimestamp move on an ACTIVE window is
// suppressed (the client renders `flowing`, no timestamp), while the same
// move on an idle window and an activity flip both ship; a suppressed tick
// never leaks into the ack/replay snapshot, which stays the last SENT
// payload.
func TestSSEHubSessionsDedupIgnoresActiveActivityTimestamp(t *testing.T) {
	window := func(activity string, ts int64) []sessions.ProjectSession {
		return []sessions.ProjectSession{{Name: "s1", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "w", Activity: activity, ActivityTimestamp: ts},
		}}}
	}
	// setup wires a bump-driven hub (10s safety — ticks fire only on
	// subscriber bumps and wakes) over the scripted fetcher and subscribes
	// one client to "kits".
	setup := func(t *testing.T, script [][]sessions.ProjectSession) (*sseHub, *stubSubscriber, *sseClient) {
		t.Helper()
		isolateSettings(t)
		sub := newStubSubscriber()
		hub := newSSEHub(&scriptedSessionFetcher{results: script}, nil, nil, nil)
		hub.subscriber = sub
		hub.safetyInterval = 10 * time.Second
		client := hub.addTestClient(make(chan hubEvent, 64), "kits")
		t.Cleanup(func() { hub.removeClient(client) })
		return hub, sub, client
	}
	// settle waits out the bootstrap stragglers (gui slot, order bootstrap)
	// and drains the channel so later silence assertions see only new frames.
	settle := func(ch chan hubEvent) {
		time.Sleep(200 * time.Millisecond)
		drainConnEvents(ch)
	}

	t.Run("active-window timestamp move is suppressed; the ack stays the last sent payload", func(t *testing.T) {
		hub, sub, client := setup(t, [][]sessions.ProjectSession{
			window(tmux.WindowActivityActive, 1000),
			window(tmux.WindowActivityActive, 2000),
		})

		waitForEvent(t, client.ch, "event: sessions", `"activityTimestamp":1000`, 2*time.Second)
		settle(client.ch)

		// Fetch 2 moves only the active window's timestamp: the key is
		// unchanged, so no frame ships.
		sub.Bump("kits")
		select {
		case ev := <-client.ch:
			t.Fatalf("active-window timestamp move emitted %q, want suppression", ev.String())
		case <-time.After(400 * time.Millisecond):
		}

		// A late subscriber's replay is the last SENT payload (ts 1000), not
		// the suppressed one (ts 2000).
		second := hub.addTestClient(make(chan hubEvent, 64), "kits")
		defer hub.removeClient(second)
		got := waitForEvent(t, second.ch, "event: sessions", "", 2*time.Second)
		if !strings.Contains(got, `"activityTimestamp":1000`) || strings.Contains(got, `"activityTimestamp":2000`) {
			t.Fatalf("ack/replay snapshot = %q, want the last sent payload (ts 1000)", got)
		}
	})

	t.Run("idle-window timestamp move still ships", func(t *testing.T) {
		_, sub, client := setup(t, [][]sessions.ProjectSession{
			window(tmux.WindowActivityIdle, 1000),
			window(tmux.WindowActivityIdle, 2000),
		})

		waitForEvent(t, client.ch, "event: sessions", `"activityTimestamp":1000`, 2*time.Second)
		settle(client.ch)

		// The idle window's timestamp drives the `idle <dur>` label, so the
		// move is a real change.
		sub.Bump("kits")
		waitForEvent(t, client.ch, "event: sessions", `"activityTimestamp":2000`, 2*time.Second)
	})

	t.Run("activity flip ships with the latest timestamp", func(t *testing.T) {
		_, sub, client := setup(t, [][]sessions.ProjectSession{
			window(tmux.WindowActivityActive, 1000),
			window(tmux.WindowActivityIdle, 2500),
		})

		waitForEvent(t, client.ch, "event: sessions", `"activity":"active"`, 2*time.Second)
		settle(client.ch)

		sub.Bump("kits")
		got := waitForEvent(t, client.ch, "event: sessions", `"activity":"idle"`, 2*time.Second)
		if !strings.Contains(got, `"activityTimestamp":2500`) {
			t.Fatalf("flip frame = %q, want the window's latest activityTimestamp 2500", got)
		}
	})
}
