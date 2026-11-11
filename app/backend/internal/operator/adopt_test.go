package operator

import (
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// legacyV10State is a full legacy-shaped fab file: two monitored entries, one
// watch, an exhausted autopilot block (state/current null, queue/completed
// retained), and one open + one resolved note.
const legacyV10State = `tick_count: 9
clock_override:
  schedule: {kind: every, every: 10m}
  until: "2026-09-09T09:00:00Z"
monitored:
  ab12:
    pane: "%3"
    repo: /home/u/foo
    session: work
    stage: apply
    agent: active
    stop_stage: null
    spawned_by: null
    depends_on: []
    branch: 260909-ab12-x
    enrolled_at: "2026-09-09T00:00:00Z"
    last_transition: "2026-09-09T01:00:00Z"
  cd34:
    pane: "%4"
    repo: /home/u/bar
    session: ops
    branch: 260909-cd34-y
    enrolled_at: "2026-09-09T02:00:00Z"
    last_transition: "2026-09-09T02:30:00Z"
watches:
  linear-bugs:
    enabled: true
    source: linear
    query:
      project: DEV
    target_repo: /home/u/foo
    stop_stage: intake
    known: [DEV-1, DEV-2]
    completed: [DEV-2, DEV-3]
    last_checked: "2026-09-09T03:00:00Z"
    instructions: spawn each new bug
autopilot:
  queue: [ab12, cd34]
  current: null
  completed: [ab12, cd34]
  state: null
  mode: cherry-pick-ladder
notes:
  - id: n1
    kind: coordination
    text: merge sequence open
    refs: [ab12]
    created_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:10:00Z"
    resolved: false
  - id: n2
    kind: correction
    text: typo fix
    created_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:20:00Z"
    resolved: true
notes_seq: 2
branch_map:
  ab12: {branch: 260909-ab12-x, repo: /home/u/foo}
`

// currentFabState is a fab file in the `tracked` shape: a note item carrying
// the old text field, a github-pr item, a retired fab-change item, and the
// fab-only clock_override and an unknown top-level key.
const currentFabState = `tick_count: 3
clock_override:
  schedule: {kind: every, every: 10m}
  until: "2026-09-09T09:00:00Z"
tracked:
  - id: a
    kind: github-pr
    probe: {mode: shell, argv: [gh, pr, view, "1"], fields: [state]}
    check_every: 5m
    done_when: 'state == "MERGED"'
    depends_on: []
    scope: {pr: 1}
    last: {state: OPEN}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: b
    kind: note
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    text: fab prose becomes the first note
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T05:00:00Z"
  - id: ab12
    kind: fab-change
    probe: {mode: pane}
    depends_on: []
    scope: {pane: "%3", repo: /home/u/foo}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
branch_map:
  a: {branch: br-a, repo: /r}
`

func writeFab(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fab", "operator", "default.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func hashFile(t *testing.T, p string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

func mustAdopt(t *testing.T, source, target string, dryRun bool) AdoptResult {
	t.Helper()
	res, err := Adopt(source, target, dryRun)
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	return res
}

func byID(t *testing.T, path string) map[string]TrackedItem {
	t.Helper()
	m := map[string]TrackedItem{}
	for _, it := range mustLoad(t, path).Tracked {
		m[it.ID] = it
	}
	return m
}

func TestAdopt_LegacyV10FileConverts(t *testing.T) {
	src := writeFab(t, legacyV10State)
	target := seededState(t, "")

	res := mustAdopt(t, src, target, false)
	items := byID(t, target)
	// 2 pane, 1 linear, 1 note; the exhausted queue converts nothing.
	if len(items) != 4 || len(res.Adopted) != 4 {
		t.Fatalf("items = %d adopted = %v, want 4", len(items), res.Adopted)
	}

	ab12 := items["ab12"]
	if ab12.Kind != KindPane || ab12.Probe.Mode != probePane {
		t.Errorf("ab12 kind/probe = %s/%s", ab12.Kind, ab12.Probe.Mode)
	}
	for k, want := range map[string]string{"pane": "%3", "change": "ab12", "repo": "/home/u/foo", "session": "work", "branch": "260909-ab12-x", "stage": "apply", "agent": "active"} {
		if got := scopeString(ab12.Scope, k); got != want {
			t.Errorf("ab12 scope.%s = %q, want %q", k, got, want)
		}
	}
	if v, present := ab12.Scope["pane_pid"]; !present || v != nil {
		t.Errorf("ab12 scope.pane_pid = %v (present %v), want key present with null", v, present)
	}
	if ab12.CheckedAt == nil || *ab12.CheckedAt != "2026-09-09T01:00:00Z" {
		t.Errorf("ab12 checked_at = %v, want last_transition", ab12.CheckedAt)
	}
	if ab12.AddedAt != "2026-09-09T00:00:00Z" || ab12.UpdatedAt != "2026-09-09T01:00:00Z" {
		t.Errorf("ab12 timestamps = %s/%s", ab12.AddedAt, ab12.UpdatedAt)
	}

	lw := items["linear-bugs"]
	if lw.Kind != KindLinear || lw.Probe.Mode != probeAgent || lw.Probe.Instruction == "" {
		t.Errorf("linear-bugs probe = %+v", lw.Probe)
	}
	if lw.CheckEvery == nil || *lw.CheckEvery != "5m" {
		t.Errorf("linear-bugs check_every = %v", lw.CheckEvery)
	}
	if got := strings.Join(lw.Seen, ","); got != "DEV-1,DEV-2,DEV-3" {
		t.Errorf("linear-bugs seen = %v, want known ∪ completed deduped", lw.Seen)
	}
	if lw.Then == nil || *lw.Then != "spawn each new bug" {
		t.Errorf("linear-bugs then = %v", lw.Then)
	}
	if got := scopeString(lw.Scope, "stop_stage"); got != "intake" {
		t.Errorf("linear-bugs scope.stop_stage = %q", got)
	}
	if lw.CheckedAt == nil || *lw.CheckedAt != "2026-09-09T03:00:00Z" {
		t.Errorf("linear-bugs checked_at = %v", lw.CheckedAt)
	}

	n1 := items["n1"]
	if n1.Kind != KindNote || len(n1.Notes) != 1 {
		t.Fatalf("n1 = %+v, want the open note as a note item with one note", n1)
	}
	if n1.Notes[0].Text != "merge sequence open" || n1.Notes[0].By != ByUser || n1.Notes[0].At != "2026-09-09T00:10:00Z" {
		t.Errorf("n1 first note = %+v, want text/user/updated_at", n1.Notes[0])
	}
	if _, ok := items["n2"]; ok {
		t.Error("resolved note n2 must be dropped")
	}
	if got := mustLoad(t, target).BranchMap["ab12"]; got != (BranchMapEntry{Branch: "260909-ab12-x", Repo: "/home/u/foo"}) {
		t.Errorf("branch_map.ab12 = %+v, want carried", got)
	}
}

func TestAdopt_RunningAutopilotRefusesAndWritesNothing(t *testing.T) {
	seed := strings.Replace(legacyV10State, "  state: null", "  state: running", 1)
	seed = strings.Replace(seed, "  current: null", "  current: ab12", 1)
	src := writeFab(t, seed)
	target := seededState(t, "")

	_, err := Adopt(src, target, false)
	if err == nil || err.Error() != LegacyRunningRefusal {
		t.Fatalf("err = %v, want exactly %q", err, LegacyRunningRefusal)
	}
	if _, statErr := os.Stat(filepath.Dir(target)); !os.IsNotExist(statErr) {
		t.Error("a refusal created the rk state directory")
	}
}

func TestAdopt_AutopilotQueueChainsItems(t *testing.T) {
	src := writeFab(t, `autopilot:
  queue: [a1, b1, a2, done0]
  current: a1
  completed: [done0]
  state: paused
  mode: stacked-prs
branch_map:
  a1: {branch: br-a1, repo: /r/a}
  b1: {branch: br-b1, repo: /r/b}
  a2: {branch: br-a2, repo: /r/a}
  done0: {branch: br-d0, repo: /r/a}
`)
	target := seededState(t, "")
	mustAdopt(t, src, target, false)
	items := byID(t, target)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3 (completed entries convert nothing)", len(items))
	}
	a1 := items["a1"]
	if a1.Kind != KindPane || scopeString(a1.Scope, "pane") != "" || scopeString(a1.Scope, "change") != "a1" {
		t.Errorf("a1 = %+v", a1)
	}
	if got := scopeString(a1.Scope, "merge_mode"); got != "stacked-prs" {
		t.Errorf("a1 merge_mode = %q, want the autopilot mode", got)
	}
	if got := scopeString(a1.Scope, "branch"); got != "br-a1" {
		t.Errorf("a1 branch = %q", got)
	}
	if got := strings.Join(items["b1"].DependsOn, ","); got != "a1" {
		t.Errorf("b1 depends_on = %v, want [a1] (cross-repo → immediate predecessor)", items["b1"].DependsOn)
	}
	if got := strings.Join(items["a2"].DependsOn, ","); got != "a1" {
		t.Errorf("a2 depends_on = %v, want [a1] (nearest same-repo predecessor)", items["a2"].DependsOn)
	}
}

func TestAdopt_DisabledWatchConvertsPaused(t *testing.T) {
	src := writeFab(t, `watches:
  w1:
    enabled: false
    source: slack
    target_repo: /home/u/foo
    known: []
    completed: []
`)
	target := seededState(t, "")
	mustAdopt(t, src, target, false)
	w1 := byID(t, target)["w1"]
	if w1.Kind != KindSlack || !w1.Paused {
		t.Errorf("w1 = kind %s paused %v, want slack/paused", w1.Kind, w1.Paused)
	}
}

func TestAdopt_CurrentShape(t *testing.T) {
	src := writeFab(t, currentFabState)
	target := seededState(t, "")
	res := mustAdopt(t, src, target, false)
	if strings.Join(res.Adopted, ",") != "a,b,ab12" {
		t.Fatalf("adopted = %v, want fab's order", res.Adopted)
	}
	items := byID(t, target)

	b := items["b"]
	if len(b.Notes) != 1 || b.Notes[0] != (Note{At: "2026-09-09T05:00:00Z", By: ByUser, Text: "fab prose becomes the first note"}) {
		t.Errorf("b notes = %+v, want the old text as the first note at updated_at", b.Notes)
	}
	if items["a"].Notes != nil {
		t.Errorf("a (github-pr) gained notes: %+v", items["a"].Notes)
	}

	fc := items["ab12"]
	if fc.Kind != KindPane || scopeString(fc.Scope, "change") != "ab12" {
		t.Errorf("fab-change item = kind %s change %q, want pane / ab12", fc.Kind, scopeString(fc.Scope, "change"))
	}
	if v, present := fc.Scope["pane_pid"]; !present || v != nil {
		t.Errorf("fab-change scope.pane_pid = %v (present %v), want null", v, present)
	}
	if got := scopeString(fc.Scope, "pane"); got != "%3" {
		t.Errorf("fab-change scope.pane = %q, want preserved", got)
	}

	out, _ := os.ReadFile(target)
	for _, banned := range []string{"clock_override", "tick_count", "\n    text:"} {
		if strings.Contains(string(out), banned) {
			t.Errorf("target carries %q:\n%s", banned, out)
		}
	}
	if got := mustLoad(t, target).BranchMap["a"]; got != (BranchMapEntry{Branch: "br-a", Repo: "/r"}) {
		t.Errorf("branch_map.a = %+v, want carried", got)
	}
}

func TestAdopt_NoteItemFallsBackToAddedAt(t *testing.T) {
	src := writeFab(t, `tracked:
  - id: n
    kind: note
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    text: only added_at
    added_at: "2026-09-09T00:00:00Z"
`)
	target := seededState(t, "")
	mustAdopt(t, src, target, false)
	if got := byID(t, target)["n"].Notes; len(got) != 1 || got[0].At != "2026-09-09T00:00:00Z" {
		t.Errorf("notes = %+v, want at = added_at", got)
	}
}

func TestAdopt_FabFileIsByteIdentical(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"legacy", legacyV10State},
		{"current", currentFabState},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := writeFab(t, tc.content)
			before := hashFile(t, src)
			infoBefore, _ := os.Stat(src)
			target := seededState(t, "")

			mustAdopt(t, src, target, true)
			mustAdopt(t, src, target, false)
			mustAdopt(t, src, target, false)

			if hashFile(t, src) != before {
				t.Error("the fab file's bytes changed")
			}
			infoAfter, _ := os.Stat(src)
			if !infoAfter.ModTime().Equal(infoBefore.ModTime()) {
				t.Error("the fab file's mtime changed")
			}
			entries, _ := os.ReadDir(filepath.Dir(src))
			if len(entries) != 1 {
				t.Errorf("fab dir has stray files (a lock or temp file): %v", entries)
			}
		})
	}
}

