# Plan: Quake terminal compose draft is per tmux server

**Change**: 260913-3sx8-quake-compose-draft-per-server
**Intake**: `intake.md`

## Requirements

### run-kit/ui: Quake compose seam — draft keyed by operator target

#### R1: Draft text lives in the compose-draft store, keyed by the operator window target
The quake compose seam in `app/frontend/src/lib/quake-terminal.ts` MUST NOT hold a module-global draft text. The draft text for a resolved `(server, target)` pair MUST be read from and written to `lib/compose-draft-store.ts` under the key `entryKey(server, target.window.windowId)`, exposed by an exported `operatorComposeKey(server, target)` helper that returns `null` when either `server` or `target` is absent.

- **GIVEN** a draft "for A" typed while the resolved server is `srvA` with operator window `@9`
- **WHEN** the resolved server becomes `srvB` (route navigation, picker, pin)
- **THEN** `useOperatorCompose("srvB", targetB).text` is `""`
- **AND** returning to `("srvA", targetA)` reads `"for A"` again

#### R2: In-flight flags and the inline error are per server
`sending`, `uploading`, and `error` MUST remain module state in `lib/quake-terminal.ts` but MUST be keyed by server name in a map. `useOperatorCompose(server, target)` MUST return that server's flags merged with the target's draft text, as a reference-stable object while neither input changed. An edit via `setOperatorComposeText(server, target, text)` MUST clear only that server's `error`. `flagsFor(null)` MUST return the shared initial flags object.

- **GIVEN** a send on `srvA` that rejected with "probe failed"
- **WHEN** `useOperatorCompose("srvB", targetB)` renders
- **THEN** its `error` is `null` while `useOperatorCompose("srvA", targetA).error` is `"probe failed"`
- **AND** `setOperatorComposeText("srvA", targetA, "edited")` clears A's error

#### R3: Send success clears only the sent target's draft; the guard is per server
`sendOperatorMessage(server, target, value)` MUST keep its signature. Its in-flight guard MUST read `flagsFor(server).sending`. On success it MUST call `clearComposeDraft(operatorComposeKey(server, target))` and reset that server's `error`/`sending`; on failure it MUST set that server's `error` and leave the draft untouched. `attachOperatorFiles` MUST route its `uploading`/`error` patches to that server's flags. The chat-subject fork MUST be unchanged.

- **GIVEN** drafts on `srvA` and `srvB`, and a send in flight on `srvA`
- **WHEN** `sendOperatorMessage("srvB", targetB, "two")` is called
- **THEN** it is not blocked by A's in-flight send
- **AND** when A's send resolves, only A's draft is cleared and B's survives

