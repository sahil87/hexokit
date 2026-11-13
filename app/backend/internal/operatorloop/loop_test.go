package operatorloop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/tmux"
)

// rig points every seam at a temp state home and returns it. Tests override
// individual seams after calling it; the originals are restored on cleanup.
type rig struct {
	t         *testing.T
	statePath string
	now       time.Time
}

const testServer = "dev"

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{t: t, statePath: filepath.Join(t.TempDir(), "operator", "test.yaml"), now: time.Date(2026, 11, 12, 10, 15, 0, 0, time.UTC)}
	saved := struct {
		statePath func(context.Context, string) (string, error)
		now       func() time.Time
		windows   func(context.Context, string) ([]tmux.RunWindow, error)
		check     func(context.Context, string, operator.CheckOptions) (operator.CheckResult, error)
		launch    func(context.Context, string, string, string, string, string) (tmux.WindowBirth, error)
		root      func(context.Context, string) (string, error)
		resolve   func(context.Context, string, string) string
		self      func() (string, error)
		home      func() (string, error)
		runID     func() (string, error)
	}{statePathFn, nowTime, listRunWindowsFn, checkFn, launchWindowFn, operatorRootFn, resolveLauncherFn, selfPathFn, homeDirFn, newRunIDFn}
	t.Cleanup(func() {
		statePathFn, nowTime, listRunWindowsFn, checkFn = saved.statePath, saved.now, saved.windows, saved.check
		launchWindowFn, operatorRootFn, resolveLauncherFn = saved.launch, saved.root, saved.resolve
		selfPathFn, homeDirFn, newRunIDFn = saved.self, saved.home, saved.runID
	})
	statePathFn = func(context.Context, string) (string, error) { return r.statePath, nil }
	nowTime = func() time.Time { return r.now }
	listRunWindowsFn = func(context.Context, string) ([]tmux.RunWindow, error) { return nil, nil }
	selfPathFn = func() (string, error) { return "/opt/rk/bin/rk", nil }
	homeDirFn = func() (string, error) { return "/home/tester", nil }
	operatorRootFn = func(context.Context, string) (string, error) { return "", nil }
	resolveLauncherFn = func(context.Context, string, string) string { return riffDefaultForTest }
	return r
}

const riffDefaultForTest = "claude -p --dangerously-skip-permissions"

// addNoteItem seeds the ledger with a note-kind item.
func (r *rig) addNoteItem(id string) {
	r.t.Helper()
	if _, err := operator.Add(context.Background(), r.statePath, operator.AddSpec{ID: id, Kind: operator.KindNote, Text: "hello", TextSet: true}); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) runsDir() string {
	r.t.Helper()
	dir, err := Dir(context.Background(), testServer)
	if err != nil {
		r.t.Fatal(err)
	}
	return dir
}

// writeRun stores a record (and optional brief/log) for tests that start from
// files on disk.
func (r *rig) writeRun(rec Record) string {
	r.t.Helper()
	dir := r.runsDir()
	if err := EnsureDir(dir); err != nil {
		r.t.Fatal(err)
	}
	path, err := RecordPath(dir, rec.ID)
	if err != nil {
		r.t.Fatal(err)
	}
	if err := WriteRecord(path, rec); err != nil {
		r.t.Fatal(err)
	}
	return path
}

func fire() cron.Fire {
	return cron.Fire{Server: testServer, Entry: cron.Entry{ID: "lp01", Run: cron.RunOperatorLoop}, Reason: cron.FireSchedule}
}

func exists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Stat(path)
	return err == nil
}

var errBoom = errors.New("boom")

func secs(n int) time.Duration { return time.Duration(n) * time.Second }

func readFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	return string(b), err
}
