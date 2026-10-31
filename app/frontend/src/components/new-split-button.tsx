import { useEffect, useMemo, useRef, useState } from "react";
import { useMatches } from "@tanstack/react-router";
import { controlClass } from "@/components/control";
import { MENU_ROW_KBD_CLASS, POPOVER_SECTION_LABEL, POPOVER_SHELL } from "@/components/controls";
import { Tip } from "@/components/tip";
import type { TopBarMode } from "@/components/top-bar";
import { useFocusedPane } from "@/contexts/focused-pane-context";
import { usePaletteActionsApi } from "@/contexts/palette-actions-context";
import { useSessionContext } from "@/contexts/session-context";
import { useTopBarNotFound, useTopBarSlot } from "@/contexts/top-bar-slot-context";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { formatCombo } from "@/lib/keybindings";
import { newSplitPrimary, newSplitSections, type NewSplitTarget } from "@/lib/new-split";

/**
 * The route's `TopBarMode`, derived exactly like `RootTopBar` does (the
 * deepest-first param walk, with the not-found page forcing `host`). Surfaces
 * outside the top bar — the mobile drawer's brand row — need the same answer.
 */
export function useNewSplitMode(): TopBarMode {
  const matches = useMatches();
  const notFound = useTopBarNotFound();
  if (notFound) return "host";
  let hasServer = false;
  let hasWindow = false;
  let hasBoard = false;
  for (const m of matches) {
    const p = (m.params ?? {}) as { server?: string; window?: string; name?: string };
    if (typeof p.server === "string") hasServer = true;
    if (typeof p.window === "string") hasWindow = true;
    if (typeof p.name === "string") hasBoard = true;
  }
  if (hasBoard) return "board";
  if (hasWindow) return "terminal";
  if (hasServer) return "server";
  return "host";
}

/** Effective chord for a palette action id, or undefined when unbound,
 *  disabled or browser-reserved (a tip advertising a dead chord would lie). */
function useChordFor(): (actionId: string) => string | undefined {
  const { byAction, host } = useKeybindings();
  return (actionId) => {
    const b = byAction.get(actionId);
    return b?.enabled ? formatCombo({ code: b.code, tier: b.tier }, host.platform) : undefined;
  };
}

/** Where the menu's results land: the route's workspace and group. The board
 *  has no group of its own — it is the focused pane's. Read only while the
 *  menu is open (the session list changes on every SSE tick). */
function useNewSplitTarget(mode: TopBarMode): NewSplitTarget {
  const slot = useTopBarSlot();
  const focused = useFocusedPane();
  const { sessionsByServer } = useSessionContext();
  const matches = useMatches();
  if (mode === "board") {
    if (!focused) return { server: "", group: null };
    const group =
      (sessionsByServer.get(focused.server) ?? []).find((s) =>
        s.windows.some((w) => w.windowId === focused.windowId),
      )?.name ?? null;
    return { server: focused.server, group };
  }
  let server = slot?.server ?? "";
  for (const m of matches) {
    const p = (m.params ?? {}) as { server?: string };
    if (typeof p.server === "string") server = p.server;
  }
  return { server, group: mode === "terminal" ? slot?.sessionName || null : null };
}

const PLUS_GLYPH = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <line x1="6" y1="2" x2="6" y2="10" />
    <line x1="2" y1="6" x2="10" y2="6" />
  </svg>
);

const CARET_GLYPH = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="2,3.5 5,6.5 8,3.5" />
  </svg>
);

/** The accent-green outline shared by the split chip and the plain host button. */
const NEW_CHIP_CLASS = "rounded border border-accent-green bg-accent-green/10 text-accent-green";
const NEW_SEGMENT_REST = "border-accent-green text-accent-green hover:bg-accent-green/15";

/**
 * NewSplitButton — the persistent `+ New` control (open-button.tsx's split
 * geometry and menu shell). The PRIMARY segment is an instant create at the
 * deepest level the route has (`newSplitPrimary`); the CARET opens a menu
 * grouped by where the result lands (`newSplitSections`). Every primary and
 * row invokes a palette action by id (Constitution V), resolved against the
 * live palette list at click time — a row whose id the route has not
 * registered is omitted, so the control never offers an action the palette
 * lacks.
 *
 * `iconOnly` is the fold's narrowest form (`+▾`) and the closed-sidebar
 * fallback after the hamburger. The host page's primary opens the New sheet
 * itself, so it renders as one plain `+ Workspace` button with no caret.
 */
