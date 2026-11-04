// Workspace page WATCHED zone — the operator-watchlist detail table below
// the Sessions grid on `/default` on desktop; on mobile the same footer slot
// carries the Cron section (`clock-zone-cron` — the phone's operator-less
// cron registry) instead. The retired CRONS and RECENT DELIVERIES zones must
// stay gone; the zone root keeps its legacy `server-clock-dashboard` test id
// on both form factors and the desktop wrapper its legacy `clock-zone-watched`.
//
// Shared setup: fully mocked (no tmux). The sessions payload rides the
// state-socket mock — a `dev` session whose `@1` window carries the monitored
// facets (the WATCHED row) plus an operator window `@9` with
// `role: "operator"` in `_rk-operator`, and `operatorLastTickAt` stamped on
// both sessions so the zone's side readout has a tick age. `GET /api/cron` is
// stubbed via page.route (trailing `*` — the client appends `?server=` via
// withServer) with one entry (`a3f9`) and no deliveries: on desktop only the
// status bar's clock chip reads it (no cron surface renders on the page); on
// mobile it is the Cron section's registry row. `/api/servers`
// feeds the server list; `/ws/terminals` is a no-op socket mock so the shell
// mounts without stream data. Desktop tests run at 1280×800, the mobile case
// at 375×812. No host-global state is saved or restored.
import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

const SERVER = "default";
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };

const NOW = Math.floor(Date.now() / 1000);

const SESSIONS = JSON.stringify([
  {
    name: "dev",
    operatorLastTickAt: NOW - 60,
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "feature-work",
        worktreePath: "/tmp/wt",
        activity: "active",
        isActiveWindow: true,
        activityTimestamp: 0,
        monitored: true,
        monitoredChange: "wuiu",
        monitoredStage: "review",
        monitoredRepo: "/home/user/code/run-kit",
        agentState: "waiting",
        agentIdleDuration: "6m",
        panes: [{ paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true }],
      },
    ],
  },
  {
    name: "_rk-operator",
    operatorLastTickAt: NOW - 60,
    windows: [
      {
        windowId: "@9",
        index: 0,
        name: "operator",
        worktreePath: "/tmp/op",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
        role: "operator",
        panes: [{ paneId: "%9", paneIndex: 0, cwd: "/tmp/op", command: "claude", isActive: true }],
      },
    ],
  },
]);

// One cron entry so the mobile Cron section has a registry row; the desktop
// page renders no cron surface (the status bar's chip still reads it).
const CRON = JSON.stringify({
  entries: [
    {
      id: "a3f9",
      name: "operator tick",
      schedule: { kind: "backoff", min: "60s", max: "30m" },
      target: { kind: "role", role: "operator" },
      payload: "tick",
      lastFired: NOW - 120,
      nextFire: NOW + 3600,
    },
  ],
  deliveries: [],
});

/** Install the mocked backend (state socket + servers + the cron read). */
async function mockBackend(page: Page) {
  await mockStateSocket(page, { sessions: SESSIONS });
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 2 }]),
    }),
  );
  await page.route("**/api/cron*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: CRON,
    }),
  );
}

/** Land on the server route and wait for the tiles to render. */
async function gotoServerPage(page: Page) {
  await page.goto(`/${SERVER}`);
  await expect(page.getByTestId("session-tile-dev")).toBeVisible({ timeout: 10_000 });
}

