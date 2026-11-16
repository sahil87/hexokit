package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
)

// Derived queue-item states, in precedence order.
const (
	StateDone    = "done"
	StatePaused  = "paused"
	StateHeld    = "held"
	StatePending = "pending"
	StateSpawned = "spawned"
)

// derivedState is the item's state from stored facts alone, consistent with
// `rk operator track list`: done › paused › held › pending › spawned. The
// precedence is strict: an unsatisfied dependency holds an item that already has
// a pane.
func derivedState(st *operator.State, it operator.TrackedItem) string {
	switch {
	case operator.ItemDone(it):
		return StateDone
	case it.Paused:
		return StatePaused
	}
	if storedHeldBy(st, it) != "" {
		return StateHeld
	}
	if operator.ScopeString(it.Scope, "pane") == "" {
		return StatePending
	}
	return StateSpawned
}

// storedHeldBy returns the first dependency the stored state does not satisfy
// ("" when none). It reads no PR: the live gate in step adds those checks.
func storedHeldBy(st *operator.State, it operator.TrackedItem) string {
	for _, dep := range it.DependsOn {
		di := operator.IndexOf(st.Tracked, dep)
		if di < 0 {
			if _, ok := st.BranchMap[dep]; ok {
				continue
			}
			return dep
		}
		d := st.Tracked[di]
		if !operator.ItemDone(d) {
			return dep
		}
		if mergeAutoBarrier(st, it, d) && !prMerged(st, d.ID) {
			return dep
		}
	}
	return ""
}

// mergeAutoBarrier reports whether dep is a merge-auto queue item the
// dependent must wait on until its PR merge is verified.
func mergeAutoBarrier(st *operator.State, it, dep operator.TrackedItem) bool {
	return isQueueItem(st, it) && isQueueItem(st, dep) && modeOf(it) == operator.MergeModeMergeAuto && modeOf(dep) == operator.MergeModeMergeAuto
}

// prMerged reports whether the github-pr item created for queue item id is
// done (a verified merge).
func prMerged(st *operator.State, id string) bool {
	for _, p := range st.Tracked {
		if p.Kind == operator.KindGitHubPR && operator.ScopeString(p.Scope, scopeItem) == id {
			return operator.ItemDone(p)
		}
	}
	return false
}

func fabPresent(repo string) (bool, error) {
	fi, err := os.Stat(filepath.Join(repo, "fab"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("cannot inspect fab directory: %w", err)
	}
	return fi.IsDir(), nil
}

// isPlainAgent reports whether the item is a change-less plain-agent item: a
// task in a repo with no fab/, which has no pipeline to finish and is done when
// its PR is ready.
func isPlainAgent(st *operator.State, it operator.TrackedItem) (bool, error) {
	if !isQueueItem(st, it) || operator.ScopeString(it.Scope, scopeTask) == "" || operator.ScopeString(it.Scope, "change") != "" {
		return false, nil
	}
	fab, err := fabPresent(operator.ScopeString(it.Scope, "repo"))
	return !fab, err
}

// prView is the subset of `gh pr view` the engine reads.
type prView struct {
	Number      int             `json:"number"`
	URL         string          `json:"url"`
	State       string          `json:"state"`
	IsDraft     bool            `json:"isDraft"`
	MergedAt    string          `json:"mergedAt"`
	Mergeable   string          `json:"mergeable"`
	HeadRefOid  string          `json:"headRefOid"`
	BaseRefName string          `json:"baseRefName"`
	Reviews     []reviewSummary `json:"reviews"`
}

type reviewSummary struct {
	State string `json:"state"`
}

// viewPR runs `gh pr view <ref> --json <fields>` in the repo.
func (e *engine) viewPR(ctx context.Context, repo, ref, fields string) (prView, error) {
	out, err := e.gh(ctx, repo, "pr", "view", ref, "--json", fields)
	if err != nil {
		return prView{}, err
	}
	var v prView
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return prView{}, fmt.Errorf("gh pr view %s: %w", ref, err)
	}
	return v, nil
}

