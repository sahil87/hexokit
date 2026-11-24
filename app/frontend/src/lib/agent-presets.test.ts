import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFabConfig, type FabAgentPreset, type FabConfigDocument } from "@/api/client";
import {
  buildAgentPresetChoices,
  displayAgentPresetName,
  loadMachineAgentPresetInfo,
  loadMachineAgentPresets,
  resolveAgentPreset,
  resetAgentPresetCache,
} from "./agent-presets";

vi.mock("@/api/client", () => ({ getFabConfig: vi.fn() }));

const PRESETS: FabAgentPreset[] = [
  { name: "claude", description: "All roles on Claude", source: "built-in" },
  { name: "codex-review", description: "Only review on Codex", source: "built-in" },
  { name: "codex-workers", source: "built-in" },
];

function fabDocument(defaultValue: string | number | boolean | null): FabConfigDocument {
  return {
    installed: true,
    systemPath: "/tmp/fab/config.yaml",
    tools: [],
    agent_presets: PRESETS,
    fields: { "agent.preset": { value: defaultValue, origin: "system" } },
    roles: [],
    modelSuggestions: {},
    effortSuggestions: [],
  };
}

beforeEach(() => {
  resetAgentPresetCache();
  vi.mocked(getFabConfig).mockReset();
});

describe("loadMachineAgentPresetInfo", () => {
  it("returns the list and default from one cached config read", async () => {
    vi.mocked(getFabConfig).mockResolvedValue(fabDocument("claude"));

    await expect(loadMachineAgentPresetInfo()).resolves.toEqual({ presets: PRESETS, machineDefault: "claude" });
    await expect(loadMachineAgentPresets()).resolves.toBe(PRESETS);
    expect(getFabConfig).toHaveBeenCalledTimes(1);
  });

  it.each(["", null, 4, false])("treats a non-string or empty default as unset: %j", async (value) => {
    vi.mocked(getFabConfig).mockResolvedValue(fabDocument(value));
    await expect(loadMachineAgentPresetInfo()).resolves.toEqual({ presets: PRESETS, machineDefault: undefined });
  });

  it("degrades to empty info when fab is absent or the read fails", async () => {
    vi.mocked(getFabConfig).mockResolvedValueOnce({ installed: false });
    await expect(loadMachineAgentPresetInfo()).resolves.toEqual({});

    resetAgentPresetCache();
    vi.mocked(getFabConfig).mockRejectedValueOnce(new Error("offline"));
    await expect(loadMachineAgentPresetInfo()).resolves.toEqual({});
  });
});

describe("resolveAgentPreset", () => {
  it.each([
    [{ own: "codex-review", workspace: "codex-workers", machineDefault: "claude" }, { name: "codex-review", source: "set here" }],
    [{ workspace: "codex-workers", machineDefault: "claude" }, { name: "codex-workers", source: "from workspace" }],
    [{ machineDefault: "claude" }, { name: "claude", source: "machine default" }],
    [{}, { name: undefined, source: "fab's defaults" }],
    [{ own: "", workspace: "", machineDefault: "" }, { name: undefined, source: "fab's defaults" }],
    [{ own: "none", workspace: "claude" }, { name: "none", source: "set here" }],
    [{ workspace: "none", machineDefault: "claude" }, { name: "none", source: "from workspace" }],
    [{ machineDefault: "none" }, { name: "none", source: "machine default" }],
  ])("resolves %j", (args, expected) => {
    expect(resolveAgentPreset(args)).toEqual(expected);
  });
});

describe("preset display and choices", () => {
  it.each([
    [{ own: "codex-review" }, "codex-review"],
    [{ own: "old-preset" }, "old-preset (unknown)"],
    [{ own: "none" }, "none (no preset)"],
    [{ workspace: "codex-workers" }, "codex-workers"],
    [{ machineDefault: "claude" }, "claude"],
    [{}, "none"],
  ])("renders the effective display name for %j", (args, expected) => {
    expect(displayAgentPresetName(resolveAgentPreset(args).name, PRESETS)).toBe(expected);
  });

  it("builds inherit, presets and none with descriptions and the current choice", () => {
    const choices = buildAgentPresetChoices({
      presets: PRESETS,
      inherited: resolveAgentPreset({ workspace: "codex-workers" }),
    });

    expect(choices.map(({ value, label, description, checked }) => ({ value, label, description, checked }))).toEqual([
      { value: null, label: "inherit", description: "uses codex-workers (from workspace)", checked: true },
      { value: "claude", label: "claude", description: "All roles on Claude", checked: false },
      { value: "codex-review", label: "codex-review", description: "Only review on Codex", checked: false },
      { value: "codex-workers", label: "codex-workers", description: undefined, checked: false },
      { value: "none", label: "none", description: "no preset, even the machine default", checked: false },
    ]);
  });

  it("uses fab's defaults in the inherit description", () => {
    const [inherit] = buildAgentPresetChoices({ presets: PRESETS, inherited: resolveAgentPreset({}) });
    expect(inherit.description).toBe("uses none (fab's defaults)");
  });

  it.each(["codex-review", "none"])("marks the own value %s", (own) => {
    const choices = buildAgentPresetChoices({ presets: PRESETS, own, inherited: resolveAgentPreset({}) });
    expect(choices.filter((choice) => choice.checked).map((choice) => choice.value)).toEqual([own]);
  });

  it("marks nothing for an unknown own value", () => {
    const choices = buildAgentPresetChoices({ presets: PRESETS, own: "old-preset", inherited: resolveAgentPreset({}) });
    expect(choices.some((choice) => choice.checked)).toBe(false);
  });
});
