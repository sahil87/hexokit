import { lazy, Suspense, useEffect, useRef, useMemo, useState, useCallback, useSyncExternalStore } from "react";
import { useNavigate, useMatches, useSearch, Outlet } from "@tanstack/react-router";
import {
  availableViews,
  hasWebUrl,
  readStoredView,
  windowViewStorageKey,
  type ViewName,
  type ViewWindow,
} from "@/lib/window-view";
import {
  availableSurfaces,
  panelStorageKey,
  readStoredPanel,
  type SurfaceName,
} from "@/lib/right-panel";
import {
  codeRootFollowTarget,
  codeRootFor,
  codeRootSeed,
} from "@/lib/code-folder-latch";
import {
  addSurface,
  applyTemplate,
  availableTiles,
  bareLeaves,
  closeSurface,
  cycleTemplate,
  effectiveLayout,
  leafIds,
  leaves,
  legacyTranslationDecision,
  openTileKinds,
  parseLayoutTree,
  promote,
  readStoredSizes,
  readStoredZoom,
  serializeLayoutTree,
  slotOrder,
  swapDirectional,
  toggleSurface,
  translateLegacyParams,
  writeStoredZoom,
  zoomLeafKind,
  SURFACE_LABEL,
  type Layout,
  type Rect,
  type SurfaceKind,
  type SwapDirection,
  type TemplateName,
} from "@/lib/surface-layout";
import { parseLeafAddress, pruneDeadLeaves } from "@/lib/layout-tree";
import { parsePopLeaf, popoutToggleAction, popoutToggleTarget, reducePopped } from "@/lib/popout";
import { usePoppedSet, usePopoutPresence } from "@/hooks/use-popout";
import { focusIsEngaged, hasReclaimableMatch, shouldSuppressChord, withShortcutHints, formatCombo } from "@/lib/keybindings";
import { requestQuakeTerminal, findOperatorWindow, resolveQuakeServer } from "@/lib/quake-terminal";
import { WEB_FIND_OPEN_EVENT } from "@/lib/find-in-page";
import { TERMINAL_FIND_OPEN_EVENT } from "@/lib/terminal-find";
import { EXPORT_EVENT, type ExportAction } from "@/lib/terminal-export";
import { WEB_ADDRESS_FOCUS_EVENT, WEB_INSPECT_EVENT, WEB_OPEN_EXTERNAL_EVENT } from "@/lib/web-url";
import { WEB_ZOOM_EVENT } from "@/lib/web-zoom";
import { isMacroActionId, type MacroAction } from "@/lib/macros";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useKeybindingDispatch } from "@/hooks/use-keybinding-dispatch";
import { useMacros } from "@/hooks/use-macros";
import { ChromeProvider, useChromeState, useChromeDispatch, SIDEBAR_WIDTH_BOUNDS } from "@/contexts/chrome-context";
import { ZenProvider, useZenState, useZenDispatch, zenApplies } from "@/contexts/zen-context";
import { FocusedTerminalProvider } from "@/contexts/focused-terminal-context";
import { TopBarSlotProvider, useTopBarSlot, useTopBarNotFound, useTopBarPopout, useRegisterTopBarSlot, useRegisterTopBarPopout } from "@/contexts/top-bar-slot-context";
import { FocusedPaneProvider } from "@/contexts/focused-pane-context";
import { computeKillRedirect } from "@/lib/navigation";
import {
  readLastWindow,
  resolveServerLandingWindow,
  writeLastWindow,
} from "@/lib/last-window-per-server";
import { deriveEffectiveSessionOrder, computeMoveOrder, computeWindowMoveTarget } from "@/lib/palette/move";
import { buildViewActions } from "@/lib/palette/view";
import { buildLayoutActions, buildTileSwitchActions, type BringWindow } from "@/lib/palette/layout";
import { buildGuiActions, type GuiPaletteAction } from "@/lib/palette/gui";
import { closestAspectPreset } from "@/lib/gui-geometry";
import { buildDesktopPaletteRows } from "@/lib/gui-desktop";
import { useDesktopPick } from "@/hooks/use-desktop-pick";
import {
  readGuiPointerMode,
  readGuiQuality,
  readGuiResizeLocked,
  readGuiStatsVisible,
  readGuiZoom,
  readGuiHidpi,
  readGuiKeyBarVisible,
  readGuiToolbarVisible,
  readGuiCapture,
  stepGuiZoom,
  writeGuiPointerMode,
  writeGuiQuality,
  writeGuiResizeLocked,
  writeGuiStatsVisible,
  writeGuiZoom,
  writeGuiHidpi,
  writeGuiKeyBarVisible,
  writeGuiToolbarVisible,
  writeGuiCapture,
  type GuiPointerMode,
  type GuiQuality,
  type GuiZoom,
} from "@/lib/gui-posture";
import { readWebCapture, writeWebCapture } from "@/lib/web-capture";
import { GUI_SEND_KEY_MIRROR_REFUSAL, sendKeyChord, type KeyChord } from "@/lib/gui-send-key";
import { buildZenActions } from "@/lib/palette/zen";
import { buildCodeActions } from "@/lib/palette/code";
import { resolveZenToggle } from "@/lib/zen-mode";
import { buildStatusRefreshAction } from "@/lib/palette/status-refresh";
import { buildPinActions } from "@/lib/palette/pin";
import {
  buildSelectAllMergedAction,
  buildSelectionCloseAction,
  buildSelectionMoveActions,
  buildSelectionSendPromptAction,
  batchToast,
  executeSelectionBatch,
} from "@/lib/palette/selection";
import { singleSelectedServer } from "@/lib/selection";
import { useSelectionStore } from "@/store/selection-store";
import { buildServerKillActions } from "@/lib/palette/server-kill";
import { buildServerProtectActions } from "@/lib/palette/server-protect";
import { buildServerAdoptActions } from "@/lib/palette/server-adopt";
import { buildServerSetColorAction } from "@/lib/palette/server-color";
import { buildShellServerActions } from "@/lib/palette/shell";
import { buildWebEngineActions, buildWebInspectActions } from "@/lib/palette/web-engine";
import { canCloseShellWindow, canNewShellWindow, canShellPopout, canShellWeb, closeShellWindow, isShell, newShellWindow, switchShellServer } from "@/lib/shell";
import { WEB_NATIVE_ENGINE_DEFAULT, WEB_NATIVE_ENGINE_PREF_KEY, selectWebEngineKind } from "@/lib/web-engine-pref";
import { ShellTitlebarStrip } from "@/components/desktop-shell/titlebar-strip";
import { ShellAccentReporter } from "@/components/desktop-shell/accent-reporter";
import { ShellBadgeReporter } from "@/components/desktop-shell/badge-reporter";
import { useShellServers } from "@/hooks/use-shell-servers";
import { readLastPinnedBoard } from "@/lib/last-pinned-board";
import { buildOpenActions, buildOpenLastUsedAction, buildOpenPrAction } from "@/lib/palette/open";
import { activePaneCwd, buildOpenTargets, readLastUsedOpenTarget, resolveLastUsedTarget } from "@/lib/open-in-app";
import { copyToClipboard } from "@/lib/clipboard";
import { parseFabChange } from "@/lib/format";
import { useOpenTargets } from "@/hooks/use-open-targets";
import { useRunOpenTarget } from "@/components/open-button";
import { nextWaitingTarget, type WaitingTarget } from "@/lib/palette/agent-nav";
import { isWaiting } from "@/lib/waiting";
import {
  windowSwitchDirection,
  viewTransitionSupported,
  shouldAnimateWindowSwitch,
  beginWindowSwitchGate,
  nextDirectionToken,
  isLatestDirectionToken,
  armGraceMask,
  tearDownMask,
  confirmSwitchArrived,
  forceSwitchArrived,
  hasCountedIncomingBytes,
  abandonSwitchFeedback,
  subscribeMaskState,
  getMaskState,
  isMaskExemptKey,
  isRedundantSwitch,
  isSamePendingTarget,
  postConfirmsSwitch,
  resolvePendingSwitchPost,
  resolvePendingSwitchVerdict,
  type SwitchPostOutcome,
  type PendingSwitchTarget,
} from "@/lib/window-transition";
import { ThemeProvider, useTheme, useThemeActions } from "@/contexts/theme-context";
import { InstanceAccentProvider, useInstanceAccent } from "@/contexts/instance-accent-context";
import { InstanceNameProvider, useInstanceName } from "@/contexts/instance-name-context";
import { SettingsDialogProvider } from "@/contexts/settings-dialog-context";
import { GuiOffRequestProvider, useGuiOffRequest, type GuiOffRequest } from "@/contexts/gui-off-context";
import { GuiOffDialog } from "@/components/gui-off-dialog";
import { GuiRestartRequestProvider, type GuiRestartRequest } from "@/contexts/gui-restart-context";
import { GuiRestartDialog } from "@/components/gui-restart-dialog";
import type { GuiSurfaceCommands } from "@/components/gui-surface";
import { windowIdToUrlSegment } from "@/lib/router-url";
import { ServerDialogsProvider, useServerDialogs } from "@/contexts/server-dialogs-context";
import { PaletteActionsProvider, usePaletteActions, usePaletteActionsApi, usePaletteGlobals, useRegisterPaletteActions } from "@/contexts/palette-actions-context";
import { ServerDialogs } from "@/components/server-dialogs";
import { useGlobalPaletteActions } from "@/hooks/use-global-palette-actions";
import { ScreenBreakController } from "@/components/screen-break";
import { registerGlass } from "@/lib/screen-break-store";
import { SessionProvider } from "@/contexts/session-context";
import { ToastProvider } from "@/components/toast";
import { OptimisticProvider } from "@/contexts/optimistic-context";
import { useDialogState } from "@/hooks/use-dialog-state";
import { useOccludes } from "@/hooks/use-occludes";
import { useRecentlyClosed, buildReopenWindowAction, pushRecentlyClosed, popRecentlyClosed } from "@/hooks/use-recently-closed";
import { useSessionsScope } from "@/hooks/use-sessions-scope";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSidebarSectionVisible } from "@/hooks/use-sidebar-sections";
import { useLocalStorageBoolean } from "@/hooks/use-local-storage-boolean";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { TopBar, type TopBarMode } from "@/components/top-bar";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { Shell } from "@/components/shell/shell";
import { Sidebar } from "@/components/sidebar";
import { HeadsetIcon } from "@/components/sidebar/icons";
import { PANE_PANEL_OPEN_STORAGE_KEY, PANE_PANEL_DEFAULT_OPEN } from "@/components/sidebar/status-panel";
import { canRequestWindowOperatorAction } from "@/components/sidebar/row-flyout-card";
import { SurfaceLayout } from "@/components/surface-layout";
import { PoppedOutPlaceholder, PopoutEnded, type PoppedLeafRow } from "@/components/popout-states";
import type { CodeTileCommands } from "@/components/surface-layout";
import { CronList } from "@/components/cron-list";
import { CronLog } from "@/components/cron-log";
import { CronStaleBanner } from "@/components/cron-stale-banner";
import { WatchedTasks } from "@/components/watched-tasks";
import { TerminalActivityTabs } from "@/components/terminal-activity-tabs";
import { BottomBar } from "@/components/bottom-bar";
import { StatusBar } from "@/components/status-bar";
import { ComposeStrip } from "@/components/compose-strip";
import { focusComposeStrip, openComposeRecall, runComposeToggleChord } from "@/lib/compose-strip-events";
import { tileChordHandler } from "@/lib/tile-chord";
import { cycleWindowTarget, sessionJumpTarget } from "@/lib/window-cycle";
import { registerWindowFocusRestorer } from "@/lib/sidebar-events";
import {
  armGuard,
  disarmGuard,
  focusMemoryKey,
  isGuardArmed,
  recallFocus,
  type FocusKind,
} from "@/lib/focus-memory";
import type { PaletteAction } from "@/components/command-palette";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { SessionTiles } from "@/components/session-tiles/session-tiles";
import { TmuxCommandsDialog } from "@/components/tmux-commands-dialog";
import { LogoSpinner } from "@/components/logo-spinner";
import type { ServerInfo, SelectWindowResult } from "@/api/client";
import type { ProjectSession, WindowInfo } from "@/types";

import { selectWindow, createSession, createWindow, splitWindow, closePane, killWindow, moveWindow, moveWindowToSession, reloadTmuxConfig, initTmuxConf, setWindowColor as setWindowColorApi, setWindowMarker as setWindowMarkerApi, setWindowRole, setWindowNote, setWindowOptions, borrowLayout, returnLayout, setSessionColor as setSessionColorApi, setSessionOrder, setServerOrder, setServerColor as setServerColorApi, setServerProtected, sendToWindow, sendOperatorRequest, sendServerOperatorRequest, refreshStatus, isInfraServer, spawnRiff, forkWindow, sortSessionWindows, addWebTab, selectWebTab, removeWebTab, moveWebTab, reopenClosedWindow, dismissClosedWindow, resumeClosedWindow, muteCron, pinCron, deleteCron, postSettings, restartGui, launchGuiApp, getSettingsEntries, fetchGuiStatus, resizeGui, fetchCodeBridge, restartCodeServer, DAEMON_SERVER, ApiError, HttpError, type SortWindowsBy, type CronEntry } from "@/api/client";
import { useCronData } from "@/hooks/use-cron";
import { buildCronActions, type CronActionHandlers } from "@/lib/palette/cron";
import { buildDataTableActions } from "@/lib/palette/data-table";
import { useMountedDataTables } from "@/components/data-table";
import { ServerWatchedZone } from "@/components/server-watched-zone";
import { CronCreateDialog } from "@/components/cron-create-dialog";
import { buildWebTabActions } from "@/lib/palette/web-tabs";
import { operatorRequestToast } from "@/lib/operator-request";
import { buildSessionSortActions } from "@/lib/palette/sort";
import { useBoards } from "@/hooks/use-boards";
import { useWindowPins } from "@/hooks/use-window-pins";
import { usePinActions } from "@/hooks/use-pin-actions";
import {
  deriveNameFromPath,
  finalizeSafeName,
  toSafeSessionName,
  toSafeWindowName,
} from "@/lib/names";
import { useSessionContext, useCodeServer, useCurrentServerFromRoute, useGui } from "@/contexts/session-context";
import { useOptimisticContext, useMergedSessions } from "@/contexts/optimistic-context";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useCodeWorkspace } from "@/hooks/use-code-workspace";
import { useToast } from "@/components/toast";
import { HELP_TOPIC_EVENT, isHelpTopic } from "@/lib/help-topics";
import { useBrowserTitle } from "@/hooks/use-browser-title";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { useShellNotifications } from "@/hooks/use-shell-notifications";
import { useWindowStore } from "@/store/window-store";

const CommandPalette = lazy(() => import("@/components/command-palette").then(m => ({ default: m.CommandPalette })));
const ThemeSelector = lazy(() => import("@/components/theme-selector").then(m => ({ default: m.ThemeSelector })));
const CreateSessionDialog = lazy(() => import("@/components/create-session-dialog").then(m => ({ default: m.CreateSessionDialog })));
const SessionNamePrompt = lazy(() => import("@/components/session-name-prompt").then(m => ({ default: m.SessionNamePrompt })));
const GuiGeometryPrompt = lazy(() => import("@/components/gui-geometry-prompt").then(m => ({ default: m.GuiGeometryPrompt })));
const GuiSendKeyPrompt = lazy(() => import("@/components/gui-send-key-prompt").then(m => ({ default: m.GuiSendKeyPrompt })));
const WindowNotePrompt = lazy(() => import("@/components/window-note-prompt").then(m => ({ default: m.WindowNotePrompt })));
const SpawnAgentDialog = lazy(() => import("@/components/spawn-agent-dialog").then(m => ({ default: m.SpawnAgentDialog })));
const OperatorComposeDialog = lazy(() => import("@/components/operator-compose-dialog").then(m => ({ default: m.OperatorComposeDialog })));
const SwatchPopover = lazy(() => import("@/components/swatch-popover").then(m => ({ default: m.SwatchPopover })));
const SettingsDialog = lazy(() => import("@/components/settings-dialog").then(m => ({ default: m.SettingsDialog })));
const QuakeTerminal = lazy(() => import("@/components/quake-terminal").then(m => ({ default: m.QuakeTerminal })));
const QuakeTerminalTongue = lazy(() => import("@/components/quake-terminal").then(m => ({ default: m.QuakeTerminalTongue })));

const { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH } = SIDEBAR_WIDTH_BOUNDS;

/** The keyboard-lock capability (Chrome desktop's "all keys to the guest"
 *  mode for the gui fullscreen verb). Absent everywhere else — the `in` guard
 *  is the feature detection; the cast bridges the DOM-lib gap. */
function keyboardLock(): { lock(): Promise<void>; unlock(): void } | undefined {
  return "keyboard" in navigator
    ? (navigator as unknown as { keyboard?: { lock(): Promise<void>; unlock(): void } }).keyboard
    : undefined;
}

/**
 * Derive a session name from an optional working directory path, falling back
 * to "session", and deduplicate against existing session names by appending
 * -2 through -10; beyond that appends -11 (best-effort).
 */
function deriveInstantSessionName(cwd: string | undefined, existingNames: string[]): string {
  const base = (cwd ? deriveNameFromPath(cwd) : "") || "session";
  const nameSet = new Set(existingNames);
  if (!nameSet.has(base)) return base;
  for (let i = 2; i <= 10; i++) {
    const candidate = `${base}-${i}`;
    if (!nameSet.has(candidate)) return candidate;
  }
  return `${base}-11`;
}

/**
 * Raw (unsanitized) basename of a filesystem path — the last non-empty path
 * segment. Used as the optimistic ghost-window label so it matches what tmux
 * will name an unnamed window (tmux's `#{b:pane_current_path}` uses the raw
 * basename, NOT the tmux-safe sanitization `deriveNameFromPath` applies).
 * Falls back to "window" when no basename is derivable.
 */
function rawBasename(cwd: string | undefined): string {
  if (!cwd) return "window";
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "") return "window";
  const segment = trimmed.split("/").pop() ?? "";
  return segment || "window";
}

/** Root wrapper — provides theme, chrome, session, focused-terminal, and
 *  optimistic contexts above ALL routes. Mounting `SessionProvider` here
 *  means the multi-server state socket is shared across `/$server/...`,
 *  `/board/$name`, and `/`; navigating between routes only flips
 *  `currentServer`, never tearing down the provider.
 *
 *  `FocusedTerminalProvider` lives at the same level so the BottomBar
 *  (rendered once per shell) can read the focused terminal regardless of
 *  which route is active. AppShell's TerminalClient and BoardPage's
 *  BoardPanes both register into this single provider instance. */
export function RootWrapper() {
  // `useVisualViewport` maintains the `--app-height` / `--app-offset-top` CSS
  // vars (iOS keyboard handling) on `document.documentElement`. It moved here
  // from `Shell` (260707-4vq2): the persistent root layout div (in `AppLayout`)
  // is now the `--app-height` consumer, and the var must exist on EVERY route —
  // including the host and edge pages that mount no `Shell`. The hook is a
  // single idempotent effect; owning it once at the root avoids the double-mount
  // cleanup race a second call in `Shell` would create (Shell now sizes to
  // `height: 100%` and no longer consumes the var directly).
  useVisualViewport();
  return (
    <ThemeProvider>
      <ToastProvider>
        <InstanceAccentProvider>
          <InstanceNameProvider>
          <ChromeProvider>
            {/* Zen mode (260820-o8cr): transient terminal-route chrome state,
                deliberately NOT part of ChromeContext (persisted chrome) —
                zen never writes localStorage or a URL param. */}
            <ZenProvider>
            <SessionProvider>
              <FocusedTerminalProvider>
                <OptimisticProvider>
                  <TopBarSlotProvider>
                    <FocusedPaneProvider>
                      <Outlet />
                    </FocusedPaneProvider>
                  </TopBarSlotProvider>
                </OptimisticProvider>
              </FocusedTerminalProvider>
            </SessionProvider>
            </ZenProvider>
          </ChromeProvider>
          </InstanceNameProvider>
        </InstanceAccentProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

/**
 * `AppLayout` — the persistent-chrome layout (260707-4vq2). It is the component
 * of a **pathless layout route** that uniformly parents EVERY page route
 * (index, server, terminal, board). Because every navigation keeps the match
 * chain `[root, app-layout, <leaf>]`, this layout match sits at a stable depth
 * with a stable route id and is NEVER remounted across navigation — so the
 * `TopBar` mounted here (once, above the `<Outlet>`) keeps a stable React/DOM
 * identity and re-renders in place instead of unmounting/remounting a per-page
 * copy (the flicker fix).
 *
 * (Hosting the bar directly in `RootWrapper` — the root route's component — did
 * NOT work: the index route `/` is a direct child of the root at the same
 * pathname, so the root→index match chain is structurally shorter than
 * root→serverLayout→…, and React remounted the root subtree when navigating to
 * `/`. A pathless layout route normalizes the tree depth and removes that
 * asymmetry.)
 *
 * The `<Suspense fallback={null}>` boundary wraps only the content region, so a
 * lazy-chunk load (e.g. the board) blanks the body while the bar stays painted.
 */
export function AppLayout() {
  return (
    // Settings dialog (o7q8): provided HERE — the true every-page layer — so
    // any descendant (AppShell palette, board palette, sidebar gear) can call
    // `openSettings()` while the dialog renders exactly once below. AppShell
    // is server-scoped and `/board/$name` doesn't render it, so a lower mount
    // would either miss boards or duplicate the dialog.
    //
    // Server dialogs + the palette-actions slot (260811-239r) join it at the
    // same layer: the create/kill server dialogs and the single CommandPalette
    // each mount exactly once below, and any route
    // (boards included) triggers them through `server-dialogs-context` /
    // registers route-scoped palette actions into `palette-actions-context`.
    // Order matters: the palette slot's global actions are built INSIDE
    // `SettingsDialogProvider` (`Settings: Open` consumes it), and
    // `ServerDialogs` reads `SessionContext` (RootWrapper, above all of this).
    <SettingsDialogProvider>
      <ServerDialogsProvider>
        <AppLayoutContent />
      </ServerDialogsProvider>
    </SettingsDialogProvider>
  );
}

/** AppLayout's body — split out so the layout-level global palette actions
 *  (which consume the settings-dialog context) can be built above the
 *  `PaletteActionsProvider` they feed. */
function AppLayoutContent() {
  useShellNotifications();

  // The GUI off-confirm (spec gui.md § The switch): ONE dialog mount at this
  // every-page layer — opened self-posting by the palette's `GUI: Turn off`
  // (`open`), or post-deferred by the settings seam's `gui.enabled` off
  // interception (`request`, which resolves the verdict so the seam's POST
  // and entry update stay one write). The resolver ref hands the verdict back.
  const [guiOffOpen, setGuiOffOpen] = useState(false);
  const guiOffResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const guiOffSelfPostsRef = useRef(true);
  const guiOff = useMemo<GuiOffRequest>(
    () => ({
      open: () => {
        guiOffSelfPostsRef.current = true;
        setGuiOffOpen(true);
      },
      request: () =>
        new Promise<boolean>((resolve) => {
          guiOffResolveRef.current = resolve;
          guiOffSelfPostsRef.current = false;
          setGuiOffOpen(true);
        }),
    }),
    [],
  );

  // The desktop restart confirm (spec gui.md § Switching desktops): the second
  // one-mount dialog at this layer, beside the off-confirm. Both desktop-pick
  // doors (the Settings `gui.wm` row, the palette's `GUI: Desktop…`) request
  // it through the context AFTER their settings write — `request` resolves the
  // verdict; the dialog's Restart button owns the restart POST itself.
  const [guiRestartOpen, setGuiRestartOpen] = useState(false);
  const guiRestartResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const guiRestart = useMemo<GuiRestartRequest>(
    () => ({
      request: () =>
        new Promise<boolean>((resolve) => {
          guiRestartResolveRef.current = resolve;
          setGuiRestartOpen(true);
        }),
    }),
    [],
  );

  // Instance accent (1etw): a 2px stripe across the top of the persistent top
  // bar plus a subtle wash behind it — the "which run-kit instance is this"
  // color channel (server colors own the sidebar). Both hexes are theme-derived
  // (contrast-guarded stripe, ~6.5% background blend wash); nothing renders
  // until an accent is resolved.
  const { stripeHex, washHex } = useInstanceAccent();

  // The shortcuts surface lives in the settings dialog's Shortcuts tab now
  // (260818-bncw): the `Help: Keyboard Shortcuts` global entry toggles it via
  // `useSettingsDialog()` (the `shortcuts-overlay` chord resolves that entry's
  // body through the merged palette list) — no layout-owned overlay state, no
  // `shortcuts-overlay:open` event seam.
  const globalActions = useGlobalPaletteActions();

  // ⌘N / ⇧⌘W app-window chords (260820-lfla) — dispatched at the LAYOUT, not
  // AppShell/BoardPage, because those route shells never mount on the host
  // overview or NotFound routes and the app-window pair must work everywhere
  // the SPA runs. Bridge-gated exactly like the palette bodies: an absent
  // invoker leaves the entry undefined and the chord falls through untouched.
  useKeybindingDispatch({
    "new-app-window": canNewShellWindow() ? () => void newShellWindow() : undefined,
    "close-app-window": canCloseShellWindow() ? () => void closeShellWindow() : undefined,
    // The quake terminal chord works from everywhere the SPA runs (Host,
    // Server, Terminal, Board) — same every-route reasoning as the app-window
    // pair. On desktop the machine steps rest→focused→open→rest; on mobile
    // the seam navigates to the operator window's terminal route. The
    // layout-mounted quake terminal owns the fork, this only dispatches.
    "quake-terminal": () => requestQuakeTerminal({ action: "toggle" }),
  });

  // Zen hide seam (260820-o8cr R2): the zen flag crosses the root-layout
  // boundary through ZenContext; the applies-flag is DERIVED per render from
  // the same deepest-first route-param walk `RootTopBar` uses, never stored —
  // so the hide flips in the same frame as the route change and never flashes
  // stale chrome on navigation. Zen is desktop-only (AppShell's chord/palette
  // gates own the isMobile term) and mobile shows no sidebar/statusbar chrome
  // anyway. The instance-accent stripe/wash KEEP rendering — they are chrome
  // identity, not the bar.
  const { zenActive } = useZenState();
  const matches = useMatches();
  let zenWindowParam: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { window?: string };
    if (typeof p.window === "string") {
      zenWindowParam = p.window;
      break;
    }
  }
  // The popout posture (AppShell publishes it through the slot context): the
  // `?pop=` terminal-route window renders chrome-less — no top bar, no quake
  // drawer/tongue, no command palette (spec surface-layout.md § Verbs → Pop
  // out; the popout's keyboard exit is closing the window).
  const popoutChromeless = useTopBarPopout();
  const hideTopBar = (zenActive && zenWindowParam !== undefined) || popoutChromeless;

  return (
    <GuiOffRequestProvider value={guiOff}>
    <GuiRestartRequestProvider value={guiRestart}>
    <PaletteActionsProvider globalActions={globalActions}>
    <div
      className="app-root flex flex-col"
      style={{ height: "var(--app-height, 100vh)" }}
      // The glass of the screen-break eggs — the layer (a sibling below) clips
      // and shakes this element, never a DOM-queried one.
      ref={registerGlass}
    >
      {/* Desktop-shell chrome (260731-ofws), shell-only by `isShell()` gating
          (false in every browser and in Playwright): the titlebar strip is the
          window's drag surface under the shell's hidden native titlebar, and
          the badge reporter mirrors the waiting-agent count to the OS dock/
          taskbar badge. The top bar below is untouched — the strip is a new
          sibling ABOVE it, not a merge. */}
      {isShell() && <ShellTitlebarStrip />}
      {isShell() && <ShellBadgeReporter />}
      {isShell() && <ShellAccentReporter />}
      {/* Plain `div`, not `header`: `TopBar` already renders its own `<header>`
          (the banner landmark), so wrapping it in a second `<header>` would
          nest two `role="banner"` landmarks. This wrapper owns the
          `shrink-0` sizing that keeps the bar at its natural height above the
          `flex-1` content region AND the top bar's surface paint: the
          `bg-bg-chrome` class is the base, and the inline `washHex` (when an
          instance accent is set) overrides it — the TopBar header has no
          background of its own, so one element carrying class + inline wash
          keeps the wash on top. While zen mode applies the BAR is not
          rendered (the wrapper collapses to zero height — the stripe/wash
          above are chrome identity and stay). */}
      <div className="shrink-0 bg-bg-chrome" style={washHex ? { backgroundColor: washHex } : undefined}>
        {stripeHex && (
          <div aria-hidden="true" style={{ height: "2px", backgroundColor: stripeHex }} />
        )}
        {!hideTopBar && <RootTopBar />}
      </div>
      <div className="relative flex-1 min-h-0">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
        {/* The ONE quake-terminal mount — a top-bar-anchored overlay living
            inside the main area (absolute, so pages below keep their layout);
            every entry point reaches it via the QUAKE_TERMINAL_EVENT seam.
            Unmounted in the chrome-less popout posture. */}
        {!popoutChromeless && (
          <Suspense fallback={null}>
            <QuakeTerminal />
          </Suspense>
        )}
        {/* The mobile standing affordance — the tongue hanging under the top
            bar on every route (desktop's standing affordance is the quake launcher).
            Self-gates on isMobile, hides on operator-less servers
            and on the operator window's own route; renders nothing on
            desktop. */}
        {!popoutChromeless && (
          <Suspense fallback={null}>
            <QuakeTerminalTongue />
          </Suspense>
        )}
      </div>
      {/* The ONE settings-dialog mount (o7q8) — never duplicated per page. */}
      <Suspense fallback={null}>
        <SettingsDialog />
      </Suspense>
    </div>
    {/* The ONE server create/kill dialog mount (260811-239r) — every route's
        sidebar/palette triggers funnel through `server-dialogs-context`. */}
    <ServerDialogs />
    {/* The ONE (lazy) command-palette mount (260811-239r) — renders the merged
        list: the active route's registered actions first, then the global
        groups built above. The per-route palette mounts are gone. Unmounted
        in the chrome-less popout posture. */}
    {!popoutChromeless && <LayoutCommandPalette />}
    {/* The ONE screen-break mount — a sibling of the `.app-root` glass, never
        inside it: a clipped/transformed ancestor would clip or re-anchor the
        layer's fixed fragments. Renders null while idle. */}
    <ScreenBreakController />
    {/* The ONE GUI off-confirm mount — the palette's `GUI: Turn off` and the
        settings seam's interception share it via the gui-off context. */}
    {guiOffOpen && (
      <GuiOffDialog
        postOnConfirm={guiOffSelfPostsRef.current}
        onClose={(confirmed) => {
          setGuiOffOpen(false);
          guiOffResolveRef.current?.(confirmed);
          guiOffResolveRef.current = null;
        }}
      />
    )}
    {/* The ONE desktop restart-confirm mount — both desktop-pick doors reach
        it through the gui-restart context after their settings write. */}
    {guiRestartOpen && (
      <GuiRestartDialog
        onClose={(confirmed) => {
          setGuiRestartOpen(false);
          guiRestartResolveRef.current?.(confirmed);
          guiRestartResolveRef.current = null;
        }}
      />
    )}
    </PaletteActionsProvider>
    </GuiRestartRequestProvider>
    </GuiOffRequestProvider>
  );
}

/** The layout palette mount — an inner component because the merged
 *  `allActions` list (`[...routeActions, ...globalActions]`) is computed by
 *  `PaletteActionsProvider` and read back via `usePaletteActions()`. */
function LayoutCommandPalette() {
  const allActions = usePaletteActions();
  // The Ask-operator fallback row's availability gate: resolve the quake terminal's
  // server context (route server, else sole/last-viewed/first listed) and
  // check its sessions payload for an operator window. Servers with no
  // attached sessions slice resolve operator-less — the row is omitted, not
  // disabled.
  const { servers, sessionsByServer } = useSessionContext();
  const routeServer = useCurrentServerFromRoute();
  // Most-recently-viewed server — the same ephemeral rule the quake terminal itself
  // applies (quake-terminal.tsx); passing null here would resolve the FIRST
  // listed server on Host/Board while the quake terminal opens on the last-viewed.
  const lastViewedRef = useRef<string | null>(null);
  if (routeServer) lastViewedRef.current = routeServer;
  const quakeServer = resolveQuakeServer(routeServer, servers.map((s) => s.name), lastViewedRef.current);
  const hasOperator =
    quakeServer !== null &&
    findOperatorWindow(sessionsByServer.get(quakeServer) ?? []) !== undefined;
  const askOperator = useMemo(
    () => ({
      hasOperator,
      onAsk: (query: string) =>
        requestQuakeTerminal({
          action: "open",
          server: quakeServer ?? undefined,
          send: query,
        }),
    }),
    [hasOperator, quakeServer],
  );
  return (
    <Suspense fallback={null}>
      <CommandPalette actions={allActions} askOperator={askOperator} />
    </Suspense>
  );
}

/**
 * `RootTopBar` — the single persistent `TopBar` mount (260707-4vq2). Delivers
 * the bar's inputs through two channels (see `top-bar-slot-context.tsx`):
 *   - Route-derived (here, synchronously from `useMatches()`): `mode` +
 *     `boardName`. This flips the instant the URL changes, so the heading
 *     never waits on the incoming page's mount — critical for the lazily
 *     loaded board (`Board: <name>` renders from the URL param while the
 *     chunk is still loading).
 *   - Page-registered (`useTopBarSlot()`): the data/handler props a page owns.
 *     When no page has registered yet (first frame after navigation, or a lazy
 *     chunk still loading), we render the tolerant-empty prop shape every mode
 *     already supports.
 */
function RootTopBar() {
  const matches = useMatches();
  // The not-found page signals its render via context (`useSignalTopBarNotFound`
  // in `NotFoundPage`). This MUST win over the route-param walk below: TanStack
  // Router's fuzzy not-found handling RETAINS the partially-matched params in
  // `useMatches()` — e.g. `/board/x/y` keeps `name=x`, so the param walk alone
  // would derive `board` mode ("Board: x") over the not-found body. When the
  // not-found page is what actually renders, force the minimal `host`
  // fallback (R3/R10). (The `/$server/$window`+extra shape — `/a/b/c` — is a
  // different arm: it renders AppShell's `ServerNotFound`, not `NotFoundPage`,
  // so `notFound` is false there and the `server`/`terminal` mode below is kept.)
  const notFound = useTopBarNotFound();

  // Walk matches deepest-first for route params. Param NAMES are unique across
  // the route tree (`window` only on the terminal route, `server` on the server
  // layout, `name` on the board route), so their presence fully determines the
  // mode — the same deepest-first param walk `SessionContext` uses for
  // `currentServer`. The host (`/`) carries no params and resolves to the
  // minimal `host` mode.
  let serverParam: string | undefined;
  let windowParam: string | undefined;
  let boardParam: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as {
      server?: string;
      window?: string;
      name?: string;
    };
    if (serverParam === undefined && typeof p.server === "string") serverParam = p.server;
    if (windowParam === undefined && typeof p.window === "string") windowParam = p.window;
    if (boardParam === undefined && typeof p.name === "string") boardParam = p.name;
  }

  let mode: TopBarMode;
  if (notFound) mode = "host";
  else if (boardParam !== undefined) mode = "board";
  else if (windowParam !== undefined) mode = "terminal";
  else if (serverParam !== undefined) mode = "server";
  else mode = "host";

  const slot = useTopBarSlot();

  return (
    <TopBar
      mode={mode}
      boardName={notFound ? undefined : boardParam}
      sessions={slot?.sessions ?? []}
      currentSession={slot?.currentSession ?? null}
      currentWindow={slot?.currentWindow ?? null}
      sessionName={slot?.sessionName ?? ""}
      windowName={slot?.windowName ?? ""}
      sidebarOpen={slot?.sidebarOpen ?? false}
      // Prefer the page-registered server (the confirmed value), but fall back
      // to the route-derived `serverParam` so the `tmux Server: <server>`
      // heading (server mode) and the terminal-mode server crumb render
      // synchronously from the URL — before AppShell's registering effect runs
      // on a cold deep link / first frame after navigation, `slot` is null and
      // `slot?.server` would be `""`, which those truthy-gated renders omit.
      // Mirrors how `boardName` already renders from `boardParam` above.
      server={slot?.server ?? serverParam ?? ""}
      onNavigate={slot?.onNavigate ?? (() => {})}
      onToggleSidebar={slot?.onToggleSidebar ?? (() => {})}
      onCreateWindow={slot?.onCreateWindow ?? (() => {})}
      onSpawnAgent={slot?.onSpawnAgent}
      paneCount={slot?.paneCount}
      serverCount={slot?.serverCount}
      waitingPaneCount={slot?.waitingPaneCount}
      boards={slot?.boards}
      focusedPane={slot?.focusedPane}
      onRequestKill={slot?.onRequestKill}
      autofit={slot?.autofit}
      onToggleAutofit={slot?.onToggleAutofit}
      surfaceToggles={slot?.surfaceToggles}
      guiToolbar={slot?.guiToolbar}
      layout={slot?.layout}
      onApplyLayout={slot?.onApplyLayout}
      layoutTemplatesDisabled={slot?.layoutTemplatesDisabled ?? false}
    />
  );
}

/** Server layout — renders `<AppShell>` for `/$server/...`. The provider stack
 *  lives in `RootWrapper` (above ALL routes); `ServerShell` is now a thin
 *  pass-through that exists for tanstack-router's component slot. */
export function ServerShell() {
  return <AppShell />;
}

/** Server not found UI — shown when server param doesn't match any known server. */
function ServerNotFound({ serverName }: { serverName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 bg-bg-primary">
      <h1 className="text-xl text-text-primary">Server not found</h1>
      <p className="text-text-secondary">
        No tmux server named <strong>{serverName}</strong> was found.
      </p>
      <a
        href="/"
        className="px-4 py-2 bg-bg-card border border-border rounded hover:border-text-secondary transition-colors text-text-primary"
      >
        Go to server list
      </a>
    </div>
  );
}

/** Brief waiting state shown right after creating a server, while the refreshed
 *  server list is in flight. Reuses ServerNotFound's centered full-screen
 *  layout idiom and the shared LogoSpinner. Swaps to the server view
 *  automatically once the server appears in the refreshed list (see the
 *  three-way guard and the pending-clear effect in SessionContext). */
function ServerWaiting({ serverName }: { serverName: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 bg-bg-primary">
      <LogoSpinner size={48} />
      <h1 className="text-xl text-text-primary">Creating server…</h1>
      <p className="text-text-secondary">
        Waiting for <strong>{serverName}</strong>.
      </p>
    </div>
  );
}

