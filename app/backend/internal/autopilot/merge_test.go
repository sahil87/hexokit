package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	fp[0].State = "CLOSED"
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
	e.arm(context.Background(), head, prView{State: "OPEN", Mergeable: "MERGEABLE"})
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

func TestStartMergeRefusesAStackedQueueAndWritesNothing(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("stacked-prs", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.shipped(1, "a", "b")
	before := h.state()
	_, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if !errors.Is(err, errStackedMerge) || !strings.Contains(err.Error(), "run brief") {
		t.Fatalf("err = %v", err)
	}
	if len(h.state().Tracked) != len(before.Tracked) || h.has("pr-1") {
		t.Fatal("a refused merge wrote PR items")
	}
	if h.run.called("gh pr merge") != 0 || h.run.called("gh pr ready") != 0 {
		t.Fatalf("a refused merge acted on GitHub: %q", h.run.calls)
	}
}

func TestStepDoesNotDriveAStackedPRItem(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	h.run.reset()
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		it, err := operator.NewGitHubPRItem("pr-1", nil, map[string]interface{}{
			"repo": foo.Dir, "pr": 1, "branch": "a-branch", scopeMergeSeq: "seq", scopeItem: "a", "merge_mode": "stacked-prs",
		}, "o/foo")
		st.Tracked = append(st.Tracked, it)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	if prs[0].Armed || prs[0].MergeCalls != 0 || h.run.called("gh pr merge") != 0 || !hasEscalation(res, "stacked-prs") {
		t.Fatalf("a stacked PR item was driven: %+v", res)
	}
}

func TestLadderFailedRequiredCheckEscalatesRecoveryNeededAndLeavesThePRArmed(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	prs[0].Checks = []checkRun{{Name: "test (2/4)", State: "FAILURE", Link: "https://ci/run/9"}}
	h.run.reset()

	res := h.step()
	if !hasEscalation(res, "recovery needed: ci-failed — PR #1 (foo)") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if !prs[0].Armed || prs[0].Disarms != 0 || scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatalf("a stall must leave the PR armed and unhalted: armed=%v disarms=%d", prs[0].Armed, prs[0].Disarms)
	}
	for _, mutation := range []string{"gh pr merge", "gh pr ready", "gh pr edit", "git push", "git rebase"} {
		if h.run.called(mutation) != 0 {
			t.Fatalf("a stall took action: %s in %q", mutation, h.run.calls)
		}
	}
	if len(h.spawn.reqs) != 0 {
		t.Fatalf("a stall spawned a recovery window: %+v", h.spawn.reqs)
	}

	if res := h.step(); hasEscalation(res, "recovery needed") {
		t.Fatalf("the same head and reason escalated twice: %+v", res.Escalations)
	}
	prs[0].HeadOid = "ffff0000ffff0000ffff0000ffff0000ffff0000"
	if res := h.step(); !hasEscalation(res, "recovery needed: ci-failed") {
		t.Fatalf("a new head failing again must escalate again: %+v", res.Escalations)
	}
}

func TestLadderConflictingStallEscalatesAfterQuietPollsAndLeavesThePRArmed(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	h.startMerge()
	prs[0].Mergeable = "CONFLICTING"
	h.run.reset()

	for i := 0; i < 3; i++ {
		if res := h.step(); hasEscalation(res, "recovery needed") {
			t.Fatalf("escalated after only %d quiet polls: the stall rule needs 3", i)
		}
	}
	res := h.step()
	if !hasEscalation(res, "recovery needed: conflicting — PR #1 (foo)") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if !prs[0].Armed || prs[0].Disarms != 0 || h.run.called("git push") != 0 || h.run.called("gh pr merge") != 0 {
		t.Fatalf("a conflicting stall took action: %q", h.run.calls)
	}
}

func TestHaltedArmedPRIsDisarmedAgainOnTheNextStepUntilDurable(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	h.run.fail("gh pr merge --disable-auto", "HTTP 502")
	if _, err := Stop(context.Background(), h.env); err == nil {
		t.Fatal("a failed disarm must fail the stop")
	}
	it := h.item(head.ID)
	if !scopeBool(it, scopeHalted) || !scopeBool(it, scopeArmed) || !pr.Armed {
		t.Fatalf("a failed disarm must leave the PR halted and still marked armed: %+v", it.Scope)
	}

	res := h.step()
	if !hasEscalation(res, "disarming PR #1 failed") || !scopeBool(h.item(head.ID), scopeArmed) {
		t.Fatalf("each failed retry must escalate and keep the marker: %+v", res)
	}
	if h.run.called("gh pr merge --disable-auto") != 2 {
		t.Fatalf("the step did not retry the disarm: %q", h.run.calls)
	}

	h.run.on("gh pr merge --disable-auto", h.gh.handle)
	res = h.step()
	if pr.Armed || scopeBool(h.item(head.ID), scopeArmed) || !hasAction(res, ActDisarmed, head.ID) {
		t.Fatalf("a successful retry must disarm and clear the marker: armed=%v %+v", pr.Armed, res)
	}
	if h.step(); h.run.called("gh pr merge --disable-auto") != 3 {
		t.Fatalf("a cleared marker was disarmed again: %q", h.run.calls)
	}
	if h.run.called("gh pr merge --auto") != 1 {
		t.Fatal("a halted head was armed again")
	}
}

func TestStopRetriesAFailedDisarm(t *testing.T) {
	h, pr, head := armFixture(t)
	armOnce(t, h, head)
	h.run.fail("gh pr merge --disable-auto", "connection reset by peer")
	if _, err := Stop(context.Background(), h.env); err == nil {
		t.Fatal("a failed disarm must fail the stop")
	}
	h.run.on("gh pr merge --disable-auto", h.gh.handle)
	res, err := Stop(context.Background(), h.env)
	if err != nil || pr.Armed || scopeBool(h.item(head.ID), scopeArmed) || !hasAction(res, ActDisarmed, head.ID) {
		t.Fatalf("stop did not converge: armed=%v err=%v %+v", pr.Armed, err, res)
	}
}

func TestDisarmOfAMergedOrClosedPRClearsTheMarker(t *testing.T) {
	for _, state := range []string{"MERGED", "CLOSED"} {
		t.Run(state, func(t *testing.T) {
			h, pr, head := armFixture(t)
			armOnce(t, h, head)
			h.run.fail("gh pr merge --disable-auto", "GraphQL: pull request is not open")
			pr.State = state
			e := newEngine(h.env)
			if err := e.disarm(context.Background(), h.item(head.ID)); err != nil {
				t.Fatalf("disarm = %v", err)
			}
			if scopeBool(h.item(head.ID), scopeArmed) {
				t.Fatal("a finished PR kept its armed marker")
			}
		})
	}
}
