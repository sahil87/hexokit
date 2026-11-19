import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { GuiToolbar } from "./gui-toolbar";
import { buildGuiActions, type GuiPaletteAction, type GuiPaletteInput } from "@/lib/palette/gui";
import type { GuiQuality } from "@/lib/gui-posture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function paletteInput(overrides: Partial<GuiPaletteInput> = {}): GuiPaletteInput {
  return {
    enabled: true,
    reachable: true,
    backend: "Xtigervnc",
    tileOpen: true,
    connected: true,
    coarsePointer: true,
    zoom: 100,
    pointerMode: "trackpad",
    resizeLocked: false,
    locked: false,
    quality: "balanced",
    statsVisible: false,
    hidpi: false,
    keyBarVisible: true,
    toolbarVisible: false,
    capture: false,
    onCaptureChange: vi.fn(),
    geometry: "auto",
    supervisorAvailable: true,
    onTurnOn: vi.fn(),
    onTurnOff: vi.fn(),
    loadDesktopRows: vi.fn().mockResolvedValue([]),
    onLaunch: vi.fn(),
    onResize: vi.fn(),
    onResizeCustom: vi.fn(),
    onMatchTile: vi.fn(),
    onFullscreen: vi.fn(),
    onPaste: vi.fn(),
    onZoom: vi.fn(),
    onPointerMode: vi.fn(),
    onLockChange: vi.fn(),
    onQuality: vi.fn(),
    onStatsVisible: vi.fn(),
    onHidpiChange: vi.fn(),
    onKeyBarVisibleChange: vi.fn(),
    onToolbarVisibleChange: vi.fn(),
    onSendKey: vi.fn(),
    onOpenLogs: vi.fn(),
    onReconnect: vi.fn(),
    ...overrides,
  };
}

interface RenderProps {
  input?: Partial<GuiPaletteInput>;
  coarsePointer?: boolean;
  quality?: GuiQuality;
  statsVisible?: boolean;
  capture?: boolean;
  geometry?: string;
  width?: number;
  height?: number;
  locked?: boolean;
  toolbarVisible?: boolean;
  onToolbarVisibleChange?: (visible: boolean) => void;
}

function el(p: RenderProps, actions: GuiPaletteAction[]) {
  return (
    <GuiToolbar
      actions={actions}
      coarsePointer={p.coarsePointer ?? false}
      quality={p.quality ?? "balanced"}
      statsVisible={p.statsVisible ?? false}
      capture={p.capture ?? false}
      geometry={p.geometry ?? "auto"}
      width={p.width ?? 0}
      height={p.height ?? 0}
      locked={p.locked ?? false}
      toolbarVisible={p.toolbarVisible ?? false}
      onToolbarVisibleChange={p.onToolbarVisibleChange ?? (() => {})}
    />
  );
}

/** Render the cluster against ONE built `buildGuiActions` list (the same
 *  array the palette would get). jsdom has no layout: the probe reads all
 *  zero, so the fold keeps its cold default — FULLY EXPANDED — unless the
 *  test mocks probe widths (see mockWidths). */
function setup(props: RenderProps = {}) {
  const input = paletteInput({
    coarsePointer: props.coarsePointer ?? true,
    quality: props.quality ?? "balanced",
    statsVisible: props.statsVisible ?? false,
    geometry: props.geometry ?? "auto",
    locked: props.locked ?? false,
    ...props.input,
  });
  const actions = buildGuiActions(input);
  const utils = render(el(props, actions));
  return {
    ...utils,
    input,
    actions,
    rerenderWith: (patch: RenderProps) => utils.rerender(el({ ...props, ...patch }, actions)),
  };
}

/** Drive the fold in jsdom: the probe children's `data-fold` widths come
 *  from `widths`; the root spring's clientWidth is `available`. The
 *  ResizeObserver stub never fires, so the measure runs once at mount —
 *  mount a fresh setup per width case. */
