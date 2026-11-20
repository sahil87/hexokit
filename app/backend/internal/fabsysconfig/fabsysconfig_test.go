package fabsysconfig

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const systemPath = "/home/u/.fab-kit/config.yaml"

// fakeFab is a scripted Runner: responses are keyed by the space-joined argv,
// every call is recorded, and an unscripted argv fails the test — so no test
// can reach the real binary or the developer's ~/.fab-kit/config.yaml. Read
// runs discovery concurrently with the config reads, so the call log is locked.
type fakeFab struct {
	t       *testing.T
	show    string
	explain string
	stacks  map[string]string // key → `show <key> --origin --json` output
	failOn  string            // argv prefix that exits non-zero
	failMsg string
	setErr  string // stderr emitted by every successful set/unset
	// models and modelsErr are the stdout and stderr of `agent models --json`;
	// with models empty the call exits non-zero, like a fab without the verb.
	models    string
	modelsErr string
	mu        sync.Mutex
	calls     [][]string
}

func (f *fakeFab) run(_ context.Context, argv ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, argv)
	f.mu.Unlock()
	joined := strings.Join(argv, " ")
	if f.failOn != "" && strings.HasPrefix(joined, f.failOn) {
		return nil, []byte(f.failMsg), errors.New("exit 1")
	}
	switch {
	case joined == "agent models --json":
		if f.models == "" {
			return nil, []byte("unknown role: models"), errors.New("exit 1")
		}
		return []byte(f.models), []byte(f.modelsErr), nil
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

func (f *fakeFab) callLog() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.calls...)
}

