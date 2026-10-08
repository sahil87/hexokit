# Intake: Web Tile Remote-Native Mode (Same-Port Forward Proxy)

**Change**: 260925-lqgp-web-tile-remote-proxy
**Created**: 2026-09-25

## Origin

Conversational. The user and the orchestrating agent discussed the design; this intake was created by a promptless dispatch (`/fab-proceed`-style, `{questioning-mode} = promptless-defer`) from the synthesized discussion. Raw framing:

> Web tile "remote-native" mode — the desktop native web engine behaves as if the browser were running on the rk host, **by default**, so that anything started in a terminal on the rk host is reachable in the web tile exactly as if it were running locally.

**Inspiration.** The user's script `~/code/wvrdz/dev-shell/src/packages/scripts/bin/proxy-chrome` opens `ssh -D <port>` (a SOCKS5 dynamic forward) and launches Chrome with:

```sh
--proxy-server=socks5://localhost:<port> \
--proxy-bypass-list="<-loopback>" \
--user-data-dir=/tmp/chrome-proxied
```

`<-loopback>` removes Chromium's implicit loopback bypass, so `localhost:*` is proxied too. Typing `localhost:6000` (a frontend) works, and that page's JS calls to `localhost:6001` (a backend) also resolve on the remote. run-kit's web tile — backed in the desktop app by a Chromium `WebContentsView` — should behave this way.

**Decisions reached in the discussion** (all encoded as Certain/Confident rows in § Assumptions):

1. A **same-port HTTP forward proxy** on the rk server (CONNECT + absolute-form), handled before the chi router — chosen over SOCKS5.
2. **SOCKS5 rejected** — the user explicitly agreed (`ssh -D` would cover only SSH hosts; Tailscale hosts would need a second exposed port).
3. **Full remote, DNS included** — the user chose this explicitly: all native web-tile traffic, not just loopback; hostnames resolve on the rk host; **no destination allowlist/blocklist**.
4. **Per-host session partitions** in the desktop shell, each with `session.setProxy` pointing at that host's rk origin.
5. The **native engine loads literal URLs** when proxy mode is active; the iframe engine is unchanged.
6. **The local host skips the proxy** and loads literal URLs directly.
7. **Constitution amendment** (the user explicitly asked for it): a second Principle IX exception for the proxy transport; version 1.12.1 → 1.13.0.
8. Scope: Go backend + tests, Electron desktop wiring + tests, frontend native-engine URL handling + Vitest, constitution, specs, memory.

## Why

### The problem

Today every loopback URL in the web tile rides the rk server's reverse proxy, `/proxy/{port}`:

- `app/backend/api/router.go` (~line 1012) mounts `r.HandleFunc("/proxy/{port}/*", s.handleProxy)` and `r.HandleFunc("/proxy/{port}", s.handleProxy)`.
- `app/backend/api/proxy.go` builds an `httputil.ReverseProxy` that dials `127.0.0.1:<port>` on the rk host and rewrites `(https?:)?//(localhost|127\.0\.0\.1):(\d+)` to `/proxy/N` in **HTML responses only** (`rewritePattern`, `makeModifyResponse`).
- The frontend maps typed `localhost:N` / `127.0.0.1:N` to `/proxy/N/…` (`app/frontend/src/lib/web-url.ts` → `toProxySrc`), and maps `/proxy/N` back to `localhost:N` for display (`displayForm`).
- Both engines load that same-origin path: the iframe engine (`app/frontend/src/components/web-frame-iframe.tsx`) and the native engine (`app/frontend/src/components/web-frame-native.tsx:253`: `absoluteUrl = new URL(toProxySrc(url), window.location.origin).href`).

That path-rewrite scheme falls short for real development servers:

- **Only HTML is rewritten.** JS-constructed URLs, e.g. `fetch("http://localhost:6001/api")` inside a bundle, go to the **viewer's** machine, not the rk host.
- **Root-absolute asset paths** (`/assets/x.js`) loaded under `/proxy/6000/` resolve against rk's own root.
- **Vite HMR WebSockets** and **OAuth `redirect_uri=http://localhost:…`** break.
- **All ports share rk's single origin**, so cookies and localStorage collide across ports, and CORS semantics differ from real development.

