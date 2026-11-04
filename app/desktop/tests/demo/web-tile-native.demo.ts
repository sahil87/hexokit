/**
 * Demo: a native web tile composited over the SPA in the desktop shell,
 * recorded for PR evidence.
 *
 * Runs only under `just demo web-tile-native` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway
 * e2e rig. The scene is the one per-page video cannot capture: the guest is
 * a separate WebContentsView drawn over the host SPA, so only the display
 * grab (ffmpeg x11grab, owned by the `_demo.ts` fixture) shows what a user
 * sees. `beat()` pauses let a reviewer register each state; `pace()` dwells
 * after actions stand in for the web lane's slowMo (Electron launch has
 * none).
 *
 * Shared setup: beforeAll creates one tmux session on the rig's isolated
 * server via the e2e `_tmux.ts` helpers and starts a spec-owned guest stub
 * serving a visually distinct page (full-bleed colour, large title — unlike
 * the e2e stub's plain `<p>guest</p>`, so the native layer is unmistakable in
 * the video); afterAll kills both (the rig's EXIT trap reaps the server
 * itself). The `_demo.ts` fixture supplies the seeded per-test config home,
 * the launched shell, the host page, and the recording; window ids resolve
 * tmux-side (`listWindows`) because this config declares no baseURL.
 */
import http from "node:http";
import { test, expect, beat, pace, openPalette, READY_TIMEOUT } from "./_demo";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import { hostOrigins, viewTree, type ViewNode } from "../e2e/_shell";
import type { ElectronApplication, Page } from "@playwright/test";

const DEMO_SESSION = "demo-web-tile-native";

/** The spec-owned guest content: full-bleed colour plus a large title, so the
 *  composited native layer reads unmistakably in the recording. Served from a
 *  real loopback listener — guest requests originate in the shell's per-host
 *  `persist:rk-web:<hostId>` partition, which a `page.route` stub cannot
 *  serve (see tests/e2e/_shell.ts). */
const GUEST_HTML = `<!doctype html><html><head><title>rk demo guest</title></head>
<body style="margin:0;background:#7c3aed;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font:700 42px/1.2 monospace;text-align:center">
NATIVE WEB TILE<br/>GUEST</body></html>`;

let guestPort: number;
let stub: http.Server | undefined;

/** The guest's literal loopback URL — e2e-a's web mode is `direct` under the
 *  harness env, so the native engine loads it unchanged (no proxy hop). */
function guestUrl(): string {
  return `http://127.0.0.1:${guestPort}/`;
}

/** The guest node in the window's view tree, identified by the stub's literal
 *  loopback URL. */
async function guestNode(app: ElectronApplication): Promise<ViewNode | null> {
  const tree = await viewTree(app);
  return tree.find((node) => node.url.startsWith(guestUrl())) ?? null;
}

/** Poll until the guest exists in the tree and satisfies `pred`. */
async function pollGuest(app: ElectronApplication, pred: (node: ViewNode) => boolean): Promise<void> {
  await expect
    .poll(
      async () => {
        const node = await guestNode(app);
        return node !== null && pred(node);
      },
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
}

/** Create a tmux window stamped with the guest stub as its active web tab and
 *  navigate the host page to it, waiting for the native placeholder. */
async function seedWindow(hostPage: Page, name: string): Promise<void> {
  newWindow(DEMO_SESSION, name);
  const found = listWindows(DEMO_SESSION).find((w) => w.name === name);
  if (!found) throw new Error(`window "${name}" not found in ${DEMO_SESSION}`);
  stampWebTab(found.windowId, guestUrl());
  setWindowOption(found.windowId, "@rk_win_layout", "single:web");
  await hostPage.goto(
    `${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
  );
  await expect(hostPage.getByTestId("web-native-placeholder")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/** The shell bridge on the host page, narrowed to the host switch invoker
 *  (the preload's exact argument shape). */
interface ShellBridge {
  servers: { switch: (id: string) => Promise<unknown> };
}

function switchHost(hostPage: Page, id: string): Promise<unknown> {
  return hostPage.evaluate((hostId) => {
    const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
    return shell.servers.switch(hostId);
  }, id);
}

test.describe("web-tile-native demo", () => {
  test.beforeAll(async () => {
    createSession(DEMO_SESSION);
    const server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(GUEST_HTML);
    });
    stub = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("guest stub bind returned no port");
    }
    guestPort = addr.port;
  });

  test.afterAll(async () => {
    killSession(DEMO_SESSION);
    // beforeAll may have thrown before the stub existed; a TypeError here
    // would mask that original failure.
    const server = stub;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Proves: a reviewer can watch the shell's native web tile end to end — the
   * coloured guest composited over the SPA, hiding when the command palette
   * (a modal overlay) opens and reappearing when it closes, and hiding/re-
   * raising across a host switch — exactly what per-page video cannot show.
   *
   * Steps:
   * 1. Seed a window with the stub URL stamped as its web tab and
   *    `@rk_win_layout single:web`; navigate the host page to the window
   *    route and wait for the `web-native-placeholder`.
   * 2. Poll the view tree until the guest is visible with non-zero bounds,
   *    then `beat()` — the recording lingers on the composited guest.
   * 3. Open the command palette (Shift+Control+K); poll the guest hidden
   *    (nothing the SPA draws can paint over a native layer); `beat()`.
   * 4. Press Escape; poll the guest visible again; `beat()`.
   * 5. Switch host to e2e-b and back through the shell bridge; poll the
   *    guest hidden then re-shown, with a `beat()` at each stop.
   */
  test("a native web tile over the SPA, hidden by the palette, kept across a host switch", async ({
    app,
    hostPage,
  }) => {
    await seedWindow(hostPage, `web-tile-${Date.now()}`);

    await pollGuest(app, (n) => n.visible && n.bounds.width > 0);
    await beat(hostPage);

    const input = await openPalette(hostPage);
    await expect(input).toBeVisible();
    await pace(hostPage);
    await pollGuest(app, (n) => !n.visible);
    await beat(hostPage);

    await hostPage.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: READY_TIMEOUT });
    await pace(hostPage);
    await pollGuest(app, (n) => n.visible);
    await beat(hostPage);

    await switchHost(hostPage, "e2e-b");
    await pollGuest(app, (n) => !n.visible);
    await beat(hostPage);

    await switchHost(hostPage, "e2e-a");
    await pollGuest(app, (n) => n.visible);
    await beat(hostPage);
  });
});
