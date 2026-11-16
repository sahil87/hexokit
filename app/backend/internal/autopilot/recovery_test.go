package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

func ciRecoveryFixture(t *testing.T, authoring bool) (*harness, *testRepo, *simPR) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", "a.txt", "a\n")
	foo.pushBranch("a-branch")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	pr := prs[0]
	pr.HeadOid = runGit(t, foo.Dir, "rev-parse", "origin/a-branch")
	pending(pr)
	h.startMerge()
	if authoring {
		h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	}
	pr.Checks = []checkRun{{Name: "test (2/4)", State: "FAILURE", Link: "https://ci/run/9"}}
	return h, foo, pr
}

func conflictRecoveryFixture(t *testing.T, branchFile, branchContent, mainFile, mainContent string) (*harness, *testRepo, *simPR) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", branchFile, branchContent)
	foo.pushBranch("a-branch")
	foo.advanceOrigin(mainFile, mainContent)
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	pr := prs[0]
	pr.HeadOid = runGit(t, foo.Dir, "rev-parse", "origin/a-branch")
	pending(pr)
	h.startMerge()
	pr.Mergeable = "CONFLICTING"
	return h, foo, pr
}

func stepUntilRebase(h *harness) *StepResult {
	var res *StepResult
	for i := 0; i < 4; i++ {
		res = h.step()
		if hasAction(res, ActRebased, "pr-1") {
			break
		}
	}
	return res
}

func TestFixRequestWritesIntentBeforeSend(t *testing.T) {
	h, _, pr := ciRecoveryFixture(t, true)
	h.panes.onSend = func(pane, text string) {
		it := h.item("pr-1")
		if !roundSpent(it, recoveryCIFix) || operator.ScopeString(it.Scope, scopeFixHead) != pr.HeadOid || operator.ScopeString(it.Scope, scopeRecoverAt) == "" {
			t.Fatalf("intent was not durable at send: %+v", it.Scope)
		}
	}
	res := h.step()
	if !hasAction(res, ActRecoverySent, "pr-1") || len(h.panes.sent) != 1 {
		t.Fatalf("res = %+v sent = %q", res, h.panes.sent)
	}
	want := "%7|CI failed on PR #1 (o/foo): check `test (2/4)` — run https://ci/run/9, shard 2/4.\nDiagnose and fix on this branch, push, and report the root cause in one line."
	if h.panes.sent[0] != want {
		t.Fatalf("sent %q\nwant %q", h.panes.sent[0], want)
	}
}

func TestFixRequestBusyRollbackAndUncertainDelivery(t *testing.T) {
	t.Run("busy rolls back and retries", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, true)
		h.panes.sendErr = ErrPaneBusy
		h.step()
		it := h.item("pr-1")
		if roundSpent(it, recoveryCIFix) || operator.ScopeString(it.Scope, scopeFixHead) != "" || operator.ScopeString(it.Scope, scopeRecoverAt) != "" {
			t.Fatalf("busy send left intent: %+v", it.Scope)
		}
		h.panes.sendErr = nil
		h.step()
		if len(h.panes.sent) != 1 || !roundSpent(h.item("pr-1"), recoveryCIFix) {
			t.Fatalf("retry did not send exactly once: %q", h.panes.sent)
		}
	})
	t.Run("uncertain delivery keeps the round", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, true)
		h.panes.sendErr = errors.New("connection lost after write")
		res := h.step()
		it := h.item("pr-1")
		if !roundSpent(it, recoveryCIFix) || !hasEscalation(res, "CI fix request delivery uncertain") {
			t.Fatalf("res = %+v scope = %+v", res, it.Scope)
		}
		h.panes.sendErr = nil
		h.step()
		if len(h.panes.sent) != 0 {
			t.Fatal("an uncertain round was spent twice")
		}
	})
}

func TestCINoPushWindowHaltsAndResumeDoesNotRefund(t *testing.T) {
	h, _, pr := ciRecoveryFixture(t, true)
	h.step()
	h.clock = h.clock.Add(29 * time.Minute)
	if res := h.step(); hasEscalation(res, "no new push") {
		t.Fatalf("halted inside the window: %+v", res)
	}
	h.clock = h.clock.Add(2 * time.Minute)
	res := h.step()
	if !hasEscalation(res, "no new push 30m0s") || pr.Disarms != 1 || !scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatalf("no-push halt = %+v disarms = %d", res, pr.Disarms)
	}
	res, err := Resume(context.Background(), h.env, "pr-1")
	if err != nil {
		t.Fatal(err)
	}
	it := h.item("pr-1")
	if !roundSpent(it, recoveryCIFix) || !scopeBool(it, scopeHalted) || !hasEscalation(res, "no new push") || len(h.panes.sent) != 1 {
		t.Fatalf("resume refunded or did not re-halt: %+v scope = %+v", res, it.Scope)
	}
}

