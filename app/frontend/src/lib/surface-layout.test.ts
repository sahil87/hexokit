import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addSurface,
  applyTemplate,
  availableTiles,
  closeSurface,
  cycleTemplate,
  degradeLayout,
  effectiveLayout,
  fitsFloor,
  legacyTranslationDecision,
  openTileKinds,
  parseLayoutTree,
  promote,
  readStoredSizes,
  readStoredZoom,
  serializeLayoutTree,
  sizesStorageKey,
  structureSig,
  swapDirectional,
  templatesFor,
  toggleSurface,
  translateLegacyParams,
  writeStoredSizes,
  writeStoredZoom,
  zoomStorageKey,
  NOMINAL_BOX,
  type Layout,
  type SurfaceKind,
  type SwapDirection,
} from "./surface-layout";
import { TEMPLATE_NAMES, TEMPLATES, type TemplateName } from "./layout-tree";
import type { ViewWindow } from "./window-view";
import fixtures from "./layout-tree.fixtures.json";

const plain: ViewWindow = {};
const webWin: ViewWindow = { webTabs: ["http://localhost:8080"] };
const fullWin: ViewWindow = {
  webTabs: ["http://localhost:8080"],
  gitRoot: "/repo",
};

const parse = (s: string): Layout => {
  const t = parseLayoutTree(s);
  if (!t) throw new Error(`fixture start ${JSON.stringify(s)} does not parse`);
  return t;
};
const ser = (t: Layout | null): string | null => (t === null ? null : serializeLayoutTree(t));

// The shared fixture table (also read by the Go layoutspec tests): the verbs
// here are this module's; the parse half is covered in layout-tree.test.ts.
describe("shared fixture verbs (layout-tree.fixtures.json)", () => {
  const isKind = (v: string | undefined): v is SurfaceKind =>
    v === "tty" || v === "web" || v === "code" || v === "gui";
  for (const c of fixtures.verbs) {
    const label = `${c.verb} ${c.start}${c.kind ? ` +${c.kind}` : ""}${c.id ? ` ${c.id}` : ""}${c.name ? ` → ${c.name}` : ""}`;
    it(label, () => {
      const start = parse(c.start);
      let out: Layout | null;
      switch (c.verb) {
        case "add":
          if (!isKind(c.kind)) throw new Error(`bad fixture kind ${c.kind}`);
          out = addSurface(start, c.kind);
          break;
        case "close":
          out = closeSurface(start, c.id ?? "");
          break;
        case "promote":
          out = promote(start, c.id ?? "");
          break;
        case "cycle":
          out = cycleTemplate(start);
          break;
        case "template":
          out = (TEMPLATE_NAMES as string[]).includes(c.name ?? "")
            ? applyTemplate(start, c.name as TemplateName)
            : null;
          break;
        default:
          throw new Error(`unknown fixture verb ${c.verb}`);
      }
      expect(ser(out)).toBe(c.expect);
    });
  }
});

describe("availableTiles", () => {
  it("always lists tty + web, then code per capability — web availability is unconditional", () => {
    expect(availableTiles(plain)).toEqual(["tty", "web"]);
    expect(availableTiles(webWin)).toEqual(["tty", "web"]);
    expect(availableTiles(fullWin)).toEqual(["tty", "code", "web"]);
    expect(availableTiles(null)).toEqual(["tty", "web"]);
  });

  it("appends gui last iff the host signal is enabled", () => {
    expect(availableTiles(fullWin, { enabled: true })).toEqual([
      "tty",
      "code",
      "web",
      "gui",
    ]);
    expect(availableTiles(plain, { enabled: true })).toEqual(["tty", "web", "gui"]);
  });

  it("omits gui when the host is disabled or the signal is absent", () => {
    expect(availableTiles(fullWin, { enabled: false })).toEqual(["tty", "code", "web"]);
    expect(availableTiles(fullWin, null)).toEqual(["tty", "code", "web"]);
    expect(availableTiles(fullWin)).toEqual(["tty", "code", "web"]);
  });
});

