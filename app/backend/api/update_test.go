package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rk/internal/daemon"
	"rk/internal/updatecheck"
)

// qualifyingChecker returns a checker whose cached snapshot reports a pending
// qualifying update for run-kit (3.8.0 → 3.9.0) without a real `shll
// check-updates` exec: the check seam is stubbed with a run-kit-only report
// (deterministic argv for the remediation tests).
func qualifyingChecker(t *testing.T) *updatecheck.Checker {
	t.Helper()
	c := updatecheck.New("3.8.0", true)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{Schema: 1, Tools: []updatecheck.CheckTool{
			{Name: "run-kit", Formula: "run-kit", Latest: "3.9.0", Notify: "minor"},
		}}, nil
	})
	c.CheckOnceForTest()
	if len(c.Snapshot().Matched) == 0 {
		t.Fatalf("test setup: checker snapshot should match, got %+v", c.Snapshot())
	}
	return c
}

// multiToolChecker returns a checker matching BOTH run-kit and fab-kit, so the
// shll-present scoped-argv test can assert the full matched set is passed.
func multiToolChecker(t *testing.T) *updatecheck.Checker {
	t.Helper()
	c := updatecheck.New("3.8.0", true)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{Schema: 1, Tools: []updatecheck.CheckTool{
			{Name: "run-kit", Formula: "run-kit", Latest: "3.9.0", Notify: "minor"},
			{Name: "fab-kit", Formula: "fab-kit", Installed: "2.16.0", Latest: "2.17.0", Notify: "minor", UpdateAvailable: true, Notable: true},
		}}, nil
	})
	c.CheckOnceForTest()
	if len(c.Snapshot().Matched) != 2 {
		t.Fatalf("test setup: expected 2 matched tools, got %+v", c.Snapshot().Matched)
	}
	return c
}

// jobRecord captures a recorded RunJob call (window + argv) from the runJobFn
// seam, so tests can assert the job window and argv without a live tmux server.
type jobRecord struct {
	called bool
	window string
	argv   []string
}

// withSeams swaps the update/restart handlers' package-var seams for the
// duration of a test and restores them afterward. The daemon is scripted
// RUNNING (the 260812-z1ya first gate); shllPath="" (with shllErr non-nil)
// forces the shll-absent fallback path; a non-empty shllPath forces the
// shll-present scoped path.
func withSeams(t *testing.T, selfPath string, resolveErr error, shllPath string, shllErr error, runJob func(ctx context.Context, window string, argv []string) (daemon.JobTarget, bool, error)) {
	t.Helper()
	origResolve, origShll, origRunning, origRunJob := resolveSelfPathFn, lookShllFn, daemonRunningFn, runJobFn
	resolveSelfPathFn = func() (string, error) { return selfPath, resolveErr }
	lookShllFn = func() (string, error) { return shllPath, shllErr }
	daemonRunningFn = func() bool { return true }
	runJobFn = runJob
	t.Cleanup(func() {
		resolveSelfPathFn = origResolve
		lookShllFn = origShll
		daemonRunningFn = origRunning
		runJobFn = origRunJob
	})
}

// errNoShll is the shll-lookup error stub for the fallback-path tests (forces
// the shll-absent branch of handleUpdate).
var errNoShll = errors.New("exec: \"shll\": executable file not found in $PATH")

// recordingJob returns a RunJob stub that records its call into rec and
// reports a fresh spawn (window id @5).
func recordingJob(rec *jobRecord) func(context.Context, string, []string) (daemon.JobTarget, bool, error) {
	return func(_ context.Context, window string, argv []string) (daemon.JobTarget, bool, error) {
		rec.called = true
		rec.window = window
		rec.argv = argv
		return daemon.JobTarget{Server: "rk-daemon", Session: "rk-jobs", Window: window, WindowID: "@5"}, true, nil
	}
}

// assertJobBody decodes a 202/200 job response and verifies the status and the
// populated watch target.
func assertJobBody(t *testing.T, res *httptest.ResponseRecorder, wantStatus, wantWindow string) {
	t.Helper()
	var body jobResponse
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != wantStatus {
		t.Errorf("body status = %q, want %q", body.Status, wantStatus)
	}
	want := jobWatchPayload{Server: "rk-daemon", Session: "rk-jobs", Window: wantWindow, WindowID: "@5"}
	if body.Watch != want {
		t.Errorf("watch = %+v, want %+v", body.Watch, want)
	}
}

