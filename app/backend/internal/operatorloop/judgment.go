package operatorloop

import (
	"strings"

	"rk/internal/operator"
)

// judgmentSet is the pure selection of items that need a model run after the
// mechanical pass. Input order is preserved and each id appears once.
func judgmentSet(changes []ChangeRecord, pass *PassRecord, state *operator.State, engineOwned map[string]bool) []operator.ChangedItem {
	var out []operator.ChangedItem
	pos := map[string]int{}
	add := func(id, reason string) {
		if id == "" {
			return
		}
		i, ok := pos[id]
		if !ok {
			i = len(out)
			pos[id] = i
			out = append(out, operator.ChangedItem{ID: id})
		}
		if reason != "" {
			out[i].Reasons = append(out[i].Reasons, reason)
		}
	}
	items := map[string]operator.TrackedItem{}
	if state != nil {
		for _, it := range state.Tracked {
			items[it.ID] = it
		}
	}
	for _, change := range changes {
		for _, reason := range change.Reasons {
			if reasonNeedsJudgment(reason, items[change.ID], engineOwned[change.ID]) {
				add(change.ID, reason)
			}
		}
	}
	if pass != nil {
		for _, id := range pass.Escalations {
			add(id, "mechanical pass escalation")
		}
	}
	if state != nil {
		for _, it := range state.Tracked {
			if _, pending := operator.PendingInstruction(it.Notes); pending && !hasReasonKind(out, pos, it.ID, operator.DeltaNote) {
				add(it.ID, pendingNoteReason)
			}
		}
	}
	return out
}

// pendingNoteReason covers an unanswered instruction whose `note` condition an
// earlier fire already reported, so this run's change records do not carry it.
const pendingNoteReason = "new user or chat note"

// hasReasonKind reports whether the item already carries a reason of the kind.
func hasReasonKind(out []operator.ChangedItem, pos map[string]int, id, kind string) bool {
	i, ok := pos[id]
	if !ok {
		return false
	}
	for _, reason := range out[i].Reasons {
		if reasonKind(reason) == kind {
			return true
		}
	}
	return false
}

// reasonKind is the delta kind a rendered reason (`<kind>[ <detail>]`) opens with.
func reasonKind(reason string) string {
	if fields := strings.Fields(reason); len(fields) > 0 {
		return fields[0]
	}
	return reason
}

func reasonNeedsJudgment(reason string, item operator.TrackedItem, owned bool) bool {
	switch reasonKind(reason) {
	case operator.DeltaAgentState:
		return strings.HasSuffix(reason, "→waiting") || strings.HasSuffix(reason, "→idle")
	case operator.DeltaAgentAged, operator.DeltaDue, operator.DeltaStale, operator.DeltaPaused, operator.DeltaUnknownDep, operator.DeltaNote:
		return true
	case operator.DeltaDone:
		return item.Then != nil && strings.TrimSpace(*item.Then) != ""
	case operator.DeltaPaneDeath, operator.DeltaPaneMismatch, operator.DeltaAgentExited:
		return !owned
	}
	return false
}
