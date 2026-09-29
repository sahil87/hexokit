/**
 * Zen mode e2e: the ⇧⌘⏎ / ⇧Ctrl+⏎ `zen-toggle` chord on a single-tile
 * desktop terminal route, the transient top-bar + sidebar hide, the
 * always-visible-in-zen status-bar exit button, and the `View: Enter/Exit Zen
 * Mode` palette entries.
 *
 * Shared setup: own tmux session (`e2e-zen-<ts>`) created in `beforeAll`,
 * killed in `afterAll`; windows are created per test via `_tmux.newWindow`
 * and resolved through the SSE snapshot (`_ready.resolveWindow`). Desktop
 * viewport (1440×800) — zen is desktop-only. `beforeEach` seeds localStorage
 * `hexokit-sidebar-open = "true"` via `page.addInitScript` so the round-trip
 * test asserts a KNOWN persisted preference survives untouched. The chord
 * resolves on the Linux browser host as `Shift+Control+Enter` (the mac ⇧⌘⏎
 * form is unit-tested in `keybindings.test.ts`). The ⇧⌘⏎ chord fires from the
 * xterm pane (its `ignoreInputs` carve-out); the palette chord does NOT
 * (the pane's key handling swallows it on Linux — a pre-existing
 * terminal-routing property, unrelated to zen), so `zenPalette` defocuses to
 * the status bar before delegating the press to the shared `openPalette`.
 */
import { test, expect, type Page } from "@playwright/test";
import { openPalette, READY_TIMEOUT, resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-zen-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// The chord under test, as it resolves on the e2e rig's Linux browser host
// (base shifted tier — the mac ⇧⌘⏎ form is unit-tested in keybindings.test.ts).
const CHORD_ZEN = "Shift+Control+Enter";

const SIDEBAR_PREF_KEY = "hexokit-sidebar-open";

const sidebarAside = (page: Page) => page.locator('aside[aria-label="Sidebar"]');
const topBar = (page: Page) => page.getByRole("banner");
const statusBar = (page: Page) => page.getByTestId("status-bar");
const exitZenButton = (page: Page) => page.getByTestId("status-bar-exit-zen");
const ttyTile = (page: Page) => page.getByTestId("surface-tile-tty");

/** Create a window and return its stable `@N` id. */
async function makeWindow(page: Page, name: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  return (await resolveWindow(page, TMUX_SERVER, TEST_SESSION, name)).windowId;
}

/** Navigate to a window's terminal route and wait for the SSE connection. */
async function gotoWindow(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/** Read the persisted sidebar preference straight out of localStorage. */
async function sidebarPref(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), SIDEBAR_PREF_KEY);
}

/** Open the command palette and return the DIALOG — these tests scope their
 *  option queries to it, unlike `openPalette`, which returns the input.
 *  Focus starts in the xterm pane here, which swallows the chord, so defocus
 *  to chrome up front rather than paying the shared helper's retry. */
async function zenPalette(page: Page) {
  await page.getByTestId("status-bar").click({ position: { x: 400, y: 12 } });
  await openPalette(page);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible({ timeout: READY_TIMEOUT });
  return palette;
}

test.beforeAll(() => {
  createSession(TEST_SESSION);
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  // A known persisted sidebar preference — the round-trip test asserts this
  // exact value survives a zen enter/exit untouched.
  await page.addInitScript(
    (key) => localStorage.setItem(key, "true"),
    SIDEBAR_PREF_KEY,
  );
});

/**
 * Proves: the chord mounts at arity 1 (a single-tile layout used to swallow
 * it); entering zen hides the top bar and the sidebar while keeping the
 * status bar visible with its exit affordance; zen is transient — the
 * persisted sidebar preference is never written on a zen path; exiting via
 * the status-bar button restores exactly the persisted chrome.
 *
 * Steps:
 * 1. Create window A; navigate; wait for the tty tile.
 * 2. Assert baseline: top bar, sidebar, status bar all visible; no exit
 *    button; the seeded preference reads `"true"`.
 * 3. Click into the xterm and press ⇧Ctrl+⏎; assert the top bar and sidebar
 *    hide, the status bar stays visible, and the `status-bar-exit-zen` button
 *    appears.
 * 4. Assert localStorage `hexokit-sidebar-open` still reads `"true"` mid-zen.
 * 5. Click the exit button; assert top bar + sidebar return, the exit button
 *    disappears, and the preference still reads `"true"`.
 */
