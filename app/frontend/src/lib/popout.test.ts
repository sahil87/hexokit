import { describe, expect, it } from "vitest";
import { parseLayoutTree, type LayoutNode } from "./layout-tree";
import {
  isPopoutMessage,
  parsePopLeaf,
  poppedKey,
  popoutFeatures,
  popoutToggleAction,
  popoutToggleTarget,
  popoutUrl,
  popoutWindowName,
  POPOUT_FALLBACK_HEIGHT,
  POPOUT_FALLBACK_WIDTH,
  POPOUT_STALE_MS,
  readPopped,
  reducePopped,
  sweepStale,
  writePopped,
} from "./popout";

// The popped set is per-viewer localStorage (`rk-layout-popped:{server}:{@N}`)
// — every access tolerates unavailable/corrupt storage (Constitution II
// degrade-to-cold-start).
describe("popped-set storage", () => {
  it("reads an absent key as the empty set", () => {
    expect(readPopped("srv", "@5")).toEqual([]);
  });

  it("round-trips a leaf-id array", () => {
    writePopped("srv", "@5", ["tty", "@12/tty"]);
    expect(readPopped("srv", "@5")).toEqual(["tty", "@12/tty"]);
  });

  it("reads a corrupt value as the empty set", () => {
    localStorage.setItem(poppedKey("srv", "@5"), "not json");
    expect(readPopped("srv", "@5")).toEqual([]);
  });

  it("reads a non-array or non-string entries as the empty/dropped set", () => {
    localStorage.setItem(poppedKey("srv", "@5"), JSON.stringify({ leaf: "tty" }));
    expect(readPopped("srv", "@5")).toEqual([]);
    localStorage.setItem(poppedKey("srv", "@5"), JSON.stringify(["tty", 3, ""]));
    expect(readPopped("srv", "@5")).toEqual(["tty"]);
  });

  it("removes the key when the set empties", () => {
    writePopped("srv", "@5", ["tty"]);
    writePopped("srv", "@5", []);
    expect(localStorage.getItem(poppedKey("srv", "@5"))).toBeNull();
  });
});

// The opener renders removeLeaf of every popped id; ids absent from the
// current tree are ignored (and reported for pruning); an all-popped
// reduction yields null (the placeholder case — a layout never renders empty).
describe("reducePopped", () => {
  it("removes a bare leaf and lets siblings absorb its share", () => {
    const tree = parseLayoutTree("h(tty,code)");
    const { tree: out, present } = reducePopped(tree!, ["code"]);
    expect(out).toEqual({ leaf: "tty" });
    expect(present).toEqual(["code"]);
  });

  it("removes a duplicate bare tty occurrence by its numbered id", () => {
    const tree = parseLayoutTree("h(tty,tty)");
    const { tree: out, present } = reducePopped(tree!, ["tty#2"]);
    expect(out).toEqual({ leaf: "tty" });
    expect(present).toEqual(["tty#2"]);
  });

  it("removes both duplicate bare tty occurrences in reading order", () => {
    // Removing `tty` first renumbers `tty#2` down to `tty` — the reduction
    // must take the higher occurrence first regardless of input order.
    const tree = parseLayoutTree("h(tty,tty)");
    const { tree: out, present } = reducePopped(tree!, ["tty", "tty#2"]);
    expect(out).toBeNull();
    expect(present).toEqual(["tty", "tty#2"]);
  });

  it("removes a foreign leaf by its address", () => {
    const tree = parseLayoutTree("h(tty,@12/tty)");
    const { tree: out, present } = reducePopped(tree!, ["@12/tty"]);
    expect(out).toEqual({ leaf: "tty" });
    expect(present).toEqual(["@12/tty"]);
  });

  it("ignores ids absent from the tree (absent from `present`)", () => {
    const tree = parseLayoutTree("h(tty,code)");
    const { tree: out, present } = reducePopped(tree!, ["web", "code"]);
    expect(out).toEqual({ leaf: "tty" });
    expect(present).toEqual(["code"]);
  });

  it("returns null when every leaf is popped", () => {
    const tree = parseLayoutTree("h(tty,code)");
    const { tree: out, present } = reducePopped(tree!, ["tty", "code"]);
    expect(out).toBeNull();
    expect(present).toEqual(["tty", "code"]);
  });

  it("keeps the tree for an empty popped set", () => {
    const tree = parseLayoutTree("h(tty,code)");
    const { tree: out, present } = reducePopped(tree!, []);
    expect(out).toBe(tree);
    expect(present).toEqual([]);
  });
});

