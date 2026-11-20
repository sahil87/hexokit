import { useMemo, useState, type KeyboardEvent } from "react";
import { useCronData } from "@/hooks/use-cron";
import { formatDuration } from "@/lib/format";
import { DataTable, type DataTableColumn, type DataTableRowProps } from "@/components/data-table";
import { CronEntryDetailSheet } from "@/components/cron-entry-detail-sheet";
import { controlClass } from "@/components/control";
import type { CronDelivery } from "@/api/client";

// The operator-loop entry's `run` value (CronEntry.run).
const OPERATOR_LOOP_RUN = "operator-loop";

/**
 * The Cron segment's deliveries half — the server's delivery log, nothing
 * else: every line of `useCronData(server).deliveries` (fires, `missed`, `skipped-absent`,
 * `rate-capped`, `rescheduled`, respawn outcomes), rendered through the shared
 * `DataTable` (components/data-table.tsx) in the API's most-recent-first
 * order as-is (`initialSort: null`). No upcoming fires, no "now" divider —
 * the registry half is CronList, stacked above it in CronConsole. A header
 * sort is an additive per-viewer override persisted under `hexokit-table-cron-log`; `Table: Reset
 * columns` returns to API order. Data rides the mount fetch + state-socket
 * sessions cadence — no polling.
 *
 * Rows of the operator-loop entry are hidden by default — the loop's own
 * view is the Activity tab — and a `show loop` toggle in the header reveals
 * them (component state, not persisted). A line for a since-deleted entry
 * cannot be told apart and stays visible.
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
  // The tapped delivery line itself: the sheet needs its entry AND, for an
  // operator-loop run, the run fields the line carries.
  const [selectedDelivery, setSelectedDelivery] = useState<CronDelivery | null>(null);
  const [showLoop, setShowLoop] = useState(false);

  const selectedEntry = selectedDelivery
    ? entries.find((e) => e.id === selectedDelivery.entry)
    : undefined;

  const nowMs = Date.now();

  const visible = useMemo(() => {
    if (showLoop) return deliveries;
    const loopIds = new Set(entries.filter((e) => e.run === OPERATOR_LOOP_RUN).map((e) => e.id));
    return deliveries.filter((d) => !loopIds.has(d.entry));
  }, [deliveries, entries, showLoop]);

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
        no workspace resolved — cron log unavailable
      </div>
    );
  }

  return (
    <div
      className={`flex-1 min-h-0 flex flex-col${inline ? " relative" : ""}`}
      data-testid="cron-log"
    >
      <div className="shrink-0 border-b border-border px-3 py-1.5 flex">
        <button
          type="button"
          aria-pressed={showLoop}
          onClick={() => setShowLoop((v) => !v)}
          data-testid="cron-log-show-loop"
          className={controlClass({
            variant: "toggle",
            base: "rounded border px-2 py-0.5 text-[11px] font-mono coarse:min-h-[36px]",
            pressed: showLoop,
          })}
        >
          show loop
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 ? (
          <div
            className="flex h-full items-center justify-center px-4 text-xs text-text-secondary"
            data-testid="cron-log-empty"
          >
            {deliveries.length === 0
              ? `No deliveries yet on ${server}.`
              : `No deliveries on ${server} besides the operator loop.`}
          </div>
        ) : (
          <DataTable
            tableId="cron-log"
            label="Cron Log"
            columns={columns}
            rows={visible}
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
                onClick: () => setSelectedDelivery(delivery),
                onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedDelivery(delivery);
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
          delivery={selectedDelivery ?? undefined}
          onClose={() => setSelectedDelivery(null)}
          inline={inline}
        />
      )}
    </div>
  );
}
