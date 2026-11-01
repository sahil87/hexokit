import { describe, it, expect, beforeEach } from "vitest";
import {
  availableSurfaces,
  panelStorageKey,
  readStoredPanel,
  clampRatio,
  clampSiblingFraction,
} from "./right-panel";
import type { ViewWindow } from "./window-view";

const webWin: ViewWindow = { webTabs: ["http://localhost:8080"] };
const plain: ViewWindow = {};

beforeEach(() => {
  localStorage.clear();
});

describe("availableSurfaces", () => {
  // The registry is the SHARED tileable-surface
  // registry (`availableTiles`): `tty` and `web` are always available (`tty`
  // first), then `code` per capability.
  it("offers tty first, then web — unconditionally (260821-zqlq)", () => {
    expect(availableSurfaces(webWin)).toEqual(["tty", "web"]);
    expect(availableSurfaces(plain)).toEqual(["tty", "web"]);
    expect(availableSurfaces(null)).toEqual(["tty", "web"]);
    expect(availableSurfaces(undefined)).toEqual(["tty", "web"]);
  });

  // The `code` surface (260811-k3vp, simplified by 260811-a2bo) mirrors the
  // view registry's gate: gitRoot derived (the port resolves by convention).
  // Registry order is tty, code, web (surface-layout R8).
  it("offers code exactly when gitRoot is set", () => {
    const codeWin: ViewWindow = { gitRoot: "/repo" };
    expect(availableSurfaces(codeWin)).toEqual(["tty", "code", "web"]);
    expect(availableSurfaces({ webTabs: ["http://localhost:8080"], gitRoot: "/repo" }))
      .toEqual(["tty", "code", "web"]);
  });

  it("gates code off without a gitRoot", () => {
    expect(availableSurfaces(plain)).toEqual(["tty", "web"]);
    expect(availableSurfaces(null)).toEqual(["tty", "web"]);
  });
});

describe("legacy panel storage key (read-only seed)", () => {
  it("builds the value-bearing per-window key", () => {
    expect(panelStorageKey("srv", "@3")).toBe("runkit-window-panel:srv:@3");
  });

  it("reads a stored surface under the window's key (absent = undefined)", () => {
    expect(readStoredPanel("srv", "@3")).toBeUndefined();
    localStorage.setItem(panelStorageKey("srv", "@3"), "web");
    expect(readStoredPanel("srv", "@3")).toBe("web");
  });

  it("scopes the key per server + window", () => {
    localStorage.setItem(panelStorageKey("srv", "@3"), "web");
    expect(readStoredPanel("srv", "@4")).toBeUndefined();
    expect(readStoredPanel("other", "@3")).toBeUndefined();
  });
});

describe("clampRatio", () => {
  // The divider-boundary clamp (260812-ab5v R5): the 280px floor bounds BOTH
  // sides, so the range is [floor, 100 − floor] — no 65% cap (a dominant main
  // tile is legitimate in `main-*` shapes).
  it("passes through an in-range percentage", () => {
    expect(clampRatio(50, 1000)).toBe(50);
  });

  it("applies the 280px floor on both sides of the boundary", () => {
    // 280px on a 1000px container = 28% on each side.
    expect(clampRatio(10, 1000)).toBeCloseTo(28);
    expect(clampRatio(90, 1000)).toBeCloseTo(72);
  });

  it("allows dominant tiles (no upper cap short of the far floor)", () => {
    expect(clampRatio(80, 2000)).toBe(80);
  });

  it("skips the floor when the container is unmeasured", () => {
    expect(clampRatio(10, 0)).toBe(10);
    expect(clampRatio(90, 0)).toBe(90);
  });

  it("collapses to 50/50 when the container cannot fit two floors", () => {
    // Below 2 × 280px the range [floor, 100 − floor] inverts; the boundary
    // must stay inside [0, 100] and treat both tiles alike.
    expect(clampRatio(10, 500)).toBe(50); // floor = 56%
    expect(clampRatio(90, 500)).toBe(50);
    expect(clampRatio(50, 200)).toBe(50); // floor = 140%
    expect(clampRatio(10, 200)).toBe(50);
  });

  it("still honors the floor at exactly two floors of width", () => {
    // 560px = 2 × 280px — the last width where the range is non-empty.
    expect(clampRatio(10, 560)).toBeCloseTo(50);
    expect(clampRatio(90, 560)).toBeCloseTo(50);
  });
});

describe("clampSiblingFraction", () => {
  // A divider drag edits only its two siblings' fractions (their combined
  // share is constant); the 280px floor bounds both sides of the pair's
  // combined extent.

  it("clamps the first sibling's fraction to the two-sided floor band", () => {
    // 1000px combined → floor = 0.28; the band is [0.28, 0.72].
    expect(clampSiblingFraction(0.5, 1000)).toBe(0.5);
    expect(clampSiblingFraction(0.1, 1000)).toBeCloseTo(0.28);
    expect(clampSiblingFraction(0.9, 1000)).toBeCloseTo(0.72);
  });

  it("skips the floor on a non-positive combined extent (unmeasured, jsdom)", () => {
    expect(clampSiblingFraction(0.1, 0)).toBeCloseTo(0.1);
    expect(clampSiblingFraction(0.9, 0)).toBeCloseTo(0.9);
  });

  it("collapses an inverted band to 50/50", () => {
    // Below 2 × 280px combined the floor band inverts and both siblings are
    // equally undersized rather than one being stranded.
    expect(clampSiblingFraction(0.1, 500)).toBe(0.5);
    expect(clampSiblingFraction(0.9, 500)).toBe(0.5);
    expect(clampSiblingFraction(0.5, 560)).toBe(0.5);
  });

});
