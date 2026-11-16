package autopilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
)

const prViewFields = "number,url,state,isDraft,mergedAt,mergeable,headRefOid"

// MergeOptions are the merge verb's inputs.
type MergeOptions struct {
	// Repo limits the merge to one repo ("" = every repo).
	Repo    string
	RepoSet bool
}

// stallUnchanged is the number of polls with no change after which an armed PR
// with no failed check and a CONFLICTING mergeable state is read as stuck.
const stallUnchanged = 3

var errStackedMerge = errors.New("stacked-prs queues are not merged by this verb: follow the stacked-prs merge text in the run brief")

// isChainMode reports whether the mode builds a merge chain. stacked-prs does
// too, but only so StartMerge can recognise and refuse it.
func isChainMode(mode string) bool {
	return mode == operator.MergeModeCherryPickLadder || mode == operator.MergeModeStackedPRs
}

func isPRItem(it operator.TrackedItem) bool { return it.Kind == operator.KindGitHubPR }

func scopeBool(it operator.TrackedItem, key string) bool {
	b, _ := it.Scope[key].(bool)
	return b
}

func seqOf(it operator.TrackedItem) string { return operator.ScopeString(it.Scope, scopeMergeSeq) }

// seqID names a repo's merge sequence: its basename plus a short hash of the
// path, so two repos sharing a basename stay apart.
func seqID(repo string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(repo))
	return fmt.Sprintf("%s-%06x", filepath.Base(repo), h.Sum32()&0xffffff)
}

// StartMerge begins the ordered merge for completed cherry-pick-ladder queues:
// it creates the per-repo github-pr chains and advances each once (arming or
// merging the first PR). Later steps advance them. It refuses while queue
// items are not done and a stacked-prs queue outright, and does nothing for
// merge-auto. It runs under the pass lock.
func StartMerge(ctx context.Context, env Env, opts MergeOptions) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) { return startMerge(ctx, env, opts) })
}

func startMerge(ctx context.Context, env Env, opts MergeOptions) (result *StepResult, resultErr error) {
	e := newEngine(env)
	defer func() {
		if resultErr != nil {
			var invalid *InvalidError
			if !errors.As(resultErr, &invalid) {
				e.escalate("", "merge failed: "+resultErr.Error())
			}
		}
	}()
	st, err := e.load()
	if err != nil {
		return e.res, err
	}
	if opts.RepoSet && opts.Repo == "" {
		return e.res, operatorInvalid("--repo must not be empty")
	}
	repoFilter := cleanRepo(opts.Repo)
	if opts.Repo != "" {
		if err := e.validateRepo(ctx, opts.Repo); err != nil {
			return e.res, operatorInvalid("invalid --repo: %s", err)
		}
		matched := false
		for _, it := range st.Tracked {
			if isQueueItem(st, it) && cleanRepo(operator.ScopeString(it.Scope, "repo")) == repoFilter {
				matched = true
				break
			}
		}
		if !matched {
			return e.res, operatorInvalid("--repo %s does not match a queued repository", opts.Repo)
		}
	}
	var all []operator.TrackedItem
	started := map[string]bool{}
	for _, it := range st.Tracked {
		if !isQueueItem(st, it) || !isChainMode(modeOf(it)) || isBare(it) {
			continue
		}
		all = append(all, it)
		if repoFilter == "" || cleanRepo(operator.ScopeString(it.Scope, "repo")) == repoFilter {
			started[it.ID] = true
		}
	}
	if len(started) == 0 {
		return e.res, nil
	}
	// A started repo's PRs wait on the PRs of the repos it depends on, so those
	// get their items too (registered, not started) and must be done.
	queue := closureOf(all, started)
	for _, it := range queue {
		if modeOf(it) == operator.MergeModeStackedPRs {
			return e.res, errStackedMerge
		}
	}
	var pending []string
	for _, it := range queue {
		if !operator.ItemDone(it) {
			pending = append(pending, it.ID)
		}
	}
	if len(pending) > 0 {
		return e.res, fmt.Errorf("queue items not done yet: %s", strings.Join(pending, ", "))
	}
	items, err := e.buildPRChains(ctx, st, queue, started)
	if err != nil {
		return e.res, err
	}
	if err := e.startChains(started); err != nil {
		return e.res, fmt.Errorf("starting the registered sequences: %w", err)
	}
	if len(items) > 0 {
		if err := e.addPRItems(items); err != nil {
			return e.res, err
		}
		for _, it := range items {
			e.act(ActPRTracked, operator.ScopeString(it.Scope, scopeItem), it.ID)
		}
	}
	if env.DryRun {
		return e.res, nil
	}
	return e.res, e.advance(ctx)
}

