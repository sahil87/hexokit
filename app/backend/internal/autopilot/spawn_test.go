package autopilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operator"
	"rk/internal/riff"
)

func TestSpawnPinsFetchedTipNotStaleLocalHead(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	tip := foo.advanceOrigin("x.txt", "1\n")
	local := runGit(t, foo.Dir, "rev-parse", "HEAD")
	if local == tip {
		t.Fatal("fixture: local HEAD must lag origin")
	}

	res := h.step()
	if len(h.spawn.reqs) != 1 {
		t.Fatalf("spawn requests = %d, want 1 (%+v)", len(h.spawn.reqs), res)
	}
	if got := h.spawn.reqs[0].BaseSHA; got != tip {
		t.Fatalf("BaseSHA = %s, want the fetched origin tip %s (local HEAD %s)", got, tip, local)
	}
	if got := runGit(t, foo.Dir, "rev-parse", "a"); got != tip {
		t.Fatalf("spawned branch at %s, want %s", got, tip)
	}
}

func TestSpawnBranchHasNoUpstreamTracking(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	h.step()
	for _, key := range []string{"remote", "merge"} {
		if gitOK(foo.Dir, "config", "--get", "branch.a."+key) {
			t.Errorf("branch a has branch.a.%s set: a ref, not a SHA, was passed as the base", key)
		}
	}
	// The same worktree add with a remote-tracking ref does set it: the check above is live.
	runGit(t, foo.Dir, "worktree", "add", "-b", "zz", filepath.Join(t.TempDir(), "zz"), "origin/main")
	if !gitOK(foo.Dir, "config", "--get", "branch.zz.merge") {
		t.Fatal("sanity: a remote-tracking start point must set upstream tracking")
	}
}

func TestSpawnFetchFailureStopsTheSpawn(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	runGit(t, foo.Dir, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "gone.git"))
	h.run.reset()

	res := h.step()
	if len(h.spawn.reqs) != 0 {
		t.Fatalf("spawned despite a failed fetch: %+v", h.spawn.reqs)
	}
	if !hasEscalation(res, "git fetch failed") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if n := h.run.called("git rev-parse origin/"); n != 0 {
		t.Fatalf("rev-parse origin/<default> consulted %d times after a failed fetch: it would return the stale tip", n)
	}
	if got := h.stateOf(h.item("a")); got != QueuePending || spawningSet(h.item("a")) {
		t.Fatalf("state = %s spawning=%v, want a pending item with no spawn marker", got, spawningSet(h.item("a")))
	}
}

