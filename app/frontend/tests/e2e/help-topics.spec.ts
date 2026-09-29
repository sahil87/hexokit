/**
 * Help topics e2e: the chevron menu's `Help topics` disclosure and its
 * `Help: <topic>` palette twins open a curated documentation page in the
 * CURRENT window's web tile on a terminal route (add tab → grow the layout to
 * include a web surface → select the tab), dedupe a re-open onto the existing
 * tab, and fall back to a browser tab off the terminal route where no window
 * owns a web tile.
 *
 * Shared setup: `beforeAll` creates a dedicated session `e2e-help-<ts>` on
 * the isolated tmux server with three plain windows (`help-menu-<ts>` for the
 * menu path, `help-palette-<ts>` for the palette path — each needs a window
 * whose layout starts at the bare `tty` default (the option unset) with no
 * web tabs — and `help-full-<ts>`
 * for the cannot-grow fallback, whose `@rk_win_layout` the test seeds to
 * nine tty ROWS before navigating — at the default desktop viewport every
 * row is under the 100px height floor once split, so no add fits and the
 * layout refuses to grow (the size floor, not a tile count, gates adds));
 * `afterAll` kills the session. `beforeEach` route-stubs `https://hexokit.com/**` with a
 * static 200 page so the web tile's iframe never reaches the network (the
 * specs assert the stored tab and the layout, never remote content) and
 * replaces `window.open` with a recorder on `window.__openedUrls` so the
 * browser-tab fallback is observable without spawning tabs. The default
 * desktop viewport is required: `gotoWindow` gates on the desktop status
 * bar's `Connected` dot. Tab state is read from tmux (`@rk_win_web_N`,
 * `@rk_win_web_active`, `@rk_win_layout`) via `windowOption`, the same
 * source the UI derives from.
 */
import { test, expect, type Page } from "@playwright/test";
import { gotoWindow as gotoWindowRaw, openPalette, resolveWindow as resolveWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, setWindowOption, windowOption } from "./_tmux";

const STAMP = Date.now().toString().slice(-6);
const TEST_SESSION = `e2e-help-${STAMP}`;
const MENU_WINDOW = `help-menu-${STAMP}`;
const PALETTE_WINDOW = `help-palette-${STAMP}`;
const FULL_WINDOW = `help-full-${STAMP}`;
// Nine bare tty rows: at the default 1280×720 viewport each row is ~70px
// tall, so splitting any tile (a row split keeps its height) lands under the
// 100px floor and every add is refused — the cannot-grow state the fallback
// test needs. Repeated bare tty is legal.
const FULL_LAYOUT = `v(${Array.from({ length: 9 }, () => "tty").join(",")})`;

const CRON_URL = "https://hexokit.com/docs/cron-schedule-kinds/";
const BOARDS_URL = "https://hexokit.com/docs/boards/";
const TOPIC_LABELS = [
  "Status dot legend",
  "Cron schedule kinds",
  "Boards",
  "Notifications",
  "GUI desktop",
  "Merge topologies",
  "FKF",
];

const resolveWindow = async (page: Page, windowName: string) =>
  (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
const gotoWindow = (page: Page, windowId: string) => gotoWindowRaw(page, TMUX_SERVER, windowId);

/** Stub window.open, recording targets on `window.__openedUrls`. */
async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __openedUrls: string[]; open: (url?: unknown) => null };
    w.__openedUrls = [];
    w.open = (url?: unknown) => {
      w.__openedUrls.push(String(url));
      return null;
    };
  });
}

function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls);
}

/** Open the chevron menu and expand the Help topics disclosure; returns the
 *  menu locator with the seven topic rows visible. */
async function expandHelpTopics(page: Page) {
  await page.getByRole("button", { name: "More controls" }).click();
  const menu = page.getByRole("menu", { name: "More controls" });
  const disclosure = menu.getByRole("menuitem", { name: "Help topics" });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const group = menu.getByRole("group", { name: "Help topics" });
  await expect(group.getByRole("menuitem")).toHaveText(
    TOPIC_LABELS.map((label) => new RegExp(`^${label}`)),
  );
  return { menu, group };
}

