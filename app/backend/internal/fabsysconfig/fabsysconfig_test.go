package fabsysconfig

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

const systemPath = "/home/u/.fab-kit/config.yaml"

// fakeFab is a scripted Runner: responses are keyed by the space-joined argv,
// every call is recorded, and an unscripted argv fails the test — so no test
// can reach the real binary or the developer's ~/.fab-kit/config.yaml.
type fakeFab struct {
	t       *testing.T
	show    string
	explain string
	stacks  map[string]string // key → `show <key> --origin --json` output
	failOn  string            // argv prefix that exits non-zero
	failMsg string
	setErr  string // stderr emitted by every successful set/unset
	calls   [][]string
}

func (f *fakeFab) run(_ context.Context, argv ...string) ([]byte, []byte, error) {
	f.calls = append(f.calls, argv)
	joined := strings.Join(argv, " ")
	if f.failOn != "" && strings.HasPrefix(joined, f.failOn) {
		return nil, []byte(f.failMsg), errors.New("exit 1")
	}
	switch {
	case joined == "config show --origin --json":
		return []byte(f.show), nil, nil
	case joined == "config explain --json":
		return []byte(f.explain), nil, nil
	case strings.HasPrefix(joined, "config show ") && strings.HasSuffix(joined, " --origin --json"):
		key := argv[2]
		if out, ok := f.stacks[key]; ok {
			return []byte(out), nil, nil
		}
	case strings.HasPrefix(joined, "config set "), strings.HasPrefix(joined, "config unset "):
		return nil, []byte(f.setErr), nil
	}
	f.t.Fatalf("unscripted fab call: %s", joined)
	return nil, nil, nil
}

func (f *fakeFab) mutations() []string {
	var out []string
	for _, c := range f.calls {
		if len(c) > 1 && (c[1] == "set" || c[1] == "unset") {
			out = append(out, strings.Join(c, " "))
		}
	}
	return out
}

func row(key, valueJSON, origin, detail string) string {
	return `{"key":"` + key + `","value":` + valueJSON + `,"origin":"` + origin + `","origin_detail":"` + detail + `","status":"effective"}`
}

func derivedRow(key, valueJSON, from string) string {
	return `{"key":"` + key + `","value":` + valueJSON + `,"origin":"default","origin_detail":"","status":"effective","derived_from":{"key":"` + from + `","origin":"system","origin_detail":"` + systemPath + `"}}`
}

func showJSON(rows ...string) string { return "[" + strings.Join(rows, ",") + "]" }

// baseRows is a machine with claude as both depths, a system model override
// for `doing`, and a four-provider table.
func baseRows() []string {
	return []string{
		row("agent.session", `"claude"`, "system", systemPath),
		row("agent.workers", `"claude"`, "system", systemPath),
		row("dispatch.mode", `"pane"`, "system", systemPath),
		row("dispatch.column_width", `45`, "default", ""),
		row("dispatch.min_cols", `50`, "default", ""),
		row("dispatch.min_rows", `20`, "default", ""),
		row("dispatch.reap_done", `true`, "default", ""),
		derivedRow("agent.profiles.default.provider", `"claude"`, "agent.session"),
		derivedRow("agent.profiles.operator.provider", `"claude"`, "agent.session"),
		derivedRow("agent.profiles.doing.provider", `"claude"`, "agent.workers"),
		derivedRow("agent.profiles.fast.provider", `"claude"`, "agent.workers"),
		derivedRow("agent.profiles.hydrate.provider", `"claude"`, "agent.workers"),
		derivedRow("agent.profiles.review.provider", `"claude"`, "agent.workers"),
		row("agent.profiles.doing.model", `"claude-sonnet-5-5"`, "system", systemPath),
		row("providers.agy.interactive_command", `"agy"`, "default", ""),
		row("providers.agy.profiles.default.model", `"gemini-3.1-pro-high"`, "default", ""),
		row("providers.claude.profiles.review.model", `"claude-opus-5-5"`, "default", ""),
		row("providers.claude.profiles.review.effort", `"high"`, "default", ""),
		row("providers.claude.profiles.doing.model", `"claude-sonnet-5-5"`, "default", ""),
		row("providers.codex.profiles.review.model", `"gpt-5.6-sol"`, "default", ""),
		row("providers.kimi.interactive_command", `"kimi"`, "default", ""),
	}
}

