/**
 * Demo: forking an agent tab from the `+ Tab` caret menu. On an agent tab the
 * menu's `IN <ws> › <group>` section offers `Fork tab` and `Fork tab in new
 * worktree` right after `Agent tab…`; on a plain shell tab it offers neither.
 * The worktree row opens the forked conversation in a NEW tab on a NEW
 * worktree + branch (the fork-worktree demo's endpoint, reached from the menu).
 *
 * Runs only under `just demo new-split-fork [--before]`
 * (playwright.demo.config.ts), against the throwaway e2e rig. Desktop uses the
 * sidebar head's split; mobile opens the drawer and uses the brand row's. The
 * `before` variant (DEMO_VARIANT, the base branch's SPA/backend) opens the same
 * menu on the agent tab, shows it has no fork rows, and stops.
 *
 * Shared setup: beforeAll builds a scratch git repo in a temp dir (branch
 * `feature/login`, one commit, an `app/` subdirectory) so `wt create` never
 * touches the real checkout, then launches the real `claude` CLI (Haiku, an
 * explicit `--session-id`) as window `login-agent` of session
 * `demo-newsplit-fork` on the rig's isolated tmux server, cwd `<repo>/app`, plus
 * a plain shell window `notes`. It answers the folder-trust dialog, stamps the
 * pane's `@rk_pane_agent_session` (the value the agent hooks would write), and
 * seeds the conversation with a codeword (skipped in the `before` variant,
 * which never forks). afterAll kills the session and removes the temp dir with
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
import { AGENTS, TMUX_SERVER, capturePane, createSession, killSession } from "./_agent-injection";
import { listWindows, newWindow, paneIdForWindow, sendKeysToPane } from "../e2e/_tmux";

const SESSION = "demo-newsplit-fork";
const WINDOW = "login-agent";
const SHELL_WINDOW = "notes";
const CODEWORD = "PELICAN-42";
const claude = AGENTS.find((a) => a.name === "claude")!;
const BEFORE = process.env.DEMO_VARIANT === "before";

// Fresh per beforeAll: each viewport project boots its own conversation, and
// claude refuses a --session-id that already exists.
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

async function ask(paneId: string, text: string): Promise<void> {
  sendKeysToPane(paneId, ["-l", text]);
  await delay(800);
  sendKeysToPane(paneId, ["Enter"]);
}

/** Wait for an agent reply line (claude's `●`/`⏺` bullet) carrying `re`. */
async function waitForReply(paneId: string, re: RegExp, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(paneId, { scrollback: true });
    if (last.split("\n").some((line) => /^\s*[●⏺]/.test(line) && re.test(line))) return;
    await delay(1_000);
  }
  throw new Error(`no reply matching ${re} in ${paneId}:\n${last.split("\n").slice(-40).join("\n")}`);
}

function checkoutOf(paneId: string): { path: string; branch: string; head: string } {
  const path = tmux(["display-message", "-p", "-t", paneId, "#{pane_current_path}"]);
  return { path, branch: git(path, ["branch", "--show-current"]), head: git(path, ["rev-parse", "--short", "HEAD"]) };
}

