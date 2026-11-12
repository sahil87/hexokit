package operator

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"rk/internal/fabstatus"
	"rk/internal/proctree"
	"rk/internal/tmux"
)

// terminusStage is the pipeline stage at which an item with no stop_stage
// completes. Completion there is a display-state check (done/skipped), never
// bare stage membership: a change entering hydrate is mid-pipeline.
const terminusStage = "ship"

// Stages whose transition is the rework reset: review failing back to apply.
const (
	stageReview = "review"
	stageApply  = "apply"
)

// paneRow is one pane of the server snapshot: tmux's own facts, rk's
// reconciled agent state, and the fab tier derived from the pane's cwd.
type paneRow struct {
	PaneID       string
	Cwd          string
	Command      string
	PanePID      int
	AgentPID     int
	AgentState   string
	AgentEpoch   int64
	Change       string
	Stage        string
	DisplayState string
}

// defaultPaneSnapshot lists every pane of the server through internal/tmux.
// A dead server is an error, not an empty snapshot: reading it as "every pane
// is gone" would report a pane_death for every tracked item.
func defaultPaneSnapshot(ctx context.Context, server string) (map[string]paneRow, error) {
	sessions, err := tmux.ListSessions(ctx, server)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	if len(sessions) == 0 {
		if err := tmux.ServerAlive(ctx, server); err != nil {
			return nil, fmt.Errorf("list sessions: %w", err)
		}
	}
	memo := fabstatus.NewMemo()
	rows := map[string]paneRow{}
	for _, s := range sessions {
		windows, err := tmux.ListWindowsStrict(ctx, s.Name, server)
		if err != nil {
			return nil, fmt.Errorf("list windows (%s): %w", s.Name, err)
		}
		for _, w := range windows {
			for _, p := range w.Panes {
				fab := memo.Derive(p.Cwd)
				rows[p.PaneID] = paneRow{
					PaneID: p.PaneID, Cwd: p.Cwd, Command: p.Command,
					PanePID: p.PanePID, AgentPID: p.AgentPID,
					AgentState: p.AgentState, AgentEpoch: p.AgentStateEpoch,
					Change: fab.Change, Stage: fab.Stage, DisplayState: fab.DisplayState,
				}
			}
		}
	}
	return rows, nil
}

// defaultAgentAlive walks the pane's process tree.
func defaultAgentAlive(ctx context.Context, panePID, agentPID int) bool {
	return agentAliveVia(ctx, proctree.Discover, panePID, agentPID)
}

// agentAliveVia reports whether the walk finds an agent. A walk error is
// "alive": no evidence must not fabricate an exit.
func agentAliveVia(ctx context.Context, discover proctree.DiscoverFunc, panePID, agentPID int) bool {
	_, has, err := proctree.PaneHasAgentVia(ctx, discover, panePID, agentPID)
	return err != nil || has
}

// defaultGitBranch returns the branch checked out at cwd ("" when detached).
func defaultGitBranch(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "branch", "--show-current").Output()
	return strings.TrimSpace(string(out)), err
}

// livePaneItem reports whether a pane item has a pane to join against and has
// not already completed.
func livePaneItem(it TrackedItem) bool {
	return it.Probe.Mode == probePane && scopeString(it.Scope, "pane") != "" && !hasDoneAt(it)
}

func hasDoneAt(it TrackedItem) bool {
	return it.DoneAt != nil && *it.DoneAt != ""
}

// snapshotTargets maps each pane item id to the pane the snapshot is taken
// for.
func snapshotTargets(items []TrackedItem) map[string]string {
	targets := map[string]string{}
	for _, it := range items {
		if it.Probe.Mode == probePane {
			if id := scopeString(it.Scope, "pane"); id != "" {
				targets[it.ID] = id
			}
		}
	}
	return targets
}

// anyPaneItems reports whether any item needs the pane snapshot.
func anyPaneItems(items []TrackedItem) bool {
	for _, it := range items {
		if it.Probe.Mode == probePane && scopeString(it.Scope, "pane") != "" {
			return true
		}
	}
	return false
}

// resolveExited marks the snapshot panes a tracked item points at whose
// foreground is a bare shell with no live agent: the reconciled agent state
// carries no live pid and the process-tree walk finds none. The walk and the
// branch lookups below run in phase 1 so no subprocess or /proc crawl happens
// under the state lock.
func resolveExited(ctx context.Context, items []TrackedItem, panes map[string]paneRow) map[string]bool {
	exited := map[string]bool{}
	for _, it := range items {
		if !livePaneItem(it) {
			continue
		}
		id := scopeString(it.Scope, "pane")
		row, ok := panes[id]
		if !ok || exited[id] || !tmux.IsShellCommand(row.Command) {
			continue
		}
		if (row.AgentState == "" || row.AgentPID == 0) && row.PanePID > 0 && !agentAliveFn(ctx, row.PanePID, row.AgentPID) {
			exited[id] = true
		}
	}
	return exited
}

