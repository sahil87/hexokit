import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  useFloating,
  offset,
  flip,
  shift,
  useHover,
  useFocus,
  useDismiss,
  useInteractions,
  FloatingPortal,
  safePolygon,
  autoUpdate,
} from "@floating-ui/react";
import {
  useMetrics,
  useHostMetrics,
  useSessionContext,
  useUpdateNotification,
} from "@/contexts/session-context";
import { useInstanceName } from "@/contexts/instance-name-context";
import { useChromeState } from "@/contexts/chrome-context";
import { useKeybindings } from "@/hooks/use-keybindings";
import { useCronData } from "@/hooks/use-cron";
import { chordHintFor } from "@/lib/keybindings";
import { Tip } from "@/components/tip";
import { StatusDot } from "@/components/status-dot";
import { HostMetrics, normalizeLoadPercent } from "@/components/host-metrics";
import { displayVersion } from "@/lib/palette/version";
import { gaugeColor } from "@/lib/gauge";
import { getAgentLine, getFabParts, getPrSegments, getTmxLabel, splitDatePrefix } from "./sidebar/registers";
import { FAB_STATE_COLORS } from "@/components/pr-status-model";
import { controlClass } from "@/components/control";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useOccludes } from "@/hooks/use-occludes";
import { formatDuration, parseFabChange } from "@/lib/format";
import { requestQuakeTerminal } from "@/lib/quake-terminal";
import {
  computeStatusBarFold,
  type StatusBarFold,
  type StatusBarFoldItem,
} from "@/lib/status-bar-fold";
import type { MetricsSnapshot, WindowInfo } from "@/types";

/**
 * StatusBar (260814-ldbs R4/R5) — the shell's full-width ATTACHED status strip
 * on desktop: frame chrome like the top bar (flush, square, 1px `border-t`
 * seam, `bg-bg-chrome`), never a card. It absorbs the sidebar's retired
 * desktop PANE/HOST panels: the LEFT cluster mirrors the CURRENT WINDOW's
 * registers (terminal route only), the RIGHT cluster carries the host
 * segments + the ⌘K / compose hints the deleted fine-pointer bottom bar used
 * to hold. The sidebar ends flush above it; the Shell grid spans the row
 * across ALL columns (sidebar included). Mobile renders no status bar at all
 * (the drawer keeps the panels — the drawer-only fork).
 *
 * MIRROR, NOT A ROLLUP: every value arrives from EXISTING derivations — the
 * shared register resolvers (`sidebar/registers.ts`), the PANE panel's
 * identity-row sources, the host-metrics contexts, and the shared PR
 * vocabulary (`pr-status-model.ts`, via the resolvers' segment colors).
 * Nothing is re-derived, nothing is fetched, and no attention/aggregation
 * logic lives here (the status-pyramid machinery is untouched).
 *
 * Data seams: the window record + server name + connection state arrive as
 * PROPS (the presentational-by-contract rule — state lives in the callers).
 * Metrics + version + the compose preference subscribe to their EXISTING
 * contexts at this leaf (the HostPanel/SidebarFooter precedent): the metrics
 * contexts are deliberately split from SessionContext so the ~2.5s metrics
 * stream re-renders only subscribers — passing metrics DOWN through AppShell
 * would re-render the whole shell every tick. The clock chip reads the
 * server's cron data (`useCronData`) and operator staleness fields the same
 * way — leaf subscriptions to existing seams, riding the sessions SSE
 * cadence.
 *
 * OVERFLOW — a measured priority fold, never scroll (the fourth instance of
 * the shipped measured-overflow idiom, after the top bar's
 * `computeVisibleCount`, the breadcrumb collapse, and the gui tile header's
 * suffix fold; the pure decision lives in `lib/status-bar-fold.ts`, all DOM
 * measurement here): every segment renders at natural width or folds whole
 * into the `…` menu — ONE ladder across BOTH clusters, so the two sides of
 * the `ml-auto` spring no longer degrade independently. A hidden probe row
 * renders every candidate segment (plus the `…` chevron) at natural width
 * — `aria-hidden` + `inert`, and its copies carry no accessible identity
 * (no aria-label / testid / title / href), because label-text queries match
 * raw attributes regardless of `aria-hidden`; one ResizeObserver on the bar
 * root AND the probe feeds
 * `computeStatusBarFold` from a pre-paint `useLayoutEffect`. Lower fold
 * priority dies first (SEGMENT_TABLE); `pr`/`fab`/`zen ✕`/the stale `◷`
 * chip/the connection dot never fold. Truncation is the last resort,
 * reserved for the single rightmost truncatable never-fold survivor (`fab`
 * before `pr`) when the never-fold set alone does not fit — otherwise the
 * bar's `overflow-hidden` clips. The `…` chevron renders IFF something is
 * folded (the two-pass rule: the first fit carries no chevron charge, so
 * the reserve never causes the fold that justifies it), and its menu lists
 * exactly the folded ids in strip order. Metrics numerals are fixed-width
 * (tabular-nums + a 4ch reserve) so the ~2.5s metrics tick cannot change a
 * probed width and re-fold the bar. The render is collapse-first: fold
 * state starts null and the strip shows only the never-fold set until the
 * pre-paint measure lands, so no wide-then-snap frame is ever painted;
 * 24px one-sided hysteresis on the expand edge stops boundary flapping.
 *
 * COPY AFFORDANCES: segments with a stable raw value are click-to-copy via
 * the shared `useCopyFeedback` hook (the Pane panel's CopyableRow contract:
 * raw value — never the truncated display text — selection guard, 1s
 * `copied ✓` label swap, hover accent). Left cluster: git → branch, fab →
 * change id, tmx → pane id, cwd → full path (agt has no raw value and stays
 * passive; pr stays the open-first anchor). Right cluster: server / host /
 * version copy their displayed strings (live metrics and the connection dot
 * stay passive). Every copyable segment also carries a copy-action overflow
 * row, so the action stays one click away while its segment is folded
 * (Constitution V); the menu stays open on copy.
 */

