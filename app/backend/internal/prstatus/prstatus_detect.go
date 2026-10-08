package prstatus

// The conditional-REST change detector: a cheap change signal in front of the
// GraphQL pollers. A 304 on an authorized conditional request is free against
// GitHub's primary rate limit, so a tight cadence costs nothing while nothing
// changes; only a real change (a 200 with a new ETag) triggers the existing
// refresh chain. The detector never writes PR state itself — it decides WHEN
// to re-derive; the collector, branch refresher, and thread digest remain the
// source of truth and keep running as the reconciliation safety net.
//
// Invariants:
//   - ETag replay only works with the header set that obtained it (GitHub ties
//     ETags to request headers), so every request sends one fixed header set
//     from one http.Client.
//   - The Authorization header must never reach a host other than the derived
//     API host: the shared client refuses all redirects.
//   - All state (ETags, head SHAs, tokens, backoff deadlines, drop tombstones)
//     is in-memory only and disposable: losing it costs one baseline 200 per
//     endpoint per PR, which by rule triggers nothing.
//   - Fail-silent posture: gh absent/unauthenticated, a paused host, or a
//     transient error all degrade to "behave as if nothing changed" — the
//     timed pollers carry on untouched.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// prChangeRefreshMinInterval bounds detector-triggered refresh rounds. A CI
	// storm can flip a check-runs ETag on every check transition; this window
	// defers flips that arrive too soon after the last trigger to the next
	// pass (carried forward, never dropped), bounding the GraphQL spend the
	// detector can cause.
	prChangeRefreshMinInterval = 10 * time.Second

	// detectBackoffInitial / detectBackoffMax are the fixed host-wide backoff
	// ladder a 403/429 climbs when the response carries neither Retry-After
	// nor X-RateLimit-Reset to pause on.
	detectBackoffInitial = 60 * time.Second
	detectBackoffMax     = 30 * time.Minute

	// detectTokenTTL is how long a gh token is reused per host — the same
	// "gh works" TTL internal/ghprobe uses, so an `gh auth switch` is picked
	// up without waiting for a 401.
	detectTokenTTL = 5 * time.Minute

	// The fixed header set every request sends. GitHub rejects requests
	// without a User-Agent; the build version lives in cmd/rk (package main)
	// and is not importable from here, and the UA's job is identification,
	// not version reporting.
	detectAcceptHeader = "application/vnd.github+json"
	detectAPIVersion   = "2022-11-28"
	detectUserAgent    = "hexokit/dev"

	// detectMaxBody bounds one response-body read. The bodies are discarded
	// except for the PR endpoint's head.sha/comments fields; the read exists
	// to drain the connection for reuse without trusting the server's length.
	detectMaxBody = 4 << 20
)

// DetectedChange is one tracked PR whose conditional endpoints flipped during
// a pass. The flags record WHICH endpoint flipped so the wiring can choose
// which re-derivation to pay for.
type DetectedChange struct {
	URL string
	// PR: the pulls/{n} resource flipped (state, merge, push, draft, counts).
	PR bool
	// Checks: the check-runs or combined-status endpoint flipped (CI).
	Checks bool
	// Reviews: the pulls/{n}/reviews endpoint flipped (an approve-only review
	// may not flip the PR resource).
	Reviews bool
	// CommentsChanged reports that the PR flip included a comments/
	// review_comments count delta — with Reviews, the gate for paying for a
	// thread-digest refresh.
	CommentsChanged bool
}

// ThreadsRelevant reports whether this change warrants a thread-digest
// refresh: a comment-count delta on the PR endpoint, or any reviews flip.
func (c DetectedChange) ThreadsRelevant() bool { return c.CommentsChanged || c.Reviews }

// prWatch is the per-PR conditional state: an ETag per exact request URL (the
// CI endpoint URLs embed the head SHA, so a push naturally re-baselines them),
// the last recorded head SHA, and the comment counts a PR flip is compared
// against.
type prWatch struct {
	etags          map[string]string
	headSHA        string
	comments       int
	reviewComments int
}

