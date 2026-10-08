# Plan: Overlay Presence Registry

**Change**: 260916-ter5-overlay-presence-registry
**Intake**: `intake.md`

## Requirements

### Frontend: overlay-presence registry module

#### R1: A pure module counts open occluding overlays per kind
`app/frontend/src/lib/overlay-presence.ts` SHALL export `OverlayKind = "modal" | "transient"`, `acquire(kind): () => void`, `count(kind?): number`, `isModalOpen(): boolean`, `subscribe(listener): () => void`, and `_resetForTests(): void`. The module MUST import nothing from React and touch no DOM, `window`, or storage.

- **GIVEN** a fresh module
- **WHEN** `acquire("modal")` is called twice and one release runs
- **THEN** `count("modal")` is 1, `count()` is 1, and `isModalOpen()` is true
- **AND** after the second release `count("modal")` is 0 and `isModalOpen()` is false

#### R2: Release is idempotent and the count never goes negative
The function returned by `acquire` MUST decrement exactly once; a second call is a no-op. `count` MUST never return a negative number.

- **GIVEN** one `acquire("modal")`
- **WHEN** its release is called twice
- **THEN** `count("modal")` is 0, not −1

#### R3: Only `modal` feeds the hide signal
`isModalOpen()` SHALL be `count("modal") > 0`; a held `transient` alone leaves it false. `transient` is counted and subscribable but has no call sites in this change.

- **GIVEN** `acquire("transient")` only
- **WHEN** `isModalOpen()` is read
- **THEN** it is false while `count("transient")` is 1 and `count()` is 1

#### R4: Subscribers are notified on every change and can unsubscribe
`subscribe(cb)` SHALL call `cb()` synchronously after each acquire and each effective release (no payload), return an unsubscribe, and tolerate unsubscribing from inside a notification.

- **GIVEN** a subscriber
- **WHEN** an overlay is acquired and released
- **THEN** the subscriber fires twice
- **AND** after unsubscribing a further acquire does not fire it

### Frontend: `useOccludes` hook

#### R5: `useOccludes(kind, open)` holds a registration while `open`
`app/frontend/src/hooks/use-occludes.ts` SHALL export `useOccludes(kind: OverlayKind, open: boolean): void` that acquires when `open` becomes true and releases when `open` becomes false or the component unmounts. Under React StrictMode's effect double-invocation the settled count MUST be 1.

- **GIVEN** a component calling `useOccludes("modal", open)`
- **WHEN** it renders with `open: true`, rerenders with `open: false`, then unmounts
- **THEN** `count("modal")` reads 1, then 0, then 0

### Frontend: modal-class overlays register