### Consequence of not fixing

The web tile stays unusable for the core run-kit use case — an agent starts a dev server in a terminal on the rk host and the user wants to look at it — for any modern SPA (Vite/Next dev servers, split frontend/backend ports, OAuth flows). Users fall back to ad-hoc `ssh -L` forwards or scripts like `proxy-chrome`.

### Why this approach

- **A real HTTP forward proxy** makes the browser itself route traffic, so every request — HTML, JS `fetch`, WebSocket, redirects — resolves on the rk host with correct origins. No content rewriting at all.
- **Same port as rk** means it works identically for both remote host kinds with zero new tunnels or exposed ports: a Tailscale host is reached at its rk origin already, and an SSH host's existing `ssh -N -L 127.0.0.1:L:127.0.0.1:R` tunnel (`app/backend/internal/remote/tunnel.go:71-74`) already carries the rk port.
- **SOCKS5 rejected**: adding `ssh -D` to `rk remote connect` covers only SSH hosts; Tailscale hosts would need a second exposed port. (User agreed.)
- **Electron can set a proxy per session** (`session.setProxy`), which an iframe can never do — so this is a desktop-native-engine capability; the iframe engine keeps `/proxy/{port}`.

## What Changes

### 1. Backend — same-port HTTP forward proxy (`app/backend/`)

