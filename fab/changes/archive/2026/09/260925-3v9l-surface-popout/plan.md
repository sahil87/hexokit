# Plan: Surface Popout

**Change**: 260925-3v9l-surface-popout
**Intake**: `intake.md`

## Requirements

### Routing: the `?pop=` viewer param

#### R1: `pop` search param on the terminal route
`validateTerminalSearch` (`app/frontend/src/lib/router-url.ts`) SHALL accept `pop` as a raw non-empty string pass-through (like `layout`/`from`) and drop an empty or non-string value. `pop` is live state: the route-entry translation effect in `app.tsx` that rewrites retired `view`/`panel`/`layout` params to the bare route MUST NOT strip `pop`.

- **GIVEN** a URL `/main/5?pop=tty`
- **WHEN** the terminal route validates its search
- **THEN** `search.pop === "tty"` and the translation effect leaves `?pop=tty` in the URL
- **AND** `?pop=` (empty) validates to no `pop` key

#### R2: Popout leaf validation
The consumer SHALL resolve the `pop` value as a leaf id in the `leafIds()` vocabulary of `lib/layout-tree.ts`: a bare kind (`tty`, `code`, `web`, `gui`), a duplicate bare-tty occurrence (`tty#<n>`, n ≥ 2), or a foreign address parsed by `parseLeafAddress` (`@12/tty`). A foreign `gui`, a malformed value, or a value whose surface window (foreign `home`, else the route window) is absent from the sessions payload SHALL degrade to the ordinary (non-popout) terminal render — never a route error.

- **GIVEN** `/main/5?pop=@12/gui` or `/main/5?pop=bogus`
- **WHEN** the route renders
- **THEN** the normal terminal layout renders (no popout posture)

### Popout: the chrome-less render

#### R3: One tile, no app chrome
With a valid `pop`, the terminal route SHALL render exactly one tile filling the viewport and SHALL NOT mount the top bar, sidebar, bottom bar / compose strip, quake-terminal drawer, or command palette. The tile keeps its surface header (kind glyph, label, per-kind content verbs — tty pane segment, code Follow/Reload, gui toolbar) and replaces the layout-verb cluster (zoom, ↩, ✕, Pop out) with a single **Pop back in** verb (aria-label `Pop <Surface> back in`).

- **GIVEN** a popout window at `/main/5?pop=code`
- **WHEN** it renders
- **THEN** only the code tile is visible, no top bar/sidebar/bottom bar exists in the DOM, and the header shows Pop back in but no Expand/Close

#### R4: Popout identity is fixed
The popout SHALL be keyed to the route window `@N` from its URL and SHALL NOT follow the opener's navigation. Its document title SHALL be `<Surface> · <window name>` using `SURFACE_LABEL`, where the window is the leaf's home window for a foreign leaf (e.g. popping `@12/tty` out of `@5` titles `Terminal · <name of @12>`).

- **GIVEN** the opener at `@5` pops `@12/tty`
- **WHEN** the popout loads and the opener then navigates to `@7`
- **THEN** the popout title is `Terminal · <@12 name>` and the popout still shows `@12`'s terminal

#### R5: Popout outlives its leaf; ends with its window
The popout SHALL keep rendering its surface while the surface's window lives, even if the leaf is removed from the shared `@rk_win_layout`. When the window disappears from the sessions payload, the popout SHALL render an ended "Window closed" state (surface unmounted) and SHALL NOT navigate.

- **GIVEN** a tty popout of `@5`
- **WHEN** another viewer closes the tty tile in `@5`'s layout
- **THEN** the popout keeps showing the terminal
- **AND WHEN** window `@5` is killed **THEN** the popout shows "Window closed"

### Opener: the per-viewer popped set

#### R6: Popped set in viewer localStorage
The popped set SHALL persist in localStorage at `rk-layout-popped:{server}:{@N}` as a JSON array of leaf ids. Every access SHALL be wrapped in try/catch; corrupt or absent storage reads as the empty set. Pop-out and pop-in SHALL NEVER write `@rk_win_layout`.

- **GIVEN** storage holds `not json`
- **WHEN** the opener reads the popped set
- **THEN** it is empty and no error surfaces

#### R7: Opener render reduction
The opener SHALL render `reducePopped(tree, popped)` — `removeLeaf` of each popped id present in the tree; ids absent from the current tree SHALL be ignored and pruned from storage. If the reduction would empty the tree, the opener SHALL render a single **popped-out placeholder** ("<Surface> is popped out" + a **Pop back in** button) instead of an empty layout. A zoomed leaf that is popped SHALL render as unzoomed; the focused tile falls back per the existing first-leaf rule.

