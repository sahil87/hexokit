package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
	"rk/internal/riff"

	"gopkg.in/yaml.v3"
)

// confidenceGate is fab's flat intake gate: a change scoring below it is not
// spawned into a pipeline.
const confidenceGate = 3.0

// resolveAgentFn resolves the target repo's agent (launcher and skill prefix);
// a var so tests do not reach a real fab.
var resolveAgentFn = riff.ResolveAgent

// conflictError is a dependency cherry-pick that conflicted. The spawn is
// escalated and never skipped.
type conflictError struct {
	dep string
	err error
}

func (c *conflictError) Error() string {
	return fmt.Sprintf("cherry-pick of the %s dependency conflicted: %v", c.dep, c.err)
}

func spawningSet(it operator.TrackedItem) bool {
	return operator.ScopeString(it.Scope, scopeSpawning) != ""
}

func skipped(it operator.TrackedItem) bool {
	b, _ := it.Scope[scopeSkipped].(bool)
	return b
}

// sameRepoDeps returns the dependency items that share the item's repo, in
// depends_on order. Cross-repo dependencies are ordering barriers: no code
// moves across repos.
func sameRepoDeps(st *operator.State, it operator.TrackedItem) []operator.TrackedItem {
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	var out []operator.TrackedItem
	for _, dep := range it.DependsOn {
		i := operator.IndexOf(st.Tracked, dep)
		if i < 0 {
			if be, ok := st.BranchMap[dep]; ok && cleanRepo(be.Repo) == repo {
				out = append(out, operator.TrackedItem{ID: dep, Scope: map[string]interface{}{"branch": be.Branch, "repo": be.Repo}})
			}
			continue
		}
		if cleanRepo(depRepo(st, st.Tracked[i])) == repo {
			out = append(out, st.Tracked[i])
		}
	}
	return out
}

// spawn is the executor of row Q2: the spawn sequence for one pending item,
// whose readiness was decided from the pass's facts.
func (e *engine) spawn(ctx context.Context, d Decision) error {
	st, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	e.spawnItem(ctx, st, it, d.fp)
	return nil
}

// spawnItem runs the spawn sequence for one pending item. Every refusal is an
// escalation that leaves the item pending, to be retried by the next step.
func (e *engine) spawnItem(ctx context.Context, st *operator.State, it operator.TrackedItem, fp string) {
	id := it.ID
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	mode := modeOf(it)
	if !e.validateSpawnBranches(st, it) {
		return
	}
	if err := e.validateRepo(ctx, repo); err != nil {
		e.escalate(id, err.Error())
		return
	}

	// A failed fetch stops the spawn: falling through to rev-parse would pin the
	// stale origin/<default> the main checkout last saw.
	if _, err := e.git(ctx, repo, "fetch", "origin"); err != nil {
		e.escalate(id, "git fetch failed, spawn stopped and the item stays pending: "+stderrOf(err))
		return
	}
	def := e.defaultBranch(ctx, repo, id)
	baseRef := "origin/" + def
	deps := sameRepoDeps(st, it)

	var ladder []depRef
	stackedBranch := ""
	switch mode {
	case operator.MergeModeCherryPickLadder:
		var err error
		ladder, err = e.ladderDeps(ctx, st, repo, deps)
		if err != nil {
			e.escalate(id, err.Error())
			return
		}
	case operator.MergeModeStackedPRs:
		b, err := e.stackedBase(ctx, st, repo, deps)
		if err != nil {
			e.escalate(id, err.Error())
			return
		}
		stackedBranch = b
		if b != "" {
			baseRef = "origin/" + b
		}
	}

	change := operator.ScopeString(it.Scope, "change")
	if change != "" && !changeIDRe.MatchString(change) {
		e.escalate(id, fmt.Sprintf("invalid change reference %q", change))
		return
	}
	newBranch := ""
	hasFab, err := fabPresent(repo)
	if err != nil {
		e.escalate(id, err.Error())
		return
	}
	if change != "" && hasFab {
		folder, err := e.run(ctx, repo, "fab", "resolve", "--folder", change)
		folder = strings.TrimSpace(folder)
		if err != nil || folder == "" {
			e.escalate(id, fmt.Sprintf("change %s not found in %s", change, repo))
			return
		}
		newBranch = folder
		if reason := e.belowConfidenceGate(repo, folder); reason != "" {
			e.escalate(id, reason)
			return
		}
	}

	sha, err := e.git(ctx, repo, "rev-parse", baseRef)
	if err != nil || sha == "" {
		e.escalate(id, fmt.Sprintf("cannot resolve %s: %s", baseRef, stderrOf(err)))
		return
	}
	session, err := e.env.Session(ctx, repo)
	if err != nil {
		e.escalate(id, "no landing session: "+err.Error())
		return
	}

	prompt, err := e.buildPrompt(ctx, it, repo, def, stackedBranch)
	if err != nil {
		e.escalate(id, err.Error())
		return
	}
	req := SpawnRequest{
		Repo: repo, Session: session, WorktreeName: id, BaseSHA: sha, NewBranch: newBranch,
		Prompt: prompt,
		Note:   id + " · spawned",
		Prepare: func(ctx context.Context, wt string) error {
			return e.prepareWorktree(ctx, wt, id, change, def, mode, ladder, stackedBranch)
		},
	}
	e.launch(ctx, it, fp, req, ActSpawned, false)
}

