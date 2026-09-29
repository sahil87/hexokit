import { useState, useCallback, useRef, useEffect, useMemo, useReducer, memo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { killSession as killSessionApi, killWindow as killWindowApi, renameSession, moveWindow, moveWindowToSession, setSessionColor as setSessionColorApi, setWindowColor as setWindowColorApi, setWindowFlair as setWindowFlairApi, setSessionFlair as setSessionFlairApi, getAllServerColors, setServerColor as setServerColorApi, getAllServerFlairs, setServerFlair as setServerFlairApi, setSessionOrder, setServerProtected, isExternalServer, DAEMON_SERVER, type ServerInfo } from "@/api/client";
import { useSessionContext, useUpdateNotification } from "@/contexts/session-context";
import { useFocusedPane } from "@/contexts/focused-pane-context";
import { thinWindowFromFocusedPane } from "@/lib/focused-pane-window";
import { finalizeSafeName } from "@/lib/names";
import { pinDragImage } from "@/lib/drag-image";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { pushRecentlyClosed } from "@/hooks/use-recently-closed";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useToast } from "@/components/toast";
import { TypedLabel } from "@/components/typed-label";
import { LogoSpinner, useBrandLogoSweep } from "@/components/logo-spinner";
import { Tip, TipGroup } from "@/components/tip";
import { SwatchPopover } from "@/components/swatch-popover";
import { FlairOverlay } from "@/components/flair-overlay";
import { ExternalGlyph, ShieldGlyph } from "@/components/top-bar-icons";
import { useTheme } from "@/contexts/theme-context";
import { displayVersion } from "@/lib/palette/version";
import { copyToClipboard } from "@/lib/clipboard";
import { formatCombo } from "@/lib/keybindings";
import { useKeybindings } from "@/hooks/use-keybindings";
import { computeRowTints, computeRowBorders, deriveUIColors, UNCOLORED_SELECTED_KEY } from "@/themes";
import type { ProjectSession } from "@/types";
import { isGhostWindow } from "@/contexts/optimistic-context";
import type { MergedSession } from "@/contexts/optimistic-context";
import { useWindowStore } from "@/store/window-store";
import { useSelectionStore } from "@/store/selection-store";
// Aliased: `selectionKey` is already taken in this file by the autoscroll
// effect's URL-selection identity (`${currentServer}:${currentWindowId}`) — a
// different concept from the multi-select's composite row key.
import { rangeBetween, selectionKey as windowSelectionKey } from "@/lib/selection";
import { useWindowRename } from "@/hooks/use-window-rename";
import { useWindowPins } from "@/hooks/use-window-pins";
import { useSessionsScope } from "@/hooks/use-sessions-scope";
import { useSidebarSectionVisible } from "@/hooks/use-sidebar-sections";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useScrollEdgeFade } from "@/hooks/use-scroll-edge-fade";
import { registerSidebarRowFocuser, restoreWindowFocus } from "@/lib/sidebar-events";
import { useChromeState } from "@/contexts/chrome-context";
import { useActiveBoardName } from "@/hooks/use-active-board";
import { useMergedSessions } from "@/contexts/optimistic-context";
import { countWaitingInSessions } from "@/lib/waiting";
import { deriveEffectiveSessionOrder } from "@/lib/palette/move";
import { readLastWindow, resolveServerLandingWindow } from "@/lib/last-window-per-server";
import { BoardsSection, WINDOW_DRAG_MIME } from "./boards-section";
import { SectionRail } from "./section-rail";
import { HostPanel } from "./host-panel";
import { KillDialog } from "./kill-dialog";
import { ServerPanel } from "./server-panel";
import { SessionRow } from "./session-row";
import { WindowPanel } from "./status-panel";
import { WindowRow } from "./window-row";
import { HeadsetIcon } from "./icons";
import { ServerCardContent, useAnchoredPopoverPos } from "./server-card";
import {
  useRowFlyout,
  useRailScrub,
  STATUS_RAIL_WIDTH_PX,
  railRestBand,
  railHeldBand,
  RAIL_HELD_SEAM,
  NoteLine,
} from "./row-flyout-card";

/** Shallow element-wise compare of two flat string arrays (same length, same
 *  elements in order). Used to detect when an SSE-delivered session order has
 *  caught up to a transient drag override so the override can be dropped. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** localStorage key holding the per-SESSION collapse map (260807-kddk) — a
 *  single JSON object of collapsed EXCEPTIONS keyed by the session row key
 *  (`{"default:utils2": true, "fabKit1:relay-spike": true}`). An expanded
 *  session carries no entry, so the default (expanded) keeps applying to every
 *  session the user has never collapsed, new sessions included.
 *
 *  One map key rather than one key per session: per-session keys would sprawl
 *  unboundedly across killed sessions and could not be enumerated for cleanup.
 *  The sibling per-SERVER section keys (`hexokit-panel-sessions-{server}`) are
 *  scalars only because their value is a single boolean per server. */
export const SESSION_COLLAPSED_STORAGE_KEY = "hexokit-session-collapsed";

/** Tolerant read of the persisted collapse map. Malformed JSON, a non-object
 *  root (an array included), a throwing `localStorage` (privacy mode,
 *  sandboxed iframe), and non-`true` entry values all degrade to `{}` — i.e.
 *  every session expanded. Normalizing to `true`-only entries on read is what
 *  keeps the map exceptions-only: a stored `false` is dropped, not honored. */
function readCollapsedSessions(): Record<string, boolean> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY);
  } catch {
    return {}; // localStorage unavailable
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const map: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === true) map[key] = true;
  }
  return map;
}

/** Best-effort write-through of the collapse map. An empty map removes the key
 *  outright rather than storing `{}` (the `compose-draft-store.ts` posture), so
 *  "no exceptions" and "never used" are the same state on the next read. */
function writeCollapsedSessions(map: Record<string, boolean>): void {
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(SESSION_COLLAPSED_STORAGE_KEY);
    } else {
      localStorage.setItem(SESSION_COLLAPSED_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // localStorage unavailable
  }
}

/** Identity of a roving tree row, keyed by its row key (`data-window-id` for a
 *  window, `${server}:${name}` for a session). A discriminated union so Enter/
 *  Space activation derives the right handler + args with no type assertions. */
type RowIdentity =
  | { kind: "window"; server: string; session: string; windowId: string; ghost: boolean }
  | { kind: "session"; server: string; session: string; firstWindowId: string }
  | { kind: "operator-placeholder"; server: string };

export type SidebarProps = {
  /** Identifies the "active" server for visual treatment + default expanded
   *  group. `null` on board route — no group is marked current and all
   *  groups follow persisted toggles (defaulting to collapsed). */
  currentServer: string | null;
  currentSession: string | null;
  currentWindowId: string | null;
  /** Per-page "this page's live data is flowing" (260724-6j1v) — the same
   *  value the top-bar connection dot carried before it moved to the sidebar
   *  footer. AppShell passes its chat-aware `dotConnected`; BoardPage passes
   *  `boardConnected` (AND over attached servers). */
  isConnected: boolean;
  /** Session/window navigation. The `server` argument carries the source
   *  server so callers can route across servers. The window is addressed by
   *  its stable tmux window ID (@N). */
  onSelectWindow: (server: string, session: string, windowId: string) => void;
  /** Create a new window inside a session on a specific server. */
  onCreateWindow: (server: string, session: string) => void;
  /** Create a new session against a specific server (per-group "+" button). */
  onCreateSession: (server: string) => void;
  /** Open the spawn-agent dialog targeting a session-row's `{server, session}`.
   *  Optional (mirrors `SessionRow.onSpawnAgent`): when omitted (e.g. the
   *  board-route sidebar) the per-row bot button is hidden. */
  onSpawnAgent?: (server: string, session: string) => void;
  /** Ask the server's operator window to write/refresh one-line @rk_win_note
   *  annotations for the session's tabs (the update-annotations template's
   *  session scope — 260827-8n6k). Optional (mirrors `onSpawnAgent`): when
   *  omitted — e.g. the board-route sidebar — the session card's Update
   *  annotations row is hidden. The consumer additionally gates on the server
   *  having an operator window. */
  onUpdateAnnotations?: (server: string, session: string) => void;
  /** Persist a window marker when this route owns a marker write seam. */
  onWindowMarkerChange?: (
    server: string,
    session: string,
    windowId: string,
    marker: string | null,
  ) => void;
  /** Fork a window's agent conversation into a new window in the same session
   *  and directory (260806-s4av). Optional (mirrors `onSpawnAgent`): when
   *  omitted — e.g. the board-route sidebar — the row flyout's fork affordance is
   *  hidden. The flyout additionally gates on `agentProvider === "claude"`. */
  onForkWindow?: (server: string, windowId: string) => Promise<void>;
  /** Ask the server's operator window to fix a subject window's tab name
   *  (260822-fih1-operator-request-fix-tab-name). Optional (mirrors
   *  `onForkWindow`): when omitted — e.g. the board-route sidebar — the row
   *  flyout's Fix tab name affordance is hidden. */
  onFixTabName?: (server: string, windowId: string) => Promise<void>;
  /** Open the operator compose dialog from the pinned operator row
   *  (260822-wyn3). Optional (mirrors `onForkWindow`): when omitted — e.g. the
   *  board-route sidebar — the pinned row renders no compose icon. */
  onOperatorCompose?: (server: string) => void;
  /** Activate the operator PLACEHOLDER row (the pinned slot's operator-less
   *  form — the shell's drawer opener). Optional (mirrors
   *  `onOperatorCompose`): when omitted — e.g. the board-route sidebar — no
   *  placeholder renders. */
  onOperatorPlaceholder?: (server: string) => void;
  onCreateServer: () => void;
  onKillServer: (name: string) => void;
  /** Optional waiting-badge click (260714-r7rq): navigate to the next waiting
   *  window in a session (the target renders its own stored layout). Passed
   *  to each `SessionRow`; absent ⇒ badges stay display-only. */
  onWaitingBadgeClick?: (server: string, session: string) => void;
  /** Forwarded to `ServerPanel` → `CollapsiblePanel` as the corner pointerdown
   *  callback. When supplied (desktop only), a corner affordance is rendered at
   *  the bottom-right of the server panel drag handle that also starts a
   *  sidebar-width drag. */
  onSidebarResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
};

