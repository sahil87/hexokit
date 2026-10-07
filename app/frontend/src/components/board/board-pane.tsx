import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { TerminalClient } from "@/components/terminal-client";
import { useFocusedTerminal } from "@/contexts/focused-terminal-context";
import { BOARD_PANE_MIN_WIDTH } from "@/hooks/use-pane-widths";
import { BoardHeader } from "./board-header";
import type { BoardEntry } from "@/api/boards";
import type { BoardPaneDragProps, BoardPaneDropProps } from "@/hooks/use-board-pane-reorder";

export interface BoardPaneHandle {
  focus: () => void;
}

interface BoardPaneProps {
  entry: BoardEntry;
  /**
   * Pane width in px. Optional — when omitted, the pane uses CSS sizing
   * (`w-full`) so the parent layout controls the width. Desktop row passes a
   * concrete number (resizable per-pane); mobile carousel omits it and lets
   * the wrapper's `w-full` drive the width, which keeps the pane reactive to
   * viewport changes (orientation/resize) without reading `window.innerWidth`
   * at render time.
   */
  width?: number;
  /**
   * Desktop autofit mode (738w). When `true`, the pane root becomes an
   * equal-share flex item (`flex: 1 1 0` + a `min-width` floor of
   * `max(BOARD_PANE_MIN_WIDTH, calc(25% - 4.5px))`) instead of using the pixel
   * `width` prop or the carousel's `w-full`. The `width` prop is ignored while
   * autofit is on, so the stored per-pane widths are never consulted (and the
   * caller keeps them untouched — non-destructive toggle). The `25% - 4.5px` floor
   * is gap-adjusted for the row's 6px stage gap (6px × 3 gaps ÷ 4 panes) so exactly 4
   * panes fit flush without a horizontal scrollbar; a 5th pane pushes the row
   * into horizontal scroll at the 25% floor. Desktop only — the mobile carousel
   * never passes it.
   */
  autofit?: boolean;
  paused?: boolean; // mobile carousel: when true, terminal is unmounted (WebSocket closes)
  isFocused: boolean;
  /** Attention overlay (260706-y1ar): when the joined window's rolled-up agent
   *  state is `waiting`, the pane gets a 3px pulsing yellow seam (static under
   *  reduced-motion — see globals.css `.rk-waiting-seam`). The board-pane form
   *  of the same additive attention signal the status-dot halo carries. */
  waiting?: boolean;
  /** When `true`, this pane is the drag source — dimmed (`opacity-50`) as
   *  drag-source feedback, matching the server/session reorder treatment. */
  dimmed?: boolean;
  onClick: () => void;
  onUnpin: () => void;
  /** The window's HOME session name (co9z), resolved by the parent from the
   *  sessions snapshot. Forwarded to BoardHeader for the `{session} › {window}`
   *  crumb; undefined → header falls back to `{window} · {server}`. */
  homeSession?: string;
  showResizeHandle: boolean;
  onResizeStart?: (clientX: number) => void;
  /** HTML5 drag-SOURCE props for the pane HEADER (the drag handle:
   *  draggable + onDragStart/onDragEnd). The pane body / terminal is never
   *  draggable — a live xterm must not hijack the drag or become the drag
   *  image. Omitted on mobile (carousel has no reorder). */
  dragHandleProps?: BoardPaneDragProps;
  /** HTML5 drop-TARGET props (onDragOver/onDrop) for the whole pane ROOT. Kept
   *  separate from the header handle so a release anywhere over the pane body
   *  commits the move — not only over the ~24px header strip (rework
   *  should-fix #1). Omitted on mobile. */
  dropTargetProps?: BoardPaneDropProps;
  /** When `true`, this pane's TerminalClient suppresses xterm focus on
   * touch/tap (long-press scroll-lock). Forwarded from the persisted
   * ChromeContext scroll-lock preference read by BoardPage. */
  scrollLocked?: boolean;
  /**
   * Optional callback ref to the pane's root DOM element. Distinct from the
   * imperative `BoardPaneHandle` (`forwardRef`, used for `focus()`): the
   * desktop row needs the actual element to observe with an
   * `IntersectionObserver` for visibility-driven relay suspension. Mobile does
   * not pass it. Kept separate so the imperative-handle contract is untouched.
   */
  rootRef?: (el: HTMLDivElement | null) => void;
}

/**
 * A single pane on the board: header + live xterm. Implements the BoardPaneHandle
 * imperative `focus()` so the parent can implement `Cmd+]` cycling without
 * threading focus state through every render.
 *
 * When `paused`, the TerminalClient is unmounted — its WebSocket closes per
 * the existing TerminalClient cleanup pattern (sync.Once on the relay side).
 * Re-mounting on swipe-in re-establishes the connection.
 */
