import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { safePolygon } from "@floating-ui/react";
import {
  useRowFlyout,
  WindowFlyoutContent,
  flyoutOpenDelay,
  resetFlyoutWarmState,
  scrubTargetAt,
  edgeAnchorReference,
  EDGE_ANCHOR_CONTAINER_SELECTOR,
  FLYOUT_OPEN_DELAY_MS,
  STATUS_DOT_DOCS_URL,
  STATUS_RAIL_WIDTH_PX,
  RAIL_ROW_SELECTOR,
  railRestBand,
  railHeldBand,
  RAIL_HELD_SEAM,
  FORK_TOOLTIP,
  canForkWindow,
  canRequestWindowOperatorAction,
} from "./row-flyout-card";

// safePolygon is wrapped with a delegating spy (behavior unchanged) because
// the polygon's options are otherwise unobservable in jsdom — a real pointer
// traversal through the polygon cannot be synthesized.
vi.mock("@floating-ui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/react")>();
  return { ...actual, safePolygon: vi.fn(actual.safePolygon) };
});
import { PopupTitleBar, PopupTitleBarSecondary, notchFill, POPUP_TITLE_BAR_HEIGHT_PX } from "./popup-title-bar";
import { CardActionList, CardActionRow } from "./row-flyout-card";
import { dotLabel } from "@/components/status-dot-label";
import { statusDotState } from "@/components/pr-status-model";
import type { OperatorLoopFacts } from "./registers";
import type { WindowInfo } from "@/types";
import { makeWindow, makeWindowWithPanes } from "@/test-utils/fixtures";

// The row-hover register flyout card (93dy) — the tier-2 surface replacing the
// retired StatusDotTip. The card opens on hover of its REFERENCE element after
// a delay; these tests drive fake timers to open it deterministically and to
// pin the useNow()-driven lines.

beforeEach(() => {
  vi.useFakeTimers();
  resetFlyoutWarmState();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetFlyoutWarmState();
});

/** Minimal consumer mirroring WindowRow's wiring: the shared shell's
 *  reference props ride a plain row element, the card renders as a sibling,
 *  and the window tier's content is built via the `content` render prop (the
 *  close-then-open handoff idiom for the Change color…/Pin rows lives at this
 *  seam in the real row). The imperative seams (`openNow` = the coarse
 *  rail-tap, `close` = drag start) are exposed as buttons so tests can drive
 *  them like the row does. `onFork` mirrors the row's bound fork handler
 *  (omitted ⇒ no fork affordance); `onRowClick` stands in for the real row's
 *  select-on-click so stopPropagation can be asserted. The root carries the
 *  shared `data-rail-row` handle so the scrub registry's hit-test resolves
 *  it. */
function Row({
  win,
  suppressed = false,
  onChangeColorAction,
  onFork,
  onFixTabName,
  hasOperator = false,
  onPinAction,
  pinned = false,
  pinnedBoard,
  onKillAction,
  onRowClick,
  operator,
}: {
  win: WindowInfo;
  suppressed?: boolean;
  onChangeColorAction?: () => void;
  onFork?: () => Promise<void>;
  onFixTabName?: () => Promise<void>;
  hasOperator?: boolean;
  onPinAction?: () => void;
  pinned?: boolean;
  pinnedBoard?: string;
  onKillAction?: () => void;
  onRowClick?: () => void;
  operator?: OperatorLoopFacts;
}) {
  const flyout = useRowFlyout({
    suppressed,
    content: ({ close }) => (
      <WindowFlyoutContent
        win={win}
        onChangeColorAction={
          onChangeColorAction
            ? () => {
                close();
                onChangeColorAction();
              }
            : undefined
        }
        onFork={onFork}
        onFixTabName={onFixTabName}
        hasOperator={hasOperator}
        onPinAction={
          onPinAction
            ? () => {
                close();
                onPinAction();
              }
            : undefined
        }
        pinned={pinned}
        pinnedBoard={pinnedBoard}
        onKillAction={onKillAction}
        operator={operator}
      />
    ),
  });
  return (
    <div
      ref={flyout.setReference}
      {...flyout.referenceProps}
      onClick={onRowClick}
      role="treeitem"
      data-window-id={win.windowId}
      data-rail-row=""
      data-testid="row"
    >
      row
      <button type="button" data-testid="open-now" onClick={() => flyout.openNow()} />
      <button type="button" data-testid="close-now" onClick={() => flyout.close()} />
      {flyout.card}
    </div>
  );
}

/** Hover the row and advance past the (cold) open delay. */
function hoverOpen(testid = "row") {
  const row = screen.getByTestId(testid);
  act(() => {
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    fireEvent.mouseEnter(row);
    vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
  });
}

function renderOpen(win: WindowInfo) {
  render(<Row win={win} />);
  hoverOpen();
}

