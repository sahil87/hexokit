package cron

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

// specExampleYAML is the spec's example entry file (docs/specs/cron.md § Cron
// State), verbatim in shape.
const specExampleYAML = `
entries:
  - id: a3f9
    name: operator tick
    schedule: { kind: backoff, min: 60s, max: 30m }
    wake_on: { event: agent-state-change, scope: server, debounce: 60s }
    target: { kind: role, role: operator }
    payload: "operator tick"
    deliver: immediate
    if_absent: respawn
    respawn: ["rk", "operator", "-L", "{server}"]
    pinned: true
    created_by: { session: 8c1e, pane: "%12", at: 1788254000 }
  - id: k7q2
    name: hourly PR sweep
    schedule: { kind: every, interval: 1h }
    target: { kind: session, session: 4fe2 }
    payload: "check open PRs for new review comments and triage them"
    deliver: when-idle
    if_absent: skip
    created_by: { session: 4fe2, pane: "%31", at: 1788255100 }
`

func loadSpecExample(t *testing.T) []Entry {
	t.Helper()
	var wrapper struct {
		Entries []Entry `yaml:"entries"`
	}
	if err := yaml.Unmarshal([]byte(specExampleYAML), &wrapper); err != nil {
		t.Fatal(err)
	}
	return wrapper.Entries
}

func TestSpecExampleRoundTrips(t *testing.T) {
	entries := loadSpecExample(t)
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}

	op := entries[0]
	if op.ID != "a3f9" || op.Name != "operator tick" {
		t.Errorf("entry = %+v", op)
	}
	if op.Schedule.Kind != ScheduleBackoff {
		t.Errorf("schedule = %+v", op.Schedule)
	}
	if op.Schedule.Min.Duration != 60*time.Second || op.Schedule.Max.Duration != 30*time.Minute {
		t.Errorf("backoff min/max = %v/%v", op.Schedule.Min, op.Schedule.Max)
	}
	if op.WakeOn == nil || op.WakeOn.Event != WakeAgentStateChange ||
		op.WakeOn.Scope != WakeScopeServer || op.WakeOn.Debounce.Duration != 60*time.Second {
		t.Errorf("wake_on = %+v", op.WakeOn)
	}
	if !reflect.DeepEqual(op.Respawn, []string{"rk", "operator", "-L", "{server}"}) {
		t.Errorf("respawn = %v", op.Respawn)
	}
	if op.Target.Kind != TargetRole || op.Target.Role != RoleOperator {
		t.Errorf("target = %+v", op.Target)
	}
	if op.Deliver != DeliverImmediate || op.IfAbsent != IfAbsentRespawn || !op.Pinned || op.Muted {
		t.Errorf("flags = %+v", op)
	}
	if op.CreatedBy.Session != "8c1e" || op.CreatedBy.Pane != "%12" || op.CreatedBy.At != 1788254000 {
		t.Errorf("created_by = %+v", op.CreatedBy)
	}

	sweep := entries[1]
	if sweep.Schedule.Kind != ScheduleEvery || sweep.Schedule.Interval.Duration != time.Hour {
		t.Errorf("schedule = %+v", sweep.Schedule)
	}
	if sweep.Target.Kind != TargetSession || sweep.Target.Session != "4fe2" {
		t.Errorf("target = %+v", sweep.Target)
	}
	for _, e := range entries {
		if err := e.validate(); err != nil {
			t.Errorf("entry %s failed validation: %v", e.ID, err)
		}
	}

	// Marshal back and re-parse: every field survives the round trip.
	out, err := yaml.Marshal(struct {
		Entries []Entry `yaml:"entries"`
	}{Entries: entries})
	if err != nil {
		t.Fatal(err)
	}
	var wrapper struct {
		Entries []Entry `yaml:"entries"`
	}
	if err := yaml.Unmarshal(out, &wrapper); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wrapper.Entries, entries) {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", wrapper.Entries, entries)
	}
}

func TestRuntimeFactsAreNotSchemaFields(t *testing.T) {
	// Runtime facts (last_fired, next_fire, rung, orphaned-since) must never
	// appear in the marshaled intent form.
	out, err := yaml.Marshal(struct {
		Entries []Entry `yaml:"entries"`
	}{Entries: loadSpecExample(t)})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range []string{"last_fired", "next_fire", "rung", "orphaned"} {
		if strings.Contains(string(out), fact) {
			t.Errorf("marshaled entry contains runtime fact %q:\n%s", fact, out)
		}
	}
}

