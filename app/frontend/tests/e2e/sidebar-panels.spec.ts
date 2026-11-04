import { test, expect, type Page } from "@playwright/test";
import { READY_TIMEOUT, gotoServerReady } from "./_ready";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

const TEST_SESSION = `e2e-panels-${Date.now()}`;

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * CollapsiblePanel-based Host and Pane panels. The panels are
 * visibility-gated per section (the `hexokit-sidebar-section-pane|host`
 * booleans), both defaulting OFF on every viewport — the drawer-only fork
 * became a default, not a hard `isMobile` gate. The panel tests run on a
 * mobile viewport with the drawer open and first opt both sections in via
 * `addInitScript` seeds; a desktop test pins the default-off contract.
 * Validates that SSE-driven host metrics render, window context updates when
 * a window is selected, and the collapse/expand state persists via
 * localStorage.
 *
 * DOM note: CollapsiblePanel renders <outer-div> > <header-div> > <button>
 * plus <outer-div> > <content-div>; two `..` levels from the title button
 * reach the outer wrapper, one only reaches the header — these tests
 * deliberately use locator("../..").
 *
 * Shared setup: beforeAll creates `e2e-panels-<timestamp>` so the Pane panel
 * has a real window to display once selected; afterAll kills it. The
 * `mobile drawer` describe runs test.use({ hasTouch: true, viewport:
 * 375×812 }) — `hasTouch` flips Chromium's `(any-pointer: coarse)` media
 * query, so combined with the 375px width `useIsMobile()` reports mobile and
 * the sidebar renders as the drawer — and its beforeEach seeds
 * `hexokit-sidebar-section-pane=true` and `hexokit-sidebar-section-host=true`
 * via `addInitScript` (both sections default OFF; the seed re-runs on every
 * navigation, so in-test reloads keep the panels mounted). gotoDrawer
 * navigates, then opens the drawer via the `Toggle navigation` button and
 * returns the role="dialog" drawer — it gates on the toggle, NOT the
 * sidebar-footed `Connected` dot (a closed drawer leaves it unmounted).
 * ensureDrawerOpen re-opens the drawer when a destination tap auto-closed it
 * or a reload landed on the persisted sidebar preference.
 */

/** Navigate at the mobile viewport, then open the drawer (the panels' only
 *  home). Gates on the `Toggle navigation` button, NOT the sidebar-footed
 *  `Connected` dot — a closed drawer leaves it unmounted. Returns the drawer
 *  (`role="dialog"`). `readyText` gates LAZY routes (the board chunk): the
 *  top bar's toggle renders before the route's slot registration effect runs,
 *  so a click that lands early is a noop — wait for a content string from the
 *  route body first. */
async function gotoDrawer(page: Page, path: string, readyText?: string | RegExp) {
  await page.goto(path);
  if (readyText) {
    await expect(page.getByText(readyText).first()).toBeVisible({ timeout: READY_TIMEOUT });
  }
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer;
}

/** Re-open the drawer if it is closed (post-navigation auto-close, or a
 *  reload landing on the persisted sidebar preference either way). */
async function ensureDrawerOpen(page: Page) {
  const drawer = page.getByRole("dialog");
  if (await drawer.isVisible().catch(() => false)) return drawer;
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer;
}

