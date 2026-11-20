package ghhooks

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"

	"rk/internal/cron"
	"rk/internal/operator"
)

// Hit is one live server that tracks the event's PR. PR is the matched PR
// number (0 when the match was by branch alone) and Branch the event's head
// branch.
type Hit struct {
	Server string
	PR     int
	Branch string
}

// Source is everything the mapping reads, injected so tests need no tmux
// server, state home or git checkout.
type Source struct {
	// Servers lists the live tmux servers; a dead server has no operator loop
	// to wake.
	Servers func(ctx context.Context) ([]string, error)
	// State loads a server's operator ledger.
	State func(ctx context.Context, server string) (*operator.State, error)
	// OriginNWO resolves a local checkout path to its GitHub owner/name.
	OriginNWO func(ctx context.Context, dir string) (string, error)
}

// argvRepoFlag names the repo in a github-pr item's probe argv.
const argvRepoFlag = "--repo"

// Match returns the live servers whose ledger tracks the event's PR, at most
// one hit per server, in server order. A server whose ledger cannot be read is
// skipped (the error is the caller's to log through onErr).
//
// A server matches when a tracked item is
//   - a github-pr item pinned (probe argv --repo) to the event's repo whose
//     scope.pr is among the event's PRs, or whose scope.branch is the event's
//     head branch; or
//   - an item carrying a local checkout path (scope.repo) whose branch —
//     branch_map[scope.change], else scope.branch — is the event's head branch
//     and whose checkout's origin is the event's repo. Queue items are these:
//     the ledger holds their projection, whose scope.repo is a path, never an
//     owner/name.
//
// Done items match too: a merge event for a finished item costs one free
// check, and the check is what knows the item is done.
func Match(ctx context.Context, src Source, ev Event, onErr func(server string, err error)) []Hit {
	servers, err := src.Servers(ctx)
	if err != nil {
		if onErr != nil {
			onErr("", err)
		}
		return nil
	}
	origins := map[string]string{}
	resolve := func(dir string) string {
		if nwo, seen := origins[dir]; seen {
			return nwo
		}
		nwo, err := src.OriginNWO(ctx, dir)
		if err != nil {
			nwo = ""
		}
		origins[dir] = nwo
		return nwo
	}
	var hits []Hit
	for _, server := range servers {
		st, err := src.State(ctx, server)
		if err != nil {
			if onErr != nil {
				onErr(server, err)
			}
			continue
		}
		if hit, ok := matchServer(st, ev, resolve); ok {
			hit.Server = server
			hits = append(hits, hit)
		}
	}
	return hits
}

// matchServer returns the best hit in one ledger: a PR-number match over a
// branch-only match, ledger order within each.
func matchServer(st *operator.State, ev Event, resolve func(dir string) string) (Hit, bool) {
	var byBranch *Hit
	for i := range st.Tracked {
		it := &st.Tracked[i]
		if it.Kind == operator.KindGitHubPR {
			if !strings.EqualFold(pinnedRepo(it.Probe.Argv), ev.NWO) {
				continue
			}
			if pr, err := strconv.Atoi(operator.ScopePRNumber(it.Scope)); err == nil && containsInt(ev.PRs, pr) {
				return Hit{PR: pr, Branch: ev.Branch}, true
			}
			if byBranch == nil && ev.Branch != "" && operator.ScopeString(it.Scope, "branch") == ev.Branch {
				byBranch = &Hit{Branch: ev.Branch}
			}
			continue
		}
		if byBranch != nil || ev.Branch == "" {
			continue
		}
		dir := operator.ScopeString(it.Scope, "repo")
		if !filepath.IsAbs(dir) || itemBranch(st, it) != ev.Branch {
			continue
		}
		if strings.EqualFold(resolve(dir), ev.NWO) {
			byBranch = &Hit{Branch: ev.Branch}
		}
	}
	if byBranch != nil {
		return *byBranch, true
	}
	return Hit{}, false
}

// itemBranch is the branch an item's change has checked out: the check
// records the real one under the change id in branch_map, since /fab-new
// renames the spawn-time branch; scope.branch is the fallback.
func itemBranch(st *operator.State, it *operator.TrackedItem) string {
	if change := operator.ScopeString(it.Scope, "change"); change != "" {
		if entry, ok := st.BranchMap[change]; ok && entry.Branch != "" {
			return entry.Branch
		}
	}
	return operator.ScopeString(it.Scope, "branch")
}

// pinnedRepo is the owner/name a github-pr probe is pinned to.
func pinnedRepo(argv []string) string {
	for i, a := range argv {
		if a == argvRepoFlag && i+1 < len(argv) {
			return argv[i+1]
		}
		if v, ok := strings.CutPrefix(a, argvRepoFlag+"="); ok {
			return v
		}
	}
	return ""
}

func containsInt(list []int, n int) bool {
	for _, v := range list {
		if v == n {
			return true
		}
	}
	return false
}

// Reason is the wake reason for a hit: pr:<nwo>#<n>:<event>, the branch
// standing in for <n> when no PR number matched. It is cut to the marker's
// reason limit rather than rejected: a long branch name must not cost the
// trigger.
func Reason(ev Event, hit Hit) string {
	ref := strconv.Itoa(hit.PR)
	if hit.PR == 0 {
		ref = hit.Branch
	}
	r := []rune("pr:" + ev.NWO + "#" + ref + ":" + ev.Name)
	if len(r) > cron.MaxWakeReasonRunes {
		r = r[:cron.MaxWakeReasonRunes]
	}
	return string(r)
}
