# Intake: Surface Layout Tree Model

**Change**: 260925-ww92-surface-layout-tree
**Created**: 2026-09-25

## Origin

> The terminal route's layout becomes a canonical split tree instead of one of eight presets: a new tree encoding in @rk_win_layout (old preset strings still parse), a recursive renderer with a divider between each pair of siblings, per-viewer sizes keyed by structure signature, templates in place of presets on the ▦ chip, and generic add/close/promote/swap. Tile count stays capped at three in this change. Full spec, task breakdown, standing context (frontend/backend files, reference implementation, tests, constitution mapping, verification commands) and decisions of record are in fab/plans/sahil/26-09-24-surface-drag-and-popout.md — read the whole file, then use its "Change 1 — layout tree model" section plus "Standing context" and "Decisions of record" sections as authoritative intake input.

Invoked as `/fab-new` (interactive). This is **Change 1 of 6** in the plan `fab/plans/sahil/26-09-24-surface-drag-and-popout.md`, drafted from the 2026-09-24/25 `/fab-discuss` sessions. The plan's "Change 1", "Standing context" and "Decisions of record" sections are authoritative input. The **contract of record** is the design study `docs/wiki/surface-drop-zone-studies.html`: §2 is the model and encoding, §3 the resolver, §6 sizes, §9 the generic verbs, §11 the implementation notes. The study's embedded `<script>` (the `tree core`, `templates` and `geometry` blocks, around lines 334–470) is the **executable reference implementation**.

The user answered two questions during intake:
1. **Add target**: *split the last leaf in reading order* along its longer axis, not the focused tile. Desktop uses that leaf's real rect. Mobile and Go use a nominal 16:10 box.
2. **Rollback**: writers *always emit the tree form*. There is no one-release preset-string fallback (plan open question 2 is closed).

## Why

1. **The problem.** A layout today is `(shape, order)`, where shape is one of eight hard-coded presets (`single`, `split-h`, `split-v`, `row`, `col`, `main-left`, `main-right`, `main-top`). Presets cover N ≤ 3 only, and even there they miss one structure (`main-bottom`). Arrangements of N tiles grow 2 → 6 → 22 → 90 → 394 for N = 2…6 (large Schröder numbers, study §1), so presets cannot be the model once later changes lift the tile count (change 4: tiles from other tabs, limited only by a size floor). Every later change (drag to snap, borrowed tiles, popout) needs one generic tree edit, `insert → remove → normalise`, and cannot be built on a preset table.
2. **If we don't.** Change 2 (drag) would need a hand-written outcome table per (shape, zone), and the table stops working at N = 4. Growing past three tiles would mean adding named presets one by one, and the study rejected that because it is correct only to N = 3.
3. **Why this approach.** A **canonical split tree** (≥2 children per split, directions alternating by depth) has exactly one encoding per arrangement. It generalises to any N and is still small enough to validate on both sides (TS and Go). Presets survive as **templates**, which are generators rather than the model, so `rk tab layout main-left` and the ▦ chip still work. This change lands the model at the current cap of 3, so behaviour stays recognisable and the risk stays low. The cap is lifted in change 4.

## What Changes

### 1. New pure module `app/frontend/src/lib/layout-tree.ts`

Port of the study's reference resolver, with types. It is pure and DOM-free and has colocated `layout-tree.test.ts`.

**Types**:

```ts
type SplitDir = "h" | "v";            // h = children side by side (left→right), v = stacked (top→bottom)
type LayoutLeaf = { leaf: SurfaceKind };                      // bare kind in this change
type LayoutSplit = { dir: SplitDir; children: LayoutNode[] };  // ≥ 2 children, canonical
type LayoutNode = LayoutLeaf | LayoutSplit;
type LayoutSizes = /* per-split fractions, see § Sizes */;
```

Leaves carry a surface **kind** only (`tty | code | web | gui`). The richer leaf grammar (`web/<n>`, `@N/<surface>[/<n>]`) belongs to change 4 and is NOT parsed here. The rest of the code identifies a leaf by a stable **leaf id**: the kind for a unique kind, and `tty`, `tty#2`, … for duplicate tty leaves by occurrence in reading order.

