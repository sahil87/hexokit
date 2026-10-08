# Plan: Web Native Engine Parity

**Change**: 260917-w0k7-web-native-parity
**Intake**: `intake.md`

## Requirements

### Desktop shell: history, find, zoom, devtools channels

#### R1: History channels
The shell SHALL expose `web:back` and `web:forward` (payload `{tabKey}`) that call `webContents.navigationHistory.goBack()` / `goForward()` on the sender's guest, gated by the shipped four-rung ladder (`Not allowed` → `No host view` → `Invalid request` → `Unknown tab`). A call at the boundary (`!canGoBack()` / `!canGoForward()`) MUST be a no-op that still returns `{ok: true}`.

- **GIVEN** a registered guest that has navigated twice
- **WHEN** the owning host sends `web:back {tabKey}`
- **THEN** the guest goes back one entry and the next `url` relay reports `canGoForward: true`

#### R2: Find channels and relay
The shell SHALL expose `web:find` (payload `{tabKey, text, forward, findNext}` — `text` a non-empty string ≤ 1024 chars, both flags booleans) calling `webContents.findInPage(text, {forward, findNext})`, and `web:stop-find` (payload `{tabKey}`) calling `webContents.stopFindInPage("clearSelection")`. `wireGuestRelay` SHALL relay `found-in-page` as `{kind: "find", active: result.activeMatchOrdinal, total: result.matches, final: result.finalUpdate}` on `web:event`.

- **GIVEN** a guest page containing three matches for "foo"
- **WHEN** the host sends `web:find {text: "foo", forward: true, findNext: false}`
- **THEN** a `find` relay arrives with `total: 3` and `active ≥ 1`

#### R3: Zoom channel
The shell SHALL expose `web:zoom` (payload `{tabKey, factor}` — a finite number within `[0.25, 5]`, named constants) calling `webContents.setZoomFactor(factor)`. The `zoom-changed` relay stays direction-only and is never applied main-side.

- **GIVEN** a registered guest
- **WHEN** the host sends `web:zoom {factor: 1.25}`
- **THEN** `setZoomFactor(1.25)` is called on the guest webContents and no zoom is applied on any other path

#### R4: DevTools channel
The shell SHALL expose `web:devtools` (payload `{tabKey}`) calling `webContents.openDevTools({mode: "detach"})`.

- **GIVEN** a registered guest
- **WHEN** the host sends `web:devtools {tabKey}`
- **THEN** a detached DevTools window opens for that guest

#### R5: Navigation relay carries the HTTP status
The `url` relay SHALL carry `httpStatus` (the `did-navigate` `httpResponseCode` argument) on `did-navigate` events and omit it on `did-navigate-in-page`.

- **GIVEN** a proxy-kind address whose upstream port is dead
- **WHEN** the guest commits the navigation and the rk reverse proxy answers 502
- **THEN** the `url` relay carries `httpStatus: 502`

### Desktop shell: chord forwarding

#### R6: Chord matcher module
A new electron-free module `app/desktop/src/chords.ts` SHALL export `ChordSpec`, `ChordInput`, `parseChordSpecs(value: unknown): ChordSpec[] | null` (structural; ≤ 256 entries — `WEB_CHORDS_MAX`; each `code` a non-empty string ≤ 64 chars; four booleans), and `matchChord(input, chords): boolean`, true iff `input.type === "keyDown"` and some spec equals the input on `code`, `control↔ctrl`, `meta`, `shift`, `alt` exactly. Auto-repeat is not filtered.

- **GIVEN** a table `[{code: "KeyK", ctrl: true, meta: false, shift: false, alt: false}]`
- **WHEN** `matchChord({type: "keyDown", code: "KeyK", control: true, meta: false, shift: false, alt: false}, table)` is evaluated
- **THEN** it returns `true`
- **AND** the same input with `type: "keyUp"`, or with `shift: true`, returns `false`

#### R7: Per-guest chord table and `before-input-event`
`WebViewEntry` SHALL carry `chords: ChordSpec[]` (initially `[]`) with a pure `setWebViewChords` transition (unknown key no-op). The shell SHALL expose `web:chords` (payload `{tabKey, chords}` validated via `parseChordSpecs`) recording the table. `wireGuestRelay` SHALL attach `before-input-event`: when the registry's current entry for the guest matches (`matchChord`), it `preventDefault()`s the input, calls `webContents.fromId(hostContentsId)?.focus()` (the focus hop — on EVERY relayed chord), and relays `{kind: "chord", key, code, ctrlKey: input.control, metaKey: input.meta, shiftKey: input.shift, altKey: input.alt}`.

