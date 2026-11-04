import { test, expect, type Page, type Route } from "@playwright/test";
import { STORAGE_MIGRATION_MARKER_KEY } from "../../src/lib/legacy-storage-migration";
import { gotoServerReady, READY_TIMEOUT } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

/**
 * Legacy localStorage pickup: the one-shot boot copy in
 * `src/lib/legacy-storage-migration.ts` (invoked from `main.tsx` before the
 * React tree mounts) moves every live `runkit-*`/`runkit:` per-viewer
 * preference to its `hexokit` counterpart — copy, never move, so the
 * originals survive for a downgrade — guarded by the
 * `hexokit-storage-migrated` marker key so it runs once per origin. Without
 * the marker guard, prefs whose absence means "default" (the app deletes the
 * key) would be resurrected from their legacy originals on every boot.
 *
 * Shared setup:
 * - Seeding: `seedLegacyKeys` registers an addInitScript that writes the
 *   legacy keys BEFORE the app's own scripts run, guarded by a sessionStorage
 *   flag so it fires only on the tab's first navigation — the no-resurrection
 *   test reloads the page, and an unguarded seed would re-create the very
 *   legacy keys whose non-copy it asserts. Each test gets a fresh browser
 *   context (fresh localStorage AND sessionStorage), so every test observes
 *   one real first-boot migration.
 * - Seeds: `runkit-theme` = "default-dark" (a real theme id — the rig's
 *   emulated color scheme is light, so `data-theme="dark"` on <html> can only
 *   come from the copied preference), `runkit-sidebar-width` = "320" (inside
 *   the 160–400 clamp, off the 220 default), `runkit-macros` (a one-entry
 *   valid MacroAction JSON array), and the dynamic key
 *   `runkit-last-window:legacy-mig-host` (a per-server key whose server names
 *   no rig server, so the server-switch landing resolution never acts on it).
 * - Navigation: `gotoServerReady(page, TMUX_SERVER, SESSION)` on a desktop
 *   viewport (1440×800, set in beforeEach) — the sidebar aside
 *   (`aria-label="Sidebar"`) is the grid track whose width IS the stored
 *   sidebar width, so its bounding box proves the preference was applied.
 * - page.route stub: the theme preference is HOST-scoped — ThemeProvider
 *   refetches `/api/settings` on mount and rewrites the localStorage cache
 *   from the host's answer (the rig has no host theme, so the sync would
 *   clobber the migrated `hexokit-theme` with "system" mid-assertion). The
 *   pickup test therefore route-HOLDS every `/api/settings` fetch (a regex —
 *   glob patterns miss rk's query strings) until its theme and storage
 *   assertions are done, freezing the migrated pre-sync state the boot copy
 *   produced; the hold is released in a finally. The no-resurrection test
 *   asserts only sidebar width (device-local, never host-synced) and needs no
 *   hold.
 * - tmux: one dedicated session `e2e-legacystorage-<ts>` (one window) created
 *   in beforeAll on the isolated e2e socket, killed in afterAll — never run
 *   Playwright directly, use `just test-e2e legacy-storage-migration`.
 */

