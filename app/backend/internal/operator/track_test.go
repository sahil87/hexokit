package operator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// --- shared scaffolding --------------------------------------------------------

// seededState points XDG_STATE_HOME at a temp dir (so nothing can reach the
// live state home), writes initial into a state file there (empty = missing
// file) and returns its path.
func seededState(t *testing.T, initial string) string {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	path := filepath.Join(t.TempDir(), "operator", "state.yaml")
	if initial != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// stubSeams replaces the gh and pane-pid seams so no test shells out; each
// fails unless the test installs its own.
func stubSeams(t *testing.T) {
	t.Helper()
	prevGH, prevPID := ghNameWithOwnerFn, panePIDFn
	ghNameWithOwnerFn = func(context.Context, string) (string, error) { return "", errors.New("stubbed: no gh") }
	panePIDFn = func(context.Context, string, string) (int, error) { return 0, errors.New("stubbed: no tmux") }
	t.Cleanup(func() { ghNameWithOwnerFn, panePIDFn = prevGH, prevPID })
}

func stubGH(t *testing.T, nameWithOwner string, err error) {
	t.Helper()
	prev := ghNameWithOwnerFn
	ghNameWithOwnerFn = func(context.Context, string) (string, error) { return nameWithOwner, err }
	t.Cleanup(func() { ghNameWithOwnerFn = prev })
}

func stubPanePID(t *testing.T, pid int, err error) {
	t.Helper()
	prev := panePIDFn
	panePIDFn = func(context.Context, string, string) (int, error) { return pid, err }
	t.Cleanup(func() { panePIDFn = prev })
}

// stubClock makes timestamps deterministic: each call advances one second.
func stubClock(t *testing.T) {
	t.Helper()
	prev := clock
	cur := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	clock = func() time.Time {
		cur = cur.Add(time.Second)
		return cur
	}
	t.Cleanup(func() { clock = prev })
}

func mustLoad(t *testing.T, path string) *State {
	t.Helper()
	st, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return st
}

// item returns the tracked item with the given id (fails when absent).
func item(t *testing.T, path, id string) TrackedItem {
	t.Helper()
	st := mustLoad(t, path)
	i := indexOf(st.Tracked, id)
	if i < 0 {
		t.Fatalf("no item %s in %v", id, st.Tracked)
	}
	return st.Tracked[i]
}

func mustAdd(t *testing.T, path string, spec AddSpec) AddResult {
	t.Helper()
	res, err := Add(context.Background(), path, spec)
	if err != nil {
		t.Fatalf("Add(%s): %v", spec.ID, err)
	}
	return res
}

func wantErr(t *testing.T, err error, sub string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), sub) {
		t.Fatalf("err = %v, want it to contain %q", err, sub)
	}
}

func isInvalid(err error) bool {
	var inv *InvalidError
	return errors.As(err, &inv)
}

func scopeIntVal(it TrackedItem, key string) (int, bool) {
	n, ok := it.Scope[key].(int)
	return n, ok
}

// seedShell is a state file carrying one shell item (pr-1) and one done
// github-pr item (pr-done) — the shared seed for update/observe/rm tests.
const seedShell = `tracked:
  - id: pr-1
    kind: shell
    probe:
      mode: shell
      argv: [myprobe, --flag]
      fields: [status]
    check_every: 2m
    done_when: 'status == "green"'
    then: null
    depends_on: []
    scope: {}
    last: {status: red}
    checked_at: "2026-09-10T00:00:00Z"
    unchanged: 1
    failures: 0
    paused: false
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-10T00:00:00Z"
  - id: pr-done
    kind: github-pr
    probe:
      mode: shell
      argv: [gh, pr, view, "5"]
      fields: [state]
    check_every: 5m
    done_when: 'state == "MERGED"'
    then: null
    depends_on: []
    scope: {repo: /x, pr: 5}
    last: {state: MERGED}
    checked_at: "2026-09-10T00:00:00Z"
    unchanged: 0
    failures: 0
    paused: false
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-10T00:00:00Z"
branch_map: {}
`

// --- Add -------------------------------------------------------------------------

