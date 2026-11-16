package autopilot

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"rk/internal/operator"
)

const (
	recoveryCIFix  = "ci-fix"
	recoveryRebase = "rebase"
	// recoveryWindow is how long a fix round may go without a new push.
	recoveryWindow = 30 * time.Minute
	// stallUnchanged is the number of polls with no change after which an
	// armed PR with no failed check is read as stuck.
	stallUnchanged = 3
)

var shardRe = regexp.MustCompile(`(\d+)/(\d+)`)

// stall is the stall rule on an armed head PR: a failed required check is a
// ci-failed recovery; no failed check after `stallUnchanged` quiet polls with
// the PR CONFLICTING is a conflicting recovery.
func (e *engine) stall(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView) {
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	n := prNum(head.Scope)
	runs, err := e.requiredChecks(ctx, repo, n)
	if err != nil {
		e.escalate(head.ID, "gh pr checks failed: "+stderrOf(err))
		return
	}
	if !e.progressFixRound(ctx, st, head, v, runs) {
		return
	}
	if f := firstFailed(runs); f != nil {
		e.ciFailed(ctx, st, head, v, *f)
		return
	}
	fresh, err := e.load(head.ID)
	if err != nil {
		return
	}
	ci := operator.IndexOf(fresh.Tracked, head.ID)
	if ci < 0 {
		return // removed by an external writer: it wins
	}
	cur := fresh.Tracked[ci]
	if cur.Unchanged >= stallUnchanged && strings.EqualFold(v.Mergeable, "CONFLICTING") {
		e.conflicting(ctx, fresh, cur, v)
	}
}

// ciFailed runs the bounded ci-failed recovery. The marker is persisted before
// the request is sent, so a restarted run can tell a recovered PR from a first
// sighting. The PR stays armed throughout.
func recoveryFields(head string, now time.Time) map[string]interface{} {
	return map[string]interface{}{scopeRecovery: recoveryCIFix, scopeFixHead: head, scopeRecoverAt: now.UTC().Format(time.RFC3339)}
}

func (e *engine) ciFailed(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView, failed checkRun) {
	// PR observation and earlier sequences may have changed the ledger since the
	// caller loaded it. Read the facts to claim after constructing the request.
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	text := e.fixRequest(ctx, head, repo, failed)
	fresh, err := e.load(head.ID)
	if err != nil {
		return
	}
	i := operator.IndexOf(fresh.Tracked, head.ID)
	if i < 0 {
		return
	}
	st, head = fresh, fresh.Tracked[i]
	if claimToken(head) != "" {
		return
	}
	if operator.ScopeString(head.Scope, scopeRecovery) == recoveryCIFix {
		e.progressFixRound(ctx, st, head, v, []checkRun{failed})
		return
	}
	pane, err := e.authoringPane(ctx, st, head)
	if err != nil {
		e.escalate(head.ID, "authoring pane snapshot failed: "+err.Error())
		return
	}
	if e.env.DryRun {
		e.act(ActRecoverySent, head.ID, "would send a CI fix request for "+failed.Name)
		return
	}
	if pane == "" {
		e.recoverySpawn(ctx, st, head, repo, operator.ScopeString(head.Scope, "change"), text, v.HeadRefOid)
		return
	}
	claimed, ok, err := e.claimWork(head.ID, st, claimFixSend, "", recoveryFields(v.HeadRefOid, e.env.now()))
	if err != nil {
		e.escalate(head.ID, "recovery marker not written: "+err.Error())
		return
	}
	if !ok {
		return
	}
	err = e.env.Panes.Send(ctx, pane, text)
	switch {
	case errors.Is(err, ErrPaneBusy):
		if rollbackErr := e.rollbackClaim(claimed); rollbackErr != nil {
			e.escalate(head.ID, "busy recovery rollback failed: "+rollbackErr.Error())
			return
		}
		if err := e.note(head.ID, "CI fix request deferred: the authoring agent is busy"); err != nil {
			e.escalate(head.ID, "busy deferral note not written: "+err.Error())
		}
	case err != nil:
		// An injection error can occur after delivery. Keep pending ownership until
		// reconciliation, instead of treating an uncertain send as a completed round.
		e.escalate(head.ID, "CI fix request delivery uncertain; claim retained: "+err.Error())
	default:
		if err := e.releaseClaim(claimed); err != nil {
			e.escalate(head.ID, "CI fix delivery completion not written: "+err.Error())
			return
		}
		e.act(ActRecoverySent, head.ID, fmt.Sprintf("check %s → pane %s", failed.Name, pane))
	}
}

