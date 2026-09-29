# Intake: hexokit-t2a-plan-doc-sync

**Change**: 260929-cybu-hexokit-t2a-plan-doc-sync
**Created**: 2026-09-29

## Origin

> Operator request (one-shot): after T2(a) ships and is released, update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`'s T2 row: mark (a) done with the PR link and release version, leave (b) not started. Separate small change in a fresh run-kit worktree off current main, its own tiny fab pipeline, its own PR — same pattern as the prior plan-doc-sync changes (s57a, c5my, 7u5c, jor0).

Facts established this session (T2(a) was done as shll fab change `6ywy`):
- [shll#105](https://github.com/sahil87/shll/pull/105) merged 2026-09-29 (`a8f11e2`).
- Released [shll v0.1.36](https://github.com/sahil87/shll/releases/tag/v0.1.36): release workflow green, 4 tarballs, homebrew-tap commit `480c83f` bumps `Formula/shll.rb` to 0.1.36; the downloaded linux-amd64 binary reports `shll version v0.1.36` and `shll install --dry-run hexokit` exits 0; raw `main` `scripts/install.sh` (what hexokit-site fetches at deploy) carries the upgrade step and still ends in `main "$@"` (the composer's anchor).
- What shipped: in the shll handoff, when shll is on PATH and `brew list --versions sahil87/tap/shll` succeeds (brew-managed), the script runs the capability-probed trust step (now a shared `trust_shll` helper) then `brew upgrade sahil87/tap/shll` before `shll install "$@"`. Fresh installs are unchanged; a non-brew shll on PATH is left alone; a failing upgrade aborts before `shll install`.
- Copilot review raised one point, skipped with reason: a non-brew shll that shadows a brew-installed one still drives the hand-off (its brew copy is upgraded underneath). That is a deliberate dev setup; documented in shll's `ci/install-bootstrap` memory.

## Why

The plan doc is the Phase 4 coordination surface, and T2 is strict-order: (b) in hexokit-site may start only once (a) is released. Recording (a) as done with the release version is what tells the next agent (b) is unblocked and which shll version it builds on.

## What Changes

### Row T2 (`install-update-path-cleanup`)
- Scope cell: prefix the `**(a) shll:** …` clause with **(a) DONE — [shll#105](https://github.com/sahil87/shll/pull/105) (merged 2026-09-29, `a8f11e2`), released [shll v0.1.36](https://github.com/sahil87/shll/releases/tag/v0.1.36)** and a compact summary of what shipped and how the release was verified (the facts above), in the style of the R1 row's DONE annotations. Leave the `(b)` clause text as is, noting it is unblocked (builds on shll v0.1.36).
- PR column: `[shll#105](https://github.com/sahil87/shll/pull/105)`.
- Status column: `**(a) done** — shll v0.1.36 released 2026-09-29; (b) not started`.

No other row, paragraph, or Order line changes (T1 runs in parallel and may edit this file too — a one-row diff keeps any merge conflict trivial).

## Affected Memory

None — `fab/plans/` is not memory or specs.

## Impact

One docs file in run-kit: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`, one table row. No code.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Mark T2(a) done with shll#105 and shll v0.1.36; (b) stays not started | Explicit operator instruction | S:95 R:95 A:95 D:95 |
| 2 | Certain | Only the T2 row changes | Explicit instruction scope; T1 edits in parallel | S:90 R:95 A:90 D:90 |
| 3 | Confident | Record release verification + the skipped Copilot point in the row | Mirrors the R1 row's DONE annotations; a later reader needs the evidence | S:75 R:95 A:85 D:80 |

3 assumptions (2 certain, 1 confident, 0 tentative, 0 unresolved).
