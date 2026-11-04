/**
 * Web tile keyboard capture e2e: the web tile's own full-pass latch
 * (`rk-web-capture`) — while latched, every rk chord but the release binding
 * falls through to the embedded same-origin page (⌘K reaches the page instead
 * of opening rk's palette), and the three exits (tile-header button, release
 * chord, palette row) all release it.
 *
 * Shared setup: `beforeAll` creates a dedicated session `e2e-webcap-<ts>` so
 * this file never collides with other specs; a nested `beforeAll` starts a
 * stub HTTP server on an ephemeral port serving a page that RECORDS ⌘K/Ctrl+K
 * keydowns onto `document.body.dataset` (the page-received proof) plus a
 * focusable `#inner` button (the click-into-frame target); `afterAll` kills
 * the session and closes the stub. `http://localhost:<port>/` converts to the
 * same-origin `/proxy/<port>/` path via `toProxySrc`, so the reclaim seam
 * applies. `makeWindow`/`gotoWebWindow`/`focusFrame` are the
 * web-tile-find.spec.ts seams: tmux window + slot-1 web tab stamp, deep-link
 * `?view=web`, click `#inner` so keydowns go to the framed document. The
 * latch is per-viewer localStorage, so each test releases it up front
 * (`localStorage.removeItem`) to stay independent of test order.
 */
import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import { openPalette, READY_TIMEOUT, resolveWindow as resolveWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow, stampWebTab } from "./_tmux";

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-webcap-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// The stub framed page: a focusable button (the click-into-frame target) and
// a keydown recorder — a ⌘K/Ctrl+K landing on the framed document sets
// `data-cmdk`, the proof the page (not rk) received the chord.
const STUB_PAGE =
  "<!doctype html><html><body>" +
  '<button id="inner">focus target</button>' +
  "<script>window.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.code==='KeyK'){document.body.dataset.cmdk='1';e.preventDefault();}});</script>" +
  "</body></html>";

function startStub(): Promise<{ srv: http.Server; port: number }> {
  const srv = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(STUB_PAGE);
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        reject(new Error("stub server has no port"));
        return;
      }
      resolve({ srv, port: address.port });
    });
  });
}

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Create a window and stamp its slot-1 web tab via tmux. Returns the @N id. */
async function makeWindow(page: Page, name: string, url: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  const id = await resolveWindow(page, name);
  stampWebTab(id, url);
  return id;
}

/** Navigate straight into the web lens (?view=web → single:web) and wait for
 *  the iframe. The latch is viewer-local storage — release it before every
 *  navigation so no test inherits a prior test's latch. */
