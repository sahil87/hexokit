package prstatus

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ghJSON builds a minimal gh GraphQL response body for the given PR nodes, with
// NO viewer login — which also exercises the absent-login path (an empty login is
// "unknown", never a mismatch). Login-keyed tests use ghJSONLogin.
// Each node is the raw JSON for one PR (see ghFixture).
func ghJSON(nodes string) []byte {
	return []byte(`{"data":{"viewer":{"pullRequests":{"nodes":[` + nodes + `]}}}}`)
}

// ghJSONLogin is ghJSON plus the `viewer { login }` field the disk cache keys on.
func ghJSONLogin(login, nodes string) []byte {
	return []byte(`{"data":{"viewer":{"login":"` + login +
		`","pullRequests":{"nodes":[` + nodes + `]}}}}`)
}

// ghFixture renders one PR node with the given fields. The head-identity fields
// (headRefName/headRepository/updatedAt) are omitted — they serve only the
// branch-derivation seed, so the status-collapse tests need not carry them (and
// their absence exercises the zero-value/null path). Seed tests use ghHeadFixture.
func ghFixture(number int, url, state string, isDraft bool, rollup, review string) string {
	draft := "false"
	if isDraft {
		draft = "true"
	}
	rollupJSON := "null"
	if rollup != "" {
		rollupJSON = `{"state":"` + rollup + `"}`
	}
	return `{"number":` + strconv.Itoa(number) +
		`,"url":"` + url +
		`","state":"` + state +
		`","isDraft":` + draft +
		`,"reviewDecision":"` + review +
		`","commits":{"nodes":[{"commit":{"statusCheckRollup":` + rollupJSON + `}}]}}`
}

// ghHeadFixture renders one PR node carrying the head-identity fields the
// branch-derivation seed joins on. A headRepo of "" renders `headRepository:
// null` (the deleted-fork shape GitHub actually returns).
func ghHeadFixture(number int, url, state, headRepo, headRef, updatedAt string) string {
	headRepoJSON := "null"
	if headRepo != "" {
		headRepoJSON = `{"nameWithOwner":"` + headRepo + `"}`
	}
	return `{"number":` + strconv.Itoa(number) +
		`,"url":"` + url +
		`","state":"` + state +
		`","isDraft":false,"reviewDecision":"","updatedAt":"` + updatedAt +
		`","headRefName":"` + headRef +
		`","headRepository":` + headRepoJSON +
		`,"commits":{"nodes":[]}}`
}

// newTestCollector builds a collector whose gh availability is forced true and
// whose gh exec is stubbed with the supplied function.
func newTestCollector(exec func(ctx context.Context) ([]byte, error)) *Collector {
	c := NewCollector(time.Hour)
	c.available = func(context.Context) bool { return true }
	c.ghExec = exec
	return c
}

func TestRefreshBuildsSnapshot(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(
			ghFixture(386, "https://example/pull/386", "OPEN", false, "SUCCESS", "APPROVED"),
		), nil
	})
	c.refresh(context.Background())

	snap := c.Snapshot()
	got, ok := snap["https://example/pull/386"]
	if !ok {
		t.Fatalf("PR #386 missing from snapshot: %v", snap)
	}
	if got.URL != "https://example/pull/386" {
		t.Errorf("URL = %q", got.URL)
	}
	if got.State != "open" {
		t.Errorf("State = %q, want open", got.State)
	}
	if got.Checks != "pass" {
		t.Errorf("Checks = %q, want pass", got.Checks)
	}
	if got.ReviewDecision != "approved" {
		t.Errorf("ReviewDecision = %q, want approved", got.ReviewDecision)
	}
	if got.FetchedAt.IsZero() {
		t.Error("FetchedAt not set")
	}
}

