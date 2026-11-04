import { useCallback, useRef } from "react";
import { createSession } from "@/api/client";
import { useToast } from "@/components/toast";
import { useOptimisticContext } from "@/contexts/optimistic-context";

/**
 * The optimistic create-group lifecycle shared by every opener (instant
 * sidebar/palette creates, the named prompt, the New sheet, the board
 * sidebar): add a ghost group, `createSession(server, name, cwd)`, drop the
 * ghost and toast on failure. A success leaves the ghost for the SSE payload
 * to reconcile.
 *
 * One create is in flight at a time: `createGroup` returns false and does
 * nothing while a previous one is unsettled, so a second submit cannot strand
 * a ghost. Both returned functions are referentially stable.
 */
export function useCreateGroup(): {
  createGroup: (server: string, name: string, cwd: string | undefined) => boolean;
  isCreatingGroup: () => boolean;
} {
  const { addGhostSession, removeGhost } = useOptimisticContext();
  const { addToast } = useToast();
  const inFlightRef = useRef(false);

  const createGroup = useCallback(
    (server: string, name: string, cwd: string | undefined) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      const ghostId = addGhostSession(server, name);
      createSession(server, name, cwd).then(
        () => {
          inFlightRef.current = false;
        },
        (err: unknown) => {
          inFlightRef.current = false;
          removeGhost(ghostId);
          addToast((err instanceof Error && err.message) || "Failed to create group");
        },
      );
      return true;
    },
    [addGhostSession, removeGhost, addToast],
  );

  const isCreatingGroup = useCallback(() => inFlightRef.current, []);

  return { createGroup, isCreatingGroup };
}
