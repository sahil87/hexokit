// Pure derivation helpers for the tmux Server page's WATCHED zone — the row
// collection and the zone-level stale/tick/operator status. Leaf module in
// the lib/cron-schedule.ts mold: no fetch, no timers; every relative time is
// computed by the caller and passed in as `nowSeconds` so the zone re-derives
// on the SSE cadence alone.

import { isGhostWindow } from "@/contexts/optimistic-context";
import type { OperatorTrackedItem, ProjectSession, WindowInfo } from "@/types";

/** One Operator Tasks row: a `worker` row is a tracked item whose `windowId`
 *  resolves to a live non-ghost window in `sessions` (its window facets render
 *  through the watched row and it navigates); every other item — pane-less
 *  (note / queued fab-change / github-pr / shell / task) or a pane no window
 *  carries — is an `item` row. */
export type TrackedRow =
  | { kind: "worker"; item: OperatorTrackedItem; session: string; win: WindowInfo; done: boolean }
  | { kind: "item"; item: OperatorTrackedItem; done: boolean };

/** One watched row per non-ghost window with `monitored === true` (the pane
 *  join of the operator state file's tracked list, done items excluded),
 *  ordered by session order then window index. The Server page WATCHED zone's
 *  workers view renders through it; the quake terminal's Operator Tasks segment
 *  renders through `collectTrackedRows` and reaches for this only as its
 *  older-backend fallback (`watchedWorkerRows`). */
export function collectWatchedRows(
  sessions: ProjectSession[],
): { session: string; win: WindowInfo }[] {
  const rows: { session: string; win: WindowInfo }[] = [];
  for (const session of sessions) {
    const windows = [...session.windows].sort((a, b) => a.index - b.index);
    for (const win of windows) {
      if (win.monitored === true && !isGhostWindow(win)) {
        rows.push({ session: session.name, win });
      }
    }
  }
  return rows;
}

/** `collectWatchedRows` lifted into `worker` rows with the identity facets
 *  synthesized from the window's `monitored*` fields — the WATCHED zone's row
 *  set, and the Operator Tasks segment's fallback when no session carries
 *  `operatorTracked`. One adapter so the two surfaces cannot drift. */
export function watchedWorkerRows(sessions: ProjectSession[]): TrackedRow[] {
  return collectWatchedRows(sessions).map(({ session, win }) => ({
    kind: "worker",
    item: { id: win.monitoredChange ?? "", windowId: win.windowId },
    session,
    win,
    done: false,
  }));
}

/** The Operator Tasks rows: one per tracked item. Order: worker rows first in
 *  session order then window index (the WATCHED zone's order), then item rows
 *  in tracked-list order; within each species live items before done ones.
 *  Returns null when no session carries `operatorTracked` (older backend) so
 *  the caller can fall back to collectWatchedRows. */
export function collectTrackedRows(sessions: ProjectSession[]): TrackedRow[] | null {
  const carrier = sessions.find((s) => s.operatorTracked !== undefined);
  if (!carrier) {
    return null;
  }
  const items = carrier.operatorTracked ?? [];

  const sessionOrder = new Map(sessions.map((s, i) => [s.name, i]));
  const winById = new Map<string, { session: string; win: WindowInfo }>();
  for (const session of sessions) {
    for (const win of session.windows) {
      winById.set(win.windowId, { session: session.name, win });
    }
  }

  const isDone = (item: OperatorTrackedItem) => (item.doneAt ?? 0) > 0;
  const liveWorkers: TrackedRow[] = [];
  const doneWorkers: TrackedRow[] = [];
  const liveItems: TrackedRow[] = [];
  const doneItems: TrackedRow[] = [];
  for (const item of items) {
    const ref = item.windowId !== undefined ? winById.get(item.windowId) : undefined;
    if (ref !== undefined && !isGhostWindow(ref.win)) {
      (isDone(item) ? doneWorkers : liveWorkers).push({
        kind: "worker",
        item,
        session: ref.session,
        win: ref.win,
        done: isDone(item),
      });
    } else {
      (isDone(item) ? doneItems : liveItems).push({ kind: "item", item, done: isDone(item) });
    }
  }
  const workerOrder = (a: TrackedRow, b: TrackedRow) => {
    if (a.kind !== "worker" || b.kind !== "worker") return 0;
    return (
      (sessionOrder.get(a.session) ?? 0) - (sessionOrder.get(b.session) ?? 0) ||
      a.win.index - b.win.index
    );
  };
  liveWorkers.sort(workerOrder);
  doneWorkers.sort(workerOrder);
  return [...liveWorkers, ...doneWorkers, ...liveItems, ...doneItems];
}

/** The watchlist's zone-level derivations: `stale` = any session reports
 *  `operatorStale` (the server's own 15-minute verdict — the frontend never
 *  re-derives the threshold); `tickAgeSeconds` from the max
 *  `operatorLastTickAt` (`null` when no session carries a tick);
 *  `hasOperator` = a tick exists or any window carries `role === "operator"`. */
export function watchlistStatus(
  sessions: ProjectSession[],
  nowSeconds: number,
): { stale: boolean; tickAgeSeconds: number | null; hasOperator: boolean } {
  const stale = sessions.some((s) => s.operatorStale === true);
  const tickAt = sessions.reduce(
    (latest, s) => Math.max(latest, s.operatorLastTickAt ?? 0),
    0,
  );
  const tickAgeSeconds = tickAt > 0 ? Math.max(0, nowSeconds - tickAt) : null;
  const hasOperator =
    tickAt > 0 || sessions.some((s) => s.windows.some((w) => w.role === "operator"));
  return { stale, tickAgeSeconds, hasOperator };
}