// tokenEntry is a per-host cached gh token with its taken-at time. A non-nil
// err is a negatively cached acquisition failure, replayed until the TTL so a
// host gh cannot authorize costs one `gh auth token` subprocess per TTL, not
// one per tracked PR per pass.
type tokenEntry struct {
	token string
	at    time.Time
	err   error
}

// hostBackoff is a host-wide pause: requests to the host are skipped until
// `until`; `next` is the current rung of the fixed doubling ladder.
type hostBackoff struct {
	until time.Time
	next  time.Duration
}

// requestOutcome classifies one conditional GET for the response-handling
// table (see checkPR).
type requestOutcome int

const (
	outcomeUnchanged    requestOutcome = iota // 304, or a 200 replaying the stored ETag
	outcomeBaseline                           // 200 with no prior ETag — store, never trigger
	outcomeFlipped                            // 200 with a new ETag — store, mark changed
	outcomeDrop                               // 404, or 403 without rate-limit signals
	outcomeTransient                          // network error / 5xx / timeout — keep last-good
	outcomeUnauthorized                       // 401 — get() absorbs with one token re-read
	outcomeBackoff                            // 403/429 with rate-limit signals — pause the host
)

// getResult is one conditional GET's disposition plus the response facts the
// caller needs (ETag to store, body for the PR endpoint, headers for backoff
// and budget accounting).
type getResult struct {
	outcome requestOutcome
	status  int
	etag    string
	body    []byte
	header  http.Header
}

// passBudget accumulates GitHub's own rate-limit accounting over one pass so
// REST spend is logged once per pass that saw a 200, mirroring the thread
// digest's GraphQL cost logging.
type passBudget struct {
	saw200       bool
	minRemaining int
	remainingSet bool
}

func (b *passBudget) observe(res getResult) {
	if res.status != http.StatusOK {
		return
	}
	b.saw200 = true
	if v, err := strconv.Atoi(res.header.Get("X-RateLimit-Remaining")); err == nil {
		if !b.remainingSet || v < b.minRemaining {
			b.minRemaining = v
			b.remainingSet = true
		}
	}
}

// Detector polls the conditional REST endpoints of every tracked OPEN PR on a
// tight cadence and invokes onChange once per pass when anything flipped. It
// follows the Collector/BranchRefresher shape: a background goroutine started
// by Start(ctx), injectable seams for tests, and a single-flighted pass.
//
// All pass state (watches, tokens, backoffs, the pending set) is touched only
// by the pass goroutine — passMu's TryLock is the guard, which is why the
// maps are not individually mutexed. mu guards only the seams that wiring
// installs before Start.
type Detector struct {
	interval time.Duration

	passMu sync.Mutex

	mu       sync.Mutex
	source   func() []string
	onChange func(ctx context.Context, changed []DetectedChange)

	// Seams. apiBase defaults to apiBaseFor (tests point it at httptest);
	// tokenFn defaults to ghToken (tests never spawn gh); available defaults
	// to the package's shared ghprobe gate; now is the clock seam backoff
	// tests advance instead of sleeping.
	client    *http.Client
	apiBase   func(host string) string
	tokenFn   func(ctx context.Context, host string) (string, error)
	available func(ctx context.Context) bool
	now       func() time.Time
	// minInterval is the per-instance form of prChangeRefreshMinInterval so
	// tests can shrink the rate guard.
	minInterval time.Duration

	watches     map[string]*prWatch       // PR URL → conditional state
	tokens      map[string]tokenEntry     // host → cached token
	backoffs    map[string]hostBackoff    // host → pause deadline + ladder rung
	stoodDown   map[string]bool           // hosts stood down this pass (401 twice)
	dropped     map[string]bool           // tombstoned PR URLs (404/403-drop) — skipped until they leave the source set
	pending     map[string]DetectedChange // carried-forward flips (rate guard)
	lastTrigger time.Time
}

