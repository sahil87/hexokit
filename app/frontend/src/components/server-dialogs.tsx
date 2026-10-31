import { useCallback, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { killServer as killServerApi, adoptServer as adoptServerApi, DAEMON_SERVER } from "@/api/client";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import { useServerDialogs } from "@/contexts/server-dialogs-context";
import { useSessionContext } from "@/contexts/session-context";
import { useOptimisticContext } from "@/contexts/optimistic-context";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import { useToast } from "@/components/toast";
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
  return `kills ${sessionCount} group${sessionCount === 1 ? "" : "s"}, ${windowCount} tab${windowCount === 1 ? "" : "s"}`;
}

/**
 * The single kill-server + adopt-server dialog implementation, mounted ONCE in
 * `AppLayout` (the board route renders no AppShell, so a per-route copy would
 * drift). Open-state and the close triggers come from
 * `server-dialogs-context`; this component owns the kill/adopt handlers.
 * Workspace creation is not here: it goes through the New sheet
 * (`new-sheet-context`).
 *
 * The kill confirm renders the `DAEMON_SERVER` warning on every route. After a
 * confirmed kill the app navigates to `/` only when the killed server is
 * `SessionContext`'s `currentServer` — `null` on board routes, so a board kill
 * never navigates away.
 */
export function ServerDialogs() {
  const {
    killServerTarget,
    adoptServerTarget,
    clearKillServerTarget,
    clearAdoptServerTarget,
  } = useServerDialogs();
  const ctx = useSessionContext();
  const currentServer = ctx.currentServer;
  const refreshServers = ctx.refreshServers;
  const { markKilled, unmarkKilled } = useOptimisticContext();
  const { addToast } = useToast();
  const navigate = useNavigate();

  const killedServerNameRef = useRef<string | null>(null);

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
      addToast(err.message || "Failed to kill workspace");
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
        addToast(err instanceof Error ? err.message : "Failed to adopt workspace");
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
        <Dialog title="Kill workspace?" onClose={clearKillServerTarget}>
          <p className="text-text-secondary mb-2.5">
            Kill workspace <strong>{killServerTarget}</strong> and all its groups? This cannot be undone.
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
        <Dialog title="Adopt workspace into HexoKit?" onClose={clearAdoptServerTarget}>
          <p className="text-text-secondary mb-2.5">
            Adopt workspace <strong>{adoptServerTarget}</strong> into HexoKit? HexoKit's tmux config is
            applied to it now — your own config returns only when the workspace restarts.
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
    <Dialog title="Kill protected workspace?" onClose={onCancel}>
      <p className="text-signal-red mb-2.5">
        <strong>{target}</strong> is a protected workspace — killing it{" "}
        {protectedBlastRadius(target, sessions)}. This cannot be undone.
      </p>
      <input
        autoFocus
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && unlocked && onForceKill()}
        aria-label="Type the workspace name to unlock force kill"
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
