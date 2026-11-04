# Intake: Desktop Web Views Bridge

**Change**: 260916-crb3-desktop-web-views-bridge
**Created**: 2026-09-16

## Origin

One-shot `/fab-new` invocation, autonomous (the user is not watching; the intake proceeds straight into `/fab-fff`, full lane). Change **3d of 6** (the desktop half of "Change 3 — shell web views") in the plan `fab/plans/sahil/26-09-16-web-tile-native-browser.md`, which came out of the 2026-09-16 `/fab-discuss` session on replacing the web tile's iframe with Electron's Chromium renderer in the desktop shell. Design authority: `docs/wiki/web-tile-native-browser-studies.html` (§4 architecture + bridge channels, §6 containment table, §14 closed decisions). Change 0 (the spike, branch `spike/web-native-view`, commits `62125c1b` + `262c839e`, never merged) and change 1 (`260916-fxt1-web-frame-engine-seam`, PR #993, merged as `6b544c3b`) are done; change 2 (`overlay-presence-registry`) runs in parallel from its own worktree and touches only `app/frontend/` — the two are file-disjoint.

> The desktop shell can host a web tile's content in a WebContentsView — a runkitShell.web bridge group, an electron-free registry keyed (window, host, tabKey), main handlers for create/destroy/bounds/visible/load/reload, a one-channel event relay, a dedicated persist:rk-web partition with no preload, and a navigation guard that lets guests browse http(s) while the host allowlist keeps applying to hosts.
>
> Full context lives in fab/plans/sahil/26-09-16-web-tile-native-browser.md — read the whole file before starting, especially "## Change 3 — shell web views" (the "Intake seed (3d)" and numbered items 1-6 — this change covers ONLY the desktop/3d half; the frontend/3f half is a separate later change), "## Standing context" and "## Decisions of record", and CRITICALLY the "## Spike verdict" section at the bottom — change 0's spike found a structural amendment that changes this task: guests must be SIBLINGS of the host view on the window's contentView, NOT children of the host view (a child never paints on Electron 43/Linux). The verdict's "Adjustments to changes 1-5" bullet for "Change 3d" spells out the exact registry/z-order requirements (attach seam re-adds+re-shows the incoming host's guests, detach seam hides the outgoing host's guests, bounds park while hidden, every relayed chord calls hostContents.focus()). This is change 3d of 6 in the plan (full lane — new module, IPC surface, security). After intake, proceed through the full pipeline yourself (fab-fff) to implementation, review, hydrate, ship, and PR.

Key decisions carried from the plan and the spike verdict (all apply here):

- **Guests are siblings of the host view on `win.contentView`, never children of the host view.** The spike proved a `WebContentsView` added under the host view never paints on Electron 43 / Linux (events flow, but the document reports `visibilityState: hidden` and `capturePage` throws `UnknownVizError`); the same view re-parented onto `win.contentView` paints at once, pixel-aligned with the tile. The plan's original "under the host view" wording (§ Change 3 item 2 `hostEntry.handle.addChildView(view)`, item 6's Design Decision *Web views hang under the host view*) is superseded by the verdict.
- **The registry is the z-order authority.** Because guests are siblings, `attachHostView`'s `addChildView(incoming)` lands the incoming host ABOVE every guest: switching away covers the outgoing host's guests (they go `hidden` by occlusion — wrong: they must be hidden explicitly so a later re-attach of a different host never reveals them), and switching back buries the returning host's own guests under it. So the attach seam re-adds the incoming host's guests (`addChildView` on an existing child raises it) and re-shows the ones the SPA wants visible; the detach seam `setVisible(false)`s the outgoing host's guests.
- **Bounds park while hidden.** `setBounds` on a view hidden with `setVisible(false)` re-shows it on Electron 43 / Linux/X11 (observed in the spike). `web:bounds` on a hidden guest records the rect only; `web:visible {true}` applies the parked rect in the same turn as `setVisible(true)`.
- **Containment**: guests get NO preload, `sandbox` + `contextIsolation`, `nodeIntegration: false`, a dedicated `persist:rk-web` partition (separate from the default session the SPA runs in — external logins persist like a browser profile and never share a jar with rk), a deny-all permission handler on that session, http(s)-only navigation (a scheme allowlist, not the host-origin allowlist), popups external via the existing app-level `setWindowOpenHandler`, downloads on Electron's default flow (no `will-download` handler in v1). Every `web:*` handler is gated on a registered-host sender AND on tabKey membership under that sender.
- **One event channel** `web:event` main→renderer, payload `{tabKey, kind, …}`; the SPA demuxes by `tabKey`. The preload's `onEvent(handler)` MUST return the unsubscribe (spike: a leaked listener re-dispatched each chord a dozen times and the palette toggled itself shut). `zoom-changed` is relayed as a direction, never applied by main.
- **Non-goals (this change)**: everything in `app/frontend/` (the `native` engine, `lib/shell.ts` `webBridge()` narrowing, the opt-out palette entry, drag-hide — change 3f); chord matching / `before-input-event` / `web:chords` / `chords.ts` (change 4 — but the rule *every relayed chord calls `hostContents.focus()`* is recorded in memory now so change 4 implements it); `web:back`/`web:forward`/`web:find`/`web:zoom`/`web:devtools` handlers, error-code mapping, downloads/popups beyond the shipped external policy (change 4); the Playwright Electron lane and spec rows (change 5); any backend change; any change to `hostWebPreferences()` or to how host views are created/loaded.

