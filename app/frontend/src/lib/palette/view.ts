/**
 * Pure builder for the command-palette window-view lens actions (`View: Web` /
 * `View: Terminal` / `View: Code`). Extracted from app.tsx so
 * the visibility gating (available AND not-current) and label composition are
 * unit-testable without mounting the whole shell — mirroring lib/palette/move.ts
 * / lib/palette/update.ts. The action bodies are thin `onSelect` wrappers passed
 * in by the caller (they call `switchView(v)`).
 *
 * Constitution V palette parity: the palette is the ONLY desktop lens-switch
 * surface — no chord reaches a single-tile lens switch (the ⌘1/⌘2/⌘3 digits
 * are TILE toggles, a different action), so every entry carries an empty
 * `shortcut`. Each lens is offered only when it is AVAILABLE for the current
 * window AND is not the current view, so the palette shows the destination,
 * never the current lens.
 */
import type { ViewName } from "../window-view";

export type ViewPaletteAction = {
  id: string;
  label: string;
  shortcut: string;
  onSelect: () => void;
};

/** Human label for a view's palette entry. */
const VIEW_ACTION_LABEL: Record<ViewName, string> = {
  tty: "View: Terminal",
  web: "View: Web",
  code: "View: Code",
  gui: "View: GUI",
};

/**
 * Build the view-switch palette actions. Returns one action per view that is
 * available AND is not the current (`resolved`) view. A single-view window
 * (only `tty` available) yields an empty array — there is nothing to switch to.
 */
export function buildViewActions(
  available: ViewName[],
  resolved: ViewName,
  onSwitch: (view: ViewName) => void,
): ViewPaletteAction[] {
  return available
    .filter((v) => v !== resolved)
    .map((v) => ({
      id: `view-${v}`,
      label: VIEW_ACTION_LABEL[v],
      shortcut: "",
      onSelect: () => onSwitch(v),
    }));
}
