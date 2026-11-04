# Plan: Web Frame Native Engine

**Change**: 260916-q2xk-web-frame-native-engine
**Intake**: `intake.md`

## Requirements

### Shell bridge: the `web` group narrowing (`app/frontend/src/lib/shell.ts`)

#### R1: Structural narrowing of `runkitShell.web`
`lib/shell.ts` SHALL narrow the bridge's `web` group structurally — the file's additive-group pattern (`windowsBridge()`/`badgeBridge()`/`accentBridge()`): a private `ShellWebBridge` interface requiring all seven members (`create`, `destroy`, `bounds`, `visible`, `load`, `reload`, `onEvent`) to be functions, a private `webBridge(): ShellWebBridge | null` accessor, and an exported `canShellWeb(): boolean` that is true exactly when the accessor returns non-null. No `as` casts.

- **GIVEN** a plain browser (no `window.runkitShell`) or a shell whose bridge lacks `web` or has a partial `web` group
- **WHEN** `canShellWeb()` is called
- **THEN** it returns `false`
- **GIVEN** a shell whose `runkitShell.web` carries all seven function members
- **WHEN** `canShellWeb()` is called
- **THEN** it returns `true`

#### R2: Never-throwing typed invokers
`lib/shell.ts` SHALL export `createShellWebView(tabKey, url)`, `destroyShellWebView(tabKey)`, `setShellWebViewBounds(tabKey, rect: ShellWebRect)`, `setShellWebViewVisible(tabKey, visible)`, `loadShellWebView(tabKey, url)`, and `reloadShellWebView(tabKey)`, each resolving `Promise<boolean>`: `true` only on an `{ ok: true }` result; `false` outside the shell, on a missing/partial group, on a rejected invoke, or on any other result shape. None throws. `ShellWebRect` is `{ x, y, width, height }` (numbers).

- **GIVEN** the full `web` group whose `bounds` resolves `{ ok: true }`
- **WHEN** `setShellWebViewBounds("web-1", { x: 10, y: 20, width: 300, height: 200 })` is awaited
- **THEN** the bridge's `bounds` was called with `("web-1", 10, 20, 300, 200)` and the call resolves `true`
- **GIVEN** the bridge's `reload` rejects
- **WHEN** `reloadShellWebView("web-1")` is awaited
- **THEN** it resolves `false` and nothing is thrown

#### R3: The relay event parser and subscription
`lib/shell.ts` SHALL export the discriminated union `ShellWebEvent` (kinds `title`, `favicon`, `loading`, `failed`, `url`, `focus`, `zoom`, each carrying `tabKey: string` plus the fields the 3d relay sends — `title: string`; `favicons: string[]`; `loading: boolean`; `code: number, description: string, url: string`; `url: string, canGoBack: boolean, canGoForward: boolean`; none; `direction: "in" | "out"`), a pure `parseShellWebEvent(payload: unknown): ShellWebEvent | null` (null for a non-object, a missing/non-string `tabKey`, an unknown `kind`, or wrong-typed required fields; `favicons` keeps only string entries), and `onShellWebEvent(handler): () => void` which subscribes the parser-filtered handler through the bridge's `onEvent` and returns the bridge's disposer — or a no-op disposer outside the shell — so a caller may return it from an effect unconditionally.

- **GIVEN** the full `web` group whose `onEvent` records its handler and returns a disposer spy
- **WHEN** `const off = onShellWebEvent(h)` runs, the recorded handler receives `{ tabKey: "web-1", kind: "title", title: "GitHub" }`, then `{ tabKey: "web-1", kind: "bogus" }`, then `"garbage"`, then `off()`
- **THEN** `h` was called exactly once with the parsed title event, and the disposer spy was called once
- **GIVEN** a plain browser
- **WHEN** `onShellWebEvent(h)` runs
- **THEN** it returns a callable function and `h` is never called

### Engine contract: the kind union (`app/frontend/src/lib/web-frame-engine.ts`)

#### R4: `native` joins the kind union
`WebFrameEngineKind` SHALL become `"iframe" | "native"`. No other member of the contract module changes.

- **GIVEN** the widened union
- **WHEN** `createEngine` in the chrome switches over it without a `native` arm
- **THEN** `tsc --noEmit` fails (exhaustiveness is the guard)

