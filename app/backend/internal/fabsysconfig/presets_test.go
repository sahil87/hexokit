package fabsysconfig

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// nightShift is a user preset beside fab's three built-ins.
const nightShiftJSON = `{"name":"night-shift","description":"Overnight","source":"system","workers":"codex","profiles":{"review":{"cli":"codex","effort":"xhigh"}}}`

var userPresetsFixture = strings.TrimSuffix(presetsFixture, "]") + "," + nightShiftJSON + "]"

// onlyDescriptionFixture is a user preset whose sole field is its description.
var onlyDescriptionFixture = strings.TrimSuffix(presetsFixture, "]") +
	`,{"name":"solo","description":"Just a description","source":"system"}]`

func presetFake(t *testing.T, rows ...string) *fakeFab {
	t.Helper()
	f := newFake(t, rows...)
	f.presets = strings.TrimSuffix(userPresetsFixture, "]") +
		`,{"name":"from-env","description":"d","source":"env","workers":"codex"},{"name":"from-repo","description":"d","source":"project"}]`
	return f
}

func validationMsg(t *testing.T, err error) string {
	t.Helper()
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("err = %v, want ValidationError", err)
	}
	return ve.Msg
}

// ---- patch keys ----

func TestApply_presetLeafArgv(t *testing.T) {
	f := presetFake(t)
	patch := `{
		"agent_presets.late-shift.description":"Later",
		"agent_presets.late-shift.session":"claude",
		"agent_presets.late-shift.workers":"codex",
		"agent_presets.late-shift.profiles.review.cli":"codex",
		"agent_presets.late-shift.profiles.review.model":"gpt-5.6-sol",
		"agent_presets.late-shift.profiles.review.effort":"xhigh"}`
	if _, err := New(f.run).Apply(context.Background(), patchOf(t, patch)); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.late-shift.description Later --system",
		"config set agent_presets.late-shift.profiles.review.cli codex --system",
		"config set agent_presets.late-shift.profiles.review.effort xhigh --system",
		"config set agent_presets.late-shift.profiles.review.model gpt-5.6-sol --system",
		"config set agent_presets.late-shift.session claude --system",
		"config set agent_presets.late-shift.workers codex --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestApply_presetEmptyLeafUnsetsAndNullUnsets(t *testing.T) {
	f := presetFake(t)
	patch := `{"agent_presets.night-shift.profiles.review.effort":"","agent_presets.night-shift.workers":null}`
	if _, err := New(f.run).Apply(context.Background(), patchOf(t, patch)); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config unset agent_presets.night-shift.profiles.review.effort --system",
		"config unset agent_presets.night-shift.workers --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestApply_wholePresetNullUnsetsIt(t *testing.T) {
	f := presetFake(t)
	if _, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent_presets.night-shift":null}`)); err != nil {
		t.Fatal(err)
	}
	want := []string{"config unset agent_presets.night-shift --system"}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestApply_presetKeysRejectBeforeExec(t *testing.T) {
	cases := map[string]struct{ body, wantMsg string }{
		"built-in name":     {`{"agent_presets.claude.description":"x"}`, "agent_presets.claude.description: " + errBuiltInReadOnly},
		"built-in removal":  {`{"agent_presets.codex-review":null}`, "agent_presets.codex-review: " + errBuiltInReadOnly},
		"none":              {`{"agent_presets.none.description":"x"}`, `agent_presets.none.description: "none" is reserved; it means no preset`},
		"bad charset":       {`{"agent_presets.night shift.description":"x"}`, "agent_presets.night shift.description: Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"leading dash":      {`{"agent_presets.-x.description":"x"}`, "agent_presets.-x.description: Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"empty name":        {`{"agent_presets..description":"x"}`, "agent_presets..description: Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"unknown field":     {`{"agent_presets.p.color":"x"}`, "agent_presets.p.color: unknown preset field"},
		"unknown role":      {`{"agent_presets.p.profiles.boss.cli":"codex"}`, "agent_presets.p.profiles.boss.cli: unknown preset field"},
		"tool leaf":         {`{"agent_presets.p.profiles.review.tool":"codex"}`, "agent_presets.p.profiles.review.tool: a preset's tool leaf is spelled cli"},
		"provider leaf":     {`{"agent_presets.p.profiles.review.provider":"codex"}`, "agent_presets.p.profiles.review.provider: a preset's tool leaf is spelled cli"},
		"unknown CLI":       {`{"agent_presets.p.workers":"bogus"}`, "agent_presets.p.workers: unknown CLI \"bogus\" (available: agy, claude, codex, kimi)"},
		"unknown role cli":  {`{"agent_presets.p.profiles.review.cli":"bogus"}`, "agent_presets.p.profiles.review.cli: unknown CLI \"bogus\" (available: agy, claude, codex, kimi)"},
		"empty description": {`{"agent_presets.p.description":""}`, "agent_presets.p.description: must not be empty"},
		"hash in model":     {`{"agent_presets.p.profiles.review.model":"a # b"}`, "agent_presets.p.profiles.review.model: must not contain '#'"},
		"dash in effort":    {`{"agent_presets.p.profiles.review.effort":"-x"}`, "agent_presets.p.profiles.review.effort: must not start with '-'"},
		"not a string":      {`{"agent_presets.p.description":3}`, "agent_presets.p.description: must be a string"},
		"whole non-null":    {`{"agent_presets.p":"x"}`, "agent_presets.p: a whole preset can only be removed (null)"},
		"trailing dot":      {`{"agent_presets.night-shift.":null}`, "agent_presets.night-shift.: unknown preset field"},
		"env-source name":   {`{"agent_presets.from-env.workers":"codex"}`, "agent_presets.from-env.workers: " + errNotInSystemConfig},
		"project-source":    {`{"agent_presets.from-repo":null}`, "agent_presets.from-repo: " + errNotInSystemConfig},
		"remove and edit":   {`{"agent_presets.night-shift":null,"agent_presets.night-shift.workers":"claude"}`, "agent_presets.night-shift: a preset is removed alone, not together with changes to its fields"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := presetFake(t)
			_, err := New(f.run).Apply(context.Background(), patchOf(t, tc.body))
			if got := validationMsg(t, err); got != tc.wantMsg {
				t.Errorf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := f.mutations(); len(got) != 0 {
				t.Errorf("mutations = %v, want none", got)
			}
		})
	}
}

func TestApply_presetKeysNeedAPresetList(t *testing.T) {
	f := newFake(t)
	_, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent_presets.p.description":"x"}`))
	if got := validationMsg(t, err); !strings.Contains(got, "not supported") {
		t.Errorf("message = %q, want the unsupported-fab reason", got)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Errorf("mutations = %v, want none", got)
	}
}

func TestApply_presetListIsFetchedBeforeTheWrite(t *testing.T) {
	f := presetFake(t)
	if _, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent_presets.p.description":"x"}`)); err != nil {
		t.Fatal(err)
	}
	firstList, firstWrite := -1, -1
	for i, call := range f.callLog() {
		if len(call) > 1 && call[0] == "agent" && call[1] == "presets" && firstList < 0 {
			firstList = i
		}
		if len(call) > 1 && call[1] == "set" && firstWrite < 0 {
			firstWrite = i
		}
	}
	if firstList < 0 || firstList > firstWrite {
		t.Errorf("preset list at call %d, first write at %d, want the list first", firstList, firstWrite)
	}
}

// ---- last-field guard ----

func TestApply_lastFieldGuard(t *testing.T) {
	cases := map[string]struct {
		presets string
		body    string
		wantErr string
	}{
		"the only field":            {onlyDescriptionFixture, `{"agent_presets.solo.description":null}`, "agent_presets.solo: " + errLastField},
		"every remaining field":     {userPresetsFixture, `{"agent_presets.night-shift.description":null,"agent_presets.night-shift.workers":null,"agent_presets.night-shift.profiles.review.cli":null,"agent_presets.night-shift.profiles.review.effort":""}`, "agent_presets.night-shift: " + errLastField},
		"one of several":            {userPresetsFixture, `{"agent_presets.night-shift.workers":null}`, ""},
		"swap the only field":       {onlyDescriptionFixture, `{"agent_presets.solo.description":null,"agent_presets.solo.workers":"codex"}`, ""},
		"unlisted preset, only set": {userPresetsFixture, `{"agent_presets.fresh.description":"x"}`, ""},
		"unlisted preset, unset":    {userPresetsFixture, `{"agent_presets.ghost.workers":null}`, ""},
		"whole removal":             {onlyDescriptionFixture, `{"agent_presets.solo":null}`, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.presets = tc.presets
			_, err := New(f.run).Apply(context.Background(), patchOf(t, tc.body))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				return
			}
			if got := validationMsg(t, err); got != tc.wantErr {
				t.Errorf("message = %q, want %q", got, tc.wantErr)
			}
			if got := f.mutations(); len(got) != 0 {
				t.Errorf("mutations = %v, want none", got)
			}
		})
	}
}

