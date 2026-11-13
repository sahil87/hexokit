package operatorloop

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operator"
	"rk/internal/selfpath"
	"rk/internal/tmux"
)

// launchCall captures what the runner asked tmux to create, plus whether the
// durable files already existed at that moment.
type launchCall struct {
	server, name, cwd, shellCmd, runID string
	recordExisted, briefExisted        bool
}

func stubLaunch(t *testing.T, r *rig, err error) *[]launchCall {
	t.Helper()
	var calls []launchCall
	launchWindowFn = func(ctx context.Context, server, name, cwd, shellCmd, runID string) (tmux.WindowBirth, error) {
		recPath := mustRecordPath(t, r, runID)
		briefPath, _ := BriefPath(r.runsDir(), runID)
		calls = append(calls, launchCall{server, name, cwd, shellCmd, runID, exists(t, recPath), exists(t, briefPath)})
		if err != nil {
			return tmux.WindowBirth{}, err
		}
		return tmux.WindowBirth{Session: tmux.OperatorSessionName, WindowID: "@7", PaneID: "%7"}, nil
	}
	return &calls
}

func changedCheck(ids ...string) func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
	return func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		res := operator.CheckResult{Changed: true}
		for _, id := range ids {
			res.Changes = append(res.Changes, operator.CheckDelta{Kind: operator.DeltaDone, ID: id})
		}
		return res, nil
	}
}

func TestRunBusyDoesNotCheck(t *testing.T) {
	r := newRig(t)
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) {
		return []tmux.RunWindow{{WindowID: "@3", RunID: runA}}, nil
	}
	checked := false
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		checked = true
		return operator.CheckResult{}, nil
	}
	got := Run(context.Background(), fire())
	if got.String() != "skipped-busy: run "+runA || got.Held {
		t.Fatalf("outcome = %+v", got)
	}
	if checked {
		t.Fatal("Check ran while a run window was alive")
	}
	_ = r
}

func TestRunBusyWindowWithoutStampedID(t *testing.T) {
	newRig(t)
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) {
		return []tmux.RunWindow{{WindowID: "@3"}}, nil
	}
	if got := Run(context.Background(), fire()); got.String() != "skipped-busy: run unknown" {
		t.Fatalf("outcome = %q", got.String())
	}
}

func TestRunCheckFailed(t *testing.T) {
	newRig(t)
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		return operator.CheckResult{}, errBoom
	}
	if got := Run(context.Background(), fire()); got.String() != "check-failed: boom" || got.Held {
		t.Fatalf("outcome = %+v", got)
	}
}

func TestRunWindowListFailureIsCheckFailed(t *testing.T) {
	newRig(t)
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) { return nil, errBoom }
	if got := Run(context.Background(), fire()); !strings.HasPrefix(got.String(), "check-failed: listing run windows") {
		t.Fatalf("outcome = %q", got.String())
	}
}

func TestRunBadServerName(t *testing.T) {
	newRig(t)
	f := fire()
	f.Server = "../x"
	if got := Run(context.Background(), f); !strings.HasPrefix(got.String(), "check-failed: ") {
		t.Fatalf("outcome = %q", got.String())
	}
}

func TestRunNoChangeCreatesNothing(t *testing.T) {
	r := newRig(t)
	checkFn = func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error) {
		return operator.CheckResult{Changed: false}, nil
	}
	calls := stubLaunch(t, r, nil)
	if got := Run(context.Background(), fire()); got.String() != "no change" || got.Held {
		t.Fatalf("outcome = %+v", got)
	}
	if len(*calls) != 0 {
		t.Fatal("a window launched on no change")
	}
	if ids, _ := listRunIDs(r.runsDir()); len(ids) != 0 {
		t.Fatalf("run records created on no change: %v", ids)
	}
}