// NewDetector creates a change detector polling on the given interval. Call
// SetSource/SetOnChange, then Start.
func NewDetector(interval time.Duration) *Detector {
	return &Detector{
		interval: interval,
		client: &http.Client{
			Timeout: ghTimeout,
			// Redirects are refused outright: an Authorization header must
			// never reach a host other than the derived API host, and a 3xx
			// from GitHub's REST API is never part of the conditional flow.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		apiBase:     apiBaseFor,
		tokenFn:     ghToken,
		available:   ghAvailable,
		now:         time.Now,
		minInterval: prChangeRefreshMinInterval,
		watches:     map[string]*prWatch{},
		tokens:      map[string]tokenEntry{},
		backoffs:    map[string]hostBackoff{},
		stoodDown:   map[string]bool{},
		dropped:     map[string]bool{},
		pending:     map[string]DetectedChange{},
	}
}

// SetSource installs the callback naming the OPEN PR URLs worth polling —
// wired to the branch refresher's ObservedEntries with the collector's state
// overriding on a URL hit. Nil means the detector polls nothing.
func (d *Detector) SetSource(fn func() []string) {
	d.mu.Lock()
	d.source = fn
	d.mu.Unlock()
}

// SetOnChange installs the callback invoked once per pass when any tracked PR
// changed. It runs on the detector's goroutine, so it may block on the
// refresh chain's own single-flight locks.
func (d *Detector) SetOnChange(fn func(ctx context.Context, changed []DetectedChange)) {
	d.mu.Lock()
	d.onChange = fn
	d.mu.Unlock()
}

// Start begins the background goroutine: an immediate first pass (which
// establishes baselines and therefore triggers nothing), then a tick on the
// interval, exiting on ctx cancellation — the Collector.Start lifecycle.
func (d *Detector) Start(ctx context.Context) {
	go func() {
		d.pass(ctx)
		ticker := time.NewTicker(d.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				d.pass(ctx)
			}
		}
	}()
}

// apiBaseFor derives the REST API base from a PR's host: github.com has the
// dedicated api.github.com origin; any other host is treated as GitHub
// Enterprise Server, which serves the API under /api/v3.
func apiBaseFor(host string) string {
	if host == "github.com" {
		return "https://api.github.com"
	}
	return "https://" + host + "/api/v3"
}

// tokenArgv builds the `gh auth token` argv for a host. github.com is gh's
// default host and takes no flag; any other host is passed explicitly.
func tokenArgv(host string) []string {
	if host == "github.com" {
		return []string{"auth", "token"}
	}
	return []string{"auth", "token", "--hostname", host}
}

// ghToken is the default tokenFn: one `gh auth token` subprocess under the
// package's gh budget, explicit argv slice, no shell string (Constitution I).
// It delegates account/host selection to gh, which already honors GH_TOKEN /
// GITHUB_TOKEN and the active account. The token is never logged and never
// appears in an error string.
func ghToken(ctx context.Context, host string) (string, error) {
	tokenCtx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	cmd := exec.CommandContext(tokenCtx, "gh", tokenArgv(host)...)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", errors.New("gh auth token: empty token")
	}
	return token, nil
}

// validTokenHost gates the host string before it reaches gh's argv: non-empty,
// hostname-shaped, and never flag-like (a leading dash would make it an option
// instead of a value).
func validTokenHost(host string) bool {
	if host == "" || strings.HasPrefix(host, "-") || strings.Contains(host, "..") {
		return false
	}
	for _, r := range host {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// prIdentity is the request identity parsed from a canonical PR URL.
type prIdentity struct {
	host, owner, repo string
	number            int
}

// parsePRURL splits a canonical PR URL `<scheme>://<host>/<owner>/<repo>/pull/<n>`
// into its request identity. ok=false for anything not exactly that shape —
// such a URL can never be addressed over REST. The host is lowercased and
// port-dropped (hostnames are case-insensitive; the port is deployment detail,
// not identity).
func parsePRURL(rawURL string) (prIdentity, bool) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return prIdentity{}, false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return prIdentity{}, false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" || parts[0] == "" || parts[1] == "" {
		return prIdentity{}, false
	}
	n, err := strconv.Atoi(parts[3])
	if err != nil || n <= 0 {
		return prIdentity{}, false
	}
	return prIdentity{host: host, owner: parts[0], repo: parts[1], number: n}, true
}

