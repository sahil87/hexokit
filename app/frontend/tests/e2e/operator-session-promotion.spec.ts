import { test, expect } from "@playwright/test";
import { gotoServerReady, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Operator session physical promotion. Promote moves the window's membership
// OUT of its work session into the hidden _rk-operator session (so tmux
// window-cycling no longer jumps to it) while its sidebar row stays pinned
// above the groups; demote moves it back out to a visible conventional
// session.
//
// Shared setup: own session `e2e-oppromote-<epoch>` created in beforeAll
// (isolated rk-test-e2e tmux server; fullyParallel: false), torn down in
// afterAll along with _rk-operator. Viewport: default desktop. All role
// changes go through the same POST /api/windows/{windowId}/options
// partial-merge route the palette client uses (@rk_win_role: "operator" to
// set, null to clear), never a client-side shortcut.
const TEST_SESSION = `e2e-oppromote-${Date.now()}`;
const OPERATOR_SESSION = "_rk-operator";

/** POST the partial-merge window-options body the palette client uses. */
async function setRole(
  page: Parameters<typeof gotoServerReady>[0],
  windowId: string,
  role: string | null,
) {
  return page.request.post(
    `/api/windows/${encodeURIComponent(windowId)}/options?server=${encodeURIComponent(TMUX_SERVER)}`,
    { data: { options: { "@rk_win_role": role } } },
  );
}

test.describe("Operator session physical promotion (skcr)", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
    killSession(OPERATOR_SESSION);
  });

  /**
   * Proves: the three user-visible behaviors — (1) after promote, the work
   * session's group no longer contains the operator window (membership moved
   * ⇒ tmux window-cycling no longer jumps to it) and no _rk-operator session
   * group appears (content-hidden); (2) the pinned operator row still renders
   * once above the groups and, like every other sidebar row, navigates to the
   * operator window's own terminal route on activation — no quake terminal overlay
   * opens; (3) after demote, the window reappears under a visible
   * conventional session group, no longer pinned.
   *
   * Steps:
   * 1. Create a sibling `worker-<ts>` window (keeps the work session alive
   *    after the move) and the operator window `operator-<ts>`; open the
   *    server page and resolve the operator window's id.
   * 2. Assert the fresh operator window renders once inside its work-session
   *    group, and no _rk-operator session group exists.
   * 3. Promote: POST @rk_win_role: "operator"; assert it succeeds.
   * 4. Assert the work group no longer lists the operator window (count 0),
   *    no _rk-operator session group renders, and the pinned operator row
   *    renders exactly once ABOVE the work group (smaller y).
   * 5. Click the pinned row; assert it navigates to the operator window's
   *    terminal route exactly like an ordinary row (the rename-tab button for
   *    that window becomes visible) and no quake terminal overlay opens.
   * 6. Demote: POST @rk_win_role: null; assert it succeeds.
   * 7. Assert no _rk-operator session group renders, and the window reappears
   *    under a visible session group exactly once (no longer the pinned
   *    slot).
   */
  test("promote hides the operator session + moves the window out of its work group; pinned row navigates like a normal row; demote reappears under a visible group", async ({
    page,
  }) => {
    const ts = Date.now();
    const opName = `operator-${ts}`;
    // A sibling keeps the work session alive after the operator window moves out.
    newWindow(TEST_SESSION, `worker-${ts}`);
    newWindow(TEST_SESSION, opName);

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");
    const target = await resolveWindow(page, TMUX_SERVER, TEST_SESSION, opName);
    const row = sidebar.locator(`[data-window-id="${target.windowId}"]`);
    const workGroupRow = page.locator(
      `[data-session-group="${TEST_SESSION}"] [data-window-id="${target.windowId}"]`,
    );

    // Fresh window: an ordinary row inside its work group; no operator session.
    await expect(row).toHaveCount(1, { timeout: 5_000 });
    await expect(workGroupRow).toHaveCount(1);
    await expect(page.locator(`[data-session-group="${OPERATOR_SESSION}"]`)).toHaveCount(0);

    // Promote via the same options POST route the palette commands use.
    const setRes = await setRole(page, target.windowId, "operator");
    expect(setRes.ok(), "setting @rk_win_role=operator via the options API").toBeTruthy();

    // The work group no longer lists the operator window (membership MOVED,
    // so tmux window-cycling traverses only the remaining windows — the
    // traversal-order fix is exactly this membership change).
    await expect(workGroupRow).toHaveCount(0, { timeout: 6_000 });
    // The content-hidden operator session renders no session group …
    await expect(page.locator(`[data-session-group="${OPERATOR_SESSION}"]`)).toHaveCount(0);
    // … but the pinned operator row still renders exactly once, above the work group.
    await expect(row).toHaveCount(1);
    const rowBox = await row.boundingBox();
    const workBox = await page.locator(`[data-session-group="${TEST_SESSION}"]`).boundingBox();
    expect(rowBox, "pinned row box").toBeTruthy();
    expect(workBox, "work group box").toBeTruthy();
    expect(rowBox!.y).toBeLessThan(workBox!.y);

    // Row activation is ordinary navigation to the operator window's terminal
    // route — no quake terminal overlay opens.
    await row.click();
    await expect(page.getByRole("button", { name: `Rename tab ${opName}` })).toBeVisible();
    await expect(page.getByTestId("quake-terminal")).toHaveCount(0);

    // Demote (null per the partial-merge contract): the window moves OUT to a
    // visible conventional session group and the pinned slot disappears.
    const clearRes = await setRole(page, target.windowId, null);
    expect(clearRes.ok(), "clearing @rk_win_role via the options API").toBeTruthy();
    await expect(page.locator(`[data-session-group="${OPERATOR_SESSION}"]`)).toHaveCount(0, {
      timeout: 6_000,
    });
    // The window reappears under a visible session group (its cwd-basename
    // session) — exactly once, no longer pinned.
    await expect(row).toHaveCount(1, { timeout: 6_000 });
    const reappearedGroup = page.locator(
      `[data-session-group] [data-window-id="${target.windowId}"]`,
    );
    await expect(reappearedGroup).toHaveCount(1);
  });
});
