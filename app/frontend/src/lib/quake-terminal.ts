import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectSession, WindowInfo } from "@/types";
import type { QuakeSegment } from "@/components/terminal-activity-tabs";
import { sendOperatorRequest, sendToWindow, uploadFile } from "@/api/client";
import { SessionContext, useCurrentServerFromRoute } from "@/contexts/session-context";
import {
  clearComposeDraft,
  getComposeDraft,
  setComposeText,
  subscribeComposeDraft,
} from "@/lib/compose-draft-store";
import { resolveFocusedWindow } from "@/lib/focused-pane-window";
import { urlSegmentToWindowId } from "@/lib/router-url";
import { entryKey } from "@/store/window-store";

/**
 * Quake terminal support — pure helpers for the pull-down quake terminal
 * overlay (components/quake-terminal.tsx) plus its entry-point seams:
 *
 *  - `resolveQuakeServer` — the server-context rule: the route's server on
 *    Server/Terminal routes; on Host/Board the sole server when exactly one
 *    exists, else the most recently viewed server (then the first) as the
 *    picker default.
 *  - `findOperatorWindow` — client-side operator discovery from the sessions
 *    payload (`role === "operator"` — server-scoped radio, enforced
 *    backend-side, so the first hit is the only hit).
 *  - `shouldShowAskOperatorRow` — the palette free-text fallback gate: zero
 *    action matches + an operator on the resolved server + a trimmed query at
 *    or above the length floor (short typo fragments never fire a send).
 *  - `requestQuakeTerminal` — the document-event seam every entry point
 *    (chord dispatch, palette action, overflow-menu row, palette fallback row,
 *    mobile tongue) funnels through
 *    to the single layout-mounted quake terminal, which forks on form factor:
 *    desktop drives the ⌘J machine, mobile navigates to the operator
 *    window's terminal route. An event, not a callback chain: the entry
 *    points live in route shells the layout does not compose directly. The
 *    request is buffered until the quake terminal handles it, so a dispatch
 *    fired before the lazy quake terminal mounts is drained on mount rather
 *    than lost.
 *  - The ⌘J two-state machine (`rest | open`, focus and drawer linked) — the
 *    desktop quake terminal's controlling state, shared between the top-bar
 *    quake launcher and the drawer (module slot, the open-state idiom),
 *    flanked by the pin slot, the compose-engaged slot, and the
 *    restore-origin slot (same idiom; all ephemeral).
 *  - The shared compose seam (`useOperatorCompose` + `sendOperatorMessage` +
 *    `attachOperatorFiles`) — ONE send/upload implementation whose desktop
 *    view is the drawer's docked compose strip while open (the standing quake
 *    launcher box is its rest-state affordance). The draft TEXT is a
 *    compose-draft-store entry keyed by the operator window target
 *    (`operatorComposeKey`), so a draft stays with the operator it addresses
 *    when the resolved server changes; the in-flight flags and the inline
 *    error are module state keyed per server.
 *  - The chat-subject store (`setOperatorChatSubject` + `useOperatorChatChip`)
 *    — the templated chat lane's context: on a terminal route the quake
 *    terminal stamps the route window here (the validated `?from=` origin on
 *    the operator window's own route), the docked compose strip and the
 *    operator route's compose strip render the dismissable chip from it, and
 *    `sendOperatorMessage` (plus the strip's plain-submit path) reads it AT
 *    SEND TIME to fork between the templated lane (`sendOperatorRequest(...,
 *    "user-message", ...)` — a server-derived source envelope wraps the text;
 *    the busy gate and queue are skipped server-side) and the direct
 *    `sendToWindow` lane.
 *  - Per-viewer persisted preferences (geometry, opacity) — localStorage
 *    stores with the in-module pub/sub idiom (`use-local-storage-enum.ts`).
 *  - The quake-terminal-origin event predicate and `useQuakeTerminalContext` —
 *    the read-only server/target resolution the quake launcher and mobile
 *    tongue share with the quake terminal.
 */

/** Minimum trimmed query length before the palette's Ask-operator row appears. */
export const ASK_OPERATOR_MIN_QUERY = 3;

/** Document event name carrying `QuakeTerminalRequest` details. */
export const QUAKE_TERMINAL_EVENT = "rk:quake-terminal";

/** The resolved operator's live state mapped to the shared state-dot color. */
export const OPERATOR_STATE_DOT: Record<string, string> = {
  waiting: "bg-signal-yellow",
  active: "bg-accent-green",
};

