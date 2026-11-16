package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"rk/internal/operator"
)

var shardRe = regexp.MustCompile(`(\d+)/(\d+)`)

// fixRequest is the one sanctioned raw send into a fab-project agent. It amends
// an existing change, so it carries no skill prefix.
func (e *engine) fixRequest(ctx context.Context, head operator.TrackedItem, repo string, failed checkRun) string {
	label, err := e.nameWithOwner(ctx, repo)
	if err != nil {
		e.escalate(head.ID, "CI fix repo lookup failed: "+stderrOf(err))
	}
	if label == "" {
		label = repo
	}
	shard := ""
	if m := shardRe.FindStringSubmatch(failed.Name); m != nil {
		shard = fmt.Sprintf(", shard %s/%s", m[1], m[2])
	}
	return fmt.Sprintf("CI failed on PR #%s (%s): check `%s` — run %s%s.\nDiagnose and fix on this branch, push, and report the root cause in one line.",
		prNum(head.Scope), label, failed.Name, failed.Link, shard)
}

func addRecovery(rounds []string, kind string) []string {
	for _, round := range rounds {
		if round == kind {
			return append([]string{}, rounds...)
		}
	}
	return append(append([]string{}, rounds...), kind)
}

func recoveryFailure(e *engine, d Decision) (*prFacts, *checkRun, bool) {
	pf := e.facts.pr[d.Item]
	if pf == nil || pf.view.HeadRefOid == "" {
		e.escalate(d.Item, "CI fix request refused: the PR head commit was not observed")
		return nil, nil, false
	}
	failed := firstFailed(pf.checks)
	if failed == nil {
		e.escalate(d.Item, "CI fix request refused: no failed required check was observed")
		return nil, nil, false
	}
	return pf, failed, true
}

// requestFix spends the round before sending. Busy delivery restores the exact
// prior fields; any other error may have delivered, so the round stays spent.
func (e *engine) requestFix(ctx context.Context, d Decision) error {
	st, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	if e.env.DryRun {
		return nil
	}
	pf, failed, ok := recoveryFailure(e, d)
	if !ok {
		return nil
	}
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	text := e.fixRequest(ctx, it, repo, *failed)
	pane, idle, known := authoringPane(st, e.facts, it)
	if !known || pane == "" || !idle {
		return nil
	}
	oldRounds := recoveryValues(it.Scope[scopeRecovery])
	oldHead := operator.ScopeString(it.Scope, scopeFixHead)
	oldAt := operator.ScopeString(it.Scope, scopeRecoverAt)
	stamp := e.env.now().UTC().Format(time.RFC3339)
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) {
		t.Scope[scopeRecovery] = addRecovery(recoveryValues(t.Scope[scopeRecovery]), recoveryCIFix)
		t.Scope[scopeFixHead] = pf.view.HeadRefOid
		t.Scope[scopeRecoverAt] = stamp
	}); err != nil {
		e.writeFailed(d.Item, d.pr, "CI fix recovery marker not written", err)
		return nil
	}
	err := e.env.Panes.Send(ctx, pane, text)
	switch {
	case errors.Is(err, ErrPaneBusy):
		if rollbackErr := e.mutateEngine(func(st *engineState) error {
			item, found := st.find(d.Item)
			if !found {
				return fmt.Errorf("item %s is no longer in the engine state", d.Item)
			}
			item.Recovery, item.FixHead, item.RecoveryAt = oldRounds, oldHead, oldAt
			item.UpdatedAt = operator.NowRFC3339()
			return nil
		}); rollbackErr != nil {
			e.escalate(d.Item, "CI fix busy rollback failed: "+rollbackErr.Error())
		}
	case err != nil:
		e.escalate(d.Item, "CI fix request delivery uncertain: "+err.Error())
	default:
		e.act(ActRecoverySent, d.Item, fmt.Sprintf("check %s → pane %s", failed.Name, pane))
	}
	return nil
}

