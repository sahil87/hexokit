import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useOccludes } from "@/hooks/use-occludes";
import { controlClass } from "@/components/control";
import {
  SWITCH_KNOB_OFF,
  SWITCH_KNOB_ON,
  SWITCH_TRACK_OFF,
  SWITCH_TRACK_ON,
} from "@/components/controls";
import { deleteCron, muteCron, pinCron, type CronDelivery, type CronEntry } from "@/api/client";
import { copyToClipboard } from "@/lib/clipboard";
import { describeDeliver, describeSchedule } from "@/lib/cron-schedule";
import { formatDuration } from "@/lib/format";
import { CronCreateDialog } from "@/components/cron-create-dialog";

/** The `Mute for…` preset choices; `undefined` = no lease (until unmuted). */
const MUTE_FOR_PRESETS: { label: string; forDuration?: string }[] = [
  { label: "30m", forDuration: "30m" },
  { label: "2h", forDuration: "2h" },
  { label: "8h", forDuration: "8h" },
  { label: "until unmuted" },
];

/** "3m ago" for a unix-seconds timestamp. Render-time only — the
 *  SSE-cadence refetch is the clock (the recovery-section precedent: no
 *  ticking timer). */
function agoLabel(ts: number, nowMs: number): string {
  const elapsed = Math.max(0, Math.floor(nowMs / 1000 - ts));
  return `${formatDuration(elapsed)} ago`;
}

/** "in 5m" for a unix-seconds timestamp; a past-due fire reads "due". */
function inLabel(ts: number, nowMs: number): string {
  const delta = Math.floor(ts - nowMs / 1000);
  return delta > 0 ? `in ${formatDuration(delta)}` : "due";
}

/** One labelled, copyable value (a run id or a file path). The value is
 *  selectable text — `select-all` lets one tap/click select it for a manual
 *  copy — and the Copy button writes it to the clipboard. */
function CopyableRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyToClipboard(value).then((ok) => setCopied(ok));
  };
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-primary">{label}</div>
        <code
          className="mt-0.5 block select-all break-all text-xs text-text-secondary"
          data-testid={testId}
        >
          {value}
        </code>
      </div>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={copy}
        className="rk-glint shrink-0 rounded px-1 text-xs text-text-secondary transition-colors hover:text-text-primary coarse:min-h-[36px]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The track visual for a bool row — the shared switch color recipe around
 *  this sheet's own geometry (per the controls.ts contract). */