export type QuakeTerminalRequest = {
  /** `toggle` steps the desktop ⌘J machine (rest ⇄ open); `open` always
   *  opens (desktop: drawer plus quake launcher focus). On mobile both actions
   *  collapse to navigation to the operator window's terminal route. */
  action: "toggle" | "open";
  /** Pin the quake terminal to this server (for example, the palette fallback
   *  passes its resolved server). Absent = resolve from the route/server list. */
  server?: string;
  /** Text to deliver on open, once the operator window resolves (the sessions
   *  slice can lag the open). Never delivered when the resolved server has no
   *  operator window — the quake terminal's hint line is the answer there. On
   *  mobile the text is seeded into the operator route's compose-strip draft
   *  instead of auto-sending. */
  send?: string;
  /** The body segment to select on open. Desktop applies it to the drawer's
   *  segment state (and bypasses the already-on-operator-route hint — the
   *  non-terminal views are not visible on the desktop route itself); mobile
   *  maps any non-terminal segment to the operator route's `?tab=` search
   *  param. Absent = no segment change. The type derives from the segment
   *  strip's SEGMENTS; router-url.ts keeps its own literal union (a
   *  dependency-free leaf) and the two are guarded by a Vitest agreement
   *  test. */
  segment?: QuakeSegment;
};

/** The most recent request, buffered until the quake terminal handles it. The
 *  quake terminal is lazy-mounted behind Suspense, so a cold-load event can
 *  fire before its listener attaches; an unhandled request stays here for the
 *  quake terminal to drain on mount, and a live quake terminal clears it
 *  synchronously inside its event handler. */
let pendingQuakeRequest: QuakeTerminalRequest | null = null;

/** Dispatch a quake terminal request to the layout-mounted QuakeTerminal. The
 *  request is buffered until handled, so a dispatch that precedes the lazy
 *  quake terminal's mount is replayed when its listener attaches — the seam
 *  is replayable, never lost. */
export function requestQuakeTerminal(req: QuakeTerminalRequest): void {
  pendingQuakeRequest = req;
  document.dispatchEvent(new CustomEvent<QuakeTerminalRequest>(QUAKE_TERMINAL_EVENT, { detail: req }));
}

/** Clear the buffered request — the quake terminal calls this once it has
 *  handled a request, so a later mount cannot replay an already-handled one. */
export function clearPendingQuakeRequest(): void {
  pendingQuakeRequest = null;
}

/** Take and clear the buffered request, if any — the quake terminal's mount
 *  drain for requests that fired before its listener attached. */
export function drainPendingQuakeRequest(): QuakeTerminalRequest | null {
  const req = pendingQuakeRequest;
  pendingQuakeRequest = null;
  return req;
}

/** Type guard for the event detail (tolerant of foreign CustomEvents). */
export function isQuakeTerminalRequest(detail: unknown): detail is QuakeTerminalRequest {
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as Record<string, unknown>;
  return d.action === "toggle" || d.action === "open";
}

/**
 * Resolve the quake terminal's server context. `routeServer` (the current
 * route's server param, when any) always wins; Host/Board routes fall to the
 * sole server, then `lastViewed` (still-listed), then the first listed server.
 * `null` only when the server list is empty (still loading or genuinely
 * server-less) — the quake terminal degrades to its hint line there.
 */
export function resolveQuakeServer(
  routeServer: string | null,
  servers: readonly string[],
  lastViewed: string | null,
): string | null {
  if (routeServer) return routeServer;
  if (servers.length === 1) return servers[0];
  if (lastViewed && servers.includes(lastViewed)) return lastViewed;
  return servers[0] ?? null;
}

export type OperatorWindowTarget = {
  window: WindowInfo;
  /** The window's session name — TerminalClient's `sessionName` prop. */
  sessionName: string;
};

/**
 * Find the operator window in one server's sessions payload. Ghost/optimistic
 * rows never carry `role`, so a plain field check suffices.
 */
export function findOperatorWindow(sessions: readonly ProjectSession[]): OperatorWindowTarget | undefined {
  for (const session of sessions) {
    for (const win of session.windows) {
      if (win.role === "operator" && win.windowId !== "") {
        return { window: win, sessionName: session.name };
      }
    }
  }
  return undefined;
}

/** The palette fallback-row gate: zero matches, operator present, query at floor. */
export function shouldShowAskOperatorRow(query: string, matchCount: number, hasOperator: boolean): boolean {
  return matchCount === 0 && hasOperator && query.trim().length >= ASK_OPERATOR_MIN_QUERY;
}

