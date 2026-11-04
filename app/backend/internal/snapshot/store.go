package snapshot

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"rk/internal/apphome"
	"rk/internal/fsatomic"
)

const (
	// historyRetention caps the rolling per-server history
	// ({server}/{unix-ts}.json); oldest entries beyond it are pruned on write.
	historyRetention = 10
	// tombstoneRetention caps the per-server died tombstones
	// ({server}.died-{unix-ts}.json). Same posture as history: bounded, never
	// unbounded growth, newest kept.
	tombstoneRetention = 10

	dirMode  = 0o755
	fileMode = 0o644

	// tombstoneInfix separates the server name from the death timestamp in a
	// tombstone filename ({server}.died-{ts}.json). Server names are validated
	// to [A-Za-z0-9_-] (no dots), so the infix can never occur inside a name —
	// the filename grammar is unambiguous.
	tombstoneInfix = ".died-"
	jsonExt        = ".json"
)

// DefaultDir resolves the snapshot storage root: <state home>/snapshots, where
// the state home is apphome.StateDir ($XDG_STATE_HOME when set, else
// ~/.local/state, with the hexokit/run-kit dual-read rule). State dir — not
// cache — because these are recovery artifacts and caches are droppable by
// contract. Pure resolver, no side effects: the one-time move of the legacy
// <state-root>/rk/snapshots dir is MigrateLegacyDir, fired at store first-use.
func DefaultDir() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving snapshot dir: %w", err)
	}
	return filepath.Join(root, "snapshots"), nil
}

// MigrateLegacyDir performs the one-time, best-effort move of the legacy
// snapshot dir (<state-root>/rk/snapshots, same resolution root as dir with
// "rk" in place of the resolved home name) into the resolved dir, leaving a
// MOVED-to-run-kit breadcrumb file in the legacy <state-root>/rk/ dir that
// names the new path. Recovery backups are worth preserving, so the move
// fires at store first-use rather than dropping them — but it fires ONLY into
// an absent target: an existing new dir (or anything else at that path) is
// never merged into or clobbered. Every failure degrades silently to
// cold-start behavior (an empty store) and is at most a debug line.
func MigrateLegacyDir(dir string) {
	stateRoot := filepath.Dir(filepath.Dir(dir))
	legacy := filepath.Join(stateRoot, "rk", "snapshots")
	if _, err := os.Stat(dir); err == nil {
		return // target exists — never merge or clobber
	} else if !os.IsNotExist(err) {
		slog.Debug("snapshot: legacy move skipped, target unstatable", "dir", dir, "err", err)
		return
	}
	if _, err := os.Stat(legacy); err != nil {
		return // nothing to move (or unreadable — cold start either way)
	}
	if err := os.MkdirAll(filepath.Dir(dir), dirMode); err != nil {
		slog.Debug("snapshot: legacy move failed, starting cold", "from", legacy, "to", dir, "err", err)
		return
	}
	if err := os.Rename(legacy, dir); err != nil {
		slog.Debug("snapshot: legacy move failed, starting cold", "from", legacy, "to", dir, "err", err)
		return
	}
	breadcrumb := filepath.Join(stateRoot, "rk", "MOVED-to-run-kit")
	if err := os.WriteFile(breadcrumb, []byte("snapshots moved to "+dir+"\n"), fileMode); err != nil {
		slog.Debug("snapshot: breadcrumb write failed", "path", breadcrumb, "err", err)
	}
}

// Store persists snapshots under a root directory:
//
//	{server}.json                 — latest snapshot (live server)
//	{server}/{unix-ts}.json       — rolling history (last historyRetention)
//	{server}.died-{unix-ts}.json  — tombstones of dead servers
type Store struct {
	dir string
}

// NewStore returns a Store rooted at dir. The directory is created lazily on
// first write.
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

func (s *Store) latestPath(server string) string {
	return filepath.Join(s.dir, server+jsonExt)
}

func (s *Store) historyDir(server string) string {
	return filepath.Join(s.dir, server)
}

func (s *Store) tombstonePath(server string, ts int64) string {
	return filepath.Join(s.dir, server+tombstoneInfix+strconv.FormatInt(ts, 10)+jsonExt)
}

// marshal renders a snapshot as indented JSON (human-inspectable recovery
// artifacts).
func marshal(snap *Snapshot) ([]byte, error) {
	return json.MarshalIndent(snap, "", "  ")
}

// ContentEqual reports whether two snapshots carry the same layout content,
// ignoring the capture timestamp. Used by Write so freshness-only re-captures
// (quiet-server safety passes) skip disk entirely and never churn history.
func ContentEqual(a, b *Snapshot) bool {
	if a == nil || b == nil {
		return a == b
	}
	ca, cb := *a, *b
	ca.TakenAt, cb.TakenAt = time.Time{}, time.Time{}
	ba, err := marshal(&ca)
	if err != nil {
		return false
	}
	bb, err := marshal(&cb)
	if err != nil {
		return false
	}
	return string(ba) == string(bb)
}

