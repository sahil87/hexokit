/**
 * Web-tile tunnel proxy — a loopback HTTP proxy in the main process that
 * terminates Chromium's proxy protocol on the viewer's own machine and
 * carries each proxied connection over a WebSocket tunnel to the host's rk
 * server (`GET /ws/tunnel?target=host:port`, one WebSocket per connection).
 * Because the tunnel is an ordinary WebSocket upgrade, it traverses any
 * front end rk already works behind (origin-form reverse proxies drop
 * CONNECT/absolute-form, never `/ws/*` upgrades).
 *
 * Deliberately electron-free (the `web-proxy.ts` / `web-views.ts` precedent):
 * the per-host listener lifecycle, the capability probe, and the awaited
 * `session.setProxy` apply live in `main.ts`; this module uses only
 * node:http/net/stream, so the sibling `tunnel-proxy.test.ts` runs under
 * plain `node --test`.
 *
 * The tunnel client is Node's global `WebSocket` (undici) — no runtime
 * dependency; it sends no `Origin`/`Sec-Fetch-Site` header, which the
 * server's tunnel upgrader requires.
 */

import { createServer, Agent, request as httpRequest } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { Duplex } from "node:stream";

/** The tunnel endpoint path — every rk WebSocket lives under `/ws/*`. */
const TUNNEL_WS_PATH = "/ws/tunnel";

/** Client writes MUST stay under the server's 1 MiB per-message read limit. */
export const TUNNEL_WS_CHUNK_BYTES = 64 * 1024;

/** Send-side flow control: `_write` callbacks are held while undici's send
 *  buffer exceeds the high-water mark and released at the low-water mark,
 *  which pauses the piped client socket (the WHATWG WebSocket API has no
 *  receive-side backpressure — only `bufferedAmount` on send). */
export const TUNNEL_SEND_HIGH_WATER_BYTES = 1024 * 1024;
export const TUNNEL_SEND_LOW_WATER_BYTES = 256 * 1024;
/** `bufferedAmount` has no change event; drain is polled. */
const TUNNEL_DRAIN_POLL_MS = 10;

/** Receive-side flow control: the WHATWG WebSocket API cannot pause frame
 *  delivery (no receive-side counterpart to `bufferedAmount`), so frames the
 *  readable side backpressures queue in memory, and the tunnel is destroyed
 *  once the queue would exceed this bound — the only hard memory cap
 *  available against a stalled client. */
export const TUNNEL_RECV_HIGH_WATER_BYTES = 4 * 1024 * 1024;

const MIN_PORT = 1;
const MAX_PORT = 65535;
/** Absolute-form requests without an explicit port are plain http. */
const DEFAULT_HTTP_PORT = 80;

/** The listener is loopback-only — same exposure as the SSH `-L` tunnel's
 *  local end; browser pages get 400 on the origin-form arm. */
const PROXY_LISTEN_HOST = "127.0.0.1";

/** Hop-by-hop and proxy-only headers stripped from forwarded absolute-form
 *  requests; `Connection`-listed tokens are stripped additionally. */
const PROXY_STRIP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * The tunnel WebSocket URL for a host origin and `host:port` target:
 * `http:`→`ws:`, `https:`→`wss:`, path `/ws/tunnel`, the target carried
 * URL-encoded in the query (an IPv6 target arrives bracketed via
 * `formatAuthority`). Throws on a non-http(s) origin.
 */
export function tunnelWsUrl(origin: string, target: string): string {
  const url = new URL(origin);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new Error(`unsupported host origin protocol "${url.protocol}"`);
  url.pathname = TUNNEL_WS_PATH;
  url.search = "";
  url.searchParams.set("target", target);
  return url.toString();
}

export interface ConnectTarget {
  /** Bare host — IPv6 literals WITHOUT brackets. */
  host: string;
  port: number;
}

/**
 * Parse a CONNECT authority (`host:port`, IPv6 bracketed). Returns null for
 * anything else: missing/empty host, non-numeric port, port outside
 * 1–65535, unbracketed IPv6.
 */
export function parseConnectAuthority(authority: string): ConnectTarget | null {
  let host: string;
  let portText: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    host = authority.slice(1, close);
    if (authority[close + 1] !== ":") return null;
    portText = authority.slice(close + 2);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon === -1) return null;
    host = authority.slice(0, colon);
    portText = authority.slice(colon + 1);
    if (host.includes(":")) return null; // unbracketed IPv6 is not authority-form
  }
  if (host === "") return null;
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return { host, port };
}

