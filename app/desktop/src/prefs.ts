/**
 * Desktop-app preferences store: `<userData>/prefs.json` (schema version 1) —
 * settings that belong to the desktop APP rather than to any one host: they
 * cannot live in localStorage (every host is a separate origin inside the
 * shell, so a choice made on one host would vanish on switching) nor in a
 * host's config.yaml (the app is not a property of any host).
 *
 * Today's keys are the titlebar strip's `strip.effect` and `strip.motion`
 * (closed sets below; the SPA's lib/shell-strip.ts mirrors them).
 *
 * Deliberately electron-free — the data directory is a parameter (main.ts
 * passes `app.getPath('userData')`), the `windows.ts` discipline: tmp-file-
 * then-rename writes (atomic on POSIX), and a missing, corrupt, or
 * wrong-shape file recovers as the defaults; an unknown value for one key
 * falls back to that key's default without discarding the others.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STRIP_EFFECTS = ["glow", "livery", "halftone", "hex", "scan", "edge", "flat"] as const;
export type StripEffect = (typeof STRIP_EFFECTS)[number];

export const STRIP_MOTIONS = ["slide", "sweep", "cut"] as const;
export type StripMotion = (typeof STRIP_MOTIONS)[number];

export interface ShellPrefs {
  strip: { effect: StripEffect; motion: StripMotion };
}

/** The preference keys `prefs:set` accepts. */
export type PrefKey = "strip.effect" | "strip.motion";

const FILE_NAME = "prefs.json";

export const DEFAULT_STRIP_EFFECT: StripEffect = "glow";
export const DEFAULT_STRIP_MOTION: StripMotion = "slide";

export function defaultPrefs(): ShellPrefs {
  return { strip: { effect: DEFAULT_STRIP_EFFECT, motion: DEFAULT_STRIP_MOTION } };
}

export function isStripEffect(value: unknown): value is StripEffect {
  return typeof value === "string" && STRIP_EFFECTS.some((e) => e === value);
}

export function isStripMotion(value: unknown): value is StripMotion {
  return typeof value === "string" && STRIP_MOTIONS.some((m) => m === value);
}

/** Closed-set validation of one `prefs:set` request. */
export function isPrefsUpdate(
  key: unknown,
  value: unknown,
): key is PrefKey {
  if (key === "strip.effect") return isStripEffect(value);
  if (key === "strip.motion") return isStripMotion(value);
  return false;
}

function parsePrefs(value: unknown): ShellPrefs {
  const prefs = defaultPrefs();
  if (typeof value !== "object" || value === null) return prefs;
  if (!("strip" in value) || typeof value.strip !== "object" || value.strip === null) {
    return prefs;
  }
  const strip = value.strip;
  if ("effect" in strip && isStripEffect(strip.effect)) prefs.strip.effect = strip.effect;
  if ("motion" in strip && isStripMotion(strip.motion)) prefs.strip.motion = strip.motion;
  return prefs;
}

/** Load the prefs; missing/unreadable/corrupt → defaults. */
export function loadPrefs(dir: string): ShellPrefs {
  let raw: string;
  try {
    raw = readFileSync(join(dir, FILE_NAME), "utf8");
  } catch {
    return defaultPrefs();
  }
  try {
    return parsePrefs(JSON.parse(raw));
  } catch {
    return defaultPrefs();
  }
}

/** Persist atomically: write a tmp file in the same directory, then rename over the target. */
export function savePrefs(dir: string, prefs: ShellPrefs): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, FILE_NAME);
  const tmp = join(dir, `${FILE_NAME}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ version: 1, ...prefs }, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

/**
 * Apply one validated update and persist it. Returns the new prefs, or null
 * when the (key, value) pair is outside the closed sets (nothing written).
 */
export function setPref(dir: string, key: unknown, value: unknown): ShellPrefs | null {
  if (!isPrefsUpdate(key, value)) return null;
  const prefs = loadPrefs(dir);
  if (key === "strip.effect" && isStripEffect(value)) prefs.strip.effect = value;
  else if (key === "strip.motion" && isStripMotion(value)) prefs.strip.motion = value;
  else return null;
  savePrefs(dir, prefs);
  return prefs;
}
