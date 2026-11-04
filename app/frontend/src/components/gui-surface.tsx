import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { fetchGuiStatus, pingGui } from "@/api/client";
import type { GuiSignal } from "@/contexts/session-context";
import { copyToClipboard } from "@/lib/clipboard";
import { STATS_PING_MS, STATS_SAMPLE_MS, sampleRates } from "@/lib/gui-stats";
import { createWheelAccumulator } from "@/lib/zoom-gesture";
import {
  readGuiWmStripDismissed,
  stepGuiZoom,
  writeGuiWmStripDismissed,
  GUI_QUALITY_PRESETS,
  type GuiPointerMode,
  type GuiQuality,
  type GuiZoom,
} from "@/lib/gui-posture";
import { Control } from "./control";
import { attachGuiPointer } from "./gui-pointer";
import { GuiKeyBar } from "./gui-keybar";
import { GuiStatsOverlay } from "./gui-stats-overlay";
import { zoomedHostSize } from "@/lib/gui-posture";

/**
 * GuiSurface — the renderer for the `gui` lens (spec docs/specs/gui.md § The
 * substrate / § Availability vs reachability), mounted as a tile by
 * SurfaceLayout's `case "gui"` and lazy-loaded (`export default` +
 * `React.lazy`) so tabs that never open a gui tile never pay for noVNC.
 *
 * - **Content states**: `enabled && reachable` mounts a noVNC `RFB` on a bare
 *   host div connected to the ABSOLUTE `ws(s)://<location.host>/ws/gui/host`
 *   URL (never a relative path — the embed must work behind any proxy); an
 *   enabled-but-unreachable host renders the empty state with the `reason`
 *   fetched ONCE per unreachable transition (never polled — the state socket
 *   drives re-fetch). A `!enabled` host never mounts this tile (degradation).
 *   On a reachable host with NO window manager (`wm === ""`, never on the
 *   screen-sharing mirror backend) a one-line strip (`gui-wm-strip`) rides
 *   above the canvas as a flex sibling — the fit subtracts it — carrying the
 *   status document's `wm_hint` install line (fetched ONCE per bare
 *   transition, the reason-fetch grammar), a Copy of the line, the empty
 *   state's Restart supervisor action, and a per-viewer dismiss
 *   (`hexokit-gui-wm-strip-dismissed`, cleared whenever `wm` turns non-empty).
 * - **Connection lifecycle**: connect/disconnect report through
 *   `onConnectionChange` (the top-bar dot). An RFB disconnect while
 *   `reachable` stays true re-dials on a 1s→2s→4s→8s backoff (reset on
 *   connect) under a `disconnected — reconnecting…` overlay; `reachable`
 *   flipping false swaps in the empty state and clears the timer. When the
 *   tile is not VISIBLE (zoomed away, or the document hidden) for 15s the RFB
 *   disconnects — releasing the relay's viewer count so the backend probe
 *   resumes — and reconnects on the next visible true. Focus loss alone never
 *   disconnects. Unmount disconnects and clears every timer.
 * - **Resize policy (D7)**: `resizeSession` is `!coarsePointer && focused &&
 *   !resizeLocked && !hostLocked && geometry === "auto"`, recomputed on every
 *   prop change. D7's follow-the-tile is now the `auto` value of the host's
 *   `gui.geometry` setting: only while it reads `auto` may the focused
 *   fine-pointer viewer drive SetDesktopSize; a fixed `WxH` (or the `""` of a
 *   disabled host) disables `resizeSession` for EVERY viewer, so the desktop
 *   keeps its configured size (fit mode already letterboxes via
 *   `scaleViewport`). Under `auto` the two pins keep their meaning:
 *   `hostLocked` is the host-side pin (`rk gui lock`, streamed as the entry's
 *   `locked`) — an AND term beside the viewer-local `resizeLocked`, not a
 *   replacement. Coarse viewers scale client-side only and can never resize
 *   the shared desktop.
 * - **Zoom (the sized host)**: `scaleViewport` stays ON at every zoom and
 *   `clipViewport` off; a percentage zoom sizes the noVNC host div to
 *   `fb × z/100` CSS px (the framebuffer from the gui signal's width/height)
 *   so noVNC's autoscale yields exactly z/100 and `_display.scale` equals the
 *   canvas's visual scale by construction (pointer mapping stays exact). At
 *   `fit` the host div is tile-sized, today's behavior. While zoomed
 *   `resizeSession` is held false: noVNC's ResizeObserver watches that screen
 *   div, and its deliberately-larger size must never be requested as the
 *   remote desktop size (the gui-signal echo would feed back and grow the
 *   framebuffer unboundedly); the five-clause formula is untouched and
 *   resumes at `fit`.
 * - **Pan**: the wrapper clips (`overflow: hidden`) and pans via clamped
 *   scroll offsets so the scaled canvas always covers the tile. A fine
 *   pointer left-drag pans — the press is swallowed in the capture phase so
 *   it never reaches noVNC as a guest button, and a release under
 *   PAN_DRAG_THRESHOLD_PX is replayed to the canvas as a plain click. A
 *   coarse one-finger drag in `touch` mode pans via an observing (passive,
 *   capture-phase) touch tracker while `dragViewport` keeps noVNC from
 *   sending the drag to the guest as a left-drag — noVNC's own viewport pan
 *   only moves a CLIPPING display and is a visual no-op under scaleViewport.
 *   The `trackpad` mode's cursor-follow rides the `ensureCursorVisible` seam
 *   (its caller is the trackpad layer). No pan gesture exists at fit.
 * - **Trackpad mode (the translation layer)**: while `pointerMode ===
 *   "trackpad"` on a coarse pointer with a live RFB, `attachGuiPointer`
 *   (gui-pointer.ts) owns every touch in the capture phase and re-emits
 *   synthetic mouse/wheel events on noVNC's canvas — a one-finger drag moves
 *   the virtual cursor (the rk-owned `gui-trackpad-cursor` indicator), tap
 *   left-clicks, two-finger tap right-clicks, two-finger drag scrolls,
 *   long-press drag-and-drops, pinch steps the zoom ladder. `dragViewport`
 *   is forced false while attached (applyRfbProps gates it to touch mode);
 *   `touch` mode is the untouched noVNC passthrough.
 * - **Key bar**: on coarse pointers a `GuiKeyBar` strip (gui-keybar.tsx)
 *   docks under the canvas as a flex sibling of the host div (the fit
 *   subtracts its height) with latching modifiers and a hidden-input ⌨
 *   path; every key rides `rfb.sendKey` through a ref-bound callback — a
 *   no-op without a live RFB. Its visibility is the per-viewer
 *   `rk-gui-keybar` posture (the `keyBarVisible` prop).
 * - **Header fold**: the session controls live in the tile header as a
 *   measured priority fold (components/gui-toolbar.tsx, mounted by
 *   SurfaceLayout's gui branch, NOT here) — nothing overlays the
 *   framebuffer. The fullscreen verb (app.tsx's guiFullscreen) targets the
 *   TILE element, so the header travels into fullscreen and serves it; this
 *   component only reports the flip (onFullscreenChange, containment-checked
 *   against `rootRef`, which is attached to both the canvas and the
 *   empty-state root).
 * - **HiDPI**: with `hidpi` on (`rk-gui-hidpi`) the sized host's CSS size
 *   divides by `window.devicePixelRatio` (zoomedHostSize), so a 100% zoom
 *   maps one framebuffer pixel to one device pixel — crisp 1:1 on a Retina
 *   display. Client-side rendering only: `resizeSession`, `gui.geometry`, and
 *   every server-facing value are untouched; `fit` is unaffected (the fit
 *   scale is tile-bound).
 * - **Zoom badge + wheel**: any zoom prop change shows the corner
 *   `gui-zoom-badge` for ZOOM_BADGE_MS (a change restarts the timer); a
 *   capture-phase non-passive wheel listener steps the ladder one notch per
 *   WHEEL_STEP_THRESHOLD of Ctrl+wheel deltaY (lib/zoom-gesture.ts createWheelAccumulator) (mac trackpad pinch
 *   arrives as ctrl+wheel) and swallows the event so neither the browser's
 *   page zoom nor noVNC's wheel handler sees it; a wheel without Ctrl passes
 *   to noVNC untouched.
 * - **Chord gate**: a capture-phase keydown on the canvas wrapper intercepts
 *   registry chords (`shouldReclaimChord`, bound to kind "gui") BEFORE
 *   noVNC's canvas-attached handler sees them and re-dispatches a synthetic
 *   bubbling KeyboardEvent on the parent document so rk's window-level
 *   dispatcher handles the chord (the code-surface grammar — the dispatcher
 *   listens in the bubble phase, so a plain stopPropagation would eat the
 *   chord). Every other key reaches the guest. No steal guard: noVNC grabs
 *   focus only on click (`focusOnClick`), never programmatically.
 * - **Stats overlay**: the per-viewer `statsVisible` posture
 *   (`rk-gui-stats-visible`) mounts `GuiStatsOverlay` (gui-stats-overlay.tsx)
 *   in the zoom badge's corner (suppressing the badge) and, only while
 *   visible AND connected, runs the collector: fps from canvas-source
 *   `drawImage` calls wrapped on the tile canvas's 2D context INSTANCE
 *   (restored on cleanup), Mbit/s from binary bytes on the WebSocket this
 *   component constructs and hands to `new RFB(hostEl, socket, …)` (noVNC
 *   1.7's raw-channel form — `Websock.attach` coexists with our
 *   `addEventListener("message")` counter), and RTT from a timed
 *   `pingGui()` round trip every `STATS_PING_MS` — all idle while hidden
 *   (the math lives in lib/gui-stats.ts).
 * - **macOS credentials**: on `credentialsrequired` an inline password field
 *   overlays the canvas; the password lives only in component state (never
 *   storage, never a POST) and is re-asked on every reconnect. A
 *   `securityfailure` re-shows the field with the wrong-password note; Escape
 *   disconnects into the empty state.
 */