func TestRefreshWholesaleRebuildDropsAbsentPR(t *testing.T) {
	// First cycle: two PRs present.
	out := ghJSON(
		ghFixture(100, "u100", "OPEN", false, "SUCCESS", "") + "," +
			ghFixture(200, "u200", "OPEN", false, "PENDING", ""),
	)
	c := newTestCollector(func(context.Context) ([]byte, error) { return out, nil })
	c.refresh(context.Background())
	if snap := c.Snapshot(); len(snap) != 2 || snap["u100"].Number != 100 || snap["u200"].Number != 200 {
		t.Fatalf("first cycle snapshot = %v, want #100 and #200", snap)
	}

	// Second cycle: #100 is simply absent from the fetch result. Whatever the
	// real-world reason (e.g. it aged out of the top-$limit UPDATED_AT window),
	// the wholesale rebuild must drop it — there is no separate pruning logic,
	// so "not in the latest fetch" is the entire eviction mechanism.
	out = ghJSON(ghFixture(200, "u200", "OPEN", false, "SUCCESS", ""))
	c.refresh(context.Background())
	snap := c.Snapshot()
	if _, ok := snap["u100"]; ok {
		t.Error("PR #100 should be gone after wholesale rebuild")
	}
	if _, ok := snap["u200"]; !ok {
		t.Error("PR #200 should remain")
	}
	if len(snap) != 1 {
		t.Errorf("snapshot size = %d, want 1", len(snap))
	}
}

func TestRefreshStaleWhileRevalidateOnError(t *testing.T) {
	calls := 0
	c := newTestCollector(func(context.Context) ([]byte, error) {
		calls++
		if calls == 1 {
			return ghJSON(ghFixture(386, "u386", "OPEN", false, "SUCCESS", "APPROVED")), nil
		}
		return nil, errors.New("network blip")
	})

	// First refresh: good data.
	c.refresh(context.Background())
	if _, ok := c.Snapshot()["u386"]; !ok {
		t.Fatal("PR #386 missing after first refresh")
	}

	// Second refresh: gh errors — last-good map MUST be kept.
	c.refresh(context.Background())
	snap := c.Snapshot()
	if got, ok := snap["u386"]; !ok || got.ReviewDecision != "approved" {
		t.Errorf("stale-while-revalidate failed: snapshot = %v", snap)
	}
}

func TestRefreshGhUnavailableIsNoOp(t *testing.T) {
	// Seed a snapshot via a forced-available refresh first.
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(ghFixture(1, "u1", "OPEN", false, "SUCCESS", "")), nil
	})
	c.refresh(context.Background())
	if len(c.Snapshot()) != 1 {
		t.Fatal("seed refresh failed")
	}

	// Now flip availability to false; refresh must be a no-op (last-good kept),
	// and the gh exec must NOT be called.
	c.available = func(context.Context) bool { return false }
	c.ghExec = func(context.Context) ([]byte, error) {
		t.Fatal("ghExec must not be called when gh is unavailable")
		return nil, nil
	}
	c.refresh(context.Background())
	if len(c.Snapshot()) != 1 {
		t.Errorf("snapshot changed on unavailable gh: %v", c.Snapshot())
	}
}

func TestRefreshNilExecIsNoOp(t *testing.T) {
	c := NewCollector(time.Hour)
	c.available = func(context.Context) bool { return true }
	c.ghExec = nil
	c.refresh(context.Background()) // must not panic
	if len(c.Snapshot()) != 0 {
		t.Errorf("snapshot = %v, want empty", c.Snapshot())
	}
}

func TestRefreshBadJSONKeepsLastGood(t *testing.T) {
	calls := 0
	c := newTestCollector(func(context.Context) ([]byte, error) {
		calls++
		if calls == 1 {
			return ghJSON(ghFixture(7, "u7", "OPEN", false, "SUCCESS", "")), nil
		}
		return []byte("not json"), nil
	})
	c.refresh(context.Background())
	c.refresh(context.Background())
	if _, ok := c.Snapshot()["u7"]; !ok {
		t.Error("bad JSON should keep last-good map")
	}
}

