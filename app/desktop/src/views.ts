/**
 * Per-window view registry pure logic — which renderer view exists for which
 * (window, host) pair, which view is attached in each window, the per-view
 * badge-count and theme-color caches that the switch seam repaints from, the
 * cross-window badge aggregation, and the load-failure flag transitions the
 * remote-tunnel heal gates its reload on.
 *
 * Deliberately electron-free (the `hosts.ts` / `window-open.ts` /
 * `local-daemon.ts` / `update-check.ts` / `strip.ts` / `badge.ts` precedent):
 * the actual `WebContentsView` is an opaque generic handle `H`, so the
 * sibling `views.test.ts` covers the decision logic under plain
 * `node --test`. The impure glue — view construction, attach/detach on a
 * window's contentView, `setBounds`, `setTitleBarOverlay`, badge painting —
 * lives in `main.ts`.
 *
 * Identity: entries key on (windowId, hostId) — the same host may show in N
 * windows (each an independent view; views never migrate between windows),
 * and several host entries may share one ORIGIN, so origin is never a key
 * here. `webContentsId` is carried so IPC reports (`badge:set`), whose
 * sender is a webContents, resolve to their view without an origin lookup.
 */

export interface ViewEntry<H> {
  /** The BrowserWindow id this view is attached to (window-scoped). */
  windowId: number;
  hostId: string;
  /** The view's webContents id — the IPC sender key (origins can be shared). */
  webContentsId: number;
  /** Opaque view handle (the WebContentsView in main.ts). */
  handle: H;
  /** Last `badge:set` report from this view's page (0 = none/cleared). */
  badgeCount: number;
  /** Last theme color observed from this view (null = none observed yet). */
  themeColor: string | null;
  /** Last `nameplate:set` report from this view's page (null = none yet).
   *  In-memory only — never persisted; the hover preview of a host that has
   *  no live view simply shows its name. */
  nameplate: NameplateReport | null;
}

/** What a host's own SPA reports for the strip's nameplate preview. */
export interface NameplateReport {
  /** `${sshUser}@${hostname}` (or the hostname alone). */
  machine?: string;
  /** The daemon's `runtime.GOOS`. */
  os?: string;
  /** Tabs with an agent, in any state. */
  agents?: number;
}

const NAMEPLATE_MACHINE_MAX = 256;
const NAMEPLATE_OS_MAX = 32;
const NAMEPLATE_AGENTS_MAX = 100_000;
const NAMEPLATE_OS_SHAPE = /^[A-Za-z0-9_-]+$/;
// Printable text only: the value is rendered into the strip, so control
// characters are rejected outright rather than stripped.
const NAMEPLATE_MACHINE_SHAPE = /^[^\p{Cc}\p{Cf}]+$/u;

/**
 * Strict validation of a `nameplate:set` payload — a plain object carrying
 * at least one of `machine` (bounded printable string), `os` (short token),
 * `agents` (bounded non-negative integer), and nothing else. Anything else is
 * null (rejected whole, never partially applied).
 */
export function parseNameplateReport(payload: unknown): NameplateReport | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const report: NameplateReport = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "machine") {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > NAMEPLATE_MACHINE_MAX ||
        !NAMEPLATE_MACHINE_SHAPE.test(value)
      ) {
        return null;
      }
      report.machine = value;
    } else if (key === "os") {
      if (
        typeof value !== "string" ||
        value.length > NAMEPLATE_OS_MAX ||
        !NAMEPLATE_OS_SHAPE.test(value)
      ) {
        return null;
      }
      report.os = value;
    } else if (key === "agents") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > NAMEPLATE_AGENTS_MAX
      ) {
        return null;
      }
      report.agents = value;
    } else {
      return null;
    }
  }
  return Object.keys(report).length === 0 ? null : report;
}

export interface ViewsState<H> {
  /** Insertion order = first-visit order. */
  entries: ViewEntry<H>[];
  /** Per-window attached host (at most one entry per windowId); empty when
   *  every window shows welcome / nothing. Array order is activation order. */
  active: { windowId: number; hostId: string }[];
}

export function emptyViews<H>(): ViewsState<H> {
  return { entries: [], active: [] };
}

export function getView<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
): ViewEntry<H> | null {
  return (
    state.entries.find((e) => e.windowId === windowId && e.hostId === hostId) ?? null
  );
}