/** The canonical `host:port` authority — IPv6 hosts bracketed. */
export function formatAuthority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * Strip hop-by-hop and proxy-only headers from a request being forwarded:
 * the fixed PROXY_STRIP_HEADERS set plus every token `Connection` lists.
 * All matching is case-insensitive.
 */
export function stripProxyHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionListed = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of (Array.isArray(value) ? value : [value ?? ""]).join(",").split(",")) {
      const listed = token.trim().toLowerCase();
      if (listed !== "") connectionListed.add(listed);
    }
  }
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (PROXY_STRIP_HEADERS.has(lower) || connectionListed.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

export interface ForwardRequest {
  /** Bare hostname (IPv6 without brackets) — what `http.request` wants. */
  host: string;
  port: number;
  /** Origin-form path (`pathname + search`, at minimum `/`). */
  path: string;
  /** Stripped headers with `Host` set from the absolute URL. */
  headers: OutgoingHttpHeaders;
}

/**
 * Turn an absolute-form proxy request (`GET http://host:port/path?q`) into
 * the origin-form forward shape. Returns null for anything not absolute-form
 * plain http — origin-form requests (what a browser page can send to a
 * loopback listener) are rejected by the caller with 400, which keeps the
 * listener useless cross-site and against DNS rebinding.
 */
export function deriveForwardRequest(
  url: string,
  headers: IncomingHttpHeaders,
): ForwardRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // origin-form (`/x`) and garbage alike
  }
  if (parsed.protocol !== "http:") return null; // https rides CONNECT
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "") return null;
  const port = parsed.port === "" ? DEFAULT_HTTP_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
  const stripped = stripProxyHeaders(headers);
  stripped["host"] = parsed.host; // authority, port included when non-default
  return { host, port, path: parsed.pathname + parsed.search, headers: stripped };
}

/**
 * A WebSocket-backed Duplex — the byte pipe between a local client socket
 * (or a pooled `http.Agent` connection) and one tunnel WebSocket. The
 * WebSocket opens on construction so the agent's connect-wait works: Node's
 * Agent never writes before `connect`, it defers on `socket.connecting` and
 * the `connect` event, both of which this class surfaces net.Socket-style.
 *
 * Bytes written before open are buffered and flushed on open; incoming
 * binary frames flow through a bounded receive queue (text frames ignored,
 * forward-compat). The WebSocket has no half-close, matching the server
 * contract: either side ending ends the tunnel.
 */
export class TunnelSocket extends Duplex {
  /** net.Socket surface the http.Agent checks before flushing a request. */
  connecting = true;

  private ws: WebSocket | null = null;
  private wsOpen = false;
  private openSettled = false;
  private pendingWrites: Buffer[] = [];
  private drainWaiters: ((error?: Error | null) => void)[] = [];
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private recvQueue: Buffer[] = [];
  private recvQueuedBytes = 0;
  private recvPaused = false;
  private recvEnded = false;
  private recvEofPushed = false;
  private readonly openPromise: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (error: Error) => void;

  constructor(url: string) {
    super();
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // The pooled-agent path never calls waitOpen(); a handshake failure there
    // must not surface as an unhandled rejection — awaiters still see it.
    this.openPromise.catch(() => {});
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (cause) {
      const error = toError(cause);
      // Deferred so listeners attached right after construction catch it.
      queueMicrotask(() => this.destroy(error));
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => this.onWsOpen());
    ws.addEventListener("message", (event) => this.onWsMessage(event));
    ws.addEventListener("error", () => {
      this.destroy(new Error("tunnel WebSocket error"));
    });
    ws.addEventListener("close", () => this.onWsClose());
  }

  /** net.Socket surface. */
  get readyState(): "opening" | "open" | "closed" {
    if (this.destroyed) return "closed";
    return this.wsOpen ? "open" : "opening";
  }

  /** Resolves on WebSocket open (dial-before-upgrade ⇒ "connected to
   *  target"); rejects when the handshake fails first. */
  waitOpen(): Promise<void> {
    return this.openPromise;
  }

