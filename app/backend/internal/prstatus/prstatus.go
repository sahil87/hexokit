// Package prstatus maintains an in-memory, periodically-refreshed cache of the
// current user's open pull-request statuses, fetched in a single batched `gh`
// call. It is modeled on internal/metrics.Collector: a background goroutine
// ticks on an interval, refreshes a snapshot under a lock, and Snapshot()
// hands callers a deep copy.
//
// Design (see fab/changes/260610-596o-pr-status-sidebar):
//   - ONE batched GraphQL call (gh api graphql, viewer.pullRequests) fetches
//     every open PR authored by the user across ALL repos — O(1) in PR count.
//   - The map is REBUILT WHOLESALE each refresh. A PR that merged/closed (no
//     longer OPEN) simply drops out next cycle — this is the cleanup mechanism,
//     so there is no eviction logic or window-lifecycle hook.
//   - On a gh error (network blip) the last-good map is kept
//     (stale-while-revalidate), mirroring metrics.Collector.
//   - gh absent or unauthenticated is a silent no-op (last-good kept), matching
//     the `command -v rk` fail-silent posture used elsewhere in the codebase.
//
// Runtime state is in-memory only. Since 260809-r4vk the last-good state is ALSO
// mirrored to one droppable startup-seed file (prstatus_disk.go) so a restart
// while gh is slow/offline does not start blank; that cache is never
// authoritative and is covered by Constitution §II's $XDG_STATE_HOME/hexokit/
// carve-out. No tmux option, no database.
// All process execution uses exec.CommandContext with a timeout and an explicit
// argument slice; no shell string and no user input in argv (Constitution §I).
package prstatus

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"rk/internal/ghprobe"
)

// ghTimeout bounds the single batched gh call so a hung gh can never block the
// background goroutine (Constitution Process Execution: 30s for build-like ops,
// shorter for queries).
const ghTimeout = 10 * time.Second

// prFetchLimit caps the number of PRs requested in the batched query. A user
// with more than this many simultaneously-open PRs is far outside the target
// workflow; the cap keeps the single call bounded.
const prFetchLimit = 100

// PRStatus is the collapsed, display-ready status for one pull request.
type PRStatus struct {
	Number         int       // PR number
	URL            string    // canonical PR URL
	State          string    // open | merged | closed
	IsDraft        bool      // draft PR
	Checks         string    // pass | fail | pending | none
	ReviewDecision string    // approved | changes_requested | review_required | none
	FetchedAt      time.Time // when this status was fetched
}

// ViewerPR is one PR from the viewer-wide batched fetch, projected down to what
// the branch→PR head-index join needs: the canonical URL + number to serve, the
// state and updatedAt to rank candidates by precedence, and the head identity
// (repo `owner/name` + ref name) to key the index by.
//
// The URL is load-bearing twice over: it is what the live-status join is keyed by,
// AND it is the only HOST authority a node carries — the batched query takes no
// `--hostname`, so StoreViewerIndex parses the host out of this URL to build the
// host-qualified index key (see viewerIndexKey).
//
// It exists as an EXPORTED projection because the seed seam is wired from
// package api (router.go): the raw ghPR JSON shape stays private, and the sink
// contract carries only stable, display-agnostic fields.
type ViewerPR struct {
	Number int
	URL    string
	// State is GitHub's raw PR-state enum (OPEN | MERGED | CLOSED) — the same
	// values branchStateRank ranks, case-insensitively.
	State string
	// HeadRepo is the head repository's `owner/name` (GraphQL nameWithOwner), or
	// "" when the head repository is absent (deleted fork). It is host-qualified at
	// index time by joining it with the host parsed from URL.
	HeadRepo string
	// HeadRef is the head branch name (GraphQL headRefName).
	HeadRef string
	// UpdatedAt breaks precedence ties within a state class.
	UpdatedAt time.Time
}

