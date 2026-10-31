/**
 * Pure helpers for the window-view lens model (change 260714-t97o-web-view-lens).
 *
 * The model (docs/specs/window-views.md): a window ROW is a substrate (a tmux
 * pane); a VIEW is a lens over one derivable output of that pane. Which lenses a
 * window offers is a capability set derived from window options (Constitution
 * II/X); which lenses are on screen is shared tab state — the `@rk_win_layout`
 * window option, read via `surface-layout.ts`'s `effectiveLayout`.
 *
 * Everything here is pure and DOM-free (the localStorage read is a thin
 * try/catch wrapper) — the same pure-helper + colocated-unit-test pattern as
 * `window-transition.ts` / `navigation.ts`. This module owns the capability
 * predicates and the active-web-tab selector so the rail, the layout, and the
 * palette share one capability source (no drift) with no React/DOM dependency.
 * The retired stored-view key survives one release as an inbound-only
 * translation input.
 */

/**
 * A lens over a window's substrate. `tty`, `web`, `code`, and `gui` are
 * implemented; the registry (spec § The View Registry) is open-ended — a new
 * lens adds a member here and a capability in `availableViews`.
 */
export type ViewName = "tty" | "web" | "code" | "gui";

/**
 * The host-global gui signal the availability helpers consult. Absent/null
 * means no signal has arrived yet, which reads as NOT available — the gui
 * surface is never on by default, and a late replay must not flash a button.
 * Only `enabled` gates availability; reachability/backend/viewers select the
 * tile's content, never its existence.
 */
export type GuiHost = { enabled: boolean } | null | undefined;

export function hasGui(host: GuiHost): boolean {
  return host?.enabled === true;
}

/**
 * The minimal window shape the view helpers need. Structural (assignable from
 * `WindowInfo`) so these stay pure and easy to unit-test without constructing a
 * whole `WindowInfo`. Field semantics mirror the backend `Window` struct
 * (`internal/tmux/tmux.go`): `layout` is the tab's shared surface layout from
 * `@rk_win_layout` ("" renders `single:tty`; read-side tolerant, consumers
 * parse), `webTabs` the dense `@rk_win_web_<n>` URL family with `webActive` its
 * 1-based active slot, `codeRoot` the code surface's folder from
 * `@rk_win_code_root`, and `gitRoot` the backend-derived code folder (the
 * window's active-pane cwd walked to its repo root, falling back to the raw
 * cwd when outside any repo) — the code lens's other availability half that
 * lives per-window.
 */
export type ViewWindow = {
  layout?: string;
  webTabs?: string[];
  webActive?: number;
  codeRoot?: string;
  gitRoot?: string;
};

/**
 * The capability ordering: `availableViews` filters the window's lenses
 * through this list, so the switcher segment order is stable and
 * registry-driven. `code` sits ahead of `web` and `tty` here for ORDERING
 * only — neither availability nor on-screen state is implied.
 */
const HINT_ORDER: ViewName[] = ["code", "gui", "web", "tty"];

/**
 * Whether a window carries at least one web tab (the `@rk_win_web_<n>` family
 * non-empty). This is the web surface's CONTENT selector (onboarding state vs
 * live iframe) and its toggle-dot signal — NOT its availability gate: web is
 * always available (the code-surface availability-vs-reachability split).
 */
export function hasWebUrl(win: ViewWindow | null | undefined): boolean {
  return (win?.webTabs?.length ?? 0) > 0;
}

/**
 * The URL the web surface shows: the `webActive` slot of the tab family
 * (1-based; a 0/absent pointer reads slot 1, matching the backend's clamp).
 * An empty family or an out-of-range pointer yields "" — the onboarding
 * state.
 */
export function activeWebUrl(win: ViewWindow | null | undefined): string {
  const tabs = win?.webTabs ?? [];
  const active = win?.webActive ?? 0;
  return tabs[(active >= 1 ? active : 1) - 1] ?? "";
}

/**
 * Whether a window offers the code lens (spec right-panel.md § Surface
 * Registry): AVAILABILITY = a shared code root (`@rk_win_code_root`) OR the
 * derived `gitRoot` is non-empty. The shared root keeps a tab code-capable
 * after its active pane `cd`s out of the repo (the latch's stable-availability
 * contract). code-server REACHABILITY is deliberately NOT part of this gate —
 * it fluctuates, and gating on it would strobe the switcher; reachability
 * instead selects the surface's CONTENT (live iframe vs the not-running empty
 * state). The single source of truth for code availability — `availableViews`
 * and `right-panel.ts`'s `availableSurfaces` both key off it.
 */
export function hasCode(win: ViewWindow | null | undefined): boolean {
  return ((win?.codeRoot || win?.gitRoot) ?? "").length > 0;
}

/**
 * The capability set a window offers (spec R1/R3). `tty` is ALWAYS available;
 * `web` is ALWAYS available too — like `tty`, the lens exists on every window;
 * `hasWebUrl` selects its CONTENT (onboarding vs live iframe), never its
 * availability (the code-surface availability-vs-reachability split); `code`
 * is available exactly when `hasCode` holds; `gui` exactly when the host
 * signal's `enabled` is true (`hasGui`) — a per-HOST capability threaded in
 * as the optional second arg, absent reading as unavailable. Capabilities are
 * orthogonal and stack (spec R5). Returned in the registry's fixed order
 * (HINT_ORDER).
 */
export function availableViews(
  win: ViewWindow | null | undefined,
  host?: GuiHost,
): ViewName[] {
  const views: ViewName[] = [];
  if (hasCode(win)) views.push("code");
  if (hasGui(host)) views.push("gui");
  views.push("web");
  views.push("tty");
  // Return in HINT_ORDER so the switcher segment order is stable/registry-driven.
  return HINT_ORDER.filter((v) => views.includes(v));
}

/**
 * Value-bearing per-window localStorage key (spec R2). RETIRED as view state:
 * it survives one release as an inbound-only translation input — the
 * route-entry translation effect reads it (via `readStoredView`), translates
 * it into `@rk_win_layout`, and deletes it. Nothing else reads or writes it.
 */
export function windowViewStorageKey(server: string, windowId: string): string {
  return `runkit-window-view:${server}:${windowId}`;
}

/**
 * Read the persisted last-view for a window — a one-release translation input
 * (see `windowViewStorageKey`). Returns `undefined` when absent or when
 * localStorage is unavailable (SSR/jsdom/quota) — the try/catch-noop
 * pattern from `chrome-context.tsx`. The value is NOT validated here; the
 * translation consumer parses + degrades it.
 */
export function readStoredView(
  server: string,
  windowId: string,
): string | undefined {
  try {
    return localStorage.getItem(windowViewStorageKey(server, windowId)) ?? undefined;
  } catch {
    return undefined;
  }
}
