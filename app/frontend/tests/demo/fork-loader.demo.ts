/**
 * Demo: the in-flight feedback of "Fork to new worktree". After the click the
 * row shows the LogoSpinner with a "creating worktree…" hint, and a placeholder
 * `<name>-fork` row sits in the sidebar until the real tab replaces it — so the
 * fork stays visible after the hover card closes.
 *
 * Runs only under `just demo fork-loader [--before]` (playwright.demo.config.ts),
 * against the throwaway e2e rig, with a REAL fork (wt create + claude
 * --resume --fork-session). The fork POST is held for HOLD_MS in the browser
 * before it reaches the backend, identically in both variants, so the
 * in-flight window is long enough to watch; the caption says so. The `before`
 * variant (DEMO_VARIANT, the base branch's SPA/backend) records the same click
 * on the old row (fade only, no placeholder).
 *
 * Shared setup: beforeAll calls setupForkSource (_fork-demo.ts) — a scratch
 * repo and a live `claude` (Haiku) window `login-agent` of session
 * `demo-fork-loader`, seeded with one turn so there is a conversation to fork.
 * afterAll kills the session and removes the temp dir with every worktree
 * created under it.
 */
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, beat } from "./_demo";
import { killSession } from "./_agent-injection";
import { listWindows, paneIdForWindow } from "../e2e/_tmux";
import { caption, openCard, openWindow, setupForkSource, waitReady } from "./_fork-demo";

const SESSION = "demo-fork-loader";
const WINDOW = "login-agent";
const HOLD_MS = 3_000;
const BEFORE = process.env.DEMO_VARIANT === "before";

let root = "";

test.describe("fork-loader demo", () => {
  test.setTimeout(300_000);

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    const source = await setupForkSource(SESSION, WINDOW, {
      prompt: "Add rate limiting to the login endpoint? Without tools, reply with only OK.",
      reply: /\bOK\b/,
    });
    root = source.root;
  });

  test.afterAll(() => {
    killSession(SESSION);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Proves: clicking "Fork to new worktree" gives immediate, lasting feedback —
   * the clicked row swaps its glyph for the LogoSpinner with a "creating
   * worktree…" hint, and a placeholder `login-agent-fork` row appears in the
   * sidebar and stays after the card closes, until the real tab replaces it
   * and the app opens it. Before (base branch): the row only fades and nothing
   * else shows until the tab appears.
   *
   * Steps:
   * 1. Hold the fork POST for HOLD_MS in the browser (both variants).
   * 2. Open the source tab; open its card (desktop: hover; mobile: drawer +
   *    rail tap); click/tap "Fork to new worktree".
   * 3. After: assert the placeholder row, plus (desktop) the row spinner and
   *    progress hint; on touch the tap closes the card, so assert it closed.
   *    Before: assert neither spinner nor placeholder exists.
   * 4. Desktop: move the pointer off the card; assert the card closes and
   *    (After) the placeholder row is still visible.
   * 5. Wait for the real `login-agent-fork` tab, the navigation to it and its
   *    agent's composer; caption the elapsed time.
   */
  test("worktree fork shows a loader until the new tab opens", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const viewport = `${BEFORE ? "Before" : "After"} · ${info.project.name}`;
    await page.route("**/api/windows/*/fork*", async (route) => {
      await delay(HOLD_MS);
      await route.continue();
    });
    const source = listWindows(SESSION).find((w) => w.name === WINDOW)!;

    await openWindow(page, source.windowId, mobile);
    await caption(page, `${viewport}\nClick “Fork to new worktree” (the fork request is held ${HOLD_MS / 1000} s so the wait is visible).`, mobile);
    await beat(page, 2_000);

    const card = await openCard(page, source.windowId, mobile);
    const forkWt = card.getByTestId("row-flyout-fork-worktree-action");
    await expect(forkWt).toBeVisible();
    if (!mobile) {
      await forkWt.hover();
      await beat(page, 800);
    }
    const clickedAt = Date.now();
    if (mobile) await forkWt.tap();
    else await forkWt.click();

    const ghost = page.locator("[role='treeitem'][data-window-id^='ghost-']");
    if (BEFORE) {
      await expect(forkWt.getByTestId("row-flyout-fork-spinner")).toHaveCount(0);
      await expect(ghost).toHaveCount(0);
      await caption(page, `${viewport}\nFork running: the row only fades. Nothing else shows progress.`, mobile);
    } else if (mobile) {
      // On touch, tapping a card action closes the card (existing behavior), so
      // the placeholder row is the whole signal there.
      await expect(card).toHaveCount(0);
      await expect(ghost).toContainText(`${WINDOW}-fork`);
      await caption(page, `${viewport}\nFork running: the tap closes the card; the placeholder “${WINDOW}-fork” pulses in the sidebar.`, mobile);
    } else {
      await expect(forkWt.getByTestId("row-flyout-fork-spinner")).toBeVisible();
      await expect(forkWt).toContainText("creating worktree…");
      await expect(ghost).toContainText(`${WINDOW}-fork`);
      await caption(page, `${viewport}\nFork running: spinner on the row, placeholder “${WINDOW}-fork” in the sidebar.`, mobile);
    }
    await beat(page, 1_200);

    if (!mobile) {
      await page.mouse.move(900, 400);
      await expect(card).toHaveCount(0);
      if (!BEFORE) await expect(ghost).toBeVisible();
      await caption(
        page,
        BEFORE
          ? `${viewport}\nPointer left, card closed: nothing on screen shows the fork is still running.`
          : `${viewport}\nPointer left, card closed: the placeholder row keeps pulsing.`,
        mobile,
      );
    }

    await expect
      .poll(() => listWindows(SESSION).some((w) => w.name === `${WINDOW}-fork`), { timeout: 90_000 })
      .toBe(true);
    const fork = listWindows(SESSION).find((w) => w.name === `${WINDOW}-fork`)!;
    await expect(page).toHaveURL(new RegExp(`/${fork.windowId.slice(1)}(?:$|[/?#])`), { timeout: 30_000 });
    const elapsed = ((Date.now() - clickedAt) / 1000).toFixed(1);
    await expect(ghost).toHaveCount(0);
    await caption(page, `${viewport}\nNew tab ${WINDOW}-fork opened ${elapsed} s after the click (${HOLD_MS / 1000} s of it held).`, mobile);
    await waitReady(paneIdForWindow(fork.windowId));
    await beat(page, 3_000);
  });
});
