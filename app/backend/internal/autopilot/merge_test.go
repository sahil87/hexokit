package autopilot

import (
	"context"
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
	pending(prs...)

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
	if prs[1].Armed {
		t.Fatal("the successor was armed in the pass that recorded its predecessor's merge")
	}
	if !operator.ItemDone(h.item("pr-1")) {
		t.Fatal("pr-1 not done after a verified merge")
	}
	wantLine := "a: merged (foo 1/2) · unreviewed"
	if len(res.Report) != 2 || res.Report[0] != wantLine || res.Report[1] != "merged without review: #1 (a)" {
		t.Fatalf("report = %q", res.Report)
	}
	h.step()
	if !prs[1].Armed {
		t.Fatal("the next PR was not armed on the pass after the merge was recorded")
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
	pending(prs...)
	prs[0].IsDraft = true
	res := h.startMerge()
	if prs[0].IsDraft || prs[0].Armed || !hasAction(res, ActReadied, "pr-1") {
		t.Fatalf("draft=%v armed=%v: a draft is readied by its own pass, armed by the next", prs[0].IsDraft, prs[0].Armed)
	}
	h.step()
	if !prs[0].Armed {
		t.Fatal("the readied PR was not armed on the next pass")
	}
}

func TestLadderGreenPRMergesDirectlyWithoutArming(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")
	res := h.startMerge()
	if prs[0].MergeCalls != 1 || prs[0].State != "MERGED" || h.run.called("gh pr merge --auto") != 0 {
		t.Fatalf("PR1 merges = %d state %s: a green PR has nothing for auto-merge to wait on", prs[0].MergeCalls, prs[0].State)
	}
	if !hasAction(res, ActMerged, "a") || prs[1].MergeCalls != 0 || prs[1].Armed {
		t.Fatalf("the successor acted in the pass of its predecessor's merge: %+v", res)
	}
	res = h.step()
	if len(res.Report) == 0 || !strings.HasPrefix(res.Report[0], "a: merged (foo 1/2)") || prs[1].MergeCalls != 0 {
		t.Fatalf("report = %q, PR2 merges = %d", res.Report, prs[1].MergeCalls)
	}
	h.step()
	if prs[1].State != "MERGED" {
		t.Fatal("the sequence did not move on after the merge was recorded")
	}
}

func TestLadderRepoWithoutAutoMergeMergesOnGreen(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	pending(prs...)
	h.gh.noAutoMerge["o/foo"] = true
	res := h.startMerge()
	if prs[0].State == "MERGED" || prs[0].Armed || h.run.called("gh pr merge") != 0 {
		t.Fatal("merged with pending checks, or armed on a repo that forbids it")
	}
	if hasEscalation(res, "auto-merge is disabled") {
		t.Fatalf("a repo without auto-merge is a fact, not an escalation: %+v", res.Escalations)
	}
	prs[0].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if prs[0].State != "MERGED" || h.run.called("gh pr merge --auto") != 0 {
		t.Fatal("the green PR was not merged directly")
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
	pending(fp[0], bp[0], zp[0])
	h.startMerge()
	if !fp[0].Armed || bp[0].Armed || !zp[0].Armed {
		t.Fatalf("armed foo=%v bar=%v baz=%v: bar waits behind foo across repos", fp[0].Armed, bp[0].Armed, zp[0].Armed)
	}
	fp[0].State = "CLOSED"
	h.step()

	if fp[0].Disarms != 1 || zp[0].Disarms != 0 || !zp[0].Armed {
		t.Fatalf("disarms foo=%d baz=%d bazArmed=%v: only the halted cone is disarmed", fp[0].Disarms, zp[0].Disarms, zp[0].Armed)
	}
	if !scopeBool(h.item("pr-1"), scopeHalted) || scopeBool(h.item("pr-2"), scopeHalted) || scopeBool(h.item("pr-3"), scopeHalted) {
		t.Fatal("a halt writes halted on the failing item only")
	}
	if h.prStatusOf("pr-2") != PRHalted || h.prStatusOf("pr-3") == PRHalted {
		t.Fatalf("bar's sequence is in foo's cone (%s); baz's is independent (%s)", h.prStatusOf("pr-2"), h.prStatusOf("pr-3"))
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
	pending(fp[0], bp[0], h.gh.add(9, "later-branch"))
	h.startMerge()
	if !fp[0].Armed || !bp[0].Armed {
		t.Fatal("fixture: both repos' first PRs should be armed")
	}
	// A pending item in the engine file that has not spawned yet.
	h.queue("", Entry{ID: "queued", Repo: foo.Dir, Task: "q"})

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
	pending(pr)

	res := h.step()
	if !hasAction(res, ActPRTracked, "a") || pr.Armed {
		t.Fatalf("a shipped merge-auto item gets its PR tracked first and armed on the next pass: %+v", res.Actions)
	}
	res = h.step()
	if !pr.Armed || !hasAction(res, ActArmed, "pr-1") {
		t.Fatalf("the tracked PR was not armed: %+v", res.Actions)
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
	if len(h.spawn.reqs) != 0 {
		t.Fatal("b spawned in the pass that recorded a's merge")
	}
	if len(res.Report) == 0 || !strings.HasPrefix(res.Report[0], "a: merged (foo 1/1)") {
		t.Fatalf("report = %q", res.Report)
	}
	h.step()
	if len(h.spawn.reqs) != 1 || h.spawn.reqs[0].WorktreeName != "b" {
		t.Fatalf("spawn requests = %+v", h.spawn.reqs)
	}
	if got := h.spawn.reqs[0].BaseSHA; got != tip {
		t.Fatalf("b based on %s, want the advanced origin tip %s", got, tip)
	}
}

func TestMergeAutoHaltDisarmsOnePRAndKeepsTheNextDeferred(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	pr := h.gh.add(1, "a-branch")
	pending(pr)
	h.step()
	h.step()
	if !pr.Armed {
		t.Fatal("fixture: the merge-auto PR should be armed")
	}
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
	if res.Items[0].State != QueuePending || res.Items[1].State != QueueHeld || res.Items[0].Mode != "cherry-pick-ladder" {
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
	pending(fp[0], bp[0])

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
	if bp[0].Armed {
		t.Fatal("bar's PR was armed in the pass that recorded foo's merge")
	}
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
	pending(h.shipped(1, "a")...)
	h.startMerge()
	h.run.onRun = func(argv []string) {
		if len(argv) > 3 && argv[1] == "pr" && argv[2] == "checks" {
			_ = operator.Remove(h.env.StatePath, "pr-1")
		}
	}
	h.step() // the engine keeps its own item after the projection is removed
	ledger, loadErr := operator.Load(h.env.StatePath)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if operator.IndexOf(ledger.Tracked, "pr-1") >= 0 || !h.has("pr-1") {
		t.Fatal("projection removal did not leave the engine item intact")
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

// armableFixture is armFixture with foo's sequence started but its PR still
// unarmed: its checks are pending, so the head is `waiting` and the next pass
// decides row P6.
func armableFixture(t *testing.T) (*harness, *simPR, operator.TrackedItem) {
	h, pr, _ := armFixture(t)
	pending(pr)
	e := newEngine(h.env)
	if err := e.setScope("pr-1", map[string]interface{}{scopeDeferred: false}); err != nil {
		t.Fatal(err)
	}
	return h, pr, h.item("pr-1")
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

// execOne runs a single decision through the executors.
func execOne(t *testing.T, e *engine, d Decision) {
	t.Helper()
	if err := e.execute(context.Background(), e.facts, []Decision{d}); err != nil {
		t.Logf("execute: %v", err)
	}
}

func TestArmExecutorArmsThePinnedPRAndWritesNoMarker(t *testing.T) {
	h, pr, head := armableFixture(t)
	e, d := h.decideFor(head.ID)
	if d.Row != "P6" || d.Action != ActionArm {
		t.Fatalf("decision = %+v", d)
	}
	execOne(t, e, d)
	if !pr.Armed || !hasAction(e.res, ActArmed, head.ID) {
		t.Fatalf("armed=%v res=%+v", pr.Armed, e.res)
	}
	for _, k := range []string{"armed", "direct", "stall_seen"} {
		if _, ok := h.item(head.ID).Scope[k]; ok {
			t.Errorf("the engine wrote scope.%s", k)
		}
	}
}

func TestArmRefusedByGitHubEscalatesAndIsRetriedFromObservation(t *testing.T) {
	h, pr, head := armableFixture(t)
	pr.AutoErr = "GraphQL: Pull request is not in the correct state to enable auto-merge"
	e, d := h.decideFor(head.ID)
	execOne(t, e, d)
	if pr.Armed || hasAction(e.res, ActArmed, "") || !hasEscalation(e.res, "arming PR #1 failed") {
		t.Fatalf("result = %+v", e.res)
	}
	pr.AutoErr = ""
	res := h.step()
	if !pr.Armed || !hasAction(res, ActArmed, head.ID) {
		t.Fatalf("the next pass did not arm: %+v", res)
	}
}

// An arm whose outcome is unknown (gh errored after arming) needs no marker:
// the next pass reads autoMergeRequest, and stop disarms what it finds.
func TestUncertainArmOutcomeIsReobservedAndStopDisarmsIt(t *testing.T) {
	for _, msg := range []string{"context deadline exceeded", "gh: HTTP 502", "connection reset by peer", "GraphQL: something unexpected"} {
		t.Run(msg, func(t *testing.T) {
			h, pr, head := armableFixture(t)
			h.run.on("gh pr merge --auto", func(_ string, argv []string) (string, error) {
				pr.Armed = true
				return "", ghErr(argv, msg)
			})
			e, d := h.decideFor(head.ID)
			execOne(t, e, d)
			if !hasEscalation(e.res, "arming PR #1 failed") || hasAction(e.res, ActArmed, "") {
				t.Fatalf("result = %+v", e.res)
			}
			if res := h.step(); hasAction(res, ActArmed, "") || h.run.called("gh pr merge --auto") != 1 {
				t.Fatalf("an armed PR was armed again: %+v", res)
			}
			if _, err := Stop(context.Background(), h.env); err != nil {
				t.Fatal(err)
			}
			if pr.Armed || pr.Disarms != 1 {
				t.Fatal("stop missed the uncertain arm")
			}
		})
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

func TestStartMergeAcceptsAStackedQueueAndCreatesChains(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("stacked-prs", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.shipped(1, "a", "b")
	_, err := StartMerge(context.Background(), h.env, MergeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	engine, loadErr := loadEngineFile(h.env.StatePath)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(engine.PRs) != 2 || engine.PRs[0].MergeMode != "stacked-prs" || engine.PRs[1].DependsOn[0] != engine.PRs[0].ID {
		t.Fatalf("stacked engine items = %#v", engine.PRs)
	}
	if h.run.called("gh pr merge --squash 1 --repo o/foo") != 1 || h.run.called("gh pr merge --auto") != 0 || h.run.called("gh pr ready") != 0 {
		t.Fatalf("the first stacked head did not merge directly: %q", h.run.calls)
	}
}

func TestStepMergesButNeverArmsAStackedPRItem(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	h.run.reset()
	it, err := operator.NewGitHubPRItem("pr-1", nil, map[string]interface{}{
		"repo": foo.Dir, "pr": 1, "branch": "a-branch", scopeMergeSeq: "seq", scopeItem: "a", "merge_mode": "stacked-prs",
	}, "o/foo")
	if err != nil {
		t.Fatal(err)
	}
	if err := newEngine(h.env).addPRItems([]operator.TrackedItem{it}, nil); err != nil {
		t.Fatal(err)
	}
	res := h.step()
	if prs[0].Armed || prs[0].MergeCalls != 1 || h.run.called("gh pr merge --auto") != 0 || h.run.called("gh pr ready") != 0 {
		t.Fatalf("a stacked green PR was not merged directly: %+v", res)
	}
	if row := h.decisionRows()["pr-1"]; row != "P1" {
		t.Fatalf("the freshly merged stacked PR matched row %q, want P1", row)
	}
}

func TestLadderFailedRequiredCheckRequestsOneFixAndHaltsOnNewRedHead(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	pending(prs...)
	h.startMerge()
	h.panes.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "260101-ab12-x"}
	prs[0].Checks = []checkRun{{Name: "test (2/4)", State: "FAILURE", Link: "https://ci/run/9"}}
	h.run.reset()

	res := h.step()
	if !hasAction(res, ActRecoverySent, "pr-1") || len(h.panes.sent) != 1 {
		t.Fatalf("fix request = %+v, sent = %q", res, h.panes.sent)
	}
	want := "%7|CI failed on PR #1 (o/foo): check `test (2/4)` — run https://ci/run/9, shard 2/4.\nDiagnose and fix on this branch, push, and report the root cause in one line."
	if h.panes.sent[0] != want {
		t.Fatalf("sent %q\nwant %q", h.panes.sent[0], want)
	}
	if !prs[0].Armed || prs[0].Disarms != 0 || scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatalf("the fix round must leave the PR armed and unhalted: armed=%v disarms=%d", prs[0].Armed, prs[0].Disarms)
	}
	for _, mutation := range []string{"gh pr merge", "gh pr ready", "gh pr edit", "git push", "git rebase"} {
		if h.run.called(mutation) != 0 {
			t.Fatalf("a fix request took another action: %s in %q", mutation, h.run.calls)
		}
	}
	if len(h.spawn.reqs) != 0 {
		t.Fatalf("an authoring pane exists but recovery spawned: %+v", h.spawn.reqs)
	}

	h.step()
	if len(h.panes.sent) != 1 {
		t.Fatal("the same head sent another fix request")
	}
	prs[0].HeadOid = "ffff0000ffff0000ffff0000ffff0000ffff0000"
	res = h.step()
	if !hasEscalation(res, "halted: CI still failing") || prs[0].Disarms != 1 || !scopeBool(h.item("pr-1"), scopeHalted) {
		t.Fatalf("a new red head did not halt and disarm: %+v", res)
	}
	if _, ok := h.item("pr-1").Scope["stall_seen"]; ok {
		t.Fatal("the engine wrote scope.stall_seen")
	}
}

func TestLadderConflictingStallRebasesOnceThenHaltsOnRecurrence(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	foo.branch("a-branch", "main", "a.txt", "a\n")
	foo.pushBranch("a-branch")
	foo.advanceOrigin("other.txt", "o\n")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "ab12"})
	prs := h.shipped(1, "a")
	prs[0].HeadOid = runGit(t, foo.Dir, "rev-parse", "origin/a-branch")
	pending(prs...)
	h.startMerge()
	prs[0].Mergeable = "CONFLICTING"
	h.run.reset()

	for i := 0; i < 3; i++ {
		if res := h.step(); hasAction(res, ActRebased, "pr-1") {
			t.Fatalf("rebased after only %d quiet polls: the stall rule needs 3", i)
		}
	}
	res := h.step()
	if !hasAction(res, ActRebased, "pr-1") || !roundSpent(h.item("pr-1"), recoveryRebase) {
		t.Fatalf("rebase recovery = %+v", res)
	}
	if !prs[0].Armed || prs[0].Disarms != 0 || h.run.called("git push") != 1 || h.run.called("gh pr merge") != 0 {
		t.Fatalf("rebase must push once without arming or disarming in the same pass: %q", h.run.calls)
	}
	res = h.step()
	if !hasEscalation(res, "CONFLICTING again") || prs[0].Disarms != 1 {
		t.Fatalf("recurring conflict did not halt: %+v", res)
	}
}

func TestHaltedArmedPRIsDisarmedAgainOnTheNextStepUntilDurable(t *testing.T) {
	h, pr, head := armFixture(t)
	pr.Armed = true
	h.run.fail("gh pr merge --disable-auto", "HTTP 502")
	if _, err := Stop(context.Background(), h.env); err == nil {
		t.Fatal("a failed disarm must fail the stop")
	}
	if !scopeBool(h.item(head.ID), scopeHalted) || !pr.Armed {
		t.Fatalf("a failed disarm must leave the PR halted and still armed: %+v", h.item(head.ID).Scope)
	}

	res := h.step()
	if !hasEscalation(res, "disarming PR #1 failed") {
		t.Fatalf("each failed retry must escalate: %+v", res)
	}
	if h.run.called("gh pr merge --disable-auto") != 2 {
		t.Fatalf("the step did not retry the disarm: %q", h.run.calls)
	}

	h.run.on("gh pr merge --disable-auto", h.gh.handle)
	res = h.step()
	if pr.Armed || !hasAction(res, ActDisarmed, head.ID) {
		t.Fatalf("a successful retry must disarm: armed=%v %+v", pr.Armed, res)
	}
	if h.step(); h.run.called("gh pr merge --disable-auto") != 3 {
		t.Fatalf("a disarmed PR was disarmed again: %q", h.run.calls)
	}
	if h.run.called("gh pr merge --auto") != 0 {
		t.Fatal("a halted head was armed")
	}
}

func TestStopRetriesAFailedDisarm(t *testing.T) {
	h, pr, head := armFixture(t)
	pr.Armed = true
	h.run.fail("gh pr merge --disable-auto", "connection reset by peer")
	if _, err := Stop(context.Background(), h.env); err == nil {
		t.Fatal("a failed disarm must fail the stop")
	}
	h.run.on("gh pr merge --disable-auto", h.gh.handle)
	res, err := Stop(context.Background(), h.env)
	if err != nil || pr.Armed || !hasAction(res, ActDisarmed, head.ID) {
		t.Fatalf("stop did not converge: armed=%v err=%v %+v", pr.Armed, err, res)
	}
}

func TestDisarmOfAMergedOrClosedPRCountsAsDone(t *testing.T) {
	for _, state := range []string{"MERGED", "CLOSED"} {
		t.Run(state, func(t *testing.T) {
			h, pr, head := armFixture(t)
			pr.Armed = true
			h.run.fail("gh pr merge --disable-auto", "GraphQL: pull request is not open")
			pr.State = state
			e := newEngine(h.env)
			if err := e.disarm(context.Background(), h.item(head.ID)); err != nil {
				t.Fatalf("disarm = %v", err)
			}
			if !hasAction(e.res, ActDisarmed, head.ID) || hasEscalation(e.res, "disarming") || e.disarmErr != nil {
				t.Fatalf("a finished PR is disarmed: %+v", e.res)
			}
		})
	}
}

// A github-pr item is pinned to the owner/name its probe was created with.
// scope.repo is only a mutable checkout path, so no gh call may follow it.
func TestGitHubPRCallsTargetThePinnedRepoNotTheCheckoutInScope(t *testing.T) {
	for _, scenario := range []string{"stall-then-stop", "verified-merge"} {
		t.Run(scenario, func(t *testing.T) {
			h := newHarness(t)
			foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
			h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
			prs := h.shipped(1, "a")
			pending(prs...)
			h.startMerge()
			if !prs[0].Armed {
				t.Fatal("fixture: PR 1 should be armed")
			}
			if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
				st.Tracked[operator.IndexOf(st.Tracked, "pr-1")].Scope["repo"] = bar.Dir
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			h.run.reset()
			if scenario == "stall-then-stop" {
				prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
				h.step() // view, checks
				if _, err := Stop(context.Background(), h.env); err != nil {
					t.Fatal(err) // view, checks not needed, disarm
				}
				if prs[0].Disarms != 1 {
					t.Fatalf("disarms = %d", prs[0].Disarms)
				}
			} else {
				prs[0].State = "MERGED"
				h.step() // view, reviews
				if !operator.ItemDone(h.item("pr-1")) {
					t.Fatal("merge not verified")
				}
			}
			seen := 0
			for _, c := range h.run.calls {
				if !strings.HasPrefix(c, "gh pr ") {
					continue
				}
				seen++
				if !strings.Contains(c, "--repo o/foo") || strings.Contains(c, "o/bar") {
					t.Fatalf("gh call not pinned to o/foo: %q", c)
				}
			}
			if seen < 2 {
				t.Fatalf("too few pr calls: %q", h.run.calls)
			}
		})
	}
}

func TestReadyArmAndMergeAreAllPinned(t *testing.T) {
	for _, scenario := range []string{"arm", "merge"} {
		t.Run(scenario, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
			prs := h.shipped(1, "a")
			prs[0].IsDraft = true
			if scenario == "arm" {
				pending(prs...)
			}
			if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: foo.Dir}); err != nil {
				t.Fatal(err)
			}
			h.step()
			for _, c := range h.run.calls {
				if (strings.HasPrefix(c, "gh pr ready") || strings.HasPrefix(c, "gh pr merge")) && !strings.Contains(c, "--repo o/foo") {
					t.Fatalf("mutation not pinned: %q", c)
				}
			}
			want := "gh pr merge --squash 1 --repo o/foo"
			if scenario == "arm" {
				want = "gh pr merge --auto --squash 1 --repo o/foo"
			}
			if h.run.called("gh pr ready 1 --repo o/foo") != 1 || h.run.called(want) != 1 {
				t.Fatalf("calls = %q", h.run.calls)
			}
		})
	}
}

func TestAPRItemWithoutAPinnedRepoIsNeverActedOn(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	pending(prs...)
	h.startMerge()
	e := newEngine(h.env)
	if err := e.patch("pr-1", func(it *operator.TrackedItem) {
		it.Probe.Argv = []string{"gh", "pr", "view", "1"}
	}); err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	res := h.step()
	if !hasEscalation(res, "no valid pinned owner/name") {
		t.Fatalf("escalations = %+v", res.Escalations)
	}
	if _, err := Stop(context.Background(), h.env); err == nil {
		t.Fatal("stop must fail rather than claim to have disarmed a PR it cannot place")
	}
	if h.run.called("gh pr") != 0 || prs[0].Disarms != 0 {
		t.Fatalf("an unpinned PR item reached gh: %q", h.run.calls)
	}
}

// A hand-edited state file (track update refuses these fields) can re-point a
// github-pr item between a pass's observation and its action. Every identity
// change must stop the executor before it reaches gh.
var prIdentityChanges = map[string]func(it *operator.TrackedItem, other string){
	"scope.pr":   func(it *operator.TrackedItem, _ string) { it.Scope["pr"] = 2 },
	"scope.repo": func(it *operator.TrackedItem, other string) { it.Scope["repo"] = other },
	"pinned owner/name": func(it *operator.TrackedItem, _ string) {
		for i, a := range it.Probe.Argv {
			if a == "--repo" {
				it.Probe.Argv[i+1] = "o/elsewhere"
			}
		}
	},
}

func changePRItem(t *testing.T, h *harness, id, other string, change func(*operator.TrackedItem, string)) {
	t.Helper()
	e := newEngine(h.env)
	if err := e.patch(id, func(it *operator.TrackedItem) {
		change(it, other)
	}); err != nil {
		t.Fatal(err)
	}
}

// A green PR is merged only at the head whose checks were read: a commit pushed
// between the read and the merge makes gh refuse it.
func TestMergeIsPinnedToTheObservedHead(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	h.startMerge()
	want := "gh pr merge --squash 1 --repo o/foo --match-head-commit " + prs[0].HeadOid
	if h.run.called(want) != 1 {
		t.Fatalf("merge not pinned to the observed head %s: %q", prs[0].HeadOid, h.run.calls)
	}
}

func TestExecutorsSkipAPRItemThatChangedAfterObservation(t *testing.T) {
	scenarios := map[string]func(h *harness, pr *simPR) (want ActionKind, gh string){
		"arm":    func(h *harness, pr *simPR) (ActionKind, string) { return ActionArm, "gh pr merge" },
		"ready":  func(h *harness, pr *simPR) (ActionKind, string) { pr.IsDraft = true; return ActionReady, "gh pr ready" },
		"merge":  func(h *harness, pr *simPR) (ActionKind, string) { pr.Checks = nil; return ActionMerge, "gh pr merge" },
		"disarm": func(h *harness, pr *simPR) (ActionKind, string) { pr.Armed = true; return ActionDisarm, "gh pr merge" },
	}
	for scenario, setup := range scenarios {
		for name, change := range prIdentityChanges {
			t.Run(scenario+"/"+name, func(t *testing.T) {
				h, pr, head := armableFixture(t)
				want, ghCall := setup(h, pr)
				if want == ActionDisarm {
					changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.Scope[scopeHalted] = true })
				}
				e, d := h.decideFor(head.ID)
				if d.Action != want {
					t.Fatalf("decision = %+v, want %s", d, want)
				}
				changePRItem(t, h, head.ID, t.TempDir(), change)
				h.run.reset()
				execOne(t, e, d)
				if h.run.called(ghCall) != 0 || len(e.res.Actions) != 0 {
					t.Fatalf("acted on a changed item: calls=%q actions=%+v", h.run.calls, e.res.Actions)
				}
				if !hasEscalation(e.res, "PR item pr-1 changed externally; skipped") {
					t.Fatalf("res = %+v", e.res)
				}
			})
		}
	}
}

func TestRecordMergedRefusesAChangedPRItem(t *testing.T) {
	h, pr, head := armFixture(t)
	changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.Scope[scopeDeferred] = false })
	pr.State = "MERGED"
	e, d := h.decideFor(head.ID)
	if d.Action != ActionRecordMerged {
		t.Fatalf("decision = %+v", d)
	}
	changePRItem(t, h, head.ID, "", prIdentityChanges["scope.pr"])
	execOne(t, e, d)
	if operator.ItemDone(h.item(head.ID)) || hasAction(e.res, ActMerged, "") || !hasEscalation(e.res, "changed externally; skipped") {
		t.Fatalf("res = %+v", e.res)
	}
}

func TestObservationOfAChangedPRItemWritesNothing(t *testing.T) {
	h, _, head := armFixture(t)
	changePRItem(t, h, head.ID, "", prIdentityChanges["scope.pr"])
	before := h.item(head.ID)
	e := newEngine(h.env)
	if err := e.observePRWrite(head, prView{State: "OPEN", Mergeable: "CONFLICTING"}); err == nil {
		t.Fatal("observation of another PR was written")
	}
	after := h.item(head.ID)
	if after.Unchanged != before.Unchanged || fmt.Sprint(after.Last) != fmt.Sprint(before.Last) || !hasEscalation(e.res, "changed externally; skipped") {
		t.Fatalf("before %+v after %+v res %+v", before, after, e.res)
	}
}

// Q7 finds the PR by branch with reads that take time. If its queue item is
// removed meanwhile, nothing is persisted: no orphan sequence a later pass
// could arm or merge.
func TestTrackPRWritesNothingWhenItsQueueItemChangedDuringTheReads(t *testing.T) {
	for _, scenario := range []string{"removed", "changed"} {
		t.Run(scenario, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
			h.setDone("a")
			h.attachBranch("a", "a-branch")
			pending(h.gh.add(1, "a-branch"))
			e, d := h.decideFor("a")
			if d.Action != ActionTrackPR {
				t.Fatalf("decision = %+v", d)
			}
			h.run.onRun = func(argv []string) {
				if len(argv) > 3 && argv[1] == "pr" && argv[2] == "view" && argv[3] == "a-branch" {
					h.run.onRun = nil
					if scenario == "removed" {
						_ = e.mutateEngine(func(st *engineState) error { st.remove("a"); return nil })
					} else {
						_ = e.patch("a", func(it *operator.TrackedItem) { it.Scope["task"] = "edited" })
					}
				}
			}
			execOne(t, e, d)
			if h.has("pr-1") || hasAction(e.res, ActPRTracked, "") || !hasEscalation(e.res, "item a changed externally; skipped") {
				t.Fatalf("an orphan PR item was persisted or the skip not reported: %+v", e.res)
			}
		})
	}
}

// An escalate-once row writes its note and dedupe key under the item's
// fingerprint: an item whose edges changed since observe gets neither.
func TestEscalateRowWritesNothingToAnItemThatChanged(t *testing.T) {
	h, pr, head := armableFixture(t)
	pr.Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	e, d := h.decideFor(head.ID)
	if d.Row != "C3" {
		t.Fatalf("decision = %+v", d)
	}
	d.Row, d.Action, d.Key, d.Reason = "test", ActionEscalate, "test", "test escalation"
	changePRItem(t, h, head.ID, "", func(it *operator.TrackedItem, _ string) { it.DependsOn = []string{"other"} })
	execOne(t, e, d)
	it := h.item(head.ID)
	seen, _ := it.Scope[scopeEscalated].(map[string]interface{})
	if len(seen) != 0 || len(it.Notes) != 0 {
		t.Fatalf("an escalation landed on a changed item: %+v notes=%v", it.Scope, it.Notes)
	}
	if hasEscalation(e.res, "test escalation") || !hasEscalation(e.res, "PR item pr-1 changed externally; skipped") {
		t.Fatalf("res = %+v", e.res)
	}
}
