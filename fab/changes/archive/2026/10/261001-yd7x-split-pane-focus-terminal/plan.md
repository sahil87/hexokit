# Plan: Split Pane Focuses the Terminal

**Change**: 261001-yd7x-split-pane-focus-terminal
**Intake**: `intake.md`

## Requirements

### UI: Focused-terminal handle

#### R1: The focused-terminal registration carries a focus handle
`FocusedTerminal` (`app/frontend/src/contexts/focused-terminal-context.tsx`) SHALL carry a
`focus?: () => void` field (optional only so test fixtures can omit it) that hands DOM keyboard focus to that terminal's xterm. Every
registrant MUST supply it: `TerminalClient` (`xtermRef.current?.focus()`) and `BoardPane`
(`focusFnRef.current?.()`).

- **GIVEN** a terminal route with a focused tty tile
- **WHEN** a consumer calls `useFocusedTerminal().focused?.focus()`
- **THEN** `document.activeElement` is inside that tile's `.xterm`

### UI: Shared split executor

#### R2: One shared split hook
A single hook `useSplitPane()` (`app/frontend/src/hooks/use-split-pane.ts`) SHALL own the
split action: it calls `splitWindow(server, windowId, horizontal, cwd)` through
`useOptimisticAction`, toasts `err.message || "Failed to split pane"` on failure, and returns
`{ split, isPending }`.

- **GIVEN** the split API rejects
- **WHEN** `split(...)` is called
- **THEN** a "Failed to split pane" (or the server's message) toast is shown

#### R3: A split hands keyboard focus to the focused terminal, synchronously
`split(...)` SHALL call the live `FocusedTerminal.focus()` synchronously at invoke — before the
API call resolves — read through a ref so it uses the current registration. It MUST NOT write
focus memory.

- **GIVEN** focus is on a split button (or the palette input, or `<body>`)
- **WHEN** a split is invoked
- **THEN** focus moves to the focused terminal's xterm in the same tick, before the POST settles
- **AND** keystrokes typed afterwards land in the newly split (tmux-active) pane

#### R4: No auto-focus on mobile
On a mobile viewport (`useIsMobile()` — narrow OR coarse pointer) `split(...)` SHALL NOT move
focus (auto-focus pops the mobile keyboard — the restore-router rule); it still splits.

- **GIVEN** a mobile viewport
- **WHEN** a split is invoked from the overflow menu or palette
- **THEN** the split happens and the focused terminal's `focus` is not called

#### R5: Every split entry point routes through the shared hook
All split entry points SHALL use `useSplitPane().split`; no other `splitWindow` caller remains
in components: `app.tsx` `executeSplit` (palette `split-horizontal`/`split-vertical` + chords +
the tty tile-header `onSplitPane`), `board/board-page.tsx` `executeSplit` (board palette
actions), `top-bar.tsx` `SplitControl` (keeps its pending spinner/disabled state from the hook's
`isPending`) and `SplitMenuRow`.

- **GIVEN** the tty tile header's Split pane horizontally button
- **WHEN** the user clicks it
- **THEN** the window gains a pane and `document.activeElement` is inside that tile's `.xterm`

### Non-Goals

- Backend changes — `POST /api/windows/{id}/split` already `select-pane`s the new pane.
- Recording `tty` focus memory on a programmatic split focus.
- A per-leaf focus map — the tile's pointerdown already makes the clicked tile the focused
  registrant before its click fires.

### Design Decisions

#### Split focus rides the FocusedTerminal registration
**Decision**: the shared split hook focuses whatever `FocusedTerminal` currently names, via a new `focus` handle on that registration.
**Why**: it is the one seam that already tracks "the focused xterm" on both the terminal route (focused bare/foreign tty tile, else the primary tty) and the board (focused pane), and it is mounted above the top bar.
**Rejected**: `focusTerminalRef` (binds only the primary bare tty, unreachable from board/top bar); `onMouseDown` preventDefault on buttons (cannot recover focus already lost to the ▾ menu or the palette).
*Introduced by*: 261001-yd7x-split-pane-focus-terminal

## Tasks

### Phase 1: Setup

- [x] T001 Add `focus: () => void` to `FocusedTerminal` in `app/frontend/src/contexts/focused-terminal-context.tsx`; register it in `app/frontend/src/components/terminal-client.tsx` and `app/frontend/src/components/board/board-pane.tsx` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Create `app/frontend/src/hooks/use-split-pane.ts` (split + toast + sync focus via ref, mobile-gated) with `app/frontend/src/hooks/use-split-pane.test.tsx` (focus called before the API resolves; not called on mobile; error toast) <!-- R2 R3 R4 -->

### Phase 3: Integration & Edge Cases

- [x] T003 Route `app/frontend/src/app.tsx` and `app/frontend/src/components/board/board-page.tsx` `executeSplit` through `useSplitPane` <!-- R5 -->
- [x] T004 Route `SplitControl` and `SplitMenuRow` in `app/frontend/src/components/top-bar.tsx` through `useSplitPane`; keep `top-bar.test.tsx` green <!-- R5 -->
- [x] T005 Add an e2e test to `app/frontend/tests/e2e/surface-layout.spec.ts`: tile-header split → pane count 2, `document.activeElement` in `.xterm`, typed text lands in the new pane <!-- R3 R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `FocusedTerminal` has a `focus` field and both real registrants supply it
- [x] A-002 R2: `useSplitPane` is the only component-level owner of `splitWindow` + the split error toast
- [x] A-003 R3: `split` calls `focus()` synchronously before the API promise settles
- [x] A-004 R4: `split` skips `focus()` when `useIsMobile()` is true
- [x] A-005 R5: `app.tsx`, `board-page.tsx`, `SplitControl`, `SplitMenuRow` all call `useSplitPane().split`

### Scenario Coverage

- [x] A-006 R3: unit test proves focus is called before the API resolves and not on mobile
- [x] A-007 R5: e2e proves a tile-header split leaves `document.activeElement` inside `.xterm` and keystrokes reach the new pane

### Edge Cases & Error Handling

- [x] A-008 R2: a failed split still toasts; focus having moved is harmless

### Code Quality

- [x] A-009 Pattern consistency: new hook mirrors `hooks/` conventions (named export, colocated test)
- [x] A-010 No unnecessary duplication: the four duplicated split actions collapse into one
- [x] A-011 Type narrowing over assertions: no new `as` casts
- [x] A-012 Comments state constraints only — no narration, no change IDs

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None outstanding — the change's own diff already deleted the four per-call-site split executors it made redundant (the `useOptimisticAction`-wrapped `splitWindow` blocks in `app/frontend/src/app.tsx`, `app/frontend/src/components/board/board-page.tsx`, and `app/frontend/src/components/top-bar.tsx` `SplitControl`/`SplitMenuRow`, plus their now-unused `splitWindow` imports); no remaining code was made redundant without removal.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Hook lives in `hooks/use-split-pane.ts` with a colocated test | Matches the `hooks/` directory convention (`use-optimistic-action.ts`, etc.) | S:70 R:90 A:85 D:80 |
| 2 | Confident | The e2e goes in `surface-layout.spec.ts`, which already owns the pane-segment tests | Existing home for tile-header pane verbs | S:65 R:90 A:80 D:75 |
| 3 | Confident | `SplitControl` keeps its spinner via the hook's `isPending` | Preserves existing behavior; the hook already exposes it | S:70 R:90 A:85 D:85 |

3 assumptions (0 certain, 3 confident, 0 tentative).
