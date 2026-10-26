# Plan: Web tab strip redesign — folder tabs, width ladder, kind chip, URL-row diet

**Change**: 261026-akdh-web-tab-strip-redesign
**Intake**: `intake.md`

## Requirements

Design authority: `docs/wiki/web-tab-strip-studies.html` variant B (§2 live mock, §3 ladder, §4 kind, §5 URL row, §6 mobile). Where intake and study differ, the intake wins.

### Web tile: tab strip

#### R1: Inset strip ground and folder active tab
The web tab strip (`data-testid="web-tab-strip"`, `app/frontend/src/components/iframe-window.tsx`) SHALL sit on an inset ground (`bg-bg-inset`, ~30px tall, ~4px top padding, tabs bottom-aligned, `border-b border-border` rule kept). The active tab SHALL render as a "folder": the raised surface `bg-bg-card` (shared with the URL row below), 6px rounded top corners, a 1px dimmed card border (the `rk-card-border` mix) on top/left/right, no bottom border, a 1px negative bottom margin so it overlaps the strip rule, and stacked above its siblings. Inactive tabs SHALL be `text-text-secondary` with no fill, `hover:text-text-primary`, separated by hairlines that are hidden on either side of the active tab. The old `gap-px` + active `bg-bg-primary` styling SHALL be removed.

- **GIVEN** a web tile with four declared tabs and tab 4 active
- **WHEN** the strip renders
- **THEN** tab 4 has the `bg-bg-card` fill, rounded top corners, and no bottom border, and visually joins the URL row
- **AND** tabs 1–3 have no fill, secondary text, and hairline separators between 1|2 and 2|3 but none between 3|4

#### R2: Width ladder sizing function
A pure DOM-free module `app/frontend/src/lib/web-tab-ladder.ts` SHALL export named constants `WEB_TAB_MAX_W = 200`, `WEB_TAB_ACTIVE_FLOOR_W = 110`, `WEB_TAB_ICON_THRESHOLD_W = 72`, `WEB_TAB_ICON_W = 34` and `sizeWebTabs(count, available, activeIndex) → { widths, iconOnly, scroll }` implementing the study's `sizeTabs`: share `w = available / count`; `w ≥ 200` → all 200; else `w ≥ 110` → all `floor(w)`; else the active entry is 110 and each inactive entry is `max(floor((available − 110)/(count − 1)), 34)`, icon-only when that share is below 72; `scroll` is true iff `110 + o·(count − 1) > available` (o = the inactive width). `count = 0` returns empty arrays and `scroll: false`; `count = 1` returns one entry.

- **GIVEN** 12 entries, 760px available, active index 3
- **WHEN** `sizeWebTabs(12, 760, 3)` runs
- **THEN** index 3 is 110 and the other 11 are 59 with `iconOnly` true, and `scroll` is false
- **AND** `sizeWebTabs(16, 400, 0)` yields inactive widths of 34 with `scroll` true

#### R3: Ladder wiring
`IframeWindow` SHALL measure the strip's available width with a `ResizeObserver` (no polling; available = strip width minus its padding and the `+` button) and apply `sizeWebTabs` widths inline to each declared tab and draft in strip order. Labels SHALL truncate with an ellipsis (no unbounded `whitespace-nowrap`). An icon-only tab SHALL keep its label in the DOM visually hidden (accessible name and e2e text matching survive) and keep its `title` tooltip. While `scroll` is true the strip SHALL show a trailing-edge fade mask, and selecting a tab SHALL scroll it into view.

- **GIVEN** a 16-tab family in a narrow tile
- **WHEN** the strip overflows
- **THEN** the trailing edge fades and the selected tab is scrolled into view
- **AND** each icon-only tab's `role="tab"` still exposes its title as its accessible name

#### R4: Close affordance under the ladder
The active tab SHALL always show its `×`. Labelled inactive tabs SHALL keep today's rule (hover/focus-within reveal on fine pointers, always visible on coarse pointers). Icon-only inactive tabs SHALL hide `×` even on coarse pointers; middle-click (`auxclick` button 1) and roving-focus Delete/Backspace SHALL still close them.

- **GIVEN** a coarse pointer and an icon-only inactive tab
- **WHEN** the strip renders
- **THEN** that tab shows no `×`
- **AND** a middle-click on it still calls `onCloseTab`