test.describe("Server page WATCHED zone", () => {
  /**
   * Proves: on the desktop server route the WATCHED zone renders below the
   * Sessions grid, and the retired CRONS / RECENT DELIVERIES zones are gone —
   * neither their wrappers nor their headings exist.
   *
   * Steps:
   * 1. Set the 1280×800 viewport; mock the backend; land on `/default`.
   * 2. Assert the zone root and the watched wrapper are visible, with the
   *    WATCHED heading below the Sessions heading (bounding-box y).
   * 3. Assert the watched row for the monitored window renders.
   * 4. Assert no `clock-zone-crons` / `clock-zone-deliveries` wrappers and no
   *    `Crons` / `Recent Deliveries` headings exist.
   */
  test("WATCHED renders below the Sessions grid; CRONS and RECENT DELIVERIES are absent", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await mockBackend(page);
    await gotoServerPage(page);

    await expect(page.getByTestId("server-clock-dashboard")).toBeVisible();
    await expect(page.getByTestId("clock-zone-watched")).toBeVisible();

    const sessionsHeading = page.getByRole("heading", { name: "Groups" });
    const watchedHeading = page.getByRole("heading", { name: "Watched" });
    await expect(sessionsHeading).toBeVisible();
    await expect(watchedHeading).toBeVisible();
    const sessionsBox = await sessionsHeading.boundingBox();
    const watchedBox = await watchedHeading.boundingBox();
    expect(sessionsBox).not.toBeNull();
    expect(watchedBox!.y).toBeGreaterThan(sessionsBox!.y);

    await expect(page.getByTestId("watched-row")).toHaveCount(1);

    await expect(page.getByTestId("clock-zone-crons")).toHaveCount(0);
    await expect(page.getByTestId("clock-zone-deliveries")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Crons" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Recent Deliveries" })).toHaveCount(0);
  });

  /**
   * Proves: the WATCHED zone's table has a real header row — one `scope="col"`
   * header per column carrying `aria-sort`, and clicking a header sorts the
   * rows (the shared DataTable contract).
   *
   * Steps:
   * 1. Set the 1280×800 viewport; mock the backend; land on `/default`.
   * 2. Assert the six column headers render with `aria-sort` (all `none` at
   *    rest) and each carries a `Sort by …` button.
   * 3. Click `Sort by status`; assert the `status` header reads
   *    `aria-sort="ascending"` and the others stay `none`.
   */
  test("the WATCHED table has a sortable header row", async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await mockBackend(page);
    await gotoServerPage(page);

    const table = page.getByTestId("watched-table");
    await expect(table).toBeVisible();
    const headers = table.locator('th[scope="col"]');
    await expect(headers).toHaveCount(6);
    for (const name of ["status", "group", "change", "awaiting", "note", "repo"]) {
      await expect(table.getByLabel(`Sort by ${name}`)).toBeVisible();
    }
    await expect(headers.first()).toHaveAttribute("aria-sort", "none");

    await table.getByLabel("Sort by status").click();
    await expect(headers.first()).toHaveAttribute("aria-sort", "ascending");
    await expect(headers.nth(1)).toHaveAttribute("aria-sort", "none");
  });

  /**
   * Proves: the footer slot forks by form factor — the 375px mobile server
   * route keeps its session tiles and renders the Cron section (the phone's
   * cron registry — heading, `+ New entry`, the stubbed entry row — which
   * needs no operator and renders whether or not the fixture's operator
   * window exists) in place of the WATCHED zone, which stays desktop-only.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend; land on `/default`.
   * 2. Assert the session tiles and the `server-clock-dashboard` root render.
   * 3. Assert the `clock-zone-cron` section is visible with the `Cron`
   *    heading, the stubbed cron row, and `+ New entry`.
   * 4. Assert no `clock-zone-watched` wrapper or `watched-table` exists.
   */
  test("the mobile viewport renders the Cron section in place of WATCHED", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page);
    await gotoServerPage(page);

    await expect(page.getByTestId("session-tile-dev")).toBeVisible();
    await expect(page.getByTestId("server-clock-dashboard")).toBeVisible();
    const zone = page.getByTestId("clock-zone-cron");
    await expect(zone).toBeVisible();
    await expect(zone.getByRole("heading", { name: "Cron" })).toBeVisible();
    await expect(zone.getByTestId("cron-list-row-a3f9")).toBeVisible({ timeout: 10_000 });
    await expect(zone.getByTestId("cron-list-new")).toBeVisible();
    await expect(page.getByTestId("clock-zone-watched")).toHaveCount(0);
    await expect(page.getByTestId("watched-table")).toHaveCount(0);
  });
});
