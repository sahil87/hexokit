import { useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createServer } from "@/api/client";
import { useToast } from "@/components/toast";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useSessionContext } from "@/contexts/session-context";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";

/**
 * The create-workspace lifecycle shared by every opener: optimistic ghost,
 * `createServer(name, cwd)`, `markServerPending` so the route guard shows the
 * brief waiting state (not "Workspace not found") until the refreshed list
 * includes the new name, then navigation to `/$server`. Returns a stable
 * `(name, cwd) => void`.
 */
export function useCreateWorkspace(): (name: string, cwd: string | undefined) => void {
  const { refreshServers, markServerPending } = useSessionContext();
  const { removeGhost, addGhostServer } = useOptimisticContext();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const ghostServerIdRef = useRef<string | null>(null);

  const { execute } = useOptimisticAction<[string, string | undefined]>({
    action: (name, cwd) => createServer(name, cwd),
    onOptimistic: (name) => {
      ghostServerIdRef.current = addGhostServer(name);
    },
    onRollback: () => {
      if (ghostServerIdRef.current) {
        removeGhost(ghostServerIdRef.current);
        ghostServerIdRef.current = null;
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to create workspace");
    },
    onSettled: () => {
      ghostServerIdRef.current = null;
    },
    // The server list is otherwise fetched once: refresh it when the create
    // resolves so the new workspace appears and the waiting state swaps to the
    // view. `onAlwaysSettled`/`onAlwaysRollback` run even after the opener has
    // closed on navigation — they touch only root-level SessionContext.
    onAlwaysSettled: () => {
      refreshServers();
    },
    // A failed create must not strand the UI on the waiting state: an empty
    // name clears the pending marker.
    onAlwaysRollback: () => {
      markServerPending("");
    },
  });

  return useCallback(
    (name: string, cwd: string | undefined) => {
      execute(name, cwd);
      markServerPending(name);
      navigate({ to: "/$server", params: { server: name } });
    },
    [execute, markServerPending, navigate],
  );
}
