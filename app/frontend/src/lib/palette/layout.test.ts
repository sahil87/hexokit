import { describe, it, expect, vi } from "vitest";
import { buildLayoutActions, buildTileSwitchActions, type BringWindow } from "./layout";
import { leaves, type Layout, type Rect, type SurfaceKind } from "../surface-layout";

/**
 * `buildLayoutActions` — the palette's `Tile:`/`Layout:` entries per layout
 * state. Pure-builder tests in the `palette/view.test.ts` pattern.
 * `buildTileSwitchActions` — the mobile `Tile: Switch to <Surface>` entries
 * (the top-bar switch group's palette twin).
 */

const ALL: SurfaceKind[] = ["tty", "web", "code"];

const SINGLE_TTY: Layout = { leaf: "tty" };
const SPLIT_H_TTY_CODE: Layout = {
  dir: "h",
  children: [{ leaf: "tty" }, { leaf: "code" }],
};
/** h(tty,v(code,web)) — main-left with tty main, code over web right. */
const MAIN_LEFT: Layout = {
  dir: "h",
  children: [
    { leaf: "tty" },
    { dir: "v", children: [{ leaf: "code" }, { leaf: "web" }] },
  ],
};

/** Rects for MAIN_LEFT: tty full-height left, code top-right, web
 *  bottom-right. */
const MAIN_LEFT_RECTS = new Map<string, Rect>([
  ["tty", { x: 0, y: 0, w: 800, h: 1000 }],
  ["code", { x: 806, y: 0, w: 794, h: 497 }],
  ["web", { x: 806, y: 503, w: 794, h: 497 }],
]);

function build(
  layout: Layout,
  overrides: Partial<Parameters<typeof buildLayoutActions>[2]> = {},
  available: SurfaceKind[] = ALL,
) {
  return buildLayoutActions(layout, available, {
    zoomed: false,
    zoomEnabled: leaves(layout).length > 1,
    onApply: vi.fn(),
    onZoomToggle: vi.fn(),
    onApplyTemplate: vi.fn(),
    onCycleTemplate: vi.fn(),
    onPromoteLeaf: vi.fn(),
    onSwapDirection: vi.fn(),
    focusedLeafId: undefined,
    leafRects: undefined,
    ...overrides,
  });
}

const ids = (layout: Layout, available: SurfaceKind[] = ALL) =>
  build(layout, {}, available).map((a) => a.id);

