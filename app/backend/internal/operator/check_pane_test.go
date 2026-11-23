package operator

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"rk/internal/proctree"
)

func scopeOf(e *checkEnv, id, key string) interface{} { return e.item(id).Scope[key] }

func TestCheck_PaneSnapshotOnlyWhenAPaneItemHasAPane(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("pending", nil)) // scope.pane null
	e.run()
	if e.snapshotCalls != 0 {
		t.Errorf("snapshot calls = %d, want 0 for a pane item with no pane", e.snapshotCalls)
	}
	e.seed(paneItem("bound", map[string]interface{}{"pane": "%1"}))
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5}
	e.run()
	if e.snapshotCalls != 1 {
		t.Errorf("snapshot calls = %d, want exactly one per check", e.snapshotCalls)
	}
}

func TestCheck_PaneMismatchOnRecycledPaneAndNoBaselineChange(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%5", "pane_pid": 100, "stage": "apply", "agent": "active"}))
	e.panes["%5"] = paneRow{PaneID: "%5", Command: "claude", PanePID: 200, Change: "c-new", Stage: "review", AgentState: "waiting"}

	res := e.run()
	wantKinds(t, "changes", res.Changes, "p:pane_mismatch")
	d := res.Changes[0]
	if d.Pane != "%5" || d.Found == nil || *d.Found != "c-new" {
		t.Errorf("delta = %+v, want pane %%5 found c-new", d)
	}
	if scopeOf(e, "p", "stage") != "apply" || scopeOf(e, "p", "agent") != "active" || scopeOf(e, "p", "change") != nil {
		t.Errorf("a mismatched pane must not touch the baselines: %v", e.item("p").Scope)
	}
}

func TestCheck_PaneMismatchJoinsOnIdWhenPidIsNullOrUnknown(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(
		paneItem("nullpid", map[string]interface{}{"pane": "%1"}),
		paneItem("unknown", map[string]interface{}{"pane": "%2", "pane_pid": 100}),
		paneItem("match", map[string]interface{}{"pane": "%3", "pane_pid": 300}),
	)
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 111}
	e.panes["%2"] = paneRow{PaneID: "%2", Command: "claude"} // PanePID unreadable
	e.panes["%3"] = paneRow{PaneID: "%3", Command: "claude", PanePID: 300}
	res := e.run()
	wantKinds(t, "changes", res.Changes)
}

func TestCheck_AgentExitedNeedsABareShellAndNoLiveAgent(t *testing.T) {
	cases := []struct {
		name  string
		row   paneRow
		alive bool
		want  bool
		walk  bool
	}{
		{"shell, no agent state, walk finds none", paneRow{Command: "zsh", PanePID: 9}, false, true, true},
		{"shell, walk finds an agent", paneRow{Command: "zsh", PanePID: 9}, true, false, true},
		{"agent TUI owns the tty", paneRow{Command: "claude", PanePID: 9}, false, false, false},
		{"shell with a live instrumented agent pid", paneRow{Command: "zsh", PanePID: 9, AgentState: "active", AgentPID: 42}, false, false, false},
		{"shell with state but no pid still walks", paneRow{Command: "bash", PanePID: 9, AgentState: "active"}, false, true, true},
		{"shell with no walk root", paneRow{Command: "zsh"}, false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newCheckEnv(t)
			e.alive = tc.alive
			tc.row.PaneID = "%1"
			e.panes["%1"] = tc.row
			e.seed(paneItem("p", map[string]interface{}{"pane": "%1"}))
			res := e.run()
			if tc.want {
				wantKinds(t, "changes", res.Changes, "p:agent_exited")
				if d := res.Changes[0]; d.Command == nil || *d.Command != tc.row.Command {
					t.Errorf("command = %v, want %q", d.Command, tc.row.Command)
				}
			} else {
				wantKinds(t, "changes", res.Changes)
			}
			if walked := e.aliveCalls > 0; walked != tc.walk {
				t.Errorf("walked = %v, want %v", walked, tc.walk)
			}
		})
	}
}

