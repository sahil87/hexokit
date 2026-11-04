/**
 * Overlay presence — the SPA's single "an occluding overlay is open" signal.
 *
 * A native web view (the desktop shell's `WebContentsView`) is composited
 * above the SPA's DOM, so nothing the SPA draws can appear over it. A surface
 * that cannot be painted over reads this registry to hide itself while an
 * occluding overlay is open. The signal is a COUNT of mounted occluding
 * overlays, never a focus read: focus is stolen by iframes and native views
 * exactly when the signal is needed, and nested modals (a create dialog over
 * a detail sheet, a confirm inside the quake drawer) need a count to stay
 * correct until the last one closes.
 *
 * Module-level state on purpose — the palette, dialogs, drawer and toast
 * trees mount independently with no shared provider, and the engine's bridge
 * effect subscribes from outside React. The module imports no React and
 * touches no DOM, `window`, or storage, so it is importable anywhere.
 *
 * Kinds: `modal` (palette, dialogs, quake drawer, screen-break egg, mobile
 * drawer) and `transient` (click-opened menus, dropdowns, popovers, context
 * menus) BOTH feed the native surface's hide signal — `isOccludingOpen()`
 * reads modal + transient. The registration rule: a click-opened menu,
 * dropdown, popover or context menu registers `transient` while open;
 * tooltips (`tip.tsx`) and hover-opened flyout cards register NOTHING —
 * hiding the native view on every hover would flicker the page.
 */

export type OverlayKind = "modal" | "transient";

const counts: Record<OverlayKind, number> = { modal: 0, transient: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  // Snapshot: a listener may unsubscribe (or subscribe) while being notified.
  for (const listener of Array.from(listeners)) listener();
}

/** Register an open occluding overlay of `kind`; returns its release. The
 *  release is idempotent — a second call is a no-op, so StrictMode effect
 *  replays and defensive double-cleanup never drive the count negative. */
export function acquire(kind: OverlayKind): () => void {
  counts[kind] += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counts[kind] = Math.max(0, counts[kind] - 1);
    notify();
  };
}

/** Open overlays of `kind`, or across all kinds when omitted. */
export function count(kind?: OverlayKind): number {
  if (kind) return counts[kind];
  return counts.modal + counts.transient;
}

/** The hide signal a native surface reads: true while any modal-class
 *  overlay is open. A held `transient` alone leaves it false. */
export function isModalOpen(): boolean {
  return counts.modal > 0;
}

/** The native surface's full hide signal: true while any occluding overlay
 *  is open — modal-class surfaces AND click-opened menus/popovers
 *  (`transient`). Anything composited above the DOM (the desktop shell's
 *  `WebContentsView`) hides on this, since a menu would paint underneath it
 *  exactly like a dialog. */
export function isOccludingOpen(): boolean {
  return counts.modal + counts.transient > 0;
}

/** Notified synchronously after every count change (acquire or effective
 *  release), with no payload — readers call `count`/`isModalOpen`. Returns
 *  the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — zero every count and drop every listener. */
export function _resetForTests(): void {
  counts.modal = 0;
  counts.transient = 0;
  listeners.clear();
}
