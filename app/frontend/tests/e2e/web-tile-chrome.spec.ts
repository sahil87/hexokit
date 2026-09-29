/**
 * Web tile browser chrome e2e: explicit error states replace the silent blank
 * iframe, back/forward drive the same-origin frame history per-viewer with
 * zero option writes, and the address bar splits display form from raw edit
 * form.
 *
 * Shared setup: `beforeAll` creates a dedicated session `e2e-webchrome-<ts>`
 * (80×24) plus a scratch present dir (`mkdtemp`) holding `page-one.html`
 * (which links to `page-two.html` — the NEW `/present/{server}/{hash}`
 * content-keyed route derives the server from the path, so the in-frame
 * link needs no query plumbing) and `page-two.html`; `afterAll` kills the
 * session and removes the scratch dir. `beforeEach` sets a 1440×800
 * desktop viewport. `makeWindow(name, {url?, presentRoot?})` runs `tmux
 * new-window` plus a slot-1 web tab stamp (`stampWebTab`) and a direct
 * `set-option -w` stamp of `@rk_win_present_root`; `url` is omittable so
 * `/present/…` addresses can embed the resolved `@N` id before navigation.
 * `presentAddress(abs, server)` composes the NEW content-keyed form (server
 * + sha256(root) leading 12 hex) when the spec stamps a new-form stored
 * value. `gotoWebTile` deep-links `/<server>/<@N>?view=web` and waits for
 * the `Proxied content` iframe. `trackOptionPosts` records every
 * `POST /api/windows/…/options` for the zero-mutation assertions.
 * `stubWindowOpen` replaces `window.open` with a recorder on
 * `window.__openedUrls` (no real tabs). Chrome-side locators are scoped to
 * `surface-tile-web`; frame content is reached via
 * `frameLocator('iframe[title="Proxied content"]')`.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow, stampWebTab, windowOption } from "./_tmux";
import { resolveWindow as resolveWindowRaw } from "./_ready";

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-webchrome-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// The presented two-page flow (tests b and c) is served from a scratch dir
// through the real `/present/` route — the window carries the serve root in
// @rk_win_web_1_root (the NEW arm's declared-set read), exactly as `rk
// present` stamps it. The spec uses the NEW content-keyed URL form for its
// stored values; the new arm's resolution matches against the server's
// declared roots.
let presentDir: string;

/** The composed hash segment for a present address's serve root — the same
 *  sha256(path).slice(0, 12) the backend's `rk present` composes. */
function presentHash(abs: string): string {
  return createHash("sha256").update(abs).digest("hex").slice(0, 12);
}

/** Compose the NEW content-kind /present/{server}/{hash}/{name} form. */
function presentAddress(abs: string, server: string, name: string): string {
  return `/present/${server}/${presentHash(abs)}/${name}`;
}

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Stamp a window option directly via tmux (execFileSync arg arrays — never a
 *  shell string), the same window-option seam web-view-lens.spec.ts uses. */
function setWindowOpt(windowId: string, key: string, value: string): void {
  execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", windowId, key, value], {
    stdio: "ignore",
  });
}

/** Create a window and stamp its slot-1 web tab (plus @rk_win_web_1_root
 *  when the address is a /present/ one — the new arm's declared-set read).
 *  Returns the @N id. `url` may be omitted when the address needs the
 *  resolved id (the /present/ path embeds it) — stamp it via setWindowOpt
 *  before navigating. */
async function makeWindow(
  page: Page,
  name: string,
  opts: { url?: string; presentRoot?: string },
): Promise<string> {
  newWindow(TEST_SESSION, name, { cwd: "/tmp" });
  const id = await resolveWindow(page, name);
  if (opts.url !== undefined) stampWebTab(id, opts.url);
  if (opts.presentRoot) setWindowOpt(id, "@rk_win_web_1_root", opts.presentRoot);
  return id;
}

