import { describe, it, expect, vi } from "vitest";
import { buildNavActions } from "./nav";

const noop = {
  onBack: () => {},
  onForward: () => {},
  onTmuxServer: () => {},
  onHost: () => {},
};

describe("buildNavActions (Go: palette parity)", () => {
  it("always offers Back and Forward first (history is global)", () => {
    const actions = buildNavActions("server", "prod", noop);
    expect(actions.slice(0, 2).map((a) => a.id)).toEqual(["go-back", "go-forward"]);
    expect(actions[0].label).toBe("Go: Back");
    expect(actions[1].label).toBe("Go: Forward");
  });

  it("emits Go: Host as the final entry on every supported mode (the Host root is a universal ancestor)", () => {
    for (const mode of ["terminal", "board", "server"] as const) {
      const ids = buildNavActions(mode, "prod", noop).map((a) => a.id);
      expect(ids[ids.length - 1]).toBe("go-host");
    }
  });

  it("on a terminal route offers Workspace then Host (nearest-first)", () => {
    const ids = buildNavActions("terminal", "prod", noop).map((a) => a.id);
    expect(ids).toEqual(["go-back", "go-forward", "go-tmux-server", "go-host"]);
  });

  it("on a board route offers only Host as the ancestor (no Workspace)", () => {
    const ids = buildNavActions("board", "prod", noop).map((a) => a.id);
    expect(ids).toEqual(["go-back", "go-forward", "go-host"]);
  });

  it("on a server (Workspace) route offers only Host (its lone ancestor)", () => {
    const ids = buildNavActions("server", "prod", noop).map((a) => a.id);
    expect(ids).toEqual(["go-back", "go-forward", "go-host"]);
  });

  it("omits Workspace on a terminal route when the server is not yet resolved", () => {
    const ids = buildNavActions("terminal", "", noop).map((a) => a.id);
    // No blank-server Workspace entry; Host still present.
    expect(ids).toEqual(["go-back", "go-forward", "go-host"]);
  });

  it("labels the ancestor entries with the new vocabulary", () => {
    const actions = buildNavActions("terminal", "prod", noop);
    const byId = (id: string) => actions.find((a) => a.id === id)!;
    expect(byId("go-tmux-server").label).toBe("Go: Workspace");
    expect(byId("go-host").label).toBe("Go: Host");
  });

  it("wires each action's onSelect to its own handler", () => {
    const handlers = {
      onBack: vi.fn(),
      onForward: vi.fn(),
      onTmuxServer: vi.fn(),
      onHost: vi.fn(),
    };
    const actions = buildNavActions("terminal", "prod", handlers);
    const byId = (id: string) => actions.find((a) => a.id === id)!;
    byId("go-back").onSelect();
    byId("go-forward").onSelect();
    byId("go-tmux-server").onSelect();
    byId("go-host").onSelect();
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    expect(handlers.onForward).toHaveBeenCalledTimes(1);
    expect(handlers.onTmuxServer).toHaveBeenCalledTimes(1);
    expect(handlers.onHost).toHaveBeenCalledTimes(1);
  });
});
