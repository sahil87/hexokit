/**
 * Main process — lifecycle, the multi-window BrowserWindow registry, per-
 * (window, host) WebContentsViews, security wiring, IPC, the welcome ↔
 * host-view routing, and local-daemon control. ("Host" = an rk instance;
 * "server" is reserved for tmux servers. The `servers:*` IPC channels and
 * the bridge's `servers` group keep their names — they are the web SPA's
 * contract.)
 *
 * ONE PROCESS, MANY WINDOWS: `requestSingleInstanceLock` keeps userData
 * single-owner (a lock-less launch quits; `second-instance` opens a new
 * window HERE), and a window registry replaces the v1 single `mainWindow`.
 * Host content renders in ONE PERSISTENT WebContentsView PER (WINDOW, HOST)
 * pair (created lazily, kept alive until the host is removed or the window
 * is torn down), so a host switch is an instant detach/attach flip that
 * preserves live renderer state — WS/SSE connections, xterm scrollback,
 * scroll position — never a reload. The same host may show in N windows,
 * each an independent view; views never migrate between windows. Each
 * window's own webContents serves only the welcome page. Per-view decision
 * logic + badge/theme caches: ./views (electron-free, node:test covered);
 * window decisions (duplication targets, titles, restore): ./window-registry;
 * the cold-start window-set store: ./windows (windows.json).
 *
 * Web-tile GUEST views (the SPA's native-engine web tabs) are per-(window,
 * host, tabKey) WebContentsViews attached as SIBLINGS of the host view on the
 * window's contentView (a child of the host view never paints — Electron
 * 43/Linux), in a dedicated hardened partition with NO preload. Their
 * registry (./web-views, electron-free, node:test covered) is the z-order
 * authority: addChildView(host) raises the host above its guests, so the
 * attach seam re-raises the incoming host's guests and the detach seam hides
 * the outgoing host's. The `web:*` IPC surface — create/destroy/bounds/
 * visible/load/reload plus the parity channels back/forward/find/stop-find/
 * zoom/chords/devtools and the per-host mode query — is gated on a
 * registered-host sender that owns a
 * host view, plus tabKey membership under that sender. Every guest event
 * relays to the owning host webContents on the single `web:event` channel
 * (title/favicon/loading/failed/url+httpStatus/focus/find/chord/zoom). Chord
 * reclaim runs through `before-input-event` matched against the per-guest
 * SPA-uploaded table (pure matcher in ./chords, electron-free, node:test
 * covered): a match is preventDefaulted, hops focus to the host webContents,
 * and relays `chord` for the SPA to re-dispatch.
 *
 * This shell is a VIEWER (Constitution VI): it loads an existing `rk serve`
 * URL and NEVER spawns or supervises the rk daemon on its own initiative.
 * child_process is used ONLY for explicit user-initiated actions — `rk daemon`
 * start/stop/restart via the welcome card or the Daemon menu, and
 * `rk desktop update` via the App menu's Restart-to-Update click — and
 * read-only detection (`rk url`, `rk --version`, `rk desktop status`). There
 * is no auto-start and no auto-update anywhere; the tmux/server layer stays
 * independent of this process, and the CLI (not the shell) is the updater.
 *
 * Dev override: `RK_DESKTOP_URL=http://localhost:6123 just dev-desktop`
 * loads that URL directly without persisting it to hosts.json (or
 * windows.json — sentinel windows are never persisted).
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  screen,
  session,
  shell,
  webContents,
  WebContents,
  WebContentsView,
} from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  augmentPath,
  DaemonAction,
  DaemonStatus,
  isDaemonAlreadyRunning,
  parseDaemonStatusRunning,
  parseRkVersion,
  parseSessionCount,
  resolveRkBinary,
  rkCandidatePaths,
  rkInvocationErrorMessage,
} from "./local-daemon";
import { badgePng, overlayDescription } from "./badge";
import {
  buildMenu,
  DaemonMenuInfo,
  MenuCallbacks,
  UpdateMenuInfo,
  WindowMenuEntry,
} from "./menu";
import {
  BLANK_UNDERLAY_URL,
  DEFAULT_STRIP_COLOR,
  fallbackStripCss,
  shouldInjectFallbackStrip,
  STRIP_HEIGHT_PX,
  symbolColorFor,
  welcomeStripColor,
} from "./strip";
import {
  createLineSplitter,
  parseConnectOrigin,
  parseRemoteAddOutput,
} from "./remote-host";
import { availableUpdateVersion, isUpdateCheckDue } from "./update-check";
import { guestNavigationAction, isEditorDeeplink, isHttpUrl, windowOpenAction } from "./window-open";
import {
  addHost,
  findHostByOrigin,
  HostInfo,
  hostInfos,
  isHostAccentHex,
  loadHosts,
  moveHost,
  normalizeOrigin,
  removeHost,
  resolveActiveHost,
  setActiveHost,
  setHostAccentColor,
  setHostLastPath,
  setHostName,
  setHostUrl,
} from "./hosts";
import {
  activateView,
  activeHostForWindow,
  activeView,
  addView,
  aggregateBadge,
  deactivateViews,
  emptyViews,
  ERR_ABORTED,
  findViewByWebContentsId,
  getView,
  LoadFlagEvent,
  nextLoadFailed,
  removeHostViews,
  removeWindowViews,
  setViewBadge,
  setViewThemeColor,
  switchPaint,
  ViewEntry,
  ViewsState,
} from "./views";
import {
  addWebView,
  adoptParkedWebView,
  emptyWebViews,
  findWebViewByContents,
  findWebViewBySender,
  hostAttachPlan,
  hostDetachPlan,
  isGuestContents,
  moveWebViewToWindow,
  parkWebView,
  parkWindowWebViewsInto,
  removeHostWebViews,
  removeHostWebViewsEverywhere,
  removeWebView,
  removeWindowWebViews,
  setWebViewBounds,
  setWebViewChords,
  setWebViewVisible,
  setWebViewZoomFactor,
  WebViewEntry,
  WebViewsState,
} from "./web-views";
import { findChord, parseChordSpecs, ChordSpec } from "./chords";
import {
  findPopoutWindow,
  parsePopoutPayload,
  PopoutRecord,
  stripPopParam,
} from "./popout";
import {
  guestPartitionName,
  settleHostProxy,
  WebProxyMode,
} from "./web-proxy";
import { createLocalProxy, LocalProxy, tunnelWsUrl } from "./tunnel-proxy";
import {
  loadWindows,
  saveWindows,
  WindowBounds,
  WindowRecord,
} from "./windows";
import { carryForwardLegacyUserData, retireLegacyUserData } from "./user-data-migration";
import {
  captureWindowRecord,
  hostRemovedFallback,
  newWindowTarget,
  restoreTargets,
  windowListItems,
  windowSetForSave,
  windowTitle,
} from "./window-registry";

const WELCOME_PATH = join(__dirname, "welcome", "welcome.html");
const WELCOME_URL = pathToFileURL(WELCOME_PATH).toString();
const INTERSTITIAL_PATH = join(__dirname, "interstitial", "interstitial.html");
const INTERSTITIAL_URL = pathToFileURL(INTERSTITIAL_PATH).toString();
const HEALTH_TIMEOUT_MS = 5000;
const INTERSTITIAL_HEALTH_POLL_MS = 3000;
/** Read-only rk queries (`rk url`, `rk --version`) — quick, config-derived. */
const RK_QUERY_TIMEOUT_MS = 5000;
/** Avoid re-running `rk url` for every 3s interstitial status IPC gate. */
const LOCAL_DAEMON_ORIGIN_CACHE_TTL_MS = 15_000;
/** `rk desktop status` — read-only, but round-trips the GitHub releases API. */
const RK_STATUS_TIMEOUT_MS = 10_000;
/** Daemon start/stop commands — bounded tmux work. */
const RK_DAEMON_TIMEOUT_MS = 30_000;
/** A full restart includes stop grace, port release, start, and tunnel reconnect. */
const RK_DAEMON_RESTART_TIMEOUT_MS = 60_000;
/** `rk remote add` — pure local registration, no ssh roundtrip. */
const RK_REMOTE_ADD_TIMEOUT_MS = 10_000;
/** `rk remote connect` — may bootstrap rk on the remote over ssh. */
const RK_REMOTE_CONNECT_TIMEOUT_MS = 300_000;
/** Suppression window for activation-time reconnects after a success. */
const REMOTE_RECONNECT_SUPPRESS_MS = 15_000;
/** Cadence + cap for the post-start "waiting for the port to answer" poll. */
const DAEMON_START_POLL_MS = 1000;
const DAEMON_START_WAIT_MS = 30_000;
const ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
]);

/** Dev-only direct URL (never persisted). Validated once: a value
 *  `normalizeOrigin` rejects (no scheme, non-http) is ignored — it could
 *  neither load nor pass the origin allowlist. The raw value (which may
 *  carry a path) is kept for loading; only its origin joins the allowlist. */
const rawDevUrl = process.env.RK_DESKTOP_URL;
const devUrl =
  rawDevUrl && normalizeOrigin(rawDevUrl).ok ? rawDevUrl : undefined;

/**
 * The window registry — insertion order IS window creation order (the
 * restore-order + menu-list order). Keyed on `BrowserWindow.id`.
 */
const windows = new Map<number, BrowserWindow>();

/**
 * Popout windows (the SPA's Pop out verb over `shell:popout`) — keyed on
 * `BrowserWindow.id`, dropped on `closed`. A popout is a same-host shell
 * window showing one `?pop=` route; it is never persisted to windows.json,
 * never switches host, and closes when its host is removed. The record's
 * (openerWindowId, hostId, route) triple is the dedupe key (a repeat Pop
 * out from the same opener focuses the live popout), and `openerWindowId`
 * scopes the web-guest move between the opener and the popout (./web-views).
 */
const popouts = new Map<number, PopoutRecord>();

/** Set by `before-quit` — a `close` during quit ACCUMULATES the window's
 *  record into `quitCaptures` (the whole set restores next launch); a user
 *  closing one of N windows drops only that window's record. */
let quitting = false;

/** Records captured during the current quit — each closing window adds its
 *  own (its registry entry is gone by the NEXT window's close), so the last
 *  quit-time save holds the whole set. Keyed by windowId. */
let quitCaptures = new Map<number, WindowRecord>();

/** Window creation order (ids) — the save order's base (the last-focused
 *  window's record goes last). Never spliced: the quit path needs the
 *  positions of windows already closed earlier in the same quit. */
const windowCreationOrder: number[] = [];

/** Per-(window, host) view registry — pure logic in ./views, handles are
 *  WebContentsViews. */
let views: ViewsState<WebContentsView> = emptyViews();

/** Composite key for the per-(window, host) in-memory flag maps. */
function viewKey(windowId: number, hostId: string): string {
  return `${windowId}:${hostId}`;
}

/** Per-(window, host) "last main-frame load failed" flags (view-scoped): the
 *  connect heals reload ONLY a failed view — a warm view keeps its live
 *  renderer state. Entries die with their view. */
const viewLoadFailed = new Map<string, boolean>();

interface InterstitialHealthPoll {
  timer: ReturnType<typeof setInterval>;
  inFlight: boolean;
}

/** Per-view read-only health polls; entries exist only while a recovery page is visible. */
const interstitialHealthPolls = new Map<string, InterstitialHealthPoll>();

/**
 * Reload a view stranded on a failed main-frame load, clearing its flag — the
 * shared tail of both connect heals (local daemon connect, SSH tunnel heal).
 * A view whose last load SUCCEEDED is never touched: keeping live renderer
 * state (WS relays, /ws/state, xterm scrollback) across a switch is the whole
 * point of the per-host view model, so the flag is the only thing that may
 * license a navigation here. The target is the host record's captured
 * `lastPath`, not the view's current route — a failed view sits on Chromium's
 * error page, where the captured path is the right destination.
 */
function reloadFailedView(
  windowId: number,
  host: { id: string; url: string; lastPath?: string },
): void {
  const key = viewKey(windowId, host.id);
  if (viewLoadFailed.get(key) !== true) return;
  const entry = getView(views, windowId, host.id);
  if (!entry || entry.handle.webContents.isDestroyed()) return;
  viewLoadFailed.set(key, false);
  void entry.handle.webContents.loadURL(host.url + (host.lastPath ?? ""));
}

/** Per-(window, host) "this SPA speaks accent:set" flags (view-scoped — the
 *  viewLoadFailed pattern): once a view has reported its raw accent, the
 *  did-change-theme-color seam stops persisting its 35% titlebar blend as
 *  accentColor — the blend would overwrite the full-strength value on every
 *  report. Hosts that never report keep the blend persistence (the older-SPA
 *  fallback). In-memory only: after a restart an early theme-color report may
 *  transiently re-persist the blend, and the SPA's initial-resolve accent
 *  report overwrites it — self-healing, no store schema. Entries die with
 *  their view. */
const rawAccentReported = new Map<string, boolean>();

/** Sentinel registry hostId for the RK_DESKTOP_URL dev view — never a store
 *  entry, so nothing about it (activeId, lastPath, window records) is ever
 *  persisted. */
const DEV_HOST_ID = "__dev__";

const PRODUCT_NAME = "HexoKit";

const userDataDir = (): string => app.getPath("userData");

// ─── Single-instance lock ────────────────────────────────────────────────────
//
// One process owns userData — two OS instances would collide on Chromium's
// LevelDB lock (the `open -n` hazard). A launch that fails to acquire the
// lock quits; the survivor's `second-instance` handler opens a NEW window
// (the same duplicate-of-current semantics as the menu item).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const focused = focusedWindow() ?? [...windows.values()][0] ?? null;
    openDuplicateWindow(focused);
  });
}

// Linux's dock badge (the Unity LauncherEntry D-Bus API behind
// app.setBadgeCount) keys on the app's DESKTOP NAME, which must match the
// .desktop filename the installer writes — without this the badge never
// associates with the launcher entry.
if (process.platform === "linux") {
  app.setDesktopName("hexokit-desktop.desktop");
}

type PingResult =
  | { ok: true; origin: string; hostname: string }
  | { ok: false; error: string };

type IpcResult = { ok: true } | { ok: false; error: string };

type DaemonActionResult =
  | { ok: true }
  | { ok: true; outcome: "declined" }
  | { ok: false; error: string };

/** `servers:list` envelope — the channel name AND the `servers` key are the SPA contract. */
type ServersListResult =
  | { ok: true; servers: HostInfo[] }
  | { ok: false; error: string };

/** `web:mode` envelope — the per-host web-tile load mode for the SPA. */
type WebModeResult =
  | { ok: true; mode: WebProxyMode }
  | { ok: false; error: string };

/** `shell:popout` envelope — the new popout window's id is the guest-move
 *  target the popout's own `web:create` adoption keys on. */
type PopoutResult =
  | { ok: true; windowId: number }
  | { ok: false; error: string };

type DaemonStatusResult =
  | { ok: true; status: DaemonStatus }
  | { ok: false; error: string };

// ─── URL helpers ────────────────────────────────────────────────────────────

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Origins the window may show in-place: registered hosts + the dev override. */
function registeredOrigins(): Set<string> {
  const origins = new Set(loadHosts(userDataDir()).hosts.map((h) => h.url));
  if (devUrl) {
    const normalized = normalizeOrigin(devUrl);
    if (normalized.ok) origins.add(normalized.origin);
  }
  return origins;
}

function isAllowedNavigation(url: string): boolean {
  if (url.startsWith(WELCOME_URL)) return true;
  const origin = originOf(url);
  return origin !== null && registeredOrigins().has(origin);
}

// ─── Dock/taskbar waiting badge ─────────────────────────────────────────────
//
// The SPA reports its waiting-agent count over `badge:set` (sender-gated like
// `servers:*`). Counts are cached PER (window, host) view (./views — resolved
// by webContents id, since a sender origin can be shared by several host
// entries): background views' reports update their cache silently. The PAINTED
// surface is the AGGREGATE (./views aggregateBadge): the sum over the DISTINCT
// hosts attached in ANY open window — a host shown by two windows counts once.
// macOS/Linux take `app.setBadgeCount` (0 clears); Windows has no dock badge,
// so the aggregate renders as a taskbar overlay icon on EVERY open window
// (per-window surface, app-scoped count — every entry signals), whose PNG
// bytes come from the electron-free ./badge module (node:test covered). The
// aggregate recomputes on any cached-count change, window open/close, and
// host switches.