describe("degradeLayout", () => {
  it("keeps an already-available layout untouched", () => {
    const tree = parse("h(tty,v(code,web))");
    expect(degradeLayout(tree, fullWin)).toEqual(tree);
  });

  it("drops an unavailable leaf, keeping the remaining structure", () => {
    // No gitRoot → code unavailable; web is always available.
    expect(ser(degradeLayout(parse("h(tty,v(code,web))"), webWin))).toBe("h(tty,web)");
    expect(ser(degradeLayout(parse("v(tty,code,web)"), webWin))).toBe("v(tty,web)");
  });

  it("drops unavailable leaves down to a bare leaf", () => {
    expect(ser(degradeLayout(parse("h(web,code)"), webWin))).toBe("web");
  });

  it("returns null when nothing is available (fully invalid → the tty fallback)", () => {
    expect(degradeLayout(parse("code"), plain)).toBeNull();
  });

  it("never drops web — a web deep link keeps its tile on a URL-less window", () => {
    const tree = parse("h(tty,web)");
    expect(degradeLayout(tree, plain)).toEqual(tree);
    expect(degradeLayout(parse("web"), plain)).toEqual(parse("web"));
  });

  it("drops gui when the host signal is off and keeps the remaining structure", () => {
    expect(ser(degradeLayout(parse("v(tty,h(gui,web))"), plain, { enabled: false }))).toBe(
      "v(tty,web)",
    );
    const tree = parse("h(tty,gui)");
    expect(ser(degradeLayout(tree, plain, { enabled: false }))).toBe("tty");
    expect(ser(degradeLayout(tree, plain, null))).toBe("tty");
    expect(degradeLayout(tree, plain, { enabled: true })).toEqual(tree);
  });

  it("never degrades a FOREIGN leaf by the route window's capabilities", () => {
    // Borrowing @3/code into a code-less window keeps the tile — the home
    // window's record carries the capability; dead homes are pruned elsewhere.
    expect(ser(degradeLayout(parse("h(tty,@3/code)"), plain))).toBe("h(tty,@3/code)");
    const foreignOnly = parse("@3/code");
    expect(degradeLayout(foreignOnly, plain)).toEqual(foreignOnly);
  });
});

describe("effectiveLayout", () => {
  it("falls back to the bare tty leaf for an unset or absent layout", () => {
    expect(effectiveLayout(plain)).toEqual({ leaf: "tty" });
    expect(effectiveLayout({ layout: "" })).toEqual({ leaf: "tty" });
    expect(effectiveLayout(null)).toEqual({ leaf: "tty" });
    expect(effectiveLayout(undefined)).toEqual({ leaf: "tty" });
  });

  it("reads the tree form as written", () => {
    const win: ViewWindow = { layout: "h(tty,v(code,web))", gitRoot: "/repo" };
    expect(effectiveLayout(win)).toEqual(parse("h(tty,v(code,web))"));
  });

  it("reads the legacy preset strings identically to today", () => {
    const win: ViewWindow = { layout: "main-right:tty,code,web", gitRoot: "/repo" };
    expect(effectiveLayout(win)).toEqual(parse("h(v(code,web),tty)"));
  });

  it("degrades a partially-unavailable layout in place, never rewriting the option", () => {
    const win: ViewWindow = { layout: "main-left:tty,code,web", gitRoot: "" };
    expect(ser(effectiveLayout(win))).toBe("h(tty,web)");
    expect(win.layout).toBe("main-left:tty,code,web");
  });

  it("heals a stored chat layout to tty via parse-reject", () => {
    // "chat" is no longer a surface kind, so any stored layout containing it
    // fails the parse and the whole value falls back to the tty leaf (the
    // stale option is overwritten on the next layout write).
    expect(effectiveLayout({ layout: "single:chat" })).toEqual({ leaf: "tty" });
    expect(effectiveLayout({ layout: "h(chat,tty)", gitRoot: "/repo" })).toEqual({
      leaf: "tty",
    });
  });

  it("falls back to tty when nothing in the layout is available", () => {
    expect(effectiveLayout({ layout: "single:code" })).toEqual({ leaf: "tty" });
  });

  it("keeps a foreign leaf the route window could not host itself", () => {
    // A borrowed @3/code tile on a code-less window renders — capability
    // degradation is a BARE-leaf ladder.
    expect(ser(effectiveLayout({ layout: "h(tty,@3/code)" }))).toBe("h(tty,@3/code)");
  });

  it("falls back to tty for a malformed or non-canonical layout string", () => {
    expect(effectiveLayout({ layout: "garbage" })).toEqual({ leaf: "tty" });
    expect(effectiveLayout({ layout: "h(h(tty,web),code)" })).toEqual({ leaf: "tty" });
  });

  it("degrades a gui layout when the switch is off and restores it when on", () => {
    const win: ViewWindow = { layout: "split-h:tty,gui" };
    expect(effectiveLayout(win, { enabled: false })).toEqual({ leaf: "tty" });
    expect(effectiveLayout(win, null)).toEqual({ leaf: "tty" });
    expect(effectiveLayout(win, { enabled: true })).toEqual(parse("h(tty,gui)"));
    expect(win.layout).toBe("split-h:tty,gui");
  });
});

