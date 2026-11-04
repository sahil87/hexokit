/**
 * Desktop native-engine e2e: a REMOTE-mode web tile behind an origin-form
 * reverse proxy (the Tailscale Serve shape) — the front end passes WebSocket
 * upgrades but refuses the HTTP forward-proxy request shapes, so the only
 * guest transport that can cross it is the WebSocket tunnel (the main
 * process's per-host loopback proxy → `/ws/tunnel` → dialed on the rig host).
 *
 * Shared setup: `beforeAll` creates the rig tmux session and starts three
 * spec-owned loopback servers; `afterAll` closes them and kills the session.
 *
 *  1. The REVERSE PROXY (`http.createServer` on `<LAN IPv4>:0` — the box's
 *     first non-internal IPv4 address, see below), the front end
 *     under test: (a) origin-form requests are forwarded to the rig's serving
 *     origin (`127.0.0.1:<E2E_PORT>` — what the seeded hosts point at) and
 *     the response relayed verbatim; (b) `upgrade` events dial the rig origin
 *     and pipe raw bytes both ways, forwarding the client's head — WebSocket
 *     upgrades pass untouched; (c) `connect` events (CONNECT authority-form)
 *     get a 404 and the socket closes; (d) absolute-form request targets
 *     (`req.url` starting `http://`/`https://`) get a 404. It also records
 *     every upgrade path it passes, so a test can prove the tunnel crossed
 *     THIS front end rather than reaching the rig some other way.
 *  2. Stub A serves an HTML page with a marker string and a script that
 *     fetches `http://localhost:<stubB>/data` and writes the payload into the
 *     DOM (`#fetch-result`).
 *  3. Stub B answers with `Access-Control-Allow-Origin: *` so the guest
 *     page's cross-port fetch is permitted.
 *
 * Both stubs listen on the same box as the rig — exactly what the tunnel must
 * reach: from the shell's perspective `localhost:<stubPort>` is resolvable
 * ONLY through the host's rk server.
 *
 * The shell lifecycle lives in the nested describe (the fixture-honesty test
 * pays no Electron launch): a fresh `mkdtemp` XDG_CONFIG_HOME per test,
 * seeded with a THREE-host hosts.json — `_shell.ts`'s two-host shape plus
 * `e2e-tun`, whose url is the reverse proxy's origin and which carries NO
 * `remote` field, so the SSH heal/interstitial flow never engages; `afterEach`
 * closes the app and removes the temp dir even on mid-test failure. Why
 * e2e-tun still derives the probe-gated remote path: its origin is a
 * NON-loopback address (the LAN IPv4), so the local-host arms never match
 * whether or not `rk url` answers — it does not on CI, where no `rk` is on
 * PATH and a loopback origin would fall back to `direct`. The spec is skipped
 * on a box with no non-internal IPv4. The capability probe (the health
 * `tunnel` field, then a `/ws/tunnel` round-trip) succeeds THROUGH the
 * reverse proxy, settling the host to `proxy`. Window ids resolve tmux-side
 * (`listWindows`), not through the backend snapshot — the desktop Playwright
 * config declares no baseURL, so `_ready.ts`'s request-relative resolver
 * cannot run here (and `_ready.ts` must never be imported: it would load a
 * second physical Playwright copy into this process).
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
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
  E2E_PORT,
  hostOrigins,
  launchShell,
  pageByOrigin,
  findPage,
  viewTree,
} from "./_shell";

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

const TEST_SESSION = `e2e-desktop-tunnel-${Date.now()}`;

/** Stub A's marker string and stub B's fetch payload — the rig-side proof. */
const STUB_A_MARKER = "tunnel rig-side stub A";
const STUB_B_PAYLOAD = "tunnel rig-side stub B data";

/** The box's first non-internal IPv4 address — the reverse proxy's bind
 *  host, so e2e-tun's origin is non-loopback (remote by construction). */
function lanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

const LAN_HOST = lanIPv4();

/** The shell's appData directory name — package.json `name` (the _shell.ts
 *  seeding mechanism). */
const APP_DATA_DIR = "hexokit-desktop";

interface ReverseProxy {
  server: http.Server;
  port: number;
  origin: string;
  /** The `req.url` of every `upgrade` event passed through, in arrival
   *  order — a `/ws/tunnel` entry proves the guest's tunnel crossed this
   *  front end. */
  upgrades: string[];
}

/** The origin-form reverse proxy: forward origin-form requests to the rig,
 *  pipe WebSocket upgrades through raw, 404 CONNECT and absolute-form. */
