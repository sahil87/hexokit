package prstatus

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordedRequest captures the facts a test asserts about one request the
// detector made: where it went and the fixed/conditional headers it carried.
type recordedRequest struct {
	path          string
	query         string
	ifNoneMatch   string
	authorization string
	accept        string
	apiVersion    string
	userAgent     string
}

// scriptedEndpoint is one fake-API endpoint's mutable script. status == 0
// selects the conditional logic (304 when If-None-Match matches the current
// etag, else 200 with the etag and body); any other status is served verbatim.
// ignoreConditional serves a 200 even when If-None-Match matches — a server
// that ignores the conditional header. Tests mutate fields between passes via
// fakeAPI.mutate so the handler goroutine and the test goroutine never race.
type scriptedEndpoint struct {
	etag              string
	body              string
	status            int
	ignoreConditional bool
	headers           map[string]string
}

type fakeAPI struct {
	mu       sync.Mutex
	requests []recordedRequest
	mux      *http.ServeMux
}

func newFakeAPI() (*fakeAPI, *httptest.Server) {
	f := &fakeAPI{mux: http.NewServeMux()}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.requests = append(f.requests, recordedRequest{
			path:          r.URL.Path,
			query:         r.URL.RawQuery,
			ifNoneMatch:   r.Header.Get("If-None-Match"),
			authorization: r.Header.Get("Authorization"),
			accept:        r.Header.Get("Accept"),
			apiVersion:    r.Header.Get("X-GitHub-Api-Version"),
			userAgent:     r.Header.Get("User-Agent"),
		})
		f.mu.Unlock()
		f.mux.ServeHTTP(w, r)
	}))
	return f, srv
}

func (f *fakeAPI) handle(path string, ep *scriptedEndpoint) {
	f.mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		ep := *ep
		f.mu.Unlock()
		for k, v := range ep.headers {
			w.Header().Set(k, v)
		}
		switch {
		case ep.status != 0:
			w.WriteHeader(ep.status)
			if ep.body != "" {
				_, _ = io.WriteString(w, ep.body)
			}
		case !ep.ignoreConditional && ep.etag != "" && r.Header.Get("If-None-Match") == ep.etag:
			w.WriteHeader(http.StatusNotModified)
		default:
			if ep.etag != "" {
				w.Header().Set("ETag", ep.etag)
			}
			w.Header().Set("X-RateLimit-Remaining", "4999")
			_, _ = io.WriteString(w, ep.body)
		}
	})
}

// prEndpoints holds the four endpoint scripts of one fake PR.
type prEndpoints struct {
	pr        *scriptedEndpoint
	checkRuns *scriptedEndpoint
	status    *scriptedEndpoint
	reviews   *scriptedEndpoint
}

// handlePR registers the four endpoints of one PR. The CI scripts are keyed
// by the given SHA — a test simulating a push registers the new SHA's
// endpoints itself via handleCI.
func (f *fakeAPI) handlePR(owner, repo string, number int, sha string) *prEndpoints {
	eps := &prEndpoints{
		pr: &scriptedEndpoint{
			etag: "pr-1",
			body: fmt.Sprintf(`{"head":{"sha":%q},"comments":0,"review_comments":0}`, sha),
		},
		reviews: &scriptedEndpoint{etag: "rv-1", body: `[]`},
	}
	f.handle(fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, repo, number), eps.pr)
	f.handle(fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", owner, repo, number), eps.reviews)
	eps.checkRuns, eps.status = f.handleCI(owner, repo, sha)
	return eps
}

// handleCI registers the two commit endpoints for one SHA.
func (f *fakeAPI) handleCI(owner, repo, sha string) (checkRuns, status *scriptedEndpoint) {
	checkRuns = &scriptedEndpoint{etag: "cr-1", body: `{"total_count":0,"check_runs":[]}`}
	status = &scriptedEndpoint{etag: "st-1", body: `{"state":"success","statuses":[]}`}
	f.handle(fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, repo, sha), checkRuns)
	f.handle(fmt.Sprintf("/repos/%s/%s/commits/%s/status", owner, repo, sha), status)
	return checkRuns, status
}

