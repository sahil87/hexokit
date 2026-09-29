import { useCallback, useEffect, useState } from "react";
import {
  MACROS_STORAGE_KEY,
  makeMacroActionId,
  readStoredMacros,
  writeStoredMacros,
  type MacroAction,
  type MacroTarget,
} from "@/lib/macros";
import { readStoredOverrides, writeStoredOverrides } from "@/lib/keybindings";

/**
 * Reactive macro store (260730-hbyh). Thin React integration over the pure
 * `lib/macros.ts` model: reads the per-device macro definitions from
 * `localStorage["hexokit-macros"]` and keeps every subscriber in sync — the
 * same in-module pub/sub + native `storage`-event pattern as
 * `use-keybindings.ts` (which composes this hook so macro bindings ride the
 * shared effective map).
 *
 * A macro's KEY COMBO is not stored here — it lives as an ordinary override
 * entry in `localStorage["hexokit-keybindings"]` keyed by the macro's actionId.
 * `removeMacro` therefore also drops that diff entry (no orphaned overrides;
 * a later same-slug macro must not inherit a ghost combo). `useKeybindings`
 * re-reads override storage whenever macros change, so the cleanup is visible
 * without a keybinding-store notification.
 */

const subscribers = new Set<(macros: MacroAction[]) => void>();

function persistMacros(macros: MacroAction[]): void {
  writeStoredMacros(macros);
  for (const listener of subscribers) listener(macros);
}

export type UseMacros = {
  /** The stored macro definitions, in insertion order. */
  macros: MacroAction[];
  /** Create a macro (id derived from the label, uniquified). Returns its actionId. */
  addMacro: (label: string, target: MacroTarget) => string;
  /** Delete a macro AND its `hexokit-keybindings` diff entry. */
  removeMacro: (actionId: string) => void;
};

export function useMacros(): UseMacros {
  const [macros, setMacros] = useState<MacroAction[]>(readStoredMacros);

  useEffect(() => {
    const onNotify = (next: MacroAction[]) => setMacros(next);
    subscribers.add(onNotify);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== MACROS_STORAGE_KEY) return;
      setMacros(readStoredMacros());
    };
    window.addEventListener("storage", onStorage);
    // Resync in case another subscriber wrote between mount and effect.
    setMacros(readStoredMacros());
    return () => {
      subscribers.delete(onNotify);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const addMacro = useCallback((label: string, target: MacroTarget): string => {
    // Compute against the CURRENT stored list (not the possibly-stale render
    // snapshot) so rapid successive adds compose correctly.
    const current = readStoredMacros();
    const actionId = makeMacroActionId(
      label,
      current.map((m) => m.actionId),
    );
    persistMacros([...current, { actionId, kind: "macro", label, target }]);
    return actionId;
  }, []);

  const removeMacro = useCallback((actionId: string) => {
    const current = readStoredMacros();
    const next = current.filter((m) => m.actionId !== actionId);
    if (next.length !== current.length) persistMacros(next);
    // Drop the macro's combo diff so a future same-id macro starts unbound.
    const overrides = readStoredOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
      const trimmed = { ...overrides };
      delete trimmed[actionId];
      writeStoredOverrides(trimmed);
    }
  }, []);

  return { macros, addMacro, removeMacro };
}
