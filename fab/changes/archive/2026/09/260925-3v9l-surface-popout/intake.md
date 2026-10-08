# Intake: Surface Popout

**Change**: 260925-3v9l-surface-popout
**Created**: 2026-09-25

## Origin

> Any tile can pop out into its own browser window showing that one surface; the opener hides the popped tile for this viewer only and reflows; closing the popout or Tile: Pop Back In restores it. A popped-out terminal attaches an isolated session. Full spec, task breakdown, standing context (frontend/backend/desktop files, reference implementation, tests, constitution mapping, verification commands) and decisions of record are in fab/plans/sahil/26-09-24-surface-drag-and-popout.md — read the whole file, then use its "Change 5 — popout" section plus "Standing context" and "Decisions of record" sections as authoritative intake input. Changes 1-4 (layout tree, drag-to-snap, isolated terminal sessions, tiles from other tabs) are already merged to main; this change needs change 4's cross-tab addressing to know which leaf to pop.

One-shot `/fab-new` invocation. The authoritative design input is **Change 5 — popout** of `fab/plans/sahil/26-09-24-surface-drag-and-popout.md` (slug `surface-popout`, lane hint: full), plus that plan's *Standing context* and *Decisions of record*, all produced in the 2026-09-24/25 `/fab-discuss` session. The contract of record for the surface model is `docs/wiki/surface-drop-zone-studies.html`. Changes 1 (canonical layout tree, `lib/layout-tree.ts`), 2 (drag-to-snap, `lib/layout-drop.ts`), 3 (isolated terminal sessions `_rk-iso-*`, relay `open { isolate: true }`) and 4 (tiles from other tabs — `@N/<surface>` foreign leaves, away placeholder, borrow/return; `d92b71cc`, #1041) are merged on `main`. Change 6 (desktop-shell popout windows, `WebContentsView` reparent) follows this one and is out of scope here.

Decisions of record carried verbatim from the plan (not re-litigated):