- **GIVEN** a guest whose table contains Ctrl+K and Escape
- **WHEN** the user presses Ctrl+K inside the guest page
- **THEN** the page never receives the keydown, the host webContents gains focus, and a `chord` relay arrives at the host
- **AND** a plain letter keydown is untouched and not relayed

### Desktop shell: preload

#### R8: Preload `web` group members
`preload.ts`'s `web` group SHALL gain `back`, `forward`, `find(tabKey, text, forward, findNext)`, `stopFind`, `zoom(tabKey, factor)`, `chords(tabKey, chords)`, `devtools` invokers over the matching channels.

- **GIVEN** the parity shell
- **WHEN** the SPA calls `window.runkitShell.web.find("web-1", "foo", true, false)`
- **THEN** `ipcRenderer.invoke("web:find", {tabKey: "web-1", text: "foo", forward: true, findNext: false})` is issued

### SPA: bridge narrowing and invokers

#### R9: Widened `isWebBridge` and invokers
`lib/shell.ts` `ShellWebBridge` SHALL require all fourteen members (the seven shipped plus `back`, `forward`, `find`, `stopFind`, `zoom`, `chords`, `devtools`); a bridge missing any narrows to `null` so `canShellWeb()` is `false` and the chrome selects the iframe engine. New never-throw invokers: `goBackShellWebView`, `goForwardShellWebView`, `findShellWebView(tabKey, text, {forward, findNext})`, `stopFindShellWebView`, `setShellWebViewZoom(tabKey, factor)`, `setShellWebViewChords(tabKey, chords)`, `openShellWebViewDevTools`. `ShellWebEvent` SHALL gain `find` (`{active, total, final}`), `chord` (`{key, code, ctrlKey, metaKey, shiftKey, altKey}`), and `url.httpStatus?: number`; `parseShellWebEvent` narrows each structurally and drops malformed payloads.

- **GIVEN** a `runkitShell.web` object carrying only the seven 3d members
- **WHEN** `canShellWeb()` is evaluated
- **THEN** it returns `false`

### SPA: chord table

#### R10: `buildWebChordTable`
A new pure module `lib/web-chord-table.ts` SHALL export `WebChordSpec` and `buildWebChordTable(bindings: readonly EffectiveBinding[]): WebChordSpec[]`: for every `enabled` binding that is neither `ttyOnly` nor `guiOnly`, emit the combos `matchesCombo` accepts for its effective `{code, tier}` — `cmd` → `{ctrl}` and `{meta}`; `shifted` → `{shift+ctrl}` and `{shift+meta}`; `ctrl` → `{ctrl}` — always `alt: false`; append `{code: "Escape"}` with no modifiers last; dedupe by the five-tuple; registry order.

- **GIVEN** the default binding set with `command-palette` (KeyK, cmd) enabled and the `ttyOnly` split pair
- **WHEN** `buildWebChordTable(bindings)` runs
- **THEN** the table contains `{KeyK, ctrl}` and `{KeyK, meta}`, contains no entry for the split pair's codes unless an ungated binding shares them, and ends with the Escape spec

### SPA: engine contract

#### R11: Two optional engine props
`WebFrameEngineProps` SHALL gain `onZoomStep?: (direction: "in" | "out") => void` and `chordTable?: readonly WebChordSpec[]`. The iframe engine accepts and ignores both.

- **GIVEN** the iframe engine mounted with both props
- **WHEN** it renders
- **THEN** behavior is byte-identical to before

### SPA: native engine

#### R12: Capabilities and handle
`WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES` SHALL be `{history: true, find: true, meta: true, zoomGestures: true, devtools: true}`; the handle's `back`/`forward`/`find`/`stopFind` call the matching invokers and `openDevTools` is set (calls `openShellWebViewDevTools`).

- **GIVEN** the native engine mounted for `https://example.com`
- **WHEN** the chrome calls `handle.back()`
- **THEN** `runkitShell.web.back(tabKey)` is invoked

#### R13: Find state mapping
A `find` relay SHALL set `find = {active: Math.max(0, active - 1), total}`; `stopFind` and every completed load (`loading: false` edge) SHALL reset `find` to `null`.

