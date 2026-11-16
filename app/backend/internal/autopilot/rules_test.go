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
// no state file. Every case names an item kind, a merge mode and a status, and
// pins the row that fires or an explicit wait.

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

// pr adds a sequence PR item with the given facts.
func (x *fx) pr(id, mode string, deps ...string) *operator.TrackedItem {
	it, err := operator.NewGitHubPRItem(id, deps, map[string]interface{}{
		"repo": "/r", "pr": 7, scopeMergeSeq: "s", scopeItem: "q-" + id, scopeMergeMode: mode,
	}, "o/r")
	if err != nil {
		x.t.Fatal(err)
	}
	x.items = append(x.items, it)
	return &x.items[len(x.items)-1]
}

func (x *fx) fix(id string) *operator.TrackedItem {
	it, err := operator.NewPaneItem(id, nil, map[string]interface{}{"repo": "/r", "change": "ab12", "branch": "a-branch"})
	if err != nil {
		x.t.Fatal(err)
	}
	it.Kind = "fix"
	x.items = append(x.items, it)
	return &x.items[len(x.items)-1]
}

func (x *fx) fixParentFor(id, mode string) *operator.TrackedItem {
	parent := x.pr("p", mode)
	parent.Scope[scopeFixItem] = id
	parent.Scope[scopeFixHead] = "old000"
	return parent
}

func (x *fx) pane(it *operator.TrackedItem, alive bool) {
	it.Scope["pane"] = "%1"
	if alive {
		x.f.panes["%1"] = operator.PaneInfo{PaneID: "%1"}
	}
}

// view records a successfully read PR with the given state and checks.
func (x *fx) view(id string, v prView, checks ...checkRun) *prFacts {
	pf := &prFacts{read: true, view: v, checks: checks, checksRead: true}
	if i := operator.IndexOf(x.state().Tracked, id); i >= 0 && modeOf(x.items[i]) == operator.MergeModeStackedPRs {
		pf.stacked, pf.staleRead, pf.base, pf.defaultBranch, pf.ancestor = true, true, "main", "main", true
	}
	x.f.pr[id] = pf
	x.f.autoMerge["o/r"] = true
	return pf
}

func open() prView { return prView{State: "OPEN", Mergeable: "MERGEABLE", HeadRefOid: "abc123"} }

// outcome decides the snapshot and returns the target item's decision.
func (x *fx) outcome(id string) Decision {
	x.t.Helper()
	ds := decide(x.state(), x.f, fxNow)
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
	kind   string // queue | pr
	status string
	row    string // "" is an explicit wait
	action ActionKind
	build  func(x *fx, mode string) string // returns the item id under test
	// modes and statuses hold per-mode overrides; nil runs every mode.
	modes    map[string]string // mode -> row that fires there instead
	statuses map[string]string // mode -> derived status
}

// rowFor is the row a case expects in a mode: the case's own, or its per-mode
// override.
func rowFor(c ruleCase, mode string) string {
	if r, ok := c.modes[mode]; ok {
		return r
	}
	return c.row
}

