/**
 * Desktop host-cycling e2e: the native Hosts-menu accelerators (Alt+PageDown /
 * Alt+PageUp on this Linux rig; ⌥⌘→/← on macOS) step the focused window
 * through the host list and wrap at both ends.
 *
 * Shared setup: `beforeEach` launches a FRESH shell per test over a fresh
 * `mkdtemp` XDG_CONFIG_HOME seeded with THREE hosts — e2e-a `127.0.0.1`,
 * e2e-b `localhost`, e2e-c `c.localhost` (Chromium resolves `*.localhost` to
 * loopback, so all three serve the rig's one Vite port) — so a wrap is
 * distinguishable from a two-host toggle; `afterEach` closes the app and
 * removes the temp dir. The chord is injected as a REAL X key event
 * (`pressXChord`, XTest through libXtst): a Playwright `keyboard.press` is
 * dispatched over CDP straight into the renderer and never reaches Electron's
 * native menu accelerators, so it would prove nothing here. The current host
 * is read from the strip's `aria-current` square. No state outside the temp
 * config home is written.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_PORT, hostOrigins, launchShell, pageByOrigin, pressXChord, seedHosts } from "./_shell";

/** Readiness gate budget (the frontend convention) — mirrored, see strip-no-shift.spec.ts. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

let app: ElectronApplication;
let configHome: string;

/** The host page currently showing in the (single) window, by origin. */
async function pageFor(origin: string): Promise<Page> {
  const page = await pageByOrigin(app, origin, READY_TIMEOUT);
  await page.waitForLoadState("load");
  await expect(page.getByTestId("shell-host-square")).toHaveCount(3, { timeout: READY_TIMEOUT });
  return page;
}

test.beforeEach(async () => {
  configHome = mkdtempSync(join(tmpdir(), "rk-desktop-cycle-"));
  seedHosts(configHome, [
    { id: "e2e-c", name: "e2e C", url: `http://c.localhost:${E2E_PORT}` },
  ]);
  app = await launchShell(configHome);
});

test.afterEach(async () => {
  await app.close();
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Proves: the Hosts menu carries Previous Host / Next Host with the
 * per-platform accelerators when three hosts are registered.
 *
 * Steps:
 * 1. Wait for the first host page and its three squares.
 * 2. Read the application menu's Hosts submenu from the main process.
 * 3. Assert Previous Host and Next Host exist with the Linux accelerators
 *    Alt+PageUp and Alt+PageDown.
 */
test("the Hosts menu lists Previous/Next Host with Alt+PageUp / Alt+PageDown", async () => {
  await pageFor(hostOrigins().a);
  const items = await app.evaluate(({ Menu }) => {
    const hosts = Menu.getApplicationMenu()?.items.find((i) => i.label === "Hosts");
    return (hosts?.submenu?.items ?? [])
      .filter((i) => i.label === "Previous Host" || i.label === "Next Host")
      .map((i) => ({ label: i.label, accelerator: String(i.accelerator) }));
  });
  expect(items).toEqual([
    { label: "Previous Host", accelerator: "Alt+PageUp" },
    { label: "Next Host", accelerator: "Alt+PageDown" },
  ]);
});

/**
 * Proves: Alt+PageDown steps to the next host and wraps from the last host to
 * the first; Alt+PageUp steps back and wraps from the first to the last — the
 * window's current square follows each press.
 *
 * Steps:
 * 1. Wait for the first host (e2e A) page; assert square 1 is current.
 * 2. Press Alt+PageDown; wait for the second host page; assert square 2 is current.
 * 3. Press Alt+PageDown; wait for the third host page; assert square 3 is current.
 * 4. Press Alt+PageDown again (wrap); wait for the first host page; assert square 1.
 * 5. Press Alt+PageUp (wrap back); wait for the third host page; assert square 3.
 */
test("Alt+PageDown / Alt+PageUp cycle the hosts and wrap at both ends", async () => {
  const origins = hostOrigins();
  const cOrigin = `http://c.localhost:${E2E_PORT}`;
  const currentIndex = async (page: Page) =>
    page
      .getByTestId("shell-host-square")
      .evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-current") === "true"));

  let page = await pageFor(origins.a);
  expect(await currentIndex(page)).toBe(0);

  pressXChord("Next", "Alt_L");
  page = await pageFor(origins.b);
  expect(await currentIndex(page)).toBe(1);

  pressXChord("Next", "Alt_L");
  page = await pageFor(cOrigin);
  expect(await currentIndex(page)).toBe(2);

  pressXChord("Next", "Alt_L");
  page = await pageFor(origins.a);
  expect(await currentIndex(page)).toBe(0);

  pressXChord("Prior", "Alt_L");
  page = await pageFor(cOrigin);
  expect(await currentIndex(page)).toBe(2);
});
