import type { CSSProperties } from "react";
import { contrastRatio } from "@/themes";
import type { ShellServer } from "@/lib/shell";

/**
 * Pure helpers for the desktop shell's titlebar strip (the 28px accent band
 * `ShellTitlebarStrip` draws above the top bar when running inside the
 * Electron viewer shell). Extracted so the label/inset/color rules are
 * unit-testable without mounting the component.
 */

/** A style object that may also carry CSS custom properties (`--rk-*`). */
export type CssVarStyle = CSSProperties & { [key: `--${string}`]: string };

/** Strip height — mirrors the shell's `STRIP_HEIGHT_PX` (the win/linux
 *  window-controls overlay is sized to the same value shell-side). */
export const SHELL_STRIP_HEIGHT_PX = 28;

/** The <html> marker class keying the shell's version-skew fallback CSS off
 *  (`html:not(.rk-shell-strip)` shell-side) while the real strip is mounted. */
export const SHELL_STRIP_MARKER_CLASS = "rk-shell-strip";

const STRIP_TEXT_LIGHT = "#e5e7eb";
const STRIP_TEXT_DARK = "#111827";

/**
 * Contrast-derived label color for a strip background: whichever of the two
 * standard text hexes reads better (the `themes.ts` contrast helpers — the
 * same WCAG ratio the border guard uses).
 */
export function stripLabelColor(bgHex: string): string {
  return contrastRatio(bgHex, STRIP_TEXT_LIGHT) >= contrastRatio(bgHex, STRIP_TEXT_DARK)
    ? STRIP_TEXT_LIGHT
    : STRIP_TEXT_DARK;
}

/** Gutter between the OS window controls' reserved area and the strip row. */
const STRIP_GUTTER_PX = 12;
/** Space the macOS traffic lights occupy at the strip's left edge. */
const DARWIN_TRAFFIC_LIGHT_INSET_PX = 80;

/**
 * Horizontal insets keeping the strip row clear of the OS window controls
 * compositing over it: the macOS traffic lights reserve the left end (the row
 * is left-aligned, so the right end needs only a gutter); elsewhere the
 * `titlebar-area-*` env expressions place the row inside the Windows/Linux
 * window-controls overlay's free area (the env vars fall back to 0/full where
 * WCO is absent, degrading to a plain gutter).
 */
export function stripInsets(platform: string): { left: string; right: string } {
  if (platform === "darwin") {
    return { left: `${DARWIN_TRAFFIC_LIGHT_INSET_PX}px`, right: `${STRIP_GUTTER_PX}px` };
  }
  return {
    left: `calc(env(titlebar-area-x, 0px) + ${STRIP_GUTTER_PX}px)`,
    right: "calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%))",
  };
}

/**
 * The active shell-registered host's display name, or null when the list is
 * unavailable (older shell, denial) or carries no active entry — callers fall
 * back to `location.hostname`.
 */
export function activeShellHostName(servers: ShellServer[] | null): string | null {
  const active = servers?.find(isSelfHost);
  return active ? active.name : null;
}

/**
 * Whether the entry is the host THIS view shows. The additive `current` flag
 * is resolved shell-side from the asking view; `active` is the cosmetic
 * last-focused-window record, which in a multi-window shell can name another
 * window's host — the fallback for older shells that omit `current`.
 */
export function isSelfHost(server: ShellServer): boolean {
  return server.current ?? server.active;
}

/** Document CustomEvent name opening the strip's host-switcher menu — the
 *  `terminal-find:open` seam shape: entry points that cannot reach the strip's
 *  state (the palette's `Host: Switcher` body) dispatch it, and the mounted
 *  `ShellTitlebarStrip` listens and opens. No detail payload. */
export const HOST_MENU_OPEN_EVENT = "host-menu:open";

/** Document CustomEvent name moving focus to the strip's host squares — the
 *  palette's `Host: Focus Squares` body dispatches it (the same seam shape as
 *  HOST_MENU_OPEN_EVENT); the ⇧⌘H chord is a component-local listener. */
export const HOST_STRIP_FOCUS_EVENT = "host-strip:focus";

/** Accelerator-hint cap — mirrors the native Hosts menu's
 *  `MAX_SWITCHER_ACCELERATORS` (hosts beyond the ninth get no binding, so
 *  they get no hint either). */
export const MAX_SHELL_SWITCHER_HINTS = 9;

