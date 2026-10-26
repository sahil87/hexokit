/** Web tab strip e2e: the tmux-backed family renders as URL-keyed mounted
 * frames; selection, close, draft materialization, and all three reorder
 * surfaces land in tmux; viewer-local drafts never do. The suite also covers
 * single-tab visibility, cross-viewer convergence, close/new-tab browser
 * gestures, the folder active-tab treatment (with its separator rule), and
 * the width ladder's icon-only/scroll rung.
 *
 * Shared setup: `beforeAll` creates a dedicated session `e2e-webtabs-<ts>`
 * (80×24); `afterAll` kills it. `beforeEach` route-stubs `/proxy/3001|3002|3003/**
 * with a static 200 page and sets a wide desktop viewport (1440×800).
 * `makeWindow(name, urls?, active?)` creates a window, stamps the family and
 * `@rk_win_layout=single:web`, then navigates to the bare route. Tmux-side
 * assertions poll through `windowOption`; request counters prove viewer-only
 * paths and single-commit gestures. Tests run serially (workers: 1), and the
 * second-viewer case closes its extra browser context in `finally`. The
 * legacy-present compat test stamps the LEGACY slot form for the R4 compat
 * row (new-form rows live in web-tile-chrome.spec.ts), reading its
 * `@rk_win_present_root` from the mkdtemp-managed presentDir scrubbed in
 * afterAll. The path-target tests reuse presentDir (seeded with
 * docs/report.html in beforeAll) as the window's pane cwd — the backend
 * resolves address-bar path targets against the window's first-pane path.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openPalette,
  READY_TIMEOUT,
  resolveWindow as resolveWindowRaw,
} from "./_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  setWindowOption,
  stampWebTabs,
  windowOption,
} from "./_tmux";
import { stubProxyPorts } from "./_web-tile";

const TEST_SESSION = `e2e-webtabs-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

const TAB_URLS = ["/proxy/3001/", "/proxy/3002/", "/proxy/3003/"];
const SEED_ACTIVE = 2;

// The legacy-form compat row's present root (created in beforeAll; removed in
// afterAll) — the `@rk_win_present_root` slot-1 dual-read the legacy arm
// needs to register the root in the server's declared set.
let presentDir: string;

const URL_BAR = (page: Page) => page.getByTestId("surface-tile-web").getByLabel("URL");
const draftTabs = (page: Page) => page.getByTestId("web-tab-draft");
const strip = (page: Page) => page.getByTestId("web-tab-strip");
const tab = (page: Page, n: number) => page.locator(`[data-testid="web-tab"][data-index="${n}"]`);
const frames = (page: Page) => page.getByTitle("Proxied content");
const visibleFrames = (page: Page) => page.locator('iframe[title="Proxied content"]:visible');
const frameFor = (page: Page, url: string) =>
  page.locator(`iframe[title="Proxied content"][src="${url}"]`);

const OPTION_TICK_TIMEOUT = 30_000;

async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Create a window on this spec's session, stamp the family, and navigate. */
async function makeWindow(page: Page, name: string, urls = TAB_URLS, active = SEED_ACTIVE): Promise<string> {
  newWindow(TEST_SESSION, name);
  const id = await resolveWindow(page, name);
  stampWebTabs(id, urls, active);
  setWindowOption(id, "@rk_win_layout", "single:web");
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
  await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  return id;
}

async function expectWindowOption(windowId: string, option: string, expected: string): Promise<void> {
  await expect.poll(() => windowOption(windowId, option), { timeout: OPTION_TICK_TIMEOUT }).toBe(expected);
}

test.beforeAll(() => {
  createSession(TEST_SESSION);
  presentDir = mkdtempSync(join(tmpdir(), "rk-e2e-webtabs-present-"));
  writeFileSync(join(presentDir, "legacy-doc.html"), "<!doctype html><html><body><p>legacy</p></body></html>");
  mkdirSync(join(presentDir, "docs"));
  writeFileSync(join(presentDir, "docs", "report.html"), "<!doctype html><html><body><p>report</p></body></html>");
});

