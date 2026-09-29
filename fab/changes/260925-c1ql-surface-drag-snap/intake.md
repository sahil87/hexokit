# Intake: Surface Drag to Snap

**Change**: 260925-c1ql-surface-drag-snap
**Created**: 2026-09-25

## Origin

> Tiles move by dragging their header: a pointer-captured drag offers center (swap), tile-edge (split beside) and layout-edge (span a side) zones, previews the resulting tree at the viewer's sizes, and commits one @rk_win_layout write on release; Escape cancels. Promote/Swap leave the header and stay in the palette. Full spec, task breakdown, standing context (frontend/backend/desktop files, reference implementation, tests, constitution mapping, verification commands) and decisions of record are in fab/plans/sahil/26-09-24-surface-drag-and-popout.md — read the whole file, then use its "Change 2 — drag to snap" section plus "Standing context" and "Decisions of record" sections as authoritative intake input. Change 1 (layout tree model) already merged to main, so this branch already has that foundation.

One-shot `/fab-new` invocation. Change 2 of the 1 study + 6 changes plan `fab/plans/sahil/26-09-24-surface-drag-and-popout.md` (sequence study → 1 → 2 → …). The contract of record is the design study `docs/wiki/surface-drop-zone-studies.html` (§3 resolver, §5 zones + size floor, §6 sizes through a drop, §7 feedback, §11 implementation notes, §12 decisions D2/D3/D5/D6/D8). Change 1 (`260925-ww92-surface-layout-tree`, PR #1035, `4175ac2e`) shipped the canonical split tree, `lib/layout-tree.ts`, the flat rect-positioned renderer and per-signature viewer sizes — this branch is cut from that commit.

One question asked at intake: plan open question 3 (root-edge drop share). **User chose the generic 50 % wrap** over 1/N.

## Why

1. **The pain**: rearranging tiles today means reaching for per-tile Promote (◧, swap with slot A) and Swap (⇄, swap with the next leaf in reading order, wrapping) buttons in every tile header, or the palette. These verbs only permute leaves across the positions a template already has; they cannot move a tile to a different *place in the structure* (e.g. from the right column of `main-left` to spanning the bottom). Reaching a different structure means cycling templates (▦) and then permuting — several actions for what is one gesture in every tiling editor users know (VS Code editor groups, tmux-style tilers).
2. **If we don't**: the header keeps two buttons whose effect is hard to predict (swap-with-next depends on reading order), and the model that change 1 built — a canonical tree that supports any arrangement — stays reachable only through templates. Change 4 (tiles from other tabs) needs the same drop resolver and overlay for its borrow gesture (dragging a sidebar row onto a tile zone), so the resolver is a prerequisite.
3. **Why this approach**: one generic drop edit (wrap target with a placeholder → remove the dragged leaf → normalise → rename) covers every outcome at any N with a pure, exhaustively testable function; tile-edge + layout-edge zones reach every single-tile move in one drop (max N − 1 drops between any two layouts); pointer capture keeps events arriving over iframes where HTML5 drag-and-drop does not (and its Playwright simulation is unreliable); previewing the *result* is honest where a VS-Code-style half-tile highlight lies whenever a drop reshapes siblings (study §7). Rejected alternatives are in the plan's Decisions of record: nested ancestor strips (+0.6 % outcomes at N = 4, reachability unchanged), half-tile-only feedback, HTML5 DnD.

## What Changes

### 1. `app/frontend/src/lib/layout-drop.ts` (new, pure — no DOM)

Port the study's executable spec (`docs/wiki/surface-drop-zone-studies.html` inline script: `dropEdge`, `swapLeaves`, `hit`, `band`, `resolveHit`) onto change 1's typed tree in `lib/layout-tree.ts` (reuse its `LayoutNode`, `LayoutSplit`, `Rect`, `LayoutSizes`, `DropSide`, `pathOf`, `removeLeaf`, `normalise`, `swapLeaves`, `layoutRects`, `structureSig`, `leafIds`, `SPLIT_GAP_PX` — do not duplicate them; add small exports to `layout-tree.ts` if a needed internal such as `getAt`/`setAt`/`normSized` is private).

Named constants (study values, verbatim):

```ts
export const DRAG_THRESHOLD_PX = 4;      // movement before a header press becomes a drag
export const ROOT_EDGE_PX = 18;          // layout-edge band, outer 18 px of the layout box
export const EDGE_BAND_FRACTION = 0.25;  // tile-edge band = clamp(25 % of that axis, 28, 110) px
export const EDGE_BAND_MIN_PX = 28;
export const EDGE_BAND_MAX_PX = 110;
export const MIN_TILE_W = 150;           // size floor, px, in THIS viewer's viewport
export const MIN_TILE_H = 100;
```

Functions:

- `edgeBand(dim: number): number` — `Math.min(110, Math.max(28, dim * 0.25))`.
- `rootZoneAt(box: Rect, point: {x, y}): DropSide | null` — the side whose distance from the layout box edge is `< ROOT_EDGE_PX`; when two sides qualify (a corner) the nearest wins. Layout-edge bands **win over** tile bands; there are always four at any N.
- `zoneAt(rect: Rect, point): "center" | DropSide` — inside a tile: each side's band is `edgeBand(rect.w)` (left/right) or `edgeBand(rect.h)` (top/bottom); a point inside no band is `center`; a corner (inside two bands) goes to the side the pointer is **deepest into**, i.e. the smallest `distance / band` ratio. Trees have no diagonal splits.
- `hitTest(tree, rects: Map<leafId, Rect>, box: Rect, point, draggedId): DropHit | null` where `DropHit = { kind: "root", side } | { kind: "center", targetId } | { kind: "edge", targetId, side } | { kind: "self" }` — `null` outside the layout box; `self` over the dragged tile's own rect (no zone; release cancels).
- `resolveDrop(tree, sizes: LayoutSizes | undefined, draggedId, hit, box): DropResult` where

  ```ts
  type DropResult =
    | { kind: "move"; tree: LayoutNode; sizes: LayoutSizes }  // canonical tree + pre-order sizes for its signature
    | { kind: "noop" }        // result ≡ current tree (same serialized form AND same sizes)
    | { kind: "too-small" }   // some leaf of layoutRects(result, box, sizes) < MIN_TILE_W × MIN_TILE_H
    | { kind: "cancel" };     // hit is null or self
  ```

  Algorithm (study §3, verbatim semantics):

  ```
  if hit.kind = center:  out ← swapLeaves(tree, dragged, target)     // sizes stay with POSITIONS
  else:                                                              // edge: target = pathOf(target leaf); root: target = []
      d    ← side ∈ {left,right} ? h : v
      wrap ← split(d, side ∈ {left,top} ? [X, node(target)] : [node(target), X])   // X = placeholder, 50/50 inside the wrap
      out  ← replace(tree, targetPath, wrap)      // wrap takes the target's share in its parent
      out  ← removeLeaf(out, dragged)             // dragged's share redistributes to its siblings in proportion
      out  ← normalise(out)                       // merge same-direction (fractions multiply through), lift single children (child inherits share)
      out  ← rename(out, X → dragged kind)
  ```

  **Insert before remove** is load-bearing: removing first breaks when the removal collapses the target's parent. The resolver runs on the tree with the viewer's current effective sizes attached (stored `rk-layout-sizes:*` for the current signature, else `templateSizes`, else equal), so sizes carry through the drop per study §6; the returned `sizes` are the result tree's pre-order fractions. A **layout-edge (root) drop** is the same wrap at path `[]`, so the dragged tile takes **50 %** of that axis (user decision at intake — no 1/N special case). Leaves are identified by **leaf id** (`tty`, `tty#2`, … from `leafIds`), never by kind; a target is a node **path**.

  Invariants (unit-test targets): result is canonical (`isCanonicalTree`), keeps the leaf multiset, never changes N, center is an involution, sizes arrays match each split's child count and sum to 1 (1e-6).

The placeholder: the leaf type is `SurfaceKind`, so the resolver needs a sentinel the rename step replaces; any internal representation is fine as long as it never escapes `resolveDrop`.

### 2. `app/frontend/src/components/surface-layout.tsx` — the header drag

- **Start**: `pointerdown` (primary button, `e.button === 0`) on a tile header's **background** — not on its buttons, pane segment, code verbs, meta chip or menus — records the start point. Movement `< DRAG_THRESHOLD_PX` stays a click: the existing pointerdown-capture focus seam focuses the tile, nothing else. Past the threshold the drag starts: `setPointerCapture` on the header, snapshot the leaf rects (the component already computes them from `layoutRects` — the same map behind `layoutRectsRef`) and the layout box (`gridRef.getBoundingClientRect()`), and snapshot the effective sizes.
- **Mid-drag event routing**: follow the divider drag's hardening (`surface-layout.tsx` ~1540–1650): move/up/cancel on **window-level** listeners gated on the captured `pointerId` (engines can drop element capture over iframe content — the macOS Safari observation), plus a window `keydown` capture listener for Escape.
- **Mid-drag posture**: reuse the mid-drag flag so tile content goes `pointer-events-none` (iframes cannot swallow moves). The native web engine must **hide** its guest for a tile move (the `WebContentsView` is composited above the DOM, so the overlay could not paint over it), whereas divider drags keep today's live-resize. `TileDragContext` (`lib/tile-drag-context.ts`, currently `boolean` "sash drag in progress") therefore becomes a posture, e.g. `"idle" | "resize" | "move"`; `components/web-frame-native.tsx` live-resizes on `resize` (today's `HIDE_WHILE_DRAGGING = false` path, unchanged) and hides on `move` (`wantVisible` false), re-measuring and showing again when the posture returns to `idle`. The iframe web engine and code frames need only the `pointer-events-none` class.
- **Hit-testing**: pointer coords relative to the snapshotted layout box → `hitTest` → `resolveDrop`, cached per `(hit kind, target id, side)` for the drag's duration (one resolver + one `layoutRects` pass per zone change, not per move).
- **Overlay (result preview, study §7)**: an absolutely positioned layer above the tiles inside the layout container:
  - `move`: draw every leaf rect of the **result** tree at the result sizes, labelled with the kind glyph (`SURFACE_GLYPH`) + `SURFACE_LABEL`; the dragged tile's destination is filled accent-green, the others outlined.
  - `noop`: a neutral "no change" highlight over the hovered zone's region (center = the target rect; an edge = that half of the target; a root edge = that third of the layout); never writes.
  - `too-small`: a red "too small" highlight over the hovered zone's region; not offered, never writes.
  - `cancel` (outside / over self): no overlay.
  - The dragged tile is visually marked (dimmed) for the drag's duration. A small ghost chip (glyph + label) following the pointer is optional polish.
