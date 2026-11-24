package autopilot

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"rk/internal/operator"
)

func (h *harness) ledger() *operator.State {
	h.t.Helper()
	st, err := operator.Load(h.env.StatePath)
	if err != nil {
		h.t.Fatal(err)
	}
	return st
}

func (h *harness) ledgerItem(id string) (operator.TrackedItem, bool) {
	st := h.ledger()
	i := operator.IndexOf(st.Tracked, id)
	if i < 0 {
		return operator.TrackedItem{}, false
	}
	return st.Tracked[i], true
}

func (h *harness) marker(id string) string {
	h.t.Helper()
	es, err := loadEngineFile(h.env.StatePath)
	if err != nil {
		h.t.Fatal(err)
	}
	it, ok := es.find(id)
	if !ok {
		h.t.Fatalf("no engine item %s", id)
	}
	return it.PRTracked
}

func (h *harness) ledgerBytes() string {
	h.t.Helper()
	b, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		h.t.Fatal(err)
	}
	return string(b)
}

// addLedger appends items to the ledger, as a user or the chat would.
func (h *harness) addLedger(items ...operator.TrackedItem) {
	h.t.Helper()
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked = append(st.Tracked, items...)
		return nil
	}); err != nil {
		h.t.Fatal(err)
	}
}

func prLedgerItem(t *testing.T, id, repo string, pr int, nwo string) operator.TrackedItem {
	t.Helper()
	it, err := operator.NewGitHubPRItem(id, nil, map[string]interface{}{"repo": repo, "pr": pr}, nwo)
	if err != nil {
		t.Fatal(err)
	}
	return it
}

func noPRMutations(t *testing.T, h *harness) {
	t.Helper()
	for _, verb := range []string{"ready", "merge", "edit"} {
		if n := h.run.called("gh pr " + verb); n != 0 {
			t.Fatalf("the engine ran gh pr %s %d time(s): %q", verb, n, h.run.calls)
		}
	}
}

// shippedMergeAuto queues a merge-auto item `a` done on `a-branch` with PR 41.
func shippedMergeAuto(t *testing.T) (*harness, *testRepo, *simPR) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	return h, foo, h.shipped(41, "a")[0]
}

func TestRecordDoneProjectsTheOpenPRAsAGitHubPRItem(t *testing.T) {
	h, foo, _ := shippedMergeAuto(t)
	res := h.step()

	it, ok := h.ledgerItem("pr-41")
	if !ok {
		t.Fatalf("pr-41 not projected: %v", ids(h.ledger().Tracked))
	}
	wantArgv := []string{"gh", "pr", "view", "41", "--repo", "owner/name", "--json", "state,mergedAt,mergeable,isDraft,mergeStateStatus"}
	if it.Kind != operator.KindGitHubPR || !reflect.DeepEqual(it.Probe.Argv, wantArgv) || it.Probe.Mode != "shell" ||
		!reflect.DeepEqual(it.Probe.Fields, []string{"state", "mergedAt", "mergeable", "isDraft", "mergeStateStatus"}) {
		t.Fatalf("probe = %+v kind %s", it.Probe, it.Kind)
	}
	if it.CheckEvery == nil || *it.CheckEvery != "5m" || it.DoneWhen == nil || *it.DoneWhen != `state == "MERGED"` ||
		it.Then == nil || *it.Then != "merge-auto: ready and merge this PR when its required checks are green" || len(it.DependsOn) != 0 {
		t.Fatalf("item = %+v", it)
	}
	if operator.ScopeString(it.Scope, "repo") != foo.Dir || operator.ScopePRNumber(it.Scope) != "41" ||
		operator.ScopeString(it.Scope, "change") != "" || operator.ScopeString(it.Scope, "item") != "a" || len(it.Scope) != 4 {
		t.Fatalf("scope = %+v", it.Scope)
	}
	if got := h.marker("a"); got != "pr-41" {
		t.Fatalf("pr_tracked = %q, want pr-41", got)
	}
	if !hasAction(res, ActPRTracked, "a") || len(res.Escalations) != 0 {
		t.Fatalf("result = %+v", res)
	}
	noPRMutations(t, h)
	if a, _ := h.ledgerItem("a"); a.Scope != nil {
		if _, leaked := a.Scope[scopePRTracked]; leaked {
			t.Fatalf("the engine marker reached the queue item's ledger projection: %+v", a.Scope)
		}
	}
	if _, leaked := it.Scope[scopePRTracked]; leaked {
		t.Fatalf("the engine marker reached the PR item: %+v", it.Scope)
	}
}

