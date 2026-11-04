import { describe, it, expect } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  ROOT_EDGE_PX,
  EDGE_BAND_FRACTION,
  EDGE_BAND_MIN_PX,
  EDGE_BAND_MAX_PX,
  MIN_TILE_W,
  MIN_TILE_H,
  edgeBand,
  hitTest,
  resolveDrop,
  rootZoneAt,
  zoneAt,
  zoneRegion,
  type DropHit,
  type DropResult,
} from "./layout-drop";
import {
  isCanonicalTree,
  isLeaf,
  leafIds,
  leaves,
  parseLayoutTree,
  serializeLayoutTree,
  structureSig,
  templateSizes,
  attachSizes,
  extractSizes,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSizes,
  type Rect,
  type SplitDir,
  type SurfaceKind,
} from "./layout-tree";

function parse(raw: string): LayoutNode {
  const tree = parseLayoutTree(raw);
  if (!tree) throw new Error(`fixture ${raw} does not parse`);
  return tree;
}

const ser = serializeLayoutTree;

/** A big box — comfortably over the size floor for every tree here. */
const BIG_BOX: Rect = { x: 0, y: 0, w: 1600, h: 1000 };

/** The move payload, or a throw — every expectation site wants the tree. */
function moveOf(result: DropResult): { tree: LayoutNode; sizes: LayoutSizes; destId: string } {
  if (result.kind !== "move") throw new Error(`expected a move, got ${result.kind}`);
  return result;
}

describe("edgeBand", () => {
  it("clamps the 25% fraction to [28, 110]", () => {
    expect(EDGE_BAND_FRACTION).toBe(0.25);
    expect(EDGE_BAND_MIN_PX).toBe(28);
    expect(EDGE_BAND_MAX_PX).toBe(110);
    expect(edgeBand(80)).toBe(28); // 20 clamps up
    expect(edgeBand(112)).toBe(28); // exactly the floor
    expect(edgeBand(200)).toBe(50);
    expect(edgeBand(400)).toBe(100);
    expect(edgeBand(440)).toBe(110); // exactly the cap
    expect(edgeBand(1000)).toBe(110); // 250 clamps down
  });
});

describe("zoneAt", () => {
  // The spec's worked example: a 420×280 tile — bands 105 (sides) and 70
  // (top/bottom).
  const rect: Rect = { x: 0, y: 0, w: 420, h: 280 };

  it("a point in no band is center; a point in one band is that side", () => {
    expect(zoneAt(rect, { x: 210, y: 140 })).toBe("center");
    expect(zoneAt(rect, { x: 50, y: 140 })).toBe("left");
    expect(zoneAt(rect, { x: 415, y: 140 })).toBe("right");
    expect(zoneAt(rect, { x: 210, y: 20 })).toBe("top");
    expect(zoneAt(rect, { x: 210, y: 275 })).toBe("bottom");
  });

  it("a corner goes to the deepest edge (the smallest distance/band ratio)", () => {
    // (5, 5): left 5/105 < top 5/70 — left wins despite equal distance.
    expect(zoneAt(rect, { x: 5, y: 5 })).toBe("left");
    // (100, 5): in both bands (100 < 105), but top 5/70 ≈ 0.07 beats left
    // 100/105 ≈ 0.95 — the shallower ratio loses.
    expect(zoneAt(rect, { x: 100, y: 5 })).toBe("top");
  });

  it("band edges: a point exactly at the band width is center", () => {
    expect(zoneAt(rect, { x: 105, y: 140 })).toBe("center");
    expect(zoneAt(rect, { x: 104.9, y: 140 })).toBe("left");
  });
});

