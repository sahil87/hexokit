// Responsive-layout guardrails: mobile viewports must not leak horizontal
// overflow, must keep theme switching REACHABLE (it lives in the settings
// dialog's Appearance picker and the palette — the chevron menu carries no
// Theme… row), and must expose a drawer-style navigation that sits *below*
// (not over) the top bar.
// beforeEach sets an iPhone 14-sized viewport (375×812) so every test starts
// from a mobile baseline.
import { test, expect } from "@playwright/test";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";
import { resolveWindow } from "./_ready";

// iPhone 14 viewport
const MOBILE_VIEWPORT = { width: 375, height: 812 };

test.describe("Mobile layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
  });

  /**
   * Proves: layout never introduces a horizontal scrollbar at 375px. A
   * regression here is usually from an absolutely-positioned element or an
   * xterm.js canvas without `overflow: hidden` on its column.
   *
   * Steps:
   * 1. Navigate to `/${TMUX_SERVER}`.
   * 2. Read `document.body.scrollWidth` via `page.evaluate`.
   * 3. Assert it is `≤ 375` (the viewport width).
   */
  test("page does not overflow horizontally", async ({ page }) => {
    await page.goto(`/${TMUX_SERVER}`);
    // The document should not be wider than the viewport
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  });

  /**
   * Proves: theme switching lives in the settings dialog's Appearance picker
   * and the palette: the chevron menu carries no `Theme…` row, the bar
   * carries no theme button, and the sidebar footer carries none either —
   * even with the drawer open — yet the Settings row still reaches the
   * Appearance theme picker.
   *
   * Steps:
   * 1. Navigate to `/${TMUX_SERVER}` (viewport is 375px).
   * 2. Assert the `More controls` chevron is visible, and that no `* theme`
   *    button exists in the bar.
   * 3. Open the chevron menu; assert it has NO `Theme…` menuitem; open
   *    Settings via the in-bar gear (or the menu's `Settings` row when the
   *    gear overflowed), switch to the Appearance tab, and assert the
   *    `theme-picker-trigger` renders; Escape-close the dialog.
   * 4. Click `Toggle navigation` (the hamburger) and assert the sidebar nav
   *    still contains zero theme buttons.
   */
  test("theme is reachable via the settings dialog on mobile (no chrome theme button anywhere)", async ({
    page,
  }) => {
    // Theme switching lives in the settings dialog's Appearance picker and
    // the palette (260819-qkow) — the chevron menu carries no Theme… row and
    // the sidebar footer carries no theme button, drawer open or closed.
    await page.goto(`/${TMUX_SERVER}`);
    const chevron = page.getByRole("button", { name: "More controls" });
    await expect(chevron).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: / theme$/ })).toHaveCount(0);
    await chevron.click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Theme…/ })).toHaveCount(0);
    // Settings reaches the Appearance theme picker. The gear is a fit
    // candidate: when it still fits in-bar at 375px there is no menu row, so
    // take whichever surface rendered.
    await page.keyboard.press("Escape");
    const gear = page.getByRole("button", { name: "Open settings" });
    if (await gear.isVisible()) {
      await gear.click();
    } else {
      await chevron.click();
      await menu.getByRole("menuitem", { name: "Settings" }).click();
    }
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "Appearance" }).click();
    await expect(dialog.getByTestId("theme-picker-trigger")).toBeVisible();
    await page.keyboard.press("Escape");
    // Even with the drawer open, the footer has no theme button.
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(
      page.getByRole("navigation", { name: "Groups" }).getByRole("button", { name: / theme$/ }),
    ).toHaveCount(0);
  });

  /**
   * Proves: the mobile hamburger opens a drawer that does NOT cover the top
   * bar — the user must always be able to close it by tapping the same
   * toggle.
   *
   * Steps:
   * 1. Navigate to `/${TMUX_SERVER}`.
   * 2. Click the `Toggle navigation` button.
   * 3. Assert `navigation[name='Sessions']` is visible.
   * 4. Assert the toggle button is still visible (not covered by drawer
   *    overlay).
   * 5. Assert the sidebar's bounding-box `y` is `> 0` — i.e. drawer starts
   *    below the top bar, not at viewport origin.
   * 6. Click the toggle again and assert the sidebar is no longer visible.
   */
  test("mobile drawer opens below top bar", async ({ page }) => {
    await page.goto(`/${TMUX_SERVER}`);
    const toggle = page.getByRole("button", { name: "Toggle navigation" });

    // Open drawer
    await toggle.click();

    // The sidebar navigation should be visible
    const sidebar = page.getByRole("navigation", { name: "Groups" });
    await expect(sidebar).toBeVisible();

    // Toggle button should still be visible (not covered by drawer)
    await expect(toggle).toBeVisible();

    // The sidebar should be below the top bar — its top should be > 0
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).toBeTruthy();
    expect(sidebarBox!.y).toBeGreaterThan(0);

    // Clicking toggle again should close the drawer
    await toggle.click();
    await expect(sidebar).not.toBeVisible();
  });

  /**
   * Proves: below `sm` the top-bar heading LEFT-ALIGNS beside the hamburger
   * (the mobile grid content-sizes the left and center columns — no dead
   * space where the hidden crumbs would be), and the tab-switcher ▾ never
   * overlaps the pinned surface-switch group even with a long window name —
   * the leftover width belongs to the right cluster's `minmax(0,1fr)` track,
   * so the fit machinery measures a real budget instead of overflowing an
   * equal-share `1fr` track over the heading.
   *
   * Steps:
   * 1. Create a session whose window carries a name longer than the heading's
   *    16ch mobile cap; goto its terminal route directly (gotoWindow's
   *    Connected-dot wait is desktop-sidebar-bound).
   * 2. Assert the heading (rename button) starts within a hamburger's width
   *    of the toggle — left-aligned, not centered.
   * 3. Assert the ▾ switcher's box ends left of the surface-toggle group's
   *    box (no intersection).
   * 4. Assert no horizontal page overflow.
   */
  test("terminal-route heading left-aligns and the tab ▾ clears the surface switch", async ({
    page,
  }) => {
    const session = `e2e-navbar-${Date.now()}`;
    const windowName = "riff-amber-tern-navbar-probe";
    createSession(session, { windows: [windowName] });
    try {
      const { windowId } = await resolveWindow(page, TMUX_SERVER, session, windowName);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);

      const heading = page.getByRole("button", { name: `Rename tab ${windowName}` });
      await expect(heading).toBeVisible({ timeout: 10_000 });

      const hamburger = await page
        .getByRole("button", { name: "Toggle navigation" })
        .boundingBox();
      const headingBox = await heading.boundingBox();
      expect(hamburger).toBeTruthy();
      expect(headingBox).toBeTruthy();
      // Left-aligned: the heading starts right after the hamburger (gap-2 grid
      // gap + the empty nav's gap — allow one hamburger width of slack), not
      // at the centered position.
      expect(headingBox!.x - (hamburger!.x + hamburger!.width)).toBeLessThan(40);

      const switcherBox = await page
        .getByRole("button", { name: "Switch tab" })
        .boundingBox();
      const surfaceBox = await page.getByTestId("surface-toggles").boundingBox();
      expect(switcherBox).toBeTruthy();
      expect(surfaceBox).toBeTruthy();
      // The ▾ ends before the surface group begins — no overlap.
      expect(switcherBox!.x + switcherBox!.width).toBeLessThanOrEqual(surfaceBox!.x);

      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    } finally {
      killSession(session);
    }
  });
});
