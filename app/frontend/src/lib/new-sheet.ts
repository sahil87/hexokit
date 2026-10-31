import { abbreviateHomePath } from "@/lib/format";
import { deriveNameFromPath, toSafeServerName, uniqueName } from "@/lib/names";
import type { ProjectSession, WindowInfo } from "@/types";

/** What the New sheet creates. Order is the level switch's visual order. */
export type NewLevel = "tab" | "group" | "workspace";

export const NEW_LEVELS: readonly NewLevel[] = ["tab", "group", "workspace"];

export const LEVEL_LABEL: Record<NewLevel, string> = {
  tab: "Tab",
  group: "Group",
  workspace: "Workspace",
};

/** The opener seam's request — `server`/`group` pin the target when the caller
 *  (a per-group `+`, a split-button row) knows it; otherwise the host derives
 *  them from the current route. */
export type NewSheetRequest = {
  level: NewLevel;
  server?: string;
  group?: string;
};

/** Step `current` through `available` (wrapping). Returns `current` unchanged
 *  when it is the only choice. */
export function cycleLevel(current: NewLevel, delta: 1 | -1, available: readonly NewLevel[]): NewLevel {
  const levels = NEW_LEVELS.filter((l) => available.includes(l));
  const at = levels.indexOf(current);
  if (at < 0 || levels.length === 0) return levels[0] ?? current;
  return levels[(at + delta + levels.length) % levels.length];
}

/** Display/compare form of a folder: `~`-abbreviated, trimmed, no trailing slash. */
export function normalizeFolder(p: string): string {
  const abbreviated = abbreviateHomePath(p.trim());
  return abbreviated.length > 1 ? abbreviated.replace(/\/+$/, "") : abbreviated;
}

export function windowBranch(w: WindowInfo): string | undefined {
  const panes = w.panes ?? [];
  return (panes.find((p) => p.isActive) ?? panes[0])?.gitBranch || undefined;
}

export type ContextTarget = {
  /** The group a new tab lands in (undefined when the workspace has none). */
  group?: string;
  /** The window whose folder prefills the field. */
  window?: WindowInfo;
};

/**
 * Resolve the group + context window for a workspace's sessions. Precedence:
 * the opener's explicit `group` (its active tab), then the tab being viewed,
 * then the tab last viewed in this workspace, then the first group's active tab.
 */
export function resolveContextTarget(
  sessions: ProjectSession[],
  hint: { group?: string; windowId?: string; lastWindowId?: string | null },
): ContextTarget {
  const activeOf = (s: ProjectSession) => s.windows.find((w) => w.isActiveWindow) ?? s.windows[0];
  const byWindow = (id?: string | null): ContextTarget | undefined => {
    if (!id) return undefined;
    for (const s of sessions) {
      const w = s.windows.find((x) => x.windowId === id);
      if (w) return { group: s.name, window: w };
    }
    return undefined;
  };

  if (hint.group) {
    const s = sessions.find((x) => x.name === hint.group);
    if (s) return { group: s.name, window: activeOf(s) };
  }
  const found = byWindow(hint.windowId) ?? byWindow(hint.lastWindowId);
  if (found) return found;
  const first = sessions[0];
  return first ? { group: first.name, window: activeOf(first) } : {};
}