function repaintBadge(): void {
  const count = aggregateBadge(views);
  if (process.platform === "win32") {
    for (const win of windows.values()) {
      if (win.isDestroyed()) continue;
      if (count > 0) {
        win.setOverlayIcon(nativeImage.createFromBuffer(badgePng(count)), overlayDescription(count));
      } else {
        win.setOverlayIcon(null, "");
      }
    }
    return;
  }
  app.setBadgeCount(count);
}

// ─── Routing ────────────────────────────────────────────────────────────────

/** The app's focused window, restricted to OUR registry. */
function focusedWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return null;
  return windows.get(win.id) ?? null;
}

/**
 * The cosmetic `activeId` write — the LAST FOCUSED WINDOW's host (back-compat
 * + first-window fallback), never per-window state. Written on window focus
 * and on switches in the focused window; sentinel views skip it (the store's
 * membership guard would no-op anyway).
 */
function trackActiveId(hostId: string | null): void {
  if (hostId === null || hostId === DEV_HOST_ID) return;
  setActiveHost(userDataDir(), hostId);
}

/** A window's title from its CURRENT registry state (host — route-leaf). */
function titleForWindow(win: BrowserWindow): string {
  const hostId = activeHostForWindow(views, win.id);
  if (hostId === null) return PRODUCT_NAME;
  // A popout window titles from the page's DOCUMENT title (the SPA's popout
  // posture sets `<Surface> · <window name>`), falling back to the ordinary
  // host — leaf form before the first page-title report. Checked BEFORE the
  // dev-sentinel special case: a popout of the dev host is still a popout.
  if (popouts.has(win.id)) {
    const entry = getView(views, win.id, hostId);
    const docTitle =
      entry && !entry.handle.webContents.isDestroyed() ? entry.handle.webContents.getTitle() : "";
    if (docTitle !== "") return docTitle;
  }
  if (hostId === DEV_HOST_ID) return devUrl ? (originOf(devUrl) ?? PRODUCT_NAME) : PRODUCT_NAME;
  const host = loadHosts(userDataDir()).hosts.find((h) => h.id === hostId);
  if (!host) return PRODUCT_NAME;
  return windowTitle(PRODUCT_NAME, host.name, routeForView(win, hostId));
}

function setWindowTitle(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setTitle(titleForWindow(win));
  rebuildMenu(); // the mac Window-menu list renders titles
}

/**
 * A view's current SPA route remainder (`pathname + search`), guarded like
 * the capture seam: a destroyed/unparseable/foreign-origin URL contributes
 * "" (the bare-origin title / no route). Title-only — capture is
 * `captureLastPathForView` at close/destroy.
 */
function routeForView(win: BrowserWindow, hostId: string): string {
  const entry = getView(views, win.id, hostId);
  if (!entry) return "";
  const current = entry.handle.webContents.getURL();
  if (!current) return "";
  try {
    const url = new URL(current);
    const expectedOrigin =
      hostId === DEV_HOST_ID
        ? devUrl ? originOf(devUrl) : null
        : loadHosts(userDataDir()).hosts.find((host) => host.id === hostId)?.url ?? null;
    if (expectedOrigin === null || url.origin !== expectedOrigin) return "";
    return url.pathname + url.search;
  } catch {
    return "";
  }
}

function showWelcome(win: BrowserWindow, query?: Record<string, string>): void {
  const current = activeView(views, win.id);
  if (current) {
    // The welcome page must never be covered by a guest of the outgoing host.
    for (const handle of hostDetachPlan(webViews, win.id, current.hostId)) {
      handle.setVisible(false);
    }
    win.contentView.removeChildView(current.handle);
  }
  views = deactivateViews(views, win.id);
  repaintBadge(); // this window's host leaves the displayed set (caches kept)
  applyOverlayColor(welcomeStripColor(nativeTheme.shouldUseDarkColors), win); // welcome's static strip color
  void win.loadFile(WELCOME_PATH, query ? { query } : undefined);
  setWindowTitle(win); // welcome — the plain product name
}

/**
 * Show the fallback host in a window (the cosmetic `activeId`, else first),
 * else welcome. A remembered `lastPath` is restored as-is (and only when the
 * view is created fresh) — staleness (removed window/board, dead host) is
 * the SPA's failure mode, never validated shell-side.
 */
function showActive(win: BrowserWindow): void {
  const active = resolveActiveHost(loadHosts(userDataDir()));
  if (active) {
    attachHostView(win, active);
  } else {
    showWelcome(win);
  }
}

/**
 * Persist a view's current SPA route (`pathname + search`) for ITS host
 * entry. Views preserve live state, so capture runs only at window close
 * (every live view of THAT window) and at view destroy — never on switch;
 * restore happens only when a view is created fresh. Keyed directly by the
 * view's host id (a view belongs to exactly one entry — an origin lookup
 * would misattribute a shared-origin background view's route to the ACTIVE
 * entry), guarded so a URL whose origin does not match that entry's origin
 * (mid-navigation, foreign origin) persists nothing. The dev view's sentinel
 * id matches no entry and is never persisted.
 */
function captureLastPathForView(hostId: string, contents: WebContents): void {
  if (contents.isDestroyed()) return;
  const current = contents.getURL();
  if (!current) return;
  let url: URL;
  try {
    url = new URL(current);
  } catch {
    return;
  }
  const host = loadHosts(userDataDir()).hosts.find((h) => h.id === hostId);
  if (!host || host.url !== url.origin) return;
  setHostLastPath(userDataDir(), hostId, url.pathname + url.search);
}

// ─── Host views (one persistent WebContentsView per (window, host) pair) ────
//
// Each window's own webContents serves ONLY the welcome page (and the
// no-drag blank underlay while a view covers it — BLANK_UNDERLAY_URL, see
// blankWelcomeUnderlay); host content lives in per-(window, host)
// WebContentsViews attached over the FULL window content bounds — the SPA
// draws the 28px titlebar strip itself, so full-bounds views reproduce
// today's rendering exactly. Views are created lazily on first visit in
// THAT window and stay alive until their host is removed or the window is
// torn down; a switch is a detach/attach flip, never a reload. The same
// host in N windows is N independent views (own renderers, own sockets);
// views never migrate between windows.

/** Shared hardened webPreferences — every window and every host view. */
function hostWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // Sandboxed preloads read process.argv — this carries app.getVersion().
    additionalArguments: [`--runkit-shell-version=${app.getVersion()}`],
  };
}

// ─── Web-tile guests (WebContentsView siblings of the host view) ────────────

/** Guests run in a dedicated PER-HOST partition (`persist:rk-web:<host.id>`)
 *  — separate from the default session the SPA runs in, so external logins
 *  persist like a browser profile and never share a jar with rk, and two
 *  hosts serving the same loopback port never share one with each other.
 *  The retired shared `persist:rk-web` partition is left on disk untouched:
 *  per-host jars start fresh, no migration. */
const GUEST_BACKGROUND = "#0f1117"; // the host view's boot background
const GUEST_BORDER_RADIUS_PX = 6;
/** The SPA's per-tab identity is bounded (the strict badge:set posture). */
const TAB_KEY_MAX_LENGTH = 128;
/** The retention identity embeds a slot URL, which the web-tab URL contract
 *  leaves unbounded — so this is a payload-sanity ceiling with headroom past
 *  practical URL lengths, never a contract bound: an over-long identity
 *  degrades to identity-less (no parking) instead of failing web:create. */
const WEB_IDENTITY_MAX_LENGTH = 8192;
/** web:find text bound — the query is renderer-supplied data over IPC. */
const WEB_FIND_TEXT_MAX_LENGTH = 1024;
/** web:zoom sanity band — the SPA's zoom ladder is the authority; main only
 *  rejects nonsense (a negative/NaN/astronomical factor). */
const WEB_ZOOM_FACTOR_MIN = 0.25;
const WEB_ZOOM_FACTOR_MAX = 5;
/** The capability probe's bounds — the `/api/health` gate shares
 *  HEALTH_TIMEOUT_MS; this caps the tunnel WebSocket round-trip. */
const PROXY_PROBE_TIMEOUT_MS = 5000;

/** Per-host guest sessions, keyed by partition name. */
const guestSessions = new Map<string, Electron.Session>();
function guestSession(host: ViewHost): Electron.Session {
  const partition = guestPartitionName(host.id);
  const existing = guestSessions.get(partition);
  if (existing) return existing;
  const s = session.fromPartition(partition);
  // Deny-by-default: a guest is an arbitrary page; nothing it asks for
  // (camera, geolocation, notifications, clipboard) is granted.
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  guestSessions.set(partition, s);
  return s;
}

