import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { QuakeTerminal } from "./quake-terminal";
import { QuakeLauncher, QuakeLauncherFocusCapture } from "./quake-launcher";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import {
  dismissOperatorChatChip,
  getQuakeMachineState,
  isQuakeTerminalTarget,
  requestQuakeTerminal,
  resetOperatorComposeFlags,
  setQuakeMachineState,
  setOperatorChatSubject,
  setOperatorComposeText,
  setQuakeComposeEngaged,
} from "@/lib/quake-terminal";
import { hydrateComposeDrafts } from "@/lib/compose-draft-store";
import { stubMatchMedia } from "@/test-utils/match-media";
import { KEYBINDINGS_STORAGE_KEY } from "@/lib/keybindings";
import { TIP_OPEN_DELAY_MS } from "@/components/tip";
import type { ProjectSession, WindowInfo } from "@/types";

// Route params the quake terminal/quake launcher server-context walk reads; the quake terminal's
// mobile navigation arm's hooks are inert under the desktop stub but must
// exist on the mock.
let mockMatches: Array<{ params: Record<string, string> }> = [{ params: {} }];
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => mockMatches,
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/components/terminal-client", () => ({
  TerminalClient: () => <div data-testid="embedded-terminal" />,
}));

const mockSend = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockOperatorRequest = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  sendToWindow: mockSend,
  uploadFile: mockUpload,
  sendOperatorRequest: mockOperatorRequest,
}));

// The compose-strip focus seam is spied (not exercised) here — the strip
// itself is ComposeStrip's own tested surface.
const mockFocusComposeStrip = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/compose-strip-events", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/compose-strip-events")>()),
  focusComposeStrip: mockFocusComposeStrip,
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

function operatorSessions(agentState?: string): ProjectSession[] {
  return [
    { name: "main", windows: [win({ windowId: "@1" })] },
    {
      name: "_rk-operator",
      windows: [win({ windowId: "@9", name: "operator", role: "operator", agentState })],
      hidden: true,
    },
  ];
}

function renderPair(sessionsByServer?: Map<string, ProjectSession[]>) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        servers: [{ name: "srv1", sessionCount: 1 }],
        serversLoaded: true,
        sessionsByServer: sessionsByServer ?? new Map([["srv1", operatorSessions()]]),
      }}
    >
      <QuakeLauncherFocusCapture />
      <QuakeTerminal />
      <QuakeLauncher routeServer={null} routeWindow={null} />
    </StandaloneSessionContextProvider>,
  );
}

/** Desktop: fine pointer, no mobile query matches. */
function stubDesktop() {
  stubMatchMedia(() => false);
}

const OPERATOR_TARGET = {
  window: win({ windowId: "@9", name: "operator", role: "operator" }),
  sessionName: "_rk-operator",
};

/** Hover the button and read the tooltip's text. */
function tooltipText(button: HTMLElement): string {
  vi.useFakeTimers();
  try {
    act(() => {
      fireEvent.mouseEnter(button);
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS);
    });
    return screen.getByRole("tooltip").textContent ?? "";
  } finally {
    vi.useRealTimers();
  }
}

