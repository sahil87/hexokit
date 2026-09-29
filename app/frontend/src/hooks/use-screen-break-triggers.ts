/**
 * useScreenBreakTriggers — the automatic occasions for the screen-break eggs,
 * derived client-side from state the frontend already receives (no backend
 * channel, no trigger file):
 *
 * - `smash` — the VIEWED window's `prState` flips from an observed
 *   `"open"`/`"closed"` to `"merged"` (identity: the PR number). The first
 *   observation of a window never fires (merged is a terminal state visible
 *   forever on old windows); switching windows resets the observed-previous.
 * - `peek` — the UpdateChip's `showChip` becomes true (including a first
 *   observation with the chip already lit — the stored `hexokit-egg-peek` key
 *   is what makes a reload idempotent) or its `key` changes while lit
 *   (identity: `key ?? latest`).
 *
 * Both ride the store's gates: in-flight drops, once-per-identity
 * localStorage, reduced-motion never-fires, the 640 px floor.
 */

import { useEffect, useRef } from "react";
import { useMatches } from "@tanstack/react-router";
import { useSessionContext, useUpdateNotification } from "@/contexts/session-context";
import { fire } from "@/lib/screen-break-store";
import type { WindowInfo } from "@/types";

export function useScreenBreakTriggers(): void {
  const matches = useMatches();
  const { sessionsByServer } = useSessionContext();
  const { showChip, key, latest } = useUpdateNotification();

  // The viewed window, resolved from the deepest-first route-param walk (the
  // same idiom useGlobalPaletteActions uses). Routes without a `window` param
  // (host/server/board) have no viewed window — the fist never fires there.
  let serverParam: string | undefined;
  let windowParam: string | undefined;
  for (let i = matches.length - 1; i >= 0; i--) {
    const p = (matches[i]?.params ?? {}) as { server?: string; window?: string };
    if (serverParam === undefined && typeof p.server === "string") serverParam = p.server;
    if (windowParam === undefined && typeof p.window === "string") windowParam = p.window;
  }
  let viewed: WindowInfo | null = null;
  if (serverParam !== undefined && windowParam !== undefined) {
    for (const session of sessionsByServer.get(serverParam) ?? []) {
      const found = session.windows.find((w) => w.windowId === windowParam);
      if (found) {
        viewed = found;
        break;
      }
    }
  }

  const prevWindowRef = useRef<{ windowKey: string; prState: WindowInfo["prState"] } | null>(null);
  useEffect(() => {
    const windowKey =
      serverParam !== undefined && windowParam !== undefined
        ? `${serverParam}/${windowParam}`
        : null;
    const prev = prevWindowRef.current;
    prevWindowRef.current =
      windowKey === null ? null : { windowKey, prState: viewed?.prState };
    if (
      windowKey !== null &&
      prev !== null &&
      prev.windowKey === windowKey &&
      (prev.prState === "open" || prev.prState === "closed") &&
      viewed?.prState === "merged" &&
      viewed.prNumber !== undefined
    ) {
      fire("smash", { identity: String(viewed.prNumber) });
    }
  });

  const prevChipRef = useRef<{ showChip: boolean; key: string | null } | null>(null);
  useEffect(() => {
    const prev = prevChipRef.current;
    prevChipRef.current = { showChip, key };
    // First observation with the chip lit counts (arrival); the store's
    // once-per-identity rule is what makes a reload idempotent.
    const becameLit = showChip && (prev === null || !prev.showChip);
    const keyChangedWhileLit = showChip && prev !== null && prev.showChip && key !== prev.key;
    if (becameLit || keyChangedWhileLit) {
      const identity = key ?? latest ?? "";
      if (identity !== "") fire("peek", { identity });
    }
  }, [showChip, key, latest]);
}
