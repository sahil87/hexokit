import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { createSession, createWindow } from "@/api/client";
import type { NewSheetSubmit } from "@/components/new-sheet";
import { useToast } from "@/components/toast";
import { useNewSheet } from "@/contexts/new-sheet-context";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useSessionContext } from "@/contexts/session-context";
import { useCreateWorkspace } from "@/hooks/use-create-workspace";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useRouteWindowId } from "@/hooks/use-route-window-id";
import { readLastWindow } from "@/lib/last-window-per-server";
import { NEW_LEVELS, resolveContextTarget, windowBranch, type NewLevel, type NewSheetRequest } from "@/lib/new-sheet";
import { rawBasename } from "@/lib/names";
import { useWindowStore } from "@/store/window-store";
import type { ProjectSession } from "@/types";

const NewSheet = lazy(() => import("@/components/new-sheet").then((m) => ({ default: m.NewSheet })));

type Target = {
  server: string;
  group: string;
  sessions: ProjectSession[];
  availableLevels: NewLevel[];
  contextFolder: string;
  contextBranch?: string;
};

/**
 * The ONE New-sheet mount (like `ServerDialogs`): reads the opener's request
 * from `new-sheet-context`, resolves the target workspace/group and the
 * context folder from the live session data, and runs the create action for
 * the chosen level. The target is snapshotted per request so SSE ticks never
 * move the field's prefill under the user.
 */
export function NewSheetHost() {
  const { newSheetRequest, closeNewSheet } = useNewSheet();
  const ctx = useSessionContext();
  const routeWindowId = useRouteWindowId();
  const { addToast } = useToast();
  const { addGhostSession, removeGhost } = useOptimisticContext();
  const addGhostWindow = useWindowStore((s) => s.addGhostWindow);
  const removeWindowGhost = useWindowStore((s) => s.removeGhost);
  const createWorkspace = useCreateWorkspace();

  const ghostWindowIdRef = useRef<string | null>(null);
  const ghostSessionIdRef = useRef<string | null>(null);

  const { execute: executeCreateTab } = useOptimisticAction<[string, string, string | undefined]>({
    action: (srv, group, cwd) => createWindow(srv, group, undefined, cwd),
    // The ghost label is the raw basename tmux will auto-name the tab to.
    onOptimistic: (srv, group, cwd) => {
      ghostWindowIdRef.current = addGhostWindow(srv, group, rawBasename(cwd));
    },
    onRollback: () => {
      if (ghostWindowIdRef.current) {
        removeWindowGhost(ghostWindowIdRef.current);
        ghostWindowIdRef.current = null;
      }
    },
    onError: (err) => addToast(err.message || "Failed to create tab"),
    onSettled: () => {
      ghostWindowIdRef.current = null;
    },
  });

  const { execute: executeCreateGroup } = useOptimisticAction<[string, string, string | undefined]>({
    action: (srv, name, cwd) => createSession(srv, name, cwd),
    onOptimistic: (srv, name) => {
      ghostSessionIdRef.current = addGhostSession(srv, name);
    },
    onRollback: () => {
      if (ghostSessionIdRef.current) {
        removeGhost(ghostSessionIdRef.current);
        ghostSessionIdRef.current = null;
      }
    },
    onError: (err) => addToast(err.message || "Failed to create group"),
    onSettled: () => {
      ghostSessionIdRef.current = null;
    },
  });

  const snapshotRef = useRef<{ request: NewSheetRequest; target: Target } | null>(null);
  if (!newSheetRequest) {
    snapshotRef.current = null;
  } else if (snapshotRef.current?.request !== newSheetRequest) {
    const server = newSheetRequest.server ?? ctx.currentServer ?? "";
    const sessions = server ? (ctx.sessionsByServer.get(server) ?? []) : [];
    const { group, window } = resolveContextTarget(sessions, {
      group: newSheetRequest.group,
      windowId: server === ctx.currentServer ? routeWindowId : undefined,
      lastWindowId: server ? readLastWindow(server) : null,
    });
    const availableLevels = NEW_LEVELS.filter((l) => (l === "tab" ? !!(server && group) : l === "group" ? !!server : true));
    snapshotRef.current = {
      request: newSheetRequest,
      target: {
        server,
        group: group ?? "",
        sessions,
        availableLevels,
        contextFolder: window?.worktreePath ?? "",
        contextBranch: window ? windowBranch(window) : undefined,
      },
    };
  }

  const workspaceNames = useMemo(() => ctx.servers.map((s) => s.name), [ctx.servers]);

  const target = snapshotRef.current?.target;
  const handleSubmit = useCallback(
    ({ level, folder, name }: NewSheetSubmit) => {
      if (!target) return;
      closeNewSheet();
      if (level === "tab") executeCreateTab(target.server, target.group, folder);
      else if (level === "group" && name) executeCreateGroup(target.server, name, folder);
      else if (level === "workspace" && name) createWorkspace(name, folder);
    },
    [target, closeNewSheet, executeCreateTab, executeCreateGroup, createWorkspace],
  );

  if (!newSheetRequest || !target) return null;
  return (
    <Suspense fallback={null}>
      <NewSheet
        initialLevel={newSheetRequest.level}
        availableLevels={target.availableLevels}
        server={target.server}
        group={target.group}
        sessions={target.sessions}
        workspaceNames={workspaceNames}
        contextFolder={target.contextFolder}
        contextBranch={target.contextBranch}
        onSubmit={handleSubmit}
        onClose={closeNewSheet}
      />
    </Suspense>
  );
}