// launch is the only window-opening site. The spawning marker (with respawned
// for the one respawn) is durable before the window can exist; the pane is
// recorded as soon as it does, which clears the marker. A launch that fails
// before a window opens clears the marker again so the item is retried; one
// that opened a window it could not record leaves the marker, so no pass
// relaunches over an orphan.
func (e *engine) launch(ctx context.Context, it operator.TrackedItem, fp string, req SpawnRequest, action string, respawn bool) {
	id := it.ID
	stamp := e.env.now().UTC().Format(time.RFC3339)
	if err := e.guarded(id, fp, func(t *operator.TrackedItem) {
		t.Scope[scopeSpawning] = stamp
		if respawn {
			t.Scope[scopeRespawned] = true
		}
	}); err != nil {
		if errors.Is(err, errItemChanged) {
			e.writeFailed(id, false, "", err)
		} else {
			e.escalate(id, "spawn marker not written, nothing launched: "+err.Error())
		}
		return
	}
	opened, pane := false, ""
	var attachErr error
	req.Opened = func(res SpawnResult) error {
		opened, pane = true, res.PaneID
		attachErr = e.attach(ctx, it, req.Repo, res, req.Session)
		return attachErr
	}
	res, err := e.env.Spawn.Spawn(ctx, req)
	if err == nil && !opened {
		opened, pane = true, res.PaneID
		attachErr = e.attach(ctx, it, req.Repo, res, req.Session)
	}
	switch {
	case errors.Is(attachErr, errItemRemoved):
		e.escalate(id, fmt.Sprintf("window %s opened but %s was removed from tracking meanwhile — nothing was recorded; close the orphaned window", pane, id))
	case attachErr != nil:
		e.escalate(id, attachEscalation(pane, attachErr))
	case err != nil && !opened:
		e.clearSpawning(id, respawn)
		e.escalate(id, "spawn failed: "+err.Error())
	case err != nil:
		e.escalate(id, "spawn: "+err.Error())
	default:
		e.act(action, id, fmt.Sprintf("%s in %s", res.PaneID, req.Session))
	}
}

// clearSpawning withdraws the marker of a launch that opened no window. A
// respawn that opened none has not used its one respawn either.
func (e *engine) clearSpawning(id string, respawn bool) {
	if err := e.patch(id, func(it *operator.TrackedItem) {
		delete(it.Scope, scopeSpawning)
		if respawn {
			delete(it.Scope, scopeRespawned)
		}
	}); err != nil {
		e.escalate(id, "spawn marker not cleared: "+err.Error())
	}
}

// depRef is one dependency to cherry-pick: its id and resolved ref.
type depRef struct {
	id, branch, ref string
}

// ladderDeps resolves each same-repo dependency's branch and prunes a
// dependency whose branch is an ancestor of another dependency's: the leaf
// already carries it.
func (e *engine) ladderDeps(ctx context.Context, st *operator.State, repo string, deps []operator.TrackedItem) ([]depRef, error) {
	refs := make([]depRef, 0, len(deps))
	for _, d := range deps {
		b := depBranch(st, d)
		if b == "" {
			return nil, fmt.Errorf("dependency %s has no branch (neither scope.branch nor a branch_map entry)", d.ID)
		}
		ref, err := e.resolveRef(ctx, repo, b)
		if err != nil {
			return nil, fmt.Errorf("dependency %s: %w", d.ID, err)
		}
		refs = append(refs, depRef{id: d.ID, branch: b, ref: ref})
	}
	drop := make([]bool, len(refs))
	for i := range refs {
		for j := range refs {
			if i == j || drop[j] {
				continue
			}
			ancestor, err := e.isAncestor(ctx, repo, refs[i].ref, refs[j].ref)
			if err != nil {
				return nil, err
			}
			if !ancestor {
				continue
			}
			reverse, err := e.isAncestor(ctx, repo, refs[j].ref, refs[i].ref)
			if err != nil {
				return nil, err
			}
			if !reverse || i > j {
				drop[i] = true
				break
			}
		}
	}
	kept := refs[:0:0]
	for i, r := range refs {
		if !drop[i] {
			kept = append(kept, r)
		}
	}
	return kept, nil
}

