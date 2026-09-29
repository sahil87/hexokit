import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { useEffect, useState, createContext } from "react";
import { ThemeProvider } from "@/contexts/theme-context";
import { ToastProvider } from "@/components/toast";
import { ChromeProvider } from "@/contexts/chrome-context";
import { InstanceAccentValueProvider, type InstanceAccent } from "@/contexts/instance-accent-context";
import { InstanceNameValueProvider, type InstanceName } from "@/contexts/instance-name-context";
import { SettingsDialogProvider, useSettingsDialog } from "@/contexts/settings-dialog-context";
import { SettingsDialog } from "./settings-dialog";

// Mock the API client module so no real HTTP calls happen in tests. Includes
// the theme-context imports since the whole module is replaced.
vi.mock("@/api/client", () => ({
  getThemePreference: vi.fn().mockRejectedValue(new Error("no API in test")),
  setThemePreference: vi.fn().mockResolvedValue(undefined),
  getSettingsEntries: vi.fn().mockResolvedValue([]),
  postSettings: vi.fn().mockResolvedValue(undefined),
  getRiffPresets: vi.fn().mockRejectedValue(new Error("no API in test")),
  getKeybindings: vi.fn().mockResolvedValue([]),
}));
import { getSettingsEntries, postSettings, setThemePreference, getThemePreference, type SettingsEntry } from "@/api/client";

// The escape-hatch footer's copy button — assert the write, never the OS.
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));
import { copyToClipboard } from "@/lib/clipboard";

// The Shortcuts tab's plumbing reads the session context, the route params,
// and the merged palette list — mock all three seams light (no current
// server/route → no add flow, the tmux section's empty state). The quake terminal
// opacity row's store (lib/quake-terminal.ts) imports the raw SessionContext
// object + the route-server hook from the same module, so the mock must carry
// them (a real context object, absent provider = the tolerant-degrade path).
vi.mock("@/contexts/session-context", () => ({
  useSessionContext: () => ({ currentServer: null, sessionsByServer: new Map() }),
  SessionContext: createContext(null),
  useCurrentServerFromRoute: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => [],
}));
vi.mock("@/contexts/palette-actions-context", () => ({
  usePaletteActions: () => [],
}));

// Mock the open-context store so the commit→invalidate seam is observable
// without dragging the real store (and its fetches) into dialog tests.
vi.mock("@/hooks/use-open-targets", () => ({
  invalidateOpenContext: vi.fn(),
}));
import { invalidateOpenContext } from "@/hooks/use-open-targets";

// Drive the Notifications row deterministically (260724-6j1v): mock the push
// lib so each test picks the reported state without touching real
// serviceWorker / Notification (the retired top-bar bell test pattern).
const getPushState = vi.fn();
const enablePushSubscription = vi.fn();
const sendTestNotification = vi.fn();
vi.mock("@/lib/push", () => ({
  getPushState: (...a: unknown[]) => getPushState(...a),
  enablePushSubscription: (...a: unknown[]) => enablePushSubscription(...a),
  sendTestNotification: (...a: unknown[]) => sendTestNotification(...a),
}));

function mockMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }),
  );
}

const NULL_ACCENT: InstanceAccent = {
  color: null,
  isExplicit: false,
  stripeHex: null,
  washHex: null,
  titlebarHex: null,
  setColor: vi.fn(),
};

function makeInstanceName(overrides: Partial<InstanceName> = {}): InstanceName {
  return {
    hostname: "mac-mini",
    instanceName: null,
    displayName: "mac-mini",
    setInstanceName: vi.fn(),
    ...overrides,
  };
}

/** One GET /api/settings row for the entries-seam mock. */
function registryEntry(key: string, kind: string, value: unknown) {
  return { key, kind, default: "", description: "", category: "", ui: true, live: true, value };
}

/** A registry row with per-field overrides — the All-settings fixture builder. */
function allEntry(partial: Partial<SettingsEntry> & { key: string }): SettingsEntry {
  return {
    kind: "string",
    default: "",
    description: "",
    category: "advanced",
    ui: true,
    live: true,
    value: null,
    ...partial,
  };
}