func TestAdopt_DryRunWritesNothing(t *testing.T) {
	src := writeFab(t, currentFabState)
	target := seededState(t, "")
	res := mustAdopt(t, src, target, true)
	if !res.DryRun || len(res.Adopted) != 3 {
		t.Fatalf("result = %+v, want a dry-run reporting 3 adopted", res)
	}
	if _, err := os.Stat(filepath.Dir(target)); !os.IsNotExist(err) {
		t.Error("dry-run created the state directory (and so possibly a lock)")
	}

	// Against an existing target a dry-run leaves it byte-identical.
	target = seededState(t, seedShell)
	before := hashFile(t, target)
	res = mustAdopt(t, src, target, true)
	if hashFile(t, target) != before {
		t.Error("dry-run changed the existing target")
	}
	if _, err := os.Stat(target + lockSuffix); !os.IsNotExist(err) {
		t.Error("dry-run took a lock")
	}
	if len(res.Adopted) != 3 {
		t.Errorf("dry-run adopted = %v", res.Adopted)
	}
}

func TestAdopt_MissingSourceIsNoSourceAndCreatesNoFile(t *testing.T) {
	target := seededState(t, "")
	missing := filepath.Join(t.TempDir(), "nope.yaml")
	_, err := Adopt(missing, target, false)
	if !errors.Is(err, ErrNoSource) {
		t.Fatalf("err = %v, want ErrNoSource", err)
	}
	wantErr(t, err, missing)
	if _, statErr := os.Stat(filepath.Dir(target)); !os.IsNotExist(statErr) {
		t.Error("a missing source created rk state")
	}
}

