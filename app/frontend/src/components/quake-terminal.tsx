import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  SessionContext,
  useSessionContext,
  useCurrentServerFromRoute,
} from "@/contexts/session-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useOccludes } from "@/hooks/use-occludes";
import { TerminalClient } from "@/components/terminal-client";
import { QuakeSegments, type QuakeSegment } from "@/components/terminal-activity-tabs";
import { CronList } from "@/components/cron-list";
import { CronLog } from "@/components/cron-log";
import { CronStaleBanner } from "@/components/cron-stale-banner";
import { WatchedTasks } from "@/components/watched-tasks";
import { OperatorContextChip } from "@/components/operator-context-chip";
import { OperatorStateGlyph } from "@/components/operator-state-glyph";
import { Tip } from "@/components/tip";
import { Control } from "@/components/control";
import { formatDuration } from "@/lib/format";
import { useMatches, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { prefersReducedMotion } from "@/lib/motion";
import { resolveFocusedWindow } from "@/lib/focused-pane-window";
import { useOptionalToast } from "@/components/toast";
import { setComposeText } from "@/lib/compose-draft-store";
import { focusComposeStrip } from "@/lib/compose-strip-events";
import { ApiError, startOperator } from "@/api/client";
import { entryKey } from "@/store/window-store";
import { classifyComposeEnter } from "@/lib/compose-keys";
import { insertTextAtCaret } from "@/lib/readline-keys";
import { useTextareaAutogrow } from "@/lib/textarea-autogrow";
import { CRON_ZONE_HASH } from "@/components/server-watched-zone/cron-zone";
import {
  QUAKE_TERMINAL_EVENT,
  attachOperatorFiles,
  clampQuakeGeometry,
  clearPendingQuakeRequest,
  cycleQuakeMachine,
  drainPendingQuakeRequest,
  findOperatorWindow,
  getQuakeMachineActivity,
  isQuakeTerminalRequest,
  isQuakeTerminalTarget,
  requestQuakeTerminal,
  resolveQuakeServer,
  resolveFromOrigin,
  sendOperatorMessage,
  resetOperatorChatChip,
  setQuakeComposeEngaged,
  setQuakeMachineState,
  setQuakePinned,
  setOperatorChatSubject,
  setOperatorComposeText,
  takeQuakeRestoreOrigin,
  QUAKE_GEOMETRY_DEFAULT,
  useQuakeGeometry,
  useQuakeMachineState,
  useQuakeOpacity,
  useQuakePinned,
  useQuakeComposeEngaged,
  useOperatorCompose,
  useQuakeTerminalContext,
  type OperatorWindowTarget,
  type QuakeGeometry,
  type QuakeResizeEdge,
  type QuakeTerminalRequest,
} from "@/lib/quake-terminal";

/** Slide duration — must match the `.rk-quake-slide` transition in globals.css. */
const QUAKE_SLIDE_MS = 240;

/** The operator-less hint is a toast; repeat activations within one toast
 *  lifetime must not stack duplicates (the toast itself times out at 4s). */
const NO_OPERATOR_HINT_THROTTLE_MS = 4000;

/** The established operator-absent message — the desktop drawer renders it as
 *  its hint line, mobile activations toast it. */
const NO_OPERATOR_HINT = "no operator on this server — run rk operator";

/** No SSE event says "the start you requested produced no window". The daemon
 *  answers the POST within its 30 s receipt bound (operatorStartReceiptTimeout
 *  in api/operator_start.go) and wakes the hub on 202, so a window that has
 *  not appeared by now is not coming from this request: re-arm the button
 *  with an inline note instead of holding it dead. */
const START_OPERATOR_PENDING_TIMEOUT_MS = 45_000;
const START_OPERATOR_TIMEOUT_NOTE =
  "operator did not appear — check the operator terminal or run rk operator";

/** One in-flight Start operator request: `gen` identifies the click (so a
 *  late outcome from an older attempt cannot release a newer one), and
 *  `startedAt` anchors its own pending deadline. */
type StartPendingEntry = { gen: number; startedAt: number };

/** The map without `server`'s entry — unchanged (same reference) when there is
 *  none, or when `gen` is given and the entry belongs to a different attempt. */
function withoutStartPending(
  prev: ReadonlyMap<string, StartPendingEntry>,
  server: string,
  gen?: number,
): ReadonlyMap<string, StartPendingEntry> {
  const cur = prev.get(server);
  if (!cur || (gen !== undefined && cur.gen !== gen)) return prev;
  const next = new Map(prev);
  next.delete(server);
  return next;
}

/**
 * The quake terminal — the operator-chat surface: a global pull-down drawer
 * overlay on desktop, available on every route. Mounted ONCE at the
 * persistent root layout
 * (app.tsx, beside the single CommandPalette mount); every entry point — the
 * registry chord, the palette action, the palette's Ask-operator fallback row,
 * the mobile tongue, and the overflow-menu row — reaches it through the
 * QUAKE_TERMINAL_EVENT
 * document seam (lib/quake-terminal.ts).
 *
 * The seam forks on form factor. Desktop runs the ⌘J two-state machine
 * (lib/quake-terminal.ts): rest ⇄ open (drawer down, the docked compose
 * textarea focused — focus and the expanded drawer are linked, so one chord
 * engages both and the next releases both). Enter in the docked compose
 * sends; Esc on the Operator Terminal segment first yields focus to the
 * embedded terminal, then releases to rest (on the list segments the first
 * Esc releases); the palette action lands on open+focused; a click outside
 * the quake terminal's own DOM (the drawer or the quake launcher) collapses
 * to rest unless the drawer is pinned (⌖ — an ephemeral module slot, reset at
 * rest; only the outside-click path is suspended, the chord/Esc/▼ still
 * collapse), same destination as the
 * header button. The machine is the controlling state — the drawer's internal
 * open flag follows it through the slide machinery.
 *
 * On MOBILE there is no drawer at all: every request resolves the operator
 * window and NAVIGATES to its ordinary terminal route, reusing that route's
 * chrome wholesale (the top-bar `Terminal: <window>` heading, the compose
 * strip, the bottom-bar key chips, the `--bottom-bar-pad` safe-area
 * handling). The palette fallback row's query is seeded into the operator
 * route's compose-strip draft instead of auto-sending, and a navigation from
 * a terminal route carries the origin window as `?from=` so the operator
 * route's compose strip keeps the templated chat lane behind its context
 * chip. A request against an operator-less server toasts the hint and stays
 * put — except a cron-segment request (`list`/`log`) on a server whose
 * sessions have loaded: cron needs no operator, so it navigates to the tmux
 * Server page's Cron section (`/$server#cron`) instead. The component still
 * mounts on mobile (the seam listener lives here)
 * but renders nothing; a desktop→mobile viewport flip resets the machine to
 * rest and tears down any in-flight slide state, so no effect or frame
 * survives the gate.
 *
 * Anatomy (desktop): ONE header row folding the
 * Operator Terminal | Operator Tasks | Cron List | Cron Log segment strip
 * (the shared `QuakeSegments` strip from terminal-activity-tabs.tsx, driven
 * by the quake terminal's local ephemeral state) together with the meta
 * cluster (the server picker on param-less multi-server routes, else the
 * server name; the operator window's live agent state; the operator loop's
 * tick-age stamp), the pin, and the collapse affordance — then the body: on
 * Operator Terminal an embedded LIVE
 * terminal view of the operator window (a plain TerminalClient over the
 * shared /ws/terminals relay mux — the same mechanism a board pane uses,
 * registerFocus off so the BottomBar keeps its target, `transparent` on so
 * the glass background shows through the cells); on Operator Tasks the
 * `WatchedTasks` watchlist (the shared
 * `WatchedTable`, dense variant — a row click navigates through the router to
 * the window's terminal and collapses the drawer explicitly: a click inside
 * the quake terminal bypasses the outside-click collapse, which stands down
 * for clicks inside the quake terminal's DOM); on Cron List / Cron Log the
 * `CronStaleBanner` (mounted once above either cron body) over the `CronList`
 * or `CronLog` (inline variant — the entry detail sheet renders
 * in-container). On every non-terminal segment the TerminalClient is
 * UNMOUNTED, so the drawer holds at
 * most one relay stream. While open the drawer carries the compose DOCKED at
 * its bottom edge (the QuakeCompose strip below): the shared compose seam's
 * one desktop view, with the inline status/error line as its first row (one
 * home — nothing renders at the drawer's top edge). The strip drives the ONE
 * shared compose
 * seam (lib/quake-terminal.ts) — same draft, same `sendToWindow(...,
 * "submit", "agent")` delivery with chat-send busy semantics (allow + probe —
 * no client-side busy gate), same upload path. Structured send failures
 * surface inline (never toasts) and the composed text survives a failure for
 * retry/edit. At rest the compose's standing affordance is the top-bar quake
 * launcher (components/quake-launcher.tsx); while the drawer is open the
 * launcher collapses to its glyph + chord and re-focuses the docked textarea
 * on click.
 *
 * On a terminal route the compose carries a dismissable context chip (default
 * attached) naming the subject window — the route's window, or the validated
 * `?from=` origin on the operator window's own route; with it attached, sends
 * ride the templated chat lane (`sendOperatorRequest(server, subjectWindowId,
 * "user-message", text)` — a server-derived source envelope wraps the text,
 * the busy gate and queue are skipped server-side), otherwise the direct
 * lane. The quake terminal stamps the subject into the lib's chat-subject
 * store; the
 * quake launcher fork lives in `sendOperatorMessage` and the compose strip's
 * plain-submit fork keys on the same store, both read AT SEND TIME, so a
 * pendingSend delivered in the same commit as a chip reset sees the reset,
 * never a stale closure.
 *
 * The desktop drawer is a true quake slide: it mounts translated fully above
 * the top-bar seam (an `overflow-clip` wrapper hides the raised portion) and
 * transitions to rest, and a close request drives the raised class and holds
 * the unmount until `transitionend` (with a timeout fallback), so the terminal
 * stream tears down AFTER the slide, not mid-animation. Reduced motion zeroes
 * both directions including the exit delay. The drawer is mouse-resizable
 * from every exposed edge — the full bottom edge (the hanging tongue is its
 * visual pull tab), both sides, and the two bottom corners (both axes at
 * once); each edge moves only its own side, so a corner tracks the pointer
 * and the drawer may rest off-center (`centerOffsetPx`). Height clamps
 * 25–85vh, width 420px–96vw, the offset keeps the drawer inside the viewport;
 * the grabbed edge tints accent-green, double-click on any grip resets,
 * drags suspend the slide transition, and the geometry persists per-viewer
 * in localStorage — and its
 * background is glass: `color-mix`-alpha bg-primary at the per-viewer opacity
 * (default 0.95, settings-dialog row) over a fixed 6px backdrop blur, disabled
 * entirely at α=1.
 *
 * File paste/drop inside the drawer (or the quake launcher) uploads via the
 * existing
 * `uploadFile` client scoped to the OPERATOR window's session and
 * insert-delivers each returned path to the operator pane (`"raw"` send mode
 * — staged into the TUI composer, never submitted; the user's own Enter
 * submits). With no operator window resolved, file paste is a no-op — the
 * hint line is the answer.
 *
 * Open/closed is ephemeral per-viewer component state (Constitution IV — no
 * URL, tmux, or localStorage write beyond the ordinary route URL;
 * geometry/opacity are the carve-out preferences). Availability degrades to
 * ABSENT: a server with no operator window renders a single hint line and
 * opens no stream (mobile: a toast, and no navigation).
 */
/** The five grips' edge masks: three edges and the two bottom corners. */
const GRIP_LEFT: QuakeResizeEdge = { x: -1, y: 0 };
const GRIP_RIGHT: QuakeResizeEdge = { x: 1, y: 0 };
const GRIP_BOTTOM: QuakeResizeEdge = { x: 0, y: 1 };
const GRIP_BOTTOM_LEFT: QuakeResizeEdge = { x: -1, y: 1 };
const GRIP_BOTTOM_RIGHT: QuakeResizeEdge = { x: 1, y: 1 };

export function QuakeTerminal() {
  const isMobile = useIsMobile();
  const machine = useQuakeMachineState();
  const pinned = useQuakePinned();
  const [open, setOpen] = useState(false);
  // The mount flag, not the machine: it stays true through the exit slide, so
  // a surface hidden beneath the drawer re-shows once the drawer has left.
  useOccludes("modal", open);
  // True while the exit slide runs: the component stays mounted with the
  // raised class until transitionend (or the timeout fallback) unmounts it.
  const [closing, setClosing] = useState(false);
  // True once the drawer has left its raised start pose — the enter slide is
  // the transition between these two poses.
  const [entered, setEntered] = useState(false);
  const [pinnedServer, setPinnedServer] = useState<string | null>(null);
  const [pickerServer, setPickerServer] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  // Start operator (the operator-less body's button): the in-flight
  // POST /api/operator/start requests, server → { gen, startedAt }. Keyed per
  // server because this component outlives the body — a switch to another
  // server must render that server's own button, idle or pending, and a flag
  // cleared on body unmount would survive both the switch and a window that
  // appears then dies. An entry is released by the target-resolves effect
  // below (the SSE sessions payload carrying that server's operator window —
  // success is observed, never assumed), by a non-409 failure of the SAME
  // attempt (`gen` — a late rejection from an older attempt must not release
  // a newer one), or by that entry's own pending deadline. The error is
  // server-scoped for the same reason and retired once that server's window
  // is observed.
  const [startPendingByServer, setStartPendingByServer] = useState<
    ReadonlyMap<string, StartPendingEntry>
  >(() => new Map());
  const [startError, setStartError] = useState<{ server: string; message: string } | null>(null);
  const startGenRef = useRef(0);
  // server → the generation of its most recent click; a rejection compares
  // against it so only the latest attempt's outcome ever lands.
  const latestStartGenRef = useRef(new Map<string, number>());
  // The drawer's body segment — the quake terminal's local ephemeral state
  // (no URL, tmux,
  // or localStorage write), defaulting to Operator Terminal and resetting on
  // close; a seam request carrying `segment` sets it on open.
  const [segment, setSegment] = useState<QuakeSegment>("terminal");
  const rootRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // The embedded terminal's focus handle (TerminalClient's focusRef seam) —
  // the Esc ladder's first rung targets it.
  const terminalFocusRef = useRef<(() => void) | null>(null);
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const noOperatorHintAtRef = useRef(0);

  const { servers, sessionsByServer, isConnectedByServer, subscribeNotify } = useSessionContext();

  // Route server — the shared deepest-first route-param walk (param names are
  // unique across the route tree).
  const routeServer = useCurrentServerFromRoute();
  // Route window — the same deepest-first walk over the window param: a
  // terminal route yields the quake terminal's chat subject (or, on the
  // operator
  // window's own route, the `?from=` origin does), every other route none.
  const matches = useMatches();
  let routeWindow: string | null = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { window?: string };
    if (typeof p.window === "string" && p.window.length > 0) {
      routeWindow = p.window;
      break;
    }
  }
  // The mobile navigation arm's origin-context carrier (the `?layout=` idiom:
  // raw string, validated against the sessions payload at stamp time).
  const search = useSearch({ strict: false });

  // Most-recently-viewed server, remembered ephemerally for the picker
  // default on param-less routes (no persistence — Constitution IV).
  const lastViewedRef = useRef<string | null>(null);
  if (routeServer) lastViewedRef.current = routeServer;

  const serverNames = useMemo(() => servers.map((s) => s.name), [servers]);
  const showPicker = routeServer === null && serverNames.length > 1;
  const server =
    pickerServer ?? pinnedServer ?? resolveQuakeServer(routeServer, serverNames, lastViewedRef.current);
  // Mirrored for the once-registered seam listener (the desktop
  // on-operator-route branch reads the resolved pair through refs).
  const serverRef = useRef(server);
  serverRef.current = server;
  const targetRef = useRef<OperatorWindowTarget | undefined>(undefined);

  // A pinned/picked server is scoped to the route it was requested from — a
  // navigation retargets the quake terminal to the new route's server.
  useEffect(() => {
    setPinnedServer(null);
    setPickerServer(null);
  }, [routeServer]);

  // ── Slide machinery ─────────────────────────────────────────────────────
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(false);
    setEntered(false);
    setSegment("terminal");
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    // Mobile never slides (there is no drawer) and reduced motion skips the
    // mounted-through-exit delay entirely (the CSS transition is zeroed too).
    if (isMobileRef.current || prefersReducedMotion()) {
      setClosing(false);
      setOpen(false);
      setEntered(false);
      setSegment("terminal");
      return;
    }
    setClosing(true);
    closeTimerRef.current = setTimeout(finishClose, QUAKE_SLIDE_MS + 120);
  }, [finishClose]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // The component can unmount mid-exit (layout teardown); a pending slide
  // timeout must not fire setState afterwards.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  const openDrawer = useCallback(() => {
    // A re-open mid-exit cancels the close: the drawer transitions back down
    // from wherever the slide had reached.
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(true);
  }, []);

  // The machine is the controlling state: entering `open` runs the enter
  // slide; leaving it runs the exit slide (or the immediate mobile/reduced
  // close).
  const prevMachineRef = useRef(machine);
  useEffect(() => {
    const prev = prevMachineRef.current;
    prevMachineRef.current = machine;
    if (machine === "open" && prev !== "open") openDrawer();
    else if (machine !== "open" && prev === "open") requestCloseRef.current();
  }, [machine, openDrawer]);

  // ── Focus ownership (the two invariants) ─────────────────────────────────
  // Focus-on-open: entering `open` focuses the docked compose textarea once it
  // is mounted, caret at the end of any draft carried over from the standing
  // box. Keyed on `open` (the drawer's mount flag), so the focus call lands
  // after the textarea exists.
  useEffect(() => {
    if (machine !== "open" || !open) return;
    const el = rootRef.current?.querySelector('[data-testid="quake-terminal-compose-input"]');
    if (el instanceof HTMLTextAreaElement && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [machine, open]);

  // The return is ownership-gated: on reaching `rest` no focus action is taken
  // unless the docked textarea still holds focus — a release the user caused
  // by focusing something else (the embedded terminal, a pane below) already
  // has its owner, and acting there steals keystrokes. Keyed on the MACHINE,
  // not the mount flag: the drawer stays mounted through the exit slide (and
  // the reduced-motion close unmounts only after this effect flush), so the
  // check still observes the textarea.
  const prevMachineFocusRef = useRef(machine);
  useEffect(() => {
    const prev = prevMachineFocusRef.current;
    prevMachineFocusRef.current = machine;
    if (machine !== "rest" || prev !== "open") return;
    const textarea = rootRef.current?.querySelector('[data-testid="quake-terminal-compose-input"]');
    if (document.activeElement !== textarea) return;
    if (textarea instanceof HTMLElement) textarea.blur();
    const origin = takeQuakeRestoreOrigin();
    if (origin?.isConnected) origin.focus();
  }, [machine]);

  // On-operator-route handling — one form-factor-neutral path both seam arms
  // call when the current route IS the resolved operator window's terminal
  // route: a terminal/absent segment focuses the page's compose strip (⌘J on
  // the operator page puts the caret in the docked input; the strip is always
  // mounted there); a non-terminal segment writes the route's `?tab=` search
  // param in place (replace — a client-side search update, never a history
  // entry). A `send` payload (the palette fallback row's query) seeds the
  // strip's draft unsent — the user reviews and sends. Held in a ref so the
  // once-registered seam listener below always reads current-render values.
  const operatorRouteRequestRef = useRef<
    (detail: QuakeTerminalRequest, srv: string, windowId: string) => void
  >(() => {});
  operatorRouteRequestRef.current = (detail, srv, windowId) => {
    const requestedTab =
      detail.segment !== undefined && detail.segment !== "terminal" ? detail.segment : undefined;
    if (requestedTab !== undefined) {
      void navigate({
        to: ".",
        search: (prev) => ({ ...prev, tab: requestedTab }),
        replace: true,
      });
    } else {
      focusComposeStrip();
    }
    if (detail.send !== undefined) {
      setComposeText(entryKey(srv, windowId), detail.send);
    }
  };

  // Mobile arm: every quake terminal request — from any entry point, all three
  // actions collapse into this — resolves the operator window and navigates
  // to its ordinary terminal route (there is no sheet to open). A navigation
  // from a terminal route on the same server carries the origin window as
  // `?from=` (never the operator window itself); re-activating while ALREADY
  // on the target operator route takes the shared on-operator-route path
  // above, so the existing `?from=` (and the chip it feeds) survives. A
  // request carrying any non-terminal `segment` maps to the route's
  // `?tab=<segment>` search param (merged with `?from=` on a cross-route
  // navigation). An operator-less server toasts the hint (throttled to one
  // per toast lifetime) without navigating — EXCEPT for the cron segments:
  // cron needs no operator, so `list`/`log` land on the tmux Server page's
  // Cron section (`/$server#cron`, the phone's operator-less cron home)
  // instead. Held in a ref so the once-registered seam listener below always
  // reads current-render values.
  const mobileRequestRef = useRef<(detail: QuakeTerminalRequest) => void>(() => {});
  mobileRequestRef.current = (detail) => {
    const srv =
      detail.server ?? resolveQuakeServer(routeServer, serverNames, lastViewedRef.current);
    const tgt = srv ? findOperatorWindow(sessionsByServer.get(srv) ?? []) : undefined;
    // "No operator" is only knowable once the server's sessions have loaded:
    // a freshly attached server carries an empty slice before its first
    // `sessions` event, and treating that as operator-less would route past
    // an operator that exists. Until then the hint toast (below) answers.
    const loaded = srv ? isConnectedByServer.get(srv) === true : false;
    if (srv && loaded && !tgt && (detail.segment === "list" || detail.segment === "log")) {
      void navigate({ to: "/$server", params: { server: srv }, hash: CRON_ZONE_HASH });
      return;
    }
    if (!srv || !tgt) {
      const now = Date.now();
      if (now - noOperatorHintAtRef.current >= NO_OPERATOR_HINT_THROTTLE_MS) {
        noOperatorHintAtRef.current = now;
        toast?.addToast(NO_OPERATOR_HINT, "info");
      }
      return;
    }
    const onOperatorRoute = routeServer === srv && routeWindow === tgt.window.windowId;
    if (onOperatorRoute) {
      operatorRouteRequestRef.current(detail, srv, tgt.window.windowId);
      return;
    }
    const requestedTab =
      detail.segment !== undefined && detail.segment !== "terminal" ? detail.segment : undefined;
    // A non-terminal segment rides the navigation's search — merged with the
    // `?from=` origin carrier on a cross-route navigation.
    const from = routeServer === srv && routeWindow !== null ? routeWindow : undefined;
    void navigate({
      to: "/$server/$window",
      params: { server: srv, window: tgt.window.windowId },
      search: requestedTab !== undefined
        ? (from ? { from, tab: requestedTab } : { tab: requestedTab })
        : (from ? { from } : {}),
    });
    if (detail.send !== undefined) {
      setComposeText(entryKey(srv, tgt.window.windowId), detail.send);
    }
  };

  // Entry-point seam: chord dispatch, palette action, tongue, overflow-menu
  // row and the palette fallback row all
  // dispatch here. Mobile navigates (the arm above); desktop `toggle` steps
  // the two-state machine, and `open` always opens with the quake launcher
  // focused.
  // While the resolved operator route is already current, every desktop
  // request takes the shared on-operator-route path — the page IS the
  // surface, so openers focus its compose strip or switch its segment and no
  // drawer ever opens there.
  useEffect(() => {
    function handleRequest(detail: QuakeTerminalRequest) {
      // Handled — clear the seam's buffer so a later mount cannot replay it.
      clearPendingQuakeRequest();
      if (isMobileRef.current) {
        mobileRequestRef.current(detail);
        return;
      }
      if (onOperatorRouteRef.current) {
        const srv = serverRef.current;
        const windowId = targetRef.current?.window.windowId;
        if (srv && windowId) operatorRouteRequestRef.current(detail, srv, windowId);
        return;
      }
      const state = machineRef.current;
      if (detail.action === "toggle") {
        setQuakeMachineState(cycleQuakeMachine(state));
      } else {
        setQuakeMachineState("open");
      }
      if (detail.server) setPinnedServer(detail.server);
      if (detail.send !== undefined) setPendingSend(detail.send);
      // The requested segment applies AFTER the machine transition, so an
      // open-with-segment request lands on it directly.
      if (detail.segment !== undefined) setSegment(detail.segment);
    }
    function onRequest(e: Event) {
      const detail = (e as CustomEvent<unknown>).detail;
      if (!isQuakeTerminalRequest(detail)) return;
      handleRequest(detail);
    }
    document.addEventListener(QUAKE_TERMINAL_EVENT, onRequest);
    // Mount drain: this module loads lazily behind Suspense, so a request
    // dispatched before the listener attached (a cold `?tab=log` deep
    // link) sits in the seam's buffer — replay it now.
    const pending = drainPendingQuakeRequest();
    if (pending) handleRequest(pending);
    return () => document.removeEventListener(QUAKE_TERMINAL_EVENT, onRequest);
  }, []);

  // The daemon broadcasts a tagged notify when a Start-operator launch could
  // not get its /fab-operator kickoff delivered — a degraded result the user
  // must see, so it toasts on every form factor (the subscription lives above
  // the render gate: the mobile mount renders nothing). Other tags and
  // untagged payloads are the shell-notification path's own concern.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(
    () =>
      subscribeNotify((payload) => {
        if (payload.tag !== "operator-kickoff") return;
        const text = payload.body ?? payload.title;
        if (!text) return;
        toastRef.current?.addToast(text, "error");
      }),
    [subscribeNotify],
  );

  // The gate owns the frames AND the effects: a desktop→mobile flip resets
  // the machine and tears down any in-flight slide state, so the drawer, its
  // timers, and its poses never survive onto mobile.
  useEffect(() => {
    if (!isMobile) return;
    setQuakeMachineState("rest");
    finishClose();
  }, [isMobile, finishClose]);

  // Enter pose: mount raised (translateY(-102%), clipped by the wrapper), then
  // drop the raised class two frames later so the transition animates.
  useEffect(() => {
    if (!open) return;
    setEntered(false);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  // Esc releases the machine (bubble phase, so an already-claimed Escape — a
  // nested modal's, or the docked textarea's first-rung yield to the embedded
  // terminal — wins via defaultPrevented): the drawer closes and the blur +
  // focus restore is the ownership-gated machine-follower effect above.
  // Owning the release here — rather than letting the compose textarea handle
  // its own Esc release — keeps one Esc from being handled twice. The stream closes
  // with the unmount; the conversation itself lives in the operator window
  // regardless.
  useEffect(() => {
    if (!open && machine === "rest") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog layer nested INSIDE the drawer (the inline cron entry sheet)
      // owns this Escape — it dismisses the sheet, never collapses the drawer.
      // A DOM check, not `defaultPrevented`: this listener was registered when
      // the drawer opened, so it runs before the nested layer's focus trap.
      if (rootRef.current?.querySelector('[role="dialog"]')) return;
      if (machineRef.current !== "rest") setQuakeMachineState("rest");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, machine]);

  // Click outside: the drawer is a peek that survives compose blur
  // (see
  // above), so it never closes on its own — a click landing outside the
  // quake terminal's own DOM (the drawer + the top-bar quake launcher both
  // carry
  // QUAKE_TERMINAL_ROOT_ATTR) collapses it, same destination as the header
  // button — UNLESS the drawer is pinned: the pin suspends only this
  // click-away path (a pinned drawer is for reading the operator while typing
  // in the pane below); the chord, Esc, and ▼ still collapse. Two things a
  // plain "collapse on any outside click" would get
  // wrong, both handled below by DEFERRING the decision rather than acting
  // inline:
  //   (1) An entry-point trigger outside the quake terminal's DOM (a palette
  //       or menu
  //       opener's retarget) reads and
  //       re-writes the machine itself in response to the SAME click — the
  //       collapse must never race that write. Capturing
  //       `getQuakeMachineActivity()` in the CAPTURE phase (before the
  //       trigger's own bubble-phase onClick runs) and re-checking it after a
  //       macrotask settle catches this: if the trigger's handler already
  //       changed activity — even a same-VALUE re-open while already `open`,
  //       which is a no-op by value but still
  //       increments activity — this handler backs off and leaves whatever
  //       that handler decided standing.
  //   (2) A click that opens an unrelated modal (the settings dialog, the
  //       command palette) is outside the quake terminal's DOM but must NOT
  //       collapse it — the settings dialog in particular needs the quake
  //       terminal
  //       to stay open so its opacity control can live-apply. The trigger
  //       trigger itself may carry no quake terminal marker, so
  //       this checks for ANY currently-open `role="dialog"` at settle time
  //       instead of the clicked target's ancestry — a modal owns the
  //       interaction while open, so the quake terminal holding still behind
  //       it is
  //       the correct call regardless of where inside (or outside) the
  //       dialog the click landed.
  // A macrotask (not a microtask) is the settle mechanism: it runs after
  // React has committed and painted the triggering click's own state update
  // (mounting the settings dialog's DOM, or the opener's own
  // re-render), which a same-tick microtask cannot reliably guarantee.
  useEffect(() => {
    if (machine !== "open" || pinned) return;
    function onClickCapture(e: MouseEvent) {
      if (isQuakeTerminalTarget(e.target)) return;
      const activityAtClick = getQuakeMachineActivity();
      setTimeout(() => {
        if (getQuakeMachineActivity() !== activityAtClick) return;
        // The drawer itself carries role="dialog" — only an UNRELATED open
        // dialog (settings, palette) should hold the collapse back.
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          if (!isQuakeTerminalTarget(d)) return;
        }
        setQuakeMachineState("rest");
      }, 0);
    }
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [machine, pinned]);

  const rendered = open || closing;

  const target = useMemo(
    () => (server ? findOperatorWindow(sessionsByServer.get(server) ?? []) : undefined),
    [server, sessionsByServer],
  );
  targetRef.current = target;

  // The chat subject. On an ordinary terminal route it is the route's window;
  // on the operator window's OWN route it is the validated `?from=` origin
  // window (the mobile navigation's context carrier — the numeric segment
  // form is accepted like the path parse, and an unknown, cross-server, or
  // self id attaches nothing: a subject must never be the send's own target).
  // Either way it attaches only when the quake terminal's resolved server IS
  // the
  // route's server (a pinned/picked cross-server retarget must not attach a
  // foreign window id — window ids are server-scoped). Stamped into the lib's
  // chat-subject store — both compose surfaces render the chip from it, and
  // the send forks read it AT SEND TIME, so a pendingSend delivered in the
  // same commit as a reset sees the reset, never a stale closure.
  const onTerminalRoute = routeServer !== null && routeWindow !== null && server === routeServer;
  const onOperatorRoute =
    onTerminalRoute && target !== undefined && routeWindow === target.window.windowId;
  const onOperatorRouteRef = useRef(onOperatorRoute);
  onOperatorRouteRef.current = onOperatorRoute;
  const fromWindow = useMemo(() => {
    if (!onOperatorRoute || !server) return null;
    return resolveFromOrigin(search.from, routeWindow, sessionsByServer.get(server) ?? []);
  }, [onOperatorRoute, server, search.from, routeWindow, sessionsByServer]);
  const subjectWindowId = !onTerminalRoute
    ? null
    : onOperatorRoute
      ? (fromWindow?.windowId ?? null)
      : routeWindow;
  const subjectName = useMemo(() => {
    if (!subjectWindowId || !server) return null;
    return resolveFocusedWindow(sessionsByServer.get(server) ?? [], subjectWindowId)?.name ?? null;
  }, [subjectWindowId, server, sessionsByServer]);
  useEffect(() => {
    setOperatorChatSubject(
      subjectWindowId && server ? { server, windowId: subjectWindowId, name: subjectName } : null,
    );
  }, [server, subjectWindowId, subjectName]);

  // Chip dismissal is scoped to one engagement: re-engaging the quake
  // terminal — the
  // machine leaving rest — re-attaches the context (Constitution IV ephemeral
  // state; subject changes reset inside the store itself, which is what
  // re-attaches the chip on mobile route arrivals).
  const engaged = open || machine !== "rest";
  const prevEngagedRef = useRef(engaged);
  useEffect(() => {
    if (engaged && !prevEngagedRef.current) resetOperatorChatChip();
    prevEngagedRef.current = engaged;
  }, [engaged]);
  // The palette fallback row's pre-filled query: sent once the quake terminal
  // is open
  // AND the operator window resolves — the sessions slice can lag the open, so
  // the send waits for `target` instead of being dropped. A genuinely
  // operator-less server never resolves it (the hint line is the answer
  // there), and closing the quake terminal abandons it: the send is scoped to
  // the
  // open it arrived with.
  useEffect(() => {
    if (!open || pendingSend == null || !target) return;
    setPendingSend(null);
    void sendOperatorMessage(server, target, pendingSend);
  }, [open, pendingSend, target, server]);
  useEffect(() => {
    if (!open) setPendingSend(null);
  }, [open]);

  // Start operator resolves when a PENDING server's operator window shows up
  // in the sessions payload — keyed on that server's own slice, not the
  // drawer's current `target`, so a resolution on runKit clears runKit's
  // pending while the drawer shows fabKit. Clearing on appearance (rather
  // than on body unmount) is what leaves the button idle when the window
  // later vanishes.
  useEffect(() => {
    let next: ReadonlyMap<string, StartPendingEntry> = startPendingByServer;
    for (const srv of startPendingByServer.keys()) {
      if (findOperatorWindow(sessionsByServer.get(srv) ?? [])) next = withoutStartPending(next, srv);
    }
    if (next !== startPendingByServer) setStartPendingByServer(next);
  }, [startPendingByServer, sessionsByServer]);
  // An observed window also retires that server's start error: a timeout
  // note or failure message is moot once the operator is there, and must not
  // resurface in the operator-less body if the window later dies.
  useEffect(() => {
    if (startError === null) return;
    if (findOperatorWindow(sessionsByServer.get(startError.server) ?? [])) setStartError(null);
  }, [startError, sessionsByServer]);
  // One deadline per pending entry, anchored to its own `startedAt` — re-arming
  // on a map change (another server's click) never extends this one's wait.
  useEffect(() => {
    const timers = Array.from(startPendingByServer, ([srv, entry]) =>
      setTimeout(
        () => {
          setStartPendingByServer((prev) => withoutStartPending(prev, srv, entry.gen));
          setStartError({ server: srv, message: START_OPERATOR_TIMEOUT_NOTE });
        },
        Math.max(0, entry.startedAt + START_OPERATOR_PENDING_TIMEOUT_MS - Date.now()),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [startPendingByServer]);
  const startPending = server ? startPendingByServer.has(server) : false;

  // ── Geometry (desktop drawer) + glass ─────────────────────────────────────
  const [geometry, writeGeometry] = useQuakeGeometry();
  const [opacity] = useQuakeOpacity();
  // Live drag state: the override drives the drawer's box while a grip is held
  // (transition suspended via the dragging class); the store write lands on
  // pointer-up. `dragEdge` doubles as the lit-edge source while dragging.
  const [dragOverride, setDragOverride] = useState<QuakeGeometry | null>(null);
  const [dragEdge, setDragEdge] = useState<QuakeResizeEdge | null>(null);
  const [hoverEdge, setHoverEdge] = useState<QuakeResizeEdge | null>(null);
  // `pointerId` pins the drag to the pointer that started it: on a touchscreen
  // a second finger fires its own pointer events at the grip, and without the
  // pin it could overwrite the origin or commit its geometry on release.
  const dragRef = useRef<{
    edge: QuakeResizeEdge;
    pointerId: number;
    startX: number;
    startY: number;
    start: QuakeGeometry;
  } | null>(null);
  const dragging = dragEdge !== null;
  // The grabbed edge wins over a hovered one: a drag that wanders off its grip
  // keeps that edge lit until release.
  const litEdge = dragEdge ?? hoverEdge;

  // The offset clamp depends on the live viewport width, so a window resize
  // re-renders to re-clamp the DISPLAYED geometry. Display-only: the store is
  // never written here — a transiently narrow window must not erase the
  // viewer's preferred offset (width already tracks via `maxWidth: 96vw`).
  const [, bumpViewport] = useState(0);
  useEffect(() => {
    if (!open || isMobile) return;
    const onResize = () => bumpViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, isMobile]);

  const effectiveGeometry = clampQuakeGeometry(dragOverride ?? geometry);

  const onGripPointerDown = useCallback(
    (edge: QuakeResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // A second pointer while a drag is live is ignored, never a new drag.
      if (dragRef.current) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events (unit tests) have no active pointer to capture.
      }
      dragRef.current = {
        edge,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        start: effectiveGeometry,
      };
      setDragEdge(edge);
    },
    [effectiveGeometry],
  );
  const onGripPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const next: QuakeGeometry = { ...drag.start };
    if (drag.edge.y === 1) {
      next.heightVh = drag.start.heightVh + (dy / window.innerHeight) * 100;
    }
    // Independent edges: moving one edge by dx changes the width by dx and
    // shifts the center by dx/2, so the OPPOSITE edge stays put and the
    // grabbed edge stays under the pointer (a corner sets both masks).
    if (drag.edge.x !== 0) {
      next.widthPx = drag.start.widthPx + dx * drag.edge.x;
      next.centerOffsetPx = drag.start.centerOffsetPx + dx / 2;
    }
    setDragOverride(clampQuakeGeometry(next));
  }, []);
  const onGripPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Synthetic pointer events (unit tests) have no active pointer.
      }
      setDragEdge(null);
      setDragOverride((prev) => {
        if (prev) writeGeometry(prev);
        return null;
      });
    },
    [writeGeometry],
  );
  const onGripDoubleClick = useCallback(() => {
    dragRef.current = null;
    setDragEdge(null);
    setDragOverride(null);
    writeGeometry(QUAKE_GEOMETRY_DEFAULT);
  }, [writeGeometry]);

  // Desktop-only render: the mobile arm is navigation (the seam listener
  // above), so nothing mounts below the shared isMobile rule.
  if (!rendered || isMobile) return null;

  const agentState = target?.window.agentState;
  // agentIdleDuration is populated for `active` too; render it only for the
  // two rest states.
  const agentIdle =
    agentState === "waiting" || agentState === "idle" ? target?.window.agentIdleDuration : undefined;

  // The title-strip tick-age stamp reads the FIRST session on the resolved
  // server carrying `operatorLastTickAt > 0`; operator-less servers and older
  // backends carry no field and render nothing. Render-time only — the
  // sessions SSE cadence is the clock, never a timer.
  const tickSession = server
    ? sessionsByServer.get(server)?.find((s) => (s.operatorLastTickAt ?? 0) > 0)
    : undefined;
  const tickStale = tickSession?.operatorStale === true;
  const tickAge = tickSession
    ? formatDuration(Math.max(0, Math.floor(Date.now() / 1000) - (tickSession.operatorLastTickAt ?? 0)))
    : null;

  // Glass: alpha-blended bg-primary over a fixed 6px backdrop blur. α=1
  // disables the filter entirely: the zero-cost opaque path.
  const glassStyle: React.CSSProperties = {
    backgroundColor: `color-mix(in srgb, var(--color-bg-primary) ${Math.round(opacity * 100)}%, transparent)`,
    ...(opacity < 1
      ? { backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }
      : {}),
  };

  // One handler set for every grip; the edge mask rides the pointer-down
  // closure. `pointercancel` (a captured pointer the browser takes back)
  // ends the drag through the same up path so the dragging class never sticks.
  const gripHandlers = (edge: QuakeResizeEdge) => ({
    onPointerDown: onGripPointerDown(edge),
    onPointerMove: onGripPointerMove,
    onPointerUp: onGripPointerUp,
    onPointerCancel: onGripPointerUp,
    onPointerEnter: () => setHoverEdge(edge),
    onPointerLeave: () => setHoverEdge(null),
    onDoubleClick: onGripDoubleClick,
  });
  // Edge grips light when their axis is in the lit mask — so hovering or
  // dragging a corner lights both adjacent edges (the divider T-junction idiom).
  const edgeLit = (edge: QuakeResizeEdge) =>
    litEdge !== null && ((edge.x !== 0 && litEdge.x === edge.x) || (edge.y === 1 && litEdge.y === 1));
  const edgeGripClass = (edge: QuakeResizeEdge, side: "left" | "right" | "bottom") =>
    `rk-quake-grip rk-quake-grip-${side}${edgeLit(edge) ? " rk-quake-grip-lit" : ""}`;

  const drawer = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Quake terminal"
      data-testid="quake-terminal"
      data-quake-terminal=""
      onTransitionEnd={(e) => {
        if (e.target === rootRef.current && e.propertyName === "transform" && closingRef.current) {
          finishClose();
        }
      }}
      onKeyDownCapture={(e) => {
        // The Esc ladder's second rung: Escape with focus in the drawer's
        // embedded terminal. xterm consumes Esc as a pane keystroke (the
        // bubble-phase document listener honors that claim via
        // defaultPrevented and skips it), so the collapse is claimed here in
        // CAPTURE phase — before xterm sees the key, so the pane never gets
        // the byte. The compose textarea's own first-rung handler is untouched
        // (its target is not the xterm helper).
        if (e.key !== "Escape" || machineRef.current !== "open") return;
        const t = e.target;
        if (t instanceof Element && t.classList.contains("xterm-helper-textarea")) {
          e.preventDefault();
          e.stopPropagation();
          setQuakeMachineState("rest");
        }
      }}
      onPasteCapture={(e) => {
        // Capture phase: xterm's own textarea paste handler stops propagation,
        // so a bubble-phase handler would never see file pastes targeted at
        // the embedded terminal. Text pastes fall through (no files) and keep
        // their native behavior.
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        void attachOperatorFiles(server, target, files);
      }}
      onDragOver={(e) => {
        // Cancel every dragover — not just file drags — so the drop handler
        // below always fires and can swallow non-file drops; a URL/text drop
        // left to the browser's default navigates away from the page.
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        void attachOperatorFiles(server, target, files);
      }}
      className={`rk-quake-slide pointer-events-auto absolute top-0 -translate-x-1/2 flex flex-col border border-t-0 border-border rounded-b-lg shadow-2xl${
        entered && !closing ? "" : " rk-quake-closed"
      }${dragging ? " rk-quake-dragging" : ""}`}
      style={{
        // The center offset rides `left`: centering is the `translate`
        // property (-translate-x-1/2) and the slide is `transform`, so `left`
        // is the one free channel. maxWidth (not a min() width) so the 96vw
        // ceiling keeps tracking live viewport resizes.
        left: `calc(50% + ${effectiveGeometry.centerOffsetPx}px)`,
        width: `${effectiveGeometry.widthPx}px`,
        maxWidth: "96vw",
        height: `${effectiveGeometry.heightVh}vh`,
        ...glassStyle,
      }}
    >
      {/* ONE header row: the segment strip on the left; the meta cluster
          (server picker or name · live agent state · tick-age stamp) absorbs
          all squeeze by truncation at the 420px width floor; the pin and ▼
          controls never shrink. The strip's `◉ → operator` label names the
          addressee — there is no separate title strip. */}
      <div
        data-testid="quake-terminal-header"
        className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs shrink-0"
      >
        <QuakeSegments value={segment} onChange={setSegment} className="" />
        <div className="ml-auto flex min-w-0 items-center gap-2 truncate whitespace-nowrap">
          {showPicker ? (
            <select
              aria-label="Operator server"
              value={server ?? ""}
              onChange={(e) => setPickerServer(e.target.value)}
              className="bg-transparent text-text-secondary outline-none cursor-pointer"
            >
              {serverNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            server && <span className="text-text-secondary">{server}</span>
          )}
          {agentState && (
            <span className="text-text-secondary" data-testid="quake-terminal-state">
              · {agentState}
              {agentIdle ? ` ${agentIdle}` : ""}
            </span>
          )}
          {tickSession && tickAge !== null && (
            <Tip
              label={tickStale ? `Operator last ticked ${tickAge} ago` : undefined}
              placement="bottom"
            >
              <span
                data-testid="quake-terminal-tick"
                className={tickStale ? "text-signal-yellow" : "text-text-secondary"}
              >
                {tickStale ? "⚠ " : ""}· tick {tickAge} ago
              </span>
            </Tip>
          )}
        </div>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin quake terminal" : "Pin quake terminal"}
          data-testid="quake-terminal-pin"
          onClick={() => setQuakePinned(!pinned)}
          className={`rk-glint shrink-0 inline-flex items-center justify-center rounded px-1 transition-colors coarse:min-h-[36px] coarse:min-w-[36px] ${
            pinned ? "text-accent-green" : "text-text-secondary hover:text-text-primary"
          }`}
        >
          ⌖
        </button>
        {server && target && (
          // ⤢ open as tab — mobile's navigation arm on desktop: land on the
          // operator window's own route (the current segment rides `?tab=`,
          // terminal drops it), then rest the machine. Rendered only while a
          // target resolves; an operator-less body's answer is Start operator.
          <Control
            variant="icon"
            aria-label="Open as tab"
            data-testid="quake-terminal-open-as-tab"
            onClick={() => {
              void navigate({
                to: "/$server/$window",
                params: { server, window: target.window.windowId },
                search: segment === "terminal" ? {} : { tab: segment },
              });
              setQuakeMachineState("rest");
            }}
          >
            ⤢
          </Control>
        )}
        <button
          type="button"
          aria-label="Collapse quake terminal"
          onClick={() => setQuakeMachineState("rest")}
          className="rk-glint shrink-0 inline-flex items-center justify-center rounded px-1 text-text-secondary hover:text-text-primary transition-colors coarse:min-h-[36px] coarse:min-w-[36px]"
        >
          ▼
        </button>
      </div>
      {segment !== "terminal" ? (
        segment === "tasks" ? (
          // One relay stream max per drawer: the TerminalClient is UNMOUNTED
          // while Operator Tasks shows. A row click navigates through the
          // router to the window's terminal route and collapses the drawer
          // explicitly — the outside-click collapse stands down for clicks
          // inside the quake terminal's DOM, so the handler drives the
          // machine to
          // rest itself.
          <WatchedTasks
            server={server ?? ""}
            sessions={server ? (sessionsByServer.get(server) ?? []) : []}
            onNavigate={(windowId) => {
              if (!server) return;
              void navigate({
                to: "/$server/$window",
                params: { server, window: windowId },
                // Empty search: the destination window resolves its own stored
                // layout (the cross-server sidebar-select form).
                search: {},
              });
              setQuakeMachineState("rest");
            }}
            dense
          />
        ) : (
          // Same one-relay-stream rule for the cron tabs (the keyed remount
          // on switching back is cheap). The stale banner mounts ONCE above
          // either cron body; an unresolved server renders the tab's own
          // hint line.
          <>
            <CronStaleBanner server={server ?? ""} />
            {segment === "list" ? (
              <CronList server={server ?? ""} inline />
            ) : (
              <CronLog server={server ?? ""} inline />
            )}
          </>
        )
      ) : target && server ? (
        <div className="flex-1 min-h-0 flex flex-col px-1 py-0.5">
          <TerminalClient
            key={`${server}:${target.window.windowId}`}
            sessionName={target.sessionName}
            windowId={target.window.windowId}
            server={server}
            wsRef={wsRef}
            focusRef={terminalFocusRef}
            registerFocus={false}
            transparent
          />
        </div>
      ) : (
        // The operator-less body: the Start operator button is the on-screen
        // door onto POST /api/operator/start; the hint line stays as the
        // sub-line. Success needs no local transition — the SSE sessions
        // payload carries the new operator window, `target` resolves, and
        // this body unmounts; the pending state is released by the
        // target-resolves effect above, not by this unmount (a 409
        // operator_exists is the same outcome: the operator appeared under
        // us). Any other failure re-arms the button and renders the server's
        // message inline, for the server it was produced on.
        <div
          className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-4 text-xs"
          data-testid="quake-terminal-empty"
        >
          {server && (
            <Control
              variant="wide"
              data-testid="quake-terminal-start-operator"
              disabled={startPending}
              aria-busy={startPending}
              onClick={() => {
                if (startPending) return;
                const requested = server;
                const gen = ++startGenRef.current;
                latestStartGenRef.current.set(requested, gen);
                setStartPendingByServer((prev) =>
                  new Map(prev).set(requested, { gen, startedAt: Date.now() }),
                );
                setStartError((prev) => (prev?.server === requested ? null : prev));
                // The viewed window counts only when it lives on the server
                // being started — the quake terminal's pinned/picked server
                // can differ from the route's, and a window on another server
                // is not where the operator will run.
                startOperator(
                  requested,
                  routeServer === requested && routeWindow !== null ? routeWindow : undefined,
                ).catch((err: unknown) => {
                  if (err instanceof ApiError && err.code === "operator_exists") return;
                  // An older attempt's late rejection: a newer click owns this
                  // server's slot and its outcome is still pending.
                  if (latestStartGenRef.current.get(requested) !== gen) return;
                  setStartPendingByServer((prev) => withoutStartPending(prev, requested, gen));
                  setStartError({
                    server: requested,
                    message: err instanceof Error ? err.message : "Operator start failed",
                  });
                });
              }}
            >
              {startPending ? "starting…" : "Start operator"}
            </Control>
          )}
          <span className="text-text-secondary">{NO_OPERATOR_HINT}</span>
          {startError !== null && startError.server === server && (
            <span role="alert" data-testid="quake-terminal-start-error" className="text-signal-red">
              {startError.message}
            </span>
          )}
        </div>
      )}
      {/* The docked compose strip — the shared compose seam's one desktop
          view, mounted as the last in-flow child for as long as the drawer is
          mounted (the exit slide included — the machine-keyed focus-restore
          effect must still observe the textarea when rest arrives; the grips
          below are absolutely positioned and straddle the border,
          unaffected). A closed drawer carries no strip. */}
      {open && (
        <QuakeCompose
          server={server}
          target={target}
          segment={segment}
          focusTerminal={() => {
            const focus = terminalFocusRef.current;
            if (!focus) return false;
            focus();
            return true;
          }}
        />
      )}
      {/* Resize grips — 10px zones straddling each exposed border (5px out,
          5px in), plus 16px corners rendered last so they win the hit test
          where they overlap the edges. */}
      <div
        data-testid="quake-terminal-grip-left"
        aria-hidden="true"
        {...(edgeLit(GRIP_LEFT) ? { "data-lit": "" } : {})}
        {...gripHandlers(GRIP_LEFT)}
        className={`${edgeGripClass(GRIP_LEFT, "left")} absolute left-[-5px] top-0 bottom-0 w-2.5 cursor-ew-resize touch-none select-none`}
      />
      <div
        data-testid="quake-terminal-grip-right"
        aria-hidden="true"
        {...(edgeLit(GRIP_RIGHT) ? { "data-lit": "" } : {})}
        {...gripHandlers(GRIP_RIGHT)}
        className={`${edgeGripClass(GRIP_RIGHT, "right")} absolute right-[-5px] top-0 bottom-0 w-2.5 cursor-ew-resize touch-none select-none`}
      />
      {/* The bottom edge grip spans the full width; the tongue — a pull tab
          hanging from the drawer's bottom edge — renders inside it as the
          visual affordance and stays a valid grab by containment (on mobile
          the tongue is instead the standing affordance, mounted beside the
          quake terminal in app.tsx). */}
      {/* The grip straddles the border by 5px each way, so the tongue's top
          sits at `top-[5px]` — flush with the drawer's bottom border. */}
      <div
        data-testid="quake-terminal-grip-bottom"
        aria-hidden="true"
        {...(edgeLit(GRIP_BOTTOM) ? { "data-lit": "" } : {})}
        {...gripHandlers(GRIP_BOTTOM)}
        className={`${edgeGripClass(GRIP_BOTTOM, "bottom")} absolute left-0 right-0 bottom-[-5px] h-2.5 cursor-ns-resize touch-none select-none`}
      >
        <span
          data-testid="quake-terminal-tongue-tab"
          className="absolute left-1/2 top-[5px] block h-3 w-16 -translate-x-1/2 rounded-b-md border border-t-0 border-border rk-quake-tongue"
          style={glassStyle}
        />
      </div>
      <div
        data-testid="quake-terminal-grip-bottom-left"
        aria-hidden="true"
        {...gripHandlers(GRIP_BOTTOM_LEFT)}
        className="absolute left-[-6px] bottom-[-6px] h-4 w-4 cursor-nesw-resize touch-none select-none"
      />
      <div
        data-testid="quake-terminal-grip-bottom-right"
        aria-hidden="true"
        {...gripHandlers(GRIP_BOTTOM_RIGHT)}
        className="absolute right-[-6px] bottom-[-6px] h-4 w-4 cursor-nwse-resize touch-none select-none"
      />
    </div>
  );

  // The clip wrapper hides the raised portion of the drawer above the top-bar
  // seam during the slide (in-and-out); pointer events pass through except on
  // the drawer itself.
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-clip">{drawer}</div>
  );
}