A new forward-proxy handler wraps the top-level HTTP handler, so it sees requests **before** the chi router (CONNECT has an empty path and would never match a chi route; chi's `cors`, `Logger`, `Recoverer` middleware do not apply to it).

**Wiring** — `app/backend/cmd/rk/serve.go:338` currently builds:

```go
server := &http.Server{
    Addr:    addr,
    Handler: router,
}
```

It becomes `Handler: api.ForwardProxy(router)` (name indicative) — a wrapper that dispatches proxy-shaped requests to the proxy and passes everything else to `router` unchanged. Tests that construct the router via `NewRouter` / `NewRouterAndServer` must be able to exercise the wrapper too (the plan picks where the wrap lives — in `serve.go` or inside a constructor the tests share).

**Detection** (proxy-shaped requests):

| Request shape | Example request line | Detection | Handling |
|---|---|---|---|
| Authority-form CONNECT | `CONNECT localhost:6000 HTTP/1.1` | `r.Method == http.MethodConnect` | Tunnel |
| Absolute-form plain HTTP | `GET http://localhost:6000/assets/x.js HTTP/1.1` | request-target is absolute (`r.URL.IsAbs()` / `r.RequestURI` starts with `http://`) | Forward |
| Anything else | `GET /api/health HTTP/1.1` | — | `router.ServeHTTP` (unchanged) |

Note: Chromium sends `https://` and **WebSocket (`ws://` and `wss://`) traffic through an HTTP proxy via CONNECT**, and plain `http://` via absolute-form requests.

**CONNECT tunnel:**

- Dial `r.Host` (the `host:port` authority) with `net.Dialer{Timeout: …}` (a named constant, e.g. 10 s) using `DialContext` bound to the request context — **never a subprocess** (Principle I is about process execution; the proxy uses net dialing only).
- Hostnames resolve **on the rk host** (Go's resolver), so remote-only names work: Docker service names, internal DNS, `*.localhost`.
- On dial failure: respond `502 Bad Gateway` (before hijack). On success: hijack the client connection (`http.Hijacker`), write `HTTP/1.1 200 Connection Established\r\n\r\n`, flush any bytes already buffered in the hijacked `bufio.ReadWriter` to the upstream, then run a **bidirectional copy** (two `io.Copy` goroutines).
- **Cleanup**: when either direction ends, close both connections (or half-close via `CloseWrite` where available, then close) so neither goroutine leaks; no orphaned sockets on client disconnect or upstream close.
- An established tunnel MUST NOT be cut by a short fixed deadline — HMR WebSockets and long-polls are long-lived; lifetime is close-driven. Whether to add a generous idle cap is the plan's call.

**Absolute-form forwarding:**

- Forward to the absolute URL's host (again resolved on the rk host) with an `http.Transport` whose `DialContext` uses a `net.Dialer` with a timeout, `ResponseHeaderTimeout` set, and **`Proxy: nil`** (never chain through the daemon's own `HTTP_PROXY` env).
- Strip hop-by-hop and proxy-only headers (`Proxy-Connection`, `Proxy-Authorization`, `Connection`-listed headers, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade` unless tunnelled). `httputil.ReverseProxy` with a `Rewrite` that sets the outbound URL to the absolute request URL is one acceptable implementation (it already strips hop-by-hop headers); the plan picks.
- **No content rewriting** — the response is passed through verbatim (the opposite of `/proxy/{port}`'s HTML rewrite).
- Upstream failure → `502 Bad Gateway`.

**Destination policy: NONE.** The proxy dials any destination — loopback, LAN, internet. There is no allowlist or blocklist. Rationale (user decision, to be recorded verbatim in memory/spec): **anyone who can reach rk already has a shell on the host through the terminal relay** (rk has no auth — it is "Tailnet-only" / SSH-tunnel-only by deployment), so restricting proxy destinations would be security theater and adds no exposure beyond what rk already grants. Browser pages cannot abuse it cross-site: `CONNECT` is a forbidden method for `fetch`/XHR, and a page cannot emit an absolute-form request line, so no new CSRF surface is created.

**Statelessness:** the proxy holds no state beyond live connections (Principle II). It adds no route to the chi route table and does not touch `/proxy/{port}` or `/code`, which remain for the iframe engine and browser viewers.

**Logging/recovery:** because the wrapper sits outside chi, it carries its own panic recovery and (at least debug-level) logging consistent with the daemon's `slog` usage.

### 2. Constitution amendment (`fab/project/constitution.md`)

Principle IX gains a **second documented exception**, modeled on the existing `/mcp` paragraph. Proposed text (appended after the MCP paragraph):

> Second documented exception: the HTTP forward-proxy transport. The daemon accepts HTTP forward-proxy traffic on its listen port — `CONNECT host:port` (authority-form, used for https and WebSocket tunnels) and absolute-form plain-HTTP requests (`GET http://host:port/path`) — because the HTTP proxy protocol mandates those request shapes (`docs/specs/api.md` § Forward Proxy). Proxy-shaped requests are handled by a transport wrapper ahead of the router; the exception is transport-scoped, grants nothing to `/api/*`, adds no route, and leaves the CORS allowlist at `[GET, POST, OPTIONS]`. The proxy dials with `net.Dialer` timeouts and never spawns a subprocess (Principle I), and holds no state beyond live connections (Principle II).

Also: the first exception's sentence "One documented exception:" becomes wording consistent with there now being two (e.g. "Two documented exceptions." then each paragraph). Governance line becomes:

```
**Version**: 1.13.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-25
```

(Minor bump: a new exception is an additive, non-breaking amendment.)

### 3. Desktop — per-host guest sessions with a proxy (`app/desktop/src/`)

**Current state:** `app/desktop/src/main.ts:555` — `const GUEST_PARTITION = "persist:rk-web";` — one shared partition for every host's guests, created lazily by `guestSession()` (`main.ts:568`) which installs a deny-all `setPermissionRequestHandler`. `createWebView` (`main.ts:1093`) builds `new WebContentsView({ webPreferences: guestWebPreferences() })`. There is no `setProxy`, `webRequest`, or `protocol` handler anywhere in `app/desktop/src`.

**Change:**

- **One partition per host**: `persist:rk-web:<host.id>` replacing the single `persist:rk-web`. `host.id` is the hosts.json entry's `randomUUID()` (`app/desktop/src/hosts.ts:163`) — stable across `setHostUrl` (SSH heal can change the origin) and safe as a partition-name suffix. Two hosts can both serve `localhost:6000` without cookie/localStorage collisions.
  - `guestSession()` becomes `guestSession(host)` (a per-host cache map); every per-host session keeps the deny-all permission handler and the existing hardening (`sandbox`, `contextIsolation`, `nodeIntegration: false`, **no preload**).
  - No migration of existing `persist:rk-web` cookies — guests start with fresh per-host jars. The old partition's on-disk directory may be left alone or cleaned; the plan decides (no user data of rk's own lives there).
- **Proxy config per host session** — a pure, unit-testable derivation (e.g. in a new `app/desktop/src/web-proxy.ts` or in `web-views.ts`) from `(host entry, local-daemon facts, capability result)` → one of three modes:

  | Mode | When | Session proxy | Native engine loads |
  |---|---|---|---|
  | `direct` | the host is THIS machine's daemon (see "Local-host detection" below) | none (`mode: "direct"`) | literal URL, e.g. `http://localhost:6000/` |
  | `proxy` | remote host (Tailscale URL or `rk remote` SSH host) AND the proxy capability check passes | `{ mode: "fixed_servers", proxyRules: "http://<rk-host>:<rk-port>", proxyBypassRules: "<-loopback>" }` | literal URL |
  | `legacy` | remote host whose proxy check fails (older rk server, or a front end that does not pass CONNECT) | none | `toProxySrc` path made absolute against the host origin (today's behavior) |

  For an SSH host the `proxyRules` target is the viewer-side tunnel origin (`http://127.0.0.1:<L>`), which the existing `-L` forward carries to the remote rk port.
- **`<-loopback>` verification**: it is unverified whether Electron's `setProxy` honors `proxyBypassRules: "<-loopback>"` (Chromium's `ProxyBypassRules` supports it). The plan MUST include a verification task (a desktop test or spike that loads `http://localhost:<port>` in a proxied session and asserts the request reached the proxy). If Electron does not honor it, the plan picks a fallback (e.g. a PAC script, or a `protocol`/`webRequest`-based interception) and records it.
- **Local-host detection — do NOT use `isLoopbackOrigin` alone.** `isLoopbackOrigin` (`main.ts:668`) returns true for any `localhost` / `127.*` / `[::1]` origin — and an `rk remote` SSH host's origin IS `http://127.0.0.1:<L>` (the tunnel's local end). `interstitialKindFor` (`main.ts:677`) already shows the correct ordering: a host with a non-empty `remote` field is remote first; only then is a loopback origin (or `host.url === localDaemonOrigin()`) the local daemon. The `direct` mode MUST reuse that ordering (ideally the same helper), so SSH hosts get `proxy`, never `direct`.
- **Re-apply on change**: when a host's URL changes (`setHostUrl`, SSH heal re-connect) or its capability result changes, the host session's proxy config is re-derived and re-applied (`session.setProxy` is async; guests created before it resolves must not load unproxied — the plan sequences `setProxy` before the first `loadURL`, or awaits it in `web:create`).
- **The SPA must learn the mode** (the renderer cannot tell an SSH host from the local daemon by `window.location.origin` — both are loopback). The bridge exposes the per-host web mode to the host's SPA (e.g. a `runkitShell.web` query, or a field on the `web:create` result).