/** Pure three-way route-guard decision. Distinguishes:
 *   - "view": the server exists in the list — render the server view;
 *   - "waiting": the server is absent but is the one the user just created
 *     (=== pendingServer) — render ServerWaiting;
 *   - "not-found": the server is absent, is NOT the pending one, AND the list
 *     has loaded — render ServerNotFound immediately;
 *   - "view": otherwise (e.g. before the first fetch resolves) fall through to
 *     the server view / loading rather than flashing not-found.
 *  Gated on `serversLoaded`, NOT `servers.length > 0` (the latter was the bug:
 *  with pre-existing servers it fired not-found before the refresh landed). */
export function resolveServerView(
  server: string,
  servers: ServerInfo[],
  pendingServer: string | null,
  serversLoaded: boolean,
): "view" | "waiting" | "not-found" {
  if (servers.some((s) => s.name === server)) return "view";
  if (server === pendingServer) return "waiting";
  if (serversLoaded) return "not-found";
  return "view";
}

/** Build the current tab's independent label and marker picker entries. */
export function buildTabPickerActions(
  server: string,
  windowId: string,
): PaletteAction[] {
  return [
    {
      id: "window-label",
      label: "Tab: Label",
      onSelect: () => {
        document.dispatchEvent(
          new CustomEvent("label-popover:open", { detail: { server, windowId } }),
        );
      },
    },
    {
      id: "window-marker",
      label: "Tab: Marker",
      onSelect: () => {
        document.dispatchEvent(
          new CustomEvent("marker-pad:open", { detail: { server, windowId } }),
        );
      },
    },
  ];
}

type WindowSwitchActionTarget = {
  session: string;
  window: {
    windowId: string;
    name: string;
    role?: string;
  };
};

export function buildWindowSwitchActions({
  flatWindows,
  windowParam,
  onSelectWindow,
}: {
  flatWindows: WindowSwitchActionTarget[];
  windowParam: string | undefined;
  onSelectWindow?: (windowId: string) => void;
}): PaletteAction[] {
  return flatWindows.map((fw) => ({
    id: `window-switch-${fw.session}-${fw.window.windowId}`,
    label: `Tab: Switch to ${fw.session} › ${fw.window.name}${
      fw.window.windowId === windowParam ? " (current)" : ""
    }`,
    ...(fw.window.role === "operator"
      ? { icon: <HeadsetIcon />, description: "operator" }
      : {}),
    onSelect: () => onSelectWindow?.(fw.window.windowId),
  }));
}

/**
 * Read one localStorage key, tolerating unavailable storage (SSR/jsdom/quota)
 * — the try/catch-noop pattern the lib storage helpers use. The route-entry
 * translation effect reads the retired `rk-layout:` key through this directly
 * (the store's own helpers are deleted with the ladder; only the one-shot
 * translation still touches the key, and it deletes it).
 */
function readStorageValue(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Delete a localStorage key, tolerating unavailable storage. */
function removeStorageKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop — best-effort */
  }
}

/**
 * How long a pending window switch may stay unconfirmed before the failure
 * bounce-back fires (260715-38kg). If neither an explicit `selectWindow` POST
 * rejection nor an SSE confirmation arrives within this window, the pending
 * intent is cleared so the URL/heading bounce back to tmux's actual active
 * window (un-sticking the silent-failure limbo). A named tunable — a "few
 * seconds" per the design; trivially adjusted. This is a SINGLE per-switch
 * timer, not a polling loop (SSE remains the confirmation source).
 */
const CONFIRMATION_WINDOW_MS = 5000;

/**
 * How long the focus-restore rAF retry waits for `focusTerminalRef` to
 * register (the ref lands late in TerminalClient init, after the restore
 * effect has already run). Named tunable: 2s proved too tight under a loaded
 * box (e2e CI-class contention stalls TerminalClient init past it), so 5s.
 * Beyond it the terminal is presumed unfocusable this visit and the retry
 * stops; any user interaction abandons it earlier.
 */
const FOCUS_RESTORE_RETRY_MS = 5000;

/** Fallback sessions array for a server the snapshot map has no entry for
 *  (e.g. an absent server on a not-found route). Module-level so every render
 *  sees the SAME reference — a per-render `?? []` would re-key every memo and
 *  effect downstream (`useMergedSessions` → the top-bar slot →
 *  `useRegisterTopBarSlot`'s `setSlot` effect → provider state → re-render),
 *  closing a render loop on missing-server routes. */
const NO_SESSIONS: ProjectSession[] = [];

