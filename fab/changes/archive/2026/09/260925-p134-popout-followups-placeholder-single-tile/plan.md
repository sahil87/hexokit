# Plan: Popout Follow-ups — Popped Placeholder, Full-Width Popout, Single-Tile Pop Out

**Change**: 260925-p134-popout-followups-placeholder-single-tile
**Intake**: `intake.md`

## Requirements

### Surface popout: popped placeholder and the toggle

#### R1: A popped leaf's toggle never writes the shared layout
When the top-bar surface toggle (or any other `togglePanel` caller: palette surface-toggle rows, focus-hop open-then-focus, tile chords) targets a kind whose close target — its first bare leaf in the shared layout — is in this viewer's popped set, the toggle MUST NOT call `applyLayout` / write `@rk_win_layout`. Instead it SHALL flip the leaf's membership in the viewer's **revealed** set (not revealed → revealed; revealed → not revealed). The function's boolean return MUST report `true` for a reveal (the surface is now on screen) and `false` for a hide, so focus-hop's open-then-focus flag stays truthful. Non-popped kinds keep today's `toggleSurface` semantics unchanged.

- **GIVEN** a 2-tile layout `h(tty,web)` with `tty` popped for this viewer
- **WHEN** the viewer clicks the top-bar Terminal toggle
- **THEN** no layout write occurs (the shared tree is still `h(tty,web)`), the `tty` popped mark survives, and the `tty` slot renders the popped placeholder
- **AND** a second click hides the placeholder again, still with no layout write

#### R2: Revealed set is per-viewer, ephemeral, and a subset of popped
The revealed set SHALL live as React state in the opener (`AppShell`), reset per `(server, @N)`, never persisted (no localStorage, no tmux). An id MUST leave the revealed set whenever it leaves `popped` (pop-in, `closed`, stale sweep, tree prune).

- **GIVEN** `tty` popped and revealed
- **WHEN** the popout closes (the `closed` message clears the mark)
- **THEN** `tty` is no longer revealed and renders its live surface

#### R3: Revealed popped leaves render a popped placeholder in their slot
The opener SHALL render `reducePopped(layout, popped − revealed)`. A leaf that is popped and revealed stays in the rendered tree and renders a popped placeholder INSTEAD of its surface: no tile header, no surface mount (a revealed tty opens no relay stream; a revealed code leaf mounts no frame; a revealed web leaf never creates a guest — the popout owns the live surface). The placeholder reuses `components/surface-placeholder.tsx` `SurfacePlaceholder` (generalised with a popout variant), reading "<Surface> is popped out" with the tty status dot, a **bring back** button, a **go to window** button, and **✕** only when the rendered tree has more than one leaf. `PoppedOutPlaceholder` (all-popped) renders only when the tree reduced by `popped − revealed` is empty.

- **GIVEN** `tty` popped and revealed in `h(tty,web)`
- **WHEN** the opener renders
- **THEN** the left slot shows "Terminal is popped out" with bring back / go to window / ✕, and no terminal relay stream is opened for it
- **AND** in a single-tile layout `tty` popped + revealed shows the popped placeholder without ✕ (not the all-popped placeholder)

#### R4: Placeholder verbs
**bring back** SHALL call the existing `popIn(leafId)`. **✕** SHALL only remove the leaf from the revealed set (never a layout close). **go to window** SHALL focus the live popout without reloading it:
- in a desktop shell with the popout channel (`canShellPopout()`): call `shellPopout(popoutUrl(server, windowId, leafId))` — main's dedupe focuses/restores the existing popout;
- in a browser: `window.open("", popoutWindowName(server, windowId, leafId))`; if the returned window's location is `about:blank` (no popout by that name existed), navigate it to `popoutUrl(...)`; call `focus()` on it. It MUST NOT call `window.open(popoutUrl, name)` against an existing popout (that navigates and reloads it).

- **GIVEN** a browser opener with a live `tty` popout
- **WHEN** the viewer clicks go to window
- **THEN** `window.open` is called with `""` and the popout's window name, and never with the popout URL

#### R5: The toggle shows a popped marker
The toggle group SHALL mark a surface whose close-target leaf is popped for this viewer, through the same channel as the away marker (the `away` predicate / `surface-away-*` affordance or a sibling `popped` predicate with its own testid), with a tooltip naming the popped state (e.g. `Terminal — popped out`). `open` for a popped kind reads true only while it is revealed.