// observeDone is step phase (a): persist done_at for items whose completion is
// observable now. A fab item completes when its pane's change reaches the
// terminus (or its stop_stage); a plain-agent item when its branch has a merged
// PR or an open one with passing checks.
func (e *engine) observeDone(ctx context.Context) error {
	st, err := e.load()
	if err != nil {
		return err
	}
	panes, perr := e.env.Panes.Snapshot(ctx)
	if perr != nil {
		e.escalate("", "completion pane snapshot failed: "+perr.Error())
		return perr
	}
	now := e.env.now().UTC().Format(time.RFC3339)
	for _, it := range st.Tracked {
		if !isQueueItem(st, it) || operator.ItemDone(it) || operator.ScopeString(it.Scope, "pane") == "" {
			continue
		}
		done := false
		if row, ok := panes[operator.ScopeString(it.Scope, "pane")]; ok && row.Change != "" && row.Stage != "" {
			done = operator.BuiltInCompleted(operator.ScopeString(it.Scope, "stop_stage"), row.Stage, row.DisplayState)
		}
		if !done {
			plain, err := isPlainAgent(st, it)
			if err != nil {
				e.escalate(it.ID, err.Error())
				continue
			}
			if plain {
				done = e.plainAgentDone(ctx, st, it)
			}
		}
		if done {
			if err := e.patch(it.ID, func(t *operator.TrackedItem) { t.DoneAt = &now }); err != nil {
				e.escalate(it.ID, "completion marker not written: "+err.Error())
				return err
			}
			e.act(ActDone, it.ID, "completion observed")
		}
	}
	return nil
}

// plainAgentDone reads the agent's branch PR: merged, or open with green
// checks.
func (e *engine) plainAgentDone(ctx context.Context, st *operator.State, it operator.TrackedItem) bool {
	branch := itemBranch(st, it)
	if branch == "" {
		e.escalate(it.ID, "cannot observe completion: no branch recorded")
		return false
	}
	v, err := e.viewPR(ctx, operator.ScopeString(it.Scope, "repo"), branch, "url,state")
	if err != nil {
		e.escalate(it.ID, "completion PR lookup failed: "+stderrOf(err))
		return false
	}
	switch strings.ToUpper(v.State) {
	case "MERGED":
		return true
	case "OPEN":
		runs, err := e.requiredChecks(ctx, operator.ScopeString(it.Scope, "repo"), branch)
		if err != nil {
			e.escalate(it.ID, "completion checks lookup failed: "+stderrOf(err))
			return false
		}
		return !checksPending(runs)
	}
	return false
}

// gate evaluates the live readiness of a pending item: every dependency done,
// plus an existing PR for a same-repo dependency with no stop_stage. why names
// the first unmet dependency.
func (e *engine) gate(ctx context.Context, st *operator.State, it operator.TrackedItem) (ok bool, why string) {
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	for _, dep := range it.DependsOn {
		di := operator.IndexOf(st.Tracked, dep)
		if di < 0 {
			if _, ok := st.BranchMap[dep]; ok {
				continue
			}
			return false, dep
		}
		d := st.Tracked[di]
		if !operator.ItemDone(d) {
			return false, dep
		}
		if mergeAutoBarrier(st, it, d) {
			if !prMerged(st, d.ID) {
				return false, dep
			}
			continue
		}
		if cleanRepo(depRepo(st, d)) != repo || operator.ScopeString(d.Scope, "stop_stage") != "" {
			continue
		}
		branch := depBranch(st, d)
		if branch == "" {
			e.escalate(it.ID, "dependency "+dep+" has no branch recorded")
			return false, dep
		}
		if _, err := e.viewPR(ctx, repo, branch, "url"); err != nil {
			e.escalate(it.ID, "dependency "+dep+" PR lookup failed: "+stderrOf(err))
			return false, dep + " (no PR yet)"
		}
	}
	return true, ""
}