// Collector holds the latest PR-status snapshot, refreshed in the background.
// The map is keyed by canonical PR URL, NOT by PR number: numbers are only
// unique per repository, and the batched query spans ALL of the viewer's repos,
// so two open PRs can share a number (e.g. repoA#18 and repoB#18) and a
// number-keyed map would let one silently clobber the other.
type Collector struct {
	mu    sync.RWMutex
	byURL map[string]PRStatus
	// threadsByURL is the PR-review thread DIGEST, rebuilt wholesale in the
	// same critical section as byURL so one snapshot always describes one
	// batch. See prstatus_threads.go.
	threadsByURL map[string][]ReviewThread
	// nodeIDByURL maps a PR URL to its GraphQL node id, rebuilt with byURL. It
	// is what lets the scoped thread query address PRs via nodes(ids:).
	nodeIDByURL map[string]string
	// livePRSource names the PRs worth a thread digest — the per-window scope
	// guard. Nil means no digest is fetched at all, which is the correct
	// posture for a process nothing has wired it into.
	livePRSource func() []string
	// threadExec / threadMu mirror ghExec / refreshMu for the scoped digest
	// pass, which is single-flighted independently of the status pass.
	threadExec func(ctx context.Context, ids []string) ([]byte, error)
	threadMu   sync.Mutex
	interval   time.Duration

	// refreshMu SERIALIZES whole refresh passes (the interval tick vs an on-demand
	// RefreshNow), so a pass's byURL swap and its viewer-PR sink call can never
	// interleave with another pass's. Without it two concurrent passes could swap in
	// A's snapshot and then publish B's index (or vice versa), leaving the branch
	// refresher joining against an index that disagrees with the snapshot SSE
	// serves. It is DISTINCT from mu: mu guards the map for the (hot, lock-free-ish)
	// Snapshot readers and is never held across a subprocess, while refreshMu is
	// held for the whole pass INCLUDING the gh call. Blocking is acceptable here
	// because both callers are background: the tick runs on the collector's own
	// goroutine, and RefreshNow is invoked from the DETACHED goroutine behind
	// POST /api/status/refresh (never inline in a handler), which additionally
	// coalesces in-flight forced refreshes of its own.
	refreshMu sync.Mutex

	// ghExec runs the batched gh query and returns its raw stdout. It is a
	// field so tests can stub gh without a real binary (matching the codebase's
	// exec-seam test pattern). nil means "not available" (silent no-op).
	ghExec func(ctx context.Context) ([]byte, error)

	// available reports whether gh is installed and authenticated. A field so
	// tests can force the guard true/false without a real gh binary. Defaults
	// to ghAvailable.
	available func(ctx context.Context) bool

	// onViewerPRs, when non-nil, receives the parsed PR nodes after a SUCCESSFUL
	// refresh parse — the seed seam that hands this ONE batched call's results to
	// the branch→PR head-index (BranchRefresher.StoreViewerIndex), wired in
	// router.go. Nil (the default, and every unwired/test collector) is a no-op.
	// It is deliberately called only on a successful parse: stale-while-revalidate
	// applies to the seed exactly as it does to byURL.
	onViewerPRs func([]ViewerPR)

	// login is the gh viewer login of the LAST SUCCESSFUL fetch ("" until one
	// lands). It keys the disk cache (prstatus_disk.go): an account switch is
	// detected by comparing it against the login the loaded cache was written
	// under. Guarded by mu.
	login string

	// viewerPRs is the last successful fetch's projected node list — the same
	// payload onViewerPRs published, retained as last-good so the disk cache can
	// be assembled from live state alone (and so a seed loaded at startup IS the
	// last-good list until a fetch replaces it). Guarded by mu.
	viewerPRs []ViewerPR

	// onRefreshed, when non-nil, is called at the TAIL of a successful refresh
	// pass — the disk-cache write seam (SeedCache.collectorRefreshed). Nil (every
	// unwired/test collector) is a no-op, so nothing about an unwired collector's
	// behavior changes. It runs on the collector's background goroutine, never on
	// the SSE hot path.
	onRefreshed func()
}

// SetLivePRSource installs the per-window scope guard: a callback naming the PR
// URLs worth a thread digest, normally the PRs live windows resolve to.
//
// Nil (the default) means NO digest is fetched. That is deliberate — a process
// that never wires this in should not be paying for threads nobody reads, which
// is precisely the bug this seam exists to prevent.
func (c *Collector) SetLivePRSource(fn func() []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.livePRSource = fn
}

