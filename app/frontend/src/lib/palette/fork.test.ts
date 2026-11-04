import { describe, it, expect, vi } from "vitest";
import { makeWindow } from "@/test-utils/fixtures";
import { buildForkWindowActions } from "./fork";

// buildForkWindowActions backs the palette fork pair wired in app.tsx — and,
// through the action ids, the `+ Tab` caret menu's Fork rows (which drop out
// whenever these ids are not registered).

describe("buildForkWindowActions", () => {
  it("lists the pair, same-directory first, for a forkable agent window", () => {
    const actions = buildForkWindowActions(makeWindow({ agentProvider: "claude" }), vi.fn());
    expect(actions.map((a) => [a.id, a.label])).toEqual([
      ["fork-window", "Tab: Fork"],
      ["fork-window-worktree", "Tab: Fork in New Worktree"],
    ]);
  });

  it("routes each entry to its fork location", () => {
    const onFork = vi.fn();
    const [same, worktree] = buildForkWindowActions(makeWindow({ agentProvider: "codex" }), onFork);
    same.onSelect();
    worktree.onSelect();
    expect(onFork.mock.calls).toEqual([["checkout"], ["worktree"]]);
  });

  it("omits both on a window with no forkable agent (the flyout's canForkWindow gate)", () => {
    expect(buildForkWindowActions(makeWindow({}), vi.fn())).toEqual([]);
    expect(buildForkWindowActions(makeWindow({ agentProvider: "gemini" }), vi.fn())).toEqual([]);
  });
});
