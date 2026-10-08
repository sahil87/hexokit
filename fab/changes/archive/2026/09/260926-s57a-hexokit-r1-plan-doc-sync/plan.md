# Plan: hexokit-r1-plan-doc-sync

**Change**: 260926-s57a-hexokit-r1-plan-doc-sync
**Intake**: `intake.md`

## Requirements

### Plan doc: bookkeeping sync

#### R1: C5 row reflects merged status
The C5 (`hexokit-daemon-port`) row's status cell SHALL read "**merged**" instead of "in review", matching the Notes-column style already used by rows R0/C4 in the same table.

- **GIVEN** C5's PR [run-kit#1054](https://github.com/sahil87/run-kit/pull/1054) has merged
- **WHEN** the plan doc's C5 row is read
- **THEN** its status cell states the row is merged, and the existing PR link is left untouched

#### R2: R1 row shows (a)/(b) done, (c)/(d) untouched
The R1 (`hexokit-formula-bundle`) row's Scope cell SHALL be annotated inline to mark (a) and (b) as done, and its status cell SHALL move from "not started" to a partial-completion phrasing — without altering the (c)/(d) text or the existing "Gate before (c)" sentence.

- **GIVEN** homebrew-tap PR#6 and run-kit PR#1055 (release v3.20.22) have merged, and (c)/(d) are still gated on Sahil's sign-off
- **WHEN** the plan doc's R1 row is read
- **THEN** (a) and (b) are marked DONE inline in the Scope cell, (c) and (d) text is unchanged, and the status cell reads a partial-completion state naming that (c)/(d) await Sahil's OK

#### R3: Order line reflects C5 done and R1 partial
The Order summary line SHALL strike through `C5` and annotate `R1` with its partial-completion state, using the doc's existing strikethrough convention.

- **GIVEN** C5 merged and R1(a)/(b) merged while R1(c)/(d) remain pending
- **WHEN** the Order line is read
- **THEN** `C5` is struck through and `R1` carries an inline annotation showing (a,b) done and (c) awaiting sign-off

#### R4: Top Status summary matches row-level state
The doc's top "Status" line/section SHALL summarize: R0/C4/C5 merged; R1(a)/(b) merged with release v3.20.22 cut; R1(c)/(d) awaiting Sahil's explicit OK; R2 not started; X3 not started.

- **GIVEN** the row-level edits above (R1, R2, R3)
- **WHEN** the top Status summary is read
- **THEN** its wording matches the current per-row state with no stale "in review" or "not started" claims for C5/R1(a)/(b)

## Tasks

### Phase 1: Bookkeeping edit

- [x] T001 Update C5 row status cell in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` to "**merged**" <!-- R1 -->
- [x] T002 Annotate R1 row's Scope cell (a)/(b) as DONE inline and update its Result/status cell to a partial-completion phrasing, leaving (c)/(d) text untouched <!-- R2 -->
- [x] T003 Update the Order line (~line 74): strike through `C5`, annotate `R1` with its partial-completion state <!-- R3 -->
- [x] T004 Update the top Status line/section (~lines 18-25) to reflect R0/C4/C5 merged, R1(a)/(b) merged + v3.20.22 cut, R1(c)/(d) awaiting Sahil's OK, R2/X3 not started <!-- R4 -->

## Execution Order

- T001–T004 touch disjoint regions of the same file; order doesn't matter but T004 is easiest to write last since it summarizes T001–T003.

## Acceptance

### Functional Completeness

- [x] A-001 R1: C5 row's status cell reads "**merged**"; its existing PR link is unchanged
- [x] A-002 R2: R1 row's Scope cell shows (a) and (b) annotated DONE inline; (c) and (d) text and the "Gate before (c)" sentence are byte-identical to before
- [x] A-003 R3: Order line shows `~~C5~~` and an annotated `R1`
- [x] A-004 R4: Top Status summary names R0/C4/C5 merged, R1(a)/(b) merged + v3.20.22, R1(c)/(d) awaiting Sahil's OK, R2 and X3 not started

### Behavioral Correctness

- [x] A-005 R2: No wording anywhere implies (c) or (d) are ready, in progress, or approved

### Code Quality

- [x] A-006 Pattern consistency: new status phrasing matches the doc's existing "**merged** — ..." / "**in progress**" / "not started" vocabulary
- [x] A-007 **N/A**: docs-only bookkeeping edit, no code

## Notes

- Docs-only change: no source files, no tests, no CI-relevant surface touched beyond the one plan doc.
- `change_type: docs` — parsimony pass and deletion-candidate section are skipped per the plan template's docs/chore/ci carve-out.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope limited to the 4 requirements above; no other rows/sections edited | Matches team-lead's explicit 4-part instruction and the intake's What Changes section | S:95 R:90 A:95 D:95 |
| 2 | Confident | Exact new phrasing for R1's partial-completion status cell chosen to mirror surrounding "**merged** — ..." style rather than invent new vocabulary | No identical precedent exists in the doc for a partial (some sub-items done, others gated) row; picked the closest stylistic match | S:65 R:85 A:80 D:70 |

2 assumptions (1 certain, 1 confident, 0 tentative).