describe("buildLayoutActions — shows/hides", () => {
  it("a single tty offers a Show per available non-open surface and NO hides/verbs", () => {
    const actions = ids(SINGLE_TTY);
    expect(actions).toContain("tile-show-web");
    expect(actions).toContain("tile-show-code");
    expect(actions).not.toContain("tile-show-tty"); // already open
    // single: no hides (the last tile never hides), no promote/swaps, no
    // template jumps, no cycle (the ring is empty at one tile).
    expect(actions.some((id) => id.startsWith("tile-hide-"))).toBe(false);
    expect(actions.some((id) => id.startsWith("layout-promote-"))).toBe(false);
    expect(actions.some((id) => id.startsWith("tile-swap-"))).toBe(false);
    expect(actions.some((id) => id.startsWith("layout-template-"))).toBe(false);
    expect(actions).not.toContain("layout-cycle");
  });

  it("show runs addSurface through onApply (1→2 splits the last leaf)", () => {
    const onApply = vi.fn();
    const actions = build(SINGLE_TTY, { onApply });
    actions.find((a) => a.id === "tile-show-code")!.onSelect();
    expect(onApply).toHaveBeenCalledWith(SPLIT_H_TTY_CODE);
  });

  it("Show/Hide delegate to the onToggleSurface seam when present (the caller's guarded shared toggle)", () => {
    const onToggleSurface = vi.fn();
    const onApply = vi.fn();
    const shows = build(SINGLE_TTY, { onToggleSurface, onApply });
    shows.find((a) => a.id === "tile-show-code")!.onSelect();
    expect(onToggleSurface).toHaveBeenCalledWith("code");
    expect(onApply).not.toHaveBeenCalled();

    onToggleSurface.mockClear();
    const hides = build(SPLIT_H_TTY_CODE, { onToggleSurface, onApply });
    hides.find((a) => a.id === "tile-hide-code")!.onSelect();
    expect(onToggleSurface).toHaveBeenCalledWith("code");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a popped, unrevealed kind reads as closed: Show (reveal through the toggle), no Hide", () => {
    const onToggleSurface = vi.fn();
    const onApply = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { onToggleSurface, onApply, poppedIds: ["tty"] });
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain("tile-hide-tty");
    expect(ids).toContain("tile-hide-code");
    actions.find((a) => a.id === "tile-show-tty")!.onSelect();
    expect(onToggleSurface).toHaveBeenCalledWith("tty");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a popped, revealed kind reads as open: Hide (hides the placeholder), no Show", () => {
    const ids = build(SPLIT_H_TTY_CODE, {
      onToggleSurface: vi.fn(),
      poppedIds: ["tty"],
      revealedIds: ["tty"],
    }).map((a) => a.id);
    expect(ids).toContain("tile-hide-tty");
    expect(ids).not.toContain("tile-show-tty");
  });

  it("show resolves the split direction from the LIVE leaf rects when passed", () => {
    const onApply = vi.fn();
    // A tall, narrow tty tile splits vertically (nominal-box geometry would
    // split it horizontally).
    const tall = new Map<string, Rect>([["tty", { x: 0, y: 0, w: 200, h: 1000 }]]);
    const actions = build(SINGLE_TTY, { onApply, leafRects: () => tall });
    actions.find((a) => a.id === "tile-show-web")!.onSelect();
    expect(onApply).toHaveBeenCalledWith({
      dir: "v",
      children: [{ leaf: "tty" }, { leaf: "web" }],
    });
  });

  it("show splits the FOCUSED tile when focusedLeafId is passed", () => {
    const onApply = vi.fn();
    // h(tty,code) with focus on tty: the 797×1000 tty tile splits on its
    // longer (vertical) axis — not the last leaf (code), which the default
    // would split.
    const actions = build(SPLIT_H_TTY_CODE, { onApply, focusedLeafId: "tty" });
    actions.find((a) => a.id === "tile-show-web")!.onSelect();
    expect(onApply).toHaveBeenCalledWith({
      dir: "h",
      children: [
        { dir: "v", children: [{ leaf: "tty" }, { leaf: "web" }] },
        { leaf: "code" },
      ],
    });
  });

  it("the Show gate checks the floor against the threaded stored sizes", () => {
    // Stored 9/91 in the nominal box: the 143px tty tile can neither split
    // nor survive a split of code — no Show rows, though default fractions
    // would fit.
    const actions = build(SPLIT_H_TTY_CODE, {
      layoutSizes: () => [
        [0.09, 0.91],
      ],
    }).map((a) => a.id);
    expect(actions.some((id) => id.startsWith("tile-show-"))).toBe(false);
  });

  it("at 3 tiles a Show is still offered when a split fits the floor (no tile cap)", () => {
    const actions = ids(MAIN_LEFT, ["tty", "web", "code", "gui"]);
    expect(actions).toContain("tile-show-gui");
  });

  it("Show entries are omitted when no split fits the size floor", () => {
    // A 200×150 box: splitting either 100×150 tile lands under 150×100 on
    // both axes, so growth is refused and the rows drop out.
    const tiny = new Map<string, Rect>([
      ["tty", { x: 0, y: 0, w: 100, h: 150 }],
      ["code", { x: 106, y: 0, w: 100, h: 150 }],
    ]);
    const actions = build(SPLIT_H_TTY_CODE, { leafRects: () => tiny }).map((a) => a.id);
    expect(actions.some((id) => id.startsWith("tile-show-"))).toBe(false);
  });

  it("hide runs closeSurface through onApply (3→2 keeps the h structure)", () => {
    const onApply = vi.fn();
    const actions = build(MAIN_LEFT, { onApply });
    actions.find((a) => a.id === "tile-hide-web")!.onSelect();
    expect(onApply).toHaveBeenCalledWith(SPLIT_H_TTY_CODE);
  });

  it("offers Tile: Show Web on a URL-less window — web is always available", () => {
    // The URL-less window's availableTiles is ["tty","web"]; Show Web opens
    // the onboarding tile.
    const actions = ids(SINGLE_TTY, ["tty", "web"]);
    expect(actions).toContain("tile-show-web");
    expect(actions).not.toContain("tile-show-code");
  });

  it("an unavailable surface gets no Show entry", () => {
    const actions = ids(SINGLE_TTY, ["tty", "web"]);
    expect(actions).toContain("tile-show-web");
    expect(actions).not.toContain("tile-show-code");
  });

  it("a kind open only as a FOREIGN tile keeps its Show row and gets no Hide row", () => {
    // h(tty,@3/web): the bare web slot is not open — Show Web adds it; the
    // foreign tile's exit verb is Send Back, not Hide.
    const foreignWeb: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "web", home: "@3" }],
    };
    const actions = ids(foreignWeb);
    expect(actions).toContain("tile-show-web");
    expect(actions).not.toContain("tile-hide-web");
    expect(actions).toContain("tile-hide-tty");
    // The Show row's select lands the bare slot beside the foreign leaf.
    const onApply = vi.fn();
    build(foreignWeb, { onApply })
      .find((a) => a.id === "tile-show-web")!
      .onSelect();
    expect(onApply).toHaveBeenCalledWith({
      dir: "h",
      children: [
        { leaf: "tty" },
        { dir: "v", children: [{ leaf: "web", home: "@3" }, { leaf: "web" }] },
      ],
    });
  });

  it("Show/Hide labels carry the Tile: prefix; arrangement verbs keep Layout:", () => {
    const actions = build(SPLIT_H_TTY_CODE);
    expect(actions.find((a) => a.id === "tile-hide-code")?.label).toBe("Tile: Hide Code");
    expect(actions.find((a) => a.id === "layout-promote-code")?.label).toBe(
      "Layout: Promote Code",
    );
    expect(actions.some((a) => a.label.startsWith("Layout: Add"))).toBe(false);
    expect(actions.some((a) => a.label.startsWith("Layout: Close"))).toBe(false);
    expect(actions.some((a) => a.label.startsWith("Layout: Focus"))).toBe(false);
  });
});