func TestAdd_GitHubPRDefaults(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	stubGH(t, "sahil87/run-kit", nil)

	mustAdd(t, path, AddSpec{ID: "pr-913", Kind: KindGitHubPR, Scope: map[string]interface{}{"repo": "/x/hexokit", "pr": float64(913)}})

	it := item(t, path, "pr-913")
	if it.Probe.Mode != probeShell {
		t.Fatalf("probe.mode = %q, want shell", it.Probe.Mode)
	}
	if got, want := strings.Join(it.Probe.Argv, " "), "gh pr view 913 --repo sahil87/run-kit --json state,mergedAt,mergeable"; got != want {
		t.Errorf("argv = %q, want %q", got, want)
	}
	if strings.Join(it.Probe.Fields, ",") != "state,mergedAt,mergeable" {
		t.Errorf("fields = %v", it.Probe.Fields)
	}
	if it.DoneWhen == nil || *it.DoneWhen != `state == "MERGED"` {
		t.Errorf("done_when = %v", it.DoneWhen)
	}
	if it.CheckEvery == nil || *it.CheckEvery != "5m" {
		t.Errorf("check_every = %v, want 5m default", it.CheckEvery)
	}
	if it.Failures != 0 || it.Paused || it.Unchanged != 0 {
		t.Errorf("bookkeeping not zeroed: %+v", it)
	}
	for _, ts := range []string{it.AddedAt, it.UpdatedAt} {
		if _, err := time.Parse(time.RFC3339, ts); err != nil {
			t.Errorf("timestamp %q not RFC3339: %v", ts, err)
		}
	}
}

func TestAdd_GitHubPRDerivationFailureIsAnAddTimeError(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	stubGH(t, "", errors.New("gh: not logged in"))

	_, err := Add(context.Background(), path, AddSpec{ID: "pr-913", Kind: KindGitHubPR, Scope: map[string]interface{}{"repo": "/x/hexokit", "pr": float64(913)}})
	if err == nil {
		t.Fatal("Add succeeded, want an add-time error on derivation failure")
	}
	for _, want := range []string{"/x/hexokit", "gh: not logged in", "--argv"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("state file exists after a failed add (stat err = %v)", statErr)
	}
}

func TestAdd_GitHubPRWithoutScopeRepoNeedsNoDerivation(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)

	mustAdd(t, path, AddSpec{ID: "pr-913", Kind: KindGitHubPR, Scope: map[string]interface{}{"pr": float64(913)}})
	if got, want := strings.Join(item(t, path, "pr-913").Probe.Argv, " "), "gh pr view 913 --json state,mergedAt,mergeable"; got != want {
		t.Errorf("argv = %q, want %q", got, want)
	}
}

func TestAdd_PaneSugarAndBranchMap(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	stubPanePID(t, 48213, nil)

	mustAdd(t, path, AddSpec{ID: "r3m7", Kind: KindPane, PaneSugar: map[string]string{
		"pane": "%3", "repo": "/home/u/foo", "session": "work",
		"branch": "260324-r3m7-add-retry-logic", "stage": "apply", "agent": "active",
		"stop-stage": "review", "spawned-by": "linear-bugs", "change": "r3m7",
	}})

	it := item(t, path, "r3m7")
	if it.Kind != KindPane || it.Probe.Mode != probePane {
		t.Fatalf("kind/probe = %s/%s", it.Kind, it.Probe.Mode)
	}
	if it.CheckEvery != nil {
		t.Errorf("check_every = %v, want null for pane items", *it.CheckEvery)
	}
	for k, want := range map[string]string{
		"pane": "%3", "change": "r3m7", "repo": "/home/u/foo", "session": "work",
		"branch": "260324-r3m7-add-retry-logic", "stage": "apply", "agent": "active",
		"stop_stage": "review", "spawned_by": "linear-bugs",
	} {
		if got := scopeString(it.Scope, k); got != want {
			t.Errorf("scope.%s = %q, want %q", k, got, want)
		}
	}
	for _, k := range []string{"pane", "pane_pid", "change", "repo", "session", "branch", "stage", "agent", "stop_stage", "spawned_by", "merge_mode"} {
		if _, ok := it.Scope[k]; !ok {
			t.Errorf("scope.%s key missing (eleven pinned keys, null until set)", k)
		}
	}
	if pid, ok := scopeIntVal(it, "pane_pid"); !ok || pid != 48213 {
		t.Errorf("scope.pane_pid = %v, want 48213", it.Scope["pane_pid"])
	}
	if it.Scope["merge_mode"] != nil {
		t.Errorf("scope.merge_mode = %v, want null when --mode is omitted", it.Scope["merge_mode"])
	}
	bm := mustLoad(t, path).BranchMap
	if bm["r3m7"] != (BranchMapEntry{Branch: "260324-r3m7-add-retry-logic", Repo: "/home/u/foo"}) {
		t.Errorf("branch_map.r3m7 = %+v", bm["r3m7"])
	}
}

