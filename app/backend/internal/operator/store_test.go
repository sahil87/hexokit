package operator

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestStatePath(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/x")
	got, err := StatePath("/tmp/tmux-1000/runKit")
	if err != nil {
		t.Fatal(err)
	}
	if want := "/x/hexokit/operator/tmp-tmux--1000-runKit.yaml"; got != want {
		t.Errorf("StatePath = %q, want %q", got, want)
	}
	// An unqueryable socket path slugs to "default".
	got, err = StatePath("")
	if err != nil {
		t.Fatal(err)
	}
	if want := "/x/hexokit/operator/default.yaml"; got != want {
		t.Errorf("StatePath(\"\") = %q, want %q", got, want)
	}
}

func TestStatePathForServerFallsBackToDefaultWhenSocketPathFails(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/x")
	prev := socketPathFn
	socketPathFn = func(context.Context, string) (string, error) { return "", errors.New("no server") }
	t.Cleanup(func() { socketPathFn = prev })

	got, err := StatePathForServer(context.Background(), "ghost")
	if err != nil {
		t.Fatal(err)
	}
	if want := "/x/hexokit/operator/default.yaml"; got != want {
		t.Errorf("path = %q, want %q", got, want)
	}

	socketPathFn = func(_ context.Context, server string) (string, error) {
		if server != "work" {
			t.Errorf("server = %q, want work", server)
		}
		return "/tmp/tmux-1000/work", nil
	}
	got, _ = StatePathForServer(context.Background(), "work")
	if want := "/x/hexokit/operator/tmp-tmux--1000-work.yaml"; got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
}

func TestLoad_MissingFileIsEmptyAndWritesNothing(t *testing.T) {
	path := seededState(t, "")
	st, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Tracked) != 0 || len(st.BranchMap) != 0 {
		t.Errorf("state = %+v, want empty", st)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Error("Load created the file")
	}
	if _, statErr := os.Stat(path + lockSuffix); !os.IsNotExist(statErr) {
		t.Error("Load took a lock")
	}
}

func TestLoad_UnparsableFileErrorsNamingThePath(t *testing.T) {
	path := seededState(t, "tracked: [unclosed\n")
	_, err := Load(path)
	wantErr(t, err, path)
	wantErr(t, err, "cannot parse")
	// A mutation refuses too, and leaves the bytes alone.
	before, _ := os.ReadFile(path)
	wantErr(t, Pause(path, "x"), path)
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Error("an unparsable file was rewritten")
	}
}

func TestLoad_EmptyFileIsEmptyState(t *testing.T) {
	path := seededState(t, "\n")
	st, err := Load(path)
	if err != nil || len(st.Tracked) != 0 {
		t.Fatalf("Load = %+v, %v", st, err)
	}
}

func TestMutate_UnknownTopLevelKeysSurviveAndInSectionDriftIsDropped(t *testing.T) {
	seed := `tick_count: 9
operator_hint: keep me
tracked:
  - id: a
    kind: task
    probe: {mode: none}
    invented_field: gone
    depends_on: []
    scope: {}
    last: {}
    added_at: "2026-09-09T00:00:00Z"
    updated_at: "2026-09-09T00:00:00Z"
branch_map:
  a: {branch: b, repo: /r, invented: gone}
`
	path := seededState(t, seed)
	if err := Pause(path, "a"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var data map[string]interface{}
	if err := yaml.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if data["tick_count"] != 9 || data["operator_hint"] != "keep me" {
		t.Errorf("unknown top-level keys lost: %v", data)
	}
	if strings.Contains(string(raw), "invented") {
		t.Errorf("in-section drift survived the rewrite:\n%s", raw)
	}
	if !item(t, path, "a").Paused {
		t.Error("the mutation itself was lost")
	}
}

func TestMutate_ModesAndSidecarLock(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "a", Kind: KindTask})

	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v, want 0700", dirInfo.Mode().Perm())
	}
	for _, p := range []string{path, path + lockSuffix} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %v, want 0600", p, info.Mode().Perm())
		}
	}
}

func TestMutate_CreatesDirectoryWith0700WhenAbsent(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "hexokit", "operator", "s.yaml")
	if err := Mutate(path, func(*State) error { return nil }); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v, want 0700", info.Mode().Perm())
	}
}

func TestMutate_FnErrorWritesNothing(t *testing.T) {
	path := seededState(t, seedShell)
	before, _ := os.ReadFile(path)
	boom := errors.New("boom")
	err := Mutate(path, func(st *State) error {
		st.Tracked = nil
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Error("an fn error still wrote")
	}
	// The lock was released: the next mutation goes through.
	if err := Pause(path, "pr-1"); err != nil {
		t.Errorf("lock leaked after an fn error: %v", err)
	}
}

func TestMutate_RereadsInsideTheLock(t *testing.T) {
	path := seededState(t, seedShell)
	// An external writer lands a change between a caller's earlier Load and
	// its Mutate: the mutation must start from the file as it is now.
	stale := mustLoad(t, path)
	if err := Pause(path, "pr-1"); err != nil {
		t.Fatal(err)
	}
	if err := Mutate(path, func(st *State) error {
		if !st.Tracked[indexOf(st.Tracked, "pr-1")].Paused {
			t.Error("Mutate saw a stale state")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if stale.Tracked[0].Paused {
		t.Fatal("test setup: the stale copy changed")
	}
}

func TestMutate_LockTimeoutErrorsAndWritesNothing(t *testing.T) {
	path := seededState(t, seedShell)
	prev := lockTimeout
	lockTimeout = 150 * time.Millisecond
	t.Cleanup(func() { lockTimeout = prev })

	// Hold the sidecar lock on a separate open file description.
	lf, err := os.OpenFile(path+lockSuffix, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lf.Close()
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}

	before, _ := os.ReadFile(path)
	start := time.Now()
	err = Pause(path, "pr-1")
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want ErrBusy", err)
	}
	wantErr(t, err, "state file busy")
	if elapsed := time.Since(start); elapsed < lockTimeout {
		t.Errorf("returned after %v, before the %v timeout", elapsed, lockTimeout)
	}
	if after, _ := os.ReadFile(path); string(before) != string(after) {
		t.Error("a busy lock still wrote")
	}

	// Releasing the lock lets the next writer through.
	if err := syscall.Flock(int(lf.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := Pause(path, "pr-1"); err != nil {
		t.Errorf("after release: %v", err)
	}
}

func TestMutate_DoesNotLockTheDataFile(t *testing.T) {
	// A reader (or a stray flock holder) on the data file never blocks a
	// writer: the lock lives on the sidecar because the data file is replaced
	// by rename.
	path := seededState(t, seedShell)
	df, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer df.Close()
	if err := syscall.Flock(int(df.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	if err := Pause(path, "pr-1"); err != nil {
		t.Fatalf("a lock on the data file blocked the writer: %v", err)
	}
}

func TestMutate_ConcurrentWritersLoseNothing(t *testing.T) {
	path := seededState(t, "")
	stubSeams(t)
	mustAdd(t, path, AddSpec{ID: "n1", Kind: KindNote, Text: "first", TextSet: true})

	const writers = 8
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- AddNote(path, "n1", ByRun, strings.Repeat("x", i+1))
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("AddNote: %v", err)
		}
	}
	if got := len(item(t, path, "n1").Notes); got != writers+1 {
		t.Errorf("notes = %d, want %d (a concurrent write was lost)", got, writers+1)
	}
}
