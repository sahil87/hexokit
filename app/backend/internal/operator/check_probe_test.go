package operator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheck_ProbeSuccessUnchangedAndChanged(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "state", "n"))
	e.probeJSON(`{"state":"OPEN","n":1,"ignored":true}`)

	// First observation: last moves from {} to the declared fields.
	res := e.run()
	wantKinds(t, "first", res.Changes, "s:changed")
	if f := res.Changes[0].Fields["state"]; f.From != nil || f.To != "OPEN" {
		t.Errorf("state change = %+v", f)
	}
	if f := res.Changes[0].Fields["n"]; f.To != 1 {
		t.Errorf("n change = %+v (integral JSON numbers normalize to int)", f)
	}
	it := e.item("s")
	if _, leaked := it.Last["ignored"]; leaked || it.Last["state"] != "OPEN" || it.Unchanged != 0 {
		t.Errorf("item = last %v unchanged %d", it.Last, it.Unchanged)
	}

	// Not due again until check_every passes: no probe, no delta.
	e.advance(time.Minute)
	wantKinds(t, "not due", e.run().Changes)
	if e.probeCalls != 1 {
		t.Errorf("probe calls = %d, want 1 (not due yet)", e.probeCalls)
	}

	// Due with the same output: unchanged++, no delta.
	e.advance(5 * time.Minute)
	wantKinds(t, "unchanged", e.run().Changes)
	if got := e.item("s").Unchanged; got != 1 {
		t.Errorf("unchanged = %d, want 1", got)
	}

	// Due with a different declared field: a changed delta with from/to.
	e.advance(5 * time.Minute)
	e.probeJSON(`{"state":"CLOSED","n":1}`)
	res = e.run()
	wantKinds(t, "changed", res.Changes, "s:changed")
	if len(res.Changes[0].Fields) != 1 {
		t.Errorf("fields = %v, want only the differing one", res.Changes[0].Fields)
	}
	if f := res.Changes[0].Fields["state"]; f.From != "OPEN" || f.To != "CLOSED" {
		t.Errorf("state change = %+v", f)
	}
	if got := e.item("s"); got.Unchanged != 0 || got.UpdatedAt != "2026-11-11T12:11:00Z" {
		t.Errorf("unchanged %d updated_at %s", got.Unchanged, got.UpdatedAt)
	}
}

func TestCheck_GitHubPRMergeProducesChangedAndDone(t *testing.T) {
	e := newCheckEnv(t)
	it := ghItem("pr")
	it.Last = map[string]interface{}{"state": "OPEN"}
	then := "announce"
	it.Then = &then
	e.seed(it)
	e.probeJSON(`{"state":"MERGED","mergedAt":"x"}`)

	res := e.run()
	wantKinds(t, "changes", res.Changes, "pr:changed", "pr:done")
	if f := res.Changes[0].Fields["state"]; f.From != "OPEN" || f.To != "MERGED" {
		t.Errorf("state change = %+v", f)
	}
	if d := res.Changes[1]; d.Then == nil || *d.Then != "announce" {
		t.Errorf("done then = %v", d.Then)
	}
	// Done now: never probed again, done is open.
	e.advance(time.Hour)
	again := e.run()
	wantKinds(t, "again open", again.Open, "pr:done")
	if e.probeCalls != 1 {
		t.Errorf("probe calls = %d, want 1", e.probeCalls)
	}
}

func TestCheck_DottedFields(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "a.b", "a.c"))
	e.probeJSON(`{"a":{"b":1,"c":2,"d":3}}`)
	e.run()
	last := e.item("s").Last
	inner, _ := last["a"].(map[string]interface{})
	if len(inner) != 2 || inner["b"] != 1 || inner["c"] != 2 {
		t.Fatalf("last = %v, want only the declared dotted fields", last)
	}

	e.advance(10 * time.Minute)
	e.probeJSON(`{"a":{"b":1,"c":2,"d":99}}`) // undeclared field moved
	wantKinds(t, "undeclared", e.run().Changes)

	e.advance(10 * time.Minute)
	e.probeJSON(`{"a":{"b":5,"c":2}}`)
	res := e.run()
	wantKinds(t, "declared", res.Changes, "s:changed")
	if f := res.Changes[0].Fields["a.b"]; f.From != 1 || f.To != 5 || len(res.Changes[0].Fields) != 1 {
		t.Errorf("fields = %v", res.Changes[0].Fields)
	}

	// An absent declared field reports null on that side.
	e.advance(10 * time.Minute)
	e.probeJSON(`{"a":{"b":5}}`)
	res = e.run()
	if f := res.Changes[0].Fields["a.c"]; f.From != 2 || f.To != nil {
		t.Errorf("absent field = %+v", f)
	}
}

