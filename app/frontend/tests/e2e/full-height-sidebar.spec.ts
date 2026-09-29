import { test, expect, type Page } from "@playwright/test";
import { STAGE_COLUMN_GAP_PX } from "../../src/lib/stage-geometry";
import { mockStateSocket } from "./_state-socket-mock";

// Full-height sidebar e2e. Fully mocked (no tmux/gh) — the
// chrome-material.spec.ts idiom: the state socket (mockStateSocket from
// _state-socket-mock.ts) delivers one session (`dev`) with one window (`@1`),
// `/ws/terminals` is stubbed (xterm still mounts locally — the socket only
// feeds I/O), and `/api/servers` + `/api/health` are fulfilled inline. Every
// test runs at 1440×900 (desktop chrome, fine pointer — the sidebar aside
// renders and is open by default) on the terminal route `/default/1`. No
// host-global state is touched.
//
// Subjects: the sidebar head contract — while the desktop sidebar is open,
// the top bar paints a SidebarHead over its left end (the brand anchor plus
// the sidebar toggle), sized to the sidebar track plus the stage padding and
// column gap so its right edge lands on the content column's left edge; the
// header's 3px bottom border stays on the single full-width header (one
// continuous line, never split onto the head); and the breadcrumb nav opens
// without a leading `›` (that separator belonged to the brand root crumb,
// which the head replaces while it shows).

const SERVER = "default";

const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "work",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        panes: [
          { paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "bash", isActive: true, gitBranch: "main" },
        ],
      },
    ],
  },
]);

async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/health*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hostname: "e2e-box", instanceName: null }),
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload });
}

test.describe("Full-height sidebar — the sidebar head over the bar's left end", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockBackend(page);
  });

  /** Navigate to the terminal route and wait for the chrome to settle. */
  async function gotoTerminal(page: Page) {
    await page.goto(`/${SERVER}/1`);
    await expect(page.locator('aside[aria-label="Sidebar"]')).toBeVisible({ timeout: 15_000 });
  }

  /** The head is the header's only absolutely positioned child. */
  const head = (page: Page) => page.locator("header > div.absolute");

  /**
   * Proves: with the desktop sidebar open, the top bar's left end carries the
   * sidebar head — the `HexoKit home` brand anchor and the `Toggle navigation`
   * button — sized exactly over the sidebar track plus the stage gap, with
   * the toggle still left of the sidebar's right edge.
   *
   * Steps:
   * 1. Navigate to `/default/1` at 1440×900; wait for the sidebar aside.
   * 2. Locate the head (the header's absolutely positioned child) and assert
   *    it holds both the brand link and the toggle button.
   * 3. Read the head's and the aside's bounding boxes; assert the head hugs
   *    the left edge (x ≈ 0) and its right edge lands on the content
   *    column's left edge (the aside's right edge + the 6px stage gap, ±1px).
   * 4. Assert the toggle's box ends left of the aside's right edge.
   */
  test("the head overlays the sidebar track: brand + toggle inside, right edge on the content column", async ({
    page,
  }) => {
    await gotoTerminal(page);

    await expect(head(page)).toBeVisible();
    const brand = page.getByRole("link", { name: "HexoKit home" });
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(brand).toBeVisible();
    await expect(toggle).toBeVisible();
    expect(await head(page).locator('a[aria-label="HexoKit home"]').count()).toBe(1);
    expect(await head(page).locator('button[aria-label="Toggle navigation"]').count()).toBe(1);

    const headBox = (await head(page).boundingBox())!;
    const asideBox = (await page.locator('aside[aria-label="Sidebar"]').boundingBox())!;
    const headRight = headBox.x + headBox.width;
    const asideRight = asideBox.x + asideBox.width;
    expect(headBox.x).toBeLessThanOrEqual(1);
    // The head covers the sidebar track plus the stage column gap, so its
    // right edge lands exactly on the content column's left edge.
    expect(Math.abs(headRight - (asideRight + STAGE_COLUMN_GAP_PX))).toBeLessThanOrEqual(1);
    // The toggle sits left of the sidebar's right edge (the head's right
    // padding spends the gap, not the toggle's box).
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(asideRight);
  });

  /**
   * Proves: the 3px bottom border is ONE continuous line — it lives on the
   * single full-width `<header>` (the only header element in the document),
   * which spans the entire viewport width; the head carries no border of its
   * own.
   *
   * Steps:
   * 1. Navigate to `/default/1` at 1440×900; wait for the sidebar aside.
   * 2. Assert exactly one `header` element exists and its box spans the full
   *    1440px viewport width.
   * 3. Read the header's computed `border-bottom-width`; assert `3px`.
   * 4. Assert the head's computed `border-bottom-width` is `0px`.
   */
  test("the 3px seam stays on the single full-width header", async ({ page }) => {
    await gotoTerminal(page);

    const header = page.locator("header");
    await expect(header).toHaveCount(1);
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.x).toBeLessThanOrEqual(1);
    expect(headerBox.width).toBe(1440);
    const borderWidth = await header.evaluate(
      (el) => getComputedStyle(el).borderBottomWidth,
    );
    expect(borderWidth).toBe("3px");
    const headBorderWidth = await head(page).evaluate(
      (el) => getComputedStyle(el).borderBottomWidth,
    );
    expect(headBorderWidth).toBe("0px");
  });

  /**
   * Proves: while the head shows, the breadcrumb nav opens without a leading
   * `›` separator — that separator belonged to the brand root crumb, which
   * the head replaces — and the brand link no longer renders inside the nav.
   *
   * Steps:
   * 1. Navigate to `/default/1` at 1440×900; wait for the sidebar aside.
   * 2. Assert the breadcrumb nav holds no `HexoKit home` link (it is the
   *    head's anchor now, and the label is unique in the document).
   * 3. Read the nav's first rendered child; assert its text does not begin
   *    with the `›` separator glyph.
   */
  test("the breadcrumb nav has no brand crumb and no leading separator while the head shows", async ({
    page,
  }) => {
    await gotoTerminal(page);

    const nav = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(nav.getByLabel("HexoKit home")).toHaveCount(0);
    await expect(page.getByLabel("HexoKit home")).toHaveCount(1);
    const firstText = await nav.evaluate(
      (el) => el.firstElementChild?.textContent ?? "",
    );
    expect(firstText.startsWith("›")).toBe(false);
  });

  /**
   * Proves: the head's controls are keyboard-reachable in order — the brand
   * link and then the toggle button are consecutive Tab stops from the
   * window start (Constitution V).
   *
   * Steps:
   * 1. Navigate to `/default/1` at 1440×900; wait for the sidebar aside.
   * 2. Press Tab (bounded loop, ≤12 presses, keyboard modality from a fresh
   *    page) until the `HexoKit home` link is `document.activeElement`.
   * 3. Press Tab once more; assert the `Toggle navigation` button has focus.
   */
  test("Tab reaches the head's brand link, then its toggle, in order", async ({ page }) => {
    await gotoTerminal(page);

    const brand = page.getByRole("link", { name: "HexoKit home" });
    let focused = false;
    for (let i = 0; i < 12 && !focused; i++) {
      await page.keyboard.press("Tab");
      focused = await brand.evaluate((el) => el === document.activeElement);
    }
    expect(focused, "the head's brand link never received keyboard focus").toBe(true);

    await page.keyboard.press("Tab");
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    expect(await toggle.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});
