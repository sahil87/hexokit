import type { FabAgentPreset, FabRole, FabRoleCell, FabConfigDocument, ServerInfo } from "@/api/client";
import type { ProjectSession } from "@/types";

/** Pure rules behind the Settings > Agents preset editor: name checks, the
 *  per-preset field map, where a preset is used, the loose machine-wide values
 *  and what each group or workspace with its own preset would stop inheriting
 *  when they are moved or cleared. */

type Document = Extract<FabConfigDocument, { installed: true }>;

export const PRESET_NONE = "none";
export const PRESET_NAME_MAX = 64;
const PRESET_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const COPY_SUFFIX = "-copy";
const DEFAULT_TOOL = "claude";

export const MSG_NAME_REQUIRED = "Give the preset a name.";
export const MSG_NAME_CHARS = "Use letters, digits, - and _ only; no spaces.";
export const MSG_NAME_RESERVED = `"${PRESET_NONE}" is reserved; it means no preset.`;
export const MSG_DESCRIPTION_REQUIRED = "Add a one-line description; it is shown wherever the preset is picked.";
export const MSG_LAST_FIELD = "a preset needs at least one setting — delete it instead";
export const MOVE_DEFAULT_NAME = "my-overrides";
export const MOVE_DEFAULT_DESCRIPTION = "Moved from loose machine-wide settings";

export const nameTakenMessage = (name: string) => `A preset named ${name} already exists.`;

/** The reason a name cannot be used, or "" when it can. `taken` is every listed
 *  preset name (built-in or yours). */
export function presetNameError(name: string, taken: readonly string[]): string {
  if (name === "") return MSG_NAME_REQUIRED;
  if (name.length > PRESET_NAME_MAX || !PRESET_NAME_PATTERN.test(name)) return MSG_NAME_CHARS;
  if (name === PRESET_NONE) return MSG_NAME_RESERVED;
  if (taken.includes(name)) return nameTakenMessage(name);
  return "";
}

/** `base`, else `base-2`, `base-3`, … — the first not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export const duplicateName = (source: string, taken: readonly string[]) => uniqueName(`${source}${COPY_SUFFIX}`, taken);

export const isBuiltIn = (preset: FabAgentPreset) => preset.source === "built-in";

/** Config key for one field of a preset (`description`, `session`, `workers` or
 *  `profiles.<role>.<cli|model|effort>`). */
export const presetKey = (name: string, field: string) => `agent_presets.${name}.${field}`;

/** Every set leaf of a preset, keyed by its field path. */
export function presetFieldMap(preset: FabAgentPreset): Record<string, string> {
  const fields: Record<string, string> = {};
  if (preset.description) fields.description = preset.description;
  if (preset.session) fields.session = preset.session;
  if (preset.workers) fields.workers = preset.workers;
  for (const [role, leaves] of Object.entries(preset.profiles ?? {})) {
    for (const [leaf, value] of Object.entries(leaves)) {
      if (value) fields[`profiles.${role}.${leaf}`] = value;
    }
  }
  return fields;
}

/** Whether applying `patch` would leave the preset with no field at all — fab
 *  deletes a preset whose last leaf is unset, so the editor never sends such a
 *  patch. */
export function emptiesPreset(preset: FabAgentPreset, patch: Record<string, unknown>): boolean {
  const prefix = presetKey(preset.name, "");
  const fields = presetFieldMap(preset);
  const had = Object.keys(fields).length;
  let unsets = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (value === null || value === "") {
      delete fields[field];
      unsets = true;
    } else {
      fields[field] = String(value);
    }
  }
  return unsets && had > 0 && Object.keys(fields).length === 0;
}

// ---- usage ----

type Sessions = ReadonlyMap<string, readonly ProjectSession[]>;

export type PresetUsage = {
  machineDefault: boolean;
  workspaces: string[];
  groups: string[];
};

/** Where a preset is named: the machine default, workspaces (server option) and
 *  groups (session option) among the servers the client knows. */
export function presetUsage(
  name: string,
  machineDefault: string,
  servers: readonly ServerInfo[],
  sessionsByServer: Sessions,
): PresetUsage {
  const groups = new Set<string>();
  for (const sessions of sessionsByServer.values()) {
    for (const s of sessions) if (s.agent_preset === name) groups.add(s.name);
  }
  return {
    machineDefault: machineDefault === name,
    workspaces: servers.filter((s) => s.agent_preset === name).map((s) => s.name),
    groups: [...groups],
  };
}

/** "the machine default", "workspace loom", "group hexokit" — in that order. */
export function usageLabels(usage: PresetUsage): string[] {
  return [
    ...(usage.machineDefault ? ["the machine default"] : []),
    ...usage.workspaces.map((w) => `workspace ${w}`),
    ...usage.groups.map((g) => `group ${g}`),
  ];
}

