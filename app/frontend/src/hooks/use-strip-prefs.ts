import { useCallback, useEffect, useState } from "react";
import {
  canUseShellPrefs,
  getShellStripPrefs,
  onShellPrefsChange,
  setShellPref,
} from "@/lib/shell";
import {
  DEFAULT_STRIP_EFFECT,
  DEFAULT_STRIP_MOTION,
  effectiveMotion,
} from "@/lib/shell-strip";
import type { StripEffect, StripMotion, StripPrefs } from "@/lib/shell-strip";
import { prefersReducedMotion } from "@/lib/motion";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const DEFAULT_PREFS: StripPrefs = { effect: DEFAULT_STRIP_EFFECT, motion: DEFAULT_STRIP_MOTION };

export interface StripPrefsState {
  /** The stored effect (the default Glow until the shell answers). */
  effect: StripEffect;
  /** The stored motion choice — what Settings shows as selected. */
  motion: StripMotion;
  /** The motion actually applied: reduced-motion users always get `cut`. */
  appliedMotion: StripMotion;
  /** True when the shell carries the prefs invokers (the Settings group
   *  renders only then; without them the defaults apply). */
  canSet: boolean;
  setEffect: (effect: StripEffect) => void;
  setMotion: (motion: StripMotion) => void;
}

/**
 * The desktop app's strip prefs, read from the shell's own store (never
 * localStorage: each host is a separate origin in the shell, so a per-origin
 * value would not follow host switches). Seeds from `prefs.get`, then follows
 * the shell's `prefs:changed` broadcast, so a change made from any host in any
 * window repaints every strip. Without the bridge the defaults (Glow + Light
 * slides) hold and `canSet` is false.
 */
export function useStripPrefs(): StripPrefsState {
  const canSet = canUseShellPrefs();
  const [prefs, setPrefs] = useState<StripPrefs>(DEFAULT_PREFS);
  const [reduced, setReduced] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (!canSet) return;
    let live = true;
    void getShellStripPrefs().then((fresh) => {
      if (live && fresh !== null) setPrefs(fresh);
    });
    const off = onShellPrefsChange((next) => {
      if (live) setPrefs(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [canSet]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // The shell validates and persists, then broadcasts to every view
  // (including this one) — local state follows the broadcast, so a refused
  // write needs no rollback.
  const setEffect = useCallback((effect: StripEffect) => {
    void setShellPref("strip.effect", effect);
  }, []);
  const setMotion = useCallback((motion: StripMotion) => {
    void setShellPref("strip.motion", motion);
  }, []);

  return {
    effect: prefs.effect,
    motion: prefs.motion,
    appliedMotion: effectiveMotion(prefs.motion, reduced),
    canSet,
    setEffect,
    setMotion,
  };
}
