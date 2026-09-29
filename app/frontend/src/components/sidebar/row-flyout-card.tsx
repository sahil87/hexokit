import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  useFloating,
  offset,
  flip,
  shift,
  size,
  arrow,
  FloatingArrow,
  useHover,
  useFocus,
  useDismiss,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
  safePolygon,
  autoUpdate,
} from "@floating-ui/react";
import { PinIcon } from "@/components/pin-icon";
import { CloseIcon, PaletteIcon } from "./icons";
import { getFabParts, getOperatorParts, getPrSegments } from "./registers";
import type { OperatorLoopFacts } from "./registers";
import { FAB_STATE_COLORS } from "@/components/pr-status-model";
import { PopupTitleBar, PopupTitleBarSecondary, notchFill } from "./popup-title-bar";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { formatDuration } from "@/lib/format";
import type { WindowInfo } from "@/types";

/**
 * Row-hover register flyout card (93dy) — the sidebar's tier-2 hover-card and
 * the app's one status-detail hover surface. ONE shared card shell serves every
 * row tier: the WINDOW, SESSION and SERVER cards all open on fine-pointer
 * WHOLE-ROW hover, keyboard row focus (the roving-tabindex treeitem —
 * Constitution V), and the coarse rail tap/scrub (`openNow`); the SERVER panel
 * tile hosts the same server card as a fourth surface, fine-pointer hover/focus
 * only (no rail — its consumer suppresses the card on coarse pointers).
 *
 * Placement is pointer-conditional inside the one hook: on FINE pointers the
 * card anchors to the ROW element with `placement: "right"` +
 * `FloatingPortal`, so its x-position is FIXED at the sidebar's right edge
 * and only its y tracks the hovered row — no mouse-following jitter; on
 * COARSE pointers it anchors BELOW the
 * row (`bottom-start`, `top-start` fallback) with its width capped short of
 * the row's 56px status rail, so the finger's column stays visible mid-scrub.
 * The window card's body is the `fab` and `pr` registers ONLY — the row
 * already carries the window name, the status dot, the PR glyph and the
 * colour label, so the `out`/`agt` registers and the dot label would restate
 * it. The registers are composed from the parts resolvers in ./registers.ts
 * (one source, no drift): the `fab` register leads with `id · stage · state`
 * and drops its slug to an indented `pl-[4ch]` line where truncation costs
 * nothing, the `pr` register stays a single anchored line, and a window with
 * neither a change nor a PR renders NO body — title bar and action rows only. Plus the identity title bar
 * (`Window @N · pane %N · N panes` — the
 * shared `PopupTitleBar` chrome, carrying only the ⓘ docs affordance on its
 * right edge) and the sectioned action rows (change color /
 * fork / pin / kill with sub-hints — one home per action, both pointer
 * worlds). Session/server cards carry the same chrome with their own title,
 * one facts line, and their own action rows. Registers are read-only text;
 * the PR/docs links and the action rows are the card's only interactive
 * elements.
 *
 * PERF (ui-patterns § Render Performance — hard constraints): everything here
 * is row-local. The open state lives inside the consuming `WindowRow` via
 * `useRowFlyout` (never lifted to `Sidebar`), and the card body mounts ONLY
 * while open. The card holds NO clock at all: every line is static text
 * derived from the already-passed `win`, so nothing here ticks even while a
 * card is open. Do not reintroduce a `useNow()` consumer — a live elapsed
 * value belongs in the PANE panel, which is a single instance.
 */

/** Hover open delay outside a warm window (Tip is 300ms; the card is heavier
 *  than a tier-1 tip and interactive, so the first open is deliberate — it
 *  should not flash on drive-by pointer sweeps. Warm retargets stay instant,
 *  so only the first hover pays this). */
export const FLYOUT_OPEN_DELAY_MS = 500;

/** Width of the coarse-pointer status rail (rendered by every rail-bearing
 *  row tier — window-row.tsx, session-row.tsx, index.tsx ServerGroup). The
 *  coarse card's max-width is capped at row-width minus this (plus a gap) so
 *  the card never covers the rail — the finger's column stays visible and
 *  touchable mid-scrub. The window row's `coarse:pr-[56px]` padding reserve
 *  (and the session/server equivalents) is the SAME value as a literal class
 *  (Tailwind scans literals only). */
export const STATUS_RAIL_WIDTH_PX = 56;
/** How long the flyout cluster stays "warm" (instant retarget) after the last
 *  card closes — the same 500ms window `TipGroup` uses. */
export const FLYOUT_WARM_WINDOW_MS = 500;

/**
 * Status-dot docs page (rendered by GitHub). Opens in a new tab from the
 * card's docs icon — the canonical "what does this dot mean" reference.
 * docs/site is NOT served by the backend, so we link the GitHub blob (no
 * anchor → lands at the top of the doc), matching the convention the only
 * other in-app docs link uses (global-chrome.tsx NOTIFICATIONS_HELP_URL).
 * (Migrated verbatim from the retired status-dot-tip.tsx.)
 */
export const STATUS_DOT_DOCS_URL =
  "https://github.com/sahil87/hexokit/blob/main/docs/site/status-dot.md";

// ── Shared warm-window / single-open coordination ──────────────────────────
//
// The flyout's own delay-group scope — a SIBLING mechanism to `TipGroup`, kept
// deliberately OUT of React context: `useDelayGroup` binds to the nearest
// `FloatingDelayGroup`, and the sessions tree renders tier-1 `Tip`s (session
// rows) inside the same subtree, so a nested provider would capture those tips
// and mix tier-1/tier-2 warmth. Module state spans every window row (they all
// import this module) and floating-ui's function-form `delay` option is
// evaluated at EVENT time, so warmth is always current without re-renders.

/** The currently open flyout's closer (also the "something is open" signal). */
let activeFlyout: { close: () => void } | null = null;
/** Epoch ms of the last flyout close — drives the warm window. */
let lastClosedAt = 0;
/** True while a rail scrub gesture is in flight. Pointer capture retargets
 *  (and refires) boundary events onto the captured row's ancestor chain, so a
 *  mid-scrub `mouseenter` on the SOURCE row would otherwise hover-open its
 *  card back over the scrub's retarget — hover/focus opens are blocked while
 *  this holds (the scrub's own `openNow` calls carry no reason and pass). */
let scrubActive = false;

/** Warm = another card is open right now, or one closed <500ms ago. */
function flyoutIsWarm(): boolean {
  return activeFlyout !== null || Date.now() - lastClosedAt < FLYOUT_WARM_WINDOW_MS;
}

