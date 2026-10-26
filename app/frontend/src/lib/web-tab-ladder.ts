/**
 * Web tab strip width ladder — a pure, DOM-free module (the `web-url.ts`
 * shape) owning the strip's sizing verdict. One function answers how wide
 * every entry (declared tabs + drafts, in strip order) renders for a measured
 * available width:
 *
 * 1. even share `w ≥ 200` → every tab capped at 200 (spare strip space stays
 *    empty — the double-click → draft target)
 * 2. `w ≥ 110` → every tab the floored even share
 * 3. else the ACTIVE entry floors at 110 and the inactive entries share the
 *    remainder; a share below 72 renders icon-only at its floored share width
 *    with a 34px floor (no empty run at the icon-only rung)
 * 4. the strip scrolls only when even icon-only tabs no longer fit
 */
export const WEB_TAB_MAX_W = 200;
export const WEB_TAB_ACTIVE_FLOOR_W = 110;
export const WEB_TAB_ICON_THRESHOLD_W = 72;
export const WEB_TAB_ICON_W = 34;

export interface WebTabSizing {
  widths: number[];
  /** Per entry: icon-only rendering (the label stays in the DOM visually
   *  hidden). The active entry is never icon-only. */
  iconOnly: boolean[];
  scroll: boolean;
}

export function sizeWebTabs(
  count: number,
  available: number,
  activeIndex: number,
): WebTabSizing {
  if (count <= 0) return { widths: [], iconOnly: [], scroll: false };
  const w = available / count;
  if (w >= WEB_TAB_MAX_W) {
    return { widths: Array(count).fill(WEB_TAB_MAX_W), iconOnly: Array(count).fill(false), scroll: false };
  }
  if (w >= WEB_TAB_ACTIVE_FLOOR_W) {
    return { widths: Array(count).fill(Math.floor(w)), iconOnly: Array(count).fill(false), scroll: false };
  }
  const share = count > 1 ? (available - WEB_TAB_ACTIVE_FLOOR_W) / (count - 1) : 0;
  const inactiveW = Math.max(Math.floor(share), WEB_TAB_ICON_W);
  const iconOnly = share < WEB_TAB_ICON_THRESHOLD_W;
  return {
    widths: Array.from({ length: count }, (_, i) =>
      i === activeIndex ? WEB_TAB_ACTIVE_FLOOR_W : inactiveW,
    ),
    iconOnly: Array.from({ length: count }, (_, i) => i !== activeIndex && iconOnly),
    scroll: WEB_TAB_ACTIVE_FLOOR_W + inactiveW * (count - 1) > available,
  };
}
