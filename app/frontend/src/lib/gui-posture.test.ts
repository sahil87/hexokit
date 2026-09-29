import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GUI_QUALITY_PRESETS,
  GUI_ZOOM_STEPS,
  readGuiQuality,
  nextGuiQuality,
  GUI_QUALITY_LABELS,
  GUI_QUALITY_ORDER,
  readGuiStatsVisible,
  readGuiZoom,
  writeGuiQuality,
  writeGuiStatsVisible,
  writeGuiZoom,
  stepGuiZoom,
  readGuiPointerMode,
  writeGuiPointerMode,
  readGuiResizeLocked,
  writeGuiResizeLocked,
  readGuiWmStripDismissed,
  writeGuiWmStripDismissed,
  readGuiHidpi,
  writeGuiHidpi,
  readGuiKeyBarVisible,
  writeGuiKeyBarVisible,
  readGuiToolbarVisible,
  writeGuiToolbarVisible,
  readGuiCapture,
  writeGuiCapture,
  zoomedHostSize,
} from "./gui-posture";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("gui zoom posture (rk-gui-zoom)", () => {
  it("defaults to fit when absent or invalid", () => {
    expect(readGuiZoom()).toBe("fit");
    localStorage.setItem("rk-gui-zoom", "999");
    expect(readGuiZoom()).toBe("fit");
    localStorage.setItem("rk-gui-zoom", "zoom");
    expect(readGuiZoom()).toBe("fit");
    localStorage.setItem("rk-gui-zoom", "100.5");
    expect(readGuiZoom()).toBe("fit");
  });

  it("reads each stored percentage as its number", () => {
    for (const step of GUI_ZOOM_STEPS) {
      localStorage.setItem("rk-gui-zoom", String(step));
      expect(readGuiZoom()).toBe(step);
    }
  });

  it("round-trips every step and fit", () => {
    for (const step of GUI_ZOOM_STEPS) {
      writeGuiZoom(step);
      expect(readGuiZoom()).toBe(step);
      expect(localStorage.getItem("rk-gui-zoom")).toBe(String(step));
    }
    writeGuiZoom("fit");
    expect(readGuiZoom()).toBe("fit");
    expect(localStorage.getItem("rk-gui-zoom")).toBe("fit");
  });

  it("migrates a legacy rk-gui-view of 1:1 to 100", () => {
    localStorage.setItem("rk-gui-view", "1:1");
    expect(readGuiZoom()).toBe(100);
  });

  it("reads fit over a legacy rk-gui-view of fit", () => {
    localStorage.setItem("rk-gui-view", "fit");
    expect(readGuiZoom()).toBe("fit");
  });

  it("ignores the legacy key once rk-gui-zoom exists", () => {
    localStorage.setItem("rk-gui-view", "1:1");
    writeGuiZoom(150);
    expect(localStorage.getItem("rk-gui-view")).toBeNull();
    localStorage.setItem("rk-gui-view", "1:1");
    expect(readGuiZoom()).toBe(150);
  });

  it("swallows a localStorage read failure, returning fit", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiZoom()).toBe("fit");
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiZoom(125)).not.toThrow();
  });
});

describe("stepGuiZoom", () => {
  it("steps up fit→100→125→150→200 and saturates at 200", () => {
    expect(stepGuiZoom("fit", 1)).toBe(100);
    expect(stepGuiZoom(50, 1)).toBe(75);
    expect(stepGuiZoom(75, 1)).toBe(100);
    expect(stepGuiZoom(100, 1)).toBe(125);
    expect(stepGuiZoom(125, 1)).toBe(150);
    expect(stepGuiZoom(150, 1)).toBe(200);
    expect(stepGuiZoom(200, 1)).toBe(200);
  });

  it("steps down 200→150→125→100→75→50→fit and saturates at fit", () => {
    expect(stepGuiZoom(200, -1)).toBe(150);
    expect(stepGuiZoom(150, -1)).toBe(125);
    expect(stepGuiZoom(125, -1)).toBe(100);
    expect(stepGuiZoom(100, -1)).toBe(75);
    expect(stepGuiZoom(75, -1)).toBe(50);
    expect(stepGuiZoom(50, -1)).toBe("fit");
    expect(stepGuiZoom("fit", -1)).toBe("fit");
  });
});