**Capability check** (older rk servers lack the proxy, and a TLS front end may not pass CONNECT): proxy mode is enabled only after a check succeeds. Recommended default: a **live probe through the actual proxy path** from the main process (e.g. issue `CONNECT <rk-host>:<rk-port>` — or an absolute-form `GET http://127.0.0.1:<rk-port>/api/health` — to the host origin and require the expected answer), cached per host and re-run on URL change/heal. A cheaper supplement is a flag on `GET /api/health` (e.g. `"forwardProxy": true`; `app/backend/api/health.go`), but a flag alone cannot detect a front end that drops CONNECT.

### 4. Frontend — native engine literal URLs (`app/frontend/src/`)

- `web-frame-native.tsx` (~line 251-256): when the host's web mode is `direct` or `proxy`, it **stops calling `toProxySrc`** and loads the literal URL (`http://localhost:6000/…`). In `legacy` mode it keeps today's `new URL(toProxySrc(url), window.location.origin).href`.
- **Stored tab values are unchanged.** `@rk_win_web_<n>` slot values for loopback targets are stored as `/proxy/N/…` (the backend rewrites an absolute loopback add-target to that slot form — see `toWebAddTarget` in `web-url.ts:378`). The native engine in `direct`/`proxy` mode maps a `/proxy/N/rest` slot back to `http://localhost:N/rest` at load time (the inverse `toWebAddTarget` already implements), so the same tab still works in a browser viewer's iframe engine. A new pure helper (e.g. `toNativeSrc(url, mode)`) in `web-url.ts` carries this with Vitest coverage.
- **Address bar shows the real URL.** Guest navigations report absolute URLs; `toTracked` (`web-frame-native.tsx:94`) already keeps cross-origin URLs absolute, so `http://localhost:6000/x` displays as-is. `displayForm` must render literal loopback URLs sensibly (it already maps `/proxy/N` → `localhost:N`; confirm the literal form renders as `localhost:6000/x`).
- **Address-bar writes** of a literal loopback URL from the native engine flow through the existing `onWriteUrl` → backend path, which stores the `/proxy/N` slot form — unchanged.
- The **iframe engine** (`web-frame-iframe.tsx`) and engine selection in `iframe-window.tsx` (incl. the existing per-viewer `web-engine-pref` opt-out back to `iframe`) are unchanged.

