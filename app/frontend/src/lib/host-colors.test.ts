import { describe, it, expect } from "vitest";
import {
  classifyHostHex,
  HOST_COLOR_FAMILIES,
  hostColorClashMessage,
  hostColorValue,
  snapHostColor,
  usedHostHues,
} from "./host-colors";
import { colorValueToHex, DEFAULT_DARK_THEME } from "@/themes";

describe("host color set", () => {
  it("is the nine documented hues, violet included, orange and olive excluded", () => {
    expect([...HOST_COLOR_FAMILIES]).toEqual([
      "purple", "violet", "blue", "red", "green", "teal", "magenta", "slate", "amber",
    ]);
  });

  it("persists each member through the legacy write seam", () => {
    expect(hostColorValue("purple")).toBe("1+4");
    expect(hostColorValue("violet")).toBe("4+5");
    expect(hostColorValue("blue")).toBe("4");
    expect(hostColorValue("slate")).toBe("3+4");
    expect(hostColorValue("amber")).toBe("3");
  });
});

describe("snapHostColor", () => {
  it("keeps a set member as itself, in any form or shade", () => {
    expect(snapHostColor("4")).toBe("blue");
    expect(snapHostColor("4+5")).toBe("violet");
    expect(snapHostColor("teal-dark")).toBe("teal");
  });

  it("snaps an out-of-set family to the nearest hue", () => {
    // Orange (55°) is 30° from red and 35° from amber.
    expect(snapHostColor("1+3")).toBe("red");
    // Olive (120°) is 30° from both amber and green: the tie resolves by family order.
    expect(snapHostColor("olive")).toBe("amber");
  });

  it("returns null for no color or an unknown value", () => {
    expect(snapHostColor(null)).toBeNull();
    expect(snapHostColor("")).toBeNull();
    expect(snapHostColor("7")).toBeNull();
  });
});

describe("classifyHostHex", () => {
  it("round-trips each set member's rendered hex to the member", () => {
    for (const family of HOST_COLOR_FAMILIES) {
      const hex = colorValueToHex(family, DEFAULT_DARK_THEME.palette);
      expect(hex).not.toBeNull();
      expect(classifyHostHex(hex ?? "#000000")).toBe(family);
    }
  });

  it("reads a near-gray hex as slate", () => {
    expect(classifyHostHex("#808080")).toBe("slate");
  });
});

describe("usedHostHues + clash message", () => {
  const blue = colorValueToHex("blue", DEFAULT_DARK_THEME.palette) ?? "";
  const used = usedHostHues([
    { name: "ws-01", accentColor: blue },
    { name: "mac-mini", accentColor: blue },
    { name: "plain" },
  ]);

  it("groups other hosts by hue with monograms, skipping colorless hosts", () => {
    expect(used.get("blue")).toEqual({
      family: "blue",
      names: ["ws-01", "mac-mini"],
      monograms: ["W1", "MM"],
    });
    expect(used.size).toBe(1);
  });

  it("advises on a clash and stays silent otherwise", () => {
    expect(hostColorClashMessage("blue", used)).toBe(
      "Same color as ws-01, mac-mini. Pick another so the squares stay distinct.",
    );
    expect(hostColorClashMessage("red", used)).toBeNull();
    expect(hostColorClashMessage(null, used)).toBeNull();
  });
});