- **GIVEN** the shared tree `h(tty,code)` and popped `["code"]`
- **WHEN** the opener renders
- **THEN** only the tty tile renders, filling the layout
- **AND GIVEN** popped `["tty","code"]` **THEN** the popped-out placeholder renders

#### R8: Shared mutations act on the full tree; drag + template disabled while popped
All shared-layout mutations (add, close, promote, swap, send home, borrow, surface toggles) SHALL operate on the full shared tree, never on the reduced render. While this viewer has any leaf of this layout popped, header drag-to-snap and the ▦ template cycle (chip + chord + `Layout: <Template>` palette rows) SHALL be disabled.

- **GIVEN** `h(tty,code,web)` with `code` popped
- **WHEN** the user runs `Tile: Swap Right` on tty
- **THEN** the written tree still contains `code`
- **AND** pressing a tile header and moving 10 px starts no drag

### Coordination: the `rk-popout` BroadcastChannel

#### R9: Messages and lifecycle
Popout and opener SHALL coordinate over `BroadcastChannel("rk-popout")` with messages `{type, server, window, leaf}`, `type ∈ opened | alive | closed | pop-in | ping`: the popout posts `opened` on mount and in reply to `ping`, `alive` every `POPOUT_HEARTBEAT_MS` = 2000, and `closed` on `pagehide`; an opener posts `ping` on mount and `pop-in` to request close — on which the popout posts `closed` and calls `window.close()`. Messages that fail shape validation or name another server/window SHALL be ignored.

- **GIVEN** an open popout of `code` on `@5`
- **WHEN** the user closes the popout window
- **THEN** the opener receives `closed`, clears the mark, and the code tile reflows back

#### R10: Stale marks
A mark with no `opened`/`alive` from its popout within `POPOUT_STALE_MS` = 6000 SHALL be cleared (tile reflows back). On opener mount, persisted marks SHALL apply immediately (no flash of the popped tile) and be settled by `ping` + the stale window.

- **GIVEN** a persisted mark whose popout process died without `pagehide`
- **WHEN** 6 s pass with no heartbeat
- **THEN** the mark clears and the tile returns

### Verbs

#### R11: Opening a popout
Pop out SHALL call `window.open(url, "rk-pop:{server}:{@N}:{leafId}", "popup,width=<w>,height=<h>")` with `url` = the terminal route for `@N` plus `?pop=<leafId>`, sized from the tile's rendered rect (fallback 1200×800). The mark SHALL be written optimistically and rolled back when `window.open` returns `null`, with a toast "Pop-out blocked by the browser".

- **GIVEN** the browser blocks popups
- **WHEN** the user clicks Pop out
- **THEN** the tile stays rendered and the toast shows

#### R12: Pop out / Pop back in verbs (Constitution V)
Each tile header SHALL carry a **Pop out** button (aria-label `Pop out <Surface>`, new `PopOutGlyph`) in the content-verb family, before the layout-verb cluster. The palette SHALL register `Tile: Pop Out <Surface>` per eligible leaf (foreign leaves labelled with the home window name, as `Tile: Bring … here` does) and `Tile: Pop Back In <Surface>` per popped leaf of this layout. Pop out is eligible only when the rendered arity > 1, the viewport is non-mobile with a fine pointer, `isShell()` is false, and the tile is live (not the away placeholder, not a dead-home foreign tile, not the popped-out placeholder). Pop back in (palette, placeholder button, popout header verb) sends `pop-in` and clears the mark.

- **GIVEN** a single-tile layout, or the desktop shell, or a mobile viewport
- **WHEN** the tile header and palette render
- **THEN** no Pop out button and no `Tile: Pop Out` row exist

### Per-kind behaviour

#### R13: Terminal popout isolates
The popout's terminal SHALL open its relay stream with `isolate: true` on the leaf's home window (`leaf.home ?? @N`), so the popout keeps its window while the opener's session switches windows.

- **GIVEN** a tty popout of `@5` in session S
- **WHEN** the opener switches to sibling tab `@6` of S
- **THEN** the popout still shows `@5`'s pane content

#### R14: Code, web, gui
When the code leaf is popped the opener SHALL evict its retained code frame for that window (no second extension host); the popout mounts `CodeSurface` for that window's root. A web popout mounts the iframe web engine (reload accepted). A gui popout is a second RFB client; the opener's hidden gui tile disconnects via the existing visibility gate and `gui.geometry` authority rules are unchanged.

