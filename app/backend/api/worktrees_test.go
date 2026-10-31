package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseWorktrees(t *testing.T) {
	porcelain := "worktree /home/u/code/hexokit\nHEAD aaa\nbranch refs/heads/main\n\n" +
		"worktree /home/u/code/hexokit.worktrees/feat\nHEAD bbb\nbranch refs/heads/feat/x\n\n" +
		"worktree /home/u/code/hexokit.worktrees/loose\nHEAD ccc\ndetached\n"

	got := parseWorktrees(porcelain)

	if got.Repo != "hexokit" {
		t.Errorf("repo = %q, want hexokit", got.Repo)
	}
	want := []worktreeEntry{
		{Path: "/home/u/code/hexokit", Branch: "main"},
		{Path: "/home/u/code/hexokit.worktrees/feat", Branch: "feat/x"},
		{Path: "/home/u/code/hexokit.worktrees/loose", Branch: ""},
	}
	if !reflect.DeepEqual(got.Worktrees, want) {
		t.Errorf("worktrees = %+v, want %+v", got.Worktrees, want)
	}
}

func TestParseWorktreesBareMainNamesRepoAndIsSkipped(t *testing.T) {
	porcelain := "worktree /srv/git/proj.git\nbare\n\nworktree /home/u/proj-feat\nHEAD ddd\nbranch refs/heads/feat\n"

	got := parseWorktrees(porcelain)

	if got.Repo != "proj" {
		t.Errorf("repo = %q, want proj", got.Repo)
	}
	if len(got.Worktrees) != 1 || got.Worktrees[0].Path != "/home/u/proj-feat" {
		t.Errorf("worktrees = %+v, want only the linked one", got.Worktrees)
	}
}

func TestParseWorktreesEmpty(t *testing.T) {
	got := parseWorktrees("")
	if got.Repo != "" || got.Worktrees == nil || len(got.Worktrees) != 0 {
		t.Errorf("got %+v, want empty non-nil list", got)
	}
}

func getWorktrees(t *testing.T, path string) (*httptest.ResponseRecorder, worktreesResponse) {
	t.Helper()
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees?path="+url.QueryEscape(path), nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var body worktreesResponse
	if rec.Code == http.StatusOK {
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
	return rec, body
}

func runGit(t *testing.T, dir string, args ...string) {
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

func TestWorktreesRepoWithLinkedWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)

	repo := filepath.Join(home, "proj")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "init", "-b", "main")
	runGit(t, repo, "commit", "--allow-empty", "-m", "init")
	linked := filepath.Join(home, "proj-feat")
	runGit(t, repo, "worktree", "add", "-b", "feat", linked)

	// Asking from the linked worktree must still name the MAIN repo.
	for _, from := range []string{repo, linked} {
		rec, got := getWorktrees(t, from)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got.Repo != "proj" {
			t.Errorf("from %s: repo = %q, want proj", from, got.Repo)
		}
		branches := map[string]string{}
		for _, wt := range got.Worktrees {
			branches[filepath.Base(wt.Path)] = wt.Branch
		}
		if branches["proj"] != "main" || branches["proj-feat"] != "feat" {
			t.Errorf("from %s: branches = %v", from, branches)
		}
	}
}

func TestWorktreesNonRepoIsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, "plain")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	rec, got := getWorktrees(t, dir)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got.Repo != "" || len(got.Worktrees) != 0 {
		t.Errorf("got %+v, want empty", got)
	}
}

func TestWorktreesEmptyPathIsEmpty(t *testing.T) {
	rec, got := getWorktrees(t, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if len(got.Worktrees) != 0 {
		t.Errorf("worktrees = %v, want empty", got.Worktrees)
	}
}

func TestWorktreesInvalidPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, bad := range []string{"~/a\nb", "/etc"} {
		rec, _ := getWorktrees(t, bad)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: status = %d, want 400", bad, rec.Code)
		}
	}
}