/** Guest hardening — NO preload: a guest never sees runkitShell. */
function guestWebPreferences(host: ViewHost): Electron.WebPreferences {
  return {
    session: guestSession(host),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
}

/**
 * The proxy capability probe: a remote host earns `proxy` mode only when the
 * tunnel path provably works end to end. Two gates, both required:
 *  1. `GET <origin>/api/health` answers HTTP 200 (exactly — the capability
 *     contract) with a numeric `tunnel` field (the daemon's listen port) —
 *     absent means an older server, no probe attempted.
 *  2. A WebSocket round-trip through `<ws-origin>/ws/tunnel?target=
 *     127.0.0.1:<port>` (the rk host's own listen port — listening on every
 *     rk host): send `GET /api/health` and require an `HTTP/1.1 200` status
 *     line. This proves the whole path — the front end passes the upgrade,
 *     rk accepts the Origin-less client, the dial works, and bytes flow
 *     both ways.
 * Any failure — timeout, handshake refused, non-200 — is false, never a
 * throw.
 */
async function probeTunnel(host: ViewHost): Promise<boolean> {
  let tunnelPort: number | null = null;
  try {
    const res = await net.fetch(`${host.url}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.status === 200) {
      const body: unknown = await res.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "tunnel" in body &&
        typeof body.tunnel === "number" &&
        Number.isInteger(body.tunnel) &&
        body.tunnel >= 1 &&
        body.tunnel <= 65535
      ) {
        tunnelPort = body.tunnel;
      }
    }
  } catch {
    return false;
  }
  if (tunnelPort === null) return false;
  return tunnelProbeRoundTrip(host.url, tunnelPort);
}

/** The round-trip half of the probe: one binary frame carrying the HTTP
 *  request (the server relays binary verbatim and ignores text), answered
 *  by an `HTTP/1.1 200` status line within the deadline. */
function tunnelProbeRoundTrip(origin: string, tunnelPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(tunnelWsUrl(origin, `127.0.0.1:${tunnelPort}`));
    } catch {
      resolve(false);
      return;
    }
    ws.binaryType = "arraybuffer";
    let settled = false;
    let head = "";
    const timer = setTimeout(() => finish(false), PROXY_PROBE_TIMEOUT_MS);
    function finish(ok: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Closing an already-dead probe socket.
      }
      resolve(ok);
    }
    ws.addEventListener("open", () => {
      ws.send(
        new TextEncoder().encode(
          `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${tunnelPort}\r\nConnection: close\r\n\r\n`,
        ),
      );
    });
    ws.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data === "string") head += data;
      else if (data instanceof ArrayBuffer) head += Buffer.from(data).toString("utf8");
      else return;
      const eol = head.indexOf("\r\n");
      if (eol === -1) return;
      finish(head.slice(0, eol).startsWith("HTTP/1.1 200"));
    });
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
  });
}

/** Per-host proxy state, keyed on hosts.json id and invalidated whenever the
 *  host's url changes (setHostUrl, SSH heal) — the cache entry carries the
 *  url it was derived from, so a changed url recomputes lazily on the next
 *  ensure. `pending` collapses concurrent ensures into one probe+apply; it is
 *  keyed by host id AND url, so a probe in flight for an old url is never
 *  reused for the new one, and a stale query neither runs side effects nor
 *  publishes — listener creation, the setProxy apply, and the cache write
 *  are all gated on the pending entry's identity (settleHostProxy). */
interface HostProxyState {
  url: string;
  mode: WebProxyMode;
}
interface HostProxyPending {
  url: string;
  query: Promise<WebProxyMode>;
}
const hostProxyStates = new Map<string, HostProxyState>();
const hostProxyPending = new Map<string, HostProxyPending>();

/**
 * Settle a host's web-proxy mode and APPLY it to the host's guest session
 * before any guest loads: `session.setProxy` is awaited here, and
 * `web:create` awaits this before `createWebView`, so no guest ever loads
 * unproxied. Local hosts (the interstitialKindFor ordering, via
 * webProxyModeFor) skip the probe entirely — `direct`.
 */
async function ensureHostProxy(host: ViewHost): Promise<WebProxyMode> {
  const cached = hostProxyStates.get(host.id);
  if (cached && cached.url === host.url) return cached.mode;
  const pending = hostProxyPending.get(host.id);
  if (pending && pending.url === host.url) return pending.query;
  const url = host.url;
  const entry = { url, query: undefined as unknown as Promise<WebProxyMode> };
  entry.query = (async (): Promise<WebProxyMode> => {
    const localOrigin = await localDaemonOrigin();
    const isCurrent = () => hostProxyPending.get(host.id) === entry;
    const mode = await settleHostProxy(host, localOrigin, {
      probeTunnel: () => probeTunnel(host),
      ensureListener: () => ensureHostProxyListener(host),
      setProxy: (config) => guestSession(host).setProxy(config),
      isCurrent,
    });
    if (isCurrent()) {
      hostProxyStates.set(host.id, { url, mode });
    }
    return mode;
  })();
  hostProxyPending.set(host.id, entry);
  try {
    return await entry.query;
  } finally {
    if (hostProxyPending.get(host.id) === entry) {
      hostProxyPending.delete(host.id);
    }
  }
}

/** Per-host loopback proxy listeners (createLocalProxy in tunnel-proxy.ts),
 *  keyed on hosts.json id; the url the listener was created for rides along
 *  so a changed url never reuses a listener pointed at the old origin. */
const hostProxyListeners = new Map<string, { url: string; listener: LocalProxy }>();

/** Start the host's loopback listener, or reuse the live one while the
 *  host's url is unchanged. A creation failure is null — the caller
 *  degrades the host to `legacy`. */
async function ensureHostProxyListener(host: ViewHost): Promise<LocalProxy | null> {
  const existing = hostProxyListeners.get(host.id);
  if (existing && existing.url === host.url) return existing.listener;
  closeHostProxyListener(host.id);
  try {
    const listener = await createLocalProxy(host.url);
    hostProxyListeners.set(host.id, { url: host.url, listener });
    return listener;
  } catch {
    return null;
  }
}

/** Best-effort listener teardown: a close failure strands nothing the next
 *  ensure cannot replace. */
function closeHostProxyListener(hostId: string): void {
  const existing = hostProxyListeners.get(hostId);
  if (!existing) return;
  hostProxyListeners.delete(hostId);
  void existing.listener.close().catch(() => {});
}

/** Per-(window, host, tabKey) guest registry — pure logic in ./web-views,
 *  handles are WebContentsViews. */
let webViews: WebViewsState<WebContentsView> = emptyWebViews();

/** Apply a strip color to ONE window's win/linux window-controls overlay.
 *  darwin returns early (traffic lights are OS-drawn and take no color); a
 *  throwing call degrades silently (partial linux WCO support). */
function applyOverlayColor(color: string, win: BrowserWindow): void {
  if (process.platform === "darwin") return;
  if (win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({
      color,
      symbolColor: symbolColorFor(color),
      height: STRIP_HEIGHT_PX,
    });
  } catch {
    // Partial window-controls-overlay support (linux) — degrade silently.
  }
}

/** Views cover the full window content area (the SPA draws its own strip). */
function syncViewBounds(win: BrowserWindow, view: WebContentsView): void {
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height });
}

function syncActiveViewBounds(win: BrowserWindow): void {
  const entry = activeView(views, win.id);
  if (entry) syncViewBounds(win, entry.handle);
}

type InterstitialKind = "local" | "remote" | "url";

interface ViewHost {
  id: string;
  name: string;
  url: string;
  lastPath?: string;
  remote?: string;
}

function hostForView(hostId: string): ViewHost | null {
  if (hostId === DEV_HOST_ID && devUrl) {
    return { id: DEV_HOST_ID, name: originOf(devUrl) ?? PRODUCT_NAME, url: originOf(devUrl) ?? devUrl };
  }
  return loadHosts(userDataDir()).hosts.find((host) => host.id === hostId) ?? null;
}

function isInterstitialUrl(url: string): boolean {
  return url.startsWith(INTERSTITIAL_URL);
}

let localDaemonOriginCache: { value: string | null; expiresAt: number } | undefined;
let localDaemonOriginQuery: Promise<string | null> | null = null;

async function localDaemonOrigin(): Promise<string | null> {
  if (process.platform === "win32") return null;
  if (localDaemonOriginCache && Date.now() < localDaemonOriginCache.expiresAt) {
    return localDaemonOriginCache.value;
  }
  if (localDaemonOriginQuery) return localDaemonOriginQuery;
  localDaemonOriginQuery = (async () => {
    const run = await runRk(["url"], RK_QUERY_TIMEOUT_MS);
    if (!run.ok) return null;
    const normalized = normalizeOrigin(run.stdout.trim());
    return normalized.ok ? normalized.origin : null;
  })();
  try {
    const value = await localDaemonOriginQuery;
    localDaemonOriginCache = {
      value,
      expiresAt: Date.now() + LOCAL_DAEMON_ORIGIN_CACHE_TTL_MS,
    };
    return value;
  } finally {
    localDaemonOriginQuery = null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname.startsWith("127.") || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function interstitialKindFor(host: ViewHost): Promise<InterstitialKind> {
  if (host.remote !== undefined && host.remote !== "") return "remote";
  const localOrigin = await localDaemonOrigin();
  if (localOrigin !== null && host.url === localOrigin) return "local";
  if (localOrigin === null && process.platform !== "win32" && isLoopbackOrigin(host.url)) {
    return "local";
  }
  return "url";
}

function interstitialPageUrl(host: ViewHost, kind: InterstitialKind): string {
  const url = new URL(INTERSTITIAL_URL);
  url.searchParams.set("host", host.id);
  url.searchParams.set("kind", kind);
  url.searchParams.set("name", host.name);
  url.searchParams.set("origin", host.url);
  return url.toString();
}

function stopInterstitialHealthPoll(windowId: number, hostId: string): void {
  const key = viewKey(windowId, hostId);
  const poll = interstitialHealthPolls.get(key);
  if (!poll) return;
  clearInterval(poll.timer);
  interstitialHealthPolls.delete(key);
}

function startInterstitialHealthPoll(
  windowId: number,
  host: ViewHost,
  contents: WebContents,
): void {
  stopInterstitialHealthPoll(windowId, host.id);
  const key = viewKey(windowId, host.id);
  const tick = async (): Promise<void> => {
    const poll = interstitialHealthPolls.get(key);
    if (!poll || poll.inFlight || contents.isDestroyed()) return;
    if (!isInterstitialUrl(contents.getURL())) {
      stopInterstitialHealthPoll(windowId, host.id);
      return;
    }
    poll.inFlight = true;
    try {
      const ping = await pingServer(host.url);
      if (interstitialHealthPolls.get(key) !== poll || contents.isDestroyed()) return;
      if (!isInterstitialUrl(contents.getURL()) || !ping.ok) return;
      stopInterstitialHealthPoll(windowId, host.id);
      void contents.loadURL(host.url + (host.lastPath ?? ""));
    } finally {
      if (interstitialHealthPolls.get(key) === poll) poll.inFlight = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, INTERSTITIAL_HEALTH_POLL_MS);
  interstitialHealthPolls.set(key, { timer, inFlight: false });
}

async function showDeadHostInterstitial(
  windowId: number,
  hostId: string,
  contents: WebContents,
): Promise<void> {
  const host = hostForView(hostId);
  if (!host || contents.isDestroyed()) return;
  const kind = await interstitialKindFor(host);
  if (contents.isDestroyed() || viewLoadFailed.get(viewKey(windowId, hostId)) !== true) return;
  try {
    await contents.loadURL(interstitialPageUrl(host, kind));
    if (kind !== "remote") startInterstitialHealthPoll(windowId, host, contents);
  } catch {
    // A concurrent heal may have navigated the view before this page loaded.
  }
}

/**
 * Create + wire a host view for one window. Security wiring beyond
 * webPreferences needs no per-view work: the app-level `web-contents-created`
 * handler (window-open policy + navigation guard, which branches guest views
 * — a host view's web-tile tabs — to a scheme allowlist instead of the
 * host-origin one) and the session-wide permission handler already cover
 * every webContents created, and IPC sender gating keys on sender-frame
 * origin. What IS per-view: the theme-color cache feeding THAT window's
 * overlay, the window-title route refresh, the version-skew fallback strip
 * with its per-view inserted-CSS key, and the guest teardown on did-navigate
 * (a host-page navigation discards the SPA renderer that owned the tabKeys).
 */
function createHostView(win: BrowserWindow, hostId: string): WebContentsView {
  const windowId = win.id;
  const key = viewKey(windowId, hostId);
  const view = new WebContentsView({ webPreferences: hostWebPreferences() });
  view.setBackgroundColor("#0f1117"); // no white flash while the SPA boots
  const contents = view.webContents;

  // Track main-frame load failures per view so the remote-tunnel heal knows
  // whether a reload is needed (a warm view with live state is never
  // reloaded). Transitions are pure (./views nextLoadFailed): a real
  // main-frame failure sets the flag, and ONLY a did-navigate commit clears
  // it — did-finish-load also fires for Chromium's own error page right
  // after did-fail-load, so it must never clear (a dead-tunnel view would
  // otherwise read as healthy and the heal's reload gate would never fire).
  const applyLoadFlag = (event: LoadFlagEvent): void => {
    viewLoadFailed.set(key, nextLoadFailed(viewLoadFailed.get(key) === true, event));
  };
  contents.on("did-fail-load", (_event, errorCode, _desc, _url, isMainFrame) => {
    applyLoadFlag({ kind: "did-fail-load", isMainFrame, errorCode });
    if (isMainFrame && errorCode !== ERR_ABORTED) {
      void showDeadHostInterstitial(windowId, hostId, contents);
    }
  });

  // Key of the fallback strip CSS injected into this view's CURRENT page load
  // (null when none). Tracked so a theme-color report landing AFTER the
  // injection can recolor the band — `did-finish-load` may run before the
  // page's theme color is observed.
  let fallbackCssKey: string | null = null;
  const refreshFallbackStrip = async (): Promise<void> => {
    if (contents.isDestroyed()) return;
    const url = contents.getURL();
    if (!shouldInjectFallbackStrip(url, registeredOrigins())) return;
    const color = getView(views, windowId, hostId)?.themeColor ?? DEFAULT_STRIP_COLOR;
    const stale = fallbackCssKey;
    fallbackCssKey = null;
    try {
      if (stale != null) await contents.removeInsertedCSS(stale);
      fallbackCssKey = await contents.insertCSS(fallbackStripCss(color));
    } catch {
      // A navigation raced the injection — the next did-finish-load re-runs.
    }
  };
  // Inserted CSS does not survive a main-frame navigation; drop the dead key.
  // A did-navigate commit is also the ONE success signal that clears the
  // load-failure flag (it never fires for Chromium's error page).
  contents.on("did-navigate", (_event, url) => {
    fallbackCssKey = null;
    // A host-page navigation discards the SPA renderer that owned this
    // webContents' tabKeys (a reload, the interstitial commit) — its guests
    // die with it, parked ones included (the frames that would adopt them are
    // gone); the fresh SPA re-creates what it mounts. The initial load fires
    // this with zero guests (a no-op).
    const { state: afterGuests, removed: guests } = removeHostWebViews(webViews, contents.id);
    webViews = afterGuests;
    for (const guest of guests) destroyWebView(guest);
    const isInterstitial = isInterstitialUrl(url);
    applyLoadFlag({ kind: "did-navigate", isInterstitial });
    if (!isInterstitial) stopInterstitialHealthPoll(windowId, hostId);
    if (!win.isDestroyed()) setWindowTitle(win); // full navigations change the route leaf
  });
  // The SPA is a history-API router — in-page navigations change the route
  // (and the title leaf) without a did-navigate.
  contents.on("did-navigate-in-page", () => {
    if (!win.isDestroyed()) setWindowTitle(win);
  });
  // A popout window titles from the page's document title (titleForWindow's
  // popout branch); the SPA's popout posture keeps it at `<Surface> ·
  // <window name>` — recompute on every page-title update.
  contents.on("page-title-updated", () => {
    if (popouts.has(windowId) && !win.isDestroyed()) setWindowTitle(win);
  });
  // Cache the page's theme-color per view; repaint the overlay only when this
  // view is attached in ITS window (a background report must not tint the
  // window — the switch seam re-applies the incoming view's cached color).
  contents.on("did-change-theme-color", (_event, color) => {
    views = setViewThemeColor(views, windowId, hostId, color);
    // Persist the accent per host entry so the host-switcher's edge bar
    // survives cold start — but ONLY as the older-SPA fallback: once this
    // host's view has sent a raw accent:set report, the 35% titlebar blend
    // must not overwrite it. A null report never clears the stored value; the
    // dev sentinel view (__dev__) matches no entry — the membership guard
    // silently covers it. Unchanged values short-circuit (no write).
    if (color !== null && !rawAccentReported.get(key)) {
      setHostAccentColor(userDataDir(), hostId, color);
    }
    if (activeHostForWindow(views, windowId) === hostId && !win.isDestroyed()) {
      applyOverlayColor(color ?? DEFAULT_STRIP_COLOR, win);
    }
    if (fallbackCssKey != null) void refreshFallbackStrip();
  });
  // Version-skew fallback: an older SPA (no strip) under this hidden-titlebar
  // shell would have no drag surface. Registered-host pages get a minimal
  // draggable band whose CSS no-ops when the SPA-drawn strip marks
  // `html.rk-shell-strip` (CSS is live, so injecting unconditionally is safe).
  contents.on("did-finish-load", () => {
    applyLoadFlag({ kind: "did-finish-load" }); // deliberate no-op transition
    void refreshFallbackStrip();
  });
  return view;
}

/**
 * Blank the welcome page under an attached view: the welcome script polls
 * `daemon:status` (spawning rk subprocesses) on a 3s interval that only dies
 * with its page, and a covered page never learns it is covered. The blank
 * document is BLANK_UNDERLAY_URL — a no-drag `data:` page, NOT about:blank —
 * because about:blank emits no draggable-regions update, leaving the welcome
 * page's full-width drag band cached on this webContents where it would
 * swallow every click on the SPA strip's host-switcher (Electron merges drag
 * regions across webContents without occlusion). A main-initiated load
 * bypasses the will-navigate guard, so the data: URL needs no allowlisting;
 * `showWelcome` reloads the page fresh on demand (re-declaring its own band).
 */
function blankWelcomeUnderlay(win: BrowserWindow): void {
  if (win.webContents.getURL().startsWith(WELCOME_URL)) {
    void win.webContents.loadURL(BLANK_UNDERLAY_URL);
  }
}

/**
 * The attach seam: detach the window's current view, create the target's
 * view on first visit IN THIS WINDOW (loading `url + route` — the ONLY time
 * a view navigates), attach over full bounds, repaint the window's overlay
 * and title from the INCOMING view's caches, and repaint the aggregate
 * badge. `route` overrides the host's stored `lastPath` (New Window
 * duplication, cold-start window records); omitted, the store's `lastPath`
 * is the restore (creation-time only — warm switches keep the live route).
 */
function attachHostView(
  win: BrowserWindow,
  host: {
    id: string;
    url: string;
    lastPath?: string;
    remote?: string;
  },
  route?: string,
): void {
  if (win.isDestroyed()) return;
  const windowId = win.id;
  // SSH-only hosts heal their tunnel on activation (never blocking the
  // attach — a warm flip stays instant; a dead view reloads once healed).
  void ensureRemoteConnected(win, host);
  const current = activeView(views, windowId);
  let entry = getView(views, windowId, host.id);
  let created = false;
  if (!entry) {
    const view = createHostView(win, host.id);
    views = addView(views, windowId, host.id, view, view.webContents.id);
    entry = getView(views, windowId, host.id);
    created = true;
  }
  if (!entry) return; // unreachable — addView just registered it
  if (current && current.hostId !== host.id) {
    // Hide the outgoing host's guests before its view leaves the tree — a
    // later re-attach of a different host must never reveal them. Their
    // SPA-requested `visible` flags are untouched (a re-attach restores them).
    for (const handle of hostDetachPlan(webViews, windowId, current.hostId)) {
      handle.setVisible(false);
    }
    win.contentView.removeChildView(current.handle);
  }
  win.contentView.addChildView(entry.handle);
  syncViewBounds(win, entry.handle);
  // addChildView(host) raises the host above every guest, so the incoming
  // host's guests are re-raised on EVERY attach (a same-host re-attach
  // included): re-adding an existing child raises it, then the SPA-requested
  // visibility is restored (parked bounds applied before setVisible(true) —
  // setBounds on a hidden view would re-show it).
  for (const item of hostAttachPlan(webViews, windowId, host.id)) {
    win.contentView.addChildView(item.handle);
    if (item.visible) {
      item.handle.setBounds(item.bounds);
      item.handle.setVisible(true);
    } else {
      item.handle.setVisible(false);
    }
  }
  views = activateView(views, windowId, host.id);
  const paint = switchPaint(views, windowId, host.id);
  applyOverlayColor(paint.themeColor ?? DEFAULT_STRIP_COLOR, win);
  repaintBadge(); // the displayed set changed — recompute the aggregate
  if (created) {
    // Restore is creation-time only: warm switches keep the live route.
    void entry.handle.webContents.loadURL(host.url + (route ?? host.lastPath ?? ""));
  }
  entry.handle.webContents.focus();
  blankWelcomeUnderlay(win);
  setWindowTitle(win);
}

/**
 * Destroy a host's views across ALL windows (host removed). Each window left
 * showing the removed host falls to the first remaining host or welcome
 * (the window-registry's hostRemovedFallback decision on the post-removal
 * list). lastPath capture for the removed host is unnecessary — the store
 * entry dies with the views.
 */
function destroyHostViews(hostId: string): void {
  // A removed host's popout windows CLOSE — a popout is pinned to its host
  // and never degrades to welcome or another host. (Their guests die with
  // them below via the window teardown; the opener-side return move finds no
  // surviving host attachment and destroys as usual.)
  for (const [windowId, record] of popouts) {
    if (record.hostId !== hostId) continue;
    const win = windows.get(windowId);
    if (win && !win.isDestroyed()) win.close();
  }
  // The host's guests die first, in EVERY window, before the host views close.
  const { state: afterGuests, removed: guests } = removeHostWebViewsEverywhere(webViews, hostId);
  webViews = afterGuests;
  for (const guest of guests) destroyWebView(guest);
  const { state, removed } = removeHostViews(views, hostId);
  views = state;
  for (const entry of removed) {
    const win = windows.get(entry.windowId);
    if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.handle);
    stopInterstitialHealthPoll(entry.windowId, entry.hostId);
    viewLoadFailed.delete(viewKey(entry.windowId, entry.hostId));
    rawAccentReported.delete(viewKey(entry.windowId, entry.hostId));
    if (!entry.handle.webContents.isDestroyed()) entry.handle.webContents.close();
  }
  // Per-window fallback: first remaining host, or welcome when none remain.
  const listAfter = loadHosts(userDataDir());
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    const fallback = hostRemovedFallback(
      listAfter,
      hostId,
      activeHostForWindow(views, win.id),
    );
    if (fallback.kind === "host") attachHostView(win, fallback.host);
    else if (fallback.kind === "welcome") showWelcome(win);
  }
  repaintBadge();
}

/**
 * Window teardown: drop every view of ONE window (lastPath was captured on
 * 'close'). Views are window-scoped — a macOS dock-reopen recreates them
 * lazily from the captured routes.
 */
function destroyWindowViews(windowId: number): void {
  // The window's guests die with it — the window is closing, so detach is
  // skipped inside destroyWebView and the webContents are closed.
  const { state: afterGuests, removed: guests } = removeWindowWebViews(webViews, windowId);
  webViews = afterGuests;
  for (const guest of guests) destroyWebView(guest);
  const { state, removed } = removeWindowViews(views, windowId);
  views = state;
  for (const entry of removed) {
    stopInterstitialHealthPoll(entry.windowId, entry.hostId);
    viewLoadFailed.delete(viewKey(entry.windowId, entry.hostId));
    rawAccentReported.delete(viewKey(entry.windowId, entry.hostId));
    if (!entry.handle.webContents.isDestroyed()) entry.handle.webContents.close();
  }
}

/**
 * Last relayed chrome state per guest webContents id, re-reported to the new
 * frame on adoption: a parked guest emits no relay events (it is off the
 * mounted set), so its title/favicon would otherwise be lost to a remounting
 * frame until the next page event. Keyed by the guest's own webContents id —
 * stable across park/adopt.
 */
const guestChrome = new Map<number, { title: string; favicons: string[] }>();

function recordGuestChrome(
  webContentsId: number,
  patch: { title?: string; favicons?: string[] },
): void {
  const prev = guestChrome.get(webContentsId) ?? { title: "", favicons: [] };
  guestChrome.set(webContentsId, { ...prev, ...patch });
}

/**
 * Relay one guest event to the OWNING host webContents on the single
 * `web:event` channel, demuxed SPA-side by `tabKey`. Skipped silently when
 * the host webContents is gone (a destroyed host's late guest event relays
 * nowhere).
 */
function wireGuestRelay(contents: WebContents): void {
  const relay = (kind: string, extra: Record<string, unknown> = {}): void => {
    // Only the registry's CURRENT entry for this guest may speak. Teardown
    // unregisters before `webContents.close()`, and a closing renderer still
    // emits did-stop-loading / did-fail-load / navigation events — with no
    // identity check a replacement guest created under the same tabKey
    // (web:create's replace-on-collision) would receive the dead guest's late
    // events as its own. The lookup keys on the guest's own webContents id —
    // stable across park/adopt — so an adopted guest relays under its NEW
    // tabKey to its NEW host webContents, and a parked guest (off the mounted
    // set) relays nothing.
    const current = findWebViewByContents(webViews, contents.id);
    if (!current) return;
    const host = webContents.fromId(current.hostContentsId);
    if (!host || host.isDestroyed()) return;
    host.send("web:event", { tabKey: current.tabKey, kind, ...extra });
  };
  contents.on("page-title-updated", (_event, title) => {
    recordGuestChrome(contents.id, { title });
    relay("title", { title });
  });
  contents.on("page-favicon-updated", (_event, favicons) => {
    recordGuestChrome(contents.id, { favicons });
    relay("favicon", { favicons });
  });
  contents.on("did-start-loading", () => relay("loading", { loading: true }));
  contents.on("did-stop-loading", () => relay("loading", { loading: false }));
  // Subframe and superseded-navigation (ERR_ABORTED) failures are not relayed
  // — the nextLoadFailed rule: only a real main-frame failure is news.
  contents.on("did-fail-load", (_event, errorCode, description, url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    relay("failed", { code: errorCode, description, url });
  });
  const relayUrl = (url: string, httpStatus?: number): void =>
    relay("url", {
      url,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    });
  // did-navigate carries the commit's HTTP status (the dead-port signal — the
  // rk reverse proxy answers 502 when nothing listens); did-navigate-in-page
  // has no response code and omits the field.
  contents.on("did-navigate", (_event, url, httpResponseCode) => relayUrl(url, httpResponseCode));
  contents.on("did-navigate-in-page", (_event, url) => relayUrl(url));
  contents.on("focus", () => relay("focus"));
  // Match ordinals for the SPA's find bar — Chromium's activeMatchOrdinal is
  // 1-based; the 0-based mapping is the engine's.
  contents.on("found-in-page", (_event, result) =>
    relay("find", {
      active: result.activeMatchOrdinal,
      total: result.matches,
      final: result.finalUpdate,
    }),
  );
  // Chord reclaim: the guest's keydowns never reach the SPA document, so the
  // SPA enumerates its reclaim predicate into a per-guest table (web:chords)
  // and main matches here. A match is preventDefaulted (the page never sees
  // it), hops OS focus to the host webContents — on every matched chord,
  // Escape included, so the re-dispatched chord's result (a palette input, a
  // find bar) is usable; a `keepFocus` spec (the web keyboard-capture toggle)
  // skips the hop so the user keeps typing in the page — and relays for the
  // SPA to re-dispatch on its document. The registry-current re-check is the relay()'s identity rule:
  // a closing guest's late input must not speak for its replacement.
  contents.on("before-input-event", (event, input) => {
    const current = findWebViewByContents(webViews, contents.id);
    if (!current) return;
    const spec = findChord(input, current.chords);
    if (!spec) return;
    event.preventDefault();
    if (!spec.keepFocus) webContents.fromId(current.hostContentsId)?.focus();
    relay("chord", {
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      shiftKey: input.shift,
      altKey: input.alt,
    });
  });
  // Relayed as a direction, NEVER applied here — the SPA's zoom buckets own
  // the factor and send it back.
  contents.on("zoom-changed", (_event, direction) => relay("zoom", { direction }));
}

/**
 * Create + wire a guest for one (host view, tabKey). The guest is a SIBLING
 * of the host view on the window's contentView — a child of the host view
 * never paints (Electron 43 / Linux). Adding after the host is attached lands
 * the guest above it; the attach seam (hostAttachPlan in attachHostView)
 * re-raises it on every host switch. The URL arrives http(s)-validated by the
 * `web:create` handler (a main-initiated loadURL bypasses will-navigate), and
 * the handler has already awaited `ensureHostProxy(viewHost)` — the guest's
 * per-host session proxy config is settled before this first loadURL.
 */
function createWebView(
  win: BrowserWindow,
  host: ViewEntry<WebContentsView>,
  viewHost: ViewHost,
  tabKey: string,
  url: string,
  identity: string | null,
): void {
  const view = new WebContentsView({ webPreferences: guestWebPreferences(viewHost) });
  view.setBackgroundColor(GUEST_BACKGROUND);
  view.setBorderRadius(GUEST_BORDER_RADIUS_PX);
  win.contentView.addChildView(view);
  // A guest created by a DETACHED host's still-live SPA starts hidden —
  // showing it would paint over whatever host is actually displayed. The
  // attach plan shows it (at its recorded bounds) when that host returns.
  view.setVisible(activeHostForWindow(views, win.id) === host.hostId);
  webViews = addWebView(webViews, {
    windowId: win.id,
    hostId: host.hostId,
    hostContentsId: host.webContentsId,
    tabKey,
    handle: view,
    webContentsId: view.webContents.id,
    identity,
  });
  wireGuestRelay(view.webContents);
  void view.webContents.loadURL(url);
}

/**
 * Adopt a parked guest for a remounting frame (the registry rebind already
 * happened in the `web:create` handler): re-raise it above the host view
 * (re-adding an existing child raises it), restore the recorded bounds +
 * SPA-requested visibility under the painting gate, re-apply the recorded
 * zoom factor, and re-report the current chrome state — title, favicon,
 * url with history flags, loading — to the NEW frame over the same
 * `web:event` shapes wireGuestRelay relays, so the chrome is right without
 * waiting for a navigation event. The chord table needs no re-send: it lives
 * on the registry entry the before-input-event matcher reads.
 */
function adoptWebView(win: BrowserWindow, entry: WebViewEntry<WebContentsView>): void {
  win.contentView.addChildView(entry.handle);
  if (entry.visible && isGuestHostAttached(entry)) {
    entry.handle.setBounds(entry.bounds);
    entry.handle.setVisible(true);
  } else {
    entry.handle.setVisible(false);
  }
  const contents = entry.handle.webContents;
  contents.setZoomFactor(entry.zoomFactor);
  const host = webContents.fromId(entry.hostContentsId);
  if (!host || host.isDestroyed()) return;
  const send = (kind: string, extra: Record<string, unknown>): void => {
    host.send("web:event", { tabKey: entry.tabKey, kind, ...extra });
  };
  const chrome = guestChrome.get(entry.webContentsId);
  send("title", { title: chrome?.title ?? contents.getTitle() });
  send("favicon", { favicons: chrome?.favicons ?? [] });
  send("url", {
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  });
  send("loading", { loading: contents.isLoading() });
}

/** The guest's owning host is the one attached in its window. Painting a
 *  guest (show, bounds) is gated on this: a detached host's SPA stays alive
 *  and may still drive its guests, but must never paint over the displayed
 *  host — its requests are recorded and the attach plan applies them. */
function isGuestHostAttached(entry: WebViewEntry<WebContentsView>): boolean {
  return activeHostForWindow(views, entry.windowId) === entry.hostId;
}

/**
 * Destroy one guest: unregister, detach from its window when the window is
 * alive (tolerating a view already off the tree), and close its webContents
 * (never twice). Callers: `web:destroy`, `web:park`'s identity-less fallback
 * and LRU evictees, the host webContents `did-navigate` seam in
 * createHostView, destroyHostViews, destroyWindowViews. The scoped-removal
 * callers pass already-unregistered entries (parked ones included) — the
 * removeWebView re-removal is a no-op for them.
 */
function destroyWebView(entry: WebViewEntry<WebContentsView>): void {
  const { state } = removeWebView(webViews, entry.hostContentsId, entry.tabKey);
  webViews = state;
  guestChrome.delete(entry.webContentsId);
  const win = windows.get(entry.windowId);
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(entry.handle);
    } catch {
      // The view may already be off the tree (host detach raced a destroy).
    }
  }
  if (!entry.handle.webContents.isDestroyed()) entry.handle.webContents.close();
}

