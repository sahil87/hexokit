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

// engineRefPins lists the engine runner's calls that fetch or pin a base ref
// itself: wt does both now, so a spawn makes none.
func engineRefPins(h *harness) []string {
	h.run.mu.Lock()
	defer h.run.mu.Unlock()
	var out []string
	for _, c := range h.run.calls {
		if strings.HasPrefix(c, "git fetch") || strings.HasPrefix(c, "git rev-parse origin/") || strings.HasPrefix(c, "git rev-parse refs/remotes/origin/") {
			out = append(out, c)
		}
	}
	return out
}

func (h *harness) engineItem(id string) engineItem {
	h.t.Helper()
	es, err := loadEngineFile(h.env.StatePath)
	if err != nil {
		h.t.Fatal(err)
	}
	it, ok := es.find(id)
	if !ok {
		h.t.Fatalf("no engine item %s", id)
	}
	return *it
}

func TestSpawnRecordsTheFetchedOriginTipNotTheStaleLocalHead(t *testing.T) {
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
	if got := h.spawn.reqs[0].BaseRef; got != "origin/main" {
		t.Fatalf("BaseRef = %q, want origin/main", got)
	}
	if pins := engineRefPins(h); len(pins) != 0 {
		t.Fatalf("the engine fetched or pinned a ref itself: %v", pins)
	}
	if got := h.engineItem("a").BaseSHA; got != tip {
		t.Fatalf("recorded base_sha = %s, want the fetched origin tip %s (local HEAD %s)", got, tip, local)
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
			t.Errorf("branch a has branch.a.%s set: a spawned branch must carry no upstream", key)
		}
	}
	// The same worktree add with a remote-tracking ref does set it: the check above is live.
	runGit(t, foo.Dir, "worktree", "add", "-b", "zz", filepath.Join(t.TempDir(), "zz"), "origin/main")
	if !gitOK(foo.Dir, "config", "--get", "branch.zz.merge") {
		t.Fatal("sanity: a remote-tracking start point must set upstream tracking")
	}
}

func TestSpawnRecordsTheReceiptsBranchAndBaseSHA(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	tip := foo.advanceOrigin("x.txt", "1\n")
	h.step()

	it := h.engineItem("a")
	if it.Branch != "a" || it.BaseSHA != tip {
		t.Fatalf("engine item branch=%q base_sha=%q, want a / %s", it.Branch, it.BaseSHA, tip)
	}
	if got := h.state().BranchMap["a"].Branch; got != "a" {
		t.Fatalf("branch_map a = %q, want the receipt's branch", got)
	}
	if got := operator.ScopeString(h.item("a").Scope, "branch"); got != "a" {
		t.Fatalf("projection branch = %q", got)
	}
	// A later guarded write must not drop the recorded base.
	if err := newEngine(h.env).setScope("a", map[string]interface{}{"note": "x"}); err != nil {
		t.Fatal(err)
	}
	if got := h.engineItem("a").BaseSHA; got != tip {
		t.Fatalf("base_sha after a later write = %q, want %s", got, tip)
	}
}

func TestSpawnFetchFailureStopsTheSpawn(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	runGit(t, foo.Dir, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "gone.git"))
	h.run.reset()

	res := h.step()
	if !hasEscalation(res, "wt create --fetch failed, spawn stopped and the item stays pending") || !hasEscalation(res, "Failed to fetch remote 'origin'") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if pins := engineRefPins(h); len(pins) != 0 {
		t.Fatalf("the engine fetched or pinned a ref itself: %v", pins)
	}
	if got := h.stateOf(h.item("a")); got != QueuePending || spawningSet(h.item("a")) {
		t.Fatalf("state = %s spawning=%v, want a pending item with no spawn marker", got, spawningSet(h.item("a")))
	}
	if h.engineItem("a").Pane != "" {
		t.Fatal("a failed fetch must not bind a pane")
	}
}

