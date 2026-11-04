import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRecoveryOffers,
  restoreRecoveryServer,
  dismissRecoveryServer,
  type RecoveryOffer,
} from "@/api/client";
import { SectionHeading } from "@/components/section-heading";
import { useToast } from "@/components/toast";
import { useSessionContext } from "@/contexts/session-context";
import { useTheme } from "@/contexts/theme-context";
import { colorValueToHex } from "@/themes";
import { formatDuration } from "@/lib/format";

/**
 * Shared state for the Host Overview RECOVERY zone: the offer list plus the
 * restore/dismiss flows. The page owns the hook once and hands the result to
 * both the `RecoverySection` (rendering) and the palette registration
 * (keyboard parity — Constitution V), so every surface drives the SAME
 * mutations and one offer list.
 *
 * Data flow: one GET on mount + a refetch after the hook's own
 * restore/dismiss mutations. NEVER setInterval+fetch polling; no new SSE
 * kind. A fetch failure resolves to zero offers (an old/unreachable daemon
 * simply has no recovery surface), so the section stays hidden.
 */
export type RecoveryState = {
  offers: RecoveryOffer[];
  /** Servers whose restore POST is in flight (per-row "restoring…" state). */
  restoring: ReadonlySet<string>;
  restore: (server: string) => Promise<void>;
  restoreAll: () => Promise<void>;
  dismiss: (server: string) => Promise<void>;
  dismissAll: () => Promise<void>;
};