// buildPRChains makes one github-pr item per queue item: base-first within a
// repo (depends_on the previous PR of the repo), and across repos behind the
// PRs of the item's cross-repo dependencies.
func (e *engine) buildPRChains(ctx context.Context, st *operator.State, queue []operator.TrackedItem, started map[string]bool) ([]operator.TrackedItem, error) {
	taken := map[string]bool{}
	for _, it := range st.Tracked {
		taken[it.ID] = true
	}
	prOf := map[string]string{}
	for _, it := range st.Tracked {
		if isPRItem(it) {
			if qi := operator.ScopeString(it.Scope, scopeItem); qi != "" {
				prOf[qi] = it.ID
			}
		}
	}
	lastInRepo := map[string]string{}
	var out []operator.TrackedItem
	for _, qi := range queue {
		repo := cleanRepo(operator.ScopeString(qi.Scope, "repo"))
		if id, ok := prOf[qi.ID]; ok {
			lastInRepo[repo] = id
			continue
		}
		branch := itemBranch(st, qi)
		if branch == "" {
			err := fmt.Errorf("%s has no branch to find its PR by", qi.ID)
			e.escalate(qi.ID, err.Error())
			return nil, err
		}
		v, err := e.viewPR(ctx, repo, branch, prViewFields)
		if err != nil {
			err = fmt.Errorf("%s: no PR for branch %s: %s", qi.ID, branch, stderrOf(err))
			e.escalate(qi.ID, err.Error())
			return nil, err
		}
		var deps []string
		if prev := lastInRepo[repo]; prev != "" {
			deps = append(deps, prev)
		}
		for _, d := range qi.DependsOn {
			di := operator.IndexOf(st.Tracked, d)
			if di >= 0 && cleanRepo(depRepo(st, st.Tracked[di])) != repo && prOf[d] != "" {
				deps = append(deps, prOf[d])
			}
		}
		it, err := e.newPRItem(ctx, qi, repo, branch, v, seqID(repo), deps, modeOf(qi), taken)
		if err != nil {
			e.escalate(qi.ID, err.Error())
			return nil, err
		}
		if !started[qi.ID] {
			it.Scope[scopeDeferred] = true
		}
		taken[it.ID] = true
		prOf[qi.ID] = it.ID
		lastInRepo[repo] = it.ID
		out = append(out, it)
	}
	return out, nil
}

// closureOf returns the queue items in ledger order that are started or that a
// started item transitively depends on.
func closureOf(all []operator.TrackedItem, started map[string]bool) []operator.TrackedItem {
	need := map[string]bool{}
	var visit func(id string)
	visit = func(id string) {
		if need[id] {
			return
		}
		need[id] = true
		for _, it := range all {
			if it.ID == id {
				for _, d := range it.DependsOn {
					visit(d)
				}
			}
		}
	}
	for id := range started {
		visit(id)
	}
	var out []operator.TrackedItem
	for _, it := range all {
		if need[it.ID] {
			out = append(out, it)
		}
	}
	return out
}

// startChains lifts the deferred mark from the PR items of started queue items,
// so a repo registered earlier as another repo's barrier begins when its own
// merge is started.
func (e *engine) startChains(started map[string]bool) error {
	return e.mutate(func(st *operator.State) error {
		changed := false
		for i := range st.Tracked {
			it := &st.Tracked[i]
			if isPRItem(*it) && scopeBool(*it, scopeDeferred) && started[operator.ScopeString(it.Scope, scopeItem)] {
				it.Scope[scopeDeferred] = false
				changed = true
			}
		}
		if !changed {
			return operator.ErrNoWrite
		}
		return nil
	})
}