- **GIVEN** `tty` popped and not revealed
- **WHEN** the top bar renders
- **THEN** the Terminal toggle is not pressed and carries the popped marker

### Shell stage: no sidebar column without a sidebar

#### R6: The stage reserves a sidebar column only when sidebar children exist
`components/shell/shell.tsx` SHALL compute `sidebarVisible = sidebarOpen && !zenActive && sidebarChildren != null`, so a Shell rendered without sidebar children (the popout posture) uses stage columns `0 1fr` with no column gap, mounts no aside and no resize handle.

- **GIVEN** `runkit-sidebar-open` is `true` and the Shell renders with `sidebarChildren={null}`
- **WHEN** the desktop stage renders
- **THEN** `gridTemplateColumns` is `0 1fr` and `columnGap` is `0`

#### R7: The sidebar chord is inert without a sidebar
When the Shell has no sidebar children, the ⌘B / ⇧Ctrl+B sidebar chord (`useSidebarKeyboardToggle`) MUST NOT call `setSidebarOpen` (it would write the shared `runkit-sidebar-open` preference from inside a popout).

- **GIVEN** a popout-posture Shell (no sidebar children) with `runkit-sidebar-open` = `true`
- **WHEN** the viewer presses the sidebar chord
- **THEN** `runkit-sidebar-open` is still `true`

### Desktop shell: popout dedupe per opener

#### R8: Shell popout dedupe matches the opener window
`app/desktop/src/popout.ts` `findPopoutWindow` SHALL match on `(openerWindowId, hostId, route)`, and `main.ts` `shell:popout` SHALL pass the sender's window id. A second opener window popping the same leaf on the same host opens its own popout.

- **GIVEN** a popout record `{openerWindowId: 1, hostId: "h", route: "/s/@3?pop=tty"}`
- **WHEN** window 2 on host `h` requests the same route
- **THEN** `findPopoutWindow` returns null (a new popout opens), while window 1 requesting it again returns the existing popout's id

### Surface popout: eligibility at any arity

#### R9: Pop out is offered at arity 1
The tile header's Pop out verb and the palette `Tile: Pop Out <Surface>` rows SHALL be offered regardless of the rendered tile count. The remaining gates stay: not the popout window itself, not mobile, fine pointer only, visible live tile (not a fullscreened gui tile, not a dead-home foreign tile), and `onPopOut` present (the caller keeps omitting it on mobile and in a shell without the `windows.popout` channel). At arity 1 the header shows Pop out alone (no zoom/✕ cluster). Popping the only tile out renders `PoppedOutPlaceholder` in the opener.

- **GIVEN** a single-tile desktop layout `tty` on a fine pointer in a browser
- **WHEN** the tile header renders
- **THEN** a `Pop out Terminal` button is present, with no Expand/Close buttons
- **AND** the palette offers `Tile: Pop Out Terminal`

### Specs & memory

#### R10: Spec and memory reflect the new contract
`docs/specs/surface-layout.md` § Verbs Pop out / Pop back in rows SHALL drop "Offered only above one rendered tile" and the stale "outside the desktop shell", and describe the popped placeholder + toggle reveal. Memory (hydrate): `run-kit/ui/lenses-and-layout.md` § Surface popout, `run-kit/desktop-shell.md` § Popout windows, `run-kit/ui/routes-and-shell.md` Shell stage grid.

- **GIVEN** the change is complete
- **WHEN** a reader consults the spec's Verbs table
- **THEN** the Pop out row states any-arity eligibility and the shell channel gate, and mentions the popped placeholder

### Non-Goals

- Tear-off (drag a header outside the window to pop out) — still deferred from change 6.
- Changing header drag / row-drag borrow / ▦ template gating while any leaf is popped — unchanged.
- Persisting the revealed set across reloads.

### Design Decisions

#### Popped placeholder reuses the borrow placeholder
**Decision**: A popped leaf the viewer asks to see renders `SurfacePlaceholder` (bring back · go to window · ✕) in its slot, revealed per viewer by the surface toggle; the toggle never closes a popped leaf.
**Why**: One "surface is live elsewhere" vocabulary for borrow and popout; the toggle's shared close from a viewer-only posture destroyed other viewers' layouts.
**Rejected**: Always rendering the placeholder instead of reflowing (wastes the space popping out frees); toggle-click = immediate pop back in (surprising, closes a window on a status click).
*Introduced by*: 260925-p134-popout-followups-placeholder-single-tile

