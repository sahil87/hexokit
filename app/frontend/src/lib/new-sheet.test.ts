import { describe, expect, it } from "vitest";
import {
  buildFolderSections,
  countTabsByFolder,
  cycleLevel,
  deriveSheetName,
  isListMatch,
  normalizeFolder,
  previewFor,
  resolveContextTarget,
  windowBranch,
} from "./new-sheet";
import { uniqueName } from "./names";
import type { ProjectSession, WindowInfo } from "@/types";

function win(id: string, path: string, over: Partial<WindowInfo> = {}): WindowInfo {
  return {
    windowId: id,
    index: 0,
    name: id,
    worktreePath: path,
    activity: "idle",
    isActiveWindow: false,
    activityTimestamp: 0,
    ...over,
  } as WindowInfo;
}

function sess(name: string, windows: WindowInfo[]): ProjectSession {
  return { name, windows } as ProjectSession;
}

describe("uniqueName", () => {
  it("returns the base when free", () => {
    expect(uniqueName("app", ["other"])).toBe("app");
  });
  it("appends -2 … -10 then -11", () => {
    expect(uniqueName("app", ["app"])).toBe("app-2");
    expect(uniqueName("app", ["app", "app-2"])).toBe("app-3");
    const all = ["app", ...Array.from({ length: 9 }, (_, i) => `app-${i + 2}`)];
    expect(uniqueName("app", all)).toBe("app-11");
  });
});

describe("cycleLevel", () => {
  it("steps and wraps through the available levels", () => {
    const all = ["tab", "group", "workspace"] as const;
    expect(cycleLevel("tab", 1, all)).toBe("group");
    expect(cycleLevel("workspace", 1, all)).toBe("tab");
    expect(cycleLevel("tab", -1, all)).toBe("workspace");
  });
  it("skips unavailable levels", () => {
    expect(cycleLevel("workspace", 1, ["group", "workspace"])).toBe("group");
    expect(cycleLevel("workspace", 1, ["workspace"])).toBe("workspace");
  });
});

describe("normalizeFolder", () => {
  it("abbreviates home and trims trailing slashes", () => {
    expect(normalizeFolder("/home/u/code/app/")).toBe("~/code/app");
    expect(normalizeFolder("  ~/code/app//")).toBe("~/code/app");
    expect(normalizeFolder("/")).toBe("/");
  });
});

describe("windowBranch", () => {
  it("prefers the active pane's branch", () => {
    const w = win("@1", "/x", {
      panes: [
        { paneId: "%1", paneIndex: 0, cwd: "/x", command: "zsh", isActive: false, gitBranch: "a" },
        { paneId: "%2", paneIndex: 1, cwd: "/x", command: "zsh", isActive: true, gitBranch: "b" },
      ],
    });
    expect(windowBranch(w)).toBe("b");
    expect(windowBranch(win("@2", "/x"))).toBeUndefined();
  });
});

describe("resolveContextTarget", () => {
  const sessions = [
    sess("alpha", [win("@1", "/home/u/a"), win("@2", "/home/u/a2", { isActiveWindow: true })]),
    sess("beta", [win("@3", "/home/u/b", { isActiveWindow: true })]),
  ];
  it("an explicit group wins and uses its active tab", () => {
    const t = resolveContextTarget(sessions, { group: "beta", windowId: "@1" });
    expect(t.group).toBe("beta");
    expect(t.window?.windowId).toBe("@3");
  });
  it("falls back to the viewed tab, then the last-viewed tab, then the first group", () => {
    expect(resolveContextTarget(sessions, { windowId: "@1" })).toMatchObject({ group: "alpha" });
    expect(resolveContextTarget(sessions, { lastWindowId: "@3" }).window?.windowId).toBe("@3");
    expect(resolveContextTarget(sessions, {}).window?.windowId).toBe("@2");
  });
  it("is empty for a workspace with no groups", () => {
    expect(resolveContextTarget([], {})).toEqual({});
  });
});