- **GIVEN** a `find` relay `{active: 2, total: 5}`
- **WHEN** the engine reports state
- **THEN** `state.find` is `{active: 1, total: 5}`

#### R14: Zoom application and stepping
The engine SHALL send `web:zoom {factor: zoom}` after create, whenever the `zoom` prop changes, and on every `url` relay; a `zoom` relay SHALL call `onZoomStep?.(direction)`. The engine renders no scale wrapper.

- **GIVEN** the engine mounted with `zoom = 1.25`
- **WHEN** a `url` relay arrives
- **THEN** `web:zoom` is sent with `1.25` again
- **AND** a `zoom {direction: "in"}` relay calls `onZoomStep("in")`

#### R15: Chord table upload and chord re-dispatch
The engine SHALL send `web:chords {tabKey, chords}` after create and whenever the `chordTable` prop identity changes. On a `chord` relay it SHALL call `interactRef.current?.()` then `redispatchChord(event)` (a synthetic bubbling `keydown` on `document`). It MUST NOT consult `reclaimRef`.

- **GIVEN** the engine mounted with a chord table
- **WHEN** a `chord` relay `{key: "k", code: "KeyK", ctrlKey: true, …}` arrives
- **THEN** `interactRef.current` fires and `document` receives a bubbling `keydown` with `code === "KeyK"` and `ctrlKey === true`

#### R16: Error mapping
A new pure module `lib/web-native-errors.ts` SHALL export `WEB_ERR_CONNECTION_REFUSED = -102`, `WEB_ERR_CONNECTION_RESET = -101`, `reasonFromChromiumDescription(description)` (strip leading `ERR_`, lowercase, `_` → space; empty ⇒ `"load failed"`), `tileErrorForGuestFailure({code, description, url}, tabUrl): TileError` (proxy-kind `tabUrl` with a refused/reset code ⇒ `{kind: "dead-port", port: proxyPortOf(tabUrl)}` when the port resolves; otherwise `{kind: "unreachable", host, reason}` with `host` from `new URL(url).host`, fallback the raw url), and `tileErrorForGuestResponse(httpStatus, tabUrl): TileError | null` (proxy-kind and `502` with a resolvable port ⇒ dead-port; else `null`). The engine SHALL set `tileError` from a `failed` relay and from a `url` relay carrying `httpStatus`, clear it on `loading: true`, and report it in state; `retry` is `reload`.

- **GIVEN** the engine for `http://localhost:3000` (proxy kind, port 3000)
- **WHEN** a `url` relay with `httpStatus: 502` arrives
- **THEN** `state.tileError` is `{kind: "dead-port", port: 3000}`
- **AND** a `failed` relay `{code: -105, description: "ERR_NAME_NOT_RESOLVED", url: "https://nope.example/"}` on an external tab yields `{kind: "unreachable", host: "nope.example", reason: "name not resolved"}`

#### R17: Error surface hides the guest
While `tileError` is non-null on the active tab, the guest MUST NOT paint over the chrome's error surface: the engine SHALL include `tileError === null` in `wantVisible`.

- **GIVEN** an active native tab reporting a dead-port error
- **WHEN** the chrome renders the error surface
- **THEN** `web:visible {false}` has been sent for that guest, and a later successful load (`tileError` cleared) re-shows it

### SPA: chrome

#### R18: Chrome pass-through and inspect seam
`IframeWindow` SHALL read `useKeybindings().bindings`, compute `chordTable` via `useMemo(() => buildWebChordTable(bindings), [bindings])`, and pass `chordTable` and `onZoomStep={applyZoom}` to every mounted engine. `lib/web-url.ts` SHALL export `WEB_INSPECT_EVENT = "web-inspect"`; the chrome SHALL add one document listener calling `frameHandles.current.get(url)?.openDevTools?.()` for the active tab.

- **GIVEN** the chrome mounted with a stub engine
- **WHEN** `document.dispatchEvent(new CustomEvent(WEB_INSPECT_EVENT))` fires
- **THEN** the active handle's `openDevTools` is called once

#### R19: Tips flip upward
Every `Tip` inside `iframe-window.tsx` SHALL pass `placement="top"`.

- **GIVEN** the web tile's URL bar
- **WHEN** the Refresh button is hovered
- **THEN** the tip renders above the button (Floating UI `placement` top), never over the content rect

