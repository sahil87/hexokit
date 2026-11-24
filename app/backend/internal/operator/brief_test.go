package operator

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const (
	briefFixturePath = "testdata/brief_state.yaml"
	briefGoldenPath  = "testdata/brief_golden.md"
	updateGoldenEnv  = "UPDATE_GOLDEN"

	// rulesBudget bounds the embedded run rules.
	rulesBudget = 40960
)

var briefTestNow = time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)

var briefSectionHeadings = []string{
	"# Operator run brief",
	"## What changed",
	"## Affected items",
	"## Other tracked items",
	"## Rules",
	"## Exit contract",
}

func fixtureState(t *testing.T) *State {
	t.Helper()
	st, err := Load(briefFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func renderFixture(t *testing.T, changed ...ChangedItem) string {
	t.Helper()
	return RenderBrief(BriefInput{State: fixtureState(t), Server: "work", Now: briefTestNow, Changed: changed})
}

func briefTestItem(id, kind string, deps ...string) TrackedItem {
	it := TrackedItem{
		ID: id, Kind: kind, Probe: ProbeSpec{Mode: kinds[kind].defaultProbe},
		DependsOn: deps, AddedAt: briefTestNow.Format(time.RFC3339),
	}
	normalizeItem(&it)
	return it
}

func briefTestNotes(n, runes int) []Note {
	notes := make([]Note, n)
	for i := range notes {
		notes[i] = Note{
			At: briefTestNow.Add(time.Duration(i) * time.Minute).Format(time.RFC3339), By: ByRun,
			Text: fmt.Sprintf("note-%02d ", i) + strings.Repeat("x", runes),
		}
	}
	return notes
}

func sectionBody(t *testing.T, brief, heading string) string {
	t.Helper()
	start := strings.Index(brief, "\n"+heading+"\n")
	if start < 0 {
		t.Fatalf("heading %q missing", heading)
	}
	body := brief[start+len(heading)+2:]
	if end := strings.Index(body, "\n## "); end >= 0 {
		body = body[:end]
	}
	return body
}

func TestRenderBrief_SectionsOnceInOrder(t *testing.T) {
	out := renderFixture(t, ChangedItem{ID: "pr-1", Reasons: []string{"state: OPEN → MERGED"}})
	pos := -1
	for _, h := range briefSectionHeadings {
		if n := len(regexp.MustCompile("(?m)^"+regexp.QuoteMeta(h)+"$").FindAllString(out, -1)); n != 1 {
			t.Errorf("heading %q appears %d times, want 1", h, n)
		}
		i := strings.Index(out, h+"\n")
		if i <= pos {
			t.Errorf("heading %q out of order", h)
		}
		pos = i
	}
	for _, want := range []string{"- server: work", "- rendered: 2026-11-11T12:00:00Z", briefRoleLine} {
		if !strings.Contains(out, want) {
			t.Errorf("header missing %q", want)
		}
	}
}

func TestRenderBrief_WhatChangedRows(t *testing.T) {
	out := renderFixture(t,
		ChangedItem{ID: "pr-1", Reasons: []string{"merged", "ci-green"}},
		ChangedItem{ID: "zzz"},
		ChangedItem{ID: "remember"},
	)
	body := sectionBody(t, out, "## What changed")
	for _, want := range []string{
		"- pr-1 · github-pr · merged; ci-green\n",
		"- zzz · gone\n",
		"- remember · note · " + briefNoReasons + "\n",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("What changed missing %q in:\n%s", want, body)
		}
	}
}

func TestRenderBrief_EmptyChangedList(t *testing.T) {
	out := renderFixture(t)
	if body := sectionBody(t, out, "## What changed"); !strings.Contains(body, briefNoChangedLine) {
		t.Errorf("What changed = %q, want the %q line", body, briefNoChangedLine)
	}
	if body := sectionBody(t, out, "## Affected items"); !strings.Contains(body, "none") {
		t.Errorf("Affected items = %q, want none", body)
	}
}

func TestRenderBrief_AffectedIncludesNeighboursBothDirections(t *testing.T) {
	// pr-1 changed: w-2 depends on it (dependent neighbour).
	out := renderFixture(t, ChangedItem{ID: "pr-1"})
	affected := sectionBody(t, out, "## Affected items")
	for _, id := range []string{"### pr-1 (github-pr)", "### w-2 (pane)"} {
		if strings.Count(affected, id) != 1 {
			t.Errorf("Affected items should hold %q once:\n%s", id, affected)
		}
	}
	if !strings.Contains(affected, "- state: held") {
		t.Errorf("w-2 should read held while pr-1 is not done:\n%s", affected)
	}
	if strings.Contains(affected, "linear-bugs") {
		t.Error("unrelated item leaked into Affected items")
	}

	// w-2 changed: pr-1 is its dependency (dependency neighbour).
	out = renderFixture(t, ChangedItem{ID: "w-2"})
	affected = sectionBody(t, out, "## Affected items")
	if !strings.Contains(affected, "### pr-1 (github-pr)") || !strings.Contains(affected, "### w-2 (pane)") {
		t.Errorf("dependency neighbour missing:\n%s", affected)
	}
	// State-file order: pr-1 renders before w-2 even though w-2 was the change.
	if strings.Index(affected, "### pr-1") > strings.Index(affected, "### w-2") {
		t.Error("affected items are not in state-file order")
	}
}

func TestRenderBrief_AffectedBlockDetail(t *testing.T) {
	out := renderFixture(t, ChangedItem{ID: "pr-1"})
	affected := sectionBody(t, out, "## Affected items")
	for _, want := range []string{
		"- state: watching",
		"- probe: shell",
		"- check_every: 5m",
		`- done_when: state == "MERGED"`,
		"- then: arm next",
		"- depends_on: —",
		`- scope: pr: 1, repo: "/src/app"` + "\n", // the null change key is skipped
		`- last: mergeable: "MERGEABLE", mergedAt: null, state: "OPEN"`,
		"  - 2026-11-10T09:00:00Z · chat · hold this until the design review lands",
	} {
		if !strings.Contains(affected, want) {
			t.Errorf("block missing %q in:\n%s", want, affected)
		}
	}
}

func TestRenderBrief_MemoRendersOnItsOwnLine(t *testing.T) {
	st := fixtureState(t)
	idx := IndexOf(st.Tracked, "pr-1")
	st.Tracked[idx].Scope = mergeScope(st.Tracked[idx].Scope, map[string]interface{}{ScopeMemo: map[string]interface{}{"why": "waiting on design", "owner": "sam"}})
	out := RenderBrief(BriefInput{State: st, Server: "work", Now: briefTestNow, Changed: []ChangedItem{{ID: "pr-1"}}})
	affected := sectionBody(t, out, "## Affected items")
	for _, want := range []string{
		`- scope: pr: 1, repo: "/src/app"` + "\n",
		`- memo: owner: "sam", why: "waiting on design"` + "\n",
	} {
		if !strings.Contains(affected, want) {
			t.Errorf("block missing %q in:\n%s", want, affected)
		}
	}
}

func TestRenderBrief_OtherItemsAreOneLiners(t *testing.T) {
	out := renderFixture(t, ChangedItem{ID: "pr-1"})
	others := sectionBody(t, out, "## Other tracked items")
	for _, want := range []string{"- linear-bugs · linear · watching\n", "- remember · note · watching\n"} {
		if strings.Count(others, want) != 1 {
			t.Errorf("Other tracked items missing %q once:\n%s", want, others)
		}
	}
	if strings.Contains(others, "pr-1") || strings.Contains(others, "w-2") {
		t.Errorf("affected items must not repeat under Other tracked items:\n%s", others)
	}
}

func TestRenderBrief_NotesCap(t *testing.T) {
	a := briefTestItem("a", KindTask)
	a.Notes = briefTestNotes(14, 5)
	out := RenderBrief(BriefInput{
		State: &State{Tracked: []TrackedItem{a}}, Now: briefTestNow, Changed: []ChangedItem{{ID: "a"}},
	})
	affected := sectionBody(t, out, "## Affected items")
	if !strings.Contains(affected, "(+4 earlier notes)") {
		t.Errorf("missing earlier-notes line:\n%s", affected)
	}
	for i := 0; i < 14; i++ {
		present := strings.Contains(affected, fmt.Sprintf("note-%02d ", i))
		if want := i >= 4; present != want {
			t.Errorf("note-%02d present=%v, want %v", i, present, want)
		}
	}
	if strings.Index(affected, "(+4 earlier notes)") > strings.Index(affected, "note-04 ") {
		t.Error("the earlier-notes line must precede the shown notes")
	}
}

func TestRenderBrief_NotesCapKeepsOlderUserAndChatNotes(t *testing.T) {
	a := briefTestItem("a", KindTask)
	a.Notes = briefTestNotes(14, 5)
	a.Notes[0].By = ByUser
	a.Notes[1].By = ByChat
	out := RenderBrief(BriefInput{
		State: &State{Tracked: []TrackedItem{a}}, Now: briefTestNow, Changed: []ChangedItem{{ID: "a"}},
	})
	affected := sectionBody(t, out, "## Affected items")
	if !strings.Contains(affected, "(+2 earlier notes)") {
		t.Errorf("earlier-notes line must count only the omitted notes:\n%s", affected)
	}
	last := -1
	for i := 0; i < 14; i++ {
		at := strings.Index(affected, fmt.Sprintf("note-%02d ", i))
		if want := i < 2 || i >= 4; (at >= 0) != want {
			t.Errorf("note-%02d present=%v, want %v", i, at >= 0, want)
		}
		if at >= 0 {
			if at < last {
				t.Errorf("note-%02d is out of chronological order", i)
			}
			last = at
		}
	}
}

func TestRenderBrief_SizeCapKeepsUserAndChatNotesUntilRunNotesAreGone(t *testing.T) {
	hub := briefTestItem("hub", KindTask)
	hub.Notes = briefTestNotes(14, 5)
	hub.Notes[0].By = ByUser
	hub.Notes[1].By = ByChat
	items := []TrackedItem{hub}
	for i := 0; i < 110; i++ {
		it := briefTestItem(fmt.Sprintf("dep-%02d", i), KindTask, "hub")
		it.Notes = briefTestNotes(10, 800)
		items = append(items, it)
	}
	out := RenderBrief(BriefInput{
		State: &State{Tracked: items}, Now: briefTestNow, Changed: []ChangedItem{{ID: "hub"}},
	})
	if len(out) > BriefSizeCap {
		t.Fatalf("brief is %d bytes, over the %d cap", len(out), BriefSizeCap)
	}
	hubBlock := sectionBody(t, out, "## Affected items")
	hubBlock = hubBlock[:strings.Index(hubBlock, "### dep-00")]
	if !strings.Contains(hubBlock, "note-00 ") || !strings.Contains(hubBlock, "note-01 ") {
		t.Errorf("user/chat notes trimmed while run notes remained elsewhere:\n%s", hubBlock)
	}
	if strings.Contains(hubBlock, "note-13 ") {
		t.Errorf("the run notes should have been trimmed first:\n%s", hubBlock)
	}
}

func TestRenderBrief_SizeCapDropsUserAndChatNotesOnlyAfterRunNotes(t *testing.T) {
	hub := briefTestItem("hub", KindTask)
	hub.Notes = briefTestNotes(60, 1500)
	for i := range hub.Notes {
		hub.Notes[i].By = ByUser
	}
	items := []TrackedItem{hub}
	for i := 0; i < 90; i++ {
		it := briefTestItem(fmt.Sprintf("dep-%02d", i), KindTask, "hub")
		it.Notes = briefTestNotes(10, 800)
		items = append(items, it)
	}
	out := RenderBrief(BriefInput{
		State: &State{Tracked: items}, Now: briefTestNow, Changed: []ChangedItem{{ID: "hub"}},
	})
	if len(out) > BriefSizeCap {
		t.Fatalf("brief is %d bytes, over the %d cap", len(out), BriefSizeCap)
	}
	if strings.Contains(out, "note-00 ") {
		t.Error("the oldest user note should drop first once run notes are exhausted")
	}
	if !strings.Contains(out, "note-59 ") {
		t.Error("the newest user note should survive the final pass")
	}
	if !strings.HasSuffix(out, BriefTruncationMarker+"\n") {
		t.Error("brief does not end with the truncation marker")
	}
}

func TestRenderBrief_SizeCapDropsOthersFirst(t *testing.T) {
	a := briefTestItem("a", KindTask)
	a.Notes = briefTestNotes(10, 5)
	items := []TrackedItem{a}
	for i := 0; len(items) < 4000; i++ {
		items = append(items, briefTestItem(fmt.Sprintf("other-%04d", i), KindTask))
	}
	out := RenderBrief(BriefInput{State: &State{Tracked: items}, Now: briefTestNow, Changed: []ChangedItem{{ID: "a"}}})

	if len(out) > BriefSizeCap {
		t.Fatalf("brief is %d bytes, over the %d cap", len(out), BriefSizeCap)
	}
	if !strings.HasSuffix(out, BriefTruncationMarker+"\n") {
		t.Error("brief does not end with the truncation marker")
	}
	if strings.Contains(out, "other-0001") {
		t.Error("other-items lines should be dropped first")
	}
	for i := 0; i < 10; i++ {
		if !strings.Contains(out, fmt.Sprintf("note-%02d ", i)) {
			t.Errorf("note-%02d trimmed although dropping other items sufficed", i)
		}
	}
}

func TestRenderBrief_SizeCapTrimsNotesOldestFirstAndKeepsRequiredSections(t *testing.T) {
	hub := briefTestItem("hub", KindTask)
	items := []TrackedItem{hub}
	for i := 0; i < 60; i++ {
		it := briefTestItem(fmt.Sprintf("dep-%02d", i), KindTask, "hub")
		it.Notes = briefTestNotes(10, 800)
		items = append(items, it)
	}
	for i := 0; i < 300; i++ {
		items = append(items, briefTestItem(fmt.Sprintf("other-%03d", i), KindTask))
	}
	out := RenderBrief(BriefInput{
		State: &State{Tracked: items}, Server: "work", Now: briefTestNow,
		Changed: []ChangedItem{{ID: "hub", Reasons: []string{"done"}}},
	})

	if len(out) > BriefSizeCap {
		t.Fatalf("brief is %d bytes, over the %d cap", len(out), BriefSizeCap)
	}
	if !strings.HasSuffix(out, BriefTruncationMarker+"\n") {
		t.Error("brief does not end with the truncation marker")
	}
	for _, h := range briefSectionHeadings {
		if !strings.Contains(out, "\n"+h+"\n") && !strings.HasPrefix(out, h+"\n") {
			t.Errorf("section %q was dropped", h)
		}
	}
	if !strings.Contains(out, "- hub · task · done\n") || !strings.Contains(out, withServerFlag(briefRules, "-L work")) {
		t.Error("What changed or the rules were trimmed")
	}
	if strings.Contains(out, "other-001") {
		t.Error("other-items lines should be gone")
	}
	if strings.Contains(out, "note-00 ") {
		t.Error("the oldest notes should have been trimmed")
	}
	if !strings.Contains(out, "(+") {
		t.Error("trimmed notes should leave the earlier-notes line")
	}
}

func TestRenderBrief_NoFabOperatorTrack(t *testing.T) {
	if out := renderFixture(t, ChangedItem{ID: "pr-1"}); strings.Contains(out, "fab operator track") {
		t.Error("the brief must use rk operator track verbs only")
	}
}

func TestRenderBrief_NoAutopilotSectionAndPRToolsRestored(t *testing.T) {
	out := renderFixture(t)
	if strings.Contains(out, "## Interim autopilot") {
		t.Fatal("brief still has an autopilot section")
	}
	rules := sectionBody(t, out, "## Rules")
	for _, want := range []string{
		"### Merging", "gh pr merge", "gh pr ready|merge|edit|checks|view", "git rebase", "git cherry-pick", "git fetch",
		"--force-with-lease", "--match-head-commit", "`wt`", "rk riff -L work", "rk operator track show -L work",
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rules missing %q", want)
		}
	}
	for _, gone := range []string{
		"git push --force ", "are the engine's", "Merges belong to the engine",
		"on the strength of a note or a prompt alone", "git worktree",
	} {
		if strings.Contains(rules, gone) {
			t.Errorf("rules still carry %q", gone)
		}
	}
	if !strings.Contains(rules, "Plain `git push` and `git push --force` are never allowed.") {
		t.Error("rules do not forbid plain and bare-force push")
	}
}