// resolveBranches looks up the current git branch for each pane whose
// observed change has no branch_map entry yet and whose item names a repo. A
// failed or empty lookup (detached HEAD) is left out and retried next check.
func resolveBranches(ctx context.Context, st *State, panes map[string]paneRow) map[string]string {
	branches := map[string]string{}
	for _, it := range st.Tracked {
		if !livePaneItem(it) || scopeString(it.Scope, "repo") == "" {
			continue
		}
		row, ok := panes[scopeString(it.Scope, "pane")]
		if !ok || row.Change == "" || row.Cwd == "" {
			continue
		}
		if _, have := st.BranchMap[row.Change]; have {
			continue
		}
		if _, done := branches[row.Cwd]; done {
			continue
		}
		if b, err := gitBranchFn(ctx, row.Cwd); err == nil && b != "" {
			branches[row.Cwd] = b
		}
	}
	return branches
}

// paneVerdict is one pane item's diff outcome: event deltas (consumed by the
// baseline update made in the same write) and standing conditions.
type paneVerdict struct {
	events []CheckDelta
	conds  []condDelta
	// unobserved marks a pane item the phase-1 snapshot did not cover: it
	// was not diffed, so its stored pane conditions are neither reported nor
	// cleared this round.
	unobserved bool
}

// diffPane joins a pane item against the snapshot and applies the scope
// baselines in place. First match wins: pane_death, pane_mismatch,
// agent_exited, then a clean join (change, branch_map, completion, stage,
// agent state). An item with no pane or a persisted done_at is neither joined
// nor diffed, and one the snapshot was not taken for is reported unobserved.
func diffPane(it *TrackedItem, st *State, obs observation, now time.Time) paneVerdict {
	if !livePaneItem(*it) {
		return paneVerdict{}
	}
	paneID := scopeString(it.Scope, "pane")
	if obs.panes == nil || obs.paneFor[it.ID] != paneID {
		return paneVerdict{unobserved: true}
	}
	row, present := obs.panes[paneID]
	switch {
	case !present:
		return paneVerdict{conds: []condDelta{{condPaneDeath, CheckDelta{Kind: DeltaPaneDeath, ID: it.ID, Pane: paneID}}}}
	case paneMismatch(*it, row):
		return paneVerdict{conds: []condDelta{{condPaneMismatch, CheckDelta{
			Kind: DeltaPaneMismatch, ID: it.ID, Pane: paneID, Found: nullable(row.Change),
		}}}}
	case obs.exited[paneID]:
		return paneVerdict{conds: []condDelta{{condAgentExited, CheckDelta{
			Kind: DeltaAgentExited, ID: it.ID, Pane: paneID, Command: nullable(row.Command),
		}}}}
	}
	return joinPane(it, row, st, obs, now)
}

// paneMismatch is the recycled-pane case: tmux reuses %N across a server
// restart while the state file survives, so a recorded shell pid that differs
// from the pane's current one proves it is not the pane tracked. A null
// recorded pid, or an unknown current one, joins on the pane id alone.
func paneMismatch(it TrackedItem, row paneRow) bool {
	rec, ok := scopeInt(it.Scope, "pane_pid")
	return ok && rec != 0 && row.PanePID > 0 && row.PanePID != rec
}

func joinPane(it *TrackedItem, row paneRow, st *State, obs observation, now time.Time) paneVerdict {
	var v paneVerdict
	nowStr := now.Format(time.RFC3339)
	if d, ok := trackChange(it, row, nowStr); ok {
		v.events = append(v.events, d)
	}
	recordBranch(it, row, st, obs)
	if row.Stage != "" {
		completeBuiltIn(it, row, nowStr)
		if d, ok := trackStage(it, row, nowStr); ok {
			v.events = append(v.events, d)
		}
	}
	if c, ok := trackAgent(it, row, now); ok {
		v.conds = append(v.conds, c)
	}
	return v
}

// trackChange maintains scope.change from the snapshot's resolved change id.
// An unresolved observation never clears it (sticky); an appear or switch is
// an event consumed by the baseline update.
func trackChange(it *TrackedItem, row paneRow, nowStr string) (CheckDelta, bool) {
	baseline := scopeString(it.Scope, "change")
	if row.Change == "" || row.Change == baseline {
		return CheckDelta{}, false
	}
	var from interface{}
	if baseline != "" {
		from = baseline
	}
	it.Scope["change"] = row.Change
	it.UpdatedAt = nowStr
	return CheckDelta{
		Kind: DeltaChanged, ID: it.ID,
		Fields: map[string]FieldChange{"change": {From: from, To: row.Change}},
	}, true
}

