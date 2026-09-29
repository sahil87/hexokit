/**
 * The gui header fold's anchored menus (spec gui.md § The tile): the
 * resolution chip and the ⚙ overflow toggle both open this — one test id,
 * `data-menu` naming which. The rows ARE palette rows selected by id (the
 * caller builds them); this component is presentational only. A row may also
 * be a SEPARATOR (the fold panel's group seams) — an aria-hidden hairline
 * with no `menuitem` row.
 *
 * Rendering contract: `absolute` INSIDE the anchor's positioned ancestor,
 * anchored under the chip with a MENU_GAP_PX gap and horizontally clamped to
 * that ancestor's span. `role="menu"` with `Control variant="menu-row"`
 * rows; the palette's idioms hold: a description renders as
 * `label — description`, EXCEPT the `current` marker, which renders as the
 * trailing ✓ (MENU_ROW_CHECK_MARK) like every other menu; disabled rows are
 * dimmed and inert.
 *
 * Keyboard: focus lands on the first enabled row on open; ↑/↓ rove with
 * wraparound; Enter/Space select via the focused button's native click;
 * Escape and Tab close and return focus to the anchor chip. The menu's own
 * onKeyDown stops propagation so no key leaks to the canvas's chord gate.
 * A pick fires the row's onSelect and closes; a document-level capture
 * pointerdown outside BOTH the menu and its anchor chip closes.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { Control } from "./control";
import { MENU_ROW_CHECK_MARK, POPOVER_SHELL } from "./controls";
import { useOccludes } from "@/hooks/use-occludes";

/** Vertical gap between the anchor chip's bottom edge and the menu's top
 *  (the BreadcrumbDropdown/TopBarOverflowMenu idiom). */
const MENU_GAP_PX = 4;

export type GuiToolbarMenuRow =
  | {
      /** The palette row id (`gui-res-1280x720`, `gui-open-terminal`, …). */
      id: string;
      /** The palette label with its `GUI: ` (and arrow) prefix stripped. */
      label: string;
      /** The palette description verbatim (`current`, `locked`, …). */
      description?: string;
      disabled?: boolean;
      /** THE palette row's onSelect — never a new closure with logic. */
      onSelect: () => void;
      separator?: false;
    }
  | {
      /** A group seam inside the fold panel — no row, no role. */
      id: string;
      separator: true;
    };

interface GuiToolbarMenuProps {
  /** The `data-menu` value — one test id, two menus. */
  kind: "resolution" | "overflow";
  /** The chip; the menu renders under it and Escape/Tab refocuses it. */
  anchorRef: RefObject<HTMLElement | null>;
  rows: GuiToolbarMenuRow[];
  ariaLabel: string;
  /** Focus the first enabled row on open (default true). The ⚙ panel's
   *  PERSISTED open state mounts the menu with the page — that mount passes
   *  false so a reload never steals focus into a popover. */
  autoFocus?: boolean;
  /** Pick, Escape, Tab, outside pointerdown. */
  onClose: () => void;
}

export function GuiToolbarMenu({ kind, anchorRef, rows, ariaLabel, autoFocus = true, onClose }: GuiToolbarMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Mounts only while open, so the registration is unconditional — menus hold
  // `transient` (overlay-presence) so a native guest composited above the DOM
  // hides and the menu never paints underneath it.
  useOccludes("transient", true);

  // Anchor under the chip, clamped horizontally to the positioned ancestor's
  // span (the header cluster). Measure before paint so the menu never flashes at 0,0.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const parentRect = menu.offsetParent?.getBoundingClientRect();
    if (!parentRect) return;
    const a = anchor.getBoundingClientRect();
    const top = a.bottom - parentRect.top + MENU_GAP_PX;
    const maxLeft = Math.max(0, parentRect.width - menu.getBoundingClientRect().width);
    const left = Math.min(Math.max(a.left - parentRect.left, 0), maxLeft);
    setPos({ top, left });
  }, [anchorRef]);

  // Focus the first enabled row on open (unless the caller opted out — a
  // persisted-open panel mounting with the page must not steal focus).
  useEffect(() => {
    if (!autoFocus) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside pointerdown closes (capture phase, while open) — a tap on the
  // canvas is both a close and an ordinary tile tap.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [anchorRef, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // No key leaks past the menu (the wrapper's chord reclaim, noVNC).
    e.stopPropagation();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const active = document.activeElement;
    const index = active ? items.findIndex((el) => el === active) : -1;
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (e.key === "ArrowUp" && items.length > 0) {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
      anchorRef.current?.focus();
    }
  };

  return (
    <div
      ref={menuRef}
      data-testid="gui-toolbar-menu"
      data-menu={kind}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{ top: pos.top, left: pos.left }}
      className={`absolute ${POPOVER_SHELL} min-w-[160px] max-w-[280px] max-h-[60vh] overflow-y-auto font-mono`}
    >
      {rows.map((row) =>
        row.separator === true ? (
          <div key={row.id} aria-hidden="true" className="mx-2 my-1 h-px bg-border" />
        ) : (
        <Control
          key={row.id}
          variant="menu-row"
          role="menuitem"
          disabled={row.disabled}
          onClick={() => {
            row.onSelect();
            onClose();
          }}
        >
          <span className="flex-1">
            {row.description !== undefined && row.description !== "current"
              ? `${row.label} — ${row.description}`
              : row.label}
          </span>
          {row.description === "current" ? (
            <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>
              ✓
            </span>
          ) : null}
        </Control>
        ),
      )}
    </div>
  );
}
