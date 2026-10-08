# Plan: hexokit-t2a-plan-doc-sync

**Change**: 260929-cybu-hexokit-t2a-plan-doc-sync
**Intake**: `intake.md`

## Requirements

### Plan doc: T2 row

#### R1: T2(a) is recorded as done with its PR and release
The T2 row in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL mark (a) DONE with [shll#105](https://github.com/sahil87/shll/pull/105) (merged `a8f11e2`) and [shll v0.1.36](https://github.com/sahil87/shll/releases/tag/v0.1.36), a compact summary of what shipped and how the release was verified, the PR column set to shll#105, and the Status column reading (a) done / (b) not started.

- **GIVEN** a reader deciding whether T2(b) may start
- **WHEN** they read the T2 row
- **THEN** they see (a) done, released as shll v0.1.36, and (b) not started and unblocked

#### R2: Nothing else in the file changes
Only the T2 row SHALL change; (b)'s scope text stays as is apart from an unblocked note.

- **GIVEN** the diff of this change
- **WHEN** it is inspected
- **THEN** it touches one line of the plan doc (plus this change's own `fab/changes/` folder)

## Tasks

### Phase 1: Bookkeeping edit

- [x] T001 Annotate the T2 row's Scope cell with (a) DONE + summary + verification; set PR and Status cells in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` <!-- R1 -->
- [x] T002 Verify the diff touches only the T2 row <!-- R2 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: T2 row shows (a) DONE with shll#105 + shll v0.1.36 links, PR cell = shll#105, Status = (a) done, (b) not started
- [x] A-002 R2: `git diff main -- fab/plans/` changes exactly one line (the T2 row)

### Code Quality

- [x] A-003 Pattern consistency: annotation style matches the R1 row's DONE annotations
- [x] A-004 No unnecessary duplication: no restated evidence outside the T2 row

## Notes

- Check items as you review: `- [x]`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | One-line diff to the T2 row only | Intake decision; T1 edits the same file in parallel | S:90 R:95 A:90 D:90 |

1 assumptions (1 certain, 0 confident, 0 tentative).