/** Event-time delay resolver handed to `useHover` (function form — evaluated
 *  per interaction, so a warm state set by ANOTHER row is seen immediately). */
export function flyoutOpenDelay(): { open: number; close: number } {
  return { open: flyoutIsWarm() ? 0 : FLYOUT_OPEN_DELAY_MS, close: 0 };
}

/** Test seam: reset the module-scoped warm/single-open state between tests. */
export function resetFlyoutWarmState(): void {
  activeFlyout = null;
  lastClosedAt = 0;
  scrubActive = false;
  flyoutScrubTargets.clear();
}

// ── Scrub registry ─────────────────────────────────────────────────────────
// Slide-to-scrub (coarse pointers): the row's tap-zone gesture hit-tests the
// finger position and retargets the single-open card across rows — ACROSS
// TIERS (window, session, server-group rows all register here). Element-
// keyed module state beside the warm/single-open coordinator — no context, no
// lifted state, no re-renders (the § Render Performance constraints).

/** Row root element → that row's imperative open, for scrub retargeting. */
const flyoutScrubTargets = new Map<HTMLElement, () => void>();

/** The ONE hit-test selector for rail-bearing row roots. The three tiers have
 *  three DOM shapes (window rows are `treeitem` + `data-window-id`, session
 *  rows `treeitem` + `data-session-row`, server-group headers not treeitems at
 *  all), so a shared data attribute is the only shape covering all three — and
 *  BOTH gesture ends (each tier's scrub start-handler `closest` inside
 *  `useRailScrub`, and `scrubTargetAt` below) select on it IDENTICALLY by
 *  construction. */
export const RAIL_ROW_SELECTOR = "[data-rail-row]";

/** Hit-test a scrub position: the registered rail row under the point plus
 *  its imperative open, or null over non-row elements (gaps, the open card
 *  itself) and rows without a registered flyout — the caller leaves the
 *  current card open on null (no flicker-close). */
export function scrubTargetAt(
  clientX: number,
  clientY: number,
): { row: HTMLElement; open: () => void } | null {
  const hit = document.elementFromPoint(clientX, clientY);
  const row = hit?.closest<HTMLElement>(RAIL_ROW_SELECTOR) ?? null;
  if (!row) return null;
  const open = flyoutScrubTargets.get(row);
  return open ? { row, open } : null;
}

/**
 * The slide-to-scrub gesture (coarse pointers), shared by every rail-bearing
 * row tier so the trio lives in exactly one place: the target's pointerdown
 * stops propagation, opens this row's card via `openNow`, and captures the
 * pointer; while captured, pointermove hit-tests the finger position via
 * `scrubTargetAt` and retargets the single-open card across rows AND tiers;
 * pointerup/pointercancel releases the capture and the last card STAYS open
 * (dismissal is the existing `useDismiss` outside-press). The scrub NEVER
 * selects, navigates, or toggles a row. Spread `handlers` onto a tier's rail
 * element (and the window row's secondary dot tap zone); `touch-action: none`
 * on the target keeps a press-and-slide from scrolling the drawer.
 */
export function useRailScrub(openNow: () => void) {
  const activeRef = useRef(false);
  const rowRef = useRef<HTMLElement | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.stopPropagation();
      activeRef.current = true;
      // Blocks hover/focus opens mid-scrub: pointer capture refires boundary
      // events on the captured row's chain, and a stray `mouseenter` there
      // must not steal the card back from the scrub's retarget.
      scrubActive = true;
      rowRef.current = e.currentTarget.closest(RAIL_ROW_SELECTOR);
      openNow();
      // jsdom lacks the pointer-capture APIs — optional-call so unit tests can
      // drive the gesture without stubbing them.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [openNow],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!activeRef.current) return;
    const target = scrubTargetAt(e.clientX, e.clientY);
    // Non-row elements under the finger leave the current card open — no
    // flicker-close.
    if (!target || target.row === rowRef.current) return;
    rowRef.current = target.row;
    target.open();
  }, []);
  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    rowRef.current = null;
    scrubActive = false;
    // hasPointerCapture guard (as in surface-layout.tsx): release throws
    // NotFoundError when the capture was never taken or was already released
    // implicitly (pointercancel). Optional-call keeps jsdom unit tests working.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // An unmount mid-scrub (SSE churn) must not leak the in-flight flag.
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        activeRef.current = false;
        rowRef.current = null;
        scrubActive = false;
      }
    };
  }, []);

  return {
    /** True while a scrub gesture is in flight — a draggable row's drag-start
     *  handler reads it so an active touch scrub never escalates into an
     *  HTML5 row drag. */
    scrubActiveRef: activeRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

// ── Rail band tints (held highlight + per-tier bands) ──────────────────────
// One shade-derivation idiom for every tier's rail: the inset base mixed with
// the tier's own tint via `color-mix` (the window rail's shipped selected
// variant). No new color tokens.

/** Rest-state rail band for a tinted tier: the inset base mixed with the
 *  tier's rest tint (session `tint.base`, server header base/selected, the
 *  selected window row's selected shade). Untinted tiers keep the plain
 *  `bg-bg-inset` class and call this never. */
export function railRestBand(restTint: string): string {
  return `color-mix(in srgb, var(--color-bg-inset) 55%, ${restTint})`;
}

/** Held-rail band: while the row's card is open (tap-held or mid-scrub) the
 *  band steps up one shade — a deeper tint share of the tier's step-up shade
 *  (the hover tint, or the selected tint on an already-selected row). Keyed on
 *  the row-local flyout open state, so it travels row-to-row with the
 *  single-open card during a scrub. */
export function railHeldBand(stepUpTint: string): string {
  return `color-mix(in srgb, var(--color-bg-inset) 40%, ${stepUpTint})`;
}

/** The held rail's brightened seam — an existing token, brighter than
 *  `--color-border` (no new tokens). */
export const RAIL_HELD_SEAM = "var(--color-text-secondary)";

/**
 * Fork-conversation glyph — a git-fork shape (one trunk splitting into a branch
 * that rises to its own node). Same inline-SVG idiom and 12px box as `InfoIcon`
 * below, so the two header affordances read as one cluster.
 */
function ForkIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className="shrink-0"
    >
      {/* Trunk (bottom node up to the split) + the branch curving to its own
          node at the top right. Node circles are stroked, matching InfoIcon. */}
      <circle cx="5" cy="13" r="1.6" />
      <circle cx="5" cy="3" r="1.6" />
      <circle cx="12" cy="3" r="1.6" />
      <line x1="5" y1="4.6" x2="5" y2="11.4" />
      <path d="M10.4 3H8.5A3.5 3.5 0 0 0 5 6.5V8" />
    </svg>
  );
}

