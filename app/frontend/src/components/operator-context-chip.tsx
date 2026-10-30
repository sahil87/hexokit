import { dismissOperatorChatChip, useOperatorChatChip } from "@/lib/quake-terminal";

/**
 * The chat-lane context chip — renders the attached chat subject beside
 * whichever compose surface is active: the quake terminal's docked compose
 * strip and the operator route's compose strip both mount one, reading the
 * ONE chat-subject store in lib/quake-terminal.ts so the two stay in
 * lockstep. Implicit context the
 * user cannot see erodes trust in what the operator was told, so the chip is
 * always visible while a send would attach the envelope, and its ✕ detaches it
 * (sends then ride the direct lane until the quake terminal re-engages or the subject
 * changes — the store owns both resets).
 *
 * `server` is the caller's resolved quake terminal server: a subject stamped for a
 * different server renders nothing (window ids are server-scoped, and
 * sendOperatorMessage applies the same guard at send time).
 *
 * With `onNavigate` provided (the operator route's compose-strip mount), the
 * label itself is a control that returns to the subject window — the chip
 * names exactly where the user came from, so it doubles as the way back. The
 * ✕ stays dismiss-only either way; the docked compose strip's mount passes
 * nothing and keeps an inert label.
 */
export function OperatorContextChip({
  server,
  compact = false,
  onNavigate,
}: {
  server: string | null;
  /** Cap the chip's width (the quake launcher's slim box); the compose strip has room. */
  compact?: boolean;
  /** When set, tapping the label navigates back to the subject window. */
  onNavigate?: () => void;
}) {
  const { subject, dismissed } = useOperatorChatChip();
  if (!server || !subject || dismissed || subject.server !== server) return null;
  const labelText = `from: ${subject.windowId}${subject.name ? ` "${subject.name}"` : ""}`;
  return (
    <span
      data-testid="quake-terminal-context"
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary ${
        compact ? "max-w-[14ch]" : ""
      }`}
    >
      {onNavigate ? (
        <button
          type="button"
          aria-label={`Back to ${subject.windowId}${subject.name ? ` "${subject.name}"` : ""}`}
          onClick={onNavigate}
          className="min-w-0 truncate text-left transition-colors hover:text-text-primary coarse:min-h-[36px]"
        >
          {labelText}
        </button>
      ) : (
        <span className="truncate">{labelText}</span>
      )}
      <button
        type="button"
        aria-label="Detach tab context"
        onClick={dismissOperatorChatChip}
        className={`shrink-0 px-0.5 inline-flex items-center justify-center text-text-secondary transition-colors hover:text-text-primary coarse:min-w-[40px] coarse:min-h-[40px] ${
          // The compact mount (the docked compose strip's header row) drops
          // the 24px fine floor to fit the row's height budget; the full-size
          // compose-strip mount keeps the standard floor. The coarse (touch)
          // floor is untouched either way.
          compact ? "" : "min-w-[24px] min-h-[24px]"
        }`}
      >
        ✕
      </button>
    </span>
  );
}