test.describe("Sidebar Host & Window Panels (visibility-gated, iha5)", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: the default-visibility contract — on a desktop (fine pointer,
   * wide) with nothing seeded, the sidebar renders no Pane/Host panels (both
   * sections default off); the registers' home (the status bar) is present
   * instead. (Desktop opt-in via the rail is covered by
   * sidebar-section-rail.spec.ts.)
   *
   * Steps:
   * 1. gotoServerReady(TMUX_SERVER) (desktop default).
   * 2. Assert zero buttons named /^Pane/ or /^Host/.
   * 3. Assert the status-bar testid is visible.
   */
  test("desktop sidebar renders NO PANE/HOST panels under the defaults (both sections default off; the status bar carries the registers)", async ({
    page,
  }) => {
    // Desktop (fine pointer, wide), nothing seeded: both sections default off,
    // so the panels are gone and the session region owns the freed height; the
    // window/host values live in the status bar instead. (A desktop user can
    // opt back in via the rail — covered by sidebar-section-rail.spec.ts.)
    await gotoServerReady(page, TMUX_SERVER);
    await expect(page.getByRole("button", { name: /^Pane/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Host/ })).toHaveCount(0);
    await expect(page.getByTestId("status-bar")).toBeVisible();
  });

  test.describe("mobile drawer", () => {
    test.use({ hasTouch: true, viewport: MOBILE_VIEWPORT });

    test.beforeEach(async ({ page }) => {
      // Opt the Pane/Host sections in — both default OFF (iha5), and these
      // tests exercise the panels themselves. The seed survives the in-test
      // `page.reload()` (init scripts re-run on every navigation).
      await page.addInitScript(() => {
        localStorage.setItem("hexokit-sidebar-section-pane", "true");
        localStorage.setItem("hexokit-sidebar-section-host", "true");
      });
    });

    /**
     * Proves: the Host collapsible panel is open by default and populated
     * with real metrics (CPU, memory, load, disk, uptime) received via SSE
     * within one tick.
     *
     * Steps:
     * 1. gotoDrawer(/${TMUX_SERVER}).
     * 2. Locate the header button with name /^Host/; assert visible and
     *    aria-expanded="true".
     * 3. Walk up to the outer panel (locator("../..")).
     * 4. Inside that subtree, assert the presence of: the `cpu` label (within
     *    8s, covers the first SSE tick), a percentage rendering (/%/), the
     *    `mem` label, ^ld, dsk, and `up `.
     * 5. Assert memory is not rendered as `0/0` (sentinel for missing data).
     * 6. Assert disk renders as \d+(\.\d+)?[GM]/\d+G.
     */
    test("Host panel shows real system metrics via SSE", async ({ page }) => {
      await gotoDrawer(page, `/${TMUX_SERVER}`);

      // Host panel header is visible and expanded (exact match avoids other "Host" buttons)
      const hostButton = page.getByRole("button", { name: /^Host/ });
      await expect(hostButton).toBeVisible();
      await expect(hostButton).toHaveAttribute("aria-expanded", "true");

      // CollapsiblePanel renders: <outer-div> > <header-div> > <button> and
      // <outer-div> > <content-div>. Two ups from the button reaches the outer
      // panel div, which contains both the header and the content.
      const hostPanel = hostButton.locator("../..");

      // Wait for metrics to arrive via SSE (at least one tick ~2.5s)
      // CPU line with label and percentage
      await expect(hostPanel.locator("text=cpu")).toBeVisible({ timeout: 8_000 });
      await expect(hostPanel.locator("text=/%/").first()).toBeVisible();

      // Memory line with label and gauge
      await expect(hostPanel.locator("text=mem")).toBeVisible();

      // Load line with label
      await expect(hostPanel.locator("text=/^ld/")).toBeVisible();

      // Disk + uptime line
      await expect(hostPanel.locator("text=dsk")).toBeVisible();
      await expect(hostPanel.locator("text=/up /")).toBeVisible();

      // Memory should show real values (not 0/0)
      await expect(hostPanel.locator("text=0/0")).not.toBeVisible();

      // Disk should show real values with G suffix (fractional GB like
      // "9.4G/460G" allowed — the host's real disk size is not our choice).
      await expect(hostPanel.locator("text=/\\d+(\\.\\d+)?[GM]\\/\\d+G/")).toBeVisible();
    });

    /**
     * Proves: the Pane panel shows a "No tab selected" fallback when on the
     * dashboard, then swaps to tmux metadata (tmx, cwd, …) when a window is
     * selected.
     *
     * Steps:
     * 1. gotoDrawer(/${TMUX_SERVER}).
     * 2. Locate the header button with name /^Pane/; assert visible and
     *    expanded.
     * 3. Walk up to the outer panel.
     * 4. Assert `No tab selected` is visible.
     * 5. Click the sidebar's `Navigate to ${TEST_SESSION}` button (selects
     *    the first window in that session) — the drawer auto-closes on the
     *    destination tap, so re-open it via ensureDrawerOpen.
     * 6. Within 3s, assert lines ^tmx and ^cwd (key + gap, matched with \s
     *    because the flex cwd row's gap is an NBSP) appear inside the Pane panel.
     */
    test("Window panel shows selected window info", async ({ page }) => {
      await gotoDrawer(page, `/${TMUX_SERVER}`);

      // Pane panel header (exact match to avoid other buttons containing "Pane")
      const paneButton = page.getByRole("button", { name: /^Pane/ });
      await expect(paneButton).toBeVisible();
      await expect(paneButton).toHaveAttribute("aria-expanded", "true");

      const panePanel = paneButton.locator("../..");

      // Before selecting a window — shows fallback text
      await expect(
        panePanel.locator("text=No tab selected"),
      ).toBeVisible();

      // Click the session's "Navigate to" button — selects the first window.
      // The drawer AUTO-CLOSES on the destination tap, so reopen it to see
      // the panel.
      const drawer = page.getByRole("dialog");
      const navButton = drawer.getByRole("button", {
        name: new RegExp(`Navigate to ${TEST_SESSION}`),
      });
      await expect(navButton).toBeVisible({ timeout: READY_TIMEOUT });
      await navButton.click();
      await ensureDrawerOpen(page);

      // After selecting — should show tmx and cwd lines
      // The key gap is a plain space on inline rows and an NBSP on the flex
      // cwd row; `text=` regexes test raw text, so match the gap with \s.
      await expect(panePanel.locator("text=/^tmx\\s/")).toBeVisible({ timeout: 3_000 });
      await expect(panePanel.locator("text=/^cwd\\s/")).toBeVisible();
    });

    /**
     * Proves: clicking the Host header collapses/expands the panel, the state
     * is mirrored into localStorage, and it survives a full page reload.
     *
     * Steps:
     * 1. gotoDrawer and wait for the `cpu` line (metrics rendered).
     * 2. Click the Host header to collapse; assert aria-expanded="false".
     * 3. Read localStorage.getItem('hexokit-panel-host') and assert it equals
     *    the string "false".
     * 4. page.reload(); re-open the drawer via ensureDrawerOpen (the reload
     *    lands on the persisted sidebar preference, open or closed).
     * 5. Re-locate the Host header; assert it is still collapsed.
     * 6. Click to expand; assert aria-expanded="true" and the `cpu` line
     *    reappears within 8s.
     * 7. Clean up the `hexokit-panel-host` localStorage key for the next test.
     */
    test("Collapsible panel toggle and persistence", async ({ page }) => {
      await gotoDrawer(page, `/${TMUX_SERVER}`);

      // Wait for metrics so Host panel has content
      const hostButton = page.getByRole("button", { name: /^Host/ });
      await expect(hostButton).toBeVisible();
      await expect(hostButton).toHaveAttribute("aria-expanded", "true");

      const hostPanel = hostButton.locator("../..");
      await expect(hostPanel.locator("text=cpu")).toBeVisible({ timeout: 8_000 });

      // Collapse the Host panel
      await hostButton.click();
      await expect(hostButton).toHaveAttribute("aria-expanded", "false");

      // Verify localStorage was set
      const stored = await page.evaluate(() =>
        localStorage.getItem("hexokit-panel-host"),
      );
      expect(stored).toBe("false");

      // Reload page — panel should remain collapsed. The drawer lands open or
      // closed per the persisted sidebar preference; either way, open it.
      await page.reload();
      await ensureDrawerOpen(page);

      const hostButtonAfter = page.getByRole("button", { name: /^Host/ });
      await expect(hostButtonAfter).toHaveAttribute("aria-expanded", "false");

      // Expand it back
      await hostButtonAfter.click();
      await expect(hostButtonAfter).toHaveAttribute("aria-expanded", "true");

      // Content reappears
      await expect(
        hostButtonAfter.locator("../..").locator("text=cpu"),
      ).toBeVisible({ timeout: 8_000 });

      // Clean up localStorage for other tests
      await page.evaluate(() => localStorage.removeItem("hexokit-panel-host"));
    });

    /**
     * Proves: on /board/$name — where the route provides no server param and
     * both bottom panels would otherwise render empty by construction — the
     * PANE panel follows the board's focused tile (resolving the pinned
     * window's enriched home-session copy by windowId from the sessions
     * stream) and the HOST panel falls back to the host-global metrics
     * broadcast. The HOST header carries no connection dot — the sidebar
     * footer dot owns that signal.
     *
     * Steps:
     * 1. Resolve the test session's window id via tmux list-windows and pin
     *    it to a fresh board (panels<suffix>) via POST
     *    /api/boards/{name}/pin.
     * 2. gotoDrawer(/board/${boardName}) — a lazy chunk, so gate on the
     *    pinned window's name rendering first.
     * 3. Locate the Pane header button, walk up to the outer panel, and
     *    assert ^tmx and ^cwd rows (key + \s gap) appear (within 10s) while
     *    `No tab selected` is absent — the focused-tile fallback filled the
     *    panel.
     * 4. Locate the Host outer panel and assert `cpu` (within 8s, first
     *    metrics tick) and `mem` rows render, `No metrics` is absent, and no
     *    element with an `SSE` title exists (the header connection dot was
     *    removed).
     * 5. finally: unpin the window via the API so the shared server carries
     *    no leftover board.
     */
    test("board route populates PANE (focused tile) and HOST (host-metrics fallback)", async ({ page }) => {
      test.setTimeout(30_000);
      // Pin the test session's window to a fresh board via the API (deterministic;
      // the pin UI is exercised elsewhere). Board pins are LINK-based, so the
      // window's home-session copy keeps flowing through the sessions stream —
      // that enriched copy is what the PANE panel resolves by windowId.
      const boardName = `panels${Date.now().toString().slice(-6)}`;
      const winId = listWindows(TEST_SESSION)[0]?.windowId;
      expect(winId).toBeTruthy();
      const pinRes = await page.request.post(`/api/boards/${boardName}/pin`, {
        data: { server: TMUX_SERVER, windowId: winId },
      });
      expect(pinRes.ok()).toBeTruthy();

      try {
        // The board route is a LAZY chunk — gate on the pinned window's name
        // rendering in the page body before opening the drawer (an early
        // toggle click lands before the route's top-bar slot registration and
        // is a noop).
        const winName = listWindows(TEST_SESSION)[0]?.name;
        await gotoDrawer(page, `/board/${boardName}`, winName);

        // PANE panel — no route window on /board/$name, so the panel follows the
        // board's focused tile (index 0). The tmx/cwd identity rows render from
        // the resolved home-session copy instead of "No window selected".
        const paneButton = page.getByRole("button", { name: /^Pane/ });
        await expect(paneButton).toBeVisible({ timeout: 10_000 });
        const panePanel = paneButton.locator("../..");
        await expect(panePanel.locator("text=/^tmx\\s/")).toBeVisible({ timeout: 10_000 });
        await expect(panePanel.locator("text=/^cwd\\s/")).toBeVisible();
        await expect(panePanel.locator("text=No tab selected")).not.toBeVisible();

        // HOST panel — no currentServer on the board route, so the panel falls
        // back to the host-global metrics broadcast instead of "No metrics".
        // The header carries no connection dot (the sidebar FOOTER dot owns
        // that signal), so its absence is asserted rather than an "SSE" title.
        const hostButton = page.getByRole("button", { name: /^Host/ });
        await expect(hostButton).toBeVisible();
        const hostPanel = hostButton.locator("../..");
        await expect(hostPanel.locator("text=cpu")).toBeVisible({ timeout: 8_000 });
        await expect(hostPanel.locator("text=mem")).toBeVisible();
        await expect(hostPanel.locator("text=No metrics")).not.toBeVisible();
        await expect(hostPanel.locator("[title*='SSE']")).toHaveCount(0);
      } finally {
        // Unpin so the shared server carries no leftover board (empty boards are
        // reaped server-side).
        await page.request.post(`/api/boards/${boardName}/unpin`, {
          data: { server: TMUX_SERVER, windowId: winId },
        });
      }
    });

    /**
     * Proves: metrics don't stop rendering after the first tick — they remain
     * populated across at least two full SSE cycles (~5s).
     *
     * Steps:
     * 1. gotoDrawer and wait for Connected-equivalent panel content.
     * 2. Locate the Host outer panel via ../.. from the header button.
     * 3. Assert `cpu` appears within 8s.
     * 4. waitForTimeout(5500) — covers ≥2 SSE ticks (2.5s apart).
     * 5. Assert `cpu`, `mem`, ^ld, and `dsk` are all still visible. A
     *    disconnection, stale buffer, or unmounted HostPanel would fail here.
     */
    test("Host panel metrics update over multiple SSE ticks", async ({ page }) => {
      await gotoDrawer(page, `/${TMUX_SERVER}`);

      const hostPanel = page.getByRole("button", { name: /^Host/ }).locator("../..");

      // Wait for first metrics tick
      await expect(hostPanel.locator("text=cpu")).toBeVisible({ timeout: 8_000 });

      // Wait for at least 2 SSE ticks (2.5s each = ~5s) and verify content is still present
      await page.waitForTimeout(5_500);

      // Panel still shows metrics (not stale or disconnected)
      await expect(hostPanel.locator("text=cpu")).toBeVisible();
      await expect(hostPanel.locator("text=mem")).toBeVisible();
      await expect(hostPanel.locator("text=/^ld/")).toBeVisible();
      await expect(hostPanel.locator("text=dsk")).toBeVisible();
    });
  });
});
