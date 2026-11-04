package prstatus

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTempStore returns a store rooted at a path inside a fresh temp dir whose
// PARENT exists but whose `rk` directory does not — so the 0700 lazy-create path
// is the one under test.
func newTempStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(filepath.Join(t.TempDir(), "rk", cacheFileName))
}

// fixtureState builds a fully-populated seed state (all three halves + login).
func fixtureState(t *testing.T) SeedState {
	t.Helper()
	fetched := time.Date(2026, 8, 9, 9, 58, 0, 0, time.UTC)
	updated := time.Date(2026, 8, 9, 9, 50, 0, 0, time.UTC)
	return SeedState{
		Login: "sahil87",
		ByURL: map[string]PRStatus{
			"https://github.com/sahil87/run-kit/pull/542": {
				Number:         542,
				URL:            "https://github.com/sahil87/run-kit/pull/542",
				State:          "merged",
				IsDraft:        false,
				Checks:         "pass",
				ReviewDecision: "approved",
				FetchedAt:      fetched,
			},
		},
		ViewerPRs: []ViewerPR{{
			Number:    542,
			URL:       "https://github.com/sahil87/run-kit/pull/542",
			State:     "MERGED",
			HeadRepo:  "sahil87/run-kit",
			HeadRef:   "260807-2ept-pr-status-cold-start",
			UpdatedAt: updated,
		}},
		BranchPRs: []SeedBranchPR{{
			RepoDir: "/home/sahil/code/sahil87/run-kit",
			Branch:  "260807-2ept-pr-status-cold-start",
			PR: BranchPR{
				Number:    542,
				URL:       "https://github.com/sahil87/run-kit/pull/542",
				State:     "MERGED",
				UpdatedAt: updated,
				IsDraft:   false,
			},
		}},
	}
}

// --- path resolution ------------------------------------------------------------