describe("buildLayoutActions — tile expand", () => {
  it("offers Expand when enabled and unzoomed, Restore when zoomed — never both", () => {
    expect(ids(SPLIT_H_TTY_CODE)).toContain("layout-zoom");
    expect(ids(SPLIT_H_TTY_CODE)).not.toContain("layout-unzoom");
    const zoomed = build(SPLIT_H_TTY_CODE, { zoomed: true }).map((a) => a.id);
    expect(zoomed).toContain("layout-unzoom");
    expect(zoomed).not.toContain("layout-zoom");
  });

  it("zoom entries are gated on zoomEnabled (single/mobile)", () => {
    expect(ids(SINGLE_TTY)).not.toContain("layout-zoom");
    const mobile = build(SPLIT_H_TTY_CODE, { zoomEnabled: false }).map((a) => a.id);
    expect(mobile).not.toContain("layout-zoom");
  });

  it("the zoom entry fires the toggle seam, not onApply (transient)", () => {
    const onApply = vi.fn();
    const onZoomToggle = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { onApply, onZoomToggle });
    actions.find((a) => a.id === "layout-zoom")!.onSelect();
    expect(onZoomToggle).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe("buildLayoutActions — promote", () => {
  it("promote is offered per open kind EXCEPT slot A; no per-kind swap rows remain", () => {
    const actions = ids(MAIN_LEFT);
    expect(actions).not.toContain("layout-promote-tty"); // slot A — a no-op
    expect(actions).toContain("layout-promote-code");
    expect(actions).toContain("layout-promote-web");
    expect(actions.some((id) => id.startsWith("layout-swap-"))).toBe(false);
  });

  it("slot A follows the template's main tile, not reading order", () => {
    // h(v(code,web),tty) — main-right: slot A is tty, the RIGHT tile.
    const mainRight: Layout = {
      dir: "h",
      children: [
        { dir: "v", children: [{ leaf: "code" }, { leaf: "web" }] },
        { leaf: "tty" },
      ],
    };
    const actions = ids(mainRight);
    expect(actions).not.toContain("layout-promote-tty");
    expect(actions).toContain("layout-promote-code");
    expect(actions).toContain("layout-promote-web");
  });

  it("promote fires onPromoteLeaf with the leaf id, never onApply", () => {
    const onApply = vi.fn();
    const onPromoteLeaf = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { onApply, onPromoteLeaf });
    actions.find((a) => a.id === "layout-promote-code")!.onSelect();
    expect(onPromoteLeaf).toHaveBeenCalledWith("code");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a kind present only as a FOREIGN tile promotes by its address id", () => {
    // h(tty,@3/web): the row must pass the real leaf id — the bare kind
    // "web" is not a leaf of this tree and would no-op inside promote().
    const foreignWeb: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "web", home: "@3" }],
    };
    const onPromoteLeaf = vi.fn();
    const actions = build(foreignWeb, { onPromoteLeaf });
    const row = actions.find((a) => a.id === "layout-promote-@3/web")!;
    expect(row.label).toBe("Layout: Promote Web (@3/web)");
    row.onSelect();
    expect(onPromoteLeaf).toHaveBeenCalledWith("@3/web");
  });

  it("bare and foreign tiles of one kind get separate Promote rows", () => {
    // h(tty,v(web,@9/web)): slot A is tty; the bare web and the foreign
    // @9/web each get a row firing their own leaf id.
    const mixed: Layout = {
      dir: "h",
      children: [
        { leaf: "tty" },
        { dir: "v", children: [{ leaf: "web" }, { leaf: "web", home: "@9" }] },
      ],
    };
    const onPromoteLeaf = vi.fn();
    const actions = build(mixed, { onPromoteLeaf });
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("layout-promote-web");
    expect(ids).toContain("layout-promote-@9/web");
    actions.find((a) => a.id === "layout-promote-web")!.onSelect();
    actions.find((a) => a.id === "layout-promote-@9/web")!.onSelect();
    expect(onPromoteLeaf).toHaveBeenNthCalledWith(1, "web");
    expect(onPromoteLeaf).toHaveBeenNthCalledWith(2, "@9/web");
  });

  it("a foreign tile in slot A gets no Promote row (promoting it is a no-op)", () => {
    const foreignMain: Layout = {
      dir: "h",
      children: [{ leaf: "code", home: "@3" }, { leaf: "tty" }],
    };
    const ids = build(foreignMain).map((a) => a.id);
    expect(ids).not.toContain("layout-promote-@3/code");
    expect(ids).toContain("layout-promote-tty");
  });
});

