import { useState } from "react";
import { Control } from "@/components/control";
import { OperatorNoteComposer } from "@/components/operator-note-composer";
import type { NeedsYouRow } from "@/components/server-watched-zone/model";

/**
 * The Tasks segment's "Needs you" band: one row per open escalation or waiting
 * prompt, each with the item id, the one wanted action, and `open pane` (when a
 * live window resolves) / `note…` (the inline composer, in place under the
 * row). A pure projection of `collectNeedsYou` rows — it renders nothing when
 * there are none, and a row clears when the next sessions payload no longer
 * derives it. `onSaved` receives the composer's status line; the host shows it
 * so it outlives the row the note just cleared.
 */
export function NeedsYouBand({
  rows,
  server,
  onNavigate,
  onSaved,
}: {
  rows: NeedsYouRow[];
  server: string;
  onNavigate: (windowId: string) => void;
  onSaved: (status: string) => void;
}) {
  const [composingId, setComposingId] = useState<string | null>(null);
  if (rows.length === 0) return null;

  return (
    <section
      className="shrink-0 max-h-[45%] overflow-y-auto border-b border-border px-3 py-2"
      aria-label="Needs you"
      data-testid="needs-you-band"
    >
      <h3 className="text-xs font-mono text-signal-yellow">Needs you · {rows.length}</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="needs-you-row"
            data-item-id={row.id}
            data-kind={row.kind}
            className="text-xs font-mono"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-text-primary">{row.id}</span>
              <span className="min-w-0 flex-1 break-words text-text-secondary">{row.action}</span>
              {row.windowId !== undefined && (
                <Control
                  variant="wide"
                  data-testid="needs-you-open-pane"
                  className="px-2 text-xs"
                  onClick={() => row.windowId !== undefined && onNavigate(row.windowId)}
                >
                  open pane
                </Control>
              )}
              {server !== "" && (
                <Control
                  variant="wide"
                  data-testid="needs-you-note"
                  aria-expanded={composingId === row.id}
                  className="px-2 text-xs"
                  onClick={() => setComposingId(composingId === row.id ? null : row.id)}
                >
                  note…
                </Control>
              )}
            </div>
            {composingId === row.id && (
              <OperatorNoteComposer
                server={server}
                itemId={row.id}
                onCancel={() => setComposingId(null)}
                onSaved={(status) => {
                  setComposingId(null);
                  onSaved(status);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