- **GIVEN** the code tile of `@5` is popped
- **WHEN** the opener's code-frame retention list is inspected
- **THEN** it holds no frame for `@5`

### Specs

#### R15: Spec amendments
`docs/specs/surface-layout.md` SHALL gain Pop out / Pop back in rows in § Verbs, the popped set in § State, and a Constitution Mapping line (II: popped set is viewer localStorage; IV: `?pop=` is a viewer param on the existing route). `docs/specs/ui-state.md` § Viewer Behaviour SHALL state popout is a per-viewer posture that never writes tab state, and name `?pop=` as a live terminal-route search param.

- **GIVEN** the change ships
- **WHEN** a reader opens surface-layout.md § Verbs
- **THEN** Pop out and Pop back in are documented

### Non-Goals

- Desktop-shell popout windows and native `WebContentsView` reparent — change 6 (`desktop-popout-windows`).
- A command palette inside the popout — user decision at intake.
- A "popped" marker on top-bar surface toggles.
- Backend changes — iso sessions shipped in change 3.

### Design Decisions

#### Popout is a viewer posture, never a layout write
**Decision**: the opener hides the popped leaf only in its own render via localStorage `rk-layout-popped:{server}:{@N}`; `@rk_win_layout` is untouched.
**Why**: popping a tile out on one machine must not rearrange the tab for other viewers or agents reading the shared layout (Constitution II/IV per-viewer state).
**Rejected**: writing popout into `@rk_win_layout` — hides the tile for every viewer.
*Introduced by*: 260925-3v9l-surface-popout

#### Popped leaves are keyed by leaf id
**Decision**: the `pop` value and popped-set entries are `leafIds()` ids (`tty`, `tty#2`, `code`, `@12/tty`).
**Why**: the plan keys by leaf address, not kind; duplicate bare tty tiles are legal, and `leafIds` is the existing stable id.
**Rejected**: keying by kind — cannot distinguish a bare `tty` from `@12/tty`.
*Introduced by*: 260925-3v9l-surface-popout

#### Drag and templates pause while a tile is popped
**Decision**: header drag and the ▦ template cycle are disabled while this viewer has a leaf of this layout popped.
**Why**: a drop resolved on the reduced tree would drop the popped leaf from every viewer's shared layout.
**Rejected**: re-inserting the popped leaf into the drop result (surprising positions, more code); auto pop-in on drag start.
*Introduced by*: 260925-3v9l-surface-popout

## Tasks

### Phase 1: Setup

- [x] T001 [P] Add `pop?: string` to `TerminalSearch` and its pass-through in `validateTerminalSearch` in `app/frontend/src/lib/router-url.ts`; extend `app/frontend/src/lib/router-url.test.ts` with pass-through + empty-drop cases <!-- R1 -->
- [x] T002 [P] Add `PopOutGlyph` (box + ↗) beside `SendHomeGlyph`/`ZoomGlyph` in the glyph module they live in (`app/frontend/src/components/top-bar-icons.tsx` or wherever `SendHomeGlyph` is defined) <!-- R12 -->

### Phase 2: Core Implementation

