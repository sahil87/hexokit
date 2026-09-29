package api

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"rk/internal/sessions"
	"rk/internal/testutil"
	"rk/internal/tmux"
)

// payload returns the frame's wire bytes regardless of tier — a test-only
// convenience for the paced writers below, which peek the stream-id prefix.
// Production writeFrame reads f.control / f.data directly.
func (f outFrame) payload() []byte {
	if f.control != nil {
		return f.control
	}
	return f.data
}

// TestScheduler_EchoNotHeadOfLineBlocked is the HOL assertion ported from the
// spike harness (docs/findings/relay-mux-hol.md) as a Go unit test with NO real
// network. Stream A floods bulk frames while stream B enqueues a single short
// "echo" frame; the fair scheduler must write B's echo within a small bounded
// number of A frames (a shared FIFO would write it only after the entire A
// backlog drains). The write path is an injectable PACED writer (sleeps
// proportional to bytes written) so the flood cannot outrun the writer and the
// ordering — not wall-clock — is what the bound asserts.
func TestScheduler_EchoNotHeadOfLineBlocked(t *testing.T) {
	const (
		streamA uint32 = 1
		streamB uint32 = 2
		bulkLen        = streamFrameSize // 4096B — a flooding pane's chunk
	)

	tc := &terminalsConn{
		streams: map[uint32]*stream{},
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
	}

	stA := &stream{id: streamA, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	stB := &stream{id: streamB, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	tc.streams[streamA] = stA
	tc.streams[streamB] = stB

	// The paced writer records the ordered stream ids of everything written and
	// sleeps ∝ bytes (the simulated slow link). A small per-byte pace keeps the
	// test fast while still forcing the writer to be the bottleneck.
	var mu sync.Mutex
	var order []uint32
	const bytesPerSec = 4 * 1024 * 1024 // 4 MB/s simulated link
	tc.writeFrame = func(f outFrame) error {
		b := f.payload()
		if len(b) >= 4 {
			id := binary.BigEndian.Uint32(b[:4])
			mu.Lock()
			order = append(order, id)
			mu.Unlock()
		}
		time.Sleep(time.Duration(float64(len(b)) / bytesPerSec * float64(time.Second)))
		return nil
	}

	// A continuous flood producer on stream A: blocks when A's queue is full
	// (backpressure) — exactly the PTY-reader-pause seam in production.
	floodDone := make(chan struct{})
	go func() {
		defer close(floodDone)
		payload := make([]byte, 4+bulkLen)
		binary.BigEndian.PutUint32(payload[:4], streamA)
		for {
			frame := make([]byte, len(payload))
			copy(frame, payload)
			select {
			case stA.queue <- outFrame{data: frame}:
				tc.signalWake()
			case <-tc.done:
				return
			}
		}
	}()

	// Run the writer (the scheduler under test).
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		tc.runWriter()
	}()

	// Let the flood saturate A's queue so B's echo genuinely contends with a
	// backlog (the HOL scenario). Record how many frames were already written at
	// the moment we enqueue the echo — the HOL bound is A frames written AFTER
	// the echo is enqueued but BEFORE the echo itself, not the warmup A frames
	// written while only A existed.
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	writtenAtEnqueue := len(order)
	mu.Unlock()
	echo := make([]byte, 4+12) // 12-byte interactive payload
	binary.BigEndian.PutUint32(echo[:4], streamB)
	stB.queue <- outFrame{data: echo}
	tc.signalWake()

	// Wait until the echo is observed in the write order (fall-through on
	// timeout — the post-stop Fatalf below reports it).
	echoIdx := -1
	aFramesBefore := 0
	testutil.WaitUntil(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for i := writtenAtEnqueue; i < len(order); i++ {
			if order[i] == streamB {
				echoIdx = i
				break
			}
		}
		if echoIdx >= 0 {
			for i := writtenAtEnqueue; i < echoIdx; i++ {
				if order[i] == streamA {
					aFramesBefore++
				}
			}
		}
		return echoIdx >= 0
	})

	// Stop the flood + writer.
	close(tc.done)
	<-floodDone
	tc.signalWake()
	<-writerDone

	if echoIdx < 0 {
		t.Fatalf("stream B echo was never written — scheduler starved it")
	}
	// Fairness bound: with a two-queue priority scheduler, at most one already-
	// dequeued A bulk frame can precede the echo (the WS-frame-boundary floor
	// from the spike: one accepted 4KB frame is always ahead of an echo). Allow a
	// small slack (≤3) for scheduling-pass timing without admitting FIFO
	// behavior (a shared FIFO would put the entire backlog — dozens of A frames —
	// ahead of the echo).
	const maxAFramesBeforeEcho = 3
	if aFramesBefore > maxAFramesBeforeEcho {
		t.Errorf("echo head-of-line blocked: %d stream-A bulk frames written before the echo (want ≤ %d)",
			aFramesBefore, maxAFramesBeforeEcho)
	}
}

