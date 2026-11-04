# Intake: Fix Web Popout Shrinking the Opener's Terminal

**Change**: 260929-r2mn-web-popout-shrinks-opener-terminal
**Created**: 2026-09-29

## Origin

Conversational. The user reported (with a screenshot) that after **Pop out** on the web tile of a window whose layout is `h(tty,code,web)`, in the desktop shell, the opener's terminal tile renders tmux's dotted out-of-window fill: the tmux window has shrunk to about 80×23 while the xterm stays full size. **Pop back in** restores full size (the user confirmed this).

The root cause was then reproduced in the desktop e2e lane (`app/desktop/tests/e2e/popout.spec.ts`, the web-popout shape, `h(tty,web)` layout) with an instrumented render trace. The user approved the fix below. This intake was generated through a promptless dispatch from the synthesized discussion, so no questions were asked.

> **Bug: popping out a Web surface in the desktop shell shrinks the opener's terminal to 80×23.** After "Pop out" on the web tile of a window with layout `h(tty,code,web)`, the opener's terminal tile renders tmux's dotted out-of-window fill. The tmux window has shrunk to ~80×23 while the xterm stays full-size. Pop back in restores full size.
>
> **Decided fix (user approved):** add a `sessionsReceived` flag to the per-server `ServerSlice` in `session-context.tsx` (false in `EMPTY_SLICE`, set true on the first `sessions` event), expose it next to `sessionsByServer`, and make `app.tsx`'s `payloadArrived` read that flag instead of `sessionsByServer.has(server)`. Regression coverage: extend the desktop web-popout e2e test to assert no `surface-tile-tty` and no `_rk-iso-*` client, plus Vitest unit coverage for the slice flag and the posture signal.

## Why

**The problem.** A web popout should render exactly one leaf, the web surface. A render-order race makes it briefly render the shared layout instead. That transient render mounts a terminal whose relay stream then pins the shared tmux window to 80×24 for every viewer, including the opener. The user sees their main terminal collapse into the dotted out-of-window fill the moment they pop out an unrelated web tile, and it stays that way until they pop back in.

**The mechanism, confirmed by reproduction:**

1. The popout window (`/$server/$window?pop=web`) starts in popout posture. The rule is in `app/frontend/src/app.tsx` (~L1076–1089):
   ```ts
   const payloadArrived = ctx.sessionsByServer.has(server);
   const popWindowLive = popLeaf !== null && windowsById.has(popLeaf.windowId);
   // ...
   const popoutPosture =
     popLeaf !== null && (popWindowLive || popWindowSeen || !payloadArrived);
   ```
   While in posture it renders the single web leaf.
2. `payloadArrived` is `ctx.sessionsByServer.has(server)`. However, `app/frontend/src/contexts/session-context.tsx` (~L1183, the attach-set diff effect) seeds the server's slice with `EMPTY_SLICE` (`sessions: []`) on subscribe, **before** the first `sessions` snapshot arrives. That snapshot comes through `handleServerEvent` `"sessions"` → `updateSlice(key, { sessions, isConnected: true }, true)` (~L886), or through the `onAck` snapshot (~L1087). So for one render, `payloadArrived` is `true` while the window is still absent. In that render `popWindowLive` and `popWindowSeen` are both `false`, so the posture drops.
3. That render passes the full shared layout to `SurfaceLayout`. With the window not yet known, the layout is the default `tty`. The instrumented render sequence observed in the popout:
   `{pop:web, ids:web}` → `{pop:null, ids:tty}` → `{pop:null, ids:tty, everOpened:web,tty}` → `{pop:web, ids:web, everOpened:web,tty}`.
4. The transient render mounts a tty `TerminalClient` and adds `tty` to `SurfaceLayout`'s hide-never-unmount set (`everOpened`, `app/frontend/src/components/surface-layout.tsx` ~L1420). When the posture returns, the tty tile stays mounted, display-hidden at 0×0, for the popout's whole lifetime. Its stream effect (deps `[terminalReady, server, wsRef, connectionEpoch]`) opens with `isolate: true` (`isolate={foreign || popoutTile}`, surface-layout.tsx ~L2826). The result is an `_rk-iso-<N>` attach at xterm's default 80×24 that never resizes.
5. The iso session **links** the same tmux window, and a tmux window has one grid size. `configs/tmux/default.conf` sets `set -g window-size smallest` (L87), a deliberate correctness guard against a tmux pane-border-status redraw hang. So the window clamps to the 80×24 client for every viewer. On the rig: opener client 126×37, iso client 80×24, window 80×23.
6. `sessionsByServer.has(server)` is used as a "payload arrived" signal **only** at `app.tsx:1076` (confirmed by grep: every other `sessionsByServer` consumer reads `.get(...) ?? []`).

