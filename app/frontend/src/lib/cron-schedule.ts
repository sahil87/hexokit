// Pure schedule-to-sentence helper for the cron UI (the Cron List row
// summaries and the entry detail sheet share it). Dependency-free leaf module
// (the router-url.ts convention): the input type is declared locally and
// structural, so api/client.ts's CronEntry is assignable without an import
// edge.

/** The `run` value that marks the target-less operator-loop entry. */
export const OPERATOR_LOOP_RUN = "operator-loop";

/** The schedule/wakeOn slice of a cron entry this helper reads. */
export type CronScheduleLike = {
  /** `"operator-loop"` marks the target-less loop entry. */
  run?: string;
  schedule: {
    kind: string;
    interval?: string;
    min?: string;
    max?: string;
    expr?: string;
  };
  wakeOn?: { event: string; scope?: string; debounce?: string } | null;
};

const UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};

/** Parse a Go-style duration string ("60s", "30m", "1h30m") to seconds.
 *  Returns null on anything that doesn't parse — callers fall back to the
 *  raw string rather than fabricating a phrasing. */
function parseGoDurationSeconds(raw: string): number | null {
  if (raw.length === 0) return null;
  let rest = raw;
  let total = 0;
  let matched = false;
  const re = /^(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    matched = true;
    total += parseFloat(m[1]) * UNIT_SECONDS[m[2]];
    rest = rest.slice(m[0].length);
  }
  return matched && rest.length === 0 ? total : null;
}

/** Render seconds as plain words: "1 minute", "30 minutes",
 *  "1 hour 30 minutes", "45 seconds". Sub-second precision truncates; a
 *  positive sub-second duration renders "less than 1 second" — flooring it
 *  to "0 seconds" would misstate a valid interval. */
function humanizeSeconds(totalSeconds: number): string {
  let rest = Math.floor(totalSeconds);
  const parts: string[] = [];
  const push = (n: number, unit: string) => {
    if (n > 0) parts.push(`${n} ${unit}${n === 1 ? "" : "s"}`);
  };
  push(Math.floor(rest / 3600), "hour");
  rest %= 3600;
  push(Math.floor(rest / 60), "minute");
  rest %= 60;
  push(rest, "second");
  if (parts.length > 0) return parts.join(" ");
  return totalSeconds > 0 ? "less than 1 second" : "0 seconds";
}

/** Humanize a Go-style duration string ("60s" → "1 minute"); unparseable or
 *  empty input passes through verbatim. Exported for the sheet's rows. */
export function humanizeDuration(raw: string): string {
  const seconds = parseGoDurationSeconds(raw);
  return seconds === null ? raw : humanizeSeconds(seconds);
}

/**
 * Translate an entry's schedule (and wakeOn, when present) into a plain-words
 * sentence: `{kind:"every", interval:"1h"}` → "every hour"; `{kind:"backoff",
 * min:"60s", max:"30m"}` → "backs off from 1 minute up to 30 minutes since
 * last activity"; `{kind:"cron", expr}` → the raw expression ("cron
 * expression" when empty). Unknown kinds render their raw kind, never a
 * fabricated phrasing.
 */
export function describeSchedule(entry: CronScheduleLike): string {
  const { schedule } = entry;
  let base: string;
  switch (schedule.kind) {
    case "every": {
      const interval = schedule.interval ?? "";
      const humanized = humanizeDuration(interval);
      // "every hour", not "every 1 hour" — the numeral drops only for a
      // single-unit duration ("every 1 hour 30 minutes" keeps it).
      const phrasing =
        humanized.startsWith("1 ") && humanized.split(" ").length === 2
          ? humanized.slice(2)
          : humanized;
      base = `every ${phrasing || "unknown interval"}`;
      break;
    }
    case "backoff": {
      const min = humanizeDuration(schedule.min ?? "");
      const max = humanizeDuration(schedule.max ?? "");
      if (entry.run === OPERATOR_LOOP_RUN) {
        // The loop has no agent pane whose activity to back off from: it
        // checks the tracked items, and the gap grows while nothing changes.
        base = `checks tracked items, backing off from ${min || "unknown"} up to ${max || "unknown"} while nothing changes`;
        break;
      }
      base = `backs off from ${min || "unknown"} up to ${max || "unknown"} since last activity`;
      break;
    }
    case "cron": {
      const expr = schedule.expr ?? "";
      base = expr || "cron expression";
      break;
    }
    default:
      base = `unknown schedule (${schedule.kind || "unset"})`;
  }
  if (entry.wakeOn && entry.wakeOn.event) {
    base += `; wakes on ${entry.wakeOn.event}`;
  }
  return base;
}

/**
 * Translate an entry's `deliver` policy into a plain-words sentence:
 * `undefined`/`""`/`immediate` → "delivered immediately"; `when-idle` →
 * "held until the agent is idle (up to 2h)"; `skip-if-busy` → "skipped when
 * the agent is busy". Unknown values render raw, never a fabricated phrasing
 * (the describeSchedule unknown-kind precedent) — the wire type stays
 * `string`; this helper is the one place that knows the enum.
 */
export function describeDeliver(deliver?: string): string {
  switch (deliver) {
    case undefined:
    case "":
    case "immediate":
      return "delivered immediately";
    case "when-idle":
      return "held until the agent is idle (up to 2h)";
    case "skip-if-busy":
      return "skipped when the agent is busy";
    default:
      return deliver;
  }
}
