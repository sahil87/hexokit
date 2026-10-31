import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NewSplitButton, useNewSplitMode } from "./new-split-button";
import type { PaletteAction } from "@/components/command-palette";
import type { ProjectSession } from "@/types";
import type { EffectiveBinding } from "@/lib/keybindings";

// The control resolves everything through contexts; each is replaced with a
// mutable fixture so a case sets only the route state it is about.
let mockActions: PaletteAction[] = [];
let mockSlot: { server: string; sessionName: string } | null = null;
let mockFocused: { server: string; windowId: string } | null = null;
let mockSessionsByServer = new Map<string, ProjectSession[]>();
let mockMatches: Array<{ params: Record<string, string> }> = [];
let mockNotFound = false;
let mockBindings = new Map<string, Partial<EffectiveBinding>>();

vi.mock("@tanstack/react-router", () => ({ useMatches: () => mockMatches }));
vi.mock("@/contexts/palette-actions-context", () => ({
  usePaletteActionsApi: () => ({ getAllActions: () => mockActions, setRouteActions: () => {} }),
}));
vi.mock("@/contexts/top-bar-slot-context", () => ({
  useTopBarSlot: () => mockSlot,
  useTopBarNotFound: () => mockNotFound,
}));
vi.mock("@/contexts/focused-pane-context", () => ({ useFocusedPane: () => mockFocused }));
vi.mock("@/contexts/session-context", () => ({
  useSessionContext: () => ({ sessionsByServer: mockSessionsByServer }),
}));
vi.mock("@/hooks/use-keybindings", () => ({
  useKeybindings: () => ({ byAction: mockBindings, host: { platform: "mac", shell: false } }),
}));
vi.mock("@/hooks/use-occludes", () => ({ useOccludes: () => {} }));

function action(id: string, onSelect = vi.fn()): PaletteAction & { onSelect: ReturnType<typeof vi.fn> } {
  return { id, label: id, onSelect };
}

const win = (windowId: string) => ({ windowId }) as ProjectSession["windows"][number];

beforeEach(() => {
  mockActions = [];
  mockSlot = null;
  mockFocused = null;
  mockSessionsByServer = new Map();
  mockMatches = [];
  mockNotFound = false;
  mockBindings = new Map();
});
afterEach(cleanup);

