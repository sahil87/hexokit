/**
 * node:test suite for the tunnel-proxy pure helpers (run via `pnpm run test`
 * after compile — the `web-views.test.ts` convention). The live-tunnel arms
 * (receive bound, handshake-failure 502, close with an active CONNECT) run
 * against the minimal RFC 6455 server below — Node ships no WebSocket
 * server, and end-to-end framing fidelity stays with the e2e fixture.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import test from "node:test";
import {
  createLocalProxy,
  deriveForwardRequest,
  formatAuthority,
  handleConnectTunnel,
  parseConnectAuthority,
  stripProxyHeaders,
  TUNNEL_RECV_HIGH_WATER_BYTES,
  TUNNEL_WS_CHUNK_BYTES,
  TunnelSocket,
  tunnelWsUrl,
} from "./tunnel-proxy";

// ── tunnelWsUrl ─────────────────────────────────────────────────────────────

test("tunnelWsUrl maps http→ws and carries the target URL-encoded", () => {
  assert.equal(
    tunnelWsUrl("http://100.101.2.3:3000", "example.internal:8080"),
    "ws://100.101.2.3:3000/ws/tunnel?target=example.internal%3A8080",
  );
});

test("tunnelWsUrl maps https→wss (a TLS front end passes the upgrade)", () => {
  assert.equal(
    tunnelWsUrl("https://dev.example.ts.net", "127.0.0.1:3000"),
    "wss://dev.example.ts.net/ws/tunnel?target=127.0.0.1%3A3000",
  );
});

test("tunnelWsUrl an SSH host's viewer-side tunnel origin stays loopback ws", () => {
  assert.equal(
    tunnelWsUrl("http://127.0.0.1:3100", "127.0.0.1:3000"),
    "ws://127.0.0.1:3100/ws/tunnel?target=127.0.0.1%3A3000",
  );
});

test("tunnelWsUrl a bracketed IPv6 target survives the encoding round-trip", () => {
  const url = tunnelWsUrl("http://127.0.0.1:3000", formatAuthority("::1", 8080));
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/ws/tunnel");
  assert.equal(parsed.searchParams.get("target"), "[::1]:8080");
});

test("tunnelWsUrl drops any origin path and rejects non-http(s) origins", () => {
  assert.equal(
    tunnelWsUrl("http://127.0.0.1:3000/some/base", "a:1"),
    "ws://127.0.0.1:3000/ws/tunnel?target=a%3A1",
  );
  assert.throws(() => tunnelWsUrl("ftp://host:21", "a:1"));
  assert.throws(() => tunnelWsUrl("not a url", "a:1"));
});

// ── parseConnectAuthority / formatAuthority ─────────────────────────────────

test("parseConnectAuthority accepts host:port, dotted quads, bracketed IPv6", () => {
  assert.deepEqual(parseConnectAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseConnectAuthority("127.0.0.1:8080"), { host: "127.0.0.1", port: 8080 });
  assert.deepEqual(parseConnectAuthority("[::1]:8080"), { host: "::1", port: 8080 });
  assert.deepEqual(parseConnectAuthority("[2001:db8::1]:443"), {
    host: "2001:db8::1",
    port: 443,
  });
  assert.deepEqual(parseConnectAuthority("example.com:1"), { host: "example.com", port: 1 });
  assert.deepEqual(parseConnectAuthority("example.com:65535"), {
    host: "example.com",
    port: 65535,
  });
});

test("parseConnectAuthority rejects malformed authorities", () => {
  for (const bad of [
    "example.com", // no port
    "example.com:", // empty port
    "example.com:abc", // non-numeric port
    "example.com:-1",
    "example.com:0", // port bounds
    "example.com:65536",
    ":8080", // empty host
    "[]:8080",
    "[::1]", // bracket without port
    "[::1x:80", // unterminated bracket
    "[::1]x:80", // garbage after bracket
    "::1:8080", // unbracketed IPv6 is not authority-form
    "example.com:80:90", // a second colon makes the host invalid
    "example.com: 80", // whitespace is not numeric
    "",
  ]) {
    assert.equal(parseConnectAuthority(bad), null, bad);
  }
});

test("formatAuthority brackets IPv6 and round-trips through the parser", () => {
  assert.equal(formatAuthority("example.com", 443), "example.com:443");
  assert.equal(formatAuthority("::1", 8080), "[::1]:8080");
  const target = parseConnectAuthority("[2001:db8::5]:9000");
  assert.ok(target !== null);
  assert.deepEqual(parseConnectAuthority(formatAuthority(target.host, target.port)), target);
});

// ── stripProxyHeaders ───────────────────────────────────────────────────────

test("stripProxyHeaders removes hop-by-hop and proxy-only headers", () => {
  const out = stripProxyHeaders({
    "proxy-connection": "keep-alive",
    "proxy-authorization": "Basic abc",
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    te: "trailers",
    trailer: "Expires",
    upgrade: "websocket",
    "content-type": "text/html",
    authorization: "Bearer token", // NOT proxy-authorization — end-to-end
    cookie: "session=1",
  });
  assert.deepEqual(out, {
    "content-type": "text/html",
    authorization: "Bearer token",
    cookie: "session=1",
  });
});

test("stripProxyHeaders removes every header the Connection token lists", () => {
  const out = stripProxyHeaders({
    connection: "X-Foo, keep-alive , X-Bar",
    "x-foo": "1",
    "x-bar": "2",
    "x-keep": "3",
  });
  assert.deepEqual(out, { "x-keep": "3" });
});

test("stripProxyHeaders preserves multi-value headers and matches case-insensitively", () => {
  const out = stripProxyHeaders({
    "set-cookie": ["a=1", "b=2"],
    Connection: "X-Gone",
    "X-Gone": "yes",
  });
  assert.deepEqual(out, { "set-cookie": ["a=1", "b=2"] });
});

// ── deriveForwardRequest ────────────────────────────────────────────────────

test("deriveForwardRequest rewrites absolute-form to the origin-form forward shape", () => {
  const out = deriveForwardRequest("http://example.com:8080/path?q=1", {
    host: "example.com:8080",
    "proxy-connection": "keep-alive",
    accept: "*/*",
  });
  assert.deepEqual(out, {
    host: "example.com",
    port: 8080,
    path: "/path?q=1",
    headers: { accept: "*/*", host: "example.com:8080" },
  });
});

