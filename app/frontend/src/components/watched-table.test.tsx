import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { makeWindow } from "@/test-utils/fixtures";
import { NOTE_STALE_SECONDS } from "@/components/sidebar/row-flyout-card";
import type { TrackedRow } from "@/components/server-watched-zone/model";
import type { OperatorTrackedItem, WindowInfo } from "@/types";
import { WatchedTable } from "./watched-table";

const NOW = 1_800_000_000;

afterEach(cleanup);

/** A worker row over a monitored window — the WATCHED zone's row shape. */
function workerRow(
  win: WindowInfo,
  opts: { session?: string; item?: OperatorTrackedItem; done?: boolean } = {},
): TrackedRow {
  return {
    kind: "worker",
    item: opts.item ?? { id: win.monitoredChange ?? "", windowId: win.windowId },
    session: opts.session ?? "dev",
    win,
    done: opts.done ?? false,
  };
}

function itemRow(item: OperatorTrackedItem, done = false): TrackedRow {
  return { kind: "item", item, done };
}

function renderTable(
  rows: TrackedRow[],
  opts: { stale?: boolean; onNavigate?: (windowId: string) => void; dense?: boolean } = {},
) {
  return render(
    <WatchedTable
      rows={rows}
      stale={opts.stale ?? false}
      nowSeconds={NOW}
      onNavigate={opts.onNavigate ?? vi.fn()}
      dense={opts.dense ?? false}
    />,
  );
}

