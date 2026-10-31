package gitinfo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const porcelainMixed = "worktree /home/u/code/hexokit\nHEAD aaa\nbranch refs/heads/main\n\n" +
	"worktree /home/u/code/hexokit.worktrees/feat\nHEAD bbb\nbranch refs/heads/feat/x\n\n" +
	"worktree /home/u/code/hexokit.worktrees/loose\nHEAD ccc\ndetached\n"

func TestParseWorktreesNewlineAndNUL(t *testing.T) {
	want := []Worktree{
		{Path: "/home/u/code/hexokit", Branch: "main"},
		{Path: "/home/u/code/hexokit.worktrees/feat", Branch: "feat/x"},
		{Path: "/home/u/code/hexokit.worktrees/loose", Branch: ""},
	}
	// -z output: every field NUL-terminated, records separated by an empty field.
	nul := strings.ReplaceAll(strings.ReplaceAll(porcelainMixed, "\n\n", "\x00\x00"), "\n", "\x00")

	for name, c := range map[string]struct{ raw, sep string }{
		"newline": {porcelainMixed, "\n"},
		"nul":     {nul, "\x00"},
	} {
		got := ParseWorktrees(c.raw, c.sep)
		if got.Repo != "hexokit" {
			t.Errorf("%s: repo = %q, want hexokit", name, got.Repo)
		}
		if !reflect.DeepEqual(got.Worktrees, want) {
			t.Errorf("%s: worktrees = %+v, want %+v", name, got.Worktrees, want)
		}
	}
}

func TestParseWorktreesKeepsNewlineInsidePathUnderNUL(t *testing.T) {
	raw := "worktree /home/u/a\x00HEAD aaa\x00branch refs/heads/main\x00\x00" +
		"worktree /home/u/we\nird\x00HEAD bbb\x00branch refs/heads/x\x00\x00"
	got := ParseWorktrees(raw, "\x00")
	if len(got.Worktrees) != 2 || got.Worktrees[1].Path != "/home/u/we\nird" {
		t.Errorf("worktrees = %+v", got.Worktrees)
	}
}

func TestParseWorktreesDecodesQuotedPathWithoutNUL(t *testing.T) {
	// git without -z C-quotes non-ASCII bytes as octal escapes: "café" → "caf\303\251".
	raw := "worktree \"/home/u/caf\\303\\251\"\nHEAD aaa\nbranch refs/heads/main\n"
	got := ParseWorktrees(raw, "\n")
	if len(got.Worktrees) != 1 || got.Worktrees[0].Path != "/home/u/café" {
		t.Errorf("worktrees = %+v, want the decoded /home/u/café", got.Worktrees)
	}
	// Under -z git never quotes, so a leading quote is part of the real name.
	nul := "worktree \"odd\x00HEAD aaa\x00branch refs/heads/main\x00"
	if got := ParseWorktrees(nul, "\x00"); got.Worktrees[0].Path != `"odd` {
		t.Errorf("nul path = %q, want it untouched", got.Worktrees[0].Path)
	}
}

func TestParseWorktreesSkipsBareAndPrunableKeepsLocked(t *testing.T) {
	raw := "worktree /srv/git/proj.git\nbare\n\n" +
		"worktree /home/u/gone\nHEAD ddd\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n\n" +
		"worktree /home/u/held\nHEAD eee\nbranch refs/heads/held\nlocked in use\n\n" +
		"worktree /home/u/held2\nHEAD fff\nbranch refs/heads/held2\nlocked\n"

	got := ParseWorktrees(raw, "\n")

	if got.Repo != "proj" {
		t.Errorf("repo = %q, want proj (bare main names the repo)", got.Repo)
	}
	paths := []string{}
	for _, wt := range got.Worktrees {
		paths = append(paths, wt.Path)
	}
	if !reflect.DeepEqual(paths, []string{"/home/u/held", "/home/u/held2"}) {
		t.Errorf("paths = %v, want only the locked ones", paths)
	}
}

func TestParseWorktreesEmpty(t *testing.T) {
	got := ParseWorktrees("", "\n")
	if got.Repo != "" || got.Worktrees == nil || len(got.Worktrees) != 0 {
		t.Errorf("got %+v, want empty non-nil list", got)
	}
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestListWorktreesRealRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "proj")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, repo, "init", "-b", "main")
	gitIn(t, repo, "commit", "--allow-empty", "-m", "init")
	linked := filepath.Join(root, "proj-feat")
	gitIn(t, repo, "worktree", "add", "-b", "feat", linked)
	gone := filepath.Join(root, "proj-gone")
	gitIn(t, repo, "worktree", "add", "-b", "gone", gone)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	// From the main worktree and from a linked one the answer is the same, and
	// the deleted (prunable) worktree is not offered.
	for _, from := range []string{repo, linked} {
		got := ListWorktrees(context.Background(), from)
		if got.Repo != "proj" {
			t.Errorf("from %s: repo = %q, want proj", from, got.Repo)
		}
		branches := map[string]string{}
		for _, wt := range got.Worktrees {
			branches[filepath.Base(wt.Path)] = wt.Branch
		}
		want := map[string]string{"proj": "main", "proj-feat": "feat"}
		if !reflect.DeepEqual(branches, want) {
			t.Errorf("from %s: branches = %v, want %v", from, branches, want)
		}
	}
}

func TestListWorktreesNonRepoIsEmpty(t *testing.T) {
	got := ListWorktrees(context.Background(), t.TempDir())
	if got.Repo != "" || len(got.Worktrees) != 0 || got.Worktrees == nil {
		t.Errorf("got %+v, want empty non-nil list", got)
	}
}

func TestExitCodeReadsOnlyExitErrors(t *testing.T) {
	if got := exitCode(nil); got != -1 {
		t.Errorf("exitCode(nil) = %d, want -1", got)
	}
	err := exec.Command("sh", "-c", "exit 129").Run()
	if got := exitCode(err); got != gitUsageExit {
		t.Errorf("exitCode(exit 129) = %d, want %d", got, gitUsageExit)
	}
	// A non-repo folder is git's 128, which must not trigger the -z retry.
	err = exec.Command("git", "-C", t.TempDir(), "worktree", "list", "--porcelain", "-z").Run()
	if got := exitCode(err); got == gitUsageExit {
		t.Errorf("non-repo exit = %d, must not look like a usage error", got)
	}
}
