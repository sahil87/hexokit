/**
 * Pure builder for the command-palette per-server protect/unprotect actions
 * (`Server: Protect <name>` / `Server: Unprotect <name>`). Follows the
 * lib/palette/server-kill.ts pattern (pure, dependency-free, unit-testable) so
 * the enumeration and label composition are verifiable without mounting the
 * whole shell. The action body is a thin `onToggle(name, protected)` callback
 * passed in by the caller (app.tsx wires it to `setServerProtected`).
 *
 * rk-daemon is EXCLUDED: its protection is derived from its constant name and
 * is not togglable (the backend protect endpoint rejects it with 400).
 */
import type { PaletteAction } from "@/components/command-palette";
import { DAEMON_SERVER, type ServerInfo } from "@/api/client";

/**
 * Build one `Server: Protect <name>` / `Server: Unprotect <name>` palette
 * action per non-daemon server, driven by the `protected` payload flag.
 *
 * @param servers  all known servers (display order preserved)
 * @param onToggle invoked with the server name and the NEW protected state
 */
export function buildServerProtectActions(
  servers: ServerInfo[],
  onToggle: (name: string, protected_: boolean) => void,
): PaletteAction[] {
  return servers
    .filter((s) => s.name !== DAEMON_SERVER)
    .map((s) => {
      const next = !(s.protected ?? false);
      return {
        id: `${next ? "protect" : "unprotect"}-server-${s.name}`,
        label: `Workspace: ${next ? "Protect" : "Unprotect"} ${s.name}`,
        onSelect: () => onToggle(s.name, next),
      };
    });
}
