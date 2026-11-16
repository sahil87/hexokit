package autopilot

import (
	"context"
	"path/filepath"
	"testing"
)

func TestWorktreeForBranchPreservesUnusualPaths(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	for _, name := range []string{`work "quoted" tree`, "work\nnew line", "work-ü-尾 "} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			branch := "branch"
			runGit(t, repo.Dir, "worktree", "add", "-b", branch, path, "main")
			got, err := newEngine(h.env).worktreeForBranch(context.Background(), repo.Dir, branch)
			if err != nil {
				t.Fatal(err)
			}
			if got != path {
				t.Fatalf("path = %q, want %q", got, path)
			}
			runGit(t, repo.Dir, "worktree", "remove", path)
			runGit(t, repo.Dir, "branch", "-D", branch)
		})
	}
	if h.run.called("git worktree list --porcelain -z") != 3 {
		t.Fatal("worktree lookup bypassed the Runner seam")
	}
}