func TestCheck_ProbeFailureIsANoticeUntilThePauseCap(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "state"))
	e.probeFn = func([]string) (string, error) { return "", errors.New("exit 1: HTTP 502") }

	for failures := 1; failures <= 2; failures++ {
		res := e.run()
		if res.Changed {
			t.Fatalf("failure %d gated the check: %v", failures, kindsOf(res.Changes))
		}
		if len(res.Notices) != 1 {
			t.Fatalf("notices = %+v", res.Notices)
		}
		n := res.Notices[0]
		if n.ID != "s" || n.Kind != NoticeProbeError || n.Error != "exit 1: HTTP 502" || n.Failures != failures {
			t.Errorf("notice = %+v", n)
		}
		if got := e.item("s"); got.Failures != failures || got.Paused || got.CheckedAt == nil {
			t.Errorf("item = failures %d paused %v checked_at %v", got.Failures, got.Paused, got.CheckedAt)
		}
		e.advance(6 * time.Minute)
	}

	// The third consecutive failure pauses the item: a gating condition.
	res := e.run()
	wantKinds(t, "third failure", res.Changes, "s:paused")
	if d := res.Changes[0]; d.Failures != 3 || !d.Paused {
		t.Errorf("paused delta = %+v", d)
	}
	if !e.item("s").Paused {
		t.Error("item not paused at the cap")
	}
	// Paused items are not probed; the condition is then open.
	e.advance(time.Hour)
	again := e.run()
	wantKinds(t, "after the cap", again.Open, "s:paused")
	wantKinds(t, "after the cap changes", again.Changes)
	if e.probeCalls != 3 {
		t.Errorf("probe calls = %d, want 3", e.probeCalls)
	}
}

func TestCheck_ASuccessResetsConsecutiveFailures(t *testing.T) {
	e := newCheckEnv(t)
	it := shellItem("s", "state")
	it.Failures = 2
	e.seed(it)
	e.probeJSON(`{"state":"OPEN"}`)
	e.run()
	if got := e.item("s").Failures; got != 0 {
		t.Errorf("failures = %d, want 0 after a success", got)
	}
}

func TestCheck_NonJSONObjectOutputIsAFailure(t *testing.T) {
	for _, out := range []string{"not json", "[1,2]", "null", ""} {
		e := newCheckEnv(t)
		e.seed(shellItem("s", "state"))
		e.probeJSON(out)
		res := e.run()
		if len(res.Notices) != 1 || res.Notices[0].Error != "stdout is not a JSON object" || res.Notices[0].Failures != 1 {
			t.Errorf("output %q: notices = %+v", out, res.Notices)
		}
	}
}

func TestCheck_DueRule(t *testing.T) {
	cases := []struct {
		name      string
		checkedAt string
		every     *string
		paused    bool
		due       bool
	}{
		{"never checked", "", nil, false, true},
		{"unparsable checked_at", "garbage", nil, false, true},
		{"missing check_every defaults to 5m, fresh", "2026-11-11T11:57:00Z", nil, false, false},
		{"missing check_every defaults to 5m, due", "2026-11-11T11:55:00Z", nil, false, true},
		{"exactly at the boundary", "2026-11-11T11:55:00Z", strPtr("5m"), false, true},
		{"longer cadence not due", "2026-11-11T11:55:00Z", strPtr("10m"), false, false},
		{"paused never due", "", nil, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newCheckEnv(t)
			it := shellItem("s", "state")
			it.CheckEvery = tc.every
			it.Paused = tc.paused
			if tc.checkedAt != "" {
				it.CheckedAt = &tc.checkedAt
			}
			e.seed(it)
			e.probeJSON(`{"state":"OPEN"}`)
			e.run()
			if ran := e.probeCalls == 1; ran != tc.due {
				t.Errorf("probe ran = %v, want %v", ran, tc.due)
			}
		})
	}
}

