import { describe, it, expect } from "vitest";
import {
  WEB_TAB_ACTIVE_FLOOR_W,
  WEB_TAB_ICON_THRESHOLD_W,
  WEB_TAB_ICON_W,
  WEB_TAB_MAX_W,
  sizeWebTabs,
} from "./web-tab-ladder";

describe("sizeWebTabs", () => {
  it("caps every tab at the max width when the even share exceeds it", () => {
    const r = sizeWebTabs(2, 1000, 0);
    expect(r.widths).toEqual([WEB_TAB_MAX_W, WEB_TAB_MAX_W]);
    expect(r.iconOnly).toEqual([false, false]);
    expect(r.scroll).toBe(false);
  });

  it("shrinks every tab evenly when the share is between the floor and the max", () => {
    expect(sizeWebTabs(4, 760, 0).widths).toEqual([190, 190, 190, 190]);
    expect(sizeWebTabs(5, 600, 2).widths).toEqual([120, 120, 120, 120, 120]);
    expect(sizeWebTabs(5, 600, 2).scroll).toBe(false);
  });

  it("floors the active tab once the even share drops below it", () => {
    // 760 / 8 = 95 < 110 → the active entry keeps 110, the rest share 650/7.
    const r = sizeWebTabs(8, 760, 3);
    expect(r.widths).toEqual([92, 92, 92, WEB_TAB_ACTIVE_FLOOR_W, 92, 92, 92, 92]);
    expect(r.iconOnly).toEqual(Array(8).fill(false));
    expect(r.scroll).toBe(false);
  });

  it("floors the active tab while labelled inactives share the remainder", () => {
    const r = sizeWebTabs(9, 760, 4);
    expect(r.widths).toEqual([81, 81, 81, 81, WEB_TAB_ACTIVE_FLOOR_W, 81, 81, 81, 81]);
    expect(r.iconOnly).toEqual(Array(9).fill(false));
    expect(r.scroll).toBe(false);
  });

  it("keeps inactive tabs labelled at exactly the icon threshold share", () => {
    // share = (830 - 110) / 10 = 72 → labelled.
    const r = sizeWebTabs(11, 830, 0);
    expect(r.widths[1]).toBe(WEB_TAB_ICON_THRESHOLD_W);
    expect(r.iconOnly).toEqual(Array(11).fill(false));
  });

  it("drops inactive tabs below the threshold to icon-only at their share width", () => {
    const r = sizeWebTabs(12, 760, 3);
    expect(r.widths).toEqual([59, 59, 59, WEB_TAB_ACTIVE_FLOOR_W, 59, 59, 59, 59, 59, 59, 59, 59]);
    expect(r.iconOnly).toEqual([
      true, true, true, false, true, true, true, true, true, true, true, true,
    ]);
    expect(r.scroll).toBe(false);
  });

  it("floors icon-only tabs at the icon width and scrolls when they no longer fit", () => {
    const r = sizeWebTabs(16, 400, 0);
    expect(r.widths[0]).toBe(WEB_TAB_ACTIVE_FLOOR_W);
    expect(r.widths.slice(1)).toEqual(Array(15).fill(WEB_TAB_ICON_W));
    expect(r.iconOnly.slice(1)).toEqual(Array(15).fill(true));
    expect(r.scroll).toBe(true);
  });

  it("does not scroll while icon-only tabs at the floor still fit", () => {
    // 110 + 15*34 = 620 ≤ 640 → no scroll.
    expect(sizeWebTabs(16, 640, 0).scroll).toBe(false);
  });

  it("handles an empty family without division", () => {
    expect(sizeWebTabs(0, 500, 0)).toEqual({ widths: [], iconOnly: [], scroll: false });
  });

  it("handles a single entry", () => {
    expect(sizeWebTabs(1, 500, 0).widths).toEqual([WEB_TAB_MAX_W]);
    expect(sizeWebTabs(1, 150, 0).widths).toEqual([150]);
    expect(sizeWebTabs(1, 80, 0).widths).toEqual([WEB_TAB_ACTIVE_FLOOR_W]);
  });

  it("treats a draft index like any other active entry", () => {
    // Three declared tabs + one selected draft at index 3.
    const r = sizeWebTabs(4, 300, 3);
    expect(r.widths[3]).toBe(WEB_TAB_ACTIVE_FLOOR_W);
    expect(r.widths.slice(0, 3)).toEqual([63, 63, 63]);
    expect(r.iconOnly).toEqual([true, true, true, false]);
  });
});
