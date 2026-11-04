/**
 * The web-frame engine contract — the seam between the web tile's chrome
 * (`IframeWindow`) and whatever renders a tab's content.
 *
 * A pure, DOM-light module — the `window-view.ts`/`find-in-page.ts`
 * contract — owning two pieces:
 *
 * 1. The typed contract: capability flags the chrome renders by (never by
 *    origin — a renderer that does not embed has no meaningful origin answer,
 *    so per-feature capabilities are the only axis every engine can answer),
 *    the per-frame state slice reported up, the imperative command handle
 *    registered per frame URL, and the props every engine component accepts.
 * 2. `redispatchChord`, the one mechanism both the iframe engine and any
 *    future engine share for handing a reclaimed chord back to the parent
 *    document.
 *
 * The module carries no React runtime import and no origin awareness: the
 * word for a frame's same-origin posture exists only inside an engine
 * implementation, where it derives the capability flags it reports.
 */

import type { WebChordSpec } from "@/lib/web-chord-table";

/** Which renderer sits behind the web tile's chrome. */
export type WebFrameEngineKind = "iframe" | "native";

/** What an engine can do — the chrome renders per these, never per origin. */
export interface WebFrameCapabilities {
  /** back/forward are meaningful (chrome shows ◀ ▶). */
  history: boolean;
  /** find-in-page is available (chrome's find bar is live; false ⇒ the bar
   *  renders disabled with the hint). */
  find: boolean;
  /** the engine reports page title/favicon/tracked location. */
  meta: boolean;
  /** the engine wires ctrl-wheel / pinch gestures inside the content itself
   *  (the chrome's wrapper arm is unconditional and separate). */
  zoomGestures: boolean;
  /** the engine can open devtools. */
  devtools: boolean;
}

/** The tile's error surface — produced by an engine's probes, rendered by
 *  the chrome. */
export type TileError =
  | { kind: "refused"; host: string; reason: string }
  | { kind: "unreachable"; host: string; reason: string }
  | { kind: "dead-port"; port: number };

/** The chrome-relevant slice of one frame's state, reported up per engine
 *  instance; the chrome binds to the ACTIVE frame's entry. */
export interface FrameChromeState {
  loading: boolean;
  supports: WebFrameCapabilities;
  /** Root-relative current location when readable (display-only, never POSTed). */
  trackedLocation: string | null;
  title: string | null;
  favicon: string | null;
  tileError: TileError | null;
  /** History boundary flags; a `false` disables the matching chrome button.
   *  An engine with no boundary signal reports both equal to
   *  `supports.history` (a boundary click is then a harmless no-op). */
  canGoBack: boolean;
  canGoForward: boolean;
  /** Find result for the engine's CURRENT query; null when no search is
   *  active. `active` is the 0-based index of the active match (FindBar's
   *  `matchIndex`), `total` the match count. */
  find: { active: number; total: number } | null;
}

export interface FindOptions {
  /** Direction for a step; ignored when starting a new search. */
  forward: boolean;
  /** false ⇒ (re)start the search for `query` (matches re-collected, active
   *  resets to the first); true ⇒ step to the next/previous match of the
   *  current query. */
  findNext: boolean;
}

/** Chrome → engine commands, registered per frame URL (the frame's identity).
 *  The handle never exposes the engine's element: the chrome drives content
 *  only through these verbs. */
export interface WebFrameEngineHandle {
  kind: WebFrameEngineKind;
  reload: () => void;
  retry: () => void;
  back: () => void;
  forward: () => void;
  find: (query: string, opts: FindOptions) => void;
  stopFind: () => void;
  openDevTools?: () => void;
  /** Immediate teardown of the frame's content, chrome-initiated: the chrome
   *  owns the tab family and alone knows when a tab DIES (close, URL-slot
   *  rewrite) versus the tile merely going away. An engine whose content
   *  survives unmount (the native engine parks its guest) implements this so
   *  the dead tab is never retained; engines with nothing to retain omit it. */
  destroy?: () => void;
}

/** Props every engine component accepts — the chrome mounts one engine per
 *  tab through these. */
export interface WebFrameEngineProps {
  /** The stored tab address (the frame's identity — React key). */
  url: string;
  active: boolean;
  /** Content zoom factor (chrome-owned bucket); the engine applies it how it
   *  can. */
  zoom: number;
  /** The chrome's gesture arm, handed to the engine so it can wire the same
   *  continuous-zoom mapping inside the content when it is able to. */
  wireGestureListeners: (target: Document | HTMLElement) => () => void;
  onState: (url: string, state: FrameChromeState) => void;
  /** Fired once per completed main-frame load of this frame — an edge, not a
   *  state level: the chrome resets its find query on the ACTIVE frame's
   *  loads, which "a navigation happened" cannot express as a level. */
  onLoad: (url: string) => void;
  registerHandle: (url: string, handle: WebFrameEngineHandle) => void;
  unregisterHandle: (url: string) => void;
  /** Late-bindable seams read through refs (a hidden tile handed slot -1
   *  becoming visible supplies `onInteract` after mount). */
  interactRef: { current: (() => void) | undefined };
  reclaimRef: { current: ((e: KeyboardEvent) => boolean) | undefined };
  /** Bucket-step callback for zoom gestures the content handles itself (the
   *  native engine's ctrl-wheel relay) — the chrome steps its bucket and the
   *  resulting `zoom` prop flows back. Engines with an in-document gesture
   *  arm ignore it. */
  onZoomStep?: (direction: "in" | "out") => void;
  /** The reclaimable chord table enumerated from the keybinding registry (the
   *  kind-"web" answer to `hasReclaimableMatch` — a rebind re-derives it).
   *  Only engines whose content's keydowns cannot run the predicate at event
   *  time (the native engine) consume it; the iframe engine ignores it. */
  chordTable?: readonly WebChordSpec[];
  /** The tile's tmux scope (server + window id `@N`) — the native engine
   *  joins it with the slot `url` into the guest's stable retention identity
   *  (main prefixes the desktop window + host id from the sender's host view).
   *  Absent ⇒ the guest never parks: unmount destroys it. The iframe engine
   *  ignores it. */
  retentionScope?: { server: string; windowId: string };
}

/** The modifier + key slice a reclaimed chord carries across the engine
 *  boundary. */
export interface ChordEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Re-dispatch a reclaimed chord as a synthetic bubbling KeyboardEvent on the
 *  parent document — bubbling reaches both the document-level palette
 *  listener and the window-level keybinding dispatcher. */
export function redispatchChord(e: ChordEvent): void {
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
}
