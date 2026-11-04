import { useEffect, useMemo, useRef, useState } from "react";
import { INPUT_FOCUS } from "@/components/controls";
import { ValidBoardName } from "@/components/board/board-name";
import type { BoardSummary } from "@/api/boards";
import { usePinActions } from "@/hooks/use-pin-actions";
import { useOccludes } from "@/hooks/use-occludes";
import {
  orderBoardsLastUsedFirst,
  readLastPinnedBoard,
} from "@/lib/last-pinned-board";

/** Cold-start default board name — agreed in the change scope. Pre-filled
 *  (text selected) when zero boards exist so a bare Enter pins to a new board
 *  `main` without the user inventing a name. `ValidBoardName` accepts it. */
const DEFAULT_BOARD_NAME = "main";

type PinPopoverProps = {
  /** Server scope for the pin (per server-routing contract). */
  server: string;
  /** Tmux window-id (`@N` form). */
  windowId: string;
  /** All known boards (used to render existing rows). */
  boards: BoardSummary[];
  /** True while the board list is still being fetched. Suppresses the
   *  cold-start prefill so an empty `boards` mid-load is not mistaken for a
   *  genuine zero-board state (which would wrongly prefill/pin to `main`). */
  boardsLoading?: boolean;
  /** Predicate: is this window already pinned to the given board? */
  isPinnedTo: (board: string) => boolean;
  /** The single board this window is pinned to (co9z), or undefined. When set,
   *  a "Go to {board}" navigation row is offered at the top of the popover so
   *  the pinned-row indicator becomes a path to the owning board. */
  pinnedBoard?: string;
  /** Navigate to a board's route (`/board/{board}`). */
  onNavigateToBoard?: (board: string) => void;
  onClose: () => void;
};

/**
 * Sidebar pin popover. Lists existing boards (with a check when the current
 * window is already pinned to that board — clicking toggles pin/unpin), plus
 * an inline text input "Pin to new board…" that creates a new board on Enter
 * or via the adjacent Pin button (the mouse-only submit path — without it the
 * cold-start `main` prefill is Enter-only).
 *
 * Validation errors render inline. Closes on Escape or outside-click.
 */
