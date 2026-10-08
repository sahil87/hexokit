# Intake: hexokit-r1c-plan-doc-sync

**Change**: 260928-c5my-hexokit-r1c-plan-doc-sync
**Created**: 2026-09-28

## Origin

> Operator request (one-shot): after R1(c) (the shll roster flip) merges and ships, update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`'s R1 row: mark (c) done with the PR link + release version, and paste in the gate-verification evidence Sahil provided (the brew-upgrade verification, including the `opt/rk` dangling-symlink leftover). Separate small change in run-kit, own worktree off current main, own PR. Do not touch R1(d)/R2/X3 rows.

Sahil's gate evidence (verbatim substance): old formula run-kit 3.20.21 from sahil87/tap, pre-rename tap clone. After `brew update && brew upgrade` + `rk daemon restart`:
- brew migrated run-kit → hexokit 3.20.22 cleanly: `Cellar/run-kit` is Homebrew's compatibility symlink to hexokit; `brew info sahil87/tap/run-kit` resolves to hexokit with "Old Names: run-kit".
- hexokit, rk, xk, and run-kit on PATH all resolve to `Cellar/hexokit/3.20.22/bin/hexokit`; the daemon process runs that binary.
- C4 migrated `~/.config/run-kit` → `~/.config/hexokit` with `port: 3000` pinned; the daemon is still listening on :3000, so Tailscale kept working.
- Minor leftover, not a blocker: `opt/rk` is a dangling link (→ `Cellar/run-kit/3.20.21`) from the old rk → run-kit rename. Nothing in hook or agent configs references it; `brew cleanup` may prune it.

Facts established this session: R1(c) shipped as [shll#103](https://github.com/sahil87/shll/pull/103) (merged 2026-09-28, `4def30d`), released as [shll v0.1.34](https://github.com/sahil87/shll/releases/tag/v0.1.34) (Release workflow green; 4 tarballs; homebrew-tap commit `ac2d6cc` bumps `Formula/shll.rb` to 0.1.34; downloaded binary verified: `shll version` lists `hexokit v3.20.22`, `check-updates --json` resolves the `hexokit` row). Two cross-repo findings from R1(c): `versions.json` lives in hexokit-site (the "S3 envelope carry-over" is `help/run-kit.json` / the `run-kit` policy key / `refresh-help.yml` triple there); run-kit's `internal/updatecheck` `runKitTool = "run-kit"` must learn `hexokit`.

## Why

The plan doc is the coordination surface Sahil and other agents read for what's left in Phase 3. R1(c) is now shipped but the doc still says "(c)/(d) awaiting Sahil's OK", so a reader would re-attempt (c) or think the gate was never checked. Recording the gate evidence in the row keeps the rename's verification auditable, and noting the two cross-repo follow-ups prevents them being lost between R1(d) and X3.

## What Changes

### Row R1 (`hexokit-formula-bundle`)
- Scope cell: annotate **(c) DONE — shll#103, release shll v0.1.34** inline (same style as the (a)/(b) DONE annotations), summarizing what shipped (roster `Name`/`Formula`/`Update` → `hexokit`, `Repo` stays `run-kit` until R2, `LegacyNames {rk, run-kit}`, `rk`/`run-kit` target aliases, `hexokit agent setup` delegation, check-updates manifest legacy-key fallback). Record that `versions.json` is hexokit-site's (not a shll file), so the "retire the S3 envelope carry-over" item moves to (d)'s repo — stated as a note, (d)'s own text untouched.
- Replace the "**Gate before (c):**" sentence's open status with the gate evidence: verified 2026-09-28 by Sahil — the four bullets above, as compact prose in the cell (table cell; no line breaks).
- Add follow-up note: run-kit `app/backend/internal/updatecheck/updatecheck.go` `runKitTool = "run-kit"` must accept `hexokit` (shll ≥ v0.1.34 emits the self row as `hexokit`).
- Status column: "(a)+(b)+(c) done — shll v0.1.34 cut; (d) not started".
- **(d) text untouched.**

### Top "Where we are" / Status paragraphs
- Replace "R1(c)/(d) (shll roster + hexokit-site, awaiting Sahil's OK)" / "R1(c)/(d) awaiting Sahil's explicit OK" with R1(c) merged + shll v0.1.34 and R1(d) remaining.

### Order line
- `R1 (a,b done, awaiting OK for c)` → `R1 (a,b,c done; d next)`.

Nothing else changes: R1(d), R2, X3 rows and all other rows untouched.

## Affected Memory

None — `fab/plans/` is not memory or specs.

## Impact

One docs file in run-kit: `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. No code.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Mark R1(c) done with shll#103 + v0.1.34 and embed Sahil's gate evidence in the R1 row | Explicit operator instruction; facts verified this session | S:95 R:95 A:95 D:95 |
| 2 | Confident | Also update the top Status paragraphs and the Order line for (c) | Precedent s57a (#1056) updated the same three places; pickup protocol says update the Status line when finishing | S:75 R:95 A:85 D:80 |
| 3 | Confident | Record the two cross-repo follow-ups (hexokit-site envelope carry-over; run-kit updatecheck `runKitTool`) as notes in the R1 row, without editing (d)'s text | They are R1 findings a later reader needs; operator forbade editing (d)/R2/X3 rows, not annotating R1's own findings | S:70 R:95 A:80 D:75 |
| 4 | Certain | R1(d), R2, X3 rows untouched | Explicit operator instruction | S:95 R:95 A:95 D:95 |

4 assumptions (2 certain, 2 confident, 0 tentative, 0 unresolved).
