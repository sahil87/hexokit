import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { Sidebar } from "./index";
import { OptimisticProvider, useOptimisticContext } from "@/contexts/optimistic-context";
import { HostMetricsProvider, MetricsProvider, StandaloneSessionContextProvider } from "@/contexts/session-context";
import { FocusedPaneProvider } from "@/contexts/focused-pane-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { InstanceAccentValueProvider, type InstanceAccent } from "@/contexts/instance-accent-context";
import { InstanceNameValueProvider, type InstanceName } from "@/contexts/instance-name-context";
import { ChromeProvider } from "@/contexts/chrome-context";
import { SettingsDialogProvider } from "@/contexts/settings-dialog-context";
import { ToastProvider } from "@/components/toast";
import { useWindowStore, entryKey } from "@/store/window-store";
import { stubMatchMedia } from "@/test-utils/match-media";
import { pushRecentlyClosed } from "@/hooks/use-recently-closed";
import type { ClosedWindow } from "@/api/client";
import type { ProjectSession } from "@/types";

// HostPanel (inside Sidebar) consumes the instance-accent context; inject a
// static null accent so sidebar tests need no fetching provider (1etw).
const NULL_ACCENT: InstanceAccent = {
  color: null,
  isExplicit: false,
  stripeHex: null,
  washHex: null,
  titlebarHex: null,
  setColor: () => {},
};

// HostPanel also consumes the instance-name context (o7q8); inject a static
// empty value so sidebar tests need no fetching provider.
const NULL_NAME: InstanceName = {
  hostname: "",
  instanceName: null,
  displayName: "",
  setInstanceName: () => {},
};


const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    killWindow: vi.fn().mockResolvedValue({ ok: true }),
    killSession: vi.fn().mockResolvedValue({ ok: true }),
    renameWindow: vi.fn().mockResolvedValue({ ok: true }),
    renameSession: vi.fn().mockResolvedValue({ ok: true }),
    moveWindow: vi.fn().mockResolvedValue({ ok: true }),
    moveWindowToSession: vi.fn().mockResolvedValue({ ok: true }),
    setSessionColor: vi.fn().mockResolvedValue({ ok: true }),
    setWindowColor: vi.fn().mockResolvedValue({ ok: true }),
    setSessionOrder: vi.fn().mockResolvedValue(undefined),
  };
});

// The kill executors push the response's `closed` record onto the
// recently-closed mirror; spy the standalone export so the tests assert the
// executor contract without reaching into the mirror's module state.
vi.mock("@/hooks/use-recently-closed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-recently-closed")>();
  return { ...actual, pushRecentlyClosed: vi.fn() };
});

// Mock matchMedia for ThemeProvider
vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
  matches: true,
  media: "(prefers-color-scheme: dark)",
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onchange: null,
}));

/** The blanket stub above answers `true` for EVERY query — the coarse-pointer
 *  queries included — so the file's default pointer is COARSE. Chord-hint copy
 *  is fine-pointer-only (the app's chord-hints-off-touch rule, 260811-ke2s), so
 *  a pointer-sensitive test re-stubs per query; the `afterEach` below restores
 *  the blanket default so the stub never leaks into a later test. The re-stub
 *  flips BOTH `(pointer: coarse)` and `(any-pointer: coarse)` together —
 *  `useCoarsePointer` reads the first, `useIsMobile` the second, and a real
 *  device never disagrees with itself on the primary-pointer case. */
function stubPointer(coarse: boolean) {
  stubMatchMedia((query) => (query.includes("pointer: coarse") ? coarse : true));
}

const sessions: ProjectSession[] = [
  {
    name: "run-kit",
    windows: [
      {
        index: 0,
        windowId: "@0",
        name: "main",
        worktreePath: "~/code/run-kit",
        activity: "active",
        isActiveWindow: true,
        fabStage: "apply",
        fabChange: "260313-txna-rich-sidebar-window-status",
        agentState: "active",
        paneCommand: "claude",
        activityTimestamp: Math.floor(Date.now() / 1000) - 5,
      },
      {
        index: 1,
        windowId: "@1",
        name: "scratch",
        worktreePath: "~/code/run-kit",
        activity: "idle",
        isActiveWindow: false,
        fabStage: "apply",
        fabChange: "260313-txna-rich-sidebar-window-status",
        agentState: "idle",
        agentIdleDuration: "3m",
        paneCommand: "zsh",
        activityTimestamp: Math.floor(Date.now() / 1000) - 180,
      },
      {
        index: 2,
        windowId: "@2",
        name: "logs",
        worktreePath: "~/code/run-kit",
        activity: "idle",
        isActiveWindow: false,
        paneCommand: "tail",
        activityTimestamp: Math.floor(Date.now() / 1000) - 300,
      },
    ],
  },
  {
    name: "ao-server",
    windows: [
      {
        index: 0,
        windowId: "@3",
        name: "dev",
        worktreePath: "~/code/ao-server",
        activity: "idle",
        isActiveWindow: true,
        paneCommand: "zsh",
        activityTimestamp: Math.floor(Date.now() / 1000) - 3600,
      },
    ],
  },
];

type SidebarTestOverrides = Partial<React.ComponentProps<typeof Sidebar>> & {
  /** Test convenience: override the per-server sessions Map fed to the
   *  StandaloneSessionContextProvider. Defaults to `{ runkit: <sessions> }`. */
  sessions?: ProjectSession[];
  serverList?: { name: string; sessionCount: number }[];
  /** Override the per-server SSE-delivered session order. Defaults to empty
   *  arrays per server. */
  sessionOrderByServer?: Record<string, string[]>;
};

