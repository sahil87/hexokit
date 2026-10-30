/**
 * Pure builder for the desktop-shell server-switch palette actions
 * (`Workspace: Switch to "<name>"`) — the SPA-side keyboard path for the shell's
 * Servers menu (Constitution V; the shell-side paths are the ⌥⌘1–9 (mac) /
 * Alt+1–9 (win/linux) accelerators and the menu radios). Follows the
 * lib/palette/view.ts /
 * lib/palette/pin.ts pure-builder convention: label composition and active
 * indication are unit-testable without mounting the shell.
 *
 * The entries exist ONLY inside the desktop shell: the caller feeds this the
 * bridge-listed servers (`listShellServers()`), which is empty in a plain
 * browser — the first real `isShell()`-gated palette consumer. The quoted
 * name distinguishes these SHELL servers (whole rk instances, by URL) from
 * the tmux `Workspace: Switch to <name>` entries; `(current)` marks the active
 * one, matching the existing switch-entry vocabulary. Switch-only in v1 —
 * Add/Remove Server stay in the shell's native menu + welcome flow.
 */
import type { PaletteAction } from "@/components/command-palette";
import type { ShellServer } from "@/lib/shell";

/** One switch action per shell-registered server; `[]` for an empty list. */
export function buildShellServerActions(
  servers: ShellServer[],
  onSwitch: (id: string) => void,
): PaletteAction[] {
  return servers.map((server) => ({
    id: `shell-switch-server-${server.id}`,
    label: `Workspace: Switch to "${server.name}"${server.active ? " (current)" : ""}`,
    onSelect: () => onSwitch(server.id),
  }));
}
