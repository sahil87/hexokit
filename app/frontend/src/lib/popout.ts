/**
 * Pure helpers for the surface popout (spec docs/specs/surface-layout.md
 * § Verbs → Pop out / Pop back in). A tile pops out into its own browser
 * window — the terminal route with `?pop=<leaf-id>` renders that one surface
 * chrome-less — while the opener hides the popped leaf for THIS viewer only
 * and reflows over the rest. The popped set is per-viewer localStorage
 * (`rk-layout-popped:{server}:{@N}`, keyed by leaf id, never the shared
 * `@rk_win_layout`); the two windows coordinate over a same-origin
 * BroadcastChannel.
 *
 * Everything here is pure and DOM-light (the `window-view.ts` /
 * `layout-tree.ts` module contract): storage access is try/catch-noop
 * (unavailable storage reads as the empty set — a corrupt or absent value
 * degrades to cold-start behavior), message handling validates by type
 * narrowing (no `as` casts), and the timers/channel wiring lives in the hook
 * (`hooks/use-popout.ts`).
 */

import {
  leafIds,
  parseLeafAddress,
  removeLeaf,
  type LayoutNode,
  type SurfaceKind,
} from "./layout-tree";
import { zoomLeafKind } from "./surface-layout";
import { windowIdToUrlSegment } from "./router-url";

/** The BroadcastChannel name opener and popout windows coordinate over. */
export const POPOUT_CHANNEL = "rk-popout";

/** The popout's liveness heartbeat cadence. */
export const POPOUT_HEARTBEAT_MS = 2000;

/** A popped mark whose popout sends no `opened`/`alive` within this window is
 *  stale — cleared so the tile reflows back (covers a crashed popout process
 *  where `pagehide` never fired). Three heartbeat intervals of margin. */
export const POPOUT_STALE_MS = 6000;

/** Popup window size when the opener has no measured tile rect to offer. */
export const POPOUT_FALLBACK_WIDTH = 1200;
export const POPOUT_FALLBACK_HEIGHT = 800;

/** The popped set's localStorage key — per viewer, per (server, window). */
export function poppedKey(server: string, windowId: string): string {
  return `rk-layout-popped:${server}:${windowId}`;
}

/** Read the popped leaf ids for a window. A corrupt, absent, or ill-shaped
 *  value reads as the empty set; storage unavailability does too. */