export function Sidebar({
  currentServer,
  currentSession,
  currentWindowId,
  isConnected,
  onSelectWindow,
  onCreateWindow,
  onCreateSession,
  onSpawnAgent,
  onUpdateAnnotations,
  onWindowMarkerChange,
  onForkWindow,
  onFixTabName,
  onOperatorCompose,
  onOperatorPlaceholder,
  onCreateServer,
  onKillServer,
  onWaitingBadgeClick,
  onSidebarResizeStart,
}: SidebarProps) {
  const ctx = useSessionContext();
  const { servers, sessionsByServer, isConnectedByServer, refreshServers, attachServer } = ctx;
  // Pre-compute row tints + contrast-adjusted borders from the active theme.
  // Tints blend into the chrome hex the sidebar rows render on, not the
  // terminal background — blending into `bgPrimary` would halo on the chrome.
  const { theme } = useTheme();
  const rowTints = useMemo(
    () => computeRowTints(theme.palette, deriveUIColors(theme.palette, theme.category).bgChrome),
    [theme.palette, theme.category],
  );
  const rowBorders = useMemo(
    () => computeRowBorders(theme.palette, theme.category),
    [theme.palette, theme.category],
  );
  // Per-server waiting rollup for the SERVER panel tiles (260708-4li7). Pure
  // derivation over the already-streamed session data — no new endpoint, no
  // polling (Constitution II). Attached-server-only by construction: only
  // servers with an open SSE stream have windows in `sessionsByServer`, so an
  // unattached server's count is 0 and its tile badge is simply absent.
  const waitingCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const [name, sessions] of sessionsByServer) {
      m.set(name, countWaitingInSessions(sessions));
    }
    return m;
  }, [sessionsByServer]);
  const navigate = useNavigate();
  const { addToast } = useToast();

  // Sessions-pane scope — explicit persisted state (`hexokit-panel-sessions-scope`),
  // fully decoupled from the SERVER panel's expansion. `current` filters the
  // tree to the resolved current server (falling back to all servers when none
  // resolves); `all` (default) lists every server's group. The header chip,
  // this list, and the palette entry are sibling subscribers of the same key.
  const [sessionsScope, setSessionsScope] = useSessionsScope();

  // Server colors from config.yaml (all servers) — color value descriptors
  // ("4" / "1+3").
  const [serverColors, setServerColors] = useState<Record<string, string>>({});
  useEffect(() => {
    getAllServerColors().then(setServerColors).catch(() => {});
  }, []);

  // Server flairs from config.yaml (all servers) — flair tokens from the
  // universal set. Same mount-fetch + optimistic-map shape as serverColors
  // (settings mutations emit no control-mode event, so no SSE derive exists).
  const [serverFlairs, setServerFlairs] = useState<Record<string, string>>({});
  useEffect(() => {
    getAllServerFlairs().then(setServerFlairs).catch(() => {});
  }, []);

  // Server-switch handler — resolves a landing window for the target server
  // (remembered → derived from the effective session order) and navigates to
  // it, falling back to bare `/$server` (the session-tiles overview) when the
  // resolver finds nothing. The route param drives `currentServer` via the
  // provider's `useMatches()` lookup.
  const handleSwitchServer = useCallback(
    (name: string) => {
      const targetSessions = sessionsByServer.get(name) ?? [];
      const windowId = resolveServerLandingWindow({
        sessions: targetSessions,
        sessionOrder: deriveEffectiveSessionOrder(
          targetSessions.map((s) => s.name),
          ctx.sessionOrderByServer.get(name) ?? [],
        ),
        remembered: readLastWindow(name),
      });
      if (windowId) {
        navigate({
          to: "/$server/$window",
          params: { server: name, window: windowId },
          // Clear any carried-over layout param so the target window resolves
          // its OWN layout, not the outgoing window's.
          search: {},
        });
      } else {
        navigate({ to: "/$server", params: { server: name } });
      }
    },
    [navigate, sessionsByServer, ctx.sessionOrderByServer],
  );

  // Sessions section collapse state — per-server, persisted in localStorage
  // under `hexokit-panel-sessions-{server}`. Default-open for `currentServer`,
  // collapsed for everyone else. Includes a one-time migration of the legacy
  // `runkit-panel-sessions` key to the current server's namespaced key.
  const [serverSectionsOpen, setServerSectionsOpen] = useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    // Best-effort migration of the legacy key — only when currentServer is
    // set, so we know which namespaced key inherits the value. No error if
    // the key is missing.
    if (currentServer) {
      try {
        const legacy = localStorage.getItem("runkit-panel-sessions");
        if (legacy != null) {
          const k = `hexokit-panel-sessions-${currentServer}`;
          if (localStorage.getItem(k) == null) {
            localStorage.setItem(k, legacy);
          }
          localStorage.removeItem("runkit-panel-sessions");
        }
      } catch {
        // localStorage unavailable
      }
    }
    return seed;
  });

  /** Read per-server collapse from localStorage (used inside the render loop
   *  for servers we haven't touched yet). Default: open for currentServer,
   *  collapsed otherwise. */
  const readServerOpen = useCallback(
    (server: string): boolean => {
      const cached = serverSectionsOpen[server];
      if (cached !== undefined) return cached;
      try {
        const v = localStorage.getItem(`hexokit-panel-sessions-${server}`);
        if (v === "false") return false;
        if (v === "true") return true;
      } catch {
        // localStorage unavailable
      }
      return server === currentServer;
    },
    [serverSectionsOpen, currentServer],
  );

  // Lazy-attach: ask the provider to subscribe the state socket to any
  // server whose group is open. The current server is auto-attached by the
  // provider; this covers user-expanded non-current groups.
  useEffect(() => {
    for (const s of servers) {
      if (readServerOpen(s.name)) {
        attachServer(s.name);
      }
    }
  }, [servers, attachServer, readServerOpen]);

  const toggleServerSection = useCallback((server: string) => {
    // The state updater MUST be pure: under React 19 StrictMode (active via
    // main.tsx in dev/e2e) it is invoked twice. A side-effect inside it
    // (localStorage.setItem, attachServer) runs twice and — worse — the second
    // invocation would observe the first's localStorage write and invert the
    // computed next, making a single click a no-op (the group never opened).
    //
    // So: snapshot the current open-state via `readServerOpen` ONCE, BEFORE any
    // write, derive `next`, then run the side-effects once outside the updater.
    // `current` is captured before the localStorage.setItem below, so the value
    // is stable even though `readServerOpen` itself reads localStorage.
    const current = readServerOpen(server);
    const next = !current;
    try {
      localStorage.setItem(`hexokit-panel-sessions-${server}`, String(next));
    } catch {
      // localStorage unavailable
    }
    // When opening a non-current server's group, ask the provider to
    // subscribe to it so the group's session list is populated.
    if (next && server !== currentServer) {
      attachServer(server);
    }
    // Commit from `prev` so back-to-back toggles batched into a single render
    // still alternate correctly (`prev` accumulates queued updates within a
    // batch). For an untouched group `prev[server]` is undefined; fall back to
    // the `current` snapshot taken above — NOT a fresh `readServerOpen`, which
    // would re-read the localStorage value just written and re-introduce the
    // StrictMode inversion on the first toggle.
    setServerSectionsOpen((prev) => ({
      ...prev,
      [server]: prev[server] === undefined ? next : !prev[server],
    }));
  }, [currentServer, attachServer, readServerOpen]);

  // Per-session window-list collapse, keyed by `${server}:${session.name}` and
  // persisted as collapsed exceptions in `hexokit-session-collapsed` (kddk).
  // Seeded lazily from storage so a collapsed session paints collapsed on the
  // first frame; read sites keep their `?? false` default, so an unknown key
  // (a new session, a cleared browser) stays expanded exactly as before.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsedSessions);
  // Synchronous mirror of `collapsed` for the toggle handler. React state is
  // not readable until the next render, so two toggles batched into a single
  // render would both derive from the same stale map and persist a value that
  // disagrees with the committed state. The ref advances on every toggle.
  const collapsedRef = useRef(collapsed);
  // Manual-collapse latch: the current session renders expanded regardless of
  // its collapsed exception (the derived override in ServerGroupInner), EXCEPT
  // when the user folds it while current — the latch holds that fold until the
  // current session changes. Refs, not state: `toggleSession`'s setCollapsed
  // already re-renders the fold, and navigation re-renders via props. The
  // render-time reconcile below (orderOverrideRef idiom) clears the latch on a
  // current-session change so re-entering a folded session reveals it again.
  const manualCollapseLatchRef = useRef<string | null>(null);
  const lastCurrentSessionKeyRef = useRef<string | null>(null);
  // Mirror of the current session key for `toggleSession`, whose `[]` deps
  // would otherwise go stale on navigation (and widening them would churn the
  // handler identity through the memoized row tree).
  const currentSessionKeyRef = useRef<string | null>(null);
  const currentSessionKey =
    currentServer != null && currentSession != null ? `${currentServer}:${currentSession}` : null;
  if (lastCurrentSessionKeyRef.current !== currentSessionKey) {
    lastCurrentSessionKeyRef.current = currentSessionKey;
    manualCollapseLatchRef.current = null;
  }
  currentSessionKeyRef.current = currentSessionKey;
  const manualCollapseLatched =
    manualCollapseLatchRef.current !== null && manualCollapseLatchRef.current === currentSessionKey;
  const [killTarget, setKillTarget] = useState<{
    type: "session" | "window";
    server: string;
    session: string;
    windowId?: string;
    windowCount: number;
  } | null>(null);

  const [editingWindow, setEditingWindow] = useState<{ server: string; session: string; windowId: string } | null>(null);
  const [editingName, setEditingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const originalNameRef = useRef("");

  const [editingSession, setEditingSession] = useState<{ server: string; name: string } | null>(null);
  const [editingSessionName, setEditingSessionName] = useState("");
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const sessionCancelledRef = useRef(false);
  const sessionOriginalNameRef = useRef("");

  // Drag-and-drop state for window reordering. `dragSource.server` is the
  // source's server, used to reject cross-server drops with a toast.
  const [dragSource, setDragSource] = useState<{ server: string; session: string; index: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ server: string; session: string; index: number } | null>(null);
  const [sessionDropTarget, setSessionDropTarget] = useState<{ server: string; session: string } | null>(null);

  // Session reorder per server. The persisted order arrives via SSE
  // (`sessionOrderByServer`). The displayed order is DERIVED at render time:
  // `override ?? sseOrder`. The transient drag override lives in a ref (not
  // state) keyed by server — it is consumed synchronously at render, so
  // writing it never needs to trigger a render on its own. We keep it out of
  // state to avoid a reconciling effect that re-runs on every SSE slice tick.
  const [sessionDragSource, setSessionDragSource] = useState<{ server: string; name: string } | null>(null);
  const orderOverrideRef = useRef<Record<string, string[]>>({});
  const orderPutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SESSION_ORDER_DEBOUNCE_MS = 250;

  // Minimal render nudge. Refs do not trigger re-renders, so when we set or
  // clear `orderOverrideRef` we bump this counter to re-render reading the
  // updated override (or the now-authoritative SSE order after a clear). This
  // replaces the removed whole-Map watcher effect — the override lifecycle is
  // driven by drag events plus a per-server SSE-order equality check at render.
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const sessionDragSourceRef = useRef<typeof sessionDragSource>(null);
  sessionDragSourceRef.current = sessionDragSource;

  useEffect(() => {
    return () => {
      if (orderPutTimerRef.current) clearTimeout(orderPutTimerRef.current);
    };
  }, []);

  const { markKilled, unmarkKilled, markRenamed, unmarkRenamed } = useOptimisticContext();

  // Boards integration: aggregate pin map across all servers + boards.
  const { boards: allBoards, pinnedSet, pinnedToBoard, boardForWindow, isLoading: boardsLoading } = useWindowPins();
  const activeBoardName = useActiveBoardName();
  const isPinnedToActiveBoardFor = useCallback(
    (winServer: string, windowId: string) => {
      if (!activeBoardName) return false;
      return pinnedToBoard(activeBoardName, winServer, windowId);
    },
    [activeBoardName, pinnedToBoard],
  );
  // Navigate to a board (co9z): the pinned-row indicator's navigation
  // affordance. Stable identity so it does not churn ServerGroup's React.memo.
  const onNavigateToBoard = useCallback(
    (board: string) => {
      navigate({ to: "/board/$name", params: { name: board } });
    },
    [navigate],
  );
  const killWindowStore = useWindowStore((state) => state.killWindow);
  const restoreWindow = useWindowStore((state) => state.restoreWindow);
  const clearSession = useWindowStore((state) => state.clearSession);
  const moveWindowOrder = useWindowStore((state) => state.moveWindowOrder);
  const addGhostWindow = useWindowStore((state) => state.addGhostWindow);
  const removeGhost = useWindowStore((state) => state.removeGhost);

  // Ctrl+click kill session (optimistic) — captures (server, session) per call.
  const lastKillSessionRef = useRef<{ server: string; name: string } | null>(null);
  const { execute: executeKillSession } = useOptimisticAction<[string, string]>({
    action: (srv, name) => killSessionApi(srv, name),
    onOptimistic: (srv, name) => {
      lastKillSessionRef.current = { server: srv, name };
      markKilled("session", srv, name);
    },
    onAlwaysRollback: () => {
      const last = lastKillSessionRef.current;
      if (last) unmarkKilled("session", last.server, last.name);
    },
    onAlwaysSettled: () => {
      const last = lastKillSessionRef.current;
      if (last) clearSession(last.server, last.name);
      lastKillSessionRef.current = null;
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill session");
    },
  });

  // Ctrl+click kill window (optimistic) — captures (server, session, windowId).
  const lastKillWindowRef = useRef<{ server: string; session: string; windowId: string } | null>(null);
  const { execute: executeKillWindow } = useOptimisticAction<[string, string, string]>({
    action: async (srv, _session, windowId) => {
      const res = await killWindowApi(srv, windowId);
      if (res.closed) pushRecentlyClosed(srv, res.closed);
      return res;
    },
    onOptimistic: (srv, session, windowId) => {
      lastKillWindowRef.current = { server: srv, session, windowId };
      killWindowStore(srv, session, windowId);
    },
    onAlwaysRollback: () => {
      const last = lastKillWindowRef.current;
      if (last) restoreWindow(last.server, last.session, last.windowId);
    },
    onAlwaysSettled: () => {
      const last = lastKillWindowRef.current;
      if (last) restoreWindow(last.server, last.session, last.windowId);
      lastKillWindowRef.current = null;
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill tab");
    },
  });

  // Kill from confirmation dialog (optimistic)
  const killTargetRef = useRef(killTarget);
  killTargetRef.current = killTarget;
  const killDialogServerRef = useRef<string>("");

  const { execute: executeKillFromDialog } = useOptimisticAction<[string, { type: "session" | "window"; session: string; windowId?: string }]>({
    action: async (srv, target) => {
      if (target.type === "window" && target.windowId) {
        const res = await killWindowApi(srv, target.windowId);
        if (res.closed) pushRecentlyClosed(srv, res.closed);
        return res;
      }
      return killSessionApi(srv, target.session);
    },
    onOptimistic: (srv, target) => {
      killDialogServerRef.current = srv;
      if (target.type === "window" && target.windowId) {
        killWindowStore(srv, target.session, target.windowId);
      } else {
        markKilled("session", srv, target.session);
      }
    },
    onAlwaysRollback: () => {
      const target = killTargetRef.current;
      if (!target) return;
      const srv = killDialogServerRef.current;
      if (target.type === "window" && target.windowId) {
        restoreWindow(srv, target.session, target.windowId);
      } else {
        unmarkKilled("session", srv, target.session);
      }
    },
    onAlwaysSettled: () => {
      const target = killTargetRef.current;
      if (!target) return;
      const srv = killDialogServerRef.current;
      if (target.type === "window" && target.windowId) {
        restoreWindow(srv, target.session, target.windowId);
      } else {
        clearSession(srv, target.session);
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill");
    },
  });

  // Inline rename session (optimistic). Captures (server, oldName, newName).
  const lastRenameSessionRef = useRef<{ server: string; oldName: string; newName: string } | null>(null);
  const { execute: executeRenameSession } = useOptimisticAction<[string, string, string]>({
    action: (srv, oldName, newName) => renameSession(srv, oldName, newName),
    onOptimistic: (srv, oldName, newName) => {
      lastRenameSessionRef.current = { server: srv, oldName, newName };
      markRenamed("session", srv, oldName, newName);
      // No navigation on rename: the route is /$server/$window (no session
      // segment), so the URL is unaffected by a session rename — the breadcrumb
      // re-derives the new session name from the next SSE snapshot.
    },
    onRollback: () => {
      const last = lastRenameSessionRef.current;
      if (last) {
        unmarkRenamed(last.server, last.oldName);
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to rename session");
    },
    onSettled: () => {
      lastRenameSessionRef.current = null;
    },
  });

  // Inline rename window (optimistic) — finds windowId via editingWindow state.
  // Shared with the top-bar WindowHeading via useWindowRename (change 5ilm).
  const { execute: executeRenameWindow } = useWindowRename();

  // Optimistic move for drag-drop window reorder (insert-before semantics).
  // Snapshot is keyed by the store's composite key (`${server}:${windowId}`)
  // so the rollback restores the right per-server entries.
  // Tuple: (server, session, srcWindowId, srcIndex, dstIndex). The move API
  // addresses the source by its stable windowId; the optimistic store reorder
  // is inherently positional so it still uses srcIndex/dstIndex.
  const preMoveEntriesRef = useRef<Map<string, { index: number }> | null>(null);
  const { execute: executeMoveWindow, isPending: isMovePending } = useOptimisticAction<[string, string, string, number, number]>({
    action: (srv, _session, srcWindowId, _srcIndex, dstIndex) => moveWindow(srv, srcWindowId, dstIndex),
    onOptimistic: (srv, session, _srcWindowId, srcIndex, dstIndex) => {
      const entries = useWindowStore.getState().entries;
      const snapshot = new Map<string, { index: number }>();
      for (const [key, e] of entries) {
        if (e.server === srv && e.session === session) snapshot.set(key, { index: e.index });
      }
      preMoveEntriesRef.current = snapshot;
      moveWindowOrder(srv, session, srcIndex, dstIndex);
    },
    onAlwaysRollback: () => {
      if (preMoveEntriesRef.current) {
        const snapshot = preMoveEntriesRef.current;
        useWindowStore.setState((state) => {
          const newEntries = new Map(state.entries);
          for (const [id, saved] of snapshot) {
            const existing = newEntries.get(id);
            if (existing) newEntries.set(id, { ...existing, index: saved.index });
          }
          return { entries: newEntries };
        });
        preMoveEntriesRef.current = null;
      }
    },
    onAlwaysSettled: () => {
      preMoveEntriesRef.current = null;
    },
    onError: (err) => {
      addToast(err.message || "Failed to move tab");
    },
  });

  // Optimistic cross-session window move. Cross-server moves are rejected
  // upstream (DnD handler emits a toast) so srcServer == dstServer here.
  const lastMoveToSessionRef = useRef<{ server: string; srcSession: string; windowId: string; optimisticId: string } | null>(null);
  const { execute: executeMoveToSession, isPending: isCrossMovePending } = useOptimisticAction<[string, string, number, string, string, string]>({
    action: (srv, _srcSession, _srcIndex, windowId, _windowName, dstSession) =>
      moveWindowToSession(srv, windowId, dstSession),
    onOptimistic: (srv, srcSession, _srcIndex, windowId, windowName, dstSession) => {
      killWindowStore(srv, srcSession, windowId);
      const optimisticId = addGhostWindow(srv, dstSession, windowName);
      lastMoveToSessionRef.current = { server: srv, srcSession, windowId, optimisticId };
      navigate({ to: "/$server", params: { server: srv } });
    },
    onAlwaysRollback: () => {
      const last = lastMoveToSessionRef.current;
      if (last) {
        restoreWindow(last.server, last.srcSession, last.windowId);
        removeGhost(last.optimisticId);
      }
    },
    onAlwaysSettled: () => {
      lastMoveToSessionRef.current = null;
    },
    onError: (err) => {
      addToast(err.message || "Failed to move tab to session");
    },
  });

  useEffect(() => {
    if (editingWindow && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingWindow]);

  useEffect(() => {
    if (editingSession && sessionInputRef.current) {
      sessionInputRef.current.focus();
      sessionInputRef.current.select();
    }
  }, [editingSession]);

  const handleStartSessionEditing = useCallback((server: string, sessionName: string) => {
    cancelledRef.current = true;
    setEditingWindow(null);
    sessionCancelledRef.current = true;
    setEditingSession({ server, name: sessionName });
    setEditingSessionName(sessionName);
    sessionOriginalNameRef.current = sessionName;
    sessionCancelledRef.current = false;
  }, []);

  const handleSessionRenameCommit = useCallback(() => {
    if (!editingSession) return;
    // The row input applies the live session transform; commit trims the
    // trailing separator the live transform keeps visible while typing.
    const trimmed = finalizeSafeName(editingSessionName.trim());
    const originalName = sessionOriginalNameRef.current;
    const { server: srv, name: sessionName } = editingSession;
    setEditingSession(null);
    if (trimmed && trimmed !== originalName) {
      executeRenameSession(srv, sessionName, trimmed);
    }
  }, [editingSession, editingSessionName, executeRenameSession]);

  const handleSessionRenameCancel = useCallback(() => {
    sessionCancelledRef.current = true;
    setEditingSession(null);
  }, []);

  const handleSessionRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSessionRenameCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleSessionRenameCancel();
    }
  }, [handleSessionRenameCommit, handleSessionRenameCancel]);

  const handleSessionRenameBlur = useCallback(() => {
    if (sessionCancelledRef.current) return;
    handleSessionRenameCommit();
  }, [handleSessionRenameCommit]);

  const handleStartEditing = useCallback((server: string, session: string, windowId: string, currentName: string) => {
    sessionCancelledRef.current = true;
    setEditingSession(null);
    cancelledRef.current = true;
    setEditingWindow({ server, session, windowId });
    setEditingName(currentName);
    originalNameRef.current = currentName;
    cancelledRef.current = false;
  }, []);

  const handleRenameCommit = useCallback(() => {
    if (!editingWindow) return;
    // Same commit-time finalize as the session rename above (window kind).
    const trimmed = finalizeSafeName(editingName.trim());
    const originalName = originalNameRef.current;
    const { server: srv, session, windowId } = editingWindow;
    setEditingWindow(null);
    if (trimmed && trimmed !== originalName) {
      executeRenameWindow(srv, session, windowId, trimmed);
    }
  }, [editingWindow, editingName, executeRenameWindow]);

  const handleRenameCancel = useCallback(() => {
    cancelledRef.current = true;
    setEditingWindow(null);
  }, []);

  // Window rename key/blur — stable wrappers passed straight to ServerGroup so
  // the per-row closures inside it don't have to be rebuilt every render.
  const handleWindowRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleRenameCancel();
    }
  }, [handleRenameCommit, handleRenameCancel]);

  const handleWindowRenameBlur = useCallback(() => {
    if (cancelledRef.current) return;
    handleRenameCommit();
  }, [handleRenameCommit]);

  const handleDragStart = useCallback((e: React.DragEvent, server: string, sessionName: string, windowIndex: number, windowId: string, windowName: string) => {
    pinDragImage(e);
    setDragSource({ server, session: sessionName, index: windowIndex });
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ server, session: sessionName, index: windowIndex, windowId, name: windowName }),
    );
    // Marker for foreign drop targets (sidebar board rows — drag-to-pin):
    // dragover can only inspect types (payload is sealed until drop) and
    // application/json is too generic to gate on.
    e.dataTransfer.setData(WINDOW_DRAG_MIME, windowId);
    // Widened from "move": pinning LINKS the window (dual presence), so board
    // rows offer a copy cursor; "move" stays permitted for the reorder/move
    // targets.
    e.dataTransfer.effectAllowed = "copyMove";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, server: string, sessionName: string, windowIndex: number) => {
    if (!dragSource) return;
    // Allow dragover only within the same server + same session (existing
    // within-session reorder semantics). Cross-server is rejected at drop.
    if (dragSource.server !== server || dragSource.session !== sessionName) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget((prev) => {
      if (prev?.server === server && prev?.session === sessionName && prev?.index === windowIndex) return prev;
      return { server, session: sessionName, index: windowIndex };
    });
  }, [dragSource]);

  const handleDrop = useCallback((e: React.DragEvent, server: string, sessionName: string, windowIndex: number) => {
    e.preventDefault();
    setDropTarget(null);
    setDragSource(null);

    let data: { server?: string; session: string; index: number; windowId: string; name: string };
    try {
      data = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }

    // Cross-server drop rejection.
    if (data.server && data.server !== server) {
      addToast("Moving tabs across tmux servers isn't supported yet");
      return;
    }
    if (data.session !== sessionName || data.index === windowIndex) return;
    if (isMovePending) return;

    executeMoveWindow(server, data.session, data.windowId, data.index, windowIndex);
  }, [isMovePending, executeMoveWindow, addToast]);

  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDropTarget(null);
    setSessionDropTarget(null);
  }, []);

  const handleSessionDragOver = useCallback((e: React.DragEvent, server: string, sessionName: string) => {
    if (!dragSource) return;
    // Allow within-server cross-session drag-over preview.
    if (dragSource.server !== server) return;
    if (dragSource.session === sessionName) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setSessionDropTarget({ server, session: sessionName });
  }, [dragSource]);

  const handleSessionDragLeave = useCallback((_e: React.DragEvent, server: string, sessionName: string) => {
    if (sessionDropTarget?.server === server && sessionDropTarget?.session === sessionName) {
      setSessionDropTarget(null);
    }
  }, [sessionDropTarget]);

  const handleSessionDrop = useCallback((e: React.DragEvent, server: string, sessionName: string) => {
    e.preventDefault();
    setSessionDropTarget(null);
    setDropTarget(null);
    setDragSource(null);

    let data: { server?: string; session: string; index: number; windowId: string; name: string };
    try {
      data = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }

    // Cross-server drop rejection.
    if (data.server && data.server !== server) {
      addToast("Moving tabs across tmux servers isn't supported yet");
      return;
    }
    if (data.session === sessionName) return;
    if (isCrossMovePending) return;

    executeMoveToSession(server, data.session, data.index, data.windowId, data.name, sessionName);
  }, [isCrossMovePending, executeMoveToSession, addToast]);

  // Per-server session drag-reorder. Source carries server so the drag is
  // confined to one server's group.
  const handleSessionReorderStart = useCallback((e: React.DragEvent, server: string, name: string, orderedNames: string[]) => {
    pinDragImage(e);
    setSessionDragSource({ server, name });
    e.dataTransfer.setData("application/x-session-reorder", `${server}:${name}`);
    e.dataTransfer.effectAllowed = "move";
    orderOverrideRef.current[server] = orderedNames;
    forceRender();
  }, []);

  const handleSessionReorderOver = useCallback((e: React.DragEvent, server: string, targetName: string, naturalNames: string[]) => {
    if (!sessionDragSource || sessionDragSource.server !== server) return; // source guard: drag confined to one server's group
    if (!e.dataTransfer.types.includes("application/x-session-reorder")) return;
    // Accept the drop BEFORE the self-name check so HTML5 DnD registers the
    // release (no native cancelled-drag snap-back on the dragged row itself,
    // the common terminal hover state under insert-before splicing).
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (sessionDragSource.name === targetName) return; // …then bail: nothing to reorder

    const base = orderOverrideRef.current[server] ?? naturalNames;
    const dragName = sessionDragSource.name;
    const fromIdx = base.indexOf(dragName);
    const toIdx = base.indexOf(targetName);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const next = [...base];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragName);

    if (orderPutTimerRef.current) clearTimeout(orderPutTimerRef.current);
    const orderToPut = next.slice();
    orderPutTimerRef.current = setTimeout(() => {
      orderPutTimerRef.current = null;
      setSessionOrder(server, orderToPut).catch((err) => {
        addToast(err.message || "Failed to save session order");
      });
    }, SESSION_ORDER_DEBOUNCE_MS);

    orderOverrideRef.current[server] = next;
    forceRender();
  }, [sessionDragSource, addToast]);

  const handleSessionReorderEnd = useCallback(() => {
    setSessionDragSource(null);
  }, []);

  const toggleSession = useCallback((server: string, name: string) => {
    // The persistence write MUST stay outside the state updater — the same
    // StrictMode purity constraint `toggleServerSection` documents above: React
    // 19 double-invokes updaters, so a `localStorage.setItem` inside one runs
    // twice and the second pass observes the first pass's write, turning a
    // single click into a net no-op. Derive from the ref, write once, then
    // commit an already-computed value (not an updater function).
    const key = `${server}:${name}`;
    const next = { ...collapsedRef.current };
    if (next[key]) {
      // Expanding drops the entry entirely, keeping the stored map
      // exceptions-only so the (expanded) default keeps applying — and
      // releases the manual-collapse latch so exception and latch stay
      // coherent (two clicks return to the fully unlatched state).
      delete next[key];
      if (manualCollapseLatchRef.current === key) manualCollapseLatchRef.current = null;
    } else {
      next[key] = true;
      // Folding the CURRENT session must take effect immediately: latch it so
      // the derived expand is suppressed until the current session changes.
      if (currentSessionKeyRef.current === key) manualCollapseLatchRef.current = key;
    }
    collapsedRef.current = next;
    writeCollapsedSessions(next);
    setCollapsed(next);
  }, []);

  function handleKill() {
    if (!killTarget) return;
    executeKillFromDialog(killTarget.server, killTarget);
    setKillTarget(null);
  }

  // Bonus a11y: when the mobile drawer opens, land the keyboard user on their
  // current context. Reads `isMobile` + chrome `sidebarOpen` directly (no prop
  // threaded from Shell) and scrolls/focuses the selected window row.
  // Supersedes the focus trap's first-focusable focus when an
  // `[aria-current="page"]` row exists; when none does (board route, fresh
  // session), this is a no-op and the trap's first-focus stands. Mirrors the
  // ServerPanel mount-scroll pattern (server-panel.tsx:77-82). The focus is
  // deferred to the next frame so it runs AFTER the trap's mount-focus
  // (committed in Shell's effect) and wins the same-tick race.
  const isMobile = useIsMobile();
  // Section-visibility rail (iha5): the shared per-section booleans gate the
  // optional sections. Read locally here — nothing threads through the memoized
  // ServerGroup/SessionRow/WindowRow tree (R6a untouched).
  const [boardsSectionVisible] = useSidebarSectionVisible("boards");
  const [serverSectionVisible] = useSidebarSectionVisible("server");
  const [paneSectionVisible] = useSidebarSectionVisible("pane");
  const [hostSectionVisible] = useSidebarSectionVisible("host");
  const { sidebarOpen } = useChromeState();
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    // Scope to a WINDOW row: window rows live under a `[data-window-id]`
    // wrapper (window-row.tsx) and the selected row's button carries
    // `aria-current="page"`. The active BoardsSection row also carries
    // `aria-current="page"` and renders FIRST inside `<nav>`, but it has no
    // `[data-window-id]` ancestor, so it is excluded — on board routes (no
    // selected window) this no-ops and the trap's first-focus stands.
    const row = navRef.current?.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]');
    if (!row) return; // fallback: trap's first-focusable focus stands
    // SF-4: sync the roving cursor to the row we focus so the `tabIndex=0`
    // tab-stop and the focused row do not desync (which would make the next
    // arrow press jump). The roving treeitem is the `[data-window-id]` wrapper;
    // its roving handle is the globally-unique `data-row-key` (`${server}:${windowId}`),
    // NOT the bare `data-window-id` (which collides across open server groups).
    const treeItem = row.closest<HTMLElement>("[data-window-id]");
    const key = treeItem?.getAttribute("data-row-key") ?? null;
    if (key != null) setRovingKey(key);
    const raf = requestAnimationFrame(() => {
      if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
      row.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isMobile, sidebarOpen]);

  // ── Roving-tabindex arrow navigation (W3C APG Tree pattern) ───────────────
  // The roving "cursor" is tracked as a stable ROW KEY (a window row's
  // `data-row-key` = `${server}:${windowId}`, or a session row's
  // `data-session-row` = `${server}:${name}` — both globally unique so the key
  // is unambiguous across multiple open server groups whose tmux ids (@N) repeat)
  // rather than a numeric index, so it survives the visible-rows list growing or
  // shrinking (expand/collapse, SSE adds/removes) without pointing at the wrong
  // row. Exactly one rendered treeitem gets `tabIndex={0}` (the roving row, or
  // the FIRST visible row as a fallback when `rovingKey` matches nothing); the
  // rest get `-1`. Threading only this single string into the memo'd groups
  // means an arrow press changes `tabIndex` on just the two affected rows.
  const treeRef = useRef<HTMLDivElement>(null);
  // Scroll-edge fade (260813-kvk7): while the tree is scrollable AND not at
  // its end, the bottom cut edge fades out (rk-scroll-fade-bottom mask) so
  // partially-clipped rows read as "more below" instead of sliced glyphs.
  const treeHasOverflowBelow = useScrollEdgeFade(treeRef);
  const [rovingKey, setRovingKey] = useState<string | null>(null);

  // Identity lookup for each roving row key. Built per-server inside each
  // ServerGroup (where the MERGED session/window data lives — raw sessionsByServer
  // lacks ghost/rename overlays, so a renamed session's `${server}:${newName}`
  // key would not match a raw-derived map). Each group registers its own slice;
  // the union is read at Enter/Space time to call onSelectWindow/onSelectFirstWindow
  // DIRECTLY with a typed identity — no brittle DOM `.click()` synthesis.
  const rowIdentityRef = useRef<Map<string, Map<string, RowIdentity>>>(new Map());
  // Bumped only when a group's visible-row SET signature changes (window
  // add/remove, collapse/expand, rename) — NOT on the several-per-second passive
  // SSE activity ticks. Gates the roving-key normalization effect so it
  // re-validates only when the set actually changes (Wave-2 #262 invariant: an
  // SSE tick must NOT change roving state).
  const [rowsVersion, bumpRowsVersion] = useReducer((x: number) => x + 1, 0);
  const groupSignatureRef = useRef<Map<string, string>>(new Map());
  const registerGroupRows = useCallback(
    (groupServer: string, signature: string, slice: Map<string, RowIdentity>) => {
      const prev = groupSignatureRef.current.get(groupServer);
      groupSignatureRef.current.set(groupServer, signature);
      rowIdentityRef.current.set(groupServer, slice);
      // Only nudge the normalize effect when this group's set signature changed.
      if (prev !== signature) bumpRowsVersion();
    },
    [],
  );
  // The selection prune's liveness registry, kept SEPARATE from the visible-row
  // one above. Each ServerGroup registers every real window its SSE snapshot
  // knows — collapsed sessions included — so folding a session away never reads
  // as "the window is gone" (260807-nf9f R4). `dataKeysVersion` bumps only when
  // a group's DATA key set changes (a window actually created/killed/moved, a
  // group mounting or unmounting), never on a collapse/expand and never on the
  // several-per-second passive SSE activity ticks.
  const [dataKeysVersion, bumpDataKeysVersion] = useReducer((x: number) => x + 1, 0);
  const groupDataSignatureRef = useRef<Map<string, string>>(new Map());
  const groupDataKeysRef = useRef<Map<string, ReadonlySet<string>>>(new Map());
  const registerGroupDataKeys = useCallback(
    (groupServer: string, signature: string, keys: ReadonlySet<string>) => {
      const prev = groupDataSignatureRef.current.get(groupServer);
      groupDataSignatureRef.current.set(groupServer, signature);
      groupDataKeysRef.current.set(groupServer, keys);
      if (prev !== signature) bumpDataKeysVersion();
    },
    [],
  );

  /** The unmount counterpart to both group registrations. A whole ServerGroup can
   *  leave the tree without any surviving group's signature changing — the
   *  sessions-scope ALL→CURRENT switch, or a server disappearing from the SSE
   *  snapshot. Without this the group's rows stay in `rowIdentityRef`/
   *  `groupDataKeysRef` and its signatures stay registered, so neither version
   *  counter bumps and the downstream consumers gated on them (roving-key
   *  normalization, selection pruning) never re-validate — leaving the departed
   *  group's keys alive in the selection. Dropping every slice and bumping is
   *  what makes those effects fire on the now-smaller tree. */
  const unregisterGroupRows = useCallback((groupServer: string) => {
    // Every delete must run — `||` would short-circuit the rest.
    const hadSignature = groupSignatureRef.current.delete(groupServer);
    const hadSlice = rowIdentityRef.current.delete(groupServer);
    if (hadSignature || hadSlice) bumpRowsVersion();
    const hadDataSignature = groupDataSignatureRef.current.delete(groupServer);
    const hadDataKeys = groupDataKeysRef.current.delete(groupServer);
    if (hadDataSignature || hadDataKeys) bumpDataKeysVersion();
  }, []);

  const identityForKey = useCallback((key: string): RowIdentity | null => {
    for (const slice of rowIdentityRef.current.values()) {
      const id = slice.get(key);
      if (id) return id;
    }
    return null;
  }, []);

  // Read the currently-rendered visible tree rows straight from the DOM — they
  // are emitted in document order, already exclude collapsed sessions' windows
  // (those aren't rendered) and flow continuously across open server groups, so
  // the DOM is the authoritative flattened visible-rows list. Each row exposes
  // its identity via `data-window-id` (window) or `data-session-row` (session).
  const getVisibleRows = useCallback((): HTMLElement[] => {
    const root = treeRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  }, []);

  const rowKeyOf = useCallback((el: HTMLElement): string | null => {
    // `data-row-key` is the GLOBALLY-unique roving handle (window rows carry
    // `${server}:${windowId}`; tmux ids like `@1` are only unique within one
    // server, so the bare `data-window-id` would collide across open groups).
    // Session rows already use the unique `data-session-row` (`${server}:${name}`).
    return el.getAttribute("data-row-key") ?? el.getAttribute("data-session-row");
  }, []);

  // After any render that changed the visible rows, move DOM focus + scroll to
  // the roving row — mirrors the CommandPalette/ThemeSelector
  // "Keyboard-Navigable List Scroll Pattern" (listRef + scrollIntoView nearest).
  // `focusMovedRef` gates the focus() call to user-driven key navigation only,
  // so a passive re-render (SSE tick) never steals focus into the sidebar.
  const focusMovedRef = useRef(false);
  useEffect(() => {
    if (rovingKey === null) return;
    if (!focusMovedRef.current) return;
    focusMovedRef.current = false;
    const root = treeRef.current;
    if (!root) return;
    const sel = `[data-row-key="${CSS.escape(rovingKey)}"], [data-session-row="${CSS.escape(rovingKey)}"]`;
    const row = root.querySelector<HTMLElement>(sel);
    if (!row) return;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    row.focus();
  }, [rovingKey]);

  // ⌘B focus-arm seam (R5): the shell's stateful sidebar chord focuses the
  // current row through this module registry (`lib/sidebar-events.ts`) — no
  // DOM reach-around from shell.tsx. The `focus()` + `setRovingKey` pairing
  // is the mobile drawer-open effect's exact contract: the `tabIndex=0`
  // tab-stop and DOM focus must never desync (the Wave-2 #262 invariant).
  useEffect(() => {
    return registerSidebarRowFocuser(() => {
      const nav = navRef.current;
      if (!nav) return false;
      // Same scoped selector as the mobile drawer effect: window rows live
      // under a `[data-window-id]` wrapper; the active BoardsSection row
      // (aria-current, no such ancestor) is excluded.
      const current = nav.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]');
      if (current) {
        const key = current.closest<HTMLElement>("[data-window-id]")?.getAttribute("data-row-key") ?? null;
        if (key != null) setRovingKey(key);
        if (typeof current.scrollIntoView === "function") current.scrollIntoView({ block: "nearest" });
        current.focus();
        return true;
      }
      // No current window row (board/host routes): land on the tree's
      // current roving tab-stop, else its first row.
      const tree = treeRef.current;
      const row = tree?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
        ?? tree?.querySelector<HTMLElement>('[role="treeitem"]');
      if (!row) return false;
      const key = rowKeyOf(row);
      if (key != null) setRovingKey(key);
      if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
      row.focus();
      return true;
    });
  }, [rowKeyOf]);

  // Escape return (R5): Escape with focus inside the sidebar returns focus
  // to the route's remembered surface WITHOUT hiding — the same resolution
  // the ⌘B hide arm uses (no origin storage; the registered restorer IS the
  // terminal route's restore router — board/host routes register none and
  // blur). Nav-scoped bubble phase, so the tree's selection-clear capture
  // handler and the row flyout's own dismiss get first refusal. Desktop-only:
  // the mobile drawer's focus trap owns Escape (close) there.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return; // a rename input's Escape cancels the rename
      }
      e.preventDefault();
      if (!restoreWindowFocus()) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    };
    nav.addEventListener("keydown", onKey);
    return () => nav.removeEventListener("keydown", onKey);
  }, [isMobile]);

  // Normalize the roving key: when the visible-row SET changes, if the current
  // `rovingKey` matches no rendered treeitem (initial mount, collapse removed it,
  // server switched, rename re-keyed it), reset it to the FIRST visible row so
  // the tree always has exactly one tab stop (`tabIndex={0}`). This is a pure
  // render-follow effect — it does NOT move DOM focus (focusMovedRef stays
  // false), so a passive SSE re-render never pulls focus into the sidebar.
  //
  // Gated on `[rovingKey, rowsVersion]` — `rowsVersion` is bumped ONLY when a
  // group's visible-set signature changes (registerGroupRows), so this does NOT
  // run on the several-per-second passive SSE activity ticks, which would
  // otherwise run a full-tree querySelectorAll and could flip roving state on
  // window churn (the Wave-2 #262 invariant: an SSE tick must NOT change roving
  // state).
  useEffect(() => {
    const rows = getVisibleRows();
    if (rows.length === 0) {
      if (rovingKey !== null) setRovingKey(null);
      return;
    }
    const matched = rovingKey != null && rows.some((r) => rowKeyOf(r) === rovingKey);
    if (!matched) {
      const firstKey = rowKeyOf(rows[0]);
      if (firstKey != null && firstKey !== rovingKey) setRovingKey(firstKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rovingKey, rowsVersion]);

  // Desktop autoscroll: bring the selected window row into view when the
  // selection identity (`${server}:${windowId}`) changes — click, palette, or
  // deep link. Scroll-only: NO focus() (stealing focus on navigation would
  // break terminal typing — the mobile drawer effect above focuses only to
  // beat the focus trap's first-focus) and NO rovingKey write, so roving/focus
  // state is untouched (trivially preserving the Wave-2 #262 invariant).
  //
  // Deep-link retry: on a direct URL load the route resolves before SSE data
  // lands, so the row may not exist yet. `pendingScrollKeyRef` arms when the
  // selection identity changes and clears once the row is found and scrolled;
  // `rowsVersion` (bumped ONLY on visible-row SET changes, never on passive
  // SSE activity ticks) re-runs the attempt. One scroll per selection change —
  // a passive SSE tick can neither re-run this effect nor re-arm the ref.
  // The CURRENT session always renders expanded (the derived override at both
  // `collapsed[` read sites in ServerGroupInner — the exception itself is
  // never mutated), so selecting a window in a collapsed session reveals its
  // rows and the armed ref completes the scroll on that rowsVersion bump. Only
  // a collapsed NON-current group (or the current server's group being closed)
  // keeps the row out of the DOM: no scroll, no auto-expand there; the armed
  // ref then completes the one deferred scroll if the row later appears.
  const selectionKey =
    currentServer !== null && currentWindowId !== null
      ? `${currentServer}:${currentWindowId}`
      : null;
  const pendingScrollKeyRef = useRef<string | null>(null);
  const lastSelectionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectionKey !== lastSelectionKeyRef.current) {
      lastSelectionKeyRef.current = selectionKey;
      pendingScrollKeyRef.current = selectionKey; // null selection disarms
    }
    if (pendingScrollKeyRef.current === null) return;
    // Same scoped selector as the mobile drawer effect: the selected window
    // row's button carries aria-current="page" under a [data-window-id]
    // wrapper; the active BoardsSection row (no such ancestor) is excluded.
    const row = navRef.current?.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]');
    if (!row) return; // not rendered yet (SSE pending / collapsed group) — retry on rowsVersion
    pendingScrollKeyRef.current = null;
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [selectionKey, rowsVersion]);

  // Move the roving cursor to the row at `nextIndex` in the visible-rows list,
  // updating both the key (drives `tabIndex`) and DOM focus.
  const moveRovingTo = useCallback((rows: HTMLElement[], nextIndex: number) => {
    const clamped = Math.max(0, Math.min(nextIndex, rows.length - 1));
    const el = rows[clamped];
    if (!el) return;
    const key = rowKeyOf(el);
    if (key == null) return;
    focusMovedRef.current = true;
    if (key === rovingKey) {
      // Same key (e.g. stop-at-end) — the [rovingKey] effect won't re-fire, so
      // focus/scroll imperatively here to keep the row visible + focused.
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
      el.focus();
      focusMovedRef.current = false;
    } else {
      setRovingKey(key);
    }
  }, [rovingKey, rowKeyOf]);

  // ── Window-row multi-select (260807-nf9f) ─────────────────────────────────
  // Selection state lives in a dedicated store (store/selection-store.ts) — the
  // command palette that ACTS on the selection is composed in app.tsx, outside
  // this subtree, so a shared store (not local state) is the seam. Keys are the
  // composite `${server}:${windowId}` — the same handle as `data-row-key`.
  const selectedWindows = useSelectionStore((s) => s.selected);
  const selectionAnchor = useSelectionStore((s) => s.anchor);
  const toggleSelection = useSelectionStore((s) => s.toggle);
  const selectSelection = useSelectionStore((s) => s.select);
  const clearSelection = useSelectionStore((s) => s.clear);
  const pruneSelectionStore = useSelectionStore((s) => s.prune);

  /** The visible WINDOW rows' selection keys, in DOM (visible-row) order — the
   *  same enumeration the roving navigation walks. Read at gesture time so the
   *  order always matches what the user sees (collapsed sessions contribute
   *  nothing; open server groups flow continuously). Ghost rows carry a
   *  `ghost-` key and are excluded: they have no real windowId to move. */
  const getVisibleWindowKeys = useCallback((): string[] => {
    return getVisibleRows()
      .filter((r) => r.hasAttribute("data-window-id"))
      .map((r) => r.getAttribute("data-row-key"))
      .filter((k): k is string => k != null && !k.includes(":ghost-"));
  }, [getVisibleRows]);

  /** Is this row selectable? Ghost/optimistic rows have no real windowId —
   *  mirrors the SF-3 activation guard on the Enter/Space path. */
  const isSelectableWindow = useCallback((identity: RowIdentity | null): boolean => {
    return identity?.kind === "window" && !identity.ghost && identity.windowId !== "";
  }, []);

  /** Toggle one window row's selection, moving the range anchor onto it. */
  const toggleWindowSelection = useCallback(
    (server: string, windowId: string) => {
      toggleSelection(windowSelectionKey(server, windowId));
    },
    [toggleSelection],
  );

  /** Extend the selection from the anchor to `key` in visible-row order. With no
   *  (or a stale, no-longer-visible) anchor there is no range to extend, so this
   *  degrades to a plain toggle — the standard list-multiselect fallback. */
  const extendSelectionTo = useCallback(
    (key: string) => {
      if (selectionAnchor === null) {
        toggleSelection(key);
        return;
      }
      const range = rangeBetween(getVisibleWindowKeys(), selectionAnchor, key);
      if (range.length === 0) {
        toggleSelection(key);
        return;
      }
      // The anchor stays put so a subsequent shift-click re-extends from the
      // same fixed end (standard range semantics) — `select()` adds keys without
      // touching the anchor, so there is nothing to restore here.
      selectSelection(range);
    },
    [selectionAnchor, getVisibleWindowKeys, toggleSelection, selectSelection],
  );

  /** Modifier-aware row click, passed to every WindowRow as a single stable
   *  identity-arg handler (the memo contract). Returns `true` when the click was
   *  CONSUMED as a selection gesture — the row then does not navigate. A plain
   *  click is never consumed: it navigates as before, and additionally clears a
   *  live selection (the user has moved on). */
  const handleWindowRowClick = useCallback(
    (
      server: string,
      _session: string,
      windowId: string,
      mods: { meta: boolean; ctrl: boolean; shift: boolean },
    ): boolean => {
      if (windowId === "") return false; // ghost row — never selectable
      const key = windowSelectionKey(server, windowId);
      if (mods.shift) {
        extendSelectionTo(key);
        return true;
      }
      if (mods.meta || mods.ctrl) {
        toggleSelection(key);
        return true;
      }
      // Plain click: navigate (not consumed) and drop any live selection.
      clearSelection();
      return false;
    },
    [extendSelectionTo, toggleSelection, clearSelection],
  );

  /** Every window key the SSE snapshot knows for the currently-rendered server
   *  groups, expanded or collapsed. This — NOT the visible-row walk — is the
   *  selection's liveness source: a DOM walk equates "not rendered" with "gone",
   *  so collapsing a session would silently destroy the selection of its still-
   *  live windows, and `Select all merged` (which deliberately selects windows
   *  inside collapsed sessions) would lose them on the next signature change. */
  const getLiveWindowKeys = useCallback((): Set<string> => {
    const live = new Set<string>();
    for (const keys of groupDataKeysRef.current.values()) {
      for (const key of keys) live.add(key);
    }
    return live;
  }, []);

  // Prune selected keys whose windows have genuinely left the SSE data (killed,
  // or their whole server group unmounted). Gated on `dataKeysVersion` — bumped
  // ONLY when a group's DATA key set changes, so a collapse/expand (which
  // changes the visible rows but no window's existence) does not run it at all,
  // and the several-per-second passive SSE activity ticks never reach it. That
  // upholds the load-bearing invariant that an SSE tick must not churn tree
  // state. The store's `prune` performs no write when nothing was dropped.
  useEffect(() => {
    pruneSelectionStore(getLiveWindowKeys());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKeysVersion]);

  // Tree-container keydown. Scoped to the `role="tree"` element (never document,
  // never the terminal), so arrows act only when focus is inside the tree.
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Never hijack arrows/Enter while a rename input (or any editable) is the
    // target — its own onKeyDown commits/cancels and arrows move the caret.
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    ) {
      return;
    }

    const rows = getVisibleRows();
    if (rows.length === 0) return;
    // Anchor navigation on the row the user is ACTUALLY in: inner controls
    // (chevron/name/+) inside a treeitem stay Tab-focusable, so DOM focus can
    // sit in a different row than the one holding tabIndex=0. Prefer the event
    // target's nearest treeitem (matched by object identity, robust to
    // duplicate ids across servers) and fall back to `rovingKey`.
    const anchorRow = target.closest<HTMLElement>('[role="treeitem"]');
    let currentIndex = anchorRow ? rows.indexOf(anchorRow) : -1;
    if (currentIndex === -1) currentIndex = rows.findIndex((r) => rowKeyOf(r) === rovingKey);
    if (currentIndex === -1) currentIndex = 0; // no roving row yet → act from first
    const currentEl = rows[currentIndex];
    const isWindow = currentEl?.hasAttribute("data-window-id") ?? false;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveRovingTo(rows, currentIndex + 1); // stop at end (clamped in moveRovingTo)
        break;
      case "ArrowUp":
        e.preventDefault();
        moveRovingTo(rows, currentIndex - 1); // stop at start
        break;
      case "Home":
        e.preventDefault();
        moveRovingTo(rows, 0);
        break;
      case "End":
        e.preventDefault();
        moveRovingTo(rows, rows.length - 1);
        break;
      case "ArrowRight": {
        e.preventDefault();
        if (isWindow) break; // leaf — no-op
        const rightKey = currentEl ? rowKeyOf(currentEl) : null;
        // The operator placeholder is also a leaf (no aria-expanded) — never
        // treat it as a collapsible session.
        if (rightKey != null && identityForKey(rightKey)?.kind === "operator-placeholder") break;
        const expanded = currentEl?.getAttribute("aria-expanded") === "true";
        if (!expanded) {
          // collapsed session → expand (focus stays on the session row)
          const sep = rightKey?.indexOf(":") ?? -1;
          if (rightKey && sep > -1) toggleSession(rightKey.slice(0, sep), rightKey.slice(sep + 1));
        } else {
          // expanded session → move to first window child (next visible row,
          // which is this session's first window when expanded)
          moveRovingTo(rows, currentIndex + 1);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (isWindow) {
          // window → move to parent session row (scan upward for the nearest
          // level-1 treeitem)
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (rows[i].getAttribute("aria-level") === "1") {
              moveRovingTo(rows, i);
              break;
            }
          }
        } else {
          const expanded = currentEl?.getAttribute("aria-expanded") === "true";
          if (expanded) {
            // expanded session → collapse
            const key = currentEl ? rowKeyOf(currentEl) : null;
            const sep = key?.indexOf(":") ?? -1;
            if (key && sep > -1) toggleSession(key.slice(0, sep), key.slice(sep + 1));
          }
          // collapsed session → no-op (server header is a structural wrapper)
        }
        break;
      }
      case "Enter":
      case " ": { // Space
        e.preventDefault();
        if (!currentEl) break;
        const key = rowKeyOf(currentEl);
        if (key == null) break;
        const identity = identityForKey(key);
        if (!identity) break;
        if (identity.kind === "window") {
          // SF-3: ghost/optimistic rows have no real windowId — activation is a
          // no-op (mirrors the isGhostWindow/dragEnabled guard on the drag path).
          if (identity.ghost || identity.windowId === "") break;
          // SF-2: call the handler DIRECTLY with the typed identity — no brittle
          // DOM `.click()` synthesis or magic-string aria-label coupling.
          onSelectWindow(identity.server, identity.session, identity.windowId);
        } else if (identity.kind === "operator-placeholder") {
          // The operator-less pinned-slot row: activation is the shell-wired
          // drawer opener, never window navigation (there is no window).
          onOperatorPlaceholder?.(identity.server);
        } else {
          // Session row: select its first window (no-op if the session is empty,
          // i.e. no first window to activate).
          if (identity.firstWindowId === "") break;
          onSelectWindow(identity.server, identity.session, identity.firstWindowId);
        }
        break;
      }
      case "x":
      case "X": {
        // Multi-select toggle on the focused WINDOW row (260807-nf9f). `x`
        // rather than Space, which is already bound to activation above.
        // Never hijack a chorded `x` (⌘X / Ctrl+X / Alt+X are cut & friends).
        if (e.metaKey || e.ctrlKey || e.altKey) break;
        if (!currentEl) break;
        const key = rowKeyOf(currentEl);
        if (key == null) break;
        const identity = identityForKey(key);
        // Session rows and ghost/optimistic rows are not selectable (SF-3).
        if (!isSelectableWindow(identity) || identity?.kind !== "window") break;
        e.preventDefault();
        toggleWindowSelection(identity.server, identity.windowId);
        break;
      }
      default:
        break;
    }
  }, [getVisibleRows, rowKeyOf, rovingKey, moveRovingTo, toggleSession, identityForKey, onSelectWindow, onOperatorPlaceholder, isSelectableWindow, toggleWindowSelection]);

  /**
   * Escape-to-clear (260807-nf9f) — a CAPTURE-phase handler, deliberately
   * separate from the bubble-phase `handleTreeKeyDown` above.
   *
   * Why capture: each window row spreads the row-flyout card's floating-ui
   * `referenceProps`, whose `useDismiss` contributes an `onKeyDown` that
   * `stopPropagation()`s Escape while the card is open — and the card OPENS on
   * keyboard row focus (`useFocus`), which is exactly the state a keyboard user
   * clearing a selection is in. A bubble-phase handler on the tree therefore
   * never sees the key. Capture runs before any descendant handler, so the tree
   * gets first refusal.
   *
   * First refusal is not seizure: the handler consumes the event ONLY when there
   * is a selection to clear, and only outside an editable target — so a rename
   * input's Escape-cancels-rename still wins, and an empty-selection Escape
   * passes straight through to the flyout card's own dismiss.
   */
  const handleTreeKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape") return;
      if (selectedWindows.size === 0) return;
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
    },
    [selectedWindows, clearSelection],
  );

  // Stable per-action callbacks passed to every ServerGroup. Each takes the
  // server (and other identity) as a leading argument so a single reference
  // serves all groups — the group binds its own `server`/`session`/`windowId`
  // when it invokes them. This is what makes the React.memo on ServerGroup
  // effective: an SSE session tick changes the per-server data Maps but NOT
  // these handler identities, so unaffected groups skip re-render. (Drag/edit
  // state IS in some deps — that state is not touched by SSE ticks, so the
  // several-times-per-second churn never invalidates them; a real drag does,
  // which is correct and rare.) Follows the existing `toggleSession` pattern.
  const handleSessionRowKill = useCallback((server: string, name: string, count: number, ctrl: boolean) => {
    if (ctrl) {
      executeKillSession(server, name);
      return;
    }
    setKillTarget({ type: "session", server, session: name, windowCount: count });
  }, [executeKillSession]);

  const handleWindowRowKill = useCallback((server: string, session: string, windowId: string, ctrl: boolean) => {
    if (ctrl) {
      executeKillWindow(server, session, windowId);
      return;
    }
    setKillTarget({ type: "window", server, session, windowId, windowCount: 1 });
  }, [executeKillWindow]);

  const handleSessionColorChange = useCallback((server: string, name: string, c: string | null) => {
    setSessionColorApi(server, name, c).catch((err) =>
      addToast(err.message || "Failed to set session color"),
    );
  }, [addToast]);

  const handleWindowColorChange = useCallback((server: string, _session: string, windowId: string, c: string | null) => {
    setWindowColorApi(server, windowId, c).catch((err) =>
      addToast(err.message || "Failed to set tab color"),
    );
  }, [addToast]);

  // Persist a window's flair state. The Label picker's flair section passes
  // the exact picked state ("" → null clears) — this only writes it.
  const handleWindowFlairChange = useCallback((server: string, _session: string, windowId: string, flair: string | null) => {
    setWindowFlairApi(server, windowId, flair).catch((err) =>
      addToast(err.message || "Failed to set tab flair"),
    );
  }, [addToast]);

  // Persist a session's flair state. Mirrors handleSessionColorChange.
  const handleSessionFlairChange = useCallback((server: string, name: string, flair: string | null) => {
    setSessionFlairApi(server, name, flair).catch((err) =>
      addToast(err.message || "Failed to set session flair"),
    );
  }, [addToast]);

  // Server color write seam — the SINGLE implementation both the SERVER-panel
  // tiles and the session-tree group headers funnel through (x4sf): optimistic
  // `serverColors` update (the local repaint — server user-option mutations
  // emit no control-mode event, so covered servers otherwise wait on the 12s
  // safety poll) + POST + failure toast. Stable identity-arg callback so it
  // rides the ServerGroup memo contract like the other row handlers.
  const handleServerColorChange = useCallback((targetServer: string, c: string | null) => {
    setServerColors((prev) => {
      const next = { ...prev };
      if (c == null) { delete next[targetServer]; } else { next[targetServer] = c; }
      return next;
    });
    setServerColorApi(targetServer, c).catch((err) =>
      addToast(err.message || "Failed to set server color"),
    );
  }, [addToast]);

  // Server flair write seam — mirrors handleServerColorChange (the x4sf
  // funnel): optimistic `serverFlairs` update + POST + failure toast. Stable
  // identity-arg callback for the ServerGroup memo contract.
  const handleServerFlairChange = useCallback((targetServer: string, f: string | null) => {
    setServerFlairs((prev) => {
      const next = { ...prev };
      if (f == null || f === "") { delete next[targetServer]; } else { next[targetServer] = f; }
      return next;
    });
    setServerFlairApi(targetServer, f == null || f === "" ? null : f).catch((err) =>
      addToast(err.message || "Failed to set server flair"),
    );
  }, [addToast]);

  // Server protect write seam for the SERVER-panel tile card — POST + refresh
  // + failure toast, mirroring handleServerColorChange. Stable identity-arg
  // callback. (The group header's card toggle stays context-derived inside
  // ServerGroupInner, keyed off the same payload flag.)
  const handleServerProtectToggle = useCallback((targetServer: string, next: boolean) => {
    void setServerProtected(targetServer, next)
      .then(() => refreshServers())
      .catch((err: unknown) => {
        addToast(err instanceof Error ? err.message : "Failed to update server protection");
      });
  }, [refreshServers, addToast]);

  // `current` scope narrows to the resolved current server. When no current
  // server resolves — board route (`currentServer === null`) or a
  // stale/deleted route param not in the list — fall back to showing all
  // servers: never an empty pane or a dead-end hint. Shared by the scope
  // chip's tooltip and the session-tree filter so they can't disagree.
  const currentOnly =
    sessionsScope === "current" &&
    currentServer !== null &&
    servers.some((s) => s.name === currentServer);

  return (
    // TipGroup: the sidebar is one warm-tip cluster (260722-73al) — sweeping
    // across its tipped controls (scope chip, PANE refresh, waiting badges)
    // opens sibling tips instantly.
    <TipGroup>
    <nav ref={navRef} aria-label="Sessions" className="flex flex-col h-full">
      {/* Brand row — logo + wordmark linking home (`/`). MOBILE-ONLY: on
          phones this is the brand's ONLY surface (the top-bar brand crumb
          hides below `sm`) and the sole pointer home affordance there; on
          desktop the brand lives in the top bar's sidebar head while the
          sidebar is open (and in the bar's left crumb while it is closed), so
          the row is not rendered and the section rail is the sidebar's first
          row. Carries the same glitch + ring-sweep hover treatments.
          Accessible name comes from the wordmark text ("HexoKit") —
          deliberately NOT the top-bar's "HexoKit home" aria-label, which e2e
          selects by label and must stay unique on desktop. */}
      {isMobile && <SidebarBrand />}

      {/* Section-visibility rail (iha5) — the sidebar's first row on desktop,
          first below the brand row on mobile; toggles the optional sections
          below. Not self-hideable; Sessions has no toggle. */}
      <SectionRail />

      {/* Boards — cross-server section, visibility-gated (default on; renders
          an empty-state hint when no boards exist). Boards are curated
          workspaces; placing them above Servers reflects their
          higher-affinity destination role. */}
      {boardsSectionVisible && <BoardsSection />}

      {/* Server panel — collapsible, visibility-gated (default on). The set of
          servers is the same multi-server list, so this stays below Boards
          regardless of route. */}
      {serverSectionVisible && (
      <ServerPanel
        server={currentServer ?? ""}
        servers={servers}
        serverColors={serverColors}
        serverFlairs={serverFlairs}
        waitingCounts={waitingCounts}
        rowTints={rowTints}
        rowBorders={rowBorders}
        onSwitchServer={handleSwitchServer}
        onCreateServer={onCreateServer}
        onRefreshServers={refreshServers}
        onServerColorChange={handleServerColorChange}
        onCreateSession={onCreateSession}
        onKillServer={onKillServer}
        onToggleServerProtect={handleServerProtectToggle}
        onSidebarResizeStart={onSidebarResizeStart}
      />
      )}

      {/* Sessions — flex-grows to fill remaining space; per-server groups inside */}
      <div className="border-t-[3px] border-border flex flex-col flex-1 min-h-0">
        <div className="flex items-center gap-1.5 w-full pl-1.5 pr-1.5 sm:pr-2 py-1 text-xs text-text-secondary shrink-0 border-b border-border">
          <TypedLabel text="Sessions" className="font-bold uppercase tracking-wide" />
          <span className="ml-auto flex items-center gap-1.5 min-w-0">
            {currentServer && currentSession && (
              <span className="truncate text-text-primary font-mono">{currentSession}</span>
            )}
            {/* Scope chip — readable at rest so a `current`-filtered list never
                looks like servers vanished. Flips the persisted scope; the
                session list re-renders via the shared hook's pub/sub. */}
            {/* The old three-way sentence title is rewritten to a short
                action label (tier-1 ≤40ch cap, 260722-73al): the tip names
                what a CLICK does, the chip text (ALL/CUR) shows the state. */}
            <Tip
              label={
                sessionsScope === "all" ? "Show current server only" : "Show all servers"
              }
            >
              <button
                type="button"
                onClick={() => setSessionsScope(sessionsScope === "all" ? "current" : "all")}
                aria-label="Toggle sessions scope"
                aria-pressed={sessionsScope === "current"}
                className="shrink-0 font-mono text-[10px] leading-none tracking-wide px-1 py-0.5 border border-border rounded-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
              >
                {sessionsScope === "all" ? "ALL" : "CUR"}
              </button>
            </Tip>
          </span>
        </div>
        <div
          ref={treeRef}
          role="tree"
          data-sidebar-scroll=""
          aria-label="Session tree"
          // W3C-APG multiselect tree (260807-nf9f): window rows can be selected
          // as a set (cmd/ctrl-click, shift-click range, `x`) for the palette's
          // bulk move-to-session. Session/server rows stay unselectable.
          aria-multiselectable="true"
          onKeyDownCapture={handleTreeKeyDownCapture}
          onKeyDown={handleTreeKeyDown}
          className={`flex-1 min-h-0 overflow-y-auto${treeHasOverflowBelow ? " rk-scroll-fade-bottom" : ""}`}
        >
          {(() => {
            if (servers.length === 0) {
              return <div className="text-text-secondary text-xs py-4 text-center">No servers</div>;
            }
            // `currentOnly` (hoisted above the JSX) narrows to the resolved
            // current server, with the no-current-server fallback to all.
            const visibleServers = currentOnly
              ? servers.filter((s) => s.name === currentServer)
              : servers;
            return visibleServers.map((srvInfo) => {
              // Derive the displayed order per server: override ?? SSE order.
              // Per-server SSE-echo clear (no whole-Map effect): once the SSE
              // order for THIS server element-wise equals the stored override,
              // the round-trip has landed — drop the override so the row reads
              // the authoritative SSE order. Mutating the ref during render is
              // safe (it is not state); when equal we render `null` anyway, so
              // the displayed output is unchanged and no render nudge is needed.
              const sseOrder = ctx.sessionOrderByServer.get(srvInfo.name) ?? [];
              const override = orderOverrideRef.current[srvInfo.name];
              let localOrder: string[] | null = override ?? null;
              if (override && arraysEqual(override, sseOrder)) {
                delete orderOverrideRef.current[srvInfo.name];
                localOrder = null;
              }
              return (
              <ServerGroup
                key={srvInfo.name}
                server={srvInfo.name}
                isCurrent={srvInfo.name === currentServer}
                serverColor={serverColors[srvInfo.name]}
                serverFlair={serverFlairs[srvInfo.name]}
                rowTints={rowTints}
                rowBorders={rowBorders}
                isOpen={currentOnly ? true : readServerOpen(srvInfo.name)}
                onToggleOpen={toggleServerSection}
                rawSessions={sessionsByServer.get(srvInfo.name) ?? []}
                sessionOrder={sseOrder}
                localOrder={localOrder}
                isConnected={isConnectedByServer.get(srvInfo.name) ?? false}
                // The manual-collapse latch suppresses the derived expand by
                // withholding the current session's name — the read sites in
                // ServerGroupInner then treat it like any non-current session.
                currentSessionName={srvInfo.name === currentServer && !manualCollapseLatched ? currentSession : null}
                currentWindowId={srvInfo.name === currentServer ? currentWindowId : null}
                rovingKey={rovingKey}
                registerGroupRows={registerGroupRows}
                registerGroupDataKeys={registerGroupDataKeys}
                unregisterGroupRows={unregisterGroupRows}
                editingWindow={editingWindow?.server === srvInfo.name ? editingWindow : null}
                editingName={editingName}
                inputRef={inputRef}
                editingSession={editingSession?.server === srvInfo.name ? editingSession.name : null}
                editingSessionName={editingSessionName}
                sessionInputRef={sessionInputRef}
                sessionDragSource={sessionDragSource?.server === srvInfo.name ? sessionDragSource.name : null}
                dragSource={dragSource?.server === srvInfo.name ? dragSource : null}
                dropTarget={dropTarget?.server === srvInfo.name ? dropTarget : null}
                sessionDropTarget={sessionDropTarget?.server === srvInfo.name ? sessionDropTarget.session : null}
                allBoards={allBoards}
                boardsLoading={boardsLoading}
                pinnedSet={pinnedSet}
                pinnedToBoard={pinnedToBoard}
                boardForWindow={boardForWindow}
                isPinnedToActiveBoardFor={isPinnedToActiveBoardFor}
                onNavigateToBoard={onNavigateToBoard}
                collapsed={collapsed}
                selectedWindows={selectedWindows}
                onWindowRowClick={handleWindowRowClick}
                onToggleSession={toggleSession}
                onSelectWindow={onSelectWindow}
                onWaitingBadgeClick={onWaitingBadgeClick}
                onCreateWindow={onCreateWindow}
                onCreateSession={onCreateSession}
                onSpawnAgent={onSpawnAgent}
                onUpdateAnnotations={onUpdateAnnotations}
                onSessionRowKill={handleSessionRowKill}
                onWindowRowKill={handleWindowRowKill}
                onSessionStartEditing={handleStartSessionEditing}
                onSessionRenameKeyDown={handleSessionRenameKeyDown}
                onSessionRenameBlur={handleSessionRenameBlur}
                onSessionNameChange={setEditingSessionName}
                onWindowStartEditing={handleStartEditing}
                onWindowNameChange={setEditingName}
                onWindowRenameKeyDown={handleWindowRenameKeyDown}
                onWindowRenameBlur={handleWindowRenameBlur}
                onSessionColorChange={handleSessionColorChange}
                onServerColorChange={handleServerColorChange}
                onServerFlairChange={handleServerFlairChange}
                onKillServer={onKillServer}
                onWindowColorChange={handleWindowColorChange}
                onSessionFlairChange={handleSessionFlairChange}
                onWindowFlairChange={handleWindowFlairChange}
                onWindowMarkerChange={onWindowMarkerChange}
                onForkWindow={onForkWindow}
                onFixTabName={onFixTabName}
                onOperatorCompose={onOperatorCompose}
                onOperatorPlaceholder={onOperatorPlaceholder}
                onWindowDragStart={handleDragStart}
                onWindowDragOver={handleDragOver}
                onWindowDrop={handleDrop}
                onWindowDragEnd={handleDragEnd}
                onSessionDragOver={handleSessionDragOver}
                onSessionDragLeave={handleSessionDragLeave}
                onSessionDrop={handleSessionDrop}
                onSessionReorderStart={handleSessionReorderStart}
                onSessionReorderOver={handleSessionReorderOver}
                onSessionReorderEnd={handleSessionReorderEnd}
              />
              );
            });
          })()}
        </div>
        {/* Selection count indicator (260807-nf9f) — a minimal, NON-interactive
            strip shown only while the window-row selection is non-empty. No
            buttons and no action strip by design: the command palette is the
            sole action surface (Constitution IV minimal surface + V palette
            primary), so this only reports the count and names the two ways out.
            `role="status"` so the count change is announced.
            `hasSelectionActions` is keyed on a non-null `currentServer`: the
            `Selection:` family is current-server-scoped and composed in
            `app.tsx`, while the board route mounts this tree with
            `currentServer={null}` and its own `boardRouteActions` palette — so
            there the "to act" hint would point at commands that do not exist. */}
        <SelectionIndicator
          count={selectedWindows.size}
          hasSelectionActions={currentServer !== null}
        />
      </div>

      {/* Status panels — visibility-gated per section (iha5 R5): the PANE and
          HOST panels mount independently under their own rail/palette toggles
          on EVERY viewport. Both default OFF, so the default rendering matches
          the pre-rail behavior (260814-ldbs's drawer-only fork becomes a
          default, not a hard `isMobile` gate) — a desktop user can now opt
          back in, and the mobile drawer is pure nav + footer by default.
          Toggle-off fully unmounts the panel; its CollapsiblePanel
          collapse/height storage keys are untouched, so re-toggling restores
          the section exactly as left. */}
      {(paneSectionVisible || hostSectionVisible) && (
        <BottomPanels
          showPane={paneSectionVisible}
          showHost={hostSectionVisible}
          currentServer={currentServer}
          currentSessionName={currentSession}
          currentWindowId={currentWindowId}
        />
      )}

      {/* Footer — a passive status row (260812-d1at): LEFT = readouts
          (connection dot + version), RIGHT = a quiet status/hints slot
          (update-available hint only). The action chips relocated to the top
          bar (gear chip + chevron-menu App rows). MOBILE-ONLY (NOT part of the
          section-visibility rail): on desktop the full-width status bar owns
          the dot + version and the UpdateChip owns the update surface, so the
          footer would be a third copy; the mobile drawer has no status bar, so
          it keeps the footer byte-identical. */}
      {isMobile && <SidebarFooter isConnected={isConnected} />}

      {/* Kill confirmation */}
      {killTarget && (
        <KillDialog
          killTarget={killTarget}
          onConfirm={handleKill}
          onCancel={() => setKillTarget(null)}
        />
      )}
    </nav>
    </TipGroup>
  );
}