func statusFor(c ruleCase, mode string) string {
	if s, ok := c.statuses[mode]; ok {
		return s
	}
	return c.status
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
		{name: "done with done_at unset records it (Q1)", kind: "queue", status: "done", row: "Q1", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			x.f.queueFor("a").completed = true
			return "a"
		}},
		{name: "done and recorded: merge-auto without a PR item tracks it (Q7), others wait", kind: "queue", status: "done", row: "",
			modes: map[string]string{operator.MergeModeMergeAuto: "Q7"}, build: func(x *fx, m string) string {
				it := x.queue("a", m)
				now := fxNow.Format(time.RFC3339)
				it.DoneAt = &now
				return "a"
			}},
		{name: "done, merge-auto, PR item exists: wait", kind: "queue", status: "done", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			x.pr("pr-1", m)
			x.items[1].Scope[scopeItem] = "a"
			return "a"
		}},
		{name: "done, merge-auto, bare item: wait", kind: "queue", status: "done", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			it.Scope[scopeBare] = true
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			return "a"
		}},
		{name: "done, merge-auto, dropped PR is not retracked", kind: "queue", status: "done", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			it.Scope[scopePRDropped] = true
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			return "a"
		}},
		{name: "paused waits", kind: "queue", status: "paused", row: "", build: func(x *fx, m string) string {
			x.queue("a", m).Paused = true
			return "a"
		}},
		{name: "skipped waits", kind: "queue", status: "skipped", row: "", build: func(x *fx, m string) string {
			x.queue("a", m).Scope[scopeSkipped] = true
			return "a"
		}},
		{name: "held waits", kind: "queue", status: "held", row: "", build: func(x *fx, m string) string {
			x.queue("a", m)
			x.queue("b", m, "a")
			return "b"
		}},
		{name: "pending spawns (Q2)", kind: "queue", status: "pending", row: "Q2", build: func(x *fx, m string) string {
			x.queue("a", m)
			return "a"
		}},
		{name: "spawn-unknown escalates once (Q3)", kind: "queue", status: "spawn-unknown", row: "Q3", build: func(x *fx, m string) string {
			x.queue("a", m).Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			return "a"
		}},
		{name: "spawn-unknown already escalated waits without another note or notify", kind: "queue", status: "spawn-unknown", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			it.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			c := &ruleCtx{it: *it}
			key, _ := spawnInterruptedText(c)
			it.Scope[scopeEscalated] = map[string]interface{}{key: "2026-01-01T00:00:00Z"}
			return "a"
		}},
		{name: "spawn-unknown with a stale dead pane id is not a second death", kind: "queue", status: "spawn-unknown", row: "Q3", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, false)
			it.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			it.Scope[scopeRespawned] = true
			return "a"
		}},
		{name: "spawned, stage fresh: wait", kind: "queue", status: "spawned", row: "", build: func(x *fx, m string) string {
			x.pane(x.queue("a", m), true)
			return "a"
		}},
		{name: "spawned, stage unchanged 30 minutes escalates once (Q6a)", kind: "queue", status: "spawned", row: "Q6a", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.UpdatedAt = fxNow.Add(-slowStage - time.Minute).Format(time.RFC3339)
			return "a"
		}},
		{name: "spawned, stage stuck but already escalated: wait", kind: "queue", status: "spawned", row: "", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.UpdatedAt = fxNow.Add(-slowStage - time.Minute).Format(time.RFC3339)
			key, _ := slowStageText(&ruleCtx{it: *it})
			it.Scope[scopeEscalated] = map[string]interface{}{key: "x"}
			return "a"
		}},
		{name: "dead with its respawn unspent respawns (Q4)", kind: "queue", status: "dead", row: "Q4", build: func(x *fx, m string) string {
			x.pane(x.queue("a", m), false)
			return "a"
		}},
		{name: "dead with its respawn spent skips (Q5)", kind: "queue", status: "dead", row: "Q5", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, false)
			it.Scope[scopeRespawned] = true
			return "a"
		}},
		{name: "the oldest unfinished item, open over 2 hours, escalates once (Q6b)", kind: "queue", status: "held", row: "Q6b", build: func(x *fx, m string) string {
			a := x.queue("a", m, "ghost")
			a.AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			x.queue("b", m, "a")
			x.items[1].AddedAt = fxNow.Add(-time.Hour).Format(time.RFC3339)
			return "a"
		}},
		{name: "Q6b is for the oldest only", kind: "queue", status: "held", row: "", build: func(x *fx, m string) string {
			a := x.queue("a", m, "ghost")
			a.AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			x.queue("b", m, "a")
			x.items[1].AddedAt = fxNow.Add(-2*time.Hour - time.Minute).Format(time.RFC3339)
			return "b"
		}},
		{name: "Q6b once: the recorded escalation waits", kind: "queue", status: "paused", row: "", build: func(x *fx, m string) string {
			a := x.queue("a", m)
			a.Paused = true
			a.AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			key, _ := slowQueueText(&ruleCtx{})
			a.Scope[scopeEscalated] = map[string]interface{}{key: "x"}
			return "a"
		}},
		{name: "Q6b is after every other row: a pending oldest item spawns instead", kind: "queue", status: "pending", row: "Q2", build: func(x *fx, m string) string {
			x.queue("a", m).AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			return "a"
		}},
		{name: "Q6b never fires on a done item", kind: "queue", status: "done", row: "", build: func(x *fx, m string) string {
			a := x.queue("a", m)
			a.AddedAt = fxNow.Add(-3 * time.Hour).Format(time.RFC3339)
			now := fxNow.Format(time.RFC3339)
			a.DoneAt = &now
			if m == operator.MergeModeMergeAuto {
				x.pr("pr-1", m)
				x.items[1].Scope[scopeItem] = "a"
			}
			return "a"
		}},
		{name: "removed queue projection escalates once (X0)", kind: "queue", status: "spawned", row: "X0", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.Scope[scopeProjected] = true
			return "a"
		}},
		{name: "unwritten queue projection is repaired (X1)", kind: "queue", status: "spawned", row: "X1", build: func(x *fx, m string) string {
			it := x.queue("a", m)
			x.pane(it, true)
			it.Scope[scopeProjected] = false
			return "a"
		}},
	}
}

