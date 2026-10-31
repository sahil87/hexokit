import { describe, it, expect } from "vitest";
import {
  NEW_SPLIT_FOLD_HYSTERESIS_PX,
  newSplitPrimary,
  newSplitSections,
  nextHeadRung,
} from "./new-split";

describe("newSplitPrimary", () => {
  it("varies label, action and caret by route", () => {
    expect(newSplitPrimary("terminal")).toMatchObject({ label: "+ Tab", actionId: "create-window", caret: true });
    expect(newSplitPrimary("board")).toMatchObject({ label: "+ Tab", actionId: "create-window", caret: true });
    expect(newSplitPrimary("server")).toMatchObject({
      label: "+ Group",
      actionId: "create-session-instant",
      caret: true,
    });
    expect(newSplitPrimary("host")).toMatchObject({ label: "+ Workspace", actionId: "create-server", caret: false });
  });
});

describe("newSplitSections", () => {
  const ids = (s: ReturnType<typeof newSplitSections>) => s.flatMap((x) => x.rows.map((r) => r.actionId));

  it("terminal: tab section, group section, workspace row", () => {
    const sections = newSplitSections("terminal", { server: "work", group: "hexokit" });
    expect(sections.map((s) => s.header)).toEqual(["IN work › hexokit", "IN work", undefined]);
    expect(ids(sections)).toEqual([
      "create-window",
      "create-window-at-folder",
      "agent-spawn",
      "create-iframe-window",
      "reopen-window",
      "create-session",
      "create-session-at-folder",
      "create-server",
    ]);
  });

  it("board keys the first section to the focused pane's group", () => {
    const sections = newSplitSections("board", { server: "kit", group: "review" });
    expect(sections[0].header).toBe("IN kit › review");
  });

  it("server: only the workspace section plus Workspace…", () => {
    const sections = newSplitSections("server", { server: "work", group: null });
    expect(sections.map((s) => s.header)).toEqual(["IN work", undefined]);
    expect(ids(sections)).toEqual(["create-session", "create-session-at-folder", "create-server"]);
  });

  it("board: the Group row is the instant create (no name-prompt dialog mounts on the board)", () => {
    const rows = newSplitSections("board", { server: "kit", group: "review" }).flatMap((x) => x.rows);
    expect(rows.find((r) => r.label === "Group")?.actionId).toBe("create-session-instant");
    expect(rows.some((r) => r.actionId === "create-session")).toBe(false);
  });

  it("an empty board (no focused pane) leaves only Workspace…", () => {
    expect(ids(newSplitSections("board", { server: "", group: null }))).toEqual(["create-server"]);
  });

  it("host has no menu", () => {
    expect(newSplitSections("host", { server: "", group: null })).toEqual([]);
  });

  it("never offers the deferred worktree row", () => {
    const all = newSplitSections("terminal", { server: "w", group: "g" }).flatMap((s) => s.rows.map((r) => r.label));
    expect(all.some((l) => /worktree/i.test(l))).toBe(false);
  });
});

describe("nextHeadRung", () => {
  const H = NEW_SPLIT_FOLD_HYSTERESIS_PX;

  it("folds immediately when the current rung overflows", () => {
    expect(nextHeadRung(1, 200, { 1: 224 })).toBe(2);
    expect(nextHeadRung(2, 150, { 1: 224, 2: 170 })).toBe(3);
  });

  it("stays on the last rung when even it overflows", () => {
    expect(nextHeadRung(3, 20, { 3: 74 })).toBe(3);
  });

  it("holds when the current rung fits and no wider rung is known to fit", () => {
    expect(nextHeadRung(2, 200, { 2: 170 })).toBe(2);
  });

  it("expands only once the wider rung clears the hysteresis margin", () => {
    expect(nextHeadRung(2, 224 + H - 1, { 1: 224, 2: 170 })).toBe(2);
    expect(nextHeadRung(2, 224 + H, { 1: 224, 2: 170 })).toBe(1);
  });

  it("holds the previous rung when unmeasured", () => {
    expect(nextHeadRung(2, 0, { 2: 170 })).toBe(2);
    expect(nextHeadRung(2, 200, {})).toBe(2);
    expect(nextHeadRung(2, 200, { 2: 0 })).toBe(2);
  });
});