func TestAgentAliveViaTreatsAWalkErrorAsAlive(t *testing.T) {
	boom := func(context.Context, int) ([]proctree.Node, error) { return nil, errors.New("boom") }
	if !agentAliveVia(context.Background(), boom, 9, 0) {
		t.Error("a walk error must count as alive: no evidence must not fabricate an exit")
	}
	empty := func(context.Context, int) ([]proctree.Node, error) { return []proctree.Node{}, nil }
	if agentAliveVia(context.Background(), empty, 9, 0) {
		t.Error("an empty tree has no agent")
	}
}

func TestCheck_PanePrecedence(t *testing.T) {
	e := newCheckEnv(t)
	e.alive = false
	// Mismatched AND shell-with-no-agent: pane_mismatch wins over agent_exited.
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "zsh", PanePID: 2}
	e.seed(
		paneItem("gone", map[string]interface{}{"pane": "%404", "pane_pid": 1}),
		paneItem("mm", map[string]interface{}{"pane": "%1", "pane_pid": 1}),
	)
	wantKinds(t, "changes", e.run().Changes, "gone:pane_death", "mm:pane_mismatch")
}

func TestCheck_ChangeAppearSwitchAndStickyBaseline(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1"}))
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5, Change: "c1"}

	res := e.run()
	wantKinds(t, "appear", res.Changes, "p:changed")
	if f := res.Changes[0].Fields["change"]; f.From != nil || f.To != "c1" {
		t.Errorf("appear field = %+v, want null → c1", f)
	}
	if scopeOf(e, "p", "change") != "c1" {
		t.Errorf("scope.change = %v", scopeOf(e, "p", "change"))
	}
	wantKinds(t, "stable", e.run().Changes)

	// An unresolved observation never clears the baseline.
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5}
	wantKinds(t, "unresolved", e.run().Changes)
	if scopeOf(e, "p", "change") != "c1" {
		t.Errorf("sticky baseline lost: %v", scopeOf(e, "p", "change"))
	}

	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5, Change: "c2"}
	res = e.run()
	wantKinds(t, "switch", res.Changes, "p:changed")
	if f := res.Changes[0].Fields["change"]; f.From != "c1" || f.To != "c2" {
		t.Errorf("switch field = %+v, want c1 → c2", f)
	}
}

func TestCheck_BranchMapWriteSkipAndRetry(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "repo": "/src/app"}))
	e.panes["%1"] = paneRow{PaneID: "%1", Cwd: "/src/app", Command: "claude", PanePID: 5, Change: "c1"}

	// Detached HEAD: skipped, nothing written.
	e.branch = ""
	e.run()
	if _, ok := mustLoad(t, e.path).BranchMap["c1"]; ok {
		t.Error("branch_map written for a detached HEAD")
	}
	// Next check retries and writes.
	e.branch = "feat/x"
	e.run()
	got := mustLoad(t, e.path).BranchMap["c1"]
	if got.Branch != "feat/x" || got.Repo != "/src/app" {
		t.Errorf("branch_map[c1] = %+v", got)
	}
	// An existing entry is never re-resolved or overwritten.
	calls := e.branchCalls
	e.branch = "other"
	e.run()
	if e.branchCalls != calls || mustLoad(t, e.path).BranchMap["c1"].Branch != "feat/x" {
		t.Errorf("existing entry touched (calls %d → %d)", calls, e.branchCalls)
	}
}

func TestCheck_BranchMapSkippedWithoutRepoOrChange(t *testing.T) {
	e := newCheckEnv(t)
	e.branch = "feat"
	e.seed(
		paneItem("norepo", map[string]interface{}{"pane": "%1"}),
		paneItem("nochange", map[string]interface{}{"pane": "%2", "repo": "/r"}),
	)
	e.panes["%1"] = paneRow{PaneID: "%1", Cwd: "/a", Command: "claude", PanePID: 5, Change: "c1"}
	e.panes["%2"] = paneRow{PaneID: "%2", Cwd: "/b", Command: "claude", PanePID: 6}
	e.run()
	if len(mustLoad(t, e.path).BranchMap) != 0 || e.branchCalls != 0 {
		t.Errorf("branch_map = %v, git calls %d, want none", mustLoad(t, e.path).BranchMap, e.branchCalls)
	}
}

