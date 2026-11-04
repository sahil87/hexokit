/**
 * Pure builder for the command-palette recovery verbs (Constitution V — every
 * Recovery-section button is keyboard-reachable). Follows the
 * lib/palette/server-kill.ts pattern (pure, dependency-free, unit-testable).
 *
 * New keyboard actions registered by this module:
 *   - `Server: Restore <name>`          (id `recovery-restore-<name>`) — one
 *     per offer; invokes the SAME restore flow as the row's Restore button.
 *   - `Restore all previous servers`    (id `recovery-restore-all`) — only
 *     when more than one offer exists; the heading's Restore-all control.
 *   - `Server: Dismiss recovery <name>` (id `recovery-dismiss-<name>`) — one
 *     per offer; the row's × button.
 *   - `Dismiss all previous servers`    (id `recovery-dismiss-all`) — only
 *     when more than one offer exists; the heading's Dismiss-all control.
 *
 * The whole family is gated on offers being present: with an empty offer list
 * the builder returns no entries, so the palette never advertises a verb with
 * no target. The callbacks are supplied by the caller (HostOverviewPage wires
 * the useRecoveryOffers flows).
 */
import type { PaletteAction } from "@/components/command-palette";
import type { RecoveryOffer } from "@/api/client";

export type RecoveryHandlers = {
  onRestore: (server: string) => void;
  onRestoreAll: () => void;
  onDismiss: (server: string) => void;
  onDismissAll: () => void;
};

export function buildRecoveryActions(
  offers: RecoveryOffer[],
  handlers: RecoveryHandlers,
): PaletteAction[] {
  if (offers.length === 0) return [];
  const actions: PaletteAction[] = offers.map((offer) => ({
    id: `recovery-restore-${offer.server}`,
    label: `Workspace: Restore ${offer.server}`,
    onSelect: () => handlers.onRestore(offer.server),
  }));
  if (offers.length > 1) {
    actions.push({
      id: "recovery-restore-all",
      label: "Restore all previous workspaces",
      onSelect: handlers.onRestoreAll,
    });
  }
  for (const offer of offers) {
    actions.push({
      id: `recovery-dismiss-${offer.server}`,
      label: `Workspace: Dismiss recovery ${offer.server}`,
      onSelect: () => handlers.onDismiss(offer.server),
    });
  }
  if (offers.length > 1) {
    actions.push({
      id: "recovery-dismiss-all",
      label: "Dismiss all previous workspaces",
      onSelect: handlers.onDismissAll,
    });
  }
  return actions;
}