describe("countTabsByFolder", () => {
  it("counts every tab, keyed by normalized folder", () => {
    const counts = countTabsByFolder([
      sess("a", [win("@1", "/home/u/x"), win("@2", "/home/u/x/")]),
      sess("b", [win("@3", "/home/u/y")]),
    ]);
    expect(counts.get("~/x")).toBe(2);
    expect(counts.get("~/y")).toBe(1);
  });
});

describe("buildFolderSections", () => {
  const base = {
    contextFolder: "/home/u/repo",
    contextBranch: "main",
    repo: "repo",
    worktrees: [
      { path: "/home/u/repo", branch: "main" },
      { path: "/home/u/repo.wt/feat", branch: "feat" },
      { path: "/home/u/repo.wt/loose", branch: "" },
    ],
    openFolders: ["/home/u/repo", "/home/u/repo.wt/feat", "/home/u/other"],
    tabCounts: new Map([["~/repo.wt/feat", 2]]),
    branchByFolder: new Map([["~/other", "dev"]]),
  };

  it("orders Current, Worktrees, Open elsewhere and never repeats a folder", () => {
    const sections = buildFolderSections(base);
    expect(sections.map((s) => s.title)).toEqual(["Current", "Worktrees · repo", "Open elsewhere"]);
    expect(sections[0].rows).toEqual([{ path: "~/repo", branch: "main", meta: "active tab" }]);
    expect(sections[1].rows).toEqual([
      { path: "~/repo.wt/feat", branch: "feat", meta: "2 tabs open" },
      { path: "~/repo.wt/loose", branch: "detached", meta: undefined },
    ]);
    expect(sections[2].rows).toEqual([{ path: "~/other", branch: "dev", meta: undefined }]);
  });

  it("omits empty sections", () => {
    const sections = buildFolderSections({ ...base, worktrees: [], openFolders: [] });
    expect(sections.map((s) => s.key)).toEqual(["current"]);
    expect(buildFolderSections({ ...base, contextFolder: "", worktrees: [], openFolders: [] })).toEqual([]);
  });
});

describe("isListMatch", () => {
  const sections = buildFolderSections({
    contextFolder: "/home/u/repo",
    repo: "",
    worktrees: [],
    openFolders: [],
    tabCounts: new Map(),
  });
  it("matches an empty field and an exact row, not partial typing", () => {
    expect(isListMatch("", sections)).toBe(true);
    expect(isListMatch("~/repo/", sections)).toBe(true);
    expect(isListMatch("~/re", sections)).toBe(false);
  });
});

describe("deriveSheetName", () => {
  it("derives and dedupes group names", () => {
    expect(deriveSheetName("group", "~/code/hexokit", ["hexokit"])).toBe("hexokit-2");
    expect(deriveSheetName("group", "~", [])).toBe("session");
  });
  it("derives workspace names with the server charset", () => {
    expect(deriveSheetName("workspace", "~/code/my-repo", [])).toBe("my_repo");
    expect(deriveSheetName("workspace", "~/code/api", ["api"])).toBe("api-2");
    expect(deriveSheetName("workspace", "", [])).toBe("workspace");
  });
});

describe("previewFor", () => {
  const common = { server: "rk-dev", group: "hexokit", name: "api", folder: "/home/u/code/api" };
  it("tab", () => {
    expect(previewFor({ ...common, level: "tab" }).text).toBe("New tab in rk-dev › hexokit at ~/code/api");
  });
  it("group", () => {
    const p = previewFor({ ...common, level: "group" });
    expect(p.text).toBe("New group api in rk-dev, first tab at ~/code/api");
    expect(p.tree.map((n) => n.isNew)).toEqual([false, true, true]);
  });
  it("workspace", () => {
    const p = previewFor({ ...common, level: "workspace" });
    expect(p.text).toBe("New workspace api (tmux -L api), first group and tab at ~/code/api");
    expect(p.tree.every((n) => n.isNew)).toBe(true);
  });
  it("names the default folder when blank", () => {
    expect(previewFor({ ...common, level: "tab", folder: "  " }).text).toContain("at the default folder");
  });
});
