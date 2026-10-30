/**
 * Pure builder for the command-palette session sort action
 * (`Session: Sort windows…`) — the keyboard entry point for the sort-windows
 * verb (Constitution V). Follows the lib/palette/shell.ts / lib/palette/zen.ts
 * pure-builder convention so gating is unit-testable without mounting the
 * shell.
 *
 * The entry exists only with a current session (the terminal route's
 * sessionName gate — the same gate the other `Session:` verbs use). It opens
 * the palette's optionPicker sub-step: Space toggles keys (badge order =
 * priority: first key primary, later keys tie-breaks), Enter applies the
 * ordered composite. No success toast on apply: the reorder is immediately
 * visible via SSE.
 */
import type { PaletteAction } from "@/components/command-palette";
import type { SortWindowsBy } from "@/api/client";

/** The single sort entry for `sessionName`; `[]` without a current session. */
export function buildSessionSortActions(
  sessionName: string | null,
  onSort: (by: SortWindowsBy[]) => void,
): PaletteAction[] {
  if (!sessionName) return [];
  return [
    {
      id: "session-sort-windows",
      label: "Group: Sort tabs…",
      optionPicker: {
        options: [
          { key: "status", label: "By status" },
          { key: "created", label: "By created" },
          { key: "name", label: "By name" },
        ],
        placeholder: "Pick sort keys — Space toggle · Enter apply",
        onApply: (keys) => onSort(keys as SortWindowsBy[]),
      },
      onSelect: () => {},
    },
  ];
}
