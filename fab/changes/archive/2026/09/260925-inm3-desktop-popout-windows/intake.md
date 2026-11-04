# Intake: Desktop Shell Popout Windows

**Change**: 260925-inm3-desktop-popout-windows
**Created**: 2026-09-25

## Origin

> In the desktop shell, popouts open as shell windows on the same host (not the system browser), and a native web tile moves its live WebContentsView into the popout without reloading. Full spec, task breakdown, standing context (frontend/backend/desktop files, reference implementation, tests, constitution mapping, verification commands) and decisions of record are in fab/plans/sahil/26-09-24-surface-drag-and-popout.md — read the whole file, then use its "Change 6 — shell popout windows" section plus "Standing context" and "Decisions of record" sections as authoritative intake input. Changes 1-5 are already merged to main; this change is the desktop-shell-specific layer on top of change 5's browser popout. Item 3 (native web:reparent) needs a spike first per the plan: does a WebContentsView survive removeChildView + addChildView on another BaseWindow without reload on Electron 43?

One-shot `/fab-new` from the plan. Authoritative input: `fab/plans/sahil/26-09-24-surface-drag-and-popout.md` § Change 6, § Standing context, § Decisions of record. Changes 1–5 (layout tree #1025-era, drag, iso sessions, cross-tab tiles #1041, popout #1045) are on `main` at `4b626712`. This is the last change in the plan's chain (`5 → 6`).

Plan § Change 6 verbatim:

1. `shell:popout { url }` channel: validate same-host route + `?pop=`, open a shell window whose host view loads it; popouts are not restored from `windows.json`.
2. SPA: `lib/shell.ts` narrowing; `popOut()` prefers the bridge over `window.open`.
3. Native web: `web:reparent { tabKey, targetWindow }` — spike first (does a `WebContentsView` survive `removeChildView` + `addChildView` on another `BaseWindow` without reload on Electron 43?).
4. Optional tear-off: releasing a header drag outside the window pops the surface out.
5. Tests: `node --test` for the URL validator; manual shell matrix.
6. Memory: desktop-shell.md § Popout windows.

## Why

**The problem.** Change 5 shipped Pop out for browsers only. In the desktop shell the caller deliberately omits `onPopOut` when `isShell()` (`app.tsx` ~4602 and ~6169; memory `ui/lenses-and-layout.md` § Surface popout → Eligibility), because the shell's window-open policy (`app/desktop/src/window-open.ts` `windowOpenAction`, wired in `main.ts` `setWindowOpenHandler`) sends every http(s) `window.open` to the **system browser** and returns `{ action: "deny" }`. That has two failures:

- `window.open` returns `null` in the opener, so `usePoppedSet.popOut` would roll the mark back and toast "Pop-out blocked by the browser" — while the system browser opens the popout anyway.
- Even if the mark stuck, the system browser shares neither localStorage nor the `BroadcastChannel("rk-popout")` with the shell's host view (different browser profile), so the opener's mark would go stale in 6 s (`POPOUT_STALE_MS`) while the popout keeps running.

So shell users — the primary desktop posture — get no Pop out at all (header verb and `Tile: Pop Out …` palette rows are both hidden).

**If we don't fix it.** Pop out stays browser-only; the desktop shell, whose whole point is multi-window work on one host, is the one place it cannot be used. The web tile is the worst case: in the shell it runs the **native** engine (a guest `WebContentsView`), and a popout that reloads loses page state, login flows, form input, and scroll — the reason the native engine exists.

**Why this approach.** Open the popout as a **shell window on the same host**: host views all use the default session (`hostWebPreferences()` has no partition), so two host views of one origin share localStorage and BroadcastChannel — change 5's coordination (marks, `opened`/`alive`/`closed`/`pop-in`/`ping`, the stale sweep) works unchanged across shell windows. Then move the native web guest between windows instead of re-creating it, reusing the web-views registry's existing park/adopt machinery. Rejected: widening `windowOpenAction` with an in-window branch for registered origins (the policy is deliberately ALL-EXTERNAL — "a new-window intent never navigates the shell window"; a dedicated, validated bridge channel keeps that invariant and gives main the window identity it needs for reparenting); letting the popout reload the web page (acceptable only as the spike's fallback).

## What Changes

### 1. `shell:popout` bridge channel (desktop main + preload)

- **Preload** (`app/desktop/src/preload.ts`): add `windows.popout(payload)` to the existing `windows` group → `ipcRenderer.invoke("shell:popout", payload)`. Additive: older SPAs never call it; the SPA narrows its presence separately (the `close` precedent). Update the preload header comment's `windows` bullet.
- **Payload**: `{ route: string, width?: number, height?: number }` — a **route remainder** (`pathname + search`, e.g. `/rk-dev/@12?pop=web`), never an absolute URL. Main resolves it against the **sender's host entry origin**, so a cross-origin target is unrepresentable.
- **Validation** — a new electron-free pure module (the `window-open.ts` / `window-registry.ts` pattern, e.g. `app/desktop/src/popout.ts` + `popout.test.ts` under `node --test`): `parsePopoutPayload(value)` → `{ route, width, height } | null`:
  - `route` MUST start with a single `/` (reject `//host`, `\`, schemes, control chars/NUL), parse via `new URL(route, hostOrigin)` with the resulting origin **equal** to the host origin, a path of exactly `/<server>/<window-segment>` (the terminal route shape — two non-empty segments), and a `pop` search param present and non-empty. Anything else → `Invalid request`.
  - `width`/`height`: optional finite positive numbers, rounded and clamped to a sane range (e.g. min 320×200, max the primary display work area); absent → `POPOUT_FALLBACK_WIDTH/HEIGHT` mirror (1200×800).
  - Length cap on `route` (e.g. ≤ 2048).
- **Handler** (`main.ts`, beside `shell:new-window`): gated by `isHostsSender(event)` (the error ladder: `Not allowed` → `No host view` when the sender owns no host view, e.g. welcome → `Invalid request`). Resolves the sender's `(window, hostId)`, then:
  - **Dedupe**: a popout registry in main keyed by `(hostId, route)` — mirroring `popoutWindowName`'s `rk-pop:{server}:{@N}:{leaf}` reuse semantics — focuses the existing popout window instead of opening a second, and answers `{ ok: true }`.
  - Otherwise `createWindow({ width, height })` + `attachHostView(win, host, route)`; record the window as a **popout** (`{ openerWindowId, hostId, route }`) in the registry.
  - Returns `{ ok: true, windowId }` (the target for § 3's reparent) — the `IpcResult` envelope.
- **Popout windows are never persisted**: `windowRecord(win)` returns `null` for a popout window (the dev-sentinel precedent), so `windows.json` never restores one, and close-one-window captures skip it.
- **Popout windows are pinned to their host**: host-switch paths (menu host radio on the focused window, `servers:switch` from a popout's renderer) must not re-home a popout window — either refuse or no-op for popout windows. Removing the host (`destroyHostViews`) closes its popout windows rather than degrading them to welcome.
- **New Window (⌘N / menu) from a popout source** duplicates as an ordinary window at the route **without** `?pop=`.
- **Window title**: the popout's document title is already `<Surface> · <window name>` (change 5's `useBrowserTitle` override). The shell's `windowTitle(host, routeLeaf)` would render `{host} — @12`; for popout windows prefer the page title (`page-title-updated`) so OS window switchers read `<Surface> · <window>`.
- **Drag surface**: the window uses the hidden-titlebar treatment every shell window gets. The SPA's 28 px accent strip is drawn above the top bar gated on `isShell()`; the popout posture drops the top bar — apply MUST verify the strip (the window's only drag region under `hiddenInset`/`hidden`) still renders in popout posture, and keep it if not, or the window cannot be moved.

### 2. SPA: bridge narrowing + `popOut()` prefers the bridge

- **`app/frontend/src/lib/shell.ts`**: extend the `windows` group narrowing with `popout` (an `isWindowsPopoutBridge` guard beside `isWindowsCloseBridge`), plus `canShellPopout(): boolean` and `shellPopout(route, rect?): Promise<{ ok: true; windowId: number } | null>` — never throws; resolves `null` in a browser, on an older shell, or on rejection (type narrowing over `as`, the module's existing contract).
- **`app/frontend/src/hooks/use-popout.ts` `popOut`**: when `canShellPopout()`, call `shellPopout(popoutUrl(server, windowId, leafId), rect)` instead of `window.open`; a `null` result rolls the mark back and toasts (reword for the shell, e.g. "Pop-out failed"). The optimistic mark still lands before the call. `window.open` stays the browser path.
- **Eligibility** (`app.tsx` ~4602 and ~6169, and the `lib/palette/layout.ts` Pop rows): replace the `isShell()` exclusion with "not shell, **or** shell with `canShellPopout()`" — so an older shell without the channel still hides Pop out.
- **Closing from the popout**: `usePopoutPresence.closeSelf` and the `pop-in` handler call `window.close()`, which is legal for a script-opened browser window but does nothing for a shell host view. In the shell they MUST close via the existing `closeShellWindow()` (`shell:close-window` closes the SENDER's window) — post `closed` first, as today.
- **Liveness**: unchanged — same origin + default session ⇒ localStorage and `BroadcastChannel("rk-popout")` are shared between the opener's and popout's host views. Apply should confirm this with the manual matrix (open, heartbeat, close via ✕ / ⇧⌘W / Pop back in / opener palette `Tile: Pop Back In`).

### 3. Native web: move the live guest into the popout (spike-gated)

**Spike first (T001-class, go/no-go)**: on Electron 43 (`app/desktop/package.json` `"electron": "^43.2.0"`), does a `WebContentsView` survive `oldWin.contentView.removeChildView(view)` + `newWin.contentView.addChildView(view)` on a **different** `BaseWindow`/`BrowserWindow` without a reload — i.e. same `webContents.id`, no `did-start-loading`/`did-navigate`, JS state (a counter in page memory) intact, and it paints in the new window (the "child never paints on Electron 43/Linux" gotcha is about host-view children; guests are siblings on `win.contentView` and must stay so). Record the result (Linux; macOS if available) in the change and in memory. **Fallback if it fails**: ship § 1–2 with the popout's web tile creating a fresh native guest (a reload — today's browser-popout behavior), record the finding, and leave reparent as a follow-up.

**Design if the spike passes** — reuse the registry's park/adopt identity instead of inventing a new key:

- The retention identity is SPA-side `server\0windowId\0<slot url>` (`web-frame-native.tsx` ~146), prefixed main-side with `(windowId, hostId)`. The popout's web tile renders the same slot url for the same `server`/`@N`, so its `web:create` carries the **same SPA identity string** — only the main-side window scope differs.
- On pop-out, the opener's web tile unmounts (the reduced render drops the popped leaf) and **parks** its guest under `(openerWin, host, identity)`. Reparent = move that entry (live or parked) into the parked set under `(popoutWin, host, identity)`: `removeChildView` from the opener's `contentView`, re-key, and let the popout's `web:create` **adopt** it (`adoptParkedWebView` → `addChildView` on the popout window, re-bind tabKey/hostContentsId, re-apply bounds/zoom/chords, relay retargets automatically via `findWebViewByContents`).
- **Channel shape**: the plan names `web:reparent { tabKey, targetWindow }`. Because the opener's tile may already have parked (tabKey gone from the mounted set) and park vs. popout ordering is React-driven, key the move by **retention identity** and tolerate either order (move a parked entry, or a still-mounted one; or a pending move that the next matching park resolves). The exact channel (`web:reparent { identity, targetWindow }` from the opener, or a `carry` field on `shell:popout`) is apply's call; the invariants are: the target window MUST be a popout window whose `openerWindowId` is the sender's window and whose host matches; the guest keeps its `webContents.id`; it never paints in the opener after the move (attach/detach plans must not re-show it there).
- **Pop back in** (popout window closes by any path) — symmetric, decided at intake: before `destroyWindowViews(popoutWin)` tears down its guests, move each popout guest back into the **opener window's** parked set under `(openerWin, host, identity)` when the opener window is alive and still shows that host; the opener's re-mounting web tile adopts it — no reload either way. If the opener is gone, destroy as today.
- The parked cap (`PARKED_WEB_VIEW_CAP`) and LRU eviction apply per window as today; a move must not evict the moved entry.
- Unit coverage for the pure registry transition(s) in `web-views.test.ts` (move between windows, target-scope validation, never-painted-in-opener, cap interaction).

### 4. Tear-off (plan item 4, optional) — deferred

Releasing a header drag outside the window to pop the surface out is **out of scope** for this change (user decision at intake); record it as a follow-up.

### 5. Tests

- `node --test` (desktop, `cd app/desktop && pnpm run compile && pnpm test`): the popout payload/route validator (same-origin, shape, `?pop=` required, `//evil`, schemes, NUL, length cap, size clamp); popout registry dedupe + `windowRecord` exclusion if extracted pure; the web-views move transition(s).
- Vitest (`just test-frontend`, full): `lib/shell.ts` narrowing (`canShellPopout`, `shellPopout` with present/absent/throwing/`{ok:false}` bridges); `use-popout.test.ts` — `popOut` prefers the bridge, rolls back on `null`, `closeSelf`/`pop-in` close through `closeShellWindow` in the shell; `palette/layout.test.ts` eligibility (shell with vs without the channel).
- Desktop e2e (`just test-desktop-e2e`, new spec in `app/desktop/tests/e2e/`, the `web-native.spec.ts` harness — `_electron.launch` over a seeded `hosts.json`, second window via `electronApp.waitForEvent("window")`): pop a tty tile out → a second window opens on the same host, chrome-less, and the opener reflows; close it → the tile returns; and, if the spike passed, a native web tile whose in-page JS state (e.g. a counter) survives pop-out AND pop back in. Test Intent Comments (file header + Proves/Steps) required. The remaining kinds (code, gui) and edges (⌘N from popout, quit + relaunch → popout not restored, host removal → popout closes, pop back in via opener palette) go in a manual shell matrix recorded in the change.
- Frontend e2e `surface-popout.spec.ts` stays green (browser path unchanged).

### 6. Memory

`run-kit/desktop-shell.md` § Popout windows (new): the channel + validator, popout registry + dedupe, not persisted, host-pinned, title, drag strip, the reparent move (or the spike's negative result). Plus the `window.runkitShell` bridge table, § Web Views IPC table (channel count), and § Windows & the Window Registry. `run-kit/ui/lenses-and-layout.md` § Surface popout: eligibility no longer excludes the shell (gated on the channel), close-self in the shell, per-kind **web** in the shell (moves live vs. reloads).

## Affected Memory

- `run-kit/desktop-shell`: (modify) new § Popout windows (`shell:popout`, validator, popout registry/dedupe, not in `windows.json`, host-pinned, title, drag surface); `windows` bridge group gains `popout`; § Web Views gains the cross-window guest move (or the recorded spike result) and its channel; § Windows & the Window Registry notes popout windows
- `run-kit/ui/lenses-and-layout`: (modify) § Surface popout — shell eligibility via `canShellPopout()`, `popOut` prefers the bridge, shell close-self via `closeShellWindow`, web per-kind behavior in the shell; Design Decision on shell popouts as same-host shell windows

## Impact

- **Desktop** (`app/desktop/src`): `preload.ts` (bridge), `main.ts` (`shell:popout` handler, popout registry, `windowRecord` exclusion, host-switch/host-removal handling, title, guest move + popout-close return), new pure `popout.ts` + test, `web-views.ts` (+ test) move transition, possibly `window-registry.ts` (+ test) for the pure dedupe/record decisions. Electron 43.
- **Frontend** (`app/frontend/src`): `lib/shell.ts`, `hooks/use-popout.ts`, `app.tsx` (two `onPopOut` gates), `lib/palette/layout.ts` (Pop row eligibility), `components/web-frame-native.tsx` only if the move needs an SPA-side signal; their colocated tests. `operator-compose.spec.ts` palette count unaffected unless Pop rows' presence changes in the e2e rig (browser — no).
- **Backend**: none.
- **Security**: a new privileged IPC channel that opens windows — must be `isHostsSender`-gated, payload structurally validated, same-origin by construction (Constitution I spirit; the `window-open.ts` "never widen to a pass-through" stance). The guest move must not let one host's guest land in another host's window (target host match).
- **Constitution**: II (popout state stays viewer localStorage + shell in-memory registry; nothing new persisted — `windows.json` explicitly excludes popouts), IV (no new route: `?pop=` reused), V (Pop out/in palette rows already exist; they become visible in the shell), Test Intent Comments on any touched desktop e2e `test()`.
- **Verification**: `cd app/desktop && pnpm run compile && pnpm test`; `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; `just test-e2e surface-popout.spec`; `just test-desktop-e2e` if a desktop e2e is added.

## Open Questions

- Does a `WebContentsView` survive a cross-window `removeChildView` + `addChildView` on Electron 43 without reload (Linux; macOS)? — the spike, answered at apply before § 3 is built.
- Is the move channel `web:reparent` from the opener, or a `carry` on `shell:popout`? — apply decides after the spike, under § 3's invariants.
- Does the SPA's shell strip render in popout posture today, or does apply have to add it?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope = plan § Change 6 items 1–3, 5, 6; changes 1–5 are on main and are the base | User direction + plan are authoritative; main at 4b626712 carries #1045 Surface Popout | S:95 R:80 A:95 D:95 |
| 2 | Certain | Popouts open as same-host shell windows via a dedicated `shell:popout` channel, not by widening `windowOpenAction` | Plan item 1; window-open.ts policy is deliberately ALL-EXTERNAL with no in-window branch | S:90 R:75 A:90 D:90 |
| 3 | Certain | Popout windows are never persisted to / restored from `windows.json` | Plan item 1 verbatim; `windowRecord` → null is the dev-sentinel precedent | S:95 R:85 A:90 D:95 |
| 4 | Confident | Change 5's localStorage + BroadcastChannel coordination works unchanged across shell windows | Host views use the default session (no partition in `hostWebPreferences`) and share the host origin; to be confirmed in the manual matrix | S:70 R:80 A:75 D:80 |
| 5 | Confident | Payload is a route remainder resolved against the sender host's origin, not an absolute URL | Makes same-host structural; main already owns the sender's host entry; plan's `{ url }` is satisfied in intent | S:60 R:85 A:75 D:65 |
| 6 | Certain | In the shell, popout close-self and `pop-in` close via `closeShellWindow()`, not `window.close()` | `window.close()` is a no-op for a non-script-opened host view; `shell:close-window` closes the sender's window | S:65 R:85 A:85 D:85 |
| 7 | Certain | Pop out eligibility in the shell is gated on the bridge's `popout` invoker presence | Older shells lack the channel and would regress to the system-browser failure; mirrors `close` narrowing | S:70 R:90 A:85 D:85 |
| 8 | Confident | Repeat Pop out of the same leaf focuses the existing popout window (main-side dedupe by host + route) | Mirrors change 5's `popoutWindowName` reuse semantics | S:65 R:85 A:80 D:80 |
| 9 | Certain | Native web reparent is spike-gated; on failure ship 1–2 with a reloading popout and record the result | Plan item 3 says spike first; the fallback equals today's browser-popout behavior | S:90 R:80 A:75 D:80 |
| 10 | Confident | The guest move is keyed by retention identity and reuses park/adopt, not tabKey; exact channel (`web:reparent` vs a `carry` on `shell:popout`) left to apply | tabKey is per-mount and gone once the opener parks; the SPA identity string already matches across windows; invariants fixed in § 3 | S:60 R:70 A:70 D:60 |
| 11 | Certain | Pop back in moves the live guest back to the opener (symmetric), not only outward | Asked — user chose move back live over outward-only | S:95 R:75 A:90 D:90 |
| 12 | Certain | Tear-off (plan item 4) is deferred to a follow-up | Asked — user chose defer | S:95 R:90 A:90 D:95 |
| 13 | Certain | Popout windows are host-pinned (no host switch) and close when their host is removed | Asked — user confirmed the proposed window-edge behaviors | S:90 R:80 A:85 D:85 |
| 14 | Certain | ⌘N from a popout duplicates as an ordinary window without `?pop=` | Asked — user confirmed the proposed window-edge behaviors | S:90 R:85 A:85 D:85 |
| 15 | Certain | Popout windows title from the page title (`<Surface> · <window>`) rather than `{host} — {leaf}` | Asked — user confirmed the proposed window-edge behaviors | S:90 R:90 A:85 D:85 |
| 16 | Confident | Popout posture in the shell must keep a drag surface (the 28 px strip) | Hidden titlebar windows have no other drag region; the top bar drops in popout posture | S:60 R:85 A:80 D:85 |
| 17 | Certain | Add a desktop Electron e2e spec for popout (tty; web state survival if the spike passes); code/gui + edges in a manual matrix | Asked — user chose add Electron e2e over manual-only | S:95 R:85 A:85 D:90 |

17 assumptions (12 certain, 5 confident, 0 tentative, 0 unresolved).