/**
 * Window-row multi-select count indicator (260807-nf9f) — the sidebar's only
 * selection chrome. Deliberately NON-INTERACTIVE: it holds no buttons and no
 * action strip, because the command palette is the sole action surface for the
 * selection (Constitution IV minimal surface area + V keyboard-first, ⌘K as the
 * primary discovery mechanism). It reports the live count and names the two
 * routes out — the palette chord to act, Esc to clear — plus the `x`
 * row-toggle.
 *
 * `x` is named here as well as on the palette entries' shortcut badge because
 * it is a bare key handled inside the tree's own keydown (deliberately not a
 * global chord in `DEFAULT_BINDINGS`, which would hijack `x` app-wide), so it
 * surfaces on no chord map and in no shortcuts overlay. This strip is the one
 * place a user is already looking while building a selection, which is exactly
 * when the keyboard alternative to Cmd-clicking is worth learning.
 *
 * The palette chord is DERIVED, never hard-coded: it is platform-dependent
 * (⌘K on mac, Ctrl+K elsewhere) and user-rebindable, so it comes from the
 * HOST-effective `command-palette` binding via the same
 * `useKeybindings()` + `formatCombo` derivation the top-bar gear and menu-row
 * keycaps use (260812-d1at). The "to act" clause is omitted entirely when that
 * binding is unbound or disabled, or when the mounting route has no
 * `Selection:` palette actions (`hasSelectionActions={false}` — the board
 * route, whose palette is `boardRouteActions`): advertising a route to an
 * action surface that cannot act would be a lie either way.
 *
 * Renders nothing while the selection is empty, so it costs no vertical space
 * in the resting sidebar. `role="status"` (polite by default) announces the
 * count as it changes without stealing focus.
 */