func TestCheck_BudgetSkipsProbesNotStartedAndWritesNothingForThem(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("a", "state"), shellItem("b", "state"))
	e.probeJSON(`{"state":"OPEN"}`)

	res, err := Check(context.Background(), checkTestServer, CheckOptions{Budget: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	if e.probeCalls != 0 {
		t.Errorf("probe calls = %d, want 0 past the deadline", e.probeCalls)
	}
	if res.Changed || len(res.Notices) != 2 {
		t.Fatalf("res = %+v", res)
	}
	for _, n := range res.Notices {
		if n.Kind != NoticeSkipped || n.Error != "skipped (check budget)" || n.Failures != 0 {
			t.Errorf("notice = %+v", n)
		}
	}
	for _, id := range []string{"a", "b"} {
		if it := e.item(id); it.CheckedAt != nil || it.Failures != 0 || len(it.Last) != 0 {
			t.Errorf("%s was touched: %+v", id, it)
		}
	}
}

func TestCheck_GitHubUnavailableSkipsWithoutCountingAFailure(t *testing.T) {
	e := newCheckEnv(t)
	e.ghOK = false
	other := shellItem("plain", "state")
	e.seed(ghItem("pr"), other)
	e.probeJSON(`{"state":"OPEN"}`)

	res := e.run()
	if e.probeCalls != 1 {
		t.Errorf("probe calls = %d, want only the non-gh item", e.probeCalls)
	}
	if len(res.Notices) != 1 {
		t.Fatalf("notices = %+v", res.Notices)
	}
	n := res.Notices[0]
	if n.ID != "pr" || n.Kind != NoticeGHUnavailable || n.Error != "gh unavailable" || n.Failures != 0 {
		t.Errorf("notice = %+v", n)
	}
	pr := e.item("pr")
	if pr.CheckedAt != nil || pr.Failures != 0 {
		t.Errorf("pr = checked_at %v failures %d, want untouched", pr.CheckedAt, pr.Failures)
	}
	wantKinds(t, "changes", res.Changes, "plain:changed")
}

func TestCheck_AnItemDoneDuringPhaseOneIsNotProbedOutcomeApplied(t *testing.T) {
	e := newCheckEnv(t)
	e.seed(shellItem("s", "state"))
	started, release := blockingProbe(e, `{"state":"OPEN"}`)
	done := runCheckAsync(e)
	waitStarted(t, started)
	doneAt := "2026-11-11T11:59:00Z"
	if err := Mutate(e.path, func(st *State) error { st.Tracked[0].DoneAt = &doneAt; return nil }); err != nil {
		t.Fatal(err)
	}
	release()
	waitDone(t, done)
	if got := e.item("s"); len(got.Last) != 0 {
		t.Errorf("last = %v, a probe outcome must not land on an item completed meanwhile", got.Last)
	}
}

// --- the default runner, against real (harmless) subprocesses ------------------

func TestDefaultProbeRunner(t *testing.T) {
	ctx := context.Background()

	out, err := defaultProbeRunner(ctx, []string{"sh", "-c", `echo '{"a":1}'`})
	if err != nil || strings.TrimSpace(out) != `{"a":1}` {
		t.Errorf("success: out %q err %v", out, err)
	}

	_, err = defaultProbeRunner(ctx, []string{"sh", "-c", "echo first line >&2; echo second >&2; exit 3"})
	if err == nil || err.Error() != "exit 3: first line" {
		t.Errorf("exit error = %v, want %q", err, "exit 3: first line")
	}

	_, err = defaultProbeRunner(ctx, []string{"sh", "-c", "exit 4"})
	if err == nil || err.Error() != "exit 4" {
		t.Errorf("bare exit error = %v", err)
	}

	_, err = defaultProbeRunner(ctx, []string{"definitely-not-a-binary-xyz"})
	if err == nil || !strings.Contains(err.Error(), "executable file not found") {
		t.Errorf("lookup error = %v", err)
	}

	if _, err := defaultProbeRunner(ctx, nil); err == nil {
		t.Error("an empty argv must fail")
	}

	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := defaultProbeRunner(tctx, []string{"sleep", "5"}); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Errorf("timeout error = %v", err)
	}
}

func TestDefaultProbeRunnerNeverUsesAShell(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "injected")
	// A shell would run the second command; argv-only passes it as one literal
	// argument to echo.
	out, err := defaultProbeRunner(context.Background(), []string{"echo", "x; touch " + marker})
	if err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Error("argv was interpreted by a shell")
	}
	if !strings.Contains(out, "touch") {
		t.Errorf("out = %q", out)
	}
}
