import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { ShellServer } from "@/lib/shell";
import {
  DRAG_THRESHOLD_PX,
  dragTarget,
  shellHostMenuRows,
  slotWhileDragging,
  SQUARE_PITCH_PX,
  squareDigit,
} from "@/lib/shell-strip";
import type { HostMenuFocus } from "./host-menu";

/**
 * The host squares of the desktop-shell titlebar strip: one fixed 18×18 square
 * per shell host, in shell list order (= the ⌥⌘1–9 / Alt+1–9 accelerator
 * order), plus the trailing `+` square. Geometry never changes — the active
 * host is a ring, a waiting background host an amber corner dot, digits sit
 * inside the square's own box — so hover, the key-hint chord and drag only
 * ever move a square by its own transform.
 *
 * Every square is a no-drag island (the rest of the band drags the window).
 * Click switches; right-click / Shift+F10 / ContextMenu opens the host menu at
 * the square; hovering previews the host in the nameplate. With the shell's
 * optional `reorder` invoker a pointer drag (4px threshold, pointer capture)
 * or ⌥←/⌥→ reorders — each gesture reports ONE `onReorder`; without it the
 * squares neither drag nor reorder and click still switches.
 *
 * Keys on a focused square (roving tabindex, seated on the active square):
 * ←/→ and Home/End move focus, Enter/Space switch (native button click),
 * digits 1–9 switch to the Nth host, ⌥←/⌥→ reorder, Escape releases focus.
 */

export interface HostSquaresHandle {
  /** Seat focus on the active square. */
  focusActive: () => void;
  /** Whether keyboard focus is on one of the squares. */
  hasFocus: () => boolean;
}

export interface HostSquaresProps {
  servers: ShellServer[];
  platform: string;
  /** This view's own host color (live — a Settings pick repaints at once),
   *  overriding the projected one for the active square. */
  selfColor: string | null;
  canReorder: boolean;
  onSwitch: (id: string) => void;
  onHover: (id: string | null) => void;
  /** One committed reorder: move host `id` from `from` to `to`. */
  onReorder: (id: string, from: number, to: number) => void;
  onOpenMenu: (focus: HostMenuFocus, anchor: HTMLElement) => void;
  onDraggingChange: (dragging: boolean) => void;
  /** Escape on a square: give focus back to where it was. */
  onRelease: () => void;
}

interface DragState {
  id: string;
  from: number;
  to: number;
  offset: number;
}