// The `?pop=` value validates against the leaf-id grammar; foreign gui,
// malformed values, and `/<n>` suffixes are rejected (the consumer degrades
// to the ordinary render). Window existence is the consumer's check.
describe("parsePopLeaf", () => {
  it("accepts bare kinds, keyed to the route window", () => {
    for (const kind of ["tty", "code", "web", "gui"] as const) {
      expect(parsePopLeaf(kind, "@5")).toEqual({ leafId: kind, kind, windowId: "@5" });
    }
  });

  it("accepts a duplicate bare tty occurrence (tty#2)", () => {
    expect(parsePopLeaf("tty#2", "@5")).toEqual({ leafId: "tty#2", kind: "tty", windowId: "@5" });
  });

  it("accepts a foreign leaf, keyed to its home window", () => {
    expect(parsePopLeaf("@12/tty", "@5")).toEqual({
      leafId: "@12/tty",
      kind: "tty",
      home: "@12",
      windowId: "@12",
    });
  });

  it("rejects a foreign gui (one desktop per host)", () => {
    expect(parsePopLeaf("@12/gui", "@5")).toBeNull();
  });

  it("rejects malformed values, unknown kinds, and suffix forms", () => {
    expect(parsePopLeaf("bogus", "@5")).toBeNull();
    expect(parsePopLeaf("@12/bogus", "@5")).toBeNull();
    expect(parsePopLeaf("@12/tty/2", "@5")).toBeNull();
    expect(parsePopLeaf("web#2", "@5")).toBeNull();
    expect(parsePopLeaf("tty#1", "@5")).toBeNull();
    expect(parsePopLeaf("@x/tty", "@5")).toBeNull();
  });

  it("rejects non-canonical occurrence suffixes leafIds() never emits", () => {
    expect(parsePopLeaf("tty#02", "@5")).toBeNull();
    expect(parsePopLeaf("tty#2.0", "@5")).toBeNull();
    expect(parsePopLeaf("tty#2e0", "@5")).toBeNull();
    expect(parsePopLeaf("tty#10", "@5")).toEqual({
      leafId: "tty#10",
      kind: "tty",
      windowId: "@5",
    });
  });
});

// window.open plumbing: the named window reuses on repeat pop-out; the URL is
// the terminal route with the encoded leaf id; features size from the tile
// rect with the 1200×800 fallback.
describe("popout window plumbing", () => {
  it("names the window rk-pop:{server}:{@N}:{leafId}", () => {
    expect(popoutWindowName("main", "@5", "tty")).toBe("rk-pop:main:@5:tty");
  });

  it("builds the terminal-route URL with the encoded leaf id", () => {
    expect(popoutUrl("main", "@5", "tty")).toBe("/main/5?pop=tty");
    expect(popoutUrl("main", "@5", "@12/tty")).toBe("/main/5?pop=%4012%2Ftty");
  });

  it("sizes features from the tile rect, falling back to 1200×800", () => {
    expect(popoutFeatures({ w: 640.4, h: 480.2 })).toBe("popup,width=640,height=480");
    expect(popoutFeatures()).toBe(
      `popup,width=${POPOUT_FALLBACK_WIDTH},height=${POPOUT_FALLBACK_HEIGHT}`,
    );
    expect(popoutFeatures({ w: 0, h: 0 })).toBe(
      `popup,width=${POPOUT_FALLBACK_WIDTH},height=${POPOUT_FALLBACK_HEIGHT}`,
    );
  });
});

// Channel traffic: malformed messages and wrong-shape values are ignored.
describe("isPopoutMessage", () => {
  it("accepts every message type with the full shape", () => {
    for (const type of ["opened", "alive", "closed", "pop-in", "ping"] as const) {
      expect(isPopoutMessage({ type, server: "main", window: "@5", leaf: "tty" })).toBe(true);
    }
  });

  it("rejects malformed shapes without throwing", () => {
    expect(isPopoutMessage(null)).toBe(false);
    expect(isPopoutMessage("opened")).toBe(false);
    expect(isPopoutMessage({ type: "opened" })).toBe(false);
    expect(isPopoutMessage({ type: "bogus", server: "main", window: "@5", leaf: "tty" })).toBe(false);
    expect(isPopoutMessage({ type: "opened", server: 1, window: "@5", leaf: "tty" })).toBe(false);
  });
});