func TestDefaultBranchChain(t *testing.T) {
	run := func(t *testing.T, prep func(h *harness, foo *testRepo)) string {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		runGit(t, foo.Dir, "push", "origin", "main:trunk")
		runGit(t, foo.Dir, "fetch", "origin")
		prep(h, foo)
		return newEngine(h.env).defaultBranch(context.Background(), foo.Dir, "a")
	}
	t.Run("origin/HEAD that verifies wins", func(t *testing.T) {
		got := run(t, func(h *harness, foo *testRepo) { runGit(t, foo.Dir, "remote", "set-head", "origin", "trunk") })
		if got != "trunk" {
			t.Fatalf("got %q, want trunk", got)
		}
	})
	t.Run("dangling origin/HEAD falls back to gh", func(t *testing.T) {
		got := run(t, func(h *harness, foo *testRepo) {
			runGit(t, foo.Dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/ghost")
			h.run.reply("gh repo view --json defaultBranchRef", "trunk\n")
		})
		if got != "trunk" {
			t.Fatalf("got %q, want trunk from gh", got)
		}
	})
	t.Run("no origin/HEAD and no gh probes main", func(t *testing.T) {
		got := run(t, func(h *harness, foo *testRepo) {
			_ = gitErr(foo.Dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
			h.run.fail("gh repo view --json defaultBranchRef", "gh: not authenticated")
		})
		if got != "main" {
			t.Fatalf("got %q, want main", got)
		}
	})
	t.Run("no main on origin probes master", func(t *testing.T) {
		got := run(t, func(h *harness, foo *testRepo) {
			_ = gitErr(foo.Dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
			runGit(t, foo.Dir, "update-ref", "-d", "refs/remotes/origin/main")
			h.run.fail("gh repo view --json defaultBranchRef", "gh: not authenticated")
		})
		if got != "master" {
			t.Fatalf("got %q, want master", got)
		}
	})
}

func gitErr(dir string, args ...string) error {
	_, err := ExecRunner{}.Run(context.Background(), dir, append([]string{"git"}, args...)...)
	return err
}

// depFixture is a queue of dep → child in one repo where dep has finished with
// a PR.
func depFixture(t *testing.T, mode string) (*harness, *testRepo) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue(mode,
		Entry{ID: "dep", Repo: foo.Dir, Task: "dep work"},
		Entry{ID: "child", Repo: foo.Dir, Task: "child work"},
	)
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")
	return h, foo
}

func TestLadderCherryPicksDependencyCode(t *testing.T) {
	h, foo := depFixture(t, "cherry-pick-ladder")
	foo.branch("dep-branch", "main", "dep.txt", "from dep\n")

	res := h.step()
	if !hasAction(res, ActCherryPicked, "child") {
		t.Fatalf("actions = %+v", res.Actions)
	}
	wt := h.spawn.lastPath(t)
	if _, err := os.Stat(filepath.Join(wt, "dep.txt")); err != nil {
		t.Fatalf("the dependency's file is missing from the new worktree: %v", err)
	}
	if msg := runGit(t, wt, "log", "-1", "--format=%s"); msg != "operator: cherry-pick dep dependency" {
		t.Fatalf("commit message = %q", msg)
	}
	if got := runGit(t, wt, "status", "--porcelain"); got != "" {
		t.Fatalf("worktree dirty after the cherry-pick commit: %q", got)
	}
}

func (f *fakeSpawner) lastPath(t *testing.T) string {
	t.Helper()
	req := f.reqs[len(f.reqs)-1]
	return filepath.Join(f.root, fmt.Sprintf("%s-%d", req.WorktreeName, f.n))
}

func TestLadderPrunesAncestorDependencies(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("cherry-pick-ladder",
		Entry{ID: "a", Repo: foo.Dir, Task: "a"},
		Entry{ID: "b", Repo: foo.Dir, Task: "b"},
		Entry{ID: "c", Repo: foo.Dir, Task: "c", DependsOn: &[]string{"a", "b"}},
	)
	foo.branch("a-branch", "main", "a.txt", "a\n")
	foo.branch("b-branch", "a-branch", "b.txt", "b\n")
	for i, id := range []string{"a", "b"} {
		h.setDone(id)
		h.attachBranch(id, id+"-branch")
		h.gh.add(i+1, id+"-branch")
	}
	// b was queued behind a, so only c is pending.
	res := h.step()
	picks := 0
	for _, a := range res.Actions {
		if a.Kind == ActCherryPicked && a.Item == "c" {
			picks++
			if a.Detail != "b-branch" {
				t.Errorf("cherry-picked %q, want only the leaf b-branch", a.Detail)
			}
		}
	}
	if picks != 1 {
		t.Fatalf("cherry-picks = %d, want 1 (a is an ancestor of b and must be pruned): %+v", picks, res.Actions)
	}
}

func TestLadderSkipsDependencyAlreadyInHead(t *testing.T) {
	h, foo := depFixture(t, "cherry-pick-ladder")
	// dep-branch is main itself: already an ancestor of the new worktree's HEAD.
	runGit(t, foo.Dir, "branch", "dep-branch", "main")
	res := h.step()
	if hasAction(res, ActCherryPicked, "") {
		t.Fatalf("cherry-picked a dependency that is already an ancestor: %+v", res.Actions)
	}
	if len(h.spawn.reqs) != 1 {
		t.Fatalf("spawn requests = %d", len(h.spawn.reqs))
	}
}

func TestLadderConflictAbortsRollsBackAndEscalates(t *testing.T) {
	h, foo := depFixture(t, "cherry-pick-ladder")
	foo.branch("dep-branch", "main", "shared.txt", "dep version\n")
	foo.advanceOrigin("shared.txt", "main version\n")

	res := h.step()
	if !hasEscalation(res, "conflict") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	child := h.item("child")
	if operator.ScopeString(child.Scope, "pane") != "" || spawningSet(child) {
		t.Fatalf("a tab was attached or the spawn marker kept despite the conflict: %+v", child.Scope)
	}
	if h.stateOf(child) != QueuePending {
		t.Fatalf("state = %s: a conflict must never skip the item", h.stateOf(child))
	}
	wt := filepath.Join(h.spawn.root, "child-1")
	if _, err := os.Stat(wt); err == nil {
		t.Fatal("the worktree was not rolled back")
	}
	notes := child.Notes
	if len(notes) == 0 {
		t.Fatal("no note recorded for the conflict")
	}
}

func TestLadderMissingDependencyBranchEscalates(t *testing.T) {
	h, _ := depFixture(t, "cherry-pick-ladder")
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		delete(st.BranchMap, "dep")
		st.Tracked[operator.IndexOf(st.Tracked, "dep")].Scope["branch"] = nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// The gate needs a branch to look the PR up by, so the item is held, not spawned.
	h.step()
	if len(h.spawn.reqs) != 0 {
		t.Fatal("spawned a child whose dependency has no branch")
	}
}

func TestCrossRepoDependencyNeverCherryPicks(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("cherry-pick-ladder", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: bar.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	res := h.step()
	if hasAction(res, ActCherryPicked, "") {
		t.Fatalf("code moved across repos: %+v", res.Actions)
	}
	if len(h.spawn.reqs) != 1 || h.spawn.reqs[0].Repo != bar.Dir {
		t.Fatalf("spawn requests = %+v", h.spawn.reqs)
	}
}

func TestStackedCutsFromDependencyTipOnOrigin(t *testing.T) {
	h, foo := depFixture(t, "stacked-prs")
	pushed := foo.branch("dep-branch", "main", "dep.txt", "pushed\n")
	foo.pushBranch("dep-branch")
	// An unpushed local commit on the dependency must not leak into the stack.
	wt := filepath.Join(t.TempDir(), "extra")
	runGit(t, foo.Dir, "worktree", "add", wt, "dep-branch")
	commitFile(t, wt, "local.txt", "unpushed\n", "local only")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)

	h.step()
	if got := h.spawn.reqs[0].BaseSHA; got != pushed {
		t.Fatalf("BaseSHA = %s, want the SHA of origin/dep-branch %s", got, pushed)
	}
	if got := runGit(t, foo.Dir, "rev-parse", "child"); got != pushed {
		t.Fatalf("child branch at %s, want %s", got, pushed)
	}
	if prompt := h.spawn.reqs[0].Prompt; !strings.Contains(prompt, "open a draft PR against dep-branch") {
		t.Fatalf("a plain agent's PR instruction must name the dependency branch as the base: %q", prompt)
	}
}

func TestStackedRecordsBaseBranchForFabChanges(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	runGit(t, foo.Dir, "push", "origin", "main")
	h.queue("stacked-prs", Entry{ID: "ab12", Repo: foo.Dir, Change: "ab12"}, Entry{ID: "cd34", Repo: foo.Dir, Change: "cd34"})
	foo.branch("dep-branch", "main", "dep.txt", "x\n")
	foo.pushBranch("dep-branch")
	h.setDone("ab12")
	h.attachBranch("ab12", "dep-branch")
	h.gh.add(1, "dep-branch")

	h.step()
	if n := h.run.called("fab status set-base-branch cd34 dep-branch"); n != 1 {
		t.Fatalf("set-base-branch calls = %d, want 1; calls: %v", n, h.run.calls)
	}
	if n := h.run.called("fab change switch cd34"); n != 1 {
		t.Fatalf("pointer activation calls = %d, want 1", n)
	}
	if prompt := h.spawn.reqs[0].Prompt; prompt != "/fab-fff cd34" {
		t.Fatalf("prompt = %q", prompt)
	}
	if got := h.spawn.reqs[0].NewBranch; got != "260101-cd34-folder" {
		t.Fatalf("NewBranch = %q, want the change folder", got)
	}
}

func TestStackedRawTextFabEntryCarriesTheBaseInstruction(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	runGit(t, foo.Dir, "push", "origin", "main")
	h.queue("stacked-prs", Entry{ID: "dep", Repo: foo.Dir, Task: "dep"}, Entry{ID: "child", Repo: foo.Dir, Task: "child work"})
	foo.branch("dep-branch", "main", "dep.txt", "x\n")
	foo.pushBranch("dep-branch")
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")

	h.step()
	prompt := h.spawn.reqs[0].Prompt
	if !strings.HasPrefix(prompt, "/fab-new child work") || !strings.Contains(prompt, "fab status set-base-branch <new-change> dep-branch") {
		t.Fatalf("prompt = %q", prompt)
	}
}

func TestStackedDependencyBranchMustBeOnOrigin(t *testing.T) {
	h, foo := depFixture(t, "stacked-prs")
	foo.branch("dep-branch", "main", "dep.txt", "x\n") // never pushed
	res := h.step()
	if len(h.spawn.reqs) != 0 || !hasEscalation(res, "not on origin") {
		t.Fatalf("reqs=%d escalations=%+v", len(h.spawn.reqs), res.Escalations)
	}
}

func TestMergeAutoBasesOnDefaultBranchIndependently(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	tip := foo.advanceOrigin("x.txt", "1\n")
	h.step()
	if got := h.spawn.reqs[0].BaseSHA; got != tip {
		t.Fatalf("BaseSHA = %s, want origin tip %s", got, tip)
	}
}

func TestPromptTable(t *testing.T) {
	h := newHarness(t)
	plain := newRepo(t, "plain")
	fabRepo := newRepo(t, "fabbed")
	commitFile(t, fabRepo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	e := newEngine(h.env)
	item := func(repo string, scope map[string]interface{}) operator.TrackedItem {
		scope["repo"] = repo
		it, err := operator.NewPaneItem("x", nil, scope)
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	cases := []struct {
		name, repo string
		scope      map[string]interface{}
		base, want string
	}{
		{"fab existing change", fabRepo.Dir, map[string]interface{}{"change": "ab12"}, "", "/fab-fff ab12"},
		{"fab raw text", fabRepo.Dir, map[string]interface{}{scopeTask: "fix it"}, "", "/fab-new fix it"},
		{"fab bare", fabRepo.Dir, map[string]interface{}{scopeBare: true}, "", ""},
		{"plain task against the default branch", plain.Dir, map[string]interface{}{scopeTask: "fix it"}, "", "fix it\n\nCommit on this branch, push, and open a draft PR against main."},
		{"plain task stacked", plain.Dir, map[string]interface{}{scopeTask: "fix it"}, "dep-branch", "fix it\n\nCommit on this branch, push, and open a draft PR against dep-branch."},
		{"plain bare", plain.Dir, map[string]interface{}{scopeBare: true}, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := e.buildPrompt(context.Background(), item(c.repo, c.scope), c.repo, "main", c.base)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(got, c.want) || (c.want == "" && got != "") {
				t.Fatalf("prompt = %q, want prefix %q", got, c.want)
			}
		})
	}
}

func TestConfidenceGate(t *testing.T) {
	setup := func(t *testing.T, status string) (*harness, *testRepo) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
		runGit(t, foo.Dir, "push", "origin", "main")
		write(t, filepath.Join(foo.Dir, "fab", "changes", "260101-ab12-folder", ".status.yaml"), status)
		h.queue("", Entry{ID: "ab12", Repo: foo.Dir, Change: "ab12"})
		return h, foo
	}
	t.Run("below the gate", func(t *testing.T) {
		h, _ := setup(t, "confidence:\n  score: 2.4\n")
		res := h.step()
		if len(h.spawn.reqs) != 0 || !hasEscalation(res, "below confidence gate") || spawningSet(h.item("ab12")) {
			t.Fatalf("reqs=%d escalations=%+v", len(h.spawn.reqs), res.Escalations)
		}
	})
	t.Run("at the gate", func(t *testing.T) {
		h, _ := setup(t, "confidence:\n  score: 3.0\n")
		h.step()
		if len(h.spawn.reqs) != 1 {
			t.Fatalf("reqs = %d", len(h.spawn.reqs))
		}
	})
	t.Run("no score yet", func(t *testing.T) {
		h, _ := setup(t, "progress:\n  intake: done\n")
		h.step()
		if len(h.spawn.reqs) != 1 {
			t.Fatalf("reqs = %d", len(h.spawn.reqs))
		}
	})
}

func TestSpawnAttachesPaneSessionBranchAndBranchMap(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.step()
	it := h.item("a")
	if operator.ScopeString(it.Scope, "pane") != "%101" || operator.ScopeString(it.Scope, "session") != "work" || operator.ScopeString(it.Scope, "branch") != "a" {
		t.Fatalf("scope = %+v", it.Scope)
	}
	be := h.state().BranchMap["a"]
	if be.Branch != "a" || be.Repo != foo.Dir {
		t.Fatalf("branch_map[a] = %+v", be)
	}
	if h.spawn.reqs[0].Session != "work" || h.spawn.reqs[0].WorktreeName != "a" {
		t.Fatalf("request = %+v", h.spawn.reqs[0])
	}
}

func TestRespawnOnceThenSkip(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.step()
	h.panes.panes["%101"] = operator.PaneInfo{PaneID: "%101"}
	if res := h.step(); hasAction(res, ActRespawned, "") {
		t.Fatalf("a live pane was respawned: %+v", res.Actions)
	}
	delete(h.panes.panes, "%101")

	res := h.step()
	if !hasAction(res, ActRespawned, "a") {
		t.Fatalf("actions = %+v", res.Actions)
	}
	req := h.spawn.reqs[len(h.spawn.reqs)-1]
	if req.CheckoutBranch != "a" || req.ExistingWorktree == "" {
		t.Fatalf("respawn must reuse the existing branch and its worktree: %+v", req)
	}
	if v, _ := h.item("a").Scope[scopeRespawned].(bool); !v {
		t.Fatal("scope.respawned not recorded")
	}

	delete(h.panes.panes, "%102")
	before := len(h.spawn.reqs)
	res = h.step()
	if len(h.spawn.reqs) != before {
		t.Fatal("a second respawn happened")
	}
	if !hasEscalation(res, "after its one respawn") || !skipped(h.item("a")) {
		t.Fatalf("escalations = %+v skipped=%v", res.Escalations, skipped(h.item("a")))
	}
	if ok, _ := gateOf(t, h, "b"); ok {
		t.Fatal("dependents of a skipped item must stay held")
	}
}

func TestDryRunStepChangesNothing(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	before, err := os.ReadFile(engineFilePath(h.env.StatePath))
	if err != nil {
		t.Fatal(err)
	}
	h.env.DryRun = true
	res := h.step()
	if !res.DryRun || !hasAction(res, string(ActionSpawn), "a") || res.Actions[0].Detail != "(Q2)" {
		t.Fatalf("result = %+v", res)
	}
	if len(h.spawn.reqs) != 0 || h.run.called("git fetch") != 0 {
		t.Fatal("dry-run acted")
	}
	after, _ := os.ReadFile(engineFilePath(h.env.StatePath))
	if string(before) != string(after) {
		t.Fatal("dry-run changed the state file")
	}
}

func TestExternalWriteDuringSpawnSurvives(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "other", Repo: foo.Dir, Task: "o", DependsOn: &[]string{}})
	h.attachBranch("other", "other-branch")
	once := false
	h.spawn.during = func() {
		if once {
			return
		}
		once = true
		if err := operator.AddNote(h.env.StatePath, "other", operator.ByUser, "written between load and write"); err != nil {
			t.Error(err)
		}
		if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
			it, _ := operator.NewPaneItem("ext", nil, map[string]interface{}{"repo": foo.Dir, "pane": "%1"})
			st.Tracked = append(st.Tracked, it)
			return nil
		}); err != nil {
			t.Error(err)
		}
	}
	h.panes.panes["%1"] = operator.PaneInfo{PaneID: "%1"}
	h.step()
	found := false
	for _, note := range h.item("other").Notes {
		if note.Text == "written between load and write" && note.By == operator.ByUser {
			found = true
		}
	}
	if !found {
		t.Fatalf("the external note was lost: %+v", h.item("other").Notes)
	}
	if !h.has("ext") {
		t.Fatal("the externally added item was lost")
	}
	if operator.ScopeString(h.item("a").Scope, "pane") == "" {
		t.Fatal("the attach was lost")
	}
}