// A recovery pane is owned by its PR claim until the pane item and its parent
// link can be committed atomically. Failed attachment is adopted by advance.
func (e *engine) recoverySpawn(ctx context.Context, st *operator.State, head operator.TrackedItem, repo, change, text, headOID string) {
	branch, valid := e.checkedBranch(head.ID, operator.ScopeString(head.Scope, "branch"), "recovery")
	if !valid {
		return
	}
	pane, err := e.authoringPane(ctx, st, head)
	if err != nil {
		e.escalate(head.ID, "authoring pane snapshot failed: "+err.Error())
		return
	}
	if pane != "" {
		return
	}
	name := change
	if name == "" {
		name = operator.ScopeString(head.Scope, scopeItem)
	}
	fixID := name + "-fix"
	if !itemIDRe.MatchString(fixID) {
		e.escalate(head.ID, "no authoring pane and no valid recovery branch/item")
		return
	}
	claimed, ok, err := e.claimWork(head.ID, st, claimFixSpawn, fixID, recoveryFields(headOID, e.env.now()))
	if err != nil {
		e.escalate(head.ID, "recovery spawn claim not written: "+err.Error())
		return
	}
	if !ok {
		return
	}
	opened := false
	defer e.rollbackUnopened(claimed, &opened)
	session, err := e.env.Session(ctx, repo)
	if err != nil {
		e.escalate(head.ID, "no landing session: "+err.Error())
		return
	}
	wt, err := e.worktreeForBranch(ctx, repo, branch)
	if err != nil {
		e.escalate(head.ID, err.Error())
		return
	}
	e.launchClaimed(ctx, claimed, SpawnRequest{Repo: repo, Session: session, WorktreeName: fixID, CheckoutBranch: branch, ExistingWorktree: wt, Prompt: text, Note: fixID + " · CI fix"}, ActRecoverySpawn, &opened)
}

// fixRequest is the one sanctioned raw send into a fab-project agent, because
// it amends a change that already finished the pipeline. It carries no skill
// prefix.
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

// authoringPane finds the pane working a change by the change its cwd derives,
// never by a remembered pane id.
func (e *engine) authoringPane(ctx context.Context, st *operator.State, head operator.TrackedItem) (string, error) {
	panes, err := e.env.Panes.Snapshot(ctx)
	if err != nil {
		return "", err
	}
	change := operator.ScopeString(head.Scope, "change")
	if change == "" {
		if i := operator.IndexOf(st.Tracked, operator.ScopeString(head.Scope, scopeItem)); i >= 0 {
			pane := operator.ScopeString(st.Tracked[i].Scope, "pane")
			if _, alive := panes[pane]; alive {
				return pane, nil
			}
		}
		return "", nil
	}
	best := ""
	for id, p := range panes {
		if p.Change != "" && changeMatches(p.Change, change) && (best == "" || id < best) {
			best = id
		}
	}
	return best, nil
}

// changeMatches compares a derived change folder with an item's change, which
// may be the folder name or its 4-char id.
func changeMatches(derived, change string) bool {
	return derived == change || strings.Contains("-"+derived+"-", "-"+change+"-")
}

// A fix remains owned until a changed head has entirely green required checks.
// The no-push bound also applies while checks are pending or green on the old head.
func (e *engine) progressFixRound(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView, runs []checkRun) bool {
	if operator.ScopeString(head.Scope, scopeRecovery) != recoveryCIFix {
		return true
	}
	fixHead := operator.ScopeString(head.Scope, scopeFixHead)
	if fixHead == "" || v.HeadRefOid == "" {
		e.escalate(head.ID, "cannot resolve CI fix round without both head SHAs")
		return false
	}
	if v.HeadRefOid == fixHead {
		at, err := time.Parse(time.RFC3339, operator.ScopeString(head.Scope, scopeRecoverAt))
		if err != nil {
			e.escalate(head.ID, "invalid recovery timestamp: "+err.Error())
			return false
		}
		if e.env.now().Sub(at) > recoveryWindow {
			e.haltCone(ctx, st, head, fmt.Sprintf("no new push %s after the CI fix request", recoveryWindow))
		}
		return false
	}
	if failed := firstFailed(runs); failed != nil {
		e.haltCone(ctx, st, head, fmt.Sprintf("CI still failing on check %s after the fix round (new head %s); diagnosis is in the authoring pane", failed.Name, short(v.HeadRefOid)))
		return false
	}
	return e.resolveFixRound(head, v.HeadRefOid, runs)
}