test("enter via ⇧⌘⏎ hides top bar + sidebar at arity 1, keeps the status bar with an exit button; exit via the button restores chrome and never writes the sidebar preference", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const id = await makeWindow(page, `zen-a-${Date.now()}`);
  await gotoWindow(page, id);
  await expect(ttyTile(page)).toBeVisible({ timeout: READY_TIMEOUT });

  // Baseline: full chrome, no exit button, preference as seeded.
  await expect(topBar(page)).toBeVisible();
  await expect(sidebarAside(page)).toBeVisible();
  await expect(statusBar(page)).toBeVisible();
  await expect(exitZenButton(page)).toHaveCount(0);
  expect(await sidebarPref(page)).toBe("true");

  // Enter zen at arity 1 — the chord now mounts here (the 260820-o8cr gap).
  await page.locator(".xterm").first().click();
  await page.keyboard.press(CHORD_ZEN);
  await expect(topBar(page)).toBeHidden({ timeout: READY_TIMEOUT });
  await expect(sidebarAside(page)).toBeHidden();
  // The compose strip surface and the status bar STAY visible — and the
  // status bar carries the always-visible-in-zen exit affordance.
  await expect(statusBar(page)).toBeVisible();
  await expect(exitZenButton(page)).toBeVisible();
  // Zen is transient: the persisted preference is untouched mid-zen.
  expect(await sidebarPref(page)).toBe("true");

  // Exit via the status-bar button — chrome restored to the persisted state.
  await exitZenButton(page).click();
  await expect(topBar(page)).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(sidebarAside(page)).toBeVisible();
  await expect(exitZenButton(page)).toHaveCount(0);
  expect(await sidebarPref(page)).toBe("true");
});

/**
 * Proves: the palette offers zen entries findable by "zen" at any arity,
 * exactly one form renders keyed on live zen state, and the entries drive the
 * same enter/exit body as the chord.
 *
 * Steps:
 * 1. Create window C; navigate; wait for the tty tile (arity 1).
 * 2. Open the palette (`openPalette`), filter to "zen"; assert `View: Enter Zen Mode`
 *    is offered and `View: Exit Zen Mode` is absent; select the enter entry.
 * 3. Assert the top bar and sidebar hide (zen entered via the palette).
 * 4. Reopen the palette, filter to "zen"; assert only `View: Exit Zen Mode`
 *    is offered (the one-form flip); select it.
 * 5. Assert the top bar and sidebar return.
 */
test("the palette offers `View: Enter Zen Mode` findable by 'zen' at arity 1, flips to the exit form while zen is active, and drives the same toggle", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const id = await makeWindow(page, `zen-c-${Date.now()}`);
  await gotoWindow(page, id);
  await expect(ttyTile(page)).toBeVisible({ timeout: READY_TIMEOUT });
  // Enter through the palette (arity 1 — the entry is offered at any arity).
  let palette = await zenPalette(page);
  await palette.getByRole("combobox").fill("zen");
  await expect(palette.getByRole("option", { name: /View: Enter Zen Mode/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /View: Exit Zen Mode/ })).toHaveCount(0);
  await palette.getByRole("option", { name: /View: Enter Zen Mode/ }).click();
  await expect(topBar(page)).toBeHidden({ timeout: READY_TIMEOUT });
  await expect(sidebarAside(page)).toBeHidden();

  // One-form flip: while zen is active, only the exit form is offered.
  palette = await zenPalette(page);
  await palette.getByRole("combobox").fill("zen");
  await expect(palette.getByRole("option", { name: /View: Exit Zen Mode/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /View: Enter Zen Mode/ })).toHaveCount(0);
  await palette.getByRole("option", { name: /View: Exit Zen Mode/ }).click();
  await expect(topBar(page)).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(sidebarAside(page)).toBeVisible();
});