describe("buildLayoutActions — directional swaps", () => {
  const swapOpts = (focusedLeafId: string) => ({
    focusedLeafId,
    leafRects: () => MAIN_LEFT_RECTS,
  });

  it("h(tty,v(code,web)) with web focused lists Swap Left and Swap Up only", () => {
    const actions = build(MAIN_LEFT, swapOpts("web")).map((a) => a.id);
    // web is bottom-right: left overlaps the full-height tty, up overlaps
    // code; nothing lies right or below.
    expect(actions).toContain("tile-swap-left");
    expect(actions).toContain("tile-swap-up");
    expect(actions).not.toContain("tile-swap-right");
    expect(actions).not.toContain("tile-swap-down");
  });

  it("labels read `Tile: Swap <Direction>` and fire onSwapDirection", () => {
    const onSwapDirection = vi.fn();
    const onApply = vi.fn();
    const actions = build(MAIN_LEFT, { ...swapOpts("web"), onSwapDirection, onApply });
    const left = actions.find((a) => a.id === "tile-swap-left")!;
    expect(left.label).toBe("Tile: Swap Left");
    left.onSelect();
    expect(onSwapDirection).toHaveBeenCalledWith("left");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a two-tile row offers only the inward direction", () => {
    const rects = new Map<string, Rect>([
      ["tty", { x: 0, y: 0, w: 800, h: 1000 }],
      ["code", { x: 806, y: 0, w: 794, h: 1000 }],
    ]);
    const actions = build(SPLIT_H_TTY_CODE, {
      focusedLeafId: "code",
      leafRects: () => rects,
    }).map((a) => a.id);
    expect(actions).toContain("tile-swap-left");
    expect(actions).not.toContain("tile-swap-right");
    expect(actions).not.toContain("tile-swap-up");
    expect(actions).not.toContain("tile-swap-down");
  });

  it("no directional rows without leafRects (mobile), focusedLeafId, or at one tile", () => {
    expect(
      build(MAIN_LEFT, { focusedLeafId: "web" }).some((a) =>
        a.id.startsWith("tile-swap-"),
      ),
    ).toBe(false);
    expect(
      build(MAIN_LEFT, { leafRects: () => MAIN_LEFT_RECTS }).some((a) =>
        a.id.startsWith("tile-swap-"),
      ),
    ).toBe(false);
    expect(
      build(SINGLE_TTY, swapOpts("tty")).some((a) => a.id.startsWith("tile-swap-")),
    ).toBe(false);
  });
});