func TestSpawnInitFailureKeepsTheWorktreeAndEscalates(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "do a"})
	h.spawn.initFails = true

	res := h.step()
	kept := h.spawn.lastPath(t)
	if !hasEscalation(res, "wt init failed; worktree "+kept+" was kept and the item stays pending") || !hasEscalation(res, "wt delete "+filepath.Base(kept)) {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if _, err := os.Stat(kept); err != nil {
		t.Fatalf("the kept worktree is gone: %v", err)
	}
	it := h.item("a")
	if got := h.stateOf(it); got != QueuePending || spawningSet(it) {
		t.Fatalf("state = %s spawning=%v, want a pending item with no spawn marker", got, spawningSet(it))
	}
	if h.engineItem("a").Pane != "" || h.engineItem("a").BaseSHA != "" {
		t.Fatalf("an init-failed spawn must record nothing: %+v", h.engineItem("a"))
	}
}

func TestSpawnFailureTexts(t *testing.T) {
	with := func(code int, base string) string {
		return spawnFailure(SpawnRequest{BaseRef: base}, &riff.WtCreateError{Code: code, Message: "wt said so"})
	}
	if got := with(2, "origin/dep-branch"); !strings.Contains(got, "origin/dep-branch could not be resolved after the fetch") || !strings.Contains(got, "push it before stacking") || !strings.Contains(got, "wt said so") {
		t.Errorf("exit 2 = %q", got)
	}
	if got := with(2, ""); got != "spawn failed: "+(&riff.WtCreateError{Code: 2, Message: "wt said so"}).Error() {
		t.Errorf("exit 2 without a base keeps the generic text: %q", got)
	}
	gate := &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit riff: wt v0.1.6 is too old — rk needs wt >= v0.1.8 (run: wt update)"}
	if got := spawnFailure(SpawnRequest{}, gate); got != "spawn failed: "+gate.Msg {
		t.Errorf("the version gate's text must reach the escalation verbatim: %q", got)
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
	if got := h.spawn.reqs[0].BaseRef; got != "origin/dep-branch" {
		t.Fatalf("BaseRef = %q, want origin/dep-branch", got)
	}
	if got := h.engineItem("child").BaseSHA; got != pushed {
		t.Fatalf("base_sha = %s, want the SHA of origin/dep-branch %s", got, pushed)
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

// A dependency branch that is on no origin fails at wt's base resolution after
// its fetch, and the item stays pending.
func TestStackedDependencyBranchMustBeOnOrigin(t *testing.T) {
	h, foo := depFixture(t, "stacked-prs")
	foo.branch("dep-branch", "main", "dep.txt", "x\n") // never pushed
	res := h.step()
	if !hasEscalation(res, "origin/dep-branch could not be resolved after the fetch") || !hasEscalation(res, "push it before stacking") {
		t.Fatalf("escalations=%+v", res.Escalations)
	}
	if got := h.stateOf(h.item("child")); got != QueuePending || spawningSet(h.item("child")) {
		t.Fatalf("state = %s, want a pending item with no spawn marker", got)
	}
}

// The main checkout's last fetch predates the dependency's push: the engine
// must not read its stale refs to decide the branch is absent, since wt fetches
// before it resolves the base.
func TestStackedDependencyPushedAfterTheLastFetchStillSpawns(t *testing.T) {
	h, foo := depFixture(t, "stacked-prs")
	foo.branch("dep-branch", "main", "dep.txt", "pushed\n")
	runGit(t, foo.Dir, "push", "origin", "dep-branch")
	runGit(t, foo.Dir, "update-ref", "-d", "refs/remotes/origin/dep-branch")
	if gitOK(foo.Dir, "rev-parse", "--verify", "-q", "refs/remotes/origin/dep-branch") {
		t.Fatal("fixture: the checkout must not know origin/dep-branch yet")
	}

	res := h.step()
	if hasEscalation(res, "not on origin") || len(h.spawn.reqs) != 1 {
		t.Fatalf("reqs=%d escalations=%+v", len(h.spawn.reqs), res.Escalations)
	}
	if got := h.spawn.reqs[0].BaseRef; got != "origin/dep-branch" {
		t.Fatalf("BaseRef = %q, want origin/dep-branch", got)
	}
}

func TestMergeAutoBasesOnDefaultBranchIndependently(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	tip := foo.advanceOrigin("x.txt", "1\n")
	h.step()
	if got := h.spawn.reqs[0].BaseRef; got != "origin/main" {
		t.Fatalf("BaseRef = %q, want origin/main", got)
	}
	if got := h.engineItem("a").BaseSHA; got != tip {
		t.Fatalf("base_sha = %s, want origin tip %s", got, tip)
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
		{"fab task queued plain", fabRepo.Dir, map[string]interface{}{scopeTask: "fix it", scopePlain: true}, "", "fix it\n\nCommit on this branch, push, and open a draft PR against main."},
		{"fab task queued plain with a base", fabRepo.Dir, map[string]interface{}{scopeTask: "fix it", scopePlain: true, scopeBase: "eng-v2"}, "", "fix it\n\nCommit on this branch, push, and open a draft PR against eng-v2."},
		{"fab task queued plain stacked", fabRepo.Dir, map[string]interface{}{scopeTask: "fix it", scopePlain: true}, "dep-branch", "fix it\n\nCommit on this branch, push, and open a draft PR against dep-branch."},
		{"no-fab task with a base", plain.Dir, map[string]interface{}{scopeTask: "fix it", scopeBase: "eng-v2"}, "", "fix it\n\nCommit on this branch, push, and open a draft PR against eng-v2."},
		{"fab raw text with a base", fabRepo.Dir, map[string]interface{}{scopeTask: "fix it", scopeBase: "eng-v2"}, "", "/fab-new fix it\n\nAfter /fab-new creates the change, run `fab status set-base-branch <new-change> eng-v2`."},
		{"fab existing change with a base", fabRepo.Dir, map[string]interface{}{"change": "ab12", scopeBase: "eng-v2"}, "", "/fab-fff ab12"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := e.buildPrompt(context.Background(), item(c.repo, c.scope), c.repo, "grp", "main", c.base)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("prompt = %q, want %q", got, c.want)
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
	resolveAgentFn = func(context.Context, string, string, string) riff.ResolvedAgent {
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

// baseFixture is a repo with a pushed long-lived branch eng-v2 that main does
// not contain.
func baseFixture(t *testing.T, withFab bool) (*harness, *testRepo, string) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	if withFab {
		commitFile(t, foo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
		runGit(t, foo.Dir, "push", "origin", "main")
	}
	tip := foo.branch("eng-v2", "main", "eng.txt", "eng\n")
	foo.pushBranch("eng-v2")
	return h, foo, tip
}

func TestBaseStartsTheWorktreeAtTheBaseTip(t *testing.T) {
	h, foo, tip := baseFixture(t, false)
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "bump deps", Base: "eng-v2"})
	h.step()
	req := h.spawn.reqs[0]
	if req.BaseRef != "origin/eng-v2" {
		t.Fatalf("BaseRef = %q, want origin/eng-v2", req.BaseRef)
	}
	if got := h.engineItem("a").BaseSHA; got != tip {
		t.Fatalf("base_sha = %s, want the origin/eng-v2 tip %s", got, tip)
	}
	if pins := engineRefPins(h); len(pins) != 0 {
		t.Fatalf("the engine fetched or pinned a ref itself: %v", pins)
	}
	if !strings.Contains(req.Prompt, "open a draft PR against eng-v2") {
		t.Fatalf("prompt = %q", req.Prompt)
	}
}

func TestLadderCherryPicksOnTopOfTheBase(t *testing.T) {
	h, foo, tip := baseFixture(t, false)
	h.queue("cherry-pick-ladder",
		Entry{ID: "dep", Repo: foo.Dir, Task: "dep work", Base: "eng-v2"},
		Entry{ID: "child", Repo: foo.Dir, Task: "child work", Base: "eng-v2"},
	)
	foo.branch("dep-branch", "eng-v2", "dep.txt", "from dep\n")
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")

	res := h.step()
	if !hasAction(res, ActCherryPicked, "child") {
		t.Fatalf("actions = %+v; escalations = %+v", res.Actions, res.Escalations)
	}
	var child SpawnRequest
	for _, r := range h.spawn.reqs {
		if r.WorktreeName == "child" {
			child = r
		}
	}
	if child.BaseRef != "origin/eng-v2" {
		t.Fatalf("BaseRef = %q, want origin/eng-v2", child.BaseRef)
	}
	if got := h.engineItem("child").BaseSHA; got != tip {
		t.Fatalf("base_sha = %s, want %s", got, tip)
	}
	if n := h.run.called("git cherry-pick --no-commit origin/eng-v2.."); n != 1 {
		t.Fatalf("cherry-pick must range from origin/eng-v2; calls: %v", h.run.calls)
	}
	wt := h.spawn.lastPath(t)
	for _, f := range []string{"dep.txt", "eng.txt"} {
		if _, err := os.Stat(filepath.Join(wt, f)); err != nil {
			t.Fatalf("%s missing from the new worktree: %v", f, err)
		}
	}
}

func TestBaseRecordsTheBaseBranchForAnExistingFabChange(t *testing.T) {
	h, foo, _ := baseFixture(t, true)
	h.queue("", Entry{ID: "ab12", Repo: foo.Dir, Change: "ab12", Base: "eng-v2"})
	h.step()
	if n := h.run.called("fab status set-base-branch ab12 eng-v2"); n != 1 {
		t.Fatalf("set-base-branch calls = %d; calls: %v", n, h.run.calls)
	}
	if prompt := h.spawn.reqs[0].Prompt; prompt != "/fab-fff ab12" {
		t.Fatalf("prompt = %q", prompt)
	}
}

func TestPlainTaskInAFabRepoSpawnsThePlainPrompt(t *testing.T) {
	h, foo, _ := baseFixture(t, true)
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "bump deps", Plain: true})
	h.step()
	want := "bump deps\n\nCommit on this branch, push, and open a draft PR against main."
	if got := h.spawn.reqs[0].Prompt; got != want {
		t.Fatalf("prompt = %q, want %q", got, want)
	}
	for _, c := range []string{"fab change switch", "fab status set-base-branch"} {
		if n := h.run.called(c); n != 0 {
			t.Fatalf("a plain item ran %q (%d calls)", c, n)
		}
	}
}

func TestSpawnWithoutBaseIsUnchanged(t *testing.T) {
	h, foo, _ := baseFixture(t, true)
	tip := foo.advanceOrigin("x.txt", "1\n")
	h.queue("", Entry{ID: "ab12", Repo: foo.Dir, Change: "ab12"})
	h.step()
	if got := h.spawn.reqs[0].BaseRef; got != "origin/main" {
		t.Fatalf("BaseRef = %q, want origin/main", got)
	}
	if got := h.engineItem("ab12").BaseSHA; got != tip {
		t.Fatalf("base_sha = %s, want the origin/main tip %s", got, tip)
	}
	if n := h.run.called("fab status set-base-branch"); n != 0 {
		t.Fatalf("set-base-branch ran without a base: %v", h.run.calls)
	}
}

func TestStackedDependencyBaseAndItemBaseEscalateWithoutSpawning(t *testing.T) {
	h, foo, _ := baseFixture(t, false)
	h.queue("stacked-prs", Entry{ID: "dep", Repo: foo.Dir, Task: "dep"}, Entry{ID: "child", Repo: foo.Dir, Task: "child work"})
	foo.branch("dep-branch", "main", "dep.txt", "x\n")
	foo.pushBranch("dep-branch")
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")
	// Queue validation refuses this pairing; an edited engine file can still hold it.
	if err := newEngine(h.env).setScope("child", map[string]interface{}{scopeBase: "eng-v2"}); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	if len(h.spawn.reqs) != 0 || !hasEscalation(res, "conflicts with the stacked dependency base") {
		t.Fatalf("reqs=%d escalations=%+v", len(h.spawn.reqs), res.Escalations)
	}
	if spawningSet(h.item("child")) {
		t.Fatal("the refused spawn left its marker set")
	}
}

func TestRespawnKeepsTheItemBase(t *testing.T) {
	h, foo, _ := baseFixture(t, true)
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "bump deps", Plain: true, Base: "eng-v2"}, Entry{ID: "b", Repo: foo.Dir, Task: "raw task", Base: "eng-v2", DependsOn: &[]string{}})
	h.step()
	delete(h.panes.panes, "%101")
	delete(h.panes.panes, "%102")
	h.step()
	respawned := 0
	for _, r := range h.spawn.reqs {
		if r.CheckoutBranch == "" {
			continue
		}
		respawned++
		switch r.WorktreeName {
		case "a":
			if !strings.Contains(r.Prompt, "open a draft PR against eng-v2") {
				t.Fatalf("respawned plain prompt = %q", r.Prompt)
			}
		case "b":
			if !strings.Contains(r.Prompt, "set-base-branch <new-change> eng-v2") {
				t.Fatalf("respawned raw-task prompt = %q", r.Prompt)
			}
		}
	}
	if respawned != 2 {
		t.Fatalf("respawns = %d, want 2", respawned)
	}
}

func TestLadderDependencyOnADifferentBaseEscalatesWithoutSpawning(t *testing.T) {
	h, foo, _ := baseFixture(t, false)
	h.queue("cherry-pick-ladder",
		Entry{ID: "dep", Repo: foo.Dir, Task: "dep work", Base: "eng-v2"},
		Entry{ID: "child", Repo: foo.Dir, Task: "child work", Base: "eng-v2"},
	)
	foo.branch("dep-branch", "eng-v2", "dep.txt", "from dep\n")
	h.setDone("dep")
	h.attachBranch("dep", "dep-branch")
	h.gh.add(1, "dep-branch")
	// Queue validation refuses this pairing; an edited engine file can still hold it.
	if err := newEngine(h.env).setScope("child", map[string]interface{}{scopeBase: nil}); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	for _, r := range h.spawn.reqs {
		if r.WorktreeName == "child" {
			t.Fatalf("child spawned on a different base than its dependency: %+v", r)
		}
	}
	if !hasEscalation(res, "differs from dependency dep's base") || spawningSet(h.item("child")) {
		t.Fatalf("escalations=%+v", res.Escalations)
	}
}

// The skill prefix is resolved under the preset the spawn itself will carry:
// the ladder runs against the item's group session on the autopilot's server,
// and its name reaches the agent resolution.
func TestPromptPrefixFollowsTheGroupAgentPreset(t *testing.T) {
	h := newHarness(t)
	fabRepo := newRepo(t, "fabbed")
	commitFile(t, fabRepo.Dir, "fab/project/config.yaml", "x: 1\n", "fab")
	h.env.Server = "ws"
	var ladderServer, ladderSession, agentPreset string
	resolvePresetFn = func(_ context.Context, explicit, server, session, _ string) string {
		if explicit != "" {
			t.Errorf("explicit pick = %q, want none", explicit)
		}
		ladderServer, ladderSession = server, session
		return "codex-workers"
	}
	resolveAgentFn = func(_ context.Context, _, _, preset string) riff.ResolvedAgent {
		agentPreset = preset
		return riff.ResolvedAgent{Launcher: "codex", SkillPrefix: "$"}
	}
	it, err := operator.NewPaneItem("x", nil, map[string]interface{}{"repo": fabRepo.Dir, scopeTask: "fix it", scopeBase: "eng-v2"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := newEngine(h.env).buildPrompt(context.Background(), it, fabRepo.Dir, "grp", "main", "")
	if err != nil {
		t.Fatal(err)
	}
	if ladderServer != "ws" || ladderSession != "grp" || agentPreset != "codex-workers" {
		t.Errorf("ladder %q/%q, agent preset %q; want ws/grp and codex-workers", ladderServer, ladderSession, agentPreset)
	}
	if !strings.Contains(got, "After $fab-new creates the change") {
		t.Errorf("prompt = %q, want the codex `$` skill prefix", got)
	}
}