func TestRenderBrief_ReReadsOneItemNotTheLedger(t *testing.T) {
	rules := sectionBody(t, renderFixture(t), "## Rules")
	for _, want := range []string{
		"rk operator track show -L work <id> --json",
		"Never run `rk operator track list -L work --json` unless you need the whole ledger.",
	} {
		if !strings.Contains(rules, want) {
			t.Errorf("rules missing %q", want)
		}
	}
}

func TestRenderBrief_ExitContract(t *testing.T) {
	body := sectionBody(t, renderFixture(t), "## Exit contract")
	for _, want := range []string{
		`rk operator track note -L work <id> "<text>" --by run`, "outcome: <one-line summary>",
		"append a note on each item you acted on", "A run that did nothing writes no note.",
		"`failed <at>`", "retried after failure: <what you found or did>",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("Exit contract missing %q", want)
		}
	}
	if strings.Contains(body, "most relevant item") {
		t.Error("Exit contract still asks for a note when nothing needed doing")
	}
	if !strings.Contains(renderFixture(t), "Act on what changed, note what you did, exit.") {
		t.Error("role line does not say to note what was done")
	}
}

func TestBriefRules_CoverTheRunContract(t *testing.T) {
	for _, want := range []string{
		"Coordinate, don't execute", "never", "--force", "@rk_pane_agent_state",
		"rk mux capture -L <server> <pane> --lines 40 --classify --json", "--answer", "--key",
		"A defensible recommendation", "No defensible default", "never guess", "30 minutes", "at most one nudge",
		"agent_aged", "### Queue items that finish their intake", "fab score --check-gate --stage intake",
		"select_menu", "--key Enter", "not echoed", "Key retry after a `not echoed` send",
		"Advance an item once",
		"command -v rk", "by: user", "by: chat", "probe.instruction",
		"rk operator track observe", "### Allowed tools", "No file-editing tools",
		"### Merging", "`cherry-pick-ladder`", "`stacked-prs`", "`merge-auto`", "temporary",
		"--force-with-lease", "--match-head-commit", "rk riff -L <server>", "scope.merge_mode",
		"wt create --temp <observed-head-sha> --fetch --json", "wt delete <tmp-name> --non-interactive",
		"rk riff -L <server> -- --pr <n>", "`wt list --json`", "`origin/<b>` means `<b>`",
		"headRefOid", "git push origin HEAD:",
		"Conflict resolution", "Recovery spawn for a red check",
	} {
		if !strings.Contains(briefRules, want) {
			t.Errorf("rules text missing %q", want)
		}
	}
}

