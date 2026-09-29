# Plan: Fix Web Popout Shrinking the Opener's Terminal

**Change**: 260929-r2mn-web-popout-shrinks-opener-terminal
**Intake**: `intake.md`

## Requirements

### Session Context: First-Payload Signal

#### R1: Per-server `sessionsReceived` flag
The per-server `ServerSlice` in `app/frontend/src/contexts/session-context.tsx` SHALL carry a `sessionsReceived: boolean` that is `false` in the seeded `EMPTY_SLICE` and becomes `true` when the subscription delivers a real sessions snapshot — a `sessions` event, or a subscription ack whose snapshot is an array. An ack with a `null` snapshot MUST NOT set it. Re-seeding the slice (subscribe after gone/unsubscribe) MUST reset it to `false`; a socket drop/reconnect MUST NOT clear it.

- **GIVEN** a server was just attached and its slice seeded with `EMPTY_SLICE`
- **WHEN** no sessions snapshot has arrived yet
- **THEN** `sessionsReceivedByServer.get(server)` is `false` while `sessionsByServer.has(server)` is already `true`
- **AND WHEN** the first `sessions` event arrives, it becomes `true`

- **GIVEN** a subscription ack arrives with a `null` snapshot
- **WHEN** the slice is updated from the ack
- **THEN** `sessionsReceived` stays `false`

#### R2: The flag is exposed on the session context
`SessionContextType` SHALL expose `sessionsReceivedByServer: Map<string, boolean>`, derived from the slices like `isConnectedByServer`. `StandaloneSessionContextProvider` SHALL default it to `true` for every key present in the supplied `sessionsByServer` when the caller does not pass it, so existing test fixtures keep their "payload arrived" semantics.

- **GIVEN** a test renders `StandaloneSessionContextProvider` with `sessionsByServer` containing `"runkit"` and no `sessionsReceivedByServer`
- **WHEN** a consumer reads `sessionsReceivedByServer.get("runkit")`
- **THEN** it reads `true`

### Surface Popout: Posture Signal

#### R3: Popout posture waits for the first real payload
`app/frontend/src/app.tsx`'s `payloadArrived` SHALL read `ctx.sessionsReceivedByServer.get(server) === true` instead of `ctx.sessionsByServer.has(server)`, and `popWindowLive` SHALL judge the popped window against the RAW sessions snapshot (`rawSessions`) rather than the merged `windowsById`: the merged view's windows come from the window store, which an effect fills one render after the snapshot lands, so it reads the window as absent for one render. The rest of the posture rule (`popWindowSeen`, `popoutPosture`, `popoutEnded`) is unchanged.

- **GIVEN** a `?pop=web` popout window whose server slice is seeded but has received no snapshot
- **WHEN** the terminal route renders
- **THEN** the popout posture holds (the single web leaf renders; no tty tile mounts)

- **GIVEN** the first snapshot has arrived and contains the popped window, but the window store has not synced yet (merged `windowsById` still empty)
- **WHEN** the terminal route renders
- **THEN** the popout posture holds

