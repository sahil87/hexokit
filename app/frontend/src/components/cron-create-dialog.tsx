import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/dialog";
import { controlClass } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";
import {
  ApiError,
  createCron,
  editCron,
  type CronEditBody,
  type CronEntry,
  type CronSchedule,
} from "@/api/client";
import { isLoopEntry, targetChip } from "@/lib/cron-list-model";

type ScheduleKind = "every" | "backoff" | "cron";
type Deliver = "immediate" | "when-idle" | "skip-if-busy";
type IfAbsent = "skip" | "notify" | "respawn";

// Narrowing over the wire's plain-string fields — the route's enums live here
// (the describeDeliver precedent: the helper is the one place that knows the
// enum). Unknown values fall to the norm rather than erroring.
function toScheduleKind(kind: string | undefined): ScheduleKind {
  return kind === "backoff" || kind === "cron" ? kind : "every";
}
function toDeliver(deliver: string | undefined): Deliver {
  return deliver === "when-idle" || deliver === "skip-if-busy" ? deliver : "immediate";
}
function toIfAbsent(ifAbsent: string | undefined): IfAbsent {
  return ifAbsent === "notify" || ifAbsent === "respawn" ? ifAbsent : "skip";
}

/** The respawn argv input is a single whitespace-split field — the web's
 *  simple form of the CLI's repeatable `--respawn` flag. */