// ─── Menu ───────────────────────────────────────────────────────────────────

/**
 * Switch ONE window to a host — attach the host's view in that window and
 * rebuild the menu. The ONE switch path, shared by the Hosts menu radio
 * (focused window), the `servers:switch` IPC handler (sender's window), and
 * the local-connect/remote-connect/add tails (their invoking window). The
 * store's `activeId` is NOT written here — it is the cosmetic last-focused
 * record, written by window focus and by switches in the FOCUSED window
 * (this seam's focus-tracking call at the end). Never a loadURL on an
 * existing view: a warm switch is an instant detach/attach flip that keeps
 * live renderer state (WS/SSE connections, xterm scrollback, scroll
 * position).
 */
function switchToHost(win: BrowserWindow, id: string): IpcResult {
  // A popout is pinned to the host its route belongs to — host-switch paths
  // (the menu radio on a focused popout, `servers:switch` from a popout's
  // renderer) are refused, never re-home it.
  if (popouts.has(win.id)) return { ok: false, error: "Popout window" };
  const list = loadHosts(userDataDir());
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry) return { ok: false, error: "Unknown host" };
  attachHostView(win, entry);
  if (focusedWindow()?.id === win.id) trackActiveId(id);
  rebuildMenu();
  return { ok: true };
}

/**
 * Navigate to the welcome page in add mode — the ONE add-host entry path,
 * shared by the Hosts menu's `Add Host…` item and the `servers:add` IPC
 * handler (the SPA dropdown's `+ Add Host…` footer). The outgoing view stays
 * alive (welcome only detaches it) — lastPath capture happens at window
 * close / view destroy, not here.
 */
function openAddHost(win: BrowserWindow): IpcResult {
  if (win.isDestroyed()) return { ok: false, error: "No window" };
  showWelcome(win, { mode: "add" });
  return { ok: true };
}

function rebuildMenu(): void {
  const list = loadHosts(userDataDir());
  const focused = focusedWindow();
  const focusedHostId = focused ? activeHostForWindow(views, focused.id) : null;
  const windowEntries: WindowMenuEntry[] = windowListItems(
    [...windows.values()].map((win) => ({
      windowId: win.id,
      title: titleForWindow(win),
      focused: focused?.id === win.id,
    })),
  ).map((item) => ({ windowId: item.windowId, title: item.label, focused: item.focused }));
  const callbacks: MenuCallbacks = {
    onSwitchHost: (id) => {
      const win = focusedWindow();
      if (win) switchToHost(win, id);
    },
    onAddHost: () => {
      const win = focusedWindow();
      if (win) openAddHost(win);
    },
    onRemoveHost: (id) => {
      void confirmAndRemoveHost(id);
    },
    onNewWindow: () => {
      openDuplicateWindow(focusedWindow());
    },
    onFocusWindow: (windowId) => {
      windows.get(windowId)?.focus();
    },
    onDaemonStart: () => {
      void (async () => {
        const win = focusedWindow();
        if (!win) return;
        const result = await startAndConnectLocal(win);
        if (!result.ok) dialog.showErrorBox("Local Daemon", result.error);
      })();
    },
    onDaemonRestart: () => {
      void (async () => {
        const win = focusedWindow();
        if (!win) return;
        const result = await restartAndConnectLocal(win, false);
        if (!result.ok) dialog.showErrorBox("Local Daemon", result.error);
      })();
    },
    onDaemonRestartFull: () => {
      void (async () => {
        const win = focusedWindow();
        if (!win) return;
        const result = await restartAndConnectLocal(win, true);
        if (!result.ok) dialog.showErrorBox("Local Daemon", result.error);
      })();
    },
    onDaemonStop: () => {
      void (async () => {
        const result = await confirmAndStopDaemon();
        if (!result.ok) dialog.showErrorBox("Local Daemon", result.error);
      })();
    },
    onRestartToUpdate: () => {
      restartToUpdate();
    },
  };
  Menu.setApplicationMenu(
    buildMenu(list.hosts, focusedHostId, windowEntries, callbacks, daemonMenuInfo, updateMenuInfo),
  );
}

/**
 * The removal tail shared by both confirmed paths: store removal, view
 * teardown across ALL windows, menu rebuild, and the per-window fallback
 * (inside destroyHostViews). Confirmation is the caller's job — the native
 * menu confirms with the OS dialog below, and the SPA dropdown confirms with
 * its own themed dialog before invoking `servers:remove-confirmed`. An
 * unknown id is the store's no-op convention.
 */
function removeHostEverywhere(id: string): void {
  const list = loadHosts(userDataDir());
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry) return;
  removeHost(userDataDir(), id);
  closeHostProxyListener(id); // the loopback listener dies with its host entry
  destroyHostViews(id); // the views die with their host entry — in every window
  rebuildMenu();
}

async function confirmAndRemoveHost(id: string): Promise<void> {
  const win = focusedWindow() ?? [...windows.values()][0];
  if (!win) return;
  const list = loadHosts(userDataDir());
  const entry = list.hosts.find((h) => h.id === id);
  if (!entry) return;

  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Remove "${entry.name}"?`,
    detail: entry.url,
  });
  if (response !== 0) return;

  removeHostEverywhere(id);
}

// ─── Health ping (main process — renderer stays sandboxed) ────────────────

function parseHealthBody(body: unknown): { hostname: string } | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("status" in body) || body.status !== "ok") return null;
  const hostname =
    "hostname" in body && typeof body.hostname === "string" ? body.hostname : "";
  return { hostname };
}

async function pingServer(origin: string): Promise<PingResult> {
  let res: Response;
  try {
    res = await net.fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: `No response from ${origin} within 5s` };
  }
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} from ${origin}/api/health` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "Health response was not JSON — is this an rk server?" };
  }
  const health = parseHealthBody(body);
  if (!health) {
    return { ok: false, error: 'Health response missing status "ok" — is this an rk server?' };
  }
  return { ok: true, origin, hostname: health.hostname };
}

