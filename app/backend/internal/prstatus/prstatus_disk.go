package prstatus

// Disk seed for PR status (260809-r4vk-pr-status-disk-seed).
//
// After 260807-2ept a restart is fast only when gh answers promptly at startup:
// the collector's immediate batched fetch seeds the head-index and the wake-driven
// first branch pass joins against it. That whole mechanism is network-gated, so a
// restart while gh is slow, offline, or rate-limited still starts with EMPTY
// PR-status state and every sidebar/window PR glyph stays blank until the first
// successful fetch. Restarts are routine (`rk serve` restarts on self-update).
//
// This file adds a small file store + a startup seed, following
// internal/snapshot/store.go's established pattern at a smaller scale:
//
//   - ONE JSON file under the same state root the layout snapshots use, written
//     atomically via internal/fsatomic and coalesced by content dedup, so the
//     30s/90s ticks produce no write storm when nothing changed.
//   - Read exactly ONCE, at startup, before either poller starts; written only
//     from the collector's / branch refresher's background refresh goroutines.
//     The SSE hot path (Register/Snapshot/attachPRStatus) is untouched: no file
//     IO, no subprocess.
//   - The seed is NEVER authoritative. It is stale-while-revalidate extended
//     across the process boundary: the collector's immediate first refresh and
//     the #542 wake/index machinery replace seeded state with fresh data exactly
//     as they replace stale in-memory state today, and a fresh result — INCLUDING
//     an authoritative negative — always wins. Deleting the file changes nothing
//     but cold-start latency.
//   - Keyed by the gh viewer login. Startup verification would need a network
//     call or a subprocess, which is precisely what the seed exists to survive,
//     so the comparison happens at the NEXT successful fetch (see
//     SeedCache.collectorRefreshed).
//
// Constitution §II legitimizes this class of file explicitly (the
// `$XDG_STATE_HOME/hexokit/` carve-out: write-only recovery backups and never-
// authoritative startup seed caches). Constitution §I is untouched — no new
// subprocess, no shell string; file IO uses os + fsatomic.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"rk/internal/apphome"
	"rk/internal/fsatomic"
)

const (
	// cacheSchemaVersion is the on-disk document version. A file carrying any
	// other value is treated as ABSENT (silently discarded), which is what lets a
	// future shape change ship without a migration: the cache is droppable by
	// construction.
	cacheSchemaVersion = 1

	// cacheFileName is the single viewer-wide cache file. One file, no per-server
	// fan-out, no history, no tombstones — unlike the layout snapshots this holds
	// one process-wide seed, not per-server recovery artifacts.
	cacheFileName = "prstatus.json"

	// cacheFileMode / cacheDirMode are deliberately TIGHTER than the snapshots'
	// 0644/0755: PR metadata is private-repo data. Both are reduced by the process
	// umask (fsatomic.WriteFile applies perm at creation; os.MkdirAll likewise), so
	// a hardened umask can only narrow them further, never widen them.
	cacheFileMode = 0o600
	cacheDirMode  = 0o700
)

// DefaultCachePath resolves the PR-status cache file: <state home>/prstatus.json,
// where the state home is apphome.StateDir. Mirrors snapshot.DefaultDir() minus
// the per-server subdirectory — state dir, not cache dir, because it shares a
// root with the recovery artifacts and the path stays uniform across platforms.
// The legacy <state-root>/rk/prstatus.json is left behind, unmoved: a seed
// cache regenerates on the next refresh, so a move would buy at most one
// cold-start latency hit.
func DefaultCachePath() (string, error) {
	root, err := apphome.StateDir()
	if err != nil {
		return "", fmt.Errorf("resolving prstatus cache path: %w", err)
	}
	return filepath.Join(root, cacheFileName), nil
}