describe("gui pointer mode posture (rk-gui-pointer)", () => {
  it("defaults by pointer class when absent: trackpad on coarse, touch on fine", () => {
    expect(readGuiPointerMode(true)).toBe("trackpad");
    expect(readGuiPointerMode(false)).toBe("touch");
  });

  it("defaults by pointer class when invalid", () => {
    localStorage.setItem("rk-gui-pointer", "mouse");
    expect(readGuiPointerMode(true)).toBe("trackpad");
    expect(readGuiPointerMode(false)).toBe("touch");
  });

  it("a stored value wins over the pointer-class default", () => {
    localStorage.setItem("rk-gui-pointer", "touch");
    expect(readGuiPointerMode(true)).toBe("touch");
    localStorage.setItem("rk-gui-pointer", "trackpad");
    expect(readGuiPointerMode(false)).toBe("trackpad");
  });

  it("round-trips both modes", () => {
    writeGuiPointerMode("trackpad");
    expect(readGuiPointerMode(false)).toBe("trackpad");
    writeGuiPointerMode("touch");
    expect(readGuiPointerMode(true)).toBe("touch");
  });

  it("falls to the pointer-class default on a localStorage read failure", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiPointerMode(true)).toBe("trackpad");
    expect(readGuiPointerMode(false)).toBe("touch");
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiPointerMode("touch")).not.toThrow();
  });
});

describe("gui resize lock posture (rk-gui-lock)", () => {
  it("defaults to unlocked when absent", () => {
    expect(readGuiResizeLocked()).toBe(false);
  });

  it("round-trips the lock; unlock removes the key", () => {
    writeGuiResizeLocked(true);
    expect(readGuiResizeLocked()).toBe(true);
    writeGuiResizeLocked(false);
    expect(readGuiResizeLocked()).toBe(false);
    expect(localStorage.getItem("rk-gui-lock")).toBeNull();
  });
});

describe("gui quality posture (rk-gui-quality)", () => {
  it("maps the three names to their tuples", () => {
    expect(GUI_QUALITY_PRESETS).toEqual({
      sharp: { qualityLevel: 8, compressionLevel: 1 },
      balanced: { qualityLevel: 6, compressionLevel: 2 },
      smooth: { qualityLevel: 3, compressionLevel: 7 },
    });
  });

  it("defaults by pointer class when absent: balanced on fine, smooth on coarse", () => {
    expect(readGuiQuality(false)).toBe("balanced");
    expect(readGuiQuality(true)).toBe("smooth");
  });

  it("defaults by pointer class when invalid", () => {
    localStorage.setItem("rk-gui-quality", "ultra");
    expect(readGuiQuality(false)).toBe("balanced");
    expect(readGuiQuality(true)).toBe("smooth");
  });

  it("a stored value wins over the pointer-class default", () => {
    localStorage.setItem("rk-gui-quality", "sharp");
    expect(readGuiQuality(true)).toBe("sharp");
    localStorage.setItem("rk-gui-quality", "smooth");
    expect(readGuiQuality(false)).toBe("smooth");
  });

  it("round-trips every preset", () => {
    writeGuiQuality("sharp");
    expect(readGuiQuality(false)).toBe("sharp");
    expect(localStorage.getItem("rk-gui-quality")).toBe("sharp");
    writeGuiQuality("balanced");
    expect(readGuiQuality(false)).toBe("balanced");
    writeGuiQuality("smooth");
    expect(readGuiQuality(false)).toBe("smooth");
  });

  it("falls to the pointer-class default on a localStorage read failure", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiQuality(false)).toBe("balanced");
    expect(readGuiQuality(true)).toBe("smooth");
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiQuality("sharp")).not.toThrow();
  });
});

