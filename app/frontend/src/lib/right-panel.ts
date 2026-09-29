/**
 * Pure helpers surviving from the right-panel surface model (originally
 * 260811-2r1w-right-panel-shell-web-surface; spec docs/specs/right-panel.md).
 * The single-panel slot model itself was superseded by the surface layout
 * manager (260812-ab5v, `lib/surface-layout.ts`); what remains here is the
 * shared surface-registry alias (`SurfaceName`/`availableSurfaces` — the rail
 * and layout consumers), the retired `runkit-window-panel` READ, kept one
 * release as an inbound-only translation input, and the layout-divider clamp.
 *
 * Everything here mirrors the `window-view.ts` pattern: pure and DOM-free
 * except a thin try/catch-noop localStorage read. Surface availability
 * derives from the same capability signals as the view registry (`hasWebUrl`
 * for `web`, `hasCode` for `code` — gitRoot-derived since 260811-a2bo, where
 * `gitRoot` carries the toplevel or, outside any repo, the raw cwd;
 * Constitution II/X).
 */

import type { GuiHost, ViewWindow } from "./window-view";
import { availableTiles, type SurfaceKind } from "./surface-layout";

/**
 * A named (substrate, lens) pairing rendered in the panel slot (spec § Surface
 * Registry). `web` is the phase-1 surface; `code` joined in phase 2
 * (260811-k3vp). Since 260812-ab5v (surface-layout R8) the registry is the
 * SHARED tileable-surface registry — `SurfaceName` is an alias of
 * `surface-layout.ts`'s `SurfaceKind` (itself `ViewName`), so the rail, the
 * layout manager, and the view switcher can never drift: `tty` (always
 * available, listed first) is a surface like any other.
 */
export type SurfaceName = SurfaceKind;

/**
 * The surfaces a window offers, in shortcut order — `tty`/`code`/`web`/`gui`
 * (the ⌘1/⌘2/⌘3/⌘4 positional digits) — per capability (gui keyed off the
 * threaded host signal's `enabled`).
 * Delegates to `surface-layout.ts`'s
 * `availableTiles` — the ONE registry rail + layout + switcher share — which
 * in turn keys off `window-view.ts`'s capability helpers (`hasCode` for
 * `code`) as the single
 * availability source. Reachability is NOT part of availability (it governs a
 * surface's content — live iframe vs the not-running empty state).
 */
export function availableSurfaces(
  win: ViewWindow | null | undefined,
  host?: GuiHost,
): SurfaceName[] {
  return availableTiles(win, host);
}

/**
 * Value-bearing per-window localStorage key (spec P1 — mirrors
 * `windowViewStorageKey`). Held the open surface NAME under the retired panel
 * model. RETIRED: nothing writes this key — it survives one release as an
 * inbound-only translation input: the route-entry translation effect reads it
 * (via `readStoredPanel`), translates it into `@rk_win_layout`, and deletes
 * it.
 */
export function panelStorageKey(server: string, windowId: string): string {
  return `runkit-window-panel:${server}:${windowId}`;
}

/**
 * Read the persisted open surface for a window — a one-release translation
 * input (see `panelStorageKey`). Returns `undefined` when absent or when
 * localStorage is unavailable (SSR/jsdom/quota) — the try/catch-noop pattern
 * from `window-view.ts`/`chrome-context.tsx`. The value is NOT validated here;
 * the translation consumer parses + degrades it.
 */
export function readStoredPanel(
  server: string,
  windowId: string,
): string | undefined {
  try {
    return localStorage.getItem(panelStorageKey(server, windowId)) ?? undefined;
  } catch {
    return undefined;
  }
}

// ── layout-divider clamp (surface-layout R5) ────────────────────────────────

/** Tile-size floor for divider drags: no tile may be dragged below 280px
 *  along the split axis. */
export const MIN_PANEL_WIDTH_PX = 280;

/**
 * Clamp a layout-divider boundary percentage (surface-layout R5,
 * 260812-ab5v): the 280px floor is converted to a percentage of the container
 * along the split axis and bounds BOTH sides (a divider may never strand a
 * tile below the floor), so the range is [floor, 100 − floor]. A non-positive
 * container size (unmeasured, jsdom) skips the floor. Neighbor-boundary
 * bounds (a divider may not cross its siblings) are applied by the caller,
 * which owns the ratios array.
 *
 * Below `2 × MIN_PANEL_WIDTH_PX` the container cannot honor the floor on both
 * sides at once and the range inverts (floor > 100 − floor); the boundary
 * collapses to 50/50 so both tiles are equally undersized rather than one
 * being stranded — the same "impossible bounds" guard the caller applies to
 * its neighbor boundaries.
 */
export function clampRatio(pct: number, containerPx: number): number {
  const floorPct = containerPx > 0 ? (MIN_PANEL_WIDTH_PX / containerPx) * 100 : 0;
  if (floorPct > 50) return 50;
  return Math.min(Math.max(pct, floorPct), 100 - floorPct);
}

/**
 * Clamp one divider drag to its two siblings' legal band: `raw` is the FIRST
 * sibling's proposed fraction of the pair's combined extent (`combinedPx`,
 * gutter excluded) along the split axis, and the 280px floor bounds BOTH
 * sides (`clampRatio`), so the range is [floor, 1 − floor]. The combined
 * share of the pair stays constant — a divider drag never disturbs any other
 * split or sibling.
 *
 * Below `2 × MIN_PANEL_WIDTH_PX` the pair cannot honor the floor on both
 * sides at once and the range inverts (floor > 1 − floor); the boundary
 * collapses to 50/50 so both siblings are equally undersized rather than one
 * being stranded.
 */
export function clampSiblingFraction(raw: number, combinedPx: number): number {
  return clampRatio(raw * 100, combinedPx) / 100;
}
