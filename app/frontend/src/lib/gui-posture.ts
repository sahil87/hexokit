/**
 * The gui tile's per-viewer render postures (spec surface-layout.md § State —
 * render postures are per-viewer localStorage, never the shared layout): the
 * zoom (`rk-gui-zoom`: "fit" | decimal percentage string from
 * GUI_ZOOM_STEPS, absent = "fit"; a legacy `rk-gui-view` of "1:1" reads as
 * 100 and is removed on write), the pointer mode (`rk-gui-pointer`: "touch"
 * | "trackpad", absent = the pointer-class default — "trackpad" on coarse,
 * "touch" on fine), the viewer-local resize lock (`rk-gui-lock`: "1" =
 * locked, absent = unlocked — locked viewers never drive SetDesktopSize),
 * the HiDPI rendering switch (`rk-gui-hidpi`: "1" = on, absent/other = off —
 * divides the percentage-zoom host CSS size by `devicePixelRatio` so a 100%
 * zoom maps one framebuffer pixel to one device pixel; client-side rendering
 * only, never a server-facing size), the key-bar visibility
 * (`rk-gui-keybar`: "0" = hidden, absent/other = shown — the default keeps
 * the bar rendering as it always has), the bare-WM strip dismissal
 * (`hexokit-gui-wm-strip-dismissed`: "1" = dismissed, absent = shown —
 * cleared by the tile when `wm` becomes non-empty so a LATER bare state
 * shows the strip again), the RFB quality
 * preset (`rk-gui-quality`: "sharp" | "balanced" | "smooth", absent/invalid =
 * the pointer-class default — "balanced" on fine, "smooth" on coarse), and
 * the stats overlay's visibility (`rk-gui-stats-visible`: "1" = shown,
 * absent = hidden — the lock's shape), and the header fold panel's open
 * state (`rk-gui-toolbar`: "1" = open, absent/other = closed — an overflow
 * panel's rest state is closed), and the keyboard-capture latch
 * (`rk-gui-capture`: "1" = captured, absent/other = released — while latched
 * the gui chord gate hands every chord but the release binding to the guest
 * desktop). Reads are validated on the way in
 * (untrusted-localStorage discipline); all writes are try/catch-noop.
 */

export type GuiZoom = "fit" | 50 | 75 | 100 | 125 | 150 | 200;

/** Ascending percentage rungs of the zoom ladder; "fit" is off-table. */
export const GUI_ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;

export type GuiPointerMode = "touch" | "trackpad";

/** The three named RFB quality presets — the durable contract is the name;
 *  the tuple table is internal so a later encoder retune can sit behind it. */
export type GuiQuality = "sharp" | "balanced" | "smooth";

/** Preset name → noVNC `qualityLevel`/`compressionLevel` tuple. */
export const GUI_QUALITY_PRESETS: Record<GuiQuality, { qualityLevel: number; compressionLevel: number }> = {
  sharp: { qualityLevel: 8, compressionLevel: 1 },
  balanced: { qualityLevel: 6, compressionLevel: 2 },
  smooth: { qualityLevel: 3, compressionLevel: 7 },
};

/** The presets in palette order; the header toolbar's ◐ chip cycles through it. */
export const GUI_QUALITY_ORDER: readonly GuiQuality[] = ["sharp", "balanced", "smooth"];

/** Preset name → its user-facing label (the palette rows and the toolbar share it). */
export const GUI_QUALITY_LABELS: Record<GuiQuality, string> = {
  sharp: "Sharp",
  balanced: "Balanced",
  smooth: "Smooth",
};

/** Sharp → Balanced → Smooth → Sharp. */
export function nextGuiQuality(q: GuiQuality): GuiQuality {
  return GUI_QUALITY_ORDER[(GUI_QUALITY_ORDER.indexOf(q) + 1) % GUI_QUALITY_ORDER.length];
}

const GUI_ZOOM_KEY = "rk-gui-zoom";
const GUI_POINTER_KEY = "rk-gui-pointer";
const GUI_LOCK_KEY = "rk-gui-lock";
const GUI_QUALITY_KEY = "rk-gui-quality";
const GUI_STATS_VISIBLE_KEY = "rk-gui-stats-visible";
const GUI_HIDPI_KEY = "rk-gui-hidpi";
const GUI_KEYBAR_KEY = "rk-gui-keybar";
const GUI_TOOLBAR_KEY = "rk-gui-toolbar";
const GUI_CAPTURE_KEY = "rk-gui-capture";
const GUI_WM_STRIP_DISMISSED_KEY = "hexokit-gui-wm-strip-dismissed";

/** Retired `rk-gui-view` key; read once to seed the zoom posture, removed on write. */
const GUI_LEGACY_VIEW_KEY = "rk-gui-view";

function parseGuiZoom(raw: string): GuiZoom | null {
  if (raw === "fit") return "fit";
  const z = Number(raw);
  switch (z) {
    case 50:
    case 75:
    case 100:
    case 125:
    case 150:
    case 200:
      return z;
    default:
      return null;
  }
}

