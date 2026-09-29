import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSession, WindowInfo } from "@/types";
import type { Layout, SurfaceKind } from "@/lib/surface-layout";
import type { GuiPaletteAction } from "@/lib/palette/gui";
import type { GuiQuality } from "@/lib/gui-posture";

/**
 * TopBar slot context — the prop-delivery channel for the single persistent
 * `TopBar` mounted once at the root layout (`RootTopBar` in `app.tsx`), above
 * the router `<Outlet>` (260707-4vq2).
 *
 * The persistent TopBar's inputs split into two channels:
 *   - Route-derived (synchronous, at root): `mode` + `boardName` — derived from
 *     `useMatches()` in `RootTopBar`, so the heading flips the instant the URL
 *     changes and never waits on the incoming page's mount (important for the
 *     lazily-loaded board).
 *   - Page-registered (this context): the data/handler props a page owns —
 *     `sessions`, current session/window, and the create/navigate/toggle
 *     handlers whose heavy logic (View-Transitions gate, optimistic ghosts)
 *     stays in `AppShell`/`BoardPage`. Pages publish these via
 *     `useRegisterTopBarSlot(...)` in an effect and clear on unmount.
 *     (Connection state left the slot in 260724-6j1v — the dot moved to the
 *     sidebar footer and reaches the Sidebar as a prop.)
 *
 * Precedent: `FocusedTerminalProvider` — a root-level provider that pages
 * register into. Same referentially-stable-dispatcher + `useMemo`-value shape.
 *
 * When no page has registered (first frame after navigation, or a lazy chunk
 * still loading), the context value is `null`; `RootTopBar` falls back to the
 * tolerant-empty prop shape every TopBar mode already supports.
 */
export type TopBarSlot = {
  sessions: ProjectSession[];
  currentSession: ProjectSession | null;
  currentWindow: WindowInfo | null;
  sessionName: string;
  windowName: string;
  sidebarOpen: boolean;
  server: string;
  onNavigate: (windowId: string) => void;
  onToggleSidebar: () => void;
  onCreateWindow: (session: string) => void;
  /** Open the spawn-agent dialog for a session (260713-sbk1). Registered by
   *  `AppShell` on terminal/root routes; the window-switcher `+ New Agent` item
   *  calls it. Absent (undefined) → the dropdown renders no `+ New Agent`. */
  onSpawnAgent?: (session: string) => void;
  /** Board-mode metadata (registered by `BoardPage`; absent otherwise). */
  paneCount?: number;
  serverCount?: number;
  waitingPaneCount?: number;
  boards?: { name: string }[];
  /** Board mode: the focused tile's kill/split target (260715-6jwn). Feeds the
   *  merged top-bar SplitControl and the Kill row (a chevron-menu row since
   *  260731-oiho — menuOnly). `null` when the board is empty (no focused tile)
   *  → the split is absent and the Kill row is disabled. The board Kill NO
   *  LONGER unpins; unpin lives only on the tile header + the `Board: Unpin
   *  Focused Pane` palette action (see `board-page.tsx`). */
  focusedPane?: { server: string; windowId: string; cwd?: string } | null;
  /** Board mode (co9z): the board ✕ is a consequence-gated KILL, not an
   *  immediate close-pane. When present, the top-bar ✕ calls this to open
   *  `BoardPage`'s confirm dialog (with an `Unpin instead` escape) instead of
   *  firing `closePane`; the ✕ label/aria/tooltip read "Kill". The confirmed
   *  kill's self-heal refetch is owned by `BoardPage` (`executeKillWindow`'s
   *  `onSettled`), not signalled back through this slot. Absent outside board
   *  mode → the ✕ keeps its terminal-mode close-pane behavior. */
  onRequestKill?: () => void;
  /** Board-mode autofit toggle (738w): current per-board autofit state and its
   *  setter, published by `BoardPage` (like `focusedPane`). Absent outside
   *  board mode — the top-bar toggle renders only when both are present. */
  autofit?: boolean;
  onToggleAutofit?: () => void;
  /** Terminal-mode surface-toggle group data: the tile surfaces the current
   *  window offers (`tty` first) plus a mode discriminant — TOGGLE (desktop:
   *  the OPEN tiles (the resolved layout's leaves) and the shared toggle
   *  mutation (unlit → `addSurface`, lit → `closeSurface`)) or SWITCH (mobile:
   *  the VISIBLE tile and the switch-to-tile verb). Registered by `AppShell`
   *  on terminal routes (switch mode additionally gated on ≥2 shown surfaces);
   *  absent on board/host routes → no group in the top bar. */
  surfaceToggles?:
    | {
        mode: "toggle";
        available: SurfaceKind[];
        open: SurfaceKind[];
        onToggle: (surface: SurfaceKind) => void;
        /** The size-floor add gate — false disables the unlit buttons. */
        canAdd: boolean;
        /** Away predicate: the surface's slot is live in another tab. */
        away?: (surface: SurfaceKind) => boolean;
        /** Popped predicate: the surface's close-target leaf is popped out
         *  for this viewer — the button carries a popped marker, and the
         *  toggle reveals/hides the popped placeholder instead of closing
         *  the tile. */
        popped?: (surface: SurfaceKind) => boolean;
      }
    | {
        mode: "switch";
        available: SurfaceKind[];
        active: SurfaceKind;
        onSwitch: (surface: SurfaceKind) => void;
      };
  /** The gui header fold's mobile bottom rung: the top bar pins the `⚙` block
   *  beside the mobile switch group while the visible mobile surface is gui
   *  (the gate lives in TopBar). Registered by `AppShell` on terminal routes;
   *  absent → no block. */
  guiToolbar?: {
    actions: GuiPaletteAction[];
    quality: GuiQuality;
    visible: boolean;
    onVisibleChange: (visible: boolean) => void;
  };
  /** Surface-layout machinery (260812-ab5v R9), registered by `AppShell` on the
   *  terminal route: the RESOLVED layout + the single user-mutation path
   *  (`applyLayout`). Feed the top bar's ▦ Layout chip. Absent on non-terminal
   *  routes (BoardPage does not register them) → no chip. */
  layout?: Layout;
  onApplyLayout?: (next: Layout) => void;
  /** True while this viewer has a tile of the layout popped out: the ▦
   *  template cycle (chip + menu rows) renders DISABLED — a template rebuilds
   *  from the current slot order, and running one over the viewer's reduced
   *  render would strand the popped leaf (spec surface-layout.md § Verbs →
   *  Pop out). */
  layoutTemplatesDisabled?: boolean;
} | null;

