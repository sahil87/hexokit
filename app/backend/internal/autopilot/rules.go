package autopilot

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"rk/internal/operator"
)

const (
	// slowStage and slowQueue flag a stage or a whole queue that has run long;
	// they only escalate, never act.
	slowStage      = 30 * time.Minute
	slowQueue      = 2 * time.Hour
	recoveryWindow = 30 * time.Minute
)

// ActionKind is one typed action of the fixed vocabulary. The empty kind is a
// wait.
type ActionKind string

const (
	ActionWait          ActionKind = ""
	ActionRecordDone    ActionKind = "record-done"
	ActionSpawn         ActionKind = "spawn"
	ActionRespawn       ActionKind = "respawn"
	ActionSkip          ActionKind = "skip"
	ActionEscalate      ActionKind = "escalate"
	ActionTrackPR       ActionKind = "track-pr"
	ActionRecordMerged  ActionKind = "record-merged"
	ActionHalt          ActionKind = "halt"
	ActionDisarm        ActionKind = "disarm"
	ActionReady         ActionKind = "ready"
	ActionArm           ActionKind = "arm"
	ActionMerge         ActionKind = "merge"
	ActionReProject     ActionKind = "re-project"
	ActionFixRequest    ActionKind = "fix-request"
	ActionRecoverySpawn ActionKind = "recovery-spawn"
	ActionRebase        ActionKind = "rebase"
	ActionUntrack       ActionKind = "untrack"
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
	// Status is the item's derived queue, PR, or fix status.
	Status string
	// Reason is the escalation or halt text of the row.
	Reason string
	// Key is the scope.escalated dedupe key of an escalate-once row.
	Key string
	// fp fingerprints the item's decision inputs at observe time; an executor
	// skips the item when it no longer matches.
	fp string
	// pr marks a PR item decision (its skip text names it).
	pr bool
}

type itemKind int

const (
	kindQueue itemKind = iota + 1
	kindPR
	kindFix
)

// ruleCtx is one item's view for the guards: the snapshot, the facts, the
// clock and the item's derived mode.
type ruleCtx struct {
	st     *operator.State
	f      *facts
	now    time.Time
	it     operator.TrackedItem
	mode   string
	oldest string
}

// rule is one row of the table. status "" on a queue row matches every status
// but done. guard nil is always true. text, when set, builds the escalation
// reason and dedupe key of an escalate row.
type rule struct {
	id     string
	kind   itemKind
	queue  QueueStatus
	pr     PRStatus
	fix    FixStatus
	all    bool
	guard  func(c *ruleCtx) bool
	action ActionKind
	text   func(c *ruleCtx) (key, reason string)
}