### Preference: the selection rule (`app/frontend/src/lib/web-engine-pref.ts`)

#### R5: Per-viewer preference key and pure selection rule
A new pure module `lib/web-engine-pref.ts` SHALL export `WEB_NATIVE_ENGINE_PREF_KEY = "runkit-web-native-engine"`, `WEB_NATIVE_ENGINE_DEFAULT = true`, `readNativeEnginePref(): boolean` (localStorage read in try/catch — `"false"` ⇒ false, `"true"` or absent or a throwing storage ⇒ the default), and `selectWebEngineKind(shellWeb: boolean, nativeEnabled: boolean): WebFrameEngineKind` returning `"native"` iff both are true, else `"iframe"`. React consumers read/write the flag through the existing `useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT)` — no second localStorage pub/sub is written.

- **GIVEN** `localStorage["runkit-web-native-engine"] = "false"`
- **WHEN** `readNativeEnginePref()` runs
- **THEN** it returns `false`
- **GIVEN** the four combinations of `(shellWeb, nativeEnabled)`
- **WHEN** `selectWebEngineKind` runs
- **THEN** only `(true, true)` yields `"native"`

### Native engine (`app/frontend/src/components/web-frame-native.tsx`)

#### R6: Lifecycle — subscribe, create, register; destroy and dispose on unmount
`WebFrameNative(props: WebFrameEngineProps)` SHALL, in one mount effect keyed on `url`: (1) subscribe via `onShellWebEvent` FIRST, (2) call `createShellWebView(tabKey, absoluteUrl)` where `absoluteUrl = new URL(toProxySrc(url), window.location.origin).href` (falling back to the raw `url` if the constructor throws), (3) `registerHandle(url, handle)`. Its cleanup SHALL `unregisterHandle(url)`, call `destroyShellWebView(tabKey)`, call the subscription's disposer exactly once, and cancel any pending animation frame. `tabKey` SHALL be `web-<n>` from a module-level monotonic counter, assigned once per engine mount (a `useRef` initializer), ≤ 128 chars, and exposed on the placeholder as `data-tab-key`.

- **GIVEN** a mocked full `web` group
- **WHEN** the engine mounts with `url="/present/x/y/index.html"` on origin `http://127.0.0.1:3400`
- **THEN** `onEvent` was called before `create`, and `create` received `(tabKey, "http://127.0.0.1:3400/present/x/y/index.html")`
- **GIVEN** `url="http://localhost:8080/docs"`
- **WHEN** the engine mounts
- **THEN** `create` received the host-absolute `/proxy/8080/docs`
- **GIVEN** `url="https://github.com/x"`
- **WHEN** the engine mounts
- **THEN** `create` received `"https://github.com/x"` unchanged
- **GIVEN** a mounted engine
- **WHEN** it unmounts
- **THEN** `destroy(tabKey)` was called once and the `onEvent` disposer was called once

#### R7: Events are demuxed by tabKey and mapped into `FrameChromeState`
The engine's event handler SHALL drop any event whose `tabKey` differs from its own before any state update, and otherwise map: `title` → `title` (empty string ⇒ `null`); `favicon` → `favicon = favicons[0] ?? null`; `loading` → `loading`, and on `loading: false` additionally fire `onLoad(url)`; `url` → `trackedLocation` (same-origin as `window.location.origin` ⇒ `pathname + search + hash`; otherwise the absolute URL; an unparsable string stored raw), `canGoBack`, `canGoForward`; `failed` → `loading = false` with `tileError` left `null`; `focus` → `interactRef.current?.()`; `zoom` → ignored. The engine SHALL report `onState(url, { loading, supports: WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES, trackedLocation, title, favicon, tileError: null, canGoBack, canGoForward, find: null })` on every field change, with `loading` initially `true`.