describe("buildLayoutActions — templates", () => {
  it("at 2 tiles the template rows are Row and Column only", () => {
    const actions = ids(SPLIT_H_TTY_CODE);
    expect(actions).toContain("layout-template-row");
    expect(actions).toContain("layout-template-col");
    expect(actions).not.toContain("layout-template-main-left");
    expect(actions).not.toContain("layout-template-grid");
  });

  it("at 3 tiles the six structurally distinct templates are listed", () => {
    const actions = ids(MAIN_LEFT);
    for (const name of ["row", "col", "main-left", "main-right", "main-top", "main-bottom"]) {
      expect(actions).toContain(`layout-template-${name}`);
    }
    expect(actions).not.toContain("layout-template-grid");
  });

  it("a template row carries the template label and fires onApplyTemplate", () => {
    const onApplyTemplate = vi.fn();
    const onApply = vi.fn();
    const actions = build(MAIN_LEFT, { onApplyTemplate, onApply });
    const jump = actions.find((a) => a.id === "layout-template-main-right")!;
    expect(jump.label).toBe("Layout: Main Right");
    jump.onSelect();
    expect(onApplyTemplate).toHaveBeenCalledWith("main-right");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("`Layout: Cycle Template` carries the registry actionId and fires onCycleTemplate", () => {
    const onCycleTemplate = vi.fn();
    const onApply = vi.fn();
    const actions = build(MAIN_LEFT, { onCycleTemplate, onApply });
    const cycle = actions.find((a) => a.id === "layout-cycle")!;
    expect(cycle.label).toBe("Layout: Cycle Template");
    cycle.onSelect();
    expect(onCycleTemplate).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a template whose result lands under the size floor is not offered", () => {
    // A 300×150 box: every 3-tile template lands some tile under 150×100.
    const tiny = new Map<string, Rect>([
      ["tty", { x: 0, y: 0, w: 150, h: 150 }],
      ["code", { x: 156, y: 0, w: 150, h: 72 }],
      ["web", { x: 156, y: 78, w: 150, h: 72 }],
    ]);
    const actions = build(MAIN_LEFT, { leafRects: () => tiny }).map((a) => a.id);
    expect(actions.some((id) => id.startsWith("layout-template-"))).toBe(false);
  });

  it("a single tile offers no template rows and no cycle", () => {
    const actions = ids(SINGLE_TTY);
    expect(actions.some((id) => id.startsWith("layout-template-"))).toBe(false);
    expect(actions).not.toContain("layout-cycle");
  });
});

describe("buildLayoutActions — the toggle-chord hint (code-toggle documentation)", () => {
  it("stamps the toggle chord on the chord-target surface's Show/Hide entry", () => {
    // tty-only open: the target (code) is closed → its SHOW entry carries it.
    const added = build(SINGLE_TTY, { toggleTarget: "code", toggleShortcut: "⌘2" });
    expect(added.find((a) => a.id === "tile-show-code")?.shortcut).toBe("⌘2");
    expect(added.find((a) => a.id === "tile-show-web")?.shortcut).toBeUndefined();
    // Target open: its HIDE entry carries the hint instead.
    const closed = build(SPLIT_H_TTY_CODE, { toggleTarget: "code", toggleShortcut: "⌘2" });
    expect(closed.find((a) => a.id === "tile-hide-code")?.shortcut).toBe("⌘2");
  });

  it("omits the hint when the chord is disabled/unbound (empty shortcut)", () => {
    const actions = build(SINGLE_TTY, { toggleTarget: "code", toggleShortcut: "" });
    expect(actions.find((a) => a.id === "tile-show-code")?.shortcut).toBeUndefined();
  });
});

describe("buildLayoutActions — Tile: Focus <Surface>", () => {
  it("offers one Focus entry per open NON-focused kind (the focused one is omitted)", () => {
    const actions = build(SPLIT_H_TTY_CODE, {
      focusedKind: "tty",
      onFocus: vi.fn(),
    }).map((a) => a.id);
    expect(actions).toContain("tile-focus-code");
    expect(actions).not.toContain("tile-focus-tty"); // already focused
  });

  it("a Focus entry fires onFocus with the kind (the focusTileRef seam), never onApply", () => {
    const onApply = vi.fn();
    const onFocus = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { onApply, focusedKind: "tty", onFocus });
    const entry = actions.find((a) => a.id === "tile-focus-code")!;
    expect(entry.label).toBe("Tile: Focus Code");
    entry.onSelect();
    expect(onFocus).toHaveBeenCalledWith("code");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("duplicate kinds yield ONE Focus entry (the seam focuses the first leaf)", () => {
    const twoTty: Layout = { dir: "h", children: [{ leaf: "tty" }, { leaf: "tty" }] };
    const actions = build(twoTty, { focusedKind: "code", onFocus: vi.fn() }, [
      "tty",
      "code",
    ]).map((a) => a.id);
    expect(actions.filter((id) => id === "tile-focus-tty")).toHaveLength(1);
  });

  it("hidden at one tile, without onFocus (mobile), and without focusedKind", () => {
    const onFocus = vi.fn();
    expect(
      build(SINGLE_TTY, { focusedKind: "tty", onFocus }).some((a) =>
        a.id.startsWith("tile-focus-"),
      ),
    ).toBe(false);
    expect(
      build(SPLIT_H_TTY_CODE, { focusedKind: "tty" }).some((a) =>
        a.id.startsWith("tile-focus-"),
      ),
    ).toBe(false);
    expect(
      build(SPLIT_H_TTY_CODE, { onFocus }).some((a) => a.id.startsWith("tile-focus-")),
    ).toBe(false);
  });

  it("a 3-tile layout lists both non-focused kinds", () => {
    const actions = build(MAIN_LEFT, { focusedKind: "code", onFocus: vi.fn() }).map(
      (a) => a.id,
    );
    expect(actions).toContain("tile-focus-tty");
    expect(actions).toContain("tile-focus-web");
    expect(actions).not.toContain("tile-focus-code");
  });
});

describe("buildLayoutActions — Tile: Bring <window> <Surface> here", () => {
  const BRING_WINDOWS: BringWindow[] = [
    { id: "@3", name: "api", surfaces: ["tty", "code", "web"] },
    { id: "@5", name: "docs", surfaces: ["tty", "web"] },
  ];

  it("lists one row per other window × lendable surface, named by window + surface label", () => {
    const actions = build(SINGLE_TTY, { bringWindows: BRING_WINDOWS, onBring: vi.fn() });
    const ids = actions.map((a) => a.id);
    for (const kind of ["tty", "code", "web"]) {
      expect(ids).toContain(`tile-bring-@3-${kind}`);
    }
    expect(ids).toContain("tile-bring-@5-tty");
    expect(ids).toContain("tile-bring-@5-web");
    expect(ids).not.toContain("tile-bring-@5-code");
    expect(actions.find((a) => a.id === "tile-bring-@3-tty")?.label).toBe(
      "Tile: Bring api Terminal here",
    );
  });

  it("never offers gui, even when the window lists it", () => {
    const actions = build(SINGLE_TTY, {
      bringWindows: [{ id: "@3", name: "api", surfaces: ["tty", "gui"] }],
      onBring: vi.fn(),
    }).map((a) => a.id);
    expect(actions).toContain("tile-bring-@3-tty");
    expect(actions).not.toContain("tile-bring-@3-gui");
  });

  it("omits surfaces already in this layout (a bare kind and a foreign leaf of it coexist)", () => {
    // h(tty,@3/tty): @3's tty is present, its web is not.
    const borrowed: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "tty", home: "@3" }],
    };
    const actions = build(borrowed, {
      bringWindows: [{ id: "@3", name: "api", surfaces: ["tty", "web"] }],
      onBring: vi.fn(),
    }).map((a) => a.id);
    expect(actions).not.toContain("tile-bring-@3-tty");
    expect(actions).toContain("tile-bring-@3-web");
  });

  it("omits Bring rows when no split fits the size floor", () => {
    const tiny = new Map<string, Rect>([["tty", { x: 0, y: 0, w: 100, h: 150 }]]);
    const actions = build(SINGLE_TTY, {
      bringWindows: BRING_WINDOWS,
      onBring: vi.fn(),
      leafRects: () => tiny,
    }).map((a) => a.id);
    expect(actions.some((id) => id.startsWith("tile-bring-"))).toBe(false);
  });

  it("offers no Bring rows without bringWindows or onBring", () => {
    expect(
      build(SINGLE_TTY, { onBring: vi.fn() }).some((a) => a.id.startsWith("tile-bring-")),
    ).toBe(false);
    expect(
      build(SINGLE_TTY, { bringWindows: BRING_WINDOWS }).some((a) =>
        a.id.startsWith("tile-bring-"),
      ),
    ).toBe(false);
  });

  it("a Bring row inserts the foreign leaf by the generic add rule and fires onBring", () => {
    const onBring = vi.fn();
    const onApply = vi.fn();
    const actions = build(SINGLE_TTY, { bringWindows: BRING_WINDOWS, onBring, onApply });
    actions.find((a) => a.id === "tile-bring-@3-tty")!.onSelect();
    expect(onBring).toHaveBeenCalledWith("@3/tty", {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "tty", home: "@3" }],
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a Bring row splits the FOCUSED tile when focusedLeafId is passed", () => {
    const onBring = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, {
      bringWindows: [{ id: "@3", name: "api", surfaces: ["web"] }],
      onBring,
      focusedLeafId: "tty",
    });
    actions.find((a) => a.id === "tile-bring-@3-web")!.onSelect();
    expect(onBring).toHaveBeenCalledWith("@3/web", {
      dir: "h",
      children: [
        { dir: "v", children: [{ leaf: "tty" }, { leaf: "web", home: "@3" }] },
        { leaf: "code" },
      ],
    });
  });
});

