/**
 * Demo: the web tab strip redesign, recorded for PR evidence — the folder
 * active tab on the inset ground, the kind chip leading the address field,
 * hued page glyphs in a mixed-kind family, drafts materializing into the
 * width ladder (shrink → icon-only → scroll + trailing fade), and the ⋯
 * overflow menu's zoom stepper with its zoom chip.
 *
 * Runs only under `just demo web-tab-strip` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812 — mobile shows the reduced ↻ [address] ⋯
 * URL row and reaches the icon-only rung without a resize). slowMo paces the
 * actions and `beat()` pauses let a reviewer register each screen.
 *
 * Shared setup: beforeAll creates one session on the rig's isolated tmux
 * server; afterAll kills it. The spec's window starts with a three-tab mixed
 * family (two proxy stubs via `stubProxyPorts`, one relative path) and grows
 * to 16 slots — five through live draft materialization (the dashed folder
 * shows in the recording), the rest by restamping the family (the SSE repaint
 * grows the strip live).
 */
import { test, expect, beat } from "./_demo";
import { resolveWindow, READY_TIMEOUT } from "../e2e/_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  setWindowOption,
  stampWebTabs,
} from "../e2e/_tmux";
import { stubProxyPorts } from "../e2e/_web-tile";
import type { Page } from "@playwright/test";

const DEMO_SESSION = "demo-web-tab-strip";

const SEED_TABS = ["/proxy/3001/", "/proxy/3002/", "/tutorial/tutorial.html"];

/** The 16-slot family the ladder demo grows into (three stubbed ports with
 *  distinct paths — the strip labels read them apart). */
const FULL_TABS = Array.from({ length: 16 }, (_, i) => `/proxy/${3001 + (i % 3)}/page-${i + 1}`);

const strip = (page: Page) => page.getByTestId("web-tab-strip");
const tab = (page: Page, n: number) => page.locator(`[data-testid="web-tab"][data-index="${n}"]`);
const urlBar = (page: Page) => page.getByTestId("surface-tile-web").getByLabel("URL");

test.describe("web-tab-strip demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION);
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  /**
   * Proves: a reviewer can watch the redesigned strip end to end on both
   * viewports — folder tab, kind chip, hued glyphs, drafts in the ladder,
   * icon-only scroll with the fade, and the ⋯ zoom stepper + chip.
   *
   * Steps:
   * 1. Seed a window with the mixed three-tab family + `single:web`;
   *    navigate; wait for the strip; `beat()`.
   * 2. Select tab 1 — the folder moves and the amber `:3001 proxy` chip
   *    leads the address; select tab 3 (relative) — no chip; `beat()` each.
   * 3. Materialize five drafts from `+` (type `localhost:300N/x`, Enter) —
   *    the dashed draft folder shows, then joins the family; the strip
   *    shrinks per tab.
   * 4. Restamp the full 16-slot family — the ladder shrinks every tab; on
   *    mobile the strip goes icon-only with the trailing fade, and selecting
   *    the last tab scrolls it into view; `beat()`.
   * 5. Open ⋯, step `Zoom in` twice with the menu open, Escape, assert the
   *    `125%` chip, click it to reset; `beat()`.
   */
  test("folder tabs, the width ladder, and the ⋯ zoom stepper", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    await stubProxyPorts(page, 3001, 3002, 3003);

    newWindow(DEMO_SESSION, "tabs");
    const id = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, "tabs")).windowId;
    stampWebTabs(id, SEED_TABS, 2);
    setWindowOption(id, "@rk_win_layout", "single:web");
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    if (isMobile) {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    } else {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    await expect(strip(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page);

    // The folder follows the selection; the chip answers the active kind.
    await tab(page, 1).click();
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("web-kind-chip")).toHaveText(":3001 proxy");
    await beat(page);
    await tab(page, 3).click();
    await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("web-kind-chip")).toHaveCount(0);
    await beat(page);

    // Drafts materialize into the ladder — the strip shrinks per tab.
    for (let i = 0; i < 5; i++) {
      await page.getByTestId("web-tab-add").click();
      await expect(page.getByTestId("web-tab-draft")).toHaveCount(1);
      await beat(page, 400);
      await urlBar(page).fill(`localhost:${3001 + (i % 3)}/draft-${i + 1}`);
      await urlBar(page).press("Enter");
      await expect(page.getByTestId("web-tab")).toHaveCount(4 + i);
    }
    await beat(page);

    // The full family: the ladder shrinks every tab (desktop); on the narrow
    // mobile strip the rung is icon-only with the trailing fade, and the
    // selection scrolls into view.
    stampWebTabs(id, FULL_TABS, 1);
    await expect(page.getByTestId("web-tab")).toHaveCount(16);
    await beat(page);
    if (isMobile) {
      await expect(page.locator(".rk-web-strip-fade")).toBeVisible();
      await beat(page);
      await tab(page, 16).click();
      await expect(tab(page, 16)).toHaveAttribute("aria-selected", "true");
      await beat(page);
    }

    // The ⋯ stepper keeps the menu open while stepping; the chip resets.
    await page.getByLabel("More actions").click();
    await expect(page.getByTestId("web-overflow-menu")).toBeVisible();
    await beat(page, 600);
    await page.getByLabel("Zoom in", { exact: true }).click();
    await page.getByLabel("Zoom in", { exact: true }).click();
    await expect(page.getByLabel("Reset zoom", { exact: true })).toHaveText("125%");
    await beat(page, 600);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("web-zoom-chip")).toHaveText("125%");
    await beat(page);
    await page.getByTestId("web-zoom-chip").click();
    await expect(page.getByTestId("web-zoom-chip")).toHaveCount(0);
    await beat(page);
  });
});
