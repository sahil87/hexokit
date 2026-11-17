# Plan: Unify Sidebar Multi-Select Look with Single Select

**Change**: 261117-z1ea-unify-sidebar-multiselect-look
**Intake**: `intake.md`

## Requirements

### Sidebar: Selection Visual

#### R1: One highlighted treatment for single and bulk selection
A window row's visual selection treatment (deeper family tint `tint.selected` or the uncolored gray sentinel's selected tint, `text-text-primary font-medium`, the coarse rail's selected band, the operator HeadsetIcon's primary ink) SHALL be driven by a single derived flag: `highlighted = selectionActive ? isBulkSelected : isSelected`, where `selectionActive` is true exactly when the bulk selection store is non-empty. The 2px inset accent ring (`boxShadow: inset 0 0 0 2px var(--color-accent)`) SHALL NOT be rendered for selection. The drag-over indicator (`0 -2px 0 0 var(--color-accent)`) SHALL be unchanged.

- **GIVEN** the bulk store is empty and window A is open
- **WHEN** the sidebar renders
- **THEN** only A is painted with the selected treatment, and no selection indicator strip is shown
- **GIVEN** the bulk store holds {B, C} and A is open
- **WHEN** the sidebar renders
- **THEN** B and C are painted with the selected treatment and A is painted unselected
- **AND** no row carries an inset ring box-shadow

#### R2: Semantic attributes stay distinct
`aria-current="page"` SHALL remain bound to the URL selection (`isSelected`); `aria-selected` SHALL remain bound to set membership (`isBulkSelected`) and be emitted only when `onRowClick` is wired.

- **GIVEN** the store holds {B} and A is open
- **WHEN** the sidebar renders
- **THEN** A's button carries `aria-current="page"` and B's treeitem carries `aria-selected="true"`

### Sidebar: Selection Gestures

#### R3: The open tab seeds the selection on the first gesture
When the bulk store is empty and a selection gesture (Cmd/Ctrl-click, Shift-click, or `x`) targets a window row other than the open tab, the open tab's key (`${currentServer}:${currentWindowId}`) SHALL first be added to the selection — but only when that key is a live, non-ghost window known to the tree's data-key registry (`getLiveWindowKeys()`) — and the gesture then applies on top of it.

- **GIVEN** the store is empty and A is open
- **WHEN** the user Cmd-clicks B
- **THEN** the selection is {A, B}, the anchor is B, and the indicator reads `2 selected`
- **GIVEN** the store is empty and A is open
- **WHEN** the user Shift-clicks C (visible order A, B, C)
- **THEN** the selection is {A, B, C} and the anchor stays on A
- **GIVEN** the store is empty, A is open, and the user focuses row B
- **WHEN** the user presses `x`
- **THEN** the selection is {A, B}

#### R4: Toggling the sole open tab is a consumed no-op
When the bulk store is empty and the gesture targets the open tab itself (Cmd/Ctrl-click or `x`), the gesture SHALL be consumed (no navigation) and SHALL leave the store empty.

- **GIVEN** the store is empty and A is open
- **WHEN** the user Cmd-clicks A
- **THEN** the store stays empty, no navigation happens, and A stays highlighted

#### R5: No seeding without an open tab or with a live selection
When there is no open tab (`currentWindowId` null, or its key not in the live data keys), or the store is already non-empty, gestures SHALL behave exactly as before (Cmd-click toggles; Shift-click without an anchor degrades to a toggle; Shift-click with an anchor extends the range). Plain click SHALL still navigate and clear the selection.

- **GIVEN** the user is on the server page (no open window) with an empty store
- **WHEN** the user Cmd-clicks B
- **THEN** the selection is {B}
- **GIVEN** the store holds {A, B} with A open
- **WHEN** the user Cmd-clicks A
- **THEN** the selection is {B} and A un-highlights

### Non-Goals

- Dragging a multi-selected set (onto group rows, board rows, or as a block) — the stacked follow-up change.
- Any change to the `Selection:` palette actions' code or the `SelectionIndicator` structure.

### Design Decisions

