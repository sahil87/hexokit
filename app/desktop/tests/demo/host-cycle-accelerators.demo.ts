/**
 * Demo: cycling hosts from the keyboard in the desktop shell, recorded for PR
 * evidence. Three hosts are seeded, so the squares show three entries; Alt+
 * PageDown steps forward square by square, wraps from the last host to the
 * first, and Alt+PageUp steps back across the same wrap. The active square's
 * ring and the lit band sliding between squares are the visible proof.
 *
 * Runs only under `just demo host-cycle-accelerators` (app/desktop's
 * playwright.demo.config.ts), against the throwaway e2e rig; `_demo.ts`
 * supplies the seeded config home, the launched shell, the host page and the
 * display recording. The third host is `c.localhost` (Chromium resolves
 * `*.localhost` to loopback), so all three serve the rig's one port.
 *
 * The chord is injected as a real X key event (`pressXChord`): a Playwright
 * keyboard press goes over CDP into the renderer and never reaches the native
 * menu accelerators this change adds, so the recording would show nothing
 * moving. The `--before` pass runs the base ref, where the chord is bound to
 * nothing: the spec presses it and the squares do not move. The macOS ⌥⌘←/→
 * half is not recordable on this Linux display.
 */
import { test, expect, beat, READY_TIMEOUT } from "./_demo";
import { E2E_PORT, pageByOrigin, pressXChord } from "../e2e/_shell";

test.use({
  extraHosts: [{ id: "e2e-c", name: "e2e C", url: `http://c.localhost:${E2E_PORT}` }],
});

test.describe("host cycle accelerators demo", () => {
  /**
   * Proves: with three hosts, Alt+PageDown moves the window to the next host
   * and wraps last → first, and Alt+PageUp moves back and wraps first → last,
   * the active square and nameplate following each press.
   *
   * Steps:
   * 1. Wait for the three squares with the first host active; `beat()`.
   * 2. Press Alt+PageDown twice, waiting for each host's page and nameplate
   *    (second, then third host); `beat()` after each.
   * 3. Press Alt+PageDown once more — the wrap back to the first host; `beat()`.
   * 4. Press Alt+PageUp — the wrap to the last host; `beat()`.
   * 5. Press Alt+PageUp again to step back to the second host; `beat()`.
   *    On the base ref the chord does nothing, so the first press is followed
   *    by a `beat()` showing the first host unchanged and the spec stops.
   */
  test("Alt+PageDown and Alt+PageUp cycle the hosts through the wrap", async ({ app, hostPage }) => {
    const squares = hostPage.getByTestId("shell-host-square");
    await expect(squares).toHaveCount(3, { timeout: READY_TIMEOUT });
    const nameplate = (page: typeof hostPage) => page.getByTestId("shell-nameplate-name");
    await expect(nameplate(hostPage)).toHaveText("e2e A");
    await beat(hostPage);

    const origin = (host: string) => `http://${host}:${E2E_PORT}`;
    const step = async (key: string, host: string, name: string) => {
      pressXChord(key, "Alt_L");
      const page = await pageByOrigin(app, origin(host), READY_TIMEOUT);
      await expect(nameplate(page)).toHaveText(name, { timeout: READY_TIMEOUT });
      await beat(page);
    };

    pressXChord("Next", "Alt_L");
    const moved = await pageByOrigin(app, origin("localhost"), 3_000).then(
      () => true,
      () => false,
    );
    if (!moved) {
      // Base ref: the chord is unbound — the first host stays showing.
      await expect(nameplate(hostPage)).toHaveText("e2e A");
      await beat(hostPage);
      return;
    }
    await beat(await pageByOrigin(app, origin("localhost"), READY_TIMEOUT));

    await step("Next", "c.localhost", "e2e C");
    await step("Next", "127.0.0.1", "e2e A");
    await step("Prior", "c.localhost", "e2e C");
    await step("Prior", "localhost", "e2e B");
  });
});
