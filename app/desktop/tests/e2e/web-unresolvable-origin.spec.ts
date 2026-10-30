/**
 * Desktop native-engine e2e: an rk-relative web tab (an `rk present` file) on
 * a REMOTE-mode host whose public origin the shell resolves but the rk server
 * does not — the Tailscale Service / split-horizon front-end shape. In
 * `proxy` mode the guest's traffic is dialed from the rk host, so a relative
 * address must load against the daemon's own loopback origin, never the
 * viewer-side name.
 *
 * Shared setup: `beforeAll` creates the rig tmux session and a temp present
 * root holding one marker page; `afterAll` removes both. The shell lifecycle
 * is `beforeEach`/`afterEach`: a fresh `mkdtemp` XDG_CONFIG_HOME seeded with
 * `_shell.ts`'s two-host shape plus `e2e-unres` (`unresolvableHostRig`: a
 * `.test` name mapped to loopback in the shell's two resolvers only, serving
 * the rig's Vite port), the shell launched with that rig's extras; `afterEach`
 * closes the app and removes the temp dir even on mid-test failure. The host
 * carries no `remote` field and its origin is not the local daemon's, so the
 * shell derives `proxy` through the capability probe. Window ids resolve
 * tmux-side (`listWindows`), not through the backend snapshot — the desktop
 * Playwright config declares no baseURL, so `_ready.ts` (which would load a
 * second physical Playwright copy) is never imported.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import {
  findPage,
  hostOrigins,
  launchShell,
  pageByOrigin,
  seedHosts,
  unresolvableHostRig,
  viewTree,
} from "./_shell";

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

const TEST_SESSION = `e2e-desktop-unres-${Date.now()}`;

const PRESENT_MARKER = "unresolvable-origin present page";

/** The shell bridge on a host page, narrowed to the invokers this spec uses
 *  (the preload's exact argument shapes). */
interface ShellBridge {
  servers: { switch: (id: string) => Promise<unknown> };
  web: { mode: () => Promise<unknown> };
}

const rig = unresolvableHostRig();
let presentRoot: string;

test.beforeAll(() => {
  createSession(TEST_SESSION);
  presentRoot = mkdtempSync(join(tmpdir(), "rk-present-unres-"));
  writeFileSync(
    join(presentRoot, "report.html"),
    `<!doctype html><html><head><title>rk e2e present</title></head>` +
      `<body><p id="marker">${PRESENT_MARKER}</p></body></html>`,
  );
});

test.afterAll(() => {
  killSession(TEST_SESSION);
  rmSync(presentRoot, { recursive: true, force: true });
});

test.describe("web tile on a host whose public origin the rk server cannot resolve", () => {
  let app: ElectronApplication;
  let configHome: string;
  let hostPage: Page;

  test.beforeEach(async () => {
    configHome = mkdtempSync(join(tmpdir(), "rk-desktop-e2e-"));
    seedHosts(configHome, [rig.host]);
    app = await launchShell(configHome, rig.launch);
    hostPage = await pageByOrigin(app, hostOrigins().a, READY_TIMEOUT);
  });

  test.afterEach(async () => {
    try {
      await app.close();
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  /**
   * Proves: an `rk present` tab renders in the native tile on a remote host
   * whose public name only the viewer can resolve — the guest loads from the
   * daemon's loopback origin through the tunnel instead of failing with
   * "tunnel connection failed" dialing the unresolvable name from the rk
   * host, and the address bar still shows the pretty present form rather
   * than a raw loopback URL.
   * Steps:
   * 1. From the e2e-a host page, switch to `e2e-unres`; wait for its host page
   *    at the `.test` origin and read the `web:mode` bridge: `proxy`.
   * 2. Seed a tmux window stamped with a content-keyed `/present/<server>/
   *    <roothash>/report.html` address (root declared on the slot) and the
   *    single:web layout; navigate the host page to the window route and wait
   *    for the native placeholder.
   * 3. Poll the view tree: exactly one guest, visible, on a `127.0.0.1` URL
   *    carrying the `/present/` path — never on the `.test` host.
   * 4. On the guest's Playwright Page, assert the marker page renders.
   * 5. Assert the SPA's address bar shows `report.html` (the tracked
   *    location folded back to root-relative form).
   */
  test("a root-relative present tab loads from the daemon loopback origin", async () => {
    await hostPage.evaluate((id) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.servers.switch(id);
    }, rig.host.id);
    const unresPage = await pageByOrigin(app, rig.host.url, READY_TIMEOUT);
    await expect
      .poll(
        async () => {
          const result = await unresPage.evaluate(() => {
            const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
            return shell.web.mode();
          });
          return typeof result === "object" && result !== null && "mode" in result
            ? (result as { mode: unknown }).mode
            : null;
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe("proxy");

    const windowName = `wt-unres-${Date.now()}`;
    newWindow(TEST_SESSION, windowName);
    const found = listWindows(TEST_SESSION).find((w) => w.name === windowName);
    if (!found) throw new Error(`window "${windowName}" not found in ${TEST_SESSION}`);
    const hash = createHash("sha256").update(presentRoot).digest("hex").slice(0, 12);
    stampWebTab(found.windowId, `/present/${TMUX_SERVER}/${hash}/report.html?v=1`);
    setWindowOption(found.windowId, "@rk_win_web_1_root", presentRoot);
    setWindowOption(found.windowId, "@rk_win_layout", "single:web");
    await unresPage.goto(
      `${rig.host.url}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
    );
    await expect(unresPage.getByTestId("web-native-placeholder")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    const isGuest = (url: string) => url.startsWith("http://127.0.0.1:") && url.includes("/present/");
    await expect
      .poll(
        async () => {
          const tree = await viewTree(app);
          const guests = tree.filter((n) => isGuest(n.url));
          return guests.length === 1 && guests[0].visible;
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);

    const guestPage = await findPage(app, isGuest, READY_TIMEOUT);
    await expect(guestPage.locator("#marker")).toHaveText(PRESENT_MARKER, {
      timeout: READY_TIMEOUT,
    });
    await expect(unresPage.getByTestId("surface-tile-web").getByLabel("URL")).toHaveValue(
      /report\.html/,
      { timeout: READY_TIMEOUT },
    );
  });
});
