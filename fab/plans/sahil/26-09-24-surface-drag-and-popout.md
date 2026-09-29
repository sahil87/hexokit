# Surface Layout Tree, Drag & Popout

**Drafted**: 2026-09-24 · revised 2026-09-25 (N tiles; tiles from other tabs) · against `d829bfa7` · from the 2026-09-24/25 `/fab-discuss` session on replacing the tile-header move buttons with drag-to-snap, designing the layout for N tiles, and adding per-surface popout
**Shape**: 1 study + 6 changes, one repo (run-kit) — **study → 1 → 2 → {3 ∥ …} → 4 → 5 → 6**: 1 (layout tree) is the model every later change stands on; 2 (drag) is the frontend core; 3 (isolated terminal sessions, backend) is file-disjoint from 1–2 and may start in parallel; 4 (tiles from other tabs) needs 2 and 3; 5 (popout) needs 4; 6 (shell popout windows) needs 5
**Contract of record**: `docs/wiki/surface-drop-zone-studies.html` (§1 counts, §2 model + encoding, §3 resolver, §4 live mock, §5 zones + size floor, §6 sizes through a drop, §7 feedback, §8 reachability, §9 generic verbs, §10 tiles from other tabs, §12 decisions) · pre-change truth in `docs/memory/run-kit/ui/lenses-and-layout.md` § Surface Layout, `docs/memory/run-kit/tmux-sessions.md` § Pin Sessions / relay attach flow, `docs/memory/run-kit/desktop-shell.md` · design authority `docs/specs/surface-layout.md` (amended by changes 1–3), `docs/specs/ui-state.md` § Layout in tmux

## Decisions of record

