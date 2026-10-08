# Plan: Web Tile Remote-Native Mode (Same-Port Forward Proxy)

**Change**: 260925-lqgp-web-tile-remote-proxy
**Intake**: `intake.md`

## Requirements

### Backend: Same-Port HTTP Forward Proxy

#### R1: Transport wrapper ahead of the chi router
The daemon SHALL accept HTTP forward-proxy traffic on its existing listen port via a top-level handler wrapper (`api.ForwardProxy(router)`, wired at `app/backend/cmd/rk/serve.go`'s `http.Server{Handler: …}`). The wrapper MUST detect proxy-shaped requests — `CONNECT` (authority-form) and absolute-form plain-HTTP request targets (`r.URL.IsAbs()` with an `http:` scheme) — and handle them itself; every other request MUST pass through to the chi router unchanged. The wrapper adds NO chi route and leaves `/proxy/{port}` and `/code` untouched. Because it sits outside chi (chi's `cors`/`Logger`/`Recoverer` do not apply), it MUST carry its own per-request panic recovery and `slog` logging consistent with the daemon's usage.

- **GIVEN** the daemon serving on its listen port
- **WHEN** a request arrives with method `CONNECT` or an absolute-form `http://` request target
- **THEN** the wrapper handles it as proxy traffic and the chi router never sees it
- **AND** a plain origin-form request (e.g. `GET /api/health`) reaches the chi router byte-for-byte as before

#### R2: CONNECT tunnel semantics
A `CONNECT host:port` request MUST dial the authority with `net.Dialer` under a named timeout constant (10 s) via `DialContext` bound to the request context (hostnames resolve on the rk host — Docker service names, internal DNS, `*.localhost` all work). On dial failure the wrapper MUST respond `502 Bad Gateway` before hijacking. On success it MUST hijack the client connection, write `HTTP/1.1 200 Connection Established\r\n\r\n`, flush any bytes already buffered in the hijacked `bufio.ReadWriter` to the upstream, then run a bidirectional copy (two `io.Copy` goroutines). Cleanup MUST be close-driven: when either direction ends, both connections close (half-close via `CloseWrite` where available, then full close), so neither goroutine nor socket leaks. An established tunnel MUST NOT be cut by a fixed deadline — HMR WebSockets and long-polls are long-lived; there is no idle cap.

- **GIVEN** a client with an established CONNECT tunnel to a live upstream
- **WHEN** bytes flow in both directions (including a WebSocket upgrade inside the tunnel)
- **THEN** they are relayed verbatim in both directions
- **AND** when either side closes, both connections are closed and both copy goroutines exit

#### R3: Absolute-form forwarding semantics
An absolute-form request (`GET http://host:port/path`) MUST be forwarded to the URL's host (resolved on the rk host) with an `http.Transport` whose `DialContext` uses a `net.Dialer` timeout, `ResponseHeaderTimeout` set (mirroring `proxy.go`'s 5 s dial / 10 s response-header shape), and **`Proxy: nil`** (never chained through the daemon's own `HTTP_PROXY` env). Hop-by-hop and proxy-only headers (`Proxy-Connection`, `Proxy-Authorization`, `Connection`-listed headers, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, non-tunnelled `Upgrade`) MUST be stripped. The response MUST pass through verbatim — NO content rewriting (the opposite of `/proxy/{port}`'s HTML rewrite). Upstream failure MUST surface as `502 Bad Gateway`.

- **GIVEN** an absolute-form request carrying `Proxy-Connection: keep-alive` and a `Connection: X-Foo` + `X-Foo` header pair
- **WHEN** the wrapper forwards it
- **THEN** the upstream receives none of those headers, the body and remaining headers arrive intact, and the response body reaches the client unmodified
- **AND** when the upstream refuses the connection the client gets `502`

#### R4: No destination policy; stateless
The proxy SHALL dial ANY destination — loopback, LAN, internet — with no allowlist or blocklist. Rationale (recorded in spec and memory): anyone who can reach rk already has a shell on the host through the terminal relay (rk has no auth — Tailnet-only / SSH-tunnel-only by deployment), so restricting destinations is security theater; browsers cannot emit `CONNECT` or absolute-form request lines from a page, so no new CSRF surface is created. The proxy MUST hold no state beyond live connections (Constitution II) and MUST never spawn a subprocess (net dialing only, Constitution I).

