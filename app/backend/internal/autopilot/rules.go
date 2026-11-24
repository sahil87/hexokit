package autopilot

import (
	"encoding/json"
	"fmt"
	"strings"

	"rk/internal/operator"
)

// ActionKind is one typed action of the fixed vocabulary. The empty kind is a
// wait.
type ActionKind string

const (
	ActionWait       ActionKind = ""
	ActionRecordDone ActionKind = "record-done"
	ActionSpawn      ActionKind = "spawn"
	ActionRespawn    ActionKind = "respawn"
	ActionSkip       ActionKind = "skip"
	ActionEscalate   ActionKind = "escalate"
	ActionReProject  ActionKind = "re-project"
)

// rowUnmatched marks a reachable combination that has neither a row nor an
// explicit wait. Nothing acts on it; the table test fails on it.
const rowUnmatched = "unmatched"

// Decision is what one item does this pass: the row that fired and its typed
// action, or a wait (Action == ActionWait).
type Decision struct {
	Item   string
	Row    string
	Action ActionKind
	// Status is the item's derived queue status.
	Status string
	// Reason is the escalation text of the row.
	Reason string
	// Key is the scope.escalated dedupe key of an escalate-once row.
	Key string
	// fp fingerprints the item's decision inputs at observe time; an executor
	// skips the item when it no longer matches.
	fp string
}

// ruleCtx is one item's view for the guards: the snapshot, the facts and the
// item.
type ruleCtx struct {
	st *operator.State
	f  *facts
	it operator.TrackedItem
}

// rule is one row of the table. queue "" on a row matches every status but
// done. guard nil is always true. text, when set, builds the escalation reason
// and dedupe key of an escalate row.
type rule struct {
	id     string
	queue  QueueStatus
	all    bool
	guard  func(c *ruleCtx) bool
	action ActionKind
	text   func(c *ruleCtx) (key, reason string)
}

func (r rule) matches(c *ruleCtx, queue QueueStatus) bool {
	if r.all {
		return r.guard == nil || r.guard(c)
	}
	if r.queue == "" && queue == QueueDone {
		return false
	}
	if r.queue != "" && r.queue != queue {
		return false
	}
	return r.guard == nil || r.guard(c)
}

func doneAtUnset(c *ruleCtx) bool {
	marker, present := c.it.Scope[scopeEngineDone]
	if !present {
		return !operator.ItemDone(c.it)
	}
	switch value := marker.(type) {
	case nil:
		return true
	case string:
		return value == ""
	case *string:
		return value == nil || *value == ""
	}
	return false
}

// needsPRTrack reports a merge-auto item whose PR has not been handled yet.
// Every other mode records done and tracks nothing: merges there are the
// user's word.
func needsPRTrack(c *ruleCtx) bool {
	return modeOf(c.it) == operator.MergeModeMergeAuto && operator.ScopeString(c.it.Scope, scopePRTracked) == ""
}

func escalatedAlready(c *ruleCtx, key string) bool { return escalatedSeen(c.it, key) }

func projectionRemoved(c *ruleCtx) bool {
	return scopeBool(c.it, scopeProjected) && !c.f.projection[c.it.ID]
}

func needsProjection(c *ruleCtx) bool {
	projected, recorded := c.it.Scope[scopeProjected]
	if !recorded || scopeBool(c.it, scopeProjected) || projected == nil || c.f.projection[c.it.ID] {
		return false
	}
	return operator.ScopeString(c.it.Scope, "pane") != ""
}

func projectionRemovedText(c *ruleCtx) (string, string) {
	reason := "projection removed: " + c.it.ID
	return escalationKey(reason), reason
}

func removedProjectionGuard(c *ruleCtx) bool {
	key, _ := projectionRemovedText(c)
	done := deriveQueue(c.st, c.f, c.it) == QueueDone
	return !done && projectionRemoved(c) && !escalatedAlready(c, key)
}

func spawnInterruptedText(c *ruleCtx) (string, string) {
	reason := fmt.Sprintf("spawn interrupted: %s — check for an orphaned window before resuming or removing the queue item", c.it.ID)
	return escalationKey(reason), reason
}