/**
 * Trailing accelerator hint for the host at `index` (list order — the native
 * Hosts menu binds in the same order): `⌥⌘{n}` on darwin, `Alt+{n}`
 * elsewhere — both modifier choices sit outside every SPA chord tier (the
 * registry excludes Option and Alt), so the page can never lose a binding to
 * them. `null` past the 9-cap.
 */
export function hostAcceleratorHint(platform: string, index: number): string | null {
  if (index < 0 || index >= MAX_SHELL_SWITCHER_HINTS) return null;
  const n = index + 1;
  return platform === "darwin" ? `⌥⌘${n}` : `Alt+${n}`;
}

/** One row of the strip's host-switcher dropdown. */
export interface ShellHostMenuRow {
  id: string;
  name: string;
  /** The entry's origin — host display names are not unique (the shell's
   *  store never dedupes), so the dimmed origin disambiguates. */
  origin: string;
  active: boolean;
  /** Accelerator hint mirroring the native Hosts menu, or null past the cap. */
  hint: string | null;
  /** The host's instance accent color (left-edge bar), hex-validated — null
   *  when absent or not a strict hex value (never interpolated unvalidated). */
  accentColor: string | null;
  /** Cached waiting-agent count (amber ● N), or null — background rows only
   *  (the active host's attention surface is the dock badge). */
  waiting: number | null;
}

/** The entry's origin for display: the store persists origins already, so
 *  this is normally identity; a malformed url falls back to the raw string. */
function hostOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Strict hex gate before style interpolation — the shell-side
 *  `fallbackStripCss` precedent: `#RGB` / `#RRGGBB` / `#RRGGBBAA` only. */
const HOST_ACCENT_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Menu rows for the host-switcher dropdown, derived from the bridge's
 * `servers:list` projection. List order is preserved (it is the native
 * menu's binding order). The additive `accentColor` passes through only when
 * it hex-validates; `waiting` rides along only when positive and the row is
 * NOT active (background hosts only). Both are null on older shells, whose
 * projection omits the fields.
 */
export function shellHostMenuRows(servers: ShellServer[], platform: string): ShellHostMenuRow[] {
  return servers.map((s, i) => ({
    id: s.id,
    name: s.name,
    origin: hostOrigin(s.url),
    active: isSelfHost(s),
    hint: hostAcceleratorHint(platform, i),
    accentColor: s.accentColor !== undefined && HOST_ACCENT_HEX.test(s.accentColor)
      ? s.accentColor
      : null,
    waiting: !isSelfHost(s) && s.waiting !== undefined && s.waiting > 0 ? s.waiting : null,
  }));
}

/**
 * Gate predicate for the dropdown affordance: interactive only when the
 * bridge answered a non-empty host list (the command palette's shell-switch
 * precedent — gate on the `servers` group answering, not on `isShell()`).
 * An older shell without the group keeps the static label.
 */
export function stripSwitcherEnabled(servers: ShellServer[] | null): servers is ShellServer[] {
  return servers !== null && servers.length > 0;
}

// ── Square geometry ──────────────────────────────────────────────────────────

/** Host squares are fixed at this edge length — large enough for one digit.
 *  The active host is marked by a ring, never by size, so layout never moves. */
export const SQUARE_SIZE_PX = 18;
/** Gap between adjacent squares. */
export const SQUARE_GAP_PX = 7;
/** Distance between adjacent squares' left edges — one drag slot. */
export const SQUARE_PITCH_PX = SQUARE_SIZE_PX + SQUARE_GAP_PX;
/** Pointer travel below which a press-release is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** Digit shown in the square at `index` while hints are visible, or null past
 *  the accelerator cap (those squares have no binding, so no digit). */
export function squareDigit(index: number): number | null {
  return index >= 0 && index < MAX_SHELL_SWITCHER_HINTS ? index + 1 : null;
}

/** Move one element of a list (returns a new array; out-of-range is a no-op). */
export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Slack the dragged square may travel past the row's first/last slot. */
const DRAG_OVERSHOOT_PX = 6;

/**
 * Where a square dragged `dx` px from its slot `from` lands: the nearest slot
 * (`to`) and the travel actually applied (`offset`), clamped to the row plus a
 * small overshoot so the square never leaves the strip.
 */
export function dragTarget(
  from: number,
  dx: number,
  count: number,
): { to: number; offset: number } {
  if (count <= 0) return { to: 0, offset: 0 };
  const min = -from * SQUARE_PITCH_PX - DRAG_OVERSHOOT_PX;
  const max = (count - 1 - from) * SQUARE_PITCH_PX + DRAG_OVERSHOOT_PX;
  const offset = Math.min(Math.max(dx, min), max);
  const to = Math.min(Math.max(Math.round((from * SQUARE_PITCH_PX + offset) / SQUARE_PITCH_PX), 0), count - 1);
  return { to, offset };
}

/**
 * Where the square originally at `index` sits while another square is dragged
 * from `from` to `to`: siblings between the two slide aside by one slot.
 * Returns the slot (not pixels) the square renders in.
 */
export function slotWhileDragging(index: number, from: number, to: number): number {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (from > to && index >= to && index < from) return index + 1;
  return index;
}

// ── Key hints ────────────────────────────────────────────────────────────────

/** The modifier pill's label: the switch chord's modifiers. */
export function keyHintLabel(platform: string): string {
  return platform === "darwin" ? "⌥⌘" : "Alt";
}

/** Pill tooltip: the switch chord and the focus-squares chord. */
export function keyHintTip(platform: string): string {
  return platform === "darwin"
    ? "⌥⌘1–9 switches host · ⇧⌘H focuses the squares"
    : "Alt+1–9 switches host · ⇧Ctrl+H focuses the squares";
}

/** Whether a key event shows the switch chord's modifiers as held. */
export function isHintChord(
  e: { altKey: boolean; metaKey: boolean },
  platform: string,
): boolean {
  return platform === "darwin" ? e.altKey && e.metaKey : e.altKey;
}

// ── Host kind / link / OS labels ─────────────────────────────────────────────

/** `rk remote` SSH tunnels bind loopback ports in this range
 *  (the backend's portpolicy tunnel block). */
const TUNNEL_PORT_MIN = 3100;
const TUNNEL_PORT_MAX = 3199;

/** How the host is reached, derived from its origin (no configuration). */
export type HostKind = "local" | "net" | "tunnel";

export interface HostReach {
  kind: HostKind;
  /** Human link label: `local`, `tailscale`, `lan`, or `ssh tunnel :PORT`. */
  link: string;
}

/** Derive kind + link from a shell entry's URL. A malformed URL reads as a
 *  network host on an unknown link (`lan`). */
export function hostReach(url: string): HostReach {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "net", link: "lan" };
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  const port = Number(parsed.port);
  if (loopback && port >= TUNNEL_PORT_MIN && port <= TUNNEL_PORT_MAX) {
    return { kind: "tunnel", link: `ssh tunnel :${port}` };
  }
  if (loopback) return { kind: "local", link: "local" };
  return { kind: "net", link: parsed.hostname.endsWith(".ts.net") ? "tailscale" : "lan" };
}

