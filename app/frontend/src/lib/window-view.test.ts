import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasWebUrl,
  activeWebUrl,
  hasCode,
  hasGui,
  availableViews,
  windowViewStorageKey,
  readStoredView,
  type ViewWindow,
} from "./window-view";

const tabsWin: ViewWindow = { webTabs: ["http://localhost:8080"] };
const twoTabsWin: ViewWindow = {
  webTabs: ["/proxy/3000/", "/present/@7/2/x.html"],
  webActive: 2,
};
const emptyTabsWin: ViewWindow = { webTabs: [] };
const plain: ViewWindow = {};

describe("hasWebUrl", () => {
  it("is true when the window carries at least one web tab", () => {
    expect(hasWebUrl(tabsWin)).toBe(true);
    expect(hasWebUrl(twoTabsWin)).toBe(true);
  });

  it("is false for an empty or missing tab family", () => {
    expect(hasWebUrl(emptyTabsWin)).toBe(false);
    expect(hasWebUrl(plain)).toBe(false);
    expect(hasWebUrl(null)).toBe(false);
    expect(hasWebUrl(undefined)).toBe(false);
  });
});

describe("activeWebUrl", () => {
  it("returns the webActive slot of the family (1-based)", () => {
    expect(activeWebUrl(twoTabsWin)).toBe("/present/@7/2/x.html");
    expect(activeWebUrl(tabsWin)).toBe("http://localhost:8080");
  });

  it("returns \"\" for an empty or missing family", () => {
    expect(activeWebUrl(emptyTabsWin)).toBe("");
    expect(activeWebUrl(plain)).toBe("");
    expect(activeWebUrl(null)).toBe("");
  });

  it("falls back to slot 1 when webActive is 0/absent", () => {
    expect(activeWebUrl({ webTabs: ["a"], webActive: 0 })).toBe("a");
    expect(activeWebUrl({ webTabs: ["a", "b"] })).toBe("a");
  });

  it("returns \"\" when webActive points out of range", () => {
    expect(activeWebUrl({ webTabs: ["a"], webActive: 5 })).toBe("");
  });
});

describe("hasCode", () => {
  it("is true with a shared codeRoot alone — a tab stays code-capable after its active pane leaves the repo", () => {
    expect(hasCode({ codeRoot: "/repo" })).toBe(true);
    expect(hasCode({ codeRoot: "/repo", gitRoot: "" })).toBe(true);
  });

  it("is true with a derived gitRoot alone (the pre-seed fallback)", () => {
    expect(hasCode({ gitRoot: "/repo" })).toBe(true);
    expect(hasCode({ codeRoot: "", gitRoot: "/repo" })).toBe(true);
  });

  it("is false when neither root exists", () => {
    expect(hasCode(plain)).toBe(false);
    expect(hasCode({ codeRoot: "", gitRoot: "" })).toBe(false);
    expect(hasCode(null)).toBe(false);
    expect(hasCode(undefined)).toBe(false);
  });
});

describe("hasGui", () => {
  it("is true only when the host signal's enabled is exactly true", () => {
    expect(hasGui({ enabled: true })).toBe(true);
    expect(hasGui({ enabled: false })).toBe(false);
  });

  it("reads an absent signal as not available (never on by default)", () => {
    expect(hasGui(null)).toBe(false);
    expect(hasGui(undefined)).toBe(false);
  });
});

describe("availableViews", () => {
  it("always offers web + tty, tabs or not — availability is unconditional; hasWebUrl selects content", () => {
    expect(availableViews(tabsWin)).toEqual(["web", "tty"]);
    expect(availableViews(emptyTabsWin)).toEqual(["web", "tty"]);
    expect(availableViews(plain)).toEqual(["web", "tty"]);
  });

  it("tolerates null/undefined windows", () => {
    expect(availableViews(null)).toEqual(["web", "tty"]);
    expect(availableViews(undefined)).toEqual(["web", "tty"]);
  });

  // The `code` lens: available exactly when hasCode holds (a shared codeRoot
  // or the derived gitRoot); reachability governs content, not availability.
  it("offers code when gitRoot is set", () => {
    const codeWin: ViewWindow = { gitRoot: "/repo" };
    expect(availableViews(codeWin)).toEqual(["code", "web", "tty"]);
  });

  it("gates code off without a gitRoot or codeRoot", () => {
    expect(availableViews(plain)).toEqual(["web", "tty"]);
    expect(availableViews(null)).toEqual(["web", "tty"]);
  });

  it("stacks code + web + tty in registry order", () => {
    const all: ViewWindow = {
      gitRoot: "/repo",
      webTabs: ["http://localhost:8080"],
    };
    expect(availableViews(all)).toEqual(["code", "web", "tty"]);
  });

  // The `gui` lens: a per-host capability keyed off the signal's `enabled`,
  // never reachability — an unreachable or absent host changes nothing.
  it("offers gui after code when the host signal is enabled", () => {
    const codeWin: ViewWindow = { codeRoot: "/repo" };
    expect(availableViews(codeWin, { enabled: true })).toEqual([
      "code",
      "gui",
      "web",
      "tty",
    ]);
  });

  it("gates gui off when the host is disabled, unreachable-only, or absent", () => {
    const codeWin: ViewWindow = { codeRoot: "/repo" };
    expect(availableViews(codeWin, { enabled: false })).toEqual([
      "code",
      "web",
      "tty",
    ]);
    expect(availableViews(codeWin, null)).toEqual(["code", "web", "tty"]);
    expect(availableViews(codeWin)).toEqual(["code", "web", "tty"]);
  });
});

describe("localStorage helpers (value-bearing key, try/catch-noop)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("builds a value-bearing per-window key", () => {
    expect(windowViewStorageKey("srv", "@3")).toBe("runkit-window-view:srv:@3");
  });

  it("reads a stored view under the window's key (absent = undefined)", () => {
    expect(readStoredView("srv", "@3")).toBeUndefined();
    localStorage.setItem(windowViewStorageKey("srv", "@3"), "web");
    expect(readStoredView("srv", "@3")).toBe("web");
    localStorage.setItem(windowViewStorageKey("srv", "@3"), "tty");
    expect(readStoredView("srv", "@3")).toBe("tty");
  });

  it("scopes keys per (server, windowId)", () => {
    localStorage.setItem(windowViewStorageKey("srv", "@3"), "web");
    expect(readStoredView("srv", "@4")).toBeUndefined();
    expect(readStoredView("other", "@3")).toBeUndefined();
  });

  it("swallows a localStorage read failure, returning undefined", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredView("srv", "@3")).toBeUndefined();
  });
});
