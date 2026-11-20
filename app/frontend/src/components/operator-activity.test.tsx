import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { OperatorActivity, triggerLabel, checkSummary, runSummary } from "./operator-activity";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import type { OperatorActivityResponse, OperatorActivityRow } from "@/api/client";

const SERVER = "srv";
const NOW = Math.floor(Date.now() / 1000);
const FIRE = "20261112T101500-aaaa";
const RUN = "20261112T102100-cccc";

function check(over: Partial<NonNullable<OperatorActivityRow["check"]>> = {}): NonNullable<OperatorActivityRow["check"]> {
  return { checked_at: "t", changed: false, changes: [], open: [], notices: [], items: 0, ...over };
}

const ROWS: OperatorActivityRow[] = [
  {
    ts: NOW - 600,
    entry: "lp01",
    reason: "schedule",
    outcome: "no change",
    rung: 3,
    fire: FIRE,
    check: check({
      items: 2,
      changes: [{ kind: "note", id: "pr-41", at: "2026-11-12T10:00:00Z" }],
      open: [{ kind: "stale", id: "pr-42", age: "3d" }],
    }),
  },
  { ts: NOW - 700, entry: "lp01", reason: "trigger:manual", outcome: "no change", rung: 0, fire: "20261112T100000-bbbb", check: check() },
  {
    ts: NOW - 800,
    entry: "lp01",
    reason: "wake",
    outcome: "ran · fixed it · 20s",
    rung: 0,
    fire: RUN,
    check: check({ items: 1, changes: [{ kind: "stage-advance", id: "pr-7", from: "apply", to: "review" }] }),
    run: { id: RUN, outcome: "fixed it", duration_s: 20, has_brief: true, has_log: true },
  },
  { ts: NOW - 900, entry: "lp01", reason: "schedule", outcome: "skipped-busy: run xyz", rung: 0 },
];

function activity(over: Partial<OperatorActivityResponse> = {}): OperatorActivityResponse {
  return { server: SERVER, in_flight: null, rows: ROWS, ...over };
}

interface FetchCalls {
  activity: number;
  wakes: string[];
  files: string[];
}

/** Stubs the three endpoints; `activityFor` supplies each activity response in turn. */
function installFetch(opts: {
  activityFor?: () => OperatorActivityResponse;
  wake?: () => Response;
  file?: (url: string) => Response;
} = {}): FetchCalls {
  const calls: FetchCalls = { activity: 0, wakes: [], files: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/operator/wake")) {
        calls.wakes.push(String(init?.body));
        return opts.wake?.() ?? new Response("{}", { status: 200 });
      }
      if (url.startsWith("/api/operator/runs/")) {
        calls.files.push(url);
        return (
          opts.file?.(url) ??
          new Response(url.endsWith("/brief") ? "# the brief" : "log line", { status: 200 })
        );
      }
      calls.activity += 1;
      return new Response(JSON.stringify((opts.activityFor ?? activity)()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function renderActivity(server = SERVER) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        currentServer: server || null,
        sessionsByServer: new Map([[server, []]]),
        isConnectedByServer: new Map([[server, true]]),
      }}
    >
      <OperatorActivity server={server} />
    </StandaloneSessionContextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("row labels and summaries", () => {
  it("labels the trigger by reason", () => {
    expect(triggerLabel({ reason: "schedule", rung: 3 })).toBe("schedule · rung 3");
    expect(triggerLabel({ reason: "trigger:manual", rung: 0 })).toBe("manual");
    expect(triggerLabel({ reason: "trigger:pr-merged", rung: 0 })).toBe("trigger · pr-merged");
    expect(triggerLabel({ reason: "wake", rung: 0 })).toBe("trigger · agent");
    expect(triggerLabel({ reason: "something-else", rung: 0 })).toBe("something-else");
  });

  it("summarizes the check, with notices only when present, else the raw outcome", () => {
    expect(checkSummary({ outcome: "no change", check: check({ items: 2, changes: [{ kind: "n", id: "a" }], open: [{ kind: "s", id: "b" }] }) })).toBe(
      "2 items · 1 changes · 1 open",
    );
    expect(
      checkSummary({ outcome: "no change", check: check({ notices: [{ id: "x", kind: "paused", error: "e", failures: 1 }] }) }),
    ).toBe("0 items · 0 changes · 0 open · 1 notices");
    expect(checkSummary({ outcome: "check-failed: boom" })).toBe("check-failed: boom");
  });

  it("summarizes the run: running, mechanical with duration, or the outcome line as-is", () => {
    const base = { ts: NOW, entry: "e", reason: "schedule", rung: 0 };
    expect(runSummary({ ...base, outcome: "", running: true })).toBe("running…");
    expect(
      runSummary({ ...base, outcome: "ran · x", check: check(), run: { id: RUN, pass: { actions: 2 }, duration_s: 0, has_brief: false, has_log: false } }),
    ).toBe("mechanical · 2 actions");
    expect(
      runSummary({ ...base, outcome: "ran · x", check: check(), run: { id: RUN, pass: { actions: 1 }, duration_s: 20, has_brief: false, has_log: false } }),
    ).toBe("mechanical · 1 action · 20s");
    expect(
      runSummary({ ...base, outcome: "ran · fixed · 20s", check: check(), run: { id: RUN, pass: { actions: 2 }, outcome: "fixed", duration_s: 20, has_brief: false, has_log: false } }),
    ).toBe("ran · fixed · 20s");
    expect(runSummary({ ...base, outcome: "run-failed: exit 1", check: check() })).toBe("run-failed: exit 1");
    expect(runSummary({ ...base, outcome: "no change", check: check() })).toBe("");
    // Without a check record the outcome already shows in the check slot.
    expect(runSummary({ ...base, outcome: "skipped-busy: x" })).toBe("");
  });
});

describe("OperatorActivity rows", () => {
  it("renders one row per fire, newest first, with the trigger label and summaries", async () => {
    installFetch();
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByTestId("operator-activity-trigger")).toHaveTextContent("schedule · rung 3");
    expect(within(rows[0]).getByTestId("operator-activity-check")).toHaveTextContent("2 items · 1 changes · 1 open");
    expect(within(rows[1]).getByTestId("operator-activity-trigger")).toHaveTextContent("manual");
    expect(within(rows[2]).getByTestId("operator-activity-trigger")).toHaveTextContent("trigger · agent");
    expect(within(rows[2]).getByTestId("operator-activity-run")).toHaveTextContent("ran · fixed it · 20s");
    expect(within(rows[3]).getByTestId("operator-activity-check")).toHaveTextContent("skipped-busy: run xyz");
    expect(within(rows[0]).getByText(/10m ago/)).toBeInTheDocument();
  });

  it("shows the in-flight row as running…", async () => {
    installFetch({
      activityFor: () =>
        activity({
          in_flight: { id: RUN, started_at: "t" },
          rows: [{ ts: NOW, entry: "lp01", reason: "trigger:manual", outcome: "", rung: 0, fire: RUN, running: true, check: check({ items: 1 }) }, ...ROWS],
        }),
    });
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    expect(within(rows[0]).getByTestId("operator-activity-run")).toHaveTextContent("running…");
  });

  it("shows the empty state and the unresolved-server hint", async () => {
    installFetch({ activityFor: () => activity({ rows: [] }) });
    renderActivity();
    expect(await screen.findByTestId("operator-activity-empty")).toHaveTextContent("no operator activity yet");
    cleanup();

    const calls = installFetch();
    renderActivity("");
    expect(screen.getByTestId("operator-activity-unresolved")).toBeInTheDocument();
    expect(calls.activity).toBe(0);
  });

  it("keeps the last good rows when a refetch fails", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n > 1) throw new Error("offline");
        return new Response(JSON.stringify(activity()), { status: 200 });
      }),
    );
    renderActivity();
    expect(await screen.findAllByTestId("operator-activity-row")).toHaveLength(4);
  });
});

