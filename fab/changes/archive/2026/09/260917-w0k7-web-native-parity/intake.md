# Intake: Web Native Engine Parity

**Change**: 260917-w0k7-web-native-parity
**Created**: 2026-09-17

## Origin

One-shot `/fab-new` invocation, change 4 of 6 in the plan `fab/plans/sahil/26-09-16-web-tile-native-browser.md` (§ Change 4 — parity, items 1–9; § Standing context; § Decisions of record; § Spike verdict → "Adjustments to changes 1–5" → Change 4). The user asked for the full lane and for the pipeline to run through `/fab-fff` to a PR.

> The native engine reaches parity with the iframe engine and passes it — real back/forward with a boundary signal, find with match ordinals through the shared find bar, zoom via the renderer, chord reclaim through before-input-event, Escape returns focus, error copy from Chromium's error codes, and a new Web: Inspect page palette entry.
>
> Full context lives in fab/plans/sahil/26-09-16-web-tile-native-browser.md — read the whole file before starting, especially "## Change 4 — parity" (the numbered items 1-9), "## Standing context" and "## Decisions of record", and the "## Spike verdict" section — the verdict's "Adjustments to changes 1-5" bullet for "Change 4" says: history/find/errors/devtools unchanged from the plan seed, BUT zoom needs web:zoom on every did-navigate AND on zoom-changed (SPA steps the bucket, sends the factor), chords need the focus hop on every relayed chord as a rule (not an Escape special case), and Tips over the tile's own header verbs should flip upward instead of clipping the guest (clipping reserved for overlays that straddle the content rect). Change 3f (already merged) deliberately shipped history:false and zoomGestures:false as placeholders for this change to wire up — check components/web-frame-native.tsx, lib/shell.ts, and app/desktop/src/main.ts (the guest-relay fix from PR #1014 is already merged there) before starting. This is change 4 of 6 in the plan — full lane.

**Key inputs carried from the plan** (decisions of record, binding here):

- Two engines behind one chrome; the `iframe` engine is never removed; the chrome renders per `supports.*` flags, never per origin.
- Zoom source of truth: the SPA's localStorage buckets are authoritative across both engines; the native engine re-applies the factor on **every `did-navigate`** (Chromium's per-host zoom store inside the `persist:rk-web` partition fights it across hosts and leaks between views); `zoom-changed` from ctrl+wheel is relayed as a bucket **step**, never applied by main.
- Chords: the focus hop (`hostContents.focus()`) on **every relayed chord** is a rule, not an Escape special case — without it the SPA shows a focused palette input while OS focus stays in the guest.
- Tips over the tile's own header verbs flip **upward** instead of clipping the guest; clipping is reserved for overlays that straddle the content rect (none are added here).
- Spike-measured: chord forwarding via `before-input-event` works from inside GitHub (Ctrl+K palette, Ctrl+F find, Ctrl+L address, Escape) with plain typing untouched.
- Downloads: no `will-download` handler is registered — Electron's default flow applies; popups stay external via the shipped app-level `setWindowOpenHandler`; popup-to-tab is recorded as a follow-up idea, not built.

## Why

