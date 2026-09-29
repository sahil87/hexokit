import { useMemo, useState, type KeyboardEvent } from "react";
import { useCronData } from "@/hooks/use-cron";
import { formatDuration } from "@/lib/format";
import { DataTable, type DataTableColumn, type DataTableRowProps } from "@/components/data-table";
import { CronEntryDetailSheet } from "@/components/cron-entry-detail-sheet";
import type { CronDelivery } from "@/api/client";

/**
 * The Cron Log tab — the server's delivery log, nothing else: every line of
 * `useCronData(server).deliveries` (fires, `missed`, `skipped-absent`,
 * `rate-capped`, `rescheduled`, respawn outcomes), rendered through the shared
 * `DataTable` (components/data-table.tsx) in the API's most-recent-first
 * order as-is (`initialSort: null`). No upcoming fires, no "now" divider —
 * the registry half lives in the Cron List tab. A header sort is an additive
 * per-viewer override persisted under `hexokit-table-cron-log`; `Table: Reset
 * columns` returns to API order. Data rides the mount fetch + state-socket
 * sessions cadence — no polling.
 *
 * Tapping a row whose entry still exists opens the entry detail sheet; a line
 * for a since-deleted entry stays valid history but opens nothing (the sheet
 * needs the live entry) — the inert row carries no role, tabIndex, or
 * handlers. `inline` (the desktop drawer mount) makes the root `relative` so
 * the sheet's in-container variant anchors to it, and forwards the flag.
 *
 * An unresolvable server degrades to the quake terminal's absent/hint state
 * (a centered hint line) and fires no request.
 */
export function CronLog({ server, inline = false }: { server: string; inline?: boolean }) {
  const { entries, deliveries } = useCronData(server);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const selectedEntry = selectedEntryId
    ? entries.find((e) => e.id === selectedEntryId)
    : undefined;

  const nowMs = Date.now();

  const columns = useMemo<DataTableColumn<CronDelivery>[]>(
    () => [
      {
        id: "entry",
        header: "entry",
        sortValue: (delivery) => delivery.name || delivery.entry,
        size: 200,
        minSize: 80,
        cell: (delivery) => delivery.name || delivery.entry,
      },
      {
        id: "outcome",
        header: "outcome",
        sortValue: (delivery) => delivery.outcome,
        size: 320,
        minSize: 80,
        className: "truncate text-text-secondary",
        cell: (delivery) => delivery.outcome,
      },
      {
        id: "when",
        header: "when",
        sortValue: (delivery) => delivery.ts,
        size: 110,
        minSize: 64,
        className: "text-text-secondary",
        // The age computes at render from Date.now() — the SSE cadence is the
        // clock; no ticking timer.
        cell: (delivery) =>
          `${formatDuration(Math.max(0, Math.floor(nowMs / 1000 - delivery.ts)))} ago`,
      },
    ],
    [nowMs],
  );

  if (!server) {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 text-xs text-text-secondary"
        data-testid="cron-log-unresolved"
      >
        no server resolved — cron log unavailable
      </div>
    );
  }

  return (
    <div
      className={`flex-1 min-h-0 flex flex-col${inline ? " relative" : ""}`}
      data-testid="cron-log"
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {deliveries.length === 0 ? (
          <div
            className="flex h-full items-center justify-center px-4 text-xs text-text-secondary"
            data-testid="cron-log-empty"
          >
            No deliveries yet on {server}.
          </div>
        ) : (
          <DataTable
            tableId="cron-log"
            label="Cron Log"
            columns={columns}
            rows={deliveries}
            rowKey={(delivery) => `${delivery.ts}-${delivery.entry}-${deliveries.indexOf(delivery)}`}
            initialSort={null}
            dense={inline}
            cellClassName="coarse:min-h-[44px]"
            rowProps={(delivery): DataTableRowProps => {
              const testId = `cron-delivery-row-${delivery.entry}`;
              // The detail sheet needs the live entry — a delivery for a
              // since-deleted entry stays valid history but opens nothing.
              if (!entries.some((e) => e.id === delivery.entry)) {
                return {
                  "data-testid": testId,
                  "aria-disabled": "true",
                };
              }
              return {
                "data-testid": testId,
                role: "button",
                tabIndex: 0,
                className: "cursor-pointer",
                onClick: () => setSelectedEntryId(delivery.entry),
                onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedEntryId(delivery.entry);
                  }
                },
              };
            }}
          />
        )}
      </div>
      {selectedEntry && (
        <CronEntryDetailSheet
          server={server}
          entry={selectedEntry}
          onClose={() => setSelectedEntryId(null)}
          inline={inline}
        />
      )}
    </div>
  );
}