#### Shell popout dedupe keys on the opener window
**Decision**: `findPopoutWindow` matches `(openerWindowId, hostId, route)`.
**Why**: The popout record's `openerWindowId` scopes the native web guest move and the pop-back-in return; a cross-opener dedupe hit handed window B window A's popout and stranded B's guest.
**Rejected**: Retargeting `openerWindowId` on a hit — B's own guest stays parked under B while the popout holds A's moved guest, so pop back in would double-park under B's identity.
*Introduced by*: 260925-p134-popout-followups-placeholder-single-tile

## Tasks

### Phase 1: Core Implementation

- [x] T001 [P] Shell stage: in `app/frontend/src/components/shell/shell.tsx` gate `sidebarVisible` on `sidebarChildren != null` (stage columns, column gap, aside and resize-handle mounts follow); thread a `hasSidebar`/`disabled` flag into `useSidebarKeyboardToggle` so the chord is a no-op without sidebar children. Add cases to `components/shell/shell.test.tsx` (columns `0 1fr`/gap `0` with open preference + null children; chord leaves `runkit-sidebar-open` untouched). <!-- R6 R7 -->
- [x] T002 [P] Desktop dedupe: change `findPopoutWindow` in `app/desktop/src/popout.ts` to take and match `openerWindowId`; update the `shell:popout` call site in `app/desktop/src/main.ts` to pass `opener.id`; extend `app/desktop/src/popout.test.ts` (same-opener hit, different-opener miss on the same host+route). Update the `popouts` map doc comment in `main.ts`. <!-- R8 -->
- [x] T003 [P] Single-tile Pop out: in `app/frontend/src/components/surface-layout.tsx` decouple `canPopOutTile` from `showVerbs`/arity (gate: `!popoutTile && !mobile && tile.visible && !(kind === "gui" && guiTileFullscreen) && !coarsePointer && onPopOut !== undefined && !(leafHome !== undefined && homeWindow === null)`) and render the Pop out button outside the `showVerbs && !popoutTile` block (separator only when the layout-verb cluster follows); fix the arity-rationale comments. In `app/frontend/src/lib/palette/layout.ts` drop `renderedArity > 1` for `Tile: Pop Out` rows and update the header comment. Tests: `lib/palette/layout.test.ts` (Pop Out row at arity 1), `components/surface-layout.test.tsx` (single-tile header shows `Pop out Terminal`, no Expand/Close; absent on coarse pointer / mobile). <!-- R9 -->
- [x] T004 Placeholder variant: generalise `app/frontend/src/components/surface-placeholder.tsx` `SurfacePlaceholder` with a variant (e.g. `variant: "away" | "popped"`, or a message + go-to label prop) so the popped form reads "<Surface> is popped out" with **bring back** / **go to window** buttons and optional ✕; keep the away form byte-identical in behavior (existing tests stay green). Add a colocated test for the popped variant. <!-- R3 R4 -->
- [x] T005 Focus helper: add `focusPopout(leafId)` to `usePoppedSet` in `app/frontend/src/hooks/use-popout.ts` (shell: `shellPopout(popoutUrl(...))`; browser: `window.open("", popoutWindowName(...))`, navigate an `about:blank` result to `popoutUrl(...)`, `focus()`), returned beside `popOut`/`popIn`. Tests in `hooks/use-popout.test.ts`: shell path calls `shellPopout`; browser path calls `window.open("", name)` and never `window.open(popoutUrl, name)`; about:blank result navigates. <!-- R4 -->
- [x] T006 Revealed set + reduction + render: in `app/frontend/src/app.tsx` add the per-`(server, @N)` revealed React state (pruned to `popped` on every popped change — R2), feed `reducePopped(layout, popped − revealed)` (and the `allPopped` derivation) and pass `revealed` ids into `SurfaceLayout` (new prop, e.g. `revealedPoppedIds`) with `onPopIn`, `onFocusPopout`, `onHidePopped` seams. In `app/frontend/src/components/surface-layout.tsx` render a revealed popped leaf like the away placeholder mount gate (no header, no surface mount, no hidden-tile retention entry for it) using the popped `SurfacePlaceholder` variant, ✕ only at arity > 1. <!-- R2 R3 R4 -->
- [x] T007 Toggle guard + marker: in `app/frontend/src/app.tsx` guard `togglePanel` — when the kind's close-target first bare leaf is popped, flip its revealed membership and return `true` on reveal / `false` on hide, never `applyLayout`; the `surfaceToggles` slot's `open` treats a popped kind as open only while revealed; add a popped predicate for the marker. In `app/frontend/src/components/top-bar.tsx` (+ `contexts/top-bar-slot-context.tsx` type) render the popped marker/tooltip (`<Surface> — popped out`, own testid `surface-popped-<surface>`), in both the bar buttons and the overflow rows where the away marker renders. Top-bar test for the marker. <!-- R1 R5 -->

