package autopilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"rk/internal/operator"
)

// prViewFields is the one `gh pr view` field list: the status inputs plus
// autoMergeRequest, which is how armed is derived.
const prViewFields = "number,url,state,isDraft,mergedAt,mergeable,headRefOid,autoMergeRequest"

// stallUnchanged is the number of polls with no change after which a PR with
// no failed check and a CONFLICTING mergeable state is read as stuck.
const stallUnchanged = 3

// observe is the first stage of a pass. It loads the ledger, takes one pane
// snapshot and reads external facts only for items that can act: queue items'
// completion and dependency PRs, each merge sequence's head, and every
// not-done PR item of a halted cone (so an armed one can be disarmed). One
// fact read per item per pass. The returned ledger is the decision snapshot:
// it is reloaded after the head observations are written, because the stall
// clock (`unchanged`) lives in that write.
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
	if e.observePRs(ctx, st, f) {
		if st, err = e.load(); err != nil {
			return nil, nil, err
		}
	}
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

// observeReadiness looks up the PR of each same-repo dependency that the
// readiness gate needs, for every unfinished, unpaused queue item.
func (e *engine) observeReadiness(ctx context.Context, st *operator.State, f *facts) {
	for _, it := range st.Tracked {
		if !legacyQueueItem(st, it) || len(it.DependsOn) == 0 || itemDone(st, f, it) || it.Paused || skipped(it) {
			continue
		}
		q := f.queueFor(it.ID)
		repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
		unmetDep(st, f, it, func(d operator.TrackedItem, branch string) bool {
			ok := e.depPRExists(ctx, it, d, repo, branch)
			q.depPR[d.ID] = ok
			return ok
		})
	}
}

func isSeqPR(it operator.TrackedItem) bool { return isPRItem(it) && seqOf(it) != "" }

// observePRs reads the PR facts of every merge sequence's head and of every
// not-done PR item in a halted cone, and reports whether any head observation
// was written to the ledger.
func (e *engine) observePRs(ctx context.Context, st *operator.State, f *facts) (wrote bool) {
	heads := map[string]string{}
	for _, it := range st.Tracked {
		if isSeqPR(it) && !operator.ItemDone(it) {
			if _, ok := heads[seqOf(it)]; !ok {
				heads[seqOf(it)] = it.ID
			}
		}
	}
	for _, it := range st.Tracked {
		if !isSeqPR(it) || operator.ItemDone(it) {
			continue
		}
		cone := haltedCone(st, nil, it)
		head := heads[seqOf(it)] == it.ID
		if !cone && !(head && !scopeBool(it, scopeDeferred) && !blockedByDeps(st, it)) {
			continue
		}
		if e.observePR(ctx, st, f, it, head && !cone, cone) {
			wrote = true
		}
	}
	return wrote
}

// observePR reads one PR item's facts. A head outside a halted cone also has
// its polled state stored (the `unchanged` clock the conflicting status
// needs). It reports whether it wrote that observation. A halted item whose
// armed state cannot be read is kept in coneErr: stop reports that it cannot
// promise the disarm.
func (e *engine) observePR(ctx context.Context, st *operator.State, f *facts, it operator.TrackedItem, poll, cone bool) (wrote bool) {
	unreadable := func() {
		if cone {
			e.coneErr = errors.Join(e.coneErr, fmt.Errorf("%s: cannot tell whether the halted PR is armed", it.ID))
		}
	}
	n := prNum(it.Scope)
	if n == "" {
		e.escalate(it.ID, "scope.pr is not a PR number")
		unreadable()
		return false
	}
	nwo, ok := e.pin(it)
	if !ok {
		unreadable()
		return false
	}
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	pf := &prFacts{}
	f.pr[it.ID] = pf
	v, err := e.viewPR(ctx, repo, nwo, n, prViewFields)
	if err != nil {
		e.escalate(it.ID, "gh pr view failed: "+stderrOf(err))
		unreadable()
		return false
	}
	pf.view, pf.read = v, true
	if strings.EqualFold(v.State, "MERGED") {
		return false
	}
	if poll {
		if err := e.observePRWrite(it, v); err != nil {
			pf.read = false
			return false
		}
		wrote = !e.env.DryRun
	}
	if _, settled := prPrecheck(st, f, it); settled {
		return wrote
	}
	runs, err := e.requiredChecks(ctx, repo, nwo, n)
	if err != nil {
		e.escalate(it.ID, "gh pr checks failed: "+stderrOf(err))
		return wrote
	}
	pf.checks, pf.checksRead = runs, true
	if derivePR(st, f, it) == PRWaiting && !pf.armed() && modeOf(it) != operator.MergeModeStackedPRs {
		e.observeAutoMerge(ctx, f, it, repo, nwo)
	}
	return wrote
}

