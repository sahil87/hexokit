import { describe, it, expect } from "vitest";
import {
  isValidServerName,
  toSafeSessionName,
  toSafeWindowName,
  toSafeServerName,
  toSafeWorktreeName,
  finalizeSafeName,
  deriveNameFromPath,
} from "./names";

describe("toSafeSessionName", () => {
  const cases: Array<[raw: string, expected: string, why: string]> = [
    ["My problem", "My_problem", "space converts, case preserved"],
    ["my-session", "my_session", "hyphen converts (session-specific rule)"],
    ["a:b.c", "a_b_c", "colon and period convert"],
    ["a;b&c|d", "a_b_c_d", "shell metacharacters convert"],
    ["a`b$c(d)e", "a_b_c_d_e", "backtick/dollar/parens convert"],
    ["a{b}c[d]e", "a_b_c_d_e", "braces/brackets convert"],
    ["a<b>c!d#e*f?g", "a_b_c_d_e_f_g", "remaining forbidden set converts"],
    ["a\nb\rc\td", "a_b_c_d", "control chars convert"],
    ["a - b", "a_b", "consecutive converted chars collapse to one _"],
    ["  hello", "hello", "leading unsafe chars drop"],
    ["My problem ", "My_problem_", "trailing separator stays visible (live)"],
    ["a/b@c%d", "a/b@c%d", "chars outside the unsafe set pass through"],
    ["", "", "empty stays empty"],
    ["   ", "", "only unsafe chars → empty"],
    ["MiXeD CaSe", "MiXeD_CaSe", "case is never folded"],
  ];
  it.each(cases)("%j → %j (%s)", (raw, expected) => {
    expect(toSafeSessionName(raw)).toBe(expected);
  });

  it("caps at 128 chars (backend MaxNameLength)", () => {
    expect(toSafeSessionName("a".repeat(200))).toHaveLength(128);
  });
});

describe("toSafeWindowName", () => {
  const cases: Array<[raw: string, expected: string, why: string]> = [
    ["riff-foo", "riff-foo", "hyphens KEPT (window divergence from session)"],
    ["riff-foo bar", "riff-foo_bar", "space converts, hyphen kept"],
    ["my problem", "my_problem", "space converts"],
    ["a:b.c", "a_b_c", "colon and period convert"],
    ["  x", "x", "leading unsafe chars drop"],
    ["x ", "x_", "trailing separator stays visible (live)"],
  ];
  it.each(cases)("%j → %j (%s)", (raw, expected) => {
    expect(toSafeWindowName(raw)).toBe(expected);
  });

  it("caps at 128 chars", () => {
    expect(toSafeWindowName("b".repeat(200))).toHaveLength(128);
  });
});

describe("toSafeServerName", () => {
  const cases: Array<[raw: string, expected: string, why: string]> = [
    ["my server!", "my_server_", "anything outside [a-zA-Z0-9_-] converts"],
    ["dev-2", "dev-2", "hyphens legal for servers"],
    ["a.b:c", "a_b_c", "punctuation converts"],
    ["héllo", "h_llo", "non-ASCII converts"],
    ["  x", "x", "leading run drops"],
  ];
  it.each(cases)("%j → %j (%s)", (raw, expected) => {
    expect(toSafeServerName(raw)).toBe(expected);
  });

  it("caps at 64 chars (backend MaxServerNameLength)", () => {
    expect(toSafeServerName("c".repeat(100))).toHaveLength(64);
  });
});

describe("toSafeWorktreeName", () => {
  const cases: Array<[raw: string, expected: string, why: string]> = [
    ["swift-fox", "swift-fox", "hyphens kept (window rule base)"],
    ["a/b", "a_b", "slash converts (directory basename)"],
    ["-agent", "agent", "leading hyphen dropped (flag-injection defense)"],
    ["- -x", "x", "mixed leading hyphen/underscore run dropped"],
    ["my agent", "my_agent", "space converts"],
  ];
  it.each(cases)("%j → %j (%s)", (raw, expected) => {
    expect(toSafeWorktreeName(raw)).toBe(expected);
  });
});

describe("finalizeSafeName", () => {
  const cases: Array<[raw: string, expected: string]> = [
    ["My_problem_", "My_problem"],
    ["_x_", "x"],
    ["plain", "plain"],
    ["_", ""],
    ["", ""],
  ];
  it.each(cases)("%j → %j", (raw, expected) => {
    expect(finalizeSafeName(raw)).toBe(expected);
  });
});

describe("deriveNameFromPath", () => {
  const cases: Array<[path: string, expected: string]> = [
    ["~/code/my-project", "my_project"],
    ["~/code/my-project/", "my_project"],
    ["~", ""],
    ["", ""],
    ["/tmp/My Project", "My_Project"],
    ["~/x/name.with.dots", "name_with_dots"],
  ];
  it.each(cases)("%j → %j", (path, expected) => {
    expect(deriveNameFromPath(path)).toBe(expected);
  });
});

describe("isValidServerName", () => {
  it("accepts the backend server-name charset and rejects the rest", () => {
    expect(isValidServerName("rk-dev_2")).toBe(true);
    expect(isValidServerName("")).toBe(false);
    expect(isValidServerName("my server")).toBe(false);
    expect(isValidServerName("a.b")).toBe(false);
  });
});
