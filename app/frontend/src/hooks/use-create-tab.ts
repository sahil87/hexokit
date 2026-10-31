import { useCallback } from "react";
import { createWindow } from "@/api/client";
import { useToast } from "@/components/toast";
import { rawBasename } from "@/lib/names";
import { useWindowStore } from "@/store/window-store";

/**
 * The optimistic create-tab lifecycle shared by the sidebar `+`, the palette
 * and the New sheet: add a ghost tab labelled with the raw folder basename
 * (what tmux will auto-name the unnamed tab), `createWindow(server, group,
 * undefined, cwd)`, drop the ghost and toast on failure. Each call owns its
 * own ghost, so rapid creates never strand one. Returns a stable function.
 */
export function useCreateTab(): (server: string, group: string, cwd: string | undefined) => void {
  const addGhostWindow = useWindowStore((s) => s.addGhostWindow);
  const removeGhost = useWindowStore((s) => s.removeGhost);
  const { addToast } = useToast();

  return useCallback(
    (server: string, group: string, cwd: string | undefined) => {
      const ghostId = addGhostWindow(server, group, rawBasename(cwd));
      createWindow(server, group, undefined, cwd).catch((err: unknown) => {
        removeGhost(ghostId);
        addToast((err instanceof Error && err.message) || "Failed to create tab");
      });
    },
    [addGhostWindow, removeGhost, addToast],
  );
}
