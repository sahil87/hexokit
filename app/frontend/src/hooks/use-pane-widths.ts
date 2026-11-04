import { useCallback, useEffect, useState } from "react";

/** Per-board pane width persistence key prefix. */
export const BOARD_WIDTHS_LOCALSTORAGE_PREFIX = "hexokit:board-widths:";

/** Default pane width on desktop (px). */
export const BOARD_PANE_DEFAULT_WIDTH = 480;
/** Minimum pane width (px). */
export const BOARD_PANE_MIN_WIDTH = 280;

function storageKey(board: string): string {
  return `${BOARD_WIDTHS_LOCALSTORAGE_PREFIX}${board}`;
}

function readMap(board: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(board));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    // malformed JSON — fall through to {}
  }
  return {};
}

function writeMap(board: string, map: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(board), JSON.stringify(map));
  } catch {
    // localStorage unavailable / quota exceeded
  }
}

/** Compute the maximum allowed pane width given viewport and sidebar width. */
export function maxPaneWidth(sidebarWidth: number): number {
  if (typeof window === "undefined") return 800;
  return Math.max(BOARD_PANE_MIN_WIDTH, window.innerWidth - sidebarWidth);
}

export function clampPaneWidth(width: number, sidebarWidth: number): number {
  return Math.min(Math.max(width, BOARD_PANE_MIN_WIDTH), maxPaneWidth(sidebarWidth));
}

/**
 * Per-board, per-window pane width state with localStorage persistence.
 * Returns the current width-by-windowId map and a setter that persists to
 * localStorage. Widths are clamped on read and on set.
 */
export function usePaneWidths(board: string, sidebarWidth: number) {
  const [widths, setWidths] = useState<Record<string, number>>(() => readMap(board));

  // Reload when board changes.
  useEffect(() => {
    setWidths(readMap(board));
  }, [board]);

  const setWidth = useCallback(
    (windowId: string, width: number) => {
      setWidths((prev) => {
        const next = { ...prev, [windowId]: clampPaneWidth(width, sidebarWidth) };
        writeMap(board, next);
        return next;
      });
    },
    [board, sidebarWidth],
  );

  const getWidth = useCallback(
    (windowId: string): number => {
      const v = widths[windowId];
      if (typeof v === "number") return clampPaneWidth(v, sidebarWidth);
      return BOARD_PANE_DEFAULT_WIDTH;
    },
    [widths, sidebarWidth],
  );

  return { widths, setWidth, getWidth };
}