func TestLockIsNeverHeldAcrossASubprocess(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	probes := 0
	h.run.onRun = func(argv []string) {
		probes++
		// A lock held by the engine across this call would make the write
		// block until the store's timeout and fail with ErrBusy.
		if err := operator.Mutate(h.env.StatePath, func(*operator.State) error { return operator.ErrNoWrite }); err != nil {
			t.Errorf("the state lock was held during %v: %v", argv, err)
		}
	}
	h.step()
	if probes == 0 {
		t.Fatal("no subprocess ran")
	}
}

func TestStackedRawTextPromptRendersThroughTheProductionPrefixRenderer(t *testing.T) {
	h := newHarness(t)
	resolveAgentFn = func(context.Context, string, string) riff.ResolvedAgent {
		return riff.ResolvedAgent{Launcher: "codex", SkillPrefix: "$"}
	}
	foo := newRepo(t, "foo")
	commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	runGit(t, foo.Dir, "push", "origin", "main")
	h.queue("stacked-prs", Entry{ID: "dep", Repo: foo.Dir, Task: "dep"}, Entry{ID: "child", Repo: foo.Dir, Task: "child work"})
	foo.branch("dep-branch", "main", "dep.txt", "x\n")
	foo.pushBranch("dep-branch")
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")
	h.step()

	prompt := h.spawn.reqs[0].Prompt
	rendered := riff.ApplySkillPrefix(riff.EffectiveSpec{SkillPrefix: "$", Panes: []riff.PaneSpec{{Kind: riff.PaneKindSkill, Value: prompt}}}).Panes[0].Value
	if !strings.HasPrefix(rendered, "$fab-new child work") {
		t.Fatalf("the production renderer left the invocation unrendered: %q", rendered)
	}
	if !strings.Contains(rendered, "After $fab-new creates the change") || strings.Contains(rendered, "/fab-new") {
		t.Fatalf("rendered prompt = %q", rendered)
	}
}