func TestAdopt_UnparsableSourceErrors(t *testing.T) {
	src := writeFab(t, "tracked: [unclosed\n")
	target := seededState(t, "")
	_, err := Adopt(src, target, false)
	wantErr(t, err, src)
	if errors.Is(err, ErrNoSource) {
		t.Error("an unparsable source must not read as missing")
	}
}

func TestAdopt_MergeNeverClobbersAndIsIdempotent(t *testing.T) {
	src := writeFab(t, `tracked:
  - id: a
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {from: fab}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: b
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
branch_map:
  a: {branch: fab-branch, repo: /fab}
  b: {branch: br-b, repo: /r}
`)
	target := seededState(t, `tracked:
  - id: a
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {from: rk}
    last: {}
    paused: true
    added_at: "2026-10-01T00:00:00Z"
    updated_at: "2026-10-01T00:00:00Z"
branch_map:
  a: {branch: rk-branch, repo: /rk}
unknown_key: kept
`)

	first := mustAdopt(t, src, target, false)
	if strings.Join(first.Adopted, ",") != "b" || strings.Join(first.Skipped, ",") != "a" {
		t.Fatalf("first run adopted %v skipped %v", first.Adopted, first.Skipped)
	}
	items := byID(t, target)
	if items["a"].Scope["from"] != "rk" || !items["a"].Paused {
		t.Errorf("existing item a was overwritten: %+v", items["a"])
	}
	st := mustLoad(t, target)
	if st.BranchMap["a"].Branch != "rk-branch" || st.BranchMap["b"].Branch != "br-b" {
		t.Errorf("branch_map = %+v, want a untouched and b added", st.BranchMap)
	}
	if st.extra["unknown_key"] != "kept" {
		t.Errorf("unknown top-level key lost: %v", st.extra)
	}

	hash := hashFile(t, target)
	second := mustAdopt(t, src, target, false)
	if len(second.Adopted) != 0 || strings.Join(second.Skipped, ",") != "a,b" {
		t.Errorf("second run adopted %v skipped %v, want 0 / a,b", second.Adopted, second.Skipped)
	}
	if hashFile(t, target) != hash {
		t.Error("a no-op re-adopt rewrote the target")
	}
}

