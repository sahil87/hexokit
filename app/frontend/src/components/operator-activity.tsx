import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  getOperatorRunFile,
  postOperatorWake,
  type OperatorActivityRow,
  type OperatorCheckDelta,
  type OperatorCheckNotice,
} from "@/api/client";
import { controlClass } from "@/components/control";
import { useOperatorActivity } from "@/hooks/use-operator-activity";
import { formatDuration } from "@/lib/format";

/**
 * The Activity tab — one row per operator-loop fire, newest first, read from
 * GET /api/operator/activity (loop log lines joined with each fire's check and
 * run records). Data rides the mount fetch plus the state-socket sessions
 * cadence (`useOperatorActivity`) — no polling.
 *
 * Header: the `runs · triggers · all` filter chips (component state, default
 * `all`) and **Check now**, which posts the trigger door (`POST
 * /api/operator/wake`, the reason defaulting to `manual`): the next cron tick
 * runs one free check, and a run only if something changed. There is no forced
 * run. The button is disabled while a run is in flight.
 *
 * A row expands on click and Enter/Space to the changed/open lists, the
 * notices and — when the run has them — the brief and the run log, each
 * fetched once on first expand. An unresolvable server degrades to the
 * quake terminal's hint line and fires no request.
 */

type ActivityFilter = "runs" | "triggers" | "all";
const FILTERS: readonly ActivityFilter[] = ["runs", "triggers", "all"];

/** The size the server caps a served run file at, as the truncation line
 *  names it (api/operator_activity.go's maxRunFileBytes). */
const RUN_FILE_CAP_LABEL = "256 KiB";

const SCHEDULE_REASON = "schedule";
const TRIGGER_REASON_PREFIX = "trigger:";
const MANUAL_TRIGGER = "manual";
const AGENT_WAKE_REASON = "wake";
const NO_CHANGE_OUTCOME = "no change";

/** The row's trigger label: how the fire came about. */
export function triggerLabel(row: Pick<OperatorActivityRow, "reason" | "rung">): string {
  if (row.reason === SCHEDULE_REASON) return `schedule · rung ${row.rung}`;
  if (row.reason === AGENT_WAKE_REASON) return "trigger · agent";
  if (row.reason.startsWith(TRIGGER_REASON_PREFIX)) {
    const why = row.reason.slice(TRIGGER_REASON_PREFIX.length);
    return why === MANUAL_TRIGGER ? "manual" : `trigger · ${why}`;
  }
  return row.reason;
}

/** What the fire's check found; without a check record, the raw loop outcome
 *  (`skipped-busy: …`, `check-failed: …`). */
export function checkSummary(row: Pick<OperatorActivityRow, "check" | "outcome">): string {
  const { check } = row;
  if (!check) return row.outcome;
  const base = `${check.items} items · ${check.changes.length} changes · ${check.open.length} open`;
  return check.notices.length > 0 ? `${base} · ${check.notices.length} notices` : base;
}

/** What the run did: in flight, mechanical-only (with the record's duration),
 *  or the loop line's outcome — which already carries its own duration — when
 *  it adds to the check summary; empty when there is nothing to add. */
export function runSummary(row: OperatorActivityRow): string {
  const actions = row.run?.pass?.actions ?? 0;
  if (row.running) return "running…";
  if (row.run && actions > 0 && !row.run.outcome) {
    const text = `mechanical · ${actions} action${actions === 1 ? "" : "s"}`;
    return row.run.duration_s > 0 ? `${text} · ${formatDuration(row.run.duration_s)}` : text;
  }
  if (row.check && row.outcome && row.outcome !== NO_CHANGE_OUTCOME) return row.outcome;
  return "";
}

function passesFilter(row: OperatorActivityRow, filter: ActivityFilter): boolean {
  switch (filter) {
    case "runs":
      return row.run !== undefined || row.running === true;
    case "triggers":
      return row.reason !== SCHEDULE_REASON;
    default:
      return true;
  }
}

/** A delta's kind-specific detail, in the order the check records it. */
function deltaDetail(d: OperatorCheckDelta): string {
  const parts: string[] = [];
  if (d.from !== undefined || d.to !== undefined) parts.push(`${d.from ?? "null"}→${d.to ?? "null"}`);
  if (d.fields) parts.push(Object.keys(d.fields).sort().join(","));
  for (const v of [d.age, d.duration, d.dep, d.error, d.command, d.found, d.instruction, d.at]) {
    if (v) parts.push(v);
  }
  return parts.join(" · ");
}

function noticeText(n: OperatorCheckNotice): string {
  return `${n.id} · ${n.kind} · ${n.error} (${n.failures}×)`;
}