/** Reconnect backoff after an RFB drop while the host stays reachable. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];

/** How long the tile may stay invisible before the RFB disconnects — the
 *  "stop framebuffer requests when hidden" budget (noVNC has no pause API). */
const VISIBILITY_DISCONNECT_MS = 15_000;

/** How long the strip's Copy button reads `Copied` after a successful write. */
const COPIED_FEEDBACK_MS = 1_500;

/** How long the corner zoom badge stays visible after a zoom change. */
const ZOOM_BADGE_MS = 1_500;

/** Fine-pointer displacement (px) before a held press becomes a pan drag
 *  instead of a replayed click. */
const PAN_DRAG_THRESHOLD_PX = 10;

/** Pan the scroll container, clamped so the scaled canvas always covers the
 *  tile (no overscroll gap). */
function clampScrollBy(el: HTMLElement, dx: number, dy: number): void {
  el.scrollLeft = Math.min(
    Math.max(el.scrollLeft + dx, 0),
    Math.max(el.scrollWidth - el.clientWidth, 0),
  );
  el.scrollTop = Math.min(
    Math.max(el.scrollTop + dy, 0),
    Math.max(el.scrollHeight - el.clientHeight, 0),
  );
}

/** The imperative seams the palette's `GUI:` verbs drive (app.tsx holds the
 *  ref; the component fills it while mounted). */