/**
 * Circled-"i" info glyph for the docs affordance — an inline SVG (matching the
 * codebase's hand-built SVG icons) rather than a Nerd Font glyph, so it renders
 * crisply at any size, themes via `currentColor`, and doesn't depend on the
 * user's terminal font being patched. (Migrated from status-dot-tip.tsx.)
 */
function InfoIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6.5" />
      <line x1="8" y1="7.25" x2="8" y2="11" strokeLinecap="round" />
      <circle cx="8" cy="4.75" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}


/** One register line: fixed-width prefix + read-only content. The prefix
 *  column follows the PANE panel's 4-advance vocabulary (3-char key + space;
 *  `pr` is NBSP-padded to the same column). `min-w-0 truncate` matches the
 *  panel rows these registers were promoted from (status-panel.tsx) — long
 *  `fab`/`pr` text must ellipsize inside the `max-w-xs` card, never paint
 *  outside it. `stale` marks the line with `data-stale` and dims its content
 *  (the NoteLine stale idiom) — the caller dims the value span itself. */
function RegisterLine({
  prefix,
  testid,
  stale = false,
  children,
}: {
  prefix: string;
  testid: string;
  stale?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="min-w-0 truncate" data-testid={testid} data-stale={stale ? "true" : undefined}>
      <span className="text-text-secondary">{prefix}</span>
      {children}
    </span>
  );
}

/** A register's overflow line, indented to the same 4-advance column the
 *  prefixes establish. Truncating is harmless here by construction: the
 *  register's decisive tokens lead on its first line, so only the expendable
 *  value (the slug, the health facts) can be cut. */
function ContinuationLine({ testid, children }: { testid?: string; children: ReactNode }) {
  return (
    <span className="min-w-0 truncate pl-[4ch] text-text-secondary" data-testid={testid}>
      {children}
    </span>
  );
}

/** Notes older than this render dimmed — faded, never hidden; notes never
 *  auto-expire client-side (only an overwrite or explicit clear removes one). */
export const NOTE_STALE_SECONDS = 24 * 3600;

/** The window card's note register — the `@rk_win_note` one-line status note plus
 *  its relative age (`blocked on flaky e2e · 2h ago`). Degrade-to-absent: no
 *  `note` on the payload renders nothing. Epoch-0 (tolerant-parse) notes
 *  render text-only, undimmed. Static text derived from the already-passed
 *  `win` — the card holds no clock, so the age is as of the last SSE frame
 *  (the render-performance contract, same as every other register line). */
/** The one-line `@rk_win_note` rendering idiom — `note <text> · <age> ago`,
 *  stale-dimmed. Shared by this card's note register and the sidebar pinned
 *  operator row's pulse line. */
export function NoteLine({ win }: { win: WindowInfo }) {
  if (!win.note) return null;
  const epoch = win.noteEpoch ?? 0;
  const ageSeconds = epoch > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - epoch) : null;
  const stale = ageSeconds !== null && ageSeconds > NOTE_STALE_SECONDS;
  return (
    <span
      className={`min-w-0 truncate ${stale ? "opacity-50" : ""}`}
      data-testid="row-flyout-note"
      data-stale={stale ? "true" : undefined}
    >
      <span className="text-text-secondary">{"note "}</span>
      <span className={stale ? "text-text-secondary" : "text-text-primary"}>
        {win.note}
        {ageSeconds !== null && (
          <span className="text-text-secondary">{` · ${formatDuration(ageSeconds)} ago`}</span>
        )}
      </span>
    </span>
  );
}

/** Tooltip/aria copy for the fork affordance. Names the SAME-DIRECTORY semantics
 *  explicitly — that is what distinguishes a fork (branch this conversation
 *  here) from the spawn dialog (a fresh agent, usually in a new worktree). */
export const FORK_TOOLTIP = "Fork conversation — new tab, same directory";

/** Fork support follows the window's reconciled conversation provider. */
export function canForkWindow(win: WindowInfo): boolean {
  return win.agentProvider === "claude" || win.agentProvider === "codex";
}

/**
 * The derived availability rule for the window-scoped operator-request
 * affordance (Fix tab name — 260822-fih1) — degrade to
 * ABSENT, never disabled: the row renders only when (a) the server has an
 * operator window, (b) the subject window's reconciled agent identity resolves
 * to a readable conversation (the server-derived `conversationAvailable`
 * capability — an identity-only provider never advertises an action that would
 * predictably 404), and (c) the subject is not itself the operator. All three
 * facts already ride the sessions payload. */
export function canRequestWindowOperatorAction(win: WindowInfo, hasOperator: boolean): boolean {
  return hasOperator && win.conversationAvailable === true && win.role !== "operator";
}

/** Shared geometry for the card's sectioned action rows: full-bleed inside
 *  the action section (which carries the `-mx-2` counter-inset, so the top
 *  border + inter-row hairlines span edge to edge), one line tall — icon +
 *  label left, muted sub-hint right; ≥36px touch height on coarse, ~28px on
 *  fine pointers (the row-cluster touch-target convention). */
export const ACTION_ROW_CLASS =
  "flex w-full items-center gap-1.5 min-w-0 px-2 text-left whitespace-nowrap min-h-[28px] coarse:min-h-[36px] text-text-primary hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] border-l-2 border-l-transparent pl-1.5";

/** The muted per-action sub-hint riding the row's right edge. It is the row's
 *  FLEXIBLE part (`min-w-0 truncate`): inside the `max-w-xs` fine-pointer card
 *  a long hint ellipsizes instead of painting past the card box; the label
 *  (wrapped in a shrink-0 span at each call site) never truncates. */
const ACTION_ROW_HINT_CLASS = "ml-auto min-w-0 truncate pl-2 text-text-secondary";

/** The card's sectioned action list — the `-mx-2` counter-inset (the title
 *  bar's idiom) lets the top border + inter-row hairlines span the card edge
 *  to edge. Shared by all three card tiers.
 *
 *  `flush` is for a card with NO body between the title bar and this list.
 *  The 6px it removes is not padding — it is the title bar's `mb-0.5` plus the
 *  card's `gap-1`, both of which exist to hold a body apart from the two inset
 *  bands. With no body they leave a strip of the card's lighter ground between
 *  two darker ones, reading as an unexplained grey bar. Dropping `border-t`
 *  with it is required, not cosmetic: at zero gap the title bar's own
 *  `border-b` already sits there, and keeping both would double the rule. */