func newFake(t *testing.T, rows ...string) *fakeFab {
	t.Helper()
	if len(rows) == 0 {
		rows = baseRows()
	}
	return &fakeFab{
		t:       t,
		show:    showJSON(rows...),
		explain: `[{"key":"agent.workers","description":"Provider for worker stages"}]`,
		stacks:  map[string]string{},
	}
}

func patchOf(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	var p map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("bad patch fixture: %v", err)
	}
	return p
}

func roleByName(t *testing.T, doc *Document, name string) Role {
	t.Helper()
	for _, r := range doc.Roles {
		if r.Role == name {
			return r
		}
	}
	t.Fatalf("role %q missing", name)
	return Role{}
}

func TestRead_notInstalled(t *testing.T) {
	c := New(func(context.Context, ...string) ([]byte, []byte, error) {
		t.Fatal("fab must not be run when it is not installed")
		return nil, nil, nil
	}).WithLookPath(func(string) (string, error) { return "", errors.New("not found") })

	doc, err := c.Read(context.Background())
	if err != nil || doc.Installed {
		t.Fatalf("Read = (%+v, %v), want installed:false and no error", doc, err)
	}
	b, _ := json.Marshal(doc)
	if string(b) != `{"installed":false}` {
		t.Errorf("json = %s, want {\"installed\":false}", b)
	}
}

func TestRead_buildsDocument(t *testing.T) {
	f := newFake(t)
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !doc.Installed || doc.SystemPath != systemPath {
		t.Errorf("installed/systemPath = %v/%q", doc.Installed, doc.SystemPath)
	}
	if want := []string{"agy", "claude", "codex", "kimi"}; !reflect.DeepEqual(doc.Providers, want) {
		t.Errorf("providers = %v, want %v (derived from providers.<name>.* keys)", doc.Providers, want)
	}
	w := doc.Fields["agent.workers"]
	if w.Value != "claude" || w.Origin != "system" || w.OriginDetail != systemPath || w.Description != "Provider for worker stages" {
		t.Errorf("agent.workers = %+v", w)
	}
	if cw := doc.Fields["dispatch.column_width"]; cw.Value != float64(45) || cw.Origin != "default" {
		t.Errorf("column_width = %+v", cw)
	}
	if rp := doc.Fields["dispatch.reap_done"]; rp.Value != true {
		t.Errorf("reap_done = %+v", rp)
	}
	if got := doc.ModelSuggestions["claude"]; !reflect.DeepEqual(got, []string{"claude-opus-5-5", "claude-sonnet-5-5"}) {
		t.Errorf("claude suggestions = %v", got)
	}
	if got := doc.ModelSuggestions["kimi"]; got == nil || len(got) != 0 {
		t.Errorf("kimi suggestions = %v, want empty non-nil", got)
	}

	var order []string
	for _, r := range doc.Roles {
		order = append(order, r.Role+"/"+r.Depth)
	}
	want := []string{"default/session", "operator/session", "doing/workers", "fast/workers", "hydrate/workers", "review/workers"}
	if !reflect.DeepEqual(order, want) {
		t.Errorf("role order = %v, want %v", order, want)
	}
}

func TestRead_roleCells(t *testing.T) {
	f := newFake(t)
	doc, _ := New(f.run).Read(context.Background())

	doing := roleByName(t, doc, "doing")
	if doing.Provider.Override != nil || doing.Provider.Effective != "claude" || doing.Provider.Source != "agent.workers" {
		t.Errorf("doing.provider = %+v, want inherited from agent.workers", doing.Provider)
	}
	if doing.Model.Override == nil || *doing.Model.Override != "claude-sonnet-5-5" || doing.Model.Source != "agent.profiles.doing.model" {
		t.Errorf("doing.model = %+v, want system override", doing.Model)
	}

	review := roleByName(t, doc, "review")
	if review.Model.Override != nil || review.Model.Effective != "claude-opus-5-5" || review.Model.Source != "providers.claude.profiles.review.model" {
		t.Errorf("review.model = %+v, want inherited from the provider table", review.Model)
	}
	if review.Effort.Effective != "high" {
		t.Errorf("review.effort = %+v", review.Effort)
	}

	fast := roleByName(t, doc, "fast")
	if fast.Model.Effective != "" || fast.Model.Source != "" || fast.Model.Override != nil {
		t.Errorf("fast.model = %+v, want empty (provider default)", fast.Model)
	}
}

