# Plan: Surface Drag to Snap

**Change**: 260925-c1ql-surface-drag-snap
**Intake**: `intake.md`

## Requirements

### Layout: Drop resolver (`app/frontend/src/lib/layout-drop.ts`, pure)

#### R1: Zone geometry
The module SHALL export the named constants `DRAG_THRESHOLD_PX = 4`, `ROOT_EDGE_PX = 18`, `EDGE_BAND_FRACTION = 0.25`, `EDGE_BAND_MIN_PX = 28`, `EDGE_BAND_MAX_PX = 110`, `MIN_TILE_W = 150`, `MIN_TILE_H = 100`, and:
- `edgeBand(dim)` SHALL return `clamp(dim × 0.25, 28, 110)`.
- `zoneAt(rect, point)` SHALL return `center` when the point lies in no side band (left/right bands sized by `edgeBand(rect.w)`, top/bottom by `edgeBand(rect.h)`), otherwise the side with the smallest `distance / band` ratio (corners go to the deepest edge).
- `rootZoneAt(box, point)` SHALL return the side whose distance from the layout box edge is `< ROOT_EDGE_PX` (nearest wins in a corner), else `null`.
- `hitTest(rects, box, point, draggedId)` SHALL return `null` outside the box, a `root` hit when `rootZoneAt` matches (layout-edge bands win over tile bands), `self` over the dragged tile's rect, else a `center` or `edge` hit on the tile under the point. A point inside the box but in a gutter (no tile) SHALL return `null`.

- **GIVEN** a 420 × 280 tile at the origin
- **WHEN** `zoneAt` is asked about (5, 5)
- **THEN** it returns `left` (bands are 105 px and 70 px; 5/105 < 5/70, so left has the smaller distance/band ratio)
- **AND** (210, 140) returns `center`

- **GIVEN** a layout box 1200 × 800
- **WHEN** the pointer is 10 px from the left edge over a tile's left band
- **THEN** `hitTest` returns `{ kind: "root", side: "left" }`

#### R2: Generic drop resolution
`resolveDrop(tree, sizes, draggedId, hit, box)` SHALL return one of `move` (canonical tree + pre-order sizes), `noop`, `too-small`, `cancel`:
- `null` or `self` hit → `cancel`.
- `center` on target T → `swapLeaves(tree, dragged, T)` with sizes staying with positions.
- `edge` on target T at side S, or `root` at side S (target path `[]`) → wrap the target node in a split on S's axis with a placeholder on S's side (the wrap takes the target's share; placeholder and target split 50/50 inside), THEN remove the dragged leaf (its share redistributes to its siblings proportionally), THEN normalise (same-direction merge multiplies fractions; a lifted single child inherits its split's share), THEN rename the placeholder to the dragged leaf's kind. Insert MUST precede remove.
- A root drop gives the dragged tile 50 % of that axis (no 1/N special case).
- The result SHALL be `noop` when its serialized tree equals the input's (sizes are not compared — a drop that only rebalances fractions offers "no change", as in the study).
- The result SHALL be `too-small` when any leaf rect of `layoutRects(result, box, resultSizes)` is narrower than `MIN_TILE_W` or shorter than `MIN_TILE_H`.
- Leaves are addressed by leaf id (`leafIds`), targets by node path; the resolver MUST reuse `lib/layout-tree.ts` primitives rather than duplicate them.