- **GIVEN** a mounted engine with tabKey `K`
- **WHEN** the relay delivers `{ tabKey: "other", kind: "title", title: "X" }`
- **THEN** no `onState` report changes `title`
- **GIVEN** the same engine
- **WHEN** the relay delivers a `title`, a `favicon` with two entries, `loading: false`, and a same-origin `url` with `canGoBack: true`
- **THEN** the latest `onState` report carries that title, the first favicon, `loading: false`, a root-relative `trackedLocation`, `canGoBack: true`, and `onLoad(url)` fired once
- **GIVEN** the same engine
- **WHEN** the relay delivers `url` for `https://github.com/x/y`
- **THEN** `trackedLocation` is the absolute `https://github.com/x/y`
- **GIVEN** the same engine
- **WHEN** the relay delivers `focus`
- **THEN** `interactRef.current` was called
- **GIVEN** the same engine
- **WHEN** the relay delivers `failed`
- **THEN** `loading` is `false` and `tileError` is `null`

#### R8: Capabilities reported this change
`web-frame-native.tsx` SHALL export `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES = { history: false, find: false, meta: true, zoomGestures: false, devtools: false }` and report exactly it as `supports`. The handle SHALL be `{ kind: "native", reload, retry, back: no-op, forward: no-op, find: no-op, stopFind: no-op }` where `reload` and `retry` set `loading = true` and call `reloadShellWebView(tabKey)`. The `zoom` prop is accepted and unapplied; `wireGestureListeners` is never called.

- **GIVEN** a mounted engine
- **WHEN** the registered handle's `reload()` is invoked
- **THEN** `reload(tabKey)` was called on the bridge and the next report has `loading: true`
- **GIVEN** the registered handle
- **WHEN** `back()`, `forward()`, `find("x", …)`, `stopFind()` are invoked
- **THEN** no bridge call is made and nothing throws

#### R9: Placeholder paints the tile background
The engine SHALL render `<div ref data-testid="web-native-placeholder" data-tab-key={tabKey} hidden={!active} className="w-full h-full bg-bg-primary" />` and nothing else — no scale wrapper, no transform.

- **GIVEN** an inactive tab's engine
- **WHEN** it renders
- **THEN** the placeholder carries the `hidden` attribute
- **GIVEN** an active tab's engine
- **WHEN** it renders
- **THEN** the placeholder is visible with the `bg-bg-primary` class

#### R10: Bounds — measured, rounded, deduped, sent regardless of visibility
The engine SHALL own a `measure()` that reads the placeholder's `getBoundingClientRect()`, rounds `x, y, width, height` with `Math.round`, and — when `width > 0 && height > 0` and the rounded rect differs from the last SENT rect — calls `setShellWebViewBounds(tabKey, rect)` and records it; a zero-size rect sends no bounds and marks the rect as non-paintable for R11. `measure()` SHALL run from: a `ResizeObserver` on the placeholder; a dependency-less `useLayoutEffect` (after every render); a `window` `resize` listener; the drag loop (R12); and the `active → true` and `wantVisible → true` edges. Bounds are sent whether or not the guest is currently visible. Viewport coordinates are sent as-is (no offset).

- **GIVEN** a mounted active engine whose placeholder rect is `{ x: 100.4, y: 50.6, width: 640.2, height: 480 }`
- **WHEN** the ResizeObserver callback fires
- **THEN** `bounds(tabKey, 100, 51, 640, 480)` was called
- **GIVEN** the same rect again
- **WHEN** the callback fires again
- **THEN** no second `bounds` call is made
- **GIVEN** a rect of `{ 0, 0, 0, 0 }`
- **WHEN** the callback fires
- **THEN** no `bounds` call is made
- **GIVEN** a modal overlay is open (guest hidden) and the rect changes
- **WHEN** the callback fires
- **THEN** `bounds` IS still called with the new rect

#### R11: Visibility — active, no modal, non-zero rect
The engine SHALL derive `wantVisible = active && !modalOpen && rectNonZero`, where `modalOpen` is `useSyncExternalStore(subscribe, isModalOpen, () => false)` over `lib/overlay-presence.ts`. It SHALL call `setShellWebViewVisible(tabKey, wantVisible)` only when `wantVisible` changes from the last sent value, and on the `false → true` edge SHALL call `measure()` before the show. `dragging` SHALL NOT enter the expression while the named constant `HIDE_WHILE_DRAGGING` is `false` (its shipped value).

- **GIVEN** a mounted active engine with a non-zero rect
- **WHEN** `acquire("modal")` runs
- **THEN** `visible(tabKey, false)` was called; releasing it calls `visible(tabKey, true)` preceded by a `bounds` measurement
- **GIVEN** the same engine
- **WHEN** `acquire("transient")` runs
- **THEN** no `visible` call is made
- **GIVEN** an engine rendered with `active: false`
- **WHEN** it mounts
- **THEN** `visible(tabKey, false)` was sent; re-rendering with `active: true` (non-zero rect) sends `visible(tabKey, true)`