func TestRead_envShadowCarriesSystemValue(t *testing.T) {
	rows := baseRows()
	rows[1] = row("agent.workers", `"kimi"`, "env", "FAB_AGENT_WORKERS")
	f := newFake(t, rows...)
	f.stacks["agent.workers"] = showJSON(
		row("agent.workers", `"kimi"`, "env", "FAB_AGENT_WORKERS"),
		`{"key":"agent.workers","value":"codex","origin":"system","origin_detail":"`+systemPath+`","status":"shadowed"}`,
	)
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	w := doc.Fields["agent.workers"]
	if w.Value != "kimi" || w.Origin != "env" || w.OriginDetail != "FAB_AGENT_WORKERS" || w.SystemValue != "codex" {
		t.Errorf("agent.workers = %+v, want env winner with systemValue codex", w)
	}
	if s := doc.Fields["agent.session"]; s.SystemValue != nil {
		t.Errorf("agent.session.systemValue = %v, want nil (system wins, no stack read)", s.SystemValue)
	}
}

func TestRead_everyCallIsFreshAndArgvOnly(t *testing.T) {
	f := newFake(t)
	c := New(f.run)
	_, _ = c.Read(context.Background())
	_, _ = c.Read(context.Background())
	shows := 0
	for _, call := range f.calls {
		if strings.Join(call, " ") == "config show --origin --json" {
			shows++
		}
	}
	if shows != 2 {
		t.Errorf("show calls = %d, want 2 (no cache between reads)", shows)
	}
}

func TestRead_showFailureIsCommandError(t *testing.T) {
	f := newFake(t)
	f.failOn, f.failMsg = "config show --origin --json", "boom"
	_, err := New(f.run).Read(context.Background())
	var ce *CommandError
	if !errors.As(err, &ce) || ce.Stderr != "boom" {
		t.Fatalf("err = %v, want CommandError with stderr boom", err)
	}
}

func TestApply_setAndUnsetArgv(t *testing.T) {
	f := newFake(t)
	doc, err := New(f.run).Apply(context.Background(),
		patchOf(t, `{"agent.workers":"codex","agent.profiles.review.model":null,"dispatch.column_width":42}`))
	if err != nil {
		t.Fatal(err)
	}
	got := f.mutations()
	wantOps := []string{
		"config unset agent.profiles.review.model --system",
		"config set agent.workers codex --system",
		"config set dispatch.column_width 42 --system",
	}
	if !reflect.DeepEqual(got, wantOps) {
		t.Errorf("mutations = %v, want %v (sorted key order)", got, wantOps)
	}
	if !doc.Installed || len(doc.Roles) != 6 {
		t.Errorf("Apply must return the re-read document, got %+v", doc)
	}
}

func TestApply_emptyProfileLeafUnsets(t *testing.T) {
	f := newFake(t)
	_, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent.profiles.doing.model":"  "}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := f.mutations(); !reflect.DeepEqual(got, []string{"config unset agent.profiles.doing.model --system"}) {
		t.Errorf("mutations = %v", got)
	}
}