export function useRecoveryOffers(): RecoveryState {
  const { addToast } = useToast();
  const { refreshServers } = useSessionContext();
  const [offers, setOffers] = useState<RecoveryOffer[]>([]);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  // Restore-all / dismiss-all iterate the CURRENT offer list without a stale
  // closure.
  const offersRef = useRef(offers);
  offersRef.current = offers;

  const refetch = useCallback(async () => {
    try {
      setOffers(await getRecoveryOffers());
    } catch {
      setOffers([]);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const restore = useCallback(
    async (server: string) => {
      setRestoring((prev) => new Set(prev).add(server));
      try {
        await restoreRecoveryServer(server);
        setOffers((prev) => prev.filter((o) => o.server !== server));
        void refetch();
        // The server list is fetch-on-demand (not SSE-carried): refresh it so
        // the restored server's live tile appears without waiting for SSE —
        // mirrors the create-server flow's onAlwaysSettled.
        refreshServers();
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Restore failed");
      } finally {
        setRestoring((prev) => {
          const next = new Set(prev);
          next.delete(server);
          return next;
        });
      }
    },
    [addToast, refreshServers, refetch],
  );

  const restoreAll = useCallback(async () => {
    // No bulk endpoint exists — sequential per-server POSTs; a failed server
    // toasts (inside restore) and does not block the rest.
    for (const offer of offersRef.current) {
      await restore(offer.server);
    }
  }, [restore]);

  const dismiss = useCallback(
    async (server: string) => {
      try {
        await dismissRecoveryServer(server);
        setOffers((prev) => prev.filter((o) => o.server !== server));
        void refetch();
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Dismiss failed");
      }
    },
    [addToast, refetch],
  );

  const dismissAll = useCallback(async () => {
    // No bulk endpoint exists — sequential per-server POSTs; a failed server
    // toasts (inside dismiss) and does not block the rest.
    for (const offer of offersRef.current) {
      await dismiss(offer.server);
    }
  }, [dismiss]);

  return useMemo(
    () => ({ offers, restoring, restore, restoreAll, dismiss, dismissAll }),
    [offers, restoring, restore, restoreAll, dismiss, dismissAll],
  );
}

/** "last seen X ago" from the snapshot's RFC3339 `takenAt`. On quiet servers
 *  this reads as the age of the last layout change (accepted). Computed at
 *  render — the offers list only changes on fetch, so no ticking clock. */
function lastSeenLabel(takenAt: string): string {
  const takenMs = Date.parse(takenAt);
  if (Number.isNaN(takenMs)) return "unknown";
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - takenMs / 1000));
  return `${formatDuration(elapsed)} ago`;
}

function RecoveryTree({ offer }: { offer: RecoveryOffer }) {
  const { theme } = useTheme();
  return (
    <div className="mt-2 border-t border-border pt-2 flex flex-col gap-2">
      {offer.sessions.map((session) => {
        const hex = session.color
          ? colorValueToHex(session.color, theme.palette)
          : null;
        return (
          <div key={session.name} data-testid={`recovery-session-${session.name}`}>
            <div className="flex items-center gap-1.5 text-xs text-text-primary">
              {hex && (
                <span
                  aria-hidden="true"
                  className="w-[7px] h-[7px] rounded-full shrink-0"
                  style={{ backgroundColor: hex }}
                />
              )}
              {session.name}
            </div>
            <div className="ml-3 flex flex-col gap-0.5">
              {session.windows.map((win) => (
                <div key={win.index} className="text-xs font-mono">
                  <span className="text-text-secondary">
                    {win.index}: <span className="text-text-primary">{win.name}</span>
                    {" · "}
                    {win.paneCount} pane{win.paneCount !== 1 ? "s" : ""}
                    {win.resumable && (
                      <span className="ml-1.5 border border-border rounded px-1 text-text-secondary">
                        resumable
                      </span>
                    )}
                  </span>
                  {win.commands.length > 0 && (
                    <div className="ml-4 text-text-secondary truncate">
                      {win.commands.join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecoveryRow({
  offer,
  isRestoring,
  isExpanded,
  onToggleExpand,
  onRestore,
  onDismiss,
}: {
  offer: RecoveryOffer;
  isRestoring: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="bg-bg-card border border-border rounded px-3 py-2"
      data-testid={`recovery-row-${offer.server}`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Hide" : "Show"} layout for ${offer.server}`}
          className="shrink-0 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          {isExpanded ? "▾" : "▸"}
        </button>
        {/* Hollow (non-live) dot: the ring shape of the status-dot ladder's
            at-rest tier — a dead server never reads as solid/live. */}
        <span
          role="img"
          aria-label="not running"
          className="w-[7px] h-[7px] rounded-full shrink-0 text-text-secondary"
          style={{ border: "1.8px solid currentColor", backgroundColor: "transparent" }}
        />
        <span className="text-text-primary font-medium text-sm truncate">{offer.server}</span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {isRestoring ? (
            <span className="text-xs text-text-secondary">restoring…</span>
          ) : (
            <>
              <button
                onClick={onRestore}
                aria-label={`Restore ${offer.server}`}
                className="text-xs px-2 py-1 border border-border rounded text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
              >
                Restore
              </button>
              <button
                onClick={onDismiss}
                aria-label={`Dismiss recovery for ${offer.server}`}
                className="text-xs px-1.5 py-1 text-text-secondary hover:text-text-primary transition-colors"
              >
                ×
              </button>
            </>
          )}
        </div>
      </div>
      <div className="text-xs text-text-secondary font-mono mt-1 ml-5">
        {offer.sessionCount} group{offer.sessionCount !== 1 ? "s" : ""}
        {" · "}
        {offer.windowCount} tab{offer.windowCount !== 1 ? "s" : ""}
        {" · "}last seen {lastSeenLabel(offer.takenAt)}
        {" · "}system restart
      </div>
      {isExpanded && <RecoveryTree offer={offer} />}
    </div>
  );
}

/**
 * The Host Overview RECOVERY zone (R8/R9/R10): reboot-orphaned servers whose
 * snapshot offers can be restored or dismissed. Renders ONLY when offers
 * exist — zero footprint otherwise (no heading, no empty state, no reserved
 * space).
 */
export function RecoverySection({ recovery }: { recovery: RecoveryState }) {
  const { offers, restoring, restore, restoreAll, dismiss, dismissAll } = recovery;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (offers.length === 0) return null;

  const toggleExpand = (server: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(server)) next.delete(server);
      else next.add(server);
      return next;
    });

  return (
    <section aria-label="Recovery" className="mb-6 max-w-md">
      <SectionHeading
        label="Recovery"
        className="mb-2"
        side={
          offers.length > 1 ? (
            <span className="flex items-center gap-2">
              <button
                onClick={() => void restoreAll()}
                className="text-xs px-2 py-1 border border-border rounded text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
              >
                Restore all ({offers.length})
              </button>
              <button
                onClick={() => void dismissAll()}
                className="text-xs px-2 py-1 border border-border rounded text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
              >
                Dismiss all
              </button>
            </span>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-1.5">
        {offers.map((offer) => (
          <RecoveryRow
            key={offer.server}
            offer={offer}
            isRestoring={restoring.has(offer.server)}
            isExpanded={expanded.has(offer.server)}
            onToggleExpand={() => toggleExpand(offer.server)}
            onRestore={() => void restore(offer.server)}
            onDismiss={() => void dismiss(offer.server)}
          />
        ))}
      </div>
    </section>
  );
}
