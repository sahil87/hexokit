/**
 * Web-tile address model (260819-v6y4 R3/R4).
 *
 * A pure, DOM-free module — the `window-view.ts` contract — owning every
 * derivation over a stored `@rk_win_web_<n>` (or an address-bar keystroke):
 *
 * 1. `classifyAddress` — the four address kinds behind the header badge and
 *    the error-state posture: `present` (an `rk present` file), `proxy` (a
 *    loopback dev server riding `/proxy/{port}`), `external` (any other
 *    absolute http(s) URL), `relative` (any other root-relative path).
 * 2. `displayForm` — the pretty REST form the address bar and header show:
 *    plumbing hidden (`/proxy/` prefix, the `?server=…&v=…&raw=…` params), never
 *    throwing (unparseable input degrades to the raw string).
 * 3. `normalizeAddressInput` — the submit-time normalization: bare loopback
 *    `host:port` → `/proxy/{port}/…`, bare domain → `https://…`, valid
 *    values pass through.
 * 4. `isAllowedUrl` — the frontend mirror of the backend scheme allowlist
 *    (http/https absolute, root-relative; the backend remains enforcement).
 * 5. `toProxySrc` — the iframe-src mapping: absolute loopback URLs ride the
 *    same-origin proxy, everything else passes through.
 * 6. `toNativeSrc` — the native engine's mode-aware load target: in the
 *    host-reported `direct`/`proxy` modes a stored `/proxy/{port}` slot is
 *    re-expressed as its literal loopback URL; `legacy` is `toProxySrc`.
 *
 * The STORED `@rk_win_web_<n>` is never rewritten by display work — the
 * display contract (`docs/site/skill/display.md`) keeps relative addresses
 * relative.
 */

export type AddressKind = "present" | "proxy" | "external" | "relative";

/** The document CustomEvent that focuses the web tile's address bar (R12):
 *  dispatched by the ⌘L chord handler and the `Web: Focus address bar`
 *  palette action; `IframeWindow` listens while mounted (the
 * 'web-find:open' precedent — at most one web tile per layout). */
export const WEB_ADDRESS_FOCUS_EVENT = "web-address:focus";

/** The document CustomEvent that opens a viewer-local draft tab (the `Web:
 *  New tab` palette entry): the mounted web tile appends a dashed draft
 *  entry and focuses its address bar. `IframeWindow` is the single receiver
 *  (one web tile per layout). */
export const WEB_TAB_DRAFT_EVENT = "web-tab:open-draft";

/** The document CustomEvent behind the `Web: Open in browser` palette action
 *  (R9): the mounted web tile pops its CURRENT address — the tracked frame
 *  location lives in the component, not at the palette's layer. */
export const WEB_OPEN_EXTERNAL_EVENT = "web-open-external";

/** The document CustomEvent behind the `Web: Inspect page` palette action:
 *  the mounted web tile opens DevTools for its ACTIVE tab's engine (the
 *  native engine's detached window; engines without the capability no-op —
 *  the palette entry is gated on the native engine upstream). Same
 *  single-receiver shape as `web-open-external`. */
export const WEB_INSPECT_EVENT = "web-inspect";

/** Loopback hostnames whose absolute URLs classify as proxied ports. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The port a portless `http:` loopback URL targets. Mirrors the backend's
 *  `rk present` rule (`internal/present`), which stores `http://localhost/x`
 *  as `/proxy/80/x`; `URL.port` is also empty for an explicit `:80`. */
const HTTP_DEFAULT_PORT = 80;

/** Bare loopback `host:port[{path}]` input — no scheme (a scheme-bearing
 *  value parses as an absolute URL before this shape is consulted). */