func newUpdateServer(checker *updatecheck.Checker) *Server {
	return &Server{logger: slog.Default(), updateChecker: checker}
}

// postUpdate issues a POST /api/update with the given raw body (nil = no body).
func postUpdate(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, "/api/update", nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, "/api/update", strings.NewReader(body))
	}
	s.handleUpdate(rec, req)
	return rec
}

// ----- daemon gate (260812-z1ya) -----

// TestHandleUpdateDaemonDown409 verifies the new first gate: with the rk-daemon
// tmux server down, POST /api/update refuses 409 naming the requirement and
// never reaches the spawn (intake decision 1 — no detached-spawn fallback).
func TestHandleUpdateDaemonDown409(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	daemonRunningFn = func() bool { return false }
	s := newUpdateServer(multiToolChecker(t))

	res := postUpdate(t, s, "")

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 when the daemon is not running (body=%s)", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "rk serve -d") {
		t.Errorf("error body = %q, want it to name the fix (rk serve -d)", res.Body.String())
	}
	if rec.called {
		t.Error("must not spawn the job window when the daemon is not running")
	}
}

// ----- shll-present (scoped toolkit update) path -----

// TestHandleUpdateShllScopedSpawnsMatched verifies R9: with shll present and a
// non-force click, the handler runs `shll update <matched tools…>` in the
// `update` job window with the checker's match set as argv, and the 202 carries
// the watch target.
func TestHandleUpdateShllScopedSpawnsMatched(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	s := newUpdateServer(multiToolChecker(t))

	res := postUpdate(t, s, "")

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
	}
	assertJobBody(t, res, "updating", "update")
	if rec.window != "update" {
		t.Errorf("job window = %q, want update", rec.window)
	}
	// argv = [<shll path> update --yes <matched roster order>]. Matched is
	// roster order (fab-kit before run-kit, sorted names); --yes is the
	// handler's unattended-consent flag, present on every spawn.
	want := []string{"/opt/homebrew/bin/shll", "update", "--yes", "fab-kit", "run-kit"}
	if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
		t.Errorf("job argv = %v, want %v", rec.argv, want)
	}
}

// TestHandleUpdateShllDropsFlagLikeToolName verifies the manifest is remote
// input: a matched tool name that could be interpreted as a flag (leading `-`)
// is dropped from the `shll update` argv rather than passed through, so it can
// never inject into shll's flag parser. A legitimate sibling in the same match
// set is still passed.
func TestHandleUpdateShllDropsFlagLikeToolName(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	// A checker whose match set contains a hostile report tool name ("--force")
	// next to a legitimate sibling. run-kit itself is at latest so its row won't
	// match, keeping the assertion focused on the sibling verdicts.
	c := updatecheck.New("3.9.0", true)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{Schema: 1, Tools: []updatecheck.CheckTool{
			{Name: "fab-kit", Formula: "fab-kit", Installed: "2.16.0", Latest: "2.17.0", Notify: "minor", UpdateAvailable: true, Notable: true},
			{Name: "--force", Formula: "evil", Installed: "1.0.0", Latest: "9.9.9", Notify: "minor", UpdateAvailable: true, Notable: true},
		}}, nil
	})
	c.CheckOnceForTest()
	if len(c.Snapshot().Matched) != 2 {
		t.Fatalf("test setup: expected 2 matched tools (incl. the hostile key), got %+v", c.Snapshot().Matched)
	}
	s := newUpdateServer(c)

	res := postUpdate(t, s, "")

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
	}
	// argv must carry the legit sibling only — the flag-like name is dropped.
	// The handler-added --yes is present by construction, never via the manifest.
	want := []string{"/opt/homebrew/bin/shll", "update", "--yes", "fab-kit"}
	if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
		t.Errorf("job argv = %v, want %v (flag-like tool name must be dropped)", rec.argv, want)
	}
	for _, a := range rec.argv {
		if a == "--force" {
			t.Errorf("hostile manifest tool name reached argv: %v", rec.argv)
		}
	}
}

