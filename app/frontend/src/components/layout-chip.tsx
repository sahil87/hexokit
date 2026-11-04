import { useEffect, useRef, useState } from "react";
import { Tip } from "@/components/tip";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { formatCombo } from "@/lib/keybindings";
import {
  leaves,
  templateOf,
  templatesFor,
  TEMPLATES,
  TEMPLATE_LABEL,
  type Layout,
  type TemplateName,
} from "@/lib/surface-layout";
import { LayoutGlyph, LayoutTreeGlyph } from "@/components/top-bar-icons";
import { controlClass } from "@/components/control";
import {
  MENU_ROW_CHECK_MARK,
  POPOVER_SHELL,
} from "@/components/controls";

/**
 * ▦ Layout chip (spec docs/specs/surface-layout.md § Verbs — the one chip on
 * the layout, top-bar right cluster). Terminal-route L1 tier only.
 *
 * - **In-bar (`LayoutChip`)**: a fixed-square token button whose click opens a
 *   popover listing `templatesFor(n)` for the CURRENT tile count n (a template
 *   jump never changes the tile count; adds/closes do that). Each row carries
 *   a mini tree glyph rendered from the template's tree plus its
 *   `TEMPLATE_LABEL`; the current template is marked (trailing ✓ +
 *   `aria-checked`, the macOS menu pattern). Clicking a row hands the TEMPLATE
 *   NAME to the caller's `onApply` (top-bar runs `applyTemplate` →
 *   `applyLayout` — the single user-mutation path, R3 write discipline). The
 *   popover follows the `SplitControl` direction-menu pattern
 *   (outside-mousedown closes, Escape closes + refocuses the trigger,
 *   `role="menu"` + `menuitemradio` rows).
 * - **Current state**: a tree matching no template reads `custom` (lowercase)
 *   as a disabled marked row above the template rows; a one-tile tree (no
 *   templates exist at n = 1) renders its `single` state the same way, so the
 *   popover is never empty.
 * - **Overflow (`LayoutMenuRows`)**: the chip's chevron-menu form — one
 *   `Layout: …` `menuitemradio` row per template (the
 *   `ViewSwitcherMenuRows` precedent: `MENU_ROW_*` composition, checked row
 *   primary-ink + trailing ✓, `tabIndex={-1}` roving focus).
 *
 * The template CYCLE chord is the registry's `layout-cycle` binding (⌘;) —
 * the chip's tip advertises its effective combo (registry-derived, omitted
 * when unbound/disabled; the SplitControl tip pattern), and the palette's
 * `Layout: Cycle Template` entry is its Constitution V parity.
 *
 * Presentational by contract: the layout arrives resolved from app.tsx; the
 * chip owns only its popover-open state.
 */

type LayoutChipProps = {
  /** The RESOLVED layout (app.tsx ran the parse + degradation). */
  layout: Layout;
  /** Apply a template by name (the caller runs applyTemplate → applyLayout —
   *  persist + option write). */
  onApply: (template: TemplateName) => void;
  /** Disabled while this viewer has a tile popped out — a template rebuilds
   *  from the reduced render's slot order and would strand the popped leaf.
   *  The chip stays visible (state stays readable) but inert. */
  disabled?: boolean;
};

/** The current-state row for a tree no template matches (`custom`) or a
 *  one-tile tree (`single`): marked, never applicable. */
function CurrentStateRow({
  layout,
  name,
  menuPrefix,
  tabbable,
}: {
  layout: Layout;
  name: "single" | "custom";
  menuPrefix: boolean;
  tabbable: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={true}
      disabled
      tabIndex={tabbable ? undefined : -1}
      data-testid={`layout-template-${name}`}
      className={controlClass({ variant: "menu-row", pressed: true })}
    >
      <LayoutTreeGlyph name={name} tree={layout} />
      {`${menuPrefix ? "Layout: " : ""}${name === "single" ? "Single" : name}`}
      <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>
        ✓
      </span>
    </button>
  );
}