// newPRItem builds the github-pr item for a queue item's PR. A PR that already
// merged is born done, so the chain behind it is not blocked.
func (e *engine) newPRItem(ctx context.Context, qi operator.TrackedItem, repo, branch string, v prView, seq string, deps []string, mode string, taken map[string]bool) (operator.TrackedItem, error) {
	id := fmt.Sprintf("pr-%d", v.Number)
	if taken[id] {
		// Repos sharing a basename and a PR number need a deterministic third
		// form: count up until the id is free.
		base := fmt.Sprintf("pr-%s-%d", filepath.Base(repo), v.Number)
		id = base
		for n := 2; taken[id]; n++ {
			id = fmt.Sprintf("%s-%d", base, n)
		}
	}
	scope := map[string]interface{}{
		"repo": repo, "pr": v.Number, "change": operator.ScopeString(qi.Scope, "change"),
		"branch": branch, scopeMergeSeq: seq, scopeItem: qi.ID, "merge_mode": mode, "url": v.URL,
	}
	nwo, err := e.nameWithOwner(ctx, repo)
	if err != nil {
		return operator.TrackedItem{}, err
	}
	it, err := operator.NewGitHubPRItem(id, deps, scope, nwo)
	if err != nil {
		return it, err
	}
	if strings.EqualFold(v.State, "MERGED") {
		now := operator.NowRFC3339()
		it.DoneAt = &now
	}
	return it, nil
}

// addPRItems appends the items in one locked write, skipping ids that appeared
// since the load.
func (e *engine) addPRItems(items []operator.TrackedItem) error {
	return e.mutate(func(st *operator.State) error {
		for _, it := range items {
			if i := operator.IndexOf(st.Tracked, it.ID); i >= 0 {
				// The same PR registered by a concurrent writer is fine; a
				// different item under this id would silently lose its sequence.
				if operator.ScopeString(st.Tracked[i].Scope, scopeItem) == operator.ScopeString(it.Scope, scopeItem) {
					continue
				}
				return fmt.Errorf("tracked item %s already exists for another item", it.ID)
			}
			st.Tracked = append(st.Tracked, it)
		}
		return nil
	})
}

// createMergeAutoPRs gives every shipped merge-auto queue item its one-PR
// sequence, so the next advance arms it.
func (e *engine) createMergeAutoPRs(ctx context.Context) error {
	st, err := e.load()
	if err != nil {
		return err
	}
	taken := map[string]bool{}
	hasPR := map[string]bool{}
	for _, it := range st.Tracked {
		taken[it.ID] = true
		if isPRItem(it) {
			hasPR[operator.ScopeString(it.Scope, scopeItem)] = true
		}
	}
	var out []operator.TrackedItem
	for _, qi := range st.Tracked {
		if !isQueueItem(st, qi) || modeOf(qi) != operator.MergeModeMergeAuto || isBare(qi) || !operator.ItemDone(qi) || hasPR[qi.ID] {
			continue
		}
		repo := cleanRepo(operator.ScopeString(qi.Scope, "repo"))
		branch := itemBranch(st, qi)
		if branch == "" {
			e.escalate(qi.ID, "cannot discover PR: no branch recorded")
			continue
		}
		v, err := e.viewPR(ctx, repo, branch, prViewFields)
		if err != nil {
			e.escalate(qi.ID, "cannot discover PR for branch "+branch+": "+stderrOf(err))
			continue
		}
		it, err := e.newPRItem(ctx, qi, repo, branch, v, "auto-"+qi.ID, nil, operator.MergeModeMergeAuto, taken)
		if err != nil {
			e.escalate(qi.ID, err.Error())
			continue
		}
		taken[it.ID] = true
		out = append(out, it)
	}
	if len(out) == 0 {
		return nil
	}
	if err := e.addPRItems(out); err != nil {
		e.escalate("", "PR items not written: "+err.Error())
		return err
	}
	for _, it := range out {
		e.act(ActPRTracked, operator.ScopeString(it.Scope, scopeItem), it.ID)
	}
	return nil
}