export function CardActionList({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return (
    <div
      className={`-mx-2 -mb-1.5 rounded-b-[5px] bg-bg-inset divide-y divide-border ${
        flush ? "-mt-1.5" : "mt-1 border-t border-border"
      }`}
      data-testid="row-flyout-actions"
    >
      {children}
    </div>
  );
}

/** One row in the card's action list — icon + label left, muted sub-hint
 *  right — shared by all three card tiers so the geometry lives in exactly
 *  one place. stopPropagation so an action never selects/toggles the
 *  underlying row (the PR/docs links' idiom). */
export function CardActionRow({
  icon,
  label,
  hint,
  danger = false,
  testid,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  /** Red hover treatment for destructive actions. */
  danger?: boolean;
  testid: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${ACTION_ROW_CLASS} ${danger ? "hover:text-signal-red hover:border-l-signal-red" : "hover:text-text-primary hover:border-l-accent-green"}`}
      data-testid={testid}
    >
      {icon}
      <span className="shrink-0">{label}</span>
      {hint && <span className={ACTION_ROW_HINT_CLASS}>{hint}</span>}
    </button>
  );
}

/**
 * The fork action row, with its own IN-FLIGHT state so the busy flag is
 * leaf-scoped (the card's render-performance discipline — only this row
 * re-renders while a fork is in flight).
 *
 * The guard is load-bearing, not cosmetic: `onFork` POSTs a mutating endpoint that
 * CREATES a tmux window, so N clicks would create N forks. Disabling until the
 * promise settles is the spawn dialog's `disabled={busy}` idiom; the busy state
 * clears on settle (success and error alike) so a failed fork stays retryable.
 */
function ForkActionRow({ onFork }: { onFork: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // The card unmounts when the flyout closes (and a successful fork navigates
  // away), so a settle after unmount is a real possibility — guard the setState.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <button
      type="button"
      // stopPropagation so forking never also selects the underlying row (the
      // PR/docs links' idiom). The click is a no-op while a fork is in flight —
      // `disabled` already blocks it, this is the belt to that braces.
      onClick={(e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        void onFork().finally(() => {
          if (mountedRef.current) setBusy(false);
        });
      }}
      disabled={busy}
      className={`${ACTION_ROW_CLASS} hover:text-text-primary hover:border-l-accent-green disabled:hover:border-l-transparent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-secondary`}
      aria-label={FORK_TOOLTIP}
      title={FORK_TOOLTIP}
      data-testid="row-flyout-fork-action"
    >
      <ForkIcon />
      <span className="shrink-0">Fork conversation</span>
      <span className={ACTION_ROW_HINT_CLASS}>new tab, same directory</span>
    </button>
  );
}

/**
 * The "Fix tab name" action row (260822-fih1-operator-request-fix-tab-name) —
 * the flyout arm of the operator actuation seam. Fires one operator-request
 * POST (the backend derives every prompt fact server-side) and toasts the
 * outcome; the rename itself arrives later via the normal SSE derive tick, so
 * there is no spinner beyond the in-flight guard. The guard mirrors
 * ForkActionRow's: the POST is mutating, so N clicks must not fire N requests;
 * the busy state clears on settle (success and error alike) so a rejected
 * request stays retryable.
 */
function FixTabNameActionRow({ onFixTabName }: { onFixTabName: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  // The card unmounts when the flyout closes, so a settle after unmount is a
  // real possibility — guard the setState (the ForkActionRow idiom).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <button
      type="button"
      // stopPropagation so the request never also selects the underlying row.
      // The click is a no-op while a request is in flight — `disabled` already
      // blocks it, this is the belt to that braces.
      onClick={(e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        void onFixTabName().finally(() => {
          if (mountedRef.current) setBusy(false);
        });
      }}
      disabled={busy}
      className={`${ACTION_ROW_CLASS} hover:text-text-primary hover:border-l-accent-green disabled:hover:border-l-transparent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-secondary`}
      title="Ask the operator to rename this tab from its transcript"
      data-testid="row-flyout-fix-name-action"
    >
      <WandIcon />
      <span className="shrink-0">Fix tab name</span>
      <span className={ACTION_ROW_HINT_CLASS}>asks the operator</span>
    </button>
  );
}

/** A one-line "fix" glyph — a pencil with a check underline. Same inline-SVG
 *  idiom and 12px box as ForkIcon above. */
function WandIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className="shrink-0"
    >
      <path d="M10.5 2.5l3 3L6 13H3v-3l7.5-7.5z" />
      <path d="M8.5 4.5l3 3" />
    </svg>
  );
}

/**
 * Identity title for the card's title bar: `Window @N · pane %N · N panes` —
 * the tmux window id, the ACTIVE pane's id, and the pane count (all already on
 * the passed `win`). Static text only (the render-performance contract).
 * Degrades by omission: no `panes` (test fixtures, degraded payloads) renders
 * `Window @N` alone; panes without an active one drop just the pane segment.
 */
function WindowFlyoutTitle({ win }: { win: WindowInfo }) {
  const panes = win.panes ?? [];
  const activePaneId = panes.find((p) => p.isActive)?.paneId;
  return (
    <>
      <PopupTitleBarSecondary>Tab </PopupTitleBarSecondary>
      {win.windowId}
      {activePaneId && (
        <>
          <PopupTitleBarSecondary> · pane </PopupTitleBarSecondary>
          {activePaneId}
        </>
      )}
      {panes.length > 0 && (
        <PopupTitleBarSecondary>
          {` · ${panes.length} pane${panes.length === 1 ? "" : "s"}`}
        </PopupTitleBarSecondary>
      )}
    </>
  );
}

/**
 * The window tier's card body — mounted ONLY while the flyout is open, so the
 * freshness line's `useNow()` clock stays leaf-scoped per the
 * render-performance contract. The body is the `fab`, `pr`, and `opr`
 * registers only; a window with none renders no body block at all. The
 * consuming WindowRow builds this via the hook's `content` render prop.
 */
export function WindowFlyoutContent({
  win,
  onChangeColorAction,
  onFork,
  onFixTabName,
  hasOperator = false,
  onPinAction,
  pinned = false,
  pinnedBoard,
  onKillAction,
  operator,
}: {
  win: WindowInfo;
  /** Open the row's combined Label picker (the card's `Change color…` row —
   *  first on every tier's card). The consumer closes the card BEFORE invoking
   *  it (the Pin-row close-then-open idiom). OPTIONAL: a consumer wiring no
   *  color seam renders no row. */
  onChangeColorAction?: () => void;
  onFork?: () => Promise<void>;
  /** Fire the operator-request seam for this window (fix-tab-name). OPTIONAL:
   *  a consumer wiring no seam renders no row. Renders only when the
   *  availability rule holds (canRequestWindowOperatorAction). */
  onFixTabName?: () => Promise<void>;
  /** Whether the server has an operator window — availability input (a) for
   *  the Fix tab name row. */
  hasOperator?: boolean;
  onPinAction?: () => void;
  pinned?: boolean;
  pinnedBoard?: string;
  onKillAction?: () => void;
  /** The owning session's operator-watchdog facts (stale flag verbatim +
   *  last tick) — feeds the `opr` register only; undefined leaves the
   *  register's tick segment absent. */
  operator?: OperatorLoopFacts;
}) {
  const fabParts = getFabParts(win, win.panes?.find((p) => p.isActive)?.gitBranch);
  const prSegments = getPrSegments(win);
  // The card holds no clock (the render-performance contract, same as
  // NoteLine): the `opr` tick age is as of this render frame.
  const operatorParts = getOperatorParts(win, operator, Math.floor(Date.now() / 1000));
  // Stale describes the live watch loop, so it applies only to the watched
  // head — the done head (owner, unmonitored) never dims.
  const oprStale = win.monitored === true && operator?.stale === true;
  // Single-sourced segment JSX shared by the anchor and plain branches below
  // (the panel's segmentSpans idiom — the two renderings can't drift).
  const segmentSpans = prSegments?.map((seg, i) => (
    <span key={seg.text}>
      {i > 0 && <span className="text-text-secondary">{" · "}</span>}
      <span className={seg.color}>{seg.text}</span>
    </span>
  ));
  // Drives both the body block and the action list's `flush` spacing — they
  // must agree, or the card grows a gap with nothing in it.
  const hasBody = Boolean(fabParts || prSegments || win.note || win.monitored || win.owner === "operator");
  // The fork row keeps the DOUBLE gate: a forkable window AND a wired handler.
  // Derived as a narrowed handler (not a boolean) so the ForkActionRow call
  // site type-checks structurally instead of leaning on aliased-condition
  // narrowing, which a refactor could silently break.
  const forkHandler = canForkWindow(win) ? onFork : undefined;
  // The Fix tab name row keeps the same double gate: the derived availability
  // rule (operator present + subject agent session ref + not the operator's
  // own row) AND a wired handler.
  const fixNameHandler = canRequestWindowOperatorAction(win, hasOperator) ? onFixTabName : undefined;

  return (
    <>
      {/* Identity title bar (the card's first element): the static `Window @N`
          title plus the quiet circled-(i) docs link on the bar's right edge.
          Actions (fork/pin/kill) live in the sectioned action list at the
          card's bottom — one affordance, one home. */}
      <PopupTitleBar
        right={
          <a
            href={STATUS_DOT_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center min-w-[24px] min-h-[24px] coarse:min-w-[40px] coarse:min-h-[40px] text-text-secondary hover:text-text-primary"
            aria-label="What do status dots mean? (opens docs)"
            title="What do status dots mean?"
            data-testid="row-flyout-docs-link"
          >
            <InfoIcon />
          </a>
        }
      >
        <WindowFlyoutTitle win={win} />
      </PopupTitleBar>
      {/* The body is the change, its PR, and the operator watchlist — the row
          already carries the
          window name, the status dot, the PR glyph and the colour label, so
          the `out`/`agt` registers and the dot label would restate it.
          Critical tokens lead; expendable values continue on indented lines.
          No body block at all when both resolvers are null (a bare `prUrl`
          without a `prNumber` is not content). */}
      {hasBody && (
        <>
          <NoteLine win={win} />
          {fabParts && (
            <>
              {/* The displayState token renders in the fab hue vocabulary
                  (FAB_STATE_COLORS); an unknown state gets no extra class. The
                  slug rides a continuation line only when the branch does not
                  already carry it (the slug is written once). */}
              <RegisterLine prefix="fab " testid="row-flyout-fab">
                <span className="text-text-primary">
                  {`${fabParts.id} · ${fabParts.stage}`}
                  {fabParts.displayState && (
                    <span className={FAB_STATE_COLORS[fabParts.displayState] ?? ""}>{` · ${fabParts.displayState}`}</span>
                  )}
                </span>
              </RegisterLine>
              {fabParts.slug && (
                <ContinuationLine testid="row-flyout-fab-slug">{fabParts.slug}</ContinuationLine>
              )}
            </>
          )}
          {prSegments && (
            <>
              {/* `pr` register — open-first when a URL exists (the panel's
                  PrLinkRow idiom): the identity line is a real anchor (native
                  middle/Ctrl+click, right-click → copy link) with an
                  always-visible inline `↗` sitting shrink-0 after the
                  truncating segment span, so it hugs the text end and is never
                  eaten by truncation. stopPropagation so opening the PR never
                  selects the underlying row. The health facts and freshness
                  continue as plain text OUTSIDE the anchor, so it never spans
                  two visual rows.
                  Prefix: "pr" + 2 NBSPs = the same 4-advance column as `fab `
                  (and status-panel.tsx's pr rows). Escape sequences, never
                  literal NBSPs - a literal survives careless re-encoding
                  badly (the cycle-1 mojibake). Codepoints pinned by a unit
                  test.
                  Hover geometry: `-mx-2 px-2` mirrors CardActionList's
                  counter-inset and the hover tint matches CARD_ACTION_ROW's,
                  so the highlight paints a full-bleed row like the action
                  rows below — not a text-height strip inset by the card
                  padding. */}
              {win.prUrl ? (
                <a
                  href={win.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={win.prUrl}
                  aria-label={`Open PR #${win.prNumber} in a new tab`}
                  onClick={(e) => e.stopPropagation()}
                  className="group/pr flex items-center min-w-0 -mx-2 px-2 py-0.5 hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] coarse:py-1"
                  data-testid="row-flyout-pr-link"
                >
                  <span className="text-text-secondary shrink-0">{"pr\u00a0\u00a0"}</span>
                  <span data-testid="row-flyout-pr" className="min-w-0 truncate">
                    {segmentSpans}
                  </span>
                  {/* NBSP inside the span — the anchor is a flex container, so a
                      whitespace-only text node between flex items would be dropped. */}
                  <span className="shrink-0 text-text-secondary group-hover/pr:text-text-primary">{"\u00a0↗"}</span>
                </a>
              ) : (
                <RegisterLine prefix={"pr\u00a0\u00a0"} testid="row-flyout-pr">
                  {segmentSpans}
                </RegisterLine>
              )}
            </>
          )}
          {/* `opr` register — the last body register, after the `pr` block.
              Leads with the decisive tokens (`watched · stage · tick age`, or
              the done head for an operator-owned unmonitored window); the
              repo · branch facets continue on an indented line. Stale
              (operator loop's tick overdue) dims the watched head and marks
              the line — the NoteLine stale idiom, never opacity on the
              register. The done head is never stale: a done row has no loop. */}
          {operatorParts && (
            <>
              <RegisterLine prefix="opr " testid="row-flyout-opr" stale={oprStale}>
                <span className={oprStale ? "text-text-secondary" : "text-text-primary"}>
                  {operatorParts.head}
                </span>
              </RegisterLine>
              {operatorParts.facets && (
                <ContinuationLine testid="row-flyout-opr-facets">
                  {operatorParts.facets}
                </ContinuationLine>
              )}
            </>
          )}
        </>
      )}
      {/* Sectioned action rows — the card's last block, rendered for ALL
          pointer types: the color/pin/kill home on coarse (where the in-row
          cluster is fine-pointer-only), additive + Tab-reachable on desktop
          (the FloatingFocusManager order). One row per action in a fixed
          change-color → fork → fix-tab-name → pin → kill order
          (Change color… is the FIRST
          action row of every tier's card). Optional-handler idiom: a consumer
          wiring no handler renders no row. All rows stopPropagation so an
          action never selects the underlying row (the PR-link/docs idiom). */}
      {(onChangeColorAction || forkHandler || fixNameHandler || onPinAction || onKillAction) && (
        <CardActionList flush={!hasBody}>
          {onChangeColorAction && (
            <CardActionRow
              icon={<PaletteIcon />}
              label="Change color…"
              testid="row-flyout-color-action"
              onClick={onChangeColorAction}
            />
          )}
          {forkHandler && <ForkActionRow onFork={forkHandler} />}
          {fixNameHandler && <FixTabNameActionRow onFixTabName={fixNameHandler} />}
          {onPinAction && (
            <CardActionRow
              icon={<PinIcon filled={pinned} />}
              label="Pin to board…"
              hint={pinned ? (pinnedBoard ?? "pinned") : "not pinned"}
              testid="row-flyout-pin-action"
              onClick={onPinAction}
            />
          )}
          {onKillAction && (
            <CardActionRow
              icon={<CloseIcon />}
              label="Kill tab"
              hint="confirms first"
              danger
              testid="row-flyout-kill-action"
              onClick={onKillAction}
            />
          )}
        </CardActionList>
      )}
    </>
  );
}

