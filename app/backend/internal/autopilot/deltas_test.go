package autopilot

import (
	"context"
	"go/ast"
	"testing"

	"rk/internal/operator"
)

// The five intentional behaviour changes of the status/rule-table restructure,
// each with its own test, and the checks that the retired markers are neither
// read nor written.

var retiredMarkers = []string{"armed", "direct", "stall_seen"}

func noRetiredMarkers(t *testing.T, h *harness) {
	t.Helper()
	for _, it := range h.state().Tracked {
		for _, k := range retiredMarkers {
			if _, ok := it.Scope[k]; ok {
				t.Errorf("%s carries scope.%s: the engine neither reads nor writes it", it.ID, k)
			}
		}
	}
}

// ladderPair is a two-PR cherry-pick-ladder sequence with pending checks, its
// first PR armed by the engine.
func ladderPair(t *testing.T) (*harness, []*simPR) {
	t.Helper()
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")
	pending(prs...)
	h.startMerge()
	if !prs[0].Armed || prs[1].Armed {
		t.Fatalf("fixture: armed = %v, %v", prs[0].Armed, prs[1].Armed)
	}
	return h, prs
}

func TestDeltaArmedIsDerivedAndAHaltDisarmsTheWholeCone(t *testing.T) {
	h, prs := ladderPair(t)
	prs[1].Armed = true // a person armed the second PR; the engine never did
	prs[0].State = "CLOSED"
	res := h.step()
	if prs[0].Disarms != 1 || prs[0].Armed || !hasAction(res, ActDisarmed, "pr-1") || !hasEscalation(res, "closed without merging") {
		t.Fatalf("the halt must disarm its own item in the pass that writes it: disarms=%d %+v", prs[0].Disarms, res)
	}
	// The rest of the cone is observed once the halt is durable; P3 disarms it.
	res = h.step()
	if prs[1].Disarms != 1 || prs[1].Armed || !hasAction(res, ActDisarmed, "pr-2") {
		t.Fatalf("pr-2 armed by a person in the halted cone: disarms=%d armed=%v %+v", prs[1].Disarms, prs[1].Armed, res)
	}
	noRetiredMarkers(t, h)
	// P3 is the retry: nothing is left to disarm, so nothing is called again.
	calls := h.run.called("gh pr merge --disable-auto")
	h.step()
	if h.run.called("gh pr merge --disable-auto") != calls {
		t.Fatal("a disarmed cone was disarmed again")
	}
}