/** Resolve an IPC sender (a webContents id) to its view entry. */
export function findViewByWebContentsId<H>(
  state: ViewsState<H>,
  webContentsId: number,
): ViewEntry<H> | null {
  return state.entries.find((e) => e.webContentsId === webContentsId) ?? null;
}

/** The host attached in a window (null = welcome / none / unknown window). */
export function activeHostForWindow<H>(
  state: ViewsState<H>,
  windowId: number,
): string | null {
  return state.active.find((a) => a.windowId === windowId)?.hostId ?? null;
}

/** A window's attached view entry, when a host view is showing there. */
export function activeView<H>(state: ViewsState<H>, windowId: number): ViewEntry<H> | null {
  const hostId = activeHostForWindow(state, windowId);
  if (hostId === null) return null;
  return getView(state, windowId, hostId);
}

/**
 * Register a freshly created view for a (window, host) pair. A pair that
 * already has a view is left unchanged (views are created lazily, exactly
 * once per pair) — the caller must check `getView` first and reuse the
 * existing handle.
 */
export function addView<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
  handle: H,
  webContentsId: number,
): ViewsState<H> {
  if (getView(state, windowId, hostId) !== null) return state;
  return {
    ...state,
    entries: [
      ...state.entries,
      { windowId, hostId, webContentsId, handle, badgeCount: 0, themeColor: null, nameplate: null },
    ],
  };
}

/** Mark a host's view as the attached one in a window. Unknown pair is a no-op. */
export function activateView<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
): ViewsState<H> {
  if (getView(state, windowId, hostId) === null) return state;
  const rest = state.active.filter((a) => a.windowId !== windowId);
  return { ...state, active: [...rest, { windowId, hostId }] };
}

/** No view attached in a window (welcome showing there). Caches are kept. */
export function deactivateViews<H>(state: ViewsState<H>, windowId: number): ViewsState<H> {
  if (activeHostForWindow(state, windowId) === null) return state;
  return { ...state, active: state.active.filter((a) => a.windowId !== windowId) };
}

/**
 * Drop a (window, host) view entry (host removed, or teardown). Returns the
 * removed entry so the caller can detach + close its webContents; clears the
 * window's active pointer when it pointed there.
 */
export function removeView<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
): { state: ViewsState<H>; removed: ViewEntry<H> | null } {
  const removed = getView(state, windowId, hostId);
  if (removed === null) return { state, removed: null };
  return {
    state: {
      entries: state.entries.filter(
        (e) => !(e.windowId === windowId && e.hostId === hostId),
      ),
      active: state.active.filter(
        (a) => !(a.windowId === windowId && a.hostId === hostId),
      ),
    },
    removed,
  };
}

/**
 * Drop EVERY view of a window (the window is closing). Returns the removed
 * entries so the caller can close their webContents; the window's active
 * pointer goes with them.
 */
export function removeWindowViews<H>(
  state: ViewsState<H>,
  windowId: number,
): { state: ViewsState<H>; removed: ViewEntry<H>[] } {
  const removed = state.entries.filter((e) => e.windowId === windowId);
  if (removed.length === 0) return { state, removed: [] };
  return {
    state: {
      entries: state.entries.filter((e) => e.windowId !== windowId),
      active: state.active.filter((a) => a.windowId !== windowId),
    },
    removed,
  };
}

/**
 * Drop a host's views across ALL windows (host removed). Returns the removed
 * entries so the caller can detach + close their webContents; any active
 * pointer at that host goes with them.
 */
export function removeHostViews<H>(
  state: ViewsState<H>,
  hostId: string,
): { state: ViewsState<H>; removed: ViewEntry<H>[] } {
  const removed = state.entries.filter((e) => e.hostId === hostId);
  if (removed.length === 0) return { state, removed: [] };
  return {
    state: {
      entries: state.entries.filter((e) => e.hostId !== hostId),
      active: state.active.filter((a) => a.hostId !== hostId),
    },
    removed,
  };
}

/**
 * Record a `badge:set` report for a view. Background views' reports update
 * their cache silently — whether to PAINT is the caller's decision (the
 * aggregate over displayed hosts). Unknown pair is a no-op.
 */
export function setViewBadge<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
  count: number,
): ViewsState<H> {
  if (getView(state, windowId, hostId) === null) return state;
  return {
    ...state,
    entries: state.entries.map((e) =>
      e.windowId === windowId && e.hostId === hostId ? { ...e, badgeCount: count } : e,
    ),
  };
}

