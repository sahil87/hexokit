import { useNavigate } from "@tanstack/react-router";
import { DAEMON_SERVER } from "@/api/client";
import { useSessionContext } from "@/contexts/session-context";
import { formatUptime } from "@/components/host-metrics";
import { Tip } from "@/components/tip";
import { useToast } from "@/components/toast";
import { windowIdToUrlSegment } from "@/lib/router-url";
import type { ProjectSession, WindowInfo } from "@/types";

/** A daemon-hosted sibling service (jobs / code-server / remotes) derived from
 *  the rk-daemon server's sessions — the same derivation the protected kill
 *  dialog's blast-radius copy uses (server-dialogs.tsx). */
type ServiceRow = {
  key: string;
  label: string;
  /** Running status copy when the sibling session exists ("1 job", "up"),
   *  "not running" otherwise. */
  status: string;
  /** The session's active (or first) window — the View deep-link target. */
  window: WindowInfo | null;
};

function activeOrFirstWindow(session: ProjectSession): WindowInfo | null {
  return (
    session.windows.find((w) => w.isActiveWindow) ?? session.windows[0] ?? null
  );
}

function deriveServiceRows(sessions: ProjectSession[]): ServiceRow[] {
  const jobs = sessions.find((s) => s.name === "rk-jobs");
  const codeServer = sessions.find((s) => s.name === "rk-code-server");
  const remotes = sessions.find((s) => s.name === "rk-remotes");
  return [
    {
      key: "jobs",
      label: "jobs",
      status: jobs
        ? `${jobs.windows.length} job${jobs.windows.length === 1 ? "" : "s"}`
        : "not running",
      window: jobs ? activeOrFirstWindow(jobs) : null,
    },
    {
      key: "code-server",
      label: "code-server",
      status: codeServer ? "up" : "not running",
      window: codeServer ? activeOrFirstWindow(codeServer) : null,
    },
    {
      key: "remotes",
      label: "remotes",
      status: remotes
        ? `${remotes.windows.length} tunnel${remotes.windows.length === 1 ? "" : "s"}`
        : "not running",
      window: remotes ? activeOrFirstWindow(remotes) : null,
    },
  ];
}

/**
 * The HexoKit system card — the daemon read as a SYSTEM surface (mounted inside
 * the host page's HOST HEALTH zone): a daemon line (version / uptime / port)
 * with the Restart service verb, and one row per daemon-hosted sibling service
 * (jobs, code-server, remotes) with live status + a View deep-link to that
 * session's terminal route. Service verbs, not tmux-server verbs — nothing
 * loses terminal access (View rides the ordinary `/$server/$window` route).
 *
 * Renders independently of the host-metrics stream: the daemon serving the
 * page is by definition up even when no metrics snapshot has arrived. Uptime
 * and port render only when the version slot carried them (older daemons omit
 * the fields) — no NaN/0 fallbacks. Uptime is computed at render (coarse
 * "3d 4h" granularity needs no ticking interval).
 *
 * Restart fires immediately via the context's restartNow() — the same seam the
 * kill dialog's Restart primary and the palette's `HexoKit: Restart Daemon`
 * entry use (no second restart implementation, no new palette entry). The
 * socket drop + reconnect drives the reload guard; a rejection (the backend
 * 409s a dev build) surfaces as a toast — the kill dialog's Restart precedent.
 */
export function SystemCard() {
  const { daemonVersion, daemonStarted, daemonPort, sessionsByServer, restartNow } =
    useSessionContext();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const rows = deriveServiceRows(sessionsByServer.get(DAEMON_SERVER) ?? []);
  const uptime =
    daemonStarted !== null
      ? formatUptime(Math.max(0, Math.floor(Date.now() / 1000) - daemonStarted))
      : null;

  return (
    <div
      aria-label="HexoKit system"
      className="bg-bg-card border border-border rounded p-3 mb-2 text-xs font-mono flex flex-col gap-1"
    >
      {/* Daemon line: version / uptime / port + the Restart service verb. */}
      <div className="flex items-center gap-[1ch]">
        <span className="text-text-primary shrink-0">HexoKit</span>
        <span className="text-text-secondary truncate">
          {daemonVersion ? `v${daemonVersion}` : "v…"}
          {uptime !== null && ` · up ${uptime}`}
          {daemonPort !== null && ` · :${daemonPort}`}
        </span>
        <button
          type="button"
          onClick={() =>
            void restartNow().catch((err: unknown) => {
              addToast(err instanceof Error ? err.message : "Failed to restart HexoKit");
            })
          }
          className="ml-auto shrink-0 border border-border rounded px-1.5 text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
        >
          Restart
        </button>
      </div>
      {/* Service rows: live status + View deep-links. Absent sibling sessions
          render not-running with no link. */}
      {rows.map((row) => {
        const win = row.window;
        return (
          <div key={row.key} className="flex items-center gap-[1ch]">
            <span className="text-text-secondary shrink-0">{row.label}</span>
            <span className="text-text-secondary truncate">{row.status}</span>
            {win && (
              <Tip label={`Open ${win.name} terminal`}>
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: "/$server/$window",
                      params: {
                        server: DAEMON_SERVER,
                        window: windowIdToUrlSegment(win.windowId),
                      },
                      search: {},
                    })
                  }
                  className="ml-auto shrink-0 border border-border rounded px-1.5 text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
                >
                  View
                </button>
              </Tip>
            )}
          </div>
        );
      })}
    </div>
  );
}
