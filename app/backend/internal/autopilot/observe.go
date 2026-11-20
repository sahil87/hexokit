package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"rk/internal/operator"
)

// observe is the first stage of a pass. It loads the ledger, takes one pane
// snapshot and reads external facts only for items that can act: queue items'
// completion and dependency PRs. One fact read per item per pass.
func (e *engine) observe(ctx context.Context) (*operator.State, *facts, error) {
	st, err := e.load()
	if err != nil {
		return nil, nil, err
	}
	f := newFacts()
	ledger, err := operator.Load(e.env.StatePath)
	if err != nil {
		return nil, nil, err
	}
	for _, it := range ledger.Tracked {
		f.projection[it.ID] = true
	}
	panes, perr := e.env.Panes.Snapshot(ctx)
	switch {
	case perr == nil:
		f.panes = panes
	case e.readOnly:
		f.panesKnown = false
	default:
		e.escalate("", "completion pane snapshot failed: "+perr.Error())
		return st, f, perr
	}
	e.observeCompletion(ctx, st, f)
	e.observeReadiness(ctx, st, f)
	return st, f, nil
}

// observeCompletion records, for every unfinished queue item with a pane,
// whether its completion is observable now: a fab item when its pane's change
// reaches the terminus (or its stop_stage), a plain-agent item when its branch
// has a merged PR or an open one whose required checks are not pending.
func (e *engine) observeCompletion(ctx context.Context, st *operator.State, f *facts) {
	for _, it := range st.Tracked {
		pane := operator.ScopeString(it.Scope, "pane")
		if !legacyQueueItem(st, it) || operator.ItemDone(it) || pane == "" {
			continue
		}
		q := f.queueFor(it.ID)
		if row, ok := f.panes[pane]; ok && row.Change != "" && row.Stage != "" {
			q.completed = operator.BuiltInCompleted(operator.ScopeString(it.Scope, "stop_stage"), row.Stage, row.DisplayState)
		}
		if q.completed {
			continue
		}
		plain, err := isPlainAgent(st, it)
		if err != nil {
			e.escalate(it.ID, err.Error())
			continue
		}
		if plain {
			q.completed = e.plainAgentDone(ctx, st, it)
		}
	}
}

// observeReadiness looks up the PR of each dependency that the readiness gate
// needs (a same-repo dependency's existence, a merge-auto barrier's merge), for
// every unfinished, unpaused queue item.
func (e *engine) observeReadiness(ctx context.Context, st *operator.State, f *facts) {
	for _, it := range st.Tracked {
		if !legacyQueueItem(st, it) || len(it.DependsOn) == 0 || itemDone(st, f, it) || it.Paused || skipped(it) {
			continue
		}
		q := f.queueFor(it.ID)
		repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
		unmetDep(st, f, it,
			func(d operator.TrackedItem, branch string) bool {
				ok := e.depPRExists(ctx, it, d, repo, branch)
				q.depPR[d.ID] = ok
				return ok
			},
			func(d operator.TrackedItem, branch string) bool {
				ok := e.depMerged(ctx, it, d, cleanRepo(depRepo(st, d)), branch)
				q.depMerged[d.ID] = ok
				return ok
			})
	}
}

type checkRun struct {
	State string `json:"state"`
}

// requiredChecks lists the PR's required checks. `gh pr checks` signals failing
// or pending checks through its exit status while still printing the JSON, and
// prints no JSON at all when nothing is required.
func (e *engine) requiredChecks(ctx context.Context, repo, n string) ([]checkRun, error) {
	out, err := e.gh(ctx, repo, "pr", "checks", n, "--required", "--json", "state")
	var runs []checkRun
	if jerr := json.Unmarshal([]byte(out), &runs); jerr == nil {
		return runs, nil
	}
	if err != nil && strings.Contains(strings.ToLower(stderrOf(err)), "no required checks") {
		return nil, nil
	}
	if err == nil {
		return nil, fmt.Errorf("unreadable gh pr checks output")
	}
	return nil, err
}

func checksPending(runs []checkRun) bool {
	for _, r := range runs {
		if !strings.EqualFold(r.State, "SUCCESS") && !strings.EqualFold(r.State, "SKIPPED") && !strings.EqualFold(r.State, "NEUTRAL") {
			return true
		}
	}
	return false
}
