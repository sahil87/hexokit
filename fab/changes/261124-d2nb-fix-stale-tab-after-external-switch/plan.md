# Plan: Fix stale tab after an external window switch — single-owner viewed-window state

**Change**: 261124-d2nb-fix-stale-tab-after-external-switch
**Intake**: `intake.md`

## Requirements

### Terminal route: viewed-window ownership

#### R1: tmux owns the viewed window on the home-tab route
On the `/$server/$window` terminal route (not popout posture), the URL `$window` param — and therefore the center heading, sidebar selection and the Compose target (`FocusedTerminal.windowId` registered by `TerminalClient`) — SHALL be a projection of tmux's active window for the viewed session (the SSE-derived `activeWindow`), except while a bounded switch overlay (R2) is live. No code path SHALL keep the URL pointing at a window other than `activeWindow` once the overlay has ended.

- **GIVEN** the user is on `/$server/@A` and no switch overlay is live
- **WHEN** an external writer makes `@B` the session's active window (`rk riff` → `new-window`, `tmux select-window`, a tmux status-bar click, another browser)
- **THEN** the next session snapshot navigates the URL to `@B` with `replace: true`
- **AND** the heading shows `@B` and a Compose send targets `@B`

#### R2: UI-initiated switches are requests with a bounded optimistic overlay
Every UI-initiated same-server switch on the terminal route — `navigateToWindow`'s `runSwitch` (sidebar, palette `Tab: Switch to …`, breadcrumb, SessionTiles), `navigateToWaitingTarget` (same-server branch) and the cold deep-link / history-navigation alignment effect — SHALL fire `selectWindow(server, windowId)` and start a **switch overlay** `{ server, windowId, seq }`. While the overlay is live the URL writeback SHALL NOT override it. The overlay SHALL end at the FIRST of:

1. a session snapshot reports `overlay.windowId` active (**confirm**);
2. the POST resolved 200 AND a session snapshot **newer than the one held when the POST settled** has been received — whatever window it reports (**post-settle snapshot**); a 200 whose `activeWindow` differs from `overlay.windowId` ends it immediately;
3. the POST rejected or returned non-2xx (**rejected**);
4. a hard deadline of `CONFIRMATION_WINDOW_MS` (5000 ms) from overlay start (**deadline**), via a timer cleared ONLY when the overlay ends or is superseded/torn down — never on POST success.

The overlay end SHALL NOT depend on whether a terminal byte was counted.

- **GIVEN** the user clicks `@B` in the sidebar while on `@A`
- **WHEN** the POST resolves 200 before tmux's snapshot arrives
- **THEN** the URL stays on `@B` (no bounce to the still-stale `@A` snapshot)
- **AND** when the snapshot reporting `@B` arrives the overlay ends (confirm)

- **GIVEN** a switch to `@B` whose POST returned 200
- **WHEN** the next session snapshot reports `@C` (an external switch raced in)
- **THEN** the overlay ends and the URL follows `@C`

#### R3: Overlay end outcomes
- On **rejected**: the URL SHALL `navigate({ replace: true })` to the current SSE `activeWindow` and the existing toast "Tab switch didn't confirm — back to the active tab" (error) SHALL fire.
- On **deadline**: the overlay SHALL end silently (no toast); the writeback then follows the current snapshot.
- On **confirm**, **post-settle snapshot**, or **deadline**, nothing else is held: the writeback re-runs in the same commit (the overlay is React state, or a ref paired with a state bump, so ending it re-evaluates the writeback).

- **GIVEN** a switch whose POST hangs and no confirming snapshot arrives
- **WHEN** 5000 ms elapse
- **THEN** the overlay ends without a toast and the URL equals the SSE `activeWindow`

#### R4: Supersession and identity
A new switch SHALL supersede any live overlay (monotonic `seq`); a POST settlement or deadline for an older `seq` SHALL be a no-op. Overlay identity SHALL be `{server, windowId}` (`@N` ids are only unique per server — the existing H1 rule): a `$server` change, leaving the window route (`!windowParam`), and AppShell unmount SHALL end the overlay and abandon its paint feedback.

