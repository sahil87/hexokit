/**
 * Demo: a presented page in the native web tile on a remote host whose public
 * name the rk server cannot resolve, recorded for PR evidence.
 *
 * Runs only under `just demo web-tile-unresolvable-origin` (app/desktop's
 * playwright.demo.config.ts — testDir ./tests/demo), against the throwaway
 * e2e rig. The host `e2e-unres` is the `unresolvableHostRig` shape: a `.test`
 * name the shell resolves (Chromium resolver rule + the Node preload) but the
 * Go server does not, so the shell settles to `proxy` mode and the guest's
 * traffic is dialed from the rig host. Before the fix the tile shows a tunnel
 * failure; after it, the page renders from the daemon's loopback origin. Only
 * the display grab (ffmpeg x11grab, owned by the `_demo.ts` fixture) shows
 * the composited result.
 *
 * Shared setup: beforeAll creates one tmux session on the rig's isolated
 * server and a temp present root holding a visually distinct page; afterAll
 * removes both. `test.use` seeds the unresolvable host and the rig's launch
 * extras; the `_demo.ts` fixture supplies the config home, the shell, the
 * host page, and the recording. The outcome wait tolerates the failing
 * "before" shape so that pass records the error state before the closing
 * assertion fails it.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, beat, pace, READY_TIMEOUT } from "./_demo";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import { findPage, pageByOrigin, unresolvableHostRig, viewTree } from "../e2e/_shell";

const DEMO_SESSION = "demo-web-tile-unresolvable";

const PRESENT_HTML = `<!doctype html><html><head><title>rk demo present</title></head>
<body style="margin:0;background:#b45309;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font:700 42px/1.2 monospace;text-align:center">
<p id="marker">PRESENTED PAGE<br/>LOADED THROUGH THE TUNNEL</p></body></html>`;

const rig = unresolvableHostRig();
let presentRoot: string;

/** The shell bridge on a host page, narrowed to the host switch invoker. */
interface ShellBridge {
  servers: { switch: (id: string) => Promise<unknown> };
}

test.use({ extraHosts: [rig.host], launchExtras: rig.launch });

test.describe("web-tile-unresolvable-origin demo", () => {
  test.beforeAll(() => {
    createSession(DEMO_SESSION);
    presentRoot = mkdtempSync(join(tmpdir(), "rk-demo-present-"));
    writeFileSync(join(presentRoot, "report.html"), PRESENT_HTML);
  });

  test.afterAll(() => {
    killSession(DEMO_SESSION);
    rmSync(presentRoot, { recursive: true, force: true });
  });

  /**
   * Proves: a reviewer can watch an `rk present` tab open in the native tile
   * on a host reached through a public name only the viewer resolves — the
   * page renders instead of failing with a tunnel error.
   *
   * Steps:
   * 1. Seed a window whose slot is stamped with a content-keyed
   *    `/present/<server>/<roothash>/report.html` address (root declared on
   *    the slot) and `@rk_win_layout single:web`; `beat()` on the default
   *    host.
   * 2. Switch to `e2e-unres` through the shell bridge, wait for its host page
   *    at the `.test` origin, then navigate to the window route and wait for
   *    the `web-native-placeholder`.
   * 3. Wait (tolerantly) for a guest on a `127.0.0.1` `/present/` URL;
   *    `beat()` so the recording lingers on whichever state resulted.
   * 4. Assert the presented page's marker renders in the guest.
   */
  test("an rk-relative present tab renders on an unresolvable-origin host", async ({
    app,
    hostPage,
  }) => {
    const windowName = "present-demo";
    newWindow(DEMO_SESSION, windowName);
    const found = listWindows(DEMO_SESSION).find((w) => w.name === windowName);
    if (!found) throw new Error(`window "${windowName}" not found in ${DEMO_SESSION}`);
    const hash = createHash("sha256").update(presentRoot).digest("hex").slice(0, 12);
    stampWebTab(found.windowId, `/present/${TMUX_SERVER}/${hash}/report.html?v=1`);
    setWindowOption(found.windowId, "@rk_win_web_1_root", presentRoot);
    setWindowOption(found.windowId, "@rk_win_layout", "single:web");
    await beat(hostPage);

    await hostPage.evaluate((id) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.servers.switch(id);
    }, rig.host.id);
    const unresPage = await pageByOrigin(app, rig.host.url, READY_TIMEOUT);
    await pace(unresPage);
    await unresPage.goto(
      `${rig.host.url}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
    );
    await expect(unresPage.getByTestId("web-native-placeholder")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    const isGuest = (url: string) => url.startsWith("http://127.0.0.1:") && url.includes("/present/");
    await expect
      .poll(async () => (await viewTree(app)).some((n) => isGuest(n.url) && n.visible), {
        timeout: READY_TIMEOUT,
      })
      .toBe(true)
      .catch(() => undefined);
    await beat(unresPage, 3_000);

    const guestPage = await findPage(app, isGuest, 1_000);
    await expect(guestPage.locator("#marker")).toContainText("PRESENTED PAGE", {
      timeout: READY_TIMEOUT,
    });
    await beat(unresPage, 2_000);
  });
});
