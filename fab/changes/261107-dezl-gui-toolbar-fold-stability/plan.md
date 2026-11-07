# Plan: Deterministic gui header-fold e2e suite

**Change**: 261107-dezl-gui-toolbar-fold-stability
**Intake**: `intake.md`

## Requirements

### E2E stability: Diagnose before fixing

R1: The fix SHALL be preceded by an instrumented reproduction that names the mechanism behind each observed failure mode — (a) `spring did not converge`, (b) unexpected fold at a `full + cap + 40` target, (c) missing label degradation at a mid-band target — with evidence (logged viewport/spring/widths, fold state at the failing assertion). The implemented fix SHALL address the named mechanisms.

- **GIVEN** the spec run locally with retries off and instrumentation of `measureFold` inputs and the rendered fold state
- **WHEN** a failure mode reproduces
- **THEN** it is attributed to a specific mechanism (convergence arithmetic, target margins vs. boundaries, non-atomic re-fit, or meta-chip variance) with the captured evidence, recorded in the apply result

### E2E stability: Deterministic spring targeting

R2: The spec's spring targeting SHALL land deterministically and assert inside stable bands. The viewport↔spring overhead SHALL be made constant for the test (pin the header meta chip's width via injected CSS or an equivalent test-only mechanism), the landed spring SHALL be verified before dependent assertions run, and assertion targets SHALL sit at band midpoints (or carry margins scaled to the real inputs — the 24px expand-edge hysteresis, the pinned-block reserve, measured probe widths) instead of fixed small offsets from fold boundaries.

- **GIVEN** a pinned-width meta chip and a target spring S
- **WHEN** the viewport is resized by the computed delta
- **THEN** the landed spring equals S within a tolerance the test verifies before asserting fold state
- **GIVEN** a fold band `[lo, hi]` bounded by measured widths
- **WHEN** the test targets the band
- **THEN** it aims at the band's midpoint, and any widening-back target sits at least `GUI_TOOLBAR_FOLD_HYSTERESIS_PX` (24) past the boundary on the expand edge

### E2E stability: Component arm only on evidence

R3: IF AND ONLY IF R1's diagnosis proves the component's non-atomic `ResizeObserver` re-fit is causal (an assertion reads a DOM state that never re-fits, not merely a late one), the measure path in `components/gui-toolbar.tsx` SHALL re-fit synchronously with the spring's resize; the fold's documented invariants (jsdom cold default, one-sided hysteresis, two-pass `⚙` reserve) and its unit suites SHALL be preserved. Otherwise this requirement is satisfied vacuously and the apply result records the diagnostic evidence that cleared the component.

- **GIVEN** diagnosis evidence that a post-resize assertion observed a never-re-fitted DOM
- **WHEN** the component arm runs
- **THEN** the re-fit lands in the same frame as the spring resize and `gui-toolbar-fold.test.ts` + `gui-toolbar.test.tsx` pass unchanged

### Proof coverage: No weakened proofs

R4: All four proof areas SHALL remain covered at real viewport widths after the rework — (1) tail-first ladder fold with `⚙` appearing/disappeaping and the panel carrying folded rows, (2) label degradation (quality, then size) before any fold, (3) `rk-gui-toolbar` panel-state persistence across reload, (4) fullscreen targeting the tile. No assertion SHALL be deleted or converted to jsdom/unit coverage in place of the real-width proof; Playwright-level retries SHALL NOT be added as a substitute for determinism.

- **GIVEN** the reworked spec
- **WHEN** review compares its proof surface against this list
- **THEN** every area is still proven at real widths with equivalent or stronger assertions

### E2E stability: Repeated-run determinism

R5: The suite SHALL pass under repeated execution without retries: `just test-e2e gui-toolbar-fold --repeat-each 5 --retries 0` passes 20/20 locally, and the sibling measured-fold specs plus the gui toolbar unit suites pass unchanged.

- **GIVEN** a clean rig
- **WHEN** the spec runs 20 times (5 tests × `--repeat-each 5`) with retries disabled
- **THEN** all 20 runs pass

### Non-Goals

- No change to the fold's decision logic or ladder semantics in `lib/gui-toolbar-fold.ts` (its unit suite is the contract; only the R3 measure-path arm may touch the component).
- No reworking of the sibling measured-fold specs (`top-bar-overflow.spec.ts`, `crumb-collapse.spec.ts`) beyond sharing any newly extracted helper — they are not observed flaky.
- No CI-side retry increases, quarantine, or `test.skip` — false stability is out of scope.
- No product behavior change; the fix is test-side unless R3 fires.

### Design Decisions

**Diagnose before fixing; the fix lands at the layer the evidence names**
**Why**: the three failure modes may have different mechanisms (convergence arithmetic vs. boundary margins vs. re-fit timing); a fix chosen before diagnosis risks treating symptoms, and the user's standing rule is root-cause fixes.
**Rejected**: blanket retries/timeouts (masks the flake); preemptive component change (behavior risk without evidence).
*Introduced by*: 261107-dezl-gui-toolbar-fold-stability

**Determinism by pinning the variable input (the meta chip), not by loosening tolerances**
**Why**: the header's shrinkable meta chip is the one input making viewport↔spring overhead non-constant; pinning its width in the test makes the mapping affine so a single computed resize lands on target, while every width the fold consumes stays real (probe-measured, never hardcoded).
**Rejected**: widening `resizeToSpring`'s tolerance (still nondeterministic, just less often); mocking layout back into jsdom (defeats the suite's purpose).
*Introduced by*: 261107-dezl-gui-toolbar-fold-stability