#### R5: Drafts in the ladder
Drafts SHALL be counted in the ladder after the declared tabs, in strip order. A selected draft SHALL be the ladder's active entry (110 floor) and take the folder surface with a dashed top/left/right border in place of the solid card border. Draft testids (`web-tab-draft`, `web-tab-draft-close`) and behavior (Enter materializes, Esc discards, blank `web-draft-panel`) are unchanged.

- **GIVEN** three declared tabs and a selected draft
- **WHEN** the strip renders
- **THEN** the draft gets the active width and a dashed folder outline, and the declared tabs render inactive

#### R6: Tab icon ladder
Each tab's icon slot SHALL resolve: loading spinner (`web-tab-spinner`, unchanged) → favicon (unchanged sources and `failedFavicons` fallback) → a neutral page glyph (`text-text-secondary`, ~13px, from `components/top-bar-icons.tsx` with a `data-icon`). The page glyph SHALL be hued by kind (`text-accent-green` present · `text-signal-yellow` proxy · `text-signal-blue` external; `relative` stays neutral) only when the declared family mixes kinds (more than one distinct `classifyAddress` kind among declared tabs; drafts excluded). `KIND_DOT_CLASS` and the kind dot SHALL be removed.

- **GIVEN** four `present` tabs without favicons
- **WHEN** the strip renders
- **THEN** every tab shows the neutral grey page glyph
- **AND** after a `/proxy/5173/` tab joins the family, the present glyphs turn green and the proxy glyph amber

### Web tile: URL row

#### R7: Address kind chip
The address field SHALL lead with a kind chip (`data-testid="web-kind-chip"`, `shrink-0 rounded border px-1.5 text-[10px]`) derived from the active declared tab's stored slot URL: `present` (green classes), `:<port> proxy` (amber; `?` when the port is unparseable), `external` (blue); `relative` renders no chip. The derivation SHALL live in one shared helper in `app/frontend/src/lib/web-url.ts` (returning `{ text, cls } | null`). The chip stays visible while the address is being edited and is absent while a draft is selected and in onboarding.

- **GIVEN** the active tab is `/proxy/5173/`
- **WHEN** the URL row renders
- **THEN** the chip reads `:5173 proxy` with the amber classes
- **AND** for a `/tutorial/tutorial.html#ch1` tab no chip renders

#### R8: Tile header drops the kind badge
`app/frontend/src/components/surface-layout.tsx` SHALL no longer render the web kind badge (`webBadge`, `data-testid="web-kind-badge"`). Every content-bearing web tile header SHALL render the title branch — the `://` glyph, the page title (`webPageTitles.get(tileWinId) ?? meta`), the home chip, and the `keys → page` capture chip — including `relative`-kind addresses. The onboarding `://  Web` header is unchanged.

- **GIVEN** a web tile whose active tab is relative (`/tutorial/tutorial.html#ch1`)
- **WHEN** the header renders
- **THEN** it shows the page title (or meta fallback) and no `web-kind-badge`

#### R9: URL row layout and address field
The URL row SHALL be ~33px on the raised surface (`bg-bg-card`) with a card-border bottom rule, ordered `◀ ▶ ↻ [address] ⌕ ↗ ⋯` (back/forward still iff `supports.history`; Find and Open-in-browser behavior unchanged). The address field SHALL be an unbordered inset wrapper (~24px, `bg-bg-inset`, transparent border, 4px radius, `INPUT_FOCUS` ring kept) holding `[kind chip][input]` with ~11.5px text; the input keeps `aria-label="URL"`, the display/edit split, the submit ladder, the draft placeholder, and the inline `role="alert"` submit-error slot. All strip and URL-row Tips keep `placement="top"`.

- **GIVEN** a desktop web tile with history support
- **WHEN** the URL row renders
- **THEN** its controls appear in the order back, forward, refresh, address, find, open-in-browser, `⋯`
- **AND** no inline zoom control or Inspect button renders in the row