describe("translateLegacyParams", () => {
  it("maps ?view=X to single:X", () => {
    expect(translateLegacyParams("code", undefined)).toBe("single:code");
  });

  it("maps ?view=X&panel=Y to split-h:X,Y (X in slot A)", () => {
    expect(translateLegacyParams("code", "web")).toBe("split-h:code,web");
  });

  it("maps a bare ?panel=Y against the tty default main slot", () => {
    expect(translateLegacyParams(undefined, "web")).toBe("split-h:tty,web");
  });

  it("returns undefined when neither legacy param is present", () => {
    expect(translateLegacyParams(undefined, undefined)).toBeUndefined();
  });
});

describe("legacyTranslationDecision", () => {
  it("prefers the carried URL layout, written in the tree form", () => {
    expect(
      legacyTranslationDecision({
        carried: "split-h:tty,web",
        storedLayout: "single:code",
        storedLegacy: "single:web",
        winLayout: "",
      }),
    ).toEqual({ write: "h(tty,web)", dropParams: true });
  });

  it("falls back to the stored layout, then the stored legacy translation", () => {
    expect(
      legacyTranslationDecision({
        storedLayout: "single:code",
        storedLegacy: "single:web",
        winLayout: "",
      }),
    ).toEqual({ write: "code", dropParams: false });
    expect(legacyTranslationDecision({ storedLegacy: "single:web", winLayout: "" })).toEqual({
      write: "web",
      dropParams: false,
    });
  });

  it("writes nothing for a stored legacy layout containing the removed chat surface", () => {
    expect(legacyTranslationDecision({ storedLegacy: "single:chat", winLayout: "" })).toEqual({
      dropParams: false,
    });
  });

  it("writes nothing when the window option is already set — params still drop", () => {
    expect(
      legacyTranslationDecision({ carried: "split-h:tty,web", winLayout: "code" }),
    ).toEqual({ dropParams: true });
    expect(
      legacyTranslationDecision({ storedLayout: "single:web", winLayout: "code" }),
    ).toEqual({ dropParams: false });
  });

  it("writes nothing when no candidate parses", () => {
    expect(legacyTranslationDecision({ winLayout: "" })).toEqual({ dropParams: false });
    expect(legacyTranslationDecision({ carried: "garbage", winLayout: "" })).toEqual({
      dropParams: true,
    });
  });
});

describe("zoom storage (per-viewer surface kind)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uses rk-layout-zoom:{server}:{windowId}", () => {
    expect(zoomStorageKey("s", "@1")).toBe("rk-layout-zoom:s:@1");
  });

  it("round-trips a surface kind, scoped per (server, windowId)", () => {
    expect(readStoredZoom("s", "@3")).toBeUndefined();
    writeStoredZoom("s", "@3", "web");
    expect(readStoredZoom("s", "@3")).toBe("web");
    expect(readStoredZoom("s", "@4")).toBeUndefined();
    expect(readStoredZoom("other", "@3")).toBeUndefined();
  });

  it("clears the key on null (unzoom)", () => {
    writeStoredZoom("s", "@3", "web");
    writeStoredZoom("s", "@3", null);
    expect(readStoredZoom("s", "@3")).toBeUndefined();
    expect(localStorage.getItem("rk-layout-zoom:s:@3")).toBeNull();
  });

  it("rejects a stored value that is not a surface kind", () => {
    localStorage.setItem("rk-layout-zoom:s:@3", "bogus");
    expect(readStoredZoom("s", "@3")).toBeUndefined();
  });

  it("swallows a localStorage read failure, returning undefined", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredZoom("s", "@3")).toBeUndefined();
  });
});

