import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SwatchPopover } from "./swatch-popover";
import {
  PICKER_COLOR_VALUES,
  FLAIR_STATES,
  HUE_FAMILIES,
  DEFAULT_DARK_THEME,
  UNCOLORED_SELECTED_KEY,
  computeRowTints,
  computeRowBorders,
  deriveUIColors,
} from "@/themes";

/** The chrome hex the component blends its tint previews into (rows render on
 *  the sidebar chrome, so the popover's previews must match that surface). */
const DARK_CHROME = deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome;

/** The STORED value the write seam maps a picked display value to: a NORMAL
 *  shade maps to its legacy descriptor ("orange" → "1+3", the vocabulary
 *  pre-existing colors are stored in), while a DARK shade has no legacy form
 *  and is stored verbatim ("orange-dark"). onSelect assertions expect this. */
const storedOf = (value: string): string =>
  HUE_FAMILIES.find((f) => f.name === value)?.legacy ?? value;
/** Legacy descriptor of a normal-shade family name (write-seam vocabulary). */
const legacyOf = (familyName: string): string =>
  HUE_FAMILIES.find((f) => f.name === familyName)!.legacy;

/** jsdom serializes inline hex colors to rgb() — mirror that for assertions. */
const rgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** The 16 named flair states (band order; − clear cell lives in the band header). */
const FLAIR_NAMED = FLAIR_STATES.slice(1);

// Minimal ThemeProvider wrapper for tests
import { ThemeProvider } from "@/contexts/theme-context";