function mockWidths(available: number, widths: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.getAttribute("data-fold");
    if (key !== null && key in widths) return widths[key];
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("data-testid") === "gui-toolbar" ? available : 0;
  });
}

/** Round-number probe widths mirroring the pure module's fixture. The
 *  default connected fixture has 10 ladder items (no reconnect): full fit
 *  377px, quality-degraded 321px, fully degraded 281px, pinned block 29px. */
const PROBE = {
  size: 90,
  "size:short": 50,
  "zoom-out": 24,
  "zoom-fit": 24,
  "zoom-in": 24,
  quality: 80,
  "quality:short": 24,
  paste: 24,
  "send-key": 24,
  terminal: 24,
  browser: 24,
  stats: 24,
  reconnect: 24,
  divider: 5,
  pinned: 29,
};

/** Replace a row's onSelect with a recording wrapper — a chip firing ANY
 *  other function object fails the assertion. */
function spyRow(actions: GuiPaletteAction[], id: string) {
  const row = actions.find((a) => a.id === id);
  if (!row) throw new Error(`palette row ${id} missing`);
  const spy = vi.fn(row.onSelect);
  row.onSelect = spy;
  return spy;
}

const inlineLabels = () =>
  within(screen.getByTestId("gui-toolbar"))
    .getAllByRole("button")
    .filter((b) => b.closest("[data-fold]") === null)
    .map((b) => b.getAttribute("aria-label"));

