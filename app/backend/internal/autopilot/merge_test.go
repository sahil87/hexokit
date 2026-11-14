package autopilot

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

func TestMergeRefusesWhileItemsAreNotDone(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.shipped(1, "a")
	_, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if err == nil || !strings.Contains(err.Error(), "not done yet: b") {
		t.Fatalf("err = %v", err)
	}
	if h.has("pr-1") {
		t.Fatal("a refused merge created PR items")
	}
}

func TestMergeIsANoOpForMergeAutoItems(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.shipped(1, "a")
	res := h.startMerge()
	if len(res.Actions) != 0 || h.has("pr-1") {
		t.Fatalf("merge touched a merge-auto queue: %+v", res)
	}
}

func TestLadderArmsOnePRPerSequenceAndReportsMerges(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")

	res := h.startMerge()
	if !prs[0].Armed || prs[1].Armed {
		t.Fatalf("armed = %v, %v: exactly the first PR of the sequence may be armed", prs[0].Armed, prs[1].Armed)
	}
	if n := h.run.called("gh pr merge --auto --squash"); n != 1 {
		t.Fatalf("--auto --squash calls = %d, want 1 (the method flag is always explicit)", n)
	}
	if got := h.item("pr-2").DependsOn; len(got) != 1 || got[0] != "pr-1" {
		t.Fatalf("pr-2 depends_on = %v", got)
	}
	if scope := h.item("pr-1").Scope; operator.ScopeString(scope, "merge_seq") == "" || operator.ScopeString(scope, scopeItem) != "a" {
		t.Fatalf("pr-1 scope = %+v", scope)
	}
	if !hasAction(res, ActArmed, "pr-1") {
		t.Fatalf("actions = %+v", res.Actions)
	}

	if res := h.step(); prs[1].Armed || len(res.Report) != 0 {
		t.Fatalf("an unmerged head advanced the sequence: %+v", res)
	}

	prs[0].State = "MERGED"
	res = h.step()
	if !prs[1].Armed {
		t.Fatal("the next PR was not armed after the merge was verified")
	}
	if !operator.ItemDone(h.item("pr-1")) {
		t.Fatal("pr-1 not done after a verified merge")
	}
	wantLine := "a: merged (foo 1/2) · unreviewed"
	if len(res.Report) != 2 || res.Report[0] != wantLine || res.Report[1] != "merged without review: #1 (a)" {
		t.Fatalf("report = %q", res.Report)
	}

	prs[1].State = "MERGED"
	prs[1].Reviews = []reviewSummary{{State: "APPROVED"}}
	res = h.step()
	if len(res.Report) != 1 || res.Report[0] != "b: merged (foo 2/2)" {
		t.Fatalf("report = %q: a reviewed merge is not flagged", res.Report)
	}
}

func TestLadderReadiesADraftBeforeArming(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	prs[0].IsDraft = true
	h.startMerge()
	if prs[0].IsDraft || !prs[0].Armed {
		t.Fatalf("draft=%v armed=%v", prs[0].IsDraft, prs[0].Armed)
	}
}

func TestLadderAlreadyCleanRejectionMergesDirectly(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")
	prs[0].AutoErr = "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)"
	res := h.startMerge()
	if prs[0].MergeCalls != 1 || prs[0].State != "MERGED" {
		t.Fatalf("PR1 merges = %d state %s: a clean PR has nothing for auto-merge to wait on", prs[0].MergeCalls, prs[0].State)
	}
	if !prs[1].Armed {
		t.Fatal("the sequence did not move on after the direct merge was verified")
	}
	if len(res.Report) == 0 || !strings.HasPrefix(res.Report[0], "a: merged (foo 1/2)") {
		t.Fatalf("report = %q", res.Report)
	}
}

func TestLadderAutoMergeDisabledFallsBackToDirectMerge(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	prs[0].AutoErr = "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)"
	prs[0].Checks = []checkRun{{Name: "ci", State: "PENDING"}}
	h.startMerge()
	if prs[0].State == "MERGED" || prs[0].Armed {
		t.Fatal("merged with pending checks, or armed on a repo that forbids it")
	}
	if !scopeBool(h.item("pr-1"), scopeDirect) {
		t.Fatal("the direct-merge fallback is not recorded on the sequence")
	}
	prs[0].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if prs[0].State != "MERGED" {
		t.Fatal("the step-driven direct merge did not run once checks were green")
	}
}

