import { useEffect, useRef, useState } from "react";
import { useOccludes } from "@/hooks/use-occludes";
import {
  MARKER_INK,
  MARKER_MODES,
  MARKER_STAGES,
  MARKER_STAGE_GLOSS,
  MARKER_STAGE_WIDTHS,
  MARKER_WELL_BACKGROUND,
  MARKER_WELL_EDGE,
  markerFillStyle,
  MarkerChevrons,
  type Marker,
} from "@/marker";

/** Select a grid cell from pointer displacement, clamping at every edge. */
export function selectCell(
  current: Marker | null,
  dx: number,
  dy: number,
  pitch: number,
): Marker | null {
  const cols = Math.round(dx / pitch);
  const rows = Math.round(dy / pitch);
  let stageIndex = (current ? current.stage : 0) + cols;
  if (stageIndex < 1) {
    if (current === null && rows !== 0) stageIndex = 1;
    else return null;
  }
  const clampedStage = MARKER_STAGES[Math.min(stageIndex, MARKER_STAGES.length) - 1];
  const modeIndex = current
    ? MARKER_MODES.indexOf(current.mode) + rows
    : Math.max(rows - 1, 0);
  const clampedMode =
    MARKER_MODES[Math.min(Math.max(modeIndex, 0), MARKER_MODES.length - 1)];
  return { mode: clampedMode, stage: clampedStage };
}

/** Step only the ordinal marker axis, clamped to its closed vocabulary. */
export function stepStage(marker: Marker, direction: 1 | -1): Marker {
  const next =
    MARKER_STAGES[
      Math.min(Math.max(marker.stage + direction, 1), MARKER_STAGES.length) - 1
    ];
  return { ...marker, stage: next };
}

/** Compare marker grid positions, including the clear column. */
export function sameCell(a: Marker | null, b: Marker | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mode === b.mode && a.stage === b.stage;
}

const GAP_PX = 3;
export const MARKER_PAD_POPOVER_CELL_PX = 26;
export const MARKER_PAD_POPOVER_INSET_PX = 8;
export const MARKER_PAD_POPOVER_PREFERRED_WIDTH_PX = 180;
export const MARKER_PAD_POPOVER_MIN_CELL_PX = 22;
export const MARKER_PAD_LABEL_PREFERRED_WIDTH_PX = 54;

// The non-track width is 2px border + 8px p-1 + four 3px inter-track gaps.
const MARKER_PAD_POPOVER_NON_TRACK_PX = 22;

export type MarkerPadPopoverLayout = {
  width: number;
  cellPx: number;
  labelPx: number;
};

/** Fit the pad while preserving the stage cells' minimum touchable pitch. */
export function markerPadPopoverLayout(sidebarWidth: number): MarkerPadPopoverLayout {
  const resolvedSidebarWidth =
    Number.isFinite(sidebarWidth) && sidebarWidth > 0
      ? sidebarWidth
      : MARKER_PAD_POPOVER_PREFERRED_WIDTH_PX + MARKER_PAD_POPOVER_INSET_PX;
  const width = Math.min(
    MARKER_PAD_POPOVER_PREFERRED_WIDTH_PX,
    Math.max(0, resolvedSidebarWidth - MARKER_PAD_POPOVER_INSET_PX),
  );
  const preferredCellPx =
    (width - MARKER_PAD_POPOVER_NON_TRACK_PX - MARKER_PAD_LABEL_PREFERRED_WIDTH_PX) /
    4;
  const cellPx = Math.min(
    MARKER_PAD_POPOVER_CELL_PX,
    Math.max(MARKER_PAD_POPOVER_MIN_CELL_PX, preferredCellPx),
  );
  const labelPx = Math.max(
    0,
    width - MARKER_PAD_POPOVER_NON_TRACK_PX - cellPx * 4,
  );
  return { width, cellPx, labelPx };
}

type MarkerPadRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Return row-relative coordinates for a pad clamped inside its sidebar. */
export function placeMarkerPad(
  sidebar: MarkerPadRect,
  row: MarkerPadRect,
  pad: { width: number; height: number },
  anchorLeft: number,
): { left: number; top: number } {
  const sidebarRight = sidebar.left + sidebar.width;
  const sidebarBottom = sidebar.top + sidebar.height;
  const idealTop = row.top + (row.height - pad.height) / 2;
  const clampedTop = Math.min(
    Math.max(idealTop, sidebar.top),
    Math.max(sidebarBottom - pad.height, sidebar.top),
  );
  const minLeft = sidebar.left - row.left;
  const maxLeft = Math.max(sidebarRight - row.left - pad.width, minLeft);
  const clampedLeft = Math.min(Math.max(anchorLeft, minLeft), maxLeft);
  return { left: clampedLeft, top: clampedTop - row.top };
}

/** The active pad's closer enforces one open pad across independently rendered rows. */
let activeMarkerPad: { close: () => void } | null = null;

export function openMarkerPad(handle: { close: () => void }): void {
  if (activeMarkerPad && activeMarkerPad !== handle) activeMarkerPad.close();
  activeMarkerPad = handle;
}

export function closeMarkerPad(handle: { close: () => void }): void {
  if (activeMarkerPad === handle) activeMarkerPad = null;
}

/** Reset module state between independently mounted test cases. */
export function resetMarkerPadRegistry(): void {
  activeMarkerPad = null;
}

type MarkerPadProps = {
  value: Marker | null;
  onPreview: (marker: Marker | null) => void;
  onCommit: (marker: Marker | null) => void;
  onCancel: () => void;
  cellPx: number;
  popoverWidth?: number;
  labelPx?: number;
  highlight?: Marker | null;
};

function PadCell({
  marker,
  cellPx,
  highlighted,
  onHover,
  onPick,
  cellRef,
}: {
  marker: Marker;
  cellPx: number;
  highlighted: boolean;
  onHover: () => void;
  onPick: () => void;
  cellRef: (element: HTMLButtonElement | null) => void;
}) {
  const fill = markerFillStyle(marker);
  return (
    <button
      ref={cellRef}
      type="button"
      role="option"
      aria-selected={highlighted}
      aria-label={`Marker ${marker.mode}:${marker.stage}`}
      data-testid={`marker-pad-cell-${marker.mode}-${marker.stage}`}
      onMouseEnter={onHover}
      onClick={(event) => {
        event.stopPropagation();
        onPick();
      }}
      className={`relative shrink-0 overflow-hidden cursor-pointer ${
        highlighted ? "ring-1 ring-text-primary" : ""
      }`}
      style={{
        width: cellPx,
        height: cellPx,
        background: MARKER_WELL_BACKGROUND,
        borderRight: MARKER_WELL_EDGE,
      }}
    >
      {fill && <span aria-hidden className="absolute inset-y-0 left-0" style={fill} />}
      {marker.mode === "auto" && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 flex items-center"
          style={{ width: MARKER_STAGE_WIDTHS[3] }}
        >
          <MarkerChevrons count={marker.stage} />
        </span>
      )}
    </button>
  );
}