- **GIVEN** `h(tty,code,web)` with equal sizes
- **WHEN** tty is dropped on code's top edge
- **THEN** the result is `h(v(tty,code),web)` with the outer split at 0.5/0.5 (tty's third redistributed) and the inner at 0.5/0.5
- **GIVEN** `h(tty,code)`
- **WHEN** tty is dropped on the layout's bottom edge
- **THEN** the result is `v(code,tty)` at 0.5/0.5
- **GIVEN** `h(tty,code)`
- **WHEN** tty is dropped on code's left edge
- **THEN** the result is `noop`

#### R3: Resolver invariants
For every canonical tree with N ≤ 4 leaves, every dragged leaf, every target leaf ≠ dragged, and every zone (center + four sides) plus the four root sides, a `move` result SHALL be canonical (`isCanonicalTree(tree, 4)`), keep the leaf multiset, keep N, and carry sizes whose arrays match each split's child count and sum to 1 (±1e-6); a center drop SHALL be an involution (applying it twice restores the tree and sizes).

- **GIVEN** the exhaustive enumeration of N = 2, 3, 4 trees
- **WHEN** every drop is resolved
- **THEN** every invariant holds

### Layout: Header drag gesture (`components/surface-layout.tsx`)

#### R4: Drag start and threshold
A primary-button `pointerdown` on a tile header's background (not on a button, pane segment, code verb, meta chip or menu) SHALL arm a drag; the drag SHALL start only after the pointer moves ≥ `DRAG_THRESHOLD_PX`. Below the threshold the press SHALL behave as today (the tile focuses). On start the component SHALL capture the pointer (`setPointerCapture`), snapshot the leaf rects, the layout box and the effective sizes, and route move/up/cancel through window-level listeners gated on the captured `pointerId` (the divider drag's pattern) plus a window capture `keydown` listener.

- **GIVEN** a 2-tile desktop layout
- **WHEN** the user presses the code header and moves 2 px, then releases
- **THEN** no drag overlay appears, no layout is applied, and the code tile is focused
- **WHEN** the user presses and moves 20 px
- **THEN** the drag overlay appears

#### R5: Result preview overlay
During a drag an overlay above the tiles SHALL render, per the cached resolution of the current hit (cached per hit kind + target + side):
- `move`: every leaf rect of the result tree at its result sizes, labelled with `SURFACE_GLYPH` + `SURFACE_LABEL`; the dragged tile's destination filled accent-green, the others outlined.
- `noop`: a neutral "no change" region (center = target rect; edge = that half of the target; root = that third of the layout).
- `too-small`: a red "too small" region over the same zone region.
- `cancel`: nothing.
The dragged tile SHALL be visually dimmed for the drag's duration; the header SHALL show `cursor: grab` when a drag can start and `cursor: grabbing` during one.

- **GIVEN** a drag of tty over code's center in `h(tty,code)`
- **THEN** the overlay shows the swapped result with tty's destination (the right rect) highlighted

#### R6: Commit and cancel
On `pointerup` with a cached `move` result the component SHALL write the viewer's sizes under `structureSig(result.tree)` via `writeStoredSizes`, THEN call the new `onApplyLayout(result.tree)` prop exactly once, and focus the dragged tile at its new position. `app.tsx` SHALL wire `onApplyLayout` to its existing `applyLayout` (one `@rk_win_layout` POST, optimistic `pendingLayout`, no URL change). The drag SHALL cancel with no layout call and no sizes write on: Escape (default prevented, propagation stopped), release on a `cancel`/`noop`/`too-small` result, `pointercancel`, unmount or window switch, and a `layout` prop change mid-drag.

- **GIVEN** a drag of tty onto code's center in `h(tty,code)`
- **WHEN** the pointer is released
- **THEN** `onApplyLayout` is called once with `h(code,tty)` and sizes are stored for signature `h(0,1)`
- **GIVEN** a drag in progress over a valid zone
- **WHEN** Escape is pressed
- **THEN** the overlay disappears and `onApplyLayout` is never called

#### R7: Disabled contexts
No drag SHALL arm on a coarse pointer (`useCoarsePointer()`), while a tile is zoomed, on a single-leaf layout, or in the mobile branch.

- **GIVEN** a zoomed 2-tile layout
- **WHEN** the user drags the visible header 40 px
- **THEN** no overlay appears and nothing is applied

