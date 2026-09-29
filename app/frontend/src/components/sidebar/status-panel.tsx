import { useState, useRef, useEffect, type ReactNode } from "react";
import { refreshStatus } from "@/api/client";
import { useSessionContext } from "@/contexts/session-context";
import { useNow } from "@/hooks/use-now";
import { BrailleSnake } from "@/components/braille-snake";
import { ClockSpinner } from "@/components/clock-spinner";
import { StarTwinkle } from "@/components/star-twinkle";
import { CollapsiblePanel } from "./collapsible-panel";
import { ICON_CLASS } from "./icons";
import { COPY_FEEDBACK_MS, useCopyFeedback } from "@/hooks/use-copy-feedback";
import { abbreviateHomePath } from "@/lib/format";
import { getOutputLine, getAgentLine, getFabParts, getOperatorParts, getPrParts, getTmxLabel, splitDatePrefix } from "./registers";
import type { OperatorLoopFacts, PrSegment } from "./registers";
import { FAB_STATE_COLORS } from "@/components/pr-status-model";
import { StatusDot } from "@/components/status-dot";
import { Tip } from "@/components/tip";
import type { WindowInfo } from "@/types";

type CopyableRowKey = "tmx" | "cwd" | "git" | "fab" | "pr";

/** localStorage key + default of the PANE panel's collapsed/expanded state
 *  (CollapsiblePanel's `storageKey`). Exported because the status bar's yield
 *  rule subscribes to the same boolean: the panel is "on screen" only while
 *  expanded, so a collapsed panel hands the window cluster back to the bar. */
export const PANE_PANEL_OPEN_STORAGE_KEY = "hexokit-panel-window";
export const PANE_PANEL_DEFAULT_OPEN = true;

// How long the post-completion / throttled "checkmark" shows before reverting to
// the idle refresh icon — the copy rows' feedback cadence, shared so the two
// can't diverge.
const REFRESH_CHECK_MS = COPY_FEEDBACK_MS;

// UI fallback that clears a stuck spinner if no `status-refresh` completion event
// arrives (network drop / a client that missed the broadcast). The backend pass
// is bounded by statusRefreshTimeout = 60s; a snappier practical fallback is fine
// since the freshness "checked Xs ago" line covers the ambient case.
const REFRESH_FALLBACK_MS = 15000;

/** PANE-header refresh button feedback state. `idle` = the rotate-cw icon;
 *  `spinning` = waiting for the server-global `status-refresh` completion event
 *  (started/coalesced); `check` = a brief "done / already fresh" checkmark. */
type RefreshButtonState = "idle" | "spinning" | "check";

type WindowPanelProps = {
  window: WindowInfo | null;
  /** The owning session's operator-watchdog facts (stale flag verbatim + last
   *  tick) — feeds the `opr` register; undefined for windows whose session
   *  facts are unavailable (the thin pin-only fallback window). */
  operator?: OperatorLoopFacts;
};

// The register-line resolvers — getOutputLine (L0) / getAgentLine (L1) /
// getFabParts (L2) / getPrParts (L3) — live in ./registers.ts: the single
// source shared with the sidebar row-hover flyout card and the status bar, so
// the three register surfaces cannot drift. The fab display-state hue
// vocabulary comes from pr-status-model.ts (FAB_STATE_COLORS).
//
// Continuation lines: the `pr` and `fab` rows split into a KEY line of the
// decisive tokens (`#n · state`, `id · stage · state`) and a dim continuation
// line for the expendable tail (the PR health facts; the slug when the branch
// does not carry it) — the row-flyout card's rule. Truncation is unavoidable
// at the 220px default, so the layout chooses what gets cut: the tail, on its
// own line. A row never exceeds two lines; a continuation line renders only
// with content. The indent is the panel's VALUE column — the 4-advance key
// plus the 2-advance icon cell (`pl-[6ch]`); the card's `pl-[4ch]` is the same
// rule on a surface with no icon column.