func TestAdd_BranchMapKeysOnItemIDWithoutChange(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "k1", Kind: KindPane, PaneSugar: map[string]string{"repo": "/r", "branch": "b-k1"}})
	if got := mustLoad(t, path).BranchMap["k1"]; got != (BranchMapEntry{Branch: "b-k1", Repo: "/r"}) {
		t.Errorf("branch_map.k1 = %+v", got)
	}

	// Only one of branch/repo → no entry.
	mustAdd(t, path, AddSpec{ID: "k2", Kind: KindPane, PaneSugar: map[string]string{"repo": "/r"}})
	if _, ok := mustLoad(t, path).BranchMap["k2"]; ok {
		t.Error("branch_map entry written without a branch")
	}
}

func TestAdd_PanePIDLookupFailureStoresNull(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)

	mustAdd(t, path, AddSpec{ID: "a1", Kind: KindPane, PaneSugar: map[string]string{"pane": "%3"}})
	mustAdd(t, path, AddSpec{ID: "a2", Kind: KindPane, Scope: map[string]interface{}{"pane": "%9"}})
	for _, id := range []string{"a1", "a2"} {
		if v, present := item(t, path, id).Scope["pane_pid"]; !present || v != nil {
			t.Errorf("%s scope.pane_pid = %v (present %v), want key present with null", id, v, present)
		}
	}

	stubPanePID(t, 501, nil)
	mustAdd(t, path, AddSpec{ID: "a3", Kind: KindPane, Scope: map[string]interface{}{"pane": "%9"}})
	if pid, ok := scopeIntVal(item(t, path, "a3"), "pane_pid"); !ok || pid != 501 {
		t.Errorf("a3 scope.pane_pid = %v, want 501", item(t, path, "a3").Scope["pane_pid"])
	}
}

func TestAdd_ModeSetsMergeMode(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)

	res := mustAdd(t, path, AddSpec{ID: "m1", Kind: KindPane, Mode: MergeModeMergeAuto})
	if res.MergeMode != MergeModeMergeAuto {
		t.Errorf("result mode = %q", res.MergeMode)
	}
	if got := scopeString(item(t, path, "m1").Scope, "merge_mode"); got != MergeModeMergeAuto {
		t.Errorf("scope.merge_mode = %q", got)
	}

	// A chain without --mode keeps merge_mode null: no config is consulted.
	res = mustAdd(t, path, AddSpec{ID: "m2", Kind: KindPane, DependsOn: []string{"m1"}})
	if res.MergeMode != "" || item(t, path, "m2").Scope["merge_mode"] != nil {
		t.Errorf("chained add without --mode set merge_mode: %v", item(t, path, "m2").Scope["merge_mode"])
	}
}

func TestAdd_NoteKindCreatesFirstNote(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)

	mustAdd(t, path, AddSpec{ID: "n1", Kind: KindNote, Text: "  remember X  ", TextSet: true})
	it := item(t, path, "n1")
	if len(it.Notes) != 1 || it.Notes[0].By != ByUser || it.Notes[0].Text != "remember X" {
		t.Fatalf("notes = %+v, want one user note %q", it.Notes, "remember X")
	}
	if _, err := time.Parse(time.RFC3339, it.Notes[0].At); err != nil {
		t.Errorf("note at %q not RFC3339", it.Notes[0].At)
	}
	if it.Probe.Mode != probeNone || it.CheckEvery != nil {
		t.Errorf("note probe/check_every = %s/%v", it.Probe.Mode, it.CheckEvery)
	}

	mustAdd(t, path, AddSpec{ID: "n2", Kind: KindNote, Text: "from chat", TextSet: true, By: ByChat})
	if got := item(t, path, "n2").Notes[0].By; got != ByChat {
		t.Errorf("n2 note by = %q, want chat", got)
	}
}

