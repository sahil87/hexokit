import { useCallback, useState, useRef, useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { BreadcrumbDropdown } from "@/components/breadcrumb-dropdown";
import { LogoSpinner, useBrandLogoSweep } from "@/components/logo-spinner";
import { useChromeState, useChromeDispatch, TERMINAL_FONT_BOUNDS } from "@/contexts/chrome-context";
import { STAGE_COLUMN_GAP_PX, STAGE_PADDING_PX } from "@/components/shell/shell";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useToast } from "@/components/toast";
import { useUpdateClick } from "@/hooks/use-update-click";
import { useUpdateNotification } from "@/contexts/session-context";
import { updateChipToolSummary } from "@/lib/palette/update";
import { splitWindow, closePane } from "@/api/client";
import { useWindowRename } from "@/hooks/use-window-rename";
import { finalizeSafeName, toSafeWindowName } from "@/lib/names";
import { prefersReducedMotion } from "@/lib/motion";
import { isShell } from "@/lib/shell";
import { WaitingBadge } from "@/components/waiting-badge";
import { Tip, TipGroup } from "@/components/tip";
import { OpenButton, OpenMenuRows } from "@/components/open-button";
import { useOpenTargets } from "@/hooks/use-open-targets";
import { activePaneCwd, buildOpenTargets } from "@/lib/open-in-app";
import {
  TopBarOverflowMenu,
  HelpMenuRow,
  HelpTopicsMenuRow,
  KeyboardMenuRow,
  QuakeTerminalMenuRow,
  type OverflowMenuRow,
  type MenuGroup,
} from "@/components/top-bar-overflow-menu";
import { controlClass } from "@/components/control";
import {
  MENU_ROW_CHECK_MARK,
  MENU_ROW_KBD_CLASS,
  POPOVER_SHELL,
} from "@/components/controls";
import { GearIcon, HeadsetIcon } from "@/components/sidebar/icons";
import { useSettingsDialog } from "@/contexts/settings-dialog-context";
import {
  SplitVerticalGlyph,
  SplitHorizontalGlyph,
  ClosePaneGlyph,
  RefreshGlyph,
  FixedWidthGlyph,
  AutofitGlyph,
  TerminalFontGlyph,
} from "@/components/top-bar-icons";
import { LayoutChip, LayoutMenuRows } from "@/components/layout-chip";
import { QuakeLauncher } from "@/components/quake-launcher";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { computeVisibleCount, orderForFit } from "@/lib/top-bar-overflow";
import type { GuiPaletteAction } from "@/lib/palette/gui";
import type { GuiQuality } from "@/lib/gui-posture";
import { GuiToolbarMobileOverflow } from "@/components/gui-toolbar";
import { deriveCrumbsCollapsed } from "@/lib/crumb-collapse";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useOccludes } from "@/hooks/use-occludes";
import { formatCombo } from "@/lib/keybindings";
import type { Layout, SurfaceKind, TemplateName } from "@/lib/surface-layout";
import { applyTemplate, SURFACE_GLYPH, SURFACE_LABEL } from "@/lib/surface-layout";
import type { ProjectSession, WindowInfo } from "@/types";
import type { BreadcrumbDropdownItem } from "@/contexts/chrome-context";

export type TopBarMode = "terminal" | "board" | "server" | "host";

/**
 * A right-cluster control's registry entry (260715-h1ck). Order in the registry
 * array encodes drop priority (L1 → L2 → L3, leftmost-first within a tier). The
 * registry drives BOTH the bar (first N candidates → `barRender`) and the
 * overflow menu (the rest → `menuRender`) from one ordered source.
 *
 *  - `id`        — stable key + overflow identity.
 *  - `modes`     — the entry renders only when the current mode is listed.
 *  - `hidden`    — optional per-item opt-out: when true the entry renders
 *                  NOWHERE (not bar, not menu, not probe) — e.g. push
 *                  unsupported, no current window, no qualifying update.
 *  - `menuOnly`  — optional placement demotion (260722-n2n4): the entry NEVER
 *                  renders in-bar (not in the visible row, not in the
 *                  measurement probe, not in the fit computation — zero fit
 *                  pixels) while its `menuRender()` rows ALWAYS render in the
 *                  overflow menu, in registry order. `hidden` keeps its
 *                  "renders nowhere" priority over `menuOnly`.
 *  - `menuGroup` — the chevron-menu section this entry's rows render under
 *                  (260731-oiho: View / Window / App, fixed order) — the menu
 *                  partitions rows by group, preserving registry order within
 *                  each section.
 *  - `barRender` — the in-bar icon-button form (may return null).
 *  - `menuRender`— the labeled menu-row form (may return null; the update chip
 *                  returns null because its function merges into the version row).
 */
type RegistryEntry = {
  id: string;
  modes: TopBarMode[];
  hidden?: boolean;
  /** When true the entry NEVER renders in-bar (not in the visible row, not in
   *  the measurement probe, not in the fit computation) — its menuRender()
   *  rows ALWAYS render in the overflow menu (subject to `hidden`). */
  menuOnly?: boolean;
  /** When true the entry NEVER overflows (not in the measurement probe, not in
   *  the fit computation, not in the overflow menu) — it renders pinned in-bar
   *  and its measured width is RESERVED from the fit budget, like the trailing
   *  chevron block. The mobile surface-switch group uses this: it is the
   *  primary mobile tile-switch affordance, so other chips drop first. */
  pinned?: boolean;
  /** When true the entry is the LAST fit candidate to overflow, regardless of
   *  its bar position: the fit consumes the pyramid from its L1 head, but a
   *  `dropLast` entry is moved to the tail of the fit ORDER while keeping its
   *  registry slot in the bar. The desktop surface-toggle group uses this — it
   *  sits leftmost in the cluster yet is the cluster's most important control. */
  dropLast?: boolean;
  /** Chevron-menu section (260731-oiho) — Tiles / View / Window / App. */
  menuGroup: MenuGroup;
  barRender: () => ReactNode;
  menuRender: () => ReactNode;
};

type TopBarProps = {
  /**
   * Mode controls the breadcrumb / informational region and the center page
   * heading. The center cell carries a universal `PageType: name` heading in
   * EVERY mode (260704-pr0p); the left breadcrumb always ends at the PARENT
   * (move-don't-copy — the leaf is the centered heading, never duplicated):
   * - `terminal` (default, `/$server/$window`) — left: brand + hamburger +
   *   server link + session dropdown (ends at session). Center: `Terminal:
   *   <window>` editable heading + ▾ window switcher.
   * - `server` (`/$server` with no window, the tmux Server) — left: brand +
   *   hamburger (ends at the parent = home). Center: `tmux Server: <server>`
   *   display heading (the server leaf moved here from the left breadcrumb).
   * - `board` (`/board/$name`) — left: brand + hamburger + pane/server counts +
   *   cycle hint (the `Board ▸` home button is gone). Center: `Board: <board>`
   *   display heading + ▾ board switcher (moved from the left breadcrumb).
   * - `host` (`/`, the Server List home) — brand crumb ONLY (left). Center:
   *   the solo `Host` word. No hamburger
   *   (the Host page has no sidebar), no terminal-font control, no split/close
   *   buttons, no fixed-width button (terminal-only since 260704-9o7k). The L3
   *   always-block (Refresh · Settings gear, plus UpdateChip when qualifying)
   *   still renders; the connection dot left the bar for the sidebar footer in
   *   260724-6j1v (the Host page, having no sidebar, shows no dot).
   *   Session/server-dependent props are passed
   *   empty (`sessions=[]`, `currentSession=null`, `currentWindow=null`,
   *   `sessionName=""`, `server=""`, no-op callbacks) — the same tolerant-empty
   *   shape board mode already uses.
   */
  mode?: TopBarMode;
  sessions: ProjectSession[];
  currentSession: ProjectSession | null;
  currentWindow: WindowInfo | null;
  sessionName: string;
  windowName: string;
  sidebarOpen: boolean;
  server: string;
  onNavigate: (windowId: string) => void;
  onToggleSidebar: () => void;
  /** Terminal-mode surface-toggle group: the tile surfaces the current window
   *  offers (`tty` first) plus a mode discriminant — TOGGLE (desktop: the OPEN
   *  tiles + the shared toggle mutation — rendered as a bordered sub-group at
   *  the right cluster's L1 head, the retired right rail's toggles relocated)
   *  or SWITCH (mobile: the VISIBLE tile + the switch-to-tile verb — radio
   *  semantics, pinned in-bar, no overflow-menu rows). Absent → no group
   *  rendered. */
  surfaceToggles?:
    | {
        mode: "toggle";
        available: SurfaceKind[];
        open: SurfaceKind[];
        onToggle: (surface: SurfaceKind) => void;
        /** The size-floor add gate (replaces the retired 3-tile count cap):
         *  false ⇒ no further split fits the floor and the unlit buttons
         *  render disabled instead of no-oping silently. */
        canAdd: boolean;
        /** Per-surface "away" predicate: the surface's slot is live in
         *  another tab (the route window's `awayIn`) — the button carries an
         *  away marker. Absent → no markers (legacy). */
        away?: (surface: SurfaceKind) => boolean;
        /** Per-surface "popped" predicate: the surface's close-target leaf is
         *  popped out for this viewer — the button carries a popped marker
         *  (`surface-popped-<surface>`) and the `<Label> — popped out`
         *  tooltip. Absent → no markers (legacy). */
        popped?: (surface: SurfaceKind) => boolean;
        /** Per-surface corner-dot predicate (260821-zqlq): the dot means
         *  "has content" for web (`hasWebUrl`); every other surface stays
         *  always-on. Absent → the dot renders unconditionally (legacy). */
        showDot?: (surface: SurfaceKind) => boolean;
      }
    | {
        mode: "switch";
        available: SurfaceKind[];
        active: SurfaceKind;
        onSwitch: (surface: SurfaceKind) => void;
        /** Per-surface disabled predicate (switch mode): a not-open surface
         *  whose growth breaks the size floor renders disabled instead of
         *  no-oping silently — the toggle mode's canAdd affordance. */
        disabled?: (surface: SurfaceKind) => boolean;
        /** Same contract as the toggle-mode `showDot`. */
        showDot?: (surface: SurfaceKind) => boolean;
      };
  onCreateWindow: (session: string) => void;
  /** The gui header fold's mobile bottom rung: the `⚙` panel block pinned
   *  beside the mobile switch group, rendered only when switch mode shows the
   *  gui surface (the gate is at the render site). Carries the palette list
   *  the panel mirrors by row id and the `rk-gui-toolbar` open state. */
  guiToolbar?: {
    actions: GuiPaletteAction[];
    quality: GuiQuality;
    visible: boolean;
    onVisibleChange: (visible: boolean) => void;
  };
  /** Open the spawn-agent dialog for a session (260713-sbk1). When present, the
   *  terminal-mode window-switcher dropdown shows a `+ New Agent` item beside
   *  `+ New Tab`. Absent → no `+ New Agent` (e.g. before AppShell registers). */
  onSpawnAgent?: (session: string) => void;
  /** Board-mode metadata. Required when `mode === "board"`. */
  boardName?: string;
  paneCount?: number;
  serverCount?: number;
  /** Board-mode attention rollup (260706-y1ar): count of board panes whose
   *  joined window is `waiting`. Rendered as a yellow badge in the board-mode
   *  left info. Absent/0 → no badge. */
  waitingPaneCount?: number;
  /** Board-mode list of all boards (for the board switcher dropdown). */
  boards?: { name: string }[];
  /** Board-mode split/kill target (260715-6jwn): the focused tile's window.
   *  Feeds the merged top-bar SplitControl AND the Kill menu row (a
   *  consequence-gated Kill in board mode — co9z; menuOnly since 260731-oiho).
   *  `null` when the board is empty → the split is absent, the Kill row
   *  disabled. `cwd` seeds the split's working directory. */
  focusedPane?: { server: string; windowId: string; cwd?: string } | null;
  /** Board-mode kill request (co9z): when present, the board ✕ calls this to
   *  open `BoardPage`'s consequence-gated kill dialog instead of firing
   *  `closePane` directly, and the ✕ reads "Kill". The confirmed kill's
   *  self-heal refetch is owned by `BoardPage` (`executeKillWindow`'s
   *  `onSettled`). Absent → terminal-mode close-pane behavior. */
  onRequestKill?: () => void;
  /** Board-mode autofit state (738w) — reflected by the L2 toggle's
   *  `aria-pressed`. Wired from `board-page.tsx` via the slot context. */
  autofit?: boolean;
  /** Board-mode autofit setter (738w) — flips the same state the palette's
   *  `Board: Toggle Autofit` action flips. Absent → no toggle rendered. */
  onToggleAutofit?: () => void;
  /** Surface-layout machinery (260812-ab5v R9), registered by AppShell on the
   *  terminal route via the slot context: the RESOLVED layout + the shared
   *  user-mutation path (`applyLayout`). Feed the L1 ▦ Layout chip (template
   *  popover, current template marked, direct jump). Absent → no chip, no menu
   *  rows. */
  layout?: Layout;
  onApplyLayout?: (next: Layout) => void;
  /** While true (this viewer has a tile popped out) the ▦ template cycle
   *  renders disabled — chip, chord, and menu rows (spec surface-layout.md §
   *  Verbs → Pop out: a template resolved on the reduced render would drop
   *  the popped leaf from the shared layout). */
  layoutTemplatesDisabled?: boolean;
};

function HamburgerIcon({ isOpen }: { isOpen: boolean }) {
  // Notion-style sidebar pictogram: rounded-rect with an internal vertical
  // divider ~30% from the left. The left column fills when the sidebar is
  // open and empties when collapsed — same shape both states, only the fill
  // flips, so the icon's identity ("this is a sidebar toggle") never changes.
  const fillX = 2.5;
  const dividerX = 6.5;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Outer panel — rounded rectangle */}
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
      {/* Panel slot fill — the left edge column, filled
          when that area is visible. Uses fillOpacity to tone the fill down to
          a subtle wash rather than matching the stroke at full intensity. */}
      <rect
        x={fillX}
        y="3.5"
        width="4"
        height="11"
        rx="2"
        fill="currentColor"
        fillOpacity={isOpen ? 0.5 : 0}
        stroke="none"
        style={{ transition: "fill-opacity 150ms ease" }}
      />
      {/* Internal divider — separates the panel slot from the content area */}
      <line x1={dividerX} y1="3.5" x2={dividerX} y2="14.5" />
    </svg>
  );
}

/**
 * The sidebar column's head, painted OVER the top bar's left end while the
 * desktop sidebar is open: the brand anchor (home affordance) and the sidebar
 * toggle, aligned over the sidebar column below.
 *
 * Why paint over the bar rather than restructure the DOM: the top bar mounts
 * once in the persistent root layout above `<Shell>`, and Shell owns the
 * sidebar per route (drag-resize, zen override and the mobile drawer hang off
 * its stage), so a real root-grid column spanning the bar row would be a large
 * refactor. Since the header wash, the stage ground and the sidebar aside all
 * paint the same `bg-bg-chrome` material, an absolutely positioned head is
 * visually identical to that column — and the header's `border-b-[3px]` stays
 * on ONE full-width element, so the bottom seam reads as a single continuous
 * line (the head carries no border of its own). The illusion holds only while
 * those surfaces share the chrome material.
 *
 * `width` is the sidebar track plus the stage padding and column gap
 * (`STAGE_PADDING_PX` / `STAGE_COLUMN_GAP_PX`, imported from shell.tsx by the
 * caller), so the head's right edge lands exactly on the content column's
 * left edge.
 */
/** Minimum bar width the head must leave beside itself. The bar's own
 *  degradation (crumb collapse, the right cluster's overflow fit) was tuned
 *  for a bar at least as wide as the desktop breakpoint; below that the head
 *  yields and the classic bar returns, so the breadcrumb never spills into the
 *  centered heading. */
const HEAD_MIN_BAR_PX = 600;

function SidebarHead({
  width,
  onToggleSidebar,
  hamburgerOpen,
  brandSweep,
  toggleRef,
}: {
  width: number;
  onToggleSidebar: () => void;
  hamburgerOpen: boolean;
  brandSweep: ReturnType<typeof useBrandLogoSweep>;
  toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="absolute inset-y-0 left-0 flex items-center gap-2 pl-3 pr-3" style={{ width }}>
      <Tip label="Host">
        <a
          href="/"
          aria-label="HexoKit home"
          className="rk-brand-glitch flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
          onMouseEnter={brandSweep.onMouseEnter}
        >
          <LogoSpinner size={20} loading={false} svgRef={brandSweep.svgRef} />
          <span className="text-xs font-bold tracking-wide">HexoKit</span>
        </a>
      </Tip>
      <button
        ref={toggleRef}
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className={`ml-auto ${controlClass({ variant: "icon", rest: "border-border hover:border-text-secondary text-text-primary" })}`}
      >
        <HamburgerIcon isOpen={hamburgerOpen} />
      </button>
    </div>
  );
}