func (f *fakeAPI) mutate(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

func (f *fakeAPI) recorded() []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedRequest(nil), f.requests...)
}

func (f *fakeAPI) resetRequests() {
	f.mu.Lock()
	f.requests = nil
	f.mu.Unlock()
}

func (f *fakeAPI) countPath(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if strings.HasPrefix(r.path, prefix) {
			n++
		}
	}
	return n
}

// detectHarness bundles a Detector wired to a fake API with recording seams:
// the onChange calls it made, the hosts tokenFn was asked for, and a clock the
// test advances instead of sleeping. The rate guard is disabled by default
// (minInterval 0); the guard's own test sets it back.
type detectHarness struct {
	d             *Detector
	onChangeCalls [][]DetectedChange
	tokenCalls    []string
	nowTime       time.Time
}

func newDetectHarness(srv *httptest.Server) *detectHarness {
	h := &detectHarness{nowTime: time.Unix(1_700_000_000, 0)}
	d := NewDetector(15 * time.Second)
	d.apiBase = func(string) string { return srv.URL }
	d.available = func(context.Context) bool { return true }
	d.now = func() time.Time { return h.nowTime }
	d.minInterval = 0
	d.tokenFn = func(_ context.Context, host string) (string, error) {
		h.tokenCalls = append(h.tokenCalls, host)
		return "test-token", nil
	}
	d.SetOnChange(func(_ context.Context, changed []DetectedChange) {
		h.onChangeCalls = append(h.onChangeCalls, changed)
	})
	h.d = d
	return h
}

// sourceFrom installs a source reading a slice the test owns.
func (h *detectHarness) sourceFrom(urls *[]string) {
	h.d.SetSource(func() []string { return *urls })
}

func (h *detectHarness) pass() { h.d.pass(context.Background()) }

func (h *detectHarness) advance(d time.Duration) { h.nowTime = h.nowTime.Add(d) }

func TestDetectorFirstSightBaselineDoesNotTrigger(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("first-sight baseline triggered onChange %d times", len(h.onChangeCalls))
	}
	reqs := f.recorded()
	if len(reqs) != 4 {
		t.Fatalf("baseline pass made %d requests, want 4", len(reqs))
	}
	for _, r := range reqs {
		if r.ifNoneMatch != "" {
			t.Errorf("baseline request to %s carried If-None-Match %q", r.path, r.ifNoneMatch)
		}
		if r.accept != detectAcceptHeader || r.apiVersion != detectAPIVersion || r.userAgent != detectUserAgent {
			t.Errorf("request to %s missing fixed headers: accept=%q version=%q ua=%q", r.path, r.accept, r.apiVersion, r.userAgent)
		}
		if r.authorization != "Bearer test-token" {
			t.Errorf("request to %s authorization=%q", r.path, r.authorization)
		}
	}

	// Second pass: everything 304s, still no onChange, and the requests carry
	// the stored ETags plus the fixed header set.
	f.resetRequests()
	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("304 pass triggered onChange")
	}
	reqs = f.recorded()
	if len(reqs) != 4 {
		t.Fatalf("second pass made %d requests, want 4", len(reqs))
	}
	wantETag := map[string]string{
		"/repos/o/r/pulls/1":                 "pr-1",
		"/repos/o/r/commits/sha1/check-runs": "cr-1",
		"/repos/o/r/commits/sha1/status":     "st-1",
		"/repos/o/r/pulls/1/reviews":         "rv-1",
	}
	for _, r := range reqs {
		want, ok := wantETag[r.path]
		if !ok {
			t.Errorf("unexpected request to %s", r.path)
			continue
		}
		if r.ifNoneMatch != want {
			t.Errorf("request to %s If-None-Match=%q, want %q", r.path, r.ifNoneMatch, want)
		}
		if r.accept != detectAcceptHeader || r.apiVersion != detectAPIVersion {
			t.Errorf("conditional request to %s lost fixed headers", r.path)
		}
		if strings.HasSuffix(r.path, "/check-runs") && !strings.Contains(r.query, "per_page=100") {
			t.Errorf("check-runs request query=%q, want per_page=100", r.query)
		}
		if strings.HasSuffix(r.path, "/reviews") && !strings.Contains(r.query, "per_page=100") {
			t.Errorf("reviews request query=%q, want per_page=100", r.query)
		}
	}
}