func (r rule) matches(c *ruleCtx, kind itemKind, queue QueueStatus, pr PRStatus, fix FixStatus) bool {
	if r.kind != kind {
		return false
	}
	if r.all {
		return r.guard == nil || r.guard(c)
	}
	switch kind {
	case kindQueue:
		if r.queue == "" && queue == QueueDone {
			return false
		}
		if r.queue != "" && r.queue != queue {
			return false
		}
	case kindPR:
		if r.pr != pr {
			return false
		}
	case kindFix:
		if r.fix != fix {
			return false
		}
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

func escalatedAlready(c *ruleCtx, key string) bool { return escalatedSeen(c.it, key) }

func stacked(c *ruleCtx) bool { return c.mode == operator.MergeModeStackedPRs }

func prFactsOf(c *ruleCtx) *prFacts { return c.f.pr[c.it.ID] }

func armedFact(c *ruleCtx) bool { return prFactsOf(c).armed() }

func projectionRemoved(c *ruleCtx) bool {
	return scopeBool(c.it, scopeProjected) && !c.f.projection[c.it.ID]
}

func needsProjection(c *ruleCtx) bool {
	projected, recorded := c.it.Scope[scopeProjected]
	if !recorded || scopeBool(c.it, scopeProjected) || projected == nil || c.f.projection[c.it.ID] {
		return false
	}
	return c.it.Kind == operator.KindGitHubPR || operator.ScopeString(c.it.Scope, "pane") != ""
}

func projectionRemovedText(c *ruleCtx) (string, string) {
	reason := "projection removed: " + c.it.ID
	return escalationKey(reason), reason
}

func removedProjectionGuard(c *ruleCtx) bool {
	key, _ := projectionRemovedText(c)
	done := (c.it.Kind == operator.KindPane && deriveQueue(c.st, c.f, c.it) == QueueDone) ||
		(c.it.Kind == operator.KindGitHubPR && derivePR(c.st, c.f, c.it) == PRMerged)
	return !done && projectionRemoved(c) && !escalatedAlready(c, key)
}

func upstreamMerged(c *ruleCtx) bool {
	for _, id := range c.it.DependsOn {
		i := operator.IndexOf(c.st.Tracked, id)
		if i >= 0 && (operator.ItemDone(c.st.Tracked[i]) || observedMerged(c.f, id)) {
			return true
		}
	}
	return false
}

func restackGuard(c *ruleCtx) bool {
	key, _ := restackText(c)
	status := derivePR(c.st, c.f, c.it)
	active := status != PRMerged && status != PRClosed && status != PRHalted && status != PRPaused
	return active && stacked(c) && upstreamMerged(c) && !escalatedAlready(c, key)
}

func restackText(c *ruleCtx) (string, string) {
	reason := fmt.Sprintf("restack needed: PR #%s", prNum(c.it.Scope))
	return escalationKey(reason), reason
}

// repoAllowsAutoMerge is P6's fact guard: the repo's setting was read and the
// PR's required checks were too, so an arm never rests on an unread check.
func repoAllowsAutoMerge(c *ruleCtx) bool {
	pf := prFactsOf(c)
	return pf != nil && pf.checksRead && c.f.autoMerge[pinnedRepo(c.it)]
}

func spawnInterruptedText(c *ruleCtx) (string, string) {
	reason := fmt.Sprintf("spawn interrupted: %s — check for an orphaned window before resuming or removing the queue item", c.it.ID)
	return escalationKey(reason), reason
}

func slowStageText(c *ruleCtx) (string, string) {
	reason := fmt.Sprintf("stage %s over %s without moving", stageLabel(c.it), slowStage)
	return escalationKey(reason), reason
}

func slowQueueText(*ruleCtx) (string, string) {
	reason := fmt.Sprintf("queue open for over %s", slowQueue)
	return escalationKey(reason), reason
}

func ageOver(stamp string, now time.Time, limit time.Duration) bool {
	t, err := time.Parse(time.RFC3339, stamp)
	return err == nil && now.Sub(t) > limit
}

func slowStageGuard(c *ruleCtx) bool {
	key, _ := slowStageText(c)
	return ageOver(c.it.UpdatedAt, c.now, slowStage) && !escalatedAlready(c, key)
}

func slowQueueGuard(c *ruleCtx) bool {
	key, _ := slowQueueText(c)
	return c.it.ID == c.oldest && ageOver(c.it.AddedAt, c.now, slowQueue) && !escalatedAlready(c, key)
}

func hasPRItem(st *operator.State, id string) bool {
	for _, p := range st.Tracked {
		if isPRItem(p) && operator.ScopeString(p.Scope, scopeItem) == id {
			return true
		}
	}
	return false
}

func trackPRGuard(c *ruleCtx) bool {
	return c.mode == operator.MergeModeMergeAuto && !isBare(c.it) && operator.ItemDone(c.it) && !scopeBool(c.it, scopePRDropped) && !hasPRItem(c.st, c.it.ID)
}

// mergeGuard is P7's: a green, unarmed, non-stacked PR whose observed head is
// known, because the merge is pinned to that commit.
func mergeGuard(c *ruleCtx) bool {
	pf := prFactsOf(c)
	return !stacked(c) && !armedFact(c) && pf != nil && pf.view.HeadRefOid != ""
}

func closedHaltText(c *ruleCtx) (string, string) {
	return "", fmt.Sprintf("PR #%s was closed without merging", prNum(c.it.Scope))
}

func noPushHaltGuard(c *ruleCtx) bool {
	return ageOver(operator.ScopeString(c.it.Scope, scopeRecoverAt), c.now, recoveryWindow)
}

func noPushHaltText(c *ruleCtx) (string, string) {
	return "", fmt.Sprintf("no new push %s after the CI fix request — PR #%s", recoveryWindow, prNum(c.it.Scope))
}

func authoringRecoveryGuard(spawn bool) func(c *ruleCtx) bool {
	return func(c *ruleCtx) bool {
		if roundSpent(c.it, recoveryCIFix) {
			return false
		}
		pane, idle, known := authoringPane(c.st, c.f, c.it)
		if !known {
			return false
		}
		if spawn {
			return pane == ""
		}
		return pane != "" && idle
	}
}

func failedAfterFixText(c *ruleCtx) (string, string) {
	name, head := "(unknown)", ""
	if pf := prFactsOf(c); pf != nil {
		head = short(pf.view.HeadRefOid)
		if failed := firstFailed(pf.checks); failed != nil {
			name = failed.Name
		}
	}
	return "", fmt.Sprintf("CI still failing on check %s after the fix round (new head %s) — PR #%s", name, head, prNum(c.it.Scope))
}

func conflictingAgainText(c *ruleCtx) (string, string) {
	return "", fmt.Sprintf("PR #%s is CONFLICTING again after the rebase recovery", prNum(c.it.Scope))
}

func fixSpawnInterruptedText(c *ruleCtx) (string, string) {
	reason := fmt.Sprintf("spawn interrupted: %s — check for an orphaned recovery window before untracking the fix item", c.it.ID)
	return escalationKey(reason), reason
}

func short(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

// ruleTable is the whole of autopilot behaviour. Rows are tried in order and
// the first match wins, at most one per item. Rows act only on the status
// they name; every other (item, status) is a wait (waitTable). Q5's escalation
// is part of its skip executor.
var ruleTable = []rule{
	{id: "X0", kind: kindQueue, all: true, guard: removedProjectionGuard, action: ActionEscalate, text: projectionRemovedText},
	{id: "X0", kind: kindPR, all: true, guard: removedProjectionGuard, action: ActionEscalate, text: projectionRemovedText},
	{id: "X1", kind: kindQueue, all: true, guard: needsProjection, action: ActionReProject},
	{id: "X1", kind: kindPR, all: true, guard: needsProjection, action: ActionReProject},
	{id: "Q1", kind: kindQueue, queue: QueueDone, guard: doneAtUnset, action: ActionRecordDone},
	{id: "Q2", kind: kindQueue, queue: QueuePending, action: ActionSpawn},
	{id: "Q3", kind: kindQueue, queue: QueueSpawnUnknown, action: ActionEscalate, text: spawnInterruptedText,
		guard: func(c *ruleCtx) bool { key, _ := spawnInterruptedText(c); return !escalatedAlready(c, key) }},
	{id: "Q4", kind: kindQueue, queue: QueueDead, guard: func(c *ruleCtx) bool { return !scopeBool(c.it, scopeRespawned) }, action: ActionRespawn},
	{id: "Q5", kind: kindQueue, queue: QueueDead, guard: func(c *ruleCtx) bool { return scopeBool(c.it, scopeRespawned) }, action: ActionSkip},
	{id: "Q6a", kind: kindQueue, queue: QueueSpawned, guard: slowStageGuard, action: ActionEscalate, text: slowStageText},
	{id: "Q7", kind: kindQueue, queue: QueueDone, guard: trackPRGuard, action: ActionTrackPR},
	{id: "Q6b", kind: kindQueue, guard: slowQueueGuard, action: ActionEscalate, text: slowQueueText},

	{id: "P1", kind: kindPR, pr: PRMerged, guard: doneAtUnset, action: ActionRecordMerged},
	{id: "P2", kind: kindPR, pr: PRClosed, action: ActionHalt, text: closedHaltText},
	{id: "P3", kind: kindPR, pr: PRHalted, guard: armedFact, action: ActionDisarm},
	{id: "B0", kind: kindPR, all: true, guard: restackGuard, action: ActionEscalate, text: restackText},
	{id: "P4", kind: kindPR, pr: PRDraft, guard: func(c *ruleCtx) bool { return !stacked(c) }, action: ActionReady},
	{id: "C1", kind: kindPR, pr: PRFixing, guard: noPushHaltGuard, action: ActionHalt, text: noPushHaltText},
	{id: "C2", kind: kindPR, pr: PRFailed, guard: authoringRecoveryGuard(false), action: ActionFixRequest},
	{id: "C3", kind: kindPR, pr: PRFailed, guard: authoringRecoveryGuard(true), action: ActionRecoverySpawn},
	{id: "C4", kind: kindPR, pr: PRFailed, guard: func(c *ruleCtx) bool { return roundSpent(c.it, recoveryCIFix) }, action: ActionHalt, text: failedAfterFixText},
	{id: "C5", kind: kindPR, pr: PRConflicting, guard: func(c *ruleCtx) bool { return !stacked(c) && !roundSpent(c.it, recoveryRebase) }, action: ActionRebase},
	{id: "C6", kind: kindPR, pr: PRConflicting, guard: func(c *ruleCtx) bool { return !stacked(c) && roundSpent(c.it, recoveryRebase) }, action: ActionHalt, text: conflictingAgainText},
	{id: "P6", kind: kindPR, pr: PRWaiting, guard: func(c *ruleCtx) bool { return !stacked(c) && !armedFact(c) && repoAllowsAutoMerge(c) }, action: ActionArm},
	{id: "P7", kind: kindPR, pr: PRGreen, guard: mergeGuard, action: ActionMerge},
	{id: "F1", kind: kindFix, fix: FixResolved, action: ActionUntrack},
	{id: "F2", kind: kindFix, fix: FixSpawnUnknown, action: ActionEscalate, text: fixSpawnInterruptedText,
		guard: func(c *ruleCtx) bool { key, _ := fixSpawnInterruptedText(c); return !escalatedAlready(c, key) }},
}

// wait is an explicit non-action: the (item kind, status) the table leaves to
// a later pass, and why.
type wait struct {
	kind   itemKind
	queue  QueueStatus
	pr     PRStatus
	fix    FixStatus
	reason string
}

// waitTable names every (kind, status) whose rows can all be guarded out, so
// the outcome of an unmatched combination is a declared wait and not an
// accident. A status absent here must have an unconditional row.
var waitTable = []wait{
	{kind: kindQueue, queue: QueueDone, reason: "recorded; nothing left to track"},
	{kind: kindQueue, queue: QueuePaused, reason: "paused by the user or by stop"},
	{kind: kindQueue, queue: QueueSkipped, reason: "skipped after its one respawn; dependents stay held"},
	{kind: kindQueue, queue: QueueHeld, reason: "a dependency is not satisfied"},
	{kind: kindQueue, queue: QueueSpawnUnknown, reason: "spawn interrupted, already escalated"},
	{kind: kindQueue, queue: QueueSpawned, reason: "the agent is working"},
	{kind: kindPR, pr: PRMerged, reason: "recorded"},
	{kind: kindPR, pr: PRPaused, reason: "paused by the user"},
	{kind: kindPR, pr: PRHalted, reason: "halted and not armed"},
	{kind: kindPR, pr: PRDeferred, reason: "its repo's merge has not started"},
	{kind: kindPR, pr: PRBlocked, reason: "an upstream PR has not merged"},
	{kind: kindPR, pr: PRDraft, reason: "stacked-prs: merged by R6b"},
	{kind: kindPR, pr: PRFixing, reason: "CI fix round in progress"},
	{kind: kindPR, pr: PRFailed, reason: "authoring agent busy, or pane snapshot unknown"},
	{kind: kindPR, pr: PRConflicting, reason: "stacked-prs: rebase is R6b's restack"},
	{kind: kindPR, pr: PRGreen, reason: "armed (GitHub merges it), or its head commit is unknown"},
	{kind: kindPR, pr: PRWaiting, reason: "checks pending, armed, or the repo has no auto-merge"},
	{kind: kindFix, fix: FixSpawnUnknown, reason: "spawn interrupted, already escalated"},
	{kind: kindFix, fix: FixWorking, reason: "the recovery agent is working"},
}

func waitDeclared(kind itemKind, queue QueueStatus, pr PRStatus, fixes ...FixStatus) bool {
	var fix FixStatus
	if len(fixes) > 0 {
		fix = fixes[0]
	}
	for _, w := range waitTable {
		if w.kind == kind && w.queue == queue && w.pr == pr && w.fix == fix {
			return true
		}
	}
	return false
}

// decide is the rule table applied to one snapshot: at most one decision per
// engine item, in engine order. It is a pure function of (state, facts, now).
func decide(st *operator.State, f *facts, now time.Time) []Decision {
	c := &ruleCtx{st: st, f: f, now: now, oldest: oldestUnfinished(st, f)}
	var out []Decision
	for _, it := range st.Tracked {
		c.it, c.mode = it, modeOf(it)
		switch {
		case legacyQueueItem(st, it):
			out = append(out, decideItem(c, kindQueue, deriveQueue(st, f, it), "", ""))
		case isSeqPR(it):
			out = append(out, decideItem(c, kindPR, "", derivePR(st, f, it), ""))
		case it.Kind == "fix":
			out = append(out, decideItem(c, kindFix, "", "", deriveFix(st, f, it)))
		}
	}
	return out
}

func decideItem(c *ruleCtx, kind itemKind, queue QueueStatus, pr PRStatus, fix FixStatus) Decision {
	status := string(queue)
	if kind == kindPR {
		status = string(pr)
	} else if kind == kindFix {
		status = string(fix)
	}
	d := Decision{Item: c.it.ID, Status: status, fp: fingerprint(c.it), pr: kind == kindPR}
	for _, r := range ruleTable {
		if !r.matches(c, kind, queue, pr, fix) {
			continue
		}
		d.Row, d.Action = r.id, r.action
		if r.text != nil {
			d.Key, d.Reason = r.text(c)
		}
		return d
	}
	if !waitDeclared(kind, queue, pr, fix) {
		d.Row = rowUnmatched
	}
	return d
}

// oldestUnfinished is the first-added queue item that is not done, the one Q6b
// reports a queue open too long on ("" when none).
func oldestUnfinished(st *operator.State, f *facts) string {
	var oldest time.Time
	id := ""
	for _, it := range st.Tracked {
		if !legacyQueueItem(st, it) || deriveQueue(st, f, it) == QueueDone {
			continue
		}
		if t, err := time.Parse(time.RFC3339, it.AddedAt); err == nil && (oldest.IsZero() || t.Before(oldest)) {
			oldest, id = t, it.ID
		}
	}
	return id
}

func stageLabel(it operator.TrackedItem) string {
	if s := operator.ScopeString(it.Scope, "stage"); s != "" {
		return s
	}
	return "(unknown)"
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
