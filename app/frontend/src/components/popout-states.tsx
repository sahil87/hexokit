import { SURFACE_GLYPH, SURFACE_LABEL, type SurfaceKind } from "@/lib/surface-layout";

/**
 * The two popout STILL states (spec docs/specs/surface-layout.md § Verbs →
 * Pop out / Pop back in):
 *
 * - `PoppedOutPlaceholder` — the OPENER's render when every leaf of the
 *   layout is popped for this viewer (a layout never renders empty — the
 *   away-placeholder precedent): one row per popped leaf ("<Surface> is
 *   popped out" + a Pop back in button). The tiles stay mounted hidden
 *   behind it, so their streams survive.
 * - `PopoutEnded` — the POPOUT's render when its surface's window left the
 *   sessions payload (killed/closed): the surface unmounts, the window stays
 *   open showing the ended state, and nothing navigates.
 */

/** One popped leaf's row model: its surface label and, for a foreign leaf,
 *  the home window's display name. */
export interface PoppedLeafRow {
  leafId: string;
  kind: SurfaceKind;
  homeName?: string;
}

export function PoppedOutPlaceholder({
  leaves,
  onPopIn,
}: {
  leaves: PoppedLeafRow[];
  onPopIn: (leafId: string) => void;
}) {
  return (
    <div
      data-testid="popped-out-placeholder"
      className="flex-1 min-h-0 m-3 rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-2 font-mono text-[11px] text-text-secondary select-none"
    >
      {leaves.map(({ leafId, kind, homeName }) => (
        <span key={leafId} className="flex items-center gap-2">
          <span aria-hidden="true">{SURFACE_GLYPH[kind]}</span>
          <span>
            <span className="text-text-primary">
              {homeName !== undefined ? `${homeName} ${SURFACE_LABEL[kind]}` : SURFACE_LABEL[kind]}
            </span>{" "}
            is popped out
          </span>
          <button
            type="button"
            onClick={() => onPopIn(leafId)}
            aria-label={`Pop ${SURFACE_LABEL[kind]} back in`}
            className="rounded border border-accent-green px-2 py-0.5 text-accent-green transition-colors hover:bg-accent-green/10"
          >
            Pop back in
          </button>
        </span>
      ))}
    </div>
  );
}

export function PopoutEnded() {
  return (
    <div
      data-testid="popout-ended"
      className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 font-mono text-[11px] text-text-secondary select-none"
    >
      <span className="text-text-primary">Window closed</span>
      <span>this popout's window no longer exists — close this window</span>
    </div>
  );
}
