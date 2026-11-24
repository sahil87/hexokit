package autopilot

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"rk/internal/operator"
	"rk/internal/validate"
)

// The tracked PR is an ordinary github-pr ledger item. These are its fixed
// parts; the engine reads the PR and tracks it, and never readies, arms or
// merges it.
const (
	prTrackCheckEvery = "5m"
	prTrackThen       = "merge-auto: ready and merge this PR when its required checks are green"
	// scopeSourceItem names the queue item a projected PR belongs to: the
	// authority for merging it is that item's merge mode.
	scopeSourceItem = "item"
	// pr_tracked values when the PR needed no ledger item.
	prTrackedMerged = "merged"
	prTrackedClosed = "closed"
)

// prTrackFields are the probe fields. mergeStateStatus is the one scalar that
// moves when required checks turn green; state, mergeable and isDraft do not.
var prTrackFields = []string{"state", "mergedAt", "mergeable", "isDraft", "mergeStateStatus"}

// nameWithOwner resolves the repo's owner/name through the engine runner,
// once per repo.
func (e *engine) nameWithOwner(ctx context.Context, repo string) (string, error) {
	if m := e.meta[repo]; m != nil && m.nwo != "" {
		return m.nwo, nil
	}
	out, err := e.gh(ctx, repo, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
	if err != nil {
		return "", errors.New(stderrOf(err))
	}
	nwo := strings.TrimSpace(out)
	if msg := validate.ValidateGitHubRepo(nwo); msg != "" {
		return "", fmt.Errorf("gh returned %q: %s", nwo, msg)
	}
	e.metaFor(repo).nwo = nwo
	return nwo, nil
}

// trackPR handles the PR of a done merge-auto item: nothing while it has no PR
// (the next pass retries), a marker alone for a PR that already ended, and a
// github-pr ledger item for an open one. Every failure leaves the marker unset
// so a later pass retries.
func (e *engine) trackPR(ctx context.Context, d Decision) error {
	st, err := e.load(d.Item)
	if err != nil {
		return nil
	}
	i := operator.IndexOf(st.Tracked, d.Item)
	if i < 0 {
		e.escalate(d.Item, changedText(d.Item))
		return nil
	}
	it := st.Tracked[i]
	repo, branch := cleanRepo(operator.ScopeString(it.Scope, "repo")), itemBranch(st, it)
	switch {
	case repo == "":
		e.escalate(d.Item, "cannot track PR: no repo recorded")
		return nil
	case branch == "":
		e.escalate(d.Item, "cannot track PR: no branch recorded")
		return nil
	}
	v, err := e.viewPR(ctx, repo, branch, "number,url,state")
	if err != nil {
		if !noPRFound(err) {
			e.escalate(d.Item, "PR lookup failed: "+stderrOf(err))
		}
		return nil
	}
	switch strings.ToUpper(v.State) {
	case "MERGED":
		return e.markPRTracked(d.Item, prTrackedMerged)
	case "CLOSED":
		return e.markPRTracked(d.Item, prTrackedClosed)
	case "OPEN":
		return e.projectPR(ctx, it, v)
	}
	return nil
}

// projectPR adds the open PR as a ledger item, then marks the queue item. The
// marker is written only after the ledger write succeeded.
func (e *engine) projectPR(ctx context.Context, it operator.TrackedItem, v prView) error {
	repo := operator.ScopeString(it.Scope, "repo")
	if v.Number <= 0 {
		e.escalate(it.ID, "PR lookup failed: no PR number")
		return nil
	}
	nwo, err := e.nameWithOwner(ctx, repo)
	if err != nil {
		e.escalate(it.ID, "PR repo lookup failed: "+err.Error())
		return nil
	}
	id, err := e.addPRProjection(it, v.Number, nwo)
	if err != nil {
		e.writeFailed(it.ID, "PR item not written", err)
		if errors.Is(err, errItemChanged) {
			return nil
		}
		return err
	}
	if err := e.markPRTracked(it.ID, id); err != nil {
		return err
	}
	e.act(ActPRTracked, it.ID, id)
	return nil
}

// addPRProjection writes the github-pr item in one locked ledger write and
// returns its id. A github-pr item already tracking the same repo and PR is
// reused. The write is refused when the source queue item left the engine file.
func (e *engine) addPRProjection(src operator.TrackedItem, number int, nwo string) (string, error) {
	repo := operator.ScopeString(src.Scope, "repo")
	var id string
	err := operator.Mutate(e.env.StatePath, func(st *operator.State) error {
		es, err := loadEngineFile(e.env.StatePath)
		if err != nil {
			return err
		}
		if !es.has(src.ID) {
			return errItemChanged
		}
		if existing := trackedPRItem(st, repo, number); existing != "" {
			id = existing
			return operator.ErrNoWrite
		}
		id = freePRItemID(st, es, repo, number)
		it, err := newPRTrackItem(id, src, number, nwo)
		if err != nil {
			return err
		}
		st.Tracked = append(st.Tracked, it)
		return nil
	})
	return id, err
}

// newPRTrackItem builds the tracked item for a queue item's open PR.
func newPRTrackItem(id string, src operator.TrackedItem, number int, nwo string) (operator.TrackedItem, error) {
	scope := map[string]interface{}{
		"repo": operator.ScopeString(src.Scope, "repo"), "pr": number,
		"change": operator.ScopeString(src.Scope, "change"), scopeSourceItem: src.ID,
	}
	it, err := operator.NewGitHubPRItem(id, nil, scope, nwo)
	if err != nil {
		return it, err
	}
	every, then := prTrackCheckEvery, prTrackThen
	it.Probe.Argv = []string{"gh", "pr", "view", strconv.Itoa(number), "--repo", nwo, "--json", strings.Join(prTrackFields, ",")}
	it.Probe.Fields = append([]string(nil), prTrackFields...)
	it.CheckEvery = &every
	it.Then = &then
	return it, nil
}

// trackedPRItem returns the id of a github-pr item already tracking the PR
// ("" when none).
func trackedPRItem(st *operator.State, repo string, number int) string {
	want := strconv.Itoa(number)
	for _, it := range st.Tracked {
		if it.Kind != operator.KindGitHubPR || operator.ScopePRNumber(it.Scope) != want {
			continue
		}
		if other := operator.ScopeString(it.Scope, "repo"); other != "" && repo != "" && samePath(other, repo) {
			return it.ID
		}
	}
	return ""
}

// freePRItemID is pr-<n>, else pr-<repo base>-<n>, else that with -2, -3, …
// until no ledger item and no queue item carries it: a ledger item with a
// queue item's id would overlay its facts onto the queue item.
func freePRItemID(st *operator.State, es *engineState, repo string, number int) string {
	taken := func(id string) bool { return operator.IndexOf(st.Tracked, id) >= 0 || es.has(id) }
	id := fmt.Sprintf("pr-%d", number)
	if !taken(id) {
		return id
	}
	base := fmt.Sprintf("pr-%s-%d", filepath.Base(repo), number)
	id = base
	for n := 2; taken(id); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	return id
}

// markPRTracked records what handled the item's PR. It is an engine-file
// write with no fingerprint, so it holds even when the item changed after
// the pass observed it.
func (e *engine) markPRTracked(id, value string) error {
	return e.mutateEngine(func(st *engineState) error {
		item, ok := st.find(id)
		if !ok {
			return fmt.Errorf("item %s is no longer in the engine state", id)
		}
		if item.PRTracked == value {
			return operator.ErrNoWrite
		}
		item.PRTracked = value
		return nil
	})
}
