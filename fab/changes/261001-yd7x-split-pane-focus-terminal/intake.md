# Intake: Split Pane Focuses the Terminal

**Change**: 261001-yd7x-split-pane-focus-terminal
**Created**: 2026-10-01

## Origin

> When I do Split Pane horizontally or vertically, currently it opens the terminal but that terminal is not focused. Can you check what the issue is and help me understand how we can fix it?

Conversational. The agent diagnosed the bug read-only and offered two fixes:
(1) route every split entry point through one shared split executor that also hands DOM
keyboard focus back to the terminal, or (2) `onMouseDown={e => e.preventDefault()}` on the
split buttons. The user chose **option 1** ("go ahead with option 1, /fab-ff") and asked that,
before any PR is opened, they get a way to test it; the PR opens only after their approval.

## Why

**The tmux side already works.** `handleWindowSplit` (`app/backend/api/windows.go:273`) runs
`split-window -d … -P -F '#{pane_id}'` then `SelectPane(paneID)` (`select-pane -t %N`, added in
#657 "Auto-Focus Split Pane"). Verified on a throwaway tmux server: the new pane `%1` becomes the
window's active pane. So keystrokes that reach the xterm DO land in the new pane.

**The browser side never hands keyboard focus back to the xterm.** Every split entry point
leaves DOM focus somewhere other than the terminal:

| Entry point | Location | Where DOM focus ends up |
|---|---|---|
| Board top-bar `SplitControl` (primary button + ▾ direction menu) | `app/frontend/src/components/top-bar.tsx:2595` | on the clicked `<button>` |
| Overflow-menu `SplitMenuRow` (terminal + board) | `top-bar.tsx:2935` | on the menu row / chevron |
| tty tile-header Split H / Split V buttons | `app/frontend/src/components/surface-layout.tsx:3580` | on the button — the tile's `onPointerDownCapture` → `focusLeafFromPointer` only updates the focused-LEAF highlight + focus memory, never `xterm.focus()` |
| Command palette `Split Horizontal/Vertical` + chords | `app/frontend/src/app.tsx:4126` → `executeSplit` (`app.tsx:2502`) | palette runs `closePalette(); action.onSelect()` and restores nothing → `<body>` |
| Board palette `Board: Split Focused Pane …` | `app/frontend/src/components/board/board-page.tsx:458,673` | `<body>` |
| Keyboard chord pressed from inside the xterm | same `executeSplit` | already fine (focus never left) |

Result: the user sees a new pane highlighted as active in tmux, but typing goes nowhere until
they click into the terminal. If not fixed, every split costs an extra click and breaks the
keyboard-first posture (Constitution V).

**Why option 1 over option 2:** `preventDefault` on mousedown only preserves focus that was
already on the xterm. It does nothing for the ▾ menu (opening it already moved focus to the
chevron) or the palette (focus is on the palette input), and nothing for a tile header click in a
tile whose terminal was not focused. A shared executor fixes every path in one place.

There are currently **four** independent `splitWindow` call sites, each with its own
`useOptimisticAction` + "Failed to split pane" toast: `app.tsx:2502` (`executeSplit`),
`board-page.tsx:458` (`executeSplit`), `top-bar.tsx` `SplitControl`, `top-bar.tsx` `SplitMenuRow`.
Patching focus into each would be four copies of the same fix.

## What Changes

### 1. `FocusedTerminal` gains a `focus` handle

`app/frontend/src/contexts/focused-terminal-context.tsx` — the existing root-level context
(`FocusedTerminalProvider`, mounted in `RootWrapper` ABOVE `TopBarSlotProvider`, so the top bar
can read it) that already tracks "the focused xterm" on BOTH routes:

- terminal route: `TerminalClient`'s `registerFocus` effect (`terminal-client.tsx:375`) — the
  surface layout passes `registerFocus` true for the FOCUSED tty tile (bare or foreign), or the
  primary bare tty while a non-tty tile is focused (`surface-layout.tsx:2829`).
- board route: `BoardPane`'s own registration effect (`board/board-pane.tsx:119`) for the focused
  pane (its inner `TerminalClient` uses `registerFocus={false}`).

Add a field to the `FocusedTerminal` type:

```ts
/** Hand DOM keyboard focus to this terminal's xterm. */
focus: () => void;
```

- `TerminalClient` registers `focus: () => xtermRef.current?.focus()` (the same body its
  `focusRef` seam installs at `terminal-client.tsx:692`).
- `BoardPane` registers `focus: () => focusFnRef.current?.()` (the same call its
  `useImperativeHandle` `focus()` already makes).

### 2. One shared split hook: `useSplitPane`

New file `app/frontend/src/hooks/use-split-pane.ts`:

```ts
export function useSplitPane() {
  const { focused } = useFocusedTerminal();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const isMobile = useIsMobile();
  const { addToast } = useToast();
  const { execute, isPending } = useOptimisticAction<[string, string, boolean, string | undefined]>({
    action: (server, windowId, horizontal, cwd) => splitWindow(server, windowId, horizontal, cwd),
    onError: (err) => addToast(err.message || "Failed to split pane"),
  });
  const split = useCallback((server, windowId, horizontal, cwd?) => {
    // Desktop only: auto-focus pops the mobile keyboard (the restore-router rule).
    if (!isMobile) focusedRef.current?.focus();
    execute(server, windowId, horizontal, cwd);
  }, [execute, isMobile]);
  return { split, isPending };
}
```

- Focus is handed over **synchronously at invoke**, before the API call — the xterm instance
  does not change on a split (tmux renders the new pane inside the same terminal), so there is
  nothing to wait for and no visible lag.
- The focused terminal is read through a ref so the call uses the live registration.
- The focus is a programmatic `xterm.focus()`; it does NOT write focus memory (the recording
  seams stay pointerdown/`onFocus`-only per `focus-ownership.md`).

### 3. Every split entry point routes through `useSplitPane`

- `app.tsx` — replace the `executeSplit` `useOptimisticAction` (line ~2502) with
  `const { split: executeSplit } = useSplitPane();`. This covers the palette `split-horizontal` /
  `split-vertical` actions + their chords (`app.tsx:4126–4136`) and the tile-header
  `onSplitPane` (`app.tsx:6462`).
- `board/board-page.tsx` — same replacement for its `executeSplit` (line ~458), covering the
  `board-split-horizontal` / `board-split-vertical` palette actions.
- `top-bar.tsx` `SplitControl` and `SplitMenuRow` — drop their local `useOptimisticAction` +
  toast and call `useSplitPane()` (SplitControl keeps its `isPending` spinner/disabled state
  from the hook's `isPending`).

### 4. Tile-header splits focus THAT tile's terminal

The tty tile header's Split H/V buttons live inside the tile whose `onPointerDownCapture`
(`surface-layout.tsx:3304`) runs `focusLeafFromPointer(leafId)` on pointerdown — that makes the
tile the focused leaf, so its `TerminalClient` becomes the `FocusedTerminal` registrant before
the `click` fires (React flushes discrete-event updates and their passive effects synchronously).
The shared hook therefore focuses the clicked tile's own terminal — including a foreign or
duplicate tty tile, which the `focusTerminalRef` seam (bound only to the primary bare tty) could
not reach. No per-leaf focus map is needed.

## Affected Memory

- `run-kit/ui/focus-ownership`: (modify) document that a split hands DOM focus to the focused
  terminal via the `FocusedTerminal.focus` handle (desktop only), and that it does not record
  focus memory.
- `run-kit/ui/top-bar`: (modify) SplitControl / SplitMenuRow route through the shared
  `useSplitPane` hook rather than owning their own `splitWindow` action.

## Impact

Frontend only — no backend or API change (`POST /api/windows/{id}/split` unchanged).

- `app/frontend/src/contexts/focused-terminal-context.tsx` — type field
- `app/frontend/src/components/terminal-client.tsx` — register `focus`
- `app/frontend/src/components/board/board-pane.tsx` — register `focus`
- `app/frontend/src/hooks/use-split-pane.ts` — new hook (+ a unit test)
- `app/frontend/src/app.tsx`, `app/frontend/src/components/board/board-page.tsx`,
  `app/frontend/src/components/top-bar.tsx` — call sites
- Tests that construct a `FocusedTerminal` literal (e.g. `focused-terminal-context.test.tsx`,
  `compose-strip`/`bottom-bar` tests) may need the new `focus` field; tests rendering
  `SplitControl`/`SplitMenuRow` need `FocusedTerminalProvider` in their wrapper if they don't
  already have it.

## Open Questions

- None blocking. (Whether an e2e spec should assert `document.activeElement` is the xterm
  helper textarea after a tile-header split is an apply-time call.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix is frontend-only; backend `select-pane` already makes the new pane active | Verified on a throwaway tmux server (`new=%1 active=%1`) | S:90 R:90 A:95 D:90 |
| 2 | Certain | Option 1 — one shared split executor that refocuses the terminal | Discussed — user chose option 1 over the mousedown-preventDefault option | S:95 R:80 A:90 D:90 |
| 3 | Confident | The shared focus target is a new `focus` field on the existing `FocusedTerminal` context, not `focusTerminalRef` | `focusTerminalRef` binds only the primary bare tty and is not reachable from the board or the top bar; `FocusedTerminal` already tracks the focused xterm on both routes and is mounted above the top bar | S:70 R:80 A:80 D:70 |
| 4 | Confident | Focus synchronously at invoke, before the API returns | Discussed — the xterm instance is unchanged by a split, so no reason to wait | S:85 R:90 A:85 D:85 |
| 5 | Confident | Skip the auto-focus on mobile | Existing rule (restore router, focus-ownership.md): auto-focus pops the mobile keyboard | S:60 R:90 A:85 D:80 |
| 6 | Confident | Tile-header split relies on the tile's pointerdown making it the focused registrant before click | React 18 flushes discrete updates + passive effects synchronously; avoids a per-leaf focus map | S:60 R:85 A:70 D:70 |
| 7 | Confident | The programmatic focus does not write focus memory | focus-ownership.md: recording seams are real-focus only (pointerdown / onFocus) | S:60 R:90 A:80 D:80 |
| 8 | Certain | Open no PR until the user has tested and approved | User instruction | S:95 R:95 A:95 D:95 |

8 assumptions (3 certain, 5 confident, 0 tentative, 0 unresolved).
