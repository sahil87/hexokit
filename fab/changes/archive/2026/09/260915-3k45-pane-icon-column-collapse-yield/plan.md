# Plan: PANE Panel Icon Column + Collapse Yields the Status Bar

**Change**: 260915-3k45-pane-icon-column-collapse-yield
**Intake**: `intake.md`

## Requirements

### Sidebar PANE panel: register icon column

#### R1: A flex-mode `CopyableRow` keeps the 4-advance key column
`CopyableRow` in `app/frontend/src/components/sidebar/status-panel.tsx` MUST render its key column at the same width in `flex` mode as in inline mode: the prefix span's trailing gap SHALL be a no-break space (` `) when `flex` is set, both for the at-rest key (`{prefix}` + NBSP, 4 advances) and for the `copied ✓` feedback (`copied ✓` + NBSP, 9 advances). Inline mode SHALL keep the plain space. In the flex rows (the `cwd` row and `PrLinkRow`) the icon→value gap MUST be an NBSP text node placed outside the 14px icon span (not inside it), so it measures one 12px advance like the inline rows' `{" "}` and the value column lines up too.

- **GIVEN** a window whose active pane has a cwd
- **WHEN** the PANE panel renders the `cwd` row (the only flex-mode `CopyableRow`)
- **THEN** the `cwd` prefix span's text is exactly `"cwd "` and its icon's x-coordinate equals the `tmx`, `git`, `pr`, and `out` icons' x-coordinate, and its value's x-coordinate equals the `tmx`, `git`, and `pr` values' x-coordinate
- **AND** after a click the prefix span reads `"copied ✓ "` — the 9-advance feedback shifts the icon for 1s exactly as it does on the inline rows and `PrLinkRow` (the panel's existing feedback design, unchanged here); flex mode differs from inline mode in nothing but the gap character

- **GIVEN** the same window
- **WHEN** the `tmx` row (inline mode) renders
- **THEN** its prefix span text is exactly `"tmx "` (plain space) — unchanged

### Status bar: the window cluster returns when the PANE panel is collapsed

#### R2: The yield rule requires the panel to be expanded
`paneRegistersVisible` in `app/frontend/src/app.tsx` MUST be `paneSectionVisible && panePanelOpen && sidebarOpen && !zenOn`, where `panePanelOpen` is `useLocalStorageBoolean(PANE_PANEL_OPEN_STORAGE_KEY, PANE_PANEL_DEFAULT_OPEN)` — the same key and default the PANE `CollapsiblePanel` persists, so the bar flips live with the panel's header chevron through the hook's in-module pub/sub. The `StatusBar` mount, `StatusBar` itself, and `CollapsiblePanel` SHALL NOT change.

- **GIVEN** desktop, terminal route, zen off, sidebar open, PANE section on, `runkit-panel-window` = `"false"`
- **WHEN** the shell renders
- **THEN** `status-bar-window` is present and `status-bar-host` is present

- **GIVEN** the same state with the panel expanded (default)
- **WHEN** the user clicks the PANE header toggle (collapse)
- **THEN** `status-bar-window` appears without a remount; clicking again (expand) removes it

- **GIVEN** PANE section off
- **WHEN** the shell renders
- **THEN** behavior is unchanged: `status-bar-window` is present regardless of `runkit-panel-window`

#### R3: The panel's persisted open state is a named, shared constant
`status-panel.tsx` MUST export `PANE_PANEL_OPEN_STORAGE_KEY = "runkit-panel-window"` and `PANE_PANEL_DEFAULT_OPEN = true`, and the `CollapsiblePanel` mount MUST read both from those constants. The string value and default MUST NOT change (persisted user state is preserved).

- **GIVEN** a user who collapsed the PANE panel before this change
- **WHEN** they load the app after it
- **THEN** the panel is still collapsed (same key, same value semantics) and the status bar shows the window cluster

### Non-Goals
- Mobile: the status bar never renders on mobile; nothing changes there.
- Any change to `StatusBar`'s fold/priority logic, `registers.ts`, `CollapsiblePanel`, or `useLocalStorageBoolean`.
- Aligning icon glyph advance widths (the Nerd Font glyphs already share one cell; only the key column was short).

### Design Decisions

#### NBSP inside the prefix span is the flex-row gap contract
**Decision**: In flex mode `CopyableRow` ends its prefix text with ` `, the same idiom `PrLinkRow` uses for its `pr` + 2×NBSP key and `copied ✓` + NBSP feedback.
**Why**: A flex container trims a flex item's trailing collapsible whitespace, so `"cwd "` renders as `"cwd"` and the icon column shifts one advance left. Putting the gap inside the span as a non-collapsible character is the fix that survives every container.
**Rejected**: `whitespace-pre` on the prefix span — works here but departs from the documented idiom and leaves a collapsible space that other containers trim again.
*Introduced by*: 260915-3k45-pane-icon-column-collapse-yield

#### The panel's own open boolean is the fourth yield term
**Decision**: `app.tsx` subscribes to the PANE panel's persisted open state by key via `useLocalStorageBoolean` and ANDs it into `paneRegistersVisible`.
**Why**: "On screen" means visible content; a collapsed panel shows none, so the bar must take the registers back. The boolean already lives in the shared pub/sub store the section toggle uses — no new state, no prop chain, live flips for free.
**Rejected**: Lifting the open state into `ChromeContext` or threading an `onToggle` callback up from the sidebar — new plumbing for a value the hook already broadcasts.
*Introduced by*: 260915-3k45-pane-icon-column-collapse-yield

## Tasks

### Phase 1: Core Implementation

- [x] T001 `app/frontend/src/components/sidebar/status-panel.tsx`: export `PANE_PANEL_OPEN_STORAGE_KEY` / `PANE_PANEL_DEFAULT_OPEN` and use them in the `CollapsiblePanel` mount; in `CopyableRow` make the prefix gap ` ` when `flex` is set (at-rest and `copied ✓`), plain space otherwise, with a one-line comment stating the flex-trim constraint; move the `cwd` and `PrLinkRow` icon→value NBSP out of the 14px icon span into a sibling text node <!-- R1, R3 -->
- [x] T002 `app/frontend/src/app.tsx`: import the two constants and `useLocalStorageBoolean`; add `panePanelOpen` and the fourth term to `paneRegistersVisible`; update the block comment to name all four terms <!-- R2 -->

### Phase 2: Tests

- [x] T003 [P] `app/frontend/src/components/sidebar/status-panel.test.tsx`: pin the flex-mode prefix codepoints (`"cwd "`, `"copied ✓ "` after click) and the inline `"tmx "` <!-- R1 -->
- [x] T004 [P] `app/frontend/src/app.test.tsx` § "status bar window cluster yields…": add "keeps the window cluster when the PANE section is on but the panel is collapsed" (seed `runkit-panel-window = "false"`) and a live-flip case through the PANE header toggle (collapse → cluster present, expand → absent, no remount) <!-- R2, R3 -->
- [x] T005 `app/frontend/tests/e2e/pane-register-panel.spec.ts`: (a) in the mobile/panel describe, an icon-column test asserting the `tmx`/`cwd`/`git`/`pr`/`out` icon spans share one `boundingBox().x` (±0.5) and the Nerd-glyph rows' (`tmx`/`cwd`/`git`/`pr`) value spans do too (the `out` braille glyph's advance is font-dependent, so its value is not asserted); (b) in the desktop yield describe, a test that clicks the PANE header toggle to collapse → `status-bar-window` count 1, header still visible; click again → count 0. Both with Proves/Steps JSDoc; run `just test-e2e pane-register-panel.spec` <!-- R1, R2 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The flex-mode `CopyableRow` prefix ends in ` ` at rest and in the `copied ✓` state; inline mode keeps the plain space
- [x] A-002 R2: `paneRegistersVisible` includes the `panePanelOpen` term read from `PANE_PANEL_OPEN_STORAGE_KEY` / `PANE_PANEL_DEFAULT_OPEN`
- [x] A-003 R3: Both constants are exported from `status-panel.tsx` and consumed by the `CollapsiblePanel` mount and `app.tsx`; the key string is still `"runkit-panel-window"` with default `true`

