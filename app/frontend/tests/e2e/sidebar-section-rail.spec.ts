import { test, expect, type Page } from "@playwright/test";
import { READY_TIMEOUT, gotoServerReady } from "./_ready";
import { TMUX_SERVER } from "./_tmux";

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * Section-visibility micro-rail: a horizontal row of icon-only aria-pressed
 * toggle buttons — Boards · Server · Pane · Host, in that fixed
 * order — rendered as the first child of the sidebar's <nav>. Each toggle
 * flips a persisted `hexokit-sidebar-section-*` boolean; the gated section
 * fully unmounts/remounts. Defaults (Boards/Server on, Pane/Host off)
 * reproduce the pre-rail rendering on BOTH viewports, so the mobile drawer is
 * pure nav + footer unless the user opts in. Sessions has no toggle
 * (always-on core nav), and the rail itself always renders. A stale stored
 * `hexokit-sidebar-section-clock` value from the retired CLOCK section is
 * ignored — no toggle reads it.
 *
 * Shared setup: no test session needed — the rail and the PANE panel's empty
 * state render on the plain server route. Desktop tests use
 * gotoServerReady(page, TMUX_SERVER) (status-bar Connected gate —
 * desktop-only chrome) and scope queries to the nav[aria-label='Sessions']
 * sidebar. The mobile describe runs test.use({ hasTouch: true, viewport:
 * 375×812 }) — hasTouch flips Chromium's (any-pointer: coarse) media query so
 * useIsMobile() reports mobile; navigation is a direct page.goto (no
 * gotoWindow), then the drawer is opened via the `Toggle navigation` button.
 * railToggle(page, section) locates a rail button by its state-stable
 * aria-label (`Toggle {Section} section`); the state lives on aria-pressed.
 */

/** A rail toggle by its state-stable aria-label. */
function railToggle(page: Page, section: string) {
  return page.getByRole("button", { name: `Toggle ${section} section` });
}

/** Open the mobile drawer (the sidebar's coarse-pointer home) and return it. */
async function gotoDrawer(page: Page, path: string) {
  await page.goto(path);
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer;
}

/** Re-open the drawer if a reload landed on a closed sidebar preference. */
async function ensureDrawerOpen(page: Page) {
  const drawer = page.getByRole("dialog");
  if (await drawer.isVisible().catch(() => false)) return drawer;
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer;
}