// ─── Local daemon control (explicit user-initiated actions only) ───────────
//
// Detection derives, never assumes: the local origin comes from `rk url`
// (config-derived), health is checked with the SAME `pingServer` probe the
// remote form uses, and a missing binary (ENOENT) is the not-installed state.
// Every subprocess call is execFile with an argument slice and a timeout —
// never a shell string (Constitution I applies to the Node side too).

const execFileAsync = promisify(execFile);

type RkRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; notInstalled: boolean };

/** Resolve the rk binary: fixed candidates first (GUI PATH trap), then PATH. */
function rkBinary(): string {
  return resolveRkBinary(rkCandidatePaths(process.platform), existsSync);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

async function runRk(args: string[], timeout: number): Promise<RkRunResult> {
  const binary = rkBinary();
  try {
    // The other half of the GUI PATH trap: resolving the rk BINARY via fixed
    // candidates is not enough — the spawned rk (and the tmux server tree
    // `rk daemon start` creates, which inherits this env wholesale) must also
    // find `tmux` on PATH, so the brew bin dirs are appended when missing.
    const { stdout } = await execFileAsync(binary, args, {
      timeout,
      env: { ...process.env, PATH: augmentPath(process.platform, process.env.PATH) },
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: rkInvocationErrorMessage(err, args, timeout, binary),
      notInstalled: isEnoent(err),
    };
  }
}

/** Session count for the running detail line — decoration, so any failure is null. */
async function fetchSessionCount(origin: string): Promise<number | null> {
  try {
    const res = await net.fetch(`${origin}/api/sessions`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseSessionCount(await res.json());
  } catch {
    return null;
  }
}

/**
 * Derive the local daemon state: `rk --version` (existence + version) →
 * `rk url` (config-derived origin) → health ping (running?) → session count.
 * Also feeds the menu's cached status (rebuilt only on change).
 */
async function probeDaemonStatus(): Promise<DaemonStatusResult> {
  const result = await probeDaemonStatusUncached();
  if (result.ok) updateDaemonMenu(result.status);
  return result;
}

async function probeDaemonStatusUncached(): Promise<DaemonStatusResult> {
  if (process.platform === "win32") return { ok: true, status: { installed: false } };
  const versionRun = await runRk(["--version"], RK_QUERY_TIMEOUT_MS);
  if (!versionRun.ok) {
    if (versionRun.notInstalled) return { ok: true, status: { installed: false } };
    return { ok: false, error: versionRun.error };
  }
  const version = parseRkVersion(versionRun.stdout);
  const urlRun = await runRk(["url"], RK_QUERY_TIMEOUT_MS);
  if (!urlRun.ok) return { ok: false, error: urlRun.error };
  const normalized = normalizeOrigin(urlRun.stdout.trim());
  if (!normalized.ok) {
    return { ok: false, error: `rk url printed "${urlRun.stdout.trim()}" — not a valid URL` };
  }
  const origin = normalized.origin;
  const ping = await pingServer(origin);
  if (!ping.ok) {
    const daemonRun = await runRk(["daemon", "status", "--json"], RK_QUERY_TIMEOUT_MS);
    const state =
      daemonRun.ok && parseDaemonStatusRunning(daemonRun.stdout) === true
        ? "wedged"
        : "stopped";
    return { ok: true, status: { installed: true, state, version, origin } };
  }
  const sessions = await fetchSessionCount(origin);
  return {
    ok: true,
    status: { installed: true, state: "running", version, origin, hostname: ping.hostname, sessions },
  };
}

/** Poll `/api/health` until it answers or the start-wait cap elapses. */
async function waitForHealth(origin: string): Promise<PingResult> {
  const deadline = Date.now() + DAEMON_START_WAIT_MS;
  for (;;) {
    const ping = await pingServer(origin);
    if (ping.ok) return ping;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `Daemon started but ${origin} did not answer within ${DAEMON_START_WAIT_MS / 1000}s`,
      };
    }
    await delay(DAEMON_START_POLL_MS);
  }
}

/**
 * Activate-or-add the local host — the connect tail shared by the card and
 * the menu. An existing entry for the origin is activated (never duplicated,
 * `addHost` does not dedupe); otherwise the existing add-host path runs
 * with the name auto-derived from the ping hostname (origin fallback in the
 * store). Acts on the invoking window.
 *
 * The activate branch also runs the reload gate: a view created while the
 * daemon was down committed Chromium's error page, and a warm switch never
 * navigates — so without the gate a fully successful connect leaves the
 * window black. The add branch needs no gate: a fresh host id has no view,
 * so `attachHostView` creates one and loads it.
 */
function connectLocalHost(win: BrowserWindow, origin: string, hostname: string): IpcResult {
  const existing = findHostByOrigin(loadHosts(userDataDir()), origin);
  if (existing) {
    const switched = switchToHost(win, existing.id);
    if (switched.ok) reloadFailedView(win.id, existing);
    return switched;
  }
  const added = addHost(userDataDir(), hostname, origin);
  if (!added.ok) return added;
  return switchToHost(win, added.host.id); // attaches the fresh view + rebuilds the menu
}

/**
 * The ONE get-in flow (`daemon:start` + the menu's Start): start the daemon
 * when stopped (a `daemon already running` error is already-started success),
 * wait for health, then connect in the invoking window. Never runs without an
 * explicit user action.
 */
async function showWedgedDaemonDialog(
  win: BrowserWindow,
  origin: string,
): Promise<DaemonActionResult> {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Restart Daemon", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `HexoKit reports running but isn't answering on ${origin}`,
    detail: "Restarting briefly interrupts local SSH tunnels; they reconnect automatically.",
  });
  if (response !== 0) return { ok: true, outcome: "declined" };
  return restartAndConnectLocal(win, true, true);
}

let daemonActionInFlight: DaemonAction | null = null;

function setDaemonActionInFlight(action: DaemonAction | null): void {
  daemonActionInFlight = action;
  if (daemonMenuInfo !== null) daemonMenuInfo = { ...daemonMenuInfo, action };
  rebuildMenu();
}

async function runDaemonAction(
  action: DaemonAction,
  operation: () => Promise<DaemonActionResult>,
  replace: boolean = false,
): Promise<DaemonActionResult> {
  if (daemonActionInFlight !== null && !replace) {
    return { ok: false, error: "Another daemon action is already in progress" };
  }
  setDaemonActionInFlight(action);
  try {
    return await operation();
  } finally {
    if (daemonActionInFlight === action) setDaemonActionInFlight(null);
    void refreshDaemonMenu();
  }
}

async function startAndConnectLocal(win: BrowserWindow): Promise<DaemonActionResult> {
  return runDaemonAction("start", async () => {
    const probe = await probeDaemonStatus();
    if (!probe.ok) return probe;
    const status = probe.status;
    if (!status.installed) return { ok: false, error: "HexoKit is not installed" };
    if (status.state === "wedged") return showWedgedDaemonDialog(win, status.origin);
    let hostname: string;
    if (status.state === "running") {
      hostname = status.hostname;
    } else {
      const started = await runRk(["daemon", "start"], RK_DAEMON_TIMEOUT_MS);
      const alreadyRunning = !started.ok && isDaemonAlreadyRunning(started.error);
      if (!started.ok && !alreadyRunning) return { ok: false, error: started.error };
      const ping = await waitForHealth(status.origin);
      if (!ping.ok) {
        if (alreadyRunning) return showWedgedDaemonDialog(win, status.origin);
        return ping;
      }
      hostname = ping.hostname;
    }
    return connectLocalHost(win, status.origin, hostname);
  });
}

/**
 * Restart followed by the same health/connect tail as Start. `full` runs
 * `rk daemon restart --full` — the whole rk-daemon tmux server dies (sibling
 * sessions included) and previously-up remote tunnels are reconnected by the
 * CLI. The renderer recovery paths (wedged welcome card, dead-host
 * interstitial) and the not-responding dialog stay full; the menu's plain
 * Restart is the non-full daemon-only bounce.
 */
async function restartAndConnectLocal(
  win: BrowserWindow,
  full: boolean,
  replaceAction: boolean = false,
): Promise<DaemonActionResult> {
  return runDaemonAction(full ? "restart-full" : "restart", async () => {
    const probe = await probeDaemonStatus();
    if (!probe.ok) return probe;
    if (!probe.status.installed) return { ok: false, error: "HexoKit is not installed" };
    const restarted = await runRk(
      full ? ["daemon", "restart", "--full"] : ["daemon", "restart"],
      RK_DAEMON_RESTART_TIMEOUT_MS,
    );
    if (!restarted.ok) return { ok: false, error: restarted.error };
    const ping = await waitForHealth(probe.status.origin);
    if (!ping.ok) return ping;
    return connectLocalHost(win, probe.status.origin, ping.hostname);
  }, replaceAction);
}

/**
 * Confirm-then-stop — ONE path shared by the welcome card's Stop button and
 * the Daemon menu item. Cancel is the default (the Remove-host
 * precedent); the copy states that tmux sessions survive (Constitution VI —
 * the tmux layer is independent of the server, so stop is low-stakes).
 */
async function confirmAndStopDaemon(
  actingWindow?: BrowserWindow,
): Promise<DaemonActionResult> {
  const win = actingWindow ?? focusedWindow() ?? [...windows.values()][0];
  if (!win || win.isDestroyed()) return { ok: false, error: "No window" };
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Stop Daemon", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Stop the local HexoKit daemon?",
    detail:
      "Only the web server stops — tmux sessions and running agents survive and reattach when the daemon starts again.",
  });
  if (response !== 0) return { ok: true, outcome: "declined" };
  return runDaemonAction("stop", async () => {
    const stopped = await runRk(["daemon", "stop"], RK_DAEMON_TIMEOUT_MS);
    return stopped.ok ? { ok: true } : { ok: false, error: stopped.error };
  });
}

// ─── SSH remote hosts (rk remote — explicit user-initiated actions only) ────
//
// The CLI owns bootstrap and tunnel lifecycle; the shell only runs
// user-initiated `rk remote add` / `rk remote connect` via execFile (argument
// slices + timeouts — Constitution I applies to the Node side too) and
// parses the CLI's stable stdout contracts (./remote-host, node:test
// covered). Progress rides connect's stderr chatter, streamed line-by-line
// to the welcome page.

/**
 * Streamed variant of runRk for `rk remote connect`: stderr chatter lines
 * are relayed to onLine as they arrive (the welcome progress feed) while
 * stdout is buffered for the origin data line.
 */
function runRkStreaming(
  args: string[],
  timeout: number,
  onLine: (line: string) => void,
): Promise<RkRunResult> {
  return new Promise((resolve) => {
    const splitter = createLineSplitter();
    const binary = rkBinary();
    const child = execFile(
      binary,
      args,
      {
        timeout,
        env: { ...process.env, PATH: augmentPath(process.platform, process.env.PATH) },
      },
      (err, stdout, stderr) => {
        for (const line of splitter.flush()) onLine(line);
        if (err) {
          const failure = stderr.trim();
          const error = rkInvocationErrorMessage(err, args, timeout, binary, failure);
          resolve({ ok: false, error, notInstalled: isEnoent(err) });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) onLine(line);
    });
  });
}

/**
 * Reduce a failed connect's stderr (progress chatter + cobra's final
 * "Error: …" block) to the error block alone — the progress lines were
 * already streamed to the renderer.
 */
function remoteErrorMessage(full: string): string {
  const idx = full.lastIndexOf("Error:");
  return idx >= 0 ? full.slice(idx).trim() : full;
}

/**
 * The welcome "or over SSH" flow: register (idempotent `rk remote add`,
 * labeled-line output) → connect (streamed progress) → health-ping the
 * local origin (the same `pingServer` gate the URL rung uses — a tunnel
 * that accepts TCP but does not answer /api/health persists nothing) →
 * activate-or-add the host entry carrying the `remote` name → switchToHost
 * in the invoking window. Never runs without an explicit user action.
 */
async function connectRemoteHost(
  win: BrowserWindow,
  target: string,
  onProgress: (line: string) => void,
): Promise<IpcResult> {
  const added = await runRk(["remote", "add", target], RK_REMOTE_ADD_TIMEOUT_MS);
  if (!added.ok) {
    if (added.notInstalled) {
      return { ok: false, error: "HexoKit is not installed on this machine" };
    }
    return { ok: false, error: remoteErrorMessage(added.error) };
  }
  const info = parseRemoteAddOutput(added.stdout);
  if (!info) {
    return { ok: false, error: "Unexpected `rk remote add` output — update HexoKit and retry" };
  }

  const connected = await runRkStreaming(
    ["remote", "connect", info.name],
    RK_REMOTE_CONNECT_TIMEOUT_MS,
    onProgress,
  );
  if (!connected.ok) return { ok: false, error: remoteErrorMessage(connected.error) };
  const origin = parseConnectOrigin(connected.stdout) ?? info.origin;

  // Health-gate before persisting: the tunnel is up, but only an rk server
  // answering /api/health earns a host entry (the URL rung's contract). A
  // failed ping surfaces inline and leaves hosts.json — and the reconnect
  // suppression window — untouched.
  const ping = await pingServer(origin);
  if (!ping.ok) return { ok: false, error: ping.error };
  markRemoteConnected(info.name);

  // Dedupe on the remote name — the stable identity for SSH hosts (several
  // entries can share an origin, but one remote is one host).
  const existing = loadHosts(userDataDir()).hosts.find((h) => h.remote === info.name);
  if (existing) {
    // The tunnel origin may differ from the stored url across reconnects —
    // drop the derived proxy state so it recomputes against the live origin.
    hostProxyStates.delete(existing.id);
    closeHostProxyListener(existing.id);
    return switchToHost(win, existing.id);
  }
  const addedHost = addHost(userDataDir(), info.name, origin, info.name);
  if (!addedHost.ok) return addedHost;
  return switchToHost(win, addedHost.host.id); // attaches the fresh view + rebuilds the menu
}

// Activation-time heal guards: one connect in flight per remote, and a short
// suppression window after a success so the welcome flow's switchToHost does
// not immediately re-run the connect it just finished.
const remoteConnectsInFlight = new Set<string>();
const remoteConnectedAt = new Map<string, number>();

function markRemoteConnected(name: string): void {
  remoteConnectedAt.set(name, Date.now());
}

/**
 * Re-run `rk remote connect` when a remote-carrying host is activated —
 * non-blocking (the attach seam stays an instant flip): the idempotent
 * connect heals a dead tunnel in the background, and only a view whose last
 * main-frame load FAILED is reloaded afterwards (a live view keeps its
 * state; its sockets reconnect on their own once the tunnel is back). Each
 * (window, host) view heals independently.
 */
async function ensureRemoteConnected(
  win: BrowserWindow,
  host: {
    id: string;
    url: string;
    lastPath?: string;
    remote?: string;
  },
  options: { showError?: boolean; bypassSuppression?: boolean } = {},
): Promise<IpcResult> {
  const showError = options.showError ?? true;
  const bypassSuppression = options.bypassSuppression ?? false;
  const name = host.remote;
  if (name === undefined || name === "") return { ok: true };
  if (remoteConnectsInFlight.has(name)) {
    return { ok: false, error: `Already reconnecting to ${name}` };
  }
  const lastOk = remoteConnectedAt.get(name);
  if (
    !bypassSuppression &&
    lastOk !== undefined &&
    Date.now() - lastOk < REMOTE_RECONNECT_SUPPRESS_MS
  ) {
    return { ok: false, error: `Reconnect to ${name} was attempted recently` };
  }

  const windowId = win.id;
  remoteConnectsInFlight.add(name);
  try {
    const run = await runRkStreaming(
      ["remote", "connect", name],
      RK_REMOTE_CONNECT_TIMEOUT_MS,
      () => {},
    );
    if (!run.ok) {
      const error = remoteErrorMessage(run.error);
      if (showError) dialog.showErrorBox(`Remote Host: ${name}`, error);
      return { ok: false, error };
    }
    markRemoteConnected(name);
    // A healed tunnel can carry a fresh origin — re-derive the host's proxy
    // state lazily on the next ensure.
    hostProxyStates.delete(host.id);
    closeHostProxyListener(host.id);
    reloadFailedView(windowId, host);
    return { ok: true };
  } finally {
    remoteConnectsInFlight.delete(name);
  }
}