const TEST_SESSION = `e2e-legacystorage-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

const SEED_FLAG = "e2e-legacy-storage-seeded";
const SIDEBAR_WIDTH_SEED = "320";
const THEME_SEED = "default-dark";
const MACROS_SEED = JSON.stringify([
  {
    actionId: "macro:e2e-migrated",
    kind: "macro",
    label: "Migrated macro",
    target: { type: "palette", paletteActionId: "view.terminal" },
  },
]);
const LAST_WINDOW_KEY = "runkit-last-window:legacy-mig-host";
const LAST_WINDOW_SEED = "@7";

async function seedLegacyKeys(page: Page): Promise<void> {
  await page.addInitScript(
    ({ flag, theme, width, macros, lastWindowKey, lastWindow }) => {
      if (sessionStorage.getItem(flag)) return;
      sessionStorage.setItem(flag, "1");
      localStorage.setItem("runkit-theme", theme);
      localStorage.setItem("runkit-sidebar-width", width);
      localStorage.setItem("runkit-macros", macros);
      localStorage.setItem(lastWindowKey, lastWindow);
    },
    {
      flag: SEED_FLAG,
      theme: THEME_SEED,
      width: SIDEBAR_WIDTH_SEED,
      macros: MACROS_SEED,
      lastWindowKey: LAST_WINDOW_KEY,
      lastWindow: LAST_WINDOW_SEED,
    },
  );
}

/** Read the named localStorage keys (null when absent). */
function readStorage(page: Page, keys: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(
    (ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])),
    keys,
  );
}

const SETTINGS_ROUTE = /\/api\/settings(\?.*)?$/;

/**
 * Stall every `/api/settings` fetch the page makes until the returned release
 * runs, so the host-scoped theme sync cannot rewrite the migrated localStorage
 * cache before the assertions read it. The handler neither continues nor
 * fulfills, leaving each request pending.
 */
async function holdSettingsFetch(page: Page): Promise<() => Promise<void>> {
  const pending: Route[] = [];
  await page.route(SETTINGS_ROUTE, (route) => {
    pending.push(route);
  });
  return async () => {
    await page.unroute(SETTINGS_ROUTE);
    for (const route of pending.splice(0)) {
      await route.continue().catch(() => {});
    }
  };
}

/** The sidebar aside's rendered width in px — the preference made visible. */
async function sidebarWidthPx(page: Page): Promise<number | undefined> {
  return (await page.locator('aside[aria-label="Sidebar"]').boundingBox())?.width;
}

test.describe("Legacy localStorage migration", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION, { windows: ["win-a"] });
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: the first boot after the rename applies the legacy `runkit-*`
   * preferences (the dark theme lands on the root element, the sidebar renders
   * at the stored 320px), copies every seeded legacy key to its `hexokit`
   * counterpart with the value intact, sets the migration marker, and leaves
   * the `runkit-*` originals in place.
   *
   * Steps:
   * 1. Route-hold every `/api/settings` fetch (theme is host-scoped: the
   *    provider's mount sync would otherwise overwrite the migrated
   *    `hexokit-theme` with the rig's host default before the assertions).
   * 2. Seed the legacy keys via addInitScript (first navigation only), then
   *    load the server route and wait for the session row.
   * 3. Assert `data-theme="dark"` on <html> (the rig emulates a light color
   *    scheme, so dark can only come from the migrated preference).
   * 4. Assert the sidebar aside renders at 320px.
   * 5. Assert the `hexokit-*` counterparts hold the seeded values, the marker
   *    key is set, and every `runkit-*` original is still present; then
   *    release the settings hold (finally).
   */
  test("first boot copies runkit-* keys to hexokit-*, applies them, and keeps the originals", async ({
    page,
  }) => {
    // Step 1.
    const releaseSettings = await holdSettingsFetch(page);
    try {
      // Step 2.
      await seedLegacyKeys(page);
      await gotoServerReady(page, TMUX_SERVER, TEST_SESSION);

      // Step 3.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", {
        timeout: READY_TIMEOUT,
      });

      // Step 4.
      await expect
        .poll(() => sidebarWidthPx(page), { timeout: READY_TIMEOUT })
        .toBe(Number(SIDEBAR_WIDTH_SEED));

      // Step 5.
      const stored = await readStorage(page, [
        "hexokit-theme",
        "hexokit-sidebar-width",
        "hexokit-macros",
        "hexokit-last-window:legacy-mig-host",
        STORAGE_MIGRATION_MARKER_KEY,
        "runkit-theme",
        "runkit-sidebar-width",
        "runkit-macros",
        LAST_WINDOW_KEY,
      ]);
      expect(stored).toEqual({
        "hexokit-theme": THEME_SEED,
        "hexokit-sidebar-width": SIDEBAR_WIDTH_SEED,
        "hexokit-macros": MACROS_SEED,
        "hexokit-last-window:legacy-mig-host": LAST_WINDOW_SEED,
        [STORAGE_MIGRATION_MARKER_KEY]: "1",
        "runkit-theme": THEME_SEED,
        "runkit-sidebar-width": SIDEBAR_WIDTH_SEED,
        "runkit-macros": MACROS_SEED,
        [LAST_WINDOW_KEY]: LAST_WINDOW_SEED,
      });
    } finally {
      await releaseSettings();
    }
  });

  /**
   * Proves: the marker guard makes the copy one-shot — a `hexokit-*` key the
   * app deleted after migration (its way of saying "back to default") is NOT
   * recreated from the surviving `runkit-*` original on the next boot, and the
   * sidebar renders at the default width again.
   *
   * Steps:
   * 1. Seed the legacy keys and load the server route; assert the copied
   *    `hexokit-sidebar-width` exists (the copy ran on this boot).
   * 2. Delete `hexokit-sidebar-width`, mimicking the app dropping the pref.
   * 3. Reload (the seed guard keeps the init script from re-seeding) and wait
   *    for the Connected gate.
   * 4. Assert `hexokit-sidebar-width` is still absent, `runkit-sidebar-width`
   *    and the marker are untouched, and the sidebar is back at the 220px
   *    default.
   */
  test("a hexokit-* key deleted after migration is not resurrected from its runkit-* original", async ({
    page,
  }) => {
    // Two full app boots on one rig budget — wider than the per-test default.
    test.setTimeout(30_000);

    // Step 1.
    await seedLegacyKeys(page);
    await gotoServerReady(page, TMUX_SERVER, TEST_SESSION);
    expect(await readStorage(page, ["hexokit-sidebar-width"])).toEqual({
      "hexokit-sidebar-width": SIDEBAR_WIDTH_SEED,
    });

    // Step 2.
    await page.evaluate(() => localStorage.removeItem("hexokit-sidebar-width"));

    // Step 3.
    await page.reload();
    await expect(
      page.getByTestId("status-bar").locator("[aria-label='Connected']"),
    ).toBeVisible({ timeout: READY_TIMEOUT });

    // Step 4.
    const stored = await readStorage(page, [
      "hexokit-sidebar-width",
      "runkit-sidebar-width",
      STORAGE_MIGRATION_MARKER_KEY,
    ]);
    expect(stored).toEqual({
      "hexokit-sidebar-width": null,
      "runkit-sidebar-width": SIDEBAR_WIDTH_SEED,
      [STORAGE_MIGRATION_MARKER_KEY]: "1",
    });
    await expect
      .poll(() => sidebarWidthPx(page), { timeout: READY_TIMEOUT })
      .toBe(220);
  });
});
