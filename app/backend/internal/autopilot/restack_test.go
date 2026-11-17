package autopilot

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/operator"
)

func stackFixture(t *testing.T, s2File, s2Content string) (*harness, *testRepo, []*simPR) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	predHead := foo.branch("s1-branch", "main", "s1.txt", "s1\n")
	head := foo.branch("s2-branch", "s1-branch", s2File, s2Content)
	foo.pushBranch("s1-branch")
	foo.pushBranch("s2-branch")
	h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"}, Entry{ID: "s2", Repo: foo.Dir, Task: "s2"})
	prs := h.shipped(1, "s1", "s2")
	prs[0].HeadOid = predHead
	prs[1].HeadOid = head
	prs[1].Base = "s1-branch"
	prs[1].Origin = foo
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			p.MergeCommit = foo.advanceOrigin("s1.txt", "s1\n")
		}
	}
	return h, foo, prs
}

func recordStackPredecessor(h *harness) {
	h.t.Helper()
	h.step()
}

func restackStackSuccessor(h *harness) *StepResult {
	h.t.Helper()
	recordStackPredecessor(h)
	return h.step()
}

func assertRestackWorktreesRemoved(t *testing.T, repo *testRepo) {
	t.Helper()
	out := runGit(t, repo.Dir, "worktree", "list", "--porcelain")
	if strings.Contains(out, "rk-autopilot-restack-") {
		t.Fatalf("temporary restack worktree remains: %s", out)
	}
}

func TestStackedMergesStepByStepRetargetsAndRebases(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	pending(prs[1])
	res := h.startMerge()
	if prs[0].State != "MERGED" || prs[0].MergeCalls != 1 || h.run.called("gh pr merge --auto") != 0 {
		t.Fatalf("first PR was not merged directly without arming: %+v", res)
	}
	if prs[1].MergeCalls != 0 || prs[1].Base != "s1-branch" {
		t.Fatal("the successor acted before its predecessor's merge was recorded")
	}
	res = restackStackSuccessor(h)
	if prs[1].Base != "main" || !hasAction(res, ActRetargeted, "pr-2") || !hasAction(res, ActRebased, "pr-2") {
		t.Fatalf("restack result = %+v / %+v", res.Actions, res.Escalations)
	}
	if !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/s2-branch") {
		t.Fatal("successor was not rebased onto the default tip")
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s2-branch"); n != "1" {
		t.Fatalf("successor carries %s commits beyond main, want one", n)
	}
	if prs[1].State == "MERGED" {
		t.Fatal("successor merged in its mutating pass")
	}
	assertRestackWorktreesRemoved(t, foo)
	if _, ok := h.item("pr-2").Scope["prepared"]; ok {
		t.Fatal("restack wrote a prepared marker")
	}

	h.run.reset()
	res = h.step()
	if hasAction(res, ActRebased, "") || h.run.called("git rebase --onto") != 0 || h.run.called("gh pr edit") != 0 {
		t.Fatalf("restack repeated after ancestry held: %+v / %q", res.Actions, h.run.calls)
	}
	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if prs[1].State != "MERGED" || h.run.called("gh pr merge --auto") != 0 {
		t.Fatal("restacked green PR did not merge directly")
	}
}

func TestStackedKeepsAnExistingRetargetUntouched(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	landSquash := h.gh.onMerge
	h.gh.onMerge = func(p *simPR) {
		landSquash(p)
		if p.Number == 1 {
			prs[1].Base = "main"
		}
	}
	h.startMerge()
	res := restackStackSuccessor(h)
	if h.run.called("gh pr edit") != 0 || !hasAction(res, ActRebased, "pr-2") {
		t.Fatalf("existing retarget was not preserved: %q / %+v", h.run.calls, res)
	}
	assertRestackWorktreesRemoved(t, foo)
}