Change 3f (`260916-q2xk`, PR #1015) mounted the native engine in the desktop shell but deliberately shipped it **below** the iframe engine's feature set: `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES` is `{history: false, find: false, meta: true, zoomGestures: false, devtools: false}`, the handle's `back`/`forward`/`find`/`stopFind` are no-ops, the `failed` relay only ends the load (no `TileError`), the `zoom` relay is ignored, and the `zoom` prop is accepted and unapplied. A viewer who gets the native engine by default (bridge present, opt-out not set) therefore loses back/forward buttons, sees the find bar disabled with a misleading "page is cross-origin — find unavailable" hint, gets a zoom control that changes a number but not the page, cannot open the palette with ⌘K while the guest holds focus (the reclaim mechanism is iframe-only — a keydown inside a `WebContentsView` never reaches the SPA's document), and sees a dead page with no error copy when a site is unreachable or a proxied port dies.

If this is not fixed, the native engine is a regression behind a default-on flag and the per-viewer opt-out becomes the real default. The plan's whole premise — Chromium's renderer for sites that refuse embedding, with the same chrome — only pays off once the chrome's every control works on both engines, and passes the iframe engine where Chromium can do more (find inside cross-origin pages, a real history boundary signal, DevTools).

Why this shape: every capability lands as a `web:*` IPC channel gated exactly like the six shipped ones (`isHostsSender` → host view → validator → tabKey membership), plus a relayed event on the single `web:event` channel, consumed by the engine behind the unchanged `WebFrameEngine` contract — the chrome, the FindBar, the zoom control and the error surface are not redesigned. The chord table is derived from the **same** registry predicate the iframe engine uses (`hasReclaimableMatch` under kind `"web"`), so both engines reclaim the same chords and a user rebind moves both.

## What Changes

All coordinates, gates and naming follow the shipped 3d/3f code. New channels join the `web` bridge group; new event kinds join the `web:event` relay table. Nothing in the backend changes.

### 1. History — real back/forward with a boundary signal

**Desktop (`app/desktop/src/main.ts`)**: two new handlers in `registerIpcHandlers`, sharing the six-channel error ladder (`Not allowed` → `No host view` → `Invalid request` → `Unknown tab`) and the `parseWebTabKeyPayload` validator:

```ts
ipcMain.handle("web:back", …)     // guest.handle.webContents.navigationHistory.goBack()   — no-op when !canGoBack()
ipcMain.handle("web:forward", …)  // guest.handle.webContents.navigationHistory.goForward() — no-op when !canGoForward()
```

The existing `url` relay already carries `canGoBack`/`canGoForward` on every `did-navigate` and `did-navigate-in-page` (3d); nothing changes there except the `httpStatus` addition in § 5.

**Preload (`app/desktop/src/preload.ts`)** `web` group gains `back(tabKey)`, `forward(tabKey)`.

**SPA (`lib/shell.ts`)**: `ShellWebBridge` gains `back`, `forward` (and every other invoker below); `isWebBridge` requires the widened set — the group ships whole per shell release, so a pre-parity shell fails the narrowing and the chrome falls back to the iframe engine (an honest degrade: a shell that cannot deliver parity must not select an engine that would show controls it cannot drive). New invokers `goBackShellWebView(tabKey)` / `goForwardShellWebView(tabKey)` in the existing never-throws `Promise<boolean>` shape.

**Engine (`components/web-frame-native.tsx`)**: `supports.history = true`; the handle's `back`/`forward` call the invokers. The chrome (`iframe-window.tsx`) already renders ◀ ▶ when `supports.history` and disables at the boundary from `canGoBack`/`canGoForward` — unchanged.

### 2. Find — match ordinals through the shared FindBar

**Desktop**: handlers

```ts
ipcMain.handle("web:find", …)       // payload {tabKey, text, forward, findNext} → webContents.findInPage(text, {forward, findNext})
ipcMain.handle("web:stop-find", …)  // payload {tabKey} → webContents.stopFindInPage("clearSelection")
```

with a new validator `parseWebFindPayload` (`text` a non-empty string ≤ 1024 chars — `WEB_FIND_TEXT_MAX_LENGTH`; `forward`/`findNext` booleans). `wireGuestRelay` gains

```ts
contents.on("found-in-page", (_event, result) =>
  relay("find", { active: result.activeMatchOrdinal, total: result.matches, final: result.finalUpdate }));
```

**SPA**: `ShellWebEvent` gains `{ kind: "find"; active: number; total: number; final: boolean }` (parsed structurally in `parseShellWebEvent`, malformed → dropped like every kind). Invokers `findShellWebView(tabKey, text, {forward, findNext})`, `stopFindShellWebView(tabKey)`.

**Engine**: `supports.find = true`. Handle `find(query, opts)` → `findShellWebView`; `stopFind` → `stopFindShellWebView` and resets the engine's `find` state to `null`. `find` relay → `find: { active: Math.max(0, active - 1), total }` (Chromium's `activeMatchOrdinal` is 1-based; FindBar's `matchIndex` is 0-based; `total === 0` ⇒ `{active: 0, total: 0}` so the bar reads `0/0`). Every completed load (`loading: false` edge) resets `find` to `null` — the iframe engine's per-load reset, mirrored. The chrome's existing `findOpen`/`findQuery` effect already calls `handle.find(query, {forward: true, findNext: false})` on query change and `handle.stopFind()` on close; the `FindBar` UI is unchanged; the cross-origin `statusText` hint never renders on the native engine because `supports.find` is `true`.

### 3. Zoom — via the renderer, re-applied on every navigation

**Desktop**: handler

```ts
ipcMain.handle("web:zoom", …)  // payload {tabKey, factor} → webContents.setZoomFactor(factor)
```

validator `parseWebZoomPayload`: `factor` a finite number within `[0.25, 5]` (`WEB_ZOOM_FACTOR_MIN`/`MAX` — the SPA's own ladder is `WEB_ZOOM_MIN`…`WEB_ZOOM_MAX` in `lib/web-zoom.ts`; the main-side band is a sanity clamp, not the ladder). The `zoom-changed` relay is unchanged (direction only, never applied — 3d).

**SPA**: invoker `setShellWebViewZoom(tabKey, factor)`. `WebFrameEngineProps` gains an optional `onZoomStep?: (direction: "in" | "out") => void` — the chrome passes its existing `applyZoom` (which steps the bucket and persists via `writeWebZoom`); the iframe engine ignores the prop (its ctrl-wheel path is the in-document gesture arm).

**Engine**: `supports.zoomGestures = true` (the guest handles ctrl+wheel itself; the relay steps the bucket). Send `web:zoom {factor: zoom}`: (a) after create, (b) whenever the `zoom` prop changes, (c) on **every** `url` relay event (`did-navigate` and `did-navigate-in-page` — the re-apply rule; in-page re-apply is a harmless idempotent set). `zoom` relay (`direction`) → `onZoomStep?.(direction)`; the stepped `zoom` prop then flows back and triggers (b). The engine renders no scale wrapper — the placeholder stays a plain div (3f).

### 4. Chords — reclaim through `before-input-event`

**SPA — `lib/web-chord-table.ts` (new, pure, Vitest)**:

```ts
export interface WebChordSpec { code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: false }
export function buildWebChordTable(bindings: readonly EffectiveBinding[]): WebChordSpec[]
```

For every `enabled` binding that `hasReclaimableMatch` would reclaim under kind `"web"` — i.e. every enabled binding that is not `ttyOnly` and not `guiOnly` (`webOnly` included: the keydown arrives inside the web tile) — emit the combos `matchesCombo` accepts for its `{code, tier}`: `cmd` → `{ctrl}` and `{meta}` (no shift); `shifted` → `{shift+ctrl}` and `{shift+meta}`; `ctrl` → `{ctrl}` only. Alt is always `false` (`matchesCombo` rejects Alt). Append `{code: "Escape"}` with no modifiers (the focus-return chord, always present). The ⌘K palette chord needs no special entry: `command-palette` (`KeyK`, `cmd`, global) and its `command-palette-alt` alias are ordinary enabled registry bindings and are emitted by the rule. Dedupe by the five-tuple; deterministic order (registry order, Escape last).

**SPA — bridge**: `web:chords` invoker `setShellWebViewChords(tabKey, chords)`; `ShellWebEvent` gains `{ kind: "chord"; key: string; code: string; ctrlKey; metaKey; shiftKey; altKey: boolean }`.

**Engine**: takes a new optional prop `chordTable?: readonly WebChordSpec[]` (the chrome computes it once via `useMemo(() => buildWebChordTable(bindings), [bindings])` from `useKeybindings().bindings` — `IframeWindow` gains that hook read; `SurfaceLayout` and the existing `shouldReclaimChord` prop are untouched) and sends `web:chords` after create and whenever the table identity changes. On a `chord` relay: `interactRef.current?.()` (a keydown inside the tile is an interaction — the iframe engine's `onKey` reports first) then `redispatchChord(event)` — the shared helper in `lib/web-frame-engine.ts`, byte-identical to the iframe reclaim. The engine does **not** re-consult `reclaimRef`: the table already IS the predicate, and Escape is not a registry chord.

**Desktop — `app/desktop/src/chords.ts` (new, electron-free, `node --test`)**:

```ts
export interface ChordSpec { code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
export interface ChordInput { type: string; code: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }
export function parseChordSpecs(value: unknown): ChordSpec[] | null   // structural; ≤ 256 entries (WEB_CHORDS_MAX), each code a non-empty string ≤ 64 chars
export function matchChord(input: ChordInput, chords: readonly ChordSpec[]): boolean
```

`matchChord` is true iff `input.type === "keyDown"` and some spec equals the input on `code` and all four modifiers exactly (`control` ↔ `ctrl`). Auto-repeat is not filtered (a held ⌘K repeats the palette toggle exactly as it does in the iframe engine).

**Desktop — registry (`web-views.ts`)**: `WebViewEntry` gains `chords: ChordSpec[]` (initially `[]`); pure `setWebViewChords(state, hostContentsId, tabKey, chords)` (unknown key no-op — the `setWebViewBounds` shape). Tests in `web-views.test.ts`.

**Desktop — `main.ts`**: handler `web:chords` (`parseWebChordsPayload` → `setWebViewChords`); in `wireGuestRelay`:

```ts
contents.on("before-input-event", (event, input) => {
  const current = findWebViewBySender(webViews, hostContentsId, tabKey);
  if (!current || current.webContentsId !== contents.id) return;
  if (!matchChord(input, current.chords)) return;
  event.preventDefault();
  webContents.fromId(hostContentsId)?.focus();     // the rule: EVERY relayed chord hops focus to the host
  relay("chord", { key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, shiftKey: input.shift, altKey: input.alt });
});
```

Escape therefore returns focus to the SPA by the same rule as every other chord (the "Escape returns focus" parity item is this rule applied to the always-present Escape spec); the re-dispatched synthetic Escape on the document is inert unless an SPA listener wants it.

### 5. Errors — `TileError` from Chromium's error codes and the proxy's 502

**Desktop**: the `url` relay gains `httpStatus` — `did-navigate`'s `httpResponseCode` argument (`did-navigate-in-page` carries none; the field is omitted there). The `failed` relay (`{code, description, url}`, main-frame only, `ERR_ABORTED` excluded) is unchanged.

**SPA — `lib/web-native-errors.ts` (new, pure, Vitest)**:

```ts
export function tileErrorForGuestFailure(input: { code: number; description: string; url: string }, tabUrl: string): TileError
export function tileErrorForGuestResponse(httpStatus: number, tabUrl: string): TileError | null
export function reasonFromChromiumDescription(description: string): string   // "ERR_NAME_NOT_RESOLVED" → "name not resolved"
```

Rules: `classifyAddress(tabUrl) === "proxy"` and (`httpStatus === 502` — the Go `httputil.ReverseProxy` default error path when nothing listens — or a failure code in the connection-refused/reset family `-102`/`-101`) ⇒ `{ kind: "dead-port", port: proxyPortOf(tabUrl) }`; every other main-frame failure ⇒ `{ kind: "unreachable", host: new URL(input.url).host (fallback: the raw url), reason: reasonFromChromiumDescription(description) }`. The `refused` kind is unreachable on this engine (Chromium renders sites that refuse embedding). `reasonFromChromiumDescription` strips a leading `ERR_`, lowercases, and turns `_` into spaces; an empty description yields `"load failed"`. Named constants for the two connection codes; no other code table.

**Engine**: `failed` relay → `setTileError(tileErrorForGuestFailure(event, url))`, `loading = false`; `url` relay with `httpStatus` → `setTileError(tileErrorForGuestResponse(httpStatus, url))` (a `null` clears a stale error on a successful navigation); a new load start (`loading: true`) clears `tileError`. `retry` (the dead-port Retry button) is `reload`. While `tileError` is set the chrome renders its error surface in place of the content area (3f: `hidden={!active}` placeholder; the chrome hides the engine wrapper branch when `tileError` is non-null — verify the native placeholder unmounts or zero-sizes so `rectNonZero` goes false and the guest hides; if the chrome keeps the wrapper mounted, the engine sends `web:visible false` while `tileError !== null`).

### 6. Downloads & popups — confirm, record

No code. The apply worker confirms in `main.ts` that the guest partition registers no `will-download` handler (default save flow) and that the app-level `setWindowOpenHandler` denies + `openExternal`s http(s) for guests (shipped). The follow-up is recorded with `idea add "web tile popup-to-tab: a guest window.open / target=_blank opens a new web tab in the same tile instead of the system browser (setWindowOpenHandler on guests → web:event popup → onAddTab); from fab/plans/sahil/26-09-16-web-tile-native-browser.md change 4 item 6"` (the `idea` CLI is on PATH; `fab/backlog.md` is its target).

### 7. DevTools — `Web: Inspect page`

**Desktop**: handler `web:devtools` (`parseWebTabKeyPayload`) → `guest.handle.webContents.openDevTools({ mode: "detach" })`.

**SPA**: invoker `openShellWebViewDevTools(tabKey)`; engine `supports.devtools = true`, handle `openDevTools` set. `lib/web-url.ts` gains `WEB_INSPECT_EVENT = "web-inspect"` (the `web-open-external` seam shape); the chrome adds one document listener that calls `frameHandles.current.get(url)?.openDevTools?.()`. Palette: `lib/palette/web-engine.ts` gains `buildWebInspectActions({ available, onSelect })` returning `[{ id: "web-inspect", label: "Web: Inspect page", onSelect }]` when `available` — `available = selectWebEngineKind(canShellWeb(), nativeEnabled) === "native" && hasWebUrl(effectiveWindow)` (absent on the iframe engine and on an onboarding tile — the `web-find` content gate); registered in `app.tsx` beside `webEngineActions`; **no chord** (the palette is the keyboard path); **no header verb** (the URL bar's fold budget stays as shipped — Constitution V is satisfied by the palette entry).

### 8. Tips flip upward over the tile's header verbs

Every `Tip` inside `iframe-window.tsx` (the tab-strip cluster and the URL-bar cluster: Back, Forward, Refresh, Find in page, Zoom out/reset/in, Open in browser, the tab-full tip) passes `placement="top"`. Engine-blind (both engines — the chrome is one component); `flip()` still handles the viewport edge. No clipping geometry is added.

### 9. Tests

- **Desktop `node --test`**: `chords.test.ts` (`matchChord`: keyDown only, exact modifiers, Escape, cmd/shifted variants, alt rejected; `parseChordSpecs`: shape, caps, bad entries), `web-views.test.ts` additions (`setWebViewChords` record + unknown-key no-op + `chords: []` on add).
- **Frontend Vitest**: `lib/web-chord-table.test.ts` (tier expansion, ttyOnly/guiOnly exclusion, webOnly inclusion, disabled exclusion, Escape appended, dedupe, `command-palette` present); `lib/web-native-errors.test.ts` (proxy 502 ⇒ dead-port with port, `-102` on proxy ⇒ dead-port, `-105` external ⇒ unreachable with `name not resolved`, description transform, empty description); `lib/shell.test.ts` additions (`parseShellWebEvent` for `find`/`chord`/`url.httpStatus`, the widened `isWebBridge` — a six-member bridge narrows to null); `components/web-frame-native.test.tsx` additions (capabilities all `true` except none; handle back/forward/find/stopFind/openDevTools call the bridge; `find` relay maps ordinals; `zoom` sent on create, on prop change, on every `url` event; `zoom` relay calls `onZoomStep`; `chords` sent on create and on table change; `chord` relay fires `interactRef` and dispatches a bubbling `keydown` on `document`; `failed`/`url.httpStatus` produce `tileError`; load start clears it); `lib/palette/web-engine.test.ts` (`buildWebInspectActions` gate); `iframe-window.stub-engine.test.tsx` — the chrome passes `chordTable`/`onZoomStep` to the engine and the `web-inspect` event reaches the active handle.
- **E2E**: unchanged; `just test-e2e web-tile-find.spec`, `web-tile-zoom.spec`, `web-tile-chrome.spec` run as the iframe-engine regression gate (Tip placement touched the chrome).
- **Manual matrix** (not a gate — listed in the PR body as a checklist for the user): four address kinds (present, proxy, relative, external) × {back/forward, find, zoom, ⌘K from inside, Escape, dead port, unreachable} in `RK_DESKTOP_URL=… just dev-desktop`.

### Verification per change (plan § Standing context)

`cd app/frontend && npx tsc --noEmit`; `just test-frontend` (the full Vitest run — touched-files-only has missed cross-file breakage); scoped e2e as above (one spec per run, `.spec` suffix); `cd app/desktop && pnpm run compile && pnpm test`. Fresh worktree: `just setup` for the frontend and `cd app/desktop && pnpm install` (Electron download) before compiling.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Web Tile → "The `native` engine" paragraph rewritten to present truth (capabilities all `true`; the handle's real verbs; the `find`/`chord`/`zoom`/`failed`/`url.httpStatus` relay mappings; the chord table prop; `onZoomStep`) plus a per-engine parity table (history · find · zoom · chords · errors · devtools · meta: iframe vs native); § Web Tile → Tips flip upward; Design Decisions: *The chord table is the reclaim predicate, enumerated* (why: one registry, two engines, one answer), *Zoom re-applies on every navigation* (why: Chromium's per-host store in the partition), *Guest errors map SPA-side from code + status* (why: address kind lives in `lib/web-url.ts`).
- `run-kit/ui/keyboard-and-palette`: (modify) chord forwarding through `before-input-event` as the third reclaim mechanism beside the iframe and code seams (§ the `ttyOnly`/`webOnly` flags paragraph and § Design Decisions → the chord-reclaim entry); `Web: Inspect page` (`web-inspect`) added to the Command Palette Actions inventory beside `Web: Use embedded browser`.
- `run-kit/desktop-shell`: (modify) § Web Views — the relay table gains `find`, `chord`, `url.httpStatus`; the IPC table gains `web:back`, `web:forward`, `web:find`, `web:stop-find`, `web:zoom`, `web:chords`, `web:devtools` with their validators; the "No `before-input-event` listener exists" sentence is replaced by the chord matcher description (`chords.ts`, the per-guest `chords` record, the focus-hop rule); `WebViewEntry.chords`; § `window.runkitShell` Bridge — the `web` group row lists the widened member set; Design Decisions: *Chords are matched main-side from an SPA-supplied table* (why: the guest's keydowns never reach the SPA document; the table keeps the registry the single authority), *Every relayed chord hops focus* (why: spike — palette input focused while OS focus stays in the guest).
- `run-kit/ui/focus-ownership`: (modify) one sentence in § Recording Seams — the native engine's `chord` relay reports `onInteract` before re-dispatch, matching the iframe engine's keydown ordering.

## Impact

- **Frontend** (`app/frontend/src/`): `components/web-frame-native.tsx` (+ test), `components/iframe-window.tsx` (Tip placement, `chordTable`/`onZoomStep` pass-through, `web-inspect` listener, `useKeybindings` read) (+ stub-engine test), `lib/web-frame-engine.ts` (two optional props), `lib/shell.ts` (+ test), `lib/web-url.ts` (`WEB_INSPECT_EVENT`), `lib/web-chord-table.ts` (new + test), `lib/web-native-errors.ts` (new + test), `lib/palette/web-engine.ts` (+ test), `app.tsx` (palette registration). `web-frame-iframe.tsx` is untouched except that it ignores the two new optional props.
- **Desktop** (`app/desktop/src/`): `main.ts` (seven handlers, four validators, relay additions, `before-input-event`), `preload.ts` (`web` group members), `web-views.ts` (+ test), `chords.ts` (new + test).
- **Backend**: none. **E2E**: none modified. **Specs**: none (change 5 owns the spec rows).
- **Compatibility**: a pre-parity shell (3d/3f only) fails the widened `isWebBridge` narrowing and falls back to the iframe engine; an older SPA on a parity shell never calls the new channels (additive). No stored `@rk_win_web_<n>` contract change.
- **Security**: every new channel rides the shipped four-rung ladder; payloads are structurally validated (`text`/`factor`/`chords` bounded); no new subprocess, route, or settings surface (Constitution I, IV); the new action is a palette entry (Constitution V).

## Open Questions

- None blocking. The manual desktop matrix cannot run inside the dispatched worker; it ships as a PR-body checklist.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Follow the plan's Change 4 items 1–9 with the spike verdict's three amendments (zoom re-apply on every navigation + zoom-changed as a bucket step; focus hop on every relayed chord; Tips flip upward) | Written decisions of record in the plan; the user's prompt restates them | S:95 R:80 A:95 D:95 |
| 2 | Certain | New capabilities land as `web:*` IPC channels behind the shipped four-rung gate + structural validators, relayed on the single `web:event` channel | The 3d pattern; Constitution I security posture | S:90 R:85 A:95 D:95 |
| 3 | Certain | `Web: Inspect page` is a palette entry only (no chord, no header verb), present only when the active engine is native and the window has web content | Plan item 7 allows palette-only; Constitution V satisfied; header fold budget untouched | S:85 R:90 A:90 D:85 |
| 4 | Confident | The chord table is enumerated SPA-side from the registry (`buildWebChordTable` over `useKeybindings().bindings`, mirroring `matchesCombo`'s tier expansion) and stored per guest; main matches with exact modifier equality on `keyDown` | Plan item 4 names both modules; the tier expansion is read straight from `matchesCombo` | S:85 R:80 A:85 D:80 |
| 5 | Confident | Escape is an always-present chord spec: main `preventDefault`s it in the guest, hops focus, relays it; the engine re-dispatches it like any chord | Plan: "match ⌘K/⌘F/⌘L/Escape, preventDefault, relay"; the spike verified exactly this | S:80 R:85 A:75 D:70 |
| 6 | Confident | `isWebBridge` requires the widened member set; a pre-parity shell falls back to the iframe engine | The 3f comment "shipped whole in one shell release, so all members are required together"; a shell that cannot drive a control must not select the engine that shows it | S:70 R:85 A:80 D:70 |
| 7 | Confident | Dead-port detection reads `did-navigate`'s `httpResponseCode` (502 from the Go reverse proxy) plus the connection-refused/reset codes on proxy-kind addresses; error mapping lives SPA-side in `lib/web-native-errors.ts` (Vitest) because address kind is `lib/web-url.ts` knowledge | Plan item 5 names the outcomes; the proxy's 502 is an HTTP response, not a Chromium load failure, so a code-only mapping would miss the common dead-port case | S:75 R:85 A:85 D:75 |
| 8 | Confident | The `unreachable` reason derives from Chromium's description by a generic transform (`ERR_NAME_NOT_RESOLVED` → `name not resolved`), no hand-maintained code table | Plan: "Chromium's description as the reason"; avoids magic-string tables (code-quality) | S:70 R:90 A:85 D:75 |
| 9 | Confident | Zoom stepping from `zoom-changed` reaches the chrome through a new optional engine prop `onZoomStep` (the chrome passes `applyZoom`); the native engine sends `web:zoom` after create, on `zoom` prop change, and on every `url` relay | The bucket is chrome-owned (`iframe-window.tsx`); the contract already threads chrome callbacks as props | S:80 R:85 A:85 D:80 |
| 10 | Confident | Every `Tip` in `iframe-window.tsx` uses `placement="top"` on both engines | The chrome is engine-blind; the plan's Tip amendment; `flip()` covers edges | S:75 R:95 A:85 D:80 |
| 11 | Confident | Find ordinals map `activeMatchOrdinal - 1` → FindBar `matchIndex`; find state resets to `null` on `stopFind` and on every completed load | FindBar's 0-based contract; the iframe engine's per-load reset rule | S:80 R:90 A:90 D:85 |
| 12 | Confident | Manual desktop matrix is a PR-body checklist, not a pipeline gate; automated gates are tsc, `just test-frontend`, desktop `pnpm test`, and three scoped web-tile e2e specs | Dispatched workers cannot drive the Electron shell reliably; plan § Verification lists the manual run as separate | S:70 R:90 A:80 D:75 |
| 13 | Tentative | Auto-repeat keydowns are not filtered in `matchChord` | Mirrors the iframe engine (no repeat filter there); a held palette chord toggling is acceptable and reversible in one line | S:50 R:95 A:70 D:60 |
| 14 | Confident | Popup-to-tab is recorded via `idea add` into `fab/backlog.md`; no popup or download code changes | Plan item 6 verbatim; `idea` is on PATH | S:85 R:95 A:90 D:90 |

14 assumptions (3 certain, 10 confident, 1 tentative, 0 unresolved).