func TestRecordDoneReportsCompletionOnlyOnThePassThatWritesIt(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.attachBranch("a", "a-branch")
	h.livePanes()
	h.setDone("a")
	if res := h.step(); hasAction(res, ActDone, "a") || hasAction(res, ActPRTracked, "a") {
		t.Fatalf("a recorded completion was announced again, or a PR tracked with none open: %+v", res)
	}
	h.gh.add(41, "a-branch")
	if res := h.step(); hasAction(res, ActDone, "a") || !hasAction(res, ActPRTracked, "a") {
		t.Fatalf("retry pass = %+v", res)
	}
}

func TestRecordDoneIsIdempotentOnceTheItemIsTracked(t *testing.T) {
	h, _, _ := shippedMergeAuto(t)
	h.step()
	before := h.ledgerBytes()
	h.run.reset()
	res := h.step()
	if h.run.called("gh ") != 0 {
		t.Fatalf("a tracked item was read again: %q", h.run.calls)
	}
	if hasAction(res, ActPRTracked, "") || hasAction(res, ActDone, "") || h.ledgerBytes() != before {
		t.Fatalf("second pass acted: %+v", res)
	}
}

func TestRecordDoneWithNoPRWritesNothingThenProjectsWhenOneOpens(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.setDone("a")
	h.attachBranch("a", "a-branch")
	for i := 0; i < 2; i++ {
		res := h.step()
		if len(res.Escalations) != 0 || hasAction(res, ActPRTracked, "") || h.marker("a") != "" || len(h.ledger().Tracked) != 1 {
			t.Fatalf("pass %d with no PR: %+v marker=%q items=%v", i, res, h.marker("a"), ids(h.ledger().Tracked))
		}
	}
	h.gh.add(41, "a-branch")
	if res := h.step(); !hasAction(res, ActPRTracked, "a") || !h.hasLedger("pr-41") {
		t.Fatalf("the retry did not project: %+v", res)
	}
}

func (h *harness) hasLedger(id string) bool {
	_, ok := h.ledgerItem(id)
	return ok
}

func TestRecordDoneMarksAnEndedPRWithoutAnItem(t *testing.T) {
	for state, want := range map[string]string{"MERGED": prTrackedMerged, "CLOSED": prTrackedClosed} {
		t.Run(state, func(t *testing.T) {
			h, _, pr := shippedMergeAuto(t)
			pr.State = state
			res := h.step()
			if h.hasLedger("pr-41") || h.marker("a") != want || hasAction(res, ActPRTracked, "") {
				t.Fatalf("marker=%q items=%v res=%+v", h.marker("a"), ids(h.ledger().Tracked), res)
			}
			h.run.reset()
			h.step()
			if h.run.called("gh ") != 0 {
				t.Fatalf("a marked item was read again: %q", h.run.calls)
			}
		})
	}
}

func TestRecordDoneProjectsNothingOutsideMergeAuto(t *testing.T) {
	for _, mode := range []string{"cherry-pick-ladder", "stacked-prs"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			foo := newRepo(t, "foo")
			h.queue(mode, Entry{ID: "a", Repo: foo.Dir, Task: "a"})
			h.shipped(41, "a")
			res := h.step()
			if h.hasLedger("pr-41") || h.marker("a") != "" || h.run.called("gh pr view") != 0 || hasAction(res, ActPRTracked, "") {
				t.Fatalf("%s projected: items=%v calls=%q", mode, ids(h.ledger().Tracked), h.run.calls)
			}
		})
	}
}

