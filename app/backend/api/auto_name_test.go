package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// newTestAutoNameTracker builds a tracker with a controllable clock (the
// decision is pure; delivery is exercised through the deliver seam).
func newTestAutoNameTracker() (*autoNameTracker, *time.Time) {
	base := time.Unix(1_000_000, 0)
	tr := newAutoNameTracker()
	clock := base
	tr.now = func() time.Time { return clock }
	return tr, &clock
}

// autoWin builds a subject window with an agent session ref (eligible) in the
// given rollup state.
func autoWin(id, state string) *tmux.WindowInfo {
	return &tmux.WindowInfo{WindowID: id, Name: "w" + id, AgentState: state, AgentSessionRef: "ref"}
}

// autoOp builds the server operator window in the given rollup state.
func autoOp(state string) *tmux.WindowInfo {
	return &tmux.WindowInfo{WindowID: "@9", Name: "operator", Role: "operator", AgentState: state}
}

// TestAutoName_TransitionMatrix: only busy(active|waiting)→idle fires;
// idle→idle, ""→idle, →active/→waiting, and the first-ever observation emit
// nothing.
func TestAutoName_TransitionMatrix(t *testing.T) {
	cases := []struct {
		name  string
		prev  string // "" with seen=false means first observation
		cur   string
		fires bool
	}{
		{"active→idle", "active", "idle", true},
		{"waiting→idle", "waiting", "idle", true},
		{"idle→idle", "idle", "idle", false},
		{"empty→idle", "", "idle", false},
		{"idle→active", "idle", "active", false},
		{"active→waiting", "active", "waiting", false},
		{"waiting→active", "waiting", "active", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tr, clock := newTestAutoNameTracker()
			op := autoOp("idle")
			// Tick 1: establish the previous state.
			tr.decide("s", []*tmux.WindowInfo{autoWin("@1", c.prev), op})
			*clock = clock.Add(time.Second)
			// Tick 2: the transition under test.
			w := autoWin("@1", c.cur)
			got := tr.decide("s", []*tmux.WindowInfo{w, op})
			if c.fires {
				if got == nil {
					t.Fatalf("%s must emit a candidate", c.name)
				}
				if got.subject != w || got.operator != op {
					t.Errorf("candidate = subject %v / operator %v, want the tick's windows", got.subject.WindowID, got.operator.WindowID)
				}
			} else if got != nil {
				t.Fatalf("%s must not emit, got %+v", c.name, got.subject.WindowID)
			}
		})
	}

	t.Run("first observation as idle", func(t *testing.T) {
		tr, _ := newTestAutoNameTracker()
		if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("idle")}); got != nil {
			t.Fatalf("a window first observed as idle must never trigger")
		}
	})
	t.Run("first observation as busy, then idle fires", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoOp("idle")})
		*clock = clock.Add(time.Second)
		if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("idle")}); got == nil {
			t.Fatalf("busy→idle across two observations must fire")
		}
	})
}

// TestAutoName_EligibilitySkips: no operator on the server, the operator window
// itself transitioning, and a chatless subject all drop the transition silently
// (no candidate, no stamp).
func TestAutoName_EligibilitySkips(t *testing.T) {
	t.Run("no operator on server", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active")})
		*clock = clock.Add(time.Second)
		if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle")}); got != nil {
			t.Fatalf("operator-less server must degrade to absent")
		}
	})
	t.Run("subject is the operator", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		op := autoOp("active")
		op.AgentSessionRef = "ref"
		tr.decide("s", []*tmux.WindowInfo{op})
		*clock = clock.Add(time.Second)
		if got := tr.decide("s", []*tmux.WindowInfo{autoOp("idle")}); got != nil {
			t.Fatalf("the operator window itself must never be a subject")
		}
	})
	t.Run("subject without agent session or pane", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		chatless := &tmux.WindowInfo{WindowID: "@1", Name: "w", AgentState: "active"}
		tr.decide("s", []*tmux.WindowInfo{chatless, autoOp("idle")})
		*clock = clock.Add(time.Second)
		chatless = &tmux.WindowInfo{WindowID: "@1", Name: "w", AgentState: "idle"}
		if got := tr.decide("s", []*tmux.WindowInfo{chatless, autoOp("idle")}); got != nil {
			t.Fatal("a subject with no agent context must be dropped")
		}
	})
	t.Run("agent lifecycle without session identity", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		win := &tmux.WindowInfo{
			WindowID: "@1", AgentState: "active",
			Panes: []tmux.PaneInfo{{PaneID: "%1", AgentState: "active", IsActive: true}},
		}
		tr.decide("s", []*tmux.WindowInfo{win, autoOp("idle")})
		*clock = clock.Add(time.Second)
		win.AgentState, win.Panes[0].AgentState = "idle", "idle"
		if got := tr.decide("s", []*tmux.WindowInfo{win, autoOp("idle")}); got == nil || got.subject != win {
			t.Fatalf("lifecycle-only agent should be eligible, got %+v", got)
		}
	})
	// Ineligible transitions are consumed WITHOUT a stamp: once eligible, the
	// window's next busy→idle fires immediately (no phantom cooldown).
	t.Run("ineligible transition does not stamp cooldown", func(t *testing.T) {
		tr, clock := newTestAutoNameTracker()
		chatless := &tmux.WindowInfo{WindowID: "@1", Name: "w", AgentState: "active"}
		tr.decide("s", []*tmux.WindowInfo{chatless, autoOp("idle")})
		*clock = clock.Add(time.Second)
		chatless = &tmux.WindowInfo{WindowID: "@1", Name: "w", AgentState: "idle"}
		tr.decide("s", []*tmux.WindowInfo{chatless, autoOp("idle")}) // consumed, unstamped
		// The window gains an agent session ref and cycles busy→idle again right
		// away.
		*clock = clock.Add(time.Second)
		tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoOp("idle")})
		*clock = clock.Add(time.Second)
		if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("idle")}); got == nil {
			t.Fatalf("an unstamped earlier transition must not suppress a later eligible one")
		}
	})
}