func TestAdopt_InvalidItemIsSkippedWithAReasonNotFatal(t *testing.T) {
	src := writeFab(t, `tracked:
  - id: good
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: bad-probe
    kind: task
    probe: {mode: shell, argv: [x], fields: [y]}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: bad-kind
    kind: email
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: empty-note
    kind: note
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: good
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - just a string
  - kind: task
`)
	target := seededState(t, "")
	res := mustAdopt(t, src, target, false)
	if strings.Join(res.Adopted, ",") != "good" {
		t.Errorf("adopted = %v, want only the first good", res.Adopted)
	}
	reasons := map[string]string{}
	for _, inv := range res.Invalid {
		reasons[inv.ID] = inv.Reason
	}
	for id, want := range map[string]string{
		"bad-probe":  "does not allow probe mode",
		"bad-kind":   "unknown kind",
		"empty-note": "no text",
		"good":       "duplicate id",
		"#5":         "unreadable item",
		"":           "missing id",
	} {
		if got, ok := reasons[id]; !ok || !strings.Contains(got, want) {
			t.Errorf("invalid[%q] = %q (present %v), want it to contain %q", id, got, ok, want)
		}
	}
	if len(byID(t, target)) != 1 {
		t.Errorf("target = %v, want only the good item", byID(t, target))
	}
}