type TopBarSlotContextValue = {
  slot: TopBarSlot;
  setSlot: (slot: TopBarSlot) => void;
  /**
   * A separate boolean channel (independent of `slot`) set by `NotFoundPage`
   * when it renders. Kept apart from the page-data slot so the not-found page
   * — which owns no TopBar data — signals the fallback with a bare boolean
   * rather than publishing the full slot shape (260707-4vq2 rework).
   */
  notFound: boolean;
  setNotFound: (notFound: boolean) => void;
  /**
   * The popout chrome mode (spec surface-layout.md § Verbs → Pop out): set by
   * `AppShell` while the terminal route renders the `?pop=` popout posture —
   * the root layout drops the persistent TopBar, the quake terminal, and the
   * command palette for a chrome-less one-tile window. A bare boolean like
   * `notFound`: the payload-dependent validity/ever-seen decision lives in
   * AppShell, and the chrome must not flip back when the popout's window dies
   * (the ended "Window closed" state is chrome-less too).
   */
  popout: boolean;
  setPopout: (popout: boolean) => void;
};

const TopBarSlotContext = createContext<TopBarSlotContextValue | null>(null);

/**
 * Provider for `TopBarSlotContext`. Mount in `RootWrapper` above all routes so
 * the registered slot survives navigation and feeds the single persistent
 * `RootTopBar`.
 */
