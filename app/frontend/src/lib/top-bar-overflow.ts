/**
 * Pure fit computation for the top-bar right-cluster overflow (260715-h1ck).
 * Follows the `lib/palette/*.ts` pure-helper pattern: dependency-free and
 * unit-testable without mounting the shell. The measurement wiring (the
 * ResizeObserver + child-width reads) lives in the component; this module owns
 * ONLY the arithmetic of "how many leading items fit".
 *
 * The right cluster degrades as a priority+ overflow menu: the exempt trailing
 * items (chevron, dot) always render, and the ordered non-exempt fit candidates
 * (`menuOnly` entries such as fixed-width / terminal-font / close-pane are
 * excluded by the caller and
 * never fitted, 260731-oiho) are consumed FROM THE FRONT of the REGISTRY as
 * width shrinks (L1 drops before L2 before L3 — the `split` control is the
 * first to yield). This function itself is direction-agnostic: it greedily fits from
 * index 0 of whatever `itemWidths` array the caller supplies, and returns how
 * many of THOSE leading entries fit. Because the surviving in-bar set must be a
 * SUFFIX of the registry order, the TopBar caller passes the widths REVERSED
 * (L3-end first) and then slices the returned count off the tail — so the
 * returned N maps to the LAST N registry items, not the leading ones. Keep that
 * reversal in mind: "leading" here means leading in the array as given, which
 * the caller has inverted relative to display order.
 */

/**
 * How many of the ordered non-exempt items fit in `availableWidth` once
 * `reservedWidth` (the trailing exempt chevron + dot + their gap) is set aside.
 *
 * Items are fit greedily from index 0. A gap of `gap` px is charged BETWEEN
 * rendered items only (n items ⇒ n−1 gaps), matching a flex row's `gap`
 * behavior — the reserved block already accounts for the gaps on its own side.
 *
 * Edge cases:
 *  - `availableWidth <= 0` or a budget (`availableWidth - reservedWidth`) that
 *    cannot fit even the first item ⇒ 0 (everything overflows).
 *  - every item fits ⇒ `itemWidths.length` (nothing overflows).
 *
 * All inputs are treated as measured pixel values; nothing is hardcoded here.
 */
export function computeVisibleCount(
  availableWidth: number,
  itemWidths: number[],
  reservedWidth: number,
  gap: number,
): number {
  const budget = availableWidth - reservedWidth;
  if (budget <= 0) return 0;

  let used = 0;
  let count = 0;
  for (const w of itemWidths) {
    // Charge a gap before every item except the first rendered one.
    const next = used + (count > 0 ? gap : 0) + w;
    if (next > budget) break;
    used = next;
    count += 1;
  }
  return count;
}

/**
 * Order fit candidates for the overflow fit: the pyramid order (registry
 * order — L1 first, so it drops first) with `dropLast` entries moved to the
 * TAIL, so they are the last to overflow. The caller keeps rendering the bar
 * in registry order; only the fit consumes this order (and its measurement
 * probe renders in it, so measured widths stay index-aligned). Stable: the
 * relative order inside each half is preserved.
 */
export function orderForFit<T extends { dropLast?: boolean }>(entries: readonly T[]): T[] {
  return [...entries.filter((e) => !e.dropLast), ...entries.filter((e) => e.dropLast)];
}

/** One-sided hysteresis on the compact → full EXPAND edge, in px (the
 *  `nextHeadRung` / crumb-collapse precedent): a drag hovering the boundary
 *  cannot flap the label on and off. */
export const TOP_BAR_COMPACT_HYSTERESIS_PX = 24;

/** One fit candidate's measured widths: its full bar form and, for entries
 *  that carry a compact form, the compact one. */
export type FitItem = { width: number; compactWidth?: number };

export type FitResult = { count: number; compact: boolean };

/**
 * Two-rung fit. Fits every candidate at full width when it can; otherwise every
 * compact-capable candidate folds to its compact form BEFORE any candidate
 * overflows, then the usual greedy fit runs over the folded widths. `items` is
 * in the same direction as `computeVisibleCount`'s `itemWidths` (tail-first).
 *
 * `wasCompact` is the previous result's `compact`: staying folded needs no
 * proof, but returning to full needs `hysteresisPx` of spare room on top of the
 * full fit, so the boundary cannot flap. Entries without a `compactWidth` keep
 * their full width in both rungs.
 */
export function computeFit(
  availableWidth: number,
  items: FitItem[],
  reservedWidth: number,
  gap: number,
  wasCompact: boolean,
  hysteresisPx: number = TOP_BAR_COMPACT_HYSTERESIS_PX,
): FitResult {
  const full = items.map((i) => i.width);
  if (!items.some((i) => i.compactWidth !== undefined)) {
    return { count: computeVisibleCount(availableWidth, full, reservedWidth, gap), compact: false };
  }
  const slack = wasCompact ? hysteresisPx : 0;
  if (computeVisibleCount(availableWidth - slack, full, reservedWidth, gap) === items.length) {
    return { count: items.length, compact: false };
  }
  const folded = items.map((i) => i.compactWidth ?? i.width);
  return { count: computeVisibleCount(availableWidth, folded, reservedWidth, gap), compact: true };
}
