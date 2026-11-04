/**
 * Pure builder for the fork pair — `Tab: Fork` (same directory, 260806-s4av)
 * and `Tab: Fork in New Worktree` (new worktree + branch at the source HEAD).
 * The palette arm of the row flyout's two fork rows, gated by the SAME
 * `canForkWindow` predicate so palette/flyout parity holds by construction
 * (omit-not-disable: a window with no forkable agent lists neither). The
 * `+ Tab` caret menu's Fork rows resolve these ids at click time, so this gate
 * is also theirs.
 */
import type { ForkWhere } from "@/api/client";
import type { PaletteAction } from "@/components/command-palette";
import { canForkWindow } from "@/components/sidebar/row-flyout-card";
import type { WindowInfo } from "@/types";

export function buildForkWindowActions(win: WindowInfo, onFork: (where: ForkWhere) => void): PaletteAction[] {
  if (!canForkWindow(win)) return [];
  return [
    { id: "fork-window", label: "Tab: Fork", onSelect: () => onFork("checkout") },
    { id: "fork-window-worktree", label: "Tab: Fork in New Worktree", onSelect: () => onFork("worktree") },
  ];
}