func TestRespawnKeepsTheStackedBase(t *testing.T) {
	setup := func(t *testing.T, withFab bool) (*harness, string) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		if withFab {
			commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
			runGit(t, foo.Dir, "push", "origin", "main")
		}
		h.queue("stacked-prs", Entry{ID: "dep", Repo: foo.Dir, Task: "dep"}, Entry{ID: "child", Repo: foo.Dir, Task: "child work"})
		foo.branch("dep-branch", "main", "dep.txt", "x\n")
		foo.pushBranch("dep-branch")
		h.setDone("dep")
		h.attachBranch("dep", "dep-branch")
		h.gh.add(1, "dep-branch")
		h.step()
		delete(h.panes.panes, "%101")
		h.step()
		return h, foo.Dir
	}
	t.Run("raw-text fab entry that died before recording its base", func(t *testing.T) {
		h, _ := setup(t, true)
		req := h.spawn.reqs[len(h.spawn.reqs)-1]
		if req.CheckoutBranch == "" || !strings.HasPrefix(req.Prompt, "/fab-new child work") || !strings.Contains(req.Prompt, "set-base-branch <new-change> dep-branch") {
			t.Fatalf("respawn request = %+v", req)
		}
	})
	t.Run("plain agent", func(t *testing.T) {
		h, _ := setup(t, false)
		req := h.spawn.reqs[len(h.spawn.reqs)-1]
		if !strings.Contains(req.Prompt, "open a draft PR against dep-branch") {
			t.Fatalf("respawn prompt = %q", req.Prompt)
		}
	})
}

