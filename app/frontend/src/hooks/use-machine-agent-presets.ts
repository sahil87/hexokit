import { useEffect, useState } from "react";
import type { FabAgentPreset } from "@/api/client";
import { loadMachineAgentPresets } from "@/lib/agent-presets";

/** The machine-wide agent presets (undefined until read, or when fab cannot
 *  list presets). One cached read on mount — no polling; the palette uses it
 *  to hide the Set actions when fab reports none. */
export function useMachineAgentPresets(): FabAgentPreset[] | undefined {
  const [presets, setPresets] = useState<FabAgentPreset[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadMachineAgentPresets().then((list) => {
      if (!cancelled) setPresets(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return presets;
}
