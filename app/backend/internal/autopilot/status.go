package autopilot

import "rk/internal/operator"

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

// facts is everything observe read from outside the ledger. A zero value is a
// valid "nothing known" snapshot, which derive reads as waiting/unknown.
type facts struct {
	// panes is rk's pane snapshot; panesKnown is false when it could not be
	// taken (the read-only status view), and every recorded pane then reads as
	// alive.
	panes      map[string]operator.PaneInfo
	panesKnown bool
	queue      map[string]*queueFacts
	projection map[string]bool
}

func newFacts() *facts {
	return &facts{
		panes: map[string]operator.PaneInfo{}, panesKnown: true,
		queue: map[string]*queueFacts{}, projection: map[string]bool{},
	}
}

// queueFacts are the externally observed inputs of one queue item.
type queueFacts struct {
	// completed: the pane's change reached its terminus (or stop_stage), or a
	// plain agent's branch PR is merged or ready.
	completed bool
	// depPR records, per same-repo dependency id, whether its PR exists.
	depPR map[string]bool
	// depMerged records, per merge-auto barrier dependency id, whether its
	// branch's PR reads MERGED this pass.
	depMerged map[string]bool
}

func (f *facts) queueFor(id string) *queueFacts {
	q := f.queue[id]
	if q == nil {
		q = &queueFacts{depPR: map[string]bool{}, depMerged: map[string]bool{}}
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
// are satisfied): not done; in merge-auto a dependency whose branch PR has not
// merged; or a same-repo dependency without stop_stage that has no PR. A
// dependency surviving only in branch_map is satisfied. exists and merged answer
// the PR lookups: derive reads the observed facts, observe performs the reads.
func unmetDep(st *operator.State, f *facts, it operator.TrackedItem, exists, merged func(dep operator.TrackedItem, branch string) bool) string {
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
			if !merged(d, depBranch(st, d)) {
				return dep + " (PR not merged)"
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
		var q queueFacts
		if observed := f.queue[it.ID]; observed != nil {
			q = *observed
		}
		held := unmetDep(st, f, it,
			func(d operator.TrackedItem, branch string) bool { return branch != "" && q.depPR[d.ID] },
			func(d operator.TrackedItem, branch string) bool { return branch != "" && q.depMerged[d.ID] })
		if held != "" {
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