  /** net.Socket shims — no-ops over a WebSocket. */
  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }
  setNoDelay(_noDelay?: boolean): this {
    return this;
  }
  setTimeout(_timeout: number, _callback?: () => void): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  override _read(_size: number): void {
    this.recvPaused = false;
    this.pumpReceived();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (!this.wsOpen) {
      this.pendingWrites.push(buf);
      callback();
      return;
    }
    try {
      this.sendChunked(buf);
    } catch (cause) {
      callback(toError(cause));
      return;
    }
    // Holding the callback pauses the pipe feeding this writable — the
    // send-side backpressure.
    if (this.bufferedAmount() > TUNNEL_SEND_HIGH_WATER_BYTES) {
      this.awaitDrain(callback);
      return;
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    // No half-close: a finished writable side closes the tunnel; the close
    // handshake flushes undici's send buffer first.
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // Already closing/closed.
      }
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.connecting = false;
    if (!this.openSettled) {
      this.openSettled = true;
      this.rejectOpen(error ?? new Error("tunnel WebSocket closed before open"));
    }
    const destroyError = error ?? new Error("tunnel WebSocket destroyed");
    if (this.drainTimer !== null) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) waiter(destroyError);
    this.recvQueue = [];
    this.recvQueuedBytes = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        // Already closing/closed.
      }
    }
    callback(error);
  }

  private onWsOpen(): void {
    this.wsOpen = true;
    this.connecting = false;
    this.openSettled = true;
    this.resolveOpen();
    const pending = this.pendingWrites;
    this.pendingWrites = [];
    try {
      for (const buf of pending) this.sendChunked(buf);
    } catch (cause) {
      this.destroy(toError(cause));
      return;
    }
    this.emit("connect");
  }

  private onWsMessage(event: MessageEvent): void {
    if (this.destroyed || this.recvEnded) return;
    const data: unknown = event.data;
    if (typeof data === "string") return; // text frames ignored (forward-compat)
    let buf: Buffer;
    if (data instanceof ArrayBuffer) {
      buf = Buffer.from(data);
    } else if (ArrayBuffer.isView(data)) {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else {
      return;
    }
    // Undici keeps delivering frames while a stalled consumer holds the
    // readable backpressured; past the bound the tunnel dies rather than
    // accumulating unbounded data in the main process.
    if (this.recvQueuedBytes + buf.length > TUNNEL_RECV_HIGH_WATER_BYTES) {
      this.destroy(new Error("tunnel receive buffer exceeded the high-water mark"));
      return;
    }
    this.recvQueue.push(buf);
    this.recvQueuedBytes += buf.length;
    this.pumpReceived();
  }

  private pumpReceived(): void {
    while (!this.recvPaused) {
      const buf = this.recvQueue.shift();
      if (buf === undefined) break;
      this.recvQueuedBytes -= buf.length;
      if (!this.push(buf)) this.recvPaused = true;
    }
    // EOF rides behind every queued frame, never ahead of one.
    if (this.recvEnded && !this.recvEofPushed && this.recvQueue.length === 0) {
      this.recvEofPushed = true;
      this.push(null);
    }
  }

  private onWsClose(): void {
    if (this.destroyed) return;
    if (!this.openSettled) {
      // Dial-before-upgrade ⇒ a pre-open close IS the handshake failure.
      this.openSettled = true;
      this.rejectOpen(new Error("tunnel WebSocket handshake failed"));
    }
    this.connecting = false;
    this.recvEnded = true;
    this.pumpReceived();
    if (!this.writableEnded) this.end();
  }

  private bufferedAmount(): number {
    return this.ws !== null && this.wsOpen ? this.ws.bufferedAmount : 0;
  }

  private sendChunked(buf: Buffer): void {
    const ws = this.ws;
    if (ws === null) return;
    for (let offset = 0; offset < buf.length; offset += TUNNEL_WS_CHUNK_BYTES) {
      // A fresh Uint8Array over a real ArrayBuffer: Buffer's SharedArrayBuffer
      // typing does not satisfy the WebSocket send() contract.
      ws.send(new Uint8Array(buf.subarray(offset, offset + TUNNEL_WS_CHUNK_BYTES)));
    }
  }

  private awaitDrain(callback: (error?: Error | null) => void): void {
    this.drainWaiters.push(callback);
    if (this.drainTimer !== null) return;
    this.drainTimer = setInterval(() => {
      if (this.bufferedAmount() <= TUNNEL_SEND_LOW_WATER_BYTES) {
        if (this.drainTimer !== null) {
          clearInterval(this.drainTimer);
          this.drainTimer = null;
        }
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const waiter of waiters) waiter(null);
      }
    }, TUNNEL_DRAIN_POLL_MS);
    this.drainTimer.unref();
  }
}

/** A keep-alive agent whose pooled connections are tunnel WebSockets —
 *  `AgentOptions` exposes no `createConnection`, so the override rides the
 *  Agent class seam. */
class TunnelAgent extends Agent {
  constructor(
    private readonly hostOrigin: string,
    private readonly authority: string,
  ) {
    super({ keepAlive: true });
  }

  override createConnection(): Duplex {
    return new TunnelSocket(tunnelWsUrl(this.hostOrigin, this.authority));
  }
}

export interface LocalProxy {
  port: number;
  close(): Promise<void>;
}

/** The tunnel surface the CONNECT wiring needs — TunnelSocket satisfies it
 *  structurally; tests substitute a controllable Duplex. */
