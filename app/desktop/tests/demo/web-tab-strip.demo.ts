/**
 * Demo: the redesigned web tab strip on the desktop shell's NATIVE engine,
 * recorded for PR evidence.
 *
 * Runs only under `just demo web-tab-strip` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway
 * e2e rig. The native guest is a separate WebContentsView composited over the
 * host SPA, so only the display grab (ffmpeg x11grab, owned by the `_demo.ts`
 * fixture) shows what a user sees — including the ⋯ overflow menu's
 * `transient` occlusion hiding the guest while the menu is open, and the
 * Inspect page row the iframe engine never offers.
 *
 * Shared setup: beforeAll creates one tmux session on the rig's isolated
 * server and starts a spec-owned guest stub serving a visually distinct page
 * (full-bleed colour, large title); afterAll kills both. The `_demo.ts`
 * fixture supplies the seeded config home, the launched shell, the host page,
 * and the recording; `beat()`/`pace()` dwells pace the narrative.
 */
import http from "node:http";
import { test, expect, beat, pace, READY_TIMEOUT } from "./_demo";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTabs,
} from "../../../frontend/tests/e2e/_tmux";
import { hostOrigins, viewTree, type ViewNode } from "../e2e/_shell";
import type { ElectronApplication, Page } from "@playwright/test";

const DEMO_SESSION = "demo-web-tab-strip-shell";

const GUEST_HTML = `<!doctype html><html><head><title>rk demo guest</title></head>
<body style="margin:0;background:#0e7490;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font:700 42px/1.2 monospace;text-align:center">
NATIVE WEB TILE<br/>GUEST</body></html>`;

let guestPort: number;
let stub: http.Server | undefined;

function guestUrl(): string {
  return `http://127.0.0.1:${guestPort}/`;
}

async function guestNode(app: ElectronApplication): Promise<ViewNode | null> {
  const tree = await viewTree(app);
  return tree.find((node) => node.url.startsWith(guestUrl())) ?? null;
}

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

test.describe("web-tab-strip shell demo", () => {
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
   * Proves: a reviewer can watch the redesigned chrome over the native engine
   * — the folder tab and the amber `:<port> proxy` chip on the new URL row,
   * and the ⋯ menu hiding the composited guest while open (the accepted
   * transient-occlusion trade) with the native-only Inspect page row.
   *
   * Steps:
   * 1. Seed a window with the guest stub as its active web tab and
   *    `@rk_win_layout single:web`; navigate the host page; wait for the
   *    native placeholder; poll the guest visible.
   * 2. Assert the folder tab and the `web-kind-chip` read `:<port> proxy`;
   *    `beat()`.
   * 3. Open ⋯; poll the guest HIDDEN (transient occlusion); assert the Zoom
   *    stepper and the `Inspect page` row; step `Zoom in` twice with the menu
   *    open; `beat()`.
   * 4. Escape; poll the guest visible again; assert the `125%` zoom chip;
   *    click it to reset; `beat()`.
   */
  test("folder tab and kind chip on the native engine, ⋯ menu occluding the guest", async ({
    app,
    hostPage,
  }) => {
    const name = `strip-${Date.now()}`;
    newWindow(DEMO_SESSION, name);
    const found = listWindows(DEMO_SESSION).find((w) => w.name === name);
    if (!found) throw new Error(`window "${name}" not found in ${DEMO_SESSION}`);
    stampWebTabs(found.windowId, [guestUrl()], 1);
    setWindowOption(found.windowId, "@rk_win_layout", "single:web");
    await hostPage.goto(
      `${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
    );
    await expect(hostPage.getByTestId("web-native-placeholder")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await pollGuest(app, (n) => n.visible && n.bounds.width > 0);
    await beat(hostPage);

    // The folder tab and the amber proxy chip on the raised URL row.
    await expect(hostPage.getByTestId("web-tab")).toHaveCount(1);
    await expect(hostPage.getByTestId("web-kind-chip")).toHaveText(`:${guestPort} proxy`);
    await beat(hostPage);

    // The ⋯ menu hides the composited guest while open (transient occlusion).
    await hostPage.getByLabel("More actions").click();
    await expect(hostPage.getByTestId("web-overflow-menu")).toBeVisible();
    await pace(hostPage);
    await pollGuest(app, (n) => !n.visible);
    await expect(hostPage.getByTestId("web-zoom-control")).toBeVisible();
    await expect(
      hostPage.getByRole("menuitem", { name: "Inspect page" }),
    ).toBeVisible();
    await beat(hostPage);

    // Zoom steps with the menu open; Escape re-shows the guest; the chip resets.
    await hostPage.getByLabel("Zoom in", { exact: true }).click();
    await hostPage.getByLabel("Zoom in", { exact: true }).click();
    await expect(hostPage.getByLabel("Reset zoom", { exact: true })).toHaveText("125%");
    await pace(hostPage);
    await hostPage.keyboard.press("Escape");
    await pollGuest(app, (n) => n.visible);
    await expect(hostPage.getByTestId("web-zoom-chip")).toHaveText("125%");
    await beat(hostPage);
    await hostPage.getByTestId("web-zoom-chip").click();
    await expect(hostPage.getByTestId("web-zoom-chip")).toHaveCount(0);
    await beat(hostPage);
  });
});
