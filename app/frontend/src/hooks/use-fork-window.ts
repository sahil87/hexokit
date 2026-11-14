import { useCallback } from "react";
import { forkWindow, type ForkWhere } from "@/api/client";
import { useToast } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";

/**
 * The conversation-fork lifecycle (260806-s4av) shared by the row card and the
 * palette: a NEW window in the SAME session — same directory, or
 * (where="worktree") a new worktree + branch — resuming that agent's session
 * with its provider's fork command. The backend derives everything from the
 * windowId, so the client sends nothing but the identity.
 *
 * While the POST is in flight a placeholder `<name>-fork` ghost row sits under
 * the source's group (the useCreateTab idiom), so the fork stays visible after
 * the hover card closes; the SSE tick that brings the real window claims it, a
 * failure drops it and toasts. On success navigate to the fork; a best-effort
 * empty windowId (the backend's display-message resolve failed) skips
 * navigation and lets SSE surface the row, matching the spawn dialog's rule.
 *
 * RETURNS the settle promise (already error-handled here, so it never rejects):
 * the card's fork rows await it to hold their in-flight disabled state, so
 * repeated clicks cannot fire multiple mutating POSTs and create N forks.
 */
export function useForkWindow(
  navigateToSpawnedWindow: (server: string, windowId: string) => void,
): (server: string, windowId: string, where?: ForkWhere) => Promise<void> {
  const addGhostWindow = useWindowStore((s) => s.addGhostWindow);
  const removeGhost = useWindowStore((s) => s.removeGhost);
  const { addToast } = useToast();

  return useCallback(
    (server: string, windowId: string, where?: ForkWhere) => {
      const src = useWindowStore.getState().entries.get(`${server}:${windowId}`);
      const ghostId = src ? addGhostWindow(server, src.session, `${src.name}-fork`) : undefined;
      return forkWindow(server, windowId, where)
        .then((res) => {
          if (res.windowId) navigateToSpawnedWindow(server, res.windowId);
        })
        .catch((err: Error) => {
          if (ghostId) removeGhost(ghostId);
          addToast(err.message || "Failed to fork conversation", "error");
        });
    },
    [navigateToSpawnedWindow, addGhostWindow, removeGhost, addToast],
  );
}
