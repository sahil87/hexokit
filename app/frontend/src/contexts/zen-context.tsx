import { createContext, useContext, useState, useMemo, useRef } from "react";

/**
 * Zen mode (260820-o8cr R1) — the desktop terminal route's transient
 * distraction-free override: while active, the root-layout top bar, the Shell
 * sidebar column, and (at arity > 1) every tile except the focused one are
 * hidden; the compose strip and status bar stay visible.
 *
 * TRANSIENT BY CONTRACT: nothing here reads or writes localStorage or a URL
 * param — the state is a render-time override on top of the persisted chrome
 * preferences (which is why this is NOT a ChromeContext field: that shape is
 * persisted chrome, and `setSidebarOpen` writing `hexokit-sidebar-open` is
 * exactly what zen must never do). A reload — or leaving the terminal route —
 * restores exactly what persisted state says.
 *
 * `zenZoomed` tracks whether ZEN initiated the current tile zoom (the
 * `layoutZoomToggleRef` seam): exit unzooms only a zen-initiated zoom — a zoom
 * the user made before entering zen survives exit.
 *
 * The state survives window switches within the terminal route (AppShell does
 * not remount) and is deactivated by AppShell whenever the route no longer
 * carries a window (board/host/server routes render normal chrome).
 *
 * Dual-context shape (the ChromeContext precedent): state consumers re-render
 * on flips; dispatch consumers hold a stable ref-frozen dispatch object.
 */

export type ZenState = {
  /** Whether zen mode is currently active. */
  zenActive: boolean;
  /** Whether the active zen session initiated the tile zoom (exit unzooms
   *  only then — a pre-existing user zoom survives). */
  zenZoomed: boolean;
};

export type ZenDispatch = {
  setZenActive: (active: boolean) => void;
  setZenZoomed: (zoomed: boolean) => void;
};

const ZenStateContext = createContext<ZenState | null>(null);
const ZenDispatchContext = createContext<ZenDispatch | null>(null);

export function ZenProvider({ children }: { children: React.ReactNode }) {
  const [zenActive, setZenActive] = useState(false);
  const [zenZoomed, setZenZoomed] = useState(false);

  const stateValue = useMemo<ZenState>(
    () => ({ zenActive, zenZoomed }),
    [zenActive, zenZoomed],
  );

  const dispatchRef = useRef<ZenDispatch | null>(null);
  if (!dispatchRef.current) {
    dispatchRef.current = {
      setZenActive,
      setZenZoomed,
    };
  }

  return (
    <ZenStateContext.Provider value={stateValue}>
      <ZenDispatchContext.Provider value={dispatchRef.current}>
        {children}
      </ZenDispatchContext.Provider>
    </ZenStateContext.Provider>
  );
}

export function useZenState(): ZenState {
  const state = useContext(ZenStateContext);
  if (!state) throw new Error("useZenState must be used within ZenProvider");
  return state;
}

export function useZenDispatch(): ZenDispatch {
  const dispatch = useContext(ZenDispatchContext);
  if (!dispatch) throw new Error("useZenDispatch must be used within ZenProvider");
  return dispatch;
}

/** Combined convenience hook (the `useChrome` precedent). */
export function useZen(): ZenState & ZenDispatch {
  const state = useZenState();
  const dispatch = useZenDispatch();
  return useMemo(() => ({ ...state, ...dispatch }), [state, dispatch]);
}

/** The terminal-route gate for zen: desktop only, a window open. Shared by
 *  AppShell's own derivation and unit tests so the rule lives in one place. */
export function zenApplies(zenActive: boolean, windowParam: string | undefined, isMobile: boolean): boolean {
  return zenActive && !isMobile && !!windowParam;
}
