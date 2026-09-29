import { describe, it, expect, vi } from "vitest";
import { buildCodeActions } from "./code";

/**
 * `buildCodeActions` — the palette's `Code: Follow Terminal` /
 * `Code: Reload Editor` rows (the code tile header verbs' Constitution V
 * parity). The caller gates the offer on the terminal route, so the builder
 * itself is route-agnostic. Pure-builder tests in the `palette/zen.test.ts`
 * pattern.
 */

const base = { onFollowTerminal: vi.fn(), onReload: vi.fn(), unreachable: false, onRestartServer: vi.fn() };

describe("buildCodeActions — gating", () => {
  it("offers both rows when the tile is open with drift and a mounted frame", () => {
    const actions = buildCodeActions({
      ...base,
      codeTileOpen: true,
      followTarget: "/repo.worktrees/x",
      frameMounted: true,
    });
    expect(actions.map((a) => a.id)).toEqual(["code-follow-terminal", "code-reload-editor"]);
  });

  it("offers only Reload Editor without drift (roots agree or either empty)", () => {
    const actions = buildCodeActions({
      ...base,
      codeTileOpen: true,
      followTarget: null,
      frameMounted: true,
    });
    expect(actions.map((a) => a.id)).toEqual(["code-reload-editor"]);
  });

  it("offers only Follow Terminal while no frame is mounted (pending/unreachable)", () => {
    const actions = buildCodeActions({
      ...base,
      codeTileOpen: true,
      followTarget: "/other",
      frameMounted: false,
    });
    expect(actions.map((a) => a.id)).toEqual(["code-follow-terminal"]);
  });

  it("offers Restart code-server only while code-server is unreachable", () => {
    const actions = buildCodeActions({
      ...base,
      codeTileOpen: true,
      followTarget: null,
      frameMounted: false,
      unreachable: true,
    });
    expect(actions.map((a) => a.id)).toEqual(["code-restart-server"]);
    actions[0].onSelect();
    expect(base.onRestartServer).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when the code tile is closed", () => {
    expect(
      buildCodeActions({ ...base, codeTileOpen: false, followTarget: "/other", frameMounted: true }),
    ).toEqual([]);
  });
});

describe("buildCodeActions — row shape", () => {
  it("the Follow row's description names the target's basename", () => {
    const [follow] = buildCodeActions({
      ...base,
      codeTileOpen: true,
      followTarget: "/home/u/repo.worktrees/flowing-ridge",
      frameMounted: false,
    });
    expect(follow.label).toBe("Code: Follow Terminal");
    expect(follow.description).toBe("→ flowing-ridge");
  });

  it("both rows resolve the header verbs' bodies (the codeCommandsRef seam)", () => {
    const onFollowTerminal = vi.fn();
    const onReload = vi.fn();
    const [follow, reload] = buildCodeActions({
      codeTileOpen: true,
      followTarget: "/other",
      frameMounted: true,
      onFollowTerminal,
      onReload,
      unreachable: false,
      onRestartServer: vi.fn(),
    });
    follow.onSelect();
    reload.onSelect();
    expect(onFollowTerminal).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