func TestAdd_ValidationErrors(t *testing.T) {
	str := func(s string) *string { return &s }
	shellArgs := func(s AddSpec) AddSpec {
		s.Kind = KindShell
		return s
	}
	tests := []struct {
		name    string
		seed    string
		spec    AddSpec
		wantErr string
		invalid bool
	}{
		{"unknown kind", "", AddSpec{ID: "x", Kind: "email"}, "unknown --kind", true},
		{"kind-forbidden probe", "", AddSpec{ID: "x", Kind: KindNote, Probe: "shell", Text: "hi", TextSet: true}, "does not allow probe mode", true},
		{"unknown probe", "", AddSpec{ID: "x", Kind: KindTask, Probe: "weird"}, "unknown --probe", true},
		{"check-every below floor", "", shellArgs(AddSpec{ID: "x", Argv: []string{"true"}, Fields: []string{"a"}, DoneWhen: str("a == 1"), CheckEvery: "30s"}), "below the 1m0s floor", true},
		{"floor error wins over the done-when requirement", "", shellArgs(AddSpec{ID: "x", Argv: []string{"true"}, Fields: []string{"a"}, CheckEvery: "30s"}), "below the 1m0s floor", true},
		{"malformed done-when", "", shellArgs(AddSpec{ID: "x", Argv: []string{"true"}, Fields: []string{"a"}, DoneWhen: str("a == MERGED")}), `invalid --done-when: invalid clause "a == MERGED"`, true},
		{"shell probe without fields", "", shellArgs(AddSpec{ID: "x", Argv: []string{"true"}, DoneWhen: str("a == 1")}), "requires --fields", true},
		{"shell probe without argv", "", shellArgs(AddSpec{ID: "x", Fields: []string{"a"}, DoneWhen: str("a == 1")}), "requires --argv", true},
		{"shell kind without done-when", "", shellArgs(AddSpec{ID: "x", Argv: []string{"true"}, Fields: []string{"a"}}), "kind shell requires --done-when", true},
		{"unknown depends-on id", "", AddSpec{ID: "x", Kind: KindTask, DependsOn: []string{"zz"}}, `--depends-on "zz": no tracked item with that id`, true},
		{"self depends-on", "", AddSpec{ID: "x", Kind: KindTask, DependsOn: []string{"x"}}, "names the item itself", true},
		{"note without text", "", AddSpec{ID: "x", Kind: KindNote}, "kind note requires --text", true},
		{"note with unknown author", "", AddSpec{ID: "x", Kind: KindNote, Text: "hi", TextSet: true, By: "robot"}, "invalid --by", true},
		{"text on non-note kind", "", AddSpec{ID: "x", Kind: KindTask, Text: "hi", TextSet: true}, "--text applies only to kind note", true},
		{"pane sugar on non-pane kind", "", AddSpec{ID: "x", Kind: KindTask, PaneSugar: map[string]string{"pane": "%3"}}, "--pane applies only to kind pane", true},
		{"mode on non-pane kind", "", AddSpec{ID: "x", Kind: KindTask, Mode: MergeModeMergeAuto}, "--mode applies only to kind pane", true},
		{"invalid mode", "", AddSpec{ID: "x", Kind: KindPane, Mode: "yolo"}, `unknown --mode "yolo"`, true},
		{"empty change sugar rejected", "", AddSpec{ID: "x", Kind: KindPane, PaneSugar: map[string]string{"pane": "%3", "change": ""}}, "--change requires a non-empty change id", true},
		{"retired kind fab-change is unknown at add", "", AddSpec{ID: "x", Kind: "fab-change"}, `unknown --kind "fab-change" (valid: pane, github-pr, linear, slack, shell, task, note)`, true},
		{"invalid stage sugar", "", AddSpec{ID: "x", Kind: KindPane, PaneSugar: map[string]string{"stage": "deploy"}}, "invalid --stage", true},
		{"github-pr without scope.pr", "", AddSpec{ID: "x", Kind: KindGitHubPR, Scope: map[string]interface{}{"repo": "/x"}}, "requires scope.pr", true},
		{"empty id", "", AddSpec{ID: "", Kind: KindTask}, "id must not be empty", true},
		{"duplicate id", seedShell, AddSpec{ID: "pr-1", Kind: KindTask}, "tracked item pr-1 already exists", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := seededState(t, tc.seed)
			stubSeams(t)
			stubGH(t, "o/r", nil)
			var before []byte
			if tc.seed != "" {
				before, _ = os.ReadFile(path)
			}
			_, err := Add(context.Background(), path, tc.spec)
			wantErr(t, err, tc.wantErr)
			if isInvalid(err) != tc.invalid {
				t.Errorf("InvalidError = %v, want %v (%v)", isInvalid(err), tc.invalid, err)
			}
			if tc.seed == "" {
				if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
					t.Error("state file written on a rejected add")
				}
			} else if after, _ := os.ReadFile(path); string(before) != string(after) {
				t.Error("state file changed on a rejected add")
			}
		})
	}
}