/** Record the last observed theme color for a view. Unknown pair is a no-op. */
export function setViewThemeColor<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
  color: string | null,
): ViewsState<H> {
  if (getView(state, windowId, hostId) === null) return state;
  return {
    ...state,
    entries: state.entries.map((e) =>
      e.windowId === windowId && e.hostId === hostId ? { ...e, themeColor: color } : e,
    ),
  };
}

/** Record a `nameplate:set` report for a view. Unknown pair is a no-op. */
export function setViewNameplate<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
  report: NameplateReport,
): ViewsState<H> {
  if (getView(state, windowId, hostId) === null) return state;
  return {
    ...state,
    entries: state.entries.map((e) =>
      e.windowId === windowId && e.hostId === hostId ? { ...e, nameplate: report } : e,
    ),
  };
}

/**
 * A host's nameplate report for the `servers:list` projection: the first
 * live view (any window, first-visit order) that has reported. Two views of
 * one host read the same daemon, so any deterministic pick is correct.
 */
export function hostNameplate<H>(state: ViewsState<H>, hostId: string): NameplateReport | null {
  for (const e of state.entries) {
    if (e.hostId === hostId && e.nameplate !== null) return e.nameplate;
  }
  return null;
}

/**
 * What to repaint when attaching a host's view in a window: its cached badge
 * count (0 — i.e. clear — when the view is fresh or unknown) and its cached
 * theme color (null → the caller applies the default strip color). This is
 * the switch-time decision: state comes from the INCOMING view's caches,
 * never carried over from the outgoing one.
 */
export function switchPaint<H>(
  state: ViewsState<H>,
  windowId: number,
  hostId: string,
): { badgeCount: number; themeColor: string | null } {
  const entry = getView(state, windowId, hostId);
  if (entry === null) return { badgeCount: 0, themeColor: null };
  return { badgeCount: entry.badgeCount, themeColor: entry.themeColor };
}

/**
 * The OS badge aggregate: the sum of waiting counts over the DISTINCT hosts
 * attached in any window — a host displayed by two windows counts ONCE (the
 * count comes from the FIRST-CREATED window showing it — window ids increment
 * with creation, so the smallest active id wins; two views of one host are
 * independent renderers that normally report the same number, so any
 * deterministic pick is correct). Windows showing welcome contribute nothing.
 */
export function aggregateBadge<H>(state: ViewsState<H>): number {
  const firstWindowByHost = new Map<string, number>();
  for (const a of state.active) {
    const current = firstWindowByHost.get(a.hostId);
    if (current === undefined || a.windowId < current) {
      firstWindowByHost.set(a.hostId, a.windowId);
    }
  }
  let total = 0;
  for (const [hostId, windowId] of firstWindowByHost) {
    total += getView(state, windowId, hostId)?.badgeCount ?? 0;
  }
  return total;
}

// ─── Load-failure flag (the remote-tunnel heal's reload gate) ────────────────

/** Chromium's "navigation superseded by another" — never a real failure. */
export const ERR_ABORTED = -3;

/** The main-frame load lifecycle events that drive the failure flag. */
export type LoadFlagEvent =
  | { kind: "did-fail-load"; isMainFrame: boolean; errorCode: number }
  | { kind: "did-navigate"; isInterstitial: boolean }
  | { kind: "did-finish-load" };

/**
 * Next value of a view's "last main-frame load failed" flag — the gate the
 * remote-tunnel heal reads to decide whether a healed host's view needs a
 * reload (a warm view keeps its live renderer state, never reloaded).
 *
 * Set by a real main-frame `did-fail-load` (ERR_ABORTED excluded — a
 * superseded navigation is not a failure). Cleared ONLY by a `did-navigate`
 * commit to the real host; a commit to the shell-owned interstitial preserves
 * the failed state so the next successful heal still reloads the host.
 * `did-finish-load` NEVER clears: Chromium fires it for its own error page
 * immediately after `did-fail-load`, so clearing there would wipe the flag
 * before a background heal completes.
 */
export function nextLoadFailed(prev: boolean, event: LoadFlagEvent): boolean {
  switch (event.kind) {
    case "did-fail-load":
      return event.isMainFrame && event.errorCode !== ERR_ABORTED ? true : prev;
    case "did-navigate":
      return event.isInterstitial ? prev : false;
    case "did-finish-load":
      return prev;
  }
}