// recoverySpawn writes the parent and fix item in one engine-file write before
// looking up a session or opening a window. Failures never relaunch implicitly.
func (e *engine) recoverySpawn(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	if e.env.DryRun {
		return nil
	}
	pf, failed, ok := recoveryFailure(e, d)
	if !ok {
		return nil
	}
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	branch, valid := e.checkedBranch(it.ID, operator.ScopeString(it.Scope, "branch"), "recovery")
	if !valid {
		return nil
	}
	name := operator.ScopeString(it.Scope, "change")
	if name == "" {
		name = operator.ScopeString(it.Scope, scopeItem)
	}
	fixID := name + "-fix"
	if !itemIDRe.MatchString(fixID) {
		e.escalate(it.ID, "no authoring pane and no valid recovery branch/item")
		return nil
	}
	text := e.fixRequest(ctx, it, repo, *failed)
	stamp := e.env.now().UTC().Format(time.RFC3339)
	err := e.mutateEngine(func(st *engineState) error {
		view, _, err := engineView(e.env.StatePath)
		if err != nil {
			return err
		}
		i := operator.IndexOf(view.Tracked, d.Item)
		if i < 0 || fingerprint(view.Tracked[i]) != d.fp {
			return errItemChanged
		}
		if st.has(fixID) {
			return fmt.Errorf("recovery item %s already exists", fixID)
		}
		parent, found := st.find(d.Item)
		if !found {
			return fmt.Errorf("item %s is no longer in the engine state", d.Item)
		}
		parent.Recovery = addRecovery(parent.Recovery, recoveryCIFix)
		parent.FixHead, parent.RecoveryAt, parent.FixItem = pf.view.HeadRefOid, stamp, fixID
		parent.UpdatedAt = operator.NowRFC3339()
		st.upsertFix(engineItem{
			ID: fixID, Repo: repo, Branch: branch, Change: name,
			Spawning: stamp, AddedAt: stamp, UpdatedAt: stamp, SpawnedBy: operator.ByRun,
		})
		return nil
	})
	if err != nil {
		e.writeFailed(d.Item, d.pr, "CI fix recovery spawn marker not written", err)
		return nil
	}
	session, err := e.env.Session(ctx, repo)
	if err != nil {
		e.escalate(d.Item, "no landing session: "+err.Error())
		return nil
	}
	wt, err := e.worktreeForBranch(ctx, repo, branch)
	if err != nil {
		e.escalate(d.Item, err.Error())
		return nil
	}
	view, err := e.load(fixID)
	if err != nil {
		return nil
	}
	i := operator.IndexOf(view.Tracked, fixID)
	if i < 0 {
		e.escalate(d.Item, "recovery item vanished before launch")
		return nil
	}
	fix := view.Tracked[i]
	req := SpawnRequest{
		Repo: repo, Session: session, WorktreeName: fixID, CheckoutBranch: branch,
		ExistingWorktree: wt, Prompt: text, Note: fixID + " · CI fix",
	}
	e.launchWithPolicy(ctx, fix, fingerprint(fix), req, ActRecoverySpawn, false, false)
	return nil
}