// R7 holds for an item that already has a pane: its same-repo dependency has
// no PR, so a dead pane must not be replaced.
func TestRespawnNeverReplacesAHeldItem(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	foo.branch("b-branch", "main", "b.txt", "b")
	h.setDone("a")
	h.attachBranch("a", "a-branch") // done, null stop_stage, and no PR
	h.attachBranch("b", "b-branch") // spawned, pane %900 is gone from the snapshot
	h.panes.panes = map[string]operator.PaneInfo{}
	h.run.reset()

	res := h.step()
	if h.spawn.n != 0 || hasAction(res, ActRespawned, "") || scopeBool(h.item("b"), scopeRespawned) || spawningSet(h.item("b")) {
		t.Fatalf("a held item was respawned: launches=%d %+v", h.spawn.n, res)
	}
	if got := h.stateOf(h.item("b")); got != QueueHeld {
		t.Fatalf("b = %s, want held", got)
	}
	h.gh.add(1, "a-branch")
	if res := h.step(); !hasAction(res, ActRespawned, "b") {
		t.Fatalf("once a has its PR the dead pane is respawned: %+v", res)
	}
}

// Spawn, respawn and status decide through one function, so they cannot
// disagree about the same item.
func TestSpawnRespawnAndStatusAgreeOnReadiness(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	res, err := Status(context.Background(), h.env)
	if err != nil || res.Items[1].State != QueueHeld {
		t.Fatalf("status b = %+v err %v", res.Items[1], err)
	}
	if got := h.step(); hasAction(got, ActSpawned, "b") || h.spawn.n != 0 {
		t.Fatalf("step spawned a held item: %+v", got)
	}
}