describe("buildLayoutActions — Tile: Send Back to <home window>", () => {
  const BORROWED: Layout = {
    dir: "h",
    children: [{ leaf: "tty" }, { leaf: "tty", home: "@3" }],
  };
  const sendBackOpts = {
    focusedLeafId: "@3/tty",
    onSendBack: vi.fn(),
    windowNameFor: (id: string) => (id === "@3" ? "api" : undefined),
  };

  it("offered for a focused foreign tile, labelled with the home window's name", () => {
    const actions = build(BORROWED, sendBackOpts);
    const row = actions.find((a) => a.id === "tile-send-back")!;
    expect(row.label).toBe("Tile: Send Back to api");
    expect(row.disabled).toBe(false);
  });

  it("fires onSendBack with the focused leaf's address", () => {
    const onSendBack = vi.fn();
    const actions = build(BORROWED, { ...sendBackOpts, onSendBack });
    actions.find((a) => a.id === "tile-send-back")!.onSelect();
    expect(onSendBack).toHaveBeenCalledWith("@3/tty");
  });

  it("hidden when the focused tile is bare, unfocused, or onSendBack is absent", () => {
    expect(
      build(BORROWED, { ...sendBackOpts, focusedLeafId: "tty" }).some(
        (a) => a.id === "tile-send-back",
      ),
    ).toBe(false);
    expect(
      build(BORROWED, { ...sendBackOpts, focusedLeafId: undefined }).some(
        (a) => a.id === "tile-send-back",
      ),
    ).toBe(false);
    const { onSendBack: _omitted, ...noHandler } = sendBackOpts;
    expect(build(BORROWED, noHandler).some((a) => a.id === "tile-send-back")).toBe(false);
  });

  it("a dead home window renders the row disabled, labelled by address", () => {
    const actions = build(BORROWED, { ...sendBackOpts, windowNameFor: () => undefined });
    const row = actions.find((a) => a.id === "tile-send-back")!;
    expect(row.disabled).toBe(true);
    expect(row.label).toBe("Tile: Send Back to @3");
  });
});

