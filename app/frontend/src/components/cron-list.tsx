import { useMemo, useState, type KeyboardEvent } from "react";
import { useCronData } from "@/hooks/use-cron";
import { describeSchedule } from "@/lib/cron-schedule";
import {
  compareCronEntries,
  cronEntryLabel,
  isCronDimmed,
  mutedLabel,
  targetChip,
} from "@/lib/cron-list-model";
import { formatDuration } from "@/lib/format";
import { controlClass } from "@/components/control";
import { DataTable, type DataTableColumn, type DataTableRowProps } from "@/components/data-table";
import { CronEntryDetailSheet } from "@/components/cron-entry-detail-sheet";
import { CronCreateDialog } from "@/components/cron-create-dialog";
import type { CronEntry } from "@/api/client";

/**
 * The Cron List tab — the `rk cron list` registry rendered through the shared
 * `DataTable` (components/data-table.tsx): one row per entry with a sortable,
 * resizable header — entry name, target chip, schedule in plain words, backoff
 * rung, the deliver marker for non-immediate policies, the relative next fire,
 * and the muted/pinned/orphan flags. The at-rest order is `sortCronEntries`
 * (soonest-fire-first, undated last), expressed as the `next` column's initial
 * ascending sort over the same `compareCronEntries` comparator; a header click
 * is a per-viewer override persisted under `hexokit-table-cron-list`. Muted and
 * orphaned rows are DIMMED, never omitted. Tapping a row opens the entry
 * detail sheet (the row-action surface); `+ New entry` opens the create
 * dialog. Data rides `useCronData` (mount fetch + the state-socket sessions
 * cadence — no polling); every mutation's confirmation lands on the next tick.
 *
 * `inline` (the desktop drawer mount) makes the root `relative` so the
 * sheet's in-container variant anchors to it, and forwards the flag.
 *
 * An unresolvable server degrades to the quake terminal's absent/hint state
 * and fires no request.
 */
export function CronList({ server, inline = false }: { server: string; inline?: boolean }) {
  const { entries } = useCronData(server);
  return <CronListView server={server} entries={entries} inline={inline} />;
}

/**
 * The Cron List body over caller-supplied `entries` — the one rendering
 * behind `CronList`, exported so a parent that already subscribes to
 * `useCronData(server)` (the mobile Server page's Cron section, which derives
 * its heading from the same entries) mounts the list without a second cron
 * subscription per SSE tick.
 */