func TestRunChangedPersistsThenLaunches(t *testing.T) {
	r := newRig(t)
	r.addNoteItem("pr-41")
	checkFn = changedCheck("pr-41")
	newRunIDFn = func() (string, error) { return runA, nil }
	calls := stubLaunch(t, r, nil)

	got := Run(context.Background(), fire())
	if !got.Held {
		t.Fatalf("a launch must return a Held outcome, got %+v", got)
	}
	if len(*calls) != 1 {
		t.Fatalf("launches = %d", len(*calls))
	}
	c := (*calls)[0]
	if !c.recordExisted || !c.briefExisted {
		t.Errorf("record/brief must be durable before the window is created: %+v", c)
	}
	if c.server != testServer || c.name != "run-aaaa" || c.runID != runA || c.cwd != "/home/tester" {
		t.Errorf("launch = %+v", c)
	}
	wantCmd := `'/opt/rk/bin/rk' 'operator' 'run-exec' '--server' 'dev' '--run' '` + runA + `' '--' 'sh' '-c' 'claude -p --dangerously-skip-permissions'`
	if c.shellCmd != wantCmd {
		t.Errorf("shell command =\n %s\nwant\n %s", c.shellCmd, wantCmd)
	}

	rec, err := ReadRecord(mustRecordPath(t, r, runA))
	if err != nil {
		t.Fatal(err)
	}
	if rec.Entry != "lp01" || rec.Server != testServer || rec.Window != "run-aaaa" || rec.FiredAt != "2026-11-12T10:15:00Z" ||
		len(rec.Changed) != 1 || rec.Changed[0] != "pr-41" || rec.Ended() {
		t.Errorf("record = %+v", rec)
	}
	briefPath, _ := BriefPath(r.runsDir(), runA)
	brief, _ := readFile(briefPath)
	if !strings.Contains(brief, "pr-41") || !strings.Contains(brief, "Exit contract") {
		t.Errorf("brief = %.200s", brief)
	}
}

func TestRunLauncherAndRootResolution(t *testing.T) {
	r := newRig(t)
	r.addNoteItem("a")
	checkFn = changedCheck("a")
	rootDir := t.TempDir()
	operatorRootFn = func(context.Context, string) (string, error) { return rootDir, nil }
	var gotRoot, gotTier string
	resolveLauncherFn = func(_ context.Context, root, tier string) string {
		gotRoot, gotTier = root, tier
		return "fab-resolved -p"
	}
	calls := stubLaunch(t, r, nil)
	Run(context.Background(), fire())
	c := (*calls)[0]
	if c.cwd != rootDir || gotRoot != rootDir || gotTier != "operator" {
		t.Errorf("cwd=%q root=%q tier=%q", c.cwd, gotRoot, gotTier)
	}
	if !strings.HasSuffix(c.shellCmd, `'sh' '-c' 'fab-resolved -p'`) {
		t.Errorf("shell command = %s", c.shellCmd)
	}

	// A recorded root that no longer validates falls back to home.
	operatorRootFn = func(context.Context, string) (string, error) { return "/no/such/dir", nil }
	if got := runWindowDir(context.Background(), testServer); got != "/home/tester" {
		t.Errorf("stale root fell back to %q", got)
	}
	operatorRootFn = func(context.Context, string) (string, error) { return "relative", nil }
	if got := runWindowDir(context.Background(), testServer); got != "/home/tester" {
		t.Errorf("relative root fell back to %q", got)
	}
}

func TestRunLaunchFailureIsRecordedLostWithNotes(t *testing.T) {
	r := newRig(t)
	r.addNoteItem("pr-41")
	checkFn = changedCheck("pr-41", "gone-item")
	newRunIDFn = func() (string, error) { return runA, nil }
	stubLaunch(t, r, errBoom)

	got := Run(context.Background(), fire())
	if !got.Held {
		t.Fatalf("a recorded launch failure is transcribed later, got %+v", got)
	}
	rec, _ := ReadRecord(mustRecordPath(t, r, runA))
	if !rec.Ended() || rec.Lost != "launch: boom" {
		t.Fatalf("record = %+v", rec)
	}
	lines := Transcribe(context.Background(), testServer)
	if len(lines) != 1 || lines[0].Outcome != "run-lost: launch: boom" {
		t.Fatalf("lines = %+v", lines)
	}

	st, err := operator.Load(r.statePath)
	if err != nil {
		t.Fatal(err)
	}
	var notes []operator.Note
	for _, it := range st.Tracked {
		if it.ID == "pr-41" {
			notes = it.Notes
		}
	}
	if len(notes) != 2 || notes[1].By != "run" || notes[1].Text != "run failed: launch: boom" {
		t.Fatalf("notes = %+v (a removed item must be skipped without error)", notes)
	}
}

