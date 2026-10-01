import { createContext, useContext, useMemo, useRef, useState } from "react";

/**
 * The currently-focused terminal across the app. There is exactly one
 * focused terminal at any time, or `null` when no terminal is mounted
 * (e.g., the dashboard route).
 *
 * Producers:
 *   - `TerminalClient` (single-terminal route): registers on mount, clears
 *     on unmount.
 *   - `BoardPane` (board route): registers on focus events (click,
 *     cycle, initial pane). Does NOT clear on focus LOSS — the next pane
 *     to gain focus overwrites (avoids a transient `null` during a cycle).
 *     It DOES clear on UNMOUNT, iff it is still the registered focused pane,
 *     so leaving the board (board → `/$server` tiles) does not leave a stale
 *     target for the compose strip (260718-dhdj).
 *
 * Consumers:
 *   - `BottomBar`: reads `focused?.wsRef` to send keystrokes/input to
 *     the active terminal. The existing `readyState !== OPEN` guard
 *     handles the `null` case naturally.
 *   - `ComposeStrip`: reads `focused` live at send time to target the
 *     currently-focused pane's `wsRef` and to derive its `→ {window}`
 *     target label. Compose enablement is a persisted
 *     `ChromeContext` preference (`composeStripEnabled`), NOT held here
 *     — the strip is a single global surface, not a per-terminal one
 *     (260718-dhdj).
 */
export type FocusedTerminal = {
  wsRef: React.RefObject<WebSocket | null>;
  /** The focused pane's outer DOM container — the element whose box
   *  visually IS the pane (the tile/pane container, not the inner xterm
   *  canvas). */
  containerRef: React.RefObject<HTMLElement | null>;
  server: string;
  session: string;
  windowId: string;
  /** Display name known to the registrant at registration time. The compose
   *  strip's target label prefers the live window-store name (tracks renames)
   *  and falls back to this before the raw windowId — on the board route the
   *  store only covers servers whose sidebar group has delivered sessions, so
   *  without this fallback other panes label as `@N`. */
  windowName?: string;
  /** Hand DOM keyboard focus to this terminal's xterm. Both real registrants
   *  (TerminalClient, BoardPane) supply it; optional only so test fixtures
   *  can omit it. */
  focus?: () => void;
} | null;

type FocusedTerminalContextValue = {
  focused: FocusedTerminal;
  setFocused: (t: FocusedTerminal) => void;
};

const FocusedTerminalContext = createContext<FocusedTerminalContextValue | null>(null);

/**
 * Provider for `FocusedTerminalContext`. Mount in `RootWrapper` above all
 * routes (alongside `SessionProvider`) so the focused terminal survives
 * navigation between `/$server/...` and `/board/$name`.
 */
export function FocusedTerminalProvider({ children }: { children: React.ReactNode }) {
  const [focused, setFocusedState] = useState<FocusedTerminal>(null);

  // Keep the dispatcher referentially stable so callers can pass it directly
  // into `useEffect` deps without retriggering on every render. Mirrors the
  // dispatch-stability pattern used by `chrome-context.tsx`.
  const dispatchersRef = useRef<{
    setFocused: (t: FocusedTerminal) => void;
  } | null>(null);
  if (!dispatchersRef.current) {
    dispatchersRef.current = {
      setFocused: (t: FocusedTerminal) => setFocusedState(t),
    };
  }

  const value = useMemo<FocusedTerminalContextValue>(
    () => ({
      focused,
      setFocused: dispatchersRef.current!.setFocused,
    }),
    [focused],
  );

  return (
    <FocusedTerminalContext.Provider value={value}>
      {children}
    </FocusedTerminalContext.Provider>
  );
}

/** Read + dispatch focused-terminal state. Throws when used outside a provider. */
export function useFocusedTerminal(): FocusedTerminalContextValue {
  const ctx = useContext(FocusedTerminalContext);
  if (!ctx) {
    throw new Error("useFocusedTerminal must be used within FocusedTerminalProvider");
  }
  return ctx;
}
