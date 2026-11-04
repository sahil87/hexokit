/**
 * Demo: a popped-out terminal in the desktop shell — the popout window's
 * titlebar strip names the tab, its session and its server
 * (`agent #<n> — <session> · <server>`) instead of the host name, and the
 * sidebar row card opens the popout from another tab and brings it back.
 *
 * Runs only under `just demo tab-popout [--before]` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway
 * e2e rig. The popout is a second shell window, so only the display grab
 * (ffmpeg x11grab, owned by the `_demo.ts` fixture) shows it; the demo moves
 * it to the right half of the screen (Electron's own `setBounds`) so the
 * opener's sidebar stays visible beside it. The `before` variant (the base
 * tree's shell and SPA) has no card row, so it pops the same terminal the
 * only way the base offers — the tile header's Pop out on the tab itself —
 * and shows the strip's host-name label.
 *
 * Shared setup: beforeAll creates session `demo-tab-popout-shell` on the
 * rig's isolated tmux server with two windows — `planner` (an idle pane, the
 * tab the viewer stays on in the after variant) and `agent` (a loop printing
 * a timestamped line every second, layout `h(tty,web)` with a loopback guest
 * stub as its web tab so the base's tile-header Pop out is offered) — and
 * starts the guest stub. afterAll kills the session and the stub.
 */
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect, beat, pace, READY_TIMEOUT } from "./_demo";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import { findPage, hostOrigins, startGuestStub, type GuestStub } from "../e2e/_shell";

const SESSION = "demo-tab-popout-shell";
const CURRENT = "planner";
const TARGET = "agent";
const BEFORE = process.env.DEMO_VARIANT === "before";
/** Where the popout window is parked on the 1280×800 Xvfb screen. */
const POPOUT_BOUNDS = { x: 300, y: 220, width: 960, height: 460 };

let stub: GuestStub;

