import { useState, useCallback, useMemo, useRef } from "react";
import { renameSession, killSession, killWindow } from "@/api/client";
import { finalizeSafeName } from "@/lib/names";
import { pushRecentlyClosed } from "@/hooks/use-recently-closed";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useSessionContext } from "@/contexts/session-context";
import { useToast } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";

type UseDialogStateOptions = {
  sessionName: string | undefined;
  windowId: string | undefined;
  onKillComplete?: () => void;
  onSessionRenamed?: (newName: string) => void;
};

export function useDialogState({ sessionName, windowId, onKillComplete, onSessionRenamed }: UseDialogStateOptions) {
  // Window rename is no longer a modal dialog (260703-5ilm): the centered
  // top-bar window heading owns inline rename now. Only the SESSION rename +
  // the kill confirmations remain here.
  const [showRenameSessionDialog, setShowRenameSessionDialog] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [showKillSessionConfirm, setShowKillSessionConfirm] = useState(false);
  const [renameSessionName, setRenameSessionName] = useState("");

  // useDialogState is consumed only by AppShell where currentServer is set.
  // When null (board route, defensive), handlers no-op via the empty-string
  // guard at execute sites.
  const { currentServer } = useSessionContext();
  const server = currentServer ?? "";
  const { markRenamed, unmarkRenamed, markKilled, unmarkKilled } = useOptimisticContext();
  const { addToast } = useToast();
  const killWindowStore = useWindowStore((state) => state.killWindow);
  const restoreWindow = useWindowStore((state) => state.restoreWindow);
  const clearSession = useWindowStore((state) => state.clearSession);

  // Refs to capture identifiers at execute time, avoiding stale closures on rollback.
  // Captures (server, identifier) so rollback / settle targets the exact originating server.
  const lastRenameSessionRef = useRef<{ server: string; name: string } | null>(null);
  const lastKillSessionRef = useRef<{ server: string; name: string } | null>(null);
  const lastKillWindowRef = useRef<{ server: string; session: string; windowId: string } | null>(null);

  const openRenameSessionDialog = useCallback(
    (currentName: string) => {
      setRenameSessionName(currentName);
      setShowRenameSessionDialog(true);
    },
    [],
  );
  const closeRenameSessionDialog = useCallback(() => setShowRenameSessionDialog(false), []);

  const openKillConfirm = useCallback(() => setShowKillConfirm(true), []);
  const closeKillConfirm = useCallback(() => setShowKillConfirm(false), []);

  const openKillSessionConfirm = useCallback(() => setShowKillSessionConfirm(true), []);
  const closeKillSessionConfirm = useCallback(() => setShowKillSessionConfirm(false), []);

  const { execute: executeRenameSession } = useOptimisticAction<[string, string, string]>({
    action: (srv, oldName, newName) => renameSession(srv, oldName, newName),
    onOptimistic: (srv, oldName, newName) => {
      lastRenameSessionRef.current = { server: srv, name: oldName };
      markRenamed("session", srv, oldName, newName);
    },
    onRollback: () => {
      const last = lastRenameSessionRef.current;
      if (last) unmarkRenamed(last.server, last.name);
    },
    onError: (err) => {
      addToast(err.message || "Failed to rename group");
    },
    onSettled: () => {
      lastRenameSessionRef.current = null;
    },
  });

  const handleRenameSession = useCallback(() => {
    // The input applies the live session transform; commit trims the trailing
    // separator the live transform deliberately keeps visible.
    const newName = finalizeSafeName(renameSessionName.trim());
    if (!newName || !sessionName) return;
    executeRenameSession(server, sessionName, newName);
    onSessionRenamed?.(newName);
    setShowRenameSessionDialog(false);
  }, [renameSessionName, sessionName, server, onSessionRenamed, executeRenameSession]);

  const { execute: executeKillSession } = useOptimisticAction<[string, string]>({
    action: (srv, name) => killSession(srv, name),
    onOptimistic: (srv, name) => {
      lastKillSessionRef.current = { server: srv, name };
      markKilled("session", srv, name);
    },
    onAlwaysRollback: () => {
      const last = lastKillSessionRef.current;
      if (last) unmarkKilled("session", last.server, last.name);
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill group");
    },
    onAlwaysSettled: () => {
      const last = lastKillSessionRef.current;
      if (last) clearSession(last.server, last.name);
      lastKillSessionRef.current = null;
    },
  });

  const handleKillSession = useCallback(() => {
    if (!sessionName) return;
    executeKillSession(server, sessionName);
    onKillComplete?.();
    setShowKillSessionConfirm(false);
  }, [sessionName, server, onKillComplete, executeKillSession]);

  const { execute: executeKillWindow } = useOptimisticAction<[string, string, string]>({
    action: async (srv, _session, wid) => {
      const res = await killWindow(srv, wid);
      // The kill-seam record (absent when the capture failed server-side) goes
      // straight onto the mirror — the reopen entry lights up without a refetch.
      if (res.closed) pushRecentlyClosed(srv, res.closed);
      return res;
    },
    onOptimistic: (srv, session, wid) => {
      lastKillWindowRef.current = { server: srv, session, windowId: wid };
      killWindowStore(srv, session, wid);
    },
    onAlwaysRollback: () => {
      const last = lastKillWindowRef.current;
      if (last) restoreWindow(last.server, last.session, last.windowId);
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill tab");
    },
    onAlwaysSettled: () => {
      const last = lastKillWindowRef.current;
      if (last) restoreWindow(last.server, last.session, last.windowId);
      lastKillWindowRef.current = null;
    },
  });

  const handleKillWindow = useCallback(() => {
    if (!sessionName || !windowId) return;
    executeKillWindow(server, sessionName, windowId);
    onKillComplete?.();
    setShowKillConfirm(false);
  }, [sessionName, windowId, server, onKillComplete, executeKillWindow]);

  return useMemo(() => ({
    showRenameSessionDialog,
    showKillConfirm,
    showKillSessionConfirm,
    renameSessionName,
    setRenameSessionName,
    openRenameSessionDialog,
    closeRenameSessionDialog,
    openKillConfirm,
    closeKillConfirm,
    openKillSessionConfirm,
    closeKillSessionConfirm,
    handleRenameSession,
    handleKillSession,
    handleKillWindow,
  }), [
    showRenameSessionDialog,
    showKillConfirm,
    showKillSessionConfirm,
    renameSessionName,
    openRenameSessionDialog,
    closeRenameSessionDialog,
    openKillConfirm,
    closeKillConfirm,
    openKillSessionConfirm,
    closeKillSessionConfirm,
    handleRenameSession,
    handleKillSession,
    handleKillWindow,
  ]);
}
