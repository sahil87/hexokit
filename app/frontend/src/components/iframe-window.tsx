import { useState, useRef, useCallback, useEffect, useMemo, type ComponentType } from "react";
import { INPUT_FOCUS } from "@/components/controls";
import { ApiError } from "@/api/client";
import { Tip, TipGroup } from "@/components/tip";
import { FindBar } from "@/components/find-bar";
import {
  FindGlyph,
  InspectGlyph,
  OpenExternalGlyph,
  RefreshGlyph,
  WebBackGlyph,
  WebForwardGlyph,
} from "@/components/top-bar-icons";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  WEB_ADDRESS_FOCUS_EVENT,
  WEB_INSPECT_EVENT,
  WEB_OPEN_EXTERNAL_EVENT,
  WEB_TAB_DRAFT_EVENT,
  classifyAddress,
  displayForm,
  routeAddressSubmit,
  webTabTitle,
  type AddressKind,
} from "@/lib/web-url";
import {
  WEB_ZOOM_DEFAULT,
  WEB_ZOOM_EVENT,
  readWebZoom,
  stepWebZoom,
  webZoomKeyFor,
  writeWebZoom,
  WEB_ZOOM_MAX,
  WEB_ZOOM_MIN,
  type WebZoomDirection,
} from "@/lib/web-zoom";
import { applyWheelZoom, clampZoom } from "@/lib/zoom-gesture";
import { WEB_FIND_OPEN_EVENT } from "@/lib/find-in-page";
import {
  WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES,
  WebFrameIframe,
} from "@/components/web-frame-iframe";
import {
  WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES,
  WebFrameNative,
} from "@/components/web-frame-native";
import { useLocalStorageBoolean } from "@/hooks/use-local-storage-boolean";
import { useKeybindings } from "@/hooks/use-keybindings";
import { buildWebChordTable } from "@/lib/web-chord-table";
import { canShellWeb } from "@/lib/shell";
import {
  WEB_NATIVE_ENGINE_DEFAULT,
  WEB_NATIVE_ENGINE_PREF_KEY,
  selectWebEngineKind,
} from "@/lib/web-engine-pref";
import type {
  FrameChromeState,
  WebFrameCapabilities,
  WebFrameEngineHandle,
  WebFrameEngineKind,
  WebFrameEngineProps,
} from "@/lib/web-frame-engine";

interface IframeWindowProps {
  /** Dense web-tab family (the window's `webTabs ?? []`). */
  tabs: string[];
  /** The tile's tmux identity — the server name and window id (`@N`) of the
   *  window this tile renders. Feeds the native engine's retention identity
   *  (joined with the slot URL) and scopes the chrome-owned destroy rule: a
   *  URL leaving the family of THIS window destroys its guest, while a window
   *  switch parks. Absent ⇒ no retention (guests destroy on unmount). */
  server?: string;
  windowId?: string;
  /** 1-based active slot (the window's `webActive`); 0/undefined with a
   *  non-empty family selects slot 1, out-of-range clamps. */
  active?: number;
  /** Address-bar slot-write seam: Enter on URL-shaped input (the submit
   *  ladder's write lane) POSTs the value to the active web slot's window
   *  option through this callback. Path/port-shaped input never reaches it —
   *  those lanes submit through `onAddTab` (append-or-focus). The component
   *  stays payload-shape agnostic — the caller owns the slot. Absent ⇒ the
   *  write-lane submit is a local no-op. */
  onWriteUrl?: (url: string) => Promise<unknown>;
  /** Strip verbs — absent ⇒ the control is not rendered / the gesture is a
   *  no-op. The caller owns the POSTs; the component re-renders from the
   *  next `tabs`/`active` props and never renumbers locally. */
  onSelectTab?: (n: number) => Promise<unknown>;
  onCloseTab?: (n: number) => Promise<unknown>;
  /** Move (drag, strip ⌥⇧←/→, or dblclick-free drop) — the optimistic
   *  reorder seam; absent ⇒ drag and the move keys are inert. */
  onMoveTab?: (n: number, to: number) => Promise<unknown>;
  /** The add-verb seam: draft materialization, the palette's draft seam, and
   *  the address bar's path/port lanes (a repo-relative path, a dotted single
   *  name, bare `:NNNN`) all submit through it — the backend stats path
   *  targets under the window's worktree cwd. Resolves to the server's
   *  {index, existed}; the component then calls onSelectTab(index) because
   *  the add verb selects only an empty family (append-or-focus). */
  onAddTab?: (target: string) => Promise<{ index: number; existed: boolean }>;
  /** Tile-focus seam: fired when a pointerdown/keydown arrives inside the
   *  engine's content, or — the unreadable-content fallback — when the parent
   *  window blurs with the frame as the active element. Clicks inside an
   *  iframe stay in the frame's document and moving focus into it fires NO
   *  focusin in the parent, so without this seam in-frame interaction is
   *  invisible to the tile wrapper. Absent ⇒ no reporting. */
  onInteract?: () => void;
  /** Chord-reclaim seam (260819-ie2i R1): the kind-bound predicate over
   *  in-frame keydowns. A MATCHING chord is consumed in the frame
   *  (preventDefault + stopImmediatePropagation) and re-dispatched as a
   *  synthetic bubbling KeyboardEvent on the parent document — byte-identical
   *  in mechanism to `CodeSurface`'s `onKey`. Non-matching keys pass through
   *  untouched (typing into a framed form is unchanged); every keydown still
   *  reports `onInteract` first. Absent ⇒ report-only (legacy behavior). */
  shouldReclaimChord?: (e: KeyboardEvent) => boolean;
  /** Page-meta seam (260819-v6y4 R10): fired on every ACTIVE frame `load`
   *  with the reported page title, `null` when the engine reports none. The
   *  header (SurfaceLayout) owns the render, but only the engine can read
   *  its content's title — the `onInteract`/`onFolderNavigated`
   *  callback-seam shape. Absent ⇒ no reporting. */
  onPageMeta?: (meta: { title: string | null }) => void;
  /** The web keyboard-capture latch (`rk-web-capture`, owned by app.tsx).
   *  While set the native engine's chord table narrows to the release binding
   *  (`buildWebChordTable(bindings, true)`); the iframe engine's narrowing
   *  rides `shouldReclaimChord`. The toggle verb lives in the tile header
   *  (SurfaceLayout), not this chrome. */
  webCapture?: boolean;
}

/** Trailing debounce for persisting gesture-driven zoom — a pinch emits
 *  dozens of events; one write after quiescence is enough (260824-iafo R4). */
const ZOOM_PERSIST_DEBOUNCE_MS = 250;

/** Backend family cap (`@rk_win_web_1..16`) — bounds the mounted frames. */
const WEB_TAB_FAMILY_CAP = 16;

/** Sub-pixels of movement that keep a pointer-drag a click (the select
 *  gesture) instead of a reorder commit. */
const DRAG_THRESHOLD_PX = 6;

/**
 * One viewer-local draft tab. Drafts are ephemeral per-tile state — they
 * render after all real tabs and never POST; Enter in the address bar
 * materializes the selected one through the add verb.
 */
interface Draft {
  id: number;
}

