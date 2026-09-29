import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { buildNavActions } from "@/lib/palette/nav";
import { buildUpdateActions } from "@/lib/palette/update";

/**
 * Tests for the board-related palette entries — covers conditional visibility
 * rules and selection actions. The `buildBoardActions` helper below is a hand-
 * written mirror that draws from TWO distinct production sources, not one:
 *   - `boardRouteActions` in `components/board/board-page.tsx` — the route-
 *     scoped entries the board registers into the palette-actions slot
 *     (260811-239r; the single CommandPalette mounts in AppLayout). Source of
 *     the Switch/Leave/Cycle entries.
 *   - `boardActions` in `app.tsx` — the AppShell-registered route list's board
 *     block. Source of the Pin/Unpin Current Window entries (gated on
 *     `hasCurrentWindow`/`isCurrentWindowPinned`), which do NOT exist in
 *     `boardRouteActions`, and of the "hides Leave/Cycle when not on a board
 *     route" rule (`boardRouteActions` renders Leave unconditionally).
 *
 * The "View: Refresh Page" / nav / update groups are layout-level globals now
 * (`use-global-palette-actions.ts`, 260811-239r — previously DD-8 duplicates
 * inside `boardRouteActions`); the mirror keeps them so these tests still pin
 * their presence/shape RULES in the merged list the board palette renders.
 *
 * The mirror is deliberately partial and does NOT reproduce production 1:1: it
 * omits the global font trio + help entry and positions `refreshEntry` right
 * after the nav entries rather than after the font trio as production does. It
 * also never executes either production `onSelect` (the mirror wires its own
 * stubs). So these tests verify the entry-shape and visibility RULES the
 * mirror reproduces — not full parity, and not the production selection
 * wiring; treat them as rule checks, not a drift alarm for the parts left out.
 *
 * The nav entries (`Go: Back` / `Go: Forward` / `Go: Host`) are unconditional
 * globals (i996 — palette parity for the top-bar history arrows + the board
 * breadcrumb's Host ancestor). Production builds them via
 * `buildNavActions("board", ...)` at the layout level (unit-tested in
 * `lib/palette/nav.test` — the source of truth for gating/labels); the mirror
 * uses the SAME production helper, positioned after `conditional` as the
 * merged list does, matching the `buildUpdateActions` treatment.
 *
 * The update entry (`HexoKit: Dismiss Update Notice`) is a global group
 * (260713-4zap; Dismiss-only since the dynamic `Update to v{X}` entry was
 * deleted — 260720-n2ai) — below `sm` the top-bar UpdateChip is hidden, so the
 * palette is a phone user's ONLY update surface. Production builds it via
 * `buildUpdateActions` (unit-tested in `lib/palette/update.test` — the source
 * of truth for its shape/gating/wiring); here the mirror only verifies the
 * qualify-gated presence RULE, matching the `refreshEntry` treatment.
 */

function openPalette() {
  fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
}

interface BuildOpts {
  boards: Array<{ name: string }>;
  currentBoardName?: string;
  isOnBoardRoute?: boolean;
  hasCurrentWindow?: boolean;
  isCurrentWindowPinned?: boolean;
  onSwitch?: (name: string) => void;
  onPinCurrent?: () => void;
  onUnpinCurrent?: () => void;
  onLeaveBoardView?: () => void;
  onCycleNext?: () => void;
  onCyclePrev?: () => void;
  onRefresh?: () => void;
  /** Board has ≥1 pinned entry — production gates the cycle + unpin-focused +
   *  split/close-focused entries on `entries.length > 0`. Defaults true so
   *  existing cases (which assume a populated board) are unaffected. */
  hasEntries?: boolean;
  onUnpinFocused?: () => void;
  /** Split/close-focused handlers (260715-6jwn) — the palette parity for the
   *  board top-bar SplitButtons + ✕. Present only with entries. */
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  onCloseFocused?: () => void;
  /** A qualifying pending update exists (`qualifies && latest`). Production folds
   *  the Dismiss entry in via `buildUpdateActions`, gated on `qualifies` alone
   *  (dismissal-independent). Defaults false. */
  updateLatest?: string | null;
  onDismissUpdate?: () => void;
  /** Nav handlers (i996) — production wires these to `router.history.back()` /
   *  `.forward()` and `navigate({ to: "/" })`; the mirror stubs them. */
  onNavBack?: () => void;
  onNavForward?: () => void;
  onNavHost?: () => void;
}