// TestHandleUpdateShllNoMatch409 verifies R9: shll present but nothing matches →
// 409 before any spawn (the non-force qualify gate).
func TestHandleUpdateShllNoMatch409(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	// A checker at latest — no match.
	c := updatecheck.New("3.9.0", true)
	s := newUpdateServer(c)

	res := postUpdate(t, s, "")

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 when nothing matches (body=%s)", res.Code, res.Body.String())
	}
	if rec.called {
		t.Errorf("must not spawn shll update with an empty match set on the non-force path")
	}
}

// TestHandleUpdateShllForceFullRoster verifies R10: force with shll present
// runs a full-roster `shll update` (no tool args) and skips the match 409.
func TestHandleUpdateShllForceFullRoster(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	// No matching update — force must bypass the match 409.
	s := newUpdateServer(updatecheck.New("3.9.0", true))

	res := postUpdate(t, s, `{"force":true}`)

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 on force even without a match (body=%s)", res.Code, res.Body.String())
	}
	if !rec.called {
		t.Fatalf("force must run shll update")
	}
	want := []string{"/opt/homebrew/bin/shll", "update", "--yes"}
	if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
		t.Errorf("force job argv = %v, want %v (full-roster sweep)", rec.argv, want)
	}
}

// TestHandleUpdateShllPresentIgnoresBrew409 verifies R11: with shll present, a
// run-kit-not-brew daemon is NOT refused with the brew-409 — the scoped path has
// no brew gate. (The checker matches a sibling so there's something to update.)
func TestHandleUpdateShllPresentIgnoresBrew409(t *testing.T) {
	var rec jobRecord
	// resolveSelfPathFn returns a NON-brew path, but the shll-present path never
	// consults it.
	withSeams(t, "/usr/local/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&rec))
	// A checker matching fab-kit only (run-kit not brew, so its row is gated off).
	c := updatecheck.New("3.9.0", false)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{Schema: 1, Tools: []updatecheck.CheckTool{
			{Name: "fab-kit", Formula: "fab-kit", Installed: "2.16.0", Latest: "2.17.0", Notify: "minor", UpdateAvailable: true, Notable: true},
		}}, nil
	})
	c.CheckOnceForTest()
	s := newUpdateServer(c)

	res := postUpdate(t, s, "")

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (no brew-409 on the shll path) (body=%s)", res.Code, res.Body.String())
	}
	want := []string{"/opt/homebrew/bin/shll", "update", "--yes", "fab-kit"}
	if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
		t.Errorf("job argv = %v, want %v", rec.argv, want)
	}
}

// TestHandleUpdateAlreadyRunning200 verifies intake decision 4: with a live
// in-flight update window (RunJob reports started=false), the handler answers
// 200 already-running with the EXISTING window's watch target — the second
// click becomes navigation, not an error and not a duplicate spawn.
func TestHandleUpdateAlreadyRunning200(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil,
		func(_ context.Context, window string, _ []string) (daemon.JobTarget, bool, error) {
			return daemon.JobTarget{Server: "rk-daemon", Session: "rk-jobs", Window: window, WindowID: "@5"}, false, nil
		})
	s := newUpdateServer(multiToolChecker(t))

	res := postUpdate(t, s, "")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 already-running (body=%s)", res.Code, res.Body.String())
	}
	assertJobBody(t, res, "already-running", "update")
}

// TestHandleUpdateSpawnError502 verifies spawn-before-respond: a RunJob failure
// is a reportable 502 (the window survives the daemon restart, so the handler
// no longer has to commit 202 before spawning).
func TestHandleUpdateSpawnError502(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil,
		func(context.Context, string, []string) (daemon.JobTarget, bool, error) {
			return daemon.JobTarget{}, false, errors.New("tmux exploded")
		})
	s := newUpdateServer(multiToolChecker(t))

	res := postUpdate(t, s, "")

	if res.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 on a spawn error (body=%s)", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "tmux exploded") {
		t.Errorf("error body = %q, want the spawn failure reason", res.Body.String())
	}
}

