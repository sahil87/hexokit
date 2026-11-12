package operatorloop

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/shellq"
	"rk/internal/tmux"
)

// testSocketName follows the repo's unified test-socket naming
// (rk-test-<role>-<pid>-<ns>, a hyphen-free <ns>).
func testSocketName(role string) string {
	return fmt.Sprintf("rk-test-%s-%d-%d", role, os.Getpid(), time.Now().UnixNano())
}

// isolatedTmux starts a private tmux server on a socket directory under a temp
// TMUX_TMPDIR (so it can never see, or be seen by, the user's servers) and an
// XDG_STATE_HOME of its own, then returns the server name. Everything — the
// socket, the state home, the server — is torn down with the test.
func isolatedTmux(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	// A short path: unix socket paths are length-limited.
	root, err := os.MkdirTemp("", "rkol")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_TMPDIR", root)
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_PANE", "")

	server := testSocketName("oploop")
	start := exec.Command("tmux", "-L", server, "-f", "/dev/null", "new-session", "-d", "-s", "work", "-c", root)
	if out, err := start.CombinedOutput(); err != nil {
		os.RemoveAll(root)
		t.Fatalf("starting isolated tmux: %v: %s", err, out)
	}
	t.Cleanup(func() {
		_ = exec.Command("tmux", "-L", server, "kill-server").Run()
		os.RemoveAll(root)
	})
	return server
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestRestartSurvival is the loop's restart acceptance, on an isolated tmux
// server and state home (never the live daemon or the user's tmux servers): a
// run is launched through the real runner and wrapper, the "daemon" is dropped
// (a fresh Deps value — nothing the loop needs lives in memory), and a fresh
// tick still sees the live window as busy, then transcribes the finished run
// into exactly one `ran · stub acted · …` line, with the run's note on the item
// and no second line on the tick after.
func TestRestartSurvival(t *testing.T) {
	server := isolatedTmux(t)
	ctx := context.Background()

	statePath, err := statePathFn(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	doneWhen := "n == 99"
	if _, err := operator.Add(ctx, statePath, operator.AddSpec{
		ID: "pr-1", Kind: operator.KindShell, Argv: []string{"sh", "-c", `printf '{"n":1}'`},
		Fields: []string{"n"}, DoneWhen: &doneWhen,
	}); err != nil {
		t.Fatal(err)
	}

	cronDir := t.TempDir()
	if _, err := cron.Add(cronDir, server, cron.Entry{
		Name: cron.LoopSeedName, Run: cron.RunOperatorLoop, Pinned: true,
		Schedule:  cron.Schedule{Kind: cron.ScheduleBackoff, Min: cron.Duration{Duration: 3 * time.Minute}, Max: cron.Duration{Duration: 24 * time.Minute}},
		CreatedBy: cron.CreatedBy{At: time.Now().Add(-time.Hour).Unix()},
	}); err != nil {
		t.Fatal(err)
	}

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	prevSelf, prevResolve := selfPathFn, resolveLauncherFn
	t.Cleanup(func() { selfPathFn, resolveLauncherFn = prevSelf, prevResolve })
	selfPathFn = func() (string, error) { return self, nil }
	resolveLauncherFn = func(context.Context, string, string) string {
		return "cat >/dev/null; sleep 2; " + shellq.QuoteArgv([]string{self, "note", statePath, "pr-1", "stub acted"}) +
			"; echo 'outcome: stub acted'"
	}

	freshDaemon := func() cron.Deps {
		return cron.Deps{
			Dir:            cronDir,
			ListServers:    func(context.Context) ([]string, error) { return []string{server}, nil },
			LoopRunner:     Run,
			LoopTranscribe: Transcribe,
			LoopLogged:     MarkLogged,
			LoopSeed:       StateFileExists,
		}
	}
	tick := func() {
		t.Helper()
		if _, err := cron.Tick(ctx, freshDaemon()); err != nil {
			t.Fatal(err)
		}
	}
	logLines := func() []cron.LogLine {
		p, _ := cron.LogPath(cronDir, server)
		return cron.ReadLog(p)
	}

	// Daemon #1: the loop fires, the check finds the probe's first reading,
	// and a run window opens. A launch writes no log line.
	tick()
	if lines := logLines(); len(lines) != 0 {
		t.Fatalf("launch must not log a line: %+v", lines)
	}
	wins, err := tmux.ListOperatorRunWindows(ctx, server)
	if err != nil || len(wins) != 1 {
		t.Fatalf("run windows = %+v, err %v", wins, err)
	}
	runID := wins[0].RunID
	if !ValidRunID(runID) {
		t.Fatalf("window stamped with %q", runID)
	}
	dir, _ := Dir(ctx, server)
	recPath, _ := RecordPath(dir, runID)
	briefPath, _ := BriefPath(dir, runID)
	if rec, err := ReadRecord(recPath); err != nil || rec.Entry == "" || len(rec.Changed) != 1 || rec.Changed[0] != "pr-1" {
		t.Fatalf("record = %+v, err %v", rec, err)
	}
	if _, err := os.Stat(briefPath); err != nil {
		t.Fatal(err)
	}
	checkedAt := loadLastCheck(t, statePath)

	// Daemon #2 (the first one is gone): the window is still alive, so the
	// fire is skipped-busy and Check is not called again.
	tick()
	lines := logLines()
	if len(lines) != 1 || lines[0].Outcome != "skipped-busy: run "+runID {
		t.Fatalf("log after the second daemon's tick = %+v", lines)
	}
	if got := loadLastCheck(t, statePath); got != checkedAt {
		t.Errorf("Check ran while the run window was alive: last_check_at %q → %q", checkedAt, got)
	}

	// The run finishes without any daemon involved.
	waitFor(t, "the run window to close", 30*time.Second, func() bool {
		w, err := tmux.ListOperatorRunWindows(ctx, server)
		return err == nil && len(w) == 0
	})
	waitFor(t, "the run record to end", 10*time.Second, func() bool {
		rec, err := ReadRecord(recPath)
		return err == nil && rec.Ended()
	})

	// Daemon #3: transcribes exactly one line; the next tick adds nothing.
	tick()
	tick()
	lines = logLines()
	if len(lines) != 2 {
		t.Fatalf("log = %+v, want the skipped-busy line plus exactly one ran line", lines)
	}
	if ran := lines[1]; ran.Run != runID || !regexp.MustCompile(`^ran · stub acted · \d+s$`).MatchString(ran.Outcome) {
		t.Fatalf("ran line = %+v", ran)
	}
	if rec, _ := ReadRecord(recPath); !rec.Logged {
		t.Error("the record must be marked logged")
	}

	// The run's own note landed on the item.
	st, err := operator.Load(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var notes []operator.Note
	for _, it := range st.Tracked {
		if it.ID == "pr-1" {
			notes = it.Notes
		}
	}
	if len(notes) != 1 || notes[0].By != "run" || notes[0].Text != "stub acted" {
		t.Fatalf("notes = %+v", notes)
	}
}

func loadLastCheck(t *testing.T, statePath string) string {
	t.Helper()
	st, err := operator.Load(statePath)
	if err != nil {
		t.Fatal(err)
	}
	return st.LastCheckAt
}
