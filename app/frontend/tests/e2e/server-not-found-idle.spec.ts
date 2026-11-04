import { test, expect, type Page } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

/**
 * Idle contract for the "Workspace not found" fallback: loading a route whose
 * tmux server the daemon does not have renders the fallback once and then
 * leaves the main thread quiet — no re-render or redirect loop keeps the
 * renderer busy while the tab is open.
 *
 * Shared setup: no tmux fixture — the e2e rig's daemon knows only the
 * isolated `rk-test-e2e-<token>-*` socket family, so any other server name is
 * a guaranteed miss and the three-way route guard resolves `not-found` as
 * soon as the server list loads. The idle oracle is a CDP session on the
 * page: `Performance.getMetrics`'s `TaskDuration` is the CUMULATIVE
 * main-thread task time in seconds, so the delta across an idle window is
 * the page's script cost — a spinning page accrues ~1 s per second of wall
 * time, a quiet SPA well under the budget. Process-level CPU is deliberately
 * not asserted (too noisy for a gate; that is the perf-idle-cpu instrument's
 * job).
 */

// The main-thread task-time budget (seconds) for one idle window. A render
// loop accrues ~3 s over the window; a settled page stays near zero.
const TASK_TIME_BUDGET_S = 0.3;
const IDLE_WINDOW_MS = 3_000;

/** Cumulative main-thread task time (seconds) from the Performance domain. */
async function readTaskDurationS(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const metric = metrics.find((m) => m.name === "TaskDuration");
  if (!metric) {
    throw new Error("Performance.getMetrics returned no TaskDuration metric");
  }
  return metric.value;
}

/** Main-thread task seconds accrued over one idle window, measured via CDP. */
async function measureIdleTaskS(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const t0 = await readTaskDurationS(cdp);
  await page.waitForTimeout(IDLE_WINDOW_MS);
  const t1 = await readTaskDurationS(cdp);
  await cdp.detach();
  return t1 - t0;
}

/** Assert the fallback's copy: heading, the sentence naming the server, and
 *  the way home. */
async function expectServerNotFound(page: Page, server: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Workspace not found" })).toBeVisible();
  await expect(
    page.getByRole("paragraph").filter({ hasText: "No workspace named" }),
  ).toContainText(server);
  await expect(page.getByRole("link", { name: "Go to workspace list" })).toHaveAttribute(
    "href",
    "/",
  );
}

test.describe("Workspace not found — fallback renders once and idles", () => {
  /**
   * Proves: the `/$server` form of a missing-server route renders the
   * "Workspace not found" fallback with its copy and its way home, then leaves
   * the main thread quiet for the life of the tab.
   *
   * Steps:
   * 1. Open a `/$server` route whose name the rig's daemon cannot have.
   * 2. Assert the fallback renders: the `Workspace not found` heading, the
   *    sentence naming the server, and the `Go to workspace list` link to `/`.
   * 3. Measure the main-thread task-time delta over a 3 s idle window via a
   *    CDP `Performance.getMetrics` session.
   * 4. Assert the delta is under the budget — a re-render/redirect loop would
   *    accrue ~3 s in that window.
   */
  test("/$server for an unknown server renders the fallback once and idles", async ({
    page,
  }) => {
    const server = `rk-e2e-missing-${Date.now().toString(36)}`;
    await page.goto(`/${server}`);
    await expectServerNotFound(page, server);
    expect(await measureIdleTaskS(page)).toBeLessThan(TASK_TIME_BUDGET_S);
  });

  /**
   * Proves: the `/$server/$window` form of a missing-server route renders the
   * same "Workspace not found" fallback and idles the same way — the guard sits
   * on the server layout, so the terminal child route inherits it.
   *
   * Steps:
   * 1. Open a `/$server/$window` route whose server the rig's daemon cannot
   *    have.
   * 2. Assert the fallback renders with the same copy and link contract.
   * 3. Measure the main-thread task-time delta over a 3 s idle window.
   * 4. Assert the delta is under the budget.
   */
  test("/$server/$window for an unknown server renders the fallback once and idles", async ({
    page,
  }) => {
    const server = `rk-e2e-missing-${Date.now().toString(36)}`;
    await page.goto(`/${server}/0`);
    await expectServerNotFound(page, server);
    expect(await measureIdleTaskS(page)).toBeLessThan(TASK_TIME_BUDGET_S);
  });
});
