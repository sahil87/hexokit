package autopilot

import (
	"strings"

	"rk/internal/operator"
	"rk/internal/tmux"
)

// QueueStatus is a queue item's derived status, never stored: every pass
// derives it from durable intent plus observed facts.
type QueueStatus string

// Queue statuses in precedence order (first match wins).
const (
	QueueDone         QueueStatus = "done"
	QueuePaused       QueueStatus = "paused"
	QueueSkipped      QueueStatus = "skipped"
	QueueHeld         QueueStatus = "held"
	QueuePending      QueueStatus = "pending"
	QueueSpawnUnknown QueueStatus = "spawn-unknown"
	QueueSpawned      QueueStatus = "spawned"
	QueueDead         QueueStatus = "dead"
)

var allQueueStatuses = []QueueStatus{
	QueueDone, QueuePaused, QueueSkipped, QueueHeld, QueuePending, QueueSpawnUnknown, QueueSpawned, QueueDead,
}

// PRStatus is a merge-sequence PR item's derived status.
type PRStatus string

// PR statuses in precedence order (first match wins).
const (
	PRMerged      PRStatus = "merged"
	PRPaused      PRStatus = "paused"
	PRHalted      PRStatus = "halted"
	PRClosed      PRStatus = "closed"
	PRDeferred    PRStatus = "deferred"
	PRBlocked     PRStatus = "blocked"
	PRDraft       PRStatus = "draft"
	PRFixing      PRStatus = "fixing"
	PRFailed      PRStatus = "failed"
	PRConflicting PRStatus = "conflicting"
	PRGreen       PRStatus = "green"
	PRWaiting     PRStatus = "waiting"
)

var allPRStatuses = []PRStatus{
	PRMerged, PRPaused, PRHalted, PRClosed, PRDeferred, PRBlocked, PRDraft, PRFixing, PRFailed, PRConflicting, PRGreen, PRWaiting,
}

// FixStatus is a recovery-spawn item's derived status.
type FixStatus string

const (
	FixResolved     FixStatus = "resolved"
	FixSpawnUnknown FixStatus = "spawn-unknown"
	FixWorking      FixStatus = "working"
)

var allFixStatuses = []FixStatus{FixResolved, FixSpawnUnknown, FixWorking}

// facts is everything observe read from outside the ledger. A zero value is a
// valid "nothing known" snapshot, which derive reads as waiting/unknown.
type facts struct {
	// panes is rk's pane snapshot; panesKnown is false when it could not be
	// taken (the read-only status view), and every recorded pane then reads as
	// alive.
	panes      map[string]operator.PaneInfo
	panesKnown bool
	queue      map[string]*queueFacts
	pr         map[string]*prFacts
	projection map[string]bool
	// autoMerge is the repos' autoMergeAllowed, keyed by owner/name; a repo
	// that could not be read is absent.
	autoMerge map[string]bool
}

func newFacts() *facts {
	return &facts{
		panes: map[string]operator.PaneInfo{}, panesKnown: true,
		queue: map[string]*queueFacts{}, pr: map[string]*prFacts{}, autoMerge: map[string]bool{}, projection: map[string]bool{},
	}
}

// queueFacts are the externally observed inputs of one queue item.
type queueFacts struct {
	// completed: the pane's change reached its terminus (or stop_stage), or a
	// plain agent's branch PR is merged or ready.
	completed bool
	// depPR records, per same-repo dependency id, whether its PR exists.
	depPR map[string]bool
}

// prFacts are the externally observed inputs of one PR item.
type prFacts struct {
	// read is false when the PR could not be viewed.
	read       bool
	view       prView
	checks     []checkRun
	checksRead bool
}

func (f *facts) queueFor(id string) *queueFacts {
	q := f.queue[id]
	if q == nil {
		q = &queueFacts{depPR: map[string]bool{}}
		f.queue[id] = q
	}
	return q
}

func (f *facts) paneAlive(pane string) bool {
	if pane == "" {
		return false
	}
	if !f.panesKnown {
		return true
	}
	_, ok := f.panes[pane]
	return ok
}

// armed is derived from the PR's autoMergeRequest, never stored.
func (p *prFacts) armed() bool { return p != nil && p.read && p.view.AutoMergeRequest != nil }

