# Intake: Web Frame Native Engine

**Change**: 260916-q2xk-web-frame-native-engine
**Created**: 2026-09-16

## Origin

One-shot `/fab-new` invocation, autonomous (the user is not watching; the intake proceeds straight into `/fab-fff`, full lane). Change **3f of 6** (the frontend half of "Change 3 — shell web views") in the plan `fab/plans/sahil/26-09-16-web-tile-native-browser.md`, which came out of the 2026-09-16 `/fab-discuss` session on replacing the web tile's iframe with Electron's Chromium renderer in the desktop shell. Design authority: `docs/wiki/web-tile-native-browser-studies.html` (§3 engine contract, §4 architecture + bridge channels, §5 layering rule set, §14 closed decisions). Every prerequisite is merged on `main`: change 0 (the spike, never merged — its verdict is in the plan), change 1 (`260916-fxt1-web-frame-engine-seam`, PR #993 — `lib/web-frame-engine.ts`, `components/web-frame-iframe.tsx`, the engine-blind chrome), change 2 (`260916-ter5-overlay-presence-registry`, PR #999 — `lib/overlay-presence.ts`, `hooks/use-occludes.ts`, toasts over chrome), change 3d (`260916-crb3-desktop-web-views-bridge`, PR #1000 — `app/desktop/src/web-views.ts`, the six `web:*` IPC channels, the `web:event` relay, the `runkitShell.web` preload group whose `onEvent` returns the disposer). This worktree's branch is `web-frame-native-engine` off `a7a71aaf` (main after #1000).

> In a shell that carries the web bridge group the web tile mounts a native engine — it measures the tile content rect, drives the view over the bridge, feeds the chrome from the event channel, hides while a modal overlay is open, and offers a per-viewer palette toggle back to the iframe engine.
>
> Full context lives in fab/plans/sahil/26-09-16-web-tile-native-browser.md — read the whole file before starting, especially "## Change 3 — shell web views" (the "Intake seed (3f)" and numbered items 7-12 — this change covers ONLY the frontend/3f half; the desktop/3d half, `app/desktop/src/web-views.ts` and its bridge, is already merged), "## Standing context" and "## Decisions of record", and CRITICALLY the "## Spike verdict" section at the bottom — change 0's spike found guests must be SIBLINGS of the host view (not children), and the verdict's "Adjustments to changes 1-5" bullet for "Change 3f" spells out this change's exact requirements: the engine's onWebEvent subscription MUST return an unsubscribe and the effect MUST dispose it (a leaked listener re-dispatched chords N times and the palette toggled itself shut in the spike), demux by tabKey, and the mid-drag rule is LIVE RESIZE (send bounds on every animation frame while dragging, no hide by default — not the hide-then-restore approach). Also read overlay-presence-registry's lib/overlay-presence.ts and hooks/use-occludes.ts (change 2, already merged) and app/desktop/src/web-views.ts + preload.ts's web bridge group (change 3d, already merged) since this change consumes both directly. This is change 3f of 6 in the plan — full lane. After intake, proceed through the full pipeline yourself (fab-fff) to implementation, review, hydrate, ship, and PR.

Key decisions carried from the plan, the spike verdict, and the merged 3d contract (all apply here):

- **Two engines behind one chrome; the iframe engine is never removed.** `IframeWindow` stays the chrome and gains a second engine component, `components/web-frame-native.tsx`, selected per mount by `createEngine(kind)`. Browsers, PWAs and phones keep the `iframe` engine unchanged; every e2e spec drives the iframe engine and stays green.
- **The event subscription is disposed with the engine.** `runkitShell.web.onEvent(handler)` returns the unsubscribe (shipped in 3d); the SPA wrapper `onShellWebEvent` returns it too, and the engine's mount effect calls it in cleanup. Events are demuxed by `tabKey` — an event for another tab is dropped before any state update. (Spike: a leaked listener re-dispatched each chord N times and the palette toggled itself shut.)
- **Mid-drag rule is LIVE RESIZE.** While a sash or intersection drag is in progress the engine measures the placeholder and sends `web:bounds` on every animation frame (`requestAnimationFrame` loop) and never hides for the drag. Hide-while-dragging stays a named engine constant defaulting to off — an option, not the behavior.
- **Hide while a modal overlay is open.** `web:visible {false}` while `isModalOpen()` (from `lib/overlay-presence.ts`, subscribed via `subscribe`) is true; `web:visible {true}` when it returns to false. Only `modal` hides; `transient` never does. Bounds are still measured and sent while hidden — main parks them and applies them on show (3d contract).
- **Coordinates.** The host view fills the window content area (`syncViewBounds` → `{0, 0, contentWidth, contentHeight}`, desktop-shell.md § Web Views), so SPA viewport coordinates from `getBoundingClientRect()` ARE host-view coordinates and no offset is added — the shell titlebar strip is SPA-drawn DOM inside the same viewport. The "confirm the titlebar strip offset" note in plan item 8 is answered by the merged 3d memory: no offset.
- **Addressing.** The native engine loads exactly what the iframe loads, made absolute against the host origin: `new URL(toProxySrc(url), window.location.origin).href`. `/proxy/{port}` stays the path for ports.
- **Per-viewer opt-out.** A palette entry `Web: Use embedded browser` toggles a localStorage boolean (Constitution IV per-viewer state, not a settings-registry key); default on in a shell that carries the `web` bridge group; absent everywhere else. Toggling flips the mounted tile's engine live (engines remount under a kind-qualified key).
- **Placeholder paints the tile background.** The engine renders a `bg-bg-primary` div filling the zoom wrapper so a hidden guest leaves the card, not a hole (spike-confirmed).
- **Non-goals (this change)**: find, real back/forward (`web:back`/`web:forward` do not exist in the 3d bridge), zoom application in the guest (`web:zoom`), chord forwarding / `before-input-event` / `web:chords`, error-code → `TileError` mapping and error copy, devtools, downloads/popups beyond the shipped external policy — all change 4; the Playwright Electron lane and spec rows — change 5; any `app/desktop/` change; any backend change; the code lens.

## Why

**Problem.** The web tile renders every address in an `<iframe>`. Any site that sends `X-Frame-Options` / `frame-ancestors` (GitHub, Google, most SaaS dashboards) refuses to embed, so the tile paints "refuses embedding" and the user leaves the shell to read the page. Change 1 made the chrome engine-blind (capability flags, `FrameChromeState`, one engine component per tab behind `createEngine(kind)`) and change 3d gave the desktop shell a guest `WebContentsView` per (window, host, tabKey) behind six gated `web:*` IPC channels plus one `web:event` relay — but nothing in `app/frontend/` calls `runkitShell.web` yet. The bridge exists with no consumer, and the tile still embeds nothing GitHub refuses.

**Consequence of not doing it.** The native-browser plan has no user-visible effect at all: 3d's registry, partition, z-order plans and relay sit idle; change 4 (parity — history/find/zoom/chords/errors/devtools) has no engine to extend; change 5 (the Electron e2e lane) has nothing to prove. The refusal wall stays.

**Why this approach.** Every piece follows a shipped precedent. `lib/shell.ts` narrows additive bridge groups structurally (`serversBridge()`, `windowsBridge()`, `badgeBridge()`, `accentBridge()` — never-throwing invokers resolving `boolean`); this change adds `webBridge()`, `canShellWeb()`, typed invokers, and an `onShellWebEvent` subscription whose payloads are parsed structurally (`parseShellWebEvent`) before they reach React. `components/web-frame-iframe.tsx` is the shape of an engine (props from `WebFrameEngineProps`, `onState` reports, a registered handle, refs for the late-bindable seams); the native engine implements the same contract over the bridge instead of an element. `lib/overlay-presence.ts` was built for exactly this subscriber (its module comment names "the engine's bridge effect subscribes from outside React"). `hooks/use-local-storage-boolean.ts` already gives a same-tab-synced persisted boolean with try/catch reads — the opt-out reuses it rather than writing a second localStorage pub/sub. The palette entry follows the `lib/palette/*.ts` pure-builder convention and the `canNewShellWindow()`-style bridge-presence gate. The spike closed the layering questions: `setVisible(false)` lands 21–40 ms after the palette keypress with no hole, rAF bounds keep the guest within 1–2 px of the tile edge during a drag with no hide, the placeholder reads as the card.

**Behavior contract.** In a plain browser, a PWA, or an older shell without the `web` group: no behavior change whatsoever — `createEngine` resolves `iframe`, the palette entry is absent, nothing touches the bridge. In a shell that carries the `web` group with the preference on (default): every web tab's content renders in a guest `WebContentsView` positioned over the tile content rect; the tab strip shows the guest's title and favicon; the progress line follows the guest's loading; the address bar shows the guest's current URL (display form); the guest hides while the palette, any dialog, the settings panel, the quake drawer, the screen-break egg, or the mobile drawer is open and reappears on close; sash drags resize the guest live; switching tabs hides the outgoing guest and shows the incoming one; closing a tab or switching windows destroys its guest; the ◀ ▶ buttons are hidden (no history capability yet) and the find bar renders disabled with its hint; the zoom control changes the bucket but not the guest (change 4). Toggling `Web: Use embedded browser` off remounts every tab on the iframe engine; toggling it on remounts them native.

## What Changes

### 1. `app/frontend/src/lib/shell.ts` — the `web` bridge group narrowing + typed invokers + event parser

Follow the file's additive-group pattern exactly (`windowsBridge()` / `badgeBridge()` / `accentBridge()`): a private interface, a structural type guard, a private accessor, exported never-throwing invokers.

```ts
/** The bridge's `web` group — the web tile's native-engine channels. Shipped
 *  whole in one shell release, so all seven members are required together. */
interface ShellWebBridge {
  create: (tabKey: string, url: string) => Promise<unknown>;
  destroy: (tabKey: string) => Promise<unknown>;
  bounds: (tabKey: string, x: number, y: number, width: number, height: number) => Promise<unknown>;
  visible: (tabKey: string, visible: boolean) => Promise<unknown>;
  load: (tabKey: string, url: string) => Promise<unknown>;
  reload: (tabKey: string) => Promise<unknown>;
  onEvent: (handler: (payload: unknown) => void) => () => void;
}

function isWebBridge(value: unknown): value is ShellWebBridge { /* all seven typeof === "function" */ }
function webBridge(): ShellWebBridge | null { /* window.runkitShell?.web, narrowed */ }

/** True when the shell can host web-tile guests (`runkitShell.web` present). */
export function canShellWeb(): boolean;

export interface ShellWebRect { x: number; y: number; width: number; height: number }

export async function createShellWebView(tabKey: string, url: string): Promise<boolean>;
export async function destroyShellWebView(tabKey: string): Promise<boolean>;
export async function setShellWebViewBounds(tabKey: string, rect: ShellWebRect): Promise<boolean>;
export async function setShellWebViewVisible(tabKey: string, visible: boolean): Promise<boolean>;
export async function loadShellWebView(tabKey: string, url: string): Promise<boolean>;
export async function reloadShellWebView(tabKey: string): Promise<boolean>;
```

Each invoker resolves `false` outside the shell, on an older shell without the group, on a rejected invoke, or on a non-`{ok: true}` result — the `newShellWindow()` posture, never throws.

The relay payload is `unknown` at the preload boundary (`onEvent` passes it through); the SPA parses it structurally into a discriminated union mirroring the 3d relay table (desktop-shell.md § Web Views):

```ts
export type ShellWebEvent =
  | { tabKey: string; kind: "title"; title: string }
  | { tabKey: string; kind: "favicon"; favicons: string[] }
  | { tabKey: string; kind: "loading"; loading: boolean }
  | { tabKey: string; kind: "failed"; code: number; description: string; url: string }
  | { tabKey: string; kind: "url"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { tabKey: string; kind: "focus" }
  | { tabKey: string; kind: "zoom"; direction: "in" | "out" };

/** Structural parse of one relay payload; null for anything malformed or an
 *  unknown kind (a newer shell may relay kinds this SPA does not know). */
export function parseShellWebEvent(payload: unknown): ShellWebEvent | null;

/** Subscribe to the relay. Returns the unsubscribe — ALWAYS, including the
 *  no-op disposer outside the shell — so a mount effect can return it
 *  unconditionally. Malformed payloads are dropped before `handler`. */
export function onShellWebEvent(handler: (event: ShellWebEvent) => void): () => void;
```

`favicons` entries must each be strings (drop non-strings, never reject the whole event on one bad entry). `zoom.direction` accepts only `"in"` or `"out"` (Electron's `zoom-changed` values). Unit tests in `shell.test.ts`: `canShellWeb()` false in a plain browser / on a partial group / true on the full group; each invoker's false-paths; `parseShellWebEvent` per kind plus malformed cases; `onShellWebEvent` returns a callable disposer outside the shell, forwards parsed events, drops malformed payloads, and its disposer calls the preload's disposer.

### 2. `app/frontend/src/lib/web-frame-engine.ts` — widen the kind union

```ts
export type WebFrameEngineKind = "iframe" | "native";
```

Nothing else in the contract module changes. `WebFrameEngineHandle.kind` and `createEngine`'s exhaustive switch pick the new member up (a missing arm is a compile error, by design).

### 3. `app/frontend/src/lib/web-engine-pref.ts` (new, pure) — the per-viewer preference + the selection rule

```ts
/** localStorage key for the per-viewer engine preference. `"true"` (or absent
 *  — the default) selects the native engine when the shell offers it;
 *  `"false"` keeps the iframe engine. Per-viewer state (Constitution IV),
 *  never POSTed, not a settings-registry key. */
export const WEB_NATIVE_ENGINE_PREF_KEY = "runkit-web-native-engine";
export const WEB_NATIVE_ENGINE_DEFAULT = true;

/** Non-React read (try/catch; absent or unreadable ⇒ the default). */
export function readNativeEnginePref(): boolean;

/** THE selection rule — bridge presence × viewer preference. Pure so both the
 *  chrome and the palette builder share one answer. */
export function selectWebEngineKind(shellWeb: boolean, nativeEnabled: boolean): WebFrameEngineKind {
  return shellWeb && nativeEnabled ? "native" : "iframe";
}
```

React consumers read and write the flag through the existing `useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT)` (`hooks/use-local-storage-boolean.ts` — same-tab pub/sub so the chrome and the palette entry stay in sync without a reload). Colocated `web-engine-pref.test.ts`: the four-cell truth table of `selectWebEngineKind`, `readNativeEnginePref` default / stored true / stored false / storage throwing.

### 4. `app/frontend/src/components/web-frame-native.tsx` (new) — the engine

`WebFrameNative(props: WebFrameEngineProps)` implements the contract over the bridge. File header states the constraints (siblings above the DOM, disposer discipline, live-resize rule, parked bounds, coordinate identity) — not history.

**Capabilities (this change)** — exported for the chrome's pre-report seed, the `WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES` precedent:

```ts
export const WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES: WebFrameCapabilities = {
  history: false,      // no web:back/web:forward channel exists yet (change 4 adds them and flips this)
  find: false,         // web:find arrives in change 4
  meta: true,          // title / favicon / url relayed by 3d
  zoomGestures: false, // the zoom-changed relay becomes a bucket step in change 4
  devtools: false,     // web:devtools arrives in change 4
};
```

The plan's seed listed `history: true` and `zoomGestures: true`; the merged 3d bridge has no back/forward channel and the SPA does not yet step the bucket from `zoom` events, so both are reported honestly as `false` here and flip in change 4 (the chrome renders per capability — a hidden ◀ ▶ is correct, a dead one is not). `canGoBack`/`canGoForward` from `url` events are still stored and reported so change 4 only flips the flag.

**tabKey**: a module-level monotonic counter — `web-${++mountSeq}` — assigned once per engine mount (`useRef` initializer). Unique under the host webContents (one SPA renderer, one counter), ≤ 128 chars (3d's `isTabKey` bound), fresh per remount so a StrictMode replay or a kind flip never reuses a key. Exposed as `data-tab-key` on the placeholder for tests and the change-5 e2e lane.

**Mount effect (one effect, mount-scoped, keyed on `url`)** — in this order:

1. `const dispose = onShellWebEvent(handleEvent)` — subscribe FIRST so no early relay is missed.
2. `void createShellWebView(tabKey, absoluteUrl)` where `absoluteUrl = new URL(toProxySrc(url), window.location.origin).href` (a `try/catch` around the URL constructor falls back to the raw `url` — `toProxySrc` already passes unknown shapes through).
3. `registerHandle(url, handle)`.
4. Cleanup: `unregisterHandle(url)`, `void destroyShellWebView(tabKey)`, `dispose()`, cancel any pending rAF.

`handleEvent(ev)`: `if (ev.tabKey !== tabKey) return;` then per kind:

| kind | effect on engine state |
|---|---|
| `title` | `title = ev.title === "" ? null : ev.title` |
| `favicon` | `favicon = ev.favicons[0] ?? null` |
| `loading` | `loading = ev.loading`; on `false` also fire `onLoadRef.current(url)` (the per-completed-load edge the chrome resets its find query on) |
| `url` | `trackedLocation = toTracked(ev.url)`, `canGoBack = ev.canGoBack`, `canGoForward = ev.canGoForward` |
| `failed` | `loading = false`; `tileError` stays `null` — the `TileError` mapping is change 4 |
| `focus` | `interactRef.current?.()` — the tile-focus seam (the iframe engine's in-frame pointerdown/keydown equivalent) |
| `zoom` | ignored this change (change 4 steps the bucket) |

`toTracked(absolute)`: when the URL's origin equals `window.location.origin`, store it root-relative (`pathname + search + hash` — the iframe engine's display convention, so `displayForm` sees the same shape); otherwise store the absolute URL (strictly more than the iframe engine can offer for external pages — the address bar shows where the guest navigated). A `URL` constructor failure stores the raw string.

**State report**: one `useEffect` reporting `onState(url, { loading, supports: WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES, trackedLocation, title, favicon, tileError: null, canGoBack, canGoForward, find: null })` on every field change — the iframe engine's report effect, verbatim shape. `loading` starts `true` (the create issues a load).

**Handle**:

```ts
{
  kind: "native",
  reload: () => { setLoading(true); void reloadShellWebView(tabKey); },
  retry: /* same as reload */,
  back: () => {}, forward: () => {},     // no channel yet — the chrome hides the buttons (history: false)
  find: () => {}, stopFind: () => {},    // find: false — the chrome renders the bar disabled
}
```

**Placeholder**: `<div ref={placeholderRef} data-testid="web-native-placeholder" data-tab-key={tabKey} hidden={!active} className="w-full h-full bg-bg-primary" />` — fills the chrome's zoom wrapper (`flex-1 min-h-0 overflow-hidden`), paints the tile background so a hidden or not-yet-painted guest leaves the card, never a hole. `hidden` on a non-active tab makes its rect zero, which the visibility rule below turns into `web:visible {false}` — the P3 hide-never-unmount rule holds: the guest stays created.

**Bounds** — `measure()` reads `placeholderRef.current.getBoundingClientRect()`, rounds each of `x, y, width, height` with `Math.round`, and compares to the last SENT rect; an unchanged rect sends nothing. A rect with `width <= 0 || height <= 0` (hidden tab, collapsed tile) is not sent as bounds — it feeds the visibility rule instead. Triggers, all funnelled through `measure()`:

1. A `ResizeObserver` on the placeholder (size changes: ratio drags settle, window resize, sidebar toggle, tile expand/zoom, layout shape change).
2. A `useLayoutEffect` with no dependency array — re-measure after every render of the engine, so a position-only shift the observer cannot see (a neighbouring tile resizing without this one changing size) is caught on the next chrome render.
3. `window` `resize` listener.
4. The live-drag loop (below).
5. The `active → true` and `visible → true` edges (a guest coming back needs the current rect before it shows; main also applies parked bounds on show, so ordering is belt-and-braces, not load-bearing).

Bounds are sent whether or not the guest is currently visible — main parks them while hidden and applies on show (3d contract); the engine never withholds a rect.

**Visibility** — `wantVisible = active && !modalOpen && rectNonZero`. `modalOpen` comes from `useSyncExternalStore(subscribe, isModalOpen, () => false)` over `lib/overlay-presence.ts` (a tiny local hook in the engine file, or `hooks/use-modal-overlay-open.ts` if a second consumer appears — apply decides; the registry module is the only source). `rectNonZero` is state set by `measure()`. An effect sends `web:visible` only when `wantVisible` changes from the last sent value; on the `false → true` edge it calls `measure()` first so bounds precede the show. Dragging does NOT enter this expression.

**Live resize while dragging** — `const dragging = useTileDragging()` (§ 7). An effect keyed on `dragging`: while `true`, a `requestAnimationFrame` loop calls `measure()` every frame (deduped, so a frame with no movement sends nothing); on the `true → false` edge the loop stops and one final `measure()` runs. No hide. `const HIDE_WHILE_DRAGGING = false` is the named engine option the plan keeps as a knob: when `true`, `wantVisible` also requires `!dragging` — shipped `false`, covered by one test asserting the default never hides mid-drag.

**Zoom prop**: accepted, unused this change — the guest renders at factor 1 regardless of the chrome's bucket (the chrome's control still steps and persists the bucket; change 4 sends `web:zoom`). No scale wrapper is applied to the placeholder (a CSS transform on a placeholder would move nothing in the guest and would desync the measured rect).

`wireGestureListeners`: not called — the engine owns no content document.

**Tests** — `web-frame-native.test.tsx` (Vitest + RTL) over a mocked bridge installed on `window.runkitShell = { version, platform, web: {...} }` with `vi.fn()` invokers resolving `{ ok: true }` and an `onEvent` that captures the handler and returns a `vi.fn()` disposer; a mocked `ResizeObserver` (capture the callback, fire it manually) and controllable `getBoundingClientRect` on the placeholder; `requestAnimationFrame` stubbed to a manual pump. Cases: (a) mount calls `onEvent` before `create`, `create` receives the tabKey and the host-absolute URL for a relative `/present/...`, a loopback `http://localhost:8080/x` (→ `/proxy/8080/x` absolutized), and an external `https://github.com/x` (unchanged); (b) unmount calls `destroy(tabKey)` and the disposer exactly once; (c) events for another tabKey change nothing; `title`/`favicon`/`loading`/`url` map into the reported `FrameChromeState` (same-origin `url` stored root-relative, external stored absolute); `loading:false` fires `onLoad(url)`; `failed` clears `loading` and leaves `tileError` null; `focus` calls `interactRef.current`; (d) a `ResizeObserver` callback with a non-zero rect sends `bounds(tabKey, x, y, w, h)` rounded; an identical second rect sends nothing; a zero rect sends no bounds and sends `visible(tabKey, false)`; (e) `acquire("modal")` sends `visible false`, its release sends `visible true` preceded by a bounds send; a `transient` acquire sends nothing; (f) `active: false` sends `visible false`; flipping to `true` re-measures and sends `visible true`; (g) with `TileDragContext` value `true`, pumping three animation frames with a moving rect sends three bounds and NO `visible false`; the `true → false` edge stops the loop and measures once more; (h) the handle's `reload` calls `reload(tabKey)` and reports `loading: true`; `back`/`forward`/`find` are no-ops; (i) the default capability export matches the table above. `_resetForTests()` from `lib/overlay-presence` in `beforeEach`.

### 5. `app/frontend/src/components/iframe-window.tsx` — engine selection per kind, live flip

Replace the module-level `ENGINE_KIND` / `const Engine = createEngine(ENGINE_KIND)` with a per-render selection:

```ts
function createEngine(kind: WebFrameEngineKind): ComponentType<WebFrameEngineProps> {
  switch (kind) {
    case "iframe": return WebFrameIframe;
    case "native": return WebFrameNative;
  }
}

/** Pre-report capability seed per kind — the knowledge stays in each engine module. */
const DEFAULT_CAPABILITIES: Record<WebFrameEngineKind, WebFrameCapabilities> = {
  iframe: WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES,
  native: WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES,
};
```

Inside `IframeWindow`: `const [nativeEnabled] = useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT); const engineKind = selectWebEngineKind(canShellWeb(), nativeEnabled); const Engine = createEngine(engineKind);` — `canShellWeb()` is read per render (the preload injects the bridge before any SPA script runs, so it is stable; the read is cheap). The pre-report seed becomes `activeChrome?.supports ?? DEFAULT_CAPABILITIES[engineKind]`. Each engine mounts under `key={`${engineKind}:${tabUrl}`}` so a preference flip remounts every tab on the other engine (the outgoing native engines destroy their guests in cleanup; the incoming iframe engines mount fresh frames) while a tab URL change still re-keys only that tab. The chrome states map is keyed by URL as before — a kind flip's fresh engine re-reports and overwrites the entry. The zoom wrapper and every other chrome element are untouched.

Chrome tests: `iframe-window.stub-engine.test.tsx` gains a selection block — with `@/lib/web-engine-pref` and `@/lib/shell` module-mocked: `canShellWeb: false` ⇒ the iframe stub mounts regardless of the pref; `canShellWeb: true` + pref `true` ⇒ the native stub mounts (module-mock `@/components/web-frame-native` with a recording stub, the existing iframe-stub pattern); `canShellWeb: true` + pref `false` ⇒ iframe; flipping the pref through the hook's setter remounts (stub unmount recorded, other stub mounted); the pre-report `supports` seed follows the kind (native seed ⇒ ◀ ▶ hidden, find bar disabled).

### 6. Palette entry — `Web: Use embedded browser` (Constitution V)

`app/frontend/src/lib/palette/web-engine.ts` (new, pure builder + colocated `web-engine.test.ts`, the `lib/palette/shell.ts` convention):

```ts
export const WEB_NATIVE_ENGINE_ACTION_ID = "web-native-engine";

/** The per-viewer engine toggle. Present ONLY when the shell offers the `web`
 *  group (`available`); the label carries a trailing ` ✓` while the native
 *  engine is selected (the `Notifications: Enabled ✓` checkbox-label
 *  precedent). Selecting flips the preference; no chord. */
export function buildWebEngineActions(input: {
  available: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}): PaletteAction[] {
  if (!input.available) return [];
  return [{
    id: WEB_NATIVE_ENGINE_ACTION_ID,
    label: `Web: Use embedded browser${input.enabled ? " ✓" : ""}`,
    onSelect: () => input.onToggle(!input.enabled),
  }];
}
```

Registration in `app.tsx` beside `shellServerActions` (the shell-gated palette block, AppShell route list): `const [nativeEnabled, setNativeEnabled] = useLocalStorageBoolean(WEB_NATIVE_ENGINE_PREF_KEY, WEB_NATIVE_ENGINE_DEFAULT); const webEngineActions = useMemo(() => buildWebEngineActions({ available: canShellWeb(), enabled: nativeEnabled, onToggle: setNativeEnabled }), [nativeEnabled, setNativeEnabled]);` folded into the same `paletteActions` array. Availability is the bridge group's own presence (`canShellWeb()`), the truthful signal — the `new-app-window`/`canNewShellWindow()` precedent — not `isShell()`. Not gated on a web tile being open: a viewer may pre-toggle. No keybinding, so `keybindings.test.ts`'s palette-parity invariant is unaffected. Tests: `[]` when unavailable; the two label forms; `onSelect` calls `onToggle` with the negation.

### 7. Drag flag → engine — `app/frontend/src/lib/tile-drag-context.ts` (new) + `surface-layout.tsx`

```ts
/** True while a SurfaceLayout sash or intersection drag is in progress. A
 *  React context rather than an engine prop: the flag is a layout fact the
 *  chrome has no business threading, and only the native engine consumes it
 *  (live-resize its guest every frame). Default false — an engine mounted
 *  outside SurfaceLayout never drags. */
export const TileDragContext = createContext(false);
export function useTileDragging(): boolean { return useContext(TileDragContext); }
```

`surface-layout.tsx` wraps its grid render in `<TileDragContext.Provider value={draggingIndex !== null || draggingIntersection}>` — the same expression that drives the tiles' mid-drag `pointer-events-none` class (~line 2535). The class stays (iframes still need it). `surface-layout.test.tsx`: a probe child rendered through the layout's web tile (or a context-reading test tile) reads `false` at rest, `true` after a divider `pointerdown`, `false` after `pointerup`; the intersection drag likewise.

### 8. Tests summary + verification

- Vitest: `web-frame-native.test.tsx`, `web-engine-pref.test.ts`, `lib/palette/web-engine.test.ts`, additions to `shell.test.ts`, `iframe-window.stub-engine.test.tsx`, `surface-layout.test.tsx`. Existing `web-frame-iframe.test.tsx` / `iframe-window.test.tsx` pass unchanged (the iframe engine is untouched; the chrome resolves `iframe` in jsdom — no bridge).
- Gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (the whole unit suite — touched-files-only runs have missed cross-file breakage before); e2e smoke: `just test-e2e "e2e/web-tabs.spec"` and `just test-e2e "e2e/web-tile-chrome.spec"` one spec per run (Playwright has no shell, so every web e2e spec drives the iframe engine and must pass unchanged — no intent-comment edits expected). Environmental e2e failures known for long-named worktrees (project memory) are not this change's.
- Manual (recorded in the PR body, not gated): `RK_DESKTOP_URL=http://localhost:<derived Vite port> just dev-desktop` against `just dev` — open `https://github.com` in a web tile (renders, title + favicon in the strip), open the palette (guest hides, card stays), close it (guest returns at the right rect), drag a sash (guest follows live), switch tabs, switch hosts, toggle `Web: Use embedded browser` off and on, close the window.

### 9. Memory

- `docs/memory/run-kit/ui/lenses-and-layout.md`: rename § Iframe Window → **§ Web Tile (the `web` lens renderer)** in present truth: two engines behind one chrome; the selection rule (`selectWebEngineKind(canShellWeb(), pref)`, the localStorage key, default on, the kind-qualified mount key so a flip remounts); a **native engine** paragraph (tabKey scheme, the mount effect order, the event → state table, `toTracked`, the placeholder, the bounds triggers + dedupe + zero-rect rule, the visibility expression, live resize, the capabilities reported this release and which flip in parity, the ignored `zoom` prop); § Tile renderer gains the `TileDragContext` provider sentence. Design Decisions (four-field shape): *Engine selection is bridge presence × viewer preference* (why not `isShell()`; rejected: a settings-registry key — Constitution IV, per-viewer); *Live resize, not hide, during sash drags* (spike: 1–2 px lag, no hide needed; rejected: hide-then-restore — a flash per drag); *The relay subscription is disposed with the engine* (spike: N-times chord re-dispatch; rejected: a module-level singleton listener with a tabKey map — hides the leak instead of preventing it); *The drag flag crosses to the engine as a context, not an engine prop* (rejected: widening `WebFrameEngineProps` — the iframe engine would carry a prop it ignores); *Capabilities report what the bridge can do today* (history/zoomGestures false until parity; rejected: the plan seed's `true` — dead buttons). Update the frontmatter description if the § name changes its summary; re-run `fab docs-index`.
- `docs/memory/run-kit/ui/keyboard-and-palette.md`: § Command Palette Actions gains the `Web: Use embedded browser` row (id `web-native-engine`, shell-`web`-gated via `canShellWeb()`, the ` ✓` label form, the localStorage flag, no chord, registered beside the shell server-switch block); the Design Decision *Shell servers reach the palette by empty-list gating* gets a one-line sibling note that bridge-boolean gates (`canNewShellWindow`, `canShellWeb`) are the same truthful-signal principle.
- `docs/memory/run-kit/ui/dialogs-and-state.md`: § Overlay Presence — the "nothing subscribes yet" posture becomes: the native web engine is the first subscriber (`useSyncExternalStore(subscribe, isModalOpen)`), hiding its guest while `isModalOpen()`.
- `docs/memory/run-kit/ui/focus-ownership.md`: the web tile's recorder line gains the native engine's `focus` relay as the second `onInteract` path (the iframe engine's capture listeners are the first).
- `docs/memory/run-kit/desktop-shell.md`: § Web Views — one sentence naming the SPA consumer (`components/web-frame-native.tsx`, tabKeys `web-<n>` per engine mount) and pointing at lenses-and-layout § Web Tile. No bridge-table change.
- Resolve relative `](x.md)` links across `docs/memory/run-kit/ui/` and the run-kit root; `fab docs-index` when a description changes.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Iframe Window → § Web Tile — two engines behind one chrome, the selection rule, the native engine paragraph, the drag context; five Design Decisions
- `run-kit/ui/keyboard-and-palette`: (modify) the `Web: Use embedded browser` palette row + the bridge-boolean gate note
- `run-kit/ui/dialogs-and-state`: (modify) § Overlay Presence — the native engine is the first subscriber
- `run-kit/ui/focus-ownership`: (modify) the native engine's `focus` relay as an `onInteract` recorder path
- `run-kit/desktop-shell`: (modify) § Web Views — the SPA consumer pointer

## Impact

- **Frontend (`app/frontend/src/`)**: `lib/shell.ts` (+ `shell.test.ts`), `lib/web-frame-engine.ts` (kind union), `lib/web-engine-pref.ts` (new + test), `lib/tile-drag-context.ts` (new), `lib/palette/web-engine.ts` (new + test), `components/web-frame-native.tsx` (new + test), `components/iframe-window.tsx` (+ `iframe-window.stub-engine.test.tsx`), `components/surface-layout.tsx` (+ `surface-layout.test.tsx`), `app.tsx` (palette registration). Roughly 600–800 lines added including tests.
- **Reused as-is**: `lib/overlay-presence.ts` (`subscribe`, `isModalOpen`, `_resetForTests`), `hooks/use-local-storage-boolean.ts`, `lib/web-url.ts` `toProxySrc`, `components/web-frame-iframe.tsx` (unchanged), the 3d bridge (`runkitShell.web`, unchanged).
- **Not touched**: `app/desktop/`, `app/backend/`, any e2e spec, any settings-registry key, any route.
- **Dependencies**: none added.
- **Risk**: confined to the desktop shell path — every non-shell viewer resolves the `iframe` engine and runs the exact code it runs today. Inside the shell the opt-out palette entry is the escape hatch.

## Open Questions

- None blocking. The plan's "confirm the titlebar strip offset" is answered by the merged 3d contract (host view = window content area; the strip is SPA DOM): no offset. macOS sibling-layering is a change-5 manual check per the spike verdict, not this change's.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Frontend-only: `app/desktop/` and `app/backend/` are untouched; the 3d bridge is consumed as merged | User prompt and plan § Change 3 both scope 3f to the frontend half | S:100 R:95 A:100 D:100 |
| 2 | Certain | `onShellWebEvent` returns the disposer unconditionally and the engine's mount-effect cleanup calls it; events are demuxed by `tabKey` before any state update | Spike verdict "Adjustments — Change 3f", the preload's `onEvent` disposer contract | S:100 R:90 A:100 D:100 |
| 3 | Certain | Mid-drag rule is live resize: a rAF loop sends deduped bounds every frame while `dragging`; no hide by default, `HIDE_WHILE_DRAGGING = false` kept as a named option | Spike verdict (rAF bounds within 1–2 px, hide unnecessary); user prompt repeats it | S:100 R:90 A:100 D:100 |
| 4 | Certain | Hide while `isModalOpen()` from `lib/overlay-presence.ts` via `subscribe`; `transient` never hides; bounds keep flowing while hidden (main parks them) | Change 2 module built for this subscriber; 3d contract parks bounds | S:95 R:90 A:100 D:100 |
| 5 | Certain | Viewport coordinates from `getBoundingClientRect()` are sent as host-view coordinates with no offset | desktop-shell.md § Web Views: host view = window content area; the titlebar strip is SPA DOM | S:90 R:95 A:100 D:95 |
| 6 | Certain | Guest URL = `new URL(toProxySrc(url), window.location.origin).href` | Plan § Decisions of record "Addressing" | S:100 R:95 A:100 D:100 |
| 7 | Certain | Engine selection = `canShellWeb() && nativeEnabled` → `native`, else `iframe`; a pure `selectWebEngineKind` shared by chrome and palette | Plan item 9; `canNewShellWindow()` bridge-boolean gate precedent | S:95 R:90 A:95 D:95 |
| 8 | Certain | Opt-out is a localStorage boolean `runkit-web-native-engine` (default true) read/written through the existing `useLocalStorageBoolean`; not a settings-registry key | Plan "Per-viewer opt-out", Constitution IV; anti-duplication (hook already does same-tab pub/sub) | S:95 R:95 A:100 D:95 |
| 9 | Certain | Palette entry `Web: Use embedded browser`, id `web-native-engine`, ` ✓` suffix while enabled, no chord, present only when `canShellWeb()`, registered beside `shellServerActions` | Plan item 9; `Notifications: Enabled ✓` label precedent; Constitution V | S:90 R:95 A:95 D:85 |
| 10 | Certain | The placeholder is a `bg-bg-primary` div filling the zoom wrapper, `hidden` when the tab is not active | Spike confirmed the placeholder reads as the card; P3 hide-never-unmount | S:95 R:95 A:100 D:100 |
| 11 | Certain | Every web e2e spec stays untouched and green (Playwright has no shell ⇒ iframe engine) | Plan § E2E; the selection rule resolves `iframe` without the bridge | S:100 R:95 A:100 D:100 |
| 12 | Certain | `supports.history` and `supports.zoomGestures` report `false` this change (plan seed said `true`); `canGoBack`/`canGoForward` are still tracked from `url` events; change 4 flips both flags | The merged 3d bridge has no back/forward channel and the SPA does not step the bucket from `zoom` yet; the chrome renders per capability — a hidden control beats a dead one | S:80 R:90 A:85 D:75 |
| 13 | Certain | `tabKey` = `web-<n>` from a module-level counter, one per engine mount, exposed as `data-tab-key` | Plan says "a per-mount nonce + slot"; a counter is unique under one host webContents, ≤ 128 chars, and survives a StrictMode replay or kind flip without reuse | S:75 R:95 A:90 D:80 |
| 14 | Certain | The drag flag reaches the engine through a React context (`TileDragContext`) provided by `SurfaceLayout`, not a new `WebFrameEngineProps` member | Plan item 10 allows "prop or context"; the iframe engine would otherwise carry an ignored prop | S:80 R:90 A:90 D:80 |
| 15 | Certain | `failed` events clear `loading` and set no `tileError`; `zoom` events are ignored; the `zoom` prop is accepted but unapplied | Plan Non-goals (3): error copy and zoom are change 4 | S:85 R:90 A:90 D:85 |
| 16 | Certain | `trackedLocation` stores same-origin URLs root-relative and external URLs absolute | Iframe engine convention for same-origin; the absolute form is strictly more information for `displayForm` on external pages | S:70 R:95 A:85 D:75 |
| 17 | Certain | Bounds triggers: ResizeObserver + a dependency-less `useLayoutEffect` + window `resize` + the drag rAF loop + the active/visible true edges; deduped against the last sent rounded rect; zero-size rects feed visibility, not bounds | Plan item 8 names RO + layout effect; the extra triggers close the position-only-shift gap cheaply | S:80 R:95 A:85 D:80 |
| 18 | Certain | `onLoad(url)` fires on each `loading: false` relay | The contract's per-completed-load edge; `did-stop-loading` is the guest's completion signal | S:75 R:95 A:85 D:80 |
| 19 | Certain | Engines mount under `key={kind}:{url}` so a preference flip remounts every tab on the other engine live | Plan says the entry "toggles"; a live flip needs a remount and the key is the React mechanism | S:75 R:90 A:90 D:80 |
| 20 | Certain | Gates: `tsc --noEmit`, `just test-frontend`, two single-spec e2e smokes; manual shell run recorded in the PR body, not gated | Plan § Verification per change; project memory on e2e scoping | S:95 R:95 A:100 D:95 |
| 21 | Certain | Memory: lenses-and-layout § Iframe Window → § Web Tile (present truth), keyboard-and-palette row, dialogs-and-state first-subscriber note, focus-ownership recorder note, desktop-shell consumer pointer; indexes regenerated | Plan item 12 + § Memory hygiene; FKF present-truth rule | S:95 R:95 A:100 D:95 |

21 assumptions (21 certain, 0 confident, 0 tentative, 0 unresolved).