#### R10: Overflow menu
A `⋯` button (new register glyph) SHALL open a keyboard-reachable `role="menu"` holding a Zoom row with an inline `− NNN% +` stepper (keeps `data-testid="web-zoom-control"` and the `Zoom out` / `Reset zoom` / `Zoom in` aria-labels; stepping keeps the menu open) and an `Inspect page` row only when `supports.devtools`. The menu SHALL follow the GuiToolbarMenu idioms (focus to the first row on open, ↑/↓ rove with wrap, Enter/Space activate, Escape/Tab close and refocus `⋯`, outside pointerdown closes) and SHALL hold `useOccludes("transient", open)` — on the native engine the guest hides while the menu is open (accepted; no inline native zoom affordance). The palette rows `Web: Zoom in/out`, `Web: Reset zoom`, `Web: Inspect page` stay registered unchanged. `⋯` is not rendered in the onboarding state.

- **GIVEN** a web tile at 100% zoom
- **WHEN** the user opens `⋯` and presses `Zoom in` twice
- **THEN** the menu stays open, its percentage reads the stepped value, and the page zooms
- **AND** Escape closes the menu and returns focus to `⋯`

#### R11: Zoom chip
A zoom chip (e.g. `125%`) SHALL render after the address field and before `⌕` only when the active frame's zoom ≠ 100%; clicking it SHALL reset zoom (`applyZoom("reset")`).

- **GIVEN** zoom stepped to 125%
- **WHEN** the menu closes
- **THEN** a `125%` chip shows beside the address; clicking it resets to 100% and the chip disappears

### Web tile: mobile

#### R12: Mobile URL row
`SurfaceLayout` SHALL pass a `mobile` prop to `IframeWindow`. On mobile the strip SHALL use the same folder treatment and ladder; the URL row SHALL be `↻ [address] ⋯`, and the `⋯` menu SHALL carry Back, Forward (iff `supports.history`), Find in page, Open in browser, the Zoom stepper, and Inspect page (iff `supports.devtools`).

- **GIVEN** a 375px viewport
- **WHEN** a web tile renders
- **THEN** the URL row shows only refresh, the address, and `⋯`
- **AND** Back, Forward, Find and Open in browser are reachable from `⋯`

### Web tile: preserved contract

