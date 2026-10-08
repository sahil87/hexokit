# Intake: Web-Tile Tunnel over WebSocket (Remote-Native Mode Behind Any Front End)

**Change**: 260925-xm7k-web-tile-ws-tunnel
**Created**: 2026-09-25

## Origin

Conversational. The user and the orchestrating agent discussed the design after #1033 ("Web Tile Remote-Native Mode (Same-Port Forward Proxy)", change `260925-lqgp-web-tile-remote-proxy`) merged. This intake was created by a promptless dispatch (`{questioning-mode} = promptless-defer`) from the synthesized discussion. Title idea: "web-tile tunnel over WebSocket — make the remote-native web tile work behind ANY front end".

**Live verification on 2026-09-25, after #1033 merged:**

- #1033's same-port forward proxy relies on HTTP proxy request shapes: `CONNECT host:port` and absolute-form `GET http://…`.
- Nearly every front end people put in front of rk — Tailscale Serve, nginx, Caddy, Cloudflare Tunnel, ngrok, load balancers — is an origin-form HTTP reverse proxy that rejects or rewrites those shapes. Tailscale Serve answers CONNECT with its own 404 (verified).
- The proxy therefore only works with a raw TCP path to rk's listen port: an SSH `-L` tunnel, or rk bound to a reachable interface.
- On the user's own box the live daemon binds `127.0.0.1:3000` only, behind Tailscale Serve (`https://dev-ws-sahil02.bat-ordinal.ts.net`). #1033's https workaround (probe `http://<hostname>:<advertised forwardProxy port>`) fails there, and the desktop falls back to `legacy` (the old `/proxy/{port}` behavior). SSH hosts work.
- Direct verification through `127.0.0.1:3000` passed: absolute-form, CONNECT, https egress, and 502 on a dead port.
- The user's point: Tailscale is not ubiquitous, and users connect rk in many ways, so the mechanism must be generic.

**Decision (user approved: "yes, proceed"): carry the proxy traffic over a WebSocket.** Every deployment where rk works at all already passes WebSockets — the terminal relay (`/ws/terminals`) and state socket (`/ws/state`) depend on them — so a tunnel over a WebSocket goes through any front end rk already runs behind.

Decisions reached in the discussion (encoded as Certain/Confident rows in § Assumptions):

1. A **local HTTP proxy in the Electron main process** terminates Chromium's proxy protocol on the viewer's own machine; per-host guest sessions point `session.setProxy` at it.
2. The local proxy carries each proxied connection over a **WebSocket tunnel** to the rk server, which dials `host:port` from the rk host (DNS on the rk host) and pipes bytes. The server needs ONE primitive: "open TCP to host:port".
3. **Remove #1033's front-end-hostile parts**: the same-port CONNECT/absolute-form wrapper, its constitution Principle IX exception, the `forwardProxy` health field, the https raw-port special case and the CONNECT probe in the desktop.
4. **Security**: the tunnel upgrader rejects browser Origins (strictest acceptable policy), and — agreed by the user — the existing WebSocket upgrader(s) are tightened so cross-site pages cannot open rk's state/terminal sockets.
5. **Keep from #1033 unchanged**: per-host partitions, `direct`/`proxy`/`legacy` mode derivation and its local-host ordering (incl. the win32 guard), `web.mode()` bridge, the frontend's literal-URL loading (`toNativeSrc`), the iframe engine's `/proxy/{port}`.
6. **Performance**: one WebSocket per proxied connection to start; multiplexing (e.g. yamux) explicitly deferred unless measurement demands it.

## Why

### The problem

#1033 made the desktop native web engine behave "as if the browser ran on the rk host": each remote host's guest session is `session.setProxy`'d at that host's rk origin, and rk's listen port doubles as an HTTP forward proxy (`app/backend/api/forward_proxy.go`, `api.ForwardProxy(router)` wired at `app/backend/cmd/rk/serve.go:344`). Chromium speaks the HTTP proxy protocol to it: `CONNECT host:port` for `https://`, `ws://`, `wss://`, and absolute-form `GET http://host:port/path` for plain http.

Those request shapes do not survive an origin-form reverse proxy. The only hosts that get `proxy` mode are ones with a raw TCP path to rk's port (SSH hosts via the `-L` tunnel; rk bound to `0.0.0.0` on a tailnet). The #1033 fallback for `https:` origins — `proxyRulesFor` in `app/desktop/src/web-proxy.ts` targeting `http://<hostname>:<advertised port>` only when `isTailnetHostname(...)` — fails whenever rk binds loopback behind the front end, which is the recommended and the user's own deployment. Every such host silently degrades to `legacy`, i.e. the pre-#1033 `/proxy/{port}` path-rewrite behavior with all its failures (JS-constructed URLs go to the viewer, root-absolute asset paths break, HMR WebSockets and OAuth redirects break, all ports share one origin).

### Consequence of not fixing

Remote-native mode works only for SSH hosts and raw-port tailnet binds. For the common "rk behind Tailscale Serve / nginx / Caddy / Cloudflare Tunnel" deployments, the feature #1033 shipped is dead code, and the #1033 forward proxy stays as an extra, front-end-hostile transport on the daemon's port plus a constitution exception that buys nothing there.

