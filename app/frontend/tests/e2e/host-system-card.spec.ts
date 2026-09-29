import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// Fully mocked host-page spec: `mockBackend(page)` runs before each
// navigation — `GET /api/servers` is fulfilled with two servers (`regular`
// unprotected, `rk-daemon` with 2 sessions) and the state socket is the
// shared protocol mock. The rk-daemon server's sessions carry rk-jobs (one
// window) + rk-remotes (two windows) and NO rk-code-server session, so the
// card proves the running/not-running fork. The version slot carries the
// additive started/port fields (a ~1h-old daemon). No metrics slot is mocked,
// so the card renders against a metrics-less zone (independent of the
// host-metrics stream). /ws/terminals is accepted and held open — the
// terminal route after a View navigation mounts a relay socket.
const STARTED = Math.floor(Date.now() / 1000) - 3600;

const DAEMON_SESSIONS = JSON.stringify([
  {
    name: "rk-jobs",
    windows: [
      {
        windowId: "@7",
        index: 0,
        name: "update-check",
        worktreePath: "/tmp",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
      },
    ],
  },
  {
    name: "rk-remotes",
    windows: [
      {
        windowId: "@11",
        index: 0,
        name: "box-1",
        worktreePath: "/tmp",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
      },
      {
        windowId: "@12",
        index: 1,
        name: "box-2",
        worktreePath: "/tmp",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
      },
    ],
  },
]);

const REGULAR_SESSIONS = JSON.stringify([{ name: "main", windows: [] }]);

async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept and hold the socket open; send nothing */
  });

  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { name: "regular", sessionCount: 1 },
        { name: "rk-daemon", sessionCount: 2 },
      ]),
    }),
  );

  await mockStateSocket(page, {
    sessionsByServer: {
      "rk-daemon": DAEMON_SESSIONS,
      regular: REGULAR_SESSIONS,
    },
    version: { version: "3.9.1", boot: "b1", brew: false, started: STARTED, port: 3000 },
  });
}

test.describe("HexoKit system card (HOST HEALTH zone)", () => {
  /**
   * Proves: the system card renders inside the Host health zone with the
   * version/uptime/port daemon line and a Restart control; the service rows
   * derive live status from the rk-daemon server's sessions (jobs and remotes
   * running with View links, code-server not running without one); and the
   * shield glyph marks the rk-daemon tile (derived protection) while the
   * unprotected `regular` tile stays unmarked.
   *
   * Steps:
   * 1. Install the mocked backend, navigate to `/`.
   * 2. Assert the `HexoKit system` card is visible inside the `Host health` region.
   * 3. Assert the daemon line shows `v3.9.1`, an `up 1h…` uptime, and `:3000`.
   * 4. Assert the Restart button is visible.
   * 5. Assert the service rows: `1 job` and `2 tunnels` visible, one
   *    `not running` row (code-server), and exactly two View buttons.
   * 6. Assert the `shield-rk-daemon` glyph is visible on the TMUX SERVERS tile
   *    grid and no `shield-regular` glyph exists.
   */
  test("renders the daemon line, service rows, and the rk-daemon shield glyph on the tile grid", async ({
    page,
  }) => {
    await mockBackend(page);
    await page.goto("/");

    // The card renders inside the Host health zone (no metrics slot was
    // mocked — the card is independent of the metrics stream).
    const zone = page.getByRole("region", { name: "Host health" });
    const card = zone.getByLabel("HexoKit system");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText("v3.9.1");
    await expect(card).toContainText("up 1h");
    await expect(card).toContainText(":3000");
    await expect(card.getByRole("button", { name: "Restart" })).toBeVisible();

    // Service rows: jobs + remotes running with View links, code-server not
    // running with none.
    await expect(card.getByText("1 job")).toBeVisible();
    await expect(card.getByText("2 tunnels")).toBeVisible();
    await expect(card.getByText("not running")).toBeVisible();
    await expect(card.getByRole("button", { name: "View" })).toHaveCount(2);

    // The shield glyph marks the rk-daemon tile (derived) and leaves the
    // unprotected regular tile unmarked.
    await expect(page.getByTestId("shield-rk-daemon")).toBeVisible();
    await expect(page.getByTestId("shield-regular")).toHaveCount(0);
  });

  /**
   * Proves: a service row's View action navigates to the ordinary
   * `/$server/$window` terminal route for that sibling session's active
   * window on the rk-daemon server — the reframe loses no terminal access.
   *
   * Steps:
   * 1. Install the mocked backend, navigate to `/` and wait for the card.
   * 2. Click the first View button (the jobs row — `rk-jobs`' active window `@7`).
   * 3. Assert the URL is `/rk-daemon/7` (the window id's numeric URL segment).
   * 4. Assert the terminal route renders the window name `update-check` (the
   *    center page heading) — the window is reachable, not hidden.
   */
  test("a service row's View deep-link lands on the daemon window's terminal route", async ({
    page,
  }) => {
    await mockBackend(page);
    await page.goto("/");

    const card = page.getByLabel("HexoKit system");
    await expect(card).toBeVisible({ timeout: 10_000 });

    // The jobs row's View targets rk-jobs' active window @7 → /rk-daemon/7.
    await card.getByRole("button", { name: "View" }).first().click();
    await expect(page).toHaveURL(/\/rk-daemon\/7$/);

    // The terminal route renders the window's heading — terminal access kept.
    await expect(page.getByText("update-check").first()).toBeVisible({ timeout: 10_000 });
  });
});