// TestAutoName_Cooldown: a window that triggered an auto-request is suppressed
// for the cooldown; after it, a fresh busy→idle fires again.
func TestAutoName_Cooldown(t *testing.T) {
	tr, clock := newTestAutoNameTracker()
	op := autoOp("idle")

	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), op}); got == nil {
		t.Fatalf("first transition must fire")
	}
	// Flap busy→idle again 5 minutes later — inside the 15-min cooldown.
	*clock = clock.Add(5 * time.Minute)
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), op}); got != nil {
		t.Fatalf("cooldown must suppress the flapping window")
	}
	// Past the cooldown a fresh transition fires again.
	*clock = clock.Add(autoNameCooldown)
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), op}); got == nil {
		t.Fatalf("a fresh transition after the cooldown must fire")
	}
}

// TestAutoName_MinGap: a second window's transition within the per-server
// min-gap of the last delivery is suppressed; past the gap it fires.
func TestAutoName_MinGap(t *testing.T) {
	tr, clock := newTestAutoNameTracker()
	op := autoOp("idle")

	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoWin("@2", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "active"), op}); got == nil {
		t.Fatalf("@1 must fire")
	}
	// @2 transitions 30s later — inside the 60s per-server min-gap.
	*clock = clock.Add(30 * time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "idle"), op}); got != nil {
		t.Fatalf("per-server min-gap must suppress back-to-back deliveries")
	}
	// Past the gap (and with a fresh busy→idle) @2 fires.
	*clock = clock.Add(autoNameMinGap)
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "idle"), op}); got == nil {
		t.Fatalf("@2 must fire once the min-gap has passed")
	}
}

// TestAutoName_OnePerTick: two eligible windows transitioning in the same tick
// yield exactly ONE candidate; the dropped window is NOT stamped (its cooldown
// stays clear, so its next busy→idle may fire).
func TestAutoName_OnePerTick(t *testing.T) {
	tr, clock := newTestAutoNameTracker()
	op := autoOp("idle")

	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoWin("@2", "active"), op})
	*clock = clock.Add(time.Second)
	got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "idle"), op})
	if got == nil {
		t.Fatalf("one of the two transitions must fire")
	}
	delivered := got.subject.WindowID
	dropped := "@2"
	if delivered == "@2" {
		dropped = "@1"
	}
	if len(tr.attempted) != 1 {
		t.Fatalf("exactly one window may be stamped per tick, got %d", len(tr.attempted))
	}
	if _, ok := tr.attempted[waitingKey("s", dropped)]; ok {
		t.Fatalf("the dropped window %s must NOT be cooldown-stamped", dropped)
	}
	// The dropped window cycles busy→idle again after the min-gap and fires.
	*clock = clock.Add(autoNameMinGap + time.Second)
	wins := []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "idle"), op}
	for _, w := range wins {
		if w.WindowID == dropped {
			w.AgentState = "active"
		}
	}
	tr.decide("s", wins)
	*clock = clock.Add(time.Second)
	got = tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoWin("@2", "idle"), op})
	if got == nil || got.subject.WindowID != dropped {
		t.Fatalf("the dropped window's next transition must fire, got %+v", got)
	}
}

