# Plan: Status Bar Measured Priority Fold

**Change**: 260914-msu9-status-bar-priority-fold
**Intake**: `intake.md`

## Requirements

### Status bar: the pure fold module (`app/frontend/src/lib/status-bar-fold.ts`)

#### R1: A dependency-free priority-fold decision
`lib/status-bar-fold.ts` SHALL export `computeStatusBarFold(items, availablePx, chevronPx, prev, hysteresisPx?)` returning `{ folded: string[]; truncateId: string | null }`, plus the constants `STATUS_BAR_FOLD_HYSTERESIS_PX = 24`, `STATUS_BAR_FOLD_PAD_PX = 16`, `STATUS_BAR_FOLD_DOT_PX = 8`, `STATUS_BAR_FOLD_GAP_PX = 12`, and the types `StatusBarFoldItem { id; widthPx; prio: number | null; cluster: "left" | "right"; truncatable?: boolean }` and `StatusBarFold`. The module MUST import nothing (no React, no DOM, no sibling fold module) and its header comment MUST name the three precedents (`top-bar-overflow.ts` `computeVisibleCount`, `crumb-collapse.ts`, `gui-toolbar-fold.ts`) and state that this is a priority fold (any position), not a suffix fold.

- **GIVEN** items whose widths sum (with per-cluster gaps and the fixed PAD + DOT + GAP charge) to at most `availablePx`
- **WHEN** `computeStatusBarFold` runs
- **THEN** it returns `{ folded: [], truncateId: null }`

#### R2: Lowest priority folds first; ties fold rightmost; never-fold survives
While the rendered width exceeds the budget (`availablePx − PAD − DOT − GAP`), the module SHALL fold the item with the lowest numeric `prio`; among equal `prio` values the item later in display order folds first; items with `prio: null` never fold. `folded` MUST list ids in display order. Gaps are charged `GAP × (renderedInCluster − 1)` per cluster; no gap is charged across the `ml-auto` spring.

- **GIVEN** the right-cluster items `palette` (prio 1, display 14) and `compose` (prio 1, display 15) and a budget short by one item
- **WHEN** the fold runs
- **THEN** `folded` is `["compose"]`

- **GIVEN** a budget that cannot fit the never-fold items alone
- **WHEN** the fold runs
- **THEN** every `prio: null` item is still absent from `folded`

#### R3: Two-pass chevron reserve
The module SHALL first fit with no chevron reserve; if nothing folds it returns immediately (no chevron). If anything folds it SHALL re-fit with `chevronPx + GAP` reserved on the right cluster and return that second result. The reserve never causes the fold that justifies it.

- **GIVEN** items that fit exactly with no reserve
- **WHEN** the fold runs with `chevronPx = 20`
- **THEN** `folded` is empty
- **GIVEN** items one px over budget with `chevronPx = 20`
- **WHEN** the fold runs
- **THEN** the returned fold accounts for the 20 px reserve and may fold one more item than the unreserved pass

#### R4: Last-survivor truncation
When every foldable item has folded and the never-fold set still overflows, the module SHALL set `truncateId` to the rightmost never-fold item flagged `truncatable`; otherwise `truncateId` is `null`. At most one id is ever returned.

- **GIVEN** `pr` (never, truncatable, display 2) and `fab` (never, truncatable, display 3) remain and overflow
- **WHEN** the fold runs
- **THEN** `truncateId === "fab"`
- **GIVEN** only `zen`, a stale `clock`, and no truncatable item remain and overflow
- **WHEN** the fold runs
- **THEN** `truncateId === null`

#### R5: One-sided expand hysteresis
A result more expanded than `prev` (fewer folded ids, or truncation turning off — rank `= (items.length − folded.length) × 2 + (truncateId ? 0 : 1)`) SHALL be re-proven against `availablePx − hysteresisPx`; if the re-proof is not more expanded than `prev`, `prev` is returned. Collapsing is immediate.

- **GIVEN** `prev` folds `ld` and the width grows to exactly the unfolded threshold
- **WHEN** the fold runs
- **THEN** `ld` stays folded
- **GIVEN** the width grows to the threshold + 24
- **WHEN** the fold runs
- **THEN** `ld` unfolds

