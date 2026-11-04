import { describe, it, expect, vi } from "vitest";
import { buildServerKillActions } from "./server-kill";

describe("buildServerKillActions", () => {
  it("builds one Workspace: Kill entry per server, preserving order", () => {
    const actions = buildServerKillActions(
      ["default", "work", "rk-daemon"],
      "default",
      vi.fn(),
    );

    expect(actions.map((a) => a.label)).toEqual([
      "Workspace: Kill default (current)",
      "Workspace: Kill work",
      "Workspace: Kill rk-daemon",
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "kill-server-default",
      "kill-server-work",
      "kill-server-rk-daemon",
    ]);
  });

  it("suffixes only the current server with (current)", () => {
    const actions = buildServerKillActions(["a", "b"], "b", vi.fn());
    expect(actions[0].label).toBe("Workspace: Kill a");
    expect(actions[1].label).toBe("Workspace: Kill b (current)");
  });

  it("invokes onKill with the entry's own server name on select", () => {
    const onKill = vi.fn();
    const actions = buildServerKillActions(["default", "work"], "default", onKill);

    actions[1].onSelect();
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(onKill).toHaveBeenCalledWith("work");
  });

  it("returns an empty list for no servers", () => {
    expect(buildServerKillActions([], "default", vi.fn())).toEqual([]);
  });

  it("adds no (current) suffix when the current server is not in the list", () => {
    const actions = buildServerKillActions(["a"], "gone", vi.fn());
    expect(actions[0].label).toBe("Workspace: Kill a");
  });
});