func TestStackedRebaseConflictHaltsNeverSkips(t *testing.T) {
	h, foo, prs := stackFixture(t, "shared.txt", "s2 version\n")
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			p.MergeCommit = foo.advanceOrigin("shared.txt", "main version\n")
		}
	}
	h.startMerge()
	res := restackStackSuccessor(h)
	if !hasEscalation(res, "shared.txt") || !hasEscalation(res, "not skipped") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if prs[1].State == "MERGED" || prs[1].MergeCalls != 0 || !scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatal("a conflicting successor merged or was not halted")
	}
	assertRestackWorktreesRemoved(t, foo)
}

func TestStackedNeverMergesInThePassThatMutatedThePR(t *testing.T) {
	h, _, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.startMerge()
	res := restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-2") || prs[1].MergeCalls != 0 {
		t.Fatalf("mutating pass merged: %+v", res)
	}
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("fresh green state did not merge on the next pass")
	}
}

func TestStackedReadiesADraftBeforeMerging(t *testing.T) {
	h, _, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[0].IsDraft = true
	prs[1].IsDraft = true
	h.startMerge()
	if prs[0].IsDraft || prs[0].State == "MERGED" || h.run.called("gh pr ready 1") != 1 {
		t.Fatal("the first draft was not readied before merging")
	}
	h.step()
	recordStackPredecessor(h)
	h.step()
	if !prs[1].IsDraft || prs[1].State == "MERGED" {
		t.Fatal("a stale draft merged before being readied")
	}
	h.step()
	if prs[1].IsDraft || h.run.called("gh pr ready 2") != 1 {
		t.Fatal("the restacked draft was not readied")
	}
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("the readied green successor did not merge")
	}
	if h.run.called("gh pr merge --auto") != 0 {
		t.Fatal("a stacked PR was armed")
	}
}

func TestRestackIgnoresDivergedLocalBranch(t *testing.T) {
	h, foo, _ := stackFixture(t, "s2.txt", "s2\n")
	wt := filepath.Join(t.TempDir(), "local-s2")
	runGit(t, foo.Dir, "worktree", "add", wt, "s2-branch")
	commitFile(t, wt, "local-only.txt", "local\n", "local only")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	h.startMerge()
	restackStackSuccessor(h)
	if gitOK(foo.Dir, "show", "origin/s2-branch:local-only.txt") {
		t.Fatal("a diverged local commit entered the force-pushed branch")
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s2-branch"); n != "1" {
		t.Fatalf("remote branch carries %s commits, want one", n)
	}
}

func TestRestackLeaseRefusesAConcurrentRemoteHead(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	concurrent := ""
	h.run.onRun = func(argv []string) {
		if len(argv) > 1 && argv[0] == "git" && argv[1] == "push" {
			h.run.onRun = nil
			other := filepath.Join(t.TempDir(), "other")
			runGit(t, filepath.Dir(other), "clone", foo.Origin, other)
			runGit(t, other, "checkout", "s2-branch")
			concurrent = commitFile(t, other, "concurrent.txt", "concurrent\n", "concurrent push")
			runGit(t, other, "push", "origin", "s2-branch")
		}
	}
	res := h.step()
	if !hasEscalation(res, "push after rebase failed") || scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatalf("lease failure = %+v", res.Escalations)
	}
	if got := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch"); got != concurrent {
		t.Fatalf("concurrent head was overwritten: got %s want %s", got, concurrent)
	}
	pending(prs[1])
	res = h.step()
	if !hasAction(res, ActRebased, "pr-2") {
		t.Fatalf("failed push did not retry cleanly: %+v / %+v", res.Actions, res.Escalations)
	}
	h.run.reset()
	h.step()
	if h.run.called("git rebase --onto") != 0 || h.run.called("gh pr edit") != 0 {
		t.Fatal("restack repeated after the retry pushed")
	}
}

func TestRestackAfterPredecessorBranchDeletion(t *testing.T) {
	h, foo, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	runGit(t, foo.Dir, "push", "origin", "--delete", "s1-branch")
	res := restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-2") || !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/s2-branch") {
		t.Fatalf("deleted predecessor branch blocked restack: %+v / %+v", res.Actions, res.Escalations)
	}
}

