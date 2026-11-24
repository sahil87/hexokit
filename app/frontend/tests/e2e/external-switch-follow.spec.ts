import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { gotoWindow, resolveWindow, seedComposeStrip } from "./_ready";
import { TMUX_SERVER, capturePane, createSession, killSession, listWindows, newWindow } from "./_tmux";

/**
 * External tmux window switches: on the home-tab terminal route the URL,
 * centered heading and Compose target follow tmux's active window, so a switch
 * made outside the UI (`tmux select-window`, `rk riff`'s `new-window`) moves
 * all of them and a Compose send lands in the window the terminal is showing.
 *
 * Shared setup: a `beforeEach` recreates the dedicated session
 * `e2e-follow-<ts>` on the isolated e2e server with two windows (`efs-a`,
 * `efs-b`), each running `cat` so submitted text echoes into that window's pane
 * and can be read back with `capture-pane`; `afterAll` kills it. Creating
 * the session leaves `efs-b` active, so deep-linking to `efs-a` is a cold
 * deep-link to a NON-active window (the page aligns tmux to the URL first).
 * The Compose strip is seeded ON before navigation; the external switch is
 * driven on the rig's tmux socket via `execFileSync` argument arrays. The
 * window id is the router's terminal segment (`@N`, percent-encoded or bare
 * `N` depending on who wrote the URL), so URL assertions match `windowId.slice(1)`
 * with an optional `@`/`%40` prefix.
 */

const TEST_SESSION = `e2e-follow-${Date.now()}`;

function selectWindowExternally(windowId: string): void {
  execFileSync("tmux", ["-L", TMUX_SERVER, "select-window", "-t", windowId], {
    stdio: "ignore",
  });
}

function urlFor(windowId: string): RegExp {
  return new RegExp(`/${TMUX_SERVER}/(?:%40|@)?${windowId.slice(1)}(\\?.*)?$`);
}

/** Wait until the page shows `name` as the route's window: URL and centered
 *  heading. The Compose target is the window the URL names — it is proven by
 *  where a send lands, not by a label (the in-tile dock folds the label away). */
async function expectFollowed(page: Page, windowId: string, name: string): Promise<void> {
  await expect(page).toHaveURL(urlFor(windowId));
  await expect(page.getByRole("button", { name: `Rename tab ${name}` })).toBeVisible();
}

/** Submit a marker through the Compose strip and return it. */
async function sendViaCompose(page: Page, label: string): Promise<string> {
  const marker = `${label}${Date.now()}`;
  const input = page.getByTestId("compose-strip-input");
  await input.fill(marker);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  return marker;
}

test.describe("Viewed window follows tmux", () => {
  test.beforeEach(async ({ page }) => {
    createSession(TEST_SESSION, {
      windows: [
        { name: "efs-a", command: "cat" },
        { name: "efs-b", command: "cat" },
      ],
    });
    await seedComposeStrip(page, true);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: after a cold deep-link to a non-active tab, a `tmux select-window`
   * made outside the UI moves the URL and heading to the newly active window,
   * and a Compose send lands in that window — not the one the page first
   * opened.
   *
   * Steps:
   * 1. Resolve `efs-a` and `efs-b` (tmux leaves `efs-b` active).
   * 2. Deep-link to `efs-a`; assert URL and heading name `efs-a` (the page
   *    aligned tmux to the URL).
   * 3. Run `tmux select-window` to `efs-b` on the rig's socket.
   * 4. Assert URL and heading follow to `efs-b`.
   * 5. Send a marker through Compose; assert it appears in `efs-b`'s pane and
   *    not in `efs-a`'s.
   */
  test("an external select-window moves URL and heading and redirects Compose", async ({ page }) => {
    test.setTimeout(60_000);
    const a = (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, "efs-a")).windowId;
    const b = (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, "efs-b")).windowId;

    await gotoWindow(page, TMUX_SERVER, a);
    await expectFollowed(page, a, "efs-a");

    selectWindowExternally(b);
    await expectFollowed(page, b, "efs-b");

    const marker = await sendViaCompose(page, "EFSEL");
    await expect.poll(() => capturePane(b), { timeout: 10_000 }).toContain(marker);
    expect(capturePane(a)).not.toContain(marker);
  });

  /**
   * Proves: a window created outside the UI (what `rk riff` does) becomes the
   * viewed window — URL and heading follow it, and a Compose send reaches the
   * new window rather than the tab `rk riff` was typed in.
   *
   * Steps:
   * 1. Resolve `efs-a`; deep-link to it and assert URL and heading name
   *    `efs-a`.
   * 2. Run `tmux new-window` named `efs-riff` on the rig's socket (it becomes
   *    the session's active window).
   * 3. Resolve `efs-riff`; assert URL and heading follow it.
   * 4. Send a marker through Compose; assert it appears in `efs-riff`'s pane
   *    and not in `efs-a`'s.
   */
  test("a window created externally becomes the viewed window and Compose target", async ({ page }) => {
    test.setTimeout(60_000);
    const a = (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, "efs-a")).windowId;

    await gotoWindow(page, TMUX_SERVER, a);
    await expectFollowed(page, a, "efs-a");

    newWindow(TEST_SESSION, "efs-riff", { command: "cat" });
    const riff = listWindows(TEST_SESSION).find((w) => w.name === "efs-riff")?.windowId;
    expect(riff).toBeDefined();
    await expectFollowed(page, riff!, "efs-riff");

    const marker = await sendViaCompose(page, "EFRIFF");
    await expect.poll(() => capturePane(riff!), { timeout: 10_000 }).toContain(marker);
    expect(capturePane(a)).not.toContain(marker);
  });
});