// TestAutoName_StampsOnBusyOperator: the busy gate lives in the delivery core,
// so decide emits (and stamps BOTH limits) even when the operator is active —
// a busy operator never converts deferred transitions into a later burst.
func TestAutoName_StampsOnBusyOperator(t *testing.T) {
	tr, clock := newTestAutoNameTracker()

	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoOp("active")})
	*clock = clock.Add(time.Second)
	got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("active")})
	if got == nil {
		t.Fatalf("decide must still emit when the operator is busy (the core skips)")
	}
	if _, ok := tr.attempted[waitingKey("s", "@1")]; !ok {
		t.Fatalf("the attempt must be cooldown-stamped even though delivery will skip")
	}
	if _, ok := tr.lastSent["s"]; !ok {
		t.Fatalf("the server min-gap must be stamped even though delivery will skip")
	}
	// The next busy→idle within the cooldown is suppressed even though the
	// previous one never reached the operator.
	*clock = clock.Add(time.Minute)
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), autoOp("idle")})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("idle")}); got != nil {
		t.Fatalf("the stamped cooldown must suppress the follow-up transition")
	}
}

// TestAutoName_RetainReapsVanished: a vanished window's previous-state and
// cooldown entries are reaped (so a re-created window id starts fresh), an
// unpolled server's entries survive the sweep, and a dead server's lastSent
// stamp is reaped.
func TestAutoName_RetainReapsVanished(t *testing.T) {
	tr, clock := newTestAutoNameTracker()
	op := autoOp("idle")

	// Server s: @1 fires. Server b: @1 fires.
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), op})
	tr.decide("b", []*tmux.WindowInfo{autoWin("@1", "active"), autoOp("idle")})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), op}); got == nil {
		t.Fatalf("server s must fire")
	}
	if got := tr.decide("b", []*tmux.WindowInfo{autoWin("@1", "idle"), autoOp("idle")}); got == nil {
		t.Fatalf("server b must fire")
	}

	// Tick: s polled but @1 vanished; b's fetch failed transiently (not polled).
	tr.retain(map[string]bool{}, map[string]bool{"s": true})
	if _, ok := tr.prev[waitingKey("s", "@1")]; ok {
		t.Errorf("vanished window's prev state must be reaped")
	}
	if _, ok := tr.attempted[waitingKey("s", "@1")]; ok {
		t.Errorf("vanished window's cooldown stamp must be reaped")
	}
	if _, ok := tr.lastSent["s"]; ok {
		t.Errorf("windowless server's lastSent must be reaped")
	}
	if _, ok := tr.prev[waitingKey("b", "@1")]; !ok {
		t.Errorf("unpolled server b's state must survive the sweep")
	}
	if _, ok := tr.attempted[waitingKey("b", "@1")]; !ok {
		t.Errorf("unpolled server b's cooldown must survive the sweep")
	}

	// A re-created @1 on s starts fresh: no stale cooldown suppresses it.
	*clock = clock.Add(time.Second)
	tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "active"), op})
	*clock = clock.Add(time.Second)
	if got := tr.decide("s", []*tmux.WindowInfo{autoWin("@1", "idle"), op}); got == nil {
		t.Fatalf("re-created window must fire after the reap")
	}
}

// TestAutoName_AdvanceFansOutDetached: advance returns the live keys, decides
// synchronously, and hands the candidate to the deliver seam; a nil deliver
// (test hubs) still advances tracking.
func TestAutoName_AdvanceFansOutDetached(t *testing.T) {
	tr, _ := newTestAutoNameTracker()
	type call struct {
		server, subject, operator string
	}
	calls := make(chan call, 1)
	tr.deliver = func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error {
		calls <- call{server, subject.WindowID, operator.WindowID}
		return nil
	}
	sess := []sessions.ProjectSession{
		{Name: "s", Windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "zsh", AgentState: "active", AgentSessionRef: "ref"},
		}},
		{Name: "_rk-operator", Windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Role: "operator", AgentState: "idle"},
		}},
	}
	live := tr.advance("default", sess)
	if !live[waitingKey("default", "@1")] || !live[waitingKey("default", "@9")] {
		t.Fatalf("advance must return live keys for every observed window, got %v", live)
	}
	// Flip the subject to idle and advance again — the candidate must reach the
	// deliver seam.
	sess[0].Windows[0].AgentState = "idle"
	tr.advance("default", sess)
	select {
	case c := <-calls:
		if c.server != "default" || c.subject != "@1" || c.operator != "@9" {
			t.Errorf("deliver call = %+v, want default/@1/@9", c)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("deliver seam was never called for an eligible transition")
	}
}

