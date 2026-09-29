/**
 * Desktop `<-loopback>` verification e2e: proves whether Electron 43 honors
 * `proxyBypassRules: "<-loopback>"` on `session.setProxy` — a guest session
 * configured with a fixed proxy MUST route even `http://localhost:<port>/`
 * loads through that proxy (Chromium's implicit loopback bypass removed).
 * That property is what the per-host `proxy` mode stands on: a remote host's
 * guest session resolves loopback on the rk host only if localhost traffic
 * is NOT bypassed.
 *
 * Shared setup: `beforeAll` starts two spec-owned `node:http` servers — a
 * RECORDING PROXY that answers every request with a trivial page and records
 * each request target (a proxied plain-http load arrives in absolute form,
 * `GET http://localhost:<port>/`), and a loopback stub serving
 * `http://127.0.0.1:<stubPort>/`; `afterAll` closes both. `beforeEach`
 * launches a FRESH shell per test on a fresh `mkdtemp` XDG_CONFIG_HOME (no
 * hosts.json — the welcome window suffices; the guest WebContentsView is
 * created main-side through `electronApp.evaluate`, the same no-test-seam
 * posture as web-native.spec.ts); `afterEach` closes the app and removes the
 * temp dir even on failure. Each test's guest runs on its own fresh
 * partition (`persist:rk-web-proxytest*`) with `session.setProxy` applied
 * and awaited BEFORE `loadURL` — the ordering main.ts's ensureHostProxy
 * guarantees for real guests.
 */
import { test, expect, type ElectronApplication } from "@playwright/test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchShell } from "./_shell";

/** A `node:http` server that records every request target it sees. */
interface RecordingServer {
  server: http.Server;
  port: number;
  /** The raw `req.url` of every request received, in arrival order — an
   *  absolute-form target (`http://localhost:<port>/`) when reached AS a
   *  proxy, an origin-form path (`/`) when reached directly. */
  seen: string[];
}

function startRecordingServer(): Promise<RecordingServer> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><title>rk e2e proxy</title></head><body></body></html>`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("recording server bind returned no port"));
        return;
      }
      resolve({ server, port: addr.port, seen });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Create a guest on a fresh partition with the given setProxy config,
 *  attach it to the shell's window, and load the URL — all main-side. The
 *  load's outcome (resolved / threw) is returned so a test can assert the
 *  page actually arrived wherever it was routed. */
async function loadThroughSession(
  app: ElectronApplication,
  partition: string,
  config: { mode: string; proxyRules: string; proxyBypassRules?: string },
  url: string,
): Promise<boolean> {
  return app.evaluate(
    async ({ BrowserWindow, session, WebContentsView }, args) => {
      const ses = session.fromPartition(args.partition);
      await ses.setProxy(args.config);
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("no shell window");
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
      try {
        await view.webContents.loadURL(args.url);
        return true;
      } catch {
        return false;
      }
    },
    { partition, config, url },
  );
}

let proxy: RecordingServer;
let stub: RecordingServer;
let stubUrl: string;
let app: ElectronApplication;
let configHome: string;

test.beforeAll(async () => {
  proxy = await startRecordingServer();
  stub = await startRecordingServer();
  // The load target is the localhost NAME on the stub's port — loopback
  // bypass rules key on the hostname, which is what <-loopback> governs.
  stubUrl = `http://localhost:${stub.port}/`;
});

test.afterAll(async () => {
  await closeServer(proxy.server);
  await closeServer(stub.server);
});

test.beforeEach(async () => {
  // The servers span the whole file (beforeAll) — reset their records per
  // test so each test asserts only its own load's routing.
  proxy.seen.length = 0;
  stub.seen.length = 0;
  configHome = mkdtempSync(join(tmpdir(), "rk-desktop-e2e-"));
  app = await launchShell(configHome);
});

test.afterEach(async () => {
  try {
    await app.close();
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test.describe("guest session proxy bypass rules", () => {
  /**
   * Proves: with `proxyBypassRules: "<-loopback>"`, a guest session pointed
   * at a fixed proxy routes a `http://localhost:<port>/` load THROUGH that
   * proxy — the recording proxy observes the absolute-form request — instead
   * of Chromium's implicit loopback bypass sending it direct.
   * Steps:
   * 1. Launch the shell; in main, configure a fresh partition
   *    `{ mode: "fixed_servers", proxyRules: <recording proxy>,
   *    proxyBypassRules: "<-loopback>" }`, await the setProxy, create a
   *    guest WebContentsView on it, and load the stub's localhost URL.
   * 2. Assert the load succeeded (the proxy answered it).
   * 3. Assert the recording proxy saw exactly the absolute-form request for
   *    the stub URL, and the stub saw nothing.
   */
  test("a <-loopback> session proxies a localhost load through the fixed proxy", async () => {
    const loaded = await loadThroughSession(
      app,
      "persist:rk-web-proxytest",
      {
        mode: "fixed_servers",
        proxyRules: `http://127.0.0.1:${proxy.port}`,
        proxyBypassRules: "<-loopback>",
      },
      stubUrl,
    );
    expect(loaded, "the proxied load resolves (the proxy answered)").toBe(true);
    expect(proxy.seen, "the proxy observed the absolute-form request").toContain(stubUrl);
    expect(stub.seen, "the stub was NOT reached directly").toHaveLength(0);
  });

  /**
   * Proves (control): with DEFAULT bypass rules the same localhost load does
   * NOT touch the proxy — Chromium's implicit loopback bypass sends it
   * direct — so the first test's proxied observation is attributable to the
   * `<-loopback>` rule and not to fixed_servers alone.
   * Steps:
   * 1. Launch the shell; configure a fresh partition
   *    `{ mode: "fixed_servers", proxyRules: <recording proxy> }` with NO
   *    proxyBypassRules; load the stub's localhost URL.
   * 2. Assert the load succeeded and the STUB saw it (direct, origin-form).
   * 3. Assert the recording proxy saw nothing.
   */
  test("a default-bypass session loads localhost directly, never touching the proxy", async () => {
    const loaded = await loadThroughSession(
      app,
      "persist:rk-web-proxytest-control",
      { mode: "fixed_servers", proxyRules: `http://127.0.0.1:${proxy.port}` },
      stubUrl,
    );
    expect(loaded, "the direct load resolves (the stub answered)").toBe(true);
    expect(stub.seen, "the stub was reached directly").toContain("/");
    expect(proxy.seen, "the proxy was bypassed for loopback").toHaveLength(0);
  });
});
