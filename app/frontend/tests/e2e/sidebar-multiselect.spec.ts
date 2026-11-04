import { test, expect, type Page } from "@playwright/test";
import { gotoServerReady, openPalette, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

/**
 * Sidebar window-row multi-select + palette bulk actions: the session/window
 * tree is a W3C-APG multiselect tree whose window rows can be gathered into a
 * set by Cmd/Ctrl-click, Shift-click range, and the `x` key, cleared by
 * Escape, and then moved, closed after an in-palette confirmation, or
 * addressed through the docked compose strip in one palette workflow.
 *
 * DOM contract: the tree (role="tree", aria-label="Workspace tree") carries
 * aria-multiselectable="true". A selected window row is its role="treeitem"
 * with aria-selected="true"; selection membership is keyed by the row's
 * globally unique data-row-key (`${server}:${windowId}`) — the same handle
 * the roving cursor uses, since bare tmux ids (@N) repeat across servers.
 * Session rows and server headers are never selectable and never carry
 * aria-selected. The selection count indicator
 * (data-testid="selection-indicator") is a non-interactive role="status"
 * strip that exists in the DOM only while the selection is non-empty, so an
 * empty selection asserts toHaveCount(0). A row's clickable select target is
 * the first <button> inside the treeitem (the left-edge label zone and the
 * right-hand icon cluster are separate targets).
 *
 * Shared setup: beforeAll creates two per-run sessions on the isolated e2e
 * tmux server — `e2e-msel-<timestamp>` with five windows (`alpha`, `beta`,
 * `gamma`, `close-one`, `close-two`) as the range/move/close source, and
 * `e2e-mseldst-<timestamp>` with one window (`keep`) as the move target and a
 * second prompt recipient; afterAll kills both. Per-run names keep the shared
 * e2e server's other sessions out of the way. openTree(page) navigates to
 * `/${TMUX_SERVER}`, waits for Connected, and asserts both session rows are
 * rendered before any gesture is driven. windowIds / closeWindowIds resolve
 * display names to stable tmux ids (@N) from the /api/sessions snapshot (the
 * close pair is resolved only before the destructive close workflow).
 * rowKey(windowId) composes the `${server}:${windowId}` selection key;
 * selectedKeys(page) reads the data-row-key of every
 * treeitem[aria-selected="true"] currently in the tree.
 */
const STAMP = Date.now();
const SRC_SESSION = `e2e-msel-${STAMP}`;
const DST_SESSION = `e2e-mseldst-${STAMP}`;

/** The globally-unique roving/selection key for a window row. */
function rowKey(windowId: string): string {
  return `${TMUX_SERVER}:${windowId}`;
}

test.describe("Sidebar window-row multi-select", () => {
  test.beforeAll(() => {
    // The first three preserve the range/move fixtures; the final pair is
    // reserved for the destructive close test so later tests keep live panes.
    createSession(SRC_SESSION, {
      windows: ["alpha", "beta", "gamma", "close-one", "close-two"],
    });
    createSession(DST_SESSION, { windows: ["keep"] });
  });

  test.afterAll(() => {
    killSession(SRC_SESSION);
    killSession(DST_SESSION);
  });

  /** Navigate to the server route and wait for both sessions' rows to render. */
  async function openTree(page: Page) {
    await gotoServerReady(page, TMUX_SERVER);
    const tree = page.getByRole("tree", { name: "Workspace tree" });
    await expect(tree).toBeVisible();
    await expect(
      page.locator(`[data-session-row="${TMUX_SERVER}:${SRC_SESSION}"]`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator(`[data-session-row="${TMUX_SERVER}:${DST_SESSION}"]`),
    ).toBeVisible({ timeout: 10_000 });
    return tree;
  }

  /** Resolve the source session's three window ids from the backend snapshot. */
  async function windowIds(page: Page) {
    return {
      alpha: (await resolveWindow(page, TMUX_SERVER, SRC_SESSION, "alpha")).windowId,
      beta: (await resolveWindow(page, TMUX_SERVER, SRC_SESSION, "beta")).windowId,
      gamma: (await resolveWindow(page, TMUX_SERVER, SRC_SESSION, "gamma")).windowId,
    };
  }

  /** Resolve the pair reserved for the destructive confirmed-close test. */
  async function closeWindowIds(page: Page) {
    return {
      one: (await resolveWindow(page, TMUX_SERVER, SRC_SESSION, "close-one"))
        .windowId,
      two: (await resolveWindow(page, TMUX_SERVER, SRC_SESSION, "close-two"))
        .windowId,
    };
  }

  /** The set of currently `aria-selected` window rows, as roving keys. */
  async function selectedKeys(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[role="tree"] [role="treeitem"][aria-selected="true"]'),
      ).map((el) => el.getAttribute("data-row-key") ?? ""),
    );
  }

  /**
   * Proves: the tree advertises the multiselect model to assistive tech, and
   * the resting state carries no selection and no indicator chrome.
   *
   * Steps:
   * 1. openTree.
   * 2. Assert the tree element has aria-multiselectable="true".
   * 3. Assert no treeitem carries aria-selected="true".
   * 4. Assert [data-testid="selection-indicator"] has count 0.
   */
  test("the tree declares aria-multiselectable and starts with nothing selected", async ({
    page,
  }) => {
    const tree = await openTree(page);
    await expect(tree).toHaveAttribute("aria-multiselectable", "true");
    expect(await selectedKeys(page)).toEqual([]);
    // The count indicator is absent while the selection is empty.
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);
  });

  /**
   * Proves: a modifier-click is a selection gesture, not a navigation one —
   * the row joins the selection, the URL does not change, the count indicator
   * appears, and a second modifier-click removes the row again.
   *
   * Steps:
   * 1. openTree; resolve the `alpha` window id; record the current URL.
   * 2. Click `alpha`'s row button with the ControlOrMeta modifier.
   * 3. Assert the row has aria-selected="true" and the URL is unchanged.
   * 4. Assert the selection indicator reads `1 selected`.
   * 5. Modifier-click the same row again; assert aria-selected="false" and
   *    that the indicator is gone.
   */
  test("Cmd-click toggles a window row's selection without navigating", async ({ page }) => {
    await openTree(page);
    const { alpha } = await windowIds(page);
    const urlBefore = page.url();
    const row = page.locator(`[data-row-key="${rowKey(alpha)}"]`);

    // Modifier-click the row's select button — the row does NOT navigate.
    await row.locator("button").first().click({ modifiers: ["ControlOrMeta"] });
    await expect(row).toHaveAttribute("aria-selected", "true");
    expect(page.url()).toBe(urlBefore);

    // The count indicator appears and reports 1.
    await expect(page.getByTestId("selection-indicator")).toContainText("1 selected");

    // A second modifier-click removes it again.
    await row.locator("button").first().click({ modifiers: ["ControlOrMeta"] });
    await expect(row).toHaveAttribute("aria-selected", "false");
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);
  });

  /**
   * Proves: Shift-click selects the whole inclusive run between the anchor
   * and the clicked row in visible-row order — including the middle row the
   * user never clicked.
   *
   * Steps:
   * 1. openTree; resolve `alpha`, `beta`, `gamma`.
   * 2. Modifier-click `alpha` (this sets the range anchor).
   * 3. Shift-click `gamma`.
   * 4. Assert all three rows carry aria-selected="true".
   * 5. Assert the indicator reads `3 selected`.
   */
  test("Shift-click extends a contiguous range from the anchor", async ({ page }) => {
    await openTree(page);
    const { alpha, beta, gamma } = await windowIds(page);

    // Anchor on alpha, then shift-click gamma → alpha, beta, gamma all selected.
    await page
      .locator(`[data-row-key="${rowKey(alpha)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await page
      .locator(`[data-row-key="${rowKey(gamma)}"] button`)
      .first()
      .click({ modifiers: ["Shift"] });

    for (const id of [alpha, beta, gamma]) {
      await expect(page.locator(`[data-row-key="${rowKey(id)}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    await expect(page.getByTestId("selection-indicator")).toContainText("3 selected");
  });

  /**
   * Proves: the keyboard path works without a pointer — `x` on a focused
   * window row toggles it, `x` on a session row is a no-op (sessions are not
   * selectable), and Escape inside the tree clears the whole selection.
   *
   * Steps:
   * 1. openTree; resolve `alpha` and `beta`.
   * 2. Focus `alpha`'s treeitem; press `x`; assert aria-selected="true".
   * 3. Focus the source session row; press `x`; assert the selected set is
   *    still exactly [alpha] — the session row was not selected.
   * 4. Focus `alpha`; press `x` (deselects), then `x` again (reselects).
   * 5. Focus `beta`; press `x`; assert the indicator reads `2 selected`.
   * 6. Press Escape from `beta`; assert no row is aria-selected and the
   *    indicator is gone.
   */
  test("`x` toggles the focused row and Escape clears the selection", async ({ page }) => {
    await openTree(page);
    const { alpha, beta } = await windowIds(page);
    const alphaRow = page.locator(`[data-row-key="${rowKey(alpha)}"]`);
    const sessionRow = page.locator(`[data-session-row="${TMUX_SERVER}:${SRC_SESSION}"]`);

    // Focus the alpha row itself (the treeitem) and press `x`.
    await alphaRow.focus();
    await alphaRow.press("x");
    await expect(alphaRow).toHaveAttribute("aria-selected", "true");

    // `x` on a SESSION row is a no-op — sessions are not selectable.
    await sessionRow.focus();
    await sessionRow.press("x");
    expect(await selectedKeys(page)).toEqual([rowKey(alpha)]);

    // `x` again on alpha deselects it; then re-select two rows for the clear.
    await alphaRow.focus();
    await alphaRow.press("x");
    await expect(alphaRow).toHaveAttribute("aria-selected", "false");
    await alphaRow.press("x");
    const betaRow = page.locator(`[data-row-key="${rowKey(beta)}"]`);
    await betaRow.focus();
    await betaRow.press("x");
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");

    // Escape inside the tree clears everything.
    await betaRow.press("Escape");
    expect(await selectedKeys(page)).toEqual([]);
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);
  });

  /**
   * Proves: selection liveness derives from the session data, not from which
   * rows happen to be rendered. Folding a session away hides its rows but
   * kills no window, so the selection and the count indicator survive a
   * collapse of the selected windows' own session, a collapse of an unrelated
   * session, and the subsequent re-expand. (Deriving liveness from the
   * visible-row walk instead would read "not rendered" as "gone" and silently
   * destroy the selection — including windows `Select all merged`
   * deliberately selects inside collapsed sessions.)
   *
   * Steps:
   * 1. openTree; resolve `alpha` and `beta`.
   * 2. Modifier-click both rows; assert the indicator reads `2 selected`.
   * 3. Click `Collapse <src-session>`; assert `alpha`'s row has left the DOM
   *    and the indicator still reads `2 selected`.
   * 4. Click `Collapse <dst-session>` (an unrelated signature change);
   *    assert the indicator still reads `2 selected`.
   * 5. Click `Expand <src-session>`; assert both `alpha` and `beta` are
   *    rendered again with aria-selected="true".
   * 6. Re-expand the target session so the persisted collapse state does not
   *    leak into the next test.
   */
  test("collapsing a session does not clear the selection of its still-live windows", async ({
    page,
  }) => {
    await openTree(page);
    const { alpha, beta } = await windowIds(page);

    /** The session row's collapse/expand chevron, scoped to the row itself —
     *  a bare name lookup also matches the SERVER panel's copy of the session. */
    const chevron = (session: string) =>
      page
        .locator(`[data-session-row="${TMUX_SERVER}:${session}"]`)
        .getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${session}$`) });

    await page
      .locator(`[data-row-key="${rowKey(alpha)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await page
      .locator(`[data-row-key="${rowKey(beta)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");

    // Fold the selected rows out of view. They are still live in tmux, so the
    // selection (and its count indicator) must be untouched — a visibility-keyed
    // prune would read "not rendered" as "gone" and wipe both keys here.
    await chevron(SRC_SESSION).click();
    await expect(page.locator(`[data-row-key="${rowKey(alpha)}"]`)).toHaveCount(0);
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");

    // Collapsing an UNRELATED session (another signature change the selected
    // windows had no part in) must likewise leave them alone.
    await chevron(DST_SESSION).click();
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");

    // Re-expanding shows the rows still selected.
    await chevron(SRC_SESSION).click();
    await expect(page.locator(`[data-row-key="${rowKey(alpha)}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(`[data-row-key="${rowKey(beta)}"]`)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Re-expand the unrelated session too. Each test gets a fresh page (and the
    // selection store is per-page), but the collapse state is persisted to
    // localStorage, which the following test's tree would inherit.
    await chevron(DST_SESSION).click();
    await expect(
      page.locator(`[data-session-row="${TMUX_SERVER}:${DST_SESSION}"]`),
    ).toHaveAttribute("aria-expanded", "true");
  });

  /**
   * Proves: close is destructive and therefore uses the palette's single-row
   * confirmation sub-step. Escape cancels without issuing a kill, while a
   * second Enter executes the per-window kill requests, reports one success
   * toast, clears the owned selection, and removes both windows from tmux.
   *
   * Steps:
   * 1. openTree; resolve `close-one` and `close-two`; modifier-click both rows.
   * 2. Open the palette, filter to `Selection: Close 2 tabs`, and press Enter.
   * 3. Assert the sole confirmation option reads
   *    `Close 2 tabs — Enter to confirm`.
   * 4. Press Escape; assert both ids remain in the source session and the
   *    indicator still reads `2 selected`.
   * 5. Reopen and select the close action, then press Enter on the
   *    confirmation row.
   * 6. Assert the `Closed 2 tabs` toast and an empty selection.
   * 7. Poll tmux until neither reserved id remains in the source session.
   */
  test("palette bulk close requires confirmation and closes every selected window", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await openTree(page);
    const { one, two } = await closeWindowIds(page);
    for (const id of [one, two]) {
      await page
        .locator(`[data-row-key="${rowKey(id)}"] button`)
        .first()
        .click({ modifiers: ["ControlOrMeta"] });
    }

    const actionLabel = "Selection: Close 2 tabs";
    const confirmLabel = "Close 2 tabs — Enter to confirm";
    let paletteInput = await openPalette(page);
    await paletteInput.fill(actionLabel);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: confirmLabel })).toBeVisible();

    // Escape cancels the sub-step; neither window is touched and the selection
    // remains available for the second attempt.
    await page.keyboard.press("Escape");
    const liveAfterCancel = new Set(
      listWindows(SRC_SESSION).map((win) => win.windowId),
    );
    expect(liveAfterCancel.has(one)).toBe(true);
    expect(liveAfterCancel.has(two)).toBe(true);
    await expect(page.getByTestId("selection-indicator")).toContainText(
      "2 selected",
    );

    paletteInput = await openPalette(page);
    await paletteInput.fill(actionLabel);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: confirmLabel })).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page.getByText("Closed 2 tabs")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);
    await expect
      .poll(
        () => {
          const live = new Set(
            listWindows(SRC_SESSION).map((win) => win.windowId),
          );
          return !live.has(one) && !live.has(two);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  /**
   * Proves: the prompt action opens and focuses the existing compose strip on
   * a frozen two-recipient target. A later live-selection change cannot
   * retarget it; Send reuses the window-send endpoint (submit mode) once per
   * original key, strictly sequentially, then
   * reports aggregate success and reconciles the owned keys.
   *
   * Steps:
   * 1. openTree; resolve source `gamma` and target-session `keep`; route
   *    window-send requests to a recorder that tracks concurrent handlers and
   *    returns {ok:true}.
   * 2. Modifier-click both rows and choose `Selection: Send prompt to 2
   *    agents`.
   * 3. Assert the compose target reads `2 selected` and its textarea has
   *    focus.
   * 4. Modifier-click `keep` again; assert the live indicator falls to
   *    `1 selected` while the compose target remains `2 selected`.
   * 5. Fill `run tests and report` and click Send.
   * 6. Assert `Sent prompt to 2 agents`, maximum request concurrency of one,
   *    and two ordered POSTs carrying each original window id, the tmux
   *    server query, and exactly {text:"run tests and report",mode:"submit",
   *    target:"agent"} (agent-pane targeting).
   * 7. Assert the selection indicator is gone after settlement.
   */
  test("palette prompt broadcast targets a frozen selection sequentially", async ({
    page,
  }) => {
    await openTree(page);
    const { gamma } = await windowIds(page);
    const keep = (
      await resolveWindow(page, TMUX_SERVER, DST_SESSION, "keep")
    ).windowId;

    const requests: Array<{
      server: string | null;
      windowId: string;
      body: unknown;
    }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await page.route(/\/api\/windows\/[^/]+\/send\?server=/, async (route) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const request = route.request();
      const url = new URL(request.url());
      const segments = url.pathname.split("/");
      requests.push({
        server: url.searchParams.get("server"),
        windowId: decodeURIComponent(segments[3] ?? ""),
        body: request.postDataJSON(),
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      inFlight--;
    });

    for (const id of [gamma, keep]) {
      await page
        .locator(`[data-row-key="${rowKey(id)}"] button`)
        .first()
        .click({ modifiers: ["ControlOrMeta"] });
    }
    const actionLabel = "Selection: Send prompt to 2 agents";
    const paletteInput = await openPalette(page);
    await paletteInput.fill(actionLabel);
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("compose-strip-target")).toHaveText(
      "2 selected",
    );
    const composeInput = page.getByTestId("compose-strip-input");
    await expect(composeInput).toBeFocused();

    // Mutating the live selection after opening must not retarget the frozen
    // compose recipient set or its label.
    await page
      .locator(`[data-row-key="${rowKey(keep)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("selection-indicator")).toContainText(
      "1 selected",
    );
    await expect(page.getByTestId("compose-strip-target")).toHaveText(
      "2 selected",
    );

    await composeInput.fill("run tests and report");
    await page.getByTestId("compose-strip-send").click();

    await expect(page.getByText("Sent prompt to 2 agents")).toBeVisible({
      timeout: 15_000,
    });
    expect(maxInFlight).toBe(1);
    expect(requests).toEqual([
      {
        server: TMUX_SERVER,
        windowId: gamma,
        body: { text: "run tests and report", mode: "submit", target: "agent" },
      },
      {
        server: TMUX_SERVER,
        windowId: keep,
        body: { text: "run tests and report", mode: "submit", target: "agent" },
      },
    ]);
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);
  });

  /**
   * Proves: the end-to-end sweep — select several windows, run the
   * per-target-session palette entry, and the windows actually move in tmux,
   * the success toast reports the count, the selection clears, and the rows
   * repaint under the target session via SSE.
   *
   * Steps:
   * 1. openTree; resolve `alpha` and `beta`.
   * 2. Modifier-click both rows; assert the indicator reads `2 selected`.
   * 3. Open the palette (`openPalette`), fill it with
   *    `Selection: Move 2 tabs to <dst-session>`, wait for the option to
   *    render, and press Enter.
   * 4. Assert the toast `Moved 2 tabs to <dst-session>` appears.
   * 5. Assert the selection indicator is gone (a fully successful batch
   *    clears the selection).
   * 6. Poll tmux (list-windows on the target session) until both window ids
   *    are present; assert neither remains in the source session.
   * 7. Assert both rows are now rendered inside the target session's
   *    [data-session-group] — the SSE repaint.
   */
  test("palette 'Selection: Move N tabs to <session>' bulk-moves the selection", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await openTree(page);
    const { alpha, beta } = await windowIds(page);

    // Select two of the source session's windows.
    await page
      .locator(`[data-row-key="${rowKey(alpha)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await page
      .locator(`[data-row-key="${rowKey(beta)}"] button`)
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("selection-indicator")).toContainText("2 selected");

    // Run the per-target-session palette entry.
    const label = `Selection: Move 2 tabs to ${DST_SESSION}`;
    const paletteInput = await openPalette(page);
    await paletteInput.fill(label);
    await expect(page.getByRole("option", { name: label })).toBeVisible({
      timeout: 10_000,
    });
    await page.keyboard.press("Enter");

    // Success toast, and the selection clears on a fully successful batch.
    await expect(
      page.getByText(`Moved 2 tabs to ${DST_SESSION}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("selection-indicator")).toHaveCount(0);

    // tmux-side truth: both windows now live in the target session, and neither
    // remains in the source.
    await expect
      .poll(
        () => {
          const dst = new Set(listWindows(DST_SESSION).map((w) => w.windowId));
          return [alpha, beta].every((id) => dst.has(id));
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const srcIds = listWindows(SRC_SESSION).map((w) => w.windowId);
    expect(srcIds).not.toContain(alpha);
    expect(srcIds).not.toContain(beta);

    // And the rows repaint under the target session via SSE.
    await expect(
      page.locator(
        `[data-session-group="${DST_SESSION}"] [data-row-key="${rowKey(alpha)}"]`,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(
        `[data-session-group="${DST_SESSION}"] [data-row-key="${rowKey(beta)}"]`,
      ),
    ).toBeVisible({ timeout: 15_000 });
  });
});
