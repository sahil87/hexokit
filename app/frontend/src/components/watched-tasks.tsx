import { WatchedTable } from "@/components/watched-table";
import {
  collectTrackedRows,
  watchedWorkerRows,
  watchlistStatus,
} from "@/components/server-watched-zone/model";
import { formatDuration } from "@/lib/format";
import type { ProjectSession } from "@/types";

/**
 * The operator tracked-list segment body — the quake terminal's Operator Tasks
 * segment (desktop drawer, dense) and the mobile operator route's `?tab=tasks`
 * content slot. A pure projection over the sessions payload taken by PROP: no
 * hook, no fetch, no timer — every relative age is computed at render from
 * `Date.now()` and the sessions SSE cadence is the clock. Never an error
 * state: absent facets degrade to hint lines.
 *
 * Rows come from `collectTrackedRows` (the operator's WHOLE tracked list —
 * pane-bearing workers and pane-less items, done items dimmed), falling back
 * to `collectWatchedRows`-derived worker rows when no session carries
 * `operatorTracked` (an older backend). Above the table a one-line summary
 * (`watched-tasks-summary`) reads `{N} tracked · {W} watched` — N every item
 * (done included — the count that matches `fab operator track list`), W the
 * live worker rows.
 *
 * Anatomy top→bottom: (1) a pinned staleness banner rendered exactly when the
 * server's sessions report `operatorStale` (the server's own 15-minute
 * verdict — the frontend never re-derives the threshold), carrying the tick
 * age or `no recent tick` when no session carries a tick; (2) the summary
 * line and the scroll body holding the shared `WatchedTable` when rows exist;
 * (3) otherwise a centered hint line — `no server resolved` / `No operator on
 * this server` / `No tracked items` (an absent state file reads as an empty
 * list by the backend's tolerant parse, so an empty list is a state, not an
 * error).
 */
export function WatchedTasks({
  server,
  sessions,
  onNavigate,
  dense = false,
}: {
  server: string;
  sessions: ProjectSession[];
  onNavigate: (windowId: string) => void;
  /** Quake terminal variant: tighter cell/header padding; the six columns stay. */
  dense?: boolean;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { stale, tickAgeSeconds, hasOperator } = watchlistStatus(sessions, nowSeconds);
  // Older-backend fallback: no `operatorTracked` on any session ⇒ the
  // monitored-derived worker rows.
  const rows = collectTrackedRows(sessions) ?? watchedWorkerRows(sessions);

  const watched = rows.filter((row) => row.kind === "worker" && !row.done).length;

  const hint = !server
    ? "no workspace resolved — watchlist unavailable"
    : rows.length > 0
      ? null
      : !hasOperator
        ? "No operator on this workspace"
        : "No tracked items";

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="watched-tasks">
      {stale && (
        <div
          className="shrink-0 border-b border-border px-3 py-2 text-xs text-signal-yellow"
          role="status"
          data-testid="watched-tasks-banner"
        >
          {tickAgeSeconds !== null
            ? `operator tick — last seen ${formatDuration(tickAgeSeconds)} ago`
            : "operator tick — no recent tick"}
        </div>
      )}
      {hint !== null ? (
        <div
          className="flex-1 min-h-0 flex items-center justify-center px-4 text-xs text-text-secondary"
          data-testid="watched-tasks-hint"
        >
          {hint}
        </div>
      ) : (
        <>
          <div
            className="shrink-0 px-3 pt-2 text-xs text-text-secondary font-mono"
            data-testid="watched-tasks-summary"
          >
            {rows.length} tracked · {watched} watched
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
            <WatchedTable
              rows={rows}
              stale={stale}
              nowSeconds={nowSeconds}
              onNavigate={onNavigate}
              dense={dense}
            />
          </div>
        </>
      )}
    </div>
  );
}