## Tasks

### Phase 1: Diagnosis

- [x] T001 Instrument and reproduce: run `just test-e2e gui-toolbar-fold --repeat-each 3 --retries 0` with temporary instrumentation (log each `measureFold` viewport/spring/widths triple across the `resizeToSpring` loop and the rendered fold state at each assertion) until each failure mode reproduces; attribute every mode to a named mechanism with the captured evidence, and record the findings (they decide T002's arm and clear or fire R3). Files: `app/frontend/tests/e2e/gui-toolbar-fold.spec.ts` (instrumentation is temporary — removed in T002). <!-- R1 -->

### Phase 2: Fix

- [x] T002 Implement the fix at the layer T001's evidence names — expected: test-side determinism in `app/frontend/tests/e2e/gui-toolbar-fold.spec.ts` (pin the meta chip width via `page.addStyleTag`-injected CSS or equivalent so viewport↔spring overhead is constant; verify the landed spring before dependent assertions; re-target all assertions at band midpoints with hysteresis-scaled margins; remove the T001 instrumentation); if the evidence instead names the non-atomic re-fit, additionally make `app/frontend/src/components/gui-toolbar.tsx`'s measure path synchronous with the spring resize per R3. <!-- R2 R3 -->

### Phase 3: Verification

- [x] T003 Stability gate: `just test-e2e gui-toolbar-fold --repeat-each 5 --retries 0` passes 20/20; if any run fails, return to T001's evidence for the new mode before adjusting anything. <!-- R5 -->
- [x] T004 Regression gate: the gui toolbar unit suites (`gui-toolbar-fold.test.ts`, `gui-toolbar.test.tsx`) and the sibling measured-fold e2e specs (`top-bar-overflow`, `crumb-collapse`) pass unchanged; `npx tsc --noEmit` clean in `app/frontend`. <!-- R3 R4 R5 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: Each of the three observed failure modes is attributed to a named mechanism with captured evidence, recorded in the apply result.
- [ ] A-002 R2: Spring targeting lands deterministically — the landed spring is verified before dependent assertions, with the viewport↔spring overhead made constant for the test.
- [ ] A-003 R2: Every assertion target sits at a band midpoint or carries a margin scaled to the real inputs (≥ 24px past the boundary on expand edges).

### Behavioral Correctness

- [ ] A-004 R3: The component arm is either implemented with its unit suites green, or explicitly cleared with the diagnostic evidence that the non-atomic re-fit is not causal.
- [ ] A-005 R4: All four proof areas (tail-first ladder + `⚙` + panel rows; degradation before fold; reload persistence; fullscreen tile targeting) remain proven at real viewport widths with no deleted assertions.

### Scenario Coverage

- [ ] A-006 R4: The ladder test still proves tail-first folding order, `⚙` appear/disappear, and the panel's folded rows.
- [ ] A-007 R4: The degradation test still proves quality-then-size label order with every rung inline.

### Edge Cases & Error Handling

- [ ] A-008 R2: Widening-back assertions sit at least the 24px one-sided hysteresis past their boundary, so a refit landing anywhere in the band cannot flap the expected state.
- [ ] A-009 R5: The reload-persistence and fullscreen tests pass unchanged under the reworked targeting.

### Code Quality

- [ ] A-010: Pattern consistency — the reworked helpers follow the sibling measured-fold specs' idioms (probe-measured targets, retrying post-resize expects) and the file's Proves/Steps JSDoc convention.
- [ ] A-011: No magic numbers — margins and tolerances are named constants tied to the inputs they derive from (hysteresis, reserve, measured widths); comments state constraints, not narration.
- [ ] A-012: Baseline — no unnecessary duplication (shared helper extraction only if both sibling specs would use it) and no retry/quota mechanism added as a flake mask.

### Stability

- [ ] A-013 R5: `just test-e2e gui-toolbar-fold --repeat-each 5 --retries 0` passes 20/20 locally.
- [ ] A-014 R5: Sibling measured-fold specs and the gui toolbar unit suites pass unchanged; `tsc --noEmit` clean.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The fix's locus is decided by T001's evidence; expected test-side (spec helpers), component arm only on proof | Intake #3/#4 carried forward; the documented caveat says assertions already retry, pointing at sizing/convergence as the fragility | S:80 R:85 A:70 D:60 |
| 2 | Confident | Determinism mechanism: pin the meta chip's width via test-injected CSS so viewport↔spring overhead is constant | The meta chip is the one non-constant input; pinning it is test-only and keeps all fold-consumed widths real | S:70 R:80 A:70 D:55 |
| 3 | Certain | `lib/gui-toolbar-fold.ts`'s decision logic is out of scope — its unit suite is the contract | Non-Goals; the flake is in driving/measurement, not the pure arithmetic (unit-proven) | S:90 R:85 A:85 D:85 |
| 4 | Confident | Sibling specs (`top-bar-overflow`, `crumb-collapse`) are not reworked — not observed flaky | Scope control; they may adopt an extracted helper only if it fits both | S:75 R:80 A:75 D:70 |

4 assumptions (1 certain, 3 confident, 0 tentative, 0 unresolved).
