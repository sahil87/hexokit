import { describe, it, expect } from "vitest";
import type { FabAgentPreset, FabConfigDocument, FabField, FabRole, FabRoleCell, ServerInfo } from "@/api/client";
import type { ProjectSession } from "@/types";
import {
  MSG_NAME_CHARS,
  MSG_NAME_REQUIRED,
  MSG_NAME_RESERVED,
  depthKnobApplies,
  duplicateName,
  emptiesPreset,
  inheritanceLosses,
  looseValues,
  presetFieldMap,
  presetNameError,
  presetRoleRows,
  presetUsage,
  uniqueName,
  usageLabels,
} from "./agent-presets-editor";

type Doc = Extract<FabConfigDocument, { installed: true }>;

const cell = (override: string | null, effective = override ?? ""): FabRoleCell => ({
  override,
  effective,
  source: "",
  origin: override === null ? "default" : "system",
  inherited: "",
});

const role = (name: string, depth: FabRole["depth"], over: Partial<FabRole> = {}): FabRole => ({
  role: name,
  depth,
  tool: cell(null, "claude"),
  model: cell(null),
  effort: cell(null),
  ...over,
});

const field = (value: FabField["value"], origin: FabField["origin"], extra: Partial<FabField> = {}): FabField => ({
  value,
  origin,
  ...extra,
});

function doc(over: Partial<Doc> = {}): Doc {
  return {
    installed: true,
    systemPath: "/home/u/.fab-kit/config.yaml",
    tools: ["claude", "codex"],
    fields: { "agent.session": field("claude", "default"), "agent.workers": field("claude", "default") },
    roles: [role("default", "session"), role("doing", "workers"), role("review", "workers")],
    modelSuggestions: {},
    effortSuggestions: [],
    ...over,
  };
}

const PRESET: FabAgentPreset = {
  name: "night-shift",
  description: "Overnight",
  source: "system",
  workers: "codex",
  profiles: { review: { cli: "codex", effort: "xhigh" } },
};

describe("presetNameError", () => {
  const taken = ["claude", "night-shift"];
  it.each([
    ["", MSG_NAME_REQUIRED],
    ["night shift", MSG_NAME_CHARS],
    ["-x", MSG_NAME_CHARS],
    ["a.b", MSG_NAME_CHARS],
    ["x".repeat(65), MSG_NAME_CHARS],
    ["none", MSG_NAME_RESERVED],
    ["claude", "A preset named claude already exists."],
  ])("%j → %s", (name, want) => {
    expect(presetNameError(name, taken)).toBe(want);
  });
  it("accepts identifiers, mixed case and a leading underscore", () => {
    for (const name of ["late-shift", "Late_Shift2", "_x", "x".repeat(64)]) expect(presetNameError(name, taken)).toBe("");
  });
});

describe("unique names", () => {
  it("returns the base while free, then numbers from 2", () => {
    expect(uniqueName("a", ["b"])).toBe("a");
    expect(uniqueName("a", ["a"])).toBe("a-2");
    expect(uniqueName("a", ["a", "a-2", "a-3"])).toBe("a-4");
  });
  it("makes the duplicate name <name>-copy, then -copy-2", () => {
    expect(duplicateName("claude", ["claude"])).toBe("claude-copy");
    expect(duplicateName("claude", ["claude", "claude-copy"])).toBe("claude-copy-2");
  });
});

describe("emptiesPreset", () => {
  const solo: FabAgentPreset = { name: "solo", description: "d", source: "system" };
  it("is true only when an unset removes the last field", () => {
    expect(emptiesPreset(solo, { "agent_presets.solo.description": null })).toBe(true);
    expect(emptiesPreset(solo, { "agent_presets.solo.description": "" })).toBe(true);
    expect(emptiesPreset(PRESET, { "agent_presets.night-shift.workers": null })).toBe(false);
  });
  it("counts a set in the same patch and ignores other presets' keys", () => {
    expect(emptiesPreset(solo, { "agent_presets.solo.description": null, "agent_presets.solo.workers": "codex" })).toBe(false);
    expect(emptiesPreset(solo, { "agent_presets.other.description": null })).toBe(false);
  });
});

describe("presetFieldMap", () => {
  it("flattens description, depths and role leaves", () => {
    expect(presetFieldMap(PRESET)).toEqual({
      description: "Overnight",
      workers: "codex",
      "profiles.review.cli": "codex",
      "profiles.review.effort": "xhigh",
    });
  });
});

describe("usage", () => {
  const servers: ServerInfo[] = [{ name: "default", sessionCount: 1, agent_preset: "night-shift" } as ServerInfo, { name: "work", sessionCount: 0 } as ServerInfo];
  const sessions = new Map<string, ProjectSession[]>([
    ["default", [{ name: "hexokit", agent_preset: "night-shift" } as ProjectSession, { name: "other" } as ProjectSession]],
    ["work", [{ name: "api", agent_preset: "claude" } as ProjectSession]],
  ]);
  it("lists the machine default, then workspaces, then groups", () => {
    expect(usageLabels(presetUsage("night-shift", "night-shift", servers, sessions))).toEqual([
      "the machine default",
      "workspace default",
      "group hexokit",
    ]);
    expect(usageLabels(presetUsage("claude", "", servers, sessions))).toEqual(["group api"]);
    expect(usageLabels(presetUsage("nobody", "", servers, sessions))).toEqual([]);
  });
});

