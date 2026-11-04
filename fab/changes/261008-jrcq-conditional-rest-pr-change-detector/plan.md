# Plan: Conditional-REST PR Change Detector

**Change**: 261008-jrcq-conditional-rest-pr-change-detector
**Intake**: `intake.md`

## Requirements

### PR Status: Conditional-REST Change Detector

#### R1: Tracked input set — live OPEN PRs only

The detector SHALL poll only the PRs that live windows currently resolve to. The input source SHALL be a callback (wired in `api/router.go`, mirroring the thread digest's `SetLivePRSource`) that derives URLs from `prstatus.DefaultBranchRefresher.PositiveEntries()`, filtered to OPEN PRs — state taken from `BranchPR.State`, overridden by the `Collector.Snapshot()` entry's `State` when the URL is present in the collector snapshot. An idle dashboard SHALL poll nothing. The detector SHALL evict ETag/head-SHA state for PR URLs no longer in the source set at the start of each pass (bounded memory; no eviction timer).

- **GIVEN** a daemon with no live windows resolving to PRs
- **WHEN** a detector pass runs
- **THEN** no HTTP request is issued
- **AND** when a previously tracked URL leaves the source set, its ETag state is evicted at the start of the next pass

#### R2: Conditional requests with a fixed header set

Per tracked OPEN PR, each pass SHALL issue conditional GETs for: `GET {api}/repos/{owner}/{repo}/pulls/{n}`, `GET {api}/repos/{owner}/{repo}/commits/{head_sha}/check-runs?per_page=100`, `GET {api}/repos/{owner}/{repo}/commits/{head_sha}/status`, and `GET {api}/repos/{owner}/{repo}/pulls/{n}/reviews?per_page=100` — URL identity parsed from the canonical PR URL `<scheme>://<host>/<owner>/<repo>/pull/<n>`. Every request SHALL send `If-None-Match: <stored etag>` when an ETag is stored for that exact request URL, and SHALL use one fixed header set from one `http.Client`: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer <token>`, `User-Agent` (package constants — the replayed ETag is only valid for the header set that obtained it). On a PR-endpoint 200 the detector SHALL record `head.sha` and the `comments`/`review_comments` counts from the body; the CI endpoints use the most recently recorded `head.sha` and are skipped when none is known.

- **GIVEN** a tracked PR with a stored ETag for its pulls endpoint
- **WHEN** the next pass polls that endpoint
- **THEN** the request carries `If-None-Match` equal to the stored ETag plus the fixed `Accept` / `X-GitHub-Api-Version` / `Authorization` / `User-Agent` headers
- **AND** the check-runs and status URLs are built from the last recorded `head.sha`, so a new SHA starts a fresh baseline for its CI endpoints

#### R3: Response handling table

Per request the detector SHALL handle responses exactly as follows: `304 Not Modified` → no action; `200 OK` with no prior ETag (first sight, including after a daemon restart) → store the ETag (+ `head.sha` and comment counts for the PR endpoint) and do NOT trigger a refresh (baseline only — the existing pollers already fetched this PR); `200 OK` with a differing prior ETag → store the new ETag and mark the PR changed for this pass, recording which endpoint flipped; `200 OK` with an identical ETag → treat as unchanged; `404 Not Found` → drop the PR's ETags and skip it until it re-enters the set fresh (never infer merged/closed from a 404); `401 Unauthorized` → invalidate the cached token for that host and re-read it once via `tokenFn`; if the retry still 401s, stand down for that host until the next pass; `403`/`429` with `Retry-After`, or with `X-RateLimit-Remaining: 0`, → back off the whole host until `Retry-After` seconds elapse or `X-RateLimit-Reset` (epoch seconds), whichever the response carries, else a fixed backoff doubling to a cap — logged once per backoff entry (slog), never per request; `403` without rate-limit signals → treat like `404` for that PR; network error / `5xx` / timeout → keep the stored ETag and do not trigger (stale-while-revalidate).

- **GIVEN** a tracked PR polled for the first time in this process
- **WHEN** every endpoint returns `200 OK` with fresh ETags
- **THEN** the ETags are stored as baselines and `onChange` is NOT invoked
- **AND** a later pass whose PR endpoint returns `200` with a different ETag marks that PR changed

#### R4: Host-derived API base and per-host cached token

The API base URL SHALL follow the PR's host (parsed from the PR URL, port dropped, lowercased): `github.com` → `https://api.github.com`; any other host (GHES) → `https://<host>/api/v3`. The base SHALL be a seam (`apiBase` field, default `apiBaseFor(host)`) so tests point it at an `httptest.Server`, mirroring `defaultAPIBase` in `internal/codeserver/release.go` and `internal/desktop/desktop.go`. The token SHALL come from `exec.CommandContext(ctx, "gh", "auth", "token")` for `github.com` and `exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", host)` for any other host — explicit argv slice under a `ghTimeout` (10 s) context (Constitution I + Process Execution). The host string SHALL be validated (non-empty, hostname-shaped, no leading `-`) before reaching argv. Tokens SHALL be cached in memory only, per host, with a 5-minute TTL (the same "gh works" TTL `internal/ghprobe` uses), invalidated immediately on a 401; never logged, never written to disk, never in an error string. Token retrieval SHALL be gated on the memoized `ghprobe.Available(ctx, ghTimeout)` — gh absent/unauthenticated is a silent no-op. A `tokenFn func(ctx context.Context, host string) (string, error)` field SHALL be the test seam.

- **GIVEN** a tracked PR URL on host `ghe.corp`
- **WHEN** the detector polls it
- **THEN** requests go to `https://ghe.corp/api/v3/...` and the token source is invoked with host `ghe.corp` (default: `gh auth token --hostname ghe.corp`)
- **AND** a cached token younger than the TTL is reused without a subprocess

#### R5: Coalesced onChange chain with refresh-rate guard and budget logging

The detector SHALL never write PR state itself — it only decides when to re-derive. At the end of a pass in which any PR changed, it SHALL invoke an injected `onChange func(ctx context.Context, changed []DetectedChange)` callback ONCE for the whole pass (N flips ⇒ one call). `DetectedChange` SHALL carry the PR URL and which endpoints flipped (`PR`, `Checks`, `Reviews`) plus whether the PR flip included a `comments`/`review_comments` count change. A minimum interval `prChangeRefreshMinInterval = 10 * time.Second` SHALL bound detector-triggered refreshes: a flip arriving inside the window is deferred to the next pass, never dropped (the changed set is carried forward and merged). The detector SHALL log (slog) `X-RateLimit-Remaining` once per pass that saw a 200, mirroring the thread digest's GraphQL cost logging.

- **GIVEN** two tracked PRs whose endpoints flip in the same pass
- **WHEN** the pass completes
- **THEN** `onChange` is invoked exactly once with both changes
- **AND** a further flip within `prChangeRefreshMinInterval` of the last trigger is carried forward and delivered on the next pass instead of dropped

#### R6: Execution discipline

Passes SHALL be single-flighted via a `passMu`/`TryLock` (a pass starting while the previous one runs is skipped, mirroring `Collector.refreshMu`'s intent without blocking the tick goroutine). Requests in one pass SHALL run sequentially. Every request SHALL run under a per-request `context.WithTimeout(ctx, ghTimeout)` on an `http.Client` with its own `Timeout`. The client SHALL NOT forward credentials across hosts: `CheckRedirect` refuses redirects, so an `Authorization` header can never reach a host other than the derived API host. The detector SHALL run on a tick-driven `time.Ticker` with an immediate first pass (which establishes baselines), exiting on `ctx` cancellation — the same lifecycle as `Collector.Start`.

- **GIVEN** a pass still in flight when the next tick fires
- **WHEN** the tick handler runs
- **THEN** the overlapping pass is skipped
- **AND** a response that is a cross-host redirect is never followed with the `Authorization` header

#### R7: BranchRefresher.RefreshURLs — targeted branch re-resolve

`BranchRefresher` SHALL gain a `RefreshURLs(ctx, urls []string)` method that re-resolves ONLY the registered pairs whose current entry's `PR.URL` is in the given set, under the same `refreshMu` and with the same per-pair resolution order/rules as `refresh` (default-branch exclusion → viewer head-index join → `gh pr list` fallback). An empty/nil set SHALL be a no-op. The full-tick-only work (pair age-out, per-repo verdict pruning) SHALL NOT run on the targeted path.

- **GIVEN** three registered pairs whose entries point at PR URLs A, B, C
- **WHEN** `RefreshURLs(ctx, [B])` is invoked
- **THEN** only the pair whose entry URL is B is re-resolved (the exclusion/index/fallback chain runs for it alone)
- **AND** pairs pointing at A and C cost no subprocess

#### R8: Wiring and unchanged surface

`api/sse.go` SHALL gain `prChangeDetectInterval = 15 * time.Second` next to `prStatusPollInterval` (cadence constants live together). `api/router.go` `NewRouterAndServer` SHALL construct and start the detector after `pc.Start(ctx)` / `pc.StartThreads(...)` / `DefaultBranchRefresher.Start(ctx)`: source = PositiveEntries → OPEN PR URLs (collector state wins on URL hit); onChange = `pc.RefreshNow(ctx)` → `DefaultBranchRefresher.RefreshURLs(ctx, urlsOf(changed))` → `pc.RefreshThreadsNow(ctx)` only when a PR flip changed comment counts or the Reviews endpoint flipped → wake every server the SSE hub is polling. The SSE hub SHALL gain a small `wakeAll` method that calls the existing per-server `wake(server)` for every server it is polling; the Server-side caller SHALL nil-guard the lazily created hub (race-safe read of the `sseOnce`-initialized pointer) rather than creating the hub just to wake it. `NewTestRouter` SHALL leave the detector unwired. The 90 s collector poll, 30 s branch refresher, and 3 min thread digest SHALL stay unchanged (reconciliation safety net). There SHALL be no new on-disk state, no new route, no new settings key, no frontend change, no SSE event shape change.

- **GIVEN** a running daemon with a connected SSE client and a tracked PR
- **WHEN** the detector observes a flip and the refresh chain completes
- **THEN** every server the hub polls is woken via the existing coalescing `wake` seam, so clients see the new snapshot without waiting out the ≤ 12 s safety tick
- **AND** a daemon with no SSE client ever connected performs the refreshes without creating the hub

### Non-Goals

- Relaxing or removing the existing 90 s / 30 s / 3 min pollers — they stay as the reconciliation safety net; cadence changes are a later change.
- Webhooks, GitHub App webhooks, `gh webhook forward` — rejected at intake (public URL per install / central relay / one forwarder per repo).
- Projected-body comparison to decide "changed" — the raw ETag difference is the signal (intake assumption 23, user-confirmed).
- Review-thread resolution detection — `isResolved` is GraphQL-only state; it stays on the 3-min digest.

### Design Decisions

#### Conditional REST as a change detector in front of the GraphQL pollers

**Decision**: Poll the four REST endpoints conditionally (ETag / `If-None-Match`) at 15 s; a `304` is free against the primary rate limit, and only a real change (a `200` with a new ETag) triggers the existing GraphQL refresh chain.
**Why**: PR events currently surface up to 90 s (status) / 3 min (threads) late; GraphQL has no conditional requests and its point pricing already exhausted an account once when over-fetched.
**Rejected**: Webhooks / GitHub App webhooks (public URL per install, deliveries lost while the daemon is down) and `gh webhook forward` (one forwarder per repo, development tool).
*Introduced by*: 261008-jrcq-conditional-rest-pr-change-detector

#### In-process `net/http` over `gh api` subprocesses

**Decision**: The conditional calls run in-process with Go's stdlib `net/http`; the only subprocess is one cached `gh auth token` per host.
**Why**: At 20 tracked PRs the 15 s cadence would spawn ~160 `gh` processes per minute; the token is the only thing `gh` is needed for, and `gh auth token` already honors `GH_TOKEN`/`GITHUB_TOKEN` and the active account (Constitution III).
**Rejected**: `gh api --include` per endpoint (subprocess volume); embedding token resolution (reinvents gh's auth chain).
*Introduced by*: 261008-jrcq-conditional-rest-pr-change-detector

#### First-sight 200 is a baseline, never a trigger

**Decision**: A `200` for a URL with no stored ETag (first sight in this process, including right after a restart) stores the ETag and does not invoke `onChange`.
**Why**: The existing pollers already fetched the PR's state; triggering on first sight would turn every daemon restart or new window into a refresh storm.
**Rejected**: Triggering on every 200 (defeats the rate guard's purpose at exactly the highest-churn moments).
*Introduced by*: 261008-jrcq-conditional-rest-pr-change-detector

## Tasks

### Phase 1: Core Detector

- [x] T001 Create `app/backend/internal/prstatus/prstatus_detect.go`: `Detector` type (watches map, per-host token cache, per-host backoff, pending-change carry-forward, seams: `apiBase`, `tokenFn`, `available`, `now`, `minInterval`), `DetectedChange`, `NewDetector(interval)`, `SetSource`, `SetOnChange`, `Start` (ticker + immediate baseline pass, ctx-cancel exit), single-flight pass via `passMu.TryLock`, source-set eviction at pass start, `apiBaseFor(host)` (github.com → `https://api.github.com`, else `https://<host>/api/v3`), PR-URL parsing, host validation, and the default `tokenFn` (`gh auth token` / `--hostname`, argv slice + `ghTimeout` ctx, `ghprobe.Available` gate, 5-min per-host TTL cache, 401 invalidation) <!-- R1, R4, R6 -->
- [x] T002 In `prstatus_detect.go`, implement the per-PR request engine: fixed-header conditional GETs for the four endpoints (PR → check-runs/status from recorded `head.sha` → reviews), the full R3 response-handling table (304 / first-sight baseline / flip / same-ETag 200 / 404 / 401 retry-once-then-stand-down / 403-429 host backoff honoring `Retry-After` + `X-RateLimit-Reset` with fixed-doubling fallback / plain-403-as-404 / transient keep-ETag), comment-count delta capture, redirect refusal on the shared `http.Client`, per-request `ghTimeout` context, and per-pass `X-RateLimit-Remaining` budget logging <!-- R2, R3, R5, R6 -->
- [x] T003 In `prstatus_detect.go`, implement pass-end change delivery: accumulate `DetectedChange`s per pass, invoke `onChange` once per pass (coalesced), enforce `prChangeRefreshMinInterval = 10 * time.Second` with deferred-never-dropped carry-forward of the changed set <!-- R5 -->

### Phase 2: BranchRefresher + Wiring

- [x] T004 Add `BranchRefresher.RefreshURLs(ctx, urls []string)` in `app/backend/internal/prstatus/prstatus_branch.go` — factor `refresh`'s pair loop so the targeted variant re-resolves only registered pairs whose current entry's `PR.URL` is in the set, under `refreshMu`, with the same exclusion → index-join → `gh pr list` fallback order; full-tick-only work (age-out, per-repo pruning) stays on the tick path; empty set is a no-op <!-- R7 -->
- [x] T005 Wire the detector in `app/backend/api/router.go` `NewRouterAndServer` (construct after the existing poller starts, source = PositiveEntries → OPEN-only URLs with collector-state override, onChange = `pc.RefreshNow` → `DefaultBranchRefresher.RefreshURLs` → conditional `pc.RefreshThreadsNow` → wake-all-SSE), add `prChangeDetectInterval = 15 * time.Second` to `app/backend/api/sse.go` beside `prStatusPollInterval`, add `sseHub.wakeAll()` (iterates polled servers, calls existing `wake`, skips the metrics-only sentinel) and a nil-guarding race-safe `Server.wakeAllSSE`; `NewTestRouter` stays unwired <!-- R1, R5, R8 -->

### Phase 3: Tests & Gates

- [x] T006 Create `app/backend/internal/prstatus/prstatus_detect_test.go` against an `httptest.Server` (apiBase seam) with stub `tokenFn`/`now` and a recording `onChange`: first-sight baseline no-trigger; 304 carries `If-None-Match` + fixed headers and no onChange; ETag flip → exactly one coalesced onChange per pass; `head.sha` drives CI endpoint URLs (new SHA → fresh CI baselines); 404 drops the PR's ETags silently; 401 invalidates the token and re-calls tokenFn; 403/429 with `Retry-After` (and `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`) pauses the host (now seam, no sleeps); 5xx/network error keeps the ETag and does not trigger; leaving the source set evicts state and merged/closed PRs are not polled; GHES host builds `https://<host>/api/v3` and passes `--hostname`; `Authorization` not forwarded on cross-host redirect <!-- R2, R3, R4, R5, R6 -->
- [x] T007 Add `RefreshURLs` tests to `app/backend/internal/prstatus/prstatus_branch_test.go`: only pairs whose entry URL is in the set are re-resolved (stub `branchPRExec` / per-instance `exec` seam, record calls), empty set is a no-op <!-- R7 -->
- [x] T008 Run gates: `just test-backend` green; `cd app/backend && go vet ./...` and `go build ./...` clean <!-- R8 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The detector polls only URLs returned by its source callback, the wiring filters to OPEN PRs with collector-state override, and URLs leaving the set are evicted from detector state on the next pass
- [x] A-002 R2: Every polled endpoint request carries the fixed header set plus `If-None-Match` when an ETag is stored, and CI endpoint URLs follow the last recorded `head.sha`
- [x] A-003 R3: All nine response-handling rows behave as specified (verified by `prstatus_detect_test.go`)
- [x] A-004 R4: API base is host-derived (`api.github.com` / `https://<host>/api/v3`), tokens come from `gh auth token [--hostname host]` cached per host for 5 min behind `ghprobe.Available`, invalidated on 401, never logged or persisted
- [x] A-005 R5: One coalesced `onChange` per pass; flips inside `prChangeRefreshMinInterval` are deferred to the next pass, never dropped; `X-RateLimit-Remaining` is logged once per 200-seeing pass
- [x] A-006 R6: Overlapping passes are skipped via TryLock; requests are sequential with 10 s timeouts; redirects are refused so credentials never cross hosts
- [x] A-007 R7: `BranchRefresher.RefreshURLs` re-resolves only matching pairs under `refreshMu` with the tick's resolution order; empty set is a no-op
- [x] A-008 R8: Detector is constructed and started in `NewRouterAndServer` with the full onChange chain; `NewTestRouter` leaves it unwired; no new route/settings key/on-disk state/frontend change

### Behavioral Correctness

- [x] A-009 R3: A first-sight 200 (including after a daemon restart) stores a baseline and never triggers a refresh — no restart/new-window refresh storm
- [x] A-010 R5: A detected comment/review flip reaches `RefreshThreadsNow` (thread latency drops from ≤ 3 min toward the 15 s cadence) while a checks-only flip does not invoke it

### Scenario Coverage

- [x] A-011 R3: Each test in intake §6 exists and passes via `just test-backend` (baseline, 304 headers, coalescing, head.sha, 404, 401, backoff, transient, eviction, GHES, redirect, RefreshURLs)

### Edge Cases & Error Handling

- [x] A-012 R3: 404/plain-403 drops the PR's ETags without triggering; 401 re-reads the token once then stands the host down for the pass; 5xx/network errors keep stored ETags and trigger nothing
- [x] A-013 R5: Host-wide backoff honors `Retry-After`/`X-RateLimit-Reset`, falls back to 60 s doubling to a cap, and logs once per backoff entry

### Code Quality

- [x] A-014 Pattern consistency: Detector mirrors Collector/BranchRefresher shape (background goroutine, Start(ctx), injectable seams, single-flight, stale-while-revalidate)
- [x] A-015 No unnecessary duplication: existing seams reused (`ghTimeout`, `ghprobe.Available`, `prURLHost`, `wake`, `PositiveEntries`, `Collector.Snapshot`); no reimplemented exec/HTTP helpers
- [x] A-016 Process execution: every subprocess uses `exec.CommandContext` with timeout and argv slice; host validated before reaching argv
- [x] A-017 Comment discipline: comments state constraints only — no narration, no change IDs/PR numbers in code comments

### Security

- [x] A-018 R6: The shared `http.Client` refuses redirects, so the `Authorization` header can never reach a host other than the derived API host (test-verified)
- [x] A-019 R4: The token never appears in logs, error strings, or on disk

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `User-Agent: hexokit/dev` as a package constant — the build version lives in `cmd/rk` (package main) and is not importable from `internal/prstatus`; the UA's role is identification (GitHub rejects UA-less requests), not version reporting | Intake mandates a User-Agent package constant; no existing internal/ version seam exists to reuse | S:60 R:90 A:75 D:70 |
| 2 | Confident | Fixed host backoff starts at 60 s and doubles to a 30 min cap | Intake assumption 24 (user-confirmed) names 60 s doubling "to a cap" without naming the cap; 30 min bounds worst-case silence while staying well under the 90 s safety-net's job | S:70 R:90 A:70 D:60 |
| 3 | Confident | On a PR-endpoint transient error (5xx/network/timeout), the PR's remaining endpoints are skipped for that pass | Intake's table says keep-ETag/no-trigger; polling CI endpoints against a possibly-stored SHA after the PR resource itself failed adds requests with no actionable signal | S:45 R:90 A:70 D:60 |
| 4 | Confident | Race-safe hub nil-guard via an `atomic.Pointer[sseHub]` set inside `sseOnce.Do`, read by `Server.wakeAllSSE`; the hub is not created just to wake it | `s.sseHub` is written inside `initSSEHub`'s `sync.Once` on arbitrary goroutines; an unsynchronized read from the detector goroutine would be a data race, and the intake forbids creating the hub for this purpose | S:60 R:85 A:75 D:65 |
| 5 | Confident | `prChangeRefreshMinInterval` lives in `prstatus_detect.go` as a package constant with a per-instance `minInterval` field override for tests | Intake pins only `prChangeDetectInterval` to `api/sse.go`; the guard is detector-internal state (carry-forward set), so the constant sits with the mechanism | S:55 R:90 A:75 D:65 |
| 6 | Confident | Requests within a pass run strictly sequentially (no concurrency bound needed) | Intake allows "sequential or ≤ 4"; at 15 s cadence sequential suffices for realistic PR counts and avoids GitHub secondary-limit concurrency penalties | S:60 R:90 A:80 D:70 |
| 7 | Confident | On a 401 the detector invalidates the cached token and retries the current request once (re-calling `tokenFn`); a second 401 stands the host down for the rest of the pass | Intake's "re-read gh auth token once on the next request" — the immediate retry IS the next request; this converges faster than waiting a full pass while preserving the stand-down bound | S:50 R:85 A:65 D:55 |

7 assumptions (0 certain, 7 confident, 0 tentative).
