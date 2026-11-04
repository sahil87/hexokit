import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gotoServerReady, openPalette, READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * Behavioural contract for the folder-first New sheet opened from the
 * palette: `Group: Create at Folder` and `Tab: Create at Folder` open one
 * sheet whose folder field decides where the new group / tab starts, and a
 * group takes its name from the folder.
 *
 * Shared setup: `beforeAll` makes a real folder under $HOME (the backend only
 * accepts paths under home) and seeds one detached session on the isolated
 * e2e tmux server so `/$server` has a group to resolve the sheet's target
 * from; `afterAll` removes the folder and kills the seed and created
 * sessions. Desktop viewport (1024×768).
 */

const SEED_SESSION = `e2e-newsheet-${process.pid}`;
// The basename contains "-" and "." so the derived group name proves the
// unsafe-char conversion end to end.
const FOLDER_BASENAME = `6d2o-folder.${process.pid}`;
const FOLDER_GROUP = `6d2o_folder_${process.pid}`;
const FOLDER_ROOT = join(homedir(), ".cache", "rk-e2e-6d2o");
const FOLDER_ABS = join(FOLDER_ROOT, FOLDER_BASENAME);
const FOLDER_TILDE = `~/.cache/rk-e2e-6d2o/${FOLDER_BASENAME}`;

function tmuxOut(args: string[]): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, ...args], { encoding: "utf8" });
}

test.describe("New sheet (folder-first create)", () => {
  test.beforeAll(() => {
    mkdirSync(FOLDER_ABS, { recursive: true });
    createSession(SEED_SESSION);
  });

  test.afterAll(() => {
    killSession(SEED_SESSION);
    killSession(FOLDER_GROUP);
    rmSync(FOLDER_ROOT, { recursive: true, force: true });
  });

  /**
   * Proves: `Group: Create at Folder` opens the sheet at Group level, and
   * Enter creates a group named after the typed folder, starting there.
   *
   * Steps:
   * 1. Go to the e2e server (ready-gated on the seed group).
   * 2. Open the palette, run `Group: Create at Folder`; assert the sheet's
   *    Group level is pressed.
   * 3. Type the folder; assert the preview names the folder-derived group.
   * 4. Press Enter; assert the sidebar lists the folder-named group, and
   *    poll until tmux has that session at the folder.
   */
  test("Group: Create at Folder creates a folder-named group", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    const nav = await gotoServerReady(page, TMUX_SERVER, SEED_SESSION);

    const palette = await openPalette(page);
    await palette.fill("Group: Create at Folder");
    await page.getByRole("option", { name: /^Group: Create at Folder/ }).click();

    const sheet = page.getByRole("dialog", { name: "New" });
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(sheet.getByRole("button", { name: /^Group/ })).toHaveAttribute("aria-pressed", "true");

    const folder = sheet.getByRole("combobox", { name: "Folder" });
    await folder.fill(FOLDER_TILDE);
    await expect(sheet.getByLabel("Preview")).toContainText(`New group ${FOLDER_GROUP} in ${TMUX_SERVER}`);
    await folder.press("Enter");

    await expect(nav.getByText(FOLDER_GROUP, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    // The sidebar row can be the optimistic ghost, so poll tmux for the real
    // session rather than reading it once.
    await expect
      .poll(
        () =>
          tmuxOut(["list-sessions", "-F", "#{session_name}\t#{session_path}"])
            .split("\n")
            .filter(Boolean),
        { timeout: READY_TIMEOUT },
      )
      .toContain(`${FOLDER_GROUP}\t${FOLDER_ABS}`);
  });

  /**
   * Proves: `Tab: Create at Folder` opens the sheet at Tab level and creates
   * an unnamed tab in the current group, starting in the chosen folder.
   *
   * Steps:
   * 1. Go to the seed group's route (ready-gated).
   * 2. Open the palette, run `Tab: Create at Folder`; assert Tab is pressed.
   * 3. Type the folder and press Enter.
   * 4. Poll tmux until the seed session has a window whose pane is at the folder.
   */
  test("Tab: Create at Folder creates a tab at the chosen folder", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    await gotoServerReady(page, TMUX_SERVER, SEED_SESSION);
    // The tab level needs a current group, which the seed session provides.
    await page.locator("nav[aria-label='Groups']").getByRole("button", { name: `Navigate to ${SEED_SESSION}` }).click();

    const palette = await openPalette(page);
    await palette.fill("Tab: Create at Folder");
    await page.getByRole("option", { name: /^Tab: Create at Folder/ }).click();

    const sheet = page.getByRole("dialog", { name: "New" });
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(sheet.getByRole("button", { name: /^Tab/ })).toHaveAttribute("aria-pressed", "true");

    const folder = sheet.getByRole("combobox", { name: "Folder" });
    await folder.fill(FOLDER_TILDE);
    await folder.press("Enter");
    await expect(sheet).toBeHidden();

    await expect
      .poll(() => tmuxOut(["list-windows", "-t", `=${SEED_SESSION}:`, "-F", "#{pane_current_path}"]).split("\n"), {
        timeout: READY_TIMEOUT,
      })
      .toContain(FOLDER_ABS);
  });
});
