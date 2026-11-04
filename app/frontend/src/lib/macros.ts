import type { KeyBinding } from "@/lib/keybindings";

/**
 * Macro shortcut bindings over riff presets (260730-hbyh) — the "macro" kind
 * g40a's registry reserved. A macro is a user-named keyboard route to an
 * EXISTING validated action: a riff preset (spawned via the already-validated
 * `POST /api/riff` seam) or a command-palette action (dispatched in-place).
 * Macros NEVER carry shell strings — the riff target is a preset NAME only;
 * the skill lives in the preset definition under `riff_presets` in run-kit's
 * `~/.config/hexokit/config.yaml` (built-ins ship in the binary), and presets
 * are skill-only so the settings-API-writable file never contributes a raw
 * shell string (Constitution I).
 *
 * v1 riff targets deliberately carry NO `args` passthrough: the POST /api/riff
 * body has no args seam and its `task` field REPLACES preset panes
 * (`composePanes` in internal/riff), so per-macro dynamic args are not
 * expressible without a backend extension. Encode arguments in the preset.
 *
 * Persistence is per-device: definitions in `localStorage["hexokit-macros"]`
 * (a JSON array of MacroAction); each macro's key combo lives as an ordinary
 * override entry in `localStorage["hexokit-keybindings"]` keyed by the macro's
 * actionId (see `hooks/use-keybindings.ts`) — a macro without an entry is
 * unbound. Pure + DOM-light, the `lib/keybindings.ts` convention; React
 * integration is `hooks/use-macros.ts`.
 */

/** What a macro executes. A discriminated union — never a shell string. */
export type MacroTarget =
  | { type: "riff"; preset: string }
  | { type: "palette"; paletteActionId: string };

export type MacroAction = {
  /** Stable id, `"macro:<slug>"`; doubles as the palette action id. */
  actionId: string;
  kind: "macro";
  /** User-provided display name (overlay row + `Macro: {label}` palette entry). */
  label: string;
  target: MacroTarget;
};

export const MACROS_STORAGE_KEY = "hexokit-macros";
export const MACRO_ID_PREFIX = "macro:";

/** Whether an actionId belongs to a macro (used to exclude macros from target
 *  lists and from palette-target resolution — no macro→macro recursion). */
export function isMacroActionId(actionId: string): boolean {
  return actionId.startsWith(MACRO_ID_PREFIX);
}

function isMacroTarget(value: unknown): value is MacroTarget {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "riff") {
    return "preset" in value && typeof value.preset === "string" && value.preset.length > 0;
  }
  if (value.type === "palette") {
    return (
      "paletteActionId" in value &&
      typeof value.paletteActionId === "string" &&
      value.paletteActionId.length > 0
    );
  }
  return false;
}

function isMacroAction(value: unknown): value is MacroAction {
  if (typeof value !== "object" || value === null) return false;
  if (!("actionId" in value) || !("label" in value) || !("target" in value)) return false;
  return (
    typeof value.actionId === "string" &&
    isMacroActionId(value.actionId) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    isMacroTarget(value.target)
  );
}

/** Tolerant parse of the stored macro list: malformed JSON, a non-array root,
 *  or garbage entries degrade to dropped/empty (the `parseOverrides` posture). */
export function parseMacros(raw: string | null): MacroAction[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const macros: MacroAction[] = [];
  for (const entry of parsed) {
    if (!isMacroAction(entry)) continue;
    // Re-project the valid fields (drops unknown keys, pins kind).
    macros.push({
      actionId: entry.actionId,
      kind: "macro",
      label: entry.label,
      target:
        entry.target.type === "riff"
          ? { type: "riff", preset: entry.target.preset }
          : { type: "palette", paletteActionId: entry.target.paletteActionId },
    });
  }
  return macros;
}

/** Read the persisted macros; `[]` when absent or localStorage is unavailable. */
export function readStoredMacros(): MacroAction[] {
  try {
    return parseMacros(localStorage.getItem(MACROS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Persist the macro list (best-effort; an empty list removes the key). */
export function writeStoredMacros(macros: readonly MacroAction[]): void {
  try {
    if (macros.length === 0) {
      localStorage.removeItem(MACROS_STORAGE_KEY);
    } else {
      localStorage.setItem(MACROS_STORAGE_KEY, JSON.stringify(macros));
    }
  } catch {
    /* noop — best-effort persistence */
  }
}

/**
 * Derive a unique `"macro:<slug>"` id from a user label: lowercase, non-
 * alphanumeric runs collapse to `-`, `-2`/`-3`… suffixes on collision (the
 * riff `resolveWindowName` convention). An empty slug falls back to "macro".
 */
export function makeMacroActionId(label: string, existingIds: Iterable<string>): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "macro";
  const taken = new Set(existingIds);
  const base = `${MACRO_ID_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Project a macro into a registry KeyBinding. Macros ship NO default combo —
 * `code: ""` resolves unbound unless a `hexokit-keybindings` override supplies
 * one (see `resolveBindings`). Global scope: applicability is handler presence
 * at each dispatcher mount, exactly like the builtins.
 */
export function macroToBinding(macro: MacroAction): KeyBinding {
  return {
    actionId: macro.actionId,
    code: "",
    tier: "shifted",
    scope: "global",
    kind: "macro",
    label: macro.label,
    description: macroCommandPreview(macro.target),
    mapLabel: macro.label,
  };
}

/** The overlay row's resolved-command preview (per the g40a mock's macro-cmd
 *  chip): `rk riff --preset discuss` / `palette: {actionId}`. */
export function macroCommandPreview(target: MacroTarget): string {
  return target.type === "riff"
    ? `rk riff --preset ${target.preset}`
    : `palette: ${target.paletteActionId}`;
}
