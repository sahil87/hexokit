package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"rk/internal/operator"
)

// mergeAutoBarrier reports whether dep is a merge-auto queue item the
// dependent must wait on until its PR merge is verified.
func mergeAutoBarrier(st *operator.State, it, dep operator.TrackedItem) bool {
	return operator.IsQueueItem(st, it) && operator.IsQueueItem(st, dep) && modeOf(it) == operator.MergeModeMergeAuto && modeOf(dep) == operator.MergeModeMergeAuto
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
	if !operator.IsQueueItem(st, it) || operator.ScopeString(it.Scope, scopeTask) == "" || operator.ScopeString(it.Scope, "change") != "" {
		return false, nil
	}
	fab, err := fabPresent(operator.ScopeString(it.Scope, "repo"))
	return !fab, err
}

// prView is the subset of `gh pr view` the engine reads.
type prView struct {
	Number     int    `json:"number"`
	URL        string `json:"url"`
	State      string `json:"state"`
	IsDraft    bool   `json:"isDraft"`
	MergedAt   string `json:"mergedAt"`
	Mergeable  string `json:"mergeable"`
	HeadRefOid string `json:"headRefOid"`
	// AutoMergeRequest is non-nil exactly when auto-merge is armed.
	AutoMergeRequest *struct{}       `json:"autoMergeRequest"`
	Reviews          []reviewSummary `json:"reviews"`
}

type reviewSummary struct {
	State string `json:"state"`
}

// viewPR runs `gh pr view <ref> --json <fields>` in the repo. A non-empty nwo
// pins the PR's repository (`--repo`) instead of leaving it to the checkout.
func (e *engine) viewPR(ctx context.Context, repo, nwo, ref, fields string) (prView, error) {
	out, err := e.gh(ctx, repo, withRepo(nwo, "pr", "view", ref, "--json", fields)...)
	if err != nil {
		return prView{}, err
	}
	var v prView
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return prView{}, fmt.Errorf("gh pr view %s: %w", ref, err)
	}
	return v, nil
}

// plainAgentDone reads the agent's branch PR: merged, or open with required
// checks not pending.
func (e *engine) plainAgentDone(ctx context.Context, st *operator.State, it operator.TrackedItem) bool {
	branch := itemBranch(st, it)
	if branch == "" {
		e.escalate(it.ID, "cannot observe completion: no branch recorded")
		return false
	}
	v, err := e.viewPR(ctx, operator.ScopeString(it.Scope, "repo"), "", branch, "url,state")
	if err != nil {
		if !e.readOnly || !noPRFound(err) {
			e.escalate(it.ID, "completion PR lookup failed: "+stderrOf(err))
		}
		return false
	}
	switch strings.ToUpper(v.State) {
	case "MERGED":
		return true
	case "OPEN":
		runs, err := e.requiredChecks(ctx, operator.ScopeString(it.Scope, "repo"), "", branch)
		if err != nil {
			e.escalate(it.ID, "completion checks lookup failed: "+stderrOf(err))
			return false
		}
		return !checksPending(runs)
	}
	return false
}

// depPRExists reports whether a same-repo dependency's branch has a PR. A
// branch with no PR is a normal held item; any other failure is escalated.
func (e *engine) depPRExists(ctx context.Context, it, dep operator.TrackedItem, repo, branch string) bool {
	if branch == "" {
		e.escalate(it.ID, "dependency "+dep.ID+" has no branch recorded")
		return false
	}
	if _, err := e.viewPR(ctx, repo, "", branch, "url"); err != nil {
		if !e.readOnly || !noPRFound(err) {
			e.escalate(it.ID, "dependency "+dep.ID+" PR lookup failed: "+stderrOf(err))
		}
		return false
	}
	return true
}

// noPRFound reports gh's answer for a branch that has no PR yet: a normal
// state of an unfinished item, not a failure, in the read-only status view.
func noPRFound(err error) bool {
	return strings.Contains(strings.ToLower(stderrOf(err)), "no pull requests found")
}
