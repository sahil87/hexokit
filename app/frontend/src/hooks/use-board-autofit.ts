import { useCallback, useEffect, useState } from "react";

/** Per-board autofit-preference localStorage key prefix. */
export const BOARD_AUTOFIT_LOCALSTORAGE_PREFIX = "hexokit:board-autofit:";

/**
 * The single stored sentinel meaning "autofit on". Any other stored value (or
 * the absence of a value, or a malformed one) reads as off — mirroring the
 * malformed-tolerant discipline of `use-pane-widths.ts`.
 */
const AUTOFIT_ON = "on";

function storageKey(board: string): string {
  return `${BOARD_AUTOFIT_LOCALSTORAGE_PREFIX}${board}`;
}

function readAutofit(board: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(board)) === AUTOFIT_ON;
  } catch {
    // localStorage unavailable — default off.
    return false;
  }
}

function writeAutofit(board: string, on: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (on) {
      window.localStorage.setItem(storageKey(board), AUTOFIT_ON);
    } else {
      window.localStorage.removeItem(storageKey(board));
    }
  } catch {
    // localStorage unavailable / quota exceeded — non-fatal.
  }
}

/**
 * Per-board autofit preference with localStorage persistence. Returns the
 * current `autofit` flag and a `toggleAutofit` setter that persists the flip.
 * State reloads when `board` changes (mirrors the `useEffect`-on-`board` reload
 * in `usePaneWidths`). Default when no key is stored: off (current behavior).
 */
export function useBoardAutofit(board: string): {
  autofit: boolean;
  toggleAutofit: () => void;
} {
  const [autofit, setAutofit] = useState<boolean>(() => readAutofit(board));

  // Reload when the board changes.
  useEffect(() => {
    setAutofit(readAutofit(board));
  }, [board]);

  const toggleAutofit = useCallback(() => {
    setAutofit((prev) => {
      const next = !prev;
      writeAutofit(board, next);
      return next;
    });
  }, [board]);

  return { autofit, toggleAutofit };
}
