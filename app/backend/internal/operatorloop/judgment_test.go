package operatorloop

import (
	"reflect"
	"testing"

	"rk/internal/operator"
)

func TestJudgmentSetReasonKinds(t *testing.T) {
	then := "continue"
	state := &operator.State{Tracked: []operator.TrackedItem{{ID: "item", Then: &then}, {ID: "without-then"}}}
	cases := []struct {
		name, reason, id string
		owned, want      bool
	}{
		{"agent waiting", "agent_state active→waiting", "item", false, true},
		{"agent idle", "agent_state active→idle", "item", false, true},
		{"agent active", "agent_state waiting→active", "item", false, false},
		{"due", "due 5m", "item", false, true},
		{"stale", "stale 2h", "item", false, true},
		{"paused", "paused exit 1", "item", false, true},
		{"unknown dep", "unknown_dep dep", "item", false, true},
		{"done with then", "done", "item", false, true},
		{"done without then", "done", "without-then", false, false},
		{"pane death unowned", "pane_death", "item", false, true},
		{"pane death owned", "pane_death", "item", true, false},
		{"pane mismatch owned", "pane_mismatch", "item", true, false},
		{"agent exited owned", "agent_exited", "item", true, false},
		{"stage advance", "stage_advance apply→review", "item", false, false},
		{"review failure", "review_fail review→apply", "item", false, false},
		{"PR changed", "changed state", "item", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := judgmentSet([]ChangeRecord{{ID: tc.id, Reasons: []string{tc.reason}}}, nil, state, map[string]bool{"item": tc.owned})
			if (len(got) == 1) != tc.want {
				t.Fatalf("judgment = %+v, want %v", got, tc.want)
			}
		})
	}
}

func TestJudgmentSetAddsEscalationsAndNewInstructionsOnce(t *testing.T) {
	then := ""
	state := &operator.State{Tracked: []operator.TrackedItem{
		{ID: "a", Then: &then, Notes: []operator.Note{
			{At: "2026-11-16T10:00:00Z", By: operator.ByUser, Text: "older"},
			{At: "2026-11-16T11:00:00Z", By: operator.ByRun, Text: "handled"},
		}},
		{ID: "b", Notes: []operator.Note{
			{At: "2026-11-16T10:00:00Z", By: operator.ByRun, Text: "older"},
			{At: "2026-11-16T11:00:00Z", By: operator.ByChat, Text: "new instruction"},
		}},
		{ID: "c", Notes: []operator.Note{{At: "2026-11-16T11:00:00Z", By: operator.ByUser, Text: "ask"}}},
	}}
	got := judgmentSet(
		[]ChangeRecord{{ID: "a", Reasons: []string{"done"}}, {ID: "c", Reasons: []string{"stage_advance apply→review"}}},
		&PassRecord{Escalations: []string{"a", "c", "missing"}}, state, map[string]bool{"a": true, "c": true})
	var ids []string
	for _, item := range got {
		ids = append(ids, item.ID)
	}
	want := []string{"a", "c", "missing", "b"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
}

func TestJudgmentSetEmptyForMechanicalChanges(t *testing.T) {
	got := judgmentSet([]ChangeRecord{
		{ID: "a1", Reasons: []string{"stage_advance apply→review"}},
		{ID: "pr-41", Reasons: []string{"changed state"}},
		{ID: "a1", Reasons: []string{"pane_death", "done"}},
	}, nil, &operator.State{}, map[string]bool{"a1": true, "pr-41": true})
	if len(got) != 0 {
		t.Fatalf("mechanical changes entered judgment set: %+v", got)
	}
}
