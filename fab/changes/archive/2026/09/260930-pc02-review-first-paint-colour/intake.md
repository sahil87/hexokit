# Intake: Colour on First Paint (PR Review, Phase 2)

**Change**: 260930-pc02-review-first-paint-colour
**Created**: 2026-09-30

## Origin

Phase 2 of the four-phase first-load plan measured during 260929-pr01 (shipped as #1069). The user, having read that PR's Out-of-scope section, said:

> go phase 2

Phase 1's own intake recorded this phase with its measurements, so the numbers below are re-derived here rather than assumed, on the current code.

## Why

**The problem.** Phase 1 cut the time to the first row from ~2.8 s to ~1.3 s. What lands at that moment is *structure without colour*: the eagerly-expanded rows ship as one classless span each (tier 0, `LineRowsFromPatch`). Colour then trickles in behind the client's viewport pump — `SPANS_CONCURRENCY = 3`, each request a `gh` blob fetch at ~0.6 s. For the 31 files inside the eager budget on a PR like #1027 that is ~6 s of progressive recolouring, and the first screenful is monochrome for the first ~0.6 s after it appears.

**Why it costs a fetch at all.** R5's ladder lexes the file's POST-IMAGE, which lives on GitHub. Tier 1 pulls the blob, lexes a window around the requested lines with a context pad, and flags `refine` when the pad did not reach the start of the file; tier 2 re-lexes the whole blob in the background. Every rung needs the blob, so every rung needs a round trip.

**The observation this phase turns on.** The patch *already carries the line text*. It is not the whole file, so a hunk that opens inside a block comment or a raw string will lex wrong — but for the overwhelming majority of rows it is exactly right, and it costs no network at all.

Measured on PR #1027's real payload (84 files, 4,996 eagerly-expanded rows), lexing each expanded file's own patch text:

| | |
|---|---|
| serial | **240 ms** |
| across 8 cores (one goroutine per file) | **72 ms** |
| rows receiving a token class | **4,566 of 4,895 — 93%** |
| payload | 560 KB → **1,120 KB** |

So: ~72 ms of CPU, zero requests, and 93% of rows are coloured the instant they paint.

**Why this is a new RUNG and not a replacement.** The 7% it gets wrong are real — a hunk boundary genuinely lacks the context to lex correctly, which is the whole reason tier 1 has a context pad. So the blob-backed pass stays exactly as it is, and the client's viewport pump keeps upgrading each file as it approaches the viewport. Tier 0.5 changes what the reader sees in the gap before that arrives, and nothing else.

**If we don't do it:** the surface's fastest possible first paint is still a monochrome one, and the 6 s of visible recolouring on a large PR stays.

## What Changes

### 1. `prreview.go`: `applyEagerBudget` colours the rows it builds

The lexing goes in the budget path, NOT in `LineRowsFromPatch`. That separation is load-bearing: `LineRowsFromPatch` is tier 0 and is plain *by definition* (its own test says so), and it is also what `FileRows` uses before the blob-backed spans are applied. Colouring there would make tier 0 a lie and would double-lex the body path.

```go
default:
    file.Rows = LineRowsFromPatch(patchRows)
    rows += file.RowCount
    expanded++
}
```
becomes a two-step: build the rows in the loop, then colour every expanded file in one parallel pass at the end. One goroutine per file (the measured 240 ms → 72 ms), bounded by the file count, which the budget already caps at `maxEagerFiles` = 75.

### 2. `highlight.go`: `lexPatchRows`

A new unexported helper beside the existing ladder:

- Group the file's rows into contiguous runs, breaking at every `RowHunk` — a hunk header is not code, and the rows either side of it are not contiguous in the file.
- `lexLines` each run and write the spans back onto the rows in place.
- A file with no Chroma lexer is left exactly as it is (tier 0 plain). `lexerFor` returning nil is the common case for lockfiles and data, and it must not become an error path.
- The hunk header row keeps no spans: it renders from `Header`.

### 3. The wire, and what is deliberately NOT sent

Rows now arrive with `c` classes on their spans. **No new field.** Specifically:

- `FileBody.refine` is NOT set for these rows, and that is not an oversight. `ReviewDiff` fires `onLoadRange()` immediately on mount when `body.refine` is true — so setting it would make a 31-file PR issue 31 body requests the instant the tile mounts, which is precisely the storm the list/body split exists to prevent. The upgrade path is the client's existing IntersectionObserver pump: viewport-driven, `SPANS_CONCURRENCY`-bounded, already shipped, and unchanged by this change.
- The seeded body's `highlighted` flag becomes true, because it is now true. It has no consumer today, which is the reason to keep it honest rather than the reason to skip it.

So the client change is one boolean. The rest is server-side.

### 4. Coverage

- Eager rows carry token classes on a `.go` file, and the hunk header row still carries none.
- A file with no lexer ships tier-0 plain rather than failing.
- Row TEXT is unchanged by colouring — concatenating a row's spans reproduces the line exactly. This is the guard that matters: a lexer that drops or reorders a character would be a rendering corruption, not a colour bug.
- `LineRowsFromPatch` stays plain (the existing tier-0 test is left alone, and its invariant is now load-bearing for two callers).
- A collapsed file is not lexed at all.

### Out of scope (explicit)

- **Phase 3** — the longer `reviewTTL` and gzip. Gzip is the natural pairing for the payload growth here (measured 3.4× on this payload) and stays in its own change.
- **Phase 4** — the >100-file `--paginate` cliff.
- Any change to the R5 blob ladder, the client's viewport pump, `SPANS_CONCURRENCY`, or the eager budget's caps.

## Affected Memory

- `run-kit/pr-review`: (modify) the R5 ladder gains its tier-0.5 rung and the reason it is a rung rather than a replacement.

## Impact

- **Code:** `internal/prreview/prreview.go` (`applyEagerBudget`), `internal/prreview/highlight.go` (new helper), `app/frontend/src/components/review-surface.tsx` (one boolean).
- **Wire:** additive — rows that carried one classless span now carry several classed ones. No field added or removed.
- **Payload:** roughly doubles for the list read. On localhost this is immaterial; over the Tailscale address the daemon also listens on it is not, which is why gzip is named as the pairing.
- **Spec:** `docs/specs/pr-review.md` § R5 gains the rung.
- **Gates:** `just test-backend`, `just test-backend-race`, `just test-frontend`, `just test-e2e`.
- **Known-failing before this change** (must not be attributed here): locally, `rk/cmd/rk`'s `TestPortPinRowRealPolicyValues` and the e2e `control-gallery` baselines + `gui-toolbar-fold`. All three pass in CI, so they are local-environment, not repo-wide.

## Open Questions

- Whether tier 0.5 should also apply to a COLLAPSED file's rows once the reader expands it. Today expanding fetches the body, which takes the blob path and is correct from the start; adding tier 0.5 there would paint sooner but would then correct itself visibly. Left alone: the expand is a deliberate act with a spinner, not a first paint.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Lex the eagerly-expanded rows' own patch text server-side, at list time | Measured: 72 ms across 8 cores, 93% of rows get a class, zero requests. The alternative is 31 blob fetches at ~0.6 s each | S:90 R:85 A:90 D:90 |
| 2 | Certain | It is a NEW RUNG below tier 1, not a replacement for the blob ladder | A hunk boundary genuinely lacks the context to lex correctly — that is why tier 1 has a context pad. The 7% must still be corrected | S:90 R:85 A:95 D:90 |
| 3 | Certain | `FileBody.refine` must NOT be set for seeded rows | `ReviewDiff` fires `onLoadRange()` on mount when refine is true, so a 31-file PR would issue 31 requests at once — the exact storm the list/body split prevents. Verified at review-diff.tsx's refine effect | S:95 R:80 A:95 D:95 |
| 4 | Certain | The upgrade path stays the client's existing viewport pump, unchanged | It is already viewport-driven and concurrency-bounded; it fires regardless of whether rows arrived coloured, so tier 0.5 needs no client mechanism of its own | S:85 R:90 A:90 D:90 |
| 5 | Certain | The lexing goes in `applyEagerBudget`, not `LineRowsFromPatch` | Tier 0 is plain by definition and is also the body path's starting point; colouring there would make tier 0 a lie and double-lex the body | S:85 R:85 A:90 D:90 |
| 6 | Certain | Runs break at every `RowHunk` | The header is not code, and rows either side of it are not contiguous in the file — lexing across the gap would carry state that does not belong | S:90 R:90 A:90 D:90 |
| 7 | Certain | A file with no Chroma lexer is left tier-0 plain, never an error | `lexerFor` returns nil for lockfiles and data files, which is the common case, and the ladder's whole posture is that colour degrades and never blocks | S:90 R:90 A:90 D:90 |
| 8 | Confident | One goroutine per file, unbounded beyond the budget's own `maxEagerFiles` = 75 | Measured 240 ms → 72 ms on 8 cores. 75 short-lived CPU goroutines needs no worker pool, and the cap already exists | S:70 R:85 A:85 D:75 |
| 9 | Confident | The payload roughly doubling is acceptable unpaired, and gzip stays in Phase 3 | Immaterial on localhost; real over Tailscale. Shipping colour now and compression next is the right order because colour is the user-visible half | S:60 R:85 A:80 D:70 |
| 10 | Confident | `highlighted` is set true on the seeded body | It is now true. No consumer reads it today, which argues for keeping it honest rather than for leaving it wrong | S:65 R:90 A:85 D:75 |
| 11 | Confident | The span-concatenation guard is the test that matters most | A lexer that drops or reorders a character is a rendering corruption, not a colour bug, and nothing else in the suite would catch it | S:70 R:85 A:85 D:80 |
| 12 | Confident | Collapsed files are not lexed | They have no rows; lexing them would cost the budget's whole point | S:80 R:90 A:90 D:85 |

12 assumptions. Grades are derived from the composite, not asserted.