describe("NewSplitButton primary segment", () => {
  it("terminal: `+ Tab` runs the create-window palette action", () => {
    const createWindow = action("create-window");
    mockActions = [createWindow];
    render(<NewSplitButton mode="terminal" />);
    const primary = screen.getByTestId("new-split-primary");
    expect(primary).toHaveTextContent("+ Tab");
    expect(primary).toHaveAttribute("aria-label", "New tab");
    fireEvent.click(primary);
    expect(createWindow.onSelect).toHaveBeenCalledTimes(1);
  });

  it("server: `+ Group` runs the instant create-session-instant action (not the name-prompted create-session)", () => {
    const instant = action("create-session-instant");
    const prompted = action("create-session");
    mockActions = [instant, prompted];
    render(<NewSplitButton mode="server" />);
    expect(screen.getByTestId("new-split-primary")).toHaveTextContent("+ Group");
    fireEvent.click(screen.getByTestId("new-split-primary"));
    expect(instant.onSelect).toHaveBeenCalledTimes(1);
    expect(prompted.onSelect).not.toHaveBeenCalled();
  });

  it("board: `+ Tab` runs create-window", () => {
    const createWindow = action("create-window");
    mockActions = [createWindow];
    render(<NewSplitButton mode="board" />);
    expect(screen.getByTestId("new-split-primary")).toHaveTextContent("+ Tab");
    fireEvent.click(screen.getByTestId("new-split-primary"));
    expect(createWindow.onSelect).toHaveBeenCalledTimes(1);
  });

  it("host: a plain `+ Workspace` button with no caret runs create-server", () => {
    const createServer = action("create-server");
    mockActions = [createServer];
    render(<NewSplitButton mode="host" />);
    expect(screen.getByTestId("new-split-primary")).toHaveTextContent("+ Workspace");
    expect(screen.queryByTestId("new-split-caret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("new-split-primary"));
    expect(createServer.onSelect).toHaveBeenCalledTimes(1);
  });

  it("iconOnly hides the label but keeps the accessible name and the caret", () => {
    render(<NewSplitButton mode="terminal" iconOnly />);
    const primary = screen.getByTestId("new-split-primary");
    expect(primary).not.toHaveTextContent("+ Tab");
    expect(primary).toHaveAttribute("aria-label", "New tab");
    expect(screen.getByTestId("new-split-caret")).toBeInTheDocument();
  });

  it("a click with no registered action is a no-op", () => {
    mockActions = [];
    render(<NewSplitButton mode="terminal" />);
    expect(() => fireEvent.click(screen.getByTestId("new-split-primary"))).not.toThrow();
  });
});

describe("NewSplitButton menu", () => {
  const terminalActions = () => [
    action("create-window"),
    action("create-window-at-folder"),
    action("agent-spawn"),
    action("create-iframe-window"),
    action("reopen-window"),
    action("create-session"),
    action("create-session-at-folder"),
    action("create-server"),
  ];

  it("terminal: sections headed by where the result lands; every row invokes its palette id and closes the menu", () => {
    mockSlot = { server: "work", sessionName: "hexokit" };
    mockMatches = [{ params: { server: "work", window: "@1" } }];
    mockActions = terminalActions();
    render(<NewSplitButton mode="terminal" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    const menu = screen.getByTestId("new-split-menu");
    expect(within(menu).getByText("IN work › hexokit")).toBeInTheDocument();
    expect(within(menu).getByText("IN work")).toBeInTheDocument();
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows.map((r) => r.getAttribute("data-action-id"))).toEqual([
      "create-window",
      "create-window-at-folder",
      "agent-spawn",
      "create-iframe-window",
      "reopen-window",
      "create-session",
      "create-session-at-folder",
      "create-server",
    ]);
    fireEvent.click(within(menu).getByText("Tab at folder…"));
    const atFolder = mockActions.find((a) => a.id === "create-window-at-folder")!;
    expect(atFolder.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("new-split-menu")).not.toBeInTheDocument();
  });

  it("omits rows whose palette id is not registered on the route (omit-not-disable)", () => {
    mockSlot = { server: "work", sessionName: "hexokit" };
    mockMatches = [{ params: { server: "work", window: "@1" } }];
    mockActions = terminalActions().filter((a) => a.id !== "reopen-window" && a.id !== "agent-spawn");
    render(<NewSplitButton mode="terminal" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    const ids = within(screen.getByTestId("new-split-menu"))
      .getAllByRole("menuitem")
      .map((r) => r.getAttribute("data-action-id"));
    expect(ids).not.toContain("reopen-window");
    expect(ids).not.toContain("agent-spawn");
    expect(ids).toContain("create-window");
  });

  it("server route: only the workspace section plus Workspace…", () => {
    mockMatches = [{ params: { server: "work" } }];
    mockActions = terminalActions();
    render(<NewSplitButton mode="server" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    const menu = screen.getByTestId("new-split-menu");
    expect(within(menu).queryByText(/›/)).not.toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((r) => r.getAttribute("data-action-id"))).toEqual([
      "create-session",
      "create-session-at-folder",
      "create-server",
    ]);
  });

  it("board: the first section is keyed to the focused pane's workspace › group", () => {
    mockFocused = { server: "kit", windowId: "@7" };
    mockSessionsByServer = new Map([["kit", [{ name: "review", windows: [win("@7")] } as ProjectSession]]]);
    mockActions = terminalActions();
    render(<NewSplitButton mode="board" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    expect(within(screen.getByTestId("new-split-menu")).getByText("IN kit › review")).toBeInTheDocument();
  });

  it("shows a trailing keycap only for enabled bindings", () => {
    mockSlot = { server: "work", sessionName: "hexokit" };
    mockMatches = [{ params: { server: "work", window: "@1" } }];
    mockActions = terminalActions();
    mockBindings = new Map<string, Partial<EffectiveBinding>>([
      ["create-session", { enabled: true, code: "KeyT", tier: "optcmd" }],
      ["create-window", { enabled: false, code: "KeyT", tier: "cmd" }],
    ]);
    render(<NewSplitButton mode="terminal" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    const menu = screen.getByTestId("new-split-menu");
    expect(within(within(menu).getByText("Group").closest("button")!).getByText("⌥⌘T")).toBeInTheDocument();
    expect(within(within(menu).getByText("Tab").closest("button")!).queryByText("⌘T")).not.toBeInTheDocument();
  });

  it("Escape closes the menu and returns focus to the caret", () => {
    mockActions = terminalActions();
    render(<NewSplitButton mode="server" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    expect(screen.getByTestId("new-split-menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("new-split-menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-split-caret")).toHaveFocus();
  });
});

describe("useNewSplitMode", () => {
  function Mode() {
    return <span data-testid="mode">{useNewSplitMode()}</span>;
  }
  const modeFor = (matches: Array<{ params: Record<string, string> }>, notFound = false) => {
    mockMatches = matches;
    mockNotFound = notFound;
    render(<Mode />);
    const text = screen.getByTestId("mode").textContent;
    cleanup();
    return text;
  };

  it("derives the route mode from the deepest-first param walk", () => {
    expect(modeFor([{ params: {} }])).toBe("host");
    expect(modeFor([{ params: { server: "a" } }])).toBe("server");
    expect(modeFor([{ params: { server: "a", window: "@1" } }])).toBe("terminal");
    expect(modeFor([{ params: { name: "b" } }])).toBe("board");
  });

  it("forces host when the not-found page renders (retained fuzzy params must not win)", () => {
    expect(modeFor([{ params: { name: "x" } }], true)).toBe("host");
  });
});