// itemDone reports whether the item is done now: its stored done_at, or, for a
// queue item, a completion observed this pass.
func itemDone(st *operator.State, f *facts, it operator.TrackedItem) bool {
	if operator.ItemDone(it) {
		return true
	}
	if q := f.queue[it.ID]; q != nil && q.completed && legacyQueueItem(st, it) {
		return true
	}
	return false
}

// unmetDep returns the first dependency that keeps the item held ("" when all
// are satisfied): not done; in merge-auto a dependency whose PR item has not
// merged; or a same-repo dependency without stop_stage that has no PR. A
// dependency surviving only in branch_map is satisfied. exists answers the PR
// lookup: derive reads the observed fact, observe performs the read.
func unmetDep(st *operator.State, f *facts, it operator.TrackedItem, exists func(dep operator.TrackedItem, branch string) bool) string {
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	for _, dep := range it.DependsOn {
		di := operator.IndexOf(st.Tracked, dep)
		if di < 0 {
			if _, ok := st.BranchMap[dep]; ok {
				continue
			}
			return dep
		}
		d := st.Tracked[di]
		if !itemDone(st, f, d) {
			return dep
		}
		if mergeAutoBarrier(st, it, d) {
			if !prMerged(st, d.ID) {
				return dep
			}
			continue
		}
		if cleanRepo(depRepo(st, d)) != repo || operator.ScopeString(d.Scope, "stop_stage") != "" {
			continue
		}
		if !exists(d, depBranch(st, d)) {
			return dep + " (no PR yet)"
		}
	}
	return ""
}

// deriveQueue is the queue status table: done › paused › skipped › held ›
// pending › spawn-unknown › spawned › dead.
func deriveQueue(st *operator.State, f *facts, it operator.TrackedItem) QueueStatus {
	switch {
	case itemDone(st, f, it):
		return QueueDone
	case it.Paused:
		return QueuePaused
	case skipped(it):
		return QueueSkipped
	}
	if len(it.DependsOn) > 0 {
		var depPR map[string]bool
		if q := f.queue[it.ID]; q != nil {
			depPR = q.depPR
		}
		if unmetDep(st, f, it, func(d operator.TrackedItem, branch string) bool { return branch != "" && depPR[d.ID] }) != "" {
			return QueueHeld
		}
	}
	pane := operator.ScopeString(it.Scope, "pane")
	alive := f.paneAlive(pane)
	switch {
	case pane == "" && !spawningSet(it):
		return QueuePending
	case spawningSet(it) && !alive:
		return QueueSpawnUnknown
	case alive:
		return QueueSpawned
	}
	return QueueDead
}

// haltedCone reports whether the item is halted: stored `halted` on it or on
// any not-done item it transitively depends_on. The cone is derived, so
// clearing `halted` on the one item that carries it resumes everything
// downstream. An upstream that is merged (stored done_at, or MERGED observed
// this pass) holds nothing back, so a stale `halted` on a hand-merged PR does
// not propagate. f may be nil: observe asks for the superset of items that may
// need reading before any fact exists.
func haltedCone(st *operator.State, f *facts, it operator.TrackedItem) bool {
	seen := map[string]bool{}
	var visit func(x operator.TrackedItem) bool
	visit = func(x operator.TrackedItem) bool {
		if seen[x.ID] || operator.ItemDone(x) || observedMerged(f, x.ID) {
			return false
		}
		seen[x.ID] = true
		if scopeBool(x, scopeHalted) {
			return true
		}
		for _, d := range x.DependsOn {
			if i := operator.IndexOf(st.Tracked, d); i >= 0 && visit(st.Tracked[i]) {
				return true
			}
		}
		return false
	}
	return visit(it)
}

func observedMerged(f *facts, id string) bool {
	if f == nil {
		return false
	}
	pf := f.pr[id]
	return pf != nil && pf.read && strings.EqualFold(pf.view.State, "MERGED")
}

// blockedByDeps reports whether a PR item still waits on another item (the
// previous PR of its repo, or a cross-repo barrier). Only a recorded merge
// unblocks it, so a successor acts one pass after its predecessor's P1. A
// dependency that names no ledger item blocks too: its predecessor never
// merged, so the successor must not act.
func blockedByDeps(st *operator.State, it operator.TrackedItem) bool {
	for _, d := range it.DependsOn {
		if i := operator.IndexOf(st.Tracked, d); i < 0 || !operator.ItemDone(st.Tracked[i]) {
			return true
		}
	}
	return false
}