func TestRestackDisarmsBeforeRetargetAndStopsOnDisarmFailure(t *testing.T) {
	t.Run("armed successor", func(t *testing.T) {
		h, _, prs := stackFixture(t, "s2.txt", "s2\n")
		prs[1].Armed = true
		h.startMerge()
		res := restackStackSuccessor(h)
		if prs[1].Armed || prs[1].Disarms != 1 || !hasAction(res, ActRebased, "pr-2") {
			t.Fatalf("armed stacked PR was not disarmed and restacked: %+v", res)
		}
		calls := strings.Join(h.run.calls, "\n")
		if strings.Index(calls, "gh pr merge --disable-auto") > strings.Index(calls, "gh pr edit") {
			t.Fatal("retarget happened before disarm")
		}
	})
	t.Run("failed disarm", func(t *testing.T) {
		h, _, prs := stackFixture(t, "s2.txt", "s2\n")
		prs[1].Armed = true
		h.startMerge()
		recordStackPredecessor(h)
		h.run.fail("gh pr merge --disable-auto", "HTTP 502")
		h.run.reset()
		res := h.step()
		if !hasEscalation(res, "disarming PR #2 failed") || h.run.called("gh pr edit") != 0 || h.run.called("git rebase") != 0 {
			t.Fatalf("failed disarm did not stop restack: %+v / %q", res.Escalations, h.run.calls)
		}
	})
}

func TestStackedStaleBaseWithoutPredecessorEscalatesOnce(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"})
	prs := h.shipped(1, "s1")
	prs[0].Base = "feature-x"
	res := h.startMerge()
	if !hasEscalation(res, "with no merged predecessor") || h.run.called("gh pr edit") != 0 || prs[0].MergeCalls != 0 {
		t.Fatalf("no-predecessor outcome = %+v / %q", res.Escalations, h.run.calls)
	}
	res = h.step()
	if hasEscalation(res, "with no merged predecessor") || h.run.called("gh pr edit") != 0 || prs[0].MergeCalls != 0 {
		t.Fatalf("no-predecessor escalation repeated or mutated: %+v", res)
	}
}

func TestRestackDryRunListsB1WithoutMutating(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	before := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch")
	h.env.DryRun = true
	h.run.reset()
	res := h.step()
	if !hasAction(res, string(ActionRestack), "pr-2") || h.run.called("gh pr edit") != 0 || h.run.called("git rebase") != 0 || h.run.called("git push") != 0 {
		t.Fatalf("dry run acted: %+v / %q", res.Actions, h.run.calls)
	}
	if len(res.Actions) != 1 || res.Actions[0].Detail != "(B1)" {
		t.Fatalf("dry-run actions = %+v", res.Actions)
	}
	if after := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch"); after != before || prs[1].Base != "s1-branch" {
		t.Fatal("dry run changed the branch or base")
	}
}

func TestStackedUnreadableStaleFactsWaitWithoutChecksOrMerge(t *testing.T) {
	for _, scenario := range []string{"merge commit", "compare"} {
		t.Run(scenario, func(t *testing.T) {
			h, _, prs := stackFixture(t, "s2.txt", "s2\n")
			prs[1].Base = "main"
			h.startMerge()
			recordStackPredecessor(h)
			if scenario == "merge commit" {
				h.run.fail("gh pr view 1 --json mergeCommit", "lookup failed")
			} else {
				h.run.fail("gh api repos/o/foo/compare/", "lookup failed")
			}
			h.run.reset()
			res := h.step()
			prefix := "predecessor merge commit lookup failed"
			if scenario == "compare" {
				prefix = "ancestry lookup failed"
			}
			if !hasEscalation(res, prefix) || h.run.called("gh pr checks 2") != 0 || prs[1].MergeCalls != 0 {
				t.Fatalf("unreadable facts outcome = %+v / %q", res.Escalations, h.run.calls)
			}
			if got := h.prStatusOf("pr-2"); got != PRWaiting {
				t.Fatalf("status = %s, want waiting", got)
			}
		})
	}
}