describe("rootZoneAt", () => {
  const box: Rect = { x: 0, y: 0, w: 1200, h: 800 };

  it("fires within 18px of a box edge, nearest side wins a corner", () => {
    expect(ROOT_EDGE_PX).toBe(18);
    expect(rootZoneAt(box, { x: 10, y: 400 })).toBe("left");
    expect(rootZoneAt(box, { x: 1190, y: 400 })).toBe("right");
    expect(rootZoneAt(box, { x: 600, y: 5 })).toBe("top");
    expect(rootZoneAt(box, { x: 600, y: 795 })).toBe("bottom");
    expect(rootZoneAt(box, { x: 5, y: 10 })).toBe("left"); // corner: 5 < 10
    expect(rootZoneAt(box, { x: 10, y: 5 })).toBe("top");
    expect(rootZoneAt(box, { x: 18, y: 400 })).toBeNull(); // the boundary is excluded
    expect(rootZoneAt(box, { x: 600, y: 400 })).toBeNull();
  });
});

describe("hitTest", () => {
  const box: Rect = { x: 0, y: 0, w: 1200, h: 800 };
  // h(tty,code) at equal sizes with the 6px gutter.
  const rects = new Map<string, Rect>([
    ["tty", { x: 0, y: 0, w: 597, h: 800 }],
    ["code", { x: 603, y: 0, w: 597, h: 800 }],
  ]);

  it("null outside the box and in the gutter between tiles", () => {
    expect(hitTest(rects, box, { x: -1, y: 400 }, "tty")).toBeNull();
    expect(hitTest(rects, box, { x: 1201, y: 400 }, "tty")).toBeNull();
    expect(hitTest(rects, box, { x: 600, y: 400 }, "tty")).toBeNull(); // the 6px gutter
  });

  it("self over the dragged tile's own rect, center/edge on another tile", () => {
    expect(hitTest(rects, box, { x: 300, y: 400 }, "tty")).toEqual({ kind: "self" });
    expect(hitTest(rects, box, { x: 900, y: 400 }, "tty")).toEqual({
      kind: "center",
      targetId: "code",
    });
    // code's left band: edgeBand(597) = 110; x = 610 is 7px in.
    expect(hitTest(rects, box, { x: 610, y: 400 }, "tty")).toEqual({
      kind: "edge",
      targetId: "code",
      side: "left",
    });
  });

  it("the layout-edge band wins over a tile's band", () => {
    // 10px off the layout's left edge, inside tty's left band too.
    expect(hitTest(rects, box, { x: 10, y: 400 }, "code")).toEqual({
      kind: "root",
      side: "left",
    });
  });
});

describe("resolveDrop — the study's scenarios", () => {
  it("cancel on a null or self hit", () => {
    const tree = parse("h(tty,code)");
    expect(resolveDrop(tree, undefined, "tty", null, BIG_BOX).kind).toBe("cancel");
    expect(resolveDrop(tree, undefined, "tty", { kind: "self" }, BIG_BOX).kind).toBe("cancel");
  });

  it("the §7 example: h(tty,code,web), tty dropped on code's top edge → h(v(tty,code),web), halves throughout", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,code,web)"), undefined, "tty", {
        kind: "edge",
        targetId: "code",
        side: "top",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(v(tty,code),web)");
    // tty's third redistributes equally; the wrap is 50/50 inside code's share.
    expect(result.sizes).toHaveLength(2);
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.5, 6);
    expect(result.sizes[1][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[1][1]).toBeCloseTo(0.5, 6);
    expect(result.destId).toBe("tty");
    expect(structureSig(result.tree)).toBe("h(v(0,1),2)");
  });

  it("a layout-edge drop gives the dragged tile 50% of that axis (no 1/N special case)", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,code)"), undefined, "tty", { kind: "root", side: "bottom" }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("v(code,tty)");
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.5, 6);
  });

  it("a drop that rebuilds the input is a noop (h(tty,code), tty on code's left edge)", () => {
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, "tty", {
        kind: "edge",
        targetId: "code",
        side: "left",
      }, BIG_BOX).kind,
    ).toBe("noop");
  });

  it("a center swap of identical kinds is a noop (h(tty,tty))", () => {
    expect(
      resolveDrop(parse("h(tty,tty)"), undefined, "tty", {
        kind: "center",
        targetId: "tty#2",
      }, BIG_BOX).kind,
    ).toBe("noop");
  });

  it("too-small when a result leaf would break the floor in this viewer's box", () => {
    const small: Rect = { x: 0, y: 0, w: 400, h: 180 };
    // v(code,tty) at 0.5/0.5 in a 180px-tall box leaves ~87px rows.
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, "tty", { kind: "root", side: "bottom" }, small)
        .kind,
    ).toBe("too-small");
    expect(MIN_TILE_W).toBe(150);
    expect(MIN_TILE_H).toBe(100);
    // The same drop fits a taller box.
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, "tty", { kind: "root", side: "bottom" }, BIG_BOX)
        .kind,
    ).toBe("move");
  });
});

