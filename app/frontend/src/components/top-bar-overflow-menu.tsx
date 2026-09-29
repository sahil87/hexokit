import {
  useState,
  useRef,
  useEffect,
  useId,
  useLayoutEffect,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useUpdateNotification } from "@/contexts/session-context";
import { displayVersion } from "@/lib/palette/version";
import { updateChipToolSummary } from "@/lib/palette/update";
import { copyToClipboard } from "@/lib/clipboard";
import { useToast } from "@/components/toast";
import { LogoSpinner } from "@/components/logo-spinner";
import { useUpdateClick } from "@/hooks/use-update-click";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { Tip } from "@/components/tip";
import { HELP_URL, HelpIcon } from "@/components/global-chrome";
import { HeadsetIcon, KeyboardIcon } from "@/components/sidebar/icons";
import { requestQuakeTerminal } from "@/lib/quake-terminal";
import { HELP_TOPICS, openHelpTopic } from "@/lib/help-topics";
import { useSettingsDialog } from "@/contexts/settings-dialog-context";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { formatCombo } from "@/lib/keybindings";
import { controlClass } from "./control";
import {
  MENU_ROW_KBD_CLASS,
  POPOVER_SECTION_LABEL,
  POPOVER_SHELL,
} from "./controls";

/** Sentinel running version for local (non-ldflags) builds — the version row's
 *  check-again affordance is hidden for it (a dev daemon never checks; the same
 *  gate as the palette check entries). Kept local, same pattern as
 *  lib/palette/update.ts / hooks/use-update-check.ts. */
const DEV_VERSION = "dev";

/** Vertical gap between the chevron's bottom edge and the menu's top (matches
 *  BreadcrumbDropdown's MENU_GAP_PX — 4px). */
const MENU_GAP_PX = 4;

/** Fixed section order + labels for the grouped menu (260731-oiho). */
const MENU_SECTIONS: { key: MenuGroup; label: string }[] = [
  { key: "tiles", label: "Tiles" },
  { key: "view", label: "View" },
  { key: "window", label: "Tab" },
  { key: "app", label: "App" },
];

/**
 * Menu section identity (260731-oiho): every registry entry names the section
 * its menu rows belong to; the menu renders non-empty sections in the fixed
 * Tiles → View → Window → App order under thin uppercase labels. The partition
 * preserves registry (pyramid) order within each section.
 */
export type MenuGroup = "tiles" | "view" | "window" | "app";

/**
 * A single overflowed control, rendered as a menu row. `id` is the registry id
 * (stable key); `group` is the section it renders under (260731-oiho); `node`
 * is the control's `menuRender` output — a self-contained row that owns exactly
 * one focusable element (a `<button role="menuitem">`, `<a role="menuitem">`,
 * or a stepper row whose first control is focusable).
 */
export type OverflowMenuRow = { id: string; group: MenuGroup; node: ReactNode };

/**
 * The App section's relocated global-chrome rows (260812-d1at) — Help and
 * Keyboard shortcuts, moved out of the sidebar footer. Both reuse the shared
 * `global-chrome.tsx` definitions (and the sidebar's `KeyboardIcon`) so the
 * menu can never drift from the command palettes. They are `menuOnly`
 * registry entries in `top-bar.tsx`: always in the menu, never in the bar,
 * on every top-bar mode. Theme switching carries no menu row — it lives in
 * the settings dialog's inline picker and the palette's theme actions.
 */

/** Help — external docs link. An anchor, never a button: external navigation
 *  must not unload the live dashboard's terminals/socket. */
