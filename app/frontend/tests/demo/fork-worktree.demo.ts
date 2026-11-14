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
 * Shared setup: beforeAll calls setupForkSource (_fork-demo.ts) — a scratch
 * git repo in a temp dir (branch `feature/login`, an `app/` subdirectory) and
 * the real `claude` CLI (Haiku) as window `login-agent` of session
 * `demo-fork-wt` on the rig's isolated tmux server, cwd `<repo>/app`, its pane
 * stamped with `@rk_pane_agent_session` — and seeds the conversation with a
 * codeword (skipped in the `before` variant, which never forks). afterAll
 * kills the session and removes the temp dir together with every worktree
 * created under it.
 */
import { rmSync } from "node:fs";
import { test, expect, beat } from "./_demo";
import { killSession } from "./_agent-injection";
import { listWindows, paneIdForWindow } from "../e2e/_tmux";
import { ask, caption, git, openCard, openWindow, setupForkSource, tmux, waitForReply, waitReady } from "./_fork-demo";

const SESSION = "demo-fork-wt";
const WINDOW = "login-agent";
const CODEWORD = "PELICAN-42";
const BEFORE = process.env.DEMO_VARIANT === "before";

let root = "";
let repo = "";

function checkoutOf(paneId: string): { path: string; branch: string; head: string } {
  const path = tmux(["display-message", "-p", "-t", paneId, "#{pane_current_path}"]);
  return {
    path,
    branch: git(path, ["branch", "--show-current"]),
    head: git(path, ["rev-parse", "--short", "HEAD"]),
  };
}

test.describe("fork-worktree demo", () => {
  // A cold Claude boot, a seed turn, a worktree fork (wt create + a second cold
  // boot) and a continuation turn.
  test.setTimeout(600_000);

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    // The before variant never forks, so it skips the seed turn.
    const source = await setupForkSource(
      SESSION,
      WINDOW,
      BEFORE ? undefined : { prompt: `Remember the codeword ${CODEWORD}. Without tools, reply with only OK.`, reply: /\bOK\b/ },
    );
    root = source.root;
    repo = source.repo;
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
