import { useCallback, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createServer, killServer as killServerApi, adoptServer as adoptServerApi, DAEMON_SERVER } from "@/api/client";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { useServerDialogs } from "@/contexts/server-dialogs-context";
import { useSessionContext } from "@/contexts/session-context";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useToast } from "@/components/toast";
import { finalizeSafeName, toSafeServerName } from "@/lib/names";
import type { ProjectSession } from "@/types";

/** Blast-radius copy for a protected kill target, derived live from the
 *  session data the client already holds (no endpoint). The daemon names its
 *  hosted infrastructure; other protected servers get session/window counts. */
function protectedBlastRadius(target: string, sessions: ProjectSession[]): string {
  if (target === DAEMON_SERVER) {
    const parts = ["the dashboard"];
    const jobs = sessions.find((s) => s.name === "rk-jobs");
    const running = jobs?.windows.filter((w) => w.activity === "active").length ?? 0;
    if (running > 0) parts.push(`${running} running job${running === 1 ? "" : "s"}`);
    if (sessions.some((s) => s.name === "rk-code-server")) parts.push("code-server");
    const remotes = sessions.find((s) => s.name === "rk-remotes");
    const tunnels = remotes?.windows.length ?? 0;
    if (tunnels > 0) parts.push(`${tunnels} remote tunnel${tunnels === 1 ? "" : "s"}`);
    return `kills ${parts.join(", ")}`;
  }
  const sessionCount = sessions.length;
  const windowCount = sessions.reduce((n, s) => n + s.windows.length, 0);
  return `kills ${sessionCount} session${sessionCount === 1 ? "" : "s"}, ${windowCount} window${windowCount === 1 ? "" : "s"}`;
}

/**
 * The single create-server + kill-server dialog implementation (260811-239r),
 * lifted verbatim from AppShell and mounted ONCE in `AppLayout` — the board
 * route does not render AppShell (DD-8), so both dialogs were twinned between
 * `app.tsx` and `board-page.tsx` and had drifted (the board copy lacked the
 * `DAEMON_SERVER` warning and the input sanitization). Open-state and the
 * close triggers come from `server-dialogs-context`; this component owns the
 * create-input local state and the submit/kill handlers.
 *
 * Unified behavior is AppShell's former superset on ALL routes: the create
 * input applies `toSafeServerName` on change and `finalizeSafeName` on submit,
 * and the kill confirm renders the `DAEMON_SERVER` warning everywhere. After a
 * confirmed kill the app navigates to `/` only when the killed server is
 * `SessionContext`'s `currentServer` — `null` on board routes, so a board kill
 * never navigates away (matching the board's previous behavior exactly).
 */
