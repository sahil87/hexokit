import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { SessionRow } from "./session-row";
import { FLYOUT_OPEN_DELAY_MS, resetFlyoutWarmState } from "./row-flyout-card";
import type { ProjectSession } from "@/types";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import { stubMatchMedia } from "@/test-utils/match-media";
import { ThemeProvider } from "@/contexts/theme-context";
import { computeRowTints, deriveUIColors, DEFAULT_DARK_THEME } from "@/themes";

afterEach(() => {
  cleanup();
});

const noop = () => {};

function rowProps(session: ProjectSession) {
  return {
    server: "srv",
    session,
    isCollapsed: false,
    isSessionDropTarget: false,
    editingSession: null,
    editingSessionName: "",
    sessionInputRef: { current: null },
    orderedNames: [session.name] as string[],
    onDragStart: noop,
    onDragEnd: noop,
    onToggleCollapse: noop,
    onSelectFirstWindow: noop,
    onCreateWindow: noop,
    onKillClick: noop,
    onDoubleClickName: noop,
    onSessionNameChange: noop,
    onSessionRenameKeyDown: noop as React.KeyboardEventHandler<HTMLInputElement>,
    onSessionRenameBlur: noop,
    onDragOver: noop,
    onReorderOver: noop,
    onDragLeave: noop,
    onDrop: noop,
    onColorChange: noop,
  };
}

