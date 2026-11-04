import { test, expect, type Page } from "@playwright/test";
import { READY_TIMEOUT, openPalette, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

// Terminal export e2e — the tty tile header's ⇩ export affordance: the
// button renders on the desktop tty tile header, opens the two-section menu
// ("This view — client buffer" / divider / "Full history — server capture"),
// picking Download snapshot fires a real browser download whose filename
// matches the `{session}-{window}-{YYMMDD-HHmmss}.html` convention, and the
// four export rows are palette-reachable as `Terminal: …` entries on the
// terminal route (Constitution V).
//
// Shared setup: real tmux rig on the isolated e2e server — `beforeAll`
// creates a detached 80×24 session (`e2e-texp-<ts>`, per-spec so files never
// collide) with one window `export` running `echo export-e2e-marker; sleep
// 300` (an idle pane with one printed line, so the client buffer is
// non-empty); `afterAll` kills it. `beforeEach` sets a desktop viewport
// (1440×800) — the tile header is desktop-only chrome, and so is the status
// bar's `Connected` dot (the readiness gate). Each test navigates straight
// to the window's terminal route (`/<server>/<%40id>`), resolved via
// `resolveWindow` from the backend snapshot.

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-texp-${Date.now()}`;
const WINDOW_NAME = "export";
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

const exportButton = (page: Page) =>
  page.getByRole("button", { name: "Export terminal output" });

test.beforeAll(() => {
  // An idle pane with one printed line, so the client buffer is non-empty.
  createSession(TEST_SESSION, {
    windows: [{ name: WINDOW_NAME, command: "echo export-e2e-marker; sleep 300" }],
  });
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
});

/**
 * Proves: the export button is present on the tty tile header; the menu
 * shows both labeled sections with exactly four rows; the snapshot row
 * produces a client-side `.html` download named per the convention
 * (zero-padded clock, session + window tokens); and the menu closes after
 * the pick.
 *
 * Steps:
 * 1. Resolve the `export` window and navigate to its terminal route; wait
 *    for the `Connected` dot and the `surface-tile-tty` tile, then for the
 *    sidebar's session row (`Navigate to <session>`) — the filename tokens
 *    derive from the SSE snapshot (sessionName + statusWindow), and that
 *    row renders from the same payload.
 * 2. Assert the `Export terminal output` button is visible; click it.
 * 3. Assert the menu is visible with both section labels and 4 menuitem
 *    rows.
 * 4. Start listening for a `download` event; click `Download snapshot`.
 * 5. Assert the suggested filename matches
 *    `^e2e-texp-<ts>-export-\d{6}-\d{6}\.html$`; assert the menu closed.
 */
test("⇩ button opens the two-section menu; Download snapshot downloads a convention-named .html", async ({
  page,
}) => {
  // The SSE + terminal mount chain exceeds the 10s default on a contended dev box.
  test.setTimeout(30_000);
  const win = await resolveWindow(page, TMUX_SERVER, TEST_SESSION, WINDOW_NAME);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(win.windowId)}`);
  await expect(
    page.getByTestId("status-bar").locator("[aria-label='Connected']"),
  ).toBeVisible({ timeout: READY_TIMEOUT });
  const ttyTile = page.getByTestId("surface-tile-tty");
  await expect(ttyTile).toBeVisible({ timeout: READY_TIMEOUT });
  // The filename tokens derive from the SSE snapshot (sessionName +
  // statusWindow) — the sidebar session row renders from the same payload, so
  // it is the gate for "the snapshot landed".
  await expect(
    page
      .locator("nav[aria-label='Groups']")
      .locator(`button[aria-label='Navigate to ${TEST_SESSION}']`),
  ).toBeVisible({ timeout: READY_TIMEOUT });

  // The ⇩ export button sits on the tty tile header, left of the pane segment.
  await expect(exportButton(page)).toBeVisible();
  await exportButton(page).click();

  const menu = page.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("This view — client buffer")).toBeVisible();
  await expect(menu.getByText("Full history — server capture")).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(4);

  // Picking the snapshot row fires one download named per
  // {session}-{window}-{YYMMDD-HHmmss}.html and closes the menu.
  const downloadPromise = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: /Download snapshot/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${TEST_SESSION}-${WINDOW_NAME}-\\d{6}-\\d{6}\\.html$`),
  );
  await expect(menu).not.toBeVisible();
});

/**
 * Proves: all four export actions (`Terminal: Download snapshot (HTML)`,
 * `Terminal: Download transcript`, `Terminal: Copy visible screen`,
 * `Terminal: Download full history`) are registered and discoverable
 * through the command palette while a tty tile is mounted.
 *
 * Steps:
 * 1. Resolve the `export` window and navigate to its terminal route; wait
 *    for the `surface-tile-tty` tile.
 * 2. Open the palette via `openPalette` (a chord reaching a focused xterm is
 *    swallowed, so the helper gates on the palette and retries); fill
 *    `Terminal:`.
 * 3. Assert each of the four `Terminal: …` options is listed.
 */
test("the palette carries the four Terminal: export entries on the terminal route", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const win = await resolveWindow(page, TMUX_SERVER, TEST_SESSION, WINDOW_NAME);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(win.windowId)}`);
  await expect(page.getByTestId("surface-tile-tty")).toBeVisible({
    timeout: READY_TIMEOUT,
  });

  const paletteInput = await openPalette(page);
  await paletteInput.fill("Terminal:");

  await expect(
    page.getByRole("option", { name: "Terminal: Download snapshot (HTML)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Terminal: Download transcript" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Terminal: Copy visible screen" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Terminal: Download full history" }),
  ).toBeVisible();
});
