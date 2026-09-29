import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import {
  LAST_WINDOW_KEY_PREFIX,
  lastWindowStorageKey,
  readLastWindow,
  writeLastWindow,
  resolveServerLandingWindow,
} from "./last-window-per-server";

// These helpers back the server-switch landing resolution (sidebar tile,
// palette `Server: Switch to`, Host page tile). Covering read/write
// persistence and the pure resolver's four-step order proves that behavior
// without mounting the shell.

describe("readLastWindow / writeLastWindow", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("composes the per-server key from the named prefix", () => {
    expect(LAST_WINDOW_KEY_PREFIX).toBe("hexokit-last-window:");
    expect(lastWindowStorageKey("work")).toBe("hexokit-last-window:work");
  });

  it("round-trips a written window id per server", () => {
    writeLastWindow("work", "@3");
    expect(localStorage.getItem("hexokit-last-window:work")).toBe("@3");
    expect(readLastWindow("work")).toBe("@3");
    expect(readLastWindow("home")).toBeNull();
  });

  it("returns null when no value has been written", () => {
    expect(readLastWindow("work")).toBeNull();
  });

  it("swallows a read failure (localStorage throwing) and returns null", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readLastWindow("work")).toBeNull();
  });

  it("swallows a write failure (quota / private mode) without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeLastWindow("work", "@3")).not.toThrow();
  });
});

describe("resolveServerLandingWindow", () => {
  const sessions = [
    makeSession({
      name: "api",
      windows: [
        makeWindow({ windowId: "@1", isActiveWindow: true }),
        makeWindow({ windowId: "@2" }),
      ],
    }),
    makeSession({ name: "web", windows: [makeWindow({ windowId: "@5" })] }),
  ];
  const sessionOrder = ["api", "web"];

  it("returns the remembered window when it is present in the live snapshot", () => {
    expect(
      resolveServerLandingWindow({ sessions, sessionOrder, remembered: "@5" }),
    ).toBe("@5");
  });

  it("falls through to the derived pick when the remembered window is gone", () => {
    expect(
      resolveServerLandingWindow({ sessions, sessionOrder, remembered: "@9" }),
    ).toBe("@1");
  });

  it("returns the remembered window optimistically when the snapshot is empty", () => {
    expect(
      resolveServerLandingWindow({ sessions: [], sessionOrder: [], remembered: "@3" }),
    ).toBe("@3");
  });

  it("picks the first session in the effective order, then its active window", () => {
    const ordered = ["web", "api"];
    const withActive = [
      makeSession({ name: "api", windows: [makeWindow({ windowId: "@1" })] }),
      makeSession({
        name: "web",
        windows: [
          makeWindow({ windowId: "@5", isActiveWindow: true }),
          makeWindow({ windowId: "@6" }),
        ],
      }),
    ];
    expect(
      resolveServerLandingWindow({
        sessions: withActive,
        sessionOrder: ordered,
        remembered: null,
      }),
    ).toBe("@5");
  });

  it("falls back to windows[0] when the chosen session has no active window", () => {
    expect(
      resolveServerLandingWindow({
        sessions: [
          makeSession({
            name: "api",
            windows: [makeWindow({ windowId: "@2" }), makeWindow({ windowId: "@1" })],
          }),
        ],
        sessionOrder: ["api"],
        remembered: null,
      }),
    ).toBe("@2");
  });

  it("skips ordered sessions absent from the snapshot", () => {
    expect(
      resolveServerLandingWindow({
        sessions: [makeSession({ name: "web", windows: [makeWindow({ windowId: "@5" })] })],
        sessionOrder: ["gone", "web"],
        remembered: null,
      }),
    ).toBe("@5");
  });

  it("returns null when the server has no sessions", () => {
    expect(
      resolveServerLandingWindow({ sessions: [], sessionOrder: [], remembered: null }),
    ).toBeNull();
  });

  it("returns null when the chosen session has no windows", () => {
    expect(
      resolveServerLandingWindow({
        sessions: [makeSession({ name: "api", windows: [] })],
        sessionOrder: ["api"],
        remembered: null,
      }),
    ).toBeNull();
  });
});
