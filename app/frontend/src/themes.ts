import themeDefs from "@configs/themes.json";

// ── Types ────────────────────────────────────────────────────────────────────

export type ThemePalette = {
  foreground: string;
  background: string;
  cursorColor: string;
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  /** ANSI 0-15: black, red, green, yellow, blue, magenta, cyan, white,
   *  brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite */
  ansi: readonly [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
};

export type UIColors = {
  bgPrimary: string;
  bgCard: string;
  bgInset: string;
  bgChrome: string;
  bgChromeRaised: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  accent: string;
  accentBright: string;
  accentGreen: string;
  /** Latch well floor — the chrome ground one OKLab step toward mid-gray
   *  (down on light, up on dark). */
  bgWell: string;
  /** Latch glyph ink — the palette green, moved in OKLab L until it clears
   *  the non-text contrast floor against `bgWell`. */
  accentGreenInk: string;
  /** Latched bordered controls — `border` one OKLab step down. */
  borderPressed: string;
};

export type Theme = {
  id: string;
  name: string;
  category: "dark" | "light";
  source: string;
  palette: ThemePalette;
};

// ── CSS property mapping ─────────────────────────────────────────────────────

/** Maps UIColors keys to CSS custom property names. */
export const COLOR_CSS_MAP: Record<keyof UIColors, string> = {
  bgPrimary: "--color-bg-primary",
  bgCard: "--color-bg-card",
  bgInset: "--color-bg-inset",
  bgChrome: "--color-bg-chrome",
  bgChromeRaised: "--color-bg-chrome-raised",
  textPrimary: "--color-text-primary",
  textSecondary: "--color-text-secondary",
  border: "--color-border",
  accent: "--color-accent",
  accentBright: "--color-accent-bright",
  accentGreen: "--color-accent-green",
  bgWell: "--color-bg-well",
  accentGreenInk: "--color-accent-green-ink",
  borderPressed: "--color-border-pressed",
};

// ── Color helpers (module-private) ───────────────────────────────────────────

type RGB = { r: number; g: number; b: number };
/** Linear-light sRGB channels (unclamped, may fall outside [0, 1]). */
type RGBLinear = { lr: number; lg: number; lb: number };

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(rgb: RGB): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    "#" +
    clamp(rgb.r).toString(16).padStart(2, "0") +
    clamp(rgb.g).toString(16).padStart(2, "0") +
    clamp(rgb.b).toString(16).padStart(2, "0")
  );
}

function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  const factor = amount / 100;
  return rgbToHex({
    r: rgb.r + (255 - rgb.r) * factor,
    g: rgb.g + (255 - rgb.g) * factor,
    b: rgb.b + (255 - rgb.b) * factor,
  });
}

function darkenHex(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  const factor = amount / 100;
  return rgbToHex({
    r: rgb.r * (1 - factor),
    g: rgb.g * (1 - factor),
    b: rgb.b * (1 - factor),
  });
}

export function blendHex(fg: string, bg: string, ratio: number): string {
  const fgRgb = hexToRgb(fg);
  const bgRgb = hexToRgb(bg);
  return rgbToHex({
    r: fgRgb.r * ratio + bgRgb.r * (1 - ratio),
    g: fgRgb.g * ratio + bgRgb.g * (1 - ratio),
    b: fgRgb.b * ratio + bgRgb.b * (1 - ratio),
  });
}

function rgbToHsl(rgb: RGB): { h: number; s: number; l: number } {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb(hsl: { h: number; s: number; l: number }): RGB {
  const { h, s, l } = hsl;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = h / 360;
  return {
    r: hue2rgb(p, q, hh + 1 / 3) * 255,
    g: hue2rgb(p, q, hh) * 255,
    b: hue2rgb(p, q, hh - 1 / 3) * 255,
  };
}

/** Multiply the HSL saturation of a hex color by a factor, clamped to [0, 1]. */
export function saturateHex(hex: string, factor: number): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.s = Math.max(0, Math.min(1, hsl.s * factor));
  return rgbToHex(hslToRgb(hsl));
}

// ── Derivation functions ─────────────────────────────────────────────────────

/** OKLab lightness step from the palette background to the chrome material
 *  (sidebar, top bar, status bar, mobile drawer). Up on dark, down on light.
 *  Large enough to read as a second surface on near-black palettes, small
 *  enough that mid-dark tinted palettes (Tokyo Night, Nord) keep their cast
 *  instead of turning concrete gray. */
const CHROME_L_DELTA = 0.045;
/** Further lightness step, same direction, for the surface one level above the
 *  chrome: uncolored row hover on the chrome, and the Shell stage ground. */