func TestLadderCIFailedRecovery(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}

	var atSend operator.TrackedItem
	h.panes.onSend = func(string, string) { atSend = h.item("pr-1") }
	prs[0].Checks = []checkRun{{Name: "test (2/4)", State: "FAILURE", Link: "https://ci/run/9"}}

	res := h.step()
	if len(h.panes.sent) != 1 {
		t.Fatalf("sent = %q", h.panes.sent)
	}
	if operator.ScopeString(atSend.Scope, scopeRecovery) != "ci-fix" || operator.ScopeString(atSend.Scope, scopeFixHead) != prs[0].HeadOid {
		t.Fatalf("the marker must be persisted before the request is sent: scope at send = %+v", atSend.Scope)
	}
	want := "%7|CI failed on PR #1 (o/foo): check `test (2/4)` — run https://ci/run/9, shard 2/4.\nDiagnose and fix on this branch, push, and report the root cause in one line."
	if h.panes.sent[0] != want {
		t.Fatalf("sent %q\nwant %q", h.panes.sent[0], want)
	}
	if !prs[0].Armed || prs[0].Disarms != 0 || !hasAction(res, ActRecoverySent, "pr-1") {
		t.Fatalf("the PR must stay armed during the fix round: armed=%v disarms=%d actions=%+v", prs[0].Armed, prs[0].Disarms, res.Actions)
	}

	h.step()
	if len(h.panes.sent) != 1 {
		t.Fatal("a second fix request was sent: one round per reason")
	}
	if scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatal("halted while the round is still open on the same head")
	}

	// Green: the merge report says a fix round happened.
	prs[0].Checks = []checkRun{{Name: "test (2/4)", State: "SUCCESS"}}
	prs[0].State = "MERGED"
	res = h.step()
	if len(res.Report) == 0 || !strings.Contains(res.Report[0], "· after CI fix round") {
		t.Fatalf("report = %q", res.Report)
	}
}

func TestLadderCIStillRedOnANewHeadHaltsAndDisarms(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE", Link: "l"}}
	h.step()

	prs[0].HeadOid = "ffff0000ffff0000ffff0000ffff0000ffff0000"
	res := h.step()
	if prs[0].Disarms != 1 || prs[0].Armed {
		t.Fatalf("disarms = %d armed = %v", prs[0].Disarms, prs[0].Armed)
	}
	if !hasEscalation(res, "halted: CI still failing") || !scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if res := h.step(); len(res.Escalations) != 0 || prs[0].Disarms != 1 {
		t.Fatalf("a halted sequence acted again: %+v", res)
	}
}

func TestLadderCINoPushWithinTheWindowHalts(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	h.step()
	h.clock = h.clock.Add(29 * time.Minute)
	if res := h.step(); len(res.Escalations) != 0 {
		t.Fatalf("halted inside the window: %+v", res.Escalations)
	}
	h.clock = h.clock.Add(2 * time.Minute)
	res := h.step()
	if !hasEscalation(res, "no new push") || prs[0].Disarms != 1 {
		t.Fatalf("escalations = %+v disarms = %d", res.Escalations, prs[0].Disarms)
	}
}

func TestLadderCIFixDefersWhenTheAgentIsBusy(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	h.panes.busy = true
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	h.step()
	if operator.ScopeString(h.item("pr-1").Scope, scopeRecovery) != "" {
		t.Fatal("a deferred request must not leave a recovery marker behind")
	}
	h.panes.busy = false
	h.step()
	if len(h.panes.sent) != 1 {
		t.Fatalf("sent = %q: the next step should deliver it", h.panes.sent)
	}
}

func TestLadderCIFixSpawnsOnceWhenThePaneIsGone(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", "a.txt", "a\n")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE", Link: "l"}}

	res := h.step()
	if !hasAction(res, ActRecoverySpawn, "pr-1") || len(h.spawn.reqs) != 1 {
		t.Fatalf("actions = %+v reqs = %d", res.Actions, len(h.spawn.reqs))
	}
	req := h.spawn.reqs[0]
	if req.CheckoutBranch != "a-branch" || !strings.HasPrefix(req.Prompt, "CI failed on PR #1") || strings.HasPrefix(req.Prompt, "/") {
		t.Fatalf("request = %+v", req)
	}
	if !h.has("ab12-fix") {
		t.Fatal("the recovery spawn is not tracked as <change>-fix")
	}
	h.step()
	if len(h.spawn.reqs) != 1 {
		t.Fatal("a second recovery spawn was made")
	}

	prs[0].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if h.has("ab12-fix") {
		t.Fatal("the fix item must be removed when the round resolves")
	}
}

