import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ThemeProvider, useTheme, useThemeActions } from "./theme-context";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, getThemeById, deriveUIColors } from "@/themes";

// Mock the API client module so we don't make real HTTP calls in tests
vi.mock("@/api/client", () => ({
  getThemePreference: vi.fn().mockRejectedValue(new Error("no API in test")),
  setThemePreference: vi.fn().mockResolvedValue(undefined),
}));

function TestConsumer() {
  const { preference, themeDark, themeLight, resolved, theme } = useTheme();
  const { setTheme, previewTheme, cancelPreview } = useThemeActions();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="theme-dark">{themeDark}</span>
      <span data-testid="theme-light">{themeLight}</span>
      <span data-testid="resolved">{resolved}</span>
      <span data-testid="theme-id">{theme.id}</span>
      <span data-testid="theme-name">{theme.name}</span>
      <button onClick={() => setTheme("default-light")}>Set Light</button>
      <button onClick={() => setTheme("default-dark")}>Set Dark</button>
      <button onClick={() => setTheme("system")}>Set System</button>
      <button onClick={() => setTheme("dracula")}>Set Dracula</button>
      <button onClick={() => previewTheme(getThemeById("nord")!)}>Preview Nord</button>
      <button onClick={() => cancelPreview()}>Cancel Preview</button>
    </div>
  );
}

// Helper to mock matchMedia with a specific dark-mode preference
function mockMatchMedia(prefersDark: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      listeners.push(handler);
    }),
    removeEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));

  return {
    mql,
    simulateChange(newPrefersDark: boolean) {
      mql.matches = newPrefersDark;
      for (const listener of [...listeners]) {
        listener({ matches: newPrefersDark } as MediaQueryListEvent);
      }
    },
  };
}