function startReverseProxy(bindHost: string): Promise<ReverseProxy> {
  const upgrades: string[] = [];
  const server = http.createServer((req, res) => {
    const target = req.url ?? "";
    if (target.startsWith("http://") || target.startsWith("https://")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: E2E_PORT,
        method: req.method,
        path: target,
        headers: req.headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push(req.url ?? "");
    const up = net.connect(E2E_PORT, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      up.write("\r\n");
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  server.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    socket.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("reverse proxy bind returned no port"));
        return;
      }
      resolve({ server, port: addr.port, origin: `http://${bindHost}:${addr.port}`, upgrades });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Stub A: the marker page whose script fetches stub B cross-port and writes
 *  the payload into `#fetch-result` ("pending" until then, "fetch-failed" on
 *  rejection — both distinguishable from success). */
function startStubA(portB: number): Promise<{ server: http.Server; port: number; url: string }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><title>rk e2e tunnel guest</title></head><body>` +
        `<p id="marker">${STUB_A_MARKER}</p><div id="fetch-result">pending</div>` +
        `<script>fetch("http://localhost:${portB}/data")` +
        `.then(function(r){return r.text();})` +
        `.then(function(t){document.getElementById("fetch-result").textContent=t;})` +
        `.catch(function(){document.getElementById("fetch-result").textContent="fetch-failed";});` +
        `</script></body></html>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("stub A bind returned no port"));
        return;
      }
      resolve({ server, port: addr.port, url: `http://localhost:${addr.port}/` });
    });
  });
}

/** Stub B: the cross-port fetch target, CORS-open so the guest page (a
 *  different loopback origin) may read the response. */
function startStubB(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/plain");
    res.end(STUB_B_PAYLOAD);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("stub B bind returned no port"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

/** The three-host seed: `_shell.ts`'s two-host shape (e2e-a active, the rig's
 *  local daemon; e2e-b its second origin) plus `e2e-tun` behind the reverse
 *  proxy — deliberately no `remote` field, so no SSH heal/interstitial. */
function seedHostsWithTunnel(configHome: string, tunnelOrigin: string): void {
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
        { id: "e2e-tun", name: "e2e Tun", url: tunnelOrigin },
      ],
    }),
  );
}

/** One raw `CONNECT` attempt against the reverse proxy, resolved with the
 *  response bytes read before the first CRLF (the status line). */
function rawConnectStatusLine(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const socket = net.connect(port, host, () => {
      socket.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n");
    });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("CONNECT probe timed out"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const eol = data.indexOf("\r\n");
      if (eol !== -1) {
        socket.destroy();
        resolve(data.slice(0, eol));
      }
    });
    socket.on("error", reject);
  });
}

/** One absolute-form request against the reverse proxy — Node writes the
 *  `path` verbatim as the request target, so an absolute URL arrives in
 *  exactly the shape a forward proxy would see. */
