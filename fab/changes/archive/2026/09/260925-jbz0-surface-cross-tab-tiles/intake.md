# Intake: Surface Cross-Tab Tiles

**Change**: 260925-jbz0-surface-cross-tab-tiles
**Created**: 2026-09-25

## Origin

> A tile can show any tab's surface on the same server, addressed as `@N/<surface>[/<n>]`. The surface is live in one place: its home slot shows a placeholder (bring back · go to · status · ✕) while it is borrowed, ✕ lets the remaining tiles fill the space and the surface toggle restores the slot, and a ↩ button on the borrowed tile sends it home. The tile count is limited only by a per-viewport size floor.

The request came through `/fab-new` and points at the plan `fab/plans/sahil/26-09-24-surface-drag-and-popout.md`: its **Change 4 — tiles from other tabs** (slug `surface-cross-tab-tiles`), **Standing context** and **Decisions of record** sections are authoritative input. The contract of record is `docs/wiki/surface-drop-zone-studies.html` §2 (grammar), §5 (size floor), §9 (generic verbs) and §10 (tiles from other tabs). Changes 1–3 are merged to main (`4175ac2e` layout tree #1035, `0c666e57` drag-to-snap #1036, `fbd81249` isolated terminal sessions #1038). This change builds on the drag resolver (`lib/layout-drop.ts`) and the isolated relay path (`isolate: true` → `_rk-iso-*`).

Seven questions were asked and answered at intake (2026-09-25):
1. **`web/<n>` scope → grammar only.** Both parsers accept the optional `/<n>` suffix, but only `@A/web` (A's single web surface, tab strip included) is a renderable, borrowable leaf in v1. A bare `web/<n>` or foreign `@A/web/<n>` is rejected by validation. Multiple web tiles per layout is a follow-up.
2. **Duplicate bare `tty` stays legal.** Existing stored `h(tty,tty)` layouts keep parsing. A repeated foreign address and a repeated non-tty kind are rejected. A foreign address naming the layout's own window is rejected too.
3. **Sidebar row drag extends the existing HTML5 row drag.** When a window-drag starts, the layout mounts a drop-catcher overlay and reuses `zoneAt`/`rootZoneAt`/`resolveDrop` plus the result-preview overlay. The tile-header drag stays on pointer events.
4. **Center-zone drop of an external leaf is a no-op.** Only edge zones insert.
5. **A generic layout write that adds an already-held foreign leaf is rejected** (4xx, use borrow). That covers the options endpoint and `rk tab layout`.
6. **Stored trees below the floor render as-is.** The floor gates only offers.
7. **Progress slots are per window.** A borrowed terminal's progress renders on its own tile.

## Why

1. **Problem.** A layout is capped at four tiles, one per surface kind (`tty`, `code`, `web`, `gui`), plus the `MAX_TILES = 3` cap. So you cannot watch two tabs' terminals side by side, or keep an agent's terminal next to the code tile of another worktree, without a board. Boards are a second, separate mechanism. The study (§10) replaced "pick which extra instance type to allow first" with "a tile may show any tab's surface". One address grammar, the one ui-state.md already defines, covers every future instance type.
2. **Consequence of not doing it.** The tree model (change 1) and drag (change 2) can't grow past three tiles, since there is nothing to put in a fourth or fifth slot except duplicate `tty`. Popout (change 5) needs leaves keyed by address, not kind. Boards stay a parallel renderer.
3. **Why this approach.**
   - **Move semantics** (a surface is live in exactly one place) avoid two viewers fighting over one terminal or running two ~300 MB code-server extension hosts for one workspace.
   - **Away state is derived** from the other tabs' layouts, which are already tmux state, so nothing new is stored (Constitution II).
   - Borrowing and returning each write one tab; only re-borrow and a ↩ that also restores a dismissed slot write two tabs, chained in one tmux invocation.
   - **Rejected:** tmux `join-pane`, which kills a single-pane home window, changes what plain-tmux users see, and needs a stored home. **Also rejected:** a hard tile cap, and extending presets.

## What Changes

### 1. Leaf grammar — `lib/layout-tree.ts` + `internal/layoutspec/layoutspec.go`

The grammar extends in both parsers, which must accept and reject identical inputs (study §2):

```
leaf  = kind [ "/" n ]                       this tab:     tty · code · web · gui   (web/<n> parses, rejected by validation in v1)
      | "@" N "/" kind [ "/" n ]             another tab:  @12/tty · @7/code · @7/web
split = dir "(" node "," node {"," node} ")"   dir ∈ h | v
```

- **Data type.** `LayoutLeaf` gains an optional home: `{ leaf: SurfaceKind; home?: string /* "@12" */; n?: number }`. A bare leaf has no `home`. `serializeLayoutTree` emits `@12/tty` for a foreign leaf. The Go `Node` mirrors this.
- **Leaf ids.** A foreign leaf's id is its address string (`@12/tty`), which validation keeps unique. Bare leaves keep today's `tty`, `tty#2`, … ids. `leafIds`, `pathOf`, `removeLeaf`, `swapLeaves` and `leafIdParts` (surface-layout.tsx:297) must all handle address ids. `leafIdParts` currently coerces an unknown kind to `tty`.
- **Validation** (`isCanonicalTree` / Go `isCanonicalTree`), on top of today's canonical-form rules. A tree is **rejected** when it has:
  - a foreign `gui` (`@N/gui`), since there is one desktop per host;
  - a repeated foreign address;
  - a repeated non-tty bare kind (unchanged);
  - a foreign leaf whose `@N` is the layout's own window (validation needs the owning window id as input; parse-time callers without one skip this rule, and the write paths enforce it);
  - any `/<n>` suffix in v1 (bare `web/<n>` and foreign `@A/web/<n>`);
  - a `-L srv` or `=session:` qualifier (same server only in v1).
- **Unchanged:** repeated bare `tty` stays legal.
- **Cap.** `MAX_TILES` / `MaxTiles` is removed as a tile cap (§8). `MAX_LAYOUT_LEN` / `MaxLayoutLen` (128) is the recursion-depth guard. It rises to accommodate address leaves (e.g. 512), keeping the "cap before parse" rationale in its doc comment. <!-- assumed: 512-byte cap — ~7-11 chars per foreign leaf; 128 would cap a tree near 8–10 foreign tiles -->
- Legacy `shape:a,b,c` strings stay bare-kind only.
- **Tests.**
  - Vitest over the grammar, validation and serialization round-trip, including foreign leaves in the exhaustive N ≤ 4 fixture invariants where applicable.
  - Go table tests mirroring the same accept/reject corpus.
  - A shared fixture is preferred, in the style of `layout-tree.fixtures.json`.

### 2. Away derivation — server-side, in the existing session payload

- The SSE/session payload already carries every window's `layout` (`tmux.WindowInfo.Layout`, tmux.go:947, `json:"layout"`; frontend `WindowInfo.layout?` types.ts:220).
- **New field.** After listing a server's windows, the backend derives per-window `awayIn` as `WindowInfo.AwayIn map[string]string json:"awayIn,omitempty"`, surface kind → holder window id:
  - For every window W whose parsed layout holds a foreign leaf `@A/<kind>` where window A exists on this server, set `A.awayIn[kind] = W.id`.
  - Leaves naming dead windows are ignored.
  - If two holders somehow hold the same address (a hand-written race), the first in list order wins deterministically and the rest are treated as stale.
- Mirror the field in `types.ts` `WindowInfo` and `lib/window-view.ts` `ViewWindow` as needed.
- **Tests.** A Go unit test for the derivation, covering dead-window pruning and the duplicate-holder tie-break.

### 3. Borrow — drag a sidebar row onto a tile zone, or palette `Tile: Bring … here`

- **Row drag.** Sidebar rows already use native HTML5 DnD: `draggable` + `onDragStart` (window-row.tsx:720-737), `handleDragStart` in sidebar/index.tsx:810-824 setting `WINDOW_DRAG_MIME = "application/x-window-drag"` (boards-section.tsx:16) with `{server, session, index, windowId, name}`, and `effectAllowed="copyMove"`. Its consumers stay untouched: reorder (`moveWindow`), move to session (`moveWindowToSession`), and pin to board.
- **Drop-catcher overlay.** While a window-drag is in flight, `SurfaceLayout` mounts a transparent overlay above the tiles:
  - Tiles go `pointer-events-none` and the native `WebContentsView` hides, reusing the mid-drag seam.
  - The overlay handles `dragover`/`drop`, hit-tests with the snapshot leaf rects via `zoneAt`/`rootZoneAt`, and shows the same result-preview overlay, including red "too small" and neutral "no change".
- **External leaf in the resolver.** `resolveDrop` returns `cancel` for an id not in the tree (layout-drop.ts:250-251), and `hitTest` (:142) assumes the same. Both are extended to accept an **external leaf being inserted**. The generic edit becomes "wrap target with placeholder → (remove dragged if present) → replace placeholder with the new leaf → normalise". Tile-edge and layout-edge zones insert the new leaf beside the target or spanning a side. Center on an external drag is a no-op zone ("no change"). (decided at intake)
- **Which surface.** A row drag borrows the dragged tab's **`tty`** (`@A/tty`).
- **Refused drops (preview shows "no change").**
  - Dropping the route window's own row.
  - Dropping a tab whose `tty` is already in this layout.
  - A cross-server drag (the row's `server` ≠ route server).
- **Palette `Tile: Bring … here`.** This is the keyboard route. It lists other windows on this server, and within each its `tty`, `code` and `web`: surfaces that are available and not already in this layout, excluding `gui`. It inserts by the generic add rule (§8). Entry wording: `Tile: Bring <window> <Surface> here`, generated per candidate, gated when the add rule has no room. <!-- assumed: flat per-candidate palette rows (like `Tile: Show <S>`) rather than a sub-picker; window count bounds the list -->
- **Write path.**
  - If the address is **not held** elsewhere (A's `awayIn[kind]` absent, or held by the route window itself), the borrow is an ordinary single write of the target tab's `@rk_win_layout` through `applyLayout` (app.tsx:1314-1330, `POST /api/windows/{windowId}/options`).
  - If it **is held** by another tab C, the borrow goes through the new **`POST /api/layout/borrow`** with body `{ to: "@B", leaf: "@A/tty", tree: "<B's new tree>" }` (server via the existing `?server=` convention). The handler:
    - validates both trees;
    - computes C's tree minus the leaf, normalised, falling back to C's own `tty` when it empties;
    - writes C and B in **one `;`-chained tmux invocation** (the `SetWindowOptions`/`appendOptionOps` chaining in tmux.go:2872-2902 and the `MoveWindow` pattern).
  - POST only (Constitution IX). All argv is explicit and ctx-timeout-scoped (Constitution I).
- **"Live in one place" on every layout write.** The options handler (api/windows.go:524-532, which runs `layoutspec.Parse` today) also rejects a layout that adds a foreign leaf already held by a third tab, and tells the caller to use borrow. The check lives in one Go helper used by both handlers and by `rk tab layout` (decided at intake: reject, never silently steal).

### 4. Return — placeholder bring back · ↩ on the borrowed tile · palette `Tile: Send Back to @N`

- **Where it starts.**
  - **↩** sits in the tile header verb cluster (surface-layout.tsx:2939-2972, beside Expand/Close). It shows only on foreign leaves, where the leaf's home ≠ the route window.
  - **Bring back** is on A's placeholder.
  - The palette entry is `Tile: Send Back to <home window>` for the focused foreign tile, plus bring back from the placeholder's tab.
- **Effect.** A return removes `@A/<kind>` from the holder B, normalised; if B empties it falls back to B's own `tty`, because a layout never empties. If A's layout no longer has a `<kind>` slot (the placeholder was dismissed), the return also re-adds `<kind>` to A by the generic add rule. The two writes are chained through **`POST /api/layout/return`** with body `{ from: "@B", leaf: "@A/tty" }`, so the server recomputes both trees. <!-- assumed: separate return endpoint rather than overloading borrow; the server recomputes both trees from current tmux state so a stale client cannot clobber -->
- **Single write.** When A still has its slot, the return is a single write of B's layout. The endpoint is still fine to use for uniformity.
- Go uses `layoutspec.Add` for the re-add, with nominal geometry (`nominalBox`).

### 5. Placeholder — home slot of an away surface

- **When it renders.** In tab A, a **bare** leaf `<kind>` whose `A.awayIn[kind]` names a live holder renders a placeholder instead of the surface.
- **Content** (study §10 mock):
  - "Terminal is in tab `<B name>`" (surface label per kind);
  - **bring back** (the return, §4);
  - **go to `<B>`** (navigate to B's route);
  - the surface's **status dot** (the tty status for A's window, as the sidebar row shows it);
  - **✕**.
- **Layout and mount.** The placeholder fills the tab when it is the only leaf. A's real surface is **not** mounted while away, so for tty no second relay stream competes.
- **✕** removes the slot: `closeSurface` on that leaf, then `applyLayout`. The remaining tiles fill the space. If it was the only tile, the tab falls back to its own `tty`, which renders as the placeholder again while away. <!-- assumed: dismissing the last placeholder is a no-op-equivalent (fallback tty = the same placeholder) — ✕ is hidden/disabled when the placeholder is the sole leaf -->
- **Top-bar toggle** (`SurfaceToggleGroup`, top-bar.tsx:481; wired at app.tsx:5466-5485; `togglePanel` app.tsx:1351-1366):
  - Toggling `<kind>` on re-adds the slot, which renders as the placeholder while away.
  - The toggle shows an **"away" marker** when `awayIn[kind]` is set, so the state is visible from the top bar.
  - The hardcoded `open.length >= 3` disable (top-bar.tsx:486) is replaced by the size-floor check (§8).
- **Sidebar row click** lands on the tab and its placeholder (decided; plain navigation, no special-casing).
- **Mobile** stays one tile: slot A renders the placeholder if it is away.

### 6. Dead addresses

- **At read time**, the client prunes foreign leaves whose window is not in the server's window set: `removeLeaf`, then normalise, then the tty fallback if empty. The next write persists the pruned tree; there is no background writer.
- The backend derivation ignores them (§2).
- **↩ is disabled** for a foreign leaf whose home window is gone during the window between kill and the next payload. Rendering then prunes it.

### 7. Route-window assumptions follow the tile's own window

Today `SurfaceLayout` receives one `windowId` (the URL `@N`, app.tsx:5741-5759) and every per-tile action uses it. For a foreign leaf, the tile's window is its **home** window, resolved from the server's full window list (the payload already has it; app.tsx:1218-1224 builds `codeWindowsById` from all sessions). Audit and fix each site:

- **Relay stream.** Tty tiles get `windowId={windowId}` (surface-layout.tsx:2237-2246), and terminal-client.tsx:1370 calls `relayMux.openStream({server, windowId, cols, rows})`. A foreign tty passes its home window id **and `isolate: true`**:
  - `OpenStreamOpts` (relay-mux.ts:48-53) gains `isolate?: boolean`;
  - `sendOpen` (relay-mux.ts:543-551) forwards it;
  - the backend already accepts `Isolate bool json:"isolate,omitempty"` (terminals_ws.go:151/166/449) with pick order pin → iso → home.
  - Home-tab tty streams stay non-isolated.
- **Shared `wsRef`/`focusRef` holder.** These go only to the first tty leaf (`primaryTty`, surface-layout.tsx:2244-2248; dummy `extraTtyWsRef` :763-766). Focus registration is `setFocused({wsRef, containerRef, server, session, windowId})` (terminal-client.tsx:367-368, gated `registerFocus={primaryTty}` :2254).
  - The focused tty (bare or foreign) must register its **own** window/session, so compose and bottom-bar follow the focused tile.
  - `primaryTty` is the first **bare** tty; a foreign tty registers on focus.
- **Compose strip.**
  - Send target: `sendToWindow(focused.server, focused.windowId, …)` (compose-strip.tsx:721/750) follows the focused terminal, so it is correct once focus registration carries the foreign window.
  - `focusMemoryWindow={server, windowId: windowParam}` (app.tsx:4150, compose-strip.tsx:1148-1150) and `inTileDock` (app.tsx:4127-4132) must treat a foreign tty as a terminal tile.
- **Bottom-bar keys.** They use `focused?.wsRef` (bottom-bar.tsx:90, :169-170, :291-292), which follows focus registration.
- **Tty tile Split / Close Pane.** Today `executeSplit(server, windowParam, …)` / `executeClosePane(server, windowParam)` (app.tsx:5846-5849; buttons surface-layout.tsx:2856-2893). These must use the tile's window id and that window's `worktreePath`.
- **Progress slot.** One slot per window (surface-layout.tsx:1332-1345 `handleTtyProgress`, chip :2650, line :3033). A foreign tty must not feed the route window's slot. Decided at intake: progress slots are keyed per window, and a foreign tty's progress chip and line render on its own tile; B's route slot stays B's own.
- **Focus memory, zoom, sizes and tile keys.**
  - Focus memory (`focusMemoryKey(server, windowId)` :757) and zoom (:1268/:1289/:1300) key by **leaf id**, which is now the address for foreign leaves. Zoom's memory DD "Zoom key stores a surface kind" changes to leaf id.
  - Sizes stay keyed by route window + structure signature.
  - Tile keys (`${kind}${suffix}:${windowId}`, :2569-2578) use the home window id for foreign leaves.
- **Code tile.**
  - `codeSrcFor?.(windowId)` (:1019) and `codeRootFor(win)` (:1020) use the home window's `WindowInfo`.
  - Frame records are keyed by the home window id (:1034-1037, :2316-2345), so the code-frame LRU cap (per-server 3/1) is unchanged and a borrowed code tile reuses A's retained frame when one exists.
  - The `@rk_win_code_root` seed/follow writes (app.tsx:1172-1193, :1266-1305) and `useCodeWorkspace(server, windowParam, …)` (:1229) target the tile's window for foreign code. `codeRootForWindow` / `fetchBridgeStatusFor` are already per-window (:1246-1257).
- **Web tile.**
  - It reads `win.webTabs` / `win.webActive` (surface-layout.tsx:2268-2269).
  - It writes through `setWindowOptions(server, windowId, {"@rk_win_web_<n>": url})` (:2279) and `addWebTab`/`selectWebTab`/`removeWebTab`/`moveWebTab` (:2142-2167, :2298), with the optimistic `webOverride` keyed `entryKey(server, windowId)` (:2121-2216).
  - All of these use the home window for `@A/web`. The borrowed web tile edits A's web tabs.

### 8. Size floor replaces the tile cap

- The floor already exists for drops: `MIN_TILE_W = 150`, `MIN_TILE_H = 100` in `lib/layout-drop.ts:63-66` (result "too-small", :303). It now also gates:
  - **Add** (`addSurface`, lib/surface-layout.ts:356-362). Today this checks `kinds.length >= MAX_TILES`. It becomes: split the focused tile along its longer axis; if the result breaks the floor in this viewer's measured box, split the largest tile; refuse only when no split fits. Callers without measured rects (mobile, CLI) use `NOMINAL_BOX`.
  - **Templates**: a `Layout: <Template>` result under the floor is not offered.
  - **The top-bar toggle and palette `Tile: Show <S>`** (palette/layout.ts:154 `tileCount < MAX_TILES`), and `Tile: Bring … here`.
- **Go side.** Go has no viewport. `layoutspec.Add` (layoutspec.go:693-698) and `Parse` (:176/:186) drop `MaxTiles`; the byte cap bounds size.
- **Oversized stored trees.** A tree written by a wider viewer or the CLI renders as-is on a smaller viewport; the floor gates only offers, never degrades a stored tree. Mobile stays one tile (existing degrade). (decided at intake)
- **Code frames.** The code-frame LRU cap stays.

### 9. Tests

- **Vitest:**
  - grammar, validation and serialization (§1);
  - `resolveDrop` with an external leaf (§3);
  - the add rule under the floor (§8);
  - dead-address pruning (§6);
  - palette entries for Bring/Send Back;
  - RTL for the placeholder (bring back / go to / ✕ / status dot) and ↩ visibility (foreign only).
- **Go:**
  - layoutspec corpus;
  - `awayIn` derivation;
  - `POST /api/layout/borrow` and `/return`: validation, chained two-window write on an `-L` server under `env -u TMUX -u TMUX_PANE` (project memory), and the tty fallback on empty;
  - the options handler's holder check.
- **e2e** (new spec, e.g. `tests/e2e/cross-tab-tiles.spec.ts`; scoped runs via `just test-e2e cross-tab-tiles.spec`), with Test Intent Comments on every `test()` and a file header:
  1. borrow A's terminal into B by dragging A's sidebar row onto a tile edge;
  2. type in it; the output lands in A's window;
  3. visit A: the placeholder is shown;
  4. ✕ it: web fills;
  5. toggle `tty` on: the placeholder is back, with the away marker;
  6. bring back;
  7. borrow again, ↩ from B;
  8. kill A while borrowed: B prunes the tile.
- **Also re-run:** `surface-layout.spec.ts`, `right-panel.spec.ts`, `code-surface.spec.ts`, `web-view-lens.spec.ts`, and `operator-compose.spec.ts` (its exact palette-entry count; project memory). Also `control-gallery.spec.ts` if header controls change classes. Use a regex `page.route` because of the `?server=` suffix (project memory).

### 10. Specs and memory (docs)

- **Spec amendments** (study §10, "Spec amendments this implies"):
  - **surface-layout.md:** § One tile per surface kind (v1) becomes tiles from other tabs + move semantics; § Verbs gets ↩, bring back and the size floor; the Constitution Mapping ≤3-tile line becomes size floor; the "fourth surface is the signal to use a board" note; § Boards convergence (a board is a named layout whose tiles all point at other tabs).
  - **ui-state.md:** § Layout in tmux (foreign leaves in the encoding) + § Addressing Grammar (a layout tile uses it; v1 same-server, no `/<n>`); record the sidebar row click behaviour (plan open question 1).
- Memory is hydrated per Affected Memory below.

**Out of scope:** popout (change 5); desktop shell popout windows (change 6); multi-web-tile `web/<n>` leaves; cross-server (`-L`) addresses; migrating boards onto the tree; tab-to-tab drag (only one tab renders at a time).

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) Surface Layout — foreign leaves and address ids, placeholder, ↩/bring back, size floor replacing `MAX_TILES`, external-leaf drop, route-window follow-the-tile. Design Decisions: *A surface is live in one place*, *Away is derived, not stored*, *Row drag reuses the HTML5 window-drag*; "Zoom key stores a surface kind" → leaf id
- `run-kit/ui/sidebar`: (modify) window-row drag gains a drop target in the layout (borrow); click lands on the placeholder
- `run-kit/ui/top-bar`: (modify) surface toggle away marker; the 3-tile disable becomes the size floor
- `run-kit/ui/keyboard-and-palette`: (modify) `Tile: Bring … here`, `Tile: Send Back to …`; floor-gated Show/Template entries
- `run-kit/ui/compose-and-bottom-bar`: (modify) targets follow the focused tile's window (foreign tty)
- `run-kit/ui/terminal`: (modify) `RelayMux.openStream` `isolate` option; foreign tty streams isolate
- `run-kit/api-and-sockets`: (modify) `POST /api/layout/borrow`, `POST /api/layout/return`, `WindowInfo.awayIn`, the options handler's holder check
- `run-kit/architecture/cli`: (modify) `rk tab layout` accepts foreign leaves; no tile cap

## Impact

- **Frontend:**
  - `lib/layout-tree.ts` (+ test, fixtures), `lib/layout-drop.ts` (+ test), `lib/surface-layout.ts` (+ test), `lib/palette/layout.ts` (+ test);
  - `components/surface-layout.tsx` (placeholder, ↩, drop-catcher, per-tile window plumbing), `app.tsx` (applyLayout/borrow/return wiring, toggle, split/close pane), `components/top-bar.tsx`, `components/sidebar/index.tsx` + `window-row.tsx` (drag payload reuse only), `compose-strip.tsx`, `bottom-bar.tsx`, `terminal-client.tsx`, `lib/relay-mux.ts`, `types.ts`, `lib/window-view.ts`.
- **Backend:** `internal/layoutspec/layoutspec.go` (+ test); `internal/tmux/tmux.go` (`WindowInfo.AwayIn`, derivation, chained two-window option write); `api/windows.go` (holder check); new borrow/return handlers + `api/router.go` routes; `cmd/rk/tab_layout.go`, `tab_web.go` (MaxTiles removal).
- **Desktop:** none, beyond the existing native-view hide seam reused during the row drag.
- **Risk areas:**
  - HTML5 dragover over iframes: the catcher overlay must sit above them.
  - Focus-registration refactor touching compose/bottom-bar.
  - Grammar parity between TS and Go.
  - Resource use at larger N (relay streams + code frames; the HTTP/1.1 six-connection note in surface-layout.md § Performance).
- **Verification:**
  - `cd app/frontend && npx tsc --noEmit` and `just test-frontend` (full Vitest);
  - scoped `just test-e2e <name>.spec`;
  - backend `just _ensure-tmux-conf` then `env -u TMUX -u TMUX_PANE go test ./...`;
  - `pnpm install --frozen-lockfile` first in a fresh worktree.

## Open Questions

- Should the placeholder's "go to" and bring back also exist for `code`/`web` placeholders in identical form? Assumed yes: the generic surface label varies, the verbs do not.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Leaves are a bare kind or `@N/<surface>[/<n>]`, same server only; foreign `gui` rejected | Decisions of record (plan) + study §2/§10 | S:95 R:70 A:95 D:95 |
| 2 | Certain | Move semantics: live in one place; home slot renders a placeholder (bring back · go to · status · ✕); away derived, not stored | Decisions of record 2026-09-25 | S:95 R:65 A:95 D:95 |
| 3 | Certain | ✕ removes the slot; the top-bar toggle re-adds it (placeholder while away) with an away marker | Decisions of record + plan item 4 | S:90 R:80 A:90 D:90 |
| 4 | Certain | ↩ on foreign tiles only; returning re-adds a dismissed slot via the generic add rule, chained in one tmux invocation | Decisions of record + study §10 | S:90 R:70 A:90 D:90 |
| 5 | Certain | Borrowed tty streams open with `isolate: true` (change 3's iso path); home-tab streams unchanged | Plan item 7; backend already accepts the field | S:95 R:85 A:95 D:95 |
| 6 | Certain | Size floor 150×100 px per viewport replaces MAX_TILES for adds/drops/templates; code-frame LRU cap stays; mobile one tile | Plan item 8 + existing MIN_TILE_W/H in layout-drop.ts | S:90 R:75 A:90 D:90 |
| 7 | Certain | Sidebar row click lands on the tab and its placeholder | Decided 2026-09-25 (D12) | S:95 R:90 A:95 D:95 |
| 8 | Certain | `web/<n>` is grammar-only in v1: parses, rejected by validation; borrow uses `@A/web` | Asked — user chose grammar only | S:95 R:75 A:90 D:95 |
| 9 | Certain | Repeated bare `tty` stays legal; repeated foreign address, repeated non-tty kind, and self-window address rejected | Asked — user chose to keep bare-tty dups | S:95 R:75 A:90 D:95 |
| 10 | Certain | Row-to-tile borrow extends the existing HTML5 window-drag with a drop-catcher overlay reusing zoneAt/resolveDrop/preview; header drag stays pointer-based | Asked — user chose extend HTML5 drag | S:95 R:70 A:85 D:90 |
| 11 | Confident | Away state derived server-side as `WindowInfo.awayIn` (kind → holder window id) in the existing payload | Plan item 4 says server-side; Go needs the same derivation for write validation | S:80 R:70 A:80 D:70 |
| 12 | Confident | Re-borrow from a third holder goes through `POST /api/layout/borrow {to, leaf, tree}`, chained two-window write | Plan item 2 names the endpoint + body; Constitution IX POST | S:85 R:70 A:80 D:75 |
| 13 | Confident | A row drag borrows the dragged tab's `tty` | Study §4/§10 examples borrow terminals; rows are tabs whose primary surface is tty | S:70 R:85 A:75 D:70 |
| 14 | Confident | Foreign leaf id = its address string; focus memory/zoom key by leaf id; tile/frame keys use the home window id | Study §10 "popped set, zoom and focus key by the tile's address"; validation keeps addresses unique | S:75 R:75 A:80 D:75 |
| 15 | Confident | Dead addresses pruned client-side at read; the next write persists; ↩ disabled for a dead home | Plan item 5 + study §10 | S:80 R:85 A:80 D:75 |
| 16 | Confident | Compose, bottom-bar, split/close pane, code and web writes follow the focused/owning tile's window via focus registration carrying the foreign window | Plan item 6 + audit file:line map | S:85 R:70 A:75 D:75 |
| 17 | Tentative | Separate `POST /api/layout/return {from, leaf}` with the server recomputing both trees | Plan describes return semantics but names no endpoint; server-side recompute avoids stale-client clobber | S:55 R:70 A:60 D:50 |
| 18 | Certain | The generic options write (and CLI) rejects a foreign leaf already held by a third tab (4xx, pointing to borrow) | Asked — user chose reject over silent steal / derive-winner | S:95 R:75 A:90 D:90 |
| 19 | Certain | Center-zone drop of an external leaf is a no-op ("no change"); only edge zones insert | Asked — user chose no-op over replace-target | S:95 R:85 A:90 D:90 |
| 20 | Tentative | `Tile: Bring <window> <Surface> here` as flat per-candidate palette rows | Matches `Tile: Show <S>`; no sub-picker precedent checked | S:45 R:85 A:55 D:50 |
| 21 | Certain | Stored trees over the floor render as-is; the floor gates only offers (add/drop/template) | Asked — user chose render as-is over per-viewer degrade | S:95 R:85 A:90 D:90 |
| 22 | Tentative | `MAX_LAYOUT_LEN` / `MaxLayoutLen` raised to 512 bytes | 128 bytes caps foreign-leaf trees near 8–10 tiles; the depth-guard rationale is unchanged | S:40 R:90 A:65 D:55 |
| 23 | Certain | Progress slots are per window: a foreign tty's progress renders on its own tile; the route slot stays the route window's | Asked — user chose own-tile over skip | S:95 R:85 A:90 D:90 |
| 24 | Tentative | ✕ hidden or disabled when the placeholder is the sole leaf (its fallback is the same placeholder) | Derived from "a layout never empties"; UX detail not in the study | S:45 R:90 A:60 D:55 |

24 assumptions (14 certain, 6 confident, 4 tentative, 0 unresolved).