function buildBoardActions(opts: BuildOpts): PaletteAction[] {
  const switchEntries: PaletteAction[] = opts.boards.map((b) => ({
    id: `board-switch-${b.name}`,
    label: `Board: Switch to ${b.name}${b.name === opts.currentBoardName ? " (current)" : ""}`,
    onSelect: () => opts.onSwitch?.(b.name),
  }));

  const conditional: PaletteAction[] = [];

  if (opts.hasCurrentWindow) {
    conditional.push({
      id: "board-pin-current",
      label: "Board: Pin Current Window",
      onSelect: () => opts.onPinCurrent?.(),
    });
  }

  if (opts.isCurrentWindowPinned) {
    conditional.push({
      id: "board-unpin-current",
      label: "Board: Unpin Current Window",
      onSelect: () => opts.onUnpinCurrent?.(),
    });
  }

  if (opts.isOnBoardRoute) {
    conditional.push({
      id: "board-leave",
      label: "Board: Leave Board View",
      onSelect: () => opts.onLeaveBoardView?.(),
    });
    // Cycle + unpin-focused are gated on the board having entries in production
    // (`entries.length > 0`). Mirror that with `hasEntries` (default true).
    if (opts.hasEntries !== false) {
      conditional.push({
        id: "board-cycle-next",
        label: "Board: Cycle Pane Focus →",
        onSelect: () => opts.onCycleNext?.(),
      });
      conditional.push({
        id: "board-cycle-prev",
        label: "Board: Cycle Pane Focus ←",
        onSelect: () => opts.onCyclePrev?.(),
      });
      // Board: Unpin Focused Pane — keyboard parity for the tile-header + palette
      // unpin. Present only with entries; unpins the focused pane. Unchanged by
      // 260715-6jwn (the top-bar ✕ became a kill, but unpin still lives here).
      conditional.push({
        id: "board-unpin-focused",
        label: "Board: Unpin Focused Pane",
        onSelect: () => opts.onUnpinFocused?.(),
      });
      // Split/close focused pane (260715-6jwn) — keyboard parity for the board
      // top-bar split control + ✕. Present only with entries; act on the
      // focused tile. Horizontal first (default-first) with booleans matching
      // the top-bar chip semantics (260806-2x2h): Horizontal → horizontal:
      // true (side-by-side), Vertical → false (stacked).
      conditional.push({
        id: "board-split-horizontal",
        label: "Board: Split Focused Pane Horizontal",
        onSelect: () => opts.onSplitHorizontal?.(),
      });
      conditional.push({
        id: "board-split-vertical",
        label: "Board: Split Focused Pane Vertical",
        onSelect: () => opts.onSplitVertical?.(),
      });
      conditional.push({
        id: "board-close-focused",
        label: "Board: Close Focused Pane",
        onSelect: () => opts.onCloseFocused?.(),
      });
    }
  }

  // Nav entries — folded into boardRouteActions unconditionally (i996), built
  // via the SAME production helper (`buildNavActions`) with the mirror's stub
  // handlers. Board mode + server "" ⇒ Go: Back / Go: Forward / Go: Host and
  // never Go: tmux Server (that entry is terminal-mode-only), so the tmux
  // Server handler is an unreachable no-op exactly as in production.
  const navEntries = buildNavActions("board", "", {
    onBack: () => opts.onNavBack?.(),
    onForward: () => opts.onNavForward?.(),
    onTmuxServer: () => {},
    onHost: () => opts.onNavHost?.(),
  });

  // Always-present global (unconditional refreshEntry) — a layout-level global
  // group since 260811-239r (previously duplicated into boardRouteActions, R4).
  const refreshEntry: PaletteAction = {
    id: "refresh-page",
    label: "View: Refresh Page",
    onSelect: () => opts.onRefresh?.(),
  };

  // Update entry — a layout-level global group since 260811-239r (previously
  // folded into boardRouteActions after refresh/help; 260713-4zap;
  // Dismiss-only since 260720-n2ai). Built via the SAME
  // production helper (`buildUpdateActions`), gated on a qualifying pending
  // update, dismissal-independent.
  const updateEntries = buildUpdateActions(
    opts.updateLatest != null,
    opts.updateLatest != null ? [{ tool: "run-kit", current: "", latest: opts.updateLatest }] : [],
    () => opts.onDismissUpdate?.(),
  );

  return [...switchEntries, ...conditional, ...navEntries, refreshEntry, ...updateEntries];
}