// --- Update ----------------------------------------------------------------------

func TestUpdate(t *testing.T) {
	path := seededState(t, seedShell)
	stubSeams(t)
	str := func(s string) *string { return &s }

	err := Update(context.Background(), path, UpdateSpec{
		ID: "pr-1", CheckEvery: str("10m"), DoneWhen: str(`status == "green" and extra == null`),
		Then: str("deploy next"), Scope: map[string]interface{}{"env": "prod"},
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	it := item(t, path, "pr-1")
	if it.CheckEvery == nil || *it.CheckEvery != "10m" {
		t.Errorf("check_every = %v", it.CheckEvery)
	}
	if it.DoneWhen == nil || *it.DoneWhen != `status == "green" and extra == null` {
		t.Errorf("done_when = %v", it.DoneWhen)
	}
	if it.Then == nil || *it.Then != "deploy next" {
		t.Errorf("then = %v", it.Then)
	}
	if it.Scope["env"] != "prod" {
		t.Errorf("scope = %v, want env merged in", it.Scope)
	}
	if it.UpdatedAt == "2026-09-10T00:00:00Z" {
		t.Error("updated_at not bumped")
	}

	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-1", DoneWhen: str(""), Then: str("")}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if it := item(t, path, "pr-1"); it.DoneWhen != nil || it.Then != nil {
		t.Errorf("done_when/then = %v/%v, want cleared", it.DoneWhen, it.Then)
	}
}

func TestUpdate_DependsOnReplacesTheList(t *testing.T) {
	path := seededState(t, seedShell)
	deps := []string{"pr-done"}
	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-1", DependsOn: &deps}); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "pr-1").DependsOn; !reflect.DeepEqual(got, deps) {
		t.Errorf("depends_on = %v", got)
	}
	none := []string{}
	if err := Update(context.Background(), path, UpdateSpec{ID: "pr-1", DependsOn: &none}); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "pr-1").DependsOn; len(got) != 0 {
		t.Errorf("depends_on = %v, want emptied", got)
	}
}