func TestCherryPickLadderDoesNotReadStaleBaseFacts(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("cherry-pick-ladder", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")
	prs[0].State = "MERGED"
	h.startMerge()
	h.step()
	h.step()
	for _, call := range h.run.calls {
		if strings.Contains(call, "mergeCommit") || strings.HasPrefix(call, "gh api ") {
			t.Fatalf("non-stacked PR read stale-base facts: %s", call)
		}
	}
}

func TestRestackCallsStayPinnedAndValidateBranches(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	e := newEngine(h.env)
	if err := e.patch("pr-2", func(it *operator.TrackedItem) { it.Scope["branch"] = "-bad" }); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	if !hasEscalation(res, "invalid or empty current branch") || h.run.called("git rebase") != 0 || h.run.called("git push") != 0 {
		t.Fatalf("invalid branch reached git: %+v", res.Escalations)
	}
}

func TestRestackResultNamesDefaultBranch(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	res := restackStackSuccessor(h)
	for _, action := range res.Actions {
		if action.Kind == ActRetargeted && action.Detail != "PR #2 → main" {
			t.Fatalf("retarget detail = %q", action.Detail)
		}
		if action.Kind == ActRebased && action.Detail != "s2-branch onto main" {
			t.Fatalf("rebase detail = %q", action.Detail)
		}
	}
}

func TestRestackTemporaryDirectoryUsesSystemTemp(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	h.run.onRun = func(argv []string) {
		if len(argv) > 2 && argv[0] == "git" && argv[1] == "worktree" && argv[2] == "add" {
			for _, arg := range argv {
				if strings.Contains(arg, "rk-autopilot-restack-") && !filepath.IsAbs(arg) {
					t.Fatalf("worktree path is not absolute: %s", arg)
				}
			}
		}
	}
	h.step()
}

func TestStackedMergeSequenceDoesNotArm(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	restackStackSuccessor(h)
	h.step()
	for _, call := range h.run.calls {
		if strings.HasPrefix(call, "gh pr merge --auto") {
			t.Fatalf("stacked PR armed: %s", call)
		}
	}
}

func TestRestackRetryEscalationNamesPR(t *testing.T) {
	h, _, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[0].HeadOid = strings.Repeat("f", 40)
	h.startMerge()
	recordStackPredecessor(h)
	res := h.step()
	if !hasEscalation(res, "cannot find predecessor head") {
		t.Fatalf("missing predecessor object did not escalate: %+v", res.Escalations)
	}
	for _, escalation := range res.Escalations {
		if strings.Contains(escalation.Reason, "cannot find predecessor head") && escalation.Item != "pr-2" {
			t.Fatalf("escalation item = %q, want pr-2", escalation.Item)
		}
	}
}

func TestRestackConflictDoesNotSkipDownstream(t *testing.T) {
	h, foo, prs := threeStackFixture(t, "shared.txt", "s2 version\n")
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			p.MergeCommit = foo.advanceOrigin("shared.txt", "main version\n")
		}
	}
	h.startMerge()
	res := restackStackSuccessor(h)
	if !scopeBool(h.item("pr-2"), scopeHalted) || prs[1].MergeCalls != 0 {
		t.Fatalf("conflict skipped the successor: %+v", res)
	}
	if scopeBool(h.item("pr-3"), scopeHalted) || prs[2].MergeCalls != 0 {
		t.Fatal("the downstream PR was directly marked or merged instead of sharing the derived halt")
	}
	if got := h.prStatusOf("pr-2"); got != PRHalted {
		t.Fatalf("PR2 status = %s, want halted", got)
	}
	if got := h.prStatusOf("pr-3"); got != PRHalted {
		t.Fatalf("PR3 status = %s, want halted through its predecessor", got)
	}
}

func TestRestackUsesDetachedHead(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	seen := false
	h.run.onRun = func(argv []string) {
		if len(argv) >= 4 && argv[0] == "git" && argv[1] == "worktree" && argv[2] == "add" {
			seen = true
			if argv[3] != "--detach" {
				t.Fatalf("worktree add argv = %v", argv)
			}
		}
	}
	h.step()
	if !seen {
		t.Fatal("no detached worktree was created")
	}
}