**If we don't fix it:** every web popout in the desktop shell (and, by the same race, in a browser popout) silently attaches a hidden 80×24 terminal client, shrinking the opener's terminal and every other viewer of that window until pop-in. It also wastes a relay stream and an iso session for a surface the popout never shows.

**Why this approach.** The bug comes from an ambiguous signal: "the slice exists" was standing in for "the first payload arrived". The fix makes that signal explicit at its source (the slice) instead of patching the render path. Rejected alternatives:
- **Changing `window-size smallest`.** It is a deliberate guard, and two viewers of one tmux window necessarily share one size. A popped-out *tty* tile smaller than the opener still legitimately shrinks the shared window. That is by design and not part of this bug.
- **Defense in depth, "a never-visible tty tile opens no relay stream".** This is a possible separate follow-up, not part of this change. It treats the symptom downstream, while the root cause is the wrong posture signal.

## What Changes

### 1. `session-context.tsx`: a per-server `sessionsReceived` flag

File: `app/frontend/src/contexts/session-context.tsx`.

- Extend `ServerSlice` (~L370) with `sessionsReceived: boolean`:
  ```ts
  type ServerSlice = {
    sessions: ProjectSession[];
    sessionOrder: string[];
    isConnected: boolean;
    metrics: MetricsSnapshot | null;
    previews: Record<string, string>;
    /** True once this subscription has delivered a real sessions snapshot
     *  (a `sessions` event or an ack carrying an array snapshot). The seeded
     *  `EMPTY_SLICE` is NOT a payload. */
    sessionsReceived: boolean;
  };
  const EMPTY_SLICE: ServerSlice = { /* ...existing... */ sessionsReceived: false };
  ```
- Set it `true` on the first `sessions` event: `handleServerEvent` `"sessions"` becomes `updateSlice(key, { sessions, isConnected: true, sessionsReceived: true }, true)`.
- On the `onAck` path (~L1087), whose comment calls its array snapshot "parity with the first `event: sessions`": set `sessionsReceived: true` **only when `Array.isArray(snapshot)`**. A `null` snapshot ("no snapshot yet") leaves the flag as it is.
- The seed on subscribe (`updateSlice(name, EMPTY_SLICE)`, ~L1183) keeps writing `sessionsReceived: false`. A `gone` / unsubscribe drops the slice, and a re-subscribe re-seeds `false`, which is correct because the next snapshot is a fresh payload. Socket drop/reconnect only toggles `isConnected` (`applyServerConnected`) and leaves the flag set.
- Expose it on `SessionContextType`, next to `sessionsByServer`, following the existing derived-Map pattern (`isConnectedByServer`, ~L1236):
  ```ts
  /** Per-server: true once the first sessions snapshot arrived for the
   *  current subscription (the seeded empty slice does not count). */
  sessionsReceivedByServer: Map<string, boolean>;
  ```
  Derive it in a `useMemo` over `slicesByServer`, add it to the context `value` object and its deps list.
- `StandaloneSessionContextProvider` (~L1610): default `sessionsReceivedByServer` when not supplied. Recommended default: derive `true` for every key present in the supplied `sessionsByServer`, so existing tests that hand in a sessions map keep their "payload arrived" semantics. A test can pass an explicit map to model the pre-payload window.

### 2. `app.tsx`: `payloadArrived` reads the flag

File: `app/frontend/src/app.tsx` (~L1076).

```ts
const payloadArrived = ctx.sessionsReceivedByServer.get(server) === true;
```

Everything else in the posture rule (`popWindowLive`, `popWindowSeen`, `popoutPosture`, `popoutEnded`) is unchanged. Update the adjacent comment ("optimistically until the first payload arrives") so it states that the seeded empty slice is not a payload.