/**
 * Validate a `?from=` search value against one server's sessions payload: the
 * origin window it names, or null for an absent, self, or unknown id. The ONE
 * validation both consumers apply — the quake terminal's chat-subject stamping
 * and the tongue's return tap — so the two paths cannot drift (cross-server
 * ids are excluded by resolving against the route server's own sessions).
 */
export function resolveFromOrigin(
  raw: unknown,
  routeWindow: string | null,
  sessions: ProjectSession[],
): WindowInfo | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const id = urlSegmentToWindowId(raw);
  if (id === routeWindow) return null;
  return resolveFocusedWindow(sessions, id);
}

// ── Per-viewer persisted preferences (Constitution IV — localStorage) ────────
//
// Two stores, both following the in-module pub/sub idiom of
// `use-local-storage-enum.ts` (the native `storage` event fires only across
// tabs, so same-tab subscribers — the quake terminal and the settings-dialog
// row — need the dispatch). Values are continuous, so the enum hook's
// allowed-list validation is replaced by numeric clamping; absent/corrupt/
// out-of-clamp values resolve to the defaults without error.

/** localStorage key for the desktop drawer geometry
 *  (`{heightVh, widthPx, centerOffsetPx}`; a stored record without the offset
 *  reads as offset 0). */
export const QUAKE_GEOMETRY_KEY = "hexokit-quake-terminal-geometry";
/** localStorage key for the desktop drawer background opacity. */
export const QUAKE_OPACITY_KEY = "hexokit-quake-terminal-opacity";
/** Retired key names; read as a fallback so viewers keep their drawer size
 *  and glass, removed on the next write (the fallback is one-shot). */
export const LEGACY_QUAKE_GEOMETRY_KEY = "runkit-operator-console-geometry";
export const LEGACY_QUAKE_OPACITY_KEY = "runkit-operator-console-opacity";

/** The desktop drawer's box: height in vh, width in px, and the signed
 *  displacement of its center from the viewport center (positive = right).
 *  Each edge resizes independently, so the drawer may rest off-center. */
export type QuakeGeometry = { heightVh: number; widthPx: number; centerOffsetPx: number };

/** Which drawer edges a grip moves: `x` −1 = left edge, +1 = right edge, 0 =
 *  neither; `y` 1 = bottom edge, 0 = not. A corner sets both. */
export type QuakeResizeEdge = { x: -1 | 0 | 1; y: 0 | 1 };

export const QUAKE_GEOMETRY_DEFAULT: QuakeGeometry = { heightVh: 55, widthPx: 760, centerOffsetPx: 0 };
export const QUAKE_HEIGHT_MIN_VH = 25;
export const QUAKE_HEIGHT_MAX_VH = 85;
export const QUAKE_WIDTH_MIN_PX = 420;
/** Width ceiling as a fraction of the viewport (96vw). */
export const QUAKE_WIDTH_MAX_VW = 0.96;
/** Ground kept visible between the drawer and either viewport edge when the
 *  center offset is clamped. */
export const QUAKE_EDGE_PAD_PX = 8;

export const QUAKE_OPACITY_DEFAULT = 0.95;
export const QUAKE_OPACITY_MIN = 0.5;
export const QUAKE_OPACITY_MAX = 1.0;

function viewportWidthPx(): number | undefined {
  return typeof window !== "undefined" && Number.isFinite(window.innerWidth)
    ? window.innerWidth
    : undefined;
}

/** Clamp geometry into the supported envelope (25–85vh, 420px–96vw), then
 *  bound the center offset so the drawer never leaves the viewport:
 *  `|offset| ≤ (viewport − width)/2 − QUAKE_EDGE_PAD_PX`, evaluated against the
 *  already-clamped width. */
export function clampQuakeGeometry(
  geometry: QuakeGeometry,
  viewportWidth: number | undefined = viewportWidthPx(),
): QuakeGeometry {
  const heightVh = Math.min(QUAKE_HEIGHT_MAX_VH, Math.max(QUAKE_HEIGHT_MIN_VH, geometry.heightVh));
  const maxWidth = viewportWidth !== undefined ? viewportWidth * QUAKE_WIDTH_MAX_VW : Infinity;
  const widthPx = Math.round(Math.min(maxWidth, Math.max(QUAKE_WIDTH_MIN_PX, geometry.widthPx)));
  const maxOffset =
    viewportWidth !== undefined ? Math.max(0, (viewportWidth - widthPx) / 2 - QUAKE_EDGE_PAD_PX) : Infinity;
  const rawOffset = Number.isFinite(geometry.centerOffsetPx) ? geometry.centerOffsetPx : 0;
  const centerOffsetPx = Math.round(Math.min(maxOffset, Math.max(-maxOffset, rawOffset)));
  return { heightVh, widthPx, centerOffsetPx };
}

