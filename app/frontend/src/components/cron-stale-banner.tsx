import { useMemo } from "react";
import { useSessionContext } from "@/contexts/session-context";
import { formatDuration } from "@/lib/format";

/**
 * The pinned (non-scrolling) operator-staleness banner for the Activity tab —
 * rendered exactly when any of the resolved server's sessions reports
 * `operatorStale === true`, reading the already-shipped
 * `operatorStale`/`operatorLastTickAt` fields off the sessions payload (no
 * new fetch). The relative age computes at render time; the SSE cadence is
 * the clock, never a timer. Mounted above the Activity body by its parents
 * (never above the terminal or the cron tabs); renders nothing when the
 * server is unresolvable or no session is stale.
 */
export function CronStaleBanner({ server }: { server: string }) {
  const { sessionsByServer } = useSessionContext();
  const sessions = useMemo(() => sessionsByServer.get(server) ?? [], [sessionsByServer, server]);
  const staleSession = sessions.find((s) => s.operatorStale === true);
  if (!staleSession) return null;
  return (
    <div
      className="shrink-0 border-b border-border px-3 py-2 text-xs text-signal-yellow"
      data-testid="cron-activity-banner"
      role="status"
    >
      {staleSession.operatorLastTickAt
        ? `operator loop — last check ${formatDuration(Math.max(0, Math.floor(Date.now() / 1000 - staleSession.operatorLastTickAt)))} ago`
        : "operator loop — no recent check"}
    </div>
  );
}
