import { getFabConfig, type FabAgentPreset } from "@/api/client";

/** fab's reserved agent-preset name: "no preset here, even the machine default". */
export const NO_AGENT_PRESET = "none";

/** How long the machine-wide preset list is reused before the next read. The
 *  list only changes when fab or its config does, so a short window keeps a
 *  card-open storm to one request without pinning a stale list. */
const MACHINE_LIST_TTL_MS = 30_000;

let machineList: { at: number; promise: Promise<FabAgentPreset[] | undefined> } | null = null;

/** The machine-wide agent presets (`GET /api/fab-config`'s `agent_presets`);
 *  resolves undefined when fab is absent or too old to list presets. Never
 *  rejects — an unreadable list reads as "no list available". */
export function loadMachineAgentPresets(): Promise<FabAgentPreset[] | undefined> {
  const now = Date.now();
  if (machineList && now - machineList.at < MACHINE_LIST_TTL_MS) return machineList.promise;
  const promise = getFabConfig()
    .then((doc) => (doc.installed ? doc.agent_presets : undefined))
    .catch(() => undefined);
  machineList = { at: now, promise };
  return promise;
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
  machineList = null;
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