#### R6: Degenerate inputs keep `prev`; cold default is fully expanded
When `items` is empty or every `widthPx <= 0`, the module SHALL return `prev ?? { folded: [], truncateId: null }`.

- **GIVEN** jsdom widths (all 0) and `prev === null`
- **WHEN** the fold runs
- **THEN** the result is `{ folded: [], truncateId: null }`

### Status bar: the component (`app/frontend/src/components/status-bar.tsx`)

#### R7: Measured fold replaces every breakpoint class
`StatusBar` SHALL own one `ResizeObserver` (observing the bar root and the hidden probe) and a hidden probe row (`aria-hidden="true" inert`, off-screen, `pointer-events-none`, `data-testid="status-bar-probe"`) rendering every candidate segment at natural width inside a `data-fold="<id>"` wrapper, plus the `…` chevron under `data-fold="chevron"`; probe controls carry `tabIndex={-1}` and render no `Tip`. The measure runs in a `useLayoutEffect` on mount and re-runs when a serialized candidate key (present segment ids + clock kind + `zenActive`) changes; value-only width changes reach the fit through the observed probe. No segment or menu row MAY carry `hidden`, `md:flex`, `lg:flex`, `xl:flex`, `xl:hidden`, `md:hidden`, `lg:hidden`, `min-[700px]:inline`, `min-[700px]:hidden`, or `lg:inline`. Rendered segments are `shrink-0 whitespace-nowrap`; `min-w-0 truncate` appears only on the `truncateId` survivor's value span.

- **GIVEN** probe widths that all fit the bar's `clientWidth`
- **WHEN** the bar renders
- **THEN** every candidate segment is in the strip and no `status-bar-overflow` button exists
- **GIVEN** probe widths that overflow by roughly one `ld` segment
- **WHEN** the bar renders
- **THEN** `ld` is absent from the strip and the chevron renders with exactly one `ld` row

#### R8: Collapse-first render
The fold state SHALL start `null`; until the pre-paint measure sets it the strip renders only never-fold segments (`pr`, `fab`, `zen ✕`, the stale `◷`, the connection dot). In jsdom (all-zero widths) the first measure lands on the fully-expanded cold default.

- **GIVEN** a jsdom render with no width mocks
- **WHEN** the bar mounts
- **THEN** every segment renders and no chevron exists (existing non-menu tests keep passing)

#### R9: Priority table
Fold items SHALL carry exactly these priorities (display order left → right): `git` 9 · `pr` never (truncatable) · `fab` never (truncatable) · `agt` 8 · `tmx` 3 · `cwd` 2 · `zen` never · `metrics` 6 · `ld` 0 · `clock` 4 when `kind === "next"` / never when `kind === "stale"` · `server` 5 · `host` 10 · `version` 7 · `palette` 1 · `compose` 1. Absent segments are not items.

- **GIVEN** a stale operator loop and a budget that folds the next-fire chip
- **WHEN** the bar renders
- **THEN** the `◷ stale` chip is in the strip and has no `clk` menu row

#### R10: Metrics diet with fixed-width numerals
The metrics segment SHALL read `cpu N% · mem N%` (`mem` = `Math.round(used / Math.max(total, 1) × 100)`, coloured by `gaugeColor(percent)`); `ld N%` SHALL be its own passive segment (own fold item, no flyout, no copy). The `cpu`, `mem`, and `ld` value spans SHALL carry `tabular-nums` and `min-w-[4ch] text-right` (inline, so the probe reads a constant width). `formatMemory` is no longer imported by the status bar; the `MetricsFlyout` still renders the shared `HostMetrics`.

- **GIVEN** metrics `used 24G / total 59G`
- **WHEN** the bar renders
- **THEN** the strip reads `mem` `41%` and never `24G/59G`; the flyout still shows the absolute values

