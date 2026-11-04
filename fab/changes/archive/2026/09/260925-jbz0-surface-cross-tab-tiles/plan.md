# Plan: Surface Cross-Tab Tiles

**Change**: 260925-jbz0-surface-cross-tab-tiles
**Intake**: `intake.md`

## Requirements

### Layout Model: Foreign leaves in the grammar

#### R1: Leaf grammar accepts foreign addresses
Both parsers — `app/frontend/src/lib/layout-tree.ts` (`parseLayoutTree`) and `app/backend/internal/layoutspec/layoutspec.go` (`Parse`) — SHALL accept a leaf that is either a bare kind (`tty` | `web` | `code` | `gui`) or a foreign address `@<digits>/<kind>`, and SHALL serialize a foreign leaf back to the identical string. The optional `/<n>` suffix SHALL be recognised by the tokenizer and then rejected by validation (v1: grammar-only). `-L <srv>` and `=<session>:` qualifiers SHALL be rejected. Legacy `shape:a,b,c` strings stay bare-kind only. The TS and Go parsers MUST accept and reject an identical corpus.

- **GIVEN** the stored value `h(tty,v(@12/tty,web))`
- **WHEN** either parser reads it
- **THEN** it yields a split whose second child holds a leaf `{leaf:"tty", home:"@12"}` and `serialize` returns the input unchanged
- **AND** `h(tty,@12/web/2)`, `h(tty,web/2)`, `h(tty,-L x @12/tty)`, `h(tty,=s:@12/tty)` all parse to `null` / error

#### R2: Foreign-leaf validation rules
Canonical-tree validation SHALL additionally reject: a foreign `gui` (`@N/gui`); a repeated foreign address; and — when the owning window id is supplied — a foreign leaf naming the owning window. Repeated bare `tty` SHALL remain legal; a repeated non-tty bare kind stays rejected. A bare kind and a foreign leaf of the same kind MAY coexist (`h(web,@12/web)`).

- **GIVEN** window `@7` and the tree `h(tty,tty,@12/tty)`
- **WHEN** validated for owner `@7`
- **THEN** it is valid
- **AND** `h(tty,@12/tty,@12/tty)`, `h(tty,@12/gui)` and (for owner `@7`) `h(tty,@7/tty)` are invalid

#### R3: Leaf identity is the address
A foreign leaf's id SHALL be its address string (`@12/tty`); bare leaves keep `tty`, `tty#2`, …. `leafIds`, `pathOf`, `removeLeaf`, `swapLeaves`, `insertBeside`, `structureSig`-adjacent helpers, and `leafIdParts` (surface-layout.tsx) SHALL handle address ids without coercing them to `tty`.

- **GIVEN** `h(tty,@12/tty)`
- **WHEN** `leafIds` runs
- **THEN** it returns `["tty","@12/tty"]` and `removeLeaf(tree,"@12/tty")` returns the bare `tty` leaf

#### R4: Tile cap removed; byte cap raised
`MAX_TILES` / `MaxTiles` SHALL no longer cap leaf count in parse, validation, or add. `MAX_LAYOUT_LEN` / `MaxLayoutLen` SHALL be raised to 512 bytes (still enforced before parsing as the recursion-depth guard).

- **GIVEN** a canonical 6-leaf tree (e.g. `v(h(tty,code,web),h(@3/tty,@4/tty,@5/code))`)
- **WHEN** parsed by either side
- **THEN** it is accepted; a 513-byte input is rejected before parsing

### Layout State: Away derivation

#### R5: Server derives `awayIn` per window
The backend SHALL derive, for every window on a server, `awayIn: map[kind]holderWindowId` (JSON `awayIn`, omitted when empty) on `tmux.WindowInfo`, computed from all windows' parsed layouts in the session fetch (`internal/sessions` `FetchSessions` or the list-windows chokepoint): a foreign leaf `@A/<kind>` in window W's layout, where `@A` exists on the server and `@A ≠ W`, sets `A.awayIn[kind] = W`. Foreign leaves to non-existent windows SHALL be ignored. When two holders name the same address, the first in window-list order SHALL win deterministically. The frontend `WindowInfo` type SHALL mirror the field.

- **GIVEN** windows `@3` (layout `tty`) and `@7` (layout `h(tty,@3/tty)`) and `@9` (layout `h(tty,@44/tty)`, `@44` dead)
- **WHEN** sessions are fetched
- **THEN** `@3.awayIn == {"tty":"@7"}`, `@7.awayIn` and `@9.awayIn` are empty, and no entry names `@44`

