import type { BoardSummary } from "@/api/boards";

/**
 * Client-side "last board a window was pinned to" preference. Per-client only
 * (Constitution II — no backend persistence); the `hexokit-*` key convention
 * mirrors existing preference keys (`hexokit-terminal-font-size`,
 * `hexokit-update-dismissed`). Reads/writes are best-effort with the
 * try/catch-noop pattern from `lib/window-view.ts` so private mode / quota /
 * SSR never throw.
 */
export const LAST_PINNED_BOARD_KEY = "hexokit-last-pinned-board";

/**
 * Read the last board pinned to. Returns `null` when absent or when
 * localStorage is unavailable. The value is NOT validated against the live
 * boards list here — callers filter it against the current boards (a board can
 * disappear when its last pin is removed).
 */
export function readLastPinnedBoard(): string | null {
  try {
    return localStorage.getItem(LAST_PINNED_BOARD_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the last board pinned to. Best-effort — a localStorage failure
 * (private mode / quota / SSR) is swallowed.
 */
export function writeLastPinnedBoard(name: string): void {
  try {
    localStorage.setItem(LAST_PINNED_BOARD_KEY, name);
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * Return `boards` with the last-used board moved to the front, when that board
 * is still present in the live list. A stale or absent `lastUsed` (board gone,
 * or `null`) is ignored and the input order is preserved. The input array is
 * never mutated (a fresh array is returned when a reorder happens; the same
 * reference is returned unchanged on a no-op).
 */
export function orderBoardsLastUsedFirst(
  boards: BoardSummary[],
  lastUsed: string | null,
): BoardSummary[] {
  if (!lastUsed) return boards;
  const idx = boards.findIndex((b) => b.name === lastUsed);
  if (idx <= 0) return boards; // not present, or already first → no reorder
  const next = [...boards];
  const [moved] = next.splice(idx, 1);
  next.unshift(moved);
  return next;
}