#### R6: Every modal-class overlay registers `modal` while open
The following surfaces SHALL call `useOccludes("modal", <predicate>)` (the hook call MUST precede any early `return null`): `command-palette.tsx` (`open`), `dialog.tsx` (`true` while mounted — covers all 19 consumers, including the settings panel inside `SettingsDialog`), `theme-selector.tsx` (`open`), `cron-entry-detail-sheet.tsx` (`!inline`), `quake-terminal.tsx` (`open`, the drawer mount flag), `screen-break.tsx` `ScreenBreak` (`flight !== null`), `shell/shell.tsx` `Shell` (`drawerActive`), and `app.tsx` `AppShell` (`showColorPicker !== null` — the color picker's bespoke modal shell with a full backdrop; the inline `SwatchPopover` mounts stay unregistered).

- **GIVEN** the registry is reset and the command palette is closed
- **WHEN** ⌘K opens it
- **THEN** `count("modal")` is 1
- **AND** closing it (⌘K again or Escape) returns the count to 0

- **GIVEN** a `<Dialog>` mounts
- **WHEN** it is rendered and later unmounted
- **THEN** `count("modal")` is 1 while mounted and 0 after

#### R7: Transient popovers do not register
`tip.tsx`, `sidebar/row-flyout-card.tsx`, `sidebar/marker-pad.tsx`, `sidebar/pin-popover.tsx`, `swatch-popover.tsx`, `theme-picker-list.tsx`, `compose-history-flyout.tsx`, status-bar and top-bar menus, `compose-strip.tsx`, and the `inline` cron sheet variant SHALL NOT call the hook in this change.

- **GIVEN** the inline cron sheet is rendered
- **WHEN** `count("modal")` is read
- **THEN** it is 0

### Frontend: toast placement

#### R8: Toasts anchor over the status bar on desktop, never on the stage or the top bar
`ToastContainer` in `toast.tsx` SHALL anchor `fixed bottom-1 right-2` on desktop (over the status bar's right end) and keep `fixed bottom-4 right-4` on mobile (`useIsMobile()` — no status bar and no native view there); `role="alert"`, `aria-live`, the 4 s timer, variants, action button and `onDismiss` are unchanged. The stack MUST NOT sit over the top bar, whose controls (the overflow chevron in particular) must stay hit-testable at every width. A comment states the constraint (a native web view paints over the stage) without history.

- **GIVEN** a toast is added
- **WHEN** the container renders
- **THEN** on desktop its class list contains `bottom-1` and `right-2` and no `top-` anchor; on mobile it contains `bottom-4 right-4`
- **AND** every existing toast behavior test still passes

### Frontend: no behavior change for current viewers

#### R9: The registry is inert without a subscriber
No component SHALL read the registry to change rendering in this change; the iframe engine ignores it. `npx tsc --noEmit`, the full `just test-frontend`, and the e2e smoke specs `sort-windows.spec` (palette-driven — no `command-palette.spec` exists), `operator-compose.spec` and `settings-dialog.spec` MUST pass.

- **GIVEN** the change applied
- **WHEN** the three e2e smoke specs run
- **THEN** they pass without intent-comment edits

### Non-Goals

- Any consumer of the signal beyond `subscribe`/`isModalOpen` — the native engine (change 3f) is the first reader.
- Clipping geometry for transient overlays and `transient` call sites — change 4.
- Any desktop (`app/desktop`) or backend change.

### Design Decisions

#### Overlay presence is a count, not a focus read
**Decision**: A module-level counter of mounted occluding overlays (per kind) with a synchronous subscription is the single "an overlay is open" signal.
**Why**: Focus is stolen by iframes and native views, so a focus read lies exactly when the signal is needed; nested modals (a create dialog over a detail sheet, a confirm inside the quake drawer) need a count, not a boolean; module state needs no provider above the independently mounted palette, dialog, drawer and toast trees and is readable from non-React bridge code.
**Rejected**: A focus/`activeElement` read (stolen by embedded frames); scraping `[role="dialog"]` from the DOM (misses the screen-break layer and the mobile drawer backdrop, double-counts nested dialogs); a React context (needs a provider spanning trees that mount separately).
*Introduced by*: 260916-ter5-overlay-presence-registry

#### Toasts live over chrome
**Decision**: On desktop the toast stack anchors bottom-right over the status bar's right end; on mobile it stays at the stage's bottom-right corner.
**Why**: A toast is not modal-class (it must not blank the page for 4 s) and clipping the guest around it reflows the page. Every part of the top bar is interactive — a toast there blocks the overflow chevron, the gear and the heading for its whole life (the `top-bar-overflow` e2e contract caught this). The status bar's right end is the least interactive chrome; a toast straddles a few pixels into the stage there, which is the cheapest overlap available. Mobile has no status bar and no native view, so the stage corner costs nothing.
**Rejected**: Top-right over the top bar (blocks the right cluster; failed the chevron hit-test); the top bar's center (the rename heading, the switcher and the quake launcher live there, and the center collapses below `sm`); registering toasts as `modal` (hides the page on every notification); clipping (change 4's transient rule, and it reflows).
*Introduced by*: 260916-ter5-overlay-presence-registry

## Tasks

### Phase 1: Setup

- [x] T001 Create `app/frontend/src/lib/overlay-presence.ts` (kinds, per-kind counts, idempotent release, `count`, `isModalOpen`, `subscribe`, `_resetForTests`) with `overlay-presence.test.ts` covering R1–R4 <!-- R1 R2 R3 R4 -->
- [x] T002 Create `app/frontend/src/hooks/use-occludes.ts` with `use-occludes.test.tsx` (renderHook: acquire on open, release on close/unmount, re-acquire, StrictMode settles at 1) <!-- R5 -->

### Phase 2: Core Implementation

- [x] T003 [P] Register the palette: `useOccludes("modal", open)` in `command-palette.tsx` before its early return; add a `command-palette.test.tsx` case asserting `count("modal")` 1 while open, 0 after close <!-- R6 -->
- [x] T004 [P] Register the dialog primitive: `useOccludes("modal", true)` in `dialog.tsx`; add a `dialog.test.tsx` case (1 while mounted, 0 after unmount); grep-verify `SettingsAllPanel` has no mount outside `SettingsDialog` <!-- R6 -->
- [x] T005 [P] Register the bespoke modals: `theme-selector.tsx` (`open`) and `cron-entry-detail-sheet.tsx` (`!inline`); add cases in `theme-selector.test.tsx` and `cron-entry-detail-sheet.test.tsx` (modal variant registers, inline variant does not — R7) <!-- R6 R7 -->
- [x] T006 [P] Register the quake drawer: `useOccludes("modal", open)` in `quake-terminal.tsx`; add a `quake-terminal.test.tsx` case around open/close <!-- R6 -->
- [x] T007 [P] Register the screen-break egg: `useOccludes("modal", flight !== null)` in `ScreenBreak` before its early return; add a `screen-break.test.tsx` case (1 during the flight, 0 after finish/unmount) <!-- R6 -->
- [x] T008 [P] Register the mobile drawer: `useOccludes("modal", drawerActive)` in `shell/shell.tsx`; add a `shell.test.tsx` case (mobile+open registers, desktop open does not) <!-- R6 -->
- [x] T009 [P] Move the toast stack in `toast.tsx` to `fixed bottom-1 right-2` on desktop (over the status bar) and keep `bottom-4 right-4` on mobile via `useIsMobile()`, with the constraint comment; add `toast.test.tsx` class assertions for both form factors <!-- R8 -->

### Phase 3: Integration & Edge Cases

- [x] T010 Run `cd app/frontend && npx tsc --noEmit` and `just test-frontend`; fix any failure <!-- R9 -->
- [x] T012 Register the color picker's modal mount: `useOccludes("modal", showColorPicker !== null)` in `app.tsx` `AppShell` beside its state (review should-fix — the mount carries a full backdrop and had slipped the inventory); add `data-testid="toast-stack"` to `ToastContainer` and read it in `toast.test.tsx` (review nice-to-have) <!-- R6 R8 -->
- [x] T011 Run the e2e smoke specs one per invocation — `just test-e2e "e2e/sort-windows.spec"` (palette-driven; no `command-palette.spec` exists), `just test-e2e "e2e/operator-compose.spec"` (dialog + toasts), `just test-e2e "e2e/settings-dialog.spec"`; fix any failure <!-- R9 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `lib/overlay-presence.ts` exports the five functions and the `OverlayKind` type, imports no React, and its Vitest passes
- [x] A-002 R5: `hooks/use-occludes.ts` acquires while `open` and releases on close and unmount; its Vitest passes
- [x] A-003 R6: All seven surfaces (palette, dialog primitive, theme selector, cron sheet modal variant, quake drawer, screen-break, mobile drawer) call `useOccludes("modal", …)` with the hook above any early return
- [x] A-004 R8: `ToastContainer` carries `fixed bottom-1 right-2` on desktop and `bottom-4 right-4` on mobile, never a `top-` anchor; `top-bar-overflow.spec` passes

### Behavioral Correctness

- [x] A-005 R2: Double release leaves the count at 0 (test present)
- [x] A-006 R3: A held `transient` leaves `isModalOpen()` false (test present)
- [x] A-007 R4: Subscribers fire on acquire and release and stop after unsubscribe (test present)
- [x] A-008 R7: No transient popover or the inline cron sheet calls the hook

### Scenario Coverage

- [x] A-009 R6: One RTL assertion per registering component proves `count("modal")` goes 1 → 0 around open/close (palette, dialog, theme selector, cron sheet, quake drawer, screen-break, shell drawer)
- [x] A-010 R9: `npx tsc --noEmit`, `just test-frontend`, and the three e2e smoke specs pass

### Edge Cases & Error Handling

- [x] A-011 R5: StrictMode double-invocation settles `count("modal")` at 1 (test present)
- [x] A-012 R4: Unsubscribing inside a notification does not throw or skip other listeners

### Code Quality

- [x] A-013 Pattern consistency: the module mirrors the in-module pub/sub idiom (`screen-break-store.ts`, `use-local-storage-boolean.ts`); hook calls are one line with an import
- [x] A-014 No unnecessary duplication: no second registry, context, or DOM scrape is introduced
- [x] A-015 Type narrowing over assertions: no `as` casts added
- [x] A-016 Comment rule: comments state constraints (why toasts leave the stage; why the count, not focus), never history or change IDs
- [x] A-017 Tests accompany every behavior change (module, hook, each registering component, toast placement)
- [x] A-018 R6: The `app.tsx` color-picker modal mount registers via the same hook (**N/A** for a colocated unit test — `AppShell` has no unit harness; covered by `tsc`, the hook's own tests, and the identical one-line pattern)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. (The quake drawer's settle-time `[role="dialog"]` DOM scrape at `app/frontend/src/components/quake-terminal.tsx:667-684` overlaps in spirit but not in semantics — it also matches transient `role="dialog"` popovers that deliberately do not register — so the registry does not subsume it.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Per-kind counts as two integers behind a `Map`, `count()` sums | Intake API; trivially reversible | S:90 R:95 A:95 D:90 |
| 2 | Confident | Listeners are iterated over a snapshot so an unsubscribe mid-notify is safe | Standard pub/sub hygiene; `screen-break-store` precedent | S:70 R:95 A:90 D:85 |
| 3 | Confident | Component tests read the real module after `_resetForTests()` rather than mocking it | Intake assumption 10; proves import wiring | S:65 R:95 A:85 D:75 |
| 4 | Confident | The cron sheet registers on `!inline` for its whole mount (it has no separate open flag) | The modal variant is mounted only while open, like `Dialog` | S:70 R:95 A:90 D:85 |

4 assumptions (1 certain, 3 confident, 0 tentative).