- **GIVEN** a CONNECT or absolute-form request naming any routable destination
- **WHEN** the wrapper handles it
- **THEN** it dials that destination without consulting any policy list

#### R5: `forwardProxy` capability on `GET /api/health`
`GET /api/health` MUST carry a `forwardProxy` field holding the daemon's listen port (a JSON number, derived from config at request time per Constitution II). Older daemons simply lack the field — its absence is the desktop shell's cheap pre-check before the live CONNECT probe.

- **GIVEN** a daemon running this build on port 3001
- **WHEN** a client GETs `/api/health`
- **THEN** the JSON body carries `"forwardProxy": 3001` alongside the existing fields

### Governance: Constitution Amendment

#### R6: Principle IX second exception + version 1.13.0
`fab/project/constitution.md` Principle IX MUST gain a second documented exception for the forward-proxy transport (transport-scoped, no route, grants nothing to `/api/*`, CORS allowlist unchanged, `net.Dialer` timeouts / no subprocess per §I, no state beyond live connections per §II), modeled on the existing `/mcp` paragraph and using the text drafted in intake § 2. The lead-in "One documented exception:" MUST become wording consistent with two exceptions. Governance line MUST read `**Version**: 1.13.0 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-25`.

- **GIVEN** the amended constitution
- **WHEN** a reviewer reads Principle IX
- **THEN** two exceptions are documented and the version is 1.13.0, Last Amended 2026-09-25

### Desktop: Per-Host Guest Sessions with Proxy

#### R7: One guest partition per host
The shared `persist:rk-web` partition MUST be replaced by per-host partitions `persist:rk-web:<host.id>` (the hosts.json `randomUUID()`, stable across `setHostUrl`/SSH heal). `guestSession()` becomes `guestSession(host)` backed by a per-host cache map; every per-host session keeps the deny-all `setPermissionRequestHandler` and the existing hardening (`sandbox`, `contextIsolation`, `nodeIntegration: false`, NO preload). Existing `persist:rk-web` cookies are NOT migrated — per-host jars start fresh; the old partition's on-disk directory is left alone.

- **GIVEN** two registered hosts that both serve `localhost:6000`
- **WHEN** web-tile guests are created under each
- **THEN** each runs in its own `persist:rk-web:<host.id>` partition with no cookie/localStorage sharing

