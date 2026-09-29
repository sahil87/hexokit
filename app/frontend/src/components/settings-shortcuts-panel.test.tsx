import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import {
  SettingsShortcutsPanel,
  resetShortcutsPanelViewPrefs,
} from "./settings-shortcuts-panel";
import { KEYBINDINGS_STORAGE_KEY } from "@/lib/keybindings";
import type { Keybinding } from "@/api/client";

// The panel reads the current server from the session context and fetches
// the tmux bindings itself (260801-sm6g) — mock both seams so unit tests stay
// light (no SessionProvider sockets, no network). Default: NO current server
// (the effect resolves `[]` synchronously → the empty state, no async state
// updates outside act).
let mockCurrentServer: string | null = null;
vi.mock("@/contexts/session-context", () => ({
  useSessionContext: () => ({ currentServer: mockCurrentServer }),
}));

const getKeybindingsMock = vi.fn<(server: string) => Promise<Keybinding[]>>();
vi.mock("@/api/client", async (orig) => {
  const actual = await orig<typeof import("@/api/client")>();
  return {
    ...actual,
    getKeybindings: (server: string) => getKeybindingsMock(server),
  };
});

beforeEach(() => {
  mockCurrentServer = null;
  getKeybindingsMock.mockReset();
  getKeybindingsMock.mockResolvedValue([]);
  resetShortcutsPanelViewPrefs();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPanel() {
  render(<SettingsShortcutsPanel />);
}

describe("SettingsShortcutsPanel", () => {
  it("renders grouped rows, scope badges, and locked shell rows", () => {
    renderPanel();
    // Group headings (SHELL is no longer a top-level section — 260801-sm6g;
    // TMUX joined as the merged read-only section)
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.getByText("TERMINAL")).toBeInTheDocument();
    expect(screen.getByText("BOARD")).toBeInTheDocument();
    expect(screen.getByText("TMUX")).toBeInTheDocument();
    expect(screen.queryByText("SHELL — DESKTOP APP")).toBeNull();
    // Starter rows
    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Next tab")).toBeInTheDocument();
    // Scope badges (terminal + board rows carry pills)
    expect(screen.getAllByText("terminal").length).toBeGreaterThan(0);
    // Locked shell rows (accelerators owned by the shell menu)
    expect(screen.getByText("Switch to server 1–9")).toBeInTheDocument();
    expect(
      screen.getAllByLabelText("Locked — bound by the desktop shell menu").length,
    ).toBeGreaterThan(0);
  });

  it("marks browser-reserved rows with the desktop pill (jsdom is a browser host)", () => {
    renderPanel();
    // The shifted N/T/W defaults are browser-reserved outside the desktop
    // shell — one desktop pill per reserved row.
    expect(screen.getAllByText("desktop").length).toBe(3);
    expect(screen.queryByText("browser")).toBeNull();
  });

  it("filters rows by the query and hides empty groups", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Filter shortcuts"), {
      target: { value: "waiting" },
    });
    expect(screen.getByText("Next waiting agent")).toBeInTheDocument();
    expect(screen.queryByText("New session")).toBeNull();
    expect(screen.queryByText("BOARD")).toBeNull();
  });

  it("toggles keycap platform rendering (macOS ↔ Win·Linux)", () => {
    renderPanel();
    // jsdom detects as non-mac → Shift/Ctrl keycaps present.
    expect(screen.getAllByText("Shift").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("macOS"));
    expect(screen.getAllByText("⇧").length).toBeGreaterThan(0);
  });

  it("mac display renders the switcher locked row as ⌥⌘, Win·Linux as Alt; neither display carries server digit claims (260731-nv5r)", () => {
    renderPanel();
    // Win·Linux display (jsdom default): the switcher locked row uses Alt
    // caps — no ⌥ anywhere, and no Shift/Ctrl pair on that row — while the
    // shifted tier map carries NO "server" digit claims: the switcher's
    // Alt+1–9 sits outside every tier (the mac ⌥⌘ precedent), so claims
    // data dropped the rows.
    expect(screen.queryByText("⌥")).toBeNull();
    expect(screen.getByText("Alt")).toBeInTheDocument();
    expect(screen.queryAllByTitle("server")).toHaveLength(0);
    fireEvent.click(screen.getByText("macOS"));
    // The switcher row diverges to ⌥⌘1…9 (the mac shell tier) — the only ⌥
    // keycap in the panel — while Force reload keeps the shared ⇧⌘ caps.
    expect(screen.getAllByText("⌥").length).toBe(1);
    expect(screen.getAllByText("⇧").length).toBeGreaterThan(0);
    expect(screen.getByText("Switch to server 1–9")).toBeInTheDocument();
    // The mac shifted map carries no shell "server" digit claims either:
    // Digit1/2/9 render free (the 3/4/5 screenshot claims live inside the
    // ellipsis run).
    expect(screen.queryAllByTitle("server")).toHaveLength(0);
  });

  it("macOS display offers the ⌘ map layer via the modifier picker; Win·Linux display omits it (260801-r8j2)", () => {
    renderPanel();
    // jsdom host → Win·Linux display by default: no modifier picker (plain
    // Ctrl belongs to the pane there) — a static "Holding Shift Ctrl" label
    // and the shifted layer rendered.
    expect(screen.queryByRole("group", { name: "Keyboard map modifier" })).toBeNull();
    expect(screen.getByText(/Holding/)).toBeInTheDocument();
    expect(screen.getByTitle("incognito")).toBeInTheDocument();
    expect(screen.queryByTitle("address bar")).toBeNull();
    fireEvent.click(screen.getByText("macOS"));
    // The picker appears with ⌘ selected by default (⌘ sits left of ⇧⌘).
    const picker = screen.getByRole("group", { name: "Keyboard map modifier" });
    const shiftedBtn = within(picker).getByText("⇧ ⌘");
    expect(within(picker).getByText("⌘")).toHaveAttribute("aria-pressed", "true");
    expect(shiftedBtn).toHaveAttribute("aria-pressed", "false");
    // ⌘T stands in as the browser-owned cmd-tier claim (⌘L was unclaimed in
    // 260819-v6y4 — page-interceptable, bound by web-address).
    expect(screen.getByTitle("new tab")).toBeInTheDocument();
    expect(screen.queryByTitle("incognito")).toBeNull();
    // Selecting ⇧⌘ swaps the SINGLE grid to the shifted layer (jsdom is a
    // browser host → the shifted-only browser claims render; the mac-browser
    // ⌘ claimed set disappears).
    fireEvent.click(shiftedBtn);
    expect(shiftedBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("incognito")).toBeInTheDocument();
    expect(screen.queryByTitle("new tab")).toBeNull();
    // Switching the display back to Win·Linux drops the picker and keeps the
    // shifted layer (the only one that exists there).
    fireEvent.click(screen.getByText("Win · Linux"));
    expect(screen.queryByRole("group", { name: "Keyboard map modifier" })).toBeNull();
    expect(screen.queryByTitle("new tab")).toBeNull();
    expect(screen.getByTitle("incognito")).toBeInTheDocument();
  });

  it("the ⇧⌘ layer selection survives unmount/remount (session-scoped view state, 260801-r8j2)", () => {
    const { unmount } = render(<SettingsShortcutsPanel />);
    fireEvent.click(screen.getByText("macOS"));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Keyboard map modifier" })).getByText("⇧ ⌘"),
    );
    // The panel unmounts with the dialog close / tab switch now (the old
    // overlay toggled `open`); the hoisted view prefs survive the remount.
    unmount();
    render(<SettingsShortcutsPanel />);
    const picker = screen.getByRole("group", { name: "Keyboard map modifier" });
    expect(within(picker).getByText("⇧ ⌘")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTitle("incognito")).toBeInTheDocument();
  });

  it("header hint shows the HOST-effective chord: ⌘/ on a mac host (260730-n789)", () => {
    // jsdom detects as a win/linux browser host → the shifted base chord.
    renderPanel();
    expect(screen.getByText(/^Shift\+Ctrl\+\/ toggles this sheet$/)).toBeInTheDocument();
    cleanup();
    // Spoof a mac host: the overlay toggle demotes to the ⌘ tier (macTier,
    // no shell gate), so the header must advertise ⌘/ — never ⇧⌘/.
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      renderPanel();
      expect(screen.getByText(/^⌘\/ toggles this sheet$/)).toBeInTheDocument();
    } finally {
      // Drop the instance shadow — jsdom's prototype getter resumes.
      delete (navigator as { platform?: string }).platform;
    }
  });

  it("hides the header hint when the overlay toggle is unbound", () => {
    localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ "shortcuts-overlay": null }));
    renderPanel();
    expect(screen.queryByText(/toggles this sheet/)).toBeNull();
  });

  it("click-to-capture rebinds, persists the diff, and shows the modified reset affordance", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Change binding for Next tab"));
    // Modifier-only press keeps capturing; then a valid shifted chord lands.
    fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(window, {
      key: "U",
      code: "KeyU",
      shiftKey: true,
      ctrlKey: true,
    });
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "window-next": { code: "KeyU", tier: "shifted" },
    });
    // Reset restores the default and drops the diff.
    fireEvent.click(screen.getByLabelText("Reset binding for Next tab"));
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });

  it("Escape cancels an armed capture without persisting", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Change binding for Next tab"));
    expect(screen.getByText("press keys…")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
    // Capture disarmed; the panel (and its host dialog) stay open — the
    // capture-phase listener stopPropagations before the focus trap sees Esc.
    expect(screen.queryByText("press keys…")).toBeNull();
    expect(screen.getByTestId("settings-shortcuts-panel")).toBeInTheDocument();
  });

  it("steal-with-warning: capturing another action's combo unbinds it and flags it", () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText("Change binding for Next tab"));
    // ⇧Ctrl+A is owned by "Next waiting agent".
    fireEvent.keyDown(window, { key: "A", code: "KeyA", shiftKey: true, ctrlKey: true });
    expect(screen.getByText(/now unbound/)).toBeInTheDocument();
    // The stolen-from victim's OWN row carries the unbound affordance (the
    // shipped keyless app-window rows carry one too — scope to the victim).
    expect(
      document.querySelector('[data-actionid="agent-next-waiting"] [title="unbound — click to rebind"]'),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "window-next": { code: "KeyA", tier: "shifted" },
      "agent-next-waiting": null,
    });
  });

  it("reset all clears every override", () => {
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "window-next": { code: "KeyU", tier: "shifted" } }),
    );
    renderPanel();
    fireEvent.click(screen.getByText("reset all"));
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });
});