- **Design for N tiles, not three** (user direction 2026-09-25). Arrangements grow 2 → 6 → 22 → 90 → 394 for N = 2…6 (large Schröder numbers), so presets cannot be the model past three. The layout is a **canonical split tree**: `leaf | dir(children…)` with dir ∈ `h|v`, ≥2 children per split, directions alternating by depth. `@rk_win_layout` stores the tree form, e.g. `h(tty,v(code,web))`. The old `shape:a,b,c` strings parse into their trees permanently, so `rk tab layout main-left` stays valid shorthand.
- **Presets become templates**: `row`, `col`, `main-left|right|top|bottom` and `grid` build a tree for any N from the current slot order. The ▦ chip cycles the templates for this N and reads `custom` otherwise.
- **Sizes stay per viewer** (R7): per-split fractions in localStorage keyed by structure signature (`rk-layout-sizes:{server}:{@N}:<sig>`). They replace the per-shape ratios key, and the resolver carries them through drops (study §6).
- **One generic drop edit**: wrap the target with a placeholder → remove the dragged leaf → normalise → rename. Center swaps leaves. Targets are node paths and leaves are ids, never kinds. At N = 3 this reproduces the five presets plus `main-bottom`, the one structure they lack (verified by enumeration).
- **Zones: tile edges + layout edges (outer 18 px)**. Nested ancestor strips were rejected. They add 0.6 % of outcomes at N = 4 and 2.7 % at N = 5, and leave reachability unchanged. Max drops between any two layouts = N − 1; any single-tile move is one drop.
- **No tile cap; a size floor.** A drop, add or template is offered only if every tile stays ≥ 150 × 100 px in this viewer's viewport. Mobile stays one tile.
- **Generic verbs**: add splits the focused tile along its longer axis, falling back to the largest tile at the floor. At landscape sizes this reproduces today's 1→2 `split-h` and 2→3 `main-left`. Close removes the leaf and normalises; behaviour change: closing one tile of a `col` leaves a column. Promote swaps with slot A. Directional swap uses the geometric neighbour.
- **Feedback previews the result**, not a half-tile. A drop can reshape siblings.
- **Pointer events, not HTML5 drag-and-drop.** `setPointerCapture` on the header keeps moves arriving over iframes. The native web view (`WebContentsView`) hides for the drag's duration.
- **Header Promote/Swap retire; palette verbs stay** (Constitution V). Close/Expand stay on the header.
- **Popout is per viewer.** The opener hides the popped **leaf** locally (`rk-layout-popped:{server}:{@N}`, keyed by the leaf's address, not its kind) and reflows over the rest. Other viewers still see it. Closing the popout, or `Tile: Pop Back In`, restores it. Coordination runs over a same-origin `BroadcastChannel`.
- **Popout is a viewer param, not a route**: `/$server/@N?pop=<leaf-address>` renders one surface chrome-less. No new route (Constitution IV). A popout addresses `@N` and never follows the opener's navigation.
- **Isolation mechanism verified.** Verified on a throwaway server 2026-09-24: after `link-window`, `select-window` on home does not move the linked session's window, and `kill-session` on it leaves the window alive in home.
- **Tiles from any tab** (user direction 2026-09-25, replacing "which instance type first"). A leaf is a bare kind (this tab: `tty`, `code`, `web/2`, `gui`) or an address in ui-state.md's grammar, `[-L srv] @N/<surface>[/<n>]` (another tab: `@12/tty`). Same tmux server in v1; `gui` is host-wide and never borrowed.
- **A surface is live in exactly one place** (decided 2026-09-25). Borrowing A's terminal into B writes only B's layout (`@A/tty`). A keeps its `tty` slot, which renders as a **placeholder** while some other tab's layout holds `@A/tty`. The placeholder shows "Terminal is in tab B", **bring back**, **go to B**, the terminal's status dot, and **✕**. "Away" is derived from the other tabs' layouts, so nothing is stored.
- **✕ dismisses the placeholder** and removes the slot, so the remaining tiles fill the space. **The top-bar surface toggle restores it**: toggling `tty` on in A re-adds the slot, which renders as the placeholder while the terminal is away.
- **Returning**: bring back (in A) or the **↩ button on the borrowed tile's title bar** (in B; shown only when the tile's home ≠ the route window) removes `@A/tty` from B, and A's slot goes live again — one write. If A's slot was dismissed, ↩ also re-adds `tty` to A by the generic add rule, chained with the remove in one tmux invocation (the `MoveWindow` pattern). Re-borrowing into a third tab C moves it from B to C with the same chaining. These are the only two-tab writes.
- **A borrow starts by dragging a tab's sidebar row onto a tile zone** (the same resolver and overlay), with palette `Tile: Bring … here` as the keyboard route (decided 2026-09-25). Only one tab renders at a time, so there is no tab-to-tab drag.
- **Clicking a tab's sidebar row** when its terminal is borrowed lands on the tab and its placeholder (decided 2026-09-25). Addresses to dead windows are dropped at read time. **A layout never empties**: when its last tile leaves, it falls back to the tab's own `tty`.
- **Borrowed and popped-out terminals attach an isolated single-window session** (`_rk-iso-<digits>`, `link-window` — the pin-session mechanism). Two terminal streams on one tmux session share its current window and would fight.
- **Boards converge**: a board is a named layout whose tiles all point at other tabs. Boards migrate onto the tree later rather than stay a second mechanism.
- **Rejected**: extending the preset list (`main-bottom`, a 2×2, …) — correct only to N = 3; an unconstrained tree (unary nodes, stored sizes); a hard tile cap; choosing one extra instance type first (tiles from any tab cover them all); tmux `join-pane` for cross-tab moves (kills a single-pane home window, changes plain-tmux view, needs a stored home); nested ancestor strips; half-tile-only feedback; HTML5 DnD; a `/popout/...` route; popout as a shared `@rk_win_layout` write.

## Standing context (carry into every change's intake)

