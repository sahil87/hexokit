package autopilot

import (
	"context"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

func TestDeriveQueuePrecedence(t *testing.T) {
	x := newFx(t)
	// done › paused › skipped › held › pending/spawn-unknown/spawned/dead.
	done := x.queue("done", operator.MergeModeCherryPickLadder, "ghost")
	now := fxNow.Format(time.RFC3339)
	done.DoneAt = &now
	done.Paused = true
	paused := x.queue("paused", operator.MergeModeCherryPickLadder, "ghost")
	paused.Paused = true
	paused.Scope[scopeSkipped] = true
	skippedItem := x.queue("skipped", operator.MergeModeCherryPickLadder, "ghost")
	skippedItem.Scope[scopeSkipped] = true
	x.queue("held", operator.MergeModeCherryPickLadder, "ghost")
	deadHeld := x.queue("dead-held", operator.MergeModeCherryPickLadder, "ghost")
	x.pane(deadHeld, false)

	st := x.state()
	want := map[string]QueueStatus{
		"done": QueueDone, "paused": QueuePaused, "skipped": QueueSkipped, "held": QueueHeld, "dead-held": QueueHeld,
	}
	for id, w := range want {
		if got := deriveQueue(st, x.f, st.Tracked[operator.IndexOf(st.Tracked, id)]); got != w {
			t.Errorf("%s = %s, want %s", id, got, w)
		}
	}
}

func TestDeriveQueuePaneStatuses(t *testing.T) {
	cases := []struct {
		name  string
		setup func(x *fx, it *operator.TrackedItem)
		want  QueueStatus
	}{
		{"no pane, no marker", func(x *fx, it *operator.TrackedItem) {}, QueuePending},
		{"marker, no pane", func(x *fx, it *operator.TrackedItem) { it.Scope[scopeSpawning] = "t" }, QueueSpawnUnknown},
		{"live pane", func(x *fx, it *operator.TrackedItem) { x.pane(it, true) }, QueueSpawned},
		{"recorded pane gone", func(x *fx, it *operator.TrackedItem) { x.pane(it, false) }, QueueDead},
		{"a crashed respawn leaves the old pane id and its marker", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, false)
			it.Scope[scopeSpawning] = "t"
			it.Scope[scopeRespawned] = true
		}, QueueSpawnUnknown},
		{"completion observed", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, true)
			x.f.queueFor(it.ID).completed = true
		}, QueueDone},
		{"pane snapshot unavailable reads a recorded pane as alive", func(x *fx, it *operator.TrackedItem) {
			x.pane(it, false)
			x.f.panesKnown = false
		}, QueueSpawned},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newFx(t)
			it := x.queue("a", operator.MergeModeCherryPickLadder)
			c.setup(x, it)
			st := x.state()
			if got := deriveQueue(st, x.f, st.Tracked[0]); got != c.want {
				t.Fatalf("status = %s, want %s", got, c.want)
			}
		})
	}
}

func TestDeriveQueueHeldByDependencies(t *testing.T) {
	t.Run("an unfinished dependency holds", func(t *testing.T) {
		x := newFx(t)
		x.queue("a", operator.MergeModeCherryPickLadder)
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s", got)
		}
	})
	t.Run("a dependency whose completion is observed counts as done", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeCherryPickLadder)
		a.Scope["stop_stage"] = "hydrate"
		x.pane(a, true)
		x.f.queueFor("a").completed = true
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("b = %s: a stop-stage dependency needs no PR", got)
		}
	})
	t.Run("a same-repo dependency needs its PR", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeCherryPickLadder)
		now := fxNow.Format(time.RFC3339)
		a.DoneAt = &now
		x.queue("b", operator.MergeModeCherryPickLadder, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("no PR observed: b = %s", got)
		}
		x.f.queueFor("b").depPR["a"] = true
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("PR observed: b = %s", got)
		}
	})
	t.Run("merge-auto waits for the dependency's PR item to merge", func(t *testing.T) {
		x := newFx(t)
		a := x.queue("a", operator.MergeModeMergeAuto)
		now := fxNow.Format(time.RFC3339)
		a.DoneAt = &now
		x.queue("b", operator.MergeModeMergeAuto, "a")
		st := x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s before a's PR exists", got)
		}
		pr := x.pr("pr-1", operator.MergeModeMergeAuto)
		pr.Scope[scopeItem] = "a"
		st = x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueueHeld {
			t.Fatalf("b = %s while a's PR is unmerged", got)
		}
		x.items[2].DoneAt = &now
		st = x.state()
		if got := deriveQueue(st, x.f, st.Tracked[1]); got != QueuePending {
			t.Fatalf("b = %s once a's PR merged", got)
		}
	})
	t.Run("a dependency that survives only in branch_map is satisfied", func(t *testing.T) {
		x := newFx(t)
		x.queue("b", operator.MergeModeCherryPickLadder, "gone")
		st := x.state()
		st.BranchMap["gone"] = operator.BranchMapEntry{Branch: "gone-branch", Repo: "/r"}
		if got := deriveQueue(st, x.f, st.Tracked[0]); got != QueuePending {
			t.Fatalf("b = %s", got)
		}
	})
}