describe("SettingsShortcutsPanel merged view (260801-sm6g)", () => {
  const TMUX_BINDINGS: Keybinding[] = [
    { key: "F3", table: "root", command: "previous-window", label: "Previous window (tmux)" },
    { key: "S-F3", table: "root", command: "select-pane -t :.-", label: "Previous pane" },
    { key: "\\", table: "prefix", command: "split-window -h", label: "Split horizontally" },
  ];

  it("renders the sticky jump-nav chips for every section", () => {
    renderPanel();
    const nav = screen.getByTestId("shortcuts-jump-nav");
    for (const label of ["key map", "global", "terminal", "board", "tmux"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    // No custom section on the bare mount (no macros, no paletteTargets).
    expect(within(nav).queryByText("custom")).toBeNull();
  });

  it("filtering shows live chip counts, dims empty chips, and hides the key map", () => {
    renderPanel();
    expect(screen.getByText(/Holding/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter shortcuts"), {
      target: { value: "waiting" },
    });
    // The key map auto-hides while a filter is active.
    expect(screen.queryByText(/Holding/)).toBeNull();
    const nav = screen.getByTestId("shortcuts-jump-nav");
    // "waiting" matches exactly one global row (Next waiting agent).
    const globalChip = within(nav).getByText("global").closest("button")!;
    expect(globalChip.textContent).toBe("global1");
    expect(globalChip.className).not.toContain("opacity-40");
    // Zero-hit sections dim their chips.
    const boardChip = within(nav).getByText("board").closest("button")!;
    expect(boardChip.textContent).toBe("board0");
    expect(boardChip.className).toContain("opacity-40");
    // Clearing the filter restores the map and drops the counts.
    fireEvent.change(screen.getByLabelText("Filter shortcuts"), { target: { value: "" } });
    expect(screen.getByText(/Holding/)).toBeInTheDocument();
    expect(within(nav).getByText("global").closest("button")!.textContent).toBe("global");
  });

  it("collapse map folds the key grid; expand restores it (new one-line claimed legend)", () => {
    renderPanel();
    const legend = "claimed — taken by the OS / browser / app menu (the desktop app frees the browser ones)";
    expect(screen.getByText(legend)).toBeInTheDocument();
    fireEvent.click(screen.getByText("▾ collapse map"));
    expect(screen.queryByText(legend)).toBeNull();
    fireEvent.click(screen.getByText("▸ expand map"));
    expect(screen.getByText(legend)).toBeInTheDocument();
  });

  it("shell-owned rows render as a GLOBAL subgroup", () => {
    renderPanel();
    expect(
      screen.getByText("Shell-owned — accelerators live in the desktop shell menu"),
    ).toBeInTheDocument();
    const globalSection = screen.getByText("GLOBAL").closest("section")!;
    expect(within(globalSection).getByText("Switch to server 1–9")).toBeInTheDocument();
    expect(within(globalSection).getByText("Force reload")).toBeInTheDocument();
  });

  it("tmux section renders Direct + Prefix locked rows from getKeybindings", async () => {
    mockCurrentServer = "rk";
    getKeybindingsMock.mockResolvedValue(TMUX_BINDINGS);
    renderPanel();
    const tmux = screen.getByTestId("tmux-section");
    await waitFor(() => expect(within(tmux).getByText("Previous pane")).toBeInTheDocument());
    expect(getKeybindingsMock).toHaveBeenCalledWith("rk");
    // Subheads: root table under Direct, prefix table under the sequence hint.
    expect(within(tmux).getByText("Direct")).toBeInTheDocument();
    expect(within(tmux).getByText(/Prefix —/)).toBeInTheDocument();
    // The section header names the source server.
    expect(within(tmux).getByText("rk")).toBeInTheDocument();
    // Prefix rows render as a sequence: Ctrl S then \.
    expect(within(tmux).getByText("Split horizontally")).toBeInTheDocument();
    expect(within(tmux).getByText("then")).toBeInTheDocument();
    // Every tmux row is locked (read-only — pressed inside the pane).
    expect(
      within(tmux).getAllByLabelText("Locked — a tmux binding, pressed inside the pane"),
    ).toHaveLength(3);
  });

  it("shows the tmux empty state when no current server exists (board/host routes)", () => {
    renderPanel(); // mockCurrentServer = null
    expect(screen.getByText("No tmux server running")).toBeInTheDocument();
    expect(getKeybindingsMock).not.toHaveBeenCalled();
  });

  it("shows the tmux empty state when the fetch fails", async () => {
    mockCurrentServer = "rk";
    getKeybindingsMock.mockRejectedValue(new Error("boom"));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("No tmux server running")).toBeInTheDocument(),
    );
  });

  it("one filter spans app + tmux rows and the tmux chip counts them", async () => {
    mockCurrentServer = "rk";
    getKeybindingsMock.mockResolvedValue(TMUX_BINDINGS);
    renderPanel();
    const tmux = screen.getByTestId("tmux-section");
    await waitFor(() => expect(within(tmux).getByText("Split horizontally")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Filter shortcuts"), {
      target: { value: "split" },
    });
    // The tmux hit stays visible; app sections with no hits disappear.
    expect(within(tmux).getByText("Split horizontally")).toBeInTheDocument();
    expect(screen.queryByText("GLOBAL")).toBeNull();
    const nav = screen.getByTestId("shortcuts-jump-nav");
    expect(within(nav).getByText("tmux").closest("button")!.textContent).toBe("tmux1");
    expect(within(nav).getByText("global").closest("button")!.textContent).toBe("global0");
  });
});

