package operator

import (
	"time"
)

// Condition keys: the strings stored in TrackedItem.Reported. due@ and
// unknown_dep: are prefixes completed with the base timestamp / dependency id.
const (
	condDone             = "done"
	condPaneDeath        = "pane_death"
	condPaneMismatch     = "pane_mismatch"
	condAgentExited      = "agent_exited"
	condAgentWaiting     = "agent:waiting"
	condAgentIdle        = "agent:idle"
	condPaused           = "paused"
	condStale            = "stale"
	condDuePrefix        = "due@"
	condUnknownDepPrefix = "unknown_dep:"
)

// condDelta is one standing condition with the delta that reports it.
type condDelta struct {
	key   string
	delta CheckDelta
}

// paneConditionKeys filters keys down to the ones a pane diff produces.
func paneConditionKeys(keys []string) []string {
	var out []string
	for _, k := range keys {
		switch k {
		case condPaneDeath, condPaneMismatch, condAgentExited, condAgentWaiting, condAgentIdle:
			out = append(out, k)
		}
	}
	return out
}

// openDelta is the delta as listed once its condition is already reported.
// An agent_state transition has no "from" once the baseline equals the
// observed state.
func (c condDelta) openDelta() CheckDelta {
	d := c.delta
	if d.Kind == DeltaAgentState {
		d.From = nil
	}
	return d
}

// itemConditions derives the item's current condition set, in emission order.
// A done item is inert beyond done and unknown dependencies; a paused item
// reports only the failure-cap pause; the rest carries its pane conditions and
// the agent-item due/stale conditions.
func itemConditions(items []TrackedItem, it TrackedItem, pane []condDelta, now time.Time) []condDelta {
	conds := unknownDepConditions(items, it)
	switch {
	case itemDone(it):
		return append(conds, condDelta{condDone, CheckDelta{Kind: DeltaDone, ID: it.ID, Then: it.Then}})
	case it.Paused:
		if it.Failures >= failurePauseCap {
			conds = append(conds, condDelta{condPaused, CheckDelta{
				Kind: DeltaPaused, ID: it.ID, Error: pausedErrorText(it.Failures),
				Failures: it.Failures, Paused: true,
			}})
		}
		return conds
	}
	conds = append(conds, pane...)
	return append(conds, agentItemConditions(it, now)...)
}

func unknownDepConditions(items []TrackedItem, it TrackedItem) []condDelta {
	var conds []condDelta
	for _, dep := range it.DependsOn {
		if indexOf(items, dep) < 0 {
			conds = append(conds, condDelta{condUnknownDepPrefix + dep, CheckDelta{Kind: DeltaUnknownDep, ID: it.ID, Dep: dep}})
		}
	}
	return conds
}

// agentItemConditions covers linear/slack items, which Check never queries:
// stale past twice check_every, and due once check_every has passed since the
// last check (added_at when never checked). The due key carries the base
// timestamp, so it fires once per due period and again after the next observe.
func agentItemConditions(it TrackedItem, now time.Time) []condDelta {
	if it.Probe.Mode != probeAgent {
		return nil
	}
	base := agentBase(it)
	age := checkAge(base, now)
	var conds []condDelta
	if itemStale(it, now) {
		conds = append(conds, condDelta{condStale, CheckDelta{Kind: DeltaStale, ID: it.ID, Age: age}})
	}
	if cadenceElapsed(it, base, now) {
		conds = append(conds, condDelta{condDuePrefix + base, CheckDelta{
			Kind: DeltaDue, ID: it.ID, Age: age, Instruction: it.Probe.Instruction,
		}})
	}
	return conds
}

func agentBase(it TrackedItem) string {
	if it.CheckedAt != nil && *it.CheckedAt != "" {
		return *it.CheckedAt
	}
	return it.AddedAt
}

// checkAge renders the age since base for the stale/due delta.
func checkAge(base string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, base)
	if err != nil {
		return formatAge(0)
	}
	return formatAge(now.Sub(t))
}
