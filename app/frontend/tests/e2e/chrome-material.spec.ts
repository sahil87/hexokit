import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// Chrome material e2e. Fully mocked (no tmux/gh) — the status-bar.spec.ts
// idiom: the state socket (mockStateSocket from _state-socket-mock.ts)
// delivers one session (`dev`) with one window (`@1`), `/ws/terminals` is
// stubbed (xterm still mounts locally — the socket only feeds I/O), and
// `/api/servers` + `/api/health` + `/api/settings` are fulfilled inline. The
// settings stub pins the `theme` entry per test case so the resolved theme is
// deterministic regardless of the dev machine's own persisted preference; the
// same id is seeded into localStorage by addInitScript so the pre-paint
// script agrees. Every test runs at 1440×900 (desktop chrome: sidebar aside,
// top bar, status bar all present) on the terminal route `/<server>/1`, and
// attaches a full-page screenshot (the reviewer's evidence for the
// light-theme wells, the sidebar bottom fade edge, and the gap seam).
//
// Subjects: the chrome material contract — sidebar aside, top-bar wash
// wrapper and status bar all paint `--color-bg-chrome`; the Shell stage ground
// is the chrome itself (the flush stage — the sidebar is a flat column of it
// and only the content tile floats), so it paints `--color-bg-chrome` too;
// the terminal itself keeps painting `palette.background` (probed through the
// dev-only `window.__rkTerminals` registry's theme option, because xterm.js
// paints its background onto the canvas and NEVER onto a DOM element —
// xterm.css hardcodes `.xterm-viewport` to #000, so no computed-style probe
// can see the terminal's color). The tile wrapper is additionally probed for
// a TRANSPARENT background: no DOM element may paint the tile (a stray
// bg-bg-chrome on it would pass the registry check yet show chrome through
// the xterm letterbox).

const SERVER = "default";

const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "work",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        panes: [
          { paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "bash", isActive: true, gitBranch: "main" },
        ],
      },
    ],
  },
]);

async function mockBackend(page: Page, themeId: string) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/health*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hostname: "e2e-box", instanceName: null }),
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: [{ key: "theme", value: themeId }] }),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload });
}

type ChromeProbe = {
  vars: { primary: string; chrome: string; chromeRaised: string };
  asideBg: string;
  wrapperBg: string;
  statusBarBg: string;
  stageBg: string;
  tileBg: string;
  xtermThemeBackground: string | null;
};