/** Accessible label for a kind glyph. */
export const HOST_KIND_LABEL: Record<HostKind, string> = {
  local: "this machine",
  net: "network host (Tailscale / LAN)",
  tunnel: "rk remote · SSH tunnel",
};

/** Display label for the daemon's `runtime.GOOS`. */
export function osLabel(os: string): string {
  return os === "darwin" ? "macOS" : os;
}

/**
 * Short host monogram: multi-token names (split on `-`, `_`, `.`) take the
 * first letter of the first token plus the last token's number when numeric,
 * else its first letter; single-token names take their first two characters.
 * Uppercased — `ws-01` → `W1`, `mac-mini` → `MM`, `laptop` → `LA`.
 */
export function hostMonogram(name: string): string {
  const tokens = name.split(/[-_.]/).filter((t) => t !== "");
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  const first = tokens[0][0];
  const last = tokens[tokens.length - 1];
  const tail = /^\d+$/.test(last) ? String(Number(last)) : last[0];
  return (first + tail).toUpperCase();
}

// ── Nameplate ────────────────────────────────────────────────────────────────

/** The nameplate's data, whichever host it describes. */
export interface NameplateData {
  name: string;
  /** `${sshUser}@${machine}`, or just the machine when no user is known. */
  userMachine?: string;
  os?: string;
  kind?: HostKind;
  link?: string;
  agents?: number;
}

/** One rendered nameplate field after the name. */
export interface NameplateField {
  key: "userMachine" | "os" | "link" | "agents";
  text: string;
  /** Present on the OS field only: the kind glyph to draw before the text. */
  kind?: HostKind;
}

/**
 * The nameplate's post-name fields, in DISPLAY order. Folding drops from the
 * END of this list (agents, link, OS+kind, user@machine), so the order here
 * is the fold priority. Fields without data are omitted.
 */
