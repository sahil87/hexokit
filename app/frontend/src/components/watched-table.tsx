/**
 * The watched-workers table — the ONE rendering of the operator watchlist's
 * rows, mounted by the Server page's WATCHED zone
 * (components/server-watched-zone/watched-zone.tsx, which adapts the
 * `collectWatchedRows` derivation into worker rows via ./model.ts's
 * `watchlistStatus`) and by the quake terminal's Operator Tasks segment
 * (components/watched-tasks.tsx, over `collectTrackedRows`). Six columns —
 * status, session, change, awaiting, note, repo — rendered per row species:
 * a `worker` row is a tracked item on a live window (`StatusDot` + the
 * window-name navigate button, change · stage badge, awaiting, note, repo);
 * an `item` row is a pane-less or dead-pane tracked item (kind chip + id,
 * refs, paused/done/`pane gone`, truncated text with expand-in-place toggle,
 * repo + `updated … ago`) and never navigates. Done rows dim
 * (`opacity-50` + `data-done`). Read-only by design: the watchlist is
 * derived, edits are `fab operator` verbs.
 *
 * The table renders through the shared `DataTable` (components/data-table.tsx)
 * — the header row, click-to-sort, and fine-pointer resize are DataTable's;
 * the cells below are today's markup. The two densities persist under separate
 * view-state keys (`watched` for the Server page and the mobile `?tab=tasks`
 * mount, `watched-dense` for the drawer) because the same six columns at
 * ~420px and at full page width want different widths.
 *
 * The table holds no clock: every relative age is computed at render from the
 * already-passed sessions, refreshed by the SSE cadence. A stale watchlist
 * (the server's `operatorStale` verdict) dims the whole table. `dense` is the
 * quake terminal variant: tighter cell/header padding, all six columns kept.
 */
import { useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/data-table";
import { StatusDot } from "@/components/status-dot";
import { Tip } from "@/components/tip";
import { NOTE_STALE_SECONDS } from "@/components/sidebar/row-flyout-card";
import { formatDuration } from "@/lib/format";
import type { TrackedRow } from "@/components/server-watched-zone/model";
import type { OperatorTrackedItem, WindowInfo } from "@/types";

export function WatchedTable({
  rows,
  stale,
  nowSeconds,
  onNavigate,
  dense = false,
}: {
  rows: TrackedRow[];
  stale: boolean;
  nowSeconds: number;
  onNavigate: (windowId: string) => void;
  /** Quake terminal variant: tighter cell/header padding only — no column drop. */
  dense?: boolean;
}) {
  const columns = useMemo<DataTableColumn<TrackedRow>[]>(
    () => [
      {
        id: "status",
        header: "status",
        sortValue: (row) => (row.kind === "worker" ? row.win.name : row.item.id),
        size: 160,
        minSize: 80,
        cell: (row) =>
          row.kind === "worker" ? (
            <button
              type="button"
              data-testid="watched-row-navigate"
              onClick={() => onNavigate(row.win.windowId)}
              className="flex items-center gap-1.5 min-w-0 max-w-full text-left text-text-primary hover:text-accent-green"
            >
              <StatusDot win={row.win} watched={{ stale }} />
              <span className="truncate">{row.win.name}</span>
            </button>
          ) : (
            <span className="flex items-center gap-1.5 min-w-0 max-w-full">
              <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                {row.item.kind || "item"}
              </span>
              <span className="truncate text-text-primary">{row.item.id}</span>
            </span>
          ),
      },
      {
        id: "session",
        header: "group",
        sortValue: (row) => (row.kind === "worker" ? row.session : row.item.session || undefined),
        size: 120,
        minSize: 64,
        className: "text-text-secondary",
        cell: (row) => (row.kind === "worker" ? row.session : row.item.session || "—"),
      },
      {
        id: "change",
        header: "change",
        sortValue: (row) => (row.kind === "worker" ? rowChange(row) : rowRefs(row.item)) ?? "",
        size: 200,
        minSize: 80,
        cell: (row) => (row.kind === "worker" ? <WorkerChangeCell row={row} /> : <ItemRefsCell item={row.item} />),
      },
      {
        id: "awaiting",
        header: "awaiting",
        sortValue: awaitingSortValue,
        size: 110,
        minSize: 64,
        className: (row) =>
          `whitespace-nowrap${
            row.kind === "worker" && awaitingCell(row.win)?.waiting ? " text-signal-yellow" : ""
          }`,
        cell: (row) =>
          row.kind === "worker" ? (
            <WorkerAwaitingCell win={row.win} />
          ) : row.item.paused === true ? (
            <span className="text-signal-yellow">paused</span>
          ) : row.done ? (
            <span>done</span>
          ) : row.item.pane ? (
            <span className="text-text-secondary">pane gone</span>
          ) : (
            <span className="text-text-secondary">—</span>
          ),
      },
      {
        id: "note",
        header: "note",
        sortValue: (row) => (row.kind === "worker" ? row.win.note : row.item.text) ?? "",
        size: 240,
        minSize: 80,
        className: (row) =>
          row.kind === "worker" && noteStale(row.win, nowSeconds) ? "opacity-50" : undefined,
        cell: (row) =>
          row.kind === "worker" ? (
            <WorkerNoteCell win={row.win} nowSeconds={nowSeconds} />
          ) : row.item.text ? (
            <NoteCell text={row.item.text} dense={dense} />
          ) : (
            <span className="text-text-secondary">—</span>
          ),
      },
      {
        id: "repo",
        header: "repo",
        sortValue: (row) => repoBasename(rowRepo(row)),
        size: 160,
        minSize: 64,
        cell: (row) =>
          row.kind === "worker" ? (
            <RepoCell repo={rowRepo(row)} />
          ) : (
            <ItemRepoCell item={row.item} nowSeconds={nowSeconds} />
          ),
      },
    ],
    [stale, nowSeconds, onNavigate, dense],
  );

  return (
    <DataTable
      tableId={dense ? "watched-dense" : "watched"}
      label={dense ? "Operator Tasks" : "Watched"}
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.kind}:${row.item.id}`}
      initialSort={null}
      dense={dense}
      rowProps={(row) => ({
        "data-testid": row.kind === "worker" ? "watched-row" : "tracked-item-row",
        "data-done": row.done ? "true" : undefined,
        className: row.done ? "opacity-50" : undefined,
      })}
      className={stale ? "opacity-50" : undefined}
      data-testid="watched-table"
    />
  );
}

/** The awaiting column: `waiting 6m` (the status-dot amber vocabulary) /
 *  `busy` / `idle 12m`; `—` when the window carries no agent state. The
 *  duration is the server-computed `agentIdleDuration` string. */
function awaitingCell(win: WindowInfo): { text: string; waiting: boolean } | null {
  switch (win.agentState) {
    case "waiting":
      return { text: `waiting ${win.agentIdleDuration ?? ""}`.trim(), waiting: true };
    case "active":
      return { text: "busy", waiting: false };
    case "idle":
      return { text: `idle ${win.agentIdleDuration ?? ""}`.trim(), waiting: false };
    default:
      return null;
  }
}

/** Awaiting sort: state rank (waiting · active · idle · other) scaled up so
 *  states stay contiguous, idle seconds ordering within a state; item rows
 *  (paused/done/pane-gone) rank with "other". */
const AWAITING_RANK_SCALE = 1e9;

function awaitingSortValue(row: TrackedRow): number {
  if (row.kind !== "worker") return 3 * AWAITING_RANK_SCALE;
  const state = row.win.agentState;
  const rank = state === "waiting" ? 0 : state === "active" ? 1 : state === "idle" ? 2 : 3;
  // The backend now carries an age for `active` too (a lost-write signal for
  // machine consumers); the table neither renders nor sorts on it, so active
  // rows keep tying as they always have.
  const restState = state === "waiting" || state === "idle";
  return rank * AWAITING_RANK_SCALE + (restState ? durationSeconds(row.win.agentIdleDuration) : 0);
}

/** Parse the `6m`-style idle-duration string back to seconds for sorting. */
function durationSeconds(duration: string | undefined): number {
  const match = /^(\d+)([smh])$/.exec(duration ?? "");
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] === "h" ? value * 3600 : match[2] === "m" ? value * 60 : value;
}

function repoBasename(repo: string): string {
  return repo ? (repo.split("/").filter(Boolean).pop() ?? repo) : "";
}

/** A done pane-bearing item no longer joins, so its live window carries no
 *  monitored* facets — the row reads them from the item. The facets rule keeps
 *  a done item's window (since claimed by a different live item) from leaking
 *  its monitored* facets into this row. */
function rowChange(row: Extract<TrackedRow, { kind: "worker" }>): string | undefined {
  return row.done ? row.item.id : row.win.monitoredChange;
}

function rowStage(row: Extract<TrackedRow, { kind: "worker" }>): string | undefined {
  return row.done ? row.item.stage : row.win.monitoredStage;
}

function rowRepo(row: TrackedRow): string {
  if (row.kind === "item") return row.item.repo ?? "";
  return (row.done ? row.item.repo : row.win.monitoredRepo) ?? "";
}

function rowRefs(item: OperatorTrackedItem): string {
  return (item.refs ?? []).join(", ");
}

function noteStale(win: WindowInfo, nowSeconds: number): boolean {
  const noteEpoch = win.noteEpoch ?? 0;
  return noteEpoch > 0 && nowSeconds - noteEpoch > NOTE_STALE_SECONDS;
}

function WorkerChangeCell({ row }: { row: Extract<TrackedRow, { kind: "worker" }> }) {
  const change = rowChange(row);
  const stage = rowStage(row);
  const paused = row.item.paused === true;
  if (!change) return <span className="text-text-secondary">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span>{change}</span>
      {stage && (
        <>
          {" · "}
          <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">{stage}</span>
        </>
      )}
      {paused && (
        <>
          {" · "}
          <span className="text-signal-yellow">paused</span>
        </>
      )}
      {row.done && (
        <>
          {" · "}
          <span className="text-text-secondary">done</span>
        </>
      )}
    </span>
  );
}

function ItemRefsCell({ item }: { item: OperatorTrackedItem }) {
  const refs = rowRefs(item);
  if (!refs) return <span className="text-text-secondary">—</span>;
  return (
    <Tip label={refs} placement="top">
      <span className="block truncate max-w-[24ch]">{refs}</span>
    </Tip>
  );
}

function WorkerAwaitingCell({ win }: { win: WindowInfo }) {
  const awaiting = awaitingCell(win);
  if (!awaiting) return <span className="text-text-secondary">—</span>;
  return <>{awaiting.text}</>;
}

function WorkerNoteCell({ win, nowSeconds }: { win: WindowInfo; nowSeconds: number }) {
  if (!win.note) return <span className="text-text-secondary">—</span>;
  const noteEpoch = win.noteEpoch ?? 0;
  const noteAgeSeconds = noteEpoch > 0 ? Math.max(0, nowSeconds - noteEpoch) : null;
  return (
    <Tip label={win.note} placement="top">
      <span className="block truncate max-w-[24ch] text-text-secondary">
        {win.note}
        {noteAgeSeconds !== null && ` · ${formatDuration(noteAgeSeconds)} ago`}
      </span>
    </Tip>
  );
}

function RepoCell({ repo }: { repo: string }) {
  const repoBase = repoBasename(repo);
  if (!repoBase) return <span className="text-text-secondary">—</span>;
  return (
    <Tip label={repo} placement="top">
      <span className="block truncate max-w-[16ch] text-text-secondary">{repoBase}</span>
    </Tip>
  );
}

/** The item-species note cell: the only interaction on an item row is this
 *  expand-in-place toggle (a native button, so Enter/Space work and the row
 *  is keyboard-reachable). The expanded state is cell-local so the row itself
 *  stays stateless. */
function NoteCell({ text, dense }: { text: string; dense: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <button
        type="button"
        aria-expanded="true"
        data-testid="tracked-item-expand"
        onClick={() => setExpanded(false)}
        className="block w-full text-left whitespace-pre-wrap text-text-secondary"
      >
        {text}
      </button>
    );
  }
  return (
    <Tip label={text} placement="top">
      <button
        type="button"
        aria-expanded="false"
        data-testid="tracked-item-expand"
        onClick={() => setExpanded(true)}
        className={`block truncate text-left text-text-secondary ${dense ? "max-w-[40ch]" : "max-w-[24ch]"}`}
      >
        {text}
      </button>
    </Tip>
  );
}

function ItemRepoCell({ item, nowSeconds }: { item: OperatorTrackedItem; nowSeconds: number }) {
  const repo = item.repo ?? "";
  const repoBase = repoBasename(repo);
  const stamp =
    item.updatedAt !== undefined && item.updatedAt > 0
      ? `updated ${formatDuration(Math.max(0, nowSeconds - item.updatedAt))} ago`
      : item.addedAt !== undefined && item.addedAt > 0
        ? `added ${formatDuration(Math.max(0, nowSeconds - item.addedAt))} ago`
        : null;
  if (!repoBase && !stamp) return <span className="text-text-secondary">—</span>;
  return (
    <span className="block truncate text-text-secondary whitespace-nowrap">
      {repoBase && (
        <Tip label={repo} placement="top">
          <span>{repoBase}</span>
        </Tip>
      )}
      {repoBase && stamp && " · "}
      {stamp}
    </span>
  );
}