**Result:** the popout stays in posture until a real snapshot arrives. It then either finds the window live (and stays in posture) or finds it known-absent (and degrades to the ordinary terminal render, the existing drop-don't-error posture). A web popout therefore never renders the shared layout, never mounts a tty `TerminalClient`, never adds `tty` to `everOpened`, opens no relay stream, and no `_rk-iso-*` client attaches.

### 3. Regression coverage

**Desktop e2e, `app/desktop/tests/e2e/popout.spec.ts`:** extend the existing web-popout test, `"a web tile's guest moves to the popout window and back with its JS state intact"` (~L473, seeded with `seedTtyWebWindow`, layout `h(tty,web)`). After the popout's web tile is visible and the guest has moved, add:

- The popout renders **no** tty tile: `expect(popPage.getByTestId("surface-tile-tty")).toHaveCount(0)`. This must be a count assertion, not `toBeHidden()`, because the bug's tty tile IS mounted but display-hidden, so `toBeHidden()` would pass on the buggy build.
- **No `_rk-iso-*` client** is attached on the rig tmux server (`TMUX_SERVER` from `../../../frontend/tests/e2e/_tmux`): `tmux -L <TMUX_SERVER> list-clients -F '#{client_session}'` yields no line starting with `_rk-iso-`. The `_tmux.ts` fixture currently has no `list-clients` helper (its exports are `createSession`, `killSession`, `newWindow`, `listWindows`, `setWindowOption`, `stampWebTab`, …), so add one there (e.g. `listClients(opts?)` returning `client_session`/size rows) using the fixture's existing `execFileSync` argument-slice pattern.
- Update the test's JSDoc **Proves:** / **Steps:** block in the same commit (Constitution § Test Intent Comments), with no change IDs or PR numbers.

Run it with the desktop lane recipe `just test-desktop-e2e` (not `RK_E2E_LANE=desktop just test-e2e`). A fresh worktree needs `pnpm compile` in `app/desktop` first.

**Vitest unit coverage (where it fits existing patterns):**
- `app/frontend/src/contexts/session-context.test.tsx`: follow the existing `WS.forServer(...)!.emit("sessions", …)` pattern (e.g. "reports per-server isConnected independently", ~L366). Assert `sessionsReceivedByServer.get("runkit")` is `false` after subscribe (seeded slice present, so `sessionsByServer.has` is already true) and `true` after the first `sessions` emit. If the WS mock exposes ack snapshots, also cover the ack-array vs ack-null distinction, and the reset to `false` after `server-gone` + re-subscribe.
- Posture signal in `app/frontend/src/app.test.tsx` (it already uses `StandaloneSessionContextProvider`): render the terminal route with `?pop=web`, a `sessionsByServer` entry of `[]` for the server, and `sessionsReceivedByServer` `false`. Assert that the popout posture holds (no `surface-tile-tty`), and that flipping to received-with-window-absent degrades to the ordinary render.

### Out of scope (explicit)

- Any change to `window-size smallest` in `configs/tmux/default.conf`.
- The "never-visible tty tile opens no relay stream" guard in `surface-layout.tsx`. This is a possible separate follow-up.
- Tty popouts legitimately shrinking the shared window when smaller than the opener. That is by design.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Surface popout, "The popout window" bullet. The "once the sessions payload has arrived" clause gets its precise meaning: the posture is optimistic until the server's first real sessions snapshot (`sessionsReceived`), and the seeded empty slice does not count. Note also that a web popout therefore never mounts a tty tile or an `_rk-iso-*` attach.
- `run-kit/ui/routes-and-shell`: (modify) the session-context state-shape description (per-server keyed Maps: `sessionsByServer`, `sessionOrderByServer`, `isConnectedByServer`, …) gains `sessionsReceivedByServer` and its semantics (false on the seeded slice, true on the first `sessions` event or array ack snapshot, reset on re-subscribe).

## Impact

- **Code:** `app/frontend/src/contexts/session-context.tsx` (slice type, seed, event/ack handlers, derived Map, context value, standalone provider), `app/frontend/src/app.tsx` (one line plus a comment).
- **Tests:** `app/desktop/tests/e2e/popout.spec.ts` (web-popout test extended), `app/frontend/tests/e2e/_tmux.ts` (new `listClients` helper), `app/frontend/src/contexts/session-context.test.tsx`, possibly `app/frontend/src/app.test.tsx`.
- **Consumers of `SessionContextType`:** adding a field is additive. Hand-built context values in tests go through `StandaloneSessionContextProvider`, so its default covers them. Check `tsc --noEmit` for any other literal `SessionContextType` construction.
- **Spec:** `docs/specs/surface-layout.md` § Verbs → Pop out does not carry the "optimistically until the first payload" wording (verified by grep: that rule lives only in the `app.tsx` comment and in memory), so no spec edit is expected. The spec's statement that "a popped-out terminal attaches an isolated `_rk-iso-*` session" stays true, and it is now true only for tty popouts.
- **Runtime behavior:** a popout on a slow first snapshot stays in posture a little longer (up to the first snapshot) instead of flashing the shared layout. No backend, API, or tmux-config change.
- **Gates:** `just test-frontend` (full Vitest, not scoped), `cd app/frontend && npx tsc --noEmit`, `just test-desktop-e2e` for the popout spec.

## Open Questions

- Should the e2e also assert that the opener's window width is unchanged after the web popout (e.g. `#{window_width}` before/after via `list-windows`)? That is a more direct symptom check than "no iso client". It is left to plan generation as an optional extra assertion, not required by the decided fix.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause is the seeded `EMPTY_SLICE` making `sessionsByServer.has(server)` true before the first snapshot, dropping the popout posture for one render and mounting a hidden tty tile whose isolated 80×24 attach clamps the shared window under `window-size smallest` | Discussed: reproduced in the desktop e2e lane with an instrumented render trace and rig client/window sizes | S:95 R:85 A:95 D:95 |
| 2 | Certain | Fix: add `sessionsReceived` to `ServerSlice` (false in `EMPTY_SLICE`, true on first `sessions` event), expose it per server, and have `app.tsx` `payloadArrived` read it instead of `sessionsByServer.has(server)` | Discussed: user approved this fix | S:95 R:85 A:90 D:90 |
| 3 | Certain | `window-size smallest` stays unchanged; tty popouts smaller than the opener still shrink the shared window by design | Discussed: explicitly rejected as a deliberate guard | S:95 R:90 A:95 D:95 |
| 4 | Certain | The "never-visible tty tile opens no relay stream" defense-in-depth guard is out of scope | Discussed: noted as a possible separate follow-up | S:90 R:90 A:90 D:90 |
| 5 | Certain | `app.tsx:1076` is the only consumer using `sessionsByServer.has` as a payload signal, so no other call site changes | Discussed and re-verified by grep: every other consumer uses `.get(...) ?? []` | S:90 R:85 A:95 D:90 |
| 6 | Confident | Expose the flag as `sessionsReceivedByServer: Map<string, boolean>`, derived with `useMemo` over `slicesByServer` like `isConnectedByServer` | Description says "a per-server map/accessor alongside `sessionsByServer`"; the derived-Map pattern is the file's established shape | S:70 R:85 A:80 D:70 |
| 7 | Confident | An `onAck` carrying an array snapshot also sets `sessionsReceived: true`; a null ack snapshot leaves it unchanged | The ack handler's own comment names its array snapshot "parity with the first `event: sessions`", and a null snapshot means "no snapshot yet". Without this, a known-absent window might never degrade if no `sessions` event follows the ack | S:55 R:80 A:75 D:65 |
| 8 | Confident | The flag resets to false only when the slice is re-seeded (subscribe after gone/unsubscribe); a socket drop/reconnect leaves it set | Follows from the slice lifecycle: `applyServerConnected` only toggles `isConnected`, and the gone/unsubscribe paths delete the slice | S:60 R:85 A:80 D:75 |
| 9 | Confident | `StandaloneSessionContextProvider` defaults `sessionsReceivedByServer` to true for every key in the supplied `sessionsByServer` | Keeps existing tests' "payload arrived" semantics unchanged; an explicit map models the pre-payload window | S:50 R:90 A:70 D:60 |
| 10 | Certain | The e2e tty-absence check uses `toHaveCount(0)`, not `toBeHidden()` | The bug's tty tile is mounted display-hidden, so `toBeHidden()` would pass on the buggy build | S:80 R:90 A:90 D:85 |
| 11 | Confident | The no-iso check reads `tmux -L <TMUX_SERVER> list-clients -F '#{client_session}'` and fails on any `_rk-iso-` prefix, via a new `listClients` helper in the shared `_tmux.ts` fixture | Description specifies list-clients on the rig tmux server; the fixture is where the spec's other tmux helpers live and has no list-clients helper yet | S:70 R:90 A:75 D:65 |
| 12 | Confident | The posture-signal Vitest lives in `app.test.tsx` (popout route with `sessionsReceivedByServer` false vs true-with-window-absent); fall back to session-context-only coverage if mounting the popout route there is impractical | Description says "where it fits existing test patterns"; `app.test.tsx` already uses the standalone provider, but no existing test there mounts `?pop=` | S:45 R:90 A:55 D:50 |
| 13 | Confident | No `docs/specs/surface-layout.md` edit is needed; memory updates go to `ui/lenses-and-layout` and `ui/routes-and-shell` | Grep found no "first payload / optimistically" wording in the spec; the posture rule's prose lives in memory | S:50 R:90 A:65 D:55 |

13 assumptions (6 certain, 7 confident, 0 tentative, 0 unresolved).