// TestScheduler_RoundRobinNoStarvation asserts the writer does not starve any
// stream: with two streams both holding bulk frames, both get service within a
// bounded window (round-robin), not one fully drained before the other starts.
func TestScheduler_RoundRobinNoStarvation(t *testing.T) {
	const (
		streamA uint32 = 1
		streamB uint32 = 2
	)
	tc := &terminalsConn{
		streams: map[uint32]*stream{},
		wake:    make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
	stA := &stream{id: streamA, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	stB := &stream{id: streamB, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	tc.streams[streamA] = stA
	tc.streams[streamB] = stB

	var mu sync.Mutex
	var order []uint32
	tc.writeFrame = func(f outFrame) error {
		b := f.payload()
		if len(b) >= 4 {
			id := binary.BigEndian.Uint32(b[:4])
			mu.Lock()
			order = append(order, id)
			mu.Unlock()
		}
		return nil
	}

	mkFrame := func(id uint32) outFrame {
		b := make([]byte, 4+streamFrameSize)
		binary.BigEndian.PutUint32(b[:4], id)
		return outFrame{data: b}
	}
	// Fill both queues fully with bulk frames before starting the writer.
	for i := 0; i < streamQueueDepth; i++ {
		stA.queue <- mkFrame(streamA)
		stB.queue <- mkFrame(streamB)
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		tc.runWriter()
	}()

	// Wait until all frames drain (fall-through on timeout — the post-stop
	// Fatalf below reports it).
	testutil.WaitUntil(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(order) >= 2*streamQueueDepth
	})
	close(tc.done)
	tc.signalWake()
	<-writerDone

	mu.Lock()
	defer mu.Unlock()
	if len(order) < 2*streamQueueDepth {
		t.Fatalf("not all frames drained: got %d, want %d", len(order), 2*streamQueueDepth)
	}
	// Round-robin: within the first 2 written frames, both streams appear (B is
	// not fully drained after A, nor vice versa). A shared FIFO or a
	// drain-one-stream-completely scheduler would write streamQueueDepth A frames
	// before any B frame.
	seenA, seenB := false, false
	for _, id := range order[:2] {
		if id == streamA {
			seenA = true
		}
		if id == streamB {
			seenB = true
		}
	}
	if !(seenA && seenB) {
		t.Errorf("expected round-robin interleave in the first 2 frames, got %v", order[:2])
	}
}

// TestTerminals_PingRepliesPong proves the client's application-level liveness
// probe on the terminals mux (260723-rma2): a {"op":"ping"} control frame (no
// stream id) is answered with the id-less {"op":"pong"} text frame through the
// single writer's control pseudo-stream. No tmux server is needed — the ping
// path never touches tmux — so this runs against the mock-tmux test router.
func TestTerminals_PingRepliesPong(t *testing.T) {
	router := newTestRouter(&slowSessionFetcher{}, &mockTmuxOps{})
	srv := httptest.NewServer(router)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminals"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"ping"}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		msgType, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read (no pong seen): %v", err)
		}
		if msgType != websocket.TextMessage {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		var op string
		_ = json.Unmarshal(m["op"], &op)
		if op != "pong" {
			continue
		}
		// The pong carries no stream id (the client handles it before its
		// per-stream id guard).
		if _, hasID := m["id"]; hasID {
			t.Errorf("pong carries an id field: %s", raw)
		}
		return
	}
}