function AppShell() {
  const ctx = useSessionContext();
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const params = (lastMatch?.params ?? {}) as { server?: string; window?: string };
  // AppShell only mounts under `/$server/...`, so `currentServer` is non-null
  // here in practice. Fall back to URL params during the brief window between
  // navigation and the provider's next render with `currentServer` set.
  const server = ctx.currentServer ?? params.server ?? "";
  const rawSessions = ctx.sessionsByServer.get(server) ?? NO_SESSIONS;
  const isConnected = ctx.isConnectedByServer.get(server) ?? false;
  const servers = ctx.servers;
  const serversLoaded = ctx.serversLoaded;
  const pendingServer = ctx.pendingServer;
  const sessions = useMergedSessions(rawSessions, server);
  const { sidebarOpen, sidebarWidth, fixedWidth, composeStripEnabled, scrollLocked } = useChromeState();
  // The restore router's `restoreFocus` is a stable callback that reads refs
  // and module state only, so the compose preference reaches its first-visit
  // resolver through a ref rather than a dependency that would re-key the
  // per-window restore effect on every toggle.
  const composeStripEnabledRef = useRef(composeStripEnabled);
  composeStripEnabledRef.current = composeStripEnabled;
  const { setCurrentSession, setCurrentWindow, setSidebarOpen, setSidebarWidth, persistSidebarWidth, toggleFixedWidth, toggleComposeStrip } = useChromeDispatch();
  const navigate = useNavigate();
  const { addToast } = useToast();
  // The current server's recently-closed mirror — gates the
  // `Tab: Reopen closed` palette entry (and thereby the reopen chord).
  const { stack: recentlyClosedStack } = useRecentlyClosed(server);
  const isMobile = useIsMobile();
  const wsRef = useRef<WebSocket | null>(null);
  const focusTerminalRef = useRef<(() => void) | null>(null);

  // The URL's second segment is the tmux window ID (@N), a stable identifier.
  // The route no longer carries a session segment — the owning session is
  // derived from the SSE snapshot below (see `currentSession`).
  const windowParam = params.window;

  // Derive the owning session + window from the SSE snapshot by locating the
  // URL's window id (@N) within `sessions[].windows[]`. The snapshot carries
  // session names per window, so we no longer need a `$session` URL segment.
  // `@N` is globally unique on a server, so the first match is authoritative.
  const currentSession = useMemo(() => {
    if (!windowParam) return null;
    return sessions.find((s) => s.windows.some((w) => w.windowId === windowParam)) ?? null;
  }, [sessions, windowParam]);
  const currentWindow = useMemo(() => {
    if (!currentSession || !windowParam) return null;
    return currentSession.windows.find((w) => w.windowId === windowParam) ?? null;
  }, [currentSession, windowParam]);
  // The session name shown in breadcrumbs/title/dropdowns, derived from the
  // snapshot (not the URL). Undefined until the snapshot resolves the window.
  const sessionName = currentSession?.name;

  // Operator presence on this server — availability input (a) of the Fix tab
  // name palette entry / flyout row (the rest of the rule is subject-local:
  // agent session ref + not-the-operator's-own-window).
  const hasOperatorWindow = useMemo(
    () => sessions.some((s) => s.windows.some((w) => w.role === "operator")),
    [sessions],
  );

  // The window every capability/render consumer below sees. The code root
  // (`@rk_win_code_root`, the payload's `codeRoot`) is shared tab state — no
  // per-viewer substitution layer; availability (`hasCode`) reads it straight
  // from the record, so a window stays code-capable after its active pane
  // leaves the repo.
  const effectiveWindow = currentWindow;

  // Surface-layout state (spec surface-layout.md): the terminal route's center
  // is a LAYOUT of 1–N surface tiles (offers gated by the size floor). The tree itself is shared tab
  // state — the `@rk_win_layout` window option, read from the payload via
  // `effectiveLayout` (parse + degrade, never a rewrite); every verb POSTs the
  // new value and the SSE tick repaints. The retired `?layout=`/`?view=`/
  // `?panel=` params are inbound-only translation inputs (the route-entry
  // translation effect below); nothing writes them. The search params are
  // read with `strict:false` because AppShell also mounts on `/$server` (no
  // window) — a non-strict read returns `undefined` there rather than
  // throwing. The router module registration (`validateTerminalSearch` in
  // lib/router-url.ts) types `.view`/`.panel`/`.layout`, so no casts are
  // needed.
  const search = useSearch({ strict: false });
  // Popout posture (spec surface-layout.md § Verbs → Pop out): `?pop=` names
  // the leaf a popout window renders chrome-less. This first half is
  // grammar-only (parsePopLeaf); window existence resolves against the
  // payload below, after windowsById.
  const popLeaf = useMemo(
    () =>
      windowParam != null && search.pop !== undefined
        ? parsePopLeaf(search.pop, windowParam)
        : null,
    [windowParam, search.pop],
  );
  // The host-level code-server signal (260811-k3vp; portless since
  // 260811-a2bo) — `reachable` gates only the surface CONTENT (passed to
  // CodeSurface below); availability is gitRoot-derived (hasCode). `null` = no
  // signal yet (treated as not-running until the first event lands).
  const codeServer = useCodeServer();
  // The host-global gui signal (spec gui.md): `enabled` is the availability
  // input threaded into every view/layout derivation below (a null/absent
  // signal reads as unavailable — never on by default); `reachable` selects
  // the tile's CONTENT, never its presence.
  const gui = useGui();
  const currentViews = useMemo(
    () => availableViews(effectiveWindow, gui),
    [effectiveWindow, gui],
  );

  // The route server's window map (payload-derived): the read-time dead-leaf
  // prune's live set, the palette's Bring candidates and Send Back name
  // resolution, the borrow helper's held check, the workspace hook's
  // cross-window root resolution, and SurfaceLayout's foreign-leaf home
  // resolution all read from it. `@N` is unique per server.
  const windowsById = useMemo(() => {
    const map = new Map<string, WindowInfo>();
    for (const s of sessions) {
      for (const w of s.windows) map.set(w.windowId, w);
    }
    return map;
  }, [sessions]);
  // The owning session name per window — a foreign tile's TerminalClient
  // connects under its home session and registers focus with it.
  const sessionNameByWindowId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      for (const w of s.windows) map.set(w.windowId, s.name);
    }
    return map;
  }, [sessions]);
  const liveWindowIds = useMemo<ReadonlySet<string>>(
    () => new Set(windowsById.keys()),
    [windowsById],
  );

  // Popout posture, payload half: the popout renders while its surface's
  // window is LIVE (the leaf's home for a foreign leaf, else the route
  // window), optimistically until the first payload arrives, and — once seen
  // live — keeps its posture into the ended "Window closed" state when the
  // window dies (it never navigates, and it never follows the opener's
  // navigation). A grammar-valid `pop` whose window is KNOWN-absent once the
  // payload has arrived degrades to the ordinary terminal render (the
  // validateTerminalSearch drop-don't-error posture). "Arrived" is the first
  // REAL sessions snapshot, never the empty slice seeded on subscribe: reading
  // that seed as known-absent drops the posture for a render, which mounts the
  // shared layout's tty tile (kept by hide-never-unmount) whose hidden 80×24
  // isolated attach clamps the window for every viewer. Liveness reads the RAW
  // snapshot for the same reason: the merged `windowsById` takes its windows
  // from the window store, which the SSE-sync effect fills one render after
  // the snapshot lands, so it reads a live window as absent for that render.
  const payloadArrived = ctx.sessionsReceivedByServer.get(server) === true;
  const rawWindowIds = useMemo(
    () => new Set(rawSessions.flatMap((s) => s.windows.map((w) => w.windowId))),
    [rawSessions],
  );
  const popWindowLive = popLeaf !== null && rawWindowIds.has(popLeaf.windowId);
  const popKey = popLeaf !== null ? `${server}:${windowParam ?? ""}:${popLeaf.leafId}` : "";
  const [popWindowSeen, setPopWindowSeen] = useState(false);
  useEffect(() => {
    setPopWindowSeen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popKey]);
  useEffect(() => {
    if (popWindowLive) setPopWindowSeen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popKey, popWindowLive]);
  const popoutPosture =
    popLeaf !== null && (popWindowLive || popWindowSeen || !payloadArrived);
  // The ended state: the popout outlived its surface's window — the surface
  // unmounts, the window stays open, and nothing navigates.
  const popoutEnded = popLeaf !== null && popWindowSeen && !popWindowLive;
  // Publish the chrome-less mode to the root layout (top bar, quake drawer,
  // command palette drop out for the popout's lifetime).
  useRegisterTopBarPopout(popoutPosture);
  // The popout's presence on the rk-popout channel: `opened`/`alive`
  // announcements, the `pagehide` sign-off, and the pop-in/close handling.
  const popoutPresence = usePopoutPresence(
    server,
    windowParam ?? "",
    popLeaf?.leafId ?? "",
    popoutPosture,
  );

  // The operator page: the operator window's own terminal route wears the
  // quake surface on EVERY form factor — the segmented header and the
  // content swap mount whenever the resolved window's role is `operator`.
  // `tab` absent/"terminal" (or the gate false) renders the pre-existing
  // tree byte-identically; the role is known only once the sessions payload
  // resolves the window, so a cold `?tab=` deep link swaps in a beat after
  // mount. The legacy `tab=activity` token is normalized to `log` by
  // validateTerminalSearch before this read. Never in the popout posture —
  // the popout renders one tile chrome-less.
  const operatorPage =
    !popoutPosture && windowParam != null && currentWindow?.role === "operator";
  const quakeTab = operatorPage ? (search.tab ?? "terminal") : "terminal";
  const cronTabActive = quakeTab === "list" || quakeTab === "log";
  const tasksTabActive = quakeTab === "tasks";
  // Any non-terminal tab hides (never unmounts) the terminal column.
  const terminalHidden = cronTabActive || tasksTabActive;

  // The layout the window renders: the payload's `@rk_win_layout` value,
  // parsed and degraded (`effectiveLayout`), overlaid by the optimistic
  // `pendingLayout` while a verb's POST is in flight. `pendingLayout` is keyed
  // to the route so a window switch drops a pending write to the old window,
  // and cleared the moment the SSE record carries the written value (the
  // options handler wakes the hub, so confirmation lands in the same tick) or
  // when the POST rejects (see `applyLayout`). Writers always emit the TREE
  // form, but the payload may still carry a LEGACY preset string (an
  // agent's hand-written `set-option`), so the compare parses + serializes:
  // the pending write settles when the payload parses to the pending tree.
  const [pendingLayout, setPendingLayout] = useState<{
    key: string;
    value: string;
  } | null>(null);
  const baseLayout = useMemo(() => effectiveLayout(effectiveWindow, gui), [effectiveWindow, gui]);
  // True when the payload's layout parses to the pending tree (a legacy
  // string serializes to the same tree form). An unparseable payload never
  // settles the pending write.
  const pendingLayoutSettled =
    pendingLayout !== null &&
    (() => {
      const parsed = parseLayoutTree(effectiveWindow?.layout);
      return parsed !== null && serializeLayoutTree(parsed) === pendingLayout.value;
    })();
  const layout: Layout = useMemo(() => {
    const resolved =
      pendingLayout !== null &&
      !pendingLayoutSettled &&
      pendingLayout.key === `${server}:${windowParam ?? ""}`
        ? effectiveLayout({ ...effectiveWindow, layout: pendingLayout.value }, gui)
        : baseLayout;
    // Dead foreign leaves drop out at READ time; the pruned tree is persisted
    // only by the next layout write (no background writer), and the tty
    // fallback inside pruneDeadLeaves keeps a layout from rendering empty.
    return pruneDeadLeaves(resolved, liveWindowIds);
  }, [pendingLayout, pendingLayoutSettled, server, windowParam, effectiveWindow, baseLayout, gui, liveWindowIds]);
  useEffect(() => {
    if (pendingLayoutSettled) {
      setPendingLayout(null);
    }
  }, [pendingLayoutSettled]);

  // The viewer's popped set (spec surface-layout.md § Verbs → Pop out): the
  // opener hides popped leaves for THIS viewer only (viewer localStorage +
  // the rk-popout BroadcastChannel) and reflows over the rest; the shared
  // `@rk_win_layout` is never written by pop-out/pop-in. Disabled in the
  // popout window itself — it is not an opener (its sweep would otherwise
  // judge marks against its own presence announcements). The tree argument
  // is the FULL shared tree so marks whose leaf left the layout are pruned.
  const { popped, popOut, popIn, focusPopout } = usePoppedSet(
    server,
    windowParam ?? "",
    windowParam != null && !popoutPosture,
    leafIds(layout),
  );
  // The revealed set (spec surface-layout.md § Verbs → Pop out): the popped
  // leaf ids THIS viewer asked to see — their slots render the popped
  // placeholder instead of being hidden. Ephemeral React state keyed per
  // (server, @N) by the key stamp, never persisted (a reload returns to the
  // reflowed default). An id leaves the set when its popped mark clears
  // (pop-in, `closed`, the stale sweep, the tree prune — all flow through
  // `popped`): the read filters to `popped` so the set is always a subset of
  // it, and the prune effect drops the cleared ids from the stored state so a
  // later re-pop of the same leaf never resurrects a reveal.
  const revealedKey = `${server}:${windowParam ?? ""}`;
  const [revealedState, setRevealedState] = useState<{ key: string; ids: string[] }>({
    key: revealedKey,
    ids: [],
  });
  const revealed = useMemo(
    () =>
      revealedState.key === revealedKey
        ? revealedState.ids.filter((id) => popped.includes(id))
        : [],
    [revealedState, revealedKey, popped],
  );
  useEffect(() => {
    setRevealedState((prev) => {
      // A window switch resets the set outright (per (server, @N) state).
      if (prev.key !== revealedKey) {
        return { key: revealedKey, ids: [] };
      }
      return prev.ids.some((id) => !popped.includes(id))
        ? { key: prev.key, ids: prev.ids.filter((id) => popped.includes(id)) }
        : prev;
    });
  }, [revealedKey, popped]);
  // The popped placeholder's ✕: removes the leaf from the revealed set only —
  // never a layout close.
  const hideRevealedPopped = useCallback((leafId: string) => {
    setRevealedState((prev) => ({
      key: prev.key,
      ids: prev.ids.filter((id) => id !== leafId),
    }));
  }, []);
  // The tree SurfaceLayout RENDERS: the popout's single leaf in the popout
  // posture (keyed to the URL, never the shared layout — the popout keeps
  // rendering its surface while the surface's window lives, even if the leaf
  // leaves `@rk_win_layout`); the reduced tree in the opener posture (popped
  // minus revealed — a revealed leaf stays in the tree and renders the popped
  // placeholder in its slot); the
  // full tree otherwise (and under the all-popped placeholder, where every
  // tile renders hidden through the `popped` prop so their streams survive).
  // Every shared-layout MUTATION below still computes from the full `layout`.
  const popTree = useMemo<Layout | null>(
    () =>
      popLeaf !== null
        ? { leaf: popLeaf.kind, ...(popLeaf.home !== undefined ? { home: popLeaf.home } : {}) }
        : null,
    [popLeaf],
  );
  const reducedLayout = useMemo<{ tree: Layout | null; present: string[] }>(() => {
    if (popped.length === 0) return { tree: layout, present: [] };
    const hidden =
      revealed.length > 0 ? popped.filter((id) => !revealed.includes(id)) : popped;
    return hidden.length > 0 ? reducePopped(layout, hidden) : { tree: layout, present: [] };
  }, [layout, popped, revealed]);
  const allPopped = popped.length > 0 && reducedLayout.tree === null;
  const renderLayout: Layout =
    popoutPosture && popTree !== null
      ? popTree
      : allPopped
        ? layout
        : (reducedLayout.tree ?? layout);
  // The layoutRects seam into the mounted SurfaceLayout (the
  // `codeCommandsRef` pattern): the desktop add/directional-swap verbs read
  // the leaves' REAL rects through it; mobile and CLI callers use the
  // nominal box (an absent getter ⇒ undefined ⇒ nominal).
  const layoutRectsRef = useRef<(() => Map<string, Rect>) | null>(null);
  // The lens model's consumers (the palette `View:` actions) key off slot A —
  // the template's main tile (`slotOrder`), the first leaf in reading order
  // for a custom tree: a multi-tile layout reflects slot A's surface;
  // selecting a view collapses to the bare `<view>` leaf (see `switchView`).
  const resolvedView: ViewName = slotOrder(layout)[0];

  // An external `@rk_win_layout` write (an agent's `set-option -w`, a snapshot
  // restore) repaints on the next option tick — the layout write IS the expand
  // mechanism; there is no client-side transient override.

  // One-shot legacy translation (one release; spec ui-state.md § Migration):
  // per (server, window) arrival — gated on the window record so a
  // pre-snapshot frame never acts — translate the retired `?layout=`/`?view=`/
  // `?panel=` params and their localStorage predecessors into `@rk_win_layout`
  // when the option is still empty (a set option always wins), drop the params
  // from the URL, and delete exactly the four retired keys for THIS window (no
  // prefix sweep — other tabs translate on their own arrival). The retired
  // code-folder latch migrates alongside into `@rk_win_code_root`. The per-key
  // ref makes the effect genuinely one-shot: the payload still reads empty
  // while the POST is in flight, and a replayed effect must not POST again.
  const translationDoneRef = useRef(new Set<string>());
  useEffect(() => {
    if (!windowParam || !effectiveWindow) return;
    const key = `${server}:${windowParam}`;
    if (translationDoneRef.current.has(key)) return;
    const carried = search.layout ?? translateLegacyParams(search.view, search.panel);
    // Nothing to translate and no params to drop: the bare-route steady state.
    // Skipping WITHOUT marking the key done keeps a later arrival that DOES
    // carry params (a deep link visited after a plain one) translatable, and
    // stops the replace → effect re-fire → replace loop on the bare route
    // (every navigate gives `search.view`/… fresh identities, so the effect
    // re-fires after its own cleanup navigation).
    if (
      carried === undefined &&
      readStorageValue(`rk-layout:${server}:${windowParam}`) === undefined &&
      readStoredView(server, windowParam) === undefined &&
      readStoredPanel(server, windowParam) === undefined &&
      readStorageValue(`runkit-code-folder:${server}:${windowParam}`) === undefined
    ) {
      return;
    }
    translationDoneRef.current.add(key);
    const decision = legacyTranslationDecision({
      carried,
      storedLayout: readStorageValue(`rk-layout:${server}:${windowParam}`),
      storedLegacy: translateLegacyParams(
        readStoredView(server, windowParam),
        readStoredPanel(server, windowParam),
      ),
      winLayout: effectiveWindow.layout,
    });
    if (decision.write) {
      // Render the translated arrangement immediately — a carried deep link
      // must not wait for the option tick — through the same optimistic
      // overlay a verb uses; a rejected write reverts to the payload's layout.
      const write = decision.write;
      setPendingLayout({ key, value: write });
      setWindowOptions(server, windowParam, { "@rk_win_layout": write }).catch(() => {
        setPendingLayout((p) => (p?.key === key && p.value === write ? null : p));
      });
    }
    if (decision.dropParams) {
      navigate({
        to: "/$server/$window",
        params: { server, window: windowParam },
        // `?pop=` is LIVE state (the chrome-less popout render), never a
        // retired-param translation input — it survives the bare-route
        // rewrite.
        search: search.pop !== undefined ? { pop: search.pop } : {},
        replace: true,
      });
    }
    removeStorageKey(`rk-layout:${server}:${windowParam}`);
    removeStorageKey(windowViewStorageKey(server, windowParam));
    removeStorageKey(panelStorageKey(server, windowParam));
    const codeFolderKey = `runkit-code-folder:${server}:${windowParam}`;
    const codeFolder = readStorageValue(codeFolderKey);
    removeStorageKey(codeFolderKey);
    if (!effectiveWindow.codeRoot && codeFolder && codeFolder.trim() !== "") {
      setWindowOptions(server, windowParam, { "@rk_win_code_root": codeFolder }).catch(() => {});
    }
  }, [server, windowParam, effectiveWindow, search.layout, search.view, search.panel, search.pop, navigate]);

  // Per-server last-window memory: record the viewed window against its server
  // on EVERY arrival path (sidebar click, palette, deep link, board hop, tmux
  // writeback), so a later server switch can reopen it. Write-only — no
  // navigation, and independent of the alignment guard (`hasAlignedToUrlRef`)
  // and click-suppression window (`pendingClickRef`). No write on bare
  // `/$server` — a stored value stays intact there.
  useEffect(() => {
    if (server && windowParam) writeLastWindow(server, windowParam);
  }, [server, windowParam]);

  // The code TILE's window: the bare `code` leaf resolves to the route
  // window; a foreign `@N/code` leaf's tile reads and writes its HOME
  // window's `@rk_win_code_root` and workspace — the seed effect, the
  // workspace hook, and the follow writes below all target it (R19). The
  // derivations read the RENDERED tree (`renderLayout`): a popped code leaf
  // is not rendered in the opener (its retained frame is evicted), so it
  // seeds/fetches nothing there, while the popout's one-leaf tree drives its
  // own seed + workspace derivation.
  const codeTileHome = useMemo(() => {
    const ids = leafIds(renderLayout);
    const i = leaves(renderLayout).indexOf("code");
    return i >= 0 ? (parseLeafAddress(ids[i])?.home ?? null) : null;
  }, [renderLayout]);
  const codeTileWindowId = codeTileHome ?? windowParam;
  const codeTileWindow: ViewWindow | null =
    codeTileHome === null ? effectiveWindow : (windowsById.get(codeTileHome) ?? null);

  // Code-root seed (spec right-panel.md § The code lens): the first time the
  // code tile actually renders for a window whose `@rk_win_code_root` is still
  // empty, the derived gitRoot is POSTed once — never on availability alone
  // (a code lens that is merely OFFERED seeds nothing), never over a set root
  // (that would clobber the editor's own navigation). The per-key ref
  // suppresses a second POST while the first is in flight — the payload still
  // reads empty until the option tick confirms.
  //
  // Rejections are recorded per (window, seed VALUE): a refusal is
  // deterministic (the backend validates the path — e.g. a root outside $HOME
  // is refused with 400), so the identical value never re-POSTs, while a
  // CHANGED seed (the pane moved) is a fresh attempt. The set doubles as the
  // degrade signal for the workspace hook below: a window whose seed was
  // refused can never gain a substrate codeRoot from it, so its tile mounts
  // the `?folder=` form instead of pending forever.
  const codeRootSeedInFlightRef = useRef(new Set<string>());
  const [codeSeedRejections, setCodeSeedRejections] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!codeTileWindowId || !codeTileWindow) return;
    const seed = codeRootSeed(codeTileWindow, renderLayout);
    if (seed === null) return;
    const key = `${server}:${codeTileWindowId}`;
    if (codeRootSeedInFlightRef.current.has(key)) return;
    if (codeSeedRejections.has(`${key}:${seed}`)) return;
    codeRootSeedInFlightRef.current.add(key);
    setWindowOptions(server, codeTileWindowId, { "@rk_win_code_root": seed }).catch((err: unknown) => {
      // A deterministic refusal (the backend's 400 path validation) records a
      // rejection so the identical value never re-POSTs; anything transient
      // (network, 5xx) only releases the in-flight mark so a later tick can
      // retry the SAME value. Either way the mark clears — a success holds it
      // until the option tick confirms.
      codeRootSeedInFlightRef.current.delete(key);
      if (err instanceof ApiError && err.status === 400) {
        setCodeSeedRejections((prev) =>
          prev.has(`${key}:${seed}`) ? prev : new Set(prev).add(`${key}:${seed}`),
        );
      }
    });
  }, [server, codeTileWindowId, codeTileWindow, renderLayout, codeSeedRejections]);

  // The degrade signal for the workspace hook: the CURRENT seed value has
  // already been refused by the backend, so the substrate root will never
  // arrive for it. Flips back to false the moment the root changes (a fresh
  // attempt) or the payload carries a codeRoot (a retry landed).
  const pendingCodeRootSeed = codeRootSeed(codeTileWindow, renderLayout);
  const codeSeedRejected =
    codeTileWindowId != null &&
    pendingCodeRootSeed !== null &&
    codeSeedRejections.has(`${server}:${codeTileWindowId}:${pendingCodeRootSeed}`);

  // Workspace mount gating (spec right-panel.md § The code lens): the seed
  // effect above is the only WRITE here; this hook only READS — once the
  // substrate `@rk_win_code_root` is non-empty it derives the tab-keyed
  // workspace file and the code tile mounts at the `?workspace=` URL (pending
  // until then, `?folder=` degrade on a non-409 failure or a refused seed).
  // `followFolder` is the follow rule's re-derivation half for the handler
  // below. The hook's window is the code TILE's window (a foreign code tile's
  // home), so a borrowed editor derives and follows against its own tab.
  //
  // The resolved srcs live in a per-window MAP that survives window switches
  // (a revisit resolves synchronously — no pending flash — and a retained
  // frame's src outlives its window's active period). The map's cross-window
  // inputs: `windowsById` (the lookup's per-window root resolution) and
  // `liveWindowIds` (pruning dead windows' entries alongside their frames).
  const { codeSrc, codeSrcFor, followSrc, followFolder } = useCodeWorkspace(
    server,
    codeTileWindowId,
    codeTileWindow,
    leaves(renderLayout).includes("code"),
    codeSeedRejected,
    { windowsById, liveWindowIds },
  );

  // The first-boot rescue's status-read seam, as a PER-WINDOW factory: a
  // retained frame's baseline/verdict reads can fire after its window stopped
  // being active, so each frame's fetcher binds the FRAME's window. CodeSurface
  // owns the mount generation and the load-event seam, so the fetcher is
  // injected rather than the server/window pair. The factory is
  // useCallback-stable; the per-frame closures it returns are created per
  // render, which is inert — CodeSurface mirrors the prop into a ref read only
  // at verdict time, and the rescue effect keys on `[reachable, src]`.
  const fetchBridgeStatusFor = useCallback(
    (windowId: string) => () => fetchCodeBridge(server, windowId),
    [server],
  );

  // The root-divergence eviction's comparison input: a live window's CURRENT
  // code root (`""` when the window is gone or unresolvable — never an
  // eviction input).
  const codeRootForWindow = useCallback(
    (windowId: string) => codeRootFor(windowsById.get(windowId) ?? null),
    [windowsById],
  );

  // Follow write (spec right-panel.md § The code lens): after the seed, the
  // writers of `@rk_win_code_root` are the editor's OWN navigation
  // (CodeSurface's load-event seam) and the explicit Follow terminal verb —
  // the terminal never moves the code root on its own. The editor already
  // navigated itself to the bare `?folder=` URL, so after latching, the
  // workspace is re-derived and the frame is landed on the `?workspace=`
  // URL — a sanctioned parent re-navigation, nonce-gated in CodeSurface.
  const handleCodeFolderNavigated = useCallback(
    (folder: string): Promise<void> => {
      if (!codeTileWindowId || !codeTileWindow || folder === codeRootFor(codeTileWindow)) {
        return Promise.resolve();
      }
      return setWindowOptions(server, codeTileWindowId, { "@rk_win_code_root": folder })
        .then(() => followFolder(folder))
        .catch((err: Error) => {
          addToast(err.message || "Failed to set code folder", "error");
          // SurfaceLayout clears its pending follow target on this rejection —
          // a swallowed failure would leave the stale target to be inherited
          // by a later same-folder update.
          throw err;
        });
    },
    [server, codeTileWindowId, codeTileWindow, addToast, followFolder],
  );

  // The Follow terminal verb's write half: the SAME latch POST + follow as
  // the editor-initiated path, but with the degrade posture — the verb's
  // frame still sits on the OLD folder, so a failed workspace re-derivation
  // lands it on `?folder=<folder>` (one console warning in the hook) instead
  // of leaving the option moved and the editor visibly unchanged. Drift
  // (the verb's render gate) means the folder always differs from the
  // current root, so the no-op guard never fires here — kept for symmetry
  // with the editor-initiated contract.
  const handleCodeFollowTerminal = useCallback(
    (folder: string): Promise<void> => {
      if (!codeTileWindowId || !codeTileWindow || folder === codeRootFor(codeTileWindow)) {
        return Promise.resolve();
      }
      return setWindowOptions(server, codeTileWindowId, { "@rk_win_code_root": folder })
        .then(() => followFolder(folder, { degradeToFolder: true }))
        .catch((err: Error) => {
          addToast(err.message || "Failed to set code folder", "error");
          throw err;
        });
    },
    [server, codeTileWindowId, codeTileWindow, addToast, followFolder],
  );

  // The ONE layout mutation path (write discipline — user-initiated mutations
  // only): POST the serialized TREE form to `@rk_win_layout` through the
  // unified /options seam; the SSE tick repaints. `pendingLayout` renders the
  // new arrangement optimistically until the payload confirms; a rejection
  // reverts to the payload's layout with the same toast other option writes
  // use. Tile verbs, surface toggles, and the palette `View:`/`Tile:` actions
  // all funnel through this. Stable across SSE ticks.
  const applyLayout = useCallback(
    (next: Layout) => {
      if (!windowParam) return;
      const key = `${server}:${windowParam}`;
      const value = serializeLayoutTree(next);
      setPendingLayout({ key, value });
      setWindowOptions(server, windowParam, { "@rk_win_layout": value }).catch(
        (err: Error) => {
          // Revert the optimistic overlay — a newer pending write (if any)
          // stands.
          setPendingLayout((p) => (p?.key === key && p.value === value ? null : p));
          addToast(err.message || "Failed to apply layout", "error");
        },
      );
    },
    [server, windowParam, addToast],
  );

  // Bring a foreign surface into this layout (palette `Tile: Bring … here`,
  // and later the sidebar row-drag drop): when the address is unheld — or
  // already held by THIS window — the write is a plain applyLayout; when a
  // third window holds it, the borrow endpoint unholds it there and writes
  // this window's tree in one chained server-side write, so no viewer ever
  // observes the surface in two tabs. The borrow path mirrors applyLayout's
  // optimistic overlay and its rejection posture (revert + toast).
  const borrowInto = useCallback(
    (leafAddr: string, tree: Layout) => {
      if (!windowParam) return;
      const parsed = parseLeafAddress(leafAddr);
      if (!parsed) return;
      const holder = windowsById.get(parsed.home)?.awayIn?.[parsed.kind];
      if (holder === undefined || holder === windowParam) {
        applyLayout(tree);
        return;
      }
      const key = `${server}:${windowParam}`;
      const value = serializeLayoutTree(tree);
      setPendingLayout({ key, value });
      borrowLayout(server, { to: windowParam, leaf: leafAddr, tree: value }).catch(
        (err: Error) => {
          setPendingLayout((p) => (p?.key === key && p.value === value ? null : p));
          addToast(err.message || "Failed to apply layout", "error");
        },
      );
    },
    [server, windowParam, windowsById, applyLayout, addToast],
  );

  // Send a held surface back to its home window (palette `Tile: Send Back`,
  // the tile header's ↩, the placeholder's bring back): the return endpoint
  // recomputes both trees from current tmux state, so the client sends no
  // tree; the SSE tick repaints both tabs.
  const sendHome = useCallback(
    (from: string, leafAddr: string) => {
      returnLayout(server, { from, leaf: leafAddr }).catch((err: Error) => {
        addToast(err.message || "Failed to send tile home", "error");
      });
    },
    [server, addToast],
  );

  // Switch the current window's lens (window-view spec R2/R7) — R12's shim:
  // selecting a view sets the layout to the bare `<view>` leaf through the
  // shared mutation path (an `@rk_win_layout` write — the choice is shared
  // tab state). Never mutates `@rk_win_lens` (the retired write-compat key).
  const switchView = useCallback(
    (view: ViewName) => applyLayout({ leaf: view }),
    [applyLayout],
  );

  // The surfaces the current window can tile (shortcut order, tty/code/web —
  // R8's shared registry), consumed by the top-bar surface-toggle group and
  // the palette gating.
  const panelSurfaces = useMemo(
    () => availableSurfaces(effectiveWindow, gui),
    [effectiveWindow, gui],
  );

  // The palette's `Tile: Bring … here` candidates: every OTHER window on the
  // route server with its lendable surfaces (per-window availability minus
  // gui, which is never lendable — one desktop per host). Already-in-layout
  // and size-floor gating happen in the builder (addSurface's refusal).
  const bringWindows = useMemo<BringWindow[]>(() => {
    if (!windowParam) return [];
    const out: BringWindow[] = [];
    for (const w of windowsById.values()) {
      if (w.windowId === windowParam) continue;
      out.push({
        id: w.windowId,
        name: w.name,
        surfaces: availableTiles(w, gui).filter((kind) => kind !== "gui"),
      });
    }
    return out;
  }, [windowsById, windowParam, gui]);

  // ── gui tile state ───────────────────────────────────────────────────────
  // The tile's RFB connection report (the R11 seam) — the top-bar toggle dot
  // for gui. Reset per window/route so a stale "connected" never leaks
  // across a switch.
  const [guiConnected, setGuiConnected] = useState(false);
  useEffect(() => setGuiConnected(false), [server, windowParam]);
  const coarsePointer = useCoarsePointer();
  // Per-viewer render postures (lib/gui-posture.ts — validated localStorage
  // reads, try/catch-noop writes): the zoom, the pointer mode (defaulting to
  // the pointer class), the viewer-local resize lock, the RFB quality preset,
  // and the stats overlay's visibility. The ONLY new state the gui surface
  // adds anywhere.
  const [guiZoom, setGuiZoom] = useState<GuiZoom>(() => readGuiZoom());
  const [guiPointerMode, setGuiPointerMode] = useState<GuiPointerMode>(() =>
    readGuiPointerMode(coarsePointer),
  );
  const [guiResizeLocked, setGuiResizeLocked] = useState(() => readGuiResizeLocked());
  const [guiQuality, setGuiQuality] = useState<GuiQuality>(() => readGuiQuality(coarsePointer));
  const [guiStatsVisible, setGuiStatsVisible] = useState(() => readGuiStatsVisible());
  const handleGuiZoomChange = useCallback((z: GuiZoom) => {
    setGuiZoom(z);
    writeGuiZoom(z);
  }, []);
  const handleGuiPointerModeChange = useCallback((m: GuiPointerMode) => {
    setGuiPointerMode(m);
    writeGuiPointerMode(m);
  }, []);
  const handleGuiQualityChange = useCallback((q: GuiQuality) => {
    setGuiQuality(q);
    writeGuiQuality(q);
  }, []);
  const handleGuiStatsVisibleChange = useCallback((v: boolean) => {
    setGuiStatsVisible(v);
    writeGuiStatsVisible(v);
  }, []);
  // HiDPI (`rk-gui-hidpi`) and key-bar visibility (`rk-gui-keybar`) postures —
  // the same seed-from-storage + write-through grammar as the zoom posture.
  const [guiHidpi, setGuiHidpi] = useState(() => readGuiHidpi());
  const [guiKeyBarVisible, setGuiKeyBarVisible] = useState(() => readGuiKeyBarVisible());
  const handleGuiHidpiChange = useCallback((on: boolean) => {
    setGuiHidpi(on);
    writeGuiHidpi(on);
  }, []);
  const handleGuiKeyBarVisibleChange = useCallback((visible: boolean) => {
    setGuiKeyBarVisible(visible);
    writeGuiKeyBarVisible(visible);
  }, []);
  // The header fold's ⚙ panel open state (`rk-gui-toolbar`) — the same
  // seed-from-storage + write-through grammar as the key-bar posture.
  const [guiToolbarVisible, setGuiToolbarVisible] = useState(() => readGuiToolbarVisible());
  const handleGuiToolbarVisibleChange = useCallback((visible: boolean) => {
    setGuiToolbarVisible(visible);
    writeGuiToolbarVisible(visible);
  }, []);
  // The keyboard-capture latch (`rk-gui-capture`) — the same seed-from-storage
  // + write-through grammar. While latched the gui chord gate hands every
  // chord but the release binding to the guest desktop.
  const [guiCapture, setGuiCapture] = useState(() => readGuiCapture());
  const handleGuiCaptureChange = useCallback((on: boolean) => {
    setGuiCapture(on);
    writeGuiCapture(on);
  }, []);
  // The web tile's keyboard-capture latch (`rk-web-capture`) — the gui latch's
  // mirror, same grammar. While latched BOTH web engines hand every chord but
  // the release binding (⌘⇧G) to the page: the iframe engine via the narrowed
  // reclaim predicate below, the native engine via the narrowed chord table
  // (IframeWindow → buildWebChordTable).
  const [webCapture, setWebCapture] = useState(() => readWebCapture());
  const handleWebCaptureChange = useCallback((on: boolean) => {
    setWebCapture(on);
    writeWebCapture(on);
  }, []);
  // The Send key prompt's open state (the palette's `GUI: Send key…` row opens
  // it; the prompt owns parsing/validation).
  const [guiSendKeyOpen, setGuiSendKeyOpen] = useState(false);
  // The Custom… geometry prompt's open state (the palette's `GUI: Resolution →
  // Custom…` row opens it; the prompt owns validation).
  const [guiGeometryPromptOpen, setGuiGeometryPromptOpen] = useState(false);
  // The palette seams into the live RFB (GUI: Paste clipboard / GUI:
  // Reconnect / GUI: Send key…) — GuiSurface fills it while mounted.
  const guiCommandsRef = useRef<GuiSurfaceCommands | null>(null);
  // The palette seams into the code tile's header verbs (Code: Follow
  // Terminal / Code: Reload Editor) — SurfaceLayout fills it while the active
  // window's code tile is open.
  const codeCommandsRef = useRef<CodeTileCommands | null>(null);

  // Send key (spec gui.md § The tile): viewer-side through noVNC's sendKey —
  // no server round trip. The macOS view-only mirror refuses with the
  // backend's shared `gui <verb> is not supported…` wording (the relay would
  // silently drop the input otherwise); every other backend sends the parsed
  // chord. No live RFB ⇒ the seam no-ops (nothing throws).
  const submitGuiSendKey = useCallback(
    (chord: KeyChord) => {
      setGuiSendKeyOpen(false);
      if (gui?.backend === "screen-sharing") {
        addToast(GUI_SEND_KEY_MIRROR_REFUSAL, "error");
        return;
      }
      const sendKey = guiCommandsRef.current?.sendKey;
      if (sendKey) sendKeyChord(sendKey, chord);
    },
    [gui, addToast],
  );

  // ⏶ Zoom palette seam (T012/R11): the zoom itself is SurfaceLayout-internal
  // transient state (R6 — no URL/localStorage); the palette's `Layout: Expand`/
  // `Layout: Restore` entries need to OBSERVE it (label gating) and TRIGGER it
  // (the focused-slot toggle — 260819-qwr7 R7). The component registers its
  // toggle into this ref and reports flips through `onZoomChange`, so the
  // palette list rebuilds on every zoom change. Not lifted: SurfaceLayout's
  // per-window reset effect keeps the reset semantics where the state lives.
  const layoutZoomToggleRef = useRef<(() => void) | null>(null);
  const [layoutZoomed, setLayoutZoomed] = useState(false);

  // Zen mode (260820-o8cr R1/R4): the transient distraction-free override.
  // State lives in ZenContext (mounted at the root — the top bar's hide seam
  // crosses the root-layout boundary) and is NEVER persisted (no URL param,
  // no localStorage write anywhere on a zen path). The state survives window
  // switches within the terminal route (AppShell does not remount); leaving
  // the route — `windowParam` gone — deactivates it so board/host/server
  // routes render normal chrome. `zenApplies` is the per-render gate every
  // consumer uses (AppShell also mounts on `/$server`, where zen must never
  // apply even if the flag is still set).
  const { zenActive, zenZoomed } = useZenState();
  const { setZenActive, setZenZoomed } = useZenDispatch();
  useEffect(() => {
    if (!windowParam && zenActive) setZenActive(false);
  }, [windowParam, zenActive, setZenActive]);
  const zenOn = zenApplies(zenActive, windowParam, isMobile);

  // The register view has ONE desktop home at a time. The status bar's window
  // cluster exists because the desktop PANE panel is opt-in; while that panel
  // is actually on screen — its section toggled on, the panel EXPANDED (a
  // collapsed header shows no registers), AND the sidebar rendered (Shell
  // composes `sidebarOpen && !zenActive`, so zen hides the sidebar without
  // touching the preference) — the bar yields the cluster and keeps only its
  // host segments. All three booleans are existing persisted state — the
  // section and panel-open flags ride `useLocalStorageBoolean`'s pub/sub (the
  // latter is CollapsiblePanel's own key), `sidebarOpen` is ChromeContext
  // state — so the bar flips live with the rail toggle, `Panel: Toggle Pane`,
  // the panel's header chevron, and the sidebar chord — no new state.
  const [paneSectionVisible] = useSidebarSectionVisible("pane");
  const [panePanelOpen] = useLocalStorageBoolean(PANE_PANEL_OPEN_STORAGE_KEY, PANE_PANEL_DEFAULT_OPEN);
  const paneRegistersVisible = paneSectionVisible && panePanelOpen && sidebarOpen && !zenOn;

  // Enter/exit body — the `zen-toggle` chord, the palette's `View: Enter/Exit
  // Zen Mode` entries, and the status-bar exit button all resolve here (one
  // seam). The decision itself is the pure `resolveZenToggle` (lib/zen-mode):
  // ENTER at arity > 1 zooms the focused tile through the existing
  // `layoutZoomToggleRef` seam only when not already zoomed, recording whether
  // zen initiated it; EXIT unzooms ONLY a zen-initiated zoom still in effect —
  // a pre-existing user zoom survives, and a manual unzoom while in zen is not
  // toggled back into a zoom. Plain zoom verbs (⛶, `Layout: Expand`/`Restore`)
  // drive the seam directly and never touch zen state.
  const toggleZen = useCallback(() => {
    const decision = resolveZenToggle({ zenActive, zenZoomed, layoutZoomed }, leaves(layout).length);
    setZenActive(decision.zenActive);
    setZenZoomed(decision.zenZoomed);
    if (decision.fireZoomToggle) layoutZoomToggleRef.current?.();
  }, [zenActive, zenZoomed, layoutZoomed, layout, setZenActive, setZenZoomed]);

  // ── gui verbs (spec gui.md) ──────────────────────────────────────────────
  // Supervisor logs: the rk-gui session's `host` window on the rk-daemon
  // server, derived from the sessions payload the way the system card finds
  // rk-code-server. Absent (session not running, or the daemon server's slice
  // unattached) ⇒ the palette row renders disabled ("supervisor not
  // running").
  const rkGuiWindow = useMemo(() => {
    const session = (ctx.sessionsByServer.get(DAEMON_SERVER) ?? []).find(
      (s) => s.name === "rk-gui",
    );
    if (!session) return null;
    return (
      session.windows.find((w) => w.name === "host") ??
      session.windows.find((w) => w.isActiveWindow) ??
      session.windows[0] ??
      null
    );
  }, [ctx.sessionsByServer]);
  const openGuiLogs = useCallback(() => {
    if (!rkGuiWindow) return;
    navigate({
      to: "/$server/$window",
      params: { server: DAEMON_SERVER, window: windowIdToUrlSegment(rkGuiWindow.windowId) },
      search: {},
    });
  }, [rkGuiWindow, navigate]);

  // The gui fullscreen verb: element fullscreen on the tile + keyboard lock
  // (Chrome desktop's "all keys to the guest" mode); the second invocation
  // exits both. Where element fullscreen is absent (iPhone Safari) the verb
  // runs the zen toggle instead — the palette row's description says so.
  const guiFullscreen = useCallback(() => {
    // The fullscreen element is the gui TILE (not the canvas wrapper), so the
    // tile header — the session controls — travels into fullscreen and serves
    // it. `.closest` from the canvas/empty node keeps the duplicate-suffix
    // testid form matching.
    const surface =
      document.querySelector('[data-testid="gui-surface-canvas"]') ??
      document.querySelector('[data-testid="gui-surface-empty"]');
    const tile =
      surface instanceof HTMLElement
        ? surface.closest('[data-testid^="surface-tile-gui"]')
        : null;
    if (!(tile instanceof HTMLElement) || typeof tile.requestFullscreen !== "function") {
      toggleZen();
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    // Browsers grant keyboard lock only once fullscreen is established, so
    // the lock is chained from the fullscreen success. A refused
    // fullscreen/lock (permission, transient state) must never surface as an
    // unhandled rejection.
    void tile
      .requestFullscreen()
      .then(() => keyboardLock()?.lock())
      .catch(() => {});
  }, [toggleZen]);
  // A fullscreen exit the verb didn't initiate (Esc) still releases the
  // keyboard lock.
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) keyboardLock()?.unlock();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // The desktop-resize path shared by the palette's preset/Auto/Custom… rows
  // and Match this tile: POST /api/gui/host/resize. No toast on success (the
  // desktop visibly reflows); a non-2xx throws the server's message into an
  // error toast.
  const resizeGuiDesktop = useCallback(
    (geometry: string) => {
      void resizeGui(geometry).catch((err: unknown) => {
        addToast(err instanceof Error && err.message ? err.message : "Failed to resize the desktop", "error");
      });
    },
    [addToast],
  );
  // Match this tile: measure the noVNC host div inside the gui tile's canvas
  // wrapper (the `.flex-1` child; the bare-WM strip is the only other direct
  // div), falling back to the wrapper itself, and post the closest-aspect
  // preset.
  const matchGuiTile = useCallback(() => {
    const wrapper = document.querySelector('[data-testid="gui-surface-canvas"]');
    const host = wrapper?.querySelector(":scope > div.flex-1") ?? wrapper;
    if (!(host instanceof HTMLElement)) return;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    resizeGuiDesktop(closestAspectPreset(Math.round(rect.width), Math.round(rect.height)));
  }, [resizeGuiDesktop]);

  // The `GUI:` palette family (Constitution V — every GUI verb is
  // palette-reachable). Terminal-route gated; the per-state gating and labels
  // live in the pure `buildGuiActions` (lib/palette/gui.ts). The toggle
  // chord's hint rides the registry-inherited `Tile:` rows (the
  // `toggleHints` seam in buildLayoutActions).
  const guiOffRequest = useGuiOffRequest();
  // The palette door of the desktop picker (spec gui.md § Switching desktops):
  // the sub-list's lazy loader fetches the status document and the settings
  // entries ONCE per sub-step entry (never polled, never a stream field) and
  // maps them through the shared builder; a pick runs the same write →
  // enabled-check → confirm flow as the Settings row.
  const desktopPick = useDesktopPick();
  const loadDesktopRows = useCallback(async (): Promise<PaletteAction[]> => {
    const [status, entries] = await Promise.all([fetchGuiStatus(), getSettingsEntries()]);
    const wmEntry = entries.find((e) => e.key === "gui.wm");
    const currentWM = wmEntry && typeof wmEntry.value === "string" ? wmEntry.value : "";
    return buildDesktopPaletteRows(status, currentWM, (name) => {
      void desktopPick(name, (n) => postSettings({ "gui.wm": n })).catch((err: unknown) => {
        addToast(err instanceof Error && err.message ? err.message : "Failed to save", "error");
      });
    });
  }, [desktopPick, addToast]);
  const guiActions: GuiPaletteAction[] = useMemo(() => {
    if (!windowParam) return [];
    const actions = buildGuiActions({
      enabled: gui?.enabled === true,
      reachable: gui?.reachable === true,
      backend: gui?.backend ?? "",
      tileOpen: leaves(layout).includes("gui"),
      connected: guiConnected,
      coarsePointer,
      zoom: guiZoom,
      pointerMode: guiPointerMode,
      resizeLocked: guiResizeLocked,
      locked: gui?.locked ?? false,
      quality: guiQuality,
      statsVisible: guiStatsVisible,
      hidpi: guiHidpi,
      keyBarVisible: guiKeyBarVisible,
      toolbarVisible: guiToolbarVisible,
      capture: guiCapture,
      geometry: gui?.geometry ?? "",
      supervisorAvailable: rkGuiWindow !== null,
      onTurnOn: () => {
        void postSettings({ "gui.enabled": true }).catch((err: unknown) => {
          addToast(err instanceof Error && err.message ? err.message : "Failed to save", "error");
        });
      },
      onTurnOff: () => guiOffRequest?.open(),
      loadDesktopRows,
      // A ladder miss is a 200 with ok:false by design — toast the server's
      // hint verbatim through the success path; a success toasts nothing (the
      // app appears on the desktop).
      onLaunch: (app) => {
        void launchGuiApp(app)
          .then((r) => {
            if (!r.ok) addToast(r.hint, "error");
          })
          .catch((err: unknown) => {
            addToast(err instanceof Error && err.message ? err.message : `Failed to open ${app}`, "error");
          });
      },
      onResize: resizeGuiDesktop,
      onResizeCustom: () => setGuiGeometryPromptOpen(true),
      onMatchTile: matchGuiTile,
      onFullscreen: guiFullscreen,
      onPaste: () => {
        navigator.clipboard
          ?.readText()
          .then((text) => guiCommandsRef.current?.paste(text))
          .catch(() => {
            /* clipboard read needs a permission — skip silently */
          });
      },
      onZoom: handleGuiZoomChange,
      onPointerMode: handleGuiPointerModeChange,
      onQuality: handleGuiQualityChange,
      onStatsVisible: handleGuiStatsVisibleChange,
      onLockChange: (locked) => {
        setGuiResizeLocked(locked);
        writeGuiResizeLocked(locked);
      },
      onHidpiChange: handleGuiHidpiChange,
      onKeyBarVisibleChange: handleGuiKeyBarVisibleChange,
      onToolbarVisibleChange: handleGuiToolbarVisibleChange,
      onCaptureChange: handleGuiCaptureChange,
      onSendKey: () => setGuiSendKeyOpen(true),
      onOpenLogs: openGuiLogs,
      onReconnect: () => guiCommandsRef.current?.reconnect(),
    });
    if (typeof document.documentElement.requestFullscreen !== "function") {
      return actions.map((a) =>
        a.id === "gui-fullscreen"
          ? { ...a, description: "Fullscreen (falls back to zen on this device)" }
          : a,
      );
    }
    return actions;
  }, [
    windowParam,
    gui,
    layout,
    guiConnected,
    coarsePointer,
    guiZoom,
    handleGuiZoomChange,
    guiPointerMode,
    handleGuiPointerModeChange,
    guiResizeLocked,
    guiQuality,
    handleGuiQualityChange,
    guiStatsVisible,
    handleGuiStatsVisibleChange,
    guiHidpi,
    handleGuiHidpiChange,
    guiKeyBarVisible,
    handleGuiKeyBarVisibleChange,
    guiToolbarVisible,
    handleGuiToolbarVisibleChange,
    guiCapture,
    handleGuiCaptureChange,
    rkGuiWindow,
    guiOffRequest,
    loadDesktopRows,
    guiFullscreen,
    resizeGuiDesktop,
    matchGuiTile,
    openGuiLogs,
    addToast,
  ]);

  // Mobile active tile (spec surface-layout.md § Mobile): below
  // `isMobileViewport()` the center renders ONE tile; the top-bar switch group
  // swaps WHICH surface that is. The choice is the per-viewer zoom key
  // (`rk-layout-zoom:{server}:{@N}` — a leaf id, the same key desktop zoom
  // persists): a stored id whose KIND is still in the layout wins, else slot
  // A (the template's main tile — `slotOrder` — so a main-right phone shows
  // its main tile). The epoch re-reads the key after each `switchToTile`
  // write — localStorage writes don't re-render.
  const [mobileZoomEpoch, setMobileZoomEpoch] = useState(0);
  const mobileActiveTile: SurfaceName = useMemo(() => {
    void mobileZoomEpoch;
    const stored = windowParam ? readStoredZoom(server, windowParam) : undefined;
    const storedKind = stored ? zoomLeafKind(stored) : undefined;
    return storedKind && leaves(layout).includes(storedKind)
      ? storedKind
      : slotOrder(layout)[0];
  }, [server, windowParam, layout, mobileZoomEpoch]);

  // Switch-to-tile (mobile-primary): an ALREADY-OPEN surface writes only the
  // per-viewer zoom key — the shared layout is never touched, so a phone
  // reading `web` leaves a desktop viewer's arrangement alone. An
  // available-but-not-open surface grows the SHARED layout through
  // `addSurface` → `applyLayout` (the same add mutation every entry point
  // uses — a phone posture must not destroy shared tab state; no rects here,
  // so the split resolves against the nominal box) AND writes the zoom key so
  // the phone shows it. A `null` growth (no split fits the nominal-box size
  // floor) is a no-op — the
  // switch-group button and the `Tile: Switch to` palette row render disabled
  // instead (`switchTargetDisabled`).
  const switchToTile = useCallback(
    (surface: SurfaceName) => {
      if (!windowParam) return;
      if (!leaves(layout).includes(surface)) {
        const next = addSurface(layout, surface);
        if (!next) return;
        applyLayout(next);
      }
      writeStoredZoom(server, windowParam, surface);
      setMobileZoomEpoch((n) => n + 1);
    },
    [layout, applyLayout, server, windowParam],
  );

  // Help topics arrive on the cancelable `rk:help-topic` window event
  // (lib/help-topics): the chevron menu and the global palette that dispatch
  // it mount at the root with no layout access, so this shell — the owner of
  // the current window's layout — is the in-tile handler. Cancelling
  // SYNCHRONOUSLY suppresses the dispatcher's browser-tab fallback; the async
  // work then mirrors `rk present` (add the tab → ensure a web surface →
  // select the tab). The server dedupes an identical stored address, so a
  // re-open selects the existing tab instead of growing the family. A layout
  // that cannot grow (no split fits the size floor, no web tile) still keeps
  // the added tab for
  // later but opens a browser tab now rather than no-oping — decided and
  // opened BEFORE the first await: `window.open` rides the click's transient
  // user activation, which browsers revoke once the handler yields, so a
  // post-request open is what popup blockers return `null` for. Registered
  // only while a window is current: off the terminal route nobody cancels
  // and the dispatcher opens a browser tab itself.
  useEffect(() => {
    if (!windowParam) return;
    const handleHelpTopic = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isHelpTopic(event.detail)) return;
      const topic = event.detail;
      event.preventDefault();
      const hasWeb = leaves(layout).includes("web");
      const grown = hasWeb
        ? null
        : addSurface(
            layout,
            "web",
            isMobile ? undefined : (layoutRectsRef.current?.() ?? undefined),
          );
      const fullLayout = !hasWeb && grown === null;
      if (fullLayout) window.open(topic.url, "_blank", "noopener,noreferrer");
      void (async () => {
        const { index } = await addWebTab(server, windowParam, topic.url);
        if (fullLayout) return;
        // Mobile grows the shared layout through the same add mutation AND
        // writes the per-viewer zoom key so the phone shows the tile.
        if (isMobile) switchToTile("web");
        else if (grown) applyLayout(grown);
        await selectWebTab(server, windowParam, index);
      })().catch((err: Error) => addToast(err.message || "Failed to open help topic", "error"));
    };
    window.addEventListener(HELP_TOPIC_EVENT, handleHelpTopic);
    return () => window.removeEventListener(HELP_TOPIC_EVENT, handleHelpTopic);
  }, [server, windowParam, isMobile, layout, applyLayout, switchToTile, addToast]);

  // Switch-group/palette gating: a not-open surface whose growth is
  // disallowed (`addSurface` → null — no split fits the nominal-box floor)
  // renders disabled
  // instead of no-oping silently (the toggle group's full-layout disabled
  // affordance, extended to switch mode).
  const switchTargetDisabled = useCallback(
    (surface: SurfaceName) =>
      !leaves(layout).includes(surface) && addSurface(layout, surface) === null,
    [layout],
  );

  // Focused tile (260812-wfic R2/R8): SurfaceLayout owns the focused LEAF as
  // transient state (the zoom precedent — the per-window reset comes from its
  // `[server, windowId]` reset effect) and reports the focused KIND up via
  // `onFocusedKindChange` plus the leaf id via `onFocusedLeafChange`; the
  // shell mirrors both — the kind feeds the `ttyOnly` dispatcher gate and the
  // `Tile: Focus <Surface>` palette entries, the leaf id the palette's
  // directional `Tile: Swap …` rows. On mobile the single VISIBLE leaf counts
  // as focused (the switch-group selection), so the split chords fire only
  // when the shown tile is tty. `focusTileRef` is the palette's focus-by-kind
  // seam (the `zoomToggleRef` pattern). Until the component reports (first
  // render, window switch), slot A is the fallback — never a hardcoded tty
  // guess, so a persisted layout with a non-tty slot A can't briefly enable
  // the split chords. Each report is STAMPED with its window key and counts
  // only for that window: a window switch invalidates the mirror by key
  // mismatch (no clearing effect — a child effect's fresh report would land
  // BEFORE a parent's same-render clearing effect and be wiped).
  const focusWindowKey = `${server}:${windowParam ?? ""}`;
  const [reportedFocusedKind, setReportedFocusedKind] = useState<{
    key: string;
    kind: SurfaceKind;
  } | null>(null);
  const [reportedFocusedLeafId, setReportedFocusedLeafId] = useState<{
    key: string;
    leafId: string;
  } | null>(null);
  const focusedTileKind: SurfaceKind = isMobile
    ? mobileActiveTile
    : ((reportedFocusedKind?.key === focusWindowKey ? reportedFocusedKind.kind : null) ??
      slotOrder(layout)[0]);
  // The palette's directional swaps act on the FOCUSED leaf (desktop
  // multi-tile only — mobile renders one tile, nothing to swap with).
  const focusedLeafId =
    !isMobile && leaves(layout).length > 1
      ? reportedFocusedLeafId !== null &&
        reportedFocusedLeafId.key === focusWindowKey &&
        leafIds(layout).includes(reportedFocusedLeafId.leafId)
        ? reportedFocusedLeafId.leafId
        : leafIds(layout)[0]
      : undefined;
  const layoutFocusTileRef = useRef<((kind: SurfaceKind) => void) | null>(null);

  // Surface toggle (right-panel P1/P6, retargeted to tiles in 260812-ab5v):
  // an OPEN surface — one with a BARE leaf; a kind present only as foreign
  // leaves reads as closed — closes its first bare tile (closeSurface; the
  // neighbours absorb its share; a foreign leaf is never the close target), a
  // closed one appends a tile
  // (addSurface splits the FOCUSED tile — `focusedLeafId`, the last leaf in
  // reading order by default — along its longer axis, gated by the
  // per-viewport size floor, using the leaves' REAL rects from the
  // layoutRects seam on desktop and the nominal box on mobile, with the
  // viewer's stored divider sizes threaded so the floor check matches the
  // rendered sizes). A disallowed mutation (closing the last tile, an
  // add no split fits the floor for) is a null no-op; the boolean return
  // reports whether the mutation applied (focus-hop's open-then-focus flag
  // depends on it). Stable
  // across SSE ticks. Shared by the top-bar surface-toggle group, the tile
  // verbs, and the palette. Defined BELOW the focusedLeafId mirror — the
  // deps array needs it. The popped guard comes first: when the kind's
  // close target — its first bare leaf — is in this viewer's popped set, the
  // toggle NEVER writes the shared layout; it flips the leaf's membership in
  // the revealed set (reveal shows the popped placeholder, hide returns to
  // the reflowed render), reporting true on reveal / false on hide so
  // focus-hop's open-then-focus flag stays truthful.
  const togglePanel = useCallback(
    (surface: SurfaceName) => {
      const action = popoutToggleAction(layout, surface, popped, revealed);
      if (action !== null) {
        setRevealedState((prev) => {
          const ids = prev.key === revealedKey ? prev.ids : [];
          return {
            key: revealedKey,
            ids:
              action.kind === "reveal"
                ? [...ids, action.leafId]
                : ids.filter((id) => id !== action.leafId),
          };
        });
        return action.kind === "reveal";
      }
      const next = toggleSurface(
        layout,
        surface,
        isMobile ? undefined : (layoutRectsRef.current?.() ?? undefined),
        focusedLeafId,
        windowParam ? readStoredSizes(server, windowParam, layout) : undefined,
      );
      if (next) applyLayout(next);
      return next !== null;
    },
    [layout, popped, revealed, revealedKey, applyLayout, isMobile, focusedLeafId, server, windowParam],
  );

  // The focused tile's OWN window (a foreign leaf's home, the route window
  // for a bare leaf): the compose strip's focus-memory gate and the tty
  // tile's split/close verbs target it. Desktop multi-tile reads the reported
  // focused leaf; single-tile and mobile renders have exactly one candidate.
  const focusedTileWindowId = useMemo(() => {
    if (!windowParam) return undefined;
    const ids = leafIds(layout);
    const leafId =
      focusedLeafId ??
      (isMobile ? ids[leaves(layout).indexOf(mobileActiveTile)] : ids[0]);
    return (leafId ? parseLeafAddress(leafId)?.home : undefined) ?? windowParam;
  }, [windowParam, layout, focusedLeafId, isMobile, mobileActiveTile]);

  // Open-then-focus landing flag: when a chord (focus-hop, or a tile chord's
  // hidden arm) opened a CLOSED tile, this per-kind flag makes the effect
  // below focus it once the tile lands in the RENDERED tree (SurfaceLayout's
  // focusTileRef closure re-registers with the new tree — child effects run
  // before this parent one). The trigger reads the rendered tree, not the
  // shared layout: a popped leaf's reveal writes no layout — the tile lands
  // when the reveal re-adds it to the render.
  const focusOnLandingRef = useRef<SurfaceKind | null>(null);
  useEffect(() => {
    const kind = focusOnLandingRef.current;
    if (kind !== null && leaves(renderLayout).includes(kind)) {
      focusOnLandingRef.current = null;
      layoutFocusTileRef.current?.(kind);
    }
  }, [renderLayout]);

  // Focus restore + steal guard (spec right-panel.md § The code lens): a
  // window switch re-renders the server-keyed tile grid and nothing would
  // otherwise reclaim DOM focus — and when the code tile does boot a fresh
  // workbench (first visit, post-eviction re-show, reachability recovery)
  // its one-shot load-time grab would win by default. `restoreFocus` routes
  // to the window's RECORDED focus kind (`undefined` ⇒ the first-visit
  // resolver: compose while the strip is on, else tty): tty via
  // `focusTerminalRef` with a rAF retry (the ref registers late in
  // TerminalClient init), compose via the registered strip focuser with a tty
  // fallback when it declines (disabled/unmounted), code by focusing the
  // visible active-window frame's contentWindow with the same rAF retry (a
  // RETAINED frame fires no grab on the return, so the restore cannot ride
  // it). Reads only refs + module state, so a stable identity is safe.
  // Returns a cancel that abandons any pending retry. `exclude` (a chord hide
  // passes the just-closed kind) resolves memory pointing at the hidden tile
  // to the tty default — a tile that just left the layout is never a return
  // target, and a hidden code tile fails the arm's `:not(.hidden)` selector,
  // which would otherwise strand focus until the retry deadline.
  const restoreFocus = useCallback((key: string, exclude?: SurfaceKind): (() => void) => {
    let cancelled = false;
    let rafId = 0;
    const cancel = () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
    const deadline = Date.now() + FOCUS_RESTORE_RETRY_MS;
    const focusTty = () => {
      if (cancelled) return;
      const focus = focusTerminalRef.current;
      if (focus) {
        focus();
        return;
      }
      if (Date.now() < deadline) rafId = requestAnimationFrame(focusTty);
    };
    const recalled = recallFocus(key);
    const resolved = recalled ?? firstVisitKind();
    const kind = resolved === exclude ? "tty" : resolved;
    if (kind === "code") {
      // A RETAINED code frame fires no load-time grab on the return (the
      // frame LRU keeps it mounted), so the restore can no longer ride the
      // workbench's grab — focus the frame explicitly (the recorded
      // fallback). A fresh boot (post-eviction, reachability recovery) still
      // grabs on load and lands in the same place. Retry like the tty arm:
      // on a re-show after eviction the iframe element takes a beat to
      // mount. The active window's tile only — retained frames of OTHER
      // windows carry a distinct testid, and a hidden frame must never be
      // focused. The deadline CHAINS to the tty retry: with no visible code
      // frame (a closed tile, an unreachable host, a frame still mounting)
      // the retry would otherwise expire silently and strand keyboard focus,
      // disabling the `ttyOnly` chords.
      const focusCode = () => {
        if (cancelled) return;
        const frame = document.querySelector<HTMLIFrameElement>(
          '[data-testid="surface-tile-code"]:not(.hidden) iframe[title="Code editor"]',
        );
        if (frame) {
          frame.contentWindow?.focus();
          return;
        }
        rafId = requestAnimationFrame(Date.now() < deadline ? focusCode : focusTty);
      };
      rafId = requestAnimationFrame(focusCode);
      return cancel;
    }
    if (kind === "compose") {
      // A RECORDED compose (a return to a window the user composed in) finds
      // the body already mounted: one attempt, decline ⇒ tty.
      if (recalled === "compose") {
        if (focusComposeStrip()) return cancel;
        rafId = requestAnimationFrame(focusTty);
        return cancel;
      }
      // FIRST VISIT with the strip on: the expanded body mounts only after
      // the terminal registers into FocusedTerminalContext, so a one-shot
      // attempt at effect time would always decline. Retry on the same rAF
      // loop and deadline the tty arm uses; fall to tty on the deadline. Each
      // attempt re-checks the active element — an engaged focus (xterm, an
      // editable, a dialog, an open menu, an iframe) means the user or another
      // surface got there first (this effect can arm late, after a slow
      // session payload), and the restore ABANDONS outright: falling to the
      // tty arm would steal from that surface just the same.
      const tryCompose = () => {
        if (cancelled) return;
        if (focusIsEngaged(document.activeElement)) return;
        if (focusComposeStrip()) return;
        rafId = requestAnimationFrame(Date.now() < deadline ? tryCompose : focusTty);
      };
      rafId = requestAnimationFrame(tryCompose);
      return cancel;
    }
    rafId = requestAnimationFrame(focusTty);
    return cancel;
  }, []);

  // The first-visit default for a window with no recorded focus kind: the
  // compose strip when the preference is on (the strip is the keyboard; the
  // terminal is the control surface reached by Escape or a click), else tty.
  // Consulted ONLY when `recallFocus` is undefined — a recorded kind always
  // wins, which is what keeps remounts and returns from ever stealing.
  function firstVisitKind(): FocusKind {
    return composeStripEnabledRef.current ? "compose" : "tty";
  }

  // The restore effect, keyed per window and DESKTOP-ONLY — auto-focus pops
  // the mobile keyboard. It arms the
  // window's steal guard and installs capture-phase parent-document
  // listeners that DISARM on the first genuine interaction (and abandon a
  // pending retry — the user has already chosen a target). CodeSurface's
  // in-frame `focusin` listener (on the iframe's contentDocument — a script
  // grab fires no parent-side iframe event) consults the armed guard via the
  // `onProgrammaticFocus` callback below.
  useEffect(() => {
    if (!windowParam || isMobile) return;
    const key = focusMemoryKey(server, windowParam);
    armGuard(key);
    const cancelRestore = restoreFocus(key);
    const disarm = () => {
      disarmGuard(key);
      cancelRestore();
    };
    document.addEventListener("pointerdown", disarm, true);
    document.addEventListener("keydown", disarm, true);
    return () => {
      cancelRestore();
      document.removeEventListener("pointerdown", disarm, true);
      document.removeEventListener("keydown", disarm, true);
    };
  }, [server, windowParam, isMobile, restoreFocus]);

  // Sidebar focus-return seam (R5): the stateful ⌘B hide arm and the
  // sidebar's Escape return focus through THIS route's restore router, via
  // the module registry (`lib/sidebar-events.ts`) — no origin storage; the
  // router's `recallFocus(key) ?? firstVisitKind()` IS the return target. Routes without
  // a window (and the board/host mounts) register nothing; their return path
  // is a blur.
  useEffect(() => {
    if (!windowParam || isMobile) return;
    return registerWindowFocusRestorer(() => {
      restoreFocus(focusMemoryKey(server, windowParam));
    });
  }, [server, windowParam, isMobile, restoreFocus]);

  // Steal-guard revert, threaded SurfaceLayout → CodeSurface: fires when
  // focus lands inside the frame's document (a script `focus()` grab fires
  // no parent-side iframe event — the in-frame `focusin` is the only
  // signal). While the guard is armed and the remembered kind is not `code`,
  // the grab contradicts the user's recorded choice — restore it and report
  // the revert (`true`). A remembered `code` lets the grab through: it IS
  // the restore.
  const revertProgrammaticFocus = useCallback((): boolean => {
    if (!windowParam) return false;
    const key = focusMemoryKey(server, windowParam);
    if (!isGuardArmed(key)) return false;
    if ((recallFocus(key) ?? firstVisitKind()) === "code") return false;
    restoreFocus(key);
    return true;
  }, [server, windowParam, restoreFocus]);

  // The effective keybinding map (260730-g40a): drives the shifted-tier
  // dispatch mount (see the `useKeybindingDispatch` call further down, after
  // the palette actions it reuses), the shortcuts overlay, and the palette
  // `shortcut` hints.
  const keybindings = useKeybindings();
  const { byAction: bindingByAction, host: bindingHost } = keybindings;

  // Chord-reclaim predicate factory for same-origin lens iframes
  // (keyboard-capture spike, intake k3vp §5; tty-scoped carve-out
  // 260812-wfic R9; kind-aware generalization 260819-ie2i R3): a keydown
  // inside a lens iframe is reclaimed exactly when it matches an ENABLED
  // registry binding that is meaningful under that iframe's kind — so
  // run-kit's chords (palette, layout-cycle, code-toggle, …) survive iframe
  // focus while the embedded app's OWN Ctrl/⌘ chords pass through, the
  // tmux-pane split pair (`ttyOnly`) stays with code-server's keybinding
  // service in BOTH iframe kinds, and ⌘F (`webOnly` web-find) is reclaimed
  // only inside the WEB tile's frame (code-server keeps its own find).
  const reclaimChordForKind = useCallback(
    (kind: SurfaceKind) => (e: KeyboardEvent) =>
      // The capture latches narrow the GUI / web reclaim to that kind's
      // release binding alone; the code iframe path never sees a flag.
      hasReclaimableMatch(
        e,
        keybindings.bindings,
        kind,
        (kind === "gui" && guiCapture) || (kind === "web" && webCapture),
      ),
    [keybindings.bindings, guiCapture, webCapture],
  );

  // The docked compose strip is a single global surface (260718-dhdj) rendered
  // at one of two docks (260813-j3jb — inside the first tty tile on the desktop
  // terminal route, else the shell footer above `<BottomBar>`; the dock
  // predicate lives beside the mount sites below); its enablement is the
  // persisted `composeStripEnabled` chrome preference, toggled by the `>_` chip
  // and the `Compose: Toggle` palette action. No per-terminal compose-open
  // state. Scroll-lock is likewise a persisted chrome preference (read via
  // `scrollLocked` above) — BottomBar owns the toggle, this shell only threads
  // the value down to the terminal surfaces.
  // Server create/kill dialogs + the merged palette list (260811-239r): both
  // dialogs mount ONCE in AppLayout (`ServerDialogs`); this route shell only
  // consumes the triggers (sidebar/palette call sites) and the open-state (the
  // dialogOpenRef gating predicate below). For id-resolution seams the route
  // subscribes to the GLOBALS-ONLY channel (`usePaletteGlobals`) and resolves
  // against `[...paletteActions, ...paletteGlobals]` — both sides fresh THIS
  // render, no slot lag — while macro invocation uses the imperative
  // `getAllActions` at call time. Routes never subscribe to the merged route
  // state they publish into (render-loop guard; see palette-actions-context).
  const {
    openCreateServer,
    requestKillServer,
    requestAdoptServer,
    createServerOpen,
    killServerTarget,
    adoptServerTarget,
  } = useServerDialogs();
  const { getAllActions } = usePaletteActionsApi();
  const paletteGlobals = usePaletteGlobals();
  const [showTmuxCommands, setShowTmuxCommands] = useState(false);
  const [showCreateWindowAtFolderDialog, setShowCreateWindowAtFolderDialog] = useState(false);
  // Save-as-style name prompt behind `Session: Create` (chord + palette). The
  // prefill is captured at OPEN time so it can't churn under the user's edit.
  const [sessionNamePrompt, setSessionNamePrompt] = useState<{ defaultName: string } | null>(null);
  const [showColorPicker, setShowColorPicker] = useState<"session" | "window" | "server" | null>(null);
  // The color picker's mount below is a bespoke modal shell (full backdrop),
  // so it registers here; the inline SwatchPopover mounts elsewhere do not.
  useOccludes("modal", showColorPicker !== null);
  const [showCreateIframeDialog, setShowCreateIframeDialog] = useState(false);
  // The spawn-agent dialog's target is explicit `{server, session}` state (not a
  // boolean): the sidebar bot button can target ANY listed session on ANY server
  // (cross-server spawn), while the palette/window-switcher pass the CURRENT
  // `{server, sessionName}`. `null` = closed.
  const [spawnAgentTarget, setSpawnAgentTarget] = useState<{ server: string; session: string } | null>(null);
  // The operator compose dialog's pre-selected mode (`null` = closed). Both
  // palette verbs and the pinned operator row's compose icon mount the one
  // dialog; the mode is only the entry point's pre-selection.
  const [operatorComposeMode, setOperatorComposeMode] = useState<"spawn" | "find" | null>(null);
  // The note prompt's target (260824-bb5n) — a FROZEN snapshot captured when
  // the palette action fires (the prompt's prefill can't churn under the
  // user's edit); null = closed.
  const [noteTarget, setNoteTarget] = useState<{ server: string; windowId: string; note: string } | null>(null);
  const [iframeWindowName, setIframeWindowName] = useState("");
  const [iframeWindowUrl, setIframeWindowUrl] = useState("");

  const { removeGhost, addGhostSession } = useOptimisticContext();
  const addGhostWindowStore = useWindowStore((s) => s.addGhostWindow);
  const removeWindowGhost = useWindowStore((s) => s.removeGhost);
  const setWindowsForSession = useWindowStore((s) => s.setWindowsForSession);
  const clearSession = useWindowStore((s) => s.clearSession);
  const ghostWindowIdRef = useRef<string | null>(null);
  const ghostSessionIdRef = useRef<string | null>(null);

  // SSE sync: keep window store in sync with real session data for the
  // current server. windowIds are unique per server only — pass `server`
  // through so cross-server entries don't clobber each other.
  useEffect(() => {
    for (const s of rawSessions) {
      setWindowsForSession(server, s.name, s.windows);
    }
  }, [server, rawSessions, setWindowsForSession]);

  // Palette split/close actions (button loading not visible since palette closes, but we need error toasts)
  const { execute: executeSplit } = useOptimisticAction<[string, string, boolean, string | undefined]>({
    action: (srv, windowId, horizontal, cwd) => splitWindow(srv, windowId, horizontal, cwd),
    onError: (err) => addToast(err.message || "Failed to split pane"),
  });
  const { execute: executeClosePane } = useOptimisticAction<[string, string]>({
    action: (srv, windowId) => closePane(srv, windowId),
    onError: (err) => addToast(err.message || "Failed to close pane"),
  });

  // Browser-title host label: the instance display name (settings override
  // when set, else the health hostname) from the root InstanceNameProvider —
  // the provider owns the one-shot health fetch, and a settings-dialog rename
  // retitles the tab live (o7q8).
  const { displayName: instanceDisplayName } = useInstanceName();
  // The popout's title is `<Surface> · <window name>` (the leaf's HOME window
  // for a foreign leaf — the surface's owner); the id stands in until the
  // payload resolves the name.
  const popoutTitle =
    popoutPosture && popLeaf !== null
      ? `${SURFACE_LABEL[popLeaf.kind]} · ${windowsById.get(popLeaf.windowId)?.name ?? popLeaf.windowId}`
      : undefined;
  useBrowserTitle(sessionName, windowParam, instanceDisplayName, popoutTitle);

  // Sidebar drag-resize handler (desktop only). Width state lives in
  // `ChromeContext` (lifted from per-route local state) so AppShell and
  // BoardPage observe the same width. During drag we call `setSidebarWidth`
  // (in-memory only, ~60-100x/s on pointermove) and commit the final value
  // to localStorage exactly once via `persistSidebarWidth` in the drag-end
  // handler — preserving the pre-change behavior of one write per gesture.
  // Drag-lit is STATE, not a ref: the handle's `rk-sash-lit` class is read at
  // render time, and the pointermove width writes cannot be relied on to flush
  // it (a drag that ends without moving never renders, and a drag-end whose
  // clamped width equals the current one lets React bail out — the sash would
  // stay lit after pointerup).
  const [isDragging, setIsDragging] = useState(false);
  const dragLastWidthRef = useRef<number>(sidebarWidth);

  const handleDragStart = useCallback((startX: number) => {
    setIsDragging(true);
    // Force the drag cursor at the document level so it persists when the pointer
    // leaves the 3px handle mid-drag (implicit pointer-capture workaround). Cleared
    // in handleEnd below. The corner affordance in CollapsiblePanel may overwrite
    // this to `nwse-resize` after this write — that's intended (last write wins).
    document.body.style.cursor = "col-resize";
    const startWidth = sidebarWidth;
    dragLastWidthRef.current = startWidth;

    // Pointer events (not mouse/touch): when the corner affordance initiates both
    // drags, CollapsiblePanel's horizontal handler calls preventDefault() on the
    // pointerdown, which per the Pointer Events spec suppresses the follow-up mouse
    // compatibility events (mousemove/mouseup). Listening for pointermove/pointerup
    // avoids that trap and keeps the same-pointer interaction working end-to-end.
    const handlePointerMove = (e: PointerEvent) => {
      const next = startWidth + (e.clientX - startX);
      dragLastWidthRef.current = next;
      setSidebarWidth(next);
    };

    const handleEnd = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      // Persist the final width once per drag gesture. The in-memory state is
      // already at this value via the last `setSidebarWidth` call, but
      // `persistSidebarWidth` writes through to localStorage (clamped).
      persistSidebarWidth(dragLastWidthRef.current);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handleEnd);
      document.removeEventListener("pointercancel", handleEnd);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handleEnd);
    document.addEventListener("pointercancel", handleEnd);
  }, [sidebarWidth, setSidebarWidth, persistSidebarWidth]);

  const handleDragHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      handleDragStart(e.clientX);
    },
    [handleDragStart],
  );

  // tmux is the source of truth for "current window". The URL is a
  // resumable bookmark used only on initial mount to align tmux with a
  // deep-linked window; after that the URL is treated as derived state and
  // re-written whenever the SSE-driven `isActiveWindow` changes. The 3s
  // `userNavTimestampRef` debounce was removed in this change — there is
  // no client-side window state worth protecting from server overrides.
  //
  // We retain `dialogOpenRef` so that the URL-write effect can skip
  // navigation while a dialog is open (preventing focus-stealing re-renders
  // mid-dialog). The dialog-open suppression applies to the URL writeback
  // only, not to the underlying SSE-derived selection state.
  const dialogOpenRef = useRef(false);
  // hasAlignedToUrlRef gates mount-time alignment of tmux to the URL. On
  // the first `currentSession` value received after the route mounts, if
  // the URL's `$window` differs from tmux's current `isActiveWindow`, fire
  // exactly one `selectWindow` to align tmux to the URL. Subsequent
  // route changes within the same mount do NOT re-fire alignment — the
  // sidebar-click path (a pure mutation) is the only post-mount writer.
  const hasAlignedToUrlRef = useRef(false);
  // Reset alignment guard whenever the route's session changes (this is
  // effectively a fresh "mount" for the alignment contract).
  const lastAlignedSessionRef = useRef<string | null>(null);
  // Pending click intent. A sidebar/palette click optimistically navigates
  // the URL to the clicked window id (@N) AND fires `selectWindow`. Until
  // the SSE snapshot confirms tmux switched (the clicked window reports
  // `isActiveWindow`), the writeback below would see the still-stale
  // `activeWindow` and bounce the URL back to the previously-active window.
  // We record the intent here keyed on `{server, windowId}` (rework H1: `@N`
  // ids are only unique PER SERVER and AppShell persists across `$server`
  // changes, so the server is part of identity — but never the session name:
  // a rename/cross-session move with `@N` preserved keeps the intent alive)
  // and suppress the writeback while the URL still matches BOTH fields.
  // CONFIRMATION is event-driven: the intent clears the instant SSE confirms
  // it (this is NOT the removed 3s wall-clock debounce). FAILURE detection is
  // the one timer in the design (260715-38kg): each pending switch also arms a
  // single CONFIRMATION_WINDOW_MS bounce timer (`beginPendingSwitch`) so a
  // silent selectWindow failure can't park the intent in limbo forever.
  const pendingClickRef = useRef<PendingSwitchTarget | null>(null);

  // Latest flattened window order + current window id, for the window-switch
  // slide transition (260703-l4nf). Held in a ref (synced at render time,
  // below) so `navigateToWindow` can read the current order WITHOUT taking
  // `flatWindows`/`windowParam` as deps — those churn every SSE tick and would
  // recreate the callback (and defeat the sidebar-handler memoization) each
  // tick. `order` is the flattened window-id list (sidebar order); `ungatedIds`
  // marks targets that will render a NON-tty lens (web iframe or code) — those
  // have no xterm first-write receipt seam, so they use the ungated capture (the
  // first-paint gate is terminal-only). Read only on a click, after render, so
  // no TDZ concern.
  const switchTransitionRef = useRef<{
    order: string[];
    ungatedIds: Set<string>;
    currentWindowId: string;
  }>({ order: [], ungatedIds: new Set(), currentWindowId: "" });

  useEffect(() => {
    setCurrentSession(currentSession);
    setCurrentWindow(currentWindow);
  }, [currentSession, currentWindow, setCurrentSession, setCurrentWindow]);

  // Track whether the URL's (session, window) pair has been observed as valid
  // in SSE data since the last server/session/window URL change. Gates the
  // "gone" redirect so a stale-cached or partially-populated first SSE payload
  // (missing the freshly-navigated session, or reporting it with an empty
  // windows list) can't bounce the user to the dashboard before the real data
  // arrives.
  const currentWindowEverSeenRef = useRef(false);
  const lastObservedUrlKeyRef = useRef<string>("");
  useEffect(() => {
    const key = `${server}|${sessionName ?? ""}|${windowParam ?? ""}`;
    if (lastObservedUrlKeyRef.current !== key) {
      lastObservedUrlKeyRef.current = key;
      currentWindowEverSeenRef.current = false;
    }
    if (currentWindow) currentWindowEverSeenRef.current = true;
  }, [server, sessionName, windowParam, currentWindow]);

  // Redirect when the current session/window no longer exists (e.g. window/session killed).
  // Never in the popout posture: the popout does not navigate — a dead window
  // renders the ended "Window closed" state instead.
  useEffect(() => {
    if (popoutPosture) return;
    const target = computeKillRedirect({
      sessionName,
      windowId: windowParam,
      currentSessionWindows: currentSession?.windows ?? null,
      currentWindowExists: !!currentWindow,
      isConnected,
      currentWindowEverSeen: currentWindowEverSeenRef.current,
    });
    if (!target) return;
    if (target.to === "window") {
      navigate({
        to: "/$server/$window",
        params: { server, window: target.windowId },
        // Cross-window redirect (the current window died): empty search so the
        // fallback window resolves its OWN stored layout rather than inheriting
        // the dead window's.
        search: {},
        replace: true,
      });
    } else {
      navigate({ to: "/$server", params: { server }, replace: true });
    }
  }, [sessionName, windowParam, sessions, currentSession, currentWindow, isConnected, navigate, server, popoutPosture]);

  // Active window sync (truth = tmux). The SSE-derived `activeWindow`
  // drives the sidebar selection (see `WindowRow.isSelected`) and the URL
  // writeback below. There is no client-side window selection state.
  const activeWindow = useMemo(() => {
    if (!currentSession) return null;
    return currentSession.windows.find((w) => w.isActiveWindow) ?? null;
  }, [currentSession]);

  // Live refs to tmux's actual active window, the URL's window param, and the
  // route's server, read by the failure bounce-back (260715-38kg) inside the
  // confirmation-timer callback without stale closures. The server ref is part
  // of the H1 cross-server identity guard: a timer armed on serverA must
  // recognize that the route has moved to serverB even when the window-id
  // STRING coincides (`@N` is only unique per server).
  const activeWindowRef = useRef(activeWindow);
  activeWindowRef.current = activeWindow;
  const windowParamRef = useRef(windowParam);
  windowParamRef.current = windowParam;
  // The quake tab `?tab=` param, read on click by `navigateToWindow`'s
  // same-window early return without a stale closure (that path decides
  // whether the no-op tmux switch must still navigate back to the terminal).
  const searchTabRef = useRef(search.tab);
  searchTabRef.current = search.tab;
  const serverRef = useRef(server);
  serverRef.current = server;
  // Live isConnected + receipt-tick reads for the freshness-gated bounce
  // verdict (260823-ke9i): the timer callback must not capture a stale
  // render-scope connection flag, and the tick read stays imperative
  // (ref-backed) so it never subscribes to re-renders.
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  const getServerReceiptTickRef = useRef(ctx.getServerReceiptTick);
  getServerReceiptTickRef.current = ctx.getServerReceiptTick;

  // Pending-switch tracking (260715-38kg): the confirmation timer + the grace
  // mask's cancel fn, so both tear down together when the switch confirms,
  // supersedes, or fails. A single `setTimeout` per pending switch (NOT a poll).
  // 260823-ke9i adds the freshness evidence for the verdict: `tickAtClick`
  // (the server receipt tick at switch start — a snapshot/event arriving later
  // is post-click evidence) and `postContradiction` (the POST 200 reported a
  // different active window — fresh post-click evidence even with a dead
  // socket).
  const pendingSwitchRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    cancelMask: (() => void) | null;
    tickAtClick: number;
    postContradiction: boolean;
    // Set by the confirmation-on-200 path (260823-ke9i): the POST proved tmux
    // switched, so the failure detector is disarmed. A straggler timer fire
    // (a timer created before the POST resolved) is a silent no-op.
    bounceDisarmed: boolean;
  } | null>(null);

  // Clear the confirmation timer + grace-mask cancel for the current pending
  // switch (called on SSE-confirm, supersession, or bounce). Does NOT itself
  // clear `pendingClickRef` — the writeback owns that on confirm; the bounce
  // clears it explicitly.
  const clearPendingSwitchTracking = useCallback(() => {
    const tracked = pendingSwitchRef.current;
    if (!tracked) return;
    clearTimeout(tracked.timer);
    tracked.cancelMask?.();
    pendingSwitchRef.current = null;
  }, []);

  // Failure bounce-back (260715-38kg): the switch never confirmed (explicit POST
  // rejection or the confirmation-window timeout). Un-stick the limbo — clear
  // the pending intent so the URL/heading follow tmux truth, tear down any mask,
  // surface a lightweight toast, and (since a stale `activeWindow` won't retrigger
  // the writeback effect) navigate explicitly to tmux's actual active window.
  // Guarded on the intent STILL targeting `windowId`: a newer navigation that
  // already superseded this switch must not be bounced.
  const bouncePendingSwitch = useCallback(
    (target: PendingSwitchTarget) => {
      // Identity is `{server, windowId}` (rework H1): the intent must still
      // record exactly this switch — a windowId-only match false-positives on
      // cross-server `@N` collisions.
      if (!isSamePendingTarget(pendingClickRef.current, target.server, target.windowId))
        return;
      // Recorded-server mismatch (rework H1): the route has moved to a DIFFERENT
      // server since this switch was armed (AppShell does not remount across
      // `$server` changes, so a stale timer can survive in principle). The
      // server-change teardown effect normally clears this first — defense-in-
      // depth: drop the stale intent and its feedback silently. NEVER toast or
      // navigate for a switch on a server the user has left.
      if (serverRef.current !== target.server) {
        pendingClickRef.current = null;
        clearPendingSwitchTracking();
        abandonSwitchFeedback();
        return;
      }
      // The bounce only applies while the URL still shows the failed target
      // (rework F1). If the user has left the terminal route (Cockpit/board/
      // windowless /$server) or moved to another window, the teardown effects
      // below clear this timer — this guard is defense-in-depth so a straggler
      // callback can never navigate the user back off their chosen route or
      // toast about a switch they abandoned.
      if (windowParamRef.current !== target.windowId) return;
      // SSE already reports the target ACTIVE — the switch DID confirm, but the
      // writeback (the normal event-driven clearer) can be suppressed for the
      // whole confirmation window (`dialogOpenRef` — e.g. a dialog held open
      // >5s over a confirmed switch; rework SF7), or deliberately held the
      // intent because no incoming byte had been counted yet. Not a failure:
      // clear the intent silently — no toast, no navigation. The teardown here
      // is UNCONDITIONAL (`forceSwitchArrived`, not the byte-gated
      // `confirmSwitchArrived`): after the confirmation window has elapsed with
      // the target active, a mask whose byte-driven lift path never fired must
      // never stay up — a stuck input-blocking mask is the worst outcome the
      // design forbids. This rescue runs BEFORE the `bounceDisarmed` check
      // below: a POST-200 disarms the BOUNCE, never the rescue.
      if (activeWindowRef.current?.windowId === target.windowId) {
        pendingClickRef.current = null;
        clearPendingSwitchTracking();
        forceSwitchArrived();
        return;
      }
      // Freshness-gate the verdict (260823-ke9i): a failure is only rendered
      // from evidence that POST-DATES the click. A frozen pre-click snapshot
      // (post-sleep half-open socket) or a disconnected socket re-arms the
      // timer instead — extend-until-evidence, no toast, no navigation. The
      // re-armed timer replaces the tracked entry's (clearPendingSwitchTracking
      // reads the current entry, so every existing clear path cancels it).
      const tracked = pendingSwitchRef.current;
      if (tracked) {
        // A POST-200 already confirmed this switch — the failure detector is
        // disarmed; a straggler fire is a silent no-op (the intent still
        // clears via SSE).
        if (tracked.bounceDisarmed) return;
        const verdict = resolvePendingSwitchVerdict({
          isConnected: isConnectedRef.current,
          tickAtClick: tracked.tickAtClick,
          currentTick: getServerReceiptTickRef.current(target.server),
          postContradiction: tracked.postContradiction,
          activeWindowId: activeWindowRef.current?.windowId,
          targetWindowId: target.windowId,
        });
        if (verdict === "rearm") {
          tracked.timer = setTimeout(() => bouncePendingSwitch(target), CONFIRMATION_WINDOW_MS);
          return;
        }
      }
      clearPendingSwitchTracking();
      pendingClickRef.current = null;
      // Abandon, don't just unmask (rework G2): a fast POST rejection can land
      // INSIDE the 300ms budget with the gate still pending — a bare
      // tearDownMask would let that gate's timer fire moments later and re-arm
      // the mask over the bounced-back window with no lift path (the POST
      // rejected, so liftAccepting never opens). Settling the gate too makes
      // the bounce final.
      abandonSwitchFeedback();
      const active = activeWindowRef.current;
      if (active) {
        // `target.server` — verified equal to the CURRENT route server above,
        // so the callback needs no `server` closure dep (H1: no stale-server
        // navigation is expressible from here).
        navigate({
          to: "/$server/$window",
          params: { server: target.server, window: active.windowId },
          search: {},
          replace: true,
        });
      }
      addToast("Tab switch didn't confirm — back to the active tab", "error");
    },
    [navigate, addToast, clearPendingSwitchTracking],
  );

  // Begin tracking a pending switch: record the `{server, windowId}` intent
  // (rework H1 — window ids are only unique per server), arm the confirmation
  // timer, and (for a gated tty target on the instant-switch path) arm the grace
  // mask. Bounces on explicit POST rejection OR the confirmation-window timeout —
  // NEVER merely because SSE still reports the old window (normal mid-switch).
  const beginPendingSwitch = useCallback(
    (
      target: PendingSwitchTarget,
      opts: { posted?: Promise<unknown>; graceMask?: boolean } = {},
    ) => {
      pendingClickRef.current = { server: target.server, windowId: target.windowId };
      // Supersede any prior pending switch's tracking (its timer/mask).
      clearPendingSwitchTracking();
      // A fresh switch owns ALL feedback: proactively clear a mask/grace timer a
      // prior TIMED-OUT switch left showing (module state — the
      // clearPendingSwitchTracking above only cancels the tracked entry's own
      // timer/handle, never the module mask). The gated paths get this via armGraceMask/
      // beginWindowSwitchGate; the two gateless paths (mount-time cold deep-link
      // alignment, waiting-target navigation) otherwise leave the stale mask up
      // until SSE confirmation. Deliberately the BARE teardown, NOT
      // abandonSwitchFeedback: on the animated path this runs (via
      // beginWindowSwitchGate → startViewTransition → runSwitch) while the
      // switch's OWN just-opened gate is current, and settling it would skip the
      // earned slide (260715-38kg R8). Idempotent no-op when nothing is showing.
      tearDownMask();
      const grace = opts.graceMask ? armGraceMask() : null;
      if (grace) {
        // Post-POST lift filter (rework F3): only once the switch's selectWindow
        // POST resolves may incoming bytes cancel the grace timer / lift the
        // mask — a busy OUTGOING window's bytes ride the same socket and must
        // not un-mask stale content. Mirrors the gate's chained openForNotify.
        void opts.posted?.then(() => grace.openForLift()).catch(() => {});
      }
      // The timer closure carries the full `{server, windowId}` identity so the
      // bounce can verify BOTH fields against the live route (H1).
      const timer = setTimeout(() => bouncePendingSwitch(target), CONFIRMATION_WINDOW_MS);
      const tracked = {
        timer,
        cancelMask: grace ? grace.cancel : null,
        // Freshness evidence for the bounce verdict (260823-ke9i): the receipt
        // tick at click time (a later tick is post-click evidence) and the
        // POST-contradiction flag (set by the .then chain below).
        tickAtClick: getServerReceiptTickRef.current(target.server),
        postContradiction: false,
        bounceDisarmed: false,
      };
      pendingSwitchRef.current = tracked;
      // POST settlement handling (260823-ke9i) — decision logic in
      // `resolvePendingSwitchPost`; the identity guards are load-bearing: the
      // tracked entry must still be current (a superseded switch's late
      // settlement is a no-op) and the intent must still record this target.
      //
      // - "confirm": the 200 is synchronous proof tmux executed the select —
      //   cancel THIS switch's bounce timer so a dead state socket can never
      //   false-bounce it. It cancels ONLY the timer: pendingClickRef stays set
      //   until SSE confirms (the intent is the writeback suppression), and the
      //   gate/mask machinery is untouched (paint feedback stays byte-driven).
      // - "contradiction": fresh post-click evidence — a mismatched
      //   `activeWindow` (an external switch won) or an explicit rejection. The
      //   rejection counts as fresh evidence (it post-dates the click) so the
      //   freshness-gated verdict bounces immediately rather than re-arming
      //   into the failure limbo (SF8). The timer's own expiry handles the
      //   mismatched-200 case.
      const handlePostSettlement = (outcome: SwitchPostOutcome) => {
        const effect = resolvePendingSwitchPost({
          outcome,
          targetWindowId: target.windowId,
          isCurrent: pendingSwitchRef.current === tracked,
          intentMatches: isSamePendingTarget(pendingClickRef.current, target.server, target.windowId),
        });
        if (effect === "confirm") {
          clearTimeout(tracked.timer);
          tracked.bounceDisarmed = true;
        } else if (effect === "contradiction") {
          tracked.postContradiction = true;
          if (outcome.kind === "rejected") bouncePendingSwitch(target);
        }
      };
      opts.posted?.then(
        (resp) => {
          const isResult = (
            r: unknown,
          ): r is SelectWindowResult =>
            typeof r === "object" &&
            r !== null &&
            "ok" in r &&
            typeof r.ok === "boolean";
          handlePostSettlement(
            isResult(resp)
              ? { kind: "resolved", resp }
              : { kind: "resolved", resp: { ok: false } },
          );
        },
        () => handlePostSettlement({ kind: "rejected" }),
      );
    },
    [clearPendingSwitchTracking, bouncePendingSwitch],
  );

  // Route-leave teardown (rework F1, must-fix): leaving the terminal leaf while
  // a switch is pending must abandon the switch, not park a live 5s bounce. On
  // the windowless `/$server` (SessionTiles) the writeback effect can early-
  // return (`!activeWindow || !sessionName`), so without this the timer would
  // fire with frozen refs and navigate the user BACK to a stale terminal route
  // with a spurious failure toast — even when the switch actually succeeded.
  // `abandonSwitchFeedback` (not a bare tearDownMask — rework G2) also settles
  // a still-pending gate, whose timer could otherwise re-mask up to 300ms
  // after the leave.
  useEffect(() => {
    if (windowParam) return;
    pendingClickRef.current = null;
    clearPendingSwitchTracking();
    abandonSwitchFeedback();
  }, [windowParam, clearPendingSwitchTracking]);

  // Unmount teardown (rework F1): navigating to the Cockpit `/` or a board
  // route unmounts AppShell, but the confirmation timer (a setTimeout closure)
  // and the module-level mask state + pending gate outlive the component
  // instance. Abandon both (rework G2: a bare tearDownMask would leak a
  // re-masking gate timer into the next mount) so no straggler bounce or
  // leftover mask greets it. `clearPendingSwitchTracking` is a stable
  // useCallback, so this cleanup runs only at actual unmount.
  useEffect(
    () => () => {
      clearPendingSwitchTracking();
      abandonSwitchFeedback();
    },
    [clearPendingSwitchTracking],
  );

  // Server-change teardown (rework H1, must-fix): window ids (`@N`) are only
  // unique PER SERVER, and AppShell persists across `$server` route changes
  // WITHOUT remounting — a cross-server navigation to a colliding id (serverA
  // pending @5 → serverB's @5) keeps `windowParam` the same string, so neither
  // the route-leave nor the unmount teardown fires. Abandon the previous
  // server's pending switch here: its timer closure, gate, and mask all
  // describe a window that no longer means the same thing. DECLARED BEFORE the
  // alignment effect (effects run in declaration order within a commit) so the
  // alignment skip sees a cleared intent and serverB's tmux alignment fires.
  // A prev-ref makes this a no-op on mount and fires it only on actual change.
  const prevServerRef = useRef(server);
  useEffect(() => {
    if (prevServerRef.current === server) return;
    prevServerRef.current = server;
    pendingClickRef.current = null;
    clearPendingSwitchTracking();
    abandonSwitchFeedback();
  }, [server, clearPendingSwitchTracking]);

  // Mount-time alignment: if a deep-linked URL points at a window that is
  // not the current tmux-active window for its (derived) session, fire exactly
  // one `selectWindow` to align tmux to the URL. The comparison is window-id
  // only, so a deep link to `/$server/@N` aligns to `@N` regardless of which
  // session the snapshot reports it under. Guarded by `hasAlignedToUrlRef`,
  // re-armed per window-route so subsequent navigations within the same window
  // don't replay the alignment (which would clobber user clicks).
  useEffect(() => {
    // The popout never aligns tmux to its URL: its window id is fixed at
    // open, and selecting it would yank every other viewer of the server.
    if (popoutPosture) return;
    if (!windowParam || !currentSession) return;
    const windowKey = `${server}|${windowParam}`;
    if (lastAlignedSessionRef.current !== windowKey) {
      // Fresh window route — re-arm the guard.
      hasAlignedToUrlRef.current = false;
      lastAlignedSessionRef.current = windowKey;
    }
    if (hasAlignedToUrlRef.current) return;
    // Wait for the first SSE-populated session payload (with a real
    // active window) before deciding whether to align.
    const activeId = activeWindow ? activeWindow.windowId : null;
    if (activeId === null) return;
    hasAlignedToUrlRef.current = true;
    if (activeId !== windowParam) {
      // A click-driven switch already recorded THIS exact intent (rework G1,
      // must-fix): every optimistic click navigation re-fires this effect with
      // SSE still stale (`activeId !== windowParam` one commit after a click),
      // and re-tracking here would fire a DUPLICATE selectWindow POST and —
      // worse — `beginPendingSwitch`'s supersession would cancel the click's
      // just-armed grace mask, making the instant-path mask dead in the live
      // app. This effect's tracking is for the COLD deep-link only, where no
      // click recorded an intent. The match is server-scoped (rework H1): a
      // stale intent from ANOTHER server with a colliding `@N` must not
      // suppress THIS server's alignment (the server-change teardown above
      // normally clears it first; this comparison is the correctness seam).
      if (isSamePendingTarget(pendingClickRef.current, server, windowParam)) return;
      // Deep-link to a window that is NOT tmux's current active window: record
      // a pending intent on `@N` (same mechanism as a sidebar click) so the URL
      // writeback below does NOT bounce us back to the currently-active window
      // before tmux confirms the alignment. Without this, a cold deep-link to
      // `/$server/@N` would flicker to the active window and unmount the
      // terminal. The intent clears the instant SSE reports `@N` active.
      // The confirmation timer + rejection bounce (260715-38kg) un-stick a
      // silent-failure limbo where the alignment POST fails or never confirms;
      // no grace mask here — a cold deep-link mounts a fresh terminal (a
      // connecting pane, not stale bytes).
      const posted = selectWindow(server, windowParam);
      posted.catch(() => {});
      beginPendingSwitch({ server, windowId: windowParam }, { posted });
    }
  }, [server, windowParam, currentSession, activeWindow, beginPendingSwitch, popoutPosture]);

  // URL writeback: whenever the SSE snapshot says a different window is
  // active than what the URL reflects, write the URL via `replace`. No
  // debounce — tmux truth wins always. Dialogs suppress the writeback to
  // keep focus-stealing re-renders from interrupting user input.
  useEffect(() => {
    // The popout's route is fixed for its lifetime — it never follows the
    // opener's (or tmux's) navigation.
    if (popoutPosture) return;
    if (!activeWindow || !sessionName) return;
    if (dialogOpenRef.current) return;
    // Honor a pending click: while the URL still points at the optimistically
    // navigated window the user just clicked, suppress the writeback so a
    // stale snapshot can't bounce us back to the previously-active window.
    // Clear the intent the moment SSE confirms it (active matches the click)
    // or the URL has moved on (a newer navigation superseded it).
    const pending = pendingClickRef.current;
    if (pending) {
      // Match on `{server, windowId}` — never the session name (a rename or
      // cross-session move that preserves `@N` must NOT release the suppression
      // early), and never the window id alone (rework H1: `@N` is only unique
      // per server, so a stale intent from another server with a colliding id
      // must neither suppress the writeback nor read as confirmed — it falls
      // into the `!urlMatchesPending` clear-and-abandon branch below).
      const urlMatchesPending = isSamePendingTarget(pending, server, windowParam);
      const sseConfirmed = isSamePendingTarget(pending, server, activeWindow.windowId);
      // SSE confirmation is authoritative for INTENT, but paint feedback stays
      // byte-driven: until a byte has been counted as the incoming window's,
      // `confirmSwitchArrived` is a no-op on the gate and the mask (the gate's
      // 300ms timeout arms the spinner; the first counted write lifts it), and
      // the tracked confirmation timer is the ONLY path to the unconditional
      // `forceSwitchArrived` rescue. So a confirmation that lands before the
      // byte keeps BOTH the intent and its tracking: clearing them here would
      // leave a timeout-armed mask with no lift when bytes never come. The
      // next SSE tick after the byte (or the timer itself) resolves it.
      if (sseConfirmed && urlMatchesPending && !hasCountedIncomingBytes()) return;
      if (sseConfirmed || !urlMatchesPending) {
        pendingClickRef.current = null;
        // The switch resolved (confirmed with a counted byte, or superseded by
        // a newer nav): stop tracking so the confirmation timer never fires a
        // spurious late bounce and any grace mask's cancel is released.
        clearPendingSwitchTracking();
        // A same-session switch whose tmux redraw completed BEFORE
        // `openForNotify` counts that receipt at the POST's resolution (the
        // in-flight receipt), so the confirmation here lands after the counted
        // byte in the landed-fast case.
        //
        // UNCONFIRMED clear (`!urlMatchesPending` — browser Back/Forward away
        // from a pending target; rework SF5): abandon the switch's feedback —
        // if its POST failed, an armed mask has no other lift path, and a
        // still-pending gate must not re-mask the destination.
        if (sseConfirmed) confirmSwitchArrived();
        else abandonSwitchFeedback();
      } else {
        return; // intent outstanding — let the URL stand
      }
    }
    if (activeWindow.windowId === windowParam) return;
    navigate({
      to: "/$server/$window",
      params: { server, window: activeWindow.windowId },
      // Window switch driven by tmux (SSE writeback): empty search so the
      // newly-active window resolves its own stored layout.
      search: {},
      replace: true,
    });
  }, [activeWindow, sessionName, windowParam, navigate, server, clearPendingSwitchTracking, popoutPosture]);

  // Navigation callback for sidebar/breadcrumbs. tmux is the source of truth,
  // but a click is explicit user intent: we navigate the URL optimistically
  // (so the terminal renders immediately, including the first click from the
  // Dashboard and cross-session clicks the SSE writeback alone can't express)
  // AND fire `selectWindow` to bring tmux into agreement. `pendingClickRef`
  // suppresses the writeback's bounce-back until SSE confirms the switch.
  //
  // On mobile, close the overlay sidebar after a destination tap.
  const navigateToWindow = useCallback(
    (windowId: string) => {
      // Same-window no-op click (rework G3, must-fix): the target is BOTH the
      // URL window AND tmux's active window (a mobile drawer dismissal tap, the
      // palette's "(current)" entry). Nothing will change — tmux emits no bytes
      // and the event-driven SSE snapshot never re-confirms — so arming the
      // pending-switch machinery would guarantee a spurious spinner mask at
      // 300ms over the very terminal the user is on, plus a false failure
      // toast at the confirmation window. Keep the ergonomic drawer close;
      // arm nothing tmux-side. The one navigation the no-op still owes is
      // leaving a mobile quake tab (below).
      if (
        isRedundantSwitch(windowId, windowParamRef.current, activeWindowRef.current?.windowId)
      ) {
        // Same-window tap from a mobile quake tab (R3): a watched row can BE
        // the active window (the backend joins `monitored` onto all windows),
        // so the no-op tmux switch above must still leave the tab content slot
        // — replace the route with a cleared search (dropping `?tab=`) while
        // arming nothing tmux-side. Mobile-only gate: on desktop the `?tab=`
        // handoff effect owns the param and strips it itself.
        if (isMobile && searchTabRef.current) {
          navigate({
            to: "/$server/$window",
            params: { server, window: windowId },
            search: {},
            replace: true,
          });
        }
        if (isMobile) setSidebarOpen(false);
        return;
      }

      // Today's instant switch — the byte-identical body wrapped (or not)
      // below. Returns the `selectWindow` POST so the gated path can wait for
      // tmux to be told to switch before it starts counting incoming writes.
      // The returned promise PRESERVES the POST's rejection so a chained
      // `openForNotify` only fires on success (the gate must not open — and so
      // let a stale outgoing byte release it — when tmux was never told to
      // switch). Errors are still ignored: a separate `.catch(() => {})` marks
      // the promise handled (no unhandled-rejection warning) for the fire-and-
      // forget side effect, and every downstream consumer of the returned
      // promise attaches its own rejection handler.
      // `graceMask` arms the ~300ms grace mask (260715-38kg) — only on the
      // INSTANT-switch fallback (no VT render-freeze phase, so no gate to time
      // out). The animated path leaves it false: the gate's `"timeout"` settle
      // arms the mask there instead (via `settleGate`).
      const runSwitch = (graceMask: boolean): Promise<unknown> => {
        navigate({
          to: "/$server/$window",
          params: { server, window: windowId },
          // Window switch (sidebar/palette click): clear the `?view=` param so
          // the target window resolves its OWN view (localStorage + default
          // hint), not the outgoing window's. Same-window lens switches go
          // through `switchView`, which sets the param explicitly.
          search: {},
          // PUSH (no `replace`): a user-initiated window switch IS a
          // navigation, so it creates a history entry the top-bar ◀ ▶ arrows
          // can retrace (260715-m4xy). No dedup — w1→w5→w1 pushes three
          // entries and Back retraces every hop. The two tmux/preference-driven
          // navigates that MUST stay `replace` are the SSE URL-writeback effect
          // (tmux corrections aren't user intent) and `switchView` (per-viewer
          // lens toggles) — do not add `replace` back here.
        });
        const posted = selectWindow(server, windowId);
        posted.catch(() => {}); // ignore errors (fire-and-forget)
        // Record the pending intent + arm the confirmation timer (and, on the
        // instant path, the grace mask). Bounces on explicit POST rejection or
        // the confirmation-window timeout — un-sticking the silent-failure limbo.
        beginPendingSwitch({ server, windowId }, { posted, graceMask });
        if (isMobile) setSidebarOpen(false);
        return posted;
      };

      // Window-switch slide transition (260703-l4nf). Gate on: View Transitions
      // support, motion not reduced, an outgoing window in view, and a slide
      // direction resolvable from the flattened sidebar order. Any failure →
      // the instant switch above (progressive enhancement).
      const { order, ungatedIds, currentWindowId } = switchTransitionRef.current;
      const direction = windowSwitchDirection(order, currentWindowId, windowId);
      // Guard `matchMedia` for non-browser/test envs (jsdom variants, older
      // WebViews) where it may be missing — same pattern as `use-is-mobile.ts`
      // and `chrome-context.tsx`'s `isMobileViewport`.
      const reducedMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animate = shouldAnimateWindowSwitch({
        hasVTSupport: viewTransitionSupported(),
        reducedMotion,
        hasOutgoingWindow: !!currentWindowId,
        direction,
      });

      // Single narrowed guard: `shouldAnimateWindowSwitch` already returns false
      // when `direction === null`, so `!animate` alone covers the fallback; the
      // `!direction` half is the TypeScript narrowing that lets the assignment
      // below treat `direction` as non-null.
      if (!animate || !direction) {
        // Instant-switch fallback (no VT support, reduced motion, no outgoing
        // window, or no direction). Arm the grace mask for a gated (tty) target
        // — non-tty (web/chat) targets stay mask-less, matching the gated path.
        const { ungatedIds } = switchTransitionRef.current;
        const targetUngated = ungatedIds.has(windowId);
        // A fresh switch owns ALL feedback. A leftover ARMED mask is now
        // cleared by `beginPendingSwitch`'s fresh-switch teardown (via
        // `runSwitch` below — 260719-h0x4); this call's remaining unique value
        // is settling a still-PENDING prior gate as "superseded" so its later
        // timeout cannot re-mask the new non-tty view (the bare teardown
        // deliberately never touches the gate — the animated path reaches it
        // with its OWN gate current). Without this, an animated switch
        // superseded within its 300ms budget by this ungated instant path
        // would re-mask a view whose semantics are "non-tty targets stay
        // mask-less".
        if (targetUngated) abandonSwitchFeedback();
        runSwitch(!targetUngated);
        return;
      }

      // The new-state capture is gated on the incoming window's first inbound
      // bytes, with a timeout (the polished variant). Terminal targets open the
      // gate AFTER the selectWindow POST resolves — so a busy outgoing window's
      // still-streaming bytes (a same-session switch rides the existing socket)
      // can't release the gate before tmux has run select-window — then await
      // the first-write signal, which `TerminalClient` fires at message-receipt
      // time inside `ws.onmessage` (via `notifyFirstWrite`), not at terminal
      // write time (rAF-scheduled writes don't fire during VT suppression).
      // Non-tty targets (web iframe, chat) have no such receipt seam, so they
      // use the ungated capture.
      //
      // Trade-off (accepted): during the ~180ms slide the View Transitions API
      // paints a snapshot pseudo-element that hit-tests to <html>, so a click
      // that lands on the terminal region mid-transition is lost (the app has a
      // brief pointer-input dead window). Keyboard input is unaffected — it
      // targets the focused element, not a hit-tested point — so the
      // keyboard-first flows (constitution V) never lose input.
      //
      // Fire-and-forget: `beginWindowSwitchGate` fires any prior in-flight gate
      // so a rapid second switch doesn't stall behind the first's timeout (the
      // VT spec queues the second callback behind the first's returned promise).
      // NOTE: this call is load-bearing on BOTH paths, including the ungated path
      // below — it fires a prior PENDING terminal gate (a terminal→non-tty switch
      // supersedes an in-flight terminal gate), so it must run before we branch
      // on `targetUngated`.
      //
      // A target is ungated (web iframe or code) exactly when its EFFECTIVE
      // resolved view is not `tty` — precomputed into `ungatedIds` at render time
      // (below) from each window's stored view + default hint.
      const targetUngated = ungatedIds.has(windowId);
      // `gated` (tty target) drives the pending mask: only a gated switch's
      // `"timeout"` settle arms the LogoSpinner mask (260715-38kg). A web/code
      // target is ungated and never masks.
      const gate = beginWindowSwitchGate({ gated: !targetUngated });
      // Capture a monotonic token so only the LATEST switch's cleanup may clear
      // the direction attribute (a superseded transition's `finished` still
      // fulfills — see below).
      const directionToken = nextDirectionToken();
      document.documentElement.dataset.windowSwitchDirection = direction;
      const transition = document.startViewTransition(async () => {
        // Animated path: grace mask stays off — the gate's timeout arms the mask.
        const posted = runSwitch(false);
        if (!targetUngated) {
          // Race-at-entry: arm the ~300ms budget at callback ENTRY. Do NOT await
          // the POST — CHAIN `openForNotify` off it (fire-and-forget) and await
          // only the gate wait, whose timeout clock starts here. This hard-caps
          // the callback (and thus the document-wide render suppression) at the
          // timeout regardless of the POST's fate: `selectWindow` has no client
          // fetch timeout, so awaiting it directly could freeze the document up
          // to Chromium's ~4s VT deadline and serialize a rapid second switch
          // behind the stall. Chaining still filters outgoing writes — only
          // writes after the POST resolves SUCCESSFULLY count (openForNotify
          // runs post-POST, and `runSwitch`'s promise rejects on POST failure so
          // the `.then` is skipped and the gate stays closed → it times out
          // ungated rather than releasing on a stale outgoing byte).
          void posted.then(() => gate.openForNotify()).catch(() => {});
          // The slide is now an EARNED signal (260715-38kg): it plays ONLY when
          // the gate settles `"first-write"` (bytes confirmed within 300ms) —
          // every other settle SKIPS the transition (rework H2/T012). On
          // `"timeout"` that cuts to the (masked, via settleGate) new state so
          // the slide never animates into unconfirmed content. `"superseded"`
          // covers TWO cases: a rapid second switch (the VT spec already skips
          // this transition — the explicit call is a harmless no-op on an
          // already-skipped transition) AND an abandoned/bounced switch
          // (`abandonSwitchFeedback` settles the gate with no successor VT, so
          // WITHOUT the explicit skip the failed switch would animate alongside
          // its failure feedback — slide = confirmed arrival, R8).
          const reason = await gate.waitForFirstWrite();
          if (reason !== "first-write") {
            transition.skipTransition();
          }
        }
      });
      // Clear the direction attribute once the transition settles. `finished`
      // FULFILLS both on completion AND when the transition is SKIPPED (a rapid
      // second switch supersedes this one — the path we now enable); it does not
      // reject on skip. So without a guard a superseded transition's cleanup
      // would delete the attribute its SUCCESSOR already set, dropping the
      // successor slide's direction CSS. Latest-wins guard: clear only when this
      // switch is still the latest to have set the attribute — mirroring the
      // gate's still-points-at-itself pattern. The trailing `.catch` swallows
      // any rejection (defensive) to avoid an unhandled-rejection warning.
      transition.finished
        .finally(() => {
          if (isLatestDirectionToken(directionToken)) {
            delete document.documentElement.dataset.windowSwitchDirection;
          }
        })
        .catch(() => {});
    },
    [server, navigate, isMobile, setSidebarOpen, beginPendingSwitch],
  );

  // Dialog state management. The two option callbacks are useCallback-stable:
  // inline arrows would churn the `dialogs` object every render, which cascades
  // through the palette action memos into a per-render slot re-registration
  // (260811-239r — observed as a "Maximum update depth exceeded" storm).
  const handleDialogKillComplete = useCallback(
    () => navigate({ to: "/$server", params: { server }, replace: true }),
    [navigate, server],
  );
  const handleDialogSessionRenamed = useCallback(() => {
    // The route no longer carries a session segment, so a rename needs no
    // navigation when a window is in view — the breadcrumb re-derives the new
    // session name from the next SSE snapshot. Only redirect to the dashboard
    // when no window is selected (nothing to keep us anchored).
    if (!windowParam) {
      navigate({ to: "/$server", params: { server }, replace: true });
    }
  }, [navigate, server, windowParam]);
  const dialogs = useDialogState({
    sessionName,
    windowId: currentWindow?.windowId,
    onKillComplete: handleDialogKillComplete,
    onSessionRenamed: handleDialogSessionRenamed,
  });

  // Keep dialogOpenRef in sync so the activeWindow effect can check it without deps.
  // The server create/kill open-state comes from the layout-owned
  // `server-dialogs-context` (260811-239r) — the dialogs mount in AppLayout now,
  // but gating this route's URL writeback while one is up is unchanged.
  dialogOpenRef.current =
    dialogs.showRenameSessionDialog || dialogs.showKillConfirm || dialogs.showKillSessionConfirm || createServerOpen || killServerTarget != null || adoptServerTarget != null || showTmuxCommands || showCreateWindowAtFolderDialog || showCreateIframeDialog || spawnAgentTarget != null || sessionNamePrompt != null || operatorComposeMode != null || noteTarget != null;

  // Flat window list for palette actions
  const flatWindows = useMemo(() => {
    return sessions.flatMap((s) =>
      s.windows.map((w) => ({ session: s.name, window: w })),
    );
  }, [sessions]);

  // Sync the window-switch transition ref (read on click by `navigateToWindow`)
  // with the latest flattened order + current window. Render-time assignment is
  // cheap and keeps the callback deps stable — see `switchTransitionRef` above.
  switchTransitionRef.current = {
    order: flatWindows.map((fw) => fw.window.windowId),
    // A target is UNGATED (ungated capture, no xterm first-write receipt seam)
    // exactly when its effective MAIN SLOT (slot A of the layout,
    // 260812-ab5v) is NOT `tty` — i.e. it renders the IframeWindow (web)
    // or CodeSurface (code) surface in its main slot, neither of
    // which has the terminal's first-write seam (260714-t97o-web-view-lens R12).
    // The classification reads the payload's
    // shared `@rk_win_layout` via `effectiveLayout` — the same layout the
    // target route will render, no localStorage involved. Degradation is
    // baked in, so a window whose layout resolves tty-led (unset option,
    // unavailable slot A) STAYS on the gated terminal path — getting this
    // wrong reintroduces the blank-pane/stuck-transition class of bugs
    // (ui-patterns.md § Window-Switch Slide Transition).
    ungatedIds: new Set(
      flatWindows
        .filter((fw) => slotOrder(effectiveLayout(fw.window, gui))[0] !== "tty")
        .map((fw) => fw.window.windowId),
    ),
    currentWindowId: windowParam ?? "",
  };

  // Create a new window in a session (from sidebar "+" button)
  const { execute: executeCreateWindow } = useOptimisticAction<[string, string]>({
    action: (srv, session) => {
      const targetSession = sessions.find((s) => s.name === session);
      const activeWin = targetSession?.windows.find((w) => w.isActiveWindow);
      // No name — tmux auto-names the window to its folder basename via
      // automatic-rename-format (the -c cwd on create makes this immediate).
      return createWindow(srv, session, undefined, activeWin?.worktreePath);
    },
    onOptimistic: (srv, session) => {
      // Label the optimistic ghost with the raw basename of the creation cwd so
      // it matches what tmux will name the window (was hardcoded "zsh").
      const targetSession = sessions.find((s) => s.name === session);
      const activeWin = targetSession?.windows.find((w) => w.isActiveWindow);
      ghostWindowIdRef.current = addGhostWindowStore(srv, session, rawBasename(activeWin?.worktreePath));
    },
    onRollback: () => {
      if (ghostWindowIdRef.current) {
        removeWindowGhost(ghostWindowIdRef.current);
        ghostWindowIdRef.current = null;
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to create tab");
    },
    onSettled: () => {
      ghostWindowIdRef.current = null;
    },
  });

  // Instant session creation — derives name from active window's CWD, deduplicates, no dialog
  const { execute: executeCreateSessionInstant, isPending: isSessionCreatePending } = useOptimisticAction<[string, string, string | undefined]>({
    action: (srv, name, cwd) => createSession(srv, name, cwd),
    onOptimistic: (srv, name) => {
      ghostSessionIdRef.current = addGhostSession(srv, name);
    },
    onRollback: () => {
      if (ghostSessionIdRef.current) {
        removeGhost(ghostSessionIdRef.current);
        ghostSessionIdRef.current = null;
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to create session");
    },
    onSettled: () => {
      ghostSessionIdRef.current = null;
    },
  });

  // Freshest-value refs for the instant-create path. `sessions`/`currentWindow`/
  // `isSessionCreatePending` all churn on every SSE tick; reading them via
  // render-time-mutated refs (the same pattern as `dialogOpenRef` above) keeps
  // `handleCreateSessionInstant` referentially stable across ticks, so it (and
  // the Sidebar/palette consumers that receive it) don't defeat the
  // memoization downstream. The values read are always the latest committed
  // render's, which is exactly what a click handler wants.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const currentWindowRef = useRef(currentWindow);
  currentWindowRef.current = currentWindow;
  const isSessionCreatePendingRef = useRef(isSessionCreatePending);
  isSessionCreatePendingRef.current = isSessionCreatePending;
  // `ctx.sessionsByServer` is a fresh Map every SSE tick; the cross-server
  // create branch reads it at click time via this ref so the stable
  // `onCreateSession` callback below doesn't have to depend on it.
  const sessionsByServerRef = useRef(ctx.sessionsByServer);
  sessionsByServerRef.current = ctx.sessionsByServer;

  const handleCreateSessionInstant = useCallback(() => {
    // Guard against concurrent creates: a second click before the first request
    // settles would overwrite ghostSessionIdRef, causing ghost tracking to break.
    if (isSessionCreatePendingRef.current) return;
    const cwd = currentWindowRef.current?.worktreePath;
    const existingNames = sessionsRef.current.map((s) => s.name);
    const name = deriveInstantSessionName(cwd, existingNames);
    executeCreateSessionInstant(server, name, cwd || undefined);
  }, [server, executeCreateSessionInstant]);

  // `Session: Create` (palette body, and the chord via fromPalette) opens the
  // save-as-style name prompt instead of creating instantly. The prefill is
  // the exact name instant create would have used, read from the same
  // freshest-value refs at open time — Enter on the untouched default
  // reproduces today's outcome. Sidebar/tiles/board `+` stay instant.
  const handleOpenSessionNamePrompt = useCallback(() => {
    if (isSessionCreatePendingRef.current) return;
    const cwd = currentWindowRef.current?.worktreePath;
    const existingNames = sessionsRef.current.map((s) => s.name);
    setSessionNamePrompt({ defaultName: deriveInstantSessionName(cwd, existingNames) });
  }, []);

  const handleSessionNamePromptSubmit = useCallback(
    (name: string) => {
      setSessionNamePrompt(null);
      if (isSessionCreatePendingRef.current) return;
      const cwd = currentWindowRef.current?.worktreePath;
      executeCreateSessionInstant(server, name, cwd || undefined);
    },
    [server, executeCreateSessionInstant],
  );

  const handleCreateWindow = useCallback(
    (session: string) => {
      executeCreateWindow(server, session);
    },
    [server, executeCreateWindow],
  );

  // Open the spawn-agent dialog for an explicit `{server, session}` target
  // (260713-sbk1; explicit target since gsmu). The palette `Agent: Spawn` action
  // and the window-switcher `+ New Agent` pass the CURRENT `{server, sessionName}`;
  // the sidebar bot button passes the ROW's `{server, session}` (any server →
  // cross-server spawn). Gated on a resolvable session at the call sites.
  const handleOpenSpawnAgent = useCallback((srv: string, sess: string) => {
    setSpawnAgentTarget({ server: srv, session: sess });
  }, []);

  // Open the operator compose dialog with the entry point's pre-selected mode
  // (260822-wyn3): the palette verbs pass their own mode; the pinned operator
  // row's compose icon passes just the server and lands on the spawn default.
  // The server is always the CURRENT one — the dialog is gated on this
  // server's operator.
  const handleOperatorCompose = useCallback((_srv: string, mode: "spawn" | "find" = "spawn") => {
    setOperatorComposeMode(mode);
  }, []);

  // The sidebar's operator placeholder row (no operator window on the server)
  // opens the quake terminal drawer on the Operator Terminal segment, where
  // the Start operator button sits. Identity-arg []-dep callback — the
  // memoized ServerGroup prop contract.
  const handleOperatorPlaceholder = useCallback((srv: string) => {
    requestQuakeTerminal({ action: "open", server: srv, segment: "terminal" });
  }, []);

  // Navigate to a freshly-created agent window on `srv`. When `srv` IS the
  // current server, reuse navigateToWindow (its window-switch transition);
  // otherwise route cross-server via the 2-segment /$server/$window URL. Mirrors
  // handleSidebarSelectWindow. Shared by the spawn dialog and the row-flyout fork
  // (260806-s4av) so the two cannot drift.
  const navigateToSpawnedWindow = useCallback(
    (srv: string, windowId: string) => {
      if (srv === server) {
        navigateToWindow(windowId);
        return;
      }
      navigate({ to: "/$server/$window", params: { server: srv, window: windowId } });
      if (isMobile) setSidebarOpen(false);
    },
    [server, navigateToWindow, navigate, isMobile, setSidebarOpen],
  );

  // Reopen the top of the server's recently-closed ring as a fresh shell.
  // Success pops the mirror, navigates (the fork flow's navigation), and
  // toasts; when the record carried an agent identity the toast offers
  // "Resume agent", which swaps the fresh shell for the resumed agent window.
  // The record survives plain reopen server-side so the toast action can
  // resolve it — a toast that times out without the action dismisses it.
  // A 409 (owning session gone) drops the mirror copy too: the backend has
  // already dropped the record, so keeping the entry would offer a dead end.
  const reopenClosed = useCallback(async () => {
    const top = recentlyClosedStack[0];
    if (!server || !top) return;
    const dismissRecord = () => {
      dismissClosedWindow(server, top.id).catch(() => {});
    };
    try {
      const res = await reopenClosedWindow(server, top.id);
      popRecentlyClosed(server, top.id);
      if (res.windowId) navigateToSpawnedWindow(server, res.windowId);
      const hasAgent = top.agentProvider !== undefined && top.agentRef !== undefined;
      addToast(
        `Reopened "${top.window.name}" (fresh shell)`,
        "info",
        hasAgent && res.windowId
          ? {
              label: "Resume agent",
              onSelect: () => {
                resumeClosedWindow(server, top.id, res.windowId)
                  .then((r) => {
                    if (r.windowId) navigateToSpawnedWindow(server, r.windowId);
                  })
                  // The fresh-shell window stays; only the resume failed.
                  .catch((err: Error) => addToast(err.message || "Failed to resume agent", "error"));
              },
            }
          : undefined,
        dismissRecord,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        popRecentlyClosed(server, top.id);
      }
      addToast(err instanceof Error ? err.message : "Failed to reopen tab", "error");
    }
  }, [server, recentlyClosedStack, navigateToSpawnedWindow, addToast]);

  // `Tab: Reopen closed` — stack-gated on the CURRENT server's mirror so the
  // dispatcher's fromPalette lookup gates the reopen chord for free (absent
  // entry → no handler → untouched fall-through). Offered on every AppShell
  // route for the server, not only the killed window's session.
  const reopenActions: PaletteAction[] = useMemo(
    () => buildReopenWindowAction(recentlyClosedStack, () => void reopenClosed()),
    [recentlyClosedStack, reopenClosed],
  );

  // Fork a window's agent conversation (260806-s4av): a NEW window in the SAME
  // session and directory, resuming that agent's session with --fork-session. The
  // backend derives everything from the windowId, so the client sends nothing but
  // the identity. On success navigate to the fork; a best-effort empty windowId
  // (the backend's display-message resolve failed) skips navigation and lets SSE
  // surface the row, matching the spawn dialog's rule.
  //
  // RETURNS the settle promise (already error-handled here, so it never rejects):
  // the flyout's fork button awaits it to hold its in-flight disabled state, so
  // repeated clicks cannot fire multiple mutating POSTs and create N forks.
  const handleForkWindow = useCallback(
    (srv: string, windowId: string): Promise<void> =>
      forkWindow(srv, windowId)
        .then((res) => {
          if (res.windowId) navigateToSpawnedWindow(srv, res.windowId);
        })
        .catch((err: Error) => addToast(err.message || "Failed to fork conversation", "error")),
    [navigateToSpawnedWindow, addToast],
  );

  const handleWindowMarkerChange = useCallback(
    (srv: string, _session: string, windowId: string, marker: string | null) => {
      setWindowMarkerApi(srv, windowId, marker).catch((err: Error) =>
        addToast(err.message || "Failed to set tab marker", "error"),
      );
    },
    [addToast],
  );

  // Ask the server's operator window to fix a subject window's tab name
  // (260822-fih1-operator-request-fix-tab-name): fire-and-forget — success
  // toasts the hand-off and the rename itself arrives via the normal SSE
  // derive tick; a queued hand-off gets its own toast, while delivery and
  // validation failures toast the server's structured message. RETURNS the
  // settle promise (already error-handled, so
  // it never rejects): the flyout's row awaits it to hold its in-flight guard,
  // so repeated clicks cannot fire multiple POSTs.
  const handleFixTabName = useCallback(
    (srv: string, windowId: string): Promise<void> =>
      sendOperatorRequest(srv, windowId, "fix-tab-name")
        .then((result) =>
          addToast(operatorRequestToast(result, "Sent to operator — tab will rename shortly"), "info"),
        )
        .catch((err: Error) => addToast(err.message || "Failed to reach the operator", "error")),
    [addToast],
  );

  // Fire a server-scoped, non-destructive operator request directly (the
  // brief-me / whats-stuck palette entries — 260822-rfz2): the same
  // fire-and-forget shape as handleFixTabName — success toasts the hand-off
  // (the digest/triage lands in the operator tab; there is no response
  // channel), failure toasts the server's structured message (a zero-waiting
  // whats-stuck surfaces its 409 here).
  const handleServerOperatorAction = useCallback(
    (srv: string, template: string, successToast: string): Promise<void> =>
      sendServerOperatorRequest(srv, template, "")
        .then((result) => addToast(operatorRequestToast(result, successToast), "info"))
        .catch((err: Error) => addToast(err.message || "Failed to reach the operator", "error")),
    [addToast],
  );

  // Fire the update-annotations request scoped to ONE session (the session
  // card's row — 260827-8n6k): the same fire-and-forget shape — success
  // toasts the hand-off, and the notes themselves arrive via the normal SSE
  // derive tick (user-option writes ride the ~12s safety poll).
  const handleUpdateAnnotations = useCallback(
    (srv: string, session: string): void => {
      void sendServerOperatorRequest(srv, "update-annotations", "", session)
        .then((result) =>
          addToast(
            operatorRequestToast(result, "Sent to operator — notes will be updated shortly"),
            "info",
          ),
        )
        .catch((err: Error) => addToast(err.message || "Failed to reach the operator", "error"));
    },
    [addToast],
  );

  // Ask the server's operator window to annotate a subject window with a
  // one-line @rk_win_note status note (260824-bb5n): the same fire-and-forget
  // shape as handleFixTabName — the note itself arrives via the normal SSE
  // derive tick (user-option mutations emit no control-mode event, so
  // agent-side writes ride the ~12s safety poll).
  const handleAnnotateTab = useCallback(
    (srv: string, windowId: string): Promise<void> =>
      sendOperatorRequest(srv, windowId, "annotate-tab")
        .then((result) =>
          addToast(
            operatorRequestToast(result, "Sent to operator — tab will be annotated shortly"),
            "info",
          ),
        )
        .catch((err: Error) => addToast(err.message || "Failed to reach the operator", "error")),
    [addToast],
  );

  // Submit the note prompt (260824-bb5n): bare text through the unified
  // /options contract — the server stamps the epoch prefix; an empty submit
  // clears the note ("" maps to unset server-side). The change surfaces on
  // the next SSE frame (the POST handler wakes the hub).
  const handleNoteSubmit = useCallback(
    (note: string) => {
      if (!noteTarget) return;
      const { server: srv, windowId } = noteTarget;
      setNoteTarget(null);
      setWindowNote(srv, windowId, note)
        .catch((err: Error) => addToast(err.message || "Failed to set note", "error"));
    },
    [noteTarget, addToast],
  );

  const handleCreateIframeWindow = useCallback(() => {
    const name = finalizeSafeName(iframeWindowName.trim());
    const url = iframeWindowUrl.trim();
    if (!name || !url || !sessionName) return;
    createWindow(server, sessionName, name, undefined, url)
      .catch((err) => addToast(err.message || "Failed to create iframe tab"))
      .finally(() => {
        setShowCreateIframeDialog(false);
        setIframeWindowName("");
        setIframeWindowUrl("");
      });
  }, [iframeWindowName, iframeWindowUrl, sessionName, server, addToast]);

  // Theme
  const { preference: themePreference, resolved: themeResolved, themeDark, themeLight, theme: activeTheme } = useTheme();
  const { setTheme } = useThemeActions();

  const themeMode = themePreference === "system" ? "system" : themeResolved;

  const themeActions: PaletteAction[] = useMemo(() => {
    const options = [
      { mode: "system", label: "System", action: "system" },
      { mode: "light", label: "Light", action: themeLight },
      { mode: "dark", label: "Dark", action: themeDark },
    ];
    return [
      {
        id: "theme-select",
        label: "Theme: Select Theme",
        onSelect: () => document.dispatchEvent(new CustomEvent("theme-selector:open")),
      },
      ...options.map((opt) => ({
        id: `theme-${opt.mode}`,
        label: `Theme: ${opt.label}${themeMode === opt.mode ? " (current)" : ""}`,
        onSelect: () => setTheme(opt.action),
      })),
    ] satisfies PaletteAction[];
  }, [themeMode, themeDark, themeLight, setTheme]);

  // Server management. The switch resolves a landing window for the target
  // server (remembered → derived from the effective session order) instead of
  // always dropping on the session-tiles overview; bare `/$server` stays the
  // fallback when the resolver finds nothing. Push history (no `replace`) —
  // user-initiated switches are retraced by the top-bar ◀ ▶ arrows.
  const handleSwitchServer = useCallback(
    (name: string) => {
      if (name !== server) {
        const targetSessions = ctx.sessionsByServer.get(name) ?? [];
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
            // Clear any carried-over layout param so the target window
            // resolves its OWN layout, not the outgoing window's.
            search: {},
          });
        } else {
          navigate({ to: "/$server", params: { server: name } });
        }
      }
    },
    [server, navigate, ctx.sessionsByServer, ctx.sessionOrderByServer],
  );

  // The create/kill server flows (useOptimisticAction wrappers, pending/killed
  // markers, post-create/kill navigation) live in the layout-mounted
  // `ServerDialogs` component now (260811-239r) — this shell only triggers
  // them via `openCreateServer`/`requestKillServer` from the context above.

  // File upload ref for palette
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Effective session order for the current server: SSE order (@rk_srv_session_order)
  // filtered to live session names, with any un-ordered live sessions appended
  // in natural order — the "SSE order ?? natural" derivation (the sidebar's
  // transient drag override is component-local and not visible here). Drives the
  // Session: Move up/down gating (boundary = hidden, no wraparound).
  const effectiveSessionOrder = useMemo(
    () =>
      deriveEffectiveSessionOrder(
        sessions.map((s) => s.name),
        ctx.sessionOrderByServer.get(server) ?? [],
      ),
    [sessions, ctx.sessionOrderByServer, server],
  );

  const currentSessionOrderIdx = sessionName
    ? effectiveSessionOrder.indexOf(sessionName)
    : -1;

  const moveCurrentSession = useCallback(
    (delta: -1 | 1) => {
      if (!sessionName) return;
      const next = computeMoveOrder(effectiveSessionOrder, currentSessionOrderIdx, delta);
      if (!next) return; // boundary / invalid index: no-op
      setSessionOrder(server, next).catch((err) =>
        addToast(err.message || "Failed to move session"),
      );
    },
    [sessionName, currentSessionOrderIdx, effectiveSessionOrder, server, addToast],
  );

  const sessionActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "create-session",
        label: "Session: Create",
        description: "a new group of tabs",
        onSelect: handleOpenSessionNamePrompt,
      },
      ...(sessionName
        ? [
            {
              id: "session-set-color",
              label: "Session: Set Color",
              onSelect: () => setShowColorPicker("session"),
            },
            {
              id: "rename-session",
              label: "Session: Rename",
              onSelect: () => {
                if (sessionName) {
                  dialogs.openRenameSessionDialog(sessionName);
                }
              },
            },
            // Move up/down within the effective session order (boundary =
            // hidden, no wraparound). Persisted via the existing setSessionOrder
            // (@rk_srv_session_order), the same primitive the sidebar drag uses.
            ...(currentSessionOrderIdx > 0
              ? [
                  {
                    id: "session-move-up",
                    label: "Session: Move up",
                    onSelect: () => moveCurrentSession(-1),
                  },
                ]
              : []),
            ...(currentSessionOrderIdx >= 0 &&
            currentSessionOrderIdx < effectiveSessionOrder.length - 1
              ? [
                  {
                    id: "session-move-down",
                    label: "Session: Move down",
                    onSelect: () => moveCurrentSession(1),
                  },
                ]
              : []),
            {
              id: "kill-session",
              label: "Session: Kill",
              onSelect: dialogs.openKillSessionConfirm,
            },
            // Sort windows by an ordered list of deterministic keys (status
            // pyramid rank, creation order, name) picked via the palette's
            // option-picker sub-step — one-shot, never a standing auto-sort.
            // No success toast: the reorder shows via the SSE derive tick.
            ...buildSessionSortActions(sessionName, (by: SortWindowsBy[]) => {
              sortSessionWindows(server, sessionName, by).catch((err: Error) =>
                addToast(err.message || "Failed to sort windows", "error"),
              );
            }),
          ]
        : []),
    ],
    [sessionName, dialogs, handleOpenSessionNamePrompt, currentSessionOrderIdx, effectiveSessionOrder, moveCurrentSession, server, addToast],
  );

  // Compute min/max window indices for current session (for move boundary checks)
  const { minWindowIndex, maxWindowIndex } = useMemo(() => {
    if (!currentSession || currentSession.windows.length === 0) {
      return { minWindowIndex: 0, maxWindowIndex: 0 };
    }
    const indices = currentSession.windows.map((w) => w.index);
    return { minWindowIndex: Math.min(...indices), maxWindowIndex: Math.max(...indices) };
  }, [currentSession]);

  // Palette copy entry builder — palette parity for the status bar's copy
  // segments (Constitution V: the palette is the complete action registry).
  // Same RAW values as the strip/Pane panel; toast feedback because the
  // palette closes on select, so inline `copied ✓` feedback cannot show.
  const copyPaletteEntry = useCallback(
    (id: string, label: string, what: string, value: string): PaletteAction => ({
      id,
      label,
      onSelect: () => {
        void copyToClipboard(value).then((ok) => {
          addToast(ok ? `${what} copied` : "Copy failed", ok ? "info" : "error");
        });
      },
    }),
    [addToast],
  );

  const windowActions: PaletteAction[] = useMemo(
    () => [
      ...(sessionName
        ? [
            {
              id: "create-window",
              label: "Tab: Create",
              onSelect: () => {
                if (sessionName) handleCreateWindow(sessionName);
              },
            },
            {
              id: "create-window-at-folder",
              label: "Tab: Create at Folder",
              onSelect: () => setShowCreateWindowAtFolderDialog(true),
            },
            {
              id: "create-iframe-window",
              label: "Tab: New Iframe Tab",
              onSelect: () => {
                setIframeWindowName("");
                setIframeWindowUrl("");
                setShowCreateIframeDialog(true);
              },
            },
          ]
        : []),
      ...(currentWindow
        ? [
            {
              id: "window-set-color",
              label: "Tab: Set Color",
              onSelect: () => setShowColorPicker("window"),
            },
            ...buildTabPickerActions(server, currentWindow.windowId),
            // Operator mark/unmark pair (260813-ifya) — the manual fallback for
            // the `@rk_win_role=operator` window option: Mark is listed when the
            // current window is NOT the operator, Unmark when it IS. Both POST
            // through the unified /options contract (`setWindowRole`); the
            // write wakes the SSE hub, so the sidebar's pinned row moves on
            // the next snapshot (no client refresh/poll needed).
            ...(currentWindow.role === "operator"
              ? [
                  {
                    id: "window-unmark-operator",
                    label: "Tab: Unmark Operator",
                    onSelect: () => {
                      setWindowRole(server, currentWindow.windowId, null).catch((err) =>
                        addToast(err.message || "Failed to unmark operator"),
                      );
                    },
                  },
                ]
              : [
                  {
                    id: "window-mark-operator",
                    label: "Tab: Mark as Operator",
                    onSelect: () => {
                      setWindowRole(server, currentWindow.windowId, "operator").catch((err) =>
                        addToast(err.message || "Failed to mark tab as operator"),
                      );
                    },
                  },
                ]),
            // NOTE: the old `toggle-iframe-terminal` action (which mutated
            // `@rk_win_lens`) was REPLACED by the `View: Terminal` / `View: Web`
            // actions in `viewActions` (260714-t97o-web-view-lens) — switching a
            // lens is per-viewer view state, never a `@rk_win_lens` mutation.
            // Move up/down — the sole window-move pair (up/down vocabulary
            // parity with the Session/Server/Board Move entries; windows render
            // as vertical sidebar rows). Boundary = hidden, no wraparound.
            ...(currentWindow.index > minWindowIndex
              ? [
                  {
                    id: "window-move-up",
                    label: "Tab: Move up",
                    onSelect: () => {
                      const targetIndex = computeWindowMoveTarget(currentWindow.index, -1, minWindowIndex, maxWindowIndex);
                      if (sessionName && targetIndex !== null) {
                        moveWindow(server, currentWindow.windowId, targetIndex)
                          .then(() => {
                            navigate({
                              to: "/$server/$window",
                              params: { server, window: currentWindow.windowId },
                              // Same-window move (index only): preserve the
                              // current view (260714-r7rq).
                              search: (prev) => prev,
                            });
                          })
                          .catch((err) => addToast(err.message || "Failed to move tab"));
                      }
                    },
                  },
                ]
              : []),
            ...(currentWindow.index < maxWindowIndex
              ? [
                  {
                    id: "window-move-down",
                    label: "Tab: Move down",
                    onSelect: () => {
                      const targetIndex = computeWindowMoveTarget(currentWindow.index, 1, minWindowIndex, maxWindowIndex);
                      if (sessionName && targetIndex !== null) {
                        moveWindow(server, currentWindow.windowId, targetIndex)
                          .then(() => {
                            navigate({
                              to: "/$server/$window",
                              params: { server, window: currentWindow.windowId },
                              // Same-window move (index only): preserve the
                              // current view (260714-r7rq).
                              search: (prev) => prev,
                            });
                          })
                          .catch((err) => addToast(err.message || "Failed to move tab"));
                      }
                    },
                  },
                ]
              : []),
            ...(sessions.length >= 2
              ? sessions
                  .filter((s) => s.name !== sessionName)
                  .map((s) => ({
                    id: `move-window-to-session-${s.name}`,
                    label: `Tab: Move to ${s.name}`,
                    onSelect: () => {
                      if (sessionName) {
                        moveWindowToSession(server, currentWindow.windowId, s.name)
                          .then(() => {
                            navigate({ to: "/$server", params: { server } });
                          })
                          .catch((err) => {
                            addToast(err.message || "Failed to move tab to session");
                          });
                      }
                    },
                  }))
              : []),
            {
              id: "rename-window",
              label: "Tab: Rename",
              onSelect: () => {
                // Rewired (260703-5ilm) to trigger the centered heading's inline
                // edit via a CustomEvent (mirrors `theme-selector:open`), rather
                // than opening the old modal rename dialog. The heading owns the
                // rename surface now — one place, direct manipulation.
                if (currentWindow) {
                  document.dispatchEvent(new CustomEvent("window-heading:rename"));
                }
              },
            },
            // Set note (260824-bb5n) — the user write affordance for the
            // @rk_win_note one-line status note: a prompt pre-filled with the
            // current note; an empty submit clears it.
            {
              id: "window-set-note",
              label: "Window: Set note…",
              onSelect: () => {
                setNoteTarget({ server, windowId: currentWindow.windowId, note: currentWindow.note ?? "" });
              },
            },
            // Fix tab name (260822-fih1) — the palette arm of the operator
            // actuation seam, gated by the SAME server-derived capability rule
            // as the flyout row (canRequestWindowOperatorAction —
            // omit-not-disable): an operator on the server, the subject's
            // identity resolving to a readable conversation, and the subject
            // not being the operator itself.
            ...(canRequestWindowOperatorAction(currentWindow, hasOperatorWindow)
              ? [
                  {
                    id: "window-fix-name-operator",
                    label: "Tab: Fix name (ask operator)",
                    onSelect: () => {
                      void handleFixTabName(server, currentWindow.windowId);
                    },
                  },
                  // Annotate tab (260824-bb5n) — the palette arm of the
                  // annotate-tab operator template, gated by the SAME
                  // availability triple as fix-name.
                  {
                    id: "window-annotate-operator",
                    label: "Operator: Annotate tab",
                    onSelect: () => {
                      void handleAnnotateTab(server, currentWindow.windowId);
                    },
                  },
                ]
              : []),
            {
              id: "kill-window",
              label: "Tab: Kill",
              onSelect: dialogs.openKillConfirm,
            },
            // Split direction booleans match the top-bar chip's semantics
            // (260806-2x2h): Horizontal → `horizontal: true` (tmux `-h`,
            // side-by-side), Vertical → `false` (stacked). Horizontal listed
            // first (default-first, mirroring the SplitControl menus).
            {
              id: "split-horizontal",
              label: "Tab: Split Horizontal",
              onSelect: () => {
                if (sessionName) executeSplit(server, currentWindow.windowId, true, currentWindow.worktreePath);
              },
            },
            {
              id: "split-vertical",
              label: "Tab: Split Vertical",
              onSelect: () => {
                if (sessionName) executeSplit(server, currentWindow.windowId, false, currentWindow.worktreePath);
              },
            },
            {
              id: "close-pane",
              label: "Pane: Close",
              onSelect: () => {
                if (sessionName) executeClosePane(server, currentWindow.windowId);
              },
            },
            {
              id: "copy-tmux-attach",
              label: "Copy: tmux Commands",
              onSelect: () => setShowTmuxCommands(true),
            },
            // The window-register copy segments' palette arms, each gated on
            // its raw value's presence (omit-not-disable). cwd matches the
            // status bar's ACTIVE-pane rule (`activePane.cwd ?? worktreePath`),
            // not activePaneCwd's first-pane fallback.
            ...(() => {
              const pane = currentWindow.panes?.find((p) => p.isActive);
              const fabId = parseFabChange(currentWindow.fabChange ?? "")?.id;
              const cwdValue = pane?.cwd ?? currentWindow.worktreePath;
              return [
                ...(pane?.gitBranch
                  ? [copyPaletteEntry("copy-git-branch", "Copy: Git Branch", "Git branch", pane.gitBranch)]
                  : []),
                ...(cwdValue
                  ? [copyPaletteEntry("copy-cwd-path", "Copy: Working Directory", "Working directory", cwdValue)]
                  : []),
                ...(pane?.paneId
                  ? [copyPaletteEntry("copy-pane-id", "Copy: tmux Pane Id", "Pane id", pane.paneId)]
                  : []),
                ...(fabId
                  ? [copyPaletteEntry("copy-fab-change-id", "Copy: Fab Change Id", "Fab change id", fabId)]
                  : []),
              ];
            })(),
          ]
        : []),
    ],
    [sessionName, currentWindow, sessions, hasOperatorWindow, handleCreateWindow, handleFixTabName, handleAnnotateTab, dialogs, executeSplit, executeClosePane, minWindowIndex, maxWindowIndex, navigate, server, addToast, setShowCreateWindowAtFolderDialog, copyPaletteEntry],
  );

  // Boards palette block (server-route variant). AppShell only mounts under
  // `/$server/...`, so the board-route-only entries (Leave Board View, Cycle
  // Pane Focus) live in BoardPage's own registered route list. Here we provide
  // the entries that make sense from a server route: Switch to <board>, Pin
  // Current Tab, and Unpin Current Tab when the current window is
  // pinned.
  const { boards: boardSummaries } = useBoards();
  const { pinnedToBoard } = useWindowPins();
  const { pin: pinPinAction, unpin: unpinPinAction } = usePinActions();

  // Boards the current window is currently pinned to (for Unpin Current Tab
  // visibility + bulk-unpin behavior). Recomputed when the cross-board pin map
  // updates via SSE.
  const currentWindowPinnedBoards = useMemo(() => {
    if (!currentWindow || !server) return [] as string[];
    return boardSummaries
      .map((b) => b.name)
      .filter((b) => pinnedToBoard(b, server, currentWindow.windowId));
  }, [boardSummaries, pinnedToBoard, currentWindow, server]);

  const boardActions: PaletteAction[] = useMemo(() => {
    // No `currentBoardName` here — AppShell isn't on a board route, so no
    // entry is ever annotated `(current)` from this route's list.
    const switchEntries = boardSummaries.map((b) => ({
      id: `board-switch-${b.name}`,
      label: `Board: Switch to ${b.name}`,
      onSelect: () => navigate({ to: "/board/$name", params: { name: b.name } }),
    }));

    const conditional: PaletteAction[] = [];

    if (sessionName && currentWindow && server) {
      const win = currentWindow;
      const srv = server;
      // Direct-pin palette actions (`Pin: Current Tab to <board>`) + the
      // `Pin: Current Tab to new board…` variant, from the pure
      // buildPinActions builder (lib/palette/pin.ts). These close the
      // Constitution V keyboard-first gap: a direct pin is Cmd+K → type →
      // Enter, with the §2c success toast as feedback. They SUPERSEDE the old
      // inline `board-pin-current` opener — its popover-opening role is now the
      // new-board variant. The new-board variant reuses the existing
      // `pin-popover:open` CustomEvent (only the WindowRow whose
      // (server, windowId) matches handles it) since free-text entry needs the
      // popover (the palette has no value input).
      conditional.push(
        ...buildPinActions(
          boardSummaries,
          currentWindowPinnedBoards,
          readLastPinnedBoard(),
          (board) => pinPinAction(srv, win.windowId, board),
          () =>
            document.dispatchEvent(
              new CustomEvent("pin-popover:open", {
                detail: { server: srv, windowId: win.windowId },
              }),
            ),
        ),
      );

      // Unpin Current Tab — visible only when the current window is pinned
      // to ≥1 board. v1 semantics: unpin from ALL boards in parallel (simpler
      // than a multi-board picker; users can re-pin via the popover if needed).
      if (currentWindowPinnedBoards.length > 0) {
        conditional.push({
          id: "board-unpin-current",
          label: "Board: Unpin Current Tab",
          onSelect: () => {
            for (const board of currentWindowPinnedBoards) {
              unpinPinAction(srv, win.windowId, board);
            }
          },
        });
      }
    }
    return [...switchEntries, ...conditional];
  }, [boardSummaries, sessionName, currentWindow, server, navigate, currentWindowPinnedBoards, pinPinAction, unpinPinAction]);

  // ── Sidebar window-row multi-select (260807-nf9f) ─────────────────────────
  // The palette is the SOLE action surface for the selection (Constitution IV
  // minimal surface + V ⌘K-primary), so both the merged sweep and the bulk move
  // live here. The sidebar owns the selection GESTURES (cmd/ctrl-click toggle,
  // shift-click range, `x` toggle on the focused row, Escape to clear) and
  // shares the state through `store/selection-store.ts`.
  //
  // Per the project review rule, the new `x` shortcut is DOCUMENTED at this
  // registration seam — not merely in this comment: `SELECTION_GESTURE_HINT`
  // rides the select-all entry's `shortcut` field, which the palette renders as
  // a `<kbd>` badge (see lib/palette/selection.ts). It is deliberately absent
  // from `DEFAULT_BINDINGS`, which is a modifier-chord registry driving a
  // window-level dispatcher — a bare `x` there would hijack the key app-wide
  // rather than inside the focused tree.
  const selectedWindows = useSelectionStore((s) => s.selected);
  const selectOnlySelection = useSelectionStore((s) => s.selectOnly);
  const settleBatchSelection = useSelectionStore((s) => s.settleBatch);
  // A prompt target is a FROZEN snapshot captured when its palette action is
  // selected. It remains aligned with the visible `N selected` label and the
  // eventual settleBatch keys even if the live selection changes while typing.
  const [selectionBroadcastKeys, setSelectionBroadcastKeys] = useState<
    string[] | null
  >(null);

  // Toggling the global strip off cancels selection-target mode. Per-window
  // drafts remain in their module store; only this transient recipient snapshot
  // is cleared.
  useEffect(() => {
    if (!composeStripEnabled && selectionBroadcastKeys !== null) {
      setSelectionBroadcastKeys(null);
    }
  }, [composeStripEnabled, selectionBroadcastKeys]);

  /**
   * Bulk move: N SEQUENTIAL `move-to-session` POSTs against the existing
   * endpoint (no new backend surface, no bulk optimistic machinery — rows
   * repaint from SSE). Continue-on-error: an independent per-window failure
   * must not strand the rest of the batch. On full success the batch's windows
   * are dropped from the selection; on partial (or total) failure exactly its
   * failed windows stay selected as the retry affordance, and one aggregate
   * toast reports the counts plus the first error message.
   *
   * The palette closes before this runs and the batch is fire-and-forget, so a
   * long batch races the user: they can start a WHOLE NEW selection while it is
   * still POSTing. The terminal update therefore RECONCILES against the keys
   * this batch actually owned (`settleBatch`) rather than clobbering the store
   * with `clear()` / `selectOnly(failedKeys)` — those act on whatever the store
   * holds at settle time and would silently destroy the user's new selection.
   * Reconciling (rather than an in-flight lock refusing the second batch) is
   * also the friendlier semantics: two batches over disjoint windows both settle
   * correctly, each touching only its own keys.
   */
  const executeBulkMove = useCallback(
    async (srv: string, keys: string[], targetSession: string) => {
      // Move stays SINGLE-SERVER gated (`singleSelectedServer` omits the
      // entries otherwise), so it deliberately ignores the per-key server and
      // moves every window on `srv` — only the control flow is shared.
      const result = await executeSelectionBatch(keys, ({ windowId }) =>
        moveWindowToSession(srv, windowId, targetSession),
      );
      const { message, failed } = batchToast(
        {
          success: "Moved",
          failure: "Moved",
          noun: "tab",
          qualifier: ` to ${targetSession}`,
        },
        keys.length,
        result,
      );
      addToast(message, failed ? "error" : undefined);
      settleBatchSelection(keys, result.failedKeys);
    },
    [addToast, settleBatchSelection],
  );

  /** Close each selected window on its own server, sequentially. */
  const executeBulkClose = useCallback(
    async (keys: string[]) => {
      const result = await executeSelectionBatch(
        keys,
        ({ server: targetServer, windowId }) =>
          // Each kill's record goes onto ITS server's mirror (a cross-server
          // selection is legal for close) so the palette entry lights up
          // without a refetch.
          killWindow(targetServer, windowId).then((res) => {
            if (res.closed) pushRecentlyClosed(targetServer, res.closed);
          }),
      );
      const { message, failed } = batchToast(
        { success: "Closed", failure: "Closed", noun: "tab" },
        keys.length,
        result,
      );
      addToast(message, failed ? "error" : undefined);
      settleBatchSelection(keys, result.failedKeys);
    },
    [addToast, settleBatchSelection],
  );

  /**
   * Submit one prompt through the window-send endpoint (submit mode, agent-pane
   * target) per recipient — a window with no agent pane fails closed (404) and
   * counts as that window's failure. Resolves with the DELIVERED count so the
   * compose strip can retain a prompt that reached nobody (0 of N) instead of
   * clearing text no agent ever saw.
   */
  const executeBulkSend = useCallback(
    async (keys: string[], text: string): Promise<number> => {
      const result = await executeSelectionBatch(
        keys,
        ({ server: targetServer, windowId }) =>
          sendToWindow(targetServer, windowId, text, "submit", "agent"),
      );
      const { message, failed } = batchToast(
        { success: "Sent prompt to", failure: "Sent to", noun: "agent" },
        keys.length,
        result,
      );
      addToast(message, failed ? "error" : undefined);
      settleBatchSelection(keys, result.failedKeys);
      return keys.length - result.failedKeys.length;
    },
    [addToast, settleBatchSelection],
  );

  const selectionActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = [];
    // `Selection: Select all merged (N)` — current-server-scoped (a cross-server
    // selection would dead-end the single-server bulk move below). Omitted, not
    // disabled, when there is no server context or nothing merged.
    const selectAllMerged = buildSelectAllMergedAction(
      server || null,
      sessions,
      selectOnlySelection,
    );
    if (selectAllMerged) actions.push(selectAllMerged);

    // Close/send carry their own server on every selected key, so unlike move
    // they remain eligible for a cross-server selection.
    const closeSelection = buildSelectionCloseAction(
      selectedWindows,
      (keys) => {
        void executeBulkClose(keys);
      },
    );
    if (closeSelection) actions.push(closeSelection);

    const sendPrompt = buildSelectionSendPromptAction(
      selectedWindows,
      (keys) => {
        setSelectionBroadcastKeys(keys);
        if (composeStripEnabled) {
          // The strip is already mounted; focus after React swaps its disabled
          // focused-terminal target for the selection target.
          queueMicrotask(() => focusComposeStrip());
        } else {
          // The normal off→on path marks focus-on-open for the mounting strip.
          toggleComposeStrip();
        }
      },
    );
    if (sendPrompt) actions.push(sendPrompt);

    // `Selection: Move N window(s) to <session>` — one entry per eligible
    // session on the SELECTION's server, which is NOT necessarily the route
    // server: with sessions scope "all" the sidebar paints every server's
    // groups, so a user can select rows on server A while routed to server B.
    // tmux window ids (`@N`) are unique per server only, so feeding the route
    // server's sessions here would list the wrong targets AND move the wrong
    // windows. `singleSelectedServer` is the single source of the server for
    // both the target list and the POSTs below; it returns `null` for an empty
    // or cross-server selection, which omits the entries entirely (tmux cannot
    // move a window across tmux servers).
    const selectionServer = singleSelectedServer(selectedWindows);
    if (selectionServer !== null) {
      // Prefer the merged list when the selection is on the route server (it
      // carries the ghost/rename overlays the sidebar paints); otherwise read
      // that server's raw SSE sessions. `undefined` means the server's sessions
      // have not loaded — offer no targets rather than guessing an empty list,
      // which would render every session as "eligible" against no data.
      const selectionSessions =
        selectionServer === server ? sessions : ctx.sessionsByServer.get(selectionServer);
      if (selectionSessions !== undefined) {
        actions.push(
          ...buildSelectionMoveActions(
            selectionServer,
            selectionSessions,
            selectedWindows,
            (targetSession) => {
              void executeBulkMove(selectionServer, [...selectedWindows], targetSession);
            },
          ),
        );
      }
    }
    return actions;
  }, [
    server,
    sessions,
    ctx.sessionsByServer,
    selectedWindows,
    selectOnlySelection,
    executeBulkMove,
    executeBulkClose,
    composeStripEnabled,
    toggleComposeStrip,
  ]);

  // Compose-strip dock selection (260813-j3jb): exactly ONE dock renders the
  // strip. The IN-TILE dock (the first tty tile's flex column, via
  // SurfaceLayout's `ttyDockContent` slot) hosts the desktop terminal route's
  // single-send mode — the tile frame makes the target self-evident. The
  // FOOTER dock keeps everything a tile cannot host: selection broadcast (a
  // shell-level, cross-window concern — the dock split IS the mode signal),
  // mobile (no tile chrome), the server route, and no-tty layouts (e.g.
  // single:code). One shared element serves both docks: one component, one
  // module draft store, so a dock flip (broadcast on/off, layout gaining or
  // losing its tty tile) loses no draft.
  // The compose SURFACE mounts on every Shell route: the preference no longer
  // decides whether it mounts, only which form the strip module renders —
  // the expanded strip or the one-row collapsed tongue that keeps the show
  // affordance in place. The seam keeps its name so a future route-level
  // gate has one place to hang off.
  const composeStripVisible = true;
  // The operator page keeps its input in the footer dock even under a
  // non-terminal tab (the in-tile dock would hide with the terminal column),
  // so `operatorPage` is excluded from the in-tile predicate. The dock is a
  // property of the route/layout, never of the preference — the tongue lives
  // at the same dock the expanded strip would. The popout posture is
  // chrome-less: no compose strip at all (no in-tile dock, and the Shell
  // bottombar slot renders null below).
  const inTileDock =
    !popoutPosture &&
    !operatorPage &&
    !isMobile &&
    !!windowParam &&
    !selectionBroadcastKeys &&
    leaves(renderLayout).includes("tty");
  const composeStripElement = (
    <ComposeStrip
      // The operator page's footer input is forced on regardless of the
      // preference (and stays the expanded body even target-less under a
      // non-terminal tab); only this shared element ever passes it.
      forceExpanded={operatorPage}
      // Escape's hand-off target: the route's registered terminal focuser.
      onEscapeToTerminal={() => focusTerminalRef.current?.()}
      // Dock identity: the strip's fine-pointer header fold keys on this —
      // in-tile the tile frame already names the target. One shared element
      // serves both docks, so the prop simply tracks the dock predicate.
      dockedInTile={inTileDock}
      // Focus-memory write gate: the terminal route's tile-window identity.
      // The strip records `compose` only when its live target IS the focused
      // tile's window — a foreign tty tile's home window counts (the focused
      // terminal registers with it), so composing into a borrowed terminal
      // records under the tile's own window key. The focused-terminal context
      // lags a window switch by a commit, and a restore-driven focus in that
      // gap would otherwise cross-write the previous window's key.
      focusMemoryWindow={
        focusedTileWindowId ? { server, windowId: focusedTileWindowId } : undefined
      }
      selectionTarget={
        selectionBroadcastKeys
          ? {
              keys: selectionBroadcastKeys,
              onSend: async (text) => {
                const delivered = await executeBulkSend(
                  selectionBroadcastKeys,
                  text,
                );
                // A total failure keeps the frozen target so the retained
                // draft stays visible (it is keyed to this recipient set)
                // and the retry needs neither retyping nor reselecting.
                if (delivered > 0) setSelectionBroadcastKeys(null);
                return delivered;
              },
            }
          : null
      }
    />
  );

  // Derived boolean (not `currentWindow` itself) so the memo below doesn't
  // recompute on every SSE-driven window-object identity change.
  const currentAltScreen = currentWindow?.altScreen === true;

  const viewActions: PaletteAction[] = useMemo(
    () => [
      ...(sessionName
        ? [
            {
              id: "text-input",
              label: "Compose: Toggle",
              onSelect: toggleComposeStrip,
            },
            {
              // The show+focus arm of the stateful compose chord (R6): strip
              // off → toggle on (the off→on transition focuses the textarea
              // on mount); strip on → focus through the registry seam (a
              // decline — the disabled no-target state — is a no-op here;
              // the never-dead-press fallback is the chord's contract, not
              // the palette verb's). No shortcut hint: the id is not the
              // `compose-toggle` actionId.
              id: "compose-focus",
              label: "Compose: Focus",
              onSelect: () => {
                if (!composeStripEnabled) {
                  toggleComposeStrip();
                  return;
                }
                focusComposeStrip();
              },
            },
            // Recall operates on the mounted strip's live target and history,
            // so it is absent while the strip is disabled. Compose: Focus owns
            // the separate show-the-strip verb; a live opener decline is an
            // expected silent no-op when the target or history disappears.
            ...(composeStripEnabled
              ? [
                  {
                    id: "compose-recall",
                    label: "Compose: Recall sent…",
                    onSelect: () => {
                      openComposeRecall();
                    },
                  },
                ]
              : []),
          ]
        : []),
      // Window-view lens actions (spec R4, Constitution V palette parity — the
      // palette is the ONLY lens-switch surface since the ViewSwitcher's
      // retirement, 260812-0c6o). Each lens is offered
      // only when it is AVAILABLE for the current window AND is not the current
      // view — so the palette shows the destination, never the current lens. No
      // entry carries a shortcut hint: no chord reaches a single-tile lens
      // switch (the ⌘1/⌘2/⌘3 digits are three-state TILE toggles, a different
      // action, and hinting them here would misdescribe it). These REPLACE the
      // retired
      // `toggle-iframe-terminal` action, which mutated `@rk_win_lens`; switching a
      // lens now never touches the window's identity. The gating (available AND
      // not-current) + label composition live in the pure `buildViewActions`
      // (lib/palette/view.ts) so they are unit-testable without mounting the
      // shell. MOBILE supersedes them: a phone doesn't need collapse-to-single
      // `View:` semantics — the palette instead lists the top-bar switch
      // group's twin (`Tile: Switch to <Surface>`, Constitution V parity) via
      // the pure `buildTileSwitchActions` (the switch-to-tile verb).
      ...(isMobile
        ? windowParam
          ? buildTileSwitchActions(panelSurfaces, mobileActiveTile, switchToTile, switchTargetDisabled)
          : []
        : buildViewActions(currentViews, resolvedView, switchView)),
      // Layout entries — Constitution V palette parity
      // for the surface toggles, tile verbs, and ▦ chip: `Tile: Show/Hide
      // <Surface>` (the top-bar toggle group's actions), `Layout: Expand`/`Restore` (the
      // transient focused-leaf zoom), `Layout: Promote <Surface>` (swap with
      // slot A), template jumps for the current tile count, `Layout: Cycle
      // Template` (the `layout-cycle` chord's body — its id IS the registry
      // actionId, so `withShortcutHints` decorates it with the effective ⌘;
      // combo), and the directional `Tile: Swap …` rows for the focused leaf
      // (desktop multi-tile only — the swap needs the leaves' real rects from
      // the layoutRects seam). These REPLACE the retired `Panel: Web`/`Panel:
      // Code` entries — the layout model subsumes the panel. The gating +
      // labels live in the pure `buildLayoutActions` (lib/palette/layout.ts),
      // the `buildViewActions` precedent. The `code-toggle` chord (⌘2 /
      // ⇧Ctrl+2) is documented via the code surface's Show/Hide entry hint
      // (the `toggleTarget`/`toggleShortcut` seam; enabled-else-undefined).
      ...(windowParam
        ? buildLayoutActions(layout, panelSurfaces, {
            zoomed: layoutZoomed,
            zoomEnabled: !isMobile && leaves(layout).length > 1,
            onApply: applyLayout,
            // Show/Hide delegate to the guarded shared toggle: a popped
            // close target reveals/hides the popped placeholder instead of
            // writing the shared layout.
            onToggleSurface: togglePanel,
            onZoomToggle: () => layoutZoomToggleRef.current?.(),
            // Template jumps + the cycle chord body (⌘;).
            onApplyTemplate: (name: TemplateName) => {
              const next = applyTemplate(layout, name);
              if (next) applyLayout(next);
            },
            onCycleTemplate: () => {
              const next = cycleTemplate(layout);
              if (next !== layout) applyLayout(next);
            },
            // The tile verbs' palette twins, by leaf id.
            onPromoteLeaf: (leafId: string) => {
              const next = promote(layout, leafId);
              if (next !== layout) applyLayout(next);
            },
            // Directional swap of the FOCUSED leaf with its geometric
            // neighbour, resolved against the leaves' live rects.
            onSwapDirection: (direction: SwapDirection) => {
              if (!focusedLeafId) return;
              const next = swapDirectional(
                layout,
                focusedLeafId,
                direction,
                layoutRectsRef.current?.() ?? undefined,
              );
              if (next !== layout) applyLayout(next);
            },
            focusedLeafId,
            leafRects:
              !isMobile && leaves(layout).length > 1
                ? () => layoutRectsRef.current?.() ?? new Map<string, Rect>()
                : undefined,
            // The viewer's stored divider sizes for the current structure —
            // the Show/Bring floor check estimates candidate rects from them.
            layoutSizes: windowParam
              ? () => readStoredSizes(server, windowParam, layout)
              : undefined,
            // `Tile: Focus <Surface>` (260812-wfic R10) — keyboard parity
            // for click-to-focus; desktop only (mobile's switcher is the
            // top-bar switch group), routed through SurfaceLayout's focus seam.
            focusedKind: focusedTileKind,
            onFocus: !isMobile
              ? (kind: SurfaceKind) => layoutFocusTileRef.current?.(kind)
              : undefined,
            toggleTarget: panelSurfaces.includes("code") ? "code" : null,
            toggleShortcut: (() => {
              const b = bindingByAction.get("code-toggle");
              return b?.enabled ? formatCombo(b, bindingHost.platform) : "";
            })(),
            // ⌘4/⇧Ctrl+4 gui-toggle: the hint rides the registry-inherited
            // `Tile: Show/Hide GUI` rows (the code-toggle seam, generalized).
            toggleHints: {
              gui: (() => {
                const b = bindingByAction.get("gui-toggle");
                return b?.enabled ? formatCombo(b, bindingHost.platform) : "";
              })(),
            },
            // `Tile: Bring … here` / `Tile: Send Back to …` — the borrow and
            // return write seams; the builder gates candidates on the floor.
            bringWindows,
            onBring: borrowInto,
            onSendBack: (leafAddr: string) => {
              if (windowParam) sendHome(windowParam, leafAddr);
            },
            windowNameFor: (windowId: string) => windowsById.get(windowId)?.name,
            // `Tile: Bring Back <Surface>` — the home tab's half of the
            // return verb (the placeholder's bring back, palette form); the
            // write is the same sendHome return.
            awayIn: effectiveWindow?.awayIn,
            routeWindowId: windowParam,
            onBringBack: sendHome,
            // `Tile: Pop Out <Surface>` / `Tile: Pop Back In <Surface>` — the
            // popout verbs (Constitution V parity for the tile header's Pop
            // out button). Pop Out rides the same body as the header verb (no
            // measured rect here → the popup's fallback size); mobile and a
            // shell without the `windows.popout` channel gate at the caller
            // (the shell's window.open policy sends everything to the system
            // browser, which shares neither localStorage nor the
            // BroadcastChannel with the opener — the channel keeps the marks
            // and liveness on the same origin and session). Every mutation
            // above keeps computing from the FULL shared tree while tiles are
            // popped — only this viewer's render is reduced.
            poppedIds: popped,
            revealedIds: revealed,
            onPopOut:
              !isMobile && (!isShell() || canShellPopout())
                ? (leafId: string) => popOut(leafId, layoutRectsRef.current?.().get(leafId))
                : undefined,
            onPopIn: popIn,
          })
        : []),
      // `View: Enter/Exit Zen Mode` (260820-o8cr R7) — the `zen-toggle`
      // chord's palette parity (Constitution V), findable by "zen". Exactly
      // one form renders, keyed on live zen state; any arity on the desktop
      // terminal route (unlike `Layout: Expand`, which stays arity>1-gated).
      // The id is NOT the `zen-toggle` actionId, so the ⇧⌘⏎ hint attaches
      // explicitly (the `toggleShortcut` precedent); the parity invariant's
      // equivalence map documents the pair. The body is the same `toggleZen`
      // seam the chord and the status-bar exit button resolve.
      ...(windowParam && !isMobile
        ? buildZenActions(zenOn, {
            onToggle: toggleZen,
            shortcut: (() => {
              const b = bindingByAction.get("zen-toggle");
              return b?.enabled ? formatCombo(b, bindingHost.platform) : undefined;
            })(),
          })
        : []),
      // `Code: Follow Terminal` / `Code: Reload Editor` — Constitution V
      // palette parity for the code tile's header verbs (the
      // `guiCommandsRef`/`zoomToggleRef` seam pattern): both rows route
      // through `codeCommandsRef`, which SurfaceLayout fills while the active
      // window's code tile is open, so a row and its header button run the
      // same body. Gating mirrors the header: Follow only under drift
      // (`codeRootFollowTarget`), Reload only with a mounted frame
      // (reachable + a resolved src). No chords. Offered on both form
      // factors (mobile renders no tile header).
      ...(windowParam
        ? buildCodeActions({
            codeTileOpen: leaves(layout).includes("code"),
            followTarget: codeRootFollowTarget(effectiveWindow),
            frameMounted: (codeServer?.reachable ?? false) && codeSrc !== null,
            onFollowTerminal: () => codeCommandsRef.current?.followTerminal(),
            onReload: () => codeCommandsRef.current?.reload(),
            // The empty state's Restart button twin — same client call; the
            // outcome surfaces as a toast since the row runs outside the tile.
            unreachable: !(codeServer?.reachable ?? false),
            onRestartServer: () => {
              restartCodeServer()
                .then((r) => {
                  if (r.status === "installing")
                    addToast("installing code-server — the editor appears when the download finishes");
                  else if (r.status === "external")
                    addToast("port already serving an externally managed code-server");
                })
                .catch((err: Error) => addToast(err.message || "code-server restart failed", "error"));
            },
          })
        : []),
      {
        id: "toggle-fixed-width",
        label: fixedWidth ? "View: Full Width" : "View: Fixed Width (900px)",
        onSelect: toggleFixedWidth,
      },
      // `Terminal: Find` — the palette discovery surface for the tty tile's
      // find bar, shown only when the layout includes a tty tile
      // (the `Web: Find in page` gating precedent). The id IS the registry
      // actionId, so `withShortcutHints` renders the effective ⇧Ctrl+F/⌘F
      // combo for free; the body dispatches the `terminal-find:open`
      // CustomEvent the chord's gated handler resolves to — one seam for all
      // three entry points, SurfaceLayout its single receiver.
      ...(windowParam && leaves(layout).includes("tty")
        ? [
            {
              id: "terminal-find",
              label: "Terminal: Find",
              onSelect: () => document.dispatchEvent(new CustomEvent(TERMINAL_FIND_OPEN_EVENT)),
            },
          ]
        : []),
      // `Web: Find in page` (260819-ie2i R4) — the palette discovery surface
      // for the web tile's find bar, shown only when the layout
      // includes an open web tile. The id IS the registry actionId, so
      // `withShortcutHints` renders the effective ⌘F/Ctrl+F combo for free
      // (the code-review shortcut rule); the body dispatches the
      // `web-find:open` CustomEvent the chord's gated handler resolves to —
      // one seam for all entry points. CONTENT-gated on hasWebUrl
      // (260821-zqlq): an onboarding tile has no searchable content, so the
      // entry is absent there (not disabled — the availability idiom).
      ...(windowParam && leaves(layout).includes("web")
        ? [
            // Onboarding gate (260821-zqlq): the web tile is now always
            // open-able, so find is gated on CONTENT (hasWebUrl), not tile
            // presence — an onboarding tile has nothing to search; the ⌘F
            // chord's webGated handler follows the palette's absence and the
            // tile's own `web-find:open` listener double-guards below. The
            // address/external seams stay: the onboarding address bar is
            // fully live.
            ...(hasWebUrl(effectiveWindow)
              ? [
                  {
                    id: "web-find",
                    label: "Web: Find in page",
                    onSelect: () => document.dispatchEvent(new CustomEvent(WEB_FIND_OPEN_EVENT)),
                  },
                  // `Web: Zoom in/out/reset` (260823-cwvv R5) — palette parity
                  // (Constitution V) for the URL-bar zoom control; same
                  // content gate as web-find (an onboarding tile has nothing
                  // to zoom) and the same one-CustomEvent seam shape — the
                  // mounted web tile answers `web-zoom` (detail.direction).
                  // No chord: Cmd/Ctrl+Plus/Minus/0 stay shell-owned (intake
                  // exclusion; gestures cover the muscle-memory path).
                  // `Web: Capture/Release keyboard` — palette parity
                  // (Constitution V) for the URL-bar capture toggle and ⌘⇧G;
                  // the gui row's label-flip vocabulary. Content-gated like
                  // web-find (an onboarding tile has no page to hand keys to).
                  {
                    id: "web-capture-toggle",
                    label: webCapture ? "Web: Release keyboard" : "Web: Capture keyboard",
                    onSelect: () => handleWebCaptureChange(!webCapture),
                  },
                  ...(["in", "out", "reset"] as const).map((direction) => ({
                    id: `web-zoom-${direction}`,
                    label:
                      direction === "in"
                        ? "Web: Zoom in"
                        : direction === "out"
                          ? "Web: Zoom out"
                          : "Web: Reset zoom",
                    onSelect: () =>
                      document.dispatchEvent(new CustomEvent(WEB_ZOOM_EVENT, { detail: { direction } })),
                  })),
                ]
              : []),
            // Web-tab palette actions sit OUTSIDE the content gate: the
            // builder self-gates the verb entries by tab count, and
            // `Web: New tab` must stay reachable on an empty family — it is
            // the palette's draft entry point for the onboarding tile.
            // Mutations reconcile on the next SSE tick; new-tab opens a
            // viewer-local draft.
            ...buildWebTabActions(effectiveWindow?.webTabs ?? [], effectiveWindow?.webActive, {
              onSelectTab: (n) =>
                void selectWebTab(server, windowParam, n).catch((err: Error) =>
                  addToast(err.message || "Failed to select web tab", "error"),
                ),
              onCloseTab: (n) =>
                void removeWebTab(server, windowParam, n).catch((err: Error) =>
                  addToast(err.message || "Failed to close web tab", "error"),
                ),
              onMoveTab: (n, to) =>
                void moveWebTab(server, windowParam, n, to).catch((err: Error) =>
                  addToast(err.message || "Failed to move web tab", "error"),
                ),
            }),
            // `Web: Focus address bar` + `Web: Open in browser` (260819-v6y4
            // R9/R12) — same gating and one-CustomEvent seam shape as
            // web-find; the mounted web tile is each event's single receiver
            // (the tile owns the tracked frame location the ↗ action opens).
            {
              id: "web-address",
              label: "Web: Focus address bar",
              onSelect: () => document.dispatchEvent(new CustomEvent(WEB_ADDRESS_FOCUS_EVENT)),
            },
            {
              id: "web-open-external",
              label: "Web: Open in browser",
              onSelect: () => document.dispatchEvent(new CustomEvent(WEB_OPEN_EXTERNAL_EVENT)),
            },
          ]
        : []),
      // `Terminal: …` export entries (260819-shqo R9) — palette twins of the
      // tty tile header's ⇩ menu rows, shown only when the layout
      // includes a tty tile (mobile relies on these: the header is
      // desktop-only). Each dispatches the one `terminal-export` CustomEvent
      // seam (`detail.action`); the mounted SurfaceLayout export cluster is
      // the single receiver (the `web-find:open` precedent — one terminal
      // route mount). No shortcut hints — no bindings exist (intake: menu +
      // palette only).
      ...(windowParam && leaves(layout).includes("tty")
        ? (
            [
              ["terminal-export-snapshot", "Terminal: Download snapshot (HTML)", "snapshot"],
              ["terminal-export-transcript", "Terminal: Download transcript", "transcript"],
              ["terminal-export-copy", "Terminal: Copy visible screen", "copy-visible"],
              // Gated ABSENT (not disabled — the availability idiom) on an
              // alt-screen window: tmux holds no scrollback there, so the
              // server capture is structurally empty (260820-4le0).
              ...(currentAltScreen
                ? []
                : [["terminal-export-history", "Terminal: Download full history", "history"] as const]),
            ] as const
          ).map(([id, label, action]) => ({
            id,
            label,
            onSelect: () =>
              document.dispatchEvent(new CustomEvent(EXPORT_EVENT, { detail: { action } })),
          }))
        : []),
    ],
    [sessionName, fixedWidth, toggleFixedWidth, toggleComposeStrip, composeStripEnabled, currentViews, resolvedView, switchView, bindingByAction, bindingHost, windowParam, isMobile, layout, panelSurfaces, applyLayout, togglePanel, layoutZoomed, focusedTileKind, focusedLeafId, mobileActiveTile, switchToTile, switchTargetDisabled, currentAltScreen, zenOn, toggleZen, server, effectiveWindow, addToast, codeServer, codeSrc, bringWindows, borrowInto, sendHome, windowsById, popped, revealed, popOut, popIn, webCapture, handleWebCaptureChange],
  );

  // Navigation actions (`Go: Back` / `Go: Forward` / ancestor entries,
  // 260714-uco1) moved to the layout-level global palette groups
  // (260811-239r, `use-global-palette-actions.ts`) — their mode now comes from
  // the same deepest-first route-param walk `RootTopBar` uses.

  // Open-in-App actions (260722-6d0f) — Constitution V palette parity for the
  // top-bar Open split-button: one `Open: <label>` entry per available target
  // (deeplinks when remote + sshHost set; host apps when the wt registry is
  // non-empty). Terminal route only (the folder is the current window's
  // active-pane cwd); an empty target set contributes no entries, mirroring
  // the hidden button. No keyboard chord is registered — the target set is
  // data-driven per deployment, so the palette entries themselves are the
  // keyboard path (documented per the code-review shortcut rule; see
  // lib/palette/open.ts). Data comes from the same module-cached
  // useOpenTargets fetch the TopBar entry uses (one fetch per page load).
  const openCtx = useOpenTargets(!!windowParam);
  const openPath = windowParam ? activePaneCwd(currentWindow) : "";
  const { runTarget: runOpenTarget } = useRunOpenTarget(server, openPath);
  const openTargets = useMemo(
    () =>
      windowParam
        ? buildOpenTargets({
            hostname: window.location.hostname,
            sshHost: openCtx.sshHost,
            sshUser: openCtx.sshUser,
            hostApps: openCtx.hostApps,
            path: openPath,
          })
        : [],
    [windowParam, openCtx, openPath],
  );
  // Resolved last-used target (localStorage read, validated against the live
  // set — stale ids resolve null). Feeds both the dynamic `Open: Last used
  // (<label>)` palette entry and the ⇧⌘O chord handler (260801-sm6g).
  const lastUsedOpenTarget = resolveLastUsedTarget(openTargets, readLastUsedOpenTarget());
  const openActions: PaletteAction[] = useMemo(
    () => [
      ...buildOpenActions(openTargets, runOpenTarget),
      // `Open: Last used (<label>)` (260801-sm6g) — palette twin of the ⇧⌘O
      // `open-last-used` chord and the split-button's primary segment. Hidden
      // when no last-used target resolves (the chord's toast covers that).
      ...buildOpenLastUsedAction(lastUsedOpenTarget, runOpenTarget),
      // `Open: PR #{n}` (260727-w2d8) — the keyboard path to the current
      // window's PR (Constitution V; the sidebar PrLinkRow anchor is
      // mouse-only). Client-side only: window.open in THIS viewer's browser
      // (the Help: Documentation pattern) — no host spoke, no OpenTarget
      // entry (the top-bar Open menu mirrors targets only, untouched). Off
      // the terminal route currentWindow is null, and no PR → no entry. No
      // keyboard chord — this palette entry is the keyboard path.
      ...buildOpenPrAction(currentWindow?.prUrl, currentWindow?.prNumber, (url) =>
        window.open(url, "_blank", "noopener,noreferrer"),
      ),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTargets, lastUsedOpenTarget?.id, server, openPath, currentWindow?.prUrl, currentWindow?.prNumber],
  );

  // Terminal font-size actions moved to the layout-level global palette groups
  // (260811-239r, `use-global-palette-actions.ts`) — the setting is global and
  // the board route needs the same entries without duplicating them (DD-8).

  const { execute: executeReloadConfig } = useOptimisticAction<[string]>({
    action: (srv) => reloadTmuxConfig(srv),
    onSettled: () => addToast("Tmux config reloaded", "info"),
    onError: () => addToast("Failed to reload tmux config", "error"),
  });

  const { execute: executeResetConfig } = useOptimisticAction<[string]>({
    action: (srv) => initTmuxConf().then(() => reloadTmuxConfig(srv)),
    onSettled: () => addToast("Tmux config reset to default", "info"),
    onError: () => addToast("Failed to reset tmux config", "error"),
  });

  // `Settings: Open`, `Help: Keyboard Shortcuts`, and `Help: Documentation`
  // moved to the layout-level global palette groups (260811-239r) — the board
  // route carried DD-8 duplicates of each. What remains here is server-scoped
  // (they POST against `server`).
  const configActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "reload-tmux-config",
        label: "Config: Reload tmux",
        onSelect: () => executeReloadConfig(server),
      },
      {
        id: "init-tmux-conf",
        label: "Config: Reset tmux to default",
        onSelect: () => executeResetConfig(server),
      },
    ],
    [server, executeReloadConfig, executeResetConfig],
  );

  // Manual PR/status refresh (260715-jykd) — Constitution V palette parity for
  // the PANE-header refresh button. Kicks both PR pollers server-side (POST
  // /api/status/refresh); fresh state lands via SSE. Best-effort/fire-and-forget:
  // the server coalesces + throttles, so errors are swallowed. Server-global —
  // available on every AppShell route (the pure builder holds the label/id).
  const statusRefreshActions: PaletteAction[] = useMemo(
    () => buildStatusRefreshAction(() => void refreshStatus().catch(() => {})),
    [],
  );

  // Update/check/maintenance/version actions moved to the layout-level global
  // palette groups (260811-239r, `use-global-palette-actions.ts`) — the board
  // route carried DD-8 duplicates of all four (it is a phone user's ONLY
  // update surface below `sm`, where the top-bar cluster is hidden).

  // Regular-class effective order (infra servers ignore rank and are not
  // reorderable). `servers` is already effective-sorted by the context, so this
  // is the visible order. The current server's position within it gates the
  // Move up/down actions (boundary = hidden, no wraparound); infra servers get
  // no Move action at all.
  const { regularOrder, currentRegularIdx } = useMemo(() => {
    const order = servers.filter((s) => !isInfraServer(s.name)).map((s) => s.name);
    return { regularOrder: order, currentRegularIdx: order.indexOf(server) };
  }, [servers, server]);

  const moveCurrentServer = useCallback(
    (delta: -1 | 1) => {
      const next = computeMoveOrder(regularOrder, currentRegularIdx, delta);
      if (!next) return; // boundary / infra (idx -1): no-op
      setServerOrder(next).catch((err) => addToast(err.message || "Failed to move server"));
    },
    [currentRegularIdx, regularOrder, server, addToast],
  );

  // Sessions-pane scope toggle — palette parity for the sidebar's SESSIONS
  // header chip (Constitution V). A single toggle entry labeled by its TARGET
  // state; the sidebar re-renders reactively via the shared hook's pub/sub.
  const [sessionsScope, setSessionsScope] = useSessionsScope();
  const sessionsScopeActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "sessions-scope-toggle",
        label:
          sessionsScope === "all"
            ? "Sessions: Show current server only"
            : "Sessions: Show all servers",
        onSelect: () => setSessionsScope(sessionsScope === "all" ? "current" : "all"),
      },
    ],
    [sessionsScope, setSessionsScope],
  );

  const serverActions: PaletteAction[] = useMemo(
    () => [
      {
        // Keyboard home path (Constitution V): below `sm` the top-bar brand
        // crumb is gone and the pointer home affordance is the sidebar brand
        // row, so the palette must carry the route too. Full navigation
        // (location.assign, not router navigate) — home is a deliberate
        // reload boundary, matching the brand crumb/sidebar anchors.
        id: "go-host",
        label: "Host: Overview",
        onSelect: () => window.location.assign("/"),
      },
      {
        id: "create-server",
        label: "Server: Create",
        onSelect: openCreateServer,
      },
      // The server tier's keyboard color path (mirrors `Session: Set Color`'s
      // shape): opens the modal SwatchPopover's "server" arm below.
      ...buildServerSetColorAction(server, () => setShowColorPicker("server")),
      // Host name copies the InstanceName displayName (the settings override,
      // else the health hostname) — the status bar's
      // `instanceName ?? metrics.hostname` equivalent WITHOUT subscribing
      // AppShell to the ~2.5s metrics stream (the leaf-subscription rule).
      ...(server ? [copyPaletteEntry("copy-server-name", "Copy: Server Name", "Server name", server)] : []),
      ...(instanceDisplayName
        ? [copyPaletteEntry("copy-host-name", "Copy: Host Name", "Host name", instanceDisplayName)]
        : []),
      // Per-server kill entries (bylc): with the hover ✕ removed from the
      // SERVER-panel tiles, this listing is the keyboard escape hatch that
      // keeps every server killable — including non-current servers, which
      // have no SESSIONS-pane group header under the `current` scope mode.
      // Each entry funnels through the layout-mounted kill-server confirm
      // Dialog (incl. its DAEMON_SERVER warning) via the context trigger
      // (260811-239r) → ServerDialogs' executeKillServer.
      ...buildServerKillActions(
        servers.map(({ name }) => name),
        server,
        requestKillServer,
      ),
      // Per-server protect/unprotect entries (rk-daemon excluded — derived,
      // not togglable). The POST wakes the SSE hub backend-side, so the
      // repaint rides the stream; ctx.refreshServers is belt-and-braces for
      // the host page's one-time-fetched list.
      ...buildServerProtectActions(servers, (name, next) => {
        void setServerProtected(name, next)
          .then(() => ctx.refreshServers())
          .catch((err: unknown) => {
            addToast(err instanceof Error ? err.message : "Failed to update server protection");
          });
      }),
      // Per-server adopt entries (EXTERNAL servers only — managed servers and
      // rk-daemon emit none). Each entry funnels through the layout-mounted
      // adopt confirm Dialog via the context trigger → ServerDialogs'
      // handleAdoptServer.
      ...buildServerAdoptActions(servers, requestAdoptServer),
      // Move up/down act on the CURRENT server within the regular class. Hidden
      // when the current server is infra (not reorderable) or at the boundary
      // (no wraparound).
      ...(currentRegularIdx > 0
        ? [
            {
              id: "server-move-up",
              label: "Server: Move up",
              onSelect: () => moveCurrentServer(-1),
            },
          ]
        : []),
      ...(currentRegularIdx >= 0 && currentRegularIdx < regularOrder.length - 1
        ? [
            {
              id: "server-move-down",
              label: "Server: Move down",
              onSelect: () => moveCurrentServer(1),
            },
          ]
        : []),
      ...servers.map(({ name }) => ({
        id: `switch-server-${name}`,
        label: `Server: Switch to ${name}${name === server ? " (current)" : ""}`,
        onSelect: () => handleSwitchServer(name),
      })),
    ],
    [servers, server, handleSwitchServer, currentRegularIdx, regularOrder, moveCurrentServer, openCreateServer, requestKillServer, requestAdoptServer, copyPaletteEntry, instanceDisplayName, windowParam, navigate],
  );

  // Desktop-shell server switching (Constitution V): `Server: Switch to
  // "<name>"` — one entry per SHELL-registered rk server (quoted name; whole
  // rk instances by URL, distinct from the tmux entries above), active one
  // marked (current). Present ONLY inside the desktop shell — useShellServers
  // resolves [] in a plain browser, the first real isShell()-gated palette
  // consumer. The shell-side paths are the ⌥⌘1–9 (mac) / Alt+1–9
  // (win/linux) accelerators + Servers menu
  // radios; selecting an entry hands off to the shell, which loads the target
  // server's URL (a full page swap), so no SPA-side navigation follows. A
  // denied/failed bridge call surfaces as an error toast.
  const shellServers = useShellServers();
  const shellServerActions: PaletteAction[] = useMemo(
    () =>
      buildShellServerActions(shellServers, (id) => {
        void switchShellServer(id).then((ok) => {
          if (!ok) addToast("Shell server switch failed", "error");
        });
      }),
    [shellServers, addToast],
  );

  // The web tile's engine opt-out (Constitution V): `Web: Use embedded
  // browser` flips the per-viewer localStorage preference between the native
  // and iframe engines. Gated on the `web` bridge group's own presence
  // (canShellWeb() — the canNewShellWindow() truthful-signal precedent), not
  // on isShell() and not on a web tile being open: a viewer may pre-toggle.
  // The same useLocalStorageBoolean key the chrome reads keeps both in sync.
  const [nativeEngineEnabled, setNativeEngineEnabled] = useLocalStorageBoolean(
    WEB_NATIVE_ENGINE_PREF_KEY,
    WEB_NATIVE_ENGINE_DEFAULT,
  );
  const webEngineActions: PaletteAction[] = useMemo(
    () =>
      buildWebEngineActions({
        available: canShellWeb(),
        enabled: nativeEngineEnabled,
        onToggle: setNativeEngineEnabled,
      }),
    [nativeEngineEnabled, setNativeEngineEnabled],
  );

  // `Web: Inspect page` (Constitution V — the palette is the keyboard path
  // for the URL bar's Inspect button; deliberately no chord): opens DevTools on the active
  // web tab through the chrome's `web-inspect` document seam. Present only
  // when the NATIVE engine is selected (the iframe engine has no devtools
  // capability) AND the window has web content (the `web-find` content gate —
  // an onboarding tile has nothing to inspect).
  const webInspectActions: PaletteAction[] = useMemo(
    () =>
      buildWebInspectActions({
        available:
          selectWebEngineKind(canShellWeb(), nativeEngineEnabled) === "native" &&
          hasWebUrl(effectiveWindow),
        onSelect: () => document.dispatchEvent(new CustomEvent(WEB_INSPECT_EVENT)),
      }),
    [nativeEngineEnabled, effectiveWindow],
  );

  // Navigate to a waiting target on the bare terminal route (empty search —
  // the target window resolves its own stored layout; the compose strip is
  // where the user answers the agent). A SAME-SERVER target needs the tmux
  // alignment the sidebar/palette path provides: fire `selectWindow` + track
  // the pending switch so the URL writeback (app.tsx:663) doesn't bounce back
  // to the previously-active window before SSE confirms the switch.
  // Cross-server targets navigate plainly — identity is window-id-only on the
  // 2-segment route and the destination's mount-time alignment (app.tsx:633)
  // handles tmux there.
  const navigateToWaitingTarget = useCallback(
    (targetServer: string, targetWindowId: string) => {
      if (targetServer === server) {
        // Same-server: tmux-align + track the pending switch so the failure
        // bounce-back (260715-38kg) un-sticks a limbo if the POST fails or never
        // confirms. No grace mask — the target may remount on layout change.
        // Cross-server navigates plainly (destination handles its own
        // mount-time alignment + tracking).
        const posted = selectWindow(server, targetWindowId);
        posted.catch(() => {});
        beginPendingSwitch({ server, windowId: targetWindowId }, { posted });
      }
      navigate({
        to: "/$server/$window",
        params: { server: targetServer, window: targetWindowId },
        search: {},
      });
      if (isMobile) setSidebarOpen(false);
    },
    [server, navigate, isMobile, setSidebarOpen, beginPendingSwitch],
  );

  // Per-window switch entries — one per window across every session. Grouped
  // under the "Tab:" family (user-facing copy calls tmux windows "tabs") to
  // surface the keyboard switch path (constitution V). Reuses navigateToWindow
  // (URL nav + selectWindow + mobile-close + pendingClickRef writeback
  // suppression); the `(current)` suffix marks the URL-active window, mirroring
  // `Server: Switch to <name> (current)`.
  const windowSwitchActions: PaletteAction[] = useMemo(
    () =>
      buildWindowSwitchActions({
        flatWindows,
        windowParam,
        onSelectWindow: navigateToWindow,
      }),
    [flatWindows, navigateToWindow, windowParam],
  );

  // Agent: Next waiting (260706-y1ar; status-pyramid.md § Attention Propagation).
  // The keyboard-first attention nav (Constitution V): cycles focus through
  // windows whose rolled-up agentState is `waiting`, CURRENT SERVER FIRST then
  // other ATTACHED servers (unattached servers' window data isn't streamed, so
  // they can't be enumerated client-side — a known constraint). No-op with a
  // "no agents waiting" toast when none. Single action; the cycle arithmetic is
  // the pure `nextWaitingTarget` helper (unit-tested). Built off `flatWindows`
  // (current server, already sidebar-ordered) + a live read of the streamed
  // `sessionsByServerRef` for other servers (avoids churning this memo's deps
  // every SSE tick — mirrors handleSidebarSelectWindow's ref read).
  const agentActions: PaletteAction[] = useMemo(() => {
    const onSelect = () => {
      const ordered: WaitingTarget[] = [];
      // Current server first, in sidebar order.
      for (const fw of flatWindows) {
        if (isWaiting(fw.window)) {
          ordered.push({ server, windowId: fw.window.windowId });
        }
      }
      // Then other attached servers (skip the current one — already added).
      for (const s of servers) {
        if (s.name === server) continue;
        for (const sess of sessionsByServerRef.current.get(s.name) ?? []) {
          for (const w of sess.windows) {
            if (isWaiting(w)) {
              ordered.push({ server: s.name, windowId: w.windowId });
            }
          }
        }
      }
      const target = nextWaitingTarget(ordered, server, windowParam);
      if (!target) {
        addToast("No agents waiting", "info");
        return;
      }
      if (target.server === server) {
        // Same-server: keep the rich window-switch path (selectWindow
        // tmux-align + slide transition + mobile-close). It clears search,
        // which is correct — the target resolves its own terminal layout.
        navigateToWindow(target.windowId);
        return;
      }
      // A cross-server target navigates plainly on the bare route (its stored
      // layout resolves on render).
      navigateToWaitingTarget(target.server, target.windowId);
    };
    return [{ id: "agent-next-waiting", label: "Agent: Next waiting", onSelect }];
  }, [flatWindows, servers, server, windowParam, navigateToWindow, navigateToWaitingTarget, addToast]);

  // ── macros over riff presets / palette actions (260730-hbyh) ─────────────
  const { macros } = useMacros();

  // Macro execution. Palette targets dispatch the existing palette action
  // body in-place (id lookup — the `fromPalette` convention; `macro:` ids are
  // never resolved as targets, so no macro→macro recursion). Riff targets
  // POST the existing validated spawn seam with the PRESET NAME only (no
  // shell text, no new exec surface — Constitution I): success toasts and
  // navigates to the spawned window (the spawn dialog's falsy-windowId guard
  // preserved); failure — incl. a 400 for a preset gone from fabconfig —
  // surfaces as an error toast. No fire-and-forget. The imperative
  // `getAllActions` resolves targets against the MERGED list (route actions +
  // the layout-level globals, 260811-239r) at call time, breaking the
  // palette↔macro cycle: macro palette entries fold into the registered route
  // list, while execution may target any palette entry, global ones included.
  const executeMacro = useCallback(
    (macro: MacroAction) => {
      if (macro.target.type === "palette") {
        const targetId = macro.target.paletteActionId;
        if (isMacroActionId(targetId)) return;
        getAllActions().find((a) => a.id === targetId)?.onSelect();
        return;
      }
      if (!sessionName) return;
      spawnRiff(server, sessionName, { preset: macro.target.preset })
        .then((res) => {
          addToast(`Spawned ${res.window}`, "info");
          if (res.windowId) navigateToWindow(res.windowId);
        })
        .catch((err) =>
          addToast(err instanceof Error ? err.message : "Macro spawn failed", "error"),
        );
    },
    [server, sessionName, addToast, navigateToWindow, getAllActions],
  );

  // Macros are palette-reachable without their key (kind-tagged `Macro:`
  // entries; actionId doubles as the palette id, so `withShortcutHints`
  // decorates them with their effective combos automatically). Riff macros
  // are session-gated, mirroring `Agent: Spawn`.
  const macroPaletteActions: PaletteAction[] = useMemo(
    () =>
      macros
        .filter((m) => m.target.type === "palette" || sessionName != null)
        .map((m) => ({
          id: m.actionId,
          label: `Macro: ${m.label}`,
          onSelect: () => executeMacro(m),
        })),
    [macros, sessionName, executeMacro],
  );

  // Agent: Spawn — Cmd+K parity for the web-UI spawn flow (260713-sbk1;
  // Constitution V palette parity — the shortcut/registration is documented
  // here per code-review.md "New keyboard shortcuts must be documented in the
  // command palette registration"). Gated on a resolvable session (mirrors
  // Window: Create), since the spawn target IS the current window's session.
  const agentSpawnActions: PaletteAction[] = useMemo(
    () =>
      sessionName
        ? [{ id: "agent-spawn", label: "Agent: Spawn", onSelect: () => handleOpenSpawnAgent(server, sessionName) }]
        : [],
    [server, sessionName, handleOpenSpawnAgent],
  );

  // Operator compose palette verbs (260822-wyn3) — the PRIMARY entry to the
  // compose dialog (Constitution V). Each pre-selects its mode in the shared
  // dialog; gated on this server having an operator window (omit-not-disable,
  // the same degrade-to-absent rule as `Tab: Fix name (ask operator)`).
  const operatorComposeActions: PaletteAction[] = useMemo(
    () =>
      hasOperatorWindow
        ? [
            { id: "operator-spawn-task", label: "Operator: Spawn task…", onSelect: () => handleOperatorCompose(server, "spawn") },
            { id: "operator-find-discussion", label: "Operator: Find discussion…", onSelect: () => handleOperatorCompose(server, "find") },
            // Brief me / What's stuck / Color tabs — the server-scoped,
            // non-destructive digest/triage/labeling requests; they fire
            // directly (no dialog, no confirm), same hasOperatorWindow
            // omit-not-disable gate, no chords.
            {
              id: "operator-brief-me",
              label: "Operator: Brief me",
              onSelect: () => {
                void handleServerOperatorAction(server, "brief-me", "Sent to operator — digest will appear in the operator tab");
              },
            },
            {
              id: "operator-whats-stuck",
              label: "Operator: What's stuck",
              onSelect: () => {
                void handleServerOperatorAction(server, "whats-stuck", "Sent to operator — triage will appear in the operator tab");
              },
            },
            {
              id: "operator-color-tabs",
              label: "Operator: Color tabs",
              onSelect: () => {
                void handleServerOperatorAction(server, "color-tabs", "Sent to operator — tabs will be colored shortly");
              },
            },
            {
              id: "operator-update-annotations",
              label: "Operator: Update annotations",
              onSelect: () => {
                void handleServerOperatorAction(server, "update-annotations", "Sent to operator — notes will be updated shortly");
              },
            },
          ]
        : [],
    [hasOperatorWindow, handleOperatorCompose, handleServerOperatorAction, server],
  );

  // Cron clock palette verbs (Constitution V) — `Cron: new entry` /
  // `mute…` / `pin…` / `delete…`, built by the pure lib/palette/cron.ts
  // builder over the current server's entries (useCronData rides the
  // state-socket sessions cadence — no new polling). Mute/pin fire the
  // mutation straight (the SSE wake repaints); delete goes through the
  // kill-confirm dialog below; `new entry` opens the create dialog.
  const cronData = useCronData(server);
  const [cronCreateOpen, setCronCreateOpen] = useState(false);
  const [cronDeleteTarget, setCronDeleteTarget] = useState<CronEntry | null>(null);
  // One shared handler set for the palette's cronActions — a single
  // delete-confirm path and toast-on-error posture.
  const cronHandlers: CronActionHandlers = useMemo(
    () => ({
      onCreate: () => setCronCreateOpen(true),
      onMute: (entry) => {
        void muteCron(server, entry.id, entry.muted !== true).catch((err: unknown) =>
          addToast(err instanceof Error && err.message ? err.message : "Mute failed", "error"),
        );
      },
      onPin: (entry) => {
        void pinCron(server, entry.id, entry.pinned !== true).catch((err: unknown) =>
          addToast(err instanceof Error && err.message ? err.message : "Pin failed", "error"),
        );
      },
      onDelete: (entry) => setCronDeleteTarget(entry),
    }),
    [server, addToast],
  );
  const cronActions: PaletteAction[] = useMemo(
    () => (server ? buildCronActions(cronData.entries, cronHandlers) : []),
    [server, cronData.entries, cronHandlers],
  );
  const mountedDataTables = useMountedDataTables();

  const { actions: pushActions } = usePushSubscription();

  // `Tab: Previous` / `Tab: Next` (R8) — palette parity for the
  // `window-prev`/`window-next` chords: a one-row step over the FLATTENED
  // all-sessions window list in sidebar order (wraparound at the ends, so a
  // session boundary lands on the adjacent session's edge window), via the
  // rich `navigateToWindow` path (tmux align + transition + writeback
  // suppression). Target resolution lives in lib/window-cycle.ts. The ids
  // double as the registry actionIds, so `withShortcutHints` decorates the
  // arrow combos and the chord handlers resolve through `fromPalette` —
  // chord and palette can never drift. Omitted when no window is current,
  // so the gating gates the chord for free.
  const windowCycleActions: PaletteAction[] = useMemo(() => {
    if (windowParam == null) return [];
    const cycleWindow = (delta: -1 | 1) => () => {
      const target = cycleWindowTarget(sessions, windowParam, delta);
      if (target) navigateToWindow(target);
    };
    return [
      { id: "window-prev", label: "Tab: Previous", onSelect: cycleWindow(-1) },
      { id: "window-next", label: "Tab: Next", onSelect: cycleWindow(1) },
    ];
  }, [sessions, windowParam, navigateToWindow]);

  // `Session: Previous` / `Session: Next` — palette parity for the
  // `session-prev`/`session-next` chords: jump to the adjacent session in
  // sidebar order (wraparound), landing on its tmux-active window (the
  // no-active-window fallback is lib/window-cycle.ts's concern). Same id =
  // actionId contract and same no-current-window gating as the tab pair.
  const sessionJumpActions: PaletteAction[] = useMemo(() => {
    if (windowParam == null) return [];
    const jumpSession = (delta: -1 | 1) => () => {
      const target = sessionJumpTarget(sessions, windowParam, delta);
      if (target) navigateToWindow(target);
    };
    return [
      { id: "session-prev", label: "Session: Previous", onSelect: jumpSession(-1) },
      { id: "session-next", label: "Session: Next", onSelect: jumpSession(1) },
    ];
  }, [sessions, windowParam, navigateToWindow]);

  // AppShell's ROUTE-SCOPED palette list (260811-239r): the global groups
  // (nav, terminal-font, refresh/help/shortcuts/settings, update/check/
  // maintenance/version) live at the layout level now
  // (`use-global-palette-actions.ts`) and arrive merged AFTER these via the
  // palette-actions slot — ordering stays route groups first, then the global
  // groups in their prior relative order (R11).
  const paletteActions: PaletteAction[] = useMemo(
    () =>
      // The popout posture is chrome-less (no palette mount, no shared-layout
      // verbs): registering nothing also disarms every chord whose handler
      // resolves through these palette bodies (the `layout-cycle` hazard —
      // ⌘; in a popout must not rewrite the shared layout).
      popoutPosture
        ? []
        : // Every registered action with a palette entry renders its EFFECTIVE
          // combo as the `shortcut` hint (actionId doubles as the palette id),
          // formatted per platform and reflecting overrides; disabled bindings
          // (user-disabled or browser-reserved) render no hint.
          withShortcutHints(
            [...sessionActions, ...sessionsScopeActions, ...windowActions, ...reopenActions, ...windowCycleActions, ...sessionJumpActions, ...boardActions, ...selectionActions, ...viewActions, ...guiActions, ...openActions, ...themeActions, ...configActions, ...statusRefreshActions, ...serverActions, ...shellServerActions, ...webEngineActions, ...webInspectActions, ...pushActions, ...windowSwitchActions, ...agentActions, ...agentSpawnActions, ...operatorComposeActions, ...cronActions, ...buildDataTableActions(mountedDataTables), ...macroPaletteActions],
            bindingByAction,
            bindingHost.platform,
          ),
    [popoutPosture, sessionActions, sessionsScopeActions, windowActions, reopenActions, windowCycleActions, sessionJumpActions, boardActions, selectionActions, viewActions, guiActions, openActions, themeActions, configActions, statusRefreshActions, serverActions, shellServerActions, webEngineActions, webInspectActions, pushActions, windowSwitchActions, agentActions, agentSpawnActions, operatorComposeActions, cronActions, mountedDataTables, macroPaletteActions, bindingByAction, bindingHost],
  );
  // Publish this route's (already shortcut-decorated) list into the
  // palette-actions slot — the single layout-mounted CommandPalette renders
  // `[...routeActions, ...globalActions]`; cleared on unmount so the next
  // route never sees stale entries (260811-239r).
  useRegisterPaletteActions(paletteActions);

  // ── keybinding dispatch (260730-g40a) ────────────────────────────────────
  // The shifted-tier chords reuse the PALETTE ACTION BODIES (actionId doubles
  // as the palette id), so chord and palette behavior can never drift — and
  // palette gating (e.g. `kill-window` exists only when a session is active)
  // gates the chord for free: a missing handler falls through untouched.
  const keybindingHandlers = useMemo(() => {
    // Resolve over the MERGED list (260811-239r): chords such as `go-back`,
    // `settings-open`, and `shortcuts-overlay` name ids that live in the
    // layout-level global groups now — resolving against the route list alone
    // would silently drop those handlers (R10). The merge is local
    // (`paletteActions` from THIS render + the globals-only channel), so the
    // handlers below never lag the registration slot by a commit.
    const merged = [...paletteActions, ...paletteGlobals];
    const fromPalette = (id: string) => merged.find((a) => a.id === id)?.onSelect;
    // ttyOnly gate (260812-wfic R8): a binding flagged `ttyOnly` in the
    // registry yields NO handler unless the tty tile owns focus — handler
    // presence is the dispatcher contract, so the chord then falls through
    // untouched (rule 3, no preventDefault).
    const ttyGated = (id: string) =>
      bindingByAction.get(id)?.ttyOnly && focusedTileKind !== "tty"
        ? undefined
        : fromPalette(id);
    // webOnly gate (260819-ie2i R2) — the ttyOnly mirror: a `webOnly`
    // binding's handler is treated as ABSENT unless the web tile owns focus,
    // so ⌘F falls through untouched everywhere else (native browser find; the
    // pane's Ctrl+F under Win/Linux terminal focus). The gate consults the
    // registry flag as data, never an actionId list.
    const webGated = (id: string) =>
      bindingByAction.get(id)?.webOnly && focusedTileKind !== "web"
        ? undefined
        : fromPalette(id);
    // guiOnly gate — the webOnly mirror: a `guiOnly` binding's handler is
    // treated as ABSENT unless the gui tile owns focus, so plain Ctrl+=/−/0
    // stay with the pane everywhere else. The gate consults the registry flag
    // as data, never an actionId list. The bodies are direct (not fromPalette):
    // the zoom rows' palette entries gate on tile state, while the chord's
    // reclaim path already implies a focused gui tile.
    const guiGated = (id: string, run: () => void) =>
      bindingByAction.get(id)?.guiOnly && focusedTileKind !== "gui"
        ? undefined
        : run;
    // `window-prev`/`window-next` and `session-prev`/`session-next` resolve
    // through their palette bodies — the `Tab: Previous` / `Tab: Next` /
    // `Session: Previous` / `Session: Next` entries own the flattened
    // cross-session step and the adjacent-session hop (see
    // `windowCycleActions`/`sessionJumpActions`; target resolution lives in
    // lib/window-cycle.ts).
    // Macro chords (260730-hbyh): palette targets reuse the palette body via
    // the same `fromPalette` lookup (an absent action → no handler → the
    // chord falls through untouched); riff targets are session-gated and run
    // `executeMacro`. Builtin keys are spread last, so a (theoretical) id
    // collision resolves builtin-first.
    const macroHandlers: Record<string, (() => void) | undefined> = {};
    for (const m of macros) {
      if (m.target.type === "palette") {
        macroHandlers[m.actionId] = isMacroActionId(m.target.paletteActionId)
          ? undefined
          : fromPalette(m.target.paletteActionId);
      } else {
        macroHandlers[m.actionId] = sessionName ? () => executeMacro(m) : undefined;
      }
    }
    // Stateful tile chords (R4): ⌘1/⌘2/⌘3 (⇧Ctrl+digit on Win/Linux) apply
    // the three-state rule against the CURRENT render layout — hidden →
    // open + focus once the tile lands (the per-kind landing flag);
    // visible-unfocused → focus through the palette's `Tile: Focus` seam
    // (`layoutFocusTileRef`); focused → hide + `restoreFocus` so focus never
    // strands. The state machine itself (branch table, gating, recording
    // constraint) lives in `lib/tile-chord.ts`; the seams here wire the refs.
    const tileChord = (kind: SurfaceKind): (() => void) | undefined =>
      tileChordHandler({
        kind,
        windowParam,
        isMobile,
        panelSurfaces,
        order: slotOrder(layout),
        focusedTileKind,
        togglePanel,
        focusTile: (k) => layoutFocusTileRef.current?.(k),
        setLanding: (k) => {
          focusOnLandingRef.current = k;
        },
        restoreAfterHide: (k) => {
          if (windowParam) restoreFocus(focusMemoryKey(server, windowParam), k);
        },
      });
    return {
      ...macroHandlers,
      "create-session": fromPalette("create-session"),
      "create-window": fromPalette("create-window"),
      "kill-window": fromPalette("kill-window"),
      // ⇧⌘T reopen closed tab (mac shell) — the palette entry's stack gating
      // IS the chord gating: an empty mirror mounts no entry, so fromPalette
      // yields no handler and the chord falls through untouched.
      "reopen-window": fromPalette("reopen-window"),
      "agent-next-waiting": fromPalette("agent-next-waiting"),
      "go-back": fromPalette("go-back"),
      "go-forward": fromPalette("go-forward"),
      "window-prev": fromPalette("window-prev"),
      "window-next": fromPalette("window-next"),
      "session-prev": fromPalette("session-prev"),
      "session-next": fromPalette("session-next"),
      "shortcuts-overlay": fromPalette("shortcuts-overlay"),
      // ⌘I (mac) / ⇧Ctrl+E compose (R6) — stateful on the strip's live focus
      // (the `compose-strip-events` module store). The three-arm body (off →
      // toggle on; on + unfocused → focus with a decline falling back to the
      // toggle; on + focused → toggle off) is shared with the board twin via
      // `runComposeToggleChord`. `ignoreInputs` on the binding lets the hide
      // arm fire from inside the textarea.
      "compose-toggle": () => runComposeToggleChord(composeStripEnabled, toggleComposeStrip),
      // ⇧⌘O open-last-used (260801-sm6g) — terminal route only (scope is
      // descriptive; handler presence gates). Reuses the palette body when the
      // dynamic `Open: Last used (<label>)` entry exists (a last-used target
      // resolved); otherwise the chord surfaces the empty-state toast — a
      // chord cannot reasonably pop the split-button's mouse menu.
      "open-last-used": windowParam
        ? (fromPalette("open-last-used") ??
          (() => addToast("No last-used app yet — pick one from Open ▾ or the palette", "info")))
        : undefined,
      // ⇧⌘,/⌘, settings (260801-mqim) — the palette body (`Settings: Open` →
      // `openSettings`); a re-fire while the dialog is open is a no-op.
      "settings-open": fromPalette("settings-open"),
      // ⌘N/⇧⌘W app-window chords are NOT dispatched here — the pair is owned
      // by the root layout's dispatcher (it must fire on the host overview and
      // NotFound routes, which mount no AppShell/BoardPage). The `App: New
      // Window` / `App: Close Window` palette bodies stay layout-global.
      // Split pane (260807-rbx5): ⌘D/⇧⌘D on mac, ⇧Ctrl+\/⇧Ctrl+- on
      // Win/Linux — the `Tab: Split Horizontal` / `Tab: Split Vertical`
      // palette bodies. The palette block is gated on a current session +
      // window, so on non-window routes `fromPalette` yields undefined and
      // the chord falls through untouched (BoardPage mounts neither — splits
      // are terminal-route actions, like `open-last-used`).
      //
      // tty-scoped gate (260812-wfic R8): the pair carries the registry's
      // `ttyOnly` data flag — its handler is treated as ABSENT unless the
      // focused tile is the tty tile (single:tty and mobile's visible tty
      // count), so the chord falls through per dispatcher rule 3 (no
      // preventDefault) when e.g. the code tile owns focus. The gate consults
      // the flag, never a hardcoded actionId list; PALETTE invocation is
      // unaffected (the gate applies to chords, not the `Tab: Split …`
      // rows). The tty-side path is untouched — `shouldRefuseTerminalChord`
      // still bounces the chord out of the xterm pane to this dispatcher.
      "split-horizontal": ttyGated("split-horizontal"),
      "split-vertical": ttyGated("split-vertical"),
      // ⌘F/Ctrl+F web find (260819-ie2i R4) — resolves the `Web: Find in
      // page` palette body through the webOnly gate: present only while the
      // web tile owns focus AND the layout has an open web tile (the palette
      // gating), so the chord is inert everywhere else.
      "web-find": webGated("web-find"),
      // ⌘F (mac) / ⇧Ctrl+F (Win/Linux) terminal find — the `Terminal: Find`
      // palette body through the ttyOnly gate: present only while a tty tile
      // owns focus AND the layout has an open tty tile (the palette gating),
      // so the chord is inert everywhere else (native browser find; the
      // pane's plain Ctrl+F on Win/Linux — never claimed).
      "terminal-find": ttyGated("terminal-find"),
      // ⌘L/Ctrl+L focus the web tile's address bar (260819-v6y4 R12) — the
      // `Web: Focus address bar` palette body through the webOnly gate: the
      // chord falls through untouched everywhere else (the browser's own
      // address bar on mac, readline clear-screen under Win/Linux terminal
      // focus). The mac-browser cmd-tier KeyL claim is REMOVED — ⌘L is
      // page-interceptable (the ⌘D/⌘J class).
      "web-address": webGated("web-address"),
      // Ctrl+= / Ctrl+- / Ctrl+0 gui zoom — present only while the gui tile
      // owns focus (the guiOnly gate); the tile's capture-phase keydown gate
      // reclaims the chord over noVNC's canvas handler and re-dispatches it
      // here. Stepping the posture re-renders the tile, which shows the badge.
      "gui-zoom-in": guiGated("gui-zoom-in", () => handleGuiZoomChange(stepGuiZoom(guiZoom, 1))),
      "gui-zoom-out": guiGated("gui-zoom-out", () => handleGuiZoomChange(stepGuiZoom(guiZoom, -1))),
      "gui-zoom-fit": guiGated("gui-zoom-fit", () => handleGuiZoomChange("fit")),
      // ⌘⇧G/Ctrl+Shift+G keyboard capture — the chord gate's escape hatch.
      // Present only while the gui tile owns focus (the guiOnly gate); the
      // narrowed reclaim predicate is what delivers the chord here while
      // every other chord passes to the guest.
      "gui-capture-toggle": guiGated("gui-capture-toggle", () => handleGuiCaptureChange(!guiCapture)),
      // ⌘⇧G/Ctrl+Shift+G web keyboard capture — the SAME chord, gated to the
      // web tile (webOnly), so exactly one of the two capture handlers is
      // present at a time (the dispatcher runs the first present handler).
      // While latched it is the only chord the web engines still reclaim.
      // The palette body carries the hasWebUrl content gate: an onboarding
      // tile has no page to capture for.
      "web-capture-toggle": webGated("web-capture-toggle"),
      // ⌘1/⌘2/⌘3 tile chords (R4) — see `tileChord` above for the three-state
      // rule, gating, and the recording constraint. A window without the
      // surface (`availableTiles`) mounts no handler and the chord falls
      // through untouched.
      "tty-toggle": tileChord("tty"),
      "code-toggle": tileChord("code"),
      "web-toggle": tileChord("web"),
      "gui-toggle": tileChord("gui"),
      // ⇧⌘⏎ / ⇧Ctrl+Enter zen (260820-o8cr R6) — the FULL zen toggle (top
      // bar + sidebar + focused-tile zoom at arity > 1), resolved through the
      // same `toggleZen` body as the palette entries and the status-bar exit
      // button. Mounts at ANY arity on the desktop terminal route — at arity
      // 1 the chrome hide still applies (no zoom is attempted).
      "zen-toggle":
        windowParam && !isMobile
          ? toggleZen
          : undefined,
      // ⌃`/⇧Ctrl+` focus hop (VS Code's ⌃` gesture): tty↔code through the
      // `Tile: Focus <Surface>` focus-by-kind seam. Hopping TO tty records
      // `tty` via that seam's `recordTtySlot`; hopping to code writes NO
      // focus memory (the recording asymmetry — only in-frame `onInteract`
      // records `code`). A closed-but-available code tile opens first
      // (open-then-focus), focused once the layout lands. Same gate as
      // code-toggle. Visibility is judged against the RENDERED tree: a
      // popped, unrevealed code leaf is absent from it (the shared layout
      // still holds the leaf), so the hop falls to `togglePanel`, whose
      // popped guard reveals the placeholder instead of writing the layout.
      "focus-hop":
        windowParam && !isMobile && panelSurfaces.includes("code")
          ? () => {
              if (focusedTileKind === "code") {
                layoutFocusTileRef.current?.("tty");
              } else if (leaves(renderLayout).includes("code")) {
                layoutFocusTileRef.current?.("code");
              } else if (togglePanel("code")) {
                // Flag only an APPLIED open: a full 3-tile layout refuses the
                // add (null no-op), and a stuck flag would auto-focus code
                // whenever a later unrelated action opens it.
                focusOnLandingRef.current = "code";
              }
            }
          : undefined,
      // ⌘; layout-template cycle — the ▦ chip's chord: the next template for
      // the current tile count, slot order kept. Reuses the `Layout: Cycle
      // Template` palette body, whose gating (window route + a non-degenerate
      // template ring) gates the chord for free.
      "layout-cycle": fromPalette("layout-cycle"),
    };
  }, [paletteActions, paletteGlobals, server, windowParam, macros, sessionName, executeMacro, toggleComposeStrip, composeStripEnabled, addToast, isMobile, panelSurfaces, togglePanel, restoreFocus, bindingByAction, focusedTileKind, layout, renderLayout, toggleZen, guiZoom, handleGuiZoomChange, guiCapture, handleGuiCaptureChange]);
  useKeybindingDispatch(keybindingHandlers);

  const displayName = currentWindow?.name ?? windowParam ?? "";
  const displaySession = sessionName ?? "";

  // Stable Sidebar handlers (R6a). `AppShell` consumes `useSessionContext()` and
  // therefore re-renders on every SSE tick; inline arrows here would recreate
  // these references each tick and defeat `ServerGroup`'s `React.memo` for every
  // group, including the currently-viewed one. The branching behavior
  // (current-server vs cross-server) is identical to the prior inline arrows.
  //
  // These MUST be declared before the three-way route-guard early returns below
  // — they are hooks, so a conditional/early-returned call site would violate the
  // Rules of Hooks (the not-found/waiting branches return before reaching them,
  // changing the hook count between renders).
  const handleSidebarSelectWindow = useCallback(
    (srv: string, _sess: string, windowId: string) => {
      if (srv === server) {
        navigateToWindow(windowId);
      } else {
        // Cross-server: identity is window-id only on the 2-segment route.
        // Empty search so the target window resolves its own stored layout.
        navigate({
          to: "/$server/$window",
          params: { server: srv, window: windowId },
          search: {},
        });
        if (isMobile) setSidebarOpen(false);
      }
    },
    [server, navigateToWindow, navigate, isMobile, setSidebarOpen],
  );
  const handleSidebarCreateWindow = useCallback(
    (srv: string, sess: string) => {
      if (srv === server) {
        handleCreateWindow(sess);
      } else {
        executeCreateWindow(srv, sess);
      }
    },
    [server, handleCreateWindow, executeCreateWindow],
  );
  const handleSidebarCreateSession = useCallback(
    (srv: string) => {
      if (srv === server) {
        handleCreateSessionInstant();
      } else {
        // For non-current servers, create with a default name
        // (no cwd source available). Read the freshest sessions map at click
        // time so this callback stays stable across SSE ticks.
        const existingNames = (sessionsByServerRef.current.get(srv) ?? []).map((s) => s.name);
        const name = deriveInstantSessionName(undefined, existingNames);
        executeCreateSessionInstant(srv, name, undefined);
      }
    },
    [server, handleCreateSessionInstant, executeCreateSessionInstant],
  );
  // Stable kill-server handler (260721-x4sf): `onKillServer` threads into the
  // memoized `ServerGroup` header cluster, so an inline arrow here would hand
  // every group a fresh identity per SSE tick and defeat the memo skip. The
  // context trigger (`requestKillServer`, 260811-239r) is referentially stable
  // by construction — it passes straight through at the Sidebar call site.

  // Waiting-badge click (260714-r7rq): navigate to the NEXT waiting window
  // within the clicked session's scope, reusing the `nextWaitingTarget` cycle
  // semantics (R12) — so clicking the badge while already ON one of that
  // session's waiting windows advances to the next (with wraparound) instead of
  // no-opping on the first. Navigation lands on the bare terminal route (empty
  // search — the target resolves its own stored layout). Reads the freshest
  // sessions map by ref so the
  // callback stays stable across SSE ticks (mirrors the other sidebar
  // handlers). No-op if the session has no waiting window (the badge only
  // renders when count > 0, so this is a defensive guard against a stale
  // snapshot).
  const handleWaitingBadgeClick = useCallback(
    (srv: string, sess: string) => {
      // Read the freshest sessions map by ref (keyed by server) so the callback
      // stays stable across SSE ticks — `sessionsByServerRef.current.get(server)`
      // IS `rawSessions` (same source/key), so there is no current-server special
      // case to keep. Dropping the `rawSessions` dep is what keeps this callback
      // reference stable, preserving `ServerGroup`'s `React.memo`.
      const sessionsForSrv = sessionsByServerRef.current.get(srv) ?? [];
      const sessionEntry = sessionsForSrv.find((s) => s.name === sess);
      if (!sessionEntry) return;
      const waitingWindows = sessionEntry.windows.filter((w) => isWaiting(w));
      const ordered: WaitingTarget[] = waitingWindows.map((w) => ({
        server: srv,
        windowId: w.windowId,
      }));
      // Current position is keyed on the REAL current (server, window) pair —
      // nextWaitingTarget keys on both, so a same-numbered window on another
      // server never spuriously matches; a cross-server badge click always
      // lands on the session's first waiting window.
      const target = nextWaitingTarget(ordered, server, windowParam);
      if (!target) return;
      // Same-server targets tmux-align (selectWindow + pendingClickRef) so the
      // URL writeback can't bounce back; cross-server navigates plainly. See
      // `navigateToWaitingTarget`.
      navigateToWaitingTarget(target.server, target.windowId);
    },
    [server, windowParam, navigateToWaitingTarget],
  );

  // Register AppShell's TopBar props into the persistent root bar's slot
  // (260707-4vq2). The heavy handlers (`navigateToWindow` with its
  // View-Transitions gate, `handleCreateWindow` with optimistic
  // ghosts) stay defined here and are published by reference — no logic
  // migrates to root. `mode` (terminal vs root) is derived at root from the
  // route, so it is NOT part of the slot. Memoized so the registration effect
  // re-publishes only when a prop actually changes. Declared here (a hook)
  // BEFORE the three-way route-guard early returns to keep the hook order
  // stable across the waiting/not-found branches.
  const onToggleSidebar = useCallback(
    () => setSidebarOpen(!sidebarOpen),
    [setSidebarOpen, sidebarOpen],
  );
  // Connection dot semantics: the dot reports the per-server sessions-slice
  // health ("per-page live-data health"). The dot renders in the SIDEBAR FOOTER
  // (260724-6j1v — it left the top bar), so this feeds the Sidebar prop below.
  const dotConnected = isConnected;
  // The window-switcher `+ New Agent` (TopBar `onSpawnAgent(session)`) targets
  // the CURRENT server; bind `server` here so the slot handler keeps the
  // one-arg TopBar signature while feeding the explicit `{server, session}`
  // target. Cross-server spawn comes from the sidebar, not this entry point.
  const handleSlotSpawnAgent = useCallback(
    (sess: string) => handleOpenSpawnAgent(server, sess),
    [server, handleOpenSpawnAgent],
  );
  // The web toggle's corner dot means "has content" (hasWebUrl), not "exists"
  // — web availability is unconditional (260821-zqlq), so the dot is what
  // carries the content signal. The gui toggle's dot is VNC health: the
  // tile's RFB connection state while a gui tile is open, falling back to the
  // signal's `reachable` when none is. Every other surface's dot stays
  // always-on (shown still equals available for them).
  const surfaceDot = useCallback(
    (surface: SurfaceKind) => {
      if (surface === "gui") {
        return leaves(layout).includes("gui") ? guiConnected : gui?.reachable === true;
      }
      return surface !== "web" || hasWebUrl(effectiveWindow);
    },
    [effectiveWindow, gui, guiConnected, layout],
  );
  // The toggle group's away marker: a kind the route window's server-derived
  // `awayIn` names (its slot is live in another tab). Toggling the kind on
  // re-adds the slot, which renders as the placeholder while away.
  const surfaceAway = useCallback(
    (surface: SurfaceKind) => effectiveWindow?.awayIn?.[surface] !== undefined,
    [effectiveWindow],
  );
  // The toggle group's popped marker: the kind's close target (its first bare
  // leaf) is in this viewer's popped set — the toggle reveals/hides the popped
  // placeholder instead of closing the tile.
  const surfacePopped = useCallback(
    (surface: SurfaceKind) => {
      const target = popoutToggleTarget(layout, surface);
      return target !== undefined && popped.includes(target);
    },
    [layout, popped],
  );
  // The toggle group's open state: a popped kind reads open only while
  // revealed — its slot is on screen (as the popped placeholder) only then.
  const openToggleKinds = useMemo(
    () =>
      openTileKinds(layout).filter((surface) => {
        const target = popoutToggleTarget(layout, surface);
        return target === undefined || !popped.includes(target) || revealed.includes(target);
      }),
    [layout, popped, revealed],
  );
  // The toggle group's add gate: the per-viewport size floor (an addSurface
  // dry run over SOME closed surface), not a tile count. Desktop checks the
  // leaves' real rects through the layoutRects seam; mobile reads the nominal
  // box. The stored divider sizes thread in so the verdict matches
  // togglePanel's. Computed per render of the slot — a resize that changes
  // the verdict repaints with the next layout/SSE render.
  const canAddTile = useMemo(() => {
    const closed = panelSurfaces.filter((surface) => !bareLeaves(layout).includes(surface));
    if (closed.length === 0) return false;
    return (
      addSurface(
        layout,
        closed[0],
        isMobile ? undefined : (layoutRectsRef.current?.() ?? undefined),
        undefined,
        windowParam ? readStoredSizes(server, windowParam, layout) : undefined,
      ) !== null
    );
  }, [layout, panelSurfaces, isMobile, server, windowParam]);
  const topBarSlot = useMemo(
    () => ({
      sessions,
      currentSession,
      currentWindow,
      sessionName: displaySession,
      windowName: displayName,
      sidebarOpen,
      server,
      onNavigate: navigateToWindow,
      onToggleSidebar,
      onCreateWindow: handleCreateWindow,
      onSpawnAgent: handleSlotSpawnAgent,
      // Top-bar surface-toggle group: the tile surfaces the current window
      // offers (shortcut order) plus the mode discriminant — desktop registers
      // TOGGLE mode (the open tiles + the shared toggle mutation); mobile
      // registers SWITCH mode (the visible tile + the switch-to-tile verb),
      // gated on ≥2 available surfaces (with fewer there is nothing to switch
      // to — no group). Absent on board/host routes → no group.
      surfaceToggles:
        windowParam && !isMobile
          ? {
              mode: "toggle" as const,
              available: panelSurfaces,
              open: openToggleKinds,
              onToggle: togglePanel,
              canAdd: canAddTile,
              away: surfaceAway,
              popped: surfacePopped,
              showDot: surfaceDot,
            }
          : windowParam && panelSurfaces.length >= 2
            ? {
                mode: "switch" as const,
                available: panelSurfaces,
                active: mobileActiveTile,
                onSwitch: switchToTile,
                // A not-open surface whose growth is disallowed (no split
                // fits the size floor) renders disabled instead of no-oping silently.
                disabled: switchTargetDisabled,
                showDot: surfaceDot,
              }
            : undefined,
      // The gui header fold's mobile bottom rung: the top bar pins the ⚙
      // block beside the switch group when the visible mobile surface is gui
      // (TopBar owns that gate). The panel mirrors `guiActions` by row id and
      // its open state is the `rk-gui-toolbar` posture.
      guiToolbar: windowParam
        ? {
            actions: guiActions,
            quality: guiQuality,
            visible: guiToolbarVisible,
            onVisibleChange: handleGuiToolbarVisibleChange,
          }
        : undefined,
      // ▦ Layout chip machinery (260812-ab5v R9): the on-screen layout + the
      // single mutation path. The top bar's chip/rows jump presets through
      // `applyLayout` like every other mutation. Disabled while this viewer
      // has a tile popped out (a template resolved on the reduced render
      // would strand the popped leaf).
      layout,
      onApplyLayout: applyLayout,
      layoutTemplatesDisabled: popped.length > 0,
    }),
    [
      sessions,
      currentSession,
      currentWindow,
      displaySession,
      displayName,
      sidebarOpen,
      server,
      navigateToWindow,
      onToggleSidebar,
      handleCreateWindow,
      handleSlotSpawnAgent,
      windowParam,
      isMobile,
      panelSurfaces,
      togglePanel,
      canAddTile,
      surfaceAway,
      surfacePopped,
      openToggleKinds,
      surfaceDot,
      mobileActiveTile,
      switchToTile,
      switchTargetDisabled,
      guiActions,
      guiQuality,
      guiToolbarVisible,
      handleGuiToolbarVisibleChange,
      layout,
      applyLayout,
      popped,
    ],
  );
  useRegisterTopBarSlot(topBarSlot);

  // Pending-switch mask (260715-38kg): subscribe to the pure mask-signal state
  // machine in `window-transition.ts`. `"masked"` renders a full LogoSpinner
  // waiting mask over the terminal surface (armed at gate timeout / grace-timer
  // threshold, lifted on the incoming window's late first write). The module
  // owns arm/lift/teardown — this component only renders the current state.
  // Called BEFORE the early-return guards below to keep hook order stable.
  const showSwitchMask = useSyncExternalStore(subscribeMaskState, getMaskState) === "masked";

  // Three-way route guard. Distinguishes a just-created server (brief waiting
  // state) from a genuinely-unknown one (not found), keyed on `serversLoaded`
  // (NOT `servers.length > 0`, which fired not-found prematurely when the user
  // already had servers and the post-create refresh hadn't landed yet).
  const serverView = resolveServerView(server, servers, pendingServer, serversLoaded);
  if (serverView === "waiting") {
    return <ServerWaiting serverName={server} />;
  }
  if (serverView === "not-found") {
    return <ServerNotFound serverName={server} />;
  }

  // The all-popped placeholder's rows: one per popped leaf still in the
  // shared tree, foreign leaves disambiguated by their home window's name
  // (the `Tile: Bring … here` labeling convention).
  const poppedRows: PoppedLeafRow[] = popped
    .filter((id) => leafIds(layout).includes(id))
    .map((id) => {
      const home = parseLeafAddress(id)?.home;
      return {
        leafId: id,
        kind: zoomLeafKind(id) ?? "tty",
        homeName: home !== undefined ? (windowsById.get(home)?.name ?? home) : undefined,
      };
    });

  // Sidebar element — shared between the desktop grid placement and the
  // mobile overlay (the Shell component renders one or the other).
  const sidebarElement = (
    <Sidebar
      currentServer={server || null}
      currentSession={sessionName ?? null}
      currentWindowId={windowParam ?? null}
      isConnected={dotConnected}
      onSelectWindow={handleSidebarSelectWindow}
      onWaitingBadgeClick={handleWaitingBadgeClick}
      onCreateWindow={handleSidebarCreateWindow}
      onCreateSession={handleSidebarCreateSession}
      onSpawnAgent={handleOpenSpawnAgent}
      onUpdateAnnotations={hasOperatorWindow ? handleUpdateAnnotations : undefined}
      onWindowMarkerChange={handleWindowMarkerChange}
      onForkWindow={handleForkWindow}
      onFixTabName={handleFixTabName}
      onOperatorCompose={hasOperatorWindow ? handleOperatorCompose : undefined}
      onOperatorPlaceholder={handleOperatorPlaceholder}
      onCreateServer={openCreateServer}
      onKillServer={requestKillServer}
      onSidebarResizeStart={isMobile ? undefined : (e) => handleDragStart(e.clientX)}
    />
  );

  return (
    <Shell
      // The popout posture is chrome-less: no sidebar, no status bar, no
      // bottom bar / compose strip — one tile fills the window.
      sidebarChildren={popoutPosture ? null : sidebarElement}
      // Zen mode (260820-o8cr R3): the render-time sidebar hide — Shell
      // composes `sidebarOpen && !zenActive`; the persisted preference is
      // never touched on a zen path.
      zenActive={zenOn}
      // Status bar (260814-ldbs): the full-width attached strip at the shell
      // bottom — Shell renders it as the `statusbar` row on desktop (never
      // mobile). The window cluster mirrors the CURRENT window's registers
      // (terminal route only — `currentWindow` is null without a window
      // param); the host cluster renders on every route this shell mounts.
      // The cluster yields (`window={null}`, the board mount's contract) while
      // the PANE panel is on screen — see `paneRegistersVisible`.
      // Zen keeps the bar VISIBLE and adds its exit affordance there (R5/R8).
      statusBarChildren={
        popoutPosture ? null : (
        <StatusBar
          window={paneRegistersVisible ? null : currentWindow ?? null}
          server={server}
          isConnected={dotConnected}
          onOpenCompose={toggleComposeStrip}
          zenActive={zenOn}
          onExitZen={zenOn ? toggleZen : undefined}
        />
        )
      }
      // Bottom-bar row: Shell owns the `<footer
      // gridArea:"bottombar">` placement — inside the stage's content column
      // on desktop, in the outer grid on mobile. BottomBar self-gates on pointer type — fine pointers
      // render nothing (the key chips are touch affordances; ⌘K + compose
      // relocated to the status bar), so the `auto` row collapses to zero
      // height there (the 260814-ink6 no-reserved-height property).
      bottomBarChildren={
        popoutPosture ? null : (
        <>
          {composeStripVisible && !inTileDock && composeStripElement}
          <BottomBar
            onOpenCompose={toggleComposeStrip}
            onFocusTerminal={() => focusTerminalRef.current?.()}
          />
        </>
        )
      }
      sidebarResizing={isDragging}
      sidebarResizeHandle={
        // Drag handle — Shell places it in a zero-width grid item pinned to
        // the sidebar card's right edge, so the 14px hit zone straddles the
        // 6px stage gap (the `rk-divider` gap-seam chrome — rest grip dots,
        // accent sash pill on hover/drag — is the tile-divider vocabulary).
        // All drag state/handlers stay here in AppShell.
        <div
          className={`rk-divider absolute top-0 bottom-0 left-[3px] w-3.5 -translate-x-1/2 cursor-col-resize ${isDragging ? "rk-sash-lit" : ""}`}
          onPointerDown={handleDragHandlePointerDown}
          style={{ touchAction: "none" }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
        >
          <span aria-hidden="true" className="rk-sash rk-sash-v pointer-events-none" />
          <span aria-hidden="true" className="rk-grips rk-grips-v pointer-events-none">
            <i />
            <i />
            <i />
          </span>
        </div>
      }
    >
      {/* The desktop sidebar aside is now Shell-owned (260719-rwqf): AppShell
          passes `sidebarChildren` + `sidebarResizeHandle` and Shell renders the
          `<aside gridArea:"sidebar">` (gated `!isMobile && sidebarOpen`). */}

      {/* Top bar mount moved to the persistent root layout (260707-4vq2) —
          AppShell publishes its TopBar props into the slot context instead
          (see the `useRegisterTopBarSlot` effect above). The `terminal` vs
          `root` mode distinction is derived at root from the route params. */}

      {/* Content grid area. The stage ground (`bg-bg-inset`) is universal now,
          so the main carries no ground color of its own. In `fixedWidth` mode
          the centered 900px column is a card on that ground (`rounded-md` +
          the dimmed `rk-card-border` + `bg-bg-primary`) — this is also what
          frames the server route's SessionTiles column. */}
      <main
        style={{ gridArea: "content" }}
        className="min-w-0 flex flex-col overflow-hidden"
      >
        {/* The terminal content surface. `viewTransitionName` scopes the
            window-switch slide (260703-l4nf) to this region only — sidebar,
            top bar, and bottom bar (outside <main>) stay static. Pure
            transforms on the ::view-transition pseudo-elements (globals.css)
            mean no layout change, so the terminal's ResizeObserver/fitAndSync
            never fires and tmux sees no resize churn. */}
        <div
          className={`relative flex-1 min-h-0 flex flex-col ${fixedWidth ? "rounded-md border rk-card-border bg-bg-primary overflow-hidden" : ""}`}
          style={{
            viewTransitionName: "terminal-surface",
            ...(fixedWidth ? { maxWidth: 900, width: "100%", marginInline: "auto" } : {}),
          }}
          // Block keyboard input to the OLD window while the pending-switch mask
          // is up (260715-38kg): the hazard being fixed is typing into the window
          // you THINK you left. Capture-phase intercept runs before xterm's
          // hidden-textarea handler; keystrokes are DROPPED, not buffered/replayed
          // (assumption 10). Pointer input is blocked by the overlay's own
          // `pointer-events` below. Global chords survive the swallow (rework F2
          // — constitution V: Cmd+K is the primary discovery mechanism): Escape,
          // meta chords, and the Ctrl-bound global chords pass through per
          // `isMaskExemptKey`; terminal-bound input (plain typing, Ctrl+C) stays
          // dropped.
          onKeyDownCapture={
            showSwitchMask
              ? (e) => {
                  if (isMaskExemptKey(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                }
              : undefined
          }
        >
          {/* Pending-switch spinner mask (260715-38kg). A FULL waiting mask over
              the terminal surface — never a dimmed overlay — fully hiding the
              stale bytes while a switch is in transit ("don't type"). Armed at
              the 300ms gate-timeout / grace-timer threshold (NEVER at click
              time), lifted as a cut/fast-fade on the incoming window's late
              first write. `pointer-events: auto` (via the class) swallows clicks
              on the old window. */}
          {showSwitchMask && (
            <div
              className="rk-window-switch-mask"
              role="status"
              aria-live="polite"
              aria-label="Switching tab"
            >
              <LogoSpinner size={48} />
            </div>
          )}
          {/* The operator page's segmented header —
              mounts only under the `operatorPage` gate, so every other
              route/form factor renders nothing here. The tongue clearance is
              mobile-only (the tongue never renders on desktop). */}
          {operatorPage && <TerminalActivityTabs clearTongue={isMobile} />}
          {/* Surface-layout column (260812-ab5v-surface-layout-core, spec
              surface-layout.md): the tile grid (SurfaceLayout) renders the
              RESOLVED layout as 1–N tiles (offers gated by the size floor)
              mounting the existing renderers
              unchanged — it SUBSUMES both the legacy exclusive-lens branch
              (the palette `View:` actions drive `single:<view>` through
              applyLayout — R12) and the right-panel surface mount (the panel
              slot is a
              tile now — R6). Open-tile toggles (R10) live in the top bar's
              surface-toggle group. On a non-terminal tab (Operator Tasks,
              Cron List, Cron Log) this column stays
              MOUNTED-but-hidden (the `hidden` class — the same
              hide-never-unmount posture SurfaceLayout applies to its own
              hidden tiles), so the terminal stream survives the tab swap and
              switching back needs no reconnect. */}
          <div className={terminalHidden || allPopped ? "flex-1 min-w-0 min-h-0 flex-col hidden" : "flex-1 min-w-0 min-h-0 flex flex-col"}>
          {/* Render gate keys on `windowParam` (the URL's @N) ALONE, not the
              SSE-derived `sessionName`. The session name is only needed for the
              breadcrumb/title and resolves a beat after the first snapshot; the
              terminal itself connects by window id, so gating on the derived
              session would needlessly delay the mount on a cold deep-link (and
              briefly flash the Dashboard). */}
          {windowParam ? (
            // The ended popout (its surface's window left the payload):
            // chrome-less, no navigation, the surface unmounted.
            popoutEnded ? (
              <PopoutEnded />
            ) : (
            <SurfaceLayout
              // Keyed by SERVER only: a same-server window switch re-renders
              // the mounted grid with a new `windowId` prop — the tty tile's
              // TerminalClient (xterm instance + relay stream) must survive so
              // the relay's same-session ride and deferred-reset/clear designs
              // apply, and the code tile's frame survives via the component's
              // per-server frame LRU (keyed by the frame record's
              // windowId + creation src, stable across window switches).
              // Per-window transient state (zoom, focused slot, the
              // hide-never-unmount set, find, page title, progress) resets by
              // a `[server, windowId]` effect inside the component; web/gui
              // tiles remount via `windowId` in their own keys.
              key={server}
              // The rendered layout: the payload's `@rk_win_layout` value,
              // overlaid by the optimistic `pendingLayout` while a verb's
              // POST is in flight, REDUCED by this viewer's popped set (the
              // opener hides popped tiles for itself only) — or the popout's
              // single-leaf tree in the popout posture. Mutations keep
              // computing from the full shared tree.
              layout={renderLayout}
              server={server}
              windowId={windowParam}
              sessionName={sessionName ?? ""}
              // A UI-initiated switch records its intent (`pendingClickRef`)
              // in the same tick as the navigate, before this render: only then
              // may the tty tile arm its deferred buffer clear. A tmux/SSE-
              // driven URL writeback carries no intent — the attached client
              // already redrew, so the clear must stay off.
              clearOnWindowChange={isSamePendingTarget(pendingClickRef.current, server, windowParam)}
              // The payload's window record: the code tile reads the shared
              // code root (`codeRootFor`), the web tile the active web tab.
              window={effectiveWindow}
              // The route server's window map — a foreign leaf's tile resolves
              // its HOME window's record (name, status, code root, web tabs)
              // from it; the session map feeds the foreign tile's relay
              // connection identity and focus registration.
              windowsById={windowsById}
              sessionNameByWindowId={sessionNameByWindowId}
              isMobile={
                // The popout is a desktop-only posture and its window is
                // sized from the tile's rect — often under the 640px mobile
                // breakpoint. Force the desktop branch: the mobile branch
                // renders no tile header, and the header carries the popout's
                // Pop back in verb.
                popoutPosture ? false : isMobile
              }
              // On mobile the top-bar switch group picks which leaf renders
              // (per-viewer — the zoom key; the layout itself is untouched
              // for an already-open surface). Reading-order index.
              mobileActiveSlot={leaves(renderLayout).indexOf(mobileActiveTile)}
              wsRef={wsRef}
              focusRef={focusTerminalRef}
              scrollLocked={scrollLocked}
              onSessionNotFound={
                // The popout never navigates: a dead stream leaves the ended
                // state to the payload-driven `popoutEnded` render.
                popoutPosture
                  ? () => {}
                  : () => navigate({ to: "/$server", params: { server }, replace: true })
              }
              // Popout posture: the chrome-less single-tile render — the
              // header's Pop back in verb closes this window (the opener
              // clears its mark on the `closed` channel message). Opener
              // posture: this viewer's popped set (hidden tiles, disarmed
              // header drag, evicted popped code frames) and the header's
              // Pop out verb (absent on mobile and in a shell without the
              // `windows.popout` channel — the shell's window.open policy
              // sends everything to the system browser, which shares neither
              // localStorage nor the channel with the opener).
              popoutLeafId={popoutPosture && popLeaf !== null ? popLeaf.leafId : undefined}
              onPopBackIn={popoutPosture ? popoutPresence.closeSelf : undefined}
              popped={popped.length > 0 ? popped : undefined}
              onPopOut={
                !isMobile && (!isShell() || canShellPopout())
                  ? (leafId, rect) => popOut(leafId, rect)
                  : undefined
              }
              // The revealed subset of `popped`: those leaves stayed in the
              // rendered tree (the reduction above kept them) and mount the
              // popped placeholder — bring back pops in, go to window focuses
              // the live popout, ✕ hides the placeholder (per viewer only).
              revealedPoppedIds={revealed.length > 0 ? revealed : undefined}
              onPopIn={popIn}
              onFocusPopout={focusPopout}
              onHidePopped={hideRevealedPopped}
              codeReachable={codeServer?.reachable ?? false}
              // The gui tile: the host signal (content selection), the
              // per-viewer postures, the RFB connection report (the toggle
              // dot), the empty-state verbs, and the palette command seam.
              gui={gui}
              guiZoom={guiZoom}
              guiPointerMode={guiPointerMode}
              onGuiZoomChange={handleGuiZoomChange}
              onGuiPointerModeChange={handleGuiPointerModeChange}
              guiHidpi={guiHidpi}
              guiKeyBarVisible={guiKeyBarVisible}
              onGuiKeyBarVisibleChange={handleGuiKeyBarVisibleChange}
              guiToolbarVisible={guiToolbarVisible}
              onGuiToolbarVisibleChange={handleGuiToolbarVisibleChange}
              guiCapture={guiCapture}
              webCapture={webCapture}
              onWebCaptureChange={handleWebCaptureChange}
              guiResizeLocked={guiResizeLocked}
              guiQuality={guiQuality}
              guiStatsVisible={guiStatsVisible}
              onGuiQualityChange={handleGuiQualityChange}
              onGuiStatsVisibleChange={handleGuiStatsVisibleChange}
              onGuiConnection={setGuiConnected}
              onGuiRestart={restartGui}
              onCodeServerRestart={restartCodeServer}
              onGuiOpenLogs={openGuiLogs}
              guiCommandsRef={guiCommandsRef}
              // The header toolbar mirrors this exact palette list by row id.
              guiActions={guiActions}
              // Follow rule: after the seed, the writers of
              // `@rk_win_code_root` are the editor's own navigation AND the
              // explicit Follow terminal verb (the code tile's header) —
              // never the terminal on its own.
              onCodeFolderNavigated={handleCodeFolderNavigated}
              onCodeFollowTerminal={handleCodeFollowTerminal}
              codeCommandsRef={codeCommandsRef}
              // Mount gating (the derivation GET lives in this component's
              // layout-state block): `codeSrcFor` is the per-window lookup
              // over the hook's resolved-src map — a null read for the active
              // window renders the code tile's pending state until the
              // workspace path resolves, and a revisit resolves
              // synchronously. `liveWindowIds`/`codeRootForWindow` feed the
              // kill and root-divergence evictions.
              codeSrcFor={codeSrcFor}
              liveWindowIds={liveWindowIds}
              codeRootForWindow={codeRootForWindow}
              // The follow rule's re-navigation: nonce-keyed, so only an
              // editor-initiated folder navigation ever moves a live frame.
              codeFollowSrc={followSrc}
              // The first-boot rescue's status reads (baseline + verdict) per
              // code-tile mount generation — a per-window factory because a
              // retained frame's verdict can fire after its window stopped
              // being active.
              fetchBridgeStatusFor={fetchBridgeStatusFor}
              shouldReclaimChord={reclaimChordForKind}
              // Leaf-rect seam: the desktop add/directional-swap verbs read
              // the leaves' real geometry through this getter.
              layoutRectsRef={layoutRectsRef}
              // Tile verbs address their leaf by ID (duplicate tty tiles are
              // distinct leaves); a disallowed close is null. The header
              // drag-to-snap commit rides the ONE layout mutation path with
              // the drop's resolved result tree.
              onApplyLayout={applyLayout}
              onClose={(leafId) => {
                const next = closeSurface(layout, leafId);
                if (next) applyLayout(next);
              }}
              // Cross-tab move verbs: the placeholder's bring back (from =
              // the holder) and the foreign tile header's ↩ (from = the route
              // window) ride the return endpoint; the placeholder's "go to"
              // navigates to the holder's route; the sidebar row-drag's drop
              // rides the borrow helper (plain apply when unheld).
              onSendHome={sendHome}
              onGoToWindow={navigateToWindow}
              onBorrowDrop={borrowInto}
              // tty pane-segment verbs (260813-w1lf): the tile header's
              // Split H / Split V / Close Pane buttons ride the same
              // optimistic actions the palette split/close entries use,
              // targeted at the TILE's own window (a foreign tty tile's home)
              // and that window's worktree.
              onSplitPane={(horizontal, tileWindowId) =>
                executeSplit(
                  server,
                  tileWindowId,
                  horizontal,
                  windowsById.get(tileWindowId)?.worktreePath,
                )
              }
              onClosePane={(tileWindowId) => executeClosePane(server, tileWindowId)}
              // ⏶ Zoom palette seam (T012/R11): the component owns the
              // transient zoom state and registers its focused-slot toggle
              // here (260819-qwr7 R7); flips report back so the
              // `Layout: Expand`/`Restore` palette entries stay fresh.
              zoomToggleRef={layoutZoomToggleRef}
              onZoomChange={setLayoutZoomed}
              // Focused tile (260812-wfic R2/R10): the component owns the
              // focused LEAF and reports the focused KIND (the ttyOnly chord
              // gate) plus the leaf id (the palette's directional swaps); the
              // palette's `Tile: Focus <Surface>` entries drive focus through
              // the ref seam.
              onFocusedKindChange={(kind) =>
                setReportedFocusedKind({ key: focusWindowKey, kind })
              }
              onFocusedLeafChange={(leafId) =>
                setReportedFocusedLeafId({ key: focusWindowKey, leafId })
              }
              focusTileRef={layoutFocusTileRef}
              // Steal guard (spec right-panel.md § The code lens): the code
              // tile's iframe-element focus events route here — armed guard +
              // remembered kind ≠ `code` reverts the workbench's grab.
              onProgrammaticFocus={revertProgrammaticFocus}
              // tty header status dot (R6): the SSE window record — consumed
              // by tty tile headers only (no dot when null/non-tty).
              statusWindow={currentWindow ?? null}
              // In-tile compose-strip dock (260813-j3jb): the shared strip
              // element mounts inside the FIRST tty tile when the in-tile
              // predicate holds; otherwise the shell footer below renders it.
              ttyDockContent={inTileDock ? composeStripElement : undefined}
              // tty find decorations derive their amber/green from the active
              // theme (the addon requires concrete #RRGGBB colors).
              themePalette={activeTheme.palette}
            />
            )
          ) : (
            <SessionTiles
              server={server}
              sessions={sessions}
              onNavigate={navigateToWindow}
              onCreateSession={handleCreateSessionInstant}
              onCreateWindow={handleCreateWindow}
              footer={
                <ServerWatchedZone
                  server={server}
                  sessions={sessions}
                  onNavigate={navigateToWindow}
                />
              }
            />
          )}
          </div>
          {/* The all-popped placeholder (spec surface-layout.md § Verbs → Pop
              out): when this viewer has EVERY leaf popped, the reduced tree
              is empty and a layout never renders empty — the placeholder
              takes the area while the tiles stay mounted-hidden above (their
              streams survive). */}
          {allPopped && windowParam && (
            <PoppedOutPlaceholder leaves={poppedRows} onPopIn={popIn} />
          )}
          {/* The non-terminal tabs' content swap: the watchlist / cron body
              takes the slot the SurfaceLayout column vacates (hidden, not
              unmounted, above). The cron tabs pin the stale banner above
              the body. */}
          {tasksTabActive && (
            <WatchedTasks server={server} sessions={sessions} onNavigate={navigateToWindow} />
          )}
          {cronTabActive && (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <CronStaleBanner server={server} />
              {quakeTab === "list" ? (
                <CronList server={server} />
              ) : (
                <CronLog server={server} />
              )}
            </div>
          )}
        </div>
      </main>

      {/* Bottom bar + shell-docked compose strip moved OUT of the children
          into Shell's `bottomBarChildren` slot (260814-ldbs): Shell renders
          the footer inside the stage's content column. The compose strip's dock predicate is unchanged — the
          strip renders ABOVE the bottom bar inside the bottombar row UNLESS
          the in-tile dock hosts it (260813-j3jb — desktop terminal route,
          tty tile present, no selection broadcast); its presence grows the
          `auto` footer row and shrinks the `1fr` content row, so the
          terminal's ResizeObserver refits automatically (260718-dhdj). */}

      {/* Dialogs */}
      {sessionNamePrompt && (
        <Suspense fallback={null}>
          <SessionNamePrompt
            sessions={sessions}
            defaultName={sessionNamePrompt.defaultName}
            onSubmit={handleSessionNamePromptSubmit}
            onClose={() => setSessionNamePrompt(null)}
          />
        </Suspense>
      )}

      {guiGeometryPromptOpen && (
        <Suspense fallback={null}>
          <GuiGeometryPrompt
            onSubmit={(geometry) => {
              setGuiGeometryPromptOpen(false);
              resizeGuiDesktop(geometry);
            }}
            onClose={() => setGuiGeometryPromptOpen(false)}
          />
        </Suspense>
      )}

      {guiSendKeyOpen && (
        <Suspense fallback={null}>
          <GuiSendKeyPrompt
            onSubmit={submitGuiSendKey}
            onClose={() => setGuiSendKeyOpen(false)}
          />
        </Suspense>
      )}

      {showCreateWindowAtFolderDialog && sessionName && (
        <Suspense fallback={null}>
          <CreateSessionDialog
            sessions={sessions}
            session={sessionName}
            defaultPath={currentWindow?.worktreePath}
            onClose={() => setShowCreateWindowAtFolderDialog(false)}
          />
        </Suspense>
      )}

      {spawnAgentTarget && (
        <Suspense fallback={null}>
          <SpawnAgentDialog
            server={spawnAgentTarget.server}
            session={spawnAgentTarget.session}
            onSpawned={(windowId) => navigateToSpawnedWindow(spawnAgentTarget.server, windowId)}
            onClose={() => setSpawnAgentTarget(null)}
          />
        </Suspense>
      )}

      {operatorComposeMode != null && server && (
        <Suspense fallback={null}>
          <OperatorComposeDialog
            server={server}
            initialMode={operatorComposeMode}
            onClose={() => setOperatorComposeMode(null)}
          />
        </Suspense>
      )}

      {cronCreateOpen && server && (
        <CronCreateDialog server={server} onClose={() => setCronCreateOpen(false)} />
      )}

      {/* Cron delete confirm — the palette `Cron: delete…` picker's landing;
          the kill-confirm idiom (Cancel neutral / Delete danger). */}
      {cronDeleteTarget && server && (
        <Dialog title="Delete cron entry?" onClose={() => setCronDeleteTarget(null)}>
          <p className="text-sm text-text-secondary mb-3">
            Delete cron entry <strong>{cronDeleteTarget.name || cronDeleteTarget.id}</strong>?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setCronDeleteTarget(null)}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const target = cronDeleteTarget;
                void deleteCron(server, target.id)
                  .then(() => setCronDeleteTarget(null))
                  .catch((err: unknown) =>
                    addToast(err instanceof Error && err.message ? err.message : "Delete failed", "error"),
                  );
              }}
              className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}

      {noteTarget && (
        <Suspense fallback={null}>
          <WindowNotePrompt
            defaultNote={noteTarget.note}
            onSubmit={handleNoteSubmit}
            onClose={() => setNoteTarget(null)}
          />
        </Suspense>
      )}

      {showCreateIframeDialog && sessionName && (
        <Dialog title="New iframe tab" onClose={() => { setShowCreateIframeDialog(false); setIframeWindowName(""); setIframeWindowUrl(""); }}>
          <input
            autoFocus
            type="text"
            value={iframeWindowName}
            onChange={(e) => setIframeWindowName(toSafeWindowName(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // Focus URL input on Enter from name
                const next = (e.target as HTMLElement).parentElement?.querySelector<HTMLInputElement>('input[aria-label="URL"]');
                next?.focus();
              }
            }}
            aria-label="Tab name"
            placeholder="Tab name..."
            className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
          />
          <input
            type="text"
            value={iframeWindowUrl}
            onChange={(e) => setIframeWindowUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateIframeWindow()}
            aria-label="URL"
            placeholder="http://localhost:8080"
            className={`w-full bg-transparent text-text-primary p-2 mt-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
          />
          <button
            onClick={handleCreateIframeWindow}
            disabled={!iframeWindowName.trim() || !iframeWindowUrl.trim()}
            className={`mt-2.5 w-full ${controlClass({ variant: "wide", disabled: !iframeWindowName.trim() || !iframeWindowUrl.trim() })}`}
          >
            Create
          </button>
        </Dialog>
      )}


      {dialogs.showRenameSessionDialog && (
        <Dialog title="Rename session" onClose={dialogs.closeRenameSessionDialog}>
          <input
            autoFocus
            type="text"
            value={dialogs.renameSessionName}
            onChange={(e) => dialogs.setRenameSessionName(toSafeSessionName(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && dialogs.handleRenameSession()}
            onFocus={(e) => e.target.select()}
            aria-label="Session name"
            placeholder="Session name..."
            className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
          />
          <button
            onClick={dialogs.handleRenameSession}
            className={`mt-2.5 w-full ${controlClass({ variant: "wide" })}`}
          >
            Rename
          </button>
        </Dialog>
      )}

      {dialogs.showKillConfirm && (
        <Dialog title="Kill tab?" onClose={dialogs.closeKillConfirm}>
          <p className="text-text-secondary mb-2.5">
            Kill tab <strong>{displayName}</strong>? This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              onClick={dialogs.closeKillConfirm}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
            <button
              onClick={dialogs.handleKillWindow}
              className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
            >
              Kill
            </button>
          </div>
        </Dialog>
      )}

      {dialogs.showKillSessionConfirm && (
        <Dialog title="Kill session?" onClose={dialogs.closeKillSessionConfirm}>
          <p className="text-text-secondary mb-2.5">
            Kill session <strong>{displaySession}</strong> and all its tabs? This cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              onClick={dialogs.closeKillSessionConfirm}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
            <button
              onClick={dialogs.handleKillSession}
              className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
            >
              Kill
            </button>
          </div>
        </Dialog>
      )}

      {/* Server create/kill dialogs moved to the single layout-level mount
          (`components/server-dialogs.tsx`, 260811-239r) — this shell triggers
          them via `server-dialogs-context`. */}

      {showTmuxCommands && sessionName && currentWindow && (
        <TmuxCommandsDialog
          server={server}
          session={sessionName}
          windowId={currentWindow.windowId}
          onClose={() => setShowTmuxCommands(false)}
        />
      )}

      {showColorPicker && (
        <Suspense fallback={null}>
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
            onClick={() => setShowColorPicker(null)}
          >
            <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
            <div onClick={(e) => e.stopPropagation()}>
              <SwatchPopover
                selectedColor={
                  showColorPicker === "session"
                    ? currentSession?.sessionColor
                    : showColorPicker === "window"
                      ? currentWindow?.color
                      : undefined
                }
                rowName={
                  showColorPicker === "session"
                    ? sessionName
                    : showColorPicker === "window"
                      ? currentWindow?.name
                      : server
                }
                // Selection does NOT close (the picker's dismissal contract) —
                // dismissal is the ✕ cell, the backdrop click, or Escape.
                onSelect={(c) => {
                  if (showColorPicker === "session" && sessionName) {
                    setSessionColorApi(server, sessionName, c).catch((err) =>
                      addToast(err.message || "Failed to set session color"),
                    );
                  } else if (showColorPicker === "window" && sessionName && currentWindow) {
                    setWindowColorApi(server, currentWindow.windowId, c).catch((err) =>
                      addToast(err.message || "Failed to set tab color"),
                    );
                  } else if (showColorPicker === "server") {
                    setServerColorApi(server, c).catch((err) =>
                      addToast(err.message || "Failed to set server color"),
                    );
                  }
                }}
                onClose={() => setShowColorPicker(null)}
              />
            </div>
          </div>
        </Suspense>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={async (e) => {
          const { files } = e.target;
          if (!files || files.length === 0) {
            return;
          }

          const formData = new FormData();
          Array.from(files).forEach((file) => {
            formData.append("files", file);
          });

          try {
            await fetch("/api/upload", {
              method: "POST",
              body: formData,
            });
          } finally {
            // Reset the input so the same file can be selected again later.
            e.target.value = "";
          }
        }}
      />

      {/* The command palette + shortcuts overlay mount ONCE in AppLayout now
          (260811-239r): the palette renders this route's registered actions
          ahead of the layout-level globals; the overlay's state is
          layout-owned. */}

      <Suspense fallback={null}>
        <ThemeSelector />
      </Suspense>
    </Shell>
  );
}