describe("buildLayoutActions — Tile: Bring Back <Surface>", () => {
  // The home tab: h(tty,code) with tty held by @3 and code by @5.
  const bringBackOpts = {
    awayIn: { tty: "@3", code: "@5" },
    routeWindowId: "@1",
    onBringBack: vi.fn(),
    windowNameFor: (id: string) => (id === "@3" ? "api" : id === "@5" ? "docs" : undefined),
  };

  it("offers one row per away bare-leaf kind, labelled by surface", () => {
    const ids = build(SPLIT_H_TTY_CODE, bringBackOpts).map((a) => a.id);
    expect(ids).toContain("tile-bring-back-tty");
    expect(ids).toContain("tile-bring-back-code");
    const row = build(SPLIT_H_TTY_CODE, bringBackOpts).find(
      (a) => a.id === "tile-bring-back-tty",
    )!;
    expect(row.label).toBe("Tile: Bring Back Terminal");
    expect(row.disabled).toBeUndefined();
  });

  it("fires onBringBack with the holder window and the home leaf address", () => {
    const onBringBack = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { ...bringBackOpts, onBringBack });
    actions.find((a) => a.id === "tile-bring-back-tty")!.onSelect();
    expect(onBringBack).toHaveBeenCalledWith("@3", "@1/tty");
  });

  it("absent when awayIn is empty or the route id / write seam is missing", () => {
    const none = (overrides: Partial<Parameters<typeof build>[1]>) =>
      build(SPLIT_H_TTY_CODE, overrides).some((a) => a.id.startsWith("tile-bring-back-"));
    expect(none({ ...bringBackOpts, awayIn: {} })).toBe(false);
    expect(none({ ...bringBackOpts, awayIn: undefined })).toBe(false);
    const { onBringBack: _omitted, ...noHandler } = bringBackOpts;
    expect(none(noHandler)).toBe(false);
    expect(none({ ...bringBackOpts, routeWindowId: undefined })).toBe(false);
  });

  it("not offered for a kind present only as a foreign leaf", () => {
    // h(tty,@9/web) with web away at @3: web has no bare leaf here.
    const layout: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "web", home: "@9" }],
    };
    const ids = build(layout, {
      ...bringBackOpts,
      awayIn: { web: "@3" },
      windowNameFor: () => "api",
    }).map((a) => a.id);
    expect(ids).not.toContain("tile-bring-back-web");
  });

  it("not offered when the holder window is dead", () => {
    const ids = build(SPLIT_H_TTY_CODE, {
      ...bringBackOpts,
      windowNameFor: () => undefined,
    }).map((a) => a.id);
    expect(ids.some((id) => id.startsWith("tile-bring-back-"))).toBe(false);
  });
});

describe("buildTileSwitchActions — Tile: Switch to <Surface> (mobile)", () => {
  it("offers one entry per available, not-visible surface", () => {
    const actions = buildTileSwitchActions(ALL, "tty", vi.fn());
    expect(actions.map((a) => a.id)).toEqual(["tile-switch-web", "tile-switch-code"]);
  });

  it("labels read `Tile: Switch to <Surface>` and fire onSwitch with the kind", () => {
    const onSwitch = vi.fn();
    const actions = buildTileSwitchActions(["tty", "web"], "tty", onSwitch);
    const entry = actions.find((a) => a.id === "tile-switch-web")!;
    expect(entry.label).toBe("Tile: Switch to Web");
    entry.onSelect();
    expect(onSwitch).toHaveBeenCalledWith("web");
  });

  it("a single-surface window yields no entries (nothing to switch to)", () => {
    expect(buildTileSwitchActions(["tty"], "tty", vi.fn())).toEqual([]);
  });

  it("excludes the visible surface from the destination list", () => {
    const actions = buildTileSwitchActions(["tty", "web", "code"], "web", vi.fn());
    expect(actions.map((a) => a.id)).toEqual(["tile-switch-tty", "tile-switch-code"]);
  });
});

