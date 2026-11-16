package autopilot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

	// Green on the fix push: the merge report says a fix round happened.
	prs[0].HeadOid = "fixed-head"
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

	prs[0].HeadOid = "fixed-head"
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

func TestStackedNeverMergesInThePassThatMutatedThePR(t *testing.T) {
	h, foo, prs := stackFixture(t, "s2.txt", "s2\n")
	// Stale green: the view taken before the retarget and force-push is green
	// and mergeable, and must not authorize a merge in the same pass.
	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}

	res := h.startMerge()
	if !hasAction(res, ActRebased, "pr-2") {
		t.Fatalf("fixture: expected the rebase, got %+v / %+v", res.Actions, res.Escalations)
	}
	if prs[1].State == "MERGED" || prs[1].MergeCalls != 0 {
		t.Fatal("PR2 merged in the same pass that retargeted and force-pushed it")
	}
	res = h.step()
	if prs[1].State != "MERGED" {
		t.Fatalf("the next step should merge from fresh state: %+v", res)
	}
	if !gitOK(foo.Dir, "merge-base", "--is-ancestor", "origin/main", "origin/s2-branch") {
		t.Fatal("s2 was not rebased")
	}
}

func TestMergeRepoFilterKeepsTheCrossRepoBarrier(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Change: "f1ch", DependsOn: &[]string{}},
		Entry{ID: "b1", Repo: bar.Dir, Change: "b1ch", DependsOn: &[]string{"f1"}},
	)
	fp := h.shipped(1, "f1")
	bp := h.shipped(2, "b1")

	// Start only the downstream repo first.
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: bar.Dir}); err != nil {
		t.Fatal(err)
	}
	if bp[0].Armed || bp[0].MergeCalls != 0 {
		t.Fatal("bar's PR was armed or merged before foo's PR merged: the barrier was lost")
	}
	if fp[0].Armed {
		t.Fatal("foo was never started and must not be armed")
	}
	if deps := h.item("pr-2").DependsOn; len(deps) != 1 || deps[0] != "pr-1" {
		t.Fatalf("pr-2 depends_on = %v, want the barrier on pr-1", deps)
	}
	h.step()
	if bp[0].Armed || fp[0].Armed {
		t.Fatal("a step advanced a sequence that was not started")
	}

	// Starting foo releases it; once foo's PR merges, bar's is armed.
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: foo.Dir}); err != nil {
		t.Fatal(err)
	}
	if !fp[0].Armed || bp[0].Armed {
		t.Fatalf("armed foo=%v bar=%v", fp[0].Armed, bp[0].Armed)
	}
	fp[0].State = "MERGED"
	h.step()
	if !bp[0].Armed {
		t.Fatal("bar's PR was not armed after foo's merged")
	}
}

func TestMergeRepoFilterRefusesWhileTheBarrierRepoIsNotDone(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Change: "f1ch", DependsOn: &[]string{}},
		Entry{ID: "b1", Repo: bar.Dir, Change: "b1ch", DependsOn: &[]string{"f1"}},
	)
	h.shipped(2, "b1")
	_, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: bar.Dir})
	if err == nil || !strings.Contains(err.Error(), "not done yet: f1") {
		t.Fatalf("err = %v", err)
	}
}