// Write persists snap as the server's latest snapshot plus a history entry,
// unless its content equals the current latest (ignoring TakenAt), in which
// case nothing is written. Returns whether a write happened.
//
// A zero-session snapshot is never written (A-012's alive-but-empty floor
// case): when the _rk-ctl anchor holds a socket alive after the last
// user-facing session closes, layout reads still succeed and capture yields a
// 0-session snapshot — committing it would overwrite the last good layout
// with an empty one, exactly the artifact snapshots exist to preserve (and
// restore rejects sessionless snapshots anyway).
func (s *Store) Write(snap *Snapshot) (bool, error) {
	if snap == nil || snap.Server == "" {
		return false, fmt.Errorf("snapshot write: empty snapshot/server")
	}
	if len(snap.Sessions) == 0 {
		slog.Debug("snapshot: write skipped, zero sessions", "server", snap.Server)
		return false, nil
	}
	current, err := s.LoadLatest(snap.Server)
	if err != nil {
		return false, err
	}
	if current != nil && ContentEqual(current, snap) {
		return false, nil
	}

	data, err := marshal(snap)
	if err != nil {
		return false, fmt.Errorf("snapshot write %s: %w", snap.Server, err)
	}
	if err := os.MkdirAll(s.dir, dirMode); err != nil {
		return false, fmt.Errorf("snapshot write %s: %w", snap.Server, err)
	}
	if err := fsatomic.WriteFile(s.latestPath(snap.Server), data, fileMode); err != nil {
		return false, fmt.Errorf("snapshot write %s: %w", snap.Server, err)
	}

	hd := s.historyDir(snap.Server)
	if err := os.MkdirAll(hd, dirMode); err != nil {
		return false, fmt.Errorf("snapshot history %s: %w", snap.Server, err)
	}
	// Same-second collision guard: two content-different writes within one
	// second would map to the same {unix-ts}.json and silently overwrite the
	// earlier history entry. Bump forward to the next free second — the
	// filename grammar stays a bare unix-seconds integer (LoadAt / --at
	// compatibility).
	ts := snap.TakenAt.Unix()
	histPath := filepath.Join(hd, strconv.FormatInt(ts, 10)+jsonExt)
	for {
		if _, statErr := os.Lstat(histPath); statErr != nil {
			break // free (any non-existence-unrelated error surfaces on write below)
		}
		ts++
		histPath = filepath.Join(hd, strconv.FormatInt(ts, 10)+jsonExt)
	}
	if err := fsatomic.WriteFile(histPath, data, fileMode); err != nil {
		return false, fmt.Errorf("snapshot history %s: %w", snap.Server, err)
	}
	if err := s.pruneHistory(snap.Server); err != nil {
		return true, fmt.Errorf("snapshot prune %s: %w", snap.Server, err)
	}
	return true, nil
}

// pruneHistory removes the oldest history entries beyond historyRetention.
func (s *Store) pruneHistory(server string) error {
	ts, err := s.historyTimestamps(server)
	if err != nil {
		return err
	}
	for len(ts) > historyRetention {
		oldest := ts[0]
		ts = ts[1:]
		if err := os.Remove(filepath.Join(s.historyDir(server), strconv.FormatInt(oldest, 10)+jsonExt)); err != nil {
			return err
		}
	}
	return nil
}

// historyTimestamps returns the server's history entry timestamps, ascending.
// A missing history dir returns an empty slice.
func (s *Store) historyTimestamps(server string) ([]int64, error) {
	entries, err := os.ReadDir(s.historyDir(server))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), jsonExt) {
			continue
		}
		ts, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), jsonExt), 10, 64)
		if err != nil {
			continue
		}
		out = append(out, ts)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

// load reads and decodes one snapshot file. A missing file returns (nil, nil).
func load(path string) (*Snapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return &snap, nil
}

// LoadLatest returns the server's latest live snapshot, or (nil, nil) when
// none exists.
func (s *Store) LoadLatest(server string) (*Snapshot, error) {
	return load(s.latestPath(server))
}

// LoadAt returns the snapshot for the given unix timestamp — a history entry
// or a died tombstone. Returns an error when neither exists.
func (s *Store) LoadAt(server string, ts int64) (*Snapshot, error) {
	snap, err := load(filepath.Join(s.historyDir(server), strconv.FormatInt(ts, 10)+jsonExt))
	if err != nil || snap != nil {
		return snap, err
	}
	snap, err = load(s.tombstonePath(server, ts))
	if err != nil {
		return nil, err
	}
	if snap == nil {
		return nil, fmt.Errorf("no snapshot for %s at %d", server, ts)
	}
	return snap, nil
}

// Resolve returns the snapshot restore/show should act on: the entry at `at`
// when non-zero, else the latest live snapshot, else the newest tombstone.
func (s *Store) Resolve(server string, at int64) (*Snapshot, error) {
	if at != 0 {
		return s.LoadAt(server, at)
	}
	snap, err := s.LoadLatest(server)
	if err != nil {
		return nil, err
	}
	if snap != nil {
		return snap, nil
	}
	ts, err := s.tombstoneTimestamps(server)
	if err != nil {
		return nil, err
	}
	if len(ts) == 0 {
		return nil, fmt.Errorf("no snapshot found for server %q", server)
	}
	return load(s.tombstonePath(server, ts[len(ts)-1]))
}

