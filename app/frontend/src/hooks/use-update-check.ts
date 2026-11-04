import { useCallback, useContext, useRef, useState } from "react";
import { SessionContext, useUpdateNotification } from "@/contexts/session-context";
import { useToast } from "@/components/toast";
import { checkForUpdates } from "@/api/client";
import { composeCheckToast, filterCheckRelevantTools } from "@/lib/palette/update";

/** Sentinel running version for local (non-ldflags) builds — the toast's
 *  "Update Now" action slot is suppressed for it (mirrors the palette entry's
 *  gate in buildMaintenanceActions). Kept local, same pattern as
 *  lib/palette/update.ts. */
const DEV_VERSION = "dev";

/**
 * Shared behavior for the two palette check commands (`HexoKit: Check for
 * Updates` / `… (incl. patches)`), consumed by BOTH palette mounts — AppShell
 * (app.tsx) and the board route (board-page.tsx, which mounts its own palette
 * and does not render AppShell). Extracted so the POST→toast flow (result
 * composition, Update Now action gating, error mapping) can NEVER drift between
 * the two — the same anti-drift extraction as use-update-click.ts.
 *
 * Flow: POST /api/updates/check (synchronous ~1-2s — deliberately NO
 * intermediate "checking…" toast), then ONE result toast:
 *   - info toast with the per-tool summary (composeCheckToast; the
 *     includePatches flag selects notable-only vs. all-pending filtering).
 *     The two commands are TWO BACKENDS (260720-wb3n): the default check runs
 *     shll's released-manifest source, while incl.-patches requests the fresh
 *     GitHub release-tags source (`checkForUpdates("github")` — a side-channel
 *     query that never touches the daemon's cached verdict/chip). The response's
 *     echoed `source` rides into the toast composition so the sub-threshold
 *     annotation keys off what actually ran;
 *   - when something updatable was reported AND the daemon can actually update
 *     (brew install, non-dev — the same gate as the palette's `HexoKit: Update
 *     Now` entry), the toast's action slot carries "Update Now", triggering the
 *     same force-update flow;
 *   - on a failed check (502 shll-missing, 409 dev, network) an error toast
 *     surfaces the server's message — a deliberate invocation deserves an
 *     honest answer, unlike the fail-silent ambient loop.
 *
 * The result is ALSO persisted onto the tab-local manual feed
 * (`applyManualCheckResult`), so the finding survives the toast on the
 * persistent update surfaces (chip / overflow-menu version row) instead of
 * evaporating after ~5s. The persisted subset comes from the SAME exported
 * predicate `composeCheckToast` filters with (`filterCheckRelevantTools` in
 * lib/palette/update.ts — one definition, two call sites), so the chip and the
 * toast can never disagree about what was found — and an all-up-to-date result
 * persists an EMPTY set, clearing any stale positive. The toast flow itself is
 * unchanged: this is in addition to it, never a replacement.
 *
 * In-flight state (260720-ml7k): `checking` is true while a check request is
 * pending — the overflow menu's ⟳ affordance renders its spinner/disabled form
 * off it. Repeat `runUpdateCheck` calls while in flight are no-ops
 * (single-flight). The synchronous guard is a ref — NOT the state value — so a
 * same-tick double-click can't slip past the not-yet-flushed state, and
 * `runUpdateCheck` keeps a stable identity across the in-flight transition
 * (board-page.tsx memoizes a large palette-action array on it).
 */
export function useUpdateCheck(): {
  runUpdateCheck: (includePatches: boolean) => void;
  checking: boolean;
} {
  const { brew, daemonVersion, forceUpdateNow } = useUpdateNotification();
  // Read the persistence seam from the context DIRECTLY (provider-tolerant, the
  // same `useContext` idiom useUpdateNotification uses) so this hook never
  // throws in an isolated test mount without a SessionProvider.
  const ctx = useContext(SessionContext);
  const applyManualCheckResult = ctx?.applyManualCheckResult;
  const { addToast } = useToast();
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);

  const runUpdateCheck = useCallback(
    (includePatches: boolean) => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      void checkForUpdates(includePatches ? "github" : undefined)
        .then((result) => {
          const { message, updatable } = composeCheckToast(
            result.tools,
            includePatches,
            result.source,
          );
          // Persist the same updatable subset onto the tab-local manual feed
          // (an empty subset clears a stale positive — see applyManualCheckResult).
          // The subset comes from the SAME exported predicate composeCheckToast
          // filters with (filterCheckRelevantTools), so the persisted feed can
          // never desync from what the toast just reported.
          applyManualCheckResult?.(
            filterCheckRelevantTools(result.tools, includePatches),
            result.source,
          );
          const canUpdate = brew && daemonVersion !== DEV_VERSION;
          const action =
            updatable && canUpdate
              ? {
                  label: "Update Now",
                  onSelect: () => {
                    void forceUpdateNow().catch((err: unknown) =>
                      addToast(err instanceof Error ? err.message : "Update failed", "error"),
                    );
                  },
                }
              : undefined;
          addToast(message, "info", action);
        })
        .catch((err: unknown) => {
          addToast(err instanceof Error ? err.message : "Update check failed", "error");
        })
        .finally(() => {
          checkingRef.current = false;
          setChecking(false);
        });
    },
    [brew, daemonVersion, forceUpdateNow, addToast, applyManualCheckResult],
  );

  return { runUpdateCheck, checking };
}