/** Number of tabs sitting in each folder, keyed by `normalizeFolder`. */
export function countTabsByFolder(sessions: ProjectSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (!w.worktreePath) continue;
      const key = normalizeFolder(w.worktreePath);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export type FolderRow = {
  /** `~`-abbreviated; becomes the field value when picked. */
  path: string;
  branch?: string;
  /** Right-aligned secondary text (`active tab`, `2 tabs open`). */
  meta?: string;
};

export type FolderSection = {
  key: "current" | "worktrees" | "elsewhere";
  title: string;
  rows: FolderRow[];
};

function tabsOpen(n: number | undefined): string | undefined {
  return n ? `${n} tab${n === 1 ? "" : "s"} open` : undefined;
}

export function buildFolderSections(input: {
  contextFolder: string;
  contextBranch?: string;
  repo: string;
  worktrees: { path: string; branch: string }[];
  /** Every tab folder in the workspace (`tabFolders`). */
  openFolders: string[];
  tabCounts: Map<string, number>;
  /** Branch lookup for "Open elsewhere" rows. */
  branchByFolder?: Map<string, string>;
}): FolderSection[] {
  const sections: FolderSection[] = [];
  const listed = new Set<string>();

  const context = input.contextFolder ? normalizeFolder(input.contextFolder) : "";
  if (context) {
    listed.add(context);
    sections.push({
      key: "current",
      title: "Current",
      rows: [{ path: context, branch: input.contextBranch, meta: "active tab" }],
    });
  }

  const worktreeRows: FolderRow[] = [];
  for (const wt of input.worktrees) {
    const path = normalizeFolder(wt.path);
    if (listed.has(path)) continue;
    listed.add(path);
    worktreeRows.push({ path, branch: wt.branch || "detached", meta: tabsOpen(input.tabCounts.get(path)) });
  }
  if (worktreeRows.length > 0) {
    sections.push({ key: "worktrees", title: input.repo ? `Worktrees · ${input.repo}` : "Worktrees", rows: worktreeRows });
  }

  const elsewhereRows: FolderRow[] = [];
  for (const folder of input.openFolders) {
    const path = normalizeFolder(folder);
    if (listed.has(path)) continue;
    listed.add(path);
    elsewhereRows.push({ path, branch: input.branchByFolder?.get(path), meta: tabsOpen(input.tabCounts.get(path)) });
  }
  if (elsewhereRows.length > 0) {
    sections.push({ key: "elsewhere", title: "Open elsewhere", rows: elsewhereRows });
  }
  return sections;
}

/** True when `value` names exactly one of the rows (so the list stays a list
 *  instead of switching to directory autocomplete). */
export function isListMatch(value: string, sections: FolderSection[]): boolean {
  const v = normalizeFolder(value);
  return v === "" || sections.some((s) => s.rows.some((r) => r.path === v));
}

/** The derived name a group/workspace gets from `folder`, deduped against the
 *  live names of that level. Mirrors what the instant paths would pick. */
export function deriveSheetName(
  level: "group" | "workspace",
  folder: string,
  existing: Iterable<string>,
): string {
  const base = deriveNameFromPath(folder);
  if (level === "group") return uniqueName(base || "session", existing);
  return uniqueName(toSafeServerName(base) || "workspace", existing);
}

export type PreviewNode = { label: string; isNew: boolean };

export type Preview = {
  text: string;
  /** Outermost first; the mini tree indents by index. */
  tree: PreviewNode[];
};

export function previewFor(input: {
  level: NewLevel;
  server: string;
  group: string;
  /** The (derived or overridden) name; unused for tabs. */
  name: string;
  folder: string;
}): Preview {
  const folder = input.folder.trim() ? normalizeFolder(input.folder) : "";
  const at = folder || "the default folder";
  const folderLeaf = folder ? deriveNameFromPath(folder) || "main" : "main";

  switch (input.level) {
    case "tab":
      return {
        text: `New tab in ${input.server} › ${input.group} at ${at}`,
        tree: [
          { label: input.server, isNew: false },
          { label: input.group, isNew: false },
          { label: "new tab", isNew: true },
        ],
      };
    case "group":
      return {
        text: `New group ${input.name} in ${input.server}, first tab at ${at}`,
        tree: [
          { label: input.server, isNew: false },
          { label: input.name, isNew: true },
          { label: "first tab", isNew: true },
        ],
      };
    case "workspace":
      return {
        text: `New workspace ${input.name} (tmux -L ${input.name}), first group and tab at ${at}`,
        tree: [
          { label: input.name, isNew: true },
          { label: folderLeaf, isNew: true },
          { label: "first tab", isNew: true },
        ],
      };
  }
}