function externalFavicon(url: string): string | null {
  try {
    return `https://${new URL(url).host}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Map an engine kind to its component — the single place the chrome names
 *  an engine implementation; every member of the union needs an arm here. */
function createEngine(kind: WebFrameEngineKind): ComponentType<WebFrameEngineProps> {
  switch (kind) {
    case "iframe":
      return WebFrameIframe;
    case "native":
      return WebFrameNative;
  }
}

/** Pre-report capability seed per kind — the knowledge stays in each engine
 *  module. */
const DEFAULT_CAPABILITIES: Record<WebFrameEngineKind, WebFrameCapabilities> = {
  iframe: WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES,
  native: WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES,
};

/** Value equality for the state-report dedupe guard — engines may rebuild
 *  the capability/find objects per report, and an equal report must not
 *  re-render the chrome. */
function sameSupports(a: WebFrameCapabilities, b: WebFrameCapabilities): boolean {
  return (
    a.history === b.history &&
    a.find === b.find &&
    a.meta === b.meta &&
    a.zoomGestures === b.zoomGestures &&
    a.devtools === b.devtools
  );
}

function sameFind(a: FrameChromeState["find"], b: FrameChromeState["find"]): boolean {
  if (a === b) return true;
  return a !== null && b !== null && a.active === b.active && a.total === b.total;
}

/** Renders a web-tab family with ONE browser-chrome set and one mounted
 *  engine per tab (P3): back/forward + reload, a display/edit address bar,
 *  find, open-in-browser, a load progress line, explicit error states, and
 *  the tab strip — every chrome control bound to the ACTIVE frame's reported
 *  state. The document CustomEvents (`web-find:open`, `web-address:focus`,
 *  `web-open-external`, `web-zoom`) keep exactly one listener here, so one
 *  IframeWindow per layout stays the single receiver. The chrome renders per
 *  the engine's reported capabilities, never per origin — a renderer that
 *  does not embed has no meaningful origin answer, and per-feature flags are
 *  the only axis every engine can answer. */
export function IframeWindow({
  tabs,
  active,
  server,
  windowId,
  onWriteUrl,
  onSelectTab,
  onCloseTab,
  onAddTab,
  onMoveTab,
  onInteract,
  shouldReclaimChord,
  onPageMeta,
  webCapture = false,
}: IframeWindowProps) {
  // Engine selection: bridge presence × the per-viewer preference (the pure
  // rule shared with the palette entry). canShellWeb() is read per render —
  // the preload injects the bridge before any SPA script runs, so it is
  // stable; the read is cheap. A preference flip remounts every tab on the
  // other engine (the kind-qualified key below); the outgoing native engines
  // park their guests in cleanup (bounded by the shell's parked-set LRU —
  // a flip-back adopts them).
  const [nativeEnabled] = useLocalStorageBoolean(
    WEB_NATIVE_ENGINE_PREF_KEY,
    WEB_NATIVE_ENGINE_DEFAULT,
  );
  const engineKind = selectWebEngineKind(canShellWeb(), nativeEnabled);
  const Engine = createEngine(engineKind);
  // Content selector: the family drives everything. Onboarding (the reduced
  // live URL bar + the three fill-path instructions) renders iff the family
  // is EMPTY; with ≥1 tab every frame mounts regardless of the active slot.
  const onboarding = tabs.length === 0;
  const activeIndex = onboarding ? 0 : Math.min(Math.max(active ?? 1, 1), tabs.length);
  const url = activeIndex >= 1 ? (tabs[activeIndex - 1] ?? "") : "";
  const urlRef = useRef(url);
  urlRef.current = url;

  // ── draft tabs (viewer-local, per-tile) ─────────────────────────────────
  // Drafts are ephemeral — they live exactly as long as this tile is mounted
  // (a window switch remounts SurfaceLayout's renderContent, which drops
  // them). Enter materializes the selected draft through the add verb;
  // Esc/× discards it; multiple drafts stack. They render after all real
  // tabs and are never POSTed or synced to tmux.
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selectedDraft, setSelectedDraft] = useState<number | null>(null);
  const nextDraftIdRef = useRef(1);
  const openDraftRef = useRef<() => void>(() => {});
  const moveTabRef = useRef(onMoveTab);
  moveTabRef.current = onMoveTab;

  const [inputUrl, setInputUrl] = useState(url);
  // Edit mode (R7): at rest the address bar shows the kind-specific DISPLAY
  // form; focus reveals the raw editable value (select-all). Enter is the ONE
  // submit — routed by the ladder to a slot write (`onWriteUrl`) or an
  // append-or-focus add (`onAddTab`); Escape reverts.
  const [editing, setEditing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const interactRef = useRef(onInteract);
  interactRef.current = onInteract;
  const reclaimRef = useRef(shouldReclaimChord);
  reclaimRef.current = shouldReclaimChord;
  const pageMetaRef = useRef(onPageMeta);
  pageMetaRef.current = onPageMeta;

  // The native engine's chord table: the kind-"web" reclaim predicate
  // enumerated over the effective registry (a guest's keydowns never reach
  // this document, so the predicate cannot run at event time there). A rebind
  // re-derives the table; the iframe engine ignores the prop — its reclaim
  // runs in-document.
  const { bindings } = useKeybindings();
  // The capture latch narrows the native engine's table to the release chord;
  // the engine re-uploads on every table change, so a flip takes effect live.
  const chordTable = useMemo(
    () => buildWebChordTable(bindings, webCapture),
    [bindings, webCapture],
  );

  // ── per-frame state (P3: one chrome, N frames) ──────────────────────────
  // Each engine reports its chrome slice up; the map is keyed by URL (the
  // frame's identity — a remove-shift re-keys by URL, not slot). The chrome
  // below reads ONLY the active frame's entry.
  const [chromeStates, setChromeStates] = useState<ReadonlyMap<string, FrameChromeState>>(
    new Map(),
  );
  const [failedFavicons, setFailedFavicons] = useState<ReadonlySet<string>>(new Set());
  const handleChromeState = useCallback((frameUrl: string, state: FrameChromeState) => {
    setChromeStates((prev) => {
      const cur = prev.get(frameUrl);
      if (
        cur &&
        cur.loading === state.loading &&
        cur.trackedLocation === state.trackedLocation &&
        cur.title === state.title &&
        cur.favicon === state.favicon &&
        cur.tileError === state.tileError &&
        cur.canGoBack === state.canGoBack &&
        cur.canGoForward === state.canGoForward &&
        sameSupports(cur.supports, state.supports) &&
        sameFind(cur.find, state.find)
      ) {
        return prev;
      }
      const next = new Map(prev);
      next.set(frameUrl, state);
      return next;
    });
  }, []);
  const frameHandles = useRef(new Map<string, WebFrameEngineHandle>());
  const registerHandle = useCallback((frameUrl: string, handle: WebFrameEngineHandle) => {
    frameHandles.current.set(frameUrl, handle);
  }, []);
  const unregisterHandle = useCallback((frameUrl: string) => {
    frameHandles.current.delete(frameUrl);
  }, []);

  // Chrome-owned explicit destroys. An engine's unmount cleanup PARKS its
  // guest (retention), and the engine cannot tell "the tile went away" from
  // "this tab is gone" — but the chrome owns the family and knows exactly:
  // a URL present in the previous `tabs` and absent from the next, with the
  // tile still on the SAME window, is a tab close / URL-slot rewrite /
  // external removal, so its guest is destroyed through the registered
  // handle (engines with nothing to retain omit the verb — a no-op here).
  // Render-phase on purpose: the destroy must be issued before the outgoing
  // engine's commit-phase unmount park, and an effect would run after it;
  // the engine's handle ALSO suppresses its own park once destroy fired, so
  // the pair is order-proof. A window switch (the window key changes)
  // destroys nothing — the departing tabs' engines park on unmount and their
  // identities adopt on return.
  const windowKey = `${server}:${windowId}`;
  const familyRef = useRef({ windowKey, tabs });
  const prevFamily = familyRef.current;
  if (prevFamily.windowKey !== windowKey || prevFamily.tabs !== tabs) {
    familyRef.current = { windowKey, tabs };
    if (prevFamily.windowKey === windowKey) {
      const declared = new Set(tabs);
      for (const oldUrl of prevFamily.tabs) {
        if (!declared.has(oldUrl)) frameHandles.current.get(oldUrl)?.destroy?.();
      }
    }
  }

  const activeChrome = url !== "" ? chromeStates.get(url) : undefined;
  const activeLoading = activeChrome?.loading ?? !onboarding;
  // Before an engine's first report the chrome seeds from the engine kind's
  // declared default capabilities — the knowledge stays in the engine module;
  // the pre-report paint matches a same-origin frame's.
  const supports = activeChrome?.supports ?? DEFAULT_CAPABILITIES[engineKind];
  const canGoBack = activeChrome?.canGoBack ?? supports.history;
  const canGoForward = activeChrome?.canGoForward ?? supports.history;
  const trackedLocation = activeChrome?.trackedLocation ?? null;
  const tileError = activeChrome?.tileError ?? null;

  // Find state belongs to the active document and dies with its load: the
  // engine clears its own matches on the same load edge; the chrome resets
  // its query here.
  const handleFrameLoad = useCallback((frameUrl: string) => {
    if (frameUrl !== urlRef.current) return;
    setFindQuery("");
  }, []);

  // Header metadata follows active-frame state, not load timing: inactive
  // frames mount eagerly and may already be loaded when selected.
  useEffect(() => {
    pageMetaRef.current?.({ title: activeChrome?.title ?? null });
  }, [url, activeChrome?.title]);

  // ── content zoom (260823-cwvv R2/R3; continuous gestures 260824-iafo) ────
  // Per-viewer, per-bucket zoom level: seeded from localStorage, re-seeded
  // whenever the address's bucket changes (a proxied tile navigating ports
  // switches buckets — as does an active-tab change). Never POSTed. Two
  // trigger families: click/shortcut zoom steps the discrete ladder; GESTURES
  // write a continuous float — the Chrome/macOS pinch behavior (quantized
  // pinch visibly "clicks").
  const zoomBucket = webZoomKeyFor(url);
  const [zoom, setZoomState] = useState(() => readWebZoom(zoomBucket));
  // The mirror ref keeps persistence OUT of the setState updater — StrictMode
  // double-invokes updaters, which would duplicate localStorage writes — while
  // burst gesture events still compound correctly between renders.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomBucketRef = useRef(zoomBucket);
  // Gesture persistence is DEBOUNCED (trailing): a pinch emits dozens of
  // events and localStorage-per-event is waste. The pending write FLUSHES
  // (never drops) on bucket change and unmount, so navigating away mid-pinch
  // keeps the final value. Click-path writes stay immediate.
  const zoomPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelZoomPersist = useCallback(() => {
    if (zoomPersistTimerRef.current === null) return;
    clearTimeout(zoomPersistTimerRef.current);
    zoomPersistTimerRef.current = null;
  }, []);
  const flushZoomPersist = useCallback(() => {
    if (zoomPersistTimerRef.current === null) return;
    cancelZoomPersist();
    writeWebZoom(zoomBucketRef.current, zoomRef.current);
  }, [cancelZoomPersist]);
  useEffect(() => flushZoomPersist, [flushZoomPersist]);
  useEffect(() => {
    if (zoomBucketRef.current === zoomBucket) return;
    // The pending write belongs to the OLD bucket — flush before re-seeding.
    flushZoomPersist();
    zoomBucketRef.current = zoomBucket;
    const seeded = readWebZoom(zoomBucket);
    zoomRef.current = seeded;
    setZoomState(seeded);
  }, [zoomBucket, flushZoomPersist]);
  const applyZoom = useCallback(
    (direction: WebZoomDirection) => {
      const prev = zoomRef.current;
      const next =
        direction === "reset" ? WEB_ZOOM_DEFAULT : stepWebZoom(prev, direction);
      if (next === prev) return;
      // The immediate click-path write supersedes any pending gesture write.
      cancelZoomPersist();
      zoomRef.current = next;
      writeWebZoom(zoomBucket, next);
      setZoomState(next);
    },
    [zoomBucket, cancelZoomPersist],
  );
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;
  // The continuous gesture setter: applied per event so the frame tracks the
  // fingers, persisted on the trailing debounce.
  const applyZoomFactor = useCallback((next: number) => {
    const clamped = clampZoom(next, WEB_ZOOM_MIN, WEB_ZOOM_MAX);
    if (clamped === zoomRef.current) return;
    zoomRef.current = clamped;
    setZoomState(clamped);
    if (zoomPersistTimerRef.current !== null) clearTimeout(zoomPersistTimerRef.current);
    zoomPersistTimerRef.current = setTimeout(() => {
      zoomPersistTimerRef.current = null;
      writeWebZoom(zoomBucketRef.current, zoomRef.current);
    }, ZOOM_PERSIST_DEBOUNCE_MS);
  }, []);
  const applyZoomFactorRef = useRef(applyZoomFactor);
  applyZoomFactorRef.current = applyZoomFactor;

  // Gesture plumbing (R6/R8; continuous 260824-iafo): both listener arms (the
  // tile wrapper and the engine's content document) apply the continuous
  // mapping per event — no thresholds, no ladder (the ladder is the click
  // path's). Only ctrl/meta-modified wheel and Safari gesture* events are
  // intercepted — everything else passes through untouched. Returns the
  // teardown.
  const wireGestureListeners = useCallback(
    (target: Document | HTMLElement) => {
      // Safari's gesturechange scale is cumulative from gesturestart — capture
      // the base once per pinch and multiply; no accumulator state.
      let gestureBase = zoomRef.current;
      // Typed as Event: the listener must accept the union target's
      // (Document | HTMLElement) common signature, and a frame-document
      // WheelEvent is cross-realm (instanceof narrowing is unreliable) —
      // deltaY/ctrlKey are read defensively, same posture as gesturechange.
      const onWheel = (e: Event) => {
        const wheel = e as Partial<WheelEvent>;
        if (typeof wheel.deltaY !== "number") return;
        if (!wheel.ctrlKey && !wheel.metaKey) return;
        e.preventDefault();
        applyZoomFactorRef.current(
          applyWheelZoom(zoomRef.current, wheel.deltaY, WEB_ZOOM_MIN, WEB_ZOOM_MAX),
        );
      };
      // Safari's gesture* events are non-standard (no DOM-lib typing) — the
      // scale read narrows defensively so a foreign event can't throw.
      // gesturestart must preventDefault too: without it Safari's native
      // pinch page-zoom can engage before the first gesturechange.
      const onGestureStart = (e: Event) => {
        e.preventDefault();
        gestureBase = zoomRef.current;
      };
      const onGestureChange = (e: Event) => {
        const scale = (e as { scale?: unknown }).scale;
        if (typeof scale !== "number") return;
        e.preventDefault();
        applyZoomFactorRef.current(gestureBase * scale);
      };
      target.addEventListener("wheel", onWheel, { passive: false, capture: true });
      target.addEventListener("gesturestart", onGestureStart);
      target.addEventListener("gesturechange", onGestureChange);
      return () => {
        target.removeEventListener("wheel", onWheel, { capture: true });
        target.removeEventListener("gesturestart", onGestureStart);
        target.removeEventListener("gesturechange", onGestureChange);
      };
    },
    [],
  );

  /** The current address in RAW form: the tracked frame location when known,
   *  else the active web tab's address. The ↗ button and the edit reveal read
   *  this. */
  const rawAddress = trackedLocation ?? url;

  // ── find-in-page (260819-ie2i R5–R8) — one bar, bound to the ACTIVE
  // engine. The chrome owns only the open state and the query; the engine
  // owns matches, active index, and highlights behind its handle and reports
  // {active, total} back through its state. ─────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const findWasOpenRef = useRef(false);

  // While the bar is open, a query change or an active-url change starts a
  // fresh search on the ACTIVE engine (an empty query stops it); closing the
  // bar stops the search. Engines without find support no-op the command.
  useEffect(() => {
    const handle = frameHandles.current.get(url);
    if (!findOpen) {
      if (findWasOpenRef.current) handle?.stopFind();
      findWasOpenRef.current = false;
      return;
    }
    findWasOpenRef.current = true;
    if (!handle) return;
    if (findQuery !== "") handle.find(findQuery, { forward: true, findNext: false });
    else handle.stopFind();
  }, [findOpen, findQuery, url]);

  const stepFind = useCallback(
    (forward: boolean) => {
      frameHandles.current.get(url)?.find(findQuery, { forward, findNext: true });
    },
    [url, findQuery],
  );

  // The `web-find:open` seam (R4): the ⌘F chord handler, the palette action,
  // and any future opener dispatch one document CustomEvent; the mounted web
  // tile is its single receiver (one IframeWindow per layout, regardless of
  // tab count). Onboarding double-guard (260821-zqlq): the event sources are
  // content-gated upstream, but a stale dispatch must no-op on a contentless
  // tile — no bar, no crash.
  useEffect(() => {
    const open = () => {
      if (urlRef.current !== "") setFindOpen(true);
    };
    document.addEventListener(WEB_FIND_OPEN_EVENT, open);
    return () => document.removeEventListener(WEB_FIND_OPEN_EVENT, open);
  }, []);

  // ⌘L and `Web: Focus address bar` share one focus-only event seam.
  useEffect(() => {
    const focusAddress = () => {
      const input = addressInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    document.addEventListener(WEB_ADDRESS_FOCUS_EVENT, focusAddress);
    return () => document.removeEventListener(WEB_ADDRESS_FOCUS_EVENT, focusAddress);
  }, []);

  // The `web-tab:open-draft` seam: the palette's `Web: New tab` entry
  // dispatches one document CustomEvent; the mounted web tile opens a draft
  // and focuses its address bar (the `web-find:open` single-receiver
  // precedent). Offered whenever the web tile is open — an empty family is
  // exactly where the palette entry must still reach a draft.
  useEffect(() => {
    const open = () => openDraftRef.current();
    document.addEventListener(WEB_TAB_DRAFT_EVENT, open);
    return () => document.removeEventListener(WEB_TAB_DRAFT_EVENT, open);
  }, []);

  // The `web-open-external` seam (R9): the palette action dispatches one
  // document CustomEvent; the mounted web tile pops its CURRENT address (the
  // tracked frame location when known — it owns that state, the palette
  // doesn't). Relative addresses resolve against the viewer origin.
  useEffect(() => {
    const openExternal = () => {
      window.open(trackedLocation ?? url, "_blank", "noopener");
    };
    document.addEventListener(WEB_OPEN_EXTERNAL_EVENT, openExternal);
    return () => document.removeEventListener(WEB_OPEN_EXTERNAL_EVENT, openExternal);
  }, [trackedLocation, url]);

  // The `web-inspect` seam: the palette's `Web: Inspect page` entry
  // dispatches one document CustomEvent; the mounted web tile opens DevTools
  // on the ACTIVE tab's engine (engines without the capability no-op — the
  // entry itself is gated on the native engine upstream). Single receiver,
  // same shape as the seams above. The URL bar's Inspect button calls the
  // same handler directly.
  const handleInspect = useCallback(() => {
    frameHandles.current.get(url)?.openDevTools?.();
  }, [url]);
  useEffect(() => {
    document.addEventListener(WEB_INSPECT_EVENT, handleInspect);
    return () => document.removeEventListener(WEB_INSPECT_EVENT, handleInspect);
  }, [handleInspect]);

  // The `web-zoom` seam (R5): the three `Web: Zoom` palette actions dispatch
  // one document CustomEvent (`detail.direction`); the mounted web tile is
  // its single receiver (the `web-find:open` precedent). Onboarding
  // double-guard: the actions are content-gated upstream, but a stale
  // dispatch must no-op on a contentless tile.
  useEffect(() => {
    const onZoom = (e: Event) => {
      if (urlRef.current === "") return;
      const direction = (e as CustomEvent<{ direction?: unknown }>).detail?.direction;
      if (direction === "in" || direction === "out" || direction === "reset") {
        applyZoomRef.current(direction);
      }
    };
    document.addEventListener(WEB_ZOOM_EVENT, onZoom);
    return () => document.removeEventListener(WEB_ZOOM_EVENT, onZoom);
  }, []);

  // Zoom gestures on the tile's own chrome (R8): the URL bar, find bar, and
  // error surface are parent-document DOM, so the wrapper arm covers them —
  // the engine's arm (same-origin attach) covers the page area. Wheel over an
  // iframe never reaches the parent, so both arms are needed.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    return wireGestureListeners(wrapper);
  }, [wireGestureListeners]);

  // Autofocus on open is owned by the shared FindBar (it mounts only while
  // the bar is open and focuses its input on mount).

  // Sync the URL bar text when the active address changes externally (an SSE
  // push, a tab select, or a same-slot replace). The frame side needs no
  // sync: a changed tab URL re-keys (remounts) exactly that frame.
  useEffect(() => {
    setInputUrl(url);
    setSubmitError(null);
  }, [url]);

  const handleRefresh = useCallback(() => {
    frameHandles.current.get(url)?.reload();
  }, [url]);

  const handleRetry = useCallback(() => {
    frameHandles.current.get(url)?.retry();
  }, [url]);

  const handleBack = useCallback(() => {
    frameHandles.current.get(url)?.back();
  }, [url]);

  const handleForward = useCallback(() => {
    frameHandles.current.get(url)?.forward();
  }, [url]);

  // Open in browser (R9): the CURRENT address in a new tab — relative
  // addresses resolve naturally against the viewer's origin (stored web
  // addresses stay relative per the display contract).
  const handleOpenExternal = useCallback(() => {
    window.open(rawAddress, "_blank", "noopener");
  }, [rawAddress]);

  // Consume a resolved add: clean up the consumed draft (when the submit came
  // from one), leave edit mode, and select the returned slot — the client
  // selects because the add verb selects only an empty family ("add is not
  // show"), and its idempotent { index } makes the whole flow append-or-focus.
  const finishAdd = useCallback(
    (draftId: number | null) =>
      ({ index }: { index: number }) => {
        if (draftId !== null) {
          setDrafts((d) => d.filter((x) => x.id !== draftId));
          setSelectedDraft((s) => (s === draftId ? null : s));
        }
        setEditing(false);
        addressInputRef.current?.blur();
        return onSelectTab?.(index);
      },
    [onSelectTab],
  );

  // Surface an add rejection inline, keeping the submitted value editable —
  // a selected draft was never consumed, so it remains the retry point.
  const failAdd = useCallback(
    (target: string) => (err: unknown) => {
      addressInputRef.current?.focus();
      setInputUrl(target);
      setEditing(true);
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
    [],
  );

  // Submit through the add verb — draft materialization and the path/port
  // lanes share it. The backend stats a path target under the window's
  // worktree cwd and answers with the resolved slot or an honest 400. A 400
  // on a fallback-bearing route means a dotted single segment stats to
  // nothing (the README.md-vs-example.com fork): retry once as the https://
  // bare-domain form — a draft materializes it, a declared tab slot-writes it.
  const submitViaAdd = useCallback(
    (target: string, fallback?: string) => {
      if (!onAddTab) return;
      const draftId = selectedDraft;
      onAddTab(target)
        .then(finishAdd(draftId))
        .catch((err: unknown) => {
          if (fallback !== undefined && err instanceof ApiError && err.status === 400) {
            if (draftId !== null) {
              onAddTab(fallback).then(finishAdd(draftId)).catch(failAdd(fallback));
              return;
            }
            setEditing(false);
            addressInputRef.current?.blur();
            if (fallback === url) return;
            onWriteUrl?.(fallback)?.catch(() => setInputUrl(url));
            return;
          }
          failAdd(target)(err);
        });
    },
    [onAddTab, selectedDraft, finishAdd, failAdd, onWriteUrl, url],
  );

  const handleSubmit = useCallback(() => {
    if (inputUrl.trim() === "") return;
    const route = routeAddressSubmit(inputUrl);
    // Bare words and non-http(s) schemes surface inline and fire NO POST;
    // path-shaped input now goes to the backend resolver (the stat decides),
    // so the frontend regex no longer pre-rejects it.
    if (route.kind === "reject") {
      setSubmitError("must be an http(s) URL, a path, or :port");
      return;
    }
    setSubmitError(null);
    if (route.kind === "add") {
      submitViaAdd(route.target, route.fallback);
      return;
    }
    // Write lane — a selected draft materializes through the add verb (its
    // submitted value IS the add target); otherwise replace the active slot.
    if (selectedDraft !== null) {
      submitViaAdd(route.url);
      return;
    }
    setEditing(false);
    addressInputRef.current?.blur();
    // Same-URL submit is a no-op — re-submitting the stored address never
    // POSTs.
    if (route.url === url) return;
    onWriteUrl?.(route.url)?.catch(() => {
      // Revert input on failure
      setInputUrl(url);
    });
  }, [inputUrl, selectedDraft, submitViaAdd, onWriteUrl, url]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        // Revert to the rest display form without a POST; a selected draft
        // dies with the edit.
        e.preventDefault();
        if (selectedDraft !== null) {
          setDrafts((d) => d.filter((x) => x.id !== selectedDraft));
          setSelectedDraft(null);
        }
        setInputUrl(rawAddress);
        setSubmitError(null);
        setEditing(false);
        addressInputRef.current?.blur();
      }
    },
    [handleSubmit, rawAddress, selectedDraft],
  );

  // openDraft / discardDraft sit below the refs/state they touch; the seam
  // listener binds the ref once. The plus button and the double-click gesture
  // share this one entry.
  function openDraft() {
    const id = nextDraftIdRef.current++;
    setDrafts((d) => [...d, { id }]);
    setSelectedDraft(id);
    setInputUrl("");
    setSubmitError(null);
    setEditing(false);
    setTimeout(() => {
      const input = addressInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }
  function discardDraft(id: number) {
    setDrafts((d) => d.filter((x) => x.id !== id));
    setSelectedDraft((s) => (s === id ? null : s));
  }
  openDraftRef.current = openDraft;

  // Select-all once edit mode's raw value has rendered (the focus event fires
  // with the DISPLAY value still in the input — the selection must wait a
  // commit).
  useEffect(() => {
    if (editing) addressInputRef.current?.select();
  }, [editing]);

  // ── tab strip: always rendered with the tile — at 0 tabs/0 drafts it is
  // just the `+`, so the empty family keeps a draft entry point (onboarding
  // is the empty-family CONTENT below, not a stripless chrome variant).
  // Roving-focus tablist: only the ACTIVE tab is in the
  // tab order, ←/→/Home/End move focus without writing, Enter/Space select,
  // Delete/Backspace close, ⌥⇧←/⌥⇧→ reorder the active tab. Drafts are
  // shown dashed after the real tabs and are never drag targets/sources.
  // Focused-but-not-active is a viewer posture. ────────────────────────────
  const coarsePointer = useCoarsePointer();
  const tabRefs = useRef(new Map<number, HTMLElement>());
  const [focusedTab, setFocusedTab] = useState(0); // 0 = none
  useEffect(() => {
    if (focusedTab < 1 || focusedTab > tabs.length) return;
    tabRefs.current.get(focusedTab)?.focus();
  }, [focusedTab, tabs.length]);
  const stripFull = tabs.length >= WEB_TAB_FAMILY_CAP;

  // Pointer-based drag-to-reorder: a sub-threshold pointer movement stays a
  // click (select); past the threshold the drag's drop side reads the hovered
  // half, and pointerup commits exactly one move via onMoveTab. Drafts are
  // never drag targets/sources, and the pointerup click is suppressed after
  // a real drag so `onSelectTab` doesn't fire twice.
  const dragRef = useRef<{
    from: number;
    startX: number;
    pointerId: number;
    source: Element;
    active: boolean;
    target: { index: number; side: "left" | "right" } | null;
  } | null>(null);
  const clickSuppressRef = useRef(false);
  const [dropTarget, setDropTarget] = useState<{ index: number; side: "left" | "right" } | null>(null);
  const tabAtPointerPoint = (clientX: number, clientY: number, fallback: number | null) => {
    // Pointer capture retargets move/up events to the source tab. Hit-test the
    // actual pointer position so the indicator still follows sibling tabs and
    // release over strip space/outside cancels. jsdom has no elementFromPoint,
    // so component tests use the event receiver as the fallback.
    if (typeof document.elementFromPoint !== "function") return fallback;
    const hit = document.elementFromPoint(clientX, clientY);
    const tab = hit?.closest<HTMLElement>('[data-testid="web-tab"]');
    if (!tab) return null;
    const index = Number(tab.dataset.index);
    return Number.isInteger(index) && tabRefs.current.get(index) === tab ? index : null;
  };
  const handleTabPointerDown = (n: number, e: React.PointerEvent) => {
    // The close button owns its full pointer sequence. Capturing its down on
    // the parent tab would retarget the eventual click and select instead of
    // close in real browsers.
    if (
      !onMoveTab ||
      e.button !== 0 ||
      (e.target instanceof Element && e.target.closest("button") !== null)
    ) {
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      from: n,
      startX: e.clientX,
      pointerId: e.pointerId,
      source: e.currentTarget,
      active: false,
      target: null,
    };
  };
  const handleTabPointerMove = (n: number, e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !onMoveTab) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
      drag.active = true;
    }
    e.preventDefault();
    const hovered = tabAtPointerPoint(e.clientX, e.clientY, n);
    if (hovered === null) {
      drag.target = null;
      setDropTarget(null);
      return;
    }
    // The drop side follows the hovered half of the nearest target.
    const rect = tabRefs.current.get(hovered)?.getBoundingClientRect();
    let side: "left" | "right" = "left";
    if (rect && e.clientX - rect.left >= rect.width / 2) side = "right";
    drag.target = { index: hovered, side };
    setDropTarget(drag.target);
  };
  const handleTabPointerLeave = (n: number) => {
    const drag = dragRef.current;
    if (!drag?.active || drag.target?.index !== n) return;
    drag.target = null;
    setDropTarget(null);
  };
  const finishTabDrag = useCallback((e: PointerEvent, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    setDropTarget(null);
    if (drag.source.hasPointerCapture?.(drag.pointerId)) {
      drag.source.releasePointerCapture(drag.pointerId);
    }
    if (cancelled || !drag.active) return;
    e.preventDefault();
    if (tabAtPointerPoint(e.clientX, e.clientY, drag.target?.index ?? null) === null) return;
    clickSuppressRef.current = true;
    setTimeout(() => {
      clickSuppressRef.current = false;
    }, 0);
    // Convert the target edge into the moved tab's final 1-based position.
    const target = drag.target;
    if (!target) return;
    const insertion = target.side === "right" ? target.index + 1 : target.index;
    const to = drag.from < insertion ? insertion - 1 : insertion;
    if (to === drag.from) return;
    moveTabRef.current?.(drag.from, to);
  }, []);

  // Pointer capture keeps the drag lifecycle alive when the pointer leaves
  // its source tab; window listeners guarantee both release and cancellation
  // clear the ref/indicator even over strip space or outside the tile.
  useEffect(() => {
    const up = (e: PointerEvent) => finishTabDrag(e, false);
    const cancel = (e: PointerEvent) => finishTabDrag(e, true);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragRef.current = null;
    };
  }, [finishTabDrag]);

  const handleTabKeyDown = (e: React.KeyboardEvent) => {
    const count = tabs.length;
    if (count === 0) return;
    const current = focusedTab >= 1 && focusedTab <= count ? focusedTab : activeIndex;
    // Component-local reorder keys (the registry rejects Alt chords — "no
    // tier"; the strip's roving handler owns this territory): ⌥⇧←/⌥⇧→ move
    // the active tab one slot left/right; a boundary press is a silent no-op.
    if (e.altKey && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const to = e.key === "ArrowLeft" ? activeIndex - 1 : activeIndex + 1;
      if (to >= 1 && to <= count) {
        setFocusedTab(to);
        onMoveTab?.(activeIndex, to);
      }
      return;
    }
    let next = 0;
    switch (e.key) {
      case "ArrowLeft":
        next = Math.max(1, current - 1);
        break;
      case "ArrowRight":
        next = Math.min(count, current + 1);
        break;
      case "Home":
        next = 1;
        break;
      case "End":
        next = count;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        // Same draft-deselection rule as the tab click path.
        setSelectedDraft(null);
        onSelectTab?.(current);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        onCloseTab?.(current);
        return;
      default:
        return;
    }
    e.preventDefault();
    setFocusedTab(next);
  };

  return (
    <div ref={wrapperRef} className="flex flex-col flex-1 min-h-0">
      <TipGroup>
        <div
          role="tablist"
          data-testid="web-tab-strip"
          onDoubleClick={(e) => {
            // Double-click on empty strip space opens a draft (Chrome
            // muscle memory) — the same path as the `+` button.
            if (e.target === e.currentTarget) openDraftRef.current();
          }}
          className="shrink-0 flex items-stretch gap-px px-1 border-b border-border bg-bg-primary overflow-x-auto font-mono text-[11px] select-none"
        >
          {tabs.map((tabUrl, i) => {
            const n = i + 1;
            const isActive = n === activeIndex;
            const kind = classifyAddress(tabUrl);
            const chrome = chromeStates.get(tabUrl);
            const label = chrome?.title ?? (webTabTitle(tabUrl) || `#${n}`);
            // Favicon: kind-dot fallback classes for absent/failed URLs; on
            // load failure the spinner stays hidden and the kind-dot renders.
            const faviconUrl =
              chrome?.favicon ??
              (kind === "external" ? externalFavicon(tabUrl) : null);
            const faviconFailureKey = faviconUrl ? `${tabUrl}\u0000${faviconUrl}` : null;
            const showFavicon =
              faviconUrl !== null &&
              faviconFailureKey !== null &&
              !failedFavicons.has(faviconFailureKey);
            const showSpinner = chrome?.loading === true;
            const indicatorHere =
              dropTarget?.index === n
                ? dropTarget.side
                : null;
            return (
              <div
                key={tabUrl}
                ref={(el) => {
                  if (el) tabRefs.current.set(n, el);
                  else tabRefs.current.delete(n);
                }}
                role="tab"
                aria-selected={isActive && selectedDraft === null}
                data-testid="web-tab"
                data-index={n}
                tabIndex={isActive && selectedDraft === null ? 0 : -1}
                title={displayForm(tabUrl)}
                onClick={() => {
                  if (clickSuppressRef.current) {
                    clickSuppressRef.current = false;
                    return;
                  }
                  // Selecting a real tab deselects any draft — the draft's
                  // deactivation of every frame ends and this tab's frame
                  // (still mounted) re-activates.
                  setSelectedDraft(null);
                  onSelectTab?.(n);
                }}
                onFocus={() => setFocusedTab(n)}
                onKeyDown={handleTabKeyDown}
                onPointerDown={(e) => handleTabPointerDown(n, e)}
                onPointerMove={(e) => handleTabPointerMove(n, e)}
                onPointerLeave={() => handleTabPointerLeave(n)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    onCloseTab?.(n);
                  }
                }}
                className={`group relative flex items-center gap-1.5 px-2 py-1 cursor-pointer outline-none ${
                  isActive
                    ? "bg-bg-primary text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {indicatorHere === "right" && (
                  <span
                    data-testid="web-tab-drop-indicator"
                    className="absolute right-0 top-0 bottom-0 w-0.5 bg-accent-green"
                  />
                )}
                {indicatorHere === "left" && (
                  <span
                    data-testid="web-tab-drop-indicator"
                    className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent-green"
                  />
                )}
                {showSpinner ? (
                  <span
                    aria-hidden="true"
                    data-testid="web-tab-spinner"
                    className="rk-web-spinner shrink-0 inline-block h-3 w-3 rounded-full border border-accent-green/70 border-t-transparent"
                  />
                ) : showFavicon ? (
                  <img
                    src={faviconUrl}
                    alt=""
                    aria-hidden="true"
                    className="rk-web-icon shrink-0 h-3.5 w-3.5 rounded-sm"
                    onError={() => {
                      if (!faviconFailureKey) return;
                      setFailedFavicons((prev) => {
                        if (prev.has(faviconFailureKey)) return prev;
                        const next = new Set(prev);
                        next.add(faviconFailureKey);
                        return next;
                      });
                    }}
                  />
                ) : kind !== "relative" ? (
                  <span
                    aria-hidden="true"
                    className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${KIND_DOT_CLASS[kind]}`}
                  />
                ) : null}
                <span className="whitespace-nowrap">{label}</span>
                {onCloseTab && (
                  <button
                    type="button"
                    aria-label={`Close web tab ${n}`}
                    data-testid="web-tab-close"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(n);
                    }}
                    className={`shrink-0 rounded px-0.5 hover:text-text-primary ${
                      isActive || coarsePointer
                        ? ""
                        : "invisible group-hover:visible group-focus-within:visible"
                    }`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {drafts.map((draft, idx) => {
            const isSelected = draft.id === selectedDraft;
            return (
              <div
                key={draft.id}
                role="tab"
                aria-selected={isSelected}
                data-testid="web-tab-draft"
                data-draft-id={draft.id}
                tabIndex={isSelected ? 0 : -1}
                title="New tab — Enter materializes it, Esc discards"
                onClick={() => {
                  setSelectedDraft(draft.id);
                  setInputUrl("");
                  setSubmitError(null);
                  setTimeout(() => addressInputRef.current?.focus(), 0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedDraft(draft.id);
                    setInputUrl("");
                    setSubmitError(null);
                    setTimeout(() => addressInputRef.current?.focus(), 0);
                  }
                }}
                className={`group flex items-center gap-1.5 px-2 py-1 cursor-pointer outline-none border-b-2 border-dashed ${
                  isSelected
                    ? "border-text-secondary text-text-primary"
                    : "border-border/60 text-text-secondary hover:text-text-primary"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-text-secondary/60"
                />
                <span className="whitespace-nowrap">{`new tab ${idx + 1}`}</span>
                <button
                  type="button"
                  aria-label={`Discard new tab ${idx + 1}`}
                  data-testid="web-tab-draft-close"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    discardDraft(draft.id);
                  }}
                  className="shrink-0 rounded px-0.5 hover:text-text-primary"
                >
                  ×
                </button>
              </div>
            );
          })}
          {onAddTab && (
            <Tip label={stripFull ? `web tabs full (${WEB_TAB_FAMILY_CAP})` : undefined} placement="top">
              <button
                type="button"
                aria-label="Add web tab from address"
                data-testid="web-tab-add"
                disabled={stripFull}
                // Keep the address bar's focus (and its draft) through the
                // click — a blur would revert the input to the rest value.
                onMouseDown={(e) => e.preventDefault()}
                onClick={openDraft}
                className="self-center shrink-0 w-6 h-6 mx-1 flex items-center justify-center rounded text-text-secondary enabled:hover:bg-bg-inset enabled:hover:text-text-primary disabled:opacity-50"
              >
                +
              </button>
            </Tip>
          )}
        </div>
      </TipGroup>

      {/* URL Bar — one warm-tip cluster (260722-73al). Button order per the
          approved design study: ◀ ▶ ↻ [address] ⌕ − % + <> ↗ (`<>` Inspect
          renders only on an engine reporting `supports.devtools`; the `>_` switch-to-
          terminal button was removed, 260819-v6y4 R13 — the top-bar surface
          toggles own view switching). Every Tip here (and the strip's above)
          flips UPWARD (placement="top"): a bottom-placed tip would render
          where the native engine's guest view is composited over the DOM and
          be clipped by it — clipping geometry is reserved for overlays that
          straddle the content rect, and none of these do. */}
      <TipGroup>
      <div className="flex items-center gap-1.5 px-2 h-[35px] border-b border-border bg-bg-primary shrink-0">
        {!onboarding && supports.history && (
          <>
            <Tip label="Back" placement="top">
              <button
                onClick={handleBack}
                disabled={!canGoBack}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-text-secondary enabled:hover:bg-bg-card enabled:hover:text-text-primary disabled:opacity-50"
                aria-label="Back"
              >
                <WebBackGlyph />
              </button>
            </Tip>
            <Tip label="Forward" placement="top">
              <button
                onClick={handleForward}
                disabled={!canGoForward}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-text-secondary enabled:hover:bg-bg-card enabled:hover:text-text-primary disabled:opacity-50"
                aria-label="Forward"
              >
                <WebForwardGlyph />
              </button>
            </Tip>
          </>
        )}
        <Tip label="Refresh" placement="top">
          <button
            onClick={handleRefresh}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card text-text-secondary hover:text-text-primary"
            aria-label="Refresh"
          >
            <RefreshGlyph />
          </button>
        </Tip>
        <input
          ref={addressInputRef}
          type="text"
          value={selectedDraft !== null ? inputUrl : editing ? inputUrl : displayForm(rawAddress)}
          placeholder={
            selectedDraft !== null
              ? "type an address — Enter opens the tab, Esc discards"
              : onboarding
                ? "localhost:3000 · /present/… · https://…"
                : undefined
          }
          onChange={(e) => {
            setInputUrl(e.target.value);
            setSubmitError(null);
          }}
          onFocus={() => {
            setInputUrl(selectedDraft === null ? rawAddress : "");
            setEditing(true);
          }}
          onBlur={() => {
            setEditing(false);
            setSubmitError(null);
            setSelectedDraft(null);
            setInputUrl(rawAddress);
          }}
          onKeyDown={handleKeyDown}
          className={`flex-1 min-w-0 bg-bg-card text-text-primary text-sm px-2 h-[28px] py-0 rounded border border-border ${INPUT_FOCUS}`}
          aria-label="URL"
          aria-invalid={submitError !== null}
          spellCheck={false}
        />
        {submitError && (
          <span role="alert" className="shrink-0 text-signal-red text-xs select-none">
            {submitError}
          </span>
        )}
        {!onboarding && (
          <>
            <Tip label="Find in page" placement="top">
              <button
                onClick={() => setFindOpen((o) => !o)}
                className={`shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card hover:text-text-primary ${findOpen ? "text-accent-green" : "text-text-secondary"}`}
                aria-label="Find in page"
                aria-pressed={findOpen}
              >
                <FindGlyph />
              </button>
            </Tip>
            {/* Content zoom (R4) — the universal floor trigger: the only one
                that works over an external frame (gestures never cross the
                boundary). Text glyphs per the URL-bar vocabulary; the readout
                doubles as the reset affordance, enabled only when s ≠ 1. */}
            <div className="shrink-0 flex items-center" data-testid="web-zoom-control">
              <Tip label="Zoom out" placement="top">
                <button
                  onClick={() => applyZoom("out")}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card text-text-secondary hover:text-text-primary"
                  aria-label="Zoom out"
                >
                  −
                </button>
              </Tip>
              <Tip label={zoom === 1 ? "Zoom 100%" : "Reset zoom"} placement="top">
                <button
                  onClick={() => applyZoom("reset")}
                  disabled={zoom === 1}
                  className="h-7 min-w-11 px-1 flex items-center justify-center rounded text-xs tabular-nums text-text-secondary enabled:hover:bg-bg-card enabled:hover:text-text-primary disabled:opacity-60"
                  aria-label="Reset zoom"
                >
                  {Math.round(zoom * 100)}%
                </button>
              </Tip>
              <Tip label="Zoom in" placement="top">
                <button
                  onClick={() => applyZoom("in")}
                  className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card text-text-secondary hover:text-text-primary"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </Tip>
            </div>
            {supports.devtools && (
              <Tip label="Inspect page" placement="top">
                <button
                  onClick={handleInspect}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card text-text-secondary hover:text-text-primary"
                  aria-label="Inspect page"
                >
                  <InspectGlyph />
                </button>
              </Tip>
            )}
            <Tip label="Open in browser" placement="top">
              <button
                onClick={handleOpenExternal}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded hover:bg-bg-card text-text-secondary hover:text-text-primary"
                aria-label="Open in browser"
              >
                <OpenExternalGlyph />
              </button>
            </Tip>
          </>
        )}
      </div>
      </TipGroup>

      {/* Find bar (260819-ie2i R5/R7) — a row below the URL bar per the
          approved design study (state 03), rendered by the shared FindBar;
          the ACTIVE engine owns the search mechanism behind its handle and
          reports {active, total} back through its state. An engine without
          find support renders it disabled with the hint. */}
      {findOpen && !onboarding && (
        <FindBar
          query={findQuery}
          matchIndex={activeChrome?.find?.active ?? 0}
          matchCount={activeChrome?.find?.total ?? 0}
          onQueryChange={setFindQuery}
          onNext={() => stepFind(true)}
          onPrev={() => stepFind(false)}
          onClose={() => setFindOpen(false)}
          disabled={!supports.find}
          statusText={!supports.find ? "page is cross-origin — find unavailable" : undefined}
          placeholder="Find in page"
          testId="web-find-bar"
        />
      )}

      {/* Load progress line (R11): the 2px indeterminate sweep on the
          content's top edge while the ACTIVE frame loads; zeroed under
          prefers-reduced-motion (globals.css). */}
      {activeLoading && !onboarding && <div className="rk-web-progress" data-testid="web-load-progress" />}

      {/* Error states (R8) render in place of the ACTIVE frame's VISIBLE
          area (the engine keeps its frame mounted but hidden so its
          listeners survive a Retry). Copy per the approved design study
          (states 05/06). */}
      {tileError && (
        <div
          className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2.5 text-center px-6"
          data-testid="web-tile-error"
        >
          <span className="text-2xl text-text-secondary select-none" aria-hidden="true">
            {tileError.kind === "refused" ? "⊘" : "⚡"}
          </span>
          <span className="text-text-primary text-sm">
            {tileError.kind === "refused"
              ? `${tileError.host} refuses embedding`
              : tileError.kind === "unreachable"
                ? `${tileError.host} can't be reached`
                : `nothing listening on :${tileError.port}`}
          </span>
          <span className="text-text-secondary text-xs">
            {tileError.kind === "refused"
              ? `${tileError.reason} — this site can't render inside a tile`
              : tileError.kind === "unreachable"
                ? tileError.reason
                : "connection refused — the dev server may have stopped"}
          </span>
          {tileError.kind === "dead-port" ? (
            <button
              onClick={handleRetry}
              className="mt-1 px-3.5 h-[30px] rounded border border-border text-accent-green text-sm hover:bg-bg-card"
              aria-label="Retry"
            >
              ↻ Retry
            </button>
          ) : (
            <button
              onClick={handleOpenExternal}
              className="mt-1 px-3.5 h-[30px] rounded border border-border text-accent-green text-sm hover:bg-bg-card"
              aria-label="Open in browser"
            >
              Open in browser ↗
            </button>
          )}
        </div>
      )}

      {/* Onboarding (260821-zqlq): an EMPTY web-tab family selects this
          content state in place of the frames + probe machinery — the web
          lens is always tileable, and this panel is its discoverability
          surface. Copy per the user-approved mock. The address bar above
          stays fully live: an Enter submit boots the tile for real. */}
      {onboarding ? (
        <div
          className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 px-6 py-6 bg-bg-primary overflow-y-auto"
          data-testid="web-tile-onboarding"
        >
          <span
            className="text-[26px] tracking-widest text-text-secondary/55 select-none mb-2"
            aria-hidden="true"
          >
            ://
          </span>
          <span className="text-text-primary text-[13px]">Nothing to show yet</span>
          <span className="text-text-secondary text-[11px] text-center mb-5">
            this tile follows the window&apos;s active web tab (@rk_win_web_N) — three ways to fill it:
          </span>
          <div className="flex flex-col gap-3 w-full max-w-[440px]">
            <div className="flex gap-2.5 items-start">
              <span className="w-[22px] shrink-0 text-center text-accent-green text-xs pt-px select-none" aria-hidden="true">
                ❯
              </span>
              <span className="text-text-secondary text-[11.5px] leading-relaxed">
                <b className="text-text-primary font-semibold">Ask your agent to show something.</b>{" "}
                &quot;Present this as a page&quot; — the agent runs{" "}
                <code className="bg-bg-inset border border-border rounded px-[5px] text-[10.5px] text-text-primary whitespace-nowrap">
                  rk present ./report.html
                </code>{" "}
                and it appears here. Works for HTML files, diagrams, mocks, directories.
              </span>
            </div>
            <div className="flex gap-2.5 items-start">
              <span className="w-[22px] shrink-0 text-center text-accent-green text-xs pt-px select-none" aria-hidden="true">
                ⇄
              </span>
              <span className="text-text-secondary text-[11.5px] leading-relaxed">
                <b className="text-text-primary font-semibold">Preview a dev server.</b> Type{" "}
                <code className="bg-bg-inset border border-border rounded px-[5px] text-[10.5px] text-text-primary whitespace-nowrap">
                  localhost:3000
                </code>{" "}
                in the address bar above (proxied through HexoKit, works from any device) — or have the agent run{" "}
                <code className="bg-bg-inset border border-border rounded px-[5px] text-[10.5px] text-text-primary whitespace-nowrap">
                  rk present :3000
                </code>
                .
              </span>
            </div>
            <div className="flex gap-2.5 items-start">
              <span className="w-[22px] shrink-0 text-center text-accent-green text-xs pt-px select-none" aria-hidden="true">
                ↗
              </span>
              <span className="text-text-secondary text-[11.5px] leading-relaxed">
                <b className="text-text-primary font-semibold">Open any URL.</b> Type an address above — external
                sites embed when they allow it; find-in-page (⌘F) and back/forward work on same-origin pages.
              </span>
            </div>
          </div>
          <span className="text-text-secondary/75 text-[10px] text-center mt-5">
            the tile goes live automatically when an address lands{" "}
            <span className="text-accent-green" aria-hidden="true">●</span> no reload needed
          </span>
        </div>
      ) : (
        // Scale wrapper (R2): the ACTIVE frame renders at 1/s of the tile
        // scaled back up by s, so the guest's CSS viewport shrinks/grows like
        // real browser zoom — responsive layouts adapt, and the mechanism
        // works for every address kind without reaching into the guest
        // document. At s = 1 no transform is applied — identical layout to
        // before. Every tab's frame stays mounted (P3 — hidden, never
        // unmounted); a selection change re-keys nothing and rewrites no src.
        // A selected draft activates NO frame — the previous page stays
        // mounted underneath, hidden — and the blank new-tab panel paints
        // over the wrapper.
        <div
          className="relative flex-1 min-h-0 overflow-hidden"
          data-testid="web-zoom-frame-wrapper"
          data-zoom={zoom}
        >
          {tabs.map((tabUrl, i) => (
            <Engine
              key={`${engineKind}:${tabUrl}`}
              url={tabUrl}
              active={selectedDraft === null && i + 1 === activeIndex}
              zoom={zoom}
              wireGestureListeners={wireGestureListeners}
              onState={handleChromeState}
              onLoad={handleFrameLoad}
              registerHandle={registerHandle}
              unregisterHandle={unregisterHandle}
              interactRef={interactRef}
              reclaimRef={reclaimRef}
              onZoomStep={applyZoom}
              chordTable={chordTable}
              // The native engine's retention identity = scope + slot URL;
              // absent scope ⇒ the guest destroys on unmount (no retention).
              retentionScope={
                server !== undefined && windowId !== undefined
                  ? { server, windowId }
                  : undefined
              }
            />
          ))}
          {selectedDraft !== null && (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-6 py-6 bg-bg-primary"
              data-testid="web-draft-panel"
            >
              <span
                className="text-[26px] tracking-widest text-text-secondary/55 select-none mb-2"
                aria-hidden="true"
              >
                ://
              </span>
              <span className="text-text-primary text-[13px]">New tab</span>
              <span className="text-text-secondary text-[11px] text-center">
                type an address above — Enter opens it here, Esc discards
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tab-strip kind dot — the tile-header badge hues (green present / yellow
 *  proxy / blue external); the relative kind renders no dot. */
const KIND_DOT_CLASS: Record<AddressKind, string> = {
  present: "bg-accent-green",
  proxy: "bg-signal-yellow",
  external: "bg-signal-blue",
  relative: "",
};
