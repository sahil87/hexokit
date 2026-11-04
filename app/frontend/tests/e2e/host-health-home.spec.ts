import { test, expect } from "@playwright/test";
import { createSession, killSession } from "./_tmux";

/**
 * The Host host-console home: the HOST HEALTH zone on `/` (`HostOverviewPage`)
 * renders live host-global metrics from the server-independent
 * `useHostMetrics()` stream, above the existing tmux-server tile grid, and the
 * grid itself is unaffected.
 *
 * Shared setup: `beforeAll` creates a detached tmux session
 * (`e2e-host-health-<ts>`) on the isolated e2e tmux server (`E2E_TMUX_SERVER`,
 * default `rk-test-e2e`) so the server-tile grid has a server to render;
 * `afterAll` kills that session (best-effort).
 */

const TEST_SESSION = `e2e-host-health-${Date.now()}`;

test.describe("HOST HEALTH home zone", () => {
  test.beforeAll(() => {
    // A session ensures the server tile grid has at least one server to render.
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: on the home route `/`, the HOST HEALTH zone is present, shows live
   * host metrics once the server-independent metrics tick arrives, and the
   * server-tile grid below it still renders — the zone is additive and metrics
   * reach `/` without an attached server.
   *
   * Steps:
   * 1. Navigate to `/`.
   * 2. Assert the `Host health` region (labelled section) is visible.
   * 3. Assert its `Host Health` heading is visible.
   * 4. Wait for the `cpu` metric label to appear — proving the server-neutral
   *    `?metrics=1` stream delivered a snapshot to `/` (the backend sends its
   *    cached metrics on connect) and the shared `HostMetrics` component
   *    replaced the "No metrics" placeholder. The 10s timeout only absorbs a
   *    cold air-compiled backend on the first connection.
   * 5. Assert the `mem` metric label is also visible.
   * 6. Assert the `+ New workspace` button (always present in the server-tile
   *    grid) is visible — proving the existing grid still renders below the
   *    new zone.
   */
  test("renders live host metrics on / above the server grid", async ({ page }) => {
    await page.goto("/");

    // The HOST HEALTH zone is present on the home route.
    const zone = page.getByRole("region", { name: "Host health" });
    await expect(zone).toBeVisible();
    await expect(zone.getByRole("heading", { name: "Host Health" })).toBeVisible();

    // Live metrics reach the server-neutral `?metrics=1` stream immediately (the
    // backend sends its cached metrics snapshot on connect), replacing the "No
    // metrics" placeholder with the metric rows — the CPU/mem labels come from
    // the shared HostMetrics component. Generous timeout only to absorb a cold
    // air-compiled backend on the first connection.
    await expect(zone.getByText("cpu")).toBeVisible({ timeout: 10_000 });
    await expect(zone.getByText("mem")).toBeVisible();

    // The server-tile grid below the zone still renders — the "+ New workspace"
    // affordance is always present on the home route.
    await expect(
      page.getByRole("button", { name: "+ New workspace" }),
    ).toBeVisible();
  });
});