// The four conditional endpoints, built from one identity. The CI endpoints
// embed the head SHA, so a push re-baselines them without eviction logic
// (the old SHA's entries are dropped explicitly when the SHA changes).
func prURLFor(base string, id prIdentity) string {
	return fmt.Sprintf("%s/repos/%s/%s/pulls/%d", base, id.owner, id.repo, id.number)
}
func checkRunsURLFor(base string, id prIdentity, sha string) string {
	return fmt.Sprintf("%s/repos/%s/%s/commits/%s/check-runs?per_page=100", base, id.owner, id.repo, sha)
}
func statusURLFor(base string, id prIdentity, sha string) string {
	return fmt.Sprintf("%s/repos/%s/%s/commits/%s/status", base, id.owner, id.repo, sha)
}
func reviewsURLFor(base string, id prIdentity) string {
	return fmt.Sprintf("%s/repos/%s/%s/pulls/%d/reviews?per_page=100", base, id.owner, id.repo, id.number)
}

// pass runs one detector pass: evict state for PRs that left the source set,
// poll every tracked PR sequentially, then deliver one coalesced onChange if
// the rate guard allows (else carry the changed set forward to the next pass).
// Single-flighted: a tick landing while a pass is still running is skipped —
// the pass holds passMu across its onChange call, so a slow refresh chain
// costs at most one skipped tick.
func (d *Detector) pass(ctx context.Context) {
	if !d.passMu.TryLock() {
		return
	}
	defer d.passMu.Unlock()

	d.mu.Lock()
	source := d.source
	onChange := d.onChange
	d.stoodDown = map[string]bool{}
	d.mu.Unlock()
	if source == nil {
		return
	}

	// Dedupe and parse the source set. An unparseable URL is skipped silently:
	// it can never be addressed over REST.
	live := make(map[string]prIdentity)
	var order []string
	for _, u := range source() {
		if u == "" {
			continue
		}
		if _, seen := live[u]; seen {
			continue
		}
		id, ok := parsePRURL(u)
		if !ok {
			continue
		}
		live[u] = id
		order = append(order, u)
	}

	// Evict state for PRs (and whole hosts) no longer tracked, so the maps
	// stay bounded by the live set with no eviction timer.
	liveHosts := make(map[string]bool, len(live))
	for _, id := range live {
		liveHosts[id.host] = true
	}
	for u := range d.watches {
		if _, ok := live[u]; !ok {
			delete(d.watches, u)
		}
	}
	for h := range d.tokens {
		if !liveHosts[h] {
			delete(d.tokens, h)
		}
	}
	for h := range d.backoffs {
		if !liveHosts[h] {
			delete(d.backoffs, h)
		}
	}
	// A tombstone outlives the drop but not the source membership: a dropped
	// URL still in the source stays skipped (its 404 would otherwise repeat
	// every pass), while one that departed and later re-enters baselines fresh.
	for u := range d.dropped {
		if _, ok := live[u]; !ok {
			delete(d.dropped, u)
		}
	}

	budget := &passBudget{}
	for _, u := range order {
		id := live[u]
		if d.dropped[u] || d.hostPaused(id.host) || d.stoodDown[id.host] {
			continue
		}
		if change, flipped := d.checkPR(ctx, u, id, budget); flipped {
			d.pendingChange(change)
		}
	}
	if budget.saw200 {
		slog.Debug("pr change detector pass", "prs", len(order), "rateLimitRemaining", budget.minRemaining)
	}

	// Rate guard: deliver only when the minimum interval since the last
	// trigger has elapsed; a flip inside the window stays in pending and is
	// delivered by a later pass — deferred, never dropped.
	if len(d.pending) == 0 || onChange == nil {
		return
	}
	if !d.lastTrigger.IsZero() && d.now().Sub(d.lastTrigger) < d.minInterval {
		return
	}
	deliver := make([]DetectedChange, 0, len(d.pending))
	for _, ch := range d.pending {
		deliver = append(deliver, ch)
	}
	sort.Slice(deliver, func(i, j int) bool { return deliver[i].URL < deliver[j].URL })
	d.pending = map[string]DetectedChange{}
	d.lastTrigger = d.now()
	onChange(ctx, deliver)
}