## Why

**Problem.** The web tile renders every address in an `<iframe>`. Any site that sends `X-Frame-Options` / `frame-ancestors` (GitHub, Google, most SaaS dashboards) refuses to embed, so the tile paints "refuses embedding" and the user leaves the shell to read the page. Change 1 made the tile's chrome engine-blind (`lib/web-frame-engine.ts`: capability flags, `FrameChromeState`, a per-tab engine component behind `createEngine(kind)`) precisely so a second engine could render a tab's content without an iframe — but the desktop shell has nothing for such an engine to drive. `app/desktop/src/main.ts` creates one `WebContentsView` per (window, host) for the SPA itself (`createHostView`/`attachHostView`, registry in `views.ts`) and exposes `window.runkitShell` groups (`servers`, `badge`, `windows`, `accent`, …) from `preload.ts`; there is no way for the SPA to ask the shell for a Chromium renderer positioned over a tile rect.

**Consequence of not doing it.** Change 3f (the `native` engine component) has no bridge to call, so the whole native-browser plan stalls; the iframe engine stays the only engine and the refusal wall stays. Every later change (parity, e2e lane) depends on this IPC surface existing with the exact z-order semantics the spike proved necessary.

**Why this approach.** The shell already has the pattern for every piece: `views.ts` is an electron-free registry over an opaque handle covered by `node --test` (this change adds `web-views.ts` in the same shape); `window-open.ts` is a pure policy module owning `isHttpUrl` (this change adds `guestNavigationAction` beside it); `isHostsSender` + `parse*Payload` validators gate and narrow every IPC handler (this change adds `web:*` handlers with the same gate plus a tabKey-membership check); `preload.ts` exposes additive bridge groups older SPAs never call (this change adds `web`). `WebContentsView` is Electron's maintained class and the one the shell already uses for hosts; `<webview>` was measured in the spike and not adopted (Electron's do-not-use recommendation, `webviewTag: true` on the hardened host view); `BrowserView` is deprecated. The sibling-not-child layering is the one structural amendment the spike forced, and it is cheap: the registry already keys on (window, host), so "hide the outgoing host's guests / re-raise the incoming host's" is two pure transitions plus two call sites.

**Behavior contract.** No user-visible change on its own — nothing in the SPA calls `runkitShell.web` yet (change 3f). Every existing shell behavior (host switching, welcome, interstitial, badge, accent, window duplication, navigation guard for hosts, window-open policy) is unchanged; every existing `node --test` suite passes; the frontend is untouched. The shell keeps loading, gating, and hardening host views exactly as before.

## What Changes

### 1. `app/desktop/src/web-views.ts` (new — electron-free registry, the `views.ts` pattern)

A pure module generic over an opaque handle `H` (the `WebContentsView` in `main.ts`), covered by `web-views.test.ts` under `node --test`. It is the z-order and visibility authority; `main.ts` only executes what it decides.

```ts
export interface WebViewEntry<H> {
  windowId: number;
  hostId: string;
  /** The OWNING host view's webContents id — the IPC sender key. Two windows
   *  showing one host are two host webContents, so tabKeys never collide. */
  hostContentsId: number;
  /** SPA-chosen per-tab identity, unique under one host webContents. */
  tabKey: string;
  /** The guest's own webContents id — the navigation guard's membership key. */
  webContentsId: number;
  handle: H;
  /** The SPA-requested visibility (web:visible). Independent of the host
   *  detach hide, so a re-attach restores exactly what the SPA asked for. */
  visible: boolean;
  /** Last web:bounds rect (rounded DIPs, relative to the host view = the
   *  window content area). Parked while hidden; applied on show. */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface WebViewsState<H> {
  /** Insertion order = creation order = z-order among one host's guests. */
  entries: WebViewEntry<H>[];
}
```