### Why this approach

- **WebSockets already traverse every working deployment.** rk is unusable without its WebSocket sockets, so a WebSocket-carried tunnel reaches the rk host wherever rk works at all — no new port, no front-end configuration, no Tailscale dependency.
- **Chromium's proxy protocol terminates locally.** The local proxy speaks CONNECT/absolute-form with Chromium on `127.0.0.1`, which never touches the front end.
- **One server primitive.** The server only opens TCP to `host:port` and pipes bytes; plain-HTTP absolute-form requests are turned into byte tunnels on the desktop side.
- **No Principle IX exception needed.** A WebSocket upgrade is an ordinary `GET`, so the second exception #1033 added can be removed.
- **Rejected alternatives**: keeping the raw-port workaround (fails for loopback binds, and binding rk to a public interface is the wrong fix); requiring users to configure their front end to pass CONNECT (most cannot — Tailscale Serve, Cloudflare Tunnel have no such option); SOCKS5 (`ssh -D`) — already rejected in #1033 (SSH-only).

## What Changes

### 1. Backend — `/ws/tunnel` WebSocket endpoint (`app/backend/api/`)

A new GET WebSocket endpoint in the chi router with its **own upgrader**. The user described the path as `/api/tunnel`; this intake records **`/ws/tunnel`** as the default because every existing rk WebSocket lives under `/ws/*` (`router.go:1036-1045`: `/ws/state`, `/ws/terminals`, `/ws/gui/{id}`), the Vite dev proxy forwards upgrades only for `/ws` (`app/frontend/vite.config.ts` — `/api` has `changeOrigin: true` and **no** `ws: true`), and front-end configs that scope WebSocket upgrades by path (a common nginx pattern: `location /ws/ { proxy_set_header Upgrade …; }`) already pass `/ws/*` — which is the change's whole premise.

```
GET /ws/tunnel?target=<host>:<port>   (Upgrade: websocket)
```

