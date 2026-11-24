package operatorloop

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/fsatomic"
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
// tick leaves the loop quiet while the window lives, then transcribes the finished run
// into exactly one `ran · stub acted · …` line, with the run's note on the item
// and no second line on the tick after (the loop's ladder is re-anchored on the
// run's line, so it is not due again).
func TestRestartSurvival(t *testing.T) {
	server := isolatedTmux(t)
	ctx := context.Background()

	statePath, err := statePathFn(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	doneWhen := "n == 99"
	if err := operator.Add(ctx, statePath, operator.AddSpec{
		ID: "pr-1", Kind: operator.KindShell, Argv: []string{"sh", "-c", `printf '{"n":1}'`},
		Fields: []string{"n"}, DoneWhen: &doneWhen,
	}); err != nil {
		t.Fatal(err)
	}
	if err := operator.AddNote(statePath, "pr-1", operator.ByUser, "judge this change"); err != nil {
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
	resolveLauncherFn = func(context.Context, string, string, string) string {
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
	waitFor(t, "the judgment brief", 10*time.Second, func() bool {
		_, err := os.Stat(briefPath)
		return err == nil
	})
	checkedAt := loadLastCheck(t, statePath)

	// The run window is the only window in _rk-operator (no placeholder shell).
	opWins, err := tmux.ListWindows(ctx, tmux.OperatorSessionName, server)
	if err != nil || len(opWins) != 1 || opWins[0].Role != tmux.RoleOperatorRun {
		t.Fatalf("_rk-operator windows = %+v, err %v", opWins, err)
	}

	// Daemon #2 (the first one is gone): the window is still alive, so the
	// loop does not fire at all — no extra row, and Check is not called again.
	tick()
	if lines := logLines(); len(lines) != 0 {
		t.Fatalf("log after the second daemon's tick = %+v, want nothing while the run is alive", lines)
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
	lines := logLines()
	if len(lines) != 1 {
		t.Fatalf("log = %+v, want exactly one ran line", lines)
	}
	if ran := lines[0]; ran.Run != runID || !regexp.MustCompile(`^ran · stub acted · \d+s$`).MatchString(ran.Outcome) {
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
	if len(notes) != 2 || notes[1].By != "run" || notes[1].Text != "stub acted" {
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

func TestIsolatedSocketMechanicalOnlyRun(t *testing.T) {
	installIsolatedGH(t)
	server := isolatedTmux(t)
	ctx := context.Background()
	statePath, err := statePathFn(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	a1Pane, a1Repo := newIsolatedFabPane(t, server, "a1", "ship", "done")
	a2Pane, a2Repo := newIsolatedFabPane(t, server, "a2", "review", "done")
	seedIsolatedMechanicalEngine(t, statePath, a1Pane, a1Repo, a2Pane, a2Repo)
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
	launcherMarker := filepath.Join(t.TempDir(), "launcher-called")
	resolveLauncherFn = func(context.Context, string, string, string) string {
		return "touch " + shellq.QuoteArgv([]string{launcherMarker}) + "; echo 'outcome: model called'"
	}
	tick := func() {
		t.Helper()
		if _, err := cron.Tick(ctx, cron.Deps{
			Dir: cronDir, ListServers: func(context.Context) ([]string, error) { return []string{server}, nil },
			LoopRunner: Run, LoopTranscribe: Transcribe, LoopLogged: MarkLogged, LoopSeed: StateFileExists,
		}); err != nil {
			t.Fatal(err)
		}
	}
	tick()
	wins, err := tmux.ListOperatorRunWindows(ctx, server)
	if err != nil || len(wins) != 1 {
		t.Fatalf("run windows = %+v, err=%v", wins, err)
	}
	runID := wins[0].RunID
	dir, _ := Dir(ctx, server)
	recPath, _ := RecordPath(dir, runID)
	waitFor(t, "mechanical run to end", 30*time.Second, func() bool {
		rec, err := ReadRecord(recPath)
		return err == nil && rec.Ended()
	})
	rec, err := ReadRecord(recPath)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Outcome != "mechanical · 2 actions" || rec.Pass == nil || rec.Pass.Actions != 2 {
		ledger, _ := operator.Load(statePath)
		t.Fatalf("record = %+v, pass = %+v, ledger = %+v", rec, rec.Pass, ledger.Tracked)
	}
	foundStageAdvance := false
	for _, change := range rec.Changes {
		for _, reason := range change.Reasons {
			if strings.HasPrefix(reason, "stage_advance") {
				foundStageAdvance = true
			}
		}
	}
	if !foundStageAdvance {
		t.Fatalf("changes = %+v", rec.Changes)
	}
	if _, err := os.Stat(launcherMarker); !os.IsNotExist(err) {
		t.Fatalf("mechanical run called its launcher: %v", err)
	}
	tick()
	logPath, _ := cron.LogPath(cronDir, server)
	lines := cron.ReadLog(logPath)
	if len(lines) != 1 || !regexp.MustCompile(`^ran · mechanical · 2 actions · \d+s$`).MatchString(lines[0].Outcome) {
		t.Fatalf("mechanical log = %+v", lines)
	}
}

func newIsolatedFabPane(t *testing.T, server, change, stage, display string) (string, string) {
	t.Helper()
	repo := t.TempDir()
	changeDir := filepath.Join(repo, "fab", "changes", change)
	if err := os.MkdirAll(changeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	status := "progress:\n  " + stage + ": " + display + "\n"
	if err := os.WriteFile(filepath.Join(changeDir, ".status.yaml"), []byte(status), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("fab", "changes", change, ".status.yaml"), filepath.Join(repo, ".fab-status.yaml")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-d", "-P", "-F", "#{pane_id}", "-c", repo, "sleep 60").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out)), repo
}

func seedIsolatedMechanicalEngine(t *testing.T, statePath, a1Pane, a1Repo, a2Pane, a2Repo string) {
	t.Helper()
	enginePath := strings.TrimSuffix(statePath, filepath.Ext(statePath)) + ".autopilot.yaml"
	if err := os.MkdirAll(filepath.Dir(enginePath), 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	contents := fmt.Sprintf(`version: 1
queue:
  - id: a1
    queue: q1
    repo: %q
    change: a1
    branch: a1-branch
    merge_mode: merge-auto
    depends_on: []
    pane: %q
    session: work
    projected: true
    done_at: null
    escalated: {}
    added_at: %q
    updated_at: %q
  - id: a2
    queue: q1
    repo: %q
    change: a2
    merge_mode: cherry-pick-ladder
    depends_on: [a1]
    paused: true
    pane: %q
    session: work
    projected: true
    done_at: null
    escalated: {}
    added_at: %q
    updated_at: %q
prs: []
`, a1Repo, a1Pane, now, now, a2Repo, a2Pane, now, now)
	if err := fsatomic.WriteFile(enginePath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id, pane, repo string
		paused         bool
	}{{"a1", a1Pane, a1Repo, false}, {"a2", a2Pane, a2Repo, true}} {
		if err := operator.Add(context.Background(), statePath, operator.AddSpec{
			ID: item.id, Kind: operator.KindPane,
			Scope: map[string]interface{}{"pane": item.pane, "session": "work", "repo": item.repo,
				"change": item.id, "stage": "apply", "stop_stage": nil, "spawned_by": "run"},
		}); err != nil {
			t.Fatal(err)
		}
		if item.paused {
			if err := operator.Pause(statePath, item.id); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func installIsolatedGH(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	script := `#!/bin/sh
case "$*" in
  *"pr view a1-branch"*)
    printf '%s\n' '{"number":41,"url":"https://example.test/pull/41","state":"OPEN","isDraft":false,"mergedAt":null,"mergeable":"MERGEABLE","headRefOid":"abc","autoMergeRequest":null}'
    ;;
  *"repo view"*"nameWithOwner"*)
    printf '%s\n' 'o/a1'
    ;;
  *)
    printf 'unexpected gh call: %s\n' "$*" >&2
    exit 1
    ;;
esac
`
	path := filepath.Join(bin, "gh")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}