func TestCheck_BuiltInCompletion(t *testing.T) {
	cases := []struct {
		name      string
		scope     map[string]interface{}
		stage, ds string
		done      bool
	}{
		{"no stop_stage: ship done", map[string]interface{}{"change": "c"}, "ship", "done", true},
		{"no stop_stage: ship skipped", map[string]interface{}{"change": "c"}, "ship", "skipped", true},
		{"no stop_stage: ship active", map[string]interface{}{"change": "c"}, "ship", "active", false},
		{"no stop_stage: hydrate done is mid-pipeline", map[string]interface{}{"change": "c"}, "hydrate", "done", false},
		{"stop_stage: past the stop", map[string]interface{}{"change": "c", "stop_stage": "hydrate"}, "ship", "active", true},
		{"stop_stage: at the stop, finished", map[string]interface{}{"change": "c", "stop_stage": "hydrate"}, "hydrate", "done", true},
		{"stop_stage: at the stop, running", map[string]interface{}{"change": "c", "stop_stage": "hydrate"}, "hydrate", "active", false},
		{"stop_stage: before the stop", map[string]interface{}{"change": "c", "stop_stage": "ship"}, "review", "done", false},
		{"stop_stage: review-pr stop", map[string]interface{}{"change": "c", "stop_stage": "review-pr"}, "review-pr", "done", true},
		{"unknown stop_stage never completes", map[string]interface{}{"change": "c", "stop_stage": "nonsense"}, "ship", "done", false},
		{"change-less item is never done on its own", map[string]interface{}{}, "ship", "done", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newCheckEnv(t)
			scope := map[string]interface{}{"pane": "%1"}
			for k, v := range tc.scope {
				scope[k] = v
			}
			e.seed(paneItem("p", scope))
			e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5, Stage: tc.stage, DisplayState: tc.ds}
			res := e.run()
			it := e.item("p")
			if got := it.DoneAt != nil; got != tc.done {
				t.Errorf("done_at set = %v, want %v", got, tc.done)
			}
			var hasDone bool
			for _, d := range res.Changes {
				hasDone = hasDone || d.Kind == DeltaDone
			}
			if hasDone != tc.done {
				t.Errorf("done delta = %v, want %v (%v)", hasDone, tc.done, kindsOf(res.Changes))
			}
		})
	}
}

func TestCheck_CompletedPaneItemSurvivesThePaneDisappearing(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "change": "c"}))
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 5, Stage: "ship", DisplayState: "done"}
	wantKinds(t, "completion", e.run().Changes, "p:done")

	delete(e.panes, "%1")
	res := e.run()
	wantKinds(t, "after the pane left changes", res.Changes)
	wantKinds(t, "after the pane left open", res.Open, "p:done")
}

func TestCheck_StageAdvanceReviewFailAndBaselineSeed(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(
		paneItem("adv", map[string]interface{}{"pane": "%1", "stage": "apply"}),
		paneItem("fail", map[string]interface{}{"pane": "%2", "stage": "review"}),
		paneItem("none", map[string]interface{}{"pane": "%3"}),
	)
	e.panes["%1"] = paneRow{PaneID: "%1", Command: "claude", PanePID: 1, Stage: "review", DisplayState: "active"}
	e.panes["%2"] = paneRow{PaneID: "%2", Command: "claude", PanePID: 2, Stage: "apply", DisplayState: "active"}
	e.panes["%3"] = paneRow{PaneID: "%3", Command: "claude", PanePID: 3, Stage: "apply", DisplayState: "active"}

	res := e.run()
	wantKinds(t, "changes", res.Changes, "adv:stage_advance", "fail:review_fail")
	adv := res.Changes[0]
	if adv.Pane != "%1" || adv.From == nil || *adv.From != "apply" || adv.To == nil || *adv.To != "review" {
		t.Errorf("stage_advance = %+v", adv)
	}
	if scopeOf(e, "adv", "stage") != "review" || scopeOf(e, "fail", "stage") != "apply" {
		t.Error("stage baselines not consumed")
	}
	if scopeOf(e, "none", "stage") != "apply" {
		t.Errorf("an item with no baseline stage must be seeded: %v", scopeOf(e, "none", "stage"))
	}
	wantKinds(t, "consumed", e.run().Changes)

	// The seeded baseline diffs like any other from the next check on.
	e.panes["%3"] = paneRow{PaneID: "%3", Command: "claude", PanePID: 3, Stage: "review", DisplayState: "active"}
	res = e.run()
	wantKinds(t, "seeded advance", res.Changes, "none:stage_advance")
	if d := res.Changes[0]; *d.From != "apply" || *d.To != "review" {
		t.Errorf("seeded stage_advance = %s → %s", *d.From, *d.To)
	}
	e.panes["%3"] = paneRow{PaneID: "%3", Command: "claude", PanePID: 3, Stage: "apply", DisplayState: "active"}
	wantKinds(t, "seeded rework", e.run().Changes, "none:review_fail")
}