#### Bulk selection shares the single-select treatment
**Decision**: A bulk-selected row is painted exactly like the open row; while the store is non-empty, highlight follows set membership; while empty, it follows the URL.
**Why**: Multi-select should read as an extension of single select, not a separate mode; one treatment keeps the sidebar's selection cues borderless.
**Rejected**: The 2px inset accent ring (reads as a foreign mode and is the only bordered selection cue); painting both the URL row and the set (shows a highlighted row that bulk actions won't touch).
*Introduced by*: 261117-z1ea-unify-sidebar-multiselect-look

#### Single select is a selection of one
**Decision**: The first modifier gesture seeds the store with the open tab before applying.
**Why**: Finder/VS Code semantics — Cmd-click extends the current selection and Shift-click ranges from the current item; required for the shared treatment to be truthful.
**Rejected**: Keeping the open tab out of the set until explicitly Cmd-clicked (two rows look selected while the set holds one).
*Introduced by*: 261117-z1ea-unify-sidebar-multiselect-look

## Tasks

### Phase 1: Setup

- [x] T001 Add a pure seeding helper to `app/frontend/src/lib/selection.ts` (e.g. `seedFromOpen(selected, openKey, liveKeys, targetKey)` deciding seed/no-op) plus a `seed(key)` store action in `app/frontend/src/store/selection-store.ts` that replaces an EMPTY selection with `{key}` and sets the anchor to `key` in the same write; unit tests in `lib/selection.test.ts` and `store/selection-store.test.ts` <!-- R3 -->

### Phase 2: Core Implementation

- [x] T002 In `app/frontend/src/components/sidebar/index.tsx`, seed from the open tab in `handleWindowRowClick` (Cmd/Ctrl + Shift paths) and the `x` case of `handleTreeKeyDown`, reading anchor/selection from `useSelectionStore.getState()` after seeding (not the stale closure `selectionAnchor`); make Cmd-click/`x` on the open tab with an empty store a consumed no-op; leave behavior unchanged without an open tab or with a non-empty store <!-- R3 R4 R5 -->
- [x] T003 In `app/frontend/src/components/sidebar/window-row.tsx`, add a `selectionActive` prop and derive `highlighted = selectionActive ? isBulkSelected : isSelected`; route `buttonStyle`, `buttonClass`, `uncoloredSelectedTint`, `railStyle`, and HeadsetIcon ink through `highlighted`; remove the inset ring branch; keep `aria-current` on `isSelected` and `aria-selected` on `isBulkSelected`. Thread `selectionActive={selectedWindows.size > 0}` from `sidebar/index.tsx` to both WindowRow mounts (session tree and operator row) <!-- R1 R2 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Tests: extend `app/frontend/src/components/sidebar/window-row.test.tsx` (highlight rule, no ring, aria split) and `app/frontend/src/components/sidebar/index.test.tsx` (seeding, open-tab no-op, no-open-tab fallback, non-empty store unchanged); update `app/frontend/tests/e2e/sidebar-multiselect.spec.ts` for the seeded model (Cmd-click while viewing yields `2 selected`, ring absent, selected treatment applied, bulk close of a seeded set includes the open window) <!-- R1 R2 R3 R4 R5 -->
- [x] T005 Add `app/frontend/tests/demo/sidebar-multiselect.demo.ts` (view a tab, Cmd-click two more, Shift-click a range, Escape) and record `just demo sidebar-multiselect --before` for PR evidence <!-- R1 R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Bulk-selected rows render `tint.selected` / gray-sentinel selected tint, `font-medium`, `text-text-primary`, and the coarse rail selected band; no selection box-shadow ring exists in `window-row.tsx`
- [x] A-002 R2: `aria-current` follows the URL selection and `aria-selected` follows set membership, emitted only when `onRowClick` is wired
- [x] A-003 R3: Cmd/Ctrl-click, Shift-click, and `x` with an empty store and a live open tab seed the open tab before applying the gesture
- [x] A-004 R4: Cmd-click or `x` on the open tab with an empty store is consumed and leaves the store empty
- [x] A-005 R5: Without an open tab, or with a non-empty store, gestures behave as before; plain click navigates and clears

### Behavioral Correctness

- [x] A-006 R1: With a non-empty store, the open tab is highlighted only if it is in the set
- [x] A-007 R3: Shift-click from an empty store ranges from the open tab and keeps the anchor on it

### Scenario Coverage

- [x] A-008 R3: Unit tests cover seeding on Cmd-click, Shift-click, and `x`; e2e covers Cmd-click-while-viewing → `2 selected`
- [x] A-009 R1: Unit/e2e tests assert the ring is absent and the selected treatment is applied to set members
- [x] A-010 R4: A test covers the open-tab no-op

### Edge Cases & Error Handling

- [x] A-011 R3: A ghost/absent open tab (key not in live data keys) is never seeded
- [x] A-012 R5: Cross-server: an open tab on server X plus a Cmd-click on server Y yields a two-key cross-server set

### Code Quality

- [x] A-013 Pattern consistency: New code follows naming and structural patterns of surrounding code (identity-arg stable callbacks, pure logic in `lib/selection.ts`)
- [x] A-014 No unnecessary duplication: Existing selection utilities (`rangeBetween`, `selectionKey`, store actions) reused
- [x] A-015 Render performance: `WindowRow` receives only a boolean `selectionActive`, never the selection Set; memo contract intact
- [x] A-016 Type narrowing over `as` casts in new frontend code
- [x] A-017 No comment narration or change-id citations in new comments; the obsolete ring comment is removed
- [x] A-018 PR evidence: a `just demo` recording exists for the UI change
- [x] A-019 Tests cover the changed behavior; `npx tsc --noEmit` and the touched unit/e2e suites pass

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant (the one obsolete piece, the render-time `selectionAnchor` subscription in `sidebar/index.tsx`, was already removed in the diff).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Add a `seed(key)` store action that writes selection + anchor together | Respects the store's "every action moves the anchor as part of its own write" stance without a standalone setAnchor | S:60 R:90 A:75 D:70 |
| 2 | Confident | Read anchor from `useSelectionStore.getState()` after seeding instead of the closure | Seeding and the gesture happen in one handler; the closure value is stale after the seed write | S:60 R:90 A:85 D:80 |
| 3 | Certain | `selectionActive` boolean prop rather than passing the Set | Render Performance memo contract; flips only on empty↔non-empty edges | S:70 R:90 A:90 D:85 |

3 assumptions (1 certain, 2 confident, 0 tentative).