/** The mocked registry payload the All-settings tests render — registry order. */
function allSettingsFixture(): SettingsEntry[] {
  return [
    allEntry({
      key: "theme",
      kind: "enum",
      default: "system",
      description: "Theme mode",
      category: "appearance",
      options: ["system", "dark", "light"],
      value: "system",
    }),
    allEntry({
      key: "instance_color",
      kind: "color",
      description: "Accent color",
      category: "appearance",
    }),
    allEntry({
      key: "server_colors",
      kind: "map",
      default: "{}",
      description: "Per-server colors",
      category: "appearance",
      value: {},
    }),
    allEntry({
      key: "ssh_host",
      kind: "string",
      description: "SSH host for deeplinks",
      category: "connectivity",
    }),
    allEntry({
      key: "instance_name",
      kind: "string",
      description: "Display name",
      category: "identity",
    }),
    allEntry({
      key: "auto_name",
      kind: "bool",
      default: "false",
      description: "Name windows from the running command",
      category: "behavior",
      value: false,
    }),
    allEntry({
      key: "tmux_conf",
      kind: "path",
      description: "Extra tmux config",
      category: "advanced",
      live: false,
    }),
    allEntry({
      key: "log_level",
      kind: "enum",
      default: "info",
      description: "Log verbosity",
      category: "advanced",
      live: false,
      options: ["info", "debug"],
      value: "info",
    }),
    allEntry({
      key: "board_order",
      kind: "list",
      default: "[]",
      description: "Pinned board order",
      category: "layout",
      value: [],
    }),
    allEntry({
      key: "internal_only",
      description: "A non-UI key",
      category: "advanced",
      ui: false,
    }),
  ];
}

/** Opens the dialog on mount (the palette/gear stand-in). `tab` deep-links. */
function OpenOnMount({ tab }: { tab?: "general" | "appearance" | "all" | "shortcuts" }) {
  const { openSettings } = useSettingsDialog();
  useEffect(() => {
    openSettings(tab);
  }, [openSettings, tab]);
  return null;
}

function renderDialog(
  instanceNameValue: InstanceName = makeInstanceName(),
  tab?: "general" | "appearance" | "all" | "shortcuts",
) {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ChromeProvider>
          <InstanceAccentValueProvider value={NULL_ACCENT}>
            <InstanceNameValueProvider value={instanceNameValue}>
              <SettingsDialogProvider>
                <OpenOnMount tab={tab} />
                <SettingsDialog />
              </SettingsDialogProvider>
            </InstanceNameValueProvider>
          </InstanceAccentValueProvider>
        </ChromeProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Switch to a tab by its rail/strip button. */
function selectTab(label: "General" | "Appearance" | "All settings" | "Shortcuts") {
  fireEvent.click(screen.getByRole("tab", { name: label }));
}

/** A live InstanceName provider for drift-guard tests — the setter actually
 *  updates state, like the real InstanceNameProvider (the fixed-value test
 *  seam can't show a context write propagating between presentations). */
function LiveNameProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState<string | null>(null);
  return (
    <InstanceNameValueProvider
      value={makeInstanceName({
        instanceName: name,
        displayName: name ?? "mac-mini",
        setInstanceName: setName,
      })}
    >
      {children}
    </InstanceNameValueProvider>
  );
}

function renderDialogLiveName(tab?: "general" | "appearance" | "all" | "shortcuts") {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ChromeProvider>
          <InstanceAccentValueProvider value={NULL_ACCENT}>
            <LiveNameProvider>
              <SettingsDialogProvider>
                <OpenOnMount tab={tab} />
                <SettingsDialog />
              </SettingsDialogProvider>
            </LiveNameProvider>
          </InstanceAccentValueProvider>
        </ChromeProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  delete window.runkitShell;
  localStorage.clear();
  // Belt-and-braces: the theme context's storage keys must never leak between
  // tests (a stored named-theme preference changes what the real provider
  // resolves before the API preference lands).
  localStorage.removeItem("hexokit-theme");
  localStorage.removeItem("hexokit-theme-dark");
  localStorage.removeItem("hexokit-theme-light");
  mockMatchMedia();
  vi.mocked(getSettingsEntries).mockReset();
  vi.mocked(getSettingsEntries).mockResolvedValue([]);
  vi.mocked(postSettings).mockClear();
  vi.mocked(postSettings).mockResolvedValue(undefined);
  vi.mocked(invalidateOpenContext).mockClear();
  vi.mocked(copyToClipboard).mockClear();
  vi.mocked(copyToClipboard).mockResolvedValue(true);
  // The theme commit-path test asserts postSettings calls, so the mocked
  // wrapper delegates to it (the real one translates to the snake_case patch).
  vi.mocked(setThemePreference).mockImplementation(async (prefs) => {
    const patch: Record<string, unknown> = {};
    if (prefs.theme !== undefined) patch.theme = prefs.theme;
    if (prefs.themeDark !== undefined) patch.theme_dark = prefs.themeDark;
    if (prefs.themeLight !== undefined) patch.theme_light = prefs.themeLight;
    if (Object.keys(patch).length === 0) return;
    await postSettings(patch);
  });
  getPushState.mockReset().mockResolvedValue("default");
  enablePushSubscription.mockReset().mockResolvedValue("subscribed");
  sendTestNotification.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.runkitShell;
});

