/**
 * Pure builder for the command-palette agent-preset actions — the keyboard path
 * for the group and workspace agent presets (Constitution V). Follows the
 * lib/palette/server-protect.ts convention: dependency-free and unit-testable;
 * the caller wires the four callbacks to the API (app.tsx).
 *
 * `Set` opens the palette's single-select sub-step (PaletteAction.subList) with
 * one row per preset plus `none`; the rows load lazily on entry, so the
 * group's repo-scoped list can be fetched only when the user actually opens
 * the chooser. `Clear` exists only while the entity has a preset. Both `Set`
 * actions are hidden when fab reports no presets (`presetsAvailable` false).
 */
import type { PaletteAction } from "@/components/command-palette";
import type { FabAgentPreset } from "@/api/client";
import { NO_AGENT_PRESET } from "@/lib/agent-presets";

type Scope = {
  /** `Group` or `Workspace` — the label prefix. */
  noun: "Group" | "Workspace";
  /** The entity's current preset name; absent/empty when unset. */
  current: string | undefined;
  /** False hides the entity's actions entirely (no group / no server). */
  present: boolean;
  /** Loads the preset list the chooser offers (undefined = none available). */
  load: () => Promise<FabAgentPreset[] | undefined>;
  onSet: (name: string) => void;
  onClear: () => void;
};

export function buildAgentPresetActions({
  presetsAvailable,
  group,
  workspace,
}: {
  presetsAvailable: boolean;
  group: Omit<Scope, "noun">;
  workspace: Omit<Scope, "noun">;
}): PaletteAction[] {
  return [
    ...scopeActions(presetsAvailable, { noun: "Group", ...group }),
    ...scopeActions(presetsAvailable, { noun: "Workspace", ...workspace }),
  ];
}

function scopeActions(presetsAvailable: boolean, scope: Scope): PaletteAction[] {
  if (!scope.present) return [];
  const id = scope.noun.toLowerCase();
  const actions: PaletteAction[] = [];
  if (presetsAvailable) {
    actions.push({
      id: `${id}-set-agent-preset`,
      label: `${scope.noun}: Set Agent Preset…`,
      subList: {
        placeholder: `Choose the ${id}'s agent preset`,
        rows: async () => {
          const presets = (await scope.load()) ?? [];
          return [
            ...presets.map((p) => ({
              id: `${id}-agent-preset-${p.name}`,
              label: p.name,
              description: p.description,
              onSelect: () => scope.onSet(p.name),
            })),
            {
              id: `${id}-agent-preset-${NO_AGENT_PRESET}`,
              label: NO_AGENT_PRESET,
              description: "no preset, even the machine default",
              onSelect: () => scope.onSet(NO_AGENT_PRESET),
            },
          ];
        },
      },
      onSelect: () => {},
    });
  }
  if (scope.current) {
    actions.push({
      id: `${id}-clear-agent-preset`,
      label: `${scope.noun}: Clear Agent Preset`,
      onSelect: scope.onClear,
    });
  }
  return actions;
}
