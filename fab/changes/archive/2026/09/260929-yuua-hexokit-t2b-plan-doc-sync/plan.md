# Plan: hexokit-t2b-plan-doc-sync

**Change**: 260929-yuua-hexokit-t2b-plan-doc-sync
**Intake**: `intake.md`

## Requirements

### Plan doc: T2 row and status paragraph

#### R1: T2(b) is recorded as done with its PR and deploy evidence
The T2 row in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL mark (b) DONE with [hexokit-site#14](https://github.com/sahil87/hexokit-site/pull/14) (merged `ebfb454`, fab change `x2a2`), a compact summary of what shipped and how the deploy was verified, the PR column listing shll#105 and hexokit-site#14, and the Status column reading done for both steps. The (a) annotation stays unchanged.

- **GIVEN** a reader checking Phase 4 progress
- **WHEN** they read the T2 row
- **THEN** they see (a) and (b) done, with PR links, the release, and the live-deploy verification

#### R2: The "Where we are" carry-over sentence states present truth
The sentence saying two R1 compatibility carry-overs "stay on purpose until their follow-ups land" SHALL be replaced by one stating both are resolved by T2.

- **GIVEN** the top status paragraph
- **WHEN** it is read after this change
- **THEN** it no longer claims the `run-kit`-only manifest row or the `/install` stale-shll fallback is still in place

#### R3: Nothing else in the file changes
Only the T2 row and that sentence SHALL change.

- **GIVEN** the diff of this change
- **WHEN** it is inspected
- **THEN** it touches only those two spots of the plan doc (plus this change's own `fab/changes/` folder)

## Tasks

### Phase 1: Bookkeeping edit

- [x] T001 Annotate the T2 row's (b) clause with DONE + summary + verification; set PR and Status cells in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` <!-- R1 -->
- [x] T002 Rewrite the "Where we are" carry-over sentence in the same file <!-- R2 -->
- [x] T003 Verify the diff touches only those two spots <!-- R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: T2 row shows (b) DONE with hexokit-site#14 link + `ebfb454`, PR cell lists shll#105 and hexokit-site#14, Status = done for (a) and (b); (a) text unchanged
- [x] A-002 R2: the status paragraph states both R1 carry-overs are resolved by T2
- [x] A-003 R3: `git diff origin/main -- fab/plans/` changes only the T2 row and the carry-over sentence

### Code Quality

- [x] A-004 Pattern consistency: annotation style matches the (a) DONE annotation in the same row
- [x] A-005 No unnecessary duplication: no restated evidence outside the T2 row

## Notes

- Check items as you review: `- [x]`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Two-spot diff only | Intake decision; T1 may edit the same file in parallel | S:90 R:95 A:90 D:90 |

1 assumptions (1 certain, 0 confident, 0 tentative).