function buildTree(overrides: SidebarTestOverrides) {
  const currentServer = overrides.currentServer ?? "runkit";
  const sessionData = overrides.sessions ?? sessions;
  const serverList = overrides.serverList ?? [{ name: "runkit", sessionCount: 0 }];
  const orderOverride = overrides.sessionOrderByServer;
  // Spread overrides minus the context-only fields onto Sidebar.
  const {
    sessions: _omitSessions,
    serverList: _omitServerList,
    currentServer: _omitCurrentServer,
    sessionOrderByServer: _omitOrder,
    ...sidebarOverrides
  } = overrides;
  return (
    <ThemeProvider>
    <InstanceAccentValueProvider value={NULL_ACCENT}>
    <InstanceNameValueProvider value={NULL_NAME}>
    <ToastProvider>
      <OptimisticProvider>
        <StandaloneSessionContextProvider
          value={{
            sessionsByServer: new Map(serverList.map((s) => [s.name, s.name === currentServer ? sessionData : []])),
            sessionOrderByServer: new Map(serverList.map((s) => [s.name, orderOverride?.[s.name] ?? []])),
            isConnectedByServer: new Map(serverList.map((s) => [s.name, false])),
            metricsByServer: new Map(),
            currentServer,
            servers: serverList,
            refreshServers: vi.fn(),
          }}
        >
          <MetricsProvider value={null}>
            <HostMetricsProvider value={null}>
              <FocusedPaneProvider>
                <ChromeProvider>
                  <SettingsDialogProvider>
                    <Sidebar
                      currentServer={currentServer}
                      currentSession="run-kit"
                      currentWindowId="@0"
                      isConnected={false}
                      onSelectWindow={vi.fn()}
                      onCreateWindow={vi.fn()}
                      onCreateSession={vi.fn()}
                      onCreateServer={vi.fn()}
                      onKillServer={vi.fn()}
                      {...sidebarOverrides}
                    />
                  </SettingsDialogProvider>
                </ChromeProvider>
              </FocusedPaneProvider>
            </HostMetricsProvider>
          </MetricsProvider>
        </StandaloneSessionContextProvider>
      </OptimisticProvider>
    </ToastProvider>
    </InstanceNameValueProvider>
    </InstanceAccentValueProvider>
    </ThemeProvider>
  );
}

function renderSidebar(overrides: SidebarTestOverrides = {}) {
  const result = render(buildTree(overrides));
  return {
    ...result,
    /** Re-render with a changed SSE order (or other overrides) to simulate the
     *  next SSE slice arriving. Merges over the original overrides. */
    rerenderWith(next: SidebarTestOverrides) {
      result.rerender(buildTree({ ...overrides, ...next }));
    },
  };
}

// The session name appears inside the SessionRow's "Navigate to {name}" button.
// The Sessions panel header also renders the current session name, so `getByText`
// would ambiguously match both. This helper scopes to the row.
function getSessionRowNameSpan(name: string): HTMLElement {
  const btn = screen.getByLabelText(`Navigate to ${name}`);
  return within(btn).getByText(name);
}