// observePRWrite stores the polled PR facts on the github-pr item, so
// `unchanged` counts polls with no change. Under --dry-run nothing is written.
func (e *engine) observePRWrite(it operator.TrackedItem, v prView) error {
	if e.env.DryRun {
		return nil
	}
	var merged interface{}
	if v.MergedAt != "" {
		merged = v.MergedAt
	}
	want := identityOf(it)
	engine, err := loadEngineFile(e.env.StatePath)
	if err != nil {
		return err
	}
	current, ok := engine.find(it.ID)
	if !ok || identityOf(current.tracked()) != want {
		err = errItemChanged
		e.writeFailed(it.ID, true, "PR observation not written", err)
		return err
	}
	if _, present, projectionErr := e.projection(it.ID); projectionErr != nil {
		return projectionErr
	} else if !present {
		return nil
	}
	err = operator.Observe(e.env.StatePath, operator.ObserveSpec{
		ID: it.ID, Fields: map[string]interface{}{"state": v.State, "mergedAt": merged, "mergeable": v.Mergeable},
		Guard: func(cur operator.TrackedItem) error {
			if identityOf(cur) != want {
				return errItemChanged
			}
			return nil
		},
	})
	if err != nil {
		e.writeFailed(it.ID, true, "PR observation not written", err)
	}
	return err
}

// observeAutoMerge reads whether the repo allows auto-merge, once per repo per
// pass. A repo that cannot be read stays absent from the facts, which derives
// as "not allowed": the PR waits.
func (e *engine) observeAutoMerge(ctx context.Context, f *facts, it operator.TrackedItem, repo, nwo string) {
	if _, read := f.autoMerge[nwo]; read || e.autoMergeFailed[nwo] {
		return
	}
	out, err := e.gh(ctx, repo, "repo", "view", nwo, "--json", "autoMergeAllowed")
	var v struct {
		AutoMergeAllowed *bool `json:"autoMergeAllowed"`
	}
	if err == nil {
		if jerr := json.Unmarshal([]byte(out), &v); jerr != nil || v.AutoMergeAllowed == nil {
			err = fmt.Errorf("unreadable gh repo view output")
		}
	}
	if err != nil {
		e.autoMergeFailed[nwo] = true
		e.escalate(it.ID, "repo auto-merge lookup failed: "+stderrOf(err))
		return
	}
	f.autoMerge[nwo] = *v.AutoMergeAllowed
}

type checkRun struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Link  string `json:"link"`
}

// requiredChecks lists the PR's required checks. `gh pr checks` signals failing
// or pending checks through its exit status while still printing the JSON, and
// prints no JSON at all when nothing is required.
func (e *engine) requiredChecks(ctx context.Context, repo, nwo, n string) ([]checkRun, error) {
	out, err := e.gh(ctx, repo, withRepo(nwo, "pr", "checks", n, "--required", "--json", "name,state,link")...)
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

func firstFailed(runs []checkRun) *checkRun {
	for i := range runs {
		if strings.EqualFold(runs[i].State, "FAILURE") {
			return &runs[i]
		}
	}
	return nil
}

func checksPending(runs []checkRun) bool {
	for _, r := range runs {
		if !strings.EqualFold(r.State, "SUCCESS") && !strings.EqualFold(r.State, "SKIPPED") && !strings.EqualFold(r.State, "NEUTRAL") {
			return true
		}
	}
	return false
}