/**
 * Breadcrumb separator `›` (U+203A) — the established palette-label convention
 * (`<session> › <name>`), replacing the old `/` separator. Decorative, so it is
 * `aria-hidden`; the crumb hierarchy is conveyed by position and each crumb's
 * own role/`aria-current`.
 */
function BreadcrumbSeparator() {
  return (
    <span className="text-text-secondary select-none shrink-0" aria-hidden="true">
      {"›"}
    </span>
  );
}

/**
 * Crumb box — the bordered-chip styling shared by every breadcrumb crumb
 * (brand, server, session). The box is crumb STYLING, not a clickability cue:
 * the interactive link crumbs (brand, server) add hover treatment on top
 * (LINK_CRUMB_CLASS), while the session crumb (260813-kvk7) is a static chip —
 * a session has no route of its own, so it carries the box with NO hover
 * affordance, no pointer cursor, and no ▾.
 *
 * min-h normalizes every crumb to the shared control height (28px fine /
 * 40px coarse — the same box as the toggle + HistoryNav arrows) so the left
 * cluster sits on one horizontal axis; a content-height crumb is ~1px shorter
 * and centers 1px high of the fixed-height buttons. inline-flex makes the
 * min-h bite (height is inert on inline elements) — crumbs that truncate put
 * `truncate max-w-[16ch]` on an inner span, since text-overflow does not
 * apply to a flex container's anonymous text item.
 */
const CRUMB_BOX_CLASS =
  "inline-flex items-center min-h-[28px] coarse:min-h-[40px] rounded border border-border px-1.5 py-0.5 text-text-secondary"; // lockstep: --ctl-h-bar (fine) / --ctl-h-bar-coarse

/**
 * Link-crumb affordance — the box plus the always-visible "this navigates"
 * hover cue on the two link crumbs (brand, server), reusing the
 * right-cluster's bordered-button hover language.
 */
const LINK_CRUMB_CLASS =
  `${CRUMB_BOX_CLASS} hover:border-text-secondary hover:text-text-primary transition-colors`;

/**
 * Browser-history Back/Forward arrows (260714-uco1; relocated 260731-oiho).
 * Fixed-size ◀ ▶ buttons in the LEFT cluster, immediately right of the sidebar
 * toggle (macOS convention: sidebar toggle → back → forward → brand crumb; on
 * the Host page, which has no sidebar toggle, the pair leads the cluster before
 * the brand crumb). Rendered on ALL four page modes (history is global).
 * Semantics are BROWSER HISTORY via TanStack Router's `router.history.back()` /
 * `.forward()` — explicitly NOT previous/next sibling-window cycling.
 *
 * Forward is always-active (browser-chrome style): `canGoForward` is not
 * reliably exposed by browsers, so a dim/disabled forward state is best-effort
 * only and deliberately omitted — clicking forward with no forward entry is a
 * harmless no-op. The same two actions are reachable from the command palette
 * (`Go: Back` / `Go: Forward`, Constitution V; see lib/palette/nav.ts).
 *
 * Styling is the Control primitive's `icon` variant (the shared fixed-size
 * token, 260731-oiho). The
 * pair sits in its own `shrink-0` group so the arrows never collapse under
 * breadcrumb pressure. Moving the pair out of the anchored center box deleted
 * the old `mr-2.5`/`-mr-1` width-compensation hack — the heading box carries no
 * arrow furniture anymore.
 *
 * `hidden lg:flex`: the pair joins the left cluster's degradation ladder (the
 * server crumb already hides below `md`). Below `lg` the rigid left cluster
 * (toggle + arrows + the nav's `sm:min-w-[150px]` floor) exceeds its equal-`1fr`
 * side track against a 28ch-capped long-name heading (worst case needs ~832px),
 * and the overflowing nav would paint over the centered prefix — the exact
 * overlap class 260715-q8ey eliminated (see top-bar-overlap.spec.ts). Browser
 * back gestures and the palette's `Go: Back` / `Go: Forward` cover narrow
 * viewports.
 */
function HistoryNav() {
  const router = useRouter();
  const arrowClass = controlClass({ variant: "icon" });
  return (
    <span className="hidden lg:flex items-center gap-1 shrink-0">
      <Tip label="Back">
        <button
          type="button"
          onClick={() => router.history.back()}
          aria-label="Go back"
          className={arrowClass}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {/* chevron-left */}
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </Tip>
      <Tip label="Forward">
        <button
          type="button"
          onClick={() => router.history.forward()}
          aria-label="Go forward"
          className={arrowClass}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {/* chevron-right */}
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </Tip>
    </span>
  );
}

type SurfaceToggles = NonNullable<TopBarProps["surfaceToggles"]>;
/** The desktop toggle-mode arm — the menu rows exist only in that mode. */
type SurfaceTogglesToggle = Extract<SurfaceToggles, { mode: "toggle" }>;

/**
 * Surface-toggle group — the retired right rail's open-tile toggles relocated
 * into the right cluster as ONE bordered sub-group (with a trailing divider),
 * terminal route only. Two modes share the button grammar — one Tip-wrapped
 * button per available surface, in `availableTiles`' shortcut order (⌘1 tty /
 * ⌘2 code / ⌘3 web),
 * glyphs from `SURFACE_GLYPH`, LIT (`aria-pressed`, accent-green text on a
 * green wash), the corner dot driven by the
 * caller's per-surface `showDot` predicate (web = has-content; others
 * always-on), and the live-elsewhere markers: an away marker (amber ↩,
 * top-left) when the caller's `away` predicate says the surface's slot is
 * live in another tab, a popped marker (amber ↗, bottom-left) when the
 * caller's `popped` predicate says the surface's close-target leaf is popped
 * out for this viewer:
 *
 * - TOGGLE (desktop): lit = an open tile; while the caller's floor-derived
 *   `canAdd` is false the unlit buttons render DISABLED with a "No room for
 *   another tile" tooltip — except a POPPED surface, whose toggle reveals or
 *   hides the placeholder (never an add) and so stays actionable at the floor
 *   (Tip wraps a span so the disabled button still
 *   tips — disabled controls swallow pointer events). Clicking routes through
 *   the caller's shared `togglePanel` mutation semantics (unlit →
 *   `addSurface`, lit → `closeSurface`, closing the last tile is a null no-op
 *   there).
 * - SWITCH (mobile): RADIO semantics — lit = the VISIBLE tile (exactly one);
 *   tapping an unlit button runs the caller's switch-to-tile verb, tapping the
 *   lit one is a no-op. The floor-disabled state rides the caller's
 *   per-surface `disabled` predicate.
 *
 * Buttons are flush segments inside the group's neutral border. Non-first
 * segments carry a neutral divider, only the outer corners round, and the
 * wash-only latch changes no border geometry when state flips.
 */
function SurfaceToggleGroup({ toggles }: { toggles: SurfaceToggles }) {
  // The add gate is the per-viewport size floor (the caller's `canAdd`), no
  // longer a tile count. Toggle mode reads the shared flag; switch mode asks
  // the caller's per-surface predicate.
  const full = toggles.mode === "toggle" && !toggles.canAdd;
  const shown = toggles.available;
  return (
    <span data-testid="surface-toggles" className="flex items-center gap-1.5">
      <span
        className={`flex items-center rounded border border-border ${controlClass({ variant: "icon", box: "height", glint: false })}`}
      >
        {shown.map((surface, index) => {
          const pressed =
            toggles.mode === "toggle"
              ? toggles.open.includes(surface)
              : toggles.active === surface;
          const away =
            toggles.mode === "toggle" && (toggles.away?.(surface) ?? false);
          const popped =
            toggles.mode === "toggle" && (toggles.popped?.(surface) ?? false);
          // The floor gate exempts a popped surface: its toggle reveals/hides
          // the placeholder — it never adds a tile or writes the layout.
          const disabled =
            !pressed &&
            !popped &&
            (toggles.mode === "toggle"
              ? full
              : (toggles.disabled?.(surface) ?? false));
          const label = SURFACE_LABEL[surface];
          return (
            <Tip
              key={surface}
              label={
                disabled
                  ? "No room for another tile"
                  : popped
                    ? `${label} — popped out`
                    : away
                      ? `${label} — in another tab`
                      : label
              }
            >
              {/* The span wrapper keeps the tooltip alive on the DISABLED button
                  (disabled controls swallow the pointer events Tip listens for). */}
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={() => {
                    if (toggles.mode === "toggle") {
                      toggles.onToggle(surface);
                    } else if (!pressed) {
                      toggles.onSwitch(surface);
                    }
                  }}
                  disabled={disabled}
                  aria-pressed={pressed}
                  aria-label={`${label} tile`}
                  className={`rk-glint relative w-[26px] flex items-center justify-center text-[11px] font-mono transition-colors focus-visible:outline-2 focus-visible:outline-accent-green disabled:opacity-40 disabled:cursor-not-allowed ${index > 0 ? "border-l border-border" : ""} ${index === 0 ? "rounded-l-[3px]" : ""} ${index === shown.length - 1 ? "rounded-r-[3px]" : ""} ${controlClass({ variant: "segment", flush: true, pressed, rest: "text-text-secondary hover:text-text-primary" })}`}
                >
                  <span aria-hidden="true">{SURFACE_GLYPH[surface]}</span>
                  {/* Away marker: the surface's slot is live in another tab.
                      The corner dot's top-right stays the content channel. */}
                  {away && (
                    <span
                      aria-hidden="true"
                      data-testid={`surface-away-${surface}`}
                      className="absolute top-0 left-0.5 text-[9px] leading-none text-signal-yellow"
                    >
                      ↩
                    </span>
                  )}
                  {/* Popped marker: the surface's close-target leaf is popped
                      out for this viewer (the away marker's bottom-left
                      sibling corner). */}
                  {popped && (
                    <span
                      aria-hidden="true"
                      data-testid={`surface-popped-${surface}`}
                      className="absolute bottom-0 left-0.5 text-[9px] leading-none text-signal-yellow"
                    >
                      ↗
                    </span>
                  )}
                  {/* Availability/content dot — a collapsed tile may hide
                      content, never state that wants a human. The caller's
                      per-surface predicate decides (web = hasWebUrl, others
                      always-on); absent, the dot renders unconditionally. */}
                  {(toggles.showDot?.(surface) ?? true) && (
                    <span
                      aria-hidden="true"
                      className="absolute top-0.5 right-0.5 w-1 h-1 rounded-full bg-accent-green"
                    />
                  )}
                </button>
              </span>
            </Tip>
          );
        })}
      </span>
      <span aria-hidden="true" className="w-px h-4 bg-border" />
    </span>
  );
}

/**
 * The group's overflow-menu form (Tiles section): one `menuitemcheckbox` row
 * per shown surface — checked = tile open (the one checked treatment: primary
 * ink + trailing green ✓ on `aria-checked`), leading `SURFACE_GLYPH` glyph (the
 * leading-glyph parity rule), a muted "away"/"popped" suffix when the caller
 * marks the surface away/popped, floor-disabled like the bar buttons (with
 * the same popped-surface exemption). Clicking
 * a row runs the same shared toggle mutation as the bar group.
 */
