# Plan: Desktop Web Views Bridge

**Change**: 260916-crb3-desktop-web-views-bridge
**Intake**: `intake.md`

## Requirements

### Desktop: Web View Registry (`app/desktop/src/web-views.ts`)

#### R1: Electron-free registry over an opaque handle
`web-views.ts` MUST be a pure module generic over an opaque handle `H` (no `electron` import), exporting `WebViewEntry<H>`, `WebViewsState<H>`, `emptyWebViews`, `getWebView`, `findWebViewBySender`, `isGuestContents`, `addWebView`, `setWebViewVisible`, `setWebViewBounds`, `removeWebView`, `removeHostWebViews`, `removeWindowWebViews`, `removeHostWebViewsEverywhere`, `hostDetachPlan`, and `hostAttachPlan`. Every entry carries `windowId`, `hostId`, `hostContentsId`, `tabKey`, `webContentsId`, `handle`, `visible`, `bounds`. `entries` order is creation order. Every mutator MUST no-op on an unknown key; every removal MUST return the removed entries.

- **GIVEN** an empty state
- **WHEN** `addWebView` registers `(hostContentsId: 11, tabKey: "t1")` with a string handle
- **THEN** `getWebView(state, 11, "t1")` returns the entry with `visible: true` and `bounds: {0,0,0,0}`
- **AND** a second `addWebView` for the same `(11, "t1")` leaves the state unchanged (create-once)

#### R2: Sender-scoped resolution and guest membership
`findWebViewBySender(state, senderContentsId, tabKey)` MUST resolve only entries whose `hostContentsId` equals the sender's webContents id. `isGuestContents(state, webContentsId)` MUST be true exactly for registered guests' own webContents ids.

- **GIVEN** two host webContents (ids 11 and 22) each registered a guest with `tabKey: "t1"` (guest webContents ids 101 and 102)
- **WHEN** resolving `(11, "t1")` and `(22, "t1")`
- **THEN** each resolves to its own entry (101 and 102 respectively)
- **AND** `isGuestContents(state, 101)` is true, `isGuestContents(state, 11)` is false

#### R3: Scoped removals
`removeWebView` (one guest), `removeHostWebViews` (every guest of one host webContents), `removeWindowWebViews` (every guest in one window), and `removeHostWebViewsEverywhere` (every guest of one hostId across windows) MUST remove exactly their scope and return the removed entries, leaving unrelated entries intact.

- **GIVEN** guests for (win 1, host-a, contents 11), (win 1, host-b, contents 12), (win 2, host-a, contents 21)
- **WHEN** `removeHostWebViewsEverywhere(state, "host-a")`
- **THEN** the two host-a entries are returned and only the host-b entry remains
- **AND** `removeWindowWebViews(state, 1)` on the original state returns the two win-1 entries and leaves (win 2, host-a)

#### R4: Attach and detach plans are the z-order authority
`hostDetachPlan(state, windowId, hostId)` MUST return every guest handle of that (window, host) regardless of `visible`, and MUST NOT change any entry. `hostAttachPlan(state, windowId, hostId)` MUST return, in entries order, `{handle, visible, bounds}` for every guest of that (window, host). `setWebViewVisible`/`setWebViewBounds` MUST record the SPA-requested values without side effects.

- **GIVEN** guest A under (win 1, host-1) with `visible: true`, `bounds: {x:300,y:100,width:600,height:400}` and guest B under (win 1, host-1) with `visible: false`
- **WHEN** the window switches to host-2 then back to host-1
- **THEN** `hostDetachPlan(state, 1, "host-1")` lists A and B
- **AND** `hostAttachPlan(state, 1, "host-1")` returns `[A {visible: true, bounds: {300,100,600,400}}, B {visible: false, …}]` in that order, with the state unchanged

### Desktop: Guest Session & Hardening (`main.ts`)

#### R5: Guests run in a dedicated hardened partition with no preload
Guests MUST be created with `guestWebPreferences()` = `{ session: session.fromPartition("persist:rk-web"), sandbox: true, contextIsolation: true, nodeIntegration: false }` and NO `preload`. The guest session MUST install a deny-all `setPermissionRequestHandler` once. No `will-download` handler is registered. Every guest MUST get `setBackgroundColor("#0f1117")` and `setBorderRadius(6)`.

