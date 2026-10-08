# Plan: Persistent code frames across window switches — an LRU of live code-server workbenches

**Change**: 260916-az44-persistent-code-frames-lru
**Intake**: `intake.md`

## Requirements

### Frontend: Surface Layout — code-frame retention

#### R1: The `code` tile survives a same-server window switch
The `code` tile's React key in `app/frontend/src/components/surface-layout.tsx` MUST NOT carry `windowId`; a code frame's identity is its workspace src (`code:${src}`), so a same-server window switch re-renders the mounted grid without unmounting the active window's `CodeSurface`. `web` and `gui` tiles SHALL keep their `${kind}${suffix}:${windowId}` keys unchanged.

- **GIVEN** window A has the code tile open with a resolved workspace src and its iframe is mounted
- **WHEN** the viewer switches to window B and back to A (same server)
- **THEN** A's `CodeSurface` instance and iframe element are the same nodes as before the switch (no `load` event fires again)
- **AND** the `web` and `gui` tiles still remount per window

#### R2: A bounded per-server LRU of live code frames
`SurfaceLayout` SHALL keep an ordered list of retained code-frame records `{ windowId, src, root }` (most-recently-shown last) as component state (per-server by construction — the grid is keyed by `server`). A record is created only when a window's src has resolved and its code tile is in `layout.order`. The list MUST be capped at `CODE_FRAME_CAP_DESKTOP = 3` / `CODE_FRAME_CAP_MOBILE = 1` (selected by the existing `isMobile` prop); the cap counts the active window's frame. On overflow the least-recently-shown record is evicted (the active window's frame is never the victim). Every non-active record renders as a display-hidden tile wrapper (`hidden` class, slot `-1`) through the same flat `allTiles` list on both the desktop and mobile branches — never `visibility: hidden` or off-screen.

- **GIVEN** desktop, windows A, B, C each shown with the code tile open (three live frames)
- **WHEN** window D is shown with the code tile open and its src resolves
- **THEN** A's frame (least recently shown) unmounts; B, C, D remain mounted; D is visible, B and C are `hidden`
- **GIVEN** `isMobile` is true and window A's frame is live
- **WHEN** window B's frame is created
- **THEN** A's frame unmounts (cap 1)
- **GIVEN** a retained frame's window is shown again
- **THEN** its record moves to most-recently-shown and its existing element becomes visible without a new `load`

#### R3: Eviction triggers beyond overflow
A record MUST be evicted when (a) its `windowId` leaves the server's live window set (killed/closed — threaded from `app.tsx` as a `liveWindowIds` set), (b) the live window's `codeRootFor(win)` differs from the record's `root` and the divergence is not the follow rule's own update, or (c) `codeReachable` flips `true→false` (every record dropped). A cap decrease at runtime (an `isMobile` flip) evicts down to the new cap immediately. Closing the code tile in a window keeps its frame retained and counted. A follow (`codeFollowSrc` nonce for the active window) updates the active record's `src`/`root` in place and never evicts.

- **GIVEN** windows A (retained, hidden) and B (active) have live frames
- **WHEN** A leaves `liveWindowIds`
- **THEN** A's frame unmounts with no errors and B is untouched
- **GIVEN** a retained frame for window A rooted at `/x`
- **WHEN** A's payload `codeRoot` becomes `/y` without a follow
- **THEN** A's record is evicted; the next show of A mounts a fresh frame at A's current src
- **GIVEN** three live frames
- **WHEN** `codeReachable` becomes false
- **THEN** all records are dropped; on `true` again the active window mounts at its current src from an empty LRU

### Frontend: Workspace derivation — per-window map

#### R4: `useCodeWorkspace` resolves srcs per window and exposes them
`app/frontend/src/hooks/use-code-workspace.ts` MUST hold resolved entries in a map keyed by today's key shapes (`${server}:${windowId}:${root}` and `${server}:${windowId}:seed-rejected:${folder}`), survive window switches for the hook's lifetime, fetch only when the ACTIVE window's key is absent, and expose a per-window lookup (`codeSrcFor(windowId)` or an equivalent `ReadonlyMap` by window id) alongside today's `codeSrc`. The 409 pending, non-409 `?folder=` degrade (one warning per key), and seed-rejected semantics MUST be unchanged; `followFolder` updates that window's entry and keeps the active-window `followSrc` nonce. Entries for windows outside `liveWindowIds` are pruned.

- **GIVEN** window A's src resolved, then a switch to B
- **WHEN** the viewer switches back to A
- **THEN** `codeSrc` is A's src synchronously (no pending render, no second fetch for A)
- **AND** while A is active, the lookup still returns B's src

### Frontend: `app.tsx` threading

#### R5: The parent threads per-window inputs, keeps the grid keyed by server
`app/frontend/src/app.tsx` MUST keep `key={server}` on `SurfaceLayout`, pass the per-window src lookup, pass `liveWindowIds` for the current server (derived from the session context it already holds), and keep `codeFollowSrc` active-window-only. `fetchBridgeStatus` MUST be supplied per frame (a factory `fetchBridgeStatusFor(windowId)` or equivalent) so a retained frame's rescue verdict, which may fire after a switch, reads its OWN window's bridge status.

- **GIVEN** window A's frame was created 3 s ago and the viewer switches to B
- **WHEN** A's first-boot rescue verdict fires at the 10 s mark
- **THEN** the status GET targets window A, not B

### Frontend: Per-frame seams and `CodeSurface` invariants

#### R6: Retained frames keep their own seams; show/hide re-arms nothing
Each retained `CodeSurface` MUST receive props bound to ITS window (`gitRoot` = record root, `workspaceSrc` = record src, `onInteract`/`onFolderNavigated` bound to that window's id, `onProgrammaticFocus`, `fetchBridgeStatus` per R5, `reachable`, `shouldReclaimChord("code")`). `app/frontend/src/components/code-surface.tsx` is expected unchanged: its `[reachable, src]` effects (chord reclaim, steal-guard detector, first-boot rescue) MUST NOT re-run on a display show/hide, and a retained frame fires no load-time focus grab on a switch back.

- **GIVEN** a retained code frame
- **WHEN** its window becomes active again
- **THEN** no new `load`, no new rescue baseline read, no focus grab; the tty tile keeps focus per focus memory

### Tests and docs

#### R7: Unit and e2e coverage
Vitest coverage in `surface-layout.test.tsx` and `use-code-workspace.test.tsx` SHALL prove R1–R6's scenarios; `app/frontend/tests/e2e/code-surface.spec.ts` SHALL gain two `test()`s (round-trip yields exactly one iframe `load` and the same element; a retained frame does not re-fire the focus-grab stub and the tty keeps focus), each with the constitution's **Proves:**/**Steps:** JSDoc, the file header extended for any new shared setup. Gates: `just test-frontend`, `npx tsc --noEmit` in `app/frontend`, `just test-e2e code-surface.spec`, `just test-e2e focus-restore.spec`.

#### R8: Spec P3 records the LRU decision
`docs/specs/right-panel.md` § P3 MUST replace the deferred-LRU sentence with the recorded decision (cross-window `code` retention, cap 3/1, keyed by workspace src, the eviction triggers, the measured justification). Memory files are hydrate's (intake § Affected Memory).

### Non-Goals

- The `web` tile's identical per-window remount — separate decision.
- Pre-warming the next likely window's frame — doubles extension hosts.
- code-server spawn flags, `/code` proxy, extension activation — measured as not the lever.
- Any backend, API, tmux-option, settings-registry, or localStorage change.
- A palette verb to evict/reload frames — none needed; if one is ever added it registers in the palette (Constitution V).

### Design Decisions

#### Code frames are retained across window switches by an LRU inside `SurfaceLayout`
**Decision**: the `code` tile drops `windowId` from its React key (identity = workspace src), and `SurfaceLayout` holds a per-server list of `{windowId, src, root}` frame records, rendering non-active ones display-hidden and evicting on overflow (cap 3 desktop / 1 mobile), window kill, non-follow root change, or reachability loss.
**Why**: a window switch unmounted the iframe, which is a page unload — VS Code web disconnects gracefully and code-server kills the extension host — so every switch re-booted the workbench (1.4 s chrome / ~2 s files / ~2.9 s git warm; 7 s extension host under load) while a display-hidden frame re-shows in 16 ms. Each live workbench is a ~250–320 MB extension host, so retention must be bounded. Mount bookkeeping already lives in the renderer (zoom, `everOpened`), and the grid is keyed by server, so the list is per-server for free.
**Rejected**: reconnecting a new document to the old connection (the unload disconnect is unconditional; the token lives in the dying renderer); one shared frame navigating between workspaces (a workspace switch is a full workbench reload); unbounded retention; cache/proxy tuning (warm network is 3 KB).
*Introduced by*: 260916-az44-persistent-code-frames-lru

#### The rescue/bridge fetcher is bound per frame
**Decision**: `fetchBridgeStatus` reaches each `CodeSurface` as a fetcher bound to that frame's window id, not the active window's.
**Why**: `CodeSurface` reads `fetchBridgeRef.current` at verdict time (10 s and 20 s after load); with retention a frame can outlive its window's active period, so an active-window fetcher would read the wrong tab's bridge status.
**Rejected**: keeping the single active-window fetcher (silent wrong-window verdicts).
*Introduced by*: 260916-az44-persistent-code-frames-lru

## Tasks

### Phase 1: Setup

- [x] T001 Convert `app/frontend/src/hooks/use-code-workspace.ts` from a single resolved entry to a `Map<string, string>` (state, or ref + version) keyed by today's key shapes; fetch only when the active window's key is absent; add a per-window lookup (`codeSrcFor(windowId)` or a `ReadonlyMap` by window id) to the return shape; `followFolder` updates that window's entry; accept a live-window signal (or a prune callback) to drop entries for dead windows; keep 409/degrade/seed-rejected semantics <!-- R4 -->
- [x] T002 [P] Extend `app/frontend/src/hooks/use-code-workspace.test.tsx`: A→B→A yields one fetch for A and a synchronous src on revisit; the lookup returns B's src while A is active; `followFolder` updates only its window's entry; pruning drops a dead window's entry; existing tests stay green <!-- R4 -->

### Phase 2: Core Implementation

- [x] T003 In `app/frontend/src/components/surface-layout.tsx` add the frame-record state (`{windowId, src, root}[]`, most-recently-shown last), the `CODE_FRAME_CAP_DESKTOP`/`CODE_FRAME_CAP_MOBILE` constants, the record create/bump on active-window show, the overflow eviction, and change the `code` tile key to `code:${src}` (tty unchanged; web/gui keep `:${windowId}`); render every non-active record as a `hidden` tile wrapper (slot `-1`) in the flat `allTiles` list on both the desktop and mobile branches; update the key comment block <!-- R1 R2 --> <!-- rework: should-fix — frame React key must include the record windowId (folder-degrade srcs collide across same-folder windows) -->
- [x] T004 In `surface-layout.tsx` add the eviction reconciliation: `liveWindowIds` prop (drop records whose window is gone), non-follow root divergence (compare the live window's `codeRootFor(win)` with the record's `root`; a `codeFollowSrc` nonce adoption updates the active record in place), `codeReachable` `true→false` drops all, and an `isMobile` cap decrease evicts down immediately; the `[server, windowId]` reset effect leaves the record list intact apart from the bump <!-- R3 --> <!-- rework: must-fix — the follow path races the root-divergence eviction; the eviction baseline must move synchronously with the navigation report -->
- [x] T005 In `surface-layout.tsx` `renderContent`'s `case "code"`, render the record's `CodeSurface` with props bound to the record's window: `gitRoot`=record root, `workspaceSrc`=record src, `followSrc` only for the active window, `onInteract`/`onFolderNavigated` bound to the record's `windowId` (focus-memory key per window), `fetchBridgeStatus` from the per-window factory, `reachable`, `shouldReclaimChord("code")`, `onProgrammaticFocus`; the visible tile's header meta still reads the active window <!-- R6 -->
- [x] T006 In `app/frontend/src/app.tsx` keep `key={server}`; pass the per-window src lookup, a `liveWindowIds` set for the current server derived from the session context, and a `fetchBridgeStatusFor(windowId)` factory (`() => fetchCodeBridge(server, windowId)`); keep `codeFollowSrc` active-window-only; update the render-site comment that says non-tty tiles remount per window <!-- R5 --> <!-- rework: must-fix follow race (pending-follow target recorded before the POST) + should-fix stale fetcher-stability comment -->

### Phase 3: Integration & Edge Cases

- [x] T007 Extend `app/frontend/src/components/surface-layout.test.tsx`: A→B→A keeps the code iframe element (update "keeps the tty tile's DOM node across the switch; a non-tty tile's node remounts" so `code` survives and `web` remounts); a fourth window evicts the least-recently-shown at cap 3; `isMobile` cap 1 evicts the previous frame; non-follow root change evicts, a follow nonce does not; `codeReachable` false drops all frames; a window leaving `liveWindowIds` drops its frame without errors; a closed code tile stays retained and counted; a retained frame's `onInteract` records against its own window key; existing reset tests stay green <!-- R1 R2 R3 R6 --> <!-- rework: the follow unit test encodes a nonce-first ordering production never establishes; test the real ordering (payload root tick before nonce) -->
- [x] T008 Add two `test()`s to `app/frontend/tests/e2e/code-surface.spec.ts` with **Proves:**/**Steps:** JSDoc (extend the file header for shared setup): (1) open the code tile in window A, switch to B and back — exactly one iframe `load` for A (the `addInitScript` load-counter technique) and the same element; (2) with `focusGrabCodeStubHtml`, focus the tty in A, switch to B and back — no second grab, the tty keeps focus, the steal guard is not re-triggered <!-- R7 -->
- [x] T009 Run the gates: `cd app/frontend && npx tsc --noEmit`, `just test-frontend`, `just test-e2e code-surface.spec`, `just test-e2e focus-restore.spec`; fix failures at the root <!-- R7 -->

### Phase 4: Polish

- [x] T010 [P] Update `docs/specs/right-panel.md` § P3 — Hide, never unmount: replace the deferred-LRU sentence with the recorded decision (cross-window `code` retention, cap 3 desktop / 1 mobile, keyed by workspace src, eviction on overflow / window kill / non-follow root change / reachability loss, the measured justification: 1.4–2.9 s warm boot, ~250–320 MB per extension host, 16 ms re-show) <!-- R8 -->
- [x] T011 [P] Verify `app/frontend/src/components/code-surface.tsx` needs no change (the `[reachable, src]` effects do not re-run on show/hide); if a comment there or in `surface-layout.tsx`'s hide-never-unmount header still says a window switch remounts the code tile, correct it <!-- R6 -->

## Execution Order

- T001 blocks T006 (the lookup shape) and T003 (records need resolved srcs)
- T003 blocks T004 and T005; T006 depends on T003–T005's prop names
- T007 and T008 follow T006; T009 runs last in Phase 3

## Acceptance

### Functional Completeness

- [x] A-001 R1: the `code` tile key is `code:${src}`; `web`/`gui` keys still carry `windowId`; a same-server switch does not unmount the active window's `CodeSurface`
- [x] A-002 R2: frame records `{windowId, src, root}` exist as `SurfaceLayout` state with named cap constants 3/1 selected by `isMobile`; overflow evicts the least-recently-shown, never the active frame
- [x] A-003 R3: eviction fires on window gone, non-follow root divergence, and `codeReachable` `true→false`; a cap decrease evicts down immediately; closing the tile keeps the frame; a follow updates in place — the follow's navigation report records a pending target synchronously before the latch POST, so both tick orderings (payload-first via the eviction effect's pending arm, nonce-first via the nonce-adoption effect) move the baseline in place; a failed latch POST leaves the payload unmoved and nothing evicts
- [x] A-004 R4: `useCodeWorkspace` holds a map, fetches only for an unresolved active window, exposes a per-window lookup, prunes dead windows, and preserves 409/degrade/seed-rejected behavior
- [x] A-005 R5: `app.tsx` passes the lookup, `liveWindowIds`, and a per-window `fetchBridgeStatus` factory; `key={server}` and active-only `codeFollowSrc` unchanged
- [x] A-006 R6: each retained `CodeSurface` receives props bound to its own window; `code-surface.tsx` unchanged (or comment-only)
- [x] A-007 R8: `docs/specs/right-panel.md` § P3 carries the LRU decision and no longer says the decision is deferred

### Behavioral Correctness

- [x] A-008 R1: switching A→B→A produces no second iframe `load` for A's frame (unit: same element identity; e2e: load counter = 1)
- [x] A-009 R4: revisiting a resolved window renders its src synchronously — no `code-surface-pending` render and no refetch
- [x] A-010 R2: non-active records render `hidden` at display level on BOTH the desktop and mobile branches; none use `visibility`/off-screen positioning
- [x] A-011 R5: a retained frame's rescue verdict fetches its own window's bridge status (unit test with a spy factory, or an assertion that the fetcher is created per record)

### Scenario Coverage

- [x] A-012 R2: unit test — fourth distinct window at cap 3 evicts the least-recently-shown frame; the other two persist
- [x] A-013 R2: unit test — `isMobile` cap 1 evicts the previous frame when a new one is created
- [x] A-014 R3: unit tests — root change (non-follow) evicts and re-mounts fresh on show; follow nonce does not evict; reachability false drops all; a window id leaving `liveWindowIds` drops its frame
- [x] A-015 R6/R7: e2e — the focus-grab stub fires no second grab on a switch back; the tty keeps focus; `focus-restore.spec` still passes
- [x] A-016 R7: both new e2e tests carry **Proves:**/**Steps:** JSDoc; the file header covers any new shared setup

### Edge Cases & Error Handling

- [x] A-017 R3: killing a window whose frame is hidden evicts cleanly — no console errors, no stale record, its map entry pruned
- [x] A-018 R6: a hidden frame's `onInteract`/`onProgrammaticFocus` cannot record focus under another window's key (bound per record, or omitted for non-active frames)
- [x] A-019 R2: a window whose src is still pending creates no record and does not count toward the cap

### Code Quality

- [x] A-020 Pattern consistency: new state follows the `everOpened`/zoom patterns in `surface-layout.tsx`; prop-in/callback-out preserved (no router/storage imports added to the renderer)
- [x] A-021 No unnecessary duplication: `codeRootFor`, `isMobileViewport`/`isMobile`, and the existing hidden-tile rendering path are reused rather than re-implemented
- [x] A-022 Type narrowing over assertions: no new `as` casts in the touched files
- [x] A-023 Named constants: the caps are named constants, no magic numbers
- [x] A-024 No polling: no `setInterval`/fetch loops introduced; eviction is derived from props (payload-driven)
- [x] A-025 Comment discipline: comments state constraints (why the key drops `windowId`, why the fetcher is per frame), no change-id narration or reviewer-addressed prose
- [x] A-026 Tests cover the added behavior (`just test-frontend` green, the two e2e tests green)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `useCodeWorkspace`'s `codeSrc` return field (`app/frontend/src/hooks/use-code-workspace.ts:69`, `:203`) — superseded by `codeSrcFor(windowId)`: app.tsx no longer destructures it (SurfaceLayout derives the active window's src through the lookup), so only the hook's own tests still read it; they would migrate to `codeSrcFor(windowId)`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `fetchBridgeStatus` becomes a per-window factory rather than the active-window closure | Discovered during planning: `CodeSurface` reads the fetcher ref at verdict time, which can be after a switch; the intake did not cover it | S:60 R:85 A:85 D:80 |
| 2 | Confident | The spec P3 edit is an apply task (T010), not left to hydrate | Hydrate's targets are `docs/memory/`; specs are human-curated but the intake names this edit explicitly as part of the change | S:65 R:90 A:85 D:80 |
| 3 | Confident | `liveWindowIds` is derived in `app.tsx` from the session context's windows for the current server and passed as a `ReadonlySet<string>` | The intake left the shape open; a set is the cheapest membership test and keeps the renderer payload-agnostic | S:60 R:90 A:85 D:75 |
| 4 | Certain | The FULL lane (11 tasks) | Task count > 5 | S:95 R:95 A:95 D:95 |
| 5 | Confident | A frame record's `src` is fixed at creation as the frame's identity/React key; a follow moves only the record's `root` (the eviction baseline) in place — the record's `src` is never re-read after mount | The intake both keys the frame by `code:${src}` and says a follow moves (src, root) in place; keying on the CREATION src is the only reading that doesn't remount the live frame on a follow, and the mount-generation rule already pins the iframe's src | S:65 R:85 A:80 D:75 |
| 6 | Confident | Retained (non-active) frames get NO `onInteract`/`onProgrammaticFocus`/`onFolderNavigated` bindings (the intake's "or omitted" arm) instead of per-window-id bindings | A display-hidden frame cannot receive focus or navigate, so the seams can never fire; omitting them removes the stale-closure class entirely rather than re-keying it | S:70 R:90 A:80 D:70 |
| 7 | Confident | The follow's eviction-baseline move rides a pending-follow target recorded synchronously at the frame's navigation report (before the latch POST); a root divergence TOWARD that target is the follow — both tick orderings (payload-first, nonce-first) are safe, and a failed latch POST leaves the payload unmoved so nothing evicts | Review found the nonce-only update loses the real event ordering: the follow's own `@rk_win_code_root` write wakes the SSE hub before the POST response + re-derivation GET produce the nonce, so the divergence check read the follow as an external change and evicted the live frame | S:75 R:85 A:85 D:80 |

7 assumptions (1 certain, 6 confident, 0 tentative).
