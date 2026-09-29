import { test, expect } from "@playwright/test";
import { READY_TIMEOUT, gotoServerReady } from "./_ready";
import { TMUX_SERVER, TMUX_FAMILY, createSession, killServer, killSession } from "./_tmux";

/**
 * Behavioural contract for the sidebar's explicit sessions-pane scope
 * (localStorage `hexokit-panel-sessions-scope`, `all | current`, default
 * `all`) and its delink from the SERVER panel's expansion state. The
 * SESSIONS-header chip (`ALL`/`CUR`) is the toggle affordance; the SERVER
 * panel defaults open and its expansion no longer filters the session tree.
 *
 * Shared setup: `beforeAll` creates one session on the default e2e tmux
 * server (`E2E_TMUX_SERVER`, the worktree's derived e2e primary) and a second
 * tmux server (named inside this worktree's socket family off the
 * `TMUX_FAMILY` anchor, with the Playwright `process.pid` embedded so the
 * automatic post-sweep can parse it) with its own session — two distinct
 * servers are required so scope narrowing is observable. `afterAll` kills the
 * session on the default server and `kill-server`s the second tmux server
 * entirely. All tests use the desktop viewport (1024×768) so the sidebar is
 * rendered as a docked column, not the mobile overlay (the scope logic itself
 * is layout-independent). The `current`-scope-with-no-current-server fallback
 * (board routes render all servers) is covered by unit tests in
 * `src/components/sidebar/index.test.tsx` — board fixtures are out of scope
 * here.
 */

const TMUX_SERVER_A = TMUX_SERVER;
// Second tmux server gives us a non-current group to observe while toggling
// scope. Named inside this worktree's socket family (TMUX_FAMILY anchor) with
// the Playwright process.pid as the second-to-last hyphen field so the
// automatic post-sweep can parse it; the trailing suffix is a single
// hyphen-free token to keep the PID position unambiguous.
const TMUX_SERVER_B = `${TMUX_FAMILY}scope-${process.pid}-${Date.now().toString().slice(-6)}`;
const SESSION_A = `e2e-scope-a-${Date.now()}`;
const SESSION_B = `e2e-scope-b-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1024, height: 768 };

test.describe("Sidebar — sessions-pane scope toggle", () => {
  test.beforeAll(() => {
    createSession(SESSION_A, { server: TMUX_SERVER_A });
    createSession(SESSION_B, { server: TMUX_SERVER_B });
  });

  test.afterAll(() => {
    killSession(SESSION_A, { server: TMUX_SERVER_A });
    killServer(TMUX_SERVER_B);
  });

  /**
   * Proves: the default scope is `all` (both server groups render with no
   * stored value) and the SESSIONS-header chip toggles the scope in both
   * directions: `current` narrows the tree to exactly the current server's
   * group; toggling back to `all` restores the multi-server tree. The chip
   * itself reads the active scope at rest (`ALL` ⇄ `CUR`).
   *
   * Steps:
   * 1. Set desktop viewport and navigate to `/${TMUX_SERVER_A}`; wait for
   *    `Connected`.
   * 2. Assert both `[data-server='A']` and `[data-server='B']` group headers
   *    are visible (default `all` baseline).
   * 3. Locate the chip (`button`, accessible name `Toggle sessions scope`);
   *    assert it reads `ALL`.
   * 4. Click the chip; assert it reads `CUR`.
   * 5. Assert `[data-server='A']` is still visible (current server's group).
   * 6. Assert `[data-server='B']` count is `0` (narrowed).
   * 7. Click the chip again; assert it reads `ALL`.
   * 8. Assert both groups are visible again.
   */
  test("toggling scope to current narrows the Sessions tree; toggling back restores it", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoServerReady(page, TMUX_SERVER_A);

    // Baseline: default scope `all` → both server groups render.
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible({ timeout: 10_000 });

    const chip = page.getByRole("button", { name: "Toggle sessions scope" });
    await expect(chip).toHaveText("ALL");

    // Toggle to `current`: tree narrows to the current server's group.
    await chip.click();
    await expect(chip).toHaveText("CUR");
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`)).toHaveCount(0);

    // Toggle back to `all`: the multi-server tree returns.
    await chip.click();
    await expect(chip).toHaveText("ALL");
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible();
  });

  /**
   * Proves: the scope is persisted state, not per-session UI — after toggling
   * to `current` and reloading the page, the tree renders narrowed and the
   * chip reads `CUR` without any user interaction.
   *
   * Steps:
   * 1. Set desktop viewport, navigate to `/${TMUX_SERVER_A}`, wait for
   *    `Connected`, and wait for the `B` group (baseline `all`).
   * 2. Click the chip; assert `[data-server='B']` count is `0`.
   * 3. Reload the page and wait for `Connected`.
   * 4. Assert the chip reads `CUR`.
   * 5. Assert `[data-server='A']` is visible and `[data-server='B']` count is
   *    `0` (the persisted scope was applied on a fresh render).
   */
  test("scope persists across reload", async ({ page }) => {
    test.setTimeout(30_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoServerReady(page, TMUX_SERVER_A);
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible({ timeout: 10_000 });

    const chip = page.getByRole("button", { name: "Toggle sessions scope" });
    await chip.click();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`)).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    // Persisted `current` scope survives the reload: still narrowed, chip
    // still reads CUR.
    await expect(
      page.getByRole("button", { name: "Toggle sessions scope" }),
    ).toHaveText("CUR");
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`)).toHaveCount(0);
  });

  /**
   * Proves: the SERVER panel defaults open (tile grid visible on load) and
   * its expansion state is fully decoupled from the session list — collapsing
   * and re-expanding the panel leaves the multi-server tree unchanged.
   *
   * Steps:
   * 1. Set desktop viewport and navigate to `/${TMUX_SERVER_A}`; wait for
   *    `Connected`.
   * 2. Assert the SERVER header button has `aria-expanded="true"` and the
   *    tile grid (`role=listbox`, `name=/Tmux servers/`) is visible without
   *    any click (default-open) AND both server groups render.
   * 3. Click the SERVER panel header to collapse it; assert
   *    `aria-expanded="false"` (expansion is asserted via the ARIA state — a
   *    collapsed panel only clips its content, which Playwright still counts
   *    as visible).
   * 4. Assert both server groups still render (tree unchanged).
   * 5. Click the header again to re-expand; assert `aria-expanded="true"`.
   * 6. Assert both server groups still render.
   */
  test("SERVER panel expansion does not affect the Sessions tree (delink)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await gotoServerReady(page, TMUX_SERVER_A);

    // The SERVER panel now defaults OPEN — the tile grid is visible on load —
    // and the tree still shows every server's group (the old coupling would
    // have narrowed it). Expansion state is asserted via the header's
    // aria-expanded: a collapsed panel merely clips its content (height 0 +
    // overflow hidden), which Playwright still counts as "visible".
    const toggle = page.getByRole("button", { name: /^Server/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("listbox", { name: /Tmux servers/ })).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible({ timeout: 10_000 });

    // Collapse the panel: the tree is unchanged.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible();

    // Re-expand: still unchanged.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[data-server='${TMUX_SERVER_A}']`).first()).toBeVisible();
    await expect(page.locator(`[data-server='${TMUX_SERVER_B}']`).first()).toBeVisible();
  });
});
