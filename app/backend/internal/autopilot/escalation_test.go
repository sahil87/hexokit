package autopilot

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"rk/internal/operator"
)

func assertEscalationNote(t *testing.T, h *harness, res *StepResult, id, reason string) {
	t.Helper()
	found := false
	for _, esc := range res.Escalations {
		if esc.Item == id && strings.Contains(esc.Reason, reason) {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing %s escalation %q: %+v", id, reason, res)
	}
	count := 0
	for _, note := range h.item(id).Notes {
		if strings.HasPrefix(note.Text, "escalated: ") && strings.Contains(note.Text, reason) {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("%s has %d notes for %q", id, count, reason)
	}
}

func TestMergeAutoDiscoveryFailureEscalatesAndRetries(t *testing.T) {
	for _, failure := range []string{"branch absent", "gh unavailable"} {
		t.Run(failure, func(t *testing.T) {
			h := newHarness(t)
			repo := newRepo(t, "repo")
			h.queue("merge-auto", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"}, Entry{ID: "b", Repo: repo.Dir, Change: "bbbb"})
			h.setDone("a")
			reason := "no branch recorded"
			if failure == "gh unavailable" {
				h.attachBranch("a", "a-branch")
				reason = "API unavailable"
				h.run.fail("gh pr view a-branch", reason)
			}
			for i := 0; i < 2; i++ {
				res := h.step()
				assertEscalationNote(t, h, res, "a", reason)
				if h.has("pr-1") || h.spawn.n != 0 || h.run.called("gh pr merge") != 0 {
					t.Fatal("discovery failure advanced queue")
				}
			}
			h.attachBranch("a", "a-branch")
			pr := h.gh.add(1, "a-branch")
			h.run.on("gh pr view a-branch", h.gh.handle)
			pending(pr)
			res := h.step()
			if !h.has("pr-1") || !hasAction(res, ActPRTracked, "a") {
				t.Fatalf("discovery did not recover: %+v", res)
			}
			if h.step(); !pr.Armed {
				t.Fatal("the tracked PR was not armed on the next pass")
			}
		})
	}
}

func TestAdvancePollingFailureEscalatesAndRetries(t *testing.T) {
	h, pr, head := armFixture(t)
	pending(pr)
	e := newEngine(h.env)
	if err := e.setScope(head.ID, map[string]interface{}{scopeDeferred: false}); err != nil {
		t.Fatal(err)
	}
	h.run.fail("gh pr view 1", "API unavailable")
	for i := 0; i < 2; i++ {
		res := h.step()
		assertEscalationNote(t, h, res, head.ID, "gh pr view failed: API unavailable")
		if pr.Armed || operator.ItemDone(h.item(head.ID)) {
			t.Fatal("failed poll advanced PR")
		}
	}
	h.run.on("gh pr view 1", h.gh.handle)
	if res := h.step(); !pr.Armed || !hasAction(res, ActArmed, head.ID) {
		t.Fatalf("poll did not recover: %+v", res)
	}
}

func TestCheckQueryFailuresEscalateWithoutActing(t *testing.T) {
	h, pr, head := armableFixture(t)
	h.run.fail("gh pr checks", "checks unavailable")
	for i := 0; i < 2; i++ {
		res := h.step()
		assertEscalationNote(t, h, res, head.ID, "gh pr checks failed: checks unavailable")
		if pr.State == "MERGED" || pr.Armed || len(res.Actions) > 0 {
			t.Fatalf("failed query acted: %+v", res)
		}
	}
}

func TestCompletionAndDependencyQueryFailuresEscalate(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"}, Entry{ID: "b", Repo: repo.Dir, Task: "work"})
	h.attachBranch("a", "a-branch")
	h.run.fail("gh pr view", "lookup unavailable")
	e := newEngine(h.env)
	if e.plainAgentDone(context.Background(), h.state(), h.item("a")) {
		t.Fatal("failed query marked done")
	}
	assertEscalationNote(t, h, e.res, "a", "lookup unavailable")
	h.setDone("a")
	f := newFacts()
	e.observeReadiness(context.Background(), h.state(), f)
	if f.queueFor("b").depPR["a"] {
		t.Fatal("failed query opened gate")
	}
	assertEscalationNote(t, h, e.res, "b", "lookup unavailable")
	h.run.reply("gh pr view", `{"state":"OPEN"}`)
	h.run.fail("gh pr checks", "checks unavailable")
	if e.plainAgentDone(context.Background(), h.state(), h.item("a")) {
		t.Fatal("failed checks marked done")
	}
	assertEscalationNote(t, h, e.res, "a", "checks unavailable")
}

func TestReviewLookupFailureEscalatesAndKeepsTheVerifiedMerge(t *testing.T) {
	h, pr, head := armFixture(t)
	changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.Scope[scopeDeferred] = false })
	pr.State = "MERGED"
	h.run.fail("gh pr view 1 --json reviews", "reviews unavailable")
	e, d := h.decideFor(head.ID)
	execOne(t, e, d)
	if !operator.ItemDone(h.item(head.ID)) {
		t.Fatal("verified merge lost")
	}
	assertEscalationNote(t, h, e.res, head.ID, "reviews unavailable")
	if len(e.res.Unreviewed) != 0 {
		t.Fatal("unknown review status treated as unreviewed")
	}
}

func TestStatusLookupFailureIsVisibleAndReadOnly(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	h.shipped(1, "a")
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	h.run.fail("gh pr view", "summary unavailable")
	res, err := Status(context.Background(), h.env)
	if err == nil || !strings.Contains(err.Error(), "a: completion summary PR lookup failed") || !strings.Contains(err.Error(), "summary unavailable") {
		t.Fatalf("result=%+v error=%v", res, err)
	}
	after, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("status wrote notes")
	}
}

