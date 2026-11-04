/**
 * Web-tile content zoom (260823-cwvv R2/R3/R5).
 *
 * A pure, DOM-free module — the `web-url.ts` contract — owning every
 * derivation over a web tile's zoom level:
 *
 * 1. `WEB_ZOOM_LEVELS` + `stepWebZoom` — the browser-standard discrete step
 *    ladder (50%–300%, default/reset 100%) for CLICK/SHORTCUT zoom: stepping
 *    clamps at the ends and snaps an off-ladder value to the nearest level
 *    first. Gesture zoom is CONTINUOUS (260824-iafo) — off-ladder floats are
 *    legitimate stored state, and the snap is the bridge from a gesture-set
 *    float to the button/palette ladder.
 * 2. `webZoomKeyFor` — the persistence bucket for a stored `@rk_win_url`, derived
 *    via `classifyAddress`: `external` → the URL's origin, `proxy`/loopback →
 *    `proxy:{port}`, `present`/`relative` → the single viewer-origin bucket
 *    `self`. Matches browser per-origin zoom expectations.
 * 3. `readWebZoom`/`writeWebZoom` — try/catch-noop accessors over ONE
 *    localStorage key (`hexokit-web-zoom`) holding a `{[bucket]: level}` map;
 *    a level of 1 removes the entry so the map stays sparse. Per-viewer
 *    state only — never POSTed (Constitution IV; spec window-views R7).
 * 4. `WEB_ZOOM_EVENT` — the document CustomEvent seam the palette actions
 *    dispatch; the mounted web tile is its single receiver (the
 *    `web-find:open` precedent — at most one web tile per layout).
 */

import { classifyAddress, proxyPortOf } from "./web-url";

/** The document CustomEvent behind the `Web: Zoom in/out/reset` palette
 *  actions (R5): `detail.direction` selects the step; the mounted web tile
 *  listens while mounted. */
export const WEB_ZOOM_EVENT = "web-zoom";

export type WebZoomDirection = "in" | "out" | "reset";

/** The browser-standard discrete zoom ladder (Chrome/Firefox conventions),
 *  50%–300% with 100% the default and reset target. */
export const WEB_ZOOM_LEVELS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

/** The default and reset level — 100%. */
export const WEB_ZOOM_DEFAULT = 1;

/** The continuous zoom bounds — the ladder's ends. */
export const WEB_ZOOM_MIN = WEB_ZOOM_LEVELS[0];
export const WEB_ZOOM_MAX = WEB_ZOOM_LEVELS[WEB_ZOOM_LEVELS.length - 1];

const WEB_ZOOM_STORAGE_KEY = "hexokit-web-zoom";

/** The nearest ladder level to `value` (ties break toward the lower level). */
function nearestLevel(value: number): number {
  let best: number = WEB_ZOOM_DEFAULT;
  let bestDist = Infinity;
  for (const level of WEB_ZOOM_LEVELS) {
    const dist = Math.abs(level - value);
    if (dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Step one ladder level in `direction` from `current`. An off-ladder current
 * (a hand-edited stored value) snaps to the nearest level FIRST, then steps —
 * so a step from 1.05 lands on 1.1, not 1.25. Clamps at the ladder ends:
 * stepping past an end returns the end itself (the caller can no-op on an
 * unchanged value).
 */
export function stepWebZoom(current: number, direction: "in" | "out"): number {
  const snapped = nearestLevel(current);
  const idx = WEB_ZOOM_LEVELS.indexOf(snapped as (typeof WEB_ZOOM_LEVELS)[number]);
  const next = direction === "in" ? idx + 1 : idx - 1;
  const clamped = Math.min(WEB_ZOOM_LEVELS.length - 1, Math.max(0, next));
  return WEB_ZOOM_LEVELS[clamped];
}

/**
 * The persistence bucket for a stored `@rk_win_url`: `external` → the URL's
 * origin (`https://example.com`); `proxy`/loopback → `proxy:{port}`;
 * `present`/`relative` → the single viewer-origin bucket `self` (presented
 * files rotate paths, so per-path buckets would fragment state). Never
 * throws — unparseable input degrades to `self`.
 */
export function webZoomKeyFor(url: string): string {
  try {
    const kind = classifyAddress(url);
    if (kind === "external") {
      const origin = new URL(url).origin;
      if (origin !== "null") return origin;
      return "self";
    }
    if (kind === "proxy") {
      const port = proxyPortOf(url);
      if (port !== null) return `proxy:${port}`;
      return "self";
    }
    return "self";
  } catch {
    return "self";
  }
}

function readZoomMap(): Record<string, number> {
  try {
    const stored = localStorage.getItem(WEB_ZOOM_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * The stored zoom level for a bucket, or `WEB_ZOOM_DEFAULT` when absent or
 * unreadable. Returns the stored FLOAT clamped to the continuous bounds — a
 * gesture-set 1.37 reloads as 1.37, never snapped (the ladder snap lives
 * solely in `stepWebZoom`, the click/shortcut path).
 */
export function readWebZoom(key: string): number {
  const stored = readZoomMap()[key];
  if (stored === undefined) return WEB_ZOOM_DEFAULT;
  return Math.min(WEB_ZOOM_MAX, Math.max(WEB_ZOOM_MIN, stored));
}

/**
 * Persist a bucket's zoom level, rounded to 2 decimals (1% granularity —
 * sub-percent precision is invisible). A rounded level of `WEB_ZOOM_DEFAULT`
 * REMOVES the entry — the map stays sparse, 100% is the absent state (the
 * `resetTerminalFont` unset-state precedent), and the round keeps the rule
 * robust to gesture float noise (0.9999 removes, not stores). Storage
 * failures no-op silently (private mode, quota).
 */
export function writeWebZoom(key: string, level: number): void {
  try {
    const rounded = Math.round(level * 100) / 100;
    const map = readZoomMap();
    if (rounded === WEB_ZOOM_DEFAULT) {
      delete map[key];
    } else {
      map[key] = rounded;
    }
    localStorage.setItem(WEB_ZOOM_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* noop */
  }
}