**Grammar** (the `@rk_win_layout` tree form, study §2):

```
node  = leaf | split
leaf  = "tty" | "code" | "web" | "gui"
split = dir "(" node "," node { "," node } ")"      dir ∈ h | v
```

No whitespace. Canonical form, which every writer produces and the parser requires:
- a split has ≥ 2 children
- a child split never has its parent's direction (depth alternates)
- total leaves 1…3 in this change (the cap stays, see § 6)
- non-tty kinds never repeat; duplicate `tty` leaves are legal (the muxed relay supports N clients per pane)

Examples:

| Tree form | Legacy preset |
|---|---|
| `tty` | `single:tty` |
| `h(tty,web)` | `split-h:tty,web` |
| `v(tty,web)` | `split-v:tty,web` |
| `h(tty,code,web)` | `row:tty,code,web` |
| `v(tty,code,web)` | `col:tty,code,web` |
| `h(tty,v(code,web))` | `main-left:tty,code,web` |
| `h(v(code,web),tty)` | `main-right:tty,code,web` |
| `v(tty,h(code,web))` | `main-top:tty,code,web` |
| `v(h(code,web),tty)` | *(none; the `main-bottom` template)* |

**Functions** (names from the plan):
- `parseLayoutTree(raw) → LayoutNode | null`. Accepts the tree grammar **and** the legacy `shape:a,b[,c]` grammar, permanently. Legacy strings go through today's `parseLayout` rules and convert exactly as in the table above, so the legacy parse is lossless for all eight presets. It returns `null` for anything malformed: unknown kind, a non-canonical tree, >3 leaves, or a repeated non-tty kind. Validation happens on the parse path with type guards, not `as` casts (code-quality: type narrowing over assertions).
- `serializeLayoutTree(node) → string`. Always emits the tree form (user decision: no preset-string fallback). `parse(serialize(t)) ≡ t` for every canonical tree.
- `normalise(node)`. Merges a same-direction child into its parent and lifts a single-child split to that child, carrying sizes per study §6. It is the study's `norm`.
- `removeLeaf(node, leafId)`. Removes a leaf and redistributes its share to its siblings in proportion to their sizes. It returns `null` when nothing remains.
- `insertBeside(node, targetPath, side, newLeaf)`. Wraps the target with a placeholder split (the placeholder and the target split 50/50, and the wrap takes the target's share), then normalises. This is the study's `dropEdge` generalised. It serves `add` in this change and drag drops in change 2.
- `swapLeaves(node, a, b)`. Sizes stay with positions and the leaves trade places. It is an involution.
- `layoutRects(node, box, sizes, gap = 6) → Map<leafId, Rect>` (study `layoutRects`; the 6 px gap matches today's `gap-[6px]` gutters).
- `structureSig(node)` is the shape with leaves replaced by reading-order indices, e.g. `h(0,v(1,2))`. It is the sizes storage key suffix.
- `TEMPLATES` and `templateOf(node)`. `row`, `col`, `main-left`, `main-right`, `main-top`, `main-bottom` and `grid` each build a tree for any N from a slot order (study `TEMPLATES`, main fraction `M = 0.58`). `templateOf` returns `{ name, slots }`: the first template in registry order whose structure matches, with the tiles in that template's slot order. It returns `single` at N = 1 and `custom` otherwise. `templatesFor(n)` lists the templates with distinct structures at N, deduplicated by structure in registry order:
  - N = 2 → `row`, `col`
  - N = 3 → `row`, `col`, `main-left`, `main-right`, `main-top`, `main-bottom` (`grid(3)` is structurally `main-bottom` and is dropped)

**Tests** (Vitest, exhaustive for N ≤ 4 even though the render cap is 3, because the model is N-generic): every canonical tree is kept canonical by every operation; the leaf multiset is kept; N is kept by swap and insert-then-remove; swap is an involution; `parse ∘ serialize` is the identity. The study's enumeration is the fixture: 4 / 36 / 528 placements for N = 2/3/4. The legacy parse is lossless for all eight presets. At N = 3 the closure equals the five presets plus `main-bottom`.

### 2. `app/frontend/src/lib/surface-layout.ts`: verbs delegate to the tree

`Layout` becomes the tree (`LayoutNode`). `LayoutShape`, `SHAPE_ARITY`, `SHAPE_RING`, `ALL_SHAPES`, `shapesForArity`, `COLLAPSE_SHAPE` and `GROWTH_SHAPE` retire or become template lookups. `SURFACE_LABEL` and `SURFACE_GLYPH` stay. `SHAPE_LABEL` becomes `TEMPLATE_LABEL` (`Row`, `Column`, `Main Left`, `Main Right`, `Main Top`, `Main Bottom`, `Grid`). At N = 2 the chip shows `Row`/`Column`; the retired "Split Horizontal/Vertical" labels are superseded.

Verb semantics (study §9, the plan's decisions of record, and the user's add answer):

| Verb | Today (presets) | Tree |
|---|---|---|
| **Add** (`addSurface`) | 1→2 `split-h`, 2→3 `main-left` | Split the **last leaf in reading order** along its longer axis (tie → `h`). The new leaf goes after it (right or bottom). Desktop uses the last leaf's real rect from `layoutRects` at the viewer's sizes. Mobile, and any caller without rects, uses a nominal 16:10 box (1600×1000). At landscape this reproduces `split-h` then `main-left` exactly. It returns `null` at 3 leaves (the cap) or on a repeated non-tty kind |
| **Close** (`closeSurface`) | 3→2 always `split-h`, 2→1 `single` | `removeLeaf` + `normalise`; the neighbours absorb its size. **Behaviour change**: closing one tile of `col` leaves `v(a,b)`. It returns `null` for the last leaf |
| **Promote** (`promote`) | move to slot A, order permutes | **Swap with slot A**: `templateOf(tree).slots[0]` (the template's main tile), or the first leaf in reading order for a custom tree. **Behaviour change**: in `main-left:tty,code,web`, promoting `web` gives `h(web,v(code,tty))`, not today's rotation |
| **Swap (directional)** | swap with next in order | Swap with the **geometric neighbour** in the direction left/right/up/down: the nearest leaf across that edge whose rect overlaps on the other axis. Ties go to the larger overlap, then reading order. Rects are the caller's (desktop) or come from the nominal box. It is a no-op when there is no neighbour |
| **Template jump** (`setShape` → `applyTemplate`) | same-arity preset | Rebuild from `TEMPLATES[name](n)` using the current slot order (`templateOf(tree).slots`). This is lossy for a custom tree |
| **Cycle** (`cycleShape`) | next same-arity preset | Next entry in `templatesFor(n)` after the current template. A `custom` tree cycles to the first template. At N = 1 it is a no-op |

`degradeLayout(tree, win, host)`: an unavailable leaf drops out through `removeLeaf` + `normalise` (tile by tile, structure otherwise kept). This replaces today's collapse to `split-h`/`single`. `tty` and `web` never degrade, and `gui` degrades with `hasGui(host)`, both unchanged. `effectiveLayout` is unchanged in shape: parse → degrade → fallback `tty`, and the option is never rewritten by degradation.

`translateLegacyParams` and `legacyTranslationDecision` keep working. They produce legacy strings, which `parseLayoutTree` accepts, and the decision's `write` is re-serialized in tree form.

**Sizes storage replaces ratios storage**: `rk-layout-sizes:{server}:{windowId}:{structureSig}`, e.g. `rk-layout-sizes:default:@3:h(0,v(1,2))`. The value is JSON: one fraction array per split, in pre-order, each array summing to 1 and matching that split's child count. Reads are validated (finite positive numbers, matching counts, else `undefined` → equal splits) with try/catch-noop. Writes happen on divider drag release only. Old `rk-layout-ratios:*` keys are **ignored**: not migrated and not deleted. Sizes are keyed by structure, not by leaves, so a swap keeps sizes with positions (study §6). The zoom key (`rk-layout-zoom:{server}:{windowId}`, storing a kind) is unchanged in this change.

### 3. `app/frontend/src/components/surface-layout.tsx`: flat, rect-positioned renderer

- Replace `gridStyle`/`slotStyle`/`dividerSpecs` (~505–700) and `defaultRatios`/`initialRatios` (~445–505) with `layoutRects(tree, containerBox, sizes)`. Every leaf renders in **one flat list** of absolutely positioned tiles, keyed by leaf id, so a restructure never re-parents a DOM node. Re-parenting an iframe reloads it; see the project-memory finding *code tile switch-back reloads iframe*.
- **Dividers**: one between each pair of adjacent siblings in each split, positioned in the 6 px gutter from the rects. Dragging a divider edits **those two fractions only**, and the combined share stays constant. The clamp keeps the existing `MIN_PANEL_WIDTH_PX` 280 px floor per side on the divider's own axis (today's `clampBoundary` semantics, generalised to the two siblings). Sizes persist under the current structure signature on release. The three-state gap-seam chrome (`rk-divider`/`rk-sash`/`rk-grips`), pointer capture, `touchAction: "none"`, the mid-drag `pointer-events-none` on tile content (~2696), and the `TileDragContext` flag to the native web engine are all preserved.
- **Intersection zone**: today's `main-*` T-junction zone generalises to any point where a divider ends on a perpendicular divider. Dragging it moves both adjacent fraction pairs. The existing `surface-divider-intersection` testid and `aria-valuenow` semantics stay.
- **Hide-never-unmount (P3)** and the **code-frame LRU** key by leaf id instead of kind. Behaviour is otherwise unchanged (caps 3 desktop / 1 mobile).
- **Focus** keys by leaf id instead of slot index. It defaults to the first leaf in reading order and falls back there when the focused leaf leaves. `onFocusedKindChange` still reports the kind. Primary-tty rules (`wsRef`/`focusRef`, find bar, progress slot) use the **first tty leaf in reading order**, as today.
- Header verbs stay for now: ⛶ zoom/expand, ◧ promote (new semantics), ⇄ swap (swap with the next leaf in reading order, wrapping), ✕ close. The retirement of Promote/Swap from the header is change 2, not this one.
- Mobile (R13) is unchanged: one tile (`mobileActiveTile` = stored zoom kind if hosted, else the first leaf).

### 4. ▦ chip, palette, chord

- `components/layout-chip.tsx`: the popover lists `templatesFor(n)` (mini glyphs rendered from the template tree, replacing the per-shape glyphs in `components/top-bar-icons.tsx`). The current template is marked (✓ + `aria-checked`), and the chip reads **`custom`** when `templateOf` returns `custom`. Picking a template when the current tree is custom notes that the rebuild is lossy. The overflow menu's form is one `Layout: <Template>` `menuitemradio` row per template.
- `lib/palette/layout.ts` (+ test): `Layout: <Template>` jumps for the current N (ids `layout-template-<name>`, replacing `layout-shape-<shape>`), `Layout: Cycle Template`, and `Layout: Promote <Surface>` (new semantics). Directional swap: `Tile: Swap Left/Right/Up/Down` (ids `tile-swap-left|right|up|down`) for the focused tile, shown only when a neighbour exists in that direction, **replacing** the per-kind `Layout: Swap <Surface>` rows. `Tile: Show/Hide/Focus` and `Layout: Expand/Restore` are unchanged. Show is omitted at 3 tiles (the cap).
- `⌘;` `layout-cycle` chord: same binding, now cycling templates.
- `app.tsx`: `applyLayout` serializes with `serializeLayoutTree`. The pending/optimistic layout compares serialized tree strings. `togglePanel`, `switchToTile`, the help-topic path and focus-hop call the tree verbs; add needs the last leaf's rect, which `SurfaceLayout` exposes through a ref seam (the `focusTileRef`/`zoomToggleRef` pattern) or the nominal box on mobile.

### 5. Backend `app/backend/internal/layoutspec/layoutspec.go` (+ test)

- Go port of the same model: `Node` type, `Parse(raw)` accepting both grammars with the same canonical and cap-3 validation (error on anything the TS parser rejects, so the two cannot drift), `String()` emitting the tree form, and `Default()` = `tty`.
- Verbs ported case for case: `Add` (last leaf, nominal 1600×1000 box, longer-axis split), `Close` (remove + normalise), `Promote` (swap with slot A via template match), `Cycle` (next template for N), `SetTemplate`. The named sentinel errors stay (`ErrLayoutFull`, `ErrLayoutLastTile`, `ErrSurfaceAbsent`, `ErrSurfaceRepeat`, `ErrUnknownSurface`). `ErrArityMismatch` becomes an unknown-template error. Go needs templates and `templateOf` for `Promote`/`Cycle`, but no sizes.
- Callers: `cmd/rk/tab_layout.go` (`rk tab layout` accepts both grammars as a positional value, `--add/--rm/--promote/--cycle` go through the ported verbs, and every form **prints the tree form**; help text rewritten), `cmd/rk/tab_web.go` (`webAddShow`: add `web`, and on a full layout **replace the last leaf in reading order** with `web`, preserving today's "yield the last slot"), `cmd/rk/tab_new.go` (`--layout` validates either grammar; help example updated), `api/windows.go:527` (the `/options` validator accepts either grammar and stores the value verbatim), `internal/tabaddr/tabaddr.go` (`IsSurface` unchanged), and `internal/tmux/tmux.go:114` (comment).
- MCP `internal/mcp/policy.go` `tab_layout`: the argument descriptions name the tree grammar ("`h(tty,v(code,web))` or a legacy `<shape>:<surface,…>`") and the cycle description says "template". Skill docs `cmd/rk/skill/{skill,display,tutorial}.md` show the tree form and note that legacy strings still parse.

### 6. Tile cap stays at three

The ≤3 cap stays in both parsers and in `Add`. The 150 × 100 px size floor, which replaces the cap, and the lifting of the cap are change 4. The tree code itself is N-generic and is tested to N = 4.

### 7. Tests

- Vitest: `lib/layout-tree.test.ts` (new, exhaustive invariants), `lib/surface-layout.test.ts` (verbs, degradation, sizes storage), `lib/palette/layout.test.ts`, `components/surface-layout.test.tsx` (flat render, keyed-by-leaf no-remount across restructure, divider two-fraction edit), `app.test.tsx` and `top-bar.test.tsx` where they assert preset strings.
- Go: `internal/layoutspec/layoutspec_test.go` (both grammars, canonical rejection, cap, verbs, the TS-parity cases), `cmd/rk` tab layout / tab web / tab new tests.
- e2e, updated for the tree encoding wherever a spec reads back `@rk_win_layout`: `surface-layout.spec.ts` (e.g. `main-left:tty,web,code` → `h(tty,v(web,code))`, `split-h:tty,web` → `h(tty,web)`, `single:code` → `code`), `help-topics.spec.ts`, `right-panel.spec.ts`, `web-view-lens.spec.ts`, `web-tile-chrome.spec.ts`, `present-auto-expand.spec.ts` (hand-written legacy writes must still render), `code-surface.spec.ts`, and `operator-compose.spec.ts` if the palette entry count changes. Every touched Playwright `test()` keeps or updates its **Proves/Steps** intent comment (constitution § Test Intent Comments).

### 8. Specs and memory

- `docs/specs/surface-layout.md`: rewrite § The Model and § Shape presets (canonical tree + templates, ≤3 in this change, lifted later), the § Verbs table (generic add/close/promote/swap, template cycle), and the Constitution Mapping line "presets, not free trees; ≤3 tiles" → "canonical tree (constrained, templates as generators); ≤3 tiles until the size floor lands".
- `docs/specs/ui-state.md` § Layout in tmux: the tree encoding, the permanent legacy parse, and `rk-layout-sizes:*` replacing `rk-layout-ratios:*`.
- Memory, per Affected Memory below.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Surface Layout — the model (tree × leaves × sizes), the pure `lib/layout-tree.ts` module, `lib/surface-layout.ts` verbs, the flat rect-positioned renderer and dividers, the ▦ chip templates/`custom`, palette rows, e2e notes; Design Decisions *The layout is a canonical tree; presets are templates*, *Leaves render flat, positioned from rects*, *Add splits the last leaf along its longer axis*, *Writers always emit the tree form*; supersede *Two-tile growth and the legacy param mapping both land on `split-h`* and *Sibling-boundary chaining is a row/col property*
- `run-kit/ui/keyboard-and-palette`: (modify) `Layout:` template rows, `Layout: Cycle Template`, `Tile: Swap Left/Right/Up/Down`, and the retired per-kind swap rows
- `run-kit/tmux-sessions`: (modify) the `@rk_win_layout` registry row's value format (tree form, legacy accepted)
- `run-kit/mcp`: (modify) the `tab_layout` tool's argument descriptions (tree grammar, template cycle)
- `run-kit/architecture/cli`: (modify) the `rk tab layout` verb semantics (both grammars, prints the tree form, template cycle)
- `run-kit/architecture/backend-packages`: (modify) the `internal/layoutspec` row and its Design Decisions (tree model, both grammars, ported verbs; `SwapWithNext`/`SetShape` superseded)

## Impact

- **Frontend**: `lib/layout-tree.ts` (new), `lib/surface-layout.ts`, `components/surface-layout.tsx` (2845 lines, the largest edit: render path, dividers, focus, hide set, code LRU keys), `components/layout-chip.tsx`, `components/top-bar-icons.tsx`, `lib/palette/layout.ts`, `app.tsx` (`applyLayout`, `pendingLayout`, `togglePanel`, `switchToTile`, help-topic add), plus consumers importing `Layout`/`LayoutShape`: `lib/right-panel.ts` (clamp), `lib/router-url.ts`, `lib/focus-memory.ts`, `lib/tile-chord.ts`, `lib/keybindings.ts`, `lib/code-folder-latch.ts`, `lib/find-in-page.ts`, `lib/gui-posture.ts`, `components/compose-strip.tsx`, `components/gui-toolbar.tsx`, `components/sidebar/row-flyout-card.tsx`, `components/top-bar.tsx`, `contexts/top-bar-slot-context.tsx`.
- **Backend**: `internal/layoutspec`, `cmd/rk/tab_layout.go`, `tab_web.go`, `tab_new.go`, `api/windows.go`, `internal/mcp/policy.go`, `cmd/rk/skill/*.md`, `internal/tmux/tmux.go` (comment).
- **Stored state**: existing `@rk_win_layout` preset values keep rendering identically. The first write after upgrade converts them to the tree form. Old `rk-layout-ratios:*` localStorage is ignored, so a viewer's custom divider positions reset to template defaults once.
- **Rollback**: a downgraded binary reads a tree-form value as malformed and renders `single:tty` without rewriting the option (accepted; the user chose tree form always).
- **No new routes, settings, or server-side state** (Constitution II, IV). Every verb stays palette-reachable (V).
- **Verification**: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest, not scoped); scoped e2e `just test-e2e <name>.spec`; `just _ensure-tmux-conf` then `env -u TMUX -u TMUX_PANE go test ./...` in `app/backend`. A fresh worktree needs `pnpm install --frozen-lockfile` in `app/frontend` first.

## Open Questions

- None blocking. Plan open questions 1 (isolate every tty stream) and 3 (root-drop share) belong to changes 3 and 2. Open question 2 was answered here (tree form always).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Layout is a canonical split tree `leaf` or `dir(children…)`, dir ∈ {h, v}, ≥2 children, alternating directions; stored in `@rk_win_layout` as e.g. `h(tty,v(code,web))` | Plan decision of record + study §2 contract | S:95 R:60 A:95 D:95 |
| 2 | Certain | Legacy `shape:a,b[,c]` strings parse into their trees permanently, lossless for all eight presets | Plan decision of record; `rk tab layout main-left` stays valid shorthand | S:95 R:75 A:95 D:95 |
| 3 | Certain | Writers always emit the tree form; no one-release preset-string fallback | Asked — user chose "Tree form always" (plan open question 2) | S:95 R:70 A:90 D:95 |
| 4 | Certain | Add splits the last leaf in reading order along its longer axis (tie → h); desktop uses real rect, mobile + Go use a nominal 1600×1000 box; reproduces split-h → main-left | Asked — user chose "Split last leaf"; overrides the decision-of-record's "focused tile" wording | S:90 R:75 A:90 D:90 |
| 5 | Certain | Tile count stays capped at 3 in both parsers and Add; the size floor and lifting the cap are change 4 | Stated in the user's description and the plan's change 1 seed | S:95 R:80 A:95 D:95 |
| 6 | Certain | Sizes are per-viewer localStorage `rk-layout-sizes:{server}:{@N}:<sig>`; old `rk-layout-ratios:*` keys ignored | Plan decision of record + change 1 item 2 | S:90 R:85 A:90 D:90 |
| 7 | Certain | Leaves render in a flat, rect-positioned list keyed by leaf id; a restructure never re-parents a tile | Plan change 1 item 3 + study §11 + project-memory iframe re-parent reload finding | S:90 R:65 A:90 D:90 |
| 8 | Certain | Close = removeLeaf + normalise (closing one of `col` leaves `v(a,b)`); Promote = swap with slot A | Plan decisions of record (generic verbs) + study §9 | S:90 R:80 A:90 D:90 |
| 9 | Certain | ▦ chip lists templates for the current N (deduped by structure) and reads `custom` otherwise; `Layout: <Template>` palette rows | Plan change 1 item 4 + decision "Presets become templates" | S:90 R:85 A:85 D:85 |
| 10 | Certain | Go `internal/layoutspec` ports the model: parses both grammars, validates canonical form, emits the tree form; `rk tab layout` prints the tree | Plan change 1 item 5 | S:90 R:75 A:90 D:90 |
| 11 | Confident | Header ◧/⇄ verbs stay in this change (⇄ = swap with next leaf in reading order); header retirement is change 2 | Plan scopes "Header Promote/Swap retire" to change 2 | S:75 R:85 A:80 D:75 |
| 12 | Confident | Degradation drops unavailable leaves via removeLeaf + normalise, keeping the remaining structure, instead of collapsing to split-h/single | Consistent with the generic Close rule; plan item 2 "degradeLayout operates on trees" | S:70 R:85 A:80 D:75 |
| 13 | Confident | `webAddShow` on a full layout replaces the last leaf in reading order with `web` | Preserves today's "yield the last slot" rule under the tree | S:65 R:85 A:80 D:75 |
| 14 | Confident | Divider drag edits the two adjacent fractions and keeps the 280 px per-side floor; the T-junction intersection zone generalises to every perpendicular divider meeting | Study §11 "dragging it adjusts those two fractions"; keeping the junction avoids regressing the existing e2e | S:65 R:80 A:70 D:65 |
| 15 | Confident | Both parsers reject non-canonical trees (malformed → frontend renders `tty`, Go errors) rather than normalising on read | One strict grammar keeps TS and Go from drifting; matches today's validate-on-parse posture | S:60 R:85 A:70 D:60 |
| 16 | Certain | Zoom key keeps storing a surface kind in this change; keying by leaf address is change 4 | Study §9/§10 ties the address-keyed zoom to tiles from other tabs | S:70 R:90 A:80 D:80 |
| 17 | Confident | Leaf id = kind, with duplicate tty leaves as `tty#2`… by reading-order occurrence | Needs a stable key before change 4's addresses; non-tty kinds are unique, so kind ids survive restructures | S:50 R:80 A:65 D:55 |
| 18 | Confident | Sizes value = JSON array of per-split fraction arrays in pre-order | The plan names the key, not the value shape; pre-order matches the signature traversal | S:45 R:90 A:70 D:55 |
| 19 | Confident | Directional swap targets the nearest leaf across that edge with perpendicular overlap (ties: larger overlap, then reading order); palette `Tile: Swap Left/Right/Up/Down` replaces the per-kind `Layout: Swap <Surface>` rows | Plan says "directional swap uses the geometric neighbour" and names the palette rows in change 2; the tie rule and the replacement are inferred | S:50 R:85 A:60 D:50 |
| 20 | Confident | N = 2 template labels read `Row`/`Column`; `SHAPE_LABEL`'s "Split Horizontal/Vertical" retire | Template registry naming; the plan names templates, not labels | S:45 R:90 A:60 D:55 |
| 21 | Confident | `/options` validator accepts either grammar and stores the value verbatim (no canonicalisation to the tree form) | The frontend already writes the tree form; storing verbatim is the least surprising for hand/agent writes | S:45 R:85 A:60 D:50 |

21 assumptions (11 certain, 10 confident, 0 tentative, 0 unresolved).
