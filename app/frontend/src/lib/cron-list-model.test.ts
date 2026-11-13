import { describe, it, expect } from "vitest";
import type { CronEntry } from "@/api/client";
import {
  compareCronEntries,
  cronEntryLabel,
  isCronDimmed,
  isLoopEntry,
  mutedLabel,
  sortCronEntries,
  targetChip,
} from "./cron-list-model";

const NOW = 1_800_000_000;

function makeEntry(overrides: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "aaaa",
    schedule: { kind: "every", interval: "1h" },
    target: { kind: "role", role: "operator" },
    payload: "tick",
    lastFired: 0,
    ...overrides,
  };
}

describe("targetChip", () => {
  it("renders the first target facet, else the bare kind", () => {
    expect(targetChip(makeEntry({ target: { kind: "role", role: "operator" } }))).toBe(
      "role: operator",
    );
    expect(targetChip(makeEntry({ target: { kind: "session", session: "foo" } }))).toBe(
      "session: foo",
    );
    expect(targetChip(makeEntry({ target: { kind: "pane", pane: "%3" } }))).toBe("pane: %3");
    expect(targetChip(makeEntry({ target: { kind: "role" } }))).toBe("role");
  });

  it("reads `operator loop` for the target-less loop entry", () => {
    const loop = makeEntry({ run: "operator-loop", target: { kind: "" }, payload: "" });
    expect(isLoopEntry(loop)).toBe(true);
    expect(isLoopEntry(makeEntry())).toBe(false);
    expect(targetChip(loop)).toBe("operator loop");
  });
});

describe("cronEntryLabel", () => {
  it("falls back to the id when the name is absent or empty", () => {
    expect(cronEntryLabel(makeEntry({ name: "named" }))).toBe("named");
    expect(cronEntryLabel(makeEntry())).toBe("aaaa");
    expect(cronEntryLabel(makeEntry({ name: "" }))).toBe("aaaa");
  });
});

describe("isCronDimmed", () => {
  it("dims muted and orphaned entries, never omits them", () => {
    expect(isCronDimmed(makeEntry({ muted: true }))).toBe(true);
    expect(isCronDimmed(makeEntry({ orphaned: true }))).toBe(true);
    expect(isCronDimmed(makeEntry())).toBe(false);
  });
});

describe("mutedLabel", () => {
  it("renders the lease remaining while a lease is live, else bare `muted`", () => {
    expect(mutedLabel(makeEntry({ muted: true, mutedUntil: NOW + 300 }), NOW)).toBe("muted 5m");
    expect(mutedLabel(makeEntry({ muted: true }), NOW)).toBe("muted");
  });

  it("an expired lease renders bare `muted` — never a negative remaining time", () => {
    expect(mutedLabel(makeEntry({ muted: true, mutedUntil: NOW - 5 }), NOW)).toBe("muted");
  });
});

describe("sortCronEntries", () => {
  it("orders nextFire ascending (soonest first), undated last", () => {
    const a = makeEntry({ id: "a", name: "A", nextFire: NOW + 300 });
    const b = makeEntry({ id: "b", name: "B" });
    const c = makeEntry({ id: "c", name: "C", nextFire: NOW + 60, muted: true });
    // A past-due nextFire sorts before every future one (ascending order).
    const d = makeEntry({ id: "d", name: "D", nextFire: NOW - 30 });
    expect(sortCronEntries([a, b, c, d]).map((x) => x.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("breaks ties by label, then id", () => {
    const x = makeEntry({ id: "x2", name: "same", nextFire: NOW + 60 });
    const y = makeEntry({ id: "x1", name: "same", nextFire: NOW + 60 });
    const z = makeEntry({ id: "z", name: "other", nextFire: NOW + 60 });
    const undatedB = makeEntry({ id: "u2", name: "beta" });
    const undatedA = makeEntry({ id: "u1", name: "alpha" });
    expect(sortCronEntries([x, y, z, undatedB, undatedA]).map((e) => e.id)).toEqual([
      "z",
      "x1",
      "x2",
      "u1",
      "u2",
    ]);
  });

  it("does not mutate the input and dims nothing away", () => {
    const orphan = makeEntry({ id: "o", orphaned: true });
    const input = [makeEntry({ id: "n", nextFire: NOW + 10 }), orphan];
    const sorted = sortCronEntries(input);
    expect(input.map((e) => e.id)).toEqual(["n", "o"]);
    expect(sorted).toHaveLength(2);
  });
});

describe("compareCronEntries", () => {
  it("yields the same order as sortCronEntries — undated last, label/id tie-break", () => {
    const a = makeEntry({ id: "a", name: "A", nextFire: NOW + 300 });
    const b = makeEntry({ id: "b", name: "B" });
    const c = makeEntry({ id: "c", name: "C", nextFire: NOW + 60, muted: true });
    const d = makeEntry({ id: "d", name: "D", nextFire: NOW - 30 });
    const x1 = makeEntry({ id: "x1", name: "same", nextFire: NOW + 60 });
    const input = [a, b, c, d, x1];
    expect([...input].sort(compareCronEntries).map((e) => e.id)).toEqual(
      sortCronEntries(input).map((e) => e.id),
    );
  });
});