func TestRestackActionsIncludeNoPreparedMarker(t *testing.T) {
	h, _, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	restackStackSuccessor(h)
	if got := fmt.Sprint(h.item("pr-2").Scope); strings.Contains(got, "prepared") {
		t.Fatalf("scope = %s", got)
	}
}

func threeStackFixture(t *testing.T, s2File, s2Content string) (*harness, *testRepo, []*simPR) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("s1-branch", "main", "stack.txt", "one\n")
	wt := filepath.Join(t.TempDir(), "s1-second")
	runGit(t, foo.Dir, "worktree", "add", wt, "s1-branch")
	commitFile(t, wt, "stack.txt", "two\n", "pr1 second")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	foo.branch("s2-branch", "s1-branch", s2File, s2Content)
	foo.branch("s3-branch", "s2-branch", "s3.txt", "s3\n")
	for _, branch := range []string{"s1-branch", "s2-branch", "s3-branch"} {
		foo.pushBranch(branch)
	}
	h.queue("stacked-prs",
		Entry{ID: "s1", Repo: foo.Dir, Task: "s1"},
		Entry{ID: "s2", Repo: foo.Dir, Task: "s2"},
		Entry{ID: "s3", Repo: foo.Dir, Task: "s3"},
	)
	prs := h.shipped(1, "s1", "s2", "s3")
	for i, branch := range []string{"s1-branch", "s2-branch", "s3-branch"} {
		prs[i].HeadOid = runGit(t, foo.Dir, "rev-parse", branch)
	}
	prs[1].Base = "s1-branch"
	prs[2].Base = "s2-branch"
	prs[1].Origin = foo
	prs[2].Origin = foo
	h.gh.onMerge = func(p *simPR) {
		switch p.Number {
		case 1:
			p.MergeCommit = foo.advanceOrigin("stack.txt", "two\n")
		case 2:
			p.MergeCommit = foo.advanceOrigin(s2File, s2Content)
		}
	}
	return h, foo, prs
}

func TestStackedThreePRsRestackOnlyTheirOwnCommits(t *testing.T) {
	h, foo, prs := threeStackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	res := restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-2") {
		t.Fatalf("PR2 did not restack: %+v / %+v", res.Actions, res.Escalations)
	}
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("PR2 did not merge after its restack")
	}
	res = restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-3") || scopeBool(h.item("pr-3"), scopeHalted) {
		t.Fatalf("PR3 restack failed or halted: %+v / %+v", res.Actions, res.Escalations)
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s3-branch"); n != "1" {
		t.Fatalf("PR3 carries %s commits beyond main, want only its own commit", n)
	}
	if got := runGit(t, foo.Dir, "show", "origin/s3-branch:stack.txt"); got != "two" {
		t.Fatalf("PR3 inherited the wrong PR1 content: %q", got)
	}
	assertRestackWorktreesRemoved(t, foo)
	h.step()
	if prs[2].State != "MERGED" {
		t.Fatal("PR3 did not merge after its clean restack")
	}
	for i, p := range prs {
		if p.State != "MERGED" {
			t.Fatalf("PR%d state = %s, want MERGED", i+1, p.State)
		}
	}
}

func TestRestackDoesNotPushWithoutPredecessorMergeOnDefault(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	other := filepath.Join(t.TempDir(), "other")
	runGit(t, filepath.Dir(other), "clone", foo.Origin, other)
	runGit(t, other, "checkout", "-b", "side")
	side := commitFile(t, other, "side.txt", "side\n", "side merge")
	runGit(t, other, "push", "origin", "side")
	prs[0].MergeCommit = side
	recordStackPredecessor(h)
	before := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch")
	res := h.step()
	want := "predecessor merge commit " + side + " is not on main; PR #2 not pushed"
	if !hasEscalation(res, want) || scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatalf("missing predecessor merge outcome = %+v", res.Escalations)
	}
	if after := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch"); after != before {
		t.Fatal("branch moved without the predecessor merge on the default branch")
	}
	if h.run.called("git push") != 0 {
		t.Fatalf("pushed without predecessor ancestry: %q", h.run.calls)
	}
	assertRestackWorktreesRemoved(t, foo)
}