test("deriveForwardRequest defaults the port and keeps the root path", () => {
  const out = deriveForwardRequest("http://example.com", {});
  assert.deepEqual(out, { host: "example.com", port: 80, path: "/", headers: { host: "example.com" } });
});

test("deriveForwardRequest brackets IPv6 in Host but forwards the bare literal", () => {
  const out = deriveForwardRequest("http://[::1]:8080/x", {});
  assert.deepEqual(out, {
    host: "::1",
    port: 8080,
    path: "/x",
    headers: { host: "[::1]:8080" },
  });
});

test("deriveForwardRequest sets Host from the absolute URL, not the request header", () => {
  const out = deriveForwardRequest("http://real.example:9000/", { host: "forged.example" });
  assert.ok(out !== null);
  assert.equal(out.headers["host"], "real.example:9000");
});

test("deriveForwardRequest rejects non-absolute-form, https, and garbage", () => {
  assert.equal(deriveForwardRequest("/x", {}), null); // origin-form → 400
  assert.equal(deriveForwardRequest("https://example.com/x", {}), null); // https rides CONNECT
  assert.equal(deriveForwardRequest("not a url", {}), null);
  assert.equal(deriveForwardRequest("", {}), null);
});

// ── createLocalProxy (no tunnel needed: origin validation + 400 arms) ──────

test("createLocalProxy rejects a non-http(s) host origin", async () => {
  await assert.rejects(() => createLocalProxy("ftp://host:21"));
});

test("createLocalProxy binds 127.0.0.1:0 and 400s origin-form requests", async () => {
  // The origin is only used to build tunnel URLs — nothing dials it here.
  const proxy = await createLocalProxy("http://127.0.0.1:1");
  try {
    assert.ok(proxy.port > 0);
    const code = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: "/origin-form",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? -1);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(code, 400);
  } finally {
    await proxy.close();
  }
});

test("createLocalProxy 400s a malformed CONNECT authority", async () => {
  const proxy = await createLocalProxy("http://127.0.0.1:1");
  try {
    // Raw socket: Node's http client fires `connect` for ANY CONNECT
    // response, so it cannot observe the refusal status.
    const head = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT no-port-here HTTP/1.1\r\nHost: no-port-here\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.ok(head.startsWith("HTTP/1.1 400"), head);
  } finally {
    await proxy.close();
  }
});

test("the write chunk size stays below the server's 1 MiB read limit", () => {
  assert.ok(TUNNEL_WS_CHUNK_BYTES <= 64 * 1024);
});

// ── Live-tunnel behavior (minimal RFC 6455 server) ─────────────────────────

/** One FIN frame, unmasked (server→client frames are never masked). */
function wsFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface TestWsServer {
  port: number;
  close(): Promise<void>;
}

/** Minimal WebSocket server: completes the upgrade, hands the raw socket to
 *  onConnection, discards incoming frames. Just enough protocol for undici's
 *  client to open and receive against. */