- **GIVEN** a switch to `@B` (seq 1) immediately followed by a switch to `@C` (seq 2)
- **WHEN** seq 1's POST resolves after seq 2 started
- **THEN** seq 1's settlement changes nothing and the overlay remains `@C`

#### R5: Dialog-open suppression re-evaluates on close
The writeback SHALL stay suppressed while any dialog in the existing `dialogOpenRef` predicate (`app.tsx` ~3312) is open, and SHALL re-run when the predicate turns false (the predicate becomes a writeback dependency, not a ref read).

- **GIVEN** a dialog is open on `/$server/@A`
- **WHEN** tmux switches to `@B` externally and the dialog then closes
- **THEN** the URL navigates to `@B` on close

#### R6: Paint feedback is decoupled from ownership
The first-write gate, grace mask, spinner mask and `bytesCounted` in `lib/window-transition.ts` SHALL keep their byte-driven lifecycle for paint only. On overlay end: if `activeWindow` equals the overlay target, call `confirmSwitchArrived()` (byte-gated); on the **deadline** end call `forceSwitchArrived()` when the target is active, otherwise `abandonSwitchFeedback()`; on **rejected** or when a different window won, call `abandonSwitchFeedback()`. The invariant "an input-blocking mask can never stay up past the deadline" SHALL hold.

- **GIVEN** a gated switch whose snapshot confirms before any byte is counted
- **WHEN** bytes never arrive
- **THEN** the overlay has already ended (URL correct) and the mask is torn down no later than the deadline

#### R7: Deferred buffer clear keys on the overlay
`clearOnWindowChange` (the prop at `app.tsx` ~6205 forwarded to `SurfaceLayout`) SHALL be true exactly when a live overlay targets `{server, windowParam}` — a UI-initiated ride — and false for a tmux/SSE-driven writeback, preserving today's semantics.

- **GIVEN** `rk riff` switches the session to `@B` and the writeback navigates there
- **WHEN** the terminal rides to `@B`
- **THEN** no deferred buffer clear is armed

#### R8: Popout and isolated tiles unchanged
Popout posture (`popoutPosture`) SHALL keep its fixed window (no alignment, no writeback, no overlay). Isolated cross-tab tiles (`_rk-iso-*`) are unaffected.

- **GIVEN** a popout window for `@A`
- **WHEN** tmux switches the session to `@B`
- **THEN** the popout's route stays `@A`

### Removal

#### R9: The pending-intent lock is removed
`pendingClickRef`, `pendingSwitchRef` and their tracking (`beginPendingSwitch`, `bouncePendingSwitch`, `clearPendingSwitchTracking`), the bounce freshness verdict (`resolvePendingSwitchVerdict`, `tickAtClick`, `postContradiction`, `bounceDisarmed`), and the writeback's `urlMatchesPending` / `sseConfirmed` / `hasCountedIncomingBytes` branches SHALL be removed. `resolvePendingSwitchPost` / `postConfirmsSwitch` / `isSamePendingTarget` / `PendingSwitchTarget` SHALL be removed or replaced by the overlay module if no longer used. `hasCountedIncomingBytes` MAY stay as a test query of the paint gate. No dead code or stale comments referencing the removed machinery SHALL remain.

- **GIVEN** the change is applied
- **WHEN** grepping `app/frontend/src` for `pendingClickRef|beginPendingSwitch|bouncePendingSwitch|resolvePendingSwitchVerdict`
- **THEN** there are no matches

### Non-Goals

