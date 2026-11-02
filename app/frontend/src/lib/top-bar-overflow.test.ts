import { describe, it, expect } from "vitest";
import { computeFit, computeVisibleCount, orderForFit } from "./top-bar-overflow";

describe("computeVisibleCount", () => {
  it("returns all items when everything fits", () => {
    // 3 items of 20px + 2 gaps of 4px = 68px, plenty of budget.
    expect(computeVisibleCount(500, [20, 20, 20], 0, 4)).toBe(3);
  });

  it.each([
    [0, [20, 20], 0],
    [-50, [20], 0],
    [30, [20, 20], 30],
    [100, [20, 20], 90],
    [500, [], 0],
  ] as const)("returns 0 for exhausted budget %#", (available, widths, reserved) => {
    expect(computeVisibleCount(available, [...widths], reserved, 4)).toBe(0);
  });

  it("fits only the first K leading items under pressure", () => {
    // budget = 100. Items [30, 30, 30] with 4px gaps:
    //  1 item  = 30
    //  2 items = 30 + 4 + 30 = 64
    //  3 items = 64 + 4 + 30 = 98  (fits!) → but tighten to force K=2 below.
    expect(computeVisibleCount(98, [30, 30, 30], 0, 4)).toBe(3);
    expect(computeVisibleCount(97, [30, 30, 30], 0, 4)).toBe(2);
    expect(computeVisibleCount(63, [30, 30, 30], 0, 4)).toBe(1);
  });

  it("charges a gap only BETWEEN rendered items (n items → n-1 gaps)", () => {
    // Single item: no gap charged. 20px item fits exactly in a 20px budget.
    expect(computeVisibleCount(20, [20, 20], 0, 4)).toBe(1);
    // Two items need one 4px gap: 20 + 4 + 20 = 44.
    expect(computeVisibleCount(44, [20, 20], 0, 4)).toBe(2);
    expect(computeVisibleCount(43, [20, 20], 0, 4)).toBe(1);
  });

  it("subtracts reserved space before fitting (exempt items + chevron + dot)", () => {
    // reserved 40px for exempt block; 60px available → 20px budget → 1 of two 20px items.
    expect(computeVisibleCount(60, [20, 20], 40, 4)).toBe(1);
    // Widen so both fit: 40 reserved + 20 + 4 + 20 = 84.
    expect(computeVisibleCount(84, [20, 20], 40, 4)).toBe(2);
  });

  it("respects varied (measured, non-uniform) child widths in order", () => {
    // Items with different real widths (chip-like, button-like, coarse sizing).
    // budget = 120. [50, 30, 24, 24] with 4px gaps:
    //  1 = 50
    //  2 = 50 + 4 + 30 = 84
    //  3 = 84 + 4 + 24 = 112
    //  4 = 112 + 4 + 24 = 140 (> 120) → K=3
    expect(computeVisibleCount(120, [50, 30, 24, 24], 0, 4)).toBe(3);
  });

});

describe("orderForFit", () => {
  it("moves dropLast entries to the tail and keeps each half's relative order", () => {
    const entries = [
      { id: "toggles", dropLast: true },
      { id: "open" },
      { id: "layout" },
      { id: "refresh" },
      { id: "settings" },
    ];
    expect(orderForFit(entries).map((e) => e.id)).toEqual(["open", "layout", "refresh", "settings", "toggles"]);
  });

  it("is the identity when nothing is dropLast", () => {
    const entries: { id: string; dropLast?: boolean }[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderForFit(entries).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("makes a dropLast entry the last to overflow under pressure", () => {
    // Widths keyed by fit order; the fit keeps a SUFFIX of the reversed order.
    const entries = [
      { id: "toggles", dropLast: true, w: 90 },
      { id: "open", w: 60 },
      { id: "layout", w: 30 },
      { id: "settings", w: 30 },
    ];
    const order = orderForFit(entries);
    const widths = order.map((e) => e.w).reverse(); // tail first
    // Budget for the toggles alone (+ nothing else).
    const n = computeVisibleCount(100, widths, 0, 4);
    const kept = order.slice(order.length - n).map((e) => e.id);
    expect(kept).toEqual(["toggles"]);
  });
});

describe("computeFit", () => {
  // Tail-first items: [settings 30, refresh 30, launcher 80 (compact 30)].
  // Full row = 30 + 4 + 30 + 4 + 80 = 148; folded row = 30 + 4 + 30 + 4 + 30 = 98.
  const items = [{ width: 30 }, { width: 30 }, { width: 80, compactWidth: 30 }];

  it("keeps every candidate at full width when everything fits", () => {
    expect(computeFit(148, items, 0, 4, false)).toEqual({ count: 3, compact: false });
  });

  it("folds the compact-capable entry before any candidate overflows", () => {
    expect(computeFit(147, items, 0, 4, false)).toEqual({ count: 3, compact: true });
    expect(computeFit(98, items, 0, 4, false)).toEqual({ count: 3, compact: true });
  });

  it("overflows only after the fold is exhausted", () => {
    expect(computeFit(97, items, 0, 4, false)).toEqual({ count: 2, compact: true });
  });

  it("stays folded inside the hysteresis band and expands only past it", () => {
    expect(computeFit(148, items, 0, 4, true, 24)).toEqual({ count: 3, compact: true });
    expect(computeFit(171, items, 0, 4, true, 24)).toEqual({ count: 3, compact: true });
    expect(computeFit(172, items, 0, 4, true, 24)).toEqual({ count: 3, compact: false });
  });

  it("is a plain greedy fit when no entry carries a compact form", () => {
    expect(computeFit(97, [{ width: 30 }, { width: 30 }, { width: 30 }], 0, 4, true)).toEqual({
      count: 2,
      compact: false,
    });
  });

  it("subtracts the reserved width in both rungs", () => {
    expect(computeFit(148 + 40, items, 40, 4, false)).toEqual({ count: 3, compact: false });
    expect(computeFit(98 + 40, items, 40, 4, false)).toEqual({ count: 3, compact: true });
  });
});