function SelectionIndicator({
  count,
  hasSelectionActions,
}: {
  count: number;
  hasSelectionActions: boolean;
}) {
  // ⇧click extension and the palette chord are keyboard/mouse affordances —
  // neither hint renders on coarse pointers (the app's chord-hints-off-touch
  // rule, 260811-ke2s).
  const coarsePointer = useCoarsePointer();
  const { byAction: keybindingsByAction, host: keybindingHost } = useKeybindings();
  const paletteBinding = keybindingsByAction.get("command-palette");
  const paletteChord =
    !coarsePointer && paletteBinding?.enabled
      ? formatCombo({ code: paletteBinding.code, tier: paletteBinding.tier }, keybindingHost.platform)
      : undefined;
  if (count === 0) return null;
  return (
    <div
      role="status"
      data-testid="selection-indicator"
      className="shrink-0 border-t border-border px-2 py-1 text-[10px] font-mono text-text-secondary truncate"
    >
      <span className="text-text-primary">{count} selected</span>
      {coarsePointer ? "" : " · ⇧click extends"}
      {" · x to toggle"}
      {hasSelectionActions && paletteChord ? ` · ${paletteChord} → Selection:` : ""}
      {" · Esc to clear"}
    </div>
  );
}

/**
 * Sidebar footer — a passive status row (260812-d1at), rendered ONLY in the
 * mobile drawer: desktop's full-width status bar already owns the dot +
 * version (and the UpdateChip + overflow version row own the update path), so
 * the desktop sidebar renders no footer. `justify-between`:
 *
 *  - LEFT — passive readouts (a status segment): the connection dot (same
 *    per-page `isConnected` semantics, markup, and aria as ever) and the
 *    resting version line (`v0.9.3`, click-to-copy with the overflow menu's
 *    toast pattern; renders nothing until the daemon reports a version —
 *    never `vundefined`). The overflow menu's fixed version row is unchanged
 *    and remains the update surface; this is a readout only.
 *  - RIGHT — a truncating, non-interactive status/hints span filling the
 *    remaining row width. Deliberately quiet: it shows an accent-green
 *    `v{latest} available` hint only while `useUpdateNotification()` reports
 *    a qualifying update, and renders NOTHING otherwise (no resting copy —
 *    Constitution IV).
 *
 * The four action chips (Help · Keyboard · Theme · Gear) LEFT this row in
 * 260812-d1at: Settings is a top-bar right-cluster gear chip and Help /
 * Keyboard / Theme are chevron-menu App-section rows (§ top-bar.tsx); the
 * palette entries stay the always-available keyboard path (Constitution V).
 * Tips use `placement="top"` since the row hugs the viewport bottom.
 */
