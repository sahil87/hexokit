import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PALETTE_MRU_KEY,
  PALETTE_MRU_LIMIT,
  readPaletteMru,
  recordPaletteUse,
} from "./mru";

describe("readPaletteMru / recordPaletteUse", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("round-trips a recorded id under the named key", () => {
    expect(PALETTE_MRU_KEY).toBe("hexokit-palette-mru");
    recordPaletteUse("action-a");
    expect(readPaletteMru()).toEqual(["action-a"]);
  });

  it("prepends new ids most-recent-first", () => {
    recordPaletteUse("a");
    recordPaletteUse("b");
    expect(readPaletteMru()).toEqual(["b", "a"]);
  });

  it("front-dedupes a repeat use — no duplicate, id moves to the front", () => {
    recordPaletteUse("a");
    recordPaletteUse("b");
    const next = recordPaletteUse("a");
    expect(next).toEqual(["a", "b"]);
    expect(readPaletteMru()).toEqual(["a", "b"]);
  });

  it("evicts the oldest entry at the cap", () => {
    for (let i = 0; i < PALETTE_MRU_LIMIT; i++) recordPaletteUse(`id-${i}`);
    expect(readPaletteMru()).toHaveLength(PALETTE_MRU_LIMIT);
    recordPaletteUse("fresh");
    const list = readPaletteMru();
    expect(list).toHaveLength(PALETTE_MRU_LIMIT);
    expect(list[0]).toBe("fresh");
    expect(list).not.toContain("id-0");
  });

  it("returns [] when the key is absent", () => {
    expect(readPaletteMru()).toEqual([]);
  });

  it.each(["{}", "not json", "[1, 2]", '"just a string"'])(
    "returns [] for a malformed payload (%s)",
    (payload) => {
      localStorage.setItem(PALETTE_MRU_KEY, payload);
      expect(readPaletteMru()).toEqual([]);
    },
  );

  it("drops non-string entries from a hand-edited array", () => {
    localStorage.setItem(PALETTE_MRU_KEY, '["a", 1, null, "b"]');
    expect(readPaletteMru()).toEqual(["a", "b"]);
  });

  it("swallows a read failure (localStorage throwing) and returns []", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readPaletteMru()).toEqual([]);
  });

  it("swallows a write failure (quota / private mode) without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordPaletteUse("a")).not.toThrow();
  });
});
