import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useToast } from "@/components/toast";
import { getInstanceColor, setInstanceColor as setInstanceColorApi } from "@/api/client";
import { useStripPrefs } from "@/hooks/use-strip-prefs";
import { snapHostColor } from "@/lib/host-colors";
import { isShell } from "@/lib/shell";
import {
  readInstanceColorEcho,
  writeInstanceColorEcho,
  deriveAccentHexes,
  setAccentThemeColor,
} from "@/instance-accent";

/**
 * Instance accent ("host color") — root-mounted provider owning the accent
 * resolution chain (explicit `instance_color` setting → localStorage echo as a
 * pre-fetch paint seed → none; there is no derived default), the localStorage
 * echo, and the PWA theme-color meta bridge. Both rendering surfaces (the
 * top-bar stripe/wash in AppLayout and the HOST panel hostname/picker) consume
 * `useInstanceAccent()` from this single instance — one fetch, one state, and
 * a pick in the HOST panel repaints the top bar without a reload.
 */
export type InstanceAccent = {
  /** Resolved accent descriptor ("4" / "1+3"), or null when no accent is set
   *  (the default — a fresh instance has no color until the user picks one). */
  color: string | null;
  /** True when an explicit instance color is set. */
  isExplicit: boolean;
  /** Contrast-guarded accent hex — top-bar stripe and HOST hostname tint
   *  (the theme-color meta takes the subtler `titlebarHex` blend instead).
   *  Null when no accent is resolved. */
  stripeHex: string | null;
  /** Subtle accent-into-background blend for the top-bar wash. */
  washHex: string | null;
  /** The titlebar blend (`INSTANCE_TITLEBAR_RATIO`) — the theme-color meta
   *  content, and the desktop shell's titlebar-strip background (the strip is
   *  the shell's page-drawn window chrome, so it matches the PWA titlebar
   *  tint exactly). Null when no accent is resolved. */
  titlebarHex: string | null;
  /** Set (descriptor) or clear (null → no accent) the instance color.
   *  Optimistic; POSTs to the instance host, toasting on failure. */
  setColor: (color: string | null) => void;
};

const InstanceAccentContext = createContext<InstanceAccent | null>(null);

export function InstanceAccentProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const { addToast } = useToast();

  // undefined = fetch pending; null = fetched, no explicit color set.
  const [explicit, setExplicit] = useState<string | null | undefined>(undefined);
  // Pre-fetch paint seed from the last load's echo (paint cache only — the
  // authoritative resolution below overwrites it as soon as the fetch lands).
  const [echoSeed] = useState<string | null>(() => readInstanceColorEcho()?.value ?? null);

  // Fetch the explicit setting once on mount (guarded for StrictMode
  // double-invoke, matching the AppShell getHealth pattern).
  const didFetchRef = useRef(false);
  useEffect(() => {
    if (didFetchRef.current) return;
    didFetchRef.current = true;
    getInstanceColor()
      .then((color) => setExplicit(color))
      .catch(() => setExplicit(null));
  }, []);

  // Resolution chain: explicit setting → (while pending) echo seed → none.
  // There is no derived default — an unset instance renders no accent.
  // `authoritative` marks the point where the chain no longer depends on the
  // paint seed — only then may the echo/meta be cleared on a null accent.
  const resolved = explicit === undefined ? echoSeed : explicit;
  const authoritative = explicit !== undefined;

  // In the desktop shell a stored color outside the Host color set DISPLAYS as
  // the nearest set member (square, strip light, reported edge color); the
  // stored value is never rewritten until the user picks again.
  const displayed = useMemo(
    () => (resolved != null && isShell() ? (snapHostColor(resolved) ?? resolved) : resolved),
    [resolved],
  );

  const hexes = useMemo(
    () => (displayed != null ? deriveAccentHexes(displayed, theme) : null),
    [displayed, theme],
  );

  // Bridge: keep the theme-color meta and the localStorage echo in sync with
  // the resolved accent under the active theme. The meta (installed-PWA
  // titlebar) carries the subtle titlebar blend — NOT the full-hue stripeHex —
  // so the 2px stripe below the titlebar stays visible (mock parity).
  //
  // In the desktop shell the meta paints the Windows/Linux window-controls
  // overlay beside the strip: under any light effect other than Flat the
  // strip's right end is neutral chrome, so the meta stays the bare chrome
  // (no accent tint) to match it; Flat keeps the 35% titlebar blend.
  const { effect: stripEffect } = useStripPrefs();
  const neutralMeta = isShell() && stripEffect !== "flat";
  useEffect(() => {
    if (resolved != null && hexes != null) {
      setAccentThemeColor(neutralMeta ? null : hexes.titlebarHex);
      writeInstanceColorEcho({ value: resolved, hex: hexes.titlebarHex });
    } else if (authoritative) {
      setAccentThemeColor(null);
      writeInstanceColorEcho(null);
    }
  }, [resolved, hexes, authoritative, neutralMeta]);

  // Clear the accent meta on unmount so a torn-down provider (tests) doesn't
  // leak module state into the next mount.
  useEffect(() => () => setAccentThemeColor(null), []);

  const setColor = useCallback(
    (color: string | null) => {
      setExplicit(color);
      setInstanceColorApi(color).catch((err: unknown) => {
        addToast(err instanceof Error && err.message ? err.message : "Failed to save instance color");
      });
    },
    [addToast],
  );

  const value = useMemo<InstanceAccent>(
    () => ({
      color: resolved,
      isExplicit: typeof explicit === "string",
      stripeHex: hexes?.stripeHex ?? null,
      washHex: hexes?.washHex ?? null,
      titlebarHex: hexes?.titlebarHex ?? null,
      setColor,
    }),
    [resolved, explicit, hexes, setColor],
  );

  return <InstanceAccentContext.Provider value={value}>{children}</InstanceAccentContext.Provider>;
}

/** Test seam: inject a fixed accent value without the fetching provider.
 *  Mirrors the session-context `MetricsProvider` value-injection pattern. */
export function InstanceAccentValueProvider({
  value,
  children,
}: {
  value: InstanceAccent;
  children: React.ReactNode;
}) {
  return <InstanceAccentContext.Provider value={value}>{children}</InstanceAccentContext.Provider>;
}

export function useInstanceAccent(): InstanceAccent {
  const ctx = useContext(InstanceAccentContext);
  if (!ctx) throw new Error("useInstanceAccent must be used within InstanceAccentProvider");
  return ctx;
}