export function readPopped(server: string, windowId: string): string[] {
  try {
    const raw = localStorage.getItem(poppedKey(server, windowId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

/** Persist the popped leaf ids; the empty set removes the key. Best-effort
 *  (try/catch-noop), the storage-helper pattern. */
export function writePopped(server: string, windowId: string, popped: string[]): void {
  try {
    if (popped.length === 0) {
      localStorage.removeItem(poppedKey(server, windowId));
    } else {
      localStorage.setItem(poppedKey(server, windowId), JSON.stringify(popped));
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * The opener's render reduction: remove every popped id present in the tree.
 * `tree` is `null` when every leaf is popped (the caller renders the
 * popped-out placeholder — a layout never renders empty); `present` holds the
 * popped ids that were actually in the tree, so the caller can prune ids that
 * left the shared layout from storage.
 */
export function reducePopped(
  tree: LayoutNode,
  popped: string[],
): { tree: LayoutNode | null; present: string[] } {
  let out: LayoutNode | null = tree;
  const present = new Set<string>();
  // Highest occurrence first: removing `tty` renumbers `tty#2` down to `tty`
  // (duplicate ids derive from the CURRENT tree), so a pending `tty#2`
  // removal must land before the `tty` one it would otherwise survive.
  const ordered = [...popped].sort((a, b) => occurrenceIndex(b) - occurrenceIndex(a));
  for (const id of ordered) {
    if (out === null) break;
    if (!leafIds(out).includes(id)) continue;
    present.add(id);
    out = removeLeaf(out, id);
  }
  return { tree: out, present: popped.filter((id) => present.has(id)) };
}

/** The occurrence a duplicate-suffixed id names (`tty#2` → 2); bare and
 *  foreign ids are occurrence 1. */
function occurrenceIndex(id: string): number {
  const hash = id.indexOf("#");
  if (hash < 0) return 1;
  const n = Number(id.slice(hash + 1));
  return Number.isInteger(n) && n >= 2 ? n : 1;
}

/**
 * The surface toggle's close target: the kind's FIRST BARE leaf in the shared
 * tree (toggleSurface semantics — a foreign leaf is never the close target).
 * Undefined when the kind has no bare leaf (the toggle grows the layout
 * instead of closing).
 */
export function popoutToggleTarget(
  tree: LayoutNode,
  surface: SurfaceKind,
): string | undefined {
  return leafIds(tree).find(
    (id) => parseLeafAddress(id) === null && zoomLeafKind(id) === surface,
  );
}

/** The toggle-on-popped decision: flip the close-target leaf's membership in
 *  the viewer's revealed set. `reveal` puts the popped placeholder on screen,
 *  `hide` returns to the reflowed render — neither touches the layout. */
export type PopoutToggleAction = { kind: "reveal" | "hide"; leafId: string };

/**
 * The popped-toggle guard (spec surface-layout.md § Verbs → Pop out): when
 * the toggle's close target is in this viewer's popped set, the toggle MUST
 * NOT write the shared layout — it reveals the leaf's popped placeholder
 * (not revealed) or hides it again (revealed). `null` is the non-popped
 * verdict: the caller keeps the ordinary toggleSurface mutation. Callers MUST
 * treat a non-null action as the whole toggle — running toggleSurface after
 * one would close a leaf other viewers still see.
 */
export function popoutToggleAction(
  tree: LayoutNode,
  surface: SurfaceKind,
  popped: string[],
  revealed: string[],
): PopoutToggleAction | null {
  const leafId = popoutToggleTarget(tree, surface);
  if (leafId === undefined || !popped.includes(leafId)) return null;
  return { kind: revealed.includes(leafId) ? "hide" : "reveal", leafId };
}

/** A validated `?pop=` value: the leaf id as `leafIds()` produces it, its
 *  surface kind, and the window the surface belongs to (the foreign leaf's
 *  home, else the route window). */
export interface PopLeaf {
  leafId: string;
  kind: SurfaceKind;
  /** Set for a foreign leaf (`@12/tty`). */
  home?: string;
  /** The surface's owning window — the home for a foreign leaf. */
  windowId: string;
}

/**
 * Parse a `?pop=` value against the leaf-id vocabulary: a bare kind (`tty`,
 * `code`, `web`, `gui`), a duplicate bare-tty occurrence (`tty#<n>`, n ≥ 2),
 * or a foreign address (`@12/tty`). Rejects malformed values, foreign `gui`
 * (grammar-invalid in layouts — one desktop per host), `/<n>` suffixes, and
 * unknown kinds — the caller degrades a `null` to the ordinary terminal
 * render, never a route error. Window EXISTENCE is not checked here (the
 * sessions payload is the consumer's input).
 */
export function parsePopLeaf(raw: string, routeWindow: string): PopLeaf | null {
  const foreign = parseLeafAddress(raw);
  if (foreign !== null) {
    if (foreign.kind === "gui") return null;
    return { leafId: raw, kind: foreign.kind, home: foreign.home, windowId: foreign.home };
  }
  if (raw.startsWith("@")) return null;
  const kind = zoomLeafKind(raw);
  if (kind === undefined) return null;
  const hash = raw.indexOf("#");
  if (hash >= 0) {
    const suffix = raw.slice(hash + 1);
    // Only bare tty tiles repeat; the occurrence suffix is 2-based and
    // canonical decimal, as leafIds() emits it — `tty#02`, `tty#2.0`,
    // `tty#2e0` are malformed, not aliases Number() would normalize.
    if (kind !== "tty" || !/^[1-9]\d*$/.test(suffix) || Number(suffix) < 2) return null;
  }
  return { leafId: raw, kind, windowId: routeWindow };
}

/** The popout window's `window.open` name — a repeat Pop out of the same leaf
 *  focuses/reuses the existing popout window rather than opening a second. */
export function popoutWindowName(server: string, windowId: string, leafId: string): string {
  return `rk-pop:${server}:${windowId}:${leafId}`;
}

/** The popout's URL: the terminal route for `@N` carrying `?pop=<leaf-id>`. */
export function popoutUrl(server: string, windowId: string, leafId: string): string {
  return `/${server}/${windowIdToUrlSegment(windowId)}?pop=${encodeURIComponent(leafId)}`;
}

/** The `window.open` features for a popout, sized from the tile's rendered
 *  rect when the opener measured one. */
export function popoutFeatures(rect?: { w: number; h: number }): string {
  const width = rect !== undefined && rect.w > 0 ? Math.round(rect.w) : POPOUT_FALLBACK_WIDTH;
  const height = rect !== undefined && rect.h > 0 ? Math.round(rect.h) : POPOUT_FALLBACK_HEIGHT;
  return `popup,width=${width},height=${height}`;
}

/** The channel's message vocabulary. `opened`/`alive`/`closed` flow
 *  popout → openers; `pop-in`/`ping` flow opener → popouts. `leaf` is the
 *  empty string on `ping` (it addresses every popout of the window). */
export type PopoutMessage = {
  type: "opened" | "alive" | "closed" | "pop-in" | "ping";
  server: string;
  /** The opener's route window (`@N`) — the popout is keyed to it for life. */
  window: string;
  leaf: string;
};

/** Shape validation for channel traffic: anything malformed is ignored (type
 *  narrowing over `as`, per the module contract). */
export function isPopoutMessage(value: unknown): value is PopoutMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || !("server" in value) || !("window" in value) || !("leaf" in value)) {
    return false;
  }
  const { type, server, window, leaf } = value;
  if (
    type !== "opened" &&
    type !== "alive" &&
    type !== "closed" &&
    type !== "pop-in" &&
    type !== "ping"
  ) {
    return false;
  }
  return typeof server === "string" && typeof window === "string" && typeof leaf === "string";
}

/**
 * The stale-mark sweep: the marks whose popout is still live — a mark with no
 * `opened`/`alive` sighting within POPOUT_STALE_MS of `now` drops out (a never
 * sighted mark survives exactly one stale window from its recorded time, which
 * covers the mount → ping → first `opened` reply round trip).
 */
export function sweepStale(
  marks: string[],
  lastSeen: ReadonlyMap<string, number>,
  now: number,
): string[] {
  return marks.filter((id) => {
    const seen = lastSeen.get(id);
    return seen !== undefined && now - seen < POPOUT_STALE_MS;
  });
}