export function nameplateFields(data: NameplateData): NameplateField[] {
  const fields: NameplateField[] = [];
  if (data.userMachine) fields.push({ key: "userMachine", text: data.userMachine });
  if (data.os !== undefined || data.kind !== undefined) {
    fields.push({ key: "os", text: data.os !== undefined ? osLabel(data.os) : "", kind: data.kind });
  }
  if (data.link) fields.push({ key: "link", text: data.link });
  if (data.agents !== undefined) {
    fields.push({
      key: "agents",
      text: `${data.agents} ${data.agents === 1 ? "agent" : "agents"}`,
    });
  }
  return fields;
}

/**
 * How many post-name fields fit: fold right-to-left from the full set until
 * the name plus the kept fields fit `available`. The name itself never folds
 * (it truncates), so the result is at least 0. `fieldWidths` are the fields'
 * natural widths in display order — each already includes its leading `·`
 * separator (the separator is the field's own `::before`).
 */
export function visibleFieldCount(
  nameWidth: number,
  fieldWidths: readonly number[],
  available: number,
): number {
  let used = nameWidth;
  let count = 0;
  for (const w of fieldWidths) {
    const next = used + w;
    if (next > available) break;
    used = next;
    count++;
  }
  return count;
}

/** Nameplate data for a host entry that is NOT this view's own (hover
 *  preview): the origin-derived kind/link plus whatever the host's own SPA
 *  reported to the shell — older shells report nothing, leaving the name only. */
export function previewNameplate(server: ShellServer): NameplateData {
  const reach = hostReach(server.url);
  const hasReport = server.machine !== undefined || server.os !== undefined || server.agents !== undefined;
  if (!hasReport) return { name: server.name };
  return {
    name: server.name,
    userMachine: server.machine,
    os: server.os,
    kind: reach.kind,
    link: reach.link,
    agents: server.agents,
  };
}

// ── Band light ───────────────────────────────────────────────────────────────

/** Distance the light extends past the last visible nameplate field. */
const LIGHT_TAIL_PX = 22;
/** Light end when the nameplate is empty: past the active square. */
const LIGHT_EMPTY_REACH_PX = 40;

/** `--ax`: the active square's centre x within the band row. */
export function lightAx(offsetLeft: number, width: number): number {
  return offsetLeft + width / 2;
}

/** `--dx`: where the light's panel ends — the last visible nameplate field's
 *  right edge plus a tail, or just past the square when the nameplate is empty. */
export function lightDx(lastFieldRight: number | null, ax: number): number {
  return lastFieldRight === null ? ax + LIGHT_EMPTY_REACH_PX : lastFieldRight + LIGHT_TAIL_PX;
}

// ── Strip prefs (mirrors app/desktop/src/prefs.ts) ───────────────────────────

export const STRIP_EFFECTS = ["glow", "livery", "halftone", "hex", "scan", "edge", "flat"] as const;
export type StripEffect = (typeof STRIP_EFFECTS)[number];
export const STRIP_MOTIONS = ["slide", "sweep", "cut"] as const;
export type StripMotion = (typeof STRIP_MOTIONS)[number];

export const DEFAULT_STRIP_EFFECT: StripEffect = "glow";
export const DEFAULT_STRIP_MOTION: StripMotion = "slide";

export function isStripEffect(value: unknown): value is StripEffect {
  return typeof value === "string" && STRIP_EFFECTS.some((e) => e === value);
}

export function isStripMotion(value: unknown): value is StripMotion {
  return typeof value === "string" && STRIP_MOTIONS.some((m) => m === value);
}

export interface StripPrefs {
  effect: StripEffect;
  motion: StripMotion;
}

/** Strict parse of the shell's `{ strip: { effect, motion } }` payload; any
 *  malformed or unknown value rejects the whole payload (null). */
export function parseStripPrefs(value: unknown): StripPrefs | null {
  if (typeof value !== "object" || value === null || !("strip" in value)) return null;
  const strip = value.strip;
  if (typeof strip !== "object" || strip === null) return null;
  if (!("effect" in strip) || !("motion" in strip)) return null;
  if (!isStripEffect(strip.effect) || !isStripMotion(strip.motion)) return null;
  return { effect: strip.effect, motion: strip.motion };
}

/** Reduced-motion users always get `cut`, whatever they chose. */
export function effectiveMotion(motion: StripMotion, reducedMotion: boolean): StripMotion {
  return reducedMotion ? "cut" : motion;
}
