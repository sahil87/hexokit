import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { ServerPanel } from "./server-panel";
import { FLYOUT_OPEN_DELAY_MS, resetFlyoutWarmState, useRowFlyout } from "./row-flyout-card";

// useRowFlyout is wrapped with a delegating spy (behavior unchanged) so the
// tile's hook options — the edge-anchor opt-in — are assertable.
vi.mock("./row-flyout-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./row-flyout-card")>();
  return { ...actual, useRowFlyout: vi.fn(actual.useRowFlyout) };
});
import { ThemeProvider } from "@/contexts/theme-context";
import { ToastProvider } from "@/components/toast";
import type { ServerInfo } from "@/api/client";
import { stubMatchMedia } from "@/test-utils/match-media";
import { loadMachineAgentPresetInfo, loadMachineAgentPresets, resetAgentPresetCache } from "@/lib/agent-presets";

// The card reads the machine preset list lazily; stub the read so the suite
// never reaches fetch (the card tests run on fake timers).
vi.mock("@/lib/agent-presets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-presets")>();
  return {
    ...actual,
    loadMachineAgentPresets: vi.fn(() => Promise.resolve(undefined)),
    loadMachineAgentPresetInfo: vi.fn(() => Promise.resolve({})),
  };
});
import { computeRowTints, computeRowBorders, deriveUIColors, DEFAULT_DARK_THEME, type RowTint } from "@/themes";

// jsdom does not implement matchMedia — ThemeProvider + useIsMobile both need it.
// Default to the fine-pointer / desktop-width branch unless a test overrides.
function stubFinePointer() {
  stubMatchMedia((query) => query.includes("prefers-color-scheme: dark"));
}
stubFinePointer();

function renderPanel(overrides: {
  server?: string;
  servers?: ServerInfo[];
  serverColors?: Record<string, string>;
  serverFlairs?: Record<string, string>;
  waitingCounts?: Map<string, number>;
  rowTints?: Map<string, RowTint>;
  rowBorders?: Map<string, string>;
  onSwitchServer?: (name: string) => void;
  onRefreshServers?: () => void;
  onServerColorChange?: (server: string, color: string | null) => void;
  onCreateSession?: (server: string) => void;
  onKillServer?: (name: string) => void;
  onToggleServerProtect?: (server: string, next: boolean) => void;
  onClearServerAgentPreset?: (server: string) => void;
  onSetServerAgentPreset?: (server: string, name: string | null) => void;
} = {}) {
  const props = {
    server: overrides.server ?? "default",
    servers: overrides.servers ?? [
      { name: "default", sessionCount: 4, windowCount: 9 },
      { name: "work", sessionCount: 2, windowCount: 5 },
      { name: "e2e", sessionCount: 1, windowCount: 1 },
    ],
    serverColors: overrides.serverColors ?? {},
    serverFlairs: overrides.serverFlairs,
    waitingCounts: overrides.waitingCounts,
    rowTints: overrides.rowTints,
    rowBorders: overrides.rowBorders,
    onSwitchServer: overrides.onSwitchServer ?? vi.fn(),
    onRefreshServers: overrides.onRefreshServers ?? vi.fn(),
    onServerColorChange: overrides.onServerColorChange,
    onCreateSession: overrides.onCreateSession,
    onKillServer: overrides.onKillServer,
    onToggleServerProtect: overrides.onToggleServerProtect,
    onClearServerAgentPreset: overrides.onClearServerAgentPreset,
    onSetServerAgentPreset: overrides.onSetServerAgentPreset,
  };
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ServerPanel {...props} />
      </ToastProvider>
    </ThemeProvider>,
  );
}