func TestStatusReadsANullModeAsCherryPickLadder(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.shipped(1, "a", "b")
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		for i := range st.Tracked {
			st.Tracked[i].Scope["merge_mode"] = nil
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	res, err := Status(context.Background(), h.env)
	if err != nil || len(res.Items) != 2 {
		t.Fatalf("status = %+v err %v: null-mode queue items must be listed", res, err)
	}
	for _, it := range res.Items {
		if it.Mode != "cherry-pick-ladder" {
			t.Errorf("%s mode = %q", it.ID, it.Mode)
		}
	}
	if !res.Complete || !strings.HasPrefix(res.Summary, "Queue complete. 2 PRs") {
		t.Fatalf("summary = %q", res.Summary)
	}
}

func TestStatusExcludesAnUnmarkedSingleLegacyPane(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	// A queue from before items were stamped: one spawned item, null mode, no
	// dependencies and no dependents.
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		it, _ := operator.NewPaneItem("solo", nil, map[string]interface{}{"repo": foo.Dir, "pane": "%5", "branch": "solo-branch", "change": "260101-ab12-x"})
		st.Tracked = append(st.Tracked, it)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	res, err := Status(context.Background(), h.env)
	if err != nil || len(res.Items) != 0 {
		t.Fatalf("isolated unmarked pane treated as queue work: %+v, %v", res, err)
	}
}

func TestQueueItemsCarryAnExplicitQueueMarker(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	qa, qb := operator.ScopeString(h.item("a").Scope, scopeQueue), operator.ScopeString(h.item("b").Scope, scopeQueue)
	if qa == "" || qa != qb || !strings.HasPrefix(qa, "a-") {
		t.Fatalf("queue markers = %q, %q", qa, qb)
	}
	res, _ := Status(context.Background(), h.env)
	if len(res.Items) != 2 || res.Items[0].Queue != qa {
		t.Fatalf("status = %+v", res.Items)
	}
}

func TestStackedReadiesADraftBeforeMerging(t *testing.T) {
	h, _, prs := stackFixture(t, "s2.txt", "s2\n")
	prs[0].IsDraft = true
	prs[1].IsDraft = true
	prs[1].Checks = []checkRun{{Name: "ci", State: "PENDING"}}
	h.startMerge()
	if prs[0].State != "MERGED" || prs[0].IsDraft {
		t.Fatalf("PR1 state %s draft %v: a draft cannot be squash-merged", prs[0].State, prs[0].IsDraft)
	}
	if h.run.called("gh pr ready 1") != 1 {
		t.Fatalf("gh pr ready calls = %d", h.run.called("gh pr ready 1"))
	}
	prs[1].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if prs[1].State != "MERGED" || prs[1].IsDraft {
		t.Fatalf("PR2 state %s draft %v", prs[1].State, prs[1].IsDraft)
	}
}

func TestStallSurvivesTheItemBeingRemovedByAnExternalWriter(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.shipped(1, "a")
	h.startMerge()
	h.run.onRun = func(argv []string) {
		if len(argv) > 3 && argv[1] == "pr" && argv[2] == "checks" {
			_ = operator.Remove(h.env.StatePath, "pr-1")
		}
	}
	h.step() // must not panic indexing the removed item
	if h.has("pr-1") {
		t.Fatal("fixture: the external removal did not happen")
	}
}

func TestPRItemIDsStayUniqueAcrossReposSharingABasename(t *testing.T) {
	h := newHarness(t)
	a := newRepo(t, "app")
	b := newRepo(t, "app")
	c := newRepo(t, "app")
	none := &[]string{}
	h.queue("",
		Entry{ID: "x1", Repo: a.Dir, Task: "x", DependsOn: none},
		Entry{ID: "y1", Repo: b.Dir, Task: "y", DependsOn: none},
		Entry{ID: "z1", Repo: c.Dir, Task: "z", DependsOn: none},
	)
	for _, id := range []string{"x1", "y1", "z1"} {
		h.setDone(id)
		h.attachBranch(id, id+"-branch")
	}
	// The same PR number in three repos with the same directory name.
	h.run.on("gh pr view", func(dir string, argv []string) (string, error) {
		return `{"number":7,"url":"https://example.test/pull/7","state":"OPEN","mergeable":"MERGEABLE"}`, nil
	})
	h.run.reply("gh pr merge", "")
	h.run.reply("gh pr checks", "[]")
	h.startMerge()
	seen := map[string]bool{}
	for _, it := range h.state().Tracked {
		if it.Kind == operator.KindGitHubPR {
			if seen[it.ID] {
				t.Fatalf("duplicate PR item id %s", it.ID)
			}
			seen[it.ID] = true
		}
	}
	if len(seen) != 3 {
		t.Fatalf("PR items = %v, want one per repo", seen)
	}
}

func TestMergeRepoFailsLoudlyWhenTheBarrierRepoCannotBeStarted(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("a read-only directory does not stop root")
	}
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Change: "f1ch", DependsOn: &[]string{}},
		Entry{ID: "b1", Repo: bar.Dir, Change: "b1ch", DependsOn: &[]string{"f1"}},
	)
	h.shipped(1, "f1")
	h.shipped(2, "b1")
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: bar.Dir}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(h.env.StatePath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: foo.Dir}); err == nil {
		t.Fatal("a failed write while starting the registered sequence was swallowed")
	}
}

