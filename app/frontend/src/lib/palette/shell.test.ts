import { describe, it, expect, vi } from "vitest";
import type { ShellServer } from "../shell";
import { buildShellServerActions } from "./shell";

// buildShellServerActions backs the shell-gated `Workspace: Switch to "<name>"`
// palette entries wired in app.tsx. Covering label quoting, the active
// `(current)` marker, onSelect wiring, and the empty case proves the actions'
// behavior without mounting the shell.

function server(id: string, name: string, active = false): ShellServer {
  return { id, name, url: `http://${id}:3000`, active };
}

describe("buildShellServerActions", () => {
  it("emits one quoted entry per server with (current) on the active one", () => {
    const actions = buildShellServerActions(
      [server("a", "studio-mac", true), server("b", "lab")],
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual([
      'Workspace: Switch to "studio-mac" (current)',
      'Workspace: Switch to "lab"',
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "shell-switch-server-a",
      "shell-switch-server-b",
    ]);
  });

  it("passes the server id to onSwitch on select", () => {
    const onSwitch = vi.fn();
    const actions = buildShellServerActions([server("b", "lab")], onSwitch);
    actions[0].onSelect();
    expect(onSwitch).toHaveBeenCalledWith("b");
  });

  it("yields no entries for an empty list (plain browser)", () => {
    expect(buildShellServerActions([], vi.fn())).toEqual([]);
  });
});