func prRuleCases() []ruleCase {
	failed := checkRun{Name: "ci", State: "FAILURE"}
	passed := checkRun{Name: "ci", State: "SUCCESS"}
	pend := checkRun{Name: "ci", State: "PENDING"}
	stackedWaits := map[string]string{operator.MergeModeStackedPRs: ""}
	return []ruleCase{
		{name: "merged on GitHub and unrecorded records it (P1)", kind: "pr", status: "merged", row: "P1", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", prView{State: "MERGED"})
			return "p"
		}},
		{name: "merged and recorded waits", kind: "pr", status: "merged", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			return "p"
		}},
		{name: "merged beats halted", kind: "pr", status: "merged", row: "P1", build: func(x *fx, m string) string {
			x.pr("p", m).Scope[scopeHalted] = true
			x.view("p", prView{State: "MERGED"})
			return "p"
		}},
		{name: "halted and armed is disarmed (P3)", kind: "pr", status: "halted", row: "P3", build: func(x *fx, m string) string {
			x.pr("p", m).Scope[scopeHalted] = true
			v := open()
			v.AutoMergeRequest = &struct{}{}
			x.view("p", v)
			return "p"
		}},
		{name: "halted and not armed waits", kind: "pr", status: "halted", row: "", build: func(x *fx, m string) string {
			x.pr("p", m).Scope[scopeHalted] = true
			x.view("p", open())
			return "p"
		}},
		{name: "halted through an upstream PR and armed is disarmed (P3)", kind: "pr", status: "halted", row: "P3", build: func(x *fx, m string) string {
			x.pr("p1", m).Scope[scopeHalted] = true
			x.pr("p2", m, "p1")
			v := open()
			v.AutoMergeRequest = &struct{}{}
			x.view("p2", v)
			return "p2"
		}},
		{name: "halted with its armed state unread waits", kind: "pr", status: "halted", row: "", build: func(x *fx, m string) string {
			x.pr("p", m).Scope[scopeHalted] = true
			return "p"
		}},
		{name: "closed halts (P2)", kind: "pr", status: "closed", row: "P2", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", prView{State: "CLOSED"})
			return "p"
		}},
		{name: "deferred waits", kind: "pr", status: "deferred", row: "", build: func(x *fx, m string) string {
			x.pr("p", m).Scope[scopeDeferred] = true
			return "p"
		}},
		{name: "blocked waits", kind: "pr", status: "blocked", row: "", build: func(x *fx, m string) string {
			x.pr("p1", m)
			x.pr("p2", m, "p1")
			return "p2"
		}},
		{name: "draft is readied (P4), including stacked-prs", kind: "pr", status: "draft", row: "P4", build: func(x *fx, m string) string {
			x.pr("p", m)
			v := open()
			v.IsDraft = true
			x.view("p", v)
			return "p"
		}},
		{name: "fixing inside the no-push window waits", kind: "pr", status: "fixing", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeRecovery] = []string{recoveryCIFix}
			it.Scope[scopeFixHead] = "abc123"
			it.Scope[scopeRecoverAt] = fxNow.Add(-recoveryWindow + time.Minute).Format(time.RFC3339)
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "fixing past the no-push window halts (C1)", kind: "pr", status: "fixing", row: "C1", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeRecovery] = []string{recoveryCIFix}
			it.Scope[scopeFixHead] = "abc123"
			it.Scope[scopeRecoverAt] = fxNow.Add(-recoveryWindow - time.Minute).Format(time.RFC3339)
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "failed with an idle authoring pane sends a fix request (C2)", kind: "pr", status: "failed", row: "C2", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope["change"] = "ab12"
			x.f.panes["%3"] = operator.PaneInfo{PaneID: "%3", Change: "261116-ab12-x"}
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "failed with a busy authoring pane waits", kind: "pr", status: "failed", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope["change"] = "ab12"
			x.f.panes["%3"] = operator.PaneInfo{PaneID: "%3", Change: "261116-ab12-x", AgentState: "active"}
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "failed without an authoring pane spawns recovery (C3)", kind: "pr", status: "failed", row: "C3", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "failed with an unknown pane snapshot waits", kind: "pr", status: "failed", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.f.panesKnown = false
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "failed on a new head after the fix round halts (C4)", kind: "pr", status: "failed", row: "C4", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeRecovery] = []string{recoveryCIFix}
			it.Scope[scopeFixHead] = "old000"
			x.view("p", open(), failed)
			return "p"
		}},
		{name: "conflicting with an unspent rebase round rebases (C5) in every mode, stacked-prs past stale-base included", kind: "pr", status: "conflicting", row: "C5", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Unchanged = stallUnchanged
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, pend)
			return "p"
		}},
		{name: "conflicting after the rebase round halts (C6) in every mode", kind: "pr", status: "conflicting", row: "C6", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeRecovery] = []string{recoveryRebase}
			it.Unchanged = stallUnchanged
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, pend)
			return "p"
		}},
		{name: "green and unarmed is merged (P7), including stacked-prs", kind: "pr", status: "green", row: "P7", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), passed)
			return "p"
		}},
		{name: "green with no required checks is merged (P7)", kind: "pr", status: "green", row: "P7", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open())
			return "p"
		}},
		{name: "green with an unobserved head commit is never merged", kind: "pr", status: "green", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			v := open()
			v.HeadRefOid = ""
			x.view("p", v)
			return "p"
		}},
		{name: "a dependency naming no ledger item blocks", kind: "pr", status: "blocked", row: "", build: func(x *fx, m string) string {
			x.pr("p2", m, "removed-pr-1")
			x.view("p2", open(), checkRun{State: "PENDING"})
			return "p2"
		}},
		{name: "green and armed waits for GitHub", kind: "pr", status: "green", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			v := open()
			v.AutoMergeRequest = &struct{}{}
			x.view("p", v, passed)
			return "p"
		}},
		{name: "green in a repo without auto-merge is still merged (P7)", kind: "pr", status: "green", row: "P7", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), passed)
			x.f.autoMerge["o/r"] = false
			return "p"
		}},
		{name: "waiting, repo allows auto-merge, unarmed is armed (P6), a stacked-prs PR waits", kind: "pr", status: "waiting", row: "P6", modes: stackedWaits, build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), pend)
			return "p"
		}},
		{name: "waiting and already armed waits", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			v := open()
			v.AutoMergeRequest = &struct{}{}
			x.view("p", v, pend)
			return "p"
		}},
		{name: "waiting in a repo without auto-merge waits", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), pend)
			x.f.autoMerge["o/r"] = false
			return "p"
		}},
		{name: "waiting with its checks unread waits even if the repo allows auto-merge", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.f.pr["p"] = &prFacts{read: true, view: open()}
			x.f.autoMerge["o/r"] = true
			return "p"
		}},
		{name: "waiting with the repo setting unread waits", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			x.view("p", open(), pend)
			delete(x.f.autoMerge, "o/r")
			return "p"
		}},
		{name: "waiting with mergeable UNKNOWN is still armed (P6)", kind: "pr", status: "waiting", row: "P6", modes: stackedWaits, build: func(x *fx, m string) string {
			x.pr("p", m)
			v := open()
			v.Mergeable = "UNKNOWN"
			x.view("p", v, passed)
			return "p"
		}},
		{name: "waiting on a failed read waits", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			x.pr("p", m)
			return "p"
		}},
		{name: "conflicting with too few quiet polls is waiting", kind: "pr", status: "waiting", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Unchanged = stallUnchanged - 1
			v := open()
			v.Mergeable = "CONFLICTING"
			x.view("p", v, pend)
			x.f.autoMerge["o/r"] = false
			return "p"
		}},
		{name: "paused PR waits without ready, arm, merge, or disarm", kind: "pr", status: "paused", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Paused = true
			x.view("p", open(), passed)
			return "p"
		}},
		{name: "merged predecessor restacks a stale stacked base (B1)", kind: "pr", status: "green", row: "P7",
			modes: map[string]string{operator.MergeModeStackedPRs: "B1"}, statuses: map[string]string{operator.MergeModeStackedPRs: "stale-base"}, build: func(x *fx, m string) string {
				p1 := x.pr("p1", m)
				now := fxNow.Format(time.RFC3339)
				p1.DoneAt = &now
				x.pr("p2", m, "p1")
				pf := x.view("p2", open(), passed)
				pf.hasPred, pf.ancestor = true, false
				return "p2"
			}},
		{name: "stale base without a predecessor escalates once (B2)", kind: "pr", status: "green", row: "P7",
			modes: map[string]string{operator.MergeModeStackedPRs: "B2"}, statuses: map[string]string{operator.MergeModeStackedPRs: "stale-base"}, build: func(x *fx, m string) string {
				x.pr("p", m)
				pf := x.view("p", open(), passed)
				pf.base = "feature-x"
				return "p"
			}},
		{name: "stale base without a predecessor waits after escalating", kind: "pr", status: "green", row: "P7",
			modes: map[string]string{operator.MergeModeStackedPRs: ""}, statuses: map[string]string{operator.MergeModeStackedPRs: "stale-base"}, build: func(x *fx, m string) string {
				it := x.pr("p", m)
				pf := x.view("p", open(), passed)
				pf.base = "feature-x"
				key, _ := staleBaseText(&ruleCtx{it: *it, f: x.f})
				it.Scope[scopeEscalated] = map[string]interface{}{key: "x"}
				return "p"
			}},
		{name: "unreadable stacked stale-base facts wait and never merge", kind: "pr", status: "green", row: "P7",
			modes: map[string]string{operator.MergeModeStackedPRs: ""}, statuses: map[string]string{operator.MergeModeStackedPRs: "waiting"}, build: func(x *fx, m string) string {
				x.pr("p", m)
				pf := x.view("p", open(), passed)
				pf.staleRead = false
				return "p"
			}},
		{name: "removed PR projection escalates once (X0)", kind: "pr", status: "waiting", row: "X0", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeProjected] = true
			return "p"
		}},
		{name: "removed projection of a merged PR is routine cleanup", kind: "pr", status: "merged", row: "", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			now := fxNow.Format(time.RFC3339)
			it.DoneAt = &now
			it.Scope[scopeProjected] = true
			return "p"
		}},
		{name: "unwritten PR projection is repaired (X1)", kind: "pr", status: "waiting", row: "X1", build: func(x *fx, m string) string {
			it := x.pr("p", m)
			it.Scope[scopeProjected] = false
			return "p"
		}},
	}
}

