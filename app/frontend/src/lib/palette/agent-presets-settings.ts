/**
 * Pure builder for the palette's way into Settings > Agents > Presets
 * (Constitution V: every control in the Presets section is also a palette
 * action). Every entry only opens the section — focused on the list, the New
 * form, or a named preset's Duplicate / Rename / Delete form — and never
 * writes; the section's own form or confirm does. Duplicate, Rename and Delete
 * open a single-select sub-step over the presets (Rename and Delete list only
 * the ones you can change).
 */
import type { PaletteAction } from "@/components/command-palette";
import type { FabAgentPreset } from "@/api/client";
import type { PresetsIntent } from "@/lib/agent-presets-intent";

type NamedAction = "duplicate" | "rename" | "delete";

const NAMED: { action: NamedAction; label: string; placeholder: string; changeableOnly: boolean }[] = [
  { action: "duplicate", label: "Settings: Duplicate agent preset…", placeholder: "Choose the preset to duplicate", changeableOnly: false },
  { action: "rename", label: "Settings: Rename agent preset…", placeholder: "Choose the preset to rename", changeableOnly: true },
  { action: "delete", label: "Settings: Delete agent preset…", placeholder: "Choose the preset to delete", changeableOnly: true },
];

export function buildPresetSettingsActions({
  open,
  load,
}: {
  /** Opens Settings on the Agents tab and records the intent for the section. */
  open: (intent: PresetsIntent) => void;
  /** The machine-wide preset list (undefined when fab cannot list presets). */
  load: () => Promise<FabAgentPreset[] | undefined>;
}): PaletteAction[] {
  return [
    { id: "settings-agent-presets", label: "Settings: Agent presets", onSelect: () => open({ action: "focus" }) },
    { id: "settings-new-agent-preset", label: "Settings: New agent preset…", onSelect: () => open({ action: "new" }) },
    ...NAMED.map(({ action, label, placeholder, changeableOnly }): PaletteAction => ({
      id: `settings-${action}-agent-preset`,
      label,
      subList: {
        placeholder,
        rows: async () =>
          ((await load()) ?? [])
            .filter((p) => !changeableOnly || p.source === "system")
            .map((p) => ({
              id: `settings-${action}-agent-preset-${p.name}`,
              label: p.name,
              description: p.description,
              onSelect: () => open({ action, name: p.name }),
            })),
      },
      onSelect: () => {},
    })),
  ];
}
