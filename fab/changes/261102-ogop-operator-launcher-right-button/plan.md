# Plan: Operator launcher becomes a right-aligned "Operator" button

**Change**: 261102-ogop-operator-launcher-right-button
**Intake**: `intake.md`

## Requirements

### Launcher: one button

#### R1: One `<button>`, the same element in every state
The quake launcher SHALL render exactly one `<button type="button" data-quake-terminal data-testid="quake-launcher">` on desktop in every state (rest, drawer open, operator route, no operator). It SHALL NOT render an `<input>`, the md–lg ghost (`quake-launcher-ghost`) or the separate collapsed control (`quake-launcher-collapsed`). It MUST render `null` on mobile. The `WIDE_RUNG_QUERY` / `EXTRA_WIDE_RUNG_QUERY` width ladder, the Enter-send / paste-upload handlers and the `readOnly` no-operator branch SHALL be removed.

- **GIVEN** a desktop viewport
- **WHEN** the machine moves rest → open → rest
- **THEN** `data-testid="quake-launcher"` stays the same DOM node and no other launcher testid exists

#### R2: Contents, label, tooltip, accessible name
The button SHALL show, left to right: `OperatorStateGlyph` (live state dot, `data-testid="quake-launcher-state"` + `data-state`, no dot with no operator), the fixed label "Operator", the registry-effective chord keycap (`<kbd aria-hidden>`, omitted when the `quake-terminal` binding is unbound/disabled), and a draft dot (`data-testid="quake-launcher-draft"`) when `useOperatorCompose(server, target).text.trim() !== ""`. The tooltip (shared `Tip`) SHALL read `Ask the operator (<chord>)` with an operator, `Start the operator (<chord>)` without one, append ` · unsent draft` when a draft exists, and drop the parenthetical when no chord. The glyph-only (compact) form SHALL keep `aria-label="Operator"`, show glyph + state dot + draft dot and drop the label and keycap.

- **GIVEN** an operator and chord ⌘J with a non-empty draft
- **WHEN** the button is hovered
- **THEN** the tooltip reads `Ask the operator (⌘J) · unsent draft`

#### R3: Click semantics
A click SHALL: at rest → `setQuakeMachineState("open")`; while open → `setQuakeMachineState("open")` (same-value re-assertion) then focus `[data-testid="quake-terminal-compose-input"]` — never close the drawer; on the operator window's own route (`routeServer !== null && routeServer === server && target !== undefined && routeWindow === target.window.windowId`) → `focusComposeStrip()` with no machine transition; with no operator → same as rest.

- **GIVEN** the drawer is open
- **WHEN** the button is clicked
- **THEN** the compose textarea takes focus, the drawer stays open, and the click is not an outside click

#### R4: Latch
While the machine is `open` (and not on the operator route) the button SHALL carry `aria-expanded="true"` and the latched inset well (`controlClass` `pressed`); the green accent edge SHALL show only while the docked compose is engaged (`useQuakeComposeEngaged`). It SHALL NOT use `aria-pressed`. On the operator route the button is never latched.

- **GIVEN** the drawer is open but the compose is not focused
- **WHEN** the button renders
- **THEN** it is latched with no accent edge; focusing the compose adds the accent edge

#### R5: Invariant (a) lives in an always-mounted host
The rest → open restore-origin capture (`setQuakeRestoreOrigin`, kept only when the active element lies outside every `isQuakeTerminalTarget`) SHALL run in an always-mounted `QuakeLauncherFocusCapture` component mounted once in `TopBar`, never in the button (which may be overflowed) and never in the probe copy.

- **GIVEN** a mouse click on the launcher that focuses the button before the machine opens
- **WHEN** the machine goes rest → open
- **THEN** the restore origin is `null`, not the button; Esc restores prior focus to a non-launcher origin

### Top bar: placement and registry

#### R6: Placement in the right cluster
The launcher SHALL be removed from the top bar's center cell and rendered as the leftmost item of the right cluster, before the surface-toggle group, on all four modes, with a hairline divider after it whenever another fit candidate renders after it (omitted when none). `routeServer` / `routeWindow` SHALL stay props (`server || null`, `currentWindow?.windowId ?? null`); the component SHALL NOT pull router hooks.

- **GIVEN** terminal mode on desktop with all controls fitting
- **WHEN** the bar renders
- **THEN** `quake-launcher` precedes `surface-toggles` inside `top-bar-right`, with a divider between

