import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import { QuakeTerminal, QuakeTerminalTongue } from "./quake-terminal";
import { StandaloneSessionContextProvider, type NotifyPayload } from "@/contexts/session-context";
import { ToastProvider } from "@/components/toast";
import {
  dismissOperatorChatChip,
  getQuakeMachineState,
  getOperatorChatTarget,
  requestQuakeTerminal,
  resetOperatorComposeFlags,
  setQuakeMachineState,
  setQuakeRestoreOrigin,
  setOperatorChatSubject,
  setOperatorComposeText,
  writeQuakeOpacity,
} from "@/lib/quake-terminal";
import { getComposeDraft, hydrateComposeDrafts } from "@/lib/compose-draft-store";
import { _resetForTests as resetOverlayPresence, count as overlayCount } from "@/lib/overlay-presence";
import { entryKey } from "@/store/window-store";
import { ApiError } from "@/api/client";
import { stubMatchMedia } from "@/test-utils/match-media";
import type { ProjectSession, WindowInfo } from "@/types";

// Route params and search the quake terminal's server-context walk and `?from=`
// validation read; navigations the mobile arm issues are recorded.
let mockMatches: Array<{ params: Record<string, string> }> = [{ params: {} }];
let mockSearch: Record<string, unknown> = {};
const mockNavigate = vi.hoisted(() => vi.fn());
const mockHistoryBack = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => mockMatches,
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: { back: mockHistoryBack } }),
}));

// The embedded terminal is TerminalClient's own tested surface; here we only
// record the (server, windowId, sessionName) it was pointed at and wire the
// focusRef seam (a no-op focus handle — the Esc ladder's yield target).
const terminalMounts = vi.hoisted(() => [] as { server: string; windowId: string; sessionName: string }[]);
vi.mock("@/components/terminal-client", () => ({
  TerminalClient: (props: {
    server: string;
    windowId: string;
    sessionName: string;
    focusRef?: React.MutableRefObject<(() => void) | null>;
  }) => {
    terminalMounts.push({ server: props.server, windowId: props.windowId, sessionName: props.sessionName });
    if (props.focusRef) props.focusRef.current = () => {};
    return <div data-testid="embedded-terminal" />;
  },
}));

const mockSend = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockOperatorRequest = vi.hoisted(() => vi.fn());
const mockStartOperator = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  sendToWindow: mockSend,
  uploadFile: mockUpload,
  sendOperatorRequest: mockOperatorRequest,
  startOperator: mockStartOperator,
}));

// The compose-strip focus seam is spied (not exercised) here — the strip
// itself is ComposeStrip's own tested surface.
const mockFocusComposeStrip = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/compose-strip-events", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/compose-strip-events")>()),
  focusComposeStrip: mockFocusComposeStrip,
}));

// The cron segments mount the real CronList/CronLog; their cron fetch is
// mocked out here (controllable shape) so no request fires from these tests.
const mockCronData = vi.hoisted(() => ({
  current: {
    entries: [] as import("@/api/client").CronEntry[],
    deliveries: [] as import("@/api/client").CronDelivery[],
  },
}));
vi.mock("@/hooks/use-cron", () => ({
  useCronData: () => mockCronData.current,
}));

function win(overrides: Partial<WindowInfo>): WindowInfo {
  return {
    windowId: "@1",
    index: 0,
    name: "win",
    worktreePath: "/tmp",
    activity: "idle",
    isActiveWindow: false,
    activityTimestamp: 0,
    ...overrides,
  };
}

const OPERATOR_WINDOW = win({ windowId: "@9", name: "operator", role: "operator" });
/** The resolved operator target on any server whose sessions carry
 *  OPERATOR_WINDOW — the quake compose seam's draft key half. */
const OPERATOR_TARGET = { window: OPERATOR_WINDOW, sessionName: "_rk-operator" };

// The notify subscriptions mounted quake terminals register; tests fire the
// daemon's broadcast payloads through the captured handlers.
const notifySubscribers = new Set<(payload: NotifyPayload) => void>();
function fireNotify(payload: NotifyPayload) {
  act(() => {
    for (const handler of notifySubscribers) handler(payload);
  });
}

function operatorSessions(extraWindows: WindowInfo[] = []): ProjectSession[] {
  return [
    { name: "main", windows: [win({ windowId: "@1" }), ...extraWindows] },
    { name: "_rk-operator", windows: [OPERATOR_WINDOW], hidden: true },
  ];
}

function renderQuake(opts: {
  servers?: string[];
  sessionsByServer?: Map<string, ProjectSession[]>;
  /** Per-server "first sessions event received" flags; defaults to every
   *  listed server loaded — the operator-less cron branch keys on it. */
  isConnectedByServer?: Map<string, boolean>;
  withToasts?: boolean;
} = {}) {
  const servers = (opts.servers ?? ["srv1"]).map((name) => ({ name, sessionCount: 1 }));
  const tree = (
    <StandaloneSessionContextProvider
      value={{
        servers,
        serversLoaded: true,
        sessionsByServer: opts.sessionsByServer ?? new Map([["srv1", operatorSessions()]]),
        isConnectedByServer:
          opts.isConnectedByServer ?? new Map(servers.map((s) => [s.name, true] as const)),
        subscribeNotify: (handler) => {
          notifySubscribers.add(handler);
          return () => {
            notifySubscribers.delete(handler);
          };
        },
      }}
    >
      <QuakeTerminal />
    </StandaloneSessionContextProvider>
  );
  return render(opts.withToasts ? <ToastProvider>{tree}</ToastProvider> : tree);
}

/** A rerender-able provider tree for tests that swap the sessions payload
 *  mid-test (the SSE-equivalent) across one or more servers. */
function quakeTree(servers: string[], sessionsByServer: Map<string, ProjectSession[]>) {
  return (
    <StandaloneSessionContextProvider
      value={{
        servers: servers.map((name) => ({ name, sessionCount: 1 })),
        serversLoaded: true,
        sessionsByServer,
        isConnectedByServer: new Map(servers.map((name) => [name, true] as const)),
      }}
    >
      <QuakeTerminal />
    </StandaloneSessionContextProvider>
  );
}

/** Every listed server with one plain session and no operator window. */
function operatorLess(servers: string[]): Map<string, ProjectSession[]> {
  return new Map(
    servers.map((name) => [name, [{ name: "main", windows: [win({ windowId: "@1" })] }]] as const),
  );
}

/** Tests that need the drawer open unconditionally dispatch the palette
 *  action's `open` (the chord toggles). */
function openDrawer() {
  act(() => {
    requestQuakeTerminal({ action: "open" });
  });
}

function stepMachine() {
  act(() => {
    requestQuakeTerminal({ action: "toggle" });
  });
}