// Idle is a condition only once the work has stopped: held for idleFloor and
// no other pane in its window active. Waiting is immediate, aged unchanged.
func TestCheck_IdleNeedsTheFloorAndNoActiveSibling(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) int64 { return now.Add(-d).Unix() }
	tracked := func(state string, epoch int64) paneRow {
		return paneRow{PaneID: "%1", WindowID: "@1", Command: "claude", PanePID: 5, AgentState: state, AgentEpoch: epoch}
	}
	sibling := func(id, window, state string) paneRow {
		return paneRow{PaneID: id, WindowID: window, Command: "claude", PanePID: 6, AgentState: state}
	}
	cases := []struct {
		name     string
		rows     []paneRow
		want     []string
		duration string
	}{
		{"worker active", []paneRow{tracked("idle", ago(5*time.Minute)), sibling("%2", "@1", "active")}, nil, ""},
		{"floor not reached", []paneRow{tracked("idle", ago(30*time.Second))}, nil, ""},
		{"both pass", []paneRow{tracked("idle", ago(idleFloor)), sibling("%2", "@1", "idle"), sibling("%3", "@2", "active")}, []string{"p:agent_state"}, "3m"},
		{"no epoch", []paneRow{tracked("idle", 0)}, []string{"p:agent_state"}, ""},
		{"waiting unaffected", []paneRow{tracked("waiting", ago(30*time.Second)), sibling("%2", "@1", "active")}, []string{"p:agent_state"}, "30s"},
		{"aged with worker active", []paneRow{tracked("idle", ago(31*time.Minute)), sibling("%2", "@1", "active")}, []string{"p:agent_aged"}, "31m"},
		{"no window never groups", []paneRow{
			{PaneID: "%1", Command: "claude", PanePID: 5, AgentState: "idle", AgentEpoch: ago(idleFloor)},
			sibling("%2", "", "active"),
		}, []string{"p:agent_state"}, "3m"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newCheckEnv(t)
			e.now = now
			e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "agent": "active"}))
			for _, r := range tc.rows {
				e.panes[r.PaneID] = r
			}
			res := e.run()
			wantKinds(t, "changes", res.Changes, tc.want...)
			wantKinds(t, "open", res.Open)
			if len(res.Changes) > 0 {
				if d := res.Changes[0].Duration; (d == nil) != (tc.duration == "") || (d != nil && *d != tc.duration) {
					t.Errorf("duration = %v, want %q", d, tc.duration)
				}
			}
			if got := scopeOf(e, "p", "agent"); got != tc.rows[0].AgentState {
				t.Errorf("scope.agent = %v, want %s", got, tc.rows[0].AgentState)
			}
		})
	}
}

// A manual trigger waives the idle floor — an idle of seconds is reported —
// but not the active-sibling rule: a worker still running means the work has
// not stopped, whoever asked.
func TestCheck_ManualTriggerIgnoresTheIdleFloor(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	epoch := now.Add(-20 * time.Second).Unix()
	tracked := paneRow{PaneID: "%1", WindowID: "@1", Command: "claude", PanePID: 5, AgentState: "idle", AgentEpoch: epoch}
	worker := paneRow{PaneID: "%2", WindowID: "@1", Command: "claude", PanePID: 6, AgentState: "active"}

	e := newCheckEnv(t)
	e.now = now
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "agent": "active"}))
	e.panes["%1"] = tracked
	wantKinds(t, "scheduled, under floor", e.run().Changes)
	res := e.runWith(CheckOptions{IgnoreIdleFloor: true})
	wantKinds(t, "manual, under floor", res.Changes, "p:agent_state")
	if d := res.Changes[0].Duration; d == nil || *d != "20s" {
		t.Errorf("duration = %v, want 20s", d)
	}

	e = newCheckEnv(t)
	e.now = now
	e.seed(paneItem("q", map[string]interface{}{"pane": "%1", "agent": "active"}))
	e.panes["%1"] = tracked
	e.panes["%2"] = worker
	wantKinds(t, "manual, worker active", e.runWith(CheckOptions{IgnoreIdleFloor: true}).Changes)
}

