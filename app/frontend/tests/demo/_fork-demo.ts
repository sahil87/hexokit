/**
 * Shared helpers for the conversation-fork demos (fork-worktree.demo.ts,
 * fork-loader.demo.ts): the scratch-repo + live-claude source window, pane
 * waits, the caption box, and the per-viewport card/window openers. Every
 * value a caption shows is read live from tmux/git by the caller.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect } from "./_demo";
import { READY_TIMEOUT, gotoWindow } from "../e2e/_ready";
import { AGENTS, TMUX_SERVER, capturePane, createSession } from "./_agent-injection";
import { listWindows, newWindow, paneIdForWindow, sendKeysToPane } from "../e2e/_tmux";

const claude = AGENTS.find((a) => a.name === "claude")!;

export function tmux(args: string[]): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=demo@rk", "-c", "user.name=demo", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

/** Wait for a pane's agent composer, answering the folder-trust dialog. */
export async function waitReady(paneId: string, timeoutMs = 90_000): Promise<void> {
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
export async function ask(paneId: string, text: string): Promise<void> {
  sendKeysToPane(paneId, ["-l", text]);
  await delay(800);
  sendKeysToPane(paneId, ["Enter"]);
}

/** Wait until `count` agent reply lines (claude's `●`/`⏺` bullet) carry `re`.
 *  The bullet anchor excludes the prompt echo (`❯ …`), which wraps
 *  unpredictably and, in the fork, replays the seed prompt. */
export async function waitForReply(paneId: string, re: RegExp, count = 1, timeoutMs = 300_000): Promise<string> {
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

/** A fixed caption box (the codex demo idiom) — every value in it is read live from tmux/git. */
export async function caption(page: Page, text: string, mobile: boolean): Promise<void> {
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
export async function openWindow(page: Page, windowId: string, mobile: boolean): Promise<void> {
  if (!mobile) return gotoWindow(page, TMUX_SERVER, windowId);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Open the source row's flyout card: hover on desktop; on mobile open the
 *  drawer and tap the row's status rail (the coarse-pointer flyout target). */
export async function openCard(page: Page, windowId: string, mobile: boolean) {
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

export type ForkSource = { root: string; repo: string; sessionId: string; windowId: string; paneId: string };

/**
 * The shared fork-demo source: a scratch git repo in a temp dir (branch
 * `feature/login`, one commit, an `app/` subdirectory) so `wt create` never
 * touches the real checkout, and the real `claude` CLI (Haiku, an explicit
 * `--session-id`, so each call boots a fresh conversation) as the only window
 * `windowName` of tmux session `session` on the rig's isolated server, cwd
 * `<repo>/app`. Answers the folder-trust dialog, stamps the pane's
 * `@rk_pane_agent_session` (the value the agent hooks would write) and, when
 * `seed` is given, sends it as the first turn and waits for `seedReply` — a
 * fork needs a conversation on disk to resume. Remove `root` in afterAll; it
 * holds every worktree created under it.
 */
export async function setupForkSource(
  session: string,
  windowName: string,
  seed?: { prompt: string; reply: RegExp },
): Promise<ForkSource> {
  const root = mkdtempSync(join(tmpdir(), "rk-fork-demo-"));
  const repo = join(root, "acme-app");
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app", "login.ts"), "export const login = () => true;\n");
  git(root, ["init", "-q", "-b", "feature/login", repo]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "login screen"]);

  const sessionId = randomUUID();
  createSession(session);
  newWindow(session, windowName, {
    cwd: join(repo, "app"),
    command: `claude --model haiku --session-id ${sessionId}`,
  });
  const win = listWindows(session).find((w) => w.name === windowName)!;
  for (const w of listWindows(session)) {
    if (w.windowId !== win.windowId) tmux(["kill-window", "-t", w.windowId]);
  }
  const paneId = paneIdForWindow(win.windowId);
  await waitReady(paneId);
  tmux(["set-option", "-p", "-t", paneId, "@rk_pane_agent_session", `claude:${sessionId}`]);
  if (seed) {
    await ask(paneId, seed.prompt);
    await waitForReply(paneId, seed.reply);
  }
  return { root, repo, sessionId, windowId: win.windowId, paneId };
}
