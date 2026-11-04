import {
  adjustBorderForContrast,
  blendHex,
  colorValueToHex,
  deriveUIColors,
  BORDER_MIN_CONTRAST,
} from "@/themes";
import type { Theme } from "@/themes";

/**
 * Instance accent ("host color") primitives — pure helpers shared by the
 * InstanceAccentProvider (contexts/instance-accent-context.tsx), the
 * theme-context meta write, and the index.html pre-paint script's echo
 * contract.
 *
 * The accent is a property of the INSTANCE (stored on its host in
 * ~/.config/hexokit/config.yaml `instance_color`), not the viewer — every
 * device viewing
 * the instance sees the same accent. Resolution order: explicit setting →
 * localStorage echo (paint cache only, never authoritative) → none. There is
 * no derived default: a fresh instance starts with no accent until the user
 * picks one.
 */

/** localStorage key echoing the resolved accent (paint cache only). The value
 *  is JSON `{"value": "<descriptor>", "hex": "#rrggbb"}` — `hex` is the final
 *  theme-color meta content so the index.html blocking script can tint the PWA
 *  titlebar before any fetch resolves. */
export const INSTANCE_COLOR_STORAGE_KEY = "hexokit-instance-color";

/** Ratio of the accent blended into the chrome surface for the top-bar wash
 *  (intake latitude: ~6-7%; one trivially-tunable constant). */
export const INSTANCE_WASH_RATIO = 0.065;

/** Ratio of the accent blended into the chrome surface for the PWA titlebar
 *  (theme-color meta) tint — user-tuned to 35% (the mock-parity 12% read
 *  nearly black); a taste constant, trivially tunable. */
export const INSTANCE_TITLEBAR_RATIO = 0.35;

export type InstanceColorEcho = { value: string; hex: string };

function isEcho(v: unknown): v is InstanceColorEcho {
  if (typeof v !== "object" || v === null) return false;
  if (!("value" in v) || !("hex" in v)) return false;
  return typeof v.value === "string" && typeof v.hex === "string";
}

/** Read the echoed accent, tolerating absence, malformed JSON, and a wrong
 *  shape (all → null). Paint cache only — never authoritative. */
export function readInstanceColorEcho(): InstanceColorEcho | null {
  try {
    const raw = localStorage.getItem(INSTANCE_COLOR_STORAGE_KEY);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEcho(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write (or clear, with null) the accent echo. */
export function writeInstanceColorEcho(echo: InstanceColorEcho | null): void {
  try {
    if (echo == null) {
      localStorage.removeItem(INSTANCE_COLOR_STORAGE_KEY);
    } else {
      localStorage.setItem(INSTANCE_COLOR_STORAGE_KEY, JSON.stringify(echo));
    }
  } catch {
    // localStorage unavailable
  }
}

/** Theme-derived hexes for the accent surfaces: `stripeHex` is the
 *  contrast-guarded family hex (top-bar stripe and HOST hostname tint),
 *  `washHex` the subtle top-bar background blend, and `titlebarHex` the
 *  slightly stronger blend that becomes the theme-color meta content (the
 *  installed-PWA titlebar tint — subtle wash above, full-brightness stripe
 *  below). All three blend/guard against the CHROME hex, not the terminal
 *  background: every accent surface (wash, titlebar band, stripe) renders on
 *  the chrome material, so the chrome is their truthful neighbor. Accepts
 *  family names and legacy descriptors incl. blends ("1+3") via the
 *  owned-family mapping. Null when the value maps to no owned family. */
export function deriveAccentHexes(
  value: string,
  theme: Theme,
): { stripeHex: string; washHex: string; titlebarHex: string } | null {
  const src = colorValueToHex(value, theme.palette);
  if (src == null) return null;
  const bg = deriveUIColors(theme.palette, theme.category).bgChrome;
  return {
    stripeHex: adjustBorderForContrast(src, bg, theme.category === "dark", BORDER_MIN_CONTRAST),
    washHex: blendHex(src, bg, INSTANCE_WASH_RATIO),
    titlebarHex: blendHex(src, bg, INSTANCE_TITLEBAR_RATIO),
  };
}

// ── Single theme-color meta writer ───────────────────────────────────────────
// React passive effects run child-first: ThemeProvider's applyThemeToDOM effect
// fires AFTER any child accent effect on a theme switch and would clobber an
// accent-tinted meta tag with the bare chrome. Both writers therefore funnel
// through this module's shared state — last-write-wins over one content
// derivation (accent hex when an accent is set, else the theme's chrome hex).

let currentAccentHex: string | null = null;
let lastBackground: string | null = null;

function writeMeta(): void {
  const content = currentAccentHex ?? lastBackground;
  if (content == null) return;
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute("content", content);
}

/** Theme-side write: record the active theme's chrome hex and re-apply. Called
 *  by theme-context's applyThemeToDOM on every theme application. */
export function applyThemeColorMeta(background: string): void {
  lastBackground = background;
  writeMeta();
}

/** Accent-side write: record the accent meta hex (null = no accent) and
 *  re-apply. Called by the InstanceAccentProvider on accent/theme changes. */
export function setAccentThemeColor(hex: string | null): void {
  currentAccentHex = hex;
  writeMeta();
}