/** Brand row at the sidebar's top — mobile-only; see the render-site comment
 *  for the phone-vs-desktop role split (on desktop the brand lives in the top
 *  bar's sidebar head). A plain anchor (full navigation), matching the
 *  top-bar brand crumb's reload-boundary behavior. */
function SidebarBrand() {
  const sweep = useBrandLogoSweep();
  return (
    <a
      href="/"
      className="rk-brand-glitch flex items-center gap-2 px-1.5 py-1 min-h-[28px] coarse:min-h-[40px] shrink-0 border-b border-border text-text-secondary hover:text-text-primary transition-colors"
      onMouseEnter={sweep.onMouseEnter}
    >
      <LogoSpinner size={18} loading={false} svgRef={sweep.svgRef} />
      <span className="text-xs font-bold tracking-wide">HexoKit</span>
    </a>
  );
}

function SidebarFooter({ isConnected }: { isConnected: boolean }) {
  const { daemonVersion, qualifies, singleRunKit, latest, tools } = useUpdateNotification();
  const { addToast } = useToast();

  // Same title derivation the top-bar dot carried: extend "Connected" with the
  // running version once known (hover-discovery detail; the aria-label stays
  // the concise Connected/Disconnected on the live region).
  const dotTitle = !isConnected
    ? "Disconnected"
    : daemonVersion
      ? `Connected — HexoKit ${displayVersion(daemonVersion)}`
      : "Connected";

  const versionText = daemonVersion ? displayVersion(daemonVersion) : null;
  const handleCopyVersion = () => {
    if (!daemonVersion) return;
    void copyToClipboard(displayVersion(daemonVersion)).then((ok) => {
      addToast(ok ? "Version copied" : "Copy failed", ok ? "info" : "error");
    });
  };

  // The status slot's only content policy so far: a quiet update hint. A
  // readout, never a link/button — the overflow menu's version row remains
  // the update surface.
  const updateHint = qualifies
    ? singleRunKit && latest
      ? `v${latest} available`
      : `${tools.length} updates available`
    : null;

  return (
    <div className="shrink-0 border-t border-border px-2 py-1 flex items-center justify-between">
      {/* LEFT — passive readouts: connection dot + version. */}
      <span className="flex items-center gap-1.5 min-w-0">
        {/* Connection dot — moved from the top bar (260724-6j1v). Hover-only
            tip; the dot stays a non-focusable span (a status readout, not an
            actionable control — no tab stop added). */}
        <span role="status" aria-live="polite" className="inline-flex">
          <Tip label={dotTitle} placement="top">
            <span
              className={`block w-2 h-2 rounded-full ${
                isConnected ? "bg-accent-green" : "bg-text-secondary"
              }`}
              aria-label={isConnected ? "Connected" : "Disconnected"}
            />
          </Tip>
        </span>
        {versionText && (
          <Tip label="Copy version" placement="top">
            <button
              type="button"
              onClick={handleCopyVersion}
              aria-label={`HexoKit ${versionText} (copy)`}
              className="text-[10px] text-text-secondary hover:text-text-primary transition-colors truncate"
            >
              {versionText}
            </button>
          </Tip>
        )}
      </span>

      {/* RIGHT — the status/hints slot: quiet by default (empty at rest). */}
      {updateHint && (
        <span className="flex-1 min-w-0 truncate text-right text-[10px] text-accent-green">
          {updateHint}
        </span>
      )}
    </div>
  );
}

