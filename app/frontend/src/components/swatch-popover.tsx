import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useOccludes } from "@/hooks/use-occludes";
import { Tip, TipGroup } from "@/components/tip";
import { FlairOverlay } from "@/components/flair-overlay";
import {
  PICKER_COLOR_VALUES,
  FLAIR_STATES,
  UNCOLORED_SELECTED_KEY,
  computeRowTints,
  computeRowBorders,
  colorValueToHex,
  deriveUIColors,
  parseColorValue,
  formatColorValue,
  familyToLegacy,
} from "@/themes";

type SwatchPopoverProps = {
  /** Currently-selected color value — a family/shade name ("orange" /
   *  "orange-dark") or a legacy numeric/blend descriptor ("4" / "1+3");
   *  undefined when uncolored. Legacy values are normalized to their family
   *  (normal shade) so the correct swatch highlights. */
  selectedColor?: string;
  /** Called with the value to STORE — the single write seam every
   *  color-picking surface (window/session/server rows + the palette "Set
   *  Color" actions) funnels through. A picked NORMAL-shade family name is
   *  mapped to its legacy numeric/blend descriptor (familyToLegacy) first, so
   *  pre-existing stored values stay in the legacy vocabulary (zero
   *  migration); DARK-shade picks ("orange-dark") have no legacy form and
   *  pass through verbatim — the backend validators accept both
   *  vocabularies. `null` clears the color. */
  onSelect: (color: string | null) => void;
  /** Dismissal model: selection NEVER dismisses — the picker stays open so
   *  color + flair combos can be previewed live against the row. It
   *  closes only via the explicit ✕ cell, a click outside, or Escape; callers
   *  must NOT close in their onSelect/onSelectFlair handlers. */
  onClose: () => void;
  /** The row's real name for the composite preview (a window/session name);
   *  callers without a row get a neutral sample name. */
  rowName?: string;
  /** When `onSelectFlair` is supplied, a `[ flair ]` band renders below the
   *  color band — a 2-row column-flow strip of the 16 named FLAIR_STATES
   *  (rain/scan leading), each cell carrying its always-on rk-flair-* overlay.
   *  Selection calls `onSelectFlair` DIRECTLY — `""` clears (via the header
   *  − clear cell). Offered at all three flair-capable call sites: window
   *  rows, session rows, and the server GROUP HEADER picker (the SERVER tile
   *  itself has no picker affordance). */
  selectedFlair?: string;
  onSelectFlair?: (flair: string) => void;
};

/** Cell geometry: every band cell is an 18px square on a 3px gap on fine
 *  pointers — a documented dense-picker exception to the 24px fine tappable
 *  floor (an 8+ column color grid cannot take the floor and stay a scannable
 *  palette). Coarse pointers get 28px — not the 40px floor, which cannot fit
 *  a 375px viewport with this column count; 28px matches the marker pad's
 *  coarse cell ballpark and a grid mis-tap is cheap and visible. The grid
 *  track literals at each band (grid-rows/auto-cols) mirror these sizes per
 *  pointer class — the pairs MUST change together (Tailwind scans literals
 *  only, so no shared constant). */
const CELL = "w-[18px] h-[18px] coarse:w-[28px] coarse:h-[28px]";

/** Neutral sample name for the composite preview when the caller has no row
 *  (settings/host accent pickers). */
const SAMPLE_ROW_NAME = "row-name";

/** The color band's three shade rows in column-flow order: PICKER_COLOR_VALUES
 *  is family-TRIPLET (red-light, red, red-dark, orange-light, …), so index mod
 *  3 slices the light (band row 1), normal (row 2), and dark (row 3) shades —
 *  family columns, shade rows, the lightness axis descending. */
const COLOR_ROW_LIGHT = PICKER_COLOR_VALUES.filter((_, i) => i % 3 === 0);
const COLOR_ROW_NORMAL = PICKER_COLOR_VALUES.filter((_, i) => i % 3 === 1);
const COLOR_ROW_DARK = PICKER_COLOR_VALUES.filter((_, i) => i % 3 === 2);

/** The flair band's two rows in column-flow order over the 16 named states
 *  (grid-flow-col + two fixed rows fills DOWN each column first): row 1 takes
 *  the even indices, row 2 the odd. */
const FLAIR_NAMED = FLAIR_STATES.slice(1);
const FLAIR_ROW_1 = FLAIR_NAMED.filter((_, i) => i % 2 === 0);
const FLAIR_ROW_2 = FLAIR_NAMED.filter((_, i) => i % 2 === 1);