test.beforeAll(() => {
  createSession(TEST_SESSION, { windows: [MENU_WINDOW, PALETTE_WINDOW, FULL_WINDOW] });
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.beforeEach(async ({ page }) => {
  await page.route("https://hexokit.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" }),
  );
  await stubWindowOpen(page);
});

test.describe("Help topics", () => {
  /**
   * Proves: on a terminal route the menu's Help topics rows carry no ↗ and
   * clicking one opens the page IN the current window's web tile — the URL is
   * stored as web tab 1, the tty-only layout grows to `h(tty,web)` (the tree
   * form — writers never emit the legacy preset string),
   * the tab strip shows the tab as active, and no browser tab is opened.
   *
   * Steps:
   * 1. Navigate to the menu window and confirm it has no web tab
   *    (`@rk_win_web_1` is empty).
   * 2. Open the `More controls` menu and click `Help topics`; assert the seven
   *    rows render in registry order and none contains ↗.
   * 3. Click `Cron schedule kinds`; assert the menu closes.
   * 4. Poll tmux: `@rk_win_web_1` equals the topic URL, `@rk_win_web_active`
   *    is `1`, and `@rk_win_layout` is `h(tty,web)`.
   * 5. Assert the web-tab strip renders one selected tab titled with the
   *    display form `hexokit.com/docs/cron-schedule-kinds/`, and that
   *    `window.open` was never called.
   */
  test("menu row opens the topic in the current window's web tile", async ({ page }) => {
    const id = await resolveWindow(page, MENU_WINDOW);
    expect(windowOption(id, "@rk_win_web_1")).toBe("");
    await gotoWindow(page, id);

    const { menu, group } = await expandHelpTopics(page);
    for (const row of await group.getByRole("menuitem").all()) {
      await expect(row).not.toContainText("↗");
    }

    await group.getByRole("menuitem", { name: "Cron schedule kinds" }).click();
    await expect(menu).toHaveCount(0);

    await expect.poll(() => windowOption(id, "@rk_win_web_1"), { timeout: 10_000 }).toBe(CRON_URL);
    await expect.poll(() => windowOption(id, "@rk_win_web_active"), { timeout: 10_000 }).toBe("1");
    await expect.poll(() => windowOption(id, "@rk_win_layout"), { timeout: 10_000 }).toBe("h(tty,web)");

    const strip = page.getByTestId("web-tab-strip");
    const tab = strip.getByTestId("web-tab");
    await expect(tab).toHaveCount(1);
    await expect(tab).toHaveAttribute("title", "hexokit.com/docs/cron-schedule-kinds/");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    expect(await openedUrls(page)).toEqual([]);
  });

  /**
   * Proves: the `Help: <topic>` palette twin takes the same in-tile path as
   * the menu row, and re-selecting an already-open topic selects the existing
   * tab instead of adding a second one.
   *
   * Steps:
   * 1. Navigate to the palette window (no web tab yet).
   * 2. Open the palette, choose `Help: Boards`; poll tmux until web tab 1 is
   *    the boards URL and the layout is `h(tty,web)`.
   * 3. Open the palette and choose `Help: Boards` again.
   * 4. Assert the strip still shows exactly one tab and `@rk_win_web_2` stays
   *    unset while `@rk_win_web_active` remains `1`; `window.open` was never
   *    called.
   */
  test("palette twin opens in-tile and a re-open dedupes onto the existing tab", async ({ page }) => {
    const id = await resolveWindow(page, PALETTE_WINDOW);
    await gotoWindow(page, id);

    const selectBoards = async () => {
      const input = await openPalette(page);
      await input.fill("Help: Boards");
      const option = page.getByRole("option", { name: "Help: Boards" });
      await expect(option).toBeVisible();
      await option.click();
    };

    await selectBoards();
    await expect.poll(() => windowOption(id, "@rk_win_web_1"), { timeout: 10_000 }).toBe(BOARDS_URL);
    await expect.poll(() => windowOption(id, "@rk_win_layout"), { timeout: 10_000 }).toBe("h(tty,web)");
    await expect(page.getByTestId("web-tab-strip").getByTestId("web-tab")).toHaveCount(1);

    await selectBoards();
    // A second add of the same address is a dedupe on the server: give the
    // round trip time to land before asserting nothing grew.
    await expect.poll(() => windowOption(id, "@rk_win_web_active"), { timeout: 10_000 }).toBe("1");
    await expect(page.getByTestId("web-tab-strip").getByTestId("web-tab")).toHaveCount(1);
    expect(windowOption(id, "@rk_win_web_2")).toBe("");
    expect(await openedUrls(page)).toEqual([]);
  });

  /**
   * Proves: off the terminal route (the Host page) no window owns a web tile,
   * so the Help topics rows carry ↗ and a click opens the page in a new
   * browser tab through `window.open`.
   *
   * Steps:
   * 1. Navigate to `/` (Host).
   * 2. Open the `More controls` menu, expand `Help topics`; assert every topic
   *    row contains ↗ and the fab-kit rows carry the `fab-kit` tag.
   * 3. Click `Boards`; assert `window.open` recorded exactly the boards URL.
   */
  test("host route rows show ↗ and open a browser tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "More controls" })).toBeVisible();

    const { group } = await expandHelpTopics(page);
    for (const row of await group.getByRole("menuitem").all()) {
      await expect(row).toContainText("↗");
    }
    await expect(group.getByRole("menuitem", { name: /Merge topologies/ })).toContainText("fab-kit");
    await expect(group.getByRole("menuitem", { name: /FKF/ })).toContainText("fab-kit");

    await group.getByRole("menuitem", { name: /^Boards/ }).click();
    await expect.poll(() => openedUrls(page)).toEqual([BOARDS_URL]);
  });

  /**
   * Proves: on a terminal route whose layout cannot grow (every tile split
   * breaks the size floor — nine tty rows at this viewport) and which has no
   * web surface, opening a topic still stores it as a web tab but performs
   * NO layout write and opens the page in a browser tab instead — and that
   * browser tab opens synchronously from the click, before the add request
   * resolves (the fallback must keep the click's user activation, or popup
   * blockers swallow it).
   *
   * Steps:
   * 1. Seed the full window's `@rk_win_layout` to the nine-row all-tty tree
   *    (no split fits the 150×100 px floor in this viewport, so adding a web
   *    tile is refused — the floor gates adds, not a tile count) and navigate
   *    to it; assert no web tab.
   * 2. Hold the `POST /api/windows/{id}/web` add request open.
   * 3. Open the menu, expand `Help topics`, click `Cron schedule kinds`;
   *    assert `window.open` recorded the topic URL while the add request is
   *    still pending.
   * 4. Release the request; poll tmux: `@rk_win_web_1` equals the topic URL
   *    and `@rk_win_layout` is unchanged at the seeded value.
   */
  test("a layout that cannot grow keeps the tab, skips the layout write, and opens a browser tab synchronously", async ({ page }) => {
    const id = await resolveWindow(page, FULL_WINDOW);
    setWindowOption(id, "@rk_win_layout", FULL_LAYOUT);
    expect(windowOption(id, "@rk_win_web_1")).toBe("");
    await gotoWindow(page, id);
    await expect.poll(() => windowOption(id, "@rk_win_layout")).toBe(FULL_LAYOUT);

    let releaseAdd: () => void = () => {};
    const addHeld = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const addRequested = page.waitForRequest(
      (req) => req.method() === "POST" && /\/api\/windows\/[^/]+\/web(\?|$)/.test(req.url()),
    );
    await page.route(/\/api\/windows\/[^/]+\/web(\?|$)/, async (route) => {
      await addHeld;
      await route.continue();
    });

    const { group } = await expandHelpTopics(page);
    await group.getByRole("menuitem", { name: "Cron schedule kinds" }).click();
    await addRequested;
    expect(await openedUrls(page)).toEqual([CRON_URL]);

    releaseAdd();
    await expect.poll(() => windowOption(id, "@rk_win_web_1"), { timeout: 10_000 }).toBe(CRON_URL);
    expect(windowOption(id, "@rk_win_layout")).toBe(FULL_LAYOUT);
    expect(await openedUrls(page)).toEqual([CRON_URL]);
  });
});