describe("QuakeTerminal", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    mockStartOperator.mockReset();
    mockFocusComposeStrip.mockClear();
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the chord toggles the desktop machine rest → open → rest", async () => {
    renderQuake();
    expect(screen.queryByTestId("quake-terminal")).toBeNull();

    // Step 1: open — focus and drawer are linked, nothing sent.
    stepMachine();
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(mockSend).not.toHaveBeenCalled();

    // Step 2: rest — the exit slide holds the mount until transitionend (or
    // the fallback timeout — jsdom fires no transition events).
    stepMachine();
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("registers as a modal overlay while the drawer is mounted, through the exit slide", async () => {
    resetOverlayPresence();
    renderQuake();
    expect(overlayCount("modal")).toBe(0);

    stepMachine();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(overlayCount("modal")).toBe(1);

    // Rest: the drawer stays mounted (and registered) until the exit slide
    // ends; the registration releases with the unmount, not the machine flip.
    stepMachine();
    expect(getQuakeMachineState()).toBe("rest");
    // The unmount rides the slide's timeout fallback (jsdom fires no
    // transitionend); give it headroom under full-suite load.
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull(), { timeout: 3000 });
    expect(overlayCount("modal")).toBe(0);
  });

  it.each(["toggle", "open"] as const)(
    "focuses the page's compose strip and keeps the machine at rest for %s on the operator route",
    (action) => {
      mockMatches = [{ params: { server: "srv1", window: "@9" } }];
      renderQuake({ withToasts: true });

      act(() => requestQuakeTerminal({ action }));

      expect(mockFocusComposeStrip).toHaveBeenCalled();
      expect(getQuakeMachineState()).toBe("rest");
      expect(screen.queryByTestId("quake-terminal")).toBeNull();
      // The retired already-viewing toast is gone — focus IS the answer.
      expect(screen.queryByText(/already viewing the operator/)).toBeNull();
    },
  );

  it("seeds the page's compose-strip draft (unsent) when a send payload arrives on the operator route", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    renderQuake({ withToasts: true });

    act(() => requestQuakeTerminal({ action: "open", send: "hello operator" }));

    expect(mockFocusComposeStrip).toHaveBeenCalled();
    expect(getComposeDraft(entryKey("srv1", "@9"))?.text).toBe("hello operator");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("gates explicit server and send details before they mutate quake terminal state", async () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    renderQuake({
      servers: ["srv1", "srv2"],
      sessionsByServer: new Map([
        ["srv1", operatorSessions()],
        [
          "srv2",
          [
            { name: "main", windows: [win({ windowId: "@1" })] },
            {
              name: "_rk-operator",
              hidden: true,
              windows: [win({ windowId: "@7", name: "operator-b", role: "operator" })],
            },
          ],
        ],
      ]),
    });

    act(() => {
      requestQuakeTerminal({ action: "open", server: "srv2", send: "must stay pending nowhere" });
    });
    act(() => setQuakeMachineState("open"));

    await screen.findByTestId("quake-terminal");
    expect(terminalMounts.at(-1)).toMatchObject({ server: "srv1", windowId: "@9" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
  });

  it.each(["toggle", "open"] as const)(
    "preserves the desktop %s behavior away from the operator route",
    (action) => {
      mockMatches = [{ params: { server: "srv1", window: "@1" } }];
      renderQuake();

      act(() => requestQuakeTerminal({ action }));

      expect(getQuakeMachineState()).toBe("open");
      expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    },
  );

  it("⤢ open as tab navigates to the operator route carrying the current segment and rests the machine", async () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });
    await screen.findByTestId("quake-terminal");

    fireEvent.click(screen.getByTestId("quake-terminal-open-as-tab"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { tab: "log" },
    });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("⤢ open as tab from the terminal segment navigates with empty search, and renders only while a target resolves", async () => {
    renderQuake();
    openDrawer();
    await screen.findByTestId("quake-terminal");

    fireEvent.click(screen.getByTestId("quake-terminal-open-as-tab"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: {},
    });
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("renders no ⤢ control in the operator-less body", () => {
    renderQuake({
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({ windowId: "@1" })] }]]]),
    });
    openDrawer();

    expect(screen.queryByTestId("quake-terminal-open-as-tab")).toBeNull();
  });

  it("Start operator posts once, stays pending, and the body unmounts when the sessions payload carries the operator", async () => {
    let resolveStart: (result: { windowId: string; server: string }) => void = () => {};
    mockStartOperator.mockReturnValue(
      new Promise<{ windowId: string; server: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const noOperator = new Map([["srv1", [{ name: "main", windows: [win({ windowId: "@1" })] }]]]);
    const view = render(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: noOperator,
        }}
      >
        <QuakeTerminal />
      </StandaloneSessionContextProvider>,
    );
    openDrawer();
    const button = screen.getByTestId("quake-terminal-start-operator");
    expect(button).toHaveTextContent("Start operator");
    // The hint survives as the sub-line.
    expect(screen.getByTestId("quake-terminal-empty")).toHaveTextContent(
      "no operator on this server — run rk operator",
    );

    fireEvent.click(button);
    expect(mockStartOperator).toHaveBeenCalledTimes(1);
    expect(mockStartOperator).toHaveBeenCalledWith("srv1", undefined);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("starting…");

    // Pending is a hard guard — a second click fires no second POST.
    fireEvent.click(button);
    expect(mockStartOperator).toHaveBeenCalledTimes(1);

    resolveStart({ windowId: "@9", server: "srv1" });
    // Success itself changes nothing locally — the SSE-equivalent rerender
    // (the sessions payload now carrying the operator window) swaps the body.
    view.rerender(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", operatorSessions()]]),
        }}
      >
        <QuakeTerminal />
      </StandaloneSessionContextProvider>,
    );
    await screen.findByTestId("embedded-terminal");
    expect(screen.queryByTestId("quake-terminal-empty")).toBeNull();
    expect(screen.queryByTestId("quake-terminal-start-operator")).toBeNull();
  });

  it("Start operator on a same-server terminal route sends the viewed window", async () => {
    mockStartOperator.mockResolvedValue({ windowId: "@9", server: "srv1" });
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake({
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({ windowId: "@1" })] }]]]),
    });
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));

    await waitFor(() => expect(mockStartOperator).toHaveBeenCalledWith("srv1", "@1"));
  });

  it("treats a 409 operator_exists as success — no error line, button stays pending", async () => {
    mockStartOperator.mockRejectedValue(
      new ApiError("operator already present", 409, "operator_exists", "@9"),
    );
    renderQuake({
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({ windowId: "@1" })] }]]]),
    });
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));

    await waitFor(() => expect(mockStartOperator).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();
  });

  it("surfaces a start failure inline and re-arms the button", async () => {
    mockStartOperator.mockRejectedValue(
      new ApiError("run-kit operator: fab not found on PATH", 502),
    );
    renderQuake({
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({ windowId: "@1" })] }]]]),
    });
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));

    const errorLine = await screen.findByTestId("quake-terminal-start-error");
    expect(errorLine).toHaveAttribute("role", "alert");
    expect(errorLine).toHaveTextContent("run-kit operator: fab not found on PATH");
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeEnabled();
    expect(screen.getByTestId("quake-terminal-start-operator")).toHaveTextContent("Start operator");
  });

  it("Start operator re-arms when the operator window appears and later vanishes", async () => {
    mockStartOperator.mockResolvedValue({ windowId: "@9", server: "srv1" });
    const view = render(quakeTree(["srv1"], operatorLess(["srv1"])));
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    expect(screen.getByTestId("quake-terminal-start-operator")).toHaveTextContent("starting…");

    view.rerender(quakeTree(["srv1"], new Map([["srv1", operatorSessions()]])));
    await screen.findByTestId("embedded-terminal");

    // The operator died (trust wall, agent exit, closed pane): the body comes
    // back idle, not stuck on the previous request's pending.
    view.rerender(quakeTree(["srv1"], operatorLess(["srv1"])));
    const button = await screen.findByTestId("quake-terminal-start-operator");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Start operator");
    expect(button).not.toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
  });

  it("Start operator pending is per server — another server renders its own idle button", () => {
    mockStartOperator.mockReturnValue(new Promise(() => {}));
    render(quakeTree(["a", "b"], operatorLess(["a", "b"])));
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    expect(mockStartOperator).toHaveBeenCalledWith("a", undefined);
    expect(screen.getByTestId("quake-terminal-start-operator")).toHaveTextContent("starting…");

    const picker = screen.getByRole("combobox", { name: "Operator server" });
    fireEvent.change(picker, { target: { value: "b" } });
    const onB = screen.getByTestId("quake-terminal-start-operator");
    expect(onB).toBeEnabled();
    expect(onB).toHaveTextContent("Start operator");

    fireEvent.change(picker, { target: { value: "a" } });
    const onA = screen.getByTestId("quake-terminal-start-operator");
    expect(onA).toBeDisabled();
    expect(onA).toHaveTextContent("starting…");
  });

  it("resolution on the pending server clears pending while the drawer shows another server", async () => {
    mockStartOperator.mockResolvedValue({ windowId: "@9", server: "a" });
    const view = render(quakeTree(["a", "b"], operatorLess(["a", "b"])));
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    const picker = screen.getByRole("combobox", { name: "Operator server" });
    fireEvent.change(picker, { target: { value: "b" } });

    // a's operator arrives while b is on screen.
    view.rerender(
      quakeTree(["a", "b"], new Map([["a", operatorSessions()], ["b", operatorLess(["b"]).get("b")!]])),
    );
    await act(async () => {});
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeEnabled();

    fireEvent.change(screen.getByRole("combobox", { name: "Operator server" }), {
      target: { value: "a" },
    });
    await screen.findByTestId("embedded-terminal");

    // a's operator then dies: the request already resolved, so no pending
    // survives to disable the button.
    view.rerender(quakeTree(["a", "b"], operatorLess(["a", "b"])));
    const button = await screen.findByTestId("quake-terminal-start-operator");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Start operator");
  });

  it("Start operator re-arms with an inline note when no window appears within the pending timeout", async () => {
    vi.useFakeTimers();
    try {
      mockStartOperator.mockResolvedValue({ windowId: "@9", server: "srv1" });
      render(quakeTree(["srv1"], operatorLess(["srv1"])));
      openDrawer();

      fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(44_999);
      });
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();
      expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const button = screen.getByTestId("quake-terminal-start-operator");
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent("Start operator");
      const note = screen.getByTestId("quake-terminal-start-error");
      expect(note).toHaveAttribute("role", "alert");
      expect(note).toHaveTextContent(
        "operator did not appear — check the operator terminal or run rk operator",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("an operator window arriving before the pending timeout cancels it — no note", async () => {
    vi.useFakeTimers();
    try {
      mockStartOperator.mockResolvedValue({ windowId: "@9", server: "srv1" });
      const view = render(quakeTree(["srv1"], operatorLess(["srv1"])));
      openDrawer();

      fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      view.rerender(quakeTree(["srv1"], new Map([["srv1", operatorSessions()]])));
      await act(async () => {});
      expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();

      // Past the original deadline, with the window gone again: the timer was
      // cleared on resolution, so nothing fires and no note renders.
      view.rerender(quakeTree(["srv1"], operatorLess(["srv1"])));
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeEnabled();
      expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale start failure re-arms and reports only on the server it was requested for", async () => {
    let rejectStart: (err: unknown) => void = () => {};
    mockStartOperator.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      }),
    );
    render(quakeTree(["a", "b"], operatorLess(["a", "b"])));
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    const picker = screen.getByRole("combobox", { name: "Operator server" });
    fireEvent.change(picker, { target: { value: "b" } });

    await act(async () => {
      rejectStart(new ApiError("run-kit operator: fab not found on PATH", 502));
    });
    expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeEnabled();

    fireEvent.change(picker, { target: { value: "a" } });
    expect(screen.getByTestId("quake-terminal-start-error")).toHaveTextContent(
      "run-kit operator: fab not found on PATH",
    );
    const onA = screen.getByTestId("quake-terminal-start-operator");
    expect(onA).toBeEnabled();
    expect(onA).toHaveTextContent("Start operator");
  });

  it("two servers can be pending at once — a click on the second never drops the first", async () => {
    mockStartOperator.mockReturnValue(new Promise(() => {}));
    const view = render(quakeTree(["a", "b"], operatorLess(["a", "b"])));
    openDrawer();

    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    const picker = screen.getByRole("combobox", { name: "Operator server" });
    fireEvent.change(picker, { target: { value: "b" } });
    fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
    expect(mockStartOperator).toHaveBeenCalledTimes(2);
    expect(mockStartOperator).toHaveBeenLastCalledWith("b", undefined);
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();

    fireEvent.change(picker, { target: { value: "a" } });
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();

    // a's window arrives: a resolves, b is still waiting on its own request.
    view.rerender(
      quakeTree(["a", "b"], new Map([["a", operatorSessions()], ["b", operatorLess(["b"]).get("b")!]])),
    );
    await screen.findByTestId("embedded-terminal");
    fireEvent.change(screen.getByRole("combobox", { name: "Operator server" }), {
      target: { value: "b" },
    });
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();
    expect(screen.getByTestId("quake-terminal-start-operator")).toHaveTextContent("starting…");
  });

  it("a late rejection from an older attempt never releases a newer attempt on the same server", async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst: (err: unknown) => void = () => {};
      mockStartOperator.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
      );
      mockStartOperator.mockReturnValue(new Promise(() => {}));
      render(quakeTree(["srv1"], operatorLess(["srv1"])));
      openDrawer();

      fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
      await act(async () => {
        vi.advanceTimersByTime(45_000);
      });
      expect(screen.getByTestId("quake-terminal-start-error")).toBeInTheDocument();

      // The retry owns the slot now; it also clears the timeout note.
      fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
      expect(mockStartOperator).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();
      expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();

      await act(async () => {
        rejectFirst(new ApiError("run-kit operator: fab not found on PATH", 502));
      });
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeDisabled();
      expect(screen.getByTestId("quake-terminal-start-operator")).toHaveTextContent("starting…");
      expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the timeout note is retired once the operator window appears and does not resurface when it later vanishes", async () => {
    vi.useFakeTimers();
    try {
      mockStartOperator.mockResolvedValue({ windowId: "@9", server: "srv1" });
      const view = render(quakeTree(["srv1"], operatorLess(["srv1"])));
      openDrawer();

      fireEvent.click(screen.getByTestId("quake-terminal-start-operator"));
      await act(async () => {
        vi.advanceTimersByTime(45_000);
      });
      expect(screen.getByTestId("quake-terminal-start-error")).toBeInTheDocument();

      // The operator was slow, not absent.
      view.rerender(quakeTree(["srv1"], new Map([["srv1", operatorSessions()]])));
      await act(async () => {});
      expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();

      view.rerender(quakeTree(["srv1"], operatorLess(["srv1"])));
      await act(async () => {});
      expect(screen.getByTestId("quake-terminal-start-operator")).toBeEnabled();
      expect(screen.queryByTestId("quake-terminal-start-error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("one Esc releases the machine: open → rest", async () => {
    renderQuake();
    openDrawer();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("stays mounted with the raised class through the exit slide", async () => {
    renderQuake();
    openDrawer();
    await screen.findByTestId("quake-terminal");

    fireEvent.keyDown(document, { key: "Escape" });
    const el = screen.getByTestId("quake-terminal");
    expect(el.className).toContain("rk-quake-slide");
    expect(el.className).toContain("rk-quake-closed");

    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("reduced motion closes instantly — no mounted-through-exit delay", () => {
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    renderQuake();
    openDrawer();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
  });

  it("a click outside the quake terminal's DOM collapses the open drawer to rest", async () => {
    renderQuake();
    openDrawer();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    fireEvent.click(document.body);
    // The collapse is deferred past a settle timeout — not synchronous.
    await waitFor(() => expect(getQuakeMachineState()).toBe("rest"));
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("pinned, a click outside leaves the drawer open; unpinned again, it collapses", async () => {
    renderQuake();
    openDrawer();
    fireEvent.click(screen.getByTestId("quake-terminal-pin"));

    // The outside-click listener is not attached while pinned — no collapse,
    // not even after the settle window.
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 10));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quake-terminal-pin"));
    fireEvent.click(document.body);
    await waitFor(() => expect(getQuakeMachineState()).toBe("rest"));
  });

  it("the pin button toggles aria-pressed and its accent latch", () => {
    renderQuake();
    openDrawer();

    const pin = screen.getByTestId("quake-terminal-pin");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveAttribute("aria-label", "Pin quake terminal");

    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).toHaveAttribute("aria-label", "Unpin quake terminal");
    expect(pin.className).toContain("text-accent-green");

    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin.className).not.toContain("text-accent-green");
  });

  it("the chord and the ▼ button still collapse a pinned drawer, and the pin resets on re-open", () => {
    // Reduced motion so each close is instant — no exit-slide wait.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    renderQuake();
    openDrawer();
    fireEvent.click(screen.getByTestId("quake-terminal-pin"));

    fireEvent.click(screen.getByRole("button", { name: "Collapse quake terminal" }));
    expect(getQuakeMachineState()).toBe("rest");
    expect(screen.queryByTestId("quake-terminal")).toBeNull();

    // Every open starts unpinned.
    openDrawer();
    expect(screen.getByTestId("quake-terminal-pin")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("quake-terminal-pin"));
    stepMachine();
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("a click inside the drawer does not collapse it", async () => {
    renderQuake();
    openDrawer();
    const drawer = screen.getByTestId("quake-terminal");

    fireEvent.click(drawer);
    await new Promise((r) => setTimeout(r, 10));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
  });

  it("a real DOM click on an outside trigger that re-opens/retargets the quake terminal wins over the outside-click collapse", async () => {
    renderQuake();
    openDrawer();

    function RetargetButton() {
      return (
        <button
          type="button"
          onClick={() => requestQuakeTerminal({ action: "open", server: "srv1" })}
        >
          retarget
        </button>
      );
    }
    render(<RetargetButton />);
    fireEvent.click(screen.getByRole("button", { name: "retarget" }));

    // The trigger's own click handler re-asserts "open" (bumping machine
    // activity even though the value is unchanged) during the SAME click's
    // bubble phase, which the outside-collapse's capture-phase snapshot ran
    // ahead of — the deferred settle check sees activity moved and backs off.
    await new Promise((r) => setTimeout(r, 10));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
  });

  it("a click that opens an unrelated dialog does not collapse the quake terminal", async () => {
    renderQuake();
    openDrawer();

    function DialogTrigger() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
          {open && (
            <div role="dialog" data-testid="fake-settings-dialog">
              settings
            </div>
          )}
        </>
      );
    }
    render(<DialogTrigger />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    // The dialog mounts (React commits) before the settle timeout fires;
    // the settle check finds it and skips the collapse.
    await screen.findByTestId("fake-settings-dialog");
    await new Promise((r) => setTimeout(r, 10));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
  });

  it("the docked compose strip renders only while the machine is open", async () => {
    renderQuake();
    expect(screen.queryByTestId("quake-terminal-compose")).toBeNull();

    openDrawer();
    const strip = await screen.findByTestId("quake-terminal-compose");
    const drawer = screen.getByTestId("quake-terminal");
    expect(drawer).toContainElement(strip);
    // Header row (addressee label + hints) and the textarea.
    expect(within(strip).getByText("→ operator")).toBeInTheDocument();
    expect(
      within(strip).getByText("Enter sends · ⇧Enter newline · Esc back to terminal"),
    ).toBeInTheDocument();
    expect(within(strip).getByTestId("quake-terminal-compose-input")).toBeInTheDocument();

    // Rest → no strip (reduced motion skips the mounted-through-exit slide).
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quake-terminal-compose")).toBeNull());
  });

  it("targets the route's server on a terminal route (no picker)", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();

    expect(screen.queryByRole("combobox", { name: "Operator server" })).toBeNull();
    expect(terminalMounts[0]).toMatchObject({ server: "srv1", windowId: "@9", sessionName: "_rk-operator" });
  });

  it("preselects the sole server on the Host route without a picker", () => {
    renderQuake();
    openDrawer();

    expect(screen.queryByRole("combobox", { name: "Operator server" })).toBeNull();
    expect(terminalMounts[0]?.server).toBe("srv1");
  });

  it("offers a server picker on the Host route with multiple servers and retargets on change", () => {
    renderQuake({
      servers: ["a", "b", "c"],
      sessionsByServer: new Map([
        ["a", operatorSessions()],
        ["b", operatorSessions([win({ windowId: "@7", name: "operator-b", role: "operator" })])],
        ["c", []],
      ]),
    });
    openDrawer();

    const picker = screen.getByRole("combobox", { name: "Operator server" });
    expect(picker).toHaveValue("a");

    fireEvent.change(picker, { target: { value: "b" } });
    const last = terminalMounts[terminalMounts.length - 1];
    expect(last).toMatchObject({ server: "b", windowId: "@7" });
  });

  it("renders the hint line (no stream) when the resolved server has no operator; the strip's Enter sends nothing", () => {
    renderQuake({ sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]) });
    openDrawer();

    expect(screen.getByTestId("quake-terminal-empty")).toHaveTextContent(
      "no operator on this server — run rk operator",
    );
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();

    const textarea = screen.getByTestId("quake-terminal-compose-input");
    fireEvent.change(textarea, { target: { value: "anyone home?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
  });

  it("the cron segments render on an operator-less server — only Operator Terminal needs the operator", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockCronData.current = {
      entries: [
        {
          id: "a3f9",
          name: "nightly",
          target: { kind: "role", role: "operator" },
          payload: "ping",
          schedule: { kind: "every", interval: "5m" },
          lastFired: 0,
          nextFire: nowSec + 300,
        },
      ],
      deliveries: [
        { ts: nowSec - 60, entry: "a3f9", name: "nightly", target: "role:operator", reason: "due", outcome: "delivered" },
      ],
    };
    renderQuake({ sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]) });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });
    expect(screen.getByTestId("cron-list")).toBeInTheDocument();
    expect(screen.getByTestId("cron-list-row-a3f9")).toBeInTheDocument();
    expect(screen.queryByTestId("quake-terminal-empty")).toBeNull();
    expect(terminalMounts).toHaveLength(0);

    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });
    expect(screen.getByTestId("cron-log")).toBeInTheDocument();
    expect(screen.queryByTestId("quake-terminal-empty")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Operator Terminal" }));
    expect(screen.getByTestId("quake-terminal-empty")).toBeInTheDocument();
    expect(screen.getByTestId("quake-terminal-start-operator")).toBeInTheDocument();
    expect(screen.queryByTestId("cron-list")).toBeNull();
    mockCronData.current = { entries: [], deliveries: [] };
  });

  it("opens without crashing on an empty (still-loading) server list", () => {
    renderQuake({ servers: [], sessionsByServer: new Map() });
    openDrawer();

    expect(screen.getByTestId("quake-terminal-empty")).toBeInTheDocument();
    expect(terminalMounts).toHaveLength(0);
  });

  it("renders the operator window's live agent state in the header row's meta cluster", () => {
    renderQuake({
      sessionsByServer: new Map([
        [
          "srv1",
          [
            { name: "main", windows: [] },
            {
              name: "_rk-operator",
              hidden: true,
              windows: [win({ windowId: "@9", name: "operator", role: "operator", agentState: "waiting", agentIdleDuration: "2m" })],
            },
          ],
        ],
      ]),
    });
    openDrawer();

    const header = screen.getByTestId("quake-terminal-header");
    expect(within(header).getByTestId("quake-terminal-state")).toHaveTextContent("waiting 2m");
  });

  it("an active operator window with a duration renders the state alone — the duration is rest-states-only", () => {
    renderQuake({
      sessionsByServer: new Map([
        [
          "srv1",
          [
            { name: "main", windows: [] },
            {
              name: "_rk-operator",
              hidden: true,
              windows: [win({ windowId: "@9", name: "operator", role: "operator", agentState: "active", agentIdleDuration: "12m" })],
            },
          ],
        ],
      ]),
    });
    openDrawer();

    const header = screen.getByTestId("quake-terminal-header");
    const state = within(header).getByTestId("quake-terminal-state");
    expect(state).toHaveTextContent("active");
    expect(state).not.toHaveTextContent("12m");
  });

  it("the palette fallback request opens the quake terminal and sends the query immediately", async () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", send: "find the stuck deploy" });
    });

    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "find the stuck deploy", "submit", "agent");
  });

  it("a fallback send against an operator-less server is dropped (the hint is the answer)", async () => {
    renderQuake({ sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]) });
    act(() => {
      requestQuakeTerminal({ action: "open", send: "anything at all" });
    });

    expect(screen.getByTestId("quake-terminal-empty")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a failed fallback send renders the error inside the docked compose strip, never at the top edge", async () => {
    mockSend.mockRejectedValue(new Error("probe failed: no novelty echo"));
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", send: "retry me" });
    });

    await waitFor(() =>
      expect(screen.getByTestId("quake-terminal-error")).toHaveTextContent("probe failed: no novelty echo"),
    );
    // The status has exactly one home: the strip's first row. The drawer's
    // first row is the header — nothing renders at the top edge.
    const strip = screen.getByTestId("quake-terminal-compose");
    expect(strip).toContainElement(screen.getByTestId("quake-terminal-error"));
    expect(screen.getByTestId("quake-terminal").firstElementChild).toBe(
      screen.getByTestId("quake-terminal-header"),
    );
  });

  it("a fallback send fired in the same commit as a re-open reads the post-reset chip state", async () => {
    // Reduced motion so the close is instant — the send below must not wait
    // out an exit slide.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();

    // Dismiss, then close — the dismissal is still live store state here.
    act(() => dismissOperatorChatChip());
    act(() => setQuakeMachineState("rest"));
    expect(screen.queryByTestId("quake-terminal")).toBeNull();

    // Re-open via the Ask-operator fallback: the reset effect and the
    // pendingSend delivery land in the same commit — the send must read the
    // post-reset store, riding the templated lane.
    act(() => {
      requestQuakeTerminal({ action: "open", send: "still broken" });
    });

    await waitFor(() => expect(mockOperatorRequest).toHaveBeenCalledTimes(1));
    expect(mockOperatorRequest).toHaveBeenCalledWith("srv1", "@1", "user-message", "still broken");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a desktop→mobile viewport flip resets the machine to rest and unmounts the drawer", async () => {
    // A controllable MQL (the shared stub's listeners are fire-and-forget):
    // flip `matches` and fire the change listeners to simulate the resize.
    const listeners = new Set<() => void>();
    const mql = {
      matches: false,
      media: "",
      onchange: null,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: (fn: () => void) => listeners.add(fn),
      removeListener: (fn: () => void) => listeners.delete(fn),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => mql));
    renderQuake();
    openDrawer();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    act(() => {
      mql.matches = true;
      for (const fn of [...listeners]) fn();
    });

    expect(getQuakeMachineState()).toBe("rest");
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
  });

  it("applies the glass background at the stored opacity and drops the blur at α=1", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    expect(el.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-primary) 95%");
    expect(el.style.backdropFilter).toBe("blur(6px)");

    act(() => writeQuakeOpacity(1));
    expect(el.style.backdropFilter).toBe("");
    expect(el.style.backgroundColor).toContain("100%");
  });

  const storedGeometry = () => JSON.parse(localStorage.getItem("hexokit-quake-terminal-geometry")!);

  it("dragging the bottom grip resizes only the height and persists the geometry on release", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");
    expect(el.style.height).toBe("55vh");
    expect(el.style.left).toBe("calc(50% + 0px)");

    const grip = screen.getByTestId("quake-terminal-grip-bottom");
    // A full-viewport drag overshoots the clamp: the height pins at 85vh.
    fireEvent.pointerDown(grip, { button: 0, clientX: 100, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 100, clientY: 300 + window.innerHeight, pointerId: 1 });
    expect(el.style.height).toBe("85vh");
    expect(el.style.width).toBe("760px");
    expect(el.className).toContain("rk-quake-dragging");
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(el.className).not.toContain("rk-quake-dragging");
    expect(storedGeometry()).toEqual({ heightVh: 85, widthPx: 760, centerOffsetPx: 0 });
  });

  it("the tongue tab inside the bottom grip is a valid height grab", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const tab = screen.getByTestId("quake-terminal-tongue-tab");
    expect(screen.getByTestId("quake-terminal-grip-bottom")).toContainElement(tab);
    // 25% of the viewport height: 55vh → 80vh.
    fireEvent.pointerDown(tab, { button: 0, clientX: 100, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(tab, { clientX: 100, clientY: 300 + window.innerHeight / 4, pointerId: 1 });
    expect(el.style.height).toBe("80vh");
    fireEvent.pointerUp(tab, { pointerId: 1 });
    expect(storedGeometry()).toMatchObject({ heightVh: 80 });
    expect(screen.queryByTestId("quake-terminal-grip-height")).toBeNull();
  });

  it("dragging the right grip moves only the right edge: width +dx, center +dx/2", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const grip = screen.getByTestId("quake-terminal-grip-right");
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 600, clientY: 100, pointerId: 1 });
    // +100px on the right edge: the drawer grows by 100 and its center shifts
    // by 50, so the left edge (center − width/2) stays where it was.
    expect(el.style.width).toBe("860px");
    expect(el.style.left).toBe("calc(50% + 50px)");
    expect(el.style.height).toBe("55vh");
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(storedGeometry()).toEqual({ heightVh: 55, widthPx: 860, centerOffsetPx: 50 });
  });

  it("dragging the left grip outward mirrors: width +|dx|, center −|dx|/2", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const grip = screen.getByTestId("quake-terminal-grip-left");
    fireEvent.pointerDown(grip, { button: 0, clientX: 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(el.style.width).toBe("860px");
    // jsdom normalizes `+ -50px` to `- 50px`.
    expect(el.style.left).toBe("calc(50% - 50px)");
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(storedGeometry()).toEqual({ heightVh: 55, widthPx: 860, centerOffsetPx: -50 });
  });

  it("dragging the bottom-right corner resizes both axes in one drag", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const grip = screen.getByTestId("quake-terminal-grip-bottom-right");
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, {
      clientX: 600,
      clientY: 300 + window.innerHeight / 4,
      pointerId: 1,
    });
    expect(el.style.width).toBe("860px");
    expect(el.style.left).toBe("calc(50% + 50px)");
    expect(el.style.height).toBe("80vh");
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(storedGeometry()).toEqual({ heightVh: 80, widthPx: 860, centerOffsetPx: 50 });
  });

  it("the center offset is clamped so the drawer keeps its edge pad inside the viewport", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    // jsdom's viewport is 1024px: dragging the right edge far out pins the width
    // at 96vw (983px) and the offset at round((1024 − 983) / 2 − 8) = 13.
    const grip = screen.getByTestId("quake-terminal-grip-right");
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 5000, clientY: 100, pointerId: 1 });
    expect(el.style.width).toBe("983px");
    expect(el.style.left).toBe("calc(50% + 13px)");
    fireEvent.pointerUp(grip, { pointerId: 1 });
  });

  it("hovering a corner lights both adjacent edge grips and nothing else", async () => {
    renderQuake();
    openDrawer();
    await screen.findByTestId("quake-terminal");
    const left = screen.getByTestId("quake-terminal-grip-left");
    const right = screen.getByTestId("quake-terminal-grip-right");
    const bottom = screen.getByTestId("quake-terminal-grip-bottom");

    fireEvent.pointerEnter(screen.getByTestId("quake-terminal-grip-bottom-right"));
    expect(right).toHaveAttribute("data-lit");
    expect(bottom).toHaveAttribute("data-lit");
    expect(left).not.toHaveAttribute("data-lit");
    expect(right.className).toContain("rk-quake-grip-lit");

    fireEvent.pointerLeave(screen.getByTestId("quake-terminal-grip-bottom-right"));
    expect(right).not.toHaveAttribute("data-lit");
    expect(bottom).not.toHaveAttribute("data-lit");

    // A single edge lights only itself.
    fireEvent.pointerEnter(left);
    expect(left).toHaveAttribute("data-lit");
    expect(bottom).not.toHaveAttribute("data-lit");
  });

  it("an active drag keeps its edge lit even after the pointer leaves the grip", async () => {
    renderQuake();
    openDrawer();
    await screen.findByTestId("quake-terminal");
    const right = screen.getByTestId("quake-terminal-grip-right");

    fireEvent.pointerEnter(right);
    fireEvent.pointerDown(right, { button: 0, clientX: 500, clientY: 100, pointerId: 1 });
    fireEvent.pointerLeave(right);
    expect(right).toHaveAttribute("data-lit");
    fireEvent.pointerUp(right, { pointerId: 1 });
    expect(right).not.toHaveAttribute("data-lit");
  });

  it("a second pointer cannot hijack or end a live drag", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const grip = screen.getByTestId("quake-terminal-grip-right");
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 100, pointerId: 1 });
    // A second finger lands on the grip: its down, move, and up are ignored.
    fireEvent.pointerDown(grip, { button: 0, clientX: 900, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(grip, { clientX: 1000, clientY: 100, pointerId: 2 });
    expect(el.style.width).toBe("760px");
    fireEvent.pointerUp(grip, { pointerId: 2 });
    expect(el.className).toContain("rk-quake-dragging");
    expect(localStorage.getItem("hexokit-quake-terminal-geometry")).toBeNull();

    // The first pointer still owns the drag.
    fireEvent.pointerMove(grip, { clientX: 540, clientY: 100, pointerId: 1 });
    expect(el.style.width).toBe("800px");
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(el.className).not.toContain("rk-quake-dragging");
    expect(storedGeometry()).toMatchObject({ widthPx: 800, centerOffsetPx: 20 });
  });

  it("pointercancel ends a drag through the same release path", async () => {
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");

    const grip = screen.getByTestId("quake-terminal-grip-right");
    fireEvent.pointerDown(grip, { button: 0, clientX: 500, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 540, clientY: 100, pointerId: 1 });
    expect(el.className).toContain("rk-quake-dragging");
    fireEvent.pointerCancel(grip, { pointerId: 1 });

    expect(el.className).not.toContain("rk-quake-dragging");
    expect(storedGeometry()).toMatchObject({ widthPx: 800, centerOffsetPx: 20 });
  });

  it("double-clicking any grip resets the geometry to the defaults", async () => {
    localStorage.setItem(
      "hexokit-quake-terminal-geometry",
      JSON.stringify({ heightVh: 70, widthPx: 900, centerOffsetPx: 40 }),
    );
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");
    expect(el.style.width).toBe("900px");
    expect(el.style.left).toBe("calc(50% + 40px)");

    fireEvent.doubleClick(screen.getByTestId("quake-terminal-grip-bottom-left"));

    expect(el.style.width).toBe("760px");
    expect(el.style.height).toBe("55vh");
    expect(el.style.left).toBe("calc(50% + 0px)");
    expect(storedGeometry()).toEqual({ heightVh: 55, widthPx: 760, centerOffsetPx: 0 });
  });

  it("a viewport resize re-clamps the displayed offset without writing the store", async () => {
    localStorage.setItem(
      "hexokit-quake-terminal-geometry",
      JSON.stringify({ heightVh: 55, widthPx: 760, centerOffsetPx: 100 }),
    );
    const originalWidth = window.innerWidth;
    renderQuake();
    openDrawer();
    const el = await screen.findByTestId("quake-terminal");
    expect(el.style.left).toBe("calc(50% + 100px)");

    try {
      // 900px viewport: the bound becomes (900 − 760) / 2 − 8 = 62.
      Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(el.style.left).toBe("calc(50% + 62px)");
      expect(storedGeometry()).toEqual({ heightVh: 55, widthPx: 760, centerOffsetPx: 100 });
    } finally {
      Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    }
  });

  it("file paste inside the drawer uploads to the operator session and insert-delivers the path", async () => {
    renderQuake();
    openDrawer();
    const root = await screen.findByTestId("quake-terminal");

    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(root, { clipboardData: { files: [file] } });

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload).toHaveBeenCalledWith("srv1", "_rk-operator", file, "@9");
    await waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "/tmp/op/.uploads/shot.png ", "raw", "agent"),
    );
  });

  it("file paste on an operator-less server is a no-op", async () => {
    renderQuake({ sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]) });
    openDrawer();
    const root = await screen.findByTestId("quake-terminal");

    fireEvent.paste(root, { clipboardData: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("an upload failure surfaces on the strip's inline error line and delivers nothing", async () => {
    mockUpload.mockRejectedValue(new Error("upload exploded"));
    renderQuake();
    openDrawer();
    const root = await screen.findByTestId("quake-terminal");

    fireEvent.paste(root, { clipboardData: { files: [new File(["x"], "a.png", { type: "image/png" })] } });

    await waitFor(() =>
      expect(screen.getByTestId("quake-terminal-error")).toHaveTextContent("upload exploded"),
    );
    expect(screen.getByTestId("quake-terminal-compose")).toContainElement(
      screen.getByTestId("quake-terminal-error"),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a file drop inside the drawer uploads to the operator session", async () => {
    renderQuake();
    openDrawer();
    const root = await screen.findByTestId("quake-terminal");

    const file = new File(["png"], "shot.png", { type: "image/png" });
    const proceeded = fireEvent.drop(root, { dataTransfer: { files: [file], types: ["Files"] } });

    expect(proceeded).toBe(false);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload).toHaveBeenCalledWith("srv1", "_rk-operator", file, "@9");
  });

  it("a non-file drop inside the drawer is canceled (no browser navigation) and uploads nothing", async () => {
    renderQuake();
    openDrawer();
    const root = await screen.findByTestId("quake-terminal");

    const proceeded = fireEvent.drop(root, { dataTransfer: { files: [], types: ["text/uri-list"] } });

    expect(proceeded).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe("QuakeTerminal (docked compose)", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("entering open focuses the docked textarea, caret at the end of any draft", () => {
    renderQuake();
    act(() => setOperatorComposeText("srv1", OPERATOR_TARGET, "half-written"));

    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input") as HTMLTextAreaElement;
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("half-written");
    expect(textarea.selectionStart).toBe("half-written".length);
  });

  it("the docked draft is per server — switching the picker shows the other operator's empty box and back", () => {
    render(
      quakeTree(
        ["a", "b"],
        new Map([
          ["a", operatorSessions()],
          ["b", operatorSessions()],
        ]),
      ),
    );
    openDrawer();
    const textarea = () => screen.getByTestId("quake-terminal-compose-input");
    fireEvent.change(textarea(), { target: { value: "for a" } });
    expect(textarea()).toHaveValue("for a");

    const picker = screen.getByRole("combobox", { name: "Operator server" });
    fireEvent.change(picker, { target: { value: "b" } });
    expect(textarea()).toHaveValue("");
    expect(textarea()).not.toHaveAttribute("readonly");

    fireEvent.change(picker, { target: { value: "a" } });
    expect(textarea()).toHaveValue("for a");
  });

  it("with no operator on the server the docked textarea is read-only, still focusable, and says so", () => {
    render(quakeTree(["a"], operatorLess(["a"])));
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");
    expect(textarea).toHaveAttribute("readonly");
    expect(textarea).toHaveAttribute("placeholder", "Start the operator to compose…");
    expect(textarea).toHaveFocus();
    fireEvent.change(textarea, { target: { value: "typed into the void" } });
    expect(textarea).toHaveValue("");
    // The local-newline chord must not reach the caret insert either — it
    // would mutate the DOM behind the empty store.
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(textarea).toHaveValue("");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
  });

  it("on rest the origin regains focus only while the docked textarea still holds it", () => {
    const prior = document.createElement("button");
    document.body.appendChild(prior);
    prior.focus();
    renderQuake();
    // The launcher's entry capture (not mounted here) — the slot is the seam.
    act(() => setQuakeRestoreOrigin(prior));
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");
    expect(textarea).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    expect(prior).toHaveFocus();
    prior.remove();
  });

  it("no focus restore when focus already left the compose before the collapse", () => {
    const prior = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(prior, other);
    renderQuake();
    act(() => setQuakeRestoreOrigin(prior));
    openDrawer();
    // The user moved focus elsewhere before releasing — the release already
    // has its owner.
    act(() => other.focus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    expect(other).toHaveFocus();
    expect(prior).not.toHaveFocus();
    prior.remove();
    other.remove();
  });

  it("Enter in the docked compose sends once, clears the draft, and keeps focus", async () => {
    renderQuake();
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    fireEvent.change(textarea, { target: { value: "Is peui done?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "Is peui done?", "submit", "agent");
    await waitFor(() => expect(textarea).toHaveValue(""));
    expect(textarea).toHaveFocus();
    expect(getQuakeMachineState()).toBe("open");
  });

  it("⇧Enter in the docked compose inserts a newline without sending", () => {
    renderQuake();
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line one" } });
    textarea.setSelectionRange("line one".length, "line one".length);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\n");
  });

  it("Enter on an empty draft is a no-op (no send, no state change)", () => {
    renderQuake();
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
    expect(getQuakeMachineState()).toBe("open");
  });

  it("Esc in the docked compose yields to the terminal first on the terminal segment; the next Esc collapses", async () => {
    renderQuake();
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    // First rung: consumed by the strip (the mocked TerminalClient wires a
    // no-op focus handle — the yield fires, focus itself goes nowhere).
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("Esc in the docked compose with no embedded terminal (operator-less) collapses on the first press", async () => {
    renderQuake({ sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]) });
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("Esc in the docked compose on the Cron List segment collapses on the first press", async () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });

  it("one header row carries segments, meta, pin, and ▼ — no ◉ OPERATOR title strip", () => {
    renderQuake();
    openDrawer();
    const drawer = screen.getByTestId("quake-terminal");
    const header = screen.getByTestId("quake-terminal-header");

    expect(drawer.firstElementChild).toBe(header);
    expect(drawer.querySelectorAll('[data-testid="quake-terminal-header"]')).toHaveLength(1);
    expect(within(header).getByTestId("terminal-activity-tabs")).toBeInTheDocument();
    expect(within(header).getByText("srv1")).toBeInTheDocument();
    expect(within(header).getByTestId("quake-terminal-pin")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Collapse quake terminal" })).toBeInTheDocument();
    expect(screen.queryByText("◉ OPERATOR")).toBeNull();
  });

  it("the engaged accent border follows real focus into and out of the docked textarea", () => {
    renderQuake();
    openDrawer();
    const textarea = screen.getByTestId("quake-terminal-compose-input");

    // Focus-on-open engaged the strip.
    expect(textarea).toHaveFocus();
    expect(textarea.className).toContain("border-accent-green");

    fireEvent.blur(textarea);
    expect(textarea.className).toContain("border-border");
    expect(textarea.className).not.toContain("border-accent-green");

    fireEvent.focus(textarea);
    expect(textarea.className).toContain("border-accent-green");
  });

  it("a blur toward the context chip's ✕ keeps the compose engaged so the dismiss click lands", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();
    const strip = screen.getByTestId("quake-terminal-compose");
    const textarea = within(strip).getByTestId("quake-terminal-compose-input");
    const dismiss = within(strip).getByRole("button", { name: "Detach window context" });

    // The real dismissal sequence: focus leaves the textarea FOR the ✕, then
    // the click lands. If that blur stood the engaged flag down, the accent
    // would drop mid-gesture.
    fireEvent.blur(textarea, { relatedTarget: dismiss });
    expect(textarea.className).toContain("border-accent-green");
    fireEvent.click(dismiss);
    expect(within(strip).queryByTestId("quake-terminal-context")).toBeNull();
  });

  it("on a terminal route the strip shows the chip and Enter rides the templated chat lane", async () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();
    const strip = screen.getByTestId("quake-terminal-compose");
    expect(within(strip).getByTestId("quake-terminal-context")).toHaveTextContent('from: @1 "win"');

    const textarea = within(strip).getByTestId("quake-terminal-compose-input");
    fireEvent.change(textarea, { target: { value: "can you check the failing test?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockOperatorRequest).toHaveBeenCalledTimes(1));
    expect(mockOperatorRequest).toHaveBeenCalledWith("srv1", "@1", "user-message", "can you check the failing test?");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("dismissing the chip drops the envelope — the next send rides the direct lane", async () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();
    const strip = screen.getByTestId("quake-terminal-compose");
    fireEvent.click(within(strip).getByRole("button", { name: "Detach window context" }));
    expect(within(strip).queryByTestId("quake-terminal-context")).toBeNull();

    const textarea = within(strip).getByTestId("quake-terminal-compose-input");
    fireEvent.change(textarea, { target: { value: "plain message" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "plain message", "submit", "agent");
    expect(mockOperatorRequest).not.toHaveBeenCalled();
  });

  it("the strip mounts the compact chip — no fine-pointer size floor on the dismiss button", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();
    const strip = screen.getByTestId("quake-terminal-compose");

    const dismiss = within(strip).getByRole("button", { name: "Detach window context" });
    // The compact mount drops the 24px fine-pointer floor; the coarse (touch)
    // floor is untouched.
    expect(dismiss.className).not.toContain("min-h-[24px]");
    expect(dismiss.className).not.toContain("min-w-[24px]");
    expect(dismiss.className).toContain("coarse:min-h-[40px]");
    expect(dismiss.className).toContain("coarse:min-w-[40px]");
  });

  it("the chip resets to attached when the quake terminal re-engages", async () => {
    // Reduced motion so the exit is instant — no exit-slide wait.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    openDrawer();
    const strip = screen.getByTestId("quake-terminal-compose");
    fireEvent.click(within(strip).getByRole("button", { name: "Detach window context" }));
    expect(within(strip).queryByTestId("quake-terminal-context")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
    openDrawer();
    expect(
      within(screen.getByTestId("quake-terminal-compose")).getByTestId("quake-terminal-context"),
    ).toBeInTheDocument();
  });
});

describe("QuakeTerminal (cron segments)", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
    mockCronData.current = { entries: [], deliveries: [] };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function listTab() {
    return within(screen.getByTestId("terminal-activity-tabs")).getByRole("tab", { name: "Cron List" });
  }
  function logTab() {
    return within(screen.getByTestId("terminal-activity-tabs")).getByRole("tab", { name: "Cron Log" });
  }
  function terminalTab() {
    return within(screen.getByTestId("terminal-activity-tabs")).getByRole("tab", { name: "Operator Terminal" });
  }

  it("the desktop drawer renders the four segments in order with Operator Terminal selected", () => {
    renderQuake();
    openDrawer();

    const strip = screen.getByTestId("terminal-activity-tabs");
    expect(strip).toHaveAttribute("role", "tablist");
    expect(within(strip).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Operator Terminal",
      "Operator Tasks",
      "Cron List",
      "Cron Log",
    ]);
    expect(terminalTab()).toHaveAttribute("aria-selected", "true");
    expect(listTab()).toHaveAttribute("aria-selected", "false");
    expect(logTab()).toHaveAttribute("aria-selected", "false");
  });

  it("selecting a cron tab mounts its body and unmounts the terminal; Operator Terminal reverses it", () => {
    renderQuake();
    openDrawer();
    expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();

    fireEvent.click(listTab());
    expect(screen.getByTestId("cron-list")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();

    fireEvent.click(logTab());
    expect(screen.getByTestId("cron-log")).toBeInTheDocument();
    expect(screen.queryByTestId("cron-list")).toBeNull();

    fireEvent.click(terminalTab());
    expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("cron-log")).toBeNull();
  });

  it("an open request carrying segment: log opens the drawer on the Cron Log segment", () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });

    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(logTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cron-log")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
  });

  it("an open request carrying segment: list opens the drawer on the Cron List segment", () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });

    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(listTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cron-list")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
  });

  it("segment: log on the operator route writes ?tab=log in place and never opens the drawer", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    renderQuake({ withToasts: true });

    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });

    expect(getQuakeMachineState()).toBe("rest");
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: ".",
      search: expect.any(Function),
      replace: true,
    });
    const call = mockNavigate.mock.calls[0]?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ from: "@1" })).toEqual({ from: "@1", tab: "log" });
  });

  it("Escape inside the inline entry sheet returns to the list without collapsing the drawer", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockCronData.current = {
      entries: [
        {
          id: "a3f9",
          name: "operator tick",
          schedule: { kind: "backoff", min: "60s", max: "30m" },
          target: { kind: "role", role: "operator" },
          payload: "tick",
          lastFired: 0,
          muted: false,
          pinned: false,
          nextFire: nowSec + 300,
        },
      ],
      deliveries: [],
    };
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });

    fireEvent.click(screen.getByTestId("cron-list-row-a3f9"));
    expect(screen.getByTestId("cron-entry-sheet")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("cron-entry-sheet")).toBeNull();
    expect(screen.getByTestId("cron-list")).toBeInTheDocument();
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(getQuakeMachineState()).toBe("open");
  });

  it("closing the drawer and re-opening with a plain request resets to the Operator Terminal segment", async () => {
    // Reduced motion so the close is instant — no exit-slide wait.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });
    expect(logTab()).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());

    openDrawer();
    expect(terminalTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("cron-log")).toBeNull();
  });

  it("the header row carries the tick-age stamp from the first session with operatorLastTickAt > 0", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    renderQuake({
      sessionsByServer: new Map([
        [
          "srv1",
          [
            { name: "main", windows: [win({})], operatorLastTickAt: nowSec - 90 },
            { name: "_rk-operator", windows: [OPERATOR_WINDOW], hidden: true },
          ],
        ],
      ]),
    });
    openDrawer();

    const tick = screen.getByTestId("quake-terminal-tick");
    expect(tick).toHaveTextContent("· tick 1m ago");
    expect(tick.className).toContain("text-text-secondary");
  });

  it("a stale operator loop renders the tick stamp yellow with the ⚠ prefix", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    renderQuake({
      sessionsByServer: new Map([
        [
          "srv1",
          [
            { name: "main", windows: [win({})], operatorLastTickAt: nowSec - 120, operatorStale: true },
            { name: "_rk-operator", windows: [OPERATOR_WINDOW], hidden: true },
          ],
        ],
      ]),
    });
    openDrawer();

    const tick = screen.getByTestId("quake-terminal-tick");
    expect(tick).toHaveTextContent("⚠ · tick 2m ago");
    expect(tick.className).toContain("text-signal-yellow");
  });

  it("no tick stamp renders when no session carries operatorLastTickAt > 0", () => {
    renderQuake({
      sessionsByServer: new Map([
        [
          "srv1",
          [
            { name: "main", windows: [win({})], operatorLastTickAt: 0 },
            { name: "_rk-operator", windows: [OPERATOR_WINDOW], hidden: true },
          ],
        ],
      ]),
    });
    openDrawer();

    expect(screen.queryByTestId("quake-terminal-tick")).toBeNull();
  });
});