/** A fixed caption box (the fork-worktree demo idiom) — values read live from tmux/git. */
async function caption(page: Page, text: string, mobile: boolean): Promise<void> {
  await page.evaluate(({ body, mobile }) => {
    let label = document.getElementById("newsplit-fork-caption");
    if (!label) {
      label = document.createElement("div");
      label.id = "newsplit-fork-caption";
      Object.assign(label.style, {
        position: "fixed",
        left: mobile ? "8px" : "260px",
        right: "8px",
        ...(mobile ? { bottom: "8px" } : { bottom: "40px" }),
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

async function openWindow(page: Page, windowId: string, mobile: boolean): Promise<void> {
  if (!mobile) return gotoWindow(page, TMUX_SERVER, windowId);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Open the `+ Tab` caret menu: the sidebar head's on desktop, the drawer
 *  brand row's on mobile. */
async function openNewMenu(page: Page, mobile: boolean) {
  let scope = page.locator("body");
  if (mobile) {
    // The drawer can come back open after a navigation (it was open for the
    // previous menu), and the hamburger TOGGLES — so open it only when shut.
    scope = page.getByRole("navigation", { name: "Groups" });
    const caret = scope.getByTestId("new-split-caret");
    if (!(await caret.isVisible())) await page.getByRole("button", { name: "Toggle navigation" }).tap();
    await caret.tap({ timeout: 10_000 });
  } else {
    await page.getByTestId("new-split-caret").click();
  }
  const menu = scope.getByTestId("new-split-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Agent tab…" })).toBeVisible();
  return menu;
}

test.describe("new-split-fork demo", () => {
  // A cold Claude boot, a seed turn, a worktree fork (wt create + a second cold
  // boot).
  test.setTimeout(900_000);

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    root = mkdtempSync(join(tmpdir(), "rk-newsplit-fork-demo-"));
    repo = join(root, "acme-app");
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app", "login.ts"), "export const login = () => true;\n");
    git(root, ["init", "-q", "-b", "feature/login", repo]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "login screen"]);

    const sessionId = randomUUID();
    createSession(SESSION);
    newWindow(SESSION, WINDOW, { cwd: join(repo, "app"), command: `claude --model haiku --session-id ${sessionId}` });
    newWindow(SESSION, SHELL_WINDOW, { cwd: join(repo, "app") });
    const keep = new Set([WINDOW, SHELL_WINDOW]);
    for (const w of listWindows(SESSION)) {
      if (!keep.has(w.name)) tmux(["kill-window", "-t", w.windowId]);
    }
    const paneId = paneIdForWindow(listWindows(SESSION).find((w) => w.name === WINDOW)!.windowId);
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
   * Proves: the `+ Tab` menu offers the fork pair on an agent tab and not on a
   * plain shell tab, and `Fork tab in new worktree` opens the forked
   * conversation in a new tab on a new worktree + branch at the source HEAD.
   *
   * Before (base branch): the agent tab's menu has no fork rows.
   *
   * Steps:
   * 1. Open the plain shell tab; open the menu; assert no fork rows (After only).
   * 2. Open the agent tab; open the menu. Before: assert no fork rows, caption,
   *    stop. After: assert `Fork tab` / `Fork tab in new worktree` follow
   *    `Agent tab…`.
   * 3. Click `Fork tab in new worktree`; the app navigates to `login-agent-fork`.
   * 4. Caption the source-vs-fork checkout; assert path/branch differ, HEAD same.
   * 5. Assert the fork's pane shows the source's seed turn (the codeword
   *    prompt and its OK reply) — the resumed conversation.
   */
  test("fork an agent tab from the + Tab menu", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const viewport = `${BEFORE ? "Before" : "After"} · ${info.project.name}`;
    const source = listWindows(SESSION).find((w) => w.name === WINDOW)!;
    const shell = listWindows(SESSION).find((w) => w.name === SHELL_WINDOW)!;
    const sourcePane = paneIdForWindow(source.windowId);
    const before = checkoutOf(sourcePane);

    if (!BEFORE) {
      await openWindow(page, shell.windowId, mobile);
      await caption(page, `${viewport}\nPlain shell tab "${SHELL_WINDOW}": the + Tab menu has no fork rows`, mobile);
      const shellMenu = await openNewMenu(page, mobile);
      await expect(shellMenu.getByRole("menuitem", { name: /Fork tab/ })).toHaveCount(0);
      await beat(page, 3_000);
      await page.keyboard.press("Escape");
    }

    await openWindow(page, source.windowId, mobile);
    await caption(page, `${viewport}\nAgent tab "${WINDOW}"\n  worktree  ${before.path}\n  branch    ${before.branch}\n  HEAD      ${before.head}`, mobile);
    await beat(page, 2_000);
    const menu = await openNewMenu(page, mobile);

    if (BEFORE) {
      await expect(menu.getByRole("menuitem", { name: /Fork tab/ })).toHaveCount(0);
      await caption(page, `${viewport}\nAgent tab "${WINDOW}": the + Tab menu offers no way to fork it`, mobile);
      await beat(page, 5_000);
      return;
    }

    const labels = await menu.getByRole("menuitem").allTextContents();
    const agentIdx = labels.findIndex((l) => l.includes("Agent tab…"));
    expect(labels[agentIdx + 1]).toContain("Fork tab");
    expect(labels[agentIdx + 2]).toContain("Fork tab in new worktree");
    await caption(page, `${viewport}\nAgent tab "${WINDOW}": the + Tab menu offers\n  Fork tab · Fork tab in new worktree`, mobile);
    await beat(page, 3_000);

    const forkWt = menu.getByRole("menuitem", { name: "Fork tab in new worktree" });
    if (mobile) await forkWt.tap();
    else await forkWt.click();
    await expect(menu).toHaveCount(0);

    await expect
      .poll(() => listWindows(SESSION).some((w) => w.name === `${WINDOW}-fork`), { timeout: 90_000 })
      .toBe(true);
    const fork = listWindows(SESSION).find((w) => w.name === `${WINDOW}-fork`)!;
    await expect(page).toHaveURL(new RegExp(`/${fork.windowId.slice(1)}(?:$|[/?#])`), { timeout: 20_000 });
    const forkPane = paneIdForWindow(fork.windowId);
    await waitReady(forkPane);

    const after = checkoutOf(forkPane);
    expect(after.path).not.toBe(before.path);
    expect(after.branch).not.toBe(before.branch);
    expect(after.head).toBe(before.head);
    await caption(
      page,
      [
        viewport,
        `FORK ${WINDOW}-fork (${fork.windowId})`,
        `  branch ${after.branch} · HEAD ${after.head}`,
        `  ${after.path}`,
        `SOURCE ${WINDOW} (${source.windowId})`,
        `  branch ${before.branch} · HEAD ${before.head}`,
      ].join("\n"),
      mobile,
    );
    await beat(page, 4_000);

    // The fork resumes the source conversation: its pane shows the seed turn
    // (the codeword prompt and the agent's OK), which only ever ran in the
    // source tab. (A fresh recall turn is the fork-worktree demo's proof; it
    // also costs a full cold-model turn.)
    await waitForReply(forkPane, /\bOK\b/, 60_000);
    expect(capturePane(forkPane, { scrollback: true })).toContain(CODEWORD);
    await caption(page, `${viewport}\nThe forked tab resumed the source conversation:\nits history shows the ${CODEWORD} turn from the source tab`, mobile);
    await beat(page, 4_000);
  });
});