func derivedPR(x *fx, id string) PRStatus {
	st := x.state()
	return derivePR(st, x.f, st.Tracked[operator.IndexOf(st.Tracked, id)])
}

func TestDerivePRPrecedence(t *testing.T) {
	failed := checkRun{Name: "ci", State: "FAILURE"}
	pend := checkRun{Name: "ci", State: "PENDING"}
	pass := checkRun{Name: "ci", State: "SUCCESS"}
	cases := []struct {
		name  string
		setup func(x *fx)
		want  PRStatus
	}{
		{"merged beats halted", func(x *fx) { x.pr("p", "").Scope[scopeHalted] = true; x.view("p", prView{State: "MERGED"}) }, PRMerged},
		{"done_at is merged without a read", func(x *fx) {
			now := fxNow.Format(time.RFC3339)
			x.pr("p", "").DoneAt = &now
		}, PRMerged},
		{"halted beats closed", func(x *fx) { x.pr("p", "").Scope[scopeHalted] = true; x.view("p", prView{State: "CLOSED"}) }, PRHalted},
		{"closed beats deferred", func(x *fx) { x.pr("p", "").Scope[scopeDeferred] = true; x.view("p", prView{State: "CLOSED"}) }, PRClosed},
		{"deferred beats blocked", func(x *fx) {
			x.pr("p1", "")
			x.pr("p", "", "p1").Scope[scopeDeferred] = true
		}, PRDeferred},
		{"blocked beats draft", func(x *fx) {
			x.pr("p1", "")
			x.pr("p", "", "p1")
			v := open()
			v.IsDraft = true
			x.view("p", v)
		}, PRBlocked},
		{"draft beats failed", func(x *fx) {
			x.pr("p", "")
			v := open()
			v.IsDraft = true
			x.view("p", v, failed)
		}, PRDraft},
		{"failed beats conflicting", func(x *fx) {
			x.pr("p", "").Unchanged = 9
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, failed)
		}, PRFailed},
		{"conflicting needs three quiet polls", func(x *fx) {
			x.pr("p", "").Unchanged = stallUnchanged - 1
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, pend)
		}, PRWaiting},
		{"conflicting after three quiet polls", func(x *fx) {
			x.pr("p", "").Unchanged = stallUnchanged
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, pend)
		}, PRConflicting},
		{"green: checks pass and mergeable", func(x *fx) { x.pr("p", ""); x.view("p", open(), pass) }, PRGreen},
		{"green: no required checks", func(x *fx) { x.pr("p", ""); x.view("p", open()) }, PRGreen},
		{"a skipped or neutral check does not block green", func(x *fx) {
			x.pr("p", "")
			x.view("p", open(), pass, checkRun{State: "SKIPPED"}, checkRun{State: "NEUTRAL"})
		}, PRGreen},
		{"pending checks wait", func(x *fx) { x.pr("p", ""); x.view("p", open(), pass, pend) }, PRWaiting},
		{"mergeable UNKNOWN waits", func(x *fx) {
			x.pr("p", "")
			v := open()
			v.Mergeable = "UNKNOWN"
			x.view("p", v, pass)
		}, PRWaiting},
		{"a PR that could not be read waits", func(x *fx) { x.pr("p", "") }, PRWaiting},
		{"checks not read wait", func(x *fx) { x.pr("p", ""); x.f.pr["p"] = &prFacts{read: true, view: open()} }, PRWaiting},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newFx(t)
			c.setup(x)
			if got := derivedPR(x, "p"); got != c.want {
				t.Fatalf("status = %s, want %s", got, c.want)
			}
		})
	}
}

