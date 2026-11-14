package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"rk/internal/operator"
)

// repoMeta is what the engine learns once per repo per verb.
type repoMeta struct {
	defaultBranch string
	nwo           string
}

// cleanRepo normalizes a repo path for comparison.
func cleanRepo(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Clean(p)
}

// validateRepo checks a repo path before any subprocess runs against it: an
// absolute path that is the top level of a git working tree.
func (e *engine) validateRepo(ctx context.Context, repo string) error {
	if repo == "" {
		return fmt.Errorf("repo is empty")
	}
	if !filepath.IsAbs(repo) {
		return fmt.Errorf("repo %q must be an absolute path", repo)
	}
	if strings.ContainsRune(repo, 0) || strings.HasPrefix(filepath.Base(repo), "-") {
		return fmt.Errorf("repo %q is not a valid path", repo)
	}
	if fi, err := os.Stat(repo); err != nil || !fi.IsDir() {
		return fmt.Errorf("repo %q is not a directory", repo)
	}
	top, err := e.git(ctx, repo, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("repo %q is not a git repository", repo)
	}
	if !samePath(top, repo) {
		return fmt.Errorf("repo %q is not a git root (top level is %s)", repo, top)
	}
	return nil
}

func samePath(a, b string) bool {
	if ra, err := filepath.EvalSymlinks(a); err == nil {
		a = ra
	}
	if rb, err := filepath.EvalSymlinks(b); err == nil {
		b = rb
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// defaultBranch resolves the repo's default branch: origin/HEAD when it
// verifies, else the GitHub default, else main or master by which exists on
// origin. It runs after a successful fetch.
func (e *engine) defaultBranch(ctx context.Context, repo string) string {
	if m := e.meta[repo]; m != nil && m.defaultBranch != "" {
		return m.defaultBranch
	}
	branch := ""
	if out, err := e.git(ctx, repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		cand := strings.TrimPrefix(out, "origin/")
		if _, verr := e.git(ctx, repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+cand); verr == nil && cand != "" {
			branch = cand
		}
	}
	if branch == "" {
		if out, err := e.gh(ctx, repo, "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"); err == nil {
			branch = strings.TrimSpace(out)
		}
	}
	if branch == "" {
		branch = "master"
		if _, err := e.git(ctx, repo, "rev-parse", "--verify", "-q", "origin/main"); err == nil {
			branch = "main"
		}
	}
	e.metaFor(repo).defaultBranch = branch
	return branch
}

func (e *engine) metaFor(repo string) *repoMeta {
	m := e.meta[repo]
	if m == nil {
		m = &repoMeta{}
		e.meta[repo] = m
	}
	return m
}

// nameWithOwner resolves the repo's owner/name for a github-pr probe's --repo.
// A failure is "" and the probe argv omits --repo.
func (e *engine) nameWithOwner(ctx context.Context, repo string) string {
	if m := e.meta[repo]; m != nil && m.nwo != "" {
		return m.nwo
	}
	out, err := e.gh(ctx, repo, "repo", "view", "--json", "nameWithOwner")
	if err != nil {
		return ""
	}
	var v struct {
		NameWithOwner string `json:"nameWithOwner"`
	}
	if json.Unmarshal([]byte(out), &v) != nil {
		return ""
	}
	e.metaFor(repo).nwo = v.NameWithOwner
	return v.NameWithOwner
}

// safeBranch returns name when it is safe to hand to git and gh as an argv
// element, else "". The state file is shared with other writers, so a branch
// read from it is validated like user input: no leading '-' (an option), no
// whitespace, control or ref-syntax characters, no "..".
func safeBranch(name string) string {
	if name == "" || strings.HasPrefix(name, "-") || strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") {
		return ""
	}
	for _, r := range name {
		if r <= ' ' || r == 0x7f || strings.ContainsRune("~^:?*[\\", r) {
			return ""
		}
	}
	return name
}

// prNum reads scope.pr as a PR number: digits only, else "" (a string from
// hand-edited YAML must never reach gh as an option).
func prNum(scope map[string]interface{}) string {
	n := operator.ScopePRNumber(scope)
	for _, r := range n {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return n
}

// changeIDRe is the shape of a fab change reference (an id or a folder name).
var changeIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// depBranch resolves a dependency's branch: its own scope.branch, else the
// branch_map entry keyed by its id or change.
func depBranch(st *operator.State, dep operator.TrackedItem) string {
	if b := operator.ScopeString(dep.Scope, "branch"); b != "" {
		return safeBranch(b)
	}
	for _, key := range []string{operator.ScopeString(dep.Scope, "change"), dep.ID} {
		if key == "" {
			continue
		}
		if be, ok := st.BranchMap[key]; ok && be.Branch != "" {
			return safeBranch(be.Branch)
		}
	}
	return ""
}

// itemBranch is depBranch for the item itself.
func itemBranch(st *operator.State, it operator.TrackedItem) string { return depBranch(st, it) }

// worktreeForBranch returns the path of the worktree that has branch checked
// out ("" when none), from `git worktree list --porcelain`.
func (e *engine) worktreeForBranch(ctx context.Context, repo, branch string) string {
	out, err := e.git(ctx, repo, "worktree", "list", "--porcelain")
	if err != nil {
		return ""
	}
	var path string
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			path = strings.TrimPrefix(line, "worktree ")
		case line == "branch refs/heads/"+branch:
			return path
		}
	}
	return ""
}

// resolveRef returns the commit-ish for a branch: the local head, else the
// remote-tracking one.
func (e *engine) resolveRef(ctx context.Context, dir, branch string) (string, bool) {
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if _, err := e.git(ctx, dir, "rev-parse", "--verify", "-q", ref); err == nil {
			return ref, true
		}
	}
	return "", false
}

// isAncestor reports whether a is an ancestor of b (equal counts).
func (e *engine) isAncestor(ctx context.Context, dir, a, b string) bool {
	_, err := e.git(ctx, dir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}
