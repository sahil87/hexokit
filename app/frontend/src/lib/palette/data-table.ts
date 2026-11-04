/**
 * Pure builder for the `Table: Reset columns` palette action — Constitution V
 * keyboard parity for the DataTable's mouse-only column resize. Follows the
 * lib/palette/cron.ts pure-builder convention so the gating and label
 * composition are unit-testable without mounting the shell. The action is
 * omitted with no mounted table (omit-not-disable), direct with one, and a
 * `…` optionPicker with two or more; applying the picker resets each picked
 * table's `hexokit-table-<id>` view state (sort back to its initial order,
 * widths back to defaults).
 */
import type { PaletteAction } from "@/components/command-palette";
import { resetDataTableViewState } from "@/components/data-table";

export function buildDataTableActions(
  mounted: { id: string; label: string }[],
  reset: (tableId: string) => void = resetDataTableViewState,
): PaletteAction[] {
  if (mounted.length === 0) return [];
  if (mounted.length === 1 && mounted[0]) {
    const only = mounted[0];
    return [
      {
        id: "table-reset-columns",
        label: "Table: Reset columns",
        onSelect: () => reset(only.id),
      },
    ];
  }
  return [
    {
      id: "table-reset-columns",
      label: "Table: Reset columns…",
      optionPicker: {
        options: mounted.map((m) => ({ key: m.id, label: m.label })),
        placeholder: "Pick a table to reset — Space toggle · Enter apply",
        onApply: (keys) => keys.forEach((key) => reset(key)),
      },
      onSelect: () => {},
    },
  ];
}
