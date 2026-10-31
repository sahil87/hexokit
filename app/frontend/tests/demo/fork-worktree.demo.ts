/**
 * Demo: forking an agent conversation into a NEW worktree on a NEW branch from
 * the sidebar row's hover card. The forked tab is a separate tmux window
 * rooted in its own checkout, and its agent continues the source conversation.
 *
 * Runs only under `just demo fork-worktree [--before]`
 * (playwright.demo.config.ts), against the throwaway e2e rig. Desktop opens the
 * card by hovering the row; mobile opens the drawer and taps the row's status
 * rail (the coarse-pointer flyout target). The `before` variant (DEMO_VARIANT,
 * the base branch's SPA/backend) opens the same card and shows it offers only
 * "Fork conversation" — no worktree fork — then stops.
 *
 * Shared setup: beforeAll builds a scratch git repo in a temp dir (branch
 * `feature/login`, one commit, an `app/` subdirectory) so `wt create` never
 * touches the real checkout, then launches the real `claude` CLI (Haiku, an
 * explicit `--session-id`) as window `login-agent` of session `demo-fork-wt` on
 * the rig's isolated tmux server, cwd `<repo>/app`. It answers the folder-trust
 * dialog, stamps the pane's `@rk_pane_agent_session` with that session id (the
 * value the agent hooks would write), and seeds the conversation with a
 * codeword (skipped in the `before` variant, which never forks). afterAll kills the session and removes the temp dir together with
 * every worktree created under it.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { READY_TIMEOUT, gotoWindow } from "../e2e/_ready";
import {
  AGENTS,
  TMUX_SERVER,
  capturePane,
  createSession,
  killSession,
} from "./_agent-injection";
import { listWindows, newWindow, paneIdForWindow, sendKeysToPane } from "../e2e/_tmux";

const SESSION = "demo-fork-wt";
const WINDOW = "login-agent";
const CODEWORD = "PELICAN-42";
const claude = AGENTS.find((a) => a.name === "claude")!;
const BEFORE = process.env.DEMO_VARIANT === "before";

// Fresh per beforeAll: each viewport project boots its own conversation, and
// claude refuses a --session-id that already exists.
let sessionId = "";
let root = "";
let repo = "";

function tmux(args: string[]): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=demo@rk", "-c", "user.name=demo", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

/** Wait for a pane's agent composer, answering the folder-trust dialog. */
async function waitReady(paneId: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(paneId);
    if (claude.trustPrompt?.test(last) && claude.trustKeys) sendKeysToPane(paneId, claude.trustKeys);
    else if (claude.ready.test(last)) return;
    await delay(500);
  }
  throw new Error(`claude not ready in ${paneId}:\n${last.split("\n").slice(-12).join("\n")}`);
}

/** Type a prompt into a pane's composer and submit it. */
async function ask(paneId: string, text: string): Promise<void> {
  sendKeysToPane(paneId, ["-l", text]);
  await delay(800);
  sendKeysToPane(paneId, ["Enter"]);
}

/** Wait until `count` agent reply lines (claude's `●`/`⏺` bullet) carry `re`.
 *  The bullet anchor excludes the prompt echo (`❯ …`), which wraps
 *  unpredictably and, in the fork, replays the seed prompt. */
async function waitForReply(paneId: string, re: RegExp, count = 1, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(paneId, { scrollback: true });
    const replies = last.split("\n").filter((line) => /^\s*[●⏺]/.test(line) && re.test(line));
    if (replies.length >= count) return last;
    await delay(1_000);
  }
  const shown = last.split("\n").filter((line) => line.trim() !== "").slice(-40).join("\n");
  throw new Error(`no reply matching ${re} in ${paneId}:\n${shown}`);
}

function checkoutOf(paneId: string): { path: string; branch: string; head: string } {
  const path = tmux(["display-message", "-p", "-t", paneId, "#{pane_current_path}"]);
  return {
    path,
    branch: git(path, ["branch", "--show-current"]),
    head: git(path, ["rev-parse", "--short", "HEAD"]),
  };
}