// ---- dimmed "what applies" values ----

/** What an unset Session/Worker CLI resolves to: the explicit env or system
 *  value a non-preset origin supplied, else fab's default. Only one preset
 *  applies at a time, so the machine default preset's own knob never shows
 *  through. */
export function depthKnobApplies(doc: Document, depth: "session" | "workers"): string {
  const field = doc.fields[`agent.${depth}`];
  const explicit = field !== undefined && field.preset === undefined && (field.origin === "env" || field.origin === "system");
  return explicit && typeof field.value === "string" && field.value !== "" ? field.value : DEFAULT_TOOL;
}

export type ResolvedRoles = Record<string, { cli: string; model: string; effort: string }>;

/** The role table's rows for one preset: an override is the preset's own leaf;
 *  an unset leaf carries what applies (fab's resolution for model and effort,
 *  the depth knob for the CLI). */
export function presetRoleRows(doc: Document, preset: FabAgentPreset, resolved: ResolvedRoles | undefined): FabRole[] {
  return doc.roles.map((role) => {
    const leaves = preset.profiles?.[role.role] ?? {};
    const knob = preset[role.depth] || depthKnobApplies(doc, role.depth);
    const applied = resolved?.[role.role];
    const cell = (own: string | undefined, appliedValue: string, inherited: string): FabRoleCell => ({
      override: own ?? null,
      effective: own ?? appliedValue,
      source: "",
      origin: "",
      inherited,
    });
    return {
      role: role.role,
      depth: role.depth,
      tool: cell(leaves.cli, applied?.cli || knob, knob),
      model: cell(leaves.model, applied?.model ?? "", ""),
      effort: cell(leaves.effort, applied?.effort ?? "", ""),
    };
  });
}

// ---- leftover (loose) machine-wide settings ----

export type LooseValue = {
  /** The preset field path it maps to (`session`, `workers`, `profiles.<role>.<leaf>`). */
  field: string;
  /** Plain-words label: "review CLI = codex". */
  label: string;
};

const LEAF_WORD: Record<"cli" | "model" | "effort", string> = { cli: "CLI", model: "model", effort: "effort" };

/** The explicit system-layer values that belong to no preset: the depth knobs
 *  and every role leaf the system file sets. Environment values are not
 *  leftovers — they keep the env-shadow warning. */
export function looseValues(doc: Document): LooseValue[] {
  const out: LooseValue[] = [];
  for (const [depth, word] of [["session", "session"], ["workers", "worker"]] as const) {
    const field = doc.fields[`agent.${depth}`];
    if (field && field.origin === "system" && field.preset === undefined && typeof field.value === "string" && field.value !== "") {
      out.push({ field: depth, label: `${word} CLI = ${field.value}` });
    }
  }
  for (const role of doc.roles) {
    for (const [leaf, cell] of [["cli", role.tool], ["model", role.model], ["effort", role.effort]] as const) {
      if (cell.override !== null && cell.override !== "") {
        out.push({ field: `profiles.${role.role}.${leaf}`, label: `${role.role} ${LEAF_WORD[leaf]} = ${cell.override}` });
      }
    }
  }
  return out;
}

export type InheritanceLoss = { entity: string; losses: string[] };

/** Per group or workspace with its own preset, the loose values it would stop
 *  inheriting once they are moved or cleared: those on fields its preset leaves
 *  unset (a preset fills only what it sets; the loose value filled the rest).
 *  `none` selects no preset, so everything loose is lost. A name fab does not
 *  list is ignored by fab and resolves like an inheriting entity. */
export function inheritanceLosses(
  loose: readonly LooseValue[],
  presets: readonly FabAgentPreset[],
  servers: readonly ServerInfo[],
  sessionsByServer: Sessions,
): InheritanceLoss[] {
  const entities: { entity: string; preset: string }[] = [
    ...servers.filter((s) => s.agent_preset).map((s) => ({ entity: `workspace ${s.name}`, preset: s.agent_preset as string })),
  ];
  const seen = new Set<string>();
  for (const sessions of sessionsByServer.values()) {
    for (const s of sessions) {
      if (s.agent_preset && !seen.has(s.name)) {
        seen.add(s.name);
        entities.push({ entity: `group ${s.name}`, preset: s.agent_preset });
      }
    }
  }
  const result: InheritanceLoss[] = [];
  for (const { entity, preset } of entities) {
    let setFields: Record<string, string> | undefined;
    if (preset === PRESET_NONE) setFields = {};
    else {
      const listed = presets.find((p) => p.name === preset);
      if (listed) setFields = presetFieldMap(listed);
    }
    if (!setFields) continue;
    const losses = loose.filter((l) => !(l.field in (setFields as Record<string, string>))).map((l) => l.label);
    if (losses.length > 0) result.push({ entity, losses });
  }
  return result;
}
