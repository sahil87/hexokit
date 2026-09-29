package api

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/gui"
	"rk/internal/settings"
)

// guiProbeStub is a scripted gui.Probe stand-in counting its invocations.
type guiProbeStub struct {
	mu    sync.Mutex
	calls int
	info  gui.Info
	err   error
}

func (s *guiProbeStub) probe(ctx context.Context, network, addr string) (gui.Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.info, s.err
}

func (s *guiProbeStub) set(info gui.Info, err error) {
	s.mu.Lock()
	s.info, s.err = info, err
	s.mu.Unlock()
}

func (s *guiProbeStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// stubGuiSeams installs the session-option reader and prober on ONE hub
// (per-hub seams — a stub never leaks into another test's poll loop).
func stubGuiSeams(hub *sseHub, display, backend string, ok bool, prober func(ctx context.Context, network, addr string) (gui.Info, error)) {
	hub.guiSessionOptionsFn = func(ctx context.Context) (string, string, string, bool) {
		return display, backend, "", ok
	}
	hub.guiProbeFn = prober
}

// enableGuiSettings persists gui.enabled=true into the isolated HOME.
func enableGuiSettings(t *testing.T) {
	t.Helper()
	isolateSettings(t)
	st := settings.Load()
	st.GUIEnabled = true
	if err := settings.Save(st); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

func newGuiTestHub() *sseHub {
	return newSSEHub(&slowSessionFetcher{}, nil, nil, nil)
}

func (h *sseHub) cachedGui(t *testing.T) string {
	t.Helper()
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cachedGuiJSON
}

func TestGuiTickDisabledPayloadShape(t *testing.T) {
	isolateSettings(t) // fresh HOME ⇒ gui.enabled false by default
	hub := newGuiTestHub()
	hub.guiTick()
	want := `[{"id":"host","enabled":false,"backend":"","reachable":false,"display":"","width":0,"height":0,"viewers":0,"wm":"","locked":false,"geometry":""}]`
	if got := hub.cachedGui(t); got != want {
		t.Fatalf("disabled payload = %s, want %s", got, want)
	}
}

// The geometry rides the settings file like gui.enabled: the tick's one
// settings.Load carries gui.geometry into the payload while enabled, and
// setGUIEnabled(false) clears it.
func TestGuiTickPayloadCarriesGeometry(t *testing.T) {
	isolateSettings(t)
	st := settings.Load()
	st.GUIEnabled = true
	st.GUIGeometry = "1600x900"
	if err := settings.Save(st); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1600, Height: 900}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)

	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":"1600x900"`) {
		t.Fatalf("payload = %s, want \"geometry\":\"1600x900\" from the setting", got)
	}

	// A settings edit surfaces on the next tick (the per-tick re-read).
	st.GUIGeometry = gui.GeometryAuto
	if err := settings.Save(st); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":"auto"`) {
		t.Fatalf("payload = %s, want \"geometry\":\"auto\" after the edit", got)
	}

	hub.setGUIEnabled(false)
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":""`) {
		t.Fatalf("payload = %s, want geometry cleared on disable", got)
	}
}

func TestGuiTickPayloadCarriesWM(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	hub.guiSessionOptionsFn = func(ctx context.Context) (string, string, string, bool) {
		return ":10", "Xtigervnc", "icewm-session", true
	}
	hub.guiProbeFn = stub.probe

	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"wm":"icewm-session"`) {
		t.Fatalf("payload = %s, want \"wm\":\"icewm-session\" from the stamp", got)
	}
}

func TestGuiTickProbeTTL(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)

	// Shrink the TTL (the per-hub override field) so the window is provably
	// wider than the tick loop even under full-suite scheduling load: 20
	// ticks at ~10ms sit well inside one 400ms window and must yield exactly
	// one probe.
	hub.guiProbeTTL = 400 * time.Millisecond

	for i := 0; i < 20; i++ {
		hub.guiTick()
		time.Sleep(10 * time.Millisecond)
	}
	if got := stub.count(); got != 1 {
		t.Fatalf("prober calls = %d, want 1 (one per TTL window)", got)
	}

	// Crossing the window re-probes on the next tick.
	time.Sleep(2 * hub.guiProbeTTL)
	hub.guiTick()
	if got := stub.count(); got != 2 {
		t.Fatalf("prober calls after the TTL = %d, want 2", got)
	}

	cached := hub.cachedGui(t)
	if !strings.Contains(cached, `"reachable":true`) || !strings.Contains(cached, `"width":1920`) ||
		!strings.Contains(cached, `"backend":"Xtigervnc"`) || !strings.Contains(cached, `"display":":10"`) {
		t.Fatalf("payload = %s, want reachable 1920x1080 Xtigervnc :10", cached)
	}
}

func TestGuiTickProbeFlipAfterTTL(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)

	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"reachable":true`) {
		t.Fatalf("initial payload = %s, want reachable:true", got)
	}

	// A flip inside the TTL window is still served from the cache.
	stub.set(gui.Info{Reason: "not running"}, nil)
	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"reachable":true`) {
		t.Fatalf("in-TTL payload = %s, want the cached reachable:true", got)
	}

	// Expire the cache: the first post-TTL tick re-probes and flips.
	hub.mu.Lock()
	hub.guiProbeAt = time.Now().Add(-2 * guiProbeTTL)
	hub.mu.Unlock()
	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"reachable":false`) {
		t.Fatalf("post-TTL payload = %s, want reachable:false", got)
	}
	if got := stub.count(); got != 2 {
		t.Fatalf("prober calls = %d, want 2", got)
	}
}

