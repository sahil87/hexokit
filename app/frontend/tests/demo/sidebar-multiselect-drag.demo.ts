/**
 * Demo: drag a multi-selected sidebar tab set as one block, recorded for PR
 * evidence. Desktop only because HTML5 sidebar drag is a fine-pointer gesture.
 *
 * Shared setup: beforeAll creates a five-window source session and a one-window
 * destination on the isolated demo tmux server; afterAll removes both. The flow
 * selects bravo and delta, drags bravo before alpha to form a contiguous block,
 * verifies tmux order, then drags the still-selected set onto the destination
 * group and waits for the aggregate move toast and both rows to repaint there.
 */
import { test, expect, beat, desktopOnly } from "./_demo";
import { gotoServerReady, resolveWindow, READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, listWindows } from "../e2e/_tmux";

const SOURCE_SESSION = "demo-multiselect-drag-src";
const DESTINATION_SESSION = "demo-multiselect-drag-dst";
const WINDOWS = ["alpha", "bravo", "charlie", "delta", "echo"];

function rowKey(windowId: string): string {
  return `${TMUX_SERVER}:${windowId}`;
}

test.describe("sidebar-multiselect-drag demo", () => {
  test.beforeAll(() => {
    createSession(SOURCE_SESSION, { windows: WINDOWS });
    createSession(DESTINATION_SESSION, { windows: ["keep"] });
  });

  test.afterAll(() => {
    killSession(SOURCE_SESSION);
    killSession(DESTINATION_SESSION);
  });

  test("selected tabs reorder as a block and move groups together", async ({ page }, info) => {
    desktopOnly(info);
    await page.goto("/");
    const ids: Record<string, string> = {};
    for (const name of WINDOWS) {
      ids[name] = (await resolveWindow(page, TMUX_SERVER, SOURCE_SESSION, name)).windowId;
    }
    await gotoServerReady(page, TMUX_SERVER);
    const row = (id: string) => page.locator(`[data-row-key="${rowKey(id)}"]`);
    await expect(row(ids.alpha)).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 1_000);

    for (const id of [ids.bravo, ids.delta]) {
      await row(id).locator("button").first().click({ modifiers: ["ControlOrMeta"] });
      await beat(page);
    }
    await beat(page, 1_000);

    await row(ids.bravo).dragTo(row(ids.alpha));
    await expect.poll(() => listWindows(SOURCE_SESSION).map((win) => win.windowId)).toEqual([
      ids.bravo,
      ids.delta,
      ids.alpha,
      ids.charlie,
      ids.echo,
    ]);
    await beat(page, 2_000);

    await row(ids.bravo).dragTo(
      page.locator(`[data-session-row="${TMUX_SERVER}:${DESTINATION_SESSION}"]`),
    );
    await expect(page.getByText(`Moved 2 tabs to ${DESTINATION_SESSION}`)).toBeVisible();
    for (const id of [ids.bravo, ids.delta]) {
      await expect(page.locator(
        `[data-session-group="${DESTINATION_SESSION}"] [data-row-key="${rowKey(id)}"]`,
      )).toBeVisible({ timeout: 15_000 });
    }
    await beat(page, 2_000);
  });
});