#### R12: Live resize while dragging, no hide
The engine SHALL read `useTileDragging()` (R14). While it is `true`, a `requestAnimationFrame` loop SHALL call `measure()` every frame (deduped per R10); on the `true → false` edge the loop SHALL stop and `measure()` SHALL run once more. No `visible(false)` is sent because of dragging.

- **GIVEN** a mounted active engine inside `TileDragContext.Provider value={true}` with a rect that moves each frame
- **WHEN** three animation frames are pumped
- **THEN** three `bounds` calls were made and no `visible(…, false)` call was made
- **GIVEN** the provider value flips to `false`
- **WHEN** the effect re-runs
- **THEN** exactly one further `measure()` runs and no further frames are scheduled

### Chrome (`app/frontend/src/components/iframe-window.tsx`)

#### R13: Engine selection per kind with a live flip
`IframeWindow` SHALL replace the module-level `ENGINE_KIND`/`Engine` with a per-render selection: `const [nativeEnabled] = useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT)`, `const engineKind = selectWebEngineKind(canShellWeb(), nativeEnabled)`, `const Engine = createEngine(engineKind)` where `createEngine` has an exhaustive arm per kind (`iframe` → `WebFrameIframe`, `native` → `WebFrameNative`). Each engine mounts under `key={\`${engineKind}:${tabUrl}\`}`. The pre-report capability seed SHALL be `activeChrome?.supports ?? DEFAULT_CAPABILITIES[engineKind]` with `DEFAULT_CAPABILITIES: Record<WebFrameEngineKind, WebFrameCapabilities>` mapping to each engine module's exported default. Nothing else in the chrome changes.

- **GIVEN** jsdom with no bridge
- **WHEN** the chrome renders two tabs
- **THEN** two iframe engines mount regardless of the stored preference
- **GIVEN** `canShellWeb()` mocked `true` and the preference `true`
- **WHEN** the chrome renders
- **THEN** the native engine mounts, ◀ ▶ are hidden, and the find bar (when opened) is disabled with its hint
- **GIVEN** the native engine mounted
- **WHEN** the preference flips to `false` through the hook's setter
- **THEN** the native engine unmounts and the iframe engine mounts for every tab

### Palette (`app/frontend/src/lib/palette/web-engine.ts`, `app/frontend/src/app.tsx`)

#### R14: `Web: Use embedded browser` — shell-gated, no chord
A pure builder `buildWebEngineActions({ available, enabled, onToggle })` SHALL return `[]` when `available` is false and otherwise one action `{ id: "web-native-engine", label: "Web: Use embedded browser" + (enabled ? " ✓" : ""), onSelect: () => onToggle(!enabled) }`. `app.tsx` SHALL register it beside `shellServerActions` with `available: canShellWeb()`, `enabled`/`onToggle` from `useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT)`, folded into the same `paletteActions` array. No keybinding is added.

- **GIVEN** `available: false`
- **WHEN** the builder runs
- **THEN** it returns `[]`
- **GIVEN** `available: true, enabled: true`
- **WHEN** the builder runs and the action is selected
- **THEN** the label is `Web: Use embedded browser ✓` and `onToggle(false)` was called

### Drag context (`app/frontend/src/lib/tile-drag-context.ts`, `app/frontend/src/components/surface-layout.tsx`)

#### R15: The drag flag crosses to the engine as a context
A new `lib/tile-drag-context.ts` SHALL export `TileDragContext = createContext(false)` and `useTileDragging(): boolean`. `SurfaceLayout` SHALL wrap its tile grid render in `<TileDragContext.Provider value={draggingIndex !== null || draggingIntersection}>`; the existing mid-drag `pointer-events-none` class stays.

- **GIVEN** a rendered `SurfaceLayout` with a web tile
- **WHEN** a divider receives `pointerdown`
- **THEN** a context reader inside the tile reads `true`; after `pointerup` it reads `false`

### Non-Goals