- **Frontend files**: `app/frontend/src/lib/surface-layout.ts` (484 — `LayoutShape`, `SHAPE_ARITY`, `SHAPE_RING`, `parseLayout`/`serializeLayout`, `degradeLayout`/`effectiveLayout`, the verb mutations `promote`/`swapWithNext`/`closeSurface`/`addSurface`/`cycleShape`/`setShape`, zoom/ratios storage keys); `components/surface-layout.tsx` (2845 — `defaultRatios`/`initialRatios` ~445–505, `gridStyle`/`slotStyle`/`dividerSpecs` ~505–700, the sash pointer-capture handlers ~1505/1601, hide-never-unmount + the code-frame LRU, the tile header verb cluster ~2560–2610, the mid-drag `pointer-events-none` ~2696); `components/top-bar-icons.tsx` (shape glyphs); `lib/palette/layout.ts` (+ test); `app.tsx` (`applyLayout`, `pendingLayout`); `lib/web-frame-engine.ts` + `components/web-frame-native.tsx` (the drag-hide seam).
- **Backend files**: `internal/layoutspec/layoutspec.go` (+ test — Go-side validation for `rk tab layout` / MCP / `--layout`); `api/terminals_ws.go` (`attachStream`: pin-session-first pick → scoped select → attach); `internal/tmux/board.go` (`PinSessionName`, `PinSessionPrefix`, pin/unpin `link-window`); `internal/tmux/layout.go:138` (session-name filter used by `parseSessions`).
- **Desktop files**: `app/desktop/src/preload.ts` (`shell:new-window` takes no URL; `web:*` group), `main.ts`, `window-open.ts` (`windowOpenAction` sends every http(s) `window.open` to the system browser — a shell popout needs its own channel).
- **Reference implementation**: the study's embedded resolver (`norm`, `removeLeaf`, `dropEdge`, `swapLeaves`, `edgeChain`, `layoutRects`, templates) is the executable spec. Port it to `lib/layout-tree.ts` with types. The study's enumeration (4 / 36 / 528 placements for N = 2/3/4) is the exhaustive test fixture.
- **E2E**: `tests/e2e/surface-layout.spec.ts` (15), `right-panel.spec.ts`, `code-surface.spec.ts`, `web-view-lens.spec.ts`, `operator-compose.spec.ts` (exact palette-entry count — project memory), `control-gallery.spec.ts` if header controls change classes.
- **Constitution**: II (sizes + popped set are viewer localStorage; `_rk-pop-*` is tmux-derived), IV (no new route or settings; the ≤3-tile / presets-not-trees line lives in surface-layout.md, not the constitution), V (every drag outcome has a palette verb), VI (popout sessions are tmux-side), Test Intent Comments on every touched `test()`.
- **Verification per change**: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest — project memory); scoped e2e `just test-e2e <name>.spec`; backend `env -u TMUX -u TMUX_PANE go test ./...` after `just _ensure-tmux-conf` in a fresh worktree; desktop `cd app/desktop && pnpm run compile && pnpm test`.

## Sequencing

```
study ──▶ 1 (layout tree) ──▶ 2 (drag) ──┐
          3 (isolated tty sessions) ─────┴──▶ 4 (tiles from other tabs) ──▶ 5 (popout) ──▶ 6 (shell popout windows)
```

Each change is its own fab change + draft PR off fresh `origin/main`; never stack. The study, this plan and the `docs/specs/index.md` wiki row are on main's docs commit. 3 is backend-only and may run from its own worktree while 1–2 are in flight.

Lane hints: 1 full; 2 full; 3 full; 4 full; 5 full; 6 full.

---

## Change 1 — layout tree model (slug: `surface-layout-tree`)

**Intake seed**: The terminal route's layout becomes a canonical split tree instead of one of eight presets — a new tree encoding in `@rk_win_layout` (old preset strings still parse), a recursive renderer with a divider between each pair of siblings, per-viewer sizes keyed by structure signature, templates in place of presets on the ▦ chip, and generic add/close/promote/swap. The tile count stays capped at three in this change.

1. `lib/layout-tree.ts` (new, pure): types, `parseLayoutTree` (tree grammar + legacy `shape:a,b,c`), `serializeLayoutTree`, `normalise`, `removeLeaf`, `insertBeside`, `swapLeaves`, `layoutRects(tree, box, sizes)`, `structureSig`, templates, `templateOf`. Exhaustive Vitest for N ≤ 4 over the invariants (canonical, leaf multiset kept, N kept, swap involution); legacy parse is lossless for all eight presets.
2. `lib/surface-layout.ts`: the verb mutations delegate to the tree (`promote`, directional `swap`, `closeSurface` = remove + normalise, `addSurface` = split focused on the longer axis — needs the focused leaf and its rect as inputs). `degradeLayout`/`effectiveLayout` operate on trees. Sizes storage replaces ratios storage (`rk-layout-sizes:*`); old `rk-layout-ratios:*` keys are ignored.
3. `components/surface-layout.tsx`: replace `gridStyle`/`slotStyle`/`dividerSpecs` with rect-positioned leaves in a **flat** list, so a restructure never re-parents an iframe. Dividers go between siblings, and the sash drag edits two fractions. Hide-never-unmount and the code-frame LRU key by leaf id.
4. ▦ chip + palette: template rows for the current N; `custom` state; `Layout: <Template>` palette entries.
5. `internal/layoutspec/layoutspec.go` (+ test): parse both grammars, validate canonical form, emit the tree form; `rk tab layout` accepts both and prints the tree; MCP tool description.
6. Tests: the Vitest above; `surface-layout.spec` updated for the encoding; `operator-compose.spec` palette count if entries change.
7. Specs/memory: surface-layout.md § The Model / § Shape presets rewritten (canonical tree + templates), Constitution Mapping line; ui-state.md § Layout in tmux (encoding + sizes key); lenses-and-layout.md § Surface Layout + Design Decisions *The layout is a canonical tree; presets are templates*, *Leaves render flat, positioned from rects*.

