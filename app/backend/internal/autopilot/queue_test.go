package autopilot

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"rk/internal/operator"
	"rk/internal/settings"
)

func TestSettingsModesMatchOperator(t *testing.T) {
	if !reflect.DeepEqual(settings.OperatorMergeModes, operator.MergeModes) {
		t.Fatalf("settings.OperatorMergeModes = %v, operator.MergeModes = %v", settings.OperatorMergeModes, operator.MergeModes)
	}
}

func TestResolveMode(t *testing.T) {
	cases := []struct {
		name, flag, setting, wantMode, wantSource string
		wantErr                                   string
	}{
		{name: "default", wantMode: "cherry-pick-ladder", wantSource: SourceDefault},
		{name: "flag wins", flag: "merge-auto", setting: "stacked-prs", wantMode: "merge-auto", wantSource: SourceFlag},
		{name: "setting", setting: "stacked-prs", wantMode: "stacked-prs", wantSource: SourceSetting},
		{name: "setting at the default value is the default", setting: "cherry-pick-ladder", wantMode: "cherry-pick-ladder", wantSource: SourceDefault},
		{name: "empty setting is the default", setting: "", wantMode: "cherry-pick-ladder", wantSource: SourceDefault},
		{name: "invalid setting names the set", setting: "bogus", wantErr: "cherry-pick-ladder, stacked-prs, merge-auto"},
		{name: "invalid flag names the set", flag: "bogus", wantErr: "cherry-pick-ladder, stacked-prs, merge-auto"},
		{name: "a valid flag does not hide an invalid setting", flag: "stacked-prs", setting: "bogus", wantMode: "stacked-prs", wantSource: SourceFlag},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mode, source, err := ResolveMode(c.flag, c.setting)
			if c.wantErr != "" {
				var inv *InvalidError
				if !errors.As(err, &inv) || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want InvalidError containing %q", err, c.wantErr)
				}
				return
			}
			if err != nil || mode != c.wantMode || source != c.wantSource {
				t.Fatalf("got (%q, %q, %v), want (%q, %q)", mode, source, err, c.wantMode, c.wantSource)
			}
		})
	}
}

func TestModeOfNullReadsAsLadder(t *testing.T) {
	it, err := operator.NewPaneItem("x", nil, map[string]interface{}{"repo": "/r"})
	if err != nil {
		t.Fatal(err)
	}
	if got := modeOf(it); got != operator.MergeModeCherryPickLadder {
		t.Fatalf("modeOf(null) = %q", got)
	}
}

func TestEnqueueImplicitChaining(t *testing.T) {
	h := newHarness(t)
	foo, bar := newRepo(t, "foo"), newRepo(t, "bar")
	rec := h.queue("",
		Entry{ID: "ab12", Repo: foo.Dir, Change: "ab12"},
		Entry{ID: "cd34", Repo: bar.Dir, Task: "fix the thing"},
		Entry{ID: "ef56", Repo: foo.Dir, Change: "ef56"},
	)
	if rec.Mode != "cherry-pick-ladder" || rec.Source != SourceDefault {
		t.Fatalf("receipt = %+v", rec)
	}
	want := map[string][]string{"ab12": {}, "cd34": {"ab12"}, "ef56": {"ab12"}}
	for id, deps := range want {
		it := h.item(id)
		if !reflect.DeepEqual(it.DependsOn, deps) {
			t.Errorf("%s depends_on = %v, want %v", id, it.DependsOn, deps)
		}
		if got := operator.ScopeString(it.Scope, "merge_mode"); got != "cherry-pick-ladder" {
			t.Errorf("%s merge_mode = %q, want it stamped", id, got)
		}
		if operator.ScopeString(it.Scope, "pane") != "" {
			t.Errorf("%s has a pane before spawn", id)
		}
		if it.Kind != operator.KindPane || it.Probe.Mode != "pane" {
			t.Errorf("%s kind/probe = %s/%s", id, it.Kind, it.Probe.Mode)
		}
	}
	if h.stateOf(h.item("ab12")) != StatePending || h.stateOf(h.item("cd34")) != StateHeld {
		t.Errorf("derived states = %s, %s", h.stateOf(h.item("ab12")), h.stateOf(h.item("cd34")))
	}
}

