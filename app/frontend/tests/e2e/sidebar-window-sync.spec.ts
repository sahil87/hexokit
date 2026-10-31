import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { gotoServerReady, resolveWindow as resolveWindowRaw, READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

/**
 * Sidebar window sync: the sidebar stays in sync with tmux state for
 * external mutations (create, rename, kill-then-create) without page
 * reloads, and clicking a window in the UI renders its terminal (the
 * user-driven direction).
 *
 * Shared setup: beforeAll creates `e2e-sync-<timestamp>` so every test has
 * its own isolated session; afterAll kills it. Tests within this file run
 * sequentially (fullyParallel: false), so windows created in one test won't
 * race another. resolveWindow(page, name) polls GET /api/sessions until a
 * window with the given name appears, returning its stable tmux window id
 * (@N) and index. Tests select rows by data-window-id="@N" rather than the
 * display name — @N is unique for the window's lifetime, whereas names
 * collide and indices are reused. The window id is the router's terminal URL
 * segment on the 2-segment route /$server/$window (the session is not in the
 * URL — it is derived from the SSE snapshot). The URL segment is the window
 * id's numeric part (@2 → 2; parse restores @N), so URL assertions match
 * windowId.slice(1) (regex-escaped via escapeRegExp); the index is retained
 * only for diagnostics. The viewer-badge test additionally opens a SECOND
 * browser context (its own window, so its page stays visible) on the same
 * terminal route at a different viewport — each open relay stream is a real
 * sized tmux attach client on the isolated server.
 */

// Each test file uses its own session to avoid cross-test interference.
// Tests within this file share the session and execute in order (fullyParallel: false).
const TEST_SESSION = `e2e-sync-${Date.now()}`;

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared snapshot resolver (hoisted to `_ready.ts`) bound to this file's
// server + session. Returns the full snapshot window (`windowId` is the stable
// `@N` handle for DOM selection; the router carries its numeric part).
const resolveWindow = (page: Page, windowName: string) =>
  resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName);

