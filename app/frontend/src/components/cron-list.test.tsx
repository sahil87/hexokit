import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { CronList } from "./cron-list";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import type { CronEntry, CronListResponse } from "@/api/client";

const SERVER = "srv";

// Timestamps are derived from the REAL clock at setup (no fake timers — they
// stall Testing Library's async queries), rounded off unit boundaries so
// formatDuration output is stable.
const NOW_SEC = Math.floor(Date.now() / 1000);

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

const ENTRIES: CronEntry[] = [
  makeEntry({ id: "soon", name: "soon job", nextFire: NOW_SEC + 300 }),
  makeEntry({ id: "undated", name: "undated job" }),
  makeEntry({
    id: "mute",
    name: "muted job",
    // +90s (not +60s): the remaining time must stay in the 1m bucket even
    // when the wall clock crosses a second boundary between setup and render.
    nextFire: NOW_SEC + 90,
    muted: true,
    mutedUntil: NOW_SEC + 1500,
  }),
  makeEntry({
    id: "back",
    name: "backoff job",
    schedule: { kind: "backoff", min: "60s", max: "30m" },
    rung: 3,
    deliver: "when-idle",
    pinned: true,
    nextFire: NOW_SEC - 30,
  }),
  makeEntry({
    id: "orph",
    schedule: { kind: "every", interval: "5m" },
    orphaned: true,
    orphanedSince: NOW_SEC - 600,
  }),
];

function installFetch(payload: CronListResponse = { entries: ENTRIES, deliveries: [] }) {
  const stub = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", stub);
  return { stub };
}

function renderList(server: string) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        currentServer: server || null,
        sessionsByServer: new Map([[server, []]]),
        isConnectedByServer: new Map([[server, true]]),
      }}
    >
      <CronList server={server} />
    </StandaloneSessionContextProvider>,
  );
}

function rowOrder(): (string | null)[] {
  const list = screen.getByTestId("cron-list");
  return [...list.querySelectorAll("[data-testid]")]
    .map((el) => el.getAttribute("data-testid"))
    .filter((t) => t !== null && t.startsWith("cron-list-row-"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CronList", () => {
  it("sorts soonest-fire-first with undated entries last, dimmed never omitted", async () => {
    installFetch();
    renderList(SERVER);
    await screen.findByTestId("cron-list-row-soon");
    // `back` is past due (earliest nextFire), then muted (1m), soon (5m), then
    // the two undated rows by name.
    expect(rowOrder()).toEqual([
      "cron-list-row-back",
      "cron-list-row-mute",
      "cron-list-row-soon",
      "cron-list-row-orph",
      "cron-list-row-undated",
    ]);
    expect(screen.getByTestId("cron-list-row-mute").className).toContain("opacity-50");
    expect(screen.getByTestId("cron-list-row-orph").className).toContain("opacity-50");
    expect(screen.getByTestId("cron-list-row-soon").className).not.toContain("opacity-50");
  });

  it("renders the row anatomy: fallback label, chip, schedule, next fire, rung, deliver marker, flags", async () => {
    installFetch();
    renderList(SERVER);
    const back = await screen.findByTestId("cron-list-row-back");
    expect(back).toHaveTextContent("backoff job");
    expect(back).toHaveTextContent("role: operator");
    expect(back).toHaveTextContent("backs off from 1 minute up to 30 minutes since last activity");
    expect(back).toHaveTextContent("rung 3");
    expect(within(back).getByTestId("cron-list-deliver")).toHaveTextContent("when-idle");
    expect(back).toHaveTextContent("due");
    expect(back).toHaveTextContent("pinned");

    // The live lease renders its remaining time; the orphan its age.
    expect(screen.getByTestId("cron-list-row-mute")).toHaveTextContent(/muted (24|25)m/);
    expect(screen.getByTestId("cron-list-row-mute")).toHaveTextContent(/in (1|2)m/);
    expect(screen.getByTestId("cron-list-row-orph")).toHaveTextContent(/orphaned (9|10)m/);
    expect(screen.getByTestId("cron-list-row-soon")).toHaveTextContent(/in (4|5)m/);
    // Undated rows carry the em-dash; the unnamed orphan falls back to its id.
    expect(screen.getByTestId("cron-list-row-undated")).toHaveTextContent("—");
    expect(screen.getByTestId("cron-list-row-orph")).toHaveTextContent("orph");

    // No marker on an immediate-delivery row.
    expect(
      within(screen.getByTestId("cron-list-row-soon")).queryByTestId("cron-list-deliver"),
    ).toBeNull();
  });

  it("tapping a row opens the entry detail sheet", async () => {
    installFetch();
    renderList(SERVER);
    fireEvent.click(await screen.findByTestId("cron-list-row-soon"));
    expect(
      await screen.findByRole("dialog", { name: "Cron entry soon job" }),
    ).toBeInTheDocument();
  });

  it("header click re-sorts by entry label and aria-sort reflects it", async () => {
    installFetch();
    renderList(SERVER);
    await screen.findByTestId("cron-list-row-soon");

    const entryHeader = screen.getByText("entry").closest("th");
    expect(entryHeader).toHaveAttribute("aria-sort", "none");
    // The `next` column carries the at-rest ascending sort.
    expect(screen.getByText("next").closest("th")).toHaveAttribute("aria-sort", "ascending");

    fireEvent.click(screen.getByLabelText("Sort by entry"));
    expect(entryHeader).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByText("next").closest("th")).toHaveAttribute("aria-sort", "none");
    expect(rowOrder()).toEqual([
      "cron-list-row-back",
      "cron-list-row-mute",
      "cron-list-row-orph",
      "cron-list-row-soon",
      "cron-list-row-undated",
    ]);
  });

  it("+ New entry opens the create dialog", async () => {
    installFetch();
    renderList(SERVER);
    fireEvent.click(await screen.findByTestId("cron-list-new"));
    expect(await screen.findByRole("dialog", { name: "New cron entry" })).toBeInTheDocument();
  });

  it("the empty state keeps the affordance and shows the CLI hint", async () => {
    installFetch({ entries: [], deliveries: [] });
    renderList(SERVER);
    expect(await screen.findByTestId("cron-list-empty")).toHaveTextContent(
      "Agents can schedule prompts too — rk cron add.",
    );
    expect(screen.getByTestId("cron-list-new")).toBeInTheDocument();
  });

  it("degrades to the hint state on an unresolvable server and fires no request", async () => {
    const { stub } = installFetch();
    render(
      <StandaloneSessionContextProvider value={{ currentServer: null }}>
        <CronList server="" />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getByTestId("cron-list-unresolved")).toHaveTextContent("no workspace resolved");
    expect(stub).not.toHaveBeenCalled();
  });
});