// tombstoneTimestamps returns the server's tombstone timestamps, ascending.
func (s *Store) tombstoneTimestamps(server string) ([]int64, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	prefix := server + tombstoneInfix
	var out []int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), prefix) || !strings.HasSuffix(e.Name(), jsonExt) {
			continue
		}
		ts, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(e.Name(), prefix), jsonExt), 10, 64)
		if err != nil {
			continue
		}
		out = append(out, ts)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

// Tombstone marks a dead server's latest snapshot: it is stamped with diedAt
// (+ auditedKill) and moved to {server}.died-{ts}.json — the moment a server
// dies is exactly when its snapshot becomes valuable, so it is renamed, never
// deleted. A server with no latest snapshot is a no-op, reported by the
// created return (false ⇒ nothing to tombstone). Tombstones beyond
// tombstoneRetention are pruned (oldest first); history is left intact.
func (s *Store) Tombstone(server string, diedAt time.Time, audited bool) (created bool, err error) {
	snap, err := s.LoadLatest(server)
	if err != nil {
		return false, err
	}
	if snap == nil {
		return false, nil
	}
	diedAt = diedAt.UTC()
	snap.DiedAt = &diedAt
	snap.AuditedKill = audited
	data, err := marshal(snap)
	if err != nil {
		return false, fmt.Errorf("tombstone %s: %w", server, err)
	}
	if err := fsatomic.WriteFile(s.tombstonePath(server, diedAt.Unix()), data, fileMode); err != nil {
		return false, fmt.Errorf("tombstone %s: %w", server, err)
	}
	if err := os.Remove(s.latestPath(server)); err != nil && !os.IsNotExist(err) {
		return false, fmt.Errorf("tombstone %s: %w", server, err)
	}
	ts, err := s.tombstoneTimestamps(server)
	if err != nil {
		return true, err
	}
	for len(ts) > tombstoneRetention {
		oldest := ts[0]
		ts = ts[1:]
		if err := os.Remove(s.tombstonePath(server, oldest)); err != nil {
			return true, err
		}
	}
	return true, nil
}

// RetireLatest removes the server's latest snapshot file without tombstoning
// it. Retire means "never should have been covered" (an ephemeral opt-out
// observed after a first-observation snapshot already landed), as opposed to
// a tombstone, which means "server died" — so no .died-* file is created and
// history/tombstones are untouched (the existing prune owns history).
// Idempotent: a missing latest is a no-op success.
func (s *Store) RetireLatest(server string) error {
	if err := os.Remove(s.latestPath(server)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("retire latest %s: %w", server, err)
	}
	return nil
}

// Dismiss converts the server's lingering live-latest into a never-re-offerable
// tombstone. A user-driven dismissal is a deliberate run-kit action, so the
// tombstone carries the audited marker — the same marker that already excludes
// audited tombstones from the restorable-offer set. Idempotent: a server with
// no latest snapshot is a no-op success. History is left intact.
func (s *Store) Dismiss(server string) error {
	_, err := s.Tombstone(server, time.Now(), true)
	return err
}

// Entry is one row in a store listing: a live latest snapshot or a died
// tombstone.
type Entry struct {
	Server      string
	TakenAt     time.Time
	DiedAt      *time.Time // non-nil ⇒ tombstone
	AuditedKill bool
	Sessions    int
	Windows     int
	// HistoryCount is the number of rolling history entries for the server
	// (reported on live rows; 0 on tombstones).
	HistoryCount int
}

// List returns the store's entries — every live latest snapshot and every
// died tombstone — newest-first, optionally filtered to one server. A missing
// store dir returns an empty list.
func (s *Store) List(serverFilter string) ([]Entry, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Entry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), jsonExt) {
			continue
		}
		base := strings.TrimSuffix(e.Name(), jsonExt)
		server := base
		if i := strings.Index(base, tombstoneInfix); i >= 0 {
			server = base[:i]
		}
		if serverFilter != "" && server != serverFilter {
			continue
		}
		snap, err := load(filepath.Join(s.dir, e.Name()))
		if err != nil || snap == nil {
			continue
		}
		row := Entry{
			Server:      server,
			TakenAt:     snap.TakenAt,
			DiedAt:      snap.DiedAt,
			AuditedKill: snap.AuditedKill,
			Sessions:    snap.SessionCount(),
			Windows:     snap.WindowCount(),
		}
		if snap.DiedAt == nil {
			hist, err := s.historyTimestamps(server)
			if err == nil {
				row.HistoryCount = len(hist)
			}
		}
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].TakenAt.Equal(out[j].TakenAt) {
			return out[i].TakenAt.After(out[j].TakenAt)
		}
		return out[i].Server < out[j].Server
	})
	return out, nil
}
