package autopilot

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"rk/internal/operator"
)

// The decide table test runs on hand-built snapshots: no git, no gh, no tmux,
// no state file. Every case names a merge mode and a queue status, and pins the
// row that fires or an explicit wait.

var fxNow = time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

var fxModes = []string{operator.MergeModeCherryPickLadder, operator.MergeModeMergeAuto, operator.MergeModeStackedPRs}

// fx is one decide fixture: the ledger and the facts observe would have read.
type fx struct {
	t     *testing.T
	items []operator.TrackedItem
	f     *facts
}

func newFx(t *testing.T) *fx { return &fx{t: t, f: newFacts()} }

func (x *fx) state() *operator.State {
	return &operator.State{Tracked: x.items, BranchMap: map[string]operator.BranchMapEntry{}}
}

// queue adds a queue item (a plain-task agent) and returns its index.
func (x *fx) queue(id, mode string, deps ...string) *operator.TrackedItem {
	it, err := operator.NewPaneItem(id, deps, map[string]interface{}{
		"repo": "/r", scopeMergeMode: mode, scopeQueue: "q", scopeTask: "t", "branch": id + "-branch",
	})
	if err != nil {
		x.t.Fatal(err)
	}
	stamp := fxNow.Format(time.RFC3339)
	it.AddedAt, it.UpdatedAt = stamp, stamp
	x.items = append(x.items, it)
	return &x.items[len(x.items)-1]
}

func (x *fx) pane(it *operator.TrackedItem, alive bool) {
	it.Scope["pane"] = "%1"
	if alive {
		x.f.panes["%1"] = operator.PaneInfo{PaneID: "%1"}
	}
}

// outcome decides the snapshot and returns the target item's decision.
func (x *fx) outcome(id string) Decision {
	x.t.Helper()
	ds := decide(x.state(), x.f)
	var out []Decision
	for _, d := range ds {
		if d.Item == id {
			out = append(out, d)
		}
	}
	if len(out) != 1 {
		x.t.Fatalf("%d decisions for %s, want exactly one: %+v", len(out), id, ds)
	}
	return out[0]
}

type ruleCase struct {
	name   string
	status string
	row    string                          // "" is an explicit wait
	build  func(x *fx, mode string) string // returns the item id under test
}

func actionFor(row string) ActionKind {
	for _, r := range ruleTable {
		if r.id == row {
			return r.action
		}
	}
	return ActionWait
}

func queueRuleCases() []ruleCase {
	return []ruleCase{
		{name: "done with done_at unset records it (Q1)", status: "done", row: "Q1", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			x.f.queueFor("a").completed = true
			return "a"
		}},
		{name: "done and recorded waits", status: "done", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			return "a"
		}},
		{name: "paused waits", status: "paused", row: "", build: func(x *fx, m string) string {
			x.queue("a", m).Paused = true
			return "a"
		}},
		{name: "skipped waits", status: "skipped", row: "", build: func(x *fx, m string) string {
			x.queue("a", m).Scope[scopeSkipped] = true
			return "a"
		}},
		{name: "held waits", status: "held", row: "", build: func(x *fx, m string) string {
			x.queue("a", m)
			x.queue("b", m, "a")
			return "b"
		}},
		{name: "pending spawns (Q2)", status: "pending", row: "Q2", build: func(x *fx, m string) string {
			x.queue("a", m)
			return "a"
		}},
		{name: "spawn-unknown escalates once (Q3)", status: "spawn-unknown", row: "Q3", build: func(x *fx, m string) string {
			x.queue("a", m).Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			return "a"
		}},
		{name: "spawn-unknown already escalated waits without another note or notify", status: "spawn-unknown", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			it.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			c := &ruleCtx{it: *it}
			key, _ := spawnInterruptedText(c)
			it.Scope[scopeEscalated] = map[string]interface{}{key: "2026-01-01T00:00:00Z"}
			return "a"
		}},
		{name: "spawn-unknown with a stale dead pane id is not a second death", status: "spawn-unknown", row: "Q3", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, false)
			it.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			it.Scope[scopeRespawned] = true
			return "a"
		}},
		{name: "spawned, stage fresh: wait", status: "spawned", row: "", build: func(x *fx, m string) string {
			x.pane(x.queue("a", m), true)
			return "a"
		}},
		{name: "spawned, stage unchanged for 40 minutes in a queue open for 3 hours: wait", status: "spawned", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.UpdatedAt = fxNow.Add(-40 * time.Minute).Format(time.RFC3339)
			it.AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			return "a"
		}},
		{name: "dead with its respawn unspent respawns (Q4)", status: "dead", row: "Q4", build: func(x *fx, m string) string {
			x.pane(x.queue("a", m), false)
			return "a"
		}},
		{name: "dead with its respawn spent skips (Q5)", status: "dead", row: "Q5", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, false)
			it.Scope[scopeRespawned] = true
			return "a"
		}},
		{name: "removed queue projection escalates once (X0)", status: "spawned", row: "X0", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.Scope[scopeProjected] = true
			return "a"
		}},
		{name: "unwritten queue projection is repaired (X1)", status: "spawned", row: "X1", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.Scope[scopeProjected] = false
			return "a"
		}},
	}
}

