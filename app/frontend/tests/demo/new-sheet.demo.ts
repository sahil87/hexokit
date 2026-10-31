/**
 * Demo: the folder-first New sheet, recorded for PR evidence. The palette's
 * `Group: Create at Folder` opens one sheet whose primary input is the folder:
 * a folder list with autocomplete, a live preview of what will be created, a
 * level switch (Tab / Group / Workspace) cycled with Tab, and a group created
 * in that folder (named after it) with one Enter.
 *
 * Runs only under `just demo new-sheet` (playwright.demo.config.ts — testDir
 * ./tests/demo), against the throwaway e2e rig, once per project (desktop
 * 1280x800 is a centered sheet, mobile 375x812 a bottom sheet). The `--before`
 * pass runs against the base ref, where `Group: Create at Folder` does not
 * exist: the spec then opens the old window-only `Tab: Create at Folder` dialog
 * so the before/after pair still shows the folder-picking surface.
 *
 * Shared setup: beforeAll makes a real folder under $HOME (the backend only
 * accepts paths under home) and seeds one detached session; afterAll removes
 * the folder and kills both sessions.
 */
import { test, expect, beat } from "./_demo";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { READY_TIMEOUT, openPalette, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const SEED_SESSION = `demo-newsheet-${process.pid}`;
const FOLDER_ROOT = join(homedir(), ".cache", "rk-demo-6d2o");
const FOLDER_BASENAME = "hexokit-demo";
const FOLDER_PARENT_TILDE = "~/.cache/rk-demo-6d2o/";
const FOLDER_TILDE = `${FOLDER_PARENT_TILDE}${FOLDER_BASENAME}`;
const GROUP = FOLDER_BASENAME.replace(/-/g, "_");

test.describe("new-sheet demo", () => {
  test.beforeAll(() => {
    mkdirSync(join(FOLDER_ROOT, FOLDER_BASENAME), { recursive: true });
    createSession(SEED_SESSION);
  });

  test.afterAll(() => {
    killSession(SEED_SESSION);
    killSession(GROUP);
    rmSync(FOLDER_ROOT, { recursive: true, force: true });
  });

  /**
   * Proves: a reviewer can see the New sheet open from the palette, the
   * folder list/autocomplete, the live preview, the level switch, and a
   * folder-named group created with Enter.
   *
   * Steps:
   * 1. Open the seeded window and wait for the app; `beat()`.
   * 2. Open the palette and run `Group: Create at Folder` (on the base ref,
   *    which lacks it, run `Tab: Create at Folder` and finish in the old
   *    dialog instead).
   * 3. Type the parent folder (autocomplete shows its folders), pick the demo
   *    folder with the arrow keys; `beat()` on the preview.
   * 4. Press Tab twice to show the level switch (Workspace, then back to
   *    Group, preview and button follow); `beat()`.
   * 5. Press Enter; on mobile open the navigation drawer; assert the sidebar
   *    lists the folder-named group; `beat()`.
   */
  test("create a group at a folder from the New sheet", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    const id = (await resolveWindow(page, TMUX_SERVER, SEED_SESSION, undefined)).windowId;
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    if (!isMobile) {
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
    } else {
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    }
    await beat(page);

    const palette = await openPalette(page);
    await palette.fill("Group: Create at Folder");
    const groupOption = page.getByRole("option", { name: /^Group: Create at Folder/ });
    if ((await groupOption.count()) === 0) {
      // Base ref: only the window-only dialog exists.
      await palette.fill("Tab: Create at Folder");
      await page.getByRole("option", { name: /^Tab: Create at Folder/ }).click();
      const path = page.getByRole("combobox", { name: "Project path" });
      await expect(path).toBeVisible({ timeout: READY_TIMEOUT });
      await path.pressSequentially(FOLDER_TILDE, { delay: 40 });
      await beat(page, 1_500);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await beat(page, 1_500);
      return;
    }
    await beat(page, 600);
    await groupOption.click();

    const sheet = page.getByRole("dialog", { name: "New" });
    await expect(sheet).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 1_500);

    const folder = sheet.getByRole("combobox", { name: "Folder" });
    await folder.pressSequentially(FOLDER_PARENT_TILDE, { delay: 40 });
    await expect(sheet.getByRole("option", { name: new RegExp(FOLDER_BASENAME) })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await beat(page, 1_200);
    await folder.press("ArrowDown");
    await folder.press("Enter");
    await expect(folder).toHaveValue(`${FOLDER_PARENT_TILDE}${FOLDER_BASENAME}/`);
    await expect(sheet.getByLabel("Preview")).toContainText(`New group ${GROUP}`);
    await beat(page, 1_800);

    await folder.press("Tab");
    await expect(sheet.getByRole("button", { name: /^Workspace/ })).toHaveAttribute("aria-pressed", "true");
    await beat(page, 1_500);
    await folder.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: /^Group/ })).toHaveAttribute("aria-pressed", "true");
    await beat(page, 1_200);

    await folder.press("Enter");
    await expect(sheet).toBeHidden();
    if (isMobile) {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
    }
    const nav = page.locator("nav[aria-label='Groups']");
    await expect(nav.getByText(GROUP, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_000);
  });
});