// advance is step phase (b) and (c): retry pending disarms, then for every
// merge sequence verify the head's merge, arm or merge the next PR, and detect
// a stall.
func (e *engine) advance(ctx context.Context) error {
	if err := e.createMergeAutoPRs(ctx); err != nil {
		return err
	}
	st, err := e.load()
	if err != nil {
		return err
	}
	e.retryDisarms(ctx, st)
	var seqs []string
	seen := map[string]bool{}
	for _, it := range st.Tracked {
		if s := seqOf(it); isPRItem(it) && s != "" && !seen[s] {
			seen[s] = true
			seqs = append(seqs, s)
		}
	}
	var unreviewed []string
	for _, s := range seqs {
		e.advanceSeq(ctx, s, &unreviewed)
	}
	if len(unreviewed) > 0 {
		e.res.Unreviewed = unreviewed
		e.reportf("merged without review: %s", strings.Join(unreviewed, ", "))
	}
	return nil
}

// retryDisarms re-issues the disarm of every halted PR that still carries its
// armed marker: the marker is cleared only by a confirmed disarm, so a failed
// one is retried on every pass until it is durable.
func (e *engine) retryDisarms(ctx context.Context, st *operator.State) {
	for _, it := range st.Tracked {
		if isPRItem(it) && scopeBool(it, scopeHalted) && scopeBool(it, scopeArmed) {
			_ = e.disarm(ctx, it)
		}
	}
}

// seqItems returns a sequence's github-pr items in ledger order.
func seqItems(st *operator.State, seq string) []operator.TrackedItem {
	var out []operator.TrackedItem
	for _, it := range st.Tracked {
		if isPRItem(it) && seqOf(it) == seq {
			out = append(out, it)
		}
	}
	return out
}

func (e *engine) advanceSeq(ctx context.Context, seq string, unreviewed *[]string) {
	for guard := 0; guard < 64; guard++ {
		st, err := e.load()
		if err != nil {
			return
		}
		items := seqItems(st, seq)
		pos, head := -1, operator.TrackedItem{}
		for i, it := range items {
			if !operator.ItemDone(it) {
				pos, head = i, it
				break
			}
		}
		if pos < 0 || scopeBool(head, scopeHalted) || scopeBool(head, scopeDeferred) || e.blockedByDeps(st, head) {
			return
		}
		if modeOf(head) == operator.MergeModeStackedPRs {
			e.escalate(head.ID, errStackedMerge.Error())
			return
		}
		repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
		n := prNum(head.Scope)
		if n == "" {
			e.escalate(head.ID, "scope.pr is not a PR number")
			return
		}
		v, err := e.viewPR(ctx, repo, n, prViewFields)
		if err != nil {
			e.escalate(head.ID, "gh pr view failed: "+stderrOf(err))
			return
		}
		if strings.EqualFold(v.State, "MERGED") {
			if !e.markMerged(ctx, head, v, pos+1, len(items), unreviewed) {
				return
			}
			continue
		}
		if err := e.observePR(head.ID, v); err != nil {
			return
		}
		if strings.EqualFold(v.State, "CLOSED") {
			e.haltCone(ctx, st, head, fmt.Sprintf("PR #%s was closed without merging", n))
			return
		}
		if e.env.DryRun {
			e.act(ActArmed, head.ID, "would advance PR #"+n)
			return
		}
		if merged := e.driveHead(ctx, head, v); merged {
			continue
		}
		return
	}
}

// blockedByDeps reports whether a PR item still waits on another PR item (the
// previous PR of its repo, or a cross-repo barrier).
func (e *engine) blockedByDeps(st *operator.State, it operator.TrackedItem) bool {
	for _, d := range it.DependsOn {
		i := operator.IndexOf(st.Tracked, d)
		if i >= 0 && !operator.ItemDone(st.Tracked[i]) {
			return true
		}
	}
	return false
}