export function PinPopover({ server, windowId, boards, boardsLoading = false, isPinnedTo, pinnedBoard, onNavigateToBoard, onClose }: PinPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Cold start = zero boards KNOWN to exist. Gated on `!boardsLoading` so the
  // empty `boards` seen mid-fetch (boards may still exist on the server) does
  // NOT trigger the `main` prefill — otherwise a bare Enter before the list
  // loads would pin to / create a new board `main` unintentionally.
  const coldStart = !boardsLoading && boards.length === 0;
  // Pre-fill `main` on cold start so bare Enter pins to a new board (1a); the
  // input stays empty when boards already exist (placeholder path unchanged).
  const [newName, setNewName] = useState(coldStart ? DEFAULT_BOARD_NAME : "");
  const [error, setError] = useState<string | null>(null);
  const { pin, unpin } = usePinActions();

  // Mounts only while open, so the registration is unconditional — popovers
  // hold `transient` (overlay-presence) so a native guest composited above
  // the DOM hides and the popover never paints underneath it.
  useOccludes("transient", true);

  // Last-used board, read once when the popover opens (a per-client preference,
  // stable for the popover's lifetime). Order the existing-board list with a
  // live last-used board first (a stale value is ignored). The Enter-target for
  // an empty input is that live last-used board.
  const lastUsed = useMemo(() => readLastPinnedBoard(), []);
  const orderedBoards = useMemo(
    () => orderBoardsLastUsedFirst(boards, lastUsed),
    [boards, lastUsed],
  );
  const emptyEnterTarget =
    !coldStart && lastUsed && boards.some((b) => b.name === lastUsed)
      ? lastUsed
      : null;

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  // Close on outside click — defer attach so the click that opened the popover
  // isn't itself the closer.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Autofocus the inline input. On cold start the pre-filled `main` is selected
  // so any keystroke replaces it (invent-a-name path preserved) while bare
  // Enter pins to `main`.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (coldStart) el.select();
  }, [coldStart]);

  async function handleToggleExisting(boardName: string) {
    setError(null);
    if (isPinnedTo(boardName)) {
      await unpin(server, windowId, boardName);
    } else {
      await pin(server, windowId, boardName);
    }
    onClose();
  }

  async function handleSubmitNew() {
    const trimmed = newName.trim();
    if (!trimmed) {
      // Empty input + a valid last-used board → pin to it (1b). Otherwise a
      // no-op (current behavior). Unreachable on cold start (input pre-filled).
      if (emptyEnterTarget) {
        setError(null);
        await pin(server, windowId, emptyEnterTarget);
        onClose();
      }
      return;
    }
    if (!ValidBoardName(trimmed)) {
      setError("Board name must be alphanumeric, hyphen, or underscore (1–32 chars).");
      return;
    }
    setError(null);
    await pin(server, windowId, trimmed);
    onClose();
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Pin tab to board"
      className="absolute right-0 top-full z-50 mt-1 bg-bg-primary border border-border rounded-md shadow-lg py-1 min-w-[160px] max-w-[220px]"
    >
      {/* Navigation affordance (co9z): when this window is pinned to a board,
          offer a direct link to that board's route. Makes the pinned-row pin
          indicator a path to the owning board (keyboard-reachable within the
          popover). */}
      {pinnedBoard && onNavigateToBoard && (
        <>
          <button
            type="button"
            onClick={() => {
              onNavigateToBoard(pinnedBoard);
              onClose();
            }}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left text-accent hover:bg-bg-card/50 transition-colors"
          >
            <span className="truncate">Go to {pinnedBoard}</span>
            <span aria-hidden="true">→</span>
          </button>
          <div className="border-t border-border my-1" />
        </>
      )}
      {boards.length > 0 && (
        <ul className="flex flex-col">
          {orderedBoards.map((b) => {
            const pinned = isPinnedTo(b.name);
            // Mark the Enter target (the live last-used board, rendered first)
            // so the empty-input Enter destination is visible.
            const isEnterTarget = b.name === emptyEnterTarget;
            return (
              <li key={b.name}>
                <button
                  type="button"
                  onClick={() => handleToggleExisting(b.name)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-0.5 min-h-[24px] coarse:min-h-[36px] text-xs text-left text-text-primary hover:bg-bg-card/50 transition-colors"
                >
                  <span className="truncate">{b.name}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {isEnterTarget ? (
                      <span
                        className="text-text-secondary text-xs"
                        aria-label="press Enter to pin here"
                      >
                        ↵
                      </span>
                    ) : null}
                    {pinned ? (
                      <span className="text-accent-green text-xs" aria-label="pinned">
                        ✓
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {boards.length > 0 && <div className="border-t border-border my-1" />}
      <div className="px-1.5 pb-1">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmitNew();
              }
            }}
            placeholder="Pin to new board..."
            aria-label="Pin to new board"
            className={`w-full min-w-0 flex-1 bg-transparent text-xs text-text-primary border border-border rounded px-1.5 py-0.5 ${INPUT_FOCUS} placeholder:text-text-secondary`}
          />
          {/* Mouse submit path — mirrors Enter exactly (handleSubmitNew), so a
              non-empty input pins to that name and an empty input pins to the
              ↵-hinted last-used board. Disabled when Enter would be a no-op. */}
          <button
            type="button"
            onClick={handleSubmitNew}
            disabled={!newName.trim() && !emptyEnterTarget}
            aria-label="Pin to board"
            className="shrink-0 text-xs border border-border rounded px-1.5 py-0.5 min-h-[24px] coarse:min-h-[40px] text-text-secondary hover:text-text-primary hover:bg-bg-card/50 transition-colors disabled:opacity-40"
          >
            Pin
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