func TestGuiLateJoinerReplay(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	hub.guiTick()

	// A connection attaching after the tick is replayed the cached gui event
	// from replayGlobalSlots — before any further tick runs.
	sc := &stateConn{ch: make(chan hubEvent, 16), subs: map[string]*sseClient{}}
	hub.replayGlobalSlots(sc)
	select {
	case ev := <-sc.ch:
		s := ev.String()
		if !strings.HasPrefix(s, "event: gui") || !strings.Contains(s, `"reachable":true`) {
			t.Fatalf("replayed event = %q, want the cached gui event", s)
		}
	case <-time.After(time.Second):
		t.Fatal("late joiner received no cached gui event")
	}
}

func TestGuiTickViewerSkipsProbe(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)

	hub.guiTick() // baseline probe: 1 call
	hub.guiViewerAdd("host")

	// With a live relay viewer the dial is skipped even past the TTL —
	// reachable follows from the live relay; the last geometry is retained.
	hub.mu.Lock()
	hub.guiProbeAt = time.Now().Add(-2 * guiProbeTTL)
	hub.mu.Unlock()
	hub.guiTick()
	if got := stub.count(); got != 1 {
		t.Fatalf("prober calls = %d with a live viewer, want 1 (dial skipped)", got)
	}
	cached := hub.cachedGui(t)
	if !strings.Contains(cached, `"reachable":true`) || !strings.Contains(cached, `"viewers":1`) ||
		!strings.Contains(cached, `"width":1920`) {
		t.Fatalf("viewer-live payload = %s, want reachable:true, viewers:1, retained geometry", cached)
	}

	// The viewer counter floors at zero.
	hub.guiViewerRemove("host")
	hub.guiViewerRemove("host")
	if got := hub.guiViewerCount("host"); got != 0 {
		t.Fatalf("viewer count = %d, want 0", got)
	}
}

func TestSetGUIEnabledSynchronousBroadcast(t *testing.T) {
	isolateSettings(t) // disabled
	hub := newGuiTestHub()
	sc := &stateConn{ch: make(chan hubEvent, 16), subs: map[string]*sseClient{}}
	hub.mu.Lock()
	hub.stateConns[sc] = true
	hub.mu.Unlock()

	hub.setGUIEnabled(true)

	// The broadcast must already be queued when setGUIEnabled returns — the
	// settings POST flips enabled within one state event, no tick wait.
	select {
	case ev := <-sc.ch:
		s := ev.String()
		if !strings.HasPrefix(s, "event: gui") || !strings.Contains(s, `"enabled":true`) {
			t.Fatalf("broadcast = %q, want event: gui with enabled:true", s)
		}
	default:
		t.Fatal("setGUIEnabled did not broadcast synchronously")
	}
	hub.mu.RLock()
	probeAtZero := hub.guiProbeAt.IsZero()
	hub.mu.RUnlock()
	if !probeAtZero {
		t.Fatal("setGUIEnabled did not zero the probe age")
	}
}

func TestSetGUIEnabledDropsStaleProbeState(t *testing.T) {
	enableGuiSettings(t)
	hub := newGuiTestHub()
	// Seed a previously-reachable probe result, then flip the switch: the
	// flip must not rebroadcast the stale reachable/backend/display until the
	// next tick re-probes.
	hub.mu.Lock()
	hub.guiEnabled = true
	hub.guiInfo = gui.Info{Reachable: true, Width: 1920, Height: 1080}
	hub.guiBackend = "Xtigervnc"
	hub.guiDisplay = ":10"
	hub.guiProbeAt = time.Now()
	hub.mu.Unlock()
	sc := &stateConn{ch: make(chan hubEvent, 16), subs: map[string]*sseClient{}}
	hub.mu.Lock()
	hub.stateConns[sc] = true
	hub.mu.Unlock()

	hub.setGUIEnabled(true)

	select {
	case ev := <-sc.ch:
		s := ev.String()
		for _, stale := range []string{`"reachable":true`, `"backend":"Xtigervnc"`, `"display":":10"`, `"width":1920`} {
			if strings.Contains(s, stale) {
				t.Errorf("broadcast %q carries stale %s after the flip", s, stale)
			}
		}
	default:
		t.Fatal("setGUIEnabled did not broadcast synchronously")
	}
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	if hub.guiInfo != (gui.Info{}) || hub.guiBackend != "" || hub.guiDisplay != "" {
		t.Errorf("stale probe state survived the flip: info=%+v backend=%q display=%q", hub.guiInfo, hub.guiBackend, hub.guiDisplay)
	}
}