func TestDetectorETagFlipCoalescesOneCallPerPass(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	pr1 := f.handlePR("o", "r", 1, "sha1")
	pr2 := f.handlePR("o", "r", 2, "sha2")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"}
	h.sourceFrom(&urls)

	h.pass() // baselines
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("baseline triggered onChange")
	}

	// Flip PR 1's resource and PR 2's reviews endpoint in the same pass.
	f.mutate(func() {
		pr1.pr.etag = "pr-2"
		pr2.reviews.etag = "rv-2"
	})
	h.pass()
	if len(h.onChangeCalls) != 1 {
		t.Fatalf("two flips produced %d onChange calls, want exactly 1", len(h.onChangeCalls))
	}
	changed := h.onChangeCalls[0]
	if len(changed) != 2 {
		t.Fatalf("coalesced call carried %d changes, want 2", len(changed))
	}
	byURL := map[string]DetectedChange{}
	for _, ch := range changed {
		byURL[ch.URL] = ch
	}
	ch1, ok := byURL["https://github.com/o/r/pull/1"]
	if !ok || !ch1.PR || ch1.Checks || ch1.Reviews {
		t.Errorf("PR 1 change = %+v, want PR-only flip", ch1)
	}
	ch2, ok := byURL["https://github.com/o/r/pull/2"]
	if !ok || ch2.PR || ch2.Checks || !ch2.Reviews {
		t.Errorf("PR 2 change = %+v, want Reviews-only flip", ch2)
	}
}

func TestDetectorHeadSHADrivesCIEndpoints(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	f.handleCI("o", "r", "sha2")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline on sha1
	if f.countPath("/repos/o/r/commits/sha1/") != 2 {
		t.Fatalf("baseline pass hit sha1 CI endpoints %d times, want 2", f.countPath("/repos/o/r/commits/sha1/"))
	}

	// A push: the PR body moves to sha2 and the PR ETag flips.
	f.mutate(func() {
		eps.pr.etag = "pr-2"
		eps.pr.body = `{"head":{"sha":"sha2"},"comments":0,"review_comments":0}`
	})
	f.resetRequests()
	h.pass()

	if len(h.onChangeCalls) != 1 {
		t.Fatalf("push produced %d onChange calls, want 1", len(h.onChangeCalls))
	}
	if ch := h.onChangeCalls[0][0]; !ch.PR {
		t.Errorf("change = %+v, want PR flip", ch)
	}
	if got := f.countPath("/repos/o/r/commits/sha1/"); got != 0 {
		t.Errorf("pass after push still hit sha1 CI endpoints %d times", got)
	}
	// The new SHA's endpoints start a fresh baseline: requested, with no
	// If-None-Match, and no trigger from their first 200.
	for _, r := range f.recorded() {
		if strings.HasPrefix(r.path, "/repos/o/r/commits/sha2/") && r.ifNoneMatch != "" {
			t.Errorf("fresh-baseline CI request to %s carried If-None-Match %q", r.path, r.ifNoneMatch)
		}
	}
	if got := f.countPath("/repos/o/r/commits/sha2/check-runs"); got != 1 {
		t.Errorf("sha2 check-runs requested %d times, want 1", got)
	}
	if got := f.countPath("/repos/o/r/commits/sha2/status"); got != 1 {
		t.Errorf("sha2 status requested %d times, want 1", got)
	}
	if ch := h.onChangeCalls[0][0]; ch.Checks {
		t.Errorf("fresh CI baselines marked Checks flip: %+v", ch)
	}
}