/** A fixed caption box (the codex demo idiom) — every value in it is read live from tmux/git. */
async function caption(page: Page, text: string, mobile: boolean): Promise<void> {
  await page.evaluate(({ body, mobile }) => {
    let label = document.getElementById("fork-demo-caption");
    if (!label) {
      label = document.createElement("div");
      label.id = "fork-demo-caption";
      // Mobile pins it to the top so the reply above the composer stays visible.
      Object.assign(label.style, {
        position: "fixed",
        left: mobile ? "8px" : "260px",
        right: "8px",
        ...(mobile ? { top: "56px" } : { bottom: "40px" }),
        zIndex: "2147483647",
        padding: mobile ? "8px" : "12px",
        background: "#12151e",
        color: "#fff",
        border: "1px solid #7e899c",
        font: mobile ? "11px/1.4 monospace" : "13px/1.5 monospace",
        whiteSpace: mobile ? "pre-wrap" : "pre",
        overflowWrap: "anywhere",
        pointerEvents: "none",
      });
      document.body.appendChild(label);
    }
    label.textContent = body;
  }, { body: text, mobile });
}

/** Open a window's terminal route. Desktop gates on the status bar's
 *  Connected dot (gotoWindow); mobile has no status bar, so it gates on the
 *  hamburger and the terminal (the window-switch demo idiom). */