const CHROME_RAISED_L_DELTA = 0.035;
/** Fraction of the background's OKLab chroma the chrome keeps — a gray that
 *  still leans the palette's way rather than a neutral slab. Tinted palettes
 *  (Solarized's teal, Ubuntu's aubergine) keep most of their hue; on
 *  low-chroma palettes the value is nearly moot. */
const CHROME_CHROMA_KEEP = 0.6;
/** Lightness floor for the chrome on dark palettes. OKLab compresses near
 *  black: from a pure-black background a 0.045 step encodes back to #000000,
 *  so the chrome lifts to at least this L (about the lightness of ayu-dark's
 *  background) and the raised step counts from there. Exported for the
 *  derivation tests; light palettes never approach the equivalent ceiling. */
export const CHROME_MIN_L = 0.16;
/** Minimum WCAG contrast of secondary text against the chrome it mostly sits
 *  on (sidebar rows, top bar, status bar) — text AA. Palettes whose bright
 *  black is very dark (Tokyo Night) would otherwise land near 3:1 there. */
const TEXT_SECONDARY_MIN_CONTRAST = 4.5;
/** OKLab lightness steps from the chrome ground to the latch well floor. The
 *  well steps TOWARD MID-GRAY on both categories — down on light, UP on dark —
 *  because the depth cue is the well's dark inset shade, and a dark shade on
 *  a near-black floor paints nothing: a dark well that stepped toward black
 *  read as unpressed at 24px. Same-visible-step reasoning as CHROME_L_DELTA
 *  (an sRGB percentage, the bgInset recipe, is invisible on light palettes).
 *  The dark step is the larger one so the floor clears the row-hover fill
 *  (`bgChromeRaised`, chrome + CHROME_RAISED_L_DELTA) by ≥ 0.05 L — a pressed
 *  key must never read as a hovered one. */
const WELL_L_DELTA_LIGHT = 0.06;
const WELL_L_DELTA_DARK = 0.09;
/** OKLab lightness step from `border` DOWN to the pressed border on latched
 *  bordered controls. Down on both categories: a lighter border reads as
 *  disabled, so pressed must darken every channel. */
const PRESSED_BORDER_L_DELTA = 0.12;

/** Lower a hex color's OKLab lightness by `delta`, keeping a/b (hue and
 *  chroma identity), clamped at black. */
function stepDownL(hex: string, delta: number): string {
  const lab = hexToOklab(hex);
  return oklabToHex({ L: Math.max(0, lab.L - delta), a: lab.a, b: lab.b });
}

/** Derive the 14 UI CSS colors from a full theme palette. */
export function deriveUIColors(palette: ThemePalette, category: "dark" | "light"): UIColors {
  const isDark = category === "dark";
  const accent = palette.ansi[4];
  const bgLch = hexToOklch(palette.background);
  const chromeChroma = bgLch.C * CHROME_CHROMA_KEEP;
  const chromeDir = isDark ? 1 : -1;
  const chromeL = isDark ? Math.max(bgLch.L + CHROME_L_DELTA, CHROME_MIN_L) : bgLch.L - CHROME_L_DELTA;
  const bgChrome = oklchToHexInGamut(chromeL, chromeChroma, bgLch.hueDeg);
  const wellL = isDark ? chromeL + WELL_L_DELTA_DARK : Math.max(0, chromeL - WELL_L_DELTA_LIGHT);
  const bgWell = oklchToHexInGamut(wellL, chromeChroma, bgLch.hueDeg);
  const border = blendHex(palette.foreground, palette.background, 0.25);
  return {
    bgPrimary: palette.background,
    bgCard: isDark ? lightenHex(palette.background, 8) : darkenHex(palette.background, 3),
    bgInset: isDark ? darkenHex(palette.background, 5) : darkenHex(palette.background, 6),
    bgChrome,
    bgChromeRaised: oklchToHexInGamut(chromeL + chromeDir * CHROME_RAISED_L_DELTA, chromeChroma, bgLch.hueDeg),
    textPrimary: palette.foreground,
    // The chrome is the surface secondary text mostly sits on, and it is the
    // binding case in both categories (lighter than the background on dark,
    // darker on light), so clearing AA there clears it on the background too.
    textSecondary: adjustBorderForContrast(
      blendHex(palette.foreground, palette.ansi[8], 0.3),
      bgChrome,
      isDark,
      TEXT_SECONDARY_MIN_CONTRAST,
    ),
    border,
    accent,
    // "bright" = more salient than accent relative to the theme background:
    // lighter on dark, darker + more saturated on light (lighter would wash out).
    accentBright: isDark ? lightenHex(accent, 25) : saturateHex(darkenHex(accent, 12), 1.15),
    accentGreen: palette.ansi[2],
    bgWell,
    // The palette green is a fill/track colour; as a glyph on the well it must
    // clear the non-text floor, which the light palettes' greens do not.
    accentGreenInk: adjustBorderForContrast(palette.ansi[2], bgWell, isDark, BORDER_MIN_CONTRAST),
    borderPressed: stepDownL(border, PRESSED_BORDER_L_DELTA),
  };
}