export function HelpMenuRow() {
  return (
    <a
      role="menuitem"
      tabIndex={-1}
      href={HELP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={controlClass({ variant: "menu-row" })}
    >
      <HelpIcon />
      <span className="flex-1">Help — HexoKit docs</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * Help topics — an inline disclosure of the curated `HELP_TOPICS` pages. The
 * menu is a single-level `role="menu"` list with no submenu primitive, so the
 * topics expand IN PLACE (the row toggles a `role="group"` beneath it) rather
 * than in a second popover. The expanded state is component-local: the menu
 * unmounts its rows on close, so it always reopens collapsed.
 *
 * `external` — true outside terminal mode, where no window owns a web tile and
 * a topic opens a browser tab; the rows then carry the same `↗` the Help row
 * uses. Inside terminal mode the shell handles the open in-tile and the rows
 * show no glyph. The decision itself lives in `openHelpTopic`'s cancelable
 * event, not here — the prop only keeps the glyph honest.
 *
 * Keyboard: Enter/Space (native click) and ArrowRight expand, ArrowLeft
 * collapses (from the disclosure or from any topic row, refocusing the
 * disclosure); ArrowUp/Down stay the menu's — the topic buttons are ordinary
 * focusables in its flat navigation list. Escape keeps closing the whole
 * menu. A topic row IS a terminal `role="menuitem"`, so the container's
 * role-keyed dismissal closes the menu after it fires.
 */
export function HelpTopicsMenuRow({ external }: { external: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  const disclosureRef = useRef<HTMLButtonElement>(null);

  const collapse = useCallback(() => {
    setExpanded(false);
    disclosureRef.current?.focus();
  }, []);

  const handleDisclosureKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" && !expanded) {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(true);
    } else if (e.key === "ArrowLeft" && expanded) {
      e.preventDefault();
      e.stopPropagation();
      collapse();
    }
  };

  const handleGroupKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      collapse();
    }
  };

  return (
    <>
      <button
        ref={disclosureRef}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-expanded={expanded}
        aria-controls={expanded ? groupId : undefined}
        data-menu-disclosure
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={handleDisclosureKey}
        className={controlClass({ variant: "menu-row" })}
      >
        <HelpIcon />
        <span className="flex-1">Help topics</span>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div id={groupId} role="group" aria-label="Help topics" className="pl-4" onKeyDown={handleGroupKey}>
          {HELP_TOPICS.map((topic) => (
            <button
              key={topic.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => openHelpTopic(topic)}
              className={controlClass({ variant: "menu-row" })}
            >
              <span className="flex-1">{topic.label}</span>
              {topic.tool !== "run-kit" && (
                <span className="text-[10px] text-text-secondary">{topic.tool}</span>
              )}
              {external && <span aria-hidden="true">↗</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Keyboard shortcuts — deep-links into the settings dialog's Shortcuts tab
 *  via the layout-provided `useSettingsDialog()` (the standalone overlay and
 *  its `shortcuts-overlay:open` event seam are retired, 260818-bncw). The
 *  trailing keycap shows the HOST-effective `shortcuts-overlay` chord, omitted
 *  when the binding is unbound/disabled (a chord slot advertising a dead chord
 *  would lie). */
export function KeyboardMenuRow() {
  const { byAction, host } = useKeybindings();
  const { openSettings } = useSettingsDialog();
  const binding = byAction.get("shortcuts-overlay");
  const chord = binding?.enabled
    ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform)
    : undefined;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => openSettings("shortcuts")}
      className={controlClass({ variant: "menu-row" })}
    >
      <KeyboardIcon size={14} />
      <span className="flex-1">Keyboard shortcuts</span>
      {chord && (
        <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
          {chord}
        </kbd>
      )}
    </button>
  );
}

/** Quake terminal — the mobile entry to the quake terminal (no keyboard
 *  exists on a phone, so the chord can't carry it). Fires the same
 *  document-event open the palette action dispatches (desktop: open+focused
 *  on the ⌘J machine; mobile: navigation to the operator window's terminal
 *  route); the layout-mounted quake terminal owns the fork. The trailing keycap
 *  shows the host-effective chord, omitted when unbound/disabled. */
export function QuakeTerminalMenuRow() {
  const { byAction, host } = useKeybindings();
  const binding = byAction.get("quake-terminal");
  const chord = binding?.enabled
    ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform)
    : undefined;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => requestQuakeTerminal({ action: "open" })}
      className={controlClass({ variant: "menu-row" })}
    >
      <HeadsetIcon size={14} />
      <span className="flex-1">Quake terminal</span>
      {chord && (
        <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
          {chord}
        </kbd>
      )}
    </button>
  );
}

type Props = {
  /** Overflowed controls, already in pyramid order, each pre-rendered as a row. */
  rows: OverflowMenuRow[];
  /** True when a qualifying, undismissed update is pending AND the UpdateChip is
   *  currently overflowed into this menu. Lights the chevron attention badge
   *  (R7) and is one of the two derivations that flip the version row into the
   *  update surface (R11) — the other (260720-ml7k) is a dismissed pending
   *  update (`qualifies && !showChip`, read from context here), which shows the
   *  surface WITHOUT the badge: dismissal silences ambient chrome only, and the
   *  menu is deliberate discovery (same posture as the palette's `qualifies`
   *  gate). */
  updateOverflowed: boolean;
};

