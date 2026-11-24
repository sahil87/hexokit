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
 * native menu accelerators, so it would prove nothing here. The chord is
 * injected into the INHERITED `DISPLAY` (the lane runs under a private xvfb
 * when DISPLAY is unset). Where the window went is read from the ATTACHED
 * view (`attachedOrigin`, the topmost visible view's origin): warm host views
 * outlive a switch and each strip marks only its own host current, so a
 * page's `aria-current` square is constant and cannot detect a missed step.
 * No state outside the temp config home is written.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedOrigin, E2E_PORT, hostOrigins, launchShell, pageByOrigin, pressXChord, seedHosts } from "./_shell";

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
 * Proves: Alt+PageDown steps the window to the next host and wraps from the
 * last host to the first; Alt+PageUp steps back and wraps from the first to
 * the last — the window's ATTACHED host follows each press.
 *
 * Steps:
 * 1. Wait for the first host (e2e A) page and its three squares; assert the
 *    attached host is e2e A.
 * 2. Press Alt+PageDown; assert the attached host becomes e2e B.
 * 3. Press Alt+PageDown; assert it becomes e2e C.
 * 4. Press Alt+PageDown again (wrap); assert it returns to e2e A.
 * 5. Press Alt+PageUp (wrap back); assert it becomes e2e C.
 */
test("Alt+PageDown / Alt+PageUp cycle the hosts and wrap at both ends", async () => {
  const origins = hostOrigins();
  const cOrigin = `http://c.localhost:${E2E_PORT}`;
  // Host views stay warm across switches and each strip marks only its OWN
  // host current, so a page's squares cannot say where the window went — the
  // attached (visible) view does.
  const attached = () => attachedOrigin(app);

  await pageFor(origins.a);
  await expect.poll(attached).toBe(origins.a);

  pressXChord("Next", "Alt_L");
  await expect.poll(attached).toBe(origins.b);

  pressXChord("Next", "Alt_L");
  await expect.poll(attached).toBe(cOrigin);

  pressXChord("Next", "Alt_L");
  await expect.poll(attached).toBe(origins.a);

  pressXChord("Prior", "Alt_L");
  await expect.poll(attached).toBe(cOrigin);
});