/**
 * The docked compose strip — the shared compose seam's one desktop view while
 * the drawer is open, docked at the drawer's bottom edge (the prompt →
 * compose → reply eye line every terminal route already uses). Top to bottom:
 * the status line (the inline send/upload error or the minimal
 * sending…/uploading… indicator, rendered only while one is live — the
 * status's one home), the header row (the `◉ → operator` addressee label with
 * the shared OperatorStateGlyph's live-state dot, the chat-lane context chip,
 * right-aligned key hints), and the textarea.
 *
 * The textarea rides the shared store (`useOperatorCompose` /
 * `setOperatorComposeText`) and the `quake` Enter policy of the shared
 * classifier: plain Enter sends once through `sendOperatorMessage` (the same
 * templated/direct fork as everywhere) with focus retained for follow-ups,
 * Shift+Enter inserts a local newline, an empty/whitespace Enter is a no-op.
 * Auto-grow is the route strip's bounded idiom (lib/textarea-autogrow.ts).
 * Esc is the ladder's first rung: on the Operator Terminal segment it yields
 * to the embedded terminal (prevented, so the drawer's document listener
 * skips this press and the next Esc collapses) — but only when a terminal is
 * actually mounted to receive focus (an operator-less drawer's Esc collapses
 * on the first press, like the list segments); on the list segments the
 * event is left alone and the collapse rung fires on the first press.
 *
 * The `engaged` flag (the lib's module slot) says the compose owns input:
 * true while the textarea has real focus; a blur whose relatedTarget lies
 * inside the strip wrapper does NOT clear it, so the context chip's ✕ click
 * lands. The blur handler lives on the strip WRAPPER (bubbling), not the
 * textarea, so focus leaving the strip FROM the chip's ✕ is observed too.
 * While engaged the textarea carries the accent border — and the
 * collapsed launcher in the top bar reads the same slot.
 */
