/**
 * Pure builder for the command-palette per-server kill actions
 * (`Workspace: Kill <name>`, the current server suffixed ` (current)`). Follows
 * the lib/palette/pin.ts / lib/palette/move.ts pattern (pure, dependency-free,
 * unit-testable) so the enumeration and label composition are verifiable
 * without mounting the whole shell. The action body is a thin `onKill(name)`
 * callback passed in by the caller (app.tsx wires it to `setKillServerTarget`,
 * funnelling every entry through the existing inline confirm Dialog — incl.
 * its DAEMON_SERVER warning — and `executeKillServer`).
 *
 * This supersedes the single current-server `kill-server` action: with the
 * hover kill ✕ removed from the SERVER-panel tiles (bylc), the palette listing
 * is the keyboard escape hatch that keeps EVERY server killable — including
 * non-current servers, which have no SESSIONS-pane group header under the
 * `current` scope mode (Constitution V).
 */
import type { PaletteAction } from "@/components/command-palette";

/**
 * Build one `Workspace: Kill <name>` palette action per server, mirroring the
 * `Server: Switch to <name>` enumeration pattern.
 *
 * @param serverNames   all known server names (display order preserved)
 * @param currentServer the currently-active server (gets the ` (current)` suffix)
 * @param onKill        invoked with the server name to open the kill confirm
 */
export function buildServerKillActions(
  serverNames: string[],
  currentServer: string,
  onKill: (name: string) => void,
): PaletteAction[] {
  return serverNames.map((name) => ({
    id: `kill-server-${name}`,
    label: `Workspace: Kill ${name}${name === currentServer ? " (current)" : ""}`,
    onSelect: () => onKill(name),
  }));
}
