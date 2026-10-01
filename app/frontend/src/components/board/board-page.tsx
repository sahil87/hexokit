import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { useBoardEntries, useBoards } from "@/hooks/use-boards";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSplitPane } from "@/hooks/use-split-pane";
import { usePaneWidths, BOARD_PANE_DEFAULT_WIDTH } from "@/hooks/use-pane-widths";
import { useBoardAutofit } from "@/hooks/use-board-autofit";
import { usePinActions } from "@/hooks/use-pin-actions";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useSessionContext } from "@/contexts/session-context";
import { useChromeState, useChromeDispatch } from "@/contexts/chrome-context";
import { useSettingsDialog } from "@/contexts/settings-dialog-context";
import { useServerDialogs } from "@/contexts/server-dialogs-context";
import { usePaletteGlobals, useRegisterPaletteActions } from "@/contexts/palette-actions-context";
import { useToast } from "@/components/toast";
import { BottomBar } from "@/components/bottom-bar";
import { StatusBar } from "@/components/status-bar";
import { ComposeStrip } from "@/components/compose-strip";
import { Shell } from "@/components/shell/shell";
import { Sidebar } from "@/components/sidebar";
import { useRegisterTopBarSlot } from "@/contexts/top-bar-slot-context";
import { useRegisterFocusedPane } from "@/contexts/focused-pane-context";
import { createSession, createWindow as createWindowApi, killWindow } from "@/api/client";
import { setBoardOrder } from "@/api/boards";
import { computeMoveOrder } from "@/lib/palette/move";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import type { PaletteAction } from "@/components/command-palette";
import { ValidBoardName } from "./board-name";
import { BoardPane, type BoardPaneHandle } from "./board-pane";
import { selectLivePanes } from "./select-live-panes";
import { useBoardPaneReorder } from "@/hooks/use-board-pane-reorder";
import { computeMoveNeighbors, focusedIndexForKey, shouldFocusPane } from "@/lib/board-reorder";
import { isWaiting } from "@/lib/waiting";
import { withShortcutHints, chordHintFor } from "@/lib/keybindings";
import { runComposeToggleChord } from "@/lib/compose-strip-events";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { pushRecentlyClosed } from "@/hooks/use-recently-closed";
import { useKeybindingDispatch } from "@/hooks/use-keybinding-dispatch";
import { NotFoundPage } from "@/router";

interface BoardPageRouteProps {
  // tanstack-router passes route params via useParams, but for type-safety
  // we read via the route's `useParams` hook below.
}

/**
 * Default per-pane width seed used by the local pane-widths hook when a
 * board has no persisted per-pane widths yet. Decoupled from the sidebar
 * width (now lifted to ChromeContext); BoardPage no longer drives the
 * sidebar's own column width.
 */
const PANE_WIDTH_SEED = 240;
const SWIPE_THRESHOLD_PX = 40;

/**
 * Maximum number of desktop board panes that may hold a live relay WebSocket
 * simultaneously, on plaintext (HTTP/1.1) origins. Backstops the
 * IntersectionObserver for the wide-monitor case where more panes are visible
 * at once than the ~6-connection-per-origin ceiling can afford
 * (`1 SSE + 4 relay + headroom`). The focused pane is exempt from this cap.
 */
const MAX_LIVE_RELAY_PANES = 4;

/**
 * Horizontal pre-warm margin for the desktop visibility IntersectionObserver,
 * expressed as an `IntersectionObserver` `rootMargin`. One pane-width on each
 * side keeps a pane live slightly before it enters and slightly after it
 * leaves the strict viewport, so a quick scroll-past does not thrash
 * connect/disconnect (and the `[reconnecting...]` flicker). No debounce — add
 * one only if thrash is observed during Playwright tuning. Vertical margins are
 * 0 because the row is a single horizontal strip.
 */
const RELAY_PREWARM_ROOT_MARGIN = `0px ${BOARD_PANE_DEFAULT_WIDTH}px`;

export function BoardPage(_props: BoardPageRouteProps) {
  // ToastProvider, SessionProvider, and OptimisticProvider are mounted by
  // RootWrapper above all routes — no per-route wrapping needed here.
  return <BoardPageInner />;
}

function BoardPageInner() {
  // Read the board name from the route params via TanStack Router. boardRoute
  // isn't exported from router.tsx (avoiding a circular import via app.tsx →
  // router.tsx), so use `strict: false` and narrow the type ourselves.
  const params = useParams({ strict: false }) as { name?: string };
  const name = typeof params.name === "string" ? params.name : null;
  if (name === null || !ValidBoardName(name)) {
    return <NotFoundPage />;
  }
  return <BoardPageContent name={name} />;
}