- **Commit on release** (`pointerup`) when the cached result is `move`: first `writeStoredSizes(server, windowId, structureSig(result.tree), result.sizes)` (so the first render under the new signature reads them), then call a new parent callback `onApplyLayout(result.tree)` → `app.tsx`'s existing `applyLayout` (the ONE layout mutation path: serialize the tree, optimistic `pendingLayout`, one `POST` of `@rk_win_layout` through `setWindowOptions`, toast + revert on rejection). Exactly one `@rk_win_layout` write per drop; never a URL change. Focus moves to the dragged tile at its new position.
- **Cancel** (no write, no sizes write): Escape (`preventDefault` + `stopPropagation` so the terminal never sees it), release outside the layout, release over the dragged tile itself, release on `noop`/`too-small`, `pointercancel`, component unmount / window switch, or the `layout` prop changing mid-drag (another viewer's write made the snapshot stale).
- **Disabled** (no drag starts, header behaves as today): coarse pointer (`useCoarsePointer()` true), a zoomed render, a single-leaf layout, and the mobile branch (which renders one tile).
- **Affordance**: header background shows `cursor: grab` when a drag can start and `grabbing` during one. No new grip glyph.

### 3. Retire header Promote/Swap; palette stays

- Remove the ◧ Promote and ⇄ Swap buttons from the tile header verb cluster (`surface-layout.tsx` ~2640–2665). Zoom (Expand/Restore) and ✕ Close stay on the header, with the hairline before ✕.
- Remove the now-unused `onPromote` / `onSwap` props from `SurfaceLayoutProps` and their `app.tsx` wiring (~5829–5836), and remove `swapWithNext` from `lib/surface-layout.ts` (+ its tests) — its only caller was the header ⇄ button. `promote` stays (palette `Layout: Promote <Surface>`); `swapDirectional` stays (palette `Tile: Swap Left|Right|Up|Down`). Drop `PromoteGlyph`/`SwapGlyph` imports from `surface-layout.tsx`; keep or delete the glyph exports in `top-bar-icons.tsx` per whether anything else uses them.
- Palette entries are **unchanged** (`lib/palette/layout.ts`: `Layout: Promote <Surface>`, `Tile: Swap <Dir>`, `Layout: <Template>`, `Layout: Cycle Template`), so the `operator-compose.spec` exact palette count does not move — verify it anyway.
- Constitution V: every drag outcome has a keyboard route. At N ≤ 3 (the cap `MAX_TILES = 3` stays in this change) every structure is one of the templates (verified by enumeration in change 1), and leaf placement within a structure is reachable via `Layout: Promote` + `Tile: Swap <Dir>`, so the spec's "every arrangement reachable in ≤2 actions without drag-drop" guarantee now rides the palette.

### 4. Size floor for drops

The study's per-viewport floor (150 × 100 px) gates **drops** here (`too-small`). `MAX_TILES = 3` and the add/template paths are unchanged; change 4 extends the floor to adds and templates and lifts the cap.

### 5. Tests

- **Vitest** `lib/layout-drop.test.ts`: `edgeBand` clamps (28/110 bounds, 25 % middle); `zoneAt` bands, center, corner deepest-edge tie-breaking; `rootZoneAt` 18 px + precedence over tile bands; `hitTest` self/outside; `resolveDrop` invariants **exhaustive for N ≤ 4** over every tree × dragged leaf × target × zone (reuse change 1's enumeration fixture `lib/layout-tree.fixtures.json` where it fits: 4 / 36 / 528 placements for N = 2/3/4), including the study §7 example (`h(tty,code,web)`, drag tty onto code's top edge), center involution, a root-edge 50 % share, sizes carried through (§6 table rows), `noop` detection, and `too-small` for a small box.
- **RTL** `components/surface-layout.test.tsx` with mocked rects: below-threshold press focuses and does not drag; past threshold shows the overlay; release commits one `onApplyLayout` call + one sizes write under the new signature; Escape / release outside / over self / noop cancel with no call; disabled on coarse pointer, zoom, single leaf; header no longer renders `Promote …`/`Swap …` buttons.
- **Native engine** unit test: posture `move` hides the guest, `resize` keeps it visible with live bounds.
- **e2e** `tests/e2e/surface-layout.spec.ts` via `page.mouse` (down → move in steps past 4 px → up) on a 3-tile layout: center swap, tile-edge split, layout-edge span, Escape cancel (option unchanged); assert `@rk_win_layout` via the options read the spec already uses, never the URL. Rewrite the existing `promote/swap/close verbs` test (~line 295) and the pane-segment test's `Promote Terminal` assertion (~line 463–512) for the retired buttons (palette promote/swap + header close). Every touched `test()` carries its **Proves:/Steps:** JSDoc (Constitution Test Intent Comments). Also run `operator-compose.spec` (palette count) and `right-panel.spec` / `code-surface.spec` / `web-view-lens.spec` as regression; `control-gallery.spec` only if Control classes change.

### 6. Specs and memory

- `docs/specs/surface-layout.md` § Verbs: drag is the mouse path (center swap · tile-edge split · layout-edge span, result preview, Escape cancels, one write); header ⇄ swap-with-next retired; Promote/Swap are palette verbs; the "≤2 actions without drag-drop" guarantee rides the palette; the "Future drag-drop is sugar" paragraph becomes present tense; Phasing row 4's "drag-drop sugar" is done; Constitution Mapping V line.
- `docs/memory/run-kit/ui/lenses-and-layout.md` (hydrate): § Tile renderer (header drag, overlay, cancel rules, disabled contexts, retired buttons), § ▦ Layout chip + palette, § e2e; new Design Decisions *Pointer capture, not HTML5 DnD* and *The overlay previews the result*; amend *Live resize, not hide, during sash drags* and *The drag flag crosses to the engine as a context, not an engine prop* for the resize/move posture; amend *Two verb families on tile headers* for the smaller layout-verb cluster.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) Surface Layout § Tile renderer / § palette / § e2e for header drag-to-snap, overlay, cancel + disabled rules, retired Promote/Swap buttons; Design Decisions *Pointer capture, not HTML5 DnD*, *The overlay previews the result*; amended drag-posture decisions (sash = live resize, tile move = native guest hides)