// RefreshThreadsNow runs one scoped digest pass on demand. Used by the
// listener's arm path, so arming does not wait out the digest tick.
func (c *Collector) RefreshThreadsNow(ctx context.Context) { c.refreshThreads(ctx) }

// StartThreads runs the digest on its OWN, slower cadence (guard 3). A comment
// landing a minute later is fine; a stale check state is not, which is why this
// is not simply folded into Start's tick.
func (c *Collector) StartThreads(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultThreadInterval
	}
	go func() {
		c.refreshThreads(ctx)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.refreshThreads(ctx)
			}
		}
	}()
}

// SetViewerPRSink installs the viewer-PR seed sink invoked after every successful
// refresh parse. Wired in api.NewRouterAndServer to
// prstatus.DefaultBranchRefresher.StoreViewerIndex BEFORE Start, so the
// collector's immediate first refresh stores the head-index before the branch
// refresher's first pass. Passing nil clears it (back to a no-op).
func (c *Collector) SetViewerPRSink(fn func([]ViewerPR)) {
	c.mu.Lock()
	c.onViewerPRs = fn
	c.mu.Unlock()
}

// SetRefreshHook installs the callback invoked at the tail of every SUCCESSFUL
// refresh pass (the disk-cache write seam, wired by SeedCache.Attach). Passing
// nil clears it.
func (c *Collector) SetRefreshHook(fn func()) {
	c.mu.Lock()
	c.onRefreshed = fn
	c.mu.Unlock()
}

// Seed pre-fills the collector's last-good state from the disk cache
// (prstatus_disk.go), before Start. It applies each half ONLY while that half is
// still empty, so a seed can never clobber fetched state.
//
// Each PRStatus keeps its ORIGINAL FetchedAt — the flyout's "checked Xs ago" line
// must report honest staleness, and the first successful refresh stamps fresh
// times as it always has. The seed is never authoritative: the immediate first
// refresh replaces all of this wholesale, including dropping a PR the new batch
// no longer carries.
func (c *Collector) Seed(byURL map[string]PRStatus, viewerPRs []ViewerPR) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(byURL) > 0 && len(c.byURL) == 0 {
		next := make(map[string]PRStatus, len(byURL))
		for url, p := range byURL {
			next[url] = p
		}
		c.byURL = next
	}
	if len(viewerPRs) > 0 && len(c.viewerPRs) == 0 {
		c.viewerPRs = append([]ViewerPR(nil), viewerPRs...)
	}
}

// Login returns the gh viewer login of the last successful fetch, or "" when none
// has landed in this process. Read by the disk cache to key its file and to detect
// an account switch.
func (c *Collector) Login() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.login
}

// ViewerPRs returns a copy of the last successful fetch's projected node list (or
// the seeded last-good list until a fetch lands).
func (c *Collector) ViewerPRs() []ViewerPR {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.viewerPRs) == 0 {
		return nil
	}
	return append([]ViewerPR(nil), c.viewerPRs...)
}

// NewCollector creates a PR-status collector that polls on the given interval.
// Call Start to begin the background goroutine.
func NewCollector(interval time.Duration) *Collector {
	return &Collector{
		byURL:        make(map[string]PRStatus),
		threadsByURL: make(map[string][]ReviewThread),
		nodeIDByURL:  make(map[string]string),
		threadExec:   defaultThreadExec,
		interval:     interval,
		ghExec:       defaultGhExec,
		available:    ghAvailable,
	}
}

// Start begins the background polling goroutine. It exits when ctx is
// cancelled. The first refresh runs immediately so the cache is warm before the
// first tick elapses.
func (c *Collector) Start(ctx context.Context) {
	go func() {
		c.refresh(ctx)
		ticker := time.NewTicker(c.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.refresh(ctx)
			}
		}
	}()
}

// Snapshot returns a deep copy of the current PR-status map, keyed by
// canonical PR URL. Callers may read it freely without holding the lock.
func (c *Collector) Snapshot() map[string]PRStatus {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make(map[string]PRStatus, len(c.byURL))
	for k, v := range c.byURL {
		out[k] = v
	}
	return out
}