func TestGuiTickSessionAbsent(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true}}

	// Two shapes of "not running": no rk-gui session at all, and a stamped
	// display that does not parse.
	for name, opts := range map[string][3]any{
		"absent session":     {"", "", false},
		"unparsable display": {"garbage", "Xtigervnc", true},
	} {
		t.Run(name, func(t *testing.T) {
			hub := newGuiTestHub()
			stubGuiSeams(hub, opts[0].(string), opts[1].(string), opts[2].(bool), stub.probe)
			hub.guiTick()
			if got := stub.count(); got != 0 {
				t.Fatalf("prober calls = %d without a usable session, want 0", got)
			}
			hub.mu.RLock()
			reason := hub.guiInfo.Reason
			hub.mu.RUnlock()
			if reason != "session absent" {
				t.Fatalf("reason = %q, want %q", reason, "session absent")
			}
			if got := hub.cachedGui(t); !strings.Contains(got, `"reachable":false`) {
				t.Fatalf("payload = %s, want reachable:false", got)
			}
		})
	}
}

func TestGuiTickReadsTheLockPin(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	var lockReads int
	hub.guiLockedFn = func(context.Context) bool { lockReads++; return true }

	hub.guiTick()
	if lockReads != 1 {
		t.Fatalf("lock reads = %d, want 1 (read on the probe tick beside the stamps)", lockReads)
	}
	if got := hub.cachedGui(t); !strings.Contains(got, `"locked":true`) {
		t.Fatalf("payload = %s, want \"locked\":true", got)
	}

	// The pin flip surfaces on the next TTL window, like the stamps.
	hub.guiLockedFn = func(context.Context) bool { return false }
	hub.guiProbeAt = time.Time{}
	hub.guiTick()
	if got := hub.cachedGui(t); strings.Contains(got, `"locked":true`) {
		t.Fatalf("payload = %s, want locked:false after the flip", got)
	}
}

func TestGuiPayloadCarriesHumanInputAgo(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	hub.guiLockedFn = func(context.Context) bool { return false }

	hub.guiTick()
	if got := hub.cachedGui(t); strings.Contains(got, "human_input_ago_ms") {
		t.Fatalf("payload = %s, want the field omitted before any input (omitempty)", got)
	}

	hub.guiHumanInputSeen("host")
	hub.guiTick()
	got := hub.cachedGui(t)
	var entries []gui.StreamEntry
	if err := json.Unmarshal([]byte(got), &entries); err != nil {
		t.Fatalf("payload does not decode: %v (%s)", err, got)
	}
	if len(entries) != 1 || entries[0].HumanInputAgoMS < 1 {
		t.Errorf("entry = %+v, want human_input_ago_ms ≥ 1 (the clamp keeps just-now distinct from absent)", entries)
	}
	if _, ok := hub.guiHumanInputAt("host"); !ok {
		t.Error("guiHumanInputAt = not ok after guiHumanInputSeen")
	}
	if _, ok := hub.guiHumanInputAt("nope"); ok {
		t.Error("guiHumanInputAt(nope) = ok, want not ok")
	}
}

// guiTestConn registers a state-socket connection for host-global fan-out so
// a test can count gui broadcasts (the addTestClient shape without starting
// the poll loop).
func guiTestConn(hub *sseHub) *stateConn {
	sc := &stateConn{ch: make(chan hubEvent, 16), subs: map[string]*sseClient{}}
	hub.mu.Lock()
	hub.stateConns[sc] = true
	hub.mu.Unlock()
	return sc
}

// nextGuiFrame returns the next gui broadcast on ch, failing after timeout.
func nextGuiFrame(t *testing.T, ch chan hubEvent, timeout time.Duration) string {
	t.Helper()
	select {
	case ev := <-ch:
		return ev.String()
	case <-time.After(timeout):
		t.Fatal("no gui frame broadcast")
		return ""
	}
}

