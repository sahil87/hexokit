/**
 * Demo: the desktop titlebar strip's host squares, nameplate and lit band,
 * recorded for PR evidence. Shows the squares (one per seeded host) with the
 * active host's ring and the nameplate naming it, the hover preview of the
 * other host, the Alt key-hint pill and digits appearing without anything
 * moving, a click switching hosts with the light moving to the new square, a
 * drag reordering the squares (digits renumbering live), and Settings →
 * Appearance → This app switching the strip effect.
 *
 * Runs only under `just demo shell-strip-host-squares` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway e2e
 * rig; the `_demo.ts` fixture supplies the seeded config home, the launched
 * shell, the host page and the display recording. The `--before` pass runs the
 * base ref, where the strip is a single centred `<host> ▾` label: the spec then
 * shows that label and stops. The macOS-only parts (⌥⌘ pill, traffic-light
 * inset) are not recordable on this Linux display.
 */
import { test, expect, beat, pace, READY_TIMEOUT } from "./_demo";

test.describe("shell strip host squares demo", () => {
  /**
   * Proves: in the Electron shell the strip shows one square per host with the
   * active host named in the nameplate, the squares reveal their digits under
   * the Alt chord without shifting, a click switches hosts, a drag reorders the
   * squares, and the strip effect can be changed from Settings.
   *
   * Steps:
   * 1. Wait for the seeded host page; `beat()`. On the base ref (no squares)
   *    show the centred label and stop.
   * 2. Hover the second square to preview its host in the nameplate; `beat()`.
   * 3. Hold Alt to reveal the digits; `beat()`; release.
   * 4. Drag the second square left of the first; `beat()`.
   * 5. Open Settings → Appearance and pick the Hex mesh effect in This app;
   *    `beat()`.
   * 6. Click the other host's square and wait for the page to swap; `beat()`.
   */
  test("squares, hover preview, key hints, reorder, effect and switch", async ({ hostPage }) => {
    const squares = hostPage.getByTestId("shell-host-square");
    if ((await squares.count()) === 0) {
      // Base ref: the strip is the centred label.
      await expect(hostPage.getByTestId("shell-titlebar-strip")).toBeVisible();
      await beat(hostPage);
      return;
    }
    await expect(squares).toHaveCount(2, { timeout: READY_TIMEOUT });
    await expect(hostPage.getByTestId("shell-nameplate-name")).toHaveText("e2e A");
    await beat(hostPage);

    await squares.nth(1).hover();
    await expect(hostPage.getByTestId("shell-nameplate-name")).toContainText("e2e B");
    await beat(hostPage);
    await hostPage.mouse.move(500, 300);

    await hostPage.keyboard.down("Alt");
    await beat(hostPage);
    await hostPage.keyboard.up("Alt");

    const second = await squares.nth(1).boundingBox();
    const first = await squares.nth(0).boundingBox();
    if (second && first) {
      await hostPage.mouse.move(second.x + 9, second.y + 9);
      await hostPage.mouse.down();
      await hostPage.mouse.move(first.x - 2, first.y + 9, { steps: 12 });
      await pace(hostPage);
      await hostPage.mouse.up();
    }
    await beat(hostPage);

    await hostPage.keyboard.press("Control+Shift+Comma");
    await hostPage.getByRole("tab", { name: "Appearance" }).click();
    await hostPage.getByRole("button", { name: "Hex mesh" }).click();
    await beat(hostPage, 1_800);
    await hostPage.keyboard.press("Escape");

    await hostPage.locator('[data-testid="shell-host-square"]:not([aria-current="true"])').click();
    await beat(hostPage);
  });
});