// pendingChange merges a flip into the carried-forward set, OR-ing the
// endpoint flags so a deferred flip never loses which endpoints fired.
func (d *Detector) pendingChange(ch DetectedChange) {
	p := d.pending[ch.URL]
	p.URL = ch.URL
	p.PR = p.PR || ch.PR
	p.Checks = p.Checks || ch.Checks
	p.Reviews = p.Reviews || ch.Reviews
	p.CommentsChanged = p.CommentsChanged || ch.CommentsChanged
	d.pending[ch.URL] = p
}

// hostPaused reports whether the host is inside a rate-limit backoff window.
func (d *Detector) hostPaused(host string) bool {
	b, ok := d.backoffs[host]
	return ok && d.now().Before(b.until)
}

// standDown marks a host as unusable for the rest of the pass (a token that
// still 401s after one re-read). The set is reset at the next pass — the
// backoff ladder is for rate limits, not auth, which may recover on its own.
func (d *Detector) standDown(host string) {
	d.stoodDown[host] = true
	slog.Warn("pr change detector: token rejected twice; standing host down for this pass", "host", host)
}

// recordBackoff pauses a host after a 403/429 with rate-limit signals.
// Retry-After wins over X-RateLimit-Reset; with neither, the fixed ladder
// doubles from detectBackoffInitial to detectBackoffMax. Logged once per
// entry — the pass skips the host afterwards, so there is no per-request log.
func (d *Detector) recordBackoff(host string, hdr http.Header) {
	now := d.now()
	b := d.backoffs[host]
	var until time.Time
	signalled := false
	if secs, err := strconv.Atoi(hdr.Get("Retry-After")); err == nil && secs >= 0 {
		until = now.Add(time.Duration(secs) * time.Second)
		signalled = true
	} else if epoch, err := strconv.ParseInt(hdr.Get("X-RateLimit-Reset"), 10, 64); err == nil {
		if t := time.Unix(epoch, 0); t.After(now) {
			until = t
			signalled = true
		}
	}
	if !signalled {
		level := b.next
		if level <= 0 {
			level = detectBackoffInitial
		}
		until = now.Add(level)
		b.next = min(level*2, detectBackoffMax)
	}
	b.until = until
	d.backoffs[host] = b
	slog.Warn("pr change detector: backing off host", "host", host, "until", until.Format(time.RFC3339))
}

// token returns the cached token for host, fetching through tokenFn when
// absent or past the TTL — an acquisition failure is cached on the same TTL
// and replays its error without a subprocess. Gated on the memoized
// gh-availability probe so a gh-less or logged-out machine is a silent no-op
// rather than a per-pass subprocess. The host is validated before it can reach
// argv.
func (d *Detector) token(ctx context.Context, host string) (string, error) {
	if !validTokenHost(host) {
		return "", fmt.Errorf("prstatus detect: invalid host %q", host)
	}
	if entry, ok := d.tokens[host]; ok && d.now().Sub(entry.at) < detectTokenTTL {
		return entry.token, entry.err
	}
	if d.available != nil && !d.available(ctx) {
		return "", errors.New("gh unavailable")
	}
	token, err := d.tokenFn(ctx, host)
	// A failure is cached too (err non-nil, empty token): with several PRs on
	// one host an uncached failure would retry the subprocess per PR per pass,
	// breaking the per-host subprocess bound the TTL exists to provide.
	d.tokens[host] = tokenEntry{token: token, at: d.now(), err: err}
	if err != nil {
		return "", err
	}
	return token, nil
}

// invalidateToken drops the cached token for a host (a 401 verdict), so the
// next request re-reads it through tokenFn.
func (d *Detector) invalidateToken(host string) {
	delete(d.tokens, host)
}

// get performs one conditional GET, absorbing the 401 rule: on a 401 the
// cached token is invalidated and the request retried ONCE (the retry re-reads
// the token through tokenFn); a second 401 stands the host down for the rest
// of the pass and still reports outcomeUnauthorized so the caller stops
// spending requests on it.
func (d *Detector) get(ctx context.Context, host, reqURL, etag string) getResult {
	res := d.conditionalGet(ctx, host, reqURL, etag)
	if res.outcome != outcomeUnauthorized {
		return res
	}
	d.invalidateToken(host)
	res = d.conditionalGet(ctx, host, reqURL, etag)
	if res.outcome == outcomeUnauthorized {
		d.standDown(host)
	}
	return res
}

