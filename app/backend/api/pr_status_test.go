package api

import (
	"testing"
	"time"

	"rk/internal/prstatus"
	"rk/internal/sessions"
	"rk/internal/tmux"
)

// stubSnapshotter implements PRStatusSnapshotter with a canned map.
type stubSnapshotter struct {
	snap map[string]prstatus.PRStatus
}

func (s stubSnapshotter) Snapshot() map[string]prstatus.PRStatus { return s.snap }

func intp(n int) *int       { return &n }
func strp(s string) *string { return &s }

// TestAttachPRStatusURLGate verifies the URL-only gate since 260705-dmex: the
// former FabChange (change-bound) gate is GONE, so ANY window with a non-empty
// derived PrURL that matches the snapshot is enriched — including a scratch
// (non-change-bound) window. The empty-PrURL / no-PrURL / no-match cases still
// stay empty (the URL is the join key).
func TestAttachPRStatusURLGate(t *testing.T) {
	hub := &sseHub{
		prStatus: stubSnapshotter{snap: map[string]prstatus.PRStatus{
			"u386": {Number: 386, URL: "u386", State: "open", Checks: "pass", ReviewDecision: "approved"},
			"u999": {Number: 999, URL: "u999", State: "merged", Checks: "fail"},
			// Poisoned empty key: the collector never produces one, but the
			// gate must still refuse to join an empty PrURL against it.
			"": {State: "closed"},
		}},
	}

	sess := []sessions.ProjectSession{{
		Name: "dev",
		Windows: []tmux.WindowInfo{
			// change-bound window with a matching PR → attach
			{Index: 0, FabChange: "260610-x", PrNumber: intp(386), PrURL: strp("u386")},
			// scratch window (no FabChange) WITH a matching PrURL → attach now
			// (branch-derived PR; the change gate is gone)
			{Index: 1, FabChange: "", PrNumber: intp(999), PrURL: strp("u999")},
			// window whose PR is not in the snapshot → no attach
			{Index: 2, FabChange: "260610-y", PrNumber: intp(123), PrURL: strp("u123")},
			// window with no PrURL → no attach — the join key is the URL
			{Index: 3, FabChange: "260610-z", PrNumber: intp(386), PrURL: nil},
			// window with an EMPTY PrURL → gate treats it as missing; must not
			// match an empty snapshot key
			{Index: 4, FabChange: "260610-w", PrNumber: intp(7), PrURL: strp("")},
		},
	}}

	hub.attachPRStatus(sess)
	ws := sess[0].Windows

	if ws[0].PrState != "open" || ws[0].PrChecks != "pass" || ws[0].PrReview != "approved" {
		t.Errorf("window 0 (change-bound, matched) not enriched: %+v", ws[0])
	}
	if ws[1].PrState != "merged" || ws[1].PrChecks != "fail" {
		t.Errorf("window 1 (scratch, matched) MUST be enriched now the change gate is gone: %+v", ws[1])
	}
	if ws[2].PrState != "" {
		t.Errorf("window 2 (no snapshot match) must stay empty: %+v", ws[2])
	}
	if ws[3].PrState != "" {
		t.Errorf("window 3 (no PrURL) must stay empty: %+v", ws[3])
	}
	if ws[4].PrState != "" {
		t.Errorf("window 4 (empty PrURL) must stay empty: %+v", ws[4])
	}
}

func TestAttachPRStatusSameNumberDifferentRepos(t *testing.T) {
	// Regression: two change-bound windows whose PRs share a number but live in
	// different repos must each get THEIR OWN state. The old number-keyed join
	// showed an open idea#18 as merged because shll#18 (same number) had merged.
	hub := &sseHub{
		prStatus: stubSnapshotter{snap: map[string]prstatus.PRStatus{
			"https://github.com/sahil87/idea/pull/18": {Number: 18, URL: "https://github.com/sahil87/idea/pull/18", State: "open", Checks: "pass"},
			"https://github.com/sahil87/shll/pull/18": {Number: 18, URL: "https://github.com/sahil87/shll/pull/18", State: "merged", Checks: "none"},
		}},
	}

	sess := []sessions.ProjectSession{{
		Name: "dev",
		Windows: []tmux.WindowInfo{
			{Index: 0, FabChange: "260612-a", PrNumber: intp(18), PrURL: strp("https://github.com/sahil87/idea/pull/18")},
			{Index: 1, FabChange: "260612-b", PrNumber: intp(18), PrURL: strp("https://github.com/sahil87/shll/pull/18")},
		},
	}}

	hub.attachPRStatus(sess)
	ws := sess[0].Windows

	if ws[0].PrState != "open" {
		t.Errorf("idea#18 window state = %q, want open: %+v", ws[0].PrState, ws[0])
	}
	if ws[1].PrState != "merged" {
		t.Errorf("shll#18 window state = %q, want merged: %+v", ws[1].PrState, ws[1])
	}
}

func TestAttachPRStatusNilCollectorNoop(t *testing.T) {
	hub := &sseHub{prStatus: nil}
	sess := []sessions.ProjectSession{{
		Windows: []tmux.WindowInfo{{FabChange: "x", PrNumber: intp(1), PrURL: strp("u1")}},
	}}
	hub.attachPRStatus(sess) // must not panic
	if sess[0].Windows[0].PrState != "" {
		t.Error("nil collector should attach nothing")
	}
}

