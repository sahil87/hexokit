/**
 * Demo: PR attribution on a reused git branch name, using real `gh` and real
 * worktrees of this repository. One worktree starts at origin/main with the
 * head-ref name of a historical merged PR; the positive control starts at a
 * second merged PR's own head commit under that PR's head-ref name.
 *
 * Shared setup runs independently for each desktop/mobile recording. beforeAll
 * selects two merged PRs whose head branches do not exist locally, creates the
 * temporary worktrees and branches, and opens one rig tmux window in each.
 * afterAll kills only that demo session and removes only the worktrees and
 * branches it created. The base and after backends run the same live GitHub
 * scenario; DEMO_VARIANT selects the expected stale or corrected behavior.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { gotoServerReady, READY_TIMEOUT } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession, listWindows, newWindow } from "../e2e/_tmux";
import { REPO_ROOT } from "./_agent-injection";

const SESSION = "demo-pr-branch-reuse";
const BEFORE = process.env.DEMO_VARIANT === "before";
const REUSED_WINDOW = "reused-name";
const CONTROL_WINDOW = "merged-control";

interface MergedPR {
  number: number;
  headRefName: string;
  headRefOid: string;
}

let root = "";
let reusedPath = "";
let controlPath = "";
let reusedPR: MergedPR;
let controlPR: MergedPR;
const branches: string[] = [];

function run(binary: string, args: string[], cwd = REPO_ROOT): string {
  return execFileSync(binary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branchExists(branch: string): boolean {
  try {
    run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function mergedCandidates(): Promise<MergedPR[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = run("gh", [
        "pr", "list", "--state", "merged", "--limit", "100",
        "--json", "number,headRefName,headRefOid",
      ]);
      const seen = new Set<string>();
      return (JSON.parse(out) as MergedPR[]).filter((pr) => {
        if (!pr.headRefName || pr.headRefName === "main" || !pr.headRefOid || seen.has(pr.headRefName)) return false;
        if (branchExists(pr.headRefName)) return false;
        seen.add(pr.headRefName);
        return true;
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(1_000 * (attempt + 1));
    }
  }
  throw lastError;
}

function addWorktree(branch: string, path: string, start: string): void {
  run("git", ["worktree", "add", "-b", branch, path, start]);
  branches.push(branch);
}

function tmux(args: string[]): void {
  run("tmux", ["-L", TMUX_SERVER, ...args]);
}

async function openNav(page: Page, mobile: boolean) {
  if (!mobile) return page.getByRole("navigation", { name: "Groups" });
  let drawer = page.getByRole("dialog");
  if (!(await drawer.isVisible().catch(() => false))) {
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
    await toggle.tap();
    drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible({ timeout: READY_TIMEOUT });
  }
  return drawer.getByRole("navigation", { name: "Groups" });
}

async function selectWindow(page: Page, windowId: string, mobile: boolean) {
  let nav = await openNav(page, mobile);
  const row = nav.locator(`[role='treeitem'][data-window-id='${windowId}']`);
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/${windowId.slice(1)}(?:$|[/?#])`), { timeout: READY_TIMEOUT });
  if (!mobile) await page.mouse.move(900, 400);
  nav = await openNav(page, mobile);
  return nav.locator(`[role='treeitem'][data-window-id='${windowId}']`);
}

test.describe("pr-branch-reuse demo", () => {
  test.setTimeout(480_000);

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const candidates = await mergedCandidates();
    if (candidates.length < 2) {
      throw new Error("need two historical merged PRs with unused, non-main head branch names");
    }
    [reusedPR, controlPR] = candidates;
    root = mkdtempSync(join(tmpdir(), "rk-pr-branch-reuse-"));
    reusedPath = join(root, "reused");
    controlPath = join(root, "control");
    addWorktree(reusedPR.headRefName, reusedPath, "origin/main");
    run("git", ["fetch", "origin", `pull/${controlPR.number}/head`]);
    addWorktree(controlPR.headRefName, controlPath, "FETCH_HEAD");

    createSession(SESSION);
    newWindow(SESSION, REUSED_WINDOW, { cwd: reusedPath, command: "sleep 600" });
    newWindow(SESSION, CONTROL_WINDOW, { cwd: controlPath, command: "sleep 600" });
    for (const w of listWindows(SESSION)) {
      if (w.name !== REUSED_WINDOW && w.name !== CONTROL_WINDOW) tmux(["kill-window", "-t", w.windowId]);
    }
  });

  test.afterAll(() => {
    killSession(SESSION);
    for (const path of [reusedPath, controlPath]) {
      if (!path) continue;
      try {
        run("git", ["worktree", "remove", "--force", path]);
      } catch {
        // Best-effort cleanup continues with the other temporary branch.
      }
    }
    for (const branch of branches.splice(0)) {
      try {
        run("git", ["branch", "-D", branch]);
      } catch {
        // Best-effort cleanup never removes a pre-existing branch.
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Proves: a fresh branch reusing a historical merged PR's head-ref name does
   * not inherit that PR after the fix, while a control branch containing its
   * own merged PR head keeps the merged glyph and PANE register in both runs.
   * The base run shows the stale attribution on the reused-name branch.
   *
   * Steps:
   * 1. Open the rig server and enable the PANE register.
   * 2. Select the positive-control row; wait for its real merged PR glyph and
   *    PANE entry in both variants, proving the resolver has completed a pass.
   * 3. Select the reused-name row. Before: its historical merged PR appears.
   *    After: neither its glyph nor a PANE PR entry appears.
   */
  test("reused branch name does not inherit a historical merged PR", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    if (mobile) {
      await page.goto(`/${TMUX_SERVER}`);
      await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
    } else {
      await gotoServerReady(page, TMUX_SERVER, SESSION);
    }
    await openNav(page, mobile);
    await page.getByRole("button", { name: "Toggle Pane section" }).click();

    const controlId = listWindows(SESSION).find((w) => w.name === CONTROL_WINDOW)!.windowId;
    const controlRow = await selectWindow(page, controlId, mobile);
    await expect(controlRow.getByTestId("row-pr-glyph")).toBeVisible({ timeout: 180_000 });
    const controlLine = page.getByTestId("pr-line");
    await expect(controlLine).toHaveText(`#${controlPR.number} · merged`, { timeout: 180_000 });
    await controlLine.scrollIntoViewIfNeeded();
    await beat(page, 4_000);

    const reusedId = listWindows(SESSION).find((w) => w.name === REUSED_WINDOW)!.windowId;
    const reusedRow = await selectWindow(page, reusedId, mobile);
    const reusedLine = page.getByTestId("pr-line");
    if (BEFORE) {
      await expect(reusedRow.getByTestId("row-pr-glyph")).toBeVisible({ timeout: 60_000 });
      await expect(reusedLine).toHaveText(`#${reusedPR.number} · merged`, { timeout: 60_000 });
      await reusedLine.scrollIntoViewIfNeeded();
    } else {
      await expect(reusedLine).toHaveCount(0);
      await expect(reusedRow.getByTestId("row-pr-glyph")).toHaveCount(0);
      await reusedRow.scrollIntoViewIfNeeded();
    }
    await beat(page, 5_000);
  });
});
