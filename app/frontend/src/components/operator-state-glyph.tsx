import { OPERATOR_STATE_DOT } from "@/lib/quake-terminal";

/**
 * The ◉ operator glyph carrying the resolved operator's live-state dot,
 * positioned bottom-right with a background-colored cutout ring:
 * `active` green, `waiting` amber, every other resolved state grey, no
 * operator no dot (`OPERATOR_STATE_DOT` in lib/quake-terminal.ts owns the
 * mapped colors). Shared by every surface that names the operator — the quake
 * launcher button and the docked compose strip's addressee label.
 */
export function OperatorStateGlyph({
  agentState,
  showDot = true,
  dotTestId = "quake-launcher-state",
}: {
  agentState: string | undefined;
  showDot?: boolean;
  /** The state dot's test id — each mount names its own surface. `null`
   *  omits it (an inert measurement copy must not duplicate the live id). */
  dotTestId?: string | null;
}) {
  return (
    <span aria-hidden="true" className="relative inline-flex shrink-0 text-xs text-text-secondary">
      ◉
      {showDot && agentState && (
        <span
          data-testid={dotTestId ?? undefined}
          data-state={agentState}
          className={`absolute -bottom-0.5 -right-0.5 block h-2 w-2 rounded-full border border-bg-primary ${
            OPERATOR_STATE_DOT[agentState] ?? "bg-text-secondary"
          }`}
        />
      )}
    </span>
  );
}
