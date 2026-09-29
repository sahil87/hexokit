/**
 * Pure builder for the command-palette per-server adopt actions
 * (`Server: Adopt <name> into HexoKit`). Follows the
 * lib/palette/server-protect.ts / server-kill.ts pattern (pure,
 * dependency-free, unit-testable) so the enumeration and label composition
 * are verifiable without mounting the whole shell. The action body is a thin
 * `onAdopt(name)` callback passed in by the caller (app.tsx wires it to the
 * `requestAdoptServer` context trigger, funnelling every entry through the
 * layout-mounted adopt confirm Dialog).
 *
 * EXTERNAL servers only: the backend's `managed` flag marks rk-daemon by
 * derivation and any @rk_srv_managed server (rk-born or adopted), so consumers
 * gate on `managed === false` — an old backend omitting the field renders NO
 * adopt entries. rk-daemon is additionally guarded by name, matching the
 * protect builder's exclusion.
 */
import type { PaletteAction } from "@/components/command-palette";
import { DAEMON_SERVER, type ServerInfo } from "@/api/client";

/**
 * Build one `Server: Adopt <name> into HexoKit` palette action per EXTERNAL
 * server (`managed === false`), driven by the server list's `managed` payload
 * flag.
 *
 * @param servers all known servers (display order preserved)
 * @param onAdopt invoked with the server name to open the adopt confirm
 */
export function buildServerAdoptActions(
  servers: ServerInfo[],
  onAdopt: (name: string) => void,
): PaletteAction[] {
  return servers
    .filter((s) => s.name !== DAEMON_SERVER && s.managed === false)
    .map((s) => ({
      id: `adopt-server-${s.name}`,
      label: `Server: Adopt ${s.name} into HexoKit`,
      onSelect: () => onAdopt(s.name),
    }));
}