// SeedState is the in-memory shape of one cache generation: everything a fresh
// process needs to pre-fill its derived PR state. It carries BOTH halves of the
// runtime state — the collector's URL-keyed snapshot and its viewer-PR list, plus
// the branch refresher's positive entries.
//
// Negative branch entries (resolved "no PR") are deliberately NOT part of it: a
// seed exists to fill blanks, and a negative re-derives cheaply.
type SeedState struct {
	// Login is the gh viewer login the state was fetched as ("" when unknown).
	Login string
	// ByURL is the collector's snapshot, keyed by canonical PR URL. FetchedAt is
	// carried through verbatim — the flyout's "checked Xs ago" line must report
	// honest staleness.
	ByURL map[string]PRStatus
	// ViewerPRs is the last successful batch's projection — the collector's
	// last-good viewer list AND the source the branch refresher's head-index is
	// seeded from.
	ViewerPRs []ViewerPR
	// BranchPRs are the positive (repoDir, branch) → PR derivations — what
	// restores window PR glyphs (PrURL/PrNumber) immediately after a restart.
	BranchPRs []SeedBranchPR
}

// SeedBranchPR is one positive branch derivation, carried with EXPLICIT repoDir
// and branch fields — never the refresher's internal NUL-joined cache key, which
// is an implementation detail and must not become a persisted format.
type SeedBranchPR struct {
	RepoDir string
	Branch  string
	PR      BranchPR
}

// --- persistence DTOs -----------------------------------------------------------
//
// The on-disk shape is EXPLICIT and private: the in-memory PRStatus / ViewerPR /
// BranchPR structs are converted at this boundary rather than marshalled
// directly, so adding an in-memory field can never silently change the persisted
// format. A deliberate shape change bumps cacheSchemaVersion and old caches are
// discarded.

type diskState struct {
	Schema    int                     `json:"schema"`
	Login     string                  `json:"login"`
	SavedAt   time.Time               `json:"savedAt"`
	Collector map[string]diskPRStatus `json:"collector"`
	ViewerPRs []diskViewerPR          `json:"viewerPRs"`
	BranchPRs []diskBranchEntry       `json:"branchPRs"`
}

type diskPRStatus struct {
	Number         int       `json:"number"`
	URL            string    `json:"url"`
	State          string    `json:"state"`
	IsDraft        bool      `json:"isDraft"`
	Checks         string    `json:"checks"`
	ReviewDecision string    `json:"reviewDecision"`
	FetchedAt      time.Time `json:"fetchedAt"`
}

