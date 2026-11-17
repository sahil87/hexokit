import { describe, it, expect } from "vitest";
import {
  selectionKey,
  splitSelectionKey,
  rangeBetween,
  singleSelectedServer,
  pruneSelection,
  openTabSeed,
} from "./selection";

// The pure logic behind the sidebar window-row multi-select. Covering the range
// arithmetic, single-server gate, and prune here proves the behavior without
// mounting the tree — the store and the sidebar are thin consumers of these.

describe("selectionKey / splitSelectionKey", () => {
  it("round-trips a (server, windowId) pair", () => {
    const key = selectionKey("rk-test", "@3");
    expect(key).toBe("rk-test:@3");
    expect(splitSelectionKey(key)).toEqual({ server: "rk-test", windowId: "@3" });
  });

  it("splits at the FIRST separator so a windowId containing ':' survives", () => {
    expect(splitSelectionKey("srv:@1:odd")).toEqual({
      server: "srv",
      windowId: "@1:odd",
    });
  });

  it("returns null for a key with no separator", () => {
    expect(splitSelectionKey("nope")).toBeNull();
  });
});

describe("rangeBetween", () => {
  const keys = ["s:@1", "s:@2", "s:@3", "s:@4"];

  it("returns the inclusive range when the anchor precedes the target", () => {
    expect(rangeBetween(keys, "s:@1", "s:@3")).toEqual(["s:@1", "s:@2", "s:@3"]);
  });

  it("is direction-independent — anchor after target yields the same range", () => {
    expect(rangeBetween(keys, "s:@3", "s:@1")).toEqual(["s:@1", "s:@2", "s:@3"]);
  });

  it("returns just the one key when anchor and target are the same row", () => {
    expect(rangeBetween(keys, "s:@2", "s:@2")).toEqual(["s:@2"]);
  });

  it("returns [] when the anchor is no longer visible", () => {
    expect(rangeBetween(keys, "s:@9", "s:@2")).toEqual([]);
  });

  it("returns [] when the target is not in the list", () => {
    expect(rangeBetween(keys, "s:@2", "s:@9")).toEqual([]);
  });

  it("returns [] for an empty visible list", () => {
    expect(rangeBetween([], "s:@1", "s:@2")).toEqual([]);
  });
});

describe("singleSelectedServer", () => {
  it("returns the shared server for a same-server selection", () => {
    expect(singleSelectedServer(["a:@1", "a:@2", "a:@7"])).toBe("a");
  });

  it("returns null for a cross-server selection", () => {
    expect(singleSelectedServer(["a:@1", "b:@1"])).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(singleSelectedServer([])).toBeNull();
  });

  it("returns null when a key is malformed", () => {
    expect(singleSelectedServer(["a:@1", "malformed"])).toBeNull();
  });
});

describe("pruneSelection", () => {
  it("drops keys whose rows are no longer live", () => {
    const selected = new Set(["s:@1", "s:@2"]);
    const next = pruneSelection(selected, new Set(["s:@1"]));
    expect([...next]).toEqual(["s:@1"]);
  });

  it("returns the SAME instance when every key is still live (no state churn)", () => {
    const selected = new Set(["s:@1", "s:@2"]);
    const next = pruneSelection(selected, new Set(["s:@1", "s:@2", "s:@3"]));
    expect(next).toBe(selected);
  });

  it("returns the same instance for an empty selection", () => {
    const selected: ReadonlySet<string> = new Set();
    expect(pruneSelection(selected, new Set(["s:@1"]))).toBe(selected);
  });

  it("drops everything when no rows are live", () => {
    const next = pruneSelection(new Set(["s:@1", "s:@2"]), new Set());
    expect(next.size).toBe(0);
  });
});

describe("openTabSeed", () => {
  const live = new Set(["s:@1", "s:@2"]);

  it("seeds the open tab when the selection is empty and the target is another row", () => {
    expect(openTabSeed(0, "s:@1", "s:@2", live)).toBe("seed");
  });

  it("is a no-op when the target is the open tab itself", () => {
    expect(openTabSeed(0, "s:@1", "s:@1", live)).toBe("noop");
  });

  it("does not seed once a selection is live", () => {
    expect(openTabSeed(2, "s:@1", "s:@2", live)).toBe("none");
  });

  it("does not seed without an open tab", () => {
    expect(openTabSeed(0, null, "s:@2", live)).toBe("none");
  });

  it("does not seed an open tab the tree does not know (ghost / unrendered)", () => {
    expect(openTabSeed(0, "s:@9", "s:@2", live)).toBe("none");
  });
});
