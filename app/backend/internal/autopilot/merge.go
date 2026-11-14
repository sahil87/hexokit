package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
)

const prViewFields = "number,url,state,isDraft,mergedAt,mergeable,headRefOid,baseRefName"

// MergeOptions are the merge verb's inputs.
type MergeOptions struct {
	// Repo limits the merge to one repo ("" = every repo).
	Repo string
}

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

// StartMerge begins the ordered merge for completed cherry-pick-ladder and
// stacked-prs queues: it creates the per-repo github-pr chains and advances
// each once (arming or merging the first PR). Later steps advance them. It
// refuses while queue items are not done, and does nothing for merge-auto.
func StartMerge(ctx context.Context, env Env, opts MergeOptions) (*StepResult, error) {
	e := newEngine(env)
	st, err := e.load()
	if err != nil {
		return e.res, err
	}
	repoFilter := cleanRepo(opts.Repo)
	var queue []operator.TrackedItem
	var pending []string
	for _, it := range st.Tracked {
		if !isQueueItem(it) || !isChainMode(modeOf(it)) || isBare(it) {
			continue
		}
		if repoFilter != "" && cleanRepo(operator.ScopeString(it.Scope, "repo")) != repoFilter {
			continue
		}
		queue = append(queue, it)
		if !operator.ItemDone(it) {
			pending = append(pending, it.ID)
		}
	}
	if len(queue) == 0 {
		return e.res, nil
	}
	if len(pending) > 0 {
		return e.res, fmt.Errorf("queue items not done yet: %s", strings.Join(pending, ", "))
	}
	items, err := e.buildPRChains(ctx, st, queue)
	if err != nil {
		return e.res, err
	}
	if len(items) > 0 {
		for _, it := range items {
			e.act(ActPRTracked, operator.ScopeString(it.Scope, scopeItem), it.ID)
		}
		if err := e.addPRItems(items); err != nil {
			return e.res, err
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
func (e *engine) buildPRChains(ctx context.Context, st *operator.State, queue []operator.TrackedItem) ([]operator.TrackedItem, error) {
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
			return nil, fmt.Errorf("%s has no branch to find its PR by", qi.ID)
		}
		v, err := e.viewPR(ctx, repo, branch, prViewFields)
		if err != nil {
			return nil, fmt.Errorf("%s: no PR for branch %s: %s", qi.ID, branch, stderrOf(err))
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
			return nil, err
		}
		taken[it.ID] = true
		prOf[qi.ID] = it.ID
		lastInRepo[repo] = it.ID
		out = append(out, it)
	}
	return out, nil
}

// newPRItem builds the github-pr item for a queue item's PR. A PR that already
// merged is born done, so the chain behind it is not blocked.
func (e *engine) newPRItem(ctx context.Context, qi operator.TrackedItem, repo, branch string, v prView, seq string, deps []string, mode string, taken map[string]bool) (operator.TrackedItem, error) {
	id := fmt.Sprintf("pr-%d", v.Number)
	if taken[id] {
		id = fmt.Sprintf("pr-%s-%d", filepath.Base(repo), v.Number)
	}
	scope := map[string]interface{}{
		"repo": repo, "pr": v.Number, "change": operator.ScopeString(qi.Scope, "change"),
		"branch": branch, scopeMergeSeq: seq, scopeItem: qi.ID, "merge_mode": mode, "url": v.URL,
	}
	it, err := operator.NewGitHubPRItem(id, deps, scope, e.nameWithOwner(ctx, repo))
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
			if operator.IndexOf(st.Tracked, it.ID) >= 0 {
				continue
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
		if !isQueueItem(qi) || modeOf(qi) != operator.MergeModeMergeAuto || isBare(qi) || !operator.ItemDone(qi) || hasPR[qi.ID] {
			continue
		}
		repo := cleanRepo(operator.ScopeString(qi.Scope, "repo"))
		branch := itemBranch(st, qi)
		if branch == "" {
			continue
		}
		v, err := e.viewPR(ctx, repo, branch, prViewFields)
		if err != nil {
			continue
		}
		it, err := e.newPRItem(ctx, qi, repo, branch, v, "auto-"+qi.ID, nil, operator.MergeModeMergeAuto, taken)
		if err != nil {
			e.escalate(qi.ID, err.Error())
			continue
		}
		taken[it.ID] = true
		out = append(out, it)
		e.act(ActPRTracked, qi.ID, it.ID)
	}
	if len(out) == 0 {
		return nil
	}
	return e.addPRItems(out)
}

// advance is step phase (b) and (c): for every merge sequence, verify the
// head's merge, then arm or merge the next PR, then detect a stall.
func (e *engine) advance(ctx context.Context) error {
	if err := e.createMergeAutoPRs(ctx); err != nil {
		return err
	}
	st, err := e.load()
	if err != nil {
		return err
	}
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
		e.reportf("merged without review: %s", strings.Join(unreviewed, ", "))
	}
	return nil
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
		if pos < 0 || scopeBool(head, scopeHalted) || e.blockedByDeps(st, head) {
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
			_ = e.note(head.ID, "gh pr view failed: "+stderrOf(err))
			return
		}
		e.observePR(head.ID, v)
		if strings.EqualFold(v.State, "MERGED") {
			e.markMerged(ctx, head, v, pos+1, len(items), unreviewed)
			continue
		}
		if strings.EqualFold(v.State, "CLOSED") {
			e.haltCone(ctx, st, head, fmt.Sprintf("PR #%s was closed without merging", n))
			return
		}
		if e.env.DryRun {
			e.act(ActArmed, head.ID, "would advance PR #"+n)
			return
		}
		if merged := e.driveHead(ctx, st, items, pos, head, v); merged {
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
func (e *engine) observePR(id string, v prView) {
	if e.env.DryRun {
		return
	}
	var merged interface{}
	if v.MergedAt != "" {
		merged = v.MergedAt
	}
	_ = operator.Observe(e.env.StatePath, operator.ObserveSpec{
		ID: id, Fields: map[string]interface{}{"state": v.State, "mergedAt": merged, "mergeable": v.Mergeable},
	})
}

// markMerged records a verified merge and reports it.
func (e *engine) markMerged(ctx context.Context, head operator.TrackedItem, v prView, pos, total int, unreviewed *[]string) {
	now := e.env.now().UTC().Format(time.RFC3339)
	_ = e.patch(head.ID, func(t *operator.TrackedItem) {
		t.DoneAt = &now
		t.Scope[scopeArmed] = false
	})
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	label := operator.ScopeString(head.Scope, scopeItem)
	if label == "" {
		label = head.ID
	}
	line := fmt.Sprintf("%s: merged (%s %d/%d)", label, filepath.Base(repo), pos, total)
	if reviews, err := e.viewPR(ctx, repo, prNum(head.Scope), "reviews"); err == nil && !hasReview(reviews.Reviews) {
		line += " · unreviewed"
		*unreviewed = append(*unreviewed, fmt.Sprintf("#%s (%s)", prNum(head.Scope), label))
	}
	if operator.ScopeString(head.Scope, scopeRecovery) == "ci-fix" {
		line += " · after CI fix round"
	}
	e.reportf("%s", line)
	e.act(ActMerged, label, fmt.Sprintf("PR #%s", prNum(head.Scope)))
}

func hasReview(rs []reviewSummary) bool {
	for _, r := range rs {
		if !strings.EqualFold(r.State, "PENDING") {
			return true
		}
	}
	return false
}

// driveHead acts on the sequence's head PR by mode and reports whether it
// merged during this call (so the caller verifies and moves to the next).
func (e *engine) driveHead(ctx context.Context, st *operator.State, items []operator.TrackedItem, pos int, head operator.TrackedItem, v prView) bool {
	mode := modeOf(head)
	if mode == operator.MergeModeStackedPRs {
		if pos > 0 && !scopeBool(head, scopeHalted) && !scopeBool(head, scopePrepared) {
			if !e.prepareStacked(ctx, st, items[pos-1], head, v) {
				return false
			}
		}
		return e.stackedStep(ctx, st, head, v)
	}
	if scopeBool(head, scopeDirect) {
		return e.directMerge(ctx, st, head, v)
	}
	if !scopeBool(head, scopeArmed) {
		return e.arm(ctx, st, head, v)
	}
	e.stall(ctx, st, head, v)
	return false
}

// arm enables auto-merge on the head PR. The method flag is always explicit; a
// draft is readied first; the two repo-level rejections have their own shapes.
func (e *engine) arm(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView) bool {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	if v.IsDraft {
		if _, err := e.gh(ctx, repo, "pr", "ready", n); err != nil {
			e.escalate(head.ID, fmt.Sprintf("cannot ready draft PR #%s: %s", n, stderrOf(err)))
			return false
		}
	}
	_, err := e.gh(ctx, repo, "pr", "merge", "--auto", "--squash", n)
	if err == nil {
		_ = e.setScope(head.ID, map[string]interface{}{scopeArmed: true})
		e.act(ActArmed, head.ID, "PR #"+n)
		return false
	}
	msg := strings.ToLower(stderrOf(err))
	switch {
	case strings.Contains(msg, "clean status"):
		// No required checks: auto-merge has nothing to wait for, so merge now.
		return e.mergeNow(ctx, head, n, repo)
	case strings.Contains(msg, "auto merge is not allowed"), strings.Contains(msg, "auto-merge is not allowed"):
		_ = e.setScope(head.ID, map[string]interface{}{scopeDirect: true})
		_ = e.note(head.ID, "auto-merge is disabled on this repo: merging step by step")
		return e.directMerge(ctx, st, head, v)
	case strings.Contains(msg, "already enabled"), strings.Contains(msg, "already has auto"):
		_ = e.setScope(head.ID, map[string]interface{}{scopeArmed: true})
		return false
	}
	e.escalate(head.ID, fmt.Sprintf("arming PR #%s failed: %s", n, stderrOf(err)))
	return false
}

func (e *engine) mergeNow(ctx context.Context, head operator.TrackedItem, n, repo string) bool {
	if _, err := e.gh(ctx, repo, "pr", "merge", "--squash", n); err != nil {
		e.escalate(head.ID, fmt.Sprintf("merging PR #%s failed: %s", n, stderrOf(err)))
		return false
	}
	return true
}

// directMerge merges the head PR when its required checks are green and it is
// mergeable: the step-driven path for stacked-prs and for repos without
// auto-merge.
func (e *engine) directMerge(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView) bool {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	runs, err := e.requiredChecks(ctx, repo, n)
	if err != nil {
		_ = e.note(head.ID, "gh pr checks failed: "+stderrOf(err))
		return false
	}
	if f := firstFailed(runs); f != nil {
		e.ciFailed(ctx, st, head, v, *f)
		return false
	}
	if checksPending(runs) || !strings.EqualFold(v.Mergeable, "MERGEABLE") {
		return false
	}
	return e.mergeNow(ctx, head, n, repo)
}

// stackedStep never arms: an armed stacked PR can merge into its dependency's
// branch, or fire on stale-green checks after a retarget.
func (e *engine) stackedStep(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView) bool {
	return e.directMerge(ctx, st, head, v)
}

// prepareStacked reports whether the PR is ready to merge-check: it retargets the next PR onto the default branch (GitHub does it
// itself when the merged base branch was deleted) and rebases its branch onto
// the new default tip, replaying only its own commits. A conflict halts and
// escalates; it never skips.
func (e *engine) prepareStacked(ctx context.Context, st *operator.State, prev, head operator.TrackedItem, v prView) bool {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	branch := safeBranch(operator.ScopeString(head.Scope, "branch"))
	prevBranch := safeBranch(operator.ScopeString(prev.Scope, "branch"))
	if _, err := e.git(ctx, repo, "fetch", "origin"); err != nil {
		e.escalate(head.ID, "git fetch failed: "+stderrOf(err))
		return false
	}
	def := e.defaultBranch(ctx, repo)
	if v.BaseRefName != def {
		if _, err := e.gh(ctx, repo, "pr", "edit", n, "--base", def); err != nil {
			e.escalate(head.ID, fmt.Sprintf("retargeting PR #%s onto %s failed: %s", n, def, stderrOf(err)))
			return false
		}
		e.act(ActRetargeted, head.ID, fmt.Sprintf("PR #%s → %s", n, def))
	}
	wt, cleanup, err := e.worktreeFor(ctx, repo, branch)
	if err != nil {
		e.escalate(head.ID, "no worktree to rebase in: "+err.Error())
		return false
	}
	defer cleanup()
	upstream := prevBranch
	if ref, ok := e.resolveRef(ctx, repo, prevBranch); ok {
		upstream = ref
	}
	if _, err := e.git(ctx, wt, "rebase", "--onto", "origin/"+def, upstream, branch); err != nil {
		files := e.conflictFiles(ctx, wt)
		_, _ = e.git(ctx, wt, "rebase", "--abort")
		e.haltCone(ctx, st, head, fmt.Sprintf("rebase of %s onto %s conflicted%s (aborted, not skipped)", branch, def, files))
		return false
	}
	if _, err := e.git(ctx, wt, "push", "--force-with-lease", "origin", branch); err != nil {
		e.escalate(head.ID, "push after rebase failed: "+stderrOf(err))
		return false
	}
	_ = e.setScope(head.ID, map[string]interface{}{scopePrepared: true})
	e.act(ActRebased, head.ID, fmt.Sprintf("%s onto %s", branch, def))
	return true
}

// conflictFiles names the unmerged paths of a stopped rebase or cherry-pick.
func (e *engine) conflictFiles(ctx context.Context, dir string) string {
	out, err := e.git(ctx, dir, "diff", "--name-only", "--diff-filter=U")
	if err != nil || out == "" {
		return ""
	}
	return ": " + strings.Join(strings.Fields(out), ", ")
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
// sub-sequences keep going.
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
	for _, it := range st.Tracked {
		if !isPRItem(it) || !cone[seqOf(it)] || operator.ItemDone(it) {
			continue
		}
		if scopeBool(it, scopeArmed) {
			e.disarm(ctx, it)
		}
		_ = e.setScope(it.ID, map[string]interface{}{scopeHalted: true})
	}
	e.escalate(failing.ID, "halted: "+reason)
}

// disarm turns auto-merge off on one PR.
func (e *engine) disarm(ctx context.Context, it operator.TrackedItem) {
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	n := prNum(it.Scope)
	if e.env.DryRun {
		e.act(ActDisarmed, it.ID, "would disarm PR #"+n)
		return
	}
	if _, err := e.gh(ctx, repo, "pr", "merge", "--disable-auto", n); err != nil {
		e.escalate(it.ID, fmt.Sprintf("disarming PR #%s failed — it may still merge: %s", n, stderrOf(err)))
		return
	}
	_ = e.setScope(it.ID, map[string]interface{}{scopeArmed: false})
	e.act(ActDisarmed, it.ID, "PR #"+n)
}