export function LayoutChip({ layout, onApply, disabled = false }: LayoutChipProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // A disabled chip never opens; a disable arriving mid-popover closes it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);

  // Outside-mousedown + Escape close (the SplitControl popover pattern);
  // Escape refocuses the trigger.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [open]);

  // Host-effective cycle chord for the tip's kbd slot (260811-0f3d pattern):
  // registry-derived, reflecting rebinds, omitted when unbound/disabled (a
  // keycap advertising a dead chord would lie).
  const { byAction, host } = useKeybindings();
  const cycleBinding = byAction.get("layout-cycle");
  const cycleChord = cycleBinding?.enabled
    ? formatCombo({ code: cycleBinding.code, tier: cycleBinding.tier }, host.platform)
    : undefined;

  // The popover lists exactly the templates for the CURRENT tile count (R16) —
  // a jump rebuilds the template's tree from the slot order, so it can never
  // strand a tile.
  const match = templateOf(layout);
  const templates = templatesFor(leaves(layout).length);

  const jump = (name: TemplateName) => {
    setOpen(false);
    onApply(name);
  };

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      {/* Tip suppressed while the popover is open (trigger convention — the
          tip must not paint over the first rows). */}
      <Tip
        label={
          open ? undefined : disabled ? "Layout — unavailable while a tile is popped out" : "Layout"
        }
        kbd={open || disabled ? undefined : cycleChord}
      >
        <button
          ref={buttonRef}
          type="button"
          data-testid="layout-chip"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Layout"
          className={controlClass({ variant: "icon", open, disabled })}
        >
          <LayoutGlyph />
        </button>
      </Tip>
      {open && (
        <div
          role="menu"
          aria-label="Layout templates"
          // The SplitControl direction-menu sizing: shrink-wraps to its rows
          // (`w-max`) with the 170px floor guarding the single-tile case.
          className={`absolute top-full right-0 mt-1 w-max min-w-[170px] ${POPOVER_SHELL}`}
        >
          {(match.name === "single" || match.name === "custom") && (
            <CurrentStateRow layout={layout} name={match.name} menuPrefix={false} tabbable />
          )}
          {templates.map((name) => {
            const current = name === match.name;
            return (
              <button
                key={name}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                data-testid={`layout-template-${name}`}
                onClick={() => jump(name)}
                className={controlClass({ variant: "menu-row", pressed: current })}
              >
                <LayoutTreeGlyph name={name} tree={TEMPLATES[name](leaves(layout))} />
                {TEMPLATE_LABEL[name]}
                {/* Current-template marker: trailing ✓ (the macOS menu pattern —
                    the row's glyph is identity, the ✓ is the state marker). */}
                {current && (
                  <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The chip's chevron-menu rows (260715-h1ck overflow representation): one
 * `Layout: …` `menuitemradio` row per template at the current tile count —
 * the `ViewSwitcherMenuRows` precedent (the menu-row composition — rest/checked
 * swap via the Control primitive,
 * checked row primary-ink + trailing ✓, `tabIndex={-1}` for the menu's roving
 * focus).
 * Clicking jumps directly (the menu's role-keyed click handler closes the
 * panel on a `menuitemradio` activation).
 */
export function LayoutMenuRows({ layout, onApply, disabled = false }: LayoutChipProps) {
  const match = templateOf(layout);
  const templates = templatesFor(leaves(layout).length);
  return (
    <>
      {(match.name === "single" || match.name === "custom") && (
        <CurrentStateRow layout={layout} name={match.name} menuPrefix tabbable={false} />
      )}
      {templates.map((name) => {
        const current = name === match.name;
        return (
          <button
            key={name}
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            aria-checked={current}
            disabled={disabled}
            data-testid={`layout-template-${name}`}
            onClick={() => onApply(name)}
            className={controlClass({ variant: "menu-row", pressed: current, disabled })}
          >
            <LayoutTreeGlyph name={name} tree={TEMPLATES[name](leaves(layout))} />
            {`Layout: ${TEMPLATE_LABEL[name]}`}
            {current && (
              <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>
                ✓
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
