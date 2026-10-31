import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NewSplitButton } from "./new-split-button";
import type { PaletteAction } from "@/components/command-palette";
import type { ProjectSession } from "@/types";
import type { EffectiveBinding } from "@/lib/keybindings";

// The control resolves everything through contexts; each is replaced with a
// mutable fixture so a case sets only the route state it is about.
let mockActions: PaletteAction[] = [];
let mockSlot: { server: string; sessionName: string } | null = null;
let mockFocused: { server: string; windowId: string } | null = null;
let mockSessionsByServer = new Map<string, ProjectSession[]>();
let mockRouteServer: string | null = null;
let mockBindings = new Map<string, Partial<EffectiveBinding>>();

vi.mock("@/contexts/palette-actions-context", () => ({
  usePaletteActionsApi: () => ({ getAllActions: () => mockActions, setRouteActions: () => {} }),
}));
vi.mock("@/contexts/top-bar-slot-context", () => ({
  useTopBarSlot: () => mockSlot,
}));
vi.mock("@/contexts/focused-pane-context", () => ({ useFocusedPane: () => mockFocused }));
vi.mock("@/contexts/session-context", () => ({
  useSessionContext: () => ({ sessionsByServer: mockSessionsByServer }),
  useCurrentServerFromRoute: () => mockRouteServer,
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
  mockRouteServer = null;
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
    mockRouteServer = "work";
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
    mockRouteServer = "work";
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
    mockRouteServer = "work";
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
    mockRouteServer = "work";
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

  it("section headers keep the real case of workspace and group names (no uppercase transform)", () => {
    mockSlot = { server: "Work", sessionName: "HexoKit" };
    mockRouteServer = "Work";
    mockActions = terminalActions();
    render(<NewSplitButton mode="terminal" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    const header = within(screen.getByTestId("new-split-menu")).getByText("IN Work › HexoKit");
    expect(header.className).not.toMatch(/(^|\s)uppercase(\s|$)/);
  });

  it("align=end opens the menu leftward from the control's right edge; the default opens rightward", () => {
    mockActions = terminalActions();
    const { unmount } = render(<NewSplitButton mode="server" align="end" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    expect(screen.getByTestId("new-split-menu").className).toContain("right-0");
    expect(screen.getByTestId("new-split-menu").className).not.toContain("left-0");
    unmount();
    render(<NewSplitButton mode="server" />);
    fireEvent.click(screen.getByTestId("new-split-caret"));
    expect(screen.getByTestId("new-split-menu").className).toContain("left-0");
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