#### R8: Pure mode derivation with local-host ordering
A pure, unit-testable derivation in a new electron-free module `app/desktop/src/web-proxy.ts` MUST map `(host entry, local-daemon origin, probe result)` to one of `direct` / `proxy` / `legacy`. Local-host detection MUST follow `interstitialKindFor`'s ordering — a host with a non-empty `remote` field is remote FIRST; only then is a loopback origin / `localDaemonOrigin()` match local — so an SSH host (whose origin IS loopback, `http://127.0.0.1:<L>`) gets `proxy`, never `direct`. `direct` = this machine's daemon (no proxy, literal URLs); `proxy` = remote host whose capability probe passed; `legacy` = remote host whose probe failed (today's `toProxySrc` behavior).

- **GIVEN** a host entry with `remote: "buildbox"` and url `http://127.0.0.1:3100`
- **WHEN** the mode is derived with a passing probe
- **THEN** the mode is `proxy` (not `direct`), because the `remote` field is checked before any loopback test

#### R9: Per-host `session.setProxy` config
For `proxy` mode the host's session MUST be configured `{ mode: "fixed_servers", proxyRules, proxyBypassRules: "<-loopback>" }`; for `direct`/`legacy` the session gets `{ mode: "direct" }`. `proxyRules` targets the host's rk origin for `http:` origins (an SSH host's `http://127.0.0.1:<L>` tunnel origin, which the existing `-L` forward carries to the remote rk port); for TLS-fronted (`https:`) origins it MUST target `http://<origin hostname>:<advertised port>` — the raw listen port from the health field (Assumption 20) — and when no advertised port is available the mode MUST be `legacy`. `setProxy` is async: it MUST be applied (awaited) BEFORE the first guest `loadURL` for that host, and re-derived/re-applied when the host's URL changes (`setHostUrl`, SSH heal re-connect) or the probe result is refreshed.

- **GIVEN** a host in `proxy` mode whose URL just changed via `setHostUrl`
- **WHEN** the next guest is created for that host
- **THEN** the session's proxy config has been re-derived and applied before the guest loads

#### R10: Capability probe with legacy fallback
Proxy mode MUST be gated on a live probe through the actual proxy path, run from the main process: (1) GET `<origin>/api/health` requiring HTTP 200 with a numeric `forwardProxy` field (absent ⇒ `legacy`, no probe — an older server); (2) a raw-TCP `CONNECT 127.0.0.1:<forwardProxyPort> HTTP/1.1` to the computed proxy target (the origin's host:port for `http:` origins; `<hostname>:<forwardProxyPort>` for `https:` origins), requiring an `HTTP/1.1 200` response head. Any failure — timeout (bounded, ~5 s), non-200, unreachable target — yields `legacy`. The result is cached per host and re-run on URL change/heal.

- **GIVEN** a remote host behind a TLS front end that drops CONNECT (e.g. Tailscale Serve)
- **WHEN** the probe runs against the raw-port target
- **THEN** it fails and the host's mode is `legacy` — the tile keeps today's behavior, never a broken tile

#### R11: Mode exposed to the SPA over the bridge
The bridge MUST expose the per-host web mode to that host's SPA as an ADDITIVE `web.mode()` invoker on the `runkitShell.web` group (a `web:mode` IPC channel, gated like every `web:*` handler; main resolves the host from the sender view — no argument). It resolves `{ ok: true, mode }` after the host's proxy state is settled. The frontend narrows it separately from `isWebBridge` (the existing additive-invoker pattern): an older shell without it reads as `legacy` — today's behavior. The SPA cannot infer the mode from `window.location.origin` (an SSH host and the local daemon are both loopback).

- **GIVEN** the SPA of an SSH host (origin `http://127.0.0.1:3100`)
- **WHEN** it calls `web.mode()`
- **THEN** it resolves `{ ok: true, mode: "proxy" }` once the probe has passed
- **AND** the same call on a shell predating the channel is absent, which the SPA reads as `legacy`

#### R12: `<-loopback>` verification
The plan MUST prove whether Electron 43 honors `proxyBypassRules: "<-loopback>"` (Chromium's `ProxyBypassRules` supports it; Electron passthrough was unverified). A desktop e2e spec MUST configure a session with `fixed_servers` + `proxyBypassRules: "<-loopback>"` pointing at a spec-owned recording proxy, load `http://localhost:<port>` in a guest on that session, and assert the request REACHED the proxy (not direct). If Electron does not honor it, a fallback (PAC script or `protocol`/`webRequest` interception) MUST replace it and the outcome MUST be recorded.

- **GIVEN** a guest session configured `{ mode: "fixed_servers", proxyRules: <recording proxy>, proxyBypassRules: "<-loopback>" }`
- **WHEN** the guest loads `http://localhost:<stubPort>/`
- **THEN** the recording proxy observes the absolute-form request for that URL

### Frontend: Native Engine Literal URLs

#### R13: `toNativeSrc(url, mode)` pure helper
`app/frontend/src/lib/web-url.ts` MUST gain a pure helper `toNativeSrc(url, mode)` with Vitest coverage: in `direct`/`proxy` mode a stored `/proxy/N/rest` slot maps back to `http://localhost:N/rest` (the `toWebAddTarget` inverse mapping) and an absolute loopback URL passes through as-is; in `legacy` mode it returns exactly `toProxySrc(url)`. Every other address kind passes through unchanged. Stored `@rk_win_web_<n>` slot values stay in `/proxy/N/…` form — unchanged on disk, portable to browser viewers' iframe engines.

- **GIVEN** the stored slot value `/proxy/6000/assets/x.js`
- **WHEN** `toNativeSrc` runs in `proxy` mode
- **THEN** it returns `http://localhost:6000/assets/x.js`
- **AND** in `legacy` mode it returns `/proxy/6000/assets/x.js`

#### R14: Native engine loads literal URLs in direct/proxy mode
`app/frontend/src/components/web-frame-native.tsx` MUST query the host's mode (via the additive bridge invoker, awaited inside the mount effect before `createShellWebView`, unmount-safe) and load `new URL(toNativeSrc(url, mode), window.location.origin).href` — the literal `http://localhost:6000/…` in `direct`/`proxy`, today's `/proxy/N` made host-absolute in `legacy`. `displayForm` MUST render literal loopback URLs sensibly (`localhost:6000/x` — it already maps absolute loopback to that form; covered by test). The iframe engine (`web-frame-iframe.tsx`), engine selection in `iframe-window.tsx`, and address-bar writes (`onWriteUrl` → backend `/proxy/N` slot storage) are UNCHANGED.

- **GIVEN** a web tab whose stored slot is `/proxy/6000/` on a host in `proxy` mode
- **WHEN** the native engine mounts
- **THEN** the guest is created with `http://localhost:6000/` and the address bar shows `localhost:6000/`

### E2E & Specs

#### R15: `web-native.spec.ts` updated for literal-URL guests
`app/desktop/tests/e2e/web-native.spec.ts` MUST be updated for the new guest URLs: on the loopback e2e hosts the mode is `direct`, so guests load literal `http://localhost:<stubPort>/…` URLs instead of the host-origin `/proxy/<stubPort>/` path — guest classification by URL and any `/proxy/` path assertions change accordingly. The constitution's Test Intent Comments rule applies: every modified/added `test()` carries the `Proves:`/`Steps:` JSDoc and the file header stays accurate.

- **GIVEN** the updated spec run by the desktop e2e lane
- **WHEN** a web tab stamped with the loopback stub opens on e2e-a
- **THEN** the guest is classified by its literal `localhost:<stubPort>` URL and all seven assertions hold

#### R16: `docs/specs/api.md` § Forward Proxy
`docs/specs/api.md` MUST gain a `§ Forward Proxy` section: the transport wrapper (ahead of the router, own recovery/logging), the detection table (CONNECT authority-form / absolute-form / passthrough), CONNECT and absolute-form semantics (timeouts, 502s, hop-by-hop stripping, no content rewriting, close-driven tunnel cleanup), the NO destination policy with its verbatim rationale, statelessness, the `forwardProxy` health field, and the second §IX exception. Design Principles item 1 names the second exception; the Route Summary notes the transport (no route).

- **GIVEN** the updated spec
- **WHEN** a reader looks for the proxy contract
- **THEN** § Forward Proxy specifies it and the Route Summary notes it adds no route

#### R17: `docs/specs/window-views.md` § Engines
`docs/specs/window-views.md` § Engines MUST describe the native engine's `direct`/`proxy`/`legacy` modes and literal-URL loading: mode derivation (per-host, bridge-reported), `proxy` mode's full-remote traffic through the host's forward proxy, `legacy`'s unchanged `/proxy/{port}` path, and the stored-slot `/proxy/N` ↔ literal mapping at load time.

- **GIVEN** the updated spec
- **WHEN** a reader checks the native engine's URL handling
- **THEN** the three modes and their load targets are specified

### Non-Goals

- SOCKS5 / `ssh -D` support — rejected (covers only SSH hosts; Tailscale hosts would need a second exposed port).
- Destination allowlist/blocklist — rejected as security theater (intake § Assumptions 4).
- Migration of existing `persist:rk-web` cookies — per-host jars start fresh (Assumption 12).
- Per-host proxy opt-out toggle — the existing per-viewer iframe-engine opt-out is the escape hatch (Assumption 19).
- `docs/memory/` updates — the hydrate stage's job.
- `docs/wiki/web-tile-native-browser-studies.html` §9 note — optional, skipped (the study is a historical record).

### Design Decisions

#### Same-port HTTP forward proxy over SOCKS5
**Decision**: CONNECT + absolute-form plain HTTP on the existing listen port, handled by a wrapper ahead of the chi router.
**Why**: works identically for Tailscale and SSH hosts with zero new tunnels or exposed ports — an SSH host's existing `-L` forward already carries the rk port.
**Rejected**: SOCKS5 via `ssh -D` in `rk remote connect` (covers only SSH hosts; user agreed).
*Introduced by*: 260925-lqgp-web-tile-remote-proxy

#### No destination policy on the forward proxy
**Decision**: the proxy dials any destination; no allowlist/blocklist exists or is planned.
**Why**: anyone who can reach rk already has a shell on the host through the terminal relay (no auth — Tailnet-only / SSH-tunnel-only by deployment), so restriction adds no exposure; pages cannot emit CONNECT or absolute-form request lines, so no CSRF surface is created.
**Rejected**: a loopback-only or configurable destination policy (security theater per the reachability argument).
*Introduced by*: 260925-lqgp-web-tile-remote-proxy

#### Per-host guest partitions keyed on hosts.json id
**Decision**: `persist:rk-web:<host.id>`; the shared `persist:rk-web` partition is retired with no cookie migration.
**Why**: `host.id` is a `randomUUID()` stable across `setHostUrl`/SSH heal, so origin-keyed jars (which would reset on heal) lose; two hosts serving `localhost:6000` no longer collide.
**Rejected**: origin-keyed partitions (reset on SSH heal); cookie migration (the shared jar cannot be split per host correctly).
*Introduced by*: 260925-lqgp-web-tile-remote-proxy

#### Capability probe: health flag + live CONNECT, legacy fallback
**Decision**: proxy mode requires a numeric `forwardProxy` field on `GET /api/health` AND a successful raw-TCP `CONNECT` through the computed target; any failure falls back to `legacy` (today's `toProxySrc` path).
**Why**: the health flag alone cannot detect a front end that drops CONNECT (verified: Tailscale Serve answers CONNECT with its own 404); a live probe through the actual proxy path is the only check that proves the whole hop.
**Rejected**: health-flag-only gating (false positives behind CONNECT-dropping front ends); hard failure on probe miss (a broken tile where today's behavior still works).
*Introduced by*: 260925-lqgp-web-tile-remote-proxy

#### TLS-fronted hosts target the raw listen port over plain http
**Decision**: `https:` origins proxy via `http://<origin hostname>:<forwardProxy port>`.
**Why**: the TLS front end (Tailscale Serve) is the part that drops CONNECT, so an `https:` proxy scheme is rejected; tailnet hops are WireGuard-encrypted, so the plaintext hop adds no exposure.
**Rejected**: proxying through the `https:` origin itself (Serve cannot carry CONNECT — verified 2026-09-25).
*Introduced by*: 260925-lqgp-web-tile-remote-proxy

## Tasks

### Phase 1: Backend — forward proxy

- [x] T001 Implement `app/backend/api/forward_proxy.go`: `ForwardProxy(next http.Handler) http.Handler` wrapper — detection (CONNECT / absolute-form `http:` / passthrough), CONNECT tunnel (named 10 s dial timeout via `DialContext` on the request context, 502 pre-hijack on dial failure, hijack + `200 Connection Established`, buffered-bytes flush, bidirectional `io.Copy`, half-close-then-close cleanup, no fixed deadline), own panic recovery + `slog` logging. No subprocess, no state, no destination policy. <!-- R1 R2 R4 -->
- [x] T002 Absolute-form forwarding in `app/backend/api/forward_proxy.go`: `httputil.ReverseProxy` with a `Rewrite` setting the outbound URL to the absolute request URL, transport with `Proxy: nil` + 5 s dial / 10 s response-header timeouts (named constants, the `proxy.go` shape), explicit `Proxy-Connection`/`Proxy-Authorization` stripping, no `ModifyResponse`, upstream failure → 502. <!-- R3 -->
- [x] T003 Add the `forwardProxy` listen-port field (JSON number, config-derived per request) to `GET /api/health` in `app/backend/api/health.go`. <!-- R5 -->
- [x] T004 Wire `Handler: api.ForwardProxy(router)` in `app/backend/cmd/rk/serve.go` (~line 338). <!-- R1 -->
- [x] T005 Tests in `app/backend/api/forward_proxy_test.go`: CONNECT success + bidirectional bytes (incl. a WebSocket-over-CONNECT upgrade echo), dial failure → 502, close-driven cleanup (both conns close, no leaked goroutines), absolute-form forward (hop-by-hop + proxy header stripping, verbatim body, upstream failure → 502, `Proxy: nil` — daemon `HTTP_PROXY` env ignored), non-proxy passthrough to the router; extend `app/backend/api/health_test.go` for the `forwardProxy` field. Run `env -u TMUX -u TMUX_PANE just test-backend`. <!-- R2 R3 R5 -->

### Phase 2: Desktop — per-host proxied guest sessions

- [x] T006 New electron-free pure module `app/desktop/src/web-proxy.ts` + `web-proxy.test.ts` (node --test over compiled output, the package's convention): `guestPartitionName(hostId)` → `persist:rk-web:<host.id>`; `WebProxyMode = "direct" | "proxy" | "legacy"`; `webProxyModeFor(host, localOrigin, probeOk)` mirroring `interstitialKindFor`'s ordering (non-empty `remote` ⇒ remote first; then `url === localOrigin` (non-null) ⇒ local; then localOrigin null && loopback ⇒ local; local ⇒ `direct`, remote/url ⇒ probe-gated `proxy`/`legacy`); `proxyRulesFor(hostUrl, advertisedPort)` (http origin ⇒ origin host:port; https origin ⇒ `http://<hostname>:<advertisedPort>`, null port ⇒ null); `setProxyConfigFor(mode, rules)`. Tests cover every arm incl. the SSH-host-is-never-direct case. <!-- R7 R8 R9 -->
- [x] T007 `app/desktop/src/main.ts`: `guestSession(host)` per-host session cache replacing the single `GUEST_PARTITION` (deny-all permission handler per session; hardening unchanged); capability probe (`probeForwardProxy` — health `forwardProxy` gate + raw `node:net` CONNECT to `127.0.0.1:<forwardProxyPort>` against the computed target, ~5 s bounded, cached per (hostId, url)); `ensureHostProxy(host)` awaiting `session.setProxy` before first guest load, re-derived on `setHostUrl`/SSH heal; `web:mode` IPC handler resolving `{ ok: true, mode }` for the sender's host after proxy state settles; `web:create` awaits `ensureHostProxy` before `createWebView`. <!-- R7 R9 R10 R11 -->
- [x] T008 `app/desktop/src/preload.ts`: additive `mode()` invoker on the `web` group (`web:mode`). <!-- R11 -->
- [x] T009 `<-loopback>` verification: new `app/desktop/tests/e2e/web-proxy.spec.ts` — a spec-owned recording HTTP proxy (node:http) + guest session configured `fixed_servers` + `proxyBypassRules: "<-loopback>"`; loading `http://localhost:<stubPort>/` in a guest on that session MUST reach the recording proxy as an absolute-form request. Full Proves/Steps intent comments + file header. If Electron fails to honor it, implement the PAC-script or webRequest fallback in `web-proxy.ts` and record the outcome. <!-- R12 -->

### Phase 3: Frontend — native engine literal URLs

- [x] T010 `app/frontend/src/lib/web-url.ts`: `toNativeSrc(url, mode)` pure helper (R13 semantics — reuse the `toWebAddTarget` inverse for `/proxy/N` slots) + Vitest cases in `web-url.test.ts` (all three modes × proxy-path / absolute-loopback / external / relative / present inputs; `displayForm` on a literal loopback URL). <!-- R13 -->
- [x] T011 `app/frontend/src/lib/shell.ts`: additive `web.mode` narrowing + `shellWebMode(): Promise<WebProxyMode>` (absent invoker / denial / malformed ⇒ `"legacy"`); `app/frontend/src/components/web-frame-native.tsx`: mount effect awaits the mode before computing `absoluteUrl = new URL(toNativeSrc(url, mode), window.location.origin).href` (unmount-safe), legacy path byte-identical to today. Run `just test-frontend` + `tsc --noEmit`. <!-- R11 R14 -->

### Phase 4: Governance, specs, e2e

- [x] T012 Constitution amendment in `fab/project/constitution.md`: Principle IX second exception (intake § 2 text), "One documented exception:" reworded for two, governance line 1.13.0 / Last Amended 2026-09-25. <!-- R6 -->
- [x] T013 [P] `docs/specs/api.md`: § Forward Proxy + Design Principles + Route Summary per R16. <!-- R16 -->
- [x] T014 [P] `docs/specs/window-views.md` § Engines per R17. <!-- R17 -->
- [x] T015 Update `app/desktop/tests/e2e/web-native.spec.ts` for literal-URL guests (direct mode on loopback e2e hosts): guest classification by literal `localhost:<stubPort>` URL instead of the `/proxy/<stubPort>/` path; intent comments updated per the constitution rule. Run the single spec through the desktop e2e recipe. <!-- R15 -->

## Execution Order

- T001 → T002 (same file) → T004; T003 independent of T001/T002; T005 last in the phase (tests everything)
- T003 blocks T007 (the probe reads the `forwardProxy` health field)
- T006 blocks T007 (main.ts consumes the pure module); T007 blocks T008/T009
- T008 blocks T011 (the bridge invoker the SPA narrows); T010 independent of T008
- T012–T014 [P] may run alongside Phases 1–3; T015 after T007 (needs the new mode behavior in the lane)

## Acceptance

### Functional Completeness

- [x] A-001 R1: `api.ForwardProxy(router)` wraps the daemon's handler in `serve.go`; proxy-shaped requests never reach chi; origin-form traffic is unchanged
- [x] A-002 R2: CONNECT dials with a named timeout, tunnels bytes both ways (WebSocket included), 502s on dial failure, and cleans up both connections close-driven with no fixed deadline
- [x] A-003 R3: absolute-form requests forward with hop-by-hop/proxy headers stripped, `Proxy: nil`, verbatim responses, and 502 on upstream failure
- [x] A-004 R4: no destination policy exists anywhere in the proxy path; the proxy spawns no subprocess and holds no state beyond live connections
- [x] A-005 R5: `GET /api/health` carries a numeric `forwardProxy` listen-port field
- [x] A-006 R6: constitution.md Principle IX documents two exceptions; version 1.13.0, Last Amended 2026-09-25
- [x] A-007 R7: guests run in `persist:rk-web:<host.id>` partitions with deny-all permissions and no preload; the old shared partition is untouched on disk
- [x] A-008 R8: `web-proxy.ts` derives `direct`/`proxy`/`legacy` with remote-field-first ordering; an SSH host never derives `direct`
- [x] A-009 R9: `proxy` mode applies `fixed_servers` + `proxyBypassRules: "<-loopback>"` to the host session before the first guest load; https origins target `http://<hostname>:<advertised port>`; re-application happens on URL change
- [x] A-010 R10: proxy mode requires both the health `forwardProxy` field and a successful live CONNECT probe; any failure yields `legacy`
- [x] A-011 R11: `runkitShell.web.mode()` resolves the per-host mode; shells without the channel read as `legacy` in the SPA
- [x] A-012 R12: an e2e spec proves `http://localhost:<port>` in a `<-loopback>`-configured guest session reaches the proxy; the outcome is recorded
- [x] A-013 R13: `toNativeSrc` maps `/proxy/N/rest` ↔ literal loopback per mode with Vitest coverage
- [x] A-014 R14: the native engine loads literal URLs in `direct`/`proxy` and the `/proxy/N` path in `legacy`; iframe engine and address-bar writes unchanged
- [x] A-015 R15: `web-native.spec.ts` classifies guests by literal URL and passes on the desktop e2e lane
- [x] A-016 R16: `docs/specs/api.md` § Forward Proxy exists with the detection table, semantics, no-policy rationale, and Route Summary note
- [x] A-017 R17: `docs/specs/window-views.md` § Engines documents the three modes and literal-URL loading

### Behavioral Correctness

- [x] A-018 R2: an HMR-class long-lived WebSocket tunneled over CONNECT is not cut by any fixed deadline (close-driven lifetime only)
- [x] A-019 R14: stored `@rk_win_web_<n>` values remain `/proxy/N/…` on disk — the same tab works in a browser viewer's iframe engine

### Scenario Coverage

- [x] A-020 R8: unit tests cover: SSH host (remote field + loopback origin) → proxy; local daemon origin match → direct; probe failure → legacy; https origin without advertised port → legacy
- [x] A-021 R2/R3: Go tests cover CONNECT success/failure/cleanup, absolute-form forwarding incl. header stripping, and non-proxy passthrough

### Edge Cases & Error Handling

- [x] A-022 R10: older rk server (no `forwardProxy` field) → `legacy`, no probe attempted; CONNECT-dropping TLS front end → probe fails → `legacy`
- [x] A-023 R2/R3: dial refusal and mid-tunnel close leave no leaked goroutines or sockets
- [x] A-024 R9: a guest created while `setProxy` is still resolving never loads unproxied (creation awaits the apply)

### Code Quality

- [x] A-025 Pattern consistency: proxy code follows `proxy.go` transport/timeout shape; desktop pure logic is electron-free in its own module like `views.ts`/`web-views.ts`; frontend helper lives in `web-url.ts` beside `toProxySrc`
- [x] A-026 No unnecessary duplication: `toNativeSrc` reuses the `toWebAddTarget` inverse mapping; the mode derivation reuses `interstitialKindFor`'s ordering rather than inventing a second locality rule
- [x] A-027 Named constants for every timeout/bound (no magic numbers); no shell-string subprocess construction anywhere
- [x] A-028 New features carry tests (Go `_test.go`, Vitest, node --test, desktop e2e) per the test strategy

### Security

- [x] A-029 R1/R4: proxy dials use `net.Dialer` timeouts and no subprocess (Constitution I); no route or CORS change (Constitution IX exception is transport-scoped)
- [x] A-030 R7: guest sessions keep `sandbox` + `contextIsolation` + `nodeIntegration: false` + no preload + deny-all permissions

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the retired `GUEST_PARTITION` / `guestSessionRef` shared-partition code in `app/desktop/src/main.ts` was removed in the same diff, not left behind; `toProxySrc` remains live for the iframe engine and `legacy` mode).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The wrapper is `api.ForwardProxy(router)` wired at `serve.go`'s `http.Server.Handler`; tests exercise the wrapper directly around a router from `NewRouter`/`NewRouterAndServer` | Intake names this shape ("name indicative"); serve.go is the single construction site and the wrapper is plain `http.Handler`, so tests need no serve.go seam | S:85 R:85 A:90 D:85 |
| 2 | Confident | Absolute-form forwarding uses `httputil.ReverseProxy` with `Rewrite` (it already strips hop-by-hop headers) plus explicit `Proxy-Connection`/`Proxy-Authorization` removal and a `Proxy: nil` transport | Intake names it "one acceptable implementation"; reusing the stdlib machinery matches `proxy.go`'s precedent and minimizes hand-rolled header logic | S:70 R:75 A:80 D:70 |
| 3 | Confident | CONNECT tunnels have no idle cap — lifetime is purely close-driven | Intake leaves the idle cap to the plan; HMR WebSockets can idle quietly for minutes, so any fixed cap kills live tunnels; the daemon already accepts long-lived `/ws/*` connections | S:60 R:75 A:70 D:65 |
| 4 | Confident | Mode exposure channel is an additive `web.mode()` invoker (IPC `web:mode`) resolving `{ ok: true, mode }`, narrowed separately from `isWebBridge` so old shells read as `legacy` | Intake leaves "query vs `web:create` result field" to the plan; a query is known BEFORE the URL is computed (a create-result field arrives after the load decision), and the additive-narrowing pattern is established in `shell.ts` | S:60 R:75 A:75 D:65 |
| 5 | Confident | Probe = health `forwardProxy` gate + raw-TCP `CONNECT 127.0.0.1:<forwardProxyPort>` to the computed target (absolute-form GET cannot distinguish: chi would answer `/api/health` normally on an old server) | The CONNECT authority `127.0.0.1:<own listen port>` is listening on every rk host (itself), so one probe shape covers tunnel, direct, and raw-port targets | S:60 R:70 A:65 D:60 |
| 6 | Confident | The retired `persist:rk-web` partition's on-disk directory is left alone (no cleanup code) | Assumption 12 ("the plan decides"); no rk-owned data lives there and Electron GCs nothing user-visible | S:60 R:80 A:70 D:65 |
| 7 | Confident | The `forwardProxy` health field is ALWAYS present on this build (= the listen port), not gated on anything; absence means "older server" | The proxy is unconditional once shipped, so the field needs no condition; the desktop treats absence as no-capability | S:65 R:75 A:75 D:65 |
| 8 | Certain | Timeout values: CONNECT dial 10 s; forward transport mirrors `proxy.go` (5 s dial, 10 s response header) — all named constants | Intake's "e.g. 10 s" for CONNECT; the transport shape is the file's existing precedent | S:75 R:85 A:85 D:80 |
| 9 | Confident | The `<-loopback>` verification lives in a new `web-proxy.spec.ts` with a spec-owned recording proxy, separate from the updated `web-native.spec.ts` | Keeps the smoke set's fixture shape untouched and makes the verification assertion (request REACHED the proxy) explicit and independently rerunnable | S:55 R:75 A:70 D:60 |

9 assumptions (2 certain, 7 confident, 0 tentative).