### SPA: palette

#### R20: `Web: Inspect page`
`lib/palette/web-engine.ts` SHALL export `WEB_INSPECT_ACTION_ID = "web-inspect"` and `buildWebInspectActions({available, onSelect}): PaletteAction[]` returning `[{id: "web-inspect", label: "Web: Inspect page", onSelect}]` when `available`, else `[]`. `app.tsx` SHALL register it beside `webEngineActions` with `available = selectWebEngineKind(canShellWeb(), nativeEngineEnabled) === "native" && hasWebUrl(effectiveWindow)` and `onSelect` dispatching `WEB_INSPECT_EVENT`. No chord, no header verb.

- **GIVEN** the shell with the native engine selected and a window with web content
- **WHEN** the palette opens
- **THEN** `Web: Inspect page` is listed
- **AND** on the iframe engine or an onboarding tile it is absent

### Housekeeping

#### R21: Popup-to-tab follow-up idea
The follow-up SHALL be recorded once in `fab/backlog.md` via `idea add` (text per intake § 6); no popup or download code changes.

- **GIVEN** the apply run
- **WHEN** it completes
- **THEN** `fab/backlog.md` carries one new unchecked row mentioning popup-to-tab

### Non-Goals

- Popup-to-tab, direct-localhost for local hosts, the `code` lens, `capturePage` — later changes / ideas.
- Header verb for Inspect — palette-only.
- Overlay clipping geometry — no overlay straddles the content rect in this change.
- Spec rows (`window-views.md`, `surface-layout.md`, `right-panel.md`) — change 5.
- A desktop e2e lane — change 5; the manual matrix ships as a PR-body checklist.

### Design Decisions

#### The chord table is the reclaim predicate, enumerated
**Decision**: the SPA enumerates `hasReclaimableMatch`'s kind-`web` answer over the binding registry into a per-guest table (`buildWebChordTable`), and main matches `before-input-event` against it with exact modifier equality; the engine re-dispatches without re-consulting the predicate.
**Why**: a guest's keydowns never reach the SPA document, so the predicate cannot run at event time; enumerating it keeps the registry the single authority (a rebind moves both engines) and keeps main dumb and testable.
**Rejected**: a hard-coded chord list in main (drifts from the registry); relaying every keydown to the SPA for the predicate to judge (a round-trip per keystroke, and the page would already have handled it).
*Introduced by*: 260917-w0k7-web-native-parity

#### Every relayed chord hops focus to the host
**Decision**: main calls `hostContents.focus()` before relaying any matched chord, Escape included.
**Why**: the spike showed a focused palette input in the SPA while OS focus stayed in the guest; the hop is what makes the re-dispatched chord's result usable, and making it a rule avoids an Escape special case.
**Rejected**: hopping only on Escape (palette opens with dead keyboard focus); hopping SPA-side (the SPA cannot move OS focus out of a sibling view).
*Introduced by*: 260917-w0k7-web-native-parity

#### Zoom re-applies on every navigation
**Decision**: the native engine sends `web:zoom` after create, on every `zoom` prop change, and on every `url` relay; `zoom-changed` steps the chrome's bucket through `onZoomStep`.
**Why**: Chromium's per-host zoom store inside the partition persists and leaks across views; the SPA's localStorage buckets are the source of truth for both engines.
**Rejected**: letting Chromium own zoom (fights the bucket across hosts); applying `zoom-changed` main-side (two writers).
*Introduced by*: 260917-w0k7-web-native-parity

#### Guest errors map SPA-side from code plus HTTP status
**Decision**: `lib/web-native-errors.ts` maps `did-fail-load` codes and `did-navigate`'s `httpResponseCode` to `TileError` using `classifyAddress`/`proxyPortOf`; the `refused` kind is unreachable on this engine.
**Why**: address kind is SPA knowledge, and a dead proxied port is an HTTP 502 from the Go reverse proxy, not a Chromium load failure — a code-only mapping would miss the common case.
**Rejected**: a main-side mapping (main does not know address kinds); a same-origin 502 probe fetch (Chromium already made the request).
*Introduced by*: 260917-w0k7-web-native-parity

#### A pre-parity shell falls back to the iframe engine
**Decision**: `isWebBridge` requires the full parity member set.
**Why**: the `web` group ships whole per shell release; a shell that cannot drive a control must not select the engine that shows it.
**Rejected**: per-member additive narrowing driving capability flags (more surface, and the chrome would show a half-working engine).
*Introduced by*: 260917-w0k7-web-native-parity

