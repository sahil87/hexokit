import { describe, it, expect } from "vitest";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import type { OperatorTrackedItem } from "@/types";
import { collectTrackedRows } from "./model";

const NOTE: OperatorTrackedItem = {
  id: "n3",
  kind: "note",
  latestNote: { at: 1_800_000_000, by: "user", text: "archive once merged" },
  noteCount: 1,
  refs: ["bf1l"],
  updatedAt: 1_800_000_000,
};

const WORKER_ITEM: OperatorTrackedItem = {
  id: "wuiu",
  kind: "fab-change",
  pane: "%2",
  windowId: "@2",
  repo: "/home/user/code/run-kit",
  stage: "review",
  updatedAt: 1_800_000_100,
};

describe("collectTrackedRows", () => {
  it("returns null when no session carries operatorTracked (older backend)", () => {
    const sessions = [makeSession({ name: "dev", windows: [makeWindow({ monitored: true })] })];
    expect(collectTrackedRows(sessions)).toBeNull();
  });

  it("reads the list from the first session carrying operatorTracked", () => {
    const sessions = [
      makeSession({ name: "first", operatorTracked: [NOTE] }),
      makeSession({ name: "second", operatorTracked: [WORKER_ITEM] }),
    ];
    const rows = collectTrackedRows(sessions);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: "item", item: NOTE, done: false });
  });

  it("splits worker vs item rows on windowId resolution", () => {
    const win = makeWindow({ windowId: "@2", name: "watched-worker", index: 1 });
    const sessions = [
      makeSession({ name: "dev", operatorTracked: [WORKER_ITEM, NOTE], windows: [win] }),
    ];
    const rows = collectTrackedRows(sessions);
    expect(rows).toHaveLength(2);
    const worker = rows?.[0];
    expect(worker).toMatchObject({ kind: "worker", session: "dev", done: false });
    expect(worker?.kind === "worker" && worker.win).toBe(win);
    expect(rows?.[1]).toMatchObject({ kind: "item", item: NOTE });
  });

  it("a windowId naming a ghost window renders as an item row", () => {
    const ghost = Object.assign(makeWindow({ windowId: "@2", name: "ghost" }), {
      optimistic: true as const,
      optimisticId: "g1",
    });
    const sessions = [makeSession({ operatorTracked: [WORKER_ITEM], windows: [ghost] })];
    const rows = collectTrackedRows(sessions);
    expect(rows?.[0]).toMatchObject({ kind: "item", item: WORKER_ITEM });
  });

  it("a windowId no window carries (a dead pane) renders as an item row", () => {
    const sessions = [makeSession({ operatorTracked: [WORKER_ITEM], windows: [] })];
    const rows = collectTrackedRows(sessions);
    expect(rows?.[0]).toMatchObject({ kind: "item", item: WORKER_ITEM });
  });

  it("orders live workers (session order, window index), then done workers, then live items, then done items", () => {
    const doneWorkerItem: OperatorTrackedItem = {
      ...WORKER_ITEM,
      id: "done1",
      windowId: "@1",
      doneAt: 1_800_000_500,
    };
    const doneNote: OperatorTrackedItem = { ...NOTE, id: "n9", doneAt: 1_800_000_600 };
    const sessions = [
      makeSession({
        name: "dev",
        operatorTracked: [doneNote, NOTE, doneWorkerItem, WORKER_ITEM],
        windows: [makeWindow({ windowId: "@1", index: 0 }), makeWindow({ windowId: "@2", index: 1 })],
      }),
    ];
    const rows = collectTrackedRows(sessions);
    expect(rows?.map((r) => [r.kind, r.item.id, r.done])).toEqual([
      ["worker", "wuiu", false],
      ["worker", "done1", true],
      ["item", "n3", false],
      ["item", "n9", true],
    ]);
  });

  it("item rows keep the tracked-list order", () => {
    const a: OperatorTrackedItem = { id: "zz", kind: "note" };
    const b: OperatorTrackedItem = { id: "aa", kind: "note" };
    const sessions = [makeSession({ operatorTracked: [a, b] })];
    expect(collectTrackedRows(sessions)?.map((r) => r.item.id)).toEqual(["zz", "aa"]);
  });
});
