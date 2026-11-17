import { test, expect, type Page } from "@playwright/test";
import { gotoServerReady, resolveWindow } from "./_ready";
import { pinWindow, trackPin, unpinAll } from "./_boards";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

/**
 * Multi-selected sidebar tab drags against the real backend and isolated e2e
 * tmux server. Each test receives newly-created source and destination sessions
 * so a group move, block reorder, or board pin cannot affect another case;
 * afterEach removes both sessions and any registered board pins. The source
 * fixture contains five named windows, and the destination contains `keep`.
 * Tests use Playwright's native dragTo on the same draggable treeitem roots a
 * pointer user grabs, with ControlOrMeta clicks establishing the selection.
 * Board setup pins `keep` through the HTTP API solely to make the board row
 * visible; cleanup uses the shared pin registry.
 */
const STAMP = Date.now();
const WINDOWS = ["alpha", "bravo", "charlie", "delta", "echo"];
let sequence = 0;
let sourceSession = "";
let destinationSession = "";
let boardName = "";

function rowKey(windowId: string): string {
  return `${TMUX_SERVER}:${windowId}`;
}

async function openTree(page: Page) {
  await gotoServerReady(page, TMUX_SERVER);
  await expect(page.locator(`[data-session-row="${TMUX_SERVER}:${sourceSession}"]`)).toBeVisible();
  await expect(page.locator(`[data-session-row="${TMUX_SERVER}:${destinationSession}"]`)).toBeVisible();
}

async function sourceIds(page: Page) {
  const ids: Record<string, string> = {};
  for (const name of WINDOWS) {
    ids[name] = (await resolveWindow(page, TMUX_SERVER, sourceSession, name)).windowId;
  }
  return ids;
}

async function selectRows(page: Page, windowIds: string[]) {
  for (const id of windowIds) {
    await page.locator(`[data-row-key="${rowKey(id)}"] button`).first().click({
      modifiers: ["ControlOrMeta"],
    });
  }
  await expect(page.getByTestId("selection-indicator")).toContainText(`${windowIds.length} selected`);
}

test.describe("Sidebar multi-selected tab drag", () => {
  test.beforeEach(() => {
    sequence++;
    sourceSession = `e2e-msdrag-src-${STAMP}-${sequence}`;
    destinationSession = `e2e-msdrag-dst-${STAMP}-${sequence}`;
    boardName = `msdrag-${STAMP}-${sequence}`;
    createSession(sourceSession, { windows: WINDOWS });
    createSession(destinationSession, { windows: ["keep"] });
  });

  test.afterEach(async ({ request }) => {
    await unpinAll(request);
    killSession(sourceSession);
    killSession(destinationSession);
  });

  /**
   * Proves: dragging one member of a two-tab selection onto a group row moves
   * both tabs into that tmux session and preserves the selection for another
   * gesture.
   *
   * Steps:
   * 1. Open the tree, resolve alpha/bravo, and select both rows.
   * 2. Drag alpha onto the destination group row.
   * 3. Assert one aggregate move toast and a surviving two-tab selection.
   * 4. Poll tmux until both ids belong to the destination and neither remains
   *    in the source session.
   */
  test("set drop on a group row moves every selected tab", async ({ page }) => {
    test.setTimeout(45_000);
    await openTree(page);
    const ids = await sourceIds(page);
    await selectRows(page, [ids.alpha, ids.bravo]);

    await page.locator(`[data-row-key="${rowKey(ids.alpha)}"]`).dragTo(
      page.locator(`[data-session-row="${TMUX_SERVER}:${destinationSession}"]`),
    );

    await expect(page.getByText(`Moved 2 tabs to ${destinationSession}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");
    await expect.poll(() => {
      const destination = new Set(listWindows(destinationSession).map((win) => win.windowId));
      return [ids.alpha, ids.bravo].every((id) => destination.has(id));
    }, { timeout: 15_000 }).toBe(true);
    const source = listWindows(sourceSession).map((win) => win.windowId);
    expect(source).not.toContain(ids.alpha);
    expect(source).not.toContain(ids.bravo);
  });

  /**
   * Proves: dropping a selected set before another window sends the set through
   * the block-move endpoint and produces one contiguous block in payload order
   * while non-members keep their relative order.
   *
   * Steps:
   * 1. Open the tree, resolve all five ids, and select bravo and delta.
   * 2. Drag bravo before alpha.
   * 3. Poll tmux until the exact order is bravo, delta, alpha, charlie, echo.
   */
  test("set drop between rows moves the selection as a contiguous block", async ({ page }) => {
    test.setTimeout(45_000);
    await openTree(page);
    const ids = await sourceIds(page);
    await selectRows(page, [ids.bravo, ids.delta]);

    await page.locator(`[data-row-key="${rowKey(ids.bravo)}"]`).dragTo(
      page.locator(`[data-row-key="${rowKey(ids.alpha)}"]`),
    );

    await expect.poll(() => listWindows(sourceSession).map((win) => win.windowId), {
      timeout: 15_000,
    }).toEqual([ids.bravo, ids.delta, ids.alpha, ids.charlie, ids.echo]);
  });

  /**
   * Proves: a board-row drop pins every selected tab and reports one aggregate
   * toast rather than one toast per tab.
   *
   * Steps:
   * 1. Pin the destination's keep tab to create the board, then open the tree.
   * 2. Select alpha/bravo and drag alpha onto the board row.
   * 3. Assert the single `Pinned 2 tabs` toast.
   * 4. Poll the board API until both selected ids are pinned.
   */
  test("set drop on a board row pins every selected tab", async ({ page }) => {
    test.setTimeout(45_000);
    const keep = (await resolveWindow(page, TMUX_SERVER, destinationSession, "keep")).windowId;
    await pinWindow(page.request, boardName, TMUX_SERVER, keep);
    trackPin({ board: boardName, server: TMUX_SERVER, windowId: keep });
    await openTree(page);
    const ids = await sourceIds(page);
    await selectRows(page, [ids.alpha, ids.bravo]);
    const boardRow = page.getByText(boardName, { exact: true }).locator("..");
    await expect(boardRow).toBeVisible();

    await page.locator(`[data-row-key="${rowKey(ids.alpha)}"]`).dragTo(boardRow);

    await expect(page.getByText(`Pinned 2 tabs to ${boardName}`)).toBeVisible({ timeout: 15_000 });
    for (const id of [ids.alpha, ids.bravo]) {
      trackPin({ board: boardName, server: TMUX_SERVER, windowId: id });
    }
    await expect.poll(async () => {
      const response = await page.request.get(`/api/boards/${boardName}`);
      const entries = await response.json() as Array<{ windowId: string }>;
      const pinned = new Set(entries.map((entry) => entry.windowId));
      return [ids.alpha, ids.bravo].every((id) => pinned.has(id));
    }, { timeout: 15_000 }).toBe(true);
  });
});