#### R7: Registry entry and merged menu row
`rightItems` SHALL gain an `id: "quake-terminal"` entry at the registry head (before `surface-toggles`), `modes` all four, `menuGroup: "app"`, `dropLast: true` on desktop, `menuOnly: true` on mobile — replacing the old `menuOnly` "Quake terminal" entry. Its menu row SHALL read "Operator" with a trailing chord keycap (`MENU_ROW_KBD_CLASS`), use the launcher's click semantics on desktop, and keep `requestQuakeTerminal({ action: "open" })` on mobile. Desktop SHALL never show two operator rows; the row appears only when the entry is overflowed. The fit tail SHALL be `[…, quake-launcher, surface-toggles]`.

- **GIVEN** desktop with the launcher overflowed
- **WHEN** the chevron menu opens
- **THEN** exactly one "Operator" row shows in the App section

### Narrow-width degradation

#### R8: Compact rung from measured fit
`RegistryEntry` SHALL gain an optional `compactBarRender`. The probe SHALL measure both forms; `lib/top-bar-overflow.ts` SHALL export a pure `computeFit` that returns `{ count, compact }`: all candidates are tried at full width first; if not all fit, every compact-capable entry is measured at its compact width BEFORE any candidate overflows; the expand edge (compact → full) requires `TOP_BAR_COMPACT_HYSTERESIS_PX` of extra slack. Only the launcher uses it. The button SHALL NOT self-measure.

- **GIVEN** the cluster is one pixel too narrow for every candidate at full width
- **WHEN** the fit runs
- **THEN** the launcher renders glyph-only and no candidate overflows

### Cleanup

#### R9: Center cell follow-through
Comments in `top-bar.tsx` that describe the launcher in the center cell SHALL be rewritten or removed (no history narration, no change IDs). The `≥ lg` compact heading (prefix hidden) SHALL stay as is.

#### R10: Docs and comments
`docs/site/skill/tutorial.md` SHALL describe clicking **Operator** (or the chord) instead of typing into a launcher input. Comments describing the "launcher box" / "standing launcher" in `operator-state-glyph.tsx`, `lib/quake-terminal.ts`, `lib/keybindings.ts`, `lib/compose-draft-store.ts` and `quake-terminal.tsx` SHALL be updated.

### Non-Goals
- No change to `QuakeCompose` in `quake-terminal.tsx` (still "Ask the operator…"), the mobile operator path, or the backend.
- No restore of the `PageType:` prefix at `lg`.

### Design Decisions

#### Registry-level compact rung
**Decision**: the registry carries an optional compact bar form; the probe measures both and a pure `computeFit` decides full / compact / overflow.
**Why**: a self-folding child changes its own width and feeds the probe a moving measurement.
**Rejected**: self-measuring launcher (fit feedback loop).
*Introduced by*: 261102-ogop-operator-launcher-right-button

#### `dropLast`, not `pinned`
**Decision**: the launcher entry is `dropLast` at the registry head.
**Why**: `pinned` entries never reach the menu and assume a single head entry, but the launcher needs an overflow row.
**Rejected**: `pinned`.
*Introduced by*: 261102-ogop-operator-launcher-right-button

## Tasks

### Phase 1: Fit arithmetic

- [x] T001 Add `TOP_BAR_COMPACT_HYSTERESIS_PX`, `FitItem`, `FitResult` and pure `computeFit` to `app/frontend/src/lib/top-bar-overflow.ts`; add unit cases (full fit, compact-first, compact still overflowing, hysteresis hold/expand, no compact-capable entries) to `app/frontend/src/lib/top-bar-overflow.test.ts` <!-- R8 -->

### Phase 2: Core implementation

- [x] T002 Rewrite `app/frontend/src/components/quake-launcher.tsx`: shared `useQuakeLauncher` hook, one-button `QuakeLauncher` (`compact`, `probe` props), always-mounted `QuakeLauncherFocusCapture`, `QuakeLauncherMenuRow`-ready `activate`; delete input/ghost/collapsed/width-ladder/Enter-send/paste <!-- R1 R2 R3 R4 R5 -->
- [x] T003 Rework `QuakeTerminalMenuRow` in `app/frontend/src/components/top-bar-overflow-menu.tsx` into the "Operator" row (desktop: launcher semantics; mobile: `requestQuakeTerminal`) <!-- R7 -->
- [x] T004 In `app/frontend/src/components/top-bar.tsx`: add `compactBarRender` + `dividerAfter` + `probe` arg to `RegistryEntry`; add the head `quake-terminal` entry (replace the menuOnly one); compact probe + `computeFit` in the measure effect with hysteresis; render divider; mount `QuakeLauncherFocusCapture`; delete the center-cell mount; rewrite the launcher comments <!-- R5 R6 R7 R8 R9 -->

### Phase 3: Integration, tests, docs