function BoardPageContent({ name }: { name: string }) {
  const navigate = useNavigate();
  const router = useRouter();
  const { entries, isLoading, error, refetch } = useBoardEntries(name);
  const { boards } = useBoards();
  const { unpin, reorder } = usePinActions();
  const isMobile = useIsMobile();
  const { getWidth, setWidth } = usePaneWidths(name, PANE_WIDTH_SEED);
  // Per-board desktop autofit (738w). When on, DesktopRow lays panes out as
  // equal-share flex items filling the row; stored per-pane widths are left
  // untouched so toggling off restores the hand-tuned layout.
  const { autofit, toggleAutofit } = useBoardAutofit(name);

  // Session/window creation handlers — match AppShell's wiring so the unified
  // Sidebar can fire the same optimistic flows on the board route. The server
  // create/kill dialogs live at the layout level now (260811-239r): this route
  // only consumes the `server-dialogs-context` triggers, plus the imperative
  // merged palette list (route actions + layout globals) for the keybinding
  // `shortcuts-overlay` resolution below.
  const ctx = useSessionContext();
  const { addToast } = useToast();
  const { addGhostSession, removeGhost } = useOptimisticContext();
  const { openCreateServer, requestKillServer } = useServerDialogs();
  // The `shortcuts-overlay` chord resolves the layout-level global entry
  // (260811-239r, R12) — via the globals-ONLY channel, which never changes in
  // response to this route's own registration (no render loop; see
  // palette-actions-context.tsx).
  const paletteGlobals = usePaletteGlobals();
  const ghostSessionIdRef = useRef<string | null>(null);

  const { execute: executeCreateSession } = useOptimisticAction<[string, string, string | undefined]>({
    action: (srv, sessName, cwd) => createSession(srv, sessName, cwd),
    onOptimistic: (srv, sessName) => {
      ghostSessionIdRef.current = addGhostSession(srv, sessName);
    },
    onRollback: () => {
      if (ghostSessionIdRef.current) {
        removeGhost(ghostSessionIdRef.current);
        ghostSessionIdRef.current = null;
      }
    },
    onError: (err) => addToast(err.message || "Failed to create session"),
    onSettled: () => { ghostSessionIdRef.current = null; },
  });

  const { execute: executeCreateWindow } = useOptimisticAction<[string, string]>({
    action: (srv, sess) => createWindowApi(srv, sess),
    onError: (err) => addToast(err.message || "Failed to create tab"),
  });

  // `ctx.sessionsByServer` is a fresh Map every SSE tick; read it at click time
  // via a ref so `handleCreateSession` stays referentially stable across ticks.
  // On the board route `currentServer === null`, so this handler is threaded
  // straight into every `ServerGroup` as `onCreateSession` — churning it would
  // defeat `ServerGroup`'s `React.memo` on the whole board sidebar.
  const sessionsByServerRef = useRef(ctx.sessionsByServer);
  sessionsByServerRef.current = ctx.sessionsByServer;
  const handleCreateSession = useCallback(
    (srv: string) => {
      const existingNames = (sessionsByServerRef.current.get(srv) ?? []).map((s) => s.name);
      const base = "session";
      let candidate = base;
      const set = new Set(existingNames);
      let i = 2;
      while (set.has(candidate)) {
        candidate = `${base}-${i++}`;
        if (i > 99) break;
      }
      executeCreateSession(srv, candidate, undefined);
    },
    [executeCreateSession],
  );

  const handleCreateWindow = useCallback(
    (srv: string, session: string) => executeCreateWindow(srv, session),
    [executeCreateWindow],
  );

  const paneRefs = useRef<Array<BoardPaneHandle | null>>([]);
  paneRefs.current = entries.map((_, i) => paneRefs.current[i] ?? null);

  // Focused pane index for keyboard cycling. The index drives the focus RING
  // (`isFocused={authIdx === focusedIndex}`) and imperative xterm focus. But a
  // raw index is not stable across reorders: with `paneRefs` keyed to the
  // authoritative order, focusing `paneRefs.current[index]` after an order
  // change (own reorder echo, or a reorder from another client) routes DOM
  // focus into the DISPLACED NEIGHBOUR's terminal. So focus is tracked by the
  // focused pane's `server:windowId` KEY (`focusedKeyRef`); the index is
  // reconciled from the key whenever the order changes (rework must-fix #3).
  const [focusedIndex, setFocusedIndex] = useState(0);
  const focusedKeyRef = useRef<string | null>(null);
  // Gates the imperative `.focus()` to user-driven focus movement only — mirrors
  // the sidebar's `focusMovedRef` (`components/sidebar/index.tsx`). Set at every
  // user-intent site (keyboard/palette cycle, a pane click that moves focus, an
  // own move's initiation) and consumed exactly once by the focus effect below.
  // A passive `board-changed` refetch (remote reorder/pin/unpin from another
  // client) reconciles the index but never sets this flag, so it never steals
  // DOM focus into a terminal — the "SSE must not steal focus" invariant.
  const focusIntentRef = useRef(false);
  // Signature of the previous authoritative order, to distinguish an
  // ORDER-changed render (index must follow key) from a user-intent index
  // change (key must follow index) within the single focus effect below.
  const prevOrderSigRef = useRef<string | null>(null);
  // Previously-focused index. User intent is carried by `focusIntentRef` —
  // this ref's only remaining role is suppressing a same-index re-focus (a
  // settled pass whose index didn't move must not re-fire `.focus()`). Seeded
  // to the initial `focusedIndex` (0) so the first settled render on board
  // load does NOT auto-focus pane 0's terminal. See `shouldFocusPane` and the
  // "SSE must not steal focus" invariant
  // (`docs/memory/run-kit/ui-patterns.md` § Keyboard Navigation).
  const prevFocusedIndexRef = useRef(0);

  // Single focus authority: keeps `focusedKeyRef` synced, reconciles the index
  // to the key when the order shifts, and imperatively focuses the terminal —
  // always by KEY so a keystroke lands in the intended pane both on the
  // optimistic move (order not yet echoed) and after the authoritative order
  // settles. Imperative focus fires ONLY on true user intent (`focusIntentRef`)
  // — a `board-changed` SSE refetch alone (remote reorder/pin/unpin) reconciles
  // the index but never sets the flag, so it never yanks DOM focus into a
  // terminal even when the reconcile shifts the focused pane's index (6dh9;
  // the index-change proxy could not tell an own-move follow from a remote
  // reconcile — cycle-2 must-fix #1 was the coarser first cut).
  useEffect(() => {
    const keys = entries.map((e) => `${e.server}:${e.windowId}`);
    const sig = keys.join("|");
    const orderChanged = prevOrderSigRef.current !== sig;
    prevOrderSigRef.current = sig;

    if (orderChanged && focusedKeyRef.current !== null) {
      // Order shifted underneath (SSE echo — own or cross-client). The index
      // follows the KEY so the same pane stays focused. Correct the index and
      // let the re-render re-enter this effect (with orderChanged=false) to
      // capture the key + focus — never focusing the transient wrong index.
      // `prevFocusedIndexRef` is deliberately left untouched here so the
      // re-entered settled pass sees the index change and (for an own move)
      // focuses the moved pane. `focusIntentRef` is ALSO left untouched: an own
      // move set it at initiation and it must SURVIVE this reconcile pass to be
      // consumed on the re-entered settled pass — that survival is exactly how
      // R6's own-move follow works (a remote reconcile never set it, so it stays
      // false here and no focus is stolen).
      const j = focusedIndexForKey(keys, focusedKeyRef.current, focusedIndex);
      if (j !== focusedIndex) {
        setFocusedIndex(j);
        return;
      }
    }

    // Index is authoritative for identity now: capture the focused key (always,
    // so the ref tracks the current pane across passive refetches) and focus
    // that pane's terminal ONLY when a user-intent flag rode into a render that
    // changed the index. `paneRefs` is keyed to the authoritative order (see
    // DesktopRow), so `focusedIndex` addresses the right handle.
    focusedKeyRef.current = keys[focusedIndex] ?? null;
    if (shouldFocusPane(focusIntentRef.current, prevFocusedIndexRef.current, focusedIndex)) {
      paneRefs.current[focusedIndex]?.focus();
    }
    // Clear the intent flag whenever the settled pass runs with it set — whether
    // or not the index changed — so a flag set for a render that turned out not
    // to move focus cannot linger to a later (passive) render and steal focus.
    // The `orderChanged` early-return above deliberately does NOT clear it: it
    // must survive to this re-entered settled pass for the own-move follow.
    focusIntentRef.current = false;
    prevFocusedIndexRef.current = focusedIndex;
  }, [entries, focusedIndex]);

  // Carousel index for mobile.
  const [carouselIndex, setCarouselIndex] = useState(0);
  useEffect(() => {
    if (carouselIndex >= entries.length && entries.length > 0) setCarouselIndex(0);
  }, [entries.length, carouselIndex]);

  // Pane-click focus (DesktopRow + MobileCarousel). Moving to a different pane
  // is a user-intent focus move: set the flag, then the state change re-runs the
  // effect which consumes it. Clicking the ALREADY-focused pane changes no
  // state, so the effect will not run — a set flag would go stale. So focus the
  // terminal imperatively at the call site WITHOUT the flag (mirrors the
  // sidebar's same-key imperative branch in `moveRovingTo`).
  const handlePaneClick = useCallback((idx: number) => {
    // Branch OUTSIDE the state updater — updaters must stay pure (StrictMode
    // double-invokes them), mirroring the sidebar's same-key imperative branch
    // in `moveRovingTo`. Same pane: no state change, so the focus effect will
    // not run — focus imperatively and leave the intent flag unset (it would
    // go stale). Different pane: set intent, let the effect focus it.
    if (idx === focusedIndex) {
      paneRefs.current[idx]?.focus();
      return;
    }
    focusIntentRef.current = true;
    setFocusedIndex(idx);
  }, [focusedIndex]);

  // Own-move intent seam. Both own-move paths — the palette Move Focused Pane
  // Left/Right and the header DnD drop (via `useBoardPaneReorder`, which takes
  // this as its `reorder`) — flow through here so intent is set at ONE seam.
  // Set the flag AHEAD of the SSE echo: the own move has no synchronous index
  // change (the display reorders only when `board-changed` arrives), so the flag
  // must survive the async POST→echo window to be consumed on the settled pass
  // after the key-reconcile — that survival is R6's own-move follow. On failure
  // no echo arrives to consume it, so clear it in the `.catch` (no stale flag).
  const reorderWithFollow = useCallback<typeof reorder>(
    (...args) => {
      focusIntentRef.current = true;
      return reorder(...args).catch((err) => {
        focusIntentRef.current = false;
        throw err;
      });
    },
    [reorder],
  );

  // Chrome dispatch — lifted above the keybinding handlers so the ⌘I/⇧Ctrl+E
  // compose-toggle chord (260801-sm6g) and the palette memos below can consume
  // it (also feeds the sidebar toggle).
  const { sidebarOpen, composeStripEnabled, scrollLocked } = useChromeState();
  const { setSidebarOpen, toggleComposeStrip } = useChromeDispatch();

  // Keyboard chords (260730-g40a): the pane-cycle ⌘[/⌘] pair migrated into
  // the keybinding registry (`board-cycle-prev`/`board-cycle-next`, combos
  // unchanged, per-device rebindable), joined by the global shifted-tier
  // back/forward + shortcuts-overlay chords and the ⌘I/⇧Ctrl+E compose chord
  // (260801-sm6g — the board twin mounts the same stateful handler as
  // AppShell; the terminal-scoped ⇧⌘O open-last-used chord has no board
  // handler and falls through). One dispatcher mount per route shell —
  // AppShell mounts its own; the two never co-mount. A missing handler (no
  // panes) falls through untouched, matching the old `entries.length === 0`
  // early-return.
  const { bindings: keybindings, byAction: bindingByAction, host: bindingHost } = useKeybindings();
  // Settings dialog trigger (o7q8) — the dialog mounts once in AppLayout; the
  // board twin registers both the chord handler (below) and the palette
  // opener. Lifted above the handler memo for the dep (260801-mqim).
  const { openSettings } = useSettingsDialog();
  const boardKeyHandlers = useMemo(() => {
    const cycle = (delta: -1 | 1) => {
      if (entries.length === 0) return;
      // Skip the intent set when a modulo cycle over a single pane leaves the
      // index unchanged — no re-render would consume the flag, so it would go
      // stale and steal focus on the next passive refetch (stale-flag rule).
      if (entries.length >= 2) focusIntentRef.current = true;
      setFocusedIndex((prev) => (prev + delta + entries.length) % entries.length);
    };
    return {
      "board-cycle-next": entries.length > 0 ? () => cycle(1) : undefined,
      "board-cycle-prev": entries.length > 0 ? () => cycle(-1) : undefined,
      "go-back": () => router.history.back(),
      "go-forward": () => router.history.forward(),
      // The shortcuts surface is the settings dialog's Shortcuts tab now
      // (260818-bncw): resolve the global `Help: Keyboard Shortcuts` entry's
      // `onSelect` through the merged palette list (the fromPalette
      // convention) — the same toggle the chord and palette entry share.
      "shortcuts-overlay": paletteGlobals.find((a) => a.id === "shortcuts-overlay")?.onSelect,
      // Stateful compose chord (R6) — the shared three-arm body
      // (`runComposeToggleChord`): off → toggle on (focus-on-open focuses the
      // textarea); on + textarea unfocused → focus, with a focuser decline
      // (disabled no-target state) falling back to the toggle so the chord
      // never dead-presses; on + focused → toggle off (closing is lossless
      // via the draft store).
      "compose-toggle": () => runComposeToggleChord(composeStripEnabled, toggleComposeStrip),
      // ⇧⌘,/⌘, settings (260801-mqim) — the board twin mounts the same
      // shared-context opener as AppShell (the board route renders no
      // AppShell, so a handler registered only there would leave the chord
      // dead here); a re-fire while the dialog is open is a no-op.
      "settings-open": openSettings,
      // ⌘N / ⇧⌘W app-window pair (260820-lfla) — the board route renders no
      // AppShell, so the chord resolves the layout-global bridge-backed
      // palette bodies here (the shortcuts-overlay convention above);
      // bridge-gated absent outside the shell, the chord falls through.
      "new-app-window": paletteGlobals.find((a) => a.id === "new-app-window")?.onSelect,
      "close-app-window": paletteGlobals.find((a) => a.id === "close-app-window")?.onSelect,
    };
  }, [entries.length, router, paletteGlobals, toggleComposeStrip, composeStripEnabled, openSettings]);
  useKeybindingDispatch(boardKeyHandlers);

  // Drag-resize state — separate from the persisted widths; live during drag.
  // Handlers live in refs so an unmount cleanup or a `pointercancel` (e.g.
  // OS gesture interrupt, route change mid-drag) can remove them — without
  // this, the listeners stayed attached on `window` and kept calling
  // `setWidth` on a stale closure.
  const dragRef = useRef<{ windowId: string; startX: number; startWidth: number } | null>(null);
  const dragMoveRef = useRef<((ev: PointerEvent) => void) | null>(null);
  const dragEndRef = useRef<(() => void) | null>(null);

  const cleanupDragListeners = useCallback(() => {
    if (dragMoveRef.current) {
      window.removeEventListener("pointermove", dragMoveRef.current);
      dragMoveRef.current = null;
    }
    if (dragEndRef.current) {
      window.removeEventListener("pointerup", dragEndRef.current);
      window.removeEventListener("pointercancel", dragEndRef.current);
      dragEndRef.current = null;
    }
    dragRef.current = null;
  }, []);

  const handleResizeStart = useCallback(
    (windowId: string, clientX: number) => {
      // Defensive: clear any prior drag's listeners before starting a new one.
      cleanupDragListeners();
      dragRef.current = { windowId, startX: clientX, startWidth: getWidth(windowId) };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientX - dragRef.current.startX;
        setWidth(dragRef.current.windowId, dragRef.current.startWidth + delta);
      };
      const onEnd = () => {
        cleanupDragListeners();
      };
      dragMoveRef.current = onMove;
      dragEndRef.current = onEnd;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [getWidth, setWidth, cleanupDragListeners],
  );

  // Unmount cleanup — if the user navigates away mid-drag, remove the global
  // listeners so they don't leak past component lifetime.
  useEffect(() => cleanupDragListeners, [cleanupDragListeners]);

  // Mobile swipe handling.
  const swipeStartX = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) swipeStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartX.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? swipeStartX.current;
    const delta = endX - swipeStartX.current;
    swipeStartX.current = null;
    if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
    if (delta < 0) {
      setCarouselIndex((i) => Math.min(i + 1, entries.length - 1));
    } else {
      setCarouselIndex((i) => Math.max(i - 1, 0));
    }
  };

  const showEmptyState = !isLoading && entries.length === 0;

  // Effective palette chord for the empty state's education copy
  // (260811-ke2s) — derived, never hardcoded; the `→ Pin:` clause is omitted
  // when the binding is unbound/disabled (a hint advertising a dead chord
  // would lie) or when the pointer is coarse (the app's chord-hints-off-touch
  // rule — touch users get the pin-icon path only).
  const coarsePointer = useCoarsePointer();
  const paletteChord = coarsePointer
    ? undefined
    : chordHintFor("command-palette", keybindings, bindingHost.platform);

  // The update/check/maintenance/version palette groups moved to the
  // layout-level global list (260811-239r, `use-global-palette-actions.ts`) —
  // they were the DD-8 duplicates here; below `sm` the top-bar L3 cluster is
  // hidden, so the layout palette is still a phone board user's only update
  // surface, now without the twin.

  // Palette-surface split/close executors (Constitution V). Split
  // is the shared `useSplitPane`; close mirrors the terminal palette's wiring
  // (app.tsx — useOptimisticAction-wrapped closePane with an error toast).
  // Declared ABOVE `boardRouteActions`
  // so the memo can list them in its dep array. The board palette mirrors the
  // terminal PALETTE's `horizontal` mapping (Vertical → horizontal: true), a
  // pre-existing top-bar-chip-vs-palette divergence left out of scope. Close
  // schedules a self-heal refetch (`onSettled`) like the top-bar ✕.
  const { split: executeSplit } = useSplitPane();

  // The focused tile's kill/split target — the SINGLE source of truth for the
  // focused window shared by the top-bar SplitControl + Kill-row slot AND the three
  // board split/close palette actions below (260715-6jwn). `cwd` comes from the
  // focused entry's ACTIVE pane (fallback: first pane; else undefined →
  // splitWindow omits it and tmux uses its default). Board pins are LINK-based
  // with dual home+pin membership: only the `_rk-pin-*` pin-session copy is
  // filtered from session lists — the HOME-session copy of a pinned window IS
  // in `ctx.sessionsByServer` (see the waitingWindowIds/homeSessionByKey joins
  // below). `BoardEntry.panes` is used here anyway because it already carries
  // per-pane cwd + isActive from the getBoard join (matching terminal-mode's
  // active-pane worktreePath semantics) and stays available even for a
  // pin-only window whose home session died. Null when the board is empty (no
  // focused tile). Declared ABOVE `boardRouteActions` so the palette handlers
  // consume it directly instead of re-deriving the active-pane cwd (parsimony
  // — one derivation, one source of truth).
  const focusedPane = useMemo(() => {
    const e = entries[focusedIndex];
    if (!e) return null;
    const panes = e.panes ?? [];
    const active = panes.find((p) => p.isActive) ?? panes[0];
    return { server: e.server, windowId: e.windowId, cwd: active?.cwd };
  }, [entries, focusedIndex]);

  // Publish the focused tile into the shared focused-pane context (260720-zx4i)
  // so the sidebar's bottom PANE panel can follow it on the board route (where
  // the route provides no selected window). Carries the entry's `windowName` +
  // `panes` alongside the identity — the thin-fallback data for a pin-only
  // window absent from the sessions stream. Memoized on the focused entry so
  // the registration effect re-runs only when focus (or that entry's data)
  // changes; `null` while the board is empty. Cleared on unmount by the hook.
  const focusedEntry = entries[focusedIndex];
  useRegisterFocusedPane(
    useMemo(
      () =>
        focusedEntry
          ? {
              server: focusedEntry.server,
              windowId: focusedEntry.windowId,
              windowName: focusedEntry.windowName,
              panes: focusedEntry.panes ?? [],
            }
          : null,
      [focusedEntry],
    ),
  );

  // Unpin the focused tile (non-destructive move-out). The board ✕ became a
  // REAL close-pane in 260715-6jwn (uniform with terminal mode — it kills the
  // focused tile's active pane, no confirm, focused-ring disambiguated), so the
  // ✕ no longer unpins. `unpinFocused` now survives ONLY as the `Board: Unpin
  // Focused Pane` palette-action handler (wired into `boardRouteActions` below)
  // — unpin also stays on the tile header. Declared ABOVE `boardRouteActions` so
  // the palette action consumes this shared handler rather than re-inlining
  // `unpin(...)` (parsimony — one unpin derivation, matching R6).
  const unpinFocused = useCallback(() => {
    const e = entries[focusedIndex];
    if (e) unpin(e.server, e.windowId, name);
  }, [entries, focusedIndex, unpin, name]);

  // Board kill is confirm-gated + consequence-legible (co9z). The board ✕ and
  // the palette kill entry both open this dialog instead of firing immediately,
  // because a board Kill destroys the window EVERYWHERE (home session included),
  // not just the board pane. `killTarget` is the focused window while the dialog
  // is open (null = closed). The confirmed Kill is a WINDOW-kill (killWindow —
  // "closes it everywhere"), distinct from the reversible tile-header Unpin. The
  // home session is resolved at open time from the SAME `homeSessionByKey` join
  // that feeds the pane-header crumb (single join implementation, R11) — read via
  // a ref (`homeSessionByKeyRef`, assigned just below the memo) so opening the
  // dialog does not couple this callback's identity to every SSE tick. Absent key
  // → window-only fallback copy (legacy pin / home died).
  const homeSessionByKeyRef = useRef<Map<string, string>>(new Map());
  const [killTarget, setKillTarget] = useState<{
    server: string;
    windowId: string;
    windowName: string;
    home?: string;
  } | null>(null);
  const requestKillFocused = useCallback(() => {
    const e = entries[focusedIndex];
    if (!e) return;
    setKillTarget({
      server: e.server,
      windowId: e.windowId,
      windowName: e.windowName || e.windowId,
      home: homeSessionByKeyRef.current.get(`${e.server}:${e.windowId}`),
    });
  }, [entries, focusedIndex]);
  const { execute: executeKillWindow } = useOptimisticAction<[string, string]>({
    action: async (srv, windowId) => {
      const res = await killWindow(srv, windowId);
      if (res.closed) pushRecentlyClosed(srv, res.closed);
      return res;
    },
    onSettled: () => refetch(),
    onError: (err) => addToast(err.message || "Failed to kill tab"),
  });
  const confirmKill = useCallback(() => {
    if (killTarget) executeKillWindow(killTarget.server, killTarget.windowId);
    setKillTarget(null);
  }, [killTarget, executeKillWindow]);
  const killUnpinInstead = useCallback(() => {
    if (killTarget) unpin(killTarget.server, killTarget.windowId, name);
    setKillTarget(null);
  }, [killTarget, unpin, name]);

  // Board-route-scoped command palette actions (260811-239r). Constitution V
  // (Keyboard-First) requires every action be keyboard-reachable — the board
  // route does not render AppShell (DD-8), so these route-scoped entries
  // (switch to other boards, leave the board view, cycle pane focus,
  // split/close the focused pane) are registered into the palette-actions slot
  // and rendered by the single layout-mounted CommandPalette ahead of the
  // layout-level global groups (nav, font, refresh, help, shortcuts, settings,
  // update/check/maintenance/version — `use-global-palette-actions.ts`, no
  // longer duplicated here). Pin/Unpin Current Tab are AppShell-only (no
  // current window exists in single-window sense on a board route).
  const boardRouteActions: PaletteAction[] = useMemo(() => {
    const switchEntries: PaletteAction[] = boards.map((b) => ({
      id: `board-switch-${b.name}`,
      label: `Board: Switch to ${b.name}${b.name === name ? " (current)" : ""}`,
      onSelect: () => navigate({ to: "/board/$name", params: { name: b.name } }),
    }));

    const conditional: PaletteAction[] = [
      {
        id: "board-leave",
        label: "Board: Leave Board View",
        onSelect: () => navigate({ to: "/" }),
      },
      // Autofit toggle (738w) — palette parity for the top-bar button
      // (Constitution V). Flips the same per-board `autofit` state; a no-op on
      // mobile (carousel is one full-width pane).
      {
        id: "board-toggle-autofit",
        label: autofit ? "Board: Toggle Autofit (on)" : "Board: Toggle Autofit (off)",
        onSelect: toggleAutofit,
      },
    ];

    // Board: Move up/down — reorder the CURRENT board within the board list,
    // built on the same `computeMoveOrder` helper + boundary-hidden / no-wraparound
    // gating as Server: Move up/down (Constitution V; also the touch fallback
    // where HTML5 DnD does not fire). `boards` is the backend-sorted display
    // order; the write posts the full computed order.
    const boardOrderNames = boards.map((b) => b.name);
    const currentBoardIdx = boardOrderNames.indexOf(name);
    const moveBoard = (delta: -1 | 1) => {
      const next = computeMoveOrder(boardOrderNames, currentBoardIdx, delta);
      if (!next) return; // boundary / not found: no-op
      setBoardOrder(next).catch((err: Error) => addToast(err.message || "Failed to move board"));
    };
    if (currentBoardIdx > 0) {
      conditional.push({
        id: "board-move-up",
        label: "Board: Move up",
        onSelect: () => moveBoard(-1),
      });
    }
    if (currentBoardIdx >= 0 && currentBoardIdx < boardOrderNames.length - 1) {
      conditional.push({
        id: "board-move-down",
        label: "Board: Move down",
        onSelect: () => moveBoard(1),
      });
    }

    // The global groups (nav/font/refresh/help/shortcuts/settings/update/
    // check/maintenance/version) moved to the layout-level builder
    // (`use-global-palette-actions.ts`, 260811-239r) — the seven DD-8
    // duplicates that lived here are gone.

    if (entries.length > 0) {
      conditional.push({
        id: "board-cycle-next",
        label: "Board: Cycle Pane Focus →",
        onSelect: () => {
          // Same stale-flag guard as the keyboard cycle: a single-pane modulo
          // cycle leaves the index unchanged, so skip the intent set.
          if (entries.length >= 2) focusIntentRef.current = true;
          setFocusedIndex((prev) => (prev + 1) % entries.length);
        },
      });
      conditional.push({
        id: "board-cycle-prev",
        label: "Board: Cycle Pane Focus ←",
        onSelect: () => {
          if (entries.length >= 2) focusIntentRef.current = true;
          setFocusedIndex((prev) => (prev - 1 + entries.length) % entries.length);
        },
      });
      // Keyboard parity for the tile-header unpin (Constitution V; 260704-9o7k).
      // Unpins the focused pane (non-destructive) via the shared `unpinFocused`
      // handler — the single unpin derivation (R6). The top-bar ✕ became a kill
      // in 260715-6jwn, but unpin still lives here + on the tile header.
      conditional.push({
        id: "board-unpin-focused",
        label: "Board: Unpin Focused Pane",
        onSelect: unpinFocused,
      });

      // Keyboard parity for the top-bar board split control (Constitution V;
      // 260715-6jwn). Act on the focused tile's window via the shared
      // `focusedPane` memo — the SAME `{server, windowId, cwd}` the top-bar slot
      // consumes, so there is one derivation of the active-pane cwd, not a
      // duplicated per-handler lookup (parsimony). Split booleans match the
      // top-bar chip's semantics (260806-2x2h resolved the old cross-surface
      // divergence): Horizontal → `horizontal: true` (tmux `-h`, side-by-side),
      // Vertical → `false` (stacked); Horizontal listed first (default-first).
      // The board Kill lives in `board-kill-focused` above (routes through the
      // confirm dialog), not here.
      conditional.push({
        id: "board-split-horizontal",
        label: "Board: Split Focused Pane Horizontal",
        onSelect: () => {
          if (focusedPane) executeSplit(focusedPane.server, focusedPane.windowId, true, focusedPane.cwd);
        },
      });
      conditional.push({
        id: "board-split-vertical",
        label: "Board: Split Focused Pane Vertical",
        onSelect: () => {
          if (focusedPane) executeSplit(focusedPane.server, focusedPane.windowId, false, focusedPane.cwd);
        },
      });
      // Board Kill (co9z) — routes through the confirm dialog (NOT an immediate
      // close-pane). The verb is "Kill" on board surfaces: a board Kill destroys
      // the window everywhere (home session included), so it is consequence-gated
      // with an `Unpin instead` escape. Retires the old `Board: Close Focused
      // Pane` entry.
      conditional.push({
        id: "board-kill-focused",
        label: "Board: Kill Focused Pane",
        onSelect: requestKillFocused,
      });

      // Keyboard parity for header drag-reorder (Constitution V). Boundary-gated
      // with NO wraparound — hidden (not disabled) at the edge, matching the
      // palette Move up/down convention (computeMoveOrder). Acts on the focused
      // pane: computes before/after via the shared neighbour helper, fires ONE
      // reorder POST (same single-call path as DnD; fractional indexing).
      //
      // Focus follows the moved pane by KEY, NOT by an optimistic index bump:
      // the palette move does NOT go through the DnD optimistic override, so the
      // display does not reorder until the board-changed SSE echo. Bumping
      // `focusedIndex` to `i±1` here would move the ring — and route imperative
      // xterm focus — into the DISPLACED NEIGHBOUR's terminal (paneRefs are
      // keyed to the authoritative order, still the OLD order pre-echo). Instead
      // we leave `focusedIndex` alone: the moved pane IS the focused pane and it
      // stays visually put until the echo, at which point the key-reconcile
      // effect repositions `focusedIndex` to the moved pane's new slot. Result:
      // keystrokes land in the moved pane both before and after the echo
      // (rework must-fix #3).
      const orderedIds = entries.map((e) => `${e.server}:${e.windowId}`);
      const moveFocusedPane = (delta: -1 | 1) => {
        const e = entries[focusedIndex];
        if (!e) return;
        const neighbors = computeMoveNeighbors(orderedIds, focusedIndex, delta);
        if (!neighbors) return; // boundary no-op (guarded by the gating below too)
        const stripServer = (k: string | null) =>
          k === null ? null : k.slice(k.indexOf(":") + 1);
        // `reorderWithFollow` (wrapping usePinActions' `reorder`) shows a toast
        // AND rethrows on failure, and it clears the own-move intent flag in its
        // own `.catch` before rethrowing; the palette has no client-side
        // optimistic order to roll back (unlike the DnD override), so just
        // swallow here to avoid an unhandled rejection — the toast already
        // informed the user, the intent flag is already cleared, and the absent
        // SSE echo leaves the order unchanged. Own-move focus-follow rides
        // `reorderWithFollow` (R6 preserved through the SSE echo's reconcile).
        reorderWithFollow(
          e.server,
          e.windowId,
          name,
          stripServer(neighbors.before),
          stripServer(neighbors.after),
        ).catch(() => {});
      };
      if (focusedIndex > 0) {
        conditional.push({
          id: "board-move-pane-left",
          label: "Board: Move Focused Pane Left",
          onSelect: () => moveFocusedPane(-1),
        });
      }
      if (focusedIndex < entries.length - 1) {
        conditional.push({
          id: "board-move-pane-right",
          label: "Board: Move Focused Pane Right",
          onSelect: () => moveFocusedPane(1),
        });
      }
    }

    // Palette hints (260730-g40a): registered actions with palette entries
    // (the pane-cycle pair) render their EFFECTIVE combos per platform,
    // reflecting overrides. The global groups are decorated at the layout
    // level (260811-239r).
    return withShortcutHints(
      [...switchEntries, ...conditional],
      bindingByAction,
      bindingHost.platform,
    );
  }, [boards, name, entries, focusedIndex, autofit, toggleAutofit, unpinFocused, requestKillFocused, focusedPane, reorderWithFollow, executeSplit, navigate, addToast, bindingByAction, bindingHost]);
  // Publish this route's (already shortcut-decorated) list into the
  // palette-actions slot — the single layout-mounted CommandPalette renders
  // `[...routeActions, ...globalActions]`; cleared on unmount so the next
  // route never sees stale entries (260811-239r).
  useRegisterPaletteActions(boardRouteActions);

  // Pane-server count (distinct servers) used by TopBar board-mode info.
  const serverCount = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.server);
    return set.size;
  }, [entries]);

  // Attention rollup (260706-y1ar; status-pyramid.md § Attention Propagation).
  // A `BoardEntry` is a thin shape with no `agentState`, so join each pinned
  // pane back to its live `WindowInfo` via (server, windowId) against the
  // streamed `sessionsByServer`. use-boards attaches every board server, so this
  // window data (incl. `agentState`) is flowing for board panes. The set drives
  // both the per-pane pulsing seam and the header waiting count. A pane whose
  // window is not yet in the snapshot is simply not waiting (no wrong signal).
  const waitingWindowIds = useMemo(() => {
    // Build the set of waiting window keys once per distinct board server
    // (scan each server's windows a single time, not per-entry), then keep
    // only the keys that a board entry pins. Avoids the O(entries × windows)
    // flatMap-then-find that re-scanned + re-allocated per entry on every SSE
    // tick.
    const waitingKeys = new Set<string>();
    const seenServers = new Set<string>();
    for (const e of entries) {
      if (seenServers.has(e.server)) continue;
      seenServers.add(e.server);
      for (const s of ctx.sessionsByServer.get(e.server) ?? []) {
        for (const w of s.windows) {
          if (isWaiting(w)) waitingKeys.add(`${e.server}:${w.windowId}`);
        }
      }
    }
    const set = new Set<string>();
    for (const e of entries) {
      const key = `${e.server}:${e.windowId}`;
      if (waitingKeys.has(key)) set.add(key);
    }
    return set;
  }, [entries, ctx.sessionsByServer]);
  const waitingPaneCount = waitingWindowIds.size;

  // Home-session crumb map (co9z): `server:windowId` → the window's HOME session
  // name, derived from the live sessions snapshot. Possible now precisely because
  // a pinned window stays LINKED into its home session, so it appears under a
  // visible session. Built once per distinct board server (single scan), then
  // narrowed to the pinned entries — mirrors the waitingWindowIds shape to avoid
  // an O(entries × windows) re-scan on every SSE tick. A window not present in
  // the snapshot (legacy pin / home died) is simply absent from the map, and the
  // header/dialog fall back to window-only copy.
  const homeSessionByKey = useMemo(() => {
    const byWindow = new Map<string, string>();
    const seenServers = new Set<string>();
    for (const e of entries) {
      if (seenServers.has(e.server)) continue;
      seenServers.add(e.server);
      for (const s of ctx.sessionsByServer.get(e.server) ?? []) {
        for (const w of s.windows) {
          byWindow.set(`${e.server}:${w.windowId}`, s.name);
        }
      }
    }
    const out = new Map<string, string>();
    for (const e of entries) {
      const key = `${e.server}:${e.windowId}`;
      const home = byWindow.get(key);
      if (home !== undefined) out.set(key, home);
    }
    return out;
  }, [entries, ctx.sessionsByServer]);
  // Mirror the join into a ref so `requestKillFocused` (declared above, before
  // this memo) can read the current home map at click time without depending on
  // it — keeping that callback's identity stable across SSE ticks (parsimony:
  // one join, consumed by both the crumb and the kill dialog).
  homeSessionByKeyRef.current = homeSessionByKey;

  // Connection dot (260704-9o7k; footer-hosted since 260724-6j1v): "this
  // board's live data is flowing". Green only when the board has entries AND
  // every distinct attached server's SSE slice is connected (binary AND — a
  // single disconnected server flips it gray; a zero-entry board is gray,
  // nothing is flowing). Feeds the Sidebar footer dot via the `isConnected`
  // prop below (the dot left the top bar).
  const boardConnected = useMemo(() => {
    const servers = new Set<string>();
    for (const e of entries) servers.add(e.server);
    if (servers.size === 0) return false;
    for (const s of servers) {
      if (!ctx.isConnectedByServer.get(s)) return false;
    }
    return true;
  }, [entries, ctx.isConnectedByServer]);

  // Publish the board TopBar's page-owned props into the persistent root bar's
  // slot (260707-4vq2). `mode` (`board`) and `boardName` are derived at root
  // from the route; the board extras (counts, waiting badge, board switcher, the
  // focused-tile split/kill target) travel through the slot.
  // Session/window props stay tolerant-empty (board mode has no session context,
  // the terminal-only L1 chrome — the Open button, the ▦ layout chip, the
  // fixed-width menu row — stays hidden via `currentWindow: null`; the board
  // SplitButtons key on `focusedPane` instead). Memoized so the registration
  // effect re-runs only when a board prop changes.
  const boardTopBarBoards = useMemo(
    () => boards.map((b) => ({ name: b.name })),
    [boards],
  );
  const onToggleSidebar = useCallback(
    () => setSidebarOpen(!sidebarOpen),
    [setSidebarOpen, sidebarOpen],
  );
  useRegisterTopBarSlot(
    useMemo(
      () => ({
        sessions: [],
        currentSession: null,
        currentWindow: null,
        sessionName: "",
        windowName: "",
        sidebarOpen,
        server: "",
        onNavigate: () => {},
        onToggleSidebar,
        onCreateWindow: () => {},
        paneCount: entries.length,
        serverCount,
        waitingPaneCount,
        boards: boardTopBarBoards,
        // The top-bar Kill row + SplitControl act on the focused tile's window
        // (`focusedPane`). co9z: the board Kill is a consequence-gated KILL —
        // `onRequestKill` opens the confirm dialog (with an `Unpin instead`
        // escape) instead of firing close-pane. The confirmed kill's self-heal
        // refetch is driven by `executeKillWindow`'s own `onSettled` (above), not
        // a top-bar callback. Unpin lives on the tile header + the palette action.
        focusedPane,
        onRequestKill: requestKillFocused,
        autofit,
        onToggleAutofit: toggleAutofit,
      }),
      [
        sidebarOpen,
        onToggleSidebar,
        entries.length,
        serverCount,
        waitingPaneCount,
        boardTopBarBoards,
        focusedPane,
        requestKillFocused,
        autofit,
        toggleAutofit,
      ],
    ),
  );

  // sidebarOpen drives the hamburger animation; setSidebarOpen handles the
  // toggle and mobile destination-tap auto-close. Both are destructured above
  // (alongside the terminal-font mutators) so AppShell and BoardPage share one
  // ChromeContext toggle target.

  // Focus / scroll-lock plumbing for the shell-level BottomBar. BottomBar is
  // byte-identical across routes per spec § Behavioral Correctness, so the board
  // route MUST pass the same callback set as AppShell — otherwise the `>_`
  // compose-toggle button is gated out (BottomBar renders it iff `onOpenCompose`
  // is truthy) and `ScrollLock` long-press never reaches a handler. The compose
  // strip is a single global surface enabled via the `composeStripEnabled`
  // chrome preference; the `>_` chip toggles it, and the strip reads the focused
  // BoardPane live from `FocusedTerminalContext` (260718-dhdj). Scroll-lock is
  // likewise a persisted chrome preference (`scrollLocked` above) — BottomBar
  // owns the toggle, this page only threads the value down to the panes.
  const focusFocusedPaneRef = useRef<(() => void) | null>(null);
  // Track the currently-focused pane's imperative focus method so BottomBar's
  // "Show keyboard" handler can re-focus the right xterm. The focused pane
  // updates this on each focusedIndex change.
  useEffect(() => {
    focusFocusedPaneRef.current = () => paneRefs.current[focusedIndex]?.focus();
  }, [focusedIndex]);

  // Stable select-window handler (R6a). BoardPage consumes `useSessionContext()`
  // and re-renders on every SSE tick; an inline arrow here would defeat
  // `ServerGroup`'s `React.memo`. `navigate`/`isMobile`/`setSidebarOpen` are all
  // stable across SSE ticks.
  const handleSelectWindow = useCallback(
    (srv: string, _sess: string, windowId: string) => {
      // Identity is window-id only on the 2-segment route.
      navigate({
        to: "/$server/$window",
        params: { server: srv, window: windowId },
      });
      if (isMobile) setSidebarOpen(false);
    },
    [navigate, isMobile, setSidebarOpen],
  );

  // Stable kill-server handler — same R6a reasoning as handleSelectWindow:
  // `onKillServer` threads into the memoized `ServerGroup` header cluster
  // (260721-x4sf), so an inline arrow would defeat the memo skip on every SSE
  // tick. The context trigger (`requestKillServer`, 260811-239r) is
  // referentially stable by construction — it passes straight through at the
  // Sidebar call site.

  // Sidebar element shared between desktop grid placement and mobile overlay.
  // `currentServer = null` because the board route has no `$server` param —
  // no group is marked current and all server groups follow persisted toggles.
  const sidebarElement = (
    <Sidebar
      currentServer={null}
      currentSession={null}
      currentWindowId={null}
      isConnected={boardConnected}
      onSelectWindow={handleSelectWindow}
      onCreateWindow={handleCreateWindow}
      onCreateSession={handleCreateSession}
      onCreateServer={openCreateServer}
      onKillServer={requestKillServer}
    />
  );

  // `h-full` is load-bearing: Shell sizes to `height: 100%` (260707-4vq2), so
  // this wrapper must span AppLayout's `flex-1` content region or the whole
  // board collapses to content height.
  return (
    <div className="h-full bg-bg-primary text-text-primary">
      <Shell
        sidebarChildren={sidebarElement}
        // Status bar (260814-ldbs): host cluster only on the board route (no
        // current window); the compose hint keeps the board's working
        // `toggleComposeStrip` wiring so the strip stays reachable on
        // fine-pointer desktops now that the bottom bar is pointer-gated away.
        statusBarChildren={
          <StatusBar
            window={null}
            server={null}
            isConnected={boardConnected}
            onOpenCompose={toggleComposeStrip}
          />
        }
        bottomBarChildren={
          <>
            {/* Unconditional: the strip module renders the collapsed tongue
                when the preference is off and the inert no-target tongue
                while no board pane is selected. */}
            <ComposeStrip onEscapeToTerminal={() => focusFocusedPaneRef.current?.()} />
            {/* The bar renders its own 3px-seam + min-48px frame (260814) and
                self-gates to null on fine pointers (260814-ldbs), so an empty
                row collapses with no reserved height. Callbacks mirror
                AppShell so the bar is byte-identical across routes (spec
                § Behavioral Correctness, A-022) — without these the `>_`
                compose button is gated out and the long-press scroll-lock
                affordance is inert. */}
            <BottomBar
              onOpenCompose={toggleComposeStrip}
              onFocusTerminal={() => focusFocusedPaneRef.current?.()}
            />
          </>
        }
      >
        {/* The desktop sidebar aside is now Shell-owned (260719-rwqf): BoardPage
            passes only `sidebarChildren` and Shell renders the
            `<aside gridArea:"sidebar" aria-label="Sidebar">` (gated
            `!isMobile && sidebarOpen`). No `sidebarResizeHandle` is passed —
            drag-resize is intentionally absent on the board route — so Shell's
            no-handle branch keeps the `border-r border-border` seam. The column
            width still comes from ChromeContext. */}

        {/* Top bar mount moved to the persistent root layout (260707-4vq2).
            Board mode + `boardName` are derived at root from the route; the
            board extras (pane/server counts, waiting badge, board switcher, and
            the focused-tile split/kill target `focusedPane` + the `onRequestKill`
            confirm-dialog opener — co9z: the board ✕ is a consequence-gated KILL,
            not close-pane) are published into the slot context via the
            `useRegisterTopBarSlot` effect above. The confirmed kill's self-heal
            refetch rides `executeKillWindow`'s own `onSettled`, not a top-bar
            callback. The terminal-only L1 chrome (Open button / ▦ layout
            chip / fixed-width row) stays hidden via `currentWindow: null`. */}

        {/* Content grid area — horizontal-scroll body. Viewport begins
            flush with sidebar.right (no left gutter). */}
        <main
          style={{ gridArea: "content" }}
          className="min-w-0 overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {error && entries.length === 0 ? (
            <div className="p-4 text-sm text-red-500">Error loading board: {error.message}</div>
          ) : showEmptyState ? (
            <div className="p-4 flex flex-col items-start gap-2">
              <p className="text-sm text-text-secondary">
                {paletteChord
                  ? `No panes pinned to this board yet — hover a sidebar tab row and click its 📌, or ${paletteChord} → Pin:`
                  : "No panes pinned to this board yet — hover a sidebar tab row and click its 📌"}
              </p>
              <Link to="/" className="text-sm text-accent hover:underline">
                ← Back to sessions
              </Link>
            </div>
          ) : isMobile ? (
            <MobileCarousel
              entries={entries}
              carouselIndex={carouselIndex}
              onUnpin={(e) => unpin(e.server, e.windowId, name)}
              paneRefs={paneRefs}
              focusedIndex={focusedIndex}
              onPaneClick={handlePaneClick}
              scrollLocked={scrollLocked}
              waitingWindowIds={waitingWindowIds}
              homeSessionByKey={homeSessionByKey}
            />
          ) : (
            <DesktopRow
              entries={entries}
              board={name}
              reorder={reorderWithFollow}
              getWidth={(id) => (getWidth(id) || BOARD_PANE_DEFAULT_WIDTH)}
              autofit={autofit}
              onResizeStart={handleResizeStart}
              onUnpin={(e) => unpin(e.server, e.windowId, name)}
              paneRefs={paneRefs}
              focusedIndex={focusedIndex}
              onPaneClick={handlePaneClick}
              scrollLocked={scrollLocked}
              waitingWindowIds={waitingWindowIds}
              homeSessionByKey={homeSessionByKey}
            />
          )}
        </main>

        {/* Bottom bar + compose strip moved OUT of the children into Shell's
            `bottomBarChildren` slot (260814-ldbs) — Shell owns the footer's
            grid placement on every route now. New on the board route in 17m3
            — pre-change board route had no BottomBar. */}
      </Shell>

      {/* Command palette, shortcuts overlay, and the server create/kill
          dialogs mount ONCE in AppLayout now (260811-239r): this route
          registers its board-scoped actions into the palette-actions slot
          (above) and triggers the dialogs via `server-dialogs-context`; the
          DD-8 twins are gone. The board's kill-WINDOW confirm below stays
          route-owned (co9z — kill-everywhere semantics + the `Unpin instead`
          escape differ from the terminal route's current-window confirm). */}

      {/* Board kill confirm (co9z). A board Kill destroys the window EVERYWHERE
          (its home session too), not just the board pane — so it is
          consequence-gated with a safe `Unpin instead` escape. `Unpin instead`
          is the FIRST focusable element so `Dialog` auto-focuses it (default
          focus on the safe action); the dialog is fully keyboard-operable
          (Escape/Tab/backdrop via `Dialog`). When the home session is not
          derivable (legacy pin / home died — window absent from the sessions
          snapshot), the copy falls back to window-only. */}
      {killTarget && (
        <Dialog title={`Kill ${killTarget.windowName}?`} onClose={() => setKillTarget(null)}>
          <p className="text-text-secondary mb-2.5">
            {killTarget.home ? (
              <>
                This closes it everywhere — including session <strong>{killTarget.home}</strong>.
              </>
            ) : (
              <>This closes the tab everywhere.</>
            )}
          </p>
          <div className="flex gap-2">
            <button
              onClick={killUnpinInstead}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Unpin instead
            </button>
            <button
              onClick={confirmKill}
              className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
            >
              Kill
            </button>
            <button
              onClick={() => setKillTarget(null)}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function DesktopRow({
  entries,
  board,
  reorder,
  getWidth,
  autofit,
  onResizeStart,
  onUnpin,
  paneRefs,
  focusedIndex,
  onPaneClick,
  scrollLocked,
  waitingWindowIds,
  homeSessionByKey,
}: {
  entries: ReturnType<typeof useBoardEntries>["entries"];
  board: string;
  reorder: ReturnType<typeof usePinActions>["reorder"];
  getWidth: (windowId: string) => number;
  /** Autofit mode (738w): panes become equal-share flex items filling the row
   *  (≤4 panes) or floor at ~25% + scroll (>4). Resize handles are hidden and
   *  the pixel width is not passed while on; stored widths are left untouched. */
  autofit: boolean;
  onResizeStart: (windowId: string, clientX: number) => void;
  onUnpin: (entry: ReturnType<typeof useBoardEntries>["entries"][number]) => void;
  paneRefs: React.MutableRefObject<Array<BoardPaneHandle | null>>;
  focusedIndex: number;
  onPaneClick: (idx: number) => void;
  scrollLocked: boolean;
  /** (server:windowId) keys of panes whose joined window is `waiting`. */
  waitingWindowIds: Set<string>;
  /** (server:windowId) → HOME session name for the `{session} › {window}`
   *  crumb (co9z); absent key → header falls back to window-only. */
  homeSessionByKey: Map<string, string>;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Header-only drag-reorder. Renders `orderedEntries` (the optimistic override
  // during a drag, else the authoritative `entries`); focus/pane-ref/visibility
  // bookkeeping stays keyed to the AUTHORITATIVE index so a pane keeps its
  // identity (focus, live-relay slot) as its display position changes mid-drag.
  const { orderedEntries, getHandleProps, draggingKey } = useBoardPaneReorder(
    entries,
    board,
    reorder,
  );

  // Relay-suspension feature is plaintext-only: the ~6-connection-per-origin
  // ceiling is an HTTP/1.1 artifact. Over HTTPS/h2 (production via Tailscale)
  // it does not exist, so behavior there is exactly today's (`paused={false}`,
  // no observer, no cap). `window.location.protocol === "http:"` classifies the
  // E2E/dev path (the worktree's derived dev-server port) and raw-port access
  // as plaintext.
  const plaintext = typeof window !== "undefined" && window.location.protocol === "http:";

  // Per-pane root DOM elements, keyed by pane index, for the IntersectionObserver
  // to observe. Distinct from `paneRefs` (which holds the imperative
  // `BoardPaneHandle` for `focus()`); BoardPane exposes its root element via the
  // separate `rootRef` callback prop so neither contract leaks into the other.
  const paneElsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  // Indices currently within the viewport (incl. pre-warm margin). Only tracked
  // on plaintext origins; on secure origins it stays empty and is unused.
  const [visibleIndices, setVisibleIndices] = useState<Set<number>>(new Set());

  // Most-recently-focused pane order (most-recent first), used to break ties
  // when more panes are visible than the live-pane cap allows. The ref is the
  // persistent backing store; we fold the current `focusedIndex` to the front
  // during render (via useMemo keyed on focusedIndex) rather than in a post-commit
  // effect, so the order consumed by `selectLivePanes` below is never one render
  // stale — cap eviction always sees the focused pane as most-recent immediately.
  const mruRef = useRef<number[]>([]);
  const mruOrder = useMemo(() => {
    const next = [focusedIndex, ...mruRef.current.filter((i) => i !== focusedIndex)];
    mruRef.current = next;
    return next;
  }, [focusedIndex]);

  // Translate horizontal wheel intent (trackpad two-finger pan, or shift+wheel
  // which browsers deliver as deltaX) into row scroll. Vertical wheels bubble
  // through to xterm so per-pane scrollback still works.
  //
  // Capture phase: xterm.js attaches a bubble-phase wheel listener on its
  // viewport that scrolls scrollback and stops further handling, so a focused
  // terminal swallows the event before it reaches the row in the bubble path.
  // Capture runs ancestor-first, so we see the event before xterm and can
  // preventDefault() on horizontal intent.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        el.scrollLeft += e.deltaX;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  // Visibility tracking via IntersectionObserver, rooted on the horizontal-scroll
  // container (plaintext origins only). Mirrors the wheel effect's setup/cleanup
  // discipline. Re-runs when the pane count changes so newly-added panes are
  // observed and removed panes drop out of the visible set. On secure origins
  // the observer is never created — every pane stays live (today's behavior).
  useEffect(() => {
    if (!plaintext) return;
    const root = rowRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (records) => {
        setVisibleIndices((prev) => {
          const next = new Set(prev);
          for (const record of records) {
            const target = record.target;
            if (!(target instanceof HTMLElement)) continue;
            const attr = target.dataset.paneIndex;
            if (attr === undefined) continue;
            const idx = Number(attr);
            if (record.isIntersecting) next.add(idx);
            else next.delete(idx);
          }
          return next;
        });
      },
      { root, rootMargin: RELAY_PREWARM_ROOT_MARGIN, threshold: 0 },
    );
    for (const el of paneElsRef.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [plaintext, entries.length]);

  // Compute the live-pane set. On secure origins, every pane is live (feature
  // off). On plaintext origins, the focused pane plus the most-recently-focused
  // visible panes are live, capped at MAX_LIVE_RELAY_PANES.
  const livePanes = plaintext
    ? selectLivePanes({
        visible: visibleIndices,
        focusedIndex,
        mruOrder,
        cap: MAX_LIVE_RELAY_PANES,
      })
    : null;

  // Authoritative index by `server:windowId` key. Bookkeeping (paneRefs,
  // focus, visibility cap) keys on this so a pane keeps its identity while its
  // DISPLAY position shifts under the optimistic drag override.
  const authIdxByKey = new Map<string, number>(
    entries.map((e, i) => [`${e.server}:${e.windowId}`, i]),
  );

  return (
    <div ref={rowRef} className="h-full w-full overflow-x-auto flex gap-[6px]">
      {orderedEntries.map((entry) => {
        const key = `${entry.server}:${entry.windowId}`;
        // Authoritative index (fallback to a display-stable value if a pane
        // appears only in the override, e.g. mid-drag pin — should not happen).
        const authIdx = authIdxByKey.get(key) ?? -1;
        const { handle, drop } = getHandleProps(entry.server, entry.windowId);
        return (
          <BoardPane
            key={key}
            ref={(el) => {
              if (authIdx >= 0) paneRefs.current[authIdx] = el;
            }}
            rootRef={(el) => {
              if (el) {
                el.dataset.paneIndex = String(authIdx);
                if (authIdx >= 0) paneElsRef.current.set(authIdx, el);
              } else if (authIdx >= 0) {
                paneElsRef.current.delete(authIdx);
              }
            }}
            entry={entry}
            // Autofit ignores the stored pixel width (equal-share flex item);
            // off passes the persisted per-pane width. Not reading `getWidth`
            // while on keeps the stored widths untouched (non-destructive).
            width={autofit ? undefined : getWidth(entry.windowId)}
            autofit={autofit}
            paused={livePanes === null ? false : !livePanes.has(authIdx)}
            isFocused={authIdx === focusedIndex}
            dimmed={draggingKey === key}
            waiting={waitingWindowIds.has(key)}
            homeSession={homeSessionByKey.get(key)}
            onClick={() => onPaneClick(authIdx)}
            onUnpin={() => onUnpin(entry)}
            showResizeHandle={!autofit}
            onResizeStart={(clientX) => onResizeStart(entry.windowId, clientX)}
            scrollLocked={scrollLocked}
            dragHandleProps={handle}
            dropTargetProps={drop}
          />
        );
      })}
    </div>
  );
}

function MobileCarousel({
  entries,
  carouselIndex,
  onUnpin,
  paneRefs,
  focusedIndex,
  onPaneClick,
  scrollLocked,
  waitingWindowIds,
  homeSessionByKey,
}: {
  entries: ReturnType<typeof useBoardEntries>["entries"];
  carouselIndex: number;
  onUnpin: (entry: ReturnType<typeof useBoardEntries>["entries"][number]) => void;
  paneRefs: React.MutableRefObject<Array<BoardPaneHandle | null>>;
  focusedIndex: number;
  onPaneClick: (idx: number) => void;
  scrollLocked: boolean;
  /** (server:windowId) keys of panes whose joined window is `waiting`. */
  waitingWindowIds: Set<string>;
  /** (server:windowId) → HOME session name for the `{session} › {window}`
   *  crumb (co9z); absent key → header falls back to window-only. */
  homeSessionByKey: Map<string, string>;
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex">
        {entries.map((entry, idx) => (
          <div
            key={`${entry.server}:${entry.windowId}`}
            className={`shrink-0 w-full ${idx === carouselIndex ? "block" : "hidden"}`}
          >
            <BoardPane
              ref={(el) => {
                paneRefs.current[idx] = el;
              }}
              entry={entry}
              // No `width` prop — mobile carousel uses CSS (`w-full`) so the
              // pane stays reactive to viewport changes (orientation/resize)
              // and works in non-browser environments (SSR/tests). Reading
              // `window.innerWidth` at render time would lock the value at
              // first render and break on rotation.
              paused={idx !== carouselIndex}
              isFocused={idx === focusedIndex}
              waiting={waitingWindowIds.has(`${entry.server}:${entry.windowId}`)}
              homeSession={homeSessionByKey.get(`${entry.server}:${entry.windowId}`)}
              onClick={() => onPaneClick(idx)}
              onUnpin={() => onUnpin(entry)}
              showResizeHandle={false}
              scrollLocked={scrollLocked}
            />
          </div>
        ))}
      </div>
      {/* Pagination dots */}
      <div className="shrink-0 flex justify-center gap-1.5 py-2">
        {entries.map((_, idx) => (
          <span
            key={idx}
            aria-label={`pane ${idx + 1}${idx === carouselIndex ? " (current)" : ""}`}
            className={`w-2 h-2 rounded-full ${idx === carouselIndex ? "bg-accent" : "bg-text-secondary/30"}`}
          />
        ))}
      </div>
    </div>
  );
}