describe("QuakeLauncher", () => {
  beforeEach(() => {
    setQuakeMachineState("rest");
    resetOperatorComposeFlags();
    setOperatorChatSubject(null);
    mockMatches = [{ params: {} }];
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    mockOperatorRequest.mockReset();
    mockOperatorRequest.mockResolvedValue({ outcome: "delivered" });
    mockFocusComposeStrip.mockClear();
    localStorage.clear();
    hydrateComposeDrafts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing on mobile", () => {
    stubMatchMedia(() => true);
    renderPair();
    expect(screen.queryByTestId("quake-launcher")).toBeNull();
  });

  it("is ONE button: labelled Operator with the chord keycap, never an input", () => {
    stubDesktop();
    renderPair();

    const button = screen.getByTestId("quake-launcher");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveTextContent("Operator");
    expect(button.querySelector("kbd")).toHaveTextContent(/J/);
    expect(button).toHaveAttribute("data-quake-terminal");
    expect(document.querySelector("input")).toBeNull();
    for (const retired of ["quake-launcher-input", "quake-launcher-ghost", "quake-launcher-collapsed"]) {
      expect(screen.queryByTestId(retired)).toBeNull();
    }
  });

  it("is the same DOM node at rest, open and back at rest", () => {
    stubDesktop();
    renderPair();

    const button = screen.getByTestId("quake-launcher");
    act(() => setQuakeMachineState("open"));
    expect(screen.getByTestId("quake-launcher")).toBe(button);
    act(() => setQuakeMachineState("rest"));
    expect(screen.getByTestId("quake-launcher")).toBe(button);
  });

  it("the label form drops the keycap, keeps the label and the accessible name", () => {
    stubDesktop();
    render(<QuakeLauncher routeServer={null} routeWindow={null} form="label" />);

    const button = screen.getByTestId("quake-launcher");
    expect(button).toHaveTextContent("Operator");
    expect(button.querySelector("kbd")).toBeNull();
    expect(button).not.toHaveAttribute("aria-label");
  });

  it("the glyph form is glyph-only: no label, no keycap, the accessible name stays Operator", () => {
    stubDesktop();
    render(<QuakeLauncher routeServer={null} routeWindow={null} form="glyph" />);

    const button = screen.getByTestId("quake-launcher");
    expect(button).toHaveAttribute("aria-label", "Operator");
    expect(button).not.toHaveTextContent("Operator");
    expect(button.querySelector("kbd")).toBeNull();
  });

  it("the probe copy drops every test id so the live button is the only match", () => {
    stubDesktop();
    renderPair(new Map([["srv1", operatorSessions("active")]]));
    act(() =>
      setOperatorComposeText("srv1", OPERATOR_TARGET, "draft"),
    );
    render(<QuakeLauncher routeServer={null} routeWindow={null} probe />);

    expect(screen.getAllByTestId("quake-launcher")).toHaveLength(1);
    expect(screen.getAllByTestId("quake-launcher-state")).toHaveLength(1);
    expect(screen.getAllByTestId("quake-launcher-draft")).toHaveLength(1);
  });

  it("on the operator route the click focuses the page's compose strip, never opens a drawer, and never latches", () => {
    stubDesktop();
    render(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", operatorSessions("waiting")]]),
        }}
      >
        <QuakeLauncher routeServer="srv1" routeWindow="@9" />
      </StandaloneSessionContextProvider>,
    );

    const button = screen.getByTestId("quake-launcher");
    expect(button).toContainElement(screen.getByTestId("quake-launcher-state"));
    expect(button).not.toHaveAttribute("aria-expanded");

    fireEvent.click(button);
    expect(mockFocusComposeStrip).toHaveBeenCalled();
    expect(getQuakeMachineState()).toBe("rest");

    act(() => setQuakeMachineState("open"));
    expect(button).not.toHaveAttribute("aria-expanded");
    expect(button.className).not.toContain("rk-latch-well");
  });

  it("a non-operator window route behaves like any other route: the click opens the drawer", () => {
    stubDesktop();
    render(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", operatorSessions()]]),
        }}
      >
        <QuakeLauncher routeServer="srv1" routeWindow="@1" />
      </StandaloneSessionContextProvider>,
    );

    fireEvent.click(screen.getByTestId("quake-launcher"));
    expect(mockFocusComposeStrip).not.toHaveBeenCalled();
    expect(getQuakeMachineState()).toBe("open");
  });

  it.each([
    ["waiting", "bg-signal-yellow"],
    ["active", "bg-accent-green"],
    ["idle", "bg-text-secondary"],
  ])("the glyph maps %s to its live-state dot color", (agentState, colorClass) => {
    stubDesktop();
    renderPair(new Map([["srv1", operatorSessions(agentState)]]));

    const dot = screen.getByTestId("quake-launcher-state");
    expect(dot).toHaveAttribute("data-state", agentState);
    expect(dot.className).toContain(colorClass);
    expect(screen.getByTestId("quake-launcher")).toContainElement(dot);
  });

  it("renders no state dot when no operator resolves", () => {
    stubDesktop();
    renderPair(new Map([["srv1", [{ name: "main", windows: [win({})] }]]]));

    expect(screen.queryByTestId("quake-launcher-state")).toBeNull();
  });

  it("renders no state dot without SessionContext", () => {
    stubDesktop();
    render(<QuakeLauncher routeServer="srv1" routeWindow={null} />);

    expect(screen.getByTestId("quake-launcher")).toBeInTheDocument();
    expect(screen.queryByTestId("quake-launcher-state")).toBeNull();
  });

  it("the click at rest opens the drawer and focus lands in the docked compose", () => {
    stubDesktop();
    renderPair();

    fireEvent.click(screen.getByTestId("quake-launcher"));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal-compose-input")).toHaveFocus();
  });

  it("with no operator the click still opens the drawer (its Start-operator hint)", () => {
    stubDesktop();
    renderPair(new Map([["srv1", [{ name: "main", windows: [win({})] }]]]));

    fireEvent.click(screen.getByTestId("quake-launcher"));
    expect(getQuakeMachineState()).toBe("open");
  });

  it("aria-expanded and the latch follow the machine; the accent edge follows the compose's focus, not the machine", () => {
    stubDesktop();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    renderPair();

    const button = screen.getByTestId("quake-launcher");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-pressed");
    expect(button.className).not.toContain("rk-latch-well");

    act(() => requestQuakeTerminal({ action: "open" }));
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button.className).toContain("rk-latch-well");
    // The docked textarea took focus on open — the accent edge is lit.
    expect(screen.getByTestId("quake-terminal-compose-input")).toHaveFocus();
    expect(button.className).toContain("border-accent-green");

    act(() => outside.focus());
    // The peek outlives the compose's focus: still open and latched, only the
    // accent edge stands down.
    expect(getQuakeMachineState()).toBe("open");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button.className).toContain("rk-latch-well");
    expect(button.className).not.toContain("border-accent-green");
    outside.remove();
  });

  it("the accent edge needs the latch: an engaged flag at rest paints nothing", () => {
    stubDesktop();
    renderPair();
    act(() => setQuakeComposeEngaged(true));
    expect(screen.getByTestId("quake-launcher").className).not.toContain("border-accent-green");
  });

  it("the click while open re-focuses the docked textarea and never reads as an outside click", async () => {
    stubDesktop();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    renderPair();

    act(() => requestQuakeTerminal({ action: "open" }));
    act(() => outside.focus());
    expect(screen.getByTestId("quake-terminal-compose-input")).not.toHaveFocus();

    const button = screen.getByTestId("quake-launcher");
    // Quake-owned DOM: the drawer's outside-click listener stands down on it.
    expect(isQuakeTerminalTarget(button)).toBe(true);

    fireEvent.click(button);
    expect(screen.getByTestId("quake-terminal-compose-input")).toHaveFocus();
    expect(getQuakeMachineState()).toBe("open");

    // Past the outside-click settle window (a macrotask deferral), the drawer
    // is still open and the compose still focused — the click was never
    // treated as click-away, and never closes the drawer.
    await new Promise((r) => setTimeout(r, 10));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    expect(screen.getByTestId("quake-terminal-compose-input")).toHaveFocus();
    outside.remove();
  });

  it("the draft dot follows the shared store per server — the other server's launcher has none and it returns", () => {
    stubDesktop();
    const sessionsByServer = new Map([
      ["a", operatorSessions()],
      ["b", operatorSessions()],
    ]);
    const tree = (routeServer: string) => (
      <StandaloneSessionContextProvider
        value={{
          servers: [
            { name: "a", sessionCount: 1 },
            { name: "b", sessionCount: 1 },
          ],
          serversLoaded: true,
          sessionsByServer,
        }}
      >
        <QuakeLauncher routeServer={routeServer} routeWindow={null} />
      </StandaloneSessionContextProvider>
    );
    const { rerender } = render(tree("a"));
    expect(screen.queryByTestId("quake-launcher-draft")).toBeNull();
    act(() => setOperatorComposeText("a", OPERATOR_TARGET, "for a"));
    expect(screen.getByTestId("quake-launcher-draft")).toBeInTheDocument();

    rerender(tree("b"));
    expect(screen.queryByTestId("quake-launcher-draft")).toBeNull();

    rerender(tree("a"));
    expect(screen.getByTestId("quake-launcher-draft")).toBeInTheDocument();

    // Whitespace alone is not a draft.
    act(() => setOperatorComposeText("a", OPERATOR_TARGET, "   "));
    expect(screen.queryByTestId("quake-launcher-draft")).toBeNull();
  });

  it.each(["label", "glyph"] as const)("the %s form keeps the draft dot", (form) => {
    stubDesktop();
    renderPair();
    act(() => setOperatorComposeText("srv1", OPERATOR_TARGET, "draft"));
    cleanup();
    render(
      <StandaloneSessionContextProvider
        value={{
          servers: [{ name: "srv1", sessionCount: 1 }],
          serversLoaded: true,
          sessionsByServer: new Map([["srv1", operatorSessions()]]),
        }}
      >
        <QuakeLauncher routeServer={null} routeWindow={null} form={form} />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getByTestId("quake-launcher-draft")).toBeInTheDocument();
  });

  describe("tooltip", () => {
    it.each(["label", "glyph"] as const)("the %s form carries the same tooltip as the full form", (form) => {
      stubDesktop();
      render(<QuakeLauncher routeServer={null} routeWindow={null} form={form} />);
      expect(tooltipText(screen.getByTestId("quake-launcher"))).toMatch(/^Start the operator \(.+\)$/);
    });

    it("asks the operator when one exists, naming the chord", () => {
      stubDesktop();
      renderPair();
      expect(tooltipText(screen.getByTestId("quake-launcher"))).toMatch(/^Ask the operator \(.+\)$/);
    });

    it("starts the operator when none resolves on the server", () => {
      stubDesktop();
      renderPair(new Map([["srv1", [{ name: "main", windows: [win({})] }]]]));
      expect(tooltipText(screen.getByTestId("quake-launcher"))).toMatch(/^Start the operator \(.+\)$/);
    });

    it("appends the unsent-draft note", () => {
      stubDesktop();
      renderPair();
      act(() => setOperatorComposeText("srv1", OPERATOR_TARGET, "half-written"));
      expect(tooltipText(screen.getByTestId("quake-launcher"))).toMatch(
        /^Ask the operator \(.+\) · unsent draft$/,
      );
    });

    it("drops the parenthetical (and the keycap) when the chord is unbound", () => {
      stubDesktop();
      localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ "quake-terminal": null }));
      renderPair();
      const button = screen.getByTestId("quake-launcher");
      expect(button.querySelector("kbd")).toBeNull();
      expect(tooltipText(button)).toBe("Ask the operator");
    });
  });

  it("the chord engages from rest — the docked textarea focused with any draft, caret at its end", () => {
    stubDesktop();
    renderPair();
    act(() => setOperatorComposeText("srv1", OPERATOR_TARGET, "half-written draft"));

    act(() => requestQuakeTerminal({ action: "toggle" }));
    expect(getQuakeMachineState()).toBe("open");
    expect(screen.getByTestId("quake-terminal")).toBeInTheDocument();
    const input = screen.getByTestId("quake-terminal-compose-input") as HTMLTextAreaElement;
    expect(input).toHaveFocus();
    expect(input).toHaveValue("half-written draft");
    expect(input.selectionStart).toBe("half-written draft".length);
    expect(input.selectionEnd).toBe("half-written draft".length);
  });

  it("Esc releases to rest: the docked compose blurs and prior focus is restored", () => {
    stubDesktop();
    const prior = document.createElement("button");
    document.body.appendChild(prior);
    prior.focus();
    renderPair();

    act(() => requestQuakeTerminal({ action: "toggle" }));
    expect(screen.getByTestId("quake-terminal-compose-input")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    expect(prior).toHaveFocus();
    prior.remove();
  });

  it("a blur alone never steps the machine — the open drawer outlives the compose's focus", () => {
    stubDesktop();
    renderPair();

    fireEvent.click(screen.getByTestId("quake-launcher"));
    const docked = screen.getByTestId("quake-terminal-compose-input");
    expect(docked).toHaveFocus();
    fireEvent.blur(docked);
    expect(getQuakeMachineState()).toBe("open");
  });

  // The focus-ownership cases below move focus for REAL (`el.focus()`):
  // `fireEvent.focus`/`blur` dispatch React synthetic events without moving
  // `document.activeElement`, so the origin capture only ever sees
  // `document.body` under them and the self-restore loop these guard against
  // cannot form.

  it("a mouse-entered open holds the machine open on an outside focus — it never steals focus back", () => {
    stubDesktop();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    renderPair();

    // Real click-entry: focus lands on the button BEFORE the click engages the
    // machine, so the origin capture sees a quake-owned element and records
    // nothing.
    const button = screen.getByTestId("quake-launcher");
    act(() => button.focus());
    fireEvent.click(button);
    expect(getQuakeMachineState()).toBe("open");

    act(() => outside.focus());
    expect(getQuakeMachineState()).toBe("open");
    expect(outside).toHaveFocus();
    expect(screen.getByTestId("quake-terminal-compose-input")).not.toHaveFocus();
    outside.remove();
  });

  it("Esc releases a mouse-entered open instead of re-focusing the launcher", () => {
    stubDesktop();
    renderPair();

    const button = screen.getByTestId("quake-launcher");
    act(() => button.focus());
    fireEvent.click(button);
    expect(getQuakeMachineState()).toBe("open");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(getQuakeMachineState()).toBe("rest");
    // The recorded origin is null (the button is quake-owned), so nothing
    // re-focused it.
    expect(screen.getByTestId("quake-launcher")).not.toHaveFocus();
  });
});