func TestDeltaStopDisarmsAPersonArmedPR(t *testing.T) {
	h, prs := ladderPair(t)
	prs[1].Armed = true
	res, err := Stop(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	if prs[0].Armed || prs[1].Armed || !hasAction(res, ActDisarmed, "pr-2") {
		t.Fatalf("armed = %v, %v: stop disarms every armed PR it can see: %+v", prs[0].Armed, prs[1].Armed, res)
	}
	noRetiredMarkers(t, h)
}

// Delta 2: a repo without auto-merge is a fact read from GitHub, not a failed
// arm attempt and a stored `direct` key.
func TestDeltaRepoWithoutAutoMergeIsAFactNotAFailedArm(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	pending(prs...)
	h.gh.noAutoMerge["o/foo"] = true
	res := h.startMerge()
	if h.run.called("gh pr merge --auto") != 0 || len(res.Escalations) != 0 || prs[0].Armed {
		t.Fatalf("a failed arm attempt or an escalation for a repo that forbids auto-merge: %+v", res)
	}
	if h.run.called("gh repo view o/foo --json autoMergeAllowed") != 1 {
		t.Fatalf("the repo setting was not read exactly once: %q", h.run.calls)
	}
	prs[0].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	h.step()
	if prs[0].State != "MERGED" {
		t.Fatal("P7 did not merge the green PR")
	}
	noRetiredMarkers(t, h)
}

// Delta 3: a halt writes `halted` on one item; the cone is derived, so
// clearing it on that one item resumes the PRs behind it.
func TestDeltaAHaltWritesOneItemAndClearingItResumesTheCone(t *testing.T) {
	h, prs := ladderPair(t)
	prs[0].State = "CLOSED"
	h.step()
	if !scopeBool(h.item("pr-1"), scopeHalted) || scopeBool(h.item("pr-2"), scopeHalted) {
		t.Fatal("a halt must write halted on the failing item only")
	}
	if h.prStatusOf("pr-2") != PRHalted {
		t.Fatalf("pr-2 = %s, want halted through pr-1", h.prStatusOf("pr-2"))
	}
	// The PR is reopened and the one marker cleared: the cone resumes.
	prs[0].State = "OPEN"
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[operator.IndexOf(st.Tracked, "pr-1")].Scope[scopeHalted] = false
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if h.prStatusOf("pr-2") == PRHalted {
		t.Fatal("pr-2 stayed halted after pr-1's halted was cleared")
	}
	h.step()
	if !prs[0].Armed {
		t.Fatal("the resumed head was not armed")
	}
}

func TestDeltaAFailedPRIsNeverArmed(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	res := h.startMerge()
	if !hasEscalation(res, "recovery needed: ci-failed — PR #1 (foo)") {
		t.Fatalf("no recovery escalation: %+v", res)
	}
	if prs[0].Armed || h.run.called("gh pr merge") != 0 {
		t.Fatalf("a failed PR was armed or merged: %q", h.run.calls)
	}
	noRetiredMarkers(t, h)
}

// A conflicting PR is `waiting` until it has been conflicting for three quiet
// polls, so it may be armed while the conflict is new; once the status is
// conflicting it is escalated and nothing acts on it again.
func TestDeltaAConflictingPRIsEscalatedAndLeftAlone(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	prs := h.shipped(1, "a")
	pending(prs...)
	prs[0].Mergeable = "CONFLICTING"
	res := h.startMerge()
	for i := 0; i < 4 && !hasEscalation(res, "recovery needed: conflicting — PR #1 (foo)"); i++ {
		res = h.step()
	}
	if !hasEscalation(res, "recovery needed: conflicting — PR #1 (foo)") {
		t.Fatalf("no recovery escalation: %+v", res)
	}
	merges := h.run.called("gh pr merge")
	h.step()
	if h.run.called("gh pr merge") != merges || prs[0].MergeCalls != 0 {
		t.Fatalf("a conflicting PR was acted on: %q", h.run.calls)
	}
	noRetiredMarkers(t, h)
}

// Delta 5: a sequence advances one PR per pass. P1 records a merge; the
// successor is observed and acted on the next pass.
func TestDeltaASequenceAdvancesOnePRPerPass(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"}, Entry{ID: "c", Repo: foo.Dir, Task: "c"})
	prs := h.shipped(1, "a", "b", "c")
	pending(prs...)
	h.startMerge()
	prs[0].State, prs[1].State = "MERGED", "MERGED" // both already merged on GitHub
	h.run.reset()
	res := h.step()
	if !operator.ItemDone(h.item("pr-1")) || operator.ItemDone(h.item("pr-2")) {
		t.Fatal("pass 1 must record exactly pr-1")
	}
	if h.run.called("gh pr view 2 --json number") != 0 || prs[2].Armed || len(res.Report) == 0 {
		t.Fatalf("a successor acted in its predecessor's pass: %+v %q", res, h.run.calls)
	}
	h.step()
	if !operator.ItemDone(h.item("pr-2")) || prs[2].Armed {
		t.Fatal("pass 2 must record exactly pr-2")
	}
	h.step()
	if !prs[2].Armed {
		t.Fatal("pass 3 must arm pr-3")
	}
}

// Old values of the retired markers are tolerated on disk: never read for a
// decision, never rewritten.
func TestRetiredMarkersOnDiskAreIgnoredAndLeftAlone(t *testing.T) {
	h, prs := ladderPair(t)
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		sc := st.Tracked[operator.IndexOf(st.Tracked, "pr-1")].Scope
		sc["armed"], sc["direct"], sc["stall_seen"] = false, true, "ci-failed@old"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// The PR is armed on GitHub though armed says false, and direct says true
	// though the repo allows auto-merge: only GitHub's answers count.
	prs[0].Checks = []checkRun{{Name: "ci", State: "FAILURE"}}
	h.step()
	sc := h.item("pr-1").Scope
	if sc["armed"] != false || sc["direct"] != true || sc["stall_seen"] != "ci-failed@old" {
		t.Fatalf("the engine rewrote a retired marker: %+v", sc)
	}
	if prs[0].MergeCalls != 0 || h.run.called("gh pr merge --squash") != 0 {
		t.Fatal("a stored direct marker made the engine merge")
	}
}

func TestEngineSourceNeverTouchesTheRetiredMarkers(t *testing.T) {
	names := map[string]bool{"scopeArmed": true, "scopeDirect": true, "scopeStallSeen": true}
	retired := func(e ast.Expr) bool {
		v, ok := stringLit(e)
		for _, k := range retiredMarkers {
			if ok && v == k {
				return true
			}
		}
		return false
	}
	for _, f := range parsePackageSources(t) {
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.ValueSpec:
				for _, id := range x.Names {
					if names[id.Name] {
						return false // the tolerated-on-disk definition itself
					}
				}
			case *ast.Ident:
				if names[x.Name] {
					t.Errorf("the engine uses %s", x.Name)
				}
			case *ast.IndexExpr:
				if isScopeMap(x.X) && retired(x.Index) {
					t.Errorf("the engine indexes scope with a retired marker")
				}
			case *ast.KeyValueExpr:
				if retired(x.Key) {
					t.Errorf("the engine names a retired marker as a key")
				}
			}
			return true
		})
	}
}