## Tasks

### Phase 1: Desktop shell

- [x] T001 Create `app/desktop/src/chords.ts` (`ChordSpec`, `ChordInput`, `WEB_CHORDS_MAX`, `parseChordSpecs`, `matchChord`) and `app/desktop/src/chords.test.ts` (`node --test`: keyDown-only, exact modifiers, alt rejected, Escape, cmd/shifted variants, parse caps and bad entries) <!-- R6 -->
- [x] T002 [P] Extend `app/desktop/src/web-views.ts`: `WebViewEntry.chords: ChordSpec[]` (`[]` on add), `setWebViewChords` (unknown-key no-op); add cases to `web-views.test.ts` <!-- R7 -->
- [x] T003 In `app/desktop/src/main.ts` `registerIpcHandlers`: add `web:back`, `web:forward`, `web:find`, `web:stop-find`, `web:zoom`, `web:chords`, `web:devtools` handlers on the shipped four-rung ladder; add validators `parseWebFindPayload` (`WEB_FIND_TEXT_MAX_LENGTH = 1024`), `parseWebZoomPayload` (`WEB_ZOOM_FACTOR_MIN = 0.25`, `WEB_ZOOM_FACTOR_MAX = 5`), `parseWebChordsPayload` (via `parseChordSpecs`); boundary no-ops for back/forward <!-- R1 R2 R3 R4 R7 -->
- [x] T004 In `app/desktop/src/main.ts` `wireGuestRelay`: relay `found-in-page` as `find`; carry `httpStatus` on `did-navigate`'s `url` relay (omit on in-page); attach `before-input-event` with the registry-current check, `matchChord`, `preventDefault`, `webContents.fromId(hostContentsId)?.focus()`, and the `chord` relay; update the file-header comment describing the relay/IPC surface <!-- R2 R5 R7 -->
- [x] T005 [P] Extend `app/desktop/src/preload.ts` `web` group with `back`, `forward`, `find`, `stopFind`, `zoom`, `chords`, `devtools`; update the header comment <!-- R8 -->
- [x] T006 `cd app/desktop && pnpm install` (if `node_modules` is absent) then `pnpm run compile && pnpm test` green <!-- R1 R6 R7 R8 -->

### Phase 2: SPA library modules

- [x] T007 [P] Widen `app/frontend/src/lib/shell.ts`: `ShellWebBridge` + `isWebBridge` (fourteen members), the seven new invokers, `ShellWebEvent` `find`/`chord`/`url.httpStatus`, `parseShellWebEvent` cases; extend `shell.test.ts` (six-member bridge narrows to null; new event parses; malformed drops) <!-- R9 -->
- [x] T008 [P] Create `app/frontend/src/lib/web-chord-table.ts` + `web-chord-table.test.ts` (tier expansion, ttyOnly/guiOnly exclusion, webOnly inclusion, disabled exclusion, Escape last, dedupe, `command-palette` present over the default registry) <!-- R10 -->
- [x] T009 [P] Create `app/frontend/src/lib/web-native-errors.ts` + `web-native-errors.test.ts` (502 on proxy ⇒ dead-port; -102 on proxy ⇒ dead-port; -105 external ⇒ unreachable "name not resolved"; unparsable url falls back to raw; empty description ⇒ "load failed"; non-proxy 502 ⇒ null) <!-- R16 -->
- [x] T010 [P] Add `onZoomStep?` and `chordTable?` to `WebFrameEngineProps` in `app/frontend/src/lib/web-frame-engine.ts`; add `WEB_INSPECT_EVENT` to `lib/web-url.ts`; add `WEB_INSPECT_ACTION_ID` + `buildWebInspectActions` to `lib/palette/web-engine.ts` with tests in `web-engine.test.ts` <!-- R11 R18 R20 -->

### Phase 3: Native engine

- [x] T011 Rewrite `app/frontend/src/components/web-frame-native.tsx`: capabilities all true; handle verbs wired to invokers incl. `openDevTools`; `find` state mapping + resets; `web:zoom` on create / `zoom` change / every `url` relay and `onZoomStep` on `zoom` relay; `web:chords` on create / `chordTable` change and `chord` → `interactRef` + `redispatchChord`; `tileError` from `failed` and `url.httpStatus`, cleared on load start; `wantVisible` includes `tileError === null`; update the header constraints comment <!-- R12 R13 R14 R15 R16 R17 -->
- [x] T012 Extend `app/frontend/src/components/web-frame-native.test.tsx` for every R12–R17 scenario (bridge mock gains the seven invokers) <!-- R12 R13 R14 R15 R16 R17 -->

