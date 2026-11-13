package cron

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/tmux"
)

func loopEntry(created time.Time) Entry {
	return Entry{
		ID:        "lp01",
		Name:      LoopSeedName,
		Run:       RunOperatorLoop,
		Schedule:  Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{24 * time.Minute}},
		WakeOn:    &WakeOn{Event: WakeAgentStateChange, Scope: WakeScopeServer, Debounce: Duration{60 * time.Second}},
		Pinned:    true,
		CreatedBy: CreatedBy{At: created.Unix()},
	}
}

func loopLine(entry string, at time.Time, outcome string) LogLine {
	return LogLine{TS: at.Unix(), Entry: entry, Reason: "schedule", Outcome: outcome}
}

func TestDurationShort(t *testing.T) {
	cases := map[time.Duration]string{
		0:                              "0s",
		45 * time.Second:               "45s",
		2*time.Minute + 13*time.Second: "2m13s",
		time.Hour:                      "1h",
		90 * time.Minute:               "1h30m",
		1500 * time.Millisecond:        "1.5s",
		time.Hour + 5*time.Minute + 3*time.Second: "1h5m3s",
	}
	for d, want := range cases {
		if got := DurationShort(d); got != want {
			t.Errorf("DurationShort(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestLoopOutcomeStrings(t *testing.T) {
	if got := OutcomeSkippedBusy("20261112T101500-ab12"); got != "skipped-busy: run 20261112T101500-ab12" {
		t.Errorf("skipped-busy = %q", got)
	}
	if got := OutcomeRan("nudged pr-41, noted", 133*time.Second); got != "ran · nudged pr-41, noted · 2m13s" {
		t.Errorf("ran = %q", got)
	}
	if got := OutcomeRunFailed(1, 45*time.Second); got != "run-failed: exit 1 · 45s" {
		t.Errorf("run-failed = %q", got)
	}
	if got := OutcomeRunFailedNoOutcome(5 * time.Second); got != "run-failed: no outcome line · 5s" {
		t.Errorf("run-failed no outcome = %q", got)
	}
	if got := OutcomeRunLost("window gone"); got != "run-lost: window gone" {
		t.Errorf("run-lost = %q", got)
	}
	if got := OutcomeCheckFailed("tmux dead"); got != "check-failed: tmux dead" {
		t.Errorf("check-failed = %q", got)
	}
	long := strings.Repeat("é", 300)
	got := OutcomeRan(long, time.Second)
	if n := len([]rune(strings.TrimSuffix(strings.TrimPrefix(got, "ran · "), " · 1s"))); n != 200 {
		t.Errorf("outcome runes = %d, want capped at 200", n)
	}
}

func TestLoopOutcomeRateAndOrphanClasses(t *testing.T) {
	counts := []string{
		OutcomeRan("x", time.Second),
		OutcomeRunFailed(2, time.Second),
		OutcomeRunFailedNoOutcome(time.Second),
		OutcomeRunLost("window gone"),
		OutcomeCheckFailed("boom"),
	}
	for _, o := range counts {
		if !countsTowardRate(o) {
			t.Errorf("%q must count toward the rate cap", o)
		}
		if resolvedOutcome(o) {
			t.Errorf("%q must be neutral to orphan GC", o)
		}
	}
	for _, o := range []string{OutcomeNoChange, OutcomeSkippedBusy("r")} {
		if countsTowardRate(o) {
			t.Errorf("%q must not count toward the rate cap", o)
		}
		if resolvedOutcome(o) {
			t.Errorf("%q must be neutral to orphan GC", o)
		}
	}
}

// TestLoopLadderClimbsAndResets: a `ran` line at T then `no change` at T+3m
// and T+9m puts the next fire at T+21m (the newest line plus the rung-2 gap);
// any non-`no change` line resets the count.
func TestLoopLadderClimbsAndResets(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	min, max := e.Schedule.Min.Duration, e.Schedule.Max.Duration
	log := []LogLine{
		loopLine("zzzz", T.Add(time.Minute), "delivered"), // another entry's line never counts
		loopLine(e.ID, T, OutcomeRan("did it", time.Minute)),
		loopLine(e.ID, T.Add(3*time.Minute), OutcomeNoChange),
		loopLine(e.ID, T.Add(9*time.Minute), OutcomeNoChange),
	}
	l := LoopLadder(e, log)
	if !l.Anchor.Equal(T.Add(9*time.Minute)) || l.Rung != 2 {
		t.Fatalf("ladder = %+v, want anchor T+9m rung 2", l)
	}
	if want := T.Add(21 * time.Minute); !l.NextFire(min, max).Equal(want) {
		t.Errorf("next fire = %v, want %v", l.NextFire(min, max), want)
	}
	if l.Due(T.Add(20*time.Minute), min, max) || !l.Due(T.Add(21*time.Minute), min, max) {
		t.Error("due boundary wrong around T+21m")
	}

	// Past the cap the gap stays at max after the newest line.
	for i := 3; i < 8; i++ {
		log = append(log, loopLine(e.ID, T.Add(time.Duration(i)*time.Hour), OutcomeNoChange))
	}
	capped := LoopLadder(e, log)
	if got := capped.NextFire(min, max).Sub(capped.Anchor); got != max {
		t.Errorf("capped gap after the newest line = %v, want %v", got, max)
	}

	// Any other line resets, including skipped-busy and rescheduled.
	for _, outcome := range []string{OutcomeSkippedBusy("r"), "rescheduled", OutcomeCheckFailed("x"), OutcomeRunLost("y")} {
		reset := LoopLadder(e, append(append([]LogLine{}, log...), loopLine(e.ID, T.Add(10*time.Hour), outcome)))
		if reset.Rung != 0 || !reset.Anchor.Equal(T.Add(10*time.Hour)) {
			t.Errorf("after %q ladder = %+v, want rung 0 at the line", outcome, reset)
		}
	}
}

// TestLoopLadderOffScheduleLinesStayWithinMax: wake-fired `no change` lines
// land far apart from the ladder's own gaps, yet the next check is never more
// than max after the newest line.
func TestLoopLadderOffScheduleLinesStayWithinMax(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	min, max := e.Schedule.Min.Duration, e.Schedule.Max.Duration
	log := []LogLine{loopLine(e.ID, T, OutcomeRan("did it", time.Minute))}
	var last time.Time
	for i := 1; i <= 10; i++ {
		last = T.Add(time.Duration(i) * 70 * time.Second)
		log = append(log, LogLine{TS: last.Unix(), Entry: e.ID, Reason: "wake", Outcome: OutcomeNoChange})
	}
	l := LoopLadder(e, log)
	if l.Rung != 10 {
		t.Fatalf("rung = %d, want 10", l.Rung)
	}
	if want := last.Add(max); !l.NextFire(min, max).Equal(want) {
		t.Errorf("next fire = %v, want last line + %v = %v", l.NextFire(min, max), max, want)
	}
}

func TestLoopLadderFallsBackToCreatedAt(t *testing.T) {
	T := backoffBase
	e := loopEntry(T)
	min, max := e.Schedule.Min.Duration, e.Schedule.Max.Duration
	l := LoopLadder(e, nil)
	if !l.Anchor.Equal(T) || l.Rung != 0 || !l.NextFire(min, max).Equal(T.Add(min)) {
		t.Fatalf("ladder = %+v, want created_by.at + min", l)
	}
	l = LoopLadder(e, []LogLine{loopLine(e.ID, T.Add(3*time.Minute), OutcomeNoChange)})
	if !l.Anchor.Equal(T.Add(3*time.Minute)) || l.Rung != 1 {
		t.Fatalf("ladder with one no-change = %+v, want anchor at the line, rung 1", l)
	}
}

func TestEvaluateLoopEntryFiresWithoutTarget(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	res := Evaluate(EvalInput{Server: "dev", Now: T, Entries: []Entry{e},
		// A stray unresolved fact for the id must never route it to Absent.
		Facts: map[string]TargetFacts{e.ID: {Unresolved: "no window"}}})
	if len(res.Fires) != 1 || len(res.Absent) != 0 {
		t.Fatalf("fires=%d absent=%d, want 1/0", len(res.Fires), len(res.Absent))
	}
	f := res.Fires[0]
	if f.PaneID != "" || f.Reason != FireSchedule || f.Rung != 1 {
		t.Errorf("fire = %+v", f)
	}
	if want := e.CreatedBy.At + 180; f.DueAt.Unix() != want {
		t.Errorf("DueAt = %v, want created_by.at+3m", f.DueAt)
	}
}

func TestEvaluateLoopEntryMutedSuppressed(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	e.Muted = true
	res := Evaluate(EvalInput{Server: "dev", Now: T, Entries: []Entry{e}})
	if len(res.Fires) != 0 || len(res.Absent) != 0 {
		t.Fatalf("muted loop entry fired: %+v", res)
	}
}

func TestEvaluateLoopNotDueUntilLadderElapses(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	log := []LogLine{
		loopLine(e.ID, T, OutcomeRan("x", time.Second)),
		loopLine(e.ID, T.Add(3*time.Minute), OutcomeNoChange),
		loopLine(e.ID, T.Add(9*time.Minute), OutcomeNoChange),
	}
	if res := Evaluate(EvalInput{Server: "dev", Now: T.Add(20 * time.Minute), Entries: []Entry{e}, Log: log}); len(res.Fires) != 0 {
		t.Fatal("fired at T+20m, want not due")
	}
	if res := Evaluate(EvalInput{Server: "dev", Now: T.Add(21 * time.Minute), Entries: []Entry{e}, Log: log}); len(res.Fires) != 1 {
		t.Fatal("not due at T+21m")
	}
}

func TestDeriveLoopEntry(t *testing.T) {
	T := backoffBase
	e := loopEntry(T)
	d := DeriveEntry(e, []LogLine{loopLine(e.ID, T.Add(3*time.Minute), OutcomeNoChange)}, TargetFacts{}, T)
	if d.Orphaned || !d.HasNextFire || d.Rung != 2 || !d.NextFire.Equal(T.Add(9*time.Minute)) {
		t.Errorf("derived = %+v", d)
	}
}

// TestEvaluateLoopWakeExcludesRunPanes: a run window's pane flipping does not
// wake the loop, while an unrelated pane going to waiting does.
func TestEvaluateLoopWakeExcludesRunPanes(t *testing.T) {
	T := backoffBase
	e := loopEntry(T.Add(-time.Hour))
	// Keep the schedule not due so only the wake edge can fire.
	e.Schedule.Min = Duration{24 * time.Hour}
	e.Schedule.Max = Duration{24 * time.Hour}
	runPanes := map[string]bool{"%9": true}

	cursor := WakeCursor{}
	step := func(now time.Time, states map[string]string) EvalResult {
		res := Evaluate(EvalInput{Server: "dev", Now: now, Entries: []Entry{e}, States: states,
			RunPanes: runPanes, Cursor: cursor})
		cursor = res.NextCursor
		return res
	}
	now := T
	step(now, map[string]string{"%1": "active", "%9": "active"}) // cold start
	now = now.Add(2 * time.Minute)
	if res := step(now, map[string]string{"%1": "active", "%9": "idle"}); len(res.Fires) != 0 {
		t.Fatalf("run pane going idle woke the loop: %+v", res.Fires)
	}
	now = now.Add(2 * time.Minute)
	if res := step(now, map[string]string{"%1": "active"}); len(res.Fires) != 0 {
		t.Fatalf("run pane vanishing woke the loop: %+v", res.Fires)
	}
	now = now.Add(2 * time.Minute)
	res := step(now, map[string]string{"%1": "waiting"})
	if len(res.Fires) != 1 || res.Fires[0].Reason != FireWake || res.Fires[0].PaneID != "" {
		t.Fatalf("unrelated pane waiting did not wake the loop: %+v", res.Fires)
	}
}

// TestGatherFactsRoleOnlyRunWindowIsNotInFlight: a window carrying the
// operator-run role that the run-window listing does not return (no run id, or
// every pane dead) never sets RunInFlight, so it cannot suppress the loop.
func TestGatherFactsRoleOnlyRunWindowIsNotInFlight(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: tmux.OperatorSessionName}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		tmux.OperatorSessionName: {{WindowID: "@1", Role: tmux.RoleOperatorRun, Panes: []tmux.PaneInfo{{PaneID: "%9"}}}},
	}
	facts := GatherFacts(context.Background(), "dev", []Entry{loopEntry(backoffBase)}, fk)
	if facts.RunInFlight || len(facts.RunPanes) != 0 {
		t.Errorf("RunInFlight = %v, RunPanes = %v, want neither", facts.RunInFlight, facts.RunPanes)
	}
}

// TestGatherFactsSkipsRunWindowsWithoutLoopEntry: only the loop entry reads
// the run-window facts, so a server without one costs no extra tmux call.
func TestGatherFactsSkipsRunWindowsWithoutLoopEntry(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	GatherFacts(context.Background(), "dev", nil, fk)
	for _, c := range fk.calls {
		if strings.HasPrefix(c, "ListRunWindows") {
			t.Errorf("unexpected call %q", c)
		}
	}
}

func TestGatherFactsRunPanesAndLoopSkipped(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: tmux.OperatorSessionName}, {Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		tmux.OperatorSessionName: {{WindowID: "@1", Role: tmux.RoleOperatorRun, Panes: []tmux.PaneInfo{{PaneID: "%9", AgentState: tmux.AgentStateActive}}}},
		"work":                   {{WindowID: "@2", Panes: []tmux.PaneInfo{{PaneID: "%1", AgentState: tmux.AgentStateIdle}}}},
	}
	fk.runWins["dev"] = []tmux.RunWindow{{WindowID: "@1", Session: tmux.OperatorSessionName, RunID: "20261112T101500-ab12", PaneIDs: []string{"%9"}}}
	loop := loopEntry(backoffBase)
	facts := GatherFacts(context.Background(), "dev", []Entry{loop}, fk)
	if !facts.RunInFlight {
		t.Error("RunInFlight must be set while an operator-run window exists")
	}
	if !facts.RunPanes["%9"] || facts.RunPanes["%1"] || len(facts.RunPanes) != 1 {
		t.Errorf("RunPanes = %v, want only %%9", facts.RunPanes)
	}
	if _, ok := facts.Targets[loop.ID]; ok {
		t.Error("loop entry must not be target-resolved")
	}
	if hasDiag(facts.Diags, "target-unresolved") {
		t.Errorf("diags = %v", diagReasons(facts.Diags))
	}
	for _, c := range fk.calls {
		if strings.HasPrefix(c, "PaneFacts") || strings.HasPrefix(c, "ResolveAgentPane") || strings.HasPrefix(c, "PaneExists") {
			t.Errorf("unexpected target-resolution call %q", c)
		}
	}
}

