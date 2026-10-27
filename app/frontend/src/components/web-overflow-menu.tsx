/**
 * The web tile URL row's ⋯ overflow menu — `role="menu"` with the
 * GuiToolbarMenu keyboard idioms: focus lands on the first enabled row on
 * open, ↑/↓ rove with wraparound, Enter/Space activate via the focused
 * button's native click, Escape/Tab close and return focus to the anchor,
 * and a capture-phase pointerdown outside both menu and anchor closes. The
 * menu's own onKeyDown stops propagation so no key leaks to the wrapper's
 * chord reclaim.
 *
 * Rows: the Zoom stepper (`− NNN% +`, keeps the menu open while stepping —
 * the step buttons are the menuitems) and `Inspect page` (engines reporting
 * `supports.devtools` only); on mobile the menu additionally carries Back,
 * Forward, Find in page, and Open in browser (those buttons leave the mobile
 * URL row). Mounts only while open, so the `transient` overlay-presence
 * registration is unconditional — on the native engine the guest hides while
 * the menu is open rather than the menu painting underneath it.
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
import { POPOVER_SHELL } from "./controls";
import { useOccludes } from "@/hooks/use-occludes";
import type { WebFrameCapabilities } from "@/lib/web-frame-engine";
import type { WebZoomDirection } from "@/lib/web-zoom";

/** Vertical gap between the anchor's bottom edge and the menu's top (the
 *  GuiToolbarMenu idiom). */
const MENU_GAP_PX = 4;

interface WebOverflowMenuProps {
  /** The ⋯ button; the menu renders under it and Escape/Tab refocuses it. */
  anchorRef: RefObject<HTMLElement | null>;
  /** The active frame's reported capabilities — Back/Forward rows ride
   *  `history`, the Inspect row rides `devtools`. */
  supports: WebFrameCapabilities;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Mobile menus additionally carry the navigation/find/open rows. */
  mobile: boolean;
  zoom: number;
  onZoom: (direction: WebZoomDirection) => void;
  onBack: () => void;
  onForward: () => void;
  onFind: () => void;
  onOpenExternal: () => void;
  onInspect: () => void;
  onClose: () => void;
}

export function WebOverflowMenu({
  anchorRef,
  supports,
  canGoBack,
  canGoForward,
  mobile,
  zoom,
  onZoom,
  onBack,
  onForward,
  onFind,
  onOpenExternal,
  onInspect,
  onClose,
}: WebOverflowMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Mounts only while open, so the registration is unconditional.
  useOccludes("transient", true);

  // Anchor under the ⋯ button, right-aligned and clamped horizontally to the
  // positioned ancestor (the URL row). Measure before paint so the menu never
  // flashes at 0,0.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const parentRect = menu.offsetParent?.getBoundingClientRect();
    if (!parentRect) return;
    const a = anchor.getBoundingClientRect();
    const top = a.bottom - parentRect.top + MENU_GAP_PX;
    const menuWidth = menu.getBoundingClientRect().width;
    const maxLeft = Math.max(0, parentRect.width - menuWidth);
    const left = Math.min(Math.max(a.right - parentRect.left - menuWidth, 0), maxLeft);
    setPos({ top, left });
  }, [anchorRef]);

  // Focus the first enabled row on open.
  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, []);

  // Outside pointerdown closes (capture phase, while open).
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
    // No key leaks past the menu (the wrapper's chord reclaim).
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

  const stepperButton =
    "w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:bg-bg-card hover:text-text-primary outline-none focus-visible:bg-bg-card";

  return (
    <div
      ref={menuRef}
      data-testid="web-overflow-menu"
      role="menu"
      aria-label="Web tile actions"
      onKeyDown={onKeyDown}
      style={{ top: pos.top, left: pos.left }}
      className={`absolute ${POPOVER_SHELL} min-w-[160px] max-w-[280px] font-mono`}
    >
      {mobile && supports.history && (
        <>
          <Control
            variant="menu-row"
            role="menuitem"
            disabled={!canGoBack}
            onClick={() => {
              onBack();
              onClose();
            }}
          >
            Back
          </Control>
          <Control
            variant="menu-row"
            role="menuitem"
            disabled={!canGoForward}
            onClick={() => {
              onForward();
              onClose();
            }}
          >
            Forward
          </Control>
        </>
      )}
      {mobile && (
        <>
          <Control
            variant="menu-row"
            role="menuitem"
            onClick={() => {
              onFind();
              onClose();
            }}
          >
            Find in page
          </Control>
          <Control
            variant="menu-row"
            role="menuitem"
            onClick={() => {
              onOpenExternal();
              onClose();
            }}
          >
            Open in browser
          </Control>
        </>
      )}
      {/* The Zoom stepper's buttons are menuitems that fire WITHOUT closing
          the menu — stepping keeps the menu open so repeated steps need no
          re-open; Escape/Tab still close and refocus the anchor. */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-0.5" data-testid="web-zoom-control">
        <span aria-hidden="true" className="text-xs text-text-secondary select-none">
          Zoom
        </span>
        <span className="flex items-center">
          <button type="button" role="menuitem" aria-label="Zoom out" onClick={() => onZoom("out")} className={stepperButton}>
            −
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Reset zoom"
            disabled={zoom === 1}
            onClick={() => onZoom("reset")}
            className="h-7 min-w-11 px-1 flex items-center justify-center rounded text-xs tabular-nums text-text-secondary enabled:hover:bg-bg-card enabled:hover:text-text-primary disabled:opacity-60 outline-none focus-visible:bg-bg-card"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" role="menuitem" aria-label="Zoom in" onClick={() => onZoom("in")} className={stepperButton}>
            +
          </button>
        </span>
      </div>
      {supports.devtools && (
        <Control
          variant="menu-row"
          role="menuitem"
          onClick={() => {
            onInspect();
            onClose();
          }}
        >
          Inspect page
        </Control>
      )}
    </div>
  );
}