/**
 * Top-bar overflow chevron + menu (260715-h1ck). The chevron is a fixed,
 * always-visible icon button sitting immediately LEFT of the connection dot
 * (the dot keeps its right-most status-terminator role). It follows the top-bar
 * icon-button convention (`rk-glint`, bordered chip, coarse touch sizing) and
 * the menu mirrors `breadcrumb-dropdown.tsx`'s a11y contract: `role="menu"` /
 * `role="menuitem"`, Escape closes + refocuses the trigger, ArrowUp/ArrowDown
 * move focus, outside `mousedown` closes, and the panel is `position: fixed`
 * anchored to the trigger rect (so no ancestor `overflow-hidden` clips it and no
 * new dependency is needed).
 *
 * The menu always contains the fixed version row (last), so the chevron renders
 * even when nothing is overflowed. When a qualifying pending update has no
 * in-bar chip (its entry is overflowed here, or it was dismissed) the version
 * row doubles as the update surface (R11); only the undismissed-overflowed case
 * also lights the chevron's accent attention badge (R7). At rest the row is the
 * unified update button's resting form (260720-ml7k): version + a dev-gated ⟳
 * "Check for updates" affordance running the incl.-patches check (the palette's
 * `HexoKit: Check for Updates (incl. patches)` behavior) — placement
 * between this row and the in-bar chip is always DERIVED from the verdict
 * state, never imperatively moved.
 */