describe("filter chips", () => {
  it("defaults to all and filters runs / triggers as defined", async () => {
    installFetch({
      activityFor: () =>
        activity({
          rows: [
            { ts: NOW - 1, entry: "e", reason: "schedule", outcome: "no change", rung: 1, check: check() },
            { ts: NOW - 2, entry: "e", reason: "trigger:manual", outcome: "no change", rung: 0, check: check() },
            { ts: NOW - 3, entry: "e", reason: "wake", outcome: "ran · x", rung: 0, check: check(), run: { id: RUN, duration_s: 1, has_brief: false, has_log: false } },
          ],
        }),
    });
    renderActivity();
    await screen.findAllByTestId("operator-activity-row");
    expect(screen.getByTestId("operator-activity-filter-all")).toHaveAttribute("aria-pressed", "true");
    const labels = () => screen.getAllByTestId("operator-activity-trigger").map((el) => el.textContent);
    expect(labels()).toEqual(["schedule · rung 1", "manual", "trigger · agent"]);

    fireEvent.click(screen.getByTestId("operator-activity-filter-runs"));
    expect(labels()).toEqual(["trigger · agent"]);
    fireEvent.click(screen.getByTestId("operator-activity-filter-triggers"));
    expect(labels()).toEqual(["manual", "trigger · agent"]);
    fireEvent.click(screen.getByTestId("operator-activity-filter-all"));
    expect(labels()).toHaveLength(3);
  });

  it("counts the in-flight row under runs", async () => {
    installFetch({
      activityFor: () =>
        activity({ in_flight: { id: RUN, started_at: "t" }, rows: [{ ts: NOW, entry: "e", reason: "schedule", outcome: "", rung: 0, running: true, fire: RUN }] }),
    });
    renderActivity();
    await screen.findAllByTestId("operator-activity-row");
    fireEvent.click(screen.getByTestId("operator-activity-filter-runs"));
    expect(screen.getAllByTestId("operator-activity-row")).toHaveLength(1);
  });
});