## Impact

- **Frontend** (all changes are frontend): new `app/frontend/src/lib/layout-drop.ts` (+ test); `components/surface-layout.tsx` (header drag, overlay, verb-cluster trim, props); `app.tsx` (new `onApplyLayout` wiring, remove `onPromote`/`onSwap`); `lib/surface-layout.ts` (remove `swapWithNext`) + test; `lib/tile-drag-context.ts` (boolean → posture) and `components/web-frame-native.tsx` (hide on move); possibly `lib/layout-tree.ts` (export internals) and `components/top-bar-icons.tsx` (dead glyphs).
- **Backend / desktop**: none. `@rk_win_layout` grammar and `internal/layoutspec` are unchanged — a drop writes an ordinary canonical tree through the existing `/options` seam.
- **Tests**: Vitest + RTL + e2e as above. Verification: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest); `just test-e2e surface-layout.spec`, `just test-e2e operator-compose.spec`, and the regression specs (single specs, `<name>.spec` form).
- **Docs**: `docs/specs/surface-layout.md` § Verbs (apply); memory at hydrate.

## Open Questions

- None blocking. Change 4 extends the size floor to adds/templates and adds the sidebar-row borrow drag through the same resolver + overlay; external drags (top-bar toggle into the layout) and tear-off are later follow-ups (study §12 Open).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Pointer events + `setPointerCapture` on the header, not HTML5 drag-and-drop; mid-drag routing on window listeners gated by pointerId (the divider drag's hardening) | Plan decision of record + study §11 D6; divider code shows the window-listener pattern | S:95 R:75 A:90 D:95 |
| 2 | Certain | One generic drop edit (wrap target with placeholder → remove dragged → normalise → rename); center swaps; targets are node paths, leaves are ids | Plan decision of record + study §3 executable spec | S:95 R:70 A:95 D:95 |
| 3 | Certain | Zones: tile-edge bands clamp(25 %, 28, 110) px with deepest-edge corners; layout-edge bands outer 18 px winning over tile bands; nested ancestor strips rejected | Plan decision + study §5/§8 values | S:95 R:80 A:95 D:95 |
| 4 | Certain | Root (layout-edge) drop uses the generic 50 % wrap, no 1/N special case | Asked — user chose 50 % generic (plan open question 3) | S:95 R:85 A:95 D:95 |
| 5 | Certain | Overlay previews the whole result tree at the viewer's sizes, destination filled green; noop shows neutral, too-small shows red and is not offered | Plan decision "Feedback previews the result" + study §5/§7 | S:90 R:85 A:90 D:90 |
| 6 | Certain | Commit = one `@rk_win_layout` write through `app.tsx` `applyLayout` + the viewer's sizes written under the new structure signature; sizes carried through the drop per study §6 | Plan item 2 + decision "Sizes stay per viewer"; `applyLayout` is the one mutation path | S:90 R:80 A:95 D:90 |
| 7 | Certain | Header Promote/Swap buttons retire; palette `Layout: Promote <Surface>` and `Tile: Swap <Dir>` stay; Zoom and Close stay on the header | Plan decision of record + D8 | S:95 R:85 A:95 D:95 |
| 8 | Certain | Drag off on coarse pointers, zoomed renders, single-tile layouts (and the mobile branch) | Plan item 4 verbatim | S:95 R:85 A:90 D:95 |
| 9 | Certain | Drag threshold 4 px; below it a header press is a focus click | Study §5 threshold + existing focus seam | S:90 R:90 A:95 D:95 |
| 10 | Confident | Native web guest hides for a tile move while sash drags keep live resize: `TileDragContext` becomes a posture (`idle`/`resize`/`move`) | Plan decision "native web view hides for the drag's duration"; the shipped engine only live-resizes (`HIDE_WHILE_DRAGGING=false`), and the overlay cannot paint over a composited guest | S:75 R:80 A:80 D:70 |
| 11 | Confident | The 150 × 100 px size floor gates drops in this change (`too-small`); `MAX_TILES = 3` and add/template gating stay for change 4 | Study §3/§5 resolver returns too-small; plan puts adds/templates + cap lift in change 4 | S:70 R:85 A:75 D:70 |
| 12 | Certain | Remove `swapWithNext` and the `onPromote`/`onSwap` props (dead once the header buttons go); `promote` and `swapDirectional` stay | Only caller of `swapWithNext` is the header ⇄ wiring (grep); code-quality forbids dead code | S:70 R:85 A:85 D:80 |
| 13 | Confident | Cancel also on `pointercancel`, unmount/window switch, and a mid-drag `layout` prop change (stale snapshot from another viewer's write) | Mock cancels on pointercancel; the stale-snapshot rule follows from snapshotting rects at drag start | S:60 R:90 A:80 D:75 |
| 14 | Certain | Constitution V holds with no new palette rows: at N ≤ 3 every structure is a template and placement is reachable via Promote + directional Swap | Change 1 enumeration: N = 3 structures = the template set; cap stays 3 | S:75 R:80 A:85 D:80 |
| 15 | Certain | Focus moves to the dragged tile at its new position after a committed drop | Study mock sets focus to the dragged id on commit | S:60 R:95 A:80 D:80 |
| 16 | Certain | e2e covers swap, tile edge, layout edge, Escape cancel via `page.mouse`; existing promote/swap e2e rewritten for the palette | Plan item 5; e2e grep shows header `Promote`/`Swap` clicks in surface-layout.spec | S:85 R:85 A:85 D:85 |
| 17 | Confident | Affordance is `cursor: grab`/`grabbing` on the header background only — no new grip glyph | Study mock draws a ⠿ grip; plan is silent; cheap to add later | S:35 R:90 A:50 D:50 |
| 18 | Confident | Pointer-following ghost chip is optional polish, not required | Study mock has one; plan names only the result preview | S:35 R:95 A:55 D:55 |

18 assumptions (13 certain, 5 confident, 0 tentative, 0 unresolved).