Operations (function-style state transitions; every mutator no-ops on an unknown key; removals return the removed entries so the caller can detach + close them):

- `emptyWebViews()`, `getWebView(state, hostContentsId, tabKey)`.
- `findWebViewBySender(state, senderContentsId, tabKey)` — the IPC resolution: the sender IS the owning host webContents, so this is `getWebView` under that id (the membership gate — a tabKey created by another host webContents resolves to null).
- `isGuestContents(state, webContentsId)` — for the navigation guard exemption (`guestIds()` in the plan).
- `addWebView(state, {windowId, hostId, hostContentsId, tabKey, handle, webContentsId})` — create-once per (hostContentsId, tabKey); the caller checks `getWebView` first and destroys+recreates on a collision (§ 3 `web:create`). Fresh entry: `visible: true`, `bounds: {0,0,0,0}`.
- `setWebViewVisible(state, hostContentsId, tabKey, visible)` and `setWebViewBounds(state, hostContentsId, tabKey, bounds)` — pure records; the caller reads `visible` to decide whether `setBounds` runs now or parks.
- `removeWebView(state, hostContentsId, tabKey)` → `{state, removed: entry or null}`.
- `removeHostWebViews(state, hostContentsId)` → `{state, removed[]}` — every guest of ONE host webContents (host `did-navigate`, and the per-entry loop inside host/window teardown).
- `removeWindowWebViews(state, windowId)` → `{state, removed[]}` — the window is closing (`destroyWindowViews`).
- `removeHostWebViewsEverywhere(state, hostId)` → `{state, removed[]}` — the host is removed / re-pointed (`destroyHostViews`).
- `hostDetachPlan(state, windowId, hostId): H[]` — the handles to `setVisible(false)` when that host view leaves the window's contentView (host switch away, `showWelcome`). Does NOT change `entry.visible`.
- `hostAttachPlan(state, windowId, hostId): { handle: H; visible: boolean; bounds: Rect }[]` — in entries order, every guest of that (window, host): the caller re-adds each to `win.contentView` (raising it above the just-added host view), then for `visible: true` entries applies `bounds` and `setVisible(true)`; `visible: false` entries stay hidden (`setVisible(false)` — idempotent, keeps a stale state from leaking).

Tests (`web-views.test.ts`, handle = string): add/get/create-once; sender resolution isolates two host webContents sharing a tabKey; `isGuestContents`; visible/bounds records; the three scoped removals (one guest, one host webContents, one window, one host across two windows) return exactly the removed entries and leave siblings intact; `hostDetachPlan` lists every guest of the (window, host) regardless of `visible`; `hostAttachPlan` preserves entries order and carries each entry's own `visible`/`bounds`; the z-order sequence *create A under host-1 → switch to host-2 (detach plan hides A) → switch back (attach plan re-adds A with its parked bounds and visible flag)*; unknown-key no-ops.

### 2. `app/desktop/src/window-open.ts` — `guestNavigationAction(url)`

```ts
/** Guest (web tile) navigation policy: guests browse anywhere http(s) in
 *  place; every other scheme is dropped — NOT forwarded to openExternal.
 *  Editor deeplinks and mailto: from a guest page are dropped too: the
 *  host-page forward exists for the SPA's own "Open in app" targets, and a
 *  guest is an arbitrary web page. */
export function guestNavigationAction(url: string): "allow" | "deny" {
  return isHttpUrl(url) ? "allow" : "deny";
}
```

`window-open.test.ts` gains the matrix: `https://…`/`http://…` → allow; `vscode://…`, `mailto:…`, `file:///…`, `about:blank`, `javascript:…`, `smb://…` → deny. The host-side `windowOpenAction` and `isEditorDeeplink` are untouched.

### 3. `app/desktop/src/main.ts` — guest session, creation, teardown, seams, guard, IPC

**Guest session + preferences** (module-level, beside `hostWebPreferences`):

```ts
const GUEST_PARTITION = "persist:rk-web";
const GUEST_BACKGROUND = "#0f1117"; // reuse the host view's constant if one is introduced
const GUEST_BORDER_RADIUS_PX = 6;

let guestSessionRef: Electron.Session | null = null;
function guestSession(): Electron.Session {
  if (guestSessionRef) return guestSessionRef;
  const s = session.fromPartition(GUEST_PARTITION);
  // Deny-by-default in v1: a guest is an arbitrary page; nothing it asks
  // for (camera, geolocation, notifications, clipboard) is granted.
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guestSessionRef = s;
  return s;
}

/** Guest hardening — NO preload: a guest never sees runkitShell. */
function guestWebPreferences(): Electron.WebPreferences {
  return {
    session: guestSession(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
}
```