// A suppressed idle moves the baseline silently; the check at which it passes
// the gate reports one edge, with no "from" since the baseline is already idle.
func TestCheck_IdleResumesWithOneEdge(t *testing.T) {
	e := newCheckEnv(t)
	e.now = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "agent": "active"}))
	epoch := e.now.Add(-time.Minute).Unix()
	e.panes["%1"] = paneRow{PaneID: "%1", WindowID: "@1", Command: "claude", PanePID: 5, AgentState: "idle", AgentEpoch: epoch}
	e.panes["%2"] = paneRow{PaneID: "%2", WindowID: "@1", Command: "claude", PanePID: 6, AgentState: "active"}
	wantKinds(t, "under floor, worker active", e.run().Changes)

	e.advance(5 * time.Minute)
	wantKinds(t, "past floor, worker active", e.run().Changes)

	e.panes["%2"] = paneRow{PaneID: "%2", WindowID: "@1", Command: "claude", PanePID: 6, AgentState: "idle"}
	res := e.run()
	wantKinds(t, "worker stopped", res.Changes, "p:agent_state")
	if d := res.Changes[0]; d.From != nil || d.Duration == nil || *d.Duration != "6m" {
		t.Errorf("agent_state = from %v duration %v, want null and 6m", d.From, d.Duration)
	}
	again := e.run()
	wantKinds(t, "still idle changes", again.Changes)
	wantKinds(t, "still idle open", again.Open, "p:agent_state")
}

func TestCheck_AgentStateFiresOnlyIntoWaitingOrIdle(t *testing.T) {
	e := newCheckEnv(t)
	e.now = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "agent": "active"}))
	row := func(state string, epoch int64) paneRow {
		return paneRow{PaneID: "%1", Command: "claude", PanePID: 5, AgentState: state, AgentEpoch: epoch}
	}

	e.panes["%1"] = row("waiting", e.now.Unix()-185)
	res := e.run()
	wantKinds(t, "into waiting", res.Changes, "p:agent_state")
	d := res.Changes[0]
	if d.From == nil || *d.From != "active" || d.To == nil || *d.To != "waiting" || d.Duration == nil || *d.Duration != "3m" || d.Pane != "%1" {
		t.Errorf("agent_state = %+v (duration %v)", d, d.Duration)
	}
	// Still waiting: no new delta, listed as open (without a stale "from").
	again := e.run()
	wantKinds(t, "still waiting changes", again.Changes)
	wantKinds(t, "still waiting open", again.Open, "p:agent_state")
	if again.Open[0].From != nil {
		t.Errorf("open from = %v, want nil", again.Open[0].From)
	}

	// waiting → active updates the baseline silently.
	e.panes["%1"] = row("active", 0)
	wantKinds(t, "to active", e.run().Changes)
	if scopeOf(e, "p", "agent") != "active" {
		t.Errorf("scope.agent = %v", scopeOf(e, "p", "agent"))
	}
	// active → idle fires; idle → unknown is silent and nulls the baseline.
	e.panes["%1"] = row("idle", 0)
	wantKinds(t, "into idle", e.run().Changes, "p:agent_state")
	e.panes["%1"] = row("", 0)
	wantKinds(t, "to unknown", e.run().Changes)
	if scopeOf(e, "p", "agent") != nil {
		t.Errorf("scope.agent = %v, want null", scopeOf(e, "p", "agent"))
	}
	// And back into waiting from unknown is a fresh edge.
	e.panes["%1"] = row("waiting", 0)
	res = e.run()
	wantKinds(t, "unknown → waiting", res.Changes, "p:agent_state")
	if res.Changes[0].From != nil || res.Changes[0].Duration != nil {
		t.Errorf("from %v duration %v, want both null", res.Changes[0].From, res.Changes[0].Duration)
	}
}