func TestMapChecks(t *testing.T) {
	cases := map[string]string{
		"SUCCESS":  "pass",
		"FAILURE":  "fail",
		"ERROR":    "fail",
		"PENDING":  "pending",
		"EXPECTED": "pending",
		"":         "none",
		"WAT":      "none",
	}
	for in, want := range cases {
		if got := mapChecks(in); got != want {
			t.Errorf("mapChecks(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMapReview(t *testing.T) {
	cases := map[string]string{
		"APPROVED":          "approved",
		"CHANGES_REQUESTED": "changes_requested",
		"REVIEW_REQUIRED":   "review_required",
		"":                  "none",
		"WAT":               "none",
	}
	for in, want := range cases {
		if got := mapReview(in); got != want {
			t.Errorf("mapReview(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMapState(t *testing.T) {
	cases := []struct {
		in    string
		draft bool
		want  string
	}{
		{"OPEN", false, "open"},
		{"OPEN", true, "open"}, // draft is surfaced via IsDraft, still "open"
		// The collector queries states: [OPEN, MERGED, CLOSED] so the line can
		// show a terminal state after a PR lands.
		{"MERGED", false, "merged"},
		{"CLOSED", false, "closed"},
		{"WAT", false, "open"}, // unexpected → safe "open" default
	}
	for _, tc := range cases {
		if got := mapState(tc.in, tc.draft); got != tc.want {
			t.Errorf("mapState(%q, %v) = %q, want %q", tc.in, tc.draft, got, tc.want)
		}
	}
}

func TestDraftAndEnumCollapseEndToEnd(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(
			ghFixture(11, "u11", "OPEN", true, "FAILURE", "CHANGES_REQUESTED") + "," +
				ghFixture(12, "u12", "OPEN", false, "SUCCESS", "APPROVED") + "," +
				ghFixture(13, "u13", "MERGED", false, "", ""),
		), nil
	})
	c.refresh(context.Background())
	snap := c.Snapshot()

	p11 := snap["u11"]
	if !p11.IsDraft {
		t.Error("#11 should be draft")
	}
	if p11.State != "open" || p11.Checks != "fail" || p11.ReviewDecision != "changes_requested" {
		t.Errorf("#11 collapse wrong: %+v", p11)
	}
	// #12 is a non-draft open PR with passing checks and an approval — exercises
	// the SUCCESS→pass and APPROVED→approved collapses.
	p12 := snap["u12"]
	if p12.State != "open" || p12.IsDraft || p12.Checks != "pass" || p12.ReviewDecision != "approved" {
		t.Errorf("#12 collapse wrong: %+v", p12)
	}
	// #13 is merged — the query now includes MERGED so a landed PR shows its
	// terminal state (checks/review are "none"/none for the empty fixture).
	p13 := snap["u13"]
	if p13.State != "merged" {
		t.Errorf("#13 should be merged, got %+v", p13)
	}
}

func TestRefreshCrossRepoSameNumberNoCollision(t *testing.T) {
	// PR numbers are only unique per repository. Two PRs sharing a number but
	// living in different repos must BOTH survive the rebuild under their own
	// URL keys — a number-keyed map let one clobber the other (the bug where an
	// open repoA#18 displayed as merged because repoB#18 had merged).
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(
			ghFixture(18, "https://github.com/sahil87/idea/pull/18", "OPEN", false, "SUCCESS", "") + "," +
				ghFixture(18, "https://github.com/sahil87/shll/pull/18", "MERGED", false, "", ""),
		), nil
	})
	c.refresh(context.Background())
	snap := c.Snapshot()

	if len(snap) != 2 {
		t.Fatalf("snapshot size = %d, want 2 (one per URL): %v", len(snap), snap)
	}
	if got := snap["https://github.com/sahil87/idea/pull/18"].State; got != "open" {
		t.Errorf("idea#18 state = %q, want open", got)
	}
	if got := snap["https://github.com/sahil87/shll/pull/18"].State; got != "merged" {
		t.Errorf("shll#18 state = %q, want merged", got)
	}
}

func TestRefreshSkipsEmptyURL(t *testing.T) {
	// A node with an empty URL (malformed/partial gh JSON) must be dropped —
	// inserting it would make unrelated empty-URL nodes collide on the "" key.
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(
			ghFixture(1, "", "MERGED", false, "", "") + "," +
				ghFixture(2, "u2", "OPEN", false, "SUCCESS", ""),
		), nil
	})
	c.refresh(context.Background())
	snap := c.Snapshot()

	if _, ok := snap[""]; ok {
		t.Error("empty-URL node must not be inserted under the \"\" key")
	}
	if len(snap) != 1 {
		t.Errorf("snapshot size = %d, want 1 (only the valid node): %v", len(snap), snap)
	}
	if _, ok := snap["u2"]; !ok {
		t.Error("valid node u2 should remain present")
	}
}