// TestAutoName_DeliverBusyOperatorSkipsInjection (T007): through the deliver
// seam wired exactly as initSSEHub wires it (the tracker's closure over
// deliverOperatorRequest with the fix-tab-name template), a busy operator
// produces ZERO injection subprocesses — reject, never queue.
func TestAutoName_DeliverBusyOperatorSkipsInjection(t *testing.T) {
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("active")}
	ops := &mockTmuxOps{}
	s := &Server{logger: slog.Default(), sessions: sf, tmux: ops, hostname: "host"}

	tr, _ := newTestAutoNameTracker()
	results := make(chan error, 1)
	tr.deliver = func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error {
		err := s.deliverOperatorRequest(ctx, server, subject, operator, operatorTemplates["fix-tab-name"], "")
		results <- err
		return err
	}

	sess := operatorSessions("active")
	sess[0].Windows[0].AgentState = "active"
	tr.advance("default", sess) // tick 1: subject observed active
	sess[0].Windows[0].AgentState = "idle"
	tr.advance("default", sess) // tick 2: busy→idle → delivery attempt

	select {
	case err := <-results:
		var rej *operatorReject
		if !errors.As(err, &rej) || rej.status != http.StatusConflict {
			t.Errorf("deliver err = %v, want a 409 busy reject", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("deliver seam was never called")
	}
	if len(ops.agentSendCalls) != 0 {
		t.Errorf("injection ran (%v) for a busy operator — must be a silent skip", ops.agentSendCalls)
	}
	if _, ok := tr.attempted[waitingKey("default", "@1")]; !ok {
		t.Errorf("the busy-skipped attempt must still stamp the per-window cooldown")
	}
}

// TestAutoName_DeliverIdleOperatorInjects (T007): the same seam against an idle
// operator runs the full injection sequence targeting the OPERATOR's pane %9 —
// the auto path is byte-for-byte the HTTP path post-parse.
func TestAutoName_DeliverIdleOperatorInjects(t *testing.T) {
	fastAgentSendProbe(t)
	stageFixtureTranscript(t, testTranscriptRef)
	sf := &mockSessionFetcher{result: operatorSessions("idle")}
	ops := &mockTmuxOps{capturePaneResults: []string{"❯ ", "❯ [Pasted text #1 +9 lines]", "working"}}
	s := &Server{logger: slog.Default(), sessions: sf, tmux: ops, hostname: "host"}

	tr, _ := newTestAutoNameTracker()
	results := make(chan error, 1)
	tr.deliver = func(ctx context.Context, server string, subject, operator *tmux.WindowInfo) error {
		err := s.deliverOperatorRequest(ctx, server, subject, operator, operatorTemplates["fix-tab-name"], "")
		results <- err
		return err
	}

	sess := operatorSessions("idle")
	tr.advance("default", sess) // first observation (subject has no hooks yet)
	sess[0].Windows[0].AgentState = "active"
	tr.advance("default", sess) // observed active
	sess[0].Windows[0].AgentState = "idle"
	tr.advance("default", sess) // busy→idle → delivery

	select {
	case err := <-results:
		if err != nil {
			t.Fatalf("deliver err = %v, want success against an idle operator", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("deliver seam was never called")
	}
	want := []string{"clear-pane-mode", "capture-pane", "set-buffer", "paste-buffer", "capture-pane", "send-keys", "capture-pane"}
	if len(ops.agentSendCalls) != len(want) {
		t.Fatalf("injection order = %v, want %v", ops.agentSendCalls, want)
	}
	for i := range want {
		if ops.agentSendCalls[i] != want[i] {
			t.Fatalf("injection order = %v, want %v", ops.agentSendCalls, want)
		}
	}
	if ops.pasteAgentPaneID != "%9" || ops.sendEnterPaneID != "%9" {
		t.Errorf("injection targeted paste=%q enter=%q, want the OPERATOR pane %%9",
			ops.pasteAgentPaneID, ops.sendEnterPaneID)
	}
	if prompt := ops.setAgentBufferText; !strings.Contains(prompt, "already accurately describes") {
		t.Errorf("auto-path prompt missing the no-op clause:\n%s", prompt)
	}
}

// TestAutoName_SettingGatesTracker: the feature is strictly opt-in
// (settings `auto_name` → Server.autoNameEnabled). Disabled ⇒ initSSEHub nils the
// hub's tracker — the feature-absent state both tick sites check — so no
// transition can ever fire; enabled ⇒ the tracker survives with its delivery
// seam wired.
func TestAutoName_SettingGatesTracker(t *testing.T) {
	t.Run("disabled nils the tracker", func(t *testing.T) {
		s := &Server{logger: slog.Default(), sessions: &mockSessionFetcher{}, hostname: "host"}
		s.initSSEHub()
		if s.sseHub.autoName != nil {
			t.Fatalf("autoName tracker present with autoNameEnabled=false — feature must be absent")
		}
	})

	t.Run("enabled wires the deliver seam", func(t *testing.T) {
		s := &Server{logger: slog.Default(), sessions: &mockSessionFetcher{}, hostname: "host", autoNameEnabled: true}
		s.initSSEHub()
		if s.sseHub.autoName == nil {
			t.Fatalf("autoName tracker missing with autoNameEnabled=true")
		}
		if s.sseHub.autoName.deliver == nil {
			t.Fatalf("deliver seam not wired with autoNameEnabled=true")
		}
	})
}
