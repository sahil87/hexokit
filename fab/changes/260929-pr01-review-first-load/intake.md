# Intake: PR Review Surface — First-Load Latency

**Change**: 260929-pr01-review-first-load
**Created**: 2026-09-29

## Origin

Conversational, immediately after #1027 merged. The user asked:

> how can i make the first load faster, measure and come up with a plan

A measurement pass was run against the live API (subject: PR #1027 itself — 80 files,
990 KB of patch JSON, 14,818 diff rows, 4,996 inside the eager budget; each figure a
median of 3+ runs). A four-phase plan was presented. The user then said:

> the branch is merged, i want the improvement to be done from the main branch

This change is **Phase 1 only**. Phases 2–4 are recorded under Out of scope.

## Why

**The problem.** Opening the Changes tile on a cold cache takes **2.54–2.96 s**, and
almost none of that is work we do.

| Stage | Measured | On the critical path? |
|---|---|---|
| tmux window → PR URL (`FetchSessions`) | ~0 ms | yes |
| `gh auth status` availability probe | **0.36 s** | yes, serial |
| `gh api …/pulls/1027` (meta) | **0.65 s** | yes, serial |
| `gh api …/pulls/1027/files` (990 KB) | **1.05 s** | yes, serial |
| `gh api graphql` (threads + viewer) | **0.90 s** | yes, serial |
| decode gh JSON | 5.5 ms | |
| `applyEagerBudget` (parse 80 patches) | 1.7 ms | |
| marshal the 565 KB response | 2.6 ms | |
| **end to end** | **2.54 – 2.96 s** | |

Server CPU is **~10 ms of a ~2.8 s load**. Essentially 100% of first load is four
serial `gh` round trips, and only one of the four needs to be where it is.

**Three independent causes, each separately measured:**

1. **The meta read is a whole REST round trip for four scalars.** `fetchMeta`
   (`files.go:30`) exists only to get `title`, `state`, `head.sha`, `base.sha`. All
   four are available on the `pullRequest` node the threads query already selects.
   Adding `title state headRefOid baseRefOid` to that query was measured against the
   live API: **cost stays 21 points** (`rateLimit { cost }`, unchanged) and the call
   still runs in 0.78 s. The values match REST exactly (`headRefOid` `0e3273ea` =
   `head.sha`; `baseRefOid` `e53be267` = `base.sha`). So the 0.65 s buys nothing.

2. **The remaining calls are serial for no reason.** `fetch` (`prreview.go:322`) calls
   meta → files → threads in sequence. They have no data dependency on each other;
   only `ParsePRURL` feeds them, and it is pure. Measured running files + graphql
   concurrently: **0.86 / 0.97 / 1.56 s**, against 2.54–2.96 s serial.

3. **The availability probe is a network call on every cold load.** `ghAvailable`
   (`prreview.go:473`) runs `ghprobe.Available`, which shells out to `gh auth status`.
   Measured: 0.34–0.39 s across 10 consecutive samples, and **it costs no API budget**
   (`core.remaining` was 5000 before and after three runs — it is an uncounted
   endpoint). But in one earlier burst it returned in **30.04 s and 30.07 s back to
   back**. `ghTimeout` is 10 s, so on that path the probe is cancelled, `Get` returns
   `ErrUnavailable`, and the tile paints "gh is unavailable" — which is exactly the
   symptom the user reported during #1027 ("shows gh is unavailable", and the
   companion 504). The probe is therefore both a fixed 0.36 s tax and an unbounded
   tail risk, for an answer that changes approximately never.

**If we don't fix it:** every cold tile mount and every post-TTL revalidation pays
~2.8 s, three quarters of which is removable without touching a single byte of what
the user sees. The probe keeps its 30 s failure mode.

**Why this approach.** Each of the three is independently correct, independently
testable, and none changes the wire format, the eager budget, the highlight ladder, or
the GraphQL point cost. Rejected alternatives:

- **Our own HTTP client with a keep-alive pool** instead of `gh` subprocesses. A fresh
  TLS handshake per call is probably 150–250 ms of each round trip, but Constitution I
  makes `gh` the boundary, and re-implementing auth/host resolution to save that is a
  bad trade.
- **`golang.org/x/sync/errgroup`** for the fan-out. Not currently a direct dependency
  (`go.mod` has no `golang.org/x/sync`; it appears in `go.sum` transitively only). Two
  calls do not justify a new direct dependency — stdlib `sync.WaitGroup` is four lines.
- **Prefetching the review document** when a window gains focus. Would make the click
  feel instant, but burns 22 points + 1 REST call per warm on a tile that may never
  open, three months after a rate-limit incident. Deferred to Phase 3, where a longer
  TTL gets most of the same benefit for free.

## What Changes

### 1. `threads.go`: the threads query carries the PR meta

File: `app/backend/internal/prreview/threads.go`.

Add four scalar fields to the `pullRequest` node in `threadsQuery` (`:27`):

```graphql
    pullRequest(number: $number) {
      title
      state
      headRefOid
      baseRefOid
      reviewThreads(first: 100) {
```

Widen `ghThreadsResponse` (`:57`) with the matching fields, and change
`fetchThreads` (`:99`) to return the meta alongside the threads and viewer.

`state` comes back from GraphQL **uppercase** (`"OPEN"`) where REST returns
`"open"`. Lowercase it at the projection so the wire contract is byte-identical.
`Review.State` is currently write-only (nothing in Go or the frontend reads it), which
is exactly why it must not be allowed to drift silently.

The query comment block at `:20-26` documents the 100 × 20 = 21-point bound. Extend it
to record that the scalar meta fields ride free — measured, not assumed — so the next
reader does not "optimise" them back out into their own call.

### 2. `files.go`: delete `fetchMeta`

Remove `prMeta`, `ghPRMeta` and `fetchMeta` (`files.go:12-45`). One call site
(`prreview.go:332`); nothing else in the tree references any of the three.
`restArgs` and `fetchFiles` stay untouched.

### 3. `prreview.go`: fan the two remaining calls out

File: `app/backend/internal/prreview/prreview.go`, `fetch` at `:322`.

The single shared `fetchBudget` (15 s) still wraps the whole pass, and `refreshMu` is
still held across it — R3's single-flight posture is unchanged. Only the two calls
inside become concurrent:

```go
	var (
		files       []FileEntry
		filesErr    error
		threads     []Thread
		meta        prMeta
		viewer      string
		threadsErr  error
		wg          sync.WaitGroup
	)
	wg.Add(2)
	go func() { defer wg.Done(); files, filesErr = f.fetchFiles(ctx, ref) }()
	go func() { defer wg.Done(); meta, threads, viewer, threadsErr = f.fetchThreads(ctx, ref) }()
	wg.Wait()
	if filesErr != nil {
		return nil, filesErr
	}
	if threadsErr != nil {
		return nil, threadsErr
	}
```