func TestRestackCleanupSurvivesPassCancellation(t *testing.T) {
	h, foo, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	ctx, cancel := context.WithCancel(context.Background())
	h.run.onRun = func(argv []string) {
		if len(argv) > 1 && argv[0] == "git" && argv[1] == "rebase" {
			cancel()
		}
	}
	res, err := Step(ctx, h.env)
	if err != nil {
		t.Fatal(err)
	}
	if scopeBool(h.item("pr-2"), scopeHalted) || !hasEscalation(res, "restack of PR #2 interrupted") {
		t.Fatalf("cancelled restack halted or did not escalate: %+v", res.Escalations)
	}
	assertRestackWorktreesRemoved(t, foo)
}

func TestStackedDefaultAndBaseMustBeProven(t *testing.T) {
	t.Run("guessed default", func(t *testing.T) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		runGit(t, foo.Dir, "update-ref", "-d", "refs/remotes/origin/HEAD")
		h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"})
		prs := h.shipped(1, "s1")
		h.run.fail("gh repo view --json defaultBranchRef", "GitHub unavailable")
		res := h.startMerge()
		if !hasEscalation(res, "default branch is unproven") || prs[0].MergeCalls != 0 {
			t.Fatalf("guessed default outcome = %+v", res.Escalations)
		}
		if got := h.prStatusOf("pr-1"); got != PRWaiting {
			t.Fatalf("status = %s, want waiting", got)
		}
	})
	t.Run("empty base", func(t *testing.T) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"})
		prs := h.shipped(1, "s1")
		prs[0].Base = ""
		res := h.startMerge()
		if !hasEscalation(res, "baseRefName is empty") || prs[0].MergeCalls != 0 {
			t.Fatalf("empty base outcome = %+v", res.Escalations)
		}
		if got := h.prStatusOf("pr-1"); got != PRWaiting {
			t.Fatalf("status = %s, want waiting", got)
		}
	})
}

func TestRestackChecksHeadAndUpstreamBeforeRetarget(t *testing.T) {
	h, foo, _ := stackFixture(t, "s2.txt", "s2\n")
	h.startMerge()
	recordStackPredecessor(h)
	observed := runGit(t, foo.Origin, "rev-parse", "refs/heads/s2-branch")
	h.step()
	calls := strings.Join(h.run.calls, "\n")
	headCheck := strings.Index(calls, "git rev-parse --verify -q refs/remotes/origin/s2-branch")
	cherry := strings.Index(calls, "git cherry")
	retarget := strings.Index(calls, "gh pr edit")
	if headCheck < 0 || cherry < 0 || retarget < 0 || !(headCheck < cherry && cherry < retarget) {
		t.Fatalf("safety checks and retarget are out of order: %q", h.run.calls)
	}
	worktreeAdd := strings.Index(calls, "git worktree add --detach")
	if worktreeAdd < 0 || !strings.Contains(calls[worktreeAdd:], observed) {
		t.Fatalf("worktree did not start at observed head %s: %q", observed, h.run.calls)
	}
}

func cherryPickCommit(t *testing.T, repo *testRepo, branch, sha string) {
	t.Helper()
	wt := filepath.Join(t.TempDir(), "cherry-pick")
	runGit(t, repo.Dir, "worktree", "add", wt, branch)
	runGit(t, wt, "cherry-pick", sha)
	runGit(t, repo.Dir, "worktree", "remove", "--force", wt)
}