- Stale-snapshot guard (generation counter / client hold) — the user accepted the self-correcting sub-second flicker when a derive started before the select publishes after it (intake Q1).
- Compose-specific targeting (reading tmux's active window or server-side resolution at send time) — the URL projection suffices (intake Q2).
- Backend changes — `POST /api/windows/{windowId}/select` already returns `activeWindow`.
- Cross-server navigation and the board route — unchanged.

### Design Decisions

#### Single owner for the viewed window
**Decision**: On the home-tab terminal route tmux owns which window is shown; the URL, heading, sidebar selection and Compose target are projections of SSE `activeWindow`. UI switches are `selectWindow` requests with a bounded optimistic overlay.
**Why**: The PTY renders tmux's session-current window, so two writable copies (URL + tmux) reconciled by a pending-intent lock leaked — POST 200 cancelled the rescue timer and the byte-gated hold left the URL stuck after an external switch (`rk riff`), misdirecting Compose sends. Constitution II: external writes win.
**Rejected**: Patching the lock (keeps two writers); per-browser isolated sessions (loses rk riff follow and convergence); Compose-only target resolution (URL/heading stay wrong).
*Introduced by*: 261124-d2nb-fix-stale-tab-after-external-switch

#### Overlay ends on the first post-settle session snapshot
**Decision**: The overlay ends on SSE confirm, on the first session snapshot newer than the one held at POST settle (after a 200), on rejection, or at a 5 s never-cancelled deadline.
**Why**: At POST settle the client still holds the pre-select snapshot (tmux's `%session-window-changed` derive arrives ~300 ms later), so ending at settle would bounce every click; any snapshot newer than that post-dates the select and is truth.
**Rejected**: End at POST settle (bounces every click); the per-server receipt tick as the freshness signal (it bumps on every server-scoped event, not only sessions snapshots); holding until a byte is counted (the original leak).
*Introduced by*: 261124-d2nb-fix-stale-tab-after-external-switch

### Deprecated Requirements

#### Pending-switch intent with failure bounce
**Reason**: Replaced by the bounded overlay; the intent's byte-gated hold and cancellable rescue timer were the root cause of the stale-tab bug.
**Migration**: R2–R4 (overlay start/end/supersession); R3 keeps the rejection toast; the deadline ends silently.

## Tasks

### Phase 1: Overlay state machine

- [x] T001 Create `app/frontend/src/lib/switch-overlay.ts`: a pure, framework-free module exporting the `SwitchOverlay` type (`{ server, windowId, seq, postSettled: "pending" | "ok" | "rejected", snapshotAtSettle: unknown | null }` or equivalent) and pure transition functions — `startOverlay`, `onPostSettled(overlay, seq, outcome, currentSnapshotToken)`, `onSnapshot(overlay, activeWindowId, snapshotToken)`, `onDeadline(overlay, seq)` — each returning the next overlay (or `null`) plus an end reason (`confirm | post-settle-snapshot | rejected | deadline | superseded`), so app.tsx wiring stays thin. Export `CONFIRMATION_WINDOW_MS` from here if it moves. <!-- R2 -->
- [x] T002 [P] Unit tests `app/frontend/src/lib/switch-overlay.test.ts`: confirm; 200-before-snapshot keeps the overlay (no bounce on the held stale snapshot); post-settle snapshot reporting a third window ends it; mismatched `resp.activeWindow` ends it; rejected; deadline; stale-seq settlement/deadline are no-ops; server identity (same `@N` on another server never confirms). <!-- R2 -->

### Phase 2: Wire the overlay into AppShell

- [x] T003 In `app/frontend/src/app.tsx`, replace `pendingClickRef` / `pendingSwitchRef` / `beginPendingSwitch` / `bouncePendingSwitch` / `clearPendingSwitchTracking` with overlay state (React state, or ref + state bump) driven by the T001 functions: start in `runSwitch`, `navigateToWaitingTarget` (same-server) and the alignment effect; one deadline timer per overlay cleared only on overlay end/supersession/teardown; POST settlement routed through `onPostSettled` with a stale-seq guard; session-snapshot arrival routed through `onSnapshot` using the `currentSession`/`activeWindow` object identity as the snapshot token (NOT `getServerReceiptTick`). <!-- R2 -->
- [x] T004 Rewrite the URL writeback effect in `app/frontend/src/app.tsx` (~2998–3063) to the unconditional projection: early-returns for popout, missing `activeWindow`/`sessionName`, a live same-server overlay, and dialog-open; otherwise `navigate({ replace: true, search: {} })` to `activeWindow.windowId` when it differs from `windowParam`. Make the dialog-open predicate (~3312) a dependency (derived boolean / memo), not a ref read. <!-- R1 -->
- [x] T005 Implement overlay-end outcomes in `app/frontend/src/app.tsx`: rejected → `navigate({replace:true})` to SSE `activeWindow` + existing error toast; deadline → silent end; paint calls per R6 (`confirmSwitchArrived` / `forceSwitchArrived` / `abandonSwitchFeedback`). <!-- R3 -->
- [x] T006 Collapse the server-change, route-leave and unmount teardown effects in `app/frontend/src/app.tsx` to "end the overlay + `abandonSwitchFeedback()`", keeping the server-change effect declared before the alignment effect. <!-- R4 -->
- [x] T007 Point `clearOnWindowChange` (`app/frontend/src/app.tsx` ~6205) at the live overlay (`overlay?.server === server && overlay.windowId === windowParam`). <!-- R7 -->
- [x] T008 Verify popout posture paths still early-return from alignment, writeback and overlay start (`app/frontend/src/app.tsx`, including the ~5764 same-server waiting-target comment). <!-- R8 -->

### Phase 3: Removal and tests

- [x] T009 Delete dead pending-switch helpers from `app/frontend/src/lib/window-transition.ts` (`resolvePendingSwitchVerdict`, `resolvePendingSwitchPost`, `postConfirmsSwitch`, `isSamePendingTarget`, `PendingSwitchTarget`, `SwitchPostOutcome`/`SwitchPostEffect` if unused) and their cases in `app/frontend/src/lib/window-transition.test.ts`; keep the paint-gate tests; remove stale comments referencing removed machinery across `app/frontend/src` (incl. `components/terminal-client.tsx`, `contexts/session-context.tsx` receipt-tick doc if its only consumer is gone — keep the tick if still used). <!-- R9 -->
- [x] T010 Add AppShell-level unit coverage in `app/frontend/src/app.test.tsx` (or a focused new test file) for: external switch after a confirmed-before-byte switch moves the URL; cold deep-link alignment then external switch moves the URL; dialog open during external switch → URL catches up on close; `clearOnWindowChange` false on an SSE-driven ride. <!-- R1 -->
- [x] T011 Add Playwright e2e `app/frontend/tests/e2e/external-switch-follow.spec.ts` (JSDoc Proves/Steps + file header per Constitution § Test Intent Comments): deep-link to a non-active window, then on the rig's tmux socket run an external `select-window` / `new-window`; assert URL, center heading and the Compose `→ {window}` label follow, and a Compose send lands in the new window (capture-pane). Reuse the existing e2e tmux helpers. <!-- R1 -->
- [x] T012 Run `just test-frontend`, `just test-e2e` (at minimum `external-switch-follow`, `sidebar-window-sync`, `window-switch-transition`, `window-heading`, `top-bar-refresh`, `quake-terminal`, `shortcut-registry`), and `cd app/frontend && npx tsc --noEmit`; fix regressions per Test Integrity (tests conform to the requirements above). <!-- R9 -->

### Phase 4: PR evidence

- [x] T013 Add `app/frontend/tests/demo/external-switch-follow.demo.ts`: open a non-active tab by deep link, switch tmux to a new window externally (as `rk riff` would), show heading + Compose label follow and a submitted line land in the new window. Record with `just demo external-switch-follow --before` (desktop + mobile) so ship can attach before/after. <!-- R1 -->

## Execution Order

- T001 blocks T002–T008; T003 blocks T004–T008.
- T009 after T003–T007 (deletions only once nothing references them).
- T010–T012 after Phase 2; T013 after T012.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: On the terminal route an external tmux window switch moves the URL, heading and Compose target to the new window whenever no overlay is live.
- [ ] A-002 R2: Every UI-initiated same-server switch (sidebar, palette, breadcrumb, SessionTiles, waiting target, alignment) starts an overlay and fires `selectWindow`; the overlay ends on confirm, post-settle snapshot, rejection or the 5 s deadline, and never on byte counting.
- [ ] A-003 R3: Rejection navigates to the SSE active window with the existing error toast; deadline ends silently.
- [ ] A-004 R4: Superseded seqs' settlements/deadlines are no-ops; server change, route leave and unmount end the overlay.
- [ ] A-005 R5: Closing a dialog re-runs the writeback.
- [ ] A-006 R6: The paint mask cannot outlive the deadline; mask/gate decisions never decide the URL.
- [ ] A-007 R7: `clearOnWindowChange` is true only for a live overlay matching `{server, windowParam}`.
- [ ] A-008 R8: Popout posture never aligns, writes back or starts an overlay.

### Behavioral Correctness

- [ ] A-009 R2: A sidebar click whose POST resolves before the confirming snapshot does not bounce the URL back to the previous window.
- [ ] A-010 R1: After a cold deep-link to a non-active tab, a subsequent `rk riff`/`tmux new-window` makes Compose send to the new window (the reported bug).

### Removal Verification

- [ ] A-011 R9: No references to `pendingClickRef`, `beginPendingSwitch`, `bouncePendingSwitch`, `clearPendingSwitchTracking`, `resolvePendingSwitchVerdict` remain in `app/frontend/src`; no orphaned exports or stale comments describing them.

### Scenario Coverage

- [ ] A-012 R2: `switch-overlay.test.ts` covers confirm, 200-before-snapshot, post-settle third window, mismatched 200, rejected, deadline, stale seq and cross-server identity.
- [ ] A-013 R1: `external-switch-follow.spec.ts` e2e passes via `just test-e2e`, with intent comments per the constitution.
- [ ] A-014 R1: Existing window-switch e2e specs (`sidebar-window-sync`, `window-switch-transition`, `window-heading`, `top-bar-refresh`, `quake-terminal`, `shortcut-registry`) pass.

### Edge Cases & Error Handling

- [ ] A-015 R2: A hanging `selectWindow` POST ends the overlay at 5 s (no infinite hold).
- [ ] A-016 R4: Same `@N` on a different server never confirms or suppresses the writeback.

### Code Quality

- [ ] A-017 Pattern consistency: New code follows naming and structural patterns of surrounding code (pure helpers in `lib/` with colocated tests).
- [ ] A-018 No unnecessary duplication: Existing utilities (`selectWindow`, window-transition paint helpers, toast) reused.
- [ ] A-019 Type narrowing over assertions: no new `as` casts in the overlay module or wiring.
- [ ] A-020 No client polling: freshness comes from SSE snapshot arrival, not `setInterval` + fetch.
- [ ] A-021 No magic numbers: the 5 s deadline is a named constant.
- [ ] A-022 No comment narration: comments state constraints/invariants only, cite no change IDs or PR numbers.
- [ ] A-023 Verification gates: `just test-frontend`, `npx tsc --noEmit`, and the e2e specs above pass; a `just demo` before/after recording exists for desktop and mobile.

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Overlay ends on the first post-settle session snapshot, not at POST settle | Verified at plan time: the client holds the pre-select snapshot until tmux's derive (~300 ms debounce) arrives, so ending at settle would bounce every click | S:85 R:75 A:90 D:85 |
| 2 | Confident | Use `currentSession`/`activeWindow` object identity as the "new snapshot" token, not `getServerReceiptTick` | The receipt tick bumps on every server-scoped event, not only sessions snapshots | S:70 R:80 A:75 D:70 |
| 3 | Confident | Extract the overlay into a pure `lib/switch-overlay.ts` with colocated tests | Matches the existing pure-helper pattern in `lib/window-transition.ts`; keeps app.tsx wiring thin and testable | S:65 R:85 A:80 D:75 |
| 4 | Confident | Reuse `CONFIRMATION_WINDOW_MS` (5000 ms) for the overlay deadline, which doubles as the paint-mask rescue | Existing named tunable; intake specified it | S:80 R:90 A:85 D:85 |
| 5 | Confident | New e2e spec + demo spec named `external-switch-follow` | One scenario, the reported bug; naming follows existing specs | S:60 R:90 A:75 D:70 |
| 6 | Confident | Keep `hasCountedIncomingBytes` only as a paint-gate test query; keep the receipt tick if other consumers remain | Removal limited to the pending-intent lock | S:65 R:85 A:75 D:70 |

6 assumptions (1 certain, 5 confident, 0 tentative).