export function CronListView({
  server,
  entries,
  inline = false,
}: {
  server: string;
  entries: CronEntry[];
  inline?: boolean;
}) {
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selectedEntry = selectedEntryId
    ? entries.find((e) => e.id === selectedEntryId)
    : undefined;

  const nowSeconds = Math.floor(Date.now() / 1000);

  const columns = useMemo<DataTableColumn<CronEntry>[]>(
    () => [
      {
        id: "label",
        header: "entry",
        sortValue: cronEntryLabel,
        size: 200,
        minSize: 80,
        cell: (entry) => cronEntryLabel(entry),
      },
      {
        id: "target",
        header: "target",
        sortValue: targetChip,
        size: 140,
        minSize: 64,
        className: "text-text-secondary",
        cell: (entry) => targetChip(entry),
      },
      {
        id: "schedule",
        header: "schedule",
        sortValue: (entry) => describeSchedule(entry),
        size: 240,
        minSize: 80,
        className: "truncate text-text-secondary",
        cell: (entry) => describeSchedule(entry),
      },
      {
        id: "rung",
        header: "rung",
        sortValue: (entry) => (entry.schedule.kind === "backoff" ? entry.rung : undefined),
        size: 80,
        minSize: 48,
        className: "text-text-secondary",
        cell: (entry) =>
          entry.schedule.kind === "backoff" && entry.rung != null ? (
            `rung ${entry.rung}`
          ) : (
            <span className="text-text-secondary">—</span>
          ),
      },
      {
        id: "deliver",
        header: "deliver",
        sortValue: (entry) => deliverMarker(entry) ?? "",
        size: 120,
        minSize: 64,
        className: "text-text-secondary",
        // The norm (immediate) adds zero chrome — only a non-default policy
        // marks.
        cell: (entry) => {
          const marker = deliverMarker(entry);
          return marker ? <span data-testid="cron-list-deliver">{marker}</span> : null;
        },
      },
      {
        id: "next",
        header: "next",
        sortValue: (entry) => entry.nextFire,
        // The registry comparator (soonest first, undated last, label/id
        // tie-break) — the at-rest order and this column's sort are one
        // function. `sortUndefined: false` hands undefined `nextFire` pairs to
        // the comparator too (TanStack's undefined placement would skip it and
        // keep input order, breaking the tie-break).
        sortingFn: compareCronEntries,
        sortUndefined: false,
        size: 110,
        minSize: 64,
        className: "text-text-secondary",
        cell: (entry) =>
          entry.nextFire !== undefined ? (
            entry.nextFire > nowSeconds ? (
              `in ${formatDuration(entry.nextFire - nowSeconds)}`
            ) : (
              "due"
            )
          ) : (
            <span className="text-text-secondary">—</span>
          ),
      },
      {
        id: "flags",
        header: "flags",
        sortValue: (entry) => cronFlags(entry, nowSeconds).join(" · "),
        size: 200,
        minSize: 80,
        className: "text-text-secondary",
        cell: (entry) => {
          const flags = cronFlags(entry, nowSeconds);
          return flags.length > 0 ? (
            flags.join(" · ")
          ) : (
            <span className="text-text-secondary">—</span>
          );
        },
      },
    ],
    [nowSeconds],
  );

  if (!server) {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 text-xs text-text-secondary"
        data-testid="cron-list-unresolved"
      >
        no server resolved — cron list unavailable
      </div>
    );
  }

  return (
    <div
      className={`flex-1 min-h-0 flex flex-col${inline ? " relative" : ""}`}
      data-testid="cron-list"
    >
      <div className="shrink-0 border-b border-border px-3 py-1.5 flex">
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="cron-list-new"
          className={controlClass({ variant: "chip" })}
        >
          + New entry
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {entries.length === 0 ? (
          <div
            className="flex h-full items-center justify-center px-4 text-xs text-text-secondary"
            data-testid="cron-list-empty"
          >
            Agents can schedule prompts too — rk cron add.
          </div>
        ) : (
          <DataTable
            tableId="cron-list"
            label="Cron List"
            columns={columns}
            rows={entries}
            rowKey={(entry) => entry.id}
            initialSort={{ id: "next", desc: false }}
            dense={inline}
            cellClassName="coarse:min-h-[44px]"
            rowProps={(entry): DataTableRowProps => ({
              "data-testid": `cron-list-row-${entry.id}`,
              role: "button",
              tabIndex: 0,
              className: `cursor-pointer${isCronDimmed(entry) ? " opacity-50" : ""}`,
              onClick: () => setSelectedEntryId(entry.id),
              onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedEntryId(entry.id);
                }
              },
            })}
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
      {creating && <CronCreateDialog server={server} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The deliver column's marker: the raw policy text when `deliver` is set and
 *  not `immediate`, else null (the norm adds zero chrome). */
function deliverMarker(entry: CronEntry): string | null {
  return entry.deliver != null && entry.deliver !== "" && entry.deliver !== "immediate"
    ? entry.deliver
    : null;
}

/** The flags column: `muted {remaining}` while a lease is live (keyed on the
 *  server's EFFECTIVE `muted` — stored flag OR unexpired lease, so no
 *  client-side expiry logic), `muted` for the indefinite flag, `pinned`,
 *  `orphaned {age}` plus `expires {rel}` while the orphan-TTL reap time is
 *  ahead. */
function cronFlags(entry: CronEntry, nowSeconds: number): string[] {
  const flags: string[] = [];
  if (entry.muted === true) flags.push(mutedLabel(entry, nowSeconds));
  if (entry.pinned === true) flags.push("pinned");
  if (entry.orphaned === true) {
    flags.push(
      entry.orphanedSince
        ? `orphaned ${formatDuration(Math.max(0, nowSeconds - entry.orphanedSince))}`
        : "orphaned",
    );
    if (entry.expiresAt != null && entry.expiresAt > nowSeconds) {
      flags.push(`expires ${formatDuration(entry.expiresAt - nowSeconds)}`);
    }
  }
  return flags;
}
