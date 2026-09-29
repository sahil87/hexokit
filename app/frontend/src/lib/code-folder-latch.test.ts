import { describe, it, expect } from "vitest";
import { codeRootFor, codeRootFollowTarget, codeRootSeed } from "./code-folder-latch";
import type { Layout } from "./surface-layout";

const codeOpen: Layout = { dir: "h", children: [{ leaf: "tty" }, { leaf: "code" }] };
const codeClosed: Layout = { leaf: "tty" };

describe("codeRootFor", () => {
  it("prefers the shared codeRoot over the derived gitRoot", () => {
    expect(codeRootFor({ codeRoot: "/latched", gitRoot: "/repo" })).toBe("/latched");
  });

  it("falls back to gitRoot while the option is unset (pre-seed)", () => {
    expect(codeRootFor({ gitRoot: "/repo" })).toBe("/repo");
    expect(codeRootFor({ codeRoot: "", gitRoot: "/repo" })).toBe("/repo");
  });

  it("is empty when neither root exists", () => {
    expect(codeRootFor({})).toBe("");
    expect(codeRootFor({ codeRoot: "", gitRoot: "" })).toBe("");
    expect(codeRootFor(null)).toBe("");
    expect(codeRootFor(undefined)).toBe("");
  });
});

describe("codeRootSeed", () => {
  it("seeds gitRoot when the code tile is open, the option is empty, and gitRoot is non-empty", () => {
    expect(codeRootSeed({ gitRoot: "/repo" }, codeOpen)).toBe("/repo");
  });

  it("is null when the code tile is not open", () => {
    expect(codeRootSeed({ gitRoot: "/repo" }, codeClosed)).toBeNull();
  });

  it("is null when codeRoot is already set — the editor's navigation owns the root", () => {
    expect(codeRootSeed({ codeRoot: "/latched", gitRoot: "/repo" }, codeOpen)).toBeNull();
  });

  it("is null when gitRoot is empty — an empty derivation seeds nothing", () => {
    expect(codeRootSeed({}, codeOpen)).toBeNull();
    expect(codeRootSeed({ gitRoot: "" }, codeOpen)).toBeNull();
    expect(codeRootSeed(null, codeOpen)).toBeNull();
  });
});

describe("codeRootFollowTarget", () => {
  it("returns gitRoot when the latched root drifted from the live derivation", () => {
    expect(codeRootFollowTarget({ codeRoot: "/repo", gitRoot: "/repo.worktrees/x" })).toBe(
      "/repo.worktrees/x",
    );
  });

  it("is null when the roots agree — no drift, no verb", () => {
    expect(codeRootFollowTarget({ codeRoot: "/repo", gitRoot: "/repo" })).toBeNull();
  });

  it("is null when codeRoot is empty — a pre-seed window is about to be seeded", () => {
    expect(codeRootFollowTarget({ gitRoot: "/repo" })).toBeNull();
    expect(codeRootFollowTarget({ codeRoot: "", gitRoot: "/repo" })).toBeNull();
  });

  it("is null when gitRoot is empty — no resolvable cwd has no folder to follow", () => {
    expect(codeRootFollowTarget({ codeRoot: "/repo", gitRoot: "" })).toBeNull();
  });

  it("is null for a null/undefined window", () => {
    expect(codeRootFollowTarget(null)).toBeNull();
    expect(codeRootFollowTarget(undefined)).toBeNull();
  });
});