### Phase 2: Integration & Edge Cases

- [x] T008 Regression test for the destructive toggle: a Vitest test at the lowest layer that reaches the guard (extract the guard's decision as a pure helper in `app/frontend/src/lib/popout.ts` or `lib/surface-layout.ts`, e.g. `popoutToggleAction(layout, surface, popped, revealed) → {kind:"reveal"|"hide", leafId} | null`, and unit-test it — plus wiring coverage if an app-level harness exists) proving: popped close target → no layout mutation, reveal then hide; non-popped → `null` (normal toggle); a kind with `web` popped but `web/2` not — decided by the FIRST bare leaf (the close target). Confirm the helper-level test fails against the pre-change behavior (i.e. the old path would call `toggleSurface`). <!-- R1 R2 -->
- [x] T009 Frontend e2e: extend `app/frontend/tests/e2e/surface-popout.spec.ts` (Test Intent Comments on every new `test()`): (a) single-tile tab → Pop out → opener shows the all-popped placeholder, popout opens; (b) 2 tiles, pop tty → click top-bar Terminal toggle → popped placeholder appears, the shared layout is unchanged (read `@rk_win_layout` via the rig's tmux helper or the sessions payload) → second click hides it → reveal again → bring back closes the popout and the terminal returns; (c) the popout page's tile left edge sits at the stage padding (no sidebar-width offset) with the sidebar preference open. Run with `just test-e2e surface-popout.spec` (check `--list` first). <!-- R1 R3 R6 R9 -->

### Phase 3: Polish

- [x] T010 Spec: update `docs/specs/surface-layout.md` § Verbs Pop out / Pop back in rows (~190–191) per R10 — minimal, factual edits. <!-- R10 -->

## Execution Order

- T004 and T005 block T006; T006 blocks T007; T007 blocks T008's wiring coverage; T009 runs after T001–T008.
- T001, T002, T003 are independent of each other and of T004–T008.

## Acceptance

### Functional Completeness

- [x] A-001 R1: A toggle (any `togglePanel` path) on a popped close-target leaf never calls `applyLayout`; it reveals, then hides, the popped placeholder
- [x] A-002 R2: The revealed set is React state only, reset per `(server, @N)`, and pruned to `popped` whenever a mark clears
- [x] A-003 R3: A revealed popped leaf renders the popped `SurfacePlaceholder` in its slot with no header and no surface mount; the all-popped placeholder renders only when `popped − revealed` empties the tree
- [x] A-004 R4: bring back → `popIn`; ✕ → hide only (rendered only at arity > 1); go to window → `shellPopout` in the shell, `window.open("", name)` (+ about:blank re-navigation) in a browser
- [x] A-005 R5: The toggle for a popped, unrevealed kind is not pressed and shows a popped marker + tooltip
- [x] A-006 R6: Shell stage columns are `0 1fr` with no gap, no aside, no resize handle when sidebar children are null
- [x] A-007 R7: The sidebar chord does not write `runkit-sidebar-open` without sidebar children
- [x] A-008 R8: `findPopoutWindow` matches on opener window + host + route, and `main.ts` passes the opener id
- [x] A-009 R9: Header Pop out and palette `Tile: Pop Out` rows are offered at arity 1; mobile / coarse / shell-without-channel / dead-home / fullscreen-gui gates remain
- [x] A-010 R10: The spec's Pop out / Pop back in rows state any-arity eligibility, the shell channel gate, and the popped placeholder

### Behavioral Correctness

- [x] A-011 R1: Non-popped kinds' toggle behavior is unchanged (existing toggle tests stay green)
- [x] A-012 R3: The away (borrow) placeholder's behavior and text are unchanged

### Scenario Coverage

- [x] A-013 R1: A unit test proves the popped-toggle guard decides reveal/hide with no layout mutation, and it fails under the old always-`toggleSurface` path
- [x] A-014 R9: e2e covers single-tile pop out → all-popped placeholder
- [x] A-015 R3: e2e covers pop tty → toggle → placeholder → bring back, with the shared layout unchanged
- [x] A-016 R6: e2e (or Vitest) covers the popout tile starting at the stage padding with the sidebar preference open

### Edge Cases & Error Handling

- [x] A-017 R1: Toggle close target is the kind's FIRST bare leaf — a popped `web` with an unpopped `web/2` reveals `web`'s placeholder, never closes `web/2`
- [x] A-018 R3: A revealed web leaf in a shell never creates a native guest in the opener (the popout keeps its moved guest)
- [x] A-019 R4: go to window in a browser with no live popout reopens it at `popoutUrl` instead of leaving an `about:blank` window

### Code Quality

- [x] A-020 Pattern consistency: New code follows the naming and structure of surrounding code (the away-placeholder mount gate, the `usePoppedSet` seam shape, the top-bar away-marker channel)
- [x] A-021 No unnecessary duplication: `SurfacePlaceholder` is generalised, not forked; the toggle guard is one pure helper shared by every `togglePanel` path
- [x] A-022 Type narrowing over `as` casts in new frontend code
- [x] A-023 No magic strings: new testids/labels follow the existing `surface-away-*` / `SURFACE_LABEL` conventions
- [x] A-024 No comment narration or change-ID citations in new comments
- [x] A-025 Tests: every behavior change has Vitest coverage; the UI changes have Playwright coverage in `surface-popout.spec.ts` with Test Intent Comments
- [x] A-026 Gates green: `npx tsc --noEmit`, `just test-frontend` (full), `cd app/desktop && pnpm run compile && pnpm test`, `just test-e2e surface-popout.spec`, `just test-e2e operator-compose.spec` (review re-ran the first four — all green; operator-compose's counted assertions filter to `Operator:` rows only, so the new `Tile: Pop Out` row at arity 1 cannot leak into them — verified by inspection of the spec)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The one inline casualty (the `renderedArity` local and the arity rationale in `lib/palette/layout.ts`) was removed by the change itself; `SurfacePlaceholder` was generalised in place (the away form is untouched), and `PoppedOutPlaceholder` remains the all-popped render.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `togglePanel` returns `true` on reveal and `false` on hide | Focus-hop's open-then-focus flag reads the boolean as "surface now on screen"; a reveal puts the placeholder on screen | S:55 R:85 A:75 D:70 |
| 2 | Confident | The toggle guard is extracted as a pure helper so it can be unit-tested and shared | `app.tsx` has no light harness for `togglePanel`; the lib/ pure-helper + thin wiring pattern is the codebase norm | S:60 R:90 A:80 D:75 |
| 3 | Confident | Popped marker uses its own testid `surface-popped-<surface>` beside the away marker's channel | Keeps the away marker's e2e contract untouched while reusing its visual slot | S:55 R:90 A:75 D:70 |
| 4 | Confident | At arity 1 the popped placeholder omits ✕ | ✕ at arity 1 would only swap it for the all-popped placeholder; mirrors `showClose={arity > 1}` | S:60 R:90 A:80 D:80 |
| 5 | Confident | The no-sidebar chord guard sits before `preventDefault`, so the chord is a true no-op (the event propagates) | "Inert" reads as fully transparent — swallowing the chord in a popout would block any other handler from seeing it | S:60 R:90 A:75 D:70 |
| 6 | Confident | `focusPopout` tolerates a blocked `window.open` (null) silently | Unlike `popOut` there is no optimistic mark to roll back and nothing to toast; nothing was attempted that needs undoing | S:65 R:85 A:75 D:70 |
| 7 | Confident | A revealed popped `code` leaf is excluded from the code-frame bookkeeping (`codeTileWindowIds`) while revealed | Without it, revealing would re-create the frame record the popped-eviction dropped and register the palette `Code:` seam against a placeholder; the popout owns the live frame while revealed | S:60 R:85 A:75 D:70 |
| 8 | Certain | Palette `Tile: Show/Hide` rows route through `togglePanel` via a new `onToggleSurface` option on `buildLayoutActions` (absent ⇒ legacy inline `addSurface`/`closeSurface` + `onApply`) | Plan assumption that palette rows "already funnel through `togglePanel`" was inaccurate — without the seam the destructive shared write stayed reachable from the palette | S:70 R:90 A:85 D:80 |

8 assumptions (1 certain, 7 confident, 0 tentative).