describe("sizes storage (per-viewer, keyed by structure signature)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  const tree = () => parse("h(tty,v(code,web))");

  it("uses rk-layout-sizes:{server}:{windowId}:{sig}", () => {
    expect(sizesStorageKey("s", "@1", "h(0,v(1,2))")).toBe(
      "rk-layout-sizes:s:@1:h(0,v(1,2))",
    );
    expect(structureSig(tree())).toBe("h(0,v(1,2))");
  });

  it("round-trips per-split fraction arrays", () => {
    writeStoredSizes("s", "@3", structureSig(tree()), [
      [0.7, 0.3],
      [0.4, 0.6],
    ]);
    expect(readStoredSizes("s", "@3", tree())).toEqual([
      [0.7, 0.3],
      [0.4, 0.6],
    ]);
    expect(readStoredSizes("s", "@4", tree())).toBeUndefined();
  });

  it("rejects corrupt, mis-shaped or non-summing values", () => {
    const key = sizesStorageKey("s", "@3", "h(0,v(1,2))");
    localStorage.setItem(key, "not-json");
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
    localStorage.setItem(key, JSON.stringify([[0.5, 0.5]])); // one split missing
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
    localStorage.setItem(key, JSON.stringify([[0.5, 0.5], [0.5, 0.4]])); // sums ≠ 1
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
    localStorage.setItem(key, JSON.stringify([[0.5, 0.5], [1, 0]])); // non-positive
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
    localStorage.setItem(key, JSON.stringify([[0.5, 0.5], [0.5, 0.5, 0.5]])); // arity
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
  });

  it("is keyed by structure, not leaves — a swap keeps the sizes", () => {
    const swapped = parse("h(tty,v(web,code))");
    expect(structureSig(swapped)).toBe(structureSig(tree()));
    writeStoredSizes("s", "@3", structureSig(tree()), [
      [0.7, 0.3],
      [0.4, 0.6],
    ]);
    expect(readStoredSizes("s", "@3", swapped)).toEqual([
      [0.7, 0.3],
      [0.4, 0.6],
    ]);
  });

  it("swallows a localStorage read failure, returning undefined", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredSizes("s", "@3", tree())).toBeUndefined();
  });
});