// stackedBase picks the single same-repo dependency a stacked-prs branch is cut
// from ("" when there is none: the first of a stack bases on the default
// branch).
func (e *engine) stackedBase(ctx context.Context, st *operator.State, repo string, deps []operator.TrackedItem) (string, error) {
	if len(deps) == 0 {
		return "", nil
	}
	refs, err := e.ladderDeps(ctx, st, repo, deps)
	if err != nil {
		return "", err
	}
	if len(refs) != 1 {
		return "", fmt.Errorf("stacked-prs needs exactly one same-repo dependency chain, found %d independent branches", len(refs))
	}
	// A stack is cut from the pushed tip: the dependent's worktree starts at the
	// SHA of origin/<dep-branch>, so the branch must exist on origin.
	if _, err := e.git(ctx, repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+refs[0].branch); err != nil {
		return "", fmt.Errorf("dependency %s: branch %s is not on origin (push it before stacking)", refs[0].id, refs[0].branch)
	}
	return refs[0].branch, nil
}

// belowConfidenceGate returns an escalation reason when the change's
// .status.yaml scores under the gate; "" when it passes or carries no score.
func (e *engine) belowConfidenceGate(repo, folder string) string {
	data, err := os.ReadFile(filepath.Join(repo, "fab", "changes", folder, ".status.yaml"))
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		return "cannot read confidence gate: " + err.Error()
	}
	var s struct {
		Confidence struct {
			Score *float64 `yaml:"score"`
		} `yaml:"confidence"`
	}
	if err := yaml.Unmarshal(data, &s); err != nil {
		return "cannot parse confidence gate: " + err.Error()
	}
	if s.Confidence.Score == nil {
		return ""
	}
	if *s.Confidence.Score < confidenceGate {
		return fmt.Sprintf("below confidence gate (%.1f < %.1f)", *s.Confidence.Score, confidenceGate)
	}
	return ""
}

// buildPrompt applies the two-axis table: fab/ present or not, task given or
// not. A bare agent carries no prompt, and raw implementation text never goes
// to a fab-project agent.
func (e *engine) buildPrompt(ctx context.Context, it operator.TrackedItem, repo, def, stackedBase string) (string, error) {
	change := operator.ScopeString(it.Scope, "change")
	task := operator.ScopeString(it.Scope, scopeTask)
	hasFab, err := fabPresent(repo)
	if err != nil {
		return "", err
	}
	if hasFab {
		switch {
		case change != "":
			return "/fab-fff " + change, nil
		case task != "":
			p := "/fab-new " + task
			if stackedBase != "" {
				prefix := resolveAgentFn(ctx, repo, "").SkillPrefix
				p += fmt.Sprintf("\n\nAfter %s creates the change, run `fab status set-base-branch <new-change> %s`.",
					riff.RenderSkillRef(prefix, "/fab-new"), stackedBase)
			}
			return p, nil
		}
		return "", nil
	}
	if task == "" {
		return "", nil
	}
	base := def
	if stackedBase != "" {
		base = stackedBase
	}
	return task + "\n\nCommit on this branch, push, and open a draft PR against " + base + ".", nil
}

// prepareWorktree runs in the new worktree before any window opens: dependency
// code by mode, the stacked-prs base record, then the fail-soft pointer
// activation. A returned error rolls the worktree back.
func (e *engine) prepareWorktree(ctx context.Context, wt, id, change, def, mode string, ladder []depRef, stackedBase string) error {
	if mode == operator.MergeModeCherryPickLadder {
		for _, d := range ladder {
			ancestor, err := e.isAncestor(ctx, wt, d.ref, "HEAD")
			if err != nil {
				return err
			}
			if ancestor {
				continue
			}
			if _, err := e.git(ctx, wt, "cherry-pick", "--no-commit", "origin/"+def+".."+d.ref); err != nil {
				if _, abortErr := e.git(ctx, wt, "cherry-pick", "--abort"); !alreadyApplied(abortErr, "cherry-pick-abort") {
					e.escalate(id, "git cherry-pick --abort failed: "+stderrOf(abortErr))
				}
				return &conflictError{dep: d.id, err: err}
			}
			if _, err := e.git(ctx, wt, "diff", "--cached", "--quiet"); err != nil {
				if !exitCode(err, 1) {
					return fmt.Errorf("git staged diff failed: %w", err)
				}
				if _, cerr := e.git(ctx, wt, "commit", "-m", "operator: cherry-pick "+d.id+" dependency"); cerr != nil {
					return fmt.Errorf("committing the %s dependency: %w", d.id, cerr)
				}
			}
			e.act(ActCherryPicked, id, d.branch)
		}
	}
	if change == "" {
		return nil
	}
	hasFab, err := fabPresent(wt)
	if err != nil {
		return err
	}
	if !hasFab {
		return nil
	}
	if mode == operator.MergeModeStackedPRs && stackedBase != "" {
		if _, err := e.run(ctx, wt, "fab", "status", "set-base-branch", change, stackedBase); err != nil {
			return fmt.Errorf("recording the base branch: %s", stderrOf(err))
		}
	}
	if _, err := e.run(ctx, wt, "fab", "resolve", "--folder", change); err == nil {
		if _, err := e.run(ctx, wt, "fab", "change", "switch", change); err != nil {
			e.escalate(id, "fab change switch failed: "+stderrOf(err))
		}
	} else {
		e.escalate(id, "fab change lookup failed: "+stderrOf(err))
	}
	return nil
}

