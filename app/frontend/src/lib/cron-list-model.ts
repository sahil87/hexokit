// Pure derivation helpers for the quake terminal's Cron List / Cron Log tabs — the
// shared row anatomy (target chip, dim predicate, mute badge) and the registry
// sort. Leaf module in the lib/cron-schedule.ts mold: no fetch, no timers;
// every relative time is computed by the caller and passed in as `nowSeconds`
// so the tabs re-derive on the SSE cadence alone.

import { formatDuration } from "@/lib/format";
import type { CronEntry } from "@/api/client";

/** The loop entry's `run` value and its target-chip label. */
export const OPERATOR_LOOP_RUN = "operator-loop";
export const OPERATOR_LOOP_LABEL = "operator loop";

/** True for the target-less operator-loop entry (no target, no payload). */
export function isLoopEntry(entry: CronEntry): boolean {
  return entry.run === OPERATOR_LOOP_RUN;
}

/** The target chip's discriminant: `role: operator`, `session: foo`, or
 *  `pane: %3` — the first target facet the entry carries; the loop entry
 *  reads `operator loop` (it has no target). */
export function targetChip(entry: CronEntry): string {
  if (isLoopEntry(entry)) return OPERATOR_LOOP_LABEL;
  const discriminant = entry.target.role ?? entry.target.session ?? entry.target.pane;
  return discriminant ? `${entry.target.kind}: ${discriminant}` : entry.target.kind;
}

/** The shared muted/orphaned row treatment (dim) — one predicate so the cron
 *  surfaces never drift. */
export function isCronDimmed(entry: CronEntry): boolean {
  return entry.orphaned === true || entry.muted === true;
}

/** The mute badge: `muted {lease remaining}` while an unexpired lease is
 *  stored, else `muted`. Lease remaining is as-of-fetch (no clock). An expired
 *  `mutedUntil` is not a live lease — the server already reports `muted: false`
 *  for one, so the plain arm never renders a negative remaining time. */
export function mutedLabel(entry: CronEntry, nowSeconds: number): string {
  return entry.mutedUntil != null && entry.mutedUntil > nowSeconds
    ? `muted ${formatDuration(entry.mutedUntil - nowSeconds)}`
    : "muted";
}

/** The row label for an entry: its name, else the id (the unnamed-entry
 *  fallback every cron surface shares). */
export function cronEntryLabel(entry: CronEntry): string {
  return entry.name || entry.id;
}

/** Registry comparator: `nextFire` ascending (soonest first), entries without
 *  a `nextFire` last, ties stable by label then id. The Cron List's at-rest
 *  order and its `next` column's table sort are this one function. */
export function compareCronEntries(a: CronEntry, b: CronEntry): number {
  if (a.nextFire !== undefined && b.nextFire !== undefined && a.nextFire !== b.nextFire) {
    return a.nextFire - b.nextFire;
  }
  if (a.nextFire !== undefined && b.nextFire === undefined) return -1;
  if (a.nextFire === undefined && b.nextFire !== undefined) return 1;
  const byLabel = cronEntryLabel(a).localeCompare(cronEntryLabel(b));
  return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
}

/** Registry order for the Cron List tab. Pure — the same `entries` always
 *  yields the same order, and the input is never mutated. */
export function sortCronEntries(entries: CronEntry[]): CronEntry[] {
  return [...entries].sort(compareCronEntries);
}