func fixRuleCases() []ruleCase {
	passed := checkRun{Name: "ci", State: "SUCCESS"}
	pending := checkRun{Name: "ci", State: "PENDING"}
	return []ruleCase{
		{name: "fix with a missing parent is untracked (F1)", kind: "fix", status: "resolved", row: "F1", build: func(x *fx, m string) string {
			x.fix("ab12-fix")
			return "ab12-fix"
		}},
		{name: "fix with a merged parent is untracked (F1)", kind: "fix", status: "resolved", row: "F1", build: func(x *fx, m string) string {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", m)
			x.view("p", prView{State: "MERGED"})
			return "ab12-fix"
		}},
		{name: "fix with a halted parent is untracked (F1)", kind: "fix", status: "resolved", row: "F1", build: func(x *fx, m string) string {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", m).Scope[scopeHalted] = true
			return "ab12-fix"
		}},
		{name: "fix with a green new parent head is untracked (F1)", kind: "fix", status: "resolved", row: "F1", build: func(x *fx, m string) string {
			x.fix("ab12-fix")
			x.fixParentFor("ab12-fix", m)
			x.view("p", open(), passed)
			return "ab12-fix"
		}},
		{name: "fix spawn without its pane escalates (F2)", kind: "fix", status: "spawn-unknown", row: "F2", build: func(x *fx, m string) string {
			fix := x.fix("ab12-fix")
			fix.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			x.fixParentFor("ab12-fix", m)
			x.view("p", open(), pending)
			return "ab12-fix"
		}},
		{name: "fix spawn already escalated waits", kind: "fix", status: "spawn-unknown", row: "", build: func(x *fx, m string) string {
			fix := x.fix("ab12-fix")
			fix.Scope[scopeSpawning] = "2026-01-01T00:00:00Z"
			key, _ := fixSpawnInterruptedText(&ruleCtx{it: *fix})
			fix.Scope[scopeEscalated] = map[string]interface{}{key: "x"}
			x.fixParentFor("ab12-fix", m)
			x.view("p", open(), pending)
			return "ab12-fix"
		}},
		{name: "working fix waits even with a dead pane", kind: "fix", status: "working", row: "", build: func(x *fx, m string) string {
			fix := x.fix("ab12-fix")
			x.pane(fix, false)
			x.fixParentFor("ab12-fix", m)
			x.view("p", open(), pending)
			return "ab12-fix"
		}},
	}
}