- [x] T003 Create `app/frontend/src/lib/popout.ts` (pure): `poppedKey(server, windowId)`, `readPopped`/`writePopped` (try/catch, JSON array of strings), `reducePopped(tree, popped) → { tree: LayoutNode | null, present: string[] }`, `parsePopLeaf(raw, routeWindow) → { leafId, kind, home } | null` (bare kinds, `tty#n`, foreign via `parseLeafAddress`, rejects foreign gui), `isPopoutMessage` shape validation, `sweepStale(marks, lastSeen, now, POPOUT_STALE_MS)`, constants `POPOUT_CHANNEL = "rk-popout"`, `POPOUT_HEARTBEAT_MS = 2000`, `POPOUT_STALE_MS = 6000`, `popoutWindowName`, `popoutUrl`. Tests in `app/frontend/src/lib/popout.test.ts` (corrupt storage, reduce over bare/tty#2/foreign, all-popped → null, absent ids pruned, stale boundary with explicit timestamps, message validation incl. wrong server/window) <!-- R2, R6, R7, R9, R10 -->
- [x] T004 Add the React hooks in `app/frontend/src/lib/popout.ts` (or `hooks/use-popout.ts` following the hooks folder pattern): `usePoppedSet(server, windowId)` for the opener (read storage, open the channel, `ping` on mount, handle `opened`/`alive`/`closed`, stale sweep interval, `popOut(leafId, rect)` with optimistic mark + `window.open` + null rollback + toast, `popIn(leafId)` posting `pop-in` + clearing) and `usePopoutPresence(server, windowId, leafId)` for the popout (post `opened`, `alive` interval, reply to `ping`, `closed` on `pagehide`, close on `pop-in`). Hook-level tests with a fake BroadcastChannel + fake timers <!-- R9, R10, R11 -->
- [x] T005 In `app/frontend/src/app.tsx`: detect the popout posture from `search.pop` (validated via `parsePopLeaf` + the sessions payload); keep `pop` through the route-entry translation effect; branch `AppLayout`/`AppLayoutContent` to skip `TopBar`, `Sidebar`, `BottomBar`/compose strip, quake drawer and `CommandPalette` in popout posture; render a single-tile popout view (reusing `SurfaceLayout` with a one-leaf tree and a `popout` prop, or a dedicated `SurfacePopout` component — follow whichever keeps the per-kind renderers unchanged); set `document.title` to `<Surface> · <window name>`; render "Window closed" when the surface window leaves the payload <!-- R2, R3, R4, R5 -->
- [x] T006 In `app/frontend/src/app.tsx` + `components/surface-layout.tsx`: wire `usePoppedSet` into the opener; pass the reduced tree to `SurfaceLayout` for rendering while every mutation callback (`onApplyLayout`, close, add, promote, swap, send home, borrow, toggles) keeps computing from the full shared tree; render the popped-out placeholder when the reduction is empty; clear zoom for a popped zoomed leaf <!-- R7, R8 -->
- [x] T007 In `components/surface-layout.tsx`: add the header **Pop out** button in the content-verb family (before the layout-verb cluster, hairline-separated) with the R12 eligibility rules (rendered arity > 1, non-mobile fine pointer, `!isShell()`, live tile); in popout posture render only a **Pop back in** verb in place of the layout-verb cluster; disable header drag arming while `poppedCount > 0` <!-- R3, R8, R12 -->
- [x] T008 Terminal popout: the popout's tty tile mounts `TerminalClient` with `isolate={true}` targeting `leaf.home ?? routeWindow` (`components/surface-layout.tsx` / the popout view) <!-- R13 -->
- [x] T009 Code/web/gui popout: on code pop, evict the opener's retained code frame for that window from the code-frame retention list in `components/surface-layout.tsx`; confirm the popout mounts `CodeSurface`, the iframe web engine, and the gui tile unchanged; confirm the opener's hidden gui tile disconnects via the existing visibility gate <!-- R14 -->

### Phase 3: Integration & Edge Cases

- [x] T010 Palette in `app/frontend/src/lib/palette/layout.ts`: `Tile: Pop Out <Surface>` per eligible leaf (foreign labelled with home window name) and `Tile: Pop Back In <Surface>` per popped leaf; gate `Layout: <Template>` rows + the template-cycle chord / ▦ chip while popped; wire callbacks from `app.tsx`; extend `lib/palette/layout.test.ts` (eligibility: arity 1, shell, placeholder, dead home, popped) <!-- R8, R12 -->
- [x] T011 RTL tests (`components/surface-layout.test.tsx` or a new colocated test): Pop out presence rules, popout posture renders only Pop back in, popped-out placeholder, drag not armed while popped <!-- R3, R7, R8, R12 -->
- [x] T012 e2e `app/frontend/tests/e2e/surface-popout.spec.ts` (file header + Proves/Steps JSDoc on every `test()`): (a) pop a tile via header with `context.waitForEvent("page")` → popout is chrome-less with `<Surface> · <window>` title and the opener reflows; (b) closing the popout returns the tile; (c) palette `Tile: Pop Back In` closes the popout and restores the tile; (d) a tty popout keeps its window while the opener switches to a sibling tab; (e) a foreign `@N/tty` leaf pops out and titles with its home window. Run `just test-e2e surface-popout.spec` <!-- R3, R4, R9, R12, R13 -->
- [x] T013 Regression gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest); `just test-e2e surface-layout.spec`, `just test-e2e cross-tab-tiles.spec`, `just test-e2e operator-compose.spec` (update its exact palette-entry count if the default fixture gains rows); `just test-e2e control-gallery.spec` only if header control classes changed <!-- R8, R12 -->

### Phase 4: Polish

- [x] T014 Specs: `docs/specs/surface-layout.md` § Verbs (Pop out / Pop back in rows), § State (popped set), Constitution Mapping line; `docs/specs/ui-state.md` § Viewer Behaviour (popout posture + `?pop=` live param) <!-- R15 -->