#### R11: `…` menu rows are the folded ids in strip order
The menu SHALL render one row per id in `fold.folded`, in display order: copy-action `<button role="menuitem">` for `git`, `tmx` (with a `paneId`), `cwd`, `version`, `server`, `host`; informational `<span role="menuitem">` for `metrics`, `ld`, `agt`, and a paneId-less `tmx`; action buttons for `palette` (`⌘K Command palette`), `compose` (`a▏ Compose`), `clock` (`◷ Cron List`, next state only). The chevron (`data-testid="status-bar-overflow"`) renders iff `folded.length > 0`. The keyboard contract is unchanged (rAF focus-in, ArrowUp/Down rove with wrap, Escape closes and refocuses the chevron, outside mousedown closes; copy rows keep the menu open, action rows close it). The `checkVisibility` filter in `rows_()` SHALL be removed.

- **GIVEN** a fold with `folded = ["tmx", "cwd", "ld", "palette", "compose"]`
- **WHEN** the menu opens
- **THEN** rows appear in that order, `tmx`/`cwd` are buttons whose click copies `%5` / the full path and leaves the menu open, `ld` is a span, and the palette row closes the menu after dispatching `palette:open`

#### R12: Copy affordances and data seams preserved
All existing `useCopyFeedback` behaviour (raw values, selection guard, 1 s `copied ✓` swap), aria-labels, `data-testid`s (`status-bar`, `status-bar-window`, `status-bar-host`, `status-bar-overflow`, `status-bar-clock`, `status-bar-compose`, `status-bar-exit-zen`), the open-first `pr` anchor, `FAB_STATE_COLORS`, `splitDatePrefix` dimming, the single `useClockChipState` derivation, and the unconditional coalesced metrics hooks SHALL be preserved. `StatusBarProps` is unchanged. The `host`/`version` visual pair keeps its `flex gap-1` wrapper when at least one survives.

- **GIVEN** the existing copy, flyout, click-seam, coalesced-hooks, and route-split unit tests
- **WHEN** the suite runs
- **THEN** they pass without behavioural edits (harness additions only where a test opens the menu)

### Tests

#### R13: Pure-module tests
`lib/status-bar-fold.test.ts` SHALL cover: full fit; the ladder order (`ld` → `compose` → `palette` → `cwd` → `tmx` → `clock` → `server` → `metrics` → `version` → `agt` → `git` → `host`); rightmost-tie; never-fold survival; two-pass reserve (no reserve while everything fits; the reserve may cost one more item); last-survivor truncation (`fab` before `pr`; `null` with nothing truncatable); per-cluster gap charging; hysteresis (immediate collapse, +24 to expand, expand the shrunk budget cannot hold returns `prev`, truncation-off counts as expand); degenerate inputs (all-zero ⇒ `prev`; cold ⇒ expanded; empty ⇒ empty).

- **GIVEN** the fixture widths
- **WHEN** `pnpm vitest run src/lib/status-bar-fold.test.ts` runs
- **THEN** every case passes

#### R14: Component tests use a width harness
`status-bar.test.tsx` SHALL replace the six breakpoint-class assertions with fold-state assertions driven by a `mockWidths(available, widths)` helper (spying `HTMLElement.prototype.offsetWidth` per `data-fold` and `clientWidth` on the `status-bar` root; ResizeObserver stubbed to never fire; fresh mount per width case), and every test that opens the `…` menu SHALL first drive a fold through it. New cases: wide ⇒ no chevron; short-by-`ld` ⇒ one `ld` row; narrow ⇒ `tmx`/`cwd`/hints/`ld` folded in strip order with copy buttons; never-fold-only overflow ⇒ only the `fab` value span carries `truncate`; stale `◷` survives; `tabular-nums` on the numeral spans; `mem` as `41%`; `ld` its own segment.

- **GIVEN** the rewritten file
- **WHEN** `just test-frontend` runs
- **THEN** the whole Vitest suite passes (the full suite is the gate, not a scoped list)

