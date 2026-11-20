import { useCallback, useEffect, useRef, useState } from "react";
import { postOperatorNote, postOperatorWake } from "@/api/client";
import { Control } from "@/components/control";
import { INPUT_COARSE, INPUT_FOCUS } from "@/components/controls";

/** Wake reason prefix: the trigger door logs a composer write as
 *  `trigger:note:<item id>`. */
export const NOTE_WAKE_REASON_PREFIX = "note:";

/** Longest note, in runes — lockstep with the backend's `operator.NoteTextCap`. */
const NOTE_TEXT_CAP = 1000;
/** The length counter appears once the draft is within this many runes of the cap. */
const NOTE_COUNTER_THRESHOLD = NOTE_TEXT_CAP - 100;
const MAX_ROWS = 5;
/** How long a transient save status stays up. */
const STATUS_MS = 4000;

export const NOTE_SAVED_QUEUED = "note saved · check queued";
export const NOTE_SAVED_DEFERRED = "note saved · the next check will pick it up";

/** A transient status line: `show` sets it, a single timeout clears it. */
export function useTransientStatus(): [string | null, (text: string) => void] {
  const [status, setStatus] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setStatus(text);
    timer.current = setTimeout(() => setStatus(null), STATUS_MS);
  }, []);
  return [status, show];
}

/**
 * The inline composer for one tracked item's `by: user` note. A successful
 * write is followed by a wake (`note:<id>`) so the next cron tick runs a check;
 * the note is itself a check condition, so a failed wake only delays pickup and
 * is reported, never an error. A failed write keeps the composer open with the
 * draft and the server's message. The caller owns the transient status:
 * `onSaved` receives the status line to show, `onCancel` closes without one.
 */
export function OperatorNoteComposer({
  server,
  itemId,
  onSaved,
  onCancel,
}: {
  server: string;
  itemId: string;
  onSaved: (status: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Focus on open, and again when a failed write re-enables the textarea.
  useEffect(() => {
    if (!pending) areaRef.current?.focus();
  }, [pending]);

  const canSubmit = text.trim() !== "" && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await postOperatorNote(server, itemId, text);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : "failed to save note");
      return;
    }
    const woke = await postOperatorWake(server, `${NOTE_WAKE_REASON_PREFIX}${itemId}`).then(
      () => true,
      () => false,
    );
    onSaved(woke ? NOTE_SAVED_QUEUED : NOTE_SAVED_DEFERRED);
  };

  const runes = [...text].length;
  const rows = Math.min(MAX_ROWS, text.split("\n").length);

  return (
    <form
      data-testid="operator-note-composer"
      className="flex flex-col gap-1 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={areaRef}
        aria-label={`Note for ${itemId}`}
        data-testid="operator-note-input"
        value={text}
        rows={rows}
        disabled={pending}
        placeholder="note…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        className={`w-full resize-none bg-transparent text-text-primary text-xs font-mono p-1.5 border border-border rounded ${INPUT_FOCUS} ${INPUT_COARSE} placeholder:text-text-secondary`}
      />
      {error !== null && (
        <div role="alert" data-testid="operator-note-error" className="text-xs text-signal-red">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Control
          variant="wide"
          type="submit"
          disabled={!canSubmit}
          data-testid="operator-note-save"
          className="px-3 text-xs"
        >
          Save
        </Control>
        <Control
          variant="wide"
          type="button"
          disabled={pending}
          data-testid="operator-note-cancel"
          onClick={onCancel}
          className="px-3 text-xs"
        >
          Cancel
        </Control>
        {runes >= NOTE_COUNTER_THRESHOLD && (
          <span
            data-testid="operator-note-counter"
            className={`ml-auto text-xs font-mono ${runes > NOTE_TEXT_CAP ? "text-signal-red" : "text-text-secondary"}`}
          >
            {runes}/{NOTE_TEXT_CAP}
          </span>
        )}
      </div>
    </form>
  );
}
