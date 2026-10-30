import { SectionHeading } from "@/components/section-heading";
import { WatchedTable } from "@/components/watched-table";
import { formatDuration } from "@/lib/format";
import { watchedWorkerRows, watchlistStatus } from "./model";
import type { ProjectSession } from "@/types";

/**
 * The WATCHED zone — the tmux Server page's detail table of the server's
 * operator watchlist. One row per window with
 * `monitored === true` (the fab operator state file's monitored map, joined
 * onto windows server-side; ghost windows excluded), ordered by session order
 * then window index. Read-only by design: the watchlist is derived, edits are
 * `fab operator` verbs — the only interaction is row-name navigation to the
 * window's terminal route.
 *
 * Thin wrapper: the row collection and stale/tick/operator derivations live in
 * `./model.ts` (`collectWatchedRows`/`watchlistStatus`) and the table itself is
 * the shared `WatchedTable` (also mounted by the quake terminal's Operator
 * Tasks segment — one rendering so the two surfaces cannot drift).
 *
 * The zone holds no clock: every relative age is computed at render from the
 * already-passed sessions, refreshed by the SSE cadence. When any session
 * reports `operatorStale` the side slot flips to the yellow `⚠ stale` variant
 * and the whole table dims (the sidebar's watched-indicator dimming, applied
 * to the zone).
 */
export function WatchedZone({
  sessions,
  onNavigate,
}: {
  sessions: ProjectSession[];
  onNavigate: (windowId: string) => void;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { stale, tickAgeSeconds, hasOperator } = watchlistStatus(sessions, nowSeconds);
  // The zone is the workers view: only monitored windows, never pane-less items.
  const rows = watchedWorkerRows(sessions);

  const side = stale ? (
    <span className="text-signal-yellow" data-testid="watched-stale">
      ⚠ stale{tickAgeSeconds !== null ? ` ${formatDuration(tickAgeSeconds)}` : ""}
    </span>
  ) : (
    `${rows.length} watched · ${tickAgeSeconds !== null ? `tick ${formatDuration(tickAgeSeconds)} ago` : "no operator tick"}`
  );

  return (
    <div data-testid="clock-zone-watched">
      <SectionHeading label="Watched" side={side} className="mb-2" />
      {rows.length === 0 ? (
        <div className="text-xs text-text-secondary font-mono">
          {hasOperator ? "No watched workers" : "No operator on this workspace"}
        </div>
      ) : (
        <WatchedTable
          rows={rows}
          stale={stale}
          nowSeconds={nowSeconds}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