export function TopBarSlotProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlotState] = useState<TopBarSlot>(null);
  const [notFound, setNotFoundState] = useState(false);
  const [popout, setPopoutState] = useState(false);

  // Keep the dispatchers referentially stable so registering pages can pass
  // them straight into a `useEffect` dep list without retriggering every
  // render. Mirrors `FocusedTerminalProvider`/`chrome-context`.
  const setSlotRef = useRef<((slot: TopBarSlot) => void) | null>(null);
  if (!setSlotRef.current) {
    setSlotRef.current = (next: TopBarSlot) => setSlotState(next);
  }
  const setNotFoundRef = useRef<((notFound: boolean) => void) | null>(null);
  if (!setNotFoundRef.current) {
    setNotFoundRef.current = (next: boolean) => setNotFoundState(next);
  }
  const setPopoutRef = useRef<((popout: boolean) => void) | null>(null);
  if (!setPopoutRef.current) {
    setPopoutRef.current = (next: boolean) => setPopoutState(next);
  }

  const value = useMemo<TopBarSlotContextValue>(
    () => ({
      slot,
      setSlot: setSlotRef.current!,
      notFound,
      setNotFound: setNotFoundRef.current!,
      popout,
      setPopout: setPopoutRef.current!,
    }),
    [slot, notFound, popout],
  );

  return (
    <TopBarSlotContext.Provider value={value}>
      {children}
    </TopBarSlotContext.Provider>
  );
}

/** Read the currently-registered TopBar slot. Throws outside a provider. */
export function useTopBarSlot(): TopBarSlot {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useTopBarSlot must be used within TopBarSlotProvider");
  }
  return ctx.slot;
}

/**
 * Read whether the not-found page is currently rendered. `RootTopBar` uses this
 * to force the minimal `host`-like fallback mode: TanStack Router's fuzzy
 * not-found handling retains the partially-matched route params in
 * `useMatches()` (e.g. `/board/x/y` keeps `name=x`), so route params alone
 * would derive `board` mode ("Board: x") over the not-found body. This explicit
 * signal is the only thing that distinguishes "NotFoundPage is rendering" from
 * a real board route (260707-4vq2 rework). Throws outside a provider.
 */
export function useTopBarNotFound(): boolean {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useTopBarNotFound must be used within TopBarSlotProvider");
  }
  return ctx.notFound;
}

/**
 * Signal that the not-found page is rendered — sets the shared `notFound` flag
 * true on mount and clears it on unmount. Call once from `NotFoundPage`'s render
 * body so `RootTopBar` forces the host fallback for the lifetime of that
 * page (see `useTopBarNotFound`). Throws outside a provider.
 */
export function useSignalTopBarNotFound(): void {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useSignalTopBarNotFound must be used within TopBarSlotProvider");
  }
  const { setNotFound } = ctx;
  useEffect(() => {
    setNotFound(true);
    return () => setNotFound(false);
  }, [setNotFound]);
}

/** Read whether the terminal route is rendering the chrome-less popout
 *  posture — the root layout drops the persistent TopBar, the quake terminal,
 *  and the command palette while set. Throws outside a provider. */
export function useTopBarPopout(): boolean {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useTopBarPopout must be used within TopBarSlotProvider");
  }
  return ctx.popout;
}

/** Publish the popout chrome mode (AppShell, on the terminal route) — the
 *  `useSignalTopBarNotFound` pattern: set on every posture flip, cleared on
 *  unmount. */
export function useRegisterTopBarPopout(popout: boolean): void {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useRegisterTopBarPopout must be used within TopBarSlotProvider");
  }
  const { setPopout } = ctx;
  useEffect(() => {
    setPopout(popout);
    return () => setPopout(false);
  }, [setPopout, popout]);
}

/**
 * Register a page's TopBar props into the slot (last-writer-wins) and clear
 * them on unmount. Call once per page from its render body — the effect
 * re-publishes whenever `slot` changes and clears the shared value when the
 * page unmounts.
 *
 * Clear-on-unmount is keyed on the shared `setSlot`: on unmount we reset the
 * value to `null` so a subsequent route with no registration (e.g. a lazy
 * chunk still loading) sees the tolerant-empty default rather than the prior
 * page's stale props.
 */
export function useRegisterTopBarSlot(slot: NonNullable<TopBarSlot>): void {
  const ctx = useContext(TopBarSlotContext);
  if (!ctx) {
    throw new Error("useRegisterTopBarSlot must be used within TopBarSlotProvider");
  }
  const { setSlot } = ctx;
  useEffect(() => {
    setSlot(slot);
    return () => setSlot(null);
  }, [setSlot, slot]);
}