func (f *fakeFab) mutations() []string {
	var out []string
	for _, c := range f.callLog() {
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
// for `doing`, and a four-tool table in fab's old `providers` spelling.
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

// ids is the fill-scan fallback shape: suggestions carrying only an id.
func ids(v ...string) []ModelSuggestion {
	out := make([]ModelSuggestion, 0, len(v))
	for _, id := range v {
		out = append(out, ModelSuggestion{ID: id})
	}
	return out
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
	if want := []string{"agy", "claude", "codex", "kimi"}; !reflect.DeepEqual(doc.Tools, want) {
		t.Errorf("tools = %v, want %v (derived from providers.<name>.* keys)", doc.Tools, want)
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
	if got := doc.ModelSuggestions["claude"]; !reflect.DeepEqual(got, ids("claude-opus-5-5", "claude-sonnet-5-5")) {
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
	if doing.Tool.Override != nil || doing.Tool.Effective != "claude" || doing.Tool.Source != "agent.workers" {
		t.Errorf("doing.tool = %+v, want inherited from agent.workers", doing.Tool)
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
		t.Errorf("fast.model = %+v, want empty (tool default)", fast.Model)
	}
}

func TestRead_inheritFallsBackToDefaultProfile(t *testing.T) {
	agyRows := func(extra ...string) []string {
		rows := append(baseRows(),
			row("agent.profiles.doing.provider", `"agy"`, "system", systemPath),
			row("agent.profiles.fast.provider", `"agy"`, "system", systemPath),
			row("agent.profiles.review.provider", `"kimi"`, "system", systemPath),
			row("providers.agy.profiles.fast.model", `"gemini-3.6-flash-low"`, "default", ""),
		)
		return append(rows, extra...)
	}

	t.Run("override set: inherited names the default fill", func(t *testing.T) {
		doc, _ := New(newFake(t, agyRows()...).run).Read(context.Background())
		doing := roleByName(t, doc, "doing")
		if doing.Model.Override == nil || doing.Model.Inherited != "gemini-3.1-pro-high" {
			t.Errorf("doing.model = %+v, want override with inherited gemini-3.1-pro-high", doing.Model)
		}
	})

	t.Run("no row: effective comes from the default fill", func(t *testing.T) {
		var rows []string
		for _, r := range agyRows() {
			if !strings.Contains(r, `"agent.profiles.doing.model"`) {
				rows = append(rows, r)
			}
		}
		doc, _ := New(newFake(t, rows...).run).Read(context.Background())
		doing := roleByName(t, doc, "doing")
		if doing.Model.Override != nil || doing.Model.Effective != "gemini-3.1-pro-high" ||
			doing.Model.Source != "providers.agy.profiles.default.model" || doing.Model.Inherited != "gemini-3.1-pro-high" {
			t.Errorf("doing.model = %+v, want inherited from providers.agy.profiles.default.model", doing.Model)
		}
	})

	t.Run("role fill wins over default", func(t *testing.T) {
		doc, _ := New(newFake(t, agyRows()...).run).Read(context.Background())
		fast := roleByName(t, doc, "fast")
		if fast.Model.Inherited != "gemini-3.6-flash-low" || fast.Model.Source != "providers.agy.profiles.fast.model" {
			t.Errorf("fast.model = %+v, want the fast fill", fast.Model)
		}
	})

	t.Run("an empty role fill falls through to default", func(t *testing.T) {
		doc, _ := New(newFake(t, agyRows(row("providers.agy.profiles.doing.model", `""`, "system", systemPath))...).run).Read(context.Background())
		doing := roleByName(t, doc, "doing")
		if doing.Model.Inherited != "gemini-3.1-pro-high" {
			t.Errorf("doing.model = %+v, want the default fill past an empty role fill", doing.Model)
		}
	})

	t.Run("no fills: tool default", func(t *testing.T) {
		doc, _ := New(newFake(t, agyRows()...).run).Read(context.Background())
		review := roleByName(t, doc, "review")
		for _, c := range []Cell{review.Model, review.Effort} {
			if c.Inherited != "" || c.Effective != "" || c.Source != "" {
				t.Errorf("review cell = %+v, want empty", c)
			}
		}
	})
}

func TestRead_effortCapable(t *testing.T) {
	rows := append(baseRows(),
		row("providers.claude.interactive_command", `"claude --model {model} --effort {effort}"`, "default", ""),
		row("providers.codex.headless_command", `"codex exec -m {model} -c model_reasoning_effort={effort}"`, "default", ""),
		row("providers.codex.interactive_command", `"codex -m {model}"`, "default", ""),
	)
	doc, err := New(newFake(t, rows...).run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// agy and kimi carry commands without {effort}; codex only in headless.
	want := map[string]bool{"agy": false, "claude": true, "codex": true, "kimi": false}
	if !reflect.DeepEqual(doc.EffortCapable, want) {
		t.Errorf("effortCapable = %v, want %v", doc.EffortCapable, want)
	}

	doc, _ = New(newFake(t).run).Read(context.Background())
	if capable, ok := doc.EffortCapable["codex"]; !ok || capable {
		t.Errorf("codex with no command rows = (%v, present %v), want explicit false", capable, ok)
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

func TestRead_overriddenCellCarriesInherited(t *testing.T) {
	rows := append(baseRows(), row("agent.profiles.review.provider", `"codex"`, "system", systemPath))
	f := newFake(t, rows...)
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	review := roleByName(t, doc, "review")
	if review.Tool.Effective != "codex" || review.Tool.Inherited != "claude" {
		t.Errorf("review.tool = %+v, want effective codex, inherited claude (agent.workers)", review.Tool)
	}
	if review.Model.Inherited != "gpt-5.6-sol" {
		t.Errorf("review.model.inherited = %q, want codex's review fill", review.Model.Inherited)
	}
	doing := roleByName(t, doc, "doing")
	if *doing.Model.Override != "claude-sonnet-5-5" || doing.Model.Inherited != "claude-sonnet-5-5" {
		t.Errorf("doing.model = %+v, want inherited from the provider table", doing.Model)
	}
	if defaultRole := roleByName(t, doc, "default"); defaultRole.Tool.Inherited != "claude" {
		t.Errorf("default.tool.inherited = %q, want agent.session", defaultRole.Tool.Inherited)
	}
}

func TestRead_envShadowedRoleLeafCarriesSystemValue(t *testing.T) {
	const key = "agent.profiles.review.provider"
	rows := append(baseRows(), row(key, `"kimi"`, "env", "FAB_AGENT_PROFILES"))
	f := newFake(t, rows...)
	f.stacks[key] = showJSON(
		row(key, `"kimi"`, "env", "FAB_AGENT_PROFILES"),
		`{"key":"`+key+`","value":"codex","origin":"system","origin_detail":"`+systemPath+`","status":"shadowed"}`,
	)
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p := roleByName(t, doc, "review").Tool
	if p.Override != nil || p.SystemValue == nil || *p.SystemValue != "codex" {
		t.Errorf("review.tool = %+v, want no override and systemValue codex", p)
	}
	if roleByName(t, doc, "doing").Tool.SystemValue != nil {
		t.Error("doing.tool.systemValue set without an env winner")
	}
}

func TestRead_everyCallIsFreshAndArgvOnly(t *testing.T) {
	f := newFake(t)
	c := New(f.run)
	_, _ = c.Read(context.Background())
	_, _ = c.Read(context.Background())
	shows := 0
	for _, call := range f.callLog() {
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
		"unknown tool":        `{"agent.workers":"bogus"}`,
		"empty session":       `{"agent.session":""}`,
		"profile provider":    `{"agent.profiles.doing.provider":"bogus"}`,
		"profile tool":        `{"agent.profiles.doing.tool":"bogus"}`,
		"tool leaf twice":     `{"agent.profiles.doing.tool":"codex","agent.profiles.doing.provider":"kimi"}`,
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

// Concurrent Applies (the API builds a Client per request) must not interleave
// their set/unset calls: fab rewrites the whole system file without a lock.
// Read-only calls are exempt — the post-write re-read and its discovery run
// outside the lock, as a plain GET does.
func TestApply_serializesAcrossClients(t *testing.T) {
	show := showJSON(baseRows()...)
	var mu sync.Mutex
	inFlight, maxInFlight := 0, 0
	run := func(_ context.Context, argv ...string) ([]byte, []byte, error) {
		joined := strings.Join(argv, " ")
		if joined == "agent models --json" {
			return nil, nil, errors.New("exit 1")
		}
		if !strings.HasPrefix(joined, "config set ") && !strings.HasPrefix(joined, "config unset ") {
			if joined == "config show --origin --json" {
				return []byte(show), nil, nil
			}
			return []byte("[]"), nil, nil
		}
		mu.Lock()
		inFlight++
		maxInFlight = max(maxInFlight, inFlight)
		mu.Unlock()
		time.Sleep(2 * time.Millisecond)
		mu.Lock()
		inFlight--
		mu.Unlock()
		return nil, nil, nil
	}
	var wg sync.WaitGroup
	for _, body := range []string{`{"agent.workers":"codex"}`, `{"dispatch.mode":"native"}`} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := New(run).Apply(context.Background(), patchOf(t, body)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if maxInFlight != 1 {
		t.Errorf("max concurrent set/unset calls = %d, want 1", maxInFlight)
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

// newSpelling rewrites fixture rows into fab's renamed spelling: the clis
// table and the agent.profiles.<role>.cli leaf.
func newSpelling(rows []string) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		r = strings.Replace(r, `"key":"providers.`, `"key":"clis.`, 1)
		out[i] = strings.Replace(r, `.provider","value"`, `.cli","value"`, 1)
	}
	return out
}

// spellings runs a case against fab's old and renamed spellings; a renamed
// fab must read identically and write the new leaf.
var spellings = []struct {
	name, table, leaf string
	rows              func([]string) []string
}{
	{"providers", "providers.", "provider", func(r []string) []string { return r }},
	{"clis", "clis.", "cli", newSpelling},
}

func TestRead_bothSpellingsReadAlike(t *testing.T) {
	for _, sp := range spellings {
		t.Run(sp.name, func(t *testing.T) {
			rows := sp.rows(append(baseRows(),
				row("agent.profiles.review."+sp.leaf, `"codex"`, "system", systemPath),
				row("agent.profiles.fast."+sp.leaf, `"agy"`, "system", systemPath),
				row("providers.codex.headless_command", `"codex exec -c model_reasoning_effort={effort}"`, "default", ""),
			))
			doc, err := New(newFake(t, rows...).run).Read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if want := []string{"agy", "claude", "codex", "kimi"}; !reflect.DeepEqual(doc.Tools, want) {
				t.Errorf("tools = %v, want %v", doc.Tools, want)
			}
			review := roleByName(t, doc, "review")
			if review.Tool.Override == nil || *review.Tool.Override != "codex" || review.Tool.Source != "agent.profiles.review."+sp.leaf {
				t.Errorf("review.tool = %+v, want override codex from the %s leaf", review.Tool, sp.leaf)
			}
			if review.Model.Effective != "gpt-5.6-sol" || review.Model.Source != sp.table+"codex.profiles.review.model" {
				t.Errorf("review.model = %+v, want codex's fill from the %s table", review.Model, sp.table)
			}
			if fast := roleByName(t, doc, "fast"); fast.Model.Inherited != "gemini-3.1-pro-high" || fast.Model.Source != sp.table+"agy.profiles.default.model" {
				t.Errorf("fast.model = %+v, want agy's default-profile fill", fast.Model)
			}
			if got := doc.ModelSuggestions["codex"]; !reflect.DeepEqual(got, ids("gpt-5.6-sol")) {
				t.Errorf("codex suggestions = %v", got)
			}
			if !doc.EffortCapable["codex"] || doc.EffortCapable["kimi"] {
				t.Errorf("effortCapable = %v", doc.EffortCapable)
			}
		})
	}
}

func TestRead_newSpellingWinsWhenBothShown(t *testing.T) {
	rows := append(baseRows(),
		row("agent.profiles.review.provider", `"kimi"`, "system", systemPath),
		row("agent.profiles.review.cli", `"codex"`, "system", systemPath),
		row("clis.codex.profiles.review.model", `"gpt-6.1-sol"`, "default", ""),
		row("clis.zed.interactive_command", `"zed"`, "default", ""),
	)
	doc, err := New(newFake(t, rows...).run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"agy", "claude", "codex", "kimi", "zed"}; !reflect.DeepEqual(doc.Tools, want) {
		t.Errorf("tools = %v, want the de-duplicated union %v", doc.Tools, want)
	}
	review := roleByName(t, doc, "review")
	if review.Tool.Effective != "codex" || review.Tool.Source != "agent.profiles.review.cli" {
		t.Errorf("review.tool = %+v, want the .cli row over .provider", review.Tool)
	}
	if review.Model.Effective != "gpt-6.1-sol" || review.Model.Source != "clis.codex.profiles.review.model" {
		t.Errorf("review.model = %+v, want the clis fill over providers", review.Model)
	}
	if got, want := doc.ModelSuggestions["codex"], ids("gpt-5.6-sol", "gpt-6.1-sol"); !reflect.DeepEqual(got, want) {
		t.Errorf("codex suggestions = %v, want the union %v", got, want)
	}
}

func TestRead_envShadowedToolQueriesItsSpelling(t *testing.T) {
	const key = "agent.profiles.review.cli"
	rows := append(newSpelling(baseRows()), row(key, `"kimi"`, "env", "FAB_AGENT_PROFILES"))
	f := newFake(t, rows...)
	f.stacks[key] = showJSON(
		row(key, `"kimi"`, "env", "FAB_AGENT_PROFILES"),
		`{"key":"`+key+`","value":"codex","origin":"system","origin_detail":"`+systemPath+`","status":"shadowed"}`,
	)
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v := roleByName(t, doc, "review").Tool.SystemValue; v == nil || *v != "codex" {
		t.Errorf("review.tool.systemValue = %v, want codex read from %s", v, key)
	}
}

func TestProbeToolLeaf(t *testing.T) {
	old := []showRow{{Key: "providers.claude.native"}, {Key: "agent.profiles.review.provider"}}
	cases := []struct {
		name      string
		rows      []showRow
		explained map[string]string
		want      string
	}{
		{"old fab", old, map[string]string{"providers": "", "agent.profiles": ""}, profileLeafProvider},
		{"clis row", append(old, showRow{Key: "clis.claude.native"}), nil, profileLeafCLI},
		{"cli role row", []showRow{{Key: "agent.profiles.doing.cli"}}, nil, profileLeafCLI},
		{"explain only", old, map[string]string{"clis": ""}, profileLeafCLI},
		{"nothing", nil, nil, profileLeafProvider},
	}
	for _, tc := range cases {
		if got := probeToolLeaf(tc.rows, tc.explained); got != tc.want {
			t.Errorf("%s: probe = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestApply_toolLeafWritesInstalledSpelling(t *testing.T) {
	for _, sp := range spellings {
		for _, sent := range []string{"tool", "cli", "provider"} {
			t.Run(sp.name+"/"+sent, func(t *testing.T) {
				f := newFake(t, sp.rows(baseRows())...)
				_, err := New(f.run).Apply(context.Background(), patchOf(t,
					`{"agent.profiles.review.`+sent+`":"codex","agent.profiles.doing.`+sent+`":null,"agent.profiles.review.model":null}`))
				if err != nil {
					t.Fatal(err)
				}
				want := []string{
					"config unset agent.profiles.doing." + sp.leaf + " --system",
					"config unset agent.profiles.review.model --system",
					"config set agent.profiles.review." + sp.leaf + " codex --system",
				}
				if sp.leaf == profileLeafCLI {
					want = []string{want[0], want[2], want[1]}
				}
				if got := f.mutations(); !reflect.DeepEqual(got, want) {
					t.Errorf("mutations = %v, want %v (sorted by written key)", got, want)
				}
			})
		}
	}
}

// modelsFixture mirrors `fab agent models --json` on a machine: a reserved
// row per tool, claude aliases plus tool rows (one labelled, one default),
// codex under the pre-rename `provider` spelling, a repeated id, an empty id,
// and a tool the document does not list.
const modelsFixture = `[
 {"cli":"agy","id":"tool-default","label":"tool default","efforts":[],"default":false,"source":"reserved"},
 {"cli":"claude","id":"tool-default","label":"tool default (claude-fable-5-1[1m])","efforts":["low","medium"],"default":false,"source":"reserved"},
 {"cli":"claude","id":"opus","label":"opus","efforts":["low","medium","high"],"default":false,"source":"alias"},
 {"cli":"claude","id":"glm-latest[1m]","label":"GLM 5.3 (Latest)","efforts":["low","high"],"default":false,"source":"tool"},
 {"cli":"claude","id":"claude-fable-5-1[1m]","label":"claude-fable-5-1[1m]","efforts":["low","medium","high","xhigh","max"],"default":true,"source":"tool"},
 {"cli":"claude","id":"opus","label":"opus again","efforts":[],"default":false,"source":"tool"},
 {"cli":"claude","id":"","label":"nameless","efforts":[],"default":false,"source":"tool"},
 {"provider":"codex","id":"gpt-6.1-sol","label":"","efforts":["low","medium","high","xhigh","max","ultra"],"default":true,"source":"tool"},
 {"cli":"zed","id":"zed-1","label":"Zed One","efforts":[],"default":false,"source":"tool"}
]`

func TestRead_discoversModelSuggestions(t *testing.T) {
	f := newFake(t)
	f.models = modelsFixture
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantClaude := []ModelSuggestion{
		{ID: "opus", Efforts: []string{"low", "medium", "high"}},
		{ID: "glm-latest[1m]", Label: "GLM 5.3 (Latest)", Efforts: []string{"low", "high"}},
		{ID: "claude-fable-5-1[1m]", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, Default: true},
	}
	if got := doc.ModelSuggestions["claude"]; !reflect.DeepEqual(got, wantClaude) {
		t.Errorf("claude = %+v, want %+v (fab's order, reserved/empty/duplicate dropped, label omitted when equal to id)", got, wantClaude)
	}
	wantCodex := []ModelSuggestion{{ID: "gpt-6.1-sol", Efforts: []string{"low", "medium", "high", "xhigh", "max", "ultra"}, Default: true}}
	if got := doc.ModelSuggestions["codex"]; !reflect.DeepEqual(got, wantCodex) {
		t.Errorf("codex = %+v, want %+v (read from the provider spelling)", got, wantCodex)
	}
	for _, tool := range doc.Tools {
		if doc.ModelSuggestions[tool] == nil {
			t.Errorf("tool %q has no suggestions entry, want one even when empty", tool)
		}
	}
	if got := doc.ModelSuggestions["agy"]; len(got) != 0 {
		t.Errorf("agy = %+v, want [] (only a reserved row)", got)
	}
	if _, ok := doc.ModelSuggestions["zed"]; ok {
		t.Errorf("zed is not in doc.Tools, want its rows ignored")
	}
	if len(doc.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", doc.Warnings)
	}
}

func TestRead_cliSpellingWinsOverProvider(t *testing.T) {
	f := newFake(t)
	f.models = `[{"cli":"claude","provider":"codex","id":"m","label":"m","efforts":[],"default":false,"source":"tool"}]`
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := doc.ModelSuggestions["claude"]; !reflect.DeepEqual(got, ids("m")) || len(doc.ModelSuggestions["codex"]) != 0 {
		t.Errorf("suggestions = %+v, want m under claude only", doc.ModelSuggestions)
	}
}

func TestRead_discoveryFailureFallsBackToFillsSilently(t *testing.T) {
	cases := map[string]string{
		"non-zero exit":  "",
		"malformed json": "not json",
		"not an array":   `{"cli":"claude"}`,
		"json null":      "null",
	}
	for name, models := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.models = models
			doc, err := New(f.run).Read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got := doc.ModelSuggestions["claude"]; !reflect.DeepEqual(got, ids("claude-opus-5-5", "claude-sonnet-5-5")) {
				t.Errorf("claude = %+v, want the fill scan", got)
			}
			if len(doc.Warnings) != 0 {
				t.Errorf("warnings = %v, want none for a discovery failure", doc.Warnings)
			}
		})
	}
}

func TestRead_discoveryWarningsSurface(t *testing.T) {
	f := newFake(t)
	f.models = modelsFixture
	f.modelsErr = "warning: codex: codex debug models: timed out after 3s\nnote: unrelated"
	doc, err := New(f.run).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"warning: codex: codex debug models: timed out after 3s"}; !reflect.DeepEqual(doc.Warnings, want) {
		t.Errorf("warnings = %v, want %v", doc.Warnings, want)
	}
}

func TestRead_discoveryIsOneArgvOnlyCall(t *testing.T) {
	f := newFake(t)
	f.models = modelsFixture
	if _, err := New(f.run).Read(context.Background()); err != nil {
		t.Fatal(err)
	}
	var discovery [][]string
	for _, call := range f.callLog() {
		if len(call) > 0 && call[0] == "agent" {
			discovery = append(discovery, call)
		}
	}
	if want := [][]string{{"agent", "models", "--json"}}; !reflect.DeepEqual(discovery, want) {
		t.Errorf("discovery calls = %v, want exactly %v", discovery, want)
	}
}

func TestRead_discoveryRunsConcurrentlyWithConfigReads(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	f := newFake(t)
	f.models = modelsFixture
	run := func(ctx context.Context, argv ...string) ([]byte, []byte, error) {
		switch strings.Join(argv, " ") {
		case "agent models --json":
			close(started)
			<-release
		case "config show --origin --json":
			select {
			case <-started:
				close(release)
			case <-time.After(5 * time.Second):
				t.Error("discovery had not started while the config reads ran")
				close(release)
			}
		}
		return f.run(ctx, argv...)
	}
	if _, err := New(run).Read(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRead_showFailureDoesNotLeakDiscovery(t *testing.T) {
	f := newFake(t)
	f.models = modelsFixture
	f.failOn = "config show --origin --json"
	f.failMsg = "boom"
	if _, err := New(f.run).Read(context.Background()); err == nil {
		t.Fatal("want the show failure surfaced")
	}
}

func TestApply_keepsWriteAndDiscoveryWarnings(t *testing.T) {
	f := newFake(t)
	f.models = modelsFixture
	f.modelsErr = "warning: codex: codex debug models: timed out after 3s"
	f.setErr = "warning: x"
	doc, err := New(f.run).Apply(context.Background(), patchOf(t, `{"agent.workers":"codex"}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"warning: x", "warning: codex: codex debug models: timed out after 3s"}
	if !reflect.DeepEqual(doc.Warnings, want) {
		t.Errorf("warnings = %v, want write warnings then discovery warnings %v", doc.Warnings, want)
	}
}

func TestRead_notInstalledSkipsDiscovery(t *testing.T) {
	c := New(func(_ context.Context, argv ...string) ([]byte, []byte, error) {
		t.Errorf("fab ran %v while not installed", argv)
		return nil, nil, nil
	}).WithLookPath(func(string) (string, error) { return "", errors.New("not found") })
	if _, err := c.Read(context.Background()); err != nil {
		t.Fatal(err)
	}
}
