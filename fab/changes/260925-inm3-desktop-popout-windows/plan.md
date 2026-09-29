# Plan: Desktop Shell Popout Windows

**Change**: 260925-inm3-desktop-popout-windows
**Intake**: `intake.md`

## Requirements

### Desktop: `shell:popout` channel

#### R1: Popout payload validation
The shell SHALL expose a pure, electron-free validator (new `app/desktop/src/popout.ts`) that accepts `{ route, width?, height? }` and a host origin, and returns a normalized `{ route, width, height }` or `null`. `route` MUST be a string ≤ 2048 chars starting with exactly one `/` (no `//`, no `\`, no scheme, no control characters incl. NUL); `new URL(route, hostOrigin)` MUST keep the host origin; the pathname MUST be exactly two non-empty segments (`/<server>/<window-segment>`); the `pop` search param MUST be present and non-empty. `width`/`height` are optional finite positive numbers, rounded and clamped to `[POPOUT_MIN_WIDTH=320, POPOUT_MAX_*]` / `[POPOUT_MIN_HEIGHT=200, …]`; absent/invalid-but-optional → `1200×800` (mirroring the SPA's `POPOUT_FALLBACK_WIDTH/HEIGHT`). Any required-field failure → `null`.

- **GIVEN** host origin `http://localhost:3000`
- **WHEN** the payload is `{ route: "/rk-dev/@12?pop=web", width: 640.4, height: 480 }`
- **THEN** the validator returns `{ route: "/rk-dev/@12?pop=web", width: 640, height: 480 }`
- **AND** `//evil.com/a/b?pop=x`, `https://evil.com/a/b?pop=x`, `/a/b` (no pop), `/a/b?pop=`, `/a?pop=x`, `/a/b/c?pop=x`, `/a\u0000/b?pop=x`, a 3000-char route, and a non-string route all return `null`

#### R2: `shell:popout` handler opens a same-host shell window
`main.ts` SHALL handle `shell:popout` gated by `isHostsSender(event)` with the ladder `Not allowed` → `No host view` (sender owns no host view, e.g. welcome) → `Invalid request` (R1 `null`). On success it SHALL open a new `BrowserWindow` via `createWindow({ width, height })`, attach the sender's host view at the validated route (`attachHostView(win, host, route)`), record the window in a main-side popout registry `{ openerWindowId, hostId, route }`, and resolve `{ ok: true, windowId }`.

- **GIVEN** a registered host view in window A at `/rk-dev/@12`
- **WHEN** its SPA invokes `shell:popout { route: "/rk-dev/@12?pop=tty" }`
- **THEN** a second shell window opens on the same host showing that route, and the invoke resolves `{ ok: true, windowId: <B> }`
- **AND** no system browser opens

#### R3: Popout dedupe
A `shell:popout` whose `(hostId, route)` matches a live popout window SHALL focus that window (restore if minimized) and resolve `{ ok: true, windowId }` without opening a second window. The dedupe decision SHALL be pure and unit-tested.

- **GIVEN** a live popout for `(e2e-a, /rk-dev/@12?pop=tty)`
- **WHEN** the same route is popped out again from any window of that host
- **THEN** the existing popout is focused and no new window is created

#### R4: Popouts are never persisted
`windowRecord(win)` SHALL return `null` for a popout window, so `windows.json` never records or restores one (quit and close-one-window paths alike).

- **GIVEN** an ordinary window and a popout window are open
- **WHEN** the app quits and relaunches
- **THEN** only the ordinary window is restored

#### R5: Popouts are pinned to their host
A popout window SHALL NOT change host: `switchToHost` for a popout window (menu host radio on a focused popout, `servers:switch` from a popout's renderer) SHALL be refused (`{ ok: false, error: "Popout window" }` or equivalent no-op). Removing a host SHALL close that host's popout windows instead of degrading them to welcome/another host.

- **GIVEN** a popout window for host `e2e-a`
- **WHEN** host `e2e-a` is removed
- **THEN** the popout window closes; ordinary windows follow today's fallback

#### R6: New Window from a popout is an ordinary window
`openDuplicateWindow` with a popout source SHALL open an ordinary (non-popout) window on the same host at the source route with the `pop` search param removed. The route rewrite SHALL be pure and unit-tested.

- **GIVEN** a focused popout at `/rk-dev/@12?pop=tty`
- **WHEN** New Window (⌘N / menu) runs
- **THEN** an ordinary window opens at `/rk-dev/@12`

#### R7: Popout window title
A popout window's native title SHALL follow its page's document title (`<Surface> · <window name>`, set by change 5) instead of `windowTitle(host, routeLeaf)`.

- **GIVEN** a tty popout of window `rk-dev`
- **WHEN** the page title updates to `Terminal · rk-dev`
- **THEN** the BrowserWindow title is `Terminal · rk-dev`

#### R8: Preload bridge
`preload.ts` SHALL add `windows.popout(payload)` → `ipcRenderer.invoke("shell:popout", payload)` to the existing `windows` group, additive, and document it in the header comment.

- **GIVEN** a shell with this preload
- **WHEN** the SPA reads `window.runkitShell.windows.popout`
- **THEN** it is a function that invokes `shell:popout`

### Frontend: popout through the shell

#### R9: Shell bridge narrowing
`app/frontend/src/lib/shell.ts` SHALL add `canShellPopout(): boolean` (true iff `windows.popout` is a function) and `shellPopout(route, rect?): Promise<{ windowId: number } | null>` — never throws; resolves `null` in a browser, on an older shell, on a rejected invoke, or on any result that is not `{ ok: true, windowId: number }`. Narrowing by type guards, no `as` casts.

- **GIVEN** an older shell whose `windows` group has only `newWindow`/`close`
- **WHEN** `canShellPopout()` runs
- **THEN** it returns `false`

#### R10: `popOut` prefers the bridge
`usePoppedSet.popOut` SHALL, when `canShellPopout()`, call `shellPopout(popoutUrl(server, windowId, leafId), rect)` instead of `window.open`, keeping the optimistic mark before the call; a `null` result SHALL roll the mark back and toast `"Pop-out failed"`. The browser path is unchanged.

- **GIVEN** the shell bridge resolves `{ ok: false }`
- **WHEN** the user pops out the web tile
- **THEN** the mark is rolled back, the tile reappears, and an error toast shows

#### R11: Shell popouts close through the shell
In the shell, `usePopoutPresence`'s `closeSelf` and its `pop-in` handler SHALL post `closed` and then close via `closeShellWindow()` instead of `window.close()` (a no-op for a host view). The browser path is unchanged.

- **GIVEN** a shell popout window
- **WHEN** the opener's palette runs `Tile: Pop Back In Terminal`
- **THEN** the popout window closes and the opener's tile returns

#### R12: Pop out is offered in capable shells
The `onPopOut` gates in `app.tsx` (header verb ~4602, palette/tiles ~6169) and the palette Pop-row eligibility SHALL replace the unconditional `isShell()` exclusion with "not shell OR `canShellPopout()`"; a shell lacking the channel still hides Pop out.

- **GIVEN** the shell with the new preload
- **WHEN** a ≥2-tile layout renders on a fine pointer
- **THEN** the header shows Pop out and the palette lists `Tile: Pop Out …`

### Desktop: live web guest move (spike-gated)

#### R13: Cross-window reparent spike
Before building R14–R15, apply SHALL run a spike on Electron 43: a `WebContentsView` removed from window A's `contentView` and added to window B's keeps its `webContents.id`, fires no `did-start-loading`/`did-navigate`, keeps in-page JS state, and paints in B (Linux; macOS if available). The result SHALL be recorded in `## Notes` of this plan. If it fails, R14–R15 SHALL be skipped (tasks marked N/A with the finding), the popout's web tile creates a fresh guest (reload), and the finding is recorded for memory.

- **GIVEN** a guest page with a JS counter at 7
- **WHEN** the view is moved from window A to window B
- **THEN** B shows the counter at 7 with no navigation events

#### R14: Outward move keyed by retention identity
When a native web tile is popped out, the shell SHALL move its guest (live or parked) from `(openerWin, host, identity)` into the parked set under `(popoutWin, host, identity)`, so the popout's `web:create` with the same SPA identity string ADOPTS it (same `webContents.id`, no reload). The move SHALL tolerate either order of opener `web:park` vs. the move request. The target window MUST be a popout window whose `openerWindowId` is the sender's window and whose `hostId` matches the sender's host; otherwise `Invalid request`. A moved guest MUST never paint in the opener afterward, and the move MUST NOT evict the moved entry via the parked cap. The registry transition(s) SHALL be pure in `web-views.ts` with `web-views.test.ts` coverage. The exact channel (`web:reparent { identity, targetWindow }` from the opener, or a `carry` on `shell:popout`) is apply's choice under these invariants.

- **GIVEN** window A's web tile shows a page with a JS counter at 7
- **WHEN** the user pops the web tile out
- **THEN** the popout shows the same page with the counter at 7, and A's contentView no longer holds the guest

#### R15: Return move on popout close
When a popout window closes by any path, the shell SHALL, before `destroyWindowViews(popoutWin)` destroys guests, move each guest of that popout back into the opener window's parked set under `(openerWin, host, identity)` when the opener window is alive and still attached to that host; the opener's re-mounting web tile adopts it. Otherwise the guest is destroyed as today.

- **GIVEN** a popped-out web page with its counter at 9
- **WHEN** the user pops it back in
- **THEN** the opener's web tile shows the counter at 9 with no reload

### Tests & docs

#### R16: Desktop e2e for shell popout
A new spec in `app/desktop/tests/e2e/` (the `web-native.spec.ts` harness) SHALL prove: tty Pop out opens a second window on the same host, chrome-less, and the opener reflows; closing it returns the tile; and — if R13 passed — a native web tile's in-page JS state survives pop-out and pop back in. File header + per-`test()` Proves/Steps intent comments per the constitution.

- **GIVEN** the desktop e2e rig with a seeded host
- **WHEN** `just test-desktop-e2e <spec>` runs
- **THEN** the popout tests pass

#### R17: Manual matrix recorded
The change SHALL record a manual shell matrix (code, gui kinds; ⌘N from popout; quit + relaunch; host removal; pop back in via opener palette) in this plan's `## Notes`, with results.

- **GIVEN** a built shell
- **WHEN** each row is exercised
- **THEN** its observed result is noted

### Non-Goals

- Tear-off (release a header drag outside the window to pop out) — deferred by user decision at intake.
- Changing `windowOpenAction`'s ALL-EXTERNAL policy — popouts use the dedicated channel.
- Backend changes — none needed.

### Design Decisions

#### Shell popouts are same-host shell windows over a dedicated channel
**Decision**: the SPA's `popOut` calls `shell:popout { route }`; main resolves the route against the sender's host origin and opens a shell window on that host.
**Why**: host views share the default session, so change 5's localStorage marks and `BroadcastChannel("rk-popout")` work unchanged; a route (not a URL) makes "same host" structural; the window-open policy stays ALL-EXTERNAL.
**Rejected**: an in-window branch in `windowOpenAction` for registered origins — breaks the "a new-window intent never navigates the shell" invariant and gives main no popout identity for dedupe or guest moves.
*Introduced by*: 260925-inm3-desktop-popout-windows

#### The native web guest moves between windows by retention identity
**Decision**: reparent re-keys the guest into the target window's parked set under the same SPA identity and lets the popout's `web:create` adopt it; popout close moves it back.
**Why**: the identity string (`server\0windowId\0slotUrl`) already matches across windows and park/adopt already re-binds tabKey, bounds, zoom, chords and the relay; tabKey is gone once the opener parks.
**Rejected**: tabKey-keyed `web:reparent` — the key is per-mount and races the opener's unmount; recreating the guest — reloads the page.
*Introduced by*: 260925-inm3-desktop-popout-windows

## Tasks

### Phase 1: Setup

- [x] T001 Spike (R13): in a throwaway Electron 43 script under the scratchpad (not committed) or a temporary branch in `app/desktop`, create two `BaseWindow`/`BrowserWindow`s, load a page with a JS counter into a `WebContentsView` sibling on window A's `contentView`, move it (`removeChildView` A → `addChildView` B), and check `webContents.id`, navigation events, counter value, and painting (screenshot via `webContents.capturePage` or `win.capturePage`). Record the result in `## Notes`. If it fails, mark T010–T012 N/A with the finding. <!-- R13 -->

### Phase 2: Core Implementation

- [x] T002 [P] Create `app/desktop/src/popout.ts` (electron-free): `parsePopoutPayload(value, hostOrigin)`, size constants, `stripPopParam(route)` (R6), and a pure popout-registry helper `findPopoutWindow(registry, hostId, route)` (R3); plus `app/desktop/src/popout.test.ts` covering every R1 accept/reject case, the size clamp/fallback, dedupe, and `stripPopParam`. <!-- R1 -->
- [x] T003 `app/desktop/src/main.ts`: popout registry (`Map<number, { openerWindowId, hostId, route }>`, cleared on `closed`), the `shell:popout` handler beside `shell:new-window` with the R2 error ladder, `createWindow` + `attachHostView`, dedupe focus via T002 (R3), result `{ ok: true, windowId }`. <!-- R2 -->
- [x] T004 `app/desktop/src/main.ts`: `windowRecord` returns `null` for popout windows (R4); `switchToHost` refuses for popout windows (R5); `destroyHostViews`/host removal closes that host's popout windows (R5); `openDuplicateWindow` from a popout source uses `stripPopParam` (R6); popout windows take their title from `page-title-updated` instead of `windowTitle` (R7). Keep pure decisions in `popout.ts`/`window-registry.ts` with tests where they are decisions. <!-- R4 -->
- [x] T005 [P] `app/desktop/src/preload.ts`: `windows.popout(payload)` invoker + header-comment bullet (R8). <!-- R8 -->
- [x] T006 [P] `app/frontend/src/lib/shell.ts`: `canShellPopout`, `shellPopout(route, rect?)` with type-guard narrowing (`isWindowsPopoutBridge`), plus `lib/shell.test.ts` cases (absent group, older group, throwing invoke, `{ok:false}`, malformed result, success). <!-- R9 -->
- [x] T007 `app/frontend/src/hooks/use-popout.ts`: `popOut` prefers `shellPopout` when `canShellPopout()` (optimistic mark, `null` → rollback + `"Pop-out failed"` toast); `closeSelf` and the `pop-in` handler close via `closeShellWindow()` in the shell; tests in `hooks/use-popout.test.ts` (bridge preferred, rollback, shell close path, browser path unchanged). <!-- R10 -->
- [x] T008 `app/frontend/src/app.tsx` (~4602, ~6169) and `app/frontend/src/lib/palette/layout.ts`: replace the `isShell()` Pop-out exclusion with "not shell OR `canShellPopout()`"; update `lib/palette/layout.test.ts` eligibility (shell with vs. without the channel) and any `surface-layout.test.tsx` expectations that assumed shell exclusion. <!-- R12 -->

### Phase 3: Integration & Edge Cases

- [x] T009 Verify R11 end to end in code: the shell popout's Pop back in verb, the opener's `Tile: Pop Back In`, ✕ and ⇧⌘W all clear the opener's mark (the `closed` message is posted before `closeShellWindow()`); add any missing unit coverage. <!-- R11 -->
- [x] T010 (spike-gated) `app/desktop/src/web-views.ts`: pure transition(s) to move a guest entry (mounted or parked) between window scopes by `(hostId, identity)`, including a pending-move record resolved by a later park, cap-safe (never evicts the moved entry); `web-views.test.ts` coverage (move mounted, move parked, pending then park, wrong host/target rejected, cap interaction, attach/detach plans of the opener exclude the moved entry). <!-- R14 -->
- [x] T011 (spike-gated) `app/desktop/src/main.ts` (+ `preload.ts` / `lib/shell.ts` / `components/web-frame-native.tsx` or `hooks/use-popout.ts` as the chosen channel requires): wire the outward move — `removeChildView` from the opener's `contentView`, re-key via T010, adoption by the popout's `web:create`; validate target window is a popout of the sender's window on the same host. <!-- R14 -->
- [x] T012 (spike-gated) `app/desktop/src/main.ts`: on popout window `close`, before `destroyWindowViews`, move its guests back into the opener's parked set when the opener is alive and attached to that host; else destroy as today. <!-- R15 -->

### Phase 4: Polish

- [x] T013 New `app/desktop/tests/e2e/popout.spec.ts` (harness from `web-native.spec.ts` / `_shell.ts`): tty pop out → second window, chrome-less (no top bar), opener reflows; close → tile returns; if the spike passed, web JS state survives pop out and pop back in. File header + Proves/Steps on every `test()`. Run `just test-desktop-e2e popout.spec`. <!-- R16 -->
- [x] T014 Run gates: `cd app/desktop && pnpm run compile && pnpm test`; `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; `just test-e2e surface-popout.spec`; `just test-desktop-e2e`. Record the manual matrix (code, gui, ⌘N from popout, quit + relaunch, host removal, opener-palette pop back in) in `## Notes` — rows that cannot be exercised in this environment are noted as such. <!-- R17 -->

## Execution Order

- T001 gates T010–T012 (and the web half of T013).
- T002 blocks T003–T004; T003 blocks T004 and T011.
- T005 and T006 block T007; T007 blocks T008–T009.
- T013 needs T003–T009 (and T011–T012 for its web test).

## Acceptance

### Functional Completeness

- [x] A-001 R1: `parsePopoutPayload` accepts the valid route shape and rejects every listed malformed case, with `popout.test.ts` covering each
- [x] A-002 R2: `shell:popout` opens a same-host shell window at the route and resolves `{ ok: true, windowId }`; no system browser opens
- [x] A-003 R3: a repeat pop out of the same `(host, route)` focuses the existing popout window
- [x] A-004 R4: `windowRecord` returns `null` for popout windows; relaunch restores no popout
- [x] A-005 R5: popout windows refuse host switches and close when their host is removed
- [x] A-006 R6: New Window from a popout opens an ordinary window at the route without `pop`
- [x] A-007 R7: popout window titles follow the page title
- [x] A-008 R8: `windows.popout` exists in the preload and invokes `shell:popout`
- [x] A-009 R9: `canShellPopout`/`shellPopout` narrow the bridge without `as` casts and never throw
- [x] A-010 R10: `popOut` uses the shell bridge when available and rolls back with a toast on `null`
- [x] A-011 R11: shell popouts close via `closeShellWindow()` after posting `closed`
- [x] A-012 R12: Pop out (header + palette) is offered in shells with the channel and hidden in shells without it
- [x] A-013 R13: the spike result is recorded in `## Notes`, and R14–R15 are built or marked N/A accordingly
- [x] A-014 R14: a popped-out native web tile keeps its `webContents.id` and page state (or N/A per R13)
- [x] A-015 R15: popping back in returns the live guest to the opener without reload (or N/A per R13)
- [x] A-016 R16: `app/desktop/tests/e2e/popout.spec.ts` exists, carries intent comments, and passes
- [x] A-017 R17: the manual matrix is recorded with results

### Behavioral Correctness

- [x] A-018 R12: browser Pop out behavior is unchanged (`surface-popout.spec.ts` passes)

### Scenario Coverage

- [x] A-019 R10: Vitest covers bridge-preferred, rollback, and browser-path cases in `use-popout.test.ts`
- [x] A-020 R14: `web-views.test.ts` covers move-mounted, move-parked, pending-then-park, wrong-target rejection, and cap interaction (or N/A per R13)

### Edge Cases & Error Handling

- [x] A-021 R2: welcome sender → `No host view`; non-host sender → `Not allowed`; malformed payload → `Invalid request`
- [x] A-022 R14: a move request naming a non-popout window, another opener's popout, or another host's window is rejected
- [x] A-023 R15: a popout closing after its opener window closed destroys its guests (no leak, no crash)

### Code Quality

- [x] A-024 Pattern consistency: new desktop logic follows the electron-free pure-module + `node --test` pattern (`window-open.ts`, `web-views.ts`); frontend follows `lib/shell.ts` narrowing style
- [x] A-025 No unnecessary duplication: popout URL building reuses `popoutUrl`; window creation reuses `createWindow`/`attachHostView`; guest moves reuse park/adopt
- [x] A-026: Type narrowing over `as` casts in all new TypeScript
- [x] A-027: New features carry tests (node --test, Vitest, desktop e2e)
- [x] A-028: No magic numbers — size bounds and length caps are named constants
- [x] A-029: Comments state constraints only — no narration, no change IDs / PR numbers

### Security

- [x] A-030 R1: the popout route cannot target another origin or scheme (structural resolution against the sender host's origin + validator), and `shell:popout` is `isHostsSender`-gated
- [x] A-031 R14: a guest can never be moved into another host's window

## Notes

- **T001 spike result (R13): PASS** on Electron 43.2.0 / Linux under `xvfb-run -a` (throwaway script, not committed, deleted after the run). A `WebContentsView` sibling removed from window A's `contentView` and added to window B's: kept its `webContents.id` (3 → 3), fired **no** `did-start-loading`/`did-navigate` during the move, kept in-page JS state (`window.counter` 7 → 7), and **painted in window B** (X-screen capture via `desktopCapturer` shows the guest's background inside B's content rect; A's window no longer shows it). macOS: not exercised (unavailable in this environment). ⇒ R14–R15 are built.
- **T013 e2e result (R16)**: `app/desktop/tests/e2e/popout.spec.ts` — 3 tests (tty pop out → chrome-less second window + opener reflow + pop back in; repeat pop-out dedupe-focuses the live popout; web guest move: same `webContents.id`, JS state intact, visible at the popout tile's rect, and back on pop-in) — `3 passed` on two consecutive runs of `just test-desktop-e2e popout.spec`. The e2e surfaced two real bugs, both fixed in this change: (a) a popped web leaf kept a mounted-hidden tile in the opener, staling the guest's visibility record and blocking adoption — fixed by unmounting popped web leaves under a popout-capable shell (the code-leaf precedent in `surface-layout.tsx`), so the guest parks on unmount and the popout adopts it; (b) `web-frame-native`'s first-commit bounds/visible sends race the create's mode await and are dedupe-suppressed — fixed by a post-create forced re-measure + visibility re-send, which converges every mount (adopts included).
- **T009 finding (R11)**: the popout's Pop back in verb and the opener's `Tile: Pop Back In` both post `closed` before closing via `closeShellWindow()` (unit-covered, call order asserted). The ✕/⇧⌘W window close does NOT reliably deliver `pagehide` to a closing Electron host view, so that path's opener mark clears via the 6 s stale sweep instead of instantly — the documented sweep backstop covers it; the guest return move (R15) is main-side and does not depend on the message.
- **R17 manual matrix** — this box is headless Linux; rows not exercisable here are marked as such, with the coverage that stands in:

  | Row | Result |
  |-----|--------|
  | tty pop out / pop back in (header verb, dedupe, chrome-less, reflow) | PASS — desktop e2e `popout.spec.ts` |
  | web pop out / pop back in with live guest state (no reload, same webContents id) | PASS — desktop e2e `popout.spec.ts` |
  | code pop out | Not exercisable here (no code-server in the rig); no shell-specific code path — the popout boots its own extension host as in the browser |
  | gui pop out | Not exercisable here (no gui/Xvnc backend); unchanged browser semantics (second RFB client) |
  | ⌘N from a popout → ordinary window without `?pop=` | Not exercisable here; unit-covered decision (`stripPopParam` in `popout.test.ts`) wired into `openDuplicateWindow` |
  | quit + relaunch → popout not restored | Not exercisable here (needs a relaunched app); wired via `windowRecord → null` for popouts (both quit and close-one paths) |
  | host removal → the host's popouts close | Not exercisable here; wired in `destroyHostViews` (popouts pinned: `switchToHost` refuses them) |
  | pop back in via the opener palette `Tile: Pop Back In` | Not exercisable here (the desktop rig drives the popout's own verb); unit-covered: `pop-in` → sign-off → `closeShellWindow` |
- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- The SPA's `ShellTitlebarStrip` renders in `app.tsx` outside the top bar (`{isShell() && <ShellTitlebarStrip />}`), so popout posture keeps the 28 px drag surface — verified at plan time; no task needed.

## Deletion Candidates

None — this change adds new functionality without making existing code redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Size clamp bounds: min 320×200, max from the primary display work area | Sane popup bounds; mirrors SPA fallback 1200×800 | S:60 R:90 A:75 D:70 |
| 2 | Confident | Host-switch refusal for popouts returns an `IpcResult` error rather than silently switching | Keeps the IPC envelope contract; menu radio is a no-op on popouts | S:65 R:85 A:75 D:70 |
| 3 | Certain | Drag strip needs no work — it renders outside the top bar | Verified in `app.tsx` | S:90 R:95 A:95 D:95 |
| 4 | Confident | Popout failure toast reads "Pop-out failed" in the shell | The browser wording ("blocked by the browser") is wrong in the shell | S:60 R:95 A:75 D:70 |
| 5 | Confident | The spike runs as a throwaway script, not committed | Spike code is evidence, not product | S:70 R:95 A:80 D:80 |
| 6 | Confident | R14 move channel: popout-side adoption, no new channel — `web:create` arriving in a registered popout window (registry: openerWindowId + hostId match) moves the opener's guest (mounted or parked) by `(hostId, identity)` into the popout's parked scope and adopts it | The SPA identity string already rides `web:create`; `web:reparent`/`carry` would both need the identity plumbed into `popOut`, which cannot see the slot URL. Order tolerance: park-first → parked move; create-first → mounted move (the only two states a live tile's guest can be in) | S:70 R:80 A:75 D:70 |

5 assumptions (1 certain, 4 confident, 0 tentative).
