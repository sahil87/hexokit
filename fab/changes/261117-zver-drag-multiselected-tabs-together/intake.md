# Intake: Drag a Multi-Selected Set of Sidebar Tabs Together

**Change**: 261117-zver-drag-multiselected-tabs-together
**Created**: 2026-11-17

## Origin

Conversational — a `/fab-discuss` session. The user's raw input:

> I wanted to fix the way multi-select happens on the left panel. [...] And on top of that, if I just drag a multi-selected list, it should move together instead of me having to press Command K and choosing move 10 items from there.

The discussion split the request into two sequential changes with stacked PRs. Change 1 (`261117-z1ea-unify-sidebar-multiselect-look`, PR #1149) made bulk-selected rows share the single-select treatment and made the open tab seed the selection. **This is change 2**: dragging a multi-selected set moves the whole set. It is stacked on change 1's branch and assumes its selection semantics, which are already in that branch.

Decisions from the discussion:

- The rule: a drag that starts on a row INSIDE a selection of 2+ carries the whole set; a drag that starts on a row OUTSIDE the set drags only that row and leaves the selection alone.
- The three drop targets that exist today all accept a set: group (session) rows, board rows, and the gap between window rows.
- The user was asked: "When you drop the selection between two tabs, should the first version support that (block reorder), or only dropping on a group name?" and chose **(b): include the block reorder between rows now**.
- For the block reorder, the agent proposed a backend change and the user accepted the plan: ONE request that takes the list of window ids plus "before window X", computes the final order server-side, and applies it in one chained tmux invocation. N sequential per-window calls were rejected: slot indices drift after each move, and a mid-batch failure leaves the block half-moved, which looks broken for a drag.
- A set spanning workspaces (tmux servers) cannot move between servers, so a drop onto another server's rows is refused with a toast. This matches the palette move's single-server gate. A partial "move only the same-server ones" was rejected as surprising.
- Optimistic UI is out of v1: rows repaint from SSE. Revisit only if it feels slow.

## Why

1. **Pain point**: moving N selected tabs today means opening the palette (⌘K) and choosing `Selection: Move N tabs to <group>`. Dragging only ever moves the row under the pointer, even when that row is part of a visible selection. Every mainstream list (Finder, VS Code explorer, file managers) drags the whole selection.
2. **Consequence if not fixed**: multi-select stays a palette-only power feature, and a natural gesture silently does the wrong thing (it moves one tab out of a set the user just built).
3. **Why this approach**: reuse each drop target's existing single-row semantics and widen the payload to a set. Group-row drops reuse the palette bulk move's batch machinery (`executeSelectionBatch` + `batchToast`), because each window's move is independent and partial success is acceptable there. The positional block reorder gets a dedicated atomic backend operation because positions are interdependent.

## What Changes

### 1. Drag source: carry the set (`components/sidebar/index.tsx` `handleDragStart`, `window-row.tsx`)

Today `handleDragStart(e, server, sessionName, windowIndex, windowId, windowName)` calls `pinDragImage(e)`, sets `dragSource`, writes `application/json` `{server, session, index, windowId, name}`, writes `WINDOW_DRAG_MIME` = windowId, and sets `effectAllowed = "copyMove"`.

New behavior: at drag start, read `useSelectionStore.getState().selected`. If the dragged row's key (`${server}:${windowId}`) is in the set AND the set has ≥ 2 keys, this is a **set drag**:

- The payload gains `keys: string[]`, the selected keys in VISIBLE-ROW order (`getVisibleWindowKeys()` order, with selected-but-not-visible keys from collapsed sessions appended in store order). The existing single fields stay, describing the grabbed row, so foreign drop targets that read only `server`/`windowId` keep working.
- `dragSource` state gains the key list (e.g. `keys: string[] | null`) so `dragover` handlers can gate without reading the sealed payload.
- **Drag image**: a small "N tabs" badge (e.g. an offscreen element styled like a row chip, `N tabs`) set via `e.dataTransfer.setDragImage`, instead of the single row's snapshot. It is created and removed per drag (removed on `dragend`, or on the next tick after `setDragImage`, which only needs it in the DOM at call time). jsdom lacks `setDragImage`; guard the same way `pinDragImage` does.
- **Source dimming**: every set member row renders the existing drag-source treatment while the drag is in flight (extend `isDragSource` so set members also get it; today it only hides `FlairOverlay` — add a visible dim such as `opacity-50` to set members during a set drag, matching the board list's `isDragSource` dim).
- A drag starting on a row NOT in the set, or with a set of 0–1, is unchanged (single drag; the selection is not modified).

### 2. Drop on a group (session) row — move the set into that group

`handleSessionDragOver` / `handleSessionDrop` (index.tsx ~lines 883–914) today allow same-server, different-session drops and call the optimistic `executeMoveToSession`.

For a set drag:

- **dragover**: accept when the target session is on the same server as EVERY key. Unlike the single drag, the target may equal the grabbed row's own session, since other members may live elsewhere. Reject (no `preventDefault`) when every member is already in the target session. Cross-server sets do not show the drop affordance on other servers' rows; dropping on any row of a server some key doesn't belong to is refused (see below).
- **drop**: if any key's server differs from the target server, show the toast `Moving tabs across workspaces isn't supported yet` (existing copy) and do nothing. Otherwise move each member NOT already in the target session, in payload order, via `executeSelectionBatch(keys, ({windowId}) => moveWindowToSession(server, windowId, targetSession))` from `lib/palette/selection.ts`, and report one aggregate toast via `batchToast` with the same copy shape as the palette bulk move (`Moved N tabs to <session>` / `Moved X of N tabs to <session> — F failed: <first error>`).
- **Selection after the drop**: kept. Window ids survive `move-window`, so the set is still valid and the user can drag it again (Finder keeps the selection after a drag). Do NOT call `settleBatch`/`clear`.
- No optimistic ghost machinery for set moves. The single-row optimistic path is unchanged.

### 3. Drop on a board row — pin the whole set

`boards-section.tsx` row `onDrop` parses `application/json` and calls `usePinActions().pin(server, windowId, board)`.

For a payload carrying `keys` (≥ 2): pin each key (split via `splitSelectionKey`) sequentially, in order, against its OWN server. Pin is a link, not a move, and the existing path does no client-side cross-server gating. Emit ONE aggregate toast, `Pinned N tabs to <board>` (failures: `Pinned X of N tabs to <board> — F failed: <first error>`), instead of N per-pin toasts. If `usePinActions().pin` always toasts, add a quiet/batched variant or call the underlying client fn directly and keep `pin`'s last-used persistence semantics. The implementer picks, but the result must be one toast. `dragover` acceptance is unchanged (gated on `WINDOW_DRAG_MIME`).

### 4. Drop between window rows — atomic block move (backend + frontend)

Today `handleDragOver` accepts only same-server + same-session rows, and `handleDrop` calls the optimistic `executeMoveWindow(server, session, srcWindowId, srcIndex, dstIndex)` → `POST /api/windows/{windowId}/move {targetIndex}` → `tmux.MoveWindow` (insert-before via an adjacent-swap chain plus a session-qualified `select-window` restore of the active window, all in ONE `\;`-chained tmux invocation; `app/backend/internal/tmux/tmux.go` ~line 2575).

For a set drag, dropping on window row T (in session S, server X):

- **dragover**: accept any window row on server X when every key is on server X (the target may be in a different session from some or all members). Show the existing insert-before indicator (`isDragOver` → `0 -2px 0 0 var(--color-accent)`).
- **drop**:
  - Cross-server set → toast `Moving tabs across workspaces isn't supported yet`, no-op.
  - T itself in the set → no-op (dropping a block onto its own member changes nothing; Finder semantics).
  - Otherwise ONE request: `moveWindowsBefore(server, windowIds, beforeWindowId)` (new client fn in `app/frontend/src/api/client.ts`) → new endpoint below. On error, show `addToast(err.message || "Failed to move tabs")`. Rows repaint from SSE. No optimistic reorder in v1.
- **Result order**: the members end up contiguous, directly before T, in payload (visible-row) order. Non-members of S keep their relative order. Members that came from other sessions on X are moved into S.

**New endpoint** (Constitution IX — `POST`; Constitution I — validated ids, `exec.CommandContext` argument slices via `internal/tmux`):

```
POST /api/windows/move-block?server=<server>
{ "windowIds": ["@3", "@7", "@9"], "beforeWindowId": "@5" }
→ 200 {"ok": true}
→ 400 when windowIds is empty, contains duplicates or an invalid id, or contains beforeWindowId; or beforeWindowId is missing/invalid
→ 500 with the tmux error otherwise
```

Window ids are validated with the same validator `parseWindowID` applies to the path param. Register it in `app/backend/api/router.go` beside the existing `/api/windows/{windowId}/move` routes, and register the path BEFORE any `{windowId}` pattern that could shadow it; chi's static segment wins anyway, but keep it adjacent and explicit. Document it in `docs/specs/api.md` where window move endpoints are listed. If none are listed there, add a short entry so the "no route without spec justification" anti-pattern is satisfied.

**Server-side execution — reuse the sort-windows planner** (`app/backend/api/sortwindows.go`). The precedent `POST /api/sessions/{session}/sort-windows` already reorders a session in one request: it computes a target order, plans insert-before moves with the pure `planSortMoves(windows, target)` (which simulates each move over the session's sorted index slots so later destinations account for earlier ones — no index drift), and applies them with sequential `s.tmux.MoveWindow` calls, then wakes the SSE hub. The block move follows the same shape. Write NO new swap-chain planner and NO new tmux primitive:

1. Validate the body before any tmux call (ids via the shared window-id validator; non-empty, no duplicates, `beforeWindowId` not among `windowIds`).
2. Resolve T's session `S` and the live windows via `s.sessions.FetchSessions(ctx, server)` (as sort-windows does); 404 when `beforeWindowId` is not found on the server, 400 when a member id is not found on the server.
3. For each member not in `S`, `s.tmux.MoveWindowToSession(id, S, server)` (appends; the id survives). Then re-fetch `S`'s windows.
4. Compute the target order with a **pure, unit-tested** helper (e.g. `blockTargetOrder(windows []tmux.WindowInfo, members []string, before string) []tmux.WindowInfo`): remove the members, then insert them in the given order immediately before `before`.
5. `moves := planSortMoves(windows, target)`; apply each with `s.tmux.MoveWindow`; on the first error return 500 with it, as sort-windows does. An already-in-place block yields no moves and no mutation.
6. When anything moved, `s.initSSEHub(); s.sseHub.wake(server)`.

Each `MoveWindow` is individually atomic and keeps the session's active window, via its chained `select-window` restore. The sequence as a whole is not one tmux invocation. This matches sort-windows' accepted trade-off, and the request is still single and server-planned, so the index-drift problem the discussion rejected does not arise.

### 5. Coarse pointers

HTML5 drag-and-drop is fine-pointer only in this UI. No touch behavior changes.

### 6. Tests

- Go: unit tests for `blockTargetOrder` (forward/backward blocks, members scattered on both sides of T, block already in place → `planSortMoves` yields no moves, a single member gives today's single-row result), and handler tests in `app/backend/api` using the existing `mockTmuxOps` (`sessions_test.go`) and the sort-windows handler tests as the pattern: 400 cases, 404 unknown `beforeWindowId`, cross-session members trigger `MoveWindowToSession` before the `MoveWindow` batch, and the recorded `MoveWindow` calls realize the target order.
- Frontend unit (`sidebar/index.test.tsx`, `boards-section.test.tsx`): set drag payload carries ordered `keys` only when the grabbed row is in a 2+ set; a non-member drag is unchanged; group-row drop calls `moveWindowToSession` once per non-resident member, sequentially, with one toast; cross-server refusal; board drop pins each key with one toast; window-row drop calls `moveWindowsBefore` once with `beforeWindowId`, no-op when the target is a member.
- E2E (`app/frontend/tests/e2e/`, new `sidebar-multiselect-drag.spec.ts` or extend `sidebar-multiselect.spec.ts` with its own fixture windows): drag a 2-member set onto another group row → both windows are in the target session in tmux; drag a set between rows → tmux window order matches; board drop pins both. Use Playwright `dragTo` or manual dataTransfer dispatch, following the existing drag e2e specs (grep for `dragTo` / `dataTransfer` in `tests/e2e`).
- PR evidence: `just demo <name>` web lane, desktop only (fine-pointer gesture). State that rationale in the PR body.

## Affected Memory

- `run-kit/ui/sidebar`: (modify) § Window-Row Multi-Select: set drag (payload `keys`, drag image, source dim), the three drop targets with set semantics, cross-server refusal, selection kept after a drag. Design Decisions: why group drops batch per window while the block reorder is one atomic backend op.
- `run-kit/api-and-sockets`: (modify) new `POST /api/windows/move-block` endpoint contract.
- `run-kit/architecture/backend-packages`: (modify) the move-block handler and `blockTargetOrder`, reusing `planSortMoves`, if that file documents the sort-windows planner; otherwise skip.

## Impact

- Frontend: `components/sidebar/index.tsx` (drag start/over/drop handlers, `dragSource` shape), `components/sidebar/window-row.tsx` (set-member drag dim), `components/sidebar/boards-section.tsx` (set pin), `api/client.ts` (`moveWindowsBefore`), possibly `hooks/use-pin-actions.ts` (batched/quiet pin), `lib/drag-image.ts` (count badge helper).
- Backend: `app/backend/api/router.go` (route), `app/backend/api/windows.go` or a sibling file (handler + `blockTargetOrder`), reusing `planSortMoves` from `api/sortwindows.go` and the existing `s.tmux.MoveWindow` / `MoveWindowToSession` interface methods. No new tmux primitive and no interface change.
- Docs: `docs/specs/api.md` entry for the new endpoint.
- The palette `Selection:` actions are unchanged and remain the keyboard path for moving a set (Constitution V).

## Open Questions

- None blocking. Keyboard parity for positional block reorder (e.g. `Selection: Move up/down`) is a possible follow-up; the palette's `Selection: Move N tabs to <group>` already gives keyboard reach for moving a set.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | A drag starting on a member of a 2+ set carries the whole set; a non-member drag is single and leaves the selection alone | Discussed — agreed rule | S:90 R:85 A:85 D:90 |
| 2 | Certain | All three existing drop targets (group row, board row, between rows) accept a set in this change | Discussed — user chose to include the block reorder now (option b) | S:95 R:75 A:85 D:90 |
| 3 | Confident | Block reorder is ONE backend request that plans the final order server-side and applies it, not N client calls | Discussed — user accepted; client-side index drift rejected. Execution reuses the sort-windows planner + sequential MoveWindow (same trade-off as sort-windows) rather than a new single-invocation swap chain | S:75 R:70 A:85 D:75 |
| 4 | Certain | Cross-server sets are refused with the existing toast copy; no partial move | Discussed — tmux constraint, matches palette gate | S:85 R:85 A:90 D:90 |
| 5 | Certain | No optimistic UI for set moves in v1; SSE repaints | Discussed — start with the existing bulk path, revisit if slow | S:75 R:90 A:80 D:80 |
| 6 | Certain | Group-row drop reuses `executeSelectionBatch` + `batchToast` (sequential, continue-on-error, one toast) | Discussed — independent per-window moves; existing machinery | S:75 R:85 A:85 D:85 |
| 7 | Confident | Endpoint shape `POST /api/windows/move-block {windowIds, beforeWindowId}` | Constitution IX (POST); mirrors existing `/api/windows/...` routes; agent's proposal accepted in principle | S:60 R:70 A:80 D:70 |
| 8 | Confident | Members end contiguous before T in visible-row order; non-members keep relative order; T in the set → no-op | Standard list block-move semantics | S:60 R:85 A:80 D:75 |
| 9 | Confident | Selection is kept after a drag move (unlike the palette's settleBatch) | Window ids survive move-window; Finder keeps selection after drag | S:40 R:90 A:65 D:60 |
| 10 | Confident | Board drop pins each key against its own server, one aggregate toast | Pin is a link; existing path does no cross-server gating; N toasts would be noise | S:55 R:90 A:75 D:75 |
| 11 | Certain | Drag image is an "N tabs" badge; set members dim during the drag | Discussed — agent proposed, user did not object | S:65 R:95 A:80 D:75 |
| 12 | Confident | No new palette entries; `Selection: Move N tabs to <group>` remains the keyboard path; positional keyboard reorder of a set is a follow-up | Constitution V is satisfied for moving a set; avoids scope creep | S:40 R:85 A:60 D:60 |
| 13 | Certain | PR evidence: web-lane `just demo`, desktop only, rationale stated in PR body | Constitution § PR Evidence; drag is fine-pointer only | S:80 R:90 A:90 D:85 |

13 assumptions (7 certain, 6 confident, 0 tentative, 0 unresolved).