function absoluteFormStatus(host: string, port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method: "GET", path: "http://127.0.0.1:9/absolute-form" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The shell bridge on a host page, narrowed to the invokers this spec uses
 *  (the preload's exact argument shapes). */
interface ShellBridge {
  servers: { switch: (id: string) => Promise<unknown> };
  web: { mode: () => Promise<unknown> };
}

let reverseProxy: ReverseProxy;
let stubA: { server: http.Server; port: number; url: string };
let stubB: { server: http.Server; port: number };

test.skip(LAN_HOST === undefined, "no non-internal IPv4 address to bind the reverse proxy on");

test.beforeAll(async () => {
  if (LAN_HOST === undefined) return;
  createSession(TEST_SESSION);
  reverseProxy = await startReverseProxy(LAN_HOST);
  // B first: A's page embeds B's port in the fetch URL.
  stubB = await startStubB();
  stubA = await startStubA(stubB.port);
});

test.afterAll(async () => {
  if (LAN_HOST === undefined) return;
  killSession(TEST_SESSION);
  await closeServer(reverseProxy.server);
  await closeServer(stubA.server);
  await closeServer(stubB.server);
});

/**
 * Proves: the fixture front end is honest — it refuses exactly the two
 * non-origin-form request shapes (CONNECT authority-form and absolute-form
 * targets, both 404) while its forward arm reaches the rig, so the positive
 * tunnel test cannot be attributed to a front end that would have carried
 * those shapes.
 * Steps:
 * 1. Open a raw TCP socket to the reverse proxy and send
 *    `CONNECT example.invalid:443`; assert the status line is 404.
 * 2. Send an absolute-form `GET http://127.0.0.1:9/absolute-form`; assert 404.
 * 3. Send an origin-form `GET /api/health`; assert 200 with a numeric
 *    `tunnel` field — the forward arm and the rig's capability signal both
 *    work through the proxy.
 */
test("the reverse proxy refuses CONNECT and absolute-form but forwards origin-form", async () => {
  const connectLine = await rawConnectStatusLine(LAN_HOST ?? "", reverseProxy.port);
  expect(connectLine, "CONNECT gets a 404 status line").toBe("HTTP/1.1 404 Not Found");

  const absoluteStatus = await absoluteFormStatus(LAN_HOST ?? "", reverseProxy.port);
  expect(absoluteStatus, "an absolute-form request target gets 404").toBe(404);

  const health = await fetch(`${reverseProxy.origin}/api/health`);
  expect(health.status, "origin-form GET /api/health forwards to the rig").toBe(200);
  const body: unknown = await health.json();
  expect(
    typeof body === "object" && body !== null && "tunnel" in body && typeof body.tunnel === "number",
    "health carries the numeric tunnel capability field",
  ).toBe(true);
});

test.describe("web tile behind an origin-form reverse proxy", () => {
  let app: ElectronApplication;
  let configHome: string;
  let hostPage: Page;

  test.beforeEach(async () => {
    configHome = mkdtempSync(join(tmpdir(), "rk-desktop-e2e-"));
    seedHostsWithTunnel(configHome, reverseProxy.origin);
    app = await launchShell(configHome);
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
   * Proves: a web tab stamped with a rig-side loopback URL works end to end
   * on a host reachable only through an origin-form reverse proxy — the host
   * settles to `proxy` mode, the guest loads the LITERAL
   * `http://localhost:<stubA>/` URL (not a `/proxy/<port>/` hop), stub A's
   * page renders, and the page's own cross-port fetch to stub B resolves —
   * every hop riding a WebSocket tunnel THROUGH the 404ing front end.
   * Steps:
   * 1. From the e2e-a host page, switch to e2e-tun; wait for its host page at
   *    the reverse-proxy origin and read the `web:mode` bridge: `proxy`.
   * 2. Seed a tmux window stamped `http://localhost:<stubA>/` with the
   *    single:web layout; navigate the e2e-tun host page to the window route
   *    and wait for the native placeholder.
   * 3. Poll the view tree: exactly one guest, visible, whose URL is the
   *    literal stub A URL — in any non-proxy mode the guest URL would be the
   *    host origin's `/proxy/<port>/` form instead.
   * 4. On the guest's Playwright Page, assert stub A's marker renders (the
   *    literal-localhost load resolved rig-side through the tunnel) and
   *    `#fetch-result` becomes stub B's payload (the in-page cross-port fetch
   *    stayed inside the tunnel).
   * 5. Assert the reverse proxy recorded at least one `/ws/tunnel` upgrade —
   *    the guest's traffic crossed THIS front end as WebSocket upgrades.
   */
  test("a remote web tile loads literal loopback URLs through the tunnel", async () => {
    await hostPage.evaluate((id) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.servers.switch(id);
    }, "e2e-tun");
    const tunPage = await pageByOrigin(app, reverseProxy.origin, READY_TIMEOUT);
    await expect
      .poll(
        async () => {
          const result = await tunPage.evaluate(() => {
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

    const windowName = `wt-tunnel-${Date.now()}`;
    newWindow(TEST_SESSION, windowName);
    const found = listWindows(TEST_SESSION).find((w) => w.name === windowName);
    if (!found) throw new Error(`window "${windowName}" not found in ${TEST_SESSION}`);
    stampWebTab(found.windowId, stubA.url);
    setWindowOption(found.windowId, "@rk_win_layout", "single:web");
    await tunPage.goto(
      `${reverseProxy.origin}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
    );
    await expect(tunPage.getByTestId("web-native-placeholder")).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    await expect
      .poll(
        async () => {
          const tree = await viewTree(app);
          const guests = tree.filter((n) => n.url.length > 0 && n.url.startsWith("http://localhost:"));
          return guests.length === 1 && guests[0].visible && guests[0].url === stubA.url;
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);

    const guestPage = await findPage(app, (url) => url === stubA.url, READY_TIMEOUT);
    await expect(guestPage.locator("#marker")).toHaveText(STUB_A_MARKER, {
      timeout: READY_TIMEOUT,
    });
    await expect(guestPage.locator("#fetch-result")).toHaveText(STUB_B_PAYLOAD, {
      timeout: READY_TIMEOUT,
    });

    expect(
      reverseProxy.upgrades.some((path) => path.startsWith("/ws/tunnel")),
      "the guest's tunnel WebSocket crossed the reverse proxy",
    ).toBe(true);
  });
});