func TestLadderConflictingRecoveryRebasesRearmsThenHaltsIfItRecurs(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", "a.txt", "a\n")
	foo.pushBranch("a-branch")
	foo.advanceOrigin("other.txt", "o\n")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	prs[0].Mergeable = "CONFLICTING"

	for i := 0; i < 3; i++ {
		if res := h.step(); hasAction(res, ActRebased, "") {
			t.Fatalf("rebased after only %d quiet polls: the stall rule needs 3", i)
		}
	}
	res := h.step()
	if !hasAction(res, ActRebased, "pr-1") || !hasAction(res, ActArmed, "pr-1") {
		t.Fatalf("actions = %+v escalations = %+v", res.Actions, res.Escalations)
	}
	if got := operator.ScopeString(h.item("pr-1").Scope, scopeRecovery); got != "rebase" {
		t.Fatalf("recovery = %q", got)
	}
	if !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/a-branch") {
		t.Fatal("the rebased branch was not pushed on top of origin/main")
	}
	if n := h.run.called("gh pr merge --auto --squash"); n != 2 {
		t.Fatalf("--auto calls = %d, want the initial arm and the re-arm", n)
	}

	res = h.step()
	if !hasEscalation(res, "CONFLICTING again") || prs[0].Disarms != 1 {
		t.Fatalf("escalations = %+v disarms = %d", res.Escalations, prs[0].Disarms)
	}
}

func TestLadderConflictingRebaseConflictAbortsAndHalts(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", "shared.txt", "branch version\n")
	foo.pushBranch("a-branch")
	foo.advanceOrigin("shared.txt", "main version\n")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	prs[0].Mergeable = "CONFLICTING"
	var res *StepResult
	for i := 0; i < 4; i++ {
		res = h.step()
	}
	if !hasEscalation(res, "shared.txt") || prs[0].Disarms != 1 {
		t.Fatalf("escalations = %+v disarms = %d: the halt must name the conflicting files", res.Escalations, prs[0].Disarms)
	}
	if !scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatal("not halted")
	}
}

func TestHaltDisarmsOnlyTheCone(t *testing.T) {
	h := newHarness(t)
	foo, bar, baz := newRepo(t, "foo"), newRepo(t, "bar"), newRepo(t, "baz")
	none := &[]string{}
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Change: "f1ch", DependsOn: none},
		Entry{ID: "b1", Repo: bar.Dir, Change: "b1ch", DependsOn: &[]string{"f1"}},
		Entry{ID: "z1", Repo: baz.Dir, Change: "z1ch", DependsOn: none},
	)
	fp := h.shipped(1, "f1")
	bp := h.shipped(2, "b1")
	zp := h.shipped(3, "z1")
	h.startMerge()
	if !fp[0].Armed || bp[0].Armed || !zp[0].Armed {
		t.Fatalf("armed foo=%v bar=%v baz=%v: bar waits behind foo across repos", fp[0].Armed, bp[0].Armed, zp[0].Armed)
	}
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-f1ch-x"}
	fp[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	h.step()
	fp[0].HeadOid = "ffff0000ffff0000ffff0000ffff0000ffff0000"
	h.step()

	if fp[0].Disarms != 1 || zp[0].Disarms != 0 || !zp[0].Armed {
		t.Fatalf("disarms foo=%d baz=%d bazArmed=%v: only the halted cone is disarmed", fp[0].Disarms, zp[0].Disarms, zp[0].Armed)
	}
	if !scopeBool(h.item("pr-2"), scopeHalted) || scopeBool(h.item("pr-3"), scopeHalted) {
		t.Fatal("bar's sequence is in foo's cone; baz's is independent")
	}
	zp[0].State = "MERGED"
	res := h.step()
	if len(res.Report) == 0 || !strings.HasPrefix(res.Report[0], "z1: merged (baz 1/1)") {
		t.Fatalf("the independent sequence stopped: %+v", res)
	}
}

