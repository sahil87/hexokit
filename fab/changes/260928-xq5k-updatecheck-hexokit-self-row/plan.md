# Plan: Updatecheck HexoKit Self-Row Match

**Change**: 260928-xq5k-updatecheck-hexokit-self-row
**Intake**: `intake.md`

## Requirements

### Backend: updatecheck self-row recognition

#### R1: The self row is matched by its primary or a legacy roster name
`internal/updatecheck` SHALL recognize this binary's own row in a `shll check-updates --json` report when its `name` is `hexokit` (the primary roster name, shll ≥ v0.1.34) OR one of the legacy names `rk` / `run-kit` (older shll). One predicate SHALL serve every self-row comparison site (`computeVerdicts`, `runKitFields`); no bare `"run-kit"` literal comparison against a tool name SHALL remain in the package's non-test code.

- **GIVEN** a report whose self row is `{name: "hexokit", installed: "3.8.0", latest: "3.9.0", notify: "minor", update_available: true, notable: true}` and a checker running `3.8.1` with `selfBrew=true`
- **WHEN** a released check pass runs
- **THEN** the `hexokit` verdict carries `Installed == "3.8.1"` (the RUNNING version), `Latest == "3.9.0"`, and locally-computed `UpdateAvailable && Notable`
- **AND** `Snapshot().Current/Latest == ("3.8.1", "3.9.0")` and `Key` contains `hexokit@3.9.0`

- **GIVEN** the same `hexokit` report and a checker with `selfBrew=false`
- **WHEN** a released check pass runs
- **THEN** no `hexokit` verdict is listed in `Tools` and none in `Matched`, even though shll's row says `update_available: true`

- **GIVEN** a self row named `run-kit` or `rk`
- **WHEN** a check pass runs
- **THEN** it is treated as the self row exactly as `hexokit` is

- **GIVEN** a row named `fab-kit`, `shll`, `""`, or `hexokit-x`
- **WHEN** the predicate is evaluated
- **THEN** it is not the self row

#### R2: The self verdict carries the name shll reported
The self-row `ToolVerdict.Tool` (and so `ToolUpdate.Tool`, the dismissal key pair, and the scoped `shll update` argv) SHALL be the roster name the report used (`tool.Name`), not a normalized constant.

- **GIVEN** a report whose self row is named `hexokit`
- **WHEN** the verdict is computed
- **THEN** the verdict's `Tool` is `hexokit`
- **AND** given a legacy report whose self row is `run-kit`, the verdict's `Tool` is `run-kit`

### Frontend: single-self-row chip wording

#### R3: `singleRunKit` recognizes every self-tool name
`useUpdateNotification`'s `singleRunKit` SHALL be true when the effective tool list is exactly one row whose `tool` is `hexokit`, `rk`, or `run-kit` (the same set as the backend), keeping the `⬆ v{latest}` chip form and `latest`/`current` population for a `hexokit` row.

- **GIVEN** an ambient `update-available` payload with one tool `{tool: "hexokit", current: "0.5.3", latest: "0.6.0"}`
- **WHEN** the top-bar update chip renders
- **THEN** its visible label is `⬆ v0.6.0` (not the count form)
- **AND** a single non-self tool (e.g. `fab-kit`) still uses the count form

### Plan doc