/** Clamp opacity into the supported envelope (0.5–1.0). */
export function clampQuakeOpacity(opacity: number): number {
  return Math.min(QUAKE_OPACITY_MAX, Math.max(QUAKE_OPACITY_MIN, opacity));
}

function parseStoredGeometry(raw: string): QuakeGeometry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const g = parsed as Record<string, unknown>;
      // The offset is optional on read: records written before it existed
      // carry two fields and mean "centered". Present but unusable is corrupt.
      const offsetOk =
        g.centerOffsetPx === undefined ||
        (typeof g.centerOffsetPx === "number" && Number.isFinite(g.centerOffsetPx));
      if (
        typeof g.heightVh === "number" && Number.isFinite(g.heightVh) &&
        typeof g.widthPx === "number" && Number.isFinite(g.widthPx) &&
        offsetOk
      ) {
        return clampQuakeGeometry({
          heightVh: g.heightVh,
          widthPx: g.widthPx,
          centerOffsetPx: typeof g.centerOffsetPx === "number" ? g.centerOffsetPx : 0,
        });
      }
    }
  } catch {
    // corrupt JSON
  }
  return null;
}

/** Read the stored geometry: the current key first, the retired key only when
 *  the current one is absent (a present-but-corrupt value does not fall
 *  through); anything unusable degrades to the default. */
export function readQuakeGeometry(): QuakeGeometry {
  try {
    const raw = localStorage.getItem(QUAKE_GEOMETRY_KEY) ?? localStorage.getItem(LEGACY_QUAKE_GEOMETRY_KEY);
    if (raw != null) {
      const parsed = parseStoredGeometry(raw);
      if (parsed) return parsed;
    }
  } catch {
    // localStorage unavailable (privacy mode, sandboxed iframe)
  }
  return QUAKE_GEOMETRY_DEFAULT;
}

/** Read the stored opacity with the same retired-key fallback as the geometry. */
export function readQuakeOpacity(): number {
  try {
    const raw = localStorage.getItem(QUAKE_OPACITY_KEY) ?? localStorage.getItem(LEGACY_QUAKE_OPACITY_KEY);
    if (raw != null) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) return clampQuakeOpacity(parsed);
    }
  } catch {
    // localStorage unavailable
  }
  return QUAKE_OPACITY_DEFAULT;
}

const prefSubscribers = new Map<string, Set<() => void>>();

function notifyPref(storageKey: string): void {
  const listeners = prefSubscribers.get(storageKey);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

function subscribePref(storageKey: string, listener: () => void): () => void {
  let listeners = prefSubscribers.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    prefSubscribers.set(storageKey, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = prefSubscribers.get(storageKey);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) prefSubscribers.delete(storageKey);
  };
}

export function writeQuakeGeometry(geometry: QuakeGeometry): void {
  const clamped = clampQuakeGeometry(geometry);
  try {
    localStorage.setItem(QUAKE_GEOMETRY_KEY, JSON.stringify(clamped));
    localStorage.removeItem(LEGACY_QUAKE_GEOMETRY_KEY);
  } catch {
    // localStorage unavailable
  }
  notifyPref(QUAKE_GEOMETRY_KEY);
}

export function writeQuakeOpacity(opacity: number): void {
  const clamped = clampQuakeOpacity(opacity);
  try {
    localStorage.setItem(QUAKE_OPACITY_KEY, String(clamped));
    localStorage.removeItem(LEGACY_QUAKE_OPACITY_KEY);
  } catch {
    // localStorage unavailable
  }
  notifyPref(QUAKE_OPACITY_KEY);
}

/** Shared subscribe effect: re-read on same-tab notify, cross-tab `storage`,
 *  and once on mount (in case another subscriber wrote between render and
 *  effect — the use-local-storage-enum resync). */