// errItemRemoved marks an attach whose item was removed (track rm) after the
// pass read it; nothing is written for it.
var errItemRemoved = errors.New("item removed from tracking")

type projectionWriteError struct{ err error }

func (e *projectionWriteError) Error() string { return e.err.Error() }
func (e *projectionWriteError) Unwrap() error { return e.err }

func attachEscalation(pane string, err error) string {
	var projectionErr *projectionWriteError
	if errors.As(err, &projectionErr) {
		return fmt.Sprintf("window %s opened and its engine binding was recorded, but its projection update failed: %v", pane, err)
	}
	return fmt.Sprintf("window %s opened but recording its engine binding failed (scope.spawning left set): %v", pane, err)
}

// attach records the spawn on the item in one locked write: pane, session,
// branch, the branch_map entry, and the cleared spawn marker. The pane-pid
// lookup runs before the lock.
func (e *engine) attach(ctx context.Context, it operator.TrackedItem, repo string, res SpawnResult, session string) error {
	var panePID interface{}
	if pid, err := e.env.Panes.PID(ctx, res.PaneID); err != nil {
		e.escalate(it.ID, "pane fingerprint lookup failed: "+err.Error())
	} else {
		panePID = pid
	}
	if res.Branch != "" && safeBranch(res.Branch) == "" {
		return fmt.Errorf("spawn returned invalid branch %q", res.Branch)
	}
	var bound operator.TrackedItem
	if err := e.mutateEngine(func(st *engineState) error {
		item, ok := st.find(it.ID)
		if !ok {
			return errItemRemoved
		}
		item.Pane, item.Session, item.Worktree, item.Spawning = res.PaneID, session, res.WorktreePath, ""
		if res.Branch != "" {
			item.Branch = res.Branch
		}
		item.UpdatedAt = operator.NowRFC3339()
		bound = item.tracked()
		return nil
	}); err != nil {
		return err
	}
	bound.Scope["repo"] = repo
	bound.Scope["pane_pid"] = panePID
	_, present, err := e.projection(it.ID)
	if err != nil {
		return err
	}
	if !present && scopeBool(bound, scopeProjected) {
		return nil
	}
	if err := e.upsertProjection(bound); err != nil {
		return &projectionWriteError{err: err}
	}
	return nil
}

// respawnItem is the executor of row Q4: a spawned item whose pane is gone
// gets its one existing-branch respawn.
func (e *engine) respawnItem(ctx context.Context, d Decision) error {
	st, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	e.respawn(ctx, st, it, d.fp)
	return nil
}

func (e *engine) respawn(ctx context.Context, st *operator.State, it operator.TrackedItem, fp string) {
	id := it.ID
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	branch := itemBranch(st, it)
	if _, ok := e.checkedBranch(id, branch, "respawn"); !ok {
		return
	}
	// A stacked worker that died before recording its base would otherwise be
	// replaced by one that cuts its change against the default branch.
	stackedBase := ""
	if modeOf(it) == operator.MergeModeStackedPRs {
		b, err := e.stackedBase(ctx, st, repo, sameRepoDeps(st, it))
		if err != nil {
			e.escalate(id, "cannot rebuild the stacked base for the respawn: "+err.Error())
			return
		}
		stackedBase = b
	}
	session, err := e.env.Session(ctx, repo)
	if err != nil {
		e.escalate(id, "no landing session: "+err.Error())
		return
	}
	wt, err := e.worktreeForBranch(ctx, repo, branch)
	if err != nil {
		e.escalate(id, err.Error())
		return
	}
	prompt, err := e.buildPrompt(ctx, it, repo, e.defaultBranch(ctx, repo, id), stackedBase)
	if err != nil {
		e.escalate(id, err.Error())
		return
	}
	req := SpawnRequest{
		Repo: repo, Session: session, WorktreeName: id, CheckoutBranch: branch,
		ExistingWorktree: wt,
		Prompt:           prompt,
		Note:             id + " · respawned",
	}
	e.launch(ctx, it, fp, req, ActRespawned, true)
}