// ---- duplicate ----

func TestDuplicatePreset_copiesABuiltInWithADescriptionOverride(t *testing.T) {
	f := presetFake(t)
	_, err := New(f.run).DuplicatePreset(context.Background(), "codex-review", "codex-review-copy", "Review on Codex, mine")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.codex-review-copy.description Review on Codex, mine --system",
		"config set agent_presets.codex-review-copy.profiles.review.cli codex --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestDuplicatePreset_copiesEveryFieldInWriteOrder(t *testing.T) {
	f := presetFake(t)
	if _, err := New(f.run).DuplicatePreset(context.Background(), "night-shift", "night-shift-copy", ""); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.night-shift-copy.description Overnight --system",
		"config set agent_presets.night-shift-copy.workers codex --system",
		"config set agent_presets.night-shift-copy.profiles.review.cli codex --system",
		"config set agent_presets.night-shift-copy.profiles.review.effort xhigh --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestDuplicatePreset_rejectsBeforeExec(t *testing.T) {
	noDesc := strings.TrimSuffix(presetsFixture, "]") + `,{"name":"bare","source":"system","workers":"codex"}]`
	cases := map[string]struct{ presets, from, to, desc, wantMsg string }{
		"unknown source":     {userPresetsFixture, "ghost", "x", "", `unknown agent preset "ghost"`},
		"taken":              {userPresetsFixture, "claude", "night-shift", "", "A preset named night-shift already exists."},
		"taken by built-in":  {userPresetsFixture, "night-shift", "claude", "", "A preset named claude already exists."},
		"none":               {userPresetsFixture, "claude", "none", "", errPresetNone},
		"bad charset":        {userPresetsFixture, "claude", "a b", "", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"leading dash":       {userPresetsFixture, "claude", "-x", "", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"source has no desc": {noDesc, "bare", "bare-copy", "", "a preset needs a description"},
		"bad description":    {userPresetsFixture, "claude", "x", "a # b", "description: must not contain '#'"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.presets = tc.presets
			_, err := New(f.run).DuplicatePreset(context.Background(), tc.from, tc.to, tc.desc)
			if got := validationMsg(t, err); got != tc.wantMsg {
				t.Errorf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := f.mutations(); len(got) != 0 {
				t.Errorf("mutations = %v, want none", got)
			}
		})
	}
}

func TestDuplicatePreset_aSourceWithoutADescriptionTakesTheGivenOne(t *testing.T) {
	f := newFake(t)
	f.presets = strings.TrimSuffix(presetsFixture, "]") + `,{"name":"bare","source":"system","workers":"codex"}]`
	if _, err := New(f.run).DuplicatePreset(context.Background(), "bare", "bare-copy", "Given"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.bare-copy.description Given --system",
		"config set agent_presets.bare-copy.workers codex --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestDuplicatePreset_withoutAPresetListIsUnsupported(t *testing.T) {
	f := newFake(t)
	_, err := New(f.run).DuplicatePreset(context.Background(), "claude", "x", "d")
	if !errors.Is(err, ErrPresetsUnsupported) {
		t.Errorf("err = %v, want ErrPresetsUnsupported", err)
	}
}

func TestPresetOps_notInstalled(t *testing.T) {
	f := presetFake(t)
	c := New(f.run).WithLookPath(func(string) (string, error) { return "", errors.New("missing") })
	ctx := context.Background()
	if _, err := c.DuplicatePreset(ctx, "claude", "x", "d"); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("duplicate err = %v", err)
	}
	if _, err := c.RenamePreset(ctx, "night-shift", "x", nil); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("rename err = %v", err)
	}
	if _, err := c.DeletePreset(ctx, "night-shift", nil); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("delete err = %v", err)
	}
	if _, err := c.MoveLeftovers(ctx, "x", "d"); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("move err = %v", err)
	}
	if _, err := c.ClearLeftovers(ctx); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("clear err = %v", err)
	}
	if _, err := c.ResolvePreset(ctx, "claude"); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("resolve err = %v", err)
	}
	if len(f.callLog()) != 0 {
		t.Errorf("calls = %v, want none", f.callLog())
	}
}