// The panel defaults open (defaultOpen=true) — tests that need a collapsed
// start seed the persisted key before rendering.
function seedCollapsed() {
  localStorage.setItem("hexokit-panel-server", "false");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ServerPanel", () => {
  it("renders a tile per server with name and bare window count", () => {
    renderPanel();

    expect(screen.getByRole("option", { name: /default/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /work/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /e2e/ })).toBeInTheDocument();

    // The count line is a bare window-count number — no "sess"/"win" suffix.
    const workTile = screen.getByRole("option", { name: /work/ });
    expect(within(workTile).getByText("5")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ sess/)).not.toBeInTheDocument();
  });

  it("renders 0 when windowCount is absent (backend always sends it; fixtures may not)", () => {
    renderPanel({
      servers: [{ name: "default", sessionCount: 1 }],
    });
    const tile = screen.getByRole("option");
    expect(within(tile).getByText("0")).toBeInTheDocument();
  });

  it("marks the active server tile with aria-current", () => {
    renderPanel({ server: "work" });

    const activeTile = screen.getByRole("option", { name: /work/ });
    expect(activeTile.getAttribute("aria-current")).toBe("true");
    expect(activeTile.getAttribute("aria-selected")).toBe("true");

    const otherTile = screen.getByRole("option", { name: /default/ });
    expect(otherTile.getAttribute("aria-current")).toBeNull();
    expect(otherTile.getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a non-active tile calls onSwitchServer with that name", () => {
    const onSwitchServer = vi.fn();
    renderPanel({ server: "default", onSwitchServer });

    fireEvent.click(screen.getByRole("option", { name: /work/ }));
    expect(onSwitchServer).toHaveBeenCalledWith("work");
  });

  it("shows 'No workspaces' when server list is empty", () => {
    renderPanel({ servers: [] });
    expect(screen.getByText("No workspaces")).toBeInTheDocument();
  });

  it("carries no header + (workspace creation lives in the New split button)", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "New workspace" })).not.toBeInTheDocument();
  });

  it("renders no hover action cluster on tiles (server actions live on the tile's flyout card)", () => {
    renderPanel({ server: "default" });

    // No in-tile icon buttons: the tile card (hover/focus) carries Change
    // color… / New group / Protect / Kill workspace rows instead.
    expect(screen.queryByRole("button", { name: /Kill workspace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set color for server/ })).not.toBeInTheDocument();
  });

  it("is open by default: the tile grid renders without any toggle click", () => {
    renderPanel();

    const grid = screen.getByRole("listbox", { name: /Workspaces/ });
    expect(grid).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Workspaces/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opening the panel (from a collapsed start) triggers onRefreshServers", () => {
    seedCollapsed();
    const onRefreshServers = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onRefreshServers });
    expect(onRefreshServers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Workspaces/ }));
    expect(onRefreshServers).toHaveBeenCalled();
  });

  it("renders tile grid as listbox with server tiles as options (keyboard-focusable)", () => {
    renderPanel();
    const grid = screen.getByRole("listbox", { name: /Workspaces/ });
    // Exactly three options inside the tile grid listbox.
    const options = within(grid).getAllByRole("option");
    expect(options).toHaveLength(3);
  });

  it("tile carries NO native title — the flyout card is the hover surface", () => {
    renderPanel({
      servers: [{ name: "bench-really-long-name", sessionCount: 2, windowCount: 5 }],
      server: "bench-really-long-name",
    });
    const tile = screen.getByRole("option", { name: /bench-really-long-name/ });
    expect(tile).not.toHaveAttribute("title");
  });

  // The tile flyout card: fine-pointer hover/focus of a tile opens the SAME
  // server card the sessions-pane group header mounts (the shared
  // ServerCardContent) — `Server <name>` title bar, the `tmux -L <name> · N
  // sessions` facts line (external servers carry the provenance suffix), and
  // the Change color… / New group / Protect / Kill workspace rows. No rail, no
  // coarse trigger: on coarse pointers the tile opens no card.
  describe("tile flyout card", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetFlyoutWarmState();
    });
    afterEach(() => {
      vi.useRealTimers();
      resetFlyoutWarmState();
      // Restore the fine-pointer default after a coarse-pointer test.
      stubFinePointer();
    });

    function hoverTile(name: RegExp) {
      // The reference props ride the tile's WRAPPER div; jsdom's mouseenter
      // doesn't bubble, so tests hover the wrapper (in the browser React
      // synthesizes ancestor enter events from mouseover, so hovering the
      // button works the same).
      const tile = screen.getByRole("option", { name }).parentElement!;
      act(() => {
        fireEvent.pointerEnter(tile, { pointerType: "mouse" });
        fireEvent.mouseEnter(tile);
        vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
      });
      return tile;
    }

    it("opens the shared server card on tile hover — title bar, facts line, action rows", () => {
      renderPanel({
        servers: [{ name: "default", sessionCount: 6, windowCount: 9 }],
        server: "default",
        onServerColorChange: vi.fn(),
        onCreateSession: vi.fn(),
        onKillServer: vi.fn(),
        onToggleServerProtect: vi.fn(),
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();

      hoverTile(/default/);
      const card = screen.getByTestId("row-flyout-card");
      const bar = screen.getByTestId("popup-title-bar");
      expect(card).toContainElement(bar);
      expect(bar).toHaveTextContent("Workspace default");
      expect(card).toHaveTextContent("tmux -L default · 6 groups");
      expect(screen.getByTestId("row-flyout-color-action")).toHaveTextContent("Change color…");
      expect(screen.getByTestId("row-flyout-create-action")).toHaveTextContent("New group");
      expect(screen.getByTestId("row-flyout-protect-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill workspace");
      // The retired identity tip never mounts.
      expect(screen.queryByTestId("server-tip")).toBeNull();
    });

    it("every tile opts in to the edge anchor — grid cells are not full-bleed, so the card must open at the sidebar edge", () => {
      vi.mocked(useRowFlyout).mockClear();
      renderPanel();
      const optionsPerTile = vi.mocked(useRowFlyout).mock.calls.map(([opts]) => opts);
      expect(optionsPerTile.length).toBeGreaterThan(0);
      for (const opts of optionsPerTile) expect(opts.edgeAnchor).toBe(true);
    });

    it("opens on keyboard tile focus and dismisses on Escape", () => {
      renderPanel({
        servers: [{ name: "work", sessionCount: 2, windowCount: 5 }],
        server: "work",
      });
      act(() => {
        fireEvent.focus(screen.getByRole("option", { name: /work/ }));
      });
      expect(screen.getByTestId("row-flyout-card")).toBeInTheDocument();
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
        vi.advanceTimersByTime(50);
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });

    it("appends the provenance suffix on the facts line for an external server, nothing for managed/absent", () => {
      renderPanel({
        servers: [
          { name: "ext", sessionCount: 2, windowCount: 3, managed: false },
          { name: "own", sessionCount: 1, windowCount: 1, managed: true },
        ],
        server: "ext",
      });
      hoverTile(/ext/);
      expect(screen.getByTestId("row-flyout-card")).toHaveTextContent(
        "tmux -L ext · 2 groups · external — not started by HexoKit",
      );

      cleanup();
      resetFlyoutWarmState();
      renderPanel({
        servers: [{ name: "own", sessionCount: 1, windowCount: 1, managed: true }],
        server: "own",
      });
      hoverTile(/own/);
      expect(screen.getByTestId("row-flyout-card")).toHaveTextContent("tmux -L own · 1 group");
      expect(screen.getByTestId("row-flyout-card")).not.toHaveTextContent("external");
    });

    it("card action rows route through the panel seams", () => {
      const onCreateSession = vi.fn();
      const onKillServer = vi.fn();
      const onToggleServerProtect = vi.fn();
      renderPanel({
        servers: [{ name: "work", sessionCount: 2, windowCount: 5, protected: false }],
        server: "work",
        onCreateSession,
        onKillServer,
        onToggleServerProtect,
      });
      act(() => {
        fireEvent.focus(screen.getByRole("option", { name: /work/ }));
      });

      act(() => { fireEvent.click(screen.getByTestId("row-flyout-create-action")); });
      expect(onCreateSession).toHaveBeenCalledExactlyOnceWith("work");
      act(() => { fireEvent.click(screen.getByTestId("row-flyout-protect-toggle")); });
      expect(onToggleServerProtect).toHaveBeenCalledExactlyOnceWith("work", true);
      act(() => { fireEvent.click(screen.getByTestId("row-flyout-kill-action")); });
      expect(onKillServer).toHaveBeenCalledExactlyOnceWith("work");
      // Card interactions never switch the active server.
      // (onSwitchServer is the tile button's own seam, covered above.)
    });

    it("Change color… closes the card and opens the tile-anchored color popover; a pick routes through onServerColorChange", () => {
      const onServerColorChange = vi.fn();
      renderPanel({
        servers: [{ name: "work", sessionCount: 2, windowCount: 5 }],
        server: "work",
        serverColors: { work: "4" },
        onServerColorChange,
      });
      act(() => {
        fireEvent.focus(screen.getByRole("option", { name: /work/ }));
      });
      act(() => { fireEvent.click(screen.getByTestId("row-flyout-color-action")); });

      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
      const popover = screen.getByRole("listbox", { name: "Color picker" });
      // Portalled to document.body, anchored at the tile (not nested in it).
      expect(document.body.contains(popover)).toBe(true);
      act(() => {
        fireEvent.click(within(popover).getByRole("option", { name: "Color blue" }));
      });
      expect(onServerColorChange).toHaveBeenCalledWith("work", "4");
      // Popover-over-card precedence: hover re-opens nothing while it is open.
      hoverTile(/work/);
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });

    it("never opens on a coarse pointer (no rail, no hover/focus surface)", () => {
      // Both coarse-pointer queries match — a touch-primary device answers
      // true to `(pointer: coarse)` and `(any-pointer: coarse)` alike.
      stubMatchMedia((query) => query.includes("pointer: coarse") || query.includes("prefers-color-scheme: dark"));
      renderPanel({
        servers: [{ name: "work", sessionCount: 2, windowCount: 5 }],
        server: "work",
        onServerColorChange: vi.fn(),
      });
      const tile = screen.getByRole("option", { name: /work/ }).parentElement!;
      act(() => {
        fireEvent.pointerEnter(tile, { pointerType: "touch" });
        fireEvent.mouseEnter(tile);
        fireEvent.focus(screen.getByRole("option", { name: /work/ }));
        vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 100);
      });
      expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    });
  });

  it("does not repeat the active server name in the header (spinner slot only)", () => {
    seedCollapsed();
    renderPanel({ server: "work" });

    expect(screen.getByText("Workspaces")).toBeInTheDocument();

    // The name is shown by the highlighted tile and the top-bar heading — the
    // headerRight slot no longer duplicates it.
    const toggle = screen.getByRole("button", { name: /Workspaces/ });
    expect(within(toggle).queryByText("work")).not.toBeInTheDocument();
  });

  it("de-emphasizes infra server names (grey), leaves regular names primary", () => {
    renderPanel({
      server: "work",
      servers: [
        { name: "work", sessionCount: 2, windowCount: 3 },
        { name: "rk-daemon", sessionCount: 1, windowCount: 1 },
        { name: "rk-test-e2e", sessionCount: 1, windowCount: 1 },
      ],
    });

    // Infra names render text-text-secondary, not text-text-primary.
    const daemonName = screen.getByText("rk-daemon");
    expect(daemonName).toHaveClass("text-text-secondary");
    expect(daemonName).not.toHaveClass("text-text-primary");

    const testName = screen.getByText("rk-test-e2e");
    expect(testName).toHaveClass("text-text-secondary");
    expect(testName).not.toHaveClass("text-text-primary");

    // Regular name stays primary.
    const workName = screen.getByText("work");
    expect(workName).toHaveClass("text-text-primary");
    expect(workName).not.toHaveClass("text-text-secondary");
  });

  describe("server-class glyphs (shield + external)", () => {
    // The stripe div is the h-0.5 color-signature slot at the tile's top.
    function stripeOf(name: RegExp): HTMLElement {
      const tile = screen.getByRole("option", { name });
      const stripe = tile.querySelector(".h-0\\.5");
      expect(stripe).not.toBeNull();
      return stripe as HTMLElement;
    }

    it("renders the shield for protected/daemon tiles, absent otherwise", () => {
      renderPanel({
        server: "work",
        servers: [
          { name: "work", sessionCount: 2, windowCount: 3 },
          { name: "guarded", sessionCount: 0, windowCount: 0, protected: true },
          { name: "rk-daemon", sessionCount: 1, windowCount: 1 },
        ],
      });

      expect(screen.getByTestId("shield-guarded")).toBeInTheDocument();
      // rk-daemon derives protected client-side even with the flag unset.
      expect(screen.getByTestId("shield-rk-daemon")).toBeInTheDocument();
      expect(screen.queryByTestId("shield-work")).not.toBeInTheDocument();
    });

    it("renders ↗ + dimmed name for external (managed === false) only — absent field renders no treatment", () => {
      renderPanel({
        server: "ext",
        servers: [
          { name: "ext", sessionCount: 2, windowCount: 3, managed: false },
          { name: "own", sessionCount: 1, windowCount: 1, managed: true },
          { name: "old", sessionCount: 1, windowCount: 1 }, // old backend: no `managed`
        ],
      });

      expect(screen.getByTestId("external-ext")).toBeInTheDocument();
      const extName = screen.getByText("ext");
      expect(extName).toHaveClass("text-text-secondary");
      expect(extName).not.toHaveClass("text-text-primary");

      for (const name of ["own", "old"]) {
        expect(screen.queryByTestId(`external-${name}`)).not.toBeInTheDocument();
        const nameDiv = screen.getByText(name);
        expect(nameDiv).toHaveClass("text-text-primary");
        expect(nameDiv).not.toHaveClass("text-text-secondary");
      }
    });

    it("renders both glyphs shield-first when a server is protected AND external", () => {
      renderPanel({
        server: "ext",
        servers: [{ name: "ext", sessionCount: 1, windowCount: 1, managed: false, protected: true }],
      });

      const nameDiv = screen.getByText("ext").parentElement!;
      const glyphs = nameDiv.querySelectorAll("[data-testid^='shield-'], [data-testid^='external-']");
      expect([...glyphs].map((g) => g.getAttribute("data-testid"))).toEqual([
        "shield-ext",
        "external-ext",
      ]);
    });

    it("hatches the top stripe for an external server with no assigned color; an assigned color still wins", () => {
      const rowTints = computeRowTints(DEFAULT_DARK_THEME.palette, deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome);
      const rowBorders = computeRowBorders(DEFAULT_DARK_THEME.palette, DEFAULT_DARK_THEME.category);
      renderPanel({
        server: "ext",
        servers: [
          { name: "ext", sessionCount: 1, windowCount: 1, managed: false },
          { name: "tinted", sessionCount: 1, windowCount: 1, managed: false },
        ],
        serverColors: { tinted: "4" },
        rowTints,
        rowBorders,
      });

      // Uncolored external (active): hatched placeholder in the border color.
      // (^-anchored: "tinted is external" would also match a bare /ext/.)
      const hatched = stripeOf(/^ext /);
      expect(hatched.style.backgroundImage).toContain("repeating-linear-gradient");
      expect(hatched.style.backgroundColor).toBe("");

      // Colored external: the solid signature wins — no hatch.
      const tinted = stripeOf(/tinted/);
      expect(tinted.style.backgroundImage).toBe("");
      expect(tinted.style.backgroundColor).not.toBe("");
    });

    it("keeps the stripe transparent on a non-active external tile (no hatch)", () => {
      renderPanel({
        server: "work",
        servers: [
          { name: "work", sessionCount: 2, windowCount: 3 },
          { name: "ext", sessionCount: 1, windowCount: 1, managed: false },
        ],
      });

      const stripe = stripeOf(/ext/);
      expect(stripe.style.backgroundImage).toBe("");
      expect(stripe.style.backgroundColor).toBe("transparent");
    });
  });

  it("renders a waiting badge with the count on a server that has waiting windows", () => {
    renderPanel({
      server: "default",
      servers: [
        { name: "default", sessionCount: 4, windowCount: 8 },
        { name: "work", sessionCount: 2, windowCount: 4 },
      ],
      waitingCounts: new Map([["work", 3]]),
    });

    // The badge lives inside the `work` tile (a descendant of its `option`
    // button), so scope the query to that tile — a global query would still
    // pass if the badge were rendered on the wrong server tile.
    const workTile = screen.getByRole("option", { name: /work/ });
    const badge = within(workTile).getByTestId("waiting-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveAttribute("aria-label", "3 agents waiting for input");

    // The count is forwarded per-server: the `default` tile (no map entry) has
    // no badge, proving the badge is not rendered on the wrong tile.
    const defaultTile = screen.getByRole("option", { name: /default/ });
    expect(within(defaultTile).queryByTestId("waiting-badge")).not.toBeInTheDocument();
  });

  describe("active-tile autoscroll (nris)", () => {
    // jsdom has no scrollIntoView at all — define a spy on the prototype so
    // the effect's `typeof el.scrollIntoView === "function"` guard passes.
    let scrollSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollSpy = vi.fn();
      Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
        value: scrollSpy,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
    });

    function panelUI(server: string) {
      return (
        <ThemeProvider>
          <ToastProvider>
            <ServerPanel
              server={server}
              servers={[
                { name: "default", sessionCount: 4, windowCount: 9 },
                { name: "work", sessionCount: 2, windowCount: 5 },
              ]}
              serverColors={{}}
              onSwitchServer={vi.fn()}
              onRefreshServers={vi.fn()}
            />
          </ToastProvider>
        </ThemeProvider>
      );
    }

    it("scrolls the active tile into view on mount on desktop (mobile-only gate removed)", () => {
      // The file-default matchMedia stub reports desktop (fine pointer, wide).
      render(panelUI("work"));

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
      // The call target is the ACTIVE tile's button (aria-current="true").
      const activeTile = screen.getByRole("option", { name: /work/ });
      expect(scrollSpy.mock.instances[0]).toBe(activeTile);
    });

    it("re-scrolls when the active server changes", () => {
      const { rerender } = render(panelUI("default"));
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      rerender(panelUI("work"));
      expect(scrollSpy).toHaveBeenCalledTimes(2);
      const activeTile = screen.getByRole("option", { name: /work/ });
      expect(scrollSpy.mock.instances[1]).toBe(activeTile);
    });

    it("does not scroll when no tile is active (server not in the list)", () => {
      render(panelUI("gone"));
      expect(scrollSpy).not.toHaveBeenCalled();
    });
  });

  it("renders no waiting badge for a server with count 0 or no map entry", () => {
    renderPanel({
      server: "default",
      servers: [
        { name: "default", sessionCount: 4, windowCount: 8 }, // no map entry → count 0
        { name: "work", sessionCount: 2, windowCount: 4 }, // explicit 0
      ],
      waitingCounts: new Map([["work", 0]]),
    });

    // WaitingBadge returns null at count <= 0, so no badge is present for either.
    expect(screen.queryByTestId("waiting-badge")).not.toBeInTheDocument();
  });

  describe("tile flair mount", () => {
    it("mounts a FlairOverlay (rk-flair-*) on a flaired tile, none on an unflaired one", () => {
      renderPanel({ serverFlairs: { work: "matrix" } });

      const workTile = screen.getByRole("option", { name: /work/ });
      const flair = workTile.querySelector(".rk-flair-matrix");
      expect(flair).not.toBeNull();
      expect(flair).toHaveAttribute("aria-hidden", "true");

      // A server with no map entry mounts no overlay (FlairOverlay returns null).
      const defaultTile = screen.getByRole("option", { name: /default/ });
      expect(defaultTile.querySelector("[class*='rk-flair-']")).toBeNull();
    });

    it("hides the overlay while the tile is the drag source; it returns on drag end", () => {
      renderPanel({ serverFlairs: { work: "matrix" } });

      const tileWrapper = screen.getByRole("option", { name: /work/ }).parentElement!;
      const workTile = screen.getByRole("option", { name: /work/ });
      expect(workTile.querySelector(".rk-flair-matrix")).not.toBeNull();

      act(() => {
        fireEvent.dragStart(tileWrapper, {
          dataTransfer: { setData: vi.fn(), types: [], effectAllowed: "" },
        });
      });
      expect(workTile.querySelector(".rk-flair-matrix")).toBeNull();

      act(() => {
        fireEvent.dragEnd(tileWrapper, {
          dataTransfer: { setData: vi.fn(), types: [], effectAllowed: "" },
        });
      });
      expect(workTile.querySelector(".rk-flair-matrix")).not.toBeNull();
    });
  });
});

