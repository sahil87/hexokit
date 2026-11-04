// retire-with: legacy-color-sweep
import { test, expect, type Page } from "@playwright/test";
import { gotoServerReady, resolveWindow } from "./_ready";
import {
  TMUX_FAMILY,
  createSession,
  killServer,
  setSessionOption,
  sessionOption,
} from "./_tmux";

// Dedicated scratch server: the legacy-option sweep runs at most once per
// server per daemon lifetime, so the seeded legacy key must land on a server
// this daemon process has never swept. Named inside this worktree's socket
// family (TMUX_FAMILY anchor) so the allowlist, teardown glob, and post-sweep
// all match by prefix (the multi-server spec's convention).
// beforeAll creates the scratch server with one session (one window) via the
// shared _tmux helpers — createSession marks the server @rk_srv_managed, so
// the managed-only sweep gate passes — then seeds the bug: a session-scoped
// legacy @color. afterAll kills the scratch server. expectSessionOption polls
// the session-scoped option until it reads the expected value ("" = unset).
const LEGACY_SERVER = `${TMUX_FAMILY}legacy-${process.pid}-${Date.now().toString().slice(-6)}`;
const TEST_SESSION = `e2e-legacy-${Date.now()}`;
const WIN_NAME = "legacy-win";

/** Poll a session-scoped user option until it reads `expected` ("" = unset). */
async function expectSessionOption(
  page: Page,
  option: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(() => sessionOption(TEST_SESSION, option, { server: LEGACY_SERVER }), {
      timeout: 6_000,
    })
    .toBe(expected);
}

test.describe("Legacy option sweep (session-scoped @color)", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION, { server: LEGACY_SERVER, windows: [WIN_NAME] });
    // The bug's seed: a session-scoped legacy @color. tmux format inheritance
    // made every window in the session read it, and the window-level clear was
    // a no-op against it.
    setSessionOption(TEST_SESSION, "@color", "1+3", { server: LEGACY_SERVER });
  });

  test.afterAll(() => {
    killServer(LEGACY_SERVER);
  });

  /**
   * Proves: a session-scoped legacy `@color` no longer tints any window row
   * (the snapshot's window `color` field reads `@rk_win_color`, which the
   * legacy key can never reach, and the row button carries no inline tint);
   * triggering the reload-config sweep hook purges the wrong-scope key and
   * copies nothing forward (no `@rk_ses_color` appears); and the picker's
   * `Clear color` against the purged key leaves the row uncolored.
   *
   * Steps:
   * 1. Sanity-check the seed: `@color` reads `1+3` at session scope on the
   *    scratch server.
   * 2. Navigate to `/<scratch-server>` and wait for the session row;
   *    `resolveWindow` the window and assert its `color` field is empty.
   * 3. Assert the row button's inline `background-color` style is empty (the
   *    tint is an inline style applied only for a known color value).
   * 4. POST `/api/tmux/reload-config?server=<scratch-server>` (an
   *    attach-equivalent sweep hook; first call for this server runs the
   *    once-guarded sweep); assert the response is OK.
   * 5. Poll until `@color` reads unset at session scope; assert the session
   *    gained no `@rk_ses_color` (wrong-scope values are purged, never copied)
   *    and the window's `color` field is still empty.
   * 6. Hover the row, open its `Label picker` from the flyout's `Change
   *    color…` action, and click `Clear color`; poll the snapshot until the
   *    window's `color` field is empty and assert the row button still
   *    carries no inline tint.
   * 7. Close the picker via the `Close picker` (✕) cell.
   */
  test("a session-scoped legacy @color tints nothing, the sweep purges it, and the picker clear stays a no-op", async ({
    page,
  }) => {
    // The scratch-server boot + sweep poll outgrow the default 10s budget.
    test.setTimeout(30_000);

    // Sanity: the seed landed at session scope.
    expect(sessionOption(TEST_SESSION, "@color", { server: LEGACY_SERVER })).toBe("1+3");

    await gotoServerReady(page, LEGACY_SERVER, TEST_SESSION);
    const target = await resolveWindow(page, LEGACY_SERVER, TEST_SESSION, WIN_NAME);

    // Namespace isolation: window colors read @rk_win_color now, so the
    // legacy session-scoped key never reaches the snapshot — the row's color
    // field is empty and the row button carries no inline tint (the tint is an
    // inline background-color applied only for a known color value).
    expect(target.color ?? "").toBe("");
    const sidebar = page.locator("nav[aria-label='Groups']");
    const row = sidebar.locator(`[data-window-id="${target.windowId}"]`);
    const rowButton = row.getByRole("button").filter({ hasText: WIN_NAME });
    await expect(rowButton).toBeVisible({ timeout: 5_000 });
    expect(await rowButton.evaluate((el) => el.style.backgroundColor)).toBe("");

    // The reload-config endpoint is an attach-equivalent sweep hook: first
    // call for this server runs the once-guarded sweep, which purges the
    // wrong-scope legacy key without copying it anywhere.
    const reloadRes = await page.request.post(
      `/api/tmux/reload-config?server=${encodeURIComponent(LEGACY_SERVER)}`,
    );
    expect(reloadRes.ok(), "POST /api/tmux/reload-config").toBeTruthy();
    await expectSessionOption(page, "@color", "");
    // The purge copies nothing forward: the session gained no @rk_ses_color.
    expect(sessionOption(TEST_SESSION, "@rk_ses_color", { server: LEGACY_SERVER })).toBe("");
    expect(target.color ?? "").toBe("");

    // The picker's clear against the (now gone) legacy key leaves the row
    // uncolored — the no-op clear that used to silently fail against the
    // inherited tint.
    await row.hover();
    const card = page.getByTestId("row-flyout-card");
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.getByTestId("row-flyout-color-action").click();
    const picker = page.getByRole("listbox", { name: "Label picker" });
    await expect(picker).toBeVisible({ timeout: 5_000 });
    await picker.getByRole("option", { name: "Clear color" }).click();
    await expect
      .poll(
        async () => {
          const res = await page.request.get(
            `/api/sessions?server=${encodeURIComponent(LEGACY_SERVER)}`,
          );
          if (!res.ok()) return "<fetch-failed>";
          const sessions = (await res.json()) as Array<{
            name: string;
            windows: Array<{ name: string; color?: string }>;
          }>;
          return (
            sessions
              .find((s) => s.name === TEST_SESSION)
              ?.windows.find((w) => w.name === WIN_NAME)?.color ?? ""
          );
        },
        { timeout: 6_000 },
      )
      .toBe("");
    expect(await rowButton.evaluate((el) => el.style.backgroundColor)).toBe("");
    await picker.getByLabel("Close picker").click();
  });
});