// observePR stores the polled PR facts on the github-pr item, so `unchanged`
// counts polls with no change (the stall rule's clock).
func (e *engine) observePR(id string, v prView) error {
	if e.env.DryRun {
		return nil
	}
	var merged interface{}
	if v.MergedAt != "" {
		merged = v.MergedAt
	}
	err := operator.Observe(e.env.StatePath, operator.ObserveSpec{
		ID: id, Fields: map[string]interface{}{"state": v.State, "mergedAt": merged, "mergeable": v.Mergeable},
	})
	if err != nil {
		e.escalate(id, "PR observation not written: "+err.Error())
	}
	return err
}

// markMerged records a verified merge and reports it.
func (e *engine) markMerged(ctx context.Context, head operator.TrackedItem, v prView, pos, total int, unreviewed *[]string) bool {
	now := e.env.now().UTC().Format(time.RFC3339)
	if err := e.patch(head.ID, func(t *operator.TrackedItem) {
		t.DoneAt = &now
		t.Scope[scopeArmed] = false
	}); err != nil {
		e.escalate(head.ID, "merged completion not written: "+err.Error())
		return false
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	label := operator.ScopeString(head.Scope, scopeItem)
	if label == "" {
		label = head.ID
	}
	line := fmt.Sprintf("%s: merged (%s %d/%d)", label, filepath.Base(repo), pos, total)
	if reviews, err := e.viewPR(ctx, repo, prNum(head.Scope), "reviews"); err != nil {
		e.escalate(head.ID, "merged PR review lookup failed: "+stderrOf(err))
	} else if !hasReview(reviews.Reviews) {
		line += " · unreviewed"
		*unreviewed = append(*unreviewed, fmt.Sprintf("#%s (%s)", prNum(head.Scope), label))
	}
	e.reportf("%s", line)
	e.act(ActMerged, label, fmt.Sprintf("PR #%s", prNum(head.Scope)))
	return true
}

func hasReview(rs []reviewSummary) bool {
	for _, r := range rs {
		if !strings.EqualFold(r.State, "PENDING") {
			return true
		}
	}
	return false
}

// driveHead acts on the sequence's head PR and reports whether it merged
// during this call (so the caller verifies and moves to the next).
func (e *engine) driveHead(ctx context.Context, head operator.TrackedItem, v prView) bool {
	if scopeBool(head, scopeDirect) {
		return e.directMerge(ctx, head, v)
	}
	if !scopeBool(head, scopeArmed) {
		return e.arm(ctx, head, v)
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	runs, err := e.requiredChecks(ctx, repo, prNum(head.Scope))
	if err != nil {
		e.escalate(head.ID, "gh pr checks failed: "+stderrOf(err))
		return false
	}
	e.stall(head, v, runs)
	return false
}

// arm enables auto-merge on the head PR. The method flag is always explicit; a
// draft is readied first; the two repo-level rejections have their own shapes.
func (e *engine) arm(ctx context.Context, head operator.TrackedItem, v prView) bool {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	if !e.readyDraft(ctx, head, &v) {
		return false
	}
	// The marker is durable before GitHub is asked to arm: `stop` disarms only
	// the PRs that carry it, so an armed PR without one could merge unattended.
	if err := e.markArmed(head.ID, true); err != nil {
		e.escalate(head.ID, fmt.Sprintf("PR #%s was not armed: the armed marker could not be written: %s", n, err))
		return false
	}
	_, err := e.gh(ctx, repo, "pr", "merge", "--auto", "--squash", n)
	if alreadyApplied(err, "arm") {
		e.act(ActArmed, head.ID, "PR #"+n)
		return false
	}
	msg := strings.ToLower(stderrOf(err))
	if !definitiveArmRejection(msg) {
		e.escalate(head.ID, fmt.Sprintf("arm outcome uncertain for PR #%s: %s; marker retained so stop will disarm it", n, stderrOf(err)))
		return false
	}
	if cerr := e.markArmed(head.ID, false); cerr != nil {
		// Retain the durable marker until its clearing write succeeds.
		e.escalate(head.ID, fmt.Sprintf("arming PR #%s failed (%s) and the armed marker could not be cleared (%s): the marker stays so stop will disarm it", n, stderrOf(err), cerr))
		return false
	}
	switch {
	case strings.Contains(msg, "clean status"):
		// No required checks: auto-merge has nothing to wait for, so merge now.
		return e.mergeNow(ctx, head, n, repo)
	case strings.Contains(msg, "auto merge is not allowed"), strings.Contains(msg, "auto-merge is not allowed"):
		if err := e.setScope(head.ID, map[string]interface{}{scopeDirect: true}); err != nil {
			e.escalate(head.ID, "direct merge marker not written: "+err.Error())
			return false
		}
		e.escalate(head.ID, "auto-merge is disabled on this repo: merging step by step")
		return e.directMerge(ctx, head, v)
	}
	e.escalate(head.ID, fmt.Sprintf("arming PR #%s failed: %s", n, stderrOf(err)))
	return false
}

// Only these GitHub rejections prove the auto-merge request was not accepted.
// Transport and unknown errors must retain the marker for an idempotent stop.
func definitiveArmRejection(msg string) bool {
	for _, rejection := range []string{
		"auto merge is not allowed",
		"auto-merge is not allowed",
		"pull request is in clean status",
		"pull request is not in the correct state to enable auto-merge",
	} {
		if strings.Contains(msg, rejection) {
			return true
		}
	}
	return false
}

// markArmed requires a tracked item so stop can always find the marker.
func (e *engine) markArmed(id string, armed bool) error {
	if e.env.DryRun {
		return nil
	}
	return operator.Mutate(e.env.StatePath, func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return fmt.Errorf("item %s is no longer tracked", id)
		}
		st.Tracked[i].Scope[scopeArmed] = armed
		st.Tracked[i].UpdatedAt = operator.NowRFC3339()
		return nil
	})
}

