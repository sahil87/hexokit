/**
 * The native web-frame engine — the web tile's content rendered by the
 * desktop shell's Chromium (`WebContentsView`) instead of an `<iframe>`.
 *
 * Constraints the code cannot show:
 *
 * - The guest view is a NATIVE LAYER composited above the SPA's DOM (a
 *   sibling of the host view on the window's `contentView`): nothing the SPA
 *   draws can appear over it, so the engine hides it while an occluding
 *   overlay is open (modal-class surfaces and click-opened menus/popovers),
 *   while the chrome's error surface is up (`tileError`), and
 *   keeps the placeholder painted underneath.
 * - The relay subscription MUST be disposed with the engine — a listener
 *   that outlives its mount re-fires every relayed event once per leak. The
 *   bridge's `onEvent` returns the disposer and this engine's mount-effect
 *   cleanup calls it; events are demuxed by `tabKey` before any state
 *   update.
 * - Retention: unmount PARKS the guest (hidden, renderer alive) keyed by the
 *   stable identity sent at create — a same-identity remount ADOPTS it (the
 *   shell re-reports title/favicon/url/loading through the normal relay, so
 *   no SPA-side adopt path exists beyond subscribing before create). Only
 *   the chrome knows when a tab DIES (close, URL-slot rewrite), so the
 *   registered handle's `destroy` verb destroys immediately AND suppresses
 *   the cleanup's park; an older shell without `web.park` destroys on
 *   unmount exactly as before retention.
 * - Mid-drag rule depends on the drag posture: a sash/intersection drag
 *   (`resize`) live-resizes — bounds go out on every animation frame and the
 *   guest is never hidden; a tile header drag (`move`) HIDES the guest for
 *   the drag's duration, because the drop overlay previews the result tree
 *   and the composited guest would paint over it.
 * - Bounds are sent whether or not the guest is visible — the shell parks
 *   them while hidden and applies them on show, so the engine never
 *   withholds a rect.
 * - Coordinates are identity-mapped: the host view fills the window content
 *   area, so `getBoundingClientRect()` viewport coordinates ARE host-view
 *   coordinates; no offset is added.
 * - Zoom: the SPA's localStorage buckets are the source of truth (Chromium's
 *   per-host zoom store inside the guest partition persists and leaks across
 *   views), so the engine re-sends the factor on EVERY `url` relay; the
 *   guest's own ctrl-wheel gesture arrives as a direction-only relay that
 *   steps the bucket through `onZoomStep` — main never applies it.
 * - Chords: a guest's keydowns never reach this document, so the reclaim
 *   predicate cannot run at event time — the chrome enumerates it into
 *   `chordTable`, main matches and hops focus, and the engine re-dispatches
 *   the relayed chord here WITHOUT consulting `reclaimRef` (the table already
 *   IS the predicate, and Escape is not a registry chord).
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import {
  canParkShellWebView,
  createShellWebView,
  destroyShellWebView,
  findShellWebView,
  goBackShellWebView,
  goForwardShellWebView,
  onShellWebEvent,
  openShellWebViewDevTools,
  parkShellWebView,
  reloadShellWebView,
  setShellWebViewBounds,
  setShellWebViewChords,
  setShellWebViewVisible,
  setShellWebViewZoom,
  shellWebMode,
  stopFindShellWebView,
  type ShellWebEvent,
  type ShellWebRect,
} from "@/lib/shell";
import { isOccludingOpen, subscribe } from "@/lib/overlay-presence";
import { useTileDragPosture } from "@/lib/tile-drag-context";
import { toNativeSrc } from "@/lib/web-url";
import {
  tileErrorForGuestFailure,
  tileErrorForGuestResponse,
} from "@/lib/web-native-errors";
import {
  redispatchChord,
  type TileError,
  type WebFrameCapabilities,
  type WebFrameEngineProps,
} from "@/lib/web-frame-engine";

/** The capabilities the native engine reports — the parity set: every chrome
 *  control works on this engine, and find/devtools pass the iframe engine
 *  (cross-origin find, a real DevTools window). */
export const WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES: WebFrameCapabilities = {
  history: true,
  find: true,
  meta: true,
  zoomGestures: true,
  devtools: true,
};

// Unique under the host webContents (one SPA renderer, one counter), within
// the shell's 128-char tabKey bound, and fresh per engine mount so a
// StrictMode replay or a kind flip never reuses a key.
let mountSeq = 0;

/** Root-relative form for same-origin URLs (the iframe engine's display
 *  convention, so `displayForm` sees the same shape); the absolute URL for
 *  anything else — the address bar then shows where the guest navigated. An
 *  unparsable string is stored raw. */