func TestDetector404DropsPRSilently(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline
	f.mutate(func() { eps.pr.status = http.StatusNotFound })
	f.resetRequests()
	h.pass()

	if len(h.onChangeCalls) != 0 {
		t.Fatalf("404 triggered onChange")
	}
	if _, ok := h.d.watches["https://github.com/o/r/pull/1"]; ok {
		t.Errorf("404 did not drop the PR's watch state")
	}
	if got := len(f.recorded()); got != 1 {
		t.Fatalf("404 pass made %d requests, want 1 (the CI endpoints must be skipped)", got)
	}

	// A PR that reappears is a fresh first sight: baseline, no trigger.
	f.mutate(func() { eps.pr.status = 0 })
	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("reappeared PR's fresh baseline triggered onChange")
	}
	if _, ok := h.d.watches["https://github.com/o/r/pull/1"]; !ok {
		t.Errorf("reappeared PR was not re-baselined")
	}
}

func TestDetector403WithoutRateLimitSignalDropsPR(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline
	f.mutate(func() { eps.pr.status = http.StatusForbidden })
	f.resetRequests()
	h.pass()

	if len(h.onChangeCalls) != 0 {
		t.Fatalf("plain 403 triggered onChange")
	}
	if _, ok := h.d.watches["https://github.com/o/r/pull/1"]; ok {
		t.Errorf("plain 403 did not drop the PR's watch state")
	}

	// A permission 403 is per-PR, not a host backoff: the next pass still
	// reaches the API.
	f.mutate(func() { eps.pr.status = 0 })
	f.resetRequests()
	h.pass()
	if len(f.recorded()) == 0 {
		t.Fatalf("plain 403 put the host into backoff; next pass made no requests")
	}
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("re-baselined PR after a plain 403 triggered onChange")
	}
}

func TestDetector401InvalidatesTokenAndRetriesOnce(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	f.mutate(func() { eps.pr.status = http.StatusUnauthorized })
	h.pass()

	// Pass one: initial token fetch, 401, invalidate, re-read, retry, 401
	// again → stand the host down; the CI/reviews endpoints are never reached.
	if got := len(h.tokenCalls); got != 2 {
		t.Fatalf("tokenFn called %d times in pass one, want 2 (initial + one re-read)", got)
	}
	if got := len(f.recorded()); got != 2 {
		t.Fatalf("pass one made %d requests, want 2 (PR endpoint + its retry)", got)
	}
	if got := f.countPath("/repos/o/r/commits/"); got != 0 {
		t.Errorf("stood-down host still polled CI endpoints (%d requests)", got)
	}

	// Pass two: the retried token is cached, so the first request uses it; the
	// repeat 401 invalidates and re-reads exactly once more.
	f.resetRequests()
	h.pass()
	if got := len(h.tokenCalls); got != 3 {
		t.Fatalf("tokenFn called %d times after pass two, want 3", got)
	}
	if got := len(f.recorded()); got != 2 {
		t.Fatalf("pass two made %d requests, want 2", got)
	}
}

func TestDetectorBackoffHonorsRetryAfter(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	f.mutate(func() {
		eps.pr.status = http.StatusForbidden
		eps.pr.headers = map[string]string{"Retry-After": "120"}
	})
	h.pass()
	if got := len(f.recorded()); got != 1 {
		t.Fatalf("pass one made %d requests, want 1 (host paused after the first 403)", got)
	}

	// Inside the window: no requests at all.
	f.resetRequests()
	h.advance(60 * time.Second)
	h.pass()
	if got := len(f.recorded()); got != 0 {
		t.Fatalf("host polled %d times inside the Retry-After window", got)
	}

	// Past the deadline: polling resumes.
	f.mutate(func() {
		eps.pr.status = 0
		eps.pr.headers = nil
	})
	h.advance(61 * time.Second)
	h.pass()
	if got := len(f.recorded()); got == 0 {
		t.Fatalf("host still paused after the Retry-After deadline")
	}
}

