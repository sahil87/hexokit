# Plan: Surface Layout Tree Model

**Change**: 260925-ww92-surface-layout-tree
**Intake**: `intake.md`

## Requirements

### Layout Model: The canonical split tree

#### R1: Tree grammar and canonical form
The layout SHALL be a canonical split tree `node = leaf | split`, `leaf = tty | code | web | gui`, `split = dir "(" node "," node {"," node} ")"`, `dir ∈ {h, v}` (h = children left→right, v = top→bottom), with no whitespace. A canonical tree MUST have ≥2 children per split, MUST NOT nest a split inside a parent of the same direction, MUST hold 1–3 leaves (the cap stays in this change), and MUST NOT repeat a non-tty kind (duplicate `tty` leaves are legal). `parseLayoutTree` MUST return `null` for any input that violates these rules, including a non-canonical tree. It MUST NOT normalise the input on read.

- **GIVEN** the raw value `h(tty,v(code,web))`
- **WHEN** `parseLayoutTree` runs
- **THEN** it returns `{dir:"h", children:[{leaf:"tty"},{dir:"v", children:[{leaf:"code"},{leaf:"web"}]}]}`
- **AND** `h(h(tty,web),code)`, `h(tty)`, `h(tty,web,code,gui)`, `h(web,web)` and `h( tty,web)` each return `null`

#### R2: Legacy preset strings parse losslessly, permanently
`parseLayoutTree` SHALL also accept the legacy `<shape>:<a>,<b>[,<c>]` grammar under today's `parseLayout` rules and convert it:

| Legacy | Tree |
|---|---|
| `single:X` | `X` |
| `split-h:a,b` | `h(a,b)` |
| `split-v:a,b` | `v(a,b)` |
| `row:a,b,c` | `h(a,b,c)` |
| `col:a,b,c` | `v(a,b,c)` |
| `main-left:a,b,c` | `h(a,v(b,c))` |
| `main-right:a,b,c` | `h(v(b,c),a)` |
| `main-top:a,b,c` | `v(a,h(b,c))` |

- **GIVEN** the stored value `main-right:tty,code,web`
- **WHEN** the frontend renders it
- **THEN** tty fills the right column and code/web stack on the left, identical to today
- **AND** `templateOf` of the parsed tree reports `main-right` with slots `[tty, code, web]`

#### R3: Writers always emit the tree form
`serializeLayoutTree` SHALL always emit the tree form. No writer (frontend `applyLayout`, `rk tab layout`, `rk present`/`webAddShow`, the legacy-translation write) SHALL emit a preset string. `parseLayoutTree(serializeLayoutTree(t))` MUST deep-equal `t` for every canonical tree.

- **GIVEN** a layout rendered from `split-h:tty,web`
- **WHEN** the user adds `code` through the top-bar toggle
- **THEN** `@rk_win_layout` becomes `h(tty,v(web,code))`

#### R4: Pure tree operations
`app/frontend/src/lib/layout-tree.ts` SHALL provide pure, DOM-free `normalise`, `removeLeaf`, `insertBeside`, `swapLeaves`, `layoutRects`, `structureSig`, `TEMPLATES`, `templateOf` and `templatesFor`, ported from the study's reference script (`docs/wiki/surface-drop-zone-studies.html`: `norm`, `removeLeaf`, `dropEdge`, `swapLeaves`, `layoutRects`, `TEMPLATES`, `templateOf`). Their results SHALL be canonical, keep the leaf multiset (except remove/insert by exactly one leaf), and carry sizes per study §6. `swapLeaves` SHALL be an involution. The functions are N-generic, and their tests run to N = 4.