describe("RowFlyout card content", () => {
  it("renders the identity title bar first with the docs link, and no status-label body line", () => {
    const win = makeWindow({ activity: "idle" });
    renderOpen(win);

    const card = screen.getByTestId("row-flyout-card");
    expect(card).toBeInTheDocument();
    const bar = screen.getByTestId("popup-title-bar");
    // Identity title (degraded form — the fixture carries no panes).
    expect(bar).toHaveTextContent("Tab @0");
    // The docs affordance rides the bar's right edge.
    const docs = screen.getByTestId("row-flyout-docs-link");
    expect(bar).toContainElement(docs);
    expect(docs).toHaveAttribute("href", STATUS_DOT_DOCS_URL);
    expect(docs).toHaveAttribute("target", "_blank");
    // No body line restates the dot's label — the row already carries it (the
    // label itself stays the dot's aria-label, single-sourced via dotLabel).
    const labelText = dotLabel(win, statusDotState(win));
    const label = Array.from(card.querySelectorAll("span")).find((s) => s.textContent === labelText);
    expect(label).toBeUndefined();
  });

  it("composes the full identity title — `Tab @N · pane %N · N panes`", () => {
    renderOpen(
      makeWindowWithPanes({
        windowId: "@31",
        panes: [
          { paneId: "%7", paneIndex: 0, cwd: "/x", command: "zsh", isActive: false },
          { paneId: "%425", paneIndex: 1, cwd: "/x", command: "claude", isActive: true },
        ],
      }),
    );
    const bar = screen.getByTestId("popup-title-bar");
    expect(bar).toHaveTextContent("Tab @31 · pane %425 · 2 panes");
    // Handles primary, literals secondary.
    expect(bar.querySelector("span")?.className).toContain("text-text-primary");
    const secondary = Array.from(bar.querySelectorAll("span")).find((s) =>
      s.className.includes("text-text-secondary"),
    );
    expect(secondary).toBeTruthy();
  });

  it("uses the singular `1 pane`", () => {
    renderOpen(makeWindowWithPanes({ windowId: "@31" }));
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Tab @31 · pane %5 · 1 pane");
  });

  it("degrades to `Tab @N` alone when panes are absent, and drops only the pane segment when none is active", () => {
    renderOpen(makeWindow({ windowId: "@31" }));
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Tab @31");
    expect(screen.getByTestId("popup-title-bar")).not.toHaveTextContent("pane");

    cleanup();
    renderOpen(
      makeWindow({
        windowId: "@31",
        panes: [
          { paneId: "%7", paneIndex: 0, cwd: "/x", command: "zsh", isActive: false },
          { paneId: "%8", paneIndex: 1, cwd: "/x", command: "zsh", isActive: false },
        ],
      }),
    );
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Tab @31 · 2 panes");
  });

  it("notch fill follows the band: inset inside the title bar, card surface below", () => {
    // jsdom has no layout, so the arrow middleware's y is unresolvable there —
    // the fill decision is pinned through its exported seam.
    expect(notchFill(0)).toBe("var(--color-bg-inset)");
    expect(notchFill(POPUP_TITLE_BAR_HEIGHT_PX - 1)).toBe("var(--color-bg-inset)");
    expect(notchFill(POPUP_TITLE_BAR_HEIGHT_PX)).toBe("var(--color-bg-card)");
    expect(notchFill(120)).toBe("var(--color-bg-card)");
    expect(notchFill(null)).toBe("var(--color-bg-card)");
    expect(notchFill(undefined)).toBe("var(--color-bg-card)");
  });

  it("renders no body block at all for a plain shell pane (no change, no PR)", () => {
    renderOpen(makeWindow({ activity: "idle" }));
    // Title bar and nothing else — no wrapper, no registers, no freshness.
    expect(screen.getByTestId("popup-title-bar")).toBeInTheDocument();
    for (const id of [
      "row-flyout-out",
      "row-flyout-agt",
      "row-flyout-fab",
      "row-flyout-fab-slug",
      "row-flyout-pr",
      "row-flyout-pr-link",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("an agent window with no change and no PR renders no body either", () => {
    renderOpen(makeWindow({ agentState: "waiting", agentIdleDuration: "3m" }));
    expect(screen.getByTestId("popup-title-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("row-flyout-agt")).toBeNull();
    expect(screen.queryByTestId("row-flyout-fab")).toBeNull();
    expect(screen.queryByTestId("row-flyout-pr")).toBeNull();
  });

  it("renders the fab register with its slug continuation and the pr register as one anchored line", () => {
    vi.setSystemTime(new Date("2026-08-05T10:00:30Z"));
    renderOpen(
      makeWindowWithPanes({
        activity: "active",
        agentState: "waiting",
        agentIdleDuration: "3m",
        fabChange: "260805-93dy-row-flyout",
        fabStage: "apply",
        fabDisplayState: "active",
        prNumber: 386,
        prUrl: "https://github.com/o/r/pull/386",
        prState: "open",
        prChecks: "pass",
        prReview: "approved",
        prFetchedAt: "2026-08-05T10:00:00Z",
      }),
    );

    // The out/agt registers are gone — the row's status dot already carries
    // that state.
    expect(screen.queryByTestId("row-flyout-out")).toBeNull();
    expect(screen.queryByTestId("row-flyout-agt")).toBeNull();
    // fab: the decisive tokens lead (id · stage · state); the slug continues
    // on an indented line where truncation costs nothing.
    expect(screen.getByTestId("row-flyout-fab")).toHaveTextContent("fab 93dy · apply · active");
    expect(screen.getByTestId("row-flyout-fab")).not.toHaveTextContent("row-flyout");
    const slug = screen.getByTestId("row-flyout-fab-slug");
    expect(slug).toHaveTextContent("row-flyout");
    expect(slug.className).toContain("pl-[4ch]");
    expect(slug.className).toContain("text-text-secondary");
    // pr: the identity stays inside the anchor; the health facts continue as
    // plain text OUTSIDE it (the anchor never spans two visual rows).
    const pr = screen.getByTestId("row-flyout-pr");
    expect(pr).toHaveTextContent("#386 · open · checks pass · review: approved");
    // Register + continuation lines ellipsize INSIDE the max-w-xs card (panel
    // parity — status-panel.tsx `min-w-0 truncate`); jsdom has no layout, so
    // the classes are pinned here and the real no-overflow box is asserted in
    // e2e (row-flyout.spec.ts).
    for (const id of ["row-flyout-fab", "row-flyout-fab-slug", "row-flyout-pr"]) {
      expect(screen.getByTestId(id).className).toContain("truncate");
    }
    // The pr LINE is the open-first anchor (PrLinkRow idiom): every segment
    // lives inside it, with the always-visible inline ↗ after them.
    const link = screen.getByTestId("row-flyout-pr-link");
    expect(link).toContainElement(pr);
    expect(link).toHaveTextContent("↗");
    expect(link).toHaveAttribute("aria-label", "Open PR #386 in a new tab");
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/386");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The anchor's prefix is EXACTLY "pr" + 2 NBSPs — the 4-advance column the
    // `fab ` prefix (and status-panel.tsx's pr rows) use. Pin
    // the codepoints so a mojibake re-encode (the cycle-1 `prÂ  ` regression,
    // U+00C2 U+00A0) can never silently return.
    const prPrefix = link.querySelector("span")!.textContent!;
    expect(Array.from(prPrefix).map((c) => c.codePointAt(0))).toEqual([
      0x70, 0x72, 0x00a0, 0x00a0,
    ]);
    // Row-aligned notch (E1): the arrow SVG renders inside the card.
    expect(screen.getByTestId("row-flyout-arrow")).toBeInTheDocument();
  });

  it("the widest PR state renders every segment on the one pr line", () => {
    renderOpen(
      makeWindow({
        prNumber: 540,
        prState: "open",
        prIsDraft: true,
        prChecks: "pending",
        prReview: "changes_requested",
      }),
    );
    const pr = screen.getByTestId("row-flyout-pr");
    expect(pr).toHaveTextContent("#540 · open (draft) · checks pending · review: changes requested");
    // One line, so it truncates rather than wrapping — the box is asserted in e2e.
    expect(pr.className).toContain("truncate");
  });

  it("a change with no PR renders the fab register alone (no pr group, no freshness)", () => {
    renderOpen(
      makeWindow({ fabChange: "260805-93dy-row-flyout", fabStage: "review", fabDisplayState: "active" }),
    );
    expect(screen.getByTestId("row-flyout-fab")).toHaveTextContent("fab 93dy · review · active");
    expect(screen.getByTestId("row-flyout-fab-slug")).toHaveTextContent("row-flyout");
    expect(screen.queryByTestId("row-flyout-pr")).toBeNull();
    expect(screen.queryByTestId("row-flyout-pr-link")).toBeNull();
  });

  it("a branch carrying the change drops the slug continuation; the state token is coloured", () => {
    renderOpen(
      makeWindow({
        fabChange: "260805-93dy-row-flyout",
        fabStage: "review",
        fabDisplayState: "failed",
        panes: [
          { paneId: "%7", paneIndex: 0, cwd: "/x", command: "zsh", isActive: true, gitBranch: "260805-93dy-row-flyout" },
        ],
      }),
    );
    // The branch already spells the slug — the continuation line is absent.
    expect(screen.getByTestId("row-flyout-fab")).toHaveTextContent("fab 93dy · review · failed");
    expect(screen.queryByTestId("row-flyout-fab-slug")).toBeNull();
    // The displayState token renders in the fab hue vocabulary.
    const state = screen.getByText("· failed");
    expect(state.className).toContain("text-signal-red");
  });

  it("an unknown fab displayState renders the token with no colour class", () => {
    renderOpen(
      makeWindow({ fabChange: "260805-93dy-row-flyout", fabStage: "review", fabDisplayState: "dancing" }),
    );
    expect(screen.getByText("· dancing").className).toBe("");
  });

  it("a fab change with no slug renders no empty continuation line", () => {
    renderOpen(makeWindow({ fabChange: "260805-93dy-", fabStage: "apply" }));
    expect(screen.getByTestId("row-flyout-fab")).toHaveTextContent("fab 93dy · apply");
    expect(screen.queryByTestId("row-flyout-fab-slug")).toBeNull();
  });

  it("a prFetchedAt with no PR is inert — the card carries no freshness line at all", () => {
    renderOpen(makeWindow({ prFetchedAt: "2026-08-05T10:00:00Z" }));
    expect(screen.queryByTestId("row-flyout-card")).toBeInTheDocument();
    expect(screen.queryByTestId("row-flyout-pr")).toBeNull();
  });

  it("the pr line keeps a color per segment", () => {
    renderOpen(makeWindow({ prNumber: 7, prState: "open", prChecks: "fail" }));
    const pr = screen.getByTestId("row-flyout-pr");
    const spans = Array.from(pr.querySelectorAll("span"));
    expect(spans.find((s) => s.textContent === "open")!.className).toContain("text-accent-green");
    expect(spans.find((s) => s.textContent === "checks fail")!.className).toContain("text-signal-red");
  });

  it("a bare prUrl with no prNumber renders no pr line — and no body when there is no change either", () => {
    renderOpen(makeWindow({ prUrl: "https://github.com/o/r/pull/9" }));
    // The URL alone is not content: no anchor, no pr register, no body block.
    expect(screen.queryByTestId("row-flyout-pr-link")).toBeNull();
    expect(screen.queryByTestId("row-flyout-pr")).toBeNull();
    expect(screen.queryByTestId("row-flyout-fab")).toBeNull();
    expect(screen.getByTestId("popup-title-bar")).toBeInTheDocument();
  });

  it("does not mount the card at rest and does not open while suppressed", () => {
    const win = makeWindow({});
    const { rerender } = render(<Row win={win} suppressed />);
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    hoverOpen();
    // Suppressed (popover open / ghost): hover never opens the card.
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    rerender(<Row win={win} suppressed={false} />);
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });

  it("openNow (the coarse dot-tap) honors the suppressed gate", () => {
    const win = makeWindow({});
    const { rerender } = render(<Row win={win} suppressed />);
    // A dot-tap while a row popover is open must not flash the card.
    act(() => {
      fireEvent.click(screen.getByTestId("open-now"));
    });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    // Unsuppressed, the same tap opens immediately (no hover delay).
    rerender(<Row win={win} suppressed={false} />);
    act(() => {
      fireEvent.click(screen.getByTestId("open-now"));
    });
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
  });
});

describe("Fork action row (260806-s4av)", () => {
  // The fork action row is DOUBLE-gated: the window must carry a supported agent
  // session AND the consumer must have wired a handler. Both halves are asserted, plus
  // the stopPropagation contract (forking must never also select the row) and
  // the in-flight guard (the POST creates a tmux window, so N clicks would
  // fork N times). Fork's ONLY home is the sectioned action list — the title
  // bar keeps just the docs link.

  /** A settled fork handler — the app's real one surfaces its own errors and
   *  resolves either way, so a resolved promise is the faithful stand-in. */
  const forkResolved = () => vi.fn<() => Promise<void>>(() => Promise.resolve());

  it("renders as an action row (never in the title bar) for a claude-agent window with a handler", () => {
    const onFork = forkResolved();
    render(<Row win={makeWindow({ agentProvider: "claude" })} onFork={onFork} />);
    hoverOpen();

    const fork = screen.getByTestId("row-flyout-fork-action");
    expect(fork).toBeInTheDocument();
    // Copy names the same-directory semantics — what distinguishes a fork from
    // the spawn dialog's fresh (usually new-worktree) agent. The label +
    // sub-hint split carries the same words as the tooltip.
    expect(fork).toHaveAttribute("title", FORK_TOOLTIP);
    expect(fork).toHaveAttribute("aria-label", FORK_TOOLTIP);
    expect(FORK_TOOLTIP).toContain("same directory");
    expect(fork).toHaveTextContent("Fork conversation");
    expect(fork).toHaveTextContent("new tab, same directory");
    // One affordance, one home: the title bar holds ONLY the docs link.
    const bar = screen.getByTestId("popup-title-bar");
    expect(bar).toContainElement(screen.getByTestId("row-flyout-docs-link"));
    expect(bar).not.toContainElement(fork);
    expect(bar.querySelectorAll("a, button")).toHaveLength(1);
  });

  it("is absent for a window with no agent provider", () => {
    render(<Row win={makeWindow({})} onFork={forkResolved()} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fork-action")).toBeNull();
    // The docs link is unaffected — the card still renders normally.
    expect(screen.getByTestId("row-flyout-docs-link")).toBeInTheDocument();
  });

  it("is absent for an unsupported provider", () => {
    render(<Row win={makeWindow({ agentProvider: "gemini" })} onFork={forkResolved()} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fork-action")).toBeNull();
  });

  it("is absent when the consumer wired no handler (board-route sidebar / bare row)", () => {
    render(<Row win={makeWindow({ agentProvider: "claude" })} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fork-action")).toBeNull();
  });

  it.each(["claude", "codex"])("%s fork calls the handler and does not bubble to the row", (agentProvider) => {
    const onFork = forkResolved();
    const onRowClick = vi.fn();
    render(<Row win={makeWindow({ agentProvider })} onFork={onFork} onRowClick={onRowClick} />);
    hoverOpen();

    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-fork-action"));
    });
    expect(onFork).toHaveBeenCalledTimes(1);
    // stopPropagation: forking must never also select the underlying row.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("disables the row while a fork is in flight, so a second click fires no second POST", async () => {
    // A handler that stays PENDING until the test resolves it — the in-flight
    // window the guard has to cover. The POST creates a tmux window, so a second
    // click getting through would create a second fork.
    let settle: () => void = () => {};
    const onFork = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<Row win={makeWindow({ agentProvider: "claude" })} onFork={onFork} />);
    hoverOpen();

    const fork = screen.getByTestId("row-flyout-fork-action");
    expect(fork).toBeEnabled();

    act(() => {
      fireEvent.click(fork);
    });
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(fork).toBeDisabled();

    act(() => {
      fireEvent.click(fork);
    });
    expect(onFork).toHaveBeenCalledTimes(1);

    // Settling re-enables it — a failed fork must stay retryable (the app's
    // handler resolves on error too, after surfacing a toast).
    await act(async () => {
      settle();
    });
    expect(screen.getByTestId("row-flyout-fork-action")).toBeEnabled();
  });

  it("canForkWindow supports Claude and Codex", () => {
    expect(canForkWindow(makeWindow({ agentProvider: "claude" }))).toBe(true);
    expect(canForkWindow(makeWindow({ agentProvider: "codex" }))).toBe(true);
    expect(canForkWindow(makeWindow({ agentProvider: "gemini" }))).toBe(false);
    expect(canForkWindow(makeWindow({}))).toBe(false);
  });
});

describe("Fix tab name action row (260822-fih1)", () => {
  // The Fix tab name row is DOUBLE-gated like fork: the derived availability
  // rule (operator on the server AND the subject carries an agent session ref
  // AND the subject is not itself the operator) AND a wired handler. Asserted
  // here: every gate half, the stopPropagation contract, and the in-flight
  // guard (the POST is mutating, so N clicks must not fire N requests).

  /** A settled fix-name handler — the app's real one surfaces its own errors
   *  and resolves either way, so a resolved promise is the faithful stand-in. */
  const fixNameResolved = () => vi.fn<() => Promise<void>>(() => Promise.resolve());

  /** A subject window meeting the availability rule: the server-derived
   *  conversation capability, no operator role. */
  const subjectWin = () =>
    makeWindow({ agentProvider: "claude", agentSessionRef: "ref-1", conversationAvailable: true });

  it("renders when the rule holds (operator present + agent session ref + not the operator row)", () => {
    render(<Row win={subjectWin()} hasOperator onFixTabName={fixNameResolved()} />);
    hoverOpen();

    const row = screen.getByTestId("row-flyout-fix-name-action");
    expect(row).toHaveTextContent("Fix tab name");
    expect(row).toHaveTextContent("asks the operator");
  });

  it("is absent without an operator on the server", () => {
    render(<Row win={subjectWin()} onFixTabName={fixNameResolved()} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fix-name-action")).toBeNull();
  });

  it("is absent when the subject carries no agent session ref", () => {
    render(<Row win={makeWindow({})} hasOperator onFixTabName={fixNameResolved()} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fix-name-action")).toBeNull();
  });

  it("is absent for an identity-only subject (no conversation capability)", () => {
    render(
      <Row
        win={makeWindow({ agentProvider: "copilot", agentSessionRef: "ref-1" })}
        hasOperator
        onFixTabName={fixNameResolved()}
      />,
    );
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fix-name-action")).toBeNull();
  });

  it("is absent on the operator's own row", () => {
    render(
      <Row
        win={makeWindow({ agentProvider: "claude", agentSessionRef: "ref-1", conversationAvailable: true, role: "operator" })}
        hasOperator
        onFixTabName={fixNameResolved()}
      />,
    );
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fix-name-action")).toBeNull();
  });

  it("is absent when the consumer wired no handler", () => {
    render(<Row win={subjectWin()} hasOperator />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-fix-name-action")).toBeNull();
  });

  it("clicking fires the handler once and does not bubble to the row", () => {
    const onFixTabName = fixNameResolved();
    const onRowClick = vi.fn();
    render(<Row win={subjectWin()} hasOperator onFixTabName={onFixTabName} onRowClick={onRowClick} />);
    hoverOpen();

    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-fix-name-action"));
    });
    expect(onFixTabName).toHaveBeenCalledTimes(1);
    // stopPropagation: the request must never also select the underlying row.
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("disables the row while a request is in flight, so a second click fires no second POST", async () => {
    // A handler that stays PENDING until the test resolves it — the in-flight
    // window the guard has to cover.
    let settle: () => void = () => {};
    const onFixTabName = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<Row win={subjectWin()} hasOperator onFixTabName={onFixTabName} />);
    hoverOpen();

    const row = screen.getByTestId("row-flyout-fix-name-action");
    expect(row).toBeEnabled();

    act(() => {
      fireEvent.click(row);
    });
    expect(onFixTabName).toHaveBeenCalledTimes(1);
    expect(row).toBeDisabled();

    act(() => {
      fireEvent.click(row);
    });
    expect(onFixTabName).toHaveBeenCalledTimes(1);

    // Settling re-enables it — a rejected request must stay retryable.
    await act(async () => {
      settle();
    });
    expect(screen.getByTestId("row-flyout-fix-name-action")).toBeEnabled();
  });

  it("canRequestWindowOperatorAction pins the three-part availability rule", () => {
    const subject = makeWindow({ agentSessionRef: "ref-1", conversationAvailable: true });
    expect(canRequestWindowOperatorAction(subject, true)).toBe(true);
    expect(canRequestWindowOperatorAction(subject, false)).toBe(false); // no operator
    expect(canRequestWindowOperatorAction(makeWindow({}), true)).toBe(false); // no capability
    expect(canRequestWindowOperatorAction(makeWindow({ agentSessionRef: "ref-1" }), true)).toBe(false); // identity without conversation access
    expect(canRequestWindowOperatorAction(makeWindow({ conversationAvailable: true, role: "operator" }), true)).toBe(false); // operator's own row
  });
});

describe("Note register (260824-bb5n)", () => {
  // The window card's note row: the `@rk_win_note` one-line status note plus its
  // relative age, dimmed past 24h (faded, never hidden). Degrade-to-absent: no
  // `note` → no row, no reserved space. Epoch-0 (tolerant-parse) notes render
  // text-only, undimmed.

  it("renders the note with its relative age, undimmed when fresh", () => {
    vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
    const epoch = Math.floor(Date.now() / 1000) - 2 * 3600; // 2h ago
    renderOpen(makeWindow({ note: "blocked on flaky e2e", noteEpoch: epoch }));

    const row = screen.getByTestId("row-flyout-note");
    expect(row).toHaveTextContent("blocked on flaky e2e · 2h ago");
    expect(row.className).not.toContain("opacity-50");
    expect(row).not.toHaveAttribute("data-stale");
  });

  it("renders dimmed when the note is older than 24h — faded, still legible", () => {
    vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
    const epoch = Math.floor(Date.now() / 1000) - 3 * 24 * 3600; // 3 days ago
    renderOpen(makeWindow({ note: "awaiting design decision", noteEpoch: epoch }));

    const row = screen.getByTestId("row-flyout-note");
    expect(row).toHaveTextContent("awaiting design decision · 72h ago");
    expect(row.className).toContain("opacity-50");
    expect(row).toHaveAttribute("data-stale", "true");
  });

  it("renders text-only, undimmed, for an epoch-0 (tolerant-parse) note", () => {
    renderOpen(makeWindow({ note: "just some text", noteEpoch: 0 }));

    const row = screen.getByTestId("row-flyout-note");
    expect(row).toHaveTextContent("just some text");
    expect(row).not.toHaveTextContent("ago");
    expect(row.className).not.toContain("opacity-50");
  });

  it("renders no note row when the payload carries no note", () => {
    renderOpen(makeWindow({}));
    expect(screen.queryByTestId("row-flyout-note")).toBeNull();
  });

  it("a note alone is enough body to lift the action list off the title bar (no flush gap)", () => {
    renderOpen(makeWindow({ note: "waiting on review", noteEpoch: 0 }));
    // The note counts as body — the action list renders its normal (non-flush)
    // spacing. Asserted via the note row existing between title bar and actions.
    expect(screen.getByTestId("row-flyout-note")).toBeInTheDocument();
  });
});

describe("opr register (operator watchlist)", () => {
  // The card's fifth register — `opr watched · stage · tick age` with the
  // repo · branch facets on a continuation line, rendered LAST (after the pr
  // block). Degrade-to-absent: no `monitored` → no row. The tick age is as of
  // the render frame (the card holds no clock — the NoteLine idiom).
  function renderOpenWithOperator(win: WindowInfo, operator?: OperatorLoopFacts) {
    render(<Row win={win} operator={operator} />);
    hoverOpen();
  }

  it("renders the opr register with head + facets when the window is monitored", () => {
    renderOpenWithOperator(
      makeWindow({
        monitored: true,
        monitoredRepo: "run-kit",
        monitoredStage: "apply",
        monitoredBranch: "fab/wuiu",
      }),
      { stale: false, lastTickAt: Math.floor(Date.now() / 1000) - 120 },
    );
    expect(screen.getByTestId("row-flyout-opr")).toHaveTextContent(
      "opr watched · apply · tick 2m ago",
    );
    expect(screen.getByTestId("row-flyout-opr-facets")).toHaveTextContent("run-kit · fab/wuiu");
  });

  it("renders as the LAST body register — after the fab and pr blocks", () => {
    renderOpenWithOperator(
      makeWindow({
        fabChange: "260805-93dy-row-flyout",
        fabStage: "apply",
        prNumber: 241,
        prState: "open",
        monitored: true,
        monitoredStage: "apply",
      }),
      { stale: false },
    );
    const fab = screen.getByTestId("row-flyout-fab");
    const pr = screen.getByTestId("row-flyout-pr");
    const opr = screen.getByTestId("row-flyout-opr");
    expect(fab.compareDocumentPosition(pr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pr.compareDocumentPosition(opr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no opr row (and no retired watched line) when the window is not monitored", () => {
    renderOpenWithOperator(makeWindow({}));
    expect(screen.queryByTestId("row-flyout-opr")).toBeNull();
    expect(screen.queryByTestId("row-flyout-opr-facets")).toBeNull();
    expect(screen.queryByTestId("row-flyout-watched-line")).toBeNull();
  });

  it("stale dims the head text and marks the line with data-stale", () => {
    renderOpenWithOperator(makeWindow({ monitored: true, monitoredStage: "apply" }), {
      stale: true,
    });
    const row = screen.getByTestId("row-flyout-opr");
    expect(row).toHaveAttribute("data-stale", "true");
    expect(row).toHaveTextContent("opr watched · apply");
    expect(row.querySelector("span:last-child")!.className).toContain(
      "text-text-secondary",
    );

    cleanup();
    renderOpenWithOperator(makeWindow({ monitored: true, monitoredStage: "apply" }), {
      stale: false,
    });
    const fresh = screen.getByTestId("row-flyout-opr");
    expect(fresh.getAttribute("data-stale")).toBeNull();
    expect(fresh.querySelector("span:last-child")!.className).toContain("text-text-primary");
  });

  it("owner-only window renders the body with the done head — no facets, never stale", () => {
    // No fabParts/PR/note/monitored: the owner marker alone lifts the body
    // gate, and a stale operator object still leaves the done head undimmed
    // (stale describes the live loop; a done row has no loop).
    renderOpenWithOperator(makeWindow({ owner: "operator" }), {
      stale: true,
      lastTickAt: Math.floor(Date.now() / 1000) - 120,
    });
    const opr = screen.getByTestId("row-flyout-opr");
    expect(opr).toHaveTextContent("opr done · operator-touched");
    expect(opr.getAttribute("data-stale")).toBeNull();
    expect(opr.querySelector("span:last-child")!.className).toContain("text-text-primary");
    expect(screen.queryByTestId("row-flyout-opr-facets")).toBeNull();
    // Owner carries no dot semantics — no watched underbar on the row.
    expect(screen.queryByTestId("status-dot-watched-bar")).toBeNull();
  });

  it("monitored wins over owner — the watched head renders, owner ignored", () => {
    renderOpenWithOperator(
      makeWindow({ monitored: true, monitoredStage: "apply", owner: "operator" }),
      { stale: false, lastTickAt: Math.floor(Date.now() / 1000) - 120 },
    );
    expect(screen.getByTestId("row-flyout-opr")).toHaveTextContent(
      "opr watched · apply · tick 2m ago",
    );
  });
});

describe("Flyout warm-window delay group (module-scoped)", () => {
  it("cold: full open delay; warm after a close: instant within the window", () => {
    vi.setSystemTime(new Date("2026-08-05T10:00:00Z"));
    expect(flyoutOpenDelay()).toEqual({ open: FLYOUT_OPEN_DELAY_MS, close: 0 });

    // Open then close a card — the cluster is now warm. Close via Escape
    // (useDismiss) — deterministic in jsdom, where safePolygon's zero-rect
    // pointer-leave geometry is not.
    render(<Row win={makeWindow({})} />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();

    // Within the 500ms warm window → instant open.
    expect(flyoutOpenDelay()).toEqual({ open: 0, close: 0 });
    // After the warm window lapses → cold again.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(flyoutOpenDelay()).toEqual({ open: FLYOUT_OPEN_DELAY_MS, close: 0 });
  });

  it("while a card is open elsewhere the cluster is warm (instant retarget)", () => {
    render(<Row win={makeWindow({})} />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    expect(flyoutOpenDelay()).toEqual({ open: 0, close: 0 });
  });

  it("a no-op close (card never opened) does not arm the warm window", () => {
    vi.setSystemTime(new Date("2026-08-05T10:00:00Z"));
    render(<Row win={makeWindow({})} />);
    // Drag-start fires `close()` even when the open delay never elapsed and
    // the card never opened — that must NOT stamp lastClosedAt (a false warm
    // window would make the next unrelated hover open instantly).
    act(() => {
      fireEvent.click(screen.getByTestId("close-now"));
    });
    expect(flyoutOpenDelay()).toEqual({ open: FLYOUT_OPEN_DELAY_MS, close: 0 });
  });

  it("opening a second row's card closes the first (single open card)", () => {
    render(
      <>
        <Row win={makeWindow({ windowId: "@1", name: "a" })} />
        <Row win={makeWindow({ windowId: "@2", name: "b" })} />
      </>,
    );
    const rows = screen.getAllByTestId("row");
    act(() => {
      fireEvent.pointerEnter(rows[0], { pointerType: "mouse" });
      fireEvent.mouseEnter(rows[0]);
      vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
    });
    expect(screen.getAllByTestId("row-flyout-card")).toHaveLength(1);
    // Cold open carries the slide-out entrance class (E1 base cue)…
    expect(screen.getByTestId("row-flyout-card").className).toContain("rk-flyout-in");
    act(() => {
      fireEvent.pointerEnter(rows[1], { pointerType: "mouse" });
      fireEvent.mouseEnter(rows[1]);
      // Warm (first card open) → instant open; the coordinator closes card #1.
      vi.advanceTimersByTime(50);
    });
    expect(screen.getAllByTestId("row-flyout-card")).toHaveLength(1);
    // …but a warm retarget snaps — no re-animation on every sweep.
    expect(screen.getByTestId("row-flyout-card").className).not.toContain("rk-flyout-in");
  });
});


// Sectioned action rows (change color → fork → pin → kill): the card is the
// color/pin/kill home on
// coarse pointers (where the in-row cluster is fine-pointer-only) and additive
// + Tab-reachable on desktop. Optional-handler idiom: a consumer wiring no
// handler renders no row.
describe("Pin/Kill action rows (ys3q)", () => {
  it("renders both action rows when handlers are wired, none when they are not", () => {
    render(<Row win={makeWindow({})} onPinAction={() => {}} onKillAction={() => {}} />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-pin-action")).toHaveTextContent("Pin to board…");
    expect(screen.getByTestId("row-flyout-pin-action")).toHaveTextContent("not pinned");
    expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill tab");
    expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("confirms first");
    // Optional-handler gating covers the Change color… row too: no color seam
    // wired ⇒ no row (and no throw).
    expect(screen.queryByTestId("row-flyout-color-action")).toBeNull();

    cleanup();
    render(<Row win={makeWindow({})} />);
    hoverOpen();
    expect(screen.queryByTestId("row-flyout-pin-action")).toBeNull();
    expect(screen.queryByTestId("row-flyout-kill-action")).toBeNull();
    // No handlers at all ⇒ the sectioned container itself is absent (no lone
    // top border under the freshness line).
    expect(screen.queryByTestId("row-flyout-actions")).toBeNull();
  });

  it("the Pin row's sub-hint reflects the pinned state (board name, bare pinned, not pinned)", () => {
    render(<Row win={makeWindow({})} onPinAction={() => {}} pinned pinnedBoard="work" />);
    hoverOpen();
    const pin = screen.getByTestId("row-flyout-pin-action");
    expect(pin).toHaveTextContent("Pin to board…");
    expect(pin).toHaveTextContent("work");

    cleanup();
    // Pinned without a known board degrades to a bare pinned wording.
    render(<Row win={makeWindow({})} onPinAction={() => {}} pinned />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-pin-action")).toHaveTextContent("pinned");
    expect(screen.getByTestId("row-flyout-pin-action")).not.toHaveTextContent("undefined");
  });

  it("rows render in the fixed change-color → fork → pin → kill order with the sectioned-list geometry", () => {
    render(
      <Row
        win={makeWindow({ agentProvider: "claude" })}
        onChangeColorAction={() => {}}
        onFork={() => Promise.resolve()}
        onPinAction={() => {}}
        onKillAction={() => {}}
      />,
    );
    hoverOpen();
    // `Change color…` is the FIRST action row of every tier's card
    // (260817-ve5m), exact wording.
    const color = screen.getByTestId("row-flyout-color-action");
    expect(color).toHaveTextContent("Change color…");
    const fork = screen.getByTestId("row-flyout-fork-action");
    const pin = screen.getByTestId("row-flyout-pin-action");
    const kill = screen.getByTestId("row-flyout-kill-action");
    expect(color.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fork.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pin.compareDocumentPosition(kill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One section with hairlines between its rows; touch height on coarse,
    // ~28px on fine pointers. This fixture has no change and no PR, so the
    // section is flush against the title bar and carries no top border of its
    // own — the two tests above own that split.
    const section = fork.parentElement!;
    expect(section.className).toContain("divide-y");
    expect(section).toContainElement(color);
    expect(section).toContainElement(pin);
    expect(section).toContainElement(kill);
    for (const row of [color, fork, pin, kill]) {
      expect(row.className).toContain("min-h-[28px]");
      expect(row.className).toContain("coarse:min-h-[36px]");
    }
    // Red treatment on kill.
    expect(kill.className).toContain("hover:text-signal-red");
  });

  it("kill invokes onKillAction and never selects the underlying row (stopPropagation); the card stays open for the confirm dialog", () => {
    const onKillAction = vi.fn();
    const onRowClick = vi.fn();
    render(<Row win={makeWindow({})} onKillAction={onKillAction} onRowClick={onRowClick} />);
    hoverOpen();

    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-kill-action"));
    });
    expect(onKillAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    // The card does not close on kill — the KillDialog confirm path takes over.
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
  });

  it("pin closes the card first, then hands off to the popover opener (never selects the row)", () => {
    const onPinAction = vi.fn();
    const onRowClick = vi.fn();
    render(<Row win={makeWindow({})} onPinAction={onPinAction} onRowClick={onRowClick} />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-pin-action"));
    });
    expect(onPinAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });
});

describe("flyout card elevation + action tray", () => {
  it("the card shell sits on the elevated surface with the popup-elevation shadow", () => {
    renderOpen(makeWindow({}));
    const card = screen.getByTestId("row-flyout-card");
    expect(card.className).toContain("bg-bg-card");
    expect(card.className).toContain("rk-popup-elev");
    expect(card.className).not.toContain("bg-bg-primary");
    expect(card.className).not.toContain("shadow-lg");
  });

  it("the action list is an inset tray reaching the card's bottom edge", () => {
    render(<Row win={makeWindow({})} onPinAction={() => {}} />);
    hoverOpen();
    const tray = screen.getByTestId("row-flyout-actions");
    expect(tray.className).toContain("bg-bg-inset");
    expect(tray.className).toContain("rounded-b-[5px]");
    expect(tray.className).toContain("-mb-1.5");
  });

  // Without a body the title bar's mb-0.5 and the card's gap-1 would leave 6px
  // of the card's lighter ground between two inset bands — a grey bar with
  // nothing in it. `flush` pulls the tray up over that space, and drops its
  // own border-t so the title bar's border-b is the single divider.
  it("a body-less card butts the tray against the title bar with one divider", () => {
    render(<Row win={makeWindow({})} onPinAction={() => {}} />);
    hoverOpen();
    const tray = screen.getByTestId("row-flyout-actions");
    expect(tray.className).toContain("-mt-1.5");
    expect(tray.className).not.toContain("border-t");
    expect(tray.className).not.toContain("mt-1 ");
  });

  it("a card with a body keeps the tray's own top border and spacing", () => {
    render(
      <Row
        win={makeWindow({ fabChange: "260817-kabi-hover-card-change-only", fabStage: "review" })}
        onPinAction={() => {}}
      />,
    );
    hoverOpen();
    expect(screen.getByTestId("row-flyout-fab")).toBeInTheDocument();
    const tray = screen.getByTestId("row-flyout-actions");
    expect(tray.className).toContain("border-t");
    expect(tray.className).not.toContain("-mt-1.5");
  });

  it("action rows read primary at rest and the rail color rides the danger seam", () => {
    render(
      <Row
        win={makeWindow({ agentProvider: "claude" })}
        onFork={() => Promise.resolve()}
        onPinAction={() => {}}
        onKillAction={() => {}}
      />,
    );
    hoverOpen();
    const pin = screen.getByTestId("row-flyout-pin-action");
    const kill = screen.getByTestId("row-flyout-kill-action");
    const fork = screen.getByTestId("row-flyout-fork-action");
    // The rail geometry is colorless and width-neutral: pl-1.5 (6px) plus the
    // 2px border restores the prior 8px inset, so labels never shift on hover.
    for (const row of [pin, kill, fork]) {
      expect(row.className).toContain("text-text-primary");
      expect(row.className).toContain("border-l-2");
      expect(row.className).toContain("border-l-transparent");
      expect(row.className).toContain("pl-1.5");
    }
    expect(pin.className).toContain("hover:border-l-accent-green");
    expect(pin.className).not.toContain("hover:border-l-signal-red");
    expect(kill.className).toContain("hover:border-l-signal-red");
    expect(kill.className).not.toContain("hover:border-l-accent-green");
    // Fork builds its own className, so it carries the rail directly — with a
    // disabled reset so an in-flight fork lights nothing on hover.
    expect(fork.className).toContain("hover:border-l-accent-green");
    expect(fork.className).toContain("disabled:hover:border-l-transparent");
  });

  it("the per-action sub-hint stays secondary but is no longer dimmed", () => {
    render(<Row win={makeWindow({})} onPinAction={() => {}} />);
    hoverOpen();
    const hint = Array.from(screen.getByTestId("row-flyout-pin-action").querySelectorAll("span")).find(
      (s) => s.textContent === "not pinned",
    )!;
    expect(hint.className).toContain("text-text-secondary");
    expect(hint.className).not.toContain("opacity-60");
  });
});

// Scrub registry (ys3q): module-scoped row-element → openNow map, populated by
// useRowFlyout, driving the coarse slide-to-scrub retarget. jsdom has no
// elementFromPoint, so the tests stub it (the gesture's hit-test seam).
describe("scrub registry (ys3q)", () => {
  function stubElementFromPoint(): ReturnType<typeof vi.fn> {
    const stub = vi.fn();
    (document as Document & { elementFromPoint?: unknown }).elementFromPoint = stub;
    return stub;
  }
  afterEach(() => {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("registers a row's openNow on mount and unregisters on unmount", () => {
    const elFromPoint = stubElementFromPoint();
    const { unmount } = render(<Row win={makeWindow({})} />);
    const row = screen.getByTestId("row");

    // A hit on a DESCENDANT resolves to the row root via closest().
    elFromPoint.mockReturnValue(row.querySelector("button"));
    const target = scrubTargetAt(0, 0);
    expect(target?.row).toBe(row);

    // The registered handle opens that row's card.
    act(() => {
      target?.open();
    });
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();

    // Unmount unregisters — a removed row can never be retargeted.
    unmount();
    expect(scrubTargetAt(0, 0)).toBeNull();
  });

  it("hit-testing a second row retargets the single-open card; non-row hits return null", () => {
    const elFromPoint = stubElementFromPoint();
    render(
      <>
        <Row win={makeWindow({ windowId: "@1", name: "a" })} />
        <Row win={makeWindow({ windowId: "@2", name: "b" })} />
      </>,
    );
    const rows = screen.getAllByTestId("row");

    elFromPoint.mockReturnValue(rows[0]);
    const a = scrubTargetAt(0, 0);
    expect(a?.row).toBe(rows[0]);
    act(() => {
      a?.open();
    });
    expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @1");

    elFromPoint.mockReturnValue(rows[1]);
    const b = scrubTargetAt(0, 0);
    expect(b?.row).toBe(rows[1]);
    act(() => {
      b?.open();
    });
    // One card, now anchored to B.
    expect(screen.getAllByTestId("row-flyout-card")).toHaveLength(1);
    expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @2");

    // Non-row element under the finger (header, gap, the card itself) → null,
    // so the caller leaves the current card open (no flicker-close).
    elFromPoint.mockReturnValue(document.body);
    expect(scrubTargetAt(0, 0)).toBeNull();
    expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @2");
  });
});

// Pointer-conditional placement + containment: on coarse the card anchors
// BELOW the row (bottom-start, top-start fallback) and the width cap comes
// from the size() middleware (the fine-pointer `max-w-xs` class is dropped so
// it cannot fight the cap); on fine the `right` arm is unchanged. jsdom has
// no layout, so placement geometry itself is pinned in e2e
// (row-flyout.spec.ts); here we pin the class-level contract.
describe("coarse placement + width cap", () => {
  /** Coarse-pointer stub: only `(pointer: coarse)` matches (the
   *  window-row.test.tsx idiom). jsdom has no real pointer media feature. */
  function mockCoarsePointer() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((q: string) => ({
        matches: ["(pointer: coarse)", "(any-pointer: coarse)"].includes(q),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the fine-pointer max-w-xs class on coarse (the size() middleware owns the cap)", () => {
    mockCoarsePointer();
    renderOpen(makeWindow({}));
    expect(screen.getByTestId("row-flyout-card").className).not.toContain("max-w-xs");
  });

  it("keeps the max-w-xs cap on a fine pointer (the right-placement arm is unchanged)", () => {
    renderOpen(makeWindow({}));
    expect(screen.getByTestId("row-flyout-card").className).toContain("max-w-xs");
  });
});

// `Change color…` (260817-ve5m): the FIRST action row of every tier's card —
// on the window card on BOTH pointer worlds. Mechanism is the Pin-row idiom:
// close the card, then invoke the consumer's picker opener.
describe("Change color… action row (260817-ve5m)", () => {
  it("closes the card first, then hands off to the picker opener (never selects the row)", () => {
    const onChangeColorAction = vi.fn();
    const onRowClick = vi.fn();
    render(<Row win={makeWindow({})} onChangeColorAction={onChangeColorAction} onRowClick={onRowClick} />);
    hoverOpen();
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-color-action"));
    });
    expect(onChangeColorAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    // The card closed BEFORE the handoff (the harness mirrors the row's
    // close-then-open seam).
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });

  it("renders on the fine-pointer (hover-opened) window card too, above Fork", () => {
    render(
      <Row
        win={makeWindow({ agentProvider: "claude" })}
        onChangeColorAction={() => {}}
        onFork={() => Promise.resolve()}
      />,
    );
    hoverOpen();
    const color = screen.getByTestId("row-flyout-color-action");
    const fork = screen.getByTestId("row-flyout-fork-action");
    expect(color.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// Three-tier constants + idioms (260817-ve5m): the ONE rail-width constant,
// the ONE shared hit-test selector, and the shared rail-band shade idioms.
describe("three-tier rail constants + tint idioms (260817-ve5m)", () => {
  it("STATUS_RAIL_WIDTH_PX is 56 — one constant, all tiers; the coarse width cap follows it", () => {
    expect(STATUS_RAIL_WIDTH_PX).toBe(56);
  });

  it("RAIL_ROW_SELECTOR is the single shared data-attribute selector", () => {
    expect(RAIL_ROW_SELECTOR).toBe("[data-rail-row]");
  });

  it("the rail-band idioms derive from existing tokens (color-mix into the inset base), no new tokens", () => {
    expect(railRestBand("rgb(1 2 3)")).toBe("color-mix(in srgb, var(--color-bg-inset) 55%, rgb(1 2 3))");
    // Held = one shade up: a deeper tint share.
    expect(railHeldBand("rgb(1 2 3)")).toBe("color-mix(in srgb, var(--color-bg-inset) 40%, rgb(1 2 3))");
    expect(RAIL_HELD_SEAM).toBe("var(--color-text-secondary)");
  });
});

// The session/server tiers on coarse pointers: the SAME shell with the rail's
// tap/scrub (`openNow`) as the coarse trigger — hover is `mouseOnly` (touch
// never hover-opens) and focus-open follows floating-ui's `:focus-visible`
// modality gate, so a tap's focus never opens the card. All tiers register in
// the same scrub registry, so a scrub retargets the single-open card ACROSS
// tiers.
describe("coarse-pointer session/server cards (260817-ve5m)", () => {
  /** Coarse-pointer stub: only the coarse queries match (the describe-local
   *  mirror of the "coarse placement + width cap" stub). */
  function mockCoarsePointer() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((q: string) => ({
        matches: ["(pointer: coarse)", "(any-pointer: coarse)"].includes(q),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  beforeEach(() => {
    mockCoarsePointer();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A rail-tier consumer (the session/server shape): generic tier
   *  content — PopupTitleBar title, one facts line, a CardActionList — on a
   *  non-treeitem root carrying the shared data-rail-row handle. */
  function TierRow({
    testid,
    title,
    facts,
    onAction,
    onRowClick,
  }: {
    testid: string;
    title: string;
    facts: string;
    onAction?: () => void;
    onRowClick?: () => void;
  }) {
    const flyout = useRowFlyout({
      content: () => (
        <>
          <PopupTitleBar>
            <PopupTitleBarSecondary>Server </PopupTitleBarSecondary>
            {title}
          </PopupTitleBar>
          <span className="text-text-secondary">{facts}</span>
          <CardActionList>
            <CardActionRow
              icon={<span />}
              label="Kill server"
              hint="confirms first"
              danger
              testid="row-flyout-kill-action"
              onClick={() => onAction?.()}
            />
          </CardActionList>
        </>
      ),
    });
    return (
      <div
        ref={flyout.setReference}
        {...flyout.referenceProps}
        onClick={onRowClick}
        data-rail-row=""
        data-testid={testid}
      >
        {testid}
        {/* The real rail's trailing click stopPropagations so a tap never
            selects the row — mirror that here. */}
        <button
          type="button"
          data-testid={`${testid}-open`}
          onClick={(e) => {
            e.stopPropagation();
            flyout.openNow();
          }}
        />
        {flyout.card}
      </div>
    );
  }

  it("never hover-opens on a touch pointer (the rail tap is the coarse trigger); openNow opens the card", () => {
    render(<TierRow testid="srv" title="alpha" facts="tmux -L alpha · 2 sessions" />);
    const row = screen.getByTestId("srv");
    act(() => {
      fireEvent.pointerEnter(row, { pointerType: "touch" });
      fireEvent.mouseEnter(row);
      vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 100);
    });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("srv-open"));
    });
    const card = screen.getByTestId("row-flyout-card");
    expect(card).toBeInTheDocument();
    // Title + facts + the sectioned action list; the coarse arm owns the
    // width (no fine-pointer max-w-xs class).
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Server alpha");
    expect(card).toHaveTextContent("tmux -L alpha · 2 sessions");
    expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill server");
    expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("confirms first");
    expect(card.className).not.toContain("max-w-xs");
  });

  it("card action rows stopPropagation (never toggle/select the underlying row)", () => {
    const onAction = vi.fn();
    const onRowClick = vi.fn();
    render(<TierRow testid="srv" title="alpha" facts="f" onAction={onAction} onRowClick={onRowClick} />);
    act(() => {
      fireEvent.click(screen.getByTestId("srv-open"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-kill-action"));
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("registers in the one scrub registry: a scrub retargets the single-open card ACROSS tiers", () => {
    const elFromPoint = vi.fn();
    (document as Document & { elementFromPoint?: unknown }).elementFromPoint = elFromPoint;
    try {
      render(
        <>
          <Row win={makeWindow({ windowId: "@1", name: "win-a" })} />
          <TierRow testid="srv" title="alpha" facts="tmux -L alpha · 2 sessions" />
        </>,
      );
      const winRow = screen.getByTestId("row");
      const srvRow = screen.getByTestId("srv");

      // Open the WINDOW tier's card via the registry.
      elFromPoint.mockReturnValue(winRow);
      const a = scrubTargetAt(0, 0);
      expect(a?.row).toBe(winRow);
      act(() => {
        a?.open();
      });
      expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Tab @1");

      // Hit-test the SERVER tier's (non-treeitem) root — the shared
      // data-rail-row selector resolves it where the old
      // '[role="treeitem"][data-window-id]' selector could not.
      elFromPoint.mockReturnValue(srvRow);
      const b = scrubTargetAt(0, 0);
      expect(b?.row).toBe(srvRow);
      act(() => {
        b?.open();
      });
      // One card, retargeted across the tier boundary.
      expect(screen.getAllByTestId("row-flyout-card")).toHaveLength(1);
      expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("Server alpha");
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it("a rail-bearing-shaped element with NO registered flyout does not resolve (registry lookup, not just the attribute)", () => {
    const elFromPoint = vi.fn();
    (document as Document & { elementFromPoint?: unknown }).elementFromPoint = elFromPoint;
    try {
      render(<div data-rail-row="" data-testid="stray" />);
      elFromPoint.mockReturnValue(screen.getByTestId("stray"));
      expect(scrubTargetAt(0, 0)).toBeNull();
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });
});

// The edge-anchored mount: a grid-cell reference (not full-bleed to the
// sidebar width) opts in to a virtual position reference at the sidebar
// container's right edge plus a pointer-events-blocking hover-close polygon,
// so the card opens where the full-bleed rows' cards open and grid siblings
// crossed en route cannot hover-steal the single-open card. Events stay on
// the real node; mounts without the opt-in are untouched.
describe("edge-anchored mount (edgeAnchor)", () => {
  /** DOMRect-shaped literal for getBoundingClientRect mocks. */
  function domRect(r: { top: number; bottom: number; left: number; right: number }): DOMRect {
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      x: r.left,
      y: r.top,
      width: r.right - r.left,
      height: r.bottom - r.top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Minimal grid-cell consumer (the SERVER tile's shape): trivial content —
   *  these tests assert geometry and polygon options, not card content. */
  function Tile({ edgeAnchor = true }: { edgeAnchor?: boolean }) {
    const flyout = useRowFlyout({
      edgeAnchor,
      content: () => <div data-testid="tile-card-body" />,
    });
    return (
      <div ref={flyout.setReference} {...flyout.referenceProps} data-testid="tile">
        tile
        {flyout.card}
      </div>
    );
  }

  /** Sidebar-root fixture matching EDGE_ANCHOR_CONTAINER_SELECTOR. */
  function makeNav(): HTMLElement {
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Sessions");
    document.body.appendChild(nav);
    return nav;
  }

  it("edgeAnchorReference: the reference's y-band at the sidebar container's right x, width 0", () => {
    const nav = makeNav();
    const tile = document.createElement("button");
    nav.appendChild(tile);
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(domRect({ top: 0, bottom: 700, left: 0, right: 240 }));
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(domRect({ top: 100, bottom: 140, left: 20, right: 120 }));

    const ref = edgeAnchorReference(tile);
    expect(ref.contextElement).toBe(tile);
    expect(ref.getBoundingClientRect()).toEqual({
      x: 240,
      y: 100,
      top: 100,
      bottom: 140,
      height: 40,
      left: 240,
      right: 240,
      width: 0,
    });
    expect(tile.closest(EDGE_ANCHOR_CONTAINER_SELECTOR)).toBe(nav);
    nav.remove();
  });

  it("edgeAnchorReference derives at measure time — a container resize is seen on the next call, no cached rect", () => {
    const nav = makeNav();
    const tile = document.createElement("button");
    nav.appendChild(tile);
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(domRect({ top: 100, bottom: 140, left: 20, right: 120 }));
    const navRect = vi.spyOn(nav, "getBoundingClientRect");
    navRect.mockReturnValue(domRect({ top: 0, bottom: 700, left: 0, right: 240 }));

    const ref = edgeAnchorReference(tile);
    expect(ref.getBoundingClientRect().right).toBe(240);
    navRect.mockReturnValue(domRect({ top: 0, bottom: 700, left: 0, right: 320 }));
    expect(ref.getBoundingClientRect().right).toBe(320);
    nav.remove();
  });

  it("edgeAnchorReference falls back to the reference's own FULL rect without a sidebar-container ancestor", () => {
    const tile = document.createElement("button");
    document.body.appendChild(tile);
    const own = domRect({ top: 100, bottom: 140, left: 20, right: 120 });
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(own);

    // Today's geometry verbatim — not a width-0 rect at the node's right edge,
    // which would still alter rects.reference for middleware.
    expect(edgeAnchorReference(tile).getBoundingClientRect()).toBe(own);
    tile.remove();
  });

  it("the edge-anchored mount blocks pointer events in the hover-close polygon; default mounts pass no options", () => {
    vi.mocked(safePolygon).mockClear();
    render(<Tile edgeAnchor />);
    expect(vi.mocked(safePolygon)).toHaveBeenLastCalledWith({ blockPointerEvents: true });
    cleanup();

    vi.mocked(safePolygon).mockClear();
    render(<Tile edgeAnchor={false} />);
    expect(vi.mocked(safePolygon)).toHaveBeenLastCalledWith(undefined);
  });

  // Final on-screen coordinates are e2e territory: jsdom has no layout, so
  // floating-ui's clipping rects are zero-sized and flip()/shift() clamp the
  // computed position into junk. What IS deterministic here is which rects
  // the position pipeline reads — the sidebar container's only under the
  // opt-in, proving the virtual reference is installed (or not).
  it("opening the edge-anchored card measures the sidebar container; the default mount never does", async () => {
    const nav = makeNav();
    const navRect = vi.spyOn(nav, "getBoundingClientRect");
    navRect.mockReturnValue(domRect({ top: 0, bottom: 700, left: 0, right: 240 }));
    render(<Tile edgeAnchor />, { container: nav });

    hoverOpen("tile");
    // Flush floating-ui's async position computation.
    await act(async () => {});
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    expect(navRect).toHaveBeenCalled();
    cleanup();
    nav.remove();

    const nav2 = makeNav();
    const nav2Rect = vi.spyOn(nav2, "getBoundingClientRect");
    nav2Rect.mockReturnValue(domRect({ top: 0, bottom: 700, left: 0, right: 240 }));
    render(<Tile edgeAnchor={false} />, { container: nav2 });

    hoverOpen("tile");
    await act(async () => {});
    expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
    // Default path: the events reference doubles as the position reference —
    // the container is never consulted.
    expect(nav2Rect).not.toHaveBeenCalled();
    nav2.remove();
  });
});