// TestHandleUpdateShllScopedSchedulesRecheck verifies R17: a scoped non-force
// `shll update` spawn triggers a post-remediation re-check on the checker with
// the ~2min delay, so a consumed match clears without waiting for the 6h tick.
func TestHandleUpdateShllScopedSchedulesRecheck(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&jobRecord{}))
	c := multiToolChecker(t)
	var gotDelays []time.Duration
	c.SetRecheckHookForTest(func(d time.Duration) { gotDelays = append(gotDelays, d) })
	s := newUpdateServer(c)

	if res := postUpdate(t, s, ""); res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
	}
	if len(gotDelays) != 1 {
		t.Fatalf("post-remediation re-check scheduled %d times, want 1", len(gotDelays))
	}
	if gotDelays[0] != postRemediationRecheckDelay {
		t.Errorf("re-check delay = %v, want %v", gotDelays[0], postRemediationRecheckDelay)
	}
}

// TestHandleUpdateShllForceSchedulesRecheck verifies R17 for the force sweep:
// a full-roster `shll update` also schedules the post-remediation re-check.
func TestHandleUpdateShllForceSchedulesRecheck(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "/opt/homebrew/bin/shll", nil, recordingJob(&jobRecord{}))
	c := updatecheck.New("3.9.0", true) // no match — force bypasses the 409
	var scheduled int
	c.SetRecheckHookForTest(func(time.Duration) { scheduled++ })
	s := newUpdateServer(c)

	if res := postUpdate(t, s, `{"force":true}`); res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
	}
	if scheduled != 1 {
		t.Errorf("force sweep scheduled %d re-checks, want 1", scheduled)
	}
}

// TestHandleUpdateSelfPathNoRecheck verifies R17: the shll-absent `rk update`
// fallback schedules NO re-check (the restart resets state on its own).
func TestHandleUpdateSelfPathNoRecheck(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "", errNoShll, recordingJob(&jobRecord{}))
	c := qualifyingChecker(t)
	scheduled := 0
	c.SetRecheckHookForTest(func(time.Duration) { scheduled++ })
	s := newUpdateServer(c)

	if res := postUpdate(t, s, ""); res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
	}
	if scheduled != 0 {
		t.Errorf("shll-absent fallback scheduled %d re-checks, want 0", scheduled)
	}
}

// ----- shll-absent (run-kit-self) fallback path -----

func TestHandleUpdateAcceptedSpawns(t *testing.T) {
	for _, exe := range []string{
		"/opt/homebrew/Cellar/hexokit/3.8.0/bin/hexokit",
		"/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit",
	} {
		t.Run(exe, func(t *testing.T) {
			var rec jobRecord
			withSeams(t, exe, nil, "", errNoShll, recordingJob(&rec))
			s := newUpdateServer(qualifyingChecker(t))

			res := postUpdate(t, s, "")

			if res.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202 (body=%s)", res.Code, res.Body.String())
			}
			assertJobBody(t, res, "updating", "update")
			want := []string{exe, "update"}
			if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
				t.Errorf("job argv = %v, want %v", rec.argv, want)
			}
		})
	}
}

func TestHandleUpdateNotBrewInstalled(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/usr/local/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
	s := newUpdateServer(qualifyingChecker(t))

	res := postUpdate(t, s, "")

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for non-brew install (body=%s)", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "brew install sahil87/tap/hexokit") {
		t.Errorf("error body = %q, want it to name brew install sahil87/tap/hexokit", res.Body.String())
	}
	if rec.called {
		t.Errorf("must not spawn rk update when not brew-installed")
	}
}

func TestHandleUpdateNoUpdateAvailable(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
	// A checker with no matching update (never checked / same version).
	c := updatecheck.New("3.9.0", true)
	s := newUpdateServer(c)

	res := postUpdate(t, s, "")

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 when no update pending (body=%s)", res.Code, res.Body.String())
	}
	if rec.called {
		t.Errorf("must not spawn rk update when no update is pending")
	}
}

func TestHandleUpdateNilCheckerNoUpdate(t *testing.T) {
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "", errNoShll, func(context.Context, string, []string) (daemon.JobTarget, bool, error) {
		t.Fatalf("must not spawn with a nil checker")
		return daemon.JobTarget{}, false, nil
	})
	s := newUpdateServer(nil)

	res := postUpdate(t, s, "")

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 with a nil checker", res.Code)
	}
}