func TestEnqueueExplicitDependsReplacesImplicit(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	none := []string{}
	h.queue("",
		Entry{ID: "a", Repo: foo.Dir, Change: "a"},
		Entry{ID: "b", Repo: foo.Dir, Change: "b", DependsOn: &none},
	)
	if deps := h.item("b").DependsOn; len(deps) != 0 {
		t.Fatalf("b depends_on = %v, want the explicit empty list", deps)
	}
}

func TestEnqueueMergeAutoBarrierAndMisfit(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	rec := h.queue("merge-auto",
		Entry{ID: "a", Repo: foo.Dir, Change: "a"},
		Entry{ID: "b", Repo: foo.Dir, Change: "b"},
	)
	if deps := h.item("b").DependsOn; !reflect.DeepEqual(deps, []string{"a"}) {
		t.Fatalf("merge-auto b depends_on = %v, want the previous entry as a barrier", deps)
	}
	if len(rec.Misfits) != 0 {
		t.Fatalf("implicit barrier must not be a misfit: %v", rec.Misfits)
	}

	h2 := newHarness(t)
	same := []string{"a"}
	rec = h2.queue("merge-auto",
		Entry{ID: "a", Repo: foo.Dir, Change: "a"},
		Entry{ID: "b", Repo: foo.Dir, Change: "b", DependsOn: &same},
	)
	if len(rec.Misfits) != 1 || !strings.Contains(rec.Misfits[0], "merge-auto") {
		t.Fatalf("misfits = %v, want the merge-auto + same-repo misfit", rec.Misfits)
	}
}

func TestEnqueueRejectionsWriteNothing(t *testing.T) {
	foo := newRepo(t, "foo")
	sub := foo.Dir + "/sub"
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	bare := []string{"bare"}
	cases := []struct {
		name    string
		entries []Entry
		want    string
	}{
		{"bare dependency", []Entry{{ID: "bare", Repo: foo.Dir}, {ID: "b", Repo: foo.Dir, Change: "b", DependsOn: &bare}}, "bare agent"},
		{"implicit chain onto a bare entry", []Entry{{ID: "bare", Repo: foo.Dir}, {ID: "b", Repo: foo.Dir, Change: "b"}}, "bare agent"},
		{"duplicate id", []Entry{{ID: "a", Repo: foo.Dir, Change: "a"}, {ID: "a", Repo: foo.Dir, Change: "a2"}}, "duplicate id"},
		{"relative repo", []Entry{{ID: "a", Repo: "foo", Change: "a"}}, "absolute"},
		{"not a git root", []Entry{{ID: "a", Repo: sub, Change: "a"}}, "git root"},
		{"missing repo", []Entry{{ID: "a", Repo: "/no/such/dir", Change: "a"}}, "not a directory"},
		{"change and task", []Entry{{ID: "a", Repo: foo.Dir, Change: "a", Task: "t"}}, "both a change and a task"},
		{"unknown dependency", []Entry{{ID: "a", Repo: foo.Dir, Change: "a", DependsOn: &[]string{"zzz"}}}, "neither in this queue nor tracked"},
		{"bad id", []Entry{{ID: "-x", Repo: foo.Dir, Change: "a"}}, "invalid id"},
		{"bad stop_stage", []Entry{{ID: "a", Repo: foo.Dir, Change: "a", StopStage: ptr("nope")}}, "stop_stage"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			_, err := Enqueue(context.Background(), h.env, c.entries, QueueOptions{}, "")
			var inv *InvalidError
			if !errors.As(err, &inv) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want InvalidError containing %q", err, c.want)
			}
			if _, statErr := os.Stat(h.env.StatePath); statErr == nil {
				t.Fatal("a rejected queue wrote the state file")
			}
		})
	}
}

func TestEnqueueRejectsAlreadyTrackedID(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "a"})
	_, err := Enqueue(context.Background(), h.env, []Entry{{ID: "a", Repo: foo.Dir, Change: "a"}}, QueueOptions{}, "")
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v", err)
	}
}

func TestEnqueueDryRunWritesNothing(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.env.DryRun = true
	rec := h.queue("", Entry{ID: "a", Repo: foo.Dir, Change: "a"})
	if !rec.DryRun || len(rec.Items) != 1 {
		t.Fatalf("receipt = %+v", rec)
	}
	if _, err := os.Stat(h.env.StatePath); err == nil {
		t.Fatal("dry-run wrote the state file")
	}
}