// RefreshNow triggers an on-demand refresh (used by the POST refresh endpoint).
// Best-effort: errors are swallowed (stale-while-revalidate keeps the last-good
// map), so callers never block on or surface a gh failure. It shares refresh's
// single-flight lock with the interval tick, so it waits out an in-flight pass
// rather than racing it — safe because the endpoint invokes this from a detached
// goroutine, never inline in a handler.
func (c *Collector) RefreshNow(ctx context.Context) {
	c.refresh(ctx)
}

// refresh performs ONE batched gh call and rebuilds byURL wholesale.
//
// It is SINGLE-FLIGHTED (refreshMu): a tick and an on-demand RefreshNow serialize
// instead of interleaving, so the byURL swap and the viewer-PR sink publication of
// one pass always describe the same batch.
//
// Failure modes (all leave the last-good map untouched, return without error):
//   - ghExec is nil (gh unavailable / collector not wired) → no-op
//   - gh is absent or unauthenticated → no-op (guarded by ghAvailable)
//   - the gh call errors (network blip) → stale-while-revalidate, keep last-good
//   - the JSON fails to parse → keep last-good
func (c *Collector) refresh(ctx context.Context) {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	if c.ghExec == nil {
		return
	}
	if c.available != nil && !c.available(ctx) {
		return
	}

	out, err := c.ghExec(ctx)
	if err != nil {
		// Network blip / transient gh failure: keep the last-good map
		// (stale-while-revalidate). Do not clear.
		return
	}

	batch, err := parseBatch(out)
	if err != nil {
		return
	}
	prs := batch.PRs

	next := make(map[string]PRStatus, len(prs))
	nodeIDs := make(map[string]string, len(prs))
	now := time.Now()
	for _, p := range prs {
		// URL is the map key: a node with an empty URL (malformed/partial gh
		// JSON — url unmarshals to "" without error) must be skipped, or every
		// such node would collide on the "" key and could attach a wrong
		// status downstream.
		if p.URL == "" {
			continue
		}
		nodeIDs[p.URL] = p.ID
		next[p.URL] = PRStatus{
			Number:         p.Number,
			URL:            p.URL,
			State:          mapState(p.State, p.IsDraft),
			IsDraft:        p.IsDraft,
			Checks:         mapChecks(p.rollupState()),
			ReviewDecision: mapReview(p.ReviewDecision),
			FetchedAt:      now,
		}
	}

	viewer := viewerPRsFrom(prs)

	// REPLACE wholesale: a PR absent from the new result (merged/closed/no
	// longer OPEN) is gone next cycle. This is the cleanup mechanism. The login
	// and the retained viewer list are replaced in the same critical section, so
	// a cache assembled from this state always describes ONE batch.
	c.mu.Lock()
	c.byURL = next
	c.nodeIDByURL = nodeIDs
	c.viewerPRs = viewer
	c.login = batch.Login
	sink := c.onViewerPRs
	saved := c.onRefreshed
	c.mu.Unlock()

	// Seed the branch→PR head-index from the SAME batch (successful parse only —
	// a gh error or parse failure returned above, leaving the last-good index in
	// place). Called after the swap and OUTSIDE the lock: the sink reaches into
	// another type's mutex, so holding this one across the call would couple the
	// two locks.
	if sink != nil {
		sink(viewer)
	}

	// Mirror the new last-good state to the disk cache (same reasoning: outside
	// c.mu, and only on a successful pass). Still inside refreshMu, so writes from
	// the collector side serialize with each other.
	if saved != nil {
		saved()
	}
}

// viewerPRsFrom projects parsed gh nodes onto the exported seed shape. It is a
// faithful projection — the head-identity/URL skip rules live in
// BranchRefresher.StoreViewerIndex, so there is exactly one place that decides
// what is indexable.
func viewerPRsFrom(prs []ghPR) []ViewerPR {
	out := make([]ViewerPR, 0, len(prs))
	for _, p := range prs {
		headRepo := ""
		if p.HeadRepository != nil {
			headRepo = p.HeadRepository.NameWithOwner
		}
		out = append(out, ViewerPR{
			Number:    p.Number,
			URL:       p.URL,
			State:     p.State,
			HeadRepo:  headRepo,
			HeadRef:   p.HeadRefName,
			UpdatedAt: p.UpdatedAt,
		})
	}
	return out
}

