import { familyToLegacy, HUE_FAMILIES, hexToOklch, resolveFamily } from "@/themes";
import type { HueFamily } from "@/themes";
import { hostMonogram } from "@/lib/shell-strip";

/**
 * Host color: the host-owned identity color shown on the desktop strip's
 * square and light, picked from a small set of well-separated hues. The set
 * is a subset of the shared owned hue families (themes.ts) so a host color is
 * the same vocabulary the sidebar uses; values persist through
 * `familyToLegacy` (the instance accent's write seam) and anything stored
 * outside the set only SNAPS for display — the stored value is never
 * rewritten until the user picks again.
 */

/** The Host color set, in swatch order. */
export const HOST_COLOR_FAMILIES = [
  "purple",
  "violet",
  "blue",
  "red",
  "green",
  "teal",
  "magenta",
  "slate",
  "amber",
] as const;

export type HostColorFamily = (typeof HOST_COLOR_FAMILIES)[number];

function isHostColorFamily(name: string): name is HostColorFamily {
  return HOST_COLOR_FAMILIES.some((f) => f === name);
}

/** Below this OKLCH chroma a color reads as gray, whatever its hue angle. */
const NEUTRAL_CHROMA_MAX = 0.06;

const HUE_CIRCLE_DEG = 360;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % HUE_CIRCLE_DEG;
  return d > HUE_CIRCLE_DEG / 2 ? HUE_CIRCLE_DEG - d : d;
}

function chromaticSetFamilies(): HueFamily[] {
  return HUE_FAMILIES.filter((f) => isHostColorFamily(f.name) && f.neutral !== true);
}

/** The set member nearest a hue angle (degrees) among the chromatic families. */
function nearestByHue(hueDeg: number): HostColorFamily {
  const normalized = ((hueDeg % HUE_CIRCLE_DEG) + HUE_CIRCLE_DEG) % HUE_CIRCLE_DEG;
  let best: HostColorFamily = "blue";
  let bestDistance = Infinity;
  for (const f of chromaticSetFamilies()) {
    const d = hueDistance(f.hue, normalized);
    if (d < bestDistance && isHostColorFamily(f.name)) {
      bestDistance = d;
      best = f.name;
    }
  }
  return best;
}

/**
 * The Host color family a stored `instance_color` displays as: a member of
 * the set maps to itself, a neutral family (or none) to slate, any other
 * owned family (orange, olive, shades, legacy blends) to the nearest set
 * member by hue. Null for no color or a value no owned family recognises.
 */
export function snapHostColor(value: string | null | undefined): HostColorFamily | null {
  const family = resolveFamily(value);
  if (family === null) return null;
  if (isHostColorFamily(family.name)) return family.name;
  if (family.neutral === true) return "slate";
  return nearestByHue(family.hue);
}

/** The descriptor to persist for a set member (the legacy write seam). */
export function hostColorValue(family: HostColorFamily): string {
  return familyToLegacy(family) ?? family;
}

/**
 * Classify a projected host-color hex into the set: low chroma reads as slate,
 * everything else as the nearest set member by OKLCH hue. Hexes in the
 * projection are theme-derived renderings, so this is the cheapest faithful
 * way back to a family without a descriptor channel.
 */
export function classifyHostHex(hex: string): HostColorFamily {
  const { C, hueDeg } = hexToOklch(hex);
  if (C < NEUTRAL_CHROMA_MAX) return "slate";
  return nearestByHue(hueDeg);
}

/** The other hosts using each set member. */
export interface HostHueUse {
  family: HostColorFamily;
  /** Names of the other hosts using this hue, in list order. */
  names: string[];
  /** Their monograms, in the same order. */
  monograms: string[];
}

/**
 * Which hues the OTHER connected hosts already use. `others` carries each
 * other host's name and projected color hex (hosts with no color are skipped).
 */
export function usedHostHues(
  others: readonly { name: string; accentColor?: string }[],
): Map<HostColorFamily, HostHueUse> {
  const used = new Map<HostColorFamily, HostHueUse>();
  for (const host of others) {
    if (host.accentColor === undefined) continue;
    const family = classifyHostHex(host.accentColor);
    const entry = used.get(family) ?? { family, names: [], monograms: [] };
    entry.names.push(host.name);
    entry.monograms.push(hostMonogram(host.name));
    used.set(family, entry);
  }
  return used;
}

/** Advisory copy when the pick clashes; null when it does not. */
export function hostColorClashMessage(
  pick: HostColorFamily | null,
  used: ReadonlyMap<HostColorFamily, HostHueUse>,
): string | null {
  if (pick === null) return null;
  const entry = used.get(pick);
  if (!entry) return null;
  return `Same color as ${entry.names.join(", ")}. Pick another so the squares stay distinct.`;
}
