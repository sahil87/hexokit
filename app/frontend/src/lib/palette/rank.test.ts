import { describe, it, expect } from "vitest";
import { MatchTier, matchTier, rankActions } from "./rank";

type Fixture = { id: string; label: string; description?: string };

function fixture(labels: string[]): Fixture[] {
  return labels.map((label, i) => ({ id: `a${i}`, label }));
}

describe("matchTier", () => {
  it("classifies Exact on a whole-label match", () => {
    expect(matchTier("pr", undefined, "pr")).toBe(MatchTier.Exact);
  });

  it("classifies Exact on a colon-prefix category match", () => {
    expect(matchTier("PR: Refresh Status", undefined, "pr")).toBe(MatchTier.Exact);
  });

  it("classifies Exact on a hyphenated category", () => {
    expect(matchTier("run-kit: Restart Daemon", undefined, "run-kit")).toBe(
      MatchTier.Exact,
    );
  });

  it("does not invent a category for a label with no ': '", () => {
    expect(matchTier("Reload tmux config", undefined, "reload")).toBe(
      MatchTier.WholeWord,
    );
  });

  it("classifies WholeWord when the query equals a complete word", () => {
    expect(matchTier("Open: PR #3127", undefined, "pr")).toBe(MatchTier.WholeWord);
  });

  it("classifies WordStart when the query is a strict word prefix", () => {
    expect(matchTier("Server: Protect noon", undefined, "pr")).toBe(
      MatchTier.WordStart,
    );
    expect(matchTier("Layout: Promote Web", undefined, "pr")).toBe(
      MatchTier.WordStart,
    );
  });

  it("classifies Acronym on a contiguous initials run", () => {
    expect(matchTier("PR: Refresh Status", undefined, "prs")).toBe(MatchTier.Acronym);
    expect(matchTier("Layout: Promote Web", undefined, "pw")).toBe(MatchTier.Acronym);
  });

  it("rejects a non-contiguous initials query", () => {
    expect(matchTier("PR: Refresh Status", undefined, "ps")).toBeNull();
  });

  it("classifies Incidental when the query occurs strictly inside a word", () => {
    expect(matchTier("PR: Refresh Status", undefined, "efre")).toBe(
      MatchTier.Incidental,
    );
  });

  it("classifies Incidental when the query spans a word boundary", () => {
    expect(matchTier("run-kit: Restart Daemon", undefined, "kit: r")).toBe(
      MatchTier.Incidental,
    );
  });

  it("classifies DescriptionOnly when only the description matches", () => {
    expect(matchTier("Tab: Create", "a fresh tab", "fresh")).toBe(
      MatchTier.DescriptionOnly,
    );
  });

  it("returns null when neither label nor description contains the query", () => {
    expect(matchTier("Tab: Create", "a fresh tab", "zzz")).toBeNull();
  });

  it("tokenizes on every non-alphanumeric boundary", () => {
    expect(matchTier("Open: PR #3127", undefined, "3127")).toBe(MatchTier.WholeWord);
    expect(matchTier("run-kit: Restart Daemon", undefined, "kit")).toBe(
      MatchTier.WholeWord,
    );
    expect(matchTier('Server: Switch to "work"', undefined, "work")).toBe(
      MatchTier.WholeWord,
    );
  });

  it("is case-insensitive on both sides", () => {
    expect(matchTier("open: pr #3127", undefined, "PR")).toBe(MatchTier.WholeWord);
  });
});