- `web:back`/`web:forward`/`web:find`/`web:zoom`/`web:devtools`, chord forwarding, `TileError` mapping from `failed` codes, stepping the zoom bucket from `zoom` events — change 4 (parity).
- The Playwright Electron lane and spec rows — change 5.
- Any change under `app/desktop/` or `app/backend/`; any e2e spec edit; any settings-registry key; any route.

### Design Decisions

#### Engine selection is bridge presence × viewer preference
**Decision**: `selectWebEngineKind(canShellWeb(), nativeEnabled)` — the `web` group's own presence gates the native engine, and a per-viewer localStorage boolean (default on) can turn it off.
**Why**: The bridge group's presence is the truthful signal that the shell can host guests (an older shell reports `version`/`platform` but no `web`); a per-viewer flag is Constitution IV's home for viewer state and gives an escape hatch while the engine matures.
**Rejected**: Gating on `isShell()` (a second, less accurate signal); a settings-registry key (a per-instance preference for a per-viewer concern, and a new registry surface).
*Introduced by*: 260916-q2xk-web-frame-native-engine

#### Live resize, not hide, during sash drags
**Decision**: While a layout drag is in progress the engine sends deduped bounds on every animation frame and never hides the guest; `HIDE_WHILE_DRAGGING = false` is the named option.
**Why**: The spike measured rAF bounds holding the guest within 1–2 px of the tile edge with no lag; a hide-then-restore would flash the card on every drag for no gain.
**Rejected**: Hide-while-dragging by default (a visible flash per drag); throttling bounds below frame rate (visible lag).
*Introduced by*: 260916-q2xk-web-frame-native-engine

#### The relay subscription is disposed with the engine
**Decision**: `onShellWebEvent` always returns a disposer and the engine's mount-effect cleanup calls it; events are demuxed by `tabKey` before any state update.
**Why**: In the spike a subscription that could not be dropped leaked one listener per engine mount, re-dispatched each chord N times, and toggled the palette shut.
**Rejected**: One module-level singleton listener fanning out over a tabKey map (hides the leak instead of preventing it and outlives the component tree).
*Introduced by*: 260916-q2xk-web-frame-native-engine

#### The drag flag crosses to the engine as a context, not an engine prop
**Decision**: `TileDragContext` provided by `SurfaceLayout`, read by the native engine via `useTileDragging()`.
**Why**: The flag is a layout fact only one engine consumes; threading it through `IframeWindow` and `WebFrameEngineProps` would make the iframe engine carry a prop it ignores.
**Rejected**: Widening `WebFrameEngineProps` with `dragging` (contract noise for one consumer).
*Introduced by*: 260916-q2xk-web-frame-native-engine

#### Capabilities report what the bridge can do today
**Decision**: The native engine reports `history: false` and `zoomGestures: false` until change 4 adds `web:back`/`web:forward` and steps the bucket from `zoom` relays; `canGoBack`/`canGoForward` are tracked from `url` events regardless.
**Why**: The chrome renders per capability precisely so a control is hidden rather than dead; the merged bridge has no back/forward channel.
**Rejected**: The plan seed's `history: true` (◀ ▶ rendered as no-ops).
*Introduced by*: 260916-q2xk-web-frame-native-engine

## Tasks

### Phase 1: Setup

- [x] T001 Widen `WebFrameEngineKind` to `"iframe" | "native"` in `app/frontend/src/lib/web-frame-engine.ts` (no other contract change) <!-- R4 -->
- [x] T002 [P] Create `app/frontend/src/lib/web-engine-pref.ts` (`WEB_NATIVE_ENGINE_PREF_KEY`, `WEB_NATIVE_ENGINE_DEFAULT`, `readNativeEnginePref`, `selectWebEngineKind`) + colocated `web-engine-pref.test.ts` (truth table; default / stored true / stored false / throwing storage) <!-- R5 -->
- [x] T003 [P] Create `app/frontend/src/lib/tile-drag-context.ts` (`TileDragContext = createContext(false)`, `useTileDragging`) <!-- R15 -->

### Phase 2: Core Implementation