// Cached menu-relevant daemon info. Application menus have no reliable
// about-to-open event, so the cache refreshes on startup, window focus,
// after daemon actions, and via the welcome page's status polls — and the
// menu is rebuilt only when the relevant info actually changes.
let daemonMenuInfo: DaemonMenuInfo | null = null;

function toDaemonMenuInfo(status: DaemonStatus): DaemonMenuInfo | null {
  if (!status.installed) return null;
  return { state: status.state, version: status.version, action: daemonActionInFlight };
}

function sameDaemonMenuInfo(a: DaemonMenuInfo | null, b: DaemonMenuInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.version === b.version && a.action === b.action;
}

function updateDaemonMenu(status: DaemonStatus): void {
  const next = toDaemonMenuInfo(status);
  if (sameDaemonMenuInfo(next, daemonMenuInfo)) return;
  daemonMenuInfo = next;
  rebuildMenu();
}

/** Re-probe and rebuild the menu when the daemon state changed. */
async function refreshDaemonMenu(): Promise<void> {
  await probeDaemonStatus(); // updateDaemonMenu runs inside on success
}

// ─── Desktop-app update check ("Restart to Update") ─────────────────────────
//
// Read-only detection: `rk desktop status` (stdout is stable data lines —
// parsed in ./update-check, node:test covered) tells us whether a newer
// desktop release exists. darwin+linux only (`rk desktop` exists on both;
// win32 has no desktop CLI), checked at natural events (startup, window
// focus) through a 1h throttle — the status call round-trips the GitHub
// releases API, so no perpetual timer (the daemonMenuInfo cache pattern).
// Every absence state — unsupported platform, rk missing, status failure, app
// not installed, up to date — is SILENT: null cache, no menu item, no error
// surface.

let updateMenuInfo: UpdateMenuInfo | null = null;
/** Epoch ms of the last check ATTEMPT (failures consume the window too). */
let lastUpdateCheckAt: number | null = null;

function sameUpdateMenuInfo(a: UpdateMenuInfo | null, b: UpdateMenuInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.latestVersion === b.latestVersion && a.updating === b.updating;
}

function setUpdateMenuInfo(next: UpdateMenuInfo | null): void {
  if (sameUpdateMenuInfo(next, updateMenuInfo)) return;
  updateMenuInfo = next;
  rebuildMenu();
}

/** Throttled `rk desktop status` check → change-gated menu rebuild. */
async function refreshUpdateMenu(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  // Never rewrite the cache mid-update: after a successful spawn the CLI owns
  // the outcome, and a focus-triggered check must not re-enable the item.
  if (updateMenuInfo?.updating) return;
  if (!isUpdateCheckDue(lastUpdateCheckAt, Date.now())) return;
  lastUpdateCheckAt = Date.now();
  const run = await runRk(["desktop", "status"], RK_STATUS_TIMEOUT_MS);
  // Re-check after the await: "Restart to Update" may have been clicked while
  // the status probe was in flight — writing here would clobber the updating
  // state and re-enable the item mid-update (same invariant as the pre-await
  // guard above).
  if (updateMenuInfo?.updating) return;
  const latest = run.ok ? availableUpdateVersion(run.stdout) : null;
  setUpdateMenuInfo(latest === null ? null : { latestVersion: latest, updating: false });
}

/**
 * The menu item's click: spawn `rk desktop update` fully DETACHED — the CLI
 * stages the download, quits this app gracefully (the window `close` handler
 * captures lastPath for the relaunch restore), swaps the bundle atomically,
 * and relaunches it; detachment (+ unref, stdio ignored) is what lets the
 * child survive its parent being quit. The shell adds no updater logic and
 * never touches its own bundle. After a successful spawn the item just reads
 * "Updating…" (disabled) until the quit arrives — post-spawn outcomes are the
 * CLI's responsibility. Only a failure of the spawn itself (binary vanished)
 * surfaces, via the existing native-dialog error pattern.
 */
function restartToUpdate(): void {
  const current = updateMenuInfo;
  if (current === null || current.updating) return;
  const child = spawn(rkBinary(), ["desktop", "update"], {
    detached: true,
    stdio: "ignore",
    // Same GUI-PATH posture as runRk: a Finder-launched app's PATH misses the
    // brew dirs the spawned rk may need.
    env: { ...process.env, PATH: augmentPath(process.platform, process.env.PATH) },
  });
  child.on("error", (err) => {
    // Spawn failure (ENOENT and friends) — re-enable the item for a retry.
    setUpdateMenuInfo({ latestVersion: current.latestVersion, updating: false });
    dialog.showErrorBox("Restart to Update", err.message);
  });
  child.unref();
  setUpdateMenuInfo({ latestVersion: current.latestVersion, updating: true });
}

// ─── IPC (sender-frame gated) ───────────────────────────────────────────────

/**
 * Privilege gate: `welcome:*` calls are honored only from the welcome
 * file:// page. Pages loaded from registered hosts can read
 * `runkitShell.version`/`platform` but never invoke privileged calls.
 */
function isWelcomeSender(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith(WELCOME_URL) ?? false;
}

function isInterstitialSender(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith(INTERSTITIAL_URL) ?? false;
}

/** Welcome is window-owned; an interstitial must resolve to its local host view. */
async function isDaemonSender(event: IpcMainInvokeEvent): Promise<boolean> {
  if (isWelcomeSender(event)) return true;
  if (!isInterstitialSender(event)) return false;
  const entry = findViewByWebContentsId(views, event.sender.id);
  if (!entry) return false;
  const host = hostForView(entry.hostId);
  if (!host) return false;
  return await interstitialKindFor(host) === "local";
}

/**
 * Privilege gate for `servers:*` (the SPA-facing channel family, named for
 * that contract) — a wider allowlist than `welcome:*`: registered host
 * origins (the pages that host the SPA palette) plus the welcome page. Same
 * set as the navigation guard; any other sender gets a rejection, never a
 * privileged action.
 */
function isHostsSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url;
  return url !== undefined && isAllowedNavigation(url);
}

function parseAddPayload(value: unknown): { name: string; url: string } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  const name = "name" in value && typeof value.name === "string" ? value.name : "";
  return { name, url: value.url };
}

function parseReorderPayload(value: unknown): { id: string; toIndex: number } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("toIndex" in value) || typeof value.toIndex !== "number") return null;
  if (!Number.isInteger(value.toIndex) || value.toIndex < 0) return null;
  return { id: value.id, toIndex: value.toIndex };
}

function parseRenamePayload(value: unknown): { id: string; name: string } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("name" in value) || typeof value.name !== "string") return null;
  return { id: value.id, name: value.name };
}

function parseSetUrlPayload(value: unknown): { id: string; url: string } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  return { id: value.id, url: value.url };
}

// web:* payload validators — the same structural-narrowing shape as the
// parse*Payload set above (unknown in, narrowed out, no casts).

function isTabKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TAB_KEY_MAX_LENGTH;
}

/** The retention identity's structural shape: a non-empty string. The length
 *  ceiling is enforced by the caller as a degrade, not a rejection. */
function isWebIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseWebTabKeyPayload(value: unknown): { tabKey: string } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  return { tabKey: value.tabKey };
}

function parseWebCreatePayload(
  value: unknown,
): { tabKey: string; url: string; identity: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  // Main-initiated loadURL bypasses will-navigate, so the scheme allowlist is
  // enforced HERE — a guest must never be pointed at a non-http(s) URL.
  if (!("url" in value) || typeof value.url !== "string" || !isHttpUrl(value.url)) return null;
  // The retention identity is OPTIONAL: an SPA predating park/adopt never
  // sends one and simply never parks. A present-but-non-string one is
  // rejected; an over-long one degrades to identity-less — the guest still
  // mounts and simply never parks (the slot-URL contract imposes no length
  // bound, so the identity ceiling must never cost a mount).
  let identity: string | null = null;
  if ("identity" in value && value.identity !== undefined) {
    if (!isWebIdentity(value.identity)) return null;
    identity = value.identity.length <= WEB_IDENTITY_MAX_LENGTH ? value.identity : null;
  }
  return { tabKey: value.tabKey, url: value.url, identity };
}

/** web:load carries the {tabKey, url} shape (and http(s) rule) of web:create. */
function parseWebLoadPayload(value: unknown): { tabKey: string; url: string } | null {
  const parsed = parseWebCreatePayload(value);
  if (parsed === null) return null;
  return { tabKey: parsed.tabKey, url: parsed.url };
}

function parseWebBoundsPayload(
  value: unknown,
): { tabKey: string; x: number; y: number; width: number; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  // CSS px arrive as floats (getBoundingClientRect); sizes can't be negative.
  if (!("x" in value) || typeof value.x !== "number" || !Number.isFinite(value.x)) return null;
  if (!("y" in value) || typeof value.y !== "number" || !Number.isFinite(value.y)) return null;
  if (!("width" in value) || typeof value.width !== "number" || !Number.isFinite(value.width)) return null;
  if (!("height" in value) || typeof value.height !== "number" || !Number.isFinite(value.height)) return null;
  if (value.width < 0 || value.height < 0) return null;
  return {
    tabKey: value.tabKey,
    x: Math.round(value.x),
    y: Math.round(value.y),
    width: Math.round(value.width),
    height: Math.round(value.height),
  };
}

function parseWebVisiblePayload(value: unknown): { tabKey: string; visible: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  if (!("visible" in value) || typeof value.visible !== "boolean") return null;
  return { tabKey: value.tabKey, visible: value.visible };
}

function parseWebFindPayload(
  value: unknown,
): { tabKey: string; text: string; forward: boolean; findNext: boolean } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  if (!("text" in value) || typeof value.text !== "string") return null;
  if (value.text.length === 0 || value.text.length > WEB_FIND_TEXT_MAX_LENGTH) return null;
  if (!("forward" in value) || typeof value.forward !== "boolean") return null;
  if (!("findNext" in value) || typeof value.findNext !== "boolean") return null;
  return { tabKey: value.tabKey, text: value.text, forward: value.forward, findNext: value.findNext };
}

function parseWebZoomPayload(value: unknown): { tabKey: string; factor: number } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  if (!("factor" in value) || typeof value.factor !== "number") return null;
  if (!Number.isFinite(value.factor)) return null;
  if (value.factor < WEB_ZOOM_FACTOR_MIN || value.factor > WEB_ZOOM_FACTOR_MAX) return null;
  return { tabKey: value.tabKey, factor: value.factor };
}

function parseWebChordsPayload(value: unknown): { tabKey: string; chords: ChordSpec[] } | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("tabKey" in value) || !isTabKey(value.tabKey)) return null;
  if (!("chords" in value)) return null;
  const chords = parseChordSpecs(value.chords);
  if (chords === null) return null;
  return { tabKey: value.tabKey, chords };
}

/** A web:* sender must be a registered-host page WITH a host view (the
 *  welcome page passes isHostsSender but owns no guests). */
function webSenderHost(event: IpcMainInvokeEvent): ViewEntry<WebContentsView> | null {
  if (!isHostsSender(event)) return null;
  return findViewByWebContentsId(views, event.sender.id);
}

/** …and the tabKey must belong to THAT sender. */
function webSenderGuest(
  event: IpcMainInvokeEvent,
  tabKey: string,
): WebViewEntry<WebContentsView> | null {
  return webSenderHost(event) ? findWebViewBySender(webViews, event.sender.id, tabKey) : null;
}

