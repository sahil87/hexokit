import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { gotoServerReady, openPalette } from "./_ready";
import { TMUX_SERVER, TMUX_FAMILY, killServer } from "./_tmux";

// Protected-server kill confirm dialog (the typed-name force-kill unlock).
// Runs against a scratch server created and marked @rk_srv_protected via raw
// tmux — the same mark the UI Protect toggle writes — inside this worktree's
// isolated e2e socket family.
//
// Shared setup: desktop viewport (1024×768) — gotoServerReady gates on the
// desktop-only status-bar Connected dot. beforeAll creates the scratch server
// (new-session on its own socket inside this worktree's e2e socket family)
// and marks it @rk_srv_protected 1 server-scoped — the same option the UI
// Protect toggle writes through POST /api/servers/protect. afterAll kills the
// scratch server best-effort (a protected server needs the named kill — the
// reaper's family glob skips it). Each interaction starts from the primary
// e2e server route — the palette's `Workspace: Kill <name>` entries live in the
// shared app shell, and the kill target need not be the current server.

// A protected scratch server, created and marked @rk_srv_protected via tmux (the
// mark surface for non-UI actors; the UI Protect toggle posts the same
// option). Named inside this worktree's socket family (TMUX_FAMILY anchor)
// with the Playwright process.pid as the second-to-last hyphen field so the
// family-anchored teardown and RK_SERVER_ALLOWLIST match it.
const PROTECTED_SERVER = `${TMUX_FAMILY}pkc-${process.pid}-${Date.now().toString().slice(-6)}`;
const DESKTOP_VIEWPORT = { width: 1024, height: 768 };

function tmuxOn(server: string, args: string[]): void {
  execFileSync("tmux", ["-L", server, ...args]);
}

test.describe("Protected server kill: typed-name confirm flow", () => {
  test.beforeAll(() => {
    killServer(PROTECTED_SERVER); // clean slate
    tmuxOn(PROTECTED_SERVER, ["new-session", "-d", "-s", "pkc", "-x", "80", "-y", "24"]);
    tmuxOn(PROTECTED_SERVER, ["set-option", "-s", "@rk_srv_protected", "1"]);
  });

  test.afterAll(() => {
    // Best-effort — a protected server is reaped only by name (the reaper
    // skips it), so the family teardown glob alone is not enough here.
    killServer(PROTECTED_SERVER);
  });

  /**
   * Proves: the protected kill-confirm forks away from the plain two-button
   * confirm: the destructive action is `Force kill`, it stays disabled until
   * the typed text exactly equals the server name, Enter submits only on a
   * match, Esc always cancels without killing, and a completed force kill
   * removes the server from the UI.
   *
   * Steps:
   * 1. Start on the primary e2e server route (beforeAll has already created
   *    and @rk_srv_protected-marked the scratch server).
   * 2. Open the palette, run `Workspace: Kill <name>`; assert the guarded dialog
   *    shows the typed-name input and a `Force kill` button — and NO plain
   *    `Kill` button.
   * 3. Type a wrong name; assert `Force kill` stays disabled and Enter leaves
   *    the dialog open.
   * 4. Type the exact server name; assert `Force kill` enables.
   * 5. Press Esc; assert the dialog closes and the server still answers
   *    `tmux has-session` (nothing was killed).
   * 6. Reopen the dialog, type the exact name, click `Force kill`; assert the
   *    dialog closes and the server stops answering `tmux has-session`.
   */
  test("Force kill stays locked on a wrong name, unlocks on the exact name, Esc cancels", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize(DESKTOP_VIEWPORT);

    // Land on the primary e2e server route (the palette's Workspace: Kill
    // entries live in the shared app shell; the target need not be current).
    await gotoServerReady(page, TMUX_SERVER);

    // Open the guarded dialog via the palette's Workspace: Kill entry.
    const paletteInput = await openPalette(page);
    await paletteInput.fill(`Workspace: Kill ${PROTECTED_SERVER}`);
    await page.keyboard.press("Enter");

    // The protected fork: typed-name input + Force kill (no plain Kill).
    const confirmInput = page.getByLabel("Type the workspace name to unlock force kill");
    await expect(confirmInput).toBeVisible({ timeout: 5_000 });
    const forceKill = page.getByRole("button", { name: "Force kill" });
    await expect(forceKill).toBeVisible();
    await expect(page.getByRole("button", { name: "Kill", exact: true })).toHaveCount(0);

    // A wrong name keeps Force kill locked, and Enter does nothing.
    await confirmInput.fill(`${PROTECTED_SERVER}-wrong`);
    await expect(forceKill).toBeDisabled();
    await page.keyboard.press("Enter");
    await expect(confirmInput).toBeVisible();

    // The exact name unlocks it.
    await confirmInput.fill(PROTECTED_SERVER);
    await expect(forceKill).toBeEnabled();

    // Esc cancels without killing — the server is still alive.
    await page.keyboard.press("Escape");
    await expect(confirmInput).toHaveCount(0);
    tmuxOn(PROTECTED_SERVER, ["has-session"]);

    // Reopen and force-kill for real: the server stops answering.
    await openPalette(page);
    await paletteInput.fill(`Workspace: Kill ${PROTECTED_SERVER}`);
    await page.keyboard.press("Enter");
    await expect(confirmInput).toBeVisible({ timeout: 5_000 });
    await confirmInput.fill(PROTECTED_SERVER);
    await forceKill.click();
    await expect(confirmInput).toHaveCount(0);
    await expect
      .poll(
        () => {
          try {
            tmuxOn(PROTECTED_SERVER, ["has-session"]);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(false);
  });
});