describe("CmdK Board Actions", () => {
  afterEach(cleanup);

  it("renders one Switch entry per board with (current) on the active one", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }, { name: "deploy" }, { name: "staging" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Switch to main (current)")).toBeInTheDocument();
    expect(screen.getByText("Board: Switch to deploy")).toBeInTheDocument();
    expect(screen.getByText("Board: Switch to staging")).toBeInTheDocument();
  });

  it("hides Pin Current Window when there is no current window", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      hasCurrentWindow: false,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Board: Pin Current Window")).not.toBeInTheDocument();
  });

  it("shows Pin Current Window when on a window route with a current window", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      hasCurrentWindow: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Pin Current Window")).toBeInTheDocument();
  });

  it("shows Unpin Current Window when current window is already pinned", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      hasCurrentWindow: true,
      isCurrentWindowPinned: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Unpin Current Window")).toBeInTheDocument();
  });

  it("hides Unpin Current Window when current window is not pinned", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      hasCurrentWindow: true,
      isCurrentWindowPinned: false,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Board: Unpin Current Window")).not.toBeInTheDocument();
  });

  it("hides Leave Board View and Cycle Pane Focus when not on a board route", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: false,
      hasCurrentWindow: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Board: Leave Board View")).not.toBeInTheDocument();
    expect(screen.queryByText("Board: Cycle Pane Focus →")).not.toBeInTheDocument();
    expect(screen.queryByText("Board: Cycle Pane Focus ←")).not.toBeInTheDocument();
  });

  it("shows Leave Board View and Cycle Pane Focus on a board route", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Leave Board View")).toBeInTheDocument();
    expect(screen.getByText("Board: Cycle Pane Focus →")).toBeInTheDocument();
    expect(screen.getByText("Board: Cycle Pane Focus ←")).toBeInTheDocument();
  });

  it("invokes onSelect when a Switch entry is selected", () => {
    const onSwitch = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }, { name: "deploy" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      onSwitch,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    // Filter to deploy entry to get a deterministic Enter target.
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "deploy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSwitch).toHaveBeenCalledWith("deploy");
  });

  it("Reorder Pane is NOT in v1 — entry must not be present", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText(/Board: Reorder Pane/)).not.toBeInTheDocument();
  });

  it("always renders the 'View: Refresh Page' entry (R4)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("View: Refresh Page")).toBeInTheDocument();
  });

  it("invokes reload when 'View: Refresh Page' is selected (R4)", () => {
    const onRefresh = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
      onRefresh,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Refresh Page" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("folds in 'HexoKit: Dismiss Update Notice' when an update qualifies — and never a dynamic Update entry (260720-n2ai)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
      updateLatest: "0.6.0",
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("HexoKit: Dismiss Update Notice")).toBeInTheDocument();
    // The deleted `HexoKit: Update to v{X}` entry must never reappear.
    expect(screen.queryByText(/HexoKit: Update to/)).not.toBeInTheDocument();
  });

  it("omits the update entry when no update qualifies (260713-4zap)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
      updateLatest: null,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText(/HexoKit: Update to/)).not.toBeInTheDocument();
    expect(screen.queryByText("HexoKit: Dismiss Update Notice")).not.toBeInTheDocument();
  });

  it("invokes the dismiss handler when 'HexoKit: Dismiss Update Notice' is selected (260713-4zap)", () => {
    const onDismissUpdate = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      isOnBoardRoute: true,
      updateLatest: "0.6.0",
      onDismissUpdate,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Dismiss Update Notice" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDismissUpdate).toHaveBeenCalledOnce();
  });

  it("shows 'Board: Unpin Focused Pane' on a board route with entries (260704-9o7k)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Unpin Focused Pane")).toBeInTheDocument();
  });

  it("hides 'Board: Unpin Focused Pane' when the board has zero entries", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: false,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Board: Unpin Focused Pane")).not.toBeInTheDocument();
  });

  it("invokes the unpin-focused handler when 'Board: Unpin Focused Pane' is selected", () => {
    const onUnpinFocused = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: true,
      onUnpinFocused,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Unpin Focused" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUnpinFocused).toHaveBeenCalledOnce();
  });

  it("shows the split/close focused-pane entries on a board route with entries (260715-6jwn)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Board: Split Focused Pane Vertical")).toBeInTheDocument();
    expect(screen.getByText("Board: Split Focused Pane Horizontal")).toBeInTheDocument();
    expect(screen.getByText("Board: Close Focused Pane")).toBeInTheDocument();
  });

  it("hides the split/close focused-pane entries when the board has zero entries", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: false,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Board: Split Focused Pane Vertical")).not.toBeInTheDocument();
    expect(screen.queryByText("Board: Split Focused Pane Horizontal")).not.toBeInTheDocument();
    expect(screen.queryByText("Board: Close Focused Pane")).not.toBeInTheDocument();
  });

  it("invokes the split-vertical handler when 'Board: Split Focused Pane Vertical' is selected", () => {
    const onSplitVertical = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: true,
      onSplitVertical,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Split Focused Pane Vertical" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSplitVertical).toHaveBeenCalledOnce();
  });

  it("invokes the close-focused handler when 'Board: Close Focused Pane' is selected", () => {
    const onCloseFocused = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      hasEntries: true,
      onCloseFocused,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Close Focused Pane" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCloseFocused).toHaveBeenCalledOnce();
  });

  it("renders the nav trio — Go: Back / Go: Forward / Go: Host — on the board palette (i996)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("Go: Back")).toBeInTheDocument();
    expect(screen.getByText("Go: Forward")).toBeInTheDocument();
    expect(screen.getByText("Go: Host")).toBeInTheDocument();
  });

  it("never renders Go: tmux Server on the board palette (terminal-mode-only entry) (i996)", () => {
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.queryByText("Go: tmux Server")).not.toBeInTheDocument();
  });

  it("invokes the host handler when 'Go: Host' is selected (i996)", () => {
    const onNavHost = vi.fn();
    const actions = buildBoardActions({
      boards: [{ name: "main" }],
      currentBoardName: "main",
      isOnBoardRoute: true,
      onNavHost,
    });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Go: Host" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavHost).toHaveBeenCalledOnce();
  });
});
