package daemon

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"rk/internal/shellq"
)

// jobCall records one seam invocation: the tmux argv (minus the runner's own
// -L prefix, which the seams sit below) for run/output calls, or the probe
// target for the window-state seam.
type jobCall struct {
	op   string // "run" | "output" | "state"
	args []string
}

// jobFixture stubs every RunJob seam for one test and returns the recorded
// calls plus knobs to script the tmux world: daemon running or not, session
// presence, per-target window state, and per-op error hooks. Restores via
// t.Cleanup.
type jobFixture struct {
	calls         *[]jobCall
	daemonRunning bool
	sessionExists bool
	// state answers the jobWindowState seam; nil means "every window absent".
	state func(target string) (id string, dead bool, exists bool)
	// runErr / outputErr fail the corresponding seam when non-nil.
	runErr    error
	outputErr error
	// outputFn, when non-nil, scripts the output seam per call (overrides
	// outputErr/output) — e.g. failing the first new-session but not the
	// new-window that follows a duplicate-session race.
	outputFn func(args []string) ([]byte, error)
	// output is what the output seam returns (the spawned window id).
	output string
	// stateHome is the temp XDG_STATE_HOME the test resolves against.
	stateHome string
}

func withJobSeams(t *testing.T, f *jobFixture) {
	t.Helper()
	f.calls = &[]jobCall{}
	if f.output == "" {
		f.output = "@7\n"
	}

	origRunning, origSession, origState := jobDaemonRunning, jobSessionExists, jobWindowState
	origRun, origOutput := jobRunTmux, jobRunTmuxOutput
	t.Cleanup(func() {
		jobDaemonRunning, jobSessionExists, jobWindowState = origRunning, origSession, origState
		jobRunTmux, jobRunTmuxOutput = origRun, origOutput
	})

	// The state home is temp-rooted for every test so the pipe-pane tee can
	// never write to the real state home (the withCodeServerSeams guarantee).
	f.stateHome = t.TempDir()
	t.Setenv("XDG_STATE_HOME", f.stateHome)
	jobDaemonRunning = func(context.Context) bool { return f.daemonRunning }
	jobSessionExists = func(context.Context, string) bool { return f.sessionExists }
	jobWindowState = func(_ context.Context, target string) (string, bool, bool) {
		*f.calls = append(*f.calls, jobCall{op: "state", args: []string{target}})
		if f.state == nil {
			return "", false, false
		}
		return f.state(target)
	}
	jobRunTmux = func(_ context.Context, args ...string) error {
		*f.calls = append(*f.calls, jobCall{op: "run", args: append([]string(nil), args...)})
		return f.runErr
	}
	jobRunTmuxOutput = func(_ context.Context, args ...string) ([]byte, error) {
		*f.calls = append(*f.calls, jobCall{op: "output", args: append([]string(nil), args...)})
		if f.outputFn != nil {
			return f.outputFn(args)
		}
		if f.outputErr != nil {
			return nil, f.outputErr
		}
		return []byte(f.output), nil
	}
}

// callsOf filters the recorded calls by op.
func callsOf(calls []jobCall, op string) [][]string {
	var out [][]string
	for _, c := range calls {
		if c.op == op {
			out = append(out, c.args)
		}
	}
	return out
}

func TestRunJobDaemonGateRefusesWithoutServer(t *testing.T) {
	f := &jobFixture{daemonRunning: false}
	withJobSeams(t, f)

	_, started, err := RunJob(context.Background(), "update", []string{"shll", "update"})

	if err == nil {
		t.Fatal("RunJob must error when the daemon is not running")
	}
	if !strings.Contains(err.Error(), "not running") {
		t.Errorf("error = %q, want it to name the daemon requirement", err)
	}
	if started {
		t.Error("started = true, want false on the gate refusal")
	}
	if len(*f.calls) != 0 {
		t.Errorf("tmux calls = %v, want none — the gate must run before any tmux command (no server birth)", *f.calls)
	}
}

