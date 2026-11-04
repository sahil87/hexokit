# Intake: Conditional-REST PR Change Detector

**Change**: 261008-jrcq-conditional-rest-pr-change-detector
**Created**: 2026-10-08

## Origin

> Near-instant PR event awareness: add a conditional-REST (ETag / `If-None-Match`) change detector that gates the existing GraphQL PR-status refresh, so merges, new review comments, submitted reviews and CI changes reach the dashboard in seconds instead of up to 90 s / 3 min.

Interaction mode: conversational design discussion with the user, then a promptless dispatch (`/fab-proceed` create-new path, `{questioning-mode} = promptless-defer`). No questions were asked during intake; every would-be question is recorded in `## Assumptions`.

Key points from the conversation (carried verbatim into Why / What Changes / Assumptions):

- The user wants near-instant awareness of GitHub PR events. Today everything is polling: the batched GraphQL collector every 90 s, the branch→PR refresher every 30 s, the review-thread digest every 3 min.
- Webhooks (repo or GitHub App) and `gh webhook forward` were considered and **rejected** (reasons under Why).
- The user chose **"option 4" — cheaper polling via conditional REST requests** acting as a change detector in front of the existing GraphQL fetch.
- Facts **verified live in-session** against `sahil87/hexokit` PR #1079:
  - `GET repos/{o}/{r}/pulls/{n}` with `If-None-Match: <etag>` returns `304 Not Modified`, and repeated 304s do NOT decrement `X-RateLimit-Remaining` (5 consecutive 304s held at 4940).
  - The ETag is tied to request headers — curl and `gh api` received **different** ETags for the same resource (their `Accept` headers differ), so an ETag must be replayed from the same client/header set that obtained it.
  - GraphQL supports no ETag/conditional requests, so the existing GraphQL fetches cannot themselves be made conditional.
- **User-approved**: the conditional calls are made **in-process with Go's `net/http`**, NOT by spawning `gh` subprocesses (avoids ~160 `gh` spawns/min at 20 tracked PRs). The token comes from one cached `gh auth token` subprocess.

## Why

**Problem.** HexoKit learns about PR events late because every PR signal is a timed poll:

| Poller | Where | Cadence | What it carries |
|--------|-------|---------|-----------------|
| `prstatus.Collector` — one batched `gh api graphql` (`viewer.pullRequests(first:100)`) | `app/backend/internal/prstatus/prstatus.go`, cadence const `prStatusPollInterval = 90 * time.Second` in `app/backend/api/sse.go` | 90 s | state (open/merged/closed), draft, checks rollup, review decision — **viewer-authored PRs only** |
| `BranchRefresher` — viewer-index join, `gh pr list --head <branch> --state all` fallback per pair | `app/backend/internal/prstatus/prstatus_branch.go`, `branchPRRefreshInterval = 30 * time.Second` | 30 s | the (repo, branch) → PR link, state, draft — **author-agnostic** (covers teammates' PRs) |
| Review-thread digest — scoped GraphQL `nodes(ids:)` over live windows' OPEN PRs | `app/backend/internal/prstatus/prstatus_threads.go`, `DefaultThreadInterval = 3 * time.Minute` | 3 min | review threads + 👀 marker → unhandled count, PR-review listener dispatch |

On top of that, the SSE hub re-derives a covered tmux server only on tmux control-mode events or its `safetyPollInterval = 12 * time.Second` safety tick (`api/sse.go`), so even after a collector pass lands, the new PR status can wait up to another 12 s before `attachPRStatus` serves it.

Consequence: a merge, a new review comment, a submitted review, or a CI flip shows up anywhere from seconds to ~90 s (status) or ~3 min (threads / listener dispatch) late. The PR-review listener (which dispatches unhandled review threads into the window's agent) inherits the 3-min floor, which is the most noticeable lag in the agent loop.

We cannot simply tighten the GraphQL cadences: GitHub prices GraphQL by implied requests and offers no conditional requests, and the codebase already learned this the hard way (the thread digest riding the batch took it to ~203 points/pass and exhausted 5,000 points/hour in ~37 min — see the comment on `ghQuery` in `prstatus.go`).

**Why this approach (and not the alternatives).**

- **GitHub repo webhooks / GitHub App webhooks — rejected.** They need a publicly reachable HTTPS URL per install (an App has a single webhook URL for all installations). Multi-user deployments would need every user to set up Tailscale Funnel + webhooks, or a centrally hosted relay that sees every user's PR activity — a product/ops commitment, rejected for now. Deliveries are also lost while the daemon is down (no automatic retry), so a webhook could only ever be a nudge, never the source of truth.
- **`gh webhook forward` — rejected.** It is a development tool with one active forwarder per repo, so several people cannot use it together.
- **Chosen: conditional REST as a change detector.** A `304 Not Modified` on an authorized conditional request is free against the primary rate limit (verified), so a tight cadence costs nothing while nothing changes; only an actual change (a `200`) costs one REST point and triggers the existing GraphQL refresh. Each HexoKit instance uses its own user's gh token, so the budget is per-user, and 304s are free anyway. The existing pollers stay as the reconciliation safety net, so the detector is purely additive — if it is down, broken, or rate-limited, behavior degrades to exactly today's.

## What Changes

### 1. New in-memory change detector (`app/backend/internal/prstatus/prstatus_detect.go`)

A new `Detector` type in package `prstatus` (alongside `Collector` / `BranchRefresher`, following their shape: background goroutine, `Start(ctx)`, injectable seams for tests, single-flighted pass under its own mutex).

**Input set — only tracked PRs.** The detector polls only PRs that live windows currently resolve to, so an idle dashboard polls nothing. The source is a callback, wired in `router.go` exactly like the thread digest's `SetLivePRSource`: `prstatus.DefaultBranchRefresher.PositiveEntries()` → PR URLs, filtered to **OPEN** PRs (state from `BranchPR.State`, overridden by the collector snapshot's `State` when the URL is in `Collector.Snapshot()`). A merged/closed PR drops out of the set on the pass after its refresh lands, so the detector stops polling it. Entries for URLs no longer in the set are evicted from the detector's ETag map at the start of each pass (bounded memory; no eviction timer).

**Per tracked OPEN PR, each pass issues conditional GETs** (URL identity parsed from the canonical PR URL `<scheme>://<host>/<owner>/<repo>/pull/<n>`):

| Endpoint | Why | Notes |
|----------|-----|-------|
| `GET {api}/repos/{owner}/{repo}/pulls/{n}` | PR resource carries `merged`, `state`, `draft`, `head.sha`, `comments`, `review_comments`, `updated_at` — merges, closes, pushes, draft toggles and new comments should flip its ETag | On 200, record `head.sha` from the body (needed for the CI endpoints; a 304 has no body) |
| `GET {api}/repos/{owner}/{repo}/commits/{head_sha}/check-runs?per_page=100` | CI is not in the PR body | `per_page=100` so the change in a later check run is still on the polled page in practice |
| `GET {api}/repos/{owner}/{repo}/commits/{head_sha}/status` | Combined legacy commit status — `statusCheckRollup` (what the collector displays) covers BOTH check runs and commit statuses, so both are watched | |
| `GET {api}/repos/{owner}/{repo}/pulls/{n}/reviews?per_page=100` | An approve-only review (no comment body) may NOT flip the PR resource's ETag — unverified, see Assumptions/Open Questions | Default ON; cheap because unchanged = 304 = free |

Every request:

- Sends `If-None-Match: <stored etag>` when an ETag is stored for that exact request URL.
- Uses one **fixed header set** from one `http.Client` for every request, so the replayed ETag always matches the headers that obtained it (verified: ETags differ across `Accept` headers): `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer <token>`, `User-Agent: hexokit/<version>` (GitHub rejects requests without a User-Agent). Header values are package constants.
- Runs under a per-request `context.WithTimeout(ctx, ghTimeout)` (10 s, the package's existing gh budget) on an `http.Client` that also has its own `Timeout` — Constitution "Process Execution" spirit; a hung GitHub must never stall the pass.
- Does **not** forward credentials across hosts: the client's `CheckRedirect` either refuses redirects or only follows same-host ones (an `Authorization` header must never reach a host other than the derived API host).

**Response handling (per request):**

| Status | Meaning | Action |
|--------|---------|--------|
| `304 Not Modified` | Nothing changed | Nothing. Free. |
| `200 OK`, **no prior ETag** (first sight of this URL in this process — including right after a daemon restart) | Baseline only | Store the ETag (+ `head.sha` for the PR endpoint). **Do NOT trigger a refresh** — the existing pollers already fetched this PR; triggering on first sight would turn every restart / new window into a refresh storm. |
| `200 OK`, prior ETag present, new ETag differs | Something changed | Store the new ETag; mark the PR **changed** for this pass (with which endpoint flipped — see §2). |
| `200 OK`, ETag identical to the stored one | Server ignored the conditional header | Treat as unchanged. |
| `404 Not Found` | PR deleted, repo renamed/transferred, or token lost access | Drop the PR's ETags; skip it until it re-enters the set fresh. Never infer "merged/closed" from a 404 — derivation stays with the GraphQL/`gh pr list` pollers. |
| `401 Unauthorized` | Token rotated / logged out | Invalidate the cached token for that host, re-read `gh auth token` once on the next request; if still 401, stand down for that host until the next pass. |
| `403` / `429` with `Retry-After`, or with `X-RateLimit-Remaining: 0` | Secondary or primary rate limit | **Back off the whole host**: pause the detector for that host until `Retry-After` seconds elapse, or until `X-RateLimit-Reset` (epoch seconds), whichever the response carries; with neither, a fixed backoff constant (e.g. 60 s, doubling to a cap). Log once per backoff entry (`slog`), never per request. |
| `403` without rate-limit signals | Permission problem | Treat like 404 for that PR. |
| network error / `5xx` / timeout | Transient | Keep the stored ETag, no trigger (stale-while-revalidate, mirrors the collector). |

Requests in one pass run **sequentially or with a small fixed concurrency bound (≤ 4)** — GitHub's secondary limits penalize concurrency, and at ~15 s cadence sequential is sufficient for realistic PR counts. A pass that starts while the previous one is still running is skipped (single-flight via a `passMu`/`TryLock`, mirroring `Collector.refreshMu`).

**Cadence:** `prChangeDetectInterval = 15 * time.Second` (named constant; tick-driven `time.Ticker`, immediate first pass establishes baselines).

**API base URL follows the PR's host** (parsed from the PR URL, port dropped, lowercased):
- `github.com` → `https://api.github.com`
- any other host (GitHub Enterprise Server) → `https://<host>/api/v3`

The base is a seam (`apiBaseFor(host string) string` or a field) so tests point it at an `httptest.Server`, mirroring `defaultAPIBase` in `internal/codeserver/release.go` and `internal/desktop/desktop.go`.

### 2. Token source (`gh auth token`, cached, per host)

- Obtain the token with `exec.CommandContext(ctx, "gh", "auth", "token")` for `github.com`, and `exec.CommandContext(ctx, "gh", "auth", "token", "--hostname", host)` for any other host — explicit argv slice, `ghTimeout` (10 s) context (Constitution I + Process Execution). `gh auth token` already honors `GH_TOKEN` / `GITHUB_TOKEN` and gh's active account, so "the gh host/account in use" is respected by delegation (Constitution III — wrap, don't reinvent).
- The host string comes from a parsed PR URL; validate it (non-empty, hostname-shaped, no leading `-`) before it reaches argv.
- Cache the token **in memory only**, per host, with a TTL (e.g. 5 min — the same "gh works" TTL `internal/ghprobe` uses) so a `gh auth switch` is picked up without a 401; invalidate immediately on a 401. Never log the token; never write it to disk; never put it in an error string.
- Gate on the existing `ghprobe.Available(ctx, ghTimeout)` (memoized) before spending the subprocess — gh absent/unauthenticated is a silent no-op, matching the package's fail-silent posture.
- Seam: a `tokenFn func(ctx context.Context, host string) (string, error)` field so tests never spawn `gh`.

### 3. What a detected change triggers (the existing derivation stays the source of truth)

The detector never writes PR state itself — it only decides **when** to re-derive (Constitution II / X: derivation via the existing fetches remains authoritative; ETags are a disposable cache). At the end of a pass, if any PR changed, it invokes an injected `onChange func(ctx context.Context, changed []DetectedChange)` callback (wired in `router.go`) ONCE for the whole pass (coalesced — N flips in one pass ⇒ one refresh round). `DetectedChange` carries the PR URL and which endpoints flipped (`PR`, `Checks`, `Reviews`).

The wired callback, in order:

1. **`Collector.RefreshNow(ctx)`** — one batched GraphQL pass (state, draft, checks rollup, review decision for viewer-authored PRs). Already single-flighted by `refreshMu`.
2. **Targeted branch re-resolve for the changed URLs** — the collector only sees `viewer { pullRequests }`, so a teammate's PR on an observed window gets its state/draft only from the branch channel. Add a `BranchRefresher` method (e.g. `RefreshURLs(ctx, urls []string)`) that re-resolves ONLY the registered pairs whose current entry's `PR.URL` is in the changed set, under the same `refreshMu` and with the same resolution order/rules as `refresh` (default-branch exclusion → index join → `gh pr list` fallback). Calling the full `BranchRefresher.RefreshNow` (one `gh pr list` per registered pair) on every flip is explicitly avoided.
3. **`Collector.RefreshThreadsNow(ctx)`** — only when a `PR` flip shows the `comments` / `review_comments` counts changed, or the `Reviews` endpoint flipped. (The scoped digest is ~5 points; review-thread latency for the PR-review listener drops from ≤ 3 min to ≤ ~15 s for new comments.)
4. **Wake the SSE hub** so clients see the new snapshot now rather than on the ≤ 12 s safety tick: after the refreshes return, wake every server the hub is polling (a new small `sseHub` method that iterates the hub's known servers and calls the existing `wake(server)`; `wake` is already coalescing and allocation-gated). `s.sseHub` is lazily created by `initSSEHub` — the callback must nil-guard it (read under whatever synchronization `initSSEHub`/`sseOnce` provides).

**Refresh-rate guard.** A minimum interval between detector-triggered collector refreshes (e.g. `prChangeRefreshMinInterval = 10 * time.Second`) — a flip arriving inside the window is deferred to the next pass, never dropped (the changed set is carried forward). This bounds the GraphQL cost of a CI storm (check-runs ETags may flip on every check transition) at roughly ≤ 360 collector passes/hour × ~2 points ≈ ≤ 720 points/hour worst case, well under 5,000.

**Budget logging.** Log (slog, debug/info) `X-RateLimit-Remaining` once per pass that saw a 200, mirroring how the thread digest logs GraphQL `cost`/`remaining`, so REST spend is never invisible.

### 4. Wiring (`app/backend/api/router.go`, `app/backend/api/sse.go`)

In `NewRouterAndServer`, after `pc.Start(ctx)` / `pc.StartThreads(...)` / `DefaultBranchRefresher.Start(ctx)`:

```go
det := prstatus.NewDetector(prChangeDetectInterval)
det.SetSource(func() []string { /* PositiveEntries → OPEN PR URLs, collector state wins on URL hit */ })
det.SetOnChange(func(ctx context.Context, changed []prstatus.DetectedChange) {
	pc.RefreshNow(ctx)
	prstatus.DefaultBranchRefresher.RefreshURLs(ctx, urlsOf(changed))
	if anyThreadsRelevant(changed) {
		pc.RefreshThreadsNow(ctx)
	}
	s.wakeAllSSE() // nil-guards the lazily-created hub
})
det.Start(ctx)
```

`prChangeDetectInterval` lives next to `prStatusPollInterval` in `api/sse.go` (cadence constants are kept together there). `NewTestRouter` leaves the detector unwired (unit tests never touch the network), matching how the seed cache and viewer sink are left unwired.

### 5. Unchanged

- The 90 s collector poll, the 30 s branch refresher, and the 3 min thread digest stay exactly as they are — they are the reconciliation safety net (may be relaxed in a later change; NOT in this one).
- No new on-disk state: ETags, head SHAs, tokens and backoff deadlines are in-memory only. Losing them on restart costs one baseline `200` per endpoint per PR, which triggers nothing.
- No new settings key, no new route, no frontend change, no SSE event shape change.

### 6. Tests (`app/backend/internal/prstatus/prstatus_detect_test.go`, run via `just test-backend`)

Against an `httptest.Server` (API base seam) with a stub `tokenFn` and a recording `onChange`:

- First-sight 200 stores a baseline and does NOT call `onChange`.
- Second pass: 304 → no `onChange`; the request carried `If-None-Match` equal to the stored ETag and the fixed `Accept` / `X-GitHub-Api-Version` headers.
- ETag flip (200 with new ETag) on the PR endpoint → exactly one `onChange` per pass even when several PRs/endpoints flip (coalescing).
- `head.sha` from a PR 200 drives the check-runs / status URLs; a new SHA starts a fresh baseline for its CI endpoints.
- 404 drops that PR's ETags without calling `onChange`.
- 401 invalidates the cached token and re-calls `tokenFn` on the next request.
- 403/429 with `Retry-After` (and with `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`) pauses the host — no requests until the deadline (use a `now` seam, no sleeps).
- 5xx / network error keeps the ETag and does not trigger.
- A PR that leaves the source set is evicted from the ETag map; merged/closed PRs are not polled.
- A non-github.com host builds `https://<host>/api/v3` and passes `--hostname <host>` to the token source.
- The `Authorization` header is not forwarded on a cross-host redirect.
- `BranchRefresher.RefreshURLs` re-resolves only pairs whose entry URL is in the set (stub `branchPRExec`).

## Affected Memory

- `run-kit/architecture/pr-status`: (modify) add a "Conditional-REST Change Detector" section — input set (live OPEN PRs), the four conditional endpoints, fixed header set + ETag-replay rule, response handling table (304 / first-sight baseline / flip / 404 / 401 / 403-429 backoff / transient), the `gh auth token` per-host cache, the coalesced `onChange` → collector refresh + targeted branch re-resolve + thread digest + SSE wake chain, the refresh-rate guard, `BranchRefresher.RefreshURLs`; plus Design Decisions entries (conditional REST over webhooks / `gh webhook forward`; in-process `net/http` over `gh` subprocesses; first-sight baseline never triggers; ETags in memory only, never authoritative)
- `run-kit/api-and-sockets`: (modify) only if the SSE hub gains a new "wake all polled servers" seam worth recording beside the existing per-server `wake` — note the detector as a wake source

## Impact

- **Code**: `app/backend/internal/prstatus/` (new `prstatus_detect.go` + `prstatus_detect_test.go`; `prstatus_branch.go` gains `RefreshURLs`, with tests in `prstatus_branch_test.go`), `app/backend/api/router.go` (wiring), `app/backend/api/sse.go` (cadence constants, wake-all helper).
- **Dependencies**: Go stdlib only (`net/http`, `net/url`, `encoding/json`). No new module.
- **External API**: new REST traffic to `api.github.com` (or GHES `/api/v3`) using the user's own gh token. Idle cost ≈ 0 primary-limit points (304s are free); steady state at 20 tracked OPEN PRs × 4 endpoints / 15 s ≈ 320 requests/min of mostly 304s — below GitHub's documented 900-points/min REST secondary limit if 304s count at all (unverified, see Open Questions).
- **Daemon behavior**: one more background goroutine; no new subprocess per request (one `gh auth token` per host per TTL); Constitution II unaffected (no durable state added).
- **Frontend**: none. PR body: `No recording: backend-only` (Constitution § PR Evidence).

## Open Questions

- Does an approve-only review (no comment body) change the `pulls/{n}` ETag? Does resolving a review thread change it? Neither was verified. The `pulls/{n}/reviews` conditional poll covers the first; thread **resolution** is GraphQL-only state (REST exposes no `isResolved`), so it stays on the 3-min digest regardless.
- Do 304 responses count toward GitHub's **secondary** rate limits (per-minute points / concurrency)? Only primary-limit behavior was verified. The backoff path covers being wrong, but the steady-state request rate at large PR counts should be sanity-checked live during apply.
- How often does the check-runs ETag flip during an active CI run (every check transition? on `output` updates?) — determines how often the refresh-rate guard engages.
- Background `mergeable` / `mergeable_state` recomputation (e.g. when the base branch moves) likely flips the PR ETag for every open PR against that base — producing a spurious but harmless coalesced refresh. Acceptable, or should the detector compare a projection of the body (`state`, `merged`, `draft`, `head.sha`, `comments`, `review_comments`) instead of the raw ETag to decide "changed"?

## Clarifications

### Session 2026-10-08 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 19 | Confirmed | — |
| 20 | Confirmed | — |
| 21 | Confirmed | — |
| 22 | Confirmed | — |
| 23 | Confirmed | — |
| 24 | Confirmed | — |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Use conditional REST (ETag / `If-None-Match`) as a change detector gating the existing GraphQL refresh; webhooks, GitHub App webhooks and `gh webhook forward` are out of scope | Discussed — user chose "option 4" after rejecting webhooks (public URL per install / central relay; deliveries lost while daemon down) and `gh webhook forward` (one forwarder per repo) | S:95 R:70 A:90 D:95 |
| 2 | Certain | Conditional calls are made in-process with Go `net/http`, not via `gh api` subprocesses | Discussed — explicitly user-approved, to avoid ~160 gh spawns/min at 20 PRs | S:95 R:75 A:90 D:95 |
| 3 | Certain | Token from `gh auth token` via `exec.CommandContext` + timeout + argv slice, cached in memory, re-read on 401 | Discussed — user decision; Constitution I + Process Execution mandate the exec form | S:90 R:80 A:95 D:90 |
| 4 | Certain | ETags (and head SHAs, tokens, backoff deadlines) live in memory only; no on-disk state | Discussed — Constitution II: in-memory cache, never authoritative; restart costs one baseline 200 per endpoint | S:95 R:85 A:95 D:95 |
| 5 | Certain | The 90 s collector, 30 s branch refresher and 3 min digest stay unchanged as the reconciliation safety net | Discussed — "may be relaxed later; not required in this change" | S:95 R:90 A:95 D:95 |
| 6 | Certain | Detector polls only PRs live windows resolve to (`BranchRefresher.PositiveEntries`), OPEN only | Discussed — decision 7 (idle dashboards don't poll); same live set the thread digest's `SetLivePRSource` uses | S:90 R:85 A:90 D:85 |
| 7 | Certain | One fixed header set (`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, Bearer auth, User-Agent) from one client for every request | Verified live — ETag is tied to request headers, so replay must use the headers that obtained it | S:90 R:90 A:95 D:90 |
| 8 | Certain | Response handling: 304 nothing; 200 store+flag; 404 drop; 401 token refresh; 403/429 host backoff honoring `Retry-After` / `X-RateLimit-Reset`; transient errors keep ETag | Discussed — enumerated as constraints in the conversation | S:90 R:85 A:90 D:85 |
| 9 | Certain | No UI change; PR body states `No recording: backend-only` | Discussed — backend-only latency improvement; Constitution § PR Evidence exemption | S:90 R:95 A:95 D:95 |
| 10 | Certain | Tests via `just test-backend`, `httptest.Server` + stubbed token/exec seams, no live network | context.md mandates `just` recipes; codebase's exec-seam test pattern | S:80 R:95 A:95 D:95 |
| 11 | Confident | Also conditionally poll `commits/{sha}/check-runs?per_page=100` AND `commits/{sha}/status` (combined) | Discussed (CI not in PR body); both because `statusCheckRollup` covers check runs and legacy statuses | S:75 R:85 A:75 D:65 |
| 12 | Confident | First-sight 200 (no stored ETag) is a baseline and never triggers a refresh | Existing pollers already fetched the PR; triggering would cause a refresh storm on restart / new window | S:55 R:85 A:80 D:80 |
| 13 | Confident | Coalesce: one `onChange` per pass, plus a min interval (~10 s) between detector-triggered collector refreshes; deferred flips carry to the next pass | Bounds GraphQL cost during CI storms (≤ ~720 pts/h worst case); mirrors existing single-flight/coalesce patterns | S:50 R:85 A:75 D:70 |
| 14 | Confident | On change: `Collector.RefreshNow` + `RefreshThreadsNow` (only on comment/review flips) + wake all SSE-polled servers | Description's "trigger the existing GraphQL refresh … through the existing SSE path"; the 12 s SSE safety tick would otherwise add latency | S:65 R:85 A:80 D:70 |
| 15 | Confident | Sequential (or ≤ 4 concurrent) requests per pass; single-flight pass; per-request 10 s timeout | GitHub secondary limits penalize concurrency; package's existing `ghTimeout`; Process Execution spirit | S:55 R:90 A:80 D:75 |
| 16 | Confident | Token cache TTL ~5 min per host, gated on `ghprobe.Available`; host validated before argv | Picks up `gh auth switch` without a 401; reuses the ghprobe TTL rationale; Constitution I input validation | S:55 R:90 A:80 D:75 |
| 17 | Confident | No settings key / kill switch; cadence and guards are named constants | Constitution VII (convention over configuration) and IV (minimal surface); detector is additive and fail-silent | S:50 R:85 A:75 D:70 |
| 18 | Confident | Authorization never forwarded across hosts (restrict `CheckRedirect` to same host or refuse redirects) | Security — token must only reach the derived API host | S:50 R:90 A:85 D:80 |
| 19 | Confident | Detector cadence `prChangeDetectInterval = 15 s` | Clarified — user confirmed | S:95 R:95 A:55 D:55 |
| 20 | Confident | Also conditionally poll `pulls/{n}/reviews?per_page=100` (default on) | Clarified — user confirmed | S:95 R:85 A:45 D:55 |
| 21 | Confident | GHES supported by host-derived API base (`github.com` → `api.github.com`, else `https://<host>/api/v3`) and `gh auth token --hostname <host>` | Clarified — user confirmed | S:95 R:80 A:60 D:55 |
| 22 | Confident | Teammate PRs: add `BranchRefresher.RefreshURLs` to re-resolve only pairs whose PR URL changed, rather than calling full `BranchRefresher.RefreshNow` | Clarified — user confirmed | S:95 R:80 A:60 D:45 |
| 23 | Confident | "Changed" = raw ETag differs (not a projected-body comparison) | Clarified — user confirmed | S:95 R:90 A:55 D:40 |
| 24 | Confident | Host-wide backoff with no rate-limit headers: fixed 60 s doubling to a cap | Clarified — user confirmed | S:95 R:95 A:55 D:50 |

24 assumptions (10 certain, 14 confident, 0 tentative, 0 unresolved).