describe("SettingsShortcutsPanel desktop-pill rows (260823-c5yq)", () => {
  // The desktop pill gates on the PHYSICAL host's reserved resolution, so
  // these spoof `navigator.platform` (the header-hint test's pattern) and,
  // for the shell case, inject the `window.runkitShell` bridge marker.
  function spoofMacHost() {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  }
  function unspoofMacHost() {
    delete (navigator as { platform?: string }).platform;
  }

  it("mac BROWSER host: reserved rows carry canonical keycaps + the desktop pill, no second-mapping text", () => {
    spoofMacHost();
    try {
      renderPanel();
      // Twelve pills — the six canonical-chord rows (N/T/W/, + the app-window
      // pair's ⌘N/⇧⌘W, reserved in a mac browser) plus the six surface
      // digits (⌘1–6 are the browser's tab accelerators). Rows stay
      // visible; no amber "browser" pill and no "in browser:/in desktop
      // app:" divergence text anywhere.
      expect(screen.getAllByText("desktop")).toHaveLength(12);
      expect(screen.queryByText("browser")).toBeNull();
      expect(screen.queryByText(/^in (browser|desktop app):/)).toBeNull();
      // The app-window pair renders its canonical mac keycaps here (no
      // longer "unbound") — the learn-why-⌘W-did-the-browser-thing row.
      expect(screen.getByLabelText("Change binding for New app window")).toBeInTheDocument();
      expect(screen.getByLabelText("Change binding for Close app window")).toBeInTheDocument();
    } finally {
      unspoofMacHost();
    }
  });

  it("mac SHELL host: rows render plain — no desktop pill, no reserved pills", () => {
    spoofMacHost();
    window.runkitShell = { version: "1", platform: "darwin" };
    try {
      renderPanel();
      expect(screen.queryByText("desktop")).toBeNull();
      expect(screen.queryByText("browser")).toBeNull();
      expect(screen.queryByText(/^in (browser|desktop app):/)).toBeNull();
      // The mac-canonical chords are live — their keycap buttons rebind.
      // New session is the exception: its mac-keyless default refinement
      // leaves it unbound on mac, so no live keycap renders for it.
      expect(screen.queryByLabelText("Change binding for New session")).toBeNull();
      expect(screen.getByLabelText("Change binding for Reopen closed tab")).toBeInTheDocument();
      expect(screen.getByLabelText("Change binding for Settings")).toBeInTheDocument();
    } finally {
      delete window.runkitShell;
      unspoofMacHost();
    }
  });

  it("win/linux host: browser-reserved rows carry the desktop pill; an override stays verbatim", () => {
    // Default jsdom host (platform "other") — the shifted N/T/W claims are
    // platform-unrestricted, so the three reserved rows carry the pill.
    renderPanel();
    expect(screen.getAllByText("desktop")).toHaveLength(3);
    cleanup();
    // An override onto a free key re-enables the action in the browser
    // host — the pill follows the EFFECTIVE row, not the shipped default.
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "create-window": { code: "KeyU", tier: "shifted" } }),
    );
    renderPanel();
    expect(screen.getAllByText("desktop")).toHaveLength(2);
  });
});

