/**
 * Command-palette ranking e2e, against the real composed action registry on a
 * terminal route (the widest palette: global + server + window + tile
 * families). Unit tests in `lib/palette/rank.test.ts` cover the ranking
 * rules over fixtures; this file covers what only the mounted registry can
 * show — that ranked reordering renders exactly the matched rows.
 *
 * Shared setup: own tmux session (`e2e-palrank-<ts>`) created in `beforeAll`
 * and killed in `afterAll`; each test opens the session's first window
 * resolved through the SSE snapshot (`_ready.resolveWindow`). Default project
 * viewport. Rows are read by their DOM ids, which the palette builds from
 * action ids, so a duplicate action id surfaces as a duplicate DOM id.
 */
import { test, expect, type Page } from "@playwright/test";
import { openPalette, READY_TIMEOUT, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

const TEST_SESSION = `e2e-palrank-${Date.now()}`;

const commandList = (page: Page) => page.getByRole("listbox", { name: "Commands" });

async function gotoSessionWindow(page: Page): Promise<void> {
  const { windowId } = await resolveWindow(page, TMUX_SERVER, TEST_SESSION, undefined);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.locator("[aria-label='Connected']").first()).toBeVisible({ timeout: READY_TIMEOUT });
}

async function optionIds(page: Page): Promise<string[]> {
  return commandList(page)
    .getByRole("option")
    .evaluateAll((rows) => rows.map((row) => row.id));
}

async function optionLabels(page: Page): Promise<string[]> {
  return commandList(page).getByRole("option").allTextContents();
}

test.describe("palette ranking", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: every action in the composed terminal-route palette has a unique
   * id, so React can key the ranked rows without leaving a stale row behind
   * when ranking reorders them.
   *
   * Steps:
   * 1. Open the session's window and the palette with an empty query.
   * 2. Read every option's DOM id; assert there are no duplicates.
   */
  test("the composed registry carries no duplicate action ids", async ({ page }) => {
    await gotoSessionWindow(page);
    await openPalette(page);
    const ids = await optionIds(page);
    expect(ids.length).toBeGreaterThan(0);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  /**
   * Proves: typing a query re-ranks the list to only matching rows, led by
   * the strongest match — no row from the unfiltered list lingers.
   *
   * Steps:
   * 1. Open the session's window and the palette.
   * 2. Type `split` character by character (each keystroke re-ranks).
   * 3. Assert every rendered label contains `split` and the first is a
   *    `Tab: Split …` row.
   */
  test("typing re-ranks to matching rows only, strongest first", async ({ page }) => {
    await gotoSessionWindow(page);
    const input = await openPalette(page);
    await input.pressSequentially("split");
    await expect(commandList(page).getByRole("option").first()).toContainText(/^Tab: Split/);
    const labels = await optionLabels(page);
    for (const label of labels) {
      expect(label.toLowerCase()).toContain("split");
    }
  });
});