/** Derive an xterm.js ITheme from a full theme palette. */
export function deriveXtermTheme(palette: ThemePalette) {
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursorColor,
    cursorAccent: palette.cursorText,
    selectionBackground: palette.selectionBackground,
    selectionForeground: palette.selectionForeground,
    black: palette.ansi[0],
    red: palette.ansi[1],
    green: palette.ansi[2],
    yellow: palette.ansi[3],
    blue: palette.ansi[4],
    magenta: palette.ansi[5],
    cyan: palette.ansi[6],
    white: palette.ansi[7],
    brightBlack: palette.ansi[8],
    brightRed: palette.ansi[9],
    brightGreen: palette.ansi[10],
    brightYellow: palette.ansi[11],
    brightBlue: palette.ansi[12],
    brightMagenta: palette.ansi[13],
    brightCyan: palette.ansi[14],
    brightWhite: palette.ansi[15],
  };
}

// ── OKLab + WCAG color math (ported verbatim from the retired swatch-color audit script) ─
// These are the design-evidence reference implementations. They are pure
// arithmetic (no trig / lookup tables) and are used by the contrast guardrail.

type OKLab = { L: number; a: number; b: number };

/** sRGB channel (0..255) → linear-light (0..1). The gamma step people skip. */
function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert a hex sRGB color to OKLab (Björn Ottosson, 2020). */
export function hexToOklab(hex: string): OKLab {
  const { r, g, b } = hexToRgb(hex);
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** OKLab → linear-light sRGB channels (unclamped). The shared inverse matrix
 *  (OKLab → LMS' → LMS → linear RGB) used by BOTH the hex encoder (oklabToHex)
 *  and the in-gamut check (oklchInGamut) — extracted so the 18 coefficients
 *  cannot drift between the two callers. Channels may fall outside [0, 1] when
 *  the color is out of gamut; the encoder clamps, the gamut check does not. */
function oklabToLinearRgb(c: OKLab): RGBLinear {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.L - 0.0894841775 * c.a - 1.291485548 * c.b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return {
    lr: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    lg: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    lb: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** Convert OKLab back to a hex sRGB color (inverse of hexToOklab). */
export function oklabToHex(c: OKLab): string {
  const { lr, lg, lb } = oklabToLinearRgb(c);
  const enc = (channel: number) => {
    const v = channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  const h = (n: number) => enc(n).toString(16).padStart(2, "0");
  return "#" + h(lr) + h(lg) + h(lb);
}

/** WCAG 2.x relative luminance from linear-light sRGB. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1), l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum WCAG contrast for UI components / large graphics (the 8px border). */
export const BORDER_MIN_CONTRAST = 3.0;

/** Number of OKLab lightness-nudge steps before giving up (best effort at cap). */
const CONTRAST_ADJUST_MAX_STEPS = 24;
const CONTRAST_ADJUST_STEP = 0.03;

/**
 * Return a border color that clears `min` contrast vs bg, nudging OKLab L if
 * needed. isDark ⇒ push lighter; light theme ⇒ push darker. Preserves hue and
 * chroma (only L moves) so the swatch keeps its identity. Caps at 24 steps.
 * Ported from the retired swatch-color audit script (adjustBorderForContrast).
 */
export function adjustBorderForContrast(border: string, bg: string, isDark: boolean, min: number): string {
  if (contrastRatio(border, bg) >= min) return border;
  const lab = hexToOklab(border);
  const step = isDark ? CONTRAST_ADJUST_STEP : -CONTRAST_ADJUST_STEP;
  let L = lab.L;
  for (let i = 0; i < CONTRAST_ADJUST_MAX_STEPS; i++) {
    L = Math.max(0, Math.min(1, L + step));
    const candidate = oklabToHex({ L, a: lab.a, b: lab.b });
    if (contrastRatio(candidate, bg) >= min) return candidate;
    if (L <= 0 || L >= 1) break;
  }
  return oklabToHex({ L, a: lab.a, b: lab.b }); // best effort at the cap
}

// ── Owned OKLCH hue-family palette ────────────────────────────────────────────
// The picker no longer derives its swatches from the theme's ANSI palette (which
// made hue identity hostage to the theme). Instead 10 OWNED hue families are
// defined by fixed OKLCH hue angle and rendered ADAPTED to the theme: each family
// is drawn at the theme's mean OKLab lightness and chroma so it feels native,
// while its hue stays stable across every theme. See docs/specs/themes.md.

/** OKLCH → hex sRGB. Converts polar chroma/hue to OKLab a,b (a = C·cos h,
 *  b = C·sin h; hue in DEGREES) then reuses oklabToHex. Out-of-gamut inputs are
 *  channel-clamped by oklabToHex — callers that need in-gamut fidelity use
 *  oklchToHexInGamut, which reduces chroma instead. */
export function oklchToHex(L: number, C: number, hueDeg: number): string {
  const h = (hueDeg * Math.PI) / 180;
  return oklabToHex({ L, a: C * Math.cos(h), b: C * Math.sin(h) });
}

/** True when the OKLCH triple maps inside the sRGB gamut (no channel clamped on
 *  encode). Reuses the shared oklabToLinearRgb matrix (so its coefficients stay
 *  in lockstep with oklabToHex) and checks each un-clamped channel stays within
 *  [0, 1] (with a tiny epsilon for float noise at the boundaries). */
export function oklchInGamut(L: number, C: number, hueDeg: number): boolean {
  const h = (hueDeg * Math.PI) / 180;
  const { lr, lg, lb } = oklabToLinearRgb({ L, a: C * Math.cos(h), b: C * Math.sin(h) });
  const eps = 1e-4;
  return [lr, lg, lb].every((c) => c >= -eps && c <= 1 + eps);
}

/** Number of stepwise chroma reductions before giving up bringing an OKLCH
 *  triple into gamut. */
const GAMUT_REDUCE_MAX_STEPS = 20;
/** Multiplicative chroma reduction per step. */
const GAMUT_REDUCE_FACTOR = 0.92;

/** Resolve an OKLCH family color to a hex that is in the sRGB gamut, reducing
 *  CHROMA stepwise (×0.92, ≤20 steps) when out of gamut — never sRGB
 *  channel-clamping, which would shift the hue and defeat stable hue identity.
 *  L and hue are preserved; only chroma moves. */
export function oklchToHexInGamut(L: number, C: number, hueDeg: number): string {
  let c = C;
  for (let i = 0; i < GAMUT_REDUCE_MAX_STEPS; i++) {
    if (oklchInGamut(L, c, hueDeg)) break;
    c *= GAMUT_REDUCE_FACTOR;
  }
  return oklchToHex(L, c, hueDeg);
}

/** Convert a hex sRGB color to OKLCH (polar OKLab): L, chroma, hue in degrees. */
export function hexToOklch(hex: string): { L: number; C: number; hueDeg: number } {
  const { L, a, b } = hexToOklab(hex);
  return { L, C: Math.hypot(a, b), hueDeg: (Math.atan2(b, a) * 180) / Math.PI };
}

/** OKLab chroma (distance from the neutral axis) of a hex color. */
function oklabChroma(hex: string): number {
  return hexToOklch(hex).C;
}

/** Chroma floor: near-monochrome themes still get distinguishable families. */
const THEME_CHROMA_FLOOR = 0.05;

/** Theme adaptation stats: the mean OKLab lightness and mean chroma over the
 *  theme's `ansi[1..6]` (the 6 standard hues), with the chroma floored so
 *  near-monochrome themes stay usable. Families render at (L, C, ownHue). */
export type ThemeColorStats = { L: number; C: number };
export function themeColorStats(palette: ThemePalette): ThemeColorStats {
  let sumL = 0, sumC = 0;
  for (let i = 1; i <= 6; i++) {
    const lab = hexToOklab(palette.ansi[i]);
    sumL += lab.L;
    sumC += Math.hypot(lab.a, lab.b);
  }
  return { L: sumL / 6, C: Math.max(sumC / 6, THEME_CHROMA_FLOOR) };
}

/** An owned hue family: a stable name, its OKLCH hue angle, and — for `slate` —
 *  a flag that floors its chroma to a near-neutral value (parked/archived
 *  identity). `legacy` is the pre-owned-palette color-value descriptor that maps
 *  1:1 onto this family for zero-migration reads. */
export type HueFamily = {
  name: string;
  hue: number;
  legacy: string;
  neutral?: boolean;
};

/** The 10 owned hue families in stable display order. Hue angles are placed
 *  non-uniformly — tight through the discriminable red→amber region, the large
 *  gap parked in teal→blue where human hue discrimination is weakest. `legacy`
 *  is the old ANSI-derived color value that resolves onto this family (zero
 *  migration): red←1, orange←1+3, amber←3, olive←1+2, green←2, teal←6, blue←4,
 *  violet←4+5, purple←1+4, magenta←5, slate←3+4. */
export const HUE_FAMILIES: readonly HueFamily[] = [
  { name: "red", hue: 25, legacy: "1" },
  { name: "orange", hue: 55, legacy: "1+3" },
  { name: "amber", hue: 90, legacy: "3" },
  { name: "olive", hue: 120, legacy: "1+2" },
  { name: "green", hue: 150, legacy: "2" },
  { name: "teal", hue: 185, legacy: "6" },
  { name: "blue", hue: 250, legacy: "4" },
  { name: "violet", hue: 270, legacy: "4+5" },
  { name: "purple", hue: 290, legacy: "1+4" },
  { name: "magenta", hue: 330, legacy: "5" },
  { name: "slate", hue: 250, legacy: "3+4", neutral: true },
] as const;

/** Family lookup by canonical name. */
const FAMILY_BY_NAME: ReadonlyMap<string, HueFamily> = new Map(
  HUE_FAMILIES.map((f) => [f.name, f]),
);
/** Family lookup by legacy color-value descriptor ("4" / "1+3"). Built from the
 *  canonical (normalized) legacy string so both `"4"` and `"blue"` resolve. */
const FAMILY_BY_LEGACY: ReadonlyMap<string, HueFamily> = new Map(
  HUE_FAMILIES.map((f) => [f.legacy, f]),
);

// ── Shade axis (light + normal + dark) ───────────────────────────────────────
// Every family renders in THREE shades: `normal` (the existing mean-L rendering —
// every pre-existing stored color maps here untouched), `dark` (the same hue
// and chroma at mean-L − 0.14, gamut-reduced), and `light` (the exact mirror —
// same hue and chroma at mean-L + 0.14, gamut-reduced). Non-normal shades are
// stored as family-name values with a `-dark`/`-light` suffix ("blue-dark",
// "blue-light"); they have NO legacy numeric form (the legacy vocabulary
// predates the shade axis), so the write seam passes them through verbatim
// while normal picks keep the legacy mapping. The light rung reads faded —
// raising L at fixed chroma sheds chroma at the sRGB gamut boundary — an
// accepted trade that fits its recessive role in the family ramp (family =
// project identity, shade = sub-grouping).

/** The three color shades of every hue family. */
export type Shade = "light" | "normal" | "dark";

/** Stored-value suffix marking a family's dark shade ("blue-dark"). */
const SHADE_DARK_SUFFIX = "-dark";
/** Stored-value suffix marking a family's light shade ("blue-light"). */
const SHADE_LIGHT_SUFFIX = "-light";

/** OKLab lightness delta for the dark shade: L_dark = themeColorStats(palette).L − 0.14
 *  (same hue, same chroma; gamut-reduced via oklchToHexInGamut like the normal
 *  shade, so hue identity and theme adaptation are preserved). */
const DARK_SHADE_L_DELTA = 0.14;
/** OKLab lightness delta for the light shade: L_light = themeColorStats(palette).L + 0.14 —
 *  the exact mirror of the dark rung (same hue, same chroma, gamut-reduced
 *  identically). */
const LIGHT_SHADE_L_DELTA = 0.14;

/** Compose a family + shade into its canonical stored/display value. */
function shadedName(family: HueFamily, shade: Shade): string {
  if (shade === "dark") return family.name + SHADE_DARK_SUFFIX;
  if (shade === "light") return family.name + SHADE_LIGHT_SUFFIX;
  return family.name;
}

/** Display-ordered list of every picker color value — the 30 family/shade
 *  values in family-TRIPLET order (red-light, red, red-dark, orange-light, …)
 *  so the banded picker's column-flow strip renders one family per column with
 *  its three shades as the light/normal/dark rows — swatch-popover's row
 *  slices depend on this order (index mod 3 = 0/1/2 → light/normal/dark). The picker PRESENTS these
 *  values; NORMAL-shade writes are mapped back to the legacy numeric/blend
 *  descriptor at the write seam (familyToLegacy) while light/dark values are
 *  stored verbatim; all forms resolve on read (see resolveFamily /
 *  colorValueToHex). */
export const PICKER_COLOR_VALUES: readonly string[] = HUE_FAMILIES.flatMap((f) => [
  f.name + SHADE_LIGHT_SUFFIX,
  f.name,
  f.name + SHADE_DARK_SUFFIX,
]);

/** ANSI index used to render uncolored rows in the selected state. */
export const UNCOLORED_SELECTED_ANSI = 8;
/** Sentinel color-value key for the uncolored-selected gray tint. */
export const UNCOLORED_SELECTED_KEY = `${UNCOLORED_SELECTED_ANSI}`;

// ── Row flair (decoration-only channel) ──────────────────────────────────────

/** The row flair states. `""` (no flair) is the rest state. A flair is an
 *  always-on, ambient, CSS-only animated row overlay (globals.css
 *  `.rk-flair-*`) available on window rows and session rows (NOT server group
 *  headers — those mirror the SERVER-pane tiles, whose visual identity must
 *  stay flair-free). Flair is DECORATION ONLY — unlike the marker's label
 *  conventions, it carries no semantic at all: no wiring to `@rk_pane_agent_state`
 *  or the status pyramid. `rain` and `scan` lead the display order — they are
 *  the marker axis's retired motion (the dashed data rain and the double
 *  scanlines + crawl + refresh band), now user-composable with ANY marker;
 *  both tint from `--rk-flair-color`. Mirrors the backend closed set minus the
 *  empty string, with `""` at the front. */
export const FLAIR_STATES = ["", "rain", "scan", "nyan", "naruto", "onepiece", "pacman", "matrix", "aquarium", "nemo", "roadrunner", "invaders", "cube", "warp", "spidey", "ironman", "noon"] as const;

/** A flair state — one of FLAIR_STATES. */
export type FlairState = (typeof FLAIR_STATES)[number];

/** A parsed color value: an owned family (canonical name, optionally
 *  `-dark`-/`-light`-suffixed) OR a legacy numeric/blend descriptor that maps
 *  onto one (always the normal shade — legacy has no shade slot). `null` when
 *  unrecognized. */
export type PickerColor = { family: HueFamily; shade: Shade };

/** Normalize a legacy numeric/blend descriptor ("01", " 1 + 3 ") to its
 *  canonical form ("1", "1+3"), or null when malformed. Mirrors the backend
 *  validate.NormalizeColorValue rule (parts trimmed, empty parts rejected). */
function normalizeLegacy(value: string): string | null {
  const parts = value.trim().split("+");
  if (parts.length < 1 || parts.length > 2) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t === "" || !/^\d+$/.test(t)) return null;
    nums.push(Number(t));
  }
  return nums.join("+");
}

/** Resolve a stored color value to its owned family + shade. Accepts a family
 *  name ("orange"), a `-dark`-/`-light`-suffixed family name ("orange-dark",
 *  "orange-light"), or a legacy numeric/blend descriptor ("1+3" — always the
 *  normal shade). Returns null when the value matches none. */
function resolveShaded(value: string | null | undefined): PickerColor | null {
  if (value == null) return null;
  const trimmed = value.trim();
  const byName = FAMILY_BY_NAME.get(trimmed);
  if (byName) return { family: byName, shade: "normal" };
  if (trimmed.endsWith(SHADE_DARK_SUFFIX)) {
    const base = FAMILY_BY_NAME.get(trimmed.slice(0, -SHADE_DARK_SUFFIX.length));
    if (base) return { family: base, shade: "dark" };
  }
  if (trimmed.endsWith(SHADE_LIGHT_SUFFIX)) {
    const base = FAMILY_BY_NAME.get(trimmed.slice(0, -SHADE_LIGHT_SUFFIX.length));
    if (base) return { family: base, shade: "light" };
  }
  const normalized = normalizeLegacy(trimmed);
  if (normalized == null) return null;
  const byLegacy = FAMILY_BY_LEGACY.get(normalized);
  return byLegacy ? { family: byLegacy, shade: "normal" } : null;
}

/** Resolve a stored color value to its owned family (hue identity — the shade
 *  is dropped; use parseColorValue when the shade matters). Accepts a family
 *  name ("orange"), a `-dark`-/`-light`-suffixed name ("orange-dark",
 *  "orange-light"), or a legacy numeric/blend descriptor ("1+3"), returning
 *  the same family for all. Returns null when the value matches none. */
export function resolveFamily(value: string | null | undefined): HueFamily | null {
  return resolveShaded(value)?.family ?? null;
}

/** Parse a stored color value into a {family, shade} descriptor, or null when
 *  it maps to no owned family. Accepts family names, `-dark`-/`-light`-suffixed
 *  family names, and legacy numeric/blend aliases (always normal shade). */
export function parseColorValue(value: string | null | undefined): PickerColor | null {
  return resolveShaded(value);
}

/** Format a {family, shade} descriptor into its canonical DISPLAY value — the
 *  family name, suffixed `-dark`/`-light` for the non-normal shades. Note this
 *  is not always the storage form: NORMAL-shade writes are mapped to the
 *  legacy descriptor at the write seam (familyToLegacy) so pre-existing values
 *  stay in the legacy vocabulary; light/dark values ARE stored in this form
 *  (no legacy slot exists). */
export function formatColorValue(color: PickerColor): string {
  return shadedName(color.family, color.shade);
}

/** Map a picker family name ("orange") to the LEGACY numeric/blend descriptor
 *  it was historically stored as ("1+3"). Every color write seam funnels the
 *  picked value through this map so NORMAL-shade picks keep writing the legacy
 *  vocabulary exactly as before the shade axis (zero migration — pre-existing
 *  values stay valid and byte-identical). DARK- and LIGHT-shade picks
 *  ("orange-dark", "orange-light") have NO legacy form and pass through
 *  unchanged — they are stored as the `{family}-{shade}` value itself, which
 *  the backend validators now accept alongside the numeric forms
 *  (validate.ValidateColorValue / NormalizeColorValue). A value that is
 *  already legacy (or unrecognized) is returned unchanged, so the mapping is
 *  idempotent and safe on any input. */
export function familyToLegacy(value: string | null): string | null {
  if (value == null) return null;
  const family = FAMILY_BY_NAME.get(value.trim());
  return family ? family.legacy : value;
}

/** Resolve a color value's theme-adapted source hex: the value's owned family
 *  rendered at the theme's mean L/C in the family's own hue, brought into the
 *  sRGB gamut by chroma reduction. The DARK shade renders at mean-L − 0.14 and
 *  the LIGHT shade at mean-L + 0.14 with the same hue and chroma
 *  (gamut-reduced identically), so hue identity and theme adaptation carry
 *  over with zero new palette data. `slate` uses a near-neutral chroma
 *  (min(C_theme × 0.2, 0.025)) in all three shades — an intentional gray ramp.
 *  Accepts family names, `-dark`-/`-light`-suffixed names, and legacy aliases.
 *  Returns null when the value maps to no owned family. */
export function colorValueToHex(value: string, palette: ThemePalette): string | null {
  const parsed = resolveShaded(value);
  if (!parsed) return null;
  const { family, shade } = parsed;
  const { L, C } = themeColorStats(palette);
  const chroma = family.neutral ? Math.min(C * 0.2, 0.025) : C;
  const lightness = shade === "dark" ? L - DARK_SHADE_L_DELTA : shade === "light" ? L + LIGHT_SHADE_L_DELTA : L;
  return oklchToHexInGamut(lightness, chroma, family.hue);
}

/** Pre-blended row tint colors for a single owned family at three states. */
export type RowTint = {
  base: string;     // 14% saturated-source into the surface
  hover: string;    // 22% saturated-source into the surface
  selected: string; // 40% saturated-source into the surface
};

const TINT_SATURATE_FACTOR = 1.5;
const TINT_BASE_RATIO = 0.14;
const TINT_HOVER_RATIO = 0.22;
// Selection is now carried by tint DEPTH alone (the 4px left border was removed
// in the axis split), so the selected tint is deepened from 0.32 → 0.40.
const TINT_SELECTED_RATIO = 0.4;
/** Uncolored selected rows use a deeper ratio so they beat the
 *  `bg-bg-chrome-raised` hover step on the chrome surface. */
const UNCOLORED_SELECTED_RATIO = 0.5;

/**
 * Pre-compute blended hex values for all owned family/shade values, keyed under
 * EVERY stored vocabulary form: each NORMAL shade under both the family name
 * ("orange") AND its legacy numeric/blend descriptor ("1+3") pointing at the
 * same tint entry, each DARK/LIGHT shade under its `{family}-dark` /
 * `{family}-light` value (its only stored form — no legacy alias exists), plus
 * the uncolored-selected sentinel "8". All keys are populated because consumers
 * (window-row/session-row/server-panel) look up the RAW stored color value, and
 * the backend still emits the legacy vocabulary for pre-existing colors — a
 * family-name-only map would miss every pre-existing colored row. Each value's
 * theme-adapted source hex (colorValueToHex — the dark shade at mean-L − 0.14,
 * the light shade at mean-L + 0.14) is saturated (×1.5) before blending so row
 * tints read as their intended color rather than grayish, while blend ratios
 * stay muted. Gray (ANSI 8) is not saturated (near-zero saturation by
 * definition) and uses a 0.5 selected ratio so uncolored selected rows beat
 * the chrome-raised hover.
 *
 * `surface` is the hex the rows render on (the sidebar chrome); blending into
 * anything else would leave a foreign-colored halo around every tinted band.
 */
export function computeRowTints(palette: ThemePalette, surface: string): Map<string, RowTint> {
  const bg = surface;
  const tints = new Map<string, RowTint>();

  const tintFor = (src: string): RowTint => {
    const fg = saturateHex(src, TINT_SATURATE_FACTOR);
    return {
      base: blendHex(fg, bg, TINT_BASE_RATIO),
      hover: blendHex(fg, bg, TINT_HOVER_RATIO),
      selected: blendHex(fg, bg, TINT_SELECTED_RATIO),
    };
  };

  for (const family of HUE_FAMILIES) {
    const src = colorValueToHex(family.name, palette);
    if (src != null) {
      const tint = tintFor(src);
      // Key both the family name and its legacy descriptor at the same entry.
      tints.set(family.name, tint);
      tints.set(family.legacy, tint);
    }
    // Non-normal shades have exactly one stored form — the suffixed value.
    for (const shade of ["light", "dark"] as const) {
      const shadeName = shadedName(family, shade);
      const shadeSrc = colorValueToHex(shadeName, palette);
      if (shadeSrc != null) {
        tints.set(shadeName, tintFor(shadeSrc));
      }
    }
  }

  // Uncolored-selected gray sentinel (not saturated; deeper selected ratio).
  const gray = palette.ansi[UNCOLORED_SELECTED_ANSI];
  tints.set(UNCOLORED_SELECTED_KEY, {
    base: blendHex(gray, bg, TINT_BASE_RATIO),
    hover: blendHex(gray, bg, TINT_HOVER_RATIO),
    selected: blendHex(gray, bg, UNCOLORED_SELECTED_RATIO),
  });

  return tints;
}

/**
 * Pre-compute the contrast-adjusted full-saturation border color for every owned
 * family/shade value (plus the uncolored-selected sentinel), keyed under every
 * stored vocabulary form (normal: family name AND legacy descriptor pointing at
 * the same border; light/dark: the `{family}-light` / `{family}-dark` value) —
 * mirroring computeRowTints, so consumers keyed by the raw stored value hit
 * regardless of which vocabulary is stored. Each border is the value's
 * theme-adapted source hex passed through the WCAG contrast guardrail (nudge
 * OKLab L until it clears BORDER_MIN_CONTRAST vs the theme background —
 * bidirectional: light shades on light themes are pushed darker). The window
 * row no longer uses these for a selection border (removed in the axis split),
 * but SERVER tiles still use them for their stripe/edge, and the marker gutter
 * uses them as the guarded family color. Computed once per theme alongside
 * computeRowTints.
 */
export function computeRowBorders(palette: ThemePalette, category: "dark" | "light"): Map<string, string> {
  const bg = palette.background;
  const isDark = category === "dark";
  const borders = new Map<string, string>();

  for (const family of HUE_FAMILIES) {
    const src = colorValueToHex(family.name, palette);
    if (src != null) {
      const border = adjustBorderForContrast(src, bg, isDark, BORDER_MIN_CONTRAST);
      borders.set(family.name, border);
      borders.set(family.legacy, border);
    }
    for (const shade of ["light", "dark"] as const) {
      const shadeName = shadedName(family, shade);
      const shadeSrc = colorValueToHex(shadeName, palette);
      if (shadeSrc != null) {
        borders.set(shadeName, adjustBorderForContrast(shadeSrc, bg, isDark, BORDER_MIN_CONTRAST));
      }
    }
  }

  borders.set(
    UNCOLORED_SELECTED_KEY,
    adjustBorderForContrast(palette.ansi[UNCOLORED_SELECTED_ANSI], bg, isDark, BORDER_MIN_CONTRAST),
  );

  return borders;
}

// ── Theme data (loaded from configs/themes.json) ─────────────────────────────

export const THEMES: Theme[] = (themeDefs as unknown as Theme[]);

// ── Lookup helpers ───────────────────────────────────────────────────────────

export function getThemeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

export const DEFAULT_DARK_THEME: Theme = THEMES.find((t) => t.id === "default-dark")!;
export const DEFAULT_LIGHT_THEME: Theme = THEMES.find((t) => t.id === "default-light")!;