describe("SettingsDialog", () => {
  it("renders the four tabs and opens on General by default", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    const tablist = screen.getByRole("tablist", { name: "Settings sections" });
    for (const label of ["General", "Appearance", "All settings", "Shortcuts"]) {
      expect(within(tablist).getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    // General = instance name + SSH host (This host), notifications (This device).
    expect(screen.getByText("This host")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByLabelText("Instance name")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH host")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("the Appearance tab carries the theme control + accent (This host) and terminal font (This device)", () => {
    renderDialog();
    selectTab("Appearance");
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("This host")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Theme mode" })).toBeInTheDocument();
    // The theme picker is the shared searchable core rendered inline — the
    // per-mode <select>s are gone. At rest a trigger shows the ACTIVE theme;
    // the search field + list live in a popover opened from it (collapsible).
    expect(screen.getByTestId("theme-picker-trigger")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Search themes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Themes" })).not.toBeInTheDocument();
    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: "Set instance color" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase terminal font" })).toBeInTheDocument();
  });

  it("the quake-terminal-opacity row is a localStorage-backed This-device resident — no settings API call", () => {
    renderDialog();
    selectTab("Appearance");

    const slider = screen.getByRole("slider", { name: "Quake terminal opacity" });
    // Default 0.95, clamped 0.5–1.0.
    expect(slider).toHaveValue("0.95");
    expect(slider).toHaveAttribute("min", "0.5");
    expect(slider).toHaveAttribute("max", "1");

    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(localStorage.getItem("hexokit-quake-terminal-opacity")).toBe("0.8");
    // Per-viewer resident: nothing rides the registry seam.
    expect(postSettings).not.toHaveBeenCalled();
  });

  describe("Appearance inline theme picker (260819-qkow)", () => {
    /** Renders on the Appearance tab, opens the picker popover from its
     *  trigger, and returns the search input. */
    function openAppearance() {
      renderDialog(makeInstanceName(), "appearance");
      fireEvent.click(screen.getByTestId("theme-picker-trigger"));
      return screen.getByRole("combobox", { name: "Search themes" });
    }

    it("the trigger shows the ACTIVE theme at rest; clicking it opens the popover", () => {
      renderDialog(makeInstanceName(), "appearance");
      const trigger = screen.getByTestId("theme-picker-trigger");
      // matchMedia mocks matches:false → system resolves light → Default Light.
      expect(trigger).toHaveTextContent("Default Light");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("listbox", { name: "Themes" })).not.toBeInTheDocument();
      fireEvent.click(trigger);
      // The trigger swaps to the focused search field with the list open.
      expect(screen.queryByTestId("theme-picker-trigger")).not.toBeInTheDocument();
      const input = screen.getByRole("combobox", { name: "Search themes" });
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input).toHaveFocus();
      expect(screen.getByRole("listbox", { name: "Themes" })).toBeInTheDocument();
    });

    it("filters themes by search query in the open popover", () => {
      const input = openAppearance();
      fireEvent.change(input, { target: { value: "gru" } });
      const list = screen.getByRole("listbox", { name: "Themes" });
      expect(within(list).getByText("Gruvbox Dark")).toBeInTheDocument();
      expect(within(list).getByText("Gruvbox Light")).toBeInTheDocument();
      expect(within(list).queryByText("Dracula")).not.toBeInTheDocument();
    });

    it("shows checkmarks on BOTH preferred slots (dark and light)", () => {
      openAppearance();
      const list = screen.getByRole("listbox", { name: "Themes" });
      const checked = within(list)
        .getAllByLabelText("Current theme")
        .map((el) => el.closest('[role="option"]')!);
      expect(checked).toHaveLength(2);
      const names = checked.map((row) => row.textContent);
      expect(names).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Default Dark"),
          expect.stringContaining("Default Light"),
        ]),
      );
    });

    it("clicking a theme commits it through setTheme, closes the popover, and updates the trigger", () => {
      openAppearance();
      const list = screen.getByRole("listbox", { name: "Themes" });
      fireEvent.click(within(list).getByText("Dracula"));
      expect(localStorage.getItem("hexokit-theme")).toBe("dracula");
      expect(localStorage.getItem("hexokit-theme-dark")).toBe("dracula");
      // The dialog stays open; the commit closes the popover and the trigger
      // now names the committed theme.
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      expect(screen.queryByRole("listbox", { name: "Themes" })).not.toBeInTheDocument();
      const trigger = screen.getByTestId("theme-picker-trigger");
      expect(trigger).toHaveTextContent("Dracula");
      // Reopening shows the DARK slot check moved to Dracula.
      fireEvent.click(trigger);
      const reopened = screen.getByRole("listbox", { name: "Themes" });
      const checkedNames = within(reopened)
        .getAllByLabelText("Current theme")
        .map((el) => el.closest('[role="option"]')!.textContent);
      expect(checkedNames).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Dracula"),
          expect.stringContaining("Default Light"),
        ]),
      );
    });

    it("Escape closes the POPOVER (not the dialog) and refocuses the trigger; an idle Escape closes the dialog", () => {
      const input = openAppearance();
      // ArrowDown starts a live preview in the open popover.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox", { name: "Themes" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      const trigger = screen.getByTestId("theme-picker-trigger");
      expect(trigger).toHaveFocus();
      // Nothing open or previewing now — Escape bubbles to the focus trap.
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("searching narrows the selection and Enter commits the first match", () => {
      const input = openAppearance();
      fireEvent.change(input, { target: { value: "drac" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(localStorage.getItem("hexokit-theme")).toBe("dracula");
    });
  });

  it("the Shortcuts tab mounts the ported shortcuts panel", () => {
    renderDialog();
    selectTab("Shortcuts");
    expect(screen.getByTestId("settings-shortcuts-panel")).toBeInTheDocument();
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
  });

  it("arrow keys rove the tablist and activate on focus", () => {
    renderDialog();
    const general = screen.getByRole("tab", { name: "General" });
    general.focus();
    fireEvent.keyDown(general.closest('[role="tablist"]')!, { key: "ArrowDown" });
    const appearance = screen.getByRole("tab", { name: "Appearance" });
    expect(appearance).toHaveFocus();
    expect(appearance).toHaveAttribute("aria-selected", "true");
    // Roving tabindex: the active tab is the list's one Tab stop.
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("tabindex", "-1");
    expect(appearance).toHaveAttribute("tabindex", "0");
    // The other axis works too, and wraps.
    fireEvent.keyDown(general.closest('[role="tablist"]')!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(general.closest('[role="tablist"]')!, { key: "ArrowUp" });
    expect(screen.getByRole("tab", { name: "All settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("a deep-linked open lands on the requested tab", () => {
    renderDialog(makeInstanceName(), "shortcuts");
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("settings-shortcuts-panel")).toBeInTheDocument();
  });

  it("shows the stored SSH host SETTING (empty when unset) and commits on blur", async () => {
    vi.mocked(getSettingsEntries).mockResolvedValue([registryEntry("ssh_host", "string", "devbox")]);
    renderDialog();
    const input = screen.getByLabelText("SSH host") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("devbox"));

    fireEvent.change(input, { target: { value: "user@host" } });
    fireEvent.blur(input);
    await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ ssh_host: "user@host" }));
  });

  it("clearing the SSH host commits null", async () => {
    vi.mocked(getSettingsEntries).mockResolvedValue([registryEntry("ssh_host", "string", "devbox")]);
    renderDialog();
    const input = screen.getByLabelText("SSH host") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("devbox"));

    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ ssh_host: null }));
  });

  it("a successful SSH host commit invalidates the open context (260723-l317)", async () => {
    vi.mocked(getSettingsEntries).mockResolvedValue([registryEntry("ssh_host", "string", "devbox")]);
    renderDialog();
    const input = screen.getByLabelText("SSH host") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("devbox"));

    fireEvent.change(input, { target: { value: "sahil@mini" } });
    fireEvent.blur(input);
    await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ ssh_host: "sahil@mini" }));
    await waitFor(() => expect(invalidateOpenContext).toHaveBeenCalledTimes(1));
  });

  it("a rejected SSH host commit does NOT invalidate the open context", async () => {
    vi.mocked(postSettings).mockRejectedValue(new Error("bad host"));
    renderDialog();
    const input = screen.getByLabelText("SSH host") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "dev box" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("bad host")).toBeInTheDocument());
    expect(invalidateOpenContext).not.toHaveBeenCalled();
  });

  it("a rejected SSH host commit surfaces an inline error and keeps the typed value", async () => {
    vi.mocked(postSettings).mockRejectedValue(
      new Error("SSH host cannot contain whitespace or control characters"),
    );
    renderDialog();
    const input = screen.getByLabelText("SSH host") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "dev box" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByText("SSH host cannot contain whitespace or control characters"),
      ).toBeInTheDocument(),
    );
    expect(input.value).toBe("dev box");
  });

  it("commits the instance name through the context (empty clears)", async () => {
    const value = makeInstanceName({ instanceName: "old-name", displayName: "old-name" });
    renderDialog(value);
    const input = screen.getByLabelText("Instance name") as HTMLInputElement;
    expect(input.value).toBe("old-name");

    fireEvent.change(input, { target: { value: "my-box" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(value.setInstanceName).toHaveBeenCalledWith("my-box");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(value.setInstanceName).toHaveBeenCalledWith(null);
  });

  describe("Easter eggs row (General → This host)", () => {
    const EGG_DESC = "Shows the screen-break Easter eggs: the fist and the eye.";

    it("renders checked with the registry description; clicking it commits easter_eggs: false", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue([
        { ...registryEntry("easter_eggs", "bool", true), description: EGG_DESC },
      ]);
      renderDialog();
      const toggle = screen.getByRole("switch", { name: "Easter eggs" });
      // The toggle reads ON before the fetch resolves (default-on), so only the
      // registry-sourced description proves the entries have landed.
      expect(await screen.findByText(EGG_DESC)).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-checked", "true");

      fireEvent.click(toggle);
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ easter_eggs: false }));
    });

    it("renders checked (default-on) when the entry is absent", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue([]);
      renderDialog();
      await waitFor(() => expect(getSettingsEntries).toHaveBeenCalled());
      expect(screen.getByRole("switch", { name: "Easter eggs" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });

  it("the instance-name placeholder is the real hostname (the unset fallback)", () => {
    renderDialog();
    const input = screen.getByLabelText("Instance name") as HTMLInputElement;
    expect(input.placeholder).toBe("mac-mini");
  });

  it("font stepper steps the shared ChromeContext preference", async () => {
    renderDialog();
    selectTab("Appearance");
    // Desktop default (matchMedia mocked to false) is 13px.
    expect(screen.getByText("13px")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal font" }));
    expect(screen.getByText("14px")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("13px")).toBeInTheDocument();
  });

  it("opens the color-only SwatchPopover from the accent control", async () => {
    renderDialog();
    selectTab("Appearance");
    fireEvent.click(screen.getByRole("button", { name: "Set instance color" }));
    // The popover's color band header − is the color-only marker ("Clear color" + ✕).
    expect(await screen.findByRole("option", { name: "Clear color" })).toBeInTheDocument();
  });

  it("uses the xl dialog variant (fixed height, max-w-4xl) with the 190px/1fr preference-row grid (260724-6j1v)", () => {
    renderDialog();
    // Tabbed preference pane: the shared Dialog's xl width variant.
    const panel = screen.getByRole("dialog", { name: "Settings" });
    expect(panel.className).toContain("max-w-4xl");
    expect(panel.className).toContain("h-[min(40rem,calc(100vh-2rem))]");
    // Each setting is a preference row — a two-column grid at ≥480px that
    // collapses to one column below (single markup path).
    const input = screen.getByLabelText("Instance name");
    const row = input.closest(".grid")!;
    expect(row.className).toContain("min-[480px]:grid-cols-[190px_1fr]");
    expect(row.className).toContain("grid-cols-1");
  });

  describe("Notifications row (260724-6j1v — moved from the top-bar bell)", () => {
    /** Render and flush the mount-time getPushState() promise. */
    async function renderWithPushState(state: string) {
      getPushState.mockResolvedValue(state);
      renderDialog();
      // The row label renders regardless of state; flush the async state fetch.
      await waitFor(() => expect(getPushState).toHaveBeenCalled());
    }

    it("shows the not-subscribed status with Enable and a disabled test button", async () => {
      await renderWithPushState("default");
      expect(screen.getByText("Notifications")).toBeInTheDocument();
      expect(await screen.findByText("Not subscribed")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();
    });

    it("shows the subscribed status and enables the test send", async () => {
      await renderWithPushState("subscribed");
      expect(await screen.findByText("Subscribed on this device")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
      const testBtn = screen.getByRole("button", { name: "Send test notification" });
      expect(testBtn).not.toBeDisabled();
      fireEvent.click(testBtn);
      await waitFor(() => expect(sendTestNotification).toHaveBeenCalledTimes(1));
    });

    it("calls enablePushSubscription when Enable is clicked", async () => {
      await renderWithPushState("default");
      await screen.findByText("Not subscribed");
      fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
      await waitFor(() => expect(enablePushSubscription).toHaveBeenCalledTimes(1));
    });

    it("shows the blocked status plus the re-allow note when denied", async () => {
      await renderWithPushState("denied");
      expect(await screen.findByText("Blocked in browser settings")).toBeInTheDocument();
      expect(
        screen.getByText(/Re-allow notifications for this site/),
      ).toBeInTheDocument();
    });

    it("explains absence with a note (no buttons) when push is unsupported", async () => {
      await renderWithPushState("unsupported");
      expect(await screen.findByText("Not supported in this browser")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send test notification" })).not.toBeInTheDocument();
    });

    it("links the setup & troubleshooting guide in a safe new tab", async () => {
      await renderWithPushState("default");
      await screen.findByText("Not subscribed");
      const guide = screen.getByRole("link", { name: /Setup & troubleshooting guide/ });
      expect(guide).toHaveAttribute("href", expect.stringContaining("docs/site/notifications.md"));
      expect(guide).toHaveAttribute("target", "_blank");
      expect(guide).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("renders shell-specific copy and suppresses browser guidance", async () => {
      Object.defineProperty(window, "runkitShell", {
        value: { version: "test", platform: "linux" },
        configurable: true,
        writable: true,
      });
      renderDialog();

      expect(await screen.findByText("Not enabled")).toBeInTheDocument();
      expect(screen.getByText("OS notifications from this app")).toBeInTheDocument();
      expect(screen.queryByText(/Re-allow notifications for this site/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /Setup & troubleshooting guide/ }),
      ).not.toBeInTheDocument();
      expect(getPushState).not.toHaveBeenCalled();
    });

    it("reports an enabled shell preference on this device", async () => {
      Object.defineProperty(window, "runkitShell", {
        value: { version: "test", platform: "linux" },
        configurable: true,
        writable: true,
      });
      localStorage.setItem("hexokit-shell-notifications", "on");
      renderDialog();
      expect(await screen.findByText("Enabled on this device")).toBeInTheDocument();
    });
  });

  it("Escape closes the dialog (focus-trap contract)", async () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument(),
    );
  });

  it("an armed rebind capture's Escape cancels the capture WITHOUT closing the dialog", async () => {
    renderDialog(makeInstanceName(), "shortcuts");
    fireEvent.click(screen.getByLabelText("Change binding for Next tab"));
    expect(screen.getByText("press keys…")).toBeInTheDocument();
    // The capture-phase listener stopPropagations — the focus trap never sees
    // this Escape, so only the capture cancels.
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("press keys…")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    // A second Escape (no capture armed) closes the dialog.
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument(),
    );
  });

  describe("All settings tab (260823-5r41 — the registry-driven table)", () => {
    it("renders rows from the registry payload grouped by category in registry order (ui:true only)", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-auto_name");

      const dialog = screen.getByRole("dialog", { name: "Settings" });
      // ui:false entries never render a row.
      expect(within(dialog).queryByTestId("setting-row-internal_only")).not.toBeInTheDocument();
      // Rows appear once, in registry order within their category groups, and
      // groups follow the registry's category order (title-cased headers).
      const order = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          '[data-testid^="setting-row-"], [class*="tracking-wider"]',
        ),
      ).map((el) => el.dataset.testid ?? el.textContent);
      expect(order).toEqual([
        "Appearance",
        "setting-row-theme",
        "setting-row-instance_color",
        "setting-row-server_colors",
        "Connectivity",
        "setting-row-ssh_host",
        "Identity",
        "setting-row-instance_name",
        "Behavior",
        "setting-row-auto_name",
        "Advanced",
        "setting-row-tmux_conf",
        "setting-row-log_level",
        "Layout",
        "setting-row-board_order",
      ]);
      // The escape-hatch footer carries the constant config path + copy button.
      expect(screen.getByTestId("settings-config-path-footer")).toHaveTextContent(
        "~/.config/hexokit/config.yaml",
      );
    });

    it("search filters rows over key/description/category and hides emptied headers", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-auto_name");

      const search = screen.getByRole("searchbox", { name: "Search settings" });
      fireEvent.change(search, { target: { value: "log" } });
      expect(screen.getByTestId("setting-row-log_level")).toBeInTheDocument();
      expect(screen.queryByTestId("setting-row-auto_name")).not.toBeInTheDocument();
      expect(screen.queryByText("Behavior")).not.toBeInTheDocument();
      expect(screen.getByText("Advanced")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "zzz-no-match" } });
      expect(screen.queryByTestId("setting-row-log_level")).not.toBeInTheDocument();
      expect(screen.getByText("No settings match “zzz-no-match”")).toBeInTheDocument();
    });

    it("the bool control commits postSettings({auto_name: true}) through the seam", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-auto_name");

      const toggle = within(screen.getByTestId("setting-row-auto_name")).getByRole("switch", {
        name: "auto_name",
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ auto_name: true }));
      // The row updates optimistically from the seam state.
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    });

    it("the enum control offers the entry's options and commits the pick", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-log_level");

      const select = within(screen.getByTestId("setting-row-log_level")).getByRole("combobox", {
        name: "log_level",
      }) as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toEqual(["info", "debug"]);
      expect(select.value).toBe("info");
      fireEvent.change(select, { target: { value: "debug" } });
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ log_level: "debug" }));
    });

    it("the theme mode select commits the per-mode slot id, never the mode word (real ThemeProvider)", async () => {
      // Regression cover for the mode→slot-id mapping: setTheme("dark"/"light")
      // would hit the context's unknown-id branch and persist theme:"system".
      // renderDialog mounts the REAL ThemeProvider, so postSettings sees the
      // actual setThemePreference payloads.
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      const themeSelect = (await screen.findByTestId("setting-row-theme")).querySelector(
        "select",
      ) as HTMLSelectElement;

      // Local-storage defaults: themeDark=default-dark, themeLight=default-light.
      fireEvent.change(themeSelect, { target: { value: "dark" } });
      await waitFor(() =>
        expect(postSettings).toHaveBeenCalledWith({ theme: "default-dark", theme_dark: "default-dark" }),
      );
      expect(postSettings).not.toHaveBeenCalledWith({ theme: "dark" });

      fireEvent.change(themeSelect, { target: { value: "light" } });
      await waitFor(() =>
        expect(postSettings).toHaveBeenCalledWith({ theme: "default-light", theme_light: "default-light" }),
      );
      expect(postSettings).not.toHaveBeenCalledWith({ theme: "light" });

      fireEvent.change(themeSelect, { target: { value: "system" } });
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ theme: "system" }));
    });

    it("the theme select falls back to the registry default (no commit) for an out-of-list named preference", async () => {
      // A stored named-theme preference is legal for the key but not an enum
      // option — the select must render the default, never a blank value.
      vi.mocked(getThemePreference).mockResolvedValue({
        theme: "default-dark",
        themeDark: "default-dark",
        themeLight: "default-light",
      });
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      const themeSelect = (await screen.findByTestId("setting-row-theme")).querySelector(
        "select",
      ) as HTMLSelectElement;
      await waitFor(() => expect(themeSelect.value).toBe("system"));
      // …without rewriting the stored preference.
      expect(postSettings).not.toHaveBeenCalledWith(expect.objectContaining({ theme: "system" }));
    });

    it("the modified dot tracks a context-backed key through the seam across toggle and reset (A-009)", async () => {
      // Structural R9 cover: the dot derives from settingValue, the same read
      // path as the control — a context write (no updateEntryValue involved)
      // flips it, and the reset flips it back. The previous test's provider can
      // leave a named-theme preference in localStorage; settle THIS provider on
      // system first (the fixture stores system) so the dot starts unmodified.
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-theme");
      const themeSelect = () =>
        screen.getByTestId("setting-row-theme").querySelector("select") as HTMLSelectElement;
      const dot = () => screen.getByTestId("modified-theme").className;

      // Drive to the fixture's stored value before asserting — a leaked
      // named-theme preference from the previous test resolves away on the
      // first user pick.
      fireEvent.change(themeSelect(), { target: { value: "dark" } });
      await waitFor(() => expect(dot()).toContain("bg-accent"));
      await waitFor(() =>
        expect(postSettings).toHaveBeenCalledWith({ theme: "default-dark", theme_dark: "default-dark" }),
      );

      fireEvent.change(themeSelect(), { target: { value: "system" } });
      await waitFor(() => expect(dot()).toContain("bg-transparent"));
    });

    it("the string control commits a trimmed patch on Enter and null when cleared", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      const input = (await screen.findByTestId("setting-row-ssh_host")).querySelector(
        "input",
      ) as HTMLInputElement;

      fireEvent.change(input, { target: { value: "user@host " } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ ssh_host: "user@host" }));

      fireEvent.change(input, { target: { value: "  " } });
      fireEvent.blur(input);
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ ssh_host: null }));
    });

    it("the modified dot tracks value-vs-default (a null unset scalar ≈ its empty default)", async () => {
      // The stored theme id rides the real ThemeProvider via the API preference.
      vi.mocked(getThemePreference).mockResolvedValue({
        theme: "default-dark",
        themeDark: "default-dark",
        themeLight: "default-light",
      });
      vi.mocked(getSettingsEntries).mockResolvedValue([
        allEntry({ key: "theme", kind: "enum", default: "system", options: ["system"], value: "default-dark" }),
        allEntry({ key: "ssh_host", kind: "string" }),
        allEntry({ key: "log_level", kind: "enum", default: "info", options: ["info"], value: "info" }),
        allEntry({ key: "auto_name", kind: "bool", default: "false", value: true }),
      ]);
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-theme");

      const cls = (key: string) => screen.getByTestId(`modified-${key}`).className;
      expect(cls("theme")).toContain("bg-accent");
      expect(cls("auto_name")).toContain("bg-accent");
      // Unset scalar (null value, "" default) and stored-equals-default are unmodified.
      expect(cls("ssh_host")).toContain("bg-transparent");
      expect(cls("log_level")).toContain("bg-transparent");
    });

    it("live:false rows carry the restart badge; live rows (auto_name) carry none", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-auto_name");

      expect(screen.getByTestId("restart-badge-log_level")).toHaveTextContent("requires restart");
      expect(screen.getByTestId("restart-badge-tmux_conf")).toBeInTheDocument();
      expect(screen.queryByTestId("restart-badge-auto_name")).not.toBeInTheDocument();
      expect(screen.queryByTestId("restart-badge-ssh_host")).not.toBeInTheDocument();
    });

    it("map/list rows render read-only summaries (no editable control)", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue([
        allEntry({
          key: "server_colors",
          kind: "map",
          default: "{}",
          description: "Per-server colors",
          category: "appearance",
          value: { alpha: "#123456", beta: "#654321" },
        }),
        allEntry({
          key: "board_order",
          kind: "list",
          default: "[]",
          description: "Pinned board order",
          category: "layout",
          value: ["work", "play"],
        }),
      ]);
      renderDialog(makeInstanceName(), "all");
      const colorsRow = await screen.findByTestId("setting-row-server_colors");
      expect(colorsRow).toHaveTextContent("2 entries");
      expect(colorsRow).toHaveTextContent("color picker in the sidebar");
      expect(colorsRow.querySelector("input,select,button")).toBeNull();

      const orderRow = screen.getByTestId("setting-row-board_order");
      expect(orderRow).toHaveTextContent("work → play");
      expect(orderRow).toHaveTextContent("board sidebar");
      expect(orderRow.querySelector("input,select,button")).toBeNull();
      // Non-default values still earn the modified dot on read-only rows.
      expect(screen.getByTestId("modified-server_colors").className).toContain("bg-accent");
      expect(screen.getByTestId("modified-board_order").className).toContain("bg-accent");
    });

    it("the escape-hatch copy button writes the constant path to the clipboard and confirms", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("settings-config-path-footer");

      const button = screen.getByRole("button", { name: "Copy config path" });
      fireEvent.click(button);
      await waitFor(() =>
        expect(copyToClipboard).toHaveBeenCalledWith("~/.config/hexokit/config.yaml"),
      );
      await waitFor(() => expect(button).toHaveTextContent("Copied"));
    });

    it("the General curated auto_name row commits the same patch as its table row (one seam)", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "general");
      await waitFor(() => expect(getSettingsEntries).toHaveBeenCalled());

      const curated = screen.getByRole("switch", { name: "Auto-name tabs" });
      expect(curated).toHaveAttribute("aria-checked", "false");
      fireEvent.click(curated);
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ auto_name: true }));

      // The one-seam drift guard: the table row reflects the curated write
      // with no refetch.
      selectTab("All settings");
      const tableToggle = within(screen.getByTestId("setting-row-auto_name")).getByRole("switch", {
        name: "auto_name",
      });
      expect(tableToggle).toHaveAttribute("aria-checked", "true");

      fireEvent.click(tableToggle);
      await waitFor(() => expect(postSettings).toHaveBeenCalledWith({ auto_name: false }));
      // … and the curated row reads the same seam state on the way back.
      selectTab("General");
      await waitFor(() =>
        expect(screen.getByRole("switch", { name: "Auto-name tabs" })).toHaveAttribute(
          "aria-checked",
          "false",
        ),
      );
    });

    it("a curated instance-name edit is visible to the table row (the R12 drift guard)", async () => {
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialogLiveName("general");
      await waitFor(() => expect(getSettingsEntries).toHaveBeenCalled());

      // Edit from the curated General row — the seam's context-routed write.
      const input = screen.getByLabelText("Instance name");
      fireEvent.change(input, { target: { value: "my-box" } });
      fireEvent.keyDown(input, { key: "Enter" });

      // The table row shows the edit without a refetch, and the modified dot
      // tracks the same seam state (value ≠ "" default).
      selectTab("All settings");
      const row = await screen.findByTestId("setting-row-instance_name");
      await waitFor(() =>
        expect((row.querySelector("input") as HTMLInputElement).value).toBe("my-box"),
      );
      expect(screen.getByTestId("modified-instance_name").className).toContain("bg-accent");

      // Clearing from the table row routes back through the context setter and
      // the dot returns to unmodified.
      const tableInput = row.querySelector("input") as HTMLInputElement;
      fireEvent.change(tableInput, { target: { value: "" } });
      fireEvent.blur(tableInput);
      await waitFor(() =>
        expect(screen.getByTestId("modified-instance_name").className).toContain("bg-transparent"),
      );
    });

    it("a rejected write surfaces inline on the row without clobbering the stored value", async () => {
      vi.mocked(postSettings).mockRejectedValue(new Error("auto_name must be a boolean"));
      vi.mocked(getSettingsEntries).mockResolvedValue(allSettingsFixture());
      renderDialog(makeInstanceName(), "all");
      await screen.findByTestId("setting-row-auto_name");

      const toggle = within(screen.getByTestId("setting-row-auto_name")).getByRole("switch", {
        name: "auto_name",
      });
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(
          within(screen.getByTestId("setting-row-auto_name")).getByRole("alert"),
        ).toHaveTextContent("auto_name must be a boolean"),
      );
      // No optimistic update survived the rejection.
      expect(toggle).toHaveAttribute("aria-checked", "false");
      await waitFor(() => expect(toggle).not.toBeDisabled());
    });
  });
});