describe("SettingsShortcutsPanel CUSTOM section (260730-hbyh)", () => {
  const DISCUSS = {
    actionId: "macro:discuss",
    kind: "macro",
    label: "riff: discuss",
    target: { type: "riff", preset: "discuss" },
  };

  function renderWithTargets(opts?: {
    presets?: string[] | null;
    targets?: { id: string; label: string }[];
  }) {
    render(
      <SettingsShortcutsPanel
        paletteTargets={opts?.targets ?? [{ id: "create-window", label: "Window: Create" }]}
        riffPresetNames={opts?.presets ?? ["discuss"]}
      />,
    );
  }

  it("renders no CUSTOM section when no macros exist and no targets are provided", () => {
    renderPanel();
    expect(screen.queryByTestId("macro-section")).toBeNull();
  });

  it("renders macro rows with the command preview and an unbound state", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    renderWithTargets();
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
    expect(screen.getByText("riff: discuss")).toBeInTheDocument();
    expect(screen.getByText("rk riff --preset discuss")).toBeInTheDocument();
    // No combo diff stored → unbound affordance.
    expect(screen.getByTitle("unbound — click to bind")).toBeInTheDocument();
    expect(screen.queryByText("missing preset")).toBeNull();
  });

  it("shows the missing-preset badge when the preset is absent from the known list", () => {
    localStorage.setItem(
      "hexokit-macros",
      JSON.stringify([{ ...DISCUSS, target: { type: "riff", preset: "gone" } }]),
    );
    renderWithTargets({ presets: ["discuss"] });
    expect(screen.getByText("missing preset")).toBeInTheDocument();
  });

  it("shows no missing-preset badge when the preset list is unknown (null)", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    renderWithTargets({ presets: null });
    expect(screen.queryByText("missing preset")).toBeNull();
  });

  it("add flow: pick a target, name it, add — macro persists and capture arms", () => {
    renderWithTargets();
    fireEvent.click(screen.getByText("+ bind a key to a palette action or riff preset…"));
    // Target list offers riff presets + palette actions (macros excluded).
    fireEvent.change(screen.getByLabelText("Search macro targets"), {
      target: { value: "discuss" },
    });
    fireEvent.click(screen.getByText("riff: discuss"));
    // Name pre-fills from the picked target; keep it and add.
    expect(screen.getByLabelText("Macro name")).toHaveValue("riff: discuss");
    fireEvent.click(screen.getByText("add + capture key"));

    const stored = JSON.parse(localStorage.getItem("hexokit-macros") ?? "[]");
    expect(stored).toEqual([
      {
        actionId: "macro:riff-discuss",
        kind: "macro",
        label: "riff: discuss",
        target: { type: "riff", preset: "discuss" },
      },
    ]);
    // Capture armed on the fresh row.
    expect(screen.getByText("press keys…")).toBeInTheDocument();
    // Land a chord — the combo persists as an ordinary keybindings diff.
    fireEvent.keyDown(window, { code: "KeyD", key: "D", shiftKey: true, ctrlKey: true });
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "macro:riff-discuss": { code: "KeyD", tier: "shifted" },
    });
  });

  it("delete removes the macro definition and its keybindings diff", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "macro:discuss": { code: "KeyD", tier: "shifted" } }),
    );
    renderWithTargets();
    fireEvent.click(screen.getByLabelText("Delete macro riff: discuss"));
    expect(screen.queryByText("rk riff --preset discuss")).toBeNull();
    expect(localStorage.getItem("hexokit-macros")).toBeNull();
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });

  it("capturing a builtin's combo for a macro steals it and flags the victim", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    renderWithTargets();
    fireEvent.click(screen.getByTitle("unbound — click to bind"));
    fireEvent.keyDown(window, { code: "ArrowDown", key: "ArrowDown", shiftKey: true, ctrlKey: true });
    // Steal warning names the victim; the builtin is now unbound.
    expect(screen.getByText(/took Shift\+Ctrl\+ArrowDown from “Next tab”/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "macro:discuss": { code: "ArrowDown", tier: "shifted" },
      "window-next": null,
    });
  });

  it("hides the add row when no paletteTargets prop is provided (board mount)", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    renderPanel();
    // Rows still render (view/rebind/delete), but no add flow.
    expect(screen.getByText("rk riff --preset discuss")).toBeInTheDocument();
    expect(
      screen.queryByText("+ bind a key to a palette action or riff preset…"),
    ).toBeNull();
  });
});