### 5. Specs, memory, and the design study

- `docs/specs/api.md`: new § Forward Proxy (transport, detection table, CONNECT/absolute-form semantics, no destination policy + rationale, error codes); Design Principles item 1 names the second exception; Route Summary notes the transport (no route).
- `docs/specs/window-views.md` § Engines (~lines 94-103): the native engine's `direct`/`proxy`/`legacy` modes and literal-URL loading.
- `docs/wiki/web-tile-native-browser-studies.html` §9 lists "when the host origin is loopback, load `http://localhost:{port}` directly" as optional-not-built — the plan may add a short note that it is now built (optional).
- Memory updates at hydrate (see § Affected Memory).

### Accepted cons (user decision — record in spec/memory)

- All web-tile egress leaves from the remote host: its IP, extra latency, and IP-based sites see the remote.
- The viewer's own localhost, LAN, and VPN are unreachable from the native web tile in `proxy` mode (the iframe engine, e.g. via the per-viewer engine opt-out, remains a viewer-local escape hatch).

## Affected Memory

- `run-kit/api-and-sockets`: (modify) the forward-proxy transport wrapper (CONNECT tunnel, absolute-form forward, no destination policy, statelessness) and the second scoped §IX exception beside `/mcp`
- `run-kit/desktop-shell`: (modify) § Web Views / Security Wiring — per-host `persist:rk-web:<host.id>` partitions replacing `persist:rk-web`, the per-host `setProxy` config, the `direct`/`proxy`/`legacy` mode derivation, the capability probe, local-host detection ordering; new Design Decisions entries (same-port HTTP proxy over SOCKS5; per-host partitions; no destination policy)
- `run-kit/ui/lenses-and-layout`: (modify) § Web Tile → the `native` engine — literal-URL loading in `direct`/`proxy` modes, the `/proxy/N` ↔ literal mapping at load time, address-bar display
- `run-kit/remote-hosts`: (modify) the existing `-L` tunnel now also carries the web tile's proxy traffic (no new forward)
- `run-kit/architecture/overview`: (modify) security section — the daemon is also an HTTP forward proxy with no destination restriction, and why that adds no exposure
- `run-kit/architecture/testing`: (modify) desktop e2e fixture contract — guests on the loopback e2e hosts now load literal URLs, so guest classification by `/proxy/<stubPort>/` path changes

## Impact

- **Backend**: `app/backend/cmd/rk/serve.go` (handler wrap); new `app/backend/api/forward_proxy.go` (+ `forward_proxy_test.go`: CONNECT success/dial-failure/bidirectional bytes/close cleanup, absolute-form forward incl. hop-by-hop stripping and `Proxy: nil`, non-proxy passthrough to the router, WebSocket-over-CONNECT). Possibly `app/backend/api/health.go` (capability flag).
- **Desktop**: `app/desktop/src/main.ts` (guest session per host, `setProxy`, mode derivation wiring, capability probe, bridge exposure), `app/desktop/src/preload.ts` + `app/frontend/src/lib/shell.ts` (bridge surface if a new query is added), a new pure module for partition-key + proxy-config derivation with unit tests, `app/desktop/tests/e2e/web-native.spec.ts` (its guest classification by `/proxy/<stubPort>/` URL path breaks because loopback e2e hosts become `direct` mode — update the spec and its intent comments).
- **Frontend**: `app/frontend/src/components/web-frame-native.tsx`, `app/frontend/src/lib/web-url.ts` (+ tests), possibly `display` handling in the address bar.
- **Governance/docs**: `fab/project/constitution.md`, `docs/specs/api.md`, `docs/specs/window-views.md`, optionally the design study HTML.
- **Dev rig note**: under `just dev` the desktop's host origin may be the Vite dev server (which would not handle CONNECT); such a host is loopback/local → `direct` mode, so it never needs the proxy. The capability probe protects any other shape.
- **Test gates**: `just test-backend` (run with `env -u TMUX -u TMUX_PANE` where the harness needs it), `just test-frontend`, desktop unit tests, `just test-desktop-e2e`.