#### R15: E2e width sweep re-pointed
`tests/e2e/status-bar.spec.ts` SHALL rewrite the width-sweep test to assert at 1440 px every segment visible and `status-bar-overflow` `toHaveCount(0)`, then at **1050 × 600** (real Chromium probe widths give the fixture a ~1220 px natural width; 720 px would also fold `agt`) `wt` and `%1` hidden, `main` / `waiting 3m` / the fab line / the PR anchor visible, `scrollWidth ≤ clientWidth`, the menu listing `tmx` and `cwd` copy rows and no `out` row, focus on the first row, ArrowDown/ArrowUp rove, ArrowUp off the first row wraps to the last row, Escape closes. The keyboard case SHALL use 1050 px and assert focus lands on the first folded row in display order — the `tmx` copy row (R11: rows follow `fold.folded` in strip order; `ld` is a right-cluster item and comes later) — then Enter copies `%1` and the menu stays open. The first test SHALL also assert `41%`. The file header and every touched `test()` JSDoc SHALL be updated (Test Intent Comments), with no change-ID citations in new comment text.

- **GIVEN** the rewritten spec
- **WHEN** `just test-e2e status-bar.spec` runs
- **THEN** all status-bar tests pass; `just test-e2e pane-register-panel.spec` and `just test-e2e tooltips.spec` still pass

### Memory

#### R16: `status-signals.md § Status Bar` states the fold as present truth
`docs/memory/run-kit/ui/status-signals.md` SHALL rewrite (no "was X, now Y" narration) the Overflow bullet (measured priority fold, the priority table, two-pass reserve, last-survivor truncation, fixed-width numerals, collapse-first, unmeasured ⇒ prev, one ladder across both clusters, chevron iff folded, rows = folded ids, no `checkVisibility`), the Right-cluster text (`cpu N% · mem N%`, `ld` own passive segment, server/host/version fold items with copy rows, the host/version wrapper sentence without breakpoint classes), the clock-chip fold sentence, the Copy-affordances sentence, and the Coverage bullet (`lib/status-bar-fold.test.ts`, fold-state cases, the 1050 px sweep). Design Decisions: rewrite *Status-bar left cluster is branch-first descending relevance* (display order stays; survival is the priority table), *The `out` register leaves the status bar* (drop "rides the bar to 640px"), *Stale clock chip survives the ladder…* → *Stale clock chip never folds; the next-fire chip folds at priority 4*, *Host and version are independent flex items* (drop the class citation); add *A measured priority fold replaces the breakpoint ladder* in the four-field shape. The frontmatter `description:` SHALL be updated if it names the ladder, and `fab docs-index docs/memory` regenerated. Relative `](x.md)` links across `docs/memory/run-kit/ui/` SHALL resolve.

- **GIVEN** the hydrated file
- **WHEN** `grep -n "≥xl\|≥lg\|≥md\|xl:hidden\|min-\[700px\]" docs/memory/run-kit/ui/status-signals.md` runs
- **THEN** it returns no status-bar overflow mentions (only unrelated hits, if any)

### Non-Goals

- Mobile (renders no bar); adding or removing segments (the set is fixed — `server` folds, it does not disappear); the flyout content; the PANE-on gate (change 3); the `status-bar.tsx` sibling memory files (`sidebar.md`, `architecture/repo-layout.md` — verified to carry no ladder detail).

### Design Decisions

#### A measured priority fold replaces the breakpoint ladder
**Decision**: the status bar folds by measured priority — every segment renders at natural width or moves to the `…` menu, one ladder across both clusters, truncation reserved for the single lowest-priority never-fold survivor.
**Why**: overflow is caused by value length (30-char branches, 48-char fab lines), not viewport width; at 1512 px nothing had dropped and six segments truncated proportionally; independent per-cluster ladders let a long left cluster squeeze the host name.
**Rejected**: CSS breakpoints (answer the wrong question); horizontal scroll or a two-row bar (a scrolling strip hides what it exists to show; two rows is a card); a segment-visibility setting (Constitution IV — one settings surface).
*Introduced by*: 260914-msu9-status-bar-priority-fold

