import { createContext, useContext, useState, useCallback, useMemo } from "react";

/**
 * Server kill/adopt dialog state + triggers. Provided at the
 * `AppLayout` level — mirroring `settings-dialog-context` (260723-o7q8) — so
 * any route (boards included) opens the single layout-mounted dialogs
 * (`components/server-dialogs.tsx`) instead of re-implementing them per
 * route. Deliberately small: referentially stable triggers plus the
 * open-state routes need for their modal-gating predicates.
 */
export type ServerDialogsState = {
  // Triggers (referentially stable) — the memoized Sidebar server-group
  // header cluster depends on this stability.
  requestKillServer: (name: string) => void;
  requestAdoptServer: (name: string) => void;
  // Close triggers — consumed by the layout-mounted ServerDialogs component.
  clearKillServerTarget: () => void;
  clearAdoptServerTarget: () => void;
  // Open-state, readable by routes (AppShell's/BoardPage's modal-gating
  // predicates check these instead of the deleted route-local state).
  killServerTarget: string | null;
  adoptServerTarget: string | null;
};

const ServerDialogsContext = createContext<ServerDialogsState | null>(null);

export function ServerDialogsProvider({ children }: { children: React.ReactNode }) {
  const [killServerTarget, setKillServerTarget] = useState<string | null>(null);
  const [adoptServerTarget, setAdoptServerTarget] = useState<string | null>(null);

  const requestKillServer = useCallback((name: string) => setKillServerTarget(name), []);
  const clearKillServerTarget = useCallback(() => setKillServerTarget(null), []);
  const requestAdoptServer = useCallback((name: string) => setAdoptServerTarget(name), []);
  const clearAdoptServerTarget = useCallback(() => setAdoptServerTarget(null), []);

  const value = useMemo<ServerDialogsState>(
    () => ({
      requestKillServer,
      requestAdoptServer,
      clearKillServerTarget,
      clearAdoptServerTarget,
      killServerTarget,
      adoptServerTarget,
    }),
    [
      requestKillServer,
      requestAdoptServer,
      clearKillServerTarget,
      clearAdoptServerTarget,
      killServerTarget,
      adoptServerTarget,
    ],
  );

  return (
    <ServerDialogsContext.Provider value={value}>{children}</ServerDialogsContext.Provider>
  );
}

export function useServerDialogs(): ServerDialogsState {
  const ctx = useContext(ServerDialogsContext);
  if (!ctx) throw new Error("useServerDialogs must be used within ServerDialogsProvider");
  return ctx;
}
