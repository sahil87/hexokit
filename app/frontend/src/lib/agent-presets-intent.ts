/**
 * The palette's way into the Presets section. A palette entry opens the
 * Agents tab and records what to do once the section exists: focus the list,
 * open the New form, or open Duplicate / Rename / Delete for a named preset.
 * The section takes the intent on mount, and live while it is already open.
 * Nothing here writes — the section's own forms and confirm do.
 */
export type PresetsIntent =
  | { action: "focus" }
  | { action: "new" }
  | { action: "duplicate" | "rename" | "delete"; name: string };

// An intent the section never took (fab cannot list presets, the dialog was
// closed first) must not fire at some later open.
const INTENT_TTL_MS = 10_000;

let pending: { intent: PresetsIntent; at: number } | null = null;
const listeners = new Set<() => void>();

export function requestPresetsIntent(intent: PresetsIntent): void {
  pending = { intent, at: Date.now() };
  for (const l of [...listeners]) l();
}

/** The recorded intent, cleared on read. */
export function takePresetsIntent(): PresetsIntent | null {
  const taken = pending;
  pending = null;
  return taken !== null && Date.now() - taken.at < INTENT_TTL_MS ? taken.intent : null;
}

/** Called after an intent is requested; returns an unsubscribe. */
export function onPresetsIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function resetPresetsIntent(): void {
  pending = null;
  listeners.clear();
}