export function NewSplitButton({ mode, iconOnly = false }: { mode: TopBarMode; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { getAllActions } = usePaletteActionsApi();
  const chordFor = useChordFor();
  const primary = newSplitPrimary(mode);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [open]);

  // Menus register `transient` so a native guest composited above the DOM
  // hides while the menu is open.
  useOccludes("transient", open);

  const run = (actionId: string) => {
    setOpen(false);
    const action = getAllActions().find((a) => a.id === actionId);
    if (action && !action.disabled) action.onSelect();
  };

  const chord = chordFor(primary.actionId);
  const tipLabel = chord ? `${primary.tip} (${chord})` : primary.tip;
  const showLabel = !iconOnly;

  if (!primary.caret) {
    return (
      <Tip label={tipLabel}>
        <button
          type="button"
          data-testid="new-split-primary"
          aria-label={primary.tip}
          onClick={() => run(primary.actionId)}
          className={`rk-glint px-2 text-xs font-mono inline-flex items-center justify-center gap-1 h-[28px] coarse:h-[40px] transition-colors hover:bg-accent-green/15 ${NEW_CHIP_CLASS}`}
        >
          {showLabel ? primary.label : PLUS_GLYPH}
        </button>
      </Tip>
    );
  }

  return (
    <div ref={containerRef} className="relative inline-flex items-center shrink-0" data-testid="new-split">
      <span className={`inline-flex items-stretch overflow-hidden ${NEW_CHIP_CLASS}`}>
        <Tip label={tipLabel}>
          <button
            type="button"
            data-testid="new-split-primary"
            aria-label={primary.tip}
            onClick={() => run(primary.actionId)}
            className={`rk-glint ${showLabel ? "px-2" : "px-1.5"} text-xs font-mono flex items-center justify-center gap-1 whitespace-nowrap transition-colors ${controlClass({ variant: "segment", rest: NEW_SEGMENT_REST })}`}
          >
            {showLabel ? primary.label : PLUS_GLYPH}
          </button>
        </Tip>
        <Tip label={open ? undefined : "More ways to create…"}>
          <button
            ref={triggerRef}
            type="button"
            data-testid="new-split-caret"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="More ways to create…"
            className={`rk-glint px-1 border-l flex items-center justify-center transition-colors ${controlClass({ variant: "segment", rest: NEW_SEGMENT_REST, open })}`}
          >
            {CARET_GLYPH}
          </button>
        </Tip>
      </span>
      {open && <NewSplitMenu mode={mode} chordFor={chordFor} onRun={run} />}
    </div>
  );
}

/** The caret menu — mounted only while open, so the session subscription its
 *  header needs does not tax the always-mounted button. */
function NewSplitMenu({
  mode,
  chordFor,
  onRun,
}: {
  mode: TopBarMode;
  chordFor: (actionId: string) => string | undefined;
  onRun: (actionId: string) => void;
}) {
  const { getAllActions } = usePaletteActionsApi();
  const target = useNewSplitTarget(mode);
  const sections = useMemo(() => {
    const registered = new Set(getAllActions().map((a) => a.id));
    return newSplitSections(mode, target)
      .map((s) => ({ ...s, rows: s.rows.filter((r) => registered.has(r.actionId)) }))
      .filter((s) => s.rows.length > 0);
  }, [mode, target, getAllActions]);

  return (
    <div
      role="menu"
      aria-label="New"
      data-testid="new-split-menu"
      className={`absolute top-full left-0 mt-1 min-w-[220px] ${POPOVER_SHELL}`}
    >
      {sections.map((section, i) => (
        <div key={section.header ?? `section-${i}`} role="group" aria-label={section.header}>
          {i > 0 && <div aria-hidden="true" className="my-1 border-t border-border" />}
          {section.header && (
            <div aria-hidden="true" className={`${POPOVER_SECTION_LABEL} normal-case`}>
              {section.header}
            </div>
          )}
          {section.rows.map((row) => {
            const chord = chordFor(row.actionId);
            return (
              <button
                key={row.actionId}
                type="button"
                role="menuitem"
                data-action-id={row.actionId}
                onClick={() => onRun(row.actionId)}
                className={controlClass({ variant: "menu-row" })}
              >
                <span aria-hidden="true" className="w-4 shrink-0 text-center">
                  {row.glyph}
                </span>
                {row.label}
                {chord && (
                  <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
                    {chord}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