const LOOPBACK_INPUT_RE = /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)([/?#][^\s]*)?$/;

/** Bare domain input: no scheme, no leading slash, a dot in the host,
 *  optional port and path. Also matches a dotted FILE name (`README.md`) —
 *  which is why the submit ladder stat-decides this shape via the backend
 *  instead of eagerly rewriting it to `https://…`. */
const BARE_DOMAIN_RE = /^[^\s/:]+\.[^\s/:]+(:\d+)?([/?#][^\s]*)?$/;

/** Plumbing query params hidden from the present-kind display form — the
 *  legacy form's `server` identity param (the NEW form promotes it into the
 *  path, so it lives there now), `rk present`'s `v` cache-buster, and the
 *  viewer shell's `raw` escape hatch. */
const PRESENT_PLUMBING_PARAMS = new Set(["server", "v", "raw"]);

/** Parse an absolute http(s) URL, or null for anything else. Never throws. */
function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** The port of a root-relative `/proxy/{port}/…` path, or null. */
function proxyPathPort(path: string): number | null {
  const m = path.match(/^\/proxy\/(\d+)(\/|$)/);
  return m ? Number(m[1]) : null;
}

/** The label for a NEW-form directory present (empty path tail): the
 *  trailing-slash directory form serves the root's index.html, so that
 *  basename is the display — the raw hash segment must never surface as a
 *  name or address. */
const DIRECTORY_PRESENT_LABEL = "index.html";

/** The path segments carrying content for a /present/ address, or null when
 *  only plumbing remains (degraded form — callers then fall back to the raw
 *  string, never display raw plumbing). The LEGACY form's segments are
 *  [windowId, slot?, name...]; the NEW content-keyed form's are
 *  [server, hash, name...] — so the first TWO segments are always plumbing.
 *  The legacy `@`-prefixed windowId segment is never a file name (the route
 *  gates it ^@[0-9]+$); the new-form hash segment is gated ^[0-9a-f]{8,64}$
 *  by the route, so presenting itself as a name is impossible there. */
function presentDisplayBase(segments: string[]): string | null {
  // segments[0] is the literal "present"; skip it so the shapes line up.
  const path = segments[0] === "present" ? segments.slice(1) : segments;
  if (path.length < 2) return null;
  if (path[0].startsWith("@")) {
    // Legacy form: drop windowId, then a slot-shaped next segment; what
    // remains is the name path. A slot-only remainder is not a name.
    const rest = path.slice(1);
    const names = rest.length > 1 && /^[1-8]$/.test(rest[0]) ? rest.slice(1) : rest;
    if (names.length === 0) return null;
    if (names.length === 1 && /^[1-8]$/.test(names[0])) return null;
    return names[names.length - 1];
  }
  // New content-keyed form has exactly two plumbing segments (server + hash).
  // A remainder of just those two is a directory present — the raw hash is
  // plumbing, not a name, and MUST NOT display, so the label is what the
  // directory form serves; more than two means a real file tail exists.
  if (path.length === 2) return DIRECTORY_PRESENT_LABEL;
  return path[path.length - 1];
}

/** The proxied port of an absolute loopback URL, or null when it is not
 *  proxied: an explicit port rides `/proxy/{port}`, a portless `http:` URL
 *  rides port 80, and a portless `https:` URL stays external (the backend
 *  attaches every `https://` target verbatim). */
function loopbackPortOf(u: URL): number | null {
  if (!LOOPBACK_HOSTS.has(u.hostname)) return null;
  if (u.port === "") return u.protocol === "http:" ? HTTP_DEFAULT_PORT : null;
  const port = Number(u.port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Classify a stored/tracked address. Order matters: root-relative `/present/`
 * and `/proxy/` before the generic relative fallback; absolute loopback URLs
 * with a proxied port (`loopbackPortOf`) are proxied ports, every other
 * absolute http(s) URL is external. Anything unrecognized (including
 * non-allowlist schemes, which the backend rejects anyway) degrades to
 * `relative` — never throws.
 */
export function classifyAddress(url: string): AddressKind {
  const abs = parseHttpUrl(url);
  if (abs) {
    return loopbackPortOf(abs) !== null ? "proxy" : "external";
  }
  if (url.startsWith("/present/")) return "present";
  if (proxyPathPort(url) !== null) return "proxy";
  return "relative";
}

/**
 * The port a proxy-kind address targets, or null for any other kind.
 */
export function proxyPortOf(url: string): number | null {
  const abs = parseHttpUrl(url);
  if (abs) return loopbackPortOf(abs);
  return proxyPathPort(url);
}

/**
 * The pretty REST form of an address, per kind:
 * - present  → the file's basename, plumbing params (`server`, `v`, `raw`) hidden
 * - proxy    → `localhost:{port}{path}` — the `/proxy/` plumbing never shows
 * - external → `host{path}{?query}` with the scheme omitted
 * - relative → the raw path
 *
 * Never throws: unparseable or degenerate input degrades to the raw string.
 */
export function displayForm(url: string): string {
  try {
    const kind = classifyAddress(url);
    if (kind === "present") {
      // Hide only the plumbing params (`server`, `v`, `raw`) and — for the NEW
      // content-keyed form — the server + hash path segments; a presented
      // page's own query params stay visible after the basename. A NEW-form
      // directory present (empty path tail) shows the index.html it serves —
      // the raw hash segment never displays.
      const u = new URL(url, "http://x");
      const segments = u.pathname.split("/").filter(Boolean);
      const base = presentDisplayBase(segments);
      if (base === null) return url;
      const params = new URLSearchParams(u.search);
      for (const plumbing of PRESENT_PLUMBING_PARAMS) params.delete(plumbing);
      const rest = params.toString();
      return `${base}${rest !== "" ? `?${rest}` : ""}${u.hash}`;
    }
    if (kind === "proxy") {
      const abs = parseHttpUrl(url);
      if (abs) {
        return `localhost:${loopbackPortOf(abs)}${abs.pathname}${abs.search}${abs.hash}`;
      }
      const port = proxyPathPort(url);
      if (port !== null) {
        // Strip the `/proxy/{port}` prefix; keep the remaining path + query.
        const rest = url.replace(/^\/proxy\/\d+/, "");
        return `localhost:${port}${rest === "" ? "/" : rest}`;
      }
      return url;
    }
    if (kind === "external") {
      const abs = parseHttpUrl(url);
      if (abs) return `${abs.host}${abs.pathname}${abs.search}${abs.hash}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * The tab-strip label for a stored address, per kind:
 * - present  → the file's basename; plumbing params and the tab's own query
 *   and hash are dropped
 * - proxy    → `localhost:{port}{path}` with no search/hash
 * - external → the host only
 * - relative → the raw path
 *
 * Never throws; empty/whitespace input is `""` (callers fall back to `#n`).
 */
export function webTabTitle(url: string): string {
  const value = url.trim();
  if (value === "") return "";
  try {
    const kind = classifyAddress(value);
    if (kind === "present") {
      const u = new URL(value, "http://x");
      const segments = u.pathname.split("/").filter(Boolean);
      const base = presentDisplayBase(segments);
      return base === null ? value : base;
    }
    if (kind === "proxy") {
      const abs = parseHttpUrl(value);
      if (abs) return `localhost:${loopbackPortOf(abs)}${abs.pathname}`;
      const port = proxyPathPort(value);
      if (port !== null) {
        const rest = value.replace(/^\/proxy\/\d+/, "").split(/[?#]/)[0];
        return `localhost:${port}${rest === "" ? "/" : rest}`;
      }
      return value;
    }
    if (kind === "external") {
      const abs = parseHttpUrl(value);
      if (abs) return abs.host;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * Submit-time input normalization (R4):
 * - bare loopback `localhost:{port}[{path}]` / `127.0.0.1:{port}[{path}]`
 *   (no scheme) → `/proxy/{port}{path or /}` — ride the same-origin proxy,
 *   matching the Host page's port addressing
 * - bare domain `example.com[/path]` (no scheme) → `https://example.com[/path]`
 * - already-valid values (absolute http(s), root-relative) pass through
 *
 * Anything else (an explicit non-allowlist scheme, a bare word) passes
 * through unchanged so `isAllowedUrl` can reject it with inline feedback.
 */
export function normalizeAddressInput(input: string): string {
  const trimmed = input.trim();
  // Bare loopback with a port — no scheme (a scheme would have matched the
  // pass-through below).
  const loopback = trimmed.match(LOOPBACK_INPUT_RE);
  if (loopback) {
    const rest = loopback[3] ?? "/";
    return `/proxy/${loopback[2]}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  // Bare domain: no scheme, no leading slash, carries a dot.
  if (BARE_DOMAIN_RE.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * The submit ladder's routing verdict for one address-bar input:
 * - `write` — URL-shaped input (today's lanes): the value replaces the active
 *   slot, or materializes a selected draft, exactly as before
 * - `add` — path/port-shaped input: sent to `POST …/web` (the add verb),
 *   which stats it under the window's worktree cwd — append-or-focus, never
 *   in-place navigation. `fallback` carries the `https://…` bare-domain form
 *   the caller retries on a 400 (dotted single segments only: the backend
 *   stat is the tiebreaker between `README.md` the file and `example.com`
 *   the domain)
 * - `reject` — inline error, no POST (bare words, non-http(s) schemes)
 */
export type AddressSubmitRoute =
  | { kind: "write"; url: string }
  | { kind: "add"; target: string; fallback?: string }
  | { kind: "reject" };

/**
 * Route one submitted address-bar input through the five-lane decision
 * ladder. Lanes 1–2 preserve today's behavior for URL-shaped input verbatim;
 * lanes 3–4 send path-shaped input to the backend resolver instead of
 * pre-rejecting it (frontend regexes stop deciding what only a stat can
 * decide); lane 5 is today's inline reject.
 */
export function routeAddressSubmit(input: string): AddressSubmitRoute {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "reject" };
  // Lane 1 — absolute http(s) URLs and root-relative paths: today's
  // allowlist verdict, value passed through untouched.
  if (parseHttpUrl(trimmed) !== null || trimmed.startsWith("/")) {
    return isAllowedUrl(trimmed) ? { kind: "write", url: trimmed } : { kind: "reject" };
  }
  // Lane 2 — bare loopback host:port rides the same-origin proxy (today's
  // rewrite); bare :NNNN is a backend port target (the API/CLI already
  // accept it — the address-bar rejection was an artifact of the old gate).
  if (LOOPBACK_INPUT_RE.test(trimmed)) {
    return { kind: "write", url: normalizeAddressInput(trimmed) };
  }
  if (/^:\d+$/.test(trimmed)) return { kind: "add", target: trimmed };
  // An explicit non-http(s) scheme is URL-shaped, not a path — reject it
  // here (with or without `//`: `ftp://x`, `file:/etc/passwd`, `mailto:a/b`,
  // `file:1/etc/passwd`) so the slash test below cannot misread it as a file
  // path. The ONLY colon-bearing shape exempted is the full bare-domain
  // `host.tld:port[/path]` form (`example.com:8080`) — a dotted host with a
  // digits-only port — which lanes 3–4 stat-decide (loopback and bare :NNNN
  // already returned above).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !BARE_DOMAIN_RE.test(trimmed)) {
    return { kind: "reject" };
  }
  // Lane 3 — slash-bearing or ./-leading input is always a path; the backend
  // answers with the resolved slot URL or an honest 400.
  if (trimmed.startsWith("./") || trimmed.includes("/")) {
    return { kind: "add", target: trimmed };
  }
  // Lane 4 — a dotted single segment (`README.md`, `example.com`) is
  // stat-decided: path when it exists, else the https:// form via fallback.
  if (BARE_DOMAIN_RE.test(trimmed)) {
    return { kind: "add", target: trimmed, fallback: `https://${trimmed}` };
  }
  // Lane 5 — bare words and everything else: inline reject, unchanged.
  return { kind: "reject" };
}

/**
 * The frontend mirror of the backend @rk_win_url scheme allowlist (R1): absolute
 * http:/https: URLs with a host, and root-relative paths (a single leading
 * `/`, not scheme-relative `//`). Everything else is rejected — inline
 * feedback, no POST; the backend remains the enforcement point.
 */
export function isAllowedUrl(input: string): boolean {
  const value = input.trim();
  if (value === "") return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  const abs = parseHttpUrl(value);
  return abs !== null && abs.host !== "";
}

/**
 * The iframe-src mapping: an absolute loopback URL with a proxied port
 * (`loopbackPortOf`) re-expressed as the same-origin `/proxy/{port}` path;
 * every other address passes through unchanged (relative addresses are
 * already same-origin).
 */
export function toProxySrc(url: string): string {
  const abs = parseHttpUrl(url);
  const port = abs ? loopbackPortOf(abs) : null;
  if (abs && port !== null) {
    return `/proxy/${port}${abs.pathname}${abs.search}${abs.hash}`;
  }
  return url;
}

/**
 * The `POST …/web` add-target form of an address: the backend resolves the
 * target exactly like `rk present` (`:port`, local URL, external URL,
 * file/dir), which has no root-relative `/proxy/` form — a relative proxy
 * address would be misread as a filesystem path. Re-express it as the
 * absolute loopback URL it rides (the backend rewrites that back to the
 * identical `/proxy/{port}` slot value); every other address passes through
 * unchanged.
 */
export function toWebAddTarget(url: string): string {
  const port = proxyPathPort(url);
  if (port === null) return url;
  const rest = url.replace(/^\/proxy\/\d+/, "");
  return `http://localhost:${port}${rest === "" ? "/" : rest}`;
}

/** The native engine's host-reported load mode: `direct` when the host IS
 *  this machine's daemon, `proxy` when a remote host's forward proxy carries
 *  the guest session's traffic, `legacy` for anything else (older shell or a
 *  host whose proxy capability check failed). */
export type WebNativeMode = "direct" | "proxy" | "legacy";

/**
 * The native engine's load target for a stored address, per the host's mode.
 * In `direct`/`proxy` the guest session resolves loopback on the rk host, so
 * a stored `/proxy/{port}` slot is re-expressed as the literal loopback URL it
 * rides (the `toWebAddTarget` inverse mapping — the same slot value then still
 * works in a browser viewer's iframe engine); absolute URLs and every other
 * address kind pass through unchanged. `legacy` is exactly `toProxySrc`.
 */
export function toNativeSrc(url: string, mode: WebNativeMode): string {
  if (mode === "legacy") return toProxySrc(url);
  return toWebAddTarget(url);
}
