/**
 * Demo: popping ANOTHER tab's terminal into its own window from the sidebar
 * row's hover card — Open in new window, the row's popped marker, the card's
 * Focus window / Bring back pair, and the popout's tab / session / server
 * title — without the current tab changing.
 *
 * Runs only under `just demo tab-popout [--before]` (playwright.demo.config.ts),
 * against the throwaway e2e rig. Desktop only: the card's popout rows are not
 * offered on mobile (the mobile project skips). The popout is a separate
 * browser page that per-page video cannot show, so the demo mirrors it into
 * the recorded page as a picture-in-picture panel — periodic screenshots of
 * the popup under a fake title bar carrying the popup's real document title.
 * The `before` variant (DEMO_VARIANT, the base branch's SPA/backend) opens
 * the same card, shows it has no popout row, and stops.
 *
 * Shared setup: beforeAll creates session `demo-tab-popout` on the rig's
 * isolated tmux server with two windows — `planner` (an idle pane, the tab
 * the viewer stays on) and `agent` (a loop printing a timestamped line every
 * second, so the popped terminal is visibly live). afterAll kills the session.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat, desktopOnly } from "./_demo";
import { gotoWindow, resolveWindow } from "../e2e/_ready";
import { TMUX_SERVER, createSession, killSession } from "../e2e/_tmux";

const SESSION = "demo-tab-popout";
const CURRENT = "planner";
const TARGET = "agent";
const BEFORE = process.env.DEMO_VARIANT === "before";
/** Interval between picture-in-picture refreshes of the popup. */
const PIP_FRAME_MS = 400;

/** A fixed caption box, top-right over the terminal (the fork-worktree demo idiom). */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((body) => {
    let label = document.getElementById("tab-popout-demo-caption");
    if (!label) {
      label = document.createElement("pre");
      label.id = "tab-popout-demo-caption";
      Object.assign(label.style, {
        position: "fixed",
        top: "64px",
        right: "24px",
        zIndex: "2147483647",
        margin: "0",
        padding: "10px 14px",
        maxWidth: "620px",
        whiteSpace: "pre-wrap",
        font: "13px/1.45 ui-monospace, monospace",
        color: "#e6edf3",
        background: "rgba(13, 17, 23, 0.94)",
        border: "1px solid #3fb950",
        borderRadius: "6px",
        pointerEvents: "none",
      });
      document.body.appendChild(label);
    }
    label.textContent = body;
  }, text);
}

/** Show (or refresh) the popup's picture-in-picture panel: its document
 *  title in a title bar over a screenshot of its page. */
async function pipFrame(page: Page, popup: Page): Promise<void> {
  if (popup.isClosed()) return;
  const shot = await popup.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  if (shot === null) return;
  const title = await popup.title().catch(() => "");
  await page.evaluate(
    ({ src, title }) => {
      let box = document.getElementById("tab-popout-demo-pip");
      if (!box) {
        box = document.createElement("div");
        box.id = "tab-popout-demo-pip";
        Object.assign(box.style, {
          position: "fixed",
          right: "24px",
          bottom: "48px",
          width: "560px",
          zIndex: "2147483646",
          border: "2px solid #58a6ff",
          borderRadius: "8px",
          overflow: "hidden",
          background: "#0d1117",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          pointerEvents: "none",
        });
        const bar = document.createElement("div");
        bar.id = "tab-popout-demo-pip-title";
        Object.assign(bar.style, {
          padding: "6px 10px",
          font: "12px/1.3 ui-monospace, monospace",
          color: "#e6edf3",
          background: "#161b22",
          borderBottom: "1px solid #30363d",
        });
        const img = document.createElement("img");
        img.id = "tab-popout-demo-pip-img";
        Object.assign(img.style, { display: "block", width: "100%" });
        box.append(bar, img);
        document.body.appendChild(box);
      }
      document.getElementById("tab-popout-demo-pip-title")!.textContent = `▢ New window — title: ${title}`;
      (document.getElementById("tab-popout-demo-pip-img") as HTMLImageElement).src = src;
    },
    { src: `data:image/jpeg;base64,${shot.toString("base64")}`, title },
  );
}

/** Keep the picture-in-picture panel live for `ms`. */
async function pipFor(page: Page, popup: Page, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !popup.isClosed()) {
    await pipFrame(page, popup);
    await page.waitForTimeout(PIP_FRAME_MS);
  }
}

async function clearPip(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("tab-popout-demo-pip")?.remove());
}

