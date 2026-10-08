# Plan: Full-Height Sidebar — the sidebar column owns the top-left band

**Change**: 260915-lm5q-full-height-sidebar-head
**Intake**: `intake.md`

## Requirements

### Top bar: the sidebar head

#### R1: `SidebarHead` paints the sidebar column's head over the bar's left end
`TopBar` (`app/frontend/src/components/top-bar.tsx`) MUST render a named `SidebarHead` component when `!isMobile && hasSidebar && sidebarOpen`: `absolute inset-y-0 left-0 flex items-center gap-2 pl-3 pr-3` with inline `width`, containing (a) the brand anchor to `/` — `aria-label="RunKit home"`, `rk-brand-glitch`, `LogoSpinner size={20}` driven by the `useBrandLogoSweep()` instance `TopBar` already holds (passed down, never a second hook call), wordmark `text-xs font-bold tracking-wide`, wrapped in the crumb's `Tip label="Host"` — and (b) the sidebar toggle `<button aria-label="Toggle navigation">` with `HamburgerIcon isOpen={hamburgerOpen}` on the icon `controlClass` with the cluster hamburger's rest colors, `ml-auto`. The working preview already in the tree is the starting point: harden it into the component, drop the `PREVIEW` comments and the `previewSidebarWidth` name, and write contract comments only (what the head is, why it paints over the bar instead of being a grid column, the shared-`bg-bg-chrome` dependency, the inset's lockstep with the stage constants).

- **GIVEN** the terminal route at desktop width with the sidebar open
- **WHEN** the top bar renders
- **THEN** the head renders with the `RunKit home` link (tooltip "Host" on focus/hover) and the `Toggle navigation` button, both keyboard-reachable
- **GIVEN** the sidebar closed, or a mobile viewport, or the Host page
- **WHEN** the top bar renders
- **THEN** no head renders and the bar is exactly today's

#### R2: Header inset and the continuous seam
The `<header>` MUST become `relative` and, while the head shows, take inline `style={{ paddingLeft: headWidth + 12 }}` where `headWidth = sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX`; when not shown it MUST carry no inline `paddingLeft` (the class `px-3` alone). The `border-b-[3px] border-border` MUST stay on the single full-width header and MUST NOT be split, moved or duplicated onto the head — the one continuous line is the user's explicit requirement. `STAGE_PADDING_PX = 6` and `STAGE_COLUMN_GAP_PX = 6` MUST be exported from `components/shell/shell.tsx` and used by `stageStyle` itself (`padding`, `columnGap`) so the head cannot drift from the stage geometry; `top-bar.tsx` imports them.

- **GIVEN** the head is shown at `sidebarWidth = 220`
- **WHEN** the header renders
- **THEN** `header.style.paddingLeft === "244px"` and the header's computed `border-bottom-width` is `3px` across its full width
- **GIVEN** the head is hidden
- **THEN** `header.style.paddingLeft === ""`

#### R3: Left cluster and breadcrumb gating while the head shows
While the head shows, the left cluster MUST NOT render the hamburger and the breadcrumb nav MUST NOT render the brand root crumb (its `hidden sm:contents` wrapper), so `RunKit home` and `Toggle navigation` each render exactly once. The nav MUST NOT open with a `›`: express the gating ONCE — `rootSeparator = !headShown` (before the collapsed `… ▾` rung and before the server crumb, both branches) and `sessionSeparator = showServerCrumb || rootSeparator` (before the session crumb, both branches) — replacing the preview's five per-line conditions. The cluster comment saying the hamburger is first MUST be rewritten to the conditional; history ◀ ▶ lead the cluster while the head shows.

- **GIVEN** the head shows on the terminal route with a server crumb
- **THEN** the server crumb has no leading `›` and the session crumb keeps its `›`
- **GIVEN** the head shows on the server route (no server crumb)
- **THEN** the session crumb has no leading `›`
- **GIVEN** the sidebar closes
- **THEN** the hamburger is the cluster's first element and the brand crumb is the nav's first child again

### Sidebar

#### R4: Brand row is mobile-only
`components/sidebar/index.tsx` MUST render `SidebarBrand` only when `isMobile` (`{isMobile && <SidebarBrand />}`); the section rail becomes the sidebar's first desktop row. The render-site comment (phone-vs-desktop role split) and `SidebarBrand`'s JSDoc MUST be rewritten to the new contract, keeping the note that its accessible name is the wordmark text, deliberately not `RunKit home`.

- **GIVEN** a mobile viewport with the drawer open
- **THEN** the brand row renders at the top of the sidebar
- **GIVEN** a desktop viewport
- **THEN** no brand row renders inside the aside

#### R5: Keyboard reachability verified, nothing added
The toggle MUST remain a real `<button>` in both positions and the head's brand a real `<a>`; the `sidebar-toggle` palette builtin (`KeyB`) and Shell's `useSidebarKeyboardToggle` chord MUST be unchanged. Focus management after a head-initiated toggle is NOT added (recorded open question).

- **GIVEN** the head shows
- **WHEN** the user Tabs from the window start
- **THEN** the brand link and the toggle button receive focus in order

### Tests

#### R6: Unit coverage
`top-bar.test.tsx` MUST cover: desktop + `sidebarOpen` → head present with both controls, no cluster hamburger, nav has no `RunKit home` link and its first rendered child is not a separator, header inline `paddingLeft` equals the `ChromeProvider` default `sidebarWidth` + 24; `sidebarOpen: false` → hamburger first in the cluster, brand crumb first in the nav, no head, no inline `paddingLeft`; `mode: "host"` → no head; mobile (`matchMedia` stub) → no head; separator gating with and without the server crumb. Existing tests at lines ~420/438/699 are re-checked, not rewritten. `sidebar/index.test.tsx` MUST cover `SidebarBrand` present with `makeMatchMedia(true)` and absent on the desktop stub. `shell.test.tsx` MUST compare the rendered `padding` / `columnGap` against the exported constants.

- **GIVEN** `just test-frontend` (full)
- **THEN** every Vitest suite passes and `npx tsc --noEmit` is clean

#### R7: E2e — touched specs updated, one new spec, single-spec gates
The apply MUST grep `app/frontend/tests/e2e/*.spec.ts` for `RunKit home`, `Toggle navigation`, `Toggle sidebar` and brand-crumb / hamburger-position wording and update comments and assertions that assume the brand crumb or a first-position hamburger on desktop (expected: `tooltips.spec.ts`, `top-bar-persistence.spec.ts`, `pane-register-panel.spec.ts`). A new `app/frontend/tests/e2e/full-height-sidebar.spec.ts` on the `chrome-material.spec.ts` mocked-backend idiom (1440×900, terminal route) MUST assert: the head's box lies within `x < asideRight + 6` where the aside box gives the sidebar edges, the head's `Toggle navigation` button lies left of the aside's right edge, the `header` is one element spanning the full viewport width with computed `border-bottom-width` `3px`, and the breadcrumb nav's first child is not a separator; with the constitution's file header and Proves/Steps JSDoc. Gates run as SINGLE specs: `full-height-sidebar.spec`, `chrome-material.spec`, `tooltips.spec`, `top-bar-persistence.spec`, `pane-register-panel.spec`.

- **GIVEN** each listed spec run via `just test-e2e <name>.spec`
- **THEN** it passes

### Docs (apply-owned; memory is hydrate's)

#### R8: Study and index reflect the built variant
`docs/wiki/sidebar-material-studies.html` § F row 3 MUST flip `park` → built 2026-09-16 (reuse `.tag.rec`, text "built") with the Why rewritten to the head-in-bar mechanism and the continuous-border requirement, and the filmstrip candidate label array entry for `fullh` MUST read `built`. The `docs/specs/index.md` wiki row MUST say "full-height built (head-in-bar)" in place of "full-height parked". No `docs/specs/*.md` body changes.

- **GIVEN** the study and the index
- **THEN** neither still describes full-height as parked

### Non-Goals
- Restructuring the root grid so the sidebar is a real column spanning the bar row — rejected (see Design Decisions).
- Focus management after the toggle relocates (open question, follow-up).
- Moving the quake-terminal launcher chip; mobile layout changes; any color/token change; `app.tsx` wash wrapper.
- Memory hydration (hydrate stage). The archive move of `260915-zeid-chrome-material-surface` in the tree rides the ship commit untouched.

### Design Decisions

#### Head painted over the bar, not a root-grid column
**Decision**: `TopBar` paints an absolutely positioned `SidebarHead` over its left end, sized from the stage constants; the DOM and root grid are unchanged.
**Why**: Since the chrome material change, header wash, head, stage ground and sidebar all paint `bg-bg-chrome`, so a painted head is visually identical to a real spanning column — and the 3px border stays on one element, the simplest proof of a continuous line. The dependency is stated in the component comment.
**Rejected**: Moving the sidebar out of Shell into the root grid (Shell owns the aside per route; TopBar is root-mounted; the drag handle, zen override and mobile drawer hang off Shell's stage — a large refactor for no visual gain).
*Introduced by*: 260915-lm5q-full-height-sidebar-head

#### Continuous seam on a single element
**Decision**: The header keeps `border-b-[3px] border-border` full-width; the head carries no border.
**Why**: The user's one hard requirement is that the line reads continuous left to right; one element cannot be split.
**Rejected**: A head with its own bottom border (a seam between two borders), or a border on the sidebar aside (starts 6px lower, breaking the line).
*Introduced by*: 260915-lm5q-full-height-sidebar-head

#### Brand row is mobile-only
**Decision**: `SidebarBrand` renders only on mobile; the desktop brand lives in the head.
**Why**: Two brands stacked 50px apart on desktop would be redundant; on phones the drawer's brand row is the only brand surface.
**Rejected**: Keeping the in-aside brand row on desktop under the head.
*Introduced by*: 260915-lm5q-full-height-sidebar-head

#### Toggle relocation without focus management
**Decision**: Toggling from the head unmounts it and mounts the cluster hamburger; no focus is moved.
**Why**: The user asked to verify keyboard reachability, not add behavior; palette entry and chords remain the keyboard path.
**Rejected**: Focusing the relocated toggle after a toggle-initiated relocation (deferred to a follow-up).
*Introduced by*: 260915-lm5q-full-height-sidebar-head

## Tasks

### Phase 1: Setup

- [x] T001 `components/shell/shell.tsx`: export `STAGE_PADDING_PX = 6` and `STAGE_COLUMN_GAP_PX = 6` with contract JSDoc; `stageStyle` uses them for `padding` / `columnGap`; `shell/shell.test.tsx` compares the rendered values against the constants <!-- R2 -->

### Phase 2: Core Implementation

- [x] T002 `components/top-bar.tsx`: from the preview already in the tree, extract `SidebarHead` (props `width`, `onToggleSidebar`, `hamburgerOpen`, `brandSweep`; `Tip label="Host"` around the brand anchor); compute `sidebarHeadWidth` / `headShown` from `useChromeState().sidebarWidth` + the imported stage constants; header `relative` + inline `paddingLeft` only when shown; remove `PREVIEW` comments / `previewSidebarWidth`; contract comments <!-- R1 -->
- [x] T003 `components/top-bar.tsx`: hamburger and brand root crumb gated on `!headShown`; `rootSeparator` / `sessionSeparator` expressed once and applied at the five separator sites; rewrite the left-cluster comment <!-- R3 -->
- [x] T004 [P] `components/sidebar/index.tsx`: `{isMobile && <SidebarBrand />}`; rewrite the render-site comment and `SidebarBrand`'s JSDoc <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T005 `components/top-bar.test.tsx`: the R6 cases (head present/absent by state, cluster/nav contents, inline paddingLeft, host mode, mobile stub, separator gating with and without the server crumb); re-check lines ~420/438/699 <!-- R6 -->
- [x] T006 [P] `components/sidebar/index.test.tsx`: `SidebarBrand` present under `makeMatchMedia(true)`, absent on desktop <!-- R6 -->
- [x] T007 [P] Grep `tests/e2e/*.spec.ts` for `RunKit home` / `Toggle navigation` / `Toggle sidebar` / brand-crumb / hamburger-first wording; update `tooltips.spec.ts`, `top-bar-persistence.spec.ts`, `pane-register-panel.spec.ts` (and any other hit) comments and assertions to the head contract <!-- R7 -->
- [x] T008 New `tests/e2e/full-height-sidebar.spec.ts` per R7 on the `chrome-material.spec.ts` idiom (file header + Proves/Steps JSDoc) <!-- R7 -->
- [x] T009 Verify keyboard reachability: Tab order in the head (unit or e2e), the `sidebar-toggle` palette builtin and Shell's chord untouched — assert existence, add nothing <!-- R5 -->
- [x] T010 Gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full); `just test-e2e full-height-sidebar.spec`, `chrome-material.spec`, `tooltips.spec`, `top-bar-persistence.spec`, `pane-register-panel.spec` — one spec per run, never the full suite; `just setup` first if the rig lacks pieces <!-- R7 -->

### Phase 4: Polish

- [x] T011 `docs/wiki/sidebar-material-studies.html` § F row 3 (`park` → built, Why rewritten) + the filmstrip label array entry for `fullh`; `docs/specs/index.md` wiki row "full-height parked" → "full-height built (head-in-bar)" <!-- R8 -->

## Execution Order

- T001 before T002 (the constants are imported)
- T002 before T003 (gating reads `headShown`)
- T005–T009 after Phase 2; T010 last in Phase 3

## Acceptance

### Functional Completeness

- [x] A-001 R1: `SidebarHead` is a named component rendering the `Tip`-wrapped `RunKit home` anchor (shared brand sweep) and the `Toggle navigation` button; no `PREVIEW` comment or `previewSidebarWidth` remains
- [x] A-002 R2: `STAGE_PADDING_PX` / `STAGE_COLUMN_GAP_PX` are exported from `shell.tsx`, used by `stageStyle`, and imported by `top-bar.tsx`; the header is `relative` with inline `paddingLeft = headWidth + 12` only while the head shows
- [x] A-003 R2: the 3px bottom border is on the single full-width header and nowhere else
- [x] A-004 R3: hamburger and brand crumb are gated on `!headShown`; `rootSeparator` / `sessionSeparator` are declared once and applied at all five separator sites
- [x] A-005 R4: `SidebarBrand` renders only on mobile; both comments rewritten
- [x] A-006 R5: palette `sidebar-toggle` builtin and Shell chord unchanged; toggle and brand are real button / anchor in both positions
- [x] A-007 R8: study § F row 3, filmstrip label and the specs-index row say built, not parked

### Behavioral Correctness

- [x] A-008 R1: with the sidebar closed, on mobile, or on the Host page, the bar renders exactly as before (hamburger first, brand crumb root, no head, no inline paddingLeft)
- [x] A-009 R3: while the head shows, `RunKit home` and `Toggle navigation` each occur exactly once in the document and the nav's first child is not a separator
- [x] A-010 R2: at `sidebarWidth` 220 the header's inline `paddingLeft` is `244px`

### Scenario Coverage

- [x] A-011 R7: `full-height-sidebar.spec` passes (head within the sidebar track, toggle left of the aside's right edge, one header with a 3px bottom border spanning the viewport, no leading separator)
- [x] A-012 R7: `chrome-material.spec`, `tooltips.spec`, `top-bar-persistence.spec`, `pane-register-panel.spec` pass after their updates
- [x] A-013 R6: `just test-frontend` passes in full and `tsc --noEmit` is clean

### Edge Cases & Error Handling

- [x] A-014 R1: at `SIDEBAR_MIN_WIDTH` (160) the head's brand and toggle fit without truncation or overlap (unit test or screenshot evidence in the review findings)
- [x] A-015 R3: server route (no server crumb) with the head shown — the session crumb has no leading `›`; terminal route — the server crumb has none and the session crumb keeps its own

### Code Quality

- [x] A-016 Pattern consistency: the head reuses `controlClass`, `HamburgerIcon`, `LogoSpinner`, `Tip`, and the existing sweep; no duplicated brand markup beyond the head
- [x] A-017 No magic numbers: the 6/6 geometry lives only in the exported constants; the `+ 12` is documented as the `px-3` offset
- [x] A-018 Type narrowing over assertions: no new `as` casts
- [x] A-019 Tests included: every changed behavior has a colocated unit test and the layout change has the e2e spec
- [x] A-020 No comment narration: contract comments only, no change IDs or PR numbers, no "previously"/"now" wording
- [x] A-021 Test intent comments: every new `test()` carries Proves / Steps JSDoc and the new spec has a shared-setup header
- [x] A-022 Tests conform to spec: assertions encode R1–R8, not implementation accidents

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Worktree notes: run tests only through `just`; single e2e specs only; the shell is zsh (never name a variable `status`); frontend deps are installed; the working tree already contains the preview edits and the archive move — build on the former, leave the latter alone.

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant: the cluster hamburger and brand root crumb still render whenever the head is hidden (`!headShown`), `SidebarBrand` still renders on mobile, and the preview scaffolding (`PREVIEW` comments, `previewSidebarWidth`) was consumed by the change itself; the desktop in-aside brand-row render was removed in place per R4, leaving no orphan.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Head-in-bar mechanism, preview as the starting point, `Tip label="Host"` added | Intake assumptions 1, 7 | S:95 R:75 A:90 D:95 |
| 2 | Certain | Stage constants exported from `shell.tsx` and consumed by both `stageStyle` and `top-bar.tsx` | Intake assumption 3; prevents drift | S:90 R:90 A:95 D:95 |
| 3 | Confident | Separator gating names `rootSeparator` / `sessionSeparator` | Intake assumption 6 leaves names to the agent | S:60 R:95 A:85 D:75 |
| 4 | Confident | The head-fit-at-160px check is a unit assertion on rendered widths if jsdom allows, else screenshot evidence at 160px attached from the e2e spec | jsdom has no layout; the e2e spec can set the width via the persisted `runkit-sidebar-width` key | S:45 R:90 A:70 D:65 |
| 5 | Certain | Touched e2e specs are updated in wording/assertions only; behavior they prove is unchanged | Intake § 6 grep list; names stay unique | S:75 R:95 A:85 D:85 |
| 6 | Certain | Memory files untouched at apply; hydrate owns them (incl. superseding the "Hamburger statically rendered" DD) | Stage ownership | S:90 R:95 A:95 D:95 |

6 assumptions (4 certain, 2 confident, 0 tentative).