describe("QuakeTerminal (tasks segment)", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function tasksTab() {
    return within(screen.getByTestId("terminal-activity-tabs")).getByRole("tab", { name: "Operator Tasks" });
  }
  function terminalTab() {
    return within(screen.getByTestId("terminal-activity-tabs")).getByRole("tab", { name: "Operator Terminal" });
  }

  const WATCHED_SESSIONS: ProjectSession[] = [
    {
      name: "main",
      windows: [
        win({ windowId: "@1" }),
        win({
          windowId: "@2",
          name: "worker",
          monitored: true,
          monitoredChange: "wuiu",
          monitoredStage: "review",
          monitoredRepo: "/home/user/code/run-kit",
          agentState: "waiting",
          agentIdleDuration: "6m",
        }),
      ],
    },
    { name: "_rk-operator", windows: [OPERATOR_WINDOW], hidden: true },
  ];

  it("selecting Operator Tasks mounts the watchlist and unmounts the terminal; Operator Terminal reverses it", () => {
    renderQuake({ sessionsByServer: new Map([["srv1", WATCHED_SESSIONS]]) });
    openDrawer();
    expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();

    fireEvent.click(tasksTab());
    expect(screen.getByTestId("watched-tasks")).toBeInTheDocument();
    expect(screen.getAllByTestId("watched-row")).toHaveLength(1);
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();

    fireEvent.click(terminalTab());
    expect(screen.getByTestId("embedded-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("watched-tasks")).toBeNull();
  });

  it("an open request carrying segment: tasks opens the drawer on the Operator Tasks segment", () => {
    renderQuake({ sessionsByServer: new Map([["srv1", WATCHED_SESSIONS]]) });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });

    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(tasksTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("watched-tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
  });

  it("segment: tasks on the operator route writes ?tab=tasks in place and never opens the drawer", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    renderQuake({ withToasts: true });

    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });

    expect(getQuakeMachineState()).toBe("rest");
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: ".",
      search: expect.any(Function),
      replace: true,
    });
    const call = mockNavigate.mock.calls[0]?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({})).toEqual({ tab: "tasks" });
  });

  it("closing the drawer and re-opening with a plain request resets to the Operator Terminal segment", async () => {
    // Reduced motion so the close is instant — no exit-slide wait.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });
    expect(tasksTab()).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());

    openDrawer();
    expect(terminalTab()).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("watched-tasks")).toBeNull();
  });

  it("a watched-row click navigates to the window's terminal route and collapses the drawer", async () => {
    renderQuake({ sessionsByServer: new Map([["srv1", WATCHED_SESSIONS]]) });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });
    expect(screen.getByTestId("watched-tasks")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("watched-row-navigate"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@2" },
      search: {},
    });
    expect(getQuakeMachineState()).toBe("rest");
    await waitFor(() => expect(screen.queryByTestId("quake-terminal")).toBeNull());
  });
});

