package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

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
	gone := filepath.Join(home, "proj-gone")
	runGit(t, repo, "worktree", "add", "-b", "gone", gone)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}
	// A worktree outside $HOME is dropped: the create endpoints reject it.
	outside := filepath.Join(t.TempDir(), "proj-outside")
	runGit(t, repo, "worktree", "add", "-b", "outside", outside)

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
		want := map[string]string{"proj": "main", "proj-feat": "feat"}
		if len(branches) != len(want) || branches["proj"] != "main" || branches["proj-feat"] != "feat" {
			t.Errorf("from %s: branches = %v, want %v (prunable and outside-home dropped)", from, branches, want)
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
