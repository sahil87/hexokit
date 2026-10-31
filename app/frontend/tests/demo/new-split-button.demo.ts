/**
 * Demo: the persistent `+ New` split button, recorded for PR evidence. On
 * desktop it sits in the sidebar head beside the toggle: the `+ Tab` primary
 * creates a tab at once, the caret menu groups its rows by where the result
 * lands, and with the sidebar closed an icon-only `+▾` follows the hamburger.
 * On mobile the control moves to the drawer's brand row.
 *
 * Runs only under `just demo new-split-button` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). The `--before` pass runs against the
 * base ref, where the control does not exist: the spec then shows the old
 * doors instead (the window switcher's `+ New Tab` footer on desktop, the
 * bare drawer on mobile) so the before/after pair shows what changed.
 *
 * Shared setup: beforeAll seeds one detached session; afterAll kills it and
 * the tab the demo creates lives inside it.
 */
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const SEED_SESSION = `demo-newsplit-${process.pid}`;

test.describe("new-split-button demo", () => {
  test.beforeAll(() => {
    createSession(SEED_SESSION);
  });

  test.afterAll(() => {
    killSession(SEED_SESSION);
  });

  /**
   * Proves: a reviewer can see where the New control lives on each viewport —
   * the sidebar head on desktop (primary, menu, closed-sidebar fallback), the
   * drawer's brand row on mobile — and that its primary creates a tab.
   *
   * Steps:
   * 1. Open the seeded window and wait for the app; `beat()`.
   * 2. Desktop: open the caret menu and `beat()` on the grouped rows; close
   *    it, click the `+ Tab` primary and `beat()` on the new tab; close the
   *    sidebar to show the icon-only fallback after the hamburger; reopen.
   *    (Base ref: open the window switcher to show the old `+ New Tab`.)
   * 3. Mobile: open the drawer, `beat()` on the brand row's split, open its
   *    caret menu, `beat()`. (Base ref: the drawer alone.)
   */
  test("the New split button across the head, the menu, the fallback and the drawer", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const id = (await resolveWindow(page, TMUX_SERVER, SEED_SESSION, undefined)).windowId;
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    if (!isMobile) {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    } else {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    }
    await beat(page);

    const hasSplit = (await page.getByTestId("new-split").count()) > 0 || isMobile;
    if (!isMobile) {
      if (!hasSplit) {
        // Base ref: creation lives two clicks deep in the window switcher.
        await page.getByLabel("Switch tab").click();
        await expect(page.getByRole("menuitem", { name: "+ New Tab" })).toBeVisible();
        await beat(page);
        await page.keyboard.press("Escape");
        await beat(page);
        return;
      }
      const head = page.locator("header > div.absolute");
      await expect(head.getByTestId("new-split-primary")).toHaveText("+ Tab");
      await beat(page);

      await page.getByTestId("new-split-caret").click();
      await expect(page.getByTestId("new-split-menu")).toBeVisible();
      await beat(page, 1_800);
      await page.keyboard.press("Escape");

      const tabsBefore = await page.locator("[data-window-id]").count();
      await page.getByTestId("new-split-primary").click();
      await expect(page.locator("[data-window-id]")).toHaveCount(tabsBefore + 1, { timeout: READY_TIMEOUT });
      await beat(page);

      // Sidebar closed: the head is gone, an icon-only split follows the hamburger.
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await expect(page.getByTestId("new-split")).toHaveCount(1);
      await beat(page, 1_500);
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await beat(page);
      return;
    }

    // Mobile: the drawer's brand row.
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sidebar = page.getByRole("navigation", { name: "Groups" });
    await expect(sidebar).toBeVisible();
    await beat(page);
    if ((await sidebar.getByTestId("new-split").count()) === 0) {
      // Base ref: the drawer has no create control.
      await beat(page);
      return;
    }
    await sidebar.getByTestId("new-split-caret").click();
    await expect(sidebar.getByTestId("new-split-menu")).toBeVisible();
    await beat(page, 1_800);
  });
});