function mockMatchMedia() {
  const mql = {
    matches: true,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
}

function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

/** The composite preview row is the parent of the row-name span. */
function previewRow(name: string): HTMLElement {
  return screen.getByText(name).parentElement as HTMLElement;
}

describe("SwatchPopover", () => {
  beforeEach(() => {
    mockMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("color-only variant: 33 swatches + the color header − + panel − + ✕ (no flair band)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);

    // 33 family/shade swatches + the color band's header − + the panel-level
    // − (Clear all — rendered on every variant; degenerates to clear-color
    // here) + the ✕ close cell (options-as-commands, ARIA-valid children).
    expect(screen.getAllByRole("option")).toHaveLength(36);
    expect(screen.getByRole("option", { name: "Clear all" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^Flair / })).toBeNull();
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Color picker");
  });

  it("renders a swatch for every family/shade value", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
    for (const value of PICKER_COLOR_VALUES) {
      expect(screen.getByRole("option", { name: `Color ${value}` })).toBeTruthy();
    }
  });

  it("shows checkmark on the selected family", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(
      <SwatchPopover selectedColor="orange" onSelect={onSelect} onClose={onClose} />,
    );

    const selected = screen.getByRole("option", { name: "Color orange" });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(selected.textContent).toContain("✓");
    // The adjacent dark shade of the SAME family is NOT selected — the ring/✓
    // must be unambiguous between same-family shades.
    expect(
      screen.getByRole("option", { name: "Color orange-dark" }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("a dark-stored value highlights the DARK swatch, not its normal sibling", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(
      <SwatchPopover selectedColor="orange-dark" onSelect={onSelect} onClose={onClose} />,
    );
    const dark = screen.getByRole("option", { name: "Color orange-dark" });
    expect(dark.getAttribute("aria-selected")).toBe("true");
    expect(dark.textContent).toContain("✓");
    expect(
      screen.getByRole("option", { name: "Color orange" }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("swatches are uniform SOLID squares filled with the selected-tint blend (no split halves)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
    const tints = computeRowTints(DEFAULT_DARK_THEME.palette, DARK_CHROME);
    for (const value of ["blue", "blue-dark"]) {
      const swatch = screen.getByRole("option", { name: `Color ${value}` });
      expect(swatch.style.backgroundColor).toBe(rgb(tints.get(value)!.selected));
      // Single fill on the button itself — no inner base/selected half spans.
      expect(swatch.querySelectorAll("span")).toHaveLength(0);
    }
  });

  it("clicking a DARK swatch emits the {family}-dark value verbatim (no legacy form)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("option", { name: "Color green-dark" }));
    expect(onSelect).toHaveBeenCalledWith("green-dark");
  });

  it("highlights the family swatch when selectedColor is a LEGACY descriptor (1+3 → orange)", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(
      <SwatchPopover selectedColor="1+3" onSelect={onSelect} onClose={onClose} />,
    );
    // The legacy "1+3" value normalizes to the "orange" family swatch.
    const orange = screen.getByRole("option", { name: "Color orange" });
    expect(orange.getAttribute("aria-selected")).toBe("true");
    expect(orange.textContent).toContain("✓");
  });

  it("calls onSelect with the family's LEGACY descriptor when a swatch is clicked", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);

    // The popover presents the family name ("green") but emits the legacy value
    // ("2") the backend stores/validates (write-seam mapping).
    fireEvent.click(screen.getByRole("option", { name: "Color green" }));
    expect(onSelect).toHaveBeenCalledWith(legacyOf("green"));
    expect(legacyOf("green")).toBe("2");
  });

  it("the color band's header − clears the color", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(
      <SwatchPopover selectedColor="blue" onSelect={onSelect} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("option", { name: "Clear color" }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("calls onClose on Escape", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("autofocuses the listbox on mount so keyboard nav works immediately", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
    // The palette action is the only keyboard path into the picker; arrows are
    // dead until the listbox holds focus, so the popover focuses it on mount.
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
  });

  it("the 33 picker values are the families in TRIPLET shade order (light | normal | dark per family)", () => {
    expect(PICKER_COLOR_VALUES).toEqual(
      HUE_FAMILIES.flatMap((f) => [`${f.name}-light`, f.name, `${f.name}-dark`]),
    );
    expect(PICKER_COLOR_VALUES).toHaveLength(33);
  });

  // ── Universal square style (maya): the ONLY style — no `square` prop. ──
  describe("universal square style", () => {
    it("every caller gets the square container: no rounding, hard offset block shadow, 190px panel", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
      const listbox = screen.getByRole("listbox");
      expect(listbox.className).not.toContain("rounded-md");
      expect(listbox.className).not.toContain("shadow-lg");
      expect(listbox.className).toContain("w-[190px]");
      expect(listbox.getAttribute("style")).toContain("3px 3px 0");
      // Cells are square too (no rounded-sm) and 18px.
      const swatch = screen.getByRole("option", { name: "Color orange" });
      expect(swatch.className).not.toContain("rounded-sm");
      expect(swatch.className).toContain("w-[18px]");
      expect(swatch.className).toContain("h-[18px]");
    });
  });

  // ── Dismissal model: selection never closes; ✕ / outside / Escape do. ──
  describe("dismissal model", () => {
    it("selection NEVER closes: swatch, header-−, and flair picks leave onClose uncalled", () => {
      const onSelect = vi.fn();
      const onSelectFlair = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(
        <SwatchPopover
          onSelect={onSelect}
          onSelectFlair={onSelectFlair}
          onClose={onClose}
        />,
      );
      fireEvent.click(screen.getByRole("option", { name: "Color blue" }));
      fireEvent.click(screen.getByRole("option", { name: "Color blue-dark" }));
      fireEvent.click(screen.getByRole("option", { name: "Flair rain" }));
      fireEvent.click(screen.getByRole("option", { name: "Clear color" }));
      expect(onSelect).toHaveBeenCalledTimes(3);
      expect(onSelectFlair).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clicking the ✕ cell closes", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} />);
      fireEvent.click(screen.getByLabelText("Close picker"));
      expect(onClose).toHaveBeenCalledOnce();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  // ── Composite preview row + combo caption. ──
  describe("composite preview", () => {
    const tints = computeRowTints(DEFAULT_DARK_THEME.palette, DARK_CHROME);
    const borders = computeRowBorders(DEFAULT_DARK_THEME.palette, DEFAULT_DARK_THEME.category);

    it("renders the row's resting look: tint, row name, and the combo caption (no marker stripe)", () => {
      renderWithTheme(
        <SwatchPopover
          selectedColor="green"
          selectedFlair="nyan"
          onSelect={vi.fn()}
          onSelectFlair={vi.fn()}
          onClose={vi.fn()}
          rowName="blustery-raven"
        />,
      );
      const preview = previewRow("blustery-raven");
      expect(preview.style.backgroundColor).toBe(rgb(tints.get("green")!.base));
      // The preview renders color and flair without marker visuals.
      expect(preview.querySelector("[style*='border-left']")).toBeNull();
      expect(preview.querySelector(".rk-hazard")).toBeNull();
      // The live flair overlay rides along.
      expect(preview.querySelector(".rk-flair-nyan")).not.toBeNull();
      // The caption names the combo — family name · flair.
      screen.getByText("green · nyan");
    });

    it("unset axes read ∅ in the caption; color-only callers get the color leg only", () => {
      renderWithTheme(
        <SwatchPopover
          onSelect={vi.fn()}
          onSelectFlair={vi.fn()}
          onClose={vi.fn()}
          rowName="w"
        />,
      );
      screen.getByText("∅ · ∅");
      cleanup();
      renderWithTheme(<SwatchPopover selectedColor="teal" onSelect={vi.fn()} onClose={vi.fn()} rowName="s" />);
      screen.getByText("teal");
    });

    it("callers without a row get a neutral sample name", () => {
      renderWithTheme(<SwatchPopover onSelect={vi.fn()} onClose={vi.fn()} />);
      screen.getByText("row-name");
    });

    it("picks on ANY axis repaint the preview immediately (override, no prop echo)", () => {
      const onSelectFlair = vi.fn();
      renderWithTheme(
        <SwatchPopover
          selectedColor="green"
          onSelect={vi.fn()}
          onSelectFlair={onSelectFlair}
          onClose={vi.fn()}
          rowName="w"
        />,
      );
      const preview = previewRow("w");
      expect(preview.style.backgroundColor).toBe(rgb(tints.get("green")!.base));
      // A swatch pick repaints the tint without any parent re-render.
      fireEvent.click(screen.getByRole("option", { name: "Color blue-dark" }));
      expect(preview.style.backgroundColor).toBe(rgb(tints.get("blue-dark")!.base));
      // …and a flair pick mounts its overlay (reused FlairOverlay — cube
      // carries its child-markup contract even in the preview).
      fireEvent.click(screen.getByRole("option", { name: "Flair cube" }));
      expect(onSelectFlair).toHaveBeenCalledWith("cube");
      expect(preview.querySelectorAll(".rk-flair-cube .rk-cube-face")).toHaveLength(6);
      // The caption follows the overrides.
      screen.getByText("blue · cube");
    });

    it("uncolored previews fall back to the gray sentinel tint", () => {
      renderWithTheme(
        <SwatchPopover onSelect={vi.fn()} onSelectFlair={vi.fn()} onClose={vi.fn()} rowName="w" />,
      );
      const preview = previewRow("w");
      expect(preview.style.backgroundColor).toBe(rgb(tints.get(UNCOLORED_SELECTED_KEY)!.base));
    });
  });

  // Banded structure: a color scroll strip and a two-row flair strip, each
  // with a header clear cell.
  describe("banded Label picker", () => {
    const tints = computeRowTints(DEFAULT_DARK_THEME.palette, DARK_CHROME);
    const borders = computeRowBorders(DEFAULT_DARK_THEME.palette, DEFAULT_DARK_THEME.category);

    function renderLabelPicker(extra: Partial<React.ComponentProps<typeof SwatchPopover>> = {}) {
      const onSelect = vi.fn();
      const onSelectFlair = vi.fn();
      const onClose = vi.fn();
      const utils = renderWithTheme(
        <SwatchPopover
          onSelect={onSelect}
          onSelectFlair={onSelectFlair}
          onClose={onClose}
          rowName="w"
          {...extra}
        />,
      );
      return { onSelect, onSelectFlair, onClose, ...utils };
    }

    it("full variant: 33 colors + 16 flairs + 2 header − + panel − + ✕ = 53 options, labelled Label picker", () => {
      renderLabelPicker();
      expect(screen.getAllByRole("option")).toHaveLength(53);
      expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Label picker");
      for (const state of FLAIR_NAMED) {
        expect(screen.getByRole("option", { name: `Flair ${state}` })).toBeTruthy();
      }
      // The header − cells keep the incumbent accessible names.
      expect(screen.getByRole("option", { name: "Clear color" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "Flair none" })).toBeTruthy();
    });

    it("band headers name the axes in the green-bracket idiom", () => {
      renderLabelPicker();
      for (const axis of ["color", "flair"]) {
        expect(screen.getByText(axis, { exact: true })).toBeTruthy();
      }
    });

    it("the color band is a 3-shade-row column-flow strip inside the horizontal scroller + edge fade", () => {
      renderLabelPicker();
      const swatch = screen.getByRole("option", { name: "Color orange" });
      const grid = swatch.parentElement as HTMLElement;
      expect(grid.className).toContain("grid-flow-col");
      expect(grid.className).toContain("grid-rows-[18px_18px_18px]");
      const scroller = grid.parentElement as HTMLElement;
      expect(scroller.className).toContain("rk-band-scroll");
      expect((scroller.parentElement as HTMLElement).className).toContain("rk-band-fade");
      // Family columns, shade rows: a family's three shades fill one column in
      // DOM order (column-flow), light on top — the rows ARE the lightness axis.
      const values = Array.from(grid.querySelectorAll("[data-color-value]")).map((c) =>
        c.getAttribute("data-color-value"),
      );
      expect(values.slice(0, 6)).toEqual(["red-light", "red", "red-dark", "orange-light", "orange", "orange-dark"]);
    });

    it("the flair band lists the 16 states in display order, rain/scan leading, noon last", () => {
      renderLabelPicker();
      const cells = Array.from(
        screen.getByRole("listbox").querySelectorAll("[data-flair-value]"),
      );
      expect(cells.map((c) => c.getAttribute("data-flair-value"))).toEqual([...FLAIR_NAMED]);
    });

    it("a ring on the header − indicates the axis is UNSET", () => {
      renderLabelPicker({ selectedFlair: "rain" });
      // Color unset → its header − is ringed/aria-selected…
      const clearColor = screen.getByRole("option", { name: "Clear color" });
      expect(clearColor.getAttribute("aria-selected")).toBe("true");
      expect(clearColor.className).toContain("ring-text-primary");
      // …while the set axis's header − is not.
      expect(screen.getByRole("option", { name: "Flair none" }).getAttribute("aria-selected")).toBe("false");
    });

    it("header − clears ONLY its own axis", () => {
      const { onSelect, onSelectFlair } = renderLabelPicker();
      fireEvent.click(screen.getByRole("option", { name: "Flair none" }));
      expect(onSelectFlair).toHaveBeenCalledWith("");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("flair cells are live previews carrying their always-on rk-flair-* overlay (rain/scan included)", () => {
      renderLabelPicker();
      for (const state of FLAIR_NAMED) {
        const cell = screen.getByRole("option", { name: `Flair ${state}` });
        expect(cell.querySelector(`.rk-flair-${state}`)).not.toBeNull();
      }
      // cube/warp previews carry their child-span markup via FlairOverlay.
      const cube = screen.getByRole("option", { name: "Flair cube" });
      expect(cube.querySelector(".rk-flair-cube .rk-cube-x .rk-cube-y .rk-cube")).not.toBeNull();
      expect(cube.querySelectorAll(".rk-cube-face")).toHaveLength(6);
      const warp = screen.getByRole("option", { name: "Flair warp" });
      expect(warp.querySelectorAll(".rk-flair-warp .rk-warp-plane")).toHaveLength(3);
      // The tinted flairs read the preview's guarded color.
      const rain = screen.getByRole("option", { name: "Flair rain" });
      expect(
        (rain.querySelector(".rk-flair-rain") as HTMLElement).style.getPropertyValue("--rk-flair-color"),
      ).toBe(borders.get(UNCOLORED_SELECTED_KEY));
    });

    it("clicking a flair cell calls onSelectFlair with the EXACT state (no cycling)", () => {
      const { onSelectFlair } = renderLabelPicker({ selectedFlair: "naruto" });
      fireEvent.click(screen.getByRole("option", { name: "Flair scan" }));
      expect(onSelectFlair).toHaveBeenCalledWith("scan");
      const current = screen.getByRole("option", { name: "Flair naruto" });
      expect(current.getAttribute("aria-selected")).toBe("true");
      expect(current.className).toContain("ring-text-primary");
    });
  });

  // ── Plain-grid keyboard model: every band is a plain grid; the header − is
  //    row 0 of its band; the ✕ is the stack's top row. Vertical moves
  //    preserve the column, clamped to the target row's extent. ──
  describe("panel-level − (clear all)", () => {
    function renderVariant(extra: Partial<React.ComponentProps<typeof SwatchPopover>> = {}) {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(<SwatchPopover onSelect={onSelect} onClose={onClose} {...extra} />);
      return { onSelect, onClose };
    }

    it("emits every offered clear on the full variant, drops the caption to unset, and stays open", () => {
      const onSelectFlair = vi.fn();
      const { onSelect, onClose } = renderVariant({
        selectedColor: "teal",
        selectedFlair: "scan",
        onSelectFlair,
        rowName: "blustery-raven",
      });
      fireEvent.click(screen.getByRole("option", { name: "Clear all" }));
      expect(onSelect).toHaveBeenCalledWith(null);
      expect(onSelectFlair).toHaveBeenCalledWith("");
      // Never dismisses; the preview override repaints the caption immediately.
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText("∅ · ∅")).toBeTruthy();
    });

    it("emits ONLY the offered clears: color-only fires onSelect alone", () => {
      const { onSelect } = renderVariant({ selectedColor: "orange" });
      fireEvent.click(screen.getByRole("option", { name: "Clear all" }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(null);
    });

    it("emits ONLY the offered clears: color+flair (session/server variant) fires onSelect + onSelectFlair", () => {
      const onSelectFlair = vi.fn();
      const { onSelect } = renderVariant({
        selectedColor: "green",
        selectedFlair: "rain",
        onSelectFlair,
      });
      fireEvent.click(screen.getByRole("option", { name: "Clear all" }));
      expect(onSelect).toHaveBeenCalledWith(null);
      expect(onSelectFlair).toHaveBeenCalledWith("");
    });

    it("rings iff EVERY offered axis is unset (props-computed)", () => {
      const onSelectFlair = vi.fn();
      renderVariant({ onSelectFlair });
      const clearAll = screen.getByRole("option", { name: "Clear all" });
      expect(clearAll.getAttribute("aria-selected")).toBe("true");
      expect(clearAll.className).toContain("ring-text-primary");
      cleanup();
      // One set axis breaks the ring — the panel scope is "the whole label".
      renderVariant({ onSelectFlair, selectedFlair: "scan" });
      const clearAll2 = screen.getByRole("option", { name: "Clear all" });
      expect(clearAll2.getAttribute("aria-selected")).toBe("false");
      expect(clearAll2.className).not.toContain("ring-text-primary");
    });

    it("keyboard: the top row is [− ✕] — ArrowUp reaches it, Left/Right walk it, Enter activates", () => {
      const onSelectFlair = vi.fn();
      const { onSelect, onClose } = renderVariant({ onSelectFlair });
      const listbox = screen.getByRole("listbox");
      const arrow = (key: string) => fireEvent.keyDown(listbox, { key });
      const enter = () => fireEvent.keyDown(listbox, { key: "Enter" });
      // Uncolored → initial focus is the color header − (row 1); ArrowUp
      // lands on the top row's first cell — the panel −.
      arrow("ArrowUp");
      enter();
      expect(onSelect).toHaveBeenLastCalledWith(null);
      expect(onSelectFlair).toHaveBeenLastCalledWith("");
      expect(onClose).not.toHaveBeenCalled();
      // ArrowRight walks − → ✕; Enter closes.
      arrow("ArrowRight");
      enter();
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("keyboard navigation (plain-grid bands)", () => {
    function renderFull(extra: Partial<React.ComponentProps<typeof SwatchPopover>> = {}) {
      const onSelect = vi.fn();
      const onSelectFlair = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(
        <SwatchPopover
          onSelect={onSelect}
          onSelectFlair={onSelectFlair}
          onClose={onClose}
          {...extra}
        />,
      );
      const listbox = screen.getByRole("listbox");
      const enter = () => fireEvent.keyDown(listbox, { key: "Enter" });
      const arrow = (key: string, n = 1) => {
        for (let i = 0; i < n; i++) fireEvent.keyDown(listbox, { key });
      };
      return { onSelect, onSelectFlair, onClose, listbox, enter, arrow };
    }

    it("initial focus FOLLOWS SELECTION: the color header − when uncolored — Enter clears, never emits a phantom color", () => {
      const { onSelect, enter } = renderFull();
      enter();
      expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it("shows NO focus ring before the keyboard is used; the ring appears on the first arrow key", () => {
      const { listbox, arrow } = renderFull();
      // At rest (mouse users): no focus ring anywhere — an always-on ring on
      // the autofocused listbox read as a phantom selection.
      expect(listbox.querySelectorAll(".ring-text-secondary")).toHaveLength(0);
      arrow("ArrowDown");
      expect(listbox.querySelectorAll(".ring-text-secondary")).toHaveLength(1);
    });

    it("initial focus lands on the selected swatch (magenta — normal row, family column 9 of 11)", () => {
      const { onSelect, enter } = renderFull({ selectedColor: "magenta" });
      enter();
      expect(onSelect).toHaveBeenLastCalledWith(legacyOf("magenta"));
      expect(PICKER_COLOR_VALUES[28]).toBe("magenta");
    });

    it("ArrowRight walks a color band row across family columns and clamps at its right edge", () => {
      const { onSelect, enter, arrow } = renderFull();
      // Uncolored → initial focus is the color header −; descend into the
      // light shade row (col 0 = red-light), then walk right.
      arrow("ArrowDown");
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("red-light");
      arrow("ArrowRight", 2);
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("amber-light");
      // Clamp: 11 family columns — past col 10 ArrowRight is a no-op.
      arrow("ArrowRight", 20);
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("slate-light");
    });

    it("ArrowDown from the light shade row walks the SAME family's normal, then dark shade", () => {
      const { onSelect, enter, arrow } = renderFull();
      arrow("ArrowDown"); // header − → light row, col 0 (red-light)
      arrow("ArrowRight", 1); // orange-light
      arrow("ArrowDown"); // normal row, same column
      enter();
      expect(onSelect).toHaveBeenLastCalledWith(legacyOf("orange"));
      arrow("ArrowDown"); // dark row, same column
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("orange-dark");
    });

    it("ArrowUp from a strip's first row lands on its band's header − (row 0)", () => {
      const { onSelect, onSelectFlair, enter, arrow } = renderFull();
      // Color: light row → header −.
      arrow("ArrowDown");
      arrow("ArrowUp");
      enter();
      expect(onSelect).toHaveBeenLastCalledWith(null);
      // Flair band: descend past the three color rows onto the flair header −,
      // then flair row 1, and ArrowUp lands back on the flair header −.
      arrow("ArrowDown", 4); // header−(c) → light → normal → dark → flair header −
      arrow("ArrowDown"); // flair row 1
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("rain");
      arrow("ArrowUp");
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("");
    });

    it("vertical moves preserve the column as a goal column, clamped to the target row's extent", () => {
      const { onSelect, onSelectFlair, enter, arrow } = renderFull();
      arrow("ArrowDown"); // light row, col 0
      arrow("ArrowRight", 10); // col 10 (slate-light)
      // Down into the flair band: the raw column rides THROUGH the
      // single-cell header − row at the goal column and clamps to 7, ironman,
      // on the 8-cell flair row 1.
      arrow("ArrowDown", 4);
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("ironman");
      // Back up: flair row 1 → header − → dark shade row, the raw column
      // restored (col 10 = slate-dark).
      arrow("ArrowUp", 2);
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("slate-dark");
    });

    it("ArrowUp from the color header − reaches the top row ([− ✕]); ArrowRight to ✕ and Enter closes", () => {
      const { onClose, onSelect, enter, arrow } = renderFull();
      arrow("ArrowUp"); // color header − → top row col 0 (the panel −)
      arrow("ArrowRight"); // panel − → ✕
      enter();
      expect(onClose).toHaveBeenCalledOnce();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("flair row 1 walks 8 columns and row 2 walks 8 (rain/nyan/… over scan/naruto/…)", () => {
      const { onSelectFlair, enter, arrow } = renderFull();
      // Uncolored → color header −. Down 5 → flair row 1, col 0, rain.
      arrow("ArrowDown", 5);
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("rain");
      // Walk row 1 right: nyan, onepiece, matrix, nemo, invaders, warp,
      // ironman — clamped at the 8th cell.
      for (const state of ["nyan", "onepiece", "matrix", "nemo", "invaders", "warp", "ironman", "ironman"]) {
        arrow("ArrowRight");
        enter();
        expect(onSelectFlair).toHaveBeenLastCalledWith(state);
      }
      // Down to row 2 in the same column: ironman (row 1 col 7) → noon (row 2
      // col 7 — both rows are 8 cells, no clamp).
      arrow("ArrowDown");
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("noon");
      // Row 2 walks left: spidey, cube, roadrunner, aquarium, pacman, naruto, scan — clamped.
      for (const state of ["spidey", "cube", "roadrunner", "aquarium", "pacman", "naruto", "scan", "scan"]) {
        arrow("ArrowLeft");
        enter();
        expect(onSelectFlair).toHaveBeenLastCalledWith(state);
      }
      // Row 2 is the bottom: ArrowDown is a no-op.
      arrow("ArrowDown");
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("scan");
      // Up in the same column returns to rain.
      arrow("ArrowUp");
      enter();
      expect(onSelectFlair).toHaveBeenLastCalledWith("rain");
    });

    it("ArrowLeft at the left edge is a no-op", () => {
      const { onSelect, enter, arrow } = renderFull();
      arrow("ArrowDown"); // light row col 0 (red-light)
      arrow("ArrowLeft");
      enter();
      expect(onSelect).toHaveBeenLastCalledWith("red-light");
    });

    it("Space emits the focused swatch's legacy value", () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      renderWithTheme(
        <SwatchPopover selectedColor="orange" onSelect={onSelect} onClose={onClose} />,
      );
      fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
      expect(onSelect).toHaveBeenCalledWith(legacyOf("orange"));
      expect(legacyOf("orange")).toBe("1+3");
    });
  });
});

// The instance-accent ("Host color") pickers narrow the color band to the
// well-separated hue set: one row of normal shades, nothing else changes.
describe("SwatchPopover hostColorSet", () => {
  beforeEach(() => {
    mockMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers only the nine Host color hues (normal shade), plus the clear cells and ✕", () => {
    renderWithTheme(<SwatchPopover hostColorSet onSelect={vi.fn()} onClose={vi.fn()} />);
    const swatches = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("data-color-value"))
      .filter((v): v is string => v !== null);
    expect(swatches).toEqual(["purple", "violet", "blue", "red", "green", "teal", "magenta", "slate", "amber"]);
    // 9 swatches + color header − + panel − + ✕.
    expect(screen.getAllByRole("option")).toHaveLength(12);
  });

  it("writes the legacy descriptor — violet is 4+5", () => {
    const onSelect = vi.fn();
    renderWithTheme(<SwatchPopover hostColorSet onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("option", { name: "Color violet" }));
    expect(onSelect).toHaveBeenCalledWith("4+5");
  });

  it("highlights the nearest member for an out-of-set stored value", () => {
    renderWithTheme(<SwatchPopover hostColorSet selectedColor="1+3" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Color red" })).toHaveAttribute("aria-selected", "true");
  });

  it("arrow keys walk the single color row", () => {
    const onSelect = vi.fn();
    renderWithTheme(<SwatchPopover hostColorSet onSelect={onSelect} onClose={vi.fn()} />);
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("4+5");
  });
});