## Execution Order

- T003 blocks T004, T005, T006, T010
- T005 and T006 block T007–T009
- T012 and T013 run after all implementation tasks

## Acceptance

### Functional Completeness

- [x] A-001 R1: `validateTerminalSearch` passes a non-empty `pop` through and drops an empty one; the translation effect keeps `?pop=` in the URL
- [x] A-002 R2: Invalid, foreign-gui, or dead-window `pop` values render the ordinary terminal layout without error
- [x] A-003 R3: A valid popout renders one tile and no top bar, sidebar, bottom bar/compose strip, quake drawer, or command palette; its header has Pop back in and no zoom/↩/✕
- [x] A-004 R4: Popout title is `<Surface> · <window name>` (home window for foreign leaves) and the popout never follows opener navigation
- [x] A-005 R6: Popped set lives at `rk-layout-popped:{server}:{@N}` with try/catch access; pop-out/pop-in never write `@rk_win_layout`
- [x] A-006 R7: The opener renders the reduced tree, prunes absent ids, renders the popped-out placeholder when all leaves are popped, and unzooms a popped zoomed leaf
- [x] A-007 R9: `rk-popout` channel carries `opened`/`alive`/`closed`/`pop-in`/`ping` with the documented senders; `pop-in` closes the popout
- [x] A-008 R11: `window.open` uses the `rk-pop:{server}:{@N}:{leafId}` name and rect-derived popup features; a null return rolls back the mark and toasts
- [x] A-009 R12: Header Pop out and palette `Tile: Pop Out` / `Tile: Pop Back In` rows exist with the R12 eligibility rules
- [x] A-010 R13: The popout terminal opens its stream with `isolate: true` on `leaf.home ?? @N`
- [x] A-011 R14: Popping the code leaf evicts the opener's retained frame for that window; web/gui popouts mount their existing renderers
- [x] A-012 R15: surface-layout.md and ui-state.md document the popout verbs, popped set, and `?pop=` param

### Behavioral Correctness

- [x] A-013 R8: With a leaf popped, palette mutations write trees that still contain the popped leaf; header drag and the ▦ template cycle are disabled
- [x] A-014 R5: The popout keeps rendering after its leaf leaves the shared layout and shows "Window closed" when its window dies

### Scenario Coverage

- [x] A-015 R9: e2e covers pop out via header, close-to-restore, and palette Pop Back In
- [x] A-016 R13: e2e covers a tty popout keeping its window while the opener switches to a sibling tab
- [x] A-017 R4: e2e covers a foreign-leaf popout titled with its home window
- [x] A-018 R6: Vitest covers popped-set parse/serialize, reduction, pruning, all-popped, and message validation

### Edge Cases & Error Handling

- [x] A-019 R10: A mark without heartbeat for 6 s clears; persisted marks apply on opener mount without a flash and settle via `ping`
- [x] A-020 R11: Popup-blocked path keeps the tile and shows the toast
- [x] A-021 R12: No Pop out on single-tile layouts, mobile/coarse, desktop shell, away placeholders, or dead-home foreign tiles

### Code Quality

- [x] A-022 Pattern consistency: New code follows naming and structural patterns of surrounding code (glyphs, palette builders, hooks, localStorage key helpers)
- [x] A-023 No unnecessary duplication: Existing utilities reused (`leafIds`, `removeLeaf`, `parseLeafAddress`, `SURFACE_LABEL`, `isShell`, toast provider)
- [x] A-024: Type narrowing over `as` casts for message validation and search parsing
- [x] A-025: No magic numbers — heartbeat, stale window, fallback popup size are named constants
- [x] A-026: No client polling of the server — the stale sweep is a local timer over BroadcastChannel liveness, not a fetch loop
- [x] A-027: Comments state constraints only — no narration, no change IDs / PR numbers
- [x] A-028: No god functions — the popout render path and hooks are split into focused units
- [x] A-029: Every touched Playwright `test()` carries a Proves/Steps JSDoc and the new spec has a file header (Constitution Test Intent Comments)
- [x] A-030: Every new user-facing action is palette-registered (Constitution V)

### Security