/** Bottom of sidebar: WindowPanel (selected window status) + HostPanel (metrics).
 *  Pulls from context so the data follows `currentServer`. On the board route
 *  (`currentServer === null`) the route provides no window, so the PANE panel
 *  follows the board's focused tile via the focused-pane context instead
 *  (260720-zx4i). */
function BottomPanels({
  showPane,
  showHost,
  currentServer,
  currentSessionName,
  currentWindowId,
}: {
  /** Per-section visibility toggles (iha5) — each panel mounts independently
   *  under its own boolean, on every viewport. */
  showPane: boolean;
  showHost: boolean;
  currentServer: string | null;
  currentSessionName: string | null;
  currentWindowId: string | null;
}) {
  const ctx = useSessionContext();
  const focusedPane = useFocusedPane();
  const sessions = currentServer ? ctx.sessionsByServer.get(currentServer) ?? [] : [];
  const routeSession = currentSessionName && currentWindowId != null
    ? sessions.find((s) => s.name === currentSessionName) ?? null
    : null;
  const routeWindow = routeSession?.windows.find((w) => w.windowId === currentWindowId) ?? null;
  // Focused-tile fallback (board route): resolve the published focused pane to
  // its fully-enriched home-session copy by windowId (dual home+pin membership
  // keeps it in the sessions stream); a miss means a pin-only window (home
  // session died), which gets a thin render from the board entry's own pane
  // data — registers honestly absent. Gated on the board route itself
  // (`currentServer === null`), NOT on `!routeWindow` — on a server route a
  // temporarily-unresolved route window (sessions snapshot not yet arrived)
  // must show the empty state, never a stale board-focused window.
  const fallbackSessions = !currentServer && focusedPane
    ? ctx.sessionsByServer.get(focusedPane.server) ?? []
    : [];
  const fallbackSession = focusedPane
    ? fallbackSessions.find((s) => s.windows.some((w) => w.windowId === focusedPane.windowId)) ?? null
    : null;
  const fallbackWindow = !currentServer && focusedPane
    ? fallbackSession?.windows.find((w) => w.windowId === focusedPane.windowId) ??
      thinWindowFromFocusedPane(focusedPane)
    : null;
  const selectedWindow = routeWindow ?? fallbackWindow;
  // The `opr` register reads the OWNING session's operator-watchdog facts
  // (verbatim — the threshold is server-derived); the thin pin-only fallback
  // has no owning session, so its facts are honestly absent.
  const operatorSession = routeSession ?? fallbackSession;
  const operator = selectedWindow && operatorSession
    ? { stale: operatorSession.operatorStale === true, lastTickAt: operatorSession.operatorLastTickAt }
    : undefined;
  return (
    <>
      {showPane && <WindowPanel window={selectedWindow} operator={operator} />}
      {showHost && <HostPanel />}
    </>
  );
}

/** Per-server group — renders the group header + the sessions tree. The
 *  rendering logic mirrors the legacy single-server sidebar; per-server props
 *  are threaded through from the parent. */
type ServerGroupProps = {
  server: string;
  isCurrent: boolean;
  serverColor: string | undefined;
  /** The server's flair token (universal set), or undefined when unset. Threads
   *  as a scalar like `serverColor` so the row-tree memoization is preserved. */
  serverFlair: string | undefined;
  rowTints: Map<string, import("@/themes").RowTint>;
  rowBorders: Map<string, string>;
  isOpen: boolean;
  onToggleOpen: (server: string) => void;
  rawSessions: ProjectSession[];
  sessionOrder: string[];
  localOrder: string[] | null;
  isConnected: boolean;
  currentSessionName: string | null;
  currentWindowId: string | null;
  /** Roving-tabindex cursor key (a window row's `data-row-key` =
   *  `${server}:${windowId}`, or a session row's `${server}:${name}`). The
   *  single row whose key matches gets `tabIndex={0}`; all others `-1`. A single
   *  string prop keeps the memo tree intact — an arrow press flips `tabIndex`
   *  on only the two affected rows. */
  rovingKey: string | null;
  /** Register this group's visible-row identity slice + a set-signature with the
   *  parent. Called from an effect after each render so the parent's
   *  union lookup (Enter/Space activation) and the roving-key normalization
   *  effect stay in sync with the MERGED rows actually painted. */
  registerGroupRows: (server: string, signature: string, slice: Map<string, RowIdentity>) => void;
  /** Register this group's DATA window keys (`${server}:${windowId}` for every
   *  real window the SSE snapshot knows for this server, expanded or collapsed)
   *  plus a set-signature. This is the selection prune's liveness source —
   *  deliberately separate from `registerGroupRows`, whose signature tracks the
   *  VISIBLE rows and therefore changes on every collapse/expand. */
  registerGroupDataKeys: (server: string, signature: string, keys: ReadonlySet<string>) => void;
  /** Unmount counterpart to BOTH registrations — drops this group's identity
   *  slice + row signature and its data-key slice + data signature, bumping the
   *  parent's `rowsVersion` and `dataKeysVersion` so the effects gated on them
   *  (roving-key normalization, selection pruning) re-validate against the
   *  now-smaller tree. Without it, a whole group leaving the tree
   *  (sessions-scope ALL→CURRENT, a server disappearing) would bump nothing and
   *  its rows' keys would linger in the selection. */
  unregisterGroupRows: (server: string) => void;

  editingWindow: { server: string; session: string; windowId: string } | null;
  editingName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  editingSession: string | null;
  editingSessionName: string;
  sessionInputRef: React.RefObject<HTMLInputElement | null>;
  sessionDragSource: string | null;
  dragSource: { server: string; session: string; index: number } | null;
  dropTarget: { server: string; session: string; index: number } | null;
  sessionDropTarget: string | null;

  allBoards: ReturnType<typeof useWindowPins>["boards"];
  boardsLoading: boolean;
  pinnedSet: Set<string>;
  pinnedToBoard: (board: string, server: string, windowId: string) => boolean;
  /** Reverse lookup: the single board a window is pinned to (co9z), or undefined
   *  if unpinned. Powers the pinned-row → board navigation affordance. Stable. */
  boardForWindow: (server: string, windowId: string) => string | undefined;
  isPinnedToActiveBoardFor: (winServer: string, windowId: string) => boolean;
  /** Navigate to a board's route (`/board/{board}`). Stable identity. */
  onNavigateToBoard: (board: string) => void;
  collapsed: Record<string, boolean>;
  /** The bulk multi-select (260807-nf9f), as composite `${server}:${windowId}`
   *  keys. A stable Set reference from the selection store — it changes identity
   *  only when the selection actually changes, so it does NOT churn the memo on
   *  an SSE tick. */
  selectedWindows: ReadonlySet<string>;
  /** Modifier-aware row-click seam for the multi-select. Stable identity-arg
   *  callback, forwarded verbatim to every `WindowRow`. */
  onWindowRowClick: (
    server: string,
    session: string,
    windowId: string,
    mods: { meta: boolean; ctrl: boolean; shift: boolean },
  ) => boolean;

  onToggleSession: (server: string, name: string) => void;
  onSelectWindow: (server: string, session: string, windowId: string) => void;
  onWaitingBadgeClick?: (server: string, session: string) => void;
  onCreateWindow: (server: string, session: string) => void;
  onCreateSession: (server: string) => void;
  onSpawnAgent?: (server: string, session: string) => void;
  /** Forwarded to each `SessionRow` → its coarse session card's Update
   *  annotations row. Optional (the board-route sidebar passes none) — see
   *  `SidebarProps.onUpdateAnnotations`. */
  onUpdateAnnotations?: (server: string, session: string) => void;
  onSessionRowKill: (server: string, name: string, windowCount: number, ctrl: boolean) => void;
  onWindowRowKill: (server: string, session: string, windowId: string, ctrl: boolean) => void;
  onSessionStartEditing: (server: string, name: string) => void;
  onSessionRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSessionRenameBlur: () => void;
  onSessionNameChange: (value: string) => void;
  onWindowStartEditing: (server: string, session: string, windowId: string, currentName: string) => void;
  onWindowNameChange: (value: string) => void;
  onWindowRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onWindowRenameBlur: () => void;
  onSessionColorChange: (server: string, name: string, color: string | null) => void;
  /** Server color write seam (x4sf) — the same shared handler `ServerPanel`
   *  receives (optimistic update + POST + toast). Stable identity. */
  onServerColorChange: (server: string, color: string | null) => void;
  /** Server flair write seam — mirrors `onServerColorChange` (optimistic
   *  update + POST + toast). Stable identity. */
  onServerFlairChange: (server: string, flair: string | null) => void;
  /** Kill-server request (x4sf) — routes to the parent's confirmation dialog
   *  (`killServerTarget` in app.tsx / board-page.tsx); never kills directly. */
  onKillServer: (name: string) => void;
  onWindowColorChange: (server: string, session: string, windowId: string, color: string | null) => void;
  onWindowMarkerChange?: (
    server: string,
    session: string,
    windowId: string,
    marker: string | null,
  ) => void;
  /** Flair write seams — the picker's flair section funnels through these.
   *  Both are stable identity-argument callbacks. */
  onSessionFlairChange: (server: string, name: string, flair: string | null) => void;
  onWindowFlairChange: (server: string, session: string, windowId: string, flair: string | null) => void;
  /** Forwarded to each `WindowRow` → its row flyout's fork affordance. Optional
   *  (the board-route sidebar passes none) — see `SidebarProps.onForkWindow`. */
  onForkWindow?: (server: string, windowId: string) => Promise<void>;
  /** Forwarded to each `WindowRow` → its row flyout's Fix tab name affordance.
   *  Optional (the board-route sidebar passes none) — see
   *  `SidebarProps.onFixTabName`. */
  onFixTabName?: (server: string, windowId: string) => Promise<void>;
  /** Forwarded ONLY to the pinned operator row's `WindowRow` → its trailing
   *  compose icon (260822-wyn3). Optional — see `SidebarProps.onOperatorCompose`. */
  onOperatorCompose?: (server: string) => void;
  /** The operator-less pinned slot's activation (the placeholder row).
   *  Optional — see `SidebarProps.onOperatorPlaceholder`; when omitted no
   *  placeholder renders. */
  onOperatorPlaceholder?: (server: string) => void;
  onWindowDragStart: (e: React.DragEvent, server: string, session: string, index: number, windowId: string, name: string) => void;
  onWindowDragOver: (e: React.DragEvent, server: string, session: string, index: number) => void;
  onWindowDrop: (e: React.DragEvent, server: string, session: string, index: number) => void;
  onWindowDragEnd: () => void;
  onSessionDragOver: (e: React.DragEvent, server: string, session: string) => void;
  onSessionDragLeave: (e: React.DragEvent, server: string, session: string) => void;
  onSessionDrop: (e: React.DragEvent, server: string, session: string) => void;
  onSessionReorderStart: (e: React.DragEvent, server: string, name: string, orderedNames: string[]) => void;
  onSessionReorderOver: (e: React.DragEvent, server: string, targetName: string, naturalNames: string[]) => void;
  onSessionReorderEnd: () => void;
};