function DeltaList({ title, deltas, testId }: { title: string; deltas: OperatorCheckDelta[]; testId: string }) {
  if (deltas.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h4 className="text-text-secondary">{title}</h4>
      <ul>
        {deltas.map((d, i) => (
          <li key={`${d.id}-${d.kind}-${i}`} className="break-words">
            {d.id} · {d.kind}
            {deltaDetail(d) ? ` · ${deltaDetail(d)}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

type RunFileState =
  | { status: "loading" }
  | { status: "ok"; text: string; truncated: boolean }
  | { status: "error"; message: string };

/** One run file's pane, fetched once when mounted. A failure renders inline. */
function RunFilePane({
  server,
  runId,
  kind,
  title,
}: {
  server: string;
  runId: string;
  kind: "brief" | "log";
  title: string;
}) {
  const [state, setState] = useState<RunFileState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    getOperatorRunFile(server, runId, kind)
      .then((file) => {
        if (!cancelled) setState({ status: "ok", text: file.text, truncated: file.truncated });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : "failed to load" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [server, runId, kind]);

  return (
    <section data-testid={`operator-activity-${kind}`}>
      <h4 className="text-text-secondary">{title}</h4>
      {state.status === "loading" && <p className="text-text-secondary">loading…</p>}
      {state.status === "error" && (
        <p className="text-signal-red" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <>
          {state.truncated && (
            <p className="text-text-secondary" data-testid={`operator-activity-${kind}-truncated`}>
              truncated — showing {kind === "brief" ? "first" : "last"} {RUN_FILE_CAP_LABEL}
            </p>
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-card p-2">
            {state.text}
          </pre>
        </>
      )}
    </section>
  );
}

function ActivityRow({ server, row }: { server: string; row: OperatorActivityRow }) {
  const [expanded, setExpanded] = useState(false);
  // The detail mounts on the first expand and stays mounted (hidden) after, so
  // the run files are fetched once per row, not once per expand.
  const [opened, setOpened] = useState(false);
  const toggle = () => {
    setOpened(true);
    setExpanded((v) => !v);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const run = row.run;
  const checkText = checkSummary(row);
  const runText = runSummary(row);
  return (
    <li className="border-b border-border" data-testid="operator-activity-row">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className="cursor-pointer px-3 py-1.5 text-xs font-mono hover:bg-bg-card coarse:min-h-[44px]"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-text-primary" data-testid="operator-activity-trigger">
            {triggerLabel(row)}
          </span>
          <span className="ml-auto shrink-0 text-text-secondary">
            {row.running ? "now" : `${formatDuration(Math.max(0, nowSec - row.ts))} ago`}
          </span>
        </div>
        <div className="text-text-secondary break-words" data-testid="operator-activity-check">
          {checkText}
        </div>
        {runText && (
          <div className="text-text-secondary break-words" data-testid="operator-activity-run">
            {runText}
          </div>
        )}
      </div>
      {opened && (
        <div
          hidden={!expanded}
          className="flex flex-col gap-2 px-3 pb-2 text-xs font-mono"
          data-testid="operator-activity-detail"
        >
          <DeltaList title="Changed" deltas={row.check?.changes ?? []} testId="operator-activity-changed" />
          <DeltaList title="Open" deltas={row.check?.open ?? []} testId="operator-activity-open" />
          {row.check && row.check.notices.length > 0 && (
            <section data-testid="operator-activity-notices">
              <h4 className="text-text-secondary">Notices</h4>
              <ul>
                {row.check.notices.map((n, i) => (
                  <li key={`${n.id}-${i}`} className="break-words">
                    {noticeText(n)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {run?.has_brief && <RunFilePane server={server} runId={run.id} kind="brief" title="Brief" />}
          {run?.has_log && <RunFilePane server={server} runId={run.id} kind="log" title="Run log" />}
        </div>
      )}
    </li>
  );
}

type WakeState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "queued"; since: number }
  | { kind: "error" };

function rowKey(row: OperatorActivityRow): string {
  return `${row.running ? "running" : "line"}:${row.ts}:${row.fire ?? ""}:${row.reason}:${row.outcome}`;
}

export function OperatorActivity({ server }: { server: string }) {
  const { data, fetchedAt, refetch } = useOperatorActivity(server);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [wake, setWake] = useState<WakeState>({ kind: "idle" });
  const fetchedAtRef = useRef(fetchedAt);
  fetchedAtRef.current = fetchedAt;

  // "check queued" ends when the next activity fetch returns.
  useEffect(() => {
    if (wake.kind === "queued" && fetchedAt > wake.since) setWake({ kind: "idle" });
  }, [wake, fetchedAt]);

  if (!server) {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 text-xs text-text-secondary"
        data-testid="operator-activity-unresolved"
      >
        no workspace resolved — operator activity unavailable
      </div>
    );
  }

  const inFlight = data.in_flight !== null;
  const checkNow = () => {
    if (inFlight || wake.kind === "sending") return;
    setWake({ kind: "sending" });
    postOperatorWake(server).then(
      () => {
        setWake({ kind: "queued", since: fetchedAtRef.current });
        refetch();
      },
      () => setWake({ kind: "error" }),
    );
  };
  const checkLabel = inFlight
    ? "run in progress"
    : wake.kind === "queued"
      ? "check queued"
      : wake.kind === "error"
        ? "check failed — retry"
        : "Check now";

  const rows = data.rows.filter((row) => passesFilter(row, filter));
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="operator-activity">
      <div className="shrink-0 flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        {FILTERS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={filter === name}
            onClick={() => setFilter(name)}
            data-testid={`operator-activity-filter-${name}`}
            className={controlClass({
              variant: "toggle",
              base: "rounded border px-2 py-0.5 text-[11px] font-mono coarse:min-h-[36px]",
              pressed: filter === name,
            })}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          disabled={inFlight || wake.kind === "sending"}
          onClick={checkNow}
          data-testid="operator-activity-check-now"
          data-state={inFlight ? "running" : wake.kind}
          className={`${controlClass({ variant: "chip", disabled: inFlight || wake.kind === "sending" })} ml-auto`}
        >
          {checkLabel}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <div
            className="flex h-full items-center justify-center px-4 text-xs text-text-secondary"
            data-testid="operator-activity-empty"
          >
            {data.rows.length === 0 ? "no operator activity yet" : `no ${filter} rows`}
          </div>
        ) : (
          <ul>
            {rows.map((row) => (
              <ActivityRow key={rowKey(row)} server={server} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
