import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  ChromeProvider,
  useChromeState,
  useChromeDispatch,
  TERMINAL_FONT_BOUNDS,
} from "./chrome-context";

const FONT_KEY = "hexokit-terminal-font-size";

function FontConsumer() {
  const { terminalFontSize } = useChromeState();
  const { increaseTerminalFont, decreaseTerminalFont, resetTerminalFont } = useChromeDispatch();
  return (
    <div>
      <span data-testid="size">{terminalFontSize}</span>
      <button onClick={increaseTerminalFont}>inc</button>
      <button onClick={decreaseTerminalFont}>dec</button>
      <button onClick={resetTerminalFont}>reset</button>
    </div>
  );
}

function renderConsumer() {
  return render(
    <ChromeProvider>
      <FontConsumer />
    </ChromeProvider>,
  );
}

const size = () => Number(screen.getByTestId("size").textContent);
const click = (name: string) => act(() => { fireEvent.click(screen.getByText(name)); });

/** Stub matchMedia so isMobileViewport() resolves deterministically. The
 * provider treats narrow width OR coarse pointer as mobile. */
function mockViewport(mobile: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: mobile,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

describe("ChromeProvider terminal font size", () => {
  beforeEach(() => {
    localStorage.clear();
    mockViewport(false); // default to desktop
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // restoreAllMocks does not undo stubGlobal — unstub matchMedia explicitly
    // so the viewport stub cannot leak into other suites.
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("exports bounds 8-24 step 1", () => {
    expect(TERMINAL_FONT_BOUNDS).toEqual({ min: 8, max: 24, step: 1 });
  });

  it("defaults to the desktop device default (13) when unset", () => {
    renderConsumer();
    expect(size()).toBe(13);
    expect(localStorage.getItem(FONT_KEY)).toBeNull();
  });

  it("defaults to the mobile device default (11) when unset on a mobile viewport", () => {
    mockViewport(true);
    renderConsumer();
    expect(size()).toBe(11);
  });

  it("reads and clamps a stored preference on init", () => {
    localStorage.setItem(FONT_KEY, "18");
    renderConsumer();
    expect(size()).toBe(18);
  });

  it.each([["999", 24], ["3", 8]] as const)("clamps stored %s to %s", (stored, expected) => {
    localStorage.setItem(FONT_KEY, stored);
    renderConsumer();
    expect(size()).toBe(expected);
  });

  it("first increase from the unset state steps off the device default and persists (desktop 13 -> 14)", () => {
    renderConsumer();
    expect(size()).toBe(13);
    expect(localStorage.getItem(FONT_KEY)).toBeNull();
    click("inc");
    expect(size()).toBe(14);
    expect(localStorage.getItem(FONT_KEY)).toBe("14");
  });

  it("first decrease from the unset state steps off the device default and persists (desktop 13 -> 12)", () => {
    renderConsumer();
    click("dec");
    expect(size()).toBe(12);
    expect(localStorage.getItem(FONT_KEY)).toBe("12");
  });

  it.each([
    { stored: "23", action: "inc", expected: 24 },
    { stored: "9", action: "dec", expected: 8 },
  ])("$action clamps at $expected", ({ stored, action, expected }) => {
    localStorage.setItem(FONT_KEY, stored);
    renderConsumer();
    click(action);
    expect(size()).toBe(expected);
    click(action);
    expect(size()).toBe(expected);
    expect(localStorage.getItem(FONT_KEY)).toBe(String(expected));
  });

  it("reset forgets the preference (removes the key) and reverts to the device default", () => {
    localStorage.setItem(FONT_KEY, "20");
    renderConsumer();
    expect(size()).toBe(20);
    click("reset");
    expect(localStorage.getItem(FONT_KEY)).toBeNull();
    expect(size()).toBe(13); // desktop default
  });

  it("reset reverts to the mobile default on a mobile viewport", () => {
    mockViewport(true);
    localStorage.setItem(FONT_KEY, "20");
    renderConsumer();
    click("reset");
    expect(size()).toBe(11);
  });

  it("survives a localStorage write throw without breaking (try/catch noop)", () => {
    renderConsumer();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    // Should not throw; state still updates even though persistence failed.
    expect(() => click("inc")).not.toThrow();
    expect(size()).toBe(14);
    setItem.mockRestore();
  });
});

// Each preference names its DEFAULT: the compose strip is on by default (only
// an explicit stored "false" reads off), scroll lock is off by default.
const booleanPreferences = [
  { name: "compose strip", key: "hexokit-compose-strip", defaultValue: true },
  { name: "scroll lock", key: "hexokit-scroll-lock", defaultValue: false },
] as const;

type BooleanPreferenceName = (typeof booleanPreferences)[number]["name"];

function BooleanPreferenceConsumer({ name }: { name: BooleanPreferenceName }) {
  const { composeStripEnabled, composeStripDefaulted, scrollLocked } = useChromeState();
  const { toggleComposeStrip, setScrollLocked } = useChromeDispatch();
  const value = name === "compose strip" ? composeStripEnabled : scrollLocked;
  const toggle = name === "compose strip"
    ? toggleComposeStrip
    : () => setScrollLocked(!scrollLocked);
  return (
    <div>
      <span data-testid="boolean-value">{String(value)}</span>
      <span data-testid="compose-defaulted">{String(composeStripDefaulted)}</span>
      <button onClick={toggle}>toggle</button>
    </div>
  );
}

function renderBooleanPreference(name: BooleanPreferenceName) {
  return render(
    <ChromeProvider>
      <BooleanPreferenceConsumer name={name} />
    </ChromeProvider>,
  );
}

const booleanValue = () => screen.getByTestId("boolean-value").textContent;

describe("ChromeProvider boolean preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    mockViewport(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each(booleanPreferences)("$name defaults to $defaultValue when unset", ({ name, key, defaultValue }) => {
    renderBooleanPreference(name);
    expect(booleanValue()).toBe(String(defaultValue));
    // The default is never written back — only a toggle stores a value.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each(booleanPreferences)("$name rehydrates an enabled preference", ({ name, key }) => {
    localStorage.setItem(key, "true");
    renderBooleanPreference(name);
    expect(booleanValue()).toBe("true");
  });

  it.each(booleanPreferences)("$name toggles away from its default and persists", ({ name, key, defaultValue }) => {
    renderBooleanPreference(name);
    click("toggle");
    expect(booleanValue()).toBe(String(!defaultValue));
    expect(localStorage.getItem(key)).toBe(String(!defaultValue));
  });

  it.each(booleanPreferences)("$name toggles off and persists", ({ name, key }) => {
    localStorage.setItem(key, "true");
    renderBooleanPreference(name);
    click("toggle");
    expect(booleanValue()).toBe("false");
    expect(localStorage.getItem(key)).toBe("false");
  });

  it.each(booleanPreferences)("$name survives a storage write failure", ({ name, defaultValue }) => {
    renderBooleanPreference(name);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => click("toggle")).not.toThrow();
    expect(booleanValue()).toBe(String(!defaultValue));
    setItem.mockRestore();
  });

  it("scroll lock degrades to false for a corrupt stored value", () => {
    localStorage.setItem("hexokit-scroll-lock", "banana");
    renderBooleanPreference("scroll lock");
    expect(booleanValue()).toBe("false");
  });

  it("compose strip: an explicit stored \"false\" is the only opt-out", () => {
    localStorage.setItem("hexokit-compose-strip", "false");
    renderBooleanPreference("compose strip");
    expect(booleanValue()).toBe("false");
  });

  it("compose strip: a corrupt stored value reads as the default (on)", () => {
    localStorage.setItem("hexokit-compose-strip", "banana");
    renderBooleanPreference("compose strip");
    expect(booleanValue()).toBe("true");
  });

  it("compose strip: an unreadable store reads as the default (on) and still toggles off", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    renderBooleanPreference("compose strip");
    expect(booleanValue()).toBe("true");
    getItem.mockRestore();
    click("toggle");
    expect(booleanValue()).toBe("false");
  });

  it("composeStripDefaulted reflects whether the value was stored at mount, read once", () => {
    renderBooleanPreference("compose strip");
    expect(screen.getByTestId("compose-defaulted").textContent).toBe("true");
    // A toggle writes the key, but the read-once flag never changes.
    click("toggle");
    expect(localStorage.getItem("hexokit-compose-strip")).toBe("false");
    expect(screen.getByTestId("compose-defaulted").textContent).toBe("true");
    cleanup();
    localStorage.setItem("hexokit-compose-strip", "true");
    renderBooleanPreference("compose strip");
    expect(screen.getByTestId("compose-defaulted").textContent).toBe("false");
  });
});