describe("mutations beyond the fixture table", () => {
  it("addSurface on a portrait last leaf splits vertically; a square leaf splits horizontally", () => {
    const two = parse("h(tty,web)");
    const portrait = new Map([
      ["tty", { x: 0, y: 0, w: 600, h: 1000 }],
      ["web", { x: 606, y: 0, w: 600, h: 1000 }],
    ]);
    expect(ser(addSurface(two, "code", portrait))).toBe("h(tty,v(web,code))");
    const square = new Map([
      ["tty", { x: 0, y: 0, w: 500, h: 500 }],
      ["web", { x: 506, y: 0, w: 500, h: 500 }],
    ]);
    // the wrap merges into the parent h-split (canonical form)
    expect(ser(addSurface(two, "code", square))).toBe("h(tty,web,code)");
  });

  it("swapDirectional picks the geometric neighbour and no-ops without one", () => {
    const tree = parse("h(tty,v(code,web))");
    expect(ser(swapDirectional(tree, "web", "up"))).toBe("h(tty,v(web,code))");
    expect(ser(swapDirectional(tree, "web", "right"))).toBe("h(tty,v(code,web))");
    expect(ser(swapDirectional(tree, "web", "down"))).toBe("h(tty,v(code,web))");
    expect(ser(swapDirectional(tree, "code", "left"))).toBe("h(code,v(tty,web))");
    expect(ser(swapDirectional(tree, "gui", "up"))).toBe("h(tty,v(code,web))");
  });

  it("swapDirectional respects caller rects", () => {
    const tree = parse("v(tty,web)");
    const rects = new Map([
      ["tty", { x: 0, y: 0, w: 1000, h: 497 }],
      ["web", { x: 0, y: 503, w: 1000, h: 497 }],
    ]);
    expect(ser(swapDirectional(tree, "web", "up", rects))).toBe("v(web,tty)");
  });

  it("promote is a no-op for an absent leaf", () => {
    const tree = parse("h(tty,web)");
    expect(promote(tree, "code")).toEqual(tree);
  });

  it("cycleTemplate walks templatesFor(n); a custom tree cycles to the first template", () => {
    const custom: Layout = {
      dir: "h",
      children: [
        { leaf: "tty" },
        {
          dir: "v",
          children: [
            { leaf: "web" },
            { dir: "h", children: [{ leaf: "code" }, { leaf: "gui" }] },
          ],
        },
      ],
    };
    expect(ser(cycleTemplate(custom))).toBe("h(tty,web,code,gui)");
  });

  it("applyTemplate rebuilds from the current slot order", () => {
    expect(ser(applyTemplate(parse("v(h(code,web),tty)"), "main-left"))).toBe(
      "h(tty,v(code,web))",
    );
    expect(applyTemplate(parse("tty"), "row")).toBeNull();
  });

  it("template-built layouts serialize to the tree form (sizes never persist)", () => {
    const t = TEMPLATES["main-left"](["tty", "code", "web"]);
    expect(serializeLayoutTree(t)).toBe("h(tty,v(code,web))");
  });
});

describe("addSurface — the size floor replaces the tile cap (R16)", () => {
  it("a fourth and fifth tile are permitted when the floor allows (byte cap, not tile cap, bounds size)", () => {
    const four = addSurface(parse("h(tty,v(web,code))"), "gui");
    expect(ser(four)).toBe("h(tty,v(web,h(code,gui)))");
    const five = four !== null ? addSurface(four, "tty") : null;
    expect(ser(five)).toBe("h(tty,v(web,h(code,v(gui,tty))))");
  });

  it("refuses only when no split fits the floor in the measured box", () => {
    const two = parse("h(tty,web)");
    const cramped = new Map([
      ["tty", { x: 0, y: 0, w: 150, h: 100 }],
      ["web", { x: 156, y: 0, w: 150, h: 100 }],
    ]);
    expect(addSurface(two, "code", cramped)).toBeNull();
    // One px of slack on each axis is enough.
    const fitting = new Map([
      ["tty", { x: 0, y: 0, w: 306, h: 100 }],
      ["web", { x: 312, y: 0, w: 306, h: 100 }],
    ]);
    expect(addSurface(two, "code", fitting)).not.toBeNull();
  });

  it("splits the focused tile on its longer axis, falling back to the largest tile", () => {
    // 306×300 box: the focused web tile's longer-axis (horizontal) split
    // leaves 72px columns — under the floor — so the add lands on tty, the
    // largest tile.
    const three = parse("h(tty,v(code,web))");
    const rects = new Map([
      ["tty", { x: 0, y: 0, w: 150, h: 300 }],
      ["code", { x: 156, y: 0, w: 150, h: 147 }],
      ["web", { x: 156, y: 153, w: 150, h: 147 }],
    ]);
    expect(ser(addSurface(three, "gui", rects))).toBe("h(v(tty,gui),v(code,web))");
    // An explicit focused tile that fits splits itself, not the last leaf.
    const two = parse("h(tty,web)");
    const tall = new Map([
      ["tty", { x: 0, y: 0, w: 600, h: 1000 }],
      ["web", { x: 606, y: 0, w: 600, h: 1000 }],
    ]);
    expect(ser(addSurface(two, "code", tall, "tty"))).toBe("h(v(tty,code),web)");
  });

  it("threads stored sizes into the floor check — the split tile halves from its stored share, not default fractions", () => {
    // Stored [0.81,0.19]×[0.7,0.3] in the nominal box: the focused (last)
    // web tile is 303×298 — halving its width lands at 148px, under the
    // floor — so the add splits tty instead (default fractions would split
    // web).
    const three = parse("h(tty,v(code,web))");
    expect(
      ser(addSurface(three, "gui", undefined, undefined, [[0.81, 0.19], [0.7, 0.3]])),
    ).toBe("h(tty,gui,v(code,web))");
    // Stored 9/91 on a row: the 143px tty tile can neither split (its half
    // ≈ 69px) nor survive a split of web — refused, though default fractions
    // fit.
    const two = parse("h(tty,web)");
    expect(addSurface(two, "code", undefined, undefined, [[0.09, 0.91]])).toBeNull();
  });

  it("accepts a foreign leaf and refuses a repeated address; a bare kind and a foreign leaf of it coexist", () => {
    expect(ser(addSurface(parse("tty"), { leaf: "tty", home: "@3" }))).toBe("h(tty,@3/tty)");
    expect(addSurface(parse("h(tty,@3/tty)"), { leaf: "tty", home: "@3" })).toBeNull();
    expect(ser(addSurface(parse("h(tty,web)"), { leaf: "web", home: "@3" }))).toBe(
      "h(tty,v(web,@3/web))",
    );
  });

  it("accepts a bare kind when the tree holds only a FOREIGN leaf of it; a repeated bare non-tty kind stays refused", () => {
    expect(ser(addSurface(parse("h(tty,@3/web)"), "web"))).toBe("h(tty,v(@3/web,web))");
    expect(addSurface(parse("h(tty,web,@3/web)"), "web")).toBeNull();
    // Bare tty dups keep their rule.
    expect(ser(addSurface(parse("h(tty,@3/tty)"), "tty"))).toBe("h(tty,v(@3/tty,tty))");
  });
});