// `Tile: Pop Out <Surface>` / `Tile: Pop Back In <Surface>` — the popout
// verbs (spec surface-layout.md § Verbs → Pop out). Pop Out is offered per
// open, not-popped, live leaf at any rendered arity, with foreign leaves
// disambiguated by the home window's name; Pop Back In is offered per popped
// leaf still in the shared tree. While any leaf is popped, the
// `Layout: <Template>` rows and the cycle entry gate off (a template
// resolved on the reduced render would strand the popped leaf).
describe("buildLayoutActions — popout verbs", () => {
  const popOpts = {
    onPopOut: vi.fn(),
    onPopIn: vi.fn(),
    windowNameFor: (id: string) => (id === "@9" ? "api" : undefined),
  };

  it("offers Pop Out per open leaf", () => {
    const ids = build(SPLIT_H_TTY_CODE, popOpts).map((a) => a.id);
    expect(ids).toContain("tile-pop-out-tty");
    expect(ids).toContain("tile-pop-out-code");
  });

  it("offers Pop Out on a single-tile layout", () => {
    const ids = build(SINGLE_TTY, popOpts).map((a) => a.id);
    expect(ids).toContain("tile-pop-out-tty");
  });

  it("offers NO Pop Out rows when onPopOut is omitted (the caller's mobile / shell-without-popout-channel gate)", () => {
    const ids = build(SPLIT_H_TTY_CODE, { onPopIn: vi.fn() }).map((a) => a.id);
    expect(ids.some((id) => id.startsWith("tile-pop-out-"))).toBe(false);
  });

  it("Pop Out fires the seam with the leaf id", () => {
    const onPopOut = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { ...popOpts, onPopOut });
    actions.find((a) => a.id === "tile-pop-out-code")!.onSelect();
    expect(onPopOut).toHaveBeenCalledWith("code");
  });

  it("labels a foreign leaf with its home window's name and omits a dead-home one", () => {
    const layout: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "tty", home: "@9" }, { leaf: "web", home: "@12" }],
    };
    const actions = build(layout, popOpts);
    const foreign = actions.find((a) => a.id === "tile-pop-out-@9/tty");
    expect(foreign?.label).toBe("Tile: Pop Out api Terminal");
    expect(actions.some((a) => a.id === "tile-pop-out-@12/web")).toBe(false);
  });

  it("omits Pop Out for a popped leaf and for an away bare kind", () => {
    const layout: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "code" }, { leaf: "web" }],
    };
    const popped = build(layout, { ...popOpts, poppedIds: ["code"] }).map((a) => a.id);
    expect(popped).not.toContain("tile-pop-out-code");
    expect(popped).toContain("tile-pop-out-tty");
    const away = build(layout, { ...popOpts, awayIn: { web: "@3" }, routeWindowId: "@1" }).map(
      (a) => a.id,
    );
    expect(away).not.toContain("tile-pop-out-web");
  });

  it("keeps the last Pop Out when every other leaf is popped (rendered arity 1)", () => {
    const layout: Layout = {
      dir: "h",
      children: [{ leaf: "tty" }, { leaf: "code" }],
    };
    const ids = build(layout, { ...popOpts, poppedIds: ["code"] }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["tile-pop-out-tty"]));
    expect(ids.filter((id) => id.startsWith("tile-pop-out-"))).toEqual(["tile-pop-out-tty"]);
  });

  it("offers Pop Back In per popped leaf and fires the seam", () => {
    const onPopIn = vi.fn();
    const actions = build(SPLIT_H_TTY_CODE, { ...popOpts, onPopIn, poppedIds: ["code"] });
    const entry = actions.find((a) => a.id === "tile-pop-in-code")!;
    expect(entry.label).toBe("Tile: Pop Back In Code");
    entry.onSelect();
    expect(onPopIn).toHaveBeenCalledWith("code");
  });

  it("omits Pop Back In for a popped id that left the shared tree", () => {
    const ids = build(SPLIT_H_TTY_CODE, { ...popOpts, poppedIds: ["web"] }).map((a) => a.id);
    expect(ids.some((id) => id.startsWith("tile-pop-in-"))).toBe(false);
  });

  it("gates the template rows and the cycle entry off while a leaf is popped", () => {
    const plain = build(MAIN_LEFT).map((a) => a.id);
    expect(plain.some((id) => id.startsWith("layout-template-"))).toBe(true);
    expect(plain).toContain("layout-cycle");
    const popped = build(MAIN_LEFT, { ...popOpts, poppedIds: ["web"] }).map((a) => a.id);
    expect(popped.some((id) => id.startsWith("layout-template-"))).toBe(false);
    expect(popped).not.toContain("layout-cycle");
  });
});
