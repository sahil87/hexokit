import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_BINDINGS,
  KEYBINDINGS_STORAGE_KEY,
  applyCapture,
  detectPlatform,
  readStoredOverrides,
  resolveBindings,
  writeStoredOverrides,
  type BindingCombo,
  type BindingHost,
  type BindingOverrides,
  type EffectiveBinding,
  type KeyBinding,
} from "@/lib/keybindings";
import { macroToBinding, readStoredMacros } from "@/lib/macros";
import { useMacros } from "@/hooks/use-macros";
import { isShell } from "@/lib/shell";

/**
 * Reactive keybinding store (260730-g40a). Thin React integration over the
 * pure `lib/keybindings.ts` registry: reads the per-device override diffs
 * from `localStorage["hexokit-keybindings"]`, resolves the effective map for
 * this host, and keeps every subscriber in sync.
 *
 * Same-tab reactivity uses an in-module pub/sub (the
 * `use-local-storage-enum.ts` pattern — the native `storage` event fires only
 * across tabs); cross-tab sync rides `storage` for free. All writes funnel
 * through `persist()` so subscribers can never miss an update.
 *
 * MACRO-AWARE (260730-hbyh): the effective map resolves over the builtin
 * defaults PLUS the stored macros (`lib/macros.ts`, projected via
 * `macroToBinding` — keyless defaults whose combos live solely in the
 * override diffs). Because macros ride this one map, the dispatcher, palette
 * hints, the overlay tier-map, the terminal seam, and steal-with-warning all
 * see them with no consumer changes.
 */

const subscribers = new Set<(overrides: BindingOverrides) => void>();

function persist(overrides: BindingOverrides): void {
  writeStoredOverrides(overrides);
  for (const listener of subscribers) listener(overrides);
}

export type UseKeybindings = {
  /** The effective map for this host, in registry (display) order. */
  bindings: EffectiveBinding[];
  /** actionId → effective binding (palette hints, per-action lookups). */
  byAction: Map<string, EffectiveBinding>;
  /** The raw override diffs (overlay "modified"/"unbound" derivation). */
  overrides: BindingOverrides;
  /** Host facts (keycap platform + shell presence) — stable per mount. */
  host: BindingHost;
  /**
   * Rebind an action (capture result). Steal-with-warning: returns the
   * actionId the combo was taken from (now unbound) or null.
   */
  setBinding: (actionId: string, combo: BindingCombo) => string | null;
  /** Drop one action's diff (restore its default). */
  resetBinding: (actionId: string) => void;
  /** Drop every diff. */
  resetAll: () => void;
};

export function useKeybindings(): UseKeybindings {
  // Host facts are immutable per page load (the shell bridge is injected
  // before the SPA boots; the platform never changes mid-session).
  const host = useMemo<BindingHost>(
    () => ({ platform: detectPlatform(), shell: isShell() }),
    [],
  );

  const [overrides, setOverrides] = useState<BindingOverrides>(readStoredOverrides);
  const { macros } = useMacros();

  useEffect(() => {
    const onNotify = (next: BindingOverrides) => setOverrides(next);
    subscribers.add(onNotify);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEYBINDINGS_STORAGE_KEY) return;
      setOverrides(readStoredOverrides());
    };
    window.addEventListener("storage", onStorage);
    // Resync in case another subscriber wrote between mount and effect.
    setOverrides(readStoredOverrides());
    return () => {
      subscribers.delete(onNotify);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // A macro change can carry an override-store side effect (`removeMacro`
  // drops the deleted macro's diff without a keybinding-store notification) —
  // re-read override storage so the two stores can never drift in-memory.
  useEffect(() => {
    setOverrides(readStoredOverrides());
  }, [macros]);

  const defaults = useMemo<KeyBinding[]>(
    () => [...DEFAULT_BINDINGS, ...macros.map(macroToBinding)],
    [macros],
  );

  const bindings = useMemo(
    () => resolveBindings(defaults, overrides, host),
    [defaults, overrides, host],
  );

  const byAction = useMemo(
    () => new Map(bindings.map((b) => [b.actionId, b])),
    [bindings],
  );

  const setBinding = useCallback(
    (actionId: string, combo: BindingCombo): string | null => {
      // Compute against the CURRENT stored diffs AND macros (not the possibly-
      // stale render snapshot) so rapid successive captures compose correctly
      // and macro-owned combos are steal-detected.
      const current = readStoredOverrides();
      const freshDefaults = [...DEFAULT_BINDINGS, ...readStoredMacros().map(macroToBinding)];
      const effective = resolveBindings(freshDefaults, current, host);
      const { overrides: next, stolenFrom } = applyCapture(
        effective,
        current,
        actionId,
        combo,
        host,
        freshDefaults,
      );
      persist(next);
      return stolenFrom;
    },
    [host],
  );

  const resetBinding = useCallback((actionId: string) => {
    const current = readStoredOverrides();
    if (!Object.prototype.hasOwnProperty.call(current, actionId)) return;
    const next = { ...current };
    delete next[actionId];
    persist(next);
  }, []);

  const resetAll = useCallback(() => {
    persist({});
  }, []);

  return { bindings, byAction, overrides, host, setBinding, resetBinding, resetAll };
}