describe("SettingsShortcutsPanel — aliased actions", () => {
  it("renders the palette's alias as a continuation row directly beneath it, not a second labelled row", () => {
    renderPanel();
    // jsdom detects as non-mac, so the Win/Linux alias is bound.
    const primary = document.querySelector('[data-actionid="command-palette"]');
    const alias = document.querySelector('[data-actionid="command-palette-alt"]');
    expect(primary).toBeInTheDocument();
    expect(alias).toBeInTheDocument();
    // Adjacency is the grouping: the alias is the primary's next sibling.
    expect(primary?.nextElementSibling).toBe(alias);
    // The alias carries the continuation marker, and does NOT repeat the label.
    expect(within(alias as HTMLElement).getByText("↳ also")).toBeInTheDocument();
    expect(within(alias as HTMLElement).queryByText("Command palette")).toBeNull();
  });

  it("the alias row is independently rebindable — its capture targets the alias, not the primary", () => {
    renderPanel();
    const alias = document.querySelector('[data-actionid="command-palette-alt"]') as HTMLElement;
    // Its own rebind affordance, named for the alias.
    const rebind = within(alias).getByRole("button", {
      name: "Change binding for Command palette (alternate)",
    });
    fireEvent.click(rebind);
    expect(within(alias).getByText("press keys…")).toBeInTheDocument();
    // The primary is untouched — it is not the row in capture.
    const primary = document.querySelector('[data-actionid="command-palette"]') as HTMLElement;
    expect(within(primary).queryByText("press keys…")).toBeNull();
  });

  // The panel's platform control is a DISPLAY toggle — the effective map still
  // resolves for the detected host — so mac's "no alias row" guarantee cannot
  // be asserted through it here. What makes mac safe is the rule below: an
  // alias that resolves UNBOUND contributes no row, and `macCode: ""` is
  // exactly what leaves it unbound on mac (asserted in keybindings.test.ts).
  it("an unbound alias contributes no continuation row — the rule that keeps mac unchanged", () => {
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "command-palette-alt": null }),
    );
    renderPanel();
    expect(document.querySelector('[data-actionid="command-palette"]')).toBeInTheDocument();
    expect(document.querySelector('[data-actionid="command-palette-alt"]')).toBeNull();
  });
});