No `will-download` listener is registered: Electron's default download flow (save dialog) applies; change 4 item 6 confirms or replaces it.

**Registry + creation**:

```ts
let webViews: WebViewsState<WebContentsView> = emptyWebViews();

function createWebView(win: BrowserWindow, host: ViewEntry<WebContentsView>, tabKey: string, url: string): void {
  const view = new WebContentsView({ webPreferences: guestWebPreferences() });
  view.setBackgroundColor(GUEST_BACKGROUND);
  view.setBorderRadius(GUEST_BORDER_RADIUS_PX);
  // SIBLING of the host view on the window's contentView — a child of the
  // host view never paints (Electron 43 / Linux). Adding after the host is
  // attached lands the guest above it; the attach seam re-raises on switches.
  win.contentView.addChildView(view);
  view.setVisible(true); // fresh entry is visible; bounds arrive next
  webViews = addWebView(webViews, { windowId: win.id, hostId: host.hostId, hostContentsId: host.webContentsId, tabKey, handle: view, webContentsId: view.webContents.id });
  wireGuestRelay(view.webContents, host.webContentsId, tabKey);
  void view.webContents.loadURL(url);
}
```

**Event relay** (`wireGuestRelay`): every event `send`s `web:event` to the owning host webContents (`webContents.fromId(hostContentsId)`, skipped when missing/destroyed) with `{ tabKey, kind, …extra }`:

