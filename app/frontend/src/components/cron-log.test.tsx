import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { CronLog } from "./cron-log";
import { resetDataTableViewState } from "@/components/data-table";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import type { CronEntry, CronListResponse } from "@/api/client";

const SERVER = "srv";

// Timestamps are derived from the REAL clock at setup (no fake timers — they
// stall Testing Library's async queries), rounded off unit boundaries so
// formatDuration output is stable.
const NOW_SEC = Math.floor(Date.now() / 1000);

const ENTRIES: CronEntry[] = [
  {
    id: "soon",
    name: "soon job",
    schedule: { kind: "every", interval: "10m" },
    target: { kind: "role", role: "operator" },
    payload: "p",
    lastFired: 0,
    nextFire: NOW_SEC + 300,
  },
];

const CRON_RESPONSE: CronListResponse = {
  entries: ENTRIES,
  deliveries: [
    { ts: NOW_SEC - 540, entry: "soon", name: "soon job", target: "%1", reason: "schedule", outcome: "delivered" },
    { ts: NOW_SEC - 9000, entry: "gone", target: "%2", reason: "schedule", outcome: "failed" },
  ],
};

function installFetch(payload: CronListResponse = CRON_RESPONSE) {
  const calls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

function renderLog(server: string, inline = false) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        currentServer: server || null,
        sessionsByServer: new Map([[server, []]]),
        isConnectedByServer: new Map([[server, true]]),
      }}
    >
      <CronLog server={server} inline={inline} />
    </StandaloneSessionContextProvider>,
  );
}

function rowOrder(): (string | null)[] {
  const log = screen.getByTestId("cron-log");
  return [...log.querySelectorAll("[data-testid]")]
    .map((el) => el.getAttribute("data-testid"))
    .filter((t) => t !== null && t.startsWith("cron-delivery-row-"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Per-viewer table state persists in localStorage across tests in this file.
  localStorage.clear();
});

describe("CronLog", () => {
  it("renders one row per delivery, newest first, with no upcoming rows or divider", async () => {
    installFetch();
    renderLog(SERVER);
    await screen.findByTestId("cron-delivery-row-soon");
    expect(rowOrder()).toEqual(["cron-delivery-row-soon", "cron-delivery-row-gone"]);
    expect(screen.queryByTestId("cron-activity-now")).toBeNull();
    expect(screen.queryByTestId("cron-upcoming-row-soon")).toBeNull();
  });

  it("labels rows by name and outcome, with a relative age", async () => {
    installFetch();
    renderLog(SERVER);
    const delivered = await screen.findByTestId("cron-delivery-row-soon");
    expect(delivered).toHaveTextContent("soon job");
    expect(delivered).toHaveTextContent("delivered");
    expect(delivered).toHaveTextContent("9m ago");
    expect(screen.getByTestId("cron-delivery-row-gone")).toHaveTextContent("failed");
  });

  it("a row whose entry still exists opens the detail sheet; a deleted entry's row is not tappable", async () => {
    installFetch();
    renderLog(SERVER);
    fireEvent.click(await screen.findByTestId("cron-delivery-row-soon"));
    expect(
      await screen.findByRole("dialog", { name: "Cron entry soon job" }),
    ).toBeInTheDocument();
    cleanup();

    installFetch();
    renderLog(SERVER);
    const gone = await screen.findByTestId("cron-delivery-row-gone");
    expect(gone.tagName).not.toBe("BUTTON");
    // Inert history: no button role, no keyboard targeting, marked disabled.
    expect(gone).not.toHaveAttribute("role", "button");
    expect(gone).not.toHaveAttribute("tabindex");
    expect(gone).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(gone);
    fireEvent.keyDown(gone, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking `when` sorts oldest-first then newest-first; reset returns to API order", async () => {
    installFetch();
    renderLog(SERVER);
    await screen.findByTestId("cron-delivery-row-soon");

    const whenHeader = screen.getByText("when").closest("th");
    expect(whenHeader).toHaveAttribute("aria-sort", "none");

    fireEvent.click(screen.getByLabelText("Sort by when"));
    expect(whenHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowOrder()).toEqual(["cron-delivery-row-gone", "cron-delivery-row-soon"]);

    fireEvent.click(screen.getByLabelText("Sort by when"));
    expect(whenHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowOrder()).toEqual(["cron-delivery-row-soon", "cron-delivery-row-gone"]);

    act(() => resetDataTableViewState("cron-log"));
    expect(whenHeader).toHaveAttribute("aria-sort", "none");
    expect(rowOrder()).toEqual(["cron-delivery-row-soon", "cron-delivery-row-gone"]);
  });

  it("renders the single empty line when there are no deliveries", async () => {
    installFetch({ entries: ENTRIES, deliveries: [] });
    renderLog(SERVER);
    expect(await screen.findByTestId("cron-log-empty")).toHaveTextContent(
      "No deliveries yet on srv.",
    );
  });

  it("degrades to the hint state on an unresolvable server and fires no request", async () => {
    const { calls } = installFetch();
    render(
      <StandaloneSessionContextProvider value={{ currentServer: null }}>
        <CronLog server="" />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getByTestId("cron-log-unresolved")).toHaveTextContent("no workspace resolved");
    expect(calls).toHaveLength(0);
  });

  it("the inline variant makes the root relative so the sheet anchors in-container", async () => {
    installFetch();
    renderLog(SERVER, true);
    const log = await screen.findByTestId("cron-log");
    expect(log.className).toContain("relative");
  });
});

describe("CronLog operator-loop runs", () => {
  it("opens a run delivery's sheet with the run id, outcome and run log path", async () => {
    const loop: CronEntry = {
      id: "lp01",
      name: "operator loop",
      run: "operator-loop",
      schedule: { kind: "backoff", min: "3m", max: "24m" },
      target: { kind: "" },
      payload: "",
      lastFired: NOW_SEC - 60,
    };
    installFetch({
      entries: [loop],
      deliveries: [
        {
          ts: NOW_SEC - 60,
          entry: "lp01",
          name: "operator loop",
          target: "",
          reason: "schedule",
          outcome: "ran · stub acted · 20s",
          run: "20261112T101500-ab12",
          runLog: "/state/operator/runs/s/20261112T101500-ab12.log",
        },
        { ts: NOW_SEC - 300, entry: "lp01", name: "operator loop", target: "", reason: "schedule", outcome: "no change" },
      ],
    });
    renderLog(SERVER);
    const rows = await screen.findAllByTestId("cron-delivery-row-lp01");
    expect(rows[0]).toHaveTextContent("ran · stub acted · 20s");
    fireEvent.click(rows[0]);
    expect(await screen.findByTestId("cron-entry-run-log")).toHaveTextContent(
      "/state/operator/runs/s/20261112T101500-ab12.log",
    );
    expect(screen.getByTestId("cron-entry-run-id")).toHaveTextContent("20261112T101500-ab12");
    cleanup();

    installFetch({
      entries: [loop],
      deliveries: [
        { ts: NOW_SEC - 300, entry: "lp01", name: "operator loop", target: "", reason: "schedule", outcome: "no change" },
      ],
    });
    renderLog(SERVER);
    fireEvent.click(await screen.findByTestId("cron-delivery-row-lp01"));
    await screen.findByRole("dialog", { name: "Cron entry operator loop" });
    expect(screen.queryByTestId("cron-entry-run")).toBeNull();
  });
});