// conditionalGet issues one conditional GET with the fixed header set. The
// per-request context carries the package's gh budget and the client has its
// own Timeout, so a hung GitHub can never stall the pass.
func (d *Detector) conditionalGet(ctx context.Context, host, reqURL, etag string) getResult {
	token, err := d.token(ctx, host)
	if err != nil {
		return getResult{outcome: outcomeTransient}
	}
	reqCtx, cancel := context.WithTimeout(ctx, ghTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, reqURL, nil)
	if err != nil {
		return getResult{outcome: outcomeTransient}
	}
	req.Header.Set("Accept", detectAcceptHeader)
	req.Header.Set("X-GitHub-Api-Version", detectAPIVersion)
	req.Header.Set("User-Agent", detectUserAgent)
	req.Header.Set("Authorization", "Bearer "+token)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := d.client.Do(req)
	if err != nil {
		return getResult{outcome: outcomeTransient}
	}
	defer resp.Body.Close()
	res := getResult{status: resp.StatusCode, header: resp.Header}

	switch {
	case resp.StatusCode == http.StatusNotModified:
		res.outcome = outcomeUnchanged
		res.etag = etag
	case resp.StatusCode == http.StatusOK:
		body, err := io.ReadAll(io.LimitReader(resp.Body, detectMaxBody))
		if err != nil {
			res.outcome = outcomeTransient
			break
		}
		res.body = body
		newETag := resp.Header.Get("ETag")
		switch {
		case etag == "":
			// First sight of this URL in this process: baseline only, never a
			// trigger — the existing pollers already fetched this PR, and
			// triggering here would turn every restart into a refresh storm.
			res.outcome = outcomeBaseline
			res.etag = newETag
		case newETag != "" && newETag != etag:
			res.outcome = outcomeFlipped
			res.etag = newETag
		default:
			// The server ignored the conditional header (identical or absent
			// ETag on a 200): treat as unchanged, keep the stored ETag.
			res.outcome = outcomeUnchanged
			res.etag = etag
		}
	case resp.StatusCode == http.StatusNotFound:
		// PR deleted, repo renamed/transferred, or token lost access. Never
		// infer merged/closed — derivation stays with the GraphQL pollers.
		res.outcome = outcomeDrop
	case resp.StatusCode == http.StatusUnauthorized:
		res.outcome = outcomeUnauthorized
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		if hasRateLimitSignal(resp.Header) || resp.StatusCode == http.StatusTooManyRequests {
			res.outcome = outcomeBackoff
		} else {
			// 403 without rate-limit signals is a permission problem: drop
			// this PR like a 404.
			res.outcome = outcomeDrop
		}
	case resp.StatusCode >= 500:
		res.outcome = outcomeTransient
	default:
		res.outcome = outcomeTransient
	}
	if res.outcome == outcomeTransient || res.outcome == outcomeDrop || res.outcome == outcomeBackoff {
		// Drain for connection reuse; the body carries nothing the detector reads.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, detectMaxBody))
	}
	return res
}

// hasRateLimitSignal reports whether a 403/429 carries GitHub's rate-limit
// markers: an explicit Retry-After, or an exhausted primary budget.
func hasRateLimitSignal(hdr http.Header) bool {
	if hdr.Get("Retry-After") != "" {
		return true
	}
	return hdr.Get("X-RateLimit-Remaining") == "0"
}

// prMeta is the projection of the pulls/{n} body the detector reads: the head
// SHA (which drives the CI endpoint URLs) and the comment counts a flip is
// compared against for the thread-digest gate.
type prMeta struct {
	Head struct {
		SHA string `json:"sha"`
	} `json:"head"`
	Comments       int `json:"comments"`
	ReviewComments int `json:"review_comments"`
}