/**
 * PANE-header refresh button (260715-jykd; feedback state machine 260715-nwla).
 * Kicks a server-side on-demand refresh of BOTH PR pollers via POST
 * /api/status/refresh (`refreshStatus`). The honest feedback loop:
 *
 *   - `started` / `coalesced` → SPIN from click until the server-global
 *     `status-refresh` completion event arrives (NOT until the POST settles —
 *     the POST returns 202 in ~ms while the real gh work runs 1–10s detached),
 *     then flash a brief checkmark ("done — you're current"). A 15s fallback
 *     clears a stuck spinner if the event is missed.
 *   - `throttled` → nothing was started and no event will come, so DON'T spin;
 *     flash the "already fresh" checkmark immediately instead.
 *
 * Completion is delivered via `subscribeStatusRefresh` (the server-global SSE
 * `status-refresh` event routed through the session context). Rendered via
 * CollapsiblePanel's `headerAction` (whose clicks are stopped from toggling the
 * panel). Follows the top-bar/board RefreshButton CRT-glint vocabulary
 * (`rk-glint`). The refresh is server-global, so it renders whether or not a
 * window is selected. Best-effort/fire-and-forget: server-side coalescing + a
 * min-interval throttle make it safe to over-fire, so errors are swallowed (the
 * fallback still clears any spinner).
 */
