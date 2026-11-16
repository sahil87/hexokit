package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"rk/internal/operator"
)

type restackSpec struct {
	target           target
	branch           string
	defaultBranch    string
	upstream         string
	observedHead     string
	predecessorMerge string
}

// restack retargets a stacked PR and replays only its own commits onto the
// default branch. The detached worktree and explicit lease keep the authoring
// worktree and a concurrently pushed head untouched.
func (e *engine) restack(ctx context.Context, d Decision) error {
	st, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	pf := e.facts.pr[d.Item]
	if pf == nil || !pf.read || pf.view.HeadRefOid == "" {
		e.escalate(it.ID, "restack refused: PR head was not observed")
		return nil
	}
	pred, ok := inSeqPredecessor(st, it)
	if !ok {
		e.escalate(it.ID, "restack refused: no in-sequence predecessor")
		return nil
	}
	branch, ok := e.checkedBranch(it.ID, operator.ScopeString(it.Scope, "branch"), "current")
	if !ok {
		return nil
	}
	if _, ok := e.checkedBranch(it.ID, operator.ScopeString(pred.Scope, "branch"), "predecessor"); !ok {
		return nil
	}
	if pf.armed() {
		before := e.disarmErr
		e.disarm(ctx, it)
		if e.disarmErr != before {
			return nil
		}
	}
	spec, ok := e.prepareRestack(ctx, it, pred, pf, branch)
	if !ok {
		return nil
	}
	wt, ok := e.restackWorktree(ctx, spec, it.ID)
	if !ok {
		return nil
	}
	defer e.cleanupRestack(ctx, spec.target.repo, wt, it.ID)
	if _, err := e.git(ctx, wt, "rebase", "--onto", "origin/"+spec.defaultBranch, spec.upstream); err != nil {
		if ctx.Err() != nil {
			e.interruptRestack(ctx, wt, spec, it.ID)
		} else {
			e.haltRestack(ctx, d, wt, spec, err)
		}
		return nil
	}
	if !e.rebasedContainsPredecessor(ctx, wt, spec, it.ID) {
		return nil
	}
	lease := "--force-with-lease=refs/heads/" + spec.branch + ":" + spec.observedHead
	if _, err := e.git(ctx, wt, "push", lease, "origin", "HEAD:refs/heads/"+spec.branch); err != nil {
		e.escalate(it.ID, "push after rebase failed: "+stderrOf(err))
		return nil
	}
	e.act(ActRebased, it.ID, fmt.Sprintf("%s onto %s", spec.branch, spec.defaultBranch))
	return nil
}

func (e *engine) prepareRestack(ctx context.Context, it, pred operator.TrackedItem, pf *prFacts, branch string) (restackSpec, bool) {
	spec := restackSpec{branch: branch, observedHead: pf.view.HeadRefOid, predecessorMerge: pf.predMerge}
	t, ok := e.target(it)
	if !ok {
		return spec, false
	}
	spec.target = t
	if _, err := e.git(ctx, t.repo, "fetch", "origin"); err != nil {
		e.escalate(it.ID, "git fetch failed: "+stderrOf(err))
		return spec, false
	}
	spec.defaultBranch = e.defaultBranch(ctx, t.repo, it.ID)
	if !e.metaFor(t.repo).defaultBranchKnown {
		e.escalate(it.ID, "default branch unavailable; restack retried next pass")
		return spec, false
	}
	remote, err := e.git(ctx, t.repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+branch)
	if err != nil || remote != spec.observedHead {
		e.escalate(it.ID, fmt.Sprintf("PR #%s head moved since observe; restack retried next pass", t.n))
		return spec, false
	}
	upstream, ok := e.restackUpstream(ctx, it.ID, t, pred, spec.observedHead, spec.defaultBranch)
	if !ok {
		return spec, false
	}
	spec.upstream = upstream
	if pf.view.BaseRefName != spec.defaultBranch {
		if err := e.retarget(ctx, t.repo, t.nwo, t.n, spec.defaultBranch); err != nil {
			e.escalate(it.ID, fmt.Sprintf("retargeting PR #%s onto %s failed: %s", t.n, spec.defaultBranch, stderrOf(err)))
			return spec, false
		}
		e.act(ActRetargeted, it.ID, fmt.Sprintf("PR #%s → %s", t.n, spec.defaultBranch))
	}
	return spec, true
}

func (e *engine) restackUpstream(ctx context.Context, id string, t target, pred operator.TrackedItem, head, defaultBranch string) (string, bool) {
	predN := prNum(pred.Scope)
	if predN == "" {
		e.escalate(id, "predecessor scope.pr is not a PR number; restack refused")
		return "", false
	}
	predView, err := e.viewPR(ctx, t.repo, t.nwo, predN, "headRefOid")
	if err != nil || !validCommit(predView.HeadRefOid) {
		e.escalate(id, fmt.Sprintf("cannot find predecessor head %s for PR #%s", predView.HeadRefOid, t.n))
		return "", false
	}
	mb, err := e.git(ctx, t.repo, "merge-base", predView.HeadRefOid, head)
	if err != nil || !validCommit(mb) {
		e.escalate(id, fmt.Sprintf("cannot find predecessor head %s for PR #%s", predView.HeadRefOid, t.n))
		return "", false
	}
	cherry, err := e.git(ctx, t.repo, "cherry", predView.HeadRefOid, head, mb)
	if err != nil {
		e.escalate(id, "git cherry failed: "+stderrOf(err))
		return "", false
	}
	var candidates []string
	for _, line := range strings.Split(cherry, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "-" && validCommit(fields[1]) {
			candidates = append([]string{fields[1]}, candidates...)
		}
	}
	candidates = append(candidates, mb)
	defaultTree, _ := e.git(ctx, t.repo, "rev-parse", "origin/"+defaultBranch+"^{tree}")
	for _, candidate := range candidates {
		if e.dropIsNoOp(ctx, t.repo, defaultBranch, candidate, defaultTree) {
			return candidate, true
		}
	}
	return mb, true
}