## Change 2 — drag to snap (slug: `surface-drag-snap`)

**Intake seed**: Tiles move by dragging their header: a pointer-captured drag offers center (swap), tile-edge (split beside) and layout-edge (span a side) zones, previews the resulting tree at the viewer's sizes, and commits one `@rk_win_layout` write on release; Escape cancels. Promote/Swap leave the header and stay in the palette.

1. `lib/layout-drop.ts` (new, pure): `zoneAt(rect, point)` (bands clamp(25 %, 28, 110) px, deepest-edge corners), `rootZoneAt(box, point)` (18 px), `resolveDrop(tree, sizes, dragged, hit) → {tree, sizes} | "noop"`. Vitest against the study's outcome sets.
2. `components/surface-layout.tsx`: header `pointerdown` past 4 px starts a drag; `setPointerCapture`; snapshot leaf rects; overlay = result preview; release → `onApplyLayout(tree)` + write the viewer's sizes under the new signature; Escape / outside / over-self cancel. Reuse the mid-drag flag so tiles go `pointer-events-none` and the native web engine hides.
3. Retire header Promote/Swap; keep palette rows (`Tile: Promote`, `Tile: Swap Left/Right/Up/Down`).
4. Off on coarse pointers, zoomed renders, single-tile layouts.
5. Tests: Vitest for zones + resolver; RTL for threshold/cancel/commit with mocked rects; e2e via `page.mouse` for swap, tile edge, layout edge and cancel.
6. Specs/memory: surface-layout.md § Verbs (drag is the mouse path; the ≤2-action guarantee rides the palette); lenses-and-layout.md Design Decisions *Pointer capture, not HTML5 DnD*, *The overlay previews the result*.

## Change 3 — isolated terminal sessions (slug: `tty-isolated-session`)

**Intake seed**: The terminal relay can attach a window through its own single-window tmux session, so a terminal shown outside its home tab (borrowed into another tab, or popped out) never fights the home session's current window. The session is created on demand and reaped when its last client leaves.