func TestDecideTable(t *testing.T) {
	cases := append(append(queueRuleCases(), prRuleCases()...), fixRuleCases()...)
	fired := map[string]bool{}
	seen := map[string]bool{} // kind/mode/status
	for _, c := range cases {
		for _, mode := range fxModes {
			name := c.name + " [" + mode + "]"
			t.Run(name, func(t *testing.T) {
				x := newFx(t)
				id := c.build(x, mode)
				d := x.outcome(id)
				want := rowFor(c, mode)
				if d.Row != want {
					t.Fatalf("row = %q (%s), want %q", d.Row, d.Action, want)
				}
				if wantStatus := statusFor(c, mode); d.Status != wantStatus {
					t.Fatalf("status = %q, want %q", d.Status, wantStatus)
				}
				if d.Row == rowUnmatched {
					t.Fatalf("a reachable combination has no row and no declared wait: %+v", d)
				}
				if wantAction := actionFor(want); d.Action != wantAction {
					t.Fatalf("action = %q, want %q", d.Action, wantAction)
				}
				if want != "" {
					fired[want] = true
				}
				seen[c.kind+"/"+mode+"/"+d.Status] = true
			})
		}
	}
	// Every row of the table fires in some case, and every (kind, mode, status)
	// was exercised: a row or status added without a case fails here.
	for _, r := range ruleTable {
		if !fired[r.id] {
			t.Errorf("row %s is never exercised by the table test", r.id)
		}
	}
	for _, mode := range fxModes {
		for _, s := range allQueueStatuses {
			if !seen["queue/"+mode+"/"+string(s)] {
				t.Errorf("queue/%s/%s is not covered", mode, s)
			}
		}
		for _, s := range allPRStatuses {
			key := "pr/" + mode + "/" + string(s)
			if s == PRStaleBase && mode != operator.MergeModeStackedPRs {
				if seen[key] {
					t.Errorf("non-stacked mode %s derived stale-base", mode)
				}
				continue
			}
			if !seen[key] {
				t.Errorf("%s is not covered", key)
			}
		}
		for _, s := range allFixStatuses {
			if !seen["fix/"+mode+"/"+string(s)] {
				t.Errorf("fix/%s/%s is not covered", mode, s)
			}
		}
	}
}