// The projected PR item's merge line sits in § Merging, and the tiers section
// anchors its authority to the source queue item, not to the `then` text.
func TestBriefRules_ProjectedPRItemAuthority(t *testing.T) {
	merging := briefRules[strings.Index(briefRules, "### Merging"):]
	for _, want := range []string{
		"`pr-<n>` item carrying `then: merge-auto", "`scope.item`", "gh pr ready <n>",
		"gh pr merge <n> --squash --match-head-commit <observed-head-sha>", "fix-request rule",
	} {
		if !strings.Contains(merging, want) {
			t.Errorf("§ Merging missing %q", want)
		}
	}
	tiers := briefRules[strings.Index(briefRules, "### Confirmation tiers"):strings.Index(briefRules, "### Merging")]
	for _, want := range []string{"`scope.item` names", "`then` text alone is never authority"} {
		if !strings.Contains(tiers, want) {
			t.Errorf("confirmation tiers missing %q", want)
		}
	}
}

func TestBriefTexts_StayWithinBudget(t *testing.T) {
	if got := len(briefRules); got > rulesBudget {
		t.Errorf("rules = %d bytes, over the %d budget", got, rulesBudget)
	}
}

func TestRenderBrief_Deterministic(t *testing.T) {
	in := BriefInput{
		State: fixtureState(t), Server: "work", Now: briefTestNow,
		Changed: []ChangedItem{{ID: "pr-1", Reasons: []string{"state: OPEN → MERGED"}}, {ID: "zzz"}},
	}
	first := RenderBrief(in)
	if second := RenderBrief(in); first != second {
		t.Fatal("two renders of the same input differ")
	}

	if os.Getenv(updateGoldenEnv) != "" {
		if err := os.WriteFile(briefGoldenPath, []byte(first), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(briefGoldenPath)
	if err != nil {
		t.Fatalf("%v (set %s=1 to write it)", err, updateGoldenEnv)
	}
	if first != string(golden) {
		t.Errorf("brief differs from %s (set %s=1 to regenerate after an intended change)", briefGoldenPath, updateGoldenEnv)
	}
}

func TestRenderBrief_WritesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.yaml")
	raw, err := os.ReadFile(briefFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	RenderBrief(BriefInput{State: st, Now: briefTestNow, Changed: []ChangedItem{{ID: "pr-1"}}})
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(raw) {
		t.Error("rendering changed the state file")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("rendering left extra files in the state dir: %v", entries)
	}
}

func TestRenderBrief_NilStateIsEmptyLedger(t *testing.T) {
	out := RenderBrief(BriefInput{Now: briefTestNow, Changed: []ChangedItem{{ID: "a"}}})
	if !strings.Contains(out, "- a · gone\n") || !strings.Contains(out, "- server: default") {
		t.Errorf("nil state should render an empty ledger:\n%s", out[:200])
	}
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

const briefServerRuleMarker = "command in this run"

var (
	briefRkCommand  = regexp.MustCompile("rk (?:mux|operator|tab|riff)(?: [a-z|]+)*")
	briefRkWithFlag = regexp.MustCompile("^rk (?:mux|operator|tab|riff)(?: [a-z|]+)*" + regexp.QuoteMeta(" "+briefServerFlag))
)

func renderedRunSections(t *testing.T, in BriefInput) string {
	t.Helper()
	out := RenderBrief(in)
	return sectionBody(t, out, "## Rules") + sectionBody(t, out, "## Exit contract")
}

func TestRenderBrief_EveryRkCommandCarriesTheServer(t *testing.T) {
	text := renderedRunSections(t, BriefInput{State: fixtureState(t), Server: "loom", Now: briefTestNow})
	if strings.Contains(text, briefServerFlag) {
		t.Errorf("the raw %q token survived rendering", briefServerFlag)
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, briefServerRuleMarker) {
			continue
		}
		for _, loc := range briefRkCommand.FindAllStringIndex(line, -1) {
			cmd := strings.Replace(line[loc[0]:], "-L loom", briefServerFlag, 1)
			if !briefRkWithFlag.MatchString(cmd) {
				t.Errorf("rk command without -L loom: %q in %q", line[loc[0]:], line)
			}
		}
	}
	if strings.Contains(text, "rk notify -L") {
		t.Error("rk notify must not carry -L")
	}
}

func TestRenderBrief_EmptyServerRendersDefault(t *testing.T) {
	text := renderedRunSections(t, BriefInput{State: fixtureState(t), Now: briefTestNow})
	if !strings.Contains(text, "rk mux capture -L default <pane>") || !strings.Contains(text, "rk operator track note -L default <id>") {
		t.Error("an empty server must render -L default")
	}
	if strings.Contains(text, briefServerFlag) {
		t.Errorf("the raw %q token survived rendering", briefServerFlag)
	}
}

func TestRenderBrief_RulesCarryTheAlwaysPassServerLine(t *testing.T) {
	body := sectionBody(t, renderFixture(t), "## Rules")
	if !strings.Contains(body, "passes `-L work`, exactly as written here. Never drop it or rely on `$TMUX`.") {
		t.Error("Rules missing the always-pass -L line")
	}
}

func TestRenderBrief_NotesAreNotSubstituted(t *testing.T) {
	st := fixtureState(t)
	st.Tracked[0].Notes = []Note{{At: briefTestNow.Format(time.RFC3339), By: "user", Text: "keep " + briefServerFlag + " verbatim"}}
	out := RenderBrief(BriefInput{State: st, Server: "work", Now: briefTestNow, Changed: []ChangedItem{{ID: st.Tracked[0].ID}}})
	if !strings.Contains(out, "keep "+briefServerFlag+" verbatim") {
		t.Error("note text was altered by the server substitution")
	}
}

// A queue entry renders as one `queue:` line at the top of the item's block,
// and only for items that have one.
func TestRenderBrief_QueueLine(t *testing.T) {
	st := &State{Tracked: []TrackedItem{briefTestItem("q1", "note"), briefTestItem("q2", "note"), briefTestItem("q3", "note"), briefTestItem("plain", "note")}}
	stop := "hydrate"
	out := RenderBrief(BriefInput{
		State: st, Server: "work", Now: briefTestNow,
		Changed: []ChangedItem{{ID: "q1"}, {ID: "q2"}, {ID: "q3"}, {ID: "plain"}},
		Queue: map[string]QueueEntry{
			"q1": {Task: `say "hi"`, MergeMode: "stacked-prs"},
			"q2": {Change: "261117-ab12-x", StopStage: stop},
			"q3": {Task: "bump deps", MergeMode: "merge-auto", Plain: true, Base: "eng-v2"},
		},
	})
	for _, want := range []string{
		"- queue: mode merge-auto; stop_stage null; plain; base eng-v2; task \"bump deps\"\n",
		"### q1 (note)\n\n- queue: mode stacked-prs; stop_stage null; task \"say \\\"hi\\\"\"\n- state:",
		"### q2 (note)\n\n- queue: mode cherry-pick-ladder; stop_stage hydrate; change 261117-ab12-x\n- state:",
		"### plain (note)\n\n- state:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("brief missing %q", want)
		}
	}
}