// TestGuiTickDedupIgnoresHumanInputAge proves the gui dedup key flattens
// human_input_ago_ms to a presence marker: the absent→present transition
// emits one frame carrying the field, but the age moving on later ticks
// re-emits nothing.
func TestGuiTickDedupIgnoresHumanInputAge(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	hub.guiLockedFn = func(context.Context) bool { return false }
	sc := guiTestConn(hub)

	hub.guiTick()
	if got := nextGuiFrame(t, sc.ch, time.Second); !strings.HasPrefix(got, "event: gui") {
		t.Fatalf("first frame = %q, want event: gui", got)
	}

	// Presence transition: absent → present ships one frame carrying the age.
	hub.guiHumanInputSeen("host")
	hub.guiTick()
	got := nextGuiFrame(t, sc.ch, time.Second)
	if !strings.Contains(got, "human_input_ago_ms") {
		t.Fatalf("presence-transition frame = %q, want human_input_ago_ms present", got)
	}

	// The age moves, the marker does not: no re-emission.
	time.Sleep(5 * time.Millisecond)
	hub.guiTick()
	select {
	case ev := <-sc.ch:
		t.Fatalf("tick with only the age moved emitted %q, want suppression", ev.String())
	case <-time.After(150 * time.Millisecond):
	}
}

// TestGuiTickEmitsOnReachableFlip proves the age-flattened key does not
// swallow a real change: a probe flip after the TTL still emits a frame.
func TestGuiTickEmitsOnReachableFlip(t *testing.T) {
	enableGuiSettings(t)
	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1920, Height: 1080}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	hub.guiLockedFn = func(context.Context) bool { return false }
	sc := guiTestConn(hub)

	hub.guiTick()
	if got := nextGuiFrame(t, sc.ch, time.Second); !strings.Contains(got, `"reachable":true`) {
		t.Fatalf("first frame = %q, want reachable:true", got)
	}

	// A flip inside the TTL window is served from the probe cache — unchanged
	// key, no frame.
	stub.set(gui.Info{Reason: "not running"}, nil)
	hub.guiTick()
	select {
	case ev := <-sc.ch:
		t.Fatalf("in-TTL tick emitted %q, want the cached payload (no frame)", ev.String())
	case <-time.After(150 * time.Millisecond):
	}

	// After the TTL the re-probe flips the payload and one frame ships.
	hub.mu.Lock()
	hub.guiProbeAt = time.Now().Add(-2 * guiProbeTTL)
	hub.mu.Unlock()
	hub.guiTick()
	if got := nextGuiFrame(t, sc.ch, time.Second); !strings.Contains(got, `"reachable":false`) {
		t.Fatalf("post-TTL frame = %q, want reachable:false", got)
	}

	// And the flipped payload is then stable — no repetition.
	hub.guiTick()
	select {
	case ev := <-sc.ch:
		t.Fatalf("unchanged post-flip tick emitted %q, want suppression", ev.String())
	case <-time.After(150 * time.Millisecond):
	}
}

// TestGuiTickReloadsSettingsOnlyWhenStampChanges proves the stamp gate: a
// rewrite that preserves the file's fingerprint (same size, same mtime) is
// NOT re-parsed, while a moved mtime re-parses on the next tick.
func TestGuiTickReloadsSettingsOnlyWhenStampChanges(t *testing.T) {
	isolateSettings(t)
	configFile := filepath.Join(os.Getenv("HOME"), ".config", "hexokit", "config.yaml")

	st := settings.Load()
	st.GUIEnabled = true
	st.GUIGeometry = "1600x900"
	if err := settings.Save(st); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	fi, err := os.Stat(configFile)
	if err != nil {
		t.Fatalf("stat settings: %v", err)
	}

	stub := &guiProbeStub{info: gui.Info{Reachable: true, Width: 1600, Height: 900}}
	hub := newGuiTestHub()
	stubGuiSeams(hub, ":10", "Xtigervnc", true, stub.probe)
	hub.guiLockedFn = func(context.Context) bool { return false }

	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":"1600x900"`) {
		t.Fatalf("payload = %s, want geometry 1600x900", got)
	}

	// Same-size rewrite + restored mtime ⇒ identical stamp ⇒ no reload, so
	// the payload keeps the cached geometry. (The two geometry values
	// serialize to the same length.)
	st.GUIGeometry = "1280x720"
	if err := settings.Save(st); err != nil {
		t.Fatalf("re-save settings: %v", err)
	}
	if err := os.Chtimes(configFile, fi.ModTime(), fi.ModTime()); err != nil {
		t.Fatalf("restore mtime: %v", err)
	}
	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":"1600x900"`) {
		t.Fatalf("payload = %s after a fingerprint-preserving rewrite, want the cached 1600x900 (no reload)", got)
	}

	// A moved mtime changes the stamp: the next tick reloads and the new
	// geometry ships.
	fresh := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(configFile, fresh, fresh); err != nil {
		t.Fatalf("bump mtime: %v", err)
	}
	hub.guiTick()
	if got := hub.cachedGui(t); !strings.Contains(got, `"geometry":"1280x720"`) {
		t.Fatalf("payload = %s after the stamp moved, want the reloaded 1280x720", got)
	}
}