// TestReloadConfigForAttach pins the managed-only pre-attach reload gate in
// its off-critical-path shape: the reload runs asynchronously (never a
// subprocess on the attach goroutine) and at most once per server per Server
// lifetime; an external server is skipped, a managed-check read failure fails
// closed AND releases the once-guard so a later attach retries, and a reload
// error only logs.
func TestReloadConfigForAttach(t *testing.T) {
	stub := func(t *testing.T, isManaged func(context.Context, string) (bool, error), reloadErr error) chan string {
		t.Helper()
		reloaded := make(chan string, 8)
		origManaged, origReload, origMigrate := attachIsManaged, attachReloadConfig, attachMigrateLegacy
		attachIsManaged = isManaged
		attachReloadConfig = func(server string) error {
			reloaded <- server
			return reloadErr
		}
		attachMigrateLegacy = func(context.Context, string) (bool, error) { return false, nil }
		t.Cleanup(func() {
			attachIsManaged, attachReloadConfig, attachMigrateLegacy = origManaged, origReload, origMigrate
			tmux.ResetLegacyMigrationForTest()
		})
		return reloaded
	}
	managedYes := func(context.Context, string) (bool, error) { return true, nil }
	managedNo := func(context.Context, string) (bool, error) { return false, nil }

	t.Run("managed server reloads asynchronously, off the attach path", func(t *testing.T) {
		// UNBUFFERED observation channel: were the reload synchronous, the send
		// would deadlock the attach goroutine and reloadConfigForAttach would
		// never return — so returning-then-receiving is the async proof.
		reloaded := make(chan string)
		origManaged, origReload, origMigrate := attachIsManaged, attachReloadConfig, attachMigrateLegacy
		attachIsManaged = managedYes
		attachReloadConfig = func(server string) error {
			reloaded <- server
			return nil
		}
		attachMigrateLegacy = func(context.Context, string) (bool, error) { return false, nil }
		t.Cleanup(func() {
			attachIsManaged, attachReloadConfig, attachMigrateLegacy = origManaged, origReload, origMigrate
			tmux.ResetLegacyMigrationForTest()
		})

		(&Server{}).reloadConfigForAttach("srv")
		select {
		case got := <-reloaded:
			if got != "srv" {
				t.Errorf("reloaded = %q, want srv", got)
			}
		case <-time.After(2 * time.Second):
			t.Error("reload never ran — the async reload must fire for a managed server")
		}
	})

	t.Run("external server is skipped", func(t *testing.T) {
		reloaded := stub(t, managedNo, nil)
		(&Server{}).reloadConfigForAttach("srv")
		select {
		case got := <-reloaded:
			t.Errorf("reloaded %q — an external server must never receive rk's conf", got)
		case <-time.After(100 * time.Millisecond):
		}
	})

	t.Run("managed-check failure fails closed and retries on a later attach", func(t *testing.T) {
		var calls atomic.Int32
		reloaded := stub(t, func(context.Context, string) (bool, error) {
			if calls.Add(1) == 1 {
				return false, fmt.Errorf("tmux read wobble")
			}
			return true, nil
		}, nil)
		s := &Server{}
		s.reloadConfigForAttach("srv")
		select {
		case got := <-reloaded:
			t.Fatalf("reloaded %q — a read failure must skip the reload", got)
		case <-time.After(100 * time.Millisecond):
		}
		// The guard release happens inside the async goroutine, so keep
		// re-attaching until the retry lands.
		deadline := time.After(2 * time.Second)
		for {
			s.reloadConfigForAttach("srv")
			select {
			case <-reloaded:
				return
			case <-deadline:
				t.Fatal("guard never released — a transient managed-check failure must retry")
			case <-time.After(10 * time.Millisecond):
			}
		}
	})

	t.Run("reload error does not propagate", func(t *testing.T) {
		reloaded := stub(t, managedYes, fmt.Errorf("boom"))
		(&Server{}).reloadConfigForAttach("srv") // must not panic
		select {
		case <-reloaded:
		case <-time.After(2 * time.Second):
			t.Error("reload never attempted — the error is logged, not gating")
		}
	})

	t.Run("reload runs at most once per server", func(t *testing.T) {
		reloaded := stub(t, managedYes, nil)
		s := &Server{}
		s.reloadConfigForAttach("srv")
		s.reloadConfigForAttach("srv")
		select {
		case <-reloaded:
		case <-time.After(2 * time.Second):
			t.Fatal("reload never ran")
		}
		select {
		case got := <-reloaded:
			t.Errorf("reload ran twice (%q) — the per-server once-guard must hold", got)
		case <-time.After(100 * time.Millisecond):
		}
	})

	t.Run("distinct servers each reload", func(t *testing.T) {
		reloaded := stub(t, managedYes, nil)
		s := &Server{}
		s.reloadConfigForAttach("srv-a")
		s.reloadConfigForAttach("srv-b")
		got := map[string]bool{}
		for range 2 {
			select {
			case name := <-reloaded:
				got[name] = true
			case <-time.After(2 * time.Second):
				t.Fatalf("only %v reloaded — the guard is per server, not per Server", got)
			}
		}
		if !got["srv-a"] || !got["srv-b"] {
			t.Errorf("reloaded set = %v, want srv-a and srv-b", got)
		}
	})
}

// TestStreamTeardownReapsAttachChild is the zombie regression test: teardown
// must kill AND reap (Wait) the forked attach child — without the Wait every
// closed stream leaves a <defunct> PID plus a parked os/exec watcher
// goroutine. ProcessState is populated only by a returned Wait, so its
// presence after teardown IS the reap proof. A pty child stands in for the
// real `tmux attach-session` fork (same pty.StartWithSize shape).
func TestStreamTeardownReapsAttachChild(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 30")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		cancel()
		t.Skipf("pty start unavailable: %v", err)
	}
	st := &stream{
		id:     1,
		queue:  make(chan outFrame, streamQueueDepth),
		closed: make(chan struct{}),
		ptmx:   ptmx,
		cancel: cancel,
		cmd:    cmd,
	}
	st.teardown()
	if cmd.ProcessState == nil {
		t.Fatal("child not reaped — teardown must Wait after Kill")
	}
	// Idempotent: closeStream and socket teardown can both reach it; the
	// sync.Once must prevent a second (panicking) Wait.
	st.teardown()
}

// TestKillAndReapAttach pins the shared reap helper both kill sites call —
// stream.teardown for a published cmd and attachStream's publish-race branch
// for a never-published one — plus its nil-safety on every placeholder shape
// teardown can see (control pseudo-stream, failed start).
func TestKillAndReapAttach(t *testing.T) {
	killAndReapAttach(nil)
	killAndReapAttach(&exec.Cmd{}) // failed start: no Process to reap

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 30")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		t.Skipf("pty start unavailable: %v", err)
	}
	defer ptmx.Close()
	killAndReapAttach(cmd)
	if cmd.ProcessState == nil {
		t.Fatal("child not reaped — the helper must Wait after Kill")
	}
	if cmd.ProcessState.Success() {
		t.Errorf("child exited cleanly (%v) — expected a kill", cmd.ProcessState)
	}
}