describe("toggleSurface / openTileKinds — the open-tile toggle counts bare leaves only", () => {
  it("a kind present only as a foreign leaf reads as not open", () => {
    expect(openTileKinds(parse("h(tty,@3/web)"))).toEqual(["tty"]);
    expect(openTileKinds(parse("h(tty,web)"))).toEqual(["tty", "web"]);
    expect(openTileKinds(parse("h(tty,web,@3/code)"))).toEqual(["tty", "web"]);
  });

  it("toggling ON a foreign-only kind adds the bare slot", () => {
    expect(ser(toggleSurface(parse("h(tty,@3/web)"), "web"))).toBe("h(tty,v(@3/web,web))");
  });

  it("toggling OFF closes the BARE leaf, never the foreign one — even when the foreign leaf comes first in reading order", () => {
    expect(ser(toggleSurface(parse("h(tty,web,@3/web)"), "web"))).toBe("h(tty,@3/web)");
    expect(ser(toggleSurface(parse("h(@3/web,web)"), "web"))).toBe("@3/web");
  });

  it("toggling OFF the last tile is a refused no-op", () => {
    expect(toggleSurface(parse("tty"), "tty")).toBeNull();
  });
});

describe("fitsFloor — the offer gate (R16)", () => {
  it("a leaf is offered iff it lays out at ≥ MIN_TILE_W × MIN_TILE_H in the box", () => {
    const one = parse("tty");
    expect(fitsFloor(one, undefined, { x: 0, y: 0, w: 150, h: 100 })).toBe(true);
    expect(fitsFloor(one, undefined, { x: 0, y: 0, w: 149, h: 100 })).toBe(false);
    expect(fitsFloor(one, undefined, { x: 0, y: 0, w: 150, h: 99 })).toBe(false);
  });

  it("gates Layout: <Template> offers — a template result under the floor is not offered", () => {
    const tree = parse("h(tty,v(code,web))");
    const fitting = (box: { x: number; y: number; w: number; h: number }) =>
      templatesFor(3).filter((name) => {
        const next = applyTemplate(tree, name);
        return next !== null && fitsFloor(next, undefined, box);
      });
    // 400×250: row leaves 129px columns and col leaves 79px rows; the main-*
    // templates fit.
    expect(fitting({ x: 0, y: 0, w: 400, h: 250 })).toEqual([
      "main-left",
      "main-right",
      "main-top",
      "main-bottom",
    ]);
    expect(fitting(NOMINAL_BOX)).toEqual(templatesFor(3));
  });
});