func TestRestackKeepsOwnCommitBeforeCherryPickedPredecessorFix(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	p1a := foo.branch("s1-branch", "main", "stack.txt", "one\n")
	wt := filepath.Join(t.TempDir(), "s1-fix")
	runGit(t, foo.Dir, "worktree", "add", wt, "s1-branch")
	p1fix := commitFile(t, wt, "stack.txt", "two\n", "pr1 fix")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	foo.branch("s2-branch", p1a, "own.txt", "P2own\n")
	cherryPickCommit(t, foo, "s2-branch", p1fix)
	foo.pushBranch("s1-branch")
	foo.pushBranch("s2-branch")
	h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"}, Entry{ID: "s2", Repo: foo.Dir, Task: "s2"})
	prs := h.shipped(1, "s1", "s2")
	prs[0].HeadOid = p1fix
	prs[1].HeadOid = runGit(t, foo.Dir, "rev-parse", "s2-branch")
	prs[1].Base = "s1-branch"
	prs[1].Origin = foo
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			p.MergeCommit = foo.advanceOrigin("stack.txt", "two\n")
		}
	}
	h.startMerge()
	res := restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-2") || scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatalf("restack failed: %+v / %+v", res.Actions, res.Escalations)
	}
	if got := runGit(t, foo.Dir, "show", "origin/s2-branch:own.txt"); got != "P2own" {
		t.Fatalf("own commit was dropped: %q", got)
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s2-branch"); n != "1" {
		t.Fatalf("restacked branch has %s own commits, want one", n)
	}
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("PR2 did not merge with its own commit preserved")
	}
}

func TestRestackThreePRsKeepsCommitsAroundCherryPickedFix(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("s1-branch", "main", "stack.txt", "one\n")
	wt := filepath.Join(t.TempDir(), "s1-fix")
	runGit(t, foo.Dir, "worktree", "add", wt, "s1-branch")
	commitFile(t, wt, "stack.txt", "two\n", "pr1 fix")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	b1 := foo.branch("s2-branch", "s1-branch", "b1.txt", "B1\n")
	wt = filepath.Join(t.TempDir(), "s2-fix")
	runGit(t, foo.Dir, "worktree", "add", wt, "s2-branch")
	b1fix := commitFile(t, wt, "b1fix.txt", "fix\n", "pr2 fix")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	foo.branch("s3-branch", b1, "x.txt", "X\n")
	cherryPickCommit(t, foo, "s3-branch", b1fix)
	wt = filepath.Join(t.TempDir(), "s3-z")
	runGit(t, foo.Dir, "worktree", "add", wt, "s3-branch")
	commitFile(t, wt, "z.txt", "Z\n", "pr3 Z")
	runGit(t, foo.Dir, "worktree", "remove", "--force", wt)
	for _, branch := range []string{"s1-branch", "s2-branch", "s3-branch"} {
		foo.pushBranch(branch)
	}
	h.queue("stacked-prs",
		Entry{ID: "s1", Repo: foo.Dir, Task: "s1"},
		Entry{ID: "s2", Repo: foo.Dir, Task: "s2"},
		Entry{ID: "s3", Repo: foo.Dir, Task: "s3"},
	)
	prs := h.shipped(1, "s1", "s2", "s3")
	for i, branch := range []string{"s1-branch", "s2-branch", "s3-branch"} {
		prs[i].HeadOid = runGit(t, foo.Dir, "rev-parse", branch)
	}
	prs[1].Base = "s1-branch"
	prs[2].Base = "s2-branch"
	prs[1].Origin = foo
	prs[2].Origin = foo
	h.gh.onMerge = func(p *simPR) {
		switch p.Number {
		case 1:
			p.MergeCommit = foo.advanceOrigin("stack.txt", "two\n")
		case 2:
			foo.advanceOrigin("b1.txt", "B1\n")
			p.MergeCommit = foo.advanceOrigin("b1fix.txt", "fix\n")
		}
	}
	h.startMerge()
	restackStackSuccessor(h)
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("PR2 did not merge")
	}
	res := restackStackSuccessor(h)
	if !hasAction(res, ActRebased, "pr-3") || scopeBool(h.item("pr-3"), scopeHalted) {
		t.Fatalf("PR3 restack failed: %+v / %+v", res.Actions, res.Escalations)
	}
	for file, want := range map[string]string{"x.txt": "X", "z.txt": "Z"} {
		if got := runGit(t, foo.Dir, "show", "origin/s3-branch:"+file); got != want {
			t.Fatalf("%s = %q, want %q", file, got, want)
		}
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s3-branch"); n != "2" {
		t.Fatalf("PR3 has %s commits beyond main, want X and Z", n)
	}
	h.step()
	if prs[2].State != "MERGED" {
		t.Fatal("PR3 did not merge with X and Z preserved")
	}
}