// The halted cone is derived through depends_on, across repos, from the one
// item that carries `halted`.
func TestHaltedConeIsDerivedThroughCrossRepoDependsOn(t *testing.T) {
	x := newFx(t)
	x.pr("foo-1", operator.MergeModeCherryPickLadder).Scope[scopeHalted] = true
	x.pr("foo-2", operator.MergeModeCherryPickLadder, "foo-1")
	x.pr("bar-1", operator.MergeModeCherryPickLadder, "foo-2")
	x.pr("bar-2", operator.MergeModeCherryPickLadder, "bar-1")
	x.pr("baz-1", operator.MergeModeCherryPickLadder)
	for _, id := range []string{"foo-1", "foo-2", "bar-1", "bar-2"} {
		if got := derivedPR(x, id); got != PRHalted {
			t.Errorf("%s = %s, want halted", id, got)
		}
	}
	if got := derivedPR(x, "baz-1"); got == PRHalted {
		t.Error("an independent sequence is halted")
	}
	// Clearing halted on the one item that carries it resumes the cone.
	x.items[0].Scope[scopeHalted] = false
	for _, id := range []string{"foo-1", "foo-2", "bar-1", "bar-2"} {
		if got := derivedPR(x, id); got == PRHalted {
			t.Errorf("%s stayed halted after the halted item was cleared", id)
		}
	}
}

func TestAMergedUpstreamDoesNotHoldItsDownstreamHalted(t *testing.T) {
	x := newFx(t)
	up := x.pr("up", operator.MergeModeCherryPickLadder)
	up.Scope[scopeHalted] = true
	now := fxNow.Format(time.RFC3339)
	up.DoneAt = &now
	x.pr("down", operator.MergeModeCherryPickLadder, "up")
	if got := derivedPR(x, "down"); got == PRHalted {
		t.Fatal("a merged upstream's stale halted marker halted its downstream")
	}
}

// Statuses read the ledger and the facts only; derive never reaches outside.
func TestFingerprintCoversDecisionInputsNotObservationClocks(t *testing.T) {
	x := newFx(t)
	it := x.pr("p", operator.MergeModeCherryPickLadder)
	base := fingerprint(*it)
	noise := *it
	noise.UpdatedAt, noise.Unchanged, noise.Failures = "2030-01-01T00:00:00Z", 5, 2
	checked := "2030-01-01T00:00:00Z"
	noise.CheckedAt = &checked
	noise.Last = map[string]interface{}{"state": "OPEN"}
	noise.Seen = []string{"x"}
	noise.Notes = []operator.Note{{Text: "hello"}}
	noise.Scope = map[string]interface{}{}
	for k, v := range it.Scope {
		noise.Scope[k] = v
	}
	noise.Scope["stage"], noise.Scope[scopeEscalated] = "apply", map[string]interface{}{"k": "v"}
	if got := fingerprint(noise); got != base {
		t.Fatalf("observation clocks changed the fingerprint:\n%s\n%s", base, got)
	}
	for name, mutate := range map[string]func(*operator.TrackedItem){
		"scope.pr":   func(i *operator.TrackedItem) { i.Scope["pr"] = 8 },
		"scope.repo": func(i *operator.TrackedItem) { i.Scope["repo"] = "/other" },
		"probe":      func(i *operator.TrackedItem) { i.Probe.Argv = append([]string{}, "gh", "pr", "view", "8") },
		"halted":     func(i *operator.TrackedItem) { i.Scope[scopeHalted] = true },
		"deferred":   func(i *operator.TrackedItem) { i.Scope[scopeDeferred] = true },
		"paused":     func(i *operator.TrackedItem) { i.Paused = true },
		"done_at":    func(i *operator.TrackedItem) { now := "2030-01-01T00:00:00Z"; i.DoneAt = &now },
		"depends_on": func(i *operator.TrackedItem) { i.DependsOn = []string{"q"} },
	} {
		changed := *it
		changed.Scope = map[string]interface{}{}
		for k, v := range it.Scope {
			changed.Scope[k] = v
		}
		mutate(&changed)
		if fingerprint(changed) == base {
			t.Errorf("a change to %s did not change the fingerprint", name)
		}
	}
}