describe("rankActions", () => {
  it("reproduces the design-doc fixture: query 'pr' ranks the two PR rows above every Protect/Promote row", () => {
    const actions = fixture([
      "PR: Refresh Status",
      "Open: PR #3127",
      "Server: Protect default",
      "Server: Protect noon",
      "Server: Protect runkit",
      "Layout: Promote Web",
    ]);
    expect(rankActions(actions, "pr", []).map((a) => a.label)).toEqual([
      "PR: Refresh Status",
      "Open: PR #3127",
      "Layout: Promote Web",
      "Server: Protect noon",
      "Server: Protect runkit",
      "Server: Protect default",
    ]);
  });

  it("orders by density within a tier (shorter label first)", () => {
    const actions = fixture(["Server: Protect default", "Server: Protect noon"]);
    expect(rankActions(actions, "pr", []).map((a) => a.label)).toEqual([
      "Server: Protect noon",
      "Server: Protect default",
    ]);
  });

  it("breaks a density tie by MRU — a listed id outranks an unlisted one", () => {
    const actions = fixture(["Foo: Abcd", "Xyz: Abce"]);
    expect(rankActions(actions, "ab", ["a1"]).map((a) => a.id)).toEqual([
      "a1",
      "a0",
    ]);
  });

  it("orders two MRU'd ids by recency (lower index first)", () => {
    const actions = fixture(["Foo: Abcd", "Xyz: Abce"]);
    expect(rankActions(actions, "ab", ["a0", "a1"]).map((a) => a.id)).toEqual([
      "a0",
      "a1",
    ]);
  });

  it("lets density outrank MRU — a shorter equal-tier label beats a recently-used longer one", () => {
    const actions = fixture(["Tab: Promote", "Server: Protect noon"]);
    expect(rankActions(actions, "pr", ["a1"]).map((a) => a.label)).toEqual([
      "Tab: Promote",
      "Server: Protect noon",
    ]);
  });

  it("falls back to declaration order when tier, density and MRU all tie", () => {
    const actions = fixture(["Foo: Abcd", "Xyz: Abce"]);
    expect(rankActions(actions, "ab", []).map((a) => a.id)).toEqual(["a0", "a1"]);
  });

  it("returns every action MRU-first then declaration order for an empty query", () => {
    const actions = fixture(["one", "two", "three", "four", "five", "six", "seven", "eight"]);
    const ranked = rankActions(actions, "", ["a6", "a2"]);
    expect(ranked.map((a) => a.id)).toEqual([
      "a6",
      "a2",
      "a0",
      "a1",
      "a3",
      "a4",
      "a5",
      "a7",
    ]);
  });

  it("treats a whitespace-only query as empty", () => {
    const actions = fixture(["one", "two"]);
    expect(rankActions(actions, "   ", []).map((a) => a.id)).toEqual(["a0", "a1"]);
  });

  it("does not mutate its input array", () => {
    const actions = Object.freeze(fixture(["Server: Protect default", "Open: PR #3127"]));
    const before = actions.map((a) => a.label);
    rankActions(actions, "pr", []);
    expect(actions.map((a) => a.label)).toEqual(before);
  });

  it("keeps every action the pre-change filter admitted (membership superset)", () => {
    const actions: Fixture[] = [
      { id: "a", label: "New Session" },
      { id: "b", label: "Kill Window" },
      { id: "c", label: "Session: Create", description: "a new group of tabs" },
      { id: "d", label: "Tab: Create" },
    ];
    const q = "new";
    const legacy = actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q) ?? false),
    );
    const ranked = rankActions(actions, q, []);
    for (const action of legacy) {
      expect(ranked).toContain(action);
    }
    expect(ranked.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("admits acronym matches the pre-change filter rejected, at tier Acronym only", () => {
    const actions: Fixture[] = [{ id: "a", label: "New Session" }];
    const legacy = actions.filter(
      (a) =>
        a.label.toLowerCase().includes("ns") ||
        (a.description?.toLowerCase().includes("ns") ?? false),
    );
    expect(legacy).toEqual([]);
    const ranked = rankActions(actions, "ns", []);
    expect(ranked.map((a) => a.id)).toEqual(["a"]);
    expect(matchTier("New Session", undefined, "ns")).toBe(MatchTier.Acronym);
  });

  it("excludes actions matching neither label nor description", () => {
    const actions = fixture(["New Session", "Kill Window"]);
    expect(rankActions(actions, "zzz", [])).toEqual([]);
  });
});