// recordBranch writes branch_map for an observed change that has no entry,
// using the branch phase 1 resolved for the pane's cwd.
func recordBranch(it *TrackedItem, row paneRow, st *State, obs observation) {
	repo := scopeString(it.Scope, "repo")
	if row.Change == "" || repo == "" {
		return
	}
	if _, have := st.BranchMap[row.Change]; have {
		return
	}
	if branch := obs.branches[row.Cwd]; branch != "" {
		st.BranchMap[row.Change] = BranchMapEntry{Branch: branch, Repo: repo}
	}
}

func stageIndex(stage string) int {
	for i, s := range stageNames {
		if s == stage {
			return i
		}
	}
	return -1
}

func stageFinished(displayState string) bool {
	return displayState == "done" || displayState == "skipped"
}

// builtInCompleted is the pane completion predicate: a display-state check at
// a stage, never a stage diff (a change completing at its last stage keeps its
// stage string; only the display state flips). stop_stage null: at the
// terminus and finished. stop_stage set: past the stop in stage order, or at
// it and finished — a finished stop stage auto-activates the next, so equality
// alone would race the transition.
func builtInCompleted(stopStage, stage, displayState string) bool {
	if stopStage == "" {
		return stage == terminusStage && stageFinished(displayState)
	}
	oi, oStop := stageIndex(stage), stageIndex(stopStage)
	if oi < 0 || oStop < 0 {
		return false
	}
	return oi > oStop || (oi == oStop && stageFinished(displayState))
}

// completeBuiltIn persists done_at when the built-in completion fires, so the
// verdict survives the pane disappearing. It applies only to an item bound to
// a change; a change-less pane item never completes on its own.
func completeBuiltIn(it *TrackedItem, row paneRow, nowStr string) {
	if scopeString(it.Scope, "change") == "" || hasDoneAt(*it) {
		return
	}
	if builtInCompleted(scopeString(it.Scope, "stop_stage"), row.Stage, row.DisplayState) {
		it.DoneAt = &nowStr
		it.UpdatedAt = nowStr
	}
}

// trackStage diffs the resolved stage against scope.stage and consumes it.
// review → apply is the rework reset, reported as review_fail. A missing
// baseline diffs against nothing.
func trackStage(it *TrackedItem, row paneRow, nowStr string) (CheckDelta, bool) {
	baseline := scopeString(it.Scope, "stage")
	if baseline == "" || row.Stage == baseline {
		return CheckDelta{}, false
	}
	kind := DeltaStageAdvance
	if baseline == stageReview && row.Stage == stageApply {
		kind = DeltaReviewFail
	}
	from, to := baseline, row.Stage
	it.Scope["stage"] = to
	it.UpdatedAt = nowStr
	return CheckDelta{Kind: kind, ID: it.ID, Pane: scopeString(it.Scope, "pane"), From: &from, To: &to}, true
}

// trackAgent records the observed agent state in scope.agent (null when
// unknown) and reports waiting or idle as a standing condition; active and
// unknown only move the baseline.
func trackAgent(it *TrackedItem, row paneRow, now time.Time) (condDelta, bool) {
	prev := scopeString(it.Scope, "agent")
	it.Scope["agent"] = nil
	if row.AgentState != "" {
		it.Scope["agent"] = row.AgentState
	}
	var key string
	switch row.AgentState {
	case tmux.AgentStateWaiting:
		key = condAgentWaiting
	case tmux.AgentStateIdle:
		key = condAgentIdle
	default:
		return condDelta{}, false
	}
	var duration string
	if row.AgentEpoch > 0 {
		duration = tmux.FormatAgentDuration(now.Unix() - row.AgentEpoch)
	}
	to := row.AgentState
	return condDelta{key, CheckDelta{
		Kind: DeltaAgentState, ID: it.ID, Pane: row.PaneID,
		From: nullable(prev), To: &to, Duration: nullable(duration),
	}}, true
}

// scopeInt reads an integer scope value (JSON decodes numbers as float64,
// YAML as int); ok is false for absent, null, or non-numeric values.
func scopeInt(scope map[string]interface{}, key string) (int, bool) {
	switch v := scope[key].(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case uint64:
		return int(v), true
	case float64:
		return int(v), true
	}
	return 0, false
}