describe("QuakeTerminal (mobile navigation)", () => {
  beforeEach(() => {
    stubMatchMedia(() => true);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a quake terminal request navigates to the operator window's terminal route — no sheet mounts", () => {
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: {},
    });
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("both actions collapse to the same navigation", () => {
    renderQuake();
    for (const action of ["toggle", "open"] as const) {
      act(() => {
        requestQuakeTerminal({ action });
      });
    }

    expect(mockNavigate).toHaveBeenCalledTimes(2);
    for (const call of mockNavigate.mock.calls) {
      expect(call[0]).toMatchObject({ params: { server: "srv1", window: "@9" }, search: {} });
    }
  });

  it("navigating from a terminal route carries the origin window as ?from=", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "toggle" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { from: "@1" },
    });
  });

  it("already on the operator route, re-activation is a true no-op — the existing ?from= survives", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@1" };
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "toggle" });
    });

    // No navigate: a replace would have dropped the route's `?from=` (and
    // with it the context chip).
    expect(mockNavigate).not.toHaveBeenCalled();

    // A fallback query still seeds the draft without navigating.
    act(() => {
      requestQuakeTerminal({ action: "open", send: "still broken" });
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(getComposeDraft("srv1:@9").text).toBe("still broken");
  });

  it("an explicit server request navigates to that server's operator route", () => {
    renderQuake({
      servers: ["srv1", "srv2"],
      sessionsByServer: new Map([
        ["srv1", operatorSessions()],
        [
          "srv2",
          [
            { name: "main", windows: [win({ windowId: "@1" })] },
            { name: "_rk-operator", hidden: true, windows: [win({ windowId: "@7", name: "operator-b", role: "operator" })] },
          ],
        ],
      ]),
    });
    act(() => {
      requestQuakeTerminal({ action: "open", server: "srv2" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv2", window: "@7" },
      search: {},
    });
  });

  it("the palette fallback query seeds the operator route's compose draft instead of auto-sending", async () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", send: "find the stuck deploy" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { from: "@1" },
    });
    expect(getComposeDraft("srv1:@9").text).toBe("find the stuck deploy");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockOperatorRequest).not.toHaveBeenCalled();
  });

  it("a segment: list request navigates with search.tab = list, merged with the ?from= origin", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { from: "@1", tab: "list" },
    });
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
  });

  it("already on the operator route, segment: log updates the tab search param in place", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@1" };
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "log" });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const call = mockNavigate.mock.calls[0][0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(call.to).toBe(".");
    expect(call.replace).toBe(true);
    // The updater merges over the existing search — the ?from= survives.
    expect(call.search({ from: "@1" })).toEqual({ from: "@1", tab: "log" });
  });

  it("a segment: tasks request navigates with search.tab = tasks, merged with the ?from= origin", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { from: "@1", tab: "tasks" },
    });
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
  });

  it("already on the operator route, segment: tasks updates the tab search param in place", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@1" };
    renderQuake();
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const call = mockNavigate.mock.calls[0][0] as {
      to: string;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace: boolean;
    };
    expect(call.to).toBe(".");
    expect(call.replace).toBe(true);
    // The updater merges over the existing search — the ?from= survives.
    expect(call.search({ from: "@1" })).toEqual({ from: "@1", tab: "tasks" });
  });

  it("an operator-less server toasts the hint once and never navigates", () => {
    renderQuake({
      withToasts: true,
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]),
    });
    act(() => {
      requestQuakeTerminal({ action: "toggle" });
    });
    act(() => {
      requestQuakeTerminal({ action: "open" });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    // Repeated activations within one toast lifetime do not stack.
    expect(screen.getAllByText("no operator on this server — run rk operator")).toHaveLength(1);
  });

  it("a cron-segment request on an operator-less server navigates to the Server page's Cron section, no toast", () => {
    renderQuake({
      withToasts: true,
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]),
    });
    for (const segment of ["list", "log"] as const) {
      act(() => {
        requestQuakeTerminal({ action: "open", segment });
      });
    }

    expect(mockNavigate).toHaveBeenCalledTimes(2);
    for (const call of mockNavigate.mock.calls) {
      expect(call[0]).toEqual({ to: "/$server", params: { server: "srv1" }, hash: "cron" });
    }
    expect(screen.queryByText("no operator on this server — run rk operator")).toBeNull();
  });

  it("terminal and tasks requests on an operator-less server still toast and never navigate", () => {
    renderQuake({
      withToasts: true,
      sessionsByServer: new Map([["srv1", [{ name: "main", windows: [win({})] }]]]),
    });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "tasks" });
    });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "terminal" });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getAllByText("no operator on this server — run rk operator")).toHaveLength(1);
  });

  it("a cron-segment request with no resolvable server toasts and never navigates", () => {
    renderQuake({ withToasts: true, servers: [], sessionsByServer: new Map() });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getAllByText("no operator on this server — run rk operator")).toHaveLength(1);
  });

  it("a cron-segment request before the server's sessions have loaded toasts — an empty slice is not operator-less", () => {
    renderQuake({
      withToasts: true,
      sessionsByServer: new Map([["srv1", []]]),
      isConnectedByServer: new Map([["srv1", false]]),
    });
    act(() => {
      requestQuakeTerminal({ action: "open", segment: "list" });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getAllByText("no operator on this server — run rk operator")).toHaveLength(1);
  });
});