func TestRunJobFreshSpawnEnsuresSessionAndSpawns(t *testing.T) {
	f := &jobFixture{daemonRunning: true, sessionExists: false}
	withJobSeams(t, f)

	target, started, err := RunJob(context.Background(), "update", []string{"shll", "update", "wt"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if !started {
		t.Error("started = false, want true on a fresh spawn")
	}
	want := JobTarget{Server: serverSocket, Session: "rk-jobs", Window: "update", WindowID: "@7"}
	if target != want {
		t.Errorf("target = %+v, want %+v", target, want)
	}

	runs := callsOf(*f.calls, "run")
	if len(runs) != 2 {
		t.Fatalf("run calls = %v, want [set-option, pipe-pane] — session creation rides the spawn itself", runs)
	}
	if got := strings.Join(runs[0], " "); got != "set-option -w -t =rk-jobs:=update remain-on-exit on" {
		t.Errorf("remain-on-exit argv = %q", got)
	}
	wantLog := filepath.Join(f.stateHome, "hexokit", "logs", "update.log")
	wantPipe := []string{"pipe-pane", "-o", "-t", "=rk-jobs:=update", "cat >> " + shellq.Quote(wantLog)}
	if got := runs[1]; !slices.Equal(got, wantPipe) {
		t.Errorf("pipe-pane argv = %v, want %v — the tee targets <state>/logs/<window>.log", got, wantPipe)
	}
	if info, err := os.Stat(filepath.Dir(wantLog)); err != nil || !info.IsDir() {
		t.Errorf("logs dir not created: stat %s = (%v, %v)", filepath.Dir(wantLog), info, err)
	}

	outputs := callsOf(*f.calls, "output")
	if len(outputs) != 1 {
		t.Fatalf("output calls = %v, want the one session-creating spawn", outputs)
	}
	if got := strings.Join(outputs[0], " "); got != "new-session -d -s rk-jobs -n update -P -F #{window_id} shll update wt" {
		t.Errorf("spawn argv = %q, want the job window created AS the session's first window (no idle default window)", got)
	}

	if states := callsOf(*f.calls, "state"); len(states) != 0 {
		t.Errorf("window-state probes = %v, want none — no session means no in-flight job to dedup against", states)
	}
}

func TestRunJobQuotesLogPathForPipePane(t *testing.T) {
	f := &jobFixture{daemonRunning: true, sessionExists: true}
	withJobSeams(t, f)
	// A state home with a space (e.g. under /Users/Jane Doe) must not break
	// the shell-interpreted pipe-pane redirection — the path is single-quoted.
	spacey := filepath.Join(t.TempDir(), "Jane Doe", "state")
	t.Setenv("XDG_STATE_HOME", spacey)

	if _, _, err := RunJob(context.Background(), "update", []string{"shll", "update"}); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	var pipe []string
	for _, r := range callsOf(*f.calls, "run") {
		if r[0] == "pipe-pane" {
			pipe = r
		}
	}
	if pipe == nil {
		t.Fatal("no pipe-pane call recorded")
	}
	want := "cat >> '" + filepath.Join(spacey, "hexokit", "logs", "update.log") + "'"
	if got := pipe[len(pipe)-1]; got != want {
		t.Errorf("pipe-pane command = %q, want %q", got, want)
	}
}

func TestRunJobSkipsSessionEnsureWhenPresent(t *testing.T) {
	f := &jobFixture{daemonRunning: true, sessionExists: true}
	withJobSeams(t, f)

	if _, _, err := RunJob(context.Background(), "update", []string{"shll", "update"}); err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	for _, r := range callsOf(*f.calls, "run") {
		if r[0] == "new-session" {
			t.Errorf("new-session ran with rk-jobs already present: %v", r)
		}
	}
}

func TestRunJobToleratesDuplicateSessionRace(t *testing.T) {
	// The session-creating spawn loses a concurrent create race; RunJob falls
	// through to the session-exists path — probe (absent) then new-window.
	f := &jobFixture{daemonRunning: true, sessionExists: false}
	f.outputFn = func(args []string) ([]byte, error) {
		if args[0] == "new-session" {
			return nil, fmt.Errorf("exit status 1: duplicate session: rk-jobs")
		}
		return []byte("@7\n"), nil
	}
	withJobSeams(t, f)

	target, started, err := RunJob(context.Background(), "update", []string{"true"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if !started {
		t.Error("started = false, want true — the race loser spawns via new-window into the winner's session")
	}
	if target.WindowID != "@7" {
		t.Errorf("target.WindowID = %q, want the new-window spawn's @7", target.WindowID)
	}
	outputs := callsOf(*f.calls, "output")
	if len(outputs) != 2 || outputs[0][0] != "new-session" || outputs[1][0] != "new-window" {
		t.Errorf("output calls = %v, want [new-session (lost race), new-window (fallthrough)]", outputs)
	}
	if states := callsOf(*f.calls, "state"); len(states) != 1 {
		t.Errorf("window-state probes = %v, want exactly one on the fallthrough path (the winner's job may be in flight)", states)
	}
}

func TestRunJobInFlightWindowReturnsExistingTarget(t *testing.T) {
	f := &jobFixture{
		daemonRunning: true,
		sessionExists: true,
		state:         func(string) (string, bool, bool) { return "@9", false, true },
	}
	withJobSeams(t, f)

	target, started, err := RunJob(context.Background(), "update", []string{"shll", "update"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if started {
		t.Error("started = true, want false for a live in-flight window")
	}
	if target.WindowID != "@9" {
		t.Errorf("target.WindowID = %q, want the existing window id @9", target.WindowID)
	}
	if n := len(callsOf(*f.calls, "output")); n != 0 {
		t.Errorf("new-window spawns = %d, want 0 (no duplicate window)", n)
	}
	for _, r := range callsOf(*f.calls, "run") {
		if r[0] == "kill-window" {
			t.Errorf("kill-window ran against a LIVE window: %v", r)
		}
	}
}

func TestRunJobDeadPaneWindowIsReapedAndRespawned(t *testing.T) {
	f := &jobFixture{
		daemonRunning: true,
		sessionExists: true,
		state:         func(string) (string, bool, bool) { return "@4", true, true },
	}
	withJobSeams(t, f)

	target, started, err := RunJob(context.Background(), "update", []string{"shll", "update"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if !started {
		t.Error("started = false, want true — the stale window is respawned in place")
	}
	if target.WindowID != "@4" {
		t.Errorf("target.WindowID = %q, want the respawned window's own id @4", target.WindowID)
	}
	runs := callsOf(*f.calls, "run")
	if len(runs) == 0 || strings.Join(runs[0], " ") != "respawn-window -k -t =rk-jobs:=update shll update" {
		t.Errorf("first run call = %v, want respawn-window -k in the dead window (kill-window on a session's last window would kill the session)", runs)
	}
	if n := len(callsOf(*f.calls, "output")); n != 0 {
		t.Errorf("new-window/new-session spawns = %d, want 0 — the respawn reuses the dead window", n)
	}
}

func TestRunJobSpawnErrorPropagates(t *testing.T) {
	f := &jobFixture{daemonRunning: true, sessionExists: true, outputErr: fmt.Errorf("exit status 1")}
	withJobSeams(t, f)

	_, started, err := RunJob(context.Background(), "update", []string{"shll", "update"})
	if err == nil {
		t.Fatal("RunJob must propagate a spawn failure")
	}
	if started {
		t.Error("started = true, want false on a spawn failure")
	}
	if !strings.Contains(err.Error(), "spawning") {
		t.Errorf("error = %q, want it to name the spawn step", err)
	}
}

func TestRunJobPostSpawnOptionFailuresAreBestEffort(t *testing.T) {
	// Every run-op (set-option + pipe-pane) fails; the spawn still succeeds.
	f := &jobFixture{daemonRunning: true, sessionExists: true, runErr: fmt.Errorf("tmux 3.1: unknown option")}
	withJobSeams(t, f)

	_, started, err := RunJob(context.Background(), "update", []string{"shll", "update"})
	if err != nil {
		t.Fatalf("RunJob must not fail on post-spawn option errors: %v", err)
	}
	if !started {
		t.Error("started = false, want true")
	}
}

func TestRunJobValidatesWindowName(t *testing.T) {
	for _, name := range []string{"", "-evil", "has space", "semi;colon", "colon:name", "dot.name"} {
		t.Run(fmt.Sprintf("name=%q", name), func(t *testing.T) {
			f := &jobFixture{daemonRunning: true, sessionExists: true}
			withJobSeams(t, f)

			_, _, err := RunJob(context.Background(), name, []string{"true"})
			if err == nil {
				t.Errorf("RunJob(window=%q) must reject the name before it becomes a tmux target", name)
			}
			if len(*f.calls) != 0 {
				t.Errorf("tmux calls = %v, want none — validation precedes every tmux command", *f.calls)
			}
		})
	}
}

func TestRunJobRejectsEmptyArgv(t *testing.T) {
	f := &jobFixture{daemonRunning: true, sessionExists: true}
	withJobSeams(t, f)

	if _, _, err := RunJob(context.Background(), "update", nil); err == nil {
		t.Error("RunJob with an empty argv must error (a window running nothing)")
	}
	if len(*f.calls) != 0 {
		t.Errorf("tmux calls = %v, want none", *f.calls)
	}
}

// --- Integration tests: REAL seams against an isolated scratch socket ---
//
// The released 3.15.10 first-click bug (260812-anac) lived exclusively in
// jobWindowState's DEFAULT implementation — the one code path the seam-stubbed
// tests above can never exercise. These tests run the real probe and both real
// spawn shapes, following daemon_test.go's harness conventions.

// jobsIntegrationSocket spins up an isolated tmux server carrying a stand-in
// rk-daemon session (so the real jobDaemonRunning gate passes) and points the
// package's serverSocket at it. Every tmux-facing seam stays REAL; only the
// state home is temp-rooted so pipe-pane can never touch the real state home.
func jobsIntegrationSocket(t *testing.T) string {
	t.Helper()
	if !hasTmux() {
		t.Skip("tmux not in PATH")
	}
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	socket := testSocketName("jobs")
	_ = exec.Command("tmux", "-L", socket, "kill-server").Run()
	t.Cleanup(func() { _ = exec.Command("tmux", "-L", socket, "kill-server").Run() })
	withServerSocket(t, socket)
	if err := startOn(socket, SessionName); err != nil {
		t.Fatalf("starting stand-in daemon session: %v", err)
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	return socket
}

// jobsWindowNames lists the window names of the rk-jobs session on the socket.
func jobsWindowNames(t *testing.T, socket string) []string {
	t.Helper()
	out, err := exec.Command("tmux", "-L", socket,
		"list-windows", "-t", "="+JobsSessionName+":", "-F", "#{window_name}").Output()
	if err != nil {
		t.Fatalf("listing rk-jobs windows: %v", err)
	}
	return strings.Fields(string(out))
}

func TestJobWindowStateIntegration_IdleWindowIsNotAJob(t *testing.T) {
	socket := jobsIntegrationSocket(t)

	// The exact released state: an rk-jobs session whose ONLY window is the
	// idle default shell that a bare `new-session -d` mints.
	if err := exec.Command("tmux", "-L", socket, "new-session", "-d", "-s", JobsSessionName).Run(); err != nil {
		t.Fatalf("creating idle rk-jobs session: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if id, _, exists := jobWindowState(ctx, jobTargetFor("update")); exists {
		t.Fatalf("probe reported the idle default window (%s) as a live `update` job — the display-message active-window fallback regression", id)
	}
}

func TestRunJobIntegration_SessionCreatedWithJobWindow(t *testing.T) {
	socket := jobsIntegrationSocket(t)

	target, started, err := RunJob(context.Background(), "update", []string{"sleep", "60"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if !started {
		t.Fatal("started = false, want true on a fresh host")
	}
	if names := jobsWindowNames(t, socket); len(names) != 1 || names[0] != "update" {
		t.Errorf("rk-jobs windows = %v, want exactly [update] — no idle default window", names)
	}
	if !strings.HasPrefix(target.WindowID, "@") {
		t.Errorf("target.WindowID = %q, want a real @N window id", target.WindowID)
	}

	// A second call must report the live job truthfully — the released bug's
	// false already-running is only trustworthy if the true one works too.
	again, started, err := RunJob(context.Background(), "update", []string{"sleep", "60"})
	if err != nil {
		t.Fatalf("RunJob (in-flight): %v", err)
	}
	if started {
		t.Error("started = true on an in-flight job, want false")
	}
	if again.WindowID != target.WindowID {
		t.Errorf("in-flight WindowID = %q, want the live window's %q", again.WindowID, target.WindowID)
	}
}

func TestRunJobIntegration_FailedJobRemainsDeadThenRespawns(t *testing.T) {
	jobsIntegrationSocket(t)

	// A job that lives long enough for remain-on-exit to land, then fails.
	// (A single-word argv — tmux joins argv with spaces unquoted, so multi-word
	// sh -c scripts do not survive the join; a script file does.)
	script := filepath.Join(t.TempDir(), "failing-job.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 1\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("writing failing job script: %v", err)
	}

	target, started, err := RunJob(context.Background(), "update", []string{script})
	if err != nil || !started {
		t.Fatalf("RunJob = (started=%v, err=%v), want a fresh spawn", started, err)
	}

	// The pane must survive the non-zero exit (remain-on-exit on) and the
	// probe must report it dead.
	deadline := time.Now().Add(5 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
		id, dead, exists := jobWindowState(ctx, jobTargetFor("update"))
		cancel()
		if exists && dead {
			if id != target.WindowID {
				t.Errorf("dead window id = %q, want %q", id, target.WindowID)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("probe = (id=%q dead=%v exists=%v), want the failed window to remain and read dead", id, dead, exists)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Reap-on-rerun: the next run relaunches IN the dead window (respawn-window
	// — killing the session's only window would kill the session) and the
	// probe reads it live again.
	fresh, started, err := RunJob(context.Background(), "update", []string{"sleep", "60"})
	if err != nil || !started {
		t.Fatalf("RunJob (respawn) = (started=%v, err=%v), want a respawn over the dead window", started, err)
	}
	if fresh.WindowID != target.WindowID {
		t.Errorf("respawn window id = %q, want the dead window reused in place (%q)", fresh.WindowID, target.WindowID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if id, dead, exists := jobWindowState(ctx, jobTargetFor("update")); !exists || dead || id != target.WindowID {
		t.Errorf("post-respawn probe = (id=%q dead=%v exists=%v), want the same window live", id, dead, exists)
	}
}

// TestRunJobIntegration_SucceededJobRemainsDeadThenRespawns is the success
// mirror of the failed-job test above: with remain-on-exit on, a job that
// exits 0 ALSO remains as a dead pane (its output stays on screen until the
// next update) and the next run respawns it in place.
func TestRunJobIntegration_SucceededJobRemainsDeadThenRespawns(t *testing.T) {
	jobsIntegrationSocket(t)

	// A job that lives long enough for remain-on-exit to land, then succeeds.
	// (Single-word argv — tmux joins argv with spaces unquoted, so a script
	// file carries the multi-step body.)
	script := filepath.Join(t.TempDir(), "succeeding-job.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 1\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("writing succeeding job script: %v", err)
	}

	target, started, err := RunJob(context.Background(), "update", []string{script})
	if err != nil || !started {
		t.Fatalf("RunJob = (started=%v, err=%v), want a fresh spawn", started, err)
	}

	// The pane must survive the ZERO exit and the probe must report it dead.
	deadline := time.Now().Add(5 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
		id, dead, exists := jobWindowState(ctx, jobTargetFor("update"))
		cancel()
		if exists && dead {
			if id != target.WindowID {
				t.Errorf("dead window id = %q, want %q", id, target.WindowID)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("probe = (id=%q dead=%v exists=%v), want the succeeded window to remain and read dead", id, dead, exists)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// The next run relaunches IN the dead window and the probe reads it live.
	fresh, started, err := RunJob(context.Background(), "update", []string{"sleep", "60"})
	if err != nil || !started {
		t.Fatalf("RunJob (respawn) = (started=%v, err=%v), want a respawn over the dead window", started, err)
	}
	if fresh.WindowID != target.WindowID {
		t.Errorf("respawn window id = %q, want the dead window reused in place (%q)", fresh.WindowID, target.WindowID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if id, dead, exists := jobWindowState(ctx, jobTargetFor("update")); !exists || dead || id != target.WindowID {
		t.Errorf("post-respawn probe = (id=%q dead=%v exists=%v), want the same window live", id, dead, exists)
	}
}