function QuakeCompose({
  server,
  target,
  segment,
  focusTerminal,
}: {
  server: string | null;
  target: OperatorWindowTarget | undefined;
  segment: QuakeSegment;
  /** Focus the embedded terminal; false when none is mounted (no operator —
   *  the Esc rung then falls through to the collapse). */
  focusTerminal: () => boolean;
}) {
  const compose = useOperatorCompose(server, target);
  const engaged = useQuakeComposeEngaged();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useTextareaAutogrow(textareaRef, compose.text);
  // No operator on the resolved server: there is no draft key to write to, so
  // the box is read-only (still focusable — the Esc ladder and the engaged
  // slot keep working) and says so instead of silently dropping keystrokes.
  const noOperator = target === undefined;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      // First rung, terminal segment only: hand the keystroke to the embedded
      // terminal. Prevented, so the drawer's document keydown listener (which
      // skips defaultPrevented) does not collapse on this press. With no
      // terminal mounted (no operator) or on the list segments there is
      // nothing to yield to — the event falls through and the collapse rung
      // fires.
      if (segment === "terminal" && focusTerminal()) {
        e.preventDefault();
      }
      return;
    }
    // Read-only box (no operator): leave every other key to the browser's
    // readOnly handling. The local-newline insert mutates the DOM directly
    // and would show a newline the (empty, unaddressed) draft never holds.
    if (noOperator) return;
    const action = classifyComposeEnter(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
      },
      "quake",
    );
    if (action === "submit") {
      e.preventDefault();
      const value = e.currentTarget.value;
      if (value.trim() === "") return;
      // Focus stays in the textarea — Enter sends, the drawer stays open for
      // the follow-up.
      void sendOperatorMessage(server, target, value);
      return;
    }
    if (action === "insert-line") {
      e.preventDefault();
      insertTextAtCaret(e.currentTarget, "\n");
    }
  };

  return (
    <div
      ref={wrapperRef}
      data-testid="quake-terminal-compose"
      className="border-t border-border shrink-0 flex flex-col"
      onBlur={(e) => {
        // Focus moving WITHIN the strip (the textarea → the context chip's ✕)
        // is not a stand-down — clearing engaged there would drop the accent
        // border mid-gesture, and a chip-gated chrome change must never eat
        // the ✕ click. The handler sits on the WRAPPER (React's onBlur
        // bubbles from every descendant), not the textarea: a textarea-only
        // handler never observes the ✕ button's own later blur, so engaged
        // would stay latched after focus leaves the strip from the chip.
        if (e.relatedTarget instanceof Node && wrapperRef.current?.contains(e.relatedTarget)) {
          return;
        }
        setQuakeComposeEngaged(false);
      }}
    >
      {/* The status line — the inline-error contract's one home, directly
          above the compose it reports on. */}
      {(compose.error || compose.sending || compose.uploading) && (
        <div className="flex items-center gap-2 px-3 py-1 text-xs">
          {compose.error ? (
            <span role="alert" data-testid="quake-terminal-error" className="text-signal-red">
              {compose.error}
            </span>
          ) : (
            <span data-testid="quake-terminal-uploading" className="text-text-secondary">
              {compose.sending ? "sending…" : "uploading…"}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        <span className="flex shrink-0 items-center gap-1 text-text-secondary">
          <OperatorStateGlyph
            agentState={target?.window.agentState}
            dotTestId="quake-terminal-compose-state"
          />
          → operator
        </span>
        <OperatorContextChip server={server} compact />
        <span className="ml-auto shrink-0 text-right text-text-secondary text-[10px]">
          Enter sends · ⇧Enter newline · Esc back to terminal
        </span>
      </div>
      <textarea
        ref={textareaRef}
        data-testid="quake-terminal-compose-input"
        aria-label="Ask the operator"
        rows={1}
        placeholder={noOperator ? "Start the operator to compose…" : "Ask the operator…"}
        readOnly={noOperator}
        value={compose.text}
        onChange={(e) => setOperatorComposeText(server, target, e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setQuakeComposeEngaged(true)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={`mx-2 mb-2 resize-none rounded border bg-bg-card px-2 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-secondary outline-none ${
          engaged ? "border-accent-green" : "border-border"
        }`}
      />
    </div>
  );
}

/**
 * The mobile standing affordance for the operator — a centered pull tab
 * hanging under the top bar on every route (the desktop standing affordance
 * is the quake launcher; there is no bottom-bar chip). Mounted once beside
 * the quake terminal in the root layout. The tongue is a TOGGLE: on every
 * other
 * route a tap dispatches through the document-event seam, which on mobile
 * navigates to the operator window's terminal route (amber dot when the
 * operator is waiting); on the operator window's OWN route it renders in a
 * return state (`data-tongue-state="return"`, a ⌃ mark in the tab, dot
 * suppressed — the user is already looking at the operator) and a tap
 * navigates BACK: the validated `?from=` origin window when present, else
 * browser history when an entry plausibly exists, else the server route. An
 * unknown, cross-server, or self `?from=` falls through rather than
 * navigating to a dead window. Hidden when no operator window resolves
 * (omitted, not disabled).
 */
export function QuakeTerminalTongue() {
  const isMobile = useIsMobile();
  const { server, target } = useQuakeTerminalContext();
  const sessionsByServer = useContext(SessionContext)?.sessionsByServer;
  const routeServer = useCurrentServerFromRoute();
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ strict: false });
  const matches = useMatches();
  let routeWindow: string | null = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { window?: string };
    if (typeof p.window === "string" && p.window.length > 0) {
      routeWindow = p.window;
      break;
    }
  }
  if (!isMobile || !target) return null;
  // Window ids are server-scoped, so the operator-route check needs the
  // server to match too.
  const onOperatorRoute = routeServer === server && routeWindow === target.window.windowId;
  if (onOperatorRoute) {
    const onReturn = () => {
      if (server) {
        const origin = resolveFromOrigin(search.from, routeWindow, sessionsByServer?.get(server) ?? []);
        if (origin) {
          void navigate({
            to: "/$server/$window",
            params: { server, window: origin.windowId },
            search: {},
          });
          return;
        }
      }
      // A cold deep-link (PWA start) has no back entry; history.length is the
      // best available probe — back() with nothing there would be a dead tap.
      if (window.history.length > 1) {
        router.history.back();
        return;
      }
      if (server) void navigate({ to: "/$server", params: { server } });
    };
    return (
      <button
        type="button"
        data-testid="quake-terminal-tongue"
        data-tongue-state="return"
        aria-label="Back to previous window"
        onClick={onReturn}
        // The visual tab is 64×12; the button's own box is the ≥36px hit area.
        className="absolute top-0 left-1/2 z-30 flex h-9 w-16 -translate-x-1/2 items-start justify-center"
      >
        <span className="relative flex h-3 w-16 items-center justify-center rounded-b-md border border-t-0 border-border bg-bg-primary">
          <span aria-hidden="true" className="text-[10px] leading-none text-text-secondary">
            ⌃
          </span>
        </span>
      </button>
    );
  }
  const waiting = target.window.agentState === "waiting";
  return (
    <button
      type="button"
      data-testid="quake-terminal-tongue"
      data-tongue-state="operator"
      aria-label="Quake terminal"
      onClick={() => requestQuakeTerminal({ action: "toggle" })}
      // The visual tab is 64×12; the button's own box is the ≥36px hit area.
      className="absolute top-0 left-1/2 z-30 flex h-9 w-16 -translate-x-1/2 items-start justify-center"
    >
      <span className="relative block h-3 w-16 rounded-b-md border border-t-0 border-border bg-bg-primary">
        {waiting && (
          <span
            data-testid="quake-terminal-tongue-waiting"
            className="absolute right-1 top-0.5 block h-1.5 w-1.5 rounded-full bg-signal-yellow"
          />
        )}
      </span>
    </button>
  );
}
