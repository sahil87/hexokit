import { describe, it, expect, vi } from "vitest";
import { buildSessionSortActions } from "./sort";

// Backs the `Group: Sort tabs…` palette entry. app.tsx folds the builder
// output into the session group, so covering the gating and the pinned
// id/label/options here proves the entry's shape without mounting the shell.

describe("buildSessionSortActions", () => {
  it("returns [] without a current session (entry omitted, not disabled)", () => {
    expect(buildSessionSortActions(null, vi.fn())).toEqual([]);
    expect(buildSessionSortActions("", vi.fn())).toEqual([]);
  });

  it("pins the single id, label, and option-picker keys with a current session", () => {
    const actions = buildSessionSortActions("work", vi.fn());
    expect(actions.map((a) => [a.id, a.label])).toEqual([
      ["session-sort-windows", "Group: Sort tabs…"],
    ]);
    expect(actions[0].optionPicker?.options).toEqual([
      { key: "status", label: "By status" },
      { key: "created", label: "By created" },
      { key: "name", label: "By name" },
    ]);
    // The flat pair is gone — no per-key entries.
    expect(actions.some((a) => a.id === "session-sort-windows-status")).toBe(false);
    expect(actions.some((a) => a.id === "session-sort-windows-created")).toBe(false);
  });

  it("routes onApply to onSort with the ordered selected keys", () => {
    const onSort = vi.fn();
    const [entry] = buildSessionSortActions("work", onSort);
    entry.optionPicker!.onApply(["created", "name"]);
    expect(onSort).toHaveBeenCalledWith(["created", "name"]);
  });
});