// observe reads facts only for items that can act: a sequence's head, never a
// blocked successor or a deferred head, plus every unmerged PR of a halted cone.
func TestObserveReadsOnlyActionablePRs(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	h.queue("",
		Entry{ID: "f1", Repo: foo.Dir, Task: "f1", DependsOn: &[]string{}},
		Entry{ID: "f2", Repo: foo.Dir, Task: "f2"},
		Entry{ID: "b1", Repo: bar.Dir, Task: "b1", DependsOn: &[]string{}},
	)
	prs := h.shipped(1, "f1", "f2", "b1")
	pending(prs...)
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{Repo: foo.Dir}); err != nil {
		t.Fatal(err)
	}
	h.run.reset()
	h.step()
	viewed := func(n string) int { return h.run.called("gh pr view " + n + " --json number") }
	if viewed("1") != 1 {
		t.Errorf("the head of foo's sequence was read %d times, want once", viewed("1"))
	}
	if viewed("2") != 0 {
		t.Errorf("a blocked successor was read")
	}
	if viewed("3") != 0 {
		t.Errorf("a deferred head (its repo's merge was never started) was read")
	}
	if n := h.run.called("gh repo view o/foo --json autoMergeAllowed"); n > 1 {
		t.Errorf("the repo setting was read %d times in one pass", n)
	}

	// Halting reads every unmerged PR of the cone, so a stray arm is found.
	prs[1].Armed = true
	if _, err := Stop(context.Background(), h.env); err != nil {
		t.Fatal(err)
	}
	if prs[1].Armed || prs[1].Disarms != 1 {
		t.Fatalf("a PR armed by a person in the halted cone was not disarmed: armed=%v disarms=%d", prs[1].Armed, prs[1].Disarms)
	}
}