// ---- rename / delete with tmux bindings ----

// fakeBindings is the tmux side: two servers, a workspace and groups naming
// presets. Every Set/Clear records the fab mutations already made, so ordering
// against the fab writes is assertable.
type fakeBindings struct {
	f       *fakeFab
	list    []PresetBinding
	listErr error
	failOn  string // "<server>/<session>" whose Set/Clear fails
	calls   []string
	seenMut [][]string
}

func (b *fakeBindings) List(context.Context) ([]PresetBinding, error) { return b.list, b.listErr }

func (b *fakeBindings) record(verb string, pb PresetBinding, name string) error {
	b.calls = append(b.calls, verb+" "+pb.Server+"/"+pb.Session+" "+name)
	b.seenMut = append(b.seenMut, b.f.mutations())
	if b.failOn == pb.Server+"/"+pb.Session {
		return errors.New("tmux refused")
	}
	return nil
}

func (b *fakeBindings) Set(_ context.Context, pb PresetBinding, name string) error {
	return b.record("set", pb, name)
}

func (b *fakeBindings) Clear(_ context.Context, pb PresetBinding) error {
	return b.record("clear", pb, "")
}

// usedEverywhere has night-shift named by a workspace and a group on one
// server and a group on another, plus an unrelated binding.
func usedEverywhere(f *fakeFab) *fakeBindings {
	return &fakeBindings{f: f, list: []PresetBinding{
		{Server: "default", Preset: "night-shift"},
		{Server: "default", Session: "hexokit", Preset: "night-shift"},
		{Server: "default", Session: "other", Preset: "claude"},
		{Server: "work", Session: "api", Preset: "night-shift"},
	}}
}