// A waiting or idle state held for 30 minutes is a change once more
// (agent_aged): idle once per stretch, waiting again every half hour; a new
// stretch of the same state starts over.
func TestCheck_AgentAged(t *testing.T) {
	e := newCheckEnv(t)
	e.now = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	e.seed(paneItem("p", map[string]interface{}{"pane": "%1", "agent": "active"}))
	row := func(state string, epoch int64) paneRow {
		return paneRow{PaneID: "%1", Command: "claude", PanePID: 5, AgentState: state, AgentEpoch: epoch}
	}
	epoch := e.now.Add(-idleFloor).Unix()
	e.panes["%1"] = row("idle", epoch)
	wantKinds(t, "into idle", e.run().Changes, "p:agent_state")

	e.now = e.now.Add(26 * time.Minute)
	wantKinds(t, "idle 29m", e.run().Changes)

	e.now = e.now.Add(2 * time.Minute)
	res := e.run()
	wantKinds(t, "idle 31m", res.Changes, "p:agent_aged")
	if d := res.Changes[0]; d.Pane != "%1" || d.To == nil || *d.To != "idle" || d.Duration == nil || *d.Duration != "31m" {
		t.Errorf("agent_aged = %+v", d)
	}
	again := e.run()
	wantKinds(t, "still aged changes", again.Changes)
	wantKinds(t, "still aged open", again.Open, "p:agent_state", "p:agent_aged")

	// Idle fires once per stretch: the check cannot tell finished work from
	// stuck work, and a finished agent must not cost a run every half hour.
	e.now = e.now.Add(29 * time.Minute)
	wantKinds(t, "idle 60m", e.run().Changes)

	// A nudge makes it active; the next idle stretch ages again from zero.
	e.panes["%1"] = row("active", 0)
	wantKinds(t, "to active", e.run().Changes)
	e.panes["%1"] = row("idle", e.now.Add(-idleFloor).Unix())
	wantKinds(t, "idle again", e.run().Changes, "p:agent_state")
	e.now = e.now.Add(27 * time.Minute)
	wantKinds(t, "idle again 30m", e.run().Changes, "p:agent_aged")

	// Waiting ages every half hour it stays unanswered, so a run that could
	// not resolve the prompt keeps getting the chance to escalate.
	e.panes["%1"] = row("waiting", e.now.Unix()-45*60)
	wantKinds(t, "waiting 45m", e.run().Changes, "p:agent_state", "p:agent_aged")
	wantKinds(t, "waiting 45m again", e.run().Changes)
	e.now = e.now.Add(16 * time.Minute)
	res = e.run()
	wantKinds(t, "waiting 61m", res.Changes, "p:agent_aged")
	if d := res.Changes[0]; d.Duration == nil || !strings.HasPrefix(*d.Duration, "1h") {
		t.Errorf("agent_aged duration = %v, want an hour-plus age", d.Duration)
	}
	e.now = e.now.Add(30 * time.Minute)
	wantKinds(t, "waiting 91m", e.run().Changes, "p:agent_aged")
	e.panes["%1"] = row("idle", 0)
	wantKinds(t, "idle with no epoch", e.run().Changes, "p:agent_state")
}

func TestCheck_UserPausedPaneItemStillConsumesBaselinesButReportsNoCondition(t *testing.T) {
	e := newCheckEnv(t)
	it := paneItem("p", map[string]interface{}{"pane": "%404"})
	it.Paused = true
	e.seed(it)
	res := e.run()
	wantKinds(t, "changes", res.Changes)
	wantKinds(t, "open", res.Open)
}

// The completion predicate, including the intake stop that completes at intake
// ready (where /fab-new parks).
func TestBuiltInCompleted(t *testing.T) {
	cases := []struct {
		stop, stage, display string
		want                 bool
	}{
		{"", "ship", "done", true},
		{"", "ship", "active", false},
		{"", "intake", "ready", false},
		{"intake", "intake", "ready", true},
		{"intake", "intake", "active", false},
		{"intake", "apply", "active", true},
		{"hydrate", "hydrate", "ready", false},
		{"hydrate", "hydrate", "done", true},
		{"hydrate", "ship", "active", true},
		{"apply", "intake", "ready", false},
	}
	for _, tc := range cases {
		if got := builtInCompleted(tc.stop, tc.stage, tc.display); got != tc.want {
			t.Errorf("builtInCompleted(%q, %q, %q) = %v, want %v", tc.stop, tc.stage, tc.display, got, tc.want)
		}
	}
}
