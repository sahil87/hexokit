/**
 * Bounded optimistic overlay for a UI-initiated window switch.
 *
 * tmux owns which window a home-tab terminal shows; the URL is a projection of
 * the SSE-derived active window. A UI switch is a `selectWindow` request that
 * holds the URL on the clicked window only until tmux's truth catches up. The
 * overlay therefore always ends — it never waits on terminal bytes:
 *
 * - `confirm`: a session snapshot reports the overlay's window active.
 * - `post-settle-snapshot`: the POST resolved 200 and a snapshot NEWER than the
 *   one held at settle arrived, whatever window it reports. At settle the client
 *   still holds the pre-select snapshot (tmux's own event-driven derive lands
 *   later), so ending at settle would bounce every click.
 * - `post-mismatch`: the 200 itself reported a different active window.
 * - `rejected`: the POST rejected or returned non-2xx.
 * - `deadline`: `CONFIRMATION_WINDOW_MS` elapsed (the POST has no client timeout).
 *
 * `@N` window ids are only unique per server, so identity is `{server,
 * windowId}`. Pure and framework-free: AppShell owns the state and timers.
 */

/** Hard cap on how long a switch overlay (and its paint mask) may live. */
export const CONFIRMATION_WINDOW_MS = 5000;

export interface SwitchOverlay {
  readonly server: string;
  readonly windowId: string;
  readonly seq: number;
  readonly post: "pending" | "ok";
  /** Snapshot token held when the POST settled 200; meaningful once `post === "ok"`. */
  readonly snapshotAtSettle: unknown;
}

export type OverlayEndReason =
  | "confirm"
  | "post-settle-snapshot"
  | "post-mismatch"
  | "rejected"
  | "deadline";

/** The next overlay (`null` once ended) plus why it ended, when it did. */
export interface OverlayTransition {
  readonly overlay: SwitchOverlay | null;
  readonly ended: OverlayEndReason | null;
}

export type SwitchPostOutcome =
  | { kind: "resolved"; resp: { ok: boolean; activeWindow?: string } }
  | { kind: "rejected" };

export function startOverlay(server: string, windowId: string, seq: number): SwitchOverlay {
  return { server, windowId, seq, post: "pending", snapshotAtSettle: undefined };
}

const keep = (overlay: SwitchOverlay): OverlayTransition => ({ overlay, ended: null });
const end = (reason: OverlayEndReason): OverlayTransition => ({ overlay: null, ended: reason });

/**
 * The `selectWindow` POST settled. A settlement for a superseded `seq` is a
 * no-op. A 200 whose `activeWindow` is absent (older daemon) counts as
 * confirming the select ran; the overlay then waits for the next snapshot.
 */
export function onPostSettled(
  overlay: SwitchOverlay,
  seq: number,
  outcome: SwitchPostOutcome,
  snapshotToken: unknown,
): OverlayTransition {
  if (overlay.seq !== seq) return keep(overlay);
  if (outcome.kind === "rejected" || !outcome.resp.ok) return end("rejected");
  const reported = outcome.resp.activeWindow;
  if (reported !== undefined && reported !== overlay.windowId) return end("post-mismatch");
  return keep({ ...overlay, post: "ok", snapshotAtSettle: snapshotToken });
}

/**
 * A session snapshot for `server` arrived. `snapshotToken` is the snapshot's
 * identity (a fresh object per received snapshot); `activeWindowId` is the
 * window it reports active.
 */
export function onSnapshot(
  overlay: SwitchOverlay,
  snapshot: { server: string; activeWindowId: string | undefined; token: unknown },
): OverlayTransition {
  if (snapshot.server !== overlay.server) return keep(overlay);
  if (snapshot.activeWindowId === overlay.windowId) return end("confirm");
  if (overlay.post === "ok" && snapshot.token !== overlay.snapshotAtSettle) {
    return end("post-settle-snapshot");
  }
  return keep(overlay);
}

/** The deadline timer fired. A superseded `seq` is a no-op. */
export function onDeadline(overlay: SwitchOverlay, seq: number): OverlayTransition {
  return overlay.seq === seq ? end("deadline") : keep(overlay);
}

/** Whether `overlay` holds the URL on exactly this `{server, windowId}`. */
export function overlayTargets(
  overlay: SwitchOverlay | null,
  server: string,
  windowId: string | undefined,
): boolean {
  return (
    overlay !== null &&
    windowId !== undefined &&
    overlay.server === server &&
    overlay.windowId === windowId
  );
}