#### R4: The R1 follow-up note is marked done
The "Follow-up (run-kit, not yet filed)" updatecheck note in the R1 row of `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL be marked done, pointing at this fix (PR link added at ship), and the (d) note's dependency on "the follow-up above" SHALL note it is resolved in code (the hexokit-site `versions.json` key flip stays pending until a run-kit release carries the fix). No new plan row.

- **GIVEN** the plan doc after this change
- **WHEN** a reader looks at the R1 row
- **THEN** the updatecheck follow-up reads as done with a reference to this change/PR

### Non-Goals

- Renaming the exported `singleRunKit` field or the `runKitFields` helper — naming churn beyond the bug.
- Flipping hexokit-site's `versions.json` key — hexokit-site work, after a run-kit release.
- Migrating a previously-dismissed `run-kit@X` key to `hexokit@X` — a one-time re-show across the shll upgrade is accepted (intake #7).

### Design Decisions

#### Self row recognized by a name list, verdict keeps the reported name
**Decision**: A primary name (`hexokit`) plus a legacy-name slice (`rk`, `run-kit`) and one `isSelfTool` predicate; the self verdict's `Tool` is the name shll reported.
**Why**: Mirrors shll's own `Name` + `LegacyNames` for the tool so both shll generations match; passing the reported name through keeps the scoped `shll update` argv valid for whichever shll produced the report (`hexokit` is unknown to shll < v0.1.34; `run-kit` is only an alias on ≥ v0.1.34).
**Rejected**: Bumping the constant to `hexokit` alone (breaks users on older shll); normalizing to a single constant (argv/key disagree with the installed shll's roster); a roster struct (one name compared in two places).
*Introduced by*: 260928-xq5k-updatecheck-hexokit-self-row

## Tasks

### Phase 1: Core Implementation

- [x] T001 In `app/backend/internal/updatecheck/updatecheck.go`, replace `runKitTool` with a primary self-tool name `hexokit` + legacy-name slice `{"rk", "run-kit"}` and an `isSelfTool(name string) bool` predicate; use it in `computeVerdicts` (verdict `Tool: tool.Name`) and `runKitFields`; update the doc comments that describe the self row's name <!-- R1 R2 -->
- [x] T002 In `app/backend/internal/updatecheck/updatecheck_test.go`, add regression tests: a `hexokit`-named self row gets the local comparison against the running version, the legacy fields and `hexokit@…` key, and the `selfBrew=false` omission; a table test for `isSelfTool` (`hexokit`/`run-kit`/`rk` true; `fab-kit`/`shll`/`""`/`hexokit-x` false); keep the existing `run-kit` tests passing <!-- R1 R2 -->
- [x] T003 In `app/frontend/src/contexts/session-context.tsx`, replace `RUN_KIT_TOOL` with a `SELF_TOOL_NAMES` set (`hexokit`, `rk`, `run-kit`) and compute `singleRunKit` via `.has(...)`; add a `hexokit` single-row case to `app/frontend/src/components/top-bar.update-chip.test.tsx` asserting the `⬆ v{latest}` label <!-- R3 -->

### Phase 2: Polish

- [x] T004 In `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`, mark the R1 row's updatecheck "Follow-up (run-kit, not yet filed)" note done (change `260928-xq5k`, PR link at ship) and note the (d) dependency is resolved in code <!-- R4 -->
- [x] T005 Run gates: `env -u TMUX -u TMUX_PANE go test ./internal/updatecheck/ ./api/` then `go test ./...` in `app/backend`; `npx tsc --noEmit` and `just test-frontend` in `app/frontend` <!-- R1 R2 R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `isSelfTool` returns true for `hexokit`, `run-kit`, `rk` and false for other names; it is the only self-row comparison in `updatecheck.go` non-test code
- [x] A-002 R2: The self verdict's `Tool` equals the report's `tool.Name`
- [x] A-003 R3: `singleRunKit` is true for a single `hexokit`, `rk`, or `run-kit` row
- [x] A-004 R4: The plan doc's R1 updatecheck follow-up is marked done; no new plan row was added

### Scenario Coverage

- [x] A-005 R1: A test feeds a `hexokit`-named self row and asserts the running-version comparison, legacy `Current`/`Latest`, and a `hexokit@3.9.0` key
- [x] A-006 R1: A test asserts a `hexokit` self row is omitted when `selfBrew=false`
- [x] A-007 R3: A frontend test asserts the `⬆ v{latest}` chip label for a single `hexokit` row

### Edge Cases & Error Handling

- [x] A-008 R1: Legacy `run-kit`-named reports still behave as before (existing tests pass unchanged); near-miss names (`hexokit-x`) are not matched

### Code Quality

- [x] A-009 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-010 No unnecessary duplication: one predicate/set per side; no repeated name literals at call sites
- [x] A-011 Magic strings: the self-tool names are named constants/vars, not inline literals at comparison sites
- [x] A-012 Comments state constraints (why the legacy names exist), no change-ID/PR narration in code comments
- [x] A-013 Tests: the bug fix includes regression tests covering the changed behavior

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change replaces the `runKitTool` constant and `RUN_KIT_TOOL` literal in place; no existing code was left redundant or unused.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Frontend regression test lives in `top-bar.update-chip.test.tsx` | It already owns the single-run-kit chip-label cases (`⬆ v{latest}`); the rendered label is the user-visible contract | S:80 R:95 A:90 D:85 |
| 2 | Confident | Leave `testdata/check-updates.json` on the legacy `run-kit` name; new `hexokit` tests use inline reports | Keeps the existing fixture-based tests exercising the legacy path unchanged while inline reports cover the new name | S:60 R:90 A:80 D:65 |

2 assumptions (1 certain, 1 confident, 0 tentative).