// armFixture is one queued PR whose sequence exists but is not armed: a
// barrier repo is started first, leaving the first PR registered and deferred.
func armFixture(t *testing.T) (*harness, *simPR, operator.TrackedItem) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Change: "f1ch", DependsOn: &[]string{}},
		Entry{ID: "b1", Repo: bar.Dir, Change: "b1ch", DependsOn: &[]string{"f1"}},
	)
	fp := h.shipped(1, "f1")
	h.shipped(2, "b1")
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: bar.Dir}); err != nil {
		t.Fatal(err)
	}
	if fp[0].Armed {
		t.Fatal("fixture: foo must not be armed yet")
	}
	return h, fp[0], h.item("pr-1")
}

func armOnce(t *testing.T, h *harness, head operator.TrackedItem) *StepResult {
	e := newEngine(h.env)
	e.arm(context.Background(), h.state(), head, prView{State: "OPEN", Mergeable: "MERGEABLE"})
	return e.res
}

func readOnlyState(t *testing.T, h *harness) {
	if os.Geteuid() == 0 {
		t.Skip("a read-only directory does not stop root")
	}
	dir := filepath.Dir(h.env.StatePath)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
}

func TestArmMarkerIsDurableBeforeGitHubIsAsked(t *testing.T) {
	h, pr, head := armFixture(t)
	var atArm operator.TrackedItem
	h.run.on("gh pr merge --auto", func(_ string, argv []string) (string, error) {
		atArm = h.item("pr-1")
		pr.Armed = true
		return "", nil
	})
	armOnce(t, h, head)
	if !scopeBool(atArm, scopeArmed) {
		t.Fatal("the armed marker was not durable when gh pr merge --auto ran")
	}
	if !pr.Armed || !scopeBool(h.item("pr-1"), scopeArmed) {
		t.Fatal("armed PR without its marker")
	}
}

func TestArmNeverArmsWhenTheMarkerCannotBeWritten(t *testing.T) {
	h, pr, head := armFixture(t)
	readOnlyState(t, h)
	res := armOnce(t, h, head)
	if pr.Armed || h.run.called("gh pr merge --auto") != 0 {
		t.Fatal("GitHub was asked to arm a PR whose marker could not be persisted")
	}
	if hasAction(res, ActArmed, "") || !hasEscalation(res, "was not armed") {
		t.Fatalf("a failed marker write must not report success: %+v", res)
	}
}

func TestArmClearsTheMarkerWhenGitHubRefuses(t *testing.T) {
	h, pr, head := armFixture(t)
	pr.AutoErr = "GraphQL: Pull request is not in the correct state to enable auto-merge"
	res := armOnce(t, h, head)
	if scopeBool(h.item("pr-1"), scopeArmed) || pr.Armed {
		t.Fatal("a refused arm left the marker set")
	}
	if hasAction(res, ActArmed, "") || !hasEscalation(res, "arming PR #1 failed") {
		t.Fatalf("result = %+v", res)
	}
}

