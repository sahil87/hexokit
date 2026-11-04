/**
 * Popout-window pure logic — the `shell:popout` payload validator, the
 * popout-registry dedupe decision, and the `?pop=` strip for New Window
 * duplication.
 *
 * A popout is a same-host shell window opened by the SPA's Pop out verb: the
 * payload carries a ROUTE REMAINDER (`pathname + search`, e.g.
 * `/rk-dev/@12?pop=web`), never an absolute URL — main resolves it against
 * the sender host's origin, so a cross-origin target is unrepresentable and
 * the window-open policy's all-external rule stays untouched.
 *
 * Deliberately electron-free (the `window-open.ts` / `window-registry.ts`
 * pattern), so the sibling `popout.test.ts` covers every accept/reject case
 * under plain `node --test`. The impure glue — `screen.getPrimaryDisplay()`
 * for the size ceiling, BrowserWindow construction, focus — lives in
 * `main.ts`.
 */

/** Route length cap — a route remainder is renderer-supplied IPC data. */
export const POPOUT_ROUTE_MAX_LENGTH = 2048;

/** Popup size floor — below this the popout posture's tile is unusable. */
export const POPOUT_MIN_WIDTH = 320;
export const POPOUT_MIN_HEIGHT = 200;

/** Size when the payload omits (or carries an invalid optional) width/height
 *  — mirrors the SPA's POPOUT_FALLBACK_WIDTH/HEIGHT in
 *  `app/frontend/src/lib/popout.ts`. */
export const POPOUT_FALLBACK_WIDTH = 1200;
export const POPOUT_FALLBACK_HEIGHT = 800;

export interface PopoutPayload {
  /** The validated route remainder (`pathname + search`), normalized. */
  route: string;
  width: number;
  height: number;
}

/** The size ceiling the caller derives from the primary display work area. */
export interface PopoutMaxSize {
  width: number;
  height: number;
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Validate a `shell:popout` payload against the sender host's origin.
 * Returns the normalized payload, or null on any required-field failure.
 *
 * Route rules: a string within the length cap, starting with exactly one `/`
 * (no `//host` — `new URL` would read that as protocol-relative), no
 * backslash (WHATWG URL folds `\` into `/` for special schemes, so it is an
 * escape hatch for the single-slash rule), no control characters (NUL
 * included), resolving AGAINST THE HOST ORIGIN to a URL still on that origin,
 * whose pathname is exactly two non-empty segments (`/<server>/<window>` —
 * the terminal route shape), and whose `pop` search param is present and
 * non-empty (a popout window is defined by its popout posture).
 *
 * `width`/`height` are OPTIONAL: a finite positive number is rounded and
 * clamped to [POPOUT_MIN_*, max]; anything absent or invalid falls back to
 * POPOUT_FALLBACK_* rather than failing the request.
 */
export function parsePopoutPayload(
  value: unknown,
  hostOrigin: string,
  maxSize: PopoutMaxSize,
): PopoutPayload | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("route" in value) || typeof value.route !== "string") return null;
  const raw = value.route;
  if (raw.length === 0 || raw.length > POPOUT_ROUTE_MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || CONTROL_CHARS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, hostOrigin);
  } catch {
    return null;
  }
  if (url.origin !== hostOrigin) return null;
  // No empty-segment filter: `/a//b` or `/a/b/` must NOT collapse to `/a/b`.
  const segments = url.pathname.split("/");
  if (segments.length !== 3 || segments[1] === "" || segments[2] === "") return null;
  const pop = url.searchParams.get("pop");
  if (pop === null || pop === "") return null;
  return {
    route: url.pathname + url.search,
    width: popoutSize(
      "width" in value ? value.width : undefined,
      POPOUT_MIN_WIDTH,
      maxSize.width,
      POPOUT_FALLBACK_WIDTH,
    ),
    height: popoutSize(
      "height" in value ? value.height : undefined,
      POPOUT_MIN_HEIGHT,
      maxSize.height,
      POPOUT_FALLBACK_HEIGHT,
    ),
  };
}

/** One optional size dimension: round + clamp when valid, fallback when not. */
function popoutSize(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(Math.round(raw), min), Math.max(min, max));
}

/** One popout window's registry record (main.ts owns the live Map). */
export interface PopoutRecord {
  /** The window the popout was opened from (the guest-move source/return). */
  openerWindowId: number;
  hostId: string;
  /** The validated route the popout shows — the dedupe key with
   *  openerWindowId and hostId. */
  route: string;
}

/**
 * The dedupe decision: the live popout window (if any) already showing
 * `(openerWindowId, hostId, route)` — a repeat Pop out from the SAME opener
 * focuses it instead of opening a second window (the browser path's
 * `popoutWindowName` reuse semantics). A different opener window gets its
 * own popout: the record's opener scopes the guest move and the pop-back-in
 * return, so a cross-opener hit would strand that window's guest. Liveness
 * is the caller's check (the registry entry is dropped on `closed`); an id
 * naming a destroyed window is not a match.
 */
export function findPopoutWindow(
  registry: ReadonlyMap<number, PopoutRecord>,
  openerWindowId: number,
  hostId: string,
  route: string,
): number | null {
  for (const [windowId, record] of registry) {
    if (
      record.openerWindowId === openerWindowId &&
      record.hostId === hostId &&
      record.route === route
    ) {
      return windowId;
    }
  }
  return null;
}

/**
 * New Window from a popout source duplicates as an ORDINARY window: the same
 * route with the `pop` search param removed. An unparseable route passes
 * through unchanged (the caller's routes come from live views).
 */
export function stripPopParam(route: string): string {
  try {
    const url = new URL(route, "http://popout.invalid");
    url.searchParams.delete("pop");
    return url.pathname + url.search;
  } catch {
    return route;
  }
}
