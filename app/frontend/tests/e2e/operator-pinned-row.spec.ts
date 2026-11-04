import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gotoServerReady, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Operator pinned row: when a window on the server carries
// @rk_win_role=operator, its sidebar row is MOVED (not copied) out of its
// session group and pinned at the top of the server's session area — directly
// below the SESSIONS header, above all session groups. A headset before the
// name identifies the role on both the row and the active tab heading. The
// pinned row does not participate in window drag-reorder (draggable="false"),
// and unmarking demotes the window out of the hidden _rk-operator session into
// the session named after its pane cwd's basename (physical promotion) — its
// row reappears there as an ordinary in-group row, with no placeholder left.
//
// Shared setup: beforeAll creates `e2e-operator-<timestamp>` so the file has
// its own isolated session (tests run sequentially — fullyParallel: false);
// afterAll kills it, plus the demote-destination session (the temp dir's
// basename) and the temp dir itself. The operator window is created with a
// unique mkdtemp cwd so its demote destination — the cwd-BASENAME session
// role-clear moves it to — is deterministic and cannot collide with a real
// session. resolveWindow(page, server, session, name) polls GET /api/sessions
// until a window with the given name appears, returning its stable tmux
// window id (@N); rows are selected by data-window-id="@N" and session groups
// carry data-session-group="<name>" wrappers. setRole(page, windowId, role)
// POSTs the partial-merge window-options body ({"options": {"@rk_win_role":
// role}}, null unsets) to POST /api/windows/{id}/options — the same route the
// palette's `Window: Mark as Operator` / `Window: Unmark Operator` commands
// use.
const TEST_SESSION = `e2e-operator-${Date.now()}`;

// The operator window gets a unique temp-dir cwd so its demote destination —
// role-clear moves the window out of `_rk-operator` into the session named
// after its active pane's cwd BASENAME, not back to its original session — is
// a deterministic, collision-free session.
const OP_CWD = mkdtempSync(join(tmpdir(), "rk-e2e-demote-"));
const DEST_SESSION = basename(OP_CWD);

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