function SurfaceToggleMenuRows({ toggles }: { toggles: SurfaceTogglesToggle }) {
  const full = !toggles.canAdd;
  const shown = toggles.available;
  return (
    <>
      {shown.map((surface) => {
        const isOpen = toggles.open.includes(surface);
        const away = toggles.away?.(surface) ?? false;
        const popped = toggles.popped?.(surface) ?? false;
        // The floor gate exempts a popped surface — its toggle reveals/hides
        // the placeholder, never an add.
        const disabled = !isOpen && full && !popped;
        return (
          <button
            key={surface}
            type="button"
            role="menuitemcheckbox"
            tabIndex={-1}
            aria-checked={isOpen}
            disabled={disabled}
            aria-label={`${SURFACE_LABEL[surface]} tile`}
            onClick={() => toggles.onToggle(surface)}
            className={controlClass({ variant: "menu-row", pressed: isOpen })}
          >
            <span aria-hidden="true" className="font-mono text-[11px]">
              {SURFACE_GLYPH[surface]}
            </span>
            <span className="flex-1">{`${SURFACE_LABEL[surface]} tile`}</span>
            {away && (
              <span
                data-testid={`surface-away-${surface}`}
                className="text-[10px] text-signal-yellow"
              >
                away
              </span>
            )}
            {popped && (
              <span
                data-testid={`surface-popped-${surface}`}
                className="text-[10px] text-signal-yellow"
              >
                popped
              </span>
            )}
            {isOpen && (
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

export function TopBar({
  mode = "terminal",
  currentSession,
  currentWindow,
  sessionName,
  windowName,
  sidebarOpen,
  server,
  onNavigate,
  onToggleSidebar,
  surfaceToggles,
  guiToolbar,
  onCreateWindow,
  onSpawnAgent,
  boardName,
  paneCount,
  serverCount,
  waitingPaneCount,
  boards,
  focusedPane,
  onRequestKill,
  autofit,
  onToggleAutofit,
  layout,
  onApplyLayout,
  layoutTemplatesDisabled = false,
}: TopBarProps) {
  // The ▦ chip emits a template NAME; the jump rebuilds the template's tree
  // from the current slot order and rides the one mutation path (R16/R3).
  const applyLayoutTemplate = useCallback(
    (name: TemplateName) => {
      if (!layout || !onApplyLayout) return;
      const next = applyTemplate(layout, name);
      if (next) onApplyLayout(next);
    },
    [layout, onApplyLayout],
  );
  // `showChip` tells us whether the UpdateChip WOULD render in the bar (a
  // qualifying, undismissed, non-dev update). When it does but the chip's
  // registry entry is overflowed into the menu, the version row becomes the
  // update surface and the chevron shows an attention badge (change areas 2–3).
  const { showChip, key: updateKey } = useUpdateNotification();
  const isMobile = useIsMobile();
  // The center heading never yields its cell to the quake launcher: the
  // launcher stands beside the compact heading at rest and collapses to its
  // glyph + chord while the drawer is open — at every width, on every mode.

  // Brand-crumb logo hover: the white glow "detach, orbit, land" sweep over
  // the ring segments (JS-driven, logo-spinner.tsx). Triggered from the whole
  // anchor so hovering the wordmark also plays it, like the glitch.
  const brandSweep = useBrandLogoSweep();

  // Breadcrumb hrefs use the 2-segment route shape /$server/$window — the
  // window id (@N) is the only identity in the URL. Selecting a window jumps
  // to it directly; the owning session is derived from the snapshot.
  const windowItems: BreadcrumbDropdownItem[] = (currentSession?.windows ?? []).map(
    (w) => ({
      label: w.name,
      href: `/${encodeURIComponent(server)}/${encodeURIComponent(w.windowId)}`,
      current: currentWindow ? w.windowId === currentWindow.windowId : false,
      ...(w.role === "operator" ? { icon: <HeadsetIcon /> } : {}),
    }),
  );

  const handleDropdownNavigate = useCallback(
    (href: string) => {
      // Parse href "/server/windowId" — the window segment is the tmux window
      // ID (@N), a string (no numeric coercion). Identity is window-id only.
      const parts = href.replace(/^\//, "").split("/");
      if (parts.length >= 2) {
        const windowId = decodeURIComponent(parts[1]);
        if (windowId) {
          onNavigate(windowId);
        }
      }
    },
    [onNavigate],
  );

  // Hamburger animation is driven by `sidebarOpen` alone — both desktop
  // (grid column) and mobile (overlay) collapse to the same boolean state.
  const hamburgerOpen = sidebarOpen;

  // The Host page (`/`) has no sidebar, so it renders no hamburger. Every other mode
  // (terminal / server / board) has a Shell sidebar and shows the toggle.
  const hasSidebar = mode !== "host";
  const { sidebarWidth } = useChromeState();
  // The sidebar head covers the stage's sidebar track plus the stage padding
  // and column gap, so its right edge lands on the content column's left edge.
  // The numbers come from Shell's exported stage constants — the head and the
  // stage cannot drift apart. Zen mode hides the whole bar upstream, so a
  // zen-hidden sidebar with the preference still `open` never draws a head.
  // The head is a layout decision, not just a color one: it takes its width
  // out of the bar, and the bar's breakpoint-gated content (history arrows,
  // crumb floors, the heading anchor) is sized for the VIEWPORT, not for what
  // is left of the bar. So the head shows only while the bar keeps at least
  // HEAD_MIN_BAR_PX beside it; narrower, the bar reclaims its full width and
  // the toggle and brand return to the left cluster.
  const headTrack = sidebarWidth + STAGE_PADDING_PX + STAGE_COLUMN_GAP_PX;
  const barKeepsRoom = useMediaQuery(`(min-width: ${headTrack + HEAD_MIN_BAR_PX}px)`);
  const sidebarHeadWidth = !isMobile && hasSidebar && sidebarOpen && barKeepsRoom ? headTrack : 0;
  const headShown = sidebarHeadWidth > 0;

  // Focus handoff across the toggle's node swap: the head's toggle and the
  // cluster's toggle are different buttons, and clicking either one unmounts
  // it (the head appears/disappears with the sidebar), so focus would fall
  // to the document body. The click records the replacement node; the effect
  // focuses it once the swap commits. On mobile the head never shows and the
  // cluster toggle stays mounted — no swap, no handoff.
  const headToggleRef = useRef<HTMLButtonElement>(null);
  const clusterToggleRef = useRef<HTMLButtonElement>(null);
  const toggleFocusTargetRef = useRef<"head" | "cluster" | null>(null);
  const handleHeadToggle = () => {
    toggleFocusTargetRef.current = "cluster";
    onToggleSidebar();
  };
  const handleClusterToggle = () => {
    if (!isMobile) toggleFocusTargetRef.current = "head";
    onToggleSidebar();
  };
  useLayoutEffect(() => {
    const target = toggleFocusTargetRef.current;
    toggleFocusTargetRef.current = null;
    if (!target) return;
    (target === "head" ? headToggleRef : clusterToggleRef).current?.focus();
  }, [headShown]);

  // Move-don't-copy (260704-pr0p): the left breadcrumb always ends at the
  // PARENT; the current-page leaf is the centered heading. So the server crumb
  // renders in the left nav ONLY as a link back to the tmux Server on the
  // terminal route (parent = the tmux Server) — on the server route the server name is
  // the leaf and moves to the center heading, leaving the left breadcrumb at
  // brand + hamburger. The Host page and board have no left server crumb.
  const showServerCrumb = mode === "terminal" && !!server;
  // The `›` before the first crumb belongs to the brand root crumb; with the
  // brand in the sidebar head the nav's first crumb has nothing to its left.
  const rootSeparator = !headShown;
  // The session crumb follows the server crumb when there is one, else it is
  // the nav's first crumb.
  const sessionSeparator = showServerCrumb || rootSeparator;
  const serverHref = `/${encodeURIComponent(server)}`;
  const navigate = useNavigate();

  // Crumb collapse rung — the degradation-ladder step BETWEEN truncation and
  // the breakpoint hides: when the server+session crumbs would truncate below
  // their minimum useful width (6ch of content, lib/crumb-collapse.ts), both
  // collapse into a single `… ▾` crumb (one BreadcrumbDropdown carrying both
  // levels). The measurement mirrors the right cell's fit machinery: a
  // ResizeObserver + a hidden probe row rendering the crumbs' min-useful form
  // (real text at `max-w-[6ch]`), so the threshold is measured from the real
  // names, never hardcoded. The crumbs' section wrapper is `flex-1 min-w-0`
  // (below) so its clientWidth IS the available space in BOTH states — a
  // content-sized wrapper would shrink to the tiny collapsed trigger and lose
  // the expand-back signal. deriveCrumbsCollapsed owns the decision, incl. the
  // expand-edge hysteresis that stops boundary flapping.
  const crumbSectionRef = useRef<HTMLDivElement>(null);
  const crumbProbeRef = useRef<HTMLDivElement>(null);
  const [crumbsCollapsed, setCrumbsCollapsed] = useState(false);
  const hasCollapsibleCrumbs = mode !== "board" && (showServerCrumb || !!sessionName);

  useLayoutEffect(() => {
    const section = crumbSectionRef.current;
    const probe = crumbProbeRef.current;
    if (!section || !probe) return;
    const measure = () => {
      setCrumbsCollapsed((prev) =>
        deriveCrumbsCollapsed(section.clientWidth, probe.scrollWidth, prev),
      );
    };
    measure();
    // Observe BOTH: the section tracks the available space (grid-driven), the
    // probe tracks the threshold (name-length-driven) — a rename can change
    // the required width without resizing the section.
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    ro.observe(probe);
    return () => ro.disconnect();
  }, [hasCollapsibleCrumbs, mode, server, sessionName]);

  // The collapsed crumb's two levels: the server (link crumb, → its tmux
  // Server route) and the session (a static chip when expanded — it has no
  // route of its own — so in the menu it points at the current window's
  // route, marked current). No `+ New Session` action: session creation
  // lives in the palette (`Session: Create`) and the sidebar server-header
  // `+`, not the top bar.
  const collapsedCrumbItems: BreadcrumbDropdownItem[] = [];
  if (hasCollapsibleCrumbs) {
    if (showServerCrumb) {
      collapsedCrumbItems.push({ label: server, href: serverHref });
    }
    if (sessionName) {
      collapsedCrumbItems.push({
        label: sessionName,
        href: currentWindow
          ? `/${encodeURIComponent(server)}/${encodeURIComponent(currentWindow.windowId)}`
          : serverHref,
        current: true,
      });
    }
  }

  // Collapsed-menu navigation: 2-segment hrefs are window routes and ride the
  // existing same-session seam; the 1-segment server href navigates SPA-side.
  const handleCollapsedNavigate = useCallback(
    (href: string) => {
      const parts = href.replace(/^\//, "").split("/");
      if (parts.length >= 2 && parts[1]) {
        handleDropdownNavigate(href);
        return;
      }
      navigate({ to: "/$server", params: { server: decodeURIComponent(parts[0]) } });
    },
    [handleDropdownNavigate, navigate],
  );

  // Open-in-App data (260722-6d0f): sshHost/sshUser + host-app registry,
  // fetched once per page load via the module-cached hook (enabled only where
  // the control can render — the Terminal route). The target list composes
  // the local/remote branch + deeplink-host resolution chain (the ssh_host
  // setting verbatim, else derived `user@location.hostname` when remote — 260722-fc3b)
  // + section-visibility rules in `lib/open-in-app.ts`; the folder is the
  // current window's active-pane cwd. Zero targets (local + empty registry,
  // or a pathless window) hides the entry entirely.
  const openCtx = useOpenTargets(mode === "terminal");
  const openPath = mode === "terminal" ? activePaneCwd(currentWindow) : "";
  const openTargets =
    mode === "terminal"
      ? buildOpenTargets({
          hostname: window.location.hostname,
          sshHost: openCtx.sshHost,
          sshUser: openCtx.sshUser,
          hostApps: openCtx.hostApps,
          path: openPath,
        })
      : [];

  // ── Right-cluster overflow registry (260715-h1ck) ──────────────────────────
  //
  // The ordered registry replaces the hardcoded right-cluster JSX. It is the
  // SINGLE source that drives both the bar (first N candidates render as icon
  // buttons) and the overflow menu (the rest render as rows) — so bar↔menu can
  // never drift. Order encodes drop priority: L1 first, then L2, then L3, and
  // within a tier leftmost drops first (overflow consumes FROM THE FRONT). Only
  // the trailing chevron and `pinned` entries are EXEMPT (never overflow) and
  // render outside the fit candidate list. As of 260731-oiho THREE entries are `menuOnly` (the n2n4
  // mechanism — never in-bar, rows always in the menu): the demoted
  // fixed-width, terminal-font (Aa), and
  // close-pane/Kill (sticky per-device preferences + the destructive ✕ that
  // sat one slot from Refresh). The terminal-mode bar end state is
  // surface toggles · Open · ▦ Layout · Refresh · Gear · chevron (+ UpdateChip when a qualifying
  // update exists) — the split chip demoted to `menuOnly` in terminal mode in
  // 260813-w1lf (pane verbs moved to the tty tile header). Each entry gates on `modes` (the current mode must be listed) and
  // an optional `hidden` predicate (renders nowhere); `menuGroup` names its
  // chevron-menu section (Tiles / View / Window / App).
  // Board-mode split/close target (260715-6jwn, merged into the registry): the
  // merged SplitControl AND the Kill row act on the focused tile's window
  // (`focusedPane`, wired from board-page.tsx). Unpin lives on the tile header
  // + the `Board: Unpin Focused Pane` palette action. The split is absent when
  // the board is empty (no `focusedPane`); the Kill row is disabled then.
  const rightItems: RegistryEntry[] = [
    // Surface-toggle group — terminal-only, at the registry's L1 HEAD
    // (leftmost in the bar) but `dropLast`: it is the cluster's most
    // important control, so it overflows only after every other fit
    // candidate has. The retired right rail's open-tile toggles relocated as
    // ONE bordered sub-group. One entry (not
    // three) so the probe measures the whole group once and the bar/menu
    // renderings share one slot-data source. Overflowed, it renders one
    // checkbox row per shown surface under the Tiles menu section. Hidden
    // until AppShell registers the slot (or off the window route).
    //
    // Mobile (switch mode) inverts both rules: the group is the primary
    // mobile tile-switch affordance, so it is PINNED in-bar (exempt from the
    // fit pipeline — other chips drop first) and registers NO menu rows (the
    // add-a-tile checkbox path never exists on mobile — switch mode's
    // SurfaceToggleMenuRows absence is deliberate, not an omission).
    {
      id: "surface-toggles",
      modes: ["terminal"],
      menuGroup: "tiles",
      hidden: !(mode === "terminal" && currentWindow && surfaceToggles),
      pinned: surfaceToggles?.mode === "switch",
      dropLast: true,
      barRender: () =>
        surfaceToggles ? <SurfaceToggleGroup toggles={surfaceToggles} /> : null,
      menuRender: () =>
        surfaceToggles?.mode === "toggle" ? (
          <SurfaceToggleMenuRows toggles={surfaceToggles} />
        ) : null,
    },
    // Open-in-App split-button (260722-6d0f) — terminal-only, immediately
    // after the surface-toggles head so it yields to overflow BEFORE any other
    // L1 (keeping the documented L1→L2→L3 pyramid sweep intact). Hidden
    // when the window is absent or zero targets are available (no sshHost +
    // empty host registry — the common default deployment). When overflowed it
    // renders per-target `Open: …` rows (OpenMenuRows).
    {
      id: "open",
      modes: ["terminal"],
      menuGroup: "window",
      hidden: !(mode === "terminal" && currentWindow && openTargets.length > 0),
      barRender: () => <OpenButton targets={openTargets} server={server} path={openPath} />,
      menuRender: () => <OpenMenuRows targets={openTargets} server={server} path={openPath} />,
    },
    // L1 — the ONE merged split control (terminal+board, 260731-oiho): the two
    // per-direction SplitButtons collapsed into a single split-button chip —
    // primary click = split horizontal (side-by-side, the default), a small ▾
    // affordance opens the direction menu (the OpenButton pattern). The
    // overflow menu keeps BOTH directions as one-action-per-row rows,
    // default (horizontal) first.
    // Terminal mode demotes it to `menuOnly` (260813-w1lf): pane verbs moved
    // to the tty tile header's pane segment, so the split chip no longer
    // renders in the bar in terminal mode — the menu rows stay as the mobile
    // path + fallback. Board mode
    // keeps the in-bar SplitControl untouched (dynamic flag, the n2n4
    // revert-by-flag mechanism).
    {
      id: "split",
      modes: ["terminal", "board"],
      menuGroup: "window",
      hidden: mode === "board" ? !focusedPane : !currentWindow,
      menuOnly: mode === "terminal",
      barRender: () =>
        mode === "board" ? (
          focusedPane ? (
            <SplitControl server={focusedPane.server} windowId={focusedPane.windowId} cwd={focusedPane.cwd} />
          ) : null
        ) : currentWindow ? (
          <SplitControl server={server} windowId={currentWindow.windowId} cwd={currentWindow.worktreePath} />
        ) : null,
      menuRender: () =>
        mode === "board" ? (
          focusedPane ? (
            <>
              <SplitMenuRow horizontal server={focusedPane.server} windowId={focusedPane.windowId} cwd={focusedPane.cwd} />
              <SplitMenuRow server={focusedPane.server} windowId={focusedPane.windowId} cwd={focusedPane.cwd} />
            </>
          ) : null
        ) : currentWindow ? (
          <>
            <SplitMenuRow horizontal server={server} windowId={currentWindow.windowId} cwd={currentWindow.worktreePath} />
            <SplitMenuRow server={server} windowId={currentWindow.windowId} cwd={currentWindow.worktreePath} />
          </>
        ) : null,
    },
    // ▦ Layout chip (260812-ab5v R9) — terminal-only, L1 tier: click opens a
    // popover of the template glyphs for the CURRENT tile count (current
    // marked, direct jump via `applyTemplate` → `onApplyLayout`); the template
    // cycle chord is the registry's `layout-cycle` binding with palette parity
    // (`Layout: Cycle Template`). Overflowed, its rows are one `Layout: …`
    // radio row per template (LayoutMenuRows). Hidden until AppShell registers
    // the layout slot (or off the window route).
    {
      id: "layout",
      modes: ["terminal"],
      menuGroup: "view",
      hidden: !(mode === "terminal" && currentWindow && layout && onApplyLayout),
      barRender: () =>
        layout && onApplyLayout ? (
          <LayoutChip layout={layout} onApply={applyLayoutTemplate} disabled={layoutTemplatesDisabled} />
        ) : null,
      menuRender: () =>
        layout && onApplyLayout ? (
          <LayoutMenuRows layout={layout} onApply={applyLayoutTemplate} disabled={layoutTemplatesDisabled} />
        ) : null,
    },
    // Fixed-width toggle — MENU-ONLY as of 260731-oiho: a sticky per-device
    // preference doesn't earn a permanent bar slot. The in-bar toggle form was
    // deleted (260814-6b0j); the menu row is the only rendering. Palette
    // parity: `View: Fixed Width (900px)` / `View: Full Width`.
    {
      id: "fixed-width",
      modes: ["terminal"],
      menuOnly: true,
      menuGroup: "view",
      hidden: !currentWindow,
      barRender: () => null,
      menuRender: () => <FixedWidthMenuRow />,
    },
    // Terminal-font — MENU-ONLY as of 260731-oiho (sticky per-device
    // preference; also lives in the settings dialog and the palette's
    // `Increase/Decrease/Reset terminal font`). The in-bar Aa popover form —
    // the reset stepper's last chrome home — was deleted (260814-6b0j); reset
    // stays reachable via the palette and the settings dialog.
    {
      id: "terminal-font",
      modes: ["terminal", "board"],
      menuOnly: true,
      menuGroup: "view",
      barRender: () => null,
      menuRender: () => <TerminalFontMenuRow />,
    },
    // Board-only autofit — stays IN-BAR (the one board L2 survivor; it is a
    // per-board working control, not a sticky device preference).
    {
      id: "autofit",
      modes: ["board"],
      menuGroup: "view",
      hidden: !(mode === "board" && !!onToggleAutofit),
      barRender: () => <BoardAutofitToggle autofit={autofit ?? false} onToggle={onToggleAutofit ?? (() => {})} />,
      menuRender: () => <AutofitMenuRow autofit={autofit ?? false} onToggle={onToggleAutofit ?? (() => {})} />,
    },
    {
      // Close-pane / Kill ✕ — MENU-ONLY as of 260731-oiho: a destructive
      // control sat one bar slot from Refresh (misclick trap), so it lives in
      // the chevron menu now (plus the palette's `Pane: Close` / the board
      // kill entries). Terminal mode kills the current window's active pane
      // (immediate close-pane). Board mode (co9z) is a consequence-gated KILL:
      // the row reads "Kill" and, via `onRequestKill`, opens BoardPage's confirm
      // dialog (with an `Unpin instead` escape) instead of firing immediately —
      // a board Kill destroys the window everywhere, not just the board pane. The
      // confirmed kill's self-heal refetch is owned by BoardPage
      // (`executeKillWindow`'s `onSettled`), not signalled back through the row.
      // Disabled on board when there is no focused tile.
      id: "close-pane",
      modes: ["terminal", "board"],
      menuOnly: true,
      menuGroup: "window",
      hidden: mode === "terminal" && !currentWindow,
      barRender: () => null,
      menuRender: () =>
        mode === "board" ? (
          <ClosePaneMenuRow
            server={focusedPane?.server ?? ""}
            windowId={focusedPane?.windowId ?? ""}
            disabled={!focusedPane}
            onRequestKill={onRequestKill}
            label="Kill"
          />
        ) : currentWindow ? (
          <ClosePaneMenuRow server={server} windowId={currentWindow.windowId} label="Close pane" />
        ) : null,
    },
    // L3 — always (all four modes): update chip · refresh · settings gear
    // (260812-d1at — the gear relocated here from the sidebar footer; Help,
    // Keyboard, and Theme moved with it but are `menuOnly` App-section rows
    // below). The notification bell folded into the settings dialog in
    // 260724-6j1v and stays there.
    // The UpdateChip has NO menu row: when overflowed, its function merges into
    // the version row (the menu component owns that — including the dismissed-
    // pending update surface and the resting version + ⟳ check affordance,
    // 260720-ml7k). `hidden` keeps it out of the candidate set entirely when it
    // wouldn't render (not qualifying / dev / dismissed) so it never reserves
    // width or an empty slot. The chip IS the unified update button's promoted
    // form; promotion/demotion is pure derivation from `showChip` + fit — never
    // imperative movement.
    {
      id: "update-chip",
      modes: ["terminal", "board", "server", "host"],
      menuGroup: "app",
      hidden: !showChip,
      barRender: () => <UpdateChip />,
      menuRender: () => null,
    },
    {
      id: "refresh",
      modes: ["terminal", "board", "server", "host"],
      menuGroup: "app",
      barRender: () => <RefreshButton />,
      menuRender: () => <RefreshMenuRow />,
    },
    // Settings gear (260812-d1at) — relocated from the sidebar footer to the
    // right cluster on ALL modes (app-global chrome, not a terminal control).
    // The LAST fit candidate (L3 tail): it survives longest in-bar and, when
    // the cluster can't fit it, degrades to the Settings menu row — never
    // shrinks or clips. Order in the bar: … · Refresh · Gear · chevron ▾.
    {
      id: "settings",
      modes: ["terminal", "board", "server", "host"],
      menuGroup: "app",
      barRender: () => <SettingsGearButton />,
      menuRender: () => <SettingsMenuRow />,
    },
    // Help / Keyboard / Theme (260812-d1at) — the sidebar footer's other three
    // actions, relocated to the chevron menu's App section. MENU-ONLY: they
    // never render in-bar (not in the visible row, not in the probe, zero fit
    // pixels); their rows ALWAYS render in the menu, above the fixed version
    // row (which rides the App section's tail). Theme click-cycling is
    // retired — the row opens the theme selector.
    {
      id: "help",
      modes: ["terminal", "board", "server", "host"],
      menuOnly: true,
      menuGroup: "app",
      barRender: () => null,
      menuRender: () => <HelpMenuRow />,
    },
    // Help topics — the curated docs pages, expanded inline under the Help
    // row. `external` is true off the terminal route: no window owns a web
    // tile there, so a topic opens a browser tab and the rows show ↗.
    {
      id: "help-topics",
      modes: ["terminal", "board", "server", "host"],
      menuOnly: true,
      menuGroup: "app",
      barRender: () => null,
      menuRender: () => <HelpTopicsMenuRow external={mode !== "terminal"} />,
    },
    {
      id: "keyboard",
      modes: ["terminal", "board", "server", "host"],
      menuOnly: true,
      menuGroup: "app",
      barRender: () => null,
      menuRender: () => <KeyboardMenuRow />,
    },
    // Quake terminal — the mobile path to the pull-down operator overlay
    // (a phone has no keyboard for the chord; the palette carries desktop).
    // MENU-ONLY on every mode, in the App section with Help/Keyboard.
    {
      id: "quake-terminal",
      modes: ["terminal", "board", "server", "host"],
      menuOnly: true,
      menuGroup: "app",
      barRender: () => null,
      menuRender: () => <QuakeTerminalMenuRow />,
    },
  ];

  // Candidate (non-exempt) entries for the current mode, minus any `hidden` ones.
  const candidates = rightItems.filter((e) => e.modes.includes(mode) && !e.hidden);
  // Pinned entries (the mobile surface-switch group) never overflow: they
  // render in-bar unconditionally, OUTSIDE the fit system — not in the probe,
  // not a fit candidate, not in the overflow menu. Their measured width is
  // reserved from the fit budget below (the trailing-chevron precedent), so
  // the OTHER candidates absorb the squeeze.
  const pinnedItems = candidates.filter((e) => e.pinned);
  // Fit candidates — the entries eligible for IN-BAR placement. `menuOnly`
  // entries (260731-oiho: fixed-width,
  // terminal-font, close-pane) never render in-bar: they are excluded from the
  // visible row, the measurement probe, and the fit budget (zero pixels). The
  // probe's children must stay index-aligned with the widths array the fit
  // reads, so the probe renders exactly this list.
  const fitCandidates = candidates.filter((e) => !e.menuOnly && !e.pinned);
  // Fit ORDER: the pyramid (registry order) with `dropLast` entries moved to
  // the tail, so they are the last to overflow. Bar RENDER order stays the
  // registry order — a `dropLast` entry keeps its screen slot. The probe
  // renders in fit order so its measured widths stay index-aligned with what
  // `computeVisibleCount` consumes.
  const fitOrder = orderForFit(fitCandidates);

  // Measurement: one ResizeObserver on the right cell + a hidden probe row that
  // renders every FIT candidate's BAR form so we always know each real width
  // (buttons vary — UpdateChip label, coarse sizing — so nothing is hardcoded).
  // `computeVisibleCount` decides how many leading fit candidates fit after
  // reserving the trailing exempt block (chevron + dot + gap). `menuOnly`
  // entries are not probed or fitted (260722-n2n4) — they live in the menu.
  // Collapse-first: `visibleCount` starts at 0 and is set in a layout effect
  // before paint, so no flash of overflowing buttons is shown.
  const rightCellRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  // Exempt-block ref whose measured width is RESERVED before fitting candidates:
  // the trailing chevron block (always present; the connection dot moved to the
  // sidebar footer, 260724-6j1v). Nothing is hardcoded — every reserved pixel
  // is measured.
  const trailingRef = useRef<HTMLDivElement>(null);
  // Pinned-block ref whose measured width is likewise RESERVED before fitting
  // (the mobile surface-switch group — pinned in-bar, never overflowed).
  const pinnedRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  // Serialize the FIT-candidate ids into a dependency key so the measure effect
  // re-runs when the probed SET changes (mode switch, a control appearing/
  // disappearing) — not on every render. `menuOnly` entries never affect the
  // fit, so they are deliberately absent from this key; the PINNED set rides
  // along (a pinned entry appearing/disappearing changes the reserved width).
  const candidateKey =
    fitOrder.map((c) => c.id).join(",") + "|" + pinnedItems.map((c) => c.id).join(",");

  useLayoutEffect(() => {
    const cell = rightCellRef.current;
    const probe = probeRef.current;
    if (!cell || !probe) return;

    const RIGHT_GAP_PX = 12; // the cluster's `gap-3` (0.75rem)

    const measure = () => {
      const available = cell.clientWidth;
      // Reserve the exempt width (measured): the trailing chevron block,
      // joined to the candidate run by one gap, plus any pinned block (the
      // mobile surface-switch group) with its own gap when present.
      const trailing = trailingRef.current?.offsetWidth ?? 0;
      const pinned = pinnedRef.current?.offsetWidth ?? 0;
      const reserved =
        trailing +
        RIGHT_GAP_PX + // gap between the last candidate and the chevron block
        (pinned > 0 ? pinned + RIGHT_GAP_PX : 0); // pinned block + its gap
      // Overflow consumes the pyramid FROM THE LEFT (L1 drops first, L3 last —
      // the documented invariant). In the bar L1 is leftmost and L3 is pinned
      // rightmost, so the SURVIVING in-bar set is a SUFFIX of the registry
      // order. Reverse the widths (L3-end first) so `computeVisibleCount` greedily
      // fits from the tail; the returned N is how many trailing candidates fit.
      const widths = Array.from(probe.children).map((c) => (c as HTMLElement).offsetWidth);
      const reversed = [...widths].reverse();
      const n = computeVisibleCount(available, reversed, reserved, RIGHT_GAP_PX);
      setVisibleCount(n);
    };

    measure();
    // Observe the cell AND the probe/trailing nodes (review S2): a candidate's
    // own width can change (e.g. the UpdateChip's label width when the matched
    // set — hence the composite `updateKey` — changes) without resizing the
    // OUTER cell (its width is grid-determined). Observing the probe (which
    // renders every fit candidate's bar form) + the trailing chevron/dot block
    // re-fits on any of those. The `updateKey`/`showChip` deps additionally
    // re-run the whole effect when the candidate set or membership changes.
    // The trailing block (chevron) is observed
    // too so a chevron size change re-fits.
    const ro = new ResizeObserver(measure);
    ro.observe(cell);
    ro.observe(probe);
    if (trailingRef.current) ro.observe(trailingRef.current);
    if (pinnedRef.current) ro.observe(pinnedRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, mode, updateKey, showChip]);

  // Keep the LAST `visibleCount` entries of the fit ORDER in-bar (the L3-end
  // suffix plus any `dropLast` entries); the rest (L1-end prefix) overflow.
  // Surviving buttons keep their screen positions — dropping L1 leftward never
  // shifts the L2/L3 tail, and a surviving `dropLast` entry stays in its slot. Menu rows list the
  // menuOnly entries (260731-oiho) plus the overflowed controls in pyramid order
  // (registry order = L1 → L2 → L3): deriving the overflow list by filtering the
  // FULL candidate list against the visible set keeps registry order for free.
  const splitAt = fitOrder.length - visibleCount;
  const visibleIds = new Set(fitOrder.slice(splitAt).map((e) => e.id));
  const visibleItems = fitCandidates.filter((e) => visibleIds.has(e.id));
  const overflowItems = candidates.filter((e) => !visibleIds.has(e.id) && !e.pinned);
  const overflowRows: OverflowMenuRow[] = overflowItems
    .map((e) => ({ id: e.id, group: e.menuGroup, node: e.menuRender() }))
    .filter((r) => r.node != null);
  // True when the undismissed chip's entry is currently overflowed into the
  // menu — drives the chevron attention badge, and is one of the menu's two
  // update-surface derivations (the other, dismissed-pending, is computed
  // inside TopBarOverflowMenu from context — 260720-ml7k).
  const updateOverflowed = showChip && overflowItems.some((e) => e.id === "update-chip");

  return (
    // pt guard: viewport-fit=cover (safe-area work, 260724-2bmy) can expose the
    // status-bar area in standalone PWA mode, so browsers/PWA keep the
    // safe-area padding. Inside the desktop shell the padding is DROPPED: the
    // ShellTitlebarStrip already reserves the titlebar band in the SPA layout,
    // and macOS hidden-titlebar windows can report that band as
    // safe-area-inset-top — keeping the class would reserve the band twice
    // (260805-9hn1). isShell() is read once per render: the preload injects
    // window.runkitShell before any SPA script runs, so it is stable for the
    // page's lifetime.
    <header
      className={`relative px-3 ${isShell() ? "" : "pt-[env(safe-area-inset-top)]"} border-b-[3px] border-border`}
      // While the head shows, shift the bar's own grid right of the content
      // column's left edge; the +12 restores the `px-3` offset relative to that
      // edge (the grid otherwise starts 12px in from the window edge). Hidden:
      // no inline padding — `px-3` alone.
      style={headShown ? { paddingLeft: sidebarHeadWidth + 12 } : undefined}
    >
      {headShown && (
        <SidebarHead
          width={sidebarHeadWidth}
          onToggleSidebar={handleHeadToggle}
          hamburgerOpen={hamburgerOpen}
          brandSweep={brandSweep}
          toggleRef={headToggleRef}
        />
      )}
      {/* 3-column grid. At ≥ sm it is `1fr auto 1fr`: the center cell is truly
          centered regardless of asymmetric left/right widths. Left = left
          cluster (hamburger + breadcrumb nav, 260720-ap63), center = the
          universal `PageType: name` page heading (all four modes,
          260704-pr0p), right = controls. BELOW `sm` the columns are
          `auto auto minmax(0,1fr)` and the heading left-aligns beside the
          hamburger instead: every crumb is breakpoint-hidden there, so a
          centered heading wastes the left cell as dead space while the
          button-heavy right cluster overflows its equal-share `1fr` track and
          paints over the heading's ▾ switcher. Content-sizing the first two
          columns hands ALL leftover width to the right cluster, whose
          `minmax(0,1fr)` track keeps tracking the viewport — the overflow fit
          machinery needs a track-filling cell to measure (see the right-cell
          comment below). */}
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] sm:grid-cols-[1fr_auto_1fr] items-center gap-2 py-2">
        {/* Left cluster (260720-ap63): a flex wrapper so the hamburger — a
            drawer toggle, NOT a breadcrumb item — sits outside the breadcrumb
            nav landmark, with the nav beside it inside the `1fr` left cell
            (the center heading's true centering is untouched). The hamburger
            leads the cluster only while the sidebar head is not shown; with
            the head up (desktop, sidebar open) the toggle and brand live in
            the head and the history arrows lead. `min-w-0` lets the nav
            shrink below its content inside `1fr`. */}
        {/* One warm-tip cluster per chrome region (260722-73al): the left
            breadcrumb cluster shares a TipGroup so sweeping across crumbs
            opens sibling tips instantly (macOS-menu behavior). */}
        <TipGroup>
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Hamburger icon — toggles sidebarOpen (one boolean covers both
              desktop grid column and mobile overlay). Renders as the left
              cluster's first element (standard drawer-toggle position) EXCEPT
              while the sidebar head is shown — the toggle lives in the head
              then and the history arrows lead the cluster. Not rendered on the
              Host page, which has no sidebar — the history arrows lead there
              (no ghost slot reserved). Uses the shared fixed-size button token
              (260731-oiho — 28px fine / 30px coarse) so it renders the SAME box
              as its siblings (HistoryNav arrows / the right cluster); rk-glint
              flips the border green on hover. Keeps its primary text color
              (the toggle carries page-level chrome weight). */}
          {hasSidebar && !headShown && (
            <button
              ref={clusterToggleRef}
              onClick={handleClusterToggle}
              aria-label="Toggle navigation"
              className={controlClass({ variant: "icon", rest: "border-border hover:border-text-secondary text-text-primary" })}
            >
              <HamburgerIcon isOpen={hamburgerOpen} />
            </button>
          )}

          {/* Browser-history ◀ ▶ arrows — LEFT cluster as of 260731-oiho
              (macOS convention: sidebar toggle → back → forward → brand
              crumb; the pair leads the cluster on the Host page and while the
              sidebar head shows). Global chrome on all four modes; moving them
              here deleted the center box's width-compensation hack. */}
          <HistoryNav />

          {/* Breadcrumb nav (260715-q8ey overlap fixes): `overflow-hidden`
              is the clip backstop — any crumb content past the floor clips at
              the nav edge instead of painting over the center heading. The
              `sm:min-w-[150px]` floor guarantees a usable session crumb
              sliver at `sm+`; below `sm` there is NO floor — every crumb is
              breakpoint-hidden there (brand, server, session, the collapse
              rung), so the nav renders empty and a floor would only push the
              left-aligned heading right (the mobile grid content-sizes this
              column). While the sidebar head shows the floor is OFF too
              (`min-w-0`): the head takes its width out of the bar, and a
              rigid floor in the `1fr` left track would spill the nav into
              the centered heading — the crumb collapse (`… ▾`) absorbs the
              squeeze instead. `flex-1` makes the nav claim the left cell's leftover
              width at `sm+` regardless of content size, so the crumb section's
              clientWidth stays the available-space signal even while collapsed
              (a content-sized nav would shrink to the `… ▾` trigger and the
              collapse measurement would go blind; below `sm` the probe
              measures 0 and the collapse derivation holds its previous state,
              as before). Degradation ladder: crumbs truncate (floored at 6ch
              of content + chrome, so the ellipsis reserve can never be
              squeezed away) → BOTH crumbs collapse into a single `… ▾` crumb
              (measurement-driven, below) → server crumb hides below `md` →
              nav clips at its floor. */}
          <nav
            aria-label="Breadcrumb"
            className={`flex items-center gap-1.5 text-sm overflow-hidden flex-1 ${headShown ? "min-w-0" : "sm:min-w-[150px]"}`}
          >
            {/* Brand root crumb — logo + wordmark, links to `/`. The nav's
                first child (the breadcrumb's root — the `›` separator starts
                after it); IS the home affordance ON ≥sm (no separate "Host"
                crumb). Not rendered while the sidebar head is shown — the head
                carries the brand anchor then, and `HexoKit home` must stay
                unique in the document. Below `sm` the whole crumb is gone (the
                `hidden sm:contents` wrapper — a wrapper, not classes on the
                anchor, because `hidden` and CRUMB_BOX's `inline-flex` are
                conflicting display utilities whose winner would depend on
                stylesheet order): on phones the brand + home affordance live
                in the sidebar's brand row instead (SidebarBrand), so the left
                cluster spends its scarce 375px width on crumbs that navigate. */}
            {!headShown && (
            <span className="hidden sm:contents">
            <Tip label="Host">
            <a
              href="/"
              aria-label="HexoKit home"
              className={`gap-2 shrink-0 rk-brand-glitch ${LINK_CRUMB_CLASS}`}
              onMouseEnter={brandSweep.onMouseEnter}
            >
              {/* Inline SVG (LogoSpinner at rest), not the /icon.svg img — the
                  hover sweep drives the border segments' fills from JS
                  (useBrandLogoSweep), which can't reach inside an img. */}
              <LogoSpinner size={20} loading={false} svgRef={brandSweep.svgRef} />
              {/* [text-decoration:inherit] — the anchor is a flex container and
                  text-decoration does not propagate into flex items, so an
                  underline-based LINK_CRUMB_CLASS would silently skip the
                  wordmark without it. No-op for non-underline variants. */}
              <span className="text-xs [text-decoration:inherit]">HexoKit</span>
            </a>
            </Tip>
            </span>
            )}

            {mode === "board" ? (
              // Board mode keeps ONLY the counts/hint on the left (move-don't-copy,
              // 260704-pr0p): the board name + ▾ switcher moved to the center
              // heading, and the left `Board ▸` home button is gone (the brand
              // crumb is already the home affordance). No leading separator — the
              // hint is not a crumb.
              <BoardModeInfo
                paneCount={paneCount ?? 0}
                serverCount={serverCount ?? 0}
                waitingPaneCount={waitingPaneCount ?? 0}
              />
            ) : hasCollapsibleCrumbs ? (
              // The collapsible crumb section: `flex-1 min-w-0` so its
              // clientWidth IS the space the crumbs may occupy (see the
              // collapse-rung comment above); `overflow-hidden` clips the
              // floored crumbs for the single frame before the collapse
              // re-render lands (the layout-effect measurement runs pre-paint,
              // so this is a backstop, not a rendered state).
              <div ref={crumbSectionRef} className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
                {crumbsCollapsed ? (
                  // `hidden sm:contents`: the collapse rung never renders
                  // below `sm`. Every crumb is breakpoint-hidden there, so the
                  // probe measures 0 and the derivation holds its PREVIOUS
                  // state — a collapse engaged at sm+ would otherwise persist
                  // into mobile widths on resize, rendering a crumb a cold
                  // mobile load never renders. The CSS gate keeps the
                  // breakpoint hides as the unconditional outer rungs.
                  <span className="hidden sm:contents">
                    {rootSeparator && <BreadcrumbSeparator />}
                    {/* The collapse rung's rendering: ONE crumb-styled trigger
                        whose menu carries both levels (server → its route;
                        session → the current window's route, current) so each
                        destination stays one tap away. */}
                    <BreadcrumbDropdown
                      items={collapsedCrumbItems}
                      label="location"
                      title="Navigation"
                      onNavigate={handleCollapsedNavigate}
                      triggerContent={
                        <span className="min-w-0 truncate px-0.5">{"… ▾"}</span>
                      }
                      triggerClassName={LINK_CRUMB_CLASS}
                    />
                  </span>
                ) : (
                  <>
                {/* Server LINK crumb — terminal route only (parent = the tmux
                    Server). On the server route the server name is the leaf and lives
                    in the center heading, so no left server crumb there. Hidden
                    below `md` (260715-q8ey — demoted from `sm`): it is the
                    redundant first-to-give crumb, giving way before the session
                    crumb in the cramped `sm`..`md` band. (260813-kvk7: the
                    hierarchy ▾ that originally covered this navigation is gone —
                    below `md` the ancestor paths are the palette's
                    `Go: tmux Server` / `Go: Host` + browser back; the ladder
                    itself is unchanged.) `min-w-0` unblocks the inner
                    `truncate max-w-[16ch]`, while the box's
                    `min-w-[calc(6ch+0.875rem)]` floor (6ch of content + the
                    box's horizontal padding/border chrome) guarantees the
                    ellipsis reserve — a crumb can never render as a sub-6ch
                    fragment or hard-clip without its `…`. */}
                {showServerCrumb && (
                  <span className="hidden md:flex items-center gap-1.5 min-w-0">
                    {rootSeparator && <BreadcrumbSeparator />}
                    <Tip label="tmux Server">
                      <a
                        href={serverHref}
                        className={`rk-glint ${LINK_CRUMB_CLASS} min-w-[calc(6ch+0.875rem)]`}
                      >
                        <span className="truncate max-w-[16ch] [text-decoration:inherit]">
                          {server}
                        </span>
                      </a>
                    </Tip>
                  </span>
                )}

                {sessionName && (
                  // The breadcrumb ends at the SESSION crumb — window identity
                  // moved to the centered heading (below), so the window name is
                  // never duplicated. Session crumb hidden below `sm`.
                  // 260813-kvk7: the session dropdown (switcher + "+ New Session")
                  // is gone — session switching lives in the sidebar rows and the
                  // palette's `Tab: Switch to …`, creation in the palette's
                  // `Session: Create` and the sidebar server-header `+`. The
                  // crumb is now a NON-interactive
                  // static chip: a session has no route of its own, so it carries
                  // the siblings' box styling with no hover affordance or caret.
                  // Same 6ch ellipsis-reserve floor as the server crumb.
                  <span className="hidden sm:flex items-center gap-1.5 min-w-0">
                    {/* The `›` ties the session crumb to the crumb on its
                        LEFT. With the head up (`!rootSeparator`) that left
                        crumb is the server crumb, which is itself hidden
                        below `md` — gate the separator on the same
                        breakpoint or the session crumb opens with an orphan
                        `›` in the sm–md band. With the brand in the nav
                        (`rootSeparator`) a left crumb always exists at
                        `sm+`, so no gate. */}
                    {sessionSeparator &&
                      (showServerCrumb && !rootSeparator ? (
                        <span className="hidden md:contents">
                          <BreadcrumbSeparator />
                        </span>
                      ) : (
                        <BreadcrumbSeparator />
                      ))}
                    <span className={`${CRUMB_BOX_CLASS} min-w-[calc(6ch+0.875rem)]`}>
                      <span className="truncate max-w-[16ch]">{sessionName}</span>
                    </span>
                  </span>
                )}
                  </>
                )}

                {/* Collapse-threshold probe (hidden, inert, off-screen — the
                    right cell's probe pattern): the crumbs rendered at their
                    min-useful form — real text, `max-w-[6ch]` truncation — so
                    `scrollWidth` is exactly the smallest width at which every
                    crumb still shows ≥6ch of content. The breakpoint-hide
                    classes mirror the real crumbs so a hidden crumb drops out
                    of the threshold. The `6ch` literal couples to
                    CRUMB_MIN_USEFUL_CH (lib/crumb-collapse.ts) — Tailwind
                    arbitrary values must stay literal for the compiler. */}
                <div
                  ref={crumbProbeRef}
                  aria-hidden="true"
                  inert
                  data-testid="crumb-collapse-probe"
                  className="absolute -left-[9999px] top-0 flex items-center gap-1.5 text-sm pointer-events-none w-max"
                >
                  {showServerCrumb && (
                    <span className="hidden md:flex items-center gap-1.5">
                      {rootSeparator && <BreadcrumbSeparator />}
                      <span className={CRUMB_BOX_CLASS}>
                        <span className="truncate max-w-[6ch]">{server}</span>
                      </span>
                    </span>
                  )}
                  {sessionName && (
                    <span className="hidden sm:flex items-center gap-1.5">
                      {sessionSeparator &&
                        (showServerCrumb && !rootSeparator ? (
                          <span className="hidden md:contents">
                            <BreadcrumbSeparator />
                          </span>
                        ) : (
                          <BreadcrumbSeparator />
                        ))}
                      <span className={CRUMB_BOX_CLASS}>
                        <span className="truncate max-w-[6ch]">{sessionName}</span>
                      </span>
                    </span>
                  )}
                </div>
              </div>
            ) : null}
          </nav>
        </div>
        </TipGroup>

        {/* Center cell — the universal `PageType: name` page heading, filled on
            EVERY mode (260704-pr0p): terminal = editable window heading + ▾
            window switcher; board = display board heading + ▾ board switcher
            (both moved here from the left breadcrumb); root = display server
            heading; host = solo `Host`. At ≥ sm it stays centered under the
            `auto` middle grid column regardless of left/right widths; BELOW
            `sm` it is the visible leaf (intermediate crumbs hide there) and
            LEFT-ALIGNS beside the hamburger — its column is content-sized and
            the leftover width goes to the button-heavy right cluster (see the
            grid comment above). At ≥ lg the heading compacts (the prefix span
            hides) and the standing quake launcher sits beside it; at md–lg
            the engaged ⌘J machine morphs the box in place of the heading. */}
        {/* No flex `gap` here: the single separator between the page-type prefix
            and the instance name is the boot sweep's own `sp` space cell (the
            cursor visibly crosses it) — a `gap-1` on top of it double-spaced
            them (260704-pr0p rework N4). The ▾ switchers carry their own `ml-1`
            so only the switcher gets separated from the name. */}
        {/* The OUTER cell centers at ≥ sm and left-aligns below it (the mobile
            grid content-sizes this column — see the grid comment); the INNER
            container (260714-uco1) carries a `sm:`-gated min-width with
            left-aligned content so the heading's LEFT EDGE stops drifting as the
            instance name length changes. Below `sm` the min-width is absent
            (space is scarce at 375px).
            260715-q8ey: the OUTER cell deliberately has NO `min-w-0` — that let
            the `auto` column compress below the heading's content floor and
            produced center-side overlap. The floor is already bounded (name
            spans `max-w-[16ch] sm:max-w-[28ch] truncate` + fixed-width
            `shrink-0` controls + the inner `sm:min-w-[28ch]` anchor), so
            dropping `min-w-0` protects the center without a magic pixel min. Do
            NOT re-add `min-w-0` here. */}
        <div className="flex items-center justify-start sm:justify-center">
          {/* Center heading cluster's warm-tip group (260722-73al): the rename
              heading + window switcher sweep as one cluster (the history arrows
              ride the left cluster's group now, 260731-oiho). */}
          <TipGroup>
          <div
            className="flex items-center justify-start min-w-0 sm:min-w-[28ch]"
          >
            {/* The history ◀ ▶ arrows moved to the LEFT cluster (260731-oiho) —
                the anchored box now carries only the heading furniture
                (prefix + name + switcher), so the old
                arrow width-compensation hack is gone with them. */}

            {mode === "terminal" && currentWindow && (
              <>
                {/* No `key` on the route identity: the instance persists across
                    window switches so the boot sweep replays on navigation and
                    an in-progress edit survives long enough to be intentionally
                    cancelled (see WindowHeading's identity-change guard) rather
                    than silently destroyed by a remount. The prefix is a
                    STATIC `Tab:` in every lens — the lens is
                    shown by the tile content itself, not the heading. The
                    prefix carries NO caret (260813-kvk7): the heading reads
                    `Tab: <name>` with the single ▾ owned by the tab
                    switcher; ancestor navigation lives in the palette
                    (`Go: tmux Server` / `Go: Host`, lib/palette/nav.ts). */}
                <WindowHeading
                  server={server}
                  windowId={currentWindow.windowId}
                  sessionName={sessionName}
                  name={windowName}
                  prefix={WINDOW_PREFIX}
                  operator={currentWindow.role === "operator"}
                />
                <BreadcrumbDropdown
                  items={windowItems}
                  label="tab"
                  title="Tabs"
                  onNavigate={handleDropdownNavigate}
                  action={{ label: "+ New Tab", onAction: () => onCreateWindow(sessionName) }}
                  // + New Agent — the second window-switcher entry point for the
                  // web-UI spawn flow (260713-sbk1). Rendered only when AppShell
                  // published an onSpawnAgent handler (terminal route with a session).
                  secondaryAction={
                    onSpawnAgent
                      ? { label: "+ New Agent", onAction: () => onSpawnAgent(sessionName) }
                      : undefined
                  }
                  triggerClassName="ml-1 text-text-secondary hover:text-text-primary transition-colors shrink-0"
                />
              </>
            )}

            {mode === "board" && boardName && (
              <>
                {/* Board name is display-only (boards have no rename API); the ▾
                    board switcher moved here from the left breadcrumb. No prefix
                    caret (260813-kvk7) — the heading reads `Board: <name>`. */}
                <PageHeadingDisplay
                  prefix={BOARD_PREFIX}
                  name={boardName}
                  ariaLabel={`Board ${boardName}`}
                />
                <BoardSwitcher boardName={boardName} boards={boards ?? []} />
              </>
            )}

            {mode === "server" && server && (
              // No prefix caret (260813-kvk7) — the heading reads
              // `tmux Server: <name>`; ancestors are reachable via the palette.
              <PageHeadingDisplay
                prefix={TMUX_SERVER_PREFIX}
                name={server}
                ariaLabel={`tmux Server ${server}`}
              />
            )}

            {mode === "host" && (
              // Solo `Host` — the root of the hierarchy, so NO prefix caret
              // (it has no ancestors). The history arrows still render (above).
              <PageHeadingDisplay
                prefix=""
                name={HOST_SOLO}
                solo
                ariaLabel="Host"
              />
            )}
          </div>
          </TipGroup>
          {/* The quake launcher — the quake terminal's standing affordance in
              the center cell on desktop (standing box at ≥ lg beside the
              compact heading, ghost at md–lg; while the drawer is open both
              rungs collapse to the glyph + chord control that re-focuses the
              docked compose). Renders on every mode;
              self-gates to null on mobile. The route server and window arrive
              as props so this center-cell component does not pull router
              hooks. */}
          <QuakeLauncher routeServer={server || null} routeWindow={currentWindow?.windowId ?? null} />
        </div>

        {/* Right cluster — registry-driven overflow (260715-h1ck). The ordered
            registry (built above) is the single source: the first N candidates
            that fit render as icon buttons; the rest overflow into the chevron
            menu. `min-w-0` makes this `1fr` grid track squeezable (q8ey's
            left/center floors bound the other tracks, so there is no feedback
            loop). The pyramid invariant holds — overflow consumes L1→L2→L3 from
            the left and surviving buttons keep their positions.

            Only the trailing chevron and `pinned` entries (the mobile
            surface-switch group) are EXEMPT (never overflow; the
            connection dot moved to the sidebar footer, 260724-6j1v);
            fixed-width / terminal-font /
            close-pane (260731-oiho) are `menuOnly` — never in-bar, their rows
            always in the menu. The `hidden sm:flex` breakpoint cliff is GONE:
            below `sm`, controls overflow into the menu instead of vanishing. */}
        {/* The cell must FILL its `1fr` grid track (NOT `justify-self-end`,
            which would size the box to its own content and both (a) deadlock
            `computeVisibleCount` — a content-sized box measures only the exempt
            block, so budget < 0 forever at collapse-first — and (b) never fire
            the ResizeObserver on window resize, since a content-sized box's
            width doesn't track the viewport). Default grid stretch fills the
            track; `justify-end` right-aligns the content inside it. */}
        {/* `min-w-0` keeps the `1fr` track squeezable (M1: the cell fills the
            track — no `justify-self-end`, which would content-size it and
            deadlock the fit). NO `overflow-hidden` here: the candidate buttons
            that don't fit are moved to the menu (never rendered in-bar), so the
            only content that can exceed a very-narrow track is the ALWAYS-present
            exempt block (the chevron). Clipping it would make the chevron
            un-clickable at tight widths with a long center heading
            (violating R6/(e) "exempt items always visible"). Letting the exempt
            block paint (unclipped) keeps it usable; `.app-shell`/`header` still
            clip any horizontal PAGE overflow, so no scrollbar appears. */}
        {/* Right control cluster's warm-tip group (260722-73al) — includes the
            overflow menu and every registry control's popover rows, so the
            whole cluster sweeps as one warm group. */}
        <TipGroup>
        <div
          ref={rightCellRef}
          data-testid="top-bar-right"
          className="flex items-center justify-end gap-3 text-xs text-text-secondary min-w-0"
        >
          {/* The window-view lens switcher never renders here (260722-n2n4):
              its registry entry is `menuOnly`, so its ONLY rendering is the
              per-view `View: …` rows inside the chevron menu — the pill is
              excluded from the visible row, the probe, and the fit budget. */}

          {/* Pinned entries — always in-bar, never overflowed, never probed
              (the mobile surface-switch group; its measured width is reserved
              from the fit budget). Rendered at the head: the only pinned entry
              is the registry head, so registry order is preserved. */}
          {pinnedItems.length > 0 && (
            <div ref={pinnedRef} className="flex items-center gap-3 shrink-0">
              {pinnedItems.map((e) => (
                <span key={e.id} className="flex items-center shrink-0">
                  {e.barRender()}
                </span>
              ))}
              {/* The gui fold's mobile bottom rung: with the gui surface
                  visible, the `⚙` panel block pins beside the switch group
                  (mobile has no tile header). Inside the pinned container its
                  width is reserved from the fit budget like the group's. */}
              {guiToolbar &&
              surfaceToggles?.mode === "switch" &&
              surfaceToggles.active === "gui" ? (
                <GuiToolbarMobileOverflow
                  actions={guiToolbar.actions}
                  quality={guiToolbar.quality}
                  visible={guiToolbar.visible}
                  onVisibleChange={guiToolbar.onVisibleChange}
                />
              ) : null}
            </div>
          )}

          {/* Visible fit candidates — the leading N that fit, as icon buttons. */}
          {visibleItems.map((e) => (
            <span key={e.id} className="flex items-center shrink-0">
              {e.barRender()}
            </span>
          ))}

          {/* Hidden measurement probe — renders every FIT candidate's bar form
              (menuOnly entries are excluded, 260722-n2n4 — the probe's children
              must stay index-aligned with the widths array the fit reads) so we
              always know each real width (never hardcoded), regardless of how
              many are currently visible. It is `inert` (React 19) + `aria-hidden`
              + off-screen (`absolute`, off the left edge): invisible, untabbable,
              and non-interactive, so the duplicated controls can never receive
              focus/clicks or open a popover — they exist purely to be measured
              and never affect the visible row's layout. The duplication is a
              deliberate trade-off for measuring true widths without a magic
              constant; the controls are cheap and read-only on mount. */}
          <div
            ref={probeRef}
            aria-hidden="true"
            inert
            className="absolute -left-[9999px] top-0 flex items-center gap-3 pointer-events-none"
          >
            {fitOrder.map((e) => (
              <span key={e.id} className="flex items-center shrink-0">
                {e.barRender()}
              </span>
            ))}
          </div>

          {/* Trailing exempt block — the always-present overflow chevron/menu,
              the right-most element in every mode (the connection dot moved to
              the sidebar footer, 260724-6j1v). Its measured width is reserved
              before fitting. */}
          <div ref={trailingRef} className="flex items-center gap-3 shrink-0">
            <TopBarOverflowMenu rows={overflowRows} updateOverflowed={updateOverflowed} />
          </div>
        </div>
        </TipGroup>
      </div>
    </header>
  );
}

// Boot-sweep tuning (change 260704-pr0p, extending the 260703-5ilm decode).
// One inverse-video cursor sweeps the whole heading string (prefix + space +
// name) at ~28ms/cell, with a ~140ms hover-intent delay so cursor transit
// across the bar toward the right-side buttons doesn't replay it.
const DECODE_FRAME_MS = 28;
const DECODE_HOVER_INTENT_MS = 140;
const DECODE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/";

function randomGlyph(): string {
  return DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)];
}

// A boot-sweep cell: `kind` fixes its resting styling (prefix vs name vs the
// separating space vs a solo type word); `phase` is its live sweep state.
type SweepKind = "pfx" | "sp" | "nm" | "solo";
type SweepPhase = "rest" | "resolved" | "cursor" | "ahead";
type SweepCell = { ch: string; kind: SweepKind; phase: SweepPhase };

/**
 * Build the resting cell list for a heading. Terminal/board/server headings pass
 * a `prefix` (e.g. `Terminal`) + `name`; host passes `solo` alone (no
 * prefix, no instance name — just the type word).
 *
 * The separating space is its own `sp` cell so the cursor visibly crosses it
 * between the prefix and the name (matching the reviewed demo).
 */
function buildCells(
  prefix: string,
  name: string,
  solo: boolean,
): SweepCell[] {
  if (solo) {
    return Array.from(name).map((ch) => ({ ch, kind: "solo", phase: "rest" }));
  }
  const cells: SweepCell[] = [];
  for (const ch of prefix) cells.push({ ch, kind: "pfx", phase: "rest" });
  cells.push({ ch: " ", kind: "sp", phase: "rest" });
  for (const ch of name) cells.push({ ch, kind: "nm", phase: "rest" });
  return cells;
}

/**
 * The one continuous "boot sweep": a single inverse-video accent-green block
 * cursor sweeps prefix + space + name left-to-right at `DECODE_FRAME_MS`/cell
 * (change 260704-pr0p). Over PREFIX cells it behaves like TypedLabel — cells
 * ahead of the cursor are dim (`rk-typed-off`), the cursor cell shows the real
 * char in inverse video (`rk-typed-cursor`), resolved cells settle to
 * secondary. Once the cursor crosses into the NAME, unresolved name cells churn
 * random `DECODE_GLYPHS` in accent-green each frame (spaces preserved) until
 * the cursor locks each to its true char; resolved name cells settle to
 * semibold primary. The Host page's solo word runs the typed sweep alone.
 *
 * Returns the live cell array (for per-cell rendering), a `scrambling` flag,
 * and imperative controls. Reduced motion is JS-gated (`prefersReducedMotion`):
 * the sweep never starts and the rest state IS the reduced state.
 */
function useBootSweep(prefix: string, name: string, solo: boolean) {
  const rest = () => buildCells(prefix, name, solo);
  const [cells, setCells] = useState<SweepCell[]>(rest);
  const [scrambling, setScrambling] = useState(false);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setScrambling(false);
  }, []);

  // Snap every cell back to its true char + resting styling.
  const resolve = useCallback(() => {
    stop();
    setCells(rest());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, name, solo, stop]);

  const play = useCallback(() => {
    stop();
    const base = rest();
    if (prefersReducedMotion() || base.length === 0) {
      setCells(base);
      return;
    }
    setScrambling(true);
    let cur = 0;
    const n = base.length;
    const tick = () => {
      if (cur > n) {
        setCells(base);
        stop();
        return;
      }
      const next = base.map((c, i): SweepCell => {
        if (i < cur) return { ...c, phase: "resolved" };
        if (i === cur) return { ...c, phase: "cursor" };
        // Ahead of the cursor: name cells churn a glyph (space preserved);
        // prefix/solo/space cells just dim.
        if (c.kind === "nm") {
          return { ...c, ch: c.ch === " " ? " " : randomGlyph(), phase: "ahead" };
        }
        return { ...c, phase: "ahead" };
      });
      setCells(next);
      cur += 1;
    };
    tick();
    frameTimerRef.current = setInterval(tick, DECODE_FRAME_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, name, solo, stop]);

  // Deferred (hover-intent) start: `DECODE_HOVER_INTENT_MS` before the sweep,
  // so cursor transit toward the right-side buttons doesn't replay it.
  const playDeferred = useCallback(() => {
    if (prefersReducedMotion()) return;
    stop();
    hoverTimerRef.current = setTimeout(play, DECODE_HOVER_INTENT_MS);
  }, [play, stop]);

  useEffect(() => () => stop(), [stop]);

  return { cells, scrambling, play, playDeferred, resolve, stop };
}

// Per-cell REST styling by kind. Resolved cells (and cells rendered at rest)
// settle to THESE classes as the cursor passes — NOT to a container-wide color.
// This is the fix for the "resolved cells stay accent-green" defect (change
// 260704-pr0p rework): the heading containers no longer flip `text-accent-green`
// for the whole scramble, so each resolved cell must name its own rest color —
// prefix/space → `text-text-secondary`, name/solo → semibold `text-text-primary`.
// Only the churn (`ahead` name) glyphs and the single cursor cell are green.
function restCellClass(kind: SweepKind): string {
  return kind === "nm" || kind === "solo"
    ? "font-semibold text-text-primary"
    : "text-text-secondary";
}

/**
 * Renders a boot-sweep cell list. At REST (no active sweep) it emits plain text
 * inside a single `whitespace-pre` span so the accessible name stays clean and
 * stable; while sweeping it emits per-cell spans carrying the frame-state
 * classes. Decorative during animation — the spans are `aria-hidden` so churn
 * glyphs never reach a screen reader.
 *
 * Cell-state → styling: the single `cursor` cell is inverse video
 * (`rk-typed-cursor`); an `ahead` cell is a dim prefix glyph (`rk-typed-off`) or
 * an accent-green name churn glyph; a `resolved` (already-swept) cell settles to
 * its per-kind REST class (`restCellClass`), so the left-to-right two-tone
 * reveal is visible instead of a uniform green flash.
 */
function SweepCells({
  cells,
  scrambling,
}: {
  cells: SweepCell[];
  scrambling: boolean;
}) {
  if (!scrambling) {
    return <>{cells.map((c) => c.ch).join("")}</>;
  }
  return (
    <span aria-hidden="true" className="whitespace-pre">
      {cells.map((c, k) => {
        let cls: string;
        if (c.phase === "cursor") cls = "rk-typed-cursor";
        else if (c.phase === "ahead")
          cls = c.kind === "nm" ? "text-accent-green" : "rk-typed-off";
        // resolved (already swept) — settle to the cell's own rest color so it
        // does NOT inherit any transient container color.
        else cls = restCellClass(c.kind);
        return (
          <span key={k} className={cls}>
            {c.ch}
          </span>
        );
      })}
    </span>
  );
}

// Page-type prefix words for the universal center heading (change 260704-pr0p,
// title-case per the reviewed demo — supersedes PageHeading's lowercase idiom).
//
// The terminal-route prefix is a STATIC `Tab:` in every lens (change
// 260714-uco1 — a deliberate reversal of window-views spec R4's "the center
// page heading follows the lens"). The heading identifies the WINDOW (the
// substrate); which lens you look through is shown by the tile content, not
// the heading (per docs/specs/window-views.md "rows are substrates, views are
// lenses"). This also fixes the anchor jumping on lens switches — the prefix
// width no longer changes with the lens. The retired lens-following
// `terminalHeadingPrefix()` + `WEB_PREFIX`/`CHAT_PREFIX` were removed with it.
const WINDOW_PREFIX = "Tab:";
const BOARD_PREFIX = "Board:";
const TMUX_SERVER_PREFIX = "tmux Server:";
const HOST_SOLO = "Host";

/**
 * Split a boot-sweep cell list into its prefix portion (the `pfx`/`sp` cells)
 * and its name portion (the `nm` cells), so a heading can render the static
 * prefix span and the name in separate DOM containers while ONE cursor sweeps
 * across both. The `sp` separating space rides with the prefix portion so the
 * cursor visibly crosses it before entering the name.
 */
function splitSweepCells(cells: SweepCell[]): {
  prefix: SweepCell[];
  name: SweepCell[];
} {
  const prefix = cells.filter((c) => c.kind === "pfx" || c.kind === "sp");
  const name = cells.filter((c) => c.kind === "nm");
  return { prefix, name };
}

/**
 * The static page-type prefix span — a sibling OUTSIDE the rename button/input
 * so clicking it never starts an edit and it can hide independently below `sm`.
 * Its CONTENT is driven by the shared boot sweep (the one cursor crosses it into
 * the name), but structurally it is decorative: the accessible heading name is
 * carried by the name element's own label, so the prefix carries no role.
 */
function HeadingPrefix({
  cells,
  scrambling,
}: {
  cells: SweepCell[];
  scrambling: boolean;
}) {
  // -mr-1: the sweep's `sp` separator cell is a full
  // monospace space (1ch ≈ 8px at text-sm) — noticeably wider than a natural
  // `label: value` gap next to the semibold name. Pulling the following name
  // element back 4px tightens the separator to ~half a space while the cursor
  // still visibly crosses the real space cell (N4: the cell, not a flex gap,
  // owns the separation — do not swap it for a margin/gap on the name).
  // The wide-desktop rung (≥ lg) renders the compact heading — the page-type
  // prefix span hides there too, extending the below-`sm` hiding, so the
  // standing quake launcher fits beside `{name} ▾` (rename and ▾ untouched).
  return (
    <span className="hidden sm:inline lg:hidden text-sm text-text-secondary whitespace-pre shrink-0 -mr-1">
      <SweepCells cells={cells} scrambling={scrambling} />
    </span>
  );
}

/**
 * Centered, highlighted, editable window heading (change 260703-5ilm; boot
 * sweep 260704-pr0p) — the single most important identity on the terminal
 * route (the tmux window name), now prefixed `Terminal:`.
 *
 * Three states:
 *  - display: a static `Terminal:` prefix sibling + weight-600 primary-color
 *    name; hover runs the "boot sweep" (typed cursor over the prefix flowing
 *    into a decode scramble over the name).
 *  - decode/sweep: one inverse-video cursor sweeps prefix → name at 28ms/cell
 *    (JS timer — CSS can't randomize glyphs or key on the name state).
 *  - edit: an identically-styled inline input (ch-sized, grows as you type).
 *    Enter/blur commit, Escape/empty-trim cancel, wired to renameWindow() via
 *    the optimistic window-store pattern (same as the sidebar inline rename).
 *
 * Guards (intake A5): (a) 140ms hover-intent delay before the sweep; (b) edit
 * start cancels the sweep and the input binds to the real name state, never
 * scrambled DOM text; (c) the sweep replays once whenever the DISPLAYED name
 * changes — which covers a committed rename (confirmation animation), an
 * SSE-delivered external rename, and navigating to a different window, all with
 * one name-change-keyed mechanism. All animation is skipped under
 * prefers-reduced-motion.
 *
 * The component is deliberately NOT remounted per window (no `key` on the route
 * identity) so this instance persists across window switches: that is what lets
 * guard (c)'s name-change effect actually fire on navigation (a fresh mount
 * would re-seed `prevNameRef` and never replay), and it keeps an in-progress
 * inline edit from being destroyed by an external window switch. Instead, an
 * external identity change (windowId/server) while editing CANCELS the stale
 * edit — the edit belonged to the previous window, so committing the typed name
 * onto the newly-navigated window would be wrong (the modal this replaced was
 * likewise pinned to the window it opened on).
 */
function WindowHeading({
  server,
  windowId,
  sessionName,
  name,
  prefix,
  operator,
}: {
  server: string;
  windowId: string;
  sessionName: string;
  name: string;
  /** Page-type prefix — the static `Tab:` constant (`WINDOW_PREFIX`) in every
   *  lens; the lens-following `Terminal:`/`Web:`/`Chat:` prefix was retired by
   *  260714-uco1. The boot sweep renders over `prefix + " " + name`. */
  prefix: string;
  operator: boolean;
}) {
  // Shared with the sidebar inline rename (change 5ilm) so both surfaces rename
  // identically (optimistic store rename, rollback + toast, clear on settle).
  const { execute: executeRename } = useWindowRename();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // The boot sweep drives the animated name display; `sweep.cells` carries the
  // whole `Tab: name` string so ONE cursor crosses the prefix into the
  // name. `scrambling` is passed to `SweepCells`, which turns ONLY the per-cell
  // churn glyphs and the single cursor cell accent-green (the vocabulary-wide
  // "animated element turns green" cue) — resolved cells settle to their REST
  // color as the cursor passes, so the container itself never flips green
  // (260704-pr0p rework M2).
  const sweep = useBootSweep(prefix, name, false);
  const { prefix: prefixCells, name: nameCells } = splitSweepCells(sweep.cells);

  const inputRef = useRef<HTMLInputElement>(null);
  // Seeded with `null` (never a real name) so the name-effect below fires ONCE
  // on mount — that is the mount/navigation replay leg (change 260704-pr0p
  // rework M1). A fresh mount plays once, then `prevNameRef` holds the real
  // name so only a GENUINE later name change replays. Seeding it with `name`
  // (as before) suppressed the initial/route-transition play entirely, since
  // WindowHeading mounts only after `currentWindow` resolves and the headings
  // remount across page types. Using the existing name-effect as the single
  // play path (rather than a separate mount effect) is what keeps mount from
  // double-playing over a name change.
  const prevNameRef = useRef<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Set true by a key-driven commit/cancel (Enter/Escape) so the onBlur that
  // fires as the focused <input> tears down is ignored — otherwise Escape could
  // be followed by a stray blur COMMIT (renaming despite the cancel), or Enter
  // by a redundant second commit. Mirrors the sidebar inline editor's
  // `cancelledRef` blur guard (sidebar/index.tsx). Consumed (reset) by the blur
  // handler; re-cleared on each fresh edit entry.
  const keyHandledRef = useRef(false);
  // Track the window identity so an EXTERNAL switch (another client / tmux
  // changing the route) mid-edit can cancel the stale edit rather than retarget
  // it onto the newly-navigated window.
  const prevIdentityRef = useRef(`${server}:${windowId}`);

  // External window switch (another client / tmux changing the route) while
  // an inline edit is in progress: CANCEL the stale edit. The edit targeted
  // the previous window, so committing the typed name onto the newly-navigated
  // window would rename the wrong window. The retired rename modal was pinned
  // to the window it opened on for the same reason; this is its equivalent now
  // that the heading persists across window switches (no remount `key`).
  useEffect(() => {
    const identity = `${server}:${windowId}`;
    if (identity !== prevIdentityRef.current) {
      prevIdentityRef.current = identity;
      if (editingRef.current) {
        sweep.resolve();
        setEditing(false);
        setDraft(name);
      }
    }
  }, [server, windowId, name, sweep]);

  // Plays the boot sweep once on MOUNT and once on every later DISPLAYED-name
  // change (rename confirmation / external rename / route to a different
  // window — one name-keyed mechanism, plus the mount leg via the `null` seed
  // above). Because the instance is NOT remounted per window, the name change
  // also fires on navigation, so the sweep genuinely replays when routing to a
  // different window (guard c). The mount fire and a name change can never
  // double-play: mount sets `prevNameRef` to the real name, so the effect only
  // re-runs `play()` for a name that is actually different. While editing, do
  // not animate (bind to the real name).
  useEffect(() => {
    if (name !== prevNameRef.current) {
      prevNameRef.current = name;
      setDraft(name);
      if (!editingRef.current) sweep.play();
      else sweep.resolve();
    }
  }, [name, sweep]);

  const startEdit = useCallback(() => {
    sweep.resolve();
    setDraft(name);
    keyHandledRef.current = false;
    setEditing(true);
  }, [name, sweep]);

  // Command-palette "Tab: Rename" enters inline edit via a CustomEvent,
  // mirroring the `theme-selector:open` pattern (Constitution V keyboard path).
  useEffect(() => {
    function onRename() {
      startEdit();
    }
    document.addEventListener("window-heading:rename", onRename);
    return () => document.removeEventListener("window-heading:rename", onRename);
  }, [startEdit]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    // The edit input applies the live window transform; commit trims the
    // trailing separator the live transform keeps visible while typing.
    const trimmed = finalizeSafeName(draft.trim());
    setEditing(false);
    // Empty-after-conversion commit = cancel (matches the dialog's trim guard).
    if (!trimmed || trimmed === name) {
      sweep.resolve();
      setDraft(name);
      return;
    }
    executeRename(server, sessionName, windowId, trimmed);
    // The name-change effect replays the boot sweep when the store-driven
    // `name` prop settles to the committed value.
  }, [draft, name, server, sessionName, windowId, executeRename, sweep]);

  const cancel = useCallback(() => {
    setEditing(false);
    sweep.resolve();
    setDraft(name);
  }, [name, sweep]);

  const operatorIcon = operator ? (
    // mr-1 only (no left margin): HeadingPrefix's -mr-1 deliberately tightens
    // the sweep's `sp` cell against whatever follows — a left margin here would
    // cancel that pull-back and widen the prefix gap.
    <span className="mr-1 shrink-0 text-text-secondary transition-colors hover:text-text-primary group-hover/operator-heading:text-text-primary">
      <HeadsetIcon size={14} />
    </span>
  ) : null;

  if (editing) {
    return (
      <>
        <HeadingPrefix cells={prefixCells} scrambling={false} />
        {operatorIcon}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          // Live safe-name conversion (window kind — hyphens kept): a typed
          // space appears as "_" so the committed name is the displayed name.
          onChange={(e) => setDraft(toSafeWindowName(e.target.value))}
          onBlur={() => {
            // A key (Enter/Escape) already committed/cancelled and is tearing
            // the input down — swallow the trailing blur so it doesn't re-commit
            // (Enter) or override a cancel (Escape). Genuine focus-loss (no
            // preceding key) still commits.
            if (keyHandledRef.current) {
              keyHandledRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              keyHandledRef.current = true;
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              keyHandledRef.current = true;
              cancel();
            }
          }}
          aria-label="Tab name"
          // Identically-styled to the display heading: monospace, LEFT-aligned
          // (260714-uco1 — dropped `text-center` so the name doesn't jump
          // horizontally when entering edit mode, now that the heading is
          // left-anchored), weight-600 primary color, sized in ch and growing
          // with content.
          style={{ width: `${Math.max(draft.length + 1, 3)}ch` }}
          className="bg-transparent text-left text-sm font-semibold text-text-primary outline-none border-b border-accent-green min-w-0"
        />
      </>
    );
  }

  return (
    // ONE hover owner for the whole heading: enter/leave live on this wrapper
    // (mirroring PageHeadingDisplay's outer span), NEVER on the prefix and the
    // button individually — per-sibling handlers fire resolve() + playDeferred()
    // when the pointer crosses the prefix↔name boundary, restarting the sweep
    // mid-flight. Enter/leave don't refire while the pointer moves between
    // children, so the sweep plays once per whole-heading hover.
    <span
      className={`${operator ? "group/operator-heading " : ""}inline-flex items-center min-w-0`}
      onMouseEnter={sweep.playDeferred}
      onMouseLeave={sweep.resolve}
    >
      {/* Static `Tab:` prefix — a sibling OUTSIDE the button so clicking
          it never starts an edit; hidden below `sm` (mobile keeps just the
          name). Its content rides the same sweep so the one cursor crosses it,
          but it is NOT a click target — only the button below enters edit. */}
      <HeadingPrefix cells={prefixCells} scrambling={sweep.scrambling} />
      {operatorIcon}
      <Tip label="Click to rename">
      <button
        type="button"
        onClick={startEdit}
        aria-label={`Rename tab ${name}`}
        // The heading is the mobile leaf and the primary rename affordance
        // there, so give it a touch-sized tap target on coarse pointers
        // (matches the top-bar control convention `coarse:min-h-[30px]`);
        // inline-flex centers the truncated name vertically within the taller
        // target. The container keeps its REST color throughout the sweep — the
        // green lives ONLY on the per-cell churn/cursor spans (SweepCells), so
        // resolved cells settle to `text-text-primary` as the cursor passes
        // rather than the whole name flashing accent-green (260704-pr0p rework).
        className="max-w-[16ch] sm:max-w-[28ch] text-sm font-semibold text-text-primary inline-flex items-center coarse:min-h-[30px]"
      >
        {/* Truncation lives on an inner span, NOT the button: text-overflow is
            inert on a flex container, and the flex centering clipped long names
            on BOTH ends (riff-blustery-whale → "iff-blustery-whal", no
            ellipsis). The span is left-anchored, so a long name keeps its head
            and cuts at the tail with an ellipsis; the button (and heading)
            itself stays centered in the bar's grid cell. */}
        <span className="min-w-0 truncate">
          <SweepCells cells={nameCells} scrambling={sweep.scrambling} />
        </span>
      </button>
      </Tip>
    </span>
  );
}

/**
 * Display-only universal center heading for board / server / host (change
 * 260704-pr0p). Renders the same boot sweep as `WindowHeading` but with NO
 * rename affordance (board has no rename API; the server/board name is
 * display-only). Two shapes:
 *  - prefixed: a static `PageType:` sibling span + the boot-swept name
 *    (`Board: <board>`, `tmux Server: <server>`).
 *  - solo: just the type word swept alone (`Host`) — no prefix, no name; it
 *    is the leaf/name-equivalent, so it stays visible at all breakpoints and
 *    renders primary-medium (PageHeading's solo rule).
 *
 * Hover replays the sweep behind the 140ms intent delay; mouseleave resolves to
 * rest; the sweep plays once on MOUNT and once on every later name change;
 * reduced motion skips the sweep entirely. Not remounted per route so a name
 * change replays instead of a fresh mount re-seeding the prev-name ref.
 *
 * A11y: the identity carries a STABLE `aria-label` (the churn glyphs are
 * `aria-hidden` inside SweepCells). The label sits on a `role="group"` wrapper
 * — `aria-label` is prohibited on the implicit `role="generic"` of a bare
 * `<span>`/`<div>` (ARIA 1.2), and `group` names the prefix+name as one
 * identity atom WITHOUT introducing a document-outline heading (intake
 * assumption #18: no `<h1>`/heading is added to the top bar).
 */
function PageHeadingDisplay({
  prefix,
  name,
  solo = false,
  ariaLabel,
}: {
  prefix: string;
  name: string;
  solo?: boolean;
  ariaLabel: string;
}) {
  const sweep = useBootSweep(prefix, name, solo);
  // Seeded `null` so the name-effect fires ONCE on mount — the mount /
  // route-transition replay leg (260704-pr0p rework M1). Headings remount
  // across page types, so without this leg navigating between page types never
  // animated. Mount sets `prevNameRef` to the real name, so only a genuine
  // later name change replays (no mount double-play).
  const prevNameRef = useRef<string | null>(null);

  useEffect(() => {
    if (name !== prevNameRef.current) {
      prevNameRef.current = name;
      sweep.play();
    }
  }, [name, sweep]);

  if (solo) {
    return (
      <span
        role="group"
        aria-label={ariaLabel}
        onMouseEnter={sweep.playDeferred}
        onMouseLeave={sweep.resolve}
        // Container keeps its REST color throughout the sweep; the green lives
        // only on the per-cell cursor span (SweepCells), so the solo word
        // settles to `text-text-primary` cell-by-cell rather than flashing
        // accent-green as a whole (260704-pr0p rework M2).
        className="text-sm font-medium text-text-primary inline-flex items-center coarse:min-h-[30px] whitespace-pre"
      >
        <SweepCells cells={sweep.cells} scrambling={sweep.scrambling} />
      </span>
    );
  }

  const { prefix: prefixCells, name: nameCells } = splitSweepCells(sweep.cells);
  return (
    // role="group" + aria-label: see the component doc comment (ARIA-valid
    // naming without a heading). No flex `gap`: the single prefix↔name
    // separator is the sweep's own `sp` space cell (N4 — a `gap-1` on top of it
    // double-spaced them).
    <span
      role="group"
      aria-label={ariaLabel}
      onMouseEnter={sweep.playDeferred}
      onMouseLeave={sweep.resolve}
      className="inline-flex items-center min-w-0 coarse:min-h-[30px]"
    >
      <HeadingPrefix cells={prefixCells} scrambling={sweep.scrambling} />
      {/* Name keeps its REST color throughout the sweep (green lives only on
          the per-cell churn/cursor spans) so resolved cells settle to
          `text-text-primary` as the cursor passes (260704-pr0p rework M2). */}
      <span className="max-w-[16ch] sm:max-w-[28ch] text-sm font-semibold text-text-primary truncate">
        <SweepCells cells={nameCells} scrambling={sweep.scrambling} />
      </span>
    </span>
  );
}

/**
 * Board-mode LEFT info (260704-pr0p): `{n} pane(s) · {n} server(s) · ⌘[⌘] cycle`.
 * Hidden on `< 640px` via `hidden sm:inline`, matching the chrome mobile-hide
 * pattern. Move-don't-copy: the board name + ▾ switcher moved OUT to the center
 * heading (§ BoardSwitcher), and the old left `Board ▸` home button is gone —
 * the brand crumb is already the home affordance, and a left "Board" word would
 * duplicate the type word now centered. Only the counts/hint stays left
 * (centering it would crowd the center slot).
 */
function BoardModeInfo({
  paneCount,
  serverCount,
  waitingPaneCount,
}: {
  paneCount: number;
  serverCount: number;
  waitingPaneCount: number;
}) {
  const paneNoun = paneCount === 1 ? "pane" : "panes";
  const serverNoun = serverCount === 1 ? "server" : "servers";
  return (
    <span className="hidden sm:inline ml-2 text-xs text-text-secondary">
      {paneCount} {paneNoun} · {serverCount} {serverNoun}
      {/* Attention rollup (260706-y1ar): count of waiting panes on this board.
          Constant-yellow, hidden at 0 (WaitingBadge renders null). */}
      {waitingPaneCount > 0 && (
        <>
          {" · "}
          <WaitingBadge
            count={waitingPaneCount}
            label={`${waitingPaneCount} pane(s) on this board waiting for input`}
          />
        </>
      )}
      {" · ⌘[⌘] cycle"}
    </span>
  );
}

/**
 * Board switcher — the bare-`▾` `BreadcrumbDropdown` beside the centered board
 * heading (260704-pr0p relocated it from the left breadcrumb, mirroring how the
 * window switcher sits beside the WindowHeading). It inherits the shared
 * dropdown a11y (`role="menu"`/`menuitem`, Escape, ArrowUp/Down, outside-click)
 * and keeps the `← Sessions` shortcut in the `action` slot.
 */
function BoardSwitcher({
  boardName,
  boards,
}: {
  boardName: string;
  boards: { name: string }[];
}) {
  const navigate = useNavigate();

  const boardItems: BreadcrumbDropdownItem[] = boards.map((b) => ({
    label: b.name,
    href: `/board/${encodeURIComponent(b.name)}`,
    current: b.name === boardName,
  }));

  const handleNavigate = useCallback(
    (href: string) => {
      // `href` is `/board/{encoded-name}` — decode and route via the typed
      // navigator so route params are validated.
      const match = href.match(/^\/board\/(.+)$/);
      if (match) {
        navigate({ to: "/board/$name", params: { name: decodeURIComponent(match[1]) } });
      }
    },
    [navigate],
  );

  return (
    <BreadcrumbDropdown
      items={boardItems}
      label="board"
      title="Board"
      onNavigate={handleNavigate}
      action={{ label: "← Sessions", onAction: () => navigate({ to: "/" }) }}
      triggerClassName="ml-1 text-text-secondary hover:text-text-primary transition-colors shrink-0"
    />
  );
}

// ThemeToggle, HelpLink, and NotificationControl LEFT this file in 260724-6j1v
// (theme + help chrome moved to the sidebar footer, notifications folded into
// the settings dialog); the footer actions then relocated HERE in 260812-d1at —
// Settings as a right-cluster gear chip, Help/Keyboard/Theme as chevron-menu
// App-section rows. The shared definitions (HELP_URL, NOTIFICATIONS_HELP_URL,
// the theme/help SVGs) live in `components/global-chrome.tsx`.

/**
 * SplitControl — the ONE merged split control (260731-oiho), replacing the two
 * per-direction SplitButtons. A split-button chip (the in-bar `OpenButton`
 * precedent — primary + ▾ share one bordered chip so the pair reads as ONE
 * control at cluster scale):
 *
 *  - PRIMARY segment: split HORIZONTAL (side-by-side, the default) — the
 *    square-split-horizontal glyph, optimistic `splitWindow` call, spinner
 *    while pending.
 *  - ▾ segment: `aria-haspopup="menu"`/`aria-expanded`, opens a small direction
 *    menu listing BOTH `Split horizontal` and `Split vertical` (the complete
 *    option set, split-button convention, default first). Outside `mousedown`
 *    and Escape close; Escape refocuses the ▾.
 *
 * Segments use the segment height (2px shorter than the squares,
 * compensating the bordered wrapper) via the Control primitive's `segment`
 * variant so the chip's TOTAL box matches
 * the square token buttons exactly. Terminal and board modes pass the same
 * `{server, windowId, cwd}` the old per-direction buttons received, so board
 * parity (focusedPane) holds unchanged. The board keybindings that call
 * `executeSplit` directly are independent of this control.
 */
function SplitControl({
  server,
  windowId,
  cwd,
}: {
  server: string;
  windowId: string;
  cwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const { addToast } = useToast();

  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);

  const { execute, isPending } = useOptimisticAction<[boolean]>({
    action: (horizontal) => splitWindow(server, windowId, horizontal, cwd),
    onError: (err) => {
      addToast(err.message || "Failed to split pane");
    },
  });

  // Outside-click + Escape close (the OpenButton popover pattern).
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
        chevronRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [open]);

  const run = (horizontal: boolean) => {
    setOpen(false);
    execute(horizontal);
  };

  // Host-effective split chords for the primary tip's kbd slot and the
  // direction-menu rows' trailing keycaps (260811-0f3d — the OpenButton
  // primary-tip pattern, 260811-ke2s): registry-derived, reflecting rebinds,
  // omitted when unbound/disabled (a keycap advertising a dead chord would
  // lie). The chevron tip stays keycap-free — it opens a menu, no chord.
  const { byAction: keybindingsByAction, host: keybindingHost } = useKeybindings();
  const splitChordFor = (actionId: string) => {
    const binding = keybindingsByAction.get(actionId);
    return binding?.enabled
      ? formatCombo({ code: binding.code, tier: binding.tier }, keybindingHost.platform)
      : undefined;
  };
  const splitHorizontalChord = splitChordFor("split-horizontal");
  const splitVerticalChord = splitChordFor("split-vertical");

  const segmentClass = `rk-glint px-1.5 flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${controlClass({ variant: "segment", rest: "text-text-secondary hover:text-text-primary" })}`;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <span className="inline-flex items-stretch rounded border border-border overflow-hidden">
        <Tip label="Split horizontally" kbd={splitHorizontalChord}>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={isPending}
            aria-label="Split horizontally"
            className={segmentClass}
          >
            {isPending ? <LogoSpinner size={14} /> : <SplitHorizontalGlyph />}
          </button>
        </Tip>
        {/* Tip suppressed while the menu is open (trigger convention). */}
        <Tip label={open ? undefined : "Split… (choose direction)"}>
          <button
            ref={chevronRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={isPending}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Split… (choose direction)"
            className={`rk-glint px-1 border-l flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${controlClass({ variant: "segment", open })}`}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="2,3.5 5,6.5 8,3.5" />
            </svg>
          </button>
        </Tip>
      </span>
      {open && (
        <div
          role="menu"
          aria-label="Split direction"
          // 170px floor + `w-max` (260811-0f3d): the absolutely-positioned menu
          // shrink-wraps against the tiny chip container, so the min-width was
          // the effective width — with the trailing keycaps the rows' content
          // varies per platform (⇧⌘D on mac, Shift+Ctrl+\ elsewhere), so the
          // menu now sizes to its content and the floor only guards the
          // unbound case. Rows never wrap.
          className={`absolute top-full right-0 mt-1 w-max min-w-[170px] ${POPOVER_SHELL}`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => run(true)}
            disabled={isPending}
            className={controlClass({ variant: "menu-row" })}
          >
            <SplitHorizontalGlyph />
            Split horizontal
            {splitHorizontalChord && (
              <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
                {splitHorizontalChord}
              </kbd>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(false)}
            disabled={isPending}
            className={controlClass({ variant: "menu-row" })}
          >
            <SplitVerticalGlyph />
            Split vertical
            {splitVerticalChord && (
              <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
                {splitVerticalChord}
              </kbd>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Best-effort hard reload, Chrome Shift+reload style: a `cache: "reload"`
 * fetch of the current document forces a network round-trip that overwrites
 * the HTTP cache entry, so the follow-up `location.reload()` serves the fresh
 * copy (hashed Vite assets self-bust; the document is the only cacheable
 * stale-able resource). `location.reload(true)` is not an option — the
 * forceGet flag is dead in modern browsers. Reloads regardless of fetch
 * outcome: a force-refresh must never be blocked by a failing network — so the
 * fetch races a short timeout (`fetch` can hang indefinitely on a stalled
 * socket that never resolves *or* rejects, and `.catch` alone would not cover
 * that), and `reload()` fires exactly once whichever settles first.
 */
export function forceReload() {
  const FORCE_RELOAD_TIMEOUT_MS = 3000;
  let timer: ReturnType<typeof setTimeout>;
  Promise.race([
    fetch(window.location.href, { cache: "reload" }).catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, FORCE_RELOAD_TIMEOUT_MS);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    window.location.reload();
  });
}

/**
 * Full-page refresh button — a plain `window.location.reload()` recovery
 * affordance in the top-bar cluster. Shift+click
 * force-reloads (bypasses the HTTP cache via `forceReload`), mirroring
 * Chrome's Shift+reload. Unlike Split / Close there is NO async action to
 * await (the page unloads synchronously), so it deliberately carries no
 * `useOptimisticAction`/`isPending`/`LogoSpinner` and no `disabled` state — a
 * spinner would never meaningfully render. The reload is non-destructive by
 * design (constitution II/VI: state re-derives on load; tmux is unaffected),
 * so no confirmation dialog either. The same action is also reachable from
 * the command palette as "View: Refresh Page" — in AppShell's palette
 * (app.tsx `viewActions`) and, duplicated, in the board route's own palette
 * (board-page.tsx `refreshEntry`); the Host `/` mounts no palette — a
 * pre-existing, out-of-scope limitation (mounting one to add this entry would
 * grow UI surface against constitution IV, Minimal Surface Area).
 */
function RefreshButton() {
  return (
    // The old "(Shift+click: force reload)" parenthetical becomes the tip's
    // dim modifier note (the intake's canonical label + note example).
    <Tip label="Refresh page" note="⇧click: force">
    <button
      type="button"
      onClick={(e) => (e.shiftKey ? forceReload() : window.location.reload())}
      aria-label="Refresh page"
      className={controlClass({ variant: "icon" })}
    >
      <RefreshGlyph />
    </button>
    </Tip>
  );
}

/**
 * Top-bar update chip (L3 right cluster). Self-contained — reads the
 * update-notification state from SessionContext via `useUpdateNotification`
 * (no props threaded through TopBar). In-app
 * only: NO Web Push (update notices must not buzz phones).
 *
 * Rest: `⬆ v{latest}` with green styling + CRT-glint hover (`rk-glint`, the
 * button hover vocabulary). Clicking the chip body triggers POST /api/update and
 * enters a disabled `updating…` state; the daemon restart then drops SSE, and
 * the reconnect's differing `version` drives the reload guard (session-context).
 * A small `✕` dismisses per-version (localStorage `hexokit-update-dismissed`).
 * Renders nothing unless a qualifying, un-dismissed update is pending and the
 * daemon is not the `dev` version.
 */
function UpdateChip() {
  const { showChip, tools, singleRunKit, latest, current, dismissUpdate } = useUpdateNotification();
  // Shared one-click-update behavior (updating state + catch/toast) with the
  // overflow menu's version-row update surface — see useUpdateClick (review M5).
  const { updating, triggerUpdate } = useUpdateClick();

  if (!showChip || tools.length === 0) return null;

  // Presentation (R15): a single run-kit match keeps today's `⬆ v{latest}`
  // with the `v{current} → v{latest}` transition in the title/aria. Any other
  // single tool or multiple tools use a count form `⬆ updates (N)`, and the
  // title/aria names every per-tool transition — the button runs a SCOPED
  // update of exactly these tools, so it must say which tools move.
  const visibleLabel = singleRunKit ? `⬆ v${latest}` : `⬆ updates (${tools.length})`;
  const restLabel =
    singleRunKit && current
      ? `Update HexoKit: v${current} → v${latest}`
      : `Update: ${updateChipToolSummary(tools)}`;

  // No `hidden sm:flex` (review M2 / R14): responsive gating is 100%
  // registry-driven now — below `sm` the chip's registry entry overflows into
  // the chevron menu (its function merges into the version row) rather than
  // vanishing via `display:none`. A CSS-hidden chip would leave a 0-width probe
  // copy corrupting the fit input and render in NEITHER bar nor menu.
  return (
    <span className="flex items-center">
      <Tip label={updating ? "Updating\u2026" : restLabel}>
      <button
        type="button"
        onClick={triggerUpdate}
        disabled={updating}
        aria-label={updating ? "Updating HexoKit" : restLabel}
        className={`flex items-center gap-1 px-1.5 rounded transition-colors text-xs disabled:opacity-60 disabled:cursor-not-allowed ${controlClass({ variant: "icon", box: "height", rest: "border border-accent-green text-accent-green hover:border-accent-green" })}`}
      >
        {updating ? (
          <>
            <LogoSpinner size={12} />
            <span>{"updating\u2026"}</span>
          </>
        ) : (
          <span>{visibleLabel}</span>
        )}
      </button>
      </Tip>
      {!updating && (
        <Tip label="Dismiss update notice">
          <button
            type="button"
            onClick={dismissUpdate}
            aria-label="Dismiss update notice"
            className={`ml-0.5 w-[16px] coarse:w-[20px] flex items-center justify-center rounded text-text-secondary hover:text-text-primary transition-colors text-xs ${controlClass({ variant: "icon", box: "height", glint: false })}`}
          >
            {"\u2715"}
          </button>
        </Tip>
      )}
    </span>
  );
}

/**
 * Board-mode autofit toggle (738w). The shared top-bar toggle vocabulary
 * (rk-glint, `coarse:` touch sizing, `aria-pressed`, pressed-state accent
 * styling) driving the per-board board-autofit preference (owned by
 * `BoardPage` via `useBoardAutofit`, plumbed through the top-bar slot context).
 * When on, board panes stretch to fill the row (≤4 panes) or floor at ~25% and
 * scroll (>4); when off, hand-tuned per-pane widths apply. The same flip is
 * reachable from the palette's `Board: Toggle Autofit` (Constitution V). The
 * icon is a set of columns filling a frame — the "panes fill the row" idea —
 * with the pressed (on) state showing filled columns.
 */
function BoardAutofitToggle({
  autofit,
  onToggle,
}: {
  autofit: boolean;
  onToggle: () => void;
}) {
  return (
    <Tip label={autofit ? "Autofit on (panes fill the row)" : "Autofit off (fixed pane widths)"}>
    <button
      type="button"
      onClick={onToggle}
      aria-label="Toggle board autofit"
      aria-pressed={autofit}
      className={controlClass({ variant: "icon", pressed: autofit })}
    >
      <AutofitGlyph filled={autofit} />
    </button>
    </Tip>
  );
}

// ── Overflow-menu row representations (260715-h1ck) ────────────────────────────
//
// Each right-cluster control that can overflow into the chevron menu renders as
// a labeled `role="menuitem"` row here (change area 4). The rows reuse the same
// underlying actions as their in-bar button forms — clicking a row does exactly
// what clicking the icon button does — so bar↔menu behavior can never drift.

// Menu rows compose via the Control primitive's `menu-row` variant (the
// `MENU_ROW_*` compositions hosted in `control.tsx`) so the row styling stays
// shared (mirrors BreadcrumbDropdown's item classes).

/** Split vertical / horizontal menu row — same optimistic split action as the
 *  in-bar SplitControl (the merged entry's menuRender emits one row per
 *  direction; menu rows stay one-action-per-row, 260731-oiho). */
function SplitMenuRow({
  horizontal,
  server,
  windowId,
  cwd,
}: {
  horizontal?: boolean;
  server: string;
  windowId: string;
  cwd?: string;
}) {
  const label = horizontal ? "Split horizontal" : "Split vertical";
  const { addToast } = useToast();
  const { execute, isPending } = useOptimisticAction<[]>({
    action: () => splitWindow(server, windowId, !!horizontal, cwd),
    onError: (err) => addToast(err.message || "Failed to split pane"),
  });
  // Trailing keycap (260811-0f3d): the effective chord for this direction,
  // registry-derived and omitted when unbound — the SplitControl popover-row
  // treatment applied to the overflow menu's split rows.
  const { byAction: keybindingsByAction, host: keybindingHost } = useKeybindings();
  const binding = keybindingsByAction.get(horizontal ? "split-horizontal" : "split-vertical");
  const chord = binding?.enabled
    ? formatCombo({ code: binding.code, tier: binding.tier }, keybindingHost.platform)
    : undefined;
  return (
    <button type="button" role="menuitem" tabIndex={-1} disabled={isPending} onClick={() => execute()} className={controlClass({ variant: "menu-row" })}>
      {horizontal ? <SplitHorizontalGlyph /> : <SplitVerticalGlyph />}
      {label}
      {chord && (
        <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
          {chord}
        </kbd>
      )}
    </button>
  );
}

/** Fixed-width checkbox row — reflects/toggles the ChromeContext `fixedWidth`
 *  state (`role="menuitemcheckbox"`); the control's only rendering since the
 *  in-bar toggle form was deleted (260814-6b0j). */
function FixedWidthMenuRow() {
  const { fixedWidth } = useChromeState();
  const { toggleFixedWidth } = useChromeDispatch();
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={fixedWidth}
      tabIndex={-1}
      onClick={toggleFixedWidth}
      className={controlClass({ variant: "menu-row", pressed: fixedWidth })}
    >
      {/* Static identity variant — state is carried solely by the trailing ✓
          (leading icon = identity, trailing ✓ = state). */}
      <FixedWidthGlyph />
      <span className="flex-1">Fixed width</span>
      {fixedWidth && <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>✓</span>}
    </button>
  );
}

/** Terminal-font stepper row — inline `−` / value / `+` operating on the
 *  ChromeContext terminalFontSize (TERMINAL_FONT_BOUNDS-clamped); the
 *  control's only chrome rendering since the in-bar Aa popover form was
 *  deleted (260814-6b0j — reset lives in the palette + settings dialog). The
 *  `−` button is the row's first focusable element, so keyboard nav lands
 *  there. */
function TerminalFontMenuRow() {
  const { terminalFontSize } = useChromeState();
  const { increaseTerminalFont, decreaseTerminalFont } = useChromeDispatch();
  const atMin = terminalFontSize <= TERMINAL_FONT_BOUNDS.min;
  const atMax = terminalFontSize >= TERMINAL_FONT_BOUNDS.max;
  const stepClass = controlClass({ variant: "icon", glint: false, disabled: false });
  return (
    <div role="group" aria-label="Terminal font size" className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-secondary">
      <TerminalFontGlyph />
      <span className="flex-1">Terminal font</span>
      <button type="button" tabIndex={-1} onClick={decreaseTerminalFont} disabled={atMin} aria-label="Decrease terminal font" className={stepClass}>
        −
      </button>
      <span className="min-w-[4ch] text-center tabular-nums text-text-primary select-none" aria-label={`Terminal font size ${terminalFontSize} pixels`}>
        {terminalFontSize}px
      </span>
      <button type="button" tabIndex={-1} onClick={increaseTerminalFont} disabled={atMax} aria-label="Increase terminal font" className={stepClass}>
        +
      </button>
    </div>
  );
}

/** Autofit-panes checkbox row (board mode) — mirrors the in-bar BoardAutofitToggle. */
function AutofitMenuRow({ autofit, onToggle }: { autofit: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={autofit}
      tabIndex={-1}
      onClick={onToggle}
      className={controlClass({ variant: "menu-row", pressed: autofit })}
    >
      {/* Static identity variant (unfilled frame) — state stays on the ✓. */}
      <AutofitGlyph />
      <span className="flex-1">Autofit panes</span>
      {autofit && <span aria-hidden="true" className={MENU_ROW_CHECK_MARK}>✓</span>}
    </button>
  );
}

/** Close-pane row — the control's only rendering since the in-bar ✕ form was
 *  deleted (260814-6b0j). Terminal mode: a real close-pane on the current
 *  window's active pane. Board mode (co9z): `onRequestKill` opens BoardPage's
 *  consequence-gated kill dialog instead, and the row reads "Kill";
 *  `disabled` when the board is empty. */
function ClosePaneMenuRow({
  server,
  windowId,
  disabled,
  onRequestKill,
  label = "Close pane",
}: {
  server?: string;
  windowId?: string;
  disabled?: boolean;
  /** Board mode (co9z): when present, open BoardPage's confirm dialog instead of
   *  firing closePane directly. */
  onRequestKill?: () => void;
  label?: string;
}) {
  const { addToast } = useToast();
  const { execute, isPending } = useOptimisticAction<[]>({
    action: () => closePane(server ?? "", windowId ?? ""),
    onError: (err) => addToast(err.message || "Failed to close pane"),
  });
  // Keep the row label coupled to the actual click behavior: "Kill" only holds
  // when `onRequestKill` routes to the confirm dialog; without it the click is a
  // plain close-pane, so the label must say so (co9z).
  const effectiveLabel = onRequestKill ? label : "Close pane";
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled || isPending}
      onClick={() => (onRequestKill ? onRequestKill() : execute())}
      className={controlClass({ variant: "menu-row" })}
    >
      <ClosePaneGlyph />
      {effectiveLabel}
    </button>
  );
}

/** Refresh-page row — plain click reloads, Shift+click force-reloads (same as
 *  the in-bar RefreshButton). Labeled "Refresh page" to disambiguate from the
 *  `Status: Refresh` palette action (260715-jykd), assumption #12. */
function RefreshMenuRow() {
  return (
    <Tip label="Refresh page" note="⇧click: force">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={(e) => (e.shiftKey ? forceReload() : window.location.reload())}
        className={controlClass({ variant: "menu-row" })}
      >
        <RefreshGlyph />
        Refresh page
      </button>
    </Tip>
  );
}

/** Host-effective chord for a registry-bound action (the sidebar footer's
 *  derivation, 260801-mqim): reflects per-platform tiers and user overrides;
 *  undefined when the binding is unbound/disabled so no dead chord is
 *  advertised (a tip/row advertising a dead chord would lie). */
function useActionChord(actionId: string): string | undefined {
  const { byAction, host } = useKeybindings();
  const binding = byAction.get(actionId);
  return binding?.enabled
    ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform)
    : undefined;
}

/** Settings gear (260812-d1at) — the sidebar footer's gear relocated to the
 *  top-bar right cluster, immediately before the overflow chevron. Opens the
 *  single AppLayout-mounted settings dialog via `useSettingsDialog()` (the
 *  same seam the footer used — no new event). The LAST fit candidate, so it
 *  survives longest in-bar and degrades to the Settings menu row under width
 *  pressure. */
function SettingsGearButton() {
  const { openSettings } = useSettingsDialog();
  const chord = useActionChord("settings-open");
  return (
    <Tip label="Settings" kbd={chord}>
      <button
        type="button"
        onClick={() => openSettings()}
        aria-label="Open settings"
        className={controlClass({ variant: "icon" })}
      >
        <GearIcon size={14} />
      </button>
    </Tip>
  );
}

/** Settings row — the gear's menu fallback when the chip overflows. */
function SettingsMenuRow() {
  const { openSettings } = useSettingsDialog();
  const chord = useActionChord("settings-open");
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => openSettings()}
      className={controlClass({ variant: "menu-row" })}
    >
      <GearIcon size={14} />
      <span className="flex-1">Settings</span>
      {chord && (
        <kbd aria-hidden="true" className={MENU_ROW_KBD_CLASS}>
          {chord}
        </kbd>
      )}
    </button>
  );
}