#### R8: Native web guest posture
`TileDragContext` SHALL carry a posture `"idle" | "resize" | "move"` instead of a boolean. Divider and intersection drags SHALL publish `resize` (the native engine keeps today's per-frame live resize); a header drag SHALL publish `move`, and `components/web-frame-native.tsx` SHALL hide the guest (`wantVisible` false) while the posture is `move`, re-measuring and re-showing when it returns to `idle`. Tile content SHALL be `pointer-events-none` during either posture.

- **GIVEN** a native web tile
- **WHEN** a header drag starts
- **THEN** the shell guest is set invisible, and it is shown again after the drag ends

### Layout: Header verb cluster

#### R9: Promote/Swap retire from the header
The tile header SHALL no longer render the Promote and Swap buttons; Zoom (Expand/Restore) and ✕ Close SHALL remain, with the hairline before ✕. The `onPromote` / `onSwap` props SHALL be removed from `SurfaceLayoutProps` and `app.tsx`; `swapWithNext` (lib + tests) and the unused `PromoteGlyph` / `SwapGlyph` exports SHALL be removed. Palette entries (`Layout: Promote <Surface>`, `Tile: Swap <Dir>`, templates, cycle) SHALL be unchanged.

- **GIVEN** a 3-tile layout
- **WHEN** the tile headers render
- **THEN** no `Promote …` or `Swap …` button exists, `Expand …` and `Close …` do, and the palette still lists `Layout: Promote Code` and `Tile: Swap …` rows

### Docs: Spec

#### R10: surface-layout.md § Verbs describes drag
`docs/specs/surface-layout.md` SHALL describe drag as the mouse path (center swap, tile-edge split, layout-edge span at 50 %, result preview, 150 × 100 floor for drops, Escape cancels, one write), state that Promote/Swap are palette verbs and the header swap-with-next is gone, keep the "≤2 actions without drag-drop" guarantee as a palette guarantee, turn the "Future drag-drop is sugar" paragraph into present tense, and update the Phasing row and Constitution Mapping V line.

- **GIVEN** the spec after this change
- **WHEN** a reader looks up the Swap verb
- **THEN** it names the palette directional swap only and points to drag for mouse moves

### Non-Goals

- Size-floor gating of adds and templates, lifting `MAX_TILES = 3` — change 4.
- Borrowing surfaces from other tabs (sidebar-row drag) — change 4, reuses this resolver.
- External drags (top-bar toggle into the layout) and tear-off — later follow-ups.
- A pointer-following ghost chip and a grip glyph — optional polish, not built.
- Backend/`internal/layoutspec` changes — the drop writes an ordinary canonical tree.

### Design Decisions

#### Pointer capture, not HTML5 drag-and-drop
**Decision**: The header drag uses pointer events with `setPointerCapture` and window-level move/up listeners gated on the pointer id.
**Why**: Moves keep arriving over iframes (HTML5 DnD does not deliver them), engines can drop element capture over iframe content, and Playwright drives `page.mouse` reliably.
**Rejected**: HTML5 drag-and-drop — iframe dead zones and unreliable Playwright simulation.
*Introduced by*: 260925-c1ql-surface-drag-snap

#### The overlay previews the result
**Decision**: The drag overlay draws the whole resolved tree at the viewer's sizes, not a half-tile highlight.
**Why**: A drop can merge into a parent split or collapse the dragged tile's old parent, reshaping siblings; only the result is honest.
**Rejected**: VS-Code-style half-tile highlight — lies whenever siblings reshape.
*Introduced by*: 260925-c1ql-surface-drag-snap

#### Tile moves hide the native guest; sash drags live-resize it
**Decision**: `TileDragContext` is a posture; `move` hides the native `WebContentsView`, `resize` keeps per-frame bounds.
**Why**: The guest is composited above the DOM, so the overlay cannot paint over it during a move; a sash drag has no overlay and benefits from live bounds.
**Rejected**: One boolean for both — either the overlay is occluded or the sash drag loses live resize.
*Introduced by*: 260925-c1ql-surface-drag-snap

### Deprecated Requirements

#### Header ⇄ swap-with-next
**Reason**: Drag replaces header rearrangement; swap-with-next's reading-order target was hard to predict.
**Migration**: Mouse users drag the header; keyboard users use `Tile: Swap Left|Right|Up|Down`.

#### Header ◧ Promote button
**Reason**: Drag covers it (center-drop on slot A).
**Migration**: Palette `Layout: Promote <Surface>`.

## Tasks

### Phase 1: Setup

- [x] T001 Export the internals `layout-drop.ts` needs from `app/frontend/src/lib/layout-tree.ts` (e.g. `getAt`, `setAt`, a sizes-attach/extract helper for pre-order `LayoutSizes` ↔ explicit `sizes` on splits) without changing existing behavior; keep existing tests green <!-- R2 -->
- [x] T002 Convert `app/frontend/src/lib/tile-drag-context.ts` to a `TileDragPosture = "idle" | "resize" | "move"` context (default `idle`), update `useTileDragging` callers (`components/web-frame-native.tsx`, `components/surface-layout.tsx` providers, the existing tests in `surface-layout.test.tsx` / `web-frame-native.test.tsx`) so today's divider/intersection drags publish `resize` with unchanged behavior <!-- R8 -->

### Phase 2: Core Implementation

- [x] T003 Create `app/frontend/src/lib/layout-drop.ts`: constants, `edgeBand`, `zoneAt`, `rootZoneAt`, `hitTest`, `DropHit`/`DropResult` types, `resolveDrop` (wrap → remove → normalise → rename, sizes carried, noop + too-small detection) reusing `layout-tree.ts` primitives <!-- R1 --> <!-- R2 -->
- [x] T004 Create `app/frontend/src/lib/layout-drop.test.ts`: band clamps, `zoneAt` center/sides/corner tie-break, `rootZoneAt` + precedence, `hitTest` self/outside/gutter, the R2 scenarios (study §7 example, root 50 %, noop), sizes-through-drop rows (study §6), too-small on a small box, and the exhaustive N ≤ 4 invariants + center involution (enumerate trees in the test or reuse `layout-tree.fixtures.json` where it fits) <!-- R1 --> <!-- R2 --> <!-- R3 -->
- [x] T005 In `app/frontend/src/components/web-frame-native.tsx`, hide the guest while the posture is `move` (`wantVisible` false), keep the rAF live-resize loop for `resize`, and re-measure on return to `idle`; add a `web-frame-native.test.tsx` case for `move` hiding and `resize` staying visible <!-- R8 -->
- [x] T006 In `app/frontend/src/components/surface-layout.tsx`, add the header drag: arm on background `pointerdown` (exclude interactive children), 4 px threshold, pointer capture, rect/box/sizes snapshot, window-level move/up/cancel gated by pointer id, window capture Escape, per-hit resolution cache, `TileDragContext` = `move` + tile content `pointer-events-none` while dragging, dragged-tile dimming, `cursor-grab`/`cursor-grabbing`; keep functions focused (extract a hook or helpers if the drag logic grows past the file's typical size) <!-- R4 --> <!-- R7 --> <!-- R8 -->
- [x] T007 In `app/frontend/src/components/surface-layout.tsx`, render the result-preview overlay (move / noop / too-small / nothing) from the cached resolution, positioned in the layout container's coordinate space <!-- R5 -->
- [x] T008 In `app/frontend/src/components/surface-layout.tsx` + `app/frontend/src/app.tsx`, add the `onApplyLayout(next: Layout)` prop wired to `applyLayout`; on a `move` release write sizes under the new signature then call `onApplyLayout` once and focus the dragged tile; implement every cancel path (Escape, cancel/noop/too-small release, `pointercancel`, unmount/window switch, mid-drag `layout` change) <!-- R6 -->
- [x] T009 Retire the header Promote/Swap buttons in `components/surface-layout.tsx`; remove `onPromote`/`onSwap` props and their `app.tsx` wiring; remove `swapWithNext` from `lib/surface-layout.ts` and its tests in `lib/surface-layout.test.ts`; remove `PromoteGlyph`/`SwapGlyph` from `components/top-bar-icons.tsx`; update the component's header doc comment <!-- R9 -->

### Phase 3: Integration & Edge Cases

- [x] T010 Add RTL cases to `app/frontend/src/components/surface-layout.test.tsx` (mocked rects): below-threshold press focuses without dragging; past threshold shows the overlay; release on a center zone commits one `onApplyLayout` + one sizes write under the new signature; Escape / release outside / release over self / noop release cancel with no call; no drag on coarse pointer, zoom, single leaf; header has no `Promote …`/`Swap …` buttons; divider drag still publishes `resize` <!-- R4 --> <!-- R5 --> <!-- R6 --> <!-- R7 --> <!-- R9 -->
- [x] T011 Update `app/frontend/tests/e2e/surface-layout.spec.ts`: rewrite the "promote/swap/close verbs" test for palette promote/swap + header close, fix the pane-segment test's `Promote Terminal` assertion, and add `page.mouse` drag tests (center swap, tile-edge split, layout-edge span, Escape cancel) asserting `@rk_win_layout` via the options read and an unchanged URL; every touched `test()` carries Proves:/Steps: JSDoc and the file header covers any new setup <!-- R4 --> <!-- R6 --> <!-- R9 -->

- [x] T014 Add header-drag RTL cancel cases to `app/frontend/src/components/surface-layout.test.tsx`: `pointercancel` on window mid-drag, unmount / window switch (`windowId` rerender) mid-drag, and release on a `too-small` result (small mocked box) — each asserts no `onApplyLayout` call, no sizes write, overlay gone, posture back to `idle`. Also route the per-window reset's tile-drag teardown (`surface-layout.tsx` ~2108–2112) through the normal end path so pointer capture is released uniformly <!-- R6 --> <!-- rework: review cycle 1 — A-014 cancel paths untested -->
- [x] T015 Fix the corner tie-break comment in `app/frontend/src/lib/layout-drop.test.ts` (~84–85) so its point and arithmetic match the assertion; add a focused regression test for the `app.tsx` focus-mirror window-key stamping (a window switch where the child's fresh focus report must survive — e.g. palette `Tile: Swap …` rows target the reported focused leaf after a switch) in the most local existing test file that can mount it <!-- R6 --> <!-- rework: review cycle 1 — should-fix -->

### Phase 4: Polish

- [x] T012 Update `docs/specs/surface-layout.md` § Verbs, the drag-drop sugar paragraph, the Phasing row and the Constitution Mapping V line per R10 <!-- R10 -->
- [x] T013 Run the gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; `just test-e2e surface-layout.spec`; `just test-e2e operator-compose.spec`; regression `just test-e2e right-panel.spec`, `just test-e2e code-surface.spec`, `just test-e2e web-view-lens.spec`; fix failures <!-- R9 -->

## Execution Order

- T001 blocks T003; T002 blocks T005 and T006
- T003 blocks T004, T006, T007, T008
- T006 blocks T007 and T008; T009 can run after T006 (same file — sequential)
- T010, T011 follow T006–T009; T013 is last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `layout-drop.ts` exports the seven named constants and `edgeBand`, `zoneAt`, `rootZoneAt`, `hitTest` with the specified geometry
- [x] A-002 R2: `resolveDrop` implements wrap → remove → normalise → rename with sizes carried and returns `move` / `noop` / `too-small` / `cancel`
- [x] A-003 R4: A header background press past 4 px starts a pointer-captured drag; below it the tile only focuses
- [x] A-004 R5: The overlay previews the whole result tree (move), a neutral region (noop), a red region (too-small)
- [x] A-005 R6: A committed drop writes sizes under the new signature and calls `onApplyLayout` exactly once → one `@rk_win_layout` write through `applyLayout`
- [x] A-006 R8: `TileDragContext` is a three-state posture; the native guest hides on `move` and live-resizes on `resize`
- [x] A-007 R9: Header Promote/Swap buttons, `onPromote`/`onSwap` props, `swapWithNext`, `PromoteGlyph`/`SwapGlyph` are gone; palette entries unchanged
- [x] A-008 R10: `docs/specs/surface-layout.md` describes drag as the mouse path and Promote/Swap as palette verbs

### Behavioral Correctness

- [x] A-009 R9: Zoom and Close remain on the header; the tty pane segment and code verbs are unaffected
- [x] A-010 R8: Divider and intersection drags behave exactly as before (live resize, pointer-events-none on tiles)

### Removal Verification

- [x] A-011 R9: No reference to `swapWithNext`, `onPromote`, `onSwap`, `PromoteGlyph`, `SwapGlyph` remains in `app/frontend/src` or tests

### Scenario Coverage

- [x] A-012 R2: Vitest covers the study §7 example, a root 50 % drop, a noop, sizes through a drop and too-small
- [x] A-013 R3: Vitest checks canonical / multiset / N / sizes-shape invariants and center involution exhaustively for N ≤ 4
- [x] A-014 R6: RTL covers commit and every cancel path listed in R6 — commit, Escape, cancel (outside/self), noop, mid-drag `layout` change, `pointercancel`, unmount, window switch, and release on a `too-small` result (`surface-layout.test.tsx` header-drag block, T014)
- [x] A-015 R6: e2e covers center swap, tile-edge split, layout-edge span and Escape cancel via `page.mouse`, asserting the option and an unchanged URL

### Edge Cases & Error Handling

- [x] A-016 R7: No drag arms on a coarse pointer, while zoomed, on a single-leaf layout, or on mobile (RTL covers the first three; mobile is structural — the mobile branch renders no header drag handler and `canDragTiles` gates on `isMobile`)
- [x] A-017 R6: A `layout` prop change or unmount mid-drag cancels cleanly (listeners removed, capture released, posture back to `idle`) — the layout-change path is RTL-covered; unmount teardown is the armed-effect cleanup plus the per-window reset, verified by reading
- [x] A-018 R4: Presses on header buttons, the pane segment, code verbs, the meta chip or menus never arm a drag (one `closest("button, [role='menu'], [data-no-tile-drag]")` guard; RTL covers a header button)
- [x] A-019 R6: Escape during a drag does not reach the terminal (propagation stopped)

### Code Quality

- [x] A-020 Pattern consistency: New code follows the naming and structure of `layout-tree.ts` and the divider-drag handlers
- [x] A-021 No unnecessary duplication: `layout-drop.ts` reuses `layout-tree.ts` primitives (`pathOf`, `removeLeaf`, `normalise`, `swapLeaves`, `layoutRects`, `structureSig`)
- [x] A-022 Readability: drag logic in `surface-layout.tsx` is split into focused functions/hook (no god function > 50 lines without reason)
- [x] A-023 Type narrowing over assertions: `DropHit`/`DropResult` are discriminated unions consumed with narrowing, no `as` casts
- [x] A-024 No magic numbers: every threshold/band/floor is a named constant
- [x] A-025 Tests included: Vitest, RTL and e2e cover the added behavior; every touched Playwright `test()` has a Proves:/Steps: JSDoc
- [x] A-026 Comments state constraints only — no narration, no change IDs or PR numbers

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None unremoved — the code this change made redundant (`swapWithNext` in `lib/surface-layout.ts`, `PromoteGlyph`/`SwapGlyph` in `components/top-bar-icons.tsx`, the `HIDE_WHILE_DRAGGING` knob in `components/web-frame-native.tsx`) was deleted in the same diff; no further dead code discovered. `pathOfNode`/`leafIndexAtPath` in `lib/layout-drop.ts` are identity-based companions to the id-based `pathOf` (a kind-derived id is ambiguous mid-edit), not duplicates.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `hitTest` returns `null` (cancel) for a point in a gutter between tiles | The study mock's `hit` falls through to null there; gutters are 6 px | S:60 R:90 A:80 D:75 |
| 2 | Confident | `noop` compares the serialized tree only; a size-only difference is still `noop` | Study's `paint` compares `sig` only; rebalancing on a same-arrangement drop would surprise the user | S:65 R:90 A:80 D:70 |
| 3 | Confident | Placeholder is an internal sentinel never escaping `resolveDrop` | `SurfaceKind` has no free value; sentinel is implementation detail | S:70 R:95 A:85 D:80 |
| 4 | Confident | RTL covers commit/cancel with mocked `getBoundingClientRect`; jsdom has no layout | Existing divider tests mock rects the same way | S:70 R:90 A:85 D:80 |

4 assumptions (0 certain, 4 confident, 0 tentative).