func TestApply_validationRejectsBeforeExec(t *testing.T) {
	long := strings.Repeat("x", maxProfileValueLen+1)
	cases := map[string]string{
		"unknown key":         `{"providers.codex.native":true}`,
		"unknown role":        `{"agent.profiles.ship.model":"m"}`,
		"unknown leaf":        `{"agent.profiles.doing.native":"m"}`,
		"role without leaf":   `{"agent.profiles.doing":"m"}`,
		"extra segment":       `{"agent.profiles.doing.model.x":"m"}`,
		"bad mode":            `{"dispatch.mode":"weird"}`,
		"mode type":           `{"dispatch.mode":1}`,
		"unknown provider":    `{"agent.workers":"bogus"}`,
		"empty session":       `{"agent.session":""}`,
		"profile provider":    `{"agent.profiles.doing.provider":"bogus"}`,
		"width zero":          `{"dispatch.column_width":0}`,
		"width 100":           `{"dispatch.column_width":100}`,
		"width fraction":      `{"dispatch.column_width":4.5}`,
		"width string":        `{"dispatch.column_width":"45"}`,
		"min_cols zero":       `{"dispatch.min_cols":0}`,
		"min_rows negative":   `{"dispatch.min_rows":-3}`,
		"reap not bool":       `{"dispatch.reap_done":"yes"}`,
		"model hash":          `{"agent.profiles.doing.model":"a # b"}`,
		"model dash":          `{"agent.profiles.doing.model":"--model"}`,
		"model newline":       `{"agent.profiles.doing.model":"a\nb"}`,
		"model too long":      `{"agent.profiles.doing.model":"` + long + `"}`,
		"effort dash":         `{"agent.profiles.review.effort":"-x"}`,
		"valid + invalid mix": `{"agent.workers":"codex","dispatch.mode":"weird"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			_, err := New(f.run).Apply(context.Background(), patchOf(t, body))
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("err = %v, want ValidationError", err)
			}
			if got := f.mutations(); len(got) != 0 {
				t.Errorf("mutations = %v, want none (reject before exec)", got)
			}
		})
	}
}

func TestApply_everyRoleLeafIsWritable(t *testing.T) {
	for _, rd := range Roles {
		for _, leaf := range []string{profileLeafModel, profileLeafEffort} {
			key := profileKeyPrefix + rd.Name + "." + leaf
			f := newFake(t)
			if _, err := New(f.run).Apply(context.Background(), patchOf(t, `{"`+key+`":"m"}`)); err != nil {
				t.Errorf("%s: %v", key, err)
			}
		}
	}
}

func TestApply_acceptsBoundaryValues(t *testing.T) {
	f := newFake(t)
	_, err := New(f.run).Apply(context.Background(), patchOf(t,
		`{"dispatch.column_width":99,"dispatch.mode":"headless","dispatch.reap_done":false,"agent.session":"kimi","agent.profiles.operator.provider":"agy"}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"config set agent.profiles.operator.provider agy --system",
		"config set agent.session kimi --system",
		"config set dispatch.column_width 99 --system",
		"config set dispatch.mode headless --system",
		"config set dispatch.reap_done false --system",
	}
	if got := f.mutations(); !reflect.DeepEqual(got, want) {
		t.Errorf("mutations = %v, want %v", got, want)
	}
}

func TestApply_stopsAtFirstFailureWithStderr(t *testing.T) {
	f := newFake(t)
	f.failOn, f.failMsg = "config set dispatch.mode", "fab: refusing to set dispatch.mode"
	_, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent.workers":"codex","dispatch.mode":"pane","dispatch.reap_done":true}`))
	var ce *CommandError
	if !errors.As(err, &ce) || ce.Stderr != "fab: refusing to set dispatch.mode" {
		t.Fatalf("err = %v, want CommandError carrying fab stderr", err)
	}
	if got := f.mutations(); len(got) != 2 {
		t.Errorf("mutations = %v, want agent.workers then the failing dispatch.mode, nothing after", got)
	}
}

func TestApply_surfacesFabWarnings(t *testing.T) {
	f := newFake(t)
	f.setErr = "fab: warning: agent.workers is shadowed by env $FAB_AGENT_WORKERS — the written value is not in effect\nSet agent.workers in " + systemPath
	doc, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent.workers":"codex"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Warnings) != 1 || !strings.Contains(doc.Warnings[0], "shadowed by env $FAB_AGENT_WORKERS") {
		t.Errorf("warnings = %v", doc.Warnings)
	}
}

func TestApply_notInstalled(t *testing.T) {
	c := New(func(context.Context, ...string) ([]byte, []byte, error) {
		t.Fatal("must not run")
		return nil, nil, nil
	}).WithLookPath(func(string) (string, error) { return "", errors.New("nope") })
	if _, err := c.Apply(context.Background(), patchOf(t, `{"agent.workers":"codex"}`)); !errors.Is(err, ErrNotInstalled) {
		t.Errorf("err = %v, want ErrNotInstalled", err)
	}
}