/** A fixed caption box on a page (top-right, above the terminal). */
async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((body) => {
    let label = document.getElementById("tab-popout-demo-caption");
    if (!label) {
      label = document.createElement("pre");
      label.id = "tab-popout-demo-caption";
      Object.assign(label.style, {
        position: "fixed",
        top: "72px",
        right: "24px",
        zIndex: "2147483647",
        margin: "0",
        padding: "10px 14px",
        maxWidth: "560px",
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

/** Park the newest shell window (the popout) at POPOUT_BOUNDS and raise it. */
async function parkPopout(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, bounds) => {
    const wins = BrowserWindow.getAllWindows();
    const popout = wins.reduce((a, b) => (b.id > a.id ? b : a));
    popout.setBounds(bounds);
    popout.moveTop();
  }, POPOUT_BOUNDS);
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** Outline an element so the recording draws the eye to it. */
async function outline(page: Page, testid: string): Promise<void> {
  await page.getByTestId(testid).first().evaluate((el) => {
    (el as HTMLElement).style.outline = "2px solid #f0883e";
    (el as HTMLElement).style.outlineOffset = "-2px";
  });
}

test.describe("tab-popout shell demo", () => {
  test.beforeAll(async () => {
    stub = await startGuestStub();
    createSession(SESSION, {
      windows: [
        { name: CURRENT, command: `clear; echo "${CURRENT} pane (idle)"; exec sleep 3600` },
        { name: TARGET, command: `while true; do date +"${TARGET} pane  %T  (live)"; sleep 1; done` },
      ],
    });
    const agent = listWindows(SESSION).find((w) => w.name === TARGET);
    if (!agent) throw new Error(`window "${TARGET}" not found in ${SESSION}`);
    stampWebTab(agent.windowId, `${stub.origin}/`);
    setWindowOption(agent.windowId, "@rk_win_layout", "h(tty,web)");
  });

  test.afterAll(() => {
    killSession(SESSION);
    stub.server.close();
  });

  /**
   * Proves: in the shell, a popped-out terminal's window titlebar strip shows
   * `agent #<n> — <session> · <server>` (after) where it showed the host name
   * (before); and the sidebar row card opens that popout from another tab and
   * Bring back closes it.
   *
   * Steps:
   * 1. Before: navigate to `agent`; click the tty tile header's Pop out; the
   *    popout window opens; park it on the right; outline its titlebar strip
   *    and caption the host-name label; stop.
   * 2. After: navigate to `planner`; hover the `agent` row; click Open in
   *    new window; the popout window opens; park it; assert and outline the
   *    strip's popout title; caption it.
   * 3. Hover the `agent` row again; click Bring back; the popout window
   *    closes (window count back to one); caption it.
   */
  test("popout titlebar names the tab; row card opens and brings it back", async ({ app, hostPage }) => {
    const label = BEFORE ? "Before · shell" : "After · shell";
    const windows = listWindows(SESSION);
    const current = windows.find((w) => w.name === CURRENT)!;
    const target = windows.find((w) => w.name === TARGET)!;
    const routeOf = (id: string) => `${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(id)}`;

    if (BEFORE) {
      await hostPage.goto(routeOf(target.windowId));
      const tty = hostPage.getByTestId("surface-tile-tty");
      await expect(tty).toBeVisible({ timeout: READY_TIMEOUT });
      await caption(hostPage, `${label}\nTab "${TARGET}". Pop its terminal out with the tile header's Pop out.`);
      await beat(hostPage, 2_500);
      await tty.getByLabel("Pop out Terminal").click();
      await pace(hostPage);
      await expect.poll(() => windowCount(app), { timeout: READY_TIMEOUT }).toBe(2);
      const popout = await findPage(app, (url) => url.includes("?pop="), READY_TIMEOUT);
      await expect(popout.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
      await parkPopout(app);
      await outline(popout, "shell-titlebar-strip");
      const title = await popout.title();
      await caption(
        hostPage,
        `${label}\nThe popout window's titlebar (outlined) shows the HOST name,\nnot which tab it is.\nDocument title: ${title}`,
      );
      await beat(hostPage, 7_000);
      return;
    }

    await hostPage.goto(routeOf(current.windowId));
    await expect(hostPage.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
    await caption(hostPage, `${label}\nViewing tab "${CURRENT}". Pop "${TARGET}"'s terminal out\nfrom its sidebar row card.`);
    await beat(hostPage, 2_500);

    const row = hostPage.locator(`[role='treeitem'][data-window-id='${target.windowId}']`);
    await row.hover();
    await pace(hostPage);
    const open = hostPage.getByTestId("row-flyout-popout-action");
    await expect(open).toBeVisible({ timeout: READY_TIMEOUT });
    await open.hover();
    await beat(hostPage, 1_500);
    await open.click();
    await pace(hostPage);
    await expect.poll(() => windowCount(app), { timeout: READY_TIMEOUT }).toBe(2);
    const popout = await findPage(app, (url) => url.includes("?pop="), READY_TIMEOUT);
    await expect(popout.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
    await parkPopout(app);
    await hostPage.mouse.move(400, 500);
    const stripTitle = popout.getByTestId("shell-titlebar-popout-title");
    await expect(stripTitle).toHaveText(new RegExp(`^${TARGET} #\\d+ — ${SESSION} · `));
    await outline(popout, "shell-titlebar-strip");
    await caption(
      hostPage,
      `${label}\nThe popout window's titlebar (outlined) names the tab:\n${await stripTitle.innerText()}\nThis window stays on "${CURRENT}".`,
    );
    await beat(hostPage, 7_000);

    await row.hover();
    await pace(hostPage);
    const bringBack = hostPage.getByTestId("row-flyout-popout-bring-back-action");
    await expect(bringBack).toBeVisible({ timeout: READY_TIMEOUT });
    await caption(hostPage, `${label}\nThe card now offers "Focus window" and "Bring back".`);
    await bringBack.hover();
    await beat(hostPage, 2_500);
    await bringBack.click();
    await expect.poll(() => windowCount(app), { timeout: READY_TIMEOUT }).toBe(1);
    await hostPage.mouse.move(400, 500);
    await caption(hostPage, `${label}\n"Bring back" closed the popout window.`);
    await beat(hostPage, 3_500);
  });
});