func TestUpdate_PaneScopeRecordsPID(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	stubPanePID(t, 48213, nil)
	mustAdd(t, path, AddSpec{ID: "a1", Kind: KindPane})

	if err := Update(context.Background(), path, UpdateSpec{ID: "a1", Scope: map[string]interface{}{"pane": "%7"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	it := item(t, path, "a1")
	if got := scopeString(it.Scope, "pane"); got != "%7" {
		t.Fatalf("scope.pane = %q", got)
	}
	if pid, ok := scopeIntVal(it, "pane_pid"); !ok || pid != 48213 {
		t.Errorf("scope.pane_pid = %v, want 48213", it.Scope["pane_pid"])
	}

	// A scope update that does not touch pane keeps the fingerprint.
	if err := Update(context.Background(), path, UpdateSpec{ID: "a1", Scope: map[string]interface{}{"stage": "apply"}}); err != nil {
		t.Fatal(err)
	}
	if pid, _ := scopeIntVal(item(t, path, "a1"), "pane_pid"); pid != 48213 {
		t.Errorf("pane_pid = %v after an unrelated scope update", item(t, path, "a1").Scope["pane_pid"])
	}

	if err := Update(context.Background(), path, UpdateSpec{ID: "a1", Scope: map[string]interface{}{"pane": ""}}); err != nil {
		t.Fatal(err)
	}
	if v := item(t, path, "a1").Scope["pane_pid"]; v != nil {
		t.Errorf("scope.pane_pid = %v, want null after the pane cleared", v)
	}
}

func TestUpdate_Errors(t *testing.T) {
	str := func(s string) *string { return &s }
	missing := []string{"zz"}
	tests := []struct {
		name    string
		spec    UpdateSpec
		wantErr string
	}{
		{"unknown id", UpdateSpec{ID: "zz", Then: str("x")}, "no tracked item zz"},
		{"check-every below floor", UpdateSpec{ID: "pr-1", CheckEvery: str("10s")}, "below the 1m0s floor"},
		{"malformed done-when", UpdateSpec{ID: "pr-1", DoneWhen: str("a > 1")}, "invalid --done-when"},
		{"unknown depends-on", UpdateSpec{ID: "pr-1", DependsOn: &missing}, "no tracked item with that id"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := seededState(t, seedShell)
			before, _ := os.ReadFile(path)
			wantErr(t, Update(context.Background(), path, tc.spec), tc.wantErr)
			if after, _ := os.ReadFile(path); string(before) != string(after) {
				t.Error("state file changed on a rejected update")
			}
		})
	}
}

// --- Pause / Resume / Remove -----------------------------------------------------

func TestPauseResume(t *testing.T) {
	path := seededState(t, seedShell)
	if err := Pause(path, "pr-1"); err != nil {
		t.Fatal(err)
	}
	if !item(t, path, "pr-1").Paused {
		t.Error("paused = false after Pause")
	}
	if err := Observe(path, ObserveSpec{ID: "pr-1", Failed: true}); err != nil {
		t.Fatal(err)
	}
	if err := Resume(path, "pr-1"); err != nil {
		t.Fatal(err)
	}
	it := item(t, path, "pr-1")
	if it.Paused || it.Failures != 0 {
		t.Errorf("after Resume: paused=%v failures=%d, want false/0", it.Paused, it.Failures)
	}
	wantErr(t, Pause(path, "zz"), "no tracked item zz")
	wantErr(t, Resume(path, "zz"), "no tracked item zz")
}

func TestRemove(t *testing.T) {
	seed := `tracked:
  - id: ab12
    kind: pane
    probe: {mode: pane}
    depends_on: []
    scope: {pane: "%3", repo: /home/u/foo, branch: 260909-ab12-x}
    last: {}
    notes:
      - {at: "2026-09-09T00:00:00Z", by: user, text: remember}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
branch_map:
  ab12: {branch: 260909-ab12-x, repo: /home/u/foo}
`
	path := seededState(t, seed)
	wantErr(t, Remove(path, "zz"), "no tracked item zz")
	if err := Remove(path, "ab12"); err != nil {
		t.Fatal(err)
	}
	st := mustLoad(t, path)
	if len(st.Tracked) != 0 {
		t.Errorf("tracked = %v, want empty (notes go with the item)", st.Tracked)
	}
	if _, ok := st.BranchMap["ab12"]; !ok {
		t.Error("branch_map entry must survive Remove")
	}
}

func TestRemove_DoneDependencyDropsSatisfiedEdges(t *testing.T) {
	seed := `tracked:
  - id: pr-1
    kind: shell
    probe: {mode: shell, argv: [true], fields: [status]}
    check_every: 5m
    done_when: 'status == "green"'
    depends_on: []
    scope: {}
    last: {status: green}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: n34
    kind: pane
    probe: {mode: pane}
    depends_on: [pr-1, other]
    scope: {repo: /home/u/foo, branch: 260909-n34-x}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: other
    kind: task
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
`
	path := seededState(t, seed)
	if err := Remove(path, "pr-1"); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "n34").DependsOn; !reflect.DeepEqual(got, []string{"other"}) {
		t.Errorf("n34.depends_on = %v after removing the done dep, want [other]", got)
	}
	if err := Remove(path, "other"); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "n34").DependsOn; !reflect.DeepEqual(got, []string{"other"}) {
		t.Errorf("n34.depends_on = %v after removing a not-done dep, want [other] kept", got)
	}
}

// --- Observe ---------------------------------------------------------------------