// TestHandleUpdateSecondClick verifies the in-flight contract end to end: the
// first click spawns (202), and a second POST — with RunJob reporting the live
// window (started=false) — answers 200 already-running with the same watch
// target (intake decision 4; no duplicate window is ever spawned).
func TestHandleUpdateSecondClick(t *testing.T) {
	spawns := 0
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.8.0/bin/run-kit", nil, "", errNoShll,
		func(_ context.Context, window string, _ []string) (daemon.JobTarget, bool, error) {
			spawns++
			// The first call reports a fresh spawn; every later call finds the
			// live window (RunJob's dedup branch).
			return daemon.JobTarget{Server: "rk-daemon", Session: "rk-jobs", Window: window, WindowID: "@5"}, spawns == 1, nil
		})
	s := newUpdateServer(qualifyingChecker(t))

	res := postUpdate(t, s, "")
	if res.Code != http.StatusAccepted {
		t.Fatalf("click 1: status = %d, want 202", res.Code)
	}
	res = postUpdate(t, s, "")
	if res.Code != http.StatusOK {
		t.Fatalf("click 2: status = %d, want 200 already-running", res.Code)
	}
	assertJobBody(t, res, "already-running", "update")
}

// TestHandleUpdateForceSkipsQualifyKeepsBrew verifies R11: on the shll-absent
// path, force=true skips the qualify 409 (no pending update) but still spawns
// for a brew install.
func TestHandleUpdateForceSkipsQualifyKeepsBrew(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
	// A checker with NO matching update — force must bypass the qualify 409.
	s := newUpdateServer(updatecheck.New("3.9.0", true))

	res := postUpdate(t, s, `{"force":true}`)

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 on force even without a matching update (body=%s)", res.Code, res.Body.String())
	}
	if !rec.called {
		t.Errorf("force=true must spawn rk update even without a matching update")
	}
	want := []string{"/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", "update"}
	if strings.Join(rec.argv, " ") != strings.Join(want, " ") {
		t.Errorf("force job argv = %v, want %v", rec.argv, want)
	}
}

// TestHandleUpdateForceNilChecker verifies force=true bypasses the nil-checker
// 409 too on the shll-absent path (the qualify branch is fully gated behind
// !force).
func TestHandleUpdateForceNilChecker(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
	s := newUpdateServer(nil)

	res := postUpdate(t, s, `{"force":true}`)

	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 on force with a nil checker (body=%s)", res.Code, res.Body.String())
	}
	if !rec.called {
		t.Errorf("force=true must spawn even with a nil checker")
	}
}

// TestHandleUpdateForceKeepsBrew409 verifies R11: on the shll-absent path, force
// does NOT bypass the brew 409 — a non-brew install is still refused.
func TestHandleUpdateForceKeepsBrew409(t *testing.T) {
	var rec jobRecord
	withSeams(t, "/usr/local/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
	s := newUpdateServer(nil)

	res := postUpdate(t, s, `{"force":true}`)

	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 — force must NOT bypass the brew requirement (body=%s)", res.Code, res.Body.String())
	}
	if rec.called {
		t.Errorf("must not spawn on a non-brew install even with force=true")
	}
}

// ----- POST /api/updates/check (on-demand check) -----

// postUpdatesCheck issues a POST /api/updates/check with the given raw body
// ("" = no body).
func postUpdatesCheck(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(http.MethodPost, "/api/updates/check", nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, "/api/updates/check", strings.NewReader(body))
	}
	s.handleUpdatesCheck(rec, req)
	return rec
}