function usePrefSubscription(storageKey: string, reread: () => void): void {
  useEffect(() => {
    const unsubscribe = subscribePref(storageKey, reread);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) reread();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
    }
    reread();
    return () => {
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
    // reread is a stable setState-derived callback at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
}

/** The desktop drawer's persisted geometry — `[value, setter]` like the other
 *  localStorage hooks. */
export function useQuakeGeometry(): [QuakeGeometry, (next: QuakeGeometry) => void] {
  const [value, setValue] = useState<QuakeGeometry>(readQuakeGeometry);
  usePrefSubscription(QUAKE_GEOMETRY_KEY, () => setValue(readQuakeGeometry()));
  return [value, writeQuakeGeometry];
}

/** The desktop drawer's persisted background opacity (0.5–1.0, default 0.95).
 *  1.0 disables the backdrop blur entirely — the zero-cost opaque path. */
export function useQuakeOpacity(): [number, (next: number) => void] {
  const [value, setValue] = useState<number>(readQuakeOpacity);
  usePrefSubscription(QUAKE_OPACITY_KEY, () => setValue(readQuakeOpacity()));
  return [value, writeQuakeOpacity];
}

// ── ⌘J two-state machine ─────────────────────────────────────────────────────
//
// The desktop quake terminal is a plain toggle: `rest` (drawer closed, the
// standing launcher box in the top bar) ⇄ `open` (drawer down, the docked
// compose textarea focused, the launcher collapsed to glyph + chord).
// Focus and the expanded drawer are LINKED — engaging the machine from any
// entry point (chord, box click, ghost) both drops the drawer and focuses the
// docked textarea; releasing it does both in reverse. A blur alone does NOT
// release the machine: the drawer is a peek that outlives the compose's focus
// (clicking into its terminal must not collapse it) — the outside-click
// collapse (suspended while pinned) and Esc are the release paths.
// The state lives in a module slot (the open-state slot idiom) because the two
// halves of the surface — the top-bar quake launcher and the layout-mounted
// drawer — are mounted in different trees and must not own each other's
// state. The drawer component is the controller (it interprets the
// document-event seam); the quake launcher is a follower that also originates
// transitions (click-to-focus, Enter). Mobile never engages the machine — its
// seam arm navigates instead.

export type QuakeMachineState = "rest" | "open";

let machineState: QuakeMachineState = "rest";
const machineListeners = new Set<(state: QuakeMachineState) => void>();

/** Bumped on every `setQuakeMachineState` call, including a same-value
 *  no-op — the outside-click-collapse effect's "did anything else already
 *  claim this click" signal (a value-equality check alone would miss a
 *  legitimate same-value re-open while already `open`). */
let machineActivity = 0;

export function getQuakeMachineState(): QuakeMachineState {
  return machineState;
}

export function getQuakeMachineActivity(): number {
  return machineActivity;
}

export function setQuakeMachineState(next: QuakeMachineState): void {
  machineActivity++;
  if (machineState === next) return;
  machineState = next;
  // Entering rest stands every open-scoped flag down: a pin or an engaged
  // compose on a closed drawer is meaningless, so every open starts clean.
  if (next === "rest") {
    setQuakePinned(false);
    setQuakeComposeEngaged(false);
  }
  for (const listener of machineListeners) listener(next);
}

/** The chord step: rest ⇄ open. */
export function cycleQuakeMachine(state: QuakeMachineState): QuakeMachineState {
  return state === "rest" ? "open" : "rest";
}

export function useQuakeMachineState(): QuakeMachineState {
  const [state, setState] = useState(getQuakeMachineState);
  useEffect(() => {
    const listener = (next: QuakeMachineState) => setState(next);
    machineListeners.add(listener);
    setState(getQuakeMachineState());
    return () => {
      machineListeners.delete(listener);
    };
  }, []);
  return state;
}

// ── Pin / compose-engaged / restore-origin slots ─────────────────────────────
//
// Three more module slots beside the machine, same pub/sub idiom. The pin and
// the engaged flag are read from trees the drawer's component state cannot
// reach (the palette builder, the top-bar quake launcher); both are ephemeral
// (Constitution IV — no localStorage, tmux, or URL write) and reset to false
// by `setQuakeMachineState("rest")` above. The restore origin is the ⌘J focus
// return's captured `document.activeElement` — a bare module slot (no
// subscribers: nothing renders from it) so the entry capture and the
// exit-time ownership check share one ref across the two trees.

let quakePinned = false;
const pinnedListeners = new Set<(pinned: boolean) => void>();

export function getQuakePinned(): boolean {
  return quakePinned;
}

export function setQuakePinned(next: boolean): void {
  if (quakePinned === next) return;
  quakePinned = next;
  for (const listener of pinnedListeners) listener(next);
}

export function useQuakePinned(): boolean {
  const [pinned, setPinned] = useState(getQuakePinned);
  useEffect(() => {
    const listener = (next: boolean) => setPinned(next);
    pinnedListeners.add(listener);
    setPinned(getQuakePinned());
    return () => {
      pinnedListeners.delete(listener);
    };
  }, []);
  return pinned;
}

let composeEngaged = false;
const engagedListeners = new Set<(engaged: boolean) => void>();

export function getQuakeComposeEngaged(): boolean {
  return composeEngaged;
}

export function setQuakeComposeEngaged(next: boolean): void {
  if (composeEngaged === next) return;
  composeEngaged = next;
  for (const listener of engagedListeners) listener(next);
}

/** True while the docked compose owns input — drives the accent border on
 *  both the strip's textarea and the collapsed launcher. Focus-derived, never
 *  pin-derived. */
export function useQuakeComposeEngaged(): boolean {
  const [engaged, setEngaged] = useState(getQuakeComposeEngaged);
  useEffect(() => {
    const listener = (next: boolean) => setEngaged(next);
    engagedListeners.add(listener);
    setEngaged(getQuakeComposeEngaged());
    return () => {
      engagedListeners.delete(listener);
    };
  }, []);
  return engaged;
}

let restoreOrigin: HTMLElement | null = null;

/** Record the focus-restore origin at machine entry — kept only when the
 *  active element lies outside every quake-terminal-owned element. */
export function setQuakeRestoreOrigin(origin: HTMLElement | null): void {
  restoreOrigin = origin;
}

/** Take (and clear) the recorded origin for the exit-time restore. */
export function takeQuakeRestoreOrigin(): HTMLElement | null {
  const origin = restoreOrigin;
  restoreOrigin = null;
  return origin;
}

// ── Shared compose seam ──────────────────────────────────────────────────────
//
// ONE compose implementation drives the quake terminal's input surfaces: the
// drawer's docked compose strip while open, the standing quake launcher box
// (top-bar center cell) at rest. The draft text lives in the compose-draft
// store under the operator window's key; the in-flight flags and the inline
// error are module state keyed per server; the send/upload logic exists
// exactly once. Delivery rides the existing lanes: `sendToWindow(...,
// "submit", "agent")` for messages, `uploadFile` + a `"raw"` insert per
// returned path for files (staged into the TUI composer, never submitted).

// ── Chat-subject store (the templated chat lane's context chip) ──────────────
//
// On a terminal route the quake terminal stamps the route's window here — or,
// on the operator window's own route, the validated `?from=` origin window
// (only when the quake terminal's resolved server IS the route's server —
// window ids are server-scoped, so a pinned/picked cross-server retarget must
// never attach a foreign id). Module state, like the compose seam, so the
// docked compose strip and the operator route's compose strip render one chip
// in lockstep — and so the send forks read the CURRENT attachment at send time
// rather than a captured closure (a pendingSend delivered in the same commit
// as a chip reset must see the reset).

export type OperatorChatSubject = {
  /** The server the subject window lives on — the fork applies only when the
   *  send's resolved server matches. */
  server: string;
  windowId: string;
  /** Display name for the chip; null while the sessions payload lags. */
  name: string | null;
};

export type OperatorChatChipState = {
  subject: OperatorChatSubject | null;
  /** Dismissal is ephemeral per-viewer state (Constitution IV): it clears on a
   *  subject change and on `resetOperatorChatChip` (quake terminal
   *  re-engage). */
  dismissed: boolean;
};

let chatChipState: OperatorChatChipState = { subject: null, dismissed: false };
const chatChipListeners = new Set<() => void>();

function patchChatChip(next: OperatorChatChipState): void {
  chatChipState = next;
  for (const listener of chatChipListeners) listener();
}

/** Stamp the current chat subject (the route window, or null off terminal
 *  routes). A change of subject identity resets dismissal; a same-subject
 *  restamp (e.g. the name resolving) preserves it. */
export function setOperatorChatSubject(subject: OperatorChatSubject | null): void {
  const prev = chatChipState.subject;
  const sameIdentity =
    prev !== null &&
    subject !== null &&
    prev.server === subject.server &&
    prev.windowId === subject.windowId;
  patchChatChip({ subject, dismissed: sameIdentity ? chatChipState.dismissed : false });
}

/** Detach the context for subsequent sends (the chip's ✕). */
export function dismissOperatorChatChip(): void {
  patchChatChip({ ...chatChipState, dismissed: true });
}

/** Re-attach the context — fired when the quake terminal re-engages (the
 *  machine leaves rest). */
export function resetOperatorChatChip(): void {
  patchChatChip({ ...chatChipState, dismissed: false });
}

/** The subject a send on `server` should attach, read at send time: null when
 *  none stamped, dismissed, or stamped for a different server. */
export function getOperatorChatTarget(server: string | null): OperatorChatSubject | null {
  const { subject, dismissed } = chatChipState;
  if (!server || !subject || dismissed || subject.server !== server) return null;
  return subject;
}

/** Subscribe to the chip state (both compose surfaces render from this). */
export function useOperatorChatChip(): OperatorChatChipState {
  const [state, setState] = useState(chatChipState);
  useEffect(() => {
    const listener = () => setState(chatChipState);
    chatChipListeners.add(listener);
    setState(chatChipState);
    return () => {
      chatChipListeners.delete(listener);
    };
  }, []);
  return state;
}

/** The in-flight facts about a send against one server's operator. Never
 *  persisted — these are not drafts. */
export type QuakeComposeFlags = {
  sending: boolean;
  uploading: boolean;
  error: string | null;
};

export type QuakeComposeState = { text: string } & QuakeComposeFlags;

const FLAGS_INITIAL: QuakeComposeFlags = { sending: false, uploading: false, error: null };
// Keyed by SERVER name, not by draft key: a server has exactly one operator
// window at a time, and a server key keeps the no-target case representable
// (an upload error still surfaces when the target vanished mid-flight).
const composeFlags = new Map<string, QuakeComposeFlags>();
const composeListeners = new Set<() => void>();

/**
 * The draft-store key for the quake compose: the SEND TARGET (the operator
 * window), in the same `entryKey(server, windowId)` grammar the route compose
 * strip uses — so the operator page's own strip and the drawer read one draft.
 * null when no operator window resolves on the server: nothing to address.
 */
export function operatorComposeKey(
  server: string | null,
  target: OperatorWindowTarget | undefined,
): string | null {
  if (!server || !target) return null;
  return entryKey(server, target.window.windowId);
}

/** This server's flags — a stable object while unchanged; the shared initial
 *  flags for null/absent. */
function flagsFor(server: string | null): QuakeComposeFlags {
  if (!server) return FLAGS_INITIAL;
  return composeFlags.get(server) ?? FLAGS_INITIAL;
}

function patchFlags(server: string, patch: Partial<QuakeComposeFlags>): void {
  composeFlags.set(server, { ...flagsFor(server), ...patch });
  for (const listener of composeListeners) listener();
}

function subscribeFlags(listener: () => void): () => void {
  composeListeners.add(listener);
  return () => {
    composeListeners.delete(listener);
  };
}

/** Test-only: drop every server's in-flight flags (the draft text is reset
 *  through the draft store's own `hydrateComposeDrafts`). */
export function resetOperatorComposeFlags(): void {
  composeFlags.clear();
  for (const listener of composeListeners) listener();
}

/** Edit this target's draft; any edit clears THAT server's inline error line.
 *  A no-op when no operator window resolves (nothing to address). */
export function setOperatorComposeText(
  server: string | null,
  target: OperatorWindowTarget | undefined,
  text: string,
): void {
  if (!server) return;
  const key = operatorComposeKey(server, target);
  if (key === null) return;
  setComposeText(key, text);
  if (flagsFor(server).error !== null) patchFlags(server, { error: null });
}

/**
 * Deliver a composed message. With a chat subject attached for this server
 * (read from the chat-subject store AT SEND TIME, never a captured closure),
 * the message rides the templated chat lane — `sendOperatorRequest(server,
 * subjectWindowId, "user-message", value)`, where the backend wraps the text
 * in a server-derived source envelope and skips the busy gate and queue.
 * Otherwise it rides the direct agent send lane with chat-send busy semantics
 * (allow + probe — no client-side busy gate). A whitespace-only or in-flight
 * send is a guarded no-op. The draft survives a failure for retry/edit.
 * Resolves true when the send was attempted and succeeded.
 */
export async function sendOperatorMessage(
  server: string | null,
  target: OperatorWindowTarget | undefined,
  value: string,
): Promise<boolean> {
  if (!server || !target || flagsFor(server).sending) return false;
  if (value.trim() === "") return false;
  patchFlags(server, { sending: true });
  try {
    const subject = getOperatorChatTarget(server);
    if (subject) {
      await sendOperatorRequest(server, subject.windowId, "user-message", value);
    } else {
      await sendToWindow(server, target.window.windowId, value, "submit", "agent");
    }
    // Only the sent target's draft clears — another server's draft is
    // someone else's unsent message.
    clearComposeDraft(entryKey(server, target.window.windowId));
    patchFlags(server, { error: null, sending: false });
    return true;
  } catch (err) {
    patchFlags(server, { error: err instanceof Error ? err.message : "Send failed", sending: false });
    return false;
  }
}

/**
 * Upload clipboard/dropped files to the operator window's session worktree,
 * then insert-deliver each returned path to the operator pane (the trailing
 * space keeps consecutive inserts from concatenating) — staged into the TUI
 * composer where the `[Image #N]` chip renders, never submitted. Failures ride
 * the inline error line and deliver nothing further.
 */
export async function attachOperatorFiles(
  server: string | null,
  target: OperatorWindowTarget | undefined,
  files: File[],
): Promise<void> {
  if (!server || !target || files.length === 0) return;
  patchFlags(server, { uploading: true, error: null });
  try {
    for (const file of files) {
      const result = await uploadFile(server, target.sessionName, file, target.window.windowId);
      if (!result.ok || !result.path) continue;
      await sendToWindow(server, target.window.windowId, `${result.path} `, "raw", "agent");
    }
  } catch (err) {
    patchFlags(server, { error: err instanceof Error ? err.message : "Upload failed" });
  } finally {
    patchFlags(server, { uploading: false });
  }
}

/**
 * Subscribe to this target's compose state: the draft text from the
 * compose-draft store (keyed by `operatorComposeKey`) merged with this
 * server's in-flight flags. Both sources are `useSyncExternalStore` snapshots
 * with stable identities, so the merged object is reference-stable while
 * neither changed.
 */
export function useOperatorCompose(
  server: string | null,
  target: OperatorWindowTarget | undefined,
): QuakeComposeState {
  const key = operatorComposeKey(server, target);
  const text = useSyncExternalStore(subscribeComposeDraft, () => getComposeDraft(key).text);
  const flags = useSyncExternalStore(subscribeFlags, () => flagsFor(server));
  return useMemo(() => ({ text, ...flags }), [text, flags]);
}

// ── Quake-terminal-origin event predicate ────────────────────────────────────

/** Attribute on the quake terminal's root element, used to recognize
 *  paste/drop events originating inside the quake terminal (the route
 *  terminals' document-level file-paste forward must skip them — the quake
 *  terminal owns its own file path). */
export const QUAKE_TERMINAL_ROOT_ATTR = "data-quake-terminal";

/** True when an event target sits inside the quake terminal dialog (its xterm
 *  helper textarea and compose textarea both resolve here). */
export function isQuakeTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${QUAKE_TERMINAL_ROOT_ATTR}]`) !== null;
}

// ── Shared quake-terminal-context resolution ─────────────────────────────────

/**
 * Pure resolution shared by the quake terminal's read-only surfaces (the
 * quake launcher and mobile tongue): the quake terminal's server rule (route
 * server wins, then sole/last-viewed/first listed) plus the operator-window
 * lookup on the resolved server's sessions payload.
 */
export function resolveQuakeTerminalTarget(
  routeServer: string | null,
  servers: readonly string[],
  sessionsByServer: ReadonlyMap<string, readonly ProjectSession[]> | undefined,
  lastViewed: string | null,
): { server: string | null; target: OperatorWindowTarget | undefined } {
  const server = resolveQuakeServer(routeServer, servers, lastViewed);
  const target = server ? findOperatorWindow(sessionsByServer?.get(server) ?? []) : undefined;
  return { server, target };
}

/**
 * The quake terminal's resolved server + operator window for surfaces that
 * only READ the context and lack their own route server (the mobile tongue) —
 * wraps `resolveQuakeTerminalTarget` with the shared route-server walk.
 * `lastViewed` is tracked ephemerally per consumer (no persistence —
 * Constitution IV), matching the quake terminal's own ref.
 *
 * Tolerant of a missing provider: quake terminal chrome must
 * degrade to "no operator" (never crash) when mounted outside SessionProvider
 * — e.g. isolated component tests (the useUpdateNotification precedent).
 */
export function useQuakeTerminalContext(): {
  server: string | null;
  target: OperatorWindowTarget | undefined;
} {
  const ctx = useContext(SessionContext);
  const routeServer = useCurrentServerFromRoute();
  const lastViewedRef = useRef<string | null>(null);
  if (routeServer) lastViewedRef.current = routeServer;
  const servers = ctx?.servers ?? [];
  const serverNames = useMemo(() => servers.map((s) => s.name), [servers]);
  const sessionsByServer = ctx?.sessionsByServer;
  return useMemo(
    () => resolveQuakeTerminalTarget(routeServer, serverNames, sessionsByServer, lastViewedRef.current),
    [routeServer, serverNames, sessionsByServer],
  );
}
