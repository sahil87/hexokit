/**
 * Demo: one home entry in the command palette, recorded for PR evidence.
 * `Host: Overview` (app.tsx) duplicated `Go: Host` (lib/palette/nav.ts) on a
 * terminal route — two rows, one destination, with different navigation
 * semantics (full reload vs SPA route). The route-registered duplicate is
 * gone; `Go: Host` is the single entry and covers every palette-bearing mode.
 *
 * Runs only under `just demo palette-host-entry` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). The `--before` pass runs the same
 * script against the base ref, where the `host` query shows both rows — the
 * before/after pair shows the entry that disappeared.
 *
 * Shared setup: beforeAll seeds one detached session the page is viewed from
 * (the terminal route is the only one where both entries used to collide);
 * afterAll kills it. Nothing is selected, so no navigation happens.
 */
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const VIEW_SESSION = `demo-palhost-${process.pid}`;

test.describe("palette-host-entry demo", () => {
  test.beforeAll(() => {
    createSession(VIEW_SESSION);
  });

  test.afterAll(() => {
    killSession(VIEW_SESSION);
  });

  /**
   * Proves: the palette offers exactly one home entry — `Go: Host` — and no
   * `Host: Overview` row appears beside it.
   *
   * Steps:
   * 1. Open the session's window and wait for the app; `beat()`.
   * 2. Open the palette, type `host` character by character, dwell on the
   *    result list (after: `Go: Host` only; before: `Host: Overview` too).
   * 3. Esc, then reopen with an empty query and dwell so a reviewer can see
   *    the entry's place in the unscoped list.
   */
  test("one home entry: Go: Host without the Host: Overview duplicate", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const viewId = (await resolveWindow(page, TMUX_SERVER, VIEW_SESSION, undefined)).windowId;
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(viewId)}`);
    if (isMobile) {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    } else {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    }
    await beat(page);

    const input = await openPalette(page);
    await input.pressSequentially("host", { delay: 200 });
    await beat(page, 2_500);
    await page.keyboard.press("Escape");
    await beat(page, 400);

    await openPalette(page);
    await beat(page, 2_000);
  });
});