## Open Questions

- ~~TLS-fronted hosts~~ — resolved (Assumption 20): Tailscale Serve rejects CONNECT (verified), so such hosts target rk's raw listen port over the tailnet, probe-gated with `legacy` fallback.
- Is a per-host opt-out ("keep viewer-local networking for this host") wanted beyond the existing per-viewer iframe-engine opt-out?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Same-port HTTP forward proxy on the rk server: CONNECT (authority-form) + absolute-form plain HTTP on the existing listen port, detected and handled BEFORE the chi router as a top-level handler wrapper | Discussed — user decision 1; works for Tailscale and SSH hosts via the existing `-L` tunnel with no new port | S:95 R:60 A:90 D:90 |
| 2 | Certain | SOCKS5 (`ssh -D` in `rk remote connect`) rejected | Discussed — user explicitly agreed: covers only SSH hosts; Tailscale would need a second exposed port | S:95 R:70 A:90 D:95 |
| 3 | Certain | Full remote incl. DNS: all native web-tile traffic goes through the proxy (not only loopback) and hostnames resolve on the rk host | Discussed — user chose this explicitly; cons (remote egress IP, latency, viewer localhost/LAN/VPN unreachable) accepted | S:95 R:65 A:90 D:90 |
| 4 | Certain | No destination allowlist/blocklist; record the rationale (anyone who reaches rk already has a shell via the terminal relay, so restriction is security theater) in spec + memory | Discussed — user decision 3, rationale to be recorded verbatim; browsers cannot emit CONNECT/absolute-form, so no new CSRF surface | S:95 R:70 A:85 D:90 |
| 5 | Certain | Constitution Principle IX gets a second transport-scoped exception modeled on `/mcp`; CORS allowlist unchanged; notes on Principle I (net dialing, no subprocess) and II (stateless); version 1.12.1 → 1.13.0, Last Amended 2026-09-25 | Discussed — user explicitly asked for the amendment and the minor bump | S:95 R:80 A:90 D:85 |
| 6 | Certain | Native engine loads literal URLs (`http://localhost:6000/…`) when the proxy/direct mode is active and the address bar shows the real URL; the iframe engine keeps `/proxy/{port}` unchanged | Discussed — user decision 5; iframes cannot set a proxy | S:95 R:75 A:90 D:90 |
| 7 | Certain | When the rk host is this machine, load literal URLs directly with no proxy (the study §9 optional idea) | Discussed — user decision 6 | S:90 R:80 A:85 D:85 |
| 8 | Certain | Go proxy dials use `net.Dialer` with a named timeout constant; CONNECT tunnels are bidirectional copies with close-driven cleanup of both conns | Discussed constraint + constitution Process Execution spirit + code-quality (no magic numbers) | S:90 R:85 A:90 D:85 |
| 9 | Certain | Tests: Go unit tests for CONNECT and absolute-form, Vitest for native URL logic, desktop unit tests for partition-key and proxy-config derivation | Discussed constraint + code-quality "features MUST include tests" | S:90 R:85 A:90 D:85 |
| 10 | Certain | "Local host" for `direct` mode follows `interstitialKindFor` ordering: a host with a non-empty `remote` field is remote first; only then a loopback origin / `localDaemonOrigin()` match is local. `isLoopbackOrigin` alone is wrong because SSH hosts' origins are `http://127.0.0.1:<L>` | Code reading: `main.ts:668-684`, `tunnel.go:74`; the user's intent ("the local machine") is unambiguous and the loopback-only reading is demonstrably a bug for SSH hosts | S:70 R:75 A:90 D:85 |
| 11 | Confident | Partition key is `persist:rk-web:<host.id>` (the hosts.json UUID), not the origin | `hosts.ts:163` ids are `randomUUID()` and survive `setHostUrl`/SSH heal; origin-keyed jars would reset on heal | S:65 R:70 A:75 D:65 |
| 12 | Confident | No migration of existing `persist:rk-web` cookies; per-host jars start fresh | Description said "probably no migration needed"; the shared jar cannot be split per host correctly; the old partition stays on disk, so a later migration remains possible | S:65 R:75 A:70 D:75 |
| 13 | Confident | Stored `@rk_win_web_<n>` slot values stay in the `/proxy/N/…` form; the native engine maps `/proxy/N/rest` → `http://localhost:N/rest` at load time (the `toWebAddTarget` inverse), so tabs stay portable to browser viewers | Code reading: `web-url.ts:358-383`; keeps backend + iframe engine untouched | S:60 R:75 A:80 D:70 |
| 14 | Confident | Proxy mode is gated on a capability check; failing hosts fall back to `legacy` (today's `toProxySrc` path) — never a broken tile. Recommended check: a live probe through the actual proxy path (optionally plus a `/api/health` flag) | Description flagged older servers; a health flag alone cannot detect a front end that drops CONNECT; fallback preserves today's behavior | S:55 R:70 A:65 D:50 |
| 15 | Certain | Absolute-form forwarding uses a transport with `Proxy: nil`, dial + response-header timeouts, hop-by-hop/proxy header stripping, and NO content rewriting | Standard HTTP forward-proxy semantics (RFC 9110 hop-by-hop rules); `proxy.go` Transport pattern already sets dial/header timeouts | S:60 R:80 A:90 D:85 |
| 16 | Certain | `/proxy/{port}` and `/code` routes are untouched; the wrapper adds no chi route | Iframe engine and browser viewers still need them (decision 5); code-quality "no routes without spec justification" | S:70 R:85 A:85 D:80 |
| 17 | Confident | The SPA learns the per-host web mode (`direct`/`proxy`/`legacy`) from the desktop main process over the `runkitShell.web` bridge; the exact channel (query vs `web:create` result field) is the plan's choice | Forced by the facts: the renderer cannot distinguish an SSH host from the local daemon by origin, and main owns host facts; only the channel shape is open | S:50 R:75 A:80 D:70 |
| 18 | Confident | Use `proxyBypassRules: "<-loopback>"`; the plan MUST verify Electron (43.x) honors it with a test/spike and pick a fallback (PAC script or protocol/webRequest interception) if not | User named `<-loopback>` and asked for verification; Chromium's ProxyBypassRules supports it, Electron passthrough unverified; a fallback stays local to the proxy-config module | S:70 R:65 A:45 D:50 |
| 19 | Confident | No new opt-out toggle; default-on, with the existing per-viewer iframe-engine opt-out (`web-engine-pref`) as the viewer-local escape hatch | User said "by default" and "any toggle is optional"; Constitution IV discourages new settings surfaces; a per-host toggle can be added later | S:65 R:75 A:50 D:55 |
| 20 | Confident | TLS-fronted hosts (`https://` origins, e.g. Tailscale Serve) target a raw-port proxy: `http://<origin hostname>:<rk listen port>`, the port advertised by the rk server (e.g. a `forwardProxy` port field on `GET /api/health`). The row-14 live probe runs against that target; a failing probe (rk bound to `127.0.0.1` only, or a Tailscale service VIP with no raw port) falls back to `legacy`. An `https://` proxy scheme is rejected — the front end is the part that drops CONNECT | Verified 2026-09-25 on the user's box: `curl -p -x https://dev-ws-sahil02.bat-ordinal.ts.net` → Serve answers CONNECT with its own 404 (rk direct answers 405), so Serve cannot carry the proxy; the box runs `RK_HOST=0.0.0.0`, so the raw port is tailnet-reachable. Tailnet hops are WireGuard-encrypted, so a plaintext proxy hop adds no exposure | S:80 R:70 A:75 D:70 |

20 assumptions (12 certain, 8 confident, 0 tentative, 0 unresolved).