func TestDecideTable(t *testing.T) {
	fired := map[string]bool{}
	seen := map[string]bool{} // mode/status
	for _, c := range queueRuleCases() {
		for _, mode := range fxModes {
			t.Run(c.name+" ["+mode+"]", func(t *testing.T) {
				x := newFx(t)
				id := c.build(x, mode)
				d := x.outcome(id)
				if d.Row != c.row {
					t.Fatalf("row = %q (%s), want %q", d.Row, d.Action, c.row)
				}
				if d.Status != c.status {
					t.Fatalf("status = %q, want %q", d.Status, c.status)
				}
				if d.Row == rowUnmatched {
					t.Fatalf("a reachable combination has no row and no declared wait: %+v", d)
				}
				if wantAction := actionFor(c.row); d.Action != wantAction {
					t.Fatalf("action = %q, want %q", d.Action, wantAction)
				}
				if c.row != "" {
					fired[c.row] = true
				}
				seen[mode+"/"+d.Status] = true
			})
		}
	}
	// Every row of the table fires in some case, and every (mode, status) was
	// exercised: a row or status added without a case fails here.
	for _, r := range ruleTable {
		if !fired[r.id] {
			t.Errorf("row %s is never exercised by the table test", r.id)
		}
	}
	for _, mode := range fxModes {
		for _, s := range allQueueStatuses {
			if !seen[mode+"/"+string(s)] {
				t.Errorf("%s/%s is not covered", mode, s)
			}
		}
	}
}

func TestRuleTableShape(t *testing.T) {
	var ids []string
	for _, r := range ruleTable {
		ids = append(ids, r.id)
	}
	want := []string{"X0", "X1", "Q1", "Q2", "Q3", "Q4", "Q5"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("rule table order = %v, want %v", ids, want)
	}
	for _, r := range ruleTable {
		if r.action == ActionWait {
			t.Errorf("row %s has no action: a wait is a waitTable entry, not a row", r.id)
		}
		if r.action == ActionEscalate && r.text == nil {
			t.Errorf("escalate row %s has no reason text", r.id)
		}
	}
}

// Every status has a row that can fire or a declared wait, so adding a status
// without either fails here.
func TestEveryStatusHasARowOrADeclaredWait(t *testing.T) {
	for _, s := range allQueueStatuses {
		has := waitDeclared(s)
		for _, r := range ruleTable {
			if r.queue == s || (r.queue == "" && !r.all && s != QueueDone) {
				has = true
			}
		}
		if !has {
			t.Errorf("queue status %s has neither a row nor a declared wait", s)
		}
	}
	for _, w := range waitTable {
		if w.reason == "" {
			t.Errorf("wait %+v has no reason", w)
		}
	}
}

func TestUndeclaredCombinationIsReportedNotActed(t *testing.T) {
	saved := waitTable
	t.Cleanup(func() { waitTable = saved })
	waitTable = nil
	x := newFx(t)
	x.queue("a", operator.MergeModeCherryPickLadder).Paused = true
	if d := x.outcome("a"); d.Row != rowUnmatched || d.Action != ActionWait {
		t.Fatalf("decision = %+v, want an unmatched wait that acts on nothing", d)
	}
}

// decide is a pure function: the same snapshot gives the same decisions and
// the snapshot is left untouched.
func TestDecideIsPureAndDeterministic(t *testing.T) {
	x := newFx(t)
	a := x.queue("a", operator.MergeModeMergeAuto)
	x.pane(a, true)
	x.f.queueFor("a").completed = true
	x.queue("b", operator.MergeModeMergeAuto, "a")
	before := fmt.Sprintf("%+v|%+v", x.items, x.f.queue)
	first := decide(x.state(), x.f)
	second := decide(x.state(), x.f)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("decide is not deterministic:\n%+v\n%+v", first, second)
	}
	if after := fmt.Sprintf("%+v|%+v", x.items, x.f.queue); before != after {
		t.Fatalf("decide mutated its inputs:\n%s\n%s", before, after)
	}
	one := map[string]int{}
	for _, d := range first {
		one[d.Item]++
	}
	for id, n := range one {
		if n != 1 {
			t.Errorf("%s has %d decisions, want at most one row per item", id, n)
		}
	}
}

// Decisions come out in ledger order, the order executors run in.
func TestDecideKeepsLedgerOrder(t *testing.T) {
	x := newFx(t)
	x.queue("b", operator.MergeModeCherryPickLadder)
	x.queue("a", operator.MergeModeCherryPickLadder, "b")
	var got []string
	for _, d := range decide(x.state(), x.f) {
		got = append(got, d.Item)
	}
	if strings.Join(got, ",") != "b,a" {
		t.Fatalf("decision order = %v, want ledger order b,a", got)
	}
}

// A former PR projection in the ledger is no engine work: decide lists queue
// items only.
func TestDecideIgnoresNonQueueItems(t *testing.T) {
	x := newFx(t)
	x.queue("a", operator.MergeModeCherryPickLadder)
	pr, err := operator.NewGitHubPRItem("pr-41", nil, map[string]interface{}{"repo": "/r", "pr": 41}, "o/r")
	if err != nil {
		t.Fatal(err)
	}
	x.items = append(x.items, pr)
	ds := decide(x.state(), x.f)
	if len(ds) != 1 || ds[0].Item != "a" {
		t.Fatalf("decisions = %+v, want only the queue item", ds)
	}
}