/** Deep-link a window into the web lens and wait for the iframe. */
async function gotoWebTile(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}?view=web`);
  await expect(page.getByTitle("Proxied content")).toBeAttached({ timeout: READY_TIMEOUT });
}

/** Record every window-option POST for the zero-mutation assertions (R7). */
function trackOptionPosts(page: Page): string[] {
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/api\/windows\/.*\/options/.test(req.url())) {
      posts.push(req.url());
    }
  });
  return posts;
}

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

const webTile = (page: Page) => page.getByTestId("surface-tile-web");
const addressInput = (page: Page) => webTile(page).getByLabel("URL");

test.beforeAll(() => {
  createSession(TEST_SESSION);
  presentDir = mkdtempSync(join(tmpdir(), "rk-e2e-present-"));
  // The in-frame link carries no query plumbing: the NEW /present/{server}/
  // {hash} content-keyed route reads the server from the path, so a bare
  // relative link resolves against the same declaration set.
  writeFileSync(
    join(presentDir, "page-one.html"),
    '<!doctype html><html><head><title>Page One</title></head><body><a href="page-two.html" id="go">two</a></body></html>',
  );
  writeFileSync(
    join(presentDir, "page-two.html"),
    '<!doctype html><html><head><title>Page Two</title></head><body><p>second</p></body></html>',
  );
});

test.afterAll(() => {
  killSession(TEST_SESSION);
  rmSync(presentDir, { recursive: true, force: true });
});

test.describe("Web tile browser chrome (260819-v6y4)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: a probed-blocked external URL renders the refusal error box
   * ("{host} refuses embedding" + the reason line) instead of a silent blank
   * iframe, and the in-error "Open in browser ↗" button pops the current
   * address in a new tab without any option write.
   *
   * Steps:
   * 1. Record `/options` POSTs; stub `window.open`; `page.route` mock
   *    `/api/frame-check*` (trailing `*` covers the query string) to answer
   *    `embeddable: false` with `X-Frame-Options: DENY`; abort the external
   *    iframe navigation so the test is hermetic.
   * 2. Create a window with
   *    web tab `https://framed-refusal.example/some/page`; deep-link
   *    `?view=web`.
   * 3. Assert the error box is visible with the refusal copy, and the iframe
   *    is hidden.
   * 4. Click the error box's "Open in browser" button; assert `__openedUrls`
   *    received the address and zero `/options` POSTs fired.
   */
  test("(a) a frame-refused external URL renders the error state with the Open-in-browser escape hatch", async ({
    page,
  }) => {
    await stubWindowOpen(page);
    // Mock the frame-check probe (trailing `*` — the glob must cover the
    // query string) and abort the external navigation so the test is hermetic.
    await page.route("/api/frame-check*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reachable: true,
          embeddable: false,
          status: 200,
          reason: "X-Frame-Options: DENY",
        }),
      }),
    );
    await page.route("https://framed-refusal.example/**", (route) => route.abort());

    const id = await makeWindow(page, `wc-refuse-${Date.now()}`, {
      url: "https://framed-refusal.example/some/page",
    });
    await gotoWebTile(page, id);
    // Count option POSTs only once the tile is up: the `?view=web` arrival may
    // itself translate into one `@rk_win_layout` write (the tree form `web`),
    // which is the deep link's business, not the chrome's.
    await expect.poll(() => windowOption(id, "@rk_win_layout"), { timeout: 10_000 }).toBe("web");
    const optionPosts = trackOptionPosts(page);

    // The refusal state replaces a silent blank iframe (design study state 05).
    const errBox = page.getByTestId("web-tile-error");
    await expect(errBox).toBeVisible({ timeout: 10_000 });
    await expect(errBox).toContainText("framed-refusal.example refuses embedding");
    await expect(errBox).toContainText("X-Frame-Options: DENY");
    await expect(page.getByTitle("Proxied content")).toBeHidden();

    // The escape hatch pops the CURRENT address — no option write.
    await errBox.getByRole("button", { name: "Open in browser" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls))
      .toEqual(["https://framed-refusal.example/some/page"]);
    expect(optionPosts, `no /options POST; got ${optionPosts.join(", ")}`).toHaveLength(0);
  });

  /**
   * Proves: ◀/▶ navigate the frame's own history (view state); the address
   * bar's display form tracks the frame's current location; neither touches
   * the option (the substrate/view split).
   *
   * Steps:
   * 1. Create a window with `@rk_win_present_root` = the scratch dir and
   *    web tab `/present/<@N>/page-one.html?server=<e2e-server>`;
   *    deep-link `?view=web`.
   * 2. Assert the frame shows page one and the address input's rest value is
   *    the display form `page-one.html`.
   * 3. Click the in-frame link; assert page two renders and the input tracks
   *    `page-two.html`.
   * 4. Click the tile's Back button; assert page one returns and the input
   *    reads `page-one.html`.
   * 5. Click Forward; assert page two again. Assert zero `/options` POSTs
   *    throughout.
   */
  test("(b) back/forward drive the same-origin frame history per-viewer — zero option POSTs", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wc-nav-${Date.now()}`, { presentRoot: presentDir });
    stampWebTab(id, presentAddress(presentDir, TMUX_SERVER, "page-one.html"));
    await gotoWebTile(page, id);
    // Count option POSTs only once the tile is up (the arrival's translation
    // write — the tree form `web` — is the deep link's, not the chrome's).
    await expect.poll(() => windowOption(id, "@rk_win_layout"), { timeout: 10_000 }).toBe("web");
    const optionPosts = trackOptionPosts(page);

    const frame = page.frameLocator('iframe[title="Proxied content"]');
    await expect(frame.locator("#go")).toBeVisible({ timeout: 10_000 });
    // Rest display form: the file basename, plumbing params hidden.
    await expect(addressInput(page)).toHaveValue("page-one.html");

    // Navigate in-frame; the address bar's DISPLAY tracks the frame location
    // (view state), never the substrate.
    await frame.locator("#go").click();
    await expect(frame.locator("p", { hasText: "second" })).toBeVisible({ timeout: 10_000 });
    await expect(addressInput(page)).toHaveValue("page-two.html");

    // ◀ returns to page one — contentWindow.history, zero /options POSTs.
    await webTile(page).getByRole("button", { name: "Back" }).click();
    await expect(frame.locator("#go")).toBeVisible({ timeout: 10_000 });
    await expect(addressInput(page)).toHaveValue("page-one.html");

    // ▶ goes forward again.
    await webTile(page).getByRole("button", { name: "Forward" }).click();
    await expect(frame.locator("p", { hasText: "second" })).toBeVisible({ timeout: 10_000 });
    await expect(addressInput(page)).toHaveValue("page-two.html");

    expect(optionPosts, `no /options POST; got ${optionPosts.join(", ")}`).toHaveLength(0);
  });

  /**
   * Proves: at rest the address bar shows the pretty form (basename, plumbing
   * params hidden); focusing reveals the raw editable value with select-all;
   * Escape reverts without a POST.
   *
   * Steps:
   * 1. Same presented rig as (b); wait for page one.
   * 2. Assert the input value is `page-one.html`.
   * 3. Click the input; assert the value becomes the raw
   *    `/present/<@N>/page-one.html?server=<e2e-server>` and the selection
   *    spans all of it.
   * 4. Press Escape; assert the value is back to `page-one.html`.
   */
  test("(c) the address bar shows the display form at rest and the raw value on focus; Escape reverts", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wc-display-${Date.now()}`, { presentRoot: presentDir });
    stampWebTab(id, presentAddress(presentDir, TMUX_SERVER, "page-one.html"));
    await gotoWebTile(page, id);
    const frame = page.frameLocator('iframe[title="Proxied content"]');
    await expect(frame.locator("#go")).toBeVisible({ timeout: 10_000 });

    const input = addressInput(page);
    await expect(input).toHaveValue("page-one.html");

    // Focus reveals the raw editable value (the tracked frame location),
    // fully selected.
    await input.click();
    await expect(input).toHaveValue(presentAddress(presentDir, TMUX_SERVER, "page-one.html"));
    const selection = await input.evaluate((el: HTMLInputElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]);
    expect(selection).toEqual([0, presentAddress(presentDir, TMUX_SERVER, "page-one.html").length]);

    // Escape reverts to the display form with no POST.
    await input.press("Escape");
    await expect(input).toHaveValue("page-one.html");
  });

});