describe("gui stats overlay visibility (rk-gui-stats-visible)", () => {
  it("defaults to hidden when absent", () => {
    expect(readGuiStatsVisible()).toBe(false);
  });

  it("round-trips the flag; hiding removes the key", () => {
    writeGuiStatsVisible(true);
    expect(readGuiStatsVisible()).toBe(true);
    expect(localStorage.getItem("rk-gui-stats-visible")).toBe("1");
    writeGuiStatsVisible(false);
    expect(readGuiStatsVisible()).toBe(false);
    expect(localStorage.getItem("rk-gui-stats-visible")).toBeNull();
  });

  it("reads a stray non-'1' value as hidden", () => {
    localStorage.setItem("rk-gui-stats-visible", "yes");
    expect(readGuiStatsVisible()).toBe(false);
  });

  it("swallows a localStorage read failure, returning hidden", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiStatsVisible()).toBe(false);
  });
});

describe("gui bare-WM strip dismissal (hexokit-gui-wm-strip-dismissed)", () => {
  it("defaults to not dismissed when absent", () => {
    expect(readGuiWmStripDismissed()).toBe(false);
  });

  it("round-trips the dismissal; clearing removes the key", () => {
    writeGuiWmStripDismissed(true);
    expect(readGuiWmStripDismissed()).toBe(true);
    expect(localStorage.getItem("hexokit-gui-wm-strip-dismissed")).toBe("1");
    writeGuiWmStripDismissed(false);
    expect(readGuiWmStripDismissed()).toBe(false);
    expect(localStorage.getItem("hexokit-gui-wm-strip-dismissed")).toBeNull();
  });

  it("swallows a localStorage read failure, returning not dismissed", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiWmStripDismissed()).toBe(false);
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiWmStripDismissed(true)).not.toThrow();
  });
});

describe("gui HiDPI posture (rk-gui-hidpi)", () => {
  it("defaults to off when absent or any value other than 1", () => {
    expect(readGuiHidpi()).toBe(false);
    localStorage.setItem("rk-gui-hidpi", "true");
    expect(readGuiHidpi()).toBe(false);
    localStorage.setItem("rk-gui-hidpi", "0");
    expect(readGuiHidpi()).toBe(false);
  });

  it("round-trips; off removes the key", () => {
    writeGuiHidpi(true);
    expect(readGuiHidpi()).toBe(true);
    expect(localStorage.getItem("rk-gui-hidpi")).toBe("1");
    writeGuiHidpi(false);
    expect(readGuiHidpi()).toBe(false);
    expect(localStorage.getItem("rk-gui-hidpi")).toBeNull();
  });

  it("swallows a localStorage read failure, returning off", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiHidpi()).toBe(false);
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiHidpi(true)).not.toThrow();
  });
});

describe("gui key-bar visibility posture (rk-gui-keybar)", () => {
  it("defaults to shown when absent or any value other than 0", () => {
    expect(readGuiKeyBarVisible()).toBe(true);
    localStorage.setItem("rk-gui-keybar", "1");
    expect(readGuiKeyBarVisible()).toBe(true);
    localStorage.setItem("rk-gui-keybar", "hidden");
    expect(readGuiKeyBarVisible()).toBe(true);
  });

  it("round-trips; shown removes the key", () => {
    writeGuiKeyBarVisible(false);
    expect(readGuiKeyBarVisible()).toBe(false);
    expect(localStorage.getItem("rk-gui-keybar")).toBe("0");
    writeGuiKeyBarVisible(true);
    expect(readGuiKeyBarVisible()).toBe(true);
    expect(localStorage.getItem("rk-gui-keybar")).toBeNull();
  });

  it("swallows a localStorage read failure, returning shown", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiKeyBarVisible()).toBe(true);
  });
});