type UseRowFlyoutOptions = {
  /** Close + inhibit the flyout while true — the consuming row passes its
   *  ghost flag and its popover-open states (`PinPopover` / label / color
   *  `SwatchPopover`), so the card never fights the row's other layers. A
   *  surface with no coarse trigger at all (the SERVER panel tile) also
   *  includes its coarse-pointer flag here, so the card stays a fine-pointer
   *  hover/focus surface there. */
  suppressed?: boolean;
  /** Opt-in for a reference that is NOT full-bleed to the sidebar width (the
   *  SERVER panel tile — a multi-column grid cell). `placement: "right"`
   *  assumes "right of the reference" is the sidebar's right edge; a mid-panel
   *  reference would open the card on top of its grid siblings. The flag
   *  (a) positions against a virtual reference — the reference's y-band at the
   *  sidebar container's right x, derived at position time (never lifted
   *  state) — so the card opens where the full-bleed rows' cards open, and
   *  (b) switches the hover-close polygon to `blockPointerEvents`, so grid
   *  siblings crossed en route to the card fire no hover-open (the warm
   *  window would otherwise let a crossed cell steal the single-open card;
   *  a pointer that STOPS on a sibling still retargets — a stalled pointer
   *  collapses the polygon, unblocking events). Events stay bound to the real
   *  reference node; the coarse arm is unaffected (the one consumer is
   *  fine-pointer-only via `suppressed`). */
  edgeAnchor?: boolean;
  /** The tier's card content, built ONLY while the card is open (the
   *  card-mounts-only-while-open perf contract). Receives `close` so action
   *  rows that hand off to a row popover can run the close-then-open idiom
   *  (close the card BEFORE opening the popover — ordering independent of the
   *  consumer's state-update timing; popover-over-card precedence is held by
   *  the `suppressed` gate including the popover-open state). */
  content: (helpers: { close: () => void }) => ReactNode;
};

