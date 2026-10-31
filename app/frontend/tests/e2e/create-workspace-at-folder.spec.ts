import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { READY_TIMEOUT } from "./_ready";
import { TMUX_FAMILY, killServer } from "./_tmux";

/**
 * Behavioural contract for creating a workspace at a folder: the "New
 * workspace" dialog's optional folder field makes the workspace's first group
 * start in that folder and take its name — and a workspace created without a
 * folder keeps the legacy "0" group.
 *
 * Shared setup: a real folder under $HOME (the backend only accepts paths
 * under home) is made in `beforeAll` and removed in `afterAll`, along with the
 * two workspaces the tests create. Workspace names live in this worktree's
 * `TMUX_FAMILY` so the family-anchored teardown reaps them even if `afterAll`
 * is missed. Desktop viewport (1024×768).
 */

const SUFFIX = `${process.pid}-${Date.now().toString().slice(-6)}`;
// The folder basename contains "-" and "." so the derived group name proves
// the unsafe-char conversion end to end.
const FOLDER_BASENAME = `qm52-folder.${process.pid}`;
const FOLDER_GROUP = `qm52_folder_${process.pid}`;
const FOLDER_ABS = join(homedir(), ".cache", "rk-e2e-qm52", FOLDER_BASENAME);
const FOLDER_TILDE = `~/.cache/rk-e2e-qm52/${FOLDER_BASENAME}`;
const WS_AT_FOLDER = `${TMUX_FAMILY}qmf-${SUFFIX}`;
const WS_LEGACY = `${TMUX_FAMILY}qml-${SUFFIX}`;

function tmuxSessions(server: string): { name: string; path: string }[] {
  const out = execFileSync("tmux", ["-L", server, "list-sessions", "-F", "#{session_name}\t#{session_path}"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, path] = line.split("\t");
      return { name, path };
    });
}

test.describe("Create workspace at a folder", () => {
  test.beforeAll(() => {
    mkdirSync(FOLDER_ABS, { recursive: true });
  });

  test.afterAll(() => {
    killServer(WS_AT_FOLDER);
    killServer(WS_LEGACY);
    rmSync(join(homedir(), ".cache", "rk-e2e-qm52"), { recursive: true, force: true });
  });

  /**
   * Proves: picking a folder in the New workspace dialog names the first
   * group after the folder (unsafe chars → "_") and starts it there, with the
   * workspace name following the folder until edited — and no "0" group.
   *
   * Steps:
   * 1. Open the host page and click `+ New workspace`.
   * 2. Type the folder into the `Workspace folder` field.
   * 3. Overwrite the name with the test workspace name; click `Create`.
   * 4. Assert the URL lands on the new workspace and the sidebar lists a group
   *    named after the folder, and tmux has exactly that session at the folder.
   */
  test("the first group is named after the folder, not 0", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/");

    await page.getByRole("button", { name: "+ New workspace" }).click();
    const nameInput = page.getByRole("textbox", { name: "Workspace name" });
    const folderInput = page.getByRole("combobox", { name: "Workspace folder" });
    await expect(nameInput).toBeVisible({ timeout: READY_TIMEOUT });

    await folderInput.fill(FOLDER_TILDE);
    // The name followed the folder; overwrite it with the family-anchored name.
    await expect(nameInput).toHaveValue(FOLDER_GROUP);
    await nameInput.fill(WS_AT_FOLDER);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${WS_AT_FOLDER}(?:$|[/?#])`));
    const nav = page.locator("nav[aria-label='Groups']");
    await expect(nav.getByText(FOLDER_GROUP, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const sessions = tmuxSessions(WS_AT_FOLDER);
    expect(sessions.map((s) => s.name)).toEqual([FOLDER_GROUP]);
    expect(sessions[0].path).toBe(FOLDER_ABS);
  });

  /**
   * Proves: a blank folder keeps the legacy behavior — the first group is "0".
   *
   * Steps:
   * 1. Open the host page, click `+ New workspace`, fill only the name.
   * 2. Click `Create`; assert tmux has a single session named "0".
   */
  test("a blank folder keeps the legacy '0' group", async ({ page }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/");

    await page.getByRole("button", { name: "+ New workspace" }).click();
    const nameInput = page.getByRole("textbox", { name: "Workspace name" });
    await expect(nameInput).toBeVisible({ timeout: READY_TIMEOUT });
    await nameInput.fill(WS_LEGACY);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${WS_LEGACY}(?:$|[/?#])`));
    await expect
      .poll(() => tmuxSessions(WS_LEGACY).map((s) => s.name), { timeout: READY_TIMEOUT })
      .toEqual(["0"]);
  });
});