export function MarkerPad({
  value,
  onPreview,
  onCommit,
  onCancel,
  cellPx,
  popoverWidth,
  labelPx = MARKER_PAD_LABEL_PREFERRED_WIDTH_PX,
  highlight,
}: MarkerPadProps) {
  // Mounts only while open, so the registration is unconditional — popovers
  // hold `transient` (overlay-presence) so a native guest composited above
  // the DOM hides and the pad never paints underneath it.
  useOccludes("transient", true);

  const [cell, setCell] = useState<Marker | null>(
    highlight === undefined ? value : highlight,
  );
  useEffect(() => {
    if (highlight !== undefined) setCell(highlight);
  }, [highlight]);

  const pick = (next: Marker | null) => {
    setCell(next);
    onPreview(next);
  };
  const commit = (next: Marker | null) => {
    pick(next);
    onCommit(next);
  };

  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const keyFor = (marker: Marker | null): string =>
    marker === null ? "clear" : `${marker.mode}:${marker.stage}`;

  useEffect(() => {
    cellRefs.current.get(keyFor(value))?.focus();
    // Focus is intentionally tied to the opening cell only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveCell = (next: Marker | null) => {
    pick(next);
    cellRefs.current.get(keyFor(next))?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const modeIndex = cell ? MARKER_MODES.indexOf(cell.mode) : 0;
    const stage = cell ? cell.stage : 1;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      if (cell === null) moveCell({ mode: MARKER_MODES[modeIndex], stage: 1 });
      else if (stage < 3) moveCell(stepStage(cell, 1));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (cell !== null) {
        if (stage <= 1) moveCell(null);
        else moveCell(stepStage(cell, -1));
      }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(
        Math.max(modeIndex + delta, 0),
        MARKER_MODES.length - 1,
      );
      if (next !== modeIndex) {
        moveCell({ mode: MARKER_MODES[next], stage: cell ? stage : 1 });
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onCommit(cell);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      pick(value);
      onCancel();
    }
  };

  return (
    <div
      role="listbox"
      aria-label="Marker pad"
      data-testid="marker-pad"
      onKeyDown={handleKeyDown}
      className="rk-popup-elev bg-bg-card border border-border z-50 p-1"
      style={popoverWidth === undefined ? undefined : { width: popoverWidth }}
    >
      <div className="flex pb-1 text-[9px] text-text-secondary select-none" style={{ gap: GAP_PX }}>
        <span
          className="min-w-0 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ width: labelPx }}
        >
          Marker
        </span>
        <span
          aria-label="Clear marker"
          data-testid="marker-pad-stage-heading-clear"
          className="shrink-0 text-center"
          style={{ width: cellPx, color: cell === null ? MARKER_INK : undefined }}
        >
          ∅
        </span>
        {MARKER_STAGES.map((stage) => (
          <span
            key={stage}
            aria-label={`Stage ${stage}: ${MARKER_STAGE_GLOSS[stage]}`}
            title={MARKER_STAGE_GLOSS[stage]}
            data-testid={`marker-pad-stage-heading-${stage}`}
            className="shrink-0 text-center"
            style={{
              width: cellPx,
              color: cell?.stage === stage ? MARKER_INK : undefined,
            }}
          >
            {stage}
          </span>
        ))}
      </div>
      <div className="flex" style={{ gap: GAP_PX }}>
        <span
          aria-hidden
          className="min-w-0 overflow-hidden text-[9px] text-text-secondary select-none flex flex-col justify-around shrink-0"
          style={{ width: labelPx }}
        >
          {MARKER_MODES.map((mode) => (
            <span
              key={mode}
              data-testid={`marker-pad-mode-label-${mode}`}
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{
                height: cellPx,
                lineHeight: `${cellPx}px`,
                color: cell?.mode === mode ? MARKER_INK : undefined,
              }}
            >
              {mode}
            </span>
          ))}
        </span>
        <button
          ref={(element) => {
            if (element) cellRefs.current.set("clear", element);
          }}
          type="button"
          role="option"
          aria-selected={cell === null}
          aria-label="Marker clear"
          data-testid="marker-pad-cell-clear"
          onMouseEnter={() => pick(null)}
          onClick={(event) => {
            event.stopPropagation();
            commit(null);
          }}
          className={`relative shrink-0 cursor-pointer ${
            cell === null ? "ring-1 ring-text-primary" : ""
          }`}
          style={{
            width: cellPx,
            height: cellPx * MARKER_MODES.length + GAP_PX * (MARKER_MODES.length - 1),
            background: MARKER_WELL_BACKGROUND,
            borderRight: MARKER_WELL_EDGE,
          }}
        >
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center text-text-secondary"
          >
            ∅
          </span>
        </button>
        <div className="flex shrink-0 flex-col" style={{ gap: GAP_PX }}>
          {MARKER_MODES.map((mode) => (
            <div key={mode} className="flex" style={{ gap: GAP_PX }}>
              {MARKER_STAGES.map((stage) => {
                const marker = { mode, stage };
                return (
                  <PadCell
                    key={stage}
                    marker={marker}
                    cellPx={cellPx}
                    highlighted={sameCell(cell, marker)}
                    onHover={() => pick(marker)}
                    onPick={() => commit(marker)}
                    cellRef={(element) => {
                      if (element) cellRefs.current.set(keyFor(marker), element);
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
