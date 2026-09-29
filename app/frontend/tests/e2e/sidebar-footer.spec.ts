import { test, expect, type Page } from "@playwright/test";
import { READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER } from "./_tmux";

/**
 * The sidebar footer is MOBILE-ONLY: the desktop sidebar renders NO footer at
 * all — the full-width status bar at the bottom of desktop routes owns the
 * connection dot (aria-label "Connected"/"Disconnected") and the version
 * readout. The footer itself is a passive justify-between row: readouts left
 * (connection dot with role="status", version click-to-copy) and a quiet
 * status/hints slot right (empty at rest; the update-available hint is
 * unit-tested in `sidebar/index.test.tsx`). The mobile drawer keeps the
 * footer byte-identical. Runs against the isolated e2e server
 * (`just test-e2e`).
 *
 * Setup: the desktop case uses the default viewport (sidebar open by
 * default) and gates readiness on the status bar's [aria-label='Connected']
 * dot — `_ready.ts`'s `gotoServerReady` gates there too (the desktop sidebar
 * footer is gone). The mobile cases run under
 * `test.use({ hasTouch: true, viewport: 375x812 })` — `hasTouch` flips
 * Chromium's `(any-pointer: coarse)` media query so `useIsMobile()` reports
 * mobile — and open the drawer via the always-mounted `Toggle navigation`
 * hamburger (a closed drawer leaves the footer unmounted); footer locators
 * are scoped to the drawer's `navigation[name='Sessions']`.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sessions" });
const statusBar = (page: Page) => page.getByTestId("status-bar");
const hostCluster = (page: Page) => page.getByTestId("status-bar-host");

/** Navigate at the mobile viewport, then open the drawer (the footer's only
 *  home). Gates on the `Toggle navigation` button, NOT the drawer-footed
 *  `Connected` dot — a closed drawer leaves it unmounted. Returns the drawer
 *  (`role="dialog"`). (The sidebar-panels.spec.ts pattern.) */
async function gotoDrawer(page: Page, path: string) {
  await page.goto(path);
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer;
}

test.describe("Sidebar footer — mobile-only (260815-19me)", () => {
  /**
   * Proves: on desktop the Sessions nav contains no footer readouts (no
   * connection dot, no version copy button), while the status bar's host
   * cluster carries both the Connected dot and the version readout.
   *
   * Steps:
   * 1. Navigate to /<e2e server>.
   * 2. Wait for the status bar's Connected dot (readiness gate + proof of
   *    the dot's new home).
   * 3. Assert the Sessions nav is visible and contains zero
   *    [aria-label='Connected']/[aria-label='Disconnected'] elements and zero
   *    HexoKit … (copy) buttons.
   * 4. Assert the status-bar host cluster shows the version readout (anchored
   *    dev / v… regex matches the version span, not the hostname parent).
   */
  test("desktop: the sidebar has NO footer — the status bar owns the connection dot + version readout", async ({
    page,
  }) => {
    await page.goto(`/${TMUX_SERVER}`);
    // Readiness gate: the desktop sidebar carries no Connected dot anymore, so
    // gate on the status bar's copy (which also proves the dot's new home).
    const bar = statusBar(page);
    await expect(bar.getByLabel("Connected")).toBeVisible({ timeout: READY_TIMEOUT });

    // The desktop sidebar renders no footer: no connection dot, no version
    // copy button anywhere in the Sessions nav.
    const nav = sidebar(page);
    await expect(nav).toBeVisible();
    await expect(
      nav.locator("[aria-label='Connected'], [aria-label='Disconnected']"),
    ).toHaveCount(0);
    await expect(nav.getByRole("button", { name: /HexoKit .*\(copy\)/ })).toHaveCount(0);

    // The status bar's host cluster carries the version readout (`v0.9.3`, or
    // the bare `dev` sentinel on a dev daemon). The anchored regex matches the
    // version span itself, not the hostname-then-version parent.
    await expect(
      hostCluster(page).getByText(/^\s*(dev|v\d+(\.\d+)*)$/),
    ).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test.describe("mobile drawer", () => {
    // `hasTouch: true` flips Chromium's `(any-pointer: coarse)` media query —
    // combined with the 375px width, `useIsMobile()` reports mobile (the same
    // seam sidebar-panels.spec.ts / bottom-bar-chip-size.spec.ts use).
    test.use({ hasTouch: true, viewport: MOBILE_VIEWPORT });

    /**
     * Proves: on mobile the footer's connection dot keeps its semantics
     * inside the drawer's Sessions nav, and no status bar renders to
     * duplicate it.
     *
     * Steps:
     * 1. gotoDrawer('/<e2e server>') (hamburger → drawer visible).
     * 2. Assert [aria-label='Connected'] is visible inside the drawer's
     *    navigation[name='Sessions'].
     * 3. Assert data-testid="status-bar" has zero matches on the page.
     */
    test("the drawer keeps the footer: connection dot present, status bar absent", async ({
      page,
    }) => {
      const drawer = await gotoDrawer(page, `/${TMUX_SERVER}`);
      // The footer's dot keeps its semantics (`aria-label` Connected /
      // Disconnected) inside the drawer's Sessions nav — and there is no
      // status bar on mobile to duplicate it.
      const nav = drawer.getByRole("navigation", { name: "Sessions" });
      await expect(nav.locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
      await expect(statusBar(page)).toHaveCount(0);
    });

    /**
     * Proves: the drawer footer's version line renders once the daemon
     * reports a version and click-copies exactly the displayed form (`v0.9.3`,
     * or the bare `dev` sentinel on a dev daemon).
     *
     * Steps:
     * 1. Grant clipboard permissions; gotoDrawer('/<e2e server>').
     * 2. Wait for the HexoKit … (copy) button in the drawer; read its text.
     * 3. Click it and assert the clipboard equals the displayed text.
     */
    test("version readout copies the displayed version form", async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const drawer = await gotoDrawer(page, `/${TMUX_SERVER}`);
      const version = drawer.getByRole("button", { name: /HexoKit .*\(copy\)/ });
      // The readout renders only once the daemon reported a version; the SSE
      // `version` event always precedes `Connected`-gated data on this route.
      await expect(version).toBeVisible({ timeout: READY_TIMEOUT });
      const text = (await version.textContent())?.trim() ?? "";
      await version.click();
      // A numeric version copies its displayed `v…` form; the dev sentinel is a
      // bare `dev` (never `vdev`) and copies as-is.
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(text);
    });
  });
});