async function openWindow(page: Page, windowId: string, mobile: boolean): Promise<void> {
  if (!mobile) return gotoWindow(page, TMUX_SERVER, windowId);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Open the source row's flyout card: hover on desktop; on mobile open the
 *  drawer and tap the row's status rail (the coarse-pointer flyout target). */
async function openCard(page: Page, windowId: string, mobile: boolean) {
  const row = page.locator(`[role='treeitem'][data-window-id='${windowId}']`);
  if (mobile) {
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByTestId("status-rail").tap();
  } else {
    await row.hover();
  }
  const card = page.getByTestId("row-flyout-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("row-flyout-fork-action")).toBeVisible();
  return card;
}

test.describe("fork-worktree demo", () => {
  // A cold Claude boot, a seed turn, a worktree fork (wt create + a second cold
  // boot) and a continuation turn.
  test.setTimeout(600_000);

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    root = mkdtempSync(join(tmpdir(), "rk-fork-demo-"));
    repo = join(root, "acme-app");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "login.ts"), "export const login = () => true;\n");
    git(root, ["init", "-q", "-b", "feature/login", repo]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "login screen"]);

    sessionId = randomUUID();
    createSession(SESSION);
    newWindow(SESSION, WINDOW, {
      cwd: join(repo, "app"),
      command: `claude --model haiku --session-id ${sessionId}`,
    });
    const win = listWindows(SESSION).find((w) => w.name === WINDOW)!;
    for (const w of listWindows(SESSION)) {
      if (w.windowId !== win.windowId) tmux(["kill-window", "-t", w.windowId]);
    }
    const paneId = paneIdForWindow(win.windowId);
    await waitReady(paneId);
    tmux(["set-option", "-p", "-t", paneId, "@rk_pane_agent_session", `claude:${sessionId}`]);
    if (BEFORE) return;
    await ask(paneId, `Remember the codeword ${CODEWORD}. Without tools, reply with only OK.`);
    await waitForReply(paneId, /\bOK\b/);
  });

  test.afterAll(() => {
    killSession(SESSION);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Proves: hovering an agent tab's sidebar row shows "Fork to new worktree";
   * clicking it opens a NEW tab whose checkout is a NEW worktree on a NEW
   * branch (started at the source's commit, same `app/` subdirectory), while
   * the source tab keeps its own worktree and branch — two separate tabs —
   * and the forked agent continues the source conversation (it recalls the
   * codeword it was only ever told in the source tab).
   *
   * Before (base branch): the same card offers only "Fork conversation" —
   * there is no way to fork into a new worktree + branch.
   *
   * Steps:
   * 1. Open the source tab; caption its worktree path, branch and HEAD.
   * 2. Open the source row's card (desktop: hover; mobile: drawer + rail tap);
   *    it shows "Fork conversation". Before: assert there is no worktree fork
   *    row, caption that, and stop. After: assert "Fork to new worktree" is
   *    the next row; on desktop hover it so its tooltip reads.
   * 3. Click/tap it; the app navigates to the new `login-agent-fork` tab.
   * 4. Answer the folder-trust dialog in the new worktree; caption the
   *    source-vs-fork comparison (path, branch, HEAD) and assert they differ in
   *    path and branch, share HEAD, and both appear in `git worktree list`.
   * 5. Ask the forked agent for the codeword; it answers PELICAN-42.
   * 6. Return to the source tab, still on its own worktree and branch.
   */
  test("fork a conversation into a new worktree + branch", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const viewport = `${BEFORE ? "Before" : "After"} · ${info.project.name}`;
    const source = listWindows(SESSION).find((w) => w.name === WINDOW)!;
    const sourcePane = paneIdForWindow(source.windowId);
    const before = checkoutOf(sourcePane);

    await openWindow(page, source.windowId, mobile);
    await caption(page, `${viewport}\nSource tab: ${WINDOW}\n  worktree  ${before.path}\n  branch    ${before.branch}\n  HEAD      ${before.head}${BEFORE ? "" : `\n  agent was told the codeword ${CODEWORD}`}`, mobile);
    await beat(page, 3_000);

    const card = await openCard(page, source.windowId, mobile);
    const forkWt = card.getByTestId("row-flyout-fork-worktree-action");
    if (BEFORE) {
      await expect(forkWt).toHaveCount(0);
      await caption(
        page,
        `${viewport}\nThe card offers only "Fork conversation" (new tab, SAME worktree + branch).\nNo way to fork into a new worktree + branch.`,
        mobile,
      );
      await beat(page, 5_000);
      return;
    }
    await expect(forkWt).toBeVisible();
    await beat(page, 1_500);
    if (mobile) {
      await forkWt.tap();
    } else {
      await forkWt.hover();
      await beat(page, 2_000);
      await forkWt.click();
      // Park the pointer over the terminal so the hover card closes and the
      // forked tab's terminal is fully visible.
      await page.mouse.move(900, 400);
    }
    await expect(card).toHaveCount(0);

    await expect
      .poll(() => listWindows(SESSION).some((w) => w.name === `${WINDOW}-fork`), { timeout: 90_000 })
      .toBe(true);
    const fork = listWindows(SESSION).find((w) => w.name === `${WINDOW}-fork`)!;
    // The window route carries the id without its `@` (`@9` → `/9`).
    await expect(page).toHaveURL(new RegExp(`/${fork.windowId.slice(1)}(?:$|[/?#])`), { timeout: 20_000 });
    const forkPane = paneIdForWindow(fork.windowId);
    await waitReady(forkPane);

    const after = checkoutOf(forkPane);
    const worktrees = git(repo, ["worktree", "list"]);
    expect(after.path).not.toBe(before.path);
    expect(after.branch).not.toBe(before.branch);
    expect(after.head).toBe(before.head);
    expect(after.path.endsWith("/app")).toBe(true);
    expect(worktrees).toContain(before.path.replace(/\/app$/, ""));
    expect(worktrees).toContain(after.path.replace(/\/app$/, ""));
    expect(source.windowId).not.toBe(fork.windowId);

    const comparison = mobile
      ? [
          viewport,
          `SOURCE ${WINDOW} (${source.windowId})`,
          `  branch ${before.branch} · HEAD ${before.head}`,
          `  ${before.path}`,
          `FORK ${WINDOW}-fork (${fork.windowId})`,
          `  branch ${after.branch} · HEAD ${after.head}`,
          `  ${after.path}`,
        ]
      : [
          viewport,
          `            source tab (${source.windowId})        forked tab (${fork.windowId})`,
          `window      ${WINDOW.padEnd(28)}${WINDOW}-fork`,
          `branch      ${before.branch.padEnd(28)}${after.branch}`,
          `HEAD        ${before.head.padEnd(28)}${after.head}`,
          `worktree    ${before.path}`,
          `            → ${after.path}`,
        ];
    await caption(page, comparison.join("\n"), mobile);
    await beat(page, 5_000);

    await ask(forkPane, "What codeword did I ask you to remember? Without tools, reply with only the codeword.");
    await waitForReply(forkPane, new RegExp(CODEWORD));
    await caption(
      page,
      `${viewport}\nForked tab ${WINDOW}-fork on branch ${after.branch}\ncontinues the source conversation: it recalled ${CODEWORD}\n(the codeword was only ever given in the source tab)`,
      mobile,
    );
    await beat(page, 5_000);

    await openWindow(page, source.windowId, mobile);
    const sourceNow = checkoutOf(sourcePane);
    expect(sourceNow.branch).toBe(before.branch);
    expect(sourceNow.path).toBe(before.path);
    await caption(page, `${viewport}\nBack on the source tab ${WINDOW}: untouched\n  worktree  ${sourceNow.path}\n  branch    ${sourceNow.branch}`, mobile);
    await beat(page, 3_000);
  });
});