describe("row expansion", () => {
  it("expands by click and by Enter/Space, with aria-expanded", async () => {
    installFetch();
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    const header = within(rows[0]).getByRole("button");
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(header, { key: " " });
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("lists the changed items, open items and notices", async () => {
    installFetch({
      activityFor: () =>
        activity({
          rows: [
            {
              ts: NOW, entry: "e", reason: "schedule", outcome: "no change", rung: 0,
              check: check({
                items: 2,
                changes: [{ kind: "stage-advance", id: "pr-7", from: "apply", to: "review" }],
                open: [{ kind: "stale", id: "pr-42", age: "3d" }],
                notices: [{ id: "pr-9", kind: "paused", error: "boom", failures: 2 }],
              }),
            },
          ],
        }),
    });
    renderActivity();
    fireEvent.click(within(await screen.findByTestId("operator-activity-row")).getByRole("button"));
    expect(screen.getByTestId("operator-activity-changed")).toHaveTextContent("pr-7 · stage-advance · apply→review");
    expect(screen.getByTestId("operator-activity-open")).toHaveTextContent("pr-42 · stale · 3d");
    expect(screen.getByTestId("operator-activity-notices")).toHaveTextContent("pr-9 · paused · boom (2×)");
  });

  it("fetches the brief and log once on first expand and shows them", async () => {
    const calls = installFetch();
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    expect(calls.files).toEqual([]);
    const header = within(rows[2]).getByRole("button");
    fireEvent.click(header);
    expect(await screen.findByText("# the brief")).toBeInTheDocument();
    expect(await screen.findByText("log line")).toBeInTheDocument();
    fireEvent.click(header);
    fireEvent.click(header);
    expect(calls.files.sort()).toEqual([
      `/api/operator/runs/${SERVER}/${RUN}/brief`,
      `/api/operator/runs/${SERVER}/${RUN}/log`,
    ]);
  });

  it("names the truncation per file and survives a fetch failure inline", async () => {
    installFetch({
      file: (url) =>
        url.endsWith("/brief")
          ? new Response("head", { status: 200, headers: { "X-Rk-Truncated": "true" } })
          : new Response(JSON.stringify({ error: "run file not found" }), { status: 404 }),
    });
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    fireEvent.click(within(rows[2]).getByRole("button"));
    expect(await screen.findByTestId("operator-activity-brief-truncated")).toHaveTextContent(
      "truncated — showing first 256 KiB",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("run file not found");
  });

  it("says last 256 KiB for a truncated log", async () => {
    installFetch({ file: () => new Response("tail", { status: 200, headers: { "X-Rk-Truncated": "true" } }) });
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    fireEvent.click(within(rows[2]).getByRole("button"));
    expect(await screen.findByTestId("operator-activity-log-truncated")).toHaveTextContent(
      "truncated — showing last 256 KiB",
    );
  });

  it("offers no run panes for a row without a run", async () => {
    const calls = installFetch();
    renderActivity();
    const rows = await screen.findAllByTestId("operator-activity-row");
    fireEvent.click(within(rows[0]).getByRole("button"));
    expect(screen.queryByTestId("operator-activity-brief")).not.toBeInTheDocument();
    expect(calls.files).toEqual([]);
  });
});

describe("Check now", () => {
  it("posts the wake once with {server}, then reads check queued until the next fetch returns", async () => {
    let release: (() => void) | null = null;
    let fetches = 0;
    const calls = installFetch({
      activityFor: activity,
    });
    // Hold the post-wake activity fetch so the transient state is observable.
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/operator/activity")) {
          fetches += 1;
          if (fetches > 1) await new Promise<void>((resolve) => (release = resolve));
        }
        return inner(input, init);
      }),
    );
    renderActivity();
    await screen.findAllByTestId("operator-activity-row");
    const button = screen.getByTestId("operator-activity-check-now");
    expect(button).toHaveTextContent("Check now");
    expect(button).toBeEnabled();

    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent("check queued"));
    expect(calls.wakes).toEqual([JSON.stringify({ server: SERVER })]);

    await waitFor(() => expect(release).not.toBeNull());
    release!();
    await waitFor(() => expect(button).toHaveTextContent("Check now"));
    expect(calls.wakes).toHaveLength(1);
  });

  it("is disabled and reads run in progress while a run is in flight", async () => {
    const calls = installFetch({
      activityFor: () => activity({ in_flight: { id: RUN, started_at: "t" } }),
    });
    renderActivity();
    const button = await screen.findByTestId("operator-activity-check-now");
    await waitFor(() => expect(button).toHaveTextContent("run in progress"));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(calls.wakes).toEqual([]);
  });

  it("shows an error state, never throwing, when the wake POST fails — and retries", async () => {
    let fail = true;
    const calls = installFetch({
      wake: () => (fail ? new Response(JSON.stringify({ error: "nope" }), { status: 500 }) : new Response("{}", { status: 200 })),
    });
    renderActivity();
    const button = await screen.findByTestId("operator-activity-check-now");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-state", "error"));
    expect(button).toHaveTextContent("check failed — retry");
    expect(button).toBeEnabled();
    fail = false;
    fireEvent.click(button);
    await waitFor(() => expect(calls.wakes).toHaveLength(2));
  });
});