// prPrecheck derives the statuses that need no check facts: merged › halted ›
// closed › deferred › blocked › (unread →) waiting › draft › fixing. ok is false
// when the item reaches the check-based statuses, which tells observe to read them.
func prPrecheck(st *operator.State, f *facts, it operator.TrackedItem) (status PRStatus, ok bool) {
	pf := f.pr[it.ID]
	state := ""
	if pf != nil && pf.read {
		state = strings.ToUpper(pf.view.State)
	}
	switch {
	case state == "MERGED" || operator.ItemDone(it):
		return PRMerged, true
	case it.Paused:
		return PRPaused, true
	case haltedCone(st, f, it):
		return PRHalted, true
	case state == "CLOSED":
		return PRClosed, true
	case scopeBool(it, scopeDeferred):
		return PRDeferred, true
	case blockedByDeps(st, it):
		return PRBlocked, true
	case pf == nil || !pf.read:
		return PRWaiting, true
	case pf.view.IsDraft:
		return PRDraft, true
	case roundSpent(it, recoveryCIFix) && pf.view.HeadRefOid != "" && pf.view.HeadRefOid == operator.ScopeString(it.Scope, scopeFixHead):
		return PRFixing, true
	}
	return "", false
}

// derivePR is the PR status table: merged › halted › closed › deferred ›
// blocked › draft › fixing › failed › conflicting › green › waiting.
func derivePR(st *operator.State, f *facts, it operator.TrackedItem) PRStatus {
	if s, ok := prPrecheck(st, f, it); ok {
		return s
	}
	pf := f.pr[it.ID]
	if !pf.checksRead {
		return PRWaiting
	}
	switch {
	case firstFailed(pf.checks) != nil:
		return PRFailed
	case strings.EqualFold(pf.view.Mergeable, "CONFLICTING") && it.Unchanged >= stallUnchanged:
		return PRConflicting
	case !checksPending(pf.checks) && strings.EqualFold(pf.view.Mergeable, "MERGEABLE"):
		return PRGreen
	}
	return PRWaiting
}

// deriveFix resolves recovery agents from their parent PR, never queue membership.
func deriveFix(st *operator.State, f *facts, it operator.TrackedItem) FixStatus {
	parent, ok := fixParent(st, it.ID)
	if !ok {
		return FixResolved
	}
	parentStatus := derivePR(st, f, *parent)
	if parentStatus == PRMerged || parentStatus == PRHalted {
		return FixResolved
	}
	if parentStatus == PRGreen {
		pf := f.pr[parent.ID]
		if pf != nil && pf.read && pf.view.HeadRefOid != operator.ScopeString(parent.Scope, scopeFixHead) {
			return FixResolved
		}
	}
	pane := operator.ScopeString(it.Scope, "pane")
	if spawningSet(it) && !f.paneAlive(pane) {
		return FixSpawnUnknown
	}
	return FixWorking
}

// authoringPane finds the lowest matching live pane and whether its agent is idle.
// known is false only when the whole snapshot is unavailable.
func authoringPane(st *operator.State, f *facts, it operator.TrackedItem) (pane string, idle, known bool) {
	if !f.panesKnown {
		return "", false, false
	}
	change := operator.ScopeString(it.Scope, "change")
	if change == "" {
		if i := operator.IndexOf(st.Tracked, operator.ScopeString(it.Scope, scopeItem)); i >= 0 {
			pane = operator.ScopeString(st.Tracked[i].Scope, "pane")
			info, alive := f.panes[pane]
			if alive {
				return pane, paneIdle(info), true
			}
		}
		return "", false, true
	}
	for id, info := range f.panes {
		if info.Change != "" && changeMatches(info.Change, change) && (pane == "" || id < pane) {
			pane = id
		}
	}
	if pane == "" {
		return "", false, true
	}
	return pane, paneIdle(f.panes[pane]), true
}

func paneIdle(info operator.PaneInfo) bool {
	return info.AgentState != tmux.AgentStateActive && info.AgentState != tmux.AgentStateWaiting
}

// changeMatches compares a derived change folder with a full folder or its id segment.
func changeMatches(derived, change string) bool {
	return derived == change || strings.Contains("-"+derived+"-", "-"+change+"-")
}