func TestDetectorBackoffHonorsRateLimitReset(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	reset := h.nowTime.Add(200 * time.Second).Unix()
	f.mutate(func() {
		eps.pr.status = http.StatusForbidden
		eps.pr.headers = map[string]string{
			"X-RateLimit-Remaining": "0",
			"X-RateLimit-Reset":     strconv.FormatInt(reset, 10),
		}
	})
	h.pass()
	if got := len(f.recorded()); got != 1 {
		t.Fatalf("pass one made %d requests, want 1", got)
	}

	f.resetRequests()
	h.advance(100 * time.Second)
	h.pass()
	if got := len(f.recorded()); got != 0 {
		t.Fatalf("host polled inside the X-RateLimit-Reset window")
	}

	f.mutate(func() {
		eps.pr.status = 0
		eps.pr.headers = nil
	})
	h.advance(101 * time.Second)
	h.pass()
	if got := len(f.recorded()); got == 0 {
		t.Fatalf("host still paused after X-RateLimit-Reset")
	}
}

func TestDetectorBackoffDoublesWithoutSignal(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	f.mutate(func() { eps.pr.status = http.StatusTooManyRequests })
	h.pass()
	if got := len(f.recorded()); got != 1 {
		t.Fatalf("pass one made %d requests, want 1", got)
	}

	// First rung: 60 s. Just past it the host is polled again and 429s once
	// more — the ladder doubles to 120 s.
	f.resetRequests()
	h.advance(61 * time.Second)
	h.pass()
	if got := len(f.recorded()); got != 1 {
		t.Fatalf("pass two made %d requests, want 1", got)
	}

	f.resetRequests()
	h.advance(61 * time.Second)
	h.pass()
	if got := len(f.recorded()); got != 0 {
		t.Fatalf("host polled inside the doubled (120 s) backoff window")
	}

	f.mutate(func() { eps.pr.status = 0 })
	h.advance(60 * time.Second)
	h.pass()
	if got := len(f.recorded()); got == 0 {
		t.Fatalf("host still paused after the doubled backoff elapsed")
	}
}

func TestDetectorTransientErrorKeepsETag(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)
	url := urls[0]

	h.pass() // baseline
	f.mutate(func() { eps.pr.status = http.StatusBadGateway })
	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("5xx triggered onChange")
	}
	watch := h.d.watches[url]
	stored := watch.etags[srv.URL+"/repos/o/r/pulls/1"]
	if stored != "pr-1" {
		t.Fatalf("5xx lost the stored ETag: %q, want %q", stored, "pr-1")
	}

	// Recovery with a real flip revalidates against the KEPT ETag.
	f.mutate(func() {
		eps.pr.status = 0
		eps.pr.etag = "pr-2"
	})
	f.resetRequests()
	h.pass()
	if len(h.onChangeCalls) != 1 {
		t.Fatalf("post-recovery flip produced %d onChange calls, want 1", len(h.onChangeCalls))
	}
	for _, r := range f.recorded() {
		if r.path == "/repos/o/r/pulls/1" && r.ifNoneMatch != "pr-1" {
			t.Errorf("recovery request If-None-Match=%q, want the kept %q", r.ifNoneMatch, "pr-1")
		}
	}
}

func TestDetectorEvictsDepartedPR(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	f.handlePR("o", "r", 1, "sha1")
	f.handlePR("o", "r", 2, "sha2")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"}
	h.sourceFrom(&urls)

	h.pass() // baselines for both
	if len(h.d.watches) != 2 {
		t.Fatalf("baseline tracked %d PRs, want 2", len(h.d.watches))
	}

	// PR 2 leaves the source set (window closed, or it merged — the wiring
	// filters non-OPEN states out before the detector sees them).
	urls = urls[:1]
	f.resetRequests()
	h.pass()
	if _, ok := h.d.watches["https://github.com/o/r/pull/2"]; ok {
		t.Errorf("departed PR was not evicted from the detector's state")
	}
	if got := f.countPath("/repos/o/r/pulls/2"); got != 0 {
		t.Errorf("departed PR still polled (%d requests)", got)
	}
	if got := f.countPath("/repos/o/r/pulls/1"); got == 0 {
		t.Errorf("remaining PR stopped being polled")
	}
}