func TestStopDisarmsEverythingAndPausesUnspawnedItems(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	none := &[]string{}
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Task: "f", DependsOn: none},
		Entry{ID: "b1", Repo: bar.Dir, Task: "b", DependsOn: none},
		Entry{ID: "later", Repo: foo.Dir, Task: "later", DependsOn: &[]string{"f1"}},
	)
	fp := h.shipped(1, "f1")
	bp := h.shipped(2, "b1")
	h.setDone("later")
	h.attachBranch("later", "later-branch")
	h.gh.add(9, "later-branch")
	h.startMerge()
	if !fp[0].Armed || !bp[0].Armed {
		t.Fatal("fixture: both repos' first PRs should be armed")
	}
	// A pending item that has not spawned yet.
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		it, _ := operator.NewPaneItem("queued", nil, map[string]interface{}{"repo": foo.Dir, "merge_mode": "cherry-pick-ladder", scopeTask: "q"})
		st.Tracked = append(st.Tracked, it)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	res, err := Stop(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	if fp[0].Armed || bp[0].Armed || fp[0].Disarms != 1 || bp[0].Disarms != 1 {
		t.Fatalf("stop must disarm every armed PR: foo=%v bar=%v", fp[0].Armed, bp[0].Armed)
	}
	if !h.item("queued").Paused || !hasAction(res, ActPaused, "queued") {
		t.Fatal("the unspawned queue item was not paused")
	}
	h.step()
	if fp[0].Armed || bp[0].Armed {
		t.Fatal("a step after stop re-armed a PR")
	}
	if len(h.spawn.reqs) != 0 {
		t.Fatal("a step after stop spawned a paused item")
	}
}

// stackFixture is two stacked PRs in one repo: s2-branch is cut from s1-branch,
// both pushed, with s1's squash merge simulated on origin when PR1 merges.
func stackFixture(t *testing.T, s2File, s2Content string) (*harness, *testRepo, []*simPR) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("s1-branch", "main", "s1.txt", "s1\n")
	foo.branch("s2-branch", "s1-branch", s2File, s2Content)
	foo.pushBranch("s1-branch")
	foo.pushBranch("s2-branch")
	h.queue("stacked-prs", Entry{ID: "s1", Repo: foo.Dir, Task: "s1"}, Entry{ID: "s2", Repo: foo.Dir, Task: "s2"})
	prs := h.shipped(1, "s1", "s2")
	prs[1].Base = "s1-branch"
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			foo.advanceOrigin("s1.txt", "s1\n")
		}
	}
	return h, foo, prs
}

func TestStackedMergesStepByStepRetargetsAndRebases(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[1].Checks = []checkRun{{Name: "ci", State: "PENDING"}}

	res := h.startMerge()
	if n := h.run.called("gh pr merge --auto"); n != 0 {
		t.Fatalf("a stacked PR was armed (%d times): it could merge into its dependency's branch", n)
	}
	if prs[0].State != "MERGED" || prs[0].MergeCalls != 1 {
		t.Fatalf("PR1 state %s: a green, mergeable head merges directly", prs[0].State)
	}
	if prs[1].Base != "main" || !hasAction(res, ActRetargeted, "pr-2") {
		t.Fatalf("PR2 base = %q actions = %+v", prs[1].Base, res.Actions)
	}
	if !hasAction(res, ActRebased, "pr-2") || !scopeBool(h.item("pr-2"), scopePrepared) {
		t.Fatalf("actions = %+v escalations = %+v", res.Actions, res.Escalations)
	}
	if !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/s2-branch") {
		t.Fatal("s2 was not rebased onto the new default tip")
	}
	if n := runGit(t, foo.Dir, "rev-list", "--count", "origin/main..origin/s2-branch"); n != "1" {
		t.Fatalf("s2 carries %s commits beyond main, want only its own", n)
	}
	if prs[1].State == "MERGED" {
		t.Fatal("PR2 merged while its checks were pending")
	}
	if len(res.Report) != 2 || !strings.HasPrefix(res.Report[0], "s1: merged (foo 1/2)") {
		t.Fatalf("report = %q", res.Report)
	}

	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	res = h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("PR2 did not merge once its checks were green")
	}
	if n := h.run.called("gh pr edit"); n != 1 {
		t.Fatalf("retargets = %d, want exactly 1", n)
	}
}

func TestStackedKeepsAnExistingRetargetUntouched(t *testing.T) {
	h, _, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[1].Checks = []checkRun{{Name: "ci", State: "PENDING"}}
	landSquash := h.gh.onMerge
	h.gh.onMerge = func(p *simPR) {
		landSquash(p)
		if p.Number == 1 {
			prs[1].Base = "main" // GitHub retargeted when the merged base branch was deleted
		}
	}
	h.startMerge()
	if n := h.run.called("gh pr edit"); n != 0 {
		t.Fatalf("retargeted a PR GitHub had already retargeted (%d edits)", n)
	}
	if !scopeBool(h.item("pr-2"), scopePrepared) {
		t.Fatal("the rebase must still run after a retarget GitHub did itself")
	}
}