test.describe("tab popout demo", () => {
  test.beforeAll(() => {
    createSession(SESSION, {
      windows: [
        { name: CURRENT, command: `clear; echo "${CURRENT} pane (idle)"; exec sleep 3600` },
        { name: TARGET, command: `while true; do date +"${TARGET} pane  %T  (live)"; sleep 1; done` },
      ],
    });
  });

  test.afterAll(() => {
    killSession(SESSION);
  });

  /**
   * Proves: from the `planner` tab, the `agent` row's hover card pops agent's
   * terminal into its own window (titled `agent #<n> — <session> · <server>`)
   * while the viewer stays on planner; the agent row then shows the popped
   * marker and its card offers Focus window + Bring back; Bring back closes
   * the window and clears the marker. Before: the card has no popout row.
   *
   * Steps:
   * 1. Navigate to planner; caption the scenario.
   * 2. Hover the agent row; the card opens. Before: assert no
   *    `row-flyout-popout-action`, caption that, stop.
   * 3. After: click Open in new window; catch the popup; mirror it as a
   *    picture-in-picture panel; assert its title and that the viewer's URL
   *    is still planner's route.
   * 4. Leave the sidebar; assert the agent row's popped marker; caption it.
   * 5. Hover the agent row again; the card shows Focus window + Bring back
   *    (no Open in new window); click Bring back; the popup closes and the
   *    marker clears.
   */
  test("pop another tab's terminal into its own window from the row card", async ({ page }, info) => {
    desktopOnly(info);
    const viewport = `${BEFORE ? "Before" : "After"} · ${info.project.name}`;
    const current = await resolveWindow(page, TMUX_SERVER, SESSION, CURRENT);
    const target = await resolveWindow(page, TMUX_SERVER, SESSION, TARGET);
    await gotoWindow(page, TMUX_SERVER, current.windowId);
    const openerUrl = page.url();
    await caption(page, `${viewport}\nViewing tab "${CURRENT}".\nGoal: open tab "${TARGET}"'s terminal in its own window.`);
    await beat(page, 2_500);

    const row = page.locator(`[role='treeitem'][data-window-id='${target.windowId}']`);
    await expect(row).toBeVisible();
    await row.hover();
    const open = page.getByTestId("row-flyout-popout-action");
    if (BEFORE) {
      await expect(page.getByTestId("row-flyout-kill-action")).toBeVisible();
      await expect(open).toHaveCount(0);
      await caption(
        page,
        `${viewport}\nThe "${TARGET}" row's card has no "Open in new window".\nPopping a terminal out needs the tab open in a split layout\n(the tile header's Pop out), so you must leave "${CURRENT}".`,
      );
      await beat(page, 6_000);
      return;
    }

    await expect(open).toBeVisible();
    await caption(page, `${viewport}\nHover the "${TARGET}" row: the card offers "Open in new window".`);
    await open.hover();
    await beat(page, 2_000);
    const [popup] = await Promise.all([page.context().waitForEvent("page"), open.click()]);
    await popup.waitForLoadState("domcontentloaded");
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expect(popup).toHaveTitle(new RegExp(`^${TARGET} #\\d+ — ${SESSION} · `));
    expect(page.url()).toBe(openerUrl);
    await page.mouse.move(900, 300);
    const title = await popup.title();
    await caption(
      page,
      `${viewport}\n"${TARGET}"'s terminal opened in a new window (inset, live).\nWindow title: ${title}\nThis tab is still "${CURRENT}" — no navigation.`,
    );
    await pipFor(page, popup, 5_000);

    const marker = row.getByTestId("row-popped-marker");
    await expect(marker).toBeVisible({ timeout: 10_000 });
    await marker.evaluate((el) => {
      (el as HTMLElement).style.outline = "2px solid #f0883e";
      (el as HTMLElement).style.outlineOffset = "2px";
    });
    await caption(page, `${viewport}\nThe "${TARGET}" row now shows a pop-out marker (outlined).\nClicking it focuses the popped-out window.`);
    await pipFor(page, popup, 4_000);

    await row.hover();
    const bringBack = page.getByTestId("row-flyout-popout-bring-back-action");
    await expect(page.getByTestId("row-flyout-popout-focus-action")).toBeVisible();
    await expect(open).toHaveCount(0);
    await caption(page, `${viewport}\nWhile it is popped out, the card offers\n"Focus window" and "Bring back" instead.`);
    await pipFor(page, popup, 3_000);
    await bringBack.hover();
    await pipFor(page, popup, 1_500);
    await Promise.all([popup.waitForEvent("close", { timeout: 15_000 }), bringBack.click()]);
    await clearPip(page);
    await page.mouse.move(900, 300);
    await expect(marker).toHaveCount(0);
    await caption(page, `${viewport}\n"Bring back" closed the window; the marker is gone.\nStill on "${CURRENT}".`);
    await beat(page, 4_000);
  });
});