export interface GuiSurfaceCommands {
  /** Paste host clipboard text into the guest (palette: GUI: Paste clipboard). */
  paste(text: string): void;
  /** Drop and re-dial the RFB connection (palette: GUI: Reconnect). */
  reconnect(): void;
  /** Forward a key to the guest (palette: GUI: Send key…) — a no-op without a
   *  live RFB. */
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

export type GuiRestartResult = { ok: boolean; disabled?: boolean };

interface GuiSurfaceProps {
  /** The host signal (enabled/reachable/backend drive the content states). */
  gui: GuiSignal | null;
  /** Tile displayed (not zoomed away / the mobile-active slot). Combined with
   *  `document.visibilityState` for the 15s hidden-disconnect rule. */
  visible: boolean;
  /** This tile owns tile focus (focusedTileKind === "gui"). */
  focused: boolean;
  /** Coarse pointer — never drives resize; the pan/trackpad layers key on it. */
  coarsePointer: boolean;
  /** Per-viewer RFB quality posture (localStorage `rk-gui-quality`, owned by
   *  app.tsx) — the named preset mapped onto `qualityLevel`/`compressionLevel`. */
  quality: GuiQuality;
  /** Per-viewer stats overlay visibility (`rk-gui-stats-visible`, owned by
   *  app.tsx) — while true AND connected the collector samples fps / Mbit/s /
   *  RTT and the overlay renders; false means fully idle (no wrap, no
   *  interval, no ping). */
  statsVisible: boolean;
  /** Per-viewer zoom posture (localStorage `rk-gui-zoom`, owned by app.tsx). */
  zoom: GuiZoom;
  /** Per-viewer pointer mode (`rk-gui-pointer`): `touch` is the noVNC
   *  passthrough, `trackpad` the rk translation layer. */
  pointerMode: GuiPointerMode;
  /** Zoom-change seam (chords, Ctrl+wheel); app.tsx owns persistence. */
  onZoomChange: (z: GuiZoom) => void;
  /** Pointer-mode seam (app.tsx owns persistence); the palette rows and the
   *  header fold's ⌖ panel row fire it. */
  onPointerModeChange: (m: GuiPointerMode) => void;
  /** HiDPI posture (`rk-gui-hidpi`): divides the percentage-zoom host CSS size
   *  by `devicePixelRatio` — rendering only, never server-facing. */
  hidpi: boolean;
  /** Key-bar visibility posture (`rk-gui-keybar`). */
  keyBarVisible: boolean;
  /** Key-bar visibility seam (the ⚙ panel's ⌨ row fires it, by palette id). */
  onKeyBarVisibleChange: (visible: boolean) => void;
  /** Quality preset seam; app.tsx owns persistence (the fold's ◐ chip fires
   *  it, by palette id). */
  onQualityChange: (q: GuiQuality) => void;
  /** Stats overlay visibility seam; app.tsx owns persistence (the fold's ∿
   *  fires it, by palette id). */
  onStatsVisibleChange: (visible: boolean) => void;
  /** Fullscreen report — the fullscreen verb (app.tsx's guiFullscreen) targets
   *  the TILE, so this surface tracks `fullscreenchange` by containment and
   *  reports flips up; SurfaceLayout latches the header's ⤢ and suppresses the
   *  layout verbs while it lasts. */
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** Viewer-local resize lock (localStorage `rk-gui-lock`). */
  resizeLocked: boolean;
  /** RFB connection report — the top-bar toggle dot (R6). */
  onConnectionChange: (connected: boolean) => void;
  /** Tile-focus seam: pointerdown/keydown on the canvas wrapper. */
  onInteract?: () => void;
  /** Registry-chord predicate bound to kind "gui" (built in app.tsx from
   *  `hasReclaimableMatch`). Absent ⇒ no reclaim. */
  shouldReclaimChord?: (e: KeyboardEvent) => boolean;
  /** POST /api/gui/host/restart (via app.tsx); a 409 surfaces as
   *  `{ ok: false, disabled: true }` so the empty state can render
   *  "gui turned off" instead of an error. */
  onRestart: () => Promise<GuiRestartResult>;
  onOpenLogs: () => void;
  /** Filled with the imperative seams while an RFB is live (paste/reconnect). */
  commandsRef?: { current: GuiSurfaceCommands | null };
}

export default function GuiSurface({
  gui,
  visible,
  focused,
  coarsePointer,
  quality,
  statsVisible,
  zoom,
  pointerMode,
  onZoomChange,
  onPointerModeChange,
  hidpi,
  keyBarVisible,
  onKeyBarVisibleChange,
  onQualityChange,
  onStatsVisibleChange,
  onFullscreenChange,
  resizeLocked,
  onConnectionChange,
  onInteract,
  shouldReclaimChord,
  onRestart,
  onOpenLogs,
  commandsRef,
}: GuiSurfaceProps) {
  const enabled = gui?.enabled === true;
  const reachable = gui?.reachable === true;
  const wm = gui?.wm ?? "";
  const backend = gui?.backend ?? "";
  // The bare state: a reachable host whose supervisor resolved no WM rung.
  // The screen-sharing mirror stamps no WM by construction and has no display
  // to install one into — it is never "bare" here.
  const bare = enabled && reachable && wm === "" && backend !== "screen-sharing";

  const hostRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackpadCursorRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffAttemptRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reason, setReason] = useState("");
  const [restartDisabled, setRestartDisabled] = useState(false);
  const [credentials, setCredentials] = useState<{ wrong: boolean } | null>(null);
  const [password, setPassword] = useState("");
  // Escape on the credentials prompt: disconnect and stay on the empty state
  // until the host signal changes (the stream drives any recovery).
  const [credEscaped, setCredEscaped] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [docVisible, setDocVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  // Connection generation: bumping re-dials (the backoff timer and the manual
  // GUI: Reconnect seam both ride it).
  const [epoch, setEpoch] = useState(0);
  // The bare-WM strip: the install line (empty until the status GET resolves —
  // the strip renders without that segment meanwhile) and the per-viewer
  // dismiss/Copy feedback state.
  const [wmHint, setWmHint] = useState("");
  const [wmStripDismissed, setWmStripDismissed] = useState(readGuiWmStripDismissed);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The zoom badge: `null` = hidden. A zoom prop CHANGE shows it for
  // ZOOM_BADGE_MS (never on initial mount — nothing changed yet).
  const [badge, setBadge] = useState<GuiZoom | null>(null);
  const badgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastZoomRef = useRef(zoom);
  // Fullscreen flips arrive only as DOM events (the verb is app.tsx's): the
  // TILE is the fullscreen element, so this surface reports containment flips
  // up (the header's ⤢ latch + layout-verb suppression live in SurfaceLayout).
  // Tracked from the DOM, covering both the canvas and the empty-state root.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // An in-flight fine-pointer pan drag; its window-level listeners' remover.
  const panCleanupRef = useRef<(() => void) | null>(null);
  // Reentrancy guard for the replayed click (it bubbles through this
  // wrapper's own capture handlers).
  const panReplayRef = useRef(false);
  // The stats seam's raw counters: flips (canvas-source drawImage calls on
  // the tile canvas's 2D context — noVNC's Display.flip) and binary bytes on
  // the RFB socket. The byte listener rides the socket for its whole life
  // (a cheap increment); the flip wrap exists only while the collector runs.
  const statsCountersRef = useRef({ flips: 0, bytes: 0 });
  const [stats, setStats] = useState<{ fps: number | null; mbit: number | null }>({ fps: null, mbit: null });
  const [rttMs, setRttMs] = useState<number | null>(null);

  // Latest-value refs for the listener/effect closures that outlive renders.
  const propsRef = useRef({ coarsePointer, focused, resizeLocked, zoom, pointerMode, quality, backend: gui?.backend ?? "", hostLocked: gui?.locked ?? false, geometry: gui?.geometry ?? "" });
  propsRef.current = { coarsePointer, focused, resizeLocked, zoom, pointerMode, quality, backend: gui?.backend ?? "", hostLocked: gui?.locked ?? false, geometry: gui?.geometry ?? "" };
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const onInteractRef = useRef(onInteract);
  onInteractRef.current = onInteract;
  const onFullscreenChangeRef = useRef(onFullscreenChange);
  onFullscreenChangeRef.current = onFullscreenChange;
  const reclaimRef = useRef(shouldReclaimChord);
  reclaimRef.current = shouldReclaimChord;

  // D7: only the focused fine-pointer viewer on an unlocked host (neither the
  // viewer-local pin nor `rk gui lock` set) whose host setting is `auto`
  // drives SetDesktopSize. While zoomed the screen div is deliberately larger
  // than the tile, so resizeSession is held false — noVNC would request the
  // SCALED size as the remote desktop size and the signal echo would grow the
  // framebuffer unboundedly. The formula resumes verbatim at `fit`.
  const applyRfbProps = (rfb: RFB) => {
    const p = propsRef.current;
    rfb.resizeSession = !p.coarsePointer && p.focused && !p.resizeLocked && !p.hostLocked && p.geometry === "auto" && p.zoom === "fit";
    // The sized host (see the header): scaleViewport is always on and
    // clipViewport always off — a percentage zoom sizes the host div so
    // autoscale lands on exactly z/100.
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    // noVNC's dragViewport pan moves only a CLIPPING viewport (a visual no-op
    // under scaleViewport) — its role here is to keep a coarse one-finger
    // drag from reaching the guest as a left-drag while the wrapper's own
    // touch tracker scrolls. Trackpad mode forces it off (the translation
    // layer owns the touches).
    rfb.dragViewport = p.zoom !== "fit" && p.coarsePointer && p.pointerMode === "touch";
    // The quality posture's named preset, applied live like every prop above.
    const preset = GUI_QUALITY_PRESETS[p.quality];
    rfb.qualityLevel = preset.qualityLevel;
    rfb.compressionLevel = preset.compressionLevel;
    rfb.showDotCursor = true;
    rfb.focusOnClick = true;
    rfb.background = "";
    // The relay already drops input on macOS; viewOnly stops the pretend cursor.
    rfb.viewOnly = p.backend === "screen-sharing";
  };

  const effectivelyVisible = visible && docVisible;
  const wantConnection = enabled && reachable && !credEscaped && !suspended;
  // Read from inside the disconnect closure (the connect effect re-runs on
  // its flip, but a listener outlives the render that installed it).
  const wantConnectionRef = useRef(wantConnection);
  wantConnectionRef.current = wantConnection;

  // Track document visibility (a prop can't — it lives outside React).
  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Fullscreen flips arrive only as DOM events (the verb is a callback, Esc
  // bypasses it entirely). The fullscreen element is the TILE — an ANCESTOR
  // of this surface — so the check is containment against the root ref
  // (attached to both the canvas and the empty-state root), never identity.
  useEffect(() => {
    const onFsChange = () => {
      const root = rootRef.current;
      onFullscreenChangeRef.current?.(
        root !== null && (document.fullscreenElement?.contains(root) ?? false),
      );
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // The 15s hidden-disconnect rule: invisible starts the budget, visible
  // clears it and unsuspends (the connect effect re-dials on the flip).
  useEffect(() => {
    if (effectivelyVisible) {
      setSuspended(false);
      return;
    }
    const t = setTimeout(() => setSuspended(true), VISIBILITY_DISCONNECT_MS);
    return () => clearTimeout(t);
  }, [effectivelyVisible]);

  // The RFB connection itself. Keyed on wantConnection + epoch: any flip to
  // unwanted tears down; any epoch bump re-dials. Cleanup removes the RFB's
  // listeners BEFORE disconnect() so the teardown disconnect event cannot
  // schedule a spurious reconnect, and drops noVNC's screen subtree so a
  // re-dial starts from a bare host div.
  useEffect(() => {
    if (!wantConnection) return;
    const hostEl = hostRef.current;
    if (!hostEl) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    // The component constructs the socket itself (noVNC 1.7's raw-channel
    // constructor form — Websock.attach sets binaryType/onmessage, which
    // coexists with our addEventListener byte counter) so the stats seam
    // counts bytes on rk's own object, never a global WebSocket wrap.
    const socket = new WebSocket(`${proto}://${window.location.host}/ws/gui/host`);
    const onSocketMessage = (e: MessageEvent) => {
      const data: unknown = e.data;
      if (data instanceof ArrayBuffer) {
        statsCountersRef.current.bytes += data.byteLength;
      } else if (data instanceof Blob) {
        statsCountersRef.current.bytes += data.size;
      }
    };
    socket.addEventListener("message", onSocketMessage);
    const rfb = new RFB(hostEl, socket, {
      shared: true,
    });
    rfbRef.current = rfb;
    applyRfbProps(rfb);

    const onConnect = () => {
      backoffAttemptRef.current = 0;
      setConnected(true);
      setReconnecting(false);
      onConnectionChangeRef.current(true);
    };
    const onDisconnect = () => {
      setConnected(false);
      onConnectionChangeRef.current(false);
      if (!wantConnectionRef.current) return;
      // The host stays reachable: re-dial with capped backoff, the overlay
      // marking the interim.
      setReconnecting(true);
      const attempt = Math.min(backoffAttemptRef.current, RECONNECT_BACKOFF_MS.length - 1);
      backoffAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => setEpoch((e) => e + 1), RECONNECT_BACKOFF_MS[attempt]);
    };
    const onClipboard = (e: CustomEvent<{ text: string }>) => {
      // Best-effort: no clipboard permission silently skips the write.
      navigator.clipboard?.writeText(e.detail.text).catch(() => {});
    };
    const onCredentials = () => {
      setPassword("");
      setCredentials({ wrong: false });
    };
    const onSecurityFailure = () => {
      setPassword("");
      setCredentials({ wrong: true });
    };
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    rfb.addEventListener("clipboard", onClipboard);
    rfb.addEventListener("credentialsrequired", onCredentials);
    rfb.addEventListener("securityfailure", onSecurityFailure);

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      socket.removeEventListener("message", onSocketMessage);
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.removeEventListener("clipboard", onClipboard);
      rfb.removeEventListener("credentialsrequired", onCredentials);
      rfb.removeEventListener("securityfailure", onSecurityFailure);
      rfb.disconnect();
      rfbRef.current = null;
      hostEl.replaceChildren();
      setConnected(false);
      setReconnecting(false);
      onConnectionChangeRef.current(false);
    };
    // Deps stay [wantConnection, epoch] by contract: applyRfbProps reads the
    // latest props through propsRef, and prop-only changes apply to the live
    // RFB via the every-render effect below — they must NOT re-dial.
  }, [wantConnection, epoch]);

  // Recompute the RFB prop mapping on EVERY prop change — noVNC applies the
  // setters live (a resizeSession flip sends SetDesktopSize on the next size
  // change). No deps array: runs after every render, cheap plain assignments.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (rfb) applyRfbProps(rfb);
  });

  // The stats collector: runs only while the overlay is visible AND the RFB
  // is connected — hidden or disconnected means no wrap, no interval, no
  // ping. fps counts canvas-source drawImage calls on the tile canvas's 2D
  // context INSTANCE (noVNC's Display.flip — the gui-perf.spec criterion;
  // never the prototype, never _display), restored on cleanup; the 1 s tick
  // folds the counters into the snapshot; every 5 s a pingGui round trip is
  // timed into rttMs (null until the first resolves and after any failure).
  useEffect(() => {
    if (!statsVisible || !connected) return;
    const counters = statsCountersRef.current;
    setStats({ fps: null, mbit: null });
    setRttMs(null);
    const canvas = hostRef.current?.querySelector("canvas");
    const ctx = canvas?.getContext("2d") ?? null;
    let restoreDrawImage: (() => void) | null = null;
    if (ctx) {
      const original = ctx.drawImage;
      ctx.drawImage = (image: CanvasImageSource, ...args: number[]): void => {
        if (image instanceof HTMLCanvasElement) counters.flips += 1;
        Reflect.apply(original, ctx, [image, ...args]);
      };
      restoreDrawImage = () => {
        ctx.drawImage = original;
      };
    }
    let prev = { ...counters };
    let prevAt = performance.now();
    const sampleTimer = setInterval(() => {
      const now = { ...counters };
      const nowAt = performance.now();
      setStats(sampleRates(prev, now, nowAt - prevAt));
      prev = now;
      prevAt = nowAt;
    }, STATS_SAMPLE_MS);
    // review-ignore: RTT probe — the timed round trip IS the measurement; runs only while the overlay is visible and the RFB is connected
    const pingTimer = setInterval(() => {
      const startedAt = performance.now();
      pingGui()
        .then(() => setRttMs(performance.now() - startedAt))
        .catch(() => setRttMs(null));
    }, STATS_PING_MS);
    return () => {
      restoreDrawImage?.();
      clearInterval(sampleTimer);
      clearInterval(pingTimer);
    };
  }, [statsVisible, connected]);

  // The zoom badge: shows on every zoom prop CHANGE (never on mount), hides
  // ZOOM_BADGE_MS later; a change mid-show restarts the timer.
  useEffect(() => {
    if (lastZoomRef.current === zoom) return;
    lastZoomRef.current = zoom;
    setBadge(zoom);
    if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(() => setBadge(null), ZOOM_BADGE_MS);
  }, [zoom]);

  // The badge timer must not outlive the component.
  useEffect(() => {
    return () => {
      if (badgeTimerRef.current) clearTimeout(badgeTimerRef.current);
    };
  }, []);

  // Ctrl+wheel zoom — a NATIVE capture-phase non-passive listener (React
  // attaches wheel passively, where preventDefault is ignored). The event is
  // swallowed before noVNC's canvas wheel handler or the browser's page zoom
  // can see it; a wheel without Ctrl passes through untouched. The delta→step
  // reduction (sub-threshold deltas — mac trackpad pinch — accumulate into
  // single steps; a direction flip drops the leftover) is the shared
  // zoom-gesture accumulator; the ladder itself is stepGuiZoom.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const accumulate = createWheelAccumulator();
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      let steps = accumulate(e.deltaY);
      let z = propsRef.current.zoom;
      while (steps > 0) {
        z = stepGuiZoom(z, 1);
        steps -= 1;
      }
      while (steps < 0) {
        z = stepGuiZoom(z, -1);
        steps += 1;
      }
      if (z !== propsRef.current.zoom) onZoomChangeRef.current(z);
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
    // The wrapper exists only in the canvas branch — re-attach on a branch
    // switch (the empty state renders no wrapper).
  }, [enabled, reachable, credEscaped]);

  // Coarse `touch`-mode pan: OBSERVE one-finger drags (passive capture — the
  // events still reach noVNC, whose dragViewport swallows them as a viewport
  // gesture instead of a guest left-drag) and scroll the wrapper to match.
  useEffect(() => {
    if (zoom === "fit" || !coarsePointer || pointerMode !== "touch") return;
    const el = wrapperRef.current;
    if (!el) return;
    let last: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      last = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!last || e.touches.length !== 1) {
        last = null;
        return;
      }
      const t = e.touches[0];
      clampScrollBy(el, last.x - t.clientX, last.y - t.clientY);
      last = { x: t.clientX, y: t.clientY };
    };
    const onEnd = () => {
      last = null;
    };
    el.addEventListener("touchstart", onStart, { capture: true, passive: true });
    el.addEventListener("touchmove", onMove, { capture: true, passive: true });
    el.addEventListener("touchend", onEnd, { capture: true, passive: true });
    el.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart, { capture: true });
      el.removeEventListener("touchmove", onMove, { capture: true });
      el.removeEventListener("touchend", onEnd, { capture: true });
      el.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [enabled, reachable, credEscaped, zoom, coarsePointer, pointerMode]);

  // An in-flight pan drag's window listeners must not outlive the component.
  useEffect(() => {
    return () => panCleanupRef.current?.();
  }, []);

  // Fine-pointer pan: the press is swallowed in the capture phase (the JSX
  // onMouseDownCapture) so it never reaches noVNC as a guest button; the
  // drag scrolls the wrapper, and a release under the threshold replays a
  // plain click to the canvas so clicking still works while zoomed.
  const startPanDrag = (clientX: number, clientY: number) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    panCleanupRef.current?.();
    const drag = { startX: clientX, startY: clientY, lastX: clientX, lastY: clientY, panning: false };
    const onMove = (ev: MouseEvent) => {
      const dx = drag.lastX - ev.clientX;
      const dy = drag.lastY - ev.clientY;
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
      if (!drag.panning) {
        if (Math.abs(ev.clientX - drag.startX) <= PAN_DRAG_THRESHOLD_PX &&
            Math.abs(ev.clientY - drag.startY) <= PAN_DRAG_THRESHOLD_PX) {
          return;
        }
        drag.panning = true;
      }
      ev.stopPropagation();
      ev.preventDefault();
      clampScrollBy(wrapper, dx, dy);
    };
    const onUp = (ev: MouseEvent) => {
      panCleanupRef.current = null;
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      ev.stopPropagation();
      ev.preventDefault();
      if (!drag.panning) {
        // Never became a drag: replay the swallowed press as a plain click.
        // The replayed events bubble through this wrapper's own capture
        // handlers — the flag keeps them from starting a fresh pan drag.
        const canvas = hostRef.current?.querySelector("canvas");
        if (canvas) {
          panReplayRef.current = true;
          try {
            canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: ev.clientX, clientY: ev.clientY, button: 0, buttons: 1, bubbles: true }));
            canvas.dispatchEvent(new MouseEvent("mouseup", { clientX: ev.clientX, clientY: ev.clientY, button: 0, buttons: 0, bubbles: true }));
          } finally {
            panReplayRef.current = false;
          }
        }
      }
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    panCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  };

  // The trackpad layer's cursor-follow seam: scroll the wrapper so the
  // framebuffer point is inside the visible window. A no-op at fit (nothing
  // to pan); clamped like any other pan.
  const ensureCursorVisible = (fbX: number, fbY: number) => {
    const el = wrapperRef.current;
    const z = propsRef.current.zoom;
    if (!el || z === "fit") return;
    const cssX = (fbX * z) / 100;
    const cssY = (fbY * z) / 100;
    let dx = 0;
    let dy = 0;
    if (cssX < el.scrollLeft) dx = cssX - el.scrollLeft;
    else if (cssX > el.scrollLeft + el.clientWidth) dx = cssX - el.clientWidth - el.scrollLeft;
    if (cssY < el.scrollTop) dy = cssY - el.scrollTop;
    else if (cssY > el.scrollTop + el.clientHeight) dy = cssY - el.clientHeight - el.scrollTop;
    if (dx !== 0 || dy !== 0) clampScrollBy(el, dx, dy);
  };
  const ensureCursorVisibleRef = useRef(ensureCursorVisible);
  ensureCursorVisibleRef.current = ensureCursorVisible;

  // Trackpad mode: the translation layer (gui-pointer.ts) owns every touch on
  // the wrapper in the capture phase and re-emits synthetic mouse/wheel
  // events on noVNC's canvas. dragViewport stays false while attached —
  // applyRfbProps gates it to touch mode, so the two never fight over the
  // same input. Deps mirror the connection effect's: a re-dial (epoch bump)
  // re-attaches against the fresh RFB (React runs all cleanups before all
  // setups on a re-render, so the detach never races the disconnect), and a
  // mode flip or branch switch detaches. The layer also detaches while the
  // credentials prompt is up: the modal overlay is not a gesture surface and
  // no gesture state may track across it.
  useEffect(() => {
    if (pointerMode !== "trackpad" || !coarsePointer || !wantConnection || credentials) return;
    const rfb = rfbRef.current;
    const wrapper = wrapperRef.current;
    if (!rfb || !wrapper) return;
    return attachGuiPointer(wrapper, {
      rfb,
      cursorEl: trackpadCursorRef.current,
      onZoomStep: (dir) => onZoomChangeRef.current(stepGuiZoom(propsRef.current.zoom, dir)),
      ensureCursorVisible: (fbX, fbY) => ensureCursorVisibleRef.current(fbX, fbY),
    });
  }, [wantConnection, epoch, pointerMode, coarsePointer, enabled, reachable, credEscaped, credentials]);

  // The palette seams (GUI: Paste clipboard / GUI: Reconnect / GUI: Send
  // key…) — live only while mounted; paste and sendKey no-op without a live
  // RFB.
  useEffect(() => {
    if (!commandsRef) return;
    commandsRef.current = {
      paste: (text) => rfbRef.current?.clipboardPasteFrom(text),
      sendKey: (keysym, code, down) => rfbRef.current?.sendKey(keysym, code, down),
      reconnect: () => {
        backoffAttemptRef.current = 0;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        // An Escape'd credentials prompt parks the connection until the next
        // host-signal transition; a user-invoked reconnect reopens it now.
        setCredEscaped(false);
        setEpoch((e) => e + 1);
      },
    };
    return () => {
      commandsRef.current = null;
    };
  }, [commandsRef]);

  // The empty state's reason: fetched ONCE per unreachable transition (the
  // stream drives any re-fetch — a reachable flip re-arms the transition).
  // A failed GET leaves the empty state without a reason line, never a throw.
  const reasonFetchedRef = useRef(false);
  useEffect(() => {
    if (!enabled || reachable) {
      reasonFetchedRef.current = false;
      setRestartDisabled(false);
      setCredEscaped(false);
      return;
    }
    if (reasonFetchedRef.current) return;
    reasonFetchedRef.current = true;
    // A new unreachable transition starts with no reason: a stale line from an
    // earlier transition must not survive a failed GET.
    setReason("");
    let cancelled = false;
    fetchGuiStatus()
      .then((s) => {
        if (!cancelled) setReason(s.reason ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // StrictMode's mount-replay cleanup runs synchronously between the two
      // effect invocations of ONE transition — re-arm so the replay re-fires
      // the fetch instead of dropping it (the cancelled flag above suppresses
      // the first attempt's late resolution).
      reasonFetchedRef.current = false;
    };
  }, [enabled, reachable]);

  // The strip's install line: fetched ONCE per bare transition from the status
  // document (the stream carries `wm` but not the package-manager-aware hint,
  // so the frontend never hardcodes one) — the same never-polled grammar as
  // the reason fetch above. A failed GET leaves the line unknown: the strip
  // still renders, without the install segment and without Copy. A `wm` or
  // `reachable` flip re-arms the transition and clears the stored line.
  const hintFetchedRef = useRef(false);
  useEffect(() => {
    if (!bare) {
      hintFetchedRef.current = false;
      setWmHint("");
      return;
    }
    if (hintFetchedRef.current) return;
    hintFetchedRef.current = true;
    // A new bare transition starts with no line: a stale hint from an earlier
    // transition must not survive a failed GET.
    setWmHint("");
    let cancelled = false;
    fetchGuiStatus()
      .then((s) => {
        if (!cancelled) setWmHint(s.wm_hint ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // StrictMode's mount-replay cleanup runs synchronously between the two
      // effect invocations of ONE transition — re-arm so the replay re-fires
      // the fetch instead of dropping it (the cancelled flag above suppresses
      // the first attempt's late resolution).
      hintFetchedRef.current = false;
    };
  }, [bare]);

  // A non-empty `wm` (the user installed a WM and restarted) clears the
  // dismissal, so a LATER bare state shows the strip again. A `reachable`
  // flip deliberately never clears it.
  useEffect(() => {
    if (wm === "") return;
    writeGuiWmStripDismissed(false);
    setWmStripDismissed(false);
  }, [wm]);

  // The `Copied` feedback timer must not outlive the component.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const dismissWmStrip = () => {
    setWmStripDismissed(true);
    writeGuiWmStripDismissed(true);
  };

  const copyInstallLine = () => {
    void copyToClipboard(wmHint).then((ok) => {
      // A failed copy (both mechanisms) leaves the strip unchanged.
      if (!ok) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  };

  if (!gui || !enabled) return null;

  if (!reachable || credEscaped) {
    return (
      <div
        ref={rootRef}
        data-testid="gui-surface-empty"
        className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-text-secondary text-xs font-mono select-none"
      >
        <div>GUI is on but not running</div>
        {reason ? <div data-testid="gui-surface-reason">{reason}</div> : null}
        {restartDisabled ? <div>gui turned off</div> : null}
        <div className="flex gap-2">
          <button
            type="button"
            className="border border-border rounded px-2 py-1 hover:bg-bg-inset"
            onClick={() => {
              onRestart()
                .then((r) => {
                  if (r.ok === false) setRestartDisabled(true);
                })
                .catch(() => {});
            }}
          >
            Restart supervisor
          </button>
          <button
            type="button"
            className="border border-border rounded px-2 py-1 hover:bg-bg-inset"
            onClick={onOpenLogs}
          >
            Open supervisor logs
          </button>
        </div>
      </div>
    );
  }

  const submitCredentials = () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.sendCredentials({ password });
    // The password lives in component state only — cleared immediately after
    // submit, never stored, and re-asked on the next credentialsrequired.
    setPassword("");
    setCredentials(null);
  };

  // The sized host: at fit the host div is tile-sized (flex-1, today's fit);
  // a percentage zoom sizes it to fb × z/100 CSS px so noVNC's autoscale
  // yields exactly z/100 — divided by the device pixel ratio under HiDPI, so
  // 100% maps one framebuffer pixel to one device pixel (a client-side
  // rendering choice; no server-facing value ever reads it). shrink-0 keeps
  // the flex layout from shrinking it back to the tile.
  const fbW = gui.width;
  const fbH = gui.height;
  const hostStyle = zoomedHostSize(fbW, fbH, zoom, hidpi ? window.devicePixelRatio : 1);

  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
        rootRef.current = el;
      }}
      data-testid="gui-surface-canvas"
      className="flex-1 min-h-0 relative overflow-hidden flex flex-col"
      onPointerDownCapture={() => {
        onInteractRef.current?.();
      }}
      onMouseDownCapture={(e) => {
        // Fine-pointer pan: a zoomed left-press inside the noVNC host subtree
        // is a pan gesture, never a guest button — swallow it before noVNC's
        // canvas listeners (a release under the threshold replays a click).
        if (panReplayRef.current) return;
        if (propsRef.current.zoom === "fit" || propsRef.current.coarsePointer || e.button !== 0) return;
        if (!(e.target instanceof Node) || !hostRef.current?.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        startPanDrag(e.clientX, e.clientY);
      }}
      onKeyDownCapture={(e) => {
        onInteractRef.current?.();
        if (!reclaimRef.current?.(e.nativeEvent)) return;
        // noVNC's Keyboard listens on the canvas (a descendant) — stop the
        // event before it descends, then re-dispatch on the parent document:
        // rk's keybinding dispatcher listens at window in the BUBBLE phase,
        // so a plain stopPropagation would eat the chord with it.
        e.preventDefault();
        e.stopPropagation();
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            bubbles: true,
          }),
        );
      }}
    >
      {bare && !wmStripDismissed ? (
        <div
          data-testid="gui-wm-strip"
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 border-b border-border text-text-secondary select-none font-mono text-xs"
        >
          <span>No window manager on the GUI host</span>
          {wmHint ? <span>{` — ${wmHint}`}</span> : null}
          <span>
            {" · then "}
            <button
              type="button"
              className="underline hover:text-text-primary"
              // An ok:false (409) means the switch flipped off — the stream
              // unmounts the tile; there is nothing to render for it here.
              onClick={() => void onRestart().catch(() => {})}
            >
              Restart supervisor
            </button>
          </span>
          {wmHint ? (
            <Control variant="chip" aria-label="Copy install line" onClick={copyInstallLine}>
              {copied ? "Copied" : "Copy"}
            </Control>
          ) : null}
          <Control variant="chip" aria-label="Dismiss" onClick={dismissWmStrip}>
            ×
          </Control>
        </div>
      ) : null}
      {/* The key pins the host div's DOM node identity: without it a branch
          switch (canvas ⇄ empty state) can reuse the node for a same-position
          sibling, and the connect effect's cleanup (`hostEl.replaceChildren()`)
          would then wipe THAT element's content. */}
      <div
        ref={hostRef}
        data-testid="gui-novnc-host"
        className={hostStyle ? "shrink-0" : "flex-1 min-h-0"}
        style={hostStyle}
        key="novnc-host"
      />
      {/* Trackpad mode's virtual cursor — noVNC's local cursor is a CSS
          `cursor`, invisible under touch. The layer positions it; it ignores
          all input. */}
      {coarsePointer && pointerMode === "trackpad" ? (
        <div
          ref={trackpadCursorRef}
          data-testid="gui-trackpad-cursor"
          className="absolute z-10 left-0 top-0 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full bg-accent-green/80 border border-bg-primary pointer-events-none"
        />
      ) : null}
      {/* The coarse-pointer key bar docks under the canvas as a flex sibling
          (the fit subtracts its height); sendKey rides the live RFB and is a
          no-op without one. `keyBarVisible` is the `rk-gui-keybar` posture —
          the ⚙ panel's ⌨ row toggles it. */}
      {coarsePointer && keyBarVisible && !credentials ? (
        <GuiKeyBar
          sendKey={(keysym, code, down) => {
            rfbRef.current?.sendKey(keysym, code, down);
          }}
        />
      ) : null}
      {statsVisible ? (
        <GuiStatsOverlay
          stats={{
            fps: stats.fps,
            mbit: stats.mbit,
            rttMs,
            width: gui.width,
            height: gui.height,
            zoom,
          }}
        />
      ) : null}
      {/* The session controls live in the tile header's measured fold
          (gui-toolbar.tsx, SurfaceLayout's gui branch) — nothing overlays
          the framebuffer. The fullscreen verb targets the TILE, so the
          header travels into fullscreen and serves it too. */}
      {/* The zoom badge cedes the corner to the stats overlay while it is
          visible — same classes, and the overlay's zoom segment is live. */}
      {!statsVisible && badge !== null ? (
        <div
          data-testid="gui-zoom-badge"
          className="absolute top-2 right-2 z-10 px-1.5 py-0.5 rounded border border-border bg-bg-primary/80 text-text-secondary text-xs font-mono select-none pointer-events-none"
        >
          {badge === "fit" ? "fit" : `${badge}%`}
        </div>
      ) : null}
      {reconnecting && !credentials ? (
        <div
          data-testid="gui-surface-reconnecting"
          className="absolute inset-0 flex items-center justify-center text-text-secondary text-xs font-mono select-none bg-bg-primary/70"
        >
          disconnected — reconnecting…
        </div>
      ) : null}
      {credentials ? (
        <div
          data-testid="gui-surface-credentials"
          className="absolute inset-0 flex items-center justify-center bg-bg-primary/70"
        >
          <form
            className="flex flex-col gap-2 items-center text-xs font-mono text-text-secondary"
            onSubmit={(e) => {
              e.preventDefault();
              submitCredentials();
            }}
          >
            <label htmlFor="gui-surface-password">Screen Sharing password</label>
            {credentials.wrong ? <div>Wrong password — try again</div> : null}
            <input
              id="gui-surface-password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setCredentials(null);
                  setCredEscaped(true);
                  setReason("Screen Sharing password required");
                }
              }}
              className="bg-bg-inset border border-border rounded px-2 py-1 text-text-primary"
            />
            <button
              type="submit"
              className="border border-border rounded px-2 py-1 hover:bg-bg-inset"
            >
              Connect
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