type RowFlyout = {
  /** Floating reference setter — attach to the ROW ROOT element. */
  setReference: (node: HTMLElement | null) => void;
  /** Reference interaction props (hover/focus/dismiss wiring) — spread onto
   *  the row root. */
  referenceProps: Record<string, unknown>;
  /** floating-ui's merging reference-props getter — rows that own hover
   *  handlers of their own (the tint mouse-enter/leave) call this so both
   *  handler sets chain instead of the row's clobbering the card's. */
  getReferenceProps: (userProps?: HTMLAttributes<HTMLElement>) => Record<string, unknown>;
  /** The portalled card, or null while closed. Render inside the row. */
  card: ReactNode;
  /** True while the card is open. The row reads this to HOLD its hover tint
   *  while the pointer travels onto the card (the held-row continuity cue) —
   *  the state is row-local, so the open/close re-render never leaves the row. */
  open: boolean;
  /** Imperative open — the coarse-pointer dot-tap trigger. */
  openNow: () => void;
  /** Imperative close — the row calls this on drag start. */
  close: () => void;
};

/**
 * Row-local flyout state + wiring for one rail-bearing row — the ONE shared
 * card shell (placement arms, containment cap, held-state key, portal/focus
 * wiring, notch) consumed by all three tiers, parameterized by tier content.
 * All state lives inside the row (React.memo stays effective; nothing is
 * lifted to `Sidebar`).
 *
 * Triggers: `useHover` (row hover, `mouseOnly` so touch never
 * hover-opens; `safePolygon` bridges row → card so links are clickable; delay
 * via the module-scoped warm window), `useFocus` (keyboard row focus — the
 * roving treeitem; floating-ui's default `visibleOnly` gate keeps
 * pointer/tap-driven focus from opening the card, so the coarse rail
 * tap/scrub stays the one coarse trigger), `useDismiss` (Escape / outside
 * press / blur), plus the exposed `openNow` for the coarse rail/dot tap.
 */
/** The sidebar root the `edgeAnchor` virtual reference measures against — the
 *  full-sidebar-width ancestor whose right edge IS the fixed x every
 *  full-bleed row hands `placement: "right"` (sidebar/index.tsx renders every
 *  flyout consumer inside this `<nav>`). Resolved per positioning pass via
 *  `closest()` from the reference node; a reference outside it falls back to
 *  its own rect (today's geometry). */
export const EDGE_ANCHOR_CONTAINER_SELECTOR = 'nav[aria-label="Sessions"]';