describe("Sidebar", () => {
  afterEach(cleanup);
  // Undo any per-test `stubPointer` so the blanket (all-true) default is what
  // the next test sees.
  afterEach(() => stubPointer(true));

  it("renders all sessions", () => {
    renderSidebar();
    expect(getSessionRowNameSpan("run-kit")).toBeInTheDocument();
    expect(getSessionRowNameSpan("ao-server")).toBeInTheDocument();
  });

  it("renders windows for expanded sessions", () => {
    renderSidebar();
    // "main" appears in both tree and status panel (selected window)
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("scratch")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("collapse/expand sessions via chevron click", () => {
    // Collapse a NON-current session: the CURRENT session ("run-kit", holding
    // the selected @0) renders expanded regardless of its collapsed exception
    // (derived expand), so the fold is exercised on "ao-server".
    renderSidebar();
    expect(screen.getByText("dev")).toBeInTheDocument();

    // Click chevron to collapse — the window row leaves the tree.
    fireEvent.click(screen.getByLabelText(/Collapse ao-server/));
    expect(screen.queryByText("dev")).toBeNull();

    // Click chevron again to expand.
    fireEvent.click(screen.getByLabelText(/Expand ao-server/));
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("session name click navigates to first window (not toggles)", () => {
    const onSelectWindow = vi.fn();
    renderSidebar({ onSelectWindow });

    // Click the session name text
    fireEvent.click(screen.getByLabelText("Navigate to run-kit"));
    expect(onSelectWindow).toHaveBeenCalledWith("runkit", "run-kit", "@0");

    // Windows should still be visible (not collapsed)
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
  });

  it("highlights selected window", () => {
    renderSidebar();
    // First "main" is in the tree row
    const mainBtn = screen.getAllByText("main")[0].closest("button");
    expect(mainBtn?.getAttribute("aria-current")).toBe("page");
    expect(mainBtn?.className).toContain("font-medium");
  });

  it("highlights exactly one window when the URL window differs from the tmux-active window", () => {
    // Regression: an optimistic click navigates the URL ahead of tmux, so the
    // URL window (scratch, index 1) and the still-stale tmux-active window
    // (main, index 0) momentarily disagree. Selection must follow the URL
    // alone — never light up BOTH rows (the prior OR-of-two-sources bug).
    renderSidebar({ currentWindowId: "@1" });

    const mainBtn = screen.getAllByText("main")[0].closest("button");
    const scratchBtn = screen.getAllByText("scratch")[0].closest("button");

    // URL points at scratch → only scratch is selected.
    expect(scratchBtn?.getAttribute("aria-current")).toBe("page");
    // main is tmux-active but NOT in the URL → must not look selected.
    expect(mainBtn?.getAttribute("aria-current")).not.toBe("page");

    // Belt-and-suspenders: exactly one selected row in this session's tree.
    const tree = screen.getByRole("navigation", { name: "Sessions" });
    const selected = within(tree).getAllByRole("button", { current: "page" });
    expect(selected).toHaveLength(1);
  });

  it("falls back to the tmux-active window when the URL has no window segment", () => {
    // Before the URL gains a window (e.g. just landed on the session, or
    // pre-writeback), selection follows isActiveWindow so the active row is
    // still indicated.
    renderSidebar({ currentWindowId: null });
    const mainBtn = screen.getAllByText("main")[0].closest("button");
    expect(mainBtn?.getAttribute("aria-current")).toBe("page");
  });

  it("calls onSelectWindow when clicking a window", () => {
    const onSelectWindow = vi.fn();
    renderSidebar({ onSelectWindow });
    fireEvent.click(screen.getByText("scratch"));
    expect(onSelectWindow).toHaveBeenCalledWith("runkit", "run-kit", "@1");
  });

  it("Row Minimalism: window rows show NO fab stage text (dot is the only status signal)", () => {
    // Palette v3 / Row Minimalism (260706-y1ar): the stage word was removed from
    // the window row. Status lives entirely in the leading StatusDot; the exact
    // stage + durations are in the tip and the PANE panel register view.
    renderSidebar();
    expect(screen.queryByText("apply")).not.toBeInTheDocument();
  });

  it("Row Minimalism: window rows show NO duration text (parked or otherwise)", () => {
    const parked: ProjectSession[] = [
      {
        name: "run-kit",
        windows: [
          {
            index: 0,
            windowId: "@0",
            name: "main",
            worktreePath: "~/code/run-kit",
            activity: "idle",
            isActiveWindow: true,
            fabStage: "review-pr",
            fabChange: "260612-epqk-parked",
            fabDisplayState: "done",
            agentState: "idle",
            agentIdleDuration: "2m",
            paneCommand: "zsh",
            activityTimestamp: Math.floor(Date.now() / 1000) - 180,
          },
          {
            index: 1,
            windowId: "@1",
            name: "scratch",
            worktreePath: "~/code/run-kit",
            activity: "idle",
            isActiveWindow: false,
            fabStage: "apply",
            fabChange: "260612-epqk-active",
            fabDisplayState: "active",
            agentState: "active",
            paneCommand: "claude",
            activityTimestamp: Math.floor(Date.now() / 1000) - 5,
          },
        ],
      },
    ];
    renderSidebar({ sessions: parked });
    // No stage words, no duration text anywhere in the rows.
    expect(screen.queryByText("review-pr")).not.toBeInTheDocument();
    expect(screen.queryByText("apply")).not.toBeInTheDocument();
    expect(screen.queryByText("2m")).not.toBeInTheDocument();
  });

  it("does not render empty-state hint when sessions exist", () => {
    renderSidebar();
    expect(screen.queryByText(/no sessions/)).not.toBeInTheDocument();
  });

  it("the kill affordance lives in each session row's card (no in-row kill buttons)", () => {
    // The session-row action cluster is retired on every pointer class — kill
    // is a card row now. Pin a fine pointer and open each row's card via
    // keyboard focus.
    stubPointer(false);
    renderSidebar();
    expect(screen.queryAllByLabelText(/Kill session/)).toHaveLength(0);
    const sessionRows = screen
      .getAllByRole("treeitem")
      .filter((r) => r.getAttribute("aria-level") === "1");
    expect(sessionRows).toHaveLength(2);
    for (const row of sessionRows) {
      act(() => {
        fireEvent.focus(row);
      });
      expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill session");
      act(() => {
        fireEvent.keyDown(document, { key: "Escape" });
      });
    }
  });

  it("shows kill confirmation dialog when the card's Kill session row is clicked", () => {
    stubPointer(false);
    renderSidebar();
    const row = screen
      .getByRole("button", { name: "Navigate to run-kit" })
      .closest('[role="treeitem"]')!;
    act(() => {
      fireEvent.focus(row);
    });
    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-kill-action"));
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Kill session?")).toBeInTheDocument();
    expect(within(dialog).getByText(/3 tab/)).toBeInTheDocument();
  });

  it("shows empty-state hint row when no sessions", () => {
    const onCreateSession = vi.fn();
    renderSidebar({ sessions: [], onCreateSession });
    const hint = screen.getByText(/^\(no sessions — a session groups tabs/);
    expect(hint).toBeInTheDocument();
    fireEvent.click(hint);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });

  // Placeholder education (260811-ke2s): the no-sessions hint names the
  // effective `create-session` chord — derived from the registry, never
  // hardcoded, and dropped when the binding is disabled (a dead chord would
  // lie). Note: the DEFAULT ⇧Ctrl+N is browser-reserved outside the shell
  // (Chrome's incognito chord), so jsdom's bare default render omits the
  // clause; an explicit override makes the derivation observable.
  it("no-sessions hint names the derived create-session chord", () => {
    stubPointer(false);
    localStorage.setItem(
      "hexokit-keybindings",
      JSON.stringify({ "create-session": { code: "Comma", tier: "shifted" } }),
    );
    renderSidebar({ sessions: [], onCreateSession: vi.fn() });
    expect(
      screen.getByText("(no sessions — a session groups tabs; + new, or Shift+Ctrl+,)"),
    ).toBeInTheDocument();
    localStorage.removeItem("hexokit-keybindings");
  });

  it("no-sessions hint drops the chord clause on a coarse pointer", () => {
    // Chord hints never render on touch (the app's chord-hints-off-touch rule)
    // even when the binding is live — the `+ new` row is the touch path.
    stubPointer(true);
    localStorage.setItem(
      "hexokit-keybindings",
      JSON.stringify({ "create-session": { code: "Comma", tier: "shifted" } }),
    );
    renderSidebar({ sessions: [], onCreateSession: vi.fn() });
    expect(screen.getByText("(no sessions — a session groups tabs; + new)")).toBeInTheDocument();
    localStorage.removeItem("hexokit-keybindings");
  });

  it("no-sessions hint drops the chord clause when create-session is unbound", () => {
    localStorage.setItem("hexokit-keybindings", JSON.stringify({ "create-session": null }));
    renderSidebar({ sessions: [], onCreateSession: vi.fn() });
    expect(screen.getByText("(no sessions — a session groups tabs; + new)")).toBeInTheDocument();
    expect(screen.queryByText(/Shift\+Ctrl\+N/)).not.toBeInTheDocument();
    localStorage.removeItem("hexokit-keybindings");
  });

  it("empty-state hint click calls onCreateSession directly (no dialog)", () => {
    const onCreateSession = vi.fn();
    renderSidebar({ sessions: [], onCreateSession });
    fireEvent.click(screen.getByText(/^\(no sessions — a session groups tabs/));
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const renameCases = [
    {
      kind: "window",
      label: "Rename tab",
      original: "scratch",
      changed: "new-name",
      blurInput: "blur-name",
      blurExpected: "blur-name",
      start: () => fireEvent.doubleClick(screen.getByText("scratch")),
      startPrimary: () => fireEvent.doubleClick(screen.getAllByText("main")[0]),
      startSibling: () => fireEvent.doubleClick(screen.getByText("scratch")),
      sibling: "scratch",
      navigate: () => fireEvent.click(screen.getByText("scratch")),
      navigateArgs: ["runkit", "run-kit", "@1"],
      commitArgs: (name: string) => ["runkit", "@1", name],
    },
    {
      kind: "session",
      label: "Rename session",
      original: "run-kit",
      changed: "staging",
      blurInput: "blur-session",
      blurExpected: "blur_session",
      start: () => fireEvent.doubleClick(getSessionRowNameSpan("run-kit")),
      startPrimary: () => fireEvent.doubleClick(getSessionRowNameSpan("run-kit")),
      startSibling: () => fireEvent.doubleClick(screen.getByText("ao-server")),
      sibling: "ao-server",
      navigate: () => fireEvent.click(screen.getByLabelText("Navigate to run-kit")),
      navigateArgs: ["runkit", "run-kit", "@0"],
      commitArgs: (name: string) => ["runkit", "run-kit", name],
    },
  ] as const;

  describe("inline rename", () => {
    it.each(renameCases)("double-click activates the $kind input", (renameCase) => {
      renderSidebar();
      renameCase.start();
      expect(screen.getByLabelText(renameCase.label)).toHaveValue(renameCase.original);
    });

    it.each(renameCases)("Enter commits the $kind rename", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockResolvedValue({ ok: true });

      renderSidebar();
      renameCase.start();
      const input = screen.getByLabelText(renameCase.label);
      fireEvent.change(input, { target: { value: renameCase.changed } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });

      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
      expect(renameMock).toHaveBeenCalledWith(...renameCase.commitArgs(renameCase.changed));
    });

    it.each(renameCases)("Escape cancels the $kind rename", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockClear();

      renderSidebar();
      renameCase.start();
      const input = screen.getByLabelText(renameCase.label);
      fireEvent.change(input, { target: { value: renameCase.changed } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
      expect(renameMock).not.toHaveBeenCalled();
    });

    it.each(renameCases)("blur commits the $kind rename", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockResolvedValue({ ok: true });

      renderSidebar();
      renameCase.start();
      const input = screen.getByLabelText(renameCase.label);
      fireEvent.change(input, { target: { value: renameCase.blurInput } });
      await act(async () => {
        fireEvent.blur(input);
      });

      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
      expect(renameMock).toHaveBeenCalledWith(...renameCase.commitArgs(renameCase.blurExpected));
    });

    it.each(renameCases)("empty $kind input cancels without an API call", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockClear();

      renderSidebar();
      renameCase.start();
      const input = screen.getByLabelText(renameCase.label);
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
      expect(renameMock).not.toHaveBeenCalled();
    });

    it.each(renameCases)("unchanged $kind input skips the API call", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockClear();

      renderSidebar();
      renameCase.start();
      fireEvent.keyDown(screen.getByLabelText(renameCase.label), { key: "Enter" });
      expect(renameMock).not.toHaveBeenCalled();
    });

    it.each(renameCases)("starting a sibling $kind rename cancels the first", async (renameCase) => {
      const api = await import("@/api/client");
      const renameMock = renameCase.kind === "window" ? vi.mocked(api.renameWindow) : vi.mocked(api.renameSession);
      renameMock.mockClear();

      renderSidebar();
      renameCase.startPrimary();
      const firstInput = screen.getByLabelText(renameCase.label);
      fireEvent.change(firstInput, { target: { value: "renamed-first" } });
      renameCase.startSibling();

      expect(screen.getByLabelText(renameCase.label)).toHaveValue(renameCase.sibling);
      expect(renameMock).not.toHaveBeenCalled();
    });

    it.each(renameCases)("single-click navigates without editing a $kind", (renameCase) => {
      const onSelectWindow = vi.fn();
      renderSidebar({ onSelectWindow });
      renameCase.navigate();

      expect(onSelectWindow).toHaveBeenCalledWith(...renameCase.navigateArgs);
      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
    });

    it.each(renameCases)("suspends row drag while editing a $kind", (renameCase) => {
      renderSidebar();
      renameCase.start();
      const input = screen.getByLabelText(renameCase.label);
      const row = input.closest("[draggable]");
      // A pointer drag in the input must select text, not drag the row.
      expect(row?.getAttribute("draggable")).toBe("false");

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByLabelText(renameCase.label)).not.toBeInTheDocument();
      expect(row?.getAttribute("draggable")).toBe("true");
    });

    it("live-converts unsafe session-name characters", () => {
      renderSidebar();
      fireEvent.doubleClick(getSessionRowNameSpan("run-kit"));
      const input = screen.getByLabelText("Rename session");
      fireEvent.change(input, { target: { value: "My problem" } });
      expect(input).toHaveValue("My_problem");
    });
  });


  describe("cross-cancellation session↔window", () => {
    it("starting session edit cancels active window edit without committing", async () => {
      const { renameWindow: renameWindowMock } = await import("@/api/client");
      vi.mocked(renameWindowMock).mockClear();

      renderSidebar();
      // Start editing window "scratch"
      fireEvent.doubleClick(screen.getByText("scratch"));
      const windowInput = screen.getByLabelText("Rename tab");
      fireEvent.change(windowInput, { target: { value: "renamed-scratch" } });

      // Double-click on session name — should cancel window edit without committing
      fireEvent.doubleClick(getSessionRowNameSpan("run-kit"));
      expect(screen.queryByLabelText("Rename tab")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Rename session")).toBeInTheDocument();
      expect(renameWindowMock).not.toHaveBeenCalled();
    });

    it("starting window edit cancels active session edit without committing", async () => {
      const { renameSession: renameSessionMock } = await import("@/api/client");
      vi.mocked(renameSessionMock).mockClear();

      renderSidebar();
      // Start editing session "run-kit"
      fireEvent.doubleClick(getSessionRowNameSpan("run-kit"));
      const sessionInput = screen.getByLabelText("Rename session");
      fireEvent.change(sessionInput, { target: { value: "renamed-run-kit" } });

      // Double-click on window name — should cancel session edit without committing
      fireEvent.doubleClick(screen.getByText("scratch"));
      expect(screen.queryByLabelText("Rename session")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Rename tab")).toBeInTheDocument();
      expect(renameSessionMock).not.toHaveBeenCalled();
    });
  });

  it("does not show external marker (removed in single-server model)", () => {
    renderSidebar();
    expect(screen.queryByLabelText("external session")).not.toBeInTheDocument();
  });

  describe("section order (17m3)", () => {
    it("renders Boards above Server above Sessions", () => {
      renderSidebar();
      // Each section header carries a known label/text. Use
      // `compareDocumentPosition` to assert relative document order — this is
      // stable against unrelated DOM structure (no whole-tree scan, no
      // coupling to nested text-node layout) compared with indexing into
      // `document.body.querySelectorAll("*")`.
      const boardsHeader = screen.getByText("Boards");
      const serverHeader = screen.getByText("Servers", { selector: "span" });
      const sessionsHeader = screen.getByText("Sessions", { selector: "span" });

      // Node.DOCUMENT_POSITION_FOLLOWING (4): the argument node follows the
      // reference node in document order.
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
      expect(boardsHeader.compareDocumentPosition(serverHeader) & FOLLOWING).toBe(FOLLOWING);
      expect(serverHeader.compareDocumentPosition(sessionsHeader) & FOLLOWING).toBe(FOLLOWING);
    });
  });

  describe("drag-and-drop window reorder", () => {
    it("window items have draggable attribute", () => {
      renderSidebar();
      // The "main" window button's parent div should be draggable
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const draggableDiv = mainBtn?.closest("[draggable]");
      expect(draggableDiv).toBeTruthy();
      expect(draggableDiv?.getAttribute("draggable")).toBe("true");
    });

    it("onDragStart sets JSON data with session, index, windowId, and name", () => {
      renderSidebar();
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const draggableDiv = mainBtn?.closest("[draggable]") as HTMLElement;

      // Capture per type: drag start writes the JSON payload AND the
      // application/x-window-drag marker (g0t1 drag-to-pin).
      const transferredByType = new Map<string, string>();
      const dataTransfer = {
        setData: vi.fn((type: string, data: string) => {
          transferredByType.set(type, data);
        }),
        effectAllowed: "",
      };

      fireEvent.dragStart(draggableDiv, { dataTransfer });

      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "application/json",
        JSON.stringify({ server: "runkit", session: "run-kit", index: 0, windowId: "@0", name: "main" }),
      );
      const parsed = JSON.parse(transferredByType.get("application/json")!);
      expect(parsed.server).toBe("runkit");
      expect(parsed.session).toBe("run-kit");
      expect(parsed.index).toBe(0);
      expect(parsed.windowId).toBe("@0");
      expect(parsed.name).toBe("main");
    });

    it("drop on same position does not call moveWindow", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      vi.mocked(moveWindowMock).mockClear();

      renderSidebar();
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const draggableDiv = mainBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0 })),
        effectAllowed: "",
        dropEffect: "",
      };

      // Drag and drop on same element (index 0 -> index 0)
      fireEvent.dragStart(draggableDiv, { dataTransfer });
      fireEvent.dragOver(draggableDiv, { dataTransfer });
      fireEvent.drop(draggableDiv, { dataTransfer });

      expect(moveWindowMock).not.toHaveBeenCalled();
    });

    it("drop on different window in same session calls moveWindow", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      vi.mocked(moveWindowMock).mockClear();

      const onSelectWindow = vi.fn();
      renderSidebar({ onSelectWindow });

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      const scratchBtn = screen.getByText("scratch").closest("button");
      const scratchDraggable = scratchBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0" })),
        effectAllowed: "",
        dropEffect: "",
      };

      // Drag from main (index 0, @0) to scratch (index 1). The move API
      // addresses the source by its stable windowId; the target stays a
      // numeric index.
      fireEvent.dragStart(mainDraggable, { dataTransfer });
      fireEvent.dragOver(scratchDraggable, { dataTransfer });
      await act(async () => {
        fireEvent.drop(scratchDraggable, { dataTransfer });
      });

      expect(moveWindowMock).toHaveBeenCalledWith("runkit", "@0", 1);
    });

    it("drop on window in different session does not call moveWindow", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      vi.mocked(moveWindowMock).mockClear();

      renderSidebar();

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      const devBtn = screen.getByText("dev").closest("button");
      const devDraggable = devBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0 })),
        effectAllowed: "",
        dropEffect: "",
      };

      // Drag from run-kit (main) to ao-server (dev) — cross-session
      fireEvent.dragStart(mainDraggable, { dataTransfer });
      // dragOver on dev should not be allowed (different session)
      fireEvent.dragOver(devDraggable, { dataTransfer });
      fireEvent.drop(devDraggable, { dataTransfer });

      expect(moveWindowMock).not.toHaveBeenCalled();
    });

    it("dragEnd clears drag state", () => {
      renderSidebar();
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const draggableDiv = mainBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        effectAllowed: "",
      };

      fireEvent.dragStart(draggableDiv, { dataTransfer });
      fireEvent.dragEnd(draggableDiv);

      // After dragEnd, no drop indicators should be visible
      // Check that no elements have the accent border style
      const allDraggables = document.querySelectorAll("[draggable]");
      allDraggables.forEach((el) => {
        expect((el as HTMLElement).style.borderTop).not.toContain("2px solid");
      });
    });
  });

  describe("cross-session drag-and-drop", () => {
    beforeEach(() => {
      mockNavigate.mockClear();
      // Seed the window store so killWindow/restoreWindow/addGhostWindow have entries
      useWindowStore.setState({ entries: new Map(), ghosts: [] });
      useWindowStore.getState().setWindowsForSession("runkit", "run-kit", [
        { windowId: "@0", index: 0, name: "main", worktreePath: "~/code/run-kit", activity: "active", isActiveWindow: true, activityTimestamp: Math.floor(Date.now() / 1000) - 5 },
        { windowId: "@1", index: 1, name: "scratch", worktreePath: "~/code/run-kit", activity: "idle", isActiveWindow: false, activityTimestamp: Math.floor(Date.now() / 1000) - 180 },
      ]);
      useWindowStore.getState().setWindowsForSession("runkit", "ao-server", [
        { windowId: "@2", index: 0, name: "dev", worktreePath: "~/code/ao-server", activity: "idle", isActiveWindow: true, activityTimestamp: Math.floor(Date.now() / 1000) - 3600 },
      ]);
    });

    it("drop on different session header calls moveWindowToSession and triggers optimistic update", async () => {
      const { moveWindowToSession: moveWindowToSessionMock } = await import("@/api/client");
      vi.mocked(moveWindowToSessionMock).mockResolvedValue({ ok: true });

      renderSidebar();

      const bravoHeader = screen.getByLabelText("Navigate to ao-server").closest(".flex.items-center.justify-between.group") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      fireEvent.dragStart(mainDraggable, { dataTransfer });

      fireEvent.dragOver(bravoHeader, { dataTransfer });
      await act(async () => {
        fireEvent.drop(bravoHeader, { dataTransfer });
      });

      // Source window should be killed optimistically
      expect(useWindowStore.getState().entries.get(entryKey("runkit", "@0"))?.killed).toBe(true);
      // Ghost window should be added to target session
      expect(useWindowStore.getState().ghosts.some((g) => g.session === "ao-server" && g.name === "main")).toBe(true);
      // Navigate to server dashboard
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/$server", params: { server: "runkit" } });
      // API was called — source addressed by windowId, destination by session name
      expect(moveWindowToSessionMock).toHaveBeenCalledWith("runkit", "@0", "ao-server");
    });

    it("drop on same session header is no-op", async () => {
      const { moveWindowToSession: moveWindowToSessionMock } = await import("@/api/client");
      vi.mocked(moveWindowToSessionMock).mockClear();

      renderSidebar();

      const alphaHeader = screen.getByLabelText("Navigate to run-kit").closest(".flex.items-center.justify-between.group") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      fireEvent.dragStart(mainDraggable, { dataTransfer });

      fireEvent.dragOver(alphaHeader, { dataTransfer });
      fireEvent.drop(alphaHeader, { dataTransfer });

      expect(moveWindowToSessionMock).not.toHaveBeenCalled();
    });

    it("API failure rolls back: restoreWindow + removeGhost + toast", async () => {
      const { moveWindowToSession: moveWindowToSessionMock } = await import("@/api/client");
      vi.mocked(moveWindowToSessionMock).mockRejectedValue(new Error("server error"));

      renderSidebar();

      const bravoHeader = screen.getByLabelText("Navigate to ao-server").closest(".flex.items-center.justify-between.group") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      fireEvent.dragStart(mainDraggable, { dataTransfer });

      // Before drop — source window is not killed
      expect(useWindowStore.getState().entries.get(entryKey("runkit", "@0"))?.killed).toBe(false);

      await act(async () => {
        fireEvent.drop(bravoHeader, { dataTransfer });
      });

      // After API rejection settles, window should be restored (not killed)
      expect(useWindowStore.getState().entries.get(entryKey("runkit", "@0"))?.killed).toBe(false);
      // Ghost should be removed
      expect(useWindowStore.getState().ghosts.some((g) => g.session === "ao-server" && g.name === "main")).toBe(false);
      // Error toast should be shown
      expect(screen.getByText("server error")).toBeInTheDocument();
    });

    it("visual feedback shows accent border on valid cross-session hover", () => {
      renderSidebar();

      const bravoHeader = screen.getByLabelText("Navigate to ao-server").closest(".flex.items-center.justify-between.group") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      fireEvent.dragStart(mainDraggable, { dataTransfer });

      fireEvent.dragOver(bravoHeader, { dataTransfer });

      expect(bravoHeader.style.boxShadow).toContain("2px");
    });

    it("within-session window drag still works after cross-session support", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      vi.mocked(moveWindowMock).mockClear();

      const onSelectWindow = vi.fn();
      renderSidebar({ onSelectWindow });

      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      const scratchBtn = screen.getByText("scratch").closest("button");
      const scratchDraggable = scratchBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      fireEvent.dragStart(mainDraggable, { dataTransfer });
      fireEvent.dragOver(scratchDraggable, { dataTransfer });
      await act(async () => {
        fireEvent.drop(scratchDraggable, { dataTransfer });
      });

      expect(moveWindowMock).toHaveBeenCalledWith("runkit", "@0", 1);
    });
  });

  describe("window kill clears optimistic state on success", () => {
    it("Ctrl+click kill: killed entry is removed after API call resolves", async () => {
      // Ctrl+click force-kill is a FINE-pointer path — the in-row kill button
      // is render-gated off on coarse (the file's blanket matchMedia stub
      // defaults to coarse), so pin the pointer to fine for this test.
      stubPointer(false);
      const { killWindow: killWindowMock } = await import("@/api/client");
      vi.mocked(killWindowMock).mockResolvedValue({ ok: true });

      let killedCount = -1;

      function KilledCountDisplay() {
        const ctx = useOptimisticContext();
        killedCount = ctx.killed.length;
        return <span data-testid="killed-count">{ctx.killed.length}</span>;
      }

      render(
        <ThemeProvider>
        <InstanceAccentValueProvider value={NULL_ACCENT}>
        <InstanceNameValueProvider value={NULL_NAME}>
        <ToastProvider>
          <OptimisticProvider>
            <StandaloneSessionContextProvider
              value={{
                sessionsByServer: new Map([["runkit", sessions]]),
                sessionOrderByServer: new Map([["runkit", []]]),
                isConnectedByServer: new Map([["runkit", false]]),
                metricsByServer: new Map(),
                currentServer: "runkit",
                servers: [{ name: "runkit", sessionCount: 0 }],
                refreshServers: vi.fn(),
              }}
            >
              <MetricsProvider value={null}>
                <HostMetricsProvider value={null}>
                  <FocusedPaneProvider>
                    <KilledCountDisplay />
                    <ChromeProvider>
                      <SettingsDialogProvider>
                        <Sidebar
                          currentServer="runkit"
                          currentSession="run-kit"
                          currentWindowId="@0"
                          isConnected={false}
                          onSelectWindow={vi.fn()}
                          onCreateWindow={vi.fn()}
                          onCreateSession={vi.fn()}
                          onCreateServer={vi.fn()}
                          onKillServer={vi.fn()}
                        />
                      </SettingsDialogProvider>
                    </ChromeProvider>
                  </FocusedPaneProvider>
                </HostMetricsProvider>
              </MetricsProvider>
            </StandaloneSessionContextProvider>
          </OptimisticProvider>
        </ToastProvider>
        </InstanceNameValueProvider>
        </InstanceAccentValueProvider>
        </ThemeProvider>,
      );

      // Ctrl+click the X button for "scratch" window (index 1)
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Kill tab scratch"), { ctrlKey: true });
      });

      // API was called — window addressed by its stable windowId
      expect(killWindowMock).toHaveBeenCalledWith("runkit", "@1");
      // After the API call resolves, the killed entry must be removed (unmarkKilled called)
      expect(killedCount).toBe(0);
    });
  });

  describe("window kills push the recently-closed record", () => {
    const CLOSED_RECORD: ClosedWindow = {
      id: "1756700000000000000",
      closedAt: "2026-09-01T10:00:00Z",
      server: "runkit",
      session: "run-kit",
      window: { index: 1, id: "@1", name: "scratch", panes: [] },
    };

    beforeEach(() => {
      // Both kill entry points are fine-pointer row controls.
      stubPointer(false);
      vi.mocked(pushRecentlyClosed).mockClear();
      // The window store is module-global; a dialog-confirmed kill leaves its
      // optimistic killed flag set (SSE clears it in the real app), which
      // would hide the row from the next test.
      useWindowStore.setState({ entries: new Map(), ghosts: [] });
    });

    it("Ctrl+click kill pushes the response's closed record with the row's server", async () => {
      const { killWindow: killWindowMock } = await import("@/api/client");
      vi.mocked(killWindowMock).mockResolvedValue({ ok: true, closed: CLOSED_RECORD });
      renderSidebar();
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Kill tab scratch"), { ctrlKey: true });
      });
      expect(pushRecentlyClosed).toHaveBeenCalledWith("runkit", CLOSED_RECORD);
    });

    it("dialog-confirmed kill pushes the response's closed record", async () => {
      const { killWindow: killWindowMock } = await import("@/api/client");
      vi.mocked(killWindowMock).mockResolvedValue({ ok: true, closed: CLOSED_RECORD });
      renderSidebar();
      fireEvent.click(screen.getByLabelText("Kill tab scratch"));
      expect(screen.getByText("Kill tab?")).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Kill" }));
      });
      expect(killWindowMock).toHaveBeenCalledWith("runkit", "@1");
      expect(pushRecentlyClosed).toHaveBeenCalledWith("runkit", CLOSED_RECORD);
    });

    it("a response without a closed record pushes nothing (both paths)", async () => {
      const { killWindow: killWindowMock } = await import("@/api/client");
      vi.mocked(killWindowMock).mockClear().mockResolvedValue({ ok: true });
      renderSidebar();
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Kill tab scratch"), { ctrlKey: true });
      });
      fireEvent.click(screen.getByLabelText("Kill tab logs"));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Kill" }));
      });
      expect(killWindowMock).toHaveBeenCalledTimes(2);
      expect(pushRecentlyClosed).not.toHaveBeenCalled();
    });
  });

  describe("optimistic drag-drop reorder", () => {
    beforeEach(() => {
      // Seed the window store so moveWindowOrder has entries to operate on.
      // Need 3+ windows to test insert-before semantics (2-item forward move is a no-op).
      useWindowStore.setState({ entries: new Map(), ghosts: [] });
      useWindowStore.getState().setWindowsForSession("runkit", "run-kit", [
        { windowId: "@0", index: 0, name: "main", worktreePath: "~/code/run-kit", activity: "active", isActiveWindow: true, activityTimestamp: Math.floor(Date.now() / 1000) - 5 },
        { windowId: "@1", index: 1, name: "scratch", worktreePath: "~/code/run-kit", activity: "idle", isActiveWindow: false, activityTimestamp: Math.floor(Date.now() / 1000) - 180 },
        { windowId: "@2", index: 2, name: "logs", worktreePath: "~/code/run-kit", activity: "idle", isActiveWindow: false, activityTimestamp: Math.floor(Date.now() / 1000) - 300 },
      ]);
    });

    it("optimistic move updates window store indices synchronously on drop", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      // Use a deferred promise so API stays pending during assertion
      let resolveApi!: () => void;
      vi.mocked(moveWindowMock).mockImplementation(() => new Promise<{ ok: boolean }>((r) => { resolveApi = () => r({ ok: true }); }));

      const onSelectWindow = vi.fn();
      renderSidebar({ onSelectWindow });

      // Drag main(@0, index 0) onto logs(@2, index 2)
      // Insert-before: [main scratch logs] → [scratch main logs]
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      const logsBtn = screen.getByText("logs").closest("button");
      const logsDraggable = logsBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      fireEvent.dragStart(mainDraggable, { dataTransfer });
      fireEvent.dragOver(logsDraggable, { dataTransfer });
      fireEvent.drop(logsDraggable, { dataTransfer });

      // Synchronous: store indices should reflect insert-before (before API resolves)
      const entries = useWindowStore.getState().entries;
      expect(entries.get(entryKey("runkit", "@1"))?.index).toBe(0); // scratch shifted left
      expect(entries.get(entryKey("runkit", "@0"))?.index).toBe(1); // main inserted before logs
      expect(entries.get(entryKey("runkit", "@2"))?.index).toBe(2); // logs unchanged

      // Reorder should not change selection
      expect(onSelectWindow).not.toHaveBeenCalled();

      // Clean up: flush microtask to let action() run (assigns resolveApi), then resolve
      await act(async () => { await Promise.resolve(); });
      await act(async () => { resolveApi(); });
    });

    it("rollback on API failure restores original window order", async () => {
      const { moveWindow: moveWindowMock } = await import("@/api/client");
      vi.mocked(moveWindowMock).mockRejectedValue(new Error("server error"));

      renderSidebar();

      // Drag main(@0, index 0) onto logs(@2, index 2)
      const mainBtn = screen.getAllByText("main")[0].closest("button");
      const mainDraggable = mainBtn?.closest("[draggable]") as HTMLElement;
      const logsBtn = screen.getByText("logs").closest("button");
      const logsDraggable = logsBtn?.closest("[draggable]") as HTMLElement;

      const dataTransfer = {
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(JSON.stringify({ session: "run-kit", index: 0, windowId: "@0", name: "main" })),
        effectAllowed: "",
        dropEffect: "",
      };

      fireEvent.dragStart(mainDraggable, { dataTransfer });
      fireEvent.dragOver(logsDraggable, { dataTransfer });

      // Drop triggers optimistic move + API call
      await act(async () => {
        fireEvent.drop(logsDraggable, { dataTransfer });
      });

      // After API rejection settles, indices should be restored
      const entries = useWindowStore.getState().entries;
      expect(entries.get(entryKey("runkit", "@0"))?.index).toBe(0);
      expect(entries.get(entryKey("runkit", "@1"))?.index).toBe(1);
      expect(entries.get(entryKey("runkit", "@2"))?.index).toBe(2);
    });
  });

  describe("ghost entries", () => {
    it("renders ghost session with opacity-50 and animate-pulse", () => {
      const ghostSessions = [
        ...sessions,
        {
          name: "ghost-session",
          windows: [],
          optimistic: true,
          optimisticId: "ghost-1",
        },
      ];
      renderSidebar({ sessions: ghostSessions });
      const ghostName = screen.getByText("ghost-session");
      // Find the session container (the outer div wrapping the session header)
      const sessionContainer = ghostName.closest("[class*='opacity-50']");
      expect(sessionContainer).toBeTruthy();
      expect(sessionContainer?.className).toContain("animate-pulse");
    });

    it("renders ghost window with opacity-50 and animate-pulse", () => {
      const sessionsWithGhostWindow = [
        {
          ...sessions[0],
          windows: [
            ...sessions[0].windows,
            {
              index: 99,
              windowId: "",
              name: "ghost-win",
              worktreePath: "",
              activity: "idle" as const,
              isActiveWindow: false,
              activityTimestamp: 0,
              optimistic: true,
              optimisticId: "ghost-w-1",
            },
          ],
        },
        sessions[1],
      ];
      renderSidebar({ sessions: sessionsWithGhostWindow });
      const ghostWin = screen.getByText("ghost-win");
      const windowRow = ghostWin.closest("[class*='opacity-50']");
      expect(windowRow).toBeTruthy();
      expect(windowRow?.className).toContain("animate-pulse");
    });

    it("ghost window uses optimisticId as key (not index)", () => {
      const sessionsWithGhostWindow = [
        {
          ...sessions[0],
          windows: [
            ...sessions[0].windows,
            {
              index: 0, // same index as real window — key collision without optimisticId
              windowId: "",
              name: "new-window",
              worktreePath: "",
              activity: "idle" as const,
              isActiveWindow: false,
              activityTimestamp: 0,
              optimistic: true,
              optimisticId: "ghost-w-2",
            },
          ],
        },
      ];
      // Should not throw from duplicate React keys
      renderSidebar({ sessions: sessionsWithGhostWindow });
      expect(screen.getByText("new-window")).toBeInTheDocument();
    });
  });

  describe("session reorder display-order derivation (ebks)", () => {
    // The default fixture has two sessions on server "runkit": "run-kit"
    // (windows @0-@2) and "ao-server" (window @3). The per-server SSE order is
    // over SESSION names. Displayed order = override ?? sseOrder.

    /** Returns the session-row names in current DOM (document) order. */
    function sessionNamesInDomOrder(): string[] {
      const navButtons = screen.getAllByLabelText(/^Navigate to /);
      return navButtons.map((b) => b.getAttribute("aria-label")!.replace("Navigate to ", ""));
    }

    /** Drag session `from` onto session `to` within `server`, reordering rows. */
    function dragSessionOnto(from: string, to: string) {
      const fromRow = screen.getByLabelText(`Navigate to ${from}`).closest("[draggable]") as HTMLElement;
      const toRow = screen.getByLabelText(`Navigate to ${to}`).closest("[draggable]") as HTMLElement;
      const dataTransfer = {
        _store: {} as Record<string, string>,
        types: [] as string[],
        setData(type: string, val: string) {
          this._store[type] = val;
          if (!this.types.includes(type)) this.types.push(type);
        },
        getData(type: string) {
          return this._store[type] ?? "";
        },
        effectAllowed: "",
        dropEffect: "",
      };
      fireEvent.dragStart(fromRow, { dataTransfer });
      fireEvent.dragOver(toRow, { dataTransfer });
    }

    it("(a) displayed order follows SSE order when no override", () => {
      // SSE says ao-server first, then run-kit — reversed from fixture order.
      renderSidebar({ sessionOrderByServer: { runkit: ["ao-server", "run-kit"] } });
      const order = sessionNamesInDomOrder();
      expect(order.indexOf("ao-server")).toBeLessThan(order.indexOf("run-kit"));
    });

    it("(b) a drag override persists across unrelated re-renders until the matching SSE order arrives, then is dropped (no snap-back)", () => {
      // Start with the natural fixture order via SSE (run-kit, then ao-server).
      const { rerenderWith } = renderSidebar({ sessionOrderByServer: { runkit: ["run-kit", "ao-server"] } });
      let order = sessionNamesInDomOrder();
      expect(order.indexOf("run-kit")).toBeLessThan(order.indexOf("ao-server"));

      // Drag ao-server above run-kit — override applies immediately (snappy).
      dragSessionOnto("ao-server", "run-kit");
      order = sessionNamesInDomOrder();
      expect(order.indexOf("ao-server")).toBeLessThan(order.indexOf("run-kit"));

      // An UNRELATED SSE slice arrives that does NOT yet echo the new order
      // (still the old order). The override MUST hold — no snap-back.
      act(() => {
        rerenderWith({ sessionOrderByServer: { runkit: ["run-kit", "ao-server"] } });
      });
      order = sessionNamesInDomOrder();
      expect(order.indexOf("ao-server")).toBeLessThan(order.indexOf("run-kit"));

      // Now the matching SSE order echoes back. The override is dropped and the
      // row reads the authoritative (now-identical) SSE order — still ao-server
      // first, and no stale override lingers.
      act(() => {
        rerenderWith({ sessionOrderByServer: { runkit: ["ao-server", "run-kit"] } });
      });
      order = sessionNamesInDomOrder();
      expect(order.indexOf("ao-server")).toBeLessThan(order.indexOf("run-kit"));

      // A subsequent unrelated SSE slice that reverts the order would now take
      // effect (proving the override was actually cleared, not still pinning).
      act(() => {
        rerenderWith({ sessionOrderByServer: { runkit: ["run-kit", "ao-server"] } });
      });
      order = sessionNamesInDomOrder();
      expect(order.indexOf("run-kit")).toBeLessThan(order.indexOf("ao-server"));
    });

    it("(c) a reorder fires the debounced PUT once with the reordered names", async () => {
      vi.useFakeTimers();
      try {
        const { setSessionOrder } = await import("@/api/client");
        vi.mocked(setSessionOrder).mockClear();

        renderSidebar({ sessionOrderByServer: { runkit: ["run-kit", "ao-server"] } });

        dragSessionOnto("ao-server", "run-kit");

        // Debounce window not yet elapsed → no PUT.
        expect(setSessionOrder).not.toHaveBeenCalled();

        // Advance past SESSION_ORDER_DEBOUNCE_MS (250ms).
        act(() => {
          vi.advanceTimersByTime(250);
        });

        expect(setSessionOrder).toHaveBeenCalledTimes(1);
        expect(setSessionOrder).toHaveBeenCalledWith("runkit", ["ao-server", "run-kit"]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