async function gotoWebWindow(page: Page, windowId: string): Promise<void> {
  await page.addInitScript(() => localStorage.removeItem("rk-web-capture"));
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}?view=web`);
  await expect(iframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
}

const iframe = (page: Page) => page.getByTitle("Proxied content");
const frameBody = (page: Page) =>
  page.frameLocator('iframe[title="Proxied content"]').locator("body");
const captureButton = (page: Page) => page.getByTestId("web-capture-toggle");
const paletteInput = (page: Page) => page.getByPlaceholder("Type a command");

/** Click into the framed page so FOCUS lives inside the iframe. */
async function focusFrame(page: Page): Promise<void> {
  await frameBody(page).locator("#inner").click();
}

/** Whether the framed page has recorded a ⌘K/Ctrl+K keydown. */
async function frameSawCmdK(page: Page): Promise<boolean> {
  const handle = await iframe(page).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("no contentFrame");
  return frame.evaluate(() => document.body.dataset.cmdk === "1");
}

let stub: { srv: http.Server; port: number };

test.beforeAll(() => {
  createSession(TEST_SESSION);
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Web tile — keyboard capture latch", () => {
  test.beforeAll(async () => {
    stub = await startStub();
  });

  test.afterAll(async () => {
    stub.srv.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: the full-pass latch on the iframe engine — while latched, ⌘K
   * pressed inside the same-origin frame reaches the PAGE (rk's palette stays
   * closed), and the release chord is the keyboard route back: pressing it
   * inside the frame releases the latch so ⌘K opens rk's palette again.
   *
   * Steps:
   * 1. Create a window on the same-origin stub URL; open `?view=web`; wait
   *    for the frame's `#inner`.
   * 2. Baseline: click into the frame, press `Meta+k` — rk's palette opens
   *    (reclaim works); close with Escape.
   * 3. Click the tile-header capture button; assert it latches (`aria-pressed`)
   *    and the header meta reads `keys → page`.
   * 4. Click into the frame, press `Meta+k`; assert rk's palette never
   *    appears and the framed page recorded the chord.
   * 5. Press the release chord `Shift+Control+G` inside the frame; assert the
   *    button unlatches and the meta label is gone.
   * 6. Click into the frame, press `Meta+k` — rk's palette opens again.
   */
  test("(a) latched capture hands ⌘K to the page; the release chord restores rk's reclaim", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wc-latch-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    await expect(frameBody(page).locator("#inner")).toBeVisible({ timeout: 10_000 });

    // Baseline: reclaim is live — ⌘K inside the frame opens rk's palette.
    await focusFrame(page);
    await page.keyboard.press("Meta+k");
    await expect(paletteInput(page)).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(paletteInput(page)).toHaveCount(0);

    // Latch via the tile-header button.
    await captureButton(page).click();
    await expect(captureButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("keys → page")).toBeVisible();

    // While latched, ⌘K falls through to the page: rk's palette stays closed
    // and the framed document's recorder fires.
    await focusFrame(page);
    await page.keyboard.press("Meta+k");
    await expect(paletteInput(page)).toHaveCount(0);
    await expect.poll(() => frameSawCmdK(page), { timeout: 5_000 }).toBe(true);

    // The release chord is reclaimed even while latched — the keyboard exit.
    await focusFrame(page);
    await page.keyboard.press("Shift+Control+G");
    await expect(captureButton(page)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("keys → page")).toHaveCount(0);

    // Reclaim restored: ⌘K opens rk's palette again.
    await focusFrame(page);
    await page.keyboard.press("Meta+k");
    await expect(paletteInput(page)).toBeVisible({ timeout: 5_000 });
  });

  /**
   * Proves: the palette row is the latch's pointer/keyboard-parity entry —
   * `Web: Capture keyboard` appears while a content-bearing web tile is open,
   * carries the toggle chord's hint, flips to `Web: Release keyboard` while
   * latched, and selecting it latches/releases the web latch (the third exit).
   *
   * Steps:
   * 1. Create a window on the same-origin stub URL; open `?view=web`.
   * 2. Open the palette; fill `Web: Capture`; assert the option is visible;
   *    click it.
   * 3. Assert the header button latched (`aria-pressed`).
   * 4. Reopen the palette; fill `Web: Release`; click the option; assert the
   *    button is released.
   */
  test("(b) the `Web: Capture keyboard` / `Web: Release keyboard` palette row flips the latch", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wc-palette-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    await expect(frameBody(page).locator("#inner")).toBeVisible({ timeout: 10_000 });

    const input = await openPalette(page);
    await input.fill("Web: Capture");
    const captureOption = page.getByRole("option", { name: /Web: Capture keyboard/ });
    await expect(captureOption).toBeVisible({ timeout: 10_000 });
    await captureOption.click();
    await expect(captureButton(page)).toHaveAttribute("aria-pressed", "true");

    const input2 = await openPalette(page);
    await input2.fill("Web: Release");
    const releaseOption = page.getByRole("option", { name: /Web: Release keyboard/ });
    await expect(releaseOption).toBeVisible({ timeout: 10_000 });
    await releaseOption.click();
    await expect(captureButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * Proves: the onboarding (empty) web tile renders no capture button and no
   * palette row — a no-page tile has nothing to capture for.
   *
   * Steps:
   * 1. Create a window with NO web tab stamp; open `?view=web` (the
   *    onboarding state renders).
   * 2. Assert `web-capture-toggle` is absent.
   * 3. Open the palette; fill `Web: Capture`; assert no option matches.
   */
  test("(c) the onboarding web tile has neither the button nor the palette row", async ({
    page,
  }) => {
    const name = `wc-empty-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    await page.addInitScript(() => localStorage.removeItem("rk-web-capture"));
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}?view=web`);
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: READY_TIMEOUT });

    await expect(captureButton(page)).toHaveCount(0);
    const input = await openPalette(page);
    await input.fill("Web: Capture keyboard");
    // Anchored: the operator-compose fallback row echoes the query as
    // `Ask operator: "Web: Capture keyboard"` and must not count as a match.
    await expect(page.getByRole("option", { name: /^Web: Capture keyboard/ })).toHaveCount(0);
  });
});