export function ServerDialogs() {
  const {
    createServerOpen,
    killServerTarget,
    adoptServerTarget,
    closeCreateServer,
    clearKillServerTarget,
    clearAdoptServerTarget,
  } = useServerDialogs();
  const ctx = useSessionContext();
  const currentServer = ctx.currentServer;
  const refreshServers = ctx.refreshServers;
  const markServerPending = ctx.markServerPending;
  const { removeGhost, addGhostServer, markKilled, unmarkKilled } = useOptimisticContext();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const [createServerName, setCreateServerName] = useState("");
  const ghostServerIdRef = useRef<string | null>(null);
  const killedServerNameRef = useRef<string | null>(null);

  const { execute: executeCreateServer } = useOptimisticAction<[string]>({
    action: (name) => createServer(name),
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
      addToast(err.message || "Failed to create server");
    },
    onSettled: () => {
      ghostServerIdRef.current = null;
    },
    // Refresh the (otherwise one-time-fetched) server list once the create
    // resolves so the new server appears and the waiting state swaps to the
    // view. `onAlwaysSettled` runs even though the create dialog has already
    // closed on navigation — this component (which owns the hook) is mounted
    // at the AppLayout level and never unmounts on navigation, and
    // `refreshServers` only touches root-level SessionContext.
    onAlwaysSettled: () => {
      refreshServers();
    },
    // A failed create must not strand the UI on the waiting state — clear the
    // pending marker (empty string clears to null) on the rollback path (also
    // unmount-safe, root-context only).
    onAlwaysRollback: () => {
      markServerPending("");
    },
  });

  const handleCreateServer = useCallback(() => {
    const trimmed = finalizeSafeName(createServerName.trim());
    if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return;
    executeCreateServer(trimmed);
    // Mark the just-created server pending so the route guard shows the brief
    // waiting state (not "Server not found") until the refreshed list includes
    // it. Cleared automatically by SessionContext once it appears.
    markServerPending(trimmed);
    navigate({ to: "/$server", params: { server: trimmed } });
    closeCreateServer();
    setCreateServerName("");
  }, [createServerName, navigate, executeCreateServer, markServerPending, closeCreateServer]);

  const { execute: executeKillServer } = useOptimisticAction<[string, boolean]>({
    action: (name, force) => killServerApi(name, force),
    onOptimistic: (name) => {
      killedServerNameRef.current = name;
      markKilled("server", name);
    },
    onRollback: () => {
      if (killedServerNameRef.current) {
        unmarkKilled("server", killedServerNameRef.current);
        killedServerNameRef.current = null;
      }
    },
    onError: (err) => {
      addToast(err.message || "Failed to kill server");
    },
    onSettled: () => {
      killedServerNameRef.current = null;
    },
  });

  const handleKillServer = useCallback(() => {
    if (!killServerTarget) return;
    const target = killServerTarget;
    executeKillServer(target, false);
    // Route away only when killing the currently-active server; killing another
    // server in the panel should leave the user where they are. `currentServer`
    // (SessionContext's deepest-first route-param walk) is null on board
    // routes, so a board-route kill never navigates away.
    if (target === currentServer) navigate({ to: "/" });
    clearKillServerTarget();
  }, [killServerTarget, currentServer, navigate, executeKillServer, clearKillServerTarget]);

  // Adopt is a config mutation, not a destruction — no optimistic killed mark.
  // The backend wakes the SSE hub on success, so covered clients repaint off
  // the stream; refreshServers is belt-and-braces for the host page's
  // one-time-fetched list (mirrors the protect flow in app.tsx).
  const handleAdoptServer = useCallback(() => {
    if (!adoptServerTarget) return;
    void adoptServerApi(adoptServerTarget)
      .then(() => refreshServers())
      .catch((err: unknown) => {
        addToast(err instanceof Error ? err.message : "Failed to adopt server");
      });
    clearAdoptServerTarget();
  }, [adoptServerTarget, refreshServers, addToast, clearAdoptServerTarget]);

  // The kill-confirm forks on the target's `protected` payload flag (R10):
  // protected targets get the typed-name force unlock (daemon additionally
  // gets the Restart primary), non-protected targets keep the plain
  // two-button confirm byte-for-byte.
  // The daemon's protection is derived from its constant name (never from the
  // payload alone) so a stale or empty server list can't render it the
  // unprotected two-button confirm.
  const killTargetProtected =
    killServerTarget != null &&
    (killServerTarget === DAEMON_SERVER ||
      (ctx.servers.find((s) => s.name === killServerTarget)?.protected ?? false));

  return (
    <>
      {createServerOpen && (
        <Dialog title="Create tmux server" onClose={() => { closeCreateServer(); setCreateServerName(""); }}>
          <input
            autoFocus
            type="text"
            value={createServerName}
            onChange={(e) => setCreateServerName(toSafeServerName(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && handleCreateServer()}
            onFocus={(e) => e.target.select()}
            aria-label="Server name"
            placeholder="Server name..."
            className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
          />
          <p className="text-xs text-text-secondary mt-1.5">
            Alphanumeric, hyphens, and underscores only.
          </p>
          <button
            onClick={handleCreateServer}
            disabled={!createServerName.trim() || !/^[a-zA-Z0-9_-]+$/.test(createServerName.trim())}
            className={`mt-2.5 w-full ${controlClass({ variant: "wide", disabled: !createServerName.trim() || !/^[a-zA-Z0-9_-]+$/.test(createServerName.trim()) })}`}
          >
            Create
          </button>
        </Dialog>
      )}

      {killServerTarget && killTargetProtected && (
        <ProtectedKillDialog
          target={killServerTarget}
          sessions={ctx.sessionsByServer.get(killServerTarget) ?? []}
          onCancel={clearKillServerTarget}
          onForceKill={() => {
            executeKillServer(killServerTarget, true);
            if (killServerTarget === currentServer) navigate({ to: "/" });
            clearKillServerTarget();
          }}
          onRestart={() => {
            void ctx.restartNow().catch((err: unknown) => {
              addToast(err instanceof Error ? err.message : "Failed to restart HexoKit");
            });
            clearKillServerTarget();
          }}
        />
      )}

      {killServerTarget && !killTargetProtected && (
        <Dialog title="Kill tmux server?" onClose={clearKillServerTarget}>
          <p className="text-text-secondary mb-2.5">
            Kill server <strong>{killServerTarget}</strong> and all its sessions? This cannot be undone.
          </p>
          {killServerTarget === DAEMON_SERVER && (
            <p className="text-signal-red mb-2.5">
              <strong>{DAEMON_SERVER}</strong> hosts the HexoKit daemon serving this dashboard — killing it takes the dashboard down.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={clearKillServerTarget}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
            <button
              onClick={handleKillServer}
              className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
            >
              Kill
            </button>
          </div>
        </Dialog>
      )}

      {adoptServerTarget && (
        <Dialog title="Adopt server into HexoKit?" onClose={clearAdoptServerTarget}>
          <p className="text-text-secondary mb-2.5">
            Adopt server <strong>{adoptServerTarget}</strong> into HexoKit? HexoKit's tmux config is
            applied to it now — your own config returns only when the server restarts.
          </p>
          <div className="flex gap-2">
            <button
              onClick={clearAdoptServerTarget}
              className={`flex-1 ${controlClass({ variant: "confirm" })}`}
            >
              Cancel
            </button>
            <button
              onClick={handleAdoptServer}
              className={`flex-1 ${controlClass({ variant: "wide" })}`}
            >
              Adopt
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The kill confirm for PROTECTED targets (rk-daemon by derivation, or any
 *  @rk_srv_protected server). The kill action is locked behind typing the exact
 *  server name (auto-focused, Enter submits only on match, Esc cancels via the
 *  Dialog's focus trap). The daemon additionally gets the "Restart HexoKit"
 *  primary — the safe action — wired to the existing POST /api/restart; other
 *  protected servers keep Cancel as the safe default. */
function ProtectedKillDialog({
  target,
  sessions,
  onCancel,
  onForceKill,
  onRestart,
}: {
  target: string;
  sessions: ProjectSession[];
  onCancel: () => void;
  onForceKill: () => void;
  onRestart: () => void;
}) {
  const [typed, setTyped] = useState("");
  const unlocked = typed === target;
  const isDaemon = target === DAEMON_SERVER;

  return (
    <Dialog title="Kill protected server?" onClose={onCancel}>
      <p className="text-signal-red mb-2.5">
        <strong>{target}</strong> is a protected server — killing it{" "}
        {protectedBlastRadius(target, sessions)}. This cannot be undone.
      </p>
      <input
        autoFocus
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && unlocked && onForceKill()}
        aria-label="Type the server name to unlock force kill"
        placeholder={`Type ${target} to unlock force kill`}
        className={`w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
      />
      <div className="flex gap-2 mt-2.5">
        <button
          onClick={onCancel}
          className={`flex-1 ${controlClass({ variant: "confirm" })}`}
        >
          Cancel
        </button>
        {isDaemon && (
          <button
            onClick={onRestart}
            className={`flex-1 ${controlClass({ variant: "wide" })}`}
          >
            Restart HexoKit
          </button>
        )}
        <button
          onClick={onForceKill}
          disabled={!unlocked}
          className={`flex-1 ${controlClass({ variant: "confirm", danger: true })}`}
        >
          Force kill
        </button>
      </div>
    </Dialog>
  );
}