1. `internal/tmux`: `IsoSessionName(windowID)` (`_rk-iso-<digits>`), `EnsureIsoSession` (`new-session -d` + `link-window` + kill the placeholder — the pin path's shape), `_rk-iso-` in the `_rk-*` taxonomy and the `parseSessions` filter; snapshots skip it.
2. Relay (`attachStream`): an `open` op with `isolate: true` ensures the iso-session and attaches it; pick order pin → iso (when requested) → home. Non-isolated attaches unchanged.
3. Lifecycle: `destroy-unattached on` (verify it leaves the linked window alive, as `kill-session` does) or an explicit reap on stream close — decide in intake.
4. Decide in intake whether *every* tty stream should isolate. That would also fix the documented tradeoff of two browser tabs on sibling windows yanking each other, at the cost of one extra session per viewed window.
5. Tests: Go on an `-L` server (`env -u TMUX -u TMUX_PANE`); a relay test that two isolated streams on sibling windows of one session each keep their window.
6. Specs/memory: tmux-sessions.md § iso-sessions + relay pick order; api-and-sockets.md `open` op field.

## Change 4 — tiles from other tabs (slug: `surface-cross-tab-tiles`)

**Intake seed**: A tile can show any tab's surface on the same server, addressed as `@N/<surface>[/<n>]`. The surface is live in one place: its home slot shows a placeholder (bring back · go to · status · ✕) while it is borrowed, ✕ lets the remaining tiles fill the space and the surface toggle restores the slot, and a ↩ button on the borrowed tile sends it home. The tile count is limited only by a per-viewport size floor.

1. Leaf grammar in `lib/layout-tree.ts` + `internal/layoutspec`: bare kind (`tty`, `code`, `web/<n>`, `gui`) or `@N/<surface>[/<n>]`, same server. Validation rejects a foreign `gui` and a second occurrence of any surface address.
2. **Borrow**: a drop that brings a surface from another tab (dragging the tab's sidebar row onto a tile zone, or palette `Tile: Bring … here`) writes only the target tab's `@rk_win_layout`. When the surface is already borrowed elsewhere, the old holder's remove is chained in the same tmux invocation through `POST /api/layout/borrow {to:@B, leaf, tree}` (Constitution IX). The backend validates the trees and the "live in one place" rule.
3. **Return**: the placeholder's bring back, the ↩ header button (only on foreign leaves), and palette `Tile: Send Back to @N` — remove from the holder, and re-add `tty` to the home tab by the generic add rule only if its slot was dismissed (chained). A layout never empties: the last tile leaving falls back to the tab's own `tty`.
4. **Placeholder**: derive "surface X of @A is live in @B" from all windows' layouts (server-side, in the existing session payload); a home leaf whose surface is away renders the placeholder (bring back · go to @B · status dot · ✕), filling the tab when it is the only leaf. ✕ removes the slot; the top-bar surface toggle re-adds it (it renders as the placeholder while away). The toggle shows an "away" marker so the state is visible from the top bar. Sidebar row click lands on the tab (decided).
5. **Dead addresses** are pruned at read time; ↩ is disabled for them.
6. **Route-window assumptions** follow the tile's own window: compose strip target, bottom-bar keys, the tty tile's Split/Close Pane verbs, the progress slot, focus memory, the shared `wsRef`/`focusRef` holder. Audit `surface-layout.tsx`, `app.tsx`, `bottom-bar`, `compose-strip`.
7. Borrowed tty leaves open their relay stream with `isolate: true` (change 3).
8. Size floor (150 × 100 px) gates adds, drops and templates per viewport. The code-frame LRU cap stays.
9. Tests: Vitest for the grammar, validation and derivation; Go for the chained move + validation; e2e: borrow A's terminal into B, type in it, visit A (placeholder), ✕ it (web fills), toggle it back, bring it back, ↩ it home from B, kill A while borrowed.
10. Specs/memory: surface-layout.md § One tile per surface kind → tiles from other tabs, the "fourth surface = board" note, § Boards convergence; ui-state.md § Layout in tmux + § Addressing Grammar; sidebar row click behaviour (open question 1).

## Change 5 — popout (slug: `surface-popout`)

**Intake seed**: Any tile can pop out into its own browser window showing that one surface; the opener hides the popped tile for this viewer only and reflows; closing the popout or `Tile: Pop Back In` restores it. A popped-out terminal attaches an isolated session.

1. `?pop=<leaf-address>` handling in the terminal route: validate, render one tile chrome-less, keyed to `@N`; title `<Surface> · <window>`.
2. `lib/popout.ts`: the viewer's popped set; `BroadcastChannel("rk-popout")` messages `opened`/`closed`/`pop-in`; the opener renders `removeLeaf(tree, popped)` for this viewer; `pagehide` + a heartbeat clear a stale mark.
3. Verbs: header `Pop out` (content-verb family), palette `Tile: Pop Out …` / `Tile: Pop Back In …`.
4. Per kind: **tty** — `isolate: true` (change 3); **code** — the opener evicts its retained frame (one extension host, not two); **web** — iframe engine reloads in the new window; **gui** — second RFB client, geometry authority follows focus.
5. Tests: Vitest for the popped-set derivation; e2e with `context.waitForEvent("page")`, including a tty popout that keeps its window while the opener switches to a sibling tab.
6. Specs/memory: surface-layout.md § Verbs; ui-state.md § Viewer Behaviour; lenses-and-layout.md.

## Change 6 — shell popout windows (slug: `desktop-popout-windows`)

**Intake seed**: In the desktop shell, popouts open as shell windows on the same host (not the system browser), and a native web tile moves its live `WebContentsView` into the popout without reloading.

1. `shell:popout { url }` channel: validate same-host route + `?pop=`, open a shell window whose host view loads it; popouts are not restored from `windows.json`.
2. SPA: `lib/shell.ts` narrowing; `popOut()` prefers the bridge over `window.open`.
3. Native web: `web:reparent { tabKey, targetWindow }` — spike first (does a `WebContentsView` survive `removeChildView` + `addChildView` on another `BaseWindow` without reload on Electron 43?).
4. Optional tear-off: releasing a header drag outside the window pops the surface out.
5. Tests: `node --test` for the URL validator; manual shell matrix.
6. Memory: desktop-shell.md § Popout windows.

## Open questions

1. Should every terminal stream isolate (change 3 item 4)?
2. Should a 3-tile tree that matches an old preset keep writing the preset string for one release (rollback safety)?
3. A root-edge drop gives the dragged tile 50 % of the layout (the generic wrap rule). Should root drops take 1/N instead?