// TestReloadConfigForAttachLegacySweep pins the sweep half of the pre-attach
// seam: the sweep runs for managed servers only, behind the same gate, off
// the attach goroutine (the once-guard taken synchronously up front), and at
// most once per server. Each subtest uses its own server name: the sweep runs
// in a goroutine, so a shared name would let the previous subtest's in-flight
// sweep fire into the next subtest's fresh stub.
func TestReloadConfigForAttachLegacySweep(t *testing.T) {
	stub := func(t *testing.T, managed bool) chan string {
		t.Helper()
		swept := make(chan string, 8)
		origManaged, origReload, origMigrate := attachIsManaged, attachReloadConfig, attachMigrateLegacy
		attachIsManaged = func(context.Context, string) (bool, error) { return managed, nil }
		attachReloadConfig = func(string) error { return nil }
		attachMigrateLegacy = func(_ context.Context, server string) (bool, error) {
			// Ignore leaked sends from earlier tests' in-flight sweep
			// goroutines — only this test's own names count.
			if strings.HasPrefix(server, "sweep-") {
				swept <- server
			}
			return false, nil
		}
		tmux.ResetLegacyMigrationForTest()
		t.Cleanup(func() {
			attachIsManaged, attachReloadConfig, attachMigrateLegacy = origManaged, origReload, origMigrate
			tmux.ResetLegacyMigrationForTest()
		})
		return swept
	}

	t.Run("managed server is swept off the attach path", func(t *testing.T) {
		swept := stub(t, true)
		(&Server{}).reloadConfigForAttach("sweep-managed")
		select {
		case got := <-swept:
			if got != "sweep-managed" {
				t.Errorf("swept = %q, want sweep-managed", got)
			}
		case <-time.After(2 * time.Second):
			t.Error("sweep never ran — the async sweep must fire for a managed server")
		}
	})

	t.Run("external server is not swept", func(t *testing.T) {
		swept := stub(t, false)
		(&Server{}).reloadConfigForAttach("sweep-external")
		select {
		case got := <-swept:
			t.Errorf("swept %q — an external server must never be swept", got)
		case <-time.After(100 * time.Millisecond):
		}
	})

	t.Run("the once-guard runs the sweep at most once per server", func(t *testing.T) {
		swept := stub(t, true)
		(&Server{}).reloadConfigForAttach("sweep-once")
		(&Server{}).reloadConfigForAttach("sweep-once")
		select {
		case got := <-swept:
			if got != "sweep-once" {
				t.Errorf("swept = %q, want sweep-once", got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("sweep never ran")
		}
		select {
		case got := <-swept:
			t.Errorf("sweep ran twice (%q) — the once-guard must be taken synchronously", got)
		case <-time.After(100 * time.Millisecond):
		}
	})
}

// shortenLivenessTimeout overrides the package-level liveness deadline for one
// test and restores it on cleanup. Tests using it must not call t.Parallel():
// the var is read by every handleTerminalsWS in the package.
func shortenLivenessTimeout(t *testing.T, d time.Duration) {
	t.Helper()
	prev := terminalsLivenessTimeout
	terminalsLivenessTimeout = d
	t.Cleanup(func() { terminalsLivenessTimeout = prev })
}

// readUntilError drains a terminals socket in the background, counting pongs,
// and reports the first read error on errCh (buffered, so the goroutine never
// blocks on a caller that stopped listening).
func readUntilError(conn *websocket.Conn) (errCh chan error, pongs *atomic.Int32) {
	errCh = make(chan error, 1)
	pongs = &atomic.Int32{}
	go func() {
		for {
			msgType, raw, err := conn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			if msgType != websocket.TextMessage {
				continue
			}
			var m struct {
				Op string `json:"op"`
			}
			if json.Unmarshal(raw, &m) == nil && m.Op == "pong" {
				pongs.Add(1)
			}
		}
	}()
	return errCh, pongs
}

// TestTerminals_LivenessDeadlineTearsDownSilentSocket proves the root-cause
// fix for ghost attach clients: a terminals socket whose peer goes silent is
// torn down at the liveness deadline and its stream's REAL tmux attach client
// disappears from list-clients (releasing its sized client from the
// window-size-smallest computation). Real tmux — the reap is the point.
func TestTerminals_LivenessDeadlineTearsDownSilentSocket(t *testing.T) {
	tmuxServer, _, win0ID, _ := withTerminalsTmux(t)
	shortenLivenessTimeout(t, 300*time.Millisecond)
	ts := terminalsServerWithProdTmux(t)
	defer ts.Close()

	conn := dialTerminals(t, ts)
	defer conn.Close()
	openStream(t, conn, 1, tmuxServer, win0ID, 80, 24)
	testutil.MustWaitUntil(t, 5*time.Second, func() bool {
		return len(listClients(t, tmuxServer)) == 1
	}, "attach client never appeared on %s", tmuxServer)

	// Go silent: never write again. The server must close the socket on its
	// own well inside the client-side 3s read bound (deadline 300ms).
	errCh, _ := readUntilError(conn)
	select {
	case err := <-errCh:
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatalf("client-side timeout, not a server close: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server never closed the silent socket (liveness deadline did not fire)")
	}

	testutil.MustWaitUntil(t, 3*time.Second, func() bool {
		return len(listClients(t, tmuxServer)) == 0
	}, "attach client survived the liveness teardown")
}

// TestTerminals_LivenessDeadlinePingsKeepSocketAlive proves the deadline is
// re-armed by the client heartbeat: a socket that pings more often than the
// deadline stays open far past it and keeps receiving pongs.
func TestTerminals_LivenessDeadlinePingsKeepSocketAlive(t *testing.T) {
	shortenLivenessTimeout(t, 200*time.Millisecond)
	router := newTestRouter(&slowSessionFetcher{}, &mockTmuxOps{})
	srv := httptest.NewServer(router)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminals"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	errCh, pongs := readUntilError(conn)

	// Ping at a quarter of the deadline for four deadlines' worth of time.
	interval := terminalsLivenessTimeout / 4
	end := time.Now().Add(4 * terminalsLivenessTimeout)
	for time.Now().Before(end) {
		if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"ping"}`)); err != nil {
			t.Fatalf("write ping: %v", err)
		}
		select {
		case err := <-errCh:
			t.Fatalf("socket closed while heartbeating: %v", err)
		case <-time.After(interval):
		}
	}
	if pongs.Load() < 4 {
		t.Fatalf("expected pongs to keep flowing past the deadline, got %d", pongs.Load())
	}
}

// TestTerminals_LivenessDeadlineDataFramesRefresh proves ANY inbound frame is
// proof of life, not only pings: a socket sending only binary data frames
// (addressed to an unknown stream — dropped after the deadline re-arm) stays
// open past the deadline, and a final ping is still answered.
func TestTerminals_LivenessDeadlineDataFramesRefresh(t *testing.T) {
	shortenLivenessTimeout(t, 200*time.Millisecond)
	router := newTestRouter(&slowSessionFetcher{}, &mockTmuxOps{})
	srv := httptest.NewServer(router)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/terminals"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	errCh, pongs := readUntilError(conn)

	frame := make([]byte, 5)
	binary.BigEndian.PutUint32(frame[:4], 99) // no such stream: dropped, still liveness
	frame[4] = 'x'
	interval := terminalsLivenessTimeout / 4
	end := time.Now().Add(4 * terminalsLivenessTimeout)
	for time.Now().Before(end) {
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			t.Fatalf("write data frame: %v", err)
		}
		select {
		case err := <-errCh:
			t.Fatalf("socket closed while sending data frames: %v", err)
		case <-time.After(interval):
		}
	}
	if pongs.Load() != 0 {
		t.Fatalf("no pings were sent, yet %d pongs arrived", pongs.Load())
	}
	// Still open: a ping is answered.
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"ping"}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	testutil.MustWaitUntil(t, 2*time.Second, func() bool { return pongs.Load() == 1 },
		"socket did not answer a ping after the data-frame window")
}

// TestDeviceClass pins the closed-set UA classifier: five values, evaluated
// Electron/ → tablet → phone → desktop, with the ordering cases (Electron
// beats every other token; Android with Mobile is a phone, without it a
// tablet).
func TestDeviceClass(t *testing.T) {
	tests := []struct {
		name string
		ua   string
		want string
	}{
		{"empty is unknown", "", "unknown"},
		{"iphone is phone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "phone"},
		{"ipod is phone", "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148", "phone"},
		{"android with Mobile is phone", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36", "phone"},
		{"android without Mobile is tablet", "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", "tablet"},
		{"ipad is tablet", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "tablet"},
		{"explicit Tablet token is tablet", "Mozilla/5.0 (Tablet; rv:121.0) Gecko/121.0 Firefox/121.0", "tablet"},
		{"electron is desktop-shell", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Electron/31.0.0 Safari/537.36", "desktop-shell"},
		{"electron beats a phone token", "Mozilla/5.0 (Linux; Android 14) Mobile Electron/31.0.0", "desktop-shell"},
		{"macintosh safari is desktop", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15", "desktop"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := deviceClass(tt.ua); got != tt.want {
				t.Errorf("deviceClass(%q) = %q, want %q", tt.ua, got, tt.want)
			}
		})
	}
}

// TestPeerFromRequest pins the display-only peer derivation: the first
// X-Forwarded-For hop wins; without the header, RemoteAddr's host half (or the
// raw value when it carries no port).
func TestPeerFromRequest(t *testing.T) {
	tests := []struct {
		name       string
		xff        string
		remoteAddr string
		want       string
	}{
		{"first XFF hop wins", "100.64.0.12, 10.0.0.1", "127.0.0.1:51234", "100.64.0.12"},
		{"single XFF hop", "100.64.0.12", "127.0.0.1:51234", "100.64.0.12"},
		{"no XFF falls back to RemoteAddr host", "", "10.0.0.7:51234", "10.0.0.7"},
		{"RemoteAddr without a port passes through", "", "10.0.0.7", "10.0.0.7"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/ws/terminals", nil)
			r.RemoteAddr = tt.remoteAddr
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := peerFromRequest(r); got != tt.want {
				t.Errorf("peerFromRequest() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestAttachRegistryNilSafe pins the zero-value-Server contract: every method
// on a nil registry is a no-op, and Lookup resolves nothing (every viewer
// stays kind "tty").
func TestAttachRegistryNilSafe(t *testing.T) {
	var r *attachRegistry
	if _, ok := r.Lookup(1); ok {
		t.Error("nil registry Lookup must resolve nothing")
	}
	r.register(1, sessions.AttachMeta{}) // must not panic
	r.unregister(1)                      // must not panic
	if r.snapshot() != nil {
		t.Error("nil registry snapshot must be nil")
	}
}

// registryTestConn builds a terminalsConn wired to a registry-carrying Server
// over the real tmux ops — the direct attachStream-drive idiom.
func registryTestConn(server string, registry *attachRegistry) *terminalsConn {
	tc := &terminalsConn{
		s:           &Server{tmux: &prodTmuxOps{}, attachRegistry: registry},
		streams:     map[uint32]*stream{},
		wake:        make(chan struct{}, 1),
		done:        make(chan struct{}),
		peer:        "100.64.0.12",
		device:      "phone",
		connectedAt: time.Now(),
	}
	tc.writeFrame = func(f outFrame) error { return nil }
	return tc
}

// TestAttachRegistryLifecycle pins the register-at-publish /
// unregister-at-teardown contract against a real attach: after attachStream
// publishes, the attach pid resolves to the conn's meta (peer/device/connectedAt
// plus the live lastInbound closure); after teardown it is gone.
func TestAttachRegistryLifecycle(t *testing.T) {
	server, _, win0ID, _ := withTerminalsTmux(t)
	registry := &attachRegistry{byPID: map[int]sessions.AttachMeta{}}
	tc := registryTestConn(server, registry)
	defer close(tc.done)

	st := &stream{id: 7, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	tc.streams[7] = st
	tc.attachStream(openOp{Op: "open", ID: 7, Server: server, WindowID: win0ID, Cols: 80, Rows: 24}, st)

	snap := registry.snapshot()
	if len(snap) != 1 {
		t.Fatalf("registry after publish = %v, want exactly one pid", snap)
	}
	var pid int
	for p := range snap {
		pid = p
	}
	meta, ok := registry.Lookup(pid)
	if !ok {
		t.Fatalf("Lookup(%d) = false after publish", pid)
	}
	if meta.Peer != "100.64.0.12" || meta.Device != "phone" {
		t.Errorf("meta = %+v, want the conn's peer/device", meta)
	}
	if meta.LastInbound == nil {
		t.Error("meta.LastInbound must be the conn's live closure, not nil")
	}

	st.teardown()
	if _, ok := registry.Lookup(pid); ok {
		t.Errorf("Lookup(%d) = true after teardown — the entry must die with the attach", pid)
	}
}

// TestAttachStreamPublishRaceNeverRegisters pins the publish-race branch: a
// stream whose placeholder was removed while the attach was in flight is
// killed and reaped WITHOUT a registry entry (the never-published cmd's sole
// owner is the race branch).
func TestAttachStreamPublishRaceNeverRegisters(t *testing.T) {
	server, _, win0ID, _ := withTerminalsTmux(t)
	registry := &attachRegistry{byPID: map[int]sessions.AttachMeta{}}
	tc := registryTestConn(server, registry)
	defer close(tc.done)

	// The placeholder is gone from the registry map but the stream is still
	// live (neither st.closed nor tc.done), so attachStream runs the full
	// resolve→attach path and only then hits the publish-race branch.
	st := &stream{id: 7, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	tc.attachStream(openOp{Op: "open", ID: 7, Server: server, WindowID: win0ID, Cols: 80, Rows: 24}, st)

	if snap := registry.snapshot(); len(snap) != 0 {
		t.Errorf("publish-race branch registered %v — must never register", snap)
	}
}

// TestStreamTeardownUnregistersBeforeKill pins the ordering contract: the
// registry entry is removed before the attach process is killed and reaped, so
// a reused pid can never briefly alias the dead attach. ProcessState is
// populated only by Wait, so a nil ProcessState at unregister time proves the
// kill+reap has not run yet.
func TestStreamTeardownUnregistersBeforeKill(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 30")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		cancel()
		t.Skipf("pty start unavailable: %v", err)
	}
	var liveAtUnregister bool
	st := &stream{
		id:     1,
		queue:  make(chan outFrame, streamQueueDepth),
		closed: make(chan struct{}),
		ptmx:   ptmx,
		cancel: cancel,
		cmd:    cmd,
		unregister: func() {
			liveAtUnregister = cmd.ProcessState == nil
		},
	}
	st.teardown()
	if !liveAtUnregister {
		t.Error("unregister ran after the kill/reap — a reused pid could alias the dead attach")
	}
	if cmd.ProcessState == nil {
		t.Fatal("child not reaped — teardown must still Wait after unregistering")
	}
}

// --- Isolated relay sessions (`isolate` on the open op) ---

// isoMockConn builds a terminalsConn wired to a mockTmuxOps — the direct
// attachStream-drive idiom (registryTestConn's mock twin). The stream registry
// starts empty; attachStream's failure paths emit `closed` onto the reserved
// control pseudo-stream, which awaitControlClosed drains.
func isoMockConn(ops *mockTmuxOps) *terminalsConn {
	tc := &terminalsConn{
		s:           &Server{tmux: ops},
		streams:     map[uint32]*stream{},
		wake:        make(chan struct{}, 1),
		done:        make(chan struct{}),
		peer:        "100.64.0.12",
		device:      "phone",
		connectedAt: time.Now(),
	}
	tc.writeFrame = func(f outFrame) error { return nil }
	return tc
}

// awaitControlClosed pops the next `closed` control frame from the reserved
// control pseudo-stream after a synchronous attachStream run.
func awaitControlClosed(t *testing.T, tc *terminalsConn, id uint32) closedFrame {
	t.Helper()
	tc.mu.Lock()
	ctl := tc.streams[controlStreamID]
	tc.mu.Unlock()
	if ctl == nil {
		t.Fatalf("no control stream — attachStream emitted no `closed` for id %d", id)
	}
	for {
		select {
		case f := <-ctl.queue:
			if f.control == nil {
				continue
			}
			var frame closedFrame
			if err := json.Unmarshal(f.control, &frame); err != nil {
				continue
			}
			if frame.Op == "closed" && frame.ID == id {
				return frame
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no `closed` frame for id %d on the control stream", id)
		}
	}
}

// driveAttachStream registers a placeholder stream and runs attachStream
// synchronously against the mock ops. The server value is a nonexistent test
// socket: attach-session on it spawns a short-lived client that errors out (so
// the pick under test — recorded by the mock BEFORE the attach — is isolated
// from any live tmux server), and cleanup kills the stray test server the
// attach may have booted.
func driveAttachStream(t *testing.T, tc *terminalsConn, id uint32, windowID string, isolate bool) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "tmux", "-L", "rk-test-relay-isomock", "kill-server").Run()
	})
	st := &stream{id: id, queue: make(chan outFrame, streamQueueDepth), closed: make(chan struct{})}
	tc.streams[id] = st
	tc.attachStream(openOp{Op: "open", ID: id, Server: "rk-test-relay-isomock", WindowID: windowID, Cols: 80, Rows: 24, Isolate: isolate}, st)
}

func TestOpenOp_IsolateDecodes(t *testing.T) {
	var absent openOp
	if err := json.Unmarshal([]byte(`{"op":"open","id":7,"windowId":"@42","cols":120,"rows":32}`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.Isolate {
		t.Error("absent isolate field must decode as false (back-compat)")
	}
	var present openOp
	if err := json.Unmarshal([]byte(`{"op":"open","id":7,"windowId":"@42","isolate":true}`), &present); err != nil {
		t.Fatal(err)
	}
	if !present.Isolate {
		t.Error("isolate:true must decode as true")
	}
}

func TestAttachStream_NonIsolatePicksHome(t *testing.T) {
	ops := &mockTmuxOps{resolveWindowSessionResult: "home"}
	tc := isoMockConn(ops)

	driveAttachStream(t, tc, 1, "@42", false)

	if ops.ensureIsoSessionCalled {
		t.Error("non-isolated open must never call EnsureIsoSession")
	}
	if ops.resolveWindowSessionID != "@42" {
		t.Errorf("ResolveWindowSession id = %q, want @42 (home resolution)", ops.resolveWindowSessionID)
	}
	if ops.selectWindowInSessionSession != "home" {
		t.Errorf("SelectWindowInSession session = %q, want %q (home)", ops.selectWindowInSessionSession, "home")
	}
	// The attach child errors out on the test socket and is torn down here;
	// regardless of that outcome, NO rollback kill may run — rollback is
	// iso-only.
	tc.teardown()
	if called, name := ops.KillSessionWasCalled(); called {
		t.Errorf("KillSession(%q) on a non-iso attach outcome — rollback must be iso-only", name)
	}
}

func TestAttachStream_IsolateOnPinnedPicksPin(t *testing.T) {
	pin, _ := tmux.PinSessionName("@42")
	ops := &mockTmuxOps{hasSessionNames: map[string]bool{pin: true}}
	tc := isoMockConn(ops)

	driveAttachStream(t, tc, 1, "@42", true)
	defer tc.teardown()

	if ops.ensureIsoSessionCalled {
		t.Error("a pinned window already isolates — EnsureIsoSession must never run for it")
	}
	if ops.selectWindowInSessionSession != pin {
		t.Errorf("SelectWindowInSession session = %q, want pin-session %q", ops.selectWindowInSessionSession, pin)
	}
}

func TestAttachStream_IsolateUnpinnedEnsuresIso(t *testing.T) {
	ops := &mockTmuxOps{resolveWindowSessionResult: "home"}
	tc := isoMockConn(ops)

	driveAttachStream(t, tc, 1, "@42", true)
	defer tc.teardown()

	if !ops.ensureIsoSessionCalled || ops.ensureIsoSessionWindowID != "@42" {
		t.Errorf("EnsureIsoSession called=%v windowID=%q, want (true, @42)", ops.ensureIsoSessionCalled, ops.ensureIsoSessionWindowID)
	}
	if ops.resolveWindowSessionID != "" {
		t.Errorf("ResolveWindowSession called for an isolated open — the iso pick must not fall through to home resolution")
	}
	iso, _ := tmux.IsoSessionName("@42")
	if ops.selectWindowInSessionSession != iso {
		t.Errorf("SelectWindowInSession session = %q, want iso session %q", ops.selectWindowInSessionSession, iso)
	}
}

// The attach-failure rollback decision: kill the iso session only when it has
// zero attached clients (a failed attach never ran the destroy-unattached
// chain, so a client-less session would leak) — and never under a shared
// viewer or an unreadable probe.
func TestRollbackIsoAttach(t *testing.T) {
	iso, _ := tmux.IsoSessionName("@42")

	t.Run("client-less iso session is killed", func(t *testing.T) {
		ops := &mockTmuxOps{sessionClientCountResult: 0}
		tc := isoMockConn(ops)
		defer tc.teardown()
		tc.rollbackIsoAttach("rk-test-relay-isomock", iso)
		if called, name := ops.KillSessionWasCalled(); !called || name != iso {
			t.Errorf("rollback kill = (%v, %q), want (true, %q)", called, name, iso)
		}
	})

	t.Run("shared iso session survives", func(t *testing.T) {
		ops := &mockTmuxOps{sessionClientCountResult: 1}
		tc := isoMockConn(ops)
		defer tc.teardown()
		tc.rollbackIsoAttach("rk-test-relay-isomock", iso)
		if called, name := ops.KillSessionWasCalled(); called {
			t.Errorf("rollback killed %q with another viewer attached — a shared iso session must survive", name)
		}
	})

	t.Run("probe failure leaves the session", func(t *testing.T) {
		ops := &mockTmuxOps{sessionClientCountErr: errors.New("server gone")}
		tc := isoMockConn(ops)
		defer tc.teardown()
		tc.rollbackIsoAttach("rk-test-relay-isomock", iso)
		if called, name := ops.KillSessionWasCalled(); called {
			t.Errorf("rollback killed %q on a failed client probe — unknown state must keep the session", name)
		}
	})
}

func TestAttachStream_IsolateEnsureFailureMissingWindow(t *testing.T) {
	ops := &mockTmuxOps{ensureIsoSessionErr: errors.New(`window "@9999" not found`)}
	tc := isoMockConn(ops)
	defer close(tc.done)

	driveAttachStream(t, tc, 1, "@9999", true)

	if f := awaitControlClosed(t, tc, 1); f.Code != closeWindowNotFound {
		t.Errorf("closed code = %d, want %d (4004 — the window is missing)", f.Code, closeWindowNotFound)
	}
	// Socket-level: the failure must be per-stream — the conn stays live.
	select {
	case <-tc.done:
		t.Error("socket torn down for a per-stream ensure failure")
	default:
	}
}

// A pre-attach failure after a SUCCESSFUL ensure (select-window here) must
// roll the ensured iso session back — the attach argv never ran, so
// destroy-unattached was never chained and the client-less session would leak.
func TestAttachStream_IsolateSelectFailureRollsBackIso(t *testing.T) {
	iso, _ := tmux.IsoSessionName("@42")
	ops := &mockTmuxOps{selectWindowInSessionErr: errors.New("window gone")}
	tc := isoMockConn(ops)
	defer close(tc.done)

	driveAttachStream(t, tc, 1, "@42", true)

	if f := awaitControlClosed(t, tc, 1); f.Code != closeWindowNotFound {
		t.Errorf("closed code = %d, want %d (select-window failure maps to 4004)", f.Code, closeWindowNotFound)
	}
	if called, name := ops.KillSessionWasCalled(); !called || name != iso {
		t.Errorf("rollback kill = (%v, %q), want (true, %q) — a pre-attach failure must not leak the ensured iso session", called, name, iso)
	}
}

func TestAttachStream_IsolateEnsureFailureAttachClass(t *testing.T) {
	ops := &mockTmuxOps{ensureIsoSessionErr: errors.New("create iso session: boom")}
	tc := isoMockConn(ops)
	defer close(tc.done)

	driveAttachStream(t, tc, 1, "@42", true)

	if f := awaitControlClosed(t, tc, 1); f.Code != closeAttachFailed {
		t.Errorf("closed code = %d, want %d (4001 — ensure failure other than a missing window)", f.Code, closeAttachFailed)
	}
	select {
	case <-tc.done:
		t.Error("socket torn down for a per-stream ensure failure")
	default:
	}
}

func TestAttachArgv(t *testing.T) {
	conf := tmux.ConfigPath()

	home := attachArgv("default", "home", false)
	wantTail := []string{"attach-session", "-t", "home"}
	if len(home) < len(wantTail) || strings.Join(home[len(home)-len(wantTail):], " ") != strings.Join(wantTail, " ") {
		t.Errorf("non-iso argv tail = %v, want %v (unchanged non-iso form)", home, wantTail)
	}
	for _, a := range home {
		if a == ";" {
			t.Errorf("non-iso argv %v carries the iso lifecycle chain", home)
		}
	}
	if conf != "" && (len(home) < 2 || home[0] != "-f" || home[1] != conf) {
		t.Errorf("default-server argv = %v, want no -L and the conf -f first", home)
	}

	iso, _ := tmux.IsoSessionName("@42")
	got := attachArgv("srv", iso, true)
	want := []string{"-L", "srv"}
	if conf != "" {
		want = append(want, "-f", conf)
	}
	want = append(want, "attach-session", "-t", iso, ";", "set-option", "-t", iso, "destroy-unattached", "on")
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("iso argv = %v, want %v", got, want)
	}
}

// TestTerminals_IsolateFlagSurvivesTheWire pins the read-loop mapping: an
// `isolate:true` JSON open op decoded through controlIn must reach attachStream
// with Isolate set (the op is rebuilt field-by-field from the controlIn decode,
// so a field present only on openOp would be silently dropped). Mock ops: the
// ensure call itself is the assertion.
func TestTerminals_IsolateFlagSurvivesTheWire(t *testing.T) {
	ops := &mockTmuxOps{}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	router := NewTestRouter(logger, &mockSessionFetcher{}, ops, "test-host")
	ts := httptest.NewServer(router)
	defer ts.Close()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "tmux", "-L", "rk-test-relay-isomock", "kill-server").Run()
	})

	conn := dialTerminals(t, ts)
	defer conn.Close()

	body, _ := json.Marshal(map[string]any{"op": "open", "id": 7, "server": "rk-test-relay-isomock", "windowId": "@42", "cols": 80, "rows": 24, "isolate": true})
	if err := conn.WriteMessage(websocket.TextMessage, body); err != nil {
		t.Fatalf("write open op: %v", err)
	}
	if !testutil.WaitUntil(t, 3*time.Second, func() bool {
		called, _ := ops.EnsureIsoSessionWasCalled()
		return called
	}) {
		t.Error("EnsureIsoSession never called — the isolate flag did not survive the wire decode")
	}
	if _, windowID := ops.EnsureIsoSessionWasCalled(); windowID != "@42" {
		t.Errorf("EnsureIsoSession windowID = %q, want @42", windowID)
	}
}