// checkPR polls one tracked PR's four endpoints in order — the PR resource,
// the two CI endpoints (from the recorded head SHA), then reviews — and
// accumulates the pass's DetectedChange. The bool reports whether anything
// flipped.
func (d *Detector) checkPR(ctx context.Context, prURL string, id prIdentity, budget *passBudget) (DetectedChange, bool) {
	change := DetectedChange{URL: prURL}
	base := d.apiBase(id.host)

	watch := d.watches[prURL]
	if watch == nil {
		watch = &prWatch{etags: map[string]string{}}
		d.watches[prURL] = watch
	}

	reqURL := prURLFor(base, id)
	res := d.get(ctx, id.host, reqURL, watch.etags[reqURL])
	budget.observe(res)
	switch res.outcome {
	case outcomeBackoff:
		d.recordBackoff(id.host, res.header)
		return change, false
	case outcomeUnauthorized, outcomeTransient:
		// Stood down, or the PR resource itself could not be read: polling CI
		// endpoints against a stored SHA adds requests with no fresh signal.
		return change, false
	case outcomeDrop:
		// Tombstone, not just eviction: the URL typically stays in the source
		// set (a stale branch mapping or lost repo access), so deleting the
		// watch alone would re-request the 404 every pass. The tombstone lifts
		// when the URL leaves the source.
		delete(d.watches, prURL)
		d.dropped[prURL] = true
		return change, false
	case outcomeBaseline, outcomeFlipped:
		var meta prMeta
		if err := json.Unmarshal(res.body, &meta); err != nil {
			// A PR body that does not parse is not a usable baseline: keep the
			// stored ETag so the next pass revalidates instead of locking in a
			// body head.sha was never read from.
			break
		}
		if res.etag != "" {
			watch.etags[reqURL] = res.etag
		}
		if meta.Head.SHA != "" && meta.Head.SHA != watch.headSHA {
			// A push: the CI endpoint URLs embed the SHA, so the old SHA's
			// ETags are dead weight — drop them; the new URLs baseline fresh.
			if watch.headSHA != "" {
				delete(watch.etags, checkRunsURLFor(base, id, watch.headSHA))
				delete(watch.etags, statusURLFor(base, id, watch.headSHA))
			}
			watch.headSHA = meta.Head.SHA
		}
		if res.outcome == outcomeFlipped {
			change.PR = true
			change.CommentsChanged = meta.Comments != watch.comments ||
				meta.ReviewComments != watch.reviewComments
		}
		watch.comments = meta.Comments
		watch.reviewComments = meta.ReviewComments
	case outcomeUnchanged:
		// Nothing to store; fall through to the CI endpoints with the recorded SHA.
	}

	if watch.headSHA != "" && !d.stoodDown[id.host] && !d.hostPaused(id.host) {
		for _, ciURL := range []string{checkRunsURLFor(base, id, watch.headSHA), statusURLFor(base, id, watch.headSHA)} {
			res := d.get(ctx, id.host, ciURL, watch.etags[ciURL])
			budget.observe(res)
			switch res.outcome {
			case outcomeFlipped:
				change.Checks = true
				fallthrough
			case outcomeBaseline:
				if res.etag != "" {
					watch.etags[ciURL] = res.etag
				}
			case outcomeDrop:
				// A CI endpoint 404 (e.g. a force-pushed-away SHA) drops only
				// that endpoint's ETag — the PR itself stays tracked.
				delete(watch.etags, ciURL)
			case outcomeBackoff:
				d.recordBackoff(id.host, res.header)
			}
			if res.outcome == outcomeBackoff || res.outcome == outcomeUnauthorized {
				break
			}
		}
	}

	if !d.stoodDown[id.host] && !d.hostPaused(id.host) {
		reqURL := reviewsURLFor(base, id)
		res := d.get(ctx, id.host, reqURL, watch.etags[reqURL])
		budget.observe(res)
		switch res.outcome {
		case outcomeFlipped:
			change.Reviews = true
			fallthrough
		case outcomeBaseline:
			if res.etag != "" {
				watch.etags[reqURL] = res.etag
			}
		case outcomeDrop:
			delete(d.watches, prURL)
			d.dropped[prURL] = true
		case outcomeBackoff:
			d.recordBackoff(id.host, res.header)
		}
	}

	return change, change.PR || change.Checks || change.Reviews
}
