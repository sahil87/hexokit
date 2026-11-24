import { useEffect, useState } from "react";
import { loadMachineAgentPresetInfo, type MachineAgentPresetInfo } from "@/lib/agent-presets";

/** The machine-wide preset list and default, read once through the shared
 *  cache. Undefined until the first read settles. */
export function useMachineAgentPresetInfo(): MachineAgentPresetInfo | undefined {
  const [info, setInfo] = useState<MachineAgentPresetInfo | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadMachineAgentPresetInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
