/**
 * Pure builder for the command-palette `Server: Set Color` action — the server
 * tier's keyboard color path, scoped to the current route's server. Follows
 * the lib/palette/server-protect.ts pattern (pure, dependency-free,
 * unit-testable); the action body is a thin `onOpen` callback the caller wires
 * to its modal SwatchPopover mount (app.tsx's showColorPicker union, "server"
 * arm).
 */
import type { PaletteAction } from "@/components/command-palette";

/**
 * Build the `Server: Set Color` palette action for the current server.
 *
 * @param server  the current route's server, or null on serverless routes
 *                (host/board) — no current server ⇒ no action
 * @param onOpen  opens the caller's server-scoped color picker
 */
export function buildServerSetColorAction(
  server: string | null,
  onOpen: () => void,
): PaletteAction[] {
  if (!server) return [];
  return [
    {
      id: "server-set-color",
      label: "Workspace: Set Color",
      onSelect: onOpen,
    },
  ];
}