function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative block w-8 h-[18px] shrink-0 rounded-full border transition-colors ${
        on ? SWITCH_TRACK_ON : SWITCH_TRACK_OFF
      }`}
    >
      <span
        className={`absolute top-[2px] block w-3 h-3 rounded-full transition-all ${
          on ? `left-[16px] ${SWITCH_KNOB_ON}` : `left-[2px] ${SWITCH_KNOB_OFF}`
        }`}
      />
    </span>
  );
}

/**
 * The cron entry detail sheet — the mobile action surface for one entry (the
 * spec's "alarm-app anatomy": name, schedule in plain words, last/next, a
 * first-class mute switch, pin and delete rows). No Sheet/BottomSheet
 * primitive exists in the codebase; this is a bottom-anchored overlay panel
 * riding the Dialog idioms (backdrop tap + Escape close via the focus trap,
 * settings-dialog row/toggle markup, kill-confirm two-step for delete).
 *
 * Mute/pin reflect OPTIMISTICALLY: the row overrides the prop value until the
 * next SSE-driven refetch confirms it (every mutation wakes the hub
 * server-side), then the override clears; a failure reverts to the prop and
 * surfaces the error inline.
 *
 * The `inline` variant is the same sheet without the modal shell: no fixed
 * full-viewport backdrop and no `aria-modal` — the panel fills its parent's
 * relative container (`absolute inset-0`, the desktop quake terminal drawer's cron
 * tabs mount it this way) and its header leads with a `‹ Back` control in
 * place of the ✕. Rows are identical in both variants.
 *
 * The Edit row opens CronCreateDialog's edit mode as a nested modal (the
 * sheet's focus trap stands down while it is open).
 */
export function CronEntryDetailSheet({
  server,
  entry,
  onClose,
  inline = false,
  delivery,
}: {
  server: string;
  entry: CronEntry;
  onClose: () => void;
  inline?: boolean;
  /** The delivery-log line the sheet was opened from (Cron Log). When it
   *  carries a `run`, the sheet shows that run's id, outcome and log paths. */
  delivery?: CronDelivery;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, true, onClose);
  // Only the modal shell occludes the stage; the inline variant sits inside
  // a container (the quake drawer) that registers itself.
  useOccludes("modal", !inline);

  const [mutedOverride, setMutedOverride] = useState<boolean | null>(null);
  const [pinnedOverride, setPinnedOverride] = useState<boolean | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [muteForOpen, setMuteForOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  const entryMuted = entry.muted === true;
  const entryPinned = entry.pinned === true;
  // Reconcile: once a refetch's entry carries the optimistic value, the
  // override has nothing left to say.
  useEffect(() => {
    if (mutedOverride !== null && entryMuted === mutedOverride) setMutedOverride(null);
  }, [entryMuted, mutedOverride]);
  useEffect(() => {
    if (pinnedOverride !== null && entryPinned === pinnedOverride) setPinnedOverride(null);
  }, [entryPinned, pinnedOverride]);

  const muted = mutedOverride ?? entryMuted;
  const pinned = pinnedOverride ?? entryPinned;

  const setMutedState = (next: boolean, forDuration?: string) => {
    setError("");
    setMutedOverride(next);
    muteCron(server, entry.id, next, forDuration).catch((err: unknown) => {
      setMutedOverride(null);
      setError(err instanceof Error && err.message ? err.message : "Mute failed");
    });
  };
  const toggleMute = () => {
    setMuteForOpen(false);
    setMutedState(!muted);
  };
  const togglePin = () => {
    const next = !pinned;
    setError("");
    setPinnedOverride(next);
    pinCron(server, entry.id, next).catch((err: unknown) => {
      setPinnedOverride(null);
      setError(err instanceof Error && err.message ? err.message : "Pin failed");
    });
  };
  const confirmDelete = () => {
    if (deleting) return;
    setDeleting(true);
    setError("");
    deleteCron(server, entry.id)
      .then(onClose)
      .catch((err: unknown) => {
        setError(err instanceof Error && err.message ? err.message : "Delete failed");
      })
      .finally(() => setDeleting(false));
  };

  const nowMs = Date.now();
  const title = entry.name || entry.id;

  const rowClass = "flex items-center justify-between gap-4 px-3 py-2.5";
  const labelClass = "text-xs text-text-primary";
  const valueClass = "text-xs text-text-secondary text-right";

  const content = (
    <>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {inline && (
          <button
            type="button"
            aria-label="Back"
            onClick={onClose}
            className="rk-glint inline-flex shrink-0 items-center rounded px-1 text-text-secondary transition-colors hover:text-text-primary coarse:min-h-[36px]"
          >
            ‹ Back
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
          {title}
        </h2>
        {!inline && (
          <button
            type="button"
            aria-label="Close entry details"
            onClick={onClose}
            className="rk-glint ml-auto inline-flex shrink-0 items-center justify-center rounded px-1 text-text-secondary transition-colors hover:text-text-primary coarse:min-h-[36px] coarse:min-w-[36px]"
          >
            ✕
          </button>
        )}
      </div>
      <p className="px-3 pb-2 text-xs text-text-secondary">{describeSchedule(entry)}</p>
      {delivery?.run && (
        <div className="border-t border-border" data-testid="cron-entry-run">
          <CopyableRow label="Run" value={delivery.run} testId="cron-entry-run-id" />
          <CopyableRow label="Outcome" value={delivery.outcome} testId="cron-entry-run-outcome" />
          {delivery.runLog && (
            <CopyableRow label="Run log" value={delivery.runLog} testId="cron-entry-run-log" />
          )}
          {delivery.transcript && (
            <CopyableRow label="Transcript" value={delivery.transcript} testId="cron-entry-run-transcript" />
          )}
        </div>
      )}
      <div className="border-t border-border">
        <div className={rowClass}>
          <span className={labelClass}>Last fired</span>
          <span className={valueClass} data-testid="cron-entry-last-fired">
            {entry.lastFired > 0 ? agoLabel(entry.lastFired, nowMs) : "never"}
          </span>
        </div>
        <div className={`${rowClass} border-t border-border`}>
          <span className={labelClass}>Next fire</span>
          <span className={valueClass} data-testid="cron-entry-next-fire">
            {entry.nextFire !== undefined ? inLabel(entry.nextFire, nowMs) : "unknown"}
          </span>
        </div>
        <div className={`${rowClass} border-t border-border`}>
          <span className={labelClass}>Deliver</span>
          <span className={valueClass} data-testid="cron-entry-deliver">
            {describeDeliver(entry.deliver)}
          </span>
        </div>
        {/* The whole row is the switch hit target — the phone affordance. */}
        <button
          type="button"
          role="switch"
          aria-checked={muted}
          aria-label="Mute entry"
          onClick={toggleMute}
          className={`${rowClass} w-full border-t border-border text-left coarse:min-h-[44px]`}
        >
          <span className={labelClass}>Mute</span>
          <SwitchTrack on={muted} />
        </button>
        {/* The lease arm — presets POST mute with the additive `for` field;
            `until unmuted` and unmute carry no `for`. Hidden while muted (the
            switch is the unmute path then). */}
        {!muted && (
          <div className="border-t border-border px-3 py-2.5">
            <button
              type="button"
              aria-expanded={muteForOpen}
              onClick={() => setMuteForOpen((v) => !v)}
              className="w-full text-left text-xs text-text-primary coarse:min-h-[44px]"
            >
              Mute for…
            </button>
            {muteForOpen && (
              <div className="flex flex-wrap gap-1.5 pt-1.5" role="group" aria-label="Mute duration">
                {MUTE_FOR_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setMuteForOpen(false);
                      setMutedState(true, preset.forDuration);
                    }}
                    className={controlClass({
                      variant: "toggle",
                      base: "px-2 py-1 border rounded text-xs transition-colors",
                    })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={pinned}
          aria-label="Pin entry"
          onClick={togglePin}
          className={`${rowClass} w-full border-t border-border text-left coarse:min-h-[44px]`}
        >
          <span className={labelClass}>Pin</span>
          <SwitchTrack on={pinned} />
        </button>
        <div className="border-t border-border px-3 py-2.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-full text-left text-xs text-text-primary coarse:min-h-[44px]"
          >
            Edit
          </button>
        </div>
        <div className="border-t border-border px-3 py-2.5">
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-text-secondary">Delete this entry?</span>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className={controlClass({ variant: "confirm" })}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className={controlClass({ variant: "confirm", danger: true })}
              >
                Delete
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="w-full text-left text-xs text-signal-red coarse:min-h-[44px]"
            >
              Delete entry
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-signal-red">
          {error}
        </p>
      )}
      {editing && (
        <CronCreateDialog server={server} entry={entry} onClose={() => setEditing(false)} />
      )}
    </>
  );

  if (inline) {
    return (
      <div
        ref={sheetRef}
        role="dialog"
        aria-label={`Cron entry ${title}`}
        data-testid="cron-entry-sheet"
        className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-bg-primary text-[11px]"
      >
        {content}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40" data-testid="cron-entry-sheet">
      <div
        className="fixed inset-0 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Cron entry ${title}`}
        className="absolute bottom-0 left-0 right-0 sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 max-h-[80vh] overflow-y-auto rounded-t-lg border border-b-0 border-border bg-bg-primary text-[11px] shadow-2xl"
      >
        {content}
      </div>
    </div>
  );
}