func TestPRItemIDCollisionRule(t *testing.T) {
	h, foo, _ := shippedMergeAuto(t)
	bar := newRepo(t, "bar")
	other := prLedgerItem(t, "pr-41", bar.Dir, 41, "owner/bar")
	squat, err := operator.NewPaneItem("pr-foo-41", nil, map[string]interface{}{"repo": bar.Dir})
	if err != nil {
		t.Fatal(err)
	}
	h.addLedger(other)
	h.step()
	if got := h.marker("a"); got != "pr-foo-41" || !h.hasLedger("pr-foo-41") {
		t.Fatalf("id taken by another repo's PR: marker %q items %v", got, ids(h.ledger().Tracked))
	}
	if it, _ := h.ledgerItem("pr-41"); operator.ScopeString(it.Scope, "repo") != bar.Dir {
		t.Fatalf("the other item was changed: %+v", it.Scope)
	}

	h2, foo2, _ := shippedMergeAuto(t)
	h2.addLedger(prLedgerItem(t, "pr-41", bar.Dir, 41, "owner/bar"), squat)
	h2.step()
	if got := h2.marker("a"); got != "pr-foo-41-2" {
		t.Fatalf("second collision: marker %q (repos %s %s)", got, foo.Dir, foo2.Dir)
	}
}

func TestPRItemIDNeverTakesAQueueItemID(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "pr-41", Repo: foo.Dir, Task: "x"})
	h.shipped(41, "a")
	h.step()
	if got := h.marker("a"); got != "pr-foo-41" {
		t.Fatalf("marker = %q, want pr-foo-41", got)
	}
	if it, ok := h.ledgerItem("pr-41"); ok && it.Kind == operator.KindGitHubPR {
		t.Fatal("a github-pr item took a queue item's id")
	}
}

func TestPRAlreadyTrackedUnderAnyIDIsNotDuplicated(t *testing.T) {
	h, foo, _ := shippedMergeAuto(t)
	h.addLedger(prLedgerItem(t, "mine", foo.Dir, 41, "owner/name"))
	h.step()
	if h.marker("a") != "mine" || h.hasLedger("pr-41") || len(h.ledger().Tracked) != 2 {
		t.Fatalf("marker %q items %v", h.marker("a"), ids(h.ledger().Tracked))
	}
}

func TestPRLookupFailuresEscalateAndRetry(t *testing.T) {
	t.Run("pr view", func(t *testing.T) {
		h, _, _ := shippedMergeAuto(t)
		h.run.fail("gh pr view a-branch", "boom")
		res := h.step()
		if !hasEscalation(res, "PR lookup failed: boom") || h.marker("a") != "" || h.hasLedger("pr-41") {
			t.Fatalf("res=%+v marker=%q", res, h.marker("a"))
		}
		h.run.on("gh pr view a-branch", h.gh.handle)
		if res := h.step(); !hasAction(res, ActPRTracked, "a") {
			t.Fatalf("not retried: %+v", res)
		}
	})
	t.Run("repo name", func(t *testing.T) {
		h, _, _ := shippedMergeAuto(t)
		h.run.fail("gh repo view --json nameWithOwner", "no auth")
		res := h.step()
		if !hasEscalation(res, "PR repo lookup failed: no auth") || h.marker("a") != "" || h.hasLedger("pr-41") {
			t.Fatalf("res=%+v marker=%q", res, h.marker("a"))
		}
		h.run.reply("gh repo view --json nameWithOwner", "owner/name\n")
		if res := h.step(); !hasAction(res, ActPRTracked, "a") {
			t.Fatalf("not retried: %+v", res)
		}
	})
	t.Run("invalid repo name", func(t *testing.T) {
		h, _, _ := shippedMergeAuto(t)
		h.gh.nwo = "not-a-repo"
		res := h.step()
		if !hasEscalation(res, "PR repo lookup failed: gh returned") || h.marker("a") != "" || h.hasLedger("pr-41") {
			t.Fatalf("res=%+v marker=%q", res, h.marker("a"))
		}
	})
	t.Run("no branch", func(t *testing.T) {
		h := newHarness(t)
		foo := newRepo(t, "foo")
		h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
		h.setDone("a")
		res := h.step()
		if !hasEscalation(res, "cannot track PR: no branch recorded") || h.marker("a") != "" {
			t.Fatalf("res=%+v marker=%q", res, h.marker("a"))
		}
	})
}