func TestStatusShowsDerivedStatusNames(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"}, Entry{ID: "b", Repo: foo.Dir, Task: "b"})
	prs := h.shipped(1, "a", "b")
	prs[0].Checks = []checkRun{{Name: "ci", State: "SUCCESS"}}
	if _, err := StartMerge(context.Background(), h.env, MergeOptions{}); err != nil {
		t.Fatal(err)
	}
	// The green head was merged by the pass; make a fresh sequence state to read.
	prs[0].State = "OPEN"
	prs[0].MergeCalls = 0
	res, err := Status(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, it := range res.Items {
		lines = append(lines, it.ID+" "+string(it.State)+" "+it.PR+" "+it.PRStatus+" "+it.Sequence)
	}
	got := strings.Join(lines, "|")
	if got != "a done 1 green 1/2|b done 2 blocked 2/2" {
		t.Fatalf("status rows = %s", got)
	}
}

// A predecessor removed from the ledger never merged: its successor stays
// blocked instead of acting.
func TestAMissingPredecessorBlocksItsSuccessor(t *testing.T) {
	x := newFx(t)
	x.pr("pr-2", operator.MergeModeCherryPickLadder, "pr-1")
	x.view("pr-2", open(), checkRun{State: "PENDING"})
	if got := derivedPR(x, "pr-2"); got != PRBlocked {
		t.Fatalf("status = %s, want blocked", got)
	}
}

// A halted PR merged by hand does not halt what was behind it: the observed
// MERGED fact ends the cone, whether or not done_at is recorded yet.
func TestAnObservedMergeEndsTheHaltedCone(t *testing.T) {
	x := newFx(t)
	x.pr("pr-1", operator.MergeModeCherryPickLadder).Scope[scopeHalted] = true
	x.view("pr-1", prView{State: "MERGED"})
	now := fxNow.Format(time.RFC3339)
	x.pr("pr-2", operator.MergeModeCherryPickLadder, "pr-1")
	x.view("pr-2", open(), checkRun{State: "PENDING"})
	if got := derivedPR(x, "pr-1"); got != PRMerged {
		t.Fatalf("pr-1 = %s", got)
	}
	if got := derivedPR(x, "pr-2"); got == PRHalted {
		t.Fatal("a stale halted marker on a merged PR halted its successor")
	}
	x.items[0].DoneAt = &now
	if got := derivedPR(x, "pr-2"); got == PRHalted {
		t.Fatal("a recorded merge must not halt its successor either")
	}
}

func TestHandMergedHaltedPRDoesNotDisarmItsArmedSuccessorInThePass(t *testing.T) {
	h, prs := ladderPair(t)
	prs[1].Armed = true
	if err := operator.Mutate(h.env.StatePath, func(st *operator.State) error {
		st.Tracked[operator.IndexOf(st.Tracked, "pr-1")].Scope[scopeHalted] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	prs[0].State = "MERGED"
	h.step()
	if prs[1].Disarms != 0 || !prs[1].Armed {
		t.Fatalf("pr-2 disarmed through a merged halted predecessor: disarms=%d armed=%v", prs[1].Disarms, prs[1].Armed)
	}
}

func TestDerivePRFixingPrecedence(t *testing.T) {
	failed := checkRun{Name: "ci", State: "FAILURE"}
	passed := checkRun{Name: "ci", State: "SUCCESS"}
	cases := []struct {
		name string
		view prView
		runs []checkRun
		read bool
		want PRStatus
	}{
		{name: "same head stays fixing even when green", view: open(), runs: []checkRun{passed}, read: true, want: PRFixing},
		{name: "fixing needs no check read", view: open(), want: PRFixing},
		{name: "new red head falls through to failed", view: open(), runs: []checkRun{failed}, read: true, want: PRFailed},
		{name: "new green head falls through to green", view: open(), runs: []checkRun{passed}, read: true, want: PRGreen},
		{name: "merged wins over fixing", view: prView{State: "MERGED"}, want: PRMerged},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newFx(t)
			it := x.pr("p", operator.MergeModeCherryPickLadder)
			it.Scope[scopeRecovery] = []string{recoveryCIFix}
			it.Scope[scopeFixHead] = "abc123"
			if c.name == "new red head falls through to failed" || c.name == "new green head falls through to green" {
				c.view.HeadRefOid = "new456"
			} else {
				c.view.HeadRefOid = "abc123"
			}
			x.f.pr["p"] = &prFacts{read: true, view: c.view, checks: c.runs, checksRead: c.read}
			if got := derivedPR(x, "p"); got != c.want {
				t.Fatalf("status = %s, want %s", got, c.want)
			}
		})
	}
}

func TestDeriveFixStatuses(t *testing.T) {
	passed := checkRun{Name: "ci", State: "SUCCESS"}
	pending := checkRun{Name: "ci", State: "PENDING"}
	cases := []struct {
		name  string
		build func(x *fx)
		want  FixStatus
	}{
		{name: "missing parent resolves", build: func(x *fx) { x.fix("ab12-fix") }, want: FixResolved},
		{name: "merged parent resolves", build: func(x *fx) {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder)
			x.view("p", prView{State: "MERGED"})
		}, want: FixResolved},
		{name: "halted parent resolves", build: func(x *fx) {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder).Scope[scopeHalted] = true
		}, want: FixResolved},
		{name: "green new head resolves", build: func(x *fx) {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder)
			x.view("p", open(), passed)
		}, want: FixResolved},
		{name: "same head green remains working", build: func(x *fx) {
			x.fix("ab12-fix")
			parent := x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder)
			parent.Scope[scopeRecovery] = []string{recoveryCIFix}
			parent.Scope[scopeFixHead] = "abc123"
			x.view("p", open(), passed)
		}, want: FixWorking},
		{name: "spawning without a live pane is unknown", build: func(x *fx) {
			x.fix("ab12-fix").Scope[scopeSpawning] = "t"
			x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder)
			x.view("p", open(), pending)
		}, want: FixSpawnUnknown},
		{name: "dead fix pane remains working", build: func(x *fx) {
			fix := x.fix("ab12-fix")
			x.pane(fix, false)
			x.fixParentFor("ab12-fix", operator.MergeModeCherryPickLadder)
			x.view("p", open(), pending)
		}, want: FixWorking},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			x := newFx(t)
			c.build(x)
			st := x.state()
			fix := st.Tracked[operator.IndexOf(st.Tracked, "ab12-fix")]
			if got := deriveFix(st, x.f, fix); got != c.want {
				t.Fatalf("status = %s, want %s", got, c.want)
			}
		})
	}
}