// ruleTable is the whole of autopilot behaviour. Rows are tried in order and
// the first match wins, at most one per item. Rows act only on the status
// they name; every other (item, status) is a wait (waitTable). Q5's escalation
// is part of its skip executor. Q1 matches a done item until its done_at is
// written, and a merge-auto item again until its PR is tracked.
var ruleTable = []rule{
	{id: "X0", all: true, guard: removedProjectionGuard, action: ActionEscalate, text: projectionRemovedText},
	{id: "X1", all: true, guard: needsProjection, action: ActionReProject},
	{id: "Q1", queue: QueueDone, guard: func(c *ruleCtx) bool { return doneAtUnset(c) || needsPRTrack(c) }, action: ActionRecordDone},
	{id: "Q2", queue: QueuePending, action: ActionSpawn},
	{id: "Q3", queue: QueueSpawnUnknown, action: ActionEscalate, text: spawnInterruptedText,
		guard: func(c *ruleCtx) bool { key, _ := spawnInterruptedText(c); return !escalatedAlready(c, key) }},
	{id: "Q4", queue: QueueDead, guard: func(c *ruleCtx) bool { return !scopeBool(c.it, scopeRespawned) }, action: ActionRespawn},
	{id: "Q5", queue: QueueDead, guard: func(c *ruleCtx) bool { return scopeBool(c.it, scopeRespawned) }, action: ActionSkip},
}

// wait is an explicit non-action: the queue status the table leaves to a later
// pass, and why.
type wait struct {
	queue  QueueStatus
	reason string
}

// waitTable names every status whose rows can all be guarded out, so the
// outcome of an unmatched combination is a declared wait and not an accident. A
// status absent here must have an unconditional row.
var waitTable = []wait{
	{queue: QueueDone, reason: "recorded, and any merge-auto PR tracked; nothing left to track"},
	{queue: QueuePaused, reason: "paused by the user or by stop"},
	{queue: QueueSkipped, reason: "skipped after its one respawn; dependents stay held"},
	{queue: QueueHeld, reason: "a dependency is not satisfied"},
	{queue: QueueSpawnUnknown, reason: "spawn interrupted, already escalated"},
	{queue: QueueSpawned, reason: "the agent is working"},
}

func waitDeclared(queue QueueStatus) bool {
	for _, w := range waitTable {
		if w.queue == queue {
			return true
		}
	}
	return false
}

// decide is the rule table applied to one snapshot: at most one decision per
// engine item, in engine order. It is a pure function of (state, facts).
func decide(st *operator.State, f *facts) []Decision {
	c := &ruleCtx{st: st, f: f}
	var out []Decision
	for _, it := range st.Tracked {
		if !legacyQueueItem(st, it) {
			continue
		}
		c.it = it
		out = append(out, decideItem(c, deriveQueue(st, f, it)))
	}
	return out
}

func decideItem(c *ruleCtx, queue QueueStatus) Decision {
	d := Decision{Item: c.it.ID, Status: string(queue), fp: fingerprint(c.it)}
	for _, r := range ruleTable {
		if !r.matches(c, queue) {
			continue
		}
		d.Row, d.Action = r.id, r.action
		if r.text != nil {
			d.Key, d.Reason = r.text(c)
		}
		return d
	}
	if !waitDeclared(queue) {
		d.Row = rowUnmatched
	}
	return d
}

// volatileScope are the check-owned keys an external writer rewrites without
// changing what an action would do.
var volatileScope = map[string]bool{"stage": true, "agent": true, "pane_pid": true, scopeEscalated: true}

// fingerprint serialises an item's decision inputs: identity, probe, edges,
// stops and every scope key an executor reads. It leaves out the clocks and
// counters an observation or a check rewrites (updated_at, last, unchanged,
// checked_at, failures, seen, notes), so observe's own writes never invalidate
// a decision.
func fingerprint(it operator.TrackedItem) string {
	scope := make(map[string]interface{}, len(it.Scope))
	for k, v := range it.Scope {
		if !volatileScope[k] {
			scope[k] = v
		}
	}
	b, err := json.Marshal(struct {
		ID, Kind  string
		Probe     operator.ProbeSpec
		DependsOn []string
		Scope     map[string]interface{}
		Paused    bool
		DoneAt    string
	}{it.ID, it.Kind, it.Probe, it.DependsOn, scope, it.Paused, strings.TrimSpace(derefString(it.DoneAt))})
	if err != nil {
		return fmt.Sprintf("%#v", scope)
	}
	return string(b)
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