func machineDefaultRows(preset, origin string) []string {
	return append(baseRows(), row("agent.preset", `"`+preset+`"`, origin, systemPath))
}

func TestRenamePreset_repointsEverythingThenRemovesTheOld(t *testing.T) {
	f := presetFake(t, machineDefaultRows("night-shift", "system")...)
	b := usedEverywhere(f)
	if _, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", b); err != nil {
		t.Fatal(err)
	}
	wantMut := []string{
		"config set agent_presets.late-shift.description Overnight --system",
		"config set agent_presets.late-shift.workers codex --system",
		"config set agent_presets.late-shift.profiles.review.cli codex --system",
		"config set agent_presets.late-shift.profiles.review.effort xhigh --system",
		"config set agent.preset late-shift --system",
		"config unset agent_presets.night-shift --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, wantMut) {
		t.Errorf("mutations = %v, want %v", got, wantMut)
	}
	wantCalls := []string{"set default/ late-shift", "set default/hexokit late-shift", "set work/api late-shift"}
	if !reflect.DeepEqual(b.calls, wantCalls) {
		t.Errorf("tmux calls = %v, want %v", b.calls, wantCalls)
	}
	for i, seen := range b.seenMut {
		if len(seen) != 5 {
			t.Errorf("repoint %d ran after %d fab writes, want the new preset and the default (5) before it and the removal after", i, len(seen))
		}
	}
}