// TestHandleUpdatesCheckReturnsFreshVerdict verifies the endpoint runs one
// inline pass and returns the fresh verdict synchronously in the shared
// SSE-payload shape (full per-tool verdict list + notable-derived key).
func TestHandleUpdatesCheckReturnsFreshVerdict(t *testing.T) {
	c := updatecheck.New("3.8.0", true)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{Schema: 1, Tools: []updatecheck.CheckTool{
			{Name: "run-kit", Formula: "run-kit", Latest: "3.9.0", Notify: "minor"},
			{Name: "tu", Formula: "tu", Installed: "0.9.1", Latest: "0.9.2", Notify: "minor", UpdateAvailable: true, Notable: false},
		}}, nil
	})
	s := newUpdateServer(c)

	res := postUpdatesCheck(t, s, "")

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", res.Code, res.Body.String())
	}
	var body struct {
		Tools []struct {
			Tool            string `json:"tool"`
			Current         string `json:"current"`
			Latest          string `json:"latest"`
			UpdateAvailable bool   `json:"updateAvailable"`
			Notable         bool   `json:"notable"`
		} `json:"tools"`
		Key string `json:"key"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(body.Tools) != 2 {
		t.Fatalf("tools = %+v, want 2 verdicts (notable run-kit + sub-threshold tu)", body.Tools)
	}
	if body.Tools[0].Tool != "run-kit" || !body.Tools[0].Notable || !body.Tools[0].UpdateAvailable {
		t.Errorf("run-kit verdict = %+v, want notable+updateAvailable", body.Tools[0])
	}
	if body.Tools[1].Tool != "tu" || body.Tools[1].Notable || !body.Tools[1].UpdateAvailable {
		t.Errorf("tu verdict = %+v, want sub-threshold updateAvailable", body.Tools[1])
	}
	if body.Key != "run-kit@3.9.0" {
		t.Errorf("key = %q, want run-kit@3.9.0 (notable set only)", body.Key)
	}
	// The pass converged the shared cached verdict (chip source).
	if snap := c.Snapshot(); snap.Key != "run-kit@3.9.0" {
		t.Errorf("cached snapshot key = %q, want run-kit@3.9.0", snap.Key)
	}
}

// TestHandleUpdatesCheckFailure502 verifies the fail-loud manual posture: a
// failed check (shll missing / non-zero / unparseable) maps to 502 with the
// reason in the error body.
func TestHandleUpdatesCheckFailure502(t *testing.T) {
	c := updatecheck.New("3.8.0", true)
	c.SetCheckForTest(func(string) (updatecheck.CheckReport, error) {
		return updatecheck.CheckReport{}, errors.New("shll not found on PATH")
	})
	s := newUpdateServer(c)

	res := postUpdatesCheck(t, s, "")

	if res.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body=%s)", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "shll not found on PATH") {
		t.Errorf("error body = %q, want the check-failure reason", res.Body.String())
	}
}

// TestHandleUpdatesCheckSuppressedAndNil409 verifies the defensive contract: a
// suppressed (dev) or nil checker responds 409 without running any check.
func TestHandleUpdatesCheckSuppressedAndNil409(t *testing.T) {
	dev := updatecheck.New("dev", true)
	for name, s := range map[string]*Server{
		"suppressed": newUpdateServer(dev),
		"nil":        newUpdateServer(nil),
	} {
		t.Run(name, func(t *testing.T) {
			res := postUpdatesCheck(t, s, "")
			if res.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409 (body=%s)", res.Code, res.Body.String())
			}
		})
	}
}

// sourceRecordingChecker returns a checker whose check seam records every
// requested source and answers with a minimal per-source report (source echoed
// in the report, github rows carrying no notify/notable per that contract).
func sourceRecordingChecker(seen *[]string) *updatecheck.Checker {
	c := updatecheck.New("3.8.0", true)
	c.SetCheckForTest(func(source string) (updatecheck.CheckReport, error) {
		*seen = append(*seen, source)
		if source == updatecheck.SourceGithub {
			return updatecheck.CheckReport{Schema: 1, Source: "github", Tools: []updatecheck.CheckTool{
				{Name: "run-kit", Formula: "run-kit", Installed: "3.8.0", Latest: "3.9.1", UpdateAvailable: true},
			}}, nil
		}
		return updatecheck.CheckReport{Schema: 1, Source: "released", Tools: []updatecheck.CheckTool{
			{Name: "run-kit", Formula: "run-kit", Latest: "3.9.0", Notify: "minor"},
		}}, nil
	})
	return c
}

// TestHandleUpdatesCheckBodyVariantsDefaultReleased verifies the tolerant body
// parse: an absent body, `{}`, an empty source, and a malformed body all take
// the released default (existing clients POSTing `{}` unchanged).
func TestHandleUpdatesCheckBodyVariantsDefaultReleased(t *testing.T) {
	for name, body := range map[string]string{
		"absent":       "",
		"empty-obj":    `{}`,
		"empty-source": `{"source":""}`,
		"malformed":    `{not json`,
	} {
		t.Run(name, func(t *testing.T) {
			var seen []string
			s := newUpdateServer(sourceRecordingChecker(&seen))

			res := postUpdatesCheck(t, s, body)

			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 for body %q (body=%s)", res.Code, body, res.Body.String())
			}
			if len(seen) != 1 || seen[0] != updatecheck.SourceReleased {
				t.Errorf("check seam saw sources %v, want [released default] for body %q", seen, body)
			}
			if !strings.Contains(res.Body.String(), `"source":"released"`) {
				t.Errorf("response = %s, want the released source echoed", res.Body.String())
			}
		})
	}
}

// TestHandleUpdatesCheckGithubSource verifies the github override: the
// validated enum value reaches the checker seam, the response echoes the
// report's source, and the side-channel posture holds through the handler (the
// cached snapshot the chip reads stays untouched).
func TestHandleUpdatesCheckGithubSource(t *testing.T) {
	var seen []string
	c := sourceRecordingChecker(&seen)
	s := newUpdateServer(c)

	res := postUpdatesCheck(t, s, `{"source":"github"}`)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", res.Code, res.Body.String())
	}
	if len(seen) != 1 || seen[0] != updatecheck.SourceGithub {
		t.Errorf("check seam saw sources %v, want [github]", seen)
	}
	var body struct {
		Tools []struct {
			Tool            string `json:"tool"`
			UpdateAvailable bool   `json:"updateAvailable"`
			Notable         bool   `json:"notable"`
		} `json:"tools"`
		Key    string `json:"key"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Source != "github" {
		t.Errorf("response source = %q, want github (echo of the report's source)", body.Source)
	}
	if len(body.Tools) != 1 || !body.Tools[0].UpdateAvailable || body.Tools[0].Notable {
		t.Errorf("tools = %+v, want one non-notable updateAvailable row (no notify policy in the github backend)", body.Tools)
	}
	if body.Key != "" {
		t.Errorf("key = %q, want empty (github rows never enter the notable set)", body.Key)
	}
	// Side-channel: the shared cached verdict was never written.
	if snap := c.Snapshot(); snap.Key != "" || len(snap.Tools) != 0 {
		t.Errorf("github check must not write the cache: snapshot = %+v", snap)
	}
}

// TestHandleUpdatesCheckUnknownSource400 verifies the closed enum: a parsed
// unknown non-empty source is a client bug → 400 without invoking the checker
// (a silent released fallback would mask it).
func TestHandleUpdatesCheckUnknownSource400(t *testing.T) {
	var seen []string
	s := newUpdateServer(sourceRecordingChecker(&seen))

	res := postUpdatesCheck(t, s, `{"source":"bogus"}`)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "bogus") {
		t.Errorf("error body = %q, want the rejected source named", res.Body.String())
	}
	if len(seen) != 0 {
		t.Errorf("check seam invoked %v times on an invalid source, want none", seen)
	}
}

// TestHandleUpdateBodyVariantsPreserveNonForce verifies the tolerant body parse:
// an explicit force=false, an empty {} body, and an absent body all take the
// non-force path (byte-preserving today's 409 when no update matches, on the
// shll-absent path).
func TestHandleUpdateBodyVariantsPreserveNonForce(t *testing.T) {
	for name, body := range map[string]string{
		"force-false": `{"force":false}`,
		"empty-obj":   `{}`,
		"absent":      "",
	} {
		t.Run(name, func(t *testing.T) {
			var rec jobRecord
			withSeams(t, "/opt/homebrew/Cellar/run-kit/3.9.0/bin/run-kit", nil, "", errNoShll, recordingJob(&rec))
			s := newUpdateServer(updatecheck.New("3.9.0", true)) // no matching update

			res := postUpdate(t, s, body)

			if res.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409 (non-force path, no update) for body %q", res.Code, body)
			}
			if rec.called {
				t.Errorf("must not spawn on the non-force path when no update is pending (body %q)", body)
			}
		})
	}
}
