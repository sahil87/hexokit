/**
 * Pure builder for the web-engine palette toggle (`Web: Use embedded
 * browser`) — the per-viewer opt-out from the native web engine back to the
 * iframe engine (Constitution V). Follows the lib/palette/shell.ts
 * pure-builder convention: availability gating and label composition are
 * unit-testable without mounting the shell.
 *
 * The entry exists ONLY when the shell offers the `web` bridge group — the
 * caller feeds `canShellWeb()` as `available`, the bridge group's own
 * presence (the truthful signal — the `canNewShellWindow()` precedent), not
 * `isShell()`. It is not gated on a web tile being open: a viewer may
 * pre-toggle. The label carries a trailing ` ✓` while the native engine is
 * selected (the `Notifications: Enabled ✓` checkbox-label precedent).
 */
import type { PaletteAction } from "@/components/command-palette";

export const WEB_NATIVE_ENGINE_ACTION_ID = "web-native-engine";

/** The per-viewer engine toggle; `[]` when the shell offers no `web` group. */
export function buildWebEngineActions(input: {
  available: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}): PaletteAction[] {
  if (!input.available) return [];
  return [
    {
      id: WEB_NATIVE_ENGINE_ACTION_ID,
      label: `Web: Use embedded browser${input.enabled ? " ✓" : ""}`,
      onSelect: () => input.onToggle(!input.enabled),
    },
  ];
}

export const WEB_INSPECT_ACTION_ID = "web-inspect";

/**
 * `Web: Inspect page` — open DevTools on the active web tab (the native
 * engine's detached-window capability) — the keyboard path for the web tile
 * URL bar's Inspect button; no chord (the palette IS the keyboard path). The caller feeds `available` from
 * the engine selection rule AND web content (`hasWebUrl`) — the entry is
 * absent on the iframe engine and on an onboarding tile. `onSelect`
 * dispatches the document event the mounted web tile listens for.
 */
export function buildWebInspectActions(input: {
  available: boolean;
  onSelect: () => void;
}): PaletteAction[] {
  if (!input.available) return [];
  return [{ id: WEB_INSPECT_ACTION_ID, label: "Web: Inspect page", onSelect: input.onSelect }];
}
