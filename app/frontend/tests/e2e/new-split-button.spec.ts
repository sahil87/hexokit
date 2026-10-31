import { test, expect } from "@playwright/test";
import { gotoServerReady, gotoWindow, resolveWindow, READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * Behavioural contract for the persistent `+ New` split button: its placement
 * in the sidebar head (and the head-less fallback), the route-varying instant
 * primary, the caret menu, the per-group `+` at rest, and the absence of the
 * retired create doors (the window switcher's footer, the Workspaces panel
 * `+`).
 *
 * Shared setup: `beforeAll` seeds one detached session on the isolated e2e
 * tmux server (so the sidebar has a group and `/$server` resolves a target);
 * `afterAll` kills it. Create requests are intercepted with
 * `page.route("**\/api/sessions*")` and fulfilled with a 201, so no test
 * mutates real tmux — the seam under test is the request the UI issues.
 * Desktop viewport (1024×768) except the mobile describe (375×812, touch).
 */

const SEED_SESSION = `e2e-newsplit-${process.pid}`;

test.describe("New split button (desktop)", () => {
  test.beforeAll(() => {
    createSession(SEED_SESSION);
  });
  test.afterAll(() => {
    killSession(SEED_SESSION);
  });

  /**
   * Proves: with the sidebar open the split lives in the sidebar head beside
   * the toggle, the brand link stays unique, and on the terminal route its
   * primary `+ Tab` creates a tab in the current group with no `name` (tmux
   * auto-names it).
   *
   * Steps:
   * 1. Intercept `POST /api/sessions/*\/windows*`, capturing the body.
   * 2. Open the seed group's first window's terminal route.
   * 3. Assert the split's primary reads `+ Tab`, sits inside the head beside
   *    the `Toggle navigation` button, and `HexoKit home` appears once.
   * 4. Click the primary; poll for the captured request; assert no `name`.
   */
  test("terminal route: the head's + Tab primary creates an unnamed tab", async ({ page }) => {
    let body: Record<string, unknown> | null = null;
    await page.route("**/api/sessions/*/windows*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.goto(`/${TMUX_SERVER}`);
    const win = await resolveWindow(page, TMUX_SERVER, SEED_SESSION);
    await gotoWindow(page, TMUX_SERVER, win.windowId);

    const primary = page.getByTestId("new-split-primary");
    await expect(primary).toHaveText("+ Tab");
    const head = page.locator("header > div.absolute");
    await expect(head.getByTestId("new-split-primary")).toBeVisible();
    await expect(head.getByRole("button", { name: "Toggle navigation" })).toBeVisible();
    await expect(page.getByLabel("HexoKit home")).toHaveCount(1);

    await primary.click();
    await expect.poll(() => body, { timeout: 5_000 }).not.toBeNull();
    expect(body).not.toHaveProperty("name");
  });

  /**
   * Proves: the caret menu is grouped by where the result lands (the header
   * names the workspace › group) and carries the tab, group and workspace
   * rows; `Group` opens the name prompt (the `create-session` palette body).
   *
   * Steps:
   * 1. Open the seed group's first window's terminal route.
   * 2. Open the split's caret; assert the `IN <ws> › <group>` and `IN <ws>`
   *    headers and the Tab / Tab at folder… / Group / Group at folder… /
   *    Workspace… rows.
   * 3. Click `Group`; assert the `New group` name dialog opens.
   */
  test("caret menu groups rows by target and Group opens the name prompt", async ({ page }) => {
    await page.goto(`/${TMUX_SERVER}`);
    const win = await resolveWindow(page, TMUX_SERVER, SEED_SESSION);
    await gotoWindow(page, TMUX_SERVER, win.windowId);

    await page.getByTestId("new-split-caret").click();
    const menu = page.getByTestId("new-split-menu");
    await expect(menu).toContainText(`IN ${TMUX_SERVER} › ${SEED_SESSION}`);
    await expect(menu).toContainText(`IN ${TMUX_SERVER}`);
    for (const name of ["Tab", "Tab at folder…", "Group", "Group at folder…", "Workspace…"]) {
      await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
    }
    await menu.getByRole("menuitem", { name: "Group", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New group" })).toBeVisible();
  });

  /**
   * Proves: on the server route the primary reads `+ Group` and creates a
   * group instantly (no prompt), and the menu has no tab rows.
   *
   * Steps:
   * 1. Intercept `POST /api/sessions*` (create-session), capturing the body.
   * 2. Open `/$server`; assert the primary reads `+ Group`.
   * 3. Open the caret; assert there is no `Tab` row.
   * 4. Close the menu, click the primary; poll for the captured request and
   *    assert no dialog opened.
   */
  test("server route: + Group creates a group instantly; no tab rows", async ({ page }) => {
    let created = false;
    await page.route("**/api/sessions*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && !/\/windows/.test(req.url())) {
        created = true;
        return route.fulfill({ status: 201, contentType: "application/json", body: '{"ok":true}' });
      }
      return route.fallback();
    });
    await gotoServerReady(page, TMUX_SERVER, SEED_SESSION);

    const primary = page.getByTestId("new-split-primary");
    await expect(primary).toHaveText("+ Group");
    await page.getByTestId("new-split-caret").click();
    await expect(page.getByTestId("new-split-menu").getByRole("menuitem", { name: "Tab", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await primary.click();
    await expect.poll(() => created, { timeout: 5_000 }).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  /**
   * Proves: with the sidebar closed the head is gone and exactly one
   * icon-only split follows the hamburger; reopening the sidebar moves it
   * back into the head.
   *
   * Steps:
   * 1. Open `/$server`; click `Toggle navigation` to close the sidebar.
   * 2. Assert one split, its primary has no label text, and it is the
   *    hamburger's next sibling.
   * 3. Click the toggle again; assert the split is back inside the head with
   *    its label.
   */
  test("sidebar closed: an icon-only split follows the hamburger", async ({ page }) => {
    await gotoServerReady(page, TMUX_SERVER, SEED_SESSION);
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await expect(page.locator("header > div.absolute")).toHaveCount(0);
    await expect(page.getByTestId("new-split")).toHaveCount(1);
    await expect(page.getByTestId("new-split-primary")).toHaveText("");
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-testid", "new-split");

    await toggle.click();
    await expect(page.locator("header > div.absolute").getByTestId("new-split-primary")).toHaveText("+ Group");
  });

  /**
   * Proves: each group row carries a `+` visible at rest that creates a tab in
   * THAT group, and the retired doors are gone — the window switcher has no
   * create footer and the Workspaces panel has no header `+`.
   *
   * Steps:
   * 1. Intercept `POST /api/sessions/*\/windows*`, capturing the URL.
   * 2. Open `/$server`; assert the seed group's `New tab in <group>` button is
   *    visible without hovering and no `New workspace` button exists.
   * 3. Click it; poll for the captured request and assert it targets the seed
   *    group.
   * 4. Open a window's terminal route, open `Switch tab`; assert no
   *    `+ New Tab` / `+ New Agent` items.
   */
  test("per-group + at rest creates in that group; retired doors are gone", async ({ page }) => {
    let url: string | null = null;
    await page.route("**/api/sessions/*/windows*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      url = route.request().url();
      return route.fulfill({ status: 201, contentType: "application/json", body: '{"ok":true}' });
    });
    await gotoServerReady(page, TMUX_SERVER, SEED_SESSION);

    const plus = page.getByRole("button", { name: `New tab in ${SEED_SESSION}` });
    await expect(plus).toBeVisible();
    await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0);
    await plus.click();
    await expect.poll(() => url, { timeout: 5_000 }).toContain(`/api/sessions/${SEED_SESSION}/windows`);

    const win = await resolveWindow(page, TMUX_SERVER, SEED_SESSION);
    await gotoWindow(page, TMUX_SERVER, win.windowId);
    await page.getByLabel("Switch tab").click();
    await expect(page.getByRole("menuitem", { name: "+ New Tab" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "+ New Agent" })).toHaveCount(0);
  });

  /**
   * Proves: the Host page carries a plain `+ Workspace` button with no caret
   * that opens the New sheet at Workspace level.
   *
   * Steps:
   * 1. Open `/`; wait for the top bar.
   * 2. Assert the split's primary reads `+ Workspace` and there is no caret.
   * 3. Click it; assert the New sheet opens with the Workspace level pressed.
   */
  test("host page: + Workspace opens the New sheet at Workspace level", async ({ page }) => {
    await page.goto("/");
    const primary = page.getByTestId("new-split-primary");
    await expect(primary).toHaveText("+ Workspace", { timeout: READY_TIMEOUT });
    await expect(page.getByTestId("new-split-caret")).toHaveCount(0);
    await primary.click();
    await expect(page.getByRole("button", { name: "Workspace", exact: true, pressed: true })).toBeVisible();
  });
});

test.describe("New split button (mobile drawer)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test.beforeAll(() => {
    createSession(SEED_SESSION);
  });
  test.afterAll(() => {
    killSession(SEED_SESSION);
  });

  /**
   * Proves: below `sm` the top bar carries no New control; the drawer's brand
   * row does, at the coarse 40px height, with the caret menu available.
   *
   * Steps:
   * 1. Open `/$server` at 375×812; assert no split in the top bar.
   * 2. Open the drawer via `Toggle navigation`.
   * 3. Assert the split sits in the drawer's first row and is ≥ 40px tall.
   * 4. Open its caret; assert the menu lists a `Group` row.
   */
  test("the drawer's brand row carries the split at the coarse height", async ({ page }) => {
    await page.goto(`/${TMUX_SERVER}`);
    await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.locator("header").getByTestId("new-split")).toHaveCount(0);

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sidebar = page.getByRole("navigation", { name: "Groups" });
    const split = sidebar.getByTestId("new-split");
    await expect(split).toBeVisible();
    const box = (await split.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);

    await sidebar.getByTestId("new-split-caret").click();
    await expect(sidebar.getByTestId("new-split-menu").getByRole("menuitem", { name: "Group", exact: true })).toBeVisible();
  });
});
