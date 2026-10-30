/**
 * Demo: the UI vocabulary rename, recorded for PR evidence — the tmux server,
 * session and window now read Workspace, Group and Tab. The recording walks
 * the sidebar (Workspaces panel and Groups tree, a Group flyout card on
 * desktop), the command palette's `Workspace:` / `Group:` / `Tab:` rows
 * (desktop), and the host page's Workspaces zone.
 *
 * Runs only under `just demo ui-rename` (playwright.demo.config.ts — testDir
 * ./tests/demo), against the throwaway e2e rig, once per project (desktop
 * 1280x800, mobile 375x812). The palette and the hover flyout card are
 * desktop-only surfaces; the mobile pass shows the drawer and the host page.
 *
 * Shared setup: beforeAll creates one session on the rig's isolated tmux
 * server; afterAll kills it.
 */
import { test, expect, beat } from "./_demo";
import { resolveWindow, openPalette, READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const DEMO_SESSION = "demo-ui-rename";

test.describe("ui-rename demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION);
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  /**
   * Proves: a reviewer can see the new nouns on every surface that named a
   * tmux server, session or window — sidebar panels, a Group flyout card, the
   * palette families, and the host page zone.
   *
   * Steps:
   * 1. Open the seeded window; wait for the app to connect; on mobile open
   *    the navigation drawer; `beat()`.
   * 2. Assert the Groups nav and the Workspaces panel toggle; `beat()`.
   * 3. Desktop: hover the group row — the card reads `Group <name>`; open the
   *    palette and filter `workspace`, then `group`, then `tab: set note`.
   * 4. Visit the host page `/` and assert the Workspaces zone with its
   *    `+ New workspace` button; `beat()`.
   */
  test("sidebar, palette and host page speak Workspace, Group and Tab", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const id = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, undefined)).windowId;
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    if (isMobile) {
      const toggle = page.getByRole("button", { name: "Toggle navigation" });
      await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
      await toggle.click();
    } else {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    const nav = page.locator("nav[aria-label='Groups']");
    await expect(nav).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole("button", { name: /^Workspaces/ })).toBeVisible();
    await beat(page);

    if (!isMobile) {
      const row = page.locator(`[data-session-row]`).first();
      await row.hover();
      await expect(page.getByTestId("row-flyout-card")).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByTestId("popup-title-bar")).toContainText(`Group ${DEMO_SESSION}`);
      await beat(page, 1_500);
      await page.mouse.move(700, 400);

      const input = await openPalette(page);
      for (const query of ["workspace", "group", "tab: set note"]) {
        await input.fill(query);
        await beat(page, 1_200);
      }
      await page.keyboard.press("Escape");
      await beat(page, 600);
    }

    await page.goto("/");
    await expect(page.getByRole("region", { name: "Workspaces" })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await expect(page.getByRole("button", { name: "+ New workspace" })).toBeVisible();
    await beat(page, 1_500);
  });
});