type diskViewerPR struct {
	Number    int       `json:"number"`
	URL       string    `json:"url"`
	State     string    `json:"state"`
	HeadRepo  string    `json:"headRepo"`
	HeadRef   string    `json:"headRef"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type diskBranchEntry struct {
	RepoDir string       `json:"repoDir"`
	Branch  string       `json:"branch"`
	PR      diskBranchPR `json:"pr"`
}

type diskBranchPR struct {
	Number    int       `json:"number"`
	URL       string    `json:"url"`
	State     string    `json:"state"`
	UpdatedAt time.Time `json:"updatedAt"`
	IsDraft   bool      `json:"isDraft"`
}

// diskStateFrom projects a SeedState onto the persistence DTOs, leaving SavedAt
// zero (the caller stamps it at write time so the dedup comparison can ignore it).
// Branch entries are SORTED by (repoDir, branch): they are assembled from a Go
// map, and the content dedup compares serialized bytes, so equal state MUST
// serialize equally.
func diskStateFrom(st SeedState) diskState {
	doc := diskState{Schema: cacheSchemaVersion, Login: st.Login}

	if len(st.ByURL) > 0 {
		doc.Collector = make(map[string]diskPRStatus, len(st.ByURL))
		for url, p := range st.ByURL {
			doc.Collector[url] = diskPRStatus{
				Number:         p.Number,
				URL:            p.URL,
				State:          p.State,
				IsDraft:        p.IsDraft,
				Checks:         p.Checks,
				ReviewDecision: p.ReviewDecision,
				FetchedAt:      p.FetchedAt,
			}
		}
	}

	for _, v := range st.ViewerPRs {
		doc.ViewerPRs = append(doc.ViewerPRs, diskViewerPR{
			Number:    v.Number,
			URL:       v.URL,
			State:     v.State,
			HeadRepo:  v.HeadRepo,
			HeadRef:   v.HeadRef,
			UpdatedAt: v.UpdatedAt,
		})
	}

	for _, b := range st.BranchPRs {
		doc.BranchPRs = append(doc.BranchPRs, diskBranchEntry{
			RepoDir: b.RepoDir,
			Branch:  b.Branch,
			PR: diskBranchPR{
				Number:    b.PR.Number,
				URL:       b.PR.URL,
				State:     b.PR.State,
				UpdatedAt: b.PR.UpdatedAt,
				IsDraft:   b.PR.IsDraft,
			},
		})
	}
	sort.Slice(doc.BranchPRs, func(i, j int) bool {
		if doc.BranchPRs[i].RepoDir != doc.BranchPRs[j].RepoDir {
			return doc.BranchPRs[i].RepoDir < doc.BranchPRs[j].RepoDir
		}
		return doc.BranchPRs[i].Branch < doc.BranchPRs[j].Branch
	})
	return doc
}

// seedState inverts diskStateFrom. Entries that could never serve are dropped
// here rather than downstream: a PRStatus keyed by an empty URL, or a branch
// entry with no repoDir/branch/PR URL, carries nothing the joins can use.
func (d diskState) seedState() SeedState {
	st := SeedState{Login: d.Login}
	if len(d.Collector) > 0 {
		st.ByURL = make(map[string]PRStatus, len(d.Collector))
		for url, p := range d.Collector {
			if url == "" {
				continue
			}
			st.ByURL[url] = PRStatus{
				Number:         p.Number,
				URL:            p.URL,
				State:          p.State,
				IsDraft:        p.IsDraft,
				Checks:         p.Checks,
				ReviewDecision: p.ReviewDecision,
				FetchedAt:      p.FetchedAt,
			}
		}
	}
	for _, v := range d.ViewerPRs {
		st.ViewerPRs = append(st.ViewerPRs, ViewerPR{
			Number:    v.Number,
			URL:       v.URL,
			State:     v.State,
			HeadRepo:  v.HeadRepo,
			HeadRef:   v.HeadRef,
			UpdatedAt: v.UpdatedAt,
		})
	}
	for _, b := range d.BranchPRs {
		if b.RepoDir == "" || b.Branch == "" || b.PR.URL == "" {
			continue
		}
		st.BranchPRs = append(st.BranchPRs, SeedBranchPR{
			RepoDir: b.RepoDir,
			Branch:  b.Branch,
			PR: BranchPR{
				Number:    b.PR.Number,
				URL:       b.PR.URL,
				State:     b.PR.State,
				UpdatedAt: b.PR.UpdatedAt,
				IsDraft:   b.PR.IsDraft,
			},
		})
	}
	return st
}

// --- store ----------------------------------------------------------------------

// Store reads and writes the single PR-status cache file. Writes are atomic
// (fsatomic.WriteFile) and coalesced by content dedup; reads are total — every
// failure mode yields an empty seed, never an error a caller could surface.
type Store struct {
	path string

	mu sync.Mutex
	// lastKey is the serialization of the last document written with its
	// freshness-only stamps zeroed (dedupKey). Nil until this process has written
	// once, so the first save after startup always lands (cheap, and it re-stamps
	// a cache written by an older process).
	lastKey []byte
}

// NewStore returns a Store for the given file path. The parent directory is
// created lazily on first write (0700).
func NewStore(path string) *Store { return &Store{path: path} }

// Path reports the file this store reads and writes.
func (s *Store) Path() string { return s.path }

// Load reads the cache. It reports ok=false — with an EMPTY seed and NO error —
// for every failure mode: absent file, unreadable file, malformed or truncated
// JSON, and a schema-version mismatch. A corrupt cache must degrade to a cold
// start, never to a startup error (at most one slog.Debug line).
func (s *Store) Load() (SeedState, bool) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Debug("prstatus: cache unreadable, starting empty", "path", s.path, "err", err)
		}
		return SeedState{}, false
	}
	var doc diskState
	if err := json.Unmarshal(data, &doc); err != nil {
		slog.Debug("prstatus: cache corrupt, starting empty", "path", s.path, "err", err)
		return SeedState{}, false
	}
	if doc.Schema != cacheSchemaVersion {
		slog.Debug("prstatus: cache schema mismatch, starting empty",
			"path", s.path, "schema", doc.Schema, "want", cacheSchemaVersion)
		return SeedState{}, false
	}
	return doc.seedState(), true
}

// dedupKey renders doc as the write-skip comparison key: its serialization with
// every FRESHNESS-ONLY stamp zeroed. Two stamps qualify, and a pass that observed
// NO change still moves both:
//
//   - the document-level savedAt, stamped at write time; and
//   - each collector entry's fetchedAt — Collector.refresh rebuilds byURL with
//     `FetchedAt: now` on EVERY successful pass, so a key that compared it would
//     always differ and the 90s tick would rewrite the file forever at idle.
//
// This is the same reason snapshot.ContentEqual zeroes TakenAt. The WRITTEN
// document keeps its real fetchedAt values (R4 — the flyout's "checked Xs ago"
// line must stay honest across a restart); only the comparison ignores them, so a
// coalesced save leaves the file describing the last pass that actually changed
// something. Genuine content timestamps (a PR's updatedAt) stay in the key: they
// move only when the PR itself moves.
func dedupKey(doc diskState) ([]byte, error) {
	key := doc
	key.SavedAt = time.Time{}
	if len(doc.Collector) > 0 {
		// A FRESH map: the struct copy above shares doc's map, and the document
		// about to be written must keep its real fetchedAt values.
		key.Collector = make(map[string]diskPRStatus, len(doc.Collector))
		for url, p := range doc.Collector {
			p.FetchedAt = time.Time{}
			key.Collector[url] = p
		}
	}
	return json.Marshal(key)
}

// Save writes st unless its content equals the last document this store wrote,
// IGNORING the freshness-only stamps (savedAt and every collector entry's
// fetchedAt — see dedupKey) — the same freshness-only-skip rule as
// snapshot.ContentEqual, which is what keeps the 30s/90s refresh ticks from
// churning the file. It reports whether a write happened.
func (s *Store) Save(st SeedState) (bool, error) {
	doc := diskStateFrom(st)
	key, err := dedupKey(doc)
	if err != nil {
		return false, fmt.Errorf("prstatus cache save: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastKey != nil && bytes.Equal(s.lastKey, key) {
		return false, nil
	}

	doc.SavedAt = time.Now().UTC()
	data, err := json.MarshalIndent(doc, "", "  ") // human-inspectable, like snapshots
	if err != nil {
		return false, fmt.Errorf("prstatus cache save: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), cacheDirMode); err != nil {
		return false, fmt.Errorf("prstatus cache save: %w", err)
	}
	if err := fsatomic.WriteFile(s.path, data, cacheFileMode); err != nil {
		return false, fmt.Errorf("prstatus cache save: %w", err)
	}
	s.lastKey = key
	return true, nil
}

// --- seed cache orchestration ---------------------------------------------------

// SeedCache ties a Store to the two live pollers: it loads the startup seed into
// both and rewrites the file after their successful background passes. It also
// owns the ONE piece of state that spans them — the login the loaded cache was
// written under, which only a successful collector fetch can check.
type SeedCache struct {
	store *Store
	c     *Collector
	r     *BranchRefresher

	mu sync.Mutex
	// seedLogin is the login the loaded cache carried. It stays set while
	// seed-originated state may still be serving, and is cleared once a login
	// mismatch has been handled (so the discard happens exactly once).
	seedLogin string
}

// NewSeedCache pairs a store with the collector and branch refresher it seeds.
// Either poller may be nil (the other half still works).
func NewSeedCache(store *Store, c *Collector, r *BranchRefresher) *SeedCache {
	return &SeedCache{store: store, c: c, r: r}
}

// Seed loads the cache ONCE and pre-fills both pollers. Call it before either
// Start: the seeded state is what serves the window between process start and the
// first successful fetch, and it never suppresses or delays that fetch.
//
// The collector's byURL AND its last-good viewer list are both seeded, so the
// writer below can always assemble the document from live in-memory state — a
// branch-triggered write before the first successful fetch must not persist an
// empty collector half over the very seed it was loaded from.
func (sc *SeedCache) Seed() {
	if sc == nil || sc.store == nil {
		return
	}
	st, ok := sc.store.Load()
	if !ok {
		return
	}
	sc.mu.Lock()
	sc.seedLogin = st.Login
	sc.mu.Unlock()

	if sc.c != nil {
		sc.c.Seed(st.ByURL, st.ViewerPRs)
	}
	if sc.r != nil {
		// Seed the head-index first so a pass that resolves a pair from it can
		// mark the resulting entry seed-originated (see BranchRefresher.refresh).
		sc.r.SeedViewerIndex(st.ViewerPRs)
		sc.r.SeedEntries(st.BranchPRs)
	}
	slog.Debug("prstatus: seeded from cache", "path", sc.store.Path(),
		"prs", len(st.ByURL), "viewerPRs", len(st.ViewerPRs), "branchPRs", len(st.BranchPRs))
}

// Attach installs the save hooks on both pollers. Writes then ride their existing
// background goroutines — nothing is added to the SSE hot path.
func (sc *SeedCache) Attach() {
	if sc == nil {
		return
	}
	if sc.c != nil {
		sc.c.SetRefreshHook(sc.collectorRefreshed)
	}
	if sc.r != nil {
		sc.r.SetRefreshHook(sc.branchRefreshed)
	}
}

// collectorRefreshed runs at the tail of a SUCCESSFUL collector pass. It is where
// account-switch invalidation lands: startup seeds unconditionally (verification
// would need the network the seed exists to survive), so the login comparison
// happens HERE, at the next successful fetch.
//
// That fetch has already replaced byURL, the viewer list, and the head-index
// wholesale, so the discard concretely means clearing the branch refresher's
// still-seed-originated entries — the only state a wholesale mechanism does not
// touch — and rewriting the file under the new login. An empty login on either
// side is "unknown", never a mismatch.
func (sc *SeedCache) collectorRefreshed() {
	login := ""
	if sc.c != nil {
		login = sc.c.Login()
	}

	sc.mu.Lock()
	mismatch := login != "" && sc.seedLogin != "" && login != sc.seedLogin
	if mismatch {
		sc.seedLogin = "" // handled once; later passes must not re-discard
	}
	sc.mu.Unlock()

	if mismatch && sc.r != nil {
		slog.Debug("prstatus: gh login changed, discarding seeded state", "login", login)
		sc.r.DiscardSeeded()
	}
	sc.save()
}

// branchRefreshed runs at the tail of a branch refresher pass.
func (sc *SeedCache) branchRefreshed() { sc.save() }

// save assembles the current state from both pollers and hands it to the store,
// which coalesces an unchanged document away. A write failure is a debug line and
// nothing more — the cache is an optimization, never a correctness dependency.
func (sc *SeedCache) save() {
	if sc == nil || sc.store == nil {
		return
	}
	if _, err := sc.store.Save(sc.state()); err != nil {
		slog.Debug("prstatus: cache write failed", "path", sc.store.Path(), "err", err)
	}
}

// state snapshots what should be persisted right now, entirely from live
// in-memory state (the seed was loaded INTO that state, so nothing is lost when
// only one poller has refreshed).
func (sc *SeedCache) state() SeedState {
	var st SeedState
	if sc.c != nil {
		st.ByURL = sc.c.Snapshot()
		st.ViewerPRs = sc.c.ViewerPRs()
		st.Login = sc.c.Login()
	}
	if st.Login == "" {
		// No successful fetch yet this process: keep labelling the file with the
		// login it was written under, rather than dropping the key.
		sc.mu.Lock()
		st.Login = sc.seedLogin
		sc.mu.Unlock()
	}
	if sc.r != nil {
		st.BranchPRs = sc.r.PositiveEntries()
	}
	return st
}

// AttachSeedCache is the production wiring one-liner (api.NewRouterAndServer):
// resolve the default path, load the seed into both pollers, and attach the save
// hooks — all before either Start. A path-resolution failure degrades to a debug
// line and an unseeded start; it returns the cache for callers that want it (nil
// when the path could not be resolved).
func AttachSeedCache(c *Collector, r *BranchRefresher) *SeedCache {
	path, err := DefaultCachePath()
	if err != nil {
		slog.Debug("prstatus: no cache path, starting unseeded", "err", err)
		return nil
	}
	sc := NewSeedCache(NewStore(path), c, r)
	sc.Seed()
	sc.Attach()
	return sc
}