// TestDefaultCachePath: the cache shares the layout snapshots' state root (state
// dir, not cache dir), one file, uniform across platforms.
func TestDefaultCachePath(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	got, err := DefaultCachePath()
	if err != nil {
		t.Fatalf("DefaultCachePath: %v", err)
	}
	if want := filepath.Join(state, "hexokit", "prstatus.json"); got != want {
		t.Errorf("path = %q, want %q", got, want)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	got, err = DefaultCachePath()
	if err != nil {
		t.Fatalf("DefaultCachePath (unset): %v", err)
	}
	if want := filepath.Join(home, ".local", "state", "hexokit", "prstatus.json"); got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
}

// --- store round-trip -----------------------------------------------------------

// TestStoreRoundTrip: save → load reproduces every persisted half, with the
// collector's FetchedAt PRESERVED (the flyout's "checked Xs ago" line must stay
// honest across a restart).
func TestStoreRoundTrip(t *testing.T) {
	s := newTempStore(t)
	want := fixtureState(t)

	wrote, err := s.Save(want)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !wrote {
		t.Fatal("first Save must write")
	}

	// A FRESH store (as a restarted process would use) reads it back.
	got, ok := NewStore(s.Path()).Load()
	if !ok {
		t.Fatal("Load reported no usable cache")
	}
	if got.Login != "sahil87" {
		t.Errorf("Login = %q, want sahil87", got.Login)
	}

	url := "https://github.com/sahil87/run-kit/pull/542"
	st, ok := got.ByURL[url]
	if !ok {
		t.Fatalf("byURL missing %q: %v", url, got.ByURL)
	}
	if st != want.ByURL[url] {
		t.Errorf("PRStatus = %+v, want %+v (FetchedAt must be preserved)", st, want.ByURL[url])
	}

	if len(got.ViewerPRs) != 1 || got.ViewerPRs[0] != want.ViewerPRs[0] {
		t.Errorf("ViewerPRs = %+v, want %+v", got.ViewerPRs, want.ViewerPRs)
	}
	if len(got.BranchPRs) != 1 || got.BranchPRs[0] != want.BranchPRs[0] {
		t.Errorf("BranchPRs = %+v, want %+v", got.BranchPRs, want.BranchPRs)
	}
}

// TestStoreDocumentShape: the persisted document carries an integer schema and
// explicit repoDir/branch fields — never the refresher's internal NUL-joined cache
// key, which is an implementation detail and must not become a format.
func TestStoreDocumentShape(t *testing.T) {
	s := newTempStore(t)
	if _, err := s.Save(fixtureState(t)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatal(err)
	}

	var doc struct {
		Schema    int    `json:"schema"`
		Login     string `json:"login"`
		SavedAt   string `json:"savedAt"`
		BranchPRs []struct {
			RepoDir string `json:"repoDir"`
			Branch  string `json:"branch"`
		} `json:"branchPRs"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("persisted document is not valid JSON: %v", err)
	}
	if doc.Schema != cacheSchemaVersion {
		t.Errorf("schema = %d, want %d", doc.Schema, cacheSchemaVersion)
	}
	if doc.Login != "sahil87" || doc.SavedAt == "" {
		t.Errorf("login/savedAt = %q/%q", doc.Login, doc.SavedAt)
	}
	if len(doc.BranchPRs) != 1 || doc.BranchPRs[0].Branch == "" || doc.BranchPRs[0].RepoDir == "" {
		t.Errorf("branchPRs = %+v, want discrete repoDir/branch fields", doc.BranchPRs)
	}
	if strings.Contains(string(raw), "\\u0000") {
		t.Error("the internal NUL-joined cache key must never be persisted")
	}
}

// TestStorePermissions: 0600 file, 0700 directory — PR metadata is private-repo
// data, deliberately tighter than the snapshots' 0644/0755.
func TestStorePermissions(t *testing.T) {
	s := newTempStore(t)
	if _, err := s.Save(fixtureState(t)); err != nil {
		t.Fatalf("Save: %v", err)
	}

	fi, err := os.Stat(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != cacheFileMode {
		t.Errorf("file perm = %v, want %v", got, os.FileMode(cacheFileMode))
	}
	di, err := os.Stat(filepath.Dir(s.Path()))
	if err != nil {
		t.Fatal(err)
	}
	if got := di.Mode().Perm(); got != cacheDirMode {
		t.Errorf("dir perm = %v, want %v", got, os.FileMode(cacheDirMode))
	}
}

// TestStoreLoadTolerance: every unusable-cache mode yields an EMPTY seed with NO
// error — a corrupt or stale-format cache must degrade to a cold start, never to a
// startup failure.
func TestStoreLoadTolerance(t *testing.T) {
	good, err := json.Marshal(diskStateFrom(fixtureState(t)))
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		write func(path string)
	}{
		{"absent file", func(string) {}},
		{"malformed JSON", func(p string) { mustWrite(t, p, []byte("{not json")) }},
		{"truncated document", func(p string) { mustWrite(t, p, good[:len(good)/2]) }},
		{"empty file", func(p string) { mustWrite(t, p, nil) }},
		{"wrong schema", func(p string) {
			mustWrite(t, p, []byte(`{"schema":999,"login":"a","collector":{"u":{"number":1,"url":"u"}}}`))
		}},
		{"json null", func(p string) { mustWrite(t, p, []byte("null")) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rk", cacheFileName)
			if tc.name != "absent file" {
				if err := os.MkdirAll(filepath.Dir(path), cacheDirMode); err != nil {
					t.Fatal(err)
				}
			}
			tc.write(path)

			got, ok := NewStore(path).Load()
			if ok {
				t.Errorf("Load reported a usable cache for %s", tc.name)
			}
			if got.Login != "" || len(got.ByURL) != 0 || len(got.ViewerPRs) != 0 || len(got.BranchPRs) != 0 {
				t.Errorf("Load returned non-empty state for %s: %+v", tc.name, got)
			}
		})
	}
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, cacheFileMode); err != nil {
		t.Fatal(err)
	}
}

// TestStoreLoadDropsUnservableEntries: entries that could never serve a join (a
// PRStatus under an empty URL key, a branch entry missing repoDir/branch/PR URL)
// are dropped at load rather than seeded.
func TestStoreLoadDropsUnservableEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rk", cacheFileName)
	if err := os.MkdirAll(filepath.Dir(path), cacheDirMode); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, path, []byte(`{
	  "schema": 1,
	  "login": "sahil87",
	  "collector": {"": {"number": 1, "url": ""}, "u2": {"number": 2, "url": "u2"}},
	  "branchPRs": [
	    {"repoDir": "", "branch": "feat", "pr": {"number": 1, "url": "u1"}},
	    {"repoDir": "/repo", "branch": "", "pr": {"number": 2, "url": "u2"}},
	    {"repoDir": "/repo", "branch": "feat", "pr": {"number": 3, "url": ""}},
	    {"repoDir": "/repo", "branch": "ok", "pr": {"number": 4, "url": "u4"}}
	  ]
	}`))

	got, ok := NewStore(path).Load()
	if !ok {
		t.Fatal("a valid document must load")
	}
	if len(got.ByURL) != 1 {
		t.Errorf("byURL = %v, want only the URL-keyed entry", got.ByURL)
	}
	if len(got.BranchPRs) != 1 || got.BranchPRs[0].Branch != "ok" {
		t.Errorf("BranchPRs = %+v, want only the servable entry", got.BranchPRs)
	}
}

// TestStoreWriteCoalescing: an unchanged document is never rewritten (the
// freshness-only-skip rule snapshot.ContentEqual established), so the 30s/90s
// refresh ticks cannot churn the file; any content change writes again.
//
// The second save reproduces what the 90s tick ACTUALLY hands the store:
// Collector.refresh rebuilds byURL with `FetchedAt: now` on every successful
// pass, so an unchanged tick still arrives with a moved fetchedAt. A fixture
// holding fetchedAt fixed would pass against a dedup key that compares it and
// prove nothing about the tick.
func TestStoreWriteCoalescing(t *testing.T) {
	s := newTempStore(t)
	st := fixtureState(t)

	if wrote, err := s.Save(st); err != nil || !wrote {
		t.Fatalf("first Save: wrote=%v err=%v", wrote, err)
	}
	before, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatal(err)
	}

	restamp := func(d time.Duration) {
		for url, p := range st.ByURL {
			p.FetchedAt = p.FetchedAt.Add(d)
			st.ByURL[url] = p
		}
	}

	restamp(90 * time.Second) // one quiet collector pass later
	if wrote, err := s.Save(st); err != nil || wrote {
		t.Errorf("identical Save with a re-stamped FetchedAt: wrote=%v err=%v, want no write", wrote, err)
	}
	after, err := os.ReadFile(s.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("a coalesced save must leave the file byte-identical (savedAt and fetchedAt included)")
	}

	// A changed half writes again — and the write carries the CURRENT fetchedAt:
	// the dedup only ignores it for the comparison, it is never zeroed on disk
	// (R4 — the flyout's "checked Xs ago" line stays honest across a restart).
	restamp(90 * time.Second)
	st.BranchPRs = append(st.BranchPRs, SeedBranchPR{
		RepoDir: "/other", Branch: "feat",
		PR: BranchPR{Number: 7, URL: "u7", State: "OPEN"},
	})
	if wrote, err := s.Save(st); err != nil || !wrote {
		t.Errorf("changed Save: wrote=%v err=%v, want a write", wrote, err)
	}
	got, ok := NewStore(s.Path()).Load()
	if !ok {
		t.Fatal("Load after the changed Save reported no usable cache")
	}
	for url, want := range st.ByURL {
		if got.ByURL[url].FetchedAt != want.FetchedAt {
			t.Errorf("persisted FetchedAt for %q = %v, want %v (the real stamp, not the zeroed dedup key)",
				url, got.ByURL[url].FetchedAt, want.FetchedAt)
		}
	}
}

// TestStoreBranchEntryOrderingIsStable: branch entries are assembled from a Go map
// (random iteration order) but the dedup compares serialized bytes — so equal state
// MUST serialize equally, which the (repoDir, branch) sort guarantees.
func TestStoreBranchEntryOrderingIsStable(t *testing.T) {
	entries := []SeedBranchPR{
		{RepoDir: "/b", Branch: "x", PR: BranchPR{Number: 2, URL: "u2"}},
		{RepoDir: "/a", Branch: "z", PR: BranchPR{Number: 1, URL: "u1"}},
		{RepoDir: "/a", Branch: "a", PR: BranchPR{Number: 3, URL: "u3"}},
	}
	shuffled := []SeedBranchPR{entries[2], entries[0], entries[1]}

	first, err := json.Marshal(diskStateFrom(SeedState{BranchPRs: entries}))
	if err != nil {
		t.Fatal(err)
	}
	second, err := json.Marshal(diskStateFrom(SeedState{BranchPRs: shuffled}))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Errorf("equal state serialized differently:\n%s\n%s", first, second)
	}

	// And the order is the documented one.
	doc := diskStateFrom(SeedState{BranchPRs: shuffled})
	want := []string{"/a\x00a", "/a\x00z", "/b\x00x"}
	for i, w := range want {
		if got := doc.BranchPRs[i].RepoDir + "\x00" + doc.BranchPRs[i].Branch; got != w {
			t.Errorf("entry %d = %q, want %q", i, got, w)
		}
	}
}

// TestStoreSaveOnUnwritablePathReturnsError: a write failure surfaces as an error
// to its (debug-logging) caller rather than panicking, and the dedup key is NOT
// advanced — the next save retries.
func TestStoreSaveOnUnwritablePathReturnsError(t *testing.T) {
	// A file where the store wants a directory: MkdirAll fails.
	dir := t.TempDir()
	blocker := filepath.Join(dir, "rk")
	mustWrite(t, blocker, []byte("not a directory"))

	s := NewStore(filepath.Join(blocker, cacheFileName))
	wrote, err := s.Save(fixtureState(t))
	if err == nil || wrote {
		t.Fatalf("Save on an unwritable path: wrote=%v err=%v, want an error", wrote, err)
	}
	if s.lastKey != nil {
		t.Error("a failed write must not advance the dedup key")
	}
}

// --- SeedCache ------------------------------------------------------------------

// newSeedCacheFixture wires a store + collector + refresher, saves `st` to disk,
// and returns the cache after Seed + Attach — the production startup sequence.
func newSeedCacheFixture(t *testing.T, st SeedState, ghExec func(context.Context) ([]byte, error)) (*SeedCache, *Collector, *BranchRefresher, *Store) {
	t.Helper()
	store := newTempStore(t)
	if _, err := store.Save(st); err != nil {
		t.Fatalf("seeding the cache file: %v", err)
	}

	c := newTestCollector(ghExec)
	r := newTestRefresher(true, func(context.Context, string, string) ([]byte, error) {
		return nil, errors.New("gh pr list unavailable (fixture default)")
	})
	c.SetViewerPRSink(r.StoreViewerIndex)

	// A fresh Store, as a restarted process would use (no in-process dedup key).
	sc := NewSeedCache(NewStore(store.Path()), c, r)
	sc.Seed()
	sc.Attach()
	return sc, c, r, store
}

// TestSeedCacheSeedsBothPollers: the startup seed pre-fills the collector's snapshot
// (FetchedAt preserved) and its last-good viewer list, the refresher's positive
// entries, and the head-index — the whole point being that window PR glyphs and
// status dots are populated before any gh call returns.
func TestSeedCacheSeedsBothPollers(t *testing.T) {
	st := fixtureState(t)
	_, c, r, _ := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return nil, errors.New("gh offline at startup")
	})

	url := "https://github.com/sahil87/run-kit/pull/542"
	if got, ok := c.Snapshot()[url]; !ok || !got.FetchedAt.Equal(st.ByURL[url].FetchedAt) {
		t.Errorf("collector seed = %+v (ok=%v), want the persisted status with its FetchedAt", got, ok)
	}
	if len(c.ViewerPRs()) != 1 {
		t.Errorf("viewer list seed = %+v", c.ViewerPRs())
	}
	pr, ok := r.Snapshot(st.BranchPRs[0].RepoDir, st.BranchPRs[0].Branch)
	if !ok || pr == nil || pr.Number != 542 {
		t.Errorf("branch seed: ok=%v pr=%v, want #542", ok, pr)
	}
	r.mu.RLock()
	idx, seeded := len(r.viewerIndex), r.viewerIndexSeeded
	r.mu.RUnlock()
	if idx != 1 || !seeded {
		t.Errorf("head-index seed: size=%d seeded=%v, want 1/true", idx, seeded)
	}
}

// TestSeedCacheSeedReplacedBySuccessfulFetch: the seed is NEVER authoritative — the
// first successful fetch replaces byURL and the head-index wholesale, INCLUDING
// dropping a seeded PR the new batch no longer carries.
func TestSeedCacheSeedReplacedBySuccessfulFetch(t *testing.T) {
	st := fixtureState(t)
	_, c, r, _ := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return ghJSONLogin("sahil87", ghHeadFixture(600, "https://github.com/sahil87/run-kit/pull/600",
			"OPEN", "sahil87/run-kit", "feat", "2026-08-09T12:00:00Z")), nil
	})

	c.refresh(context.Background())

	snap := c.Snapshot()
	if _, ok := snap["https://github.com/sahil87/run-kit/pull/542"]; ok {
		t.Error("a successful fetch must drop a seeded PR absent from the new batch")
	}
	if _, ok := snap["https://github.com/sahil87/run-kit/pull/600"]; !ok {
		t.Errorf("fetched PR missing: %v", snap)
	}
	r.mu.RLock()
	seeded := r.viewerIndexSeeded
	r.mu.RUnlock()
	if seeded {
		t.Error("the head-index must no longer be seed-originated after a live store")
	}
}

// TestSeedCacheSeedSurvivesFailedFetch: stale-while-revalidate across the process
// boundary — a failed fetch leaves every seeded half serving.
func TestSeedCacheSeedSurvivesFailedFetch(t *testing.T) {
	st := fixtureState(t)
	_, c, r, _ := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return nil, errors.New("rate limited")
	})

	c.refresh(context.Background())
	r.refresh(context.Background())

	if _, ok := c.Snapshot()["https://github.com/sahil87/run-kit/pull/542"]; !ok {
		t.Error("seeded collector state must survive a failed fetch")
	}
	if pr, ok := r.Snapshot(st.BranchPRs[0].RepoDir, st.BranchPRs[0].Branch); !ok || pr == nil {
		t.Error("seeded branch entry must survive a failed pass")
	}
}

// TestSeedCacheLoginMismatchDiscardsSeed: account-switch invalidation. Startup
// seeds unconditionally (verification would need the very network the seed exists
// to survive), so the comparison lands at the NEXT successful fetch: seed-originated
// branch entries stop serving and the file is rewritten under the new login.
func TestSeedCacheLoginMismatchDiscardsSeed(t *testing.T) {
	st := fixtureState(t) // login: sahil87
	_, c, r, store := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return ghJSONLogin("someone-else", ghHeadFixture(1, "https://github.com/someone-else/tool/pull/1",
			"OPEN", "someone-else/tool", "feat", "2026-08-09T12:00:00Z")), nil
	})

	if _, ok := r.Snapshot(st.BranchPRs[0].RepoDir, st.BranchPRs[0].Branch); !ok {
		t.Fatal("precondition: the seeded entry should serve before the fetch")
	}

	c.refresh(context.Background())

	if _, ok := r.Snapshot(st.BranchPRs[0].RepoDir, st.BranchPRs[0].Branch); ok {
		t.Error("no seed-originated entry may survive a successful fetch as another account")
	}
	got, ok := NewStore(store.Path()).Load()
	if !ok {
		t.Fatal("the cache should have been rewritten")
	}
	if got.Login != "someone-else" {
		t.Errorf("rewritten cache login = %q, want someone-else", got.Login)
	}
	if len(got.BranchPRs) != 0 {
		t.Errorf("rewritten cache still carries discarded branch entries: %+v", got.BranchPRs)
	}
}

// TestSeedCacheMatchingLoginKeepsSeed: the same account keeps its seeded entries —
// only a genuine switch discards, and an unknown ("") login on either side is never
// a mismatch.
func TestSeedCacheMatchingLoginKeepsSeed(t *testing.T) {
	for _, login := range []string{"sahil87", ""} {
		st := fixtureState(t)
		_, c, r, _ := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
			if login == "" {
				return ghJSON(ghHeadFixture(1, "u1", "OPEN", "o/r", "other", "2026-08-09T12:00:00Z")), nil
			}
			return ghJSONLogin(login, ghHeadFixture(1, "u1", "OPEN", "o/r", "other", "2026-08-09T12:00:00Z")), nil
		})

		c.refresh(context.Background())

		if _, ok := r.Snapshot(st.BranchPRs[0].RepoDir, st.BranchPRs[0].Branch); !ok {
			t.Errorf("login %q: seeded entry must keep serving", login)
		}
	}
}

// TestSeedCacheMismatchHandledOnce: after the discard, later passes must not
// re-discard — entries the new account's passes resolve are legitimate.
func TestSeedCacheMismatchHandledOnce(t *testing.T) {
	st := fixtureState(t)
	_, c, r, _ := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return ghJSONLogin("someone-else", ghHeadFixture(1, ghPRURL("someone-else/tool", 1),
			"OPEN", "someone-else/tool", "feat", "2026-08-09T12:00:00Z")), nil
	})
	c.refresh(context.Background()) // mismatch → discard

	// The new account now derives a pair of its own, then another fetch lands.
	r.exec = func(context.Context, string, string) ([]byte, error) {
		return branchListJSON(branchNode(1, ghPRURL("someone-else/tool", 1), "2026-08-09T12:00:00Z")), nil
	}
	r.Register("/repo", "feat")
	r.refresh(context.Background())
	c.refresh(context.Background())

	if pr, ok := r.Snapshot("/repo", "feat"); !ok || pr == nil || pr.Number != 1 {
		t.Errorf("the new account's own derivation must survive later fetches, got ok=%v pr=%v", ok, pr)
	}
}

// TestSeedCacheBranchSaveKeepsSeededCollectorHalf: a branch-triggered write BEFORE
// any successful fetch (the offline-restart path) must not persist an empty
// collector half over the seed it was just loaded from — which is why the seed
// fills the collector's last-good state rather than being held aside.
func TestSeedCacheBranchSaveKeepsSeededCollectorHalf(t *testing.T) {
	st := fixtureState(t)
	_, _, r, store := newSeedCacheFixture(t, st, func(context.Context) ([]byte, error) {
		return nil, errors.New("gh offline")
	})

	// A branch pass with a pair to resolve fires the save hook; gh is down, so the
	// collector has never succeeded in this process.
	r.exec = func(context.Context, string, string) ([]byte, error) {
		return branchListJSON(branchNode(7, ghPRURL("sahil87/run-kit", 7), "2026-08-09T12:00:00Z")), nil
	}
	r.Register("/repo", "feat")
	r.refresh(context.Background())

	got, ok := NewStore(store.Path()).Load()
	if !ok {
		t.Fatal("the cache should still be loadable")
	}
	if len(got.ByURL) != 1 || len(got.ViewerPRs) != 1 {
		t.Errorf("a branch-triggered save lost the seeded collector half: byURL=%v viewerPRs=%+v", got.ByURL, got.ViewerPRs)
	}
	if got.Login != "sahil87" {
		t.Errorf("login = %q, want the seeded sahil87 (no fetch has relabelled it)", got.Login)
	}
	// The newly derived pair is persisted alongside the seeded one.
	if len(got.BranchPRs) != 2 {
		t.Errorf("BranchPRs = %+v, want the seeded entry plus the newly derived one", got.BranchPRs)
	}
}

// TestSeedCacheSuccessfulFetchPersistsFreshState: the ordinary steady-state path —
// a successful fetch's own state reaches disk.
func TestSeedCacheSuccessfulFetchPersistsFreshState(t *testing.T) {
	store := newTempStore(t)
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("sahil87", ghHeadFixture(600, ghPRURL("sahil87/run-kit", 600),
			"OPEN", "sahil87/run-kit", "feat", "2026-08-09T12:00:00Z")), nil
	})
	r := newTestRefresher(true, func(context.Context, string, string) ([]byte, error) {
		return branchListJSON(branchNode(600, ghPRURL("sahil87/run-kit", 600), "2026-08-09T12:00:00Z")), nil
	})
	sc := NewSeedCache(store, c, r)
	sc.Seed() // no file yet — a true cold start
	sc.Attach()

	r.Register("/repo", "feat")
	c.refresh(context.Background())
	r.refresh(context.Background())

	got, ok := NewStore(store.Path()).Load()
	if !ok {
		t.Fatal("a successful pass must produce a cache file")
	}
	if got.Login != "sahil87" || len(got.ByURL) != 1 || len(got.ViewerPRs) != 1 || len(got.BranchPRs) != 1 {
		t.Errorf("persisted state = %+v", got)
	}
	if got.BranchPRs[0].RepoDir != "/repo" || got.BranchPRs[0].Branch != "feat" {
		t.Errorf("branch entry = %+v, want (/repo, feat)", got.BranchPRs[0])
	}
}

// TestSeedCacheNilAndMissingFileAreNoOps: an absent cache, a nil store, and a
// half-wired cache must all be silent no-ops — the seed is an optimization, never a
// correctness dependency.
func TestSeedCacheNilAndMissingFileAreNoOps(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("a", ghHeadFixture(1, "u1", "OPEN", "o/r", "feat", "2026-08-09T12:00:00Z")), nil
	})
	r := newTestRefresher(true, func(context.Context, string, string) ([]byte, error) {
		return branchListJSON(), nil
	})

	sc := NewSeedCache(newTempStore(t), c, r) // file does not exist
	sc.Seed()
	sc.Attach()
	c.refresh(context.Background()) // must not panic; writes the first generation
	if len(c.Snapshot()) != 1 {
		t.Errorf("a missing cache must leave the collector working: %v", c.Snapshot())
	}

	var nilCache *SeedCache
	nilCache.Seed()   // must not panic
	nilCache.Attach() // must not panic

	NewSeedCache(nil, c, r).Seed()               // nil store
	NewSeedCache(newTempStore(t), nil, r).Seed() // nil collector
	NewSeedCache(newTempStore(t), c, nil).Seed() // nil refresher
}