func TestEnqueueStopStageNullAndSet(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("",
		Entry{ID: "a", Repo: foo.Dir, Change: "a", StopStage: ptr("hydrate")},
		Entry{ID: "b", Repo: foo.Dir, Change: "b"},
	)
	if got := operator.ScopeString(h.item("a").Scope, "stop_stage"); got != "hydrate" {
		t.Errorf("a stop_stage = %q", got)
	}
	if got := h.item("b").Scope["stop_stage"]; got != nil {
		t.Errorf("b stop_stage = %v, want null", got)
	}
}

func TestParseEntries(t *testing.T) {
	if _, err := ParseEntries([]byte(`{"id":"a"}`)); err == nil {
		t.Error("an object (not an array) must be rejected")
	}
	if _, err := ParseEntries([]byte(`[]`)); err == nil {
		t.Error("an empty queue must be rejected")
	}
	if _, err := ParseEntries([]byte(`[{"id":"a","repo":"/r","bogus":1}]`)); err == nil {
		t.Error("an unknown field must be rejected")
	}
	es, err := ParseEntries([]byte(`[{"id":"a","repo":"/r","change":"a","stop_stage":null,"depends_on":[]}]`))
	if err != nil || len(es) != 1 || es[0].DependsOn == nil || es[0].StopStage != nil {
		t.Fatalf("entries = %+v, err %v", es, err)
	}
}

func ptr(s string) *string { return &s }

func TestSafeBranchAndPRNumber(t *testing.T) {
	for _, bad := range []string{"", "-x", "--upload-pack=evil", "a..b", "a b", "a\nb", "a:b", "x.lock", "a~1", "a[b"} {
		if safeBranch(bad) != "" {
			t.Errorf("safeBranch(%q) accepted", bad)
		}
	}
	for _, ok := range []string{"main", "260101-ab12-x", "feat/x_y.z", "a+b"} {
		if safeBranch(ok) != ok {
			t.Errorf("safeBranch(%q) rejected", ok)
		}
	}
	if prNum(map[string]interface{}{"pr": "--web"}) != "" || prNum(map[string]interface{}{"pr": "12x"}) != "" {
		t.Error("prNum accepted a non-number")
	}
	if prNum(map[string]interface{}{"pr": 42}) != "42" || prNum(map[string]interface{}{"pr": float64(7)}) != "7" {
		t.Error("prNum rejected a number")
	}
}

