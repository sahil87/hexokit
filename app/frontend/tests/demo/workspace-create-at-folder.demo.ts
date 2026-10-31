/**
 * Demo: creating a workspace at a folder, recorded for PR evidence. The
 * "New workspace" dialog gains an optional Folder field; picking a folder
 * names the workspace after it and the resulting first group (shown in the
 * sidebar) is named after the folder instead of the legacy "0".
 *
 * Runs only under `just demo workspace-create-at-folder` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). The `--before` pass runs against the
 * base ref, where the dialog has no folder field: the spec then creates the
 * workspace by name only and the sidebar shows the legacy "0" group.
 *
 * Shared setup: beforeAll makes a real folder under $HOME (the backend only
 * accepts paths under home); afterAll removes it and kills the created
 * workspaces (named inside the worktree's TMUX_FAMILY).
 */
import { test, expect, beat } from "./_demo";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_FAMILY, killServer } from "../e2e/_tmux";

const SUFFIX = `${process.pid}-${Date.now().toString().slice(-6)}`;
const FOLDER_ROOT = join(homedir(), ".cache", "rk-demo-qm52");
const FOLDER_BASENAME = "hexokit-demo";
const FOLDER_TILDE = `~/.cache/rk-demo-qm52/${FOLDER_BASENAME}`;
const WORKSPACE = `${TMUX_FAMILY}qmd-${SUFFIX}`;

test.describe("workspace-create-at-folder demo", () => {
  test.beforeAll(() => {
    mkdirSync(join(FOLDER_ROOT, FOLDER_BASENAME), { recursive: true });
  });

  test.afterAll(() => {
    killServer(WORKSPACE);
    rmSync(FOLDER_ROOT, { recursive: true, force: true });
  });

  /**
   * Proves: a reviewer can see the New workspace dialog's Folder field, the
   * name following the folder, and the first group named after the folder.
   *
   * Steps:
   * 1. Open the host page and click `+ New workspace`; `beat()`.
   * 2. If the Folder field exists: type the folder (the name prefills from
   *    it); `beat()`. Otherwise (the base ref) type the workspace name.
   * 3. Submit with `Create`; wait for the new workspace route.
   * 4. On mobile open the navigation drawer; assert the sidebar lists the
   *    folder-named group (or the legacy "0" on the base ref); `beat()`.
   */
  test("the first group is named after the chosen folder", async ({ page }, testInfo) => {
    const isMobile = testInfo.project.name === "mobile";
    await page.goto("/");
    await page.getByRole("button", { name: "+ New workspace" }).click();
    const nameInput = page.getByRole("textbox", { name: "Workspace name" });
    await expect(nameInput).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page);

    const folderInput = page.getByRole("combobox", { name: "Workspace folder" });
    const hasFolderField = (await folderInput.count()) > 0;
    let expectedGroup = "0";
    if (hasFolderField) {
      await folderInput.pressSequentially(FOLDER_TILDE, { delay: 40 });
      await expect(nameInput).toHaveValue(FOLDER_BASENAME.replace(/-/g, "_"));
      expectedGroup = FOLDER_BASENAME.replace(/-/g, "_");
      await beat(page, 1_500);
    }
    await nameInput.fill(WORKSPACE);
    await beat(page, 800);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${WORKSPACE}(?:$|[/?#])`));

    if (isMobile) {
      const toggle = page.getByRole("button", { name: "Toggle navigation" });
      await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
      await toggle.click();
    }
    const nav = page.locator("nav[aria-label='Groups']");
    await expect(nav.getByText(expectedGroup, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await beat(page, 2_000);
  });
});
