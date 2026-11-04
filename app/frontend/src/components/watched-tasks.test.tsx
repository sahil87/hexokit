import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { makeSession, makeWindow } from "@/test-utils/fixtures";
import { WatchedTasks } from "./watched-tasks";

const NOW = Math.floor(Date.now() / 1000);

// The component reads `Date.now()` at render; pin it to the fixture's `NOW`
// so the relative-time strings below cannot roll across a second boundary.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderTasks(
  opts: Partial<Parameters<typeof WatchedTasks>[0]> & { server: string },
) {
  return render(
    <WatchedTasks
      server={opts.server}
      sessions={opts.sessions ?? []}
      onNavigate={opts.onNavigate ?? vi.fn()}
      dense={opts.dense ?? false}
    />,
  );
}

const MONITORED = makeWindow({
  windowId: "@1",
  name: "worker-one",
  monitored: true,
  monitoredChange: "wuiu",
  monitoredStage: "review",
  monitoredRepo: "/home/user/code/run-kit",
  agentState: "waiting",
  agentIdleDuration: "6m",
});

describe("WatchedTasks", () => {
  it("renders the watched rows and navigates on a row click", () => {
    const onNavigate = vi.fn();
    renderTasks({
      server: "srv1",
      onNavigate,
      sessions: [
        makeSession({ name: "dev", operatorLastTickAt: NOW - 30, windows: [MONITORED] }),
        makeSession({ name: "_rk-operator", windows: [makeWindow({ role: "operator" })] }),
      ],
    });

    expect(screen.getByTestId("watched-tasks")).toBeInTheDocument();
    expect(screen.getAllByTestId("watched-row")).toHaveLength(1);
    expect(screen.getByText("worker-one")).toBeInTheDocument();
    expect(screen.queryByTestId("watched-tasks-hint")).toBeNull();
    expect(screen.queryByTestId("watched-tasks-banner")).toBeNull();

    fireEvent.click(screen.getByTestId("watched-row-navigate"));
    expect(onNavigate).toHaveBeenCalledWith("@1");
  });

  it("shows the pinned banner with the tick age when the watchlist is stale, and dims the table", () => {
    renderTasks({
      server: "srv1",
      sessions: [
        makeSession({
          name: "dev",
          operatorStale: true,
          operatorLastTickAt: NOW - 20 * 60,
          windows: [MONITORED],
        }),
      ],
    });

    const banner = screen.getByTestId("watched-tasks-banner");
    expect(banner).toHaveTextContent("operator tick — last seen 20m ago");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner.className).toContain("text-signal-yellow");
    // The stale verdict passes through to the table's dimming.
    expect(screen.getByTestId("watched-table").className).toContain("opacity-50");
  });

  it("reads `no recent tick` when stale but no session carries a tick", () => {
    renderTasks({
      server: "srv1",
      sessions: [makeSession({ operatorStale: true, windows: [MONITORED] })],
    });
    expect(screen.getByTestId("watched-tasks-banner")).toHaveTextContent(
      "operator tick — no recent tick",
    );
  });

  it("an empty server renders only the `no workspace resolved` hint", () => {
    renderTasks({ server: "", sessions: [] });
    expect(screen.getByTestId("watched-tasks-hint")).toHaveTextContent(
      "no workspace resolved — watchlist unavailable",
    );
    expect(screen.queryByTestId("watched-tasks-banner")).toBeNull();
    expect(screen.queryByTestId("watched-table")).toBeNull();
  });

  it("no operator window and no tick renders `No operator on this workspace`", () => {
    renderTasks({
      server: "srv1",
      sessions: [makeSession({ windows: [makeWindow({ windowId: "@1" })] })],
    });
    expect(screen.getByTestId("watched-tasks-hint")).toHaveTextContent(
      "No operator on this workspace",
    );
  });

  it("an operator with an empty tracked list renders `No tracked items`", () => {
    renderTasks({
      server: "srv1",
      sessions: [
        makeSession({
          operatorLastTickAt: NOW - 10,
          operatorTracked: [],
          windows: [makeWindow({ windowId: "@9", role: "operator" })],
        }),
      ],
    });
    expect(screen.getByTestId("watched-tasks-hint")).toHaveTextContent("No tracked items");
  });

  it("renders a note item row (kind chip, id, refs, truncated text, age) beside the worker row, with the summary line", () => {
    renderTasks({
      server: "srv1",
      sessions: [
        makeSession({
          name: "dev",
          operatorLastTickAt: NOW - 30,
          operatorTracked: [
            {
              id: "wuiu",
              kind: "fab-change",
              pane: "%1",
              windowId: "@1",
              repo: "/home/user/code/run-kit",
              stage: "review",
              updatedAt: NOW - 120,
            },
            {
              id: "n3",
              kind: "note",
              text: "Daemon reliability plan — archive once merged.",
              refs: ["bf1l"],
              updatedAt: NOW - 3600,
            },
          ],
          windows: [MONITORED],
        }),
      ],
    });

    expect(screen.getByTestId("watched-tasks-summary")).toHaveTextContent("2 tracked · 1 watched");
    expect(screen.getAllByTestId("watched-row")).toHaveLength(1);

    const row = screen.getByTestId("tracked-item-row");
    expect(within(row).getByText("note").className).toContain("bg-accent/10");
    expect(within(row).getByText("n3")).toBeInTheDocument();
    expect(within(row).getByText("bf1l")).toBeInTheDocument();
    expect(
      within(row).getByText("Daemon reliability plan — archive once merged."),
    ).toBeInTheDocument();
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("updated 1h ago");
    // No navigation affordance on an item row.
    expect(row.querySelector('[data-testid="watched-row-navigate"]')).toBeNull();
  });

  it("a done item renders dimmed with data-done and counts as tracked, not watched", () => {
    renderTasks({
      server: "srv1",
      sessions: [
        makeSession({
          name: "dev",
          operatorLastTickAt: NOW - 30,
          operatorTracked: [
            { id: "wuiu", kind: "fab-change", pane: "%1", windowId: "@1", updatedAt: NOW - 60 },
            { id: "n9", kind: "note", text: "done note", doneAt: NOW - 600, updatedAt: NOW - 600 },
          ],
          windows: [MONITORED],
        }),
      ],
    });

    expect(screen.getByTestId("watched-tasks-summary")).toHaveTextContent("2 tracked · 1 watched");
    const row = screen.getByTestId("tracked-item-row");
    expect(row).toHaveAttribute("data-done", "true");
    expect(row.className).toContain("opacity-50");
    expect(within(row).getByText("done")).toBeInTheDocument();
  });

  it("the expand toggle reveals the note's full text in place", () => {
    const text = "A long note body that the cell truncates until expanded.";
    renderTasks({
      server: "srv1",
      sessions: [
        makeSession({
          operatorLastTickAt: NOW - 30,
          operatorTracked: [{ id: "n3", kind: "note", text, updatedAt: NOW - 60 }],
          windows: [],
        }),
      ],
    });

    const toggle = screen.getByTestId("tracked-item-expand");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.className).toContain("truncate");
    fireEvent.click(toggle);
    const expanded = screen.getByTestId("tracked-item-expand");
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    expect(expanded.className).toContain("whitespace-pre-wrap");
  });

  it("a payload without operatorTracked (older backend) still renders monitored-derived worker rows", () => {
    const onNavigate = vi.fn();
    renderTasks({
      server: "srv1",
      onNavigate,
      sessions: [makeSession({ name: "dev", operatorLastTickAt: NOW - 30, windows: [MONITORED] })],
    });

    expect(screen.getAllByTestId("watched-row")).toHaveLength(1);
    expect(screen.getByText("worker-one")).toBeInTheDocument();
    expect(screen.getByTestId("watched-tasks-summary")).toHaveTextContent("1 tracked · 1 watched");
    fireEvent.click(screen.getByTestId("watched-row-navigate"));
    expect(onNavigate).toHaveBeenCalledWith("@1");
  });

  it("passes dense through to the table padding", () => {
    renderTasks({
      server: "srv1",
      dense: true,
      sessions: [makeSession({ name: "dev", windows: [MONITORED] })],
    });
    const row = screen.getByTestId("watched-row");
    expect(row.querySelectorAll("td")[0].className).toContain("py-0.5");
  });
});
