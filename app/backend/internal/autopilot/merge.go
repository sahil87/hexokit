package autopilot

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"path/filepath"
	"regexp"
	"strings"

	"rk/internal/operator"
)

// MergeOptions are the merge verb's inputs.
type MergeOptions struct {
	// Repo limits the merge to one repo ("" = every repo).
	Repo    string
	RepoSet bool
}

// isChainMode reports whether the mode builds a merge chain.
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

var (
	errNoPinnedRepo = errors.New("github-pr item has no valid pinned owner/name (probe --repo): refusing to act on a PR chosen by a checkout")
	pinnedRepoRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$`)
)

// pinnedRepo is the owner/name a github-pr item was created for: the --repo of
// its probe. scope.repo is a mutable checkout path and never names the PR's
// repository.
func pinnedRepo(it operator.TrackedItem) string {
	argv := it.Probe.Argv
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "--repo" && pinnedRepoRe.MatchString(argv[i+1]) {
			return argv[i+1]
		}
	}
	return ""
}

// pin returns the item's pinned owner/name, escalating (and refusing the
// caller's gh call) when it has none.
func (e *engine) pin(it operator.TrackedItem) (string, bool) {
	nwo := pinnedRepo(it)
	if nwo == "" {
		e.escalate(it.ID, errNoPinnedRepo.Error())
		return "", false
	}
	return nwo, true
}

// prIdentity is what names the PR a github-pr item stands for: its number, its
// pinned owner/name and the checkout the pass runs gh from. An external writer
// can change any of them between a pass's snapshot and its writes.
type prIdentity struct{ pr, nwo, repo string }

func identityOf(it operator.TrackedItem) prIdentity {
	return prIdentity{pr: prNum(it.Scope), nwo: pinnedRepo(it), repo: cleanRepo(operator.ScopeString(it.Scope, "repo"))}
}

// errItemChanged marks a write refused because the item no longer carries what
// the pass observed: external writes win.
var errItemChanged = errors.New("item changed externally")

// withRepo appends `--repo <nwo>` to a gh argv (nothing when nwo is empty).
func withRepo(nwo string, args ...string) []string {
	if nwo == "" {
		return args
	}
	return append(args, "--repo", nwo)
}

// StartMerge writes per-repository PR chains and lifted deferred marks, then
// runs one pass. It accepts stacked-prs, reconstructs explicitly dropped
// sequences (including merge-auto) by clearing pr_dropped, and refuses while
// queue items are not done. Ordinary merge-auto tracking remains Q7's job.
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
			if legacyQueueItem(st, it) && cleanRepo(operator.ScopeString(it.Scope, "repo")) == repoFilter {
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
		if !legacyQueueItem(st, it) || (!isChainMode(modeOf(it)) && !scopeBool(it, scopePRDropped)) || isBare(it) {
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
	if err := e.clearPRDropped(queue); err != nil {
		return e.res, err
	}
	if len(items) > 0 {
		if err := e.addPRItems(items, nil); err != nil {
			return e.res, err
		}
		for _, it := range items {
			e.act(ActPRTracked, operator.ScopeString(it.Scope, scopeItem), it.ID)
		}
	}
	if env.DryRun {
		return e.res, nil
	}
	_, err = e.pass(ctx)
	return e.res, err
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
		v, err := e.viewPR(ctx, repo, "", branch, prViewFields)
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
	return e.mutateEngine(func(st *engineState) error {
		changed := false
		for i := range st.PRs {
			it := &st.PRs[i]
			if it.Deferred && started[it.Item] {
				it.Deferred = false
				changed = true
			}
		}
		if !changed {
			return operator.ErrNoWrite
		}
		return nil
	})
}

func (e *engine) clearPRDropped(queue []operator.TrackedItem) error {
	ids := map[string]bool{}
	for _, item := range queue {
		ids[item.ID] = true
	}
	return e.mutateEngine(func(st *engineState) error {
		changed := false
		for i := range st.Queue {
			if ids[st.Queue[i].ID] && st.Queue[i].PRDropped {
				st.Queue[i].PRDropped = false
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
		"branch": branch, scopeMergeSeq: seq, scopeItem: qi.ID, scopeMergeMode: mode, scopeURL: v.URL,
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
func (e *engine) addPRItems(items []operator.TrackedItem, check func(*operator.State) error) error {
	if err := e.mutateEngine(func(st *engineState) error {
		if check != nil {
			view, _, err := engineView(e.env.StatePath)
			if err != nil {
				return err
			}
			if err := check(view); err != nil {
				return err
			}
		}
		for _, it := range items {
			if st.has(it.ID) {
				current, _ := st.find(it.ID)
				if current.Item == operator.ScopeString(it.Scope, scopeItem) {
					continue
				}
				return fmt.Errorf("engine item %s already exists for another item", it.ID)
			}
			st.upsert(engineItemFromTracked(it, false), true)
		}
		return nil
	}); err != nil {
		return err
	}
	for _, it := range items {
		if err := e.upsertProjection(it); err != nil {
			return err
		}
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