func TestStackedRebaseConflictHaltsNeverSkips(t *testing.T) {
	h, foo, prs := stackFixture(t, "shared.txt", "s2 version\n")
	h.gh.onMerge = func(p *simPR) {
		if p.Number == 1 {
			foo.advanceOrigin("shared.txt", "main version\n")
		}
	}
	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	res := h.startMerge()
	if !hasEscalation(res, "shared.txt") || !hasEscalation(res, "not skipped") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if prs[1].State == "MERGED" || prs[1].MergeCalls != 0 {
		t.Fatal("a conflicting stacked PR was merged")
	}
	if !scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatal("the sequence is not halted")
	}
}

func TestMergeAutoDefersTheNextSpawnUntilTheMergeIsVerified(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	pr := h.gh.add(1, "a-branch")

	res := h.step()
	if !pr.Armed || !hasAction(res, ActPRTracked, "a") {
		t.Fatalf("a shipped merge-auto item must get its PR armed: %+v", res.Actions)
	}
	if len(h.spawn.reqs) != 0 {
		t.Fatalf("spawned b before a's merge was verified: %+v", h.spawn.reqs)
	}
	h.step()
	if len(h.spawn.reqs) != 0 {
		t.Fatal("spawned b while a's PR is armed but unmerged")
	}

	pr.State = "MERGED"
	tip := foo.advanceOrigin("merged.txt", "m\n")
	res = h.step()
	if len(h.spawn.reqs) != 1 || h.spawn.reqs[0].WorktreeName != "b" {
		t.Fatalf("spawn requests = %+v", h.spawn.reqs)
	}
	if got := h.spawn.reqs[0].BaseSHA; got != tip {
		t.Fatalf("b based on %s, want the advanced origin tip %s", got, tip)
	}
	if len(res.Report) == 0 || !strings.HasPrefix(res.Report[0], "a: merged (foo 1/1)") {
		t.Fatalf("report = %q", res.Report)
	}
}

func TestMergeAutoHaltDisarmsOnePRAndKeepsTheNextDeferred(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	pr := h.gh.add(1, "a-branch")
	h.step()
	pr.State = "CLOSED"
	res := h.step()
	if !hasEscalation(res, "closed without merging") || pr.Disarms != 1 {
		t.Fatalf("escalations = %+v disarms = %d", res.Escalations, pr.Disarms)
	}
	h.step()
	if len(h.spawn.reqs) != 0 {
		t.Fatal("b spawned after a halted merge-auto PR")
	}
}

func TestStatusDerivesFromStoredStateAndSummarises(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "ab12", Repo: foo.Dir, Task: "a"},
		Entry{ID: "cd34", Repo: bar.Dir, Task: "b"},
		Entry{ID: "ef56", Repo: foo.Dir, Task: "c"},
	)
	res, err := Status(context.Background(), h.env)
	if err != nil || len(res.Items) != 3 || res.Complete || res.Summary != "" {
		t.Fatalf("status = %+v err %v", res, err)
	}
	if res.Items[0].State != StatePending || res.Items[1].State != StateHeld || res.Items[0].Mode != "cherry-pick-ladder" {
		t.Fatalf("items = %+v", res.Items)
	}

	prs := h.shipped(1, "ab12", "cd34", "ef56")
	_ = prs
	res, err = Status(context.Background(), h.env)
	if err != nil || !res.Complete {
		t.Fatalf("status = %+v err %v", res, err)
	}
	want := []string{
		"Queue complete. 3 PRs ready for review:",
		fmt.Sprintf("1. ab12: https://example.test/pull/1 (%s, base)", foo.Dir),
		fmt.Sprintf("2. cd34: https://example.test/pull/2 (%s, ordering-only after ab12)", bar.Dir),
		fmt.Sprintf("3. ef56: https://example.test/pull/3 (%s, depends on ab12)", foo.Dir),
		"Merge per-repo: foo 1→3, bar 2 (after foo:1 reaches main). Or ask me to merge all.",
	}
	if res.Summary != strings.Join(want, "\n") {
		t.Fatalf("summary:\n%s\nwant:\n%s", res.Summary, strings.Join(want, "\n"))
	}
}