// A raw-task spawn's branch is renamed by /fab-new to the change name. The
// engine's view takes the change, stage and real branch from the ledger (what
// the check recorded), so the respawn checks out the renamed branch, resumes
// with /fab-fff <change>, and the stall escalation names the stage.
func TestRespawnFollowsTheBranchFabNewRenamed(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	if err := os.Mkdir(filepath.Join(foo.Dir, "fab"), 0o755); err != nil {
		t.Fatal(err)
	}
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "implement the F1 brief"})
	h.step()
	h.panes.panes["%101"] = operator.PaneInfo{PaneID: "%101"}
	if res := h.step(); hasAction(res, ActRespawned, "") {
		t.Fatalf("a live pane was respawned: %+v", res.Actions)
	}

	const change = "261117-ab12-fills"
	wt := filepath.Join(h.spawn.root, "a-1")
	runGit(t, wt, "branch", "-m", change)
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, "a")
		st.Tracked[i].Scope["change"] = change
		st.Tracked[i].Scope["stage"] = "intake"
		st.BranchMap[change] = operator.BranchMapEntry{Branch: change, Repo: foo.Dir}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	view, _, err := engineView(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	it := view.Tracked[operator.IndexOf(view.Tracked, "a")]
	if operator.ScopeString(it.Scope, "change") != change || operator.ScopeString(it.Scope, "stage") != "intake" || operator.ScopeString(it.Scope, "branch") != change {
		t.Fatalf("engine view scope = %v, want the ledger's change, stage and branch", it.Scope)
	}
	if _, reason := slowStageText(&ruleCtx{it: it}); !strings.HasPrefix(reason, "stage intake over") {
		t.Errorf("slow-stage reason = %q, want it naming the stage", reason)
	}

	delete(h.panes.panes, "%101")
	res := h.step()
	if !hasAction(res, ActRespawned, "a") {
		t.Fatalf("actions = %+v escalations = %+v", res.Actions, res.Escalations)
	}
	req := h.spawn.reqs[len(h.spawn.reqs)-1]
	if req.CheckoutBranch != change || req.ExistingWorktree != wt || !strings.HasPrefix(req.Prompt, "/fab-fff "+change) {
		t.Fatalf("respawn request = %+v, want the renamed branch, its worktree and /fab-fff", req)
	}
	st, err := Status(context.Background(), h.env)
	if err != nil || len(st.Items) != 1 || st.Items[0].Branch != change || st.Items[0].Change != change {
		t.Fatalf("status = %+v err %v, want the renamed branch and change", st, err)
	}
	if be := h.state().BranchMap[change]; be.Branch != change {
		t.Fatalf("branch_map[%s] = %+v, the respawn's write-back must not restore the stale branch", change, be)
	}
}