- [x] T004 Add the `web` group narrowing to `app/frontend/src/lib/shell.ts`: `ShellWebBridge`, `isWebBridge`, `webBridge()`, `canShellWeb()`, `ShellWebRect`, the six never-throwing invokers, `ShellWebEvent`, `parseShellWebEvent`, `onShellWebEvent` (always returns a disposer) — following the file's existing additive-group pattern; extend `app/frontend/src/lib/shell.test.ts` with `canShellWeb` (plain browser / partial group / full group), every invoker's true and false paths, `parseShellWebEvent` per kind + malformed payloads (non-object, missing tabKey, unknown kind, wrong-typed field, non-string favicon entries dropped), and `onShellWebEvent` (no-op disposer outside the shell; forwards parsed events; drops malformed; disposer calls the bridge's disposer) <!-- R1 R2 R3 -->
- [x] T005 Create `app/frontend/src/components/web-frame-native.tsx`: `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES`, the module-level tabKey counter, the mount effect (subscribe → create → registerHandle; cleanup unregister → destroy → dispose → cancel rAF), the tabKey-demuxed event handler and `toTracked`, the `onState` report effect, the handle, the placeholder, `measure()` with rounding + dedupe + zero-rect rule, the ResizeObserver / dependency-less `useLayoutEffect` / window `resize` triggers, the `useSyncExternalStore` modal read, the `wantVisible` effect (measure before show), the `HIDE_WHILE_DRAGGING = false` option, and the drag rAF loop via `useTileDragging()` <!-- R6 R7 R8 R9 R10 R11 R12 -->
- [x] T006 Create `app/frontend/src/components/web-frame-native.test.tsx` (Vitest + RTL): mocked `window.runkitShell.web` (`vi.fn()` invokers resolving `{ ok: true }`, `onEvent` capturing the handler and returning a disposer spy), a controllable `ResizeObserver` mock, a stubbed `getBoundingClientRect` on the placeholder, a manual `requestAnimationFrame` pump, `_resetForTests()` in `beforeEach`; cover R6 (subscribe before create; the three URL shapes; destroy + disposer once on unmount), R7 (foreign tabKey ignored; title/favicon/loading/url mapping; `onLoad` on `loading:false`; external URL absolute; `focus` → interact; `failed` → loading false, tileError null), R8 (handle reload → bridge reload + loading true; no-op verbs; default capabilities), R9 (hidden attribute per `active`), R10 (rounded bounds; dedupe; zero rect sends none; bounds sent while hidden), R11 (modal acquire/release; transient ignored; `active:false` → visible false; `active:true` → visible true), R12 (three frames → three bounds, no hide; stop edge measures once) <!-- R6 R7 R8 R9 R10 R11 R12 -->
- [x] T007 Rewire `app/frontend/src/components/iframe-window.tsx`: import `WebFrameNative` + `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES`, `useLocalStorageBoolean`, `WEB_NATIVE_ENGINE_PREF_KEY`/`WEB_NATIVE_ENGINE_DEFAULT`/`selectWebEngineKind`, `canShellWeb`; exhaustive `createEngine`; `DEFAULT_CAPABILITIES` per kind; per-render `engineKind`/`Engine`; `key={`${engineKind}:${tabUrl}`}`; seed `supports` from `DEFAULT_CAPABILITIES[engineKind]`; remove `ENGINE_KIND` <!-- R13 -->
- [x] T008 Extend `app/frontend/src/components/iframe-window.stub-engine.test.tsx` with an engine-selection block (module-mock `@/lib/shell`'s `canShellWeb` and `@/components/web-frame-native` with a recording stub alongside the existing iframe stub): no bridge ⇒ iframe regardless of pref; bridge + pref true ⇒ native, ◀ ▶ hidden, find bar disabled with hint; bridge + pref false ⇒ iframe; flipping the pref via `localStorage` + the hook's setter (or the pub/sub) remounts the other stub <!-- R13 -->

### Phase 3: Integration & Edge Cases

- [x] T009 Create `app/frontend/src/lib/palette/web-engine.ts` (`WEB_NATIVE_ENGINE_ACTION_ID = "web-native-engine"`, `buildWebEngineActions`) + colocated `web-engine.test.ts` (`[]` when unavailable; both label forms; `onSelect` → `onToggle(!enabled)`) <!-- R14 -->
- [x] T010 Register the entry in `app/frontend/src/app.tsx` beside `shellServerActions`: `useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT)` + `useMemo(() => buildWebEngineActions({ available: canShellWeb(), enabled, onToggle }), …)` folded into `paletteActions` (and its deps array) <!-- R14 -->
- [x] T011 Wrap the tile grid in `app/frontend/src/components/surface-layout.tsx` with `<TileDragContext.Provider value={draggingIndex !== null || draggingIntersection}>` (the `pointer-events-none` class stays); add a `surface-layout.test.tsx` case proving a context reader inside the web tile flips `false → true → false` across a divider `pointerdown`/`pointerup` (and the intersection drag) <!-- R15 -->

### Phase 4: Polish

- [x] T012 Verification gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (whole suite); `just test-e2e "e2e/web-tabs.spec"` then `just test-e2e "e2e/web-tile-chrome.spec"` (one spec per run — both drive the iframe engine and must pass unchanged); fix anything red that this change caused <!-- R13 -->

## Execution Order

- T001 blocks T005 and T007 (the `native` kind must exist)
- T002 blocks T007 and T010; T003 blocks T005 and T011
- T004 blocks T005 (the engine imports the invokers)
- T005 blocks T006 and T007
- T007 blocks T008; T009 blocks T010
- T012 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `canShellWeb()` is false in a plain browser, on a missing `web` group, and on a partial group; true on the full seven-member group — proven in `shell.test.ts`
- [x] A-002 R2: All six invokers exist, resolve `true` only on `{ ok: true }`, resolve `false` on absent group / rejected invoke / other shapes, and never throw — proven in `shell.test.ts`
- [x] A-003 R3: `parseShellWebEvent` accepts each of the seven kinds with correct field typing and returns null on malformed payloads; `onShellWebEvent` returns a disposer in every environment and forwards only parsed events — proven in `shell.test.ts`
- [x] A-004 R4: `WebFrameEngineKind` is `"iframe" | "native"` and the chrome's `createEngine` switch is exhaustive
- [x] A-005 R5: `web-engine-pref.ts` exports the key, default, `readNativeEnginePref`, `selectWebEngineKind`; the truth table and storage cases are proven in `web-engine-pref.test.ts`
- [x] A-006 R6: The native engine subscribes before creating, creates with the host-absolute URL for present / loopback / external shapes, and on unmount destroys the guest and disposes the subscription exactly once — proven in `web-frame-native.test.tsx`
- [x] A-007 R7: Events for another tabKey are ignored; title/favicon/loading/url/failed/focus map as specified; `onLoad` fires on `loading:false` — proven in `web-frame-native.test.tsx`
- [x] A-008 R8: `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES` equals `{ history: false, find: false, meta: true, zoomGestures: false, devtools: false }`; the handle's `reload`/`retry` call the bridge and set loading; `back`/`forward`/`find`/`stopFind` are no-ops
- [x] A-009 R9: The placeholder renders with `data-testid="web-native-placeholder"`, `data-tab-key`, `hidden={!active}`, `bg-bg-primary`, and no transform
- [x] A-010 R10: Bounds are rounded, deduped against the last sent rect, never sent for a zero-size rect, and sent while hidden — proven in `web-frame-native.test.tsx`
- [x] A-011 R11: `visible(false)` on modal acquire, `visible(true)` (after a measure) on release, nothing on transient, `visible(false)` for an inactive tab — proven in `web-frame-native.test.tsx`
- [x] A-012 R12: Three pumped frames while dragging send three bounds and no hide; the stop edge measures once — proven in `web-frame-native.test.tsx`
- [x] A-013 R13: The chrome selects the engine per render via `selectWebEngineKind(canShellWeb(), pref)`, mounts under `${kind}:${url}` keys, and seeds capabilities per kind — proven in `iframe-window.stub-engine.test.tsx`
- [x] A-014 R14: `buildWebEngineActions` returns `[]` when unavailable and the ✓-suffixed toggle otherwise; `app.tsx` registers it beside `shellServerActions` with `available: canShellWeb()`
- [x] A-015 R15: `TileDragContext` is provided by `SurfaceLayout` with the drag expression and read via `useTileDragging()` — proven in `surface-layout.test.tsx`

### Behavioral Correctness

- [x] A-016 R13: In jsdom (no bridge) every existing `iframe-window.test.tsx` and `web-frame-iframe.test.tsx` case passes unchanged — the iframe engine's behavior is untouched
- [x] A-017 R13: A preference flip remounts every tab on the other engine (the outgoing native engines destroy their guests in cleanup)
- [x] A-018 R11: Dragging alone never produces a `visible(false)` call (`HIDE_WHILE_DRAGGING` is `false`)

### Scenario Coverage

- [x] A-019 R6: The three URL shapes (`/present/…`, `http://localhost:8080/…` → `/proxy/8080/…`, `https://…`) each reach `create` host-absolute
- [x] A-020 R7: A same-origin `url` relay stores a root-relative `trackedLocation`; an external one stores the absolute URL
- [x] A-021 R10: A modal-hidden guest still receives updated bounds (main parks them)

### Edge Cases & Error Handling

- [x] A-022 R2: A rejecting bridge invoke resolves `false` without throwing
- [x] A-023 R3: A `favicon` payload with a non-string entry keeps the string entries and drops the rest; an unknown `kind` yields null
- [x] A-024 R6: A URL that fails the `URL` constructor is passed to `create` raw (no throw)
- [x] A-025 R10: A zero-size rect (hidden tab / collapsed tile) sends no bounds and drives `visible(false)`

### Code Quality

- [x] A-026 Pattern consistency: `shell.ts` additions follow the existing additive-group narrowing pattern (private interface, type guard, accessor, never-throwing invokers); `web-frame-native.tsx` mirrors `web-frame-iframe.tsx`'s engine shape (props, report effect, handle registration, refs)
- [x] A-027 No unnecessary duplication: the preference reuses `useLocalStorageBoolean`; the URL mapping reuses `toProxySrc`; the modal signal reuses `lib/overlay-presence.ts`; no second localStorage pub/sub or overlay registry is written
- [x] A-028 Type narrowing over assertions: no `as` casts in the bridge narrowing or event parser — `if` guards and the discriminated union only
- [x] A-029 Tests cover the added behavior: every new module has a colocated test; the chrome and layout changes each have a test case
- [x] A-030 Named constants: `WEB_NATIVE_ENGINE_PREF_KEY`, `WEB_NATIVE_ENGINE_DEFAULT`, `WEB_NATIVE_ENGINE_ACTION_ID`, `HIDE_WHILE_DRAGGING`, `WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES` — no magic strings for the key, id, or option
- [x] A-031 Comments state constraints, not history: file headers explain siblings-above-DOM, disposer discipline, live-resize, parked bounds, coordinate identity — no change-ID citations, no narration
- [x] A-032 No polling: the modal signal is a subscription, bounds are event/observer/rAF driven — no `setInterval`
- [x] A-033 Verification gates green: `tsc --noEmit`, `just test-frontend`, and the two single-spec e2e smokes pass

### Security

- [x] A-034 R3: Relay payloads are treated as untrusted — structurally parsed before any state update; malformed payloads are dropped
- [x] A-035 R6: The engine only ever asks the shell to load an http(s)/host-absolute URL derived from the stored tab address; no `runkitShell` member beyond the `web` group is touched

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds a second engine alongside the iframe engine without making existing code redundant. The only removals (`ENGINE_KIND` and the module-level `Engine` in `iframe-window.tsx`) were performed by the change itself.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `onLoad(url)` fires on every `loading: false` relay (the guest's `did-stop-loading`) | The contract's per-completed-load edge; the only completion signal the relay carries | S:85 R:95 A:90 D:85 |
| 2 | Certain | `modalOpen` is read with `useSyncExternalStore(subscribe, isModalOpen, () => false)` inline in the engine file | Single consumer today; the registry module is the only source; a hook file can be extracted when a second consumer appears | S:85 R:95 A:95 D:85 |
| 3 | Certain | Bounds dedupe compares rounded integers; `ResizeObserver`/rAF/`useLayoutEffect` all funnel through one `measure()` | One send path keeps the dedupe and the zero-rect rule in one place | S:85 R:95 A:95 D:90 |
| 4 | Certain | The chrome test drives the preference flip through `localStorage.setItem` + the hook's in-module notify (rendering a small toggler component) rather than a fake `storage` event | `useLocalStorageBoolean`'s same-tab pub/sub is the production path | S:80 R:95 A:90 D:85 |

4 assumptions (4 certain, 0 confident, 0 tentative).