func TestAdopt_LegacyProseOverTheCapsIsTrimmedWithWarnings(t *testing.T) {
	long := strings.Repeat("é", NoteTextCap+50)
	src := writeFab(t, "tracked:\n  - id: big\n    kind: note\n    probe: {mode: none}\n    depends_on: []\n    scope: {}\n    last: {}\n    text: "+long+"\n    added_at: \"2026-09-09T00:00:00Z\"\n    updated_at: \"2026-09-09T00:00:00Z\"\n")
	target := seededState(t, "")
	res := mustAdopt(t, src, target, false)
	notes := byID(t, target)["big"].Notes
	if len(notes) != 1 || len([]rune(notes[0].Text)) != NoteTextCap {
		t.Fatalf("notes = %d runes %d, want one trimmed to %d", len(notes), len([]rune(notes[0].Text)), NoteTextCap)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "big") {
		t.Errorf("warnings = %v, want one naming the item", res.Warnings)
	}

	var b strings.Builder
	b.WriteString("tracked:\n  - id: many\n    kind: task\n    probe: {mode: none}\n    depends_on: []\n    scope: {}\n    last: {}\n    notes:\n")
	for i := 0; i < NoteCap+5; i++ {
		b.WriteString("      - {at: \"2026-09-09T00:00:00Z\", by: user, text: n" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + "}\n")
	}
	b.WriteString("    added_at: \"2026-09-09T00:00:00Z\"\n    updated_at: \"2026-09-09T00:00:00Z\"\n")
	res = mustAdopt(t, writeFab(t, b.String()), seededState(t, ""), true)
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "newest 50") {
		t.Errorf("warnings = %v, want the note-count trim", res.Warnings)
	}
}

func TestAdopt_UnreadableTargetErrorsBeforeAnyWrite(t *testing.T) {
	src := writeFab(t, currentFabState)
	target := seededState(t, "tracked: [unclosed\n")
	before := hashFile(t, target)
	_, err := Adopt(src, target, false)
	wantErr(t, err, target)
	if hashFile(t, target) != before {
		t.Error("an unparsable target was rewritten")
	}
}