describe("WatchedTable", () => {
  it("renders one row per entry with the six columns, and navigates on name click", () => {
    const onNavigate = vi.fn();
    renderTable(
      [
        workerRow(
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
        ),
        workerRow(makeWindow({ windowId: "@3", name: "worker-two" }), { session: "ops" }),
      ],
      { onNavigate },
    );

    const rows = screen.getAllByTestId("watched-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("worker-one")).toBeInTheDocument();
    expect(screen.getByText("worker-two")).toBeInTheDocument();
    // The six headers.
    for (const col of ["status", "group", "change", "awaiting", "note", "repo"]) {
      expect(screen.getByText(col)).toBeInTheDocument();
    }

    fireEvent.click(screen.getAllByTestId("watched-row-navigate")[0]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("@1");
  });

  it("renders the registry cells: change + stage badge, awaiting, note, repo basename", () => {
    renderTable([
      workerRow(
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
      ),
    ]);

    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("wuiu")).toBeInTheDocument();
    expect(screen.getByText("review").className).toContain("bg-accent/10");
    expect(screen.getByText("waiting 6m").className).toContain("text-signal-yellow");
    expect(screen.getByText(/blocked on flaky e2e · 1h ago/)).toBeInTheDocument();
    expect(screen.getByText("run-kit")).toBeInTheDocument();
  });

  it("dims the whole table when stale", () => {
    renderTable([workerRow(makeWindow({ windowId: "@1", monitored: true }))], { stale: true });
    expect(screen.getByTestId("watched-table").className).toContain("opacity-50");
  });

  it("dims a note older than NOTE_STALE_SECONDS", () => {
    renderTable([
      workerRow(
        makeWindow({
          windowId: "@1",
          monitored: true,
          note: "old note",
          noteEpoch: NOW - NOTE_STALE_SECONDS - 60,
        }),
      ),
    ]);
    const noteCell = screen.getByText(/old note/).closest("td");
    expect(noteCell?.className).toContain("opacity-50");
  });

  it("renders — for absent facets and unknown agent state", () => {
    renderTable([workerRow(makeWindow({ windowId: "@1", monitored: true }))]);
    const row = screen.getByTestId("watched-row");
    expect(row.querySelectorAll("td")[2]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[3]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[4]).toHaveTextContent("—");
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("—");
  });

  it("the dense variant tightens cell and header padding (py-0.5 / pr-2), columns kept", () => {
    renderTable([workerRow(makeWindow({ windowId: "@1", monitored: true }))], { dense: true });

    const header = screen.getByText("status");
    expect(header.className).toContain("pr-2");
    expect(header.className).not.toContain("pr-3");
    const row = screen.getByTestId("watched-row");
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(6);
    expect(cells[0].className).toContain("py-0.5");
    expect(cells[0].className).toContain("pr-2");
    expect(cells[5].className).toContain("py-0.5");
  });

  it("the default variant keeps the Server page padding (py-1 / pr-3)", () => {
    renderTable([workerRow(makeWindow({ windowId: "@1", monitored: true }))]);
    const row = screen.getByTestId("watched-row");
    expect(row.querySelectorAll("td")[0].className).toContain("py-1");
    expect(row.querySelectorAll("td")[0].className).toContain("pr-3");
  });

  it("a done worker row dims with data-done, a done marker, facets from the item, and still navigates", () => {
    // The join excludes done items, so the live window carries no monitored*
    // facets — change/stage/repo render from the item.
    const onNavigate = vi.fn();
    renderTable(
      [
        workerRow(makeWindow({ windowId: "@1", name: "worker-one" }), {
          item: {
            id: "wuiu",
            kind: "fab-change",
            pane: "%1",
            windowId: "@1",
            stage: "apply",
            repo: "/home/user/code/run-kit",
            doneAt: NOW - 300,
          },
          done: true,
        }),
      ],
      { onNavigate },
    );

    const row = screen.getByTestId("watched-row");
    expect(row.className).toContain("opacity-50");
    expect(row).toHaveAttribute("data-done", "true");
    expect(row).toHaveTextContent("wuiu");
    expect(screen.getByText("apply").className).toContain("bg-accent/10");
    expect(row).toHaveTextContent("done");
    expect(screen.getByText("run-kit")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("watched-row-navigate"));
    expect(onNavigate).toHaveBeenCalledWith("@1");
  });

  it("a done worker row never borrows the window's live monitored* facets", () => {
    // The done item's window has since been claimed by a different live item
    // (the join stamped that item's facets on the window); the done row must
    // describe its own item, not the newcomer.
    renderTable([
      workerRow(
        makeWindow({
          windowId: "@1",
          name: "worker-one",
          monitored: true,
          monitoredChange: "newb",
          monitoredStage: "review",
          monitoredRepo: "/home/user/code/other-repo",
        }),
        { item: { id: "olda", kind: "fab-change", pane: "%1", windowId: "@1", doneAt: NOW - 300 }, done: true },
      ),
    ]);
    const row = screen.getByTestId("watched-row");
    expect(row).toHaveTextContent("olda");
    expect(row).not.toHaveTextContent("newb");
    expect(row).not.toHaveTextContent("review");
    expect(row).not.toHaveTextContent("other-repo");
  });

  it("a paused worker row marks paused after the stage badge", () => {
    renderTable([
      workerRow(
        makeWindow({
          windowId: "@1",
          monitored: true,
          monitoredChange: "wuiu",
          monitoredStage: "review",
        }),
        { item: { id: "wuiu", windowId: "@1", paused: true } },
      ),
    ]);
    const badge = screen.getByText("review");
    const paused = screen.getByText("paused");
    expect(paused.className).toContain("text-signal-yellow");
    expect(badge.compareDocumentPosition(paused) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an item row renders kind chip + id, session, refs, awaiting, truncated text, and the age stamp", () => {
    renderTable([
      itemRow({
        id: "n3",
        kind: "note",
        text: "Daemon reliability plan — archive once merged.",
        refs: ["bf1l", "xy8b"],
        session: "ops",
        repo: "/home/user/code/run-kit",
        updatedAt: NOW - 3600,
      }),
    ]);

    const row = screen.getByTestId("tracked-item-row");
    expect(row.querySelectorAll("td")).toHaveLength(6);
    expect(within(row as HTMLElement).getByText("note").className).toContain("bg-accent/10");
    expect(within(row as HTMLElement).getByText("n3").className).toContain("text-text-primary");
    expect(screen.getByText("ops")).toBeInTheDocument();
    expect(screen.getByText("bf1l, xy8b")).toBeInTheDocument();
    expect(screen.getByText("Daemon reliability plan — archive once merged.")).toBeInTheDocument();
    expect(row.querySelectorAll("td")[5]).toHaveTextContent("run-kit · updated 1h ago");
    // No navigation affordance on an item row.
    expect(row.querySelector('[data-testid="watched-row-navigate"]')).toBeNull();
  });

  it("an item row's awaiting cell: paused (yellow) / done / pane gone / —", () => {
    renderTable([
      itemRow({ id: "p", kind: "task", paused: true }),
      itemRow({ id: "d", kind: "note", text: "finished" }, true),
      itemRow({ id: "g", kind: "fab-change", pane: "%99" }),
      itemRow({ id: "n", kind: "note" }),
    ]);
    const rows = screen.getAllByTestId("tracked-item-row");
    expect(rows[0].querySelectorAll("td")[3]).toHaveTextContent("paused");
    expect(rows[0].querySelectorAll("td")[3].querySelector("span")?.className).toContain(
      "text-signal-yellow",
    );
    expect(rows[1].querySelectorAll("td")[3]).toHaveTextContent("done");
    expect(rows[2].querySelectorAll("td")[3]).toHaveTextContent("pane gone");
    expect(rows[3].querySelectorAll("td")[3]).toHaveTextContent("—");
    // The done item row dims too.
    expect(rows[1]).toHaveAttribute("data-done", "true");
    expect(rows[1].className).toContain("opacity-50");
  });

  it("the expand toggle swaps the truncated note for the full text and back", () => {
    const text = "A very long note that would otherwise truncate in the cell.";
    renderTable([itemRow({ id: "n3", kind: "note", text })]);

    const toggle = screen.getByTestId("tracked-item-expand");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.className).toContain("truncate");

    fireEvent.click(toggle);
    const expanded = screen.getByTestId("tracked-item-expand");
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    expect(expanded.className).toContain("whitespace-pre-wrap");
    expect(expanded.className).not.toContain("truncate");

    fireEvent.click(expanded);
    expect(screen.getByTestId("tracked-item-expand")).toHaveAttribute("aria-expanded", "false");
  });

  it("headers carry aria-sort, and sorting by awaiting puts waiting rows first", () => {
    renderTable([
      workerRow(makeWindow({ windowId: "@1", name: "idle-worker", monitored: true, monitoredChange: "idle", agentState: "idle", agentIdleDuration: "12m" })),
      workerRow(makeWindow({ windowId: "@2", name: "waiting-worker", monitored: true, monitoredChange: "wait", agentState: "waiting", agentIdleDuration: "6m" })),
      workerRow(makeWindow({ windowId: "@3", name: "plain-worker", monitored: true, monitoredChange: "plan" })),
    ]);

    const awaitingHeader = screen.getByText("awaiting").closest("th");
    expect(awaitingHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(screen.getByLabelText("Sort by awaiting"));
    expect(awaitingHeader).toHaveAttribute("aria-sort", "ascending");
    const names = screen
      .getAllByTestId("watched-row-navigate")
      .map((el) => el.textContent);
    expect(names).toEqual(["waiting-worker", "idle-worker", "plain-worker"]);

    fireEvent.click(screen.getByLabelText("Sort by awaiting"));
    expect(awaitingHeader).toHaveAttribute("aria-sort", "descending");
    const reversed = screen
      .getAllByTestId("watched-row-navigate")
      .map((el) => el.textContent);
    expect(reversed).toEqual(["plain-worker", "idle-worker", "waiting-worker"]);
  });

  it("sorting by awaiting ignores the age of active rows (they tie, as before)", () => {
    renderTable([
      workerRow(makeWindow({ windowId: "@1", name: "old-active", monitored: true, monitoredChange: "a", agentState: "active", agentIdleDuration: "12m" })),
      workerRow(makeWindow({ windowId: "@2", name: "young-active", monitored: true, monitoredChange: "b", agentState: "active", agentIdleDuration: "1m" })),
      workerRow(makeWindow({ windowId: "@3", name: "idle-worker", monitored: true, monitoredChange: "c", agentState: "idle", agentIdleDuration: "1m" })),
    ]);
    fireEvent.click(screen.getByLabelText("Sort by awaiting"));
    const names = screen.getAllByTestId("watched-row-navigate").map((el) => el.textContent);
    // Both active rows rank ahead of idle; their hidden ages contribute nothing,
    // so they keep their input order instead of re-ordering by age.
    expect(names).toEqual(["old-active", "young-active", "idle-worker"]);
  });

  it("an item row falls back to `added … ago` and then —", () => {
    renderTable([
      itemRow({ id: "a", kind: "note", addedAt: NOW - 600 }),
      itemRow({ id: "b", kind: "note" }),
    ]);
    expect(screen.getByText("added 10m ago")).toBeInTheDocument();
    const rows = screen.getAllByTestId("tracked-item-row");
    expect(rows[1].querySelectorAll("td")[5]).toHaveTextContent("—");
  });
});
