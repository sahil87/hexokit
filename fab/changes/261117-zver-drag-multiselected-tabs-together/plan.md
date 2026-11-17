# Plan: Drag a Multi-Selected Set of Sidebar Tabs Together

**Change**: 261117-zver-drag-multiselected-tabs-together
**Intake**: `intake.md`

## Requirements

### Sidebar: Set Drag Source

#### R1: A drag from inside a 2+ set carries the set
When a window-row drag starts on a row whose key is in the bulk selection and the selection holds ≥ 2 keys, the drag SHALL carry the whole set: the `application/json` payload SHALL add `keys: string[]` (visible-row order, then any selected-but-not-visible keys in store order) alongside the unchanged single-row fields, the sidebar's `dragSource` state SHALL carry the key list, the drag image SHALL be an "N tabs" badge, and every set member row SHALL render dimmed while the drag is in flight. A drag starting on a non-member, or with a selection of 0–1, SHALL behave exactly as before and SHALL NOT modify the selection.

- **GIVEN** tabs B and D are selected
- **WHEN** the user starts dragging B
- **THEN** the payload carries `keys: [B, D]`, the ghost reads `2 tabs`, and B and D are dimmed
- **GIVEN** tabs B and D are selected
- **WHEN** the user starts dragging C
- **THEN** the drag is a single-row drag of C and the selection stays {B, D}

### Sidebar: Set Drop Targets

