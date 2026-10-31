import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useTopBarMode } from "./use-top-bar-mode";

let mockMatches: Array<{ params: Record<string, string> }> = [];
let mockNotFound = false;

vi.mock("@tanstack/react-router", () => ({ useMatches: () => mockMatches }));
vi.mock("@/contexts/top-bar-slot-context", () => ({ useTopBarNotFound: () => mockNotFound }));

function Probe() {
  const { mode, serverParam, boardName } = useTopBarMode();
  return <span data-testid="out">{JSON.stringify({ mode, serverParam, boardName })}</span>;
}

function read(matches: Array<{ params: Record<string, string> }>, notFound = false) {
  mockMatches = matches;
  mockNotFound = notFound;
  render(<Probe />);
  const out = JSON.parse(screen.getByTestId("out").textContent ?? "{}");
  cleanup();
  return out;
}

afterEach(cleanup);

describe("useTopBarMode", () => {
  it("derives the mode from the deepest-first param walk", () => {
    expect(read([{ params: {} }]).mode).toBe("host");
    expect(read([{ params: { server: "a" } }])).toMatchObject({ mode: "server", serverParam: "a" });
    expect(read([{ params: { server: "a" } }, { params: { server: "a", window: "@1" } }]).mode).toBe("terminal");
    expect(read([{ params: { name: "b" } }])).toMatchObject({ mode: "board", boardName: "b" });
  });

  it("forces host and withholds the board name while the not-found page renders (retained fuzzy params must not win)", () => {
    const out = read([{ params: { name: "x" } }], true);
    expect(out.mode).toBe("host");
    expect(out.boardName).toBeUndefined();
  });
});