/** Keyboard focus: a position in the logical row stack (see `grid` in the
 *  component). Every band is a plain grid; a band's header − clear cell is
 *  row 0 of the band (ArrowUp from a strip's first row lands on it); the
 *  stack's top row holds the − clear-all and ✕ close cells. */
type GridPos = { row: number; col: number };

/** Stable DOM id for a logical cell — the ref map the arrow-move
 *  scrollIntoView reads (the scroll strip stays invisible to the grid
 *  model). */
function cellId(kind: string, value?: string): string {
  return value === undefined ? kind : `${kind}:${value}`;
}

/** The green-bracket micro band header — `[ axis ]` + the right-aligned −
 *  clear cell (a ring on the − means the axis is UNSET). The glyph is a VERB —
 *  ✕ closes the panel, − clears the axis — while ∅ stays the caption's STATE
 *  token for unset axes. The header − is row 0 of its band in the keyboard
 *  model. */
function BandHeader({
  axis,
  clearLabel,
  isUnset,
  onClear,
  focused,
  cellRef,
}: {
  axis: string;
  clearLabel: string;
  isUnset: boolean;
  onClear: () => void;
  focused: boolean;
  cellRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span
        aria-hidden="true"
        className="flex-1 text-[9px] tracking-[0.18em] text-text-secondary select-none"
      >
        <span className="text-accent-green/65">[</span> {axis}{" "}
        <span className="text-accent-green/65">]</span>
      </span>
      <Tip label={clearLabel}>
        <button
          ref={cellRef}
          role="option"
          aria-selected={isUnset}
          aria-label={clearLabel}
          onClick={onClear}
          className={`${CELL} overflow-hidden transition-all text-text-secondary hover:text-text-primary bg-bg-inset flex items-center justify-center ${
            focused ? "ring-1 ring-text-secondary" : ""
          } ${isUnset ? "ring-1 ring-text-primary" : ""}`}
        >
          <span style={{ fontSize: 10, lineHeight: 1 }}>&#x2212;</span>
        </button>
      </Tip>
    </div>
  );
}

