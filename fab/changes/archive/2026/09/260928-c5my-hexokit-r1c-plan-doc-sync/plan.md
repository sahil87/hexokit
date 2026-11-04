# Plan: hexokit-r1c-plan-doc-sync

**Change**: 260928-c5my-hexokit-r1c-plan-doc-sync
**Intake**: `intake.md`

## Requirements

### Plan doc: R1 bookkeeping

#### R1: R1 row records (c) as done with its evidence
The R1 row in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL annotate **(c) DONE** with the shll PR link (shll#103), merge SHA, and release (shll v0.1.34 with its verification), summarize what shipped, note that `versions.json`/the S3 envelope carry-over is hexokit-site work, record the run-kit `updatecheck` `runKitTool` follow-up, and replace the open "Gate before (c)" status with Sahil's verification evidence — including the `opt/rk` dangling-link leftover. The PR column links shll#103; the Status column reads (a)+(b)+(c) done, (d) not started. The (d) scope text SHALL be unchanged.

- **GIVEN** the plan doc after the edit
- **WHEN** a reader looks at row R1
- **THEN** (c) is marked DONE with shll#103 + v0.1.34 and the gate evidence is present verbatim in substance
- **AND** (d)'s text is byte-identical to before

#### R2: Doc-level summaries agree with the row
The "Where we are" paragraph, the Status paragraph (dated 2026-09-28), and the Order line SHALL state R1(c) done and R1(d) remaining.

- **GIVEN** the edited doc
- **WHEN** reading the summaries
- **THEN** none still says R1(c) is awaiting Sahil's OK

### Non-Goals

- R1(d), R2, X3 rows — untouched per operator instruction.
- Filing the run-kit `updatecheck` follow-up — recorded only.

## Tasks

### Phase 1: Bookkeeping edit

- [x] T001 Annotate R1 row's Scope cell with (c) DONE + evidence, gate verification, follow-ups; set PR and Status cells in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` <!-- R1 -->
- [x] T002 Update "Where we are", the Status paragraph (date → 2026-09-28), and the Order line in the same file <!-- R2 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: R1 row shows (c) DONE with shll#103, `4def30d`, shll v0.1.34 and the release verification
- [x] A-002 R1: Gate sentence carries Sahil's four verification points including the `opt/rk` dangling link and `brew cleanup` note
- [x] A-003 R1: (d) text is byte-identical to before; R2 and X3 rows unchanged
- [x] A-004 R2: Where-we-are, Status, and Order line all say R1(c) done, R1(d) remaining

### Code Quality

- [x] A-005 Pattern consistency: annotation style matches the existing "(a) DONE — …" / "**merged** …" vocabulary
- [x] A-006 **N/A**: docs-only bookkeeping edit, no code

## Notes

- Check items as you review: `- [x]`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Put shll#103 in R1's previously empty PR column | Other rows link their PR there; improves discoverability without touching (d) | S:70 R:95 A:85 D:80 |

1 assumption (0 certain, 1 confident, 0 tentative).