// loopTickRig writes a cron file holding one overdue loop entry and returns
// the tick helper for live server "dev".
func loopTickRig(t *testing.T, T time.Time) (dir string, entry Entry, tick func(Deps) TickResult) {
	t.Helper()
	dir = t.TempDir()
	loop := loopEntry(T.Add(-time.Hour))
	loop.WakeOn = nil
	added, err := Add(dir, "dev", loop)
	if err != nil {
		t.Fatal(err)
	}
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{"work": {{WindowID: "@5"}}}
	tick = func(d Deps) TickResult {
		t.Helper()
		d.Dir = dir
		d.Now = func() time.Time { return T }
		d.ListServers = func(ctx context.Context) ([]string, error) { return []string{"dev"}, nil }
		d.Tmux = fk
		res, err := Tick(context.Background(), d)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	return dir, added, tick
}

func readDevLog(t *testing.T, dir string) []LogLine {
	t.Helper()
	p, err := LogPath(dir, "dev")
	if err != nil {
		t.Fatal(err)
	}
	return ReadLog(p)
}

func TestTickLoopNilSeamLogsNoDeliverer(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	del := &fakeDeliverer{}
	tick(Deps{Deliverer: del})
	log := readDevLog(t, dir)
	if len(log) != 1 || log[0].Entry != entry.ID || log[0].Outcome != "no-deliverer" {
		t.Fatalf("log = %+v", log)
	}
	if len(del.fires) != 0 {
		t.Error("a loop fire must never reach the Deliverer")
	}
}

func TestTickLoopRoutesToRunner(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	var got []Fire
	del := &fakeDeliverer{}
	tick(Deps{Deliverer: del, LoopRunner: func(ctx context.Context, f Fire) Outcome {
		got = append(got, f)
		return Outcome{Status: OutcomeNoChange}
	}})
	if len(got) != 1 || got[0].Entry.ID != entry.ID || got[0].Server != "dev" || len(del.fires) != 0 {
		t.Fatalf("runner fires = %+v deliverer fires = %d", got, len(del.fires))
	}
	log := readDevLog(t, dir)
	if len(log) != 1 || log[0].Outcome != OutcomeNoChange || log[0].Target != "" {
		t.Fatalf("log = %+v", log)
	}
}

func TestTickLoopHeldOutcomeUnlogged(t *testing.T) {
	T := backoffBase
	dir, _, tick := loopTickRig(t, T)
	res := tick(Deps{LoopRunner: func(ctx context.Context, f Fire) Outcome {
		return Outcome{Status: "launched", Held: true}
	}})
	if log := readDevLog(t, dir); len(log) != 0 {
		t.Fatalf("held loop outcome was logged: %+v", log)
	}
	if !hasDiag(res.Diags, "delivery-held") {
		t.Errorf("diags = %v", diagReasons(res.Diags))
	}
}

func TestTickLoopRateCapKeysOnEntry(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	logPath, _ := LogPath(dir, "dev")
	// Thirty counted outcomes within the hour, all older than the ladder
	// anchor so the entry is still due: ran lines are older than `no change`.
	seedLog(t, logPath, DefaultTargetRatePerHour, entry.ID, "", OutcomeRan("x", time.Second), T.Add(-30*time.Minute).Unix())
	called := false
	tick(Deps{LoopRunner: func(ctx context.Context, f Fire) Outcome { called = true; return Outcome{Status: OutcomeNoChange} }})
	if called {
		t.Fatal("runner called past the entry-keyed rate cap")
	}
	log := readDevLog(t, dir)
	if last := log[len(log)-1]; last.Outcome != "rate-capped" || last.Entry != entry.ID {
		t.Fatalf("last line = %+v", last)
	}
}

func TestTickLoopTranscribesThroughSingleWriter(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	var marked []string
	transcribe := func(ctx context.Context, server string) []LogLine {
		if server != "dev" {
			t.Errorf("server = %q", server)
		}
		return []LogLine{{Entry: entry.ID, Reason: "schedule", Outcome: OutcomeRan("stub acted", 20*time.Second), Run: "20261112T101500-ab12"}}
	}
	deps := Deps{
		LoopTranscribe: transcribe,
		LoopLogged:     func(ctx context.Context, server, id string) { marked = append(marked, server+"/"+id) },
		LoopRunner:     func(ctx context.Context, f Fire) Outcome { return Outcome{Status: "launched", Held: true} },
	}
	tick(deps)
	log := readDevLog(t, dir)
	if len(log) != 1 || log[0].Run != "20261112T101500-ab12" || log[0].TS != T.Unix() ||
		log[0].Outcome != "ran · stub acted · 20s" {
		t.Fatalf("log = %+v", log)
	}
	if len(marked) != 1 || marked[0] != "dev/20261112T101500-ab12" {
		t.Fatalf("marked = %v", marked)
	}

	// A crash between append and mark: the same run id comes back, the line
	// is not duplicated, and the record is marked.
	marked = nil
	tick(deps)
	if log = readDevLog(t, dir); len(log) != 1 {
		t.Fatalf("re-transcription duplicated the line: %+v", log)
	}
	if len(marked) != 1 {
		t.Fatalf("marked = %v, want the record marked again", marked)
	}
}

func TestTickLoopTranscribeNilSeams(t *testing.T) {
	T := backoffBase
	dir, _, tick := loopTickRig(t, T)
	tick(Deps{LoopRunner: func(ctx context.Context, f Fire) Outcome { return Outcome{Status: "launched", Held: true} },
		LoopTranscribe: func(ctx context.Context, s string) []LogLine {
			return []LogLine{{Entry: "lp01", Outcome: OutcomeRunLost("window gone"), Run: "r1"}}
		}})
	if log := readDevLog(t, dir); len(log) != 1 || log[0].Outcome != "run-lost: window gone" {
		t.Fatalf("log = %+v (nil LoopLogged must not break transcription)", log)
	}
}

func TestTickLoopEntryNeverOrphanExpired(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	// An unpinned loop entry created long before the orphan TTL.
	if ok, err := SetPinned(dir, "dev", entry.ID, false); err != nil || !ok {
		t.Fatal(err)
	}
	path, _ := EntriesPath(dir, "dev")
	entries, _ := LoadEntries(path)
	entries[0].CreatedBy.At = T.Add(-30 * 24 * time.Hour).Unix()
	if err := saveEntries(path, entries); err != nil {
		t.Fatal(err)
	}
	tick(Deps{})
	if got, _ := LoadEntries(path); len(got) != 1 {
		t.Fatalf("loop entry expired as orphan: %+v", got)
	}
}

// --- seeding ---

const legacyTickYAML = `
entries:
  - id: a3f9
    name: operator tick
    schedule: { kind: backoff, min: 3m, max: 24m }
    target: { kind: role, role: operator }
    payload: "operator tick"
    deliver: skip-if-busy
    if_absent: respawn
    respawn: ["rk", "operator", "-L", "{server}"]
    pinned: true
    created_by: { at: 1788254000 }
  - id: k7q2
    name: hourly
    schedule: { kind: every, interval: 1h }
    target: { kind: role, role: operator }
    payload: "something else"
    created_by: { at: 1788254000 }
`

func seedTick(t *testing.T, dir string, T time.Time, exists func(string) bool) {
	t.Helper()
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{"work": {{WindowID: "@5"}}}
	_, err := Tick(context.Background(), Deps{
		Dir: dir, Now: func() time.Time { return T }, Tmux: fk,
		ListServers: func(ctx context.Context) ([]string, error) { return []string{"dev"}, nil },
		LoopSeed:    func(ctx context.Context, s string) bool { return exists(s) },
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSeedNoRkFileLeavesCronFileUntouched(t *testing.T) {
	dir := t.TempDir()
	writeEntryFile(t, dir, "dev", legacyTickYAML)
	path := filepath.Join(dir, "dev.yaml")
	before, _ := os.ReadFile(path)
	seedTick(t, dir, backoffBase, func(string) bool { return false })
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("cron file changed without rk's state file:\n%s", after)
	}
}

func TestSeedWhenRkFileExists(t *testing.T) {
	dir := t.TempDir()
	T := backoffBase
	writeEntryFile(t, dir, "dev", legacyTickYAML)
	exists := true
	seedTick(t, dir, T, func(string) bool { return exists })

	path := filepath.Join(dir, "dev.yaml")
	entries, diags := LoadEntries(path)
	if len(diags) != 0 || len(entries) != 3 {
		t.Fatalf("entries=%d diags=%v", len(entries), diags)
	}
	byID := map[string]Entry{}
	var loop Entry
	for _, e := range entries {
		byID[e.ID] = e
		if e.IsLoop() {
			loop = e
		}
	}
	if !loop.IsLoop() || loop.Name != LoopSeedName || !loop.Pinned || loop.Muted ||
		loop.Schedule.Kind != ScheduleBackoff || loop.Schedule.Min.Duration != 3*time.Minute || loop.Schedule.Max.Duration != 24*time.Minute ||
		loop.WakeOn == nil || loop.WakeOn.Event != WakeAgentStateChange || loop.WakeOn.Scope != WakeScopeServer || loop.WakeOn.Debounce.Duration != 60*time.Second ||
		loop.CreatedBy.At != T.Unix() {
		t.Fatalf("seeded entry = %+v", loop)
	}
	if !byID["a3f9"].Muted {
		t.Error("legacy operator tick must be muted")
	}
	if byID["k7q2"].Muted {
		t.Error("an unrelated role:operator entry must not be muted")
	}
	if got := byID["a3f9"]; len(got.Respawn) != 4 || got.Payload != "operator tick" {
		t.Errorf("legacy entry fields were rewritten: %+v", got)
	}

	// The user rolls back: mute the loop, unmute the legacy entry. Later
	// ticks must change nothing.
	if _, err := SetMuted(dir, "dev", loop.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := SetMuted(dir, "dev", "a3f9", false); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	seedTick(t, dir, T.Add(time.Hour), func(string) bool { return exists })
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("a rolled-back file was rewritten:\n%s", after)
	}
}

func TestSeedAdoptedServerWithoutCronFile(t *testing.T) {
	dir := t.TempDir()
	seedTick(t, dir, backoffBase, func(string) bool { return true })
	path := filepath.Join(dir, "dev.yaml")
	entries, _ := LoadEntries(path)
	if len(entries) != 1 || !entries[0].IsLoop() {
		t.Fatalf("entries = %+v, want the seeded loop entry", entries)
	}
}

func TestSeedCorruptFileNeverWritten(t *testing.T) {
	dir := t.TempDir()
	writeEntryFile(t, dir, "dev", "entries: [unterminated\n  - {")
	path := filepath.Join(dir, "dev.yaml")
	before, _ := os.ReadFile(path)
	seedTick(t, dir, backoffBase, func(string) bool { return true })
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("seeding wrote over a corrupt cron file")
	}
}

// TestTickLoopFailedAppendLeavesRunUnmarked: a run's line that could not be
// written must not be marked logged, or its Cron Log row is lost for good.
func TestTickLoopFailedAppendLeavesRunUnmarked(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	logPath, _ := LogPath(dir, "dev")
	if err := os.Mkdir(logPath, 0o700); err != nil { // an unwritable log: the path is a directory
		t.Fatal(err)
	}
	var marked []string
	res := tick(Deps{
		LoopTranscribe: func(context.Context, string) []LogLine {
			return []LogLine{{Entry: entry.ID, Reason: "schedule", Outcome: OutcomeRan("x", time.Second), Run: "r1"}}
		},
		LoopLogged: func(_ context.Context, _, id string) { marked = append(marked, id) },
	})
	if len(marked) != 0 {
		t.Fatalf("a run whose line is not on disk was marked logged: %v", marked)
	}
	if !hasDiag(res.Diags, "log-append-failed") {
		t.Errorf("diags = %v", diagReasons(res.Diags))
	}
}

// TestTickLoopTranscribesBeforeEvaluating: the tick that transcribes a
// finished run re-anchors the loop's ladder on that line, so the (Held, hence
// never-logged) overdue entry does not fire again in the same tick.
func TestTickLoopTranscribesBeforeEvaluating(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	ran := false
	tick(Deps{
		LoopTranscribe: func(context.Context, string) []LogLine {
			return []LogLine{{Entry: entry.ID, Reason: "schedule", Outcome: OutcomeRunFailed(1, 4*time.Second), Run: "r1"}}
		},
		LoopRunner: func(context.Context, Fire) Outcome { ran = true; return Outcome{Status: OutcomeNoChange} },
	})
	if ran {
		t.Fatal("the entry fired in the same tick that transcribed its run")
	}
	if log := readDevLog(t, dir); len(log) != 1 || log[0].Run != "r1" {
		t.Fatalf("log = %+v, want only the transcribed line", log)
	}
}

// TestTickLoopSuppressedWhileRunInFlight: a live operator-run window keeps the
// loop entry from firing at all, so a launch adds no extra row next tick.
func TestTickLoopSuppressedWhileRunInFlight(t *testing.T) {
	T := backoffBase
	dir, _, _ := loopTickRig(t, T)
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: tmux.OperatorSessionName}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		tmux.OperatorSessionName: {{WindowID: "@1", Role: tmux.RoleOperatorRun}},
	}
	fk.runWins["dev"] = []tmux.RunWindow{{WindowID: "@1", Session: tmux.OperatorSessionName, RunID: "20261112T101500-ab12", PaneIDs: []string{"%9"}}}
	called := false
	res, err := Tick(context.Background(), Deps{
		Dir: dir, Now: func() time.Time { return T }, Tmux: fk,
		ListServers: func(context.Context) ([]string, error) { return []string{"dev"}, nil },
		LoopRunner:  func(context.Context, Fire) Outcome { called = true; return Outcome{Status: OutcomeNoChange} },
	})
	if err != nil {
		t.Fatal(err)
	}
	if called || len(readDevLog(t, dir)) != 0 {
		t.Fatalf("loop fired with a run in flight (called=%v, log=%+v)", called, readDevLog(t, dir))
	}
	if !hasDiag(res.Diags, "run-in-flight") {
		t.Errorf("diags = %v", diagReasons(res.Diags))
	}
}

// TestTickLoopCatchUpAfterDowntimeFiresOnce: a daemon that was down past
// several due times fires the loop once on its first tick; the line that
// fire writes pushes the next check a full gap out, so the following tick
// does not fire again.
func TestTickLoopCatchUpAfterDowntimeFiresOnce(t *testing.T) {
	T := backoffBase
	dir, entry, tick := loopTickRig(t, T)
	logPath, _ := LogPath(dir, "dev")
	seedLog(t, logPath, 1, entry.ID, "", OutcomeNoChange, T.Add(-6*time.Hour).Unix())
	fires := 0
	runner := func(context.Context, Fire) Outcome { fires++; return Outcome{Status: OutcomeNoChange} }
	for i := 0; i < 3; i++ {
		tick(Deps{LoopRunner: runner})
	}
	if fires != 1 {
		t.Fatalf("loop fired %d times across 3 ticks after downtime, want 1", fires)
	}
}