// --- viewer head-index seed (260807-2ept) ---------------------------------------

// TestParsePRsHeadFields: the batched query's head-identity additions
// (headRefName, headRepository.nameWithOwner, updatedAt) decode onto ghPR, and a
// null headRepository decodes to a nil pointer rather than erroring.
func TestParsePRsHeadFields(t *testing.T) {
	out := ghJSON(
		ghHeadFixture(1, "u1", "OPEN", "sahil87/run-kit", "feat", "2026-08-01T00:00:00Z") + "," +
			ghHeadFixture(2, "u2", "MERGED", "", "gone", "2026-08-02T00:00:00Z"),
	)
	batch, err := parseBatch(out)
	if err != nil {
		t.Fatalf("parseBatch: %v", err)
	}
	prs := batch.PRs
	if len(prs) != 2 {
		t.Fatalf("parsed %d nodes, want 2", len(prs))
	}
	if prs[0].HeadRefName != "feat" {
		t.Errorf("HeadRefName = %q, want feat", prs[0].HeadRefName)
	}
	if prs[0].HeadRepository == nil || prs[0].HeadRepository.NameWithOwner != "sahil87/run-kit" {
		t.Errorf("HeadRepository = %+v, want sahil87/run-kit", prs[0].HeadRepository)
	}
	if want := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC); !prs[0].UpdatedAt.Equal(want) {
		t.Errorf("UpdatedAt = %v, want %v", prs[0].UpdatedAt, want)
	}
	// A deleted head repository comes back as null — a nil pointer, not an error.
	if prs[1].HeadRepository != nil {
		t.Errorf("null headRepository should decode to nil, got %+v", prs[1].HeadRepository)
	}
}

// TestViewerPRsFromProjection: the exported seed projection carries URL/number/
// state/head identity/updatedAt faithfully and flattens a null headRepository to
// an empty HeadRepo (the skip signal StoreViewerIndex keys on).
func TestViewerPRsFromProjection(t *testing.T) {
	batch, err := parseBatch(ghJSON(
		ghHeadFixture(7, "u7", "OPEN", "sahil87/run-kit", "feat", "2026-08-01T00:00:00Z") + "," +
			ghHeadFixture(8, "u8", "CLOSED", "", "gone", "2026-08-02T00:00:00Z"),
	))
	if err != nil {
		t.Fatalf("parseBatch: %v", err)
	}
	got := viewerPRsFrom(batch.PRs)
	if len(got) != 2 {
		t.Fatalf("projected %d, want 2", len(got))
	}
	if got[0] != (ViewerPR{
		Number:    7,
		URL:       "u7",
		State:     "OPEN",
		HeadRepo:  "sahil87/run-kit",
		HeadRef:   "feat",
		UpdatedAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
	}) {
		t.Errorf("projection = %+v", got[0])
	}
	if got[1].HeadRepo != "" {
		t.Errorf("null headRepository must project to empty HeadRepo, got %q", got[1].HeadRepo)
	}
}

