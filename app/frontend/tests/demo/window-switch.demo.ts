/**
 * Demo: switching between a session's windows, recorded for PR evidence.
 *
 * Runs only under `just demo window-switch` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig. Motion is ON in this
 * lane (reducedMotion "no-preference"), so the window-switch slide transition
 * plays in the recording; slowMo paces the actions and `beat()` pauses let a
 * reviewer register each screen.
 *
 * Shared setup: beforeAll seeds one session with three windows on the rig's
 * isolated tmux server via the e2e `_tmux.ts` helpers, each window's pane
 * echoing a distinct marker so the recording shows unambiguous content
 * changes; afterAll kills the session (the rig's EXIT trap reaps the server
 * itself). The demo runs once per project (desktop 1280x800, mobile
 * 375x812); the video is saved by the `_demo.ts` fixture to
 * .demo/window-switch[-<variant>]-<project>.webm.
 *
 * Readiness gates differ per viewport because the chrome does: desktop gates
 * on the status bar's Connected dot (`gotoServerReady`), mobile on the
 * always-mounted `Toggle navigation` hamburger (a closed drawer leaves the
 * sidebar unmounted). Window switches drive the real UI — sidebar rows on
 * desktop, the navigation drawer on mobile (a row click navigates and the
 * drawer closes itself on mobile) — never `page.goto` between windows, so the
 * recording shows the actual switch interaction.
 */
import { test, expect, beat } from "./_demo";
import { gotoServerReady, resolveWindow, READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";
import type { Locator, Page } from "@playwright/test";

const DEMO_SESSION = "demo-window-switch";

const WINDOWS = [
  { name: "alpha", marker: "MARKER-ALPHA" },
  { name: "bravo", marker: "MARKER-BRAVO" },
  { name: "charlie", marker: "MARKER-CHARLIE" },
];

/** The Sessions nav of the currently open sidebar/drawer. */
async function openNav(page: Page, isMobile: boolean): Promise<Locator> {
  if (!isMobile) {
    return page.getByRole("navigation", { name: "Sessions" });
  }
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  return drawer.getByRole("navigation", { name: "Sessions" });
}

/** True once the window's marker text is present in its xterm buffer — the
 *  honest "content painted" signal (the WebGL canvas has no readable DOM). */
async function markerVisible(page: Page, windowId: string, marker: string): Promise<boolean> {
  return page.evaluate(
    ({ windowId, marker }) => {
      const term = window.__rkTerminals?.[windowId];
      if (!term) return false;
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        if ((buf.getLine(y)?.translateToString(true) ?? "").includes(marker)) return true;
      }
      return false;
    },
    { windowId, marker },
  );
}

test.describe("window-switch demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION, {
      windows: WINDOWS.map((w) => ({
        name: w.name,
        command: `printf '\\n  === ${w.marker} ===\\n\\n'; sleep 600`,
      })),
    });
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
  });

  /**
   * Proves: a reviewer can watch window switching end to end — three windows
   * of one session, switched in sequence through the UI's own navigation
   * (sidebar rows on desktop, the drawer on mobile), each switch landing on
   * the target window's terminal with its distinct marker content painted.
   *
   * Steps:
   * 1. Navigate to the rig server's route and wait for readiness (status-bar
   *    Connected dot on desktop; hamburger on mobile), then resolve the three
   *    seeded windows' stable @ids from the sessions snapshot.
   * 2. For each window in turn (alpha → bravo → charlie → alpha):
   *    a. Open the navigation surface (desktop sidebar is always mounted;
   *       mobile opens the drawer via the hamburger).
   *    b. Click the window's row (data-window-id) and wait for the URL to
   *       carry the window id's numeric segment and the terminal to mount.
   *    c. Wait for the window's marker in its xterm buffer (content painted),
   *       then `beat()` — a deliberate pause so the recording lingers on each
   *       window before the next switch.
   */
  test("switch between three windows", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";

    if (isMobile) {
      await page.goto(`/${TMUX_SERVER}`);
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    } else {
      await gotoServerReady(page, TMUX_SERVER, DEMO_SESSION);
    }
    await beat(page);

    const ids: Record<string, string> = {};
    for (const w of WINDOWS) {
      ids[w.name] = (await resolveWindow(page, TMUX_SERVER, DEMO_SESSION, w.name)).windowId;
    }

    for (const w of [...WINDOWS, WINDOWS[0]]) {
      const nav = await openNav(page, isMobile);
      const row = nav.locator(`[data-window-id="${ids[w.name]}"]`).getByRole("button").first();
      await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
      await beat(page);
      await row.click();
      await expect(page).toHaveURL(
        new RegExp(`/${TMUX_SERVER}/${ids[w.name].slice(1)}(?:$|[/?#])`),
        { timeout: READY_TIMEOUT },
      );
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
      await expect
        .poll(() => markerVisible(page, ids[w.name], w.marker), { timeout: READY_TIMEOUT })
        .toBe(true);
      await beat(page);
    }
  });
});