/** The bar's fixed height — VS Code-class status strip. */
const BAR_HEIGHT = "h-[24px]";

/** The rendered gap INSIDE the host/version pair wrapper (`gap-1`) — the fit
 *  model's one pair-gap override, tighter than the cluster's `gap-3`. */
const HOST_VERSION_PAIR_GAP_PX = 4;

const LABEL_CLASS = "text-text-secondary";
const VALUE_CLASS = "text-text-primary";
/** Fixed-width numeral reserve on the metrics values — `100%` is the
 *  four-character worst case, so the ~2.5s metrics tick can never change a
 *  probed width and re-fold the bar. */
const NUMERAL_CLASS = "tabular-nums min-w-[4ch] text-right";

/** Segment ids in DISPLAY order (left cluster, then right). */
type SegmentId =
  | "git" | "pr" | "fab" | "agt" | "tmx" | "cwd"
  | "zen" | "metrics" | "ld" | "clock" | "server" | "host" | "version" | "palette" | "compose";

/** The fold priority table, in display order — the ONE ladder both clusters
 *  share. LOWER `prio` dies first (ties fold rightmost); `prio: null` never
 *  folds (`pr`/`fab` carry `truncatable` for the last-survivor rule; the
 *  stale clock chip's never-fold is applied at item-build time). */
const SEGMENT_TABLE: readonly {
  id: SegmentId;
  prio: number | null;
  cluster: "left" | "right";
  truncatable?: boolean;
}[] = [
  { id: "git", prio: 9, cluster: "left" },
  { id: "pr", prio: null, cluster: "left", truncatable: true },
  { id: "fab", prio: null, cluster: "left", truncatable: true },
  { id: "agt", prio: 8, cluster: "left" },
  { id: "tmx", prio: 3, cluster: "left" },
  { id: "cwd", prio: 2, cluster: "left" },
  { id: "zen", prio: null, cluster: "right" },
  { id: "metrics", prio: 6, cluster: "right" },
  { id: "ld", prio: 0, cluster: "right" },
  { id: "clock", prio: 4, cluster: "right" },
  { id: "server", prio: 5, cluster: "right" },
  { id: "host", prio: 10, cluster: "right" },
  { id: "version", prio: 7, cluster: "right" },
  { id: "palette", prio: 1, cluster: "right" },
  { id: "compose", prio: 1, cluster: "right" },
];

/** A plain text segment: dimmed 3-char-ish prefix + value. Segments render
 *  at natural width (`shrink-0 whitespace-nowrap`) and fold whole under the
 *  measured fold; `truncate` is the fold's last-survivor exception — only
 *  the fold's `truncateId` survivor may carry `min-w-0 truncate`. `probe`
 *  renders the bare control (no Tip — measurement only; the probe is
 *  `inert`, so the copy handler can never fire there). */
function Segment({
  label,
  tip,
  truncate = false,
  probe = false,
  valueClassName = VALUE_CLASS,
  children,
}: {
  label: string;
  tip: string;
  truncate?: boolean;
  probe?: boolean;
  valueClassName?: string;
  children: ReactNode;
}) {
  const node = (
    <span className={`flex items-center gap-1 whitespace-nowrap ${truncate ? "min-w-0" : "shrink-0"}`}>
      <span className={`${LABEL_CLASS} shrink-0`}>{label}</span>
      <span className={`${truncate ? "min-w-0 truncate " : ""}${valueClassName}`}>{children}</span>
    </span>
  );
  if (probe) return node;
  return (
    <Tip label={tip} placement="top">
      {node}
    </Tip>
  );
}

/** Click-to-copy variant of Segment (the Pane panel's CopyableRow contract):
 *  a real button (Constitution V — focusable, Enter/Space activatable) whose
 *  click copies the segment's RAW value; while copied, the label swaps to
 *  `copied ✓`. The swap is STRIP-only: the probe always renders the natural
 *  label, so the transient feedback can never change a probed width and
 *  re-fold the bar. The value span's `group-hover:text-accent` is the
 *  clickability reveal. */
function CopySegment({
  label,
  tip,
  ariaLabel,
  copied,
  onCopy,
  truncate = false,
  probe = false,
  valueClassName = VALUE_CLASS,
  children,
}: {
  label: string;
  tip: string;
  ariaLabel: string;
  copied: boolean;
  onCopy: () => void;
  truncate?: boolean;
  probe?: boolean;
  valueClassName?: string;
  children: ReactNode;
}) {
  const node = (
    <button
      type="button"
      aria-label={probe ? undefined : ariaLabel}
      onClick={onCopy}
      tabIndex={probe ? -1 : undefined}
      className={`group flex items-center gap-1 whitespace-nowrap cursor-pointer bg-transparent border-0 p-0 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green ${truncate ? "min-w-0" : "shrink-0"}`}
    >
      <span className={`${LABEL_CLASS} shrink-0`}>{!probe && copied ? "copied ✓" : label}</span>
      <span className={`${truncate ? "min-w-0 truncate " : ""}group-hover:text-accent ${valueClassName}`}>{children}</span>
    </button>
  );
  if (probe) return node;
  return (
    <Tip label={tip} placement="top">
      {node}
    </Tip>
  );
}