test.afterAll(() => {
  killSession(TEST_SESSION);
  rmSync(presentDir, { recursive: true, force: true });
});

test.describe("Web tab strip — drafts, reorder, gestures", () => {
  test.beforeEach(async ({ page }) => {
    await stubProxyPorts(page, 3001, 3002, 3003);
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: the strip always renders with the web tile — at ≥1 tab with its
   * tab row, and at 0 tabs as just the `+` with the onboarding panel as the
   * content below it (onboarding is a content state, not stripless chrome).
   * Steps:
   * 1. Create a window with one seed tab and `single:web`; navigate.
   * 2. Assert the strip is visible with the one tab and the `+` button.
   * 3. Create a window with no tabs; navigate.
   * 4. Assert the strip and `+` render with zero tabs while the onboarding
   *    panel is visible below.
   */
  test("strip always renders: tab row at ≥1 tab, bare `+` over onboarding at 0", async ({ page }) => {
    test.setTimeout(30_000);
    await makeWindow(page, `wt-one-${Date.now()}`, [TAB_URLS[0]], 1);
    await expect(page.getByTestId("web-tab-strip")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId("web-tab")).toHaveCount(1);
    await expect(page.getByTestId("web-tab-add")).toBeVisible();

    await makeWindow(page, `wt-empty-${Date.now()}`, [], 0);
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId("web-tab-strip")).toBeVisible();
    await expect(page.getByTestId("web-tab-add")).toBeVisible();
    await expect(page.getByTestId("web-tab")).toHaveCount(0);
  });

  /**
   * Proves: multiple empty (draft) tabs can be opened from a 0-tab window —
   * via the strip's `+` and the palette's `Web: New tab` — and each Enter
   * materializes one draft into the next dense tmux slot; drafts themselves
   * never touch tmux.
   * Steps:
   * 1. Create a window with no tabs; navigate; assert onboarding + the `+`.
   * 2. Click `+` twice and open a third draft via the palette; assert three
   *    dashed drafts render while `@rk_win_web_1` stays empty in tmux.
   * 3. Type an address into the armed bar and press Enter three times (one
   *    address per draft); assert slots 1..3 land densely in tmux and the
   *    drafts are gone.
   */
  test("drafts open from a 0-tab window and materialize into dense slots", async ({ page }) => {
    test.setTimeout(45_000);
    const id = await makeWindow(page, `wt-drafts0-${Date.now()}`, [], 0);
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: READY_TIMEOUT });

    await page.getByTestId("web-tab-add").click();
    await page.getByTestId("web-tab-add").click();
    await openPalette(page);
    await page.getByRole("option", { name: "Web: New tab" }).click();
    await expect(draftTabs(page)).toHaveCount(3);
    expect(await windowOption(id, "@rk_win_web_1")).toBe("");

    for (const [i, port] of [3001, 3002, 3003].entries()) {
      // Select the oldest remaining draft; the bar arms for it.
      await draftTabs(page).first().click();
      await URL_BAR(page).fill(`localhost:${port}`);
      await URL_BAR(page).press("Enter");
      await expectWindowOption(id, `@rk_win_web_${i + 1}`, `/proxy/${port}/`);
    }
    await expect(draftTabs(page)).toHaveCount(0);
    await expect(page.getByTestId("web-tab")).toHaveCount(3);
    await expectWindowOption(id, "@rk_win_web_active", "3");
  });

  /**
   * Proves: a seeded family renders one tab and one mounted frame per URL;
   * page titles can replace the URL fallback without changing tab identity,
   * and only the active frame is visible.
   * Steps:
   * 1. Create the seeded three-tab window and navigate.
   * 2. Assert the three tabs keep their URL-derived title attributes while
   *    their loaded document title is shown as the label.
   * 3. Assert slot 2 alone is selected.
   * 4. Assert all three URL-keyed frames remain mounted and only slot 2 shows.
   */
  test("the seeded family renders URL-keyed tabs with one visible frame", async ({ page }) => {
    await makeWindow(page, `wt-render-${Date.now()}`);

    await expect(strip(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId("web-tab")).toHaveCount(3);
    for (let i = 0; i < TAB_URLS.length; i++) {
      await expect(tab(page, i + 1)).toHaveAttribute("title", `localhost:300${i + 1}/`);
      await expect(tab(page, i + 1)).toContainText("proxy stub");
    }
    await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "false");
    await expect(tab(page, 3)).toHaveAttribute("aria-selected", "false");

    await expect(frames(page)).toHaveCount(3);
    await expect(visibleFrames(page)).toHaveCount(1);
    await expect(visibleFrames(page)).toHaveAttribute("src", TAB_URLS[1]);
  });

  /**
   * Proves: selecting a tab writes `_active` while preserving every mounted
   * frame, so switching never reloads a hidden page.
   * Steps:
   * 1. Create the seeded window and navigate.
   * 2. Click tab 3 and wait for `_active=3`.
   * 3. Assert tab 3 is selected and tab 2 is not.
   * 4. Assert all frames remain mounted, with slots 2/3 hidden/visible.
   */
  test("clicking a tab selects it without unmounting the previous frame", async ({ page }) => {
    const id = await makeWindow(page, `wt-select-${Date.now()}`);

    await tab(page, 3).click();
    await expectWindowOption(id, "@rk_win_web_active", "3");
    await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, 2)).toHaveAttribute("aria-selected", "false");
    await expect(frames(page)).toHaveCount(3);
    await expect(frameFor(page, TAB_URLS[1])).toBeHidden();
    await expect(frameFor(page, TAB_URLS[2])).toBeVisible();
  });

  /**
   * Proves: the visible × uses the remove verb without selecting first;
   * dense renumbering and active-pointer repointing match the backend rule.
   * Steps:
   * 1. Create the seeded window with slot 2 active.
   * 2. Click slot 2's close button.
   * 3. Assert old slot 3 moves to slot 2, slot 3 clears, and active stays 2.
   * 4. Assert the strip renders two tabs with slot 2 selected.
   */
  test("the close button renumbers the family and repoints active", async ({ page }) => {
    const id = await makeWindow(page, `wt-close-${Date.now()}`);

    await tab(page, 2).getByTestId("web-tab-close").click();
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[2]);
    await expectWindowOption(id, "@rk_win_web_3", "");
    await expectWindowOption(id, "@rk_win_web_active", "2");
    await expect(page.getByTestId("web-tab")).toHaveCount(2);
    await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  });

  /**
   * Proves: a draft opened from `+` renders dashed after the real tabs and
   * materializes on Enter through the add verb — tmux gains a dense slot and
   * the new slot becomes the active one.
   * Steps:
   * 1. Create a window with the seeded three-tab family; navigate.
   * 2. Click `+`; assert a `web-tab-draft` appears after the last real tab.
   * 3. Type `localhost:3003/docs` and press Enter.
   * 4. Assert `@rk_win_web_4` holds `/proxy/3003/docs` and `@rk_win_web_active`
   *    reads "4"; the draft disappears and tab 4 is `aria-selected`.
   */
  test("the `+` opens a draft that materializes through the add verb on Enter", async ({ page }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `wt-draft-add-${Date.now()}`);
    let addPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/windows\/[^/]+\/web$/.test(new URL(request.url()).pathname)) {
        addPosts++;
      }
    });
    await expect(page.getByTestId("web-tab")).toHaveCount(3);

    await page.getByTestId("web-tab-add").click();
    await expect(page.getByTestId("web-tab-draft")).toHaveCount(1);
    const stripTabs = strip(page).locator('[data-testid="web-tab"], [data-testid="web-tab-draft"]');
    await expect(stripTabs).toHaveCount(4);
    await expect(stripTabs.last()).toHaveAttribute("data-testid", "web-tab-draft");

    await URL_BAR(page).fill("localhost:3003/docs");
    await URL_BAR(page).press("Enter");

    await expectWindowOption(id, "@rk_win_web_4", "/proxy/3003/docs");
    await expectWindowOption(id, "@rk_win_web_active", "4");
    await expect(draftTabs(page)).toHaveCount(0);
    await expect(page.getByTestId("web-tab")).toHaveCount(4);
    await expect(tab(page, 4)).toHaveAttribute("aria-selected", "true");
    expect(addPosts).toBe(1);
  });

  /**
   * Proves: materializing a draft at an existing URL keeps add idempotent;
   * the existing slot is selected, the draft clears, and no slot is appended.
   * Steps:
   * 1. Create the seeded family with slot 2 active.
   * 2. Open a draft, enter slot 1's address, and submit.
   * 3. Assert `_active=1`, no fourth slot exists, and the draft disappears.
   */
  test("a draft targeting an existing URL selects the existing slot without growing the family", async ({ page }) => {
    const id = await makeWindow(page, `wt-draft-existing-${Date.now()}`);

    await page.getByTestId("web-tab-add").click();
    await URL_BAR(page).fill("localhost:3001");
    await URL_BAR(page).press("Enter");

    await expectWindowOption(id, "@rk_win_web_active", "1");
    await expectWindowOption(id, "@rk_win_web_4", "");
    await expect(draftTabs(page)).toHaveCount(0);
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  });

  /**
   * Proves: multiple drafts can coexist; a draft's own × discards only that
   * draft and Esc discards the selected survivor, with no POST or tmux write.
   * Steps:
   * 1. Create a seeded window; navigate; assert the seeded family.
   * 2. Click `+` twice and assert two drafts.
   * 3. Close the first draft with × and assert the second remains.
   * 4. Select the survivor, press Esc, and assert no draft/POST/tmux change.
   */
  test("discarding a draft fires no POST and the tmux family stays untouched", async ({ page }) => {
    const id = await makeWindow(page, `wt-draft-discard-${Date.now()}`);
    let webPosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.includes("/web")) {
        webPosts++;
      }
    });
    await expectWindowOption(id, "@rk_win_web_active", "2");

    await page.getByTestId("web-tab-add").click();
    await page.getByTestId("web-tab-add").click();
    await expect(page.getByTestId("web-tab-draft")).toHaveCount(2);
    await page.getByTestId("web-tab-draft-close").first().click();
    await expect(draftTabs(page)).toHaveCount(1);
    expect(windowOption(id, "@rk_win_web_active")).toBe("2");
    expect(windowOption(id, "@rk_win_web_4")).toBe("");

    await draftTabs(page).click();
    await URL_BAR(page).press("Escape");
    await expect(draftTabs(page)).toHaveCount(0);
    expect(webPosts).toBe(0);
  });

  /**
   * Proves: the folder treatment — the strip sits on the inset ground and the
   * active tab carries the raised card surface (rounded top, no bottom
   * border) while inactive tabs stay fill-less secondary text; the hairline
   * separators hide on either side of the active tab.
   * Steps:
   * 1. Create the seeded three-tab window (active 2); navigate.
   * 2. Assert tab 2 carries `bg-bg-card`/`rounded-t-md`/`border-b-0` and tabs
   *    1/3 do not; assert no separator renders (both flank the active tab).
   * 3. Select tab 1; assert exactly one separator renders (between 2|3).
   */
  test("the active tab renders as a folder on the inset strip ground", async ({ page }) => {
    await makeWindow(page, `wt-folder-${Date.now()}`);
    await expect(strip(page)).toBeVisible({ timeout: READY_TIMEOUT });
    const separators = strip(page).locator("span.w-px");

    await expect(tab(page, 2)).toHaveClass(/bg-bg-card/);
    await expect(tab(page, 2)).toHaveClass(/rounded-t-md/);
    await expect(tab(page, 2)).toHaveClass(/border-b-0/);
    await expect(tab(page, 1)).not.toHaveClass(/bg-bg-card/);
    await expect(tab(page, 3)).not.toHaveClass(/bg-bg-card/);
    await expect(tab(page, 1)).toHaveClass(/text-text-secondary/);
    await expect(separators).toHaveCount(0);

    await tab(page, 1).click();
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
    await expect(separators).toHaveCount(1);
  });

  /**
   * Proves: the width ladder's icon-only rung and scroll — a 16-tab family in
   * a narrow tile floors the active tab at 110px, shrinks inactive tabs to
   * the 34px icon-only floor (label visually hidden but present, title kept,
   * no × even on the fine pointer), and the strip scrolls behind the trailing
   * fade with the selected tab scrolled into view.
   * Steps:
   * 1. Stamp a 16-tab family; set a 420px viewport; navigate.
   * 2. Assert tab 1 (active) is ~110px with a ×, tab 2 is ~34px with a
   *    visually hidden label, its title kept, and no ×.
   * 3. Assert the trailing fade renders; click the last tab; assert it is
   *    selected and inside the strip's visible box.
   */
  test("a 16-tab family in a narrow tile goes icon-only and scrolls behind the fade", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const sixteen = Array.from({ length: 16 }, (_, i) => `/proxy/300${i % 3 + 1}/tab${i}`);
    const id = await makeWindow(page, `wt-ladder-${Date.now()}`, sixteen, 1);
    await page.setViewportSize({ width: 420, height: 800 });
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    await expect(strip(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId("web-tab")).toHaveCount(16);

    const activeBox = await tab(page, 1).boundingBox();
    const iconBox = await tab(page, 2).boundingBox();
    if (!activeBox || !iconBox) throw new Error("tab boxes unavailable");
    expect(Math.round(activeBox.width)).toBe(110);
    expect(Math.round(iconBox.width)).toBe(34);
    // Icon-only inactive: the label stays in the DOM visually hidden (the
    // loaded page title), the title survives, and no × renders — while the
    // active tab keeps its ×.
    await expect(tab(page, 2).locator("span.sr-only")).toHaveText("proxy stub");
    await expect(tab(page, 2)).toHaveAttribute("title", /localhost:300/);
    await expect(tab(page, 2).getByTestId("web-tab-close")).toHaveCount(0);
    await expect(tab(page, 1).getByTestId("web-tab-close")).toBeAttached();

    // The overflowing strip shows the trailing fade, and selecting the last
    // tab scrolls it into the strip's visible box.
    await expect(page.locator(".rk-web-strip-fade")).toBeVisible();
    await tab(page, 16).click();
    await expect(tab(page, 16)).toHaveAttribute("aria-selected", "true");
    const stripBox = await strip(page).boundingBox();
    const lastBox = await tab(page, 16).boundingBox();
    if (!stripBox || !lastBox) throw new Error("strip/tab boxes unavailable");
    expect(lastBox.x).toBeGreaterThanOrEqual(stripBox.x - 1);
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(stripBox.x + stripBox.width + 1);
  });

  /**
   * Proves: dragging a tab to a sibling's right half commits exactly one
   * move POST; the family permutes all three slots and the active pointer
   * follows the moved/affected slots' identity.
   * Steps:
   * 1. Create the seeded window ([3001,3002,3003], active 2); navigate.
   * 2. Pointerdown on tab 1, move past the threshold, release on tab 2's
   *    right half.
   * 3. Assert `@rk_win_web_1..3` read [/proxy/3002/, /proxy/3001/, /proxy/3003/]
   *    and `@rk_win_web_active` reads 1 (the moved tab's new position).
   */
  test("drag-to-reorder commits exactly one move and permutes the tmux family", async ({ page }) => {
    const id = await makeWindow(page, `wt-drag-${Date.now()}`);
    let movePosts = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/web\/\d+\/move$/.test(new URL(request.url()).pathname)) {
        movePosts++;
      }
    });
    await expect(page.getByTestId("web-tab")).toHaveCount(3);

    const first = page.getByTestId("web-tab").first();
    const second = page.getByTestId("web-tab").nth(1);
    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    if (!firstBox || !secondBox) throw new Error("web tab boxes unavailable");
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width * 0.75, secondBox.y + secondBox.height / 2, {
      steps: 4,
    });
    await expect(second.getByTestId("web-tab-drop-indicator")).toBeVisible();
    await page.mouse.up();

    await expectWindowOption(id, "@rk_win_web_1", TAB_URLS[1]);
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[0]);
    await expectWindowOption(id, "@rk_win_web_3", TAB_URLS[2]);
    await expectWindowOption(id, "@rk_win_web_active", "1");
    expect(movePosts).toBe(1);
  });

  /**
   * Proves: ⌥⇧←/⌥⇧→ from the focused tablist moves the active tab one
   * slot; the family permutes all three slots and `_active` follows the
   * moved/affected slots' identity.
   * Steps:
   * 1. Create the seeded window ([3001,3002,3003], active 2); navigate.
   * 2. Focus tab 2 and press ⌥⇧←.
   * 3. Assert the family shifted and `_active` reads the moved slot.
   * 4. ⌥⇧→ returns it to the middle.
   */
  test("⌥⇧ arrows move the active tab; the family and pointer repoint", async ({ page }) => {
    const id = await makeWindow(page, `wt-move-key-${Date.now()}`);
    await expect(page.getByTestId("web-tab")).toHaveCount(3);

    await tab(page, 2).focus();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await expectWindowOption(id, "@rk_win_web_1", TAB_URLS[1]);
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[0]);
    await expectWindowOption(id, "@rk_win_web_active", "1");
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expectWindowOption(id, "@rk_win_web_1", TAB_URLS[0]);
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[1]);
    await expectWindowOption(id, "@rk_win_web_active", "2");
  });

  /**
   * Proves: the palette `Web: Move tab right` entry POSTs a move directly;
   * the family permutes and `_active` follows the moved slot.
   * Steps:
   * 1. Create the seeded window ([3001,3002,3003], active 1); navigate.
   * 2. Open the palette, filter to "Move tab right", assert the left boundary
   *    entry is absent, and click the right entry.
   * 3. Assert `@rk_win_web_2` holds the former slot 1 URL and `_active`
   *    reads "2" (the moved slot's new position).
   */
  test("the palette `Web: Move tab right` POSTs a move and the pointer follows", async ({ page }) => {
    const id = await makeWindow(page, `wt-move-palette-${Date.now()}`, TAB_URLS, 1);

    const palette = await openPalette(page);
    await palette.fill("Move tab right");
    await expect(page.getByRole("option", { name: "Web: Move tab left" })).toHaveCount(0);
    await page.getByRole("option", { name: "Web: Move tab right" }).click();

    await expectWindowOption(id, "@rk_win_web_1", TAB_URLS[1]);
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[0]);
    await expectWindowOption(id, "@rk_win_web_active", "2");
  });

  /**
   * Proves: middle-click on a tab POSTs the remove verb; the family
   * renumbers its slots and `_active` follows the repoint rule
   * (min(n, newLen)).
   * Steps:
   * 1. Create the seeded window with active=2; navigate.
   * 2. Middle-click (button 1) on second tab; assert `_active` stays "2"
   *    with two tabs renumbered.
   */
  test("middle-click closes the tab and renumbers the family (remove verb path)", async ({ page }) => {
    const id = await makeWindow(page, `wt-midclose-${Date.now()}`);
    await expect(page.getByTestId("web-tab")).toHaveCount(3);

    await tab(page, 2).dispatchEvent("auxclick", { button: 1 });
    await expectWindowOption(id, "@rk_win_web_2", TAB_URLS[2]);
    expect(windowOption(id, "@rk_win_web_3")).toBe("");
    await expectWindowOption(id, "@rk_win_web_active", "2");
  });

  /**
   * Proves: tab state is shared: a second browser context sees the active tab
   * selected by the first while every frame remains URL-keyed.
   * Steps:
   * 1. Create the seeded window, select tab 1, and wait for tmux.
   * 2. Open a fresh browser context, stub its proxy routes, and navigate to
   *    the same window.
   * 3. Assert tab 1 is selected and its frame alone is visible.
   * 4. Close the extra browser context.
   */
  test("a second browser context converges on the selected tab", async ({ page, browser }) => {
    // Two full app boots in one case: needs headroom beyond the default under suite load.
    test.setTimeout(60_000);
    const id = await makeWindow(page, `wt-coherence-${Date.now()}`);
    await tab(page, 1).click();
    await expectWindowOption(id, "@rk_win_web_active", "1");

    const context2 = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    try {
      const page2 = await context2.newPage();
      await stubProxyPorts(page2, 3001, 3002, 3003);
      await page2.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
      await expect(page2.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
        timeout: READY_TIMEOUT,
      });
      await expect(tab(page2, 1)).toHaveAttribute("aria-selected", "true");
      await expect(visibleFrames(page2)).toHaveCount(1);
      await expect(visibleFrames(page2)).toHaveAttribute("src", TAB_URLS[0]);
    } finally {
      await context2.close();
    }
  });

  /**
   * Proves: after a draft materializes through add, ordinary address-bar Enter
   * still replaces only the active slot and never grows the family.
   * Steps:
   * 1. Create the seeded family and materialize a fourth tab from a draft.
   * 2. Enter a different address in the active tab's bar.
   * 3. Assert slot 4 changes, slot 5 stays empty, slots 1–3 stay intact, and
   *    `_active` remains 4.
   */
  test("address-bar Enter replaces the materialized active tab without adding another", async ({ page }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `wt-replace-${Date.now()}`);
    await page.getByTestId("web-tab-add").click();
    await URL_BAR(page).fill("localhost:3003/docs");
    await URL_BAR(page).press("Enter");
    await expectWindowOption(id, "@rk_win_web_active", "4");
    await expect(draftTabs(page)).toHaveCount(0);
    await expect(tab(page, 4)).toHaveAttribute("aria-selected", "true");
    await expect(URL_BAR(page)).toHaveValue("localhost:3003/docs");

    await URL_BAR(page).fill("localhost:3001/alt");
    await URL_BAR(page).press("Enter");

    await expectWindowOption(id, "@rk_win_web_4", "/proxy/3001/alt");
    await expectWindowOption(id, "@rk_win_web_5", "");
    expect(windowOption(id, "@rk_win_web_1")).toBe(TAB_URLS[0]);
    expect(windowOption(id, "@rk_win_web_2")).toBe(TAB_URLS[1]);
    expect(windowOption(id, "@rk_win_web_3")).toBe(TAB_URLS[2]);
    await expectWindowOption(id, "@rk_win_web_active", "4");
  });

  /**
   * Proves: a repo-relative path pasted into the address bar resolves through
   * the backend stat into an appended present tab (append-or-focus — the
   * current tab is never navigated in place), and submitting the same path
   * again focuses the existing tab via the add verb's idempotent identity
   * match instead of duplicating it.
   * Steps:
   * 1. Create a window whose pane cwd is presentDir (carries
   *    docs/report.html), stamp a one-slot family, navigate.
   * 2. Fill the address bar with `docs/report.html`, press Enter.
   * 3. Assert slot 2 stores a /present/ URL for report.html, active repoints
   *    to 2, and slot 1 is untouched.
   * 4. Select tab 1, submit the same path again; assert active returns to 2
   *    with no third slot and still two tabs.
   */
  test("a pasted repo-relative path lands as an appended present tab, idempotently", async ({ page }) => {
    test.setTimeout(45_000);
    const name = `wt-path-${Date.now()}`;
    newWindow(TEST_SESSION, name, { cwd: presentDir });
    const id = await resolveWindow(page, name);
    stampWebTabs(id, [TAB_URLS[0]], 1);
    setWindowOption(id, "@rk_win_layout", "single:web");
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    await URL_BAR(page).fill("docs/report.html");
    await URL_BAR(page).press("Enter");
    await expectWindowOption(id, "@rk_win_web_active", "2");
    expect(windowOption(id, "@rk_win_web_2")).toContain("/present/");
    expect(windowOption(id, "@rk_win_web_2")).toContain("report.html");
    expect(windowOption(id, "@rk_win_web_1")).toBe(TAB_URLS[0]);
    await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");

    // Append-or-focus: from tab 1, re-submitting the same path focuses the
    // existing present tab — the family never grows a duplicate.
    await tab(page, 1).click();
    await expectWindowOption(id, "@rk_win_web_active", "1");
    await URL_BAR(page).fill("docs/report.html");
    await URL_BAR(page).press("Enter");
    await expectWindowOption(id, "@rk_win_web_active", "2");
    expect(windowOption(id, "@rk_win_web_3")).toBe("");
    await expect(page.getByTestId("web-tab")).toHaveCount(2);
  });

  /**
   * Proves: a path target the backend cannot stat surfaces the server's 400
   * error text verbatim in the address bar's inline alert — no tab is added
   * and the stored family is untouched.
   * Steps:
   * 1. Create a window whose pane cwd is presentDir with a one-slot family;
   *    navigate.
   * 2. Fill the address bar with `docs/nope.html` (no such file), press Enter.
   * 3. Assert the role=alert shows the backend's "does not exist" text, the
   *    strip still has one tab, and slot 2 stays empty.
   */
  test("a nonexistent path target surfaces the backend 400 inline, adding nothing", async ({ page }) => {
    test.setTimeout(30_000);
    const name = `wt-path-miss-${Date.now()}`;
    newWindow(TEST_SESSION, name, { cwd: presentDir });
    const id = await resolveWindow(page, name);
    stampWebTabs(id, [TAB_URLS[0]], 1);
    setWindowOption(id, "@rk_win_layout", "single:web");
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    await URL_BAR(page).fill("docs/nope.html");
    await URL_BAR(page).press("Enter");
    await expect(page.getByTestId("surface-tile-web").getByRole("alert")).toContainText(
      "does not exist",
    );
    await expect(page.getByTestId("web-tab")).toHaveCount(1);
    expect(windowOption(id, "@rk_win_web_2")).toBe("");
    await expectWindowOption(id, "@rk_win_web_active", "1");
  });

  /**
   * Proves: a stored LEGACY slot-form present URL
   * (`/present/@N/{n}/{path}?server=`) keeps serving unchanged through the
   * legacy arm for one release (the compat row; the new arm lives in
   * web-tile-chrome.spec.ts).
   *
   * Steps:
   * 1. Create a window; stamp slot 1 with the LEGACY slot-form present URL
   *    embedding the resolved `@N` id, plus a slot-1
   *    `@rk_win_present_root` declaration (the legacy arm's dual-read).
   * 2. Reload the bare route; assert the tile keeps the legacy address and
   *    the strip label derives the file basename.
   */
  test("a stored LEGACY slot-form present URL serves through the legacy arm (R4)", async ({
    page,
  }) => {
    // Two navigations (makeWindow goto + the restamp reload) need headroom
    // beyond the default under suite load.
    test.setTimeout(60_000);
    const id = await makeWindow(page, `wt-legacy-${Date.now()}`);
    // Recompose with the LEGACY slot form; the @N id embeds differently than
    // the content-keyed hash. The slot-1 root declaration uses the retired
    // @rk_win_present_root (the legacy arm's dual-read).
    stampWebTabs(id, [`/present/${id}/1/legacy-doc.html?server=${TMUX_SERVER}`], 1);
    setWindowOption(id, "@rk_win_present_root", presentDir);
    // makeWindow already navigated; reload so the restamped family renders.
    await page.reload();
    const tile = page.getByTestId("surface-tile-web");
    await expect(tile.getByLabel("URL")).toHaveValue("legacy-doc.html", { timeout: READY_TIMEOUT });
    await expect(page.getByTestId("web-tab").nth(0)).toHaveAttribute("aria-selected", "true");
  });
});
