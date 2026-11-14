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
// `rk operator track list`: done › paused › held › pending › spawned.
func derivedState(st *operator.State, it operator.TrackedItem) string {
	switch {
	case operator.ItemDone(it):
		return StateDone
	case it.Paused:
		return StatePaused
	}
	if operator.ScopeString(it.Scope, "pane") != "" {
		return StateSpawned
	}
	if storedHeldBy(st, it) != "" {
		return StateHeld
	}
	return StatePending
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
	return isQueueItem(it) && isQueueItem(dep) && modeOf(it) == operator.MergeModeMergeAuto && modeOf(dep) == operator.MergeModeMergeAuto
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

func fabPresent(repo string) bool {
	fi, err := os.Stat(filepath.Join(repo, "fab"))
	return err == nil && fi.IsDir()
}

// isPlainAgent reports whether the item is a change-less plain-agent item: a
// task in a repo with no fab/, which has no pipeline to finish and is done when
// its PR is ready.
func isPlainAgent(it operator.TrackedItem) bool {
	return isQueueItem(it) && operator.ScopeString(it.Scope, scopeTask) != "" &&
		operator.ScopeString(it.Scope, "change") == "" && !fabPresent(operator.ScopeString(it.Scope, "repo"))
}

// prView is the subset of `gh pr view` the engine reads.
type prView struct {
	Number            int             `json:"number"`
	URL               string          `json:"url"`
	State             string          `json:"state"`
	IsDraft           bool            `json:"isDraft"`
	MergedAt          string          `json:"mergedAt"`
	Mergeable         string          `json:"mergeable"`
	HeadRefOid        string          `json:"headRefOid"`
	BaseRefName       string          `json:"baseRefName"`
	StatusCheckRollup []checkRollup   `json:"statusCheckRollup"`
	Reviews           []reviewSummary `json:"reviews"`
}

type checkRollup struct {
	Conclusion string `json:"conclusion"`
	Status     string `json:"status"`
	State      string `json:"state"`
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

// checksPassing reports whether every rolled-up check finished green. An empty
// rollup means nothing is required.
func checksPassing(rollup []checkRollup) bool {
	for _, c := range rollup {
		switch {
		case c.Conclusion != "":
			switch strings.ToUpper(c.Conclusion) {
			case "SUCCESS", "NEUTRAL", "SKIPPED":
			default:
				return false
			}
		case c.State != "":
			if strings.ToUpper(c.State) != "SUCCESS" {
				return false
			}
		default:
			return false
		}
	}
	return true
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
		panes = nil
	}
	now := e.env.now().UTC().Format(time.RFC3339)
	for _, it := range st.Tracked {
		if !isQueueItem(it) || operator.ItemDone(it) || operator.ScopeString(it.Scope, "pane") == "" {
			continue
		}
		done := false
		if row, ok := panes[operator.ScopeString(it.Scope, "pane")]; ok && row.Change != "" && row.Stage != "" {
			done = operator.BuiltInCompleted(operator.ScopeString(it.Scope, "stop_stage"), row.Stage, row.DisplayState)
		}
		if !done && isPlainAgent(it) {
			done = e.plainAgentDone(ctx, st, it)
		}
		if done {
			e.act(ActDone, it.ID, "completion observed")
			if err := e.patch(it.ID, func(t *operator.TrackedItem) { t.DoneAt = &now }); err != nil {
				return err
			}
		}
	}
	return nil
}

// plainAgentDone reads the agent's branch PR: merged, or open with green
// checks.
func (e *engine) plainAgentDone(ctx context.Context, st *operator.State, it operator.TrackedItem) bool {
	branch := itemBranch(st, it)
	if branch == "" {
		return false
	}
	v, err := e.viewPR(ctx, operator.ScopeString(it.Scope, "repo"), branch, "url,state,statusCheckRollup")
	if err != nil {
		return false
	}
	switch strings.ToUpper(v.State) {
	case "MERGED":
		return true
	case "OPEN":
		return checksPassing(v.StatusCheckRollup)
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
			return false, dep
		}
		if _, err := e.viewPR(ctx, repo, branch, "url"); err != nil {
			return false, dep + " (no PR yet)"
		}
	}
	return true, ""
}