/**
 * The window an IPC call acts on: the SENDER's window — a host view's
 * window by registry lookup, the window itself for a welcome page (the
 * sender IS the window's own webContents). The focused window is the
 * fallback for the rare call whose sender resolves to neither.
 */
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const entry = findViewByWebContentsId(views, event.sender.id);
  if (entry) {
    const win = windows.get(entry.windowId);
    if (win && !win.isDestroyed()) return win;
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed() && win.webContents.id === event.sender.id) return win;
  }
  return focusedWindow();
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    "welcome:test-host",
    async (event, rawUrl: unknown): Promise<PingResult> => {
      if (!isWelcomeSender(event)) return { ok: false, error: "Not allowed" };
      if (typeof rawUrl !== "string") return { ok: false, error: "Invalid request" };
      const normalized = normalizeOrigin(rawUrl);
      if (!normalized.ok) return normalized;
      return pingServer(normalized.origin);
    },
  );

  ipcMain.handle("welcome:add-host", (event, payload: unknown): IpcResult => {
    if (!isWelcomeSender(event)) return { ok: false, error: "Not allowed" };
    const parsed = parseAddPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    const result = addHost(userDataDir(), parsed.name, parsed.url);
    if (!result.ok) return result;
    return switchToHost(win, result.host.id); // attaches the fresh view + rebuilds the menu
  });

  ipcMain.handle("welcome:cancel", (event): IpcResult => {
    if (!isWelcomeSender(event)) return { ok: false, error: "Not allowed" };
    const win = senderWindow(event);
    if (win) showActive(win);
    return { ok: true };
  });

  // daemon:* — shell-page-only surface (the menu calls the same functions
  // main-side). Every action is user-initiated; there is no auto-start.
  ipcMain.handle("daemon:status", async (event): Promise<DaemonStatusResult> => {
    if (!await isDaemonSender(event)) return { ok: false, error: "Not allowed" };
    return probeDaemonStatus();
  });

  ipcMain.handle("daemon:start", async (event): Promise<DaemonActionResult> => {
    if (!await isDaemonSender(event)) return { ok: false, error: "Not allowed" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    return startAndConnectLocal(win);
  });

  ipcMain.handle("daemon:restart", async (event): Promise<DaemonActionResult> => {
    if (!await isDaemonSender(event)) return { ok: false, error: "Not allowed" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    // The renderer restart is only reached from recovery surfaces (wedged
    // welcome card, dead-host interstitial) — those want the full bounce.
    return restartAndConnectLocal(win, true);
  });

  ipcMain.handle("daemon:stop", async (event): Promise<DaemonActionResult> => {
    if (!await isDaemonSender(event)) return { ok: false, error: "Not allowed" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    return confirmAndStopDaemon(win);
  });

  ipcMain.handle("interstitial:retry", async (event): Promise<IpcResult> => {
    if (!isInterstitialSender(event)) return { ok: false, error: "Not allowed" };
    const entry = findViewByWebContentsId(views, event.sender.id);
    if (!entry) return { ok: false, error: "Not allowed" };
    const win = windows.get(entry.windowId);
    const host = hostForView(entry.hostId);
    if (!win || win.isDestroyed() || !host) return { ok: false, error: "Unknown host" };
    const kind = await interstitialKindFor(host);
    if (kind === "remote") {
      return ensureRemoteConnected(win, host, { showError: false, bypassSuppression: true });
    }
    if (kind !== "url") return { ok: false, error: "Use the daemon action shown above" };
    void entry.handle.webContents.loadURL(host.url + (host.lastPath ?? ""));
    return { ok: true };
  });

  // remote:* — welcome-page-only surface (the SSH rung). Main runs the CLI
  // and streams connect's chatter back over `remote:progress` sends.
  ipcMain.handle("remote:connect", async (event, rawTarget: unknown): Promise<IpcResult> => {
    if (!isWelcomeSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof rawTarget !== "string" || rawTarget.trim() === "") {
      return { ok: false, error: "Enter an SSH target — user@host or a ~/.ssh/config alias" };
    }
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    const sender = event.sender;
    return connectRemoteHost(win, rawTarget.trim(), (line) => {
      if (!sender.isDestroyed()) sender.send("remote:progress", line);
    });
  });

  // servers:* — the web SPA's contract (app/frontend/src/lib/shell.ts): the
  // channel names AND the `servers` envelope key stay, even though the
  // entries are hosts shell-side.
  ipcMain.handle("servers:list", (event): ServersListResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    // Join the store projection with the view registry's cached badge counts:
    // a host with a live view (in ANY window) whose last `badge:set` report
    // was > 0 carries `waiting` (the switcher menu's amber ● N); never-
    // visited hosts (no view) and zero counts omit the field. The menu
    // refetches on every open, so this open-time snapshot needs no
    // subscription.
    const servers = hostInfos(loadHosts(userDataDir())).map((info) => {
      const max = views.entries
        .filter((e) => e.hostId === info.id)
        .reduce((best, e) => Math.max(best, e.badgeCount), 0);
      return max > 0 ? { ...info, waiting: max } : info;
    });
    return { ok: true, servers };
  });

  ipcMain.handle("servers:switch", (event, id: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof id !== "string") return { ok: false, error: "Invalid request" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    return switchToHost(win, id);
  });

  // servers:add — the SPA dropdown's `+ Add Host…` footer. Navigation-only
  // (no payload, no store write): it opens the welcome page in add mode via
  // the same openAddHost path the Hosts menu item takes; the actual
  // registration still happens through the welcome page's own gated
  // `welcome:add-host` flow.
  ipcMain.handle("servers:add", (event): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    return openAddHost(win);
  });

  // servers:add-direct — the SPA's in-place Add Host dialog (additive
  // channel; older SPAs only ever call servers:add). ONE invoke runs the
  // welcome page's whole test-host → add-host chain — normalize, health-ping,
  // persist, switch in the sender's window — so a failure can never land in a
  // half-state (pinged but not persisted, or persisted unpinged) and the
  // sandboxed renderer needs no cross-origin fetch. A blank name derives
  // from the ping's hostname (addHost's own empty-name rule then falls back
  // to the origin) — the welcome add form's exact behavior.
  ipcMain.handle("servers:add-direct", async (event, payload: unknown): Promise<IpcResult> => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const parsed = parseAddPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const win = senderWindow(event);
    if (!win) return { ok: false, error: "No window" };
    const normalized = normalizeOrigin(parsed.url);
    if (!normalized.ok) return normalized;
    const ping = await pingServer(normalized.origin);
    if (!ping.ok) return { ok: false, error: ping.error };
    const added = addHost(userDataDir(), parsed.name.trim() || ping.hostname, normalized.origin);
    if (!added.ok) return added;
    return switchToHost(win, added.host.id); // attaches the fresh view + rebuilds the menu
  });

  // servers:reorder — move-by-id ({id, toIndex}); a full-array payload would
  // trust renderer-supplied order, so only the immutable id + target index
  // cross the bridge. List order IS the native menu's accelerator map, so a
  // committed move rebuilds the menu to re-derive the ⌥⌘1–9/⇧Ctrl+1–9
  // bindings. An unknown id is the store's no-op convention (still ok — the
  // rebuild is harmless), not an error.
  ipcMain.handle("servers:reorder", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const parsed = parseReorderPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    moveHost(userDataDir(), parsed.id, parsed.toIndex);
    rebuildMenu();
    return { ok: true };
  });

  // servers:remove — the SPA dropdown's per-row Disconnect with the SHELL
  // confirming: the semantics this channel SHIPPED with (v3.17.11), frozen —
  // it routes into the confirmAndRemoveHost path the native Hosts → Remove
  // item calls (Cancel-default native dialog, then the shared removal tail).
  // A v3.17.11-era page invokes it with no dialog of its own, so the native
  // dialog here is that page's ONLY confirmation. User-cancel and an unknown
  // id both resolve ok — cancel is a successful no-op, matching reorder.
  ipcMain.handle("servers:remove", async (event, id: unknown): Promise<IpcResult> => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof id !== "string") return { ok: false, error: "Invalid request" };
    await confirmAndRemoveHost(id);
    return { ok: true };
  });

  // servers:remove-confirmed — the ADDITIVE already-confirmed variant for
  // newer SPAs that confirm with their own themed dialog before invoking
  // (exactly one dialog per intent): no native dialog, straight into the
  // shared removal tail. Changing servers:remove's meaning instead would
  // strip a released page of its only confirmation — the two-sided skew
  // contract is why this is a new channel, not new semantics.
  ipcMain.handle("servers:remove-confirmed", (event, id: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof id !== "string") return { ok: false, error: "Invalid request" };
    removeHostEverywhere(id);
    return { ok: true };
  });

  // servers:rename — the SPA dropdown's inline row edit. Host names appear
  // in the native Hosts-menu radio labels and `Remove "<name>"…` items, so a
  // committed rename rebuilds the menu unconditionally (unknown id and no-op
  // values included — the rebuild is harmless, the store no-ops).
  ipcMain.handle("servers:rename", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const parsed = parseRenamePayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    setHostName(userDataDir(), parsed.id, parsed.name);
    rebuildMenu();
    return { ok: true };
  });

  // servers:set-url — the SPA Edit Host dialog's URL field (additive channel,
  // the rename template). The origin is normalized HERE (the store mutator
  // takes it pre-validated); a change re-points the registration, drops the
  // old-origin lastPath store-side, and destroys the host's view so the next
  // visit loads the new origin — when that host is the one DISPLAYED, the
  // window re-attaches immediately so it never sits on a destroyed view. The
  // menu rebuild refreshes registered-origin-derived state everywhere.
  ipcMain.handle("servers:set-url", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const parsed = parseSetUrlPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const normalized = normalizeOrigin(parsed.url);
    if (!normalized.ok) return normalized;
    const before = loadHosts(userDataDir()).hosts.find((h) => h.id === parsed.id);
    if (!before || before.url === normalized.origin) return { ok: true };
    // SSH-tunnel hosts are url-managed by `rk remote connect` (their url IS
    // the tunnel origin, and activation keeps healing it via `remote`):
    // re-pointing one would leave a remote-carrying entry whose tunnel heals
    // an origin the entry no longer registers.
    if (before.remote !== undefined && before.remote !== "") {
      return { ok: false, error: "This host's URL is managed by its SSH connection" };
    }
    setHostUrl(userDataDir(), parsed.id, normalized.origin);
    hostProxyStates.delete(parsed.id); // the proxy mode re-derives lazily on
    // the next ensure against the NEW origin
    closeHostProxyListener(parsed.id);
    destroyHostViews(parsed.id); // stale views die in EVERY window — the
    // per-window fallback (first remaining host or welcome) keeps any window
    // that displayed this host off a destroyed view
    rebuildMenu();
    return { ok: true };
  });

  // shell:new-window — the New Window bridge channel (the SPA's ⌘N binding
  // is the consumer). Gated exactly like `servers:*`; routes to the SAME
  // duplicate-of-current-window function the menu item calls.
  ipcMain.handle("shell:new-window", (event): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    openDuplicateWindow(senderWindow(event));
    return { ok: true };
  });

  // shell:popout — the SPA's Pop out verb: open the validated `?pop=` route
  // as a same-host shell window (the window-open policy stays ALL-EXTERNAL;
  // a route remainder resolved against the SENDER host's origin makes a
  // cross-origin target unrepresentable). Dedupe: a live popout of the same
  // (opener, host, route) is focused (restored when minimized), not
  // duplicated — another opener window gets its OWN popout.
  ipcMain.handle("shell:popout", (event, payload: unknown): PopoutResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const host = findViewByWebContentsId(views, event.sender.id);
    if (!host) return { ok: false, error: "No host view" };
    const opener = windows.get(host.windowId);
    const viewHost = hostForView(host.hostId);
    if (!opener || opener.isDestroyed() || !viewHost) {
      return { ok: false, error: "No host view" };
    }
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const parsed = parsePopoutPayload(payload, viewHost.url, {
      width: workArea.width,
      height: workArea.height,
    });
    if (!parsed) return { ok: false, error: "Invalid request" };
    const existing = findPopoutWindow(popouts, opener.id, host.hostId, parsed.route);
    if (existing !== null) {
      const win = windows.get(existing);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
        return { ok: true, windowId: existing };
      }
      popouts.delete(existing); // a stale record outliving its window
    }
    const win = createWindow({ width: parsed.width, height: parsed.height });
    popouts.set(win.id, {
      openerWindowId: opener.id,
      hostId: host.hostId,
      route: parsed.route,
    });
    attachHostView(win, viewHost, parsed.route);
    return { ok: true, windowId: win.id };
  });

  // shell:close-window — the Close Window bridge channel (the SPA's ⇧⌘W
  // binding is the consumer). Gated exactly like `shell:new-window`; closes
  // the SENDER's window — not the focused one (a chord handled in a
  // non-focused view must close the window it was pressed in).
  ipcMain.handle("shell:close-window", (event): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    senderWindow(event)?.close();
    return { ok: true };
  });

  // badge:* — the SPA's waiting-agent count report, gated exactly like
  // `servers:*` (registered host origins + welcome). Structurally validated:
  // only a non-negative integer reaches the OS badge surface. Counts are
  // cached PER (window, host) view (resolved from the sender's webContents
  // id — origins can be shared by several entries); the PAINTED surface is
  // the aggregate over the distinct displayed hosts, recomputed on every
  // cache write. Non-view senders (the welcome page, a destroyed view's late
  // report) cache nothing — the aggregate is derived from displayed views
  // only, so there is no direct-paint branch.
  ipcMain.handle("badge:set", (event, count: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return { ok: false, error: "Invalid request" };
    }
    const entry = findViewByWebContentsId(views, event.sender.id);
    if (entry) {
      views = setViewBadge(views, entry.windowId, entry.hostId, count);
      repaintBadge(); // a cache change moves the aggregate when that host is displayed
    }
    return { ok: true };
  });

  // accent:* — the SPA's raw instance-accent report, gated exactly like
  // `badge:*` (registered host origins + welcome). The payload is the
  // full-strength contrast-guarded stripe hex the SPA already derives — the
  // theme-color meta carries only a 35% background blend, which is why the
  // switcher's edge bars need this channel. Strictly hex-validated (it feeds
  // style interpolation SPA-side); persisted per host via the existing
  // setHostAccentColor (unchanged-value short-circuit). Non-view senders (the
  // welcome page, a destroyed view's late report) persist nothing — unlike
  // badge:set there is no direct-paint branch, because nothing paints here.
  // A successful view-resolved persist marks rawAccentReported, demoting the
  // did-change-theme-color seam to older-SPA fallback for that host.
  ipcMain.handle("accent:set", (event, hex: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (typeof hex !== "string" || !isHostAccentHex(hex)) {
      return { ok: false, error: "Invalid request" };
    }
    const entry = findViewByWebContentsId(views, event.sender.id);
    if (entry) {
      setHostAccentColor(userDataDir(), entry.hostId, hex);
      rawAccentReported.set(viewKey(entry.windowId, entry.hostId), true);
    }
    return { ok: true };
  });

  // web:* — the web tile's native engine (the `web` bridge group). One tighter
  // ladder than the other hosts-gated channels: the sender must be a
  // registered-host page ("Not allowed") that OWNS a host view ("No host view"
  // — the welcome page passes the gate but owns no view), the payload must
  // validate ("Invalid request"), and the tabKey must belong to THAT sender's
  // host webContents ("Unknown tab") — two windows showing one host are two
  // host webContents, so tabKeys never cross over.
  ipcMain.handle("web:create", async (event, payload: unknown): Promise<IpcResult> => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const host = webSenderHost(event);
    if (!host) return { ok: false, error: "No host view" };
    // A host view whose window is gone is no host view at all — same rung.
    const win = windows.get(host.windowId);
    if (!win || win.isDestroyed()) return { ok: false, error: "No host view" };
    const viewHost = hostForView(host.hostId);
    if (!viewHost) return { ok: false, error: "No host view" };
    const parsed = parseWebCreatePayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    // Replace, never stack: the SPA's mount/unmount can race (a StrictMode
    // double-mount), and a stale guest would leak a renderer.
    const existing = findWebViewBySender(webViews, event.sender.id, parsed.tabKey);
    if (existing) destroyWebView(existing);
    // Adopt before create: an identity match in the parked set — scoped to
    // THIS (window, host), derived from the sender's host view — re-binds the
    // retained guest instead of booting a new renderer. No ensureHostProxy
    // await: the guest's per-host session proxy settled at its original
    // create and parked guests die with any host re-point.
    if (parsed.identity !== null) {
      const { state, adopted } = adoptParkedWebView(
        webViews,
        win.id,
        host.hostId,
        parsed.identity,
        event.sender.id,
        parsed.tabKey,
      );
      if (adopted) {
        webViews = state;
        adoptWebView(win, adopted);
        return { ok: true };
      }
      // Popout cross-window adoption: this window is a registered popout of
      // THIS host — the popped-out web tile's guest lives in the OPENER
      // window's scope (parked by the opener's unmount, or still mounted when
      // this create outran the park). Move it into this window's parked scope
      // and adopt it through the ordinary path — the guest keeps its
      // webContents id and page state, and never paints in the opener again
      // (the opener's attach/detach plans no longer list it). A non-popout
      // window, another host's popout, or a popout of another opener simply
      // never matches — the plain create path (a fresh guest) is the answer.
      const popout = popouts.get(win.id);
      if (popout !== undefined && popout.hostId === host.hostId) {
        const { state: afterMove, moved, evicted } = moveWebViewToWindow(
          webViews,
          popout.openerWindowId,
          win.id,
          host.hostId,
          parsed.identity,
        );
        if (moved !== null) {
          webViews = afterMove;
          const openerWin = windows.get(popout.openerWindowId);
          if (openerWin && !openerWin.isDestroyed()) {
            try {
              openerWin.contentView.removeChildView(moved.handle);
            } catch {
              // Already off the opener's tree (its detach raced the move).
            }
          }
          for (const stale of evicted) destroyWebView(stale);
          const { state: afterAdopt, adopted: movedAdopted } = adoptParkedWebView(
            webViews,
            win.id,
            host.hostId,
            parsed.identity,
            event.sender.id,
            parsed.tabKey,
          );
          if (movedAdopted) {
            webViews = afterAdopt;
            adoptWebView(win, movedAdopted);
            return { ok: true };
          }
        }
      }
    }
    // setProxy is async — settle the host session's proxy config BEFORE the
    // guest's first loadURL, so no guest ever loads unproxied.
    await ensureHostProxy(viewHost);
    // The await opened a race window: the window may be gone now, and a
    // concurrent create for this tab may have landed while we probed — the
    // replace check above predates the await, so repeat it.
    if (win.isDestroyed()) return { ok: false, error: "No host view" };
    const raced = findWebViewBySender(webViews, event.sender.id, parsed.tabKey);
    if (raced) destroyWebView(raced);
    createWebView(win, host, viewHost, parsed.tabKey, parsed.url, parsed.identity);
    return { ok: true };
  });

  // web:mode — the SPA's per-host web-mode query (additive: shells predating
  // the channel lack the invoker, which the SPA reads as `legacy`). No
  // payload: main resolves the host from the sender view, like every web:*
  // handler. The answer awaits the host's proxy settle (probe included), so
  // it is final — the SPA asks before computing the guest's load URL.
  ipcMain.handle("web:mode", async (event): Promise<WebModeResult> => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    const host = webSenderHost(event);
    if (!host) return { ok: false, error: "No host view" };
    const viewHost = hostForView(host.hostId);
    if (!viewHost) return { ok: false, error: "No host view" };
    const mode = await ensureHostProxy(viewHost);
    return { ok: true, mode };
  });

  ipcMain.handle("web:destroy", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    destroyWebView(guest);
    return { ok: true };
  });

  // web:park — the tile-unmount retention path: hide the guest (it must never
  // paint again until adopted — the attach/detach plans skip parked entries)
  // and move it to the parked set keyed by its retention identity, where a
  // later web:create with the same identity adopts it. Parking past
  // PARKED_WEB_VIEW_CAP evicts (destroys) the least-recently-parked guest; a
  // stale parked entry under the same key is destroyed too. An identity-less
  // entry cannot park — it takes the pre-park destroy path instead.
  ipcMain.handle("web:park", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    const { state, parked, evicted } = parkWebView(webViews, guest.hostContentsId, guest.tabKey);
    if (parked === null) {
      destroyWebView(guest); // no retention identity — the pre-park behavior
      return { ok: true };
    }
    webViews = state;
    parked.handle.setVisible(false);
    for (const stale of evicted) destroyWebView(stale);
    return { ok: true };
  });

  // web:bounds — DIP coordinates relative to the host view's content, applied
  // verbatim: the host view fills the window content area, so host-view
  // coordinates ARE win.contentView coordinates and no offset is added. The
  // rect is PARKED, not applied, on a HIDDEN guest (setBounds on a hidden view
  // re-shows it — Electron 43 / Linux) or on a guest whose owning host is
  // detached (applying would paint over the displayed host); web:visible
  // {true} and the attach plan apply the record on show.
  ipcMain.handle("web:bounds", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebBoundsPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    const bounds = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
    webViews = setWebViewBounds(webViews, guest.hostContentsId, guest.tabKey, bounds);
    if (guest.visible && isGuestHostAttached(guest)) guest.handle.setBounds(bounds);
    return { ok: true };
  });

  // web:visible — the SPA-requested visibility, recorded independently of the
  // host detach hide so a re-attach restores exactly this. On show, and only
  // when the owning host is the one attached (a detached host's SPA must not
  // paint over the displayed host — the attach plan applies the record on
  // return), the parked bounds apply immediately BEFORE setVisible(true)
  // (same turn, same reason as the parked-bounds rule above).
  ipcMain.handle("web:visible", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebVisiblePayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    webViews = setWebViewVisible(webViews, guest.hostContentsId, guest.tabKey, parsed.visible);
    if (parsed.visible) {
      if (isGuestHostAttached(guest)) {
        guest.handle.setBounds(guest.bounds);
        guest.handle.setVisible(true);
      }
    } else {
      guest.handle.setVisible(false);
    }
    return { ok: true };
  });

  // web:load / web:reload — the address bar's navigation verbs. loadURL
  // bypasses will-navigate, so the URL arrives http(s)-validated by
  // parseWebLoadPayload (the scheme allowlist holds on every entry).
  ipcMain.handle("web:load", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebLoadPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    void guest.handle.webContents.loadURL(parsed.url);
    return { ok: true };
  });

  ipcMain.handle("web:reload", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    guest.handle.webContents.reload();
    return { ok: true };
  });

  // web:back / web:forward — real guest history. A call at the boundary is a
  // no-op that still succeeds (the chrome disables the buttons from the
  // canGoBack/canGoForward the url relay carries, so reaching here means a
  // stale render, not an error).
  ipcMain.handle("web:back", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    const history = guest.handle.webContents.navigationHistory;
    if (history.canGoBack()) history.goBack();
    return { ok: true };
  });

  ipcMain.handle("web:forward", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    const history = guest.handle.webContents.navigationHistory;
    if (history.canGoForward()) history.goForward();
    return { ok: true };
  });

  // web:find / web:stop-find — Chromium's findInPage behind the shared find
  // bar; match ordinals arrive on the `found-in-page` relay.
  ipcMain.handle("web:find", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebFindPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    guest.handle.webContents.findInPage(parsed.text, {
      forward: parsed.forward,
      findNext: parsed.findNext,
    });
    return { ok: true };
  });

  ipcMain.handle("web:stop-find", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    guest.handle.webContents.stopFindInPage("clearSelection");
    return { ok: true };
  });

  // web:zoom — apply the SPA's zoom bucket to the guest renderer and record
  // it on the entry, so adoption re-applies it after a park. The SPA re-sends
  // on every navigation: Chromium's per-host zoom store inside the guest
  // partition persists and leaks between views, so the factor is never
  // derived main-side — only applied and recorded.
  ipcMain.handle("web:zoom", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebZoomPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    webViews = setWebViewZoomFactor(webViews, guest.hostContentsId, guest.tabKey, parsed.factor);
    guest.handle.webContents.setZoomFactor(parsed.factor);
    return { ok: true };
  });

  // web:chords — record the guest's reclaimable chord table (enumerated
  // SPA-side from the keybinding registry). Pure record; the
  // before-input-event matcher in wireGuestRelay reads it per keydown.
  ipcMain.handle("web:chords", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebChordsPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    webViews = setWebViewChords(webViews, guest.hostContentsId, guest.tabKey, parsed.chords);
    return { ok: true };
  });

  ipcMain.handle("web:devtools", (event, payload: unknown): IpcResult => {
    if (!isHostsSender(event)) return { ok: false, error: "Not allowed" };
    if (!webSenderHost(event)) return { ok: false, error: "No host view" };
    const parsed = parseWebTabKeyPayload(payload);
    if (!parsed) return { ok: false, error: "Invalid request" };
    const guest = webSenderGuest(event, parsed.tabKey);
    if (!guest) return { ok: false, error: "Unknown tab" };
    guest.handle.webContents.openDevTools({ mode: "detach" });
    return { ok: true };
  });
}