- [x] A-031 R2: The `pop` value is validated against the leaf grammar before use; it is never interpolated into HTML or used as a window-open URL beyond the route builder

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The popout posture reuses the existing seams (`SurfaceLayout` tile/header keys, the top-bar slot context's `notFound` channel precedent, `leafIds`/`removeLeaf`/`parseLeafAddress`, the code-frame retention list, the visibility-gated RFB connection); no file, function, branch, or config was superseded.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Duplicate-tty ids take the `tty#<n>` (n ≥ 2) form, matching `leafIds()` exactly | Reusing the existing id function keeps the pop value and popped set aligned with the renderer's leaf ids | S:70 R:85 A:85 D:80 |
| 2 | Confident | Pop out also hides when the tile is the popped-out placeholder or a dead-home foreign tile; eligibility is computed on the rendered (reduced) arity | Intake §4 eligibility + R7; the reduced arity is what the viewer sees | S:65 R:85 A:80 D:75 |
| 3 | Confident | The ▦ template cycle is gated together with drag while popped (chip, chord, and `Layout: <Template>` rows) | Templates rebuild from the current slot order; running one over the reduced tree has the same leaf-loss hazard as a drop | S:70 R:85 A:80 D:80 |
| 4 | Confident | RESOLVED at apply: the popout reuses `SurfaceLayout` with a one-leaf tree + the `popoutLeafId`/`onPopBackIn` props — per-kind renderers unchanged, per the tentative assumption | The component's tile/header seams already keyed off leaf ids; a dedicated component would have duplicated the renderers | S:45 R:80 A:55 D:40 |
| 5 | Confident | Fallback popup size 1200×800 when no tile rect is measured | Intake §3 value | S:75 R:95 A:80 D:80 |

| 6 | Confident | Hooks live in `hooks/use-popout.ts` (the hooks-folder pattern), pure halves in `lib/popout.ts`; hook tests stub `BroadcastChannel` globally + fake timers | Plan T004 offered either placement; lib modules in this repo are pure/DOM-free, and the hooks folder carries the React-wiring pattern | S:60 R:85 A:70 D:65 |
| 7 | Confident | The popout's own Pop back in posts `closed` + `window.close()` directly (the opener clears its mark on `closed`); the opener's palette Pop Back In posts `pop-in`, on which the popout posts `closed` and closes | Plan R9's flow names pop-in → close; routing the popout's own verb through a self-addressed pop-in adds a hop for the same outcome — closing the popout by any means is equivalent (intake §4) | S:60 R:80 A:65 D:60 |
| 8 | Confident | The chrome-less branch publishes AppShell's payload-dependent popout posture to the root layout through a new boolean channel on the top-bar slot context (the `notFound` precedent); a one-frame chrome flash on popout load is accepted | AppLayoutContent renders above the Outlet, so only a registered channel reaches it; the payload-dependent ever-seen rule must not recompute in two places | S:55 R:80 A:60 D:55 |
| 9 | Certain | The popout gates the three navigation effects (mount-time alignment, URL writeback, kill-redirect) and never navigates; a grammar-valid `pop` whose window is known-absent once the payload arrives degrades to the ordinary terminal render | R2/R4/R5 verbatim | S:80 R:75 A:85 D:80 |
| 10 | Confident | The sidebar row-drag borrow is disarmed while popped (same reduced-tree drop hazard as header drag); palette `Tile: Bring … here` stays available (computes from the full tree) | R8 names header drag + the template cycle; the row-drag's commit rides the same reduced-tree resolver, so it is the same hazard class | S:70 R:75 A:70 D:65 |
| 11 | Confident | The code seed/workspace hooks read the popout's one-leaf tree in popout posture (a code popout seeds/derives even if its leaf left the shared layout); the opener's read the rendered (reduced) tree, so a popped code tile neither seeds nor holds a frame in the opener | R14 + the seed rule ("first time the code tile actually renders"); the popout is the render that must work | S:60 R:75 A:60 D:55 |
| 12 | Confident | The all-popped placeholder renders one row per popped leaf, each with its own Pop back in button; the tiles stay mounted-hidden behind it (streams survive) | R7 names "a single popped-out placeholder"; per-leaf rows keep every return path one click, and hidden mounting matches the partial-pop posture | S:45 R:80 A:50 D:45 |
| 13 | Certain | The popout posture forces SurfaceLayout's desktop branch (`isMobile={false}`): the popup is sized from the tile's rect, often under the 640px mobile breakpoint, and the mobile branch renders no tile header — the popout's only Pop back in verb | Pop out is desktop-only (R12 eligibility); e2e run 1 proved the narrow-popup case renders headerless without this | S:80 R:70 A:85 D:80 |

13 assumptions (3 certain, 10 confident, 0 tentative).
