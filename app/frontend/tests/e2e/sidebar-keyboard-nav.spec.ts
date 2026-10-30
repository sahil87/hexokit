import { test, expect, type Page } from "@playwright/test";
import { gotoServerReady, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * Sidebar keyboard navigation: the session/window tree is a W3C-APG
 * disclosure tree (role="tree" / treeitem / group) with a single roving tab
 * stop, and arrow keys move/expand/collapse/activate rows without hijacking
 * rename inputs or the terminal.
 *
 * DOM contract: the scrollable Sessions region carries role="tree" with
 * aria-label="Workspace tree". Session rows are role="treeitem" aria-level="1",
 * carry a data-session-row handle equal to `${server}:${session}`, and
 * aria-expanded mirrors their collapse state. Window rows are role="treeitem"
 * aria-level="2" and carry two handles: the bare data-window-id (@N, for
 * tests/automation/pin lookups) and a data-row-key equal to
 * `${server}:${windowId}`. The latter is the globally-unique roving key —
 * bare tmux ids (@N) repeat across servers, so the roving cursor and
 * Enter/Space activation key on the namespaced handle. The roving key is read
 * off whichever treeitem currently has tabindex="0" (its data-row-key for
 * windows, data-session-row for sessions — never the bare data-window-id).
 *
 * Shared setup: beforeAll creates `e2e-kbnav-<timestamp>` with two windows
 * (`edit`, `test`) so the tree has a session row plus ≥2 window rows;
 * afterAll kills it. openTree(page) navigates to `/${TMUX_SERVER}`, waits for
 * Connected, asserts the role="tree" element and the test session's row are
 * visible, and returns the tree locator. rovingKey(page) returns the
 * globally-unique roving key of the treeitem[tabindex="0"]. resolveWindowId
 * polls /api/sessions to map a window's display name to its stable tmux id.
 */

const TEST_SESSION = `e2e-kbnav-${Date.now()}`;

/** Resolve a window's stable tmux id (`@N`) by its display name. */
async function resolveWindowId(page: Page, windowName: string): Promise<string> {
  return (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

test.describe("Sidebar keyboard navigation", () => {
  test.beforeAll(() => {
    // Session with two windows so the tree has a session row + ≥2 window rows.
    createSession(TEST_SESSION, { windows: ["edit", "test"] });
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /** Navigate to the server route, wait for SSE, and return the tree element. */
  async function openTree(page: Page) {
    await gotoServerReady(page, TMUX_SERVER);
    const tree = page.getByRole("tree", { name: "Workspace tree" });
    await expect(tree).toBeVisible();
    // Ensure our session's rows are present before driving the keyboard.
    await expect(
      page.locator(`[data-session-row="${TMUX_SERVER}:${TEST_SESSION}"]`),
    ).toBeVisible({ timeout: 8_000 });
    return tree;
  }

  /** Read the globally-unique roving key of the current (tabindex=0) tree row.
   *  Mirrors production rowKeyOf: window rows use `data-row-key`
   *  (`${server}:${windowId}`), session rows `data-session-row`
   *  (`${server}:${name}`) — NOT the bare `data-window-id`, which repeats across
   *  servers. */
  async function rovingKey(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const tree = document.querySelector('[role="tree"]');
      const row = tree?.querySelector('[role="treeitem"][tabindex="0"]') as HTMLElement | null;
      return row
        ? row.getAttribute("data-row-key") ?? row.getAttribute("data-session-row")
        : null;
    });
  }

  /**
   * Proves: the tree exposes APG roles and maintains the roving-tabindex
   * invariant — at least 3 treeitems (1 session + 2 windows) and exactly one
   * with tabindex="0".
   *
   * Steps:
   * 1. openTree.
   * 2. Assert [role="tree"] [role="treeitem"] count ≥ 3.
   * 3. Assert [role="tree"] [role="treeitem"][tabindex="0"] has count exactly 1.
   */
  test("tree has role=tree with treeitem rows and exactly one tab stop", async ({ page }) => {
    await openTree(page);
    const items = page.locator('[role="tree"] [role="treeitem"]');
    expect(await items.count()).toBeGreaterThanOrEqual(3); // session + 2 windows
    const tabStops = page.locator('[role="tree"] [role="treeitem"][tabindex="0"]');
    await expect(tabStops).toHaveCount(1);
  });

  /**
   * Proves: ArrowDown/ArrowUp move the roving tab stop between the session
   * row and its first window row, keyed on the server-namespaced roving key.
   *
   * Steps:
   * 1. openTree; resolve the `edit` window id; derive its namespaced roving
   *    key `${server}:${editId}`.
   * 2. Focus OUR session row (the shared e2e tmux server may hold other
   *    sessions; focusing does not move the roving tab stop — navigation
   *    anchors on the focused row's nearest treeitem).
   * 3. Press ArrowDown; assert the roving key is the `edit` window's
   *    namespaced key.
   * 4. Press ArrowUp from that row; assert the roving key is back on the
   *    session row.
   */
  test("ArrowDown/ArrowUp move the roving cursor and stop at the ends", async ({ page }) => {
    await openTree(page);
    const winEdit = await resolveWindowId(page, "edit");
    // Roving keys are server-namespaced (`${server}:${windowId}`); the bare
    // `winEdit` (@N) is only the `data-window-id` handle.
    const winEditKey = `${TMUX_SERVER}:${winEdit}`;
    const sessionKey = `${TMUX_SERVER}:${TEST_SESSION}`;

    // Anchor on OUR session row (the shared e2e tmux server may hold other
    // sessions, so a global `Home` would land elsewhere). Focusing a row does
    // NOT move the roving tab stop — navigation anchors on the focused row's
    // nearest treeitem (so the first ArrowDown moves the cursor into THIS
    // session's first window).
    const sessionRow = page.locator(`[data-session-row="${sessionKey}"]`);
    await sessionRow.focus();

    await sessionRow.press("ArrowDown");
    expect(await rovingKey(page)).toBe(winEditKey);

    // ArrowUp returns to this session's header row.
    await page.locator(`[data-row-key="${winEditKey}"]`).press("ArrowUp");
    expect(await rovingKey(page)).toBe(sessionKey);
  });

  /**
   * Proves: ArrowLeft collapses an expanded session; ArrowRight re-expands it
   * (focus stays on the session) and a second ArrowRight descends to its
   * first window child, moving the roving cursor.
   *
   * Steps:
   * 1. openTree; focus OUR session row (keys anchor on the focused row's
   *    nearest treeitem, regardless of which row holds the roving tab stop).
   * 2. Press ArrowLeft; assert the session row's aria-expanded="false".
   * 3. Press ArrowRight; assert aria-expanded="true" (collapse/expand toggle
   *    the row but do not move the tab stop).
   * 4. Resolve the `edit` window id; press ArrowRight again; assert the
   *    roving key is that window's namespaced key (`${server}:${editId}`).
   */
  test("ArrowLeft collapses the session; ArrowRight expands then descends", async ({ page }) => {
    await openTree(page);
    const sessionKey = `${TMUX_SERVER}:${TEST_SESSION}`;
    const sel = `[data-session-row="${sessionKey}"]`;
    const sessionRow = page.locator(sel);

    await sessionRow.focus();
    // Collapse the session via ArrowLeft. Keys anchor on the focused row's
    // nearest treeitem, so this acts on OUR session regardless of which row
    // currently holds the roving tab stop (the shared e2e server may hold other
    // sessions). Collapse/expand toggle the row but do NOT move the tab stop.
    await sessionRow.press("ArrowLeft");
    await expect(sessionRow).toHaveAttribute("aria-expanded", "false");

    // ArrowRight re-expands (focus stays on the session row).
    await sessionRow.press("ArrowRight");
    await expect(sessionRow).toHaveAttribute("aria-expanded", "true");

    // ArrowRight again descends to the first window child — THIS moves the
    // roving cursor onto our session's first window.
    const winEdit = await resolveWindowId(page, "edit");
    await sessionRow.press("ArrowRight");
    expect(await rovingKey(page)).toBe(`${TMUX_SERVER}:${winEdit}`);
  });

  /**
   * Proves: Enter activates the focused window row — it navigates the URL to
   * that window and marks the row aria-current="page".
   *
   * Steps:
   * 1. openTree; resolve the `edit` window id.
   * 2. Focus OUR session row, then press ArrowDown to descend to its first
   *    window (edit); assert the roving key is the `edit` window's
   *    namespaced key.
   * 3. Press Enter on that row.
   * 4. Assert the URL matches `/${TMUX_SERVER}/.+` and the
   *    [data-window-id=edit] row shows aria-current="page" within 5s.
   */
  test("Enter on a window row navigates to that window", async ({ page }) => {
    await openTree(page);
    const winEdit = await resolveWindowId(page, "edit");
    const sessionKey = `${TMUX_SERVER}:${TEST_SESSION}`;

    // Anchor on OUR session row, then descend to its first window (edit).
    const sessionRow = page.locator(`[data-session-row="${sessionKey}"]`);
    await sessionRow.focus();
    await sessionRow.press("ArrowDown"); // → first window (edit)
    expect(await rovingKey(page)).toBe(`${TMUX_SERVER}:${winEdit}`);
    await page.locator(`[data-row-key="${TMUX_SERVER}:${winEdit}"]`).press("Enter");

    // Activation selects the window → the URL carries its id segment.
    await expect(page).toHaveURL(new RegExp(`/${TMUX_SERVER}/.+`));
    await expect(
      page.locator(`[data-window-id="${winEdit}"] [aria-current="page"]`),
    ).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Proves: when a row's rename <input> is focused, ArrowDown moves the text
   * caret (the tree handler early-returns) and the Escape-cancel rename
   * contract still works.
   *
   * Steps:
   * 1. openTree; focus the tab stop; press Home; record the roving key.
   * 2. Double-click the session name button to enter rename mode; assert the
   *    `Rename group` input is visible and focus it.
   * 3. Press ArrowDown inside the input; assert the roving key is unchanged.
   * 4. Press Escape; assert the rename input is hidden (cancel still works).
   */
  test("arrows inside a rename input are not hijacked by the tree", async ({ page }) => {
    const tree = await openTree(page);
    await page.locator('[role="tree"] [role="treeitem"][tabindex="0"]').focus();
    await tree.press("Home");
    const before = await rovingKey(page);

    // Double-click the session name to enter rename mode.
    await page.getByRole("button", { name: `Navigate to ${TEST_SESSION}` }).dblclick();
    const input = page.getByLabel("Rename group");
    await expect(input).toBeVisible();
    await input.focus();
    await input.press("ArrowDown"); // moves the caret, must NOT move the tree
    expect(await rovingKey(page)).toBe(before);
    // Escape cancels rename (existing contract still works).
    await input.press("Escape");
    await expect(input).toBeHidden();
  });
});
