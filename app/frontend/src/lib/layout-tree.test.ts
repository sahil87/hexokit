import { describe, expect, it } from "vitest";
import {
  insertBeside,
  isCanonicalTree,
  isForeignLeaf,
  layoutDividers,
  layoutRects,
  leafAddress,
  leafIds,
  leaves,
  normalise,
  parseLeafAddress,
  parseLayoutTree,
  pathOf,
  pruneDeadLeaves,
  removeLeaf,
  serializeLayoutTree,
  slotOrder,
  structureSig,
  swapLeaves,
  templateOf,
  templatesFor,
  TEMPLATES,
  MAX_LAYOUT_LEN,
  type LayoutLeaf,
  type LayoutNode,
  type SplitDir,
  type SurfaceKind,
} from "./layout-tree";
import fixtures from "./layout-tree.fixtures.json";
import grammarFixtures from "./layout-grammar.fixtures.json";

// ── enumeration of every canonical placement (the study's 4 / 36 / 528) ────

const KINDS4: SurfaceKind[] = ["tty", "web", "code", "gui"];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

/** Ordered partitions of n into ≥2 positive parts. */
function compositions(n: number): number[][] {
  if (n < 2) return [];
  const out: number[][] = [];
  for (let first = 1; first < n; first++) {
    const rest = n - first;
    if (rest === 1) {
      out.push([first, 1]);
    } else {
      out.push([first, rest]);
      for (const tail of compositions(rest)) out.push([first, ...tail]);
    }
  }
  return out;
}

/** Every canonical node whose reading-order leaves are exactly `kinds`, as a
 *  child of a `parentDir` split (null = root). Children of a split cover
 *  contiguous reading-order segments, and a multi-leaf child of a split must
 *  split on the opposite direction. */
function treesOverSegment(kinds: SurfaceKind[], parentDir: SplitDir | null): LayoutNode[] {
  if (kinds.length === 1) return [{ leaf: kinds[0] }];
  const dirs: SplitDir[] = parentDir === null ? ["h", "v"] : [parentDir === "h" ? "v" : "h"];
  const out: LayoutNode[] = [];
  for (const dir of dirs) {
    for (const comp of compositions(kinds.length)) {
      let offset = 0;
      let acc: LayoutNode[][] = [[]];
      for (const part of comp) {
        const options = treesOverSegment(kinds.slice(offset, offset + part), dir);
        offset += part;
        acc = acc.flatMap((prefix) => options.map((o) => [...prefix, o]));
      }
      for (const children of acc) out.push({ dir, children });
    }
  }
  return out;
}

function allPlacements(n: number): LayoutNode[] {
  return permutations(KINDS4.slice(0, n)).flatMap((p) => treesOverSegment(p, null));
}

const sortedKinds = (t: LayoutNode) => [...leaves(t)].sort();

// ── shared fixture table (also read by the Go layoutspec tests) ─────────────