func TestAuthoringPaneLookup(t *testing.T) {
	t.Run("lowest matching pane wins and is idle", func(t *testing.T) {
		x := newFx(t)
		it := x.pr("p", operator.MergeModeCherryPickLadder)
		it.Scope["change"] = "ab12"
		x.f.panes["%7"] = operator.PaneInfo{PaneID: "%7", Change: "261116-ab12-x"}
		x.f.panes["%3"] = operator.PaneInfo{PaneID: "%3", Change: "261116-ab12-y"}
		x.f.panes["%1"] = operator.PaneInfo{PaneID: "%1", Change: "other"}
		pane, idle, known := authoringPane(x.state(), x.f, *it)
		if pane != "%3" || !idle || !known {
			t.Fatalf("pane = %s, idle = %v, known = %v", pane, idle, known)
		}
	})
	for _, state := range []string{"active", "waiting"} {
		t.Run(state+" agent is busy", func(t *testing.T) {
			x := newFx(t)
			it := x.pr("p", operator.MergeModeCherryPickLadder)
			it.Scope["change"] = "ab12"
			x.f.panes["%3"] = operator.PaneInfo{PaneID: "%3", Change: "ab12", AgentState: state}
			pane, idle, known := authoringPane(x.state(), x.f, *it)
			if pane != "%3" || idle || !known {
				t.Fatalf("pane = %s, idle = %v, known = %v", pane, idle, known)
			}
		})
	}
	t.Run("queue item pane is the change-less fallback", func(t *testing.T) {
		x := newFx(t)
		queue := x.queue("q", operator.MergeModeCherryPickLadder)
		x.pane(queue, true)
		it := x.pr("p", operator.MergeModeCherryPickLadder)
		it.Scope[scopeItem] = "q"
		pane, idle, known := authoringPane(x.state(), x.f, *it)
		if pane != "%1" || !idle || !known {
			t.Fatalf("pane = %s, idle = %v, known = %v", pane, idle, known)
		}
	})
	t.Run("unknown snapshot has no authoring pane", func(t *testing.T) {
		x := newFx(t)
		it := x.pr("p", operator.MergeModeCherryPickLadder)
		it.Scope["change"] = "ab12"
		x.f.panesKnown = false
		pane, idle, known := authoringPane(x.state(), x.f, *it)
		if pane != "" || idle || known {
			t.Fatalf("pane = %s, idle = %v, known = %v", pane, idle, known)
		}
	})
}

func TestStatusListsFixItems(t *testing.T) {
	h := newHarness(t)
	if err := newEngine(h.env).mutateEngine(func(st *engineState) error {
		st.upsertFix(engineItem{ID: "ab12-fix", Repo: "/r", Branch: "a-branch"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	res, err := Status(context.Background(), h.env)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Fixes) != 1 || res.Fixes[0].ID != "ab12-fix" || res.Fixes[0].State != FixResolved {
		t.Fatalf("fixes = %+v", res.Fixes)
	}
	if len(res.Items) != 0 || res.Complete {
		t.Fatalf("fix item affected queue completion: %+v", res)
	}
}