// resolveFixRound closes a green fix round: the recovery spawn's tracking item
// is removed. The recovery marker stays as evidence for the merge report.
func (e *engine) resolveFixRound(head operator.TrackedItem, currentHead string, runs []checkRun) bool {
	if currentHead == "" || operator.ScopeString(head.Scope, scopeFixHead) == "" || currentHead == operator.ScopeString(head.Scope, scopeFixHead) || checksPending(runs) {
		return false
	}
	fixID := operator.ScopeString(head.Scope, scopeFixItem)
	if fixID == "" {
		return true
	}
	resolved := false
	err := e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, head.ID)
		if i < 0 {
			return operator.ErrNoWrite
		}
		if operator.ScopeString(st.Tracked[i].Scope, scopeFixItem) != fixID || operator.ScopeString(st.Tracked[i].Scope, scopeFixHead) != operator.ScopeString(head.Scope, scopeFixHead) || claimToken(st.Tracked[i]) != "" {
			return operator.ErrNoWrite
		}
		delete(st.Tracked[i].Scope, scopeFixItem)
		if j := operator.IndexOf(st.Tracked, fixID); j >= 0 {
			if operator.ScopeString(st.Tracked[j].Scope, scopeFixFor) != head.ID {
				return fmt.Errorf("recovery item %s changed externally", fixID)
			}
			st.Tracked = append(st.Tracked[:j], st.Tracked[j+1:]...)
		}
		resolved = true
		return nil
	})
	if err != nil {
		e.escalate(head.ID, "fix round cleanup not written: "+err.Error())
		return false
	}
	return resolved
}

func short(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

// conflicting runs the bounded rebase recovery: rebase onto the default tip in
// the change's worktree, push with a lease, and re-arm. CONFLICTING again after
// a rebase, or a rebase that itself conflicts, disarms and halts the cone.
func (e *engine) conflicting(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView) {
	fresh, err := e.load(head.ID)
	if err != nil {
		return
	}
	i := operator.IndexOf(fresh.Tracked, head.ID)
	if i < 0 {
		return
	}
	st, head = fresh, fresh.Tracked[i]
	branch, valid := e.checkedBranch(head.ID, operator.ScopeString(head.Scope, "branch"), "recovery")
	if !valid {
		return
	}
	if claimToken(head) != "" {
		return
	}
	n := prNum(head.Scope)
	if operator.ScopeString(head.Scope, scopeRecovery) == recoveryRebase {
		e.haltCone(ctx, st, head, fmt.Sprintf("PR #%s is CONFLICTING again after the rebase recovery", n))
		return
	}
	if e.env.DryRun {
		e.act(ActRebased, head.ID, "would rebase PR #"+n)
		return
	}
	now := e.env.now().UTC().Format(time.RFC3339)
	claimed, ok, err := e.claimWork(head.ID, st, claimRebase, "", map[string]interface{}{scopeRecovery: recoveryRebase, scopeRecoverAt: now})
	if err != nil {
		e.escalate(head.ID, "recovery marker not written: "+err.Error())
		return
	}
	if !ok {
		return
	}
	head = claimed
	releaseClaim := true
	defer func() {
		if releaseClaim {
			e.finishWorkClaim(head)
		}
	}()
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	wt, cleanup, err := e.worktreeFor(ctx, head, repo, branch)
	if err != nil {
		e.escalate(head.ID, "no worktree to rebase in: "+err.Error())
		return
	}
	releaseClaim = false
	defer func() {
		if e.cleanupWorktree(head.ID, cleanup) {
			e.finishWorkClaim(head)
		}
	}()
	if _, err := e.git(ctx, wt, "fetch", "origin"); err != nil {
		e.escalate(head.ID, "git fetch failed: "+stderrOf(err))
		return
	}
	def := e.defaultBranch(ctx, repo, head.ID)
	if _, err := e.git(ctx, wt, "rebase", "origin/"+def); err != nil {
		files := e.conflictFiles(ctx, wt, head.ID)
		if _, abortErr := e.git(ctx, wt, "rebase", "--abort"); !alreadyApplied(abortErr, "rebase-abort") {
			e.escalate(head.ID, "git rebase --abort failed: "+stderrOf(abortErr))
		}
		e.haltCone(ctx, st, head, fmt.Sprintf("rebase of %s onto %s conflicted or failed%s: %s", branch, def, files, stderrOf(err)))
		return
	}
	if _, err := e.git(ctx, wt, "push", "--force-with-lease", "origin", branch); err != nil {
		e.escalate(head.ID, "push after rebase failed: "+stderrOf(err))
		return
	}
	e.act(ActRebased, head.ID, fmt.Sprintf("%s onto %s", branch, def))
	if _, err := e.gh(ctx, repo, "pr", "merge", "--auto", "--squash", n); err != nil {
		if !alreadyApplied(err, "arm") {
			e.escalate(head.ID, fmt.Sprintf("re-arming PR #%s failed: %s", n, stderrOf(err)))
			return
		}
	}
	e.act(ActArmed, head.ID, "PR #"+n+" re-armed")
}