export type ConnectTunnel = Duplex & { waitOpen(): Promise<void> };

/**
 * Wire one CONNECT client socket to its tunnel: `200 Connection
 * Established` on open / `502 Bad Gateway` on handshake failure
 * (dial-before-upgrade makes the handshake the dial), then pipe both ways.
 * Bytes Chromium pipelined behind the CONNECT head ride first.
 *
 * Pre-open tunnel error/close MUST NOT destroy the client socket: undici
 * emits the WebSocket error before close and the waitOpen() rejection owns
 * the handshake failure — destroying the socket from a tunnel event can
 * reset the client before the 502 lands. Only an established tunnel's death
 * ends the client connection.
 */
export function handleConnectTunnel(socket: Duplex, tunnel: ConnectTunnel, head: Buffer): void {
  socket.once("error", () => {
    // A dead client needs no answer.
  });
  let tunnelOpen = false;
  tunnel.on("error", () => {
    if (tunnelOpen) socket.destroy();
  });
  tunnel.on("close", () => {
    if (tunnelOpen && !socket.destroyed) socket.destroy();
  });
  socket.on("close", () => tunnel.destroy());
  tunnel.waitOpen().then(
    () => {
      if (socket.destroyed) {
        tunnel.destroy();
        return;
      }
      tunnelOpen = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) tunnel.write(head);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    },
    () => {
      tunnel.destroy();
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      }
    },
  );
}

/**
 * Start a loopback HTTP proxy for one host. The `'connect'` event handles
 * Chromium's CONNECT (authority-form): open a tunnel WebSocket for
 * `target=host:port`, answer `200 Connection Established` on open /
 * `502 Bad Gateway` on handshake failure (dial-before-upgrade makes the
 * handshake the dial), then pipe both ways. The `'request'` event handles
 * absolute-form plain http: each request is forwarded origin-form over a
 * per-`host:port` pooled keep-alive agent whose connections are
 * TunnelSockets — Chromium reuses one proxy connection across origins, so
 * per-request parsing is mandatory and pooling avoids one WebSocket
 * handshake per module request of a dev app. Origin-form requests get 400.
 *
 * Every error path destroys sockets; nothing throws past this module.
 */
export async function createLocalProxy(hostOrigin: string): Promise<LocalProxy> {
  // Validate the origin up front so no per-connection path can throw on URL
  // construction.
  const parsed = new URL(hostOrigin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported host origin protocol "${parsed.protocol}"`);
  }

  const agents = new Map<string, Agent>();
  // Upgraded CONNECT sockets are invisible to closeAllConnections() —
  // close() destroys this set directly.
  const connectSockets = new Set<Duplex>();

  const server = createServer();

  server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.once("error", () => {
      // A dead client needs no answer.
    });
    const target = req.url === undefined ? null : parseConnectAuthority(req.url);
    if (target === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    connectSockets.add(socket);
    socket.once("close", () => connectSockets.delete(socket));
    handleConnectTunnel(
      socket,
      new TunnelSocket(tunnelWsUrl(hostOrigin, formatAuthority(target.host, target.port))),
      head,
    );
  });

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const derived = req.url === undefined ? null : deriveForwardRequest(req.url, req.headers);
    if (derived === null) {
      res.writeHead(400).end();
      return;
    }
    const authority = formatAuthority(derived.host, derived.port);
    let agent = agents.get(authority);
    if (agent === undefined) {
      agent = new TunnelAgent(hostOrigin, authority);
      agents.set(authority, agent);
    }
    const upstream = httpRequest({
      agent,
      host: derived.host,
      port: derived.port,
      method: req.method,
      path: derived.path,
      headers: derived.headers,
    });
    upstream.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("error", () => upstream.destroy());
    // A client that went away mid-response aborts the upstream request; a
    // normally completed response (writableEnded) frees it to the pool.
    res.on("close", () => {
      if (!res.writableEnded && !upstream.destroyed) upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    // The once-listener stays attached after listen succeeds: a post-listen
    // server error calls the settled reject (a no-op) instead of crashing
    // the main process as an unhandled 'error'.
    server.once("error", reject);
    server.listen(0, PROXY_LISTEN_HOST, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("local proxy listener has no port");
  }

  let closed = false;
  return {
    port: address.port,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
      // Upgraded CONNECT sockets survive closeAllConnections(); an active
      // tunnel would otherwise hold server.close()'s callback forever.
      for (const socket of connectSockets) socket.destroy();
      connectSockets.clear();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive client sockets would otherwise hold the port open.
        server.closeAllConnections();
      });
    },
  };
}
