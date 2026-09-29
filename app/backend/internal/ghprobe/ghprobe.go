// Package ghprobe answers one question — is the `gh` CLI installed AND
// authenticated — for every package that needs it before spending a
// subprocess. It is the single source of that probe, shared by the PR-status
// collector (internal/prstatus) and the PR-review detail fetcher
// (internal/prreview), so the two can never drift on what "gh is unavailable"
// means.
//
// Stdlib-only by design: both importers sit at the same layer, so this package
// must pull in no rk/internal package.
package ghprobe

import (
	"context"
	"os/exec"
	"sync"
	"time"
)

// How long an answer is trusted. The asymmetry is the whole point: "gh works"
// is a fact that changes about once a month, while "gh is broken" is a fact the
// user is actively fixing — logging in, installing the binary — and making them
// wait five minutes to see their own fix take effect would be its own bug.
//
// Memoizing at all is a latency fix with a correctness dividend. `gh auth
// status` is a NETWORK call: measured at 0.34-0.39 s across ten consecutive
// runs, which the review fetcher paid on every cold document, and twice in one
// burst at 30 s. The caller's timeout is 10 s, so that second shape turns a
// working tile into "gh is unavailable" — a failure caused entirely by asking a
// question whose answer we already had.
const (
	positiveTTL = 5 * time.Minute
	negativeTTL = 30 * time.Second
)

var (
	mu       sync.Mutex
	memoAt   time.Time
	memoOK   bool
	memoHeld bool
	// now is a seam so the TTLs are testable without sleeping.
	now = time.Now
)

// Available reports whether gh is installed and logged in. Either failing is a
// silent no-op for every caller (the `command -v rk` fail-silent posture), so
// this returns a plain bool rather than distinguishing the two.
//
// `timeout` bounds the auth check; the caller supplies its own gh budget
// because the two collectors run on very different cadences. It applies only to
// a real probe — a memoized answer returns without spending one.
func Available(ctx context.Context, timeout time.Duration) bool {
	// LookPath stays OUTSIDE the memo. It is a filesystem check costing
	// microseconds, and caching it would mean a gh installed mid-session stays
	// invisible for the rest of the TTL.
	if _, err := exec.LookPath("gh"); err != nil {
		return false
	}

	// The lock is held across the subprocess on purpose: it makes the probe
	// single-flight, so a burst of callers costs one `gh auth status` and the
	// rest read the answer it writes. The wait is bounded by `timeout`.
	mu.Lock()
	defer mu.Unlock()
	if fresh := ttlFor(memoOK); memoHeld && now().Sub(memoAt) < fresh {
		return memoOK
	}
	// `gh auth status` exits non-zero when not logged in.
	authCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ok := exec.CommandContext(authCtx, "gh", "auth", "status").Run() == nil
	memoAt, memoOK, memoHeld = now(), ok, true
	return ok
}

func ttlFor(ok bool) time.Duration {
	if ok {
		return positiveTTL
	}
	return negativeTTL
}

// Reset drops the memoized answer. For tests, and for any caller that has just
// changed gh's auth state and wants the next probe to be real.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	memoHeld, memoOK, memoAt = false, false, time.Time{}
}