- **GIVEN** a guest created via `web:create`
- **WHEN** its page requests any permission (notifications, geolocation, camera)
- **THEN** the request is denied
- **AND** `window.runkitShell` is undefined inside the guest page (no preload)

### Desktop: Guest Lifecycle (`main.ts`)

#### R6: Guests are siblings of the host view on the window's contentView
`createWebView` MUST add the guest with `win.contentView.addChildView(view)` (never `hostEntry.handle.addChildView`), register it via `addWebView` with the owning host's `webContentsId` as `hostContentsId`, wire the relay, then `loadURL(url)`. The fresh guest MUST be shown (`setVisible(true)`) ONLY when its owning host view is the one attached in its window (`activeHostForWindow(views, windowId) === hostId`); a guest created by a detached host's still-live SPA starts hidden and the attach plan shows it when that host returns.

- **GIVEN** a host view attached in window W
- **WHEN** the SPA calls `web:create {tabKey, url}`
- **THEN** a `WebContentsView` exists as a direct child of `W.contentView` above the host view, registered under the host's webContents id

#### R7: One relay channel `web:event`
Every relayed guest event MUST be sent to the owning host webContents (`webContents.fromId(hostContentsId)`, skipped when absent/destroyed) on `web:event` as `{ tabKey, kind, …extra }` with exactly these kinds: `title {title}`, `favicon {favicons}`, `loading {loading}`, `failed {code, description, url}` (main frame only, `ERR_ABORTED` excluded), `url {url, canGoBack, canGoForward}` (on `did-navigate` and `did-navigate-in-page`), `focus`, `zoom {direction}` (from `zoom-changed`, never applied). No `before-input-event` listener is added.

- **GIVEN** a guest whose page sets `document.title = "Hello"`
- **WHEN** Chromium emits `page-title-updated`
- **THEN** the host webContents receives `web:event {tabKey, kind: "title", title: "Hello"}`
- **AND** a `did-fail-load` with `errorCode === -3` (ERR_ABORTED) or `isMainFrame === false` relays nothing

#### R8: Teardown closes guests with their owner
`destroyWebView(entry)` MUST remove the registry entry, `removeChildView` from the window when alive (tolerating an already-detached view), and `webContents.close()` when not destroyed. Callers: `web:destroy`; the host webContents `did-navigate` handler in `createHostView` (all guests of that host webContents); `destroyHostViews(hostId)` (all guests of that host in every window, before the host views close); `destroyWindowViews(windowId)` (all guests of that window).

- **GIVEN** a host view with two guests
- **WHEN** the host webContents commits a `did-navigate` (a reload)
- **THEN** both guests are closed and unregistered
- **AND** removing the host (`destroyHostViews`) or closing the window (`destroyWindowViews`) likewise closes every guest in scope

#### R9: Host attach re-raises and re-shows guests; host detach hides them
In `attachHostView`, after `win.contentView.addChildView(entry.handle)`, every item of `hostAttachPlan(webViews, windowId, host.id)` MUST be re-added to `win.contentView` (raising it above the host view) and then, for `visible: true`, get `setBounds(bounds)` followed by `setVisible(true)`; `visible: false` items get `setVisible(false)`. This MUST run on every attach, including a same-host re-attach. Where `attachHostView` and `showWelcome` detach the current host view, every handle of `hostDetachPlan(webViews, windowId, current.hostId)` MUST first get `setVisible(false)`. Guests are NOT re-synced on window resize/fullscreen.

