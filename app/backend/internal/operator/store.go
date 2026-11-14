package operator

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"rk/internal/apphome"
	"rk/internal/cron"
	"rk/internal/fsatomic"
	"rk/internal/tmux"

	"gopkg.in/yaml.v3"
)

const (
	// dirMode / fileMode are the state dir and file permission classes
	// (notes can carry agent output).
	dirMode  = 0o700
	fileMode = 0o600

	// lockPoll is the retry interval while waiting for the sidecar lock.
	lockPoll = 25 * time.Millisecond

	// DefaultServer is the label of tmux's default server; it is the only one
	// whose state file may be resolved without a known socket path.
	DefaultServer = "default"

	stateSubdir = "operator"
	lockSuffix  = ".lock"

	keyTracked   = "tracked"
	keyBranchMap = "branch_map"
	keyLastCheck = "last_check_at"
)

// lockTimeout bounds how long a writer waits for the sidecar lock before
// failing with ErrBusy; a var so tests can shrink it.
var lockTimeout = 5 * time.Second

// ErrBusy is returned when the state file's lock stays held past lockTimeout.
var ErrBusy = errors.New("operator state file busy")

// errNoWrite is returned by a Mutate callback that decided nothing changed:
// the lock is released and no file is written.
var errNoWrite = errors.New("operator: no change to write")

// clock is the single timestamp source for every state mutation; tests
// replace it.
var clock = time.Now

// socketPathFn is the tmux socket-path query seam.
var socketPathFn = tmux.SocketPath

func nowRFC3339() string {
	return clock().UTC().Format(time.RFC3339)
}

// ServerLabel is the server's display label: the empty server is `default`.
func ServerLabel(server string) string {
	if server == "" {
		return DefaultServer
	}
	return server
}

// StatePath resolves <state home>/operator/<slug>.yaml for a tmux socket path.
// The slug uses the same injective rule as the fab operator file's name, so
// one server maps to one file and adopt is a 1:1 mapping.
func StatePath(socketPath string) (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving operator state path: %w", err)
	}
	return filepath.Join(root, stateSubdir, cron.FabOperatorSlug(socketPath)+".yaml"), nil
}

// ServerSocketPath returns the named tmux server's socket path, or "" when it
// cannot be queried.
func ServerSocketPath(ctx context.Context, server string) string {
	p, err := socketPathFn(ctx, server)
	if err != nil {
		return ""
	}
	return p
}

// StatePathFor resolves the state file of a server from its socket path. The
// `default` label keeps the `default` slug fallback for an unknown socket; any
// other server with an unknown socket is an error, since the fallback would
// read and write another server's ledger.
func StatePathFor(server, socketPath string) (string, error) {
	if socketPath == "" && server != "" && server != DefaultServer {
		return "", fmt.Errorf("tmux socket path for server %q unavailable (is the server running?)", server)
	}
	return StatePath(socketPath)
}

// StatePathForServer resolves the state file of the named tmux server.
func StatePathForServer(ctx context.Context, server string) (string, error) {
	return StatePathFor(server, ServerSocketPath(ctx, server))
}

// Load reads the state file tolerantly and without locking: a missing file is
// an empty state, an unparsable file is a hard error naming the path.
// fsatomic writes guarantee a reader sees the old or the complete new file.
func Load(path string) (*State, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return newState(), nil
		}
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	data := map[string]interface{}{}
	if len(raw) > 0 {
		if err := yaml.Unmarshal(raw, &data); err != nil {
			return nil, fmt.Errorf("cannot parse %s: %w", path, err)
		}
	}
	return stateFromMap(path, data)
}

func newState() *State {
	return &State{
		Tracked:   []TrackedItem{},
		BranchMap: map[string]BranchMapEntry{},
		extra:     map[string]interface{}{},
	}
}

func stateFromMap(path string, data map[string]interface{}) (*State, error) {
	st := newState()
	for k, v := range data {
		if k != keyTracked && k != keyBranchMap && k != keyLastCheck {
			st.extra[k] = v
		}
	}
	if err := decodeSection(data, keyTracked, &st.Tracked); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := decodeSection(data, keyBranchMap, &st.BranchMap); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := decodeSection(data, keyLastCheck, &st.LastCheckAt); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if st.Tracked == nil {
		st.Tracked = []TrackedItem{}
	}
	if st.BranchMap == nil {
		st.BranchMap = map[string]BranchMapEntry{}
	}
	for i := range st.Tracked {
		normalizeItem(&st.Tracked[i])
	}
	return st, nil
}

// decodeSection re-decodes an owned top-level section into its typed form,
// dropping any in-section drift. A missing/null section leaves out unchanged.
func decodeSection(data map[string]interface{}, key string, out interface{}) error {
	raw, ok := data[key]
	if !ok || raw == nil {
		return nil
	}
	b, err := yaml.Marshal(raw)
	if err != nil {
		return fmt.Errorf("cannot decode %s section: %w", key, err)
	}
	if err := yaml.Unmarshal(b, out); err != nil {
		return fmt.Errorf("cannot decode %s section: %w", key, err)
	}
	return nil
}

// normalizeItem replaces null collections so JSON and YAML render [] / {}.
func normalizeItem(it *TrackedItem) {
	if it.DependsOn == nil {
		it.DependsOn = []string{}
	}
	if it.Scope == nil {
		it.Scope = map[string]interface{}{}
	}
	if it.Last == nil {
		it.Last = map[string]interface{}{}
	}
}

// marshal renders the state: unknown top-level keys verbatim, the owned
// sections and last_check_at from the typed fields.
func (s *State) marshal() ([]byte, error) {
	out := make(map[string]interface{}, len(s.extra)+2)
	for k, v := range s.extra {
		out[k] = v
	}
	out[keyTracked] = s.Tracked
	out[keyBranchMap] = s.BranchMap
	if s.LastCheckAt != "" {
		out[keyLastCheck] = s.LastCheckAt
	}
	return yaml.Marshal(out)
}

// Mutate is the read-modify-write skeleton every writer runs: take the
// sidecar lock, re-read the file (external writes win), apply fn to the typed
// state, write atomically, release. An fn error writes nothing; success is
// returned only after the rename. The lock is held on the sidecar, never the
// data file, because fsatomic replaces the data file by rename.
func Mutate(path string, fn func(*State) error) error {
	if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return fmt.Errorf("cannot create %s: %w", filepath.Dir(path), err)
	}
	release, err := acquireLock(path + lockSuffix)
	if err != nil {
		return err
	}
	defer release()

	st, err := Load(path)
	if err != nil {
		return err
	}
	if err := fn(st); err != nil {
		if errors.Is(err, errNoWrite) {
			return nil
		}
		return err
	}
	out, err := st.marshal()
	if err != nil {
		return fmt.Errorf("cannot marshal %s: %w", path, err)
	}
	if err := fsatomic.WriteFile(path, out, fileMode); err != nil {
		return fmt.Errorf("cannot write %s: %w", path, err)
	}
	return nil
}

// acquireLock takes the exclusive flock on the sidecar, polling non-blocking
// until lockTimeout. The returned release func unlocks and closes.
func acquireLock(lockPath string) (release func(), err error) {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, fileMode)
	if err != nil {
		return nil, fmt.Errorf("cannot open lock %s: %w", lockPath, err)
	}
	deadline := time.Now().Add(lockTimeout)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
				_ = f.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			_ = f.Close()
			return nil, fmt.Errorf("cannot lock %s: %w", lockPath, err)
		}
		if !time.Now().Before(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("%w: %s held past %s", ErrBusy, lockPath, lockTimeout)
		}
		time.Sleep(lockPoll)
	}
}