type failingGitRunner struct {
	Runner
	prefix string
}

func (r failingGitRunner) Run(ctx context.Context, dir string, argv ...string) (string, error) {
	if strings.HasPrefix(strings.Join(argv, " "), r.prefix) {
		return "", &ExecError{Argv: argv, Stderr: "injected git failure", Err: errors.New("unavailable")}
	}
	return r.Runner.Run(ctx, dir, argv...)
}

func TestGitLookupFailuresStopSpawnAndEscalate(t *testing.T) {
	for _, prefix := range []string{"git rev-parse --verify -q refs/heads/", "git merge-base --is-ancestor", "git diff --cached --quiet"} {
		t.Run(prefix, func(t *testing.T) {
			h, repo := depFixture(t, "cherry-pick-ladder")
			repo.branch("dep-branch", "main", "dep.txt", "dependency")
			h.env.Run = failingGitRunner{Runner: h.run, prefix: prefix}
			res := h.step()
			assertEscalationNote(t, h, res, "child", "injected git failure")
			if hasAction(res, ActSpawned, "child") || operator.ScopeString(h.item("child").Scope, "pane") != "" {
				t.Fatal("lookup failure spawned child")
			}
		})
	}
}

func TestDefaultBranchFallbackReportsGitHubFailure(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Task: "work"})
	_ = gitErr(repo.Dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
	h.run.fail("gh repo view --json defaultBranchRef", "not authenticated")
	e := newEngine(h.env)
	if got := e.defaultBranch(context.Background(), repo.Dir, "a"); got != "main" {
		t.Fatalf("fallback=%q", got)
	}
	assertEscalationNote(t, h, e.res, "a", "not authenticated")
}

func TestCherryPickCleanupFailureEscalates(t *testing.T) {
	h, repo := depFixture(t, "cherry-pick-ladder")
	repo.branch("dep-branch", "main", "dep.txt", "dependency")
	h.env.Run = failingGitRunner{Runner: h.run, prefix: "git cherry-pick"}
	res := h.step()
	assertEscalationNote(t, h, res, "child", "git cherry-pick --abort failed")
	if hasAction(res, ActSpawned, "child") {
		t.Fatal("failed cherry-pick spawned")
	}
	// Inspect and remove the branch left by the rolled-back fake spawn before retrying.
	runGit(t, repo.Dir, "branch", "-D", "child")
	// Other escalation reasons between retries must not duplicate the cleanup note.
	res = h.step()
	assertEscalationNote(t, h, res, "child", "git cherry-pick --abort failed")
}

func TestStartMergeDiscoveryFailureEscalates(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
	h.shipped(1, "a")
	h.run.fail("gh pr view", "discovery unavailable")
	res, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if err == nil {
		t.Fatal("discovery failure returned success")
	}
	assertEscalationNote(t, h, res, "a", "discovery unavailable")
	if h.has("pr-1") {
		t.Fatal("failed discovery registered a PR")
	}
}

func TestRepoAutoMergeLookupFailureEscalatesAndTheWaitingPRIsNotArmed(t *testing.T) {
	h, pr, head := armableFixture(t)
	h.run.fail("gh repo view o/foo --json autoMergeAllowed", "rate limited")
	for i := 0; i < 2; i++ {
		res := h.step()
		assertEscalationNote(t, h, res, head.ID, "repo auto-merge lookup failed: rate limited")
		if pr.Armed || h.run.called("gh pr merge") != 0 {
			t.Fatalf("armed a PR in a repo whose auto-merge setting is unknown: %+v", res)
		}
	}
	h.run.on("gh repo view o/foo --json autoMergeAllowed", h.gh.handle)
	if h.step(); !pr.Armed {
		t.Fatal("the PR was not armed once the repo setting could be read")
	}
}