describe("GuiToolbar — presence table (expanded cold default)", () => {
  it("fine + connected + non-mirror: the full inventory in ladder order, the capture verb pinned, no ⚙", () => {
    setup({ coarsePointer: false, geometry: "1920x1080", width: 1920, height: 1080 });
    expect(inlineLabels()).toEqual([
      "Resolution 1920×1080, menu",
      "Zoom out",
      "Zoom to fit",
      "Zoom in",
      "Quality",
      "Paste clipboard",
      "Send key…",
      "Open terminal",
      "Open browser",
      "Toggle stats",
      "Keyboard capture",
    ]);
    // Four groups ⇒ three ladder dividers, plus the pinned block's leading
    // hairline — none between the action glyphs.
    expect(
      within(screen.getByTestId("gui-toolbar"))
        .queryAllByRole("generic", { hidden: true })
        .filter((s) => s.className.includes("w-px") && s.closest("[data-fold]") === null),
    ).toHaveLength(4);
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
  });

  it("coarse pointers get NO inline ⌖/⌨ chips — the pair lives in the panel", () => {
    setup({ coarsePointer: true });
    expect(screen.queryByLabelText("Pointer mode")).toBeNull();
    expect(screen.queryByLabelText("Toggle key bar")).toBeNull();
  });

  it("disconnected: ⎘/⌥ are absent and ↻ is present", () => {
    setup({ input: { connected: false } });
    expect(screen.queryByLabelText("Paste clipboard")).toBeNull();
    expect(screen.queryByLabelText("Send key…")).toBeNull();
    expect(screen.getByLabelText("Reconnect")).toBeTruthy();
  });

  it("mirror backend: the size and launch rungs are absent with their rows; the quality chip disables", () => {
    setup({ input: { backend: "screen-sharing" } });
    expect(screen.queryByTestId("gui-toolbar-resolution")).toBeNull();
    expect(screen.queryByLabelText("Open terminal")).toBeNull();
    expect(screen.queryByLabelText("Open browser")).toBeNull();
    expect(screen.getByLabelText("Quality")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Toggle stats")).toBeTruthy();
  });

  it("the palette-only rows never appear in the cluster or its menus", () => {
    mockWidths(270, PROBE);
    setup({ toolbarVisible: true });
    const cluster = screen.getByTestId("gui-toolbar");
    for (const text of ["Turn off", "Desktop…", "logs", "HiDPI", "1:1"]) {
      expect(cluster.textContent).not.toContain(text);
    }
  });
});

describe("GuiToolbar — gating", () => {
  it("the zoom chips render disabled (not absent) at fit and at 200", () => {
    setup({ input: { zoom: "fit" } });
    expect(screen.getByLabelText("Zoom out")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Zoom to fit")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Zoom in")).toHaveProperty("disabled", false);
    cleanup();
    setup({ input: { zoom: 200 } });
    expect(screen.getByLabelText("Zoom in")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Zoom out")).toHaveProperty("disabled", false);
  });

  it("∿ reflects the stats posture and fires the destination row", () => {
    const { actions, rerenderWith } = setup({ statsVisible: false });
    const show = spyRow(actions, "gui-stats-show");
    expect(screen.getByLabelText("Toggle stats")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByLabelText("Toggle stats"));
    expect(show).toHaveBeenCalledOnce();
    rerenderWith({ statsVisible: true });
    // The built list still holds gui-stats-show (actions are one build); the
    // pressed state rides the prop.
    expect(screen.getByLabelText("Toggle stats")).toHaveAttribute("aria-pressed", "true");
  });

  it("no control carries a native title (Tip replaces it, never both)", () => {
    setup();
    for (const b of within(screen.getByTestId("gui-toolbar")).getAllByRole("button")) {
      expect(b.getAttribute("title")).toBeNull();
    }
  });
});

describe("GuiToolbar — the size chip", () => {
  it("auto geometry reads `auto ▾`", () => {
    setup();
    const chip = screen.getByTestId("gui-toolbar-resolution");
    expect(chip).toHaveTextContent("auto ▾");
    expect(chip.getAttribute("aria-label")).toBe("Resolution auto, menu");
  });

  it("a fixed geometry reads the live W×H", () => {
    setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    const chip = screen.getByTestId("gui-toolbar-resolution");
    expect(chip).toHaveTextContent("1920×1080 ▾");
    expect(chip.getAttribute("aria-label")).toBe("Resolution 1920×1080, menu");
  });

  it("the locked prefix is 🔒 and the aria-label says locked", () => {
    setup({ geometry: "1920x1080", width: 1920, height: 1080, locked: true });
    const chip = screen.getByTestId("gui-toolbar-resolution");
    expect(chip).toHaveTextContent("🔒 1920×1080 ▾");
    expect(chip.getAttribute("aria-label")).toBe("Resolution 1920×1080, locked, menu");
  });

  it("a zeroed size falls back to presetLabel(geometry) without the (portrait) suffix", () => {
    setup({ geometry: "1080x1920", width: 0, height: 0 });
    expect(screen.getByTestId("gui-toolbar-resolution")).toHaveTextContent("1080×1920 ▾");
  });

  it("the chip is absent when no gui-res-* row exists", () => {
    setup({ input: { reachable: false } });
    expect(screen.queryByTestId("gui-toolbar-resolution")).toBeNull();
  });
});

describe("GuiToolbar — the resolution menu", () => {
  it("lists the palette's Resolution and Lock rows in order with stripped labels and verbatim descriptions", () => {
    setup({ coarsePointer: false, geometry: "1920x1080", width: 1920, height: 1080 });
    fireEvent.click(screen.getByTestId("gui-toolbar-resolution"));
    const menu = screen.getByTestId("gui-toolbar-menu");
    expect(menu.getAttribute("data-menu")).toBe("resolution");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual([
      "1280×720",
      "1600×900",
      "1920×1080✓",
      "2560×1440",
      "1080×1920 (portrait)",
      "Match this tile",
      "Auto (follow this tile) — today's behavior — the desktop follows the focused fine-pointer viewer",
      "Custom…",
      "Lock resolution — resolution is fixed (1920×1080) — pick Auto to follow the tile",
    ]);
    expect(items[8]).toHaveProperty("disabled", true);
  });

  it("under geometry=auto the Auto row is absent", () => {
    setup({ geometry: "auto" });
    fireEvent.click(screen.getByTestId("gui-toolbar-resolution"));
    expect(screen.getByTestId("gui-toolbar-menu").textContent).not.toContain(
      "Auto (follow this tile)",
    );
  });

  it("a coarse pointer has no lock row", () => {
    setup({ coarsePointer: true, geometry: "1920x1080", width: 1920, height: 1080 });
    fireEvent.click(screen.getByTestId("gui-toolbar-resolution"));
    expect(screen.getByTestId("gui-toolbar-menu").textContent).not.toContain("Lock resolution");
    expect(screen.getByTestId("gui-toolbar-menu").textContent).not.toContain("Unlock resolution");
  });

  it("picking a size fires the row immediately and closes the menu", () => {
    const { input } = setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    fireEvent.click(screen.getByTestId("gui-toolbar-resolution"));
    fireEvent.click(
      within(screen.getByTestId("gui-toolbar-menu"))
        .getAllByRole("menuitem")
        .find((el) => el.textContent === "1280×720")!,
    );
    expect(input.onResize).toHaveBeenCalledWith("1280x720");
    expect(screen.queryByTestId("gui-toolbar-menu")).toBeNull();
  });
});

describe("GuiToolbar — the measured fold", () => {
  it("everything fits: full labels inline, no ⚙, nothing reserved", () => {
    mockWidths(500, PROBE);
    setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    expect(screen.getByTestId("gui-toolbar-resolution")).toHaveTextContent("1920×1080 ▾");
    expect(screen.getByLabelText("Quality")).toHaveTextContent("◐ Balanced");
    expect(screen.getByLabelText("Toggle stats")).toBeTruthy();
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
  });

  it("degradation is spent before any fold: quality drops to ◐, nothing folds, no ⚙", () => {
    // Full needs 377; quality-degraded needs 321 — at 340 only the label pays.
    mockWidths(340, PROBE);
    setup();
    expect(screen.getByLabelText("Quality")).toHaveTextContent("◐");
    expect(screen.getByLabelText("Toggle stats")).toBeTruthy();
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
  });

  it("a narrow spring folds the ladder tail into ⚙ (with the reserve costing one more)", () => {
    // Fully degraded needs 281; pass 1 at 270 folds stats (257 ≤ 270), which
    // lights the reserve — pass 2 at 241 folds browser too (257 > 241).
    mockWidths(270, PROBE);
    setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    expect(screen.queryByLabelText("Toggle stats")).toBeNull();
    expect(screen.queryByLabelText("Open browser")).toBeNull();
    expect(screen.getByLabelText("Open terminal")).toBeTruthy();
    // Both degradable labels are spent before the fold.
    expect(screen.getByTestId("gui-toolbar-resolution")).toHaveTextContent("1920 ▾");
    expect(screen.getByLabelText("Quality")).toHaveTextContent("◐");
    expect(screen.getByTestId("gui-toolbar-overflow")).toBeTruthy();
  });

  it("the ⚙ panel carries the folded rungs' palette rows in ladder order", () => {
    mockWidths(270, PROBE);
    setup({ toolbarVisible: true });
    const menu = screen.getByTestId("gui-toolbar-menu");
    expect(menu.getAttribute("data-menu")).toBe("overflow");
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Open browser",
      "Show stats",
    ]);
  });

  it("coarse panels append the ⌖/⌨ rows after a separator", () => {
    mockWidths(270, PROBE);
    setup({ coarsePointer: true, toolbarVisible: true });
    const menu = screen.getByTestId("gui-toolbar-menu");
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Open browser",
      "Show stats",
      "Pointer → Touch — tap where you touch",
      "Hide key bar",
    ]);
  });

  it("at the narrowest widths the size rung folds too, inlining the resolution rows", () => {
    // Pass 1 at 70 fits the degraded size alone; pass 2 at 41 fits nothing —
    // the whole ladder folds and the panel hosts the resolution rows.
    mockWidths(70, PROBE);
    setup({ geometry: "1920x1080", width: 1920, height: 1080, toolbarVisible: true });
    expect(screen.queryByTestId("gui-toolbar-resolution")).toBeNull();
    const items = within(screen.getByTestId("gui-toolbar-menu")).getAllByRole("menuitem");
    const texts = items.map((el) => el.textContent);
    expect(texts).toContain("1280×720");
    expect(texts).toContain("Zoom in");
    expect(texts).toContain("Quality → Balanced");
    expect(texts).toContain("Paste clipboard");
    expect(texts).toContain("Show stats");
  });

  it("the ⚙ toggle routes the open state to the caller, and the open panel never autofocuses on a cold mount", () => {
    mockWidths(270, PROBE);
    const onToolbarVisibleChange = vi.fn();
    setup({ onToolbarVisibleChange });
    fireEvent.click(screen.getByTestId("gui-toolbar-overflow"));
    expect(onToolbarVisibleChange).toHaveBeenCalledWith(true);
    cleanup();
    vi.restoreAllMocks();

    // A persisted-open panel mounts WITH the page: it renders open but does
    // not steal focus into the menu.
    mockWidths(270, PROBE);
    setup({ toolbarVisible: true });
    const menu = screen.getByTestId("gui-toolbar-menu");
    expect(menu.contains(document.activeElement)).toBe(false);
  });

  it("a wide remount after a folded state hides ⚙ again (hysteresis is the module's, not the component's)", () => {
    mockWidths(500, PROBE);
    setup();
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
  });
});