export function readGuiZoom(): GuiZoom {
  try {
    const raw = localStorage.getItem(GUI_ZOOM_KEY);
    if (raw !== null) {
      return parseGuiZoom(raw) ?? "fit";
    }
    return localStorage.getItem(GUI_LEGACY_VIEW_KEY) === "1:1" ? 100 : "fit";
  } catch {
    return "fit";
  }
}

export function writeGuiZoom(z: GuiZoom): void {
  try {
    localStorage.setItem(GUI_ZOOM_KEY, String(z));
    localStorage.removeItem(GUI_LEGACY_VIEW_KEY);
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * Zoom ladder: up runs fit→100→125→150→200, down runs
 * 200→150→125→100→75→50→fit; both ends saturate. Zooming in from "fit"
 * lands on 100 (never 50/75) by design.
 */
export function stepGuiZoom(current: GuiZoom, direction: 1 | -1): GuiZoom {
  if (current === "fit") {
    return direction === 1 ? 100 : "fit";
  }
  const next = GUI_ZOOM_STEPS[GUI_ZOOM_STEPS.indexOf(current) + direction];
  if (next === undefined) {
    return direction === 1 ? current : "fit";
  }
  return next;
}

export function readGuiPointerMode(coarsePointer: boolean): GuiPointerMode {
  try {
    const raw = localStorage.getItem(GUI_POINTER_KEY);
    if (raw === "touch" || raw === "trackpad") {
      return raw;
    }
  } catch {
    /* fall through to the pointer-class default */
  }
  return coarsePointer ? "trackpad" : "touch";
}

export function writeGuiPointerMode(m: GuiPointerMode): void {
  try {
    localStorage.setItem(GUI_POINTER_KEY, m);
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiResizeLocked(): boolean {
  try {
    return localStorage.getItem(GUI_LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiResizeLocked(locked: boolean): void {
  try {
    if (locked) {
      localStorage.setItem(GUI_LOCK_KEY, "1");
    } else {
      localStorage.removeItem(GUI_LOCK_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiStatsVisible(): boolean {
  try {
    return localStorage.getItem(GUI_STATS_VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiStatsVisible(visible: boolean): void {
  try {
    if (visible) {
      localStorage.setItem(GUI_STATS_VISIBLE_KEY, "1");
    } else {
      localStorage.removeItem(GUI_STATS_VISIBLE_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiQuality(coarsePointer: boolean): GuiQuality {
  try {
    const raw = localStorage.getItem(GUI_QUALITY_KEY);
    if (raw === "sharp" || raw === "balanced" || raw === "smooth") {
      return raw;
    }
  } catch {
    /* fall through to the pointer-class default */
  }
  return coarsePointer ? "smooth" : "balanced";
}

export function writeGuiQuality(q: GuiQuality): void {
  try {
    localStorage.setItem(GUI_QUALITY_KEY, q);
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiWmStripDismissed(): boolean {
  try {
    return localStorage.getItem(GUI_WM_STRIP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiWmStripDismissed(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(GUI_WM_STRIP_DISMISSED_KEY, "1");
    } else {
      localStorage.removeItem(GUI_WM_STRIP_DISMISSED_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiHidpi(): boolean {
  try {
    return localStorage.getItem(GUI_HIDPI_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiHidpi(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(GUI_HIDPI_KEY, "1");
    } else {
      localStorage.removeItem(GUI_HIDPI_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiKeyBarVisible(): boolean {
  try {
    return localStorage.getItem(GUI_KEYBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeGuiKeyBarVisible(visible: boolean): void {
  try {
    if (visible) {
      localStorage.removeItem(GUI_KEYBAR_KEY);
    } else {
      localStorage.setItem(GUI_KEYBAR_KEY, "0");
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiToolbarVisible(): boolean {
  try {
    return localStorage.getItem(GUI_TOOLBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiToolbarVisible(visible: boolean): void {
  try {
    if (visible) {
      localStorage.setItem(GUI_TOOLBAR_KEY, "1");
    } else {
      localStorage.removeItem(GUI_TOOLBAR_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

export function readGuiCapture(): boolean {
  try {
    return localStorage.getItem(GUI_CAPTURE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiCapture(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(GUI_CAPTURE_KEY, "1");
    } else {
      localStorage.removeItem(GUI_CAPTURE_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * The noVNC host div's CSS size at a percentage zoom: `fb × zoom / (100 ×
 * dpr)`. With HiDPI on the caller passes `window.devicePixelRatio`, so one
 * framebuffer pixel maps to exactly one device pixel at 100% (crisp 1:1 on a
 * Retina display); the canvas backing store is noVNC's, so the CSS size is
 * the only client-side lever — nothing server-facing ever reads this. `fit`
 * (the uniform letterboxed scale, tile-bound) and a zero framebuffer
 * dimension (no desktop size yet) return `undefined` — the host stays
 * tile-sized.
 */
export function zoomedHostSize(
  fbW: number,
  fbH: number,
  zoom: GuiZoom,
  dpr: number,
): { width: number; height: number } | undefined {
  if (zoom === "fit" || fbW <= 0 || fbH <= 0) return undefined;
  return { width: (fbW * zoom) / (100 * dpr), height: (fbH * zoom) / (100 * dpr) };
}