func TestRunPrepareFailureLogsLostNow(t *testing.T) {
	r := newRig(t)
	checkFn = changedCheck("a")
	newRunIDFn = func() (string, error) { return "", errBoom }
	calls := stubLaunch(t, r, nil)
	got := Run(context.Background(), fire())
	if got.Held || got.String() != "run-lost: launch: boom" {
		t.Fatalf("outcome = %+v", got)
	}
	if len(*calls) != 0 {
		t.Fatal("window launched without a record")
	}
}

func TestChangedItemsFirstSeenOrderAndReasons(t *testing.T) {
	from, to := "apply", "review"
	changes := []operator.CheckDelta{
		{Kind: operator.DeltaStageAdvance, ID: "b", Pane: "%1", From: &from, To: &to},
		{Kind: operator.DeltaDone, ID: "a"},
		{Kind: operator.DeltaChanged, ID: "b", Fields: map[string]operator.FieldChange{"state": {}, "mergeable": {}}},
		{Kind: operator.DeltaStale, ID: "c", Age: "2h"},
		{Kind: operator.DeltaPaused, ID: "d", Error: "exit 1"},
		{Kind: operator.DeltaUnknownDep, ID: "e", Dep: "x"},
		{Kind: operator.DeltaPaneDeath, ID: "f", Pane: "%2"},
	}
	got := changedItems(changes)
	want := []operator.ChangedItem{
		{ID: "b", Reasons: []string{"stage_advance apply→review", "changed mergeable,state"}},
		{ID: "a", Reasons: []string{"done"}},
		{ID: "c", Reasons: []string{"stale 2h"}},
		{ID: "d", Reasons: []string{"paused exit 1"}},
		{ID: "e", Reasons: []string{"unknown_dep x"}},
		{ID: "f", Reasons: []string{"pane_death"}},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i].ID != want[i].ID || strings.Join(got[i].Reasons, "|") != strings.Join(want[i].Reasons, "|") {
			t.Errorf("item %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if ids := changedIDs(got); strings.Join(ids, ",") != "b,a,c,d,e,f" {
		t.Errorf("ids = %v", ids)
	}
}

func TestStateFileExists(t *testing.T) {
	r := newRig(t)
	if StateFileExists(context.Background(), testServer) {
		t.Fatal("no rk state file yet")
	}
	r.addNoteItem("a")
	if !StateFileExists(context.Background(), testServer) {
		t.Fatal("rk state file exists")
	}
	statePathFn = func(context.Context, string) (string, error) { return "", errBoom }
	if StateFileExists(context.Background(), testServer) {
		t.Fatal("an unresolvable state path must read as absent")
	}
}

// TestDefaultWrapperBinaryIsTheRunningExecutable: the run window must start
// the binary that is running the daemon, never the installed launcher symlink
// (a non-brew daemon would otherwise run an rk that has no run-exec verb).
func TestDefaultWrapperBinaryIsTheRunningExecutable(t *testing.T) {
	want, err := selfpath.Stable()
	if err != nil {
		t.Fatal(err)
	}
	got, err := selfPathFn()
	if err != nil || got != want {
		t.Fatalf("selfPathFn() = %q, %v; want the running executable %q", got, err, want)
	}
	if launcher, err := selfpath.Launcher(); err == nil && strings.HasPrefix(got, filepath.Dir(launcher)) {
		t.Errorf("wrapper path %q is inside the launcher directory", got)
	}
}