function ServerGroupInner(props: ServerGroupProps) {
  const {
    server,
    isCurrent,
    serverColor,
    serverFlair,
    rowTints,
    rowBorders,
    isOpen,
    onToggleOpen,
    rawSessions,
    sessionOrder,
    localOrder,
    currentSessionName,
    currentWindowId,
    rovingKey,
    registerGroupRows,
    registerGroupDataKeys,
    unregisterGroupRows,
    editingWindow,
    editingName,
    inputRef,
    editingSession,
    editingSessionName,
    sessionInputRef,
    sessionDragSource,
    dragSource,
    dropTarget,
    sessionDropTarget,
    allBoards,
    boardsLoading,
    pinnedSet,
    pinnedToBoard,
    boardForWindow,
    isPinnedToActiveBoardFor,
    onNavigateToBoard,
    collapsed,
    selectedWindows,
    onWindowRowClick,
    onToggleSession,
    onSelectWindow,
    onWaitingBadgeClick,
    onCreateWindow,
    onCreateSession,
    onSpawnAgent,
    onUpdateAnnotations,
    onSessionRowKill,
    onWindowRowKill,
    onSessionStartEditing,
    onSessionRenameKeyDown,
    onSessionRenameBlur,
    onSessionNameChange,
    onWindowStartEditing,
    onWindowNameChange,
    onWindowRenameKeyDown,
    onWindowRenameBlur,
    onSessionColorChange,
    onServerColorChange,
    onServerFlairChange,
    onKillServer,
    onWindowColorChange,
    onWindowMarkerChange,
    onSessionFlairChange,
    onWindowFlairChange,
    onForkWindow,
    onFixTabName,
    onOperatorCompose,
    onOperatorPlaceholder,
    onWindowDragStart,
    onWindowDragOver,
    onWindowDrop,
    onWindowDragEnd,
    onSessionDragOver,
    onSessionDragLeave,
    onSessionDrop,
    onSessionReorderStart,
    onSessionReorderOver,
    onSessionReorderEnd,
  } = props;

  // Effective `create-session` chord for the no-sessions empty state's
  // education copy (260811-ke2s) — derived, never hardcoded, and omitted when
  // the binding is unbound/disabled (a hint advertising a dead chord would
  // lie; the shortcuts overlay's sheetChord rule) or when the pointer is
  // coarse (the app's chord-hints-off-touch rule).
  const groupCoarsePointer = useCoarsePointer();
  const { byAction: groupByAction, host: groupHost } = useKeybindings();
  const createSessionBinding = groupByAction.get("create-session");
  const createSessionChord =
    !groupCoarsePointer && createSessionBinding?.enabled
      ? formatCombo({ code: createSessionBinding.code, tier: createSessionBinding.tier }, groupHost.platform)
      : undefined;

  // Sync this server's session windows into the global window store. The
  // window store is what `useMergedSessions` reads to compose `MergedSession`
  // entries with ghost/rename overlays. Without this sync per-server,
  // non-current servers would render empty session rows. AppShell also
  // syncs the current server's sessions; the duplicate write is idempotent.
  // Pass `server` so per-server entries are scoped correctly — windowIds
  // from different servers must not collide in the global store.
  const setWindowsForSession = useWindowStore((s) => s.setWindowsForSession);
  useEffect(() => {
    for (const s of rawSessions) {
      setWindowsForSession(server, s.name, s.windows);
    }
  }, [server, rawSessions, setWindowsForSession]);

  // Apply optimistic merging (ghosts/rename/kill markers) per server.
  const sessions = useMergedSessions(rawSessions, server);

  // Protect/Unprotect toggle state for the server flyout card's row: driven by
  // the `protected` payload flag off the (already-fetched) server list — no
  // new prop, the R6a memo contract stays untouched. rk-daemon renders as
  // protected with the toggle DISABLED (derived, not unmarkable).
  const { servers: allServers, refreshServers } = useSessionContext();
  const { addToast: addGroupToast } = useToast();
  const serverInfo = allServers.find((s) => s.name === server);
  const serverProtected = server === DAEMON_SERVER || (serverInfo?.protected ?? false);
  // External-class marker for the header row only (the shield's leading slot);
  // nested session/window rows stay untouched. Absent `managed` = unknown =
  // no treatment.
  const serverExternal = isExternalServer(serverInfo);
  const handleProtectToggle = useCallback(() => {
    void setServerProtected(server, !serverProtected)
      .then(() => refreshServers())
      .catch((err: unknown) => {
        addGroupToast(err instanceof Error ? err.message : "Failed to update server protection");
      });
  }, [server, serverProtected, refreshServers, addGroupToast]);

  const orderedSessions = useMemo(() => {
    const effectiveOrder = localOrder ?? sessionOrder;
    if (effectiveOrder.length === 0) return sessions;
    const orderMap = new Map(effectiveOrder.map((name, i) => [name, i]));
    const ranked = (s: { name: string }) => orderMap.get(s.name) ?? Number.POSITIVE_INFINITY;
    return [...sessions].sort((a, b) => {
      const ai = ranked(a);
      const bi = ranked(b);
      if (ai === bi) return 0;
      return ai - bi;
    });
  }, [sessions, sessionOrder, localOrder]);

  // Hidden operator-home exclusion: sessions marked `hidden` by the backend
  // (the content-conditional `_rk-operator` marker — every window operator)
  // are excluded from the SESSIONS groups, roving rows, and reorder name list.
  // Their window data STAYS in `orderedSessions` (the pinned operator row's
  // only data source — the window is moved, not linked) and in `dataKeys`
  // (route resolution / window cycling are unaffected).
  const visibleSessions = useMemo(
    () => orderedSessions.filter((s) => !s.hidden),
    [orderedSessions],
  );

  const naturalNames = useMemo(() => visibleSessions.map((s) => s.name), [visibleSessions]);

  // Operator pinned row (260813-ifya): the one window on this server carrying
  // `role === "operator"` (the `@rk_win_role` window option) renders ONCE, pinned
  // at the top of this group's session area — MOVED out of its session group
  // (excluded from that group's window rows below), never copied. The backend
  // enforces server-scoped radio (at most one carrier per server); the first
  // carrier wins defensively here. Ghost rows are never carriers (no real
  // windowId / no options). No operator ⇒ null ⇒ the pinned slot renders the
  // PLACEHOLDER row instead, but only when the shell wired
  // `onOperatorPlaceholder` (an unwired sidebar — the board route — renders
  // nothing, the DOM identical to before).
  const operatorEntry = useMemo(() => {
    for (const session of orderedSessions) {
      for (const win of session.windows) {
        if (!isGhostWindow(win) && win.role === "operator") {
          return { sessionName: session.name, win, operatorStale: session.operatorStale, operatorLastTickAt: session.operatorLastTickAt };
        }
      }
    }
    return null;
  }, [orderedSessions]);

  // Derived availability input for the Fix tab name flyout row: one boolean,
  // shared by every row in the group (the rest of the rule is row-local —
  // subject agent session ref + not-the-operator's-own-row).
  const hasOperator = operatorEntry !== null;
  // Build this group's roving-row identity slice + a cheap visible-set
  // signature. The slice maps each row key → typed identity for direct
  // Enter/Space activation in the parent (no DOM `.click()` synthesis). The
  // signature is a string of the visible-row keys IN ORDER — it changes only
  // when the visible-row SET changes (window add/remove, collapse/expand,
  // rename), NOT on a passive activity-only SSE tick, so the parent's
  // normalization effect is not woken on every tick. Derived from the SAME
  // merged `orderedSessions` that render the rows, so renamed-session keys
  // (`${server}:${newName}`) match the painted DOM.
  const { rowSlice, rowSignature } = useMemo(() => {
    const slice = new Map<string, RowIdentity>();
    const sigParts: string[] = [];
    if (isOpen) {
      // The pinned operator row renders ABOVE all session groups, so its key
      // leads the visible-row order regardless of its home session's collapse
      // state (it is no longer painted inside that group). The operator-less
      // placeholder takes the same leading slot when wired.
      if (operatorEntry) {
        const opRowKey = `${server}:${operatorEntry.win.windowId}`;
        slice.set(opRowKey, {
          kind: "window",
          server,
          session: operatorEntry.sessionName,
          windowId: operatorEntry.win.windowId,
          ghost: false,
        });
        sigParts.push(opRowKey);
      } else if (onOperatorPlaceholder) {
        const placeholderRowKey = `${server}:operator-placeholder`;
        slice.set(placeholderRowKey, { kind: "operator-placeholder", server });
        sigParts.push(placeholderRowKey);
      }
      for (const session of visibleSessions) {
        const sessionRowKey = `${server}:${session.name}`;
        const firstWindowId = session.windows[0]?.windowId ?? "";
        slice.set(sessionRowKey, { kind: "session", server, session: session.name, firstWindowId });
        sigParts.push(sessionRowKey);
        // Derived override: the current route's session always renders
        // expanded — its exception stays in the map (never mutated here) and
        // re-applies the moment the session stops being current. Must match
        // the render read site below so roving and painted rows agree.
        const isCollapsed =
          (collapsed[sessionRowKey] ?? false) && session.name !== currentSessionName;
        if (!isCollapsed) {
          for (const win of session.windows) {
            const ghost = isGhostWindow(win);
            // The operator window's row lives at the top of the group (above);
            // it must not ALSO register inside its session group.
            if (operatorEntry && !ghost && win.windowId === operatorEntry.win.windowId) continue;
            // Globally-unique roving key: tmux ids (@N) collide across servers,
            // so namespace by server. Mirrors the WindowRow `data-row-key`.
            const winRowKey = `${server}:${ghost ? `ghost-${win.optimisticId}` : win.windowId}`;
            slice.set(winRowKey, {
              kind: "window",
              server,
              session: session.name,
              windowId: win.windowId,
              ghost,
            });
            sigParts.push(winRowKey);
          }
        }
      }
    }
    return { rowSlice: slice, rowSignature: sigParts.join("|") };
  }, [isOpen, visibleSessions, collapsed, server, operatorEntry, onOperatorPlaceholder, currentSessionName]);

  // This group's DATA window keys — every real window the SSE snapshot knows for
  // this server, whether or not its session is expanded and whether or not the
  // group itself is open. Deliberately independent of `collapsed`/`isOpen`
  // (unlike `rowSignature` above, which tracks the VISIBLE row set): the
  // selection prune keys on this, and treating a folded-away window as departed
  // would silently destroy a live selection on every collapse (260807-nf9f R4).
  // Ghost/optimistic rows are excluded — they have no real windowId to select.
  const { dataKeys, dataSignature } = useMemo(() => {
    const keys = new Set<string>();
    const parts: string[] = [];
    for (const session of orderedSessions) {
      for (const win of session.windows) {
        if (isGhostWindow(win) || win.windowId === "") continue;
        const key = `${server}:${win.windowId}`;
        if (keys.has(key)) continue;
        keys.add(key);
        parts.push(key);
      }
    }
    // Order-independent so a pure session/window REORDER (which moves no window
    // in or out of the snapshot) does not bump the prune's version counter.
    parts.sort();
    return { dataKeys: keys, dataSignature: parts.join("|") };
  }, [orderedSessions, server]);

  useEffect(() => {
    registerGroupRows(server, rowSignature, rowSlice);
  }, [registerGroupRows, server, rowSignature, rowSlice]);

  useEffect(() => {
    registerGroupDataKeys(server, dataSignature, dataKeys);
  }, [registerGroupDataKeys, server, dataSignature, dataKeys]);

  // Unregister on unmount, in a SEPARATE effect keyed on `[server]` only. A
  // cleanup on either registration effect above would fire on every signature
  // change (unregister → re-register), double-bumping the version counters and
  // opening a transient hole in the identity/data maps. Keyed this way it runs
  // exactly when the group actually leaves the tree — the sessions-scope
  // ALL→CURRENT switch, or a server disappearing from the SSE snapshot — which
  // is precisely the case no surviving group's signature covers. It drops BOTH
  // the roving-identity slice and the data-key slice, so the departed group's
  // windows stop counting as live for the selection prune.
  useEffect(() => {
    return () => unregisterGroupRows(server);
  }, [unregisterGroupRows, server]);

  // Server-group header tint (Variant D): the header renders as a filled bar
  // carrying the server's color. Colors resolve through the shared precomputed
  // maps (dual-keyed: family name + legacy descriptor) — the same entries the
  // SERVER panel tiles use. Servers without an assigned color (or with an
  // unrecognized descriptor) fall back to the gray sentinel so colored and
  // uncolored groups read as the same element class. The current server reads
  // deeper (selected shade) with brighter text; others rest at base and hover
  // to the hover shade. The current header stays flat on hover — the hover
  // shade (22%) is lighter than selected (40%) and would read as an inverted
  // effect (the same rule CollapsiblePanel applies to its selected-shade
  // header).
  const headerTintKey =
    serverColor != null && rowTints.has(serverColor) ? serverColor : UNCOLORED_SELECTED_KEY;
  const headerTint = rowTints.get(headerTintKey);
  const headerAccent = rowBorders.get(headerTintKey);
  const headerBg = headerTint ? (isCurrent ? headerTint.selected : headerTint.base) : undefined;
  const headerHoverBg = headerTint && !isCurrent ? headerTint.hover : undefined;

  // Header color picker (x4sf). Local per-group boolean — each group renders
  // exactly one header, so the ServerPanel's keyed `colorPickerFor` map isn't
  // needed (the session-row precedent). The popover is portalled to
  // document.body with fixed coordinates anchored at the header element,
  // escaping the session list's overflow-y clip (the shared flip heuristic).
  const [showColorPicker, setShowColorPicker] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const popoverPos = useAnchoredPopoverPos(showColorPicker, headerRef);

  // The server card: the SAME shared card shell as the window flyout (one
  // placement/containment/held implementation), on BOTH pointer classes —
  // fine-pointer hover/focus of the header, and the header rail's tap/scrub
  // (`openNow`) on coarse. The content is the shared ServerCardContent (the
  // SERVER-panel tile mounts the same implementation), bound to the EXISTING
  // stable identity-arg seams (`onServerColorChange`/`onCreateSession`/
  // `onKillServer` — no new props, so the R6a memo contract is untouched; all
  // card state is group-local).
  const flyout = useRowFlyout({
    suppressed: showColorPicker,
    content: ({ close }) => (
      <ServerCardContent
        server={server}
        sessionCount={sessions.length}
        serverProtected={serverProtected}
        onToggleProtect={handleProtectToggle}
        // Close-then-open (the Pin-row idiom): the card closes BEFORE the
        // group's color popover opens; `suppressed` includes
        // `showColorPicker`, so popover-over-card precedence holds.
        onChangeColorAction={() => {
          close();
          setShowColorPicker(true);
        }}
        onCreateSession={onCreateSession}
        onKillServer={onKillServer}
      />
    ),
  });
  const scrub = useRailScrub(flyout.openNow);

  // The header is the server card's floating reference AND its popover's
  // anchor — one stable callback sets both.
  const setHeaderRefs = useCallback(
    (node: HTMLElement | null) => {
      flyout.setReference(node);
      headerRef.current = node;
    },
    [flyout.setReference],
  );

  // Rail band: the header's family tint mixed into the inset base (the shared
  // rail-tint idiom); while this header's card is open the band steps up one
  // shade and the seam brightens (the held treatment, R8).
  const railStyle = useMemo(() => {
    if (!groupCoarsePointer) return undefined;
    if (flyout.open) {
      return {
        backgroundColor: railHeldBand(
          headerTint ? (isCurrent ? headerTint.selected : headerTint.hover) : "var(--color-bg-card)",
        ),
        borderColor: RAIL_HELD_SEAM,
      };
    }
    if (headerTint) {
      return { backgroundColor: railRestBand(isCurrent ? headerTint.selected : headerTint.base) };
    }
    return undefined;
  }, [groupCoarsePointer, flyout.open, headerTint, isCurrent]);

  return (
    <section
      role="presentation"
      className="border-b border-border last:border-b-0"
    >
      {/* Server header — a tinted filled bar carrying the server's color, with
          a chevron disclosure marker to match the rest of the sidebar's
          collapse/expand convention. The active server gets the deeper
          selected fill + brighter text; inactive rests at the base fill with
          the guarded accent text and deepens on hover. */}
      <div
        // `coarse:pr-[56px]` reserves the rail's column on coarse so the
        // header label truncates before it (the literal matches
        // STATUS_RAIL_WIDTH_PX — Tailwind scans literal classes only).
        className="group relative flex items-stretch w-full transition-colors coarse:pr-[56px]"
        aria-current={isCurrent ? "true" : undefined}
        data-current-server={isCurrent ? "true" : undefined}
        data-server={server}
        // The shared rail-row hit-test handle (260817-ve5m) — the scrub
        // gesture's both ends resolve row roots via the IDENTICAL
        // `RAIL_ROW_SELECTOR` across all three tier DOM shapes (this header
        // is NOT a treeitem, which is why the attribute route exists).
        data-rail-row=""
        // The header is the server card's floating REFERENCE (+ its popover's
        // anchor). getReferenceProps CHAINS the card's hover/focus wiring with
        // the header's own tint mouse-enter/leave (floating-ui merges them).
        ref={setHeaderRefs}
        {...flyout.getReferenceProps({
          onMouseEnter: headerHoverBg
            ? (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = headerHoverBg; }
            : undefined,
          onMouseLeave: headerHoverBg && headerBg
            ? (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = headerBg; }
            : undefined,
        })}
        style={{
          backgroundColor: headerBg,
          borderTop: headerAccent ? `1px solid ${headerAccent}` : undefined,
        }}
      >
        {/* Flair overlay (decoration-only channel): mounted whenever the
            server carries a flair value — same overlay discipline as the
            window/session rows (clipped, pointer-events-none, z-5). The
            guarded header accent rides as `color` so tinted flairs
            (rain/scan) match the header's family. Hidden under
            prefers-reduced-motion (globals.css § Flair overlays). */}
        <FlairOverlay flair={serverFlair} color={headerAccent} />
        <button
          type="button"
          onClick={() => onToggleOpen(server)}
          aria-expanded={isOpen}
          aria-label={isOpen ? `Collapse ${server} sessions` : `Expand ${server} sessions`}
          className={`flex-1 min-w-0 flex items-center gap-1.5 pl-2 pr-1.5 text-left text-[10px] uppercase tracking-wider font-semibold min-h-[26px] coarse:min-h-[28px] transition-colors ${
            isCurrent ? "text-text-primary" : ""
          }`}
          style={!isCurrent && headerAccent ? { color: headerAccent } : undefined}
        >
          <span
            className="inline-block transition-transform duration-150 shrink-0"
            style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
            aria-hidden="true"
          >
            &#x25BC;
          </span>
          {/* Server-name span — de-emphasized (grey) when the server is
              external; the truncate keeps the class composition stable. */}
          <span className={`truncate ${serverExternal ? "text-text-secondary" : ""}`}>{server}</span>
          {/* Protected-class marker: rk-daemon derives protected client-side
              (the same ∨ the flyout toggle computes above); unmarked servers
              render nothing — no layout shift. */}
          {serverProtected && (
            <span
              role="img"
              aria-label={`${server} is protected`}
              className="inline-flex shrink-0"
              data-testid={`shield-${server}`}
            >
              <ShieldGlyph />
            </span>
          )}
          {/* External-class marker (managed === false): shares the shield's
              leading slot, renders after it when both apply. The surrounding
              label carries the accessible name; the glyph stays decoration. */}
          {serverExternal && (
            <span
              role="img"
              aria-label={`${server} is external`}
              className="inline-flex shrink-0"
              data-testid={`external-${server}`}
            >
              <ExternalGlyph />
            </span>
          )}
        </button>
        {/* Right-edge status rail — COARSE pointers only (260817-ve5m): the
            SAME 56px recessed inset band the window row ships, forming ONE
            continuous strip down the tree. The band tints from the header's
            family tint (railRestBand); while this header's card is open it
            carries the held treatment (`railStyle`). The 16px glyph slot is
            ALWAYS an empty span on this tier (server headers own no PR glyph)
            so the 12px chevron column-aligns with the window/session rails.
            It is the card's tap/scrub target (the shared `useRailScrub`
            trio); the pointerdown/click stopPropagation keeps a rail tap from
            toggling the group. */}
        {groupCoarsePointer && (
          <span
            data-testid="status-rail"
            className="absolute right-0 top-0 bottom-0 z-10 flex items-center justify-end gap-0.5 border-l border-border bg-bg-inset pr-1 touch-none"
            style={{ width: STATUS_RAIL_WIDTH_PX, ...railStyle }}
            {...scrub.handlers}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 16px glyph slot — always empty on server headers; it exists so
                the chevron never shifts sideways between tiers. */}
            <span className="flex w-4 shrink-0 items-center justify-center" />
            {/* 12px chevron hint — aria-hidden decoration, muted at ~55%. */}
            <span
              aria-hidden="true"
              className="flex w-3 shrink-0 items-center justify-center text-text-secondary opacity-55"
            >
              ›
            </span>
          </span>
        )}
        {/* Color picker portalled to body so it escapes the sessions list's
            overflow-y: auto clip, anchored at the header element on every
            pointer class (the shared flip heuristic). */}
        {showColorPicker && popoverPos && createPortal(
          <div
            style={{
              position: "fixed",
              top: popoverPos.top,
              right: popoverPos.right,
              zIndex: 100,
            }}
          >
            <SwatchPopover
              selectedColor={serverColor}
              // Selection does NOT close (the picker's dismissal contract).
              onSelect={(c) => onServerColorChange(server, c)}
              // Supplying onSelectFlair renders the picker's flair band;
              // "" (the header − clear cell) clears.
              selectedFlair={serverFlair ?? ""}
              onSelectFlair={(f) => onServerFlairChange(server, f === "" ? null : f)}
              onClose={() => setShowColorPicker(false)}
            />
          </div>,
          document.body,
        )}
        {/* The server card — portalled to document.body, mounted ONLY while
            open (the shared shell's perf contract). */}
        {flyout.card}
      </div>

      {isOpen && (
        <>
          {/* Pinned operator row (260813-ifya): the ordinary WindowRow for this
              server's `role === "operator"` window, MOVED to the top of the
              group's session area (and excluded from its session group below).
              Placement is the ONLY difference — no badge, frame, or divider.
              Not draggable (it does not participate in window drag-reorder);
              it still joins the roving-tabindex tree via rowKey/tabIndex.
              It sits OUTSIDE the session-list container so its full-width
              tinted slab (scanlines) shares an edge with the tinted group
              header above and with the first session row below — rows sit
              flush with no gaps (the container keeps only pb-1, separating
              this group from the next server's header). */}
          {operatorEntry && (
            <>
            <WindowRow
              win={operatorEntry.win}
              session={operatorEntry.sessionName}
              operatorStale={operatorEntry.operatorStale}
              operatorLastTickAt={operatorEntry.operatorLastTickAt}
              isSelected={
                currentSessionName === operatorEntry.sessionName &&
                (currentWindowId != null
                  ? currentWindowId === operatorEntry.win.windowId
                  : operatorEntry.win.isActiveWindow)
              }
              isDragOver={false}
              color={operatorEntry.win.color}
              marker={operatorEntry.win.marker}
              rowTints={rowTints}
              rowBorders={rowBorders}
              editingWindow={editingWindow}
              editingName={editingName}
              inputRef={inputRef}
              server={server}
              boards={allBoards}
              boardsLoading={boardsLoading}
              isPinnedToAny={pinnedSet.has(`${server}:${operatorEntry.win.windowId}`)}
              isPinnedToActiveBoard={isPinnedToActiveBoardFor(server, operatorEntry.win.windowId)}
              isPinnedToBoard={pinnedToBoard}
              pinnedBoard={boardForWindow(server, operatorEntry.win.windowId)}
              onNavigateToBoard={onNavigateToBoard}
              tabIndex={rovingKey === `${server}:${operatorEntry.win.windowId}` ? 0 : -1}
              rowKey={`${server}:${operatorEntry.win.windowId}`}
              ariaLevel={2}
              isBulkSelected={selectedWindows.has(`${server}:${operatorEntry.win.windowId}`)}
              onRowClick={onWindowRowClick}
              onSelectWindow={onSelectWindow}
              onStartEditing={onWindowStartEditing}
              onWindowNameChange={onWindowNameChange}
              onRenameKeyDown={onWindowRenameKeyDown}
              onRenameBlur={onWindowRenameBlur}
              onKillClick={onWindowRowKill}
              draggable={false}
              onColorChange={onWindowColorChange}
              onMarkerChange={onWindowMarkerChange}
              onFlairChange={onWindowFlairChange}
              onForkWindow={onForkWindow}
              onFixTabName={onFixTabName}
              onOperatorCompose={onOperatorCompose}
              hasOperator={hasOperator}
            />
            {/* Note pulse: the operator window's @rk_win_note one-liner under
                its pinned row (the row-flyout note-line idiom). Degrade-to-
                absent — no note ⇒ nothing renders, no reserved space. */}
            {operatorEntry.win.note && (
              <div
                data-testid="operator-note-pulse"
                className="truncate pl-[26px] pr-2 pb-0.5 text-[11px]"
              >
                <NoteLine win={operatorEntry.win} />
              </div>
            )}
            </>
          )}
          {!operatorEntry && onOperatorPlaceholder && (
            // Operator placeholder row: the pinned slot's operator-less form —
            // the operator's constant landmark stays put so the Start
            // affordance is discoverable. No status dot, trailing cluster,
            // marker well, flyout, or drag; it joins the roving-tabindex tree
            // as the group's LEADING row (`${server}:operator-placeholder`),
            // and activation — pointer click, or Enter/Space through the
            // tree's typed-identity path — calls the shell-wired handler,
            // never window navigation (there is no window). It is excluded
            // from the selection registry and dataKeys (no real windowId to
            // select). Once a carrier appears, the ordinary pinned WindowRow
            // takes the slot back — no animation.
            <div
              role="treeitem"
              aria-level={2}
              aria-selected={false}
              data-testid="operator-placeholder-row"
              data-row-key={`${server}:operator-placeholder`}
              tabIndex={rovingKey === `${server}:operator-placeholder` ? 0 : -1}
              draggable={false}
              onClick={() => onOperatorPlaceholder(server)}
              className="flex w-full cursor-pointer items-center gap-1.5 py-px pl-[30px] pr-2 text-left text-xs text-text-secondary transition-colors min-h-[24px] hover:text-text-primary coarse:min-h-[36px] coarse:pl-[44px]"
            >
              <span className="shrink-0" aria-hidden="true">
                <HeadsetIcon />
              </span>
              <span className="truncate">operator</span>
              <span className="ml-auto shrink-0">not running</span>
            </div>
          )}
          <div className="pb-1">
          {visibleSessions.length === 0 && sessions.length === 0 ? (
            <button
              onClick={() => onCreateSession(server)}
              className="block w-full pl-2 pr-2 py-1 text-left text-xs text-text-secondary hover:text-text-primary hover:bg-bg-chrome-raised transition-colors"
            >
              {createSessionChord
                ? `(no sessions — a session groups tabs; + new, or ${createSessionChord})`
                : "(no sessions — a session groups tabs; + new)"}
            </button>
          ) : (
            visibleSessions.map((session, sessionIdx) => {
              // Same derived override as the rowSlice memo above: the current
              // session ignores its collapsed exception while current.
              const isCollapsed =
                (collapsed[`${server}:${session.name}`] ?? false) &&
                session.name !== currentSessionName;
              const isGhostSession = "optimistic" in session && session.optimistic;
              // Move-don't-copy (260813-ifya): the operator window's row is
              // pinned at the top of the group, so it leaves this session's
              // window rows (the group renders one fewer row). Ghost rows are
              // never the carrier.
              const renderedWindows = operatorEntry
                ? session.windows.filter(
                    (w) => isGhostWindow(w) || w.windowId !== operatorEntry.win.windowId,
                  )
                : session.windows;
              // Stable per-row tree handles + position metadata (W3C APG).
              const sessionRowKey = `${server}:${session.name}`;
              const windowGroupId = `windows-${server}-${session.name}`;
              return (
                <div
                  key={session.name}
                  // Stable per-session wrapper handle for tests (e.g.
                  // sync-latency scopes window-row counts to one session) —
                  // don't couple selectors to the spacing utility classes.
                  data-session-group={session.name}
                  className={isGhostSession ? "opacity-50 animate-pulse" : undefined}
                >
                  <SessionRow
                    server={server}
                    session={session}
                    sessionColor={session.sessionColor}
                    rowTints={rowTints}
                    rowBorders={rowBorders}
                    isCollapsed={isCollapsed}
                    isSessionDropTarget={sessionDropTarget === session.name}
                    editingSession={editingSession}
                    editingSessionName={editingSessionName}
                    sessionInputRef={sessionInputRef}
                    draggable={!isGhostSession}
                    isDragSource={sessionDragSource === session.name}
                    orderedNames={naturalNames}
                    tabIndex={rovingKey === sessionRowKey ? 0 : -1}
                    ariaSetSize={visibleSessions.length}
                    ariaPosInSet={sessionIdx + 1}
                    windowGroupId={windowGroupId}
                    sessionRowKey={sessionRowKey}
                    onDragStart={isGhostSession ? undefined : onSessionReorderStart}
                    onDragEnd={isGhostSession ? undefined : onSessionReorderEnd}
                    onToggleCollapse={onToggleSession}
                    onSelectFirstWindow={onSelectWindow}
                    onWaitingBadgeClick={onWaitingBadgeClick}
                    onCreateWindow={onCreateWindow}
                    onKillClick={onSessionRowKill}
                    onDoubleClickName={onSessionStartEditing}
                    onSessionNameChange={onSessionNameChange}
                    onSessionRenameKeyDown={onSessionRenameKeyDown}
                    onSessionRenameBlur={onSessionRenameBlur}
                    onDragOver={onSessionDragOver}
                    onReorderOver={onSessionReorderOver}
                    onDragLeave={onSessionDragLeave}
                    onDrop={onSessionDrop}
                    onColorChange={onSessionColorChange}
                    onFlairChange={onSessionFlairChange}
                    onSpawnAgent={onSpawnAgent}
                    onUpdateAnnotations={hasOperator ? onUpdateAnnotations : undefined}
                  />

                  {!isCollapsed && (
                    <div role="group" id={windowGroupId}>
                      {renderedWindows.map((win, winIdx) => {
                        const ghost = isGhostWindow(win);
                        // Globally-unique roving key — matches the row's
                        // `data-row-key` handle (namespaced by server because
                        // tmux ids @N collide across open server groups).
                        const winRowKey = `${server}:${ghost ? `ghost-${win.optimisticId}` : win.windowId}`;
                        // Exactly ONE row per session may look selected, so
                        // selection keys on a SINGLE source of truth — never
                        // an OR of two, which lights up two rows whenever the
                        // sources momentarily disagree.
                        //
                        // The URL is that source: a click navigates the URL
                        // optimistically (user intent leads), and an external
                        // `tmux select-window` / `rk riff` flips
                        // `isActiveWindow`, which the app's writeback effect
                        // then mirrors into the URL. So the URL converges to
                        // tmux truth within a render either way, and keying on
                        // it gives a single, unambiguous selection.
                        //
                        // `isActiveWindow` is the fallback ONLY before the URL
                        // has a window segment (just landed on the session,
                        // pre-writeback) — and even then only for the one
                        // tmux-active row. Ghost rows (mid-creation, not yet
                        // in the URL or snapshot) fall back to active match.
                        // The URL fallback compares the stable window ID (@N),
                        // not the mutable index.
                        const hasUrlWindow = currentWindowId != null;
                        const isSelected =
                          currentSessionName === session.name &&
                          (hasUrlWindow
                            ? currentWindowId === win.windowId
                            : (!ghost && win.isActiveWindow));
                        const isDragOver =
                          dropTarget?.server === server &&
                          dropTarget?.session === session.name &&
                          dropTarget?.index === win.index &&
                          dragSource?.index !== win.index;

                        return (
                          <WindowRow
                            key={ghost ? `ghost-${win.optimisticId}` : win.windowId}
                            win={win}
                            session={session.name}
                            operatorStale={session.operatorStale}
                            operatorLastTickAt={session.operatorLastTickAt}
                            isSelected={isSelected}
                            isDragOver={isDragOver}
                            isDragSource={
                              dragSource?.server === server &&
                              dragSource?.session === session.name &&
                              dragSource?.index === win.index
                            }
                            color={win.color}
                            marker={win.marker}
                            rowTints={rowTints}
                            rowBorders={rowBorders}
                            editingWindow={editingWindow}
                            editingName={editingName}
                            inputRef={inputRef}
                            server={server}
                            boards={allBoards}
                            boardsLoading={boardsLoading}
                            isPinnedToAny={!ghost && pinnedSet.has(`${server}:${win.windowId}`)}
                            isPinnedToActiveBoard={!ghost && isPinnedToActiveBoardFor(server, win.windowId)}
                            isPinnedToBoard={pinnedToBoard}
                            pinnedBoard={ghost ? undefined : boardForWindow(server, win.windowId)}
                            onNavigateToBoard={onNavigateToBoard}
                            tabIndex={rovingKey === winRowKey ? 0 : -1}
                            rowKey={winRowKey}
                            ariaLevel={2}
                            ariaSetSize={renderedWindows.length}
                            ariaPosInSet={winIdx + 1}
                            // Bulk multi-select (260807-nf9f): membership drives
                            // `aria-selected` + the inset-ring treatment; the
                            // click seam is offered the raw modifiers so the
                            // sidebar owns the whole gesture policy. Ghost rows
                            // are never selectable (no real windowId).
                            isBulkSelected={!ghost && selectedWindows.has(winRowKey)}
                            onRowClick={ghost ? undefined : onWindowRowClick}
                            onSelectWindow={onSelectWindow}
                            onStartEditing={onWindowStartEditing}
                            onWindowNameChange={onWindowNameChange}
                            onRenameKeyDown={onWindowRenameKeyDown}
                            onRenameBlur={onWindowRenameBlur}
                            onKillClick={onWindowRowKill}
                            draggable={!ghost}
                            onDragStart={ghost ? undefined : onWindowDragStart}
                            onDragOver={ghost ? undefined : onWindowDragOver}
                            onDrop={ghost ? undefined : onWindowDrop}
                            onDragEnd={ghost ? undefined : onWindowDragEnd}
                            onColorChange={ghost ? undefined : onWindowColorChange}
                            onMarkerChange={ghost ? undefined : onWindowMarkerChange}
                            onFlairChange={ghost ? undefined : onWindowFlairChange}
                            onForkWindow={ghost ? undefined : onForkWindow}
                            onFixTabName={ghost ? undefined : onFixTabName}
                            hasOperator={hasOperator}
                          />
                        );
                      })}
                      {dragSource?.session === session.name && (
                        <div className="relative">
                          <div
                            className="absolute inset-x-0 top-0 h-4 -mt-1"
                            style={
                              dropTarget?.server === server && dropTarget?.session === session.name && dropTarget?.index === -1
                                ? { boxShadow: "0 -2px 0 0 var(--color-accent)" }
                                : undefined
                            }
                            onDragOver={(e) => onWindowDragOver(e, server, session.name, -1)}
                            onDrop={(e) => {
                              let lastReal: (typeof session.windows)[number] | undefined;
                              for (let i = session.windows.length - 1; i >= 0; i--) {
                                if (!isGhostWindow(session.windows[i])) { lastReal = session.windows[i]; break; }
                              }
                              if (lastReal) onWindowDrop(e, server, session.name, lastReal.index + 1);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
          </div>
        </>
      )}
    </section>
  );
}

/** Memoized per-server group. An SSE session tick rebuilds the per-server data
 *  Maps in SessionContext, but `Sidebar` now passes every handler as a stable
 *  identity-arg `useCallback` and the context Map/array props (`rowTints`,
 *  `rowBorders`, `allBoards`, `pinnedSet`, `pinnedToBoard`,
 *  `isPinnedToActiveBoardFor`) are stable refs — so a tick on server B does not
 *  re-render server A's group at all. The header card's seam props
 *  ride the same contract: `onServerColorChange` is a stable identity-arg
 *  `useCallback` in `Sidebar` (shared with `ServerPanel`) and `onKillServer` is
 *  the Sidebar prop passed through unchanged — itself stabilized at BOTH
 *  parents as an identity-arg `useCallback` (`handleSidebarKillServer` in
 *  app.tsx and board-page.tsx), so the stability holds end-to-end from the
 *  `setKillServerTarget` source. The group whose `rawSessions`/order/
 *  connection actually changed still re-renders (correct). (`boardsLoading` is a
 *  primitive that flips true→false once when the board list finishes loading —
 *  a legitimate one-time re-render of every group, not per-tick churn.) */
const ServerGroup = memo(ServerGroupInner);