describe("GuiToolbar — the pinned capture verb", () => {
  it("renders in the pinned block on a fine pointer and fires the palette row's own onSelect", () => {
    const { actions } = setup({ coarsePointer: false });
    const spy = spyRow(actions, "gui-capture-toggle");
    const verb = screen.getByTestId("gui-capture-toggle");
    expect(verb.querySelector('[data-icon="keyboard"]')).toBeTruthy();
    expect(verb).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(verb);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });

  it("a mousedown on the verb never takes focus, so keys keep reaching the guest canvas", () => {
    setup({ coarsePointer: false });
    const verb = screen.getByTestId("gui-capture-toggle");
    expect(fireEvent.mouseDown(verb)).toBe(false);
  });

  it("latches with the plain well recipe without leaving the 24px verb box", () => {
    const { rerenderWith } = setup({ coarsePointer: false });
    const verb = screen.getByTestId("gui-capture-toggle");
    expect(verb.className).not.toContain("text-accent-green-ink");
    rerenderWith({ capture: true, input: { capture: true } });
    expect(verb).toHaveAttribute("aria-pressed", "true");
    expect(verb.className).toContain("text-accent-green-ink");
    // The plain well paints no border axis, so the box geometry never moves.
    expect(verb.className).toContain("rk-latch-well");
    expect(verb.className).not.toContain("border-border-pressed");
    expect(verb.className).toContain("w-[24px]");
  });

  it("never folds: the verb renders at every width, ⚙ or not", () => {
    // Full fit with the capture reserve spent: 500 − 29 ≥ 377.
    mockWidths(500, { ...PROBE, capture: 29 });
    setup({ coarsePointer: false, geometry: "1920x1080", width: 1920, height: 1080 });
    expect(screen.getByTestId("gui-capture-toggle")).toBeTruthy();
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    // The reserve spends degradation first: 380 − 29 = 351 < 377 degrades the
    // quality label, nothing folds.
    mockWidths(380, { ...PROBE, capture: 29 });
    setup({ coarsePointer: false, geometry: "1920x1080", width: 1920, height: 1080 });
    expect(screen.getByTestId("gui-capture-toggle")).toBeTruthy();
    expect(screen.getByLabelText("Quality")).toHaveTextContent("◐");
    expect(screen.queryByTestId("gui-toolbar-overflow")).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    // The narrowest spring folds the WHOLE ladder into ⚙ — the capture verb
    // stays (the escape hatch that cannot fail).
    mockWidths(70, { ...PROBE, capture: 29 });
    setup({ coarsePointer: false, geometry: "1920x1080", width: 1920, height: 1080 });
    expect(screen.getByTestId("gui-capture-toggle")).toBeTruthy();
    expect(screen.getByTestId("gui-toolbar-overflow")).toBeTruthy();
    expect(screen.queryByTestId("gui-toolbar-resolution")).toBeNull();
  });

  it("is omitted on a coarse pointer, folded or not", () => {
    setup({ coarsePointer: true });
    expect(screen.queryByTestId("gui-capture-toggle")).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    mockWidths(270, PROBE);
    setup({ coarsePointer: true });
    expect(screen.getByTestId("gui-toolbar-overflow")).toBeTruthy();
    expect(screen.queryByTestId("gui-capture-toggle")).toBeNull();
  });
});