function PaneRefreshButton() {
  const { subscribeStatusRefresh } = useSessionContext();
  const [state, setState] = useState<RefreshButtonState>("idle");
  // Fallback timer (spinner watchdog) and check-flash timer, cleared on any
  // transition and on unmount so a stale timer can't overwrite a newer state.
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearFallback() {
    if (fallbackRef.current !== null) {
      clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
  }
  function clearCheck() {
    if (checkRef.current !== null) {
      clearTimeout(checkRef.current);
      checkRef.current = null;
    }
  }
  // Transition to the brief checkmark, then auto-revert to idle.
  function flashCheck() {
    clearFallback();
    clearCheck();
    setState("check");
    checkRef.current = setTimeout(() => {
      checkRef.current = null;
      setState("idle");
    }, REFRESH_CHECK_MS);
  }

  // While spinning, a completed refresh (this tab's or any other's) clears the
  // spinner into the post-completion checkmark. Subscribe only when spinning so
  // an unrelated completion doesn't flash an idle button.
  useEffect(() => {
    if (state !== "spinning") return;
    const unsubscribe = subscribeStatusRefresh(() => flashCheck());
    return unsubscribe;
    // flashCheck is stable in effect terms (only touches refs + setState); the
    // subscription is re-established on each spin entry, which is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, subscribeStatusRefresh]);

  // Clean up any pending timers on unmount.
  useEffect(() => {
    return () => {
      clearFallback();
      clearCheck();
    };
  }, []);

  function handleClick() {
    // Ignore clicks while already spinning; a click during the check flash
    // starts a fresh cycle (the throttle server-side makes it safe to over-fire).
    if (state === "spinning") return;
    clearCheck();
    clearFallback();
    setState("spinning");
    // Arm the spinner watchdog at click entry, NOT inside `.then`: for a
    // started/coalesced click the completion event can beat the POST settle, so
    // arming in `.then` would (re)start a 15s timer after flashCheck() already
    // cleared it — a phantom checkmark ~15s later. Arming here means the event's
    // flashCheck (and the throttled/.catch paths) clear a timer that's already
    // running, and a hung POST is bounded rather than spinning forever.
    fallbackRef.current = setTimeout(() => {
      fallbackRef.current = null;
      flashCheck();
    }, REFRESH_FALLBACK_MS);
    void refreshStatus()
      .then(({ status }) => {
        if (status === "throttled") {
          // Nothing started and no event will come — flash "already fresh"
          // (flashCheck clears the fallback armed above).
          flashCheck();
        }
        // started / coalesced: keep spinning until the completion event; the
        // fallback armed at click entry already covers a missed event.
      })
      .catch(() => {
        // Best-effort/fire-and-forget: a non-2xx rejects (shared throwOnError).
        // Don't leave a stuck spinner — return to idle (clear the fallback too).
        clearFallback();
        setState("idle");
      });
  }

  const spinning = state === "spinning";
  const showCheck = state === "check";

  return (
    <Tip label="Refresh PR status">
    <button
      type="button"
      onClick={handleClick}
      disabled={spinning}
      aria-label="Refresh PR status"
      data-testid="pane-refresh"
      data-state={state}
      className="rk-glint min-w-[24px] min-h-[24px] coarse:min-w-[30px] coarse:min-h-[30px] rounded border border-border text-text-secondary hover:border-text-secondary transition-colors flex items-center justify-center disabled:opacity-60"
    >
      {showCheck ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          data-testid="pane-refresh-check"
          className="text-accent"
        >
          {/* checkmark — "done, you're current" */}
          <path d="M20 6 9 17l-5-5" />
        </svg>
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
          className={spinning ? "animate-spin" : undefined}
        >
          {/* lucide rotate-cw: circular arrow with a top-right arrowhead */}
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      )}
    </button>
    </Tip>
  );
}

export function WindowPanel({ window: win, operator }: WindowPanelProps) {
  const headerRight = win ? (
    <span className="flex min-w-0 items-center gap-1.5 text-text-secondary font-mono">
      <StatusDot win={win} />
      <span className="truncate">{win.name}</span>
    </span>
  ) : null;

  return (
    <CollapsiblePanel
      title="Pane"
      storageKey={PANE_PANEL_OPEN_STORAGE_KEY}
      defaultOpen={PANE_PANEL_DEFAULT_OPEN}
      headerRight={headerRight}
      headerAction={<PaneRefreshButton />}
    >
      {!win ? (
        <span className="text-xs text-text-secondary">No tab selected</span>
      ) : (
        <WindowContent win={win} operator={operator} />
      )}
    </CollapsiblePanel>
  );
}

/** Reusable interactive row that copies a value on click and shows inline "copied" feedback.
 *  The `group` class enables `group-hover:text-accent` on the value span so callers can
 *  reveal the accent color on hover as a clickability affordance.
 *  `tipLabel` names the register in plain words via a tier-1 `Tip` on the
 *  prefix span ONLY (260723-fm08) — never on the row button, whose click
 *  stays copy. Hover-only: the span remains non-focusable (the 73al
 *  connection-dot precedent — no new tab stops for non-actionable elements).
 *  The wrap survives the transient `copied ✓` swap (the tip describes the
 *  register, not the feedback state); a falsy label is Tip's pass-through.
 *  `flex` switches the button from a truncating inline row to a flex row whose
 *  children own their own shrink rules — required when the value composes
 *  spans with different truncation contracts (the cwd row: the parent path
 *  yields, the basename never truncates). */
function CopyableRow({ prefix, copied, onCopy, children, title, tipLabel, flex = false, continuation }: {
  prefix: string;
  copied: boolean;
  onCopy: () => void;
  children: ReactNode;
  title?: string;
  tipLabel?: string;
  flex?: boolean;
  /** A second line under the key line (a `ContinuationLine`). When set, the
   *  button stacks the two lines (`flex flex-col`) and each line truncates on
   *  its own — the key line never wraps into the continuation. A click
   *  anywhere on the block still copies. Mutually exclusive with `flex`. */
  continuation?: ReactNode;
}) {
  const buttonClass = "group text-left w-full cursor-pointer hover:bg-bg-inset bg-transparent border-0 p-0 m-0 font-inherit text-inherit";
  // A flex container trims a flex item's trailing collapsible space, so the
  // 4-advance key column (and the 9-advance `copied ✓`) must end in an NBSP
  // there — the PrLinkRow contract; inline mode keeps the plain space.
  const gap = flex ? "\u00a0" : " ";
  const prefixSpan = (
    <Tip label={tipLabel} placement="right">
      <span className={flex ? "text-text-secondary shrink-0" : "text-text-secondary"}>
        {copied ? `copied \u2713${gap}` : `${prefix}${gap}`}
      </span>
    </Tip>
  );
  if (continuation) {
    return (
      <button type="button" onClick={onCopy} className={`${buttonClass} flex flex-col`} title={title}>
        <span className="w-full min-w-0 truncate">
          {prefixSpan}
          {children}
        </span>
        {continuation}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className={`${buttonClass} ${flex ? "flex items-center whitespace-nowrap overflow-hidden" : "truncate"}`}
      title={title}
    >
      {prefixSpan}
      {children}
    </button>
  );
}

/** A register row's overflow line, indented to the panel's value column (the
 *  4-advance key + the 2-advance icon cell). Dim by default — the row's
 *  decisive tokens lead on the key line, so this line holds only the
 *  expendable tail, where truncation costs nothing; segments that carry
 *  their own hue (the PR health facts) keep it via their own class. `w-full`
 *  is what lets `truncate` bite inside a `flex-col` parent. */
function ContinuationLine({ testid, children }: { testid: string; children: ReactNode }) {
  return (
    <span className="w-full min-w-0 truncate pl-[6ch] text-text-secondary" data-testid={testid}>
      {children}
    </span>
  );
}

/** Open-first PR row (rendered only when a PR URL is present). The row BODY is a
 *  real anchor opening the PR in a new tab (native middle/Ctrl+click, right-click
 *  -> "Copy link address"); an always-visible inline `\u2197` right after the
 *  (possibly truncated) segment text signals "this row opens"; and the copy
 *  affordance is role-swapped to a hover-revealed icon on the right \u2014 the same
 *  row-body vs hover-icon split the sidebar window row uses. Takes `prUrl` as a
 *  typed `string` so neither the anchor nor the copy handler needs a non-null
 *  assertion (type narrowing over `!`). */
function PrLinkRow({ prUrl, prNumber, copied, onCopy, children, tipLabel, continuation }: {
  prUrl: string;
  prNumber: number | undefined;
  copied: boolean;
  onCopy: (url: string) => void;
  children: ReactNode;
  /** Tier-1 register-name tip on the prefix span only (260723-fm08) — the
   *  same seam as CopyableRow's `tipLabel`; the anchor's `title={prUrl}`
   *  state-reveal stays native per the 73al promotion rule. */
  tipLabel?: string;
  /** The health continuation line. It renders INSIDE the anchor, under the
   *  key line, so open-first (click, middle/Ctrl+click, right-click → copy
   *  link) and the hover tint cover the whole two-line block. */
  continuation?: ReactNode;
}) {
  return (
    <div className="group/pr relative">
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={prUrl}
        aria-label={`Open PR #${prNumber} in a new tab`}
        className="group flex flex-col w-full hover:bg-bg-inset"
      >
        <span className="flex items-center w-full min-w-0 pr-6">
        {/* Non-collapsing spacing: the anchor is a flex container, so a
            whitespace-only {" "} text node between flex items is dropped and a
            trailing collapsible space trimmed. The gap before the icon
            therefore lives as NBSPs INSIDE the prefix span, and the gap before
            the segments is an NBSP text node (an NBSP-only node survives; a
            space-only one does not) placed OUTSIDE the 14px icon span so it
            measures one 12px advance and the value column lines up with the
            inline rows' {" "}. CopyableRow renders `${prefix} ` (3-char prefix
            + a gap = 4 monospace advances before its icon; an NBSP gap in its
            flex mode), so the at-rest prefix here is "pr"+NBSP+NBSP (also 4 advances)
            to keep the icon/content column-aligned with tmx/cwd/git/fab and the
            no-URL pr branch. Lowercase "pr" \u2014 the register keys are one
            lowercase vocabulary (tmx/cwd/git/out/agt/fab/pr/opr). The
            "copied \u2713"+NBSP feedback is 9 advances, matching CopyableRow's
            "copied \u2713 " copied rendering. */}
        <Tip label={tipLabel} placement="right">
          <span className="text-text-secondary shrink-0">
            {copied ? "copied \u2713\u00a0" : "pr\u00a0\u00a0"}
          </span>
        </Tip>
        <span className={`${ICON_CLASS} shrink-0`} aria-hidden="true">{"\uf407"}</span>
        {"\u00a0"}
        <span data-testid="pr-line" className="min-w-0 truncate">
          {children}
        </span>
        <span
          className="shrink-0 pl-1 text-text-secondary group-hover:text-accent text-[12px]"
          aria-hidden="true"
        >
          {"\u2197"}
        </span>
        </span>
        {continuation}
      </a>
      {/* THE canonical hover-reveal contract (every hover-revealed icon
          cluster in the sidebar spells it this way): the CONTAINER gates
          reachability — pointer-events-none at rest on fine pointers so a
          stray click near the row's right edge falls through to the row body,
          restored on hover (group-hover), coarse pointers (always reachable —
          no hover dependence), and keyboard focus within
          (has-[:focus-visible]); the revealed BUTTONS carry the opacity
          mirror (opacity-0 → group-hover/coarse/focus-visible:opacity-100).
          A site whose button has no grouping container of its own MAY spell
          the same contract button-level (host-panel's palette action) —
          reachability semantics are the contract, not the markup. The ONE
          carve-out: window-row's cluster is deliberately FINE-POINTER-ONLY
          (not rendered on coarse at all — the status rail owns that surface),
          so it carries no coarse: escapes.
          This copy button is a SIBLING of the anchor (not
          enclosed by it), so the click cannot navigate on its own — the
          preventDefault() is belt-and-suspenders. Color follows the window-row
          cluster precedent (text-text-secondary hover:text-text-primary), NOT
          ICON_CLASS: ICON_CLASS carries text-accent-bright, which would fight
          text-text-secondary at equal specificity, so only its font/size pieces
          are kept.
          The container is `top-0 h-[1lh]` — the height of ONE text line — so
          the 24px button stays centred on the KEY line when a continuation
          line makes the block two lines tall (`top-1/2` would centre it on
          the block, between the two lines). */}
      <div className="absolute right-0 top-0 h-[1lh] flex items-center z-10 pointer-events-none group-hover/pr:pointer-events-auto coarse:pointer-events-auto has-[:focus-visible]:pointer-events-auto">
        <button
          type="button"
          aria-label="Copy PR URL"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCopy(prUrl);
          }}
          className="font-bold text-[14px] leading-none text-text-secondary hover:text-text-primary transition-opacity cursor-pointer opacity-0 group-hover/pr:opacity-100 coarse:opacity-100 focus-visible:opacity-100 px-0.5 min-w-[24px] min-h-[24px] coarse:min-w-[40px] coarse:min-h-[40px] flex items-center justify-center bg-transparent border-0"
        >
          {"\uf0c5"}
        </button>
      </div>
    </div>
  );
}

function WindowContent({ win, operator }: { win: WindowInfo; operator?: OperatorLoopFacts }) {
  // The `run` line's idle duration ticks once per second. Reading the clock
  // here (the leaf that composes the line) keeps the tick off the sidebar tree
  // — the bottom panel is a single instance, so its per-second re-render is
  // negligible and does not touch the memoized ServerGroup/SessionRow/WindowRow.
  const nowSeconds = useNow();
  // Copy interaction (selection guard, clipboard call, 1s `copied ✓` slot) is
  // the shared hook — one contract with the status bar's segments.
  const { copiedKey: copiedRow, copy: handleCopy } = useCopyFeedback<CopyableRowKey>();

  const activePane = win.panes?.find((p) => p.isActive);
  const activePaneCwd = activePane?.cwd ?? win.worktreePath;
  // The cwd value is basename-first: the basename is the answer and never
  // truncates; the abbreviated parent (with its trailing "/") is context that
  // yields. The split runs on the ABBREVIATED path (`~/code/…`), so the parent
  // span never re-introduces the long home prefix. A root-level or
  // single-segment path renders whole as the basename, with no parent span.
  const cwdAbbrev = abbreviateHomePath(activePaneCwd);
  const cwdSplitAt = cwdAbbrev.lastIndexOf("/");
  const cwdParent = cwdSplitAt > 0 ? cwdAbbrev.slice(0, cwdSplitAt + 1) : "";
  const cwdBase = cwdSplitAt > 0 ? cwdAbbrev.slice(cwdSplitAt + 1) : cwdAbbrev;
  // The active pane's cwd was deleted on disk (e.g. an archived worktree). Keep
  // the stale path as a breadcrumb but recolor the row and tag it "(deleted)".
  const cwdMissing = activePane?.cwdMissing ?? false;
  const paneId = activePane?.paneId ?? "";
  const tmxLabel = getTmxLabel(win);

  const gitBranch = activePane?.gitBranch ?? "";
  // The leading six-digit date prefix is the least scannable part of a fab
  // branch — the same dim rule the status bar's ⑂ segment renders (one regex,
  // splitDatePrefix in registers.ts). The copy value stays the full branch.
  const { prefix: gitDatePrefix, rest: gitBranchRest } = splitDatePrefix(gitBranch);

  // The slug is written once: when the pane's branch carries the change
  // (`<id>-<slug>`), the register shows `<id> · <stage>` — the `git` row above
  // already carries the slug; its presence beside a `main` or hand-named
  // branch is itself the off-branch signal.
  const fabParts = getFabParts(win, gitBranch);
  const outputLine = getOutputLine(win, nowSeconds);
  const agentLine = getAgentLine(win);
  const prParts = getPrParts(win);
  const operatorParts = getOperatorParts(win, operator, nowSeconds);
  // Stale describes the live watch loop, so it applies only to the watched
  // head — the done head (owner, unmonitored) never dims.
  const oprStale = win.monitored === true && operator?.stale === true;
  // The no-URL copy value is the joined one-line form (identity then health).
  const prText = prParts ? [...prParts.identity, ...prParts.health].map((s) => s.text).join(" · ") : "";
  // The colored PR segment spans (separator + segment) are identical in the
  // anchor (URL-present) and CopyableRow (no-URL) branches — one builder for
  // both lines of both branches so the segment styling can't drift.
  const toSegmentSpans = (segs: PrSegment[]) =>
    segs.map((seg, i) => (
      <span key={seg.text}>
        {i > 0 && <span className="text-text-secondary group-hover:text-accent">{" · "}</span>}
        <span className={`${seg.color} group-hover:text-accent`}>{seg.text}</span>
      </span>
    ));
  const prIdentitySpans = prParts ? toSegmentSpans(prParts.identity) : null;
  // Health facts ride the continuation line; a merged/closed PR has none
  // (getPrParts suppresses them), so it renders one line.
  const prContinuation =
    prParts && prParts.health.length > 0 ? (
      <ContinuationLine testid="pr-line-cont">{toSegmentSpans(prParts.health)}</ContinuationLine>
    ) : undefined;
  // The slug continues only when the branch does not carry it (getFabParts).
  const fabContinuation = fabParts?.slug ? (
    <ContinuationLine testid="fab-line-cont">{fabParts.slug}</ContinuationLine>
  ) : undefined;

  return (
    <div className="flex flex-col gap-0 text-xs">
      {/* tmx */}
      {paneId ? (
        <CopyableRow prefix="tmx" tipLabel="tmux pane" copied={copiedRow === "tmx"} onCopy={() => handleCopy("tmx", paneId)}>
          <span className={ICON_CLASS} aria-hidden="true">{"\uF489"}</span>
          {" "}
          <span className="text-text-secondary group-hover:text-accent">{tmxLabel}</span>
        </CopyableRow>
      ) : (
        <div className="truncate">
          <Tip label="tmux pane" placement="right">
            <span className="text-text-secondary">tmx </span>
          </Tip>
          <span className={ICON_CLASS} aria-hidden="true">{"\uF489"}</span>
          {" "}
          <span className="text-text-secondary">{tmxLabel}</span>
        </div>
      )}

      {/* cwd — basename-first: the parent span head-truncates (dir="rtl" moves
          the ellipsis to the head; the <bdi dir="ltr"> keeps the text itself
          in left-to-right glyph order) while the basename holds shrink-0. The
          flex CopyableRow lets the two spans carry their own shrink contracts;
          title and copy stay the full unabbreviated path. The icon/value gap
          is an NBSP text node — a flex row drops whitespace-only {" "} text
          nodes but keeps an NBSP (the PrLinkRow contract) — placed OUTSIDE
          the 14px icon span so it measures one 12px advance like the inline
          rows' {" "} and the value column lines up. */}
      <CopyableRow
        prefix="cwd"
        tipLabel="Working directory"
        copied={copiedRow === "cwd"}
        onCopy={() => handleCopy("cwd", activePaneCwd)}
        title={cwdMissing ? `${activePaneCwd} (no longer exists)` : activePaneCwd}
        flex
      >
        <span className={`${ICON_CLASS} shrink-0`} aria-hidden="true">{"\uF413"}</span>
        {"\u00a0"}
        <span className="flex min-w-0">
          {cwdParent && (
            <span
              className={`min-w-0 truncate ${cwdMissing ? "text-signal-red" : "text-text-secondary"}`}
              dir="rtl"
            >
              <bdi dir="ltr">{cwdParent}</bdi>
            </span>
          )}
          <span
            className={`shrink-0 ${cwdMissing ? "text-signal-red" : "text-text-primary group-hover:text-accent"}`}
          >
            {cwdBase}
          </span>
          {cwdMissing && (
            <span className="shrink-0 text-signal-red" data-testid="cwd-deleted"> (deleted)</span>
          )}
        </span>
      </CopyableRow>

      {/* git */}
      {gitBranch && (
        <CopyableRow prefix="git" tipLabel="Git branch" copied={copiedRow === "git"} onCopy={() => handleCopy("git", gitBranch)}>
          <span className={ICON_CLASS} aria-hidden="true">{"\uF418"}</span>
          {" "}
          <span className="text-text-primary group-hover:text-accent">
            {gitDatePrefix && <span className="text-text-secondary group-hover:text-accent">{gitDatePrefix}</span>}
            {gitBranchRest}
          </span>
        </CopyableRow>
      )}

      {/* PR (L3 register) — live PR status for ANY pane with a derived PR
          (ungated from fabChange; universal derivation, Principle X). Open-first
          (260703-41ks): when a PR URL is present, the row BODY is a real anchor
          that opens the PR in a new tab (native middle/Ctrl+click, right-click
          -> "Copy link address"), with an always-visible inline arrow (↗)
          right after the (possibly truncated) segment text signalling "this row
          opens", and the copy affordance role-swapped to a hover-revealed icon
          on the right — the same row-body vs hover-icon split the sidebar window
          row uses for its icon cluster. When there is no URL there is nothing to
          open, so the row stays a plain copy row. Both branches split the
          register the same way: identity (`#n · state`) on the key line, the
          health facts on the continuation line. Gated via getPrParts. */}
      {prParts && (
        win.prUrl ? (
          <PrLinkRow
            prUrl={win.prUrl}
            prNumber={win.prNumber}
            tipLabel="Pull request"
            copied={copiedRow === "pr"}
            onCopy={(url) => handleCopy("pr", url)}
            continuation={prContinuation}
          >
            {prIdentitySpans}
          </PrLinkRow>
        ) : (
          <CopyableRow
            prefix={"pr\u00A0"}
            tipLabel="Pull request"
            copied={copiedRow === "pr"}
            onCopy={() => handleCopy("pr", prText)}
            continuation={prContinuation}
          >
            <span className={ICON_CLASS} aria-hidden="true">{"\uF407"}</span>
            {" "}
            <span data-testid="pr-line">
              {prIdentitySpans}
            </span>
          </CopyableRow>
        )
      )}

      {/* ── The five orthogonal signal registers (status-pyramid.md § Row
          Minimalism): out (L0) / agt (L1) / fab (L2) / PR (L3, rendered just
          above) / opr (L4), fixed-width 3-char keys matching tmx/cwd/git. One
          line per
          layer, never collapsed, so the sidebar StatusDot is a pure function of
          what this panel shows and can be mentally derived from it. Absent
          layers render as absent (a plain shell pane shows only `out`). The
          identity rows (tmx/cwd/git) are pane metadata, orthogonal to these
          signal registers. ── */}

      {/* out (L0) — tmux activity + elapsed. Always rendered: L0 is the
          floor layer whose precondition is "always", so it is the one register
          a plain shell pane still shows. Its elapsed is never muted here (the
          register view is uncontested for space — the waiting-pierce rule). */}
      <div className="truncate" data-testid="register-output">
        <Tip label="Output activity" placement="right">
          <span className="text-text-secondary">out </span>
        </Tip>
        <BrailleSnake className={`${ICON_CLASS} font-normal`} />{" "}
        <span className="text-text-secondary">{outputLine}</span>
      </div>

      {/* agt (L1) — agentState + epoch duration. Absent when no agent. */}
      {agentLine && (
        <div className="truncate" data-testid="register-agent">
          <Tip label="Agent state" placement="right">
            <span className="text-text-secondary">agt </span>
          </Tip>
          <StarTwinkle className={`${ICON_CLASS} font-normal`} />{" "}
          <span className="text-text-secondary">{agentLine}</span>
        </div>
      )}

      {/* fab (L2) — key line <id> · <stage>[ · <displayState>], the slug on a
          continuation line only when the branch does not carry it. Absent
          when no fab change. The displayState token renders in the fab hue
          vocabulary (FAB_STATE_COLORS: green running/landed, yellow gated,
          red failed); an unknown state gets no extra class. The copy value
          stays the 4-char id — never the rendered line, so no colour markup
          can reach the clipboard. */}
      {fabParts && (
        <CopyableRow
          prefix="fab"
          tipLabel="Fab change"
          copied={copiedRow === "fab"}
          onCopy={() => handleCopy("fab", fabParts.id)}
          continuation={fabContinuation}
        >
          <ClockSpinner className={`${ICON_CLASS} font-normal`} />{" "}
          <span className="text-text-primary group-hover:text-accent">
            {fabParts.id} · {fabParts.stage}
            {fabParts.displayState && (
              <span className={`${FAB_STATE_COLORS[fabParts.displayState] ?? ""} group-hover:text-accent`}>{` · ${fabParts.displayState}`}</span>
            )}
          </span>
        </CopyableRow>
      )}

      {/* opr (L4) — operator watchlist: watched · stage · tick age, facets
          inline, or the done head for an operator-owned unmonitored window.
          Absent when the window is unmonitored and carries no owner. No
          per-layer icon (the watchlist has no animated mark); the column
          stays aligned by the 4-advance key, as the pr row does. Stale dims
          the value text and marks the row (the note-stale idiom) — watched
          head only; the done head is never stale. */}
      {operatorParts && (
        <div className="truncate" data-testid="register-operator" data-stale={oprStale ? "true" : undefined}>
          <Tip label="Operator watchlist" placement="right">
            <span className="text-text-secondary">opr </span>
          </Tip>
          <span className={oprStale ? "text-text-secondary" : "text-text-primary"}>
            {operatorParts.head}{operatorParts.facets ? ` · ${operatorParts.facets}` : ""}
          </span>
        </div>
      )}

    </div>
  );
}

/** @deprecated Use WindowPanel instead */
export const StatusPanel = WindowPanel;