describe("gui toolbar panel posture (rk-gui-toolbar)", () => {
  it("defaults to closed when absent or invalid", () => {
    expect(readGuiToolbarVisible()).toBe(false);
    localStorage.setItem("rk-gui-toolbar", "open");
    expect(readGuiToolbarVisible()).toBe(false);
    localStorage.setItem("rk-gui-toolbar", "1");
    expect(readGuiToolbarVisible()).toBe(true);
  });

  it("round-trips; closed removes the key", () => {
    writeGuiToolbarVisible(true);
    expect(readGuiToolbarVisible()).toBe(true);
    expect(localStorage.getItem("rk-gui-toolbar")).toBe("1");
    writeGuiToolbarVisible(false);
    expect(readGuiToolbarVisible()).toBe(false);
    expect(localStorage.getItem("rk-gui-toolbar")).toBeNull();
  });

  it("swallows a localStorage read failure, returning closed", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiToolbarVisible()).toBe(false);
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiToolbarVisible(true)).not.toThrow();
  });
});

describe("zoomedHostSize", () => {
  it("sizes the host to fb × zoom/100 at dpr 1", () => {
    expect(zoomedHostSize(1920, 1080, 100, 1)).toEqual({ width: 1920, height: 1080 });
    expect(zoomedHostSize(1920, 1080, 150, 1)).toEqual({ width: 2880, height: 1620 });
    expect(zoomedHostSize(1920, 1080, 50, 1)).toEqual({ width: 960, height: 540 });
  });

  it("divides by dpr — 100% at dpr 2 maps one framebuffer pixel to one device pixel", () => {
    expect(zoomedHostSize(1920, 1080, 100, 2)).toEqual({ width: 960, height: 540 });
  });

  it("divides by a fractional dpr — 150% at dpr 1.5 lands back on the fb size", () => {
    expect(zoomedHostSize(1920, 1080, 150, 1.5)).toEqual({ width: 1920, height: 1080 });
  });

  it("returns undefined at fit regardless of dpr", () => {
    expect(zoomedHostSize(1920, 1080, "fit", 1)).toBeUndefined();
    expect(zoomedHostSize(1920, 1080, "fit", 2)).toBeUndefined();
  });

  it("returns undefined when a framebuffer dimension is 0", () => {
    expect(zoomedHostSize(0, 1080, 100, 1)).toBeUndefined();
    expect(zoomedHostSize(1920, 0, 100, 2)).toBeUndefined();
  });
});

describe("nextGuiQuality (the ◐ quality cycle)", () => {
  it("cycles Sharp → Balanced → Smooth → Sharp over the palette order", () => {
    expect(GUI_QUALITY_ORDER).toEqual(["sharp", "balanced", "smooth"]);
    expect(nextGuiQuality("sharp")).toBe("balanced");
    expect(nextGuiQuality("balanced")).toBe("smooth");
    expect(nextGuiQuality("smooth")).toBe("sharp");
  });

  it("labels every preset", () => {
    for (const q of GUI_QUALITY_ORDER) expect(GUI_QUALITY_LABELS[q]).toMatch(/^[A-Z]/);
  });
});

describe("gui keyboard capture latch (rk-gui-capture)", () => {
  it("defaults to released when absent", () => {
    expect(readGuiCapture()).toBe(false);
  });

  it("round-trips the flag; releasing removes the key", () => {
    writeGuiCapture(true);
    expect(readGuiCapture()).toBe(true);
    expect(localStorage.getItem("rk-gui-capture")).toBe("1");
    writeGuiCapture(false);
    expect(readGuiCapture()).toBe(false);
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();
  });

  it("reads a stray non-'1' value as released", () => {
    localStorage.setItem("rk-gui-capture", "yes");
    expect(readGuiCapture()).toBe(false);
  });

  it("swallows a localStorage read failure, returning released", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readGuiCapture()).toBe(false);
  });

  it("swallows a localStorage write failure silently", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => writeGuiCapture(true)).not.toThrow();
  });
});