### Phase 4: Chrome and palette

- [x] T013 In `app/frontend/src/components/iframe-window.tsx`: `useKeybindings()` read + memoized `chordTable`; pass `chordTable` and `onZoomStep={applyZoom}` to every `<Engine>`; `WEB_INSPECT_EVENT` document listener; `placement="top"` on every `Tip`; extend `iframe-window.stub-engine.test.tsx` (props reach the engine; inspect event reaches the active handle) <!-- R18 R19 -->
- [x] T014 In `app/frontend/src/app.tsx`: `webInspectActions` via `buildWebInspectActions` (gate per R20, `onSelect` dispatches `WEB_INSPECT_EVENT`) registered beside `webEngineActions` in the palette action list and its deps <!-- R20 -->
- [x] T015 Record the popup-to-tab idea: `idea add "web tile popup-to-tab: a guest window.open / target=_blank opens a new web tab in the same tile instead of the system browser (setWindowOpenHandler on guests → web:event popup → onAddTab); from fab/plans/sahil/26-09-16-web-tile-native-browser.md change 4 item 6"`; confirm no `will-download` handler exists for the guest session and popups stay external (no code change) <!-- R21 -->

### Phase 5: Gates

- [x] T016 `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (full Vitest); `just test-e2e "e2e/web-tile-find"`, `just test-e2e "e2e/web-tile-zoom"`, `just test-e2e "e2e/web-tile-chrome"` one at a time (`just setup` first when `app/frontend/node_modules` is absent) <!-- R9 R10 R11 R12 R16 R18 R19 R20 -->

## Execution Order

- T001 blocks T002, T003, T004 (they import `chords.ts`); T002 blocks T003/T004 (`setWebViewChords`, `entry.chords`)
- T005 is independent within Phase 1; T006 closes Phase 1
- Phase 2 tasks are mutually independent; T007 and T010 block T011
- T011 blocks T012; T010 + T011 block T013; T010 blocks T014
- T016 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `web:back` / `web:forward` handlers exist on the four-rung ladder and call `navigationHistory.goBack/goForward`, no-op at the boundary
- [x] A-002 R2: `web:find` / `web:stop-find` handlers and `parseWebFindPayload` (non-empty ≤ 1024 text, boolean flags) exist; `found-in-page` relays `find {active, total, final}`
- [x] A-003 R3: `web:zoom` handler with `parseWebZoomPayload` clamping to `[0.25, 5]` named constants calls `setZoomFactor`
- [x] A-004 R4: `web:devtools` opens detached DevTools
- [x] A-005 R5: `url` relay carries `httpStatus` on `did-navigate` and omits it on `did-navigate-in-page`
- [x] A-006 R6: `chords.ts` exports `parseChordSpecs` and `matchChord` with `node --test` coverage for keyDown-only, exact modifiers, alt rejection, Escape, caps
- [x] A-007 R7: `WebViewEntry.chords` + `setWebViewChords` exist with tests; `web:chords` records; `before-input-event` matches, prevents, focuses the host webContents, relays `chord`
- [x] A-008 R8: preload `web` group carries the seven new invokers
- [x] A-009 R9: `isWebBridge` requires fourteen members; a seven-member bridge narrows to null (tested); seven new invokers never throw; `parseShellWebEvent` handles `find`, `chord`, `url.httpStatus`
- [x] A-010 R10: `buildWebChordTable` expands tiers exactly as `matchesCombo`, excludes `ttyOnly`/`guiOnly`/disabled, includes `webOnly`, appends Escape last, dedupes
- [x] A-011 R11: both new props are optional on `WebFrameEngineProps`; the iframe engine is unchanged
- [x] A-012 R12: native capabilities are all `true`; handle back/forward/find/stopFind/openDevTools call the bridge
- [x] A-013 R13: `find` relay maps `active - 1`; `stopFind` and every completed load reset `find` to null
- [x] A-014 R14: `web:zoom` sent after create, on `zoom` change, on every `url` relay; `zoom` relay calls `onZoomStep`
- [x] A-015 R15: `web:chords` sent after create and on `chordTable` change; `chord` relay fires `interactRef` then a bubbling document `keydown`; `reclaimRef` is not consulted
- [x] A-016 R16: `web-native-errors.ts` mapping matches every GIVEN/WHEN/THEN; engine sets/clears `tileError` accordingly; `retry` reloads
- [x] A-017 R17: `wantVisible` is false while `tileError` is set and true again once cleared (tested)
- [x] A-018 R18: chrome passes `chordTable` and `onZoomStep` to engines; `WEB_INSPECT_EVENT` reaches the active handle's `openDevTools` (stub-engine test)
- [x] A-019 R19: every `Tip` in `iframe-window.tsx` has `placement="top"`
- [x] A-020 R20: `Web: Inspect page` is registered, gated on native engine + web content, dispatches `WEB_INSPECT_EVENT`; `buildWebInspectActions` tested
- [x] A-021 R21: one new backlog row records popup-to-tab; no popup/download code changed

### Behavioral Correctness

- [x] A-022 R7: a plain letter keydown in the guest is neither prevented nor relayed (matcher test with a non-matching input)
- [x] A-023 R16: the `refused` kind is never produced by the native error mapping

### Scenario Coverage

- [x] A-024 R9 R10 R16: Vitest suites for `shell.ts`, `web-chord-table.ts`, `web-native-errors.ts` pass under `just test-frontend`
- [x] A-025 R6 R7: `cd app/desktop && pnpm run compile && pnpm test` passes
- [x] A-026 R19: `just test-e2e "e2e/web-tile-find"`, `"e2e/web-tile-zoom"`, `"e2e/web-tile-chrome"` pass (iframe-engine regression gate)

### Edge Cases & Error Handling

- [x] A-027 R2 R3 R7: invalid payloads (empty find text, out-of-band zoom factor, > 256 chords, non-boolean modifiers) return `Invalid request` and touch no webContents
- [x] A-028 R16: an unparsable failed `url` falls back to the raw string as `host`; an empty description yields `"load failed"`

### Code Quality

- [x] A-029 Pattern consistency: validators follow the `parse*Payload` structural-narrowing shape; invokers follow the never-throw `Promise<boolean>` shape; new pure modules are electron-free / React-free
- [x] A-030 No unnecessary duplication: `redispatchChord`, `classifyAddress`, `proxyPortOf`, `matchesCombo` semantics reused, not re-implemented
- [x] A-031 Comments state constraints, never narration or change IDs; type narrowing over `as` casts; named constants for every bound
- [x] A-032 Tests colocated (`*.test.ts` / `*.test.tsx` / desktop `*.test.ts`); no Playwright `test()` added or modified (no intent-comment updates owed)

### Security

- [x] A-033 R1–R4 R7: every new channel runs the full `Not allowed` → `No host view` → `Invalid request` → `Unknown tab` ladder and resolves the guest via `webSenderGuest`; no new subprocess, route, or settings surface

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The 3f placeholders it replaced (the native engine's no-op handle verbs, the ignored `zoom` relay, the error-less `failed` mapping) were rewritten in place in `components/web-frame-native.tsx`, so no superseded symbol, branch, or utility survives elsewhere in the tree; `web-frame-iframe.tsx` and every shared helper (`redispatchChord`, `classifyAddress`, `proxyPortOf`, `matchesCombo`) are reused, not displaced.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `wantVisible` gains `tileError === null` so the error surface is never painted under the guest | The chrome keeps the engine wrapper mounted beside the error surface (both `flex-1`), so hiding the guest is the only way the copy is visible; the iframe engine hides its frame the same way | S:70 R:90 A:85 D:80 |
| 2 | Confident | `httpStatus` rides the existing `url` relay rather than a new event kind | One event per navigation; the SPA already demuxes `url` | S:75 R:90 A:85 D:85 |
| 3 | Confident | Main-side zoom band `[0.25, 5]` is a sanity clamp, not the SPA ladder | The SPA's ladder is the authority; main only rejects nonsense | S:70 R:95 A:85 D:80 |
| 4 | Confident | Chord table capped at 256 entries and code length at 64 | The default registry expands to well under 100 specs; a bound is required for an untrusted-shaped payload | S:65 R:95 A:85 D:80 |

4 assumptions (0 certain, 4 confident, 0 tentative).
