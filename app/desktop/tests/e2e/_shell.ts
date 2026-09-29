/**
 * Desktop-lane fixture module: launches the Electron shell per test against
 * this worktree's derived e2e rig, with state isolation through
 * XDG_CONFIG_HOME and no test seam in the app.
 *
 * Constraints the code cannot show:
 *
 * - On Linux Electron derives `appData` from `XDG_CONFIG_HOME`, so
 *   `app.getPath("userData")` becomes `<configHome>/hexokit-desktop/` (the
 *   package name). Seeding a two-host `hosts.json` there gives a real host
 *   switch against ONE rig (two origins: `localhost` and `127.0.0.1` on the
 *   same port) and keeps the developer's real `~/.config/hexokit-desktop/`
 *   — and the single-instance lock a running shell holds on it — untouched.
 *   `RK_DESKTOP_URL` is never set: its sentinel host is single-host and
 *   cannot exercise a switch.
 * - `--no-sandbox` is required on userns-restricted runners (CI's
 *   ubuntu-latest, xvfb boxes); it is confined to this launcher and never
 *   reaches scripts/dev-desktop.sh or packaging.
 * - Registry claims (z-order, visibility, bounds) are read from Electron's
 *   own objects (`win.contentView.children`, `View.getVisible()`,
 *   `View.getBounds()`, `webContents.getURL()`) through
 *   `electronApp.evaluate` — `src/main.ts` exports nothing for tests; a hook
 *   would test the hook.
 * - Guest classification: the seeded e2e-a host IS the lane's local daemon
 *   (`rk url` under the harness env — `RK_PORT` set, `RK_HOST` unset —
 *   resolves `http://127.0.0.1:<E2E_PORT>`, e2e-a's origin), so its web mode
 *   is `direct` and its guests load the stub's LITERAL URL
 *   (`http://127.0.0.1:<stubPort>/`) straight from the guest session — no
 *   `/proxy/<port>/` hop. A guest is therefore identified by its literal
 *   loopback URL; host views are identified by origin (e2e-b stays
 *   `localhost`-named, so the two origins remain distinct).
 */
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessPort } from "../../../frontend/tests/e2e/_harness";

/** The rig's Vite port, set only by the harness (scripts/test-e2e.sh). Never
 *  reads the ambient RK_PORT: direnv exports it into every shell, so a bare
 *  `playwright test` resolves the policy's fail-closed sentinel instead (the
 *  frontend config's convention — see the frontend's _harness.ts). The
 *  desktop lane is single-rig (workers: 1, no per-worker rewrite), so a
 *  module-level capture here is safe. */
export const E2E_PORT = harnessPort();

/** The shell's appData directory name — package.json `name`. */
const APP_DATA_DIR = "hexokit-desktop";

const DESKTOP_DIR = join(__dirname, "..", "..");

/** The two host origins the seeded hosts.json registers — same rig, two
 *  origins, so `servers:switch` is a real host switch. e2e-a carries the
 *  127.0.0.1 form deliberately: `rk url` under the harness env (`RK_PORT`
 *  set, `RK_HOST` unset) prints `http://127.0.0.1:<E2E_PORT>`, so e2e-a is
 *  the host the shell's local-daemon detection (`localDaemonOrigin`)
 *  resolves as THIS machine's daemon — web mode `direct`, literal-URL
 *  guests. */
export function hostOrigins(): { a: string; b: string } {
  return {
    a: `http://127.0.0.1:${E2E_PORT}`,
    b: `http://localhost:${E2E_PORT}`,
  };
}

/** Seed `<configHome>/hexokit-desktop/hosts.json` with the two-host list
 *  (activeId e2e-a). With no windows.json beside it, the shell's cold start
 *  opens exactly one window on e2e-a. */
export function seedHosts(configHome: string): void {
  const origins = hostOrigins();
  const dir = join(configHome, APP_DATA_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hosts.json"),
    JSON.stringify({
      version: 1,
      activeId: "e2e-a",
      hosts: [
        { id: "e2e-a", name: "e2e A", url: origins.a },
        { id: "e2e-b", name: "e2e B", url: origins.b },
      ],
    }),
  );
}

/** Launch the compiled shell (package.json main = dist/main.js) with the
 *  per-test isolated config home. */
export function launchShell(configHome: string): Promise<ElectronApplication> {
  return _electron.launch({
    args: [".", "--no-sandbox"],
    cwd: DESKTOP_DIR,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
}

/** Find a surfaced Page by URL predicate: existing windows first, then wait
 *  for new window events until the deadline. Throws on exhaustion — the
 *  caller's assertion message names what was being awaited. */
export async function findPage(
  app: ElectronApplication,
  match: (url: string) => boolean,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of app.windows()) {
      if (match(page.url())) return page;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`no Playwright page matched within ${timeoutMs}ms`);
    }
    await app.waitForEvent("window", { timeout: remaining }).catch(() => null);
  }
}

/** The host view's Page by origin (e2e-a `localhost`, e2e-b `127.0.0.1`). */
export function pageByOrigin(
  app: ElectronApplication,
  origin: string,
  timeoutMs: number,
): Promise<Page> {
  return findPage(app, (url) => url.startsWith(`${origin}/`), timeoutMs);
}

/** One contentView child, read through Electron's own objects. `id`/`url`
 *  are null/"" for a child with no webContents (a plain View). */
export interface ViewNode {
  id: number | null;
  url: string;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

/** The first window's contentView children, bottom → top (array index IS
 *  z-order). */
export function viewTree(app: ElectronApplication): Promise<ViewNode[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return [];
    return win.contentView.children.map((view) => {
      const wc = "webContents" in view ? (view as Electron.WebContentsView).webContents : null;
      return {
        id: wc ? wc.id : null,
        url: wc ? wc.getURL() : "",
        visible: view.getVisible(),
        bounds: view.getBounds(),
      };
    });
  });
}

/** The lane's guest content: a `node:http` stub on an ephemeral loopback
 *  port serving a titled page. A real listener is required — guest requests
 *  originate in the shell's per-host `persist:rk-web:<hostId>` partition,
 *  never the host page, so a `page.route` stub cannot serve them. */
export interface GuestStub {
  server: http.Server;
  port: number;
  /** Absolute stamped form: `http://127.0.0.1:<port>/`. */
  origin: string;
  /** The LITERAL URL a `direct`-mode guest loads: the stamped absolute
   *  loopback slot passes `toNativeSrc` through unchanged (no `/proxy/<port>/`
   *  hop), so the guest URL is the stub origin verbatim. */
  literalUrl: string;
}

export const GUEST_TITLE = "rk e2e guest";

export function startGuestStub(): Promise<GuestStub> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><title>${GUEST_TITLE}</title></head><body><p>guest</p></body></html>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("guest stub bind returned no port"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
        literalUrl: `http://127.0.0.1:${addr.port}/`,
      });
    });
  });
}