#### Sibling module, not a generalisation of `gui-toolbar-fold`
**Decision**: `lib/status-bar-fold.ts` is a fourth dependency-free module beside the three precedents; hysteresis and two-pass rules are restated, not imported.
**Why**: a priority fold (any position) and a suffix fold (the tail) share two constants and little else; every precedent deliberately keeps an own constant to stay dependency-free.
**Rejected**: extracting a shared fold-core (a larger diff touching a shipped gui module for two constants).
*Introduced by*: 260914-msu9-status-bar-priority-fold

#### Last-survivor truncation targets the rightmost truncatable never-fold item
**Decision**: never-fold items share `prio: null`, so the truncation target is the rightmost `truncatable` item in display order (`fab` before `pr`); `zen`, the stale `◷`, and the dot are never truncatable.
**Why**: display order is the only tiebreak available among never-fold items, and `fab` carries the longer value on an off-change branch.
**Rejected**: truncating `pr` first (the shorter value; its anchor is the most-clicked segment).
*Introduced by*: 260914-msu9-status-bar-priority-fold

## Tasks

### Phase 1: Setup

- [x] T001 Create `app/frontend/src/lib/status-bar-fold.ts`: header comment naming the three precedents and the priority-vs-suffix distinction; export the four constants, `StatusBarFoldItem`, `StatusBarFold`, and `computeStatusBarFold` implementing the fit rule (per-cluster gaps, PAD+DOT+GAP charge), lowest-prio-first with rightmost tiebreak, two-pass chevron reserve, last-survivor truncation, one-sided expand hysteresis with the stated rank, and the degenerate/cold rules. <!-- R1 R2 R3 R4 R5 R6 -->
- [x] T002 [P] Create `app/frontend/src/lib/status-bar-fold.test.ts` with round-number fixture widths covering every R13 case. Run `cd app/frontend && pnpm vitest run src/lib/status-bar-fold.test.ts` and fix until green. <!-- R13 -->

### Phase 2: Core Implementation

- [x] T003 In `app/frontend/src/components/status-bar.tsx`, rewrite the header `OVERFLOW` block for the fold (no change-ID citations in new text); add a `SEGMENT_PRIO` table (R9) and a per-id segment render map feeding the strip, the probe, and the menu; add `truncate?: boolean` to `Segment`/`CopySegment` replacing the always-on `min-w-0 truncate`; remove every breakpoint class listed in R7 from segments, the `ClockChip`, the chevron wrapper, and menu rows. <!-- R7 R9 R12 -->
- [x] T004 In `status-bar.tsx`, add the hidden probe row (`data-testid="status-bar-probe"`, `aria-hidden inert`, off-screen, per-id `data-fold` wrappers incl. `chevron`), the `useLayoutEffect` measure (probe `offsetWidth`s + root `clientWidth` → `computeStatusBarFold(items, clientWidth, chevronW, prev)`), the `ResizeObserver` on root + probe, the serialized candidate key, and the collapse-first `null` initial state rendering only never-fold segments. <!-- R7 R8 -->
- [x] T005 In `status-bar.tsx`, apply the metrics diet: `cpu N% · mem N%` with `gaugeColor(percent)` on mem, `ld N%` as its own passive segment/fold item, `tabular-nums min-w-[4ch] text-right` on the three numeral spans; drop the `formatMemory` import. <!-- R10 -->
- [x] T006 In `status-bar.tsx`, rebuild `OverflowMenu` to render one row per `fold.folded` id in display order with the R11 row kinds (adding `server`/`host` copy rows; widening the `useCopyFeedback` key union), render the chevron iff `folded.length > 0`, keep the keyboard contract, and remove the `checkVisibility` filter. Wire the clock chip as prio 4 / never by state. <!-- R9 R11 R12 -->
- [x] T007 Run `cd app/frontend && npx tsc --noEmit`; fix type errors. <!-- R7 R12 -->

### Phase 3: Integration & Edge Cases

