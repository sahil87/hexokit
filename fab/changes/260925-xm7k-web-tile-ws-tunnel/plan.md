# Plan: Web-Tile Tunnel over WebSocket (Remote-Native Mode Behind Any Front End)

**Change**: 260925-xm7k-web-tile-ws-tunnel
**Intake**: `intake.md`

## Requirements

### Backend: WebSocket Tunnel Endpoint

#### R1: `GET /ws/tunnel?target=host:port` endpoint with dial-before-upgrade
A new GET WebSocket endpoint MUST be registered in the chi router beside the other `/ws/*` routes, handled by `app/backend/api/tunnel_ws.go` with its OWN dedicated upgrader. Every rejection MUST happen BEFORE the upgrade as a plain HTTP error in the project's `{ "error": "..." }` shape, in this exact order: (1) Origin policy (R5) → `403`; (2) `target` parses via `net.SplitHostPort` with a non-empty host and a numeric port in 1–65535 → `400`; (3) dial `target` with `net.Dialer{Timeout: tunnelDialTimeout}` (named constant, 10 s) via `DialContext` on the request context — hostnames resolve on the rk host → `502`; (4) upgrade. Dial-before-upgrade means a completed handshake signals "connected", so the desktop answers Chromium's CONNECT with `200` on open and `502` on handshake failure with no in-band signalling.

- **GIVEN** a request `GET /ws/tunnel?target=127.0.0.1:9` from an Origin-less client
- **WHEN** port 9 refuses the connection
- **THEN** the response is `502` and no WebSocket handshake completes
- **AND** a request with a malformed `target` gets `400`, one carrying an `Origin` or `Sec-Fetch-Site` header gets `403`

#### R2: Byte pipe and close-driven cleanup
The established tunnel MUST pipe binary frames both ways, modeled on `handleGuiWS` (`app/backend/api/gui_ws.go`): a `context.Background()`-rooted lifecycle (some servers cancel `r.Context()` at upgrade), a TCP→WS pump goroutine that is the ONLY WebSocket writer, a WS→TCP read loop in the handler, `SetReadLimit` bounding one inbound message (memory-DoS, the `guiReadLimit` rationale), a per-write `SetWriteDeadline`, and the short-read-deadline teardown idiom. TCP→WS MUST read in named-constant chunks (64 KiB, the `guiBackendReadChunk` precedent) and write each chunk as one binary message; upstream EOF MUST send a normal close frame before teardown. WS→TCP MUST write binary messages verbatim and ignore text frames (forward-compat). Cleanup MUST be close-driven and leak-free: either side ending closes BOTH the TCP conn and the WebSocket, and the handler waits for the pump goroutine — no goroutine or socket outlives the handler. No short deadline and no idle cap on an established tunnel (HMR WebSockets and long-polls are long-lived; WS has no half-close, so an upstream FIN ends the tunnel — acceptable for HTTP/1.1 and WebSocket traffic).

- **GIVEN** an established tunnel to a live upstream
- **WHEN** bytes flow in both directions (including a WebSocket upgrade echo inside the tunnel)
- **THEN** they are relayed verbatim in both directions
- **AND** when either side closes, both connections close, the pump exits, and the handler returns