func TestRecoverySpawnOnceAndSpawnFailures(t *testing.T) {
	t.Run("success spawns once and projects a pane", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, false)
		res := h.step()
		if !hasAction(res, ActRecoverySpawn, "ab12-fix") || h.spawn.n != 1 {
			t.Fatalf("res = %+v launches = %d", res, h.spawn.n)
		}
		req := h.spawn.reqs[0]
		if req.CheckoutBranch != "a-branch" || !strings.HasPrefix(req.Prompt, "CI failed on PR #1") || strings.HasPrefix(req.Prompt, "/") {
			t.Fatalf("request = %+v", req)
		}
		fix := h.item("ab12-fix")
		if operator.ScopeString(h.item("pr-1").Scope, scopeFixItem) != "ab12-fix" || operator.ScopeString(fix.Scope, "pane") == "" || spawningSet(fix) {
			t.Fatalf("fix binding = %+v", fix)
		}
		ledger, err := operator.Load(h.env.StatePath)
		if err != nil {
			t.Fatal(err)
		}
		projection := ledger.Tracked[operator.IndexOf(ledger.Tracked, "ab12-fix")]
		if projection.Kind != operator.KindPane {
			t.Fatalf("projection kind = %s", projection.Kind)
		}
		h.step()
		if h.spawn.n != 1 {
			t.Fatal("a second recovery agent launched")
		}
	})
	t.Run("worktree lookup spends the round but never launches", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, false)
		h.env.Run = failingGitRunner{Runner: h.run, prefix: "git worktree list"}
		res := h.step()
		if h.spawn.n != 0 || !hasEscalation(res, "git worktree list failed") || !roundSpent(h.item("pr-1"), recoveryCIFix) {
			t.Fatalf("res = %+v launches = %d", res, h.spawn.n)
		}
		if !spawningSet(h.item("ab12-fix")) {
			t.Fatal("failed launch did not leave spawning for F2")
		}
	})
	t.Run("unopened launch stays spawning and escalates once", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, false)
		h.spawn.failWith = errors.New("launch unavailable")
		h.step()
		if !spawningSet(h.item("ab12-fix")) || h.spawn.n != 1 {
			t.Fatal("unopened launch lost its spawn intent")
		}
		res := h.step()
		if h.spawn.n != 1 || !hasEscalation(res, "spawn interrupted: ab12-fix") {
			t.Fatalf("F2 = %+v launches = %d", res, h.spawn.n)
		}
	})
	t.Run("attach failure leaves spawning for F2 without relaunch", func(t *testing.T) {
		h, _, _ := ciRecoveryFixture(t, false)
		h.spawn.during = func() { readOnlyState(t, h) }
		res := h.step()
		if !hasEscalation(res, "recording its engine binding failed") || !spawningSet(h.item("ab12-fix")) {
			t.Fatalf("attach failure = %+v", res)
		}
		restoreStateWrites(t, h)
		h.spawn.during = nil
		res = h.step()
		if h.spawn.n != 1 || !hasEscalation(res, "spawn interrupted: ab12-fix") {
			t.Fatalf("attach recovery = %+v launches = %d", res, h.spawn.n)
		}
		if res = h.step(); hasEscalation(res, "spawn interrupted: ab12-fix") {
			t.Fatalf("F2 escalated twice: %+v", res)
		}
	})
}