test.describe("Operator pinned row (@rk_win_role)", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
    // The demote destination session (cwd-basename) is created by role-clear.
    killSession(DEST_SESSION);
    rmSync(OP_CWD, { recursive: true, force: true });
  });

  /**
   * Proves: marking a window as the operator via the options POST moves its
   * row out of its session group to a pinned slot above all session groups
   * with a headset identity glyph, and activating it navigates to the
   * operator's ordinary terminal route without opening the quake terminal overlay.
   * Clearing the role demotes the window to its cwd-basename session, where
   * the row loses its operator glyph but keeps the same click-to-navigate
   * behavior.
   *
   * Steps:
   * 1. Create `worker-<ts>` and `operator-<ts>` windows in the test session —
   *    the operator window with the unique temp-dir cwd.
   * 2. Navigate to the server route and wait for `Connected`.
   * 3. resolveWindow the operator window; assert its row renders exactly once
   *    inside its data-session-group wrapper without an operator glyph.
   * 4. POST @rk_win_role: "operator" to the window's /options route; assert 200.
   * 5. Assert the row is gone from the session group, still renders exactly
   *    once in the sidebar, its bounding box sits ABOVE the session group's
   *    box, is draggable="false", and carries the headset glyph.
   * 6. Click the pinned row and assert navigation to the operator window's
   *    terminal route with no quake terminal overlay.
   * 7. POST @rk_win_role: null (the partial-merge unset); assert 200.
   * 8. Assert the row reappears inside the DESTINATION session group (the
   *    temp dir's basename), is absent from the original test session's
   *    group, still renders exactly once below the destination group header,
   *    and no longer carries the headset glyph.
   * 9. Navigate away to the bare server route and assert the operator tab
   *    heading is absent.
   * 10. Click the demoted row and assert fresh navigation to the same terminal
   *     route with no quake terminal overlay.
   */
  test("marking a window operator pins its row above the session groups and removes it from its own group; unmarking restores", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    const ts = Date.now();
    const opName = `operator-${ts}`;
    newWindow(TEST_SESSION, `worker-${ts}`);
    newWindow(TEST_SESSION, opName, { cwd: OP_CWD });

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");
    const target = await resolveWindow(page, TMUX_SERVER, TEST_SESSION, opName);
    const row = sidebar.locator(`[data-window-id="${target.windowId}"]`);
    const groupRow = page.locator(
      `[data-session-group="${TEST_SESSION}"] [data-window-id="${target.windowId}"]`,
    );

    // Fresh window: an ordinary row inside its session group, no pinned row.
    await expect(row).toHaveCount(1, { timeout: 5_000 });
    await expect(groupRow).toHaveCount(1);
    await expect(row.getByTestId("operator-headset-icon")).toHaveCount(0);

    // Mark via the same options POST route the palette commands use.
    const setRes = await setRole(page, target.windowId, "operator");
    expect(setRes.ok(), "setting @rk_win_role=operator via the options API").toBeTruthy();

    // Move-don't-copy: the row leaves its session group and renders exactly
    // once — pinned ABOVE the session group (a smaller y than the group box).
    await expect(groupRow).toHaveCount(0, { timeout: 6_000 });
    await expect(row).toHaveCount(1);
    const rowBox = await row.boundingBox();
    const groupBox = await page.locator(`[data-session-group="${TEST_SESSION}"]`).boundingBox();
    expect(rowBox, "pinned row box").toBeTruthy();
    expect(groupBox, "session group box").toBeTruthy();
    expect(rowBox!.y).toBeLessThan(groupBox!.y);
    await expect(row.getByTestId("operator-headset-icon")).toHaveCount(1);

    // The pinned row does not participate in window drag-reorder.
    await expect(row).toHaveAttribute("draggable", "false");

    await row.click();
    // Pinned activation is ordinary navigation to the operator terminal.
    await expect(page.getByRole("button", { name: `Rename tab ${opName}` })).toBeVisible();
    await expect(page.getByTestId("quake-terminal")).toHaveCount(0);

    // Unmark (null per the partial-merge contract): demotion moves the window
    // out of `_rk-operator` into the session named after its pane cwd's
    // BASENAME (created on demand) — NOT back to its original session
    // (physical promotion). The pinned slot disappears entirely and the row
    // reappears as an ordinary in-group row of the destination.
    const clearRes = await setRole(page, target.windowId, null);
    expect(clearRes.ok(), "clearing @rk_win_role via the options API").toBeTruthy();
    const destRow = page.locator(
      `[data-session-group="${DEST_SESSION}"] [data-window-id="${target.windowId}"]`,
    );
    await expect(destRow).toHaveCount(1, { timeout: 6_000 });
    await expect(groupRow).toHaveCount(0);
    await expect(row).toHaveCount(1);
    const restoredRowBox = await row.boundingBox();
    const restoredGroupBox = await page
      .locator(`[data-session-group="${DEST_SESSION}"]`)
      .boundingBox();
    expect(restoredRowBox!.y).toBeGreaterThan(restoredGroupBox!.y);
    await expect(row.getByTestId("operator-headset-icon")).toHaveCount(0);

    // Leave the target route so the second click has to navigate rather than
    // passing against the route established by the pinned-row click above.
    await gotoServerReady(page, TMUX_SERVER);
    await expect(page.getByRole("button", { name: `Rename tab ${opName}` })).toHaveCount(0);
    await expect(row).toHaveCount(1);

    // Demoted activation is behaviorally identical to the pinned activation,
    // and this assertion now observes a fresh route transition.
    await row.click();
    await expect(page.getByRole("button", { name: `Rename tab ${opName}` })).toBeVisible();
    await expect(page.getByTestId("quake-terminal")).toHaveCount(0);
  });
});