describe("resolveDrop — sizes carried through (study §6)", () => {
  it("the wrap takes the target's share and splits it 50/50; removal redistributes in proportion", () => {
    const tree = parse("h(tty,code,web)");
    const sizes: LayoutSizes = [[0.5, 0.3, 0.2]];
    // tty onto web's bottom: the wrap takes web's 0.2; removing tty leaves
    // code:wrap at 0.3:0.2 → 0.6:0.4; the wrap stays 50/50 inside.
    const result = moveOf(
      resolveDrop(tree, sizes, "tty", { kind: "edge", targetId: "web", side: "bottom" }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(code,v(web,tty))");
    expect(result.sizes[0][0]).toBeCloseTo(0.6, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.4, 6);
    expect(result.sizes[1][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[1][1]).toBeCloseTo(0.5, 6);
  });

  it("a same-direction wrap merges into the parent split, fractions multiplying through", () => {
    const tree = parse("h(tty,code,web)");
    const sizes: LayoutSizes = [[0.5, 0.3, 0.2]];
    // web onto code's left: the wrap merges into the root h — code's 0.3
    // share halves to 0.15/0.15; removing web renormalizes 0.5:0.15:0.15.
    const result = moveOf(
      resolveDrop(tree, sizes, "web", { kind: "edge", targetId: "code", side: "left" }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(tty,web,code)");
    expect(result.sizes).toHaveLength(1);
    expect(result.sizes[0][0]).toBeCloseTo(0.625, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.1875, 6);
    expect(result.sizes[0][2]).toBeCloseTo(0.1875, 6);
  });

  it("a center swap keeps sizes with the positions", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,code)"), [[0.7, 0.3]], "tty", {
        kind: "center",
        targetId: "code",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(code,tty)");
    expect(result.sizes[0][0]).toBeCloseTo(0.7, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.3, 6);
    expect(result.destId).toBe("tty");
  });

  it("a same-axis root drop keeps the destination at 50% of the axis (the merge's renormalization must not inflate it)", () => {
    // h(tty,code) at 1/3:2/3, code dropped on the left layout edge: the wrap
    // merges into the root h and removing the original code renormalizes
    // 0.5:1/6 → 0.75:0.25 — the destination must be restored to its half.
    const result = moveOf(
      resolveDrop(parse("h(tty,code)"), [[1 / 3, 2 / 3]], "code", {
        kind: "root",
        side: "left",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(code,tty)");
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.5, 6);
    expect(result.destId).toBe("code");
  });

  it("a same-axis root drop on a 3-leaf row: destination 50%, survivors split the rest in proportion", () => {
    // code out of the middle of h(tty,code,web) at 0.5:0.3:0.2 to the left
    // layout edge — tty:web keep their 0.5:0.2 proportion inside the other
    // half: 5/14 : 2/14.
    const result = moveOf(
      resolveDrop(parse("h(tty,code,web)"), [[0.5, 0.3, 0.2]], "code", {
        kind: "root",
        side: "left",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(code,tty,web)");
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(5 / 14, 6);
    expect(result.sizes[0][2]).toBeCloseTo(1 / 7, 6);
  });
});

describe("resolveDrop — duplicate tty leaves", () => {
  it("tracks the dragged leaf by identity, not kind (tty#2 to the layout's bottom)", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,tty,code)"), undefined, "tty#2", {
        kind: "root",
        side: "bottom",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("v(h(tty,code),tty)");
    // The dragged leaf is the SECOND tty's node: the original first tty keeps
    // the bare id, so the dragged leaf reads `tty#2` at its new position.
    expect(result.destId).toBe("tty#2");
  });
});

// The external-leaf mode: `resolveDrop`'s third parameter is the dragged
// leaf's ID for an internal drag (a leaf already in the tree) or the full
// `LayoutLeaf` for a leaf NOT yet in the tree (a sidebar-row borrow); hitTest
// accepts the same union. Only edge zones insert — center is a noop.
describe("resolveDrop — external leaf (not yet in the tree)", () => {
  const foreign: LayoutLeaf = { leaf: "tty", home: "@3" };

  it("the R10 example: tree tty, @3/tty on the tty tile's right edge → h(tty,@3/tty)", () => {
    const result = moveOf(
      resolveDrop(parse("tty"), undefined, foreign, {
        kind: "edge",
        targetId: "tty",
        side: "right",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(tty,@3/tty)");
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.5, 6);
    expect(result.destId).toBe("@3/tty");
  });

  it("a center hit is a noop — only edge zones insert", () => {
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, foreign, {
        kind: "center",
        targetId: "code",
      }, BIG_BOX).kind,
    ).toBe("noop");
  });

  it("a layout-edge hit spans the side, the new leaf taking 50% of the axis", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,code)"), undefined, foreign, { kind: "root", side: "left" }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(@3/tty,tty,code)");
    // The same-axis merge leaves the new leaf at half; no removal follows, so
    // the survivors split the rest in proportion.
    expect(result.sizes[0][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.25, 6);
    expect(result.sizes[0][2]).toBeCloseTo(0.25, 6);
    expect(result.destId).toBe("@3/tty");
  });

  it("sizes ride along: the wrap takes the target's share at 50/50", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,code)"), [[0.7, 0.3]], foreign, {
        kind: "edge",
        targetId: "code",
        side: "bottom",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(tty,v(code,@3/tty))");
    expect(result.sizes[0][0]).toBeCloseTo(0.7, 6);
    expect(result.sizes[0][1]).toBeCloseTo(0.3, 6);
    expect(result.sizes[1][0]).toBeCloseTo(0.5, 6);
    expect(result.sizes[1][1]).toBeCloseTo(0.5, 6);
  });

  it("too-small when the result breaks the floor in this viewer's box", () => {
    const small: Rect = { x: 0, y: 0, w: 400, h: 180 };
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, foreign, {
        kind: "edge",
        targetId: "code",
        side: "right",
      }, small).kind,
    ).toBe("too-small");
    expect(
      resolveDrop(parse("h(tty,code)"), undefined, foreign, {
        kind: "edge",
        targetId: "code",
        side: "right",
      }, BIG_BOX).kind,
    ).toBe("move");
  });

  it("cancel on a null or self hit and on an unknown target id", () => {
    const tree = parse("tty");
    expect(resolveDrop(tree, undefined, foreign, null, BIG_BOX).kind).toBe("cancel");
    expect(resolveDrop(tree, undefined, foreign, { kind: "self" }, BIG_BOX).kind).toBe("cancel");
    expect(
      resolveDrop(tree, undefined, foreign, {
        kind: "edge",
        targetId: "@9/tty",
        side: "right",
      }, BIG_BOX).kind,
    ).toBe("cancel");
  });

  it("a bare external leaf inserts too, taking the kind id at its new position", () => {
    const result = moveOf(
      resolveDrop(parse("web"), undefined, { leaf: "tty" }, {
        kind: "edge",
        targetId: "web",
        side: "right",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("h(web,tty)");
    expect(result.destId).toBe("tty");
  });

  it("hitTest accepts the external leaf — its address is no rect key, so no self hit", () => {
    const box: Rect = { x: 0, y: 0, w: 1200, h: 800 };
    const rects = new Map<string, Rect>([
      ["tty", { x: 0, y: 0, w: 597, h: 800 }],
      ["code", { x: 603, y: 0, w: 597, h: 800 }],
    ]);
    expect(hitTest(rects, box, { x: 300, y: 400 }, foreign)).toEqual({
      kind: "center",
      targetId: "tty",
    });
    expect(hitTest(rects, box, { x: 300, y: 400 }, "@3/tty")).toEqual({
      kind: "center",
      targetId: "tty",
    });
  });

  it("an internal drag of a foreign leaf keeps its home (the clone carries the whole leaf)", () => {
    const result = moveOf(
      resolveDrop(parse("h(tty,@3/tty)"), undefined, "@3/tty", {
        kind: "root",
        side: "bottom",
      }, BIG_BOX),
    );
    expect(ser(result.tree)).toBe("v(tty,@3/tty)");
    expect(result.destId).toBe("@3/tty");
  });
});

describe("zoneRegion", () => {
  const box: Rect = { x: 0, y: 0, w: 1200, h: 800 };
  const rects = new Map<string, Rect>([
    ["tty", { x: 0, y: 0, w: 597, h: 800 }],
    ["code", { x: 603, y: 0, w: 597, h: 800 }],
  ]);

  it("center is the target rect, an edge is that half, a root edge is that third", () => {
    expect(zoneRegion({ kind: "center", targetId: "code" }, rects, box)).toEqual(
      rects.get("code"),
    );
    expect(zoneRegion({ kind: "edge", targetId: "code", side: "left" }, rects, box)).toEqual({
      x: 603,
      y: 0,
      w: 298.5,
      h: 800,
    });
    expect(zoneRegion({ kind: "edge", targetId: "code", side: "bottom" }, rects, box)).toEqual({
      x: 603,
      y: 400,
      w: 597,
      h: 400,
    });
    expect(zoneRegion({ kind: "root", side: "left" }, rects, box)).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 800,
    });
    expect(zoneRegion({ kind: "root", side: "bottom" }, rects, box)).toEqual({
      x: 0,
      y: (2 * 800) / 3,
      w: 1200,
      h: 800 / 3,
    });
    expect(zoneRegion(null, rects, box)).toBeNull();
    expect(zoneRegion({ kind: "self" }, rects, box)).toBeNull();
  });
});

// ── Exhaustive invariants (R3) ─────────────────────────────────────────────

const KINDS: SurfaceKind[] = ["tty", "web", "code", "gui"];
const SIDES = ["left", "right", "top", "bottom"] as const;

/** All contiguous partitions of `items` into ≥2 non-empty runs. */
function compositions<T>(items: T[]): T[][][] {
  const out: T[][][] = [];
  const rec = (start: number, acc: T[][]): void => {
    if (start === items.length) {
      if (acc.length >= 2) out.push(acc.map((part) => [...part]));
      return;
    }
    for (let end = start + 1; end <= items.length; end++) {
      acc.push(items.slice(start, end));
      rec(end, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}

/** Every canonical tree over exactly this leaf sequence (a child split never
 *  has its parent's direction). */
function structureTrees(kinds: SurfaceKind[], parentDir: SplitDir | null): LayoutNode[] {
  if (kinds.length === 1) return [{ leaf: kinds[0] }];
  const out: LayoutNode[] = [];
  for (const dir of ["h", "v"] as const) {
    if (dir === parentDir) continue;
    for (const parts of compositions(kinds)) {
      let combos: LayoutNode[][] = [[]];
      for (const part of parts) {
        const sub = structureTrees(part, dir);
        combos = combos.flatMap((c) => sub.map((s) => [...c, s]));
      }
      for (const children of combos) out.push({ dir, children });
    }
  }
  return out;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** Every placement of N distinct kinds over every N-leaf structure. */
function allTrees(n: number): LayoutNode[] {
  return permutations(KINDS.slice(0, n)).flatMap((kinds) => structureTrees(kinds, null));
}

/** The sizes-shape invariant: one array per split (pre-order), each matching
 *  its split's child count and summing to 1. */
function expectWellShapedSizes(tree: LayoutNode, sizes: LayoutSizes): void {
  const counts: number[] = [];
  const walk = (n: LayoutNode): void => {
    if (isLeaf(n)) return;
    counts.push(n.children.length);
    n.children.forEach(walk);
  };
  walk(tree);
  expect(sizes.length).toBe(counts.length);
  sizes.forEach((fractions, i) => {
    expect(fractions.length).toBe(counts[i]);
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
}

const sortedKinds = (tree: LayoutNode) => [...leaves(tree)].sort();

describe("resolveDrop — exhaustive invariants for N ≤ 4", () => {
  // The study's counts: 4 / 36 / 528 placements for N = 2 / 3 / 4.
  it("enumerates the study's placement counts", () => {
    expect(allTrees(2)).toHaveLength(4);
    expect(allTrees(3)).toHaveLength(36);
    expect(allTrees(4)).toHaveLength(528);
  });

  // The N=4 sweep runs ~80k resolutions — well past the 5s default timeout
  // under a loaded full-suite machine.
  it.each([2, 3, 4])(
    "N=%i: every tree × dragged × target × zone keeps the invariants",
    (n) => {
      for (const tree of allTrees(n)) {
        const ids = leafIds(tree);
        for (const draggedId of ids) {
          const hits: DropHit[] = [
            ...ids
              .filter((id) => id !== draggedId)
              .flatMap((targetId): DropHit[] => [
                { kind: "center", targetId },
                ...SIDES.map((side): DropHit => ({ kind: "edge", targetId, side })),
              ]),
            ...SIDES.map((side): DropHit => ({ kind: "root", side })),
          ];
          for (const hit of hits) {
            for (const sizes of [undefined, templateSizes(tree)]) {
              const result = resolveDrop(tree, sizes, draggedId, hit, BIG_BOX);
              if (result.kind === "cancel") {
                throw new Error(`cancel on a real hit: ${ser(tree)} ${draggedId} ${hit.kind}`);
              }
              if (result.kind === "noop") continue; // no write — nothing to check
              if (result.kind === "too-small") continue; // never offered
              expect(isCanonicalTree(result.tree)).toBe(true);
              expect(result.tree).not.toBe(tree);
              expect(sortedKinds(result.tree)).toEqual(sortedKinds(tree));
              expect(leafIds(result.tree)).toHaveLength(n);
              expectWellShapedSizes(result.tree, result.sizes);
              // The destination id names the dragged kind at its new position.
              const destIndex = leafIds(result.tree).indexOf(result.destId);
              expect(destIndex).toBeGreaterThanOrEqual(0);
              expect(leaves(result.tree)[destIndex]).toBe(
                leaves(tree)[ids.indexOf(draggedId)],
              );
            }
          }
        }
      }
    },
    30_000,
  );

  it.each([2, 3, 4])("N=%i: a center drop is an involution (tree AND sizes)", (n) => {
    for (const tree of allTrees(n)) {
      const ids = leafIds(tree);
      for (const draggedId of ids) {
        for (const targetId of ids) {
          if (targetId === draggedId) continue;
          const sizes = templateSizes(tree);
          const first = moveOf(
            resolveDrop(tree, sizes, draggedId, { kind: "center", targetId }, BIG_BOX),
          );
          const second = moveOf(
            resolveDrop(first.tree, first.sizes, draggedId, { kind: "center", targetId }, BIG_BOX),
          );
          expect(ser(second.tree)).toBe(ser(tree));
          expect(second.sizes).toEqual(extractSizes(attachSizes(tree, sizes)));
        }
      }
    }
  }, 30_000);
});