func TestEnqueueRejectsAnOptionShapedChange(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	_, err := Enqueue(context.Background(), h.env, []Entry{{ID: "a", Repo: foo.Dir, Change: "--evil"}}, QueueOptions{}, "")
	var inv *InvalidError
	if !errors.As(err, &inv) || !strings.Contains(err.Error(), "invalid change") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseEntriesRejectsTrailingInput(t *testing.T) {
	for _, in := range []string{
		`[{"id":"a","repo":"/r","change":"a"}] [{"id":"b"}]`,
		`[{"id":"a","repo":"/r","change":"a"}]garbage`,
	} {
		if _, err := ParseEntries([]byte(in)); err == nil || !strings.Contains(err.Error(), "after the JSON array") {
			t.Errorf("ParseEntries(%q) err = %v", in, err)
		}
	}
	if _, err := ParseEntries([]byte("[{\"id\":\"a\",\"repo\":\"/r\",\"change\":\"a\"}]\n  \n")); err != nil {
		t.Errorf("trailing whitespace must be accepted: %v", err)
	}
}

func TestEscalationNoteTruncationIsRuneSafe(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	e := newEngine(h.env)
	long := strings.Repeat("é", operator.NoteTextCap+50)
	if err := e.recordEscalation("a", long); err != nil {
		t.Fatalf("recordEscalation: %v", err)
	}
	notes := h.item("a").Notes
	if len(notes) != 1 || utf8.RuneCountInString(notes[0].Text) != operator.NoteTextCap || !utf8.ValidString(notes[0].Text) {
		t.Fatalf("note = %d runes, valid=%v", utf8.RuneCountInString(notes[0].Text), utf8.ValidString(notes[0].Text))
	}
}

func TestEnqueueRejectsForwardAndCyclicDependencies(t *testing.T) {
	foo := newRepo(t, "foo")
	cases := []struct {
		name    string
		entries []Entry
	}{
		{"forward", []Entry{
			{ID: "a", Repo: foo.Dir, Task: "a", DependsOn: &[]string{"b"}},
			{ID: "b", Repo: foo.Dir, Task: "b", DependsOn: &[]string{}},
		}},
		{"cycle", []Entry{
			{ID: "a", Repo: foo.Dir, Task: "a", DependsOn: &[]string{"b"}},
			{ID: "b", Repo: foo.Dir, Task: "b", DependsOn: &[]string{"a"}},
		}},
		{"self", []Entry{{ID: "a", Repo: foo.Dir, Task: "a", DependsOn: &[]string{"a"}}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			_, err := Enqueue(context.Background(), h.env, c.entries, QueueOptions{}, "")
			var inv *InvalidError
			if !errors.As(err, &inv) || !strings.Contains(err.Error(), "a") {
				t.Fatalf("err = %v", err)
			}
			if _, statErr := os.Stat(h.env.StatePath); statErr == nil {
				t.Fatal("a rejected queue wrote the state file")
			}
		})
	}
	h := newHarness(t)
	_, err := Enqueue(context.Background(), h.env, cases[0].entries, QueueOptions{}, "")
	if err == nil || !strings.Contains(err.Error(), "a dependency must come before its dependent") || !strings.Contains(err.Error(), "b") {
		t.Fatalf("the error must name the offending ids: %v", err)
	}
}

func TestSafeBranchMatchesGitCheckRefFormat(t *testing.T) {
	pieces := []string{"a", "/", ".", "..", "@", "{", "}", "-", "~", "^", ":", "?", "*", "[", "\\", " ", ".lock", "é", "\x01", "\x7f", "b"}
	names := []string{"main", "feat/x", "foo@{1}", "foo//bar", "@", "@{", "HEAD", "-x", ".hidden", "a/.b", "a.lock", "a/b.lock/c",
		"a.", "/a", "a/", "a b", "a\\b", "a..b", "260101-ab12-x", "feat/x_y.z", "a+b", "x@y"}
	for _, p := range pieces {
		names = append(names, p)
		for _, q := range pieces {
			names = append(names, p+q, "a"+p+q)
		}
	}
	dir := t.TempDir()
	runGit(t, dir, "init")
	for _, n := range names {
		// git expands "@" and "HEAD" to the current branch; neither names one.
		want := gitOK(dir, "check-ref-format", "--branch", n) && n != "HEAD" && n != "@"
		if got := safeBranch(n) != ""; got != want {
			t.Errorf("safeBranch(%q) accepted=%v, git check-ref-format --branch accepts=%v", n, got, want)
		}
	}
}

func TestMisfitWithoutExplicitModeWritesNothing(t *testing.T) {
	h := newHarness(t)
	repo := newRepo(t, "repo")
	h.queue("", Entry{ID: "existing", Repo: repo.Dir, Task: "keep"})
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	deps := []string{"a"}
	entries := []Entry{{ID: "a", Repo: repo.Dir, Task: "a"}, {ID: "b", Repo: repo.Dir, Task: "b", DependsOn: &deps}}
	rec, err := Enqueue(context.Background(), h.env, entries, QueueOptions{}, operator.MergeModeMergeAuto)
	if err == nil || len(rec.Misfits) != 1 || !strings.Contains(err.Error(), "queue not written") {
		t.Fatalf("receipt = %+v, err = %v", rec, err)
	}
	after, err := os.ReadFile(h.env.StatePath)
	if err != nil || string(before) != string(after) {
		t.Fatal("misfit wrote state")
	}
	dry := h.env
	dry.DryRun = true
	rec, err = Enqueue(context.Background(), dry, entries, QueueOptions{}, operator.MergeModeMergeAuto)
	if err != nil || len(rec.Misfits) != 1 {
		t.Fatalf("preview = %+v, err = %v", rec, err)
	}
	if _, err := Enqueue(context.Background(), h.env, entries, QueueOptions{Mode: operator.MergeModeMergeAuto}, operator.MergeModeMergeAuto); err != nil {
		t.Fatal(err)
	}
	if len(h.state().Tracked) != 3 {
		t.Fatal("explicit confirmation did not persist all entries")
	}
}