- **GIVEN** window W shows host-1 with a visible guest A
- **WHEN** the user switches W to host-2
- **THEN** A gets `setVisible(false)` before host-1's view is removed
- **AND** switching back to host-1 re-adds A to `W.contentView` (index above host-1's view), applies A's parked bounds, and sets it visible again

### Desktop: Navigation Guard

#### R10: Guests browse http(s) freely; every other scheme is dropped
`window-open.ts` MUST export `guestNavigationAction(url): "allow" | "deny"` (`isHttpUrl(url) ? "allow" : "deny"`). In the app-level `web-contents-created` handler, `guardNavigation` MUST first check `isGuestContents(webViews, contents.id)`: for a guest, `deny` ⇒ `event.preventDefault()` with NO `shell.openExternal`, then return without consulting `isAllowedNavigation`. Hosts are guarded exactly as before. `setWindowOpenHandler` is unchanged.

- **GIVEN** a guest page navigating to `https://example.org/`
- **WHEN** `will-navigate` fires
- **THEN** the navigation proceeds in place
- **AND** a guest navigation or redirect to `vscode://…`, `mailto:…`, `file:///…`, `about:blank`, or `javascript:…` is prevented and nothing is opened externally
- **AND** a host page navigating to `https://example.org/` is still blocked in-window and forwarded to the system browser

### Desktop: IPC (`registerIpcHandlers`)

#### R11: Every `web:*` handler is gated on a registered-host sender with a host view and on tabKey membership
Each handler MUST return `{ ok: false, error: "Not allowed" }` when `!isHostsSender(event)`, `{ ok: false, error: "No host view" }` when `findViewByWebContentsId(views, event.sender.id)` is null (the welcome page), `{ ok: false, error: "Invalid request" }` on a failed payload validator, and `{ ok: false, error: "Unknown tab" }` when `findWebViewBySender(webViews, event.sender.id, tabKey)` is null.

- **GIVEN** the welcome page calls `web:create`
- **WHEN** the handler runs
- **THEN** it returns `{ ok: false, error: "No host view" }` and creates nothing
- **AND** a registered-host page calling `web:bounds` with a tabKey created by a different host webContents gets `"Unknown tab"`

#### R12: Payload validators
Beside `parseSetUrlPayload`: `isTabKey(v)` (string, non-empty, ≤ 128 chars); `parseWebCreatePayload` and `parseWebLoadPayload` → `{tabKey, url}` requiring `isHttpUrl(url)`; `parseWebTabKeyPayload` → `{tabKey}`; `parseWebBoundsPayload` → `{tabKey, x, y, width, height}` with four finite numbers, `width`/`height` ≥ 0, each `Math.round`ed; `parseWebVisiblePayload` → `{tabKey, visible: boolean}`.

- **GIVEN** `web:create {tabKey: "t1", url: "file:///etc/passwd"}` or `web:bounds {tabKey: "t1", x: NaN, …}` or `web:visible {tabKey: "", visible: true}`
- **WHEN** validated
- **THEN** each returns `{ ok: false, error: "Invalid request" }`

#### R13: Handler semantics
`web:create` resolves the sender's window first (a destroyed window ⇒ `{ ok: false, error: "No host view" }` — the ladder's existing variant, no separate `"No window"` string), then destroys any existing guest under the same (sender, tabKey), then creates one. `web:destroy` destroys the resolved guest. A main-side predicate `isGuestHostAttached(entry)` = `activeHostForWindow(views, entry.windowId) === entry.hostId` gates every show/paint: `web:bounds` records via `setWebViewBounds` and calls `setBounds` only when `entry.visible` AND the host is attached; otherwise it parks. `web:visible {true}` records and, only when the host is attached, calls `setBounds(entry.bounds)` THEN `setVisible(true)` (a detached host's request is recorded and the attach plan applies it on return); `{false}` records and calls `setVisible(false)` unconditionally. `web:load` calls `loadURL(url)`; `web:reload` calls `reload()`. Every success returns `{ ok: true }`.

- **GIVEN** a guest hidden via `web:visible {false}`
- **WHEN** `web:bounds {x:10,y:20,width:300,height:200}` arrives and then `web:visible {true}`
- **THEN** `setBounds` is NOT called on the bounds message
- **AND** on the visible message `setBounds({10,20,300,200})` runs immediately before `setVisible(true)`

- **GIVEN** window W currently shows host-2, and host-1's detached (still-live) SPA in W calls `web:create`, then `web:bounds`, then `web:visible {true}` for its guest
- **WHEN** the handlers run
- **THEN** the guest is created hidden, its bounds and `visible: true` are recorded, and neither `setBounds` nor `setVisible(true)` is called while host-2 is displayed
- **AND** switching W back to host-1 shows the guest at the recorded bounds via the attach plan

### Desktop: Preload bridge group

#### R14: `runkitShell.web` is additive
`preload.ts` MUST expose `web: { create(tabKey, url), destroy(tabKey), bounds(tabKey, x, y, width, height), visible(tabKey, visible), load(tabKey, url), reload(tabKey), onEvent(handler) }`, each invoker mapping to its `web:*` channel with the payload shapes in R12; `onEvent` MUST subscribe to `web:event`, pass the payload through as `unknown`, and RETURN the unsubscribe function. The file-header group list gains a `web` bullet.

- **GIVEN** an SPA that calls `const off = runkitShell.web.onEvent(h)` twice for two engine mounts
- **WHEN** one mount unmounts and calls its `off()`
- **THEN** only the other handler keeps receiving `web:event` payloads

### Memory

#### R15: `docs/memory/run-kit/desktop-shell.md` documents the web-view surface
The memory file MUST gain § Web Views (after § Host Views), a `web` bullet + gate-table row in § `window.runkitShell` Bridge, guest partition/guard/validator bullets in § Security Wiring, a `guestNavigationAction` note in § Window-Open Policy Module, and three four-field Design Decisions (*Guests are siblings of the host view, and the registry is the z-order authority*; *Guests get a partition and no preload*; *Bounds park while a guest is hidden*), with a description update and regenerated indexes. (Hydrate stage.)

- **GIVEN** the hydrate stage runs
- **WHEN** the memory file is read
- **THEN** a reader can find the relay table, the attach/detach rule, the parked-bounds rule, the gate row, and the recorded chord focus-hop rule for change 4 without reading source

### Non-Goals

- Any file under `app/frontend/` — the `native` engine, `webBridge()` narrowing, the opt-out palette entry, drag hide (change 3f).
- Chord matching (`before-input-event`, `web:chords`, `chords.ts`), `web:back`/`forward`/`find`/`stop-find`/`zoom`/`devtools`, error-code mapping, downloads/popups beyond the shipped policy (change 4).
- The Playwright Electron lane and spec rows (change 5). Any backend change. Any change to `hostWebPreferences()` or `views.ts`.

### Design Decisions

#### Guests are siblings of the host view, and the registry is the z-order authority
**Decision**: A guest `WebContentsView` is added to `win.contentView` beside the host view; `web-views.ts` decides which guests to hide on host detach and which to re-add/re-show on host attach, and `attachHostView` executes that plan after every `addChildView(host)`.
**Why**: A guest added as a child of the host view never paints on Electron 43 / Linux (`visibilityState: hidden`, `capturePage` throws), while a sibling paints pixel-aligned. Siblings make the host switch non-free — `addChildView(incoming host)` lands the host above every guest — so the ordering has to be owned somewhere testable.
**Rejected**: Children of the host view (the plan's original decision of record — does not paint); `<webview>` (Electron's do-not-use recommendation, `webviewTag: true` on the hardened host view); `BrowserView` (deprecated); z-order bookkeeping as ad-hoc code in `main.ts` (untestable under `node --test`).
*Introduced by*: 260916-crb3-desktop-web-views-bridge

#### Guests get a partition and no preload
**Decision**: Guests run in `persist:rk-web` with a deny-all permission handler, `sandbox` + `contextIsolation`, and no preload script.
**Why**: A guest is an arbitrary web page; it must never see `runkitShell`, share the SPA's cookie jar, or be granted a permission on rk's behalf. A persistent partition lets external logins survive like a browser profile without touching rk's session.
**Rejected**: The default session (shares storage with the SPA and its host origins); a guest preload (any bridge surface inside an untrusted page is attack surface); an in-memory partition (logins lost on every launch).
*Introduced by*: 260916-crb3-desktop-web-views-bridge

#### Bounds park while a guest is hidden
**Decision**: `web:bounds` on a hidden guest records the rect only; `web:visible {true}` applies the parked rect immediately before `setVisible(true)`.
**Why**: `View.setBounds` on a view hidden with `setVisible(false)` re-shows it (observed on Electron 43, Linux/X11), so an unconditional apply would flash a hidden tab's content over the palette or the wrong tab.
**Rejected**: Applying bounds unconditionally; dropping bounds messages while hidden (the guest would show at a stale rect).
*Introduced by*: 260916-crb3-desktop-web-views-bridge

## Tasks

### Phase 1: Setup

- [x] T001 Read `app/desktop/src/views.ts`, `views.test.ts`, `window-open.ts`, `window-open.test.ts`, `preload.ts`, and `main.ts` (`hostWebPreferences` ~487, `createHostView` ~665, `attachHostView` ~780, `showWelcome` ~422, `destroyHostViews` ~830, `destroyWindowViews` ~861, `isHostsSender` ~1623, `parse*Payload` ~1628–1660, `registerIpcHandlers` ~1675, the `web-contents-created` handler ~2150) to extract naming/error-handling patterns; confirm `app/desktop/node_modules` exists (`pnpm install` if not) and `pnpm run compile && pnpm test` is green at baseline <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Create `app/desktop/src/web-views.ts`: `WebViewEntry<H>`, `WebViewsState<H>`, `emptyWebViews`, `getWebView`, `findWebViewBySender`, `isGuestContents`, `addWebView` (create-once, `visible: true`, zero bounds), `setWebViewVisible`, `setWebViewBounds`, `removeWebView`, `removeHostWebViews`, `removeWindowWebViews`, `removeHostWebViewsEverywhere`, `hostDetachPlan`, `hostAttachPlan`, with a header comment in the `views.ts` shape (electron-free rationale, identity, why the registry owns z-order) <!-- R1 R2 R3 R4 -->
- [x] T003 Create `app/desktop/src/web-views.test.ts` (`node:test`, string handles) covering add/get/create-once, sender resolution across two host webContents sharing a tabKey, `isGuestContents`, visible/bounds records, the four scoped removals returning exactly the removed entries, `hostDetachPlan` listing hidden and visible guests, `hostAttachPlan` order + per-entry visible/bounds, the create → switch away → switch back z-order sequence, and unknown-key no-ops <!-- R1 R2 R3 R4 -->
- [x] T004 [P] Add `guestNavigationAction(url)` to `app/desktop/src/window-open.ts` with a doc comment (why editor deeplinks/mailto are dropped, not forwarded) and extend `window-open.test.ts` with the allow/deny matrix (`https`, `http` → allow; `vscode://`, `mailto:`, `file:///`, `about:blank`, `javascript:`, `smb://` → deny) <!-- R10 -->
- [x] T005 [P] Add the `web` group to `app/desktop/src/preload.ts` (`create`, `destroy`, `bounds`, `visible`, `load`, `reload`, `onEvent` returning the unsubscribe) and a `web` bullet in the file-header group list <!-- R14 -->
- [x] T006 <!-- rework: review should-fix — createWebView must setVisible(true) only when the owning host is the attached one (isGuestHostAttached); a detached host's SPA painted its guest over the displayed host --> In `app/desktop/src/main.ts` add `GUEST_PARTITION`, the lazily-created `guestSession()` with its deny-all permission handler, `guestWebPreferences()` (no preload), the `webViews` registry variable, `createWebView(win, hostEntry, tabKey, url)` (sibling on `win.contentView`, background, radius 6, `addWebView`, relay wiring, `loadURL`), `wireGuestRelay(contents, hostContentsId, tabKey)` with the R7 kind table (ERR_ABORTED/subframe failures excluded; `zoom-changed` as a direction), and `destroyWebView(entry)` <!-- R5 R6 R7 R8 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Wire the teardown seams in `main.ts`: `createHostView`'s `did-navigate` handler destroys `removeHostWebViews(webViews, contents.id)`; `destroyHostViews` destroys `removeHostWebViewsEverywhere(webViews, hostId)` before closing host views; `destroyWindowViews` destroys `removeWindowWebViews(webViews, windowId)` <!-- R8 -->
- [x] T008 Wire the z-order seams in `main.ts`: in `attachHostView`, hide `hostDetachPlan(...)` handles before `removeChildView(current.handle)` and, after `addChildView(entry.handle)` + `syncViewBounds`, execute `hostAttachPlan(...)` (re-add, then `setBounds`+`setVisible(true)` for visible items, `setVisible(false)` otherwise); in `showWelcome`, hide the detach plan before detaching the current view; leave `syncActiveViewBounds` host-only <!-- R9 -->
- [x] T009 Add the guest branch to `guardNavigation` in the `web-contents-created` handler: `isGuestContents(webViews, contents.id)` ⇒ `guestNavigationAction(url) === "deny"` → `preventDefault()`, then return (no `openExternal`); hosts unchanged <!-- R10 -->
- [x] T010 Add the validators (`isTabKey`, `parseWebCreatePayload`, `parseWebTabKeyPayload`, `parseWebBoundsPayload`, `parseWebVisiblePayload`, `parseWebLoadPayload`) and the shared `webSenderHost`/`webSenderGuest` resolvers beside `parseSetUrlPayload`/`isHostsSender` in `main.ts` <!-- R11 R12 -->
- [x] T011 <!-- rework: review should-fix + nice-to-have — gate web:bounds/web:visible{true} painting on isGuestHostAttached (park otherwise); web:create resolves the window BEFORE destroying a colliding guest and reports a destroyed window as "No host view" (no off-ladder "No window") --> Register the six handlers `web:create`, `web:destroy`, `web:bounds`, `web:visible`, `web:load`, `web:reload` in `registerIpcHandlers` with the R11 error ladder and R13 semantics (replace-on-collision create; parked bounds; bounds-then-visible ordering), each with a comment block in the surrounding handlers' style <!-- R11 R12 R13 -->

### Phase 4: Polish

- [x] T012 Run `cd app/desktop && pnpm run compile && pnpm test`; fix every `tsc` error and test failure; confirm no `app/frontend/` file changed (`git status --short`) and that `hostWebPreferences()`/`views.ts` are untouched <!-- R1 R5 R10 R14 -->
- [x] T013 Update `main.ts`'s module header comment and the `createHostView` doc comment to mention guest web views where they describe per-view wiring and security coverage (constraints only — no change-id citations, no narration) <!-- R6 R9 -->

## Execution Order

- T002 blocks T003, T006
- T004 and T005 are independent of T002–T003 and of each other
- T006 blocks T007–T011; T007–T011 are sequential edits to `main.ts` (same file — not parallel)
- T012 runs after T011; T013 after T012

## Acceptance

### Functional Completeness

- [x] A-001 R1: `app/desktop/src/web-views.ts` exists, imports nothing from `electron`, and exports every function and type named in R1
- [x] A-002 R2: `findWebViewBySender` resolves only under the sender's webContents id; `isGuestContents` is true only for registered guest webContents ids
- [x] A-003 R3: the four removal functions remove exactly their scope and return the removed entries
- [x] A-004 R4: `hostDetachPlan` and `hostAttachPlan` return the documented shapes without mutating state
- [x] A-005 R5: `guestWebPreferences()` sets `session` to the `persist:rk-web` partition, `sandbox`, `contextIsolation`, `nodeIntegration: false`, and no `preload`; the guest session has a deny-all permission handler; guests get `#0f1117` background and radius 6
- [x] A-006 R6: `createWebView` adds the guest via `win.contentView.addChildView` and registers it with the host's `webContentsId` as `hostContentsId`
- [x] A-007 R7: the relay emits exactly the seven kinds with the documented payloads on `web:event` to the owning host webContents; no `before-input-event` listener exists
- [x] A-008 R8: `destroyWebView` unregisters, detaches (tolerant), and closes; the four teardown call sites are wired
- [x] A-009 R9: `attachHostView` runs the detach plan before removing the outgoing host and the attach plan after adding the incoming host; `showWelcome` runs the detach plan
- [x] A-010 R10: `guestNavigationAction` exists in `window-open.ts`; `guardNavigation` has the guest branch with no `openExternal` forward; the host path is byte-for-byte the previous behavior
- [x] A-011 R11: every `web:*` handler follows the error ladder `Not allowed` → `No host view` → `Invalid request` → `Unknown tab`
- [x] A-012 R12: all six validators exist with the documented constraints, including `isHttpUrl` on create/load URLs and rounding on bounds
- [x] A-013 R13: handler semantics match (window resolved before the replace-on-collision destroy, parked bounds, bounds-then-visible ordering, `loadURL`/`reload`; no `"No window"` string — a destroyed window reports `No host view`)
- [x] A-014 R14: `preload.ts` exposes the `web` group with all seven members and `onEvent` returns the unsubscribe

### Behavioral Correctness

- [x] A-015 R9: a same-host re-attach (not only a switch) re-raises the host's guests above the host view
- [x] A-016 R13: `web:bounds` on a hidden guest does not call `setBounds`; the following `web:visible {true}` applies the parked rect before `setVisible(true)`
- [x] A-035 R6 R13: `isGuestHostAttached(entry)` exists and gates `createWebView`'s initial `setVisible(true)`, `web:bounds`' `setBounds`, and `web:visible {true}`'s `setBounds`+`setVisible(true)`; a detached host's SPA can record state but never paints a guest over the displayed host; `web:visible {false}` still hides unconditionally
- [x] A-036 R9 R13: a guest created or shown while its host was detached becomes visible at its recorded bounds through the attach plan when that host is re-attached (the plan's existing `visible`/`bounds` fields carry the request — no new registry field)
- [x] A-017 R7: `did-fail-load` with `ERR_ABORTED` or a subframe relays nothing; `zoom-changed` relays a direction and never calls `setZoomFactor`

### Scenario Coverage

- [x] A-018 R4: `web-views.test.ts` covers the create → switch-away → switch-back z-order sequence as pure transitions
- [x] A-019 R2: `web-views.test.ts` covers two host webContents sharing a tabKey
- [x] A-020 R10: `window-open.test.ts` covers the guest allow/deny scheme matrix
- [x] A-021 R1: `cd app/desktop && pnpm run compile && pnpm test` is green (all existing suites plus the new ones)

### Edge Cases & Error Handling

- [x] A-022 R11: the welcome page (passes `isHostsSender`, owns no view) gets `No host view` from every `web:*` handler
- [x] A-023 R8: destroying a guest whose window is already destroyed skips `removeChildView` and still closes the webContents; a destroyed webContents is not closed twice
- [x] A-024 R7: a relay after the owning host webContents is destroyed is skipped silently
- [x] A-025 R12: non-finite or negative-size bounds, empty or over-long tabKeys, and non-http(s) create/load URLs are rejected as `Invalid request`

### Code Quality

- [x] A-026 Pattern consistency: `web-views.ts` mirrors `views.ts` (function-style transitions, header comment shape, `H` generic); handlers and validators mirror the `servers:*`/`badge:set` style
- [x] A-027 No unnecessary duplication: `isHttpUrl` and `ERR_ABORTED` are imported, not re-implemented; the guest permission handler is installed once
- [x] A-028 Type narrowing over assertions: validators narrow `unknown` payloads with `in`/`typeof` guards, no `as` casts
- [x] A-029 Comments state constraints (why siblings, why parked bounds, why no preload), never narration or change-id citations
- [x] A-030 Magic values are named constants (`GUEST_PARTITION`, `GUEST_BORDER_RADIUS_PX`, the tabKey length cap)
- [x] A-031 Tests included for the added behavior (`web-views.test.ts`, the `window-open.test.ts` matrix)

### Security

- [x] A-032 R5: no preload reaches a guest; the guest session denies every permission request
- [x] A-033 R10: a guest cannot navigate or redirect to a non-http(s) scheme, and nothing from a guest reaches `shell.openExternal` through the navigation guard
- [x] A-034 R11: no `web:*` action is reachable from the welcome page, from an unregistered origin, or across host webContents boundaries

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality (a guest registry, IPC surface, and preload group) without making any existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The attach plan re-adds hidden guests too (then `setVisible(false)`), not only visible ones | Keeps every guest of the host at a known z-position so a later `web:visible {true}` shows it above the host without another re-add | S:70 R:90 A:85 D:80 |
| 2 | Confident | `hostContentsId` is the IPC key and `windowId`/`hostId` are carried alongside (not a composite `${windowId}:${hostId}:${tabKey}` string key) | Mirrors `views.ts` (`webContentsId` carried for sender resolution); the sender id is what every handler has in hand | S:75 R:85 A:90 D:80 |
| 3 | Confident | The `url` relay carries `canGoBack`/`canGoForward` now | Cheap on `did-navigate`; change 4's history buttons consume it without a new kind; intake assumption 13 | S:70 R:95 A:90 D:80 |
| 4 | Certain | `main.ts` glue gets no unit test; `tsc` + the pure-module suites are the gate | The `views.ts` design decision: `main.ts` imports `electron` at module top and cannot load under `node --test` | S:90 R:95 A:95 D:95 |

4 assumptions (1 certain, 3 confident, 0 tentative).