| webContents event | `kind` | extra |
|---|---|---|
| `page-title-updated` | `title` | `{ title: string }` |
| `page-favicon-updated` | `favicon` | `{ favicons: string[] }` |
| `did-start-loading` / `did-stop-loading` | `loading` | `{ loading: true }` / `{ loading: false }` |
| `did-fail-load` (main frame, `errorCode !== ERR_ABORTED` — reuse `views.ts` `ERR_ABORTED`; subframe and aborted failures are NOT relayed — the `nextLoadFailed` rule) | `failed` | `{ code: number, description: string, url: string }` |
| `did-navigate` / `did-navigate-in-page` | `url` | `{ url: string, canGoBack: boolean, canGoForward: boolean }` (from `navigationHistory`) |
| `focus` | `focus` | — |
| `zoom-changed` | `zoom` | `{ direction: "in" or "out" }` — relayed as a direction, NEVER applied (the SPA's buckets own zoom; change 4 sends the factor back) |

No `before-input-event` listener in this change (change 4). The relay helper is the one place a future chord relay will hang; the rule *every relayed chord calls `hostContents.focus()`* is recorded in memory (§ 6), not implemented here.

**Teardown** (`destroyWebView(entry)`): remove from the registry, `win.contentView.removeChildView(entry.handle)` when the window is alive (try/catch — the view may already be off the tree), `entry.handle.webContents.close()` when not destroyed. Callers:

- `web:destroy` (one guest).
- Host webContents `did-navigate` (inside `createHostView`'s existing `did-navigate` handler): `removeHostWebViews(webViews, contents.id)` → destroy each — the SPA renderer that owned the tabKeys is gone (an `rk update` reload, a route reload, the interstitial commit); the fresh SPA re-creates what it mounts. Note the initial host load also fires `did-navigate` with zero guests (a no-op).
- `destroyHostViews(hostId)`: before the host views are closed, `removeHostWebViewsEverywhere(webViews, hostId)` → destroy each.
- `destroyWindowViews(windowId)`: `removeWindowWebViews(webViews, windowId)` → destroy each (the window is closing — `removeChildView` is skipped when the window is destroyed).

**Attach / detach seams** (the z-order rule):

- `attachHostView` — after `win.contentView.addChildView(entry.handle)` + `syncViewBounds`, run `hostAttachPlan(webViews, windowId, host.id)`: for each item, `win.contentView.addChildView(item.handle)` (re-adding an existing child raises it above the host view), then `if (item.visible) { item.handle.setBounds(item.bounds); item.handle.setVisible(true); } else item.handle.setVisible(false)`. This runs on EVERY attach, including a same-host re-attach (`showActive` after `servers:set-url` fallback), because `addChildView(host)` always raises the host above its guests. Before that, where the seam detaches `current` (`current.hostId !== host.id` → `removeChildView(current.handle)`), first run `hostDetachPlan(webViews, windowId, current.hostId)` → `setVisible(false)` each.
- `showWelcome` — where it detaches `current`, run the same detach plan first (the welcome page must never be covered by a guest).
- Guests are NOT re-synced on window `resize`/fullscreen: their rects are SPA-driven (the engine's `ResizeObserver` re-sends `web:bounds`); `syncActiveViewBounds` stays host-only.

**Navigation guard** — in the app-level `web-contents-created` handler's `guardNavigation`, before the host allowlist:

```ts
if (isGuestContents(webViews, contents.id)) {
  if (guestNavigationAction(url) === "deny") event.preventDefault();
  return; // guests browse http(s) freely; the host allowlist never applies to them
}
```

`will-navigate` and `will-redirect` share it (a guest redirect to a non-http(s) scheme is dropped). `setWindowOpenHandler` is unchanged and already covers guests (every `window.open` / `target=_blank` from a guest → `windowOpenAction` → external or deny). Main-initiated `loadURL` bypasses `will-navigate`, so `web:create` and `web:load` validate the URL with `isHttpUrl` themselves (§ IPC).

**IPC** (`registerIpcHandlers`; every handler returns `IpcResult`):

Shared resolution:

```ts
/** A web:* sender must be a registered-host page WITH a host view (the
 *  welcome page passes isHostsSender but owns no guests). */
function webSenderHost(event): ViewEntry<WebContentsView> | null {
  if (!isHostsSender(event)) return null;
  return findViewByWebContentsId(views, event.sender.id);
}
/** …and the tabKey must belong to THAT sender. */
function webSenderGuest(event, tabKey): WebViewEntry<WebContentsView> | null {
  return webSenderHost(event) ? findWebViewBySender(webViews, event.sender.id, tabKey) : null;
}
```

Validators beside `parseSetUrlPayload` — `isTabKey(v)`: string, non-empty, ≤ 128 chars; `parseWebCreatePayload` → `{tabKey, url}` with `isHttpUrl(url)`; `parseWebTabKeyPayload` → `{tabKey}`; `parseWebBoundsPayload` → `{tabKey, x, y, width, height}` — four finite numbers, `width`/`height` ≥ 0, rounded with `Math.round` (CSS px arrive as floats); `parseWebVisiblePayload` → `{tabKey, visible: boolean}`; `parseWebLoadPayload` → `{tabKey, url}` with `isHttpUrl(url)`. Anything else → `{ ok: false, error: "Invalid request" }`; a gate failure → `{ ok: false, error: "Not allowed" }`; an unknown tabKey → `{ ok: false, error: "Unknown tab" }`; a sender with no host view → `{ ok: false, error: "No host view" }`.

| Channel | Payload | Behavior |
|---|---|---|
| `web:create` | `{tabKey, url}` | `webSenderHost` required; a pre-existing guest under this sender with the same tabKey is destroyed first (the SPA's mount/unmount raced — replace, never stack); `createWebView(win, host, tabKey, url)` with `win = windows.get(host.windowId)` |
| `web:destroy` | `{tabKey}` | resolve → `destroyWebView` |
| `web:bounds` | `{tabKey, x, y, width, height}` | resolve → `setWebViewBounds`; `if (entry.visible) handle.setBounds(rounded)` else park (a hidden guest's `setBounds` would re-show it) |
| `web:visible` | `{tabKey, visible}` | resolve → `setWebViewVisible`; on `true`: `handle.setBounds(entry.bounds)` THEN `handle.setVisible(true)` in the same turn; on `false`: `handle.setVisible(false)` |
| `web:load` | `{tabKey, url}` | resolve → `webContents.loadURL(url)` (http(s) only) |
| `web:reload` | `{tabKey}` | resolve → `webContents.reload()` |

Bounds are DIP coordinates relative to the host view's content, applied verbatim — the host view fills the window content area (`syncViewBounds`: `{0, 0, contentWidth, contentHeight}`), so host-view coordinates ARE `win.contentView` coordinates and no offset is added.

### 4. `app/desktop/src/preload.ts` — the `web` group

```ts
  // web:* — the web tile's native engine. Additive: older SPAs never call
  // it; the SPA narrows the group's presence (canShellWeb) before use.
  // Privileged main-side for registered-host views only (isHostsSender +
  // tabKey membership under the sender).
  web: {
    create: (tabKey: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("web:create", { tabKey, url }),
    destroy: (tabKey: string): Promise<unknown> =>
      ipcRenderer.invoke("web:destroy", { tabKey }),
    bounds: (tabKey: string, x: number, y: number, width: number, height: number): Promise<unknown> =>
      ipcRenderer.invoke("web:bounds", { tabKey, x, y, width, height }),
    visible: (tabKey: string, visible: boolean): Promise<unknown> =>
      ipcRenderer.invoke("web:visible", { tabKey, visible }),
    load: (tabKey: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("web:load", { tabKey, url }),
    reload: (tabKey: string): Promise<unknown> => ipcRenderer.invoke("web:reload", { tabKey }),
    // Returns the unsubscribe — a subscription that cannot be dropped leaks a
    // listener per engine mount, and every relayed event then fires N times.
    onEvent: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on("web:event", listener);
      return () => ipcRenderer.removeListener("web:event", listener);
    },
  },
```

The preload passes the payload through as `unknown` (the SPA narrows structurally, the `shell.ts` convention); the file-header comment gains a `web` bullet in the existing group list.

### 5. Tests & verification

- `app/desktop/src/web-views.test.ts` (new) per § 1; `window-open.test.ts` gains the guest matrix per § 2. Both under `node --test` via `cd app/desktop && pnpm run compile && pnpm test` (compile = `tsc` + page copy; the worktree has no `app/desktop/node_modules` until `pnpm install` runs there — run it first; the electron binary postinstall may need `node node_modules/electron/install.js` per project memory, but compile + node tests need only `typescript` and the `electron` typings).
- `main.ts` glue is not unit-tested (it imports `electron` at module top — the standing pattern); it MUST compile with zero `tsc` errors and every decision it executes MUST come from the pure modules.
- Frontend: untouched — no `tsc`/Vitest/e2e gates are required for this change; do not run `just test` (one full e2e per worktree; nothing frontend changed).
- Manual smoke (optional, not a gate — the SPA engine that drives this arrives in 3f): with the Xvnc rig (`DISPLAY=:60`, `--no-sandbox`) and `RK_DESKTOP_URL=http://localhost:<derived Vite port> just dev-desktop` against `just dev`, open the host view's devtools console and call `runkitShell.web.create("t1", "https://example.com")`, `runkitShell.web.bounds("t1", 300, 100, 600, 400)`, `runkitShell.web.visible("t1", true)`; the page paints; switch hosts and back; the guest hides and returns above the host.

### 6. Memory (`docs/memory/run-kit/desktop-shell.md`)

- **§ Web Views (`src/main.ts` + `src/web-views.ts`)** (new section, placed after § Host Views): guests as siblings on `win.contentView`; the registry keyed (windowId, hostId, hostContentsId, tabKey) with `visible` + parked `bounds`; the attach/detach plans and why (`addChildView(host)` raises the host above its guests); the parked-bounds rule and why (`setBounds` re-shows a hidden view); the relay table from § 3; teardown seams (host `did-navigate`, host removal, window close); the recorded chord rule for change 4 (*every relayed chord calls `hostContents.focus()`* — the spike: without it the SPA shows a focused palette input while OS focus stays in the guest).
- **§ `window.runkitShell` Bridge**: a `web` group bullet + a `web:*` row in the privileged-senders table (`isHostsSender` + a host view + tabKey membership under the sender; the welcome page passes the gate but owns no view → `"No host view"`).
- **§ Security Wiring**: the guest partition (`persist:rk-web`, deny-all permissions, no preload), the guard's guest branch (scheme allowlist, no `openExternal` forward), the `web:*` payload validators, and that main-initiated guest loads are http(s)-validated because they bypass `will-navigate`.
- **§ Window-Open Policy Module**: `guestNavigationAction`.
- **§ Design Decisions** (four-field shape): *Guests are siblings of the host view, and the registry is the z-order authority* (Decision / Why: a child never paints on Electron 43 Linux; `addChildView(host)` raises it above siblings so the attach seam re-raises guests / Rejected: children of the host view (the plan's original decision of record), `<webview>`, `BrowserView`); *Guests get a partition and no preload* (Why: an arbitrary page must never see `runkitShell` or share a cookie jar with rk; Rejected: the default session, a guest preload); *Bounds park while a guest is hidden* (Why: `setBounds` re-shows a hidden view; Rejected: applying bounds unconditionally). The file's frontmatter description gains "web-tile guest views"; regenerate indexes with `fab docs-index`.

## Affected Memory

- `run-kit/desktop-shell`: (modify) new § Web Views; § Bridge `web` group + gate row; § Security Wiring guest partition/guard/validators; § Window-Open Policy Module `guestNavigationAction`; three Design Decisions; description update
- `run-kit/ui/lenses-and-layout`: (verify-only) no edit — the SPA-side engine selection and § Web Tile rewrite belong to change 3f; confirm nothing here claims the shell has no web-view bridge

## Impact

- **New**: `app/desktop/src/web-views.ts`, `app/desktop/src/web-views.test.ts`.
- **Modified**: `app/desktop/src/main.ts` (guest session/preferences, `createWebView`, `wireGuestRelay`, `destroyWebView`, the attach/detach/teardown seams in `attachHostView` / `showWelcome` / `destroyHostViews` / `destroyWindowViews` / `createHostView`'s `did-navigate`, the guard's guest branch, six `web:*` handlers + validators), `app/desktop/src/preload.ts` (`web` group + header comment), `app/desktop/src/window-open.ts` + `window-open.test.ts` (`guestNavigationAction` + matrix), `docs/memory/run-kit/desktop-shell.md` (+ regenerated `docs/memory/run-kit/index.md` / `docs/memory/index.md` descriptions).
- **Untouched**: everything under `app/frontend/`, `app/backend/`, `app/desktop/src/views.ts`, `hosts.ts`, `menu.ts`, `hostWebPreferences()`, `electron-builder.yml`, CI.
- **Security surface**: new IPC channels (gated + validated), a new session partition (deny-all permissions), a guard exemption (scheme allowlist). Constitution I (no subprocess added; the scheme allowlist and sender gates are the security surface), IV (no settings surface, no routes), V (no new user-facing action in this change — the palette entry is 3f).
- **Dependencies**: none added; Electron `^43.2.0` already provides `View.setVisible/getVisible/setBorderRadius/addChildView(view, index?)`, `session.fromPartition`, `WebContentsView`.

## Open Questions

None — the plan, the spike verdict, and the existing `views.ts` / `window-open.ts` / IPC patterns determine every decision below.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Guests are created as siblings on `win.contentView` (`win.contentView.addChildView(view)`), never `hostEntry.handle.addChildView(view)` | Spike verdict: a child of the host view never paints on Electron 43 / Linux; the user's prompt restates it as CRITICAL | S:100 R:70 A:95 D:100 |
| 2 | Certain | `web-views.ts` is electron-free over an opaque handle `H`, mirrors `views.ts`, and owns the attach/detach plans as pure z-order transitions tested in `web-views.test.ts` | Plan item 1 + verdict ("Test the attach/detach ordering in web-views.test.ts as pure z-order transitions"); the `views.ts` DD explains why main.ts glue is untestable | S:95 R:80 A:95 D:95 |
| 3 | Certain | Registry key is (hostContentsId, tabKey) for IPC resolution with (windowId, hostId) carried per entry; `findWebViewBySender` resolves under `event.sender.id` | Plan: "keyed (window, host, tabKey) with the owning host webContents id"; study §4: "tabKey is scoped to the sender webContents — two windows showing one host never collide" | S:90 R:85 A:95 D:90 |
| 4 | Certain | Attach seam re-adds every guest of the incoming (window, host) after `addChildView(host)` and re-shows only entries whose SPA-requested `visible` is true; detach seam (`attachHostView` switch-away and `showWelcome`) hides every guest of the outgoing host without changing `entry.visible` | Verdict 3d bullet verbatim; keeping `visible` separate from the detach hide is what makes a re-attach restore the SPA's last request rather than force-show hidden tabs | S:90 R:80 A:90 D:85 |
| 5 | Certain | `web:bounds` parks the rect while `entry.visible` is false; `web:visible {true}` applies parked bounds then `setVisible(true)` in the same turn | Verdict + spike comment: `setBounds` on a hidden view re-shows it (Electron 43, Linux/X11) | S:95 R:90 A:95 D:100 |
| 6 | Certain | Guest hardening: `persist:rk-web` partition via `session.fromPartition`, deny-all `setPermissionRequestHandler` on that session, `sandbox` + `contextIsolation` + `nodeIntegration: false`, NO preload | Plan item 2 + decisions of record + study §6 containment table | S:100 R:85 A:95 D:100 |
| 7 | Certain | Guard: `isGuestContents` branch runs before the host allowlist — http(s) allowed, everything else `preventDefault` with NO `openExternal` forward; `will-navigate` and `will-redirect` share it; `setWindowOpenHandler` unchanged | Plan item 2: "editor deeplinks and mailto dropped … setWindowOpenHandler unchanged (external)" | S:95 R:85 A:95 D:95 |
| 8 | Certain | `guestNavigationAction(url): "allow" or "deny"` lives in `window-open.ts` beside `isHttpUrl` with a `node --test` matrix | Plan item 5 names the function and file; the window-open DD requires the single `isHttpUrl` definition | S:95 R:90 A:95 D:95 |
| 9 | Certain | Every `web:*` handler is gated `isHostsSender` AND requires a host view for the sender (`findViewByWebContentsId`) AND tabKey membership under that sender; payloads are structurally validated via `parseWeb*Payload` beside `parseSetUrlPayload` | Plan item 3 + study §6 IPC row + the existing `servers:*`/`badge:set` gate pattern | S:95 R:85 A:95 D:95 |
| 10 | Certain | Channel set for this change is exactly `web:create`, `web:destroy`, `web:bounds`, `web:visible`, `web:load`, `web:reload` + the one `web:event` relay; back/forward/find/zoom/devtools/chords are change 4 | Plan item 3 + "Non-goals (3)" list | S:100 R:90 A:95 D:100 |
| 11 | Confident | `web:create` and `web:load` reject non-http(s) URLs (`isHttpUrl`) with `"Invalid request"` | Main-initiated `loadURL` bypasses `will-navigate`, so the guard alone cannot enforce the scheme allowlist on our own loads; the plan's http(s)-only decision must hold on every entry | S:70 R:90 A:90 D:85 |
| 12 | Confident | `web:create` for an already-registered (sender, tabKey) destroys the old guest and creates fresh (replace), never stacks or errors | The spike did this; the 3f engine's mount/unmount can race (StrictMode double-mount in dev), and a stale guest would leak a renderer | S:60 R:90 A:85 D:75 |
| 13 | Confident | Relay set: `title`, `favicon` (favicons array), `loading` (start/stop), `failed` (main frame, ERR_ABORTED excluded), `url` (did-navigate + did-navigate-in-page, carrying `canGoBack`/`canGoForward`), `focus`, `zoom` (direction only) | Plan item 2's list + verdict's `zoom-changed` rule; the history flags are cheap on `did-navigate` and let change 4 consume them without a new event kind | S:80 R:90 A:90 D:80 |
| 14 | Confident | No `before-input-event` / chord matching in this change; the rule *every relayed chord calls `hostContents.focus()`* is recorded in desktop-shell.md § Web Views for change 4 | Plan "Non-goals (3): chord forwarding … all change 4"; the verdict's 3d bullet names the rule, and memory is where a rule for a later change lives | S:70 R:90 A:85 D:75 |
| 15 | Confident | Teardown seams: host `did-navigate` closes that host webContents's guests; `destroyHostViews` closes the host's guests in every window before closing the host views; `destroyWindowViews` closes the window's guests | Plan item 2 teardown sentence + study §4 lifecycle; both existing destroy functions already own the per-entry close loop | S:85 R:85 A:90 D:90 |
| 16 | Confident | Guests are not re-synced on window resize/fullscreen — rects stay SPA-driven; `syncActiveViewBounds` stays host-only | The engine (3f) owns a `ResizeObserver` that re-sends `web:bounds`; a main-side resize would race it | S:65 R:90 A:85 D:75 |
| 17 | Confident | No `will-download` handler in v1 (Electron's default save-dialog flow); change 4 item 6 confirms | Plan item 2 "`on("will-download")` default" + change 4 item 6 "confirm will-download default behavior" | S:65 R:95 A:80 D:75 |
| 18 | Confident | Bounds validator: four finite numbers, width/height ≥ 0, `Math.round`ed; tabKey validator: non-empty string ≤ 128 chars | CSS px floats from `getBoundingClientRect`; the spike rounded; a bound on tabKey length is the same posture as the strict `badge:set` integer check | S:60 R:95 A:85 D:75 |
| 19 | Confident | `setBackgroundColor("#0f1117")` + `setBorderRadius(6)` on every guest | Plan item 2; the host view uses the same background; the spike judged the 6px radius clean | S:85 R:95 A:95 D:90 |
| 20 | Certain | Verification gate is `cd app/desktop && pnpm install && pnpm run compile && pnpm test`; no frontend gates; never full `just test`; manual shell smoke is optional | Plan § Verification per change (desktop line) + this change touches no frontend file; project memory: one full e2e per worktree | S:90 R:95 A:95 D:95 |
| 21 | Certain | `change_type` is `feat`, pinned explicitly | A new bridge group + IPC surface is a feature; project memory: refresh re-infers from wording, so the pin prevents drift | S:90 R:95 A:95 D:95 |
| 22 | Confident | Memory scope is `desktop-shell.md` only (new § Web Views, bridge row, security bullets, window-open module note, three DDs, description); `ui/lenses-and-layout.md` verify-only | Plan item 6 + the DD titles amended by the verdict (sibling layering replaces "hang under the host view"); the SPA-side memory rewrite is 3f's item 12 | S:80 R:90 A:90 D:85 |

22 assumptions (13 certain, 9 confident, 0 tentative, 0 unresolved).
