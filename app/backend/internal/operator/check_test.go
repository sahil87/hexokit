package operator

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- shared scaffolding --------------------------------------------------------

const (
	checkTestSocket = "/tmp/tmux-1000/chk"
	checkTestServer = "chk"
	checkAdded      = "2026-11-11T11:00:00Z"
)

// checkEnv stubs every seam Check reaches (clock, state home, tmux snapshot,
// process walk, probes, gh, git) so no test touches a live server or process.
type checkEnv struct {
	t    *testing.T
	path string
	now  time.Time

	panes         map[string]paneRow
	snapshotCalls int32
	snapshotErr   error

	alive      bool
	aliveCalls int32

	probeFn    func(argv []string) (string, error)
	probeCalls int32

	ghOK bool

	branch      string
	branchCalls int32
}

func newCheckEnv(t *testing.T) *checkEnv {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	e := &checkEnv{
		t:     t,
		now:   time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC),
		panes: map[string]paneRow{},
		alive: true,
		ghOK:  true,
		probeFn: func([]string) (string, error) {
			return "", errors.New("unstubbed probe")
		},
	}
	prev := struct {
		clock    func() time.Time
		sock     func(context.Context, string) (string, error)
		snapshot func(context.Context, string) (map[string]paneRow, error)
		alive    func(context.Context, int, int) bool
		probe    func(context.Context, []string) (string, error)
		gh       func(context.Context) bool
		git      func(context.Context, string) (string, error)
	}{clock, socketPathFn, paneSnapshotFn, agentAliveFn, probeRunnerFn, ghAvailableFn, gitBranchFn}
	t.Cleanup(func() {
		clock, socketPathFn, paneSnapshotFn, agentAliveFn = prev.clock, prev.sock, prev.snapshot, prev.alive
		probeRunnerFn, ghAvailableFn, gitBranchFn = prev.probe, prev.gh, prev.git
	})
	clock = func() time.Time { return e.now }
	socketPathFn = func(context.Context, string) (string, error) { return checkTestSocket, nil }
	paneSnapshotFn = func(context.Context, string) (map[string]paneRow, error) {
		atomic.AddInt32(&e.snapshotCalls, 1)
		if e.snapshotErr != nil {
			return nil, e.snapshotErr
		}
		out := make(map[string]paneRow, len(e.panes))
		for k, v := range e.panes {
			out[k] = v
		}
		return out, nil
	}
	agentAliveFn = func(context.Context, int, int) bool {
		atomic.AddInt32(&e.aliveCalls, 1)
		return e.alive
	}
	probeRunnerFn = func(_ context.Context, argv []string) (string, error) {
		atomic.AddInt32(&e.probeCalls, 1)
		return e.probeFn(argv)
	}
	ghAvailableFn = func(context.Context) bool { return e.ghOK }
	gitBranchFn = func(context.Context, string) (string, error) {
		atomic.AddInt32(&e.branchCalls, 1)
		return e.branch, nil
	}
	path, err := StatePathForServer(context.Background(), checkTestServer)
	if err != nil {
		t.Fatal(err)
	}
	e.path = path
	return e
}

func (e *checkEnv) seed(items ...TrackedItem) {
	e.t.Helper()
	if err := Mutate(e.path, func(st *State) error {
		st.Tracked = append(st.Tracked, items...)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *checkEnv) run() CheckResult {
	e.t.Helper()
	res, err := Check(context.Background(), checkTestServer, CheckOptions{})
	if err != nil {
		e.t.Fatalf("Check: %v", err)
	}
	return res
}

func (e *checkEnv) advance(d time.Duration) { e.now = e.now.Add(d) }

func (e *checkEnv) item(id string) TrackedItem { return item(e.t, e.path, id) }

func (e *checkEnv) probeJSON(out string) {
	e.probeFn = func([]string) (string, error) { return out, nil }
}

func baseItem(id, kind, mode string) TrackedItem {
	return TrackedItem{
		ID: id, Kind: kind, Probe: ProbeSpec{Mode: mode},
		DependsOn: []string{}, Scope: map[string]interface{}{}, Last: map[string]interface{}{},
		AddedAt: checkAdded, UpdatedAt: checkAdded,
	}
}

func paneItem(id string, scope map[string]interface{}) TrackedItem {
	it := baseItem(id, KindPane, probePane)
	it.Scope = paneScope()
	for k, v := range scope {
		it.Scope[k] = v
	}
	return it
}

func shellItem(id string, fields ...string) TrackedItem {
	it := baseItem(id, KindShell, probeShell)
	it.Probe.Argv = []string{"probe", id}
	it.Probe.Fields = fields
	ce := "5m"
	it.CheckEvery = &ce
	return it
}

func ghItem(id string) TrackedItem {
	it := shellItem(id, "state")
	it.Kind = KindGitHubPR
	dw := `state == "MERGED"`
	it.DoneWhen = &dw
	return it
}

func agentItem(id string, checkedAt string) TrackedItem {
	it := baseItem(id, KindLinear, probeAgent)
	it.Probe.Instruction = "check the inbox"
	ce := "5m"
	it.CheckEvery = &ce
	if checkedAt != "" {
		it.CheckedAt = &checkedAt
	}
	return it
}

func kindsOf(ds []CheckDelta) []string {
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.ID+":"+d.Kind)
	}
	return out
}