func TestArmUncertainOutcomeKeepsTheMarkerSoStopDisarms(t *testing.T) {
	h, pr, head := armFixture(t)
	if os.Geteuid() == 0 {
		t.Skip("a read-only directory does not stop root")
	}
	dir := filepath.Dir(h.env.StatePath)
	// gh arms the PR but reports a failure, and the state becomes unwritable
	// before the marker can be cleared.
	h.run.on("gh pr merge --auto", func(_ string, argv []string) (string, error) {
		pr.Armed = true
		_ = os.Chmod(dir, 0o500)
		return "", ghErr(argv, "gh: HTTP 502")
	})
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	res := armOnce(t, h, head)
	if !hasEscalation(res, "arm outcome uncertain") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	_ = os.Chmod(dir, 0o700)
	if !scopeBool(h.item("pr-1"), scopeArmed) {
		t.Fatal("the marker must stay set when gh's outcome is uncertain")
	}
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if pr.Armed || pr.Disarms != 1 {
		t.Fatalf("stop did not disarm the PR with the uncertain arm: armed=%v disarms=%d", pr.Armed, pr.Disarms)
	}
}

func TestArmUncertainErrorsRetainMarkerAndStopDisarms(t *testing.T) {
	for _, msg := range []string{"context deadline exceeded", "gh: HTTP 502", "connection reset by peer", "GraphQL: something unexpected"} {
		t.Run(msg, func(t *testing.T) {
			h, pr, head := armFixture(t)
			h.run.on("gh pr merge --auto", func(_ string, argv []string) (string, error) {
				pr.Armed = true
				return "", ghErr(argv, msg)
			})
			res := armOnce(t, h, head)
			if !scopeBool(h.item("pr-1"), scopeArmed) || !hasEscalation(res, "arm outcome uncertain") || hasAction(res, ActArmed, "") {
				t.Fatalf("result = %+v", res)
			}
			if _, err := Stop(context.Background(), h.env); err != nil {
				t.Fatal(err)
			}
			if pr.Armed || pr.Disarms != 1 {
				t.Fatal("stop missed uncertain arm")
			}
		})
	}
}

func TestDefinitiveArmRejectionList(t *testing.T) {
	for _, msg := range []string{"auto merge is not allowed", "auto-merge is not allowed", "pull request is in clean status", "pull request is not in the correct state to enable auto-merge"} {
		if !definitiveArmRejection("graphql: " + msg + " (enablepullrequestautomerge)") {
			t.Errorf("not classified: %s", msg)
		}
	}
	for _, msg := range []string{"http 500", "not mergeable", "unknown", "request timed out"} {
		if definitiveArmRejection(msg) {
			t.Errorf("uncertain error classified definitive: %s", msg)
		}
	}
}

func TestPRCreationRefusesUnresolvedRepository(t *testing.T) {
	for _, mode := range []string{operator.MergeModeCherryPickLadder, operator.MergeModeMergeAuto} {
		for _, response := range []string{"lookup failure", "invalid json", `{}`, `{"nameWithOwner":"not-qualified"}`} {
			t.Run(mode+"/"+response, func(t *testing.T) {
				h := newHarness(t)
				repo := newRepo(t, "repo")
				h.queue(mode, Entry{ID: "a", Repo: repo.Dir, Change: "aaaa"})
				h.shipped(1, "a")
				if response == "lookup failure" {
					h.run.fail("gh repo view --json nameWithOwner", "network error")
				} else {
					h.run.reply("gh repo view --json nameWithOwner", response)
				}
				var res *StepResult
				if mode == operator.MergeModeMergeAuto {
					res = h.step()
				} else {
					res, _ = StartMerge(context.Background(), h.env, MergeOptions{})
				}
				if h.has("pr-1") || !hasEscalation(res, "owner/name") || hasAction(res, ActPRTracked, "") {
					t.Fatalf("result = %+v", res)
				}
			})
		}
	}
}
