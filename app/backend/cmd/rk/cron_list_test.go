package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
)

// NOTE (tmux safety): list is disk-derived only — it issues ZERO tmux
// commands by construction (the code path touches the entry file and the
// delivery log, nothing else), so these tests need no tmux seam at all; an
// absent server must list fine.

const cronListFixture = `
entries:
  - id: a3f9
    name: hourly sweep
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%42" }
    payload: "sweep"
    deliver: immediate
    if_absent: skip
    muted: true
    created_by: { pane: "%42", at: 1756999999 }
  - id: k7q2
    name: op tick
    schedule: { kind: backoff, min: 60s, max: 30m }
    wake_on: { event: agent-state-change, scope: server, debounce: 2m }
    target: { kind: role, role: operator }
    payload: "tick"
    deliver: when-idle
    if_absent: respawn
    respawn: ["rk", "operator", "-L", "{server}"]
    pinned: true
  - id: cr0n
    name: morning digest
    schedule: { kind: cron, expr: "0 9 * * *", catch_up: once }
    target: { kind: pane, pane: "%43" }
    payload: "digest"
`

func writeCronFixture(t *testing.T, dir, slug, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, slug+".yaml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestCronListEmpty: an absent entry file yields the header-only table (or []
// under --json) with exit 0.
func TestCronListEmpty(t *testing.T) {
	stubCronDir(t)
	stubCronTMUX(t)

	stdout, _, err := runCronCmd(t, "list")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if strings.Count(strings.TrimSpace(stdout), "\n") != 0 {
		t.Errorf("stdout = %q, want header only", stdout)
	}

	stdout, _, err = runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v, want exit 0", err)
	}
	var records []cronListRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 0 {
		t.Errorf("records = %v, want empty array", records)
	}
}

