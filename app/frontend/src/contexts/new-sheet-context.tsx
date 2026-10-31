import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { NewSheetRequest } from "@/lib/new-sheet";

/**
 * New-sheet opener seam. Provided at the `AppLayout` level (the
 * `server-dialogs-context` shape) so any surface — palette, split button,
 * per-group `+` — opens the single layout-mounted `NewSheetHost` with
 * referentially stable triggers. The level always comes from the opener; the
 * request's optional `server`/`group` pin the target when the caller knows it.
 */
export type NewSheetState = {
  openNewSheet: (request: NewSheetRequest) => void;
  closeNewSheet: () => void;
  /** The live request (null while closed) — read by the host. */
  newSheetRequest: NewSheetRequest | null;
  /** Open-state for routes' modal-gating predicates. */
  newSheetOpen: boolean;
};

const NewSheetContext = createContext<NewSheetState | null>(null);

export function NewSheetProvider({ children }: { children: React.ReactNode }) {
  const [newSheetRequest, setRequest] = useState<NewSheetRequest | null>(null);

  const openNewSheet = useCallback((request: NewSheetRequest) => setRequest(request), []);
  const closeNewSheet = useCallback(() => setRequest(null), []);

  const value = useMemo<NewSheetState>(
    () => ({ openNewSheet, closeNewSheet, newSheetRequest, newSheetOpen: newSheetRequest !== null }),
    [openNewSheet, closeNewSheet, newSheetRequest],
  );

  return <NewSheetContext.Provider value={value}>{children}</NewSheetContext.Provider>;
}

export function useNewSheet(): NewSheetState {
  const ctx = useContext(NewSheetContext);
  if (!ctx) throw new Error("useNewSheet must be used within NewSheetProvider");
  return ctx;
}