// TestRefreshInvokesViewerPRSink: a successful refresh hands the parsed nodes to
// the sink (in addition to rebuilding byURL), and the sink sees every node —
// filtering is the index's job, not the collector's.
func TestRefreshInvokesViewerPRSink(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(ghHeadFixture(7, "u7", "OPEN", "sahil87/run-kit", "feat", "2026-08-01T00:00:00Z")), nil
	})
	var seen [][]ViewerPR
	c.SetViewerPRSink(func(prs []ViewerPR) { seen = append(seen, prs) })

	c.refresh(context.Background())

	if len(seen) != 1 {
		t.Fatalf("sink invoked %d times, want 1", len(seen))
	}
	if len(seen[0]) != 1 || seen[0][0].HeadRef != "feat" || seen[0][0].URL != "u7" {
		t.Errorf("sink payload = %+v", seen[0])
	}
	// The existing URL-keyed rebuild is unaffected.
	if _, ok := c.Snapshot()["u7"]; !ok {
		t.Error("byURL rebuild must still happen alongside the seed")
	}
}

// TestRefreshSinkOnlyOnSuccessfulParse: the seed is stale-while-revalidate — a gh
// error, an unavailable gh, and malformed JSON must all leave the sink
// UNINVOKED so the last-good index survives.
func TestRefreshSinkOnlyOnSuccessfulParse(t *testing.T) {
	mode := "ok"
	c := newTestCollector(func(context.Context) ([]byte, error) {
		switch mode {
		case "err":
			return nil, errors.New("network blip")
		case "bad":
			return []byte("not json"), nil
		default:
			return ghJSON(ghHeadFixture(7, "u7", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
		}
	})
	calls := 0
	c.SetViewerPRSink(func([]ViewerPR) { calls++ })

	c.refresh(context.Background()) // ok → 1
	mode = "err"
	c.refresh(context.Background()) // gh error → no seed
	mode = "bad"
	c.refresh(context.Background()) // parse error → no seed
	mode = "ok"
	c.available = func(context.Context) bool { return false }
	c.refresh(context.Background()) // gh unavailable → no seed

	if calls != 1 {
		t.Errorf("sink invoked %d times, want 1 (successful parse only)", calls)
	}
}

// TestRefreshNilSinkIsNoOp: an unwired collector (NewTestRouter, unit tests) must
// refresh without panicking on the nil sink.
func TestRefreshNilSinkIsNoOp(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(ghHeadFixture(7, "u7", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})
	c.refresh(context.Background()) // sink never set — must not panic
	if _, ok := c.Snapshot()["u7"]; !ok {
		t.Error("refresh must still rebuild byURL with no sink wired")
	}
}

// TestRefreshIsSingleFlighted: the interval tick and an on-demand RefreshNow
// SERIALIZE rather than interleave, so a pass's byURL swap and its viewer-PR sink
// publication always describe the same batch — the branch refresher's index can
// never end up joining against a batch that disagrees with the snapshot SSE
// serves.
func TestRefreshIsSingleFlighted(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var mu sync.Mutex
	concurrent, maxConcurrent := 0, 0
	c := newTestCollector(func(context.Context) ([]byte, error) {
		mu.Lock()
		concurrent++
		if concurrent > maxConcurrent {
			maxConcurrent = concurrent
		}
		mu.Unlock()
		entered <- struct{}{}
		<-release // hold the pass open inside the gh call
		mu.Lock()
		concurrent--
		mu.Unlock()
		return ghJSON(ghHeadFixture(7, "u7", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); c.refresh(context.Background()) }() // the tick's pass
	<-entered                                                        // it is inside the gh call

	wg.Add(1)
	go func() { defer wg.Done(); c.RefreshNow(context.Background()) }() // the on-demand kick

	select {
	case <-entered:
		t.Fatal("a second pass entered the gh call while one was in flight — Collector.refresh is not single-flighted")
	case <-time.After(50 * time.Millisecond):
		// Blocked on the single-flight lock, as required.
	}

	close(release)
	wg.Wait()

	mu.Lock()
	got := maxConcurrent
	mu.Unlock()
	if got != 1 {
		t.Errorf("max concurrent refresh passes = %d, want 1", got)
	}
	if _, ok := c.Snapshot()["u7"]; !ok {
		t.Error("the serialized passes must still rebuild byURL")
	}
}

// --- disk seed: collector side (260809-r4vk) ------------------------------------

// TestParseBatchCarriesViewerLogin: the batched query's `viewer { login }`
// addition decodes alongside the nodes, and a response WITHOUT the field parses to
// an empty login (unknown, never an error).
func TestParseBatchCarriesViewerLogin(t *testing.T) {
	node := ghHeadFixture(1, "u1", "OPEN", "sahil87/run-kit", "feat", "2026-08-01T00:00:00Z")

	batch, err := parseBatch(ghJSONLogin("sahil87", node))
	if err != nil {
		t.Fatalf("parseBatch: %v", err)
	}
	if batch.Login != "sahil87" {
		t.Errorf("Login = %q, want sahil87", batch.Login)
	}
	if len(batch.PRs) != 1 || batch.PRs[0].URL != "u1" {
		t.Errorf("PRs = %+v", batch.PRs)
	}

	batch, err = parseBatch(ghJSON(node)) // no login field at all
	if err != nil {
		t.Fatalf("parseBatch (no login): %v", err)
	}
	if batch.Login != "" {
		t.Errorf("absent login should decode to \"\", got %q", batch.Login)
	}
	if len(batch.PRs) != 1 {
		t.Errorf("nodes should still parse without a login: %+v", batch.PRs)
	}
}

// TestGhQuerySelectsViewerLogin: the login is fetched by the SAME batched call —
// no extra query, no extra subprocess.
func TestGhQuerySelectsViewerLogin(t *testing.T) {
	if !strings.Contains(ghQuery, "login") {
		t.Error("ghQuery must select viewer { login } for the disk cache key")
	}
	// The states/ordering/limit contract is unchanged.
	if !strings.Contains(ghQuery, "states: [OPEN, MERGED, CLOSED]") ||
		!strings.Contains(ghQuery, "orderBy: {field: UPDATED_AT, direction: DESC}") ||
		!strings.Contains(ghQuery, "first: $limit") {
		t.Error("ghQuery states/ordering/limit must be unchanged")
	}
}

// TestRefreshRecordsLoginAndViewerList: a successful pass retains the login and
// the projected node list as last-good (the disk cache's two collector-side
// sources); a FAILED pass leaves both untouched (stale-while-revalidate).
func TestRefreshRecordsLoginAndViewerList(t *testing.T) {
	mode := "ok"
	c := newTestCollector(func(context.Context) ([]byte, error) {
		if mode == "err" {
			return nil, errors.New("network blip")
		}
		return ghJSONLogin("sahil87",
			ghHeadFixture(7, "u7", "OPEN", "sahil87/run-kit", "feat", "2026-08-01T00:00:00Z")), nil
	})

	c.refresh(context.Background())
	if got := c.Login(); got != "sahil87" {
		t.Errorf("Login = %q, want sahil87", got)
	}
	if got := c.ViewerPRs(); len(got) != 1 || got[0].HeadRef != "feat" {
		t.Errorf("ViewerPRs = %+v", got)
	}

	mode = "err"
	c.refresh(context.Background())
	if got := c.Login(); got != "sahil87" {
		t.Errorf("failed pass changed Login to %q", got)
	}
	if got := c.ViewerPRs(); len(got) != 1 {
		t.Errorf("failed pass changed ViewerPRs to %+v", got)
	}
}

// TestViewerPRsIsCopy: the retained last-good list is handed out as a copy, so a
// caller (the cache writer) cannot mutate collector state.
func TestViewerPRsIsCopy(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("a", ghHeadFixture(1, "u1", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})
	c.refresh(context.Background())
	got := c.ViewerPRs()
	got[0].HeadRef = "mutated"
	if again := c.ViewerPRs(); again[0].HeadRef != "feat" {
		t.Errorf("mutating the returned slice affected collector state: %+v", again)
	}
}

// TestSeedPreservesFetchedAt: a seeded PRStatus keeps its ORIGINAL FetchedAt — the
// flyout's "checked Xs ago" line must report honest staleness across a restart,
// not claim the data was just fetched.
func TestSeedPreservesFetchedAt(t *testing.T) {
	fetched := time.Date(2026, 8, 9, 9, 58, 0, 0, time.UTC)
	c := NewCollector(time.Hour)
	c.Seed(map[string]PRStatus{
		"u542": {Number: 542, URL: "u542", State: "merged", Checks: "pass", FetchedAt: fetched},
	}, []ViewerPR{{Number: 542, URL: "u542", State: "MERGED", HeadRepo: "o/r", HeadRef: "feat"}})

	got, ok := c.Snapshot()["u542"]
	if !ok {
		t.Fatalf("seeded PR missing from snapshot: %v", c.Snapshot())
	}
	if !got.FetchedAt.Equal(fetched) {
		t.Errorf("FetchedAt = %v, want the preserved %v", got.FetchedAt, fetched)
	}
	if got.State != "merged" || got.Checks != "pass" {
		t.Errorf("seeded status not carried through: %+v", got)
	}
	if vp := c.ViewerPRs(); len(vp) != 1 || vp[0].Number != 542 {
		t.Errorf("seeded viewer list = %+v", vp)
	}
	// The seed is NOT a fetch: it must not fabricate a login.
	if got := c.Login(); got != "" {
		t.Errorf("Seed must not set Login, got %q", got)
	}
}

// TestSeedNeverClobbersFetchedState: seeding is a startup-only fill. Applied to a
// collector that has already fetched, it must leave the fetched state alone.
func TestSeedNeverClobbersFetchedState(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("sahil87", ghHeadFixture(1, "fresh", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})
	c.refresh(context.Background())

	c.Seed(map[string]PRStatus{"stale": {Number: 9, URL: "stale"}},
		[]ViewerPR{{Number: 9, URL: "stale", HeadRepo: "o/r", HeadRef: "old"}})

	snap := c.Snapshot()
	if _, ok := snap["stale"]; ok {
		t.Errorf("seed clobbered fetched state: %v", snap)
	}
	if _, ok := snap["fresh"]; !ok {
		t.Errorf("fetched state lost: %v", snap)
	}
	if vp := c.ViewerPRs(); len(vp) != 1 || vp[0].HeadRef != "feat" {
		t.Errorf("seed clobbered the fetched viewer list: %+v", vp)
	}
}

// TestSeedIsReplacedWholesaleByFetch: the seed is never authoritative — a
// successful fetch rebuilds byURL wholesale, INCLUDING dropping a seeded PR the
// new batch no longer carries (an authoritative negative).
func TestSeedIsReplacedWholesaleByFetch(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("sahil87", ghHeadFixture(2, "kept", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})
	c.Seed(map[string]PRStatus{"dropped": {Number: 1, URL: "dropped"}}, nil)

	c.refresh(context.Background())

	snap := c.Snapshot()
	if _, ok := snap["dropped"]; ok {
		t.Error("a successful fetch must drop a seeded PR absent from the new batch")
	}
	if _, ok := snap["kept"]; !ok {
		t.Errorf("fetched PR missing: %v", snap)
	}
}

// TestSeedSurvivesFailedFetch: stale-while-revalidate across the process boundary
// — a gh error, an unavailable gh, and malformed JSON all leave the seed serving.
func TestSeedSurvivesFailedFetch(t *testing.T) {
	mode := "err"
	c := newTestCollector(func(context.Context) ([]byte, error) {
		if mode == "bad" {
			return []byte("not json"), nil
		}
		return nil, errors.New("gh offline")
	})
	c.Seed(map[string]PRStatus{"seeded": {Number: 1, URL: "seeded"}}, nil)

	c.refresh(context.Background()) // gh error
	mode = "bad"
	c.refresh(context.Background()) // malformed JSON
	c.available = func(context.Context) bool { return false }
	c.refresh(context.Background()) // gh unavailable

	if _, ok := c.Snapshot()["seeded"]; !ok {
		t.Errorf("seed must survive every failed fetch: %v", c.Snapshot())
	}
}

// TestRefreshHookFiresOnlyOnSuccess: the disk-cache write seam rides successful
// passes only (a failed pass has nothing new to persist), and a nil hook — every
// unwired collector — is a no-op.
func TestRefreshHookFiresOnlyOnSuccess(t *testing.T) {
	mode := "ok"
	c := newTestCollector(func(context.Context) ([]byte, error) {
		switch mode {
		case "err":
			return nil, errors.New("network blip")
		case "bad":
			return []byte("not json"), nil
		default:
			return ghJSONLogin("sahil87", ghHeadFixture(1, "u1", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
		}
	})

	c.refresh(context.Background()) // nil hook must not panic

	calls := 0
	c.SetRefreshHook(func() { calls++ })
	c.refresh(context.Background()) // ok → 1
	mode = "err"
	c.refresh(context.Background())
	mode = "bad"
	c.refresh(context.Background())
	mode = "ok"
	c.available = func(context.Context) bool { return false }
	c.refresh(context.Background())

	if calls != 1 {
		t.Errorf("refresh hook fired %d times, want 1 (successful passes only)", calls)
	}
}

// TestRefreshHookSeesTheNewState: the hook runs at the TAIL of the pass, so the
// state it persists is the pass's own — never the previous generation's.
func TestRefreshHookSeesTheNewState(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSONLogin("sahil87", ghHeadFixture(7, "u7", "OPEN", "o/r", "feat", "2026-08-01T00:00:00Z")), nil
	})
	var login string
	var prs int
	c.SetRefreshHook(func() {
		login = c.Login()
		prs = len(c.Snapshot())
	})
	c.refresh(context.Background())
	if login != "sahil87" || prs != 1 {
		t.Errorf("hook observed login=%q prs=%d, want sahil87/1", login, prs)
	}
}

func TestSnapshotIsCopy(t *testing.T) {
	c := newTestCollector(func(context.Context) ([]byte, error) {
		return ghJSON(ghFixture(1, "u1", "OPEN", false, "SUCCESS", "")), nil
	})
	c.refresh(context.Background())
	snap := c.Snapshot()
	delete(snap, "u1") // mutate the copy
	if _, ok := c.Snapshot()["u1"]; !ok {
		t.Error("mutating the snapshot must not affect the collector's map")
	}
}

func TestViewerPRHeadRefOidFlowsIntoIndex(t *testing.T) {
	node := `{"number":7,"url":"https://github.com/o/r/pull/7","state":"MERGED","isDraft":false,"reviewDecision":"","updatedAt":"2026-08-01T00:00:00Z","headRefName":"feat","headRefOid":"abc123","headRepository":{"nameWithOwner":"o/r"},"commits":{"nodes":[]}}`
	batch, err := parseBatch(ghJSON(node))
	if err != nil {
		t.Fatalf("parseBatch: %v", err)
	}
	prs := viewerPRsFrom(batch.PRs)
	if len(prs) != 1 || prs[0].HeadOid != "abc123" {
		t.Fatalf("ViewerPR head oid = %+v, want abc123", prs)
	}
	r := NewBranchRefresher(time.Hour)
	r.StoreViewerIndex(prs)
	r.mu.RLock()
	candidates := r.viewerIndex[viewerIndexKey("github.com/o/r", "feat")]
	r.mu.RUnlock()
	if len(candidates) != 1 || candidates[0].HeadRefOid != "abc123" {
		t.Fatalf("index candidates = %+v, want headRefOid abc123", candidates)
	}
	if !strings.Contains(ghQuery, "headRefOid") {
		t.Error("GraphQL query must select headRefOid")
	}
}
