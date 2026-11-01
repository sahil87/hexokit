/**
 * Pure model of the `+ New` split button: which create the primary segment
 * performs on each route, the caret menu's sections and rows, and the head's
 * measured fold decision. The component (components/new-split-button.tsx) owns
 * rendering and DOM measurement; this module owns only the decisions, so they
 * are unit-testable without a layout engine.
 *
 * Every primary/row names a PALETTE ACTION ID (Constitution V — no
 * toolbar-only functionality): the component resolves the id against the live
 * palette list at click time, so the control can never drift from the palette.
 */
import type { TopBarMode } from "@/components/top-bar";

/** Primary segment spec per route. `caret: false` is the host page's plain
 *  `+ Workspace` button (there is no instant workspace create to pair a menu
 *  with — the primary itself opens the New sheet). */
export type NewSplitPrimary = {
  label: string;
  /** Tooltip text before the chord suffix. */
  tip: string;
  actionId: string;
  caret: boolean;
};

export function newSplitPrimary(mode: TopBarMode): NewSplitPrimary {
  switch (mode) {
    case "terminal":
    case "board":
      return { label: "+ Tab", tip: "New tab", actionId: "create-window", caret: true };
    case "server":
      return { label: "+ Group", tip: "New group", actionId: "create-session-instant", caret: true };
    case "host":
      return { label: "+ Workspace", tip: "New workspace", actionId: "create-server", caret: false };
  }
}

export type NewSplitRow = {
  /** Palette action id the row invokes. Doubles as the keycap's binding id. */
  actionId: string;
  label: string;
  /** Leading glyph (aria-hidden decoration — the top bar's mirrored-row rule). */
  glyph: string;
};

export type NewSplitSection = {
  /** `IN <target>` header naming where the result lands; absent on the
   *  trailing workspace row's group. */
  header?: string;
  rows: NewSplitRow[];
};

/** The workspace/group the menu's results land in. `group` is null when the
 *  route has none (server route; an empty board). */
export type NewSplitTarget = { server: string; group: string | null };

const WORKSPACE_ROW: NewSplitRow = { actionId: "create-server", label: "Workspace…", glyph: "◫" };

/** Menu sections for a route. Sections are grouped by where the result lands. */
export function newSplitSections(mode: TopBarMode, target: NewSplitTarget): NewSplitSection[] {
  if (mode === "host") return [];
  const sections: NewSplitSection[] = [];
  const { server, group } = target;
  if ((mode === "terminal" || mode === "board") && server && group) {
    sections.push({
      header: `IN ${server} › ${group}`,
      rows: [
        { actionId: "create-window", label: "Tab", glyph: "＋" },
        { actionId: "create-window-at-folder", label: "Tab at folder…", glyph: "▱" },
        { actionId: "agent-spawn", label: "Agent tab…", glyph: "✦" },
        { actionId: "create-iframe-window", label: "Web tab…", glyph: "◎" },
        { actionId: "reopen-window", label: "Reopen closed tab", glyph: "↺" },
      ],
    });
  }
  if (server) {
    sections.push({
      header: `IN ${server}`,
      rows: [
        // The board has no name-prompt dialog, so its Group row is the instant
        // create; everywhere else it is the name-prompted `create-session`.
        {
          actionId: mode === "board" ? "create-session-instant" : "create-session",
          label: "Group",
          glyph: "▤",
        },
        { actionId: "create-session-at-folder", label: "Group at folder…", glyph: "▱" },
      ],
    });
  }
  sections.push({ rows: [WORKSPACE_ROW] });
  return sections;
}

/** Fold rungs of the sidebar head: 1 = logo + wordmark + full split,
 *  2 = wordmark hidden, 3 = icon-only split. */
export type HeadRung = 1 | 2 | 3;

/** One-sided hysteresis on the EXPAND edge, in px (the gui-toolbar-fold and
 *  crumb-collapse precedent). */
export const NEW_SPLIT_FOLD_HYSTERESIS_PX = 24;

/**
 * The next fold rung for one measurement.
 *
 * - `available` — the head's content width.
 * - `needed` — the intrinsic content width measured AT each rung already
 *   visited (the component records one entry per rendered rung; the rungs are
 *   measured by rendering them, so a rung's width is only known after it has
 *   rendered once).
 *
 * Folding is immediate: when the current rung's content overflows, step to the
 * next (the layout effect re-runs and measures it). Expanding needs the
 * previous rung's recorded width plus the hysteresis margin to fit, so a drag
 * hovering a boundary cannot flap. Unmeasured environments (jsdom, pre-mount:
 * zero widths) hold the previous rung.
 */
export function nextHeadRung(
  prev: HeadRung,
  available: number,
  needed: Partial<Record<HeadRung, number>>,
  hysteresisPx: number = NEW_SPLIT_FOLD_HYSTERESIS_PX,
): HeadRung {
  const current = needed[prev];
  if (available <= 0 || current === undefined || current <= 0) return prev;
  if (current > available) return prev < 3 ? ((prev + 1) as HeadRung) : prev;
  if (prev > 1) {
    const wider = needed[(prev - 1) as HeadRung];
    if (wider !== undefined && wider > 0 && wider + hysteresisPx <= available) {
      return (prev - 1) as HeadRung;
    }
  }
  return prev;
}