func TestNameWithOwnerIsReadOncePerRepo(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("merge-auto", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	h.shipped(41, "a", "b")
	h.step()
	if h.marker("a") != "pr-41" || h.marker("b") != "pr-42" {
		t.Fatalf("markers %q %q", h.marker("a"), h.marker("b"))
	}
	if n := h.run.called("gh repo view --json nameWithOwner"); n != 1 {
		t.Fatalf("nameWithOwner read %d times, want once per repo", n)
	}
}

func TestAProjectedPRItemRemovedByTheUserIsNotReAdded(t *testing.T) {
	h, _, _ := shippedMergeAuto(t)
	h.step()
	if err := operator.Remove(h.env.StatePath, "pr-41"); err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	h.step()
	if h.hasLedger("pr-41") || h.run.called("gh pr view") != 0 {
		t.Fatalf("the removed item came back: calls %q", h.run.calls)
	}
}

func TestProjectedPRItemIsNotEngineOwned(t *testing.T) {
	h, _, _ := shippedMergeAuto(t)
	h.step()
	owned, err := OwnedIDs(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if owned["pr-41"] || !owned["a"] {
		t.Fatalf("owned = %v", owned)
	}
	entries, err := QueueEntries(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := entries["pr-41"]; ok {
		t.Fatalf("entries = %v", entries)
	}
}

func TestPRProjectionRefusedWhenTheSourceItemIsGone(t *testing.T) {
	h, foo, _ := shippedMergeAuto(t)
	e := newEngine(h.env)
	ghost := h.item("a")
	ghost.ID = "ghost"
	_, err := e.addPRProjection(ghost, 41, "owner/name")
	if !errors.Is(err, errItemChanged) || h.hasLedger("pr-41") {
		t.Fatalf("err = %v, items %v (repo %s)", err, ids(h.ledger().Tracked), foo.Dir)
	}
	e.writeFailed("ghost", "PR item not written", err)
	if !hasEscalation(e.res, changedText("ghost")) {
		t.Fatalf("escalations = %+v", e.res.Escalations)
	}
}

// The chain: A ships with an open PR, so the pass tracks it and B stays held;
// the PR merges, the check closes the PR item, and the next pass spawns B.
func TestMergeAutoChainSpawnsTheSuccessorAfterTheTrackedPRMerges(t *testing.T) {
	h, _ := mergeAutoPair(t)
	h.attachBranch("a", "a-branch")
	pr := h.gh.add(41, "a-branch")

	res := h.step()
	if !hasAction(res, ActPRTracked, "a") || !h.hasLedger("pr-41") || len(spawnedNames(h)) != 0 || h.stateOf(h.item("b")) != QueueHeld {
		t.Fatalf("first pass: %+v spawned %v", res, spawnedNames(h))
	}

	pr.State = "MERGED"
	now := "2026-11-24T12:00:00Z"
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[operator.IndexOf(st.Tracked, "pr-41")].DoneAt = &now
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	res = h.step()
	if !hasAction(res, ActSpawned, "b") || strings.Join(spawnedNames(h), ",") != "b" {
		t.Fatalf("after the merge: %+v spawned %v", res, spawnedNames(h))
	}
	noPRMutations(t, h)
}

func TestPRTrackNeverMutatesThePR(t *testing.T) {
	h, _, _ := shippedMergeAuto(t)
	for i := 0; i < 3; i++ {
		h.step()
	}
	noPRMutations(t, h)
	for _, c := range h.run.calls {
		if strings.HasPrefix(c, "gh ") && !strings.HasPrefix(c, "gh pr view") && !strings.HasPrefix(c, "gh repo view") && !strings.HasPrefix(c, "gh pr checks") {
			t.Fatalf("unexpected gh call %q", c)
		}
	}
}
