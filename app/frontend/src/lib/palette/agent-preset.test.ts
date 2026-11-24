import { describe, it, expect, vi } from "vitest";
import { buildAgentPresetActions } from "./agent-preset";

const PRESETS = [
  { name: "claude", description: "All roles on Claude", source: "built-in" },
  { name: "codex-review", source: "built-in" },
];

function scope(overrides: { current?: string; present?: boolean; load?: () => Promise<typeof PRESETS | undefined> } = {}) {
  return {
    current: undefined as string | undefined,
    present: true,
    load: () => Promise.resolve<typeof PRESETS | undefined>(PRESETS),
    onSet: vi.fn<(name: string) => void>(),
    onClear: vi.fn<() => void>(),
    ...overrides,
  };
}

describe("buildAgentPresetActions", () => {
  it("offers both Set actions and no Clear while nothing is set", () => {
    const actions = buildAgentPresetActions({ presetsAvailable: true, group: scope(), workspace: scope() });
    expect(actions.map((a) => a.label)).toEqual(["Group: Set Agent Preset…", "Workspace: Set Agent Preset…"]);
  });

  it("adds Clear only for the entity that has a preset", () => {
    const actions = buildAgentPresetActions({
      presetsAvailable: true,
      group: scope({ current: "claude" }),
      workspace: scope(),
    });
    expect(actions.map((a) => a.label)).toEqual([
      "Group: Set Agent Preset…",
      "Group: Clear Agent Preset",
      "Workspace: Set Agent Preset…",
    ]);
  });

  it("hides Set (but keeps Clear, which needs no fab) when fab reports no presets", () => {
    const actions = buildAgentPresetActions({
      presetsAvailable: false,
      group: scope({ current: "stale" }),
      workspace: scope({ current: "old" }),
    });
    expect(actions.map((a) => a.label)).toEqual(["Group: Clear Agent Preset", "Workspace: Clear Agent Preset"]);
  });

  it("drops an entity's actions when it is absent (no current group)", () => {
    const actions = buildAgentPresetActions({
      presetsAvailable: true,
      group: scope({ present: false, current: "claude" }),
      workspace: scope(),
    });
    expect(actions.map((a) => a.label)).toEqual(["Workspace: Set Agent Preset…"]);
  });

  it("the chooser lists every preset plus none and each row sets that name", async () => {
    const group = scope();
    const [set] = buildAgentPresetActions({ presetsAvailable: true, group, workspace: scope({ present: false }) });
    const rows = await (set.subList!.rows as () => Promise<Array<{ label: string; description?: string; onSelect: () => void }>>)();
    expect(rows.map((r) => r.label)).toEqual(["claude", "codex-review", "none"]);
    expect(rows[2].description).toBe("no preset, even the machine default");
    rows[1].onSelect();
    rows[2].onSelect();
    expect(group.onSet.mock.calls).toEqual([["codex-review"], ["none"]]);
  });

  it("an unreadable list still offers none", async () => {
    const group = scope({ load: () => Promise.resolve(undefined) });
    const [set] = buildAgentPresetActions({ presetsAvailable: true, group, workspace: scope({ present: false }) });
    const rows = await (set.subList!.rows as () => Promise<Array<{ label: string }>>)();
    expect(rows.map((r) => r.label)).toEqual(["none"]);
  });

  it("Clear fires the entity's clear callback", () => {
    const workspace = scope({ current: "claude" });
    const actions = buildAgentPresetActions({ presetsAvailable: true, group: scope({ present: false }), workspace });
    actions.find((a) => a.id === "workspace-clear-agent-preset")!.onSelect();
    expect(workspace.onClear).toHaveBeenCalledTimes(1);
  });
});