describe("QuakeTerminalTongue", () => {
  beforeEach(() => {
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    mockHistoryBack.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderTongue(sessions: ProjectSession[] = operatorSessions()) {
    return render(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", sessions]]),
        }}
      >
        <QuakeTerminal />
        <QuakeTerminalTongue />
      </StandaloneSessionContextProvider>,
    );
  }

  it("is the standing affordance on mobile: a tap navigates to the operator route", () => {
    stubMatchMedia(() => true);
    renderTongue();

    fireEvent.click(screen.getByTestId("quake-terminal-tongue"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: {},
    });
    expect(screen.queryByTestId("quake-terminal")).toBeNull();
  });

  it("renders the return state on the operator window's route, waiting dot suppressed", () => {
    stubMatchMedia(() => true);
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    renderTongue([
      { name: "main", windows: [win({})] },
      {
        name: "_rk-operator",
        hidden: true,
        windows: [win({ windowId: "@9", name: "operator", role: "operator", agentState: "waiting" })],
      },
    ]);

    const tongue = screen.getByTestId("quake-terminal-tongue");
    expect(tongue).toHaveAttribute("data-tongue-state", "return");
    expect(screen.queryByTestId("quake-terminal-tongue-waiting")).toBeNull();
  });

  it("return tap navigates to the validated ?from= origin window", () => {
    stubMatchMedia(() => true);
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@1" };
    renderTongue();

    fireEvent.click(screen.getByTestId("quake-terminal-tongue"));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@1" },
      search: {},
    });
    expect(mockHistoryBack).not.toHaveBeenCalled();
  });

  it("return tap with an unknown ?from= falls through to history back", () => {
    stubMatchMedia(() => true);
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@404" };
    vi.stubGlobal("history", { length: 2 });
    renderTongue();

    fireEvent.click(screen.getByTestId("quake-terminal-tongue"));

    expect(mockHistoryBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("return tap with no ?from= and no back entry lands on the server route", () => {
    stubMatchMedia(() => true);
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    vi.stubGlobal("history", { length: 1 });
    renderTongue();

    fireEvent.click(screen.getByTestId("quake-terminal-tongue"));

    expect(mockHistoryBack).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/$server", params: { server: "srv1" } });
  });

  it("hides when no operator window resolves on the server", () => {
    stubMatchMedia(() => true);
    renderTongue([{ name: "main", windows: [win({})] }]);

    expect(screen.queryByTestId("quake-terminal-tongue")).toBeNull();
  });

  it("carries the amber waiting dot when the resolved operator is waiting", () => {
    stubMatchMedia(() => true);
    renderTongue([
      { name: "main", windows: [win({})] },
      {
        name: "_rk-operator",
        hidden: true,
        windows: [win({ windowId: "@9", name: "operator", role: "operator", agentState: "waiting" })],
      },
    ]);
    expect(screen.getByTestId("quake-terminal-tongue-waiting")).toBeInTheDocument();
  });

  it("renders nothing on desktop", () => {
    stubMatchMedia(() => false);
    renderTongue();
    expect(screen.queryByTestId("quake-terminal-tongue")).toBeNull();
  });
});

describe("QuakeTerminal (chat subject stamping)", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    terminalMounts.length = 0;
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("on a terminal route the route window is stamped as the chat subject", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();

    expect(getOperatorChatTarget("srv1")).toMatchObject({ server: "srv1", windowId: "@1", name: "win" });
  });

  it("on the operator window's own route the validated ?from= origin is stamped instead", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "@1" };
    renderQuake();

    expect(getOperatorChatTarget("srv1")).toMatchObject({ server: "srv1", windowId: "@1" });
  });

  it("the numeric segment form of ?from= resolves like the path parse", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    mockSearch = { from: "1" };
    renderQuake();

    expect(getOperatorChatTarget("srv1")).toMatchObject({ server: "srv1", windowId: "@1" });
  });

  it("an absent, unknown, or self ?from= on the operator route stamps no subject", () => {
    mockMatches = [{ params: { server: "srv1", window: "@9" } }];
    for (const from of [undefined, "@42", "@9"]) {
      setOperatorChatSubject(null);
      mockSearch = from === undefined ? {} : { from };
      const { unmount } = renderQuake();
      expect(getOperatorChatTarget("srv1")).toBeNull();
      unmount();
    }
  });

  it("a stamped subject does not cross servers", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake();

    expect(getOperatorChatTarget("srv2")).toBeNull();
  });

  it("a pinned cross-server retarget does not attach the route's window", () => {
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    renderQuake({
      servers: ["srv1", "srv2"],
      sessionsByServer: new Map([
        ["srv1", operatorSessions()],
        ["srv2", operatorSessions()],
      ]),
    });
    act(() => {
      requestQuakeTerminal({ action: "open", server: "srv2" });
    });

    expect(getOperatorChatTarget("srv1")).toBeNull();
    expect(getOperatorChatTarget("srv2")).toBeNull();
  });

  it("a subject change re-attaches a dismissed chip; re-engaging the quake terminal does too", () => {
    // Reduced motion so the desktop exit is instant — `engaged` only leaves
    // true once the drawer has actually unmounted (the exit slide otherwise
    // holds it), and re-engagement is the edge this test exercises.
    stubMatchMedia((query) => query === "(prefers-reduced-motion: reduce)");
    mockMatches = [{ params: { server: "srv1", window: "@1" } }];
    const view = renderQuake();
    openDrawer();
    act(() => dismissOperatorChatChip());
    expect(getOperatorChatTarget("srv1")).toBeNull();

    // Close and re-open: the machine leaving rest re-attaches.
    act(() => setQuakeMachineState("rest"));
    openDrawer();
    expect(getOperatorChatTarget("srv1")?.windowId).toBe("@1");

    // Dismiss again; a route-window change resets the dismissal in the store.
    act(() => dismissOperatorChatChip());
    expect(getOperatorChatTarget("srv1")).toBeNull();
    mockMatches = [{ params: { server: "srv1", window: "@2" } }];
    view.rerender(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", operatorSessions()]]),
        }}
      >
        <QuakeTerminal />
      </StandaloneSessionContextProvider>,
    );
    expect(getOperatorChatTarget("srv1")?.windowId).toBe("@2");
  });

  it("no subject is stamped on a route without a window", () => {
    renderQuake();

    expect(getOperatorChatTarget("srv1")).toBeNull();
  });
});

describe("QuakeTerminal (operator-kickoff notify)", () => {
  beforeEach(() => {
    stubMatchMedia(() => false);
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    mockMatches = [{ params: {} }];
    mockSearch = {};
    mockNavigate.mockReset();
    notifySubscribers.clear();
    setOperatorChatSubject(null);
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("toasts the body once when the daemon broadcasts an operator-kickoff notify", () => {
    renderQuake({ withToasts: true });

    fireNotify({
      tag: "operator-kickoff",
      title: "Operator kickoff not delivered",
      body: "srv1 · /home/user/proj · the operator pane exited",
    });

    expect(
      screen.getByText("srv1 · /home/user/proj · the operator pane exited"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("ignores untagged and other-tag notify payloads", () => {
    renderQuake({ withToasts: true });

    fireNotify({ title: "PR status", body: "checks green" });
    fireNotify({ tag: "pr-status", body: "unrelated tag" });

    expect(screen.queryByText("checks green")).toBeNull();
    expect(screen.queryByText("unrelated tag")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