export function TopBarOverflowMenu({ rows, updateOverflowed }: Props) {
  const { daemonVersion, tools, singleRunKit, latest, current, qualifies, showChip } =
    useUpdateNotification();
  const { addToast } = useToast();
  // Shared one-click-update behavior with the in-bar UpdateChip (review M5).
  const { updating, triggerUpdate } = useUpdateClick();
  // Shared check flow with the palette check commands (260720-ml7k) — POST →
  // one result toast, fail-loud error toast; `checking` drives the ⟳ spinner.
  const { runUpdateCheck, checking } = useUpdateCheck();

  const [open, setOpen] = useState(false);
  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);
  // True once the version row currently holds keyboard focus — drives its roving
  // tabIndex (it is the only always-present focusable, so it owns the initial
  // tab stop until arrow-nav moves focus into an overflowed row).
  const [versionRowFocused, setVersionRowFocused] = useState(true);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Selector matching every keyboard-focusable menu control. Rows stay
  // presentational: a row may render ONE control (most) or SEVERAL (the
  // notification row's two buttons, the font stepper's − / +), so navigation
  // enumerates the flat list of focusable controls in DOM order (= visual
  // order) rather than one-focusable-per-row — otherwise the second+ control in
  // a multi-control row is keyboard-unreachable (Constitution V).
  const FOCUSABLE_SELECTOR = "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

  // All focusable controls currently in the menu panel, in DOM order. Resolved
  // at navigation time so it always reflects the live rows (a row's enabled
  // controls can change, e.g. the font stepper's − / + gating at bounds).
  const focusables = useCallback((): HTMLElement[] => {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }, []);

  // Move focus by `delta` (+1 down, -1 up) through the flat focusable list,
  // wrapping at both ends. Anchors off the currently-focused control's position
  // so navigation is stable even as the list shifts.
  const moveFocus = useCallback(
    (delta: number) => {
      const items = focusables();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const curr = active ? items.indexOf(active) : -1;
      const base = curr === -1 ? (delta > 0 ? -1 : 0) : curr;
      const next = (base + delta + items.length) % items.length;
      items[next]?.focus();
    },
    [focusables],
  );

  // Outside-click close (mousedown, like BreadcrumbDropdown).
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

  // Keyboard: Escape closes + refocuses trigger; ArrowUp/Down move focus.
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
        moveFocus(1);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-1);
      }
    }
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => document.removeEventListener("keydown", handleKey, { capture: true });
  }, [open, moveFocus]);

  // On open, restore the version row as the default tab stop and focus the
  // first focusable control.
  useEffect(() => {
    if (!open) return;
    setVersionRowFocused(true);
    requestAnimationFrame(() => {
      const items = focusables();
      items[0]?.focus();
    });
  }, [open, focusables]);

  // Anchor the fixed menu to the chevron's viewport rect: top just below the
  // trigger, right-aligned to the trigger's right edge (the chevron lives at the
  // right end of the bar, so the menu opens leftward from there).
  const computeMenuPos = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + MENU_GAP_PX, right: window.innerWidth - rect.right });
  }, []);

  useLayoutEffect(() => {
    if (open) computeMenuPos();
    else setMenuPos(null);
  }, [open, computeMenuPos]);

  // Keep the fixed menu glued to a moving trigger (scroll in any ancestor /
  // resize). Ignore scrolls originating inside the menu itself.
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

  const toggle = useCallback(() => setOpen((v) => !v), []);
  // Close the menu after a row action fires — exposed to rows via a shared
  // handler so a menu-row click dismisses the panel like BreadcrumbDropdown.
  const close = useCallback(() => setOpen(false), []);

  // Version-row plain form: `HexoKit v{version}` (plain `HexoKit` when the
  // version is unknown — no `event: version` yet — never `vundefined`).
  const versionText = daemonVersion ? `HexoKit ${displayVersion(daemonVersion)}` : "HexoKit";

  // Copy the displayed version form (matches app.tsx buildVersionAction body).
  const handleCopy = useCallback(() => {
    if (!daemonVersion) return; // plain `HexoKit` — nothing meaningful to copy
    void copyToClipboard(displayVersion(daemonVersion)).then((ok) => {
      addToast(ok ? "Version copied" : "Copy failed", ok ? "info" : "error");
    });
    setOpen(false);
  }, [daemonVersion, addToast]);

  // Chevron attention badge: ONLY the undismissed-overflowed case — a dismissed
  // update must not light ambient chrome (the dismissal contract).
  const showBadge = updateOverflowed && tools.length > 0;
  // The version row becomes the update surface whenever a qualifying update is
  // pending AND the chip is not in-bar: its entry is overflowed into this menu,
  // OR the update is dismissed (`qualifies && !showChip`, 260720-ml7k — the
  // update surface is the stronger affordance than the ⟳ when a verdict is
  // already known; the menu is deliberate discovery, like the palette).
  const asUpdateSurface = tools.length > 0 && (updateOverflowed || (qualifies && !showChip));
  // Resting-row check-again affordance (260720-ml7k): shown whenever no update
  // surface is showing, EXCEPT on the dev sentinel (a dev daemon never checks —
  // same gate as the palette check entries; a null version counts as non-dev).
  const showCheck = !asUpdateSurface && daemonVersion !== DEV_VERSION;
  // Single run-kit match keeps today's `HexoKit v{current} → v{latest} ⬆` row +
  // aria; any other single tool or multiple tools show a count row naming each
  // per-tool transition in the aria (R15). The row triggers a SCOPED update of
  // exactly the matched tools. The per-tool summary is the shared
  // `updateChipToolSummary` (single source, consumed by the in-bar chip too — no
  // bar↔menu drift, A-024).
  const toolSummary = updateChipToolSummary(tools);
  const updateRowText =
    singleRunKit && current && latest
      ? `HexoKit v${current} → v${latest} ⬆`
      : `Toolkit updates (${tools.length}) ⬆`;
  const updateLabel =
    singleRunKit && current
      ? `Update HexoKit: v${current} → v${latest}`
      : `Update: ${toolSummary}`;

  // Section partition (260731-oiho): non-empty sections render in the fixed
  // Tiles → View → Window → App order under thin uppercase labels (the OpenButton
  // "on host" header treatment). The always-present version row rides at the
  // App section's tail, so the App section always renders. When the menu holds
  // ONLY the version row (nothing overflowed, no menuOnly rows — server/host
  // modes at wide widths) no labels render — the row keeps its minimal form.
  const sections = MENU_SECTIONS.map((s) => ({
    ...s,
    rows: rows.filter((r) => r.group === s.key),
  })).filter((s) => s.rows.length > 0 || s.key === "app");
  const showLabels = rows.length > 0;

  // The fixed version row — the App section's tail: the update surface when a
  // qualifying update is pending without an in-bar chip, else the resting
  // version-copy + check-⟳ form (260720-ml7k).
  const versionNode = asUpdateSurface ? (
    <button
      type="button"
      role="menuitem"
      tabIndex={versionRowFocused ? 0 : -1}
      onFocus={() => setVersionRowFocused(true)}
      onBlur={() => setVersionRowFocused(false)}
      disabled={updating}
      onClick={triggerUpdate}
      aria-label={updating ? "Updating HexoKit" : updateLabel}
      className={`${controlClass({ variant: "menu-row", bare: true })} text-accent-green hover:bg-bg-card disabled:opacity-60 disabled:cursor-not-allowed`}
    >
      {updating ? (
        <>
          <LogoSpinner size={12} />
          <span>{"updating…"}</span>
        </>
      ) : (
        <span>{updateRowText}</span>
      )}
    </button>
  ) : (
    // Resting row: version copy button + the check-again ⟳ (260720-ml7k).
    // The ⟳ is a PLAIN control (no role="menuitem", tabIndex -1) so the
    // container's role-keyed close handler does not fire — the menu stays
    // open across the ~1-2s check and the spinner/single-flight state is
    // visible (the font-stepper precedent for non-terminal menu actions).
    // Arrow-nav still reaches it via the `button:not([disabled])`
    // focusables selector.
    <div className="flex items-center gap-1 pr-2">
      <Tip label={daemonVersion ? "Copy version" : undefined}>
        <button
          type="button"
          role="menuitem"
          tabIndex={versionRowFocused ? 0 : -1}
          onFocus={() => setVersionRowFocused(true)}
          onBlur={() => setVersionRowFocused(false)}
          onClick={handleCopy}
          aria-label={daemonVersion ? `${versionText} (copy)` : "HexoKit"}
          className={controlClass({ variant: "menu-row", className: "w-auto! flex-1 min-w-0" })}
        >
          {versionText}
        </button>
      </Tip>
      {showCheck && (
        <Tip label="Check for updates">
        <button
          type="button"
          tabIndex={-1}
          disabled={checking}
          onClick={() => runUpdateCheck(true)}
          aria-label="Check for updates"
          className={controlClass({ variant: "icon", glint: false, disabled: false, className: "hover:text-text-primary" })}
        >
          {checking ? (
            <LogoSpinner size={12} />
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* lucide rotate-cw — the refresh vocabulary (RefreshButton) */}
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          )}
        </button>
        </Tip>
      )}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      // Close the menu when a TERMINAL menu action fires — i.e. a click that
      // lands on a `role="menuitem"`/`menuitemcheckbox`/`menuitemradio` control
      // (mirrors BreadcrumbDropdown's setOpen(false) on select). Deliberately
      // keyed on the ROLE, not the row wrapper (review S1): the TerminalFont
      // stepper row is a `role="group"` whose `−`/`+` are plain buttons, so
      // stepping the font does NOT match and the menu stays open across repeated
      // steps. Checkbox toggles (fixed-width, autofit) and layout-shape radio
      // rows (LayoutMenuRows) DO close, matching a single-shot menu action.
      // A `data-menu-disclosure` menuitem (the Help topics row) is exempt: it
      // toggles an inline group, so its click must leave the menu open.
      onClick={(e) => {
        const t = e.target as HTMLElement;
        const item = t.closest('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
        if (
          open &&
          menuRef.current?.contains(t) &&
          item &&
          !item.hasAttribute("data-menu-disclosure")
        ) {
          close();
        }
      }}
    >
      {/* Tip suppressed while the menu is open (BreadcrumbDropdown trigger
          convention — the tip must not paint over the first menu rows). */}
      <Tip label={open ? undefined : "More controls"}>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="More controls"
        className={controlClass({ variant: "icon", open, className: "relative" })}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* chevron-down */}
          <polyline points="6 9 12 15 18 9" />
        </svg>
        {/* Attention badge: a small green dot when an overflowed
            attention-bearing item (the pending update chip) is in the menu.
            Deliberately NOT keyed on the dismissed-pending update surface —
            dismissal silences ambient chrome. */}
        {showBadge && (
          <span
            data-testid="overflow-attention"
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent-green"
          />
        )}
      </button>
      </Tip>
      {open && menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More controls"
          style={{ top: menuPos.top, right: menuPos.right }}
          className={`fixed ${POPOVER_SHELL} min-w-[200px] max-w-[280px] max-h-[70vh] overflow-y-auto`}
        >
          {sections.map((s, i) => (
            <div key={s.key}>
              {/* Section separators use the pre-existing divider styling; the
                  thin uppercase label is aria-hidden decoration (the OpenButton
                  "on host" header precedent) — menu semantics ride the rows. */}
              {i > 0 && <div className="border-t border-border my-1" />}
              {showLabels && (
                <div
                  aria-hidden="true"
                  className={POPOVER_SECTION_LABEL}
                >
                  {s.label}
                </div>
              )}
              {s.rows.map((row) => (
                <div key={row.id} data-menu-row>
                  {row.node}
                </div>
              ))}
              {s.key === "app" && versionNode}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
