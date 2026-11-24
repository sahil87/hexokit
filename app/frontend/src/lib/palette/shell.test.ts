import { describe, it, expect, vi } from "vitest";
import type { ShellServer } from "../shell";
import { buildShellHostCycleActions, buildShellServerActions } from "./shell";

// buildShellServerActions backs the shell-gated `Host: Switch to "<name>"`
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
      'Host: Switch to "studio-mac" (current)',
      'Host: Switch to "lab"',
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

// buildShellHostCycleActions backs `Host: Previous` / `Host: Next` — the
// palette path for the shell's cycle accelerators, which live outside every
// registry tier, so the shortcut hints are literals.
describe("buildShellHostCycleActions", () => {
  const two = [server("a", "studio"), server("b", "lab")];

  it("emits Previous then Next with mac ⌥⌘ arrow hints", () => {
    const actions = buildShellHostCycleActions(two, "mac", vi.fn());
    expect(actions.map((a) => [a.id, a.label, a.shortcut])).toEqual([
      ["shell-host-prev", "Host: Previous", "⌥⌘←"],
      ["shell-host-next", "Host: Next", "⌥⌘→"],
    ]);
  });

  it("uses Alt+PgUp / Alt+PgDn hints off mac", () => {
    const actions = buildShellHostCycleActions(two, "other", vi.fn());
    expect(actions.map((a) => a.shortcut)).toEqual(["Alt+PgUp", "Alt+PgDn"]);
  });

  it("selects with direction -1 (previous) and 1 (next)", () => {
    const onCycle = vi.fn();
    const [prev, next] = buildShellHostCycleActions(two, "other", onCycle);
    prev.onSelect();
    next.onSelect();
    expect(onCycle.mock.calls).toEqual([[-1], [1]]);
  });

  it("yields nothing below two hosts", () => {
    expect(buildShellHostCycleActions([], "mac", vi.fn())).toEqual([]);
    expect(buildShellHostCycleActions([server("a", "solo")], "mac", vi.fn())).toEqual([]);
  });
});
