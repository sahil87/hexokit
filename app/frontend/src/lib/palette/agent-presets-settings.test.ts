import { describe, it, expect, vi } from "vitest";
import type { FabAgentPreset } from "@/api/client";
import type { PaletteAction } from "@/components/command-palette";
import { buildPresetSettingsActions } from "./agent-presets-settings";

async function subRows(action: PaletteAction): Promise<PaletteAction[]> {
  const rows = action.subList!.rows;
  return typeof rows === "function" ? rows() : rows;
}

const PRESETS: FabAgentPreset[] = [
  { name: "claude", description: "All on Claude", source: "built-in" },
  { name: "night-shift", description: "Overnight", source: "system" },
];

function build() {
  const open = vi.fn();
  const actions = buildPresetSettingsActions({ open, load: async () => PRESETS });
  return { open, actions, byId: (id: string) => actions.find((a) => a.id === id)! };
}

describe("buildPresetSettingsActions", () => {
  it("registers the five entries with the documented labels", () => {
    expect(build().actions.map((a) => a.label)).toEqual([
      "Settings: Agent presets",
      "Settings: New agent preset…",
      "Settings: Duplicate agent preset…",
      "Settings: Rename agent preset…",
      "Settings: Delete agent preset…",
    ]);
  });

  it("opens the section focused, or with the New form, and does nothing else", () => {
    const { open, byId } = build();
    byId("settings-agent-presets").onSelect();
    byId("settings-new-agent-preset").onSelect();
    expect(open.mock.calls).toEqual([[{ action: "focus" }], [{ action: "new" }]]);
  });

  it("Duplicate lists every preset; Rename and Delete only the ones you can change", async () => {
    const { byId } = build();
    const names = async (id: string) => (await subRows(byId(id))).map((r) => r.label);
    expect(await names("settings-duplicate-agent-preset")).toEqual(["claude", "night-shift"]);
    expect(await names("settings-rename-agent-preset")).toEqual(["night-shift"]);
    expect(await names("settings-delete-agent-preset")).toEqual(["night-shift"]);
  });

  it("a sub-step pick opens that preset's form or confirm — it never writes", async () => {
    const { open, byId } = build();
    for (const action of ["duplicate", "rename", "delete"] as const) {
      const rows = await subRows(byId(`settings-${action}-agent-preset`));
      rows.find((r) => r.label === "night-shift")!.onSelect();
      expect(open).toHaveBeenLastCalledWith({ action, name: "night-shift" });
    }
  });

  it("offers an empty sub-step when fab lists no presets", async () => {
    const actions = buildPresetSettingsActions({ open: vi.fn(), load: async () => undefined });
    expect(await subRows(actions[2])).toEqual([]);
  });
});