func TestObserve_StoresFieldsAndSeen(t *testing.T) {
	seed := `tracked:
  - id: linear-bugs
    kind: linear
    probe:
      mode: agent
      instruction: list issues
    check_every: 5m
    done_when: null
    then: null
    depends_on: []
    scope: {repo: /home/u/foo}
    last: {}
    seen: [A]
    checked_at: null
    unchanged: 0
    failures: 2
    paused: false
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
`
	path := seededState(t, seed)
	if err := Observe(path, ObserveSpec{ID: "linear-bugs", Fields: map[string]interface{}{"new": []interface{}{"B"}}, Seen: []string{"B"}}); err != nil {
		t.Fatal(err)
	}
	it := item(t, path, "linear-bugs")
	if !reflect.DeepEqual(it.Last, map[string]interface{}{"new": []interface{}{"B"}}) {
		t.Errorf("last = %v", it.Last)
	}
	if strings.Join(it.Seen, ",") != "A,B" {
		t.Errorf("seen = %v, want [A B]", it.Seen)
	}
	if it.CheckedAt == nil || it.Failures != 0 {
		t.Errorf("checked_at = %v failures = %d, want set/0", it.CheckedAt, it.Failures)
	}

	if err := Observe(path, ObserveSpec{ID: "linear-bugs", Fields: map[string]interface{}{"new": []interface{}{"B"}}}); err != nil {
		t.Fatal(err)
	}
	if got := item(t, path, "linear-bugs").Unchanged; got != 1 {
		t.Errorf("unchanged = %d after a repeat, want 1", got)
	}
}

func TestObserve_ExtractsDeclaredFieldsOnly(t *testing.T) {
	path := seededState(t, seedShell)
	if err := Observe(path, ObserveSpec{ID: "pr-1", Fields: map[string]interface{}{"status": "green", "extra": float64(1)}}); err != nil {
		t.Fatal(err)
	}
	it := item(t, path, "pr-1")
	if !reflect.DeepEqual(it.Last, map[string]interface{}{"status": "green"}) {
		t.Errorf("last = %v, want only the declared field", it.Last)
	}
	if it.Unchanged != 0 {
		t.Errorf("unchanged = %d on a field delta, want 0", it.Unchanged)
	}
	if !itemDone(it) {
		t.Error("done_when must fire after the observed flip")
	}
}

func TestObserve_ErrorFailuresPause(t *testing.T) {
	path := seededState(t, seedShell)
	for i := 1; i <= failurePauseCap; i++ {
		if err := Observe(path, ObserveSpec{ID: "pr-1", Failed: true}); err != nil {
			t.Fatal(err)
		}
		it := item(t, path, "pr-1")
		if it.Failures != i {
			t.Errorf("failures = %d after %d errors", it.Failures, i)
		}
		if want := i == failurePauseCap; it.Paused != want {
			t.Errorf("paused = %v after %d errors, want %v", it.Paused, i, want)
		}
	}
}

func TestObserve_UnknownID(t *testing.T) {
	path := seededState(t, seedShell)
	wantErr(t, Observe(path, ObserveSpec{ID: "zz", Fields: map[string]interface{}{}}), "no tracked item zz")
}

