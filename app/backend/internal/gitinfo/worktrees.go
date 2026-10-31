package gitinfo

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// worktreesTimeout bounds the one `git worktree list` call so a wedged
// filesystem or a held lock cannot pin a request goroutine.
const worktreesTimeout = 5 * time.Second

// Worktree is one checked-out worktree of a repository. Branch is empty for a
// detached HEAD.
type Worktree struct {
	Path   string
	Branch string
}

// WorktreeList is a repository's live worktrees plus the repository's name.
type WorktreeList struct {
	Repo      string
	Worktrees []Worktree
}

// gitUsageExit is git's exit status for an unknown option — what git older
// than 2.36 answers to `-z`. A non-repo folder exits 128 and is not retried.
const gitUsageExit = 129

func exitCode(err error) int {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

// ListWorktrees lists the worktrees of the repository containing dir. A dir
// outside any repository (or an unreadable one) is not an error for callers
// that only want folders to offer: it returns an empty list.
//
// This reads `git worktree list` directly rather than wrapping fab-kit's
// `wt list`: the read is cheap and side-effect free, and `wt` is an optional
// tool that may be absent on a host. `-z` keeps a path containing a newline
// intact; git older than 2.36 rejects it (usage exit), so the call retries
// without only then.
func ListWorktrees(ctx context.Context, dir string) WorktreeList {
	ctx, cancel := context.WithTimeout(ctx, worktreesTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain", "-z").Output()
	sep := "\x00"
	if exitCode(err) == gitUsageExit {
		out, err = exec.CommandContext(ctx, "git", "-C", dir, "worktree", "list", "--porcelain").Output()
		sep = "\n"
	}
	if err != nil {
		return WorktreeList{Worktrees: []Worktree{}}
	}
	return ParseWorktrees(string(out), sep)
}

// ParseWorktrees reads `git worktree list --porcelain` output whose fields
// are separated by sep ("\n", or "\x00" under -z): records of `worktree
// <path>`, `HEAD <sha>`, then `branch refs/heads/<name>`, `detached` or
// `bare`, optionally `locked` / `prunable <reason>`, separated by an empty
// field. The first record is the main worktree, whose basename names the repo
// (a linked worktree's own toplevel would mislabel it). Bare and prunable
// records are skipped from the list — a prunable worktree's directory is
// already gone, so offering it would create at a dead cwd — while locked ones
// stay. A detached HEAD carries an empty branch.
func ParseWorktrees(porcelain, sep string) WorktreeList {
	list := WorktreeList{Worktrees: []Worktree{}}
	var cur *Worktree
	skip := false
	first := true

	flush := func() {
		if cur == nil {
			return
		}
		if first {
			list.Repo = strings.TrimSuffix(filepath.Base(cur.Path), ".git")
			first = false
		}
		if !skip {
			list.Worktrees = append(list.Worktrees, *cur)
		}
		cur, skip = nil, false
	}

	for _, field := range strings.Split(porcelain, sep) {
		switch {
		case strings.HasPrefix(field, "worktree "):
			flush()
			cur = &Worktree{Path: strings.TrimPrefix(field, "worktree ")}
		case cur != nil && strings.HasPrefix(field, "branch "):
			cur.Branch = strings.TrimPrefix(strings.TrimPrefix(field, "branch "), "refs/heads/")
		case cur != nil && (field == "bare" || field == "prunable" || strings.HasPrefix(field, "prunable ")):
			skip = true
		}
	}
	flush()
	return list
}