test.describe("Sidebar Window Sync", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: when a window is created via the tmux CLI (outside the UI), SSE
   * polling surfaces it in the sidebar within ≤5s (≥2 poll cycles at the
   * 2.5s interval).
   *
   * Steps:
   * 1. Navigate to /${TMUX_SERVER} and wait for Connected.
   * 2. Run `tmux new-window -t ${TEST_SESSION} -n ext-win-<ts>` via the
   *    shared _tmux helper.
   * 3. Assert text=ext-win-<ts> is visible inside
   *    nav[aria-label='Groups'] within 5s.
   */
  test("external window creation appears without page reload", async ({
    page,
  }) => {
    const ts = Date.now();
    const windowName = `ext-win-${ts}`;

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");

    newWindow(TEST_SESSION, windowName);

    // SSE poll interval is 2500ms; 5000ms covers ≥2 full cycles
    await expect(
      sidebar.locator(`text=${windowName}`),
    ).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Proves: renaming a tmux window outside the UI updates the sidebar — the
   * new name appears and the old name disappears.
   *
   * Steps:
   * 1. Create a window rename-src-<ts> via the shared _tmux helper before
   *    navigating.
   * 2. Navigate to /${TMUX_SERVER} and wait for Connected.
   * 3. Assert rename-src-<ts> is visible in the sidebar.
   * 4. Run `tmux rename-window -t "${TEST_SESSION}:rename-src-<ts>"
   *    rename-dst-<ts>`.
   * 5. Assert rename-dst-<ts> appears within 5s.
   * 6. Assert rename-src-<ts> is no longer visible within 5s — by this point
   *    SSE has replaced the old entry.
   */
  test("external window rename reflects without page reload", async ({
    page,
  }) => {
    const ts = Date.now();
    const srcName = `rename-src-${ts}`;
    const dstName = `rename-dst-${ts}`;

    newWindow(TEST_SESSION, srcName);

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");

    // Confirm source window is visible before renaming
    await expect(
      sidebar.locator(`text=${srcName}`),
    ).toBeVisible({ timeout: 5_000 });

    execSync(
      `tmux -L ${TMUX_SERVER} rename-window -t "${TEST_SESSION}:${srcName}" "${dstName}"`,
      { stdio: "ignore" },
    );

    await expect(
      sidebar.locator(`text=${dstName}`),
    ).toBeVisible({ timeout: 5_000 });

    // Old name should be gone (SSE will have already updated by the time dstName appeared)
    await expect(
      sidebar.locator(`text=${srcName}`),
    ).not.toBeVisible({ timeout: 5_000 });
  });

  /**
   * Proves: clicking a window in the sidebar while on the server dashboard
   * (no window in the URL) puts that window id into the URL and marks the row
   * selected — so the terminal route mounts at all. Guards the regression
   * where clicks were pure selectWindow mutations whose URL writeback could
   * only re-point the window within the URL's existing session, leaving the
   * dashboard showing forever. The assertion targets the URL + selection
   * (the direct fix signal), not the xterm canvas, whose lazy init +
   * WebSocket connect is a separate, slower concern.
   *
   * Steps:
   * 1. Create a second window click-win-<ts> via the shared _tmux helper.
   * 2. Navigate to /${TMUX_SERVER} (dashboard — no window segment) and wait
   *    for Connected.
   * 3. resolveWindow the created window to get its @id and index.
   * 4. Assert the row (data-window-id="@id") button is visible and the URL
   *    does not yet contain the window's numeric segment (@id sans @).
   * 5. Click the window button.
   * 6. Assert the URL now matches /${TMUX_SERVER}/<N> (the 2-segment route;
   *    the window id's numeric part — @id sans @, i.e. windowId.slice(1) —
   *    regex-escaped; parse restores @N) and the clicked button has
   *    aria-current="page".
   */
  test("clicking a window from the dashboard selects it and updates the URL", async ({
    page,
  }) => {
    const ts = Date.now();
    const winName = `click-win-${ts}`;

    // A second window so the click target is unambiguous and distinct from
    // the session's initial active window.
    newWindow(TEST_SESSION, winName);

    // Land on the server root (the dashboard) — no session/window in the URL.
    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");
    // Resolve the window's stable identifiers (tmux @id + index) from the API
    // snapshot rather than matching on the display name, which is neither
    // unique nor stable. We select by data-window-id and assert the URL by the
    // window id's numeric part (`@N` sans `@`, i.e. `windowId.slice(1)` — the
    // segment the router carries; parse restores `@N`), NOT the mutable index.
    const target = await resolveWindow(page, winName);
    const row = sidebar.locator(`[data-window-id="${target.windowId}"]`);
    const windowButton = row.getByRole("button").first();
    await expect(windowButton).toBeVisible({ timeout: 5_000 });

    // Before the click we are on the dashboard: URL has no window segment.
    // (Regression guard for #198, where clicks were pure tmux mutations and
    // the URL writeback could not introduce a window, leaving the dashboard
    // up forever.) The URL segment is the window id's numeric part (@N sans @).
    expect(page.url()).not.toContain(`/${target.windowId.slice(1)}`);

    await windowButton.click();

    // The URL must now carry the clicked window ID on the 2-segment route
    // /$server/$window — this is the core of the fix: the optimistic navigate
    // introduces the window so the terminal route mounts at all. The session is
    // no longer in the URL (derived from the SSE snapshot). The URL segment is
    // the window id's numeric part (`@2` → `2`); parse restores `@N`.
    await expect(page).toHaveURL(
      new RegExp(
        `/${TMUX_SERVER}/${escapeRegExp(target.windowId.slice(1))}(?:$|[/?#])`,
      ),
      { timeout: 5_000 },
    );
    // And the clicked row becomes the selected one.
    await expect(windowButton).toHaveAttribute("aria-current", "page", {
      timeout: 5_000,
    });
  });

  /**
   * Proves: after selecting window A, clicking window B switches to B and
   * stays on B — the optimistic navigate plus the pendingClickRef intent
   * guard prevent a stale SSE snapshot (still reporting A active) from
   * bouncing the selection back to A before tmux confirms the switch.
   *
   * Steps:
   * 1. Create two windows switch-a-<ts> and switch-b-<ts> via the shared
   *    _tmux helper.
   * 2. Navigate to /${TMUX_SERVER} and wait for Connected.
   * 3. resolveWindow both to get their @ids; locate rows by data-window-id.
   * 4. Click A; assert A's button is aria-current="page".
   * 5. Click B; assert B's button is aria-current="page".
   * 6. Wait 1.5s (a window in which a stale-snapshot bounce would manifest),
   *    then re-assert B is still current, A is not, and the 2-segment URL
   *    still carries B's window id's numeric part
   *    (/${TMUX_SERVER}/<N-B> — @id-B sans @, i.e. windowId.slice(1); parse
   *    restores @N).
   */
  test("clicking a different window switches selection without bounce-back", async ({
    page,
  }) => {
    const ts = Date.now();
    const winA = `switch-a-${ts}`;
    const winB = `switch-b-${ts}`;

    newWindow(TEST_SESSION, winA);
    newWindow(TEST_SESSION, winB);

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");
    const targetA = await resolveWindow(page, winA);
    const targetB = await resolveWindow(page, winB);
    const buttonA = sidebar
      .locator(`[data-window-id="${targetA.windowId}"]`)
      .getByRole("button")
      .first();
    const buttonB = sidebar
      .locator(`[data-window-id="${targetB.windowId}"]`)
      .getByRole("button")
      .first();

    await buttonA.click();
    await expect(buttonA).toHaveAttribute("aria-current", "page", {
      timeout: 5_000,
    });

    // Switch to B. The optimistic navigate selects B immediately; the
    // pending-intent guard must keep B selected and NOT let a stale SSE
    // snapshot bounce the selection back to A.
    await buttonB.click();
    await expect(buttonB).toHaveAttribute("aria-current", "page", {
      timeout: 5_000,
    });

    // Give a stale-snapshot bounce a chance to manifest, then assert B held.
    await page.waitForTimeout(1_500);
    await expect(buttonB).toHaveAttribute("aria-current", "page");
    await expect(buttonA).not.toHaveAttribute("aria-current", "page");
    // The 2-segment URL must carry B's window id numeric part (@N sans @), not
    // the session.
    await expect(page).toHaveURL(
      new RegExp(
        `/${TMUX_SERVER}/${escapeRegExp(targetB.windowId.slice(1))}(?:$|[/?#])`,
      ),
    );
  });

  /**
   * Proves: attached viewers are a visible fact — with one terminal page open
   * on a window the session row carries no viewer chip, and opening the SAME
   * window in a second browser context (a second real sized tmux attach
   * client via the relay stream) makes the session row's viewer badge appear
   * with the count 2 and the row's hover card list both viewer grids.
   *
   * Steps:
   * 1. Create window view-win-<ts> via the shared _tmux helper; navigate to
   *    /${TMUX_SERVER} and wait for Connected with the test session rendered.
   * 2. resolveWindow the window to get its @id; navigate page 1 to the
   *    terminal route (/${TMUX_SERVER}/@N encoded) and wait for `.xterm` plus
   *    the relay attach (`window.__rkTerminals[@N]`).
   * 3. Wait one SSE cycle, then assert the session row has NO viewer-badge
   *    (1 attached viewer is the chrome-free norm).
   * 4. Open a second browser context at a smaller viewport, navigate its page
   *    to the same terminal route, and wait for its `.xterm` + relay attach.
   * 5. Assert the session row's viewer-badge appears showing "2".
   * 6. Hover the session row; assert the flyout card's viewers block has a
   *    "2 viewers" header plus one row per viewer, each naming a relay-forked
   *    attach ("desktop · <W>×<H> · <peer> · <age> · idle <n>"), with exactly
   *    one row (the narrower second page) marked "narrowest".
   * 7. Close the second context.
   */
  test("a second attached viewer surfaces the count chip and card grids on the session row", async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const winName = `view-win-${Date.now()}`;
    newWindow(TEST_SESSION, winName);

    const sidebar = await gotoServerReady(page, TMUX_SERVER, TEST_SESSION);
    const target = await resolveWindow(page, winName);

    // Page 1 opens the terminal — the relay stream is one real sized
    // attach-session client on the isolated server.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(target.windowId)}`);
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            (w) =>
              Boolean(
                (window as unknown as { __rkTerminals?: Record<string, unknown> })
                  .__rkTerminals?.[w],
              ),
            target.windowId,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const sessionRow = sidebar.locator(
      `[data-session-row="${TMUX_SERVER}:${TEST_SESSION}"]`,
    );
    // One attached viewer is the norm: no chip, even after a full SSE cycle.
    await page.waitForTimeout(3_000);
    await expect(sessionRow.getByTestId("viewer-badge")).toHaveCount(0);

    // Page 2 in a SEPARATE context (its own window, so it stays visible)
    // opens the same window at a different viewport — the second sized viewer.
    const ctx2 = await browser.newContext({ viewport: { width: 900, height: 500 } });
    const page2 = await ctx2.newPage();
    try {
      await page2.goto(`/${TMUX_SERVER}/${encodeURIComponent(target.windowId)}`);
      await expect(page2.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          () =>
            page2.evaluate(
              (w) =>
                Boolean(
                  (window as unknown as { __rkTerminals?: Record<string, unknown> })
                    .__rkTerminals?.[w],
                ),
              target.windowId,
            ),
          { timeout: 15_000 },
        )
        .toBe(true);

      // The next sessions snapshot folds both attach clients onto the session.
      const badge = sessionRow.getByTestId("viewer-badge");
      await expect(badge).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(badge).toHaveText("2");
      await expect(badge).toHaveAttribute("aria-label", "2 viewers attached");

      // The row's hover card names both viewers: each relay stream is a
      // forked attach the daemon owns, so both rows resolve as kind "rk" —
      // Playwright's UA classifies as "desktop", the peer is the loopback
      // address. The narrower second page carries the "narrowest" marker.
      await sessionRow.hover();
      const viewersBlock = page.getByTestId("row-flyout-viewers");
      await expect(viewersBlock).toContainText("2 viewers", { timeout: READY_TIMEOUT });
      const rows = viewersBlock.getByTestId("row-flyout-viewer");
      await expect(rows).toHaveCount(2);
      const rowPattern =
        /^desktop · \d+×\d+ · [\d.:a-f]+ · \d+[smh] · idle \d+[smh]( · narrowest)?$/;
      await expect(rows.nth(0)).toHaveText(rowPattern);
      await expect(rows.nth(1)).toHaveText(rowPattern);
      await expect(rows.filter({ hasText: "narrowest" })).toHaveCount(1);
    } finally {
      await ctx2.close();
    }
  });

  /**
   * Proves: after killing a window, creating a replacement that tmux may
   * assign the same slot to is shown correctly. The store's reconciliation
   * (syncWindows) must not let a stale killed marker suppress the new window.
   *
   * Steps:
   * 1. Create kill-win-<ts> via the shared _tmux helper.
   * 2. Navigate to /${TMUX_SERVER} and wait for Connected.
   * 3. Assert kill-win-<ts> is visible in the sidebar.
   * 4. Hover the kill-win-<ts> row — the icon cluster is pointer-events-none
   *    at rest (stray-click hardening), so group-hover must restore
   *    interactivity before the kill button can receive the click.
   * 5. Ctrl+click the sidebar's `Kill tab kill-win-<ts>` button — performs an
   *    instant optimistic kill, bypassing the confirm dialog (the dialog path
   *    relies on a killTargetRef that is cleared synchronously, which makes
   *    this edge harder to exercise deterministically via the UI).
   * 6. Assert kill-win-<ts> disappears within 5s.
   * 7. Create win-new-<ts> externally via the shared _tmux helper.
   * 8. Assert win-new-<ts> appears within 5s.
   * 9. Assert kill-win-<ts> is still gone.
   */
  test("kill-then-create at same index does not suppress new window", async ({
    page,
  }) => {
    const ts = Date.now();
    const windowName = `kill-win-${ts}`;
    const newWindowName = `win-new-${ts}`;

    // Create the window to kill
    newWindow(TEST_SESSION, windowName);

    await gotoServerReady(page, TMUX_SERVER);

    const sidebar = page.locator("nav[aria-label='Groups']");

    // Confirm the window is visible before killing
    await expect(
      sidebar.locator(`text=${windowName}`),
    ).toBeVisible({ timeout: 5_000 });

    // Ctrl+click performs an instant optimistic kill (no confirm dialog).
    // We use this path because the dialog path relies on a killTargetRef that
    // is reset to null synchronously on handleKill, making it unreliable to
    // observe the "killed entry persists" edge case via the UI.
    // The icon cluster is pointer-events-none at rest (stray-click hardening);
    // hover the row first so group-hover restores interactivity, mirroring how
    // a real cursor reaches the kill button.
    await sidebar.locator(`text=${windowName}`).first().hover();
    await sidebar
      .locator(`button[aria-label="Kill tab ${windowName}"]`)
      .click({ modifiers: ["Control"] });

    // Killed window should disappear from the sidebar (optimistic + confirmed)
    await expect(
      sidebar.locator(`text=${windowName}`),
    ).not.toBeVisible({ timeout: 5_000 });

    // Immediately create a replacement window externally. Tmux commonly
    // assigns the next available index — which may be the same slot the
    // killed window occupied. The store's reconciliation (syncWindows) must
    // not suppress this new window just because a prior windowId was marked
    // killed.
    newWindow(TEST_SESSION, newWindowName);

    await expect(
      sidebar.locator(`text=${newWindowName}`),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      sidebar.locator(`text=${windowName}`),
    ).not.toBeVisible();
  });
});