- [x] T008 Rewrite `app/frontend/src/components/status-bar.test.tsx`: add the `mockWidths` harness (offsetWidth per `data-fold`, clientWidth on `status-bar`, ResizeObserver stub, fresh mount per case); replace the six breakpoint-class assertions with the R14 fold-state cases; make every menu-opening test drive a fold first; update the metrics assertions (`41%`, `ld` own segment, `tabular-nums`); keep copy/flyout/click-seam/coalesced-hooks/route tests. Run `pnpm vitest run src/components/status-bar.test.tsx` until green. <!-- R14 -->
- [x] T009 Run the FULL unit gate `just test-frontend` from the repo root (never a scoped file list) and fix any regression anywhere in the tree. <!-- R14 -->
- [x] T010 Rewrite `app/frontend/tests/e2e/status-bar.spec.ts` per R15 (1440 px no-chevron via `toHaveCount(0)`; the 1050 × 600 sweep; the keyboard case at 1050 px with focus on the `tmx` copy row; `41%` in the first test; header comment and every touched `test()` JSDoc updated). Run `just test-e2e status-bar.spec` (single spec — the `.spec` suffix matters, a bare name matches this worktree's path) until green; then `just test-e2e pane-register-panel.spec` and `just test-e2e tooltips.spec`. <!-- R15 -->

### Phase 4: Polish

- [x] T011 Update `docs/memory/run-kit/ui/status-signals.md` per R16 (present-truth rewrite of the § Status Bar bullets, the four Design Decisions rewrites, the new DD, the frontmatter description if it names the ladder); resolve relative links across `docs/memory/run-kit/ui/`; run `fab docs-index docs/memory --check` then `fab docs-index docs/memory`. <!-- R16 -->

## Execution Order

- T001 blocks T002 (tests import the module) and T003–T006 (the component imports it)
- T003 → T004 → T005 → T006 are one file and run sequentially; T007 after T006
- T008 after T007; T009 after T008; T010 after T009 (the e2e rig needs the compiled component)
- T011 is independent of T008–T010 but runs last so it documents the shipped shape

## Acceptance

### Functional Completeness

- [x] A-001 R1: `lib/status-bar-fold.ts` exists, imports nothing, exports the stated constants/types/function, and its header names the three precedents and the priority-vs-suffix distinction
- [x] A-002 R2: the lowest `prio` folds first, ties fold rightmost, `prio: null` never folds, `folded` is in display order, gaps are charged per cluster (n−1) and never across the spring
- [x] A-003 R3: nothing folds ⇒ no reserve consulted; anything folds ⇒ the returned fold is the re-fit with `chevronPx + GAP` reserved
- [x] A-004 R4: `truncateId` is the rightmost truncatable never-fold item only when the never-fold set overflows, else `null`
- [x] A-005 R5: expansion re-proves against `availablePx − 24`; collapse is immediate; truncation-off counts as an expand
- [x] A-006 R6: all-zero widths return `prev`; `prev === null` returns the fully-expanded cold default
- [x] A-007 R7: `status-bar.tsx` has one `ResizeObserver` (root + probe), a hidden `inert` probe with per-id `data-fold` wrappers incl. `chevron`, a `useLayoutEffect` measure keyed on the candidate set, and no breakpoint class from the R7 list anywhere in the file
- [x] A-008 R8: fold state starts `null` and the strip renders only never-fold segments until the first measure
- [x] A-009 R9: the priority table matches R9 exactly, including the clock chip's state-dependent prio
- [x] A-010 R10: strip reads `cpu N% · mem N%` (gaugeColor on the percent) and a separate passive `ld N%`; numeral spans carry `tabular-nums min-w-[4ch] text-right`; `formatMemory` is no longer imported by the bar; the flyout still renders `HostMetrics`
- [x] A-011 R11: menu rows are exactly `fold.folded` in display order with the stated row kinds (server/host copy rows added); chevron renders iff something is folded; `checkVisibility` filter removed; keyboard contract unchanged
- [x] A-012 R12: `StatusBarProps` unchanged; every listed `data-testid`, aria-label, copy raw value, the open-first `pr` anchor, `FAB_STATE_COLORS`, `splitDatePrefix`, single `useClockChipState`, and the coalesced hooks are preserved
- [x] A-013 R16: `status-signals.md § Status Bar` bullets and the four Design Decisions state the fold as present truth, the new DD exists in four-field shape, the description routes, and `fab docs-index docs/memory --check` passes

### Behavioral Correctness

- [x] A-014 R7: at a wide mocked width every segment is in the strip and `status-bar-overflow` is absent; at a width short by one `ld` the chevron appears with exactly one `ld` row
- [x] A-015 R10: with `used 24G / total 59G` the strip shows `41%` for mem and never `24G/59G`
- [x] A-016 R9: a stale `◷` chip survives a budget that folds the next-fire chip and has no `clk` menu row

### Removal Verification

- [x] A-017 R7: `grep -n "xl:hidden\|xl:flex\|lg:flex\|md:flex\|lg:hidden\|md:hidden\|lg:inline\|min-\[700px\]" app/frontend/src/components/status-bar.tsx` returns nothing
- [x] A-018 R11: `checkVisibility` no longer appears in `status-bar.tsx`
- [x] A-019 R10: `formatMemory` is not imported in `status-bar.tsx`

### Scenario Coverage

- [x] A-020 R13: `lib/status-bar-fold.test.ts` covers every R13 case and passes
- [x] A-021 R14: `status-bar.test.tsx` carries the `mockWidths` harness, the new fold-state cases, and every menu-opening test drives a fold first; `just test-frontend` (the FULL suite) passes
- [x] A-022 R15: `tests/e2e/status-bar.spec.ts` sweeps 1440 → 1050 px per R15, the keyboard case runs at 1050 px starting on the `tmx` copy row, the first test asserts `41%`, the header and every touched JSDoc are updated without change-ID citations; `just test-e2e status-bar.spec`, `pane-register-panel.spec`, and `tooltips.spec` pass

### Edge Cases & Error Handling

- [x] A-023 R4: a never-fold-only overflow truncates exactly one value span (`fab`), and no other segment carries `truncate`
- [x] A-024 R6: a jsdom render with no width mocks renders every segment and no chevron (existing non-menu tests untouched)
- [x] A-025 R11: a paneId-less `tmx` folds to an informational span, not a copy button

### Code Quality

- [x] A-026 Pattern consistency: the module and component follow the `gui-toolbar-fold.ts` / `gui-toolbar.tsx` measured-fold idiom (pure decision module + component-owned measurement, probe `inert`, `useLayoutEffect` pre-paint)
- [x] A-027 No unnecessary duplication: `gaugeColor`, `normalizeLoadPercent`, `useCopyFeedback`, the register resolvers, `FAB_STATE_COLORS`, and `controlClass` are reused; no new copy helper or colour map
- [x] A-028 Type narrowing over assertions: no new `as` casts beyond the existing `document.activeElement as HTMLElement | null` pattern
- [x] A-029 Named constants: fold charges, hysteresis, and priorities are named constants, not inline magic numbers
- [x] A-030 Comment discipline: new comments state constraints (why the probe is `inert`, why numerals are fixed-width, why the chevron reserve is two-pass), never narrate the next line or cite change IDs / PR numbers
- [x] A-031 Tests included: new behaviour (fold, metrics diet, menu rows) has unit coverage and the e2e sweep

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — the change replaced the breakpoint ladder in place (classes, the `checkVisibility` filter, and the bar's `formatMemory` import are already deleted in the diff); `formatMemory` keeps its `host-metrics.tsx` caller, and no other symbol lost its last consumer.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Requirements R1–R16 restate the intake's § What Changes 1–8 one-to-one; no new design | Intake carries every value verbatim from the plan of record | S:95 R:80 A:95 D:95 |
| 2 | Confident | The component uses a per-id segment render map shared by strip, probe, and menu | The intake recommends it; the plan of record leaves the internal shape to apply | S:65 R:90 A:85 D:75 |
| 3 | Confident | Expansion rank `(rendered × 2) + (truncateId ? 0 : 1)` orders fold states for hysteresis | The gui module's `expandRank` precedent; the intake states the formula | S:70 R:95 A:90 D:80 |

3 assumptions (1 certain, 2 confident, 0 tentative).
