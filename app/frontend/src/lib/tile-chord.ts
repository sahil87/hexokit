/**
 * The stateful tile-chord state machine (260819-qwr7 R4): ⌘1/⌘2/⌘3
 * (⇧Ctrl+digit on Win/Linux) apply the three-state rule against the CURRENT
 * render layout and focused tile kind:
 *
 * - hidden (kind not in the order) → open via `togglePanel` and focus once the
 *   layout lands (`setLanding` arms the per-kind landing flag consumed by the
 *   layout-keyed effect in app.tsx);
 * - visible, not focused → focus via `focusTile` (the `layoutFocusTileRef`
 *   seam — the same path the palette `Tile: Focus <Surface>` entries use);
 * - focused → hide via `togglePanel` then `restoreAfterHide` (the restore
 *   router) so focus never strands.
 *
 * Gating (no handler mounts — the chord falls through untouched instead of
 * preventDefault-ing into a dead action, dispatcher rule 3): no window route
 * param, mobile viewport, a surface the window cannot tile (`availableTiles`),
 * or the one-tile hide (the palette's `Tile: Hide` omission on `single`
 * layouts).
 *
 * Recording constraint: the handler writes NO focus memory itself — the tty
 * focus arm records `tty` only via the seam's own `recordTtySlot`; the
 * code/web arms record NOTHING (the steal-guard recording asymmetry — only
 * in-frame `onInteract` records `code`).
 */

import type { SurfaceKind } from "@/lib/surface-layout";

export type TileChordSeams = {
  /** The chord's surface. */
  kind: SurfaceKind;
  /** The window route param — the chords are window-route-only. */
  windowParam: string | undefined;
  isMobile: boolean;
  /** The surfaces the current window can tile. */
  panelSurfaces: readonly SurfaceKind[];
  /** The CURRENT render layout's leaf kinds (the caller reads `leaves(tree)`). */
  order: readonly SurfaceKind[];
  focusedTileKind: SurfaceKind;
  /** Open/close a tile; returns whether the layout mutation applied. */
  togglePanel: (kind: SurfaceKind) => boolean;
  /** Focus-by-kind seam (`layoutFocusTileRef`). */
  focusTile: (kind: SurfaceKind) => void;
  /** Arm the per-kind focus-on-landing flag for an APPLIED open. */
  setLanding: (kind: SurfaceKind) => void;
  /** Return focus through the restore router after an APPLIED hide. */
  restoreAfterHide: (kind: SurfaceKind) => void;
};

export function tileChordHandler(seams: TileChordSeams): (() => void) | undefined {
  const { kind } = seams;
  const gatedOut =
    seams.windowParam == null ||
    seams.isMobile ||
    !seams.panelSurfaces.includes(kind) ||
    seams.order.length === 1 && seams.order.includes(kind);
  if (gatedOut) return undefined;
  return () => {
    if (!seams.order.includes(kind)) {
      // Flag only an APPLIED open: a full 3-tile layout refuses the add (null
      // no-op), and a stuck flag would auto-focus the kind whenever a later
      // unrelated action opens it (the focus-hop precedent).
      if (seams.togglePanel(kind)) seams.setLanding(kind);
      return;
    }
    if (seams.focusedTileKind !== kind) {
      seams.focusTile(kind);
      return;
    }
    // Race guard for the render gap before the one-tile gate above re-mounts
    // no handler.
    if (seams.order.length <= 1) return;
    if (seams.togglePanel(kind)) seams.restoreAfterHide(kind);
  };
}