- [x] T005 Rewrite `app/frontend/src/components/quake-launcher.test.tsx` for the one-button contract <!-- R1 R2 R3 R4 R5 -->
- [x] T006 Update `app/frontend/src/components/top-bar.test.tsx` (placement, order, divider, modes, mobile, overflow row, single row, compact rung) <!-- R6 R7 R8 -->
- [x] T007 [P] Update e2e refs in `app/frontend/tests/e2e/quake-terminal.spec.ts`, `window-heading.spec.ts`, `web-view-lens.spec.ts` to the single `quake-launcher` button, with Proves/Steps JSDoc <!-- R1 R3 R4 -->
- [x] T008 [P] Update launcher comments in `operator-state-glyph.tsx`, `lib/quake-terminal.ts`, `lib/keybindings.ts`, `lib/compose-draft-store.ts`, `quake-terminal.tsx` and `docs/site/skill/tutorial.md` <!-- R10 -->
- [x] T009 Add `app/frontend/tests/demo/operator-button.demo.ts` and record `just demo operator-button --before` <!-- R1 R3 R6 R8 -->
- [x] T010 Run typecheck, unit tests, affected e2e specs <!-- R1 -->

## Execution Order

- T001 blocks T004; T002 blocks T003 and T004; T004 blocks T005–T009.

## Acceptance

### Functional Completeness

- [x] A-001 R1: one `<button data-testid="quake-launcher">` in every state; no input/ghost/collapsed/width ladder remains
- [x] A-002 R2: glyph + "Operator" + keycap + draft dot, tooltips and `aria-label` per the spec
- [x] A-003 R3: click semantics for rest / open / operator route / no operator
- [x] A-004 R4: latch via `aria-expanded` + well; accent edge follows `engaged` only
- [x] A-005 R5: restore-origin capture runs in `QuakeLauncherFocusCapture`, not the button or probe
- [x] A-006 R6: launcher is leftmost in `top-bar-right` before `surface-toggles` with a conditional divider, on all four modes, absent on mobile
- [x] A-007 R7: head registry entry is `dropLast`, merged row "Operator" shows once, mobile row keeps `requestQuakeTerminal`
- [x] A-008 R8: `computeFit` folds the label before any overflow and applies expand hysteresis
- [x] A-009 R9: center cell holds only the heading; stale launcher comments are gone
- [x] A-010 R10: tutorial and listed comments updated

### Removal Verification

- [x] A-011 R1: no `quake-launcher-input|ghost|collapsed` references remain in src or tests (only the demo spec's deliberate base-ref branch and the unit test's retired-id assertion name them)

### Scenario Coverage

- [x] A-012 R3: unit + e2e cover click-at-rest, click-while-open, Esc restore, blur-no-step
- [x] A-013 R8: unit tests cover the compact rung and hysteresis; e2e/demo cover labelled → glyph-only → menu row

### Edge Cases & Error Handling

- [x] A-014 R2: no `SessionContext` degrades to no operator, no state dot, no crash
- [x] A-015 R5: invariant (a) holds for a mouse-entered open (origin `null`)

### Code Quality

- [x] A-016 Pattern consistency: new code follows naming and structure of surrounding code (`controlClass`, `Tip`, registry)
- [x] A-017 No unnecessary duplication: shared hook serves bar button and menu row; existing helpers reused
- [x] A-018 Comments state constraints only — no narration, no change IDs (two stale registry comments noted as should-fix)
- [x] A-019 Magic numbers are named constants (hysteresis)
- [x] A-020 New behavior carries tests; modified Playwright tests carry updated Proves/Steps

## Notes

- Check items as you review: `- [x]`

## Deletion Candidates

- `app/frontend/src/components/top-bar-overflow-menu.tsx` `QuakeLauncherRoute` type — duplicates the unexported `LauncherProps` in `quake-launcher.tsx`; export one and reuse it
- `app/frontend/src/components/top-bar-overflow-menu.tsx` `QuakeTerminalMenuRow` name — the row is now "Operator" (the launcher's menu form); the old name no longer describes it

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Follow intake assumptions #1–#20 verbatim | Settled at clarify | S:95 R:80 A:90 D:90 |
| 2 | Confident | Probe copy of the launcher omits the `quake-launcher*` testids (a `probe` flag passed to `barRender`) | Avoids duplicate testids that would break strict-mode locators | S:70 R:85 A:80 D:70 |
| 3 | Confident | The divider lives in the registry slot wrapper (`dividerAfter`), always present in the probe (worst-case width), rendered in the bar only when another fit candidate follows | Keeps fit width conservative and the bar free of orphan dividers | S:65 R:85 A:75 D:65 |
| 4 | Confident | Accent edge uses Tailwind's important form `border-accent-green!` over the latched arm's `border-border-pressed` | Class-order ties are unreliable; the e2e class assertion keeps matching | S:65 R:90 A:75 D:70 |

4 assumptions (1 certain, 3 confident, 0 tentative).
