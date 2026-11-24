import { getFabConfig, type FabAgentPreset } from "@/api/client";

/** fab's reserved agent-preset name: "no preset here, even the machine default". */
export const NO_AGENT_PRESET = "none";

export type MachineAgentPresetInfo = {
  presets?: FabAgentPreset[];
  machineDefault?: string;
};

export type AgentPresetSource = "set here" | "from workspace" | "machine default" | "fab's defaults";

export type ResolvedAgentPreset = {
  name: string | undefined;
  source: AgentPresetSource;
};

export type AgentPresetChoice = {
  value: string | null;
  label: string;
  description?: string;
  checked: boolean;
};

/** How long the machine-wide preset info is reused before the next read. The
 *  config only changes when fab or its config does, so a short window keeps a
 *  card-open storm to one request without pinning stale values. */
const MACHINE_LIST_TTL_MS = 30_000;

let machineInfo: { at: number; promise: Promise<MachineAgentPresetInfo> } | null = null;

/** The machine-wide presets and default from one `GET /api/fab-config` read.
 *  Never rejects — unreadable config reads as no preset information. */
export function loadMachineAgentPresetInfo(): Promise<MachineAgentPresetInfo> {
  const now = Date.now();
  if (machineInfo && now - machineInfo.at < MACHINE_LIST_TTL_MS) return machineInfo.promise;
  const promise = getFabConfig()
    .then((doc): MachineAgentPresetInfo => {
      if (!doc.installed) return {};
      const configuredDefault = doc.fields?.["agent.preset"]?.value;
      return {
        presets: doc.agent_presets,
        machineDefault:
          typeof configuredDefault === "string" && configuredDefault.length > 0
            ? configuredDefault
            : undefined,
      };
    })
    .catch((): MachineAgentPresetInfo => ({}));
  machineInfo = { at: now, promise };
  return promise;
}

/** The machine-wide agent presets (`GET /api/fab-config`'s `agent_presets`);
 *  resolves undefined when fab is absent or too old to list presets. */
export async function loadMachineAgentPresets(): Promise<FabAgentPreset[] | undefined> {
  return (await loadMachineAgentPresetInfo()).presets;
}

// Repo-scoped lists the spawn dialog already fetched, keyed by `server/session`.
// A group's preset is judged against its own repo's list when one was loaded —
// a project-defined preset is absent from the machine list.
const repoLists = new Map<string, FabAgentPreset[]>();

const repoKey = (server: string, session: string) => `${server}/${session}`;

/** Remember (or forget, when `list` is undefined) the repo-scoped list a
 *  session's spawn dialog loaded. */
export function rememberRepoAgentPresets(server: string, session: string, list: FabAgentPreset[] | undefined): void {
  if (list) repoLists.set(repoKey(server, session), list);
  else repoLists.delete(repoKey(server, session));
}

export function recallRepoAgentPresets(server: string, session: string): FabAgentPreset[] | undefined {
  return repoLists.get(repoKey(server, session));
}

/** Test seam: forget every cached list. */
export function resetAgentPresetCache(): void {
  machineInfo = null;
  repoLists.clear();
}

/** How a stored preset name reads on a card. `none` is the reserved opt-out;
 *  a name missing from a known list is "unknown" (stale or hand-set); with no
 *  list to judge against, the raw name shows with no marker. */
export function describeAgentPreset(
  name: string,
  list: readonly FabAgentPreset[] | undefined,
): { label: string; unknown: boolean } {
  if (name === NO_AGENT_PRESET) return { label: "none (no preset)", unknown: false };
  if (!list) return { label: name, unknown: false };
  const unknown = !list.some((p) => p.name === name);
  return { label: unknown ? `${name} (unknown)` : name, unknown };
}

export function displayAgentPresetName(
  name: string | undefined,
  list: readonly FabAgentPreset[] | undefined,
): string {
  return name ? describeAgentPreset(name, list).label : "none";
}

export function resolveAgentPreset({
  own,
  workspace,
  machineDefault,
}: {
  own?: string;
  workspace?: string;
  machineDefault?: string;
}): ResolvedAgentPreset {
  if (own) return { name: own, source: "set here" };
  if (workspace) return { name: workspace, source: "from workspace" };
  if (machineDefault) return { name: machineDefault, source: "machine default" };
  return { name: undefined, source: "fab's defaults" };
}

export function buildAgentPresetChoices({
  presets,
  own,
  inherited,
}: {
  presets: readonly FabAgentPreset[] | undefined;
  own?: string;
  inherited: ResolvedAgentPreset;
}): AgentPresetChoice[] {
  return [
    {
      value: null,
      label: "inherit",
      description: `uses ${displayAgentPresetName(inherited.name, presets)} (${inherited.source})`,
      checked: !own,
    },
    ...(presets ?? []).map((preset) => ({
      value: preset.name,
      label: preset.name,
      description: preset.description,
      checked: own === preset.name,
    })),
    {
      value: NO_AGENT_PRESET,
      label: NO_AGENT_PRESET,
      description: "no preset, even the machine default",
      checked: own === NO_AGENT_PRESET,
    },
  ];
}
