import { useEffect, useState } from "react";
import type { FabAgentPreset } from "@/api/client";
import { loadMachineAgentPresets, recallRepoAgentPresets } from "@/lib/agent-presets";

/** The preset list a card judges a stored name against: the group's repo-scoped
 *  list when its spawn dialog loaded one (pass `session`), else the machine-wide
 *  list. Undefined while loading or when fab cannot list presets. Mount it only
 *  where a name is actually shown — it triggers the (cached) read. */
export function useAgentPresetList(server?: string, session?: string): FabAgentPreset[] | undefined {
  const repoList = server && session ? recallRepoAgentPresets(server, session) : undefined;
  const [machine, setMachine] = useState<FabAgentPreset[] | undefined>(undefined);
  useEffect(() => {
    if (repoList) return;
    let cancelled = false;
    void loadMachineAgentPresets().then((list) => {
      if (!cancelled) setMachine(list);
    });
    return () => {
      cancelled = true;
    };
  }, [repoList]);
  return repoList ?? machine;
}
