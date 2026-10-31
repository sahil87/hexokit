/**
 * Demo: the `+ New` split button in the desktop shell, recorded for PR
 * evidence. The sidebar head sits below the shell's titlebar strip (the strip
 * is the window's only drag band), so the control must stay clickable in the
 * real Electron window: the demo shows the head's `+ Tab` primary creating a
 * tab and the caret menu opening over the window.
 *
 * Runs only under `just demo new-split-button` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway e2e
 * rig; the `_demo.ts` fixture supplies the seeded config home, the launched
 * shell, the host page and the display recording. The `--before` pass runs the
 * base ref, where the control does not exist: the spec then shows the head
 * without it.
 *
 * Shared setup: beforeAll creates one tmux session on the rig's isolated
 * server; afterAll kills it.
 */
import { test, expect, beat, pace, READY_TIMEOUT } from "./_demo";
import { TMUX_SERVER, createSession, killSession, listWindows } from "../../../frontend/tests/e2e/_tmux";
import { hostOrigins } from "../e2e/_shell";

const DEMO_SESSION = "demo-new-split-shell";

test.describe("new-split-button shell demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION);
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  /**
   * Proves: in the Electron shell the New split button in the sidebar head is
   * clickable (it is not swallowed by the titlebar drag band) — the caret
   * menu opens and the `+ Tab` primary creates a tab.
   *
   * Steps:
   * 1. Open the seeded window in the host page; wait for the status bar's
   *    Connected dot; `beat()`.
   * 2. Assert the head's split primary reads `+ Tab` (base ref: only the
   *    toggle and brand — `beat()` and stop); `beat()`.
   * 3. Open the caret; assert the menu is visible; `beat()`; Escape.
   * 4. Click the primary; poll tmux until the session has one more window;
   *    `beat()`.
   */
  test("the head's split opens its menu and creates a tab in the shell", async ({ hostPage }) => {
    const first = listWindows(DEMO_SESSION)[0];
    if (!first) throw new Error(`no window in ${DEMO_SESSION}`);
    await hostPage.goto(`${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(first.windowId)}`);
    await expect(hostPage.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await beat(hostPage);

    const head = hostPage.locator("header > div.absolute");
    if ((await head.getByTestId("new-split-primary").count()) === 0) {
      // Base ref: the head carries only the brand and the toggle.
      await expect(head.getByRole("button", { name: "Toggle navigation" })).toBeVisible();
      await beat(hostPage);
      return;
    }
    await expect(head.getByTestId("new-split-primary")).toHaveText("+ Tab");
    await beat(hostPage);

    await hostPage.getByTestId("new-split-caret").click();
    await expect(hostPage.getByTestId("new-split-menu")).toBeVisible();
    await pace(hostPage);
    await beat(hostPage, 1_800);
    await hostPage.keyboard.press("Escape");

    const before = listWindows(DEMO_SESSION).length;
    await hostPage.getByTestId("new-split-primary").click();
    await expect.poll(() => listWindows(DEMO_SESSION).length, { timeout: READY_TIMEOUT }).toBe(before + 1);
    await beat(hostPage);
  });
});
