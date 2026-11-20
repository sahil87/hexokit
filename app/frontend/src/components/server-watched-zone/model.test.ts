import { describe, it, expect } from "vitest";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import type { OperatorTrackedItem } from "@/types";
import { collectNeedsYou, collectTrackedRows, watchedWorkerRows } from "./model";

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

describe("collectNeedsYou", () => {
  const escalated = (over: Partial<OperatorTrackedItem> = {}): OperatorTrackedItem => ({
    id: "pr-41",
    kind: "github-pr",
    updatedAt: 1_800_000_100,
    latestNote: { at: 1_800_000_100, by: "run", text: "escalated: spawn interrupted: x" },
    noteCount: 1,
    ...over,
  });
  const needs = (items: OperatorTrackedItem[], windows = [makeWindow({ windowId: "@2" })]) =>
    collectNeedsYou(
      collectTrackedRows([makeSession({ operatorTracked: items, windows })]) ?? [],
    );

  it("an open escalation yields one row with the reason after the prefix", () => {
    expect(needs([escalated()])).toEqual([
      { kind: "escalation", id: "pr-41", action: "spawn interrupted: x", windowId: undefined, updatedAt: 1_800_000_100 },
    ]);
  });

  it("a newer user note clears the escalation", () => {
    const answered = escalated({
      latestNote: { at: 1_800_000_200, by: "user", text: "merge it" },
    });
    expect(needs([answered])).toEqual([]);
  });

  it("a newer run note that is not an escalation clears it too", () => {
    const progress = escalated({
      latestNote: { at: 1_800_000_200, by: "run", text: "retrying" },
    });
    expect(needs([progress])).toEqual([]);
  });

  it("a done item never yields a row", () => {
    expect(needs([escalated({ doneAt: 1_800_000_300 })])).toEqual([]);
  });

  it("a user note that happens to start with escalated: is not an escalation", () => {
    const user = escalated({ latestNote: { at: 1, by: "user", text: "escalated: me" } });
    expect(needs([user])).toEqual([]);
  });

  it("a waiting worker yields a waiting row naming its window, and clears when it leaves waiting", () => {
    const item: OperatorTrackedItem = { id: "w1", windowId: "@2", updatedAt: 5 };
    const waitingWin = makeWindow({ windowId: "@2", name: "builder", agentState: "waiting" });
    expect(needs([item], [waitingWin])).toEqual([
      { kind: "waiting", id: "w1", action: "answer the prompt in builder", windowId: "@2", updatedAt: 5 },
    ]);
    const activeWin = makeWindow({ windowId: "@2", name: "builder", agentState: "active" });
    expect(needs([item], [activeWin])).toEqual([]);
  });

  it("an item both waiting and escalated yields one waiting row carrying the reason", () => {
    const item = escalated({ windowId: "@2" });
    const win = makeWindow({ windowId: "@2", name: "builder", agentState: "waiting" });
    const rows = needs([item], [win]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "waiting",
      action: "answer the prompt in builder · spawn interrupted: x",
      windowId: "@2",
    });
  });

  it("an escalation on an item with a live window carries its windowId", () => {
    const rows = needs([escalated({ windowId: "@2" })]);
    expect(rows[0]).toMatchObject({ kind: "escalation", windowId: "@2" });
  });

  it("a waiting item row with no live window is not a waiting prompt", () => {
    const item: OperatorTrackedItem = { id: "w1", windowId: "@9", updatedAt: 5 };
    expect(needs([item], [makeWindow({ windowId: "@2", agentState: "waiting" })])).toEqual([]);
  });

  it("orders waiting before escalations, oldest first within each kind", () => {
    const items: OperatorTrackedItem[] = [
      escalated({ id: "e-new", updatedAt: 30 }),
      escalated({ id: "e-old", updatedAt: 10 }),
      { id: "w-new", windowId: "@3", updatedAt: 40 },
      { id: "w-old", windowId: "@2", updatedAt: 20 },
    ];
    const wins = [
      makeWindow({ windowId: "@2", agentState: "waiting" }),
      makeWindow({ windowId: "@3", agentState: "waiting" }),
    ];
    expect(needs(items, wins).map((r) => r.id)).toEqual(["w-old", "w-new", "e-old", "e-new"]);
  });

  it("skips id-less rows (the older-backend window fallback)", () => {
    const rows = collectNeedsYou(
      watchedWorkerRows([
        makeSession({ windows: [makeWindow({ monitored: true, agentState: "waiting" })] }),
      ]),
    );
    expect(rows).toEqual([]);
  });
});