#### R2: Dropping a set on a group row moves the set into that group
For a set drag, a session row on the same server as every key SHALL accept the drop (including the grabbed row's own session) unless every member already lives there. On drop, each member not already in the target session SHALL be moved with `moveWindowToSession`, sequentially in payload order via `executeSelectionBatch`, with one aggregate `batchToast` (`Moved N tabs to <session>` / partial-failure form). The selection SHALL be kept.

- **GIVEN** B (group G1) and D (group G2) are selected on server X
- **WHEN** the set is dropped on group G3's row on server X
- **THEN** B and D are in G3, one toast reads `Moved 2 tabs to G3`, and {B, D} stays selected

#### R3: Cross-server sets are refused
A set drop (group row or between rows) whose keys are not all on the target row's server SHALL do nothing except show the toast `Moving tabs across workspaces isn't supported yet`.

- **GIVEN** the set holds a tab on server X and a tab on server Y
- **WHEN** it is dropped on a group row on server X
- **THEN** nothing moves and the toast appears

#### R4: Dropping a set on a board row pins every member
A board-row drop whose payload carries `keys` (≥ 2) SHALL pin each key (split with `splitSelectionKey`) against its own server, sequentially, with exactly ONE aggregate toast (`Pinned N tabs to <board>` / partial-failure form).

- **GIVEN** B and D are selected
- **WHEN** the set is dropped on board "work"
- **THEN** both are pinned to "work" and one toast is shown

#### R5: Dropping a set between rows moves it as a block
For a set drag, any window row T on the same server as every key SHALL accept the drop with the existing insert-before indicator. On drop: if T is a member → no-op; otherwise ONE request `moveWindowsBefore(server, keysWindowIds, T.windowId)` SHALL be sent (new client fn in `api/client.ts`), errors toasted as `err.message || "Failed to move tabs"`. Rows repaint from SSE (no optimistic reorder).

- **GIVEN** session S holds [A, B, C, D, E] and {B, D} is selected
- **WHEN** the set is dropped before A
- **THEN** one `POST /api/windows/move-block` is sent with `{windowIds:[B,D], beforeWindowId:A}`

### Backend: Block Move Endpoint

#### R6: `POST /api/windows/move-block` places members contiguously before a target
The endpoint SHALL accept `{windowIds: string[], beforeWindowId: string}` (query `server`). It SHALL validate before any tmux call: non-empty `windowIds`, every id valid per the shared window-id validator, no duplicates, `beforeWindowId` present/valid and not among `windowIds` → else 400. It SHALL resolve live windows via `s.sessions.FetchSessions`; an unknown `beforeWindowId` → 404, an unknown member → 400. Members outside T's session SHALL be moved in with `s.tmux.MoveWindowToSession` first; the target order SHALL be computed by a pure `blockTargetOrder` (members removed, re-inserted in the given order immediately before T, non-members keep relative order) and realized with `planSortMoves` + sequential `s.tmux.MoveWindow`; the first tmux error → 500. When anything moved, the SSE hub SHALL be woken. Success → 200 `{"ok": true}`. Route registered with `r.Post` in `router.go` beside the other window move routes.

- **GIVEN** S = [A, B, C, D, E]
- **WHEN** `{windowIds:[B, D], beforeWindowId: A}` is posted
- **THEN** S becomes [B, D, A, C, E]
- **GIVEN** S = [A, B, C, D, E]
- **WHEN** `{windowIds:[A, B], beforeWindowId: E}` is posted
- **THEN** S becomes [C, D, A, B, E]
- **GIVEN** S = [A, B, C] already in place for `{windowIds:[A], beforeWindowId: B}`
- **WHEN** posted
- **THEN** no `MoveWindow` call is made

#### R7: The endpoint is documented
`docs/specs/api.md` SHALL list `POST /api/windows/move-block` with its body and status codes.

- **GIVEN** a reader of the API spec
- **WHEN** they look for window move endpoints
- **THEN** move-block's contract is documented

### Non-Goals

- Optimistic UI for set moves.
- New palette entries (positional keyboard reorder of a set is a follow-up; `Selection: Move N tabs to <group>` remains the keyboard path).
- Touch/coarse-pointer drag.

### Design Decisions

#### Group drops batch per window; the positional block move is one server-planned request
**Decision**: A set dropped on a group row reuses the palette's sequential per-window `moveWindowToSession` batch; a set dropped between rows is one `POST /api/windows/move-block` that plans the whole order server-side with `planSortMoves`.
**Why**: Moves into a group are independent per window, so partial success is meaningful and the existing batch/toast machinery fits. Positions are interdependent: client-side per-window calls would drift slot indices after each move, so the order must be planned in one place — the same shape as sort-windows.
**Rejected**: N client-side `moveWindow(index)` calls (index drift, half-moved blocks); a new single-invocation swap-chain tmux primitive (duplicates the tested sort planner for marginal atomicity gain).
*Introduced by*: 261117-zver-drag-multiselected-tabs-together

## Tasks

### Phase 1: Backend

- [x] T001 Add pure `blockTargetOrder(windows []tmux.WindowInfo, members []string, before string) []tmux.WindowInfo` beside `planSortMoves` in `app/backend/api/sortwindows.go` (or a sibling `app/backend/api/moveblock.go`) with table tests (forward, backward, scattered members, already-in-place → no planned moves) <!-- R6 -->
- [x] T002 Add `handleWindowMoveBlock` (`app/backend/api/moveblock.go` or `windows.go`) + route `r.Post("/api/windows/move-block", ...)` in `app/backend/api/router.go`; validation, FetchSessions resolution, cross-session `MoveWindowToSession`, `planSortMoves` + `MoveWindow`, SSE wake; handler tests with `mockTmuxOps` covering 400/404/500, cross-session pre-move, recorded move order <!-- R6 -->
- [x] T003 [P] Document `POST /api/windows/move-block` in `docs/specs/api.md` <!-- R7 --> <!-- rework: document the 404 "Target session not found" after the cross-session refetch, or fold it into 500 -->

### Phase 2: Frontend

- [x] T004 Add `moveWindowsBefore(server, windowIds, beforeWindowId)` to `app/frontend/src/api/client.ts` (mirrors `moveWindow`) <!-- R5 -->
- [x] T005 Set drag source in `app/frontend/src/components/sidebar/index.tsx` `handleDragStart`: detect a 2+ set containing the grabbed key, add ordered `keys` to the payload and `dragSource`, set an "N tabs" badge drag image (helper in `app/frontend/src/lib/drag-image.ts`, guarded like `pinDragImage`), clear on dragend; dim set members via `isDragSource` in `window-row.tsx` <!-- R1 -->
- [x] T006 Set drops in `app/frontend/src/components/sidebar/index.tsx`: `handleSessionDragOver/Drop` (R2, R3 — `executeSelectionBatch` + `batchToast`, selection kept) and `handleDragOver/Drop` (R5, R3 — `moveWindowsBefore`, member-target no-op) <!-- R2 R3 R5 --> <!-- rework: cross-server set dragover must keep preventDefault with dropEffect "move" (not "none") and no indicator, so drop fires and the R3 toast runs; suppress the insert-before indicator when hovering a set member -->
- [x] T007 Board set drop in `app/frontend/src/components/sidebar/boards-section.tsx`: pin each key with one aggregate toast (quiet/batched pin path in `app/frontend/src/hooks/use-pin-actions.ts` if `pin` always toasts) <!-- R4 -->

### Phase 3: Tests & Evidence

- [x] T008 Frontend unit tests: `sidebar/index.test.tsx` (payload/keys only for 2+ member drag, non-member drag unchanged, group drop sequencing + one toast + selection kept, cross-server refusal, row drop single request + member no-op), `boards-section.test.tsx` (set pin, one toast), `drag-image` helper <!-- R1 R2 R3 R4 R5 --> <!-- rework: add tests that fire dragOver before drop for both cross-server branches, asserting the dragover was cancelled with a non-"none" effect and the toast appears -->
- [x] T009 E2E `app/frontend/tests/e2e/sidebar-multiselect-drag.spec.ts`: set → group row (tmux sessions verified), set → between rows (tmux order verified), set → board (both pinned); isolated e2e tmux server <!-- R2 R4 R5 --> <!-- rework: group-drop test must also assert the sidebar renders both members under the destination group (expect timeout of 5s or more); optionally the same for the between-rows test -->
- [x] T010 Demo `app/frontend/tests/demo/sidebar-multiselect-drag.demo.ts` (desktop only) and record `just demo sidebar-multiselect-drag --desktop-only` <!-- R1 R5 --> <!-- rework: wait (5s or more) for both members to render under the destination group before the final beat, then re-record just demo sidebar-multiselect-drag --desktop-only -->
- [x] T011 Wake the SSE hub after a successful move in `handleWindowMoveToSession` (`app/backend/api/windows.go`), using `s.initSSEHub(); s.sseHub.wake(server)` as move-block/sort-windows do, plus a handler test asserting the wake <!-- R2 --> <!-- rework: set group-drop has no optimistic ghost; uncovered servers wait for the 2.5s poll -->
- [x] T012 Extract the shared "move keys to session + aggregate toast" glue used by `app/frontend/src/app.tsx` `executeBulkMove` and the sidebar set group-drop into one helper in `app/frontend/src/lib/palette/selection.ts`; both call sites use it (the palette keeps its settleBatch) <!-- R2 --> <!-- rework: duplicated glue -->

## Execution Order

- T001 blocks T002; T002 blocks T009
- T004 blocks T006
- T005 blocks T006 and T007

## Acceptance

### Functional Completeness

- [x] A-001 R1: A drag from a member of a 2+ set writes ordered `keys` into the payload and `dragSource`, uses an "N tabs" drag image, and dims members; other drags are unchanged
- [x] A-002 R2: A set dropped on a same-server group row moves every non-resident member via sequential `moveWindowToSession` with one aggregate toast and keeps the selection
- [x] A-003 R3: Cross-server set drops (group row or between rows) only toast `Moving tabs across workspaces isn't supported yet` (set dragover now cancels with `dropEffect = "move"` and no indicator, so `drop` fires; unit tests dispatch dragOver before drop)
- [x] A-004 R4: A set dropped on a board row pins each member against its own server with exactly one toast
- [x] A-005 R5: A set dropped between rows sends exactly one `POST /api/windows/move-block`; dropping on a member is a no-op
- [x] A-006 R6: The endpoint validates before any tmux call, resolves via FetchSessions, pre-moves cross-session members, realizes `blockTargetOrder` through `planSortMoves` + `MoveWindow`, wakes SSE, and returns the documented status codes
- [x] A-007 R7: `docs/specs/api.md` documents the endpoint

### Behavioral Correctness

- [x] A-008 R1: A non-member drag never mutates the selection
- [x] A-009 R6: An already-in-place block issues no `MoveWindow` call

### Scenario Coverage

- [x] A-010 R6: Go tests cover the R6 scenarios (forward, backward, scattered, in-place) and the 400/404/500 paths
- [x] A-011 R2: E2E verifies a set dropped on a group row lands in that tmux session
- [x] A-012 R5: E2E verifies tmux window order after a between-rows set drop
- [x] A-013 R4: E2E or unit verifies a board set drop pins every member

### Edge Cases & Error Handling

- [x] A-014 R2: A group row where every member already lives does not accept the set drop
- [x] A-015 R6: Duplicate ids, empty list, invalid ids, and `beforeWindowId` inside `windowIds` are 400 with no tmux call

### Code Quality

- [x] A-016 Pattern consistency: New code follows naming and structural patterns of surrounding code (stable identity-arg callbacks in the sidebar, sort-windows handler shape in Go)
- [x] A-017 No unnecessary duplication: `planSortMoves`, `executeSelectionBatch`, `batchToast`, `splitSelectionKey`, and the window-id validator are reused; move-batch + toast glue shared via `executeSelectionMove`
- [x] A-018 Security: All tmux access goes through `s.tmux` / `internal/tmux` with validated ids — no shell strings
- [x] A-019 Type narrowing over `as` casts when parsing the drag payload
- [x] A-020 No comment narration or change-id citations in new comments
- [x] A-021 PR evidence: a desktop `just demo` recording exists, with the desktop-only rationale stated in the PR body (demo waits for both members under the destination group; `.demo/sidebar-multiselect-drag-desktop.webm` re-recorded and its final frame shows them there)
- [x] A-022 Tests cover the changed behavior; `go test ./...`, `npx tsc --noEmit`, and touched unit/e2e suites pass (api pkg + race ok, tsc ok, 694 sidebar/lib vitest ok, e2e 3/3; only failure is the env-dependent `cmd/rk` TestPortPinRowRealPolicyValues, untouched by this diff)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Reuse `planSortMoves` + sequential `MoveWindow` server-side for the block move | Existing tested planner and sort-windows precedent; avoids a new tmux primitive | S:70 R:75 A:85 D:75 |
| 2 | Confident | Unknown `beforeWindowId` → 404, unknown member → 400 | Mirrors sort-windows' unknown-session 404; a bad member is a malformed request | S:50 R:90 A:75 D:65 |
| 3 | Certain | Group-row set drop keeps the selection (no settleBatch) | Intake assumption 9 | S:70 R:90 A:85 D:85 |

3 assumptions (1 certain, 2 confident, 0 tentative).
