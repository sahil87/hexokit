# Intake: hexokit-t2b-plan-doc-sync

**Change**: 260929-yuua-hexokit-t2b-plan-doc-sync
**Created**: 2026-09-29

## Origin

> Operator request (one-shot): after T2(b) merges, update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`'s T2 row to mark (a) AND (b) done. T2(a)'s own plan-doc PR (hexokit#1065, fab change `cybu`) already recorded (a) and is merged on main — add the (b) evidence to the same row, based on current main. Separate small change in a fresh run-kit worktree off current main, its own tiny fab pipeline, its own PR — same pattern as the prior plan-doc-sync changes (s57a, c5my, 7u5c, jor0, cybu).

Facts established this session (T2(b) was done as hexokit-site fab change `x2a2`):
- [hexokit-site#14](https://github.com/sahil87/hexokit-site/pull/14) merged 2026-09-29 (`ebfb454`). CI green; one Copilot comment (stale `deployment.md` memory line saying the product row "stays keyed `run-kit`") fixed.
- What shipped: `scripts/install-epilogue.sh` no-arg path is plain `set -- hexokit` — the `shll install --dry-run hexokit` probe and the `run-kit` fallback are gone (a test proves an installed stub shll is never invoked); the frozen upstream fixture is refreshed to shll `a8f11e2`. `versions-policy.json` gains `"hexokit": { "notify": "minor" }` with the `run-kit` entry byte-identical, so `/versions.json` publishes identical `hexokit` and `run-kit` rows from `help/hexokit.json` (a test pins the committed `run-kit` entry). Spec `versions-manifest-contract.md` + memory updated.
- Accepted gap: a non-brew stale shll on PATH (a `just install` dev build) is not upgraded by the bootstrap and would now reject `hexokit` — maintainer-only.
- Deploy verified: hexokit-site Deploy run `36525991590` green; live `https://hexokit.com/versions.json` has `hexokit` and `run-kit` both `{ latest: 3.20.22, notify: minor, formula: hexokit }`; live `https://hexokit.com/install` has `set -- hexokit`, no probe, and the upstream `brew upgrade sahil87/tap/shll` step. No help refresh was needed (versions.json is built at deploy; `help/*.json` unchanged). shll.ai's byte copies lag by up to a day (its own daily 09:13 UTC Pages deploy), so `sahil87/shll.ai` Deploy was dispatched once (run `36526126389`, green); `shll.ai/install` and `shll.ai/versions.json` are now byte-identical to hexokit.com's.

## Why

The plan doc is the Phase 4 coordination surface. With (b) merged and deployed, T2 is complete; the row should say so with its evidence. The top "Where we are" paragraph still says two R1 compatibility carry-overs "stay on purpose until their follow-ups land" (the `run-kit`-only `versions.json` row and the stale-shll `/install` fallback) — both are now resolved by T2, so that sentence is false and must be corrected.

## What Changes

### Row T2 (`install-update-path-cleanup`)
- Scope cell: turn the `**(b) hexokit-site, after (a) is released — unblocked, builds on shll v0.1.36:**` clause into **(b) DONE — [hexokit-site#14](https://github.com/sahil87/hexokit-site/pull/14) (merged 2026-09-29, `ebfb454`, fab change `x2a2`):** followed by the original (b) task text and a compact summary of what shipped + deploy verification (the facts above), in the style of the (a) annotation. Leave the (a) text unchanged.
- PR column: `[shll#105](https://github.com/sahil87/shll/pull/105), [hexokit-site#14](https://github.com/sahil87/hexokit-site/pull/14)`.
- Status column: `**done** — (a) shll v0.1.36 released 2026-09-29; (b) merged + deployed 2026-09-29`.

### "Where we are" paragraph (lines ~21–25)
Replace "Two compatibility carry-overs from R1 stay on purpose until their follow-ups land (… — see the R1 row)." with a present-truth sentence: the two R1 compatibility carry-overs (the `run-kit`-keyed `versions.json` row and hexokit-site's stale-shll `run-kit` fallback in `/install`) are resolved by Phase 4 row T2 — `/install` always passes `hexokit`, and `versions.json` publishes both a `hexokit` and the legacy `run-kit` row. Nothing else in the paragraph changes.

No other row, the R2 follow-ups list, or the Order line changes (T1 may edit this file in parallel — keep the diff to these two spots).

## Affected Memory

None — `fab/plans/` is not memory or specs.

## Impact

One docs file in run-kit: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (T2 row + one sentence). No code.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Mark T2(b) done with hexokit-site#14 and deploy evidence; T2 status done | Explicit operator instruction; (a) already recorded by merged #1065 | S:95 R:95 A:95 D:95 |
| 2 | Confident | Also correct the "Where we are" carry-over sentence | It is now false; present-truth coordination doc; one-sentence edit | S:75 R:95 A:85 D:80 |
| 3 | Certain | Leave the historical R2 follow-ups list untouched | It already points to Phase 4 rows; history is not rewritten (D11) | S:85 R:95 A:90 D:85 |

3 assumptions (2 certain, 1 confident, 0 tentative, 0 unresolved).