export const BoardPane = forwardRef<BoardPaneHandle, BoardPaneProps>(function BoardPane(
  { entry, width, autofit = false, paused = false, isFocused, waiting = false, dimmed = false, onClick, onUnpin, homeSession, showResizeHandle, onResizeStart, scrollLocked, rootRef, dragHandleProps, dropTargetProps },
  ref,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const focusFnRef = useRef<(() => void) | null>(null);
  // The pane's root div, registered as the focused terminal's `containerRef`
  // (the element whose box visually IS the pane). Composed with the optional
  // `rootRef` callback.
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The pane registers itself as the focused terminal so the shell-level
  // `<BottomBar>` and the docked compose strip target it. The strip is a single
  // global component reading `focused.wsRef` live at send time (260718-dhdj) —
  // panes no longer render any per-pane compose surface.
  const { focused, setFocused } = useFocusedTerminal();

  useImperativeHandle(ref, () => ({
    focus() {
      focusFnRef.current?.();
    },
  }));

  // Register this pane as the BottomBar's focused input target whenever it
  // is the focused pane (parent sets `isFocused={idx === focusedIndex}`).
  // Click, cycle (Cmd+]/Cmd+[), and the initial pane on mount all flow
  // through this effect. We do NOT clear on focus loss — the next pane to
  // gain focus overwrites, which avoids a transient `null` state where the
  // BottomBar would briefly be inert. The inner `TerminalClient` is rendered
  // with `registerFocus={false}` (board panes opt out of the per-terminal
  // self-registration), so this pane-level effect is the single registration
  // path for board mode — no last-write-wins coordination required.
  useEffect(() => {
    if (!isFocused) return;
    setFocused({
      wsRef,
      containerRef,
      server: entry.server,
      session: entry.session,
      windowId: entry.windowId,
      windowName: entry.windowName,
      focus: () => focusFnRef.current?.(),
    });
  }, [isFocused, setFocused, entry.server, entry.session, entry.windowId, entry.windowName]);

  // Unmount cleanup: clear the focused terminal IFF it is still THIS pane
  // (mirrors terminal-client.tsx:139). Without this, leaving a board (board →
  // `/$server` tiles) leaves a stale non-null `FocusedTerminalContext` — the
  // enabled compose strip would render ACTIVE with the stale target label,
  // uploads would land in the stale (possibly other-server) worktree, and Enter
  // would no-op against the closed stream while clearing the draft.
  //
  // The registration effect above deliberately does NOT clear on focus loss (to
  // avoid a transient `null` during a pane cycle where a sibling pane
  // immediately re-registers). This cleanup is unmount-only (`[]` deps), so a
  // pane-focus SWITCH — which does not unmount the losing pane — never fires it;
  // it runs only when the pane truly leaves the tree. The still-mine guard reads
  // the live focused value through a ref so a newer sibling registration made
  // just before this unmount is not clobbered.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    return () => {
      if (focusedRef.current?.wsRef === wsRef) setFocused(null);
    };
  }, [setFocused]);

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        rootRef?.(el);
      }}
      role="group"
      aria-label={`board pane ${entry.windowName}${waiting ? " (agent waiting)" : ""}`}
      onClick={onClick}
      // Drop TARGET is the whole pane root (not just the header): onDragOver /
      // onDrop attach here so a release over the pane BODY still commits the
      // move. The drag SOURCE stays header-only (dragHandleProps below).
      {...dropTargetProps}
      // Border precedence: a `waiting` pane always shows the 3px pulsing yellow
      // seam (attention is the highest-priority signal); focus is still shown
      // via the green shadow ring layered on top, so a focused-AND-waiting pane
      // reads both. A non-waiting pane keeps the prior focus/idle border.
      className={`relative flex flex-col h-full bg-bg-primary ${
        // Card-family rounding is DESKTOP-only (the stage ground's card
        // vocabulary): autofit and fixed-width are both desktop layouts; the
        // mobile carousel (no width, no autofit) keeps its square full-bleed
        // pane untouched.
        autofit || width !== undefined ? "rounded-md" : ""
      } ${
        // Autofit: equal-share flex item (no `shrink-0`, no `w-full`, no pixel
        // width) — the flex + min-width in `style` below drives sizing. Non-
        // autofit desktop: fixed pixel width (`shrink-0`). Carousel: `w-full`
        // (`shrink-0`).
        autofit ? "" : width === undefined ? "shrink-0 w-full" : "shrink-0"
      } ${dimmed ? "opacity-50" : ""} ${
        waiting
          ? `border-[3px] rk-waiting-seam${isFocused ? " shadow-[0_0_0_1px_var(--color-accent-green)]" : ""}`
          : isFocused
            ? "border border-accent-green shadow-[0_0_0_1px_var(--color-accent-green)]"
            : // Suppress the unfocused `opacity-90` when this pane is the drag
              // source: Tailwind emits `.opacity-90` after `.opacity-50`, so
              // both present lets `.opacity-90` win and the drag dim disappears
              // for an unfocused source — the common case (cycle-2 should-fix
              // #1). `dimmed` (opacity-50) then stands alone.
              // The idle border is the dimmed 55% `rk-card-border` (the shared
              // gap-seam card treatment, 260814-011r R4) — `waiting`/focused
              // borders above stay full-strength (status signals, not chrome).
              `border rk-card-border${dimmed ? "" : " opacity-90"}`
      }`}
      // Autofit wins: an equal-share flex item with a gap-adjusted 25% floor
      // (resolves against the flex container's content box = the scrollport).
      // Otherwise the desktop pixel width, or nothing (carousel `w-full`).
      style={
        autofit
          ? { flex: "1 1 0", minWidth: `max(${BOARD_PANE_MIN_WIDTH}px, calc(25% - 4.5px))` }
          : width !== undefined
            ? { width }
            : undefined
      }
    >
      <BoardHeader entry={entry} onUnpin={onUnpin} homeSession={homeSession} dragHandleProps={dragHandleProps} />
      <div className="flex-1 min-h-0 px-1 py-0.5 flex flex-col">
        {!paused && (
          <TerminalClient
            sessionName={entry.session}
            windowId={entry.windowId}
            server={entry.server}
            wsRef={wsRef}
            focusRef={focusFnRef}
            registerFocus={false}
            scrollLocked={scrollLocked}
            // Boards mount many live terminals as preview surfaces (the full
            // view is one click away) — pin the small buffer, don't take the
            // device-split default.
            scrollback={1000}
          />
        )}
      </div>
      {showResizeHandle && onResizeStart && (
        <div
          aria-label="resize pane"
          onPointerDown={(e) => {
            e.preventDefault();
            onResizeStart(e.clientX);
          }}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-text-secondary/30 hidden coarse:hidden md:block"
        />
      )}
    </div>
  );
});