function toTracked(absolute: string): string {
  try {
    const parsed = new URL(absolute);
    if (parsed.origin === window.location.origin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return absolute;
  } catch {
    return absolute;
  }
}

/** One mounted web tab behind the native bridge (P3 — hide, never unmount):
 *  owns no content document; the guest view paints over the placeholder,
 *  whose rect IS the guest's bounds. */
export function WebFrameNative({
  url,
  active,
  zoom,
  onState,
  onLoad,
  registerHandle,
  unregisterHandle,
  interactRef,
  onZoomStep,
  chordTable,
  retentionScope,
}: WebFrameEngineProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const tabKeyRef = useRef<string | null>(null);
  if (tabKeyRef.current === null) {
    tabKeyRef.current = `web-${++mountSeq}`;
  }
  const tabKey = tabKeyRef.current;

  // The stable retention identity: names "this web tab as shown in this
  // desktop window" — the desktop window + host are prefixed main-side (from
  // the sender's host view), so the SPA side is the tmux server + tmux window
  // id + the SLOT url, NUL-joined (the faviconFailureKey separator — none of
  // the three fields can carry a NUL). The slot prop, never the tracked
  // location: a guest's in-page navigation must not change its identity. No
  // scope ⇒ no identity ⇒ the guest can never park (main destroys
  // identity-less entries).
  const identity = retentionScope
    ? `${retentionScope.server}\u0000${retentionScope.windowId}\u0000${url}`
    : undefined;

  // The create issues a load, so the engine reports loading until the relay
  // says otherwise.
  const [loading, setLoading] = useState(true);
  const [trackedLocation, setTrackedLocation] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [find, setFind] = useState<{ active: number; total: number } | null>(null);
  const [tileError, setTileError] = useState<TileError | null>(null);
  // Set by measure(): a zero-size rect (hidden tab, collapsed tile) feeds the
  // visibility rule instead of the bridge.
  const [rectNonZero, setRectNonZero] = useState(false);

  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomStepRef = useRef(onZoomStep);
  onZoomStepRef.current = onZoomStep;
  const chordTableRef = useRef(chordTable);
  chordTableRef.current = chordTable;

  const lastSentBoundsRef = useRef<ShellWebRect | null>(null);
  const lastSentVisibleRef = useRef<boolean | null>(null);
  const rafRef = useRef<number | null>(null);
  // True once the create has resolved. Main's per-tab channels reject every
  // call before the guest exists ("Unknown tab"), and the create lands only
  // after the host-mode query + proxy settle (a tunnel probe in remote-native
  // mode), so a mount-time bounds/visible send is ALWAYS dropped — and with
  // the dedupe refs recording it as sent, never re-sent until the rect
  // changes (the guest sat at main's 0×0 default until a window resize).
  // Until then measure() and the visibility effect only track state; the
  // post-create block sends the current rect and visibility.
  const createdRef = useRef(false);
  // The latest visibility rule, for the post-create send (the effect that
  // normally sends it has already run and been skipped).
  const wantVisibleRef = useRef(false);

  const measure = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const domRect = el.getBoundingClientRect();
    const rect: ShellWebRect = {
      x: Math.round(domRect.x),
      y: Math.round(domRect.y),
      width: Math.round(domRect.width),
      height: Math.round(domRect.height),
    };
    if (rect.width <= 0 || rect.height <= 0) {
      setRectNonZero(false);
      return;
    }
    setRectNonZero(true);
    if (!createdRef.current) return;
    const last = lastSentBoundsRef.current;
    if (
      last !== null &&
      last.x === rect.x &&
      last.y === rect.y &&
      last.width === rect.width &&
      last.height === rect.height
    ) {
      return;
    }
    lastSentBoundsRef.current = rect;
    void setShellWebViewBounds(tabKey, rect);
  }, [tabKey]);

  // Mount effect (mount-scoped — the chrome re-keys by url, so a url change
  // is a remount): subscribe FIRST so no early relay is missed (an adopt's
  // state replay lands immediately after the create resolves), then query
  // the host's web mode and create the guest with the mode-aware load target
  // (literal loopback URLs in `direct`/`proxy`; today's host-absolute
  // `/proxy/N` form in `legacy`), then register the command handle. The
  // cleanup tears all three down and cancels a still-pending create — an
  // unmount during the mode await must not create a guest.
  useEffect(() => {
    let cancelled = false;
    // Set when the chrome destroys this tab through the handle (tab close /
    // URL-slot rewrite): the cleanup must NOT park a tab that is gone.
    let chromeDestroyed = false;
    createdRef.current = false;
    const dispose = onShellWebEvent((event: ShellWebEvent) => {
      // Demux before ANY state update: an event for another tab is dropped.
      if (event.tabKey !== tabKey) return;
      switch (event.kind) {
        case "title":
          setTitle(event.title === "" ? null : event.title);
          break;
        case "favicon":
          setFavicon(event.favicons[0] ?? null);
          break;
        case "loading":
          // A load start supersedes any stale error surface.
          if (event.loading) setTileError(null);
          setLoading(event.loading);
          if (!event.loading) {
            // Find state dies with the document it matched in (the iframe
            // engine's per-load reset); the onLoad edge carries the chrome's
            // find-query reset.
            setFind(null);
            onLoadRef.current(url);
          }
          break;
        case "url": {
          setTrackedLocation(toTracked(event.url));
          setCanGoBack(event.canGoBack);
          setCanGoForward(event.canGoForward);
          // Re-apply the bucket on every navigation — Chromium's per-host
          // zoom store in the guest partition would otherwise fight it.
          void setShellWebViewZoom(tabKey, zoomRef.current);
          // did-navigate carries the commit's HTTP status; a proxy 502 is a
          // dead port, anything else clears a stale error.
          if (event.httpStatus !== undefined) {
            setTileError(tileErrorForGuestResponse(event.httpStatus, url));
          }
          break;
        }
        case "failed":
          setLoading(false);
          setTileError(tileErrorForGuestFailure(event, url));
          break;
        case "focus":
          interactRef.current?.();
          break;
        case "zoom":
          // ctrl-wheel inside the guest steps the SPA's bucket; the stepped
          // zoom prop flows back and is re-sent by the zoom effect.
          onZoomStepRef.current?.(event.direction);
          break;
        case "find":
          // Chromium's activeMatchOrdinal is 1-based; the find bar's
          // matchIndex is 0-based. total 0 reports 0/0.
          setFind({ active: Math.max(0, event.active - 1), total: event.total });
          break;
        case "chord":
          // A keydown inside the tile is an interaction (the iframe engine's
          // onKey reports first), then the chord is re-dispatched onto the
          // document — the table already decided reclaim, so reclaimRef is
          // never consulted here.
          interactRef.current?.();
          redispatchChord(event);
          break;
      }
    });
    void (async () => {
      const mode = await shellWebMode();
      if (cancelled) return;
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(toNativeSrc(url, mode), window.location.origin).href;
      } catch {
        absoluteUrl = url;
      }
      const created = await createShellWebView(tabKey, absoluteUrl, identity);
      // Unmounted while the create was in flight: the cleanup's park ran
      // before the guest existed ("Unknown tab"), so destroy the guest the
      // late create just orphaned instead of leaking a renderer (destroy,
      // not park: the unmount may have been a chrome-issued tab death — a
      // tab that is gone must not land in the parked set).
      if (cancelled) {
        if (created) void destroyShellWebView(tabKey);
        return;
      }
      if (!created) return;
      // Main's per-tab channels gate on the guest existing ("Unknown tab"
      // before the create lands), so the initial chord table and zoom factor
      // go out only after the create resolves — a mount-time send is rejected
      // and these channels never self-heal. The reads take the LATEST values
      // through the refs so a prop change that landed during the awaits is
      // not lost (prop changes also re-send immediately from their effects).
      void setShellWebViewChords(tabKey, chordTableRef.current ?? []);
      void setShellWebViewZoom(tabKey, zoomRef.current);
      // Bounds and visibility likewise: every pre-create send was skipped, so
      // push the current rect and the current visibility rule now — bounds
      // first, so the guest never shows at main's 0×0 default (an adopted
      // guest's record is from its last mount and is refreshed the same way).
      createdRef.current = true;
      lastSentBoundsRef.current = null;
      measure();
      lastSentVisibleRef.current = wantVisibleRef.current;
      void setShellWebViewVisible(tabKey, wantVisibleRef.current);
    })();
    const reload = () => {
      setTileError(null);
      setLoading(true);
      void reloadShellWebView(tabKey);
    };
    registerHandle(url, {
      kind: "native",
      reload,
      retry: reload,
      back: () => void goBackShellWebView(tabKey),
      forward: () => void goForwardShellWebView(tabKey),
      find: (query, opts) => void findShellWebView(tabKey, query, opts),
      stopFind: () => {
        void stopFindShellWebView(tabKey);
        setFind(null);
      },
      openDevTools: () => void openShellWebViewDevTools(tabKey),
      destroy: () => {
        chromeDestroyed = true;
        void destroyShellWebView(tabKey);
      },
    });
    return () => {
      cancelled = true;
      createdRef.current = false;
      unregisterHandle(url);
      // Unmount PARKS (the tile went away; a same-identity remount adopts);
      // only a chrome-issued destroy — a tab that is GONE — skips it, its
      // destroy already on the wire. An older shell without park keeps the
      // pre-retention behavior (destroy), as does an identity-less guest
      // main-side.
      if (!chromeDestroyed) {
        if (canParkShellWebView()) void parkShellWebView(tabKey);
        else void destroyShellWebView(tabKey);
      }
      dispose();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [url, tabKey, identity, registerHandle, unregisterHandle, interactRef, measure]);

  // Zoom application: the INITIAL factor is sent by the mount effect after
  // the create resolves (a mount-time send races the guest's existence), so
  // this effect covers only zoom PROP CHANGES; every url relay also re-sends
  // (inside the relay handler above).
  const zoomMountedRef = useRef(false);
  useEffect(() => {
    if (!zoomMountedRef.current) {
      zoomMountedRef.current = true;
      return;
    }
    void setShellWebViewZoom(tabKey, zoom);
  }, [tabKey, zoom]);

  // The reclaim table: like zoom, the initial upload is the mount effect's
  // post-create send, so this effect covers only identity CHANGES (a rebind
  // re-derives the table). Absent prop ⇒ empty table — a guest with no table
  // forwards nothing.
  const chordsMountedRef = useRef(false);
  useEffect(() => {
    if (!chordsMountedRef.current) {
      chordsMountedRef.current = true;
      return;
    }
    void setShellWebViewChords(tabKey, chordTable ?? []);
  }, [tabKey, chordTable]);

  // Bounds triggers — everything funnels through measure() so the dedupe and
  // the zero-rect rule live in exactly one place.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // A position-only shift (a neighbouring tile resized without this one
  // changing size) fires no ResizeObserver entry — re-measure after every
  // render of the engine.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // A tab becoming active needs the current rect before its guest shows.
  useEffect(() => {
    if (active) measure();
  }, [active, measure]);

  // Hide while an occluding overlay is open (the guest is composited above
  // the DOM — a palette, dialog, or click-opened menu would render underneath
  // it). Tooltips and hover flyouts register nothing and never hide it.
  const overlayOpen = useSyncExternalStore(subscribe, isOccludingOpen, () => false);

  // Live resize while a SASH drag runs (posture `resize`): a rAF loop sends
  // deduped bounds every frame for the drag's duration; the resize → idle
  // edge stops the loop and measures once more. A tile MOVE drag instead
  // hides the guest (below) — the drop overlay must paint over its tile.
  const posture = useTileDragPosture();
  useEffect(() => {
    if (posture !== "resize") return;
    const tick = () => {
      measure();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      measure();
    };
  }, [posture, measure]);

  // The guest must not paint over the chrome's error surface: while tileError
  // is set the wrapper stays mounted beside it, so hiding is the only way the
  // copy is visible (the iframe engine hides its frame the same way). A tile
  // move drag hides too — the drop overlay previews the result tree and the
  // composited guest would paint over it; the show effect re-measures on the
  // move → idle edge before re-showing.
  const wantVisible =
    active && !overlayOpen && rectNonZero && tileError === null && posture !== "move";
  wantVisibleRef.current = wantVisible;
  useEffect(() => {
    // Pre-create the guest does not exist yet — the post-create block sends
    // the then-current rule (recording it here would dedupe that send away).
    if (!createdRef.current) return;
    if (lastSentVisibleRef.current === wantVisible) return;
    // Bounds precede the show (the shell also applies parked bounds on show;
    // this ordering is belt-and-braces).
    if (wantVisible) measure();
    lastSentVisibleRef.current = wantVisible;
    void setShellWebViewVisible(tabKey, wantVisible);
  }, [wantVisible, measure, tabKey]);

  useEffect(() => {
    onState(url, {
      loading,
      supports: WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES,
      trackedLocation,
      title,
      favicon,
      tileError,
      canGoBack,
      canGoForward,
      find,
    });
  }, [url, loading, trackedLocation, title, favicon, tileError, canGoBack, canGoForward, find, onState]);

  return (
    <div
      ref={placeholderRef}
      data-testid="web-native-placeholder"
      data-tab-key={tabKey}
      hidden={!active}
      className="w-full h-full bg-bg-primary"
    />
  );
}
