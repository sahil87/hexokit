import { test, expect } from "@playwright/test";
import { gotoServerReady } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

// Live e2e against the isolated e2e tmux server named by E2E_TMUX_SERVER
// (default `rk-test-e2e`) — no page.route mocks. beforeAll creates a
// long-lived session `e2e-test-<timestamp>` so the dashboard never renders
// the empty state mid-test; afterAll kills it.

const TEST_SESSION = `e2e-test-${Date.now()}`;

test.describe("API Integration", () => {
  test.beforeAll(() => {
    // Create a self-managed tmux session for testing
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: a tmux session created outside the UI (via the CLI) surfaces in
   * the sidebar within a couple of SSE poll cycles, and the session flyout
   * card's Kill action + confirm dialog removes it cleanly end-to-end.
   *
   * Steps:
   * 1. Create `e2e-api-victim-<ts>` on the e2e tmux server.
   * 2. Navigate to /${TMUX_SERVER} and wait for the status bar's Connected dot.
   * 3. Assert the `Navigate to <sessionName>` button appears in the Sessions
   *    nav within 8s (allows for the 2.5s SSE poll interval).
   * 4. Hover the session row until ITS flyout card is open (a row
   *    layout-shift under the stationary pointer can fire a sibling row's
   *    hover intent while SSE settles), enter the card at the row's own band
   *    (a diagonal sweep to the bottom kill row would cross the sibling
   *    sidebar row and retarget the card), click the card's `Kill group`
   *    action row, then the `Kill` button inside the confirm dialog (scoped
   *    to role=dialog so no sidebar row whose text contains "Kill" can
   *    match).
   * 5. Assert the `Navigate to <sessionName>` button is gone within 5s.
   * 6. finally: kill-session as best-effort cleanup.
   */
  test("session appears via SSE and can be killed through the sidebar UI", async ({
    page,
  }) => {
    // Unique session name per run avoids collisions with other tests or
    // leftover state on the shared rk-test-e2e tmux server.
    const sessionName = `e2e-api-victim-${Date.now()}`;
    createSession(sessionName);

    try {
      // Wait for SSE to connect and dashboard to populate
      const sidebar = await gotoServerReady(page, TMUX_SERVER);

      // The session created via tmux CLI should appear via SSE within a few
      // poll cycles
      const navigateBtn = sidebar.getByRole("button", {
        name: `Navigate to ${sessionName}`,
      });
      await expect(navigateBtn).toBeVisible({ timeout: 8_000 });

      // Kill via the session flyout card's kill action (opens confirm dialog):
      // hover the row until THIS session's card is the open one — while SSE is
      // still settling, a row layout-shift under the stationary pointer can
      // fire a sibling row's hover intent (a mouseover with no mousemove) and
      // open THAT row's card. Then enter the card at the row's own band: a
      // diagonal sweep to the bottom kill row crosses the sibling sidebar row
      // and hover-intent retargets the card mid-transit.
      const sessionRow = sidebar.locator(
        `[data-session-row="${TMUX_SERVER}:${sessionName}"]`,
      );
      const card = page.getByTestId("row-flyout-card");
      await expect(async () => {
        await page.mouse.move(700, 500);
        await sessionRow.hover();
        await expect(card).toContainText(`Group ${sessionName}`, { timeout: 3_000 });
      }).toPass({ timeout: 15_000 });
      const rowBox = (await sessionRow.boundingBox())!;
      const cardBox = (await card.boundingBox())!;
      await page.mouse.move(cardBox.x + 16, rowBox.y + rowBox.height / 2);
      await card.getByTestId("row-flyout-kill-action").click();

      // Click the Kill confirm button inside the dialog. Scope the selector
      // to role=dialog to avoid picking up any sidebar row whose text
      // coincidentally contains "Kill".
      await page.locator("[role='dialog'] button:has-text('Kill')").click();

      // Session row disappears (optimistic + confirmed via SSE)
      await expect(navigateBtn).not.toBeVisible({ timeout: 5_000 });
    } finally {
      killSession(sessionName);
    }
  });
});