// A mark with no opened/alive within POPOUT_STALE_MS drops out; the boundary
// itself is stale (>=).
describe("sweepStale", () => {
  it("keeps marks sighted inside the stale window", () => {
    const lastSeen = new Map([["tty", 1000]]);
    expect(sweepStale(["tty"], lastSeen, 1000 + POPOUT_STALE_MS - 1)).toEqual(["tty"]);
  });

  it("drops a mark at the stale boundary", () => {
    const lastSeen = new Map([["tty", 1000]]);
    expect(sweepStale(["tty"], lastSeen, 1000 + POPOUT_STALE_MS)).toEqual([]);
  });

  it("drops a never-sighted mark (no timestamp)", () => {
    expect(sweepStale(["tty"], new Map(), 1000)).toEqual([]);
  });

  it("sweeps per mark, not per set", () => {
    const lastSeen = new Map([
      ["tty", 1000],
      ["code", 1000 + POPOUT_STALE_MS - 10],
    ]);
    expect(sweepStale(["tty", "code"], lastSeen, 1000 + POPOUT_STALE_MS)).toEqual(["code"]);
  });
});

// The toggle's close-target selection: the kind's FIRST BARE leaf in reading
// order — a foreign leaf is never the close target.
describe("popoutToggleTarget", () => {
  it("selects the first bare leaf of the kind in reading order", () => {
    expect(popoutToggleTarget(parseLayoutTree("h(tty,tty)")!, "tty")).toBe("tty");
    expect(popoutToggleTarget(parseLayoutTree("h(web,tty)")!, "tty")).toBe("tty");
    expect(popoutToggleTarget(parseLayoutTree("h(tty,web)")!, "web")).toBe("web");
  });

  it("ignores foreign leaves and absent kinds (undefined ⇒ the toggle grows)", () => {
    expect(popoutToggleTarget(parseLayoutTree("h(tty,@12/code)")!, "code")).toBeUndefined();
    expect(popoutToggleTarget(parseLayoutTree("tty")!, "web")).toBeUndefined();
  });
});

// The popped-toggle guard's decision table. The null-vs-action contract IS
// the regression pin: a non-null action is the caller's whole toggle (no
// layout mutation), while null hands the kind back to the ordinary
// toggleSurface close/grow — the shape the unguarded path applied to EVERY
// toggle, popped or not.
describe("popoutToggleAction", () => {
  it("reveals a popped, unrevealed close target", () => {
    const tree = parseLayoutTree("h(tty,web)")!;
    expect(popoutToggleAction(tree, "tty", ["tty"], [])).toEqual({
      kind: "reveal",
      leafId: "tty",
    });
  });

  it("hides a popped, revealed close target", () => {
    const tree = parseLayoutTree("h(tty,web)")!;
    expect(popoutToggleAction(tree, "tty", ["tty"], ["tty"])).toEqual({
      kind: "hide",
      leafId: "tty",
    });
  });

  it("returns null for a non-popped close target (the ordinary toggleSurface path)", () => {
    const tree = parseLayoutTree("h(tty,web)")!;
    expect(popoutToggleAction(tree, "tty", [], [])).toBeNull();
    // Another leaf's popped mark never guards this kind's toggle.
    expect(popoutToggleAction(tree, "tty", ["web"], [])).toBeNull();
    expect(popoutToggleAction(tree, "tty", ["web"], ["web"])).toBeNull();
  });

  it("returns null when the kind has no bare leaf — a foreign leaf is never the close target", () => {
    const tree = parseLayoutTree("h(tty,@12/code)")!;
    expect(popoutToggleAction(tree, "code", ["@12/code"], [])).toBeNull();
  });

  it("decides by the FIRST bare leaf: a popped second occurrence stays a normal toggle", () => {
    const tree = parseLayoutTree("h(tty,tty)")!;
    // The close target is `tty` — not popped, so the toggle closes it even
    // though `tty#2` is popped.
    expect(popoutToggleAction(tree, "tty", ["tty#2"], [])).toBeNull();
    // Popped first occurrence → reveal `tty`; `tty#2` is never the target.
    expect(popoutToggleAction(tree, "tty", ["tty", "tty#2"], [])).toEqual({
      kind: "reveal",
      leafId: "tty",
    });
  });

  it("decides by the FIRST bare leaf under occurrence-indexed ids (web popped, web#2 not)", () => {
    // Duplicate bare non-tty kinds are grammar-illegal in a stored layout;
    // the node is hand-built to pin the occurrence-indexed selection rule
    // itself (leafIds numbers the second `web` as `web#2`).
    const tree: LayoutNode = { dir: "h", children: [{ leaf: "web" }, { leaf: "web" }] };
    expect(popoutToggleAction(tree, "web", ["web"], [])).toEqual({
      kind: "reveal",
      leafId: "web",
    });
    expect(popoutToggleAction(tree, "web", ["web#2"], [])).toBeNull();
  });
});