func wantKinds(t *testing.T, label string, ds []CheckDelta, want ...string) {
	t.Helper()
	got := kindsOf(ds)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

func findDelta(t *testing.T, ds []CheckDelta, kind string) CheckDelta {
	t.Helper()
	for _, d := range ds {
		if d.Kind == kind {
			return d
		}
	}
	t.Fatalf("no %s delta in %v", kind, kindsOf(ds))
	return CheckDelta{}
}

// --- engine: result shape, last_check_at, empty list ---------------------------

func TestCheck_EmptyListIsANoOpThatStillWritesLastCheckAt(t *testing.T) {
	e := newCheckEnv(t)
	res := e.run()
	if res.Changed || len(res.Changes) != 0 || len(res.Open) != 0 || len(res.Notices) != 0 {
		t.Errorf("res = %+v, want an empty no-change result", res)
	}
	if e.snapshotCalls != 0 || e.probeCalls != 0 {
		t.Errorf("snapshot calls %d, probe calls %d, want none", e.snapshotCalls, e.probeCalls)
	}
	if got := mustLoad(t, e.path).LastCheckAt; got != "2026-11-11T12:00:00Z" {
		t.Errorf("last_check_at = %q", got)
	}
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"checked_at":"2026-11-11T12:00:00Z","changed":false,"changes":[],"open":[],"notices":[]}`
	if string(b) != want {
		t.Errorf("json = %s\nwant   %s", b, want)
	}
}

func TestCheck_WritesLastCheckAtEveryTimeAndKeepsUnknownKeys(t *testing.T) {
	e := newCheckEnv(t)
	if err := os.MkdirAll(filepath.Dir(e.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.path, []byte("operator_hint: keep me\ntracked: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.run()
	e.advance(time.Minute)
	res := e.run()
	if res.CheckedAt != "2026-11-11T12:01:00Z" || mustLoad(t, e.path).LastCheckAt != res.CheckedAt {
		t.Errorf("checked_at = %q, last_check_at = %q", res.CheckedAt, mustLoad(t, e.path).LastCheckAt)
	}
	raw, _ := os.ReadFile(e.path)
	if !strings.Contains(string(raw), "operator_hint: keep me") {
		t.Errorf("unknown top-level key lost:\n%s", raw)
	}
}

func TestCheck_SnapshotFailureIsAnErrorAndWritesNothing(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1"}))
	before, _ := os.ReadFile(e.path)
	e.snapshotErr = errors.New("no server running")
	if _, err := Check(context.Background(), checkTestServer, CheckOptions{}); err == nil || !strings.Contains(err.Error(), "no server running") {
		t.Fatalf("err = %v, want the tmux failure", err)
	}
	after, _ := os.ReadFile(e.path)
	if string(before) != string(after) {
		t.Error("a failed check wrote the state file")
	}
}

func TestCheck_UnreadableStateFileIsAnError(t *testing.T) {
	e := newCheckEnv(t)
	if err := os.MkdirAll(filepath.Dir(e.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(e.path, []byte("tracked: [unclosed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Check(context.Background(), checkTestServer, CheckOptions{}); err == nil || !strings.Contains(err.Error(), "cannot parse") {
		t.Fatalf("err = %v, want a parse error naming the file", err)
	}
}

func TestCheckDelta_MarshalPinsKeysPerKind(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		d    CheckDelta
		want string
	}{
		{CheckDelta{Kind: DeltaDone, ID: "a"}, `{"kind":"done","id":"a","then":null}`},
		{CheckDelta{Kind: DeltaDone, ID: "a", Then: str("merge it")}, `{"kind":"done","id":"a","then":"merge it"}`},
		{CheckDelta{Kind: DeltaPaneMismatch, ID: "a", Pane: "%1"}, `{"kind":"pane_mismatch","id":"a","pane":"%1","found":null}`},
		{CheckDelta{Kind: DeltaAgentExited, ID: "a", Pane: "%1", Command: str("zsh")}, `{"kind":"agent_exited","id":"a","pane":"%1","command":"zsh"}`},
		{CheckDelta{Kind: DeltaPaneDeath, ID: "a", Pane: "%1"}, `{"kind":"pane_death","id":"a","pane":"%1"}`},
		{CheckDelta{Kind: DeltaStageAdvance, ID: "a", Pane: "%1", From: str("apply"), To: str("review")}, `{"kind":"stage_advance","id":"a","pane":"%1","from":"apply","to":"review"}`},
		{CheckDelta{Kind: DeltaAgentState, ID: "a", Pane: "%1", To: str("waiting")}, `{"kind":"agent_state","id":"a","pane":"%1","from":null,"to":"waiting","duration":null}`},
		{CheckDelta{Kind: DeltaStale, ID: "a", Age: "11m"}, `{"kind":"stale","id":"a","age":"11m"}`},
		{CheckDelta{Kind: DeltaDue, ID: "a", Age: "6m", Instruction: "look"}, `{"kind":"due","id":"a","age":"6m","instruction":"look"}`},
		{CheckDelta{Kind: DeltaPaused, ID: "a", Error: "boom", Failures: 3, Paused: true}, `{"kind":"paused","id":"a","error":"boom","failures":3,"paused":true}`},
		{CheckDelta{Kind: DeltaUnknownDep, ID: "a", Dep: "x"}, `{"kind":"unknown_dep","id":"a","dep":"x"}`},
		{CheckDelta{Kind: DeltaChanged, ID: "a", Fields: map[string]FieldChange{"state": {From: "OPEN", To: "MERGED"}, "n": {To: 1}}},
			`{"kind":"changed","id":"a","fields":{"n":{"from":null,"to":1},"state":{"from":"OPEN","to":"MERGED"}}}`},
	}
	for _, tc := range cases {
		b, err := json.Marshal(tc.d)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", tc.d.Kind, b, tc.want)
		}
	}
}

// --- engine: the edge model ----------------------------------------------------

func TestCheck_StandingConditionIsNewThenOpenThenFiresAgainAfterClearing(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%7"}))

	first := e.run()
	wantKinds(t, "first changes", first.Changes, "p:pane_death")
	wantKinds(t, "first open", first.Open)
	if !first.Changed {
		t.Error("a new condition must set changed")
	}
	for i := 0; i < 2; i++ {
		again := e.run()
		wantKinds(t, "repeat changes", again.Changes)
		wantKinds(t, "repeat open", again.Open, "p:pane_death")
		if again.Changed {
			t.Error("an open condition must not set changed")
		}
	}

	// The pane returns: the condition clears and reported is emptied.
	e.panes["%7"] = paneRow{PaneID: "%7", Command: "claude", PanePID: 10}
	cleared := e.run()
	wantKinds(t, "cleared changes", cleared.Changes)
	wantKinds(t, "cleared open", cleared.Open)
	if got := e.item("p").Reported; len(got) != 0 {
		t.Errorf("Reported = %v, want it cleared", got)
	}

	// It disappears again: a returning condition is new again.
	delete(e.panes, "%7")
	wantKinds(t, "returning changes", e.run().Changes, "p:pane_death")
}

func TestCheck_ReportedIsSortedAndPersisted(t *testing.T) {
	e := newCheckEnv(t)
	it := agentItem("a", "2026-11-11T11:40:00Z") // 20m ago: stale and due
	it.DependsOn = []string{"zzz", "aaa"}
	e.seed(it)
	res := e.run()
	if len(res.Changes) != 4 {
		t.Fatalf("changes = %v", kindsOf(res.Changes))
	}
	got := e.item("a").Reported
	want := []string{"due@2026-11-11T11:40:00Z", "stale", "unknown_dep:aaa", "unknown_dep:zzz"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("Reported = %v, want %v", got, want)
	}
}

func TestCheck_DueFiresOncePerDuePeriod(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(agentItem("lin", "2026-11-11T11:54:00Z")) // 6m ago, check_every 5m

	first := e.run()
	wantKinds(t, "first", first.Changes, "lin:due")
	due := findDelta(t, first.Changes, DeltaDue)
	if due.Age != "6m" || due.Instruction != "check the inbox" {
		t.Errorf("due = %+v", due)
	}
	second := e.run()
	wantKinds(t, "second changes", second.Changes)
	wantKinds(t, "second open", second.Open, "lin:due")

	// Observing moves checked_at: the next period is a new key.
	if err := Observe(e.path, ObserveSpec{ID: "lin", Fields: map[string]interface{}{}}); err != nil {
		t.Fatal(err)
	}
	e.advance(6 * time.Minute)
	wantKinds(t, "next period", e.run().Changes, "lin:due")
}

func TestCheck_AgentItemStaleAndInertCases(t *testing.T) {
	e := newCheckEnv(t)
	stale := agentItem("stale", "2026-11-11T11:40:00Z") // 20m: > 2×5m
	paused := agentItem("paused", "2026-11-11T11:40:00Z")
	paused.Paused = true
	done := agentItem("done", "2026-11-11T11:40:00Z")
	doneAt := "2026-11-11T11:00:00Z"
	done.DoneAt = &doneAt
	capped := agentItem("capped", "2026-11-11T11:40:00Z")
	capped.Paused, capped.Failures = true, 3
	fresh := agentItem("fresh", "2026-11-11T11:58:00Z")
	e.seed(stale, paused, done, capped, fresh)

	res := e.run()
	wantKinds(t, "changes", res.Changes, "stale:stale", "stale:due", "done:done", "capped:paused")
	if p := findDelta(t, res.Changes, DeltaPaused); p.Failures != 3 || !p.Paused || !strings.Contains(p.Error, "3 consecutive") {
		t.Errorf("paused = %+v", p)
	}
	if got := findDelta(t, res.Changes, DeltaStale); got.Age != "20m" {
		t.Errorf("stale age = %q", got.Age)
	}
}

func TestCheck_AgentItemsAreNeverExecuted(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(agentItem("lin", ""), baseItem("t", KindTask, probeNone))
	e.run()
	if e.probeCalls != 0 || e.snapshotCalls != 0 {
		t.Errorf("probe calls %d, snapshot calls %d, want none", e.probeCalls, e.snapshotCalls)
	}
}

func TestCheck_UnknownDependencyIsAStandingCondition(t *testing.T) {
	e := newCheckEnv(t)
	it := baseItem("t", KindTask, probeNone)
	it.DependsOn = []string{"ghost"}
	e.seed(it)
	first := e.run()
	wantKinds(t, "first", first.Changes, "t:unknown_dep")
	if d := findDelta(t, first.Changes, DeltaUnknownDep); d.Dep != "ghost" {
		t.Errorf("dep = %q", d.Dep)
	}
	wantKinds(t, "second open", e.run().Open, "t:unknown_dep")
}

func TestCheck_DoneItemIsInertAndNotReProbed(t *testing.T) {
	e := newCheckEnv(t)
	doneAt := "2026-11-11T11:30:00Z"
	then := "tell the team"
	it := shellItem("s", "state")
	it.DoneAt, it.Then = &doneAt, &then
	e.seed(it)
	e.probeJSON(`{"state":"OPEN"}`)
	res := e.run()
	wantKinds(t, "changes", res.Changes, "s:done")
	if d := res.Changes[0]; d.Then == nil || *d.Then != "tell the team" {
		t.Errorf("done then = %v", d.Then)
	}
	if e.probeCalls != 0 {
		t.Errorf("a done item was probed %d times", e.probeCalls)
	}
	wantKinds(t, "second open", e.run().Open, "s:done")
}

// --- engine: the lock discipline -----------------------------------------------

// blockingProbe makes the probe block until released and reports when it has
// started, so a test can act between phase 1 and phase 2.
func blockingProbe(e *checkEnv, out string) (started <-chan struct{}, release func()) {
	startedCh := make(chan struct{})
	releaseCh := make(chan struct{})
	var once sync.Once
	e.probeFn = func([]string) (string, error) {
		once.Do(func() { close(startedCh) })
		<-releaseCh
		return out, nil
	}
	return startedCh, func() { close(releaseCh) }
}

func runCheckAsync(e *checkEnv) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, err := Check(context.Background(), checkTestServer, CheckOptions{})
		done <- err
	}()
	return done
}

func waitStarted(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the probe never started")
	}
}

func waitDone(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Check never finished")
	}
}

func TestCheck_NoLockIsHeldWhileProbesRun(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("probed", "state"), baseItem("other", KindTask, probeNone))
	started, release := blockingProbe(e, `{"state":"OPEN"}`)
	done := runCheckAsync(e)
	waitStarted(t, started)

	// The probe is in flight; a writer must get through immediately.
	if err := AddNote(e.path, "other", ByChat, "written during the probe"); err != nil {
		t.Fatalf("AddNote while a probe runs: %v", err)
	}
	release()
	waitDone(t, done)

	other := e.item("other")
	if len(other.Notes) != 1 || other.Notes[0].Text != "written during the probe" {
		t.Errorf("note lost: %+v", other.Notes)
	}
	if got := e.item("probed").Last["state"]; got != "OPEN" {
		t.Errorf("probe outcome lost: last = %v", e.item("probed").Last)
	}
}

func TestCheck_ProbeOutcomeIsDiscardedWhenCheckedAtMovedBetweenPhases(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "state"))
	started, release := blockingProbe(e, `{"state":"FROM-CHECK"}`)
	done := runCheckAsync(e)
	waitStarted(t, started)

	if err := Observe(e.path, ObserveSpec{ID: "s", Fields: map[string]interface{}{"state": "FROM-OBSERVE"}}); err != nil {
		t.Fatal(err)
	}
	release()
	waitDone(t, done)

	it := e.item("s")
	if it.Last["state"] != "FROM-OBSERVE" {
		t.Errorf("last = %v, the external observation must stand", it.Last)
	}
}

func TestCheck_ProbeOutcomeIsDiscardedWhenArgvChangedBetweenPhases(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "state"))
	started, release := blockingProbe(e, `{"state":"FROM-OLD-ARGV"}`)
	done := runCheckAsync(e)
	waitStarted(t, started)

	if err := Mutate(e.path, func(st *State) error {
		st.Tracked[0].Probe.Argv = []string{"probe", "new"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	release()
	waitDone(t, done)

	it := e.item("s")
	if len(it.Last) != 0 || it.CheckedAt != nil {
		t.Errorf("item = last %v checked_at %v, want the stale outcome discarded", it.Last, it.CheckedAt)
	}
}

func TestCheck_ItemRemovedDuringPhaseOneIsIgnoredAndItemAddedGetsNoProbeResult(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("gone", "state"), baseItem("stay", KindTask, probeNone))
	started, release := blockingProbe(e, `{"state":"OPEN"}`)
	done := runCheckAsync(e)
	waitStarted(t, started)

	if err := Remove(e.path, "gone"); err != nil {
		t.Fatal(err)
	}
	if err := Mutate(e.path, func(st *State) error {
		st.Tracked = append(st.Tracked, shellItem("late", "state"))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	release()
	waitDone(t, done)

	st := mustLoad(t, e.path)
	if indexOf(st.Tracked, "gone") >= 0 {
		t.Error("the removed item came back")
	}
	late := st.Tracked[indexOf(st.Tracked, "late")]
	if late.CheckedAt != nil || len(late.Last) != 0 {
		t.Errorf("late = %+v, want no probe result applied", late)
	}
}

func TestCheck_ConcurrentChecksReportAnEdgeOnce(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%9"}))

	var wg sync.WaitGroup
	results := make([]CheckResult, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := Check(context.Background(), checkTestServer, CheckOptions{})
			if err != nil {
				t.Errorf("Check: %v", err)
			}
			results[i] = res
		}(i)
	}
	wg.Wait()
	total := len(results[0].Changes) + len(results[1].Changes)
	open := len(results[0].Open) + len(results[1].Open)
	if total != 1 || open != 1 {
		t.Errorf("changes %d, open %d across both checks, want exactly one new and one open", total, open)
	}
}