export const HostSquares = forwardRef<HostSquaresHandle, HostSquaresProps>(function HostSquares(
  { servers, platform, selfColor, canReorder, onSwitch, onHover, onReorder, onOpenMenu, onDraggingChange, onRelease },
  ref,
) {
  const rows = shellHostMenuRows(servers, platform);
  const containerRef = useRef<HTMLDivElement>(null);
  const [seatId, setSeatId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // The gesture in flight, kept in a ref: pointermove must read the latest
  // values without waiting for a render.
  const gestureRef = useRef<{
    id: string;
    from: number;
    to: number;
    startX: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const activeId = rows.find((r) => r.active)?.id ?? rows[0]?.id ?? null;
  const seat = seatId !== null && rows.some((r) => r.id === seatId) ? seatId : activeId;

  const squareEl = useCallback((id: string): HTMLElement | null => {
    const container = containerRef.current;
    if (!container) return null;
    for (const el of container.querySelectorAll<HTMLElement>("[data-host-id]")) {
      if (el.dataset.hostId === id) return el;
    }
    return null;
  }, []);

  const focusSquare = useCallback(
    (id: string) => {
      setSeatId(id);
      squareEl(id)?.focus();
    },
    [squareEl],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusActive: () => {
        if (activeId !== null) focusSquare(activeId);
      },
      hasFocus: () => {
        const container = containerRef.current;
        return container !== null && container.contains(document.activeElement);
      },
    }),
    [activeId, focusSquare],
  );

  const endGesture = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture?.moved) return;
      suppressClickRef.current = true;
      setDrag(null);
      onDraggingChange(false);
      if (commit && gesture.to !== gesture.from) onReorder(gesture.id, gesture.from, gesture.to);
    },
    [onDraggingChange, onReorder],
  );

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (!canReorder || e.button !== 0) return;
    suppressClickRef.current = false;
    gestureRef.current = { id, from: index, to: index, startX: e.clientX, moved: false };
    // Capture keeps move/up on this square when the pointer leaves it mid-drag
    // (absent in jsdom, where there is no real pointer).
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const dx = e.clientX - gesture.startX;
    if (!gesture.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      gesture.moved = true;
      onDraggingChange(true);
    }
    const { to, offset } = dragTarget(gesture.from, dx, rows.length);
    gesture.to = to;
    setDrag({ id: gesture.id, from: gesture.from, to, offset });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const square = target.closest<HTMLElement>("[data-host-id]");
    const id = square?.dataset.hostId;
    if (!square || id === undefined) return; // the `+` square has no roving keys
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onRelease();
      return;
    }
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      onOpenMenu({ kind: "host", id }, square);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // ⌘/Ctrl-modified arrows are not square navigation — ⌥⌘←/→ is the
      // shell's host-cycling accelerator, which only fires if the page leaves
      // the key unhandled.
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const next = index + delta;
      if (next < 0 || next >= rows.length) return; // no wrap; edges swallow the key
      if (e.altKey) {
        if (canReorder) {
          onReorder(id, index, next);
          // The keyed element moves with the optimistic reorder, and a moved
          // DOM node can drop focus — re-seat it once the new order commits.
          setSeatId(id);
          requestAnimationFrame(() => squareEl(id)?.focus());
        }
        return;
      }
      focusSquare(rows[next].id);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusSquare(rows[e.key === "Home" ? 0 : rows.length - 1].id);
      return;
    }
    if (/^Digit[1-9]$/.test(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const n = Number(e.code.slice(5));
      const row = rows[n - 1];
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      onSwitch(row.id);
    }
  };

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-label="Hosts"
      data-testid="shell-host-squares"
      className="rk-shell-no-drag flex flex-none items-center gap-[7px]"
      onKeyDown={onKeyDown}
      onPointerLeave={() => onHover(null)}
    >
      {rows.map((row, i) => {
        const dragging = drag !== null && drag.id === row.id;
        const slot = drag ? slotWhileDragging(i, drag.from, drag.to) : i;
        const digit = squareDigit(slot);
        const color = row.active ? (selfColor ?? row.accentColor) : row.accentColor;
        const style: CSSProperties = {};
        if (color !== null) style.backgroundColor = color;
        if (drag) {
          style.transform = dragging
            ? `translateX(${drag.offset}px)`
            : slot !== i
              ? `translateX(${(slot - i) * SQUARE_PITCH_PX}px)`
              : undefined;
        }
        const label = row.waiting !== null ? `${row.name}, ${row.waiting} waiting` : row.name;
        return (
          <button
            key={row.id}
            type="button"
            data-testid="shell-host-square"
            data-host-id={row.id}
            aria-label={label}
            aria-current={row.active ? "true" : undefined}
            tabIndex={seat === row.id ? 0 : -1}
            style={style}
            className={[
              "rk-strip-sq",
              color === null ? "rk-strip-sq-uncolored" : "",
              row.active ? "rk-strip-sq-on" : "",
              dragging ? "rk-strip-sq-lifted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={(e) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                e.preventDefault();
                return;
              }
              onSwitch(row.id);
            }}
            onPointerDown={(e) => onPointerDown(e, row.id, i)}
            onPointerMove={onPointerMove}
            onPointerUp={() => endGesture(true)}
            onPointerCancel={() => endGesture(false)}
            onPointerEnter={() => {
              if (gestureRef.current === null) onHover(row.id);
            }}
            onFocus={() => setSeatId(row.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onOpenMenu({ kind: "host", id: row.id }, e.currentTarget);
            }}
            data-host-menu-anchor=""
          >
            {digit !== null && (
              <span aria-hidden="true" className="rk-strip-digit">
                {digit}
              </span>
            )}
            {row.waiting !== null && (
              <i aria-hidden="true" data-testid="shell-host-waiting-dot" className="rk-strip-sq-dot" />
            )}
          </button>
        );
      })}
      <button
        type="button"
        data-testid="shell-host-add"
        aria-label="Host menu"
        aria-haspopup="menu"
        className="rk-strip-sq rk-strip-sq-add"
        onClick={(e) => onOpenMenu({ kind: "add" }, e.currentTarget)}
        data-host-menu-anchor=""
      >
        +
      </button>
    </div>
  );
});