describe("ThemeProvider", () => {
  let themeColorMeta: HTMLMetaElement;

  beforeEach(() => {
    localStorage.clear();
    mockMatchMedia(true); // Default to dark OS
    document.documentElement.dataset.theme = "dark";
    // Add theme-color meta tag to the DOM (as index.html provides it)
    themeColorMeta = document.createElement("meta");
    themeColorMeta.setAttribute("name", "theme-color");
    themeColorMeta.setAttribute("content", "#0f1117");
    document.head.appendChild(themeColorMeta);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
    // Clear inline styles set by applyThemeToDOM
    document.documentElement.removeAttribute("style");
    themeColorMeta.remove();
  });

  it("defaults to system preference when no localStorage value", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(screen.getByTestId("theme-dark").textContent).toBe("default-dark");
    expect(screen.getByTestId("theme-light").textContent).toBe("default-light");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(screen.getByTestId("theme-id").textContent).toBe("default-dark");
  });

  it("reads stored per-mode preferences from localStorage", () => {
    localStorage.setItem("hexokit-theme", "system");
    localStorage.setItem("hexokit-theme-dark", "dracula");
    localStorage.setItem("hexokit-theme-light", "default-light");
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(screen.getByTestId("theme-dark").textContent).toBe("dracula");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");
    expect(screen.getByTestId("theme-name").textContent).toBe("Dracula");
  });

  it("reads stored theme ID from localStorage", () => {
    localStorage.setItem("hexokit-theme", "dracula");
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("dracula");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");
    expect(screen.getByTestId("theme-name").textContent).toBe("Dracula");
  });

  it.each(["invalid", "dark", "light"])("treats stored %s as system", (stored) => {
    localStorage.setItem("hexokit-theme", stored);
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("system");
  });



  it("setTheme persists theme ID as preference", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("Set Light").click();
    });
    // Preference is the theme ID, per-mode slot is also updated
    expect(localStorage.getItem("hexokit-theme")).toBe("default-light");
    expect(localStorage.getItem("hexokit-theme-light")).toBe("default-light");
    expect(screen.getByTestId("preference").textContent).toBe("default-light");
    expect(screen.getByTestId("theme-light").textContent).toBe("default-light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(screen.getByTestId("theme-id").textContent).toBe("default-light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setTheme with named theme applies correct derived colors", () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("Set Dracula").click();
    });
    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");
    expect(document.documentElement.dataset.theme).toBe("dark");
    // bgPrimary is derived from palette.background
    expect(document.documentElement.style.getPropertyValue("--color-bg-primary")).toBe("#282a36");
  });

  it("setTheme to dark updates data-theme attribute", () => {
    // Start with light OS so default-light is active initially
    mockMatchMedia(false);
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText("Set Dark").click();
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  it("system preference with light OS resolves to light", () => {
    mockMatchMedia(false); // Light OS
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("preference").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(screen.getByTestId("theme-id").textContent).toBe("default-light");
  });

  it("listens to matchMedia changes when preference is system", () => {
    const { simulateChange } = mockMatchMedia(true);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("resolved").textContent).toBe("dark");

    // Simulate OS switching to light
    act(() => {
      simulateChange(false);
    });

    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(screen.getByTestId("theme-id").textContent).toBe("default-light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("uses per-mode prefs when OS changes in system mode", () => {
    localStorage.setItem("hexokit-theme", "system");
    localStorage.setItem("hexokit-theme-dark", "dracula");
    localStorage.setItem("hexokit-theme-light", "default-light");
    const { simulateChange } = mockMatchMedia(true);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    // Should use custom dark theme
    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");

    // Simulate OS switching to light — uses custom light theme
    act(() => {
      simulateChange(false);
    });
    expect(screen.getByTestId("theme-id").textContent).toBe("default-light");
  });

  it("ignores matchMedia changes when preference is explicit theme", () => {
    localStorage.setItem("hexokit-theme", "dracula");
    const { simulateChange } = mockMatchMedia(true);

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");

    // Simulate OS switching to light — should be ignored
    act(() => {
      simulateChange(false);
    });

    expect(screen.getByTestId("theme-id").textContent).toBe("dracula");
  });

  describe("preview/cancel", () => {
    it("previewTheme applies colors without persisting", () => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      act(() => {
        screen.getByText("Preview Nord").click();
      });

      expect(screen.getByTestId("theme-id").textContent).toBe("nord");
      expect(document.documentElement.style.getPropertyValue("--color-bg-primary")).toBe("#2e3440");
      // localStorage should still be "system" (the default)
      expect(localStorage.getItem("hexokit-theme")).toBeNull();
    });

    it("cancelPreview reverts to persisted theme", () => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      // Preview Nord
      act(() => {
        screen.getByText("Preview Nord").click();
      });
      expect(screen.getByTestId("theme-id").textContent).toBe("nord");

      // Cancel — should revert to default dark (system preference)
      act(() => {
        screen.getByText("Cancel Preview").click();
      });
      expect(screen.getByTestId("theme-id").textContent).toBe("default-dark");
      expect(document.documentElement.style.getPropertyValue("--color-bg-primary")).toBe("#0f1117");
    });

    it("setTheme after preview clears preview state", () => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      // Preview Nord
      act(() => {
        screen.getByText("Preview Nord").click();
      });

      // Confirm with setTheme
      act(() => {
        screen.getByText("Set Dracula").click();
      });

      expect(screen.getByTestId("theme-id").textContent).toBe("dracula");
      // Preference is the theme ID, per-mode dark is also updated
      expect(localStorage.getItem("hexokit-theme")).toBe("dracula");
      expect(localStorage.getItem("hexokit-theme-dark")).toBe("dracula");
    });
  });

  describe("theme-color meta tag synchronization", () => {
    // The meta follows the CHROME hex (the top bar's surface — the titlebar's
    // truthful neighbor), not the terminal background.
    it.each([
      { button: "Set Dark", expected: deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome },
      { button: "Set Light", expected: deriveUIColors(DEFAULT_LIGHT_THEME.palette, "light").bgChrome },
      { button: "Set Dracula", expected: deriveUIColors(getThemeById("dracula")!.palette, "dark").bgChrome },
    ])("syncs theme-color after $button", ({ button, expected }) => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );
      act(() => {
        screen.getByText(button).click();
      });
      expect(themeColorMeta.getAttribute("content")).toBe(expected);
    });



    it("updates theme-color when OS preference changes in system mode", () => {
      const { simulateChange } = mockMatchMedia(true);

      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      // System mode starts with dark OS
      expect(themeColorMeta.getAttribute("content")).toBe(
        deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome,
      );

      // OS switches to light
      act(() => {
        simulateChange(false);
      });
      expect(themeColorMeta.getAttribute("content")).toBe(
        deriveUIColors(DEFAULT_LIGHT_THEME.palette, "light").bgChrome,
      );
    });
  });

  describe("CSS custom properties", () => {
    it("applies all 11 CSS custom properties via deriveUIColors to document.documentElement.style", () => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      const style = document.documentElement.style;
      const derived = deriveUIColors(DEFAULT_DARK_THEME.palette, "dark");
      expect(style.getPropertyValue("--color-bg-primary")).toBe(derived.bgPrimary);
      expect(style.getPropertyValue("--color-bg-card")).toBe(derived.bgCard);
      expect(style.getPropertyValue("--color-bg-inset")).toBe(derived.bgInset);
      expect(style.getPropertyValue("--color-bg-chrome")).toBe(derived.bgChrome);
      expect(style.getPropertyValue("--color-bg-chrome-raised")).toBe(derived.bgChromeRaised);
      expect(style.getPropertyValue("--color-text-primary")).toBe(derived.textPrimary);
      expect(style.getPropertyValue("--color-text-secondary")).toBe(derived.textSecondary);
      expect(style.getPropertyValue("--color-border")).toBe(derived.border);
      expect(style.getPropertyValue("--color-accent")).toBe(derived.accent);
      expect(style.getPropertyValue("--color-accent-bright")).toBe(derived.accentBright);
      expect(style.getPropertyValue("--color-accent-green")).toBe(derived.accentGreen);
    });

    it("sets color-scheme CSS property", () => {
      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );
      expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");

      act(() => {
        screen.getByText("Set Light").click();
      });
      expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
    });
  });

  describe("API persistence", () => {
    it("setTheme calls setThemePreference fire-and-forget with theme ID", async () => {
      const { setThemePreference } = await import("@/api/client");
      vi.mocked(setThemePreference).mockClear();

      render(
        <ThemeProvider>
          <TestConsumer />
        </ThemeProvider>,
      );

      act(() => {
        screen.getByText("Set Dracula").click();
      });

      expect(setThemePreference).toHaveBeenCalledWith({
        theme: "dracula",
        themeDark: "dracula",
      });
    });
  });
});