// TestCronListRows: the human table carries id, name, schedule summary,
// target, deliver, flags, and the last-fired join from the delivery log.
func TestCronListRows(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", cronListFixture)
	if err := os.WriteFile(filepath.Join(dir, "work.log"), []byte(
		`{"ts":1757001111,"entry":"a3f9","target":"%42","reason":"schedule","outcome":"no-deliverer"}`+"\n"+
			`{"ts":1757002222,"entry":"a3f9","target":"%42","reason":"schedule","outcome":"no-deliverer"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, _, err := runCronCmd(t, "list")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, want := range []string{
		"a3f9", "hourly sweep", "every 1h", "pane:%42", "immediate", "muted",
		"k7q2", "op tick", "backoff 1m→30m", "role:operator", "when-idle", "pinned",
		"cr0n", "morning digest", "cron 0 9 * * * (catch-up once)", "pane:%43",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout missing %q:\n%s", want, stdout)
		}
	}
	// Last-fired is the NEWEST log line for the entry; k7q2 never fired.
	if want := cronListLastFired(1757002222); !strings.Contains(stdout, want) {
		t.Errorf("stdout missing the rendered last-fired %q:\n%s", want, stdout)
	}
}

// TestCronListJSON: --json emits the same records as an array, with the
// last-fired join as a unix timestamp.
func TestCronListJSON(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", cronListFixture)
	if err := os.WriteFile(filepath.Join(dir, "work.log"), []byte(
		`{"ts":1757002222,"entry":"a3f9","target":"%42","reason":"schedule","outcome":"no-deliverer"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, _, err := runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v, want exit 0", err)
	}
	var records []cronListRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 3 {
		t.Fatalf("records = %d, want 3", len(records))
	}
	if records[0].ID != "a3f9" || records[0].Schedule.Kind != "every" || records[0].Schedule.Interval != "1h0m0s" ||
		records[0].ScheduleSummary != "every 1h" || records[0].Target != "pane:%42" ||
		!records[0].Muted || records[0].LastFired != 1757002222 {
		t.Errorf("records[0] = %+v, want the a3f9 row with the last-fired join", records[0])
	}
	// a3f9's only log line is failed-class (never resolved evidence), so the
	// streak runs from it; unpinned ⇒ expires_at = since + OrphanTTL.
	if records[0].OrphanedSince != 1757002222 {
		t.Errorf("records[0].OrphanedSince = %d, want 1757002222", records[0].OrphanedSince)
	}
	if want := 1757002222 + int64(cron.OrphanTTL/time.Second); records[0].ExpiresAt != want {
		t.Errorf("records[0].ExpiresAt = %d, want %d", records[0].ExpiresAt, want)
	}
	// k7q2 is a role target — never a GC subject, so the streak stays zero.
	if records[1].ID != "k7q2" || !records[1].Pinned || records[1].LastFired != 0 {
		t.Errorf("records[1] = %+v, want the k7q2 row, pinned, never fired", records[1])
	}
	if records[1].OrphanedSince != 0 || records[1].ExpiresAt != 0 {
		t.Errorf("records[1] OrphanedSince/ExpiresAt = %d/%d, want 0/0 for a role target",
			records[1].OrphanedSince, records[1].ExpiresAt)
	}
}

// TestCronListSkipIfBusyDeliver: a skip-if-busy entry renders its policy in
// the DELIVER column and in --json (the column predates the value — this pins
// the round-trip, no renderer change).
func TestCronListSkipIfBusyDeliver(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", `
entries:
  - id: s1kp
    name: busy skip
    schedule: { kind: every, interval: 5m }
    target: { kind: pane, pane: "%42" }
    payload: "sweep"
    deliver: skip-if-busy
`)

	stdout, _, err := runCronCmd(t, "list")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(stdout, "skip-if-busy") {
		t.Errorf("stdout missing the skip-if-busy DELIVER cell:\n%s", stdout)
	}

	stdout, _, err = runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v, want exit 0", err)
	}
	var records []cronListRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 1 || records[0].Deliver != cron.DeliverSkipIfBusy {
		t.Errorf("records = %+v, want the s1kp row with deliver skip-if-busy", records)
	}
}

// TestCronListJSONIntentFields: --json carries the entry's intent as
// structured fields keyed like the on-disk schema — schedule {kind + only the
// parameters the kind uses}, wake_on (object or null, never omitted),
// if_absent (raw, "" when unset), respawn ([] when unset, argv verbatim
// otherwise) — plus schedule_summary, the table's rendering.
func TestCronListJSONIntentFields(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", cronListFixture)

	stdout, _, err := runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v, want exit 0", err)
	}
	var raw []map[string]any
	unwrapEnvelopeResult(t, stdout, &raw)
	if len(raw) != 3 {
		t.Fatalf("records = %d, want 3", len(raw))
	}
	every, backoff, cronKind := raw[0], raw[1], raw[2]

	// schedule: kind always present; each kind carries only its own parameters.
	wantSchedules := map[string]map[string]any{
		"a3f9": {"kind": "every", "interval": "1h0m0s"},
		"k7q2": {"kind": "backoff", "min": "1m0s", "max": "30m0s"},
		"cr0n": {"kind": "cron", "expr": "0 9 * * *", "catch_up": "once"},
	}
	for _, rec := range raw {
		id, _ := rec["id"].(string)
		got, ok := rec["schedule"].(map[string]any)
		if !ok {
			t.Fatalf("%s schedule = %T %v, want an object", id, rec["schedule"], rec["schedule"])
		}
		if want := wantSchedules[id]; len(got) != len(want) {
			t.Errorf("%s schedule = %v, want exactly %v", id, got, want)
		} else {
			for k, v := range want {
				if got[k] != v {
					t.Errorf("%s schedule[%q] = %v, want %v", id, k, got[k], v)
				}
			}
		}
	}

	// schedule_summary keeps the table's rendering.
	if every["schedule_summary"] != "every 1h" || backoff["schedule_summary"] != "backoff 1m→30m" ||
		cronKind["schedule_summary"] != "cron 0 9 * * * (catch-up once)" {
		t.Errorf("schedule_summary = %v / %v / %v, want the table renderings",
			every["schedule_summary"], backoff["schedule_summary"], cronKind["schedule_summary"])
	}

	// wake_on: present on every record — null without a block, object with one.
	for _, rec := range []map[string]any{every, cronKind} {
		v, ok := rec["wake_on"]
		if !ok {
			t.Errorf("%s: wake_on key missing, want null", rec["id"])
		} else if v != nil {
			t.Errorf("%s: wake_on = %v, want null", rec["id"], v)
		}
	}
	wakeOn, ok := backoff["wake_on"].(map[string]any)
	if !ok || wakeOn["event"] != "agent-state-change" || wakeOn["scope"] != "server" || wakeOn["debounce"] != "2m0s" || len(wakeOn) != 3 {
		t.Errorf("k7q2 wake_on = %v, want {event: agent-state-change, scope: server, debounce: 2m0s}", backoff["wake_on"])
	}

	// if_absent raw; respawn [] when unset, argv verbatim (placeholder intact) when set.
	if every["if_absent"] != "skip" || backoff["if_absent"] != "respawn" || cronKind["if_absent"] != "" {
		t.Errorf("if_absent = %v / %v / %v, want skip / respawn / \"\" (raw stored value, never a default)",
			every["if_absent"], backoff["if_absent"], cronKind["if_absent"])
	}
	if arr, ok := every["respawn"].([]any); !ok || len(arr) != 0 {
		t.Errorf("a3f9 respawn = %v (%T), want an empty array, never null", every["respawn"], every["respawn"])
	}
	wantArgv := []any{"rk", "operator", "-L", "{server}"}
	gotArgv, _ := backoff["respawn"].([]any)
	if len(gotArgv) != len(wantArgv) {
		t.Fatalf("k7q2 respawn = %v, want %v", gotArgv, wantArgv)
	}
	for i := range wantArgv {
		if gotArgv[i] != wantArgv[i] {
			t.Errorf("k7q2 respawn[%d] = %v, want %v", i, gotArgv[i], wantArgv[i])
		}
	}
}

// TestCronListToleratesCorruptEntries: a file mixing a valid entry with a
// malformed one lists the valid entry, prints a diagnostic to stderr, and
// exits 0 (the tolerant-load posture).
func TestCronListToleratesCorruptEntries(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", `
entries:
  - id: a3f9
    name: good
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%42" }
    payload: "sweep"
  - id: bad1
    schedule: { kind: sideways }
    target: { kind: pane, pane: "%42" }
    payload: "x"
`)

	stdout, stderr, err := runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list: %v — a corrupt entry must not fail the listing (want exit 0)", err)
	}
	var records []cronListRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 1 || records[0].ID != "a3f9" {
		t.Fatalf("records = %+v, want only the valid entry", records)
	}
	if !strings.Contains(stderr, "entry-invalid") {
		t.Errorf("stderr = %q, want the entry-invalid diagnostic", stderr)
	}
}

// TestCronListMuteLease: a live lease renders muted(<remaining>) in FLAGS and
// reports effective muted + muted_until in --json; an expired lease renders
// neither (effective muted governs — no flag is needed for the lease form).
func TestCronListMuteLease(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	origNow := cronNowFn
	cronNowFn = func() time.Time { return time.Unix(1757000000, 0) }
	t.Cleanup(func() { cronNowFn = origNow })
	writeCronFixture(t, dir, "work", `
entries:
  - id: l1ve
    name: leased
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%42" }
    payload: "sweep"
    muted_until: 1757000240
  - id: xp1r
    name: expired lease
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%43" }
    payload: "sweep"
    muted_until: 1756999900
`)

	stdout, _, err := runCronCmd(t, "list")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(stdout, "muted(4m)") {
		t.Errorf("stdout missing the lease flag \"muted(4m)\":\n%s", stdout)
	}
	if strings.Contains(stdout, "xp1r") && strings.Contains(
		stdout[strings.Index(stdout, "xp1r"):], "muted") {
		t.Errorf("expired lease row renders a muted flag:\n%s", stdout)
	}

	stdout, _, err = runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v, want exit 0", err)
	}
	var raw []map[string]any
	unwrapEnvelopeResult(t, stdout, &raw)
	if len(raw) != 2 {
		t.Fatalf("records = %d, want 2", len(raw))
	}
	if raw[0]["muted"] != true || raw[0]["muted_until"] != float64(1757000240) {
		t.Errorf("live lease record = %v, want muted:true muted_until:1757000240", raw[0])
	}
	if raw[1]["muted"] != false {
		t.Errorf("expired lease record muted = %v, want false (the effective state)", raw[1]["muted"])
	}
	if _, ok := raw[1]["muted_until"]; ok {
		t.Errorf("expired lease record carries muted_until: %v", raw[1])
	}
}

// TestCronListJSONWakeOnRoundTrip: an entry added with --wake-on lists its
// block under --json (debounce in the cronListDur rendering); one added
// without lists wake_on: null. No list-side code is involved — the flag-to-
// file-to-JSON round-trip is the contract.
func TestCronListJSONWakeOnRoundTrip(t *testing.T) {
	stubCronDir(t)
	stubCronTMUX(t)
	stubCronAddSeams(t, "", nil)
	t.Setenv("TMUX_PANE", "%12")

	if _, _, err := runCronCmd(t, "add", "waking", "--every", "1h",
		"--wake-on", "agent-state-change", "--wake-debounce", "2m"); err != nil {
		t.Fatalf("add with --wake-on: %v", err)
	}
	if _, _, err := runCronCmd(t, "add", "plain", "--every", "1h"); err != nil {
		t.Fatalf("add without --wake-on: %v", err)
	}

	stdout, _, err := runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v", err)
	}
	var raw []map[string]any
	unwrapEnvelopeResult(t, stdout, &raw)
	if len(raw) != 2 {
		t.Fatalf("records = %d, want 2", len(raw))
	}
	wakeOn, ok := raw[0]["wake_on"].(map[string]any)
	if !ok || wakeOn["event"] != "agent-state-change" || wakeOn["scope"] != "server" || wakeOn["debounce"] != "2m0s" {
		t.Errorf("row 0 wake_on = %v, want {event: agent-state-change, scope: server, debounce: 2m0s}", raw[0]["wake_on"])
	}
	v, ok := raw[1]["wake_on"]
	if !ok || v != nil {
		t.Errorf("row 1 wake_on = %v (present %v), want the key present and null", v, ok)
	}
}

// TestCronListLoopEntry: the target-less operator-loop entry lists with target
// `operator loop`, mirrors its `run` key under --json, never reports an orphan
// streak, and leaves typed entries' key set untouched.
func TestCronListLoopEntry(t *testing.T) {
	dir := stubCronDir(t)
	stubCronTMUX(t)
	writeCronFixture(t, dir, "work", `
entries:
  - id: lp01
    name: operator loop
    run: operator-loop
    schedule: { kind: backoff, min: 3m, max: 24m }
    wake_on: { event: agent-state-change, scope: server, debounce: 60s }
    pinned: true
    created_by: { at: 1756999999 }
  - id: a3f9
    name: hourly sweep
    schedule: { kind: every, interval: 1h }
    target: { kind: pane, pane: "%42" }
    payload: "sweep"
`)
	stdout, _, err := runCronCmd(t, "list")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(stdout, "operator loop") || !strings.Contains(stdout, "backoff 3m→24m") || !strings.Contains(stdout, "pane:%42") {
		t.Errorf("table:\n%s", stdout)
	}

	stdout, _, err = runCronCmd(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v", err)
	}
	var records []cronListRecord
	unwrapEnvelopeResult(t, stdout, &records)
	loop, typed := records[0], records[1]
	if loop.Run != "operator-loop" || loop.Target != "operator loop" || !loop.Pinned || loop.OrphanedSince != 0 || loop.ExpiresAt != 0 {
		t.Errorf("loop record = %+v", loop)
	}
	if typed.Run != "" {
		t.Errorf("typed record carries run: %+v", typed)
	}
	if strings.Count(stdout, `"run"`) != 1 {
		t.Errorf("run key must appear only on the loop record:\n%s", stdout)
	}
}