func TestObserve_SeenCapPrunesOldest(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "w", Kind: KindSlack})
	seen := make([]string, 0, seenCap)
	for i := 0; i < seenCap; i++ {
		seen = append(seen, fmt.Sprintf("S%03d", i))
	}
	if err := Mutate(path, func(st *State) error {
		st.Tracked[0].Seen = seen
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := Observe(path, ObserveSpec{ID: "w", Fields: map[string]interface{}{}, Seen: []string{"NEW"}}); err != nil {
		t.Fatal(err)
	}
	it := item(t, path, "w")
	if len(it.Seen) != seenCap {
		t.Fatalf("seen = %d entries, want the %d cap", len(it.Seen), seenCap)
	}
	if it.Seen[0] != "S001" || it.Seen[seenCap-1] != "NEW" {
		t.Errorf("seen = [%s … %s], want oldest pruned and NEW appended", it.Seen[0], it.Seen[seenCap-1])
	}
}

func TestExtractProbeFields_MergesSharedDottedPrefix(t *testing.T) {
	obj := map[string]interface{}{
		"a": map[string]interface{}{"b": 1, "c": 2, "d": 3},
		"x": "y",
	}
	got := extractProbeFields(obj, []string{"a.b", "a.c", "missing.k"})
	want := map[string]interface{}{
		"a":       map[string]interface{}{"b": 1, "c": 2},
		"missing": map[string]interface{}{"k": nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("extractProbeFields = %#v, want %#v", got, want)
	}
}

// --- List ------------------------------------------------------------------------

func TestList(t *testing.T) {
	seed := `tracked:
  - id: k8ds
    kind: pane
    probe: {mode: pane}
    depends_on: []
    scope: {pane: "%7", repo: /r/a}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: ef56
    kind: pane
    probe: {mode: pane}
    depends_on: [k8ds]
    scope: {pane: null, repo: /r/a}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: pr-9
    kind: github-pr
    probe: {mode: shell, argv: [gh, pr, view, "9"], fields: [state]}
    check_every: 2m
    done_when: 'state == "MERGED"'
    then: arm next
    depends_on: []
    scope: {repo: /r/a, pr: 9}
    last: {state: MERGED}
    checked_at: "2026-09-09T00:00:00Z"
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
  - id: n1
    kind: note
    probe: {mode: none}
    depends_on: []
    scope: {}
    last: {}
    notes:
      - {at: "2026-09-09T00:00:00Z", by: user, text: phase 2 of 4}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
`
	path := seededState(t, seed)
	before, _ := os.ReadFile(path)

	all, shown, err := List(path, "")
	if err != nil {
		t.Fatal(err)
	}
	lines := ListLines(all, shown)
	if len(lines) != 4 {
		t.Fatalf("lines = %q, want 4", lines)
	}
	if !strings.HasPrefix(lines[0], "k8ds · pane · live · live · —") {
		t.Errorf("line 0 = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "ef56 · pane · held · — · held: k8ds") {
		t.Errorf("line 1 = %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "pr-9 · github-pr · done · ") || !strings.HasSuffix(lines[2], " · arm next") {
		t.Errorf("line 2 = %q", lines[2])
	}
	if !strings.HasPrefix(lines[3], "n1 · note · watching · ") {
		t.Errorf("line 3 = %q", lines[3])
	}

	all, shown, err = List(path, KindNote)
	if err != nil {
		t.Fatal(err)
	}
	if got := ListLines(all, shown); len(got) != 1 || !strings.HasPrefix(got[0], "n1 ·") {
		t.Errorf("--kind note = %q", got)
	}

	_, _, err = List(path, "fab-change")
	wantErr(t, err, `unknown --kind "fab-change" (valid: pane,`)
	if !isInvalid(err) {
		t.Error("unknown kind must be a usage error")
	}

	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Error("List rewrote the state file")
	}
}

func TestList_JSONIncludesNotes(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "n1", Kind: KindNote, Text: "hello", TextSet: true})
	_, shown, err := List(path, "")
	if err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(shown)
	if err != nil {
		t.Fatal(err)
	}
	var back []TrackedItem
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if len(back) != 1 || len(back[0].Notes) != 1 || back[0].Notes[0].Text != "hello" {
		t.Errorf("json round trip = %s", out)
	}
}

func TestList_AbsentFileIsEmptyAndCreatesNothing(t *testing.T) {
	path := seededState(t, "")
	all, shown, err := List(path, "")
	if err != nil || len(all) != 0 || len(shown) != 0 {
		t.Fatalf("List = %v %v %v", all, shown, err)
	}
	if _, statErr := os.Stat(filepath.Dir(path)); !os.IsNotExist(statErr) {
		t.Error("List created the state directory")
	}
}

func TestFormatAge(t *testing.T) {
	for _, tc := range []struct {
		d    time.Duration
		want string
	}{
		{-time.Second, "0s"}, {30 * time.Second, "30s"}, {5 * time.Minute, "5m"},
		{3 * time.Hour, "3h"}, {50 * time.Hour, "2d"},
	} {
		if got := formatAge(tc.d); got != tc.want {
			t.Errorf("formatAge(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}

func TestTimestampsComeFromTheInjectedClock(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	stubClock(t)
	mustAdd(t, path, AddSpec{ID: "n1", Kind: KindNote, Text: "x", TextSet: true})
	it := item(t, path, "n1")
	want := "2026-11-11T09:00:01Z"
	if it.AddedAt != want || it.UpdatedAt != want || it.Notes[0].At != want {
		t.Errorf("added/updated/note at = %s/%s/%s, want %s", it.AddedAt, it.UpdatedAt, it.Notes[0].At, want)
	}
}