Handler order (every rejection happens BEFORE the upgrade, as a plain HTTP error with the project's `{ "error": "..." }` shape):

| Step | Check | Failure |
|---|---|---|
| 1 | Origin policy: the request MUST carry NO `Origin` header (see § 4) | `403` |
| 2 | `target` parses via `net.SplitHostPort`, non-empty host, numeric port 1–65535 | `400` |
| 3 | Dial `target` with `net.Dialer{Timeout: tunnelDialTimeout}` (named constant, 10 s — #1033's CONNECT value) via `DialContext` on the request context; hostnames resolve on the rk host | `502` |
| 4 | Upgrade (the dedicated tunnel upgrader) | gorilla's own handshake error |

**Dial before upgrade** (recommended default): a successful handshake then *means* "connected", so the desktop can answer Chromium's CONNECT with `200 Connection Established` on `open` and `502 Bad Gateway` on handshake failure, with no extra in-band signalling. (The alternative — upgrade first, then close with a private close code such as `4502` on dial failure — is the plan's call if it finds a reason.)

**Byte pipe** — modeled directly on the existing WS↔TCP relay in `app/backend/api/gui_ws.go` (`handleGuiWS`: binary frames both ways, `context.Background()`-rooted lifecycle because some servers cancel `r.Context()` at upgrade, a TCP→WS pump that is the ONLY writer, a WS→TCP read loop, `SetReadLimit`, per-write `SetWriteDeadline`, short-read-deadline teardown idiom, both conns closed and the pump joined before return):

- TCP → WS: read chunks (named constant, e.g. 32–64 KiB) and write each as one binary message; upstream EOF → send a normal close frame, then teardown.
- WS → TCP: binary messages written verbatim to the TCP conn; text frames ignored (forward-compat); a WS read error / close → teardown.
- **Cleanup is close-driven and leak-free**: either side ending closes BOTH the TCP conn and the WebSocket, and the handler waits for the pump goroutine — no goroutine or socket outlives the handler. WebSocket has no half-close, so a TCP FIN from upstream ends the tunnel (acceptable: HTTP/1.1 and WebSocket traffic do not rely on half-close).
- **No short deadline and no idle cap** on an established tunnel — HMR WebSockets and long-polls are long-lived; lifetime is close-driven only.
- **Front-end idle timeouts**: nginx (`proxy_read_timeout` 60 s default) and Cloudflare (~100 s) cut idle WebSockets. The server SHOULD send periodic WS ping control frames on the tunnel (named constant, e.g. 30 s; gorilla's `WriteControl` is safe concurrently with the pump writer) so an idle HMR socket inside the tunnel is not severed by the front end. The Node/undici client answers pings automatically.
- **Read limit**: `SetReadLimit` bounds one inbound message (memory-DoS, the `guiReadLimit` rationale); the desktop client MUST chunk writes below it.
- No subprocess (net dialing only — Principle I), no state beyond live connections (Principle II), **no destination policy** (#1033's decision, unchanged: anyone who can reach rk already has a shell through the terminal relay).

**Capability signal on `GET /api/health`** (`app/backend/api/health.go`): the `forwardProxy` field is **removed**. Recommended replacement: a `tunnel` field carrying the daemon's listen port (JSON number, derived per request from config — Constitution II), which the desktop's probe uses as the tunnel target for a self-test (§ 3). Renaming (rather than reusing `forwardProxy`) keeps version skew safe in both directions: a #1033-era desktop against this server sees no `forwardProxy` → `legacy` (never probes a CONNECT that no longer exists); this desktop against a #1033-era server sees no `tunnel` → `legacy`.

### 2. Backend — remove #1033's forward-proxy transport

- Delete `app/backend/api/forward_proxy.go` and `app/backend/api/forward_proxy_test.go` (its WebSocket-over-CONNECT test case is the only other `websocket.Upgrader` in the tree — `forward_proxy_test.go:121`).
- `app/backend/cmd/rk/serve.go:337-345`: `Handler: api.ForwardProxy(router)` → `Handler: router`, and drop the wrapper comment.
- `app/backend/api/health.go`: remove `forwardProxy` and its doc-comment text; `health_test.go` cases for it change to the new field.
- Side effect worth recording: #1033's dev observation that Vite's dev proxy sends absolute-form requests into the wrapper disappears once the wrapper is gone.

### 3. Desktop — local proxy + WebSocket tunnel client (`app/desktop/src/`)

**Local proxy.** An HTTP proxy in the Electron main process, bound to `127.0.0.1:<ephemeral port>` (listen on port 0). **One listener per host** is the recommended default: the listener's identity *is* the host, so no per-request routing or proxy-auth trick is needed; it starts lazily in `ensureHostProxy` when a host settles to `proxy` mode, is reused while the host's URL is unchanged, and is closed when the host is removed or its URL changes (re-created on the next ensure). (One shared listener routing per host is the plan's alternative.)

Each proxy-mode host's guest session (`persist:rk-web:<host.id>`, unchanged) gets:

```ts
await guestSession(host).setProxy({
  mode: "fixed_servers",
  proxyRules: `http://127.0.0.1:${localPort}`,
  proxyBypassRules: "<-loopback>",   // verified by #1033's web-proxy.spec.ts
});
```

`setProxyConfigFor(mode, rules)` in `web-proxy.ts` stays; `proxyRulesFor` collapses to "the host's local listener".

**What the local proxy accepts from Chromium:**

| Chromium request | Local proxy action |
|---|---|
| `CONNECT host:port` (https, `ws://`, `wss://`) | Open a tunnel WebSocket for `target=host:port`; on `open` write `HTTP/1.1 200 Connection Established\r\n\r\n` to the Chromium socket, flush any bytes already buffered after the CONNECT head into the tunnel, then pipe both ways; on handshake failure write `HTTP/1.1 502 Bad Gateway` and close |
| Absolute-form `GET http://host:port/path` (plain http) | Forward over a tunnel to `host:port`, writing the request in **origin-form** (`GET /path HTTP/1.1`) with hop-by-hop and proxy-only headers stripped (`Proxy-Connection`, `Proxy-Authorization`, `Connection` + `Connection`-listed headers, `Keep-Alive`, `TE`, `Trailer`, `Upgrade` — `Transfer-Encoding` framing preserved correctly), `Host` set from the absolute URL; response streamed back to Chromium verbatim (no rewriting) |
| Origin-form request (`GET /x`, i.e. not proxy-shaped) | Reject `400` — a web page on the viewer machine can reach `127.0.0.1:<port>` only with origin-form requests, so this keeps the listener useless cross-site (and against DNS rebinding) |

**Keep-alive caveat for absolute-form (plan MUST handle):** Chromium reuses a keep-alive connection *to its proxy* for requests to **different** origins, so the local proxy cannot rewrite the first request and then blindly pipe bytes. It must parse each request. Recommended default: Node `http.createServer()` — the `'request'` event handles absolute-form, the `'connect'` event handles CONNECT — and forward each absolute-form request with `http.request` over a tunnel-backed socket. To avoid one WebSocket handshake (through the front end) per HTTP request — a Vite dev app issues hundreds of module requests — tunnels for absolute-form traffic SHOULD be pooled per `host:port` (e.g. a keep-alive `http.Agent` per target whose `createConnection` returns a WebSocket-backed `Duplex`; Node's Agent expects net.Socket-ish methods such as `setKeepAlive`/`setNoDelay`/`setTimeout`/`ref`/`unref`, which the adapter must provide as no-ops). The exact shape is the plan's choice.

**Tunnel client.** URL = the host origin with `http:`→`ws:`, `https:`→`wss:`, path `/ws/tunnel`, query `target=<host>:<port>` (URL-encoded; IPv6 hosts bracketed). For an SSH host the origin is the viewer-side tunnel origin `http://127.0.0.1:<L>` (the existing `-L` forward carries it — no new forward); for a Tailscale Serve host it is `wss://<name>.ts.net/ws/tunnel`. Binary frames, `binaryType = "arraybuffer"`; writes chunked below the server's read limit.

- **WebSocket client implementation**: `app/desktop` has no runtime dependencies (devDependencies only: electron, electron-builder, @playwright/test, typescript; `engines.node >=22.12.0`). Node 22+'s global `WebSocket` (undici) is the default — no new dependency. Two things the plan MUST verify: (a) what `Origin` header undici's `WebSocket` sends from the main process (the server requires NONE — § 4; undici accepts a non-standard `{ headers }` constructor option if an override is needed); (b) flow control — the WHATWG `WebSocket` API has no receive-side backpressure (only `bufferedAmount` on send), so a large download through a slow Chromium consumer buffers in memory. Pausing the Chromium-side read when `bufferedAmount` exceeds a named high-water mark covers the send side; if receive-side buffering proves a problem, adding the `ws` package (proper streams) is acceptable but must be justified and packaged.

**Capability probe — "can I open the tunnel WebSocket to this host?"** Replaces `probeForwardProxy` + `connectProbe` (`main.ts:625-690`):

1. `GET <origin>/api/health` → 200 with a numeric `tunnel` field (the rk listen port). Absent ⇒ older server ⇒ `legacy`, no probe (the #1033 shape, field renamed).
2. Open `<ws-origin>/ws/tunnel?target=127.0.0.1:<tunnel port>` (the rk host's own listen port — listening on every rk host), write `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:<port>\r\nConnection: close\r\n\r\n`, and require an `HTTP/1.1 200` status line within `PROXY_PROBE_TIMEOUT_MS` (5 s, existing constant). This proves the whole path end to end — the front end passes the upgrade, rk accepts the Origin-less client, the dial works, and bytes flow both ways.
3. Any failure — timeout, handshake refused, non-200 — ⇒ `legacy`. Cached per (host id, url) exactly as `hostProxyStates`/`hostProxyPending` do today; re-run on URL change / SSH heal.

**Removed from the desktop:** `isTailnetHostname` and the `https:` raw-port arm of `proxyRulesFor` (`web-proxy.ts:69-106`), `connectProbe` and the `forwardProxy` health parsing in `probeForwardProxy`, and the related tests in `web-proxy.test.ts`. An `https:` origin now needs no special case — `wss://` just works through the TLS front end.

**Unchanged** (decision 5): `guestPartitionName`, `webProxyModeFor` (remote-field-first ordering, the `localOrigin === null && platform !== "win32" && isLoopbackOrigin` guard), `setProxyConfigFor`, `ensureHostProxy`'s settle-before-first-`loadURL` contract and pending/stale-completion handling, the `web:mode` IPC + `runkitShell.web.mode()` bridge, the frontend's `toNativeSrc` literal-URL loading, and the iframe engine's `/proxy/{port}`.

**Exposure of the local listener:** it is loopback-bound, like the SSH `-L` tunnel's local end (`127.0.0.1:<L>`, `app/backend/internal/remote/tunnel.go`) that already gives any local process on the viewer machine a path to the remote rk — so it adds no exposure beyond what `rk remote` already grants. Browser pages cannot use it (origin-form only → 400).

### 4. Security — WebSocket Origin policy (`app/backend/api/`)

Browsers do not apply CORS to WebSockets, and rk's shared upgrader accepts any Origin:

```go
// app/backend/api/state_ws.go:188-190 — shared by /ws/state, /ws/terminals (terminals_ws.go:351), /ws/gui/{id} (gui_ws.go:80)
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}
```

A tunnel endpoint with that policy would let ANY web page the user visits open `ws://127.0.0.1:3000/ws/tunnel?target=…` and pivot through rk into the host's network.

**Tunnel upgrader — strictest policy:** accept ONLY requests with **no `Origin` header and no `Sec-Fetch-Site` header**. The tunnel's sole client is the Electron main process (a non-browser client); every browser WebSocket carries an `Origin` it cannot suppress, so this rejects all browser pages — cross-site, same-site, and DNS-rebinding alike. rk's own origin is NOT accepted either (the SPA never opens the tunnel). If the plan finds undici always sends an Origin, the fallback is a fixed, non-browser-producible value set by the main process (e.g. via undici's `headers` option) — but "absent" is the target.

**Shared upgrader — tightened (user agreed, in scope):** replace `return true` with a Fetch-Metadata-first same-origin check (Assumption 22):

- `Sec-Fetch-Site: same-origin` → allow. The browser computes it against the URL it actually connected to, so a front end that rewrites `Host` (nginx default, Tailscale Serve, load balancers) cannot break the SPA's own sockets.
- `Sec-Fetch-Site: cross-site` or `same-site` (or any other value) → reject (`403`).
- `Sec-Fetch-Site` absent (non-browser clients, or a browser that predates Fetch Metadata) → fall through:
- `Origin` absent → allow (non-browser clients: Go/Node tooling, tests).
- Otherwise parse `Origin`; allow when its host[:port] equals (case-insensitive, default ports normalized) the request's `Host`, **or** the reverse-proxy-supplied host — the first `X-Forwarded-Host` value (and, optionally, `Forwarded: host=`). This is gorilla's own default `checkSameOrigin` (nil `CheckOrigin` = Origin host vs `r.Host`) extended with forwarded-host awareness. Scheme is not compared (a TLS front end: `Origin: https://x.ts.net` vs a plain-http hop).
- Anything else → reject (gorilla answers `403`).
- Trusting `X-Forwarded-Host` is safe for this purpose: the browser `WebSocket` API cannot set custom request headers, so a cross-site page cannot forge it, and a non-browser client can simply omit `Origin` anyway.
- Existing precedent to reuse where sensible: `requestOrigin(r)` in `app/backend/api/framecheck.go:136` (derives the viewer origin from `X-Forwarded-Proto` + `r.Host`) and `isLoopbackHost` (`framecheck.go:122`); `internal/mcp/origin.go` (`normalizeOrigin`, bind-derived `OriginPolicy`).

**Compatibility that MUST keep working (plan verifies):**

- `just dev` / `just test-e2e`: the Vite dev server proxies `/ws` with `ws: true` and **no `changeOrigin`** (`vite.config.ts:45-51`), so `Host` stays the Vite `host:port` and matches the page's `Origin` → allowed. The whole Playwright e2e suite runs through this path, so it is the regression gate for the tightened check.
- The desktop app: a host view's SPA origin is the host URL, and its sockets' `Host` is the same → allowed. The desktop's own `just dev` host (the Vite origin) is covered by the bullet above.
- Browser viewers behind Tailscale Serve (the user's live box) and other front ends — see the known risk below.

**Known limitations to record (not fixed here):**

- **Host-rewriting front ends.** A front end that rewrites `Host` to the upstream and does NOT send `X-Forwarded-Host` (nginx's default `proxy_set_header Host $proxy_host`, some load balancers) would fail a pure Host-match check and break the SPA's own `/ws/state` and `/ws/terminals`.
  **Resolved (Assumption 22):** the shared upgrader checks `Sec-Fetch-Site` first (`same-origin` allowed, `cross-site`/`same-site` rejected) and only falls back to the `Origin` vs `X-Forwarded-Host`/`Host` match when the header is absent — so Host-rewriting front ends do not break rk.
- **DNS rebinding** is not stopped by a Host-match rule (under rebinding both `Origin` and `Host` carry the attacker's name). The MCP transport uses a bind-derived allowlist for exactly that reason (`internal/mcp/origin.go`: "the request Host header is never consulted"). The tunnel is immune (no-Origin rule); the shared upgrader's residual exposure matches the rest of the HTTP API.
- **CORS is allow-all** (`router.go:869-870`: `AllowedOrigins: []string{"*"}`), so any cross-site page can already call `/api/*` — including endpoints that drive tmux panes. Tightening the WebSocket upgrader is therefore defense-in-depth for the socket surface, not a closure of the cross-site hole; tightening CORS is out of scope here (§ Open Questions, Assumption 23).
  **Resolved (Assumption 23):** CORS stays allow-all here; tightening it is a follow-up change.

**Tests (Go):** accepted and rejected origins for both upgraders — absent Origin (allowed on both), same-origin Origin vs `Host` (allowed on shared, **rejected** on tunnel), `X-Forwarded-Host` match (allowed on shared), `Sec-Fetch-Site: same-origin` with a mismatched `Host` (allowed on shared — the Host-rewriting front-end case), `Sec-Fetch-Site: cross-site`/`same-site` (rejected on both), any `Sec-Fetch-Site` on the tunnel (rejected), cross-site Origin (rejected on both), default-port normalization, malformed Origin (rejected).

### 5. Constitution (`fab/project/constitution.md`)

- Remove Principle IX's second exception (the HTTP forward-proxy transport paragraph) and restore single-exception wording: "Two documented exceptions." + numbered list → "One documented exception:" followed by the `/mcp` paragraph (the pre-1.13.0 shape).
- No new exception: the tunnel is a `GET` WebSocket upgrade, ordinary under Principle IX.
- Governance line:

```
**Version**: 1.14.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-25
```

(Minor bump, per the user's instruction.)

### 6. Tests

- **Go** (`app/backend/api/`): a new tunnel test file — bytes both ways through a live upstream (incl. a WebSocket upgrade echo *inside* the tunnel, the HMR case), `400` bad target, `502` dial failure before upgrade, `403` when any `Origin` is present, close-driven cleanup from either side (both conns closed, no leaked goroutines), no deadline on a quiet tunnel; the shared-upgrader Origin-policy table (§ 4); `health_test.go` for the `tunnel` field and the absence of `forwardProxy`. Gate: `env -u TMUX -u TMUX_PANE just test-backend`.
- **Desktop unit** (`node --test` over compiled output, the package convention): pure helpers in `web-proxy.ts` — CONNECT authority parsing/validation, absolute-form → origin-form request-line rewrite, hop-by-hop header stripping, tunnel URL construction (`http`→`ws`, `https`→`wss`, SSH tunnel origin, IPv6 bracketing, target encoding), `proxyRulesFor` → local listener. Plus an integration test of the local proxy against a stub tunnel server if feasible (Node has no built-in WebSocket *server*; a minimal hand-rolled handshake in the test, or covering this layer in e2e only, is the plan's call).
- **Desktop e2e** (`just test-desktop-e2e`): keep `app/desktop/tests/e2e/web-proxy.spec.ts` (the `<-loopback>` verification — still load-bearing); update `web-native.spec.ts` only as needed (its e2e hosts are the lane's local daemon → `direct`). **New end-to-end check: a remote-mode tile works behind an origin-form reverse proxy** — a spec-owned Node reverse proxy in front of the e2e rig that passes WebSocket upgrades but answers CONNECT and absolute-form with 404 (Tailscale Serve's behavior), registered as a host that derives non-`direct` (the fixture must make the host remote — e.g. a hosts.json entry with a `remote` field, checked not to trigger the SSH heal/interstitial flow, or another non-local origin shape; plan's call), asserting the guest loads a literal `http://localhost:<stubPort>/` page served on the rig side and a JS `fetch` to a second loopback port also resolves there. Every new/modified `test()` carries the Proves/Steps JSDoc and the file header per the constitution's Test Intent Comments rule.

### 7. Docs

- `docs/specs/api.md`: replace § Forward Proxy (lines ~574-640) with **§ Tunnel** — endpoint, query contract, handler order + status codes, dial-before-upgrade, byte-pipe and close semantics, ping keepalive, read limit, no destination policy + rationale, statelessness — and add the **WebSocket Origin policy** (tunnel: no Origin and no `Sec-Fetch-Site`; shared upgrader: `Sec-Fetch-Site` first, then same-origin incl. `X-Forwarded-Host`, with the known limitations). Update § Health (`forwardProxy` → `tunnel`), Design Principles item 1 (back to one exception: `/mcp`), the Route Summary (add `GET /ws/tunnel`; drop the forward-proxy "transport, no row" note at ~736-737).
- `docs/specs/window-views.md` § Engines (~line 118): `proxy` mode now routes via the desktop-local proxy + WebSocket tunnel (`api.md` § Tunnel), working behind any front end that passes WebSockets.
- Memory updates happen at hydrate (§ Affected Memory).

## Affected Memory

- `run-kit/api-and-sockets`: (modify) remove § Forward Proxy and the second §IX exception; add the `/ws/tunnel` endpoint (Origin-less clients only, dial-before-upgrade, byte pipe, close-driven cleanup, ping keepalive, no destination policy); the shared WebSocket upgrader's same-origin policy; `/api/health` `forwardProxy` → `tunnel`
- `run-kit/desktop-shell`: (modify) § Web Views per-host proxy modes — `proxy` mode now rides a per-host local proxy on `127.0.0.1:<ephemeral>` + WebSocket tunnel; the new tunnel probe replacing health-field + raw CONNECT; removal of the tailnet `https:` raw-port arm; Design Decisions: supersede "Same-port HTTP forward proxy over SOCKS5" and the TLS-fronted raw-port entry with "WebSocket tunnel over same-port forward proxy"
- `run-kit/remote-hosts`: (modify) the `-L` forward now carries the web tile's tunnel WebSockets (`/ws/tunnel`) rather than forward-proxy traffic; still no new forward
- `run-kit/architecture/overview`: (modify) security section — the daemon is no longer an HTTP forward proxy; the tunnel endpoint and the WebSocket Origin policy (tunnel: no Origin/`Sec-Fetch-Site`; shared: `Sec-Fetch-Site` first, then same-origin + X-Forwarded-Host), with the DNS-rebinding and CORS-allow-all limitations
- `run-kit/architecture/testing`: (modify) desktop e2e — the origin-form reverse-proxy fixture and what it proves; Go tunnel/Origin-policy tests

## Impact

- **Backend**: new `app/backend/api/tunnel_ws.go` (name indicative) + test; `app/backend/api/router.go` (route `GET /ws/tunnel` beside the other `/ws/*` routes); `app/backend/api/state_ws.go` (shared upgrader `CheckOrigin`) + a helper and its tests; `app/backend/api/health.go` + `health_test.go`; `app/backend/cmd/rk/serve.go` (unwrap); delete `app/backend/api/forward_proxy.go` + `forward_proxy_test.go`.
- **Desktop**: new local-proxy + tunnel-client module (e.g. `app/desktop/src/tunnel-proxy.ts`, electron-free so `node --test` can reach it), `app/desktop/src/web-proxy.ts` (+ tests: pure helpers added, tailnet/raw-port arm removed), `app/desktop/src/main.ts` (`ensureHostProxy` starts/reuses/closes the host's local listener; probe replaced; listener cleanup on host removal/URL change and app quit), new/updated desktop e2e specs.
- **Frontend**: none expected (mode strings and `toNativeSrc` unchanged). The SPA's own sockets are affected only by the Origin tightening — covered by the existing e2e suite via Vite.
- **Governance/docs**: `fab/project/constitution.md`, `docs/specs/api.md`, `docs/specs/window-views.md`.
- **Dependencies**: none new by default (Node global `WebSocket`; gorilla/websocket already in Go).
- **Deploy note**: the user's box must be re-verified live after ship — a browser viewer through Tailscale Serve still connects (Origin tightening), and the desktop derives `proxy` (not `legacy`) for `https://dev-ws-sahil02.bat-ordinal.ts.net`.
- **Test gates**: `env -u TMUX -u TMUX_PANE just test-backend`, `just test-frontend`, desktop `node --test`, `just test-desktop-e2e`, and the Playwright e2e suite (Vite `/ws` path under the tightened Origin check).

## Open Questions

- ~~Host-rewriting front ends~~ — resolved (Assumption 22): Fetch-Metadata-first Origin policy.
- ~~CORS~~ — resolved (Assumption 23): stays allow-all here; follow-up change.
- ~~Endpoint path~~ — resolved (Assumption 5): `/ws/tunnel`.
- Does Tailscale Serve pass WebSocket upgrades on `/ws/tunnel` with binary frames end-to-end? (Verification, not a decision — plan task; the existing `/ws/*` sockets already work through it.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Carry the web tile's proxy traffic over a WebSocket tunnel: a desktop-local HTTP proxy terminates Chromium's CONNECT/absolute-form, and each proxied connection rides a WebSocket to the rk server, which dials `host:port` and pipes bytes | Discussed — user approved ("yes, proceed"); WebSockets traverse every front end rk already works behind (terminal relay + state socket depend on them) | S:95 R:55 A:90 D:90 |
| 2 | Certain | The server exposes ONE primitive — "open TCP to host:port" — and absolute-form plain HTTP is turned into a byte tunnel on the desktop side (request rewritten to origin-form, hop-by-hop headers stripped) | Discussed — user's design, item 2 | S:95 R:65 A:90 D:90 |
| 3 | Certain | Full remote incl. DNS and NO destination policy, unchanged from #1033: the server dials from the rk host with Go's resolver; no allowlist/blocklist | Discussed — preserves #1033's explicit user decision; rationale (reach rk ⇒ shell via terminal relay) unchanged | S:95 R:70 A:90 D:90 |
| 4 | Certain | Remove #1033's same-port wrapper (`forward_proxy.go` + test, `serve.go` wiring), the `forwardProxy` health field, the desktop's https raw-port arm (`isTailnetHostname`), and the CONNECT probe | Discussed — user item 4 | S:95 R:70 A:90 D:90 |
| 5 | Confident | Endpoint path is `GET /ws/tunnel?target=host:port`, not the user-named `/api/tunnel` | Orchestrator confirmed 2026-09-25; chosen from rk convention (all sockets under `/ws/*`), the Vite dev proxy upgrading only `/ws`, and path-scoped front-end WS configs — the change's own premise; cheap to rename before ship | S:65 R:80 A:80 D:70 |
| 6 | Certain | Remove Principle IX's second exception (no exception needed — a WebSocket upgrade is a GET); restore "One documented exception:" wording; version 1.13.0 → 1.14.0, Last Amended 2026-09-25 | Discussed — user item 4 specified the minor bump and date | S:95 R:85 A:90 D:90 |
| 7 | Certain | Tunnel upgrader accepts ONLY requests with no `Origin` header (rk's own origin rejected too); fallback, only if the Node client cannot omit it, is a fixed non-browser value set by main | Discussed — user: "strictest acceptable policy is preferred"; the tunnel's sole client is the Electron main process; also immune to DNS rebinding | S:85 R:75 A:85 D:80 |
| 8 | Certain | Scope: tighten EVERY shared WebSocket upgrader (`/ws/state`, `/ws/terminals`, `/ws/gui/{id}` — every `websocket.Upgrader` in `app/backend`) so cross-site pages cannot open rk's sockets; the policy itself is Assumption 22's Fetch-Metadata-first rule | Discussed — the user explicitly approved pulling the existing upgraders' `CheckOrigin` tightening into this change ("yes, proceed" to the proposal naming it); policy details live in row 22 | S:90 R:70 A:85 D:85 |
| 9 | Certain | Keep from #1033 unchanged: per-host partitions, `direct`/`proxy`/`legacy` derivation + local-host ordering (incl. win32 guard), `web.mode()` bridge, `toNativeSrc` literal-URL loading, iframe `/proxy/{port}`, `<-loopback>` bypass rule | Discussed — user item 6 | S:95 R:80 A:90 D:90 |
| 10 | Certain | One WebSocket per proxied connection; multiplexing (yamux or similar) deferred unless measurement demands it | Discussed — user item 7 | S:90 R:75 A:85 D:85 |
| 11 | Certain | Server dial via `net.Dialer` with a named timeout constant (10 s), `DialContext` on the request context; no subprocess; no state beyond live connections | Discussed constraint + Constitution I/II + code-quality named constants | S:90 R:85 A:90 D:85 |
| 12 | Certain | No new settings surface (Principle IV); no toggle; `legacy` remains the automatic fallback | Discussed constraint | S:90 R:80 A:90 D:85 |
| 13 | Confident | Dial BEFORE upgrade: Origin 403 → target 400 → dial 502 → upgrade; a completed handshake means "connected", so the local proxy answers CONNECT `200` on open and `502` on handshake failure | User left "HTTP error before upgrade or close code" to the plan; dial-first needs no in-band signal and the WHATWG client cannot read a failed handshake's status anyway (both paths map to 502 for Chromium) | S:65 R:85 A:80 D:65 |
| 14 | Confident | Byte pipe mirrors `gui_ws.go`'s WS↔TCP relay: Background-rooted lifecycle, single pump writer, binary frames, `SetReadLimit`, per-write deadline, close-driven teardown of both conns, pump joined; no idle cap; WS has no half-close so upstream FIN ends the tunnel | Codebase precedent (`handleGuiWS`) solves the identical shape; user required close-driven cleanup with no short deadline | S:70 R:80 A:85 D:75 |
| 15 | Confident | Server sends periodic WS ping frames on the tunnel (named constant, ~30 s) so front-end idle timeouts (nginx 60 s, Cloudflare ~100 s) do not sever idle HMR sockets | Follows from the "works behind any front end" goal + long-lived-connection requirement; gorilla `WriteControl` is concurrency-safe; undici auto-pongs | S:50 R:85 A:80 D:70 |
| 16 | Confident | Capability signal: `/api/health` `tunnel` field = rk listen port; probe opens `/ws/tunnel?target=127.0.0.1:<port>`, sends `GET /api/health` through it, requires `HTTP/1.1 200` within 5 s; absent field ⇒ `legacy` without probing; renamed field keeps version skew safe both ways | User: "replace with a tunnel capability signal if one is needed" and "e.g. a tunnel to the rk host's own listen address, or a dedicated probe" — the port is needed for the self-tunnel target; plan may choose another shape | S:65 R:80 A:70 D:55 |
| 17 | Confident | One local proxy listener per host on `127.0.0.1:0`, started lazily in `ensureHostProxy`, reused while the host URL is unchanged, closed on host removal / URL change / quit | User left per-host vs shared to the plan; per-host needs no request routing and maps 1:1 onto the per-host session + cache already in `main.ts` | S:55 R:85 A:80 D:60 |
| 18 | Confident | Local proxy = Node `http.createServer` (`'request'` for absolute-form, `'connect'` for CONNECT); absolute-form tunnels pooled per target (keep-alive `http.Agent` whose `createConnection` returns a WebSocket-backed Duplex with net.Socket no-op shims); origin-form requests rejected 400 | Chromium reuses one proxy connection across origins, so per-request parsing is mandatory; pooling avoids a front-end WS handshake per module request; the exact adapter is the plan's call | S:50 R:80 A:70 D:50 |
| 19 | Confident | WebSocket client = Node 22+ global `WebSocket` (no new dependency); plan verifies what Origin undici sends and adds send-side flow control via `bufferedAmount`; `ws` package only if receive-side buffering proves a problem, justified and packaged | User: "check what's already a dependency… Node 22+'s global WebSocket may suffice"; `app/desktop` has zero runtime deps; WHATWG WebSocket lacks receive backpressure | S:65 R:75 A:65 D:60 |
| 20 | Confident | The local listener's exposure (any local process on the viewer machine can use it) is accepted: it matches the loopback-bound SSH `-L` tunnel end that already exposes the remote rk locally; browser pages cannot use it (origin-form only → 400) | Follows from #1033's no-destination-policy reasoning + `tunnel.go` precedent | S:45 R:80 A:75 D:70 |
| 21 | Confident | New desktop e2e: a spec-owned origin-form reverse proxy (passes WS upgrades, 404s CONNECT/absolute-form like Tailscale Serve) in front of the e2e rig, registered as a non-`direct` host; asserts a literal `localhost:<stubPort>` page and a cross-port `fetch` resolve on the rig side. Keep `web-proxy.spec.ts`; touch `web-native.spec.ts` only as needed | User item 8 asked for exactly this check "in the spirit of works behind Tailscale Serve/nginx"; how the fixture makes the host non-local is the plan's call | S:80 R:80 A:65 D:55 |
| 22 | Confident | Shared-upgrader Origin policy is Fetch-Metadata-first: allow when `Sec-Fetch-Site` is `same-origin`; reject `cross-site`/`same-site`; when `Sec-Fetch-Site` is absent, allow a missing `Origin` (non-browser clients) and otherwise fall back to the `Origin` host == `X-Forwarded-Host` (else `Host`) match. `Sec-Fetch-Site` is computed by the browser against the URL IT connected to, so Host-rewriting front ends (nginx default, Tailscale Serve, LBs) cannot break the SPA's own sockets, and no front-end header requirements need documenting. The tunnel keeps its stricter no-Origin rule (a `Sec-Fetch-Site` header of any value is a browser → reject) | Orchestrator decision 2026-09-25 resolving the deferred compat-vs-strictness row: Fetch Metadata headers are sent on WebSocket handshakes by Chromium, Firefox and Safari 16.4+, which covers every browser rk supports incl. the Electron host view; it satisfies the user's intent (block cross-site pages) without the Host-rewrite breakage; reversible | S:70 R:70 A:70 D:65 |
| 23 | Confident | CORS stays `AllowedOrigins: ["*"]` in this change (the WS tightening is defense-in-depth, since cross-site pages can already call `/api/*`); tightening CORS is a separate follow-up | Orchestrator decision 2026-09-25: keep scope to the tunnel + socket Origin policy the user approved; the CORS gap is recorded for a follow-up change and surfaced to the user at the end of the run | S:60 R:75 A:65 D:60 |
| 24 | Confident | DNS rebinding is recorded as a known limitation of the shared upgrader's Host-match rule (the tunnel is immune via the no-Origin rule); no bind-derived allowlist is added for the shared sockets in this change | The user specified Host/X-Forwarded-Host matching; residual exposure equals the rest of the HTTP API under CORS `*`; the MCP allowlist exists as a precedent if the user wants it later | S:60 R:75 A:70 D:65 |

24 assumptions (11 certain, 13 confident, 0 tentative, 0 unresolved).