/** Hex (#rrggbb) → the rgb() form getComputedStyle reports. */
function hexToRgbCss(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * Read the live surface colors. The xterm background comes from the dev-mode
 * terminal registry (the canvas is the paint; no DOM element carries it) —
 * null when the terminal never mounted.
 */
async function probeChrome(page: Page): Promise<ChromeProbe> {
  return page.evaluate(() => {
    const varHex = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const bgOf = (el: Element | null | undefined) =>
      el ? getComputedStyle(el as Element).backgroundColor : "(missing)";
    const aside = document.querySelector('aside[aria-label="Sidebar"]');
    const banner = document.querySelector("header");
    const wrapper = banner?.parentElement ?? null;
    const statusBar = document.querySelector('[data-testid="status-bar"]');
    const tile = document.querySelector('[data-testid="surface-tile-tty"]');
    const terms = window.__rkTerminals ?? {};
    const term = Object.values(terms)[0];
    return {
      vars: {
        primary: varHex("--color-bg-primary"),
        chrome: varHex("--color-bg-chrome"),
        chromeRaised: varHex("--color-bg-chrome-raised"),
      },
      asideBg: bgOf(aside),
      wrapperBg: bgOf(wrapper),
      statusBarBg: bgOf(statusBar),
      // The stage ground: the aside's parent grid (gridArea sidebar/content).
      stageBg: bgOf(aside?.parentElement),
      tileBg: bgOf(tile),
      xtermThemeBackground: term?.options.theme?.background ?? null,
    };
  });
}

/** Shared body for all three color-scheme cases: navigate, render, probe,
 *  assert the chrome contract, attach the full-page screenshot. */
async function expectChromeMaterial(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  themeId: string,
  shotName: string,
) {
  await page.addInitScript((id) => {
    try {
      localStorage.setItem("hexokit-theme", id);
    } catch {
      // localStorage unavailable — the settings stub is authoritative anyway
    }
  }, themeId);
  await page.goto(`/${SERVER}/1`);
  await expect(page.locator('aside[aria-label="Sidebar"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 15_000 });
  // The terminal mount is the last surface to appear; wait for it so the
  // registry probe and the screenshot both cover the real tile. The `.xterm`
  // element appears BEFORE the dev registry entry — registration runs in a
  // separate effect keyed on `terminalReady` — so poll the registry itself.
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => Object.keys(window.__rkTerminals ?? {}).length > 0);

  const probe = await probeChrome(page);
  const chromeRgb = hexToRgbCss(probe.vars.chrome);

  // aside = top bar = status bar = stage ground = chrome (flush stage). The
  // raised token is the row-hover step only and never paints a surface here.
  expect(probe.asideBg).toBe(chromeRgb);
  expect(probe.wrapperBg).toBe(chromeRgb);
  expect(probe.statusBarBg).toBe(chromeRgb);
  expect(probe.stageBg).toBe(chromeRgb);
  expect(hexToRgbCss(probe.vars.chromeRaised)).not.toBe(chromeRgb);

  // The chrome is NOT the terminal color, and the tile keeps the terminal on
  // palette.background: no DOM element paints the tile (transparent — a stray
  // chrome class would show through the xterm letterbox), and the canvas
  // paints the palette background (registry probe — see the file header).
  expect(chromeRgb).not.toBe(hexToRgbCss(probe.vars.primary));
  expect(probe.tileBg).toBe("rgba(0, 0, 0, 0)");
  expect(probe.xtermThemeBackground).not.toBeNull();
  expect(probe.xtermThemeBackground?.toLowerCase()).toBe(probe.vars.primary.toLowerCase());

  await testInfo.attach(shotName, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

test.describe("Chrome material surfaces", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  /**
   * Proves: on a dark theme the sidebar aside, the top-bar wrapper and the
   * status bar all paint the derived `--color-bg-chrome`, the stage ground
   * under the flat sidebar and around the content tile paints the same
   * chrome (flush stage), and the terminal keeps `palette.background` — the
   * chrome never bleeds into the content well.
   * Steps:
   * 1. Pin `default-dark` (settings stub + localStorage seed), emulate the
   *    dark color scheme, and navigate to the terminal route at 1440×900.
   * 2. Wait for the sidebar aside, the status bar and the `.xterm` mount, then
   *    poll for the dev registry entry (registration lags the element).
   * 3. Probe computed backgrounds of the aside, the banner's wrapper, the
   *    status bar, the stage and the tile, plus the terminal's theme
   *    background.
   * 4. Assert aside = wrapper = status bar = stage = chrome, chrome ≠
   *    primary, tile unpainted (transparent), xterm theme background =
   *    primary.
   * 5. Attach a full-page screenshot.
   */
  test("dark theme: chrome surfaces paint the derived gray, terminal keeps the palette background", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockBackend(page, "default-dark");
    await expectChromeMaterial(page, testInfo, "default-dark", "chrome-material-dark.png");
  });

  /**
   * Proves: the same chrome contract on a light theme — the chrome steps DOWN
   * from the background (instead of up) and the surfaces still read as one
   * material distinct from the terminal tile.
   * Steps:
   * 1. Pin `default-light`, emulate the light color scheme, navigate at
   *    1440×900.
   * 2. Wait for sidebar, status bar and `.xterm`.
   * 3. Probe the same surfaces.
   * 4. Assert the same equalities and the chrome ≠ primary separation.
   * 5. Attach a full-page screenshot (the light-theme wells / fade-edge
   *    evidence for review).
   */
  test("light theme: chrome surfaces step down from the background, terminal keeps the palette background", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await mockBackend(page, "default-light");
    await expectChromeMaterial(page, testInfo, "default-light", "chrome-material-light.png");
  });

  /**
   * Proves: the contract holds on a warm-tinted light theme (solarized-light)
   * — the chrome keeps 35% of the background's chroma, so the gray leans the
   * palette's way instead of pasting on a neutral slab, and the terminal
   * still keeps its own tinted background.
   * Steps:
   * 1. Pin `solarized-light` through the persisted theme preference
   *    (settings stub + the `hexokit-theme` localStorage key), emulate the
   *    light color scheme, navigate at 1440×900.
   * 2. Wait for sidebar, status bar and `.xterm`.
   * 3. Probe the same surfaces.
   * 4. Assert the same equalities and the chrome ≠ primary separation.
   * 5. Attach a full-page screenshot (warm-light wells evidence for review).
   */
  test("warm light theme (solarized-light): tinted chrome over a tinted terminal", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "light" });
    await mockBackend(page, "solarized-light");
    await expectChromeMaterial(page, testInfo, "solarized-light", "chrome-material-solarized-light.png");
  });
});