func TestDetectorGHESHostDerivation(t *testing.T) {
	if got := apiBaseFor("github.com"); got != "https://api.github.com" {
		t.Errorf("apiBaseFor(github.com) = %q", got)
	}
	if got := apiBaseFor("ghe.corp"); got != "https://ghe.corp/api/v3" {
		t.Errorf("apiBaseFor(ghe.corp) = %q, want https://ghe.corp/api/v3", got)
	}
	if got := strings.Join(tokenArgv("github.com"), " "); got != "auth token" {
		t.Errorf("tokenArgv(github.com) = %q", got)
	}
	if got := strings.Join(tokenArgv("ghe.corp"), " "); got != "auth token --hostname ghe.corp" {
		t.Errorf("tokenArgv(ghe.corp) = %q", got)
	}

	// End to end: the host is parsed from the PR URL (port dropped, case
	// folded) and handed to the token source.
	f, srv := newFakeAPI()
	defer srv.Close()
	f.handlePR("o", "r", 7, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://GHE.Corp/o/r/pull/7"}
	h.sourceFrom(&urls)
	h.pass()
	if len(h.tokenCalls) != 1 || h.tokenCalls[0] != "ghe.corp" {
		t.Fatalf("tokenFn hosts = %v, want [ghe.corp]", h.tokenCalls)
	}
}

func TestDetectorRedirectDoesNotForwardAuthorization(t *testing.T) {
	// The redirect target: a second server on a different host:port that must
	// never see the Authorization header.
	var targetMu sync.Mutex
	var targetRequests []recordedRequest
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetMu.Lock()
		targetRequests = append(targetRequests, recordedRequest{
			path:          r.URL.Path,
			authorization: r.Header.Get("Authorization"),
		})
		targetMu.Unlock()
		_, _ = io.WriteString(w, `{}`)
	}))
	defer target.Close()

	f, srv := newFakeAPI()
	defer srv.Close()
	f.handle("/repos/o/r/pulls/1", &scriptedEndpoint{
		status:  http.StatusFound,
		headers: map[string]string{"Location": target.URL + "/repos/o/r/pulls/1"},
	})
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("redirect response triggered onChange")
	}
	targetMu.Lock()
	defer targetMu.Unlock()
	if len(targetRequests) != 0 {
		t.Fatalf("cross-host redirect was followed: %d requests reached the target", len(targetRequests))
	}
}

func TestDetectorRateGuardDefersNeverDrops(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	h.d.minInterval = prChangeRefreshMinInterval
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline — no trigger, lastTrigger stays zero

	// First flip: triggers immediately (no prior trigger).
	f.mutate(func() { eps.pr.etag = "pr-2" })
	h.pass()
	if len(h.onChangeCalls) != 1 {
		t.Fatalf("first flip produced %d onChange calls, want 1", len(h.onChangeCalls))
	}

	// Second flip inside the window: deferred. Both the PR and the reviews
	// endpoint flip, so the carried change must merge both flags.
	f.mutate(func() {
		eps.pr.etag = "pr-3"
		eps.reviews.etag = "rv-2"
	})
	h.advance(5 * time.Second)
	h.pass()
	if len(h.onChangeCalls) != 1 {
		t.Fatalf("flip inside the rate window triggered onChange (calls=%d)", len(h.onChangeCalls))
	}

	// The next pass past the window delivers the carried change even though
	// nothing new flipped.
	h.advance(6 * time.Second)
	h.pass()
	if len(h.onChangeCalls) != 2 {
		t.Fatalf("carried change never delivered (calls=%d)", len(h.onChangeCalls))
	}
	ch := h.onChangeCalls[1][0]
	if !ch.PR || !ch.Reviews {
		t.Errorf("carried change = %+v, want merged PR+Reviews flags", ch)
	}

	// And the well is dry: a quiet pass delivers nothing more.
	h.advance(11 * time.Second)
	h.pass()
	if len(h.onChangeCalls) != 2 {
		t.Fatalf("deferred change delivered twice (calls=%d)", len(h.onChangeCalls))
	}
}