func TestFixUntrackResolutionPaths(t *testing.T) {
	for _, scenario := range []string{"green", "merged", "halted", "missing-parent"} {
		t.Run(scenario, func(t *testing.T) {
			h, _, pr := ciRecoveryFixture(t, false)
			h.step()
			if !h.has("ab12-fix") {
				t.Fatal("fixture has no fix item")
			}
			switch scenario {
			case "green":
				pr.HeadOid = "new-fix-head"
				pr.Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
			case "merged":
				pr.State = "MERGED"
			case "halted":
				if err := newEngine(h.env).setScope("pr-1", map[string]interface{}{scopeHalted: true}); err != nil {
					t.Fatal(err)
				}
			case "missing-parent":
				if err := newEngine(h.env).mutateEngine(func(st *engineState) error {
					st.remove("pr-1")
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			res := h.step()
			if h.has("ab12-fix") || !hasAction(res, ActUntracked, "ab12-fix") {
				t.Fatalf("fix was not untracked: %+v", res)
			}
			ledger, err := operator.Load(h.env.StatePath)
			if err != nil || operator.IndexOf(ledger.Tracked, "ab12-fix") >= 0 {
				t.Fatalf("fix projection remains: %+v, %v", ledger.Tracked, err)
			}
			if scenario != "missing-parent" && operator.ScopeString(h.item("pr-1").Scope, scopeFixItem) != "" {
				t.Fatal("parent still names the removed fix")
			}
		})
	}
}

func TestRebaseSuccessLeavesAuthoringTreeAndRearmsNextPass(t *testing.T) {
	h, foo, pr := conflictRecoveryFixture(t, "a.txt", "a\n", "other.txt", "o\n")
	authoring := filepath.Join(t.TempDir(), "authoring")
	runGit(t, foo.Dir, "worktree", "add", authoring, "a-branch")
	t.Cleanup(func() { runGit(t, foo.Dir, "worktree", "remove", "--force", authoring) })
	write(t, filepath.Join(authoring, "local-note.txt"), "keep me\n")
	authorHead := runGit(t, authoring, "rev-parse", "HEAD")
	autoCalls := h.run.called("gh pr merge --auto")
	res := stepUntilRebase(h)
	if !hasAction(res, ActRebased, "pr-1") {
		t.Fatalf("rebase = %+v", res)
	}
	if h.run.called("gh pr merge --auto") != autoCalls {
		t.Fatal("C5 re-armed instead of leaving P6 for the next pass")
	}
	if !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/a-branch") {
		t.Fatal("remote branch was not rebased and pushed")
	}
	if got := runGit(t, authoring, "rev-parse", "HEAD"); got != authorHead {
		t.Fatal("authoring worktree HEAD moved")
	}
	data, err := os.ReadFile(filepath.Join(authoring, "local-note.txt"))
	if err != nil || string(data) != "keep me\n" {
		t.Fatalf("authoring worktree was touched: %q, %v", data, err)
	}
	if strings.Contains(runGit(t, foo.Dir, "worktree", "list", "--porcelain"), "rk-autopilot-rebase-") {
		t.Fatal("temporary worktree remains")
	}
	pr.Mergeable = "MERGEABLE"
	pr.Armed = false
	res = h.step()
	if !pr.Armed || !hasAction(res, ActArmed, "pr-1") {
		t.Fatalf("P6 did not re-arm on the next pass: %+v", res)
	}
}

func TestRebaseConflictAbortsSpendsRoundAndHalts(t *testing.T) {
	h, foo, pr := conflictRecoveryFixture(t, "shared.txt", "branch version\n", "shared.txt", "main version\n")
	res := stepUntilRebase(h)
	it := h.item("pr-1")
	if !hasEscalation(res, "shared.txt") || !scopeBool(it, scopeHalted) || !roundSpent(it, recoveryRebase) || pr.Disarms != 1 {
		t.Fatalf("conflict result = %+v scope = %+v", res, it.Scope)
	}
	if strings.Contains(runGit(t, foo.Dir, "worktree", "list", "--porcelain"), "rk-autopilot-rebase-") {
		t.Fatal("conflicted temporary worktree remains")
	}
}

func TestRebaseLeaseRejectsConcurrentPush(t *testing.T) {
	h, foo, _ := conflictRecoveryFixture(t, "a.txt", "a\n", "other.txt", "o\n")
	concurrent := ""
	h.run.onRun = func(argv []string) {
		if len(argv) < 2 || argv[0] != "git" || argv[1] != "rebase" {
			return
		}
		h.run.onRun = nil
		other := filepath.Join(t.TempDir(), "concurrent")
		runGit(t, filepath.Dir(other), "clone", foo.Origin, other)
		runGit(t, other, "checkout", "-b", "a-branch", "origin/a-branch")
		concurrent = commitFile(t, other, "concurrent.txt", "do not overwrite\n", "concurrent push")
		runGit(t, other, "push", "origin", "a-branch")
	}
	res := stepUntilRebase(h)
	if !hasEscalation(res, "push after rebase failed") || hasAction(res, ActRebased, "pr-1") {
		t.Fatalf("stale lease result = %+v", res)
	}
	if !roundSpent(h.item("pr-1"), recoveryRebase) {
		t.Fatal("push failure refunded the rebase round")
	}
	if got := runGit(t, foo.Origin, "rev-parse", "a-branch"); got != concurrent {
		t.Fatalf("concurrent head was overwritten: got %s want %s", got, concurrent)
	}
}

func TestRebaseFetchFailureDoesNotSpendRound(t *testing.T) {
	h, _, _ := conflictRecoveryFixture(t, "a.txt", "a\n", "other.txt", "o\n")
	for i := 0; i < 3; i++ {
		h.step()
	}
	h.env.Run = failingGitRunner{Runner: h.run, prefix: "git fetch origin"}
	res := h.step()
	if !hasEscalation(res, "git fetch failed") || roundSpent(h.item("pr-1"), recoveryRebase) {
		t.Fatalf("fetch failure = %+v", res)
	}
	if h.run.called("git push") != 0 {
		t.Fatal("fetch failure reached push")
	}
}

func TestRebaseCleanupAndAbortFailuresEscalate(t *testing.T) {
	t.Run("cleanup", func(t *testing.T) {
		h, _, _ := conflictRecoveryFixture(t, "a.txt", "a\n", "other.txt", "o\n")
		for i := 0; i < 3; i++ {
			h.step()
		}
		h.env.Run = failingGitRunner{Runner: h.run, prefix: "git worktree remove --force"}
		res := h.step()
		if !hasAction(res, ActRebased, "pr-1") || !hasEscalation(res, "worktree cleanup failed") {
			t.Fatalf("cleanup failure = %+v", res)
		}
	})
	t.Run("conflict inspection and abort", func(t *testing.T) {
		h, _, _ := conflictRecoveryFixture(t, "shared.txt", "branch version\n", "shared.txt", "main version\n")
		for i := 0; i < 3; i++ {
			h.step()
		}
		run := failingGitRunner{Runner: h.run, prefix: "git diff --name-only"}
		h.env.Run = failingGitRunner{Runner: run, prefix: "git rebase --abort"}
		res := h.step()
		if !hasEscalation(res, "git conflict-file lookup failed") || !hasEscalation(res, "git rebase --abort failed") || !scopeBool(h.item("pr-1"), scopeHalted) {
			t.Fatalf("abort failures = %+v", res)
		}
	})
}

func TestRecoveryBudgetsAreIndependent(t *testing.T) {
	h, _, pr := ciRecoveryFixture(t, true)
	h.step()
	before := h.item("pr-1")
	fixHead := operator.ScopeString(before.Scope, scopeFixHead)
	recoveryAt := operator.ScopeString(before.Scope, scopeRecoverAt)
	if err := newEngine(h.env).setScope("pr-1", map[string]interface{}{scopeFixHead: "older-fix-head"}); err != nil {
		t.Fatal(err)
	}
	pr.Checks = []checkRun{{Name: "ci", State: "PENDING"}}
	pr.Mergeable = "CONFLICTING"
	res := stepUntilRebase(h)
	it := h.item("pr-1")
	if !hasAction(res, ActRebased, "pr-1") || !roundSpent(it, recoveryCIFix) || !roundSpent(it, recoveryRebase) {
		t.Fatalf("budgets = %+v res = %+v", it.Scope, res)
	}
	if operator.ScopeString(it.Scope, scopeRecoverAt) != recoveryAt || fixHead == "" {
		t.Fatal("rebase rewrote CI round metadata")
	}
}

func TestConflictingRejectsMalformedSharedBranch(t *testing.T) {
	for _, branch := range []string{"", "--force", "bad..branch"} {
		t.Run(fmt.Sprintf("branch_%q", branch), func(t *testing.T) {
			h, _, _ := conflictRecoveryFixture(t, "a.txt", "a\n", "other.txt", "o\n")
			if err := newEngine(h.env).setScope("pr-1", map[string]interface{}{"branch": branch}); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 3; i++ {
				h.step()
			}
			h.run.reset()
			res := h.step()
			if !hasEscalation(res, "invalid or empty recovery branch") || roundSpent(h.item("pr-1"), recoveryRebase) {
				t.Fatalf("invalid branch result = %+v", res)
			}
			if h.run.called("git push") != 0 || h.run.called("git rebase") != 0 || h.run.called("git worktree add") != 0 {
				t.Fatalf("invalid branch mutated git: %q", h.run.calls)
			}
		})
	}
}
