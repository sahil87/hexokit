# Intake: hexokit-r1d-plan-doc-sync

**Change**: 260928-7u5c-hexokit-r1d-plan-doc-sync
**Created**: 2026-09-28

## Origin

> Operator request (one-shot): update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`'s R1 row: mark (d) done with the PR link. The whole R1 row (a)(b)(c)(d) should now read as fully merged/done — also flip the Order line and the Status summary near the top to reflect R1 fully complete. Separate small change in a fresh run-kit worktree off current main, its own tiny fab pipeline, its own PR — same pattern as the prior plan-doc-sync changes (s57a #1056, c5my #1058).

Facts established this session (R1(d) was done as hexokit-site change `u7sp`, [hexokit-site#11](https://github.com/sahil87/hexokit-site/pull/11), CI green; the operator merges it):
- The landing's `brew install sahil87/tap/hexokit` line was already live (hexokit-site `293e76b`); nothing to change there.
- `hexokit.com/install` no-arg default → `hexokit`, with a compatibility guard: when an installed shll rejects `hexokit` (`shll install --dry-run hexokit` fails — shll ≤ v0.1.33, reproduced), the epilogue passes the legacy `run-kit` instead, because the upstream shll bootstrap does not upgrade an installed shll before `shll install`.
- hexokit-site tool roster + `refresh-help.yml` triple → `hexokit:hexokit:hexokit` (formula/binary); repo stays `run-kit` until R2.
- `versions.json`: the `run-kit` **key and `envelope: hexokit` are kept** (run-kit's `updatecheck` `runKitTool = "run-kit"` and shll ≤ v0.1.33 read that key); only `formula` → `hexokit`. So the "Found at (c)" item "retire the S3 envelope carry-over" is only partly done: the triple flipped; the policy key/envelope stay until run-kit's updatecheck accepts `hexokit`.
- Docs copy, landing terminal card (`hexokit` primary; `rk`/`xk`/`run-kit` aliases), and stale comments relabelled. Also fixed extract-readme tests that went red on main after the 2026-09-28 help refresh began emitting `tool: hexokit` (CI does not run on puller commits).
- Deploy: GitHub Pages `Deploy` workflow on push to main — the live site updates on merge.

## Why

The plan doc is the Phase 3 coordination surface. With (d) shipped, R1 is complete; leaving "(d) not started" makes a reader re-attempt it. The two carried follow-ups (shll bootstrap upgrade; run-kit updatecheck `hexokit` + then the versions key flip) must stay visible so they're not lost before X3.

## What Changes

### Row R1 (`hexokit-formula-bundle`)
- Scope cell: replace the `**(d)** hexokit-site: …` clause with **(d) DONE — [hexokit-site#11](https://github.com/sahil87/hexokit-site/pull/11)** plus a compact summary of what shipped (the facts above), same style as the (a)/(b)/(c) DONE annotations. Note the partial envelope-carry-over outcome (triple flipped; `run-kit` policy key + envelope kept, gated on run-kit updatecheck) and add the shll follow-up (bootstrap should `brew upgrade` an installed shll before `shll install`; then the stale-shll fallback can be dropped).
- PR column: add hexokit-site#11 alongside shll#103.
- Status column: "**done** — (a)+(b)+(c)+(d) merged; release v3.20.22 (run-kit), shll v0.1.34".

### Top "Where we are" / Status paragraphs
- "Where we are": R1 done in full; still on the old name: only the GitHub repo `sahil87/run-kit` (R2).
- Status: R1(d) merged ([hexokit-site#11]) → R1 complete; R2 and X3 not started.

### Order line
- `R1 (a,b,c done; d next)` → `~~R1~~`.

R2 and X3 rows and every other row untouched.

## Affected Memory

None — `fab/plans/` is not memory or specs.

## Impact

One docs file in run-kit: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. No code.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Mark R1(d) done with hexokit-site#11 and R1 as fully done | Explicit operator instruction (operator merges #11) | S:95 R:95 A:95 D:95 |
| 2 | Certain | Update the Where-we-are, Status paragraphs and the Order line | Explicit operator instruction; precedent s57a/c5my | S:95 R:95 A:90 D:90 |
| 3 | Confident | Record the partial envelope carry-over outcome and the two follow-ups in the R1 row | R1 findings a later reader needs; mirrors c5my's "Found at (c)" practice | S:75 R:95 A:85 D:80 |
| 4 | Certain | R2, X3 and other rows untouched | Scope of the request | S:95 R:95 A:95 D:95 |

4 assumptions (3 certain, 1 confident, 0 tentative, 0 unresolved).