describe("depthKnobApplies", () => {
  it("is the explicit env or system value, else claude — never a preset's", () => {
    expect(depthKnobApplies(doc({ fields: { "agent.workers": field("codex", "system") } }), "workers")).toBe("codex");
    expect(depthKnobApplies(doc({ fields: { "agent.workers": field("codex", "env") } }), "workers")).toBe("codex");
    expect(depthKnobApplies(doc({ fields: { "agent.workers": field("codex", "system", { preset: "p" }) } }), "workers")).toBe("claude");
    expect(depthKnobApplies(doc({ fields: { "agent.workers": field("codex", "default") } }), "workers")).toBe("claude");
    expect(depthKnobApplies(doc({ fields: {} }), "session")).toBe("claude");
  });
});

describe("presetRoleRows", () => {
  const resolved = { review: { cli: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, doing: { cli: "", model: "", effort: "" } };
  it("makes the preset's own leaves the overrides and fills the rest from fab's resolution", () => {
    const rows = presetRoleRows(doc(), { ...PRESET, profiles: { review: { cli: "codex" } } }, resolved);
    const review = rows.find((r) => r.role === "review")!;
    expect(review.tool).toMatchObject({ override: "codex", effective: "codex" });
    expect(review.model).toMatchObject({ override: null, effective: "gpt-5.6-sol" });
    expect(review.effort).toMatchObject({ override: null, effective: "xhigh" });
  });
  it("falls back to the preset's depth, then the knob, for the CLI of an unresolved role", () => {
    const rows = presetRoleRows(doc({ fields: { "agent.session": field("claude", "default"), "agent.workers": field("kimi", "system") } }), { ...PRESET, workers: "" }, resolved);
    expect(rows.find((r) => r.role === "doing")!.tool).toMatchObject({ override: null, effective: "kimi", inherited: "kimi" });
    const withWorkers = presetRoleRows(doc(), PRESET, undefined);
    expect(withWorkers.find((r) => r.role === "doing")!.tool).toMatchObject({ effective: "codex", inherited: "codex" });
    expect(withWorkers.find((r) => r.role === "doing")!.model).toMatchObject({ override: null, effective: "" });
  });
});

describe("looseValues", () => {
  it("lists explicit system knobs and role leaves, in plain words", () => {
    const loose = looseValues(
      doc({
        fields: { "agent.session": field("codex", "system"), "agent.workers": field("claude", "default") },
        roles: [
          role("review", "workers", { tool: cell("codex"), effort: cell("xhigh") }),
          role("doing", "workers"),
        ],
      }),
    );
    expect(loose).toEqual([
      { field: "session", label: "session CLI = codex" },
      { field: "profiles.review.cli", label: "review CLI = codex" },
      { field: "profiles.review.effort", label: "review effort = xhigh" },
    ]);
  });
  it("ignores env-origin and preset-supplied values", () => {
    expect(
      looseValues(
        doc({
          fields: { "agent.session": field("codex", "env"), "agent.workers": field("codex", "system", { preset: "p" }) },
        }),
      ),
    ).toEqual([]);
  });
});

describe("inheritanceLosses", () => {
  const loose = [
    { field: "profiles.review.effort", label: "review effort = low" },
    { field: "profiles.review.cli", label: "review CLI = codex" },
  ];
  const presets: FabAgentPreset[] = [
    { name: "codex-review", source: "built-in", profiles: { review: { cli: "codex" } } },
    { name: "claude", source: "built-in", session: "claude" },
  ];
  const servers = [{ name: "default", agent_preset: "claude" } as ServerInfo];
  const sessions = new Map([["default", [{ name: "hexokit", agent_preset: "codex-review" } as ProjectSession, { name: "plain" } as ProjectSession]]]);

  it("names each entity with its own preset and only the loose values that preset leaves unset", () => {
    expect(inheritanceLosses(loose, presets, servers, sessions)).toEqual([
      { entity: "workspace default", losses: ["review effort = low", "review CLI = codex"] },
      { entity: "group hexokit", losses: ["review effort = low"] },
    ]);
  });
  it("loses everything under `none` and ignores a name fab does not list", () => {
    const s = new Map([["default", [{ name: "a", agent_preset: "none" } as ProjectSession, { name: "b", agent_preset: "gone" } as ProjectSession]]]);
    expect(inheritanceLosses(loose, presets, [], s)).toEqual([{ entity: "group a", losses: ["review effort = low", "review CLI = codex"] }]);
  });
  it("is empty when nothing has its own preset or nothing is loose", () => {
    expect(inheritanceLosses(loose, presets, [], new Map())).toEqual([]);
    expect(inheritanceLosses([], presets, servers, sessions)).toEqual([]);
  });
});