Error precedence is deliberate and must be stable: `filesErr` first, so a
rate-limit or timeout reports the same way it does today regardless of which
goroutine lost the race. The function comment at `:50` ("makes three sequential gh
calls") is now wrong and is part of this change.

### 4. `ghprobe`: memoize the answer

File: `app/backend/internal/ghprobe/ghprobe.go`.

`Available` gains a package-level memo behind a mutex: a successful probe is trusted
for **5 minutes**, a failed one for **30 seconds**. Asymmetric on purpose — "gh works"
is a stable fact, while "gh is broken" is what the user is actively fixing (logging in,
installing), so recovery must not wait five minutes.

`exec.LookPath` stays outside the memo: it is a filesystem check, not a network one.
An injectable clock (a package var, the pattern `prreview` already uses for `f.now()`)
so the TTLs are testable without sleeping.

Both `prreview` and `prstatus` call through `ghprobe.Available`, so the collector gets
the same benefit with no change of its own.

### 5. Coverage

- `prreview`: the fetch pass issues **two** gh invocations, not three, and neither
  argv is the `pulls/{n}` meta path — assert on the recorded argv, since the change
  has no other symptom. Title/state/head/base come back populated from the threads
  fixture. `state` is lowercased.
- Concurrency: a fixture where both calls block until released proves they overlap
  (serial code deadlocks the test); `-race` via `just test-backend-race`.
- Error precedence: files-error-plus-threads-error reports the files error.
- `ghprobe`: second call inside the TTL spawns no subprocess; a failure is retried
  after 30 s but not before; the clock seam is injected, never slept on.

### Out of scope (explicit)

Recorded so the measurements are not lost; each is its own change.

- **Phase 2 — colour on first paint.** Lexing each eager file's own patch text
  server-side, with no blob fetch, was measured at **240 ms serial / 72 ms across 8
  cores**, giving a token class to **4,566 of 4,895 rows (93%)** and doubling the
  payload (560 KB → 1,120 KB). It slots in as a new rung below R5's tier 1, with the
  existing blob-backed pass demoted to the refinement tier. Bigger design change;
  wants its own spec amendment.
- **Phase 3 — make re-opens free.** `reviewTTL` is 60 s, far shorter than needed given
  the SSE thread digest already pushes invalidation. Plus gzip on the API responses
  (measured 3.4× on this payload: 990 KB → 291 KB) — irrelevant on localhost, material
  over the Tailscale address the daemon also listens on.
- **Phase 4 — the >100-file cliff.** `--paginate` is serial inside `gh`, so a 250-file
  PR pays ~3 s on the files call alone. Page 1's `Link` header gives the count, so
  pages 2..N could fan out. Not worth building until a PR that big actually hurts.
- Any change to the eager budget, the row wire format, the highlight ladder, the
  comment/listener write paths, or the frontend. This change is invisible above
  `prreview`.

## Affected Memory

- `run-kit/pr-review`: (modify) the detail-fetch description. It currently describes
  three sequential gh reads with the viewer login riding the thread query; it becomes
  two concurrent reads with the viewer login **and the PR meta** riding the thread
  query. The measured "~21 per mount" figure at L235 is unchanged and should be stated
  as *confirmed* after the meta fold, not re-derived.
- `run-kit/architecture/pr-status`: (modify) if it describes `ghprobe.Available` as a
  live probe, add the memo and its asymmetric TTLs.

## Impact

- **Code:** `internal/prreview/threads.go`, `files.go` (deletions), `prreview.go`
  (`fetch`, one comment block), `internal/ghprobe/ghprobe.go`.
- **Tests:** `internal/prreview/prreview_test.go`, a new `internal/ghprobe` test file
  (the package has none today).
- **Spec:** `docs/specs/pr-review.md` § R3's "~21 per mount" row stays true and should
  be left alone. § R3a's cost table stays true. The prose in § R3 describing the
  detail fetcher's posture gains "the two reads inside the pass run concurrently".
  § R3a gains one line: the meta scalars ride the threads query at no additional cost —
  which is the *same* lesson as R3a's rule 1 read in the other direction, and worth
  saying so explicitly.
- **Wire format:** unchanged. Same JSON, same fields, same values.
- **GraphQL cost:** unchanged at 21 points per mount (measured). REST calls per mount
  drop from 2 to 1.
- **Gates:** `just test-backend`, `just test-backend-race`, `cd app/backend && go vet ./...`.
  No frontend gate is needed — no frontend file changes — but `just test-e2e` is worth
  one run because the review e2e exercises the mount path end to end.

## Open Questions

- The 30 s `gh auth status` outlier was observed twice and never reproduced in a
  10-sample run. The memo makes it a once-per-5-minutes risk rather than a
  once-per-load one, which is enough for this change. Whether `ghprobe` should
  additionally fall back to a *stale* positive result when a re-probe times out
  (never regressing a working tile into "gh is unavailable") is a real question and is
  left for plan generation to raise — it is one `if`, but it changes failure semantics.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | First load is ~2.8 s and ~99.6% of it is four serial `gh` round trips; server CPU is ~10 ms | Measured end to end on PR #1027, medians of 3+ runs, each stage timed separately | S:95 R:90 A:95 D:95 |
| 2 | Certain | `title`/`state`/`headRefOid`/`baseRefOid` on the threads query cost 0 additional points and 0 additional latency | Measured against the live API with `rateLimit { cost }` selected: 21 before and after, 0.78 s both ways | S:95 R:90 A:95 D:95 |
| 3 | Certain | `headRefOid`/`baseRefOid` equal REST's `head.sha`/`base.sha` | Compared directly on #1027: `0e3273ea` / `e53be267` both ways | S:95 R:90 A:95 D:95 |
| 4 | Certain | `fetchMeta`/`prMeta`/`ghPRMeta` have exactly one call site and can be deleted | Grep across `internal` and `api`: only `prreview.go:332` | S:95 R:90 A:95 D:95 |
| 5 | Certain | `fetchFiles` and `fetchThreads` have no data dependency and can run concurrently | Both take only `(ctx, ref)`; `ParsePRURL` is pure and runs before either | S:90 R:90 A:95 D:90 |
| 6 | Certain | Concurrent execution measures 0.86–1.56 s against 2.54–2.96 s serial | Measured, 3 runs of each shape | S:90 R:90 A:90 D:90 |
| 7 | Certain | `gh auth status` costs no API budget | `core.remaining` 5000 → 5000 across three probes with no other calls between | S:90 R:85 A:95 D:90 |
| 8 | Confident | The 30 s probe outlier is a transient network stall, not a reproducible gh behaviour | Seen twice in one burst, never in a subsequent 10-sample run (0.34–0.39 s). The memo bounds the blast radius either way, so the diagnosis is not load-bearing | S:45 R:80 A:85 D:70 |
| 9 | Confident | 5 min positive / 30 s negative TTLs on the probe memo | Asymmetry is the point: "gh works" is stable, "gh is broken" is being actively fixed. The exact numbers are a judgment call and the one knob to turn | S:55 R:85 A:80 D:65 |
| 10 | Certain | stdlib `sync.WaitGroup`, not `errgroup` | `golang.org/x/sync` is not a direct dependency today; two calls do not justify adding one, and the stdlib form is four lines | S:70 R:85 A:85 D:75 |
| 11 | Confident | Error precedence is files-then-threads, fixed | Arbitrary but must be deterministic, or a rate-limit error would report differently run to run. Any stable order works; this one matches the current call order | S:65 R:85 A:85 D:75 |
| 12 | Certain | `state` must be lowercased at the GraphQL projection | GraphQL returns `"OPEN"`, REST `"open"`. Nothing reads the field today (grep: write-only in Go, absent from the surface component), which makes a silent drift *more* likely to survive unnoticed, not less | S:70 R:85 A:85 D:80 |
| 13 | Confident | `exec.LookPath` stays outside the memo | It is a filesystem check costing microseconds; memoizing it would mean a gh installed mid-session stays invisible for 5 minutes | S:65 R:85 A:85 D:75 |
| 14 | Confident | Concurrency is proved by a fixture whose two calls block until released, so serial code deadlocks | Asserting on wall-clock timing would be flaky in CI; a deadlock is a deterministic failure | S:60 R:85 A:80 D:70 |
| 15 | Certain | No frontend change and no wire-format change | Same JSON fields and values; the change is entirely inside `prreview`'s fetch | S:75 R:85 A:90 D:80 |
| 16 | Certain | `prstatus` inherits the probe memo with no change of its own | It calls the same `ghprobe.Available`; grep shows the only two call sites are `prreview.go:473` and `prstatus.go:438` | S:70 R:85 A:85 D:80 |

16 assumptions (11 certain, 5 confident, 0 tentative, 0 unresolved).
Grades are derived from the composite, not asserted: `fab score` reads 4.7 against a 3.0 gate.
