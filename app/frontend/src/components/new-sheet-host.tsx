import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import type { NewSheetSubmit } from "@/components/new-sheet";
import { useNewSheet } from "@/contexts/new-sheet-context";
import { useSessionContext } from "@/contexts/session-context";
import { useCreateGroup } from "@/hooks/use-create-group";
import { useCreateTab } from "@/hooks/use-create-tab";
import { useCreateWorkspace } from "@/hooks/use-create-workspace";
import { useRouteWindowId } from "@/hooks/use-route-window-id";
import { readLastWindow } from "@/lib/last-window-per-server";
import { NEW_LEVELS, contextMeta, resolveContextTarget, windowBranch, type NewLevel, type NewSheetRequest } from "@/lib/new-sheet";
import type { ProjectSession } from "@/types";

const NewSheet = lazy(() => import("@/components/new-sheet").then((m) => ({ default: m.NewSheet })));

type Target = {
  server: string;
  group: string;
  sessions: ProjectSession[];
  availableLevels: NewLevel[];
  contextFolder: string;
  contextBranch?: string;
  contextMeta: string;
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
  const createWorkspace = useCreateWorkspace();

  const createTab = useCreateTab();
  const { createGroup } = useCreateGroup();

  const snapshotRef = useRef<{ request: NewSheetRequest; target: Target } | null>(null);
  if (!newSheetRequest) {
    snapshotRef.current = null;
  } else if (snapshotRef.current?.request !== newSheetRequest) {
    const server = newSheetRequest.server ?? ctx.currentServer ?? "";
    const sessions = server ? (ctx.sessionsByServer.get(server) ?? []) : [];
    const { group, window, source } = resolveContextTarget(sessions, {
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
        contextMeta: contextMeta(source),
      },
    };
  }

  const workspaceNames = useMemo(() => ctx.servers.map((s) => s.name), [ctx.servers]);

  const target = snapshotRef.current?.target;
  const handleSubmit = useCallback(
    ({ level, folder, name }: NewSheetSubmit) => {
      if (!target) return;
      // A refused group create (another is still in flight) keeps the sheet
      // open so the submit isn't lost silently.
      if (level === "group" && name && !createGroup(target.server, name, folder)) return;
      closeNewSheet();
      if (level === "tab") createTab(target.server, target.group, folder);
      else if (level === "workspace" && name) createWorkspace(name, folder);
    },
    [target, closeNewSheet, createTab, createGroup, createWorkspace],
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
        contextMeta={target.contextMeta}
        onSubmit={handleSubmit}
        onClose={closeNewSheet}
      />
    </Suspense>
  );
}