#### R3: Ping keepalive on the tunnel
The server SHOULD send periodic WS ping control frames on an established tunnel (named constant `tunnelPingInterval`, 30 s — gorilla's `WriteControl` is safe concurrently with the pump writer, synchronized through the pump or a write mutex) so front-end idle timeouts (nginx `proxy_read_timeout` 60 s default, Cloudflare ~100 s) do not sever an idle HMR socket inside the tunnel. The Node/undici client answers pings automatically.

- **GIVEN** an established but byte-quiet tunnel
- **WHEN** `tunnelPingInterval` elapses
- **THEN** the client observes a ping frame and the tunnel survives past a 60 s front-end idle timeout

#### R4: No destination policy; stateless; no subprocess
The tunnel SHALL dial ANY destination — loopback, LAN, internet — with no allowlist or blocklist (#1033's decision, unchanged: anyone who can reach rk already has a shell through the terminal relay). It MUST spawn no subprocess (net dialing only, Constitution I) and hold no state beyond live connections (Constitution II).

- **GIVEN** a `target` naming any routable destination
- **WHEN** the handler dials
- **THEN** it dials without consulting any policy list

### Backend: WebSocket Origin Policy

#### R5: Tunnel upgrader — strictest policy
The tunnel's dedicated upgrader MUST accept ONLY requests carrying NO `Origin` header AND NO `Sec-Fetch-Site` header. The tunnel's sole client is the Electron main process (a non-browser client — verified 2026-09-25: Node's global `WebSocket`/undici sends neither header); every browser WebSocket carries an `Origin` it cannot suppress, so this rejects all browser pages — cross-site, same-site, and DNS-rebinding alike. rk's own origin is NOT accepted (the SPA never opens the tunnel).

- **GIVEN** a tunnel request with `Origin: http://127.0.0.1:3000` (rk's own origin)
- **WHEN** the upgrader checks it
- **THEN** the upgrade is refused with `403`

#### R6: Shared upgrader — Fetch-Metadata-first same-origin policy
The shared `upgrader` (`app/backend/api/state_ws.go`, used by `/ws/state`, `/ws/terminals`, `/ws/gui/{id}`) MUST replace `return true` with: `Sec-Fetch-Site: same-origin` → allow; `Sec-Fetch-Site: cross-site`/`same-site` (or any other present value) → reject; `Sec-Fetch-Site` absent → fall through: `Origin` absent → allow (non-browser clients, tests); otherwise parse `Origin` and allow when its host[:port] equals (case-insensitive, default ports 80/443 normalized) the FIRST `X-Forwarded-Host` value when present, else the request's `Host`; scheme is NOT compared (a TLS front end terminates TLS, so `Origin: https://…` meets a plain-http hop); anything else (including a malformed `Origin`) → reject (gorilla answers `403`). The policy helper MUST live in its own file (`app/backend/api/ws_origin.go`) so the tunnel upgrader's predicate sits beside it.

- **GIVEN** a browser WebSocket handshake with `Sec-Fetch-Site: same-origin` whose `Origin` host does NOT match the rewritten `Host` (nginx default / Tailscale Serve)
- **WHEN** the shared upgrader checks it
- **THEN** the upgrade is allowed
- **AND** a handshake with `Sec-Fetch-Site: cross-site` and a matching `Origin`/`Host` pair is rejected

### Backend: Forward-Proxy Removal & Health Field

#### R7: Remove #1033's forward-proxy transport; `forwardProxy` → `tunnel`
`app/backend/api/forward_proxy.go` and `app/backend/api/forward_proxy_test.go` MUST be deleted. `app/backend/cmd/rk/serve.go` MUST wire `Handler: router` directly (dropping the wrapper comment). `GET /api/health` (`app/backend/api/health.go`) MUST drop the `forwardProxy` field (and its doc-comment text) and instead carry a `tunnel` field holding the daemon's listen port (JSON number, derived per request from config per Constitution II, always present on this build — its absence marks an older server). Renaming keeps version skew safe in both directions: a #1033-era desktop against this server sees no `forwardProxy` → `legacy`; this desktop against a #1033-era server sees no `tunnel` → `legacy`.

- **GIVEN** a daemon running this build on port 3001
- **WHEN** a client GETs `/api/health`
- **THEN** the body carries `"tunnel": 3001` and no `forwardProxy` key
- **AND** a `CONNECT host:port` request to the listen port is answered by the chi router (405/404-class), never hijacked

### Governance: Constitution Amendment

#### R8: Principle IX back to one exception; version 1.14.0
`fab/project/constitution.md` Principle IX MUST lose its second exception (the HTTP forward-proxy transport paragraph) and restore the pre-1.13.0 single-exception wording: "Two documented exceptions." + numbered list → "One documented exception:" followed by the `/mcp` paragraph (unnumbered, as before 1.13.0). No new exception is added — the tunnel is a `GET` WebSocket upgrade, ordinary under Principle IX. The governance line MUST read `**Version**: 1.14.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-25`.

- **GIVEN** the amended constitution
- **WHEN** a reviewer reads Principle IX
- **THEN** exactly one exception is documented (`/mcp`) and the version is 1.14.0, Last Amended 2026-09-25

### Desktop: Local Proxy & Tunnel Client

#### R9: Per-host loopback HTTP proxy in the main process
The Electron main process MUST run one local HTTP proxy listener per proxy-mode host, bound to `127.0.0.1:0` (ephemeral port) and started lazily in `ensureHostProxy` when a host settles to `proxy` mode. The listener MUST be implemented with Node `http.createServer()` — the `'request'` event handles absolute-form, the `'connect'` event handles CONNECT — because Chromium reuses a keep-alive proxy connection across origins, so per-request parsing is mandatory. Behaviors: (a) `CONNECT host:port` → open a tunnel WebSocket for `target=host:port`; on `open` write `HTTP/1.1 200 Connection Established\r\n\r\n`, flush any bytes buffered after the CONNECT head into the tunnel, then pipe both ways; on handshake failure write `HTTP/1.1 502 Bad Gateway` and close; (b) absolute-form `GET http://host:port/path` → forward over a tunnel to `host:port`, rewriting the request to origin-form (`GET /path HTTP/1.1`) with hop-by-hop and proxy-only headers stripped (`Proxy-Connection`, `Proxy-Authorization`, `Connection` + `Connection`-listed headers, `Keep-Alive`, `TE`, `Trailer`, `Upgrade` — `Transfer-Encoding` framing preserved correctly), `Host` set from the absolute URL, and the response streamed back verbatim; tunnels for absolute-form traffic SHOULD be pooled per `host:port` (a keep-alive `http.Agent` per target whose `createConnection` returns a WebSocket-backed `Duplex` with no-op net.Socket shims — `setKeepAlive`/`setNoDelay`/`setTimeout`/`ref`/`unref`) so a Vite dev app's hundreds of module requests do not each pay a front-end WS handshake; (c) an origin-form (non-proxy-shaped) request MUST be rejected `400` — this keeps the loopback listener useless cross-site and against DNS rebinding. Listeners MUST be closed when the host is removed or its URL changes, and on app quit.

- **GIVEN** a proxy-mode host and Chromium's `CONNECT localhost:6000` to the host's listener
- **WHEN** the tunnel WebSocket opens
- **THEN** the Chromium socket gets `200 Connection Established` and bytes pipe both ways through `/ws/tunnel`
- **AND** a browser page's origin-form `GET /x` to the listener port gets `400`

#### R10: WebSocket tunnel client
The tunnel client MUST use Node 22+'s global `WebSocket` (undici) — no new runtime dependency. The URL is the host origin with `http:`→`ws:`, `https:`→`wss:`, path `/ws/tunnel`, query `target=<host>:<port>` URL-encoded (IPv6 hosts bracketed); an SSH host's origin is the viewer-side tunnel origin `http://127.0.0.1:<L>` (the existing `-L` forward carries it — no new forward). The socket MUST use binary frames with `binaryType = "arraybuffer"`; writes MUST be chunked below the server's read limit (≤ 64 KiB per message). Send-side flow control MUST pause the Chromium-side read when `bufferedAmount` exceeds a named high-water mark. (Receive-side buffering is the WHATWG API's known gap; adding the `ws` package is acceptable only if receive-side buffering proves a problem, justified and packaged.)

- **GIVEN** the desktop main process
- **WHEN** it opens the tunnel WebSocket
- **THEN** the handshake carries no `Origin` and no `Sec-Fetch-Site` header (verified against undici on Node 24)
- **AND** a large write is split into sub-read-limit binary messages

#### R11: `setProxy` targets the local listener; raw-port arm removed
`app/desktop/src/web-proxy.ts` MUST keep `guestPartitionName`, `webProxyModeFor` (remote-field-first ordering incl. the win32 loopback guard), and `setProxyConfigFor` (`fixed_servers` + `proxyBypassRules: "<-loopback>"`) unchanged, while `proxyRulesFor` collapses to producing `http://127.0.0.1:<localPort>` from the host's local listener port. `isTailnetHostname` and the `https:` raw-port arm MUST be removed — an `https:` origin needs no special case (`wss://` just works through the TLS front end). Each proxy-mode host's guest session MUST get `{ mode: "fixed_servers", proxyRules: "http://127.0.0.1:<localPort>", proxyBypassRules: "<-loopback>" }`, applied (awaited) BEFORE the first guest `loadURL`.

- **GIVEN** a Tailscale-Serve host `https://x.ts.net` whose tunnel probe passed
- **WHEN** the proxy config is computed
- **THEN** `proxyRules` points at the host's loopback listener, with no tailnet or raw-port special case

#### R12: Capability probe = tunnel round-trip
`probeForwardProxy` + `connectProbe` (`app/desktop/src/main.ts`) MUST be replaced by a tunnel probe: (1) `GET <origin>/api/health` → 200 with a numeric `tunnel` field (absent ⇒ older server ⇒ `legacy`, no probe); (2) open `<ws-origin>/ws/tunnel?target=127.0.0.1:<tunnel port>` (the rk host's own listen port — listening on every rk host), write `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:<port>\r\nConnection: close\r\n\r\n`, and require an `HTTP/1.1 200` status line within `PROXY_PROBE_TIMEOUT_MS` (5 s, existing constant). Any failure — timeout, handshake refused, non-200 — ⇒ `legacy`. The result MUST be cached per (host id, url) exactly as `hostProxyStates`/`hostProxyPending` do today and re-run on URL change / SSH heal.

- **GIVEN** a remote host behind an origin-form front end that 404s CONNECT but passes WebSocket upgrades
- **WHEN** the probe runs
- **THEN** it succeeds (the tunnel round-trips `/api/health`) and the mode is `proxy`
- **AND** against a #1033-era server (no `tunnel` field) the probe is skipped and the mode is `legacy`

#### R13: #1033 keep-set stays byte-stable
Per-host partitions, mode derivation (remote-field-first ordering, `localOrigin === null && platform !== "win32" && isLoopbackOrigin` guard), `ensureHostProxy`'s settle-before-first-`loadURL` contract and pending/stale-completion handling, the `web:mode` IPC + `runkitShell.web.mode()` bridge, the frontend's `toNativeSrc` literal-URL loading, and the iframe engine's `/proxy/{port}` MUST remain functionally unchanged. The local listener adds no exposure beyond the loopback-bound SSH `-L` tunnel end: it binds `127.0.0.1` only and rejects origin-form requests with `400`, so browser pages cannot use it.

- **GIVEN** the finished change
- **WHEN** an SSH host heals or a host's URL changes
- **THEN** the proxy state re-derives lazily on the next ensure exactly as before, with the listener torn down and recreated

### Tests

#### R14: Go tests — tunnel, Origin policy matrix, health
`app/backend/api/tunnel_ws_test.go` MUST cover: bytes both ways through a live upstream (including a WebSocket upgrade echo INSIDE the tunnel — the HMR case), `400` on a bad target, `502` on dial failure before upgrade, `403` when any `Origin` or `Sec-Fetch-Site` is present, close-driven cleanup from either side (both conns closed, no leaked goroutines), no deadline cutting a quiet tunnel, and the ping keepalive (a ping observed within a shrunk test interval, if the interval is test-adjustable). `app/backend/api/ws_origin_test.go` MUST cover the shared-upgrader matrix: absent Origin (allowed), same-origin Origin vs `Host` (allowed), `X-Forwarded-Host` match (allowed), `Sec-Fetch-Site: same-origin` with a mismatched `Host` (allowed), `Sec-Fetch-Site: cross-site`/`same-site` (rejected), cross-site Origin (rejected), default-port normalization, malformed Origin (rejected). `health_test.go` MUST cover the `tunnel` field and the absence of `forwardProxy`. Gate: `env -u TMUX -u TMUX_PANE just test-backend`.

- **GIVEN** the new tests
- **WHEN** `just test-backend` runs
- **THEN** every case above passes and no forward-proxy test remains

#### R15: Desktop unit tests
`app/desktop/src/tunnel-proxy.test.ts` (node --test over compiled output, the package convention) MUST cover the pure helpers: CONNECT authority parsing/validation, absolute-form → origin-form request-line rewrite, hop-by-hop header stripping, and tunnel URL construction (`http`→`ws`, `https`→`wss`, SSH tunnel origin, IPv6 bracketing, target encoding). `web-proxy.test.ts` MUST be updated for the collapsed `proxyRulesFor` and the removed tailnet/raw-port arm. An integration test of the local proxy against a stub tunnel server is covered by the e2e fixture (R16) — Node has no built-in WebSocket server and a hand-rolled one in unit tests is not worth the frame codec.

- **GIVEN** the desktop package
- **WHEN** `pnpm run compile && pnpm test` runs in `app/desktop`
- **THEN** the pure-helper matrix passes and no test references `isTailnetHostname`

#### R16: Desktop e2e — remote tile behind an origin-form reverse proxy
A new desktop e2e spec (`app/desktop/tests/e2e/web-tunnel.spec.ts`) MUST put a spec-owned Node origin-form reverse proxy in front of the e2e rig — one that passes WebSocket upgrades but answers CONNECT and absolute-form requests with 404 (Tailscale Serve's behavior) — register that front end as a host that derives non-`direct` (a hosts.json entry whose URL is the reverse proxy's origin, marked remote via a `remote` field — and the fixture MUST keep the SSH heal/interstitial flow out of the way), and assert: the host derives `proxy` mode, a web tab stamped `localhost:<stubPort>` loads the literal `http://localhost:<stubPort>/` page served on the RIG side, and a JS `fetch` from that guest page to a second loopback port also resolves on the rig side. `web-proxy.spec.ts` (the `<-loopback>` verification) MUST keep passing unchanged; `web-native.spec.ts` is touched only as needed (its e2e hosts are the lane's local daemon → `direct`). Every new/modified `test()` MUST carry the Proves/Steps JSDoc and the file header per the constitution's Test Intent Comments rule.

- **GIVEN** the e2e rig behind the spec-owned reverse proxy
- **WHEN** `env -u DISPLAY just test-desktop-e2e web-tunnel` runs
- **THEN** the guest's literal-localhost load and cross-port fetch both resolve on the rig side through the tunnel

### Specs

#### R17: `docs/specs/api.md` — § Tunnel replaces § Forward Proxy
`docs/specs/api.md` MUST replace § Forward Proxy (lines ~574-640) with **§ Tunnel**: the endpoint and query contract, the handler order + status codes, dial-before-upgrade, byte-pipe and close semantics, ping keepalive, read limit, the no-destination-policy rationale, and statelessness — plus the **WebSocket Origin policy** (tunnel: no `Origin` and no `Sec-Fetch-Site`; shared upgrader: `Sec-Fetch-Site` first, then same-origin incl. `X-Forwarded-Host`, with the DNS-rebinding and CORS-allow-all known limitations). § Health MUST say `tunnel` instead of `forwardProxy`; Design Principles item 1 MUST return to one exception (`/mcp`); the Route Summary MUST add `GET /ws/tunnel` and drop the forward-proxy "transport, no row" note.

- **GIVEN** the updated spec
- **WHEN** a reader looks for the proxy contract
- **THEN** § Tunnel specifies it and no forward-proxy section remains

#### R18: `docs/specs/window-views.md` § Engines
`docs/specs/window-views.md` § Engines (~line 118) MUST state that `proxy` mode routes via the desktop-local loopback proxy + WebSocket tunnel (referencing `api.md` § Tunnel), working behind any front end that passes WebSockets, dropping the raw-port/tailnet wording.

- **GIVEN** the updated spec
- **WHEN** a reader checks `proxy` mode's mechanics
- **THEN** the local-proxy + tunnel shape is specified

### Non-Goals

- Multiplexing proxied connections over one WebSocket (yamux or similar) — deferred unless measurement demands it.
- CORS tightening (`AllowedOrigins: ["*"]` stays) — defense-in-depth is the WS upgrader; a separate follow-up change.
- A bind-derived DNS-rebinding allowlist for the shared sockets — recorded as a known limitation; the tunnel is immune by its no-Origin rule.
- A destination allowlist/blocklist on the tunnel — rejected as security theater (#1033's decision, unchanged).
- Frontend changes — mode strings and `toNativeSrc` are unchanged; the SPA's own sockets are covered by the Origin tightening regression gates.
- `docs/memory/` updates — the hydrate stage's job.
- A hand-rolled WebSocket server for desktop unit tests — the e2e fixture owns the integration proof.

### Design Decisions

#### WebSocket tunnel over the same-port forward proxy
**Decision**: each proxied guest connection rides a WebSocket to `GET /ws/tunnel?target=host:port`; a desktop-local loopback proxy terminates Chromium's CONNECT/absolute-form protocol and the server just dials TCP and pipes bytes.
**Why**: WebSockets traverse every front end rk already works behind (the terminal relay and state socket depend on them), while CONNECT/absolute-form request shapes die at origin-form reverse proxies (Tailscale Serve answers CONNECT with its own 404 — verified).
**Rejected**: keeping #1033's same-port CONNECT/absolute-form wrapper (dead behind every origin-form front end, plus a constitution exception that buys nothing there); requiring front-end CONNECT passthrough (Tailscale Serve / Cloudflare Tunnel have no such option); SOCKS5 via `ssh -D` (SSH-only, rejected in #1033).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

#### Tunnel upgrader admits only Origin-less, Sec-Fetch-Site-less clients
**Decision**: `/ws/tunnel` upgrades only requests carrying neither `Origin` nor `Sec-Fetch-Site`; rk's own origin is rejected too.
**Why**: the sole client is the Electron main process (verified: Node's global `WebSocket` sends neither header); every browser WebSocket carries an unsuppressable `Origin`, so this rejects all browser pages and is immune to DNS rebinding — the strictest acceptable policy.
**Rejected**: a fixed non-browser Origin value set via undici's `headers` option (unnecessary — undici sends none); a Host-match rule (rebinding-vulnerable and would admit same-origin browser pages).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

#### Fetch-Metadata-first shared-upgrader Origin policy
**Decision**: the shared upgrader allows `Sec-Fetch-Site: same-origin`, rejects any other present value, and only when the header is absent falls back to `Origin` host == first `X-Forwarded-Host` (else `Host`), scheme-insensitive with default ports normalized; a missing `Origin` (non-browser clients) is allowed.
**Why**: the browser computes `Sec-Fetch-Site` against the URL IT connected to, so Host-rewriting front ends (nginx default, Tailscale Serve, load balancers) cannot break the SPA's own sockets — the failure mode a pure Host-match check would have shipped.
**Rejected**: Origin-vs-Host only (breaks behind Host-rewriting front ends); a bind-derived allowlist like the MCP transport (heavier; residual Host-match exposure equals the rest of the CORS-`*` HTTP API — recorded as a known limitation).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

#### Dial before upgrade
**Decision**: the tunnel handler validates the policy, parses `target`, and dials BEFORE upgrading; a completed handshake means "connected".
**Why**: the desktop maps handshake open/failure directly onto Chromium's `200 Connection Established` / `502 Bad Gateway` with no in-band signalling, and the WHATWG WebSocket client cannot read a failed handshake's status anyway.
**Rejected**: upgrade-then-close with a private close code such as 4502 (needs in-band signalling the WHATWG client cannot surface usefully).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

#### Per-host loopback proxy listener in the main process
**Decision**: one `http.createServer` listener per proxy-mode host on `127.0.0.1:0` — `'connect'` handles CONNECT, `'request'` handles absolute-form with per-target pooled keep-alive agents over WebSocket-backed Duplex sockets; origin-form requests get `400`.
**Why**: the listener's identity IS the host (no per-request routing or proxy-auth trick); Chromium reuses a keep-alive proxy connection across origins, so per-request parsing is mandatory; pooling avoids one front-end WebSocket handshake per module request of a Vite dev app; the loopback bind plus the origin-form 400 matches the exposure of the SSH `-L` tunnel's local end and keeps the listener useless to browser pages.
**Rejected**: one shared listener routing per host (needs request routing/proxy-auth); blind byte-piping after the first request (breaks on cross-origin keep-alive reuse).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

#### One WebSocket per proxied connection
**Decision**: each CONNECT and each pooled agent connection is its own tunnel WebSocket; no multiplexing.
**Why**: simplest correct shape; gorilla and undici both handle many concurrent sockets; measurement has not demanded yamux.
**Rejected**: yamux-style multiplexing (deferred unless measurement demands it).
*Introduced by*: 260925-xm7k-web-tile-ws-tunnel

### Deprecated Requirements

#### Same-port HTTP forward-proxy transport (#1033 R1–R4)
**Reason**: origin-form reverse proxies (Tailscale Serve, nginx, Caddy, Cloudflare Tunnel, load balancers) reject or rewrite CONNECT/absolute-form request shapes, so the transport works only with a raw TCP path to rk's listen port.
**Migration**: `GET /ws/tunnel?target=host:port` (R1–R4) plus the desktop-local proxy (R9–R11).

#### `forwardProxy` health field (#1033 R5)
**Reason**: renamed so version skew degrades to `legacy` in both directions.
**Migration**: the `tunnel` field (R7) + the tunnel round-trip probe (R12).

#### TLS-fronted raw-port proxy target (#1033's `https:` arm)
**Reason**: fails whenever rk binds loopback behind the front end — the recommended deployment.
**Migration**: `wss://` through the TLS front end (R10/R11).

## Tasks

### Phase 1: Backend — tunnel endpoint & Origin policy

- [x] T001 New `app/backend/api/ws_origin.go`: `checkSharedWSOrigin(r *http.Request) bool` (Sec-Fetch-Site first: `same-origin` allow, any other present value reject; absent → `Origin` absent allow, else `Origin` host[:port] vs first `X-Forwarded-Host` else `Host`, case-insensitive, default ports 80/443 normalized, scheme not compared, malformed Origin rejected) and `checkTunnelWSOrigin(r)` (true iff NO `Origin` AND NO `Sec-Fetch-Site` header); point the shared `upgrader.CheckOrigin` in `app/backend/api/state_ws.go` at `checkSharedWSOrigin`. <!-- R5 R6 -->
- [x] T002 New `app/backend/api/tunnel_ws.go`: `handleTunnelWS` — handler order policy 403 → `net.SplitHostPort` target parse with non-empty host and numeric port 1–65535 → 400, dial via `net.Dialer{Timeout: tunnelDialTimeout = 10s}` `DialContext` on the request context → 502, then upgrade via a dedicated `tunnelUpgrader` (`CheckOrigin: checkTunnelWSOrigin`); byte pipe per `gui_ws.go` (Background-rooted ctx, TCP→WS pump the ONLY writer, 64 KiB `tunnelReadChunk`, `SetReadLimit(tunnelReadLimit = 1 MiB)`, per-write deadline, short-read-deadline teardown idiom, upstream EOF → normal close frame, text frames ignored, both conns closed + pump joined before return, no idle cap); ping keepalive `tunnelPingInterval = 30s` via `WriteControl` serialized with the pump writer; register `r.Get("/ws/tunnel", s.handleTunnelWS)` in `app/backend/api/router.go` beside `/ws/gui/{id}`. No destination policy, no subprocess, no state. <!-- R1 R2 R3 R4 -->
- [x] T003 Remove the forward proxy: delete `app/backend/api/forward_proxy.go` and `app/backend/api/forward_proxy_test.go`; `app/backend/cmd/rk/serve.go` (~line 337-345) `Handler: api.ForwardProxy(router)` → `Handler: router` with the wrapper comment dropped; `app/backend/api/health.go` — replace the `forwardProxy` field and its doc text with `tunnel` (the daemon's listen port, JSON number, config-derived per request). <!-- R7 -->
- [x] T004 Go tests: new `app/backend/api/tunnel_ws_test.go` (live-upstream bytes both ways incl. a WebSocket upgrade echo INSIDE the tunnel, 400 bad target, 502 dial failure pre-upgrade, 403 on any Origin/Sec-Fetch-Site, close-driven cleanup from either side with no leaked goroutines, a quiet tunnel not cut by any deadline, ping observed within a test-shrunk interval); new `app/backend/api/ws_origin_test.go` (the full shared + tunnel policy matrix of R5/R6); update `app/backend/api/health_test.go` (`tunnel` field present and numeric, `forwardProxy` absent). Run `env -u TMUX -u TMUX_PANE just test-backend`. <!-- R5 R6 R7 R14 -->

### Phase 2: Desktop — local proxy & tunnel client

- [x] T005 New electron-free module `app/desktop/src/tunnel-proxy.ts` + `tunnel-proxy.test.ts`: `tunnelWsUrl(origin, target)` (http→ws/https→wss, `/ws/tunnel`, URL-encoded target, IPv6 bracketed); CONNECT authority parse/validate; absolute-form → origin-form request-line rewrite + hop-by-hop/proxy-only header stripping; a WebSocket-backed `Duplex` adapter (binary arraybuffer frames, ≤64 KiB write chunks, `bufferedAmount` high-water-mark send-side backpressure, no-op `setKeepAlive`/`setNoDelay`/`setTimeout`/`ref`/`unref` shims); `createLocalProxy(hostOrigin)` returning `{ port, close }` over `http.createServer` — `'connect'` → tunnel + `200 Connection Established` / `502`, `'request'` absolute-form → per-target pooled keep-alive `http.Agent` whose `createConnection` returns the adapter, origin-form → `400`. Unit-test every pure helper. <!-- R9 R10 -->
- [x] T006 `app/desktop/src/web-proxy.ts`: collapse `proxyRulesFor` to the local listener (`proxyRulesFor(localPort)` → `http://127.0.0.1:<port>`); remove `isTailnetHostname` and the `https:` raw-port arm; keep `guestPartitionName`, `webProxyModeFor`, `setProxyConfigFor` unchanged; update `app/desktop/src/web-proxy.test.ts`. <!-- R11 -->
- [x] T007 `app/desktop/src/main.ts`: replace `probeForwardProxy` + `connectProbe` with the tunnel probe (health `tunnel` field gate, then `/ws/tunnel?target=127.0.0.1:<port>` round-trip sending `GET /api/health` and requiring `HTTP/1.1 200` within `PROXY_PROBE_TIMEOUT_MS`); `ensureHostProxy` starts/reuses the host's local listener (keyed with the cached url), points `setProxy` at it, and closes the listener on host removal, URL change (both `hostProxyStates.delete` sites and the SSH-heal path), and app quit; keep the settle/pending/stale-completion contract unchanged. <!-- R12 R13 -->
- [x] T008 Desktop gates: `cd app/desktop && pnpm run compile && pnpm test` green, covering the R15 matrix. <!-- R15 -->

### Phase 3: Governance & specs

- [x] T009 [P] `fab/project/constitution.md`: remove Principle IX's second exception, restore "One documented exception:" + the unnumbered `/mcp` paragraph, governance line `**Version**: 1.14.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-25`. <!-- R8 -->
- [x] T010 [P] `docs/specs/api.md`: § Forward Proxy → § Tunnel per R17; § Health `forwardProxy` → `tunnel`; Design Principles item 1 back to one exception; Route Summary adds `GET /ws/tunnel` and drops the transport note. <!-- R17 -->
- [x] T011 [P] `docs/specs/window-views.md` § Engines: `proxy` mode rides the desktop-local proxy + WebSocket tunnel behind any WebSocket-passing front end, per R18. <!-- R18 -->

### Phase 4: E2E & regression verification

- [x] T012 New `app/desktop/tests/e2e/web-tunnel.spec.ts` per R16 — spec-owned origin-form reverse proxy (passes WS upgrades, 404s CONNECT/absolute-form) fronting the rig; remote-marked host entry; assert `proxy` mode, literal `http://localhost:<stubPort>/` guest load served rig-side, and a cross-port guest `fetch` resolving rig-side. Full Proves/Steps intent comments + file header. Run singly: `env -u DISPLAY just test-desktop-e2e web-tunnel` (gate on the `N passed` line; ELIFECYCLE after teardown is not a failure). <!-- R16 -->
- [x] T013 Confirm `app/desktop/tests/e2e/web-proxy.spec.ts` still passes unchanged (the `<-loopback>` verification stays load-bearing) and update `web-native.spec.ts` only if the new behavior requires it — run each spec singly through the desktop e2e lane with `env -u DISPLAY`. <!-- R16 -->
- [x] T014 Regression gates under the tightened shared upgrader: `just test-frontend`; a `just dev` smoke check proving the SPA's `/ws/state` + `/ws/terminals` connect through the Vite `ws:true` proxy (Host preserved → same-origin) — e.g. boot `just dev` and run one frontend e2e spec that opens a terminal through the Vite origin; note the outcome for the result file. <!-- R6 R14 -->

## Execution Order

- T001 → T002 (tunnel imports the shared file's predicate) → T004; T003 independent of T001/T002 but must land before T004's health test edits
- T005 blocks T006 and T007; T008 closes Phase 2
- T009–T011 [P] may run alongside Phases 1–2
- T012/T013 need T007 (the probe + local listener in the lane); T014 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `GET /ws/tunnel?target=host:port` exists with the dedicated upgrader and the 403→400→502→upgrade handler order
- [x] A-002 R2: an established tunnel pipes bytes both ways verbatim (a WebSocket upgrade inside the tunnel included) and cleanup is close-driven with no leaked goroutines or sockets
- [x] A-003 R3: the server sends ping frames on a quiet tunnel at the named interval and sets no idle cap
- [x] A-004 R4: no destination policy, no subprocess, and no state beyond live connections anywhere in the tunnel path
- [x] A-005 R5: the tunnel refuses any request carrying `Origin` or `Sec-Fetch-Site` with 403, rk's own origin included
- [x] A-006 R6: the shared upgrader implements the Fetch-Metadata-first policy incl. the `X-Forwarded-Host` fallback and default-port normalization
- [x] A-007 R7: `forward_proxy.go` + its test are deleted, `serve.go` wires `Handler: router`, and `/api/health` carries `tunnel` and not `forwardProxy`
- [x] A-008 R8: constitution.md Principle IX documents exactly one exception (`/mcp`); version 1.14.0, Last Amended 2026-09-25
- [x] A-009 R9: each proxy-mode host has a `127.0.0.1`-bound local proxy handling CONNECT (200/502) and pooled absolute-form forwarding, rejecting origin-form requests with 400, closed on host removal/URL change/quit
- [x] A-010 R10: the tunnel client uses the Node global `WebSocket` with no Origin/Sec-Fetch-Site headers, binary arraybuffer frames, sub-read-limit write chunks, and `bufferedAmount` backpressure — no new runtime dependency
- [x] A-011 R11: `proxyRulesFor` yields the local listener for every proxied host; `isTailnetHostname` and the `https:` raw-port arm are gone; `setProxy` is awaited before the first guest load
- [x] A-012 R12: the probe is a `/ws/tunnel` round-trip gated on the health `tunnel` field; any failure yields `legacy`; results cache per (host id, url)
- [x] A-013 R13: per-host partitions, mode derivation incl. the win32 guard, `web.mode()` bridge, `toNativeSrc`, and iframe `/proxy/{port}` are functionally unchanged
- [x] A-014 R14: Go tests cover the tunnel behaviors, the Origin policy matrix, and the health field; `just test-backend` is green
- [x] A-015 R15: desktop `pnpm run compile && pnpm test` is green with the pure-helper matrix and no `isTailnetHostname` reference
- [x] A-016 R16: the new e2e spec proves a remote tile works behind an origin-form reverse proxy that 404s CONNECT; `web-proxy.spec.ts` still passes
- [x] A-017 R17: `docs/specs/api.md` carries § Tunnel, the Origin policy, the `tunnel` health field, one-exception Design Principles, and the Route Summary row
- [x] A-018 R18: `docs/specs/window-views.md` § Engines describes `proxy` mode as local-proxy + WS tunnel

### Behavioral Correctness

- [x] A-019 R2: a quiet long-lived tunnel (HMR class) is not cut by any fixed deadline — close-driven lifetime only, with pings keeping front ends from severing it
- [x] A-020 R6: the SPA's `/ws/state` and `/ws/terminals` still connect through the `just dev` Vite proxy and behind a Host-rewriting front end (`Sec-Fetch-Site: same-origin` path)

### Removal Verification

- [x] A-021 R7: no `forwardProxy` / `ForwardProxy` / `forward_proxy` reference remains in `app/backend` outside git history; no `isTailnetHostname`/CONNECT-probe reference remains in `app/desktop/src`
- [x] A-022 R8: no Principle IX forward-proxy exception remains anywhere in `fab/project/constitution.md` or `docs/specs/api.md`

### Scenario Coverage

- [x] A-023 R5/R6: Go tests cover both upgraders' accept/reject matrix including `Sec-Fetch-Site: same-origin` with mismatched Host and default-port normalization
- [x] A-024 R16: the e2e fixture's reverse proxy passes WS upgrades yet 404s CONNECT/absolute-form, and the guest's literal-localhost load + cross-port fetch both resolve rig-side

### Edge Cases & Error Handling

- [x] A-025 R1: bad `target` → 400, dial refusal → 502 pre-upgrade, browser-origin request → 403, each as a plain HTTP error before any upgrade
- [x] A-026 R12: a #1033-era server (no `tunnel` field) reads as `legacy` with no probe attempted; a tunnel-refusing front end yields `legacy`, never a broken tile
- [x] A-027 R9: a web page hitting the local listener with origin-form requests gets 400 (cross-site/DNS-rebinding posture)

### Code Quality

- [x] A-028 Pattern consistency: the tunnel handler mirrors `gui_ws.go`'s relay idiom; the desktop pure logic stays electron-free in its own module like `web-proxy.ts`/`web-views.ts`; named constants for every timeout/bound/chunk size
- [x] A-029 No unnecessary duplication: the Origin policy reuses the `framecheck.go`/`internal/mcp/origin.go` precedents where sensible; the byte pipe reuses the `gui_ws.go` shape rather than inventing a third relay
- [x] A-030 Readability over cleverness; type narrowing over `as` casts on the desktop side; functions stay focused
- [x] A-031 No shell-string subprocess construction anywhere (Go `exec.CommandContext` slices / Node `execFile` with timeouts); no client polling introduced
- [x] A-032 New features carry tests (Go `_test.go`, node --test, desktop e2e) per the test strategy; e2e intent comments follow the constitution rule
- [x] A-033 No comment narration: comments state constraints, not history; no change-ID/PR citations in code comments

### Security

- [x] A-034 R5: a cross-site page cannot open `/ws/tunnel` (no-Origin/no-Sec-Fetch-Site rule) — the pivot-through-rk surface is closed to browsers
- [x] A-035 R6: tightening is defense-in-depth only; CORS stays `["*"]` and the residual Host-match DNS-rebinding exposure is documented in the spec as a known limitation

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — the change's redundant code was all planned and removed in-flight (`forward_proxy.go` + test, the `serve.go` wrapper, the `forwardProxy` health field, `isTailnetHostname` + the https raw-port arm, `connectProbe`/`probeForwardProxy`); review found no additional dead symbols, zero-call-site additions, or duplicated logic.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Node's global `WebSocket` (undici, Node 24) sends NO `Origin` and NO `Sec-Fetch-Site` header on the handshake | Verified live on this box 2026-09-25 (upgrade headers dumped: only `sec-fetch-mode: websocket` present) — the strict tunnel policy accepts the desktop client with no `headers` override | S:95 R:90 A:95 D:95 |
| 2 | Confident | Shared-upgrader predicate lives in a new `app/backend/api/ws_origin.go` beside a tunnel predicate; file-local, no new package | Intake names precedents (`framecheck.go`, `internal/mcp/origin.go`) to "reuse where sensible"; a 60-line predicate needs no package and `internal/mcp`'s policy is bind-derived, not host-matching | S:70 R:85 A:85 D:75 |
| 3 | Confident | `tunnelReadLimit = 1 MiB` and `tunnelReadChunk = 64 KiB` | Intake's "e.g. 32–64 KiB" chunk and the `guiReadLimit` rationale; 64 KiB is the `guiBackendReadChunk` precedent and 1 MiB leaves headroom over the client's 64 KiB write chunks | S:70 R:85 A:85 D:75 |
| 4 | Confident | `tunnelPingInterval = 30 s`, driven by a `time.Ticker` goroutine whose pings are serialized with the pump through a write mutex | Intake's "e.g. 30 s"; gorilla forbids concurrent WRITERS but `WriteControl` is documented concurrency-safe — a mutex keeps the invariant obvious and testable | S:60 R:85 A:80 D:70 |
| 5 | Confident | The ping interval is a package-level `var` (not const) so tests shrink it, mirroring the `operatorStartReceiptTimeout` seam style | The R14 "ping observed" test cannot wait 30 s; the codebase's package-var test-seam pattern is established | S:60 R:80 A:75 D:65 |
| 6 | Confident | `proxyRulesFor` collapses to `proxyRulesFor(localPort: number): string` — the listener port is the only input left | Intake: "`proxyRulesFor` collapses to 'the host's local listener'"; the https/tailnet inputs die with the raw-port arm | S:65 R:80 A:80 D:70 |
| 7 | Confident | Desktop unit coverage stops at pure helpers; the local-proxy integration (CONNECT + absolute-form through a real tunnel) is proven by the e2e fixture, not a hand-rolled WS server in `node --test` | Intake leaves this to the plan ("the plan's call"); Node has no built-in WS server and a frame codec in tests duplicates the e2e proof at high cost | S:60 R:80 A:75 D:65 |
| 8 | Confident | The e2e fixture makes the host non-`direct` via a hosts.json entry carrying a `remote` field pointing at a name that resolves to NO live SSH tunnel — with the heal flow stubbed/avoided per the spec's own seams — so mode derivation takes the remote path without the interstitial | Intake offers "a hosts.json entry with a `remote` field … or another non-local origin shape; plan's call"; the `remote`-field route exercises the exact production ordering (remote-first) | S:60 R:75 A:65 D:55 |
| 9 | Confident | `just dev` verification is a boot smoke plus ONE frontend e2e spec through the Vite origin rather than the full suite | The dispatch contract forbids the full e2e suite ("SINGLE specs only"); any terminal-opening spec exercises `/ws/state` + `/ws/terminals` through the tightened upgrader via Vite's `ws:true` proxy | S:65 R:80 A:75 D:65 |
| 10 | Certain | One tunnel WebSocket per proxied connection; absolute-form tunnels pooled per `host:port` via a keep-alive `http.Agent` with no-op socket shims | Intake Assumptions 10 + 18 (user-discussed); no multiplexing until measurement demands it | S:90 R:80 A:85 D:85 |

10 assumptions (2 certain, 8 confident, 0 tentative).