#### R6: "Live in one place" enforced on every layout write
A shared Go helper SHALL reject a layout write to window B that introduces a foreign leaf `@A/<kind>` already held by a third window C (C ≠ B), returning a 4xx (409) error naming the holder and directing the caller to borrow. The helper SHALL be applied by `POST /api/windows/{windowId}/options` for `@rk_win_layout`, by `rk tab layout`, and SHALL enforce R2's self-window rule with B as owner. Writes whose foreign leaves are unheld, or held by B itself, pass.

- **GIVEN** `@7` holds `@3/tty`
- **WHEN** a client posts `@rk_win_layout = h(tty,@3/tty)` for `@9`
- **THEN** the request fails with 409 and no option is written

### Layout Verbs: Borrow and return

#### R7: Borrow endpoint moves a held surface in one chained write
`POST /api/layout/borrow` (server via `?server=`) with body `{ "to": "@B", "leaf": "@A/<kind>", "tree": "<B's new tree>" }` SHALL validate `tree` (R1/R2 for owner B, `leaf` present in it), locate the current holder C of `leaf` (if any, C ≠ B), compute C's tree minus the leaf (normalised; the bare `tty` fallback when it empties), and write C's and B's `@rk_win_layout` in ONE `;`-chained tmux invocation through `internal/tmux`. With no holder it writes only B. All subprocess use SHALL follow Constitution I (argv slices, ctx timeout) and the route SHALL be POST (IX).

- **GIVEN** `@7` holds `@3/tty` with layout `h(web,@3/tty)` and `@9` has `tty`
- **WHEN** the client posts borrow `{to:"@9", leaf:"@3/tty", tree:"h(tty,@3/tty)"}`
- **THEN** one tmux invocation leaves `@7 = web` and `@9 = h(tty,@3/tty)`

#### R8: Return endpoint sends a surface home
`POST /api/layout/return` with body `{ "from": "@B", "leaf": "@A/<kind>" }` SHALL recompute from current tmux state: B's tree minus the leaf (tty fallback when empty), and — only if A's layout has no bare `<kind>` leaf — A's tree with `<kind>` re-added by `layoutspec.Add` (nominal geometry), writing both in one chained invocation (only B when A still has its slot). A leaf not present in B's layout SHALL return 409; a dead home window SHALL remove the leaf from B without writing A.

- **GIVEN** A=`@3` layout `web` (tty dismissed) and B=`@7` layout `h(tty,@3/tty)`
- **WHEN** return `{from:"@7", leaf:"@3/tty"}` is posted
- **THEN** `@7 = tty` and `@3 = h(web,tty)` (Add rule) in one invocation

#### R9: Sidebar row drag borrows a tab's terminal onto a tile zone
While an HTML5 window-drag (`WINDOW_DRAG_MIME`) from the sidebar is in flight over the terminal route, `SurfaceLayout` SHALL mount a drop-catcher overlay above all tiles (tiles `pointer-events-none`, native web view hidden via the existing mid-drag seam) that hit-tests with `zoneAt`/`rootZoneAt` against snapshot leaf rects and shows the result-preview overlay (incl. "too small" and "no change"). Dropping on a tile-edge or layout-edge zone SHALL insert `@<dragged>/tty`; the center zone SHALL be a no-op. The drop SHALL be refused ("no change") when the dragged window is the route window, when `@<dragged>/tty` is already in the layout, or when the drag's server ≠ the route server. Existing row-drag consumers (reorder, move-to-session, board pin) SHALL be unaffected. The write SHALL be a plain `applyLayout` when the address is unheld (or held by this window) and `POST /api/layout/borrow` otherwise.

- **GIVEN** tab `@9` showing `tty` and the sidebar row for `@3`
- **WHEN** the row is dragged onto the right edge of the tty tile and released
- **THEN** `@9`'s layout becomes `h(tty,@3/tty)` and the preview matched it during the drag

#### R10: `resolveDrop` accepts an external leaf
`resolveDrop` (lib/layout-drop.ts) SHALL accept an external leaf not yet in the tree, inserting it at tile-edge / layout-edge zones by the generic edit (wrap target with placeholder → replace placeholder with the new leaf → normalise) and returning `noop` for center and `too-small` when the floor is broken. Internal drags are unchanged.

- **GIVEN** tree `tty` and an external leaf `@3/tty` hit on the tty tile's right edge
- **WHEN** resolved
- **THEN** the result is `move` with tree `h(tty,@3/tty)`