- **GIVEN** every canonical placement for N = 2, 3, 4 (4 / 36 / 528, the study's enumeration)
- **WHEN** each operation is applied
- **THEN** the output is canonical, `parse ∘ serialize` is the identity, swap applied twice is the identity, and the leaf multiset is preserved
- **AND** at N = 3 the set of structures reachable equals the five 3-tile presets plus `main-bottom`

#### R5: Templates replace presets
`TEMPLATES` SHALL define `row`, `col`, `main-left`, `main-right`, `main-top`, `main-bottom`, each building a tree for any N from a slot order (study `TEMPLATES`, main fraction 0.58). `templateOf(tree)` SHALL return `{name, slots}`: `single` at N = 1, the first template in registry order whose structure matches, otherwise `custom` with slots in reading order. `templatesFor(n)` SHALL list the structurally distinct templates at N in registry order: `[]` for 1, `[row, col]` for 2, `[row, col, main-left, main-right, main-top, main-bottom]` for 3. *(PR review: the study's `grid` template was dropped. At N ≤ 3 it is structurally `main-bottom`, so it returns when the cap lifts.)*

- **GIVEN** the tree `v(h(code,web),tty)`
- **WHEN** `templateOf` runs
- **THEN** it returns `{name:"main-bottom", slots:["tty","code","web"]}`

#### R6: Slot order preserves "slot A = main"
Every consumer that read `layout.order` (slot A first) SHALL read `slotOrder(tree) = templateOf(tree).slots`, so slot A remains the template's main tile (e.g. the right tile of `main-right`), and falls back to reading order for a custom tree. Mobile slot A, the zoom fallback and palette ordering use it.

- **GIVEN** `h(v(code,web),tty)` on a phone with no stored zoom
- **WHEN** the mobile layout renders
- **THEN** the visible tile is `tty`

### Layout Verbs: Generic add, close, promote, swap, template

#### R7: Add splits the last leaf along its longer axis
`addSurface(tree, kind, rects?)` SHALL split the **last leaf in reading order** along its longer axis (ties → `h`), placing the new leaf after it (right or bottom). It SHALL use that leaf's real rect when the caller passes rects (desktop) and a nominal 1600×1000 box otherwise (mobile, CLI). It SHALL return `null` at 3 leaves or for a repeated non-tty kind.

- **GIVEN** `tty` with no rects
- **WHEN** `web` is added, then `code`
- **THEN** the results are `h(tty,web)` then `h(tty,v(web,code))` (today's `split-h` → `main-left`)
- **AND** on a portrait container where the last leaf is taller than wide, the first add yields `v(tty,web)`

#### R8: Close removes and normalises
`closeSurface(tree, leafId)` SHALL be `removeLeaf` + `normalise`, with the neighbours absorbing the size. It SHALL return `null` for the last leaf.

- **GIVEN** `v(tty,code,web)`
- **WHEN** `code` closes
- **THEN** the result is `v(tty,web)` (a column stays a column, which is a behaviour change from today's `split-h`)

#### R9: Promote swaps with slot A
`promote(tree, leafId)` SHALL swap the leaf with `slotOrder(tree)[0]`. It is a no-op when the leaf is absent or already slot A.

- **GIVEN** `h(tty,v(code,web))`
- **WHEN** `web` is promoted
- **THEN** the result is `h(web,v(code,tty))`

#### R10: Directional and sequential swap
`swapDirectional(tree, leafId, dir, rects?)` SHALL swap with the nearest leaf across that edge whose rect overlaps on the perpendicular axis (ties: larger overlap, then reading order). It uses caller rects or the nominal box and is a no-op without a neighbour. `swapWithNext(tree, leafId)` SHALL swap with the next leaf in reading order, wrapping; the header ⇄ verb keeps using it in this change.

- **GIVEN** `h(tty,v(code,web))`
- **WHEN** `web` swaps up
- **THEN** the result is `h(tty,v(web,code))`
- **AND** `web` swapping right is a no-op

#### R11: Template jump and cycle
`applyTemplate(tree, name)` SHALL rebuild `TEMPLATES[name](n)` from `slotOrder(tree)`, and SHALL return `null` when the name is not in `templatesFor(n)`. `cycleTemplate(tree)` SHALL move to the next entry of `templatesFor(n)` after the current template (wrapping). A `custom` tree cycles to the first template, and N = 1 is a no-op.

- **GIVEN** `h(tty,code,web)` (row)
- **WHEN** the cycle chord fires twice
- **THEN** the layout becomes `v(tty,code,web)` then `h(tty,v(code,web))`

#### R12: Degradation drops leaves, keeping structure
`degradeLayout` SHALL drop each unavailable leaf via `removeLeaf` + `normalise`. `effectiveLayout` SHALL remain parse → degrade → fallback `tty`, and it never rewrites the option. `tty` and `web` never degrade, and `gui` degrades with `hasGui(host)`.

- **GIVEN** `v(tty,h(gui,web))` on a host with gui disabled
- **WHEN** it renders
- **THEN** the rendered tree is `v(tty,web)` and `@rk_win_layout` is unchanged

### Viewer State: Sizes

#### R13: Per-viewer sizes keyed by structure signature
Divider sizes SHALL persist per viewer in localStorage under `rk-layout-sizes:{server}:{windowId}:{structureSig}`, where `structureSig` uses reading-order indices (e.g. `h(0,v(1,2))`). The value SHALL be JSON: one fraction array per split, in pre-order, each summing to 1 (tolerance 1e-6) and matching that split's child count. Reads are validated (otherwise `undefined` → the template's own sizes, else equal splits) and wrapped in try/catch-noop. Writes happen only on divider release. `rk-layout-ratios:*` keys SHALL be ignored (not read, not deleted), and `ratiosStorageKey`/`readStoredRatios`/`writeStoredRatios` are removed.

- **GIVEN** a viewer who dragged `h(tty,v(code,web))`'s vertical divider to 70/30 and released
- **WHEN** they swap code and web
- **THEN** the same stored sizes apply (the structure is unchanged, so the positions keep their sizes)

### Renderer: Flat, rect-positioned leaves

#### R14: Flat leaf list, no re-parenting
`components/surface-layout.tsx` SHALL render every leaf as an absolutely positioned tile in one flat sibling list keyed by leaf id, positioned from `layoutRects(tree, containerBox, sizes, 6)`. A restructure SHALL NOT unmount or re-parent a tile that remains in the tree. Leaf id = kind, with duplicate tty leaves `tty`, `tty#2`, … by reading-order occurrence. Hide-never-unmount, the code-frame LRU and the focused tile SHALL key by leaf id. Primary-tty wiring (`wsRef`/`focusRef`, find bar, progress) goes to the first tty leaf in reading order.

- **GIVEN** `h(tty,web)` with a live web iframe
- **WHEN** `code` is added (→ `h(tty,v(web,code))`)
- **THEN** the web tile's iframe element is the same DOM node (no reload)

#### R15: Dividers between siblings edit two fractions
A divider SHALL render between each adjacent sibling pair of every split, in the 6 px gutter. Dragging it SHALL change only those two siblings' fractions (their sum is constant), clamped so neither side drops below `MIN_PANEL_WIDTH_PX` (280 px) on the divider's own axis. The rest/hover/drag gap-seam chrome, pointer capture, `touchAction:none`, mid-drag `pointer-events-none` on tile content and the `TileDragContext` flag SHALL be preserved. Where a divider's end meets a perpendicular divider, an intersection zone (`surface-divider-intersection`, `cursor: move`) SHALL move both at once and light both sashes. Each divider keeps `role="separator"` with `aria-valuenow`.

- **GIVEN** `h(tty,v(code,web))` at 1440×900
- **WHEN** the user drags the junction zone diagonally
- **THEN** both the h-split and the v-split fractions change, and both persist on release under `rk-layout-sizes:…:h(0,v(1,2))`

### Chrome: ▦ chip, palette, chord

#### R16: ▦ chip lists templates and reads custom
The ▦ chip popover SHALL list `templatesFor(n)` with mini glyphs rendered from each template tree, mark the current one (✓ + `aria-checked`), and apply the choice via `applyTemplate` → `applyLayout`. The chip SHALL read `custom` when `templateOf` returns `custom`. Its overflow-menu form is one `Layout: <Template>` `menuitemradio` per template. Labels: `Row`, `Column`, `Main Left`, `Main Right`, `Main Top`, `Main Bottom`.

- **GIVEN** a 2-tile layout
- **WHEN** the chip opens
- **THEN** it offers exactly Row and Column

#### R17: Palette and chord
`lib/palette/layout.ts` SHALL emit `Layout: <Template>` (id `layout-template-<name>`) for each template at the current N, `Layout: Cycle Template` (id `layout-cycle`, unchanged, chord `⌘;`), `Layout: Promote <Surface>` (new semantics), and `Tile: Swap Left|Right|Up|Down` (ids `tile-swap-left|right|up|down`) for the focused tile, only when a neighbour exists (desktop multi-tile). These replace `layout-shape-*` and the per-kind `layout-swap-*` rows. The `Tile: Show/Hide/Focus/Switch` and `Layout: Expand/Restore` rows are unchanged. Show stays omitted at 3 tiles.

- **GIVEN** `h(tty,v(code,web))` with `web` focused on desktop
- **WHEN** the palette opens
- **THEN** it lists `Tile: Swap Left` and `Tile: Swap Up`, but not `Tile: Swap Right` or `Tile: Swap Down`

### Backend: `internal/layoutspec` and the CLI

#### R18: Go parity
`internal/layoutspec` SHALL port the model: a `Node` type; `Parse(raw)` accepting both grammars with identical rejection rules (canonical form, ≤3 leaves, unknown kind, non-tty repeat); `String()` emitting the tree form; `Default()` = `tty`; `Add` (last leaf, nominal 1600×1000, longer axis), `Close`, `Promote`, `Cycle`, `SetTemplate`, and templates + `TemplateOf`. The sentinels `ErrLayoutFull`, `ErrLayoutLastTile`, `ErrSurfaceAbsent`, `ErrSurfaceRepeat` and `ErrUnknownSurface` remain. `ErrArityMismatch` is replaced by `ErrUnknownTemplate`. A shared fixture table SHALL pin the same inputs → outputs in the Go and TS tests.

- **GIVEN** `rk tab layout @3 main-left:tty,code,web`
- **WHEN** it runs
- **THEN** `@rk_win_layout` is set to `h(tty,v(code,web))`, and that value prints

#### R19: CLI, API and MCP surfaces
`rk tab layout` SHALL accept both grammars positionally; `--add/--rm/--promote/--cycle` SHALL use the ported verbs (`--cycle` walks templates), and every form prints the tree form. `webAddShow` SHALL add `web`, and on a full layout replace the last leaf in reading order with `web`. `rk tab new --layout` SHALL validate either grammar. `POST /api/windows/{id}/options` SHALL validate `@rk_win_layout` with `layoutspec.Parse` and store the value verbatim. Help text, the MCP `tab_layout` argument descriptions and `cmd/rk/skill/{skill,display,tutorial}.md` SHALL describe the tree grammar and note that legacy strings still parse.

- **GIVEN** a full layout `h(tty,v(code,gui))`
- **WHEN** `rk present page.html` runs on that window
- **THEN** the layout becomes `h(tty,v(code,web))`

### Documentation

#### R20: Specs describe the tree model
`docs/specs/surface-layout.md` (§ The Model, § Shape presets → canonical tree + templates, § Verbs, § State sizes key, Constitution Mapping line) and `docs/specs/ui-state.md` § Layout in tmux SHALL describe the tree encoding, the permanent legacy parse, templates, and `rk-layout-sizes:*`. The ≤3 cap is documented as holding until the size floor lands.

- **GIVEN** a reader of `docs/specs/surface-layout.md`
- **WHEN** they look up the layout model
- **THEN** it describes a canonical tree with templates, not "presets, not trees"

### Non-Goals

- Drag to snap, drop zones, result-preview overlay, and header Promote/Swap retirement — change 2
- `web/<n>` and `@N/<surface>` leaf addresses, borrowed tiles, placeholders, the 150×100 size floor, lifting the 3-tile cap — change 4
- Zoom keyed by leaf address (zoom still stores a kind) — change 4
- Migrating or deleting old `rk-layout-ratios:*` keys — ignored by design

### Design Decisions

#### The layout is a canonical tree; presets are templates
**Decision**: `@rk_win_layout` stores a canonical split tree (≥2 children per split, alternating directions). The six templates (`row`, `col`, `main-left|right|top|bottom`) generate trees from slot order, and legacy preset strings parse into their trees permanently.
**Why**: arrangements grow 2/6/22/90/394 for N = 2…6, so presets cannot model N > 3, and the generic drop edit (change 2) needs a tree. Canonical form gives exactly one encoding per arrangement.
**Rejected**: extending the preset list (correct only to N = 3); an unconstrained tree (unary nodes, stored sizes, many encodings per arrangement).
*Introduced by*: 260925-ww92-surface-layout-tree

#### Leaves render flat, positioned from rects
**Decision**: tiles are one flat keyed list of absolutely positioned elements placed from `layoutRects`, not nested split containers.
**Why**: re-parenting an iframe reloads it, so a nested DOM would reload code/web tiles on every restructure.
**Rejected**: a recursive nested flex/grid DOM that mirrors the tree.
*Introduced by*: 260925-ww92-surface-layout-tree

#### Add splits the last leaf along its longer axis
**Decision**: add splits the last leaf in reading order along its longer axis, using real rects on desktop and a nominal 1600×1000 box on mobile and in Go.
**Why**: it reproduces today's `split-h` → `main-left` exactly, does not depend on focus, and keeps the TS and Go tables aligned.
**Rejected**: splitting the focused tile (2→3 with slot A focused yields `h(v(tty,code),web)`; mobile and Go have no focus); split-focused-then-refocus (TS and Go diverge).
*Introduced by*: 260925-ww92-surface-layout-tree

#### Writers always emit the tree form
**Decision**: every writer serializes the tree form, and there is no one-release preset-string fallback.
**Why**: frontend and backend ship in one binary; a downgrade renders a tree value as `single:tty` without rewriting the option, so nothing is corrupted.
**Rejected**: writing the preset string when a tree matches one, which adds a second serializer path to remove later.
*Introduced by*: 260925-ww92-surface-layout-tree

### Deprecated Requirements

#### Preset shapes × order × per-shape ratios
**Reason**: replaced by the canonical tree, templates, and signature-keyed sizes.
**Migration**: legacy strings parse into trees; `rk-layout-ratios:*` is ignored and sizes restart from template defaults.

#### Collapse to split-h / single on close and degrade
**Reason**: replaced by remove + normalise (the remaining structure is kept).
**Migration**: N/A.

## Tasks

### Phase 1: Setup

- [x] T001 Create `app/frontend/src/lib/layout-tree.ts` with the types (`SplitDir`, `LayoutLeaf`, `LayoutSplit`, `LayoutNode`, `LayoutSizes`, `Rect`), the tree grammar parser, the legacy preset converter, `serializeLayoutTree`, canonical validation (≤3 leaves, no non-tty repeat), `leafIds`/reading-order helpers, and `structureSig`. Port from the study script, typed and without `as` casts on the parse path <!-- R1 -->
- [x] T002 In `lib/layout-tree.ts`, port `normalise`, `removeLeaf`, `insertBeside`, `swapLeaves`, `layoutRects` (gap 6) with sizes carried per study §6, plus `TEMPLATES`, `templateOf`, `templatesFor`, `slotOrder` and `TEMPLATE_LABEL` <!-- R4 -->
- [x] T003 Create `app/frontend/src/lib/layout-tree.test.ts`: grammar accept/reject cases, the legacy table for all eight presets, exhaustive N ≤ 4 invariants over the study's enumeration (4/36/528 placements), the N = 3 closure = five presets + main-bottom, `templateOf`/`templatesFor` cases, and a shared fixture table (`layout-tree.fixtures.json` beside it) of input → parse/serialize/verb outputs that the Go tests also read <!-- R2 -->

### Phase 2: Core Implementation

- [x] T004 Rewrite `app/frontend/src/lib/surface-layout.ts`: `Layout` becomes `LayoutNode`, and `effectiveLayout`/`degradeLayout` work on trees. Add the verbs `addSurface(tree, kind, rects?)`, `closeSurface`, `promote`, `swapWithNext`, `swapDirectional`, `applyTemplate`, `cycleTemplate`, and keep `legacyTranslationDecision` writing the tree form. Replace the ratios storage with `sizesStorageKey`/`readStoredSizes`/`writeStoredSizes`. Retire `LayoutShape`, `SHAPE_*`, `ALL_SHAPES`, `shapesForArity`, `COLLAPSE_SHAPE`, `GROWTH_SHAPE`, `setShape`, `cycleShape` and `SHAPE_LABEL`. Update `lib/surface-layout.test.ts` <!-- R7 -->
- [x] T005 Replace `clampBoundary(shape, …)` in `app/frontend/src/lib/right-panel.ts` with a two-sibling fraction clamp (280 px floor per side on the divider's axis, given the split's pixel length), and update `lib/right-panel.test.ts` <!-- R15 -->
- [x] T006 Rewrite the render path of `app/frontend/src/components/surface-layout.tsx`: measure the container, compute `layoutRects` at the viewer's stored sizes, render tiles as one flat keyed list of absolutely positioned wrappers, and key the hide-never-unmount set, the code-frame LRU, focus and zoom resolution by leaf id. Primary tty = first tty leaf in reading order. Remove `gridStyle`/`slotStyle`/`dividerSpecs`/`defaultRatios`/`initialRatios`. Expose the leaf rects to `app.tsx` through a ref seam for add and directional swap <!-- R14 -->
- [x] T007 In `components/surface-layout.tsx`, render the dividers from the tree (one per adjacent sibling pair in each split) with two-fraction drag editing, the T005 clamp, write-on-release under the structure signature, and generalised intersection zones where a divider's end meets a perpendicular divider. Keep the gap-seam chrome, pointer capture, `touchAction`, mid-drag `pointer-events-none`, `TileDragContext` and `aria-valuenow` <!-- R15 -->
- [x] T008 Update `app/frontend/src/app.tsx`: `applyLayout` serializes via `serializeLayoutTree` and the pending/optimistic compare uses serialized trees; `togglePanel`, `switchToTile`, the help-topic handler and focus-hop call the tree verbs (desktop add passes the leaf rects from the T006 seam, mobile uses the nominal box); the header `onPromote`/`onSwap`/`onClose` wiring uses leaf ids; and every `layout.order` read becomes `slotOrder(tree)` or the leaf-kind list as appropriate <!-- R6 -->
- [x] T009 [P] Migrate the remaining `layout.order`/`Layout` consumers to `slotOrder`/leaf helpers: `lib/tile-chord.ts`, `lib/code-folder-latch.ts`, `lib/palette/code.ts`, `lib/focus-memory.ts`, `lib/router-url.ts`, `lib/find-in-page.ts`, `lib/gui-posture.ts`, `lib/keybindings.ts`, `components/compose-strip.tsx`, `components/gui-toolbar.tsx`, `components/sidebar/row-flyout-card.tsx`, `components/top-bar.tsx`, `contexts/top-bar-slot-context.tsx` (and their tests) <!-- R6 -->
- [x] T010 [P] Rewrite `app/frontend/src/components/layout-chip.tsx` to show templates and `custom` (R16); replace the per-shape glyphs in `components/top-bar-icons.tsx` with a mini-tree glyph rendered from a template tree. Update `components/top-bar.test.tsx` and any layout-chip tests <!-- R16 -->
- [x] T011 [P] Rewrite `app/frontend/src/lib/palette/layout.ts` (+ `layout.test.ts`) for the template rows, `Layout: Cycle Template`, the new promote, and the directional `Tile: Swap …` rows (which need focused leaf + rects from the options); remove `layout-shape-*` and `layout-swap-*` <!-- R17 -->
- [x] T012 Rewrite `app/backend/internal/layoutspec/layoutspec.go` (+ `layoutspec_test.go`) as the Go tree port (R18), with the test reading the shared fixture table from T003 <!-- R18 -->
- [x] T013 Update the Go callers: `cmd/rk/tab_layout.go` (both grammars, ported verbs, template cycle, tree output, rewritten Long help), `cmd/rk/tab_web.go` (`webAddShow` replaces the last leaf when full), `cmd/rk/tab_new.go` (help example), `api/windows.go` (validator), `internal/tmux/tmux.go` (comment), `internal/mcp/policy.go` (`tab_layout` descriptions), `cmd/rk/skill/{skill,display,tutorial}.md`, and the affected `_test.go` files <!-- R19 -->

### Phase 3: Integration & Edge Cases

- [x] T014 Update the Vitest component/app suites for the tree encoding: `components/surface-layout.test.tsx` (flat render, the same DOM node for a surviving tile across a restructure, the two-fraction divider edit), `components/surface-layout.web-integration.test.tsx`, `app.test.tsx`, and any other test asserting preset strings; run `just test-frontend` (full) until green <!-- R14 -->
- [x] T015 Update the e2e specs that read back or assert `@rk_win_layout` or preset behaviour to the tree form: `tests/e2e/surface-layout.spec.ts` (incl. the intersection test and the close-a-column behaviour), `help-topics.spec.ts`, `right-panel.spec.ts`, `web-view-lens.spec.ts`, `web-tile-chrome.spec.ts`, `present-auto-expand.spec.ts` (legacy hand-written writes still render), `code-surface.spec.ts`, plus `operator-compose.spec.ts` if the palette count changes. Update every touched `test()`'s Proves/Steps intent comment and run each with `just test-e2e <name>.spec` <!-- R3 -->
- [x] T016 Run the Go gate: `just _ensure-tmux-conf`, then `env -u TMUX -u TMUX_PANE go test ./...` in `app/backend`; `cd app/frontend && npx tsc --noEmit` <!-- R18 -->

### Phase 4: Polish

- [x] T017 Update `docs/specs/surface-layout.md` (§ The Model, § Shape presets → canonical tree + templates, § State, § Verbs table, Constitution Mapping line) and `docs/specs/ui-state.md` § Layout in tmux (tree encoding, legacy parse, `rk-layout-sizes:*`) <!-- R20 -->

## Execution Order

- T001 → T002 → T003 (the fixture table feeds T012)
- T004 needs T002; T005 is independent; T006 → T007 need T004 + T005
- T008 needs T004 + T006; T009–T011 need T004
- T012 needs T003's fixtures; T013 needs T012
- T014–T016 after Phase 2; T017 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `parseLayoutTree` accepts canonical trees and rejects non-canonical, >3-leaf, unknown-kind, repeated non-tty and whitespace inputs
- [x] A-002 R2: all eight legacy presets parse into their trees, identical to the table
- [x] A-003 R3: no production writer emits a preset string; `serialize` round-trips every canonical tree
- [x] A-004 R4: `lib/layout-tree.ts` exports the pure operations, which pass the exhaustive N ≤ 4 invariants
- [x] A-005 R5: `templatesFor(2)` = row, col; `templatesFor(3)` = the six distinct templates; `templateOf` identifies main-bottom and custom
- [x] A-006 R6: slot A is the template's main tile for every consumer that read `layout.order[0]`
- [x] A-007 R7: sequential adds from `tty` give `h(tty,web)` then `h(tty,v(web,code))`; the add returns `null` at 3 leaves
- [x] A-008 R13: sizes persist under `rk-layout-sizes:{server}:{@N}:{sig}` on release only; ratios helpers are gone
- [x] A-009 R16: the ▦ chip lists templates for N and reads `custom` for a non-template tree
- [x] A-010 R17: the palette emits template, cycle, promote and directional swap rows with the specified ids
- [x] A-011 R18: `internal/layoutspec` passes the shared fixture table identically to the TS tests
- [x] A-012 R19: `rk tab layout`, `rk present`, `rk tab new --layout`, `/options` and the MCP descriptions handle both grammars and print or write the tree form
- [x] A-013 R20: both specs describe the tree model, templates and sizes key

### Behavioral Correctness

- [x] A-014 R8: closing one tile of `v(a,b,c)` leaves `v(…)`, not `h(…)`
- [x] A-015 R9: promoting `web` in `h(tty,v(code,web))` gives `h(web,v(code,tty))`
- [x] A-016 R11: the `⌘;` cycle walks `templatesFor(n)`; a custom tree cycles to the first template
- [x] A-017 R12: degradation removes a gui leaf and keeps the remaining structure, without rewriting the option

### Removal Verification

- [x] A-018 R4: no `LayoutShape`, `SHAPE_ARITY`, `SHAPE_RING`, `shapesForArity`, `setShape`, `cycleShape`, `gridStyle`, `slotStyle`, `dividerSpecs` or `rk-layout-ratios` reads remain in production code
- [x] A-019 R18: `ErrArityMismatch`, `shapeArity`, `growthShape`, `collapseShape` and `shapeRing` are gone from `layoutspec`

### Scenario Coverage

- [x] A-020 R14: a test proves a surviving tile's DOM node (the iframe) is unchanged across an add or close restructure
- [x] A-021 R15: a divider drag changes only its two siblings' fractions and respects the 280 px floor; the junction zone moves both (e2e intersection test green)
- [x] A-022 R10: directional swap picks the geometric neighbour and is a no-op without one (unit tests)
- [x] A-023 R3: e2e specs pass reading back tree-form values; `present-auto-expand.spec.ts` still renders hand-written legacy values

### Edge Cases & Error Handling

- [x] A-024 R12: an unset, malformed or fully unavailable value renders `tty`; a non-canonical stored tree renders `tty` and is not rewritten
- [x] A-025 R13: corrupt, mis-shaped or non-summing stored sizes fall back to template or equal sizes without throwing; storage exceptions are swallowed
- [x] A-026 R7: add on a portrait last leaf splits vertically; a square leaf splits horizontally

### Code Quality

- [x] A-027 Pattern consistency: new code follows the pure-module + colocated-test pattern (`window-view.ts`, `surface-layout.ts`), and the Go port mirrors the TS names
- [x] A-028 No unnecessary duplication: TS and Go share one fixture table; no second copy of the template registry per language beyond the port itself
- [x] A-029 Type narrowing over assertions: the parse paths use guards, not `as` casts
- [x] A-030 No god functions: the renderer split into rect computation, divider derivation and tile rendering helpers; no new function over ~50 lines without reason
- [x] A-031 No magic numbers: the 6 px gap, 0.58 main fraction, 1600×1000 nominal box and 280 px floor are named constants
- [x] A-032 Comments state constraints only: no narration and no change IDs in comments
- [x] A-033 Tests: every touched Playwright `test()` carries an up-to-date Proves/Steps intent comment; `just test-frontend` (full), scoped e2e, `tsc --noEmit` and the Go gate pass

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The preset machinery it replaces (`LayoutShape`/`SHAPE_*`/`setShape`/`cycleShape`, `clampBoundary`, `LayoutShapeGlyph`, the `rk-layout-ratios:*` helpers, `layoutspec.Layout`/`ErrArityMismatch`/`shapeArity`/`growthShape`/`collapseShape`/`shapeRing`) was already deleted by the apply diff itself; greps over `app/frontend/src` and `app/backend` find no survivors. (`swapWithNext` stays deliberately — the header ⇄ verb rides it until change 2; the retired `rk-layout-ratios:*` localStorage keys are ignored by design, per the plan's Non-Goals.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Consumers of `layout.order` read `slotOrder(tree)` (template slots, else reading order) so slot A stays the main tile | Preserves today's slot-A semantics for main-right/main-bottom and mobile | S:60 R:80 A:75 D:65 |
| 2 | Confident | TS and Go share one JSON fixture table colocated with `layout-tree.test.ts`, read by the Go test via a relative path | Makes TS/Go parity mechanical rather than hand-mirrored | S:50 R:85 A:70 D:60 |
| 3 | Confident | Template sizes (e.g. main 0.58) seed rendering when no stored sizes exist; equal splits otherwise | The study's templates carry sizes; matches today's main-* default feel | S:55 R:90 A:70 D:65 |
| 4 | Confident | `clampBoundary` becomes a two-sibling clamp in `lib/right-panel.ts` (its current home) | Keeps the clamp where the floor constant lives | S:55 R:90 A:75 D:70 |
| 5 | Confident | Intersection zones generalise to every point where a divider's end meets a perpendicular divider | Keeps the shipped junction affordance and its e2e | S:55 R:80 A:65 D:60 |

5 assumptions (0 certain, 5 confident, 0 tentative).
