/**
 * Demo: the right-aligned `Operator` launcher button, recorded for PR
 * evidence. On desktop it is the leftmost item of the top bar's right
 * cluster, one button that latches while the drawer is open; clicking it
 * while open re-focuses the docked compose; Esc closes; an unsent draft
 * lights its dot; and narrowing the window folds it to the keycap-less
 * label, then glyph-only, then into the chevron menu's `Operator` row. On mobile the top bar carries no
 * launcher and the chevron row still opens the operator route.
 *
 * Runs only under `just demo operator-button` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). The `--before` pass runs against the
 * base ref, where the launcher is a standing input in the center cell: the
 * spec then shows that box (click swaps it for a collapsed control) so the
 * before/after pair shows what changed.
 *
 * Shared setup: beforeAll seeds two detached sessions — one the page is
 * viewed from, one holding a window stamped with the operator role (no
 * operator workflow is launched; the stamp is what the launcher resolves).
 * afterAll kills both.
 */
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, setWindowOption } from "../e2e/_tmux";

const VIEW_SESSION = `demo-opbtn-view-${process.pid}`;
const OPERATOR_SESSION = `demo-opbtn-op-${process.pid}`;

/** Viewport widths walked from roomy to narrow desktop, to show the fold:
 *  with the sidebar open (the default) the launcher is full at ≥1450,
 *  label-only at 1270–1449, glyph-only at 905–1269 and a menu row below that
 *  (the sidebar head yields under ~830 and the bar regains room, so the walk
 *  stops short of it). */
const NARROWING_WIDTHS = [1500, 1350, 1200, 1050, 950, 880, 860];

test.describe("operator-button demo", () => {
  let windowId = "";

  test.beforeAll(async () => {
    createSession(VIEW_SESSION);
    createSession(OPERATOR_SESSION, { windows: ["operator"] });
  });

  test.afterAll(() => {
    killSession(VIEW_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: a reviewer can see the launcher's one-button contract end to end —
   * its place in the right cluster, the latch while open, the re-focus click,
   * Esc, the draft dot, and the narrow-width ladder — and that mobile's top
   * bar is unchanged.
   *
   * Steps:
   * 1. Stamp the second session's window as the operator, open the first
   *    session's window and wait for the app; `beat()`.
   * 2. Desktop: hover the launcher for its tooltip; click it (drawer opens,
   *    button latches, compose focused); click into the drawer's terminal and
   *    back on the launcher (compose re-focused, drawer stays open); type a
   *    draft; Esc twice (yield, release) so the draft dot shows at rest.
   *    (Base ref: click the standing input, which swaps for a collapsed
   *    control, then Esc.)
   * 3. Desktop: walk the viewport narrower in steps — full (`◉ Operator
   *    <chord>`) → label (`◉ Operator`) → glyph-only (`◉`) → menu row — and
   *    open the chevron menu at the end. (Base ref: the box
   *    drops to a ghost.)
   * 4. Mobile: `beat()` on the unchanged top bar, open the chevron menu and
   *    select the operator row; the operator route opens.
   */
  test("the Operator button across rest, open, re-focus, draft, narrowing and mobile", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    windowId = (await resolveWindow(page, TMUX_SERVER, OPERATOR_SESSION, "operator")).windowId;
    setWindowOption(windowId, "@rk_win_role", "operator");
    const viewId = (await resolveWindow(page, TMUX_SERVER, VIEW_SESSION, undefined)).windowId;

    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(viewId)}`);
    if (isMobile) {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    } else {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    await beat(page);

    if (isMobile) {
      await expect(page.getByTestId("quake-launcher")).toHaveCount(0);
      await beat(page);
      await page.getByLabel("More controls").click();
      const menu = page.getByRole("menu", { name: "More controls" });
      await expect(menu).toBeVisible();
      await beat(page, 1_500);
      await menu.getByRole("menuitem", { name: /^(Operator|Quake terminal)/ }).click();
      // The route carries the bare window index; the origin rides `?from=`.
      await expect(page).toHaveURL(new RegExp(`/${windowId.replace(/^@/, "")}\\?from=`));
      await beat(page, 1_500);
      return;
    }

    const composeInput = page.getByTestId("quake-terminal-compose-input");
    const button = page.locator('button[data-testid="quake-launcher"]');
    if ((await button.count()) === 0) {
      // Base ref: a standing input in the center cell that swaps under the
      // pointer into a collapsed control.
      const input = page.getByTestId("quake-launcher-input");
      await expect(input).toBeVisible({ timeout: READY_TIMEOUT });
      await beat(page);
      await input.click();
      await expect(page.getByTestId("quake-terminal")).toBeVisible();
      await beat(page, 1_500);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await beat(page);
      for (const width of NARROWING_WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await beat(page, 500);
      }
      return;
    }

    // At rest: the button in the right cluster, with its tooltip.
    await expect(button).toBeVisible({ timeout: READY_TIMEOUT });
    await button.hover();
    await beat(page, 1_800);

    // Click: the drawer opens, the button latches, the compose is focused.
    await button.click();
    await expect(page.getByTestId("quake-terminal")).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(composeInput).toBeFocused();
    await beat(page, 1_500);

    // Click while open: focus returns to the compose, the drawer stays.
    await page.getByTestId("quake-terminal").locator(".xterm-screen").click({ position: { x: 10, y: 10 } });
    await expect(composeInput).not.toBeFocused();
    await beat(page);
    await button.click();
    await expect(composeInput).toBeFocused();
    await expect(page.getByTestId("quake-terminal")).toBeVisible();
    await beat(page, 1_500);

    // An unsent draft, then Esc (yield, then release): the dot shows at rest.
    await composeInput.fill("restart the worker when the build is green");
    await beat(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("quake-terminal")).toHaveCount(0);
    await expect(page.getByTestId("quake-launcher-draft")).toBeVisible();
    await button.hover();
    await beat(page, 1_800);

    // Narrow desktop widths: full → label → glyph-only → chevron-menu row.
    for (const width of NARROWING_WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await beat(page, 600);
    }
    await page.getByLabel("More controls").click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Operator/ })).toBeVisible();
    await beat(page, 2_000);
  });
});