test.describe("Sidebar section-visibility rail", () => {
  /**
   * Proves: the rail mounts at the top of the sidebar with exactly the four
   * contracted toggles in order, Sessions excluded, and the default
   * visibility booleans match the pre-rail rendering (PANE/HOST panels
   * absent).
   *
   * Steps:
   * 1. gotoServerReady(TMUX_SERVER).
   * 2. Assert the section-rail testid is visible inside the sidebar nav.
   * 3. Read all rail buttons' aria-labels; assert exact order
   *    Boards → Server → Pane → Host and that no `Sessions section`
   *    toggle exists anywhere.
   * 4. Assert aria-pressed is true/true/false/false across the four
   *    toggles.
   * 5. Assert no /^Pane/ or /^Host/ panel header exists in the sidebar.
   */
  test("rail renders four toggles in order with the defaults (Boards/Server pressed, Pane/Host not)", async ({
    page,
  }) => {
    const sidebar = await gotoServerReady(page, TMUX_SERVER);
    const rail = sidebar.getByTestId("section-rail");
    await expect(rail).toBeVisible();

    // Exactly four toggles, in the fixed order — Sessions has none.
    const labels = await rail.getByRole("button").evaluateAll((buttons) =>
      buttons.map((b) => b.getAttribute("aria-label")),
    );
    expect(labels).toEqual([
      "Toggle Boards section",
      "Toggle Servers section",
      "Toggle Pane section",
      "Toggle Host section",
    ]);
    await expect(page.getByRole("button", { name: /Sessions section/ })).toHaveCount(0);

    // Defaults: Boards/Server pressed, Pane/Host not — and the gated
    // sections render accordingly (PANE/HOST absent by default).
    await expect(railToggle(page, "Boards")).toHaveAttribute("aria-pressed", "true");
    await expect(railToggle(page, "Servers")).toHaveAttribute("aria-pressed", "true");
    await expect(railToggle(page, "Pane")).toHaveAttribute("aria-pressed", "false");
    await expect(railToggle(page, "Host")).toHaveAttribute("aria-pressed", "false");
    await expect(sidebar.getByRole("button", { name: /^Pane/ })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: /^Host/ })).toHaveCount(0);
  });

  /**
   * Proves: a rail click flips the persisted boolean, mounts the section (the
   * desktop removal is an opt-in default, not a hard gate), and the state
   * survives a full page reload.
   *
   * Steps:
   * 1. gotoServerReady(TMUX_SERVER).
   * 2. Click `Toggle Pane section`; assert aria-pressed="true" and the PANE
   *    panel header appears in the sidebar.
   * 3. page.reload(); assert the toggle is still pressed and the PANE header
   *    is still rendered (localStorage persistence).
   */
  test("toggling Pane on mounts the PANE panel and persists across reload (desktop)", async ({
    page,
  }) => {
    const sidebar = await gotoServerReady(page, TMUX_SERVER);
    await railToggle(page, "Pane").click();
    await expect(railToggle(page, "Pane")).toHaveAttribute("aria-pressed", "true");
    await expect(sidebar.getByRole("button", { name: /^Pane/ })).toBeVisible();

    await page.reload();
    const sidebarAfter = page.locator("nav[aria-label='Sessions']");
    await expect(railToggle(page, "Pane")).toHaveAttribute("aria-pressed", "true", {
      timeout: READY_TIMEOUT,
    });
    await expect(sidebarAfter.getByRole("button", { name: /^Pane/ })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });

  /**
   * Proves: toggle-off fully unmounts a default-on section (header gone, not
   * merely collapsed), while the rail itself stays rendered.
   *
   * Steps:
   * 1. gotoServerReady(TMUX_SERVER); assert the Boards section header
   *    renders.
   * 2. Click `Toggle Boards section`; assert aria-pressed="false" and zero
   *    /^Boards/ buttons remain in the sidebar.
   * 3. Assert the section-rail testid is still visible.
   */
  test("toggling Boards off removes the section (desktop)", async ({ page }) => {
    const sidebar = await gotoServerReady(page, TMUX_SERVER);
    await expect(sidebar.getByRole("button", { name: /^Boards/ })).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    await railToggle(page, "Boards").click();
    await expect(railToggle(page, "Boards")).toHaveAttribute("aria-pressed", "false");
    await expect(sidebar.getByRole("button", { name: /^Boards/ })).toHaveCount(0);
    // The rail itself always renders (not self-hideable).
    await expect(sidebar.getByTestId("section-rail")).toBeVisible();
  });

  test.describe("mobile drawer (375px, coarse)", () => {
    test.use({ hasTouch: true, viewport: MOBILE_VIEWPORT });

    /**
     * Proves: at 375px/coarse the drawer defaults to pure nav + footer (no
     * PANE/HOST panels), and the rail is the in-drawer path to opt a section
     * in, with the same reload persistence as desktop.
     *
     * Steps:
     * 1. page.goto(/${TMUX_SERVER}), open the drawer via `Toggle navigation`.
     * 2. Assert Pane/Host toggles read aria-pressed="false" and no PANE/HOST
     *    headers exist in the drawer.
     * 3. Click `Toggle Pane section`; assert the PANE header appears in the
     *    drawer.
     * 4. page.reload(), re-open the drawer (ensureDrawerOpen); assert the
     *    PANE header is still rendered.
     */
    test("rail defaults hold in the drawer; toggling Pane on mounts the panel and persists across reload", async ({
      page,
    }) => {
      const drawer = await gotoDrawer(page, `/${TMUX_SERVER}`);

      // Defaults in the drawer: Pane/Host off — the drawer is pure nav + footer.
      await expect(railToggle(page, "Pane")).toHaveAttribute("aria-pressed", "false");
      await expect(railToggle(page, "Host")).toHaveAttribute("aria-pressed", "false");
      await expect(drawer.getByRole("button", { name: /^Pane/ })).toHaveCount(0);
      await expect(drawer.getByRole("button", { name: /^Host/ })).toHaveCount(0);

      await railToggle(page, "Pane").click();
      await expect(drawer.getByRole("button", { name: /^Pane/ })).toBeVisible();

      await page.reload();
      const drawerAfter = await ensureDrawerOpen(page);
      await expect(drawerAfter.getByRole("button", { name: /^Pane/ })).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    });

    /**
     * Proves: the retired CLOCK section leaves no rail toggle behind — the
     * drawer rail renders exactly the four surviving toggles (Boards, Server,
     * Pane, Host), the same set as desktop.
     *
     * Steps:
     * 1. page.goto(/${TMUX_SERVER}), open the drawer via `Toggle navigation`.
     * 2. Assert `Toggle Clock section` has zero matches in the drawer, while
     *    the other four toggles are present.
     */
    test("the drawer rail renders exactly the four section toggles (no Clock remnant)", async ({ page }) => {
      const drawer = await gotoDrawer(page, `/${TMUX_SERVER}`);

      await expect(drawer.getByRole("button", { name: "Toggle Clock section" })).toHaveCount(0);
      await expect(railToggle(page, "Boards")).toBeVisible();
      await expect(railToggle(page, "Servers")).toBeVisible();
      await expect(railToggle(page, "Pane")).toBeVisible();
      await expect(railToggle(page, "Host")).toBeVisible();
    });
  });
});