#### R11: Palette borrow and send-back
The palette SHALL offer `Tile: Bring <window> <Surface> here` per other window on the route server × each of its `tty`/`code`/`web` surfaces that is not already in this layout (never `gui`), gated by the add rule's floor; it inserts by the generic add rule and writes via plain apply or borrow as in R9. For a focused foreign tile it SHALL offer `Tile: Send Back to <home window>` invoking R8 (disabled/hidden when the home window is dead). On the home tab, for each bare leaf whose kind is away, it SHALL offer `Tile: Bring Back <Surface>` invoking R8 with from = the holder (the placeholder's bring back, Constitution V).

- **GIVEN** route `@9` and another window `@3` named `api`
- **WHEN** the palette opens
- **THEN** it lists `Tile: Bring api Terminal here` (and Code/Web when available)

### Tile Rendering: Placeholder, ↩, dead addresses

#### R12: Home slot renders a placeholder while away
In tab A, a bare leaf `<kind>` with `A.awayIn[kind]` naming a live holder SHALL render a placeholder instead of mounting the surface (tty opens no relay stream). The placeholder SHALL show "<Surface> is in tab <holder name>", a **bring back** control (R8 with from = holder), a **go to <holder>** control (navigates to the holder's route), the surface's status dot (for tty: the home window's status as the sidebar row shows it), and **✕**. ✕ SHALL close that leaf (`closeSurface` + `applyLayout`) and SHALL be hidden when the placeholder is the only leaf. A sole-leaf placeholder fills the tab. Mobile (one tile) renders the placeholder when slot A is away.

- **GIVEN** `@3` layout `h(tty,web)` and `@7` holds `@3/tty`
- **WHEN** the user visits `@3`
- **THEN** the left tile shows "Terminal is in tab <@7 name>" with bring back / go to / status dot / ✕ and no relay stream is opened for it
- **AND** clicking ✕ leaves layout `web`

#### R13: Top-bar surface toggle shows away and restores the slot
The top-bar surface toggle SHALL show an "away" marker for kinds in `awayIn`, toggling a kind on SHALL re-add the slot (which renders as the placeholder while away), and the hardcoded 3-tile disable (top-bar.tsx `open.length >= 3`) SHALL be replaced by the size-floor check (R16).

- **GIVEN** `@3` layout `web` with `awayIn.tty` set
- **WHEN** the user toggles tty on
- **THEN** the layout becomes a two-tile tree containing bare `tty`, rendered as the placeholder, and the toggle shows the away marker

#### R14: ↩ header button on foreign tiles
A foreign leaf's tile header SHALL carry a ↩ button in the Expand/Close verb cluster, shown only when the leaf's home ≠ the route window, invoking R8 (from = route window). It SHALL be disabled when the home window is dead. The header SHALL identify the home tab (e.g. the surface label plus the home window name).

- **GIVEN** `@9` layout `h(tty,@3/tty)`
- **WHEN** the user clicks ↩ on the `@3/tty` tile
- **THEN** `@9` becomes `tty` and `@3`'s slot goes live

#### R15: Dead addresses pruned at read time
The client SHALL prune foreign leaves whose window is not in the route server's window set before rendering (removeLeaf → normalise → bare `tty` fallback when empty); the pruned tree is persisted only by the next write. A layout never renders empty.

- **GIVEN** `@9` layout `h(tty,@3/tty)` and `@3` is killed
- **WHEN** the next session payload arrives
- **THEN** `@9` renders a single tty tile

### Tile Layer: Size floor

#### R16: Size floor replaces the tile cap for offers
The 150×100 px floor (`MIN_TILE_W`/`MIN_TILE_H`, layout-drop.ts) SHALL gate: `addSurface` (split the focused tile on its longer axis; else the largest tile; refuse only when no split fits the floor in the measured box, `NOMINAL_BOX` when unmeasured), `Layout: <Template>` rows (a template result under the floor is not offered), the top-bar toggle, `Tile: Show <S>`, and `Tile: Bring … here`. Stored trees under the floor SHALL render as-is (no degrade). Mobile stays one tile. The code-frame LRU cap is unchanged.

- **GIVEN** a 1280×800 layout box with four tiles
- **WHEN** the user toggles a fifth surface on
- **THEN** it is added iff some tile can split while every resulting tile stays ≥150×100

### Tile Layer: Route-window assumptions follow the tile

#### R17: Foreign tty streams isolate and target their home window
A foreign tty tile SHALL open its relay stream with its home window id and `isolate: true` (`OpenStreamOpts.isolate`, forwarded by `sendOpen`); bare tty streams SHALL NOT send `isolate`.

- **GIVEN** `@9` rendering `@3/tty`
- **WHEN** the tile mounts
- **THEN** the relay `open` op carries `windowId:"@3", isolate:true`

#### R18: Focus-driven targets follow the focused tile's window
The focused tty tile (bare or foreign) SHALL register its own server/session/window/wsRef as the focused terminal, so the compose strip send target, bottom-bar keys, and focus memory follow it; `inTileDock` SHALL count a foreign tty as a terminal tile. The tty tile's Split / Close Pane verbs SHALL target the tile's own window (and its `worktreePath`).

- **GIVEN** `@9` layout `h(tty,@3/tty)` with the `@3/tty` tile focused
- **WHEN** the user sends text from the compose strip or clicks Split
- **THEN** the text goes to `@3` and the split happens in `@3`

#### R19: Code, web and progress state follow the tile's window
A foreign code tile SHALL resolve its source, code root, frame record and code-root writes from its home window's `WindowInfo`; a foreign web tile SHALL read and write its home window's `@rk_win_web_*` tabs (optimistic override keyed by the home window). Progress slots SHALL be keyed per window: a foreign tty's progress chip/line render on its own tile and never on the route window's slot.

- **GIVEN** `@9` rendering `@3/web`
- **WHEN** the user adds a web tab in that tile
- **THEN** `@3`'s `@rk_win_web_<n>` options change, not `@9`'s

### Docs

#### R20: Specs describe tiles from other tabs
`docs/specs/surface-layout.md` (§ One tile per surface kind → tiles from other tabs + move semantics, § Verbs ↩/bring back/size floor, Constitution Mapping size-floor line, the fourth-surface/board note, § Boards convergence) and `docs/specs/ui-state.md` (§ Layout in tmux foreign leaves, § Addressing Grammar layout use, sidebar row click) SHALL be amended.

- **GIVEN** the merged change
- **WHEN** a reader opens surface-layout.md
- **THEN** it no longer states a ≤3-tile / one-per-kind limit and documents move semantics

### Non-Goals

- Popout (`?pop=`) and desktop popout windows — changes 5 and 6
- Multiple web tiles per layout (`web/<n>` leaves) — grammar-only in v1
- Cross-server (`-L`) foreign leaves; `gui` borrowing
- Migrating boards onto the tree; tab-to-tab drag

### Design Decisions

#### A surface is live in one place; away is derived
**Decision**: Borrowing writes only the holder's layout (`@A/tty`); the home keeps its slot, rendered as a placeholder while a server-derived `awayIn` names a holder.
**Why**: One live instance avoids relay-pointer fights and duplicate ~300 MB code-server hosts; derivation from layouts keeps Constitution II (nothing stored).
**Rejected**: tmux `join-pane` (kills single-pane homes, changes plain-tmux view, needs a stored home); mirroring the surface in both tabs.
*Introduced by*: 260925-jbz0-surface-cross-tab-tiles

#### Row borrow reuses the HTML5 window-drag
**Decision**: The sidebar row's existing HTML5 drag drives the borrow via a drop-catcher overlay reusing `zoneAt`/`resolveDrop` and the preview.
**Why**: Rows already carry `WINDOW_DRAG_MIME`; a second pointer drag would fight the native `draggable` and its reorder / session-move / board-pin consumers.
**Rejected**: A pointer-captured row drag (handoff with native DnD is fragile).
*Introduced by*: 260925-jbz0-surface-cross-tab-tiles

#### Two-tab writes go through server-recomputed endpoints
**Decision**: Re-borrow and return are `POST /api/layout/borrow|return`, which recompute the other tab's tree from current tmux state and chain both `set-option`s in one invocation; plain writes reject an already-held leaf.
**Why**: A single chained invocation means no viewer observes a surface in two tabs; server recompute prevents a stale client clobbering the other tab.
**Rejected**: Client-computed two-tree writes; silent steal on plain writes.
*Introduced by*: 260925-jbz0-surface-cross-tab-tiles

## Tasks

### Phase 1: Model (grammar, validation, cap)

- [x] T001 Extend `app/frontend/src/lib/layout-tree.ts`: `LayoutLeaf` gains `home?: string`; `parseTreeGrammar` tokenizes `@<digits>/<kind>[/<n>]`; `serializeLayoutTree` emits addresses; `isCanonicalTree(node, owner?)` applies R2 (foreign gui, repeated address, self-owner, any `/<n>`, keep bare-tty dups); `leafIds` returns addresses for foreign leaves; `removeLeaf`/`pathOf`/`swapLeaves`/`insertBeside` work on address ids; remove `MAX_TILES` as a cap; `MAX_LAYOUT_LEN = 512`. Add helpers `isForeignLeaf`, `leafAddress`, `parseLeafAddress("@12/tty") → {home, kind}`, `pruneDeadLeaves(tree, liveWindowIds)` (R15, with bare-tty fallback). <!-- R1 --> <!-- R2 --> <!-- R3 --> <!-- R4 --> <!-- R15 -->
- [x] T002 Vitest in `app/frontend/src/lib/layout-tree.test.ts` for the grammar/validation corpus, round-trip, address ids, prune, and 6-leaf acceptance; add a shared accept/reject corpus fixture `app/frontend/src/lib/layout-grammar.fixtures.json` consumed by both TS and Go tests. <!-- R1 --> <!-- R2 --> <!-- R3 --> <!-- R4 -->
- [x] T003 Mirror in `app/backend/internal/layoutspec/layoutspec.go`: `Node` foreign home, parse/serialize addresses, `ValidateFor(n, owner)` with R2 rules, remove `MaxTiles` cap from `Parse`/`isCanonicalTree`/`Add`, `MaxLayoutLen = 512`, `LeafIDs` addresses, `Remove(n, leafID)` + tty fallback helper. Update `layoutspec_test.go` to consume the shared fixture (path relative from the Go package) plus table tests. <!-- R1 --> <!-- R2 --> <!-- R3 --> <!-- R4 --> <!-- rework: layoutspec.Add's repeat check must count only bare leaves (R2 coexistence), mirroring TS -->
- [x] T004 Update `app/frontend/src/components/surface-layout.tsx` `leafIdParts` (and any kind-from-id parsing) to recognise address ids (kind + home) instead of coercing to `tty`. <!-- R3 -->

### Phase 2: Backend — derivation, validation, endpoints

- [x] T005 Add `AwayIn map[string]string json:"awayIn,omitempty"` to `tmux.WindowInfo` (`app/backend/internal/tmux/tmux.go`) and a pure `DeriveAwayIn(windows []WindowInfo)` (first-holder-wins, dead/self ignored) applied once per server in the session fetch (`app/backend/internal/sessions/sessions.go` `FetchSessions`, across all sessions' windows). Go unit tests for derivation. <!-- R5 -->
- [x] T006 Shared holder check in `app/backend/internal/layoutspec` or `internal/tmux` (e.g. `CheckLiveInOnePlace(tree, owner, windows)`), applied in `app/backend/api/windows.go` options handler for `@rk_win_layout` (409 on violation) and in `app/backend/cmd/rk/tab_layout.go`; remove `MaxTiles` uses in `cmd/rk/tab_layout.go`, `tab_web.go`, `tab_new.go`. Tests. <!-- R6 --> <!-- R4 -->
- [x] T007 `internal/tmux`: `SetWindowLayouts(ctx, server, map/ordered pairs windowID→layout)` writing multiple windows' `@rk_win_layout` in ONE `;`-chained invocation (reuse `appendOptionOps`). Unit test the argv; integration test on an `-L`/`-S` private server. <!-- R7 --> <!-- R8 -->
- [x] T008 `app/backend/api/layout_borrow.go` (+ `api/router.go` routes `POST /api/layout/borrow`, `POST /api/layout/return`): borrow per R7, return per R8, body validation (`validate` window ids, leaf address parse), 400/404/409 mapping; `api/layout_borrow_test.go` covering unheld borrow, re-borrow chain, empty-holder tty fallback, return with/without dismissed slot, dead home, leaf-not-in-from 409. Update `docs/specs/api.md` endpoint list if it enumerates routes. <!-- R7 --> <!-- R8 --> <!-- rework: handleLayoutBorrow must run tmux.CheckLiveInOnePlace on the posted tree (every foreign leaf other than the borrowed one) so a second held leaf is rejected 409, matching the options handler and rk tab layout; add a test --> <!-- rework: handleLayoutReturn must not swallow an Add error for the home re-add; with the bare-only repeat check the re-add succeeds when home holds only a foreign leaf of the kind; surface any real error -->

### Phase 3: Frontend — data, client, resolver, verbs

- [x] T009 [P] Mirror `awayIn` on `WindowInfo` (`app/frontend/src/types.ts`) and, if needed, `ViewWindow` (`lib/window-view.ts`); add `borrowLayout(server, {to, leaf, tree})` and `returnLayout(server, {from, leaf})` to `app/frontend/src/api/client.ts` (+ tests matching the client test pattern). <!-- R5 --> <!-- R7 --> <!-- R8 -->
- [x] T010 [P] `app/frontend/src/lib/relay-mux.ts`: `OpenStreamOpts.isolate?: boolean` forwarded by `sendOpen` (omitted when false); terminal-client accepts an `isolate` prop and passes it; tests. <!-- R17 -->
- [x] T011 `app/frontend/src/lib/layout-drop.ts`: extend `hitTest`/`resolveDrop` with an external-leaf mode (edge zones insert, center `noop`, floor `too-small`); Vitest cases in `layout-drop.test.ts`. <!-- R10 -->
- [x] T012 `app/frontend/src/lib/surface-layout.ts`: `addSurface` drops the `MAX_TILES` check and applies the floor (focused tile longer axis → largest tile → refuse), accepting a foreign leaf as the added leaf; add `fitsFloor(tree, sizes, box)` and use it for template gating; tests in `surface-layout.test.ts`. <!-- R16 --> <!-- rework: addSurface's repeat check must count only BARE leaves of the kind (a foreign @N/<kind> does not block adding bare <kind>, per R2) -->
- [x] T013 `app/frontend/src/lib/palette/layout.ts` (+ test): `Tile: Bring <window> <Surface> here` rows (floor-gated, excluding gui / already-present / route window), `Tile: Send Back to <home>` for a focused foreign tile, floor gating of `Tile: Show` and `Layout: <Template>`; wire in `app.tsx` (window list for the route server, borrow/return handlers). <!-- R11 --> <!-- R16 --> <!-- rework: Constitution V — add a home-tab palette row `Tile: Bring Back <Surface>` for each away bare leaf (awayIn[kind] set), invoking the same return as the placeholder bring back -->
- [x] T014 `app/frontend/src/app.tsx`: a borrow helper (`borrowInto(leafAddress, tree)`: plain `applyLayout` when unheld/held-by-self, else `borrowLayout`) and a `sendHome(from, leaf)` helper (`returnLayout`); apply `pruneDeadLeaves` to the effective layout before render; pass the server's window map to `SurfaceLayout`. <!-- R9 --> <!-- R11 --> <!-- R14 --> <!-- R15 --> <!-- rework: pass the focused leaf id into addSurface from togglePanel and every palette add/bring call site so R16's focused-tile split engages; addSurface should floor-check with the viewer's stored sizes for the current structure when available; add tests -->

### Phase 4: Frontend — tile rendering and route-window follow

- [x] T015 `components/surface-layout.tsx`: resolve each leaf's tile window (home window's `WindowInfo` for foreign leaves, route window otherwise); tile keys, zoom and focus memory key by leaf id; foreign tty tiles pass home window id + `isolate`; `primaryTty` = first bare tty; register focus per focused tty tile (own window/session/wsRef). <!-- R17 --> <!-- R18 -->
- [x] T016 `components/surface-layout.tsx` + `terminal-client.tsx` + `compose-strip.tsx` + `bottom-bar.tsx` + `app.tsx`: focus registration carries the focused tile's window; compose send target, bottom-bar keys, `focusMemoryWindow`, `inTileDock` follow it; tty tile Split/Close Pane call `executeSplit`/`executeClosePane` with the tile's window id and worktree path. RTL/unit tests for the focus-target switch. <!-- R18 -->
- [x] T017 `components/surface-layout.tsx`: per-window progress slots (keyed by tile window); a foreign tty's chip/line render on its own tile. <!-- R19 -->
- [x] T018 `components/surface-layout.tsx` + `app.tsx`: foreign code tile uses the home window's `codeSrcFor`/`codeRootFor`/frame record/code-root writes/`useCodeWorkspace` target; foreign web tile reads/writes the home window's web tabs and keys `webOverride` by the home window. <!-- R19 -->
- [x] T019 Placeholder component (new `components/surface-placeholder.tsx` or inside surface-layout.tsx following its patterns): message, bring back, go to, status dot, ✕ (hidden when sole leaf); render in place of an away bare leaf without mounting the surface; RTL test. <!-- R12 -->
- [x] T020 Tile header ↩ (foreign leaves only, disabled on dead home) in the Expand/Close cluster and home-tab identification in the header; RTL test for visibility rules. <!-- R14 -->
- [x] T021 `components/top-bar.tsx`: away marker on `SurfaceToggleGroup` from `awayIn`; replace the hardcoded `open.length >= 3` with a floor-derived `canAdd` passed from `app.tsx`; toggle-on of an away kind re-adds the slot. <!-- R13 --> <!-- R16 --> <!-- rework: top-bar toggle 'open' state must consider only bare leaves; a foreign-only kind shows as not open and toggling adds the bare slot -->
- [x] T022 Row-drag borrow: `components/surface-layout.tsx` drop-catcher overlay active during a `WINDOW_DRAG_MIME` drag (listen for window-level `dragstart`/`dragend` or a shared drag-state signal from the sidebar), mid-drag seam (pointer-events-none + native web hide), `dragover` hit-test with preview, refusal rules, `drop` → `borrowInto`; keep `components/sidebar/index.tsx` / `window-row.tsx` consumers intact (payload already carries server + windowId). RTL test with synthetic drag events. <!-- R9 -->

### Phase 5: e2e, docs

- [x] T023 New `app/frontend/tests/e2e/cross-tab-tiles.spec.ts` (file header + Test Intent Comments per test): borrow A's terminal into B via sidebar-row drag onto a tile edge; type in it and see output in A's window; visit A → placeholder; ✕ → remaining tile fills; toggle tty on → placeholder + away marker; bring back; borrow again then ↩ from B; kill A while borrowed → B prunes. Use regex `page.route` if stubbing; run `just test-e2e cross-tab-tiles.spec`. <!-- R9 --> <!-- R12 --> <!-- R13 --> <!-- R14 --> <!-- R15 --> <!-- R17 --> <!-- R18 -->
- [x] T024 Re-run and fix `surface-layout.spec.ts`, `right-panel.spec.ts`, `code-surface.spec.ts`, `web-view-lens.spec.ts`, `operator-compose.spec.ts` (palette count), and `control-gallery.spec.ts` if header control classes changed. <!-- R16 --> <!-- R11 -->
- [x] T025 Amend `docs/specs/surface-layout.md` and `docs/specs/ui-state.md` per R20. <!-- R20 -->
- [x] T026 Remove the zero-call-site `MAX_TILES` export (app/frontend/src/lib/layout-tree.ts) and the test-only `ReplaceLast` (app/backend/internal/layoutspec/layoutspec.go + its test); unexport or fold `layoutspec.Remove` into `RemoveOrTTY` if it has no production caller. <!-- R4 --> <!-- rework: review deletion candidates -->

## Execution Order

- T001 → T002, T004, T011, T012; T003 → T005, T006, T007 → T008
- T009, T010 independent after Phase 1
- T014 needs T009, T011, T012; T015–T022 need T014; T016 needs T015
- T023–T024 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: Both parsers accept `@N/<kind>` leaves, round-trip them, and reject `/<n>`, `-L`, `=session:` forms; the shared corpus passes in Vitest and Go
- [x] A-002 R2: Foreign gui, repeated address, and self-owner addresses are rejected; repeated bare tty accepted
- [x] A-003 R3: Foreign leaf ids are address strings across tree helpers and `leafIdParts`
- [x] A-004 R4: No tile-count cap remains in parse/validate/add on either side; byte cap is 512
- [x] A-005 R5: `WindowInfo.awayIn` is derived per server with dead/self/duplicate handling and reaches the frontend type
- [x] A-006 R6: Options endpoint and `rk tab layout` reject an already-held foreign leaf with 409
- [x] A-007 R7: Borrow writes holder + target in one chained tmux invocation; unheld borrow writes only the target
- [x] A-008 R8: Return removes from the holder and re-adds a dismissed home slot in one invocation; dead home and missing-leaf cases handled
- [x] A-009 R9: Sidebar row drag onto a tile edge borrows `@A/tty` with preview; center/no-op/refusal rules hold; existing row drags still work
- [x] A-010 R10: `resolveDrop` inserts external leaves at edge zones, noop at center, too-small under the floor
- [x] A-011 R11: `Tile: Bring … here` and `Tile: Send Back to …` exist, gated as specified
- [x] A-012 R12: Away home slots render the placeholder (message, bring back, go to, status dot, ✕) without mounting the surface
- [x] A-013 R13: Top-bar toggle shows the away marker and re-adds the slot; no hardcoded 3-tile disable remains
- [x] A-014 R14: ↩ appears only on foreign tiles, disabled for dead homes, and sends the surface home
- [x] A-015 R15: Dead foreign leaves are pruned before render; empty falls back to tty
- [x] A-016 R16: The 150×100 floor gates add, templates, toggle, Show and Bring; stored oversized trees render as-is
- [x] A-017 R17: Foreign tty streams open with the home window id and `isolate: true`; bare streams omit it
- [x] A-018 R18: Compose, bottom-bar keys, focus memory and Split/Close Pane follow the focused tile's window
- [x] A-019 R19: Foreign code/web tiles read and write their home window's state; progress renders per window
- [x] A-020 R20: surface-layout.md and ui-state.md describe tiles from other tabs and move semantics

### Behavioral Correctness

- [x] A-021 R12: ✕ on a placeholder leaves the remaining tiles filling the layout (behaviour change from one-per-kind layouts)
- [x] A-022 R16: Adding a fourth+ tile is permitted when the floor allows (previously capped at three)

### Scenario Coverage

- [x] A-023 R9: e2e `cross-tab-tiles.spec.ts` covers borrow → type → placeholder → ✕ → toggle back → bring back → ↩ → kill-home prune, and passes
- [x] A-024 R7: Go tests cover the chained re-borrow on a private tmux server

### Edge Cases & Error Handling

- [x] A-025 R8: Return of a leaf not in `from` returns 409 and writes nothing
- [x] A-026 R15: Killing a home window while borrowed never renders a broken tile or an empty layout
- [x] A-027 R9: Cross-server and self-window drags are refused with "no change"

### Code Quality

- [x] A-028 Pattern consistency: New code follows naming and structural patterns of surrounding code (tmux calls via `internal/tmux`, API client via `api/client.ts`)
- [x] A-029 No unnecessary duplication: TS/Go grammar share one fixture corpus; chaining reuses `appendOptionOps`
- [x] A-030: Type narrowing over `as` casts in the new grammar/validation code
- [x] A-031: Subprocess calls use `exec.CommandContext` with argv slices and timeouts
- [x] A-032: No god functions added to `surface-layout.tsx`/`app.tsx` — new logic extracted into helpers or components
- [x] A-033: Comments state constraints, no narration or change-ID citations
- [x] A-034: Every added/modified Playwright `test()` carries a Proves/Steps intent comment

### Security

- [x] A-035 R7: Borrow/return bodies validate window ids and leaf addresses before any tmux call; no shell strings

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None outstanding — the change already deleted the code it made redundant: `MAX_TILES` (`app/frontend/src/lib/layout-tree.ts`), `MaxTiles` / `ErrLayoutFull` / `ReplaceLast` (`app/backend/internal/layoutspec/layoutspec.go`), the `webAddShow` full-layout replace-last fallback (`app/backend/cmd/rk/tab_web.go`), and the `extraTtyWsRef` dummy bucket (`app/frontend/src/components/surface-layout.tsx`, folded into the per-leaf `ttyWsRefsRef` map).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `awayIn` computed once per server in `FetchSessions` across all sessions' windows | `@N` is unique per server; FetchSessions already sees every session's windows | S:70 R:80 A:75 D:70 |
| 2 | Confident | Multi-window chained write as a new `internal/tmux` helper reusing `appendOptionOps` | Existing `SetWindowOptions` chains ops for one target; same shape for several | S:75 R:85 A:80 D:75 |
| 3 | Confident | Shared grammar corpus as a JSON fixture read by both Vitest and Go | Parity requirement; `layout-tree.fixtures.json` precedent | S:70 R:90 A:75 D:70 |
| 4 | Confident | Borrow/return validation errors map to 400 (bad body), 404 (unknown window), 409 (holder / missing-leaf conflict) | Existing handlers' status conventions | S:65 R:85 A:70 D:70 |
| 5 | Tentative | The drop-catcher learns of a row drag via window-level `dragstart`/`dragend` checking `dataTransfer.types` for `WINDOW_DRAG_MIME` | Keeps sidebar code untouched; types are readable during dragover | S:50 R:80 A:60 D:55 |
| 6 | Tentative | Foreign tile header identifies its home by the home window's name beside the surface label | Study §10 shows the tab name; exact chrome unspecified | S:45 R:90 A:60 D:55 |

6 assumptions (0 certain, 4 confident, 2 tentative).