// ghAvailable is the collector's default `available` seam — the shared probe
// under this package's own gh budget (internal/ghprobe is the single source,
// so prstatus and prreview cannot drift on what "gh is unavailable" means).
func ghAvailable(ctx context.Context) bool {
	return ghprobe.Available(ctx, ghTimeout)
}

// ghQuery is the GraphQL query fetching the user's most-recently-updated PRs
// across all repos in a single call — OPEN, MERGED, and CLOSED, ordered by
// UPDATED_AT desc and capped at $limit. Including MERGED/CLOSED lets the pane
// line show a "merged"/"closed" state instead of a bare PR number after a PR
// lands. The recency ordering + $limit cap IS the eviction mechanism: a stale
// merged PR ages out of the top-$limit window and drops from the next wholesale
// rebuild, so the in-memory snapshot stays bounded without separate pruning.
// A just-merged PR is recently updated, so it sits near the top and is always
// included. statusCheckRollup.state is GitHub's pre-collapsed rollup enum
// (SUCCESS|FAILURE|PENDING|ERROR|EXPECTED) so we get the rollup for free.
//
// headRefName + headRepository.nameWithOwner + updatedAt are fetched for the
// BRANCH-DERIVATION seed (see ViewerPR / BranchRefresher.StoreViewerIndex): they
// let this ONE batched call pre-populate the (repo, branch) → PR index that the
// branch refresher would otherwise rebuild with one sequential `gh pr list` per
// observed pair. head identity is the join key; updatedAt is what lets indexed
// candidates be ranked with the same most-recently-updated-within-a-state-class
// tiebreak pickBranchPR applies to gh results. States, ordering, and $limit are
// deliberately unchanged.
//
// The PR-review thread DIGEST is deliberately NOT selected here. It used to be,
// on the reasoning that riding this call costs no extra gh SUBPROCESS — which is
// true, and irrelevant. GitHub prices GraphQL by the requests a query implies,
// and nesting comments+reactions inside reviewThreads inside 100 PRs took this
// query from 2 points to ~203; at the 90 s cadence that is ~8,120 points/hour
// against a 5,000/hour budget, so it exhausted the account in ~37 minutes and
// took the whole PR-status join down with it. Threads now have their own scoped
// query (prstatus_threads.go) over the handful of PRs actually on screen.
//
// `login` is selected on the same `viewer` node for the DISK CACHE (260809-r4vk):
// the cache records the login its state was fetched as, and an account switch is
// detected by comparing it at the next successful fetch — no extra call, since the
// query already selects on viewer.
const ghQuery = `query($limit: Int!) {
  rateLimit { cost remaining resetAt }
  viewer {
    login
    pullRequests(first: $limit, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id
        number
        url
        state
        isDraft
        reviewDecision
        updatedAt
        headRefName
        headRepository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

// defaultGhExec runs the batched GraphQL query via `gh api graphql`. Uses
// exec.CommandContext with a timeout and an explicit argument slice — no shell
// string, no user input in argv (Constitution §I).
func defaultGhExec(ctx context.Context) ([]byte, error) {
	queryCtx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	cmd := exec.CommandContext(queryCtx, "gh", "api", "graphql",
		"-f", "query="+ghQuery,
		"-F", "limit="+strconv.Itoa(prFetchLimit),
	)
	return cmd.Output()
}

// --- gh GraphQL response shapes -------------------------------------------------

type ghResponse struct {
	Data struct {
		Viewer struct {
			Login        string `json:"login"`
			PullRequests struct {
				Nodes []ghPR `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"viewer"`
	} `json:"data"`
}

type ghPR struct {
	// ID is the GraphQL node id. It is a free scalar on a node already being
	// fetched, and it is what lets the scoped thread query address exactly the
	// PRs that matter via nodes(ids:) — no per-PR repository/owner lookup, and
	// no string interpolation into a query.
	ID             string `json:"id"`
	Number         int    `json:"number"`
	URL            string `json:"url"`
	State          string `json:"state"` // OPEN | CLOSED | MERGED
	IsDraft        bool   `json:"isDraft"`
	ReviewDecision string `json:"reviewDecision"` // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
	// UpdatedAt / HeadRefName / HeadRepository serve the branch-derivation seed
	// only (ViewerPR); they are not part of the displayed PRStatus. HeadRepository
	// is a POINTER because GraphQL returns null for it when the head repo was
	// deleted (a deleted fork) — such a node carries no joinable identity and is
	// skipped at index time.
	UpdatedAt      time.Time `json:"updatedAt"`
	HeadRefName    string    `json:"headRefName"`
	HeadRepository *struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"headRepository"`
	Commits struct {
		Nodes []struct {
			Commit struct {
				StatusCheckRollup *struct {
					State string `json:"state"` // SUCCESS | FAILURE | PENDING | ERROR | EXPECTED
				} `json:"statusCheckRollup"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
	// ReviewThreads is the DIGEST half of the PR-review feature: just enough
}

type ghReviewThread struct {
	ID         string `json:"id"`
	IsResolved bool   `json:"isResolved"`
	IsOutdated bool   `json:"isOutdated"`
	Path       string `json:"path"`
	Line       *int   `json:"line"`
	Comments   struct {
		Nodes []struct {
			ID         string `json:"id"`
			DatabaseID int64  `json:"databaseId"`
			Author     *struct {
				Login string `json:"login"`
			} `json:"author"`
			Reactions struct {
				TotalCount int `json:"totalCount"`
			} `json:"reactions"`
		} `json:"nodes"`
	} `json:"comments"`
}

// rollupState extracts the latest commit's check-rollup state, or "" when the
// PR has no commit or no rollup (e.g. no CI configured).
func (p ghPR) rollupState() string {
	if len(p.Commits.Nodes) == 0 {
		return ""
	}
	r := p.Commits.Nodes[0].Commit.StatusCheckRollup
	if r == nil {
		return ""
	}
	return r.State
}

// ghBatch is one successful decode of the batched query: the viewer login the
// batch was fetched as (the disk cache's key — "" when the field is absent) plus
// its PR nodes. One decode carries both; they always describe the same fetch.
type ghBatch struct {
	Login string
	PRs   []ghPR
}

// parseBatch decodes the gh GraphQL response into the login + PR node list.
func parseBatch(out []byte) (ghBatch, error) {
	var resp ghResponse
	if err := json.Unmarshal(out, &resp); err != nil {
		return ghBatch{}, err
	}
	return ghBatch{
		Login: resp.Data.Viewer.Login,
		PRs:   resp.Data.Viewer.PullRequests.Nodes,
	}, nil
}

// --- enum collapse --------------------------------------------------------------

// mapState collapses GitHub's PR state to the display state open|merged|closed.
// The draft flag is surfaced separately via PRStatus.IsDraft; a draft PR is
// still "open". An unexpected/empty state defaults to "open".
func mapState(ghState string, _ bool) string {
	switch ghState {
	case "MERGED":
		return "merged"
	case "CLOSED":
		return "closed"
	default: // OPEN (and any unexpected value)
		return "open"
	}
}

// mapChecks collapses GitHub's statusCheckRollup state to pass|fail|pending|none.
// A failing/errored rollup dominates; a pending/expected rollup is pending;
// success is pass; an absent rollup (no CI) is none.
func mapChecks(rollupState string) string {
	switch rollupState {
	case "SUCCESS":
		return "pass"
	case "FAILURE", "ERROR":
		return "fail"
	case "PENDING", "EXPECTED":
		return "pending"
	default: // "" or unknown → no checks
		return "none"
	}
}

// mapReview collapses GitHub's reviewDecision to
// approved|changes_requested|review_required|none.
func mapReview(decision string) string {
	switch decision {
	case "APPROVED":
		return "approved"
	case "CHANGES_REQUESTED":
		return "changes_requested"
	case "REVIEW_REQUIRED":
		return "review_required"
	default: // "" or unknown → none
		return "none"
	}
}