/** Host-metrics hover flyout (R4) — the cpu sparkline + mem bar graphs demote
 *  to this card on the compact metrics segment, following the sidebar
 *  row-flyout-card pattern (floating-ui hover/focus card in a portal). The
 *  content is the SHARED `HostMetrics` component, so the graphs can never
 *  drift from the (drawer-only) HOST panel. Non-interactive content, so no
 *  FloatingFocusManager; keyboard reachability comes from `useFocus` on the
 *  tabbable trigger (Constitution V). */
function MetricsFlyout({
  metrics,
  children,
}: {
  metrics: MetricsSnapshot;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, {
    mouseOnly: true,
    move: false,
    delay: { open: 300, close: 0 },
    handleClose: safePolygon(),
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss]);
  return (
    <>
      <span
        ref={refs.setReference}
        tabIndex={0}
        aria-label="Host metrics — details on hover"
        className="flex items-center gap-1.5 whitespace-nowrap shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-accent-green"
        {...getReferenceProps()}
      >
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 w-[240px] rounded-md border border-border bg-bg-primary p-2 shadow-lg"
          >
            <HostMetrics metrics={metrics} />
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** The normalized 1-minute load percentage (the shared HostMetrics rule). */
function loadPercent(m: MetricsSnapshot): number {
  return normalizeLoadPercent(m.load.avg1, m.load.cpus);
}

/** Memory as a percentage of total — the strip's compact form (the flyout
 *  keeps the absolute values via the shared HostMetrics). */
function memPercent(m: MetricsSnapshot): number {
  return Math.round((m.memory.used / Math.max(m.memory.total, 1)) * 100);
}

/** The clock chip's render states: the stale dead-man alarm, the
 *  soonest-next-fire readout, or omitted entirely (no stale session and no
 *  entry carrying a `nextFire`). One chip, never two — stale wins. */
type ClockChipState =
  | { kind: "stale"; age: string | null }
  | { kind: "next"; text: string; tip: string }
  | { kind: "omitted" };

/**
 * Derive the clock chip's state for one server from the existing seams at
 * this leaf: `useCronData` (mount fetch + the state-socket sessions cadence)
 * and the sessions payload's server-derived `operatorStale` /
 * `operatorLastTickAt` fields. No new fetch loop, no timer — ages are
 * computed at render time and the SSE cadence is the clock.
 */
function useClockChipState(server: string | null | undefined): ClockChipState {
  const { entries } = useCronData(server ?? "");
  const { sessionsByServer } = useSessionContext();
  const sessions = server ? (sessionsByServer.get(server) ?? []) : [];
  const nowSec = Math.floor(Date.now() / 1000);

  const staleSession = sessions.find((s) => s.operatorStale === true);
  if (staleSession) {
    const tickAt = staleSession.operatorLastTickAt ?? 0;
    return {
      kind: "stale",
      age: tickAt > 0 ? formatDuration(Math.max(0, nowSec - tickAt)) : null,
    };
  }

  let soonest: number | undefined;
  let soonestName = "";
  for (const entry of entries) {
    if (entry.nextFire === undefined) continue;
    if (soonest === undefined || entry.nextFire < soonest) {
      soonest = entry.nextFire;
      soonestName = entry.name || entry.id;
    }
  }
  if (soonest === undefined) return { kind: "omitted" };
  const delta = soonest - nowSec;
  if (delta <= 0) {
    return { kind: "next", text: "◷ due", tip: `Clock — next fire ${soonestName} due` };
  }
  const rel = formatDuration(delta);
  return { kind: "next", text: `◷ in ${rel}`, tip: `Clock — next fire ${soonestName} in ${rel}` };
}

/** The chip and its overflow row share the one open action: the quake
 *  terminal on its Cron List segment. */
function openCronList(): void {
  requestQuakeTerminal({ action: "open", segment: "list" });
}

/** The `◷` clock chip — the right-cluster glance at the server's cron clock.
 *  The fold carries it at priority 4 in its next-fire state; the stale state
 *  never folds (the connection-dot precedent: an alarm must be visible at
 *  every width), so the overflow menu's `clk` row exists only for the
 *  next-fire state. No copy affordance — no stable raw value (the `agt`
 *  rule). */
function ClockChip({
  state,
  probe = false,
}: {
  state: Exclude<ClockChipState, { kind: "omitted" }>;
  probe?: boolean;
}) {
  const stale = state.kind === "stale";
  const text = stale ? `◷ stale${state.age ? ` ${state.age}` : ""}` : state.text;
  const tip = stale
    ? state.age
      ? `Operator loop stale — last tick ${state.age} ago`
      : "Operator loop stale — no recent tick"
    : state.tip;
  const node = (
    <button
      type="button"
      aria-label={probe ? undefined : "Cron list"}
      data-testid={probe ? undefined : "status-bar-clock"}
      tabIndex={probe ? -1 : undefined}
      onClick={openCronList}
      className={`flex items-center rounded border px-1 transition-colors ${
        stale
          ? "border-signal-yellow/50 text-signal-yellow hover:border-signal-yellow"
          : "border-border text-text-secondary hover:border-text-secondary"
      }`}
    >
      {text}
    </button>
  );
  if (probe) return node;
  return (
    <Tip label={tip} placement="top">
      {node}
    </Tip>
  );
}

/** The `…` overflow menu — the top-bar `menuOnly` row pattern: a
 *  fixed-position `role="menu"` panel anchored to the chevron's viewport
 *  rect (so no ancestor `overflow-hidden` clips it), Escape / outside
 *  mousedown closes. Rows are exactly the fold's folded ids, in strip
 *  order — no hidden rows remain, so every rendered row is focusable.
 *
 *  Keyboard (`top-bar-overflow-menu.tsx`'s contract): focus enters the panel on
 *  open, ArrowUp/ArrowDown rove between rows, Escape closes and returns focus
 *  to the chevron. Most rows here are INFORMATIONAL spans rather than actions,
 *  so roving focus is what makes them readable at all — a `role="menuitem"`
 *  that never receives focus is unreachable for keyboard and screen-reader
 *  users (Constitution V). */
function OverflowMenu({
  folded,
  win,
  metrics,
  version,
  server,
  hostName,
  onOpenCompose,
  clock,
}: {
  /** The fold's folded ids, in display order — one row per id. */
  folded: readonly string[];
  win: WindowInfo | null;
  metrics: MetricsSnapshot | null;
  version: string | null;
  server?: string | null;
  hostName: string | null;
  onOpenCompose?: () => void;
  /** The clock chip's state — the `clk` row exists only for the next-fire
   *  state; the stale chip never folds, so it never needs a row. */
  clock?: ClockChipState;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { copiedKey, copy } = useCopyFeedback<"git" | "tmx" | "cwd" | "version" | "server" | "host">();

  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", open);

  // The menu's rows in DOM (= visual) order. Every rendered row is a folded
  // segment, so no visibility filtering is needed — the rows list IS the
  // fold's folded set.
  const rows_ = useCallback((): HTMLElement[] => {
    const menu = menuRef.current;
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }, []);

  // Move focus by `delta` (+1 down, -1 up), wrapping at both ends. Anchors off
  // the focused row's position so navigation stays stable as the folded set
  // changes under a resize.
  const moveFocus = useCallback(
    (delta: number) => {
      const items = rows_();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const curr = active ? items.indexOf(active) : -1;
      const base = curr === -1 ? (delta > 0 ? -1 : 0) : curr;
      items[(base + delta + items.length) % items.length]?.focus();
    },
    [rows_],
  );

  // On open, move focus into the panel (the canonical menu pattern — rows keep
  // `tabIndex={-1}` and are reached programmatically from here and arrow-nav).
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => rows_()[0]?.focus());
  }, [open, rows_]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
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
    function onMouseDown(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, moveFocus]);

  const activePane = win?.panes?.find((p) => p.isActive);
  const cwdFull = activePane?.cwd ?? win?.worktreePath ?? "";
  const cwdBase = cwdFull.split("/").filter(Boolean).pop() ?? cwdFull;
  const gitBranch = activePane?.gitBranch ?? "";
  const tmxLabel = win ? getTmxLabel(win) : "";
  const agtLine = win ? getAgentLine(win) : null;

  const textRow = (key: string, text: string) => (
    <span
      key={key}
      role="menuitem"
      tabIndex={-1}
      className={controlClass({ variant: "menu-row", className: "focus-visible:outline-2 focus-visible:outline-accent-green" })}
    >
      {text}
    </span>
  );

  // Copy-action twin of textRow for rows mirroring COPYABLE strip segments:
  // while its segment is folded this row is the register's only surface, so
  // keyboard parity (Constitution V) requires the copy action to live here
  // too. The leading register key swaps to `copied ✓`; the menu stays open
  // (the user may want to read the row). Enter/Space activate via the native
  // button.
  const copyRow = (
    key: "git" | "tmx" | "cwd" | "version" | "server" | "host",
    prefix: string,
    rest: string,
    value: string,
    ariaLabel: string,
  ) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-label={ariaLabel}
      className={controlClass({ variant: "menu-row", className: "focus-visible:outline-2 focus-visible:outline-accent-green" })}
      onClick={() => copy(key, value)}
    >
      {copiedKey === key ? `copied ✓${rest ? " " : ""}` : prefix}
      {rest}
    </button>
  );

  // The hint/clock rows keep the ACTIONS (the top-bar menuOnly rule: the full
  // set stays one click away at any width, palette parity included).
  const actionRow = (key: string, label: string, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={controlClass({ variant: "menu-row" })}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      {label}
    </button>
  );

  /** One menu row per folded id — the row kinds are fixed per segment: copy
   *  buttons for the copyable registers, informational spans for the
   *  value-only segments, action rows for the hints and the next-fire clock
   *  chip. (`pr`/`fab`/`zen` never fold, so they never need a row.) */
  const rowFor = (id: string): ReactNode => {
    switch (id) {
      case "git":
        return copyRow("git", "⑂ ", gitBranch, gitBranch, "Copy git branch");
      case "tmx":
        return activePane?.paneId
          ? copyRow("tmx", "tmx ", tmxLabel, activePane.paneId, "Copy tmux pane id")
          : textRow("tmx", `tmx ${tmxLabel}`);
      // The row shows the basename; the copy is the FULL path (raw-value rule).
      case "cwd":
        return copyRow("cwd", "cwd ", cwdBase, cwdFull, "Copy working directory path");
      case "agt":
        return textRow("agt", `agt ${agtLine ?? ""}`);
      case "metrics":
        return metrics
          ? textRow("cpu", `cpu ${Math.round(metrics.cpu.current)}% · mem ${memPercent(metrics)}%`)
          : null;
      case "ld":
        return metrics ? textRow("ld", `ld ${loadPercent(metrics)}%`) : null;
      case "clock":
        return clock?.kind === "next" ? actionRow("clk", "◷ Cron List", openCronList) : null;
      case "server":
        return server ? copyRow("server", server, "", server, "Copy server name") : null;
      case "host":
        return hostName ? copyRow("host", hostName, "", hostName, "Copy host name") : null;
      case "version":
        return version ? copyRow("version", version, "", version, "Copy version") : null;
      case "palette":
        return actionRow("palette", "⌘K Command palette", () =>
          document.dispatchEvent(new CustomEvent("palette:open")),
        );
      case "compose":
        return onOpenCompose ? actionRow("compose", "a▏ Compose", onOpenCompose) : null;
      default:
        return null;
    }
  };

  return (
    <div className="relative flex items-center">
      <button
        ref={buttonRef}
        type="button"
        aria-label="More status segments"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="status-bar-overflow"
        className="rk-glint rounded border border-border px-1.5 text-text-secondary transition-colors hover:border-text-secondary"
        onClick={() => {
          if (!open && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPos({ bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right });
          }
          setOpen((v) => !v);
        }}
      >
        …
      </button>
      {open && menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Overflow status segments"
          className="fixed z-50 flex min-w-[180px] flex-col rounded-md border border-border bg-bg-primary py-1 shadow-2xl"
          style={{ bottom: menuPos.bottom, right: menuPos.right }}
        >
          {folded.map((id) => (
            <Fragment key={id}>{rowFor(id)}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export type StatusBarProps = {
  /** The current window record (terminal route); null elsewhere — the left
   *  cluster renders only with a window. */
  window: WindowInfo | null;
  /** The current tmux server name; null/undefined off-server routes (board). */
  server?: string | null;
  /** Connection state for the terminator dot (the sidebar footer's rule). */
  isConnected: boolean;
  /** Compose-strip opener (the relocated bottom-bar `a▏` chip action). */
  onOpenCompose?: () => void;
  /** Zen mode (260820-o8cr R8): while active, an exit-zen button renders at
   *  the bottom-right of the host cluster — zen's always-visible exit
   *  affordance beside the ⇧⌘⏎ chord. */
  zenActive?: boolean;
  /** Zen exit body — required for the button to render (same body as the
   *  chord and the palette's `View: Exit Zen Mode` entry). */
  onExitZen?: () => void;
};

export function StatusBar({ window: win, server, isConnected, onOpenCompose, zenActive, onExitZen }: StatusBarProps) {
  // Leaf subscriptions (the HostPanel precedent): BOTH hooks are called
  // unconditionally and coalesced AFTER (`??` directly between hook calls
  // would short-circuit the second hook once server metrics arrive — a
  // Rules-of-Hooks violation). Server-scoped metrics win, host-global
  // broadcast is the every-route fallback; version via the tolerant
  // update-notification seam (null until the first `version` event — the
  // fragment is omitted rather than rendering "vundefined").
  const serverMetrics = useMetrics();
  const hostMetrics = useHostMetrics();
  const metrics = serverMetrics ?? hostMetrics;
  const { daemonVersion } = useUpdateNotification();
  const { composeStripEnabled } = useChromeState();
  // Instance display name (o7q8): the host segment shows the settings override
  // over the metrics-reported hostname — display-only, the HOST panel's rule.
  const { instanceName } = useInstanceName();
  // Registry-resolved chords for the hint tips (the bottom-bar chip pattern,
  // 260801-mqim): reflect rebinds, omitted when unbound/disabled.
  const { bindings: keybindings, host: keybindingHost } = useKeybindings();
  const chordFor = (actionId: string) =>
    chordHintFor(actionId, keybindings, keybindingHost.platform);

  const version = daemonVersion ? displayVersion(daemonVersion) : null;
  const hostName = instanceName ?? metrics?.hostname ?? null;
  // Right-cluster identity fragments are click-to-copy of their displayed
  // strings. They carry no 3-char label, so the fragment's own text swaps to
  // `copied ✓` during the feedback window (live metrics and the connection
  // dot stay passive — no stable value worth copying).
  const { copiedKey: hostCopiedKey, copy: hostCopy } = useCopyFeedback<"server" | "host" | "version">();
  // The window cluster's copy segments own a second feedback slot, so a
  // left-cluster copy never clears a right-cluster one mid-swap.
  const { copiedKey: windowCopiedKey, copy: windowCopy } = useCopyFeedback<"git" | "fab" | "tmx" | "cwd">();
  // The clock chip's state — one derivation feeding both the strip segment
  // and its overflow-menu mirror row (a second `useCronData` subscription
  // would double the cron fetch per SSE tick).
  const clock = useClockChipState(server);

  // LEFT-cluster derivations (terminal route only) — the current window's
  // registers, resolved by the shared `sidebar/registers.ts` helpers + the
  // PANE panel's identity-row sources.
  const activePane = win?.panes?.find((p) => p.isActive);
  const paneId = activePane?.paneId ?? "";
  const tmxValue = win ? getTmxLabel(win) : "";
  const cwdFull = activePane?.cwd ?? win?.worktreePath ?? "";
  const cwdMissing = activePane?.cwdMissing ?? false;
  const cwdBase = cwdFull.split("/").filter(Boolean).pop() ?? cwdFull;
  const gitBranch = activePane?.gitBranch ?? "";
  // The leading six-digit date prefix dims (the panel git row's rule — one
  // regex, splitDatePrefix in registers.ts); the copy value stays the full
  // branch. The overflow-menu ⑂ row is a menu item and stays plain.
  const { prefix: gitDatePrefix, rest: gitBranchRest } = splitDatePrefix(gitBranch);
  const agtLine = win ? getAgentLine(win) : null;
  // The slug is written once: the pane's branch carries it, so the segment
  // shows `<id> · <stage>`; on any other branch the slug stays (the off-branch
  // signal). The displayState token renders in the fab hue vocabulary.
  const fabParts = win ? getFabParts(win, gitBranch) : null;
  // Parsed here for the copy value only (the fab segment copies the 4-char
  // change id, the Pane panel's rule); the display STRING composes from
  // getFabParts.
  const fabChange = parseFabChange(win?.fabChange ?? "");
  const prSegments = win ? getPrSegments(win) : null;

  // The fold candidate set, in display order. Absent segments (no branch, no
  // PR, no metrics yet, …) are simply not items.
  const present = new Set<SegmentId>();
  if (win) {
    if (gitBranch) present.add("git");
    if (prSegments) present.add("pr");
    if (fabParts) present.add("fab");
    if (agtLine) present.add("agt");
    present.add("tmx");
    present.add("cwd");
  }
  if (zenActive && onExitZen) present.add("zen");
  if (metrics) {
    present.add("metrics");
    present.add("ld");
  }
  if (server && clock.kind !== "omitted") present.add("clock");
  if (server) present.add("server");
  if (hostName) present.add("host");
  if (version) present.add("version");
  present.add("palette");
  if (onOpenCompose) present.add("compose");

  const items: (Omit<StatusBarFoldItem, "id"> & { id: SegmentId })[] = SEGMENT_TABLE.filter((s) => present.has(s.id)).map((s) => ({
    id: s.id,
    widthPx: 0, // filled by the probe measure
    // The stale clock chip never folds (the connection-dot alarm precedent).
    prio: s.id === "clock" && clock.kind === "stale" ? null : s.prio,
    cluster: s.cluster,
    truncatable: s.truncatable,
    // Host + version render as one `gap-1` wrapper, not two `gap-3` siblings —
    // charge the pair's real gap while both survive (the wrapper comment below).
    pairGap: s.id === "host" ? { withId: "version", px: HOST_VERSION_PAIR_GAP_PX } : undefined,
  }));

  // Collapse-first: null until the pre-paint measure lands — the strip renders
  // only the never-fold set, so no wide-then-snap frame is ever painted (the
  // gui toolbar's rule).
  const [fold, setFold] = useState<StatusBarFold | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);

  // Serialize the probed SET so the measure effect re-runs when it changes
  // (a segment appearing/vanishing, the clock chip's kind flipping its prio),
  // not on every render; value-only width changes (a new branch name, a
  // longer host) re-fit through the observed probe instead.
  const candidateKey = items.map((i) => `${i.id}:${i.prio ?? "never"}`).join(",");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const probe = probeRef.current;
    if (!root || !probe) return;
    const measure = () => {
      const widths = new Map<string, number>();
      for (const el of probe.querySelectorAll<HTMLElement>("[data-fold]")) {
        const key = el.getAttribute("data-fold");
        if (key !== null) widths.set(key, el.offsetWidth);
      }
      const measured = items.map((item) => ({ ...item, widthPx: widths.get(item.id) ?? 0 }));
      const chevronPx = widths.get("chevron") ?? 0;
      setFold((prev) => computeStatusBarFold(measured, root.clientWidth, chevronPx, prev));
    };
    measure();
    // Observe the bar root AND the probe: an item's own width can change (a
    // new branch, a longer host name) without the bar resizing.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(probe);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  const neverFoldIds = new Set(items.filter((i) => i.prio === null).map((i) => i.id));
  const foldedIds = new Set(fold?.folded ?? []);
  /** Strip visibility: pre-measure only the never-fold set renders
   *  (collapse-first); afterwards everything not folded. */
  const stripVisible = (id: SegmentId) => (fold === null ? neverFoldIds.has(id) : !foldedIds.has(id));
  const truncateId = fold?.truncateId ?? null;

  /** One segment per id, shared by the strip and the probe, so the two can
   *  never disagree. `probe` renders the bare control — no Tip, `tabIndex={-1}`,
   *  and NO accessible identity (no `aria-label`, `data-testid`, `title`,
   *  `href`, `aria-pressed`): the probe container is `aria-hidden` + `inert`,
   *  but label-text queries (Playwright `getByLabel`, Testing Library
   *  `getByLabelText`) match raw `aria-label` attributes regardless, so a
   *  labelled probe copy would make every strip control resolve twice. */
  const segmentNode = (id: SegmentId, probe: boolean): ReactNode => {
    switch (id) {
      case "git":
        return (
          <CopySegment
            probe={probe}
            label="⑂"
            tip="Git branch"
            ariaLabel="Copy git branch"
            copied={windowCopiedKey === "git"}
            onCopy={() => windowCopy("git", gitBranch)}
          >
            {gitDatePrefix && <span className="text-text-secondary group-hover:text-accent">{gitDatePrefix}</span>}
            {gitBranchRest}
          </CopySegment>
        );
      case "pr": {
        if (!prSegments) return null;
        // Truncation is the strip's last-survivor state — the probe measures
        // natural width, so `truncateId` never reaches it.
        const truncating = !probe && truncateId === "pr";
        const body = (
          <>
            <span className={`${LABEL_CLASS} shrink-0`}>pr</span>
            <span className={`flex items-center gap-1 ${truncating ? "min-w-0 truncate" : ""}`}>
              {prSegments.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden="true" className="text-text-secondary">·</span>}
                  <span className={seg.color}>{seg.text}</span>
                </span>
              ))}
            </span>
          </>
        );
        const frameClass = `flex items-center gap-1 whitespace-nowrap ${truncating ? "min-w-0" : "shrink-0"}`;
        // Open-first (the PANE panel's PrLinkRow rule): a real anchor, so
        // middle-click / Ctrl-⌘-click / copy-link all work natively. The `↗`
        // glyph marks the OPEN affordance, so it renders only in this branch
        // — the no-URL fallback is a passive span and carries no glyph.
        return win?.prUrl && !probe ? (
          <a
            href={win.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={win.prUrl}
            aria-label={`Open PR #${win.prNumber} in a new tab`}
            tabIndex={probe ? -1 : undefined}
            className={`${frameClass} hover:text-accent`}
          >
            {body}
            <span aria-hidden="true" className="text-text-secondary shrink-0">
              ↗
            </span>
          </a>
        ) : (
          <span className={frameClass}>{body}</span>
        );
      }
      case "fab": {
        if (!fabParts) return null;
        const body = (
          <>
            {fabParts.id}{fabParts.slug ? ` ${fabParts.slug}` : ""} · {fabParts.stage}
            {fabParts.displayState && (
              <span className={`${FAB_STATE_COLORS[fabParts.displayState] ?? ""} ${fabChange ? "group-hover:text-accent" : ""}`}>{` · ${fabParts.displayState}`}</span>
            )}
          </>
        );
        // The no-copy fork keeps the truncatable flag's rendering path — the
        // last-survivor rule does not depend on the copy affordance.
        return fabChange ? (
          <CopySegment
            probe={probe}
            label="fab"
            tip="Fab change"
            ariaLabel="Copy fab change id"
            copied={windowCopiedKey === "fab"}
            onCopy={() => windowCopy("fab", fabChange.id)}
            truncate={!probe && truncateId === "fab"}
          >
            {body}
          </CopySegment>
        ) : (
          <Segment probe={probe} label="fab" tip="Fab change" truncate={!probe && truncateId === "fab"}>
            {body}
          </Segment>
        );
      }
      case "agt": {
        if (!agtLine || !win) return null;
        const value = (
          <span className="flex items-center gap-1 whitespace-nowrap shrink-0">
            <span className={`${LABEL_CLASS} shrink-0`}>agt</span>
            <span className={VALUE_CLASS}>{agtLine}</span>
          </span>
        );
        return (
          <span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
            <StatusDot win={win} decorative={probe} />
            {probe ? value : <Tip label="Agent state" placement="top">{value}</Tip>}
          </span>
        );
      }
      case "tmx":
        // No pane id ⇒ nothing to copy — the Pane panel's same passive fork.
        return paneId ? (
          <CopySegment
            probe={probe}
            label="tmx"
            tip="tmux pane"
            ariaLabel="Copy tmux pane id"
            copied={windowCopiedKey === "tmx"}
            onCopy={() => windowCopy("tmx", paneId)}
          >
            {tmxValue}
          </CopySegment>
        ) : (
          <Segment probe={probe} label="tmx" tip="tmux pane">
            {tmxValue}
          </Segment>
        );
      case "cwd":
        return (
          <CopySegment
            probe={probe}
            label="cwd"
            tip={cwdMissing ? `${cwdFull} (no longer exists)` : cwdFull}
            ariaLabel="Copy working directory path"
            copied={windowCopiedKey === "cwd"}
            onCopy={() => windowCopy("cwd", cwdFull)}
          >
            <span className={cwdMissing ? "text-signal-red" : undefined}>
              {cwdBase}
              {cwdMissing ? " (deleted)" : ""}
            </span>
          </CopySegment>
        );
      case "zen": {
        // Zen exit — rendered ONLY while zen is active, the visible exit
        // affordance beside the ⇧⌘⏎ chord (Esc is deliberately not a zen exit
        // — it belongs to the terminal pane). The cluster's hint-button
        // vocabulary, green-lit because zen-active IS the state the chip marks
        // (scheme C: green = state); it never folds (zen's one guaranteed
        // visible exit).
        const node = (
          <button
            type="button"
            aria-label={probe ? undefined : "Exit zen mode"}
            data-testid={probe ? undefined : "status-bar-exit-zen"}
            tabIndex={probe ? -1 : undefined}
            className="flex items-center rounded border border-accent-green bg-accent-green/20 px-1 text-accent-green transition-colors"
            onClick={onExitZen}
          >
            zen ✕
          </button>
        );
        return probe ? node : <Tip label="Exit zen mode" kbd={chordFor("zen-toggle")} placement="top">{node}</Tip>;
      }
      case "metrics": {
        if (!metrics) return null;
        const values = (
          <>
            <span className={LABEL_CLASS}>cpu</span>
            <span className={`${VALUE_CLASS} ${NUMERAL_CLASS}`}>{Math.round(metrics.cpu.current)}%</span>
            <span aria-hidden="true" className={LABEL_CLASS}>·</span>
            <span className={LABEL_CLASS}>mem</span>
            <span className={`${gaugeColor(memPercent(metrics))} ${NUMERAL_CLASS}`}>{memPercent(metrics)}%</span>
          </>
        );
        return probe ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">{values}</span>
        ) : (
          <MetricsFlyout metrics={metrics}>{values}</MetricsFlyout>
        );
      }
      case "ld":
        // Passive (no copy, no flyout — the flyout stays on the metrics
        // segment only).
        return metrics ? (
          <Segment
            probe={probe}
            label="ld"
            tip="Load (1 min, normalized)"
            valueClassName={`${VALUE_CLASS} ${NUMERAL_CLASS}`}
          >
            {loadPercent(metrics)}%
          </Segment>
        ) : null;
      case "clock":
        return clock.kind === "omitted" ? null : <ClockChip state={clock} probe={probe} />;
      case "server": {
        if (!server) return null;
        return (
          <button
            type="button"
            aria-label={probe ? undefined : "Copy server name"}
            tabIndex={probe ? -1 : undefined}
            onClick={() => hostCopy("server", server)}
            className="shrink-0 whitespace-nowrap text-text-secondary cursor-pointer bg-transparent border-0 p-0 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green"
          >
            {!probe && hostCopiedKey === "server" ? "copied ✓" : server}
          </button>
        );
      }
      case "host": {
        if (!hostName) return null;
        return (
          <button
            type="button"
            aria-label={probe ? undefined : "Copy host name"}
            tabIndex={probe ? -1 : undefined}
            onClick={() => hostCopy("host", hostName)}
            className="shrink-0 whitespace-nowrap text-text-secondary cursor-pointer bg-transparent border-0 p-0 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green"
          >
            {!probe && hostCopiedKey === "host" ? "copied ✓" : hostName}
          </button>
        );
      }
      case "version": {
        if (!version) return null;
        return (
          <button
            type="button"
            aria-label={probe ? undefined : "Copy version"}
            tabIndex={probe ? -1 : undefined}
            onClick={() => hostCopy("version", version)}
            className={`${VALUE_CLASS} shrink-0 whitespace-nowrap cursor-pointer bg-transparent border-0 p-0 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-green`}
          >
            {!probe && hostCopiedKey === "version" ? "copied ✓" : version}
          </button>
        );
      }
      case "palette": {
        const node = (
          <button
            type="button"
            aria-label={probe ? undefined : "Open command palette"}
            tabIndex={probe ? -1 : undefined}
            className="flex items-center rounded border border-border px-1 text-text-secondary transition-colors hover:border-text-secondary"
            onClick={() => document.dispatchEvent(new CustomEvent("palette:open"))}
          >
            <kbd aria-hidden="true">{"⌘K"}</kbd>
          </button>
        );
        return probe ? node : <Tip label="Command palette" kbd={chordFor("command-palette")} placement="top">{node}</Tip>;
      }
      case "compose": {
        if (!onOpenCompose) return null;
        const node = (
          <button
            type="button"
            aria-label={probe ? undefined : "Compose"}
            aria-pressed={probe ? undefined : composeStripEnabled}
            data-testid={probe ? undefined : "status-bar-compose"}
            tabIndex={probe ? -1 : undefined}
            className={controlClass({
              variant: "toggle",
              base: "flex items-center rounded border px-1 transition-colors",
              pressed: composeStripEnabled,
            })}
            onClick={onOpenCompose}
          >
            <span aria-hidden="true">
              a<span className={composeStripEnabled ? "rk-compose-caret" : undefined}>{"▏"}</span>
            </span>
          </button>
        );
        return probe ? node : <Tip label="Compose" kbd={chordFor("compose-toggle")} placement="top">{node}</Tip>;
      }
    }
  };

  const leftIds = items.filter((i) => i.cluster === "left" && stripVisible(i.id)).map((i) => i.id);
  const rightIds = items.filter((i) => i.cluster === "right" && stripVisible(i.id)).map((i) => i.id);
  const hostIn = rightIds.includes("host");
  const versionIn = rightIds.includes("version");

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Status bar"
      data-testid="status-bar"
      className={`${BAR_HEIGHT} relative flex items-center overflow-hidden border-t border-border bg-bg-chrome px-2 font-mono text-[10.5px] leading-none`}
    >
      {/* LEFT — the current-window mirror (terminal route only). No gap on
          the root: the right cluster's `ml-auto` spring supplies the
          separation, and the fit model charges no gap across it. */}
      {win && (
        <div className="flex items-center gap-3 min-w-0" data-testid="status-bar-window">
          {leftIds.map((id) => (
            <Fragment key={id}>{segmentNode(id, false)}</Fragment>
          ))}
        </div>
      )}

      {/* RIGHT — host-scoped, every desktop route. The connection dot never
          folds; the `…` chevron renders only while something is folded. */}
      <div className="ml-auto flex items-center gap-3 min-w-0" data-testid="status-bar-host">
        {rightIds.map((id) => {
          // Host + version are one visual pair (gap-1, tighter than the
          // cluster's gap-3) but two independent fold items — the wrapper
          // renders whichever survive and is omitted when both fold.
          if (id === "version" && hostIn) return null;
          if (id === "host" || id === "version") {
            return (
              <span key="host-version" className="flex items-center gap-1 whitespace-nowrap shrink-0">
                {hostIn && segmentNode("host", false)}
                {versionIn && segmentNode("version", false)}
              </span>
            );
          }
          return <Fragment key={id}>{segmentNode(id, false)}</Fragment>;
        })}
        {fold !== null && fold.folded.length > 0 && (
          <OverflowMenu
            folded={fold.folded}
            win={win}
            metrics={metrics}
            version={version}
            server={server}
            hostName={hostName}
            onOpenCompose={onOpenCompose}
            clock={clock}
          />
        )}
        {/* The connection dot is the right-most status terminator (the sidebar
            footer's vocabulary) and never folds. */}
        <span role="status" aria-live="polite" className="flex items-center">
          <Tip label={isConnected ? "Connected" : "Disconnected"} placement="top">
            <span
              className={`block h-2 w-2 rounded-full ${isConnected ? "bg-accent-green" : "bg-text-secondary"}`}
              aria-label={isConnected ? "Connected" : "Disconnected"}
            />
          </Tip>
        </span>
      </div>

      {/* Hidden measurement probe — every candidate segment at natural width
          in a `data-fold` wrapper, plus the `…` chevron so its two-pass
          reserve is measured, not hardcoded. Natural width means natural
          content too: the strip's `copied ✓` swaps and the fold's
          `truncateId` never reach the probe. `inert` + aria-hidden +
          off-screen: the duplicated controls can never receive focus or
          clicks; they exist purely to be measured. */}
      <div
        ref={probeRef}
        data-testid="status-bar-probe"
        aria-hidden="true"
        inert
        className="absolute -left-[9999px] top-0 flex items-center gap-3 pointer-events-none"
      >
        {items.map((item) => (
          <span key={item.id} data-fold={item.id} className="flex items-center shrink-0">
            {segmentNode(item.id, true)}
          </span>
        ))}
        <span data-fold="chevron" className="flex items-center shrink-0">
          <button
            type="button"
            tabIndex={-1}
            className="rk-glint rounded border border-border px-1.5 text-text-secondary"
          >
            …
          </button>
        </span>
      </div>
    </div>
  );
}