func TestRuleTableShape(t *testing.T) {
	var ids []string
	for _, r := range ruleTable {
		ids = append(ids, r.id)
	}
	want := []string{"X0", "X0", "X1", "X1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6a", "Q7", "Q6b", "P1", "P2", "P3", "B1", "B2", "P4", "C1", "C2", "C3", "C4", "C5", "C6", "P6", "P7", "F1", "F2"}
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
		has := waitDeclared(kindQueue, s, "")
		for _, r := range ruleTable {
			if r.kind == kindQueue && (r.queue == s || (r.queue == "" && s != QueueDone)) {
				has = true
			}
		}
		if !has {
			t.Errorf("queue status %s has neither a row nor a declared wait", s)
		}
	}
	for _, s := range allPRStatuses {
		has := waitDeclared(kindPR, "", s)
		for _, r := range ruleTable {
			if r.kind == kindPR && r.pr == s {
				has = true
			}
		}
		if !has {
			t.Errorf("PR status %s has neither a row nor a declared wait", s)
		}
	}
	for _, s := range allFixStatuses {
		has := waitDeclared(kindFix, "", "", s)
		for _, r := range ruleTable {
			if r.kind == kindFix && r.fix == s {
				has = true
			}
		}
		if !has {
			t.Errorf("fix status %s has neither a row nor a declared wait", s)
		}
	}
	// A status with a row whose guard can fail must also declare its wait, so
	// the fall-through is intentional. Rows that are complementary pairs (Q4/Q5,
	// Q2) and unconditional rows (P2) need none.
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
	x.pr("p", operator.MergeModeCherryPickLadder)
	x.view("p", open(), checkRun{Name: "ci", State: "PENDING"})
	before := fmt.Sprintf("%+v|%+v", x.items, x.f.pr)
	first := decide(x.state(), x.f, fxNow)
	second := decide(x.state(), x.f, fxNow)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("decide is not deterministic:\n%+v\n%+v", first, second)
	}
	if after := fmt.Sprintf("%+v|%+v", x.items, x.f.pr); before != after {
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
	x.pr("p1", operator.MergeModeCherryPickLadder)
	x.queue("a", operator.MergeModeCherryPickLadder, "b")
	var got []string
	for _, d := range decide(x.state(), x.f, fxNow) {
		got = append(got, d.Item)
	}
	if strings.Join(got, ",") != "b,p1,a" {
		t.Fatalf("decision order = %v, want ledger order b,p1,a", got)
	}
}
