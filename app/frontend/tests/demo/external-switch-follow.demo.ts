/**
 * Demo: an external tmux window switch (what `rk riff` does) moves the page to
 * the new window, recorded for PR evidence.
 *
 * Runs only under `just demo external-switch-follow` (playwright.demo.config.ts
 * — testDir ./tests/demo), against the throwaway e2e rig. The "before" pass
 * records the base branch, where the URL, heading and Compose target stay on the
 * tab the page was opened on while the terminal moves; the "after" pass records
 * all three following tmux.
 *
 * Shared setup: beforeAll seeds one session with two `cat` windows on the rig's
 * isolated tmux server (`cat` echoes whatever Compose submits, so the pane shows
 * where the text landed); creating the session leaves `riff-origin`'s sibling
 * active, so deep-linking to `riff-origin` is a cold deep-link to a non-active
 * tab. The Compose strip is seeded ON. afterAll kills the session (the rig's
 * EXIT trap reaps the server). The demo runs once per project (desktop 1280x800,
 * mobile 375x812); the video lands at
 * .demo/external-switch-follow[-<variant>]-<project>.webm.
 *
 * The external switch is a `tmux new-window` on the rig's socket — exactly the
 * tmux-side effect of `rk riff` — never a UI click, so the recording shows the
 * page reacting to a change it did not make. The viewed tab is read from the
 * centered heading on desktop and from the Compose placeholder on mobile (the
 * coarse-pointer strip folds its target name into the placeholder).
 */
import { test, expect, beat } from "./_demo";
import { gotoWindow, resolveWindow, seedComposeStrip, READY_TIMEOUT } from "../e2e/_ready";
import {
  TMUX_SERVER,
  capturePane,
  createSession,
  killSession,
  listWindows,
  newWindow,
} from "../e2e/_tmux";
import type { Page } from "@playwright/test";

const DEMO_SESSION = "demo-external-switch";

/** The coarse-pointer strip names its target in the placeholder; the fine
 *  in-tile dock names it through the heading and the send landing instead. */
async function expectViewing(page: Page, isMobile: boolean, name: string): Promise<void> {
  if (isMobile) {
    await expect(page.getByTestId("compose-strip-input")).toHaveAttribute(
      "placeholder",
      `→ ${name}…`,
      { timeout: READY_TIMEOUT },
    );
  } else {
    await expect(page.getByRole("button", { name: `Rename tab ${name}` })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  }
}

test.describe("external-switch-follow demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION, {
      windows: [
        { name: "riff-origin", command: "cat" },
        { name: "riff-sibling", command: "cat" },
      ],
    });
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  /**
   * Proves: after the page is opened on one tab, a window created outside the
   * UI becomes the viewed window — the URL, heading and Compose target follow
   * it — and a line submitted through Compose lands in that new window instead
   * of the tab the page was opened on.
   *
   * Steps:
   * 1. Seed the Compose strip ON; resolve `riff-origin`'s stable @id and deep-link
   *    to it (a non-active tab); wait for the heading (mobile: the Compose
   *    placeholder) to name `riff-origin`; `beat()`.
   * 2. Run `tmux new-window` named `riff-new` on the rig's socket (the same
   *    tmux effect as `rk riff`); resolve its @id.
   * 3. Assert the URL carries the new window's id and the heading (mobile: the
   *    Compose placeholder) names `riff-new`; `beat()`.
   * 4. Type a line into Compose and submit it; assert it appears in `riff-new`'s
   *    pane and not in `riff-origin`'s; `beat()`.
   */
  test("compose follows a window created outside the UI", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    await seedComposeStrip(page, true);

    const origin = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, "riff-origin")).windowId;
    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(origin)}`);
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
    } else {
      await gotoWindow(page, TMUX_SERVER, origin);
    }
    await expectViewing(page, isMobile, "riff-origin");
    await beat(page);

    newWindow(DEMO_SESSION, "riff-new", { command: "cat" });
    const riffNew = listWindows(DEMO_SESSION).find((w) => w.name === "riff-new")?.windowId;
    expect(riffNew).toBeDefined();
    await beat(page, 2_000);

    await expect(page).toHaveURL(new RegExp(`/${TMUX_SERVER}/${riffNew!.slice(1)}(?:$|[/?#])`), {
      timeout: READY_TIMEOUT,
    });
    await expectViewing(page, isMobile, "riff-new");
    await beat(page);

    const marker = `sent-after-riff-${Date.now()}`;
    const input = page.getByTestId("compose-strip-input");
    await input.fill(marker);
    await beat(page, 500);
    await input.press("Enter");
    await expect.poll(() => capturePane(riffNew!), { timeout: READY_TIMEOUT }).toContain(marker);
    expect(capturePane(origin)).not.toContain(marker);
    await beat(page, 2_000);
  });
});
