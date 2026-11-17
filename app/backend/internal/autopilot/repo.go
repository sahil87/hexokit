package autopilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"rk/internal/gitinfo"
	"rk/internal/operator"
)

// repoMeta is what the engine learns once per repo per verb.
type repoMeta struct {
	defaultBranch      string
	defaultBranchKnown bool
	nwo                string
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
func (e *engine) defaultBranch(ctx context.Context, repo, id string) string {
	if m := e.meta[repo]; m != nil && m.defaultBranch != "" {
		return m.defaultBranch
	}
	branch := ""
	known := false
	if out, err := e.git(ctx, repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		cand := strings.TrimPrefix(out, "origin/")
		if _, verr := e.git(ctx, repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+cand); verr == nil && cand != "" {
			branch, known = cand, true
		} else if verr != nil && !exitCode(verr, 1) {
			e.escalate(id, "default branch verification failed: "+stderrOf(verr))
		}
	} else if !exitCode(err, 1) {
		e.escalate(id, "origin/HEAD lookup failed: "+stderrOf(err))
	}
	if branch == "" {
		if out, err := e.gh(ctx, repo, "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"); err == nil {
			branch = strings.TrimSpace(out)
			known = branch != ""
		} else {
			e.escalate(id, "GitHub default branch lookup failed: "+stderrOf(err))
		}
	}
	if branch == "" {
		branch = "master"
		if _, err := e.git(ctx, repo, "rev-parse", "--verify", "-q", "origin/main"); err == nil {
			branch = "main"
		} else if !exitCode(err, 1) {
			e.escalate(id, "origin/main lookup failed: "+stderrOf(err))
		} else if _, masterErr := e.git(ctx, repo, "rev-parse", "--verify", "-q", "origin/master"); masterErr != nil && !exitCode(masterErr, 1) {
			e.escalate(id, "origin/master lookup failed: "+stderrOf(masterErr))
		}
	}
	e.metaFor(repo).defaultBranch = branch
	e.metaFor(repo).defaultBranchKnown = known
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
// Failure must refuse probe creation: an ambient repo could observe another PR.
func (e *engine) nameWithOwner(ctx context.Context, repo string) (string, error) {
	if m := e.meta[repo]; m != nil && m.nwo != "" {
		return m.nwo, nil
	}
	out, err := e.gh(ctx, repo, "repo", "view", "--json", "nameWithOwner")
	if err != nil {
		return "", fmt.Errorf("cannot resolve owner/name for %s: %w", repo, err)
	}
	var v struct {
		NameWithOwner string `json:"nameWithOwner"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return "", fmt.Errorf("cannot resolve owner/name for %s: %w", repo, err)
	}
	if v.NameWithOwner == "" {
		return "", fmt.Errorf("cannot resolve owner/name for %s: empty nameWithOwner", repo)
	}
	e.metaFor(repo).nwo = v.NameWithOwner
	return v.NameWithOwner, nil
}

// safeBranch returns name when it is a valid branch name, else "": the rules of
// `git check-ref-format --branch`, which also keeps a leading '-' (an option)
// and every ref-syntax or whitespace character out of the argv of git, gh and
// wt. The state file is shared with other writers, so a branch read from it is
// validated like user input. A test pins this to the real git.
func safeBranch(name string) string {
	if !validBranchName(name) {
		return ""
	}
	return name
}

func validBranchName(name string) bool {
	if name == "" || name == "@" || name == "HEAD" || strings.HasPrefix(name, "-") ||
		strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".") ||
		strings.Contains(name, "..") || strings.Contains(name, "@{") || strings.Contains(name, "//") {
		return false
	}
	for _, r := range name {
		if r < ' ' || r == 0x7f || strings.ContainsRune(" ~^:?*[\\", r) {
			return false
		}
	}
	for _, comp := range strings.Split(name, "/") {
		if strings.HasPrefix(comp, ".") || strings.HasSuffix(comp, ".lock") {
			return false
		}
	}
	return true
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
	if raw := dep.Scope["branch"]; raw != nil && raw != "" {
		return safeBranch(operator.ScopeString(dep.Scope, "branch"))
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
// out ("" when none). NUL delimiters preserve quotes, spaces and newlines.
func (e *engine) worktreeForBranch(ctx context.Context, repo, branch string) (string, error) {
	if safeBranch(branch) == "" {
		return "", fmt.Errorf("invalid or empty worktree branch %q", branch)
	}
	out, err := e.run(ctx, repo, "git", "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return "", fmt.Errorf("git worktree list failed: %w", err)
	}
	for _, wt := range gitinfo.ParseWorktrees(out, "\x00").Worktrees {
		if wt.Branch == branch {
			return wt.Path, nil
		}
	}
	return "", nil
}

// resolveRef returns the commit-ish for a branch: the local head, else the
// remote-tracking one.
func (e *engine) resolveRef(ctx context.Context, dir, branch string) (string, error) {
	if safeBranch(branch) == "" {
		return "", fmt.Errorf("invalid or empty branch %q", branch)
	}
	for _, ref := range []string{"refs/heads/" + branch, "refs/remotes/origin/" + branch} {
		if _, err := e.git(ctx, dir, "rev-parse", "--verify", "-q", ref); err == nil {
			return ref, nil
		} else if !exitCode(err, 1) {
			return "", fmt.Errorf("git ref lookup for %s failed: %w", branch, err)
		}
	}
	return "", fmt.Errorf("branch %s not found in %s", branch, dir)
}

// isAncestor reports whether a is an ancestor of b (equal counts).
func (e *engine) isAncestor(ctx context.Context, dir, a, b string) (bool, error) {
	_, err := e.git(ctx, dir, "merge-base", "--is-ancestor", a, b)
	if err != nil && !exitCode(err, 1) {
		return false, fmt.Errorf("git ancestry lookup failed: %w", err)
	}
	return err == nil, nil
}

// Exit 1 is a normal negative result for quiet ref, ancestry and diff probes.
func exitCode(err error, code int) bool {
	var ex *exec.ExitError
	return errors.As(err, &ex) && ex.ExitCode() == code
}

func (e *engine) checkedBranch(id, branch, role string) (string, bool) {
	if safeBranch(branch) == "" {
		e.escalate(id, fmt.Sprintf("invalid or empty %s branch %q", role, branch))
		return "", false
	}
	return branch, true
}

// New spawns need not have an existing branch. If shared state does supply one,
// it must be valid; dependency code always needs a resolvable branch name.
func (e *engine) validateSpawnBranches(st *operator.State, it operator.TrackedItem) bool {
	if it.Scope["branch"] != nil && it.Scope["branch"] != "" {
		if _, ok := e.checkedBranch(it.ID, operator.ScopeString(it.Scope, "branch"), "item"); !ok {
			return false
		}
	}
	for _, key := range []string{it.ID, operator.ScopeString(it.Scope, "change")} {
		if entry, ok := st.BranchMap[key]; key != "" && ok {
			if _, ok := e.checkedBranch(it.ID, entry.Branch, "branch_map"); !ok {
				return false
			}
		}
	}
	if modeOf(it) == operator.MergeModeCherryPickLadder || modeOf(it) == operator.MergeModeStackedPRs {
		for _, dep := range sameRepoDeps(st, it) {
			if _, ok := e.checkedBranch(it.ID, depBranch(st, dep), "dependency "+dep.ID); !ok {
				return false
			}
		}
	}
	return true
}