- **GIVEN** the first snapshot has arrived and the popped window is absent from it
- **WHEN** the terminal route renders
- **THEN** the popout degrades to the ordinary terminal render (the existing drop-don't-error posture)

#### R4: A web popout attaches no terminal client
A web popout in the desktop shell SHALL NOT mount a `surface-tile-tty` and SHALL NOT attach any `_rk-iso-*` tmux client, so the opener's terminal keeps its size.

- **GIVEN** a window with layout `h(tty,web)` open in the desktop shell
- **WHEN** the user pops the web tile out and the guest has moved to the popout
- **THEN** the popout page has zero `surface-tile-tty` elements (count, not visibility)
- **AND** `tmux list-clients` on the rig server lists no client whose session starts with `_rk-iso-`

### Non-Goals

- Changing `window-size smallest` in `configs/tmux/default.conf` — a deliberate correctness guard; two viewers of one tmux window share one size, so a tty popout smaller than the opener still shrinks it by design.
- A "never-visible tty tile opens no relay stream" guard in `surface-layout.tsx` — possible separate follow-up; it treats the symptom downstream of the wrong posture signal.

### Design Decisions

#### Explicit first-payload flag on the server slice
**Decision**: Track "a real sessions snapshot arrived" as `sessionsReceived` on the per-server slice, set by the `sessions` event and array ack snapshots, exposed as `sessionsReceivedByServer`.
**Why**: The subscribe path seeds an empty slice before any payload, so slice existence is not evidence of a payload; the signal belongs at its source rather than a render-path patch.
**Rejected**: Inferring arrival from `isConnected` (also toggled by socket connectivity, not snapshot receipt); guarding the tty mount in `SurfaceLayout` (symptom-level, leaves the popout flashing the shared layout).
*Introduced by*: 260929-r2mn-web-popout-shrinks-opener-terminal

## Tasks

### Phase 2: Core Implementation

- [x] T001 Add `sessionsReceived` to `ServerSlice` / `EMPTY_SLICE` in `app/frontend/src/contexts/session-context.tsx`; set it `true` in the `"sessions"` event `updateSlice` and in the `onAck` `updateSlice` only when `Array.isArray(snapshot)`; add `sessionsReceivedByServer: Map<string, boolean>` to `SessionContextType` (doc comment), derive it with a `useMemo` over `slicesByServer`, add it to the context `value` + deps; default it in `StandaloneSessionContextProvider` to `true` for every key of the supplied `sessionsByServer` <!-- R1 -->
- [x] T002 In `app/frontend/src/app.tsx` (~L1076) make `payloadArrived` read `ctx.sessionsReceivedByServer.get(server) === true`, judge `popWindowLive` against a raw-snapshot window-id set derived from `rawSessions` (not the effect-lagged merged `windowsById`), and update the adjacent posture comment for both <!-- R3 --> <!-- rework: e2e showed a second one-render transient — merged windows lag the snapshot via the window-store sync effect -->

### Phase 3: Integration & Edge Cases

- [x] T003 [P] Vitest in `app/frontend/src/contexts/session-context.test.tsx`: `sessionsReceivedByServer` is `false` after subscribe (while `sessionsByServer.has` is true), `true` after the first `sessions` emit; cover the ack array vs `null` snapshot distinction and the reset to `false` after gone + re-subscribe if the WS mock supports them; plus a `StandaloneSessionContextProvider` default check <!-- R2 -->
- [x] T004 [P] Vitest posture coverage in `app/frontend/src/app.test.tsx` (terminal route `?pop=web`, standalone provider with an empty sessions entry): `sessionsReceivedByServer` false ⇒ posture holds, no `surface-tile-tty`; received with the window absent ⇒ ordinary render. If mounting the popout route there proves impractical, record the fallback in `## Assumptions` and rely on T003 + T005 <!-- R3 -->
- [x] T005 Add a `listClients(opts?)` helper to `app/frontend/tests/e2e/_tmux.ts` (argument-slice `execFileSync`, same pattern as the file's other helpers) returning client session + size rows; extend the web-popout test in `app/desktop/tests/e2e/popout.spec.ts` to assert `popPage.getByTestId("surface-tile-tty")` has count 0 and no listed client session starts with `_rk-iso-` once the guest has moved; update that test's JSDoc **Proves:** / **Steps:** <!-- R4 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `ServerSlice.sessionsReceived` exists, is `false` in `EMPTY_SLICE`, and is set `true` by the `sessions` event and by an array ack snapshot only
- [x] A-002 R2: `SessionContextType.sessionsReceivedByServer` is exposed from the provider value and defaulted by `StandaloneSessionContextProvider` to `true` per supplied `sessionsByServer` key
- [x] A-003 R3: `payloadArrived` in `app.tsx` reads `sessionsReceivedByServer` and `popWindowLive` reads the raw snapshot; no remaining use of `sessionsByServer.has(...)` as a payload signal
- [x] A-004 R4: The desktop web-popout e2e asserts zero `surface-tile-tty` in the popout and no `_rk-iso-*` client, and passes

### Behavioral Correctness

- [x] A-005 R3: With a seeded-but-unsnapshotted slice the popout stays in posture; after a snapshot without the window it degrades to the ordinary render

### Scenario Coverage

- [x] A-006 R1: A Vitest covers seeded (`false`) → first `sessions` emit (`true`)
- [x] A-007 R4: The e2e assertion fails on the pre-fix build shape (count-based tty check, not `toBeHidden()`)

### Edge Cases & Error Handling

- [x] A-008 R1: A `null` ack snapshot leaves the flag `false`; a socket reconnect does not clear it; re-subscribe after gone re-seeds `false`

### Code Quality

- [x] A-009 Pattern consistency: The derived Map, context field, and standalone default mirror the existing `isConnectedByServer` shape
- [x] A-010 No unnecessary duplication: The e2e reuses the shared `_tmux.ts` fixture (new helper there) rather than inline tmux calls in the spec
- [x] A-011 Type narrowing over assertions: no new `as` casts beyond the existing ack snapshot handling
- [x] A-012 Test coverage: the fix ships with unit + e2e coverage of the changed behavior
- [x] A-013 Comment discipline: new comments state constraints (why the seeded slice is not a payload), with no change IDs or PR numbers
- [x] A-014 Test intent comments: the extended Playwright test's JSDoc **Proves:** / **Steps:** block matches its body

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds a new slice flag and swaps the popout posture's signal source without making any existing symbol redundant (`sessionsByServer` retains its other consumers; the removed `sessionsByServer.has(server)` was an inline expression, not a symbol)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The flag alone does NOT close the transient: `useMergedSessions` builds windows from the window store, which `AppShell`'s SSE-sync effect fills one render after `rawSessions` changes, so `popWindowLive` must read the raw snapshot | Revised during apply: the desktop e2e still failed with the flag alone; an instrumented trace showed `arrived:true, wins:""` for one render while the event and ack both carried 3 windows | S:95 R:85 A:95 D:90 |
| 2 | Confident | No opener window-width assertion in the e2e (the intake's open question): the zero-tty-tile + no-iso-client checks target the mechanism directly and avoid a size-timing race | The iso client is the only possible clamping viewer in the test; a width check adds flake surface for no extra discrimination | S:60 R:90 A:75 D:65 |

| 3 | Confident | Only the popout's liveness judgment moves to the raw snapshot; the merged-view lag itself (window store filled by an effect) is left as is | The merged view is the optimistic display overlay and its effect-driven sync is shared by the sidebar/rename paths; the popout's known-absent decision is an existence question the authoritative snapshot answers directly | S:70 R:80 A:80 D:70 |

3 assumptions (1 certain, 2 confident, 0 tentative).