describe("shared fixture table (layout-tree.fixtures.json)", () => {
  for (const { input, expect: expected } of fixtures.parse) {
    it(`parse ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      const parsed = parseLayoutTree(input);
      expect(parsed === null ? null : serializeLayoutTree(parsed)).toBe(expected);
    });
  }
});

// ── shared grammar corpus (also read by the Go layoutspec tests) ────────────

interface GrammarCase {
  input: string;
  accept: boolean;
  owner?: string;
  expect?: string;
}

describe("shared grammar corpus (layout-grammar.fixtures.json)", () => {
  const cases: GrammarCase[] = grammarFixtures.grammar;
  for (const c of cases) {
    const ownerNote = c.owner !== undefined ? ` for owner ${c.owner}` : "";
    it(`${JSON.stringify(c.input)} → ${c.accept ? "accept" : "reject"}${ownerNote}`, () => {
      const parsed = parseLayoutTree(c.input);
      const ok = parsed !== null && isCanonicalTree(parsed, c.owner);
      expect(ok).toBe(c.accept);
      if (c.accept && parsed !== null) expect(serializeLayoutTree(parsed)).toBe(c.expect);
    });
  }
});

// ── grammar and canonical form ──────────────────────────────────────────────

describe("parseLayoutTree", () => {
  it("parses a nested tree into nodes", () => {
    expect(parseLayoutTree("h(tty,v(code,web))")).toEqual({
      dir: "h",
      children: [{ leaf: "tty" }, { dir: "v", children: [{ leaf: "code" }, { leaf: "web" }] }],
    });
  });

  it("round-trips every canonical tree with ≤ 3 leaves", () => {
    for (const n of [1, 2, 3]) {
      for (const t of allPlacements(n)) {
        expect(parseLayoutTree(serializeLayoutTree(t))).toEqual(t);
      }
    }
  });

  it("does not attach sizes to parsed trees", () => {
    const t = parseLayoutTree("h(tty,v(code,web))");
    expect(t && !("sizes" in t)).toBe(true);
  });

  it("rejects over-length input before recursing (the depth cap)", () => {
    const deep = "h(".repeat(200) + "tty" + ")".repeat(200);
    expect(deep.length).toBeGreaterThan(MAX_LAYOUT_LEN);
    expect(parseLayoutTree(deep)).toBeNull();
  });

  it("rejects a 513-byte input before parsing", () => {
    const wide = `h(tty,${"@1/tty,".repeat(85)}tty)`;
    expect(wide.length).toBeGreaterThan(MAX_LAYOUT_LEN);
    expect(parseLayoutTree(wide)).toBeNull();
  });

  it("parses a foreign leaf into home + kind", () => {
    expect(parseLayoutTree("h(tty,v(@12/tty,web))")).toEqual({
      dir: "h",
      children: [
        { leaf: "tty" },
        { dir: "v", children: [{ leaf: "tty", home: "@12" }, { leaf: "web" }] },
      ],
    });
  });

  it("serializes a foreign leaf back to its address (round-trip identity)", () => {
    const raw = "h(tty,v(@12/tty,web))";
    expect(serializeLayoutTree(parseLayoutTree(raw)!)).toBe(raw);
  });

  it("accepts a 6-leaf tree (no leaf-count cap)", () => {
    const six = "v(h(tty,code,web),h(@3/tty,@4/tty,@5/code))";
    const parsed = parseLayoutTree(six);
    expect(parsed).not.toBeNull();
    expect(serializeLayoutTree(parsed!)).toBe(six);
  });
});

describe("leafIds", () => {
  it("uses the kind for unique kinds and occurrence suffixes for duplicates", () => {
    expect(leafIds(parseLayoutTree("h(tty,v(code,web))")!)).toEqual(["tty", "code", "web"]);
    expect(leafIds(parseLayoutTree("h(tty,tty)")!)).toEqual(["tty", "tty#2"]);
  });

  it("uses the address string for foreign leaves", () => {
    expect(leafIds(parseLayoutTree("h(tty,@12/tty)")!)).toEqual(["tty", "@12/tty"]);
    expect(leafIds(parseLayoutTree("h(tty,tty,@12/tty)")!)).toEqual(["tty", "tty#2", "@12/tty"]);
    expect(leafIds(parseLayoutTree("h(web,@12/web)")!)).toEqual(["web", "@12/web"]);
  });
});

describe("address ids through the tree helpers", () => {
  it("pathOf and removeLeaf work on address ids", () => {
    const tree = parseLayoutTree("h(tty,@12/tty)")!;
    expect(pathOf(tree, "@12/tty")).toEqual([1]);
    expect(serializeLayoutTree(removeLeaf(tree, "@12/tty")!)).toBe("tty");
    expect(removeLeaf(tree, "@99/tty")).toBeNull();
  });

  it("swapLeaves carries a foreign leaf's home to the new position", () => {
    const tree = parseLayoutTree("h(tty,@12/web)")!;
    expect(serializeLayoutTree(swapLeaves(tree, "tty", "@12/web"))).toBe("h(@12/web,tty)");
    expect(swapLeaves(tree, "tty", "@99/web")).toBe(tree);
  });

  it("insertBeside accepts a foreign leaf and targets an address id", () => {
    const tree = parseLayoutTree("h(tty,tty,@12/tty)")!;
    const out = insertBeside(tree, pathOf(tree, "@12/tty")!, "right", {
      leaf: "code",
      home: "@9",
    });
    expect(serializeLayoutTree(out)).toBe("h(tty,tty,@12/tty,@9/code)");
    expect(isCanonicalTree(out)).toBe(true);
  });

  it("structureSig is address-agnostic (structure only)", () => {
    expect(structureSig(parseLayoutTree("h(tty,v(@12/tty,web))")!)).toBe("h(0,v(1,2))");
  });
});

describe("leaf address helpers", () => {
  it("isForeignLeaf and leafAddress reflect home", () => {
    const bare: LayoutLeaf = { leaf: "tty" };
    const foreign: LayoutLeaf = { leaf: "tty", home: "@12" };
    expect(isForeignLeaf(bare)).toBe(false);
    expect(isForeignLeaf(foreign)).toBe(true);
    expect(leafAddress(bare)).toBe("tty");
    expect(leafAddress(foreign)).toBe("@12/tty");
  });

  it("parseLeafAddress parses @N/kind and rejects other forms", () => {
    expect(parseLeafAddress("@12/tty")).toEqual({ home: "@12", kind: "tty" });
    expect(parseLeafAddress("@3/web")).toEqual({ home: "@3", kind: "web" });
    expect(parseLeafAddress("@7/gui")).toEqual({ home: "@7", kind: "gui" });
    expect(parseLeafAddress("tty")).toBeNull();
    expect(parseLeafAddress("@12/tty/2")).toBeNull();
    expect(parseLeafAddress("@x/tty")).toBeNull();
    expect(parseLeafAddress("@12")).toBeNull();
    expect(parseLeafAddress("12/tty")).toBeNull();
    expect(parseLeafAddress("@12/foo")).toBeNull();
  });
});

describe("isCanonicalTree owner rules", () => {
  it("rejects a foreign leaf naming the owner only when the owner matches", () => {
    const tree = parseLayoutTree("h(tty,@7/tty)")!;
    expect(isCanonicalTree(tree)).toBe(true);
    expect(isCanonicalTree(tree, "@8")).toBe(true);
    expect(isCanonicalTree(tree, "@7")).toBe(false);
  });

  it("lets a bare kind and a foreign leaf of the same kind coexist", () => {
    expect(isCanonicalTree(parseLayoutTree("h(web,@12/web)")!)).toBe(true);
  });
});

describe("pruneDeadLeaves", () => {
  it("removes foreign leaves whose home is dead and normalises", () => {
    const tree = parseLayoutTree("h(tty,v(@3/tty,web))")!;
    expect(serializeLayoutTree(pruneDeadLeaves(tree, ["@9"]))).toBe("h(tty,web)");
  });

  it("prunes only the dead addresses", () => {
    const tree = parseLayoutTree("h(tty,@3/tty,@4/tty)")!;
    expect(serializeLayoutTree(pruneDeadLeaves(tree, new Set(["@4"])))).toBe("h(tty,@4/tty)");
  });

  it("returns the identical tree when nothing is dead", () => {
    const tree = parseLayoutTree("h(tty,@3/tty)")!;
    expect(pruneDeadLeaves(tree, ["@3"])).toBe(tree);
  });

  it("falls back to a bare tty leaf when the tree empties", () => {
    expect(pruneDeadLeaves(parseLayoutTree("@3/tty")!, [])).toEqual({ leaf: "tty" });
    expect(pruneDeadLeaves(parseLayoutTree("h(@3/tty,@4/tty)")!, [])).toEqual({ leaf: "tty" });
  });

  it("keeps bare leaves regardless of the live set", () => {
    const tree = parseLayoutTree("h(tty,web)")!;
    expect(pruneDeadLeaves(tree, [])).toBe(tree);
  });
});

// ── exhaustive invariants over the study's enumeration (N ≤ 4) ─────────────

describe("exhaustive invariants (4 / 36 / 528 placements)", () => {
  it("enumerates the study's placement counts", () => {
    expect(allPlacements(2)).toHaveLength(4);
    expect(allPlacements(3)).toHaveLength(36);
    expect(allPlacements(4)).toHaveLength(528);
  });

  it("normalise is a fixpoint on canonical trees", () => {
    for (const n of [2, 3, 4]) {
      for (const t of allPlacements(n)) expect(normalise(t)).toEqual(t);
    }
  });

  it("swapLeaves is a canonical involution keeping the leaf multiset", () => {
    for (const n of [2, 3, 4]) {
      for (const t of allPlacements(n)) {
        const ids = leafIds(t);
        for (const a of ids) {
          for (const b of ids) {
            if (a === b) continue;
            const once = swapLeaves(t, a, b);
            expect(isCanonicalTree(once)).toBe(true);
            expect(sortedKinds(once)).toEqual(sortedKinds(t));
            expect(swapLeaves(once, a, b)).toEqual(t);
          }
        }
      }
    }
  });

  it("removeLeaf keeps canonical form and drops exactly one leaf", () => {
    for (const n of [2, 3, 4]) {
      for (const t of allPlacements(n)) {
        for (const id of leafIds(t)) {
          const out = removeLeaf(t, id);
          expect(out).not.toBeNull();
          expect(isCanonicalTree(out!)).toBe(true);
          expect(leaves(out!)).toHaveLength(n - 1);
        }
      }
    }
    expect(removeLeaf({ leaf: "tty" }, "tty")).toBeNull();
    expect(removeLeaf(parseLayoutTree("h(tty,web)")!, "gui")).toBeNull();
  });

  it("insertBeside keeps canonical form and adds exactly one leaf", () => {
    for (const n of [1, 2, 3]) {
      for (const t of allPlacements(n)) {
        for (const id of leafIds(t)) {
          for (const side of ["left", "right", "top", "bottom"] as const) {
            const out = insertBeside(t, pathOf(t, id)!, side, { leaf: "tty" });
            expect(isCanonicalTree(out)).toBe(true);
            expect(leaves(out)).toHaveLength(n + 1);
          }
        }
      }
    }
  });

  it("insertBeside into a same-direction parent merges into it", () => {
    const t = parseLayoutTree("h(tty,web)")!;
    expect(serializeLayoutTree(insertBeside(t, [1], "right", { leaf: "code" }))).toBe(
      "h(tty,web,code)",
    );
    expect(serializeLayoutTree(insertBeside(t, [1], "bottom", { leaf: "code" }))).toBe(
      "h(tty,v(web,code))",
    );
  });

  it("the N = 3 closure is the five presets plus main-bottom", () => {
    const reachable = new Set(allPlacements(3).map(structureSig));
    const indexSlots: SurfaceKind[] = ["tty", "web", "code"];
    const templated = new Set(
      templatesFor(3).map((name) => structureSig(TEMPLATES[name](indexSlots))),
    );
    expect(reachable).toEqual(templated);
    expect(templated.size).toBe(6);
  });
});

// ── templates ───────────────────────────────────────────────────────────────

describe("templates", () => {
  it("templatesFor lists the structurally distinct templates in registry order", () => {
    expect(templatesFor(1)).toEqual([]);
    expect(templatesFor(2)).toEqual(["row", "col"]);
    expect(templatesFor(3)).toEqual([
      "row",
      "col",
      "main-left",
      "main-right",
      "main-top",
      "main-bottom",
    ]);
  });

  it("templateOf identifies main-bottom with slot A first", () => {
    expect(templateOf(parseLayoutTree("v(h(code,web),tty)")!)).toEqual({
      name: "main-bottom",
      slots: ["tty", "code", "web"],
    });
  });

  it("templateOf identifies main-right and single", () => {
    expect(templateOf(parseLayoutTree("main-right:tty,code,web")!)).toEqual({
      name: "main-right",
      slots: ["tty", "code", "web"],
    });
    expect(templateOf(parseLayoutTree("tty")!)).toEqual({ name: "single", slots: ["tty"] });
  });

  it("templateOf reports custom beyond the template structures", () => {
    const four: LayoutNode = {
      dir: "h",
      children: [
        { leaf: "tty" },
        { dir: "v", children: [{ leaf: "web" }, { dir: "h", children: [{ leaf: "code" }, { leaf: "gui" }] }] },
      ],
    };
    expect(templateOf(four).name).toBe("custom");
    expect(slotOrder(four)).toEqual(["tty", "web", "code", "gui"]);
  });

  it("template trees carry the main fraction and survive normalise", () => {
    const t = TEMPLATES["main-left"](["tty", "code", "web"]);
    expect(t).toMatchObject({ dir: "h" });
    const sizes = t && "sizes" in t ? t.sizes : undefined;
    expect(sizes?.[0]).toBeCloseTo(0.58);
    expect(sizes?.[1]).toBeCloseTo(0.42);
    const normed = normalise(t);
    // normalise keeps the structure and the outer sizes, making the inner
    // split's implicit equal shares explicit
    expect(serializeLayoutTree(normed)).toBe("h(tty,v(code,web))");
    expect(isCanonicalTree(normed)).toBe(true);
  });
});

// ── geometry ────────────────────────────────────────────────────────────────

describe("layoutRects", () => {
  it("splits the box with the 6px gutter", () => {
    const rects = layoutRects(parseLayoutTree("h(tty,web)")!, { x: 0, y: 0, w: 1600, h: 1000 });
    expect(rects.get("tty")).toEqual({ x: 0, y: 0, w: 797, h: 1000 });
    expect(rects.get("web")).toEqual({ x: 803, y: 0, w: 797, h: 1000 });
  });

  it("honours the per-split sizes override in pre-order", () => {
    const tree = parseLayoutTree("h(tty,v(code,web))")!;
    const rects = layoutRects(tree, { x: 0, y: 0, w: 1600, h: 1000 }, [[0.75, 0.25], [0.5, 0.5]]);
    const tty = rects.get("tty")!;
    expect(tty.w).toBeCloseTo((1600 - 6) * 0.75);
    const code = rects.get("code")!;
    expect(code.h).toBeCloseTo((1000 - 6) * 0.5);
  });

  it("ignores a mis-shaped override entry", () => {
    const tree = parseLayoutTree("h(tty,web)")!;
    const rects = layoutRects(tree, { x: 0, y: 0, w: 1600, h: 1000 }, [[1, 2, 3]]);
    expect(rects.get("tty")!.w).toBeCloseTo(797);
  });
});

describe("layoutDividers", () => {
  it("derives one divider per sibling pair plus the T-junction intersection", () => {
    const tree = parseLayoutTree("h(tty,v(code,web))")!;
    const { dividers, intersections } = layoutDividers(tree, { x: 0, y: 0, w: 1600, h: 1000 });
    expect(dividers).toHaveLength(2);
    expect(dividers[0]).toMatchObject({ splitPath: [], boundary: 1, dir: "h" });
    expect(dividers[1]).toMatchObject({ splitPath: [1], boundary: 1, dir: "v" });
    expect(intersections).toHaveLength(1);
    expect(intersections[0].dividers).toEqual([0, 1]);
    expect(intersections[0].x).toBeCloseTo(797 + 3);
    expect(intersections[0].y).toBeCloseTo(497 + 3);
  });

  it("derives no intersections for a flat row", () => {
    const tree = parseLayoutTree("h(tty,code,web)")!;
    const { dividers, intersections } = layoutDividers(tree, { x: 0, y: 0, w: 1600, h: 1000 });
    expect(dividers).toHaveLength(2);
    expect(intersections).toHaveLength(0);
  });
});