// A paused entry is held past its dependencies until resume; `Pause` holds
// an unspawned entry mid-flight and refuses a spawned one.
func TestPausedEntryHoldsUntilResume(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	none, afterGate := []string{}, []string{"gate"}
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"},
		Entry{ID: "gate", Repo: foo.Dir, Task: "gate", Paused: true, DependsOn: &none},
		Entry{ID: "c", Repo: foo.Dir, Task: "c", DependsOn: &afterGate})
	res := h.step()
	if !hasAction(res, ActSpawned, "a") || hasAction(res, ActSpawned, "gate") {
		t.Fatalf("actions = %+v, want a spawned and gate held", res.Actions)
	}
	h.panes.panes["%101"] = operator.PaneInfo{PaneID: "%101"}
	if st, _ := Status(context.Background(), h.env); st.Items[1].State != QueuePaused {
		t.Fatalf("gate status = %+v, want paused", st.Items[1])
	}
	if _, err := Pause(context.Background(), h.env, "c"); err != nil {
		t.Fatal(err)
	}
	if _, err := Pause(context.Background(), h.env, "c"); err != nil {
		t.Fatalf("a second pause must be a no-op, got %v", err)
	}
	if _, err := Pause(context.Background(), h.env, "a"); err == nil {
		t.Fatal("pausing a spawned item must be a usage error")
	}
	if res := h.step(); hasAction(res, ActSpawned, "") {
		t.Fatalf("paused entries spawned: %+v", res.Actions)
	}
	// Resume runs a pass itself, so the spawn happens inside it.
	res, err := Resume(context.Background(), h.env, "gate")
	if err != nil {
		t.Fatal(err)
	}
	if !hasAction(res, ActSpawned, "gate") || len(h.spawn.reqs) != 2 || h.spawn.reqs[len(h.spawn.reqs)-1].WorktreeName != "gate" {
		t.Fatalf("resumed gate not spawned: %+v reqs %d", res.Actions, len(h.spawn.reqs))
	}
}
