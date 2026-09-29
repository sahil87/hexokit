import { describe, it, expect, beforeEach } from "vitest";
import {
  migrateLegacyStorageKeys,
  migratedKeyName,
  STORAGE_MIGRATION_MARKER_KEY,
} from "./legacy-storage-migration";

/** A Storage whose every method throws — the blocked-storage shape. */
function throwingStorage(): Storage {
  const thrower = () => {
    throw new Error("blocked");
  };
  return {
    get length(): number {
      throw new Error("blocked");
    },
    clear: thrower,
    getItem: thrower,
    key: thrower,
    removeItem: thrower,
    setItem: thrower,
  } as Storage;
}

describe("migrateLegacyStorageKeys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("copies runkit- and runkit: keys to their hexokit counterparts", () => {
    localStorage.setItem("runkit-theme", "dark");
    localStorage.setItem("runkit-sidebar-width", "220");
    localStorage.setItem("runkit:board-autofit:main", "off");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-theme")).toBe("dark");
    expect(localStorage.getItem("hexokit-sidebar-width")).toBe("220");
    expect(localStorage.getItem("hexokit:board-autofit:main")).toBe("off");
    expect(localStorage.getItem(STORAGE_MIGRATION_MARKER_KEY)).toBe("1");
  });

  it("leaves the legacy keys in place", () => {
    localStorage.setItem("runkit-theme", "dark");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("runkit-theme")).toBe("dark");
  });

  it("does not overwrite an existing hexokit key", () => {
    localStorage.setItem("runkit-theme", "dark");
    localStorage.setItem("hexokit-theme", "light");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-theme")).toBe("light");
  });

  it("does not touch rk-* substrate keys or unrelated keys", () => {
    localStorage.setItem("rk-gui-posture", "wm");
    localStorage.setItem("runkitShellConfig", "x");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-gui-posture")).toBeNull();
    expect(localStorage.getItem("rk-gui-posture")).toBe("wm");
  });

  it("excludes the retired-key translators, which keep reading the legacy names", () => {
    localStorage.setItem("runkit-window-view:srv:@3", "code");
    localStorage.setItem("runkit-window-panel:srv:@3", "web");
    localStorage.setItem("runkit-code-folder:srv:@3", "/repo");
    localStorage.setItem("runkit-panel-sessions", "false");
    localStorage.setItem("runkit-operator-console-geometry", "{}");
    // A live key sharing the retired key's stem still migrates.
    localStorage.setItem("runkit-panel-sessions-scope", "all");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-window-view:srv:@3")).toBeNull();
    expect(localStorage.getItem("hexokit-window-panel:srv:@3")).toBeNull();
    expect(localStorage.getItem("hexokit-code-folder:srv:@3")).toBeNull();
    expect(localStorage.getItem("hexokit-panel-sessions")).toBeNull();
    expect(localStorage.getItem("hexokit-operator-console-geometry")).toBeNull();
    expect(localStorage.getItem("hexokit-panel-sessions-scope")).toBe("all");
  });

  it("does not resurrect a key deleted after migration (marker guard)", () => {
    localStorage.setItem("runkit-sidebar-width", "220");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-sidebar-width")).toBe("220");
    // The app deletes the key to mean "default".
    localStorage.removeItem("hexokit-sidebar-width");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-sidebar-width")).toBeNull();
  });

  it("a pre-set marker skips the copy entirely", () => {
    localStorage.setItem(STORAGE_MIGRATION_MARKER_KEY, "1");
    localStorage.setItem("runkit-theme", "dark");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-theme")).toBeNull();
  });

  it("swallows a throwing storage instead of breaking boot", () => {
    expect(() => migrateLegacyStorageKeys(throwingStorage())).not.toThrow();
  });

  it("uses the origin localStorage by default", () => {
    localStorage.setItem("runkit-macros", "[]");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("hexokit-macros")).toBe("[]");
  });

  it("migratedKeyName swaps only the prefix", () => {
    expect(migratedKeyName("runkit-theme")).toBe("hexokit-theme");
    expect(migratedKeyName("runkit:board-widths:b")).toBe("hexokit:board-widths:b");
  });
});