describe("SessionRow", () => {
  it("renders the session name", () => {
    const session = makeSession({ name: "agent-work" });
    render(<SessionRow {...rowProps(session)} />);
    expect(screen.getByText("agent-work")).toBeInTheDocument();
  });

  it("renders no hover action cluster on a fine pointer — every action is a card row now", () => {
    const session = makeSession({ name: "agent-work" });
    render(<SessionRow {...rowProps(session)} onSpawnAgent={noop} />);
    expect(screen.queryByLabelText("Set color for agent-work")).toBeNull();
    expect(screen.queryByLabelText("Spawn agent in agent-work")).toBeNull();
    expect(screen.queryByLabelText("New tab in agent-work")).toBeNull();
    expect(screen.queryByLabelText("Kill group agent-work")).toBeNull();
  });

  // Flair overlay (decoration-only channel): an always-on ambient CSS-only
  // animation mounted whenever the session carries a flair value — gated on
  // `session.flair` alone, in every row state.
  describe("flair overlay", () => {
    it("mounts the rk-flair overlay span when the session carries a flair", () => {
      const session = makeSession({ name: "agent-work", flair: "onepiece" });
      const { container } = render(<SessionRow {...rowProps(session)} />);
      const overlay = container.querySelector(".rk-flair-onepiece");
      expect(overlay).not.toBeNull();
      expect(overlay!.getAttribute("aria-hidden")).toBe("true");
    });

    it("mounts NO flair overlay when the session has no flair", () => {
      const session = makeSession({ name: "agent-work" });
      const { container } = render(<SessionRow {...rowProps(session)} />);
      expect(container.querySelector("[class*='rk-flair-']")).toBeNull();
    });

    it("hides the flair overlay while the row is the drag source (drag-ghost guard)", () => {
      const session = makeSession({ name: "agent-work", flair: "warp" });
      const { container, rerender } = render(
        <SessionRow {...rowProps(session)} isDragSource={true} />,
      );
      expect(container.querySelector("[class*='rk-flair-']")).toBeNull();
      // At rest the warp markup contract renders (three starfield planes).
      rerender(<SessionRow {...rowProps(session)} isDragSource={false} />);
      expect(container.querySelectorAll(".rk-flair-warp .rk-warp-plane")).toHaveLength(3);
    });
  });

  // W3C-APG tree node semantics (Wave 3 sidebar-keyboard-nav). The session row
  // wrapper is a level-1 treeitem; its aria-expanded mirrors the chevron's, and
  // aria-controls points at the window-list group id. The roving model in
  // index.tsx threads tabIndex + set/pos and the data-session-row handle.
  describe("tree ARIA + roving tabindex", () => {
    function treeitem(container: HTMLElement): HTMLElement {
      const item = container.querySelector<HTMLElement>('[role="treeitem"]');
      expect(item).not.toBeNull();
      return item!;
    }

    it("renders role=treeitem at aria-level 1 with aria-expanded mirroring !isCollapsed", () => {
      const session = makeSession({ name: "api" });
      const { container, rerender } = render(
        <SessionRow {...rowProps(session)} isCollapsed={false} />,
      );
      const expanded = treeitem(container);
      expect(expanded).toHaveAttribute("role", "treeitem");
      expect(expanded).toHaveAttribute("aria-level", "1");
      expect(expanded).toHaveAttribute("aria-expanded", "true");

      rerender(<SessionRow {...rowProps(session)} isCollapsed={true} />);
      expect(treeitem(container)).toHaveAttribute("aria-expanded", "false");
    });

    it("wires aria-controls to the window-group id and exposes the data-session-row handle", () => {
      const session = makeSession({ name: "api" });
      const { container } = render(
        <SessionRow
          {...rowProps(session)}
          windowGroupId="windows-srv-api"
          sessionRowKey="srv:api"
        />,
      );
      const item = treeitem(container);
      expect(item).toHaveAttribute("aria-controls", "windows-srv-api");
      expect(item).toHaveAttribute("data-session-row", "srv:api");
    });

    // SF-5: the role="group" window list is mounted only while expanded, so the
    // session row must reference it via aria-controls ONLY when expanded — a
    // collapsed row pointing at an unmounted id is invalid ARIA.
    it("emits aria-controls only while expanded (absent when collapsed)", () => {
      const session = makeSession({ name: "api" });
      const { container, rerender } = render(
        <SessionRow
          {...rowProps(session)}
          isCollapsed={false}
          windowGroupId="windows-srv-api"
          sessionRowKey="srv:api"
        />,
      );
      expect(treeitem(container)).toHaveAttribute("aria-controls", "windows-srv-api");

      rerender(
        <SessionRow
          {...rowProps(session)}
          isCollapsed={true}
          windowGroupId="windows-srv-api"
          sessionRowKey="srv:api"
        />,
      );
      expect(treeitem(container)).not.toHaveAttribute("aria-controls");
    });

    it("reflects aria-setsize / aria-posinset and the roving tabIndex", () => {
      const session = makeSession({ name: "api" });
      const { container } = render(
        <SessionRow
          {...rowProps(session)}
          ariaSetSize={3}
          ariaPosInSet={2}
          tabIndex={0}
        />,
      );
      const item = treeitem(container);
      expect(item).toHaveAttribute("aria-setsize", "3");
      expect(item).toHaveAttribute("aria-posinset", "2");
      expect(item).toHaveAttribute("tabindex", "0");
    });

    it("defaults tabIndex to -1 when not the roving row", () => {
      const session = makeSession({ name: "api" });
      const { container } = render(<SessionRow {...rowProps(session)} />);
      expect(treeitem(container)).toHaveAttribute("tabindex", "-1");
    });
  });

  // React.memo only pays off when the parent passes referentially-stable props.
  // Proves the memo'd SessionRow does NOT re-render its body when its PARENT
  // re-renders with an identical prop set.
  //
  // We count the row's OWN render-body executions (not Profiler commits — a
  // Profiler fires on its parent's commit even when its memo'd child bails). The
  // signal is a getter on `session.name`: `SessionRowInner` reads `session.name`
  // at the top of every render (`const name = session.name`), so the getter fires
  // once per body execution. The parent (`Harness`) creates a FRESH <SessionRow>
  // element each render from a hoisted, stable props object, defeating React's
  // element-identity bailout — so only `React.memo` can stop the body from
  // re-running. An un-memoized row would read `session.name` again and fail.
  describe("React.memo", () => {
    it("does not re-render the row body when the parent re-renders with stable props", () => {
      let nameReads = 0;
      const base = makeSession({ name: "stable" });
      const session = new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "name") nameReads += 1;
          return Reflect.get(target, prop, receiver);
        },
      });
      const stableProps = rowProps(session); // hoisted once — identical refs each render

      let forceParent: () => void = () => {};
      function Harness() {
        const [, setTick] = useState(0);
        forceParent = () => setTick((n) => n + 1);
        return <SessionRow {...stableProps} />;
      }

      render(<Harness />);
      const afterMount = nameReads;
      expect(afterMount).toBeGreaterThan(0);

      act(() => { forceParent(); });
      expect(nameReads).toBe(afterMount); // memo bailed → body did not re-run
    });
  });

  // The session card on FINE pointers: whole-row hover (after the open delay)
  // and keyboard row focus open the same card the coarse rail triggers — the
  // single hover surface per row. The retired identity tip never mounts.
  describe("fine-pointer session card", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetFlyoutWarmState();
    });
    afterEach(() => {
      vi.useRealTimers();
      resetFlyoutWarmState();
      delete (window as { matchMedia?: unknown }).matchMedia;
    });

    function hoverRow() {
      const row = screen.getByRole("treeitem");
      act(() => {
        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        fireEvent.mouseEnter(row);
        vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
      });
      return row;
    }

    it("opens on row hover with the title bar, facts line, and action rows — and no identity tip", () => {
      const session = makeSession({
        name: "code-surface-latch-distill",
        sessionId: "$4",
        sessionPath: "/home/sahil/code/sahil87/run-kit",
        windows: [makeWindow({}), makeWindow({ windowId: "@2" }), makeWindow({ windowId: "@3" })],
      });
      render(<SessionRow {...rowProps(session)} onSpawnAgent={noop} />);
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();

      hoverRow();
      const card = screen.getByTestId("row-flyout-card");
      const bar = screen.getByTestId("popup-title-bar");
      expect(card).toContainElement(bar);
      expect(bar).toHaveTextContent("Group code-surface-latch-distill");
      expect(card).toHaveTextContent("$4 · 3 tabs · ~/code/sahil87/run-kit");
      // Change color… leads the action rows.
      expect(screen.getByTestId("row-flyout-color-action")).toHaveTextContent("Change color…");
      expect(screen.getByTestId("row-flyout-spawn-action")).toHaveTextContent("Spawn agent…");
      expect(screen.getByTestId("row-flyout-create-action")).toHaveTextContent("New tab");
      expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill group");
      // The card is the row's single hover surface — the tip is retired.
      expect(screen.queryByTestId("session-tip")).toBeNull();
    });

    it("omits underivable facts segments (old payloads without sessionId/sessionPath)", () => {
      const session = makeSession({ name: "alpha", windows: [makeWindow({}), makeWindow({ windowId: "@2" }), makeWindow({ windowId: "@3" })] });
      render(<SessionRow {...rowProps(session)} />);
      hoverRow();
      const card = screen.getByTestId("row-flyout-card");
      expect(card).toHaveTextContent("3 tabs");
      expect(card).not.toHaveTextContent("$");
      expect(card).not.toHaveTextContent("~");
    });

    it("opens on keyboard row focus and dismisses on Escape", () => {
      render(<SessionRow {...rowProps(makeSession({ name: "api" }))} />);
      const row = screen.getByRole("treeitem");
      act(() => {
        fireEvent.focus(row);
      });
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
        vi.advanceTimersByTime(50);
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });

    it("Change color… closes the card and opens the color popover; the open popover inhibits re-opening", () => {
      // ThemeProvider (SwatchPopover dep) needs a matchMedia stub; fine pointer.
      stubMatchMedia((q) => q === "(prefers-color-scheme: dark)");
      render(
        <ThemeProvider>
          <SessionRow {...rowProps(makeSession({ name: "api" }))} />
        </ThemeProvider>,
      );
      const row = screen.getByRole("treeitem");
      act(() => {
        fireEvent.focus(row);
      });
      act(() => { fireEvent.click(screen.getByTestId("row-flyout-color-action")); });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(screen.getByRole("listbox", { name: "Color picker" })).toBeInTheDocument();
      // Popover-over-card precedence: the suppressed gate holds while the
      // popover is open — a hover flashes nothing.
      hoverRow();
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });

    it("closes on drag start", () => {
      const onDragStart = vi.fn();
      render(<SessionRow {...rowProps(makeSession({ name: "api" }))} draggable onDragStart={onDragStart} />);
      const row = hoverRow();
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      act(() => {
        fireEvent.dragStart(row);
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(onDragStart).toHaveBeenCalled();
    });
  });

  // Attached-viewer signal: the neutral count chip and the card's per-viewer
  // grids are gated at ≥2 sized viewers — the 1-viewer norm adds zero chrome.
  describe("viewer count chip", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetFlyoutWarmState();
    });
    afterEach(() => {
      vi.useRealTimers();
      resetFlyoutWarmState();
    });

    function hoverRow() {
      const row = screen.getByRole("treeitem");
      act(() => {
        fireEvent.pointerEnter(row, { pointerType: "mouse" });
        fireEvent.mouseEnter(row);
        vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
      });
      return row;
    }

    it("renders no chip at zero or one viewer", () => {
      const none = makeSession({ name: "solo", viewers: undefined });
      const { rerender } = render(<SessionRow {...rowProps(none)} />);
      expect(screen.queryByTestId("viewer-badge")).toBeNull();

      rerender(<SessionRow {...rowProps(makeSession({ name: "solo", viewers: [] }))} />);
      expect(screen.queryByTestId("viewer-badge")).toBeNull();

      rerender(
        <SessionRow
          {...rowProps(makeSession({ name: "solo", viewers: [{ width: 144, height: 91 }] }))}
        />,
      );
      expect(screen.queryByTestId("viewer-badge")).toBeNull();
    });

    it("renders the count chip with an accessible label at ≥2 viewers", () => {
      const session = makeSession({
        name: "shared",
        viewers: [
          { width: 144, height: 91 },
          { width: 116, height: 37 },
        ],
      });
      render(<SessionRow {...rowProps(session)} />);
      const chip = screen.getByTestId("viewer-badge");
      expect(chip).toHaveTextContent("2");
      expect(chip).toHaveAttribute("aria-label", "2 viewers attached");
      // Neutral informational channel — never the signal-yellow attention
      // treatment.
      expect(chip.className).toContain("text-text-secondary");
      expect(chip.className).not.toContain("signal-yellow");
    });

    it("renders one row per viewer with identity segments when the chip shows", () => {
      // Pin the fake clock: the row floors Date.now()/1000 at render, after
      // hoverRow advances the flyout delay, so an unpinned clock can cross a
      // second boundary between fixture setup and render.
      const nowSec = 1_757_500_000;
      vi.setSystemTime(nowSec * 1000);
      const session = makeSession({
        name: "shared",
        viewers: [
          {
            width: 116,
            height: 37,
            kind: "rk",
            pid: 4242,
            device: "phone",
            peer: "100.64.0.12",
            createdAt: nowSec - 240,
            lastActiveAt: nowSec - 31,
          },
          {
            width: 144,
            height: 91,
            kind: "tty",
            pid: 5151,
            createdAt: nowSec - 7200,
            lastActiveAt: nowSec - 3,
          },
        ],
      });
      render(<SessionRow {...rowProps(session)} />);
      hoverRow();
      const container = screen.getByTestId("row-flyout-viewers");
      expect(container).toHaveTextContent("2 viewers");
      const rows = screen.getAllByTestId("row-flyout-viewer");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("phone · 116×37 · 100.64.0.12 · 4m · idle 31s · narrowest");
      expect(rows[1]).toHaveTextContent("tty · 144×91 · 2h · idle 3s");
    });

    it("marks every minimum-width viewer as narrowest (ties included)", () => {
      const session = makeSession({
        name: "shared",
        viewers: [
          { width: 116, height: 37 },
          { width: 144, height: 91 },
          { width: 116, height: 40 },
        ],
      });
      render(<SessionRow {...rowProps(session)} />);
      hoverRow();
      const rows = screen.getAllByTestId("row-flyout-viewer");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent("116×37 · narrowest");
      expect(rows[1]).toHaveTextContent("144×91");
      expect(rows[1].textContent).not.toContain("narrowest");
      expect(rows[2]).toHaveTextContent("116×40 · narrowest");
    });

    it("renders old-backend rows (width/height only) with no identity segments", () => {
      const session = makeSession({
        name: "shared",
        viewers: [
          { width: 144, height: 91 },
          { width: 116, height: 37 },
        ],
      });
      render(<SessionRow {...rowProps(session)} />);
      hoverRow();
      const rows = screen.getAllByTestId("row-flyout-viewer");
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toBe("144×91");
      expect(rows[1].textContent).toBe("116×37 · narrowest");
    });

    it("omits the card's viewer line below 2 viewers", () => {
      const session = makeSession({
        name: "solo",
        viewers: [{ width: 144, height: 91 }],
      });
      render(<SessionRow {...rowProps(session)} />);
      hoverRow();
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      expect(screen.queryByTestId("row-flyout-viewers")).toBeNull();
    });
  });

  // Coarse rail + session card (260817-ve5m): the rail extends the one
  // continuous strip to session rows and its tap/scrub triggers the same
  // card fine-pointer hover/focus opens. jsdom evaluates no media queries, so
  // the pointer is stubbed and geometry is asserted as classes/inline styles.
  describe("coarse rail + session card (260817-ve5m)", () => {
    beforeEach(() => {
      resetFlyoutWarmState();
      // Coarse pointer + dark scheme (ThemeProvider/SwatchPopover need the
      // color-scheme query answered too).
      stubMatchMedia((q) => ["(pointer: coarse)", "(any-pointer: coarse)"].includes(q) || q === "(prefers-color-scheme: dark)");
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      resetFlyoutWarmState();
    });

    function tapRail() {
      act(() => {
        fireEvent.pointerDown(screen.getByTestId("status-rail"), { pointerId: 1, pointerType: "touch" });
      });
    }

    it("renders the 56px tier-tinted rail with an empty glyph slot + chevron, and no cluster buttons", () => {
      const rowTints = computeRowTints(DEFAULT_DARK_THEME.palette, deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome);
      const session = makeSession({ name: "agent-work", sessionColor: "2" });
      render(<SessionRow {...rowProps(session)} sessionColor="2" rowTints={rowTints} onSpawnAgent={noop} />);
      const rail = screen.getByTestId("status-rail");
      expect(rail.style.width).toBe("56px");
      expect(rail.className).toContain("bg-bg-inset");
      expect(rail.className).toContain("border-l");
      expect(rail.className).toContain("touch-none");
      // Per-tier band tint: the session's family tint mixed into the inset
      // base (the shared color-mix idiom — never a new token).
      expect(rail.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-inset) 55%");
      // The 16px glyph slot is ALWAYS an empty span on this tier; the 12px
      // chevron is muted ~55% aria-hidden decoration.
      const chevron = Array.from(rail.querySelectorAll("span")).find((s) => s.textContent === "›")!;
      expect(chevron.className).toContain("w-3");
      expect(chevron.className).toContain("opacity-55");
      const glyphSlot = chevron.previousElementSibling as HTMLElement;
      expect(glyphSlot.className).toContain("w-4");
      expect(glyphSlot.children).toHaveLength(0);
      // The row root carries the shared scrub hit-test handle.
      expect(screen.getByRole("treeitem")).toHaveAttribute("data-rail-row");
      // Render-gated, not CSS-hidden: no cluster buttons exist on coarse.
      expect(screen.queryByLabelText("Set color for agent-work")).toBeNull();
      expect(screen.queryByLabelText("Spawn agent in agent-work")).toBeNull();
      expect(screen.queryByLabelText("New tab in agent-work")).toBeNull();
      expect(screen.queryByLabelText("Kill group agent-work")).toBeNull();
    });

    it("renders no rail and no cluster on fine pointers — the hover card is the surface", () => {
      stubMatchMedia((q) => q === "(prefers-color-scheme: dark)");
      const session = makeSession({ name: "agent-work" });
      render(<SessionRow {...rowProps(session)} />);
      expect(screen.queryByTestId("status-rail")).toBeNull();
      expect(screen.queryByLabelText("Set color for agent-work")).toBeNull();
      expect(screen.queryByLabelText("New tab in agent-work")).toBeNull();
      expect(screen.queryByLabelText("Kill group agent-work")).toBeNull();
    });

    it("rail tap opens the session card — title, facts line, action rows in order, actions route", () => {
      const onSpawnAgent = vi.fn();
      const onCreateWindow = vi.fn();
      const onKillClick = vi.fn();
      const session = makeSession({
        name: "agent-work",
        sessionId: "$4",
        sessionPath: "/home/sahil/code/run-kit",
        windows: [makeWindow({}), makeWindow({ windowId: "@2" })],
      });
      render(
        <SessionRow
          {...rowProps(session)}
          onSpawnAgent={onSpawnAgent}
          onCreateWindow={onCreateWindow}
          onKillClick={onKillClick}
        />,
      );
      tapRail();
      const card = screen.getByTestId("row-flyout-card");
      expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Group agent-work");
      // The facts line (omission-degrading).
      expect(card).toHaveTextContent("$4 · 2 tabs · ~/code/run-kit");
      // Fixed order: Change color… → Spawn agent… → New tab → Kill group.
      const color = screen.getByTestId("row-flyout-color-action");
      const spawn = screen.getByTestId("row-flyout-spawn-action");
      const create = screen.getByTestId("row-flyout-create-action");
      const kill = screen.getByTestId("row-flyout-kill-action");
      expect(color).toHaveTextContent("Change color…");
      expect(spawn).toHaveTextContent("Spawn agent…");
      expect(create).toHaveTextContent("New tab");
      expect(kill).toHaveTextContent("Kill group");
      expect(kill).toHaveTextContent("confirms first");
      expect(kill.className).toContain("hover:text-signal-red");
      expect(color.compareDocumentPosition(spawn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(spawn.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(create.compareDocumentPosition(kill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      act(() => { fireEvent.click(spawn); });
      expect(onSpawnAgent).toHaveBeenCalledWith("srv", "agent-work");
      act(() => { fireEvent.click(create); });
      expect(onCreateWindow).toHaveBeenCalledWith("srv", "agent-work");
      act(() => { fireEvent.click(kill); });
      // The existing kill-dialog path — never a force-kill on touch.
      expect(onKillClick).toHaveBeenCalledWith("srv", "agent-work", 2, false);
    });

    it("omits the Spawn agent… row when no onSpawnAgent is wired (the board-route sidebar)", () => {
      render(<SessionRow {...rowProps(makeSession({ name: "agent-work" }))} />);
      tapRail();
      expect(screen.queryByTestId("row-flyout-spawn-action")).toBeNull();
      expect(screen.getByTestId("row-flyout-color-action")).toBeInTheDocument();
      expect(screen.getByTestId("row-flyout-create-action")).toBeInTheDocument();
      expect(screen.getByTestId("row-flyout-kill-action")).toBeInTheDocument();
    });

    it("renders Update annotations between Spawn agent… and New tab when the handler is wired, routed session-scoped", () => {
      const onUpdateAnnotations = vi.fn();
      render(
        <SessionRow
          {...rowProps(makeSession({ name: "agent-work" }))}
          onSpawnAgent={noop}
          onUpdateAnnotations={onUpdateAnnotations}
        />,
      );
      tapRail();
      const spawn = screen.getByTestId("row-flyout-spawn-action");
      const annotate = screen.getByTestId("row-flyout-annotate-session-action");
      const create = screen.getByTestId("row-flyout-create-action");
      expect(annotate).toHaveTextContent("Update annotations");
      expect(annotate).toHaveTextContent("asks the operator");
      expect(spawn.compareDocumentPosition(annotate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(annotate.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      act(() => { fireEvent.click(annotate); });
      expect(onUpdateAnnotations).toHaveBeenCalledWith("srv", "agent-work");
    });

    it("omits the Update annotations row when no handler is wired (omit-not-disable; no operator)", () => {
      render(<SessionRow {...rowProps(makeSession({ name: "agent-work" }))} />);
      tapRail();
      expect(screen.queryByTestId("row-flyout-annotate-session-action")).toBeNull();
      expect(screen.getByTestId("row-flyout-create-action")).toBeInTheDocument();
    });

    it("Change color… closes the card and opens the color popover; the open popover inhibits re-opening", () => {
      render(
        <ThemeProvider>
          <SessionRow {...rowProps(makeSession({ name: "agent-work" }))} />
        </ThemeProvider>,
      );
      tapRail();
      act(() => { fireEvent.click(screen.getByTestId("row-flyout-color-action")); });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(screen.getByRole("listbox", { name: "Color picker" })).toBeInTheDocument();
      // Popover-over-card precedence: the suppressed gate holds while the
      // popover is open — a rail tap flashes nothing.
      tapRail();
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });

    it("lightens the rail only while the card is open (held treatment travels with the card)", () => {
      render(<SessionRow {...rowProps(makeSession({ name: "agent-work" }))} />);
      const rail = screen.getByTestId("status-rail");
      expect(rail.style.backgroundColor).toBe("");
      tapRail();
      expect(rail.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-inset) 40%");
      expect(rail.style.borderColor).toBe("var(--color-text-secondary)");
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      expect(rail.style.backgroundColor).toBe("");
    });

    it("ghost sessions get no rail and no card", () => {
      const ghost = { ...makeSession({ name: "ghosty" }), optimistic: true };
      render(<SessionRow {...rowProps(ghost)} />);
      expect(screen.queryByTestId("status-rail")).toBeNull();
      expect(screen.getByRole("treeitem")).not.toHaveAttribute("data-rail-row");
    });
  });
});