export function SwatchPopover({
  selectedColor,
  onSelect,
  onClose,
  rowName,
  selectedFlair,
  onSelectFlair,
}: SwatchPopoverProps) {
  const { theme } = useTheme();
  // Mounts only while open, so the registration is unconditional — popovers
  // hold `transient` (overlay-presence) so a native guest composited above
  // the DOM hides and the picker never paints underneath it. (The app-shell
  // modal mount ALSO counts `modal` through its own registration; the count
  // signal tolerates both.)
  useOccludes("transient", true);
  // Rows render on the sidebar chrome, so tints blend into the chrome hex —
  // a terminal-colored base would leave a halo around every tinted band.
  const rowTints = useMemo(
    () => computeRowTints(theme.palette, deriveUIColors(theme.palette, theme.category).bgChrome),
    [theme.palette, theme.category],
  );
  const rowBorders = useMemo(
    () => computeRowBorders(theme.palette, theme.category),
    [theme.palette, theme.category],
  );

  const showFlair = !!onSelectFlair;

  // Normalize the selection to its canonical display value so a legacy-stored
  // value ("1+3") highlights its family swatch and a dark-stored value
  // highlights the DARK swatch (not its normal sibling).
  const parsedSelected = parseColorValue(selectedColor);
  const selectedValue = parsedSelected ? formatColorValue(parsedSelected) : undefined;

  // Preview state for the band cells + composite preview row. A pick updates
  // the local override so the previews repaint immediately regardless of
  // whether (or how fast) the caller echoes the selection back through props —
  // the popover stays open on pick, and the preview must not lag the click.
  // `undefined` = no override; color's `null` = cleared (gray sentinel).
  const [previewOverride, setPreviewOverride] = useState<string | null | undefined>(undefined);
  const [flairOverride, setFlairOverride] = useState<string | undefined>(undefined);
  const previewValue = previewOverride === undefined ? selectedValue : previewOverride ?? undefined;
  const previewFlair = flairOverride ?? selectedFlair ?? "";
  const previewTint =
    (previewValue != null ? rowTints.get(previewValue) : undefined) ??
    rowTints.get(UNCOLORED_SELECTED_KEY);
  const previewFlairColor =
    (previewValue != null ? rowBorders.get(previewValue) : undefined) ??
    rowBorders.get(UNCOLORED_SELECTED_KEY) ??
    theme.palette.foreground;

  // The write seam: legacy mapping per the onSelect prop doc, plus the
  // immediate preview repaint (local override above).
  const emit = useCallback(
    (value: string | null) => {
      setPreviewOverride(value);
      onSelect(familyToLegacy(value));
    },
    [onSelect],
  );

  const currentFlair = selectedFlair ?? "";

  // Panel-level clear-all: the header row names the WHOLE label, so its −
  // clears every axis the caller offers (the scope grammar — a − clears
  // whatever its row names). Emits only the existing clears (no new API);
  // overrides make the preview + caption drop to unset immediately.
  const clearAll = useCallback(() => {
    emit(null);
    if (onSelectFlair) {
      setFlairOverride("");
      onSelectFlair("");
    }
  }, [emit, onSelectFlair]);

  // Ring rule at the panel scope: unset iff EVERY offered axis is unset —
  // props-computed like the band headers' isUnset, so after a clear-all the
  // caller echo rings the panel − and every offered band − together.
  const allUnset =
    selectedValue == null &&
    (!showFlair || currentFlair === "");

  /** The logical row stack the keyboard walks: [− ✕] · [color −] · color shade
   *  rows (light, normal, dark) · ([flair −] · flair rows). Each entry is a
   *  row of cell ids; vertical moves preserve the
   *  column as a GOAL COLUMN (carried raw through the single-cell header rows,
   *  clamped to the target row's extent only for display/activation);
   *  horizontal moves operate on the clamped column. */
  const grid = useMemo<string[][]>(() => {
    const rows: string[][] = [
      [cellId("clear-all"), cellId("close")],
      [cellId("clear-color")],
      COLOR_ROW_LIGHT.map((v) => cellId("color", v)),
      COLOR_ROW_NORMAL.map((v) => cellId("color", v)),
      COLOR_ROW_DARK.map((v) => cellId("color", v)),
    ];
    if (showFlair) {
      rows.push(
        [cellId("clear-flair")],
        FLAIR_ROW_1.map((s) => cellId("flair", s)),
        FLAIR_ROW_2.map((s) => cellId("flair", s)),
      );
    }
    return rows;
  }, [showFlair]);

  // Initial focus FOLLOWS SELECTION: the selected swatch, or the color band's
  // header − clear cell when uncolored — never an arbitrary swatch, whose focus ring
  // would read as a phantom selection.
  const [focus, setFocus] = useState<GridPos>(() => {
    const light = COLOR_ROW_LIGHT.indexOf(selectedValue ?? "");
    if (light >= 0) return { row: 2, col: light };
    const normal = COLOR_ROW_NORMAL.indexOf(selectedValue ?? "");
    if (normal >= 0) return { row: 3, col: normal };
    const dark = COLOR_ROW_DARK.indexOf(selectedValue ?? "");
    if (dark >= 0) return { row: 4, col: dark };
    return { row: 1, col: 0 };
  });
  // The focus ring renders only after the first arrow key: the listbox
  // autofocuses on mount, so an always-on ring would show mouse users a
  // phantom highlight.
  const [keyboardActive, setKeyboardActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLElement>());

  // Goal-column resolution: the raw column may exceed a row's extent (it is
  // carried through the single-cell header rows); the EFFECTIVE cell clamps.
  const effectiveId = useCallback(
    (pos: GridPos): string | undefined => {
      const row = grid[pos.row];
      return row?.[Math.min(pos.col, row.length - 1)];
    },
    [grid],
  );
  const focusedId = effectiveId(focus);

  // Arrow moves scroll the focused cell into view — the color band's
  // horizontal strip stays invisible to the grid model.
  useEffect(() => {
    if (!keyboardActive || !focusedId) return;
    const el = cellRefs.current.get(focusedId);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [keyboardActive, focusedId]);

  // On open, scroll the selected swatch into view inside the strip (a
  // selected family past the right edge must be visible without a swipe).
  useEffect(() => {
    if (selectedValue == null) return;
    const el = cellRefs.current.get(cellId("color", selectedValue));
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // Mount-only: scrolls the OPENING selection, not every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCellRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) cellRefs.current.set(id, el);
      else cellRefs.current.delete(id);
    },
    [],
  );

  // Activate the focused cell (Enter/Space).
  const activate = useCallback(
    (pos: GridPos) => {
      const id = effectiveId(pos);
      if (id === undefined) return;
      if (id === cellId("close")) onClose();
      else if (id === cellId("clear-all")) clearAll();
      else if (id === cellId("clear-color")) emit(null);
      else if (id === cellId("clear-flair")) onSelectFlair?.("");
      else if (id.startsWith("color:")) emit(id.slice("color:".length));
      else if (id.startsWith("flair:")) {
        const state = id.slice("flair:".length);
        setFlairOverride(state);
        onSelectFlair?.(state);
      }
    },
    [effectiveId, emit, clearAll, onClose, onSelectFlair],
  );

  // Mouse picks repaint the preview overrides immediately (same immediacy the
  // keyboard path gets through activate).
  const pickFlair = useCallback(
    (state: string) => {
      setFlairOverride(state);
      onSelectFlair?.(state);
    },
    [onSelectFlair],
  );

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Autofocus the listbox on mount — the `Tab: Label` palette action is
  // the only keyboard path to the bands, and arrow keys are dead until the
  // listbox has focus.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Use setTimeout to avoid immediately closing from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Arrow-key movement over the logical row stack: Left/Right operate on the
  // CLAMPED column of the current row (resetting the goal column to the row's
  // extent); Up/Down carry the raw goal column through single-cell header
  // rows, clamping only for display/activation.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key.startsWith("Arrow")) setKeyboardActive(true);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setFocus((f) => {
          const max = grid[f.row].length - 1;
          return { row: f.row, col: Math.min(Math.min(f.col, max) + 1, max) };
        });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setFocus((f) => {
          const max = grid[f.row].length - 1;
          return { row: f.row, col: Math.max(Math.min(f.col, max) - 1, 0) };
        });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocus((f) => (f.row >= grid.length - 1 ? f : { row: f.row + 1, col: f.col }));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((f) => (f.row === 0 ? f : { row: f.row - 1, col: f.col }));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate(focus);
      }
    },
    [focus, activate, grid],
  );

  const isFocused = (id: string) => keyboardActive && focusedId === id;

  // The combo caption: family name (shade legible from the preview itself) ·
  // flair name, ∅ for unset axes — legs only for the axes this variant shows.
  const captionLegs = [
    parseColorValue(previewValue)?.family.name ?? "∅",
    ...(showFlair ? [previewFlair || "∅"] : []),
  ];

  return (
    // TipGroup: the band cells are a warm-tip cluster — sweeping across the
    // tiny 18px cells names each state instantly.
    <TipGroup>
    <div
      ref={containerRef}
      role="listbox"
      aria-label={showFlair ? "Label picker" : "Color picker"}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="bg-bg-primary border border-border p-1.5 z-50 w-[190px]"
      style={{ boxShadow: "3px 3px 0 rgba(0,0,0,.35)" }}
    >
      {/* Composite preview row: the row's actual RESTING look — tint base +
          the live flair overlay (reused FlairOverlay — the cube/warp
          child-markup contract) + the row name. The − clear-all and ✕ close
          cells sit beside it — this row names the WHOLE label, so its −
          clears every offered axis (the band −s clear one each). */}
      <div className="flex items-center gap-1.5">
        <div
          aria-hidden="true"
          className="relative h-[24px] flex-1 min-w-0 overflow-hidden flex items-center pl-[30px] pr-2"
          style={{ backgroundColor: previewTint?.base }}
        >
          <FlairOverlay flair={previewFlair || undefined} color={previewFlairColor} />
          <span className="relative z-10 truncate text-xs text-text-primary">
            {rowName ?? SAMPLE_ROW_NAME}
          </span>
        </div>
        {/* − — the panel-level clear. Rings when the label is fully unset
            (every offered axis), mirroring the band −s' ring-at-their-scope
            rule. */}
        <Tip label="Clear all">
          <button
            ref={setCellRef(cellId("clear-all"))}
            role="option"
            aria-selected={allUnset}
            aria-label="Clear all"
            onClick={clearAll}
            className={`${CELL} shrink-0 overflow-hidden transition-all text-text-secondary hover:text-text-primary bg-bg-inset flex items-center justify-center ${
              isFocused(cellId("clear-all")) ? "ring-1 ring-text-secondary" : ""
            } ${allUnset ? "ring-1 ring-text-primary" : ""}`}
          >
            <span style={{ fontSize: 10, lineHeight: 1 }}>&#x2212;</span>
          </button>
        </Tip>
        {/* ✕ — the explicit dismiss. role=option (never aria-selected) so the
            listbox holds only ARIA-valid children. */}
        <button
          ref={setCellRef(cellId("close"))}
          role="option"
          aria-selected={false}
          aria-label="Close picker"
          onClick={onClose}
          className={`${CELL} shrink-0 text-[10px] text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center ${
            isFocused(cellId("close")) ? "ring-1 ring-text-secondary" : ""
          }`}
        >
          &#x2715;
        </button>
      </div>
      {/* Combo caption under the preview. */}
      <div
        aria-hidden="true"
        className="text-right text-[9px] tracking-[0.08em] text-text-secondary select-none mb-0.5"
      >
        {captionLegs.join(" · ")}
      </div>

      {/* ── [ color ] band — 3 shade rows (light/normal/dark — the rows ARE
             the lightness axis) × family columns, column-flow,
             horizontal-scroll strip: families grow horizontally BY
             CONSTRUCTION (a vertical scroll would break the shade pairing /
             family-column identity). ~8 of 10 families visible at 190px; the
             cut-off partial column + right-edge fade carry the affordance. ── */}
      <BandHeader
        axis="color"
        clearLabel="Clear color"
        isUnset={selectedValue == null}
        onClear={() => emit(null)}
        focused={isFocused(cellId("clear-color"))}
        cellRef={setCellRef(cellId("clear-color"))}
      />
      <div className="rk-band-fade">
        <div className="rk-band-scroll">
          <div className="grid grid-flow-col grid-rows-[18px_18px_18px] coarse:grid-rows-[28px_28px_28px] auto-cols-[18px] coarse:auto-cols-[28px] gap-[3px] w-max">
            {PICKER_COLOR_VALUES.map((value) => {
              const tint = rowTints.get(value);
              const fallback = colorValueToHex(value, theme.palette) ?? theme.palette.foreground;
              // One solid fill (the value's selected-tint blend); the ring + ✓
              // keep the picked swatch unambiguous between adjacent same-family
              // shades.
              const fill = tint?.selected ?? fallback;
              const isSelected = selectedValue === value;
              const id = cellId("color", value);
              return (
                <button
                  key={value}
                  ref={setCellRef(id)}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`Color ${value}`}
                  data-color-value={value}
                  onClick={() => emit(value)}
                  className={`${CELL} overflow-hidden transition-all flex items-center justify-center ${
                    isFocused(id) ? "ring-1 ring-text-secondary" : ""
                  } ${isSelected ? "ring-1 ring-text-primary" : ""}`}
                  style={{ backgroundColor: fill }}
                >
                  {isSelected && (
                    <span style={{ color: theme.palette.foreground, fontWeight: 700, fontSize: 7, lineHeight: 1 }}>
                      &#x2713;
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── [ flair ] band — 2-row column-flow strip of the 16 named states
             (rain/scan leading); motion IS the flair identity, so the cells
             stay live. The − clear cell lives in the band header. ── */}
      {showFlair && (
        <>
          <BandHeader
            axis="flair"
            clearLabel="Flair none"
            isUnset={currentFlair === ""}
            onClear={() => pickFlair("")}
            focused={isFocused(cellId("clear-flair"))}
            cellRef={setCellRef(cellId("clear-flair"))}
          />
          {/* Coarse-only scroll containment: at 28px cells the 7-column strip
              (~214px) outgrows the popover's fixed 190px box; the wrapper is
              layout-neutral on fine pointers. */}
          <div className="mt-1 coarse:overflow-x-auto">
          <div className="grid grid-flow-col grid-rows-[18px_18px] coarse:grid-rows-[28px_28px] auto-cols-[18px] coarse:auto-cols-[28px] gap-[3px] w-max">
            {FLAIR_NAMED.map((state) => {
              const isSelected = currentFlair === state;
              const id = cellId("flair", state);
              return (
                <Tip key={state} label={state}>
                <button
                  ref={setCellRef(id)}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`Flair ${state}`}
                  data-flair-value={state}
                  onClick={() => pickFlair(state)}
                  className={`${CELL} overflow-hidden transition-all relative ${
                    isFocused(id) ? "ring-1 ring-text-secondary" : ""
                  } ${isSelected ? "ring-1 ring-text-primary" : ""}`}
                  style={{ backgroundColor: previewTint?.base }}
                >
                  <FlairOverlay flair={state} color={previewFlairColor} />
                </button>
                </Tip>
              );
            })}
          </div>
          </div>
        </>
      )}
    </div>
    </TipGroup>
  );
}
