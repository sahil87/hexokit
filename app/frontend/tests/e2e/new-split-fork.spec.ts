import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// Behavioural contract for the `+ Tab` caret menu's fork pair — `Fork tab`
// and `Fork tab in new worktree` in the `IN <ws> › <group>` section. The rows
// invoke the `fork-window` / `fork-window-worktree` palette actions, which are
// registered only for a current tab whose agent is forkable (`canForkWindow`),
// so the menu drops them on a plain shell tab.
//
// Shared setup (the row-flyout.spec.ts mock shape, trimmed): **/api/servers →
// one server `default`; **/api/boards → []; **/api/windows/*/select* → 200;
// /ws/terminals accepted and held open; /ws/state carries session `dev` with
// @1 "agent-work" (a claude agent with a session ref) and @2 "scratch-shell"
// (plain shell). Fork requests are intercepted and fulfilled with a 200 whose
// windowId is "@9", so no test touches real tmux or a real agent.

const SERVER = "default";

const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    sessionId: "$4",
    sessionPath: "/tmp/dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "agent-work",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        agentState: "waiting",
        agentProvider: "claude",
        agentSessionRef: "5d80479e-8f25-46cd-a0d4-e51435508a37",
      },
      {
        windowId: "@2",
        index: 1,
        name: "scratch-shell",
        worktreePath: "/tmp/scratch",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
      },
    ],
  },
]);

async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept and hold the socket open; send nothing */
  });
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await page.route("**/api/boards", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload });
}

/** Record every fork POST and answer it with a fork at @9. */
async function captureForks(page: Page): Promise<string[]> {
  const urls: string[] = [];
  await page.route("**/api/windows/*/fork*", (route) => {
    urls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ server: SERVER, session: "dev", window: "agent-work-fork", windowId: "@9" }),
    });
  });
  return urls;
}

async function openMenu(page: Page, windowNum: number) {
  await page.goto(`/${SERVER}/${windowNum}`);
  await page.getByTestId("new-split-caret").click();
  const menu = page.getByTestId("new-split-menu");
  await expect(menu).toContainText(`IN ${SERVER} › dev`);
  return menu;
}

test.describe("New split button — fork rows", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  /**
   * Proves: on an agent tab the tab section lists `Fork tab` then
   * `Fork tab in new worktree` directly after `Agent tab…`, and `Fork tab`
   * POSTs the window-keyed fork endpoint with NO `where` (same directory),
   * then navigates to the returned window.
   */
  test("Fork tab forks the current tab in place and navigates", async ({ page }) => {
    const forks = await captureForks(page);
    const menu = await openMenu(page, 1);

    const labels = await menu.getByRole("menuitem").allTextContents();
    const agentIdx = labels.findIndex((l) => l.includes("Agent tab…"));
    expect(labels[agentIdx + 1]).toContain("Fork tab");
    expect(labels[agentIdx + 2]).toContain("Fork tab in new worktree");

    await menu.getByRole("menuitem", { name: "Fork tab", exact: true }).click();
    await expect.poll(() => forks.length).toBe(1);
    const url = new URL(forks[0]);
    expect(decodeURIComponent(url.pathname)).toBe("/api/windows/@1/fork");
    expect(url.searchParams.has("where")).toBe(false);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/9(?:$|[/?#])`), { timeout: 5_000 });
  });

  /**
   * Proves: `Fork tab in new worktree` POSTs the same endpoint with
   * `where=worktree` and navigates to the returned window.
   */
  test("Fork tab in new worktree forks with where=worktree", async ({ page }) => {
    const forks = await captureForks(page);
    const menu = await openMenu(page, 1);

    await menu.getByRole("menuitem", { name: "Fork tab in new worktree" }).click();
    await expect.poll(() => forks.length).toBe(1);
    const url = new URL(forks[0]);
    expect(decodeURIComponent(url.pathname)).toBe("/api/windows/@1/fork");
    expect(url.searchParams.get("where")).toBe("worktree");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/9(?:$|[/?#])`), { timeout: 5_000 });
  });

  /**
   * Proves: on a plain shell tab (no agentProvider) neither fork row is
   * offered, while the rest of the tab section still is.
   */
  test("a plain shell tab offers no fork rows", async ({ page }) => {
    const menu = await openMenu(page, 2);
    await expect(menu.getByRole("menuitem", { name: "Tab", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Fork tab/ })).toHaveCount(0);
  });
});
