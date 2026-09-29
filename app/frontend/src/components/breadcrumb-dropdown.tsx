import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { Tip } from "@/components/tip";
import { controlClass } from "@/components/control";
import { MENU_ROW_CHECK_MARK, POPOVER_SHELL } from "@/components/controls";
import { useOccludes } from "@/hooks/use-occludes";
import type { BreadcrumbDropdownItem } from "@/contexts/chrome-context";

type DropdownAction = { label: string; onAction: () => void };

/** Vertical gap between the trigger's bottom edge and the menu's top (matches
 *  the old `mt-1` — 0.25rem = 4px). */
const MENU_GAP_PX = 4;

type Props = {
  items: BreadcrumbDropdownItem[];
  label?: string;
  onNavigate?: (href: string) => void;
  action?: DropdownAction;
  /** Optional SECOND leading action, rendered below `action` (e.g. the
   *  tab switcher's `+ New Agent` beside `+ New Tab`). Only honored when
   *  `action` is also present. Every other call site passes just `action` and
   *  keeps its single-action behavior unchanged. */
  secondaryAction?: DropdownAction;
  triggerClassName?: string;
  /** Custom trigger content, replacing the default bare `▾` caret span (the
   *  collapsed breadcrumb's `… ▾` crumb is the one consumer). Unset → the
   *  default caret. */
  triggerContent?: ReactNode;
  /** Trigger tooltip — names the crumb's level (e.g. "Session"). Rendered as a
   *  tier-1 `Tip` around the trigger (260722-73al), not a native `title=`
   *  attribute; the prop keeps its name (it is a component prop, like
   *  `Dialog title=`). Suppressed while the menu is open so the tip never
   *  paints over the menu's first rows. */
  title?: string;
};

export function BreadcrumbDropdown({ items, label, onNavigate, action, secondaryAction, triggerClassName, triggerContent, title }: Props) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  // Viewport-relative position for the fixed-positioned menu. `position: fixed`
  // takes the menu OUT of the breadcrumb `<nav>`'s clip context (the nav carries
  // `overflow-hidden` as the top-bar overlap backstop, 260715-q8ey), so an
  // `absolute` menu would be clipped to the nav's single-line box and its
  // focus-on-open scroll would drag the nav content off-screen. Anchored to the
  // trigger's `getBoundingClientRect()` and recomputed on scroll/resize.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Leading actions occupy indices 0..offset-1; items follow at offset..N-1.
  // A secondaryAction is only meaningful alongside a primary action.
  const leadingActions: DropdownAction[] = action
    ? secondaryAction
      ? [action, secondaryAction]
      : [action]
    : [];
  const offset = leadingActions.length;
  const totalCount = items.length + offset;

  function getFocusableRef(index: number): HTMLButtonElement | null {
    if (index < offset) return actionRefs.current[index] ?? null;
    return itemRefs.current[index - offset] ?? null;
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const next = prev < totalCount - 1 ? prev + 1 : 0;
          getFocusableRef(next)?.focus();
          return next;
        });
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setFocusedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : totalCount - 1;
          getFocusableRef(next)?.focus();
          return next;
        });
      }
    }
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => document.removeEventListener("keydown", handleKey, { capture: true });
  }, [open, totalCount]);

  useEffect(() => {
    if (!open) return;
    const currentIdx = items.findIndex((item) => item.current);
    const targetIdx = (currentIdx >= 0 ? currentIdx : 0) + offset;
    setFocusedIndex(targetIdx);
    requestAnimationFrame(() => {
      getFocusableRef(targetIdx)?.focus();
    });
  }, [open, items]);

  const toggle = useCallback(() => {
    setOpen((v) => !v);
  }, []);

  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);

  // Anchor the fixed menu to the trigger's current viewport rect: top-left just
  // below the trigger, mirroring the old `absolute top-full left-0 mt-1`.
  const computeMenuPos = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + MENU_GAP_PX, left: rect.left });
  }, []);

  // Position synchronously before paint on open (avoids a first-frame flash at
  // 0,0); clear the stored position on close so the next open re-measures.
  useLayoutEffect(() => {
    if (open) {
      computeMenuPos();
    } else {
      setMenuPos(null);
    }
  }, [open, computeMenuPos]);

  // Keep the fixed menu glued to a moving trigger: any scroll (capture:true so
  // scrolls in ANY ancestor scroll container are heard, not just window) or a
  // resize recomputes the anchor rather than letting the menu detach. The menu
  // is itself `overflow-y-auto`, and `scroll` doesn't bubble but DOES capture,
  // so a scroll INSIDE the menu would otherwise fire this handler and trigger a
  // redundant re-render (the trigger's rect is unchanged, yet `setMenuPos` gets
  // a fresh object each call). Ignore scrolls originating within the menu.
  useEffect(() => {
    if (!open) return;
    const onReflow = (e: Event) => {
      if (e.type === "scroll" && menuRef.current?.contains(e.target as Node)) return;
      computeMenuPos();
    };
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, computeMenuPos]);

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <Tip label={open ? undefined : title}>
        <button
          ref={buttonRef}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={label ? `Switch ${label}` : "Switch"}
          onClick={toggle}
          // rk-glint / trigger `overflow:hidden` is safe: the open menu is
          // `position: fixed` (anchored to this trigger's viewport rect, below),
          // so it lives OUTSIDE both this trigger's box and the breadcrumb nav's
          // `overflow-hidden` clip — no ancestor overflow can clip or displace it.
          className={`min-w-[24px] min-h-[24px] coarse:min-w-[40px] coarse:min-h-[40px] flex items-center transition-colors ${triggerClassName ?? "text-text-secondary hover:text-text-primary"}`}
        >
          {triggerContent ?? <span className="min-w-0 truncate">{"\u25BE"}</span>}
        </button>
      </Tip>
      {open && menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label ? `Switch ${label}` : "Switch"}
          // `fixed` + measured viewport coords (not `absolute top-full`): frees
          // the menu from the breadcrumb nav's `overflow-hidden` clip context
          // (260715-q8ey). `left-0` etc. are dropped since positioning is inline.
          style={{ top: menuPos.top, left: menuPos.left }}
          className={`fixed ${POPOVER_SHELL} min-w-[160px] max-w-[240px] max-h-60 overflow-y-auto`}
        >
          {leadingActions.length > 0 && (
            <>
              {leadingActions.map((la, i) => (
                <button
                  key={la.label}
                  ref={(el) => { actionRefs.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={focusedIndex === i ? 0 : -1}
                  onClick={() => {
                    setOpen(false);
                    la.onAction();
                  }}
                  className={controlClass({ variant: "menu-row" })}
                >
                  {la.label}
                </button>
              ))}
              <div className="border-t border-border" />
            </>
          )}
          {items.map((item, i) => (
            <button
              key={item.href}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="menuitem"
              tabIndex={focusedIndex === i + offset ? 0 : -1}
              onClick={() => {
                setOpen(false);
                if (onNavigate) {
                  onNavigate(item.href);
                }
              }}
              className={controlClass({ variant: "menu-row", pressed: item.current })}
            >
              {item.icon && (
                // `currentColor` decoration — rides the row's rest→hover /
                // checked ink instead of re-typing the row's color tokens.
                <span className="shrink-0">{item.icon}</span>
              )}
              <span className="min-w-0 truncate">{item.label}</span>
              {item.current && (
                <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
