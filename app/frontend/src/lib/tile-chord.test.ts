import { describe, it, expect, vi } from "vitest";
import { tileChordHandler, type TileChordSeams } from "./tile-chord";
import type { SurfaceKind } from "@/lib/surface-layout";

/**
 * The tile-chord state machine (260819-qwr7 R4): the three-state branch table
 * (hidden / visible-unfocused / focused × tile count), the gating table (no window
 * route, mobile, unavailable surface, one-tile hide → NO handler so the chord
 * falls through untouched), and the applied-mutation guards (a refused toggle
 * arms no landing flag and runs no restore).
 */

function makeSeams(overrides: Partial<TileChordSeams> = {}) {
  const seams: TileChordSeams = {
    kind: "code",
    windowParam: "@1",
    isMobile: false,
    panelSurfaces: ["tty", "code"],
    order: ["tty", "code"],
    focusedTileKind: "tty",
    togglePanel: vi.fn(() => true),
    focusTile: vi.fn(),
    setLanding: vi.fn(),
    restoreAfterHide: vi.fn(),
    ...overrides,
  };
  return seams;
}

describe("tileChordHandler — gating (no handler mounts, the chord falls through)", () => {
  it("mounts no handler off the window route (no windowParam)", () => {
    expect(tileChordHandler(makeSeams({ windowParam: undefined }))).toBeUndefined();
  });

  it("mounts no handler on mobile", () => {
    expect(tileChordHandler(makeSeams({ isMobile: true }))).toBeUndefined();
  });

  it("mounts no handler for a surface the window cannot tile", () => {
    expect(
      tileChordHandler(makeSeams({ kind: "web", panelSurfaces: ["tty", "code"] })),
    ).toBeUndefined();
  });

  it("mounts no handler for the one-tile hide (the palette's Tile: Hide omission on single layouts)", () => {
    expect(
      tileChordHandler(
        makeSeams({ kind: "tty", panelSurfaces: ["tty"], order: ["tty"], focusedTileKind: "tty" }),
      ),
    ).toBeUndefined();
  });

  it("still mounts a handler with one tile when the kind is HIDDEN (the show arm stays live)", () => {
    expect(
      tileChordHandler(
        makeSeams({ kind: "code", panelSurfaces: ["tty", "code"], order: ["tty"] }),
      ),
    ).toBeTypeOf("function");
  });
});

describe("tileChordHandler — the three-state branch table", () => {
  it("hidden → open via togglePanel and arm the landing flag on an APPLIED open", () => {
    const seams = makeSeams({ order: ["tty"] });
    tileChordHandler(seams)!();
    expect(seams.togglePanel).toHaveBeenCalledWith("code");
    expect(seams.setLanding).toHaveBeenCalledWith("code");
    expect(seams.focusTile).not.toHaveBeenCalled();
    expect(seams.restoreAfterHide).not.toHaveBeenCalled();
  });

  it("hidden → a REFUSED open (full layout) arms no landing flag", () => {
    const seams = makeSeams({
      order: ["tty", "web"],
      panelSurfaces: ["tty", "code", "web"],
      togglePanel: vi.fn(() => false),
    });
    tileChordHandler(seams)!();
    expect(seams.togglePanel).toHaveBeenCalledWith("code");
    expect(seams.setLanding).not.toHaveBeenCalled();
  });

  it("visible + unfocused → focus via the focusTile seam, no layout mutation", () => {
    const seams = makeSeams({ focusedTileKind: "tty" });
    tileChordHandler(seams)!();
    expect(seams.focusTile).toHaveBeenCalledWith("code");
    expect(seams.togglePanel).not.toHaveBeenCalled();
    expect(seams.restoreAfterHide).not.toHaveBeenCalled();
  });

  it("focused with multiple tiles → hide via togglePanel, then restoreAfterHide with the hidden kind", () => {
    const seams = makeSeams({ focusedTileKind: "code" });
    tileChordHandler(seams)!();
    expect(seams.togglePanel).toHaveBeenCalledWith("code");
    expect(seams.restoreAfterHide).toHaveBeenCalledWith("code");
    expect(seams.focusTile).not.toHaveBeenCalled();
  });

  it("focused → a REFUSED hide runs no restore", () => {
    const seams = makeSeams({ focusedTileKind: "code", togglePanel: vi.fn(() => false) });
    tileChordHandler(seams)!();
    expect(seams.restoreAfterHide).not.toHaveBeenCalled();
  });

  it("race guard: a focused press observed with one tile (the render gap before re-gating) is a no-op", () => {
    // The handler closes over the seams object; simulate the layout having
    // collapsed to the focused tile ALONE before a stale handler fires.
    const order: SurfaceKind[] = ["tty", "code"];
    const seams = makeSeams({ order, focusedTileKind: "code" });
    const handler = tileChordHandler(seams)!;
    order.splice(order.indexOf("tty"), 1);
    handler();
    expect(seams.togglePanel).not.toHaveBeenCalled();
    expect(seams.focusTile).not.toHaveBeenCalled();
  });
});
