# Plan: hexokit-r1d-plan-doc-sync

**Change**: 260928-7u5c-hexokit-r1d-plan-doc-sync
**Intake**: `intake.md`

## Requirements

### Plan doc: R1 row

#### R1: R1 row reads fully done
The R1 row in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL mark (d) DONE with [hexokit-site#11](https://github.com/sahil87/hexokit-site/pull/11) and a compact summary of what shipped, record the partial envelope carry-over outcome (triple flipped; `run-kit` policy key + envelope kept, gated on run-kit updatecheck accepting `hexokit`) and the shll bootstrap follow-up, list hexokit-site#11 in the PR cell, and show Status **done** for (a)–(d).

- **GIVEN** the plan doc **WHEN** a reader scans the R1 row **THEN** (a), (b), (c), (d) all read DONE with their PRs, and the Status cell says done

#### R2: Summaries reflect R1 complete
"Where we are", the Status paragraph, and the Order line SHALL say R1 is complete, leaving only R2 (repo rename) and X3.

- **GIVEN** the top of the doc **WHEN** read **THEN** no sentence says R1(d) is pending

### Non-Goals

- R2, X3 and other rows — untouched

## Tasks

### Phase 1: Bookkeeping edit

- [x] T001 Annotate R1 row's Scope cell with (d) DONE + summary + follow-ups; set PR and Status cells in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` <!-- R1 -->
- [x] T002 Update "Where we are", the Status paragraph, and the Order line in the same file <!-- R2 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: R1 row shows (d) DONE with hexokit-site#11 and the shipped summary; (a)/(b)/(c) text unchanged
- [x] A-002 R1: Row records the kept `run-kit` versions key/envelope (gated on run-kit updatecheck) and the shll bootstrap follow-up
- [x] A-003 R1: PR cell lists shll#103 and hexokit-site#11; Status cell says done; R2 and X3 rows unchanged
- [x] A-004 R2: Where-we-are, Status, and Order line all say R1 complete

### Code Quality

- [x] A-005 Pattern consistency: annotation style matches the existing "(c) DONE — …" vocabulary
- [x] A-006 **N/A**: docs-only bookkeeping edit, no code

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Strike R1 in the Order line (`~~R1~~`) | Matches the struck-through done items (`~~R0~~ → ~~C4~~ → ~~C5~~`) | S:80 R:95 A:90 D:85 |

1 assumptions (0 certain, 1 confident, 0 tentative).