// readyDraft marks a draft PR ready and reports whether the PR may proceed. A
// draft cannot be merged or armed: fab-created queue PRs open as drafts.
func (e *engine) readyDraft(ctx context.Context, head operator.TrackedItem, v *prView) bool {
	if !v.IsDraft {
		return true
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	if _, err := e.gh(ctx, repo, "pr", "ready", n); !alreadyApplied(err, "ready") {
		e.escalate(head.ID, fmt.Sprintf("cannot ready draft PR #%s: %s", n, stderrOf(err)))
		return false
	}
	v.IsDraft = false
	return true
}

func (e *engine) mergeNow(ctx context.Context, head operator.TrackedItem, n, repo string) bool {
	if _, err := e.gh(ctx, repo, "pr", "merge", "--squash", n); !alreadyApplied(err, "merge") {
		e.escalate(head.ID, fmt.Sprintf("merging PR #%s failed: %s", n, stderrOf(err)))
		return false
	}
	return true
}

// directMerge merges the head PR when its required checks are green and it is
// mergeable: the step-driven path for repos without auto-merge.
func (e *engine) directMerge(ctx context.Context, head operator.TrackedItem, v prView) bool {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	runs, err := e.requiredChecks(ctx, repo, n)
	if err != nil {
		e.escalate(head.ID, "gh pr checks failed: "+stderrOf(err))
		return false
	}
	if firstFailed(runs) != nil || checksPending(runs) || !strings.EqualFold(v.Mergeable, "MERGEABLE") {
		e.stall(head, v, runs)
		return false
	}
	if !e.readyDraft(ctx, head, &v) {
		return false
	}
	return e.mergeNow(ctx, head, n, repo)
}

// stall is the stall rule on a head PR: a failed required check, or no failed
// check after stallUnchanged quiet polls with the PR CONFLICTING, is reported
// once per head SHA and reason as a `recovery needed` escalation. The engine
// takes no action: the PR stays as it is, armed or not.
func (e *engine) stall(head operator.TrackedItem, v prView, runs []checkRun) {
	reason := ""
	if firstFailed(runs) != nil {
		reason = "ci-failed"
	} else if strings.EqualFold(v.Mergeable, "CONFLICTING") {
		fresh, err := e.load(head.ID)
		if err != nil {
			return
		}
		i := operator.IndexOf(fresh.Tracked, head.ID)
		if i < 0 {
			return // removed by an external writer: it wins
		}
		if fresh.Tracked[i].Unchanged >= stallUnchanged {
			reason = "conflicting"
		}
	}
	if reason == "" {
		return
	}
	seen := reason + "@" + v.HeadRefOid
	if operator.ScopeString(head.Scope, scopeStallSeen) == seen {
		return
	}
	if err := e.setScope(head.ID, map[string]interface{}{scopeStallSeen: seen}); err != nil {
		e.escalate(head.ID, "stall marker not written: "+err.Error())
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	e.escalate(head.ID, fmt.Sprintf("recovery needed: %s — PR #%s (%s)", reason, prNum(head.Scope), filepath.Base(repo)))
}

type checkRun struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Link  string `json:"link"`
}

// requiredChecks lists the PR's required checks. `gh pr checks` signals failing
// or pending checks through its exit status while still printing the JSON, and
// prints no JSON at all when nothing is required.
func (e *engine) requiredChecks(ctx context.Context, repo, n string) ([]checkRun, error) {
	out, err := e.gh(ctx, repo, "pr", "checks", n, "--required", "--json", "name,state,link")
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

// haltCone stops the failing sequence and everything downstream of it, and
// disarms only those PRs: the failing repo's sub-sequence plus every repo whose
// PR items transitively carry a cross-repo depends_on into it. Independent
// sub-sequences keep going. A disarm that fails leaves the armed marker for
// retryDisarms.
func (e *engine) haltCone(ctx context.Context, st *operator.State, failing operator.TrackedItem, reason string) {
	cone := map[string]bool{seqOf(failing): true}
	for grew := true; grew; {
		grew = false
		for _, it := range st.Tracked {
			if !isPRItem(it) || cone[seqOf(it)] {
				continue
			}
			for _, d := range it.DependsOn {
				if di := operator.IndexOf(st.Tracked, d); di >= 0 && cone[seqOf(st.Tracked[di])] {
					cone[seqOf(it)] = true
					grew = true
					break
				}
			}
		}
	}
	var targets []operator.TrackedItem
	if err := e.mutate(func(fresh *operator.State) error {
		for i := range fresh.Tracked {
			it := &fresh.Tracked[i]
			if !isPRItem(*it) || !cone[seqOf(*it)] {
				continue
			}
			if !operator.ItemDone(*it) {
				it.Scope[scopeHalted] = true
			}
			if scopeBool(*it, scopeArmed) {
				targets = append(targets, *it)
			}
		}
		return nil
	}); err != nil {
		e.escalate(failing.ID, "halt marker not written: "+err.Error()+"; "+reason)
		return
	}
	e.escalate(failing.ID, "halted: "+reason)
	for _, it := range targets {
		_ = e.disarm(ctx, it)
	}
}

// disarm turns auto-merge off on one PR and clears its armed marker. A PR that
// already merged or closed cannot auto-merge any more, so that counts as
// disarmed. Any other failure keeps the marker: the PR may still merge.
func (e *engine) disarm(ctx context.Context, it operator.TrackedItem) error {
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	n := prNum(it.Scope)
	if e.env.DryRun {
		e.act(ActDisarmed, it.ID, "would disarm PR #"+n)
		return nil
	}
	if _, err := e.gh(ctx, repo, "pr", "merge", "--disable-auto", n); !alreadyApplied(err, "disarm") && !e.prFinished(ctx, repo, n) {
		e.escalate(it.ID, fmt.Sprintf("disarming PR #%s failed — it may still merge: %s", n, stderrOf(err)))
		return err
	}
	if err := e.setScope(it.ID, map[string]interface{}{scopeArmed: false}); err != nil {
		e.escalate(it.ID, "disarmed marker not written: "+err.Error())
		return err
	}
	e.act(ActDisarmed, it.ID, "PR #"+n)
	return nil
}

// prFinished reports whether the PR is merged or closed.
func (e *engine) prFinished(ctx context.Context, repo, n string) bool {
	v, err := e.viewPR(ctx, repo, n, "state")
	return err == nil && (strings.EqualFold(v.State, "MERGED") || strings.EqualFold(v.State, "CLOSED"))
}