func TestDetectorSameETag200IsUnchanged(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline
	// A server ignoring the conditional header answers 200 with the SAME ETag.
	f.mutate(func() { eps.pr.ignoreConditional = true })
	h.pass()
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("200 replaying the stored ETag triggered onChange")
	}
	if got := h.d.watches[urls[0]].etags[srv.URL+"/repos/o/r/pulls/1"]; got != "pr-1" {
		t.Errorf("stored ETag changed to %q on an identical-ETag 200", got)
	}
}

func TestDetectorCommentCountDeltaGatesThreadsRelevant(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	eps := f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass() // baseline (comments: 0, review_comments: 0)

	// A new comment: the PR ETag flips AND the count moved.
	f.mutate(func() {
		eps.pr.etag = "pr-2"
		eps.pr.body = `{"head":{"sha":"sha1"},"comments":1,"review_comments":0}`
	})
	h.pass()
	if len(h.onChangeCalls) != 1 {
		t.Fatalf("comment flip produced %d onChange calls, want 1", len(h.onChangeCalls))
	}
	if ch := h.onChangeCalls[0][0]; !ch.PR || !ch.CommentsChanged || !ch.ThreadsRelevant() {
		t.Errorf("comment flip = %+v, want PR+CommentsChanged, ThreadsRelevant", ch)
	}

	// A flip with unmoved counts (e.g. a draft toggle): still a PR change,
	// but not thread-relevant.
	f.mutate(func() { eps.pr.etag = "pr-3" })
	h.pass()
	if len(h.onChangeCalls) != 2 {
		t.Fatalf("second flip produced %d onChange calls, want 2", len(h.onChangeCalls))
	}
	if ch := h.onChangeCalls[1][0]; !ch.PR || ch.CommentsChanged || ch.ThreadsRelevant() {
		t.Errorf("count-stable flip = %+v, want PR without CommentsChanged", ch)
	}
}

func TestDetectorGHUnavailableIsSilent(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	h.d.available = func(context.Context) bool { return false }
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass()
	if got := len(f.recorded()); got != 0 {
		t.Fatalf("gh-unavailable pass made %d requests", got)
	}
	if len(h.tokenCalls) != 0 {
		t.Fatalf("gh-unavailable pass called tokenFn %d times", len(h.tokenCalls))
	}
	if len(h.onChangeCalls) != 0 {
		t.Fatalf("gh-unavailable pass triggered onChange")
	}
}

func TestDetectorTokenCachedPerHostWithinTTL(t *testing.T) {
	f, srv := newFakeAPI()
	defer srv.Close()
	f.handlePR("o", "r", 1, "sha1")
	h := newDetectHarness(srv)
	urls := []string{"https://github.com/o/r/pull/1"}
	h.sourceFrom(&urls)

	h.pass()
	if got := len(h.tokenCalls); got != 1 {
		t.Fatalf("first pass called tokenFn %d times, want 1", got)
	}
	h.advance(time.Minute)
	h.pass()
	if got := len(h.tokenCalls); got != 1 {
		t.Fatalf("pass inside the TTL re-fetched the token (calls=%d)", got)
	}
	h.advance(detectTokenTTL + time.Second)
	h.pass()
	if got := len(h.tokenCalls); got != 2 {
		t.Fatalf("pass past the TTL did not re-fetch (calls=%d)", got)
	}
}
