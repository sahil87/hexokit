import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import { NOTE_STALE_SECONDS } from "@/components/sidebar/row-flyout-card";
import { WatchedZone } from "./watched-zone";

const NOW = Math.floor(Date.now() / 1000);

// The zone reads `Date.now()` at render; pin it to the fixture's `NOW` so the
// exact relative-time strings below cannot roll across a second boundary
// between module load and render.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function renderZone(
  sessions: Parameters<typeof WatchedZone>[0]["sessions"],
  onNavigate: (windowId: string) => void = vi.fn(),
) {
  return render(<WatchedZone sessions={sessions} onNavigate={onNavigate} />);
}

afterEach(cleanup);

describe("WatchedZone", () => {
  it("renders one row per monitored window, ghosts excluded, and navigates on name click", () => {
    const onNavigate = vi.fn();
    const ghost = Object.assign(makeWindow({ windowId: "", name: "ghost", monitored: true }), {
      optimistic: true,
      optimisticId: "g1",
    });
    const sessions = [
      makeSession({
        name: "dev",
        windows: [
          makeWindow({
            windowId: "@1",
            name: "worker-one",
            monitored: true,
            monitoredChange: "wuiu",
            monitoredStage: "review",
            monitoredRepo: "/home/user/code/run-kit",
            agentState: "waiting",
            agentIdleDuration: "6m",
          }),
          makeWindow({ windowId: "@2", name: "unwatched" }),
          ghost,
        ],
      }),
      makeSession({
        name: "ops",
        windows: [
          makeWindow({ windowId: "@3", name: "worker-two", monitored: true }),
        ],
      }),
    ];
    renderZone(sessions, onNavigate);

    const rows = screen.getAllByTestId("watched-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("worker-one")).toBeInTheDocument();
    expect(screen.getByText("worker-two")).toBeInTheDocument();
    expect(screen.queryByText("unwatched")).not.toBeInTheDocument();
    expect(screen.queryByText("ghost")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId("watched-row-navigate")[0]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("@1");
  });

  it("renders the registry columns: session, change + stage badge, awaiting, note, repo", () => {
    renderZone([
      makeSession({
        name: "dev",
        windows: [
          makeWindow({
            windowId: "@1",
            monitored: true,
            monitoredChange: "wuiu",
            monitoredStage: "review",
            monitoredRepo: "/home/user/code/run-kit",
            agentState: "waiting",
            agentIdleDuration: "6m",
            note: "blocked on flaky e2e",
            noteEpoch: NOW - 3600,
          }),
        ],
      }),
    ]);

    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("wuiu")).toBeInTheDocument();
    expect(screen.getByText("review").className).toContain("bg-accent/10");
    expect(screen.getByText("waiting 6m").className).toContain("text-signal-yellow");
    expect(screen.getByText(/blocked on flaky e2e · 1h ago/)).toBeInTheDocument();
    expect(screen.getByText("run-kit")).toBeInTheDocument();
  });

  it("dims a note older than NOTE_STALE_SECONDS", () => {
    renderZone([
      makeSession({
        windows: [
          makeWindow({
            windowId: "@1",
            monitored: true,
            note: "old note",
            noteEpoch: NOW - NOTE_STALE_SECONDS - 60,
          }),
        ],
      }),
    ]);
    const noteCell = screen.getByText(/old note/).closest("td");
    expect(noteCell?.className).toContain("opacity-50");
  });

  it("renders — for absent facets and unknown agent state", () => {
    renderZone([
      makeSession({ windows: [makeWindow({ windowId: "@1", monitored: true })] }),
    ]);
    const row = screen.getByTestId("watched-row");
    expect(row.textContent).toContain("—");
    expect(row.querySelectorAll("td")[2]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[3]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[4]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("—");
  });

  it("side slot reads `{N} watched · tick {age} ago`", () => {
    renderZone([
      makeSession({
        operatorLastTickAt: NOW - 42,
        windows: [makeWindow({ windowId: "@1", monitored: true })],
      }),
    ]);
    expect(screen.getByText("1 watched · tick 42s ago")).toBeInTheDocument();
  });

  it("flips to the yellow stale variant and dims the table when operatorStale", () => {
    renderZone([
      makeSession({
        operatorStale: true,
        operatorLastTickAt: NOW - 20 * 60,
        windows: [makeWindow({ windowId: "@1", monitored: true })],
      }),
    ]);
    expect(screen.getByTestId("watched-stale")).toHaveTextContent("⚠ stale 20m");
    expect(screen.getByTestId("watched-stale").className).toContain("text-signal-yellow");
    expect(screen.getByTestId("watched-table").className).toContain("opacity-50");
  });

  it("reads `no operator tick` when no session carries a tick", () => {
    renderZone([
      makeSession({
        windows: [
          makeWindow({ windowId: "@1", monitored: true }),
          makeWindow({ windowId: "@9", role: "operator" }),
        ],
      }),
    ]);
    expect(screen.getByText("1 watched · no operator tick")).toBeInTheDocument();
  });

  it("empty states: `No watched workers` with an operator, `No operator on this workspace` without", () => {
    renderZone([
      makeSession({
        operatorLastTickAt: NOW - 10,
        windows: [makeWindow({ windowId: "@9", role: "operator" })],
      }),
    ]);
    expect(screen.getByText("No watched workers")).toBeInTheDocument();
    cleanup();

    renderZone([makeSession({ windows: [makeWindow({ windowId: "@1" })] })]);
    expect(screen.getByText("No operator on this workspace")).toBeInTheDocument();
    cleanup();

    // Zero sessions at all — no throw, the operatorless empty state.
    renderZone([]);
    expect(screen.getByText("No operator on this workspace")).toBeInTheDocument();
  });
});