#### R4: Both consumers pass their resolved server + target; no-operator posture is read-only
`QuakeCompose` (`components/quake-terminal.tsx`) and `QuakeLauncher` (`components/quake-launcher.tsx`) MUST call `useOperatorCompose(server, target)` and `setOperatorComposeText(server, target, value)` with their own resolved pair. When `target` is `undefined`, the drawer textarea and the launcher input MUST render `readOnly` (never `disabled` — the launcher's `onFocus` drives `rest → open`) with the placeholder `Start the operator to compose…`; edits are no-ops (key `null`).

- **GIVEN** the drawer open on a server whose sessions carry no `role: "operator"` window
- **WHEN** the docked textarea renders
- **THEN** it is focusable, `readOnly`, and shows the Start-operator placeholder
- **AND** the launcher's standing input on that server is likewise `readOnly` yet still opens the drawer on focus

#### R5: Cross-server isolation is proven at the component and e2e layers
Component tests MUST render with server A, type a draft, re-render under server B, and assert the textarea/input is empty. The e2e spec `tests/e2e/quake-terminal.spec.ts` MUST carry one `test()` (Proves/Steps JSDoc) that mocks two servers with operator windows via `mockStateSocket`'s `sessionsByServer`, types into the docked compose on server A's route, navigates to server B's route and asserts the compose is empty, then returns to A and asserts the text is back.

- **GIVEN** `/api/servers` returns `default` and `other`, each with an operator window `@9`
- **WHEN** the user types "for default" in the drawer on `/default/@1`, then loads `/other/@1` and opens the drawer
- **THEN** the docked compose is empty on `other`
- **AND** loading `/default/@1` again and opening the drawer shows "for default"

### Non-Goals
- The mobile arm, the route compose strip, `?from=` chip, and `setComposeText` seeds — already keyed by target
- The chat-subject store — already server-checked at send time
- Pushing quake sends into `pushComposeSentHistory` — a feature, not this fix
- A server-only synthetic draft key for the no-operator case — bends the store's `server:windowId` grammar

### Design Decisions

#### Quake draft rides the compose-draft store, not a private per-server map
**Decision**: The quake compose text is a `compose-draft-store` entry keyed `entryKey(server, operatorWindowId)`; flags stay in the quake module keyed by server.
**Why**: The store's principle is "drafts are keyed by their SEND TARGET" and the operator window is the quake send target; the mobile arm already writes this key. One draft discipline, refresh persistence and pruning for free, Constitution IV satisfied.
**Rejected**: A `Map<server, text>` inside `lib/quake-terminal.ts` — smaller diff but a second draft store with its own persistence posture to keep aligned.
*Introduced by*: 260913-3sx8-quake-compose-draft-per-server

#### Flags are keyed by server, not by target key
**Decision**: `sending`/`uploading`/`error` live in a `Map<server, QuakeComposeFlags>`.
**Why**: One operator per server (server-scoped radio); flags describe a send against that server's operator, and a server key keeps the no-target case representable (an upload error surfaces even if the target vanished mid-flight).
**Rejected**: Keying flags by the draft key — loses representability when `target` is undefined; storing them in the draft store — they are not drafts and must never persist.
*Introduced by*: 260913-3sx8-quake-compose-draft-per-server

## Tasks

### Phase 2: Core Implementation

- [x] T001 Rewrite the shared compose seam in `app/frontend/src/lib/quake-terminal.ts`: add `operatorComposeKey`, replace `composeState` with a per-server `composeFlags` map (`flagsFor`, `patchFlags`, module listener set), new `setOperatorComposeText(server, target, text)` and `useOperatorCompose(server, target)` (draft text via `useSyncExternalStore` over `compose-draft-store`, flags via the listener set, memoized merge), re-key `sendOperatorMessage`/`attachOperatorFiles`, export a test-only `resetOperatorComposeFlags()`; update the module header comment; add the second-subscriber note to the `lib/compose-draft-store.ts` header comment <!-- R1, R2, R3 -->
- [x] T002 Update both consumers: `QuakeCompose` in `app/frontend/src/components/quake-terminal.tsx` and the standing input in `app/frontend/src/components/quake-launcher.tsx` call the new signatures with their resolved `(server, target)`, and render `readOnly` + `Start the operator to compose…` placeholder when `target` is undefined <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T003 Update `app/frontend/src/lib/quake-terminal.test.ts` "shared compose seam": new signatures in `beforeEach` and existing cases, store reset via `localStorage.clear()` + `hydrateComposeDrafts()` + `resetOperatorComposeFlags()`, and add the regression cases (A text / B empty / back to A; A error invisible on B; A success leaves B's draft; per-server in-flight guard; no-target no-op) <!-- R1, R2, R3 -->
- [x] T004 Update `app/frontend/src/components/quake-terminal.test.tsx` and `app/frontend/src/components/quake-launcher.test.tsx`: signature updates in every `beforeEach` and the "half-written" cases, plus one cross-server case per file (type under server A, re-render under server B, input empty) and one read-only no-operator case for the drawer textarea and the launcher input <!-- R4, R5 -->
- [x] T005 Add one two-server `test()` with Proves/Steps JSDoc to `app/frontend/tests/e2e/quake-terminal.spec.ts` using `mockStateSocket`'s `sessionsByServer` and a two-entry `/api/servers` stub; run `just test-e2e quake-terminal.spec` <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `operatorComposeKey` is exported, returns `entryKey(server, windowId)` for a resolved pair and `null` otherwise; no module-global draft text remains in `lib/quake-terminal.ts`
- [x] A-002 R2: `useOperatorCompose(server, target)` returns `{ text, sending, uploading, error }` with flags read from a per-server map
- [x] A-003 R3: `sendOperatorMessage` success path calls `clearComposeDraft` for the sent key only; failure leaves the draft
- [x] A-004 R4: Both consumers pass `(server, target)`; no zero-arg `useOperatorCompose()` or one-arg `setOperatorComposeText(text)` call site remains in `src/`
- [x] A-005 R5: The e2e spec carries the two-server test with a Proves/Steps JSDoc block

### Behavioral Correctness

- [x] A-006 R1: A draft typed under server A does not render under server B and reappears on return to A (unit + component + e2e)
- [x] A-007 R2: A send error on server A is not visible under server B; an edit on A clears A's error
- [x] A-008 R3: A send on B is not blocked by an in-flight send on A; A's success does not clear B's draft
- [x] A-009 R4: With no operator on the resolved server, the drawer textarea and launcher input are `readOnly`, focusable, carry the Start-operator placeholder, and typing is a no-op; the launcher's focus still opens the drawer

### Scenario Coverage

- [x] A-010 R1: `lib/quake-terminal.test.ts` covers A-text/B-empty/back-to-A on the seam
- [x] A-011 R5: `quake-terminal.test.tsx` and `quake-launcher.test.tsx` each cover the cross-server empty-input case

### Edge Cases & Error Handling

- [x] A-012 R1: `useOperatorCompose(server, undefined).text` is `""` and `setOperatorComposeText(server, undefined, "x")` writes nothing to the store
- [x] A-013 R2: `flagsFor(null)` returns the stable initial flags object; the hook's returned object is reference-stable across re-renders with unchanged inputs

### Code Quality

- [x] A-014 Pattern consistency: The seam follows the module's existing pub/sub idiom (module state + listener `Set` + `useState`/`useSyncExternalStore` subscribers) and the draft store's stable-snapshot contract
- [x] A-015 No unnecessary duplication: Draft persistence reuses `compose-draft-store` (no new localStorage key, no parallel draft map)
- [x] A-016 Type narrowing over assertions: no new `as` casts in the changed frontend code
- [x] A-017 Comment discipline: comments state invariants (per-target draft, per-server flags), never narrate history or cite change IDs — one stale pre-existing banner line flagged as a should-fix finding (not a new-comment violation)
- [x] A-018 Tests: `just test-frontend` green (4803 passed); `just test-e2e quake-terminal.spec` green (46 passed); `cd app/frontend && npx tsc --noEmit` clean — all re-run by the reviewer

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality (the per-server re-key) without making existing code redundant; the removed single `composeState` global was deleted in place

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Export a test-only `resetOperatorComposeFlags()` from `lib/quake-terminal.ts` so tests can clear the per-server flags map between cases | The module already exports test seams (`setQuakeMachineState`, `setQuakeRestoreOrigin`); `hydrateComposeDrafts()` covers the text but not the flags | S:60 R:95 A:85 D:75 |
| 2 | Confident | The e2e two-server case uses `page.goto` between routes (a full load), which also exercises the store's refresh persistence, rather than in-app sidebar navigation | `mockStateSocket` supports `sessionsByServer`; a `goto` is the spec's existing arrival idiom and the draft-store's localStorage layer makes the return-to-A assertion meaningful | S:65 R:90 A:80 D:70 |
| 3 | Confident | Tasks folded to five (seam + store comment; both consumers; lib tests; component tests; e2e) — each is one focused edit session | Intake's seven areas map onto the same files; the fold keeps the light lane for a fix whose full context is already loaded | S:70 R:95 A:85 D:75 |

3 assumptions (0 certain, 3 confident, 0 tentative).
