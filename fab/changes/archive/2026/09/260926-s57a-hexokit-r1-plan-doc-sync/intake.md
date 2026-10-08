# Intake: hexokit-r1-plan-doc-sync

**Change**: 260926-s57a-hexokit-r1-plan-doc-sync
**Created**: 2026-09-26

## Origin

> Team lead request: update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`
> bookkeeping after C5 (run-kit#1054, hexokit daemon port) merged and R1(a)/(b)
> (homebrew-tap PR#6, run-kit#1055, release v3.20.22) landed. Mark C5's Notes
> as merged, annotate R1(a)/(b) as done inline (leaving (c)/(d) untouched —
> (c) explicitly gated on Sahil's sign-off), update the Order line and the
> doc's top Status summary to match. Docs-only bookkeeping, no product code
> touched.

## Why

The plan doc is the single source of truth other agents (and Sahil) read to
know what's left before Phase 3 closes. C5 merged and R1(a)/(b) shipped since
the doc was last updated (still says C5 "in review" and R1 "not started"),
so anyone reading it would misjudge remaining work and could re-attempt
already-done steps or misreport status upstream. Fixing the bookkeeping in
place (rather than leaving it to the next full-row rewrite) keeps the doc
trustworthy as the coordination surface it's used as.

## What Changes

### Row C5 (`hexokit-daemon-port`)
- Notes/Status cell changes from "in review — fab change
  `260926-wyey-hexokit-daemon-port`; release-notes draft below for R1" to
  "**merged**" (matching the "**merged** 2026-09-26 (`sha`) — ..." pattern
  used by rows R0/C4 in this same table). Result/PR link column already
  correct ([run-kit#1054]) — untouched.

### Row R1 (`hexokit-formula-bundle`)
- Annotate inline within the existing Scope cell text (not a rewrite):
  prefix/append "(a) DONE — homebrew-tap PR#6" and "(b) DONE — run-kit
  PR#1055, release v3.20.22 (carries R0+C4+C5+R1b), tap push confirmed
  (homebrew-tap commit `747f7d2`, Formula/hexokit.rb now real hashes)".
  Leave (c) and (d) text and the "Gate before (c)" sentence exactly as
  written — no implied readiness.
- Update the Result/link column and last Status column from "not started" to
  something reflecting partial completion, e.g. "(a)+(b) merged, release
  v3.20.22 cut — (c)/(d) awaiting Sahil's OK" — matching this doc's existing
  vocabulary for partially-done rows (no exact precedent row exists yet, so
  this phrasing is new but consistent in tone with R0/C4/C5's own Notes
  style).

### Order line (~line 74)
- Currently: `Order: ~~(P1 ∥ P2 ∥ P3)~~ done · A1 → (A2) → A3 → *[Sahil's
  call]* → ~~R0~~ → ~~C4~~ → C5 → R1 · R2 (any time after A3) → X3.`
- Strike through `C5` (`~~C5~~`) since it's merged.
- Annotate `R1` to show partial completion, e.g. `R1 (a,b done, awaiting OK
  for c)` — keep the existing strikethrough convention for fully-done items.

### Top Status line/section (~line 18-25)
- Update to state: R0/C4/C5 merged; R1(a)/(b) merged + release v3.20.22 cut;
  R1(c)/(d) awaiting Sahil's explicit OK; R2 not started; X3 not started.
  Keep existing sentence structure/tone (e.g. "**Status (2026-09-26)**:
  ..." pattern already used).

No other rows, no risks/pickup-protocol sections, no other files touched.

## Affected Memory

(none — implementation-only doc bookkeeping; the plan file itself is the
artifact being updated, not `docs/memory/` or `docs/specs/`)

## Impact

- `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` only.
- No code, no tests, no CI-relevant files.

## Open Questions

(none)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Only touch C5 row, R1 row, Order line, and top Status line/section — no other edits | Explicit team-lead instruction enumerates exactly these four edits | S:95 R:90 A:95 D:95 |
| 2 | Certain | Do not mark or imply readiness for R1(c) | Explicit instruction — (c) is gated on Sahil's sign-off per the doc's own "Gate before (c)" sentence, which stays untouched | S:95 R:95 A:95 D:95 |
| 3 | Confident | New Result/status phrasing for R1's partial-completion state ("(a)+(b) merged... awaiting Sahil's OK") has no exact precedent row in this doc but should match the tone of R0/C4/C5's own "**merged** — ..." Notes style | No row in this doc is currently in a genuinely partial (some sub-items done, others gated) state, so some new phrasing is unavoidable; kept consistent with surrounding style | S:65 R:85 A:80 D:70 |

3 assumptions (2 certain, 1 confident, 0 tentative, 0 unresolved).