describe("GuiToolbar — the by-id mirror (identity)", () => {
  it("every inline chip fires the SAME onSelect function object as its palette row", () => {
    const { actions } = setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    const cases: [string, string][] = [
      ["gui-zoom-out", "Zoom out"],
      ["gui-zoom-fit", "Zoom to fit"],
      ["gui-zoom-in", "Zoom in"],
      ["gui-quality-smooth", "Quality"],
      ["gui-paste", "Paste clipboard"],
      ["gui-send-key", "Send key…"],
      ["gui-open-terminal", "Open terminal"],
      ["gui-open-browser", "Open browser"],
      ["gui-stats-show", "Toggle stats"],
    ];
    for (const [id, label] of cases) {
      const spy = spyRow(actions, id);
      fireEvent.click(screen.getByLabelText(label));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
    }
  });

  it("the reconnect chip fires gui-reconnect", () => {
    const { actions } = setup({ input: { connected: false } });
    const spy = spyRow(actions, "gui-reconnect");
    fireEvent.click(screen.getByLabelText("Reconnect"));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("every resolution menu row fires its own palette row's onSelect object", () => {
    const { actions } = setup({ geometry: "1920x1080", width: 1920, height: 1080 });
    const expected: [string, string][] = [
      ["gui-res-1280x720", "1280×720"],
      ["gui-res-1600x900", "1600×900"],
      ["gui-res-1920x1080", "1920×1080✓"],
      ["gui-res-2560x1440", "2560×1440"],
      ["gui-res-1080x1920", "1080×1920 (portrait)"],
      ["gui-res-match", "Match this tile"],
      [
        "gui-res-auto",
        "Auto (follow this tile) — today's behavior — the desktop follows the focused fine-pointer viewer",
      ],
      ["gui-res-custom", "Custom…"],
    ];
    for (const [id, text] of expected) {
      // Spy before opening: the menu rows capture the row's onSelect at render.
      const spy = spyRow(actions, id);
      fireEvent.click(screen.getByTestId("gui-toolbar-resolution"));
      const item = within(screen.getByTestId("gui-toolbar-menu"))
        .getAllByRole("menuitem")
        .find((el) => el.textContent === text);
      if (!item) throw new Error(`menu row "${text}" missing`);
      fireEvent.click(item);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith();
      expect(screen.queryByTestId("gui-toolbar-menu")).toBeNull();
    }
  });

  it("every ⚙ panel row fires its own palette row's onSelect object", () => {
    mockWidths(270, PROBE);
    const { actions, rerenderWith } = setup({ toolbarVisible: false });
    const expected: [string, string][] = [
      ["gui-open-browser", "Open browser"],
      ["gui-stats-show", "Show stats"],
    ];
    // Spy BEFORE opening: the menu rows capture the row's onSelect at render.
    const spies = expected.map(([id]) => spyRow(actions, id));
    rerenderWith({ toolbarVisible: true });
    const menu = screen.getByTestId("gui-toolbar-menu");
    expected.forEach(([, text], i) => {
      const item = within(menu)
        .getAllByRole("menuitem")
        .find((el) => el.textContent === text);
      if (!item) throw new Error(`menu row "${text}" missing`);
      fireEvent.click(item);
      expect(spies[i]).toHaveBeenCalledTimes(1);
      expect(spies[i]).toHaveBeenCalledWith();
    });
  });
});
