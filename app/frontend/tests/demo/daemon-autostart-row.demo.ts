/**
 * Demo: the HexoKit system card's read-only autostart row. Before: the card
 * shows the daemon line and service rows only, so a reboot-survival gap is
 * invisible. After: an `autostart` row reads the daemon's state — here the
 * login-only case that tells the user lingering is the missing step.
 *
 * Runs only under `just demo daemon-autostart-row` (optionally `--before`),
 * against the throwaway e2e rig, once per project (desktop and mobile).
 *
 * Shared setup: fully mocked, mirroring `tests/e2e/host-system-card.spec.ts` —
 * `/api/servers` lists `rk-daemon`, the state socket carries a version slot
 * and a jobs session, and `/api/daemon/autostart` is stubbed to a fixed
 * login-only payload so the recording never depends on (or touches) the host's
 * service manager. On the base ref the route is never requested and the row is
 * absent, which is the "before" frame.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { mockStateSocket } from "../e2e/_state-socket-mock";

const STARTED = Math.floor(Date.now() / 1000) - 3 * 86_400;

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
]);

async function mockBackend(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "rk-daemon", sessionCount: 1 }]),
    }),
  );
  await page.route("**/api/daemon/autostart", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        supported: true,
        summary: "on (login only — enable lingering for boot)",
      }),
    }),
  );
  await mockStateSocket(page, {
    sessionsByServer: { "rk-daemon": DAEMON_SESSIONS },
    version: { version: "0.9.1", boot: "b1", brew: false, started: STARTED, port: 6123 },
  });
}

test.describe("daemon-autostart-row demo", () => {
  /**
   * Proves: a reviewer can see the HexoKit system card on the Host page gain
   * an `autostart` row that names the daemon's boot-survival state, with no
   * control attached.
   *
   * Steps:
   * 1. Install the mocked backend and open `/`; wait for the system card.
   * 2. `beat()` on the card so the daemon line and service rows register.
   * 3. Assert the autostart row reads the login-only summary (on the base ref
   *    the row is absent and the assertion is skipped); `beat()` on it.
   */
  test("the system card shows the daemon's autostart state", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/");

    const card = page.getByLabel("HexoKit system");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await beat(page, 1_500);

    if (process.env.DEMO_VARIANT !== "before") {
      const row = card.getByTestId("system-card-autostart");
      await expect(row).toContainText("on (login only — enable lingering for boot)");
      await row.scrollIntoViewIfNeeded();
    }
    await beat(page, 3_000);
  });
});