function parseRespawnArgv(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

function sameArgv(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The dialog behind the palette's `Cron: new entry` and the detail sheet's
 * Edit row — the web's create/edit surface for the operator clock (the CLI
 * stays the full-featured path). Fields: optional name, a schedule — kind
 * segment (every / backoff / cron) with its param input(s) — and a Delivery
 * segment (immediate / when-idle / skip-if-busy) sent as `deliver`.
 *
 * CREATE mode (no `entry`): the payload is the required first field and the
 * target is fixed to role "operator" — cron is the operator's clock. Submit
 * POSTs createCron.
 *
 * EDIT mode (`entry` present): title `Edit entry`, submit label `Save`. Name,
 * schedule (a kind change replaces the whole schedule), deliver, if-absent,
 * and respawn argv are editable; target (rendered as the chip), payload (as
 * text), and muted/pinned are read-only — the route exposes no edit for them
 * (muted/pinned have their own verbs). Submit POSTs ONLY the changed fields
 * via editCron; a non-`respawn` if-absent clears a stored respawn argv.
 * Server 400s render inline and the dialog stays open for edit (the
 * TextSetting rejection idiom); a 409 (cron tick in progress) renders the
 * same way and is retryable — the dialog stays open and Save fires again.
 */
export function CronCreateDialog({
  server,
  entry,
  onClose,
}: {
  server: string;
  /** Present = edit mode for this entry. */
  entry?: CronEntry;
  onClose: () => void;
}) {
  const editing = entry !== undefined;
  const [name, setName] = useState(entry?.name ?? "");
  const [payload, setPayload] = useState("");
  const [kind, setKind] = useState<ScheduleKind>(() => toScheduleKind(entry?.schedule.kind));
  const [deliver, setDeliver] = useState<Deliver>(() => toDeliver(entry?.deliver));
  const [ifAbsent, setIfAbsent] = useState<IfAbsent>(() => toIfAbsent(entry?.ifAbsent));
  const [respawn, setRespawn] = useState(entry?.respawn?.join(" ") ?? "");
  const [interval, setInterval_] = useState(entry?.schedule.interval ?? "");
  const [min, setMin] = useState(entry?.schedule.min ?? "");
  const [max, setMax] = useState(entry?.schedule.max ?? "");
  const [expr, setExpr] = useState(entry?.schedule.expr ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const inputClass = `w-full bg-transparent text-text-primary p-2 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`;

  const schedule: CronSchedule =
    kind === "every"
      ? { kind, interval: interval.trim() }
      : kind === "backoff"
        ? { kind, min: min.trim(), max: max.trim() }
        : { kind, expr: expr.trim() };

  const scheduleValid =
    kind === "every"
      ? interval.trim().length > 0
      : kind === "backoff"
        ? min.trim().length > 0 && max.trim().length > 0
        : expr.trim().length > 0;
  const canSubmit = (editing || payload.trim().length > 0) && scheduleValid && !submitting;

  function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    if (entry) {
      const orig = entry.schedule;
      const scheduleChanged =
        kind !== toScheduleKind(orig.kind) ||
        (kind === "every" && interval.trim() !== (orig.interval ?? "")) ||
        (kind === "backoff" && (min.trim() !== (orig.min ?? "") || max.trim() !== (orig.max ?? ""))) ||
        (kind === "cron" && expr.trim() !== (orig.expr ?? ""));
      const body: CronEditBody = { id: entry.id };
      if (name.trim() !== (entry.name ?? "")) body.name = name.trim();
      if (scheduleChanged) body.schedule = schedule;
      if (deliver !== toDeliver(entry.deliver)) body.deliver = deliver;
      if (ifAbsent !== toIfAbsent(entry.ifAbsent)) body.ifAbsent = ifAbsent;
      if (ifAbsent === "respawn") {
        const argv = parseRespawnArgv(respawn);
        if (!sameArgv(argv, entry.respawn ?? [])) body.respawn = argv;
      } else if ((entry.respawn ?? []).length > 0) {
        // A non-respawn if-absent clears the stored argv.
        body.respawn = [];
      }
      editCron(server, body)
        .then(onClose)
        .catch((err: unknown) => {
          setError(
            err instanceof ApiError && err.status === 409
              ? `${err.message} — retry`
              : err instanceof Error && err.message
                ? err.message
                : "Save failed",
          );
        })
        .finally(() => setSubmitting(false));
      return;
    }
    createCron(server, {
      ...(name.trim() ? { name: name.trim() } : {}),
      schedule,
      target: { kind: "role", role: "operator" },
      payload: payload.trim(),
      deliver,
    })
      .then(onClose)
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : "Create failed");
      })
      .finally(() => setSubmitting(false));
  }

  const kindButton = (k: ScheduleKind, label: string) => (
    <button
      type="button"
      onClick={() => setKind(k)}
      aria-pressed={kind === k}
      className={controlClass({
        variant: "toggle",
        base: "px-2 py-1 border rounded text-xs transition-colors",
        pressed: kind === k,
      })}
    >
      {label}
    </button>
  );

  const deliverButton = (d: Deliver, label: string) => (
    <button
      type="button"
      onClick={() => setDeliver(d)}
      aria-pressed={deliver === d}
      className={controlClass({
        variant: "toggle",
        base: "px-2 py-1 border rounded text-xs transition-colors",
        pressed: deliver === d,
      })}
    >
      {label}
    </button>
  );

  const ifAbsentButton = (v: IfAbsent, label: string) => (
    <button
      type="button"
      onClick={() => setIfAbsent(v)}
      aria-pressed={ifAbsent === v}
      className={controlClass({
        variant: "toggle",
        base: "px-2 py-1 border rounded text-xs transition-colors",
        pressed: ifAbsent === v,
      })}
    >
      {label}
    </button>
  );

  return (
    <Dialog title={editing ? "Edit entry" : "New cron entry"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {editing && entry && (
          <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-text-secondary">Target</span>
              <span className="text-text-primary" data-testid="cron-edit-target">
                {targetChip(entry)}
              </span>
            </div>
            <div className="text-xs">
              <span className="text-text-secondary">Payload</span>
              <p
                className="mt-1 whitespace-pre-wrap text-text-primary"
                data-testid="cron-edit-payload"
              >
                {isLoopEntry(entry) ? "—" : entry.payload}
              </p>
            </div>
            {(entry.muted === true || entry.pinned === true) && (
              <div className="text-xs text-text-secondary" data-testid="cron-edit-flags">
                {entry.muted === true ? "muted" : ""}
                {entry.muted === true && entry.pinned === true ? " · " : ""}
                {entry.pinned === true ? "pinned" : ""}
              </div>
            )}
          </>
        )}
        {!editing && (
          <input
            ref={firstFieldRef}
            type="text"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            aria-label="Payload"
            placeholder="payload — the prompt the entry delivers"
            className={inputClass}
          />
        )}
        <input
          ref={editing ? firstFieldRef : undefined}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          aria-label="Name"
          placeholder="name (optional)"
          className={inputClass}
        />
        <div className="flex gap-1.5" role="group" aria-label="Schedule kind">
          {kindButton("every", "Every")}
          {kindButton("backoff", "Backoff")}
          {kindButton("cron", "Cron")}
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Delivery">
          {deliverButton("immediate", "Immediate")}
          {deliverButton("when-idle", "When idle")}
          {deliverButton("skip-if-busy", "Skip if busy")}
        </div>
        {editing && (
          <div className="flex gap-1.5" role="group" aria-label="If absent">
            {ifAbsentButton("skip", "Skip")}
            {ifAbsentButton("notify", "Notify")}
            {ifAbsentButton("respawn", "Respawn")}
          </div>
        )}
        {editing && ifAbsent === "respawn" && (
          <input
            type="text"
            value={respawn}
            onChange={(e) => setRespawn(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            aria-label="Respawn argv"
            placeholder='argv — e.g. "rk operator"'
            className={inputClass}
          />
        )}
        {kind === "every" && (
          <input
            type="text"
            value={interval}
            onChange={(e) => setInterval_(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            aria-label="Interval"
            placeholder='interval — e.g. "1h"'
            className={inputClass}
          />
        )}
        {kind === "backoff" && (
          <div className="flex gap-2">
            <input
              type="text"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              aria-label="Backoff minimum"
              placeholder='min — e.g. "60s"'
              className={inputClass}
            />
            <input
              type="text"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              aria-label="Backoff maximum"
              placeholder='max — e.g. "30m"'
              className={inputClass}
            />
          </div>
        )}
        {kind === "cron" && (
          <input
            type="text"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            aria-label="Cron expression"
            placeholder='expression — e.g. "0 * * * *"'
            className={inputClass}
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-signal-red">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full ${controlClass({ variant: "wide", disabled: !canSubmit })}`}
        >
          {editing ? "Save" : "Create entry"}
        </button>
      </div>
    </Dialog>
  );
}
