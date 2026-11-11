package operator

import (
	"context"
	"errors"
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

func TestCheck_StageAdvanceReviewFailAndNoBaseline(t *testing.T) {
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
	if scopeOf(e, "none", "stage") != nil {
		t.Errorf("an item with no baseline stage must stay null: %v", scopeOf(e, "none", "stage"))
	}
	wantKinds(t, "consumed", e.run().Changes)
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

func TestFormatAgentDuration(t *testing.T) {
	for in, want := range map[int64]string{-5: "", 0: "", 59: "59s", 60: "1m", 3599: "59m", 3600: "1h", 7300: "2h"} {
		if got := formatAgentDuration(in); got != want {
			t.Errorf("formatAgentDuration(%d) = %q, want %q", in, got, want)
		}
	}
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
