/**
 * Content zoom on the web tile: the URL-bar zoom control, per-bucket
 * localStorage persistence, palette parity, onboarding absence, and the
 * same-origin ctrl-wheel gesture trigger.
 *
 * Shared setup: own tmux session (`e2e-webzoom-<ts>`) created in `beforeAll`,
 * killed in `afterAll`; desktop viewport 1440×800. A stub HTTP server on an
 * ephemeral port serves a static page; windows get
 * slot-1 web tab stamped via `stampWebTab`, so the
 * tile rides the same-origin `/proxy/<port>/` path. Each test starts from a
 * fresh browser context, so `hexokit-web-zoom` begins empty WITHOUT any
 * `addInitScript` (deliberate — an init script would also wipe the key on the
 * persistence test's re-navigation). Navigation goes straight to the web lens
 * (`?view=web` → `single:web`) and waits for the iframe + zoom control.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { openPalette, READY_TIMEOUT, resolveWindow as resolveWindowRaw } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow, stampWebTab } from "./_tmux";

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-webzoom-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// The stub framed page — any same-origin page works; the zoom mechanism never
// reaches into the guest document (scale wrapper only).
const STUB_PAGE =
  "<!doctype html><html><body><p>zoom stub</p></body></html>";

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

/** Create a window and stamp its slot-1 web tab via tmux — the web-tile-find seam. */
async function makeWindow(page: Page, name: string, url: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  const id = await resolveWindow(page, name);
  stampWebTab(id, url);
  return id;
}

const iframe = (page: Page) => page.getByTitle("Proxied content");
const zoomControl = (page: Page) => page.getByTestId("web-zoom-control");
const zoomReadout = (page: Page) => page.getByLabel("Reset zoom");
const zoomWrapper = (page: Page) => page.getByTestId("web-zoom-frame-wrapper");

/** Navigate straight into the web lens (?view=web → single:web — ONE tile)
 *  and wait for the iframe. The readout assertions key on the zoom control. */
