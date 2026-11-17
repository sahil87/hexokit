package operatorloop

import (
	"strings"
	"time"

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
			if hasUserInstruction(it.Notes) {
				add(it.ID, "new user or chat note")
			}
		}
	}
	return out
}

func reasonNeedsJudgment(reason string, item operator.TrackedItem, owned bool) bool {
	kind := reason
	if fields := strings.Fields(reason); len(fields) > 0 {
		kind = fields[0]
	}
	switch kind {
	case operator.DeltaAgentState:
		return strings.HasSuffix(reason, "→waiting") || strings.HasSuffix(reason, "→idle")
	case operator.DeltaAgentAged, operator.DeltaDue, operator.DeltaStale, operator.DeltaPaused, operator.DeltaUnknownDep:
		return true
	case operator.DeltaDone:
		return item.Then != nil && strings.TrimSpace(*item.Then) != ""
	case operator.DeltaPaneDeath, operator.DeltaPaneMismatch, operator.DeltaAgentExited:
		return !owned
	}
	return false
}

func hasUserInstruction(notes []operator.Note) bool {
	var latestInstruction, latestRun time.Time
	for _, note := range notes {
		at, err := time.Parse(time.RFC3339, note.At)
		if err != nil {
			continue
		}
		switch note.By {
		case operator.ByUser, operator.ByChat:
			if at.After(latestInstruction) {
				latestInstruction = at
			}
		case operator.ByRun:
			if at.After(latestRun) {
				latestRun = at
			}
		}
	}
	return !latestInstruction.IsZero() && (latestRun.IsZero() || latestInstruction.After(latestRun))
}
