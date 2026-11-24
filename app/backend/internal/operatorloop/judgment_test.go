package operatorloop

import (
	"reflect"
	"testing"

	"rk/internal/operator"
)

func TestJudgmentSetReasonKinds(t *testing.T) {
	then := "continue"
	state := &operator.State{Tracked: []operator.TrackedItem{
		{ID: "item", Then: &then},
		{ID: "without-then"},
		{ID: "pr", Kind: operator.KindGitHubPR},
		{ID: "pane", Kind: operator.KindPane},
	}}
	cases := []struct {
		name, reason, id string
		owned, want      bool
	}{
		{"agent waiting", "agent_state active→waiting", "item", false, true},
		{"agent idle", "agent_state active→idle", "item", false, true},
		{"agent active", "agent_state waiting→active", "item", false, false},
		{"agent aged idle", "agent_aged idle 31m", "item", false, true},
		{"agent aged waiting on engine work", "agent_aged waiting 45m", "item", true, true},
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
		{"unanswered note", "note 2026-11-20T10:00:00Z", "item", false, true},
		{"unanswered note on engine work", "note 2026-11-20T10:00:00Z", "item", true, true},
		{"PR changed on a non-PR item", "changed state", "item", false, false},
		{"changed on a github-pr item", "changed state", "pr", false, true},
		{"changed on a pane item", "changed state", "pane", false, false},
		{"done on a github-pr item without then", "done", "pr", false, true},
		{"done on a pane item without then", "done", "pane", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := judgmentSet([]ChangeRecord{{ID: tc.id, Reasons: []string{tc.reason}}}, nil, state, map[string]bool{tc.id: tc.owned})
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

// reasonFor renders the agent_aged delta as `agent_aged <state> <duration>`,
// the form the brief rules and the judgment set both read.
func TestReasonForAgentAged(t *testing.T) {
	idle, dur := "idle", "31m"
	cases := []struct {
		d    operator.CheckDelta
		want string
	}{
		{operator.CheckDelta{Kind: operator.DeltaAgentAged, To: &idle, Duration: &dur}, "agent_aged idle 31m"},
		{operator.CheckDelta{Kind: operator.DeltaAgentAged, To: &idle}, "agent_aged idle"},
	}
	for _, tc := range cases {
		if got := reasonFor(tc.d); got != tc.want {
			t.Errorf("reasonFor(%+v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}

// TestJudgmentSetListsAnUnansweredNoteOnce: a `note` change record puts the item
// in the set with its own reason, and the pending-instruction scan adds no
// second one; an item whose note was reported by an earlier fire still gets the
// scan's reason.
func TestJudgmentSetListsAnUnansweredNoteOnce(t *testing.T) {
	state := &operator.State{Tracked: []operator.TrackedItem{
		{ID: "x", Notes: []operator.Note{{At: "2026-11-20T10:00:00Z", By: operator.ByUser, Text: "look"}}},
		{ID: "y", Notes: []operator.Note{{At: "2026-11-20T10:00:00Z", By: operator.ByChat, Text: "look"}}},
	}}
	got := judgmentSet([]ChangeRecord{{ID: "x", Reasons: []string{"note 2026-11-20T10:00:00Z"}}}, nil, state, nil)
	want := []operator.ChangedItem{
		{ID: "x", Reasons: []string{"note 2026-11-20T10:00:00Z"}},
		{ID: "y", Reasons: []string{pendingNoteReason}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("judgment = %+v, want %+v", got, want)
	}
}

func TestReasonForNote(t *testing.T) {
	d := operator.CheckDelta{Kind: operator.DeltaNote, ID: "x", At: "2026-11-20T10:00:00Z"}
	if got := reasonFor(d); got != "note 2026-11-20T10:00:00Z" {
		t.Errorf("reasonFor = %q", got)
	}
}

func TestReasonForFailed(t *testing.T) {
	d := operator.CheckDelta{Kind: operator.DeltaFailed, ID: "x", At: "2026-11-23T19:19:00Z"}
	if got := reasonFor(d); got != "failed 2026-11-23T19:19:00Z" {
		t.Errorf("reasonFor = %q", got)
	}
}

// A failed run on an engine-owned queue item is still the run's to retry, so
// the reason enters the judgment set whoever owns the item.
func TestJudgmentSetCarriesAFailedReasonForOwnedAndUnownedItems(t *testing.T) {
	reason := "failed 2026-11-23T19:19:00Z"
	got := judgmentSet(
		[]ChangeRecord{{ID: "owned", Reasons: []string{reason}}, {ID: "free", Reasons: []string{reason}}},
		nil, &operator.State{}, map[string]bool{"owned": true})
	want := []operator.ChangedItem{
		{ID: "owned", Reasons: []string{reason}},
		{ID: "free", Reasons: []string{reason}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("judgment = %+v, want %+v", got, want)
	}
}