async function gotoWebWindow(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}?view=web`);
  await expect(iframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(zoomControl(page)).toBeVisible();
}

let stub: { srv: http.Server; port: number };

test.beforeAll(() => {
  createSession(TEST_SESSION);
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Web tile — content zoom (260823-cwvv R2–R5)", () => {
  test.beforeAll(async () => {
    stub = await startStub();
  });

  test.afterAll(async () => {
    stub.srv.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    // No storage clearing: each test runs in a fresh browser context, so
    // localStorage starts empty — and an addInitScript would re-run on the
    // re-navigation the persistence test depends on.
  });

  /**
   * Proves: the browser-chrome zoom control steps the discrete ladder and the
   * scale wrapper actually transforms the iframe.
   *
   * Steps:
   * 1. Open a proxied web tile; assert the readout is `100%`.
   * 2. Click `Zoom in` twice; assert the readout steps `110%` → `125%` and
   *    the iframe's CSS transform is a 1.25 scale matrix.
   * 3. Click `Zoom out` once; assert `110%`.
   * 4. Click the readout (the reset affordance); assert `100%` and the
   *    wrapper's `data-zoom` is back at `1`.
   */
  test("(a) the control steps the frame 100 → 110 → 125, − steps down, reset returns to 100%", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wz-steps-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    await expect(zoomReadout(page)).toHaveText("100%");

    await page.getByLabel("Zoom in", { exact: true }).click();
    await expect(zoomReadout(page)).toHaveText("110%");
    await page.getByLabel("Zoom in", { exact: true }).click();
    await expect(zoomReadout(page)).toHaveText("125%");
    // The scale wrapper: compensated size + transform on the iframe.
    await expect(iframe(page)).toHaveCSS("transform", /matrix\(1\.25/);

    await page.getByLabel("Zoom out", { exact: true }).click();
    await expect(zoomReadout(page)).toHaveText("110%");
    await zoomReadout(page).click();
    await expect(zoomReadout(page)).toHaveText("100%");
    await expect(zoomWrapper(page)).toHaveAttribute("data-zoom", "1");
  });

  /**
   * Proves: per-viewer localStorage persistence keyed by proxy port — a fresh
   * visit restores the tile's level.
   *
   * Steps:
   * 1. Open a proxied web tile and zoom to `125%`.
   * 2. Re-navigate to the same window's web lens (a fresh mount re-reads the
   *    per-viewer storage — the reload path races iframe-src resolution on
   *    the rig).
   * 3. Assert the readout restores `125%` once the tile re-renders.
   */
  test("(b) the zoom level persists across reload, per bucket", async ({ page }) => {
    const id = await makeWindow(page, `wz-persist-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    await page.getByLabel("Zoom in", { exact: true }).click();
    await page.getByLabel("Zoom in", { exact: true }).click();
    await expect(zoomReadout(page)).toHaveText("125%");

    // Re-navigate rather than reload(): reload leaves the iframe src
    // resolution racing the restored view state; a fresh goto is the same
    // per-viewer-storage read the spec asserts (and the rig's goto is the
    // seam every other spec reloads through).
    await gotoWebWindow(page, id);
    await expect(zoomReadout(page)).toHaveText("125%");
  });

  /**
   * Proves: palette parity (Constitution V) — the `web-zoom` CustomEvent seam
   * drives the mounted tile from the command palette.
   *
   * Steps:
   * 1. Open a proxied web tile.
   * 2. Open the command palette (`openPalette`) and type `Web: Zoom`.
   * 3. Click the `Web: Zoom in` option.
   * 4. Assert the readout steps to `110%`.
   */
  test("(c) the `Web: Zoom in` palette entry steps the tile", async ({ page }) => {
    const id = await makeWindow(page, `wz-palette-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Web: Zoom");
    const option = page.getByRole("option", { name: /Web: Zoom in/ });
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();
    await expect(zoomReadout(page)).toHaveText("110%");
  });

  /**
   * Proves: the onboarding state (an empty web tab family) hides the zoom control
   * and the palette registers nothing for a contentless tile.
   *
   * Steps:
   * 1. Open a window with an empty web tab family in the web lens; assert the
   *    onboarding panel renders.
   * 2. Assert the `web-zoom-control` testid is absent.
   * 3. Open the palette, type `Web: Zoom`, and assert no `Web: Zoom` options
   *    exist.
   */
  test("(d) an onboarding tile renders no zoom control and no Web: Zoom palette entries", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wz-onboard-${Date.now()}`, "");
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}?view=web`);
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(zoomControl(page)).toHaveCount(0);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Web: Zoom");
    // anchored: the palette's Ask-operator fallback row (`Ask operator: "Web: Zoom"`)
    // would substring-match an unanchored pattern; the gated entries are what must be absent.
    await expect(page.getByRole("option", { name: /^Web: Zoom/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  /**
   * Proves: the contentWindow gesture attach with continuous semantics — a
   * ctrl-wheel dispatched inside the framed document scales the tile smoothly
   * to off-ladder values (the Chrome/macOS pinch behavior), every event
   * compounds with no threshold, and click zoom stays quantized
   * (snap-then-step onto the ladder). The event never reaches browser page
   * zoom.
   *
   * Steps:
   * 1. Open a proxied web tile.
   * 2. Inside the framed document, dispatch a `wheel` event with
   *    `deltaY: -60, ctrlKey: true`.
   * 3. Assert the readout shows the continuous value `182%` (`exp(0.6)`) and
   *    the iframe's transform is a ~1.82 scale matrix — an off-ladder value.
   * 4. Dispatch a small `deltaY: -10` ctrl-wheel; assert the readout
   *    compounds to `201%` (no threshold swallowed it).
   * 5. Click the `+` (Zoom in) button; assert `250%` — the continuous value
   *    snapped to the nearest ladder level (2) and stepped (2.5).
   */
  test("(e) ctrl-wheel inside the same-origin frame zooms CONTINUOUSLY; a + click lands back on the ladder", async ({
    page,
  }) => {
    const id = await makeWindow(page, `wz-gesture-${Date.now()}`, `http://localhost:${stub.port}/`);
    await gotoWebWindow(page, id);
    // Dispatch inside the framed document — a real ctrl-wheel over the page
    // never reaches the parent; the tile's contentWindow attach answers it.
    const handle = await iframe(page).elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error("no contentFrame");
    const wheel = (deltaY: number) =>
      frame.evaluate((dy) => {
        document.dispatchEvent(
          new WheelEvent("wheel", { deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true }),
        );
      }, deltaY);
    // Continuous exponential mapping (260824-iafo): exp(0.6) ≈ 1.822 — an
    // OFF-LADDER value, the pinch tracking the fingers instead of clicking
    // between ladder stops.
    await wheel(-60);
    await expect(zoomReadout(page)).toHaveText("182%");
    await expect(iframe(page)).toHaveCSS("transform", /matrix\(1\.82/);
    // Every event compounds — no threshold swallows a small tick.
    await wheel(-10);
    await expect(zoomReadout(page)).toHaveText("201%");
    // Click/shortcut zoom stays quantized: + from ~2.01 snaps to 2, steps to 2.5.
    await page.getByLabel("Zoom in").click();
    await expect(zoomReadout(page)).toHaveText("250%");
  });
});