// dropIsNoOp reports whether merging candidate into the default branch leaves
// its tree unchanged, so everything dropped by the rebase is already there.
func (e *engine) dropIsNoOp(ctx context.Context, repo, defaultBranch, candidate, defaultTree string) bool {
	out, err := e.git(ctx, repo, "merge-tree", "--write-tree", "origin/"+defaultBranch, candidate)
	if err != nil || defaultTree == "" {
		return false
	}
	first, _, _ := strings.Cut(strings.TrimSpace(out), "\n")
	return first == defaultTree
}

func validCommit(s string) bool {
	if len(s) != 40 {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return false
		}
	}
	return true
}

func (e *engine) restackWorktree(ctx context.Context, spec restackSpec, id string) (string, bool) {
	wt, err := os.MkdirTemp("", "rk-autopilot-restack-")
	if err != nil {
		e.escalate(id, "temporary restack worktree failed: "+err.Error())
		return "", false
	}
	if _, err := e.git(ctx, spec.target.repo, "worktree", "add", "--detach", wt, spec.observedHead); err != nil {
		e.escalate(id, "temporary restack worktree failed: "+stderrOf(err))
		_ = os.Remove(wt)
		return "", false
	}
	return wt, true
}

func (e *engine) rebasedContainsPredecessor(ctx context.Context, wt string, spec restackSpec, id string) bool {
	_, err := e.git(ctx, wt, "merge-base", "--is-ancestor", spec.predecessorMerge, "HEAD")
	if err == nil {
		return true
	}
	if exitCode(err, 1) {
		e.escalate(id, fmt.Sprintf("predecessor merge commit %s is not on %s; PR #%s not pushed",
			spec.predecessorMerge, spec.defaultBranch, spec.target.n))
	} else {
		e.escalate(id, "predecessor ancestry check failed: "+stderrOf(err))
	}
	return false
}

func (e *engine) interruptRestack(ctx context.Context, wt string, spec restackSpec, id string) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), gitTimeout)
	defer cancel()
	if _, err := e.git(cleanupCtx, wt, "rebase", "--abort"); !alreadyApplied(err, "rebase-abort") {
		e.escalate(id, "git rebase --abort failed: "+stderrOf(err))
	}
	e.escalate(id, fmt.Sprintf("restack of PR #%s interrupted: %s; retried next pass", spec.target.n, ctx.Err()))
}

func (e *engine) cleanupRestack(ctx context.Context, repo, wt, id string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), gitTimeout)
	defer cancel()
	if _, err := e.git(ctx, repo, "worktree", "remove", "--force", wt); err != nil {
		e.escalate(id, "temporary worktree removal failed: "+stderrOf(err))
	}
	if _, err := e.git(ctx, repo, "worktree", "prune"); err != nil {
		e.escalate(id, "temporary worktree prune failed: "+stderrOf(err))
	}
	if err := os.Remove(wt); err != nil && !os.IsNotExist(err) {
		e.escalate(id, "temporary worktree directory removal failed: "+err.Error())
	}
}

func (e *engine) haltRestack(ctx context.Context, d Decision, wt string, spec restackSpec, rebaseErr error) {
	files := e.conflictFiles(ctx, wt, d.Item)
	if _, err := e.git(ctx, wt, "rebase", "--abort"); !alreadyApplied(err, "rebase-abort") {
		e.escalate(d.Item, "git rebase --abort failed: "+stderrOf(err))
	}
	reason := fmt.Sprintf("halted: rebase of %s onto %s failed%s (cleanup attempted, not skipped): %s",
		spec.branch, spec.defaultBranch, files, stderrOf(rebaseErr))
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.Scope[scopeHalted] = true }); err != nil {
		if errors.Is(err, errItemChanged) {
			e.writeFailed(d.Item, d.pr, "", err)
		} else {
			e.escalate(d.Item, "halt marker not written: "+err.Error()+"; "+reason)
		}
		return
	}
	e.escalate(d.Item, reason)
}

// retarget verifies gh's base postcondition when an edit reports no change.
func (e *engine) retarget(ctx context.Context, repo, nwo, n, base string) error {
	_, err := e.gh(ctx, repo, withRepo(nwo, "pr", "edit", n, "--base", base)...)
	if err == nil {
		return nil
	}
	msg := strings.ToLower(stderrOf(err))
	if strings.Contains(msg, "already") || strings.Contains(msg, "base branch was not changed") {
		view, viewErr := e.viewPR(ctx, repo, nwo, n, "baseRefName")
		if viewErr != nil {
			return errors.Join(err, viewErr)
		}
		if view.BaseRefName == base {
			return nil
		}
	}
	return err
}
