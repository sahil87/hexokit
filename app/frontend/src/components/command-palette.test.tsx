import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette, type PaletteAction } from "./command-palette";
import { _resetForTests as resetOverlayPresence, count as overlayCount } from "@/lib/overlay-presence";
import { PALETTE_MRU_KEY } from "@/lib/palette/mru";

function makeActions(labels: string[]): PaletteAction[] {
  return labels.map((label, i) => ({
    id: `action-${i}`,
    label,
    onSelect: vi.fn(),
  }));
}

function openPalette() {
  fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
}

describe("CommandPalette", () => {
  afterEach(cleanup);

  it("is hidden by default", () => {
    const actions = makeActions(["New Session", "Kill Window"]);
    const { container } = render(<CommandPalette actions={actions} />);
    expect(container.innerHTML).toBe("");
  });

  it.each([
    { label: "Cmd", modifier: "metaKey" },
    { label: "Ctrl", modifier: "ctrlKey" },
  ] as const)("opens and toggles closed with $label+K", ({ modifier }) => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    const chord = { key: "k", code: "KeyK", [modifier]: true };

    fireEvent.keyDown(document, chord);
    expect(screen.getByPlaceholderText(/^Type a command/)).toBeInTheDocument();
    fireEvent.keyDown(document, chord);
    expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
  });

  it("focuses the search input when opened", () => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByPlaceholderText(/^Type a command/)).toHaveFocus();
  });

  it("registers as a modal overlay while open and releases on close", () => {
    resetOverlayPresence();
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    expect(overlayCount("modal")).toBe(0);
    openPalette();
    expect(overlayCount("modal")).toBe(1);
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(overlayCount("modal")).toBe(0);
  });


  it("filters actions by search query (case-insensitive)", () => {
    const actions = makeActions(["New Session", "Kill Window", "New Window"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "new" } });

    expect(screen.getByText("New Session")).toBeInTheDocument();
    expect(screen.getByText("New Window")).toBeInTheDocument();
    expect(screen.queryByText("Kill Window")).not.toBeInTheDocument();
  });

  it("shows 'No results' when filter matches nothing", () => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "zzzzz" } });

    expect(screen.getByText(/^No results/)).toBeInTheDocument();
  });

  it("renders an optional description as secondary row text", () => {
    const actions: PaletteAction[] = [
      { id: "a", label: "Session: Create", description: "a new group of tabs", onSelect: vi.fn() },
      { id: "b", label: "Tab: Create", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("— a new group of tabs")).toBeInTheDocument();
    // Actions without a description render exactly as before.
    expect(screen.getByText("Tab: Create").querySelector("span span")).toBeNull();
  });

  it("filters by description as well as label", () => {
    const actions: PaletteAction[] = [
      { id: "a", label: "Session: Create", description: "a new group of tabs", onSelect: vi.fn() },
      { id: "b", label: "Tab: Create", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "group" } });

    expect(screen.getByText("Session: Create")).toBeInTheDocument();
    expect(screen.queryByText("Tab: Create")).not.toBeInTheDocument();
  });

  it("renders an optional action icon and finds the action through its description", () => {
    const actions: PaletteAction[] = [
      {
        id: "coordinator",
        label: "Tab: Switch to system › coordinator",
        description: "operator",
        icon: (
          <span data-testid="palette-action-icon" aria-hidden="true">
            icon
          </span>
        ),
        onSelect: vi.fn(),
      },
      { id: "worker", label: "Tab: Switch to work › worker", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "operator" } });

    expect(screen.getByTestId("palette-action-icon")).toBeInTheDocument();
    expect(screen.getByText("Tab: Switch to system › coordinator")).toBeInTheDocument();
    expect(screen.getByText("— operator")).toBeInTheDocument();
    expect(screen.queryByText("Tab: Switch to work › worker")).not.toBeInTheDocument();
  });

  it("selects action with Enter and closes palette", () => {
    const actions = makeActions(["New Session", "Kill Window"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(actions[0].onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
  });

  it("requires a second Enter for an action with a confirmation label", () => {
    const onSelect = vi.fn();
    const actions: PaletteAction[] = [
      {
        id: "close-two",
        label: "Selection: Close 2 windows",
        confirmLabel: "Close 2 windows — Enter to confirm",
        onSelect,
      },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), {
      key: "Enter",
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Close 2 windows — Enter to confirm")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Confirm action...")).toHaveAttribute(
      "readonly",
    );

    fireEvent.keyDown(screen.getByPlaceholderText("Confirm action..."), {
      key: "Enter",
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByPlaceholderText("Confirm action...")).not.toBeInTheDocument();
  });

  it("Escape cancels a pending confirmation without running its action", () => {
    const onSelect = vi.fn();
    const actions: PaletteAction[] = [
      {
        id: "close-one",
        label: "Selection: Close 1 window",
        confirmLabel: "Close 1 window — Enter to confirm",
        onSelect,
      },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), {
      key: "Enter",
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Confirm action..."), {
      key: "Escape",
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Confirm action...")).not.toBeInTheDocument();
  });

  it("navigates with ArrowDown and ArrowUp", () => {
    const actions = makeActions(["First", "Second", "Third"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(actions[2].onSelect).toHaveBeenCalledOnce();
  });

  it("ArrowUp from first item stays at first", () => {
    const actions = makeActions(["First", "Second"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(actions[0].onSelect).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
  });

  it("closes on Escape when focus is on an option row (document-level trap)", () => {
    const actions = makeActions(["New Session", "Kill Window"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    // Options are non-focusable divs; the keydown still bubbles to the
    // document, where useFocusTrap owns Escape.
    const option = screen.getByText("Kill Window");
    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
  });

  it("keeps Tab focus inside the palette (wraps on the sole focusable input)", () => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    expect(input).toHaveFocus();

    // The input is the palette's only focusable element, so the trap wraps
    // Tab and Shift+Tab back onto it — focus can never leave the modal.
    // fireEvent returns false when the trap preventDefault()ed the keydown,
    // which is the observable proof of interception in jsdom (which never
    // moves focus on Tab by itself).
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(input).toHaveFocus();

    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(false);
    expect(input).toHaveFocus();
  });

  it("closes on backdrop click", () => {
    const actions = makeActions(["New Session"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    fireEvent.click(screen.getByTestId("palette-overlay"));

    expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
  });

  it("renders shortcut badges when provided", () => {
    const actions: PaletteAction[] = [
      { id: "a1", label: "New Session", shortcut: "N", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("N")).toBeInTheDocument();
  });


  it("shows theme actions with (current) suffix on active preference", () => {
    const actions: PaletteAction[] = [
      { id: "theme-system", label: "Theme: System (current)", onSelect: vi.fn() },
      { id: "theme-light", label: "Theme: Light", onSelect: vi.fn() },
      { id: "theme-dark", label: "Theme: Dark", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Theme: System (current)")).toBeInTheDocument();
    expect(screen.getByText("Theme: Light")).toBeInTheDocument();
    expect(screen.getByText("Theme: Dark")).toBeInTheDocument();
  });

  it("filters theme actions when typing 'theme'", () => {
    const actions: PaletteAction[] = [
      { id: "create-session", label: "Create new session", onSelect: vi.fn() },
      { id: "theme-system", label: "Theme: System", onSelect: vi.fn() },
      { id: "theme-light", label: "Theme: Light", onSelect: vi.fn() },
      { id: "theme-dark", label: "Theme: Dark", onSelect: vi.fn() },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "theme" } });

    expect(screen.getByText("Theme: System")).toBeInTheDocument();
    expect(screen.getByText("Theme: Light")).toBeInTheDocument();
    expect(screen.getByText("Theme: Dark")).toBeInTheDocument();
    expect(screen.queryByText("Create new session")).not.toBeInTheDocument();
  });

  it("scrolls selected item into view on ArrowDown", () => {
    const actions = makeActions(["First", "Second", "Third"]);
    render(<CommandPalette actions={actions} />);
    openPalette();

    const listbox = screen.getByRole("listbox");
    const options = listbox.querySelectorAll('[role="option"]');
    const secondOption = options[1];
    const scrollSpy = vi.fn();
    (secondOption as unknown as HTMLElement).scrollIntoView = scrollSpy;

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const selected = listbox.querySelector('[aria-selected="true"]');
    expect(selected).toBeTruthy();
    expect(selected).toBe(secondOption);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("copy tmux attach command action copies correct string to clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const sessionName = "main";
    const windowName = "editor";
    const actions: PaletteAction[] = [
      {
        id: "copy-tmux-attach",
        label: "Copy: tmux Attach Command",
        onSelect: () => {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(`tmux attach-session -t ${sessionName}:${windowName}`).catch(() => {});
          }
        },
      },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(writeText).toHaveBeenCalledWith("tmux attach-session -t main:editor");

    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
  });

  it("calls onSelect for theme action when selected", () => {
    const setLight = vi.fn();
    const actions: PaletteAction[] = [
      { id: "theme-light", label: "Theme: Light", onSelect: setLight },
    ];
    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(setLight).toHaveBeenCalledOnce();
  });

  describe("optionPicker sub-step", () => {
    function makePickerAction(onApply = vi.fn()): PaletteAction {
      return {
        id: "sort-windows",
        label: "Session: Sort windows…",
        optionPicker: {
          options: [
            { key: "status", label: "By status" },
            { key: "created", label: "By created" },
            { key: "name", label: "By name" },
          ],
          onApply,
        },
        onSelect: vi.fn(),
      };
    }

    function enterPicker() {
      const input = screen.getByPlaceholderText(/^Type a command/);
      fireEvent.keyDown(input, { key: "Enter" });
      return screen.getByPlaceholderText("Pick options — Space toggle · Enter apply");
    }

    it("swaps the list to option rows with a readOnly instructional input", () => {
      render(<CommandPalette actions={[makePickerAction()]} />);
      openPalette();

      const input = enterPicker();

      expect(input).toHaveAttribute("readonly");
      expect(screen.getByText("By status")).toBeInTheDocument();
      expect(screen.getByText("By created")).toBeInTheDocument();
      expect(screen.getByText("By name")).toBeInTheDocument();
      expect(screen.queryByText("Session: Sort windows…")).not.toBeInTheDocument();
    });

    it("Space toggles options with order badges reflecting selection order", () => {
      render(<CommandPalette actions={[makePickerAction()]} />);
      openPalette();
      const input = enterPicker();

      // Select "created" then "name": badges 1 and 2 in selection order.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: " " });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: " " });

      const createdRow = screen.getByText("By created").closest("[role='option']")!;
      const nameRow = screen.getByText("By name").closest("[role='option']")!;
      expect(createdRow.textContent).toContain("1");
      expect(nameRow.textContent).toContain("2");
      expect(screen.getByText("By status").closest("[role='option']")!.textContent).not.toContain("1");

      // Untoggling "created" renumbers "name" to 1.
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: " " });
      expect(nameRow.textContent).toContain("1");
      expect(createdRow.textContent).not.toContain("2");
    });

    it("click toggles an option", () => {
      render(<CommandPalette actions={[makePickerAction()]} />);
      openPalette();
      enterPicker();

      fireEvent.click(screen.getByText("By name"));

      expect(screen.getByText("By name").closest("[role='option']")!.textContent).toContain("1");
    });

    it("Enter applies the ordered selected keys and closes", () => {
      const onApply = vi.fn();
      render(<CommandPalette actions={[makePickerAction(onApply)]} />);
      openPalette();
      const input = enterPicker();

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: " " });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: " " });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onApply).toHaveBeenCalledWith(["created", "name"]);
      expect(screen.queryByPlaceholderText("Pick options — Space toggle · Enter apply")).not.toBeInTheDocument();
    });

    it("Enter with zero selected is a no-op, not a dismiss", () => {
      const onApply = vi.fn();
      render(<CommandPalette actions={[makePickerAction(onApply)]} />);
      openPalette();
      const input = enterPicker();

      fireEvent.keyDown(input, { key: "Enter" });

      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText("Pick options — Space toggle · Enter apply")).toBeInTheDocument();
    });

    it("Escape cancels without applying", () => {
      const onApply = vi.fn();
      render(<CommandPalette actions={[makePickerAction(onApply)]} />);
      openPalette();
      const input = enterPicker();

      fireEvent.keyDown(input, { key: " " });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onApply).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText("Pick options — Space toggle · Enter apply")).not.toBeInTheDocument();
    });

    it("backdrop click cancels without applying", () => {
      const onApply = vi.fn();
      render(<CommandPalette actions={[makePickerAction(onApply)]} />);
      openPalette();
      enterPicker();

      fireEvent.click(screen.getByTestId("palette-overlay"));

      expect(onApply).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText("Pick options — Space toggle · Enter apply")).not.toBeInTheDocument();
    });

    it("the parent action's onSelect never fires (the picker owns completion)", () => {
      const action = makePickerAction();
      render(<CommandPalette actions={[action]} />);
      openPalette();
      const input = enterPicker();

      fireEvent.keyDown(input, { key: " " });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(action.onSelect).not.toHaveBeenCalled();
    });
  });

  describe("subList sub-step", () => {
    const PLACEHOLDER = "Pick a desktop — Enter select · Esc cancel";

    function makeSubListAction(
      rows: PaletteAction[] | (() => Promise<PaletteAction[]>),
    ): PaletteAction {
      return {
        id: "gui-desktop",
        label: "GUI: Desktop…",
        subList: { placeholder: PLACEHOLDER, rows },
        onSelect: vi.fn(),
      };
    }

    function makeRows(): PaletteAction[] {
      return [
        { id: "auto", label: "Auto (ladder)", description: "current", onSelect: vi.fn() },
        { id: "icewm", label: "IceWM", onSelect: vi.fn() },
        { id: "lxqt", label: "LXQt", onSelect: vi.fn() },
      ];
    }

    function enterSubList() {
      const input = screen.getByPlaceholderText(/^Type a command/);
      fireEvent.keyDown(input, { key: "Enter" });
      return screen.getByPlaceholderText(PLACEHOLDER);
    }

    it("eager rows swap the list to a readOnly sub-step rendering descriptions", () => {
      const action = makeSubListAction(makeRows());
      render(<CommandPalette actions={[action]} />);
      openPalette();
      const input = enterSubList();

      expect(input).toHaveAttribute("readonly");
      expect(screen.getByText("Auto (ladder)")).toBeInTheDocument();
      expect(screen.getByText("— current")).toBeInTheDocument();
      expect(screen.getByText("IceWM")).toBeInTheDocument();
      expect(screen.getByText("LXQt")).toBeInTheDocument();
      expect(screen.queryByText("GUI: Desktop…")).not.toBeInTheDocument();
      expect(action.onSelect).not.toHaveBeenCalled();
    });

    it("lazy rows render Loading… until the loader resolves", async () => {
      let resolveRows: (rows: PaletteAction[]) => void = () => {};
      const loader = vi.fn().mockImplementation(
        () => new Promise<PaletteAction[]>((resolve) => { resolveRows = resolve; }),
      );
      render(<CommandPalette actions={[makeSubListAction(loader)]} />);
      openPalette();
      const input = enterSubList();

      expect(loader).toHaveBeenCalledOnce();
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

      resolveRows(makeRows());
      expect(await screen.findByText("IceWM")).toBeInTheDocument();
    });

    it("a rejected loader renders a non-selectable error row and stays cancelable", async () => {
      const loader = vi.fn().mockRejectedValue(new Error("down"));
      render(<CommandPalette actions={[makeSubListAction(loader)]} />);
      openPalette();
      const input = enterSubList();

      const errorRow = (await screen.findByText("Couldn't load choices")).closest("[role='option']")!;
      expect(errorRow).toHaveAttribute("aria-disabled", "true");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    });

    it("Enter fires exactly the selected row's onSelect and closes the palette", async () => {
      const rows = makeRows();
      render(<CommandPalette actions={[makeSubListAction(rows)]} />);
      openPalette();
      const input = enterSubList();

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(rows[2].onSelect).toHaveBeenCalledOnce();
      expect(rows[0].onSelect).not.toHaveBeenCalled();
      expect(rows[1].onSelect).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    });

    it("click selects a row the same way", () => {
      const rows = makeRows();
      render(<CommandPalette actions={[makeSubListAction(rows)]} />);
      openPalette();
      enterSubList();

      fireEvent.click(screen.getByText("IceWM"));
      expect(rows[1].onSelect).toHaveBeenCalledOnce();
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    });

    it("a disabled row stays inert to Enter and click", () => {
      const hint = { id: "hint", label: "Install more: sudo apt install lxqt-core", disabled: true, onSelect: vi.fn() };
      render(<CommandPalette actions={[makeSubListAction([...makeRows(), hint])]} />);
      openPalette();
      const input = enterSubList();

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(hint.onSelect).not.toHaveBeenCalled();
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

      fireEvent.click(screen.getByText("Install more: sudo apt install lxqt-core"));
      expect(hint.onSelect).not.toHaveBeenCalled();
    });

    it("Escape cancels back out without firing any row", () => {
      const rows = makeRows();
      render(<CommandPalette actions={[makeSubListAction(rows)]} />);
      openPalette();
      const input = enterSubList();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
      for (const row of rows) expect(row.onSelect).not.toHaveBeenCalled();
    });

    it("backdrop click cancels the sub-step", () => {
      const rows = makeRows();
      render(<CommandPalette actions={[makeSubListAction(rows)]} />);
      openPalette();
      enterSubList();

      fireEvent.click(screen.getByTestId("palette-overlay"));
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
      for (const row of rows) expect(row.onSelect).not.toHaveBeenCalled();
    });

    it("a sub-list row carrying its own confirmLabel/subList fires onSelect directly (no recursion)", () => {
      const nested: PaletteAction = {
        id: "nested",
        label: "Nested row",
        confirmLabel: "should be ignored",
        subList: { rows: [] },
        onSelect: vi.fn(),
      };
      render(<CommandPalette actions={[makeSubListAction([nested])]} />);
      openPalette();
      const input = enterSubList();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(nested.onSelect).toHaveBeenCalledOnce();
      expect(screen.queryByText("should be ignored")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    });
  });

  describe("Ask-operator fallback row", () => {
    const noMatch = makeActions(["New Session"]);

    function typeQuery(value: string) {
      const input = screen.getByPlaceholderText(/^Type a command/);
      fireEvent.change(input, { target: { value } });
      return input;
    }

    it("renders the row at zero matches on an operator-bearing server, and Enter delivers the trimmed query", () => {
      const onAsk = vi.fn();
      render(<CommandPalette actions={noMatch} askOperator={{ hasOperator: true, onAsk }} />);
      openPalette();
      const input = typeQuery("  restart the worker  ");

      const row = screen.getByText('Ask operator: "restart the worker"');
      expect(row).toBeInTheDocument();
      expect(screen.queryByText(/^No results/)).not.toBeInTheDocument();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onAsk).toHaveBeenCalledWith("restart the worker");
      // The palette closes behind the handoff (the console opens next).
      expect(screen.queryByPlaceholderText(/^Type a command/)).not.toBeInTheDocument();
    });

    it("is omitted while any action matches the query", () => {
      const onAsk = vi.fn();
      render(<CommandPalette actions={noMatch} askOperator={{ hasOperator: true, onAsk }} />);
      openPalette();
      typeQuery("new");

      expect(screen.queryByText(/^Ask operator:/)).not.toBeInTheDocument();
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });

    it("is omitted without an operator on the resolved server", () => {
      render(<CommandPalette actions={noMatch} askOperator={{ hasOperator: false, onAsk: vi.fn() }} />);
      openPalette();
      typeQuery("restart the worker");

      expect(screen.queryByText(/^Ask operator:/)).not.toBeInTheDocument();
      expect(screen.getByText(/^No results/)).toBeInTheDocument();
    });

    it("is omitted below the query-length floor", () => {
      render(<CommandPalette actions={noMatch} askOperator={{ hasOperator: true, onAsk: vi.fn() }} />);
      openPalette();
      typeQuery("hi");

      expect(screen.queryByText(/^Ask operator:/)).not.toBeInTheDocument();
      expect(screen.getByText(/^No results/)).toBeInTheDocument();
    });

    it("clicking the row fires the same handoff", () => {
      const onAsk = vi.fn();
      render(<CommandPalette actions={noMatch} askOperator={{ hasOperator: true, onAsk }} />);
      openPalette();
      typeQuery("rename the tab");

      fireEvent.click(screen.getByText('Ask operator: "rename the tab"'));
      expect(onAsk).toHaveBeenCalledWith("rename the tab");
    });
  });

  describe("search ranking and MRU", () => {
    beforeEach(() => {
      localStorage.clear();
    });
    afterEach(() => {
      localStorage.clear();
    });

    function renderedLabels(): string[] {
      return Array.from(
        screen.getByRole("listbox").querySelectorAll('[role="option"]'),
      ).map((row) => row.textContent ?? "");
    }

    function storedMru(): string[] {
      const raw = localStorage.getItem(PALETTE_MRU_KEY);
      return raw === null ? [] : (JSON.parse(raw) as string[]);
    }

    it("ranks match quality over declaration order for query 'pr'", () => {
      const actions: PaletteAction[] = [
        { id: "open-pr", label: "Open: PR #3127", onSelect: vi.fn() },
        { id: "protect-noon", label: "Server: Protect noon", onSelect: vi.fn() },
        { id: "pr-refresh", label: "PR: Refresh Status", onSelect: vi.fn() },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      fireEvent.change(screen.getByPlaceholderText(/^Type a command/), {
        target: { value: "pr" },
      });

      expect(renderedLabels()).toEqual([
        "PR: Refresh Status",
        "Open: PR #3127",
        "Server: Protect noon",
      ]);
    });

    it("keeps every action the old label+description filter admitted", () => {
      const actions: PaletteAction[] = [
        { id: "new-session", label: "New Session", onSelect: vi.fn() },
        { id: "kill-window", label: "Kill Window", onSelect: vi.fn() },
        {
          id: "session-create",
          label: "Session: Create",
          description: "a new group of tabs",
          onSelect: vi.fn(),
        },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      fireEvent.change(screen.getByPlaceholderText(/^Type a command/), {
        target: { value: "new" },
      });

      // Same survivors as the pre-change predicate — the description-only
      // match stays in the list, ranked below the label matches.
      expect(renderedLabels()).toEqual([
        "New Session",
        "Session: Create — a new group of tabs",
      ]);
    });

    it("records a plain action's id on invoke", () => {
      const actions: PaletteAction[] = [
        { id: "new-session", label: "New Session", onSelect: vi.fn() },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), {
        key: "Enter",
      });

      expect(storedMru()).toEqual(["new-session"]);
    });

    it("records the base id on a confirm flow, never the synthetic -confirm row id", () => {
      const actions: PaletteAction[] = [
        {
          id: "kill-server-x",
          label: "Server: Kill x",
          confirmLabel: "Kill x — Enter to confirm",
          onSelect: vi.fn(),
        },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), {
        key: "Enter",
      });
      fireEvent.keyDown(screen.getByPlaceholderText("Confirm action..."), {
        key: "Enter",
      });

      expect(storedMru()).toEqual(["kill-server-x"]);
    });

    it("records nothing for a disabled row", () => {
      const actions: PaletteAction[] = [
        { id: "blocked", label: "Server: Switch to full", disabled: true, onSelect: vi.fn() },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), {
        key: "Enter",
      });

      expect(storedMru()).toEqual([]);
    });

    it("ranks a recently-used action first on an empty query", () => {
      localStorage.setItem(PALETTE_MRU_KEY, JSON.stringify(["kill-window"]));
      const actions: PaletteAction[] = [
        { id: "new-session", label: "New Session", onSelect: vi.fn() },
        { id: "kill-window", label: "Kill Window", onSelect: vi.fn() },
      ];
      render(<CommandPalette actions={actions} />);
      openPalette();

      expect(renderedLabels()).toEqual(["Kill Window", "New Session"]);
    });

    it("keeps option-picker rows in the caller's declared order and records the picker id on apply", () => {
      const onApply = vi.fn();
      const action: PaletteAction = {
        id: "sort-windows",
        label: "Session: Sort windows…",
        optionPicker: {
          options: [
            { key: "status", label: "By status" },
            { key: "created", label: "By created" },
            { key: "name", label: "By name" },
          ],
          onApply,
        },
        onSelect: vi.fn(),
      };
      render(<CommandPalette actions={[action]} />);
      openPalette();

      const input = screen.getByPlaceholderText(/^Type a command/);
      fireEvent.keyDown(input, { key: "Enter" });

      expect(renderedLabels()).toEqual(["By status", "By created", "By name"]);
      expect(storedMru()).toEqual([]);

      const pickerInput = screen.getByPlaceholderText(
        "Pick options — Space toggle · Enter apply",
      );
      fireEvent.keyDown(pickerInput, { key: " " });
      fireEvent.keyDown(pickerInput, { key: "Enter" });

      expect(onApply).toHaveBeenCalledWith(["status"]);
      expect(storedMru()).toEqual(["sort-windows"]);
    });
  });
});