// ─── Window lifecycle + security wiring ─────────────────────────────────────

/**
 * One window's contribution to windows.json — null for a window that must
 * NOT be persisted: a dev-sentinel window, or a popout window (a popout is a
 * viewer-posture window of the moment; relaunch restores the ordinary window
 * set only, on both the quit and close-one-window paths).
 */
function windowRecord(win: BrowserWindow): WindowRecord | null {
  if (popouts.has(win.id)) return null;
  const hostId = activeHostForWindow(views, win.id);
  if (hostId === DEV_HOST_ID) return null;
  const route = hostId === null ? "" : routeForView(win, hostId);
  const bounds: WindowBounds = win.getNormalBounds();
  return { hostId, route, bounds };
}

/**
 * Persist the window set from a capture map: one record per captured window
 * in creation order, the LAST-FOCUSED window's record moved to the end so
 * restore's in-order creation focuses it (windowSetForSave, pure).
 */
function saveWindowSet(captured: ReadonlyMap<number, WindowRecord>): void {
  saveWindows(
    userDataDir(),
    windowSetForSave(captured, windowCreationOrder, focusedWindow()?.id ?? null),
  );
}

function createWindow(bounds: WindowBounds | null): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    ...(bounds?.x !== undefined && bounds?.y !== undefined
      ? { x: bounds.x, y: bounds.y }
      : {}),
    backgroundColor: "#0f1117",
    // Hidden native titlebar: the page's top edge is the visible "titlebar"
    // (the SPA draws a 28px accent strip; ./strip's fallback CSS covers older
    // SPAs). macOS composites the traffic lights over the strip; win/linux
    // draw native window controls over its right end via the overlay. The
    // overlay always renders ABOVE attached views.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: DEFAULT_STRIP_COLOR,
            symbolColor: symbolColorFor(DEFAULT_STRIP_COLOR),
            height: STRIP_HEIGHT_PX,
          },
        }
      : {}),
    webPreferences: hostWebPreferences(),
  });
  const windowId = win.id;
  // The window's own webContents only ever shows the welcome page (its
  // theme/strip needs are static) — the per-view wiring lives in
  // createHostView. Views do not auto-resize with the window, so every size
  // transition re-syncs the attached view's bounds.
  win.on("resize", () => syncActiveViewBounds(win));
  win.on("enter-full-screen", () => syncActiveViewBounds(win));
  win.on("leave-full-screen", () => syncActiveViewBounds(win));
  // Focus drives: the cosmetic `activeId` (the LAST FOCUSED window's host)
  // and the menu's rendered state (radio checks + the window-list check).
  win.on("focus", () => {
    trackActiveId(activeHostForWindow(views, windowId));
    rebuildMenu();
  });
  // Capture-on-close for every live view of THIS window (webContents are
  // still readable during 'close'), then the window-set record: on quit the
  // record ACCUMULATES into quitCaptures (windows closed earlier in the same
  // quit keep theirs — the last save holds the whole set); a user closing
  // one of N windows drops only that window's record.
  win.on("close", () => {
    // A popout window's views are NOT captured: its route carries `?pop=`,
    // which must never persist as the host's lastPath (popouts are a
    // viewer-posture window; the opener's own windows own capture).
    if (!popouts.has(windowId)) {
      for (const entry of views.entries.filter((e) => e.windowId === windowId)) {
        captureLastPathForView(entry.hostId, entry.handle.webContents);
      }
    }
    if (quitting) {
      // Views are still alive here (teardown happens at 'closed'), so the
      // record carries the real host/route. A sentinel window captures null
      // and never persists.
      quitCaptures = captureWindowRecord(quitCaptures, windowId, windowRecord(win));
      saveWindowSet(quitCaptures);
    } else {
      // Pop back in: a closing popout's guests return to the OPENER window's
      // parked set when the opener is alive and still attached to that host —
      // the opener's remounting web tile adopts them, no reload. On quit, or
      // with the opener gone or switched to another host, the guests are
      // destroyed with the window as usual. Moved handles leave the closing
      // window's contentView while it is still alive (a child of a destroyed
      // window cannot be re-shown elsewhere).
      const popout = popouts.get(windowId);
      if (popout !== undefined) {
        const opener = windows.get(popout.openerWindowId);
        const openerHostId =
          opener && !opener.isDestroyed() ? activeHostForWindow(views, opener.id) : null;
        if (opener && !opener.isDestroyed() && openerHostId !== null) {
          const { state, moved, evicted } = parkWindowWebViewsInto(
            webViews,
            windowId,
            opener.id,
            openerHostId,
          );
          webViews = state;
          for (const entry of moved) {
            try {
              win.contentView.removeChildView(entry.handle);
            } catch {
              // Already off the tree (a detach raced the close).
            }
          }
          for (const stale of evicted) destroyWebView(stale);
        }
      }
      destroyWindowViews(windowId);
      // Fresh captures of the OTHER live windows — the closing window is
      // excluded up front (its views are already torn down, so capturing it
      // would degrade to a spurious welcome record). An empty map (the last
      // window closed without quitting — macOS window-all-closed) saves an
      // empty set, so the next dock-reopen falls back to hosts.json.
      let captures = new Map<number, WindowRecord>();
      for (const w of windows.values()) {
        if (w.id !== windowId && !w.isDestroyed()) {
          captures = captureWindowRecord(captures, w.id, windowRecord(w));
        }
      }
      saveWindowSet(captures);
    }
  });
  win.on("closed", () => {
    windows.delete(windowId);
    popouts.delete(windowId);
    destroyWindowViews(windowId); // idempotent — 'close' already ran it
    repaintBadge(); // the displayed set lost this window's host
    rebuildMenu(); // the mac Window-menu list
  });
  windows.set(windowId, win);
  windowCreationOrder.push(windowId);
  return win;
}

/**
 * Cold start + macOS dock-reopen: restore the recorded window set
 * (one window per record, in order — the last-created takes focus), or the
 * single dev-sentinel window under RK_DESKTOP_URL, or one fallback window
 * when nothing is recorded (active host via the cosmetic activeId, else
 * welcome).
 */
function restoreOrOpenInitial(): void {
  if (windows.size > 0) return;
  if (devUrl) {
    const win = createWindow(null);
    // Dev override: one sentinel-id view — the same per-view wiring
    // (security, theme, badge) as a registered host, nothing persisted.
    attachHostView(win, { id: DEV_HOST_ID, url: devUrl });
    return;
  }
  const list = loadHosts(userDataDir());
  for (const target of restoreTargets(loadWindows(userDataDir()), list)) {
    const win = createWindow(target.bounds);
    if (target.hostId === null) {
      showWelcome(win);
    } else {
      const host = list.hosts.find((h) => h.id === target.hostId);
      if (host) attachHostView(win, host, target.route);
      else showWelcome(win); // unreachable — restoreTargets resolves or degrades
    }
  }
}

/**
 * New Window (the menu item, `shell:new-window`, and `second-instance`):
 * duplicate the SOURCE window — same host, same CURRENT route, in a FRESH
 * independent view (never a shared or moved one). A welcome source (or no
 * window at all — the second-instance cold case) opens welcome.
 */
function openDuplicateWindow(sourceWin: BrowserWindow | null): void {
  const sourceHostId =
    sourceWin && !sourceWin.isDestroyed() ? activeHostForWindow(views, sourceWin.id) : null;
  // A popout source duplicates as an ORDINARY window — the same host at the
  // same route minus the `pop` param (the new window is no popout).
  const isPopoutSource = sourceWin !== null && popouts.has(sourceWin.id);
  const source =
    sourceWin && !sourceWin.isDestroyed()
      ? {
          hostId: sourceHostId,
          route:
            sourceHostId !== null
              ? isPopoutSource
                ? stripPopParam(routeForView(sourceWin, sourceHostId))
                : routeForView(sourceWin, sourceHostId)
              : "",
        }
      : { hostId: null, route: "" };
  const target = newWindowTarget(source);
  const win = createWindow(null);
  if (target.hostId === null) {
    showWelcome(win);
    return;
  }
  if (target.hostId === DEV_HOST_ID && devUrl) {
    // The sentinel duplicates like any host — an independent sentinel-scoped
    // view in the new window, still never persisted.
    attachHostView(win, { id: DEV_HOST_ID, url: devUrl }, target.route);
    return;
  }
  const host = loadHosts(userDataDir()).hosts.find((h) => h.id === target.hostId);
  if (host) attachHostView(win, host, target.route);
  else showWelcome(win); // the source's host vanished mid-click
}

app.on("web-contents-created", (_event, contents) => {
  // New windows are always denied; every http(s) target — registered origins
  // included — goes to the system browser (policy in ./window-open, covered by
  // node:test). There is no in-window branch: a new-window intent never
  // navigates the shell window.
  contents.setWindowOpenHandler(({ url }) => {
    if (windowOpenAction(url) === "open-external") void shell.openExternal(url);
    return { action: "deny" };
  });

  // One guard for both user navigation and host-issued redirects — a
  // registered host must not be able to escape in-window via a redirect.
  // Blocked targets forward to the system: http(s) to the browser, and
  // allowlisted editor deeplinks (`vscode:`/`cursor:`/`windsurf:` — the SPA's
  // "Open in app" targets assign them to window.location.href) to the editor
  // (260801-sm6g; previously silently dropped). The allowlist lives in
  // ./window-open beside its node:test coverage.
  const guardNavigation = (
    event: { preventDefault: () => void },
    url: string,
  ): void => {
    // Guests (web-tile views) answer to a SCHEME allowlist, not the host-origin
    // allowlist: they browse http(s) freely in place, and every other scheme
    // is dropped — never forwarded to openExternal (that forward exists for
    // the SPA's own deeplink targets; a guest is an arbitrary web page).
    if (isGuestContents(webViews, contents.id)) {
      if (guestNavigationAction(url) === "deny") event.preventDefault();
      return;
    }
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    if (isHttpUrl(url) || isEditorDeeplink(url)) void shell.openExternal(url);
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
});

// No 'certificate-error' handler: TLS errors fail closed (no bypass).

void app.whenReady().then(() => {
  // userData is keyed on the app name, so the rename moved the stores to a
  // fresh directory — carry the legacy "Run Kit" sibling's stores forward
  // once, before any loadHosts/loadWindows read, then retire the sibling
  // (./user-data-migration). A failed carry-forward may be partial, so the
  // sibling survives that start.
  const legacyUserDataDir = join(dirname(userDataDir()), "Run Kit");
  const { copied, failed } = carryForwardLegacyUserData(userDataDir(), legacyUserDataDir);
  if (copied.length > 0) {
    console.log(`carried forward legacy userData stores: ${copied.join(", ")}`);
  }
  if (!failed && retireLegacyUserData(userDataDir(), legacyUserDataDir).removed) {
    console.log(`removed legacy userData dir: ${legacyUserDataDir}`);
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  registerIpcHandlers();
  rebuildMenu();
  restoreOrOpenInitial();

  // Seed the Daemon menu state (read-only detection — never a start),
  // and keep it fresh on focus; the welcome page's polls also feed the cache.
  // The desktop-update check rides the same natural events, behind its own
  // 1h throttle (refreshUpdateMenu gates internally).
  void refreshDaemonMenu();
  void refreshUpdateMenu();
  app.on("browser-window-focus", () => {
    void refreshDaemonMenu();
    void refreshUpdateMenu();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) restoreOrOpenInitial();
  });
});

app.on("before-quit", () => {
  // The next per-window 'close' handlers keep their records (the whole set
  // restores next launch) instead of dropping them one by one.
  quitting = true;
  for (const hostId of [...hostProxyListeners.keys()]) closeHostProxyListener(hostId);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