func TestEntryValidate(t *testing.T) {
	base := Entry{
		ID:       "a3f9",
		Payload:  "x",
		Schedule: Schedule{Kind: ScheduleEvery, Interval: Duration{time.Hour}},
		Target:   Target{Kind: TargetPane, Pane: "%12"},
	}
	cases := []struct {
		name    string
		mutate  func(*Entry)
		wantErr bool
	}{
		{"valid", func(e *Entry) {}, false},
		{"missing id", func(e *Entry) { e.ID = "" }, true},
		{"missing schedule", func(e *Entry) { e.Schedule.Kind = "" }, true},
		{"unknown schedule kind", func(e *Entry) { e.Schedule.Kind = "bogus" }, true},
		{"cron kind recognized", func(e *Entry) { e.Schedule = Schedule{Kind: ScheduleCron, Expr: "*/5 * * * *"} }, false},
		{"cron expr must parse", func(e *Entry) { e.Schedule = Schedule{Kind: ScheduleCron, Expr: "not an expr"} }, true},
		{"cron expr field out of range", func(e *Entry) { e.Schedule = Schedule{Kind: ScheduleCron, Expr: "61 * * * *"} }, true},
		{"cron expr empty", func(e *Entry) { e.Schedule = Schedule{Kind: ScheduleCron} }, true},
		{"catch_up once on cron", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleCron, Expr: "0 9 * * *", CatchUp: CatchUpOnce}
		}, false},
		{"catch_up on non-cron kind", func(e *Entry) { e.Schedule.CatchUp = CatchUpOnce }, true},
		{"catch_up unknown value", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleCron, Expr: "0 9 * * *", CatchUp: "always"}
		}, true},
		{"every needs interval", func(e *Entry) { e.Schedule.Interval = Duration{} }, true},
		{"backoff needs min", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleBackoff, Max: Duration{30 * time.Minute}}
		}, true},
		{"backoff max < min", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleBackoff, Min: Duration{time.Hour}, Max: Duration{time.Minute}}
		}, true},
		{"backoff valid", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleBackoff, Min: Duration{time.Minute}, Max: Duration{30 * time.Minute}}
		}, false},
		{"backoff min == max (flat ladder)", func(e *Entry) {
			e.Schedule = Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{3 * time.Minute}}
		}, false},
		{"deliver empty", func(e *Entry) {}, false},
		{"deliver immediate", func(e *Entry) { e.Deliver = DeliverImmediate }, false},
		{"deliver when-idle", func(e *Entry) { e.Deliver = DeliverWhenIdle }, false},
		{"deliver skip-if-busy", func(e *Entry) { e.Deliver = DeliverSkipIfBusy }, false},
		{"deliver unknown value", func(e *Entry) { e.Deliver = "bogus" }, true},
		{"unknown target kind", func(e *Entry) { e.Target.Kind = "bogus" }, true},
		{"role target needs role", func(e *Entry) { e.Target = Target{Kind: TargetRole} }, true},
		{"role target valid", func(e *Entry) { e.Target = Target{Kind: TargetRole, Role: RoleOperator} }, false},
		{"session target needs id", func(e *Entry) { e.Target = Target{Kind: TargetSession} }, true},
		{"pane target validates %N", func(e *Entry) { e.Target = Target{Kind: TargetPane, Pane: "12"} }, true},
		{"respawn argv valid", func(e *Entry) { e.Respawn = []string{"rk", "operator"} }, false},
		{"respawn present but empty", func(e *Entry) { e.Respawn = []string{} }, true},
		{"respawn empty argv0", func(e *Entry) { e.Respawn = []string{""} }, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := base
			tc.mutate(&e)
			err := e.validate()
			if (err != nil) != tc.wantErr {
				t.Errorf("validate() = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}

	t.Run("deliver error names the value", func(t *testing.T) {
		e := base
		e.Deliver = "bogus"
		err := e.validate()
		if err == nil || !strings.Contains(err.Error(), `unknown deliver value "bogus"`) {
			t.Errorf("validate() = %v, want `unknown deliver value \"bogus\"`", err)
		}
	})
}

// TestLoadEntriesSkipsBadCronExpr: a stored entry whose expression does not
// parse fails per-entry validation — the tolerant load skips only that entry
// with an entry-invalid diagnostic; the file's other entries load.
func TestLoadEntriesSkipsBadCronExpr(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.yaml")
	body := `
entries:
  - id: bad1
    schedule: { kind: cron, expr: "not an expr" }
    target: { kind: pane, pane: "%1" }
    payload: x
  - id: ok22
    schedule: { kind: cron, expr: "0 9 * * *", catch_up: once }
    target: { kind: pane, pane: "%2" }
    payload: y
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(entries) != 1 || entries[0].ID != "ok22" {
		t.Fatalf("entries = %+v, want only ok22 loaded", entries)
	}
	if entries[0].Schedule.CatchUp != CatchUpOnce {
		t.Errorf("catch_up = %q, want %q", entries[0].Schedule.CatchUp, CatchUpOnce)
	}
	if len(diags) != 1 || diags[0].Reason != "entry-invalid" || diags[0].EntryID != "bad1" {
		t.Errorf("diags = %+v, want one entry-invalid for bad1", diags)
	}
}

// TestLoadEntriesToleratesRetiredKeys: a file written by an older rk (carrying
// the retired anchor: and suppress_while: keys) loads with zero diagnostics —
// unknown keys are ignored — and a load never rewrites the file.
func TestLoadEntriesToleratesRetiredKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.yaml")
	body := `
entries:
  - id: a3f9
    name: operator tick
    schedule: { kind: backoff, anchor: idle, min: 60s, max: 30m }
    suppress_while: [operator-loop-fresh, nothing-tracked]
    target: { kind: role, role: operator }
    payload: "operator tick"
    deliver: immediate
    if_absent: respawn
    pinned: true
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(diags) != 0 {
		t.Errorf("diags = %+v, want none (retired keys are ignored)", diags)
	}
	if len(entries) != 1 || entries[0].ID != "a3f9" {
		t.Fatalf("entries = %+v, want a3f9 loaded", entries)
	}
	if entries[0].Schedule.Min.Duration != time.Minute {
		t.Errorf("backoff min = %v", entries[0].Schedule.Min)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != body {
		t.Error("a load rewrote the entry file")
	}
}

// TestEffectivelyMuted: the flag mutes; a lease mutes while live and lapses on
// its own once expired.
func TestEffectivelyMuted(t *testing.T) {
	now := time.Unix(1788254000, 0)
	cases := []struct {
		name string
		e    Entry
		want bool
	}{
		{"plain", Entry{}, false},
		{"flag", Entry{Muted: true}, true},
		{"live lease", Entry{MutedUntil: now.Add(time.Minute).Unix()}, true},
		{"expired lease", Entry{MutedUntil: now.Add(-time.Minute).Unix()}, false},
		{"lease expiring exactly now is lapsed", Entry{MutedUntil: now.Unix()}, false},
		{"zero lease is no lease", Entry{MutedUntil: 0}, false},
		{"flag plus expired lease", Entry{Muted: true, MutedUntil: now.Add(-time.Minute).Unix()}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.e.EffectivelyMuted(now); got != tc.want {
				t.Errorf("EffectivelyMuted = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNewID(t *testing.T) {
	taken := map[string]bool{}
	for i := 0; i < 200; i++ {
		id, err := newID(taken)
		if err != nil {
			t.Fatal(err)
		}
		if len(id) != 4 {
			t.Fatalf("id %q not 4 chars", id)
		}
		for _, c := range id {
			if !strings.ContainsRune(idAlphabet, c) {
				t.Fatalf("id %q has char %q outside alphabet", id, c)
			}
		}
		if taken[id] {
			t.Fatalf("duplicate id %q", id)
		}
		taken[id] = true
	}
}

const loopEntryYAML = `
entries:
  - id: lp01
    name: operator loop
    run: operator-loop
    schedule: { kind: backoff, min: 3m, max: 24m }
    wake_on: { event: agent-state-change, scope: server, debounce: 60s }
    pinned: true
    created_by: { at: 1788254000 }
`

func TestLoopEntryLoadsClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.yaml")
	if err := os.WriteFile(path, []byte(loopEntryYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, diags := LoadEntries(path)
	if len(diags) != 0 || len(entries) != 1 {
		t.Fatalf("entries=%+v diags=%+v", entries, diags)
	}
	e := entries[0]
	if !e.IsLoop() || e.Run != RunOperatorLoop || e.Target != (Target{}) || e.Payload != "" {
		t.Errorf("entry = %+v", e)
	}
}

func TestLoopEntryValidation(t *testing.T) {
	base := func() Entry {
		return Entry{ID: "lp01", Run: RunOperatorLoop,
			Schedule: Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{24 * time.Minute}}}
	}
	if err := base().validate(); err != nil {
		t.Fatalf("valid loop entry rejected: %v", err)
	}
	cases := []struct {
		name string
		mut  func(*Entry)
		want string
	}{
		{"unknown run", func(e *Entry) { e.Run = "other" }, "unknown run value"},
		{"payload", func(e *Entry) { e.Payload = "x" }, "payload"},
		{"target", func(e *Entry) { e.Target = Target{Kind: TargetRole, Role: "operator"} }, "target"},
		{"deliver", func(e *Entry) { e.Deliver = DeliverImmediate }, "deliver"},
		{"if_absent", func(e *Entry) { e.IfAbsent = IfAbsentSkip }, "if_absent"},
		{"respawn", func(e *Entry) { e.Respawn = []string{"rk"} }, "respawn"},
		{"bad schedule", func(e *Entry) { e.Schedule = Schedule{Kind: "bogus"} }, "unknown schedule kind"},
	}
	for _, c := range cases {
		e := base()
		c.mut(&e)
		err := e.validate()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want containing %q", c.name, err, c.want)
		}
	}
}

func TestLoopEntryYAMLOmitsDeliveryFields(t *testing.T) {
	out, err := yaml.Marshal(entryFileOut{Entries: []Entry{{ID: "lp01", Run: RunOperatorLoop,
		Schedule: Schedule{Kind: ScheduleBackoff, Min: Duration{3 * time.Minute}, Max: Duration{24 * time.Minute}}}}})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, "run: operator-loop") || strings.Contains(s, "target") || strings.Contains(s, "payload") {
		t.Errorf("yaml = %s", s)
	}
}