// The workspace card and tile share the machine preset list; the marker is
// present only for a preset set on the workspace itself.
describe("server card agent preset", () => {
  const machineList = [
    { name: "claude", source: "built-in" },
    { name: "codex-review", source: "built-in" },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    resetFlyoutWarmState();
    resetAgentPresetCache();
    vi.mocked(loadMachineAgentPresets).mockResolvedValue(machineList);
    vi.mocked(loadMachineAgentPresetInfo).mockResolvedValue({ presets: machineList });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFlyoutWarmState();
  });

  async function openTile(
    agentPreset: string | undefined,
    options: { onClear?: (server: string) => void; onSet?: (server: string, name: string | null) => void } = {},
  ) {
    renderPanel({
      servers: [{ name: "work", sessionCount: 2, windowCount: 5, agent_preset: agentPreset }],
      server: "work",
      onClearServerAgentPreset: options.onClear,
      onSetServerAgentPreset: options.onSet,
      onServerColorChange: vi.fn(),
    });
    const tile = screen.getByRole("option", { name: /work/ }).parentElement!;
    act(() => {
      fireEvent.pointerEnter(tile, { pointerType: "mouse" });
      fireEvent.mouseEnter(tile);
      vi.advanceTimersByTime(FLYOUT_OPEN_DELAY_MS + 50);
    });
    await act(async () => {});
  }

  it("shows fab's defaults when nothing is set", async () => {
    await openTile(undefined);
    expect(screen.getByTestId("row-flyout-agent-preset")).toHaveTextContent("agent preset: none · fab's defaults");
  });

  it("shows a listed own preset with its source", async () => {
    await openTile("claude", { onClear: vi.fn() });
    expect(screen.getByTestId("row-flyout-agent-preset")).toHaveTextContent("agent preset: claude · set here");
    expect(screen.queryByTestId("row-flyout-clear-agent-preset-action")).toBeNull();
  });

  it("keeps the unknown-name clear row", async () => {
    const onClear = vi.fn();
    await openTile("old-preset", { onClear });
    expect(screen.getByTestId("row-flyout-agent-preset")).toHaveTextContent(
      "agent preset: old-preset (unknown) · set here",
    );
    fireEvent.click(screen.getByTestId("row-flyout-clear-agent-preset-action"));
    expect(onClear).toHaveBeenCalledWith("work");
  });

  it("renders none (no preset) for the reserved opt-out", async () => {
    await openTile("none", { onClear: vi.fn() });
    expect(screen.getByTestId("row-flyout-agent-preset")).toHaveTextContent("agent preset: none (no preset) · set here");
  });

  it("hides the line and action when fab reports no presets", async () => {
    vi.mocked(loadMachineAgentPresets).mockResolvedValue(undefined);
    vi.mocked(loadMachineAgentPresetInfo).mockResolvedValue({});
    await openTile("old-preset", { onSet: vi.fn() });
    expect(screen.queryByTestId("row-flyout-agent-preset")).toBeNull();
    expect(screen.queryByTestId("row-flyout-agent-preset-action")).toBeNull();
  });

  it("places the action immediately after Change color and sends a pick", async () => {
    const onSet = vi.fn();
    await openTile("claude", { onSet });
    const actions = screen.getByTestId("row-flyout-actions");
    expect(actions.children[0]).toHaveTextContent("Change color…");
    expect(actions.children[1]).toHaveTextContent("Agent preset…claude");
    fireEvent.click(actions.children[1]);
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    await act(async () => { await vi.runAllTimersAsync(); });
    const group = screen.getByRole("radiogroup", { name: "Agent preset for work" });
    fireEvent.click(within(group).getByRole("radio", { name: /^none/ }));
    expect(onSet).toHaveBeenCalledWith("work", "none");
  });

  it("marks only an own preset on the tile", () => {
    renderPanel({ servers: [{ name: "work", sessionCount: 1 }] });
    expect(screen.queryByTestId("agent-preset-marker")).toBeNull();
    cleanup();
    renderPanel({ servers: [{ name: "work", sessionCount: 1, agent_preset: "codex-review" }] });
    expect(screen.getByTestId("agent-preset-marker")).toHaveTextContent("codex-review");
  });

  it("truncates a long workspace name without squashing the preset marker", () => {
    const longName = "a-workspace-name-that-is-far-too-long-for-the-tile";
    renderPanel({ servers: [{ name: longName, sessionCount: 1, agent_preset: "codex-review" }] });
    expect(screen.getByText(longName)).toHaveClass("min-w-[3ch]", "flex-1", "truncate");
    expect(screen.getByTestId("agent-preset-marker")).toHaveTextContent("codex-review");
    expect(screen.getByTestId("agent-preset-marker")).toHaveClass("min-w-[3ch]", "max-w-1/2", "shrink");
  });
});