- **Popout is per viewer.** The opener hides the popped **leaf** locally (`rk-layout-popped:{server}:{@N}`, keyed by the leaf's address, not its kind) and reflows over the rest. Other viewers still see it. Closing the popout, or `Tile: Pop Back In`, restores it. Coordination runs over a same-origin `BroadcastChannel`.
- **Popout is a viewer param, not a route**: the terminal route with `?pop=<leaf-address>` renders one surface chrome-less. No new route (Constitution IV). A popout addresses `@N` and never follows the opener's navigation.
- **Borrowed and popped-out terminals attach an isolated single-window session** (`_rk-iso-<digits>`, `link-window` — the pin-session mechanism). Two terminal streams on one tmux session share its current window and would fight.
- **Rejected**: a `/popout/...` route; popout as a shared `@rk_win_layout` write.

## Why

1. **Problem.** The surface layout (changes 1–4) can put a terminal, editor, web page and GUI desktop side by side in one tab, but everything shares one browser window. A user with two monitors — or who wants an agent's terminal on one screen while driving the editor full-size on another — has no way to take one tile out of the grid. Today the only workaround is opening the same tab's URL in a second browser window, which renders the *whole* layout again (duplicate chrome, a second copy of every tile, a second code-server extension host for the `code` tile) and, for the terminal, attaches a second stream to the home session — which then fights the first over the session's current window the moment either viewer switches tabs.
2. **Consequence of not doing it.** Multi-monitor use stays clumsy and resource-heavy (a duplicated `code` frame is a ~250–320 MB extension host each — the reason the code-frame LRU exists), and the duplicated-terminal workaround actively misbehaves (window yanking), so users learn to avoid it.
3. **Why this approach.** Popout is a **viewer posture**, not tab state: popping a tile out on my machine must not rearrange the tab for another viewer or an agent reading `@rk_win_layout`. So the shared layout is untouched; the opener renders `removeLeaf(tree, popped)` for this viewer only, with the popped set in viewer localStorage (Constitution II/IV: per-viewer state lives in localStorage), and the two windows coordinate over a same-origin `BroadcastChannel`. Rendering the popout through the existing terminal route plus a `?pop=` param keeps the fixed route set (Constitution IV) and reuses every existing surface renderer. Change 3's iso sessions give the popped terminal an independent current-window pointer, and change 4's leaf addresses (`tty`, `code`, `@12/tty`) are exactly the identity needed to say *which* leaf is popped — including a borrowed foreign tile. Rejected: a `/popout/...` route (new route surface, Constitution IV); writing popout into `@rk_win_layout` (would hide the tile for every viewer).

## What Changes

### 1. `?pop=<leaf-id>` on the terminal route — the popout render

- The terminal route is `/$server/$window` where the URL segment is the window id **without** the `@` (`/$server/5` ↔ `@5`, `lib/router-url.ts` `windowIdToUrlSegment`). The plan's `/$server/@N?pop=…` shorthand therefore materialises as e.g. `/main/5?pop=tty`, `/main/5?pop=code`, `/main/5?pop=%4012%2Ftty` (the foreign leaf `@12/tty`, URL-encoded by the router).
- `lib/router-url.ts` `validateTerminalSearch` / `TerminalSearch` gain `pop?: string` — a raw non-empty string pass-through like `layout`/`from` (the module stays a dependency-free leaf; validation lives in the consumer). Unlike the retired `view`/`panel`/`layout` params, `pop` is **live state**: the route-entry translation effect in `app.tsx` that replaces the URL with the bare route MUST NOT strip it.
- The `pop` value is a **leaf id** as produced by `leafIds()` in `lib/layout-tree.ts`: a unique bare kind (`tty`, `code`, `web`, `gui`), a duplicate bare tty occurrence (`tty#2`), or a foreign address (`@12/tty`). Validation in the consumer: the value must parse as one of those forms (foreign via `parseLeafAddress`, which already rejects `/<n>` suffixes and unknown kinds), must not be a foreign `gui`, and its window (the leaf's `home` for a foreign leaf, else the route window `@N`) must exist in the sessions payload. An invalid value degrades to the normal (non-popout) terminal route render — never a route error (the `validateTerminalSearch` drop-don't-error posture).
- **Chrome-less render**: when `pop` is present and valid, the terminal route renders exactly one tile filling the viewport — no top bar, no sidebar, no bottom bar / compose strip, no quake terminal drawer, no command palette mount (user decision — Assumption 12). The tile keeps its own surface header (kind glyph + label, the per-kind content verbs — tty pane segment, code Follow/Reload, gui toolbar fold) and replaces the layout-verb cluster (zoom / ↩ / ✕) with a single **Pop back in** verb. The pathless `app-layout` route (`AppLayout` in `app.tsx`, which hosts `TopBar`, `Sidebar`, `BottomBar`, `CommandPalette`) is the seam that must branch on the popout posture.
- The popout is keyed to the opener's route window `@N` and never follows the opener's navigation — its route is fixed for its lifetime. It still subscribes to the session SSE stream (window names, dead-window detection, code root, gui state).
- **Document title**: `<Surface> · <window name>` — e.g. `Terminal · agent-3`, `Editor · run-kit`; for a foreign leaf the window name is the leaf's **home** window's name (the surface's owner), e.g. popping `@12/tty` out of `@5` titles `Terminal · <name of @12>`. Surface labels come from `SURFACE_LABEL` in `lib/surface-layout.ts` (shared, so they never drift).
- **Dead window**: when the surface's window disappears from the sessions payload, the popout renders an ended state ("Window closed") and stops its stream; it does not navigate.

### 2. `lib/popout.ts` (new, pure + a thin channel adapter) — the viewer's popped set

- **Storage**: `rk-layout-popped:{server}:{@N}` in localStorage → JSON array of leaf ids (e.g. `["tty","@12/tty"]`), per the decision of record. All access wrapped in try/catch; a corrupt/absent value reads as the empty set (Constitution II degrade-to-cold-start).
- **Opener render reduction**: the opener renders `reduce(tree, popped)` = `removeLeaf` of every popped id present in the tree (ids absent from the current tree are ignored and pruned from storage). **The shared `@rk_win_layout` is never written by pop-out or pop-in.** If the reduction would empty the tree (every remaining leaf popped — possible after another viewer closes tiles), the opener renders a single **popped-out placeholder** ("<Surface> is popped out" + **Pop back in**) instead of an empty layout (a layout never renders empty — the change-4 rule).
- **BroadcastChannel `"rk-popout"`** messages, each carrying `{ server, window: "@N", leaf: "<leaf-id>" }`:
  - `opened` — popout → openers, on popout mount and in reply to `ping`.
  - `alive` — popout heartbeat, every `POPOUT_HEARTBEAT_MS` (2000).
  - `closed` — popout → openers, on `pagehide`.
  - `pop-in` — opener → popout ("close yourself"); the popout calls `window.close()` (legal for a script-opened window) and emits `closed`.
  - `ping` — opener → popouts on opener mount, so live popouts re-announce immediately instead of the opener waiting a heartbeat.
- **Stale marks**: a mark whose popout sends no `opened`/`alive` within `POPOUT_STALE_MS` (6000) is cleared and the tile reflows back (covers a crashed popout / killed browser process where `pagehide` never fired). On opener mount with persisted marks, the marks apply immediately (no flash of the popped tile) and the `ping` + stale window settle them.
- Scope: localStorage and BroadcastChannel are per-origin per-browser-profile, so every opener tab of `@N` in the same browser hides the popped leaf — "this viewer" = this browser profile, consistent with every other per-viewer key (`rk-layout-sizes:*`, `rk-layout-zoom:*`).
- Pure functions (popped-set parse/serialize, `reduce`, stale-sweep given timestamps, message validation — a malformed or foreign-server message is ignored) are unit-testable without timers; the React hook wires the channel, timers and storage.

### 3. Opening a popout

- `window.open(url, name, features)` with `name = "rk-pop:{server}:{@N}:{leaf-id}"` so a repeat Pop out of the same leaf focuses/reuses the existing popout window rather than opening a second one; `features = "popup,width=<w>,height=<h>"` sized from the tile's current rendered rect (fallback 1200×800 when no rect).
- The mark is written **before** `window.open` returns control to the render (optimistic hide), and rolled back if `window.open` returns `null` (popup blocked) — with a toast "Pop-out blocked by the browser".
- Focused-tile handling: after pop-out the opener's focus falls back per the existing rule (first leaf in reading order of the rendered tree); a zoomed leaf that is popped clears the zoom for the render.

### 4. Verbs (Constitution V — every action palette-reachable)

- **Header `Pop out`** button in each tile's **content-verb family** (beside Follow/Reload / the pane segment, before the layout-verb cluster, separated by the existing hairline), with a new `PopOutGlyph` (box + ↗ arrow) in the same glyph set as `SendHomeGlyph`/`ZoomGlyph`. Tooltip/aria-label `Pop out <Surface>`.
- **Offered only when**: arity of the rendered tree > 1 (a single-tile tab gains nothing — open the tab's URL instead); fine pointer, non-mobile (mobile renders one tile); **not** in the desktop shell (`isShell()` from `lib/shell.ts` — see §6); the tile is live (not the away placeholder of change 4, not a dead-home foreign tile).
- **Palette** (`lib/palette/layout.ts`): `Tile: Pop Out <Surface>` per open, not-popped, pop-eligible leaf (foreign leaves disambiguate with the home window name, matching the existing `Tile: Bring <window> <Surface> here` convention), and `Tile: Pop Back In <Surface>` per popped leaf of this layout. The operator-compose e2e's exact palette-entry count must be updated if the default fixture's entry set changes (project memory: `operator-compose.spec`).
- **Pop back in** (opener palette, the popped-out placeholder button, or the popout's own header verb): send `pop-in`, clear the mark; the leaf reappears in the opener's render. Closing the popout window by any means (✕, `Cmd+W`) is equivalent.
- **Drag while popped**: header drag-to-snap resolves on the rendered tree, and committing that result would drop the popped leaf from the **shared** layout for every viewer. So while this viewer has any leaf of this layout popped, header drag and the ▦ template cycle are disabled (palette verbs, which address leaves by id, operate on the full shared tree and remain available). User decision at intake — Assumption 9.
- All other shared-layout mutations (add, close, promote, swap, send home, borrow) operate on the **full shared tree**, never on the viewer's reduced render.

### 5. Per surface kind

- **tty** — the popout's `TerminalClient` opens its relay stream with `isolate: true` (change 3 — the `_rk-iso-*` attach; `relay-mux.ts` already carries the wire key), targeting the leaf's home window (`leaf.home ?? @N`). The opener's hidden tty tile follows hide-never-unmount (stays mounted, hidden) as for any closed/zoomed-away tile. Acceptance: a popped-out terminal keeps showing its window while the opener switches to a sibling tab of the same session.
- **code** — the opener **evicts** its retained code frame for that window when the code leaf is popped (one extension host, not two — the ~250–320 MB-per-frame reason for the LRU); the popout mounts `CodeSurface` for the window's code root. Popping back in re-mounts in the opener (a fresh workbench boot is accepted).
- **web** — the popout mounts the iframe web engine; the page reloads in the new window (no state transfer). The native `WebContentsView` engine exists only in the desktop shell, which this change does not offer popout in.
- **gui** — the popout is a second RFB client (the Xvnc backend runs `-AlwaysShared`); the opener's hidden gui tile disconnects via the existing visibility-gated RFB connection. Under `gui.geometry: auto` the existing focused-fine-pointer-viewer-drives-SetDesktopSize rule applies unchanged (geometry authority follows focus). Only a bare `gui` leaf can exist (foreign `gui` is grammar-invalid).

### 6. Desktop shell — deferred to change 6

In the Electron shell, `window-open.ts` `windowOpenAction` sends every http(s) `window.open` to the **system browser**, where the popout would share neither localStorage nor the `BroadcastChannel` with the opener — the mark would go stale after 6 s and the tile would pop back while the popout still runs. So Pop out (header + palette) is not offered when `isShell()` is true; change 6 (`desktop-popout-windows`) adds the `shell:popout` channel and native reparent.

### 7. Tests

- **Vitest**: `lib/popout.test.ts` — popped-set parse/serialize incl. corrupt storage, `reduce` over bare/duplicate-tty/foreign leaves, the all-popped → placeholder case, ids absent from the tree pruned, stale sweep at the 6 s boundary, message validation (wrong server/window ignored); `lib/router-url.test.ts` — `pop` pass-through and the empty-string drop; `lib/palette/layout.test.ts` — Pop Out / Pop Back In rows and their eligibility (arity 1, shell, placeholder, dead home); RTL for the header `Pop out` presence rules and the popout chrome-less render.
- **e2e** (`app/frontend/tests/e2e/`, new `surface-popout.spec.ts` or an extension of `surface-layout.spec.ts`; Test Intent Comments on every `test()` and a file header, per the constitution): pop a tile out with `context.waitForEvent("page")` → the popout shows one chrome-less surface with the `<Surface> · <window>` title and the opener reflows; close the popout → the tile returns; palette `Tile: Pop Back In` closes the popout and restores the tile; a tty popout keeps its window while the opener switches to a sibling tab (isolation); a foreign (`@N/tty`) leaf pops out and titles with its home window. Scoped runs `just test-e2e <name>.spec`; also re-run `surface-layout.spec`, `operator-compose.spec` (palette count), and `control-gallery.spec` if header control classes change.
- **Gates**: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest — project memory); backend untouched unless a gap is found (then `env -u TMUX -u TMUX_PANE go test ./...` after `just _ensure-tmux-conf`).

### 8. Specs

- `docs/specs/surface-layout.md` § Verbs — add **Pop out** / **Pop back in** rows; § State — the per-viewer popped set beside sizes and zoom; Constitution Mapping line (II: popped set is viewer localStorage; IV: `?pop=` is a viewer param on the existing route).
- `docs/specs/ui-state.md` § Viewer Behaviour — popout is a per-viewer posture that never writes tab state; the `?pop=` param as the one live terminal-route search param beside `from`/`tab`.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Surface Layout — the popout posture, `lib/popout.ts`, the opener render reduction and popped-out placeholder, per-kind behaviour (tty isolate, code eviction, web reload, gui second client), drag/template disabled while popped; Design Decisions *Popout is a viewer posture, never a layout write*, *Popped leaves are keyed by leaf id*
- `run-kit/ui/routes-and-shell`: (modify) the terminal route's `?pop=` param (live, not translated away) and the chrome-less popout render branch in `AppLayout`
- `run-kit/ui/keyboard-and-palette`: (modify) `Tile: Pop Out <Surface>` / `Tile: Pop Back In <Surface>` palette entries and their eligibility

## Impact

- **Frontend (primary)**: `app/frontend/src/lib/popout.ts` (new) + test; `lib/router-url.ts` (+ test); `app.tsx` (`AppLayout` chrome-less branch, route-entry translation must keep `pop`, the popout render path, wiring the reduced tree into `SurfaceLayout`, pop-out/pop-in handlers); `components/surface-layout.tsx` (header `Pop out` verb, popped-out placeholder, drag/template disable while popped, code-frame eviction on pop, focus/zoom fallback); `components/top-bar-icons.tsx` or the glyph module holding `SendHomeGlyph` (new `PopOutGlyph`); `lib/palette/layout.ts` (+ test); `components/terminal-client.tsx` (already supports `isolate`); `lib/layout-tree.ts` (reuse `leafIds`, `removeLeaf`, `parseLeafAddress` — likely no change).
- **Backend**: none expected — iso sessions (`EnsureIsoSession`, `attachStream` pin → iso → home) shipped in change 3.
- **Desktop**: none (Pop out hidden in the shell; change 6 owns shell popouts).
- **e2e**: new popout spec; `surface-layout.spec.ts`, `operator-compose.spec.ts` (exact palette count), possibly `control-gallery.spec.ts` baselines if header control classes change.
- **Specs**: `docs/specs/surface-layout.md`, `docs/specs/ui-state.md`.
- **Constitution**: II (popped set = viewer localStorage; iso sessions tmux-derived), IV (no new route, no settings), V (every pop verb palette-registered), VI (popout sessions are tmux-side), Test Intent Comments.

## Open Questions

None — the three open design calls (drag while popped, palette in the popout, popout after its leaf leaves the shared layout) were asked and answered at intake; see Assumptions 9, 12, 14.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Popout is per viewer: the opener hides the popped leaf only in its own render via `rk-layout-popped:{server}:{@N}` localStorage; `@rk_win_layout` is never written by pop-out/pop-in | Plan decision of record; Constitution II/IV per-viewer state in localStorage; shared-write explicitly rejected | S:95 R:80 A:95 D:95 |
| 2 | Certain | Popout is a `?pop=` search param on the existing terminal route rendering one tile chrome-less — no new route | Plan decision of record; Constitution IV fixed route set; `/popout/...` route rejected | S:95 R:75 A:95 D:95 |
| 3 | Certain | A popped-out tty opens its relay stream with `isolate: true` (change 3's `_rk-iso-*` attach) on the leaf's home window | Plan decision of record; `relay-mux.ts`/`terminal-client.tsx` already carry `isolate` | S:95 R:85 A:95 D:95 |
| 4 | Certain | Coordination over a same-origin `BroadcastChannel("rk-popout")` with `opened`/`closed`/`pop-in` messages; `pagehide` + a heartbeat clear stale marks | Plan Change 5 items 2 verbatim | S:90 R:80 A:90 D:90 |
| 5 | Certain | Route URL uses the real segment form `/$server/N?pop=<leaf-id>` (no `@`), not the plan's `/$server/@N` shorthand | `lib/router-url.ts` strips `@` from the window segment; the plan's form is notation | S:70 R:85 A:90 D:85 |
| 6 | Confident | `pop` value and the popped-set key are `leafIds()` ids (`tty`, `tty#2`, `code`, `web`, `gui`, `@12/tty`) — the "leaf address" of the plan, extended to disambiguate duplicate bare tty tiles | Plan says key by leaf address, not kind; change 4 made duplicate bare tty legal, and `leafIds` is the existing stable-id function; a reading-order `tty#2` shift only swaps which identical terminal hides | S:70 R:80 A:80 D:70 |
| 7 | Confident | Pop out is not offered in the desktop shell (`isShell()`); change 6 owns shell popouts | `window-open.ts` routes http(s) `window.open` to the system browser, which shares no localStorage/BroadcastChannel, so marks would go stale and the tile would pop back | S:65 R:85 A:85 D:75 |
| 8 | Confident | Pop out offered only at rendered arity > 1, fine pointer, non-mobile, live tiles (never the away placeholder or a dead-home foreign tile) | Single-tile popout duplicates opening the tab URL; mobile renders one tile; a placeholder has no surface to pop | S:60 R:85 A:80 D:75 |
| 9 | Certain | While this viewer has a leaf of this layout popped, header drag-to-snap and the ▦ template cycle are disabled; palette verbs and add/close/swap/promote act on the full shared tree | Asked — user chose "disable drag" over re-inserting the popped leaf into the drop result or popping everything back in first; a drop resolved on the reduced tree would otherwise delete the popped leaf from every viewer's layout | S:95 R:70 A:90 D:90 |
| 10 | Confident | Heartbeat every 2000 ms, stale after 6000 ms without `opened`/`alive`; opener sends `ping` on mount and applies persisted marks immediately | Plan names pagehide + heartbeat without values; 3× interval is a conventional liveness margin, and ping avoids a 6 s wait after an opener reload | S:35 R:90 A:60 D:55 |
| 11 | Certain | Per-kind: code — opener evicts its retained frame on pop; web — iframe reloads in the popout; gui — second RFB client, opener's hidden tile disconnects via visibility gating, geometry authority unchanged | Plan Change 5 item 4; gui memory: `-AlwaysShared`, visibility gates RFB, `auto` follows the focused fine-pointer tile | S:80 R:80 A:85 D:80 |
| 12 | Certain | The popout renders no top bar, sidebar, bottom bar/compose strip, quake drawer, or command palette; the tile keeps its surface header with per-kind content verbs and a Pop back in verb replacing zoom/↩/✕ | Asked — user chose "no palette" over a scoped palette; Pop back in stays keyboard-reachable by closing the window (Cmd+W) and via the opener's palette `Tile: Pop Back In` | S:95 R:80 A:90 D:90 |
| 13 | Confident | When every rendered leaf is popped (e.g. another viewer closed the rest), the opener renders a popped-out placeholder with Pop back in rather than an empty layout | Change 4's "a layout never renders empty" rule; mirrors the away-placeholder pattern | S:40 R:85 A:65 D:55 |
| 14 | Certain | The popout keeps running while its surface's window lives even if the leaf leaves the shared layout (the stale mark is simply pruned); it shows an ended "Window closed" state when the window dies; it never navigates | Asked — user chose "keep running" over closing itself; the popout addresses the surface, not the layout | S:95 R:85 A:90 D:90 |
| 15 | Confident | `window.open` uses name `rk-pop:{server}:{@N}:{leaf-id}` (repeat pop-out reuses the window), `popup` features sized from the tile rect (fallback 1200×800); a `null` return rolls back the mark with a "Pop-out blocked" toast | Standard popup handling; prevents duplicate popouts of one leaf | S:55 R:90 A:75 D:70 |
| 16 | Certain | Popout title `<Surface> · <window name>`, using the home window's name for a foreign leaf | Plan Change 5 item 1; the foreign leaf's surface belongs to its home window | S:80 R:95 A:85 D:75 |
| 17 | Certain | No backend change: iso sessions and the relay's pin → iso → home pick shipped in change 3 | `tmux-sessions.md` documents `isolate: true` on `open` with borrowed and popped-out tiles named as consumers | S:75 R:80 A:85 D:85 |
| 18 | Certain | Specs amended: surface-layout.md § Verbs/§ State/Constitution Mapping, ui-state.md § Viewer Behaviour; memory: lenses-and-layout, routes-and-shell, keyboard-and-palette | Plan Change 5 item 6 names the specs; memory files map to the touched code areas | S:75 R:90 A:80 D:80 |
| 19 | Confident | The top-bar surface toggles get no "popped" marker in this change; a lit toggle for a popped leaf still closes it from the shared layout (an ordinary close), and the popout keeps running per #14 | Not covered by the plan; the popped state is visible from the popout itself and the palette's `Tile: Pop Back In` row; a marker is additive later | S:35 R:85 A:55 D:50 |

19 assumptions (12 certain, 7 confident, 0 tentative, 0 unresolved).