/** floating-ui virtual position reference for `edgeAnchor`: the reference
 *  node's y-band at the sidebar container's right x (degenerate width-0 rect —
 *  the same geometry class a full-bleed row's right edge gives). Both rects
 *  are read inside `getBoundingClientRect` so the position is derived at
 *  measure time; `contextElement` keeps `autoUpdate` observing a real node. */
export function edgeAnchorReference(node: HTMLElement) {
  return {
    contextElement: node,
    getBoundingClientRect() {
      const rect = node.getBoundingClientRect();
      const container = node.closest(EDGE_ANCHOR_CONTAINER_SELECTOR);
      // No container ancestor: today's geometry verbatim — the node's own
      // full rect, exactly as if the opt-in were absent (a width-0 rect here
      // would still alter rects.reference for middleware).
      if (!container) return rect;
      const x = container.getBoundingClientRect().right;
      return {
        x,
        y: rect.y,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        left: x,
        right: x,
        width: 0,
      };
    },
  };
}

export function useRowFlyout({ suppressed = false, edgeAnchor = false, content }: UseRowFlyoutOptions) {
  const [open, setOpen] = useState(false);
  // True once keyboard focus has entered the OPEN card (Tab from the row).
  // Gates FloatingFocusManager's `returnFocus`: a close where focus was
  // inside the card (Escape after tabbing in) must return focus to the row so
  // tree nav continues, but a hover-originated close (sweeping to a sibling
  // row) must NOT move focus — the manager's default returns focus even when
  // nothing was focused (activeElement === body), which yanks focus to the
  // just-left row's button mid-sweep and broke the warm retarget.
  const [focusInsideCard, setFocusInsideCard] = useState(false);

  // Stable per-instance handle for the module-scoped single-open coordinator.
  const selfRef = useRef<{ close: () => void } | null>(null);
  if (selfRef.current === null) {
    selfRef.current = { close: () => setOpen(false) };
  }

  // True when this open was COLD (no card open, warm window expired) — gates
  // the slide-out entrance so warm retargets between rows snap instead of
  // re-animating on every sweep. Captured at the closed→open transition, BEFORE
  // the coordinator update makes the module state warm.
  const coldOpenRef = useRef(false);

  const handleOpenChange = useCallback((next: boolean, _event?: Event, reason?: string) => {
    const self = selfRef.current;
    if (!self) return;
    if (next) {
      // Mid-scrub, hover/focus opens are blocked: pointer capture refires
      // boundary events on the captured (source) row's chain, and a stray
      // `mouseenter` there must not steal the card back from the scrub's
      // retarget. The scrub's own `openNow` calls carry no reason and pass.
      if (scrubActive && (reason === "hover" || reason === "focus")) return;
      // `useFocus` re-fires onOpenChange(true) for focusin bubbling from the
      // card, so only a transition where this card was NOT already the active
      // one counts as a fresh open for the entrance animation.
      if (activeFlyout !== self) coldOpenRef.current = !flyoutIsWarm();
      // Single-open: opening this card closes any other open card (the
      // FloatingDelayGroup "currentId" behavior, module-scoped).
      if (activeFlyout && activeFlyout !== self) activeFlyout.close();
      activeFlyout = self;
    } else if (activeFlyout === self) {
      // Stamp the warm window only when THIS flyout was actually open — a
      // no-op close (e.g. a drag-start before the open delay elapsed, or a
      // close racing another row's open) must not falsely arm the 500ms
      // instant-retarget window.
      activeFlyout = null;
      lastClosedAt = Date.now();
    }
    setOpen(next);
  }, []);

  // Reset the focus-entered flag on each FRESH open, keyed to the real open
  // state — NOT inside handleOpenChange: useFocus re-fires onOpenChange(true)
  // for every focusin that bubbles from the portalled card through the React
  // tree (the card is a React child of the row root), and a reset there would
  // land in the same batch as the capture-phase set and negate it.
  useEffect(() => {
    if (open) setFocusInsideCard(false);
  }, [open]);

  // Suppression (popover open / ghost) closes an open card and, via the
  // `enabled` flags below, inhibits re-opening while it holds.
  useEffect(() => {
    if (suppressed && open) handleOpenChange(false);
  }, [suppressed, open, handleOpenChange]);

  // Unmount while open must not leave the coordinator pointing at a dead row.
  useEffect(() => {
    return () => {
      const self = selfRef.current;
      if (self && activeFlyout === self) {
        activeFlyout = null;
        lastClosedAt = Date.now();
      }
    };
  }, []);

  // Row-aligned notch (E1): the arrow middleware pins a pointer on the card's
  // row-side edge at the ROW's vertical center — the geometric "whose card is
  // this" cue. `shift()` may slide the card along the cross axis at viewport
  // edges; the arrow stays locked to the reference either way.
  const arrowRef = useRef<SVGSVGElement | null>(null);

  const coarsePointer = useCoarsePointer();
  const coarse = coarsePointer;
  const { refs, floatingStyles, context, middlewareData, placement } = useFloating({
    open,
    onOpenChange: handleOpenChange,
    // Fine pointers: fixed-x anchor — the row is full-bleed to the sidebar
    // width, so "right" of the ROW element is the sidebar's right edge,
    // stable across rows. Coarse pointers: the card anchors BELOW the row
    // (the drawer has no free space at either side for a "right" card), with
    // a top-start fallback near the drawer bottom.
    placement: coarse ? "bottom-start" : "right",
    // `fixed` (not the default `absolute`): the card is portalled to
    // document.body, and an absolutely-positioned card whose right edge lands
    // past the viewport GROWS document.body's scrollWidth — horizontal page
    // overflow at narrow widths (CI: top-bar-overflow/-overlap 375px sweeps,
    // body 462px). A fixed-position box is out of the scroll flow, so an
    // off-viewport edge clips instead of widening the page; flip()/shift()
    // keep positioning against the viewport as before.
    strategy: "fixed",
    // arrow() runs after shift() so the notch is positioned against the final
    // shifted card rect (the floating-ui documented order). The coarse arm
    // adds size() AFTER shift(): the containment cap (below) must win over
    // the `max-w-xs`-free width, and shift() keeps the card inside the
    // viewport padding.
    middleware: coarse
      ? [
          offset(6),
          flip({ fallbackPlacements: ["top-start"] }),
          shift({ padding: 8 }),
          size({
            // Containment invariant: the card's right edge stops BEFORE the
            // row's status rail, so the finger's column stays visible
            // and touchable mid-scrub. bottom-start left-aligns the card to
            // the row, so the cap is row width − rail − an 8px gap.
            apply({ rects, elements }) {
              const cap = rects.reference.width - STATUS_RAIL_WIDTH_PX - 8;
              elements.floating.style.maxWidth = `${Math.max(cap, 120)}px`;
            },
          }),
          arrow({ element: arrowRef }),
        ]
      : [
          offset(6),
          flip(),
          shift({ padding: 8 }),
          size({
            // Symmetric reset of the coarse arm's inline cap: if the pointer
            // flips coarse → fine while the card is mounted, a stale inline
            // maxWidth would otherwise persist and override the fine-pointer
            // `max-w-xs` class (inline style wins over the class).
            apply({ elements }) {
              elements.floating.style.maxWidth = "";
            },
          }),
          arrow({ element: arrowRef }),
        ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    enabled: !suppressed,
    // Touch never hover-opens (intake #17): the coarse-pointer path is the
    // explicit rail/dot-tap (`openNow`) + PANE-panel-on-selection.
    mouseOnly: true,
    move: false,
    // Function form — evaluated at event time against the module-scoped warm
    // window, so sweeping between rows retargets instantly.
    delay: flyoutOpenDelay,
    // Under `edgeAnchor` the polygon corridor (reference → card at the sidebar
    // edge) crosses sibling grid cells; blocking pointer events inside it keeps
    // a crossed cell's hover-open (instant while warm) from stealing the
    // single-open card mid-travel.
    handleClose: safePolygon(edgeAnchor ? { blockPointerEvents: true } : undefined),
  });
  const focus = useFocus(context, { enabled: !suppressed });
  const dismiss = useDismiss(context);
  // Deliberately NO `useRole({ role: "tooltip" })` — the card holds real links
  // (tier-2 hover-card, same rationale as the retired StatusDotTip; see
  // ui-patterns § Design Decisions → No role="tooltip").
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss]);

  const openNow = useCallback(() => {
    // Honor the same gate the useHover/useFocus triggers honor via `enabled`:
    // a rail/dot-tap while a row popover (PinPopover/SwatchPopover) is open
    // must not flash the card or close another row's card.
    if (suppressed) return;
    handleOpenChange(true);
  }, [handleOpenChange, suppressed]);
  const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  // Capture the reference node as state so the scrub-registry effect keys on
  // it (set once at mount; an identical-node set bails out of the re-render).
  const [referenceEl, setReferenceEl] = useState<HTMLElement | null>(null);
  const setReference = useCallback(
    (node: HTMLElement | null) => {
      refs.setReference(node);
      // Positioning splits from events only under `edgeAnchor`: events stay on
      // the real node (hover/focus/dismiss), position tracks the sidebar-edge
      // virtual rect. Elsewhere the events reference doubles as the position
      // reference, as before.
      refs.setPositionReference(edgeAnchor && node ? edgeAnchorReference(node) : node);
      setReferenceEl(node);
    },
    [refs, edgeAnchor],
  );

  // Scrub registry: this row's imperative open keyed by its root element.
  // Re-registers when `openNow`'s closure changes (e.g. the suppressed gate
  // flips), so a scrub never invokes a stale gate; unregisters on unmount so
  // a removed row (SSE) can't be retargeted.
  useEffect(() => {
    if (!referenceEl) return;
    flyoutScrubTargets.set(referenceEl, openNow);
    return () => {
      flyoutScrubTargets.delete(referenceEl);
    };
  }, [referenceEl, openNow]);

  const card: ReactNode = open ? (
    <FloatingPortal>
      {/* Non-modal focus management so the card's links (PR + docs) are
          Tab-reachable from the focused row: the manager makes FloatingPortal
          render its tab-order guards (they only render under a focus
          manager), so Tab walks reference → portalled content in tree order.
          `initialFocus={-1}` skips the manager's focus-on-open move and
          `returnFocus` is gated on focus actually having entered the card —
          the card also opens (and closes) on mere hover, and hover must never
          move focus (not steal it from the terminal on open, not yank it to
          the row's button on a sweep-away close). Escape-dismiss (useDismiss)
          and the sidebar tree's arrow-key nav are unaffected: focus stays on
          the row until the user tabs in. */}
      <FloatingFocusManager
        context={context}
        modal={false}
        order={["reference", "content"]}
        initialFocus={-1}
        returnFocus={focusInsideCard}
      >
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps()}
          // Don't let clicks inside the card bubble to the underlying row.
          onClick={(e) => e.stopPropagation()}
          // Records that focus entered the card (capture phase — fires for
          // any focusable descendant, i.e. the PR/docs links).
          onFocusCapture={() => setFocusInsideCard(true)}
          data-testid="row-flyout-card"
          // `rk-flyout-in` (cold opens only — warm retargets snap) slides the
          // card out of the row via margin-left + opacity: floating-ui owns
          // this element's `transform` for positioning, so the entrance must
          // never animate transform (it would clobber the translate).
          // The `max-w-xs` cap is FINE-POINTER-ONLY: on coarse the size()
          // middleware owns the width cap (stop before the status rail).
          className={`z-50 flex flex-col gap-1 bg-bg-card border border-border rounded-md rk-popup-elev px-2 py-1.5 text-xs font-mono w-max${coarse ? "" : " max-w-xs"}${
            coldOpenRef.current ? " rk-flyout-in" : ""
          }`}
        >
          {/* Row-aligned notch (E1): pinned by the arrow() middleware to the
              hovered row on the card's row-side edge. The resolved coordinate
              is axis-dependent: on a SIDE placement (fine pointers) it is `y`
              measured from the card's top — the notchFill title-band seam. On
              the coarse BOTTOM placement the arrow sits on the card's TOP
              edge, which is always inside the full-width title band (fill 0
              → inset); flipped to TOP the arrow sits on the bottom edge, in
              the action area (null → card surface). */}
          <FloatingArrow
            ref={arrowRef}
            context={context}
            width={10}
            height={5}
            tipRadius={1}
            fill={notchFill(
              placement.startsWith("bottom")
                ? 0
                : placement.startsWith("top")
                  ? null
                  : middlewareData.arrow?.y,
            )}
            stroke="var(--color-border)"
            strokeWidth={1}
            aria-hidden="true"
            data-testid="row-flyout-arrow"
          />
          {/* The tier's content, built only while open (the mount-only-while-
              open perf contract). `close` feeds the close-then-open handoff
              idiom of popover-opening action rows (Change color…, Pin). */}
          {content({ close })}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  ) : null;

  return {
    setReference,
    referenceProps: getReferenceProps(),
    getReferenceProps,
    card,
    open,
    openNow,
    close,
  } satisfies RowFlyout;
}