func TestRenamePreset_sameNameIsANoOp(t *testing.T) {
	f := presetFake(t)
	b := usedEverywhere(f)
	if _, err := New(f.run).RenamePreset(context.Background(), "night-shift", "night-shift", b); err != nil {
		t.Fatal(err)
	}
	if got := f.mutations(); len(got) != 0 || len(b.calls) != 0 {
		t.Errorf("mutations = %v, tmux = %v, want none", got, b.calls)
	}
}

func TestRenamePreset_rejectsBeforeExec(t *testing.T) {
	cases := map[string]struct{ from, to, wantMsg string }{
		"built-in source":   {"claude", "x", errBuiltInReadOnly},
		"unknown source":    {"ghost", "x", `unknown agent preset "ghost"`},
		"taken by built-in": {"night-shift", "codex-workers", "A preset named codex-workers already exists."},
		"none":              {"night-shift", "none", errPresetNone},
		"bad charset":       {"night-shift", "a b", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"bad source name":   {"-x", "y", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"taken by yours":    {"night-shift", "solo", "A preset named solo already exists."},
		"source is a taken": {"solo", "night-shift", "A preset named night-shift already exists."},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.presets = strings.TrimSuffix(userPresetsFixture, "]") + `,{"name":"solo","description":"d","source":"system"}]`
			b := usedEverywhere(f)
			_, err := New(f.run).RenamePreset(context.Background(), tc.from, tc.to, b)
			if got := validationMsg(t, err); got != tc.wantMsg {
				t.Errorf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := f.mutations(); len(got) != 0 || len(b.calls) != 0 {
				t.Errorf("mutations = %v, tmux = %v, want none", got, b.calls)
			}
		})
	}
}

func TestRenamePreset_aFabFailureKeepsTheOldPresetAndNamesWhatLanded(t *testing.T) {
	f := presetFake(t, machineDefaultRows("night-shift", "system")...)
	f.failOn = "config set agent.preset"
	f.failMsg = "disk full"
	b := usedEverywhere(f)
	_, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", b)
	var pw *PartialWriteError
	if !errors.As(err, &pw) {
		t.Fatalf("err = %v, want PartialWriteError", err)
	}
	if pw.Failed != "set agent.preset late-shift" || pw.Stderr != "disk full" || len(pw.Landed) != 4 {
		t.Errorf("failure = %+v", pw)
	}
	if pw.Landed[0] != "set agent_presets.late-shift.description Overnight" {
		t.Errorf("first landed = %q", pw.Landed[0])
	}
	for _, m := range f.mutations() {
		if strings.HasPrefix(m, "config unset agent_presets.night-shift") {
			t.Errorf("the old preset was removed: %v", f.mutations())
		}
	}
	if len(b.calls) != 0 {
		t.Errorf("tmux repoint ran after a failed write: %v", b.calls)
	}
	if !strings.Contains(pw.Error(), "set agent.preset late-shift failed: disk full") {
		t.Errorf("message = %q", pw.Error())
	}
}

func TestRenamePreset_aTmuxFailureStopsBeforeTheRemoval(t *testing.T) {
	f := presetFake(t, machineDefaultRows("night-shift", "system")...)
	b := usedEverywhere(f)
	b.failOn = "default/hexokit"
	_, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", b)
	var pw *PartialWriteError
	if !errors.As(err, &pw) {
		t.Fatalf("err = %v, want PartialWriteError", err)
	}
	if pw.Failed != "repoint group hexokit (default)" || pw.Stderr != "tmux refused" {
		t.Errorf("failure = %+v", pw)
	}
	if got := pw.Landed[len(pw.Landed)-1]; got != "repoint workspace default" {
		t.Errorf("last landed = %q", got)
	}
	for _, m := range f.mutations() {
		if strings.HasPrefix(m, "config unset agent_presets.night-shift") {
			t.Errorf("the old preset was removed: %v", f.mutations())
		}
	}
}

func TestRenamePreset_aTmuxListFailureWritesNothing(t *testing.T) {
	f := presetFake(t)
	b := usedEverywhere(f)
	b.listErr = errors.New("no tmux")
	_, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", b)
	if err == nil || !strings.Contains(err.Error(), "no tmux") {
		t.Fatalf("err = %v", err)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Errorf("mutations = %v, want none", got)
	}
}

func TestRenamePreset_envOriginDefaultIsLeftAloneWithAWarning(t *testing.T) {
	rows := append(baseRows(), row("agent.preset", `"night-shift"`, "env", "FAB_AGENT_PRESET"))
	f := presetFake(t, rows...)
	f.stacks["agent.preset"] = showJSON(
		row("agent.preset", `"night-shift"`, "env", "FAB_AGENT_PRESET"),
		row("agent.preset", `"claude"`, "system", systemPath))
	doc, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range f.mutations() {
		if strings.HasPrefix(m, "config set agent.preset") {
			t.Errorf("agent.preset was written: %v", f.mutations())
		}
	}
	if !containsLine(doc.Warnings, `agent.preset is set to "night-shift" in the daemon's environment`) {
		t.Errorf("warnings = %v", doc.Warnings)
	}
}

func TestRenamePreset_aSystemDefaultShadowedByEnvIsStillRepointed(t *testing.T) {
	rows := append(baseRows(), row("agent.preset", `"claude"`, "env", "FAB_AGENT_PRESET"))
	f := presetFake(t, rows...)
	f.stacks["agent.preset"] = showJSON(
		row("agent.preset", `"claude"`, "env", "FAB_AGENT_PRESET"),
		row("agent.preset", `"night-shift"`, "system", systemPath))
	if _, err := New(f.run).RenamePreset(context.Background(), "night-shift", "late-shift", nil); err != nil {
		t.Fatal(err)
	}
	if !containsLine(f.mutations(), "config set agent.preset late-shift --system") {
		t.Errorf("mutations = %v", f.mutations())
	}
}

func containsLine(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func TestDeletePreset_clearsEverythingThenRemoves(t *testing.T) {
	f := presetFake(t, machineDefaultRows("night-shift", "system")...)
	b := usedEverywhere(f)
	if _, err := New(f.run).DeletePreset(context.Background(), "night-shift", b); err != nil {
		t.Fatal(err)
	}
	wantMut := []string{
		"config unset agent.preset --system",
		"config unset agent_presets.night-shift --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, wantMut) {
		t.Errorf("mutations = %v, want %v", got, wantMut)
	}
	wantCalls := []string{"clear default/ ", "clear default/hexokit ", "clear work/api "}
	if !reflect.DeepEqual(b.calls, wantCalls) {
		t.Errorf("tmux calls = %v, want %v", b.calls, wantCalls)
	}
	for i, seen := range b.seenMut {
		if len(seen) != 1 {
			t.Errorf("clear %d ran after %d fab writes, want only the default's unset", i, len(seen))
		}
	}
}

func TestDeletePreset_unusedJustUnsets(t *testing.T) {
	f := presetFake(t, machineDefaultRows("claude", "system")...)
	b := &fakeBindings{f: f}
	if _, err := New(f.run).DeletePreset(context.Background(), "night-shift", b); err != nil {
		t.Fatal(err)
	}
	want := []string{"config unset agent_presets.night-shift --system"}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestDeletePreset_rejectsBeforeExec(t *testing.T) {
	for name, tc := range map[string]struct{ preset, wantMsg string }{
		"built-in":             {"claude", errBuiltInReadOnly},
		"from the environment": {"from-env", errNotInSystemConfig},
		"unknown":              {"ghost", `unknown agent preset "ghost"`},
		"bad name":             {"a b", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
	} {
		t.Run(name, func(t *testing.T) {
			f := presetFake(t)
			f.presets = strings.TrimSuffix(userPresetsFixture, "]") + `,{"name":"from-env","description":"d","source":"env","workers":"codex"}]`
			b := usedEverywhere(f)
			_, err := New(f.run).DeletePreset(context.Background(), tc.preset, b)
			if got := validationMsg(t, err); got != tc.wantMsg {
				t.Errorf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := f.mutations(); len(got) != 0 || len(b.calls) != 0 {
				t.Errorf("mutations = %v, tmux = %v, want none", got, b.calls)
			}
		})
	}
}

func TestDeletePreset_aTmuxFailureKeepsThePreset(t *testing.T) {
	f := presetFake(t)
	b := usedEverywhere(f)
	b.failOn = "work/api"
	_, err := New(f.run).DeletePreset(context.Background(), "night-shift", b)
	var pw *PartialWriteError
	if !errors.As(err, &pw) || pw.Failed != "clear group api (work)" {
		t.Fatalf("err = %v", err)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Errorf("mutations = %v, want none (the preset must survive)", got)
	}
}

// ---- leftovers ----

func looseRows() []string {
	return []string{
		row("agent.preset", `"codex-workers"`, "system", systemPath),
		row("agent.session", `"claude"`, "default", ""),
		row("agent.workers", `"codex"`, "system", "preset codex-workers"),
		row("agent.profiles.review.provider", `"codex"`, "system", systemPath),
		row("agent.profiles.review.effort", `"xhigh"`, "system", systemPath),
		row("agent.profiles.doing.model", `"claude-sonnet-5-5"`, "default", ""),
		row("providers.claude.interactive_command", `"claude"`, "default", ""),
		row("providers.codex.interactive_command", `"codex"`, "default", ""),
	}
}

func TestMoveLeftovers_overlaysTheDefaultPresetAndUnsetsTheLooseKeys(t *testing.T) {
	f := newFake(t, looseRows()...)
	f.presets = presetsFixture
	if _, err := New(f.run).MoveLeftovers(context.Background(), "my-overrides", "Moved from loose machine-wide settings"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.my-overrides.description Moved from loose machine-wide settings --system",
		"config set agent_presets.my-overrides.workers codex --system",
		"config set agent_presets.my-overrides.profiles.review.cli codex --system",
		"config set agent_presets.my-overrides.profiles.review.effort xhigh --system",
		"config set agent.preset my-overrides --system",
		"config unset agent.profiles.review.provider --system",
		"config unset agent.profiles.review.effort --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestMoveLeftovers_withoutADefaultPresetUsesOnlyTheLooseValues(t *testing.T) {
	f := newFake(t,
		row("agent.session", `"codex"`, "system", systemPath),
		row("agent.profiles.review.cli", `"codex"`, "system", systemPath),
		row("agent.profiles.review.provider", `"claude"`, "system", systemPath),
		row("providers.codex.interactive_command", `"codex"`, "default", ""))
	f.presets = presetsFixture
	if _, err := New(f.run).MoveLeftovers(context.Background(), "mine", "d"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent_presets.mine.description d --system",
		"config set agent_presets.mine.session codex --system",
		"config set agent_presets.mine.profiles.review.cli codex --system",
		"config set agent.preset mine --system",
		"config unset agent.session --system",
		"config unset agent.profiles.review.provider --system",
		"config unset agent.profiles.review.cli --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestMoveLeftovers_rejectsBeforeExec(t *testing.T) {
	cases := map[string]struct{ name, desc, wantMsg string }{
		"taken":          {"claude", "d", "A preset named claude already exists."},
		"none":           {"none", "d", errPresetNone},
		"bad charset":    {"a b", "d", "Agent preset name must contain only alphanumeric characters, hyphens, and underscores, and must not start with a hyphen"},
		"no description": {"mine", "  ", "description: must not be empty"},
		"hash":           {"mine", "a # b", "description: must not contain '#'"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t, looseRows()...)
			f.presets = presetsFixture
			_, err := New(f.run).MoveLeftovers(context.Background(), tc.name, tc.desc)
			if got := validationMsg(t, err); got != tc.wantMsg {
				t.Errorf("message = %q, want %q", got, tc.wantMsg)
			}
			if got := f.mutations(); len(got) != 0 {
				t.Errorf("mutations = %v, want none", got)
			}
		})
	}
}

func TestMoveLeftovers_noLooseValuesIsRefused(t *testing.T) {
	f := newFake(t, row("agent.session", `"claude"`, "default", ""), row("providers.claude.interactive_command", `"claude"`, "default", ""))
	f.presets = presetsFixture
	_, err := New(f.run).MoveLeftovers(context.Background(), "mine", "d")
	if got := validationMsg(t, err); got != "there are no loose settings to move" {
		t.Errorf("message = %q", got)
	}
}

func TestMoveLeftovers_aFailureNamesWhatLandedAndKeepsTheLooseKeys(t *testing.T) {
	f := newFake(t, looseRows()...)
	f.presets = presetsFixture
	f.failOn = "config set agent.preset"
	f.failMsg = "locked"
	_, err := New(f.run).MoveLeftovers(context.Background(), "mine", "d")
	var pw *PartialWriteError
	if !errors.As(err, &pw) || pw.Failed != "set agent.preset mine" || len(pw.Landed) != 4 {
		t.Fatalf("err = %v", err)
	}
	for _, m := range f.mutations() {
		if strings.HasPrefix(m, "config unset") {
			t.Errorf("a loose key was unset before the preset became the default: %v", f.mutations())
		}
	}
}

func TestClearLeftovers_unsetsTheLooseKeysOnly(t *testing.T) {
	f := newFake(t, looseRows()...)
	f.presets = presetsFixture
	if _, err := New(f.run).ClearLeftovers(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config unset agent.profiles.review.provider --system",
		"config unset agent.profiles.review.effort --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestClearLeftovers_nothingLooseWritesNothing(t *testing.T) {
	f := newFake(t, row("agent.session", `"claude"`, "env", "FAB_AGENT_SESSION"))
	f.stacks["agent.session"] = showJSON(row("agent.session", `"claude"`, "env", "FAB_AGENT_SESSION"))
	f.presets = presetsFixture
	if _, err := New(f.run).ClearLeftovers(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Errorf("mutations = %v, want none (env values are not leftovers)", got)
	}
}

func TestClearLeftovers_aFailureNamesWhatLanded(t *testing.T) {
	f := newFake(t, looseRows()...)
	f.presets = presetsFixture
	f.failOn = "config unset agent.profiles.review.effort"
	f.failMsg = "locked"
	_, err := New(f.run).ClearLeftovers(context.Background())
	var pw *PartialWriteError
	if !errors.As(err, &pw) || pw.Failed != "unset agent.profiles.review.effort" || !reflect.DeepEqual(pw.Landed, []string{"unset agent.profiles.review.provider"}) {
		t.Fatalf("err = %v", err)
	}
}

// ---- per-role resolution ----

func TestResolvePreset_decodesEachRoleAndToleratesFailures(t *testing.T) {
	f := presetFake(t)
	f.resolved = map[string]string{
		"review codex-review":   "selector: review\ncli: codex\nprovider: codex\nmodel: gpt-5.6-sol\neffort: xhigh\npreset: codex-review\n",
		"doing codex-review":    "cli: claude\nmodel: claude-sonnet-5-5\neffort: \"\"\n",
		"hydrate codex-review":  "provider: claude\nmodel: m\n",
		"operator codex-review": "not: [valid",
	}
	got, err := New(f.run).ResolvePreset(context.Background(), "codex-review")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]ResolvedRole{
		"review":   {CLI: "codex", Model: "gpt-5.6-sol", Effort: "xhigh"},
		"doing":    {CLI: "claude", Model: "claude-sonnet-5-5"},
		"hydrate":  {CLI: "claude", Model: "m"},
		"operator": {},
		"default":  {},
		"fast":     {},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("resolved = %+v, want %+v", got, want)
	}
	for _, call := range f.callLog() {
		if call[0] != "agent" {
			t.Errorf("unexpected call %v", call)
			continue
		}
		if call[2] != "--preset" || call[3] != "codex-review" || call[4] != "-o" || call[5] != "yaml" {
			t.Errorf("argv = %v", call)
		}
	}
	if n := len(f.callLog()); n != len(Roles) {
		t.Errorf("fab calls = %d, want one per role (%d)", n, len(Roles))
	}
}

func TestResolvePreset_rejectsABadNameBeforeExec(t *testing.T) {
	f := presetFake(t)
	for _, name := range []string{"", "-x", "a b", "a;b"} {
		_, err := New(f.run).ResolvePreset(context.Background(), name)
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("name %q: err = %v, want ValidationError", name, err)
		}
	}
	if len(f.callLog()) != 0 {
		t.Errorf("calls = %v, want none", f.callLog())
	}
}