function startWsServer(onConnection: (socket: Duplex) => void): Promise<TestWsServer> {
  const sockets = new Set<Duplex>();
  const server = createHttpServer();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (key === undefined) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", () => {});
    socket.on("error", () => {});
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ws test server has no port"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

test("TunnelSocket destroys the tunnel when a stalled reader overruns the receive bound", async () => {
  const frameBytes = 64 * 1024;
  const frameCount = Math.ceil((TUNNEL_RECV_HIGH_WATER_BYTES * 2) / frameBytes);
  const wsServer = await startWsServer((socket) => {
    const frame = wsFrame(0x2, Buffer.alloc(frameBytes, 0x61));
    let sent = 0;
    const pump = (): void => {
      while (sent < frameCount) {
        sent += 1;
        if (!socket.write(frame)) {
          socket.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
  try {
    const tunnel = new TunnelSocket(`ws://127.0.0.1:${wsServer.port}/ws/tunnel`);
    // No reader ever attaches: the receive side must bound itself.
    const error = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("tunnel survived a receive flood no one consumed")),
        10_000,
      );
      tunnel.once("error", (err: Error) => {
        clearTimeout(timer);
        resolve(err);
      });
    });
    assert.match(error.message, /receive buffer/);
  } finally {
    await wsServer.close();
  }
});

test("TunnelSocket drains a backpressured receive queue in order once read", async () => {
  const frameBytes = 64 * 1024;
  // Past the readable's 16 KiB high-water mark (backpressure engages), under
  // the receive bound (the tunnel survives).
  const frameCount = 8;
  const wsServer = await startWsServer((socket) => {
    for (let i = 0; i < frameCount; i++) {
      socket.write(wsFrame(0x2, Buffer.alloc(frameBytes, i)));
    }
    socket.end(wsFrame(0x8, Buffer.alloc(0))); // close frame → tunnel EOF
  });
  try {
    const tunnel = new TunnelSocket(`ws://127.0.0.1:${wsServer.port}/ws/tunnel`);
    await tunnel.waitOpen();
    // Frames pile up unread so push() backpressure and the EOF-behind-queue
    // path both engage before any read.
    await new Promise((resolve) => setTimeout(resolve, 100));
    let position = 0;
    tunnel.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        assert.equal(byte, Math.floor(position / frameBytes) & 0xff);
        position += 1;
      }
    });
    await once(tunnel, "end");
    assert.equal(position, frameBytes * frameCount);
  } finally {
    await wsServer.close();
  }
});

test("a refused tunnel upgrade answers the CONNECT with 502, not a reset", async () => {
  const refusals = createHttpServer();
  refusals.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    refusals.once("error", reject);
    refusals.listen(0, "127.0.0.1", () => resolve());
  });
  const refusalsAddress = refusals.address();
  assert.ok(refusalsAddress !== null && typeof refusalsAddress !== "string");
  const proxy = await createLocalProxy(`http://127.0.0.1:${refusalsAddress.port}`);
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT example.internal:443 HTTP/1.1\r\nHost: example.internal:443\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.ok(answer.startsWith("HTTP/1.1 502"), answer);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => refusals.close(() => resolve()));
  }
});

test("a pre-open tunnel failure cannot reset the client before the 502 lands", async () => {
  // Hostile ordering: the tunnel raises error/close BEFORE its waitOpen
  // promise rejects (undici emits the WebSocket error before close, and
  // stream event timing is no contract). The client socket must survive to
  // carry the 502.
  const socket = new PassThrough();
  let rejectOpen!: (error: Error) => void;
  const openPromise = new Promise<void>((_resolve, reject) => {
    rejectOpen = reject;
  });
  openPromise.catch(() => {});
  const tunnel = Object.assign(new PassThrough(), { waitOpen: () => openPromise });
  handleConnectTunnel(socket, tunnel, Buffer.alloc(0));
  tunnel.emit("error", new Error("tunnel WebSocket error"));
  tunnel.emit("close");
  assert.ok(!socket.destroyed, "pre-open tunnel failure destroyed the client socket");
  rejectOpen(new Error("tunnel WebSocket handshake failed"));
  let data = "";
  socket.on("data", (chunk: Buffer) => {
    data += chunk.toString("utf8");
  });
  await once(socket, "close");
  assert.equal(data, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
});

test("close() resolves while a CONNECT tunnel is active", async () => {
  const wsServer = await startWsServer(() => {}); // upgrade accepted, held open
  try {
    const proxy = await createLocalProxy(`http://127.0.0.1:${wsServer.port}`);
    const client = netConnect(proxy.port, "127.0.0.1", () => {
      client.write("CONNECT 127.0.0.1:3000 HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n");
    });
    client.on("error", () => {});
    const [head] = await once(client, "data");
    assert.ok(String(head).startsWith("HTTP/1.1 200"), String(head));
    const closed = await Promise.race([
      proxy.close().then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        timer.unref();
      }),
    ]);
    assert.ok(closed, "close() hung with an active CONNECT tunnel");
    client.destroy();
  } finally {
    await wsServer.close();
  }
});