// rebaseRecovery prepares a detached worktree before spending the round. The
// lease pins the observed remote head, so concurrent agent work is never overwritten.
func (e *engine) rebaseRecovery(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	if e.env.DryRun {
		return nil
	}
	branch, valid := e.checkedBranch(it.ID, operator.ScopeString(it.Scope, "branch"), "recovery")
	if !valid {
		return nil
	}
	pf := e.facts.pr[d.Item]
	if pf == nil || pf.view.HeadRefOid == "" {
		e.escalate(it.ID, "rebase refused: the PR head commit was not observed")
		return nil
	}
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	if _, err := e.git(ctx, repo, "fetch", "origin"); err != nil {
		e.escalate(it.ID, "git fetch failed: "+stderrOf(err))
		return nil
	}
	def := e.defaultBranch(ctx, repo, it.ID)
	tmp, err := os.MkdirTemp("", "rk-autopilot-rebase-")
	if err != nil {
		e.escalate(it.ID, "temporary rebase worktree not created: "+err.Error())
		return nil
	}
	if err := os.Remove(tmp); err != nil {
		e.escalate(it.ID, "temporary rebase worktree not prepared: "+err.Error())
		return nil
	}
	added := false
	defer func() {
		if !added {
			_ = os.RemoveAll(tmp)
			return
		}
		if _, cleanupErr := e.git(context.WithoutCancel(ctx), repo, "worktree", "remove", "--force", tmp); cleanupErr != nil {
			e.escalate(it.ID, "worktree cleanup failed: "+stderrOf(cleanupErr))
		}
		_ = os.RemoveAll(tmp)
	}()
	if _, err := e.git(ctx, repo, "worktree", "add", "--detach", tmp, "origin/"+branch); err != nil {
		e.escalate(it.ID, "temporary rebase worktree not created: "+stderrOf(err))
		return nil
	}
	added = true
	if _, err := e.git(ctx, tmp, "rebase", "origin/"+def); err != nil {
		files := e.conflictFiles(ctx, tmp, it.ID)
		if _, abortErr := e.git(ctx, tmp, "rebase", "--abort"); !alreadyApplied(abortErr, "rebase-abort") {
			e.escalate(it.ID, "git rebase --abort failed: "+stderrOf(abortErr))
		}
		reason := fmt.Sprintf("rebase of %s onto %s conflicted or failed%s: %s", branch, def, files, stderrOf(err))
		if writeErr := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) {
			t.Scope[scopeHalted] = true
			t.Scope[scopeRecovery] = addRecovery(recoveryValues(t.Scope[scopeRecovery]), recoveryRebase)
		}); writeErr != nil {
			e.writeFailed(d.Item, d.pr, "rebase halt not written", writeErr)
			return nil
		}
		e.escalate(it.ID, "halted: "+reason)
		if pf.armed() {
			return e.disarm(ctx, it)
		}
		return nil
	}
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) {
		t.Scope[scopeRecovery] = addRecovery(recoveryValues(t.Scope[scopeRecovery]), recoveryRebase)
	}); err != nil {
		e.writeFailed(d.Item, d.pr, "rebase recovery marker not written", err)
		return nil
	}
	lease := fmt.Sprintf("--force-with-lease=refs/heads/%s:%s", branch, pf.view.HeadRefOid)
	if _, err := e.git(ctx, tmp, "push", lease, "origin", "HEAD:refs/heads/"+branch); err != nil {
		e.escalate(it.ID, "push after rebase failed: "+stderrOf(err))
		return nil
	}
	e.act(ActRebased, it.ID, fmt.Sprintf("%s onto %s", branch, def))
	return nil
}

func (e *engine) conflictFiles(ctx context.Context, dir, id string) string {
	out, err := e.git(ctx, dir, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		e.escalate(id, "git conflict-file lookup failed: "+stderrOf(err))
		return ""
	}
	if out == "" {
		return ""
	}
	return ": " + strings.Join(strings.Fields(out), ", ")
}

// untrackFix removes tracking but leaves the agent's window and report open.
func (e *engine) untrackFix(d Decision) error {
	if e.env.DryRun {
		return nil
	}
	if _, _, ok := e.reread(d); !ok {
		return nil
	}
	if err := e.mutateEngine(func(st *engineState) error {
		for i := range st.PRs {
			if st.PRs[i].FixItem == d.Item {
				st.PRs[i].FixItem = ""
				st.PRs[i].UpdatedAt = operator.NowRFC3339()
			}
		}
		if !st.remove(d.Item) {
			return fmt.Errorf("fix item %s is no longer in the engine state", d.Item)
		}
		return nil
	}); err != nil {
		e.escalate(d.Item, "fix item not untracked: "+err.Error())
		return nil
	}
	if err := removeProjection(e.env.StatePath, d.Item); err != nil {
		e.escalate(d.Item, "fix projection not removed: "+err.Error())
		return err
	}
	e.act(ActUntracked, d.Item, "recovery round resolved")
	return nil
}