#### R13: Non-regression of the strip contract
The change SHALL preserve: roving-focus tablist semantics and keys (←/→/Home/End, Enter/Space, Delete/Backspace, ⌥⇧←/⌥⇧→), pointer-drag reorder (6px threshold, `web-tab-drop-indicator`), middle-click close, drafts, the 16-tab cap and its disabled `+` Tip, double-click empty strip → draft, eager never-re-`src`d per-tab engines (`key={`${engineKind}:${tabUrl}`}`), both engines (the native guest's bounds re-measure from the placeholder rect under the new chrome heights), the document CustomEvents, and every existing e2e `data-testid`.

- **GIVEN** the existing `web-tabs`, `web-tile-chrome`, `web-tile-find`, `web-tile-capture`, `web-view-lens` and `present-*` specs
- **WHEN** they run after the change (updated only where the chrome shape changed)
- **THEN** they pass

### Docs and evidence

#### R14: Design study and index row
`docs/wiki/web-tab-strip-studies.html` SHALL be committed with the change, and `docs/specs/index.md` § Wiki SHALL gain a `Web Tab Strip Studies` row in the existing rows' style (link `../wiki/web-tab-strip-studies.html`, the 261026 discussion, its sections, the decision — variant B + folder, variant C rejected — and "Self-contained; open in a browser").

- **GIVEN** the merged change
- **WHEN** a reader opens `docs/specs/index.md`
- **THEN** the Wiki table links the study with that description

#### R15: Tests and PR evidence
Unit tests SHALL cover the ladder rungs, the chip helper, the icon hue rule, the menu contents (desktop vs mobile, Inspect gating), and the zoom chip; Playwright specs touched SHALL keep Constitution § Test Intent Comments. Demo specs SHALL exist for before/after recordings: `app/frontend/tests/demo/web-tab-strip.demo.ts` (desktop + mobile web lane) and `app/desktop/tests/demo/web-tab-strip.demo.ts` (shell lane — the menu occludes the native guest and Inspect is native-only).

- **GIVEN** `just demo web-tab-strip --before`
- **WHEN** it runs on a throwaway rig
- **THEN** it records web desktop, web mobile and shell videos for both base and change

### Non-Goals

- Merging the tabs into the tile header (study variant C) — rejected by the user.
- Moving the `keys → page` capture chip into the URL row — that applied only to variant C.
- Any backend, API, tmux-option, or CLI change; palette tab verbs (`lib/palette/web-tabs.ts`) keep their behavior.

### Design Decisions

#### Folder active tab
**Decision**: The active web tab is a raised `bg-bg-card` "folder" on an inset strip ground, joined to a URL row on the same surface by breaking the rule under the tab.
**Why**: It is the only treatment that shows which tab owns the URL row without a legend.
**Rejected**: Green underbar (green is already the focus/latch signal, so an unfocused tile's selected tab would read as focused); inset well (reads as a pressed toggle and fails on light themes per the Toggle Depth study).
*Introduced by*: 261026-akdh-web-tab-strip-redesign

#### Width ladder with share-width icon rung
**Decision**: Tabs share the strip evenly up to 200px, the active tab floors at 110px, inactive shares under 72px go icon-only at their share width (34px floor), and only then does the strip scroll.
**Why**: Bounded, browser-like tabs that never leave an empty run and keep the selected title readable.
**Rejected**: Unbounded `whitespace-nowrap` labels (one long title eats the strip); a fixed 34px icon-only width (leaves a large empty run).
*Introduced by*: 261026-akdh-web-tab-strip-redesign

#### Kind lives in the address chip
**Decision**: The address/kind badge moves from the tile header into the address field as a leading chip; tab icons fall back to a neutral page glyph hued only in mixed-kind families.
**Why**: Kind describes the active address, and a uniform family of `rk present` pages turned the per-tab dot into noise.
**Rejected**: Keeping the header badge (duplicates the active tab); always-hued tab dots.
*Introduced by*: 261026-akdh-web-tab-strip-redesign

#### URL-row diet behind `⋯`
**Decision**: Zoom and Inspect move into a `⋯` overflow menu; a zoom chip appears beside the address only when zoom ≠ 100%.
**Why**: Rarely used controls took five slots; the chip shows zoom state exactly when it is unusual.
**Rejected**: An inline native-only zoom stepper outside the menu (kept one URL-row shape across engines; the menu's occlusion of the native guest was accepted).
*Introduced by*: 261026-akdh-web-tab-strip-redesign

## Tasks

### Phase 1: Setup

- [x] T001 [P] Create `app/frontend/src/lib/web-tab-ladder.ts` (named constants + `sizeWebTabs`) and `app/frontend/src/lib/web-tab-ladder.test.ts` covering every rung: ≥200, even shrink, active floor, labelled inactive ≥72, icon-only share width <72 with the 34 floor, scroll threshold, count 0/1, a draft as the active index, and the worked examples from intake § 2 <!-- R2 -->
- [x] T002 [P] Add the shared kind-chip helper (e.g. `webKindChip(url): { text, cls } | null`, built on `classifyAddress` + `proxyPortOf`) to `app/frontend/src/lib/web-url.ts` with cases in `app/frontend/src/lib/web-url.test.ts` (present, proxy with port, proxy without parseable port → `:? proxy`, external, relative → null, empty → null) <!-- R7 -->
- [x] T003 [P] Add `WebPageGlyph` (neutral page) and `MoreGlyph` (`⋯`) register glyphs with `data-icon`s to `app/frontend/src/components/top-bar-icons.tsx`, matching the existing glyph conventions <!-- R6, R10 -->

### Phase 2: Core Implementation

- [x] T004 Restyle the strip in `app/frontend/src/components/iframe-window.tsx`: inset ground, folder active tab (`bg-bg-card`, rounded top, card-border top/left/right, no bottom border, −1px bottom margin, stacked), inactive styling, hairline separators hidden beside the active tab, and the selected draft's dashed folder outline; remove `gap-px` and the active `bg-bg-primary`. Add any utility that Tailwind cannot express (separators, fade mask) as an `rk-*` class in `app/frontend/src/globals.css` <!-- R1, R5 -->
- [x] T005 Wire the ladder in `iframe-window.tsx`: a `ResizeObserver` on the strip feeding `sizeWebTabs` over declared tabs + drafts (active index = selected draft if any, else the active tab), inline widths, `min-w-0 truncate` labels, icon-only tabs with a visually hidden label and kept `title`, the trailing fade mask while `scroll`, and scroll-into-view of the selected tab on selection <!-- R3, R5 -->
- [x] T006 Apply the close-affordance rules in `iframe-window.tsx`: active always shows `×`; labelled inactive keeps the hover/coarse rule; icon-only inactive hides `×` even on coarse; middle-click and roving Delete/Backspace unchanged <!-- R4 -->
- [x] T007 Replace the kind dot with the icon ladder in `iframe-window.tsx`: spinner → favicon → `WebPageGlyph`, hued by kind only when the declared family has more than one distinct `classifyAddress` kind (relative stays neutral); delete `KIND_DOT_CLASS` <!-- R6 -->
- [x] T008 Rebuild the URL row in `iframe-window.tsx`: ~33px on `bg-bg-card` with a card-border bottom rule; order back, forward, refresh, address, find, open-in-browser, `⋯`; the address wrapper (unbordered inset ~24px, ~11.5px text, `INPUT_FOCUS` ring on focus-within) holding the `web-kind-chip` (from T002; absent for drafts/onboarding) and the existing input with its aria-label, edit/display split, submit ladder and `role="alert"` slot; Tips stay `placement="top"` <!-- R7, R9 -->
- [x] T009 Create `app/frontend/src/components/web-overflow-menu.tsx` following the `gui-toolbar-menu.tsx` idioms (`role="menu"`, `Control variant="menu-row"` rows, `POPOVER_SHELL`, anchored under `⋯`, `useOccludes("transient")`, ↑/↓ wrap, Enter/Space, Escape/Tab refocus anchor, outside pointerdown closes) with a Zoom stepper row that keeps the menu open (`web-zoom-control`, `Zoom out`/`Reset zoom`/`Zoom in` labels) and an `Inspect page` row iff `supports.devtools`; wire `⋯` into `iframe-window.tsx` (not rendered in onboarding) and remove the inline zoom control and Inspect button from the row <!-- R10 -->
- [x] T010 Add the zoom chip in `iframe-window.tsx`: rendered after the address and before `⌕` only when the active frame's zoom ≠ 100%; click → `applyZoom("reset")` <!-- R11 -->
- [x] T011 In `app/frontend/src/components/surface-layout.tsx`, remove `webBadge` / `web-kind-badge` and render the title branch for every content-bearing web tile (relative included), keeping the `://` glyph, title with meta fallback, home chip and capture chip; onboarding header unchanged <!-- R8 -->

### Phase 3: Integration & Edge Cases

- [x] T012 Pass `mobile` from `SurfaceLayout` to `IframeWindow` (`surface-layout.tsx` ~L996) and implement the mobile URL row `↻ [address] ⋯` with Back/Forward (iff history), Find in page, Open in browser, Zoom stepper and Inspect (iff devtools) as `⋯` rows <!-- R12 -->
- [x] T013 Update unit tests: `app/frontend/src/components/iframe-window.test.tsx` / `iframe-window.stub-engine.test.tsx` (chip per kind and absence for relative/draft/onboarding, neutral vs hued glyph, menu contents desktop vs mobile and Inspect gating, zoom chip only ≠100% and click reset, icon-only accessible name, `×` rules) and `app/frontend/src/components/surface-layout.test.tsx` (badge assertions removed, relative tile renders the title branch) <!-- R4, R6, R7, R8, R10, R11, R12 -->
- [x] T014 Update Playwright specs with Test Intent Comments: `app/frontend/tests/e2e/web-tabs.spec.ts` (folder active tab, ladder shrink/icon-only/scroll, `×` rules), `web-tile-chrome.spec.ts` (row order, address chip), `web-tile-zoom.spec.ts` (zoom via `⋯`, chip appears ≠100% and resets, onboarding has no `⋯`, palette stepping unchanged); verify `web-view-lens`, `web-tile-find`, `web-tile-capture`, `present-*` still pass and adjust only shape-changed assertions; check `app/desktop/tests/e2e/web-native.spec.ts` for URL-row assumptions <!-- R13, R15 -->
- [x] T015 Verify the folder surface (`bg-bg-card` on `bg-bg-inset`) is visibly distinct on a dark and a light theme via Playwright screenshots on the worktree rig (`just dev` / `just pw`); if it is not, derive a `--color-bg-raise` in the theme derivation instead and record the decision in plan § Assumptions <!-- R1 -->

### Phase 4: Polish

- [x] T016 [P] Add the `Web Tab Strip Studies` row to `docs/specs/index.md` § Wiki (the study file `docs/wiki/web-tab-strip-studies.html` is already in the worktree and ships with the change) <!-- R14 -->
- [x] T017 [P] Author demo specs `app/frontend/tests/demo/web-tab-strip.demo.ts` (folder tab, ladder shrinking as tabs are added, mixed-kind glyphs, address chip, `⋯` menu zoom + chip reset; desktop and mobile) and `app/desktop/tests/demo/web-tab-strip.demo.ts` (same flow on the native engine, incl. the menu hiding the guest and the Inspect row), following `_demo.ts` and the existing demos; confirm `just demo web-tab-strip` records <!-- R15 -->
- [x] T018 Run the gates scoped first, then full: `cd app/frontend && npx tsc --noEmit`, the touched Vitest files, the touched e2e specs via `just pw test <name>`, then `just test` and `just build` <!-- R13, R15 -->

## Execution Order

- T001–T003 precede the Phase 2 tasks that consume them (T005 needs T001; T007 needs T003; T008 needs T002; T009 needs T003)
- T004 → T005 → T006 (same strip markup); T008 → T009 → T010 (same URL row); T011 is independent of T004–T010
- T012 depends on T008–T010; T013–T015 follow Phase 2; T018 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: The strip renders on `bg-bg-inset`; the active tab carries the folder surface (`bg-bg-card`, rounded top, no bottom border, overlapping the rule); inactive tabs have no fill and secondary text with separators hidden beside the active tab
- [x] A-002 R2: `web-tab-ladder.ts` exports the four named constants and `sizeWebTabs` matching the study's `sizeTabs` on every rung, with unit tests for each
- [x] A-003 R3: Tab widths come from `sizeWebTabs` via a `ResizeObserver` (no polling); labels ellipsis-truncate; icon-only tabs keep a visually hidden label and `title`
- [x] A-004 R4: Active `×` always shown; labelled inactive keeps the hover/coarse rule; icon-only inactive hides `×` even on coarse pointers
- [x] A-005 R5: Drafts are sized by the ladder and a selected draft shows the dashed folder outline at the active width
- [x] A-006 R6: Tab icons resolve spinner → favicon → `WebPageGlyph`; glyphs are neutral in single-kind families and hued in mixed ones; `KIND_DOT_CLASS` is gone
- [x] A-007 R7: `web-kind-chip` renders per kind from one shared `web-url.ts` helper and is absent for relative, draft and onboarding states
- [x] A-008 R8: `web-kind-badge` no longer exists; every content-bearing web header (relative included) shows the title branch with home and capture chips intact
- [x] A-009 R9: The URL row order is back, forward, refresh, address, find, open-in-browser, `⋯`, on `bg-bg-card`, with the unbordered inset ~11.5px address field keeping the focus ring and error slot
- [x] A-010 R10: `⋯` opens a keyboard-reachable `role="menu"` with the zoom stepper (`web-zoom-control`, stays open) and Inspect only with devtools; it holds `transient` occlusion; it is absent in onboarding; palette zoom/inspect rows are unchanged
- [x] A-011 R11: The zoom chip appears only when zoom ≠ 100% and resets zoom on click
- [x] A-012 R12: On mobile the URL row is `↻ [address] ⋯` and Back/Forward/Find/Open in browser are `⋯` rows
- [x] A-013 R14: `docs/specs/index.md` § Wiki links `../wiki/web-tab-strip-studies.html` in the existing style, and the study file is part of the change
- [x] A-014 R15: Demo specs exist under `app/frontend/tests/demo/` and `app/desktop/tests/demo/` and record with `just demo web-tab-strip`

### Behavioral Correctness

- [x] A-015 R9: The address input is no longer `text-sm` in a bordered 28px field; zoom and Inspect no longer render inline in the URL row
- [x] A-016 R8: A relative-kind web tile header shows the page title instead of the `Web` label + meta chip

### Removal Verification

- [x] A-017 R6: No kind-dot markup or `KIND_DOT_CLASS` remains in `iframe-window.tsx`
- [x] A-018 R8: No `webBadge` derivation remains in `surface-layout.tsx`; the kind derivation exists only in the `web-url.ts` helper

### Scenario Coverage

- [x] A-019 R2: Unit tests assert the worked examples (4@760, 8@760, 9@760, 12@760 → 110 + 11×59 icon-only, 16@400 → scroll)
- [x] A-020 R10: A test opens `⋯`, steps zoom twice with the menu staying open, and closes with Escape returning focus to `⋯`
- [x] A-021 R11: A test steps zoom away from 100%, sees the chip, clicks it, and sees zoom back at 100% with the chip gone
- [x] A-022 R13: `web-tabs`, `web-tile-chrome`, `web-tile-zoom`, `web-tile-find`, `web-tile-capture`, `web-view-lens` and `present-*` e2e specs pass

### Edge Cases & Error Handling

- [x] A-023 R2: `count` 0 and 1 are handled without division errors
- [x] A-024 R3: A full 16-tab family in a narrow tile scrolls with the trailing fade and keeps the selected tab in view
- [x] A-025 **N/A**: unreachable by construction — `classifyAddress` returns `proxy` only when a port parsed (`loopbackPortOf`/`proxyPathPort` non-null), and `proxyPortOf` re-derives that same non-null value, so the `?? "?"` arm in `webKindChip` can never fire (no input exercises it; noted as a nice-to-have parsimony finding)
- [x] A-026 R1: The folder surface is visibly distinct from the strip ground on both a dark and a light theme (screenshot evidence or a recorded token decision)

### Code Quality

- [x] A-027 Pattern consistency: New code follows the naming and structure of `iframe-window.tsx`, `gui-toolbar-menu.tsx` and the `lib/web-*.ts` modules
- [x] A-028 No unnecessary duplication: The kind derivation and the menu idioms reuse existing utilities (`classifyAddress`, `proxyPortOf`, `Control`, `POPOVER_SHELL`, `useOccludes`)
- [x] A-029 Type narrowing: New frontend code narrows with guards and discriminated unions rather than `as` casts
- [x] A-030 No magic numbers: Ladder widths and thresholds are named constants
- [x] A-031 No client polling: The ladder measures with `ResizeObserver`, not timers
- [x] A-032 Keyboard-first: Every action moved into `⋯` stays reachable by keyboard and keeps its command-palette row (Constitution V)
- [x] A-033 Comment discipline: Comments state constraints only — no narration, change IDs or PR numbers
- [x] A-034 Tests: New behavior has unit tests and touched Playwright `test()`s carry Proves/Steps intent comments
- [x] A-035 Verification gates: `npx tsc --noEmit`, the Vitest suite, the touched e2e specs, and `just build` pass

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/frontend/src/components/top-bar-icons.tsx:196 InspectGlyph` — zero call sites after the Inspect button moved into the `⋯` menu (the menu row is text-only); the register glyph is now dead code

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The `⋯` menu is a new `web-overflow-menu.tsx` that reuses `Control`, `POPOVER_SHELL` and `useOccludes` and mirrors `GuiToolbarMenu`'s keyboard idioms, rather than generalizing `GuiToolbarMenu`. | `GuiToolbarMenu` rows are palette rows that close on pick and its `kind` is gui-specific; the web menu needs a zoom stepper that keeps the menu open. Generalizing would widen a shipped component's contract for one consumer. | S:70 R:80 A:70 D:60 |
| 2 | Certain | Ladder `available` is the strip's measured width minus its horizontal padding and the `+` button; the ladder sizes declared tabs and drafts together. | Intake § 2 defines `available` that way and counts drafts in strip order. | S:90 R:85 A:85 D:85 |
| 3 | Confident | Demo spec name `web-tab-strip` for both lanes so one `just demo web-tab-strip --before` records web and shell together. | `scripts/demo.sh` routes by spec location and records both lanes when the name exists in both. | S:70 R:90 A:80 D:70 |
| 4 | Certain | The address chip and zoom chip live inside the URL row; the capture chip stays in the tile header. | Intake § 4 and § 5 are explicit; the study's capture-chip move was variant-C-only. | S:95 R:90 A:90 D:95 |
| 5 | Confident | The intake's worked example "8 @ 760 → 8×95" is a misread; the study's `sizeTabs` (authoritative per the intake) yields active 110 + 7×92 labelled for 8@760 (share 95 < 110 falls to the active-floor rung). Unit tests assert the study's values. | Intake § 2 declares `sizeTabs` authoritative for every rung, and its code is unambiguous; the parenthetical worked example contradicts it. | S:80 R:75 A:45 D:45 |

4 assumptions (2 certain, 2 confident, 0 tentative).