### Behavioral Correctness

- [x] A-004 R1: In the rendered PANE panel the `tmx`, `cwd`, `git`, `out` icons share one x-coordinate and their values share the next column (e2e)
- [x] A-005 R2: With the section on and the sidebar open, a collapsed PANE panel shows the status bar's window cluster; expanding it yields the cluster again, live, without a `SurfaceLayout` remount

### Scenario Coverage

- [x] A-006 R1: Unit test pins the `cwd` and `tmx` prefix codepoints
- [x] A-007 R2: Unit tests cover seeded-collapsed and live header-toggle cases; e2e covers the header-toggle collapse ↔ cluster round trip
- [x] A-008 R2: Existing yield tests (section off, sidebar collapsed, rail toggle, zen) still pass unchanged

### Edge Cases & Error Handling

- [x] A-009 R2: PANE section off ⇒ window cluster present regardless of `runkit-panel-window`
- [x] A-010 R3: A pre-existing persisted `runkit-panel-window = "false"` is honored (panel collapsed, cluster shown) — no migration needed

### Code Quality

- [x] A-011 Pattern consistency: the NBSP idiom matches `PrLinkRow`; the hook subscription matches `useSidebarSectionVisible`'s use in `app.tsx`
- [x] A-012 No unnecessary duplication: no new state, context, or prop chain; `useLocalStorageBoolean` reused
- [x] A-013 No magic strings: the storage key and default appear once, as exported constants
- [x] A-014 Comments state constraints, not narration; no change IDs or PR numbers in code or test intent comments
- [x] A-015 Tests: `just test-frontend` passes in full; `just test-e2e pane-register-panel.spec` passes; every new e2e `test()` carries Proves/Steps JSDoc

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change fixes the flex-mode gap and extends the yield rule without making existing code redundant; the one displaced artifact (the inline `"runkit-panel-window"` literal at the `CollapsiblePanel` mount) was replaced in the same diff.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The e2e icon-column test lives in the existing mobile/panel describe (section seeded on), reading the icon spans by their `aria-hidden` glyph spans inside each register row | That describe already renders the panel with all four rows; the rows expose stable hooks (`register-output` testid, `title` on cwd, button names on tmx/git) | S:70 R:95 A:85 D:80 |
| 2 | Confident | The e2e collapse test reuses the existing `paneHeader` locator (the CollapsiblePanel title button, `aria-expanded`) as the collapse toggle | It is the panel's only toggle affordance and the existing tests already locate it | S:75 R:95 A:85 D:85 |
| 3 | Confident | The flex rows' icon→value gap moves out of the 14px icon span into an NBSP text node (cwd and PrLinkRow) | Measured in e2e: with the NBSP inside the icon span the cwd value sat 2px right of tmx/git (a 14px advance vs the inline rows' 12px space); an NBSP-only text node survives flex whitespace dropping, verified by the passing alignment test | S:70 R:95 A:85 D:80 |
| 4 | Confident | The `out` row's value column is excluded from the e2e alignment assertion | Its braille glyph's advance depends on the installed fallback font (65 vs 64 here); icons are asserted for all five rows | S:65 R:95 A:80 D:75 |

4 assumptions (1 certain, 3 confident, 0 tentative).