func TestAttachPRStatusResetsCollectorFields(t *testing.T) {
	// A window whose PR dropped from the collector snapshot has its COLLECTOR-only
	// fields (checks/review) cleared. PrState and PrIsDraft are dual-sourced — they
	// also carry enrichWindowPR's branch fallback — so attachPRStatus preserves them
	// on a collector MISS rather than wiping them; clearing a genuinely gone PR's
	// state is the branch fallback's job on the next FetchSessions (500ms cache TTL).
	hub := &sseHub{prStatus: stubSnapshotter{snap: map[string]prstatus.PRStatus{}}}
	sess := []sessions.ProjectSession{{
		Windows: []tmux.WindowInfo{
			{FabChange: "x", PrNumber: intp(386), PrURL: strp("u386"), PrState: "closed", PrChecks: "pass", PrReview: "approved", PrIsDraft: true},
		},
	}}
	hub.attachPRStatus(sess)
	w := sess[0].Windows[0]
	if w.PrChecks != "" || w.PrReview != "" {
		t.Errorf("stale collector fields not reset: %+v", w)
	}
	// The branch-derived fallback state MUST survive a collector miss so a
	// closed PR outside the viewer's top-$limit window is not stranded to "" and
	// wrongly owned by prOwnsDot.
	if w.PrState != "closed" {
		t.Errorf("branch-derived PrState fallback must be preserved on collector miss, got %q: %+v", w.PrState, w)
	}
	// Likewise the branch-derived draft flag: the collector queries
	// `viewer { pullRequests }`, so a draft authored by anyone else is ALWAYS a
	// miss here. Wiping it would render a teammate's draft as a plain open PR.
	if !w.PrIsDraft {
		t.Errorf("branch-derived PrIsDraft fallback must be preserved on collector miss: %+v", w)
	}
}

// TestAttachPRStatusDraftFallbackNotOwnedByCollector pins the fix for the
// teammate-draft gap: the viewer-wide collector only ever returns the
// AUTHENTICATED USER'S OWN PRs, so a draft opened by someone else reaches the
// client solely through enrichWindowPR's branch-derived seed. This asserts both
// halves of the dual-source contract — a collector MISS preserves the seed, and a
// collector HIT still overrides it.
func TestAttachPRStatusDraftFallbackNotOwnedByCollector(t *testing.T) {
	hub := &sseHub{
		prStatus: stubSnapshotter{snap: map[string]prstatus.PRStatus{
			// The viewer's own PR, which the collector says is NOT a draft.
			"mine": {Number: 1, URL: "mine", State: "open", Checks: "pass", IsDraft: false},
		}},
	}
	sess := []sessions.ProjectSession{{
		Name: "dev",
		Windows: []tmux.WindowInfo{
			// Teammate's draft: branch channel seeded it, collector has no entry.
			{Index: 0, PrNumber: intp(2597), PrURL: strp("theirs"), PrState: "open", PrIsDraft: true},
			// Viewer's own PR: collector HIT wins and clears a stale seed.
			{Index: 1, PrNumber: intp(1), PrURL: strp("mine"), PrState: "open", PrIsDraft: true},
		},
	}}

	hub.attachPRStatus(sess)

	if !sess[0].Windows[0].PrIsDraft {
		t.Errorf("collector miss must preserve the branch-seeded draft flag: %+v", sess[0].Windows[0])
	}
	if sess[0].Windows[1].PrIsDraft {
		t.Errorf("collector hit must override the seed (authoritative on a hit): %+v", sess[0].Windows[1])
	}
}

// TestAttachPRStatusFetchedAt verifies PrFetchedAt is collector-join-owned like
// PrChecks/PrReview: set from the snapshot entry's FetchedAt on a
// URL-keyed hit, and reset to nil on a miss (incl. empty/nil PrURL and a
// pre-populated stale value) so a URL-miss window carries no stale timestamp.
func TestAttachPRStatusFetchedAt(t *testing.T) {
	fetched := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	stale := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	hub := &sseHub{
		prStatus: stubSnapshotter{snap: map[string]prstatus.PRStatus{
			"u386": {Number: 386, URL: "u386", State: "open", FetchedAt: fetched},
		}},
	}
	sess := []sessions.ProjectSession{{
		Name: "dev",
		Windows: []tmux.WindowInfo{
			// hit → PrFetchedAt set to the snapshot's FetchedAt
			{Index: 0, PrNumber: intp(386), PrURL: strp("u386")},
			// miss (URL not in snapshot) with a stale pre-populated value → reset nil
			{Index: 1, PrNumber: intp(123), PrURL: strp("u123"), PrFetchedAt: &stale},
			// no PrURL with a stale value → reset nil
			{Index: 2, PrURL: nil, PrFetchedAt: &stale},
		},
	}}

	hub.attachPRStatus(sess)
	ws := sess[0].Windows

	if ws[0].PrFetchedAt == nil {
		t.Fatalf("window 0 (hit) PrFetchedAt is nil, want %v", fetched)
	}
	if !ws[0].PrFetchedAt.Equal(fetched) {
		t.Errorf("window 0 PrFetchedAt = %v, want %v", *ws[0].PrFetchedAt, fetched)
	}
	if ws[1].PrFetchedAt != nil {
		t.Errorf("window 1 (miss) PrFetchedAt must reset to nil, got %v", *ws[1].PrFetchedAt)
	}
	if ws[2].PrFetchedAt != nil {
		t.Errorf("window 2 (no URL) PrFetchedAt must reset to nil, got %v", *ws[2].PrFetchedAt)
	}
}

// Note: the former POST /api/pr-status/refresh endpoint and its handler test
// (TestHandlePRStatusRefreshReturnsOK) were retired with change 260715-jykd — the
// composing POST /api/status/refresh (status_refresh.go / status_refresh_test.go)
// supersedes it. The attachPRStatus tests above are unrelated to that endpoint
// (they cover the sseHub URL-keyed join) and are retained here.
