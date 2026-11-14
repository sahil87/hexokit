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
		_ = e.note(head.ID, "gh pr checks failed: "+stderrOf(err))
		return
	}
	if f := firstFailed(runs); f != nil {
		e.ciFailed(ctx, st, head, v, *f)
		return
	}
	if operator.ScopeString(head.Scope, scopeRecovery) == recoveryCIFix {
		e.resolveFixRound(head)
	}
	fresh, err := e.load()
	if err != nil {
		return
	}
	cur := fresh.Tracked[operator.IndexOf(fresh.Tracked, head.ID)]
	if cur.Unchanged >= stallUnchanged && strings.EqualFold(v.Mergeable, "CONFLICTING") {
		e.conflicting(ctx, fresh, cur, v)
	}
}

// ciFailed runs the bounded ci-failed recovery. The marker is persisted before
// the request is sent, so a restarted run can tell a recovered PR from a first
// sighting. The PR stays armed throughout.
func (e *engine) ciFailed(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView, failed checkRun) {
	if operator.ScopeString(head.Scope, scopeRecovery) == recoveryCIFix {
		e.fixRoundStillRed(ctx, st, head, v, failed)
		return
	}
	if e.env.DryRun {
		e.act(ActRecoverySent, head.ID, "would send a CI fix request for "+failed.Name)
		return
	}
	now := e.env.now().UTC().Format(time.RFC3339)
	if err := e.setScope(head.ID, map[string]interface{}{scopeRecovery: recoveryCIFix, scopeFixHead: v.HeadRefOid, scopeRecoverAt: now}); err != nil {
		e.escalate(head.ID, "recovery marker not written: "+err.Error())
		return
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	text := e.fixRequest(ctx, head, repo, failed)
	change := operator.ScopeString(head.Scope, "change")
	if pane := e.authoringPane(ctx, change); pane != "" {
		err := e.env.Panes.Send(ctx, pane, text)
		switch {
		case errors.Is(err, ErrPaneBusy):
			// Never interrupt a working agent: forget the marker so the next
			// step sees a first sighting again.
			_ = e.setScope(head.ID, map[string]interface{}{scopeRecovery: nil, scopeFixHead: nil, scopeRecoverAt: nil})
			_ = e.note(head.ID, "CI fix request deferred: the authoring agent is busy")
		case err != nil:
			e.escalate(head.ID, "CI fix request not delivered: "+err.Error())
		default:
			e.act(ActRecoverySent, head.ID, fmt.Sprintf("check %s → pane %s", failed.Name, pane))
		}
		return
	}
	e.recoverySpawn(ctx, st, head, repo, change, text)
}

// recoverySpawn is the one recovery spawn for a PR whose authoring pane is
// gone: the same text, on the existing branch, tracked as a change-less
// `<change>-fix` item removed when the round resolves.
func (e *engine) recoverySpawn(ctx context.Context, st *operator.State, head operator.TrackedItem, repo, change, text string) {
	branch := safeBranch(operator.ScopeString(head.Scope, "branch"))
	name := change
	if name == "" {
		name = operator.ScopeString(head.Scope, scopeItem)
	}
	fixID := name + "-fix"
	if branch == "" || operator.IndexOf(st.Tracked, fixID) >= 0 {
		e.escalate(head.ID, "no authoring pane and no recovery spawn possible (no branch, or a fix item already exists)")
		return
	}
	session, err := e.env.Session(ctx, repo)
	if err != nil {
		e.escalate(head.ID, "no landing session: "+err.Error())
		return
	}
	res, err := e.env.Spawn.Spawn(ctx, SpawnRequest{
		Repo: repo, Session: session, WorktreeName: fixID, CheckoutBranch: branch,
		ExistingWorktree: e.worktreeForBranch(ctx, repo, branch), Prompt: text, Note: fixID + " · CI fix",
	})
	if err != nil {
		e.escalate(head.ID, "recovery spawn failed: "+err.Error())
		return
	}
	fp := map[string]interface{}{"pane": res.PaneID}
	operator.RecordPanePID(ctx, e.env.Server, fp)
	it, err := operator.NewPaneItem(fixID, nil, map[string]interface{}{
		"repo": repo, "pane": res.PaneID, "pane_pid": fp["pane_pid"], "session": session, "branch": branch,
		scopeFixFor: head.ID,
	})
	if err == nil {
		err = e.addPRItems([]operator.TrackedItem{it})
	}
	if err != nil {
		e.escalate(head.ID, "recovery spawn is running but could not be tracked: "+err.Error())
		return
	}
	_ = e.setScope(head.ID, map[string]interface{}{scopeFixItem: fixID})
	e.act(ActRecoverySpawn, head.ID, fmt.Sprintf("%s in %s", res.PaneID, session))
}

// fixRequest is the one sanctioned raw send into a fab-project agent, because
// it amends a change that already finished the pipeline. It carries no skill
// prefix.
func (e *engine) fixRequest(ctx context.Context, head operator.TrackedItem, repo string, failed checkRun) string {
	label := e.nameWithOwner(ctx, repo)
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
func (e *engine) authoringPane(ctx context.Context, change string) string {
	if change == "" {
		return ""
	}
	panes, err := e.env.Panes.Snapshot(ctx)
	if err != nil {
		return ""
	}
	best := ""
	for id, p := range panes {
		if p.Change != "" && changeMatches(p.Change, change) && (best == "" || id < best) {
			best = id
		}
	}
	return best
}

// changeMatches compares a derived change folder with an item's change, which
// may be the folder name or its 4-char id.
func changeMatches(derived, change string) bool {
	return derived == change || strings.Contains("-"+derived+"-", "-"+change+"-")
}

// fixRoundStillRed decides an in-flight fix round: still red on a new head, or
// on the same head after the window, halts the cone.
func (e *engine) fixRoundStillRed(ctx context.Context, st *operator.State, head operator.TrackedItem, v prView, failed checkRun) {
	fixHead := operator.ScopeString(head.Scope, scopeFixHead)
	if v.HeadRefOid != "" && v.HeadRefOid != fixHead {
		e.haltCone(ctx, st, head, fmt.Sprintf("CI still failing on check %s after the fix round (new head %s); diagnosis is in the authoring pane", failed.Name, short(v.HeadRefOid)))
		return
	}
	if at, err := time.Parse(time.RFC3339, operator.ScopeString(head.Scope, scopeRecoverAt)); err == nil && e.env.now().Sub(at) > recoveryWindow {
		e.haltCone(ctx, st, head, fmt.Sprintf("no new push %s after the CI fix request; check %s is still failing", recoveryWindow, failed.Name))
	}
}

// resolveFixRound closes a green fix round: the recovery spawn's tracking item
// is removed. The recovery marker stays as evidence for the merge report.
func (e *engine) resolveFixRound(head operator.TrackedItem) {
	fixID := operator.ScopeString(head.Scope, scopeFixItem)
	if fixID == "" {
		return
	}
	_ = e.mutate(func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, fixID)
		if i < 0 {
			return operator.ErrNoWrite
		}
		st.Tracked = append(st.Tracked[:i], st.Tracked[i+1:]...)
		return nil
	})
	_ = e.setScope(head.ID, map[string]interface{}{scopeFixItem: nil})
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
	if err := e.setScope(head.ID, map[string]interface{}{scopeRecovery: recoveryRebase, scopeRecoverAt: now}); err != nil {
		e.escalate(head.ID, "recovery marker not written: "+err.Error())
		return
	}
	repo := cleanRepo(operator.ScopeString(head.Scope, "repo"))
	branch := safeBranch(operator.ScopeString(head.Scope, "branch"))
	wt, cleanup, err := e.worktreeFor(ctx, repo, branch)
	if err != nil {
		e.escalate(head.ID, "no worktree to rebase in: "+err.Error())
		return
	}
	defer cleanup()
	if _, err := e.git(ctx, wt, "fetch", "origin"); err != nil {
		e.escalate(head.ID, "git fetch failed: "+stderrOf(err))
		return
	}
	def := e.defaultBranch(ctx, repo)
	if _, err := e.git(ctx, wt, "rebase", "origin/"+def); err != nil {
		files := e.conflictFiles(ctx, wt)
		_, _ = e.git(ctx, wt, "rebase", "--abort")
		e.haltCone(ctx, st, head, fmt.Sprintf("rebase of %s onto %s conflicted%s", branch, def, files))
		return
	}
	if _, err := e.git(ctx, wt, "push", "--force-with-lease", "origin", branch); err != nil {
		e.escalate(head.ID, "push after rebase failed: "+stderrOf(err))
		return
	}
	e.act(ActRebased, head.ID, fmt.Sprintf("%s onto %s", branch, def))
	if _, err := e.gh(ctx, repo, "pr", "merge", "--auto", "--squash", n); err != nil {
		if m := strings.ToLower(stderrOf(err)); !strings.Contains(m, "already enabled") && !strings.Contains(m, "already has auto") {
			e.escalate(head.ID, fmt.Sprintf("re-arming PR #%s failed: %s", n, stderrOf(err)))
			return
		}
	}
	e.act(ActArmed, head.ID, "PR #"+n+" re-armed")
}
