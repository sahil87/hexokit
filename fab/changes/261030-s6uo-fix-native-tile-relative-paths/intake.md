# Intake: Fix native web tile rk-relative addresses in proxy mode

**Change**: 261030-s6uo-fix-native-tile-relative-paths
**Created**: 2026-10-30

## Origin

Promptless dispatch (`/fab-draft`-style Create-Intake, `{questioning-mode} = promptless-defer`) carrying a description synthesized from a live debugging conversation. The diagnosis below was verified in that session; the fix direction was agreed there.

> **Bug:** In the desktop (Electron) shell, the native web tile fails to load rk-relative tab addresses such as `/present/runKit/<hash>/agents-settings-mock.html` when the shell is connected to a remote rk host via a public front-end hostname that the rk host itself cannot resolve. Observed: the tile shows "runner2.bat-ordinal.ts.net can't be reached — tunnel connection failed".
>
> **Diagnosed root cause (verified in-session):**
> 1. The shell's host URL is `https://runner2.bat-ordinal.ts.net` — a Tailscale Service (`svc:runner2`) that `tailscale serve` on the rk host (`dev-ws-sahil02`) proxies to `http://localhost:3000`. The viewer's Mac resolves it; the rk host itself does not (`getent hosts runner2.bat-ordinal.ts.net` returns nothing there).
> 2. The tab's stored address (`@rk_win_web_1`) is the relative path `/present/runKit/f65b8ea5966f/agents-settings-mock.html?v=…`.
> 3. `app/frontend/src/components/web-frame-native.tsx` (~line 301) does `new URL(toNativeSrc(url, mode), window.location.origin).href`, so the relative path becomes `https://runner2.bat-ordinal.ts.net/present/…`.
> 4. For a remote host the shell's web proxy mode is `proxy` (`app/desktop/src/web-proxy.ts` `webProxyModeFor`): guest traffic goes to a loopback proxy listener (`app/desktop/src/tunnel-proxy.ts`) and rides `/ws/tunnel` to the rk server, which dials the target from the rk host. The rk host can't resolve its own public name → dial fails → Chromium ERR_TUNNEL_CONNECTION_FAILED.
> 5. `toNativeSrc` in `app/frontend/src/lib/web-url.ts` (~line 437) already embodies the right principle — "in direct/proxy the guest session resolves loopback on the rk host" — and rewrites stored `/proxy/{port}` slots to `http://localhost:{port}` via `toWebAddTarget`. But every other rk-relative path (e.g. `/present/...`) passes through unchanged and is resolved against the viewer-side public origin. In a browser viewer (iframe engine) it works because the viewer resolves the name itself.
>
> **Agreed fix direction:** In `proxy` mode, resolve rk-relative addresses (paths beginning with `/`, other than the already-handled `/proxy/{port}` form) against the rk daemon's own loopback origin as seen from the rk host — `http://localhost:<daemon serve port>` — instead of `window.location.origin`. The shell/frontend needs to learn the daemon's listen port (suggested source: the health response's `tunnel` field). `direct` mode unchanged; `legacy` mode (`toProxySrc`) out of scope.
>
> **Rejected alternative:** a backend short-circuit in the tunnel handler that redirects dials of the server's own public hostname to loopback — the guest speaks TLS to `runner2:443` (https front end), so swapping a plain-HTTP `localhost:3000` underneath would break the TLS handshake.
>
> **Constraints:** Constitution (exec.CommandContext if any backend change; POST-only mutations; Disposable Daemon). Desktop-shell-affecting ⇒ Constitution § PR Evidence (shell recording via `just demo`, spec under `app/desktop/tests/demo/`); new behavior needs tests (vitest for `toNativeSrc`/URL resolution; `node --test` for desktop pure modules if touched). Reproducing the bug requires a host origin unresolvable from the rk host — the demo/test rig may need to simulate it.

Intake-time code investigation (this session) confirmed the port source already exists — see § What Changes › Port source.

## Why

**Problem.** In the desktop shell's native web engine, every rk-relative tab address other than `/proxy/{port}` — `rk present` files (`/present/<session>/<hash>/<file>`), boards, any root-relative rk route — is resolved against `window.location.origin`, i.e. the *viewer-side* origin the shell was pointed at. In `proxy` mode the guest's request is not made by the viewer: it rides `/ws/tunnel` and the rk server dials the target **from the rk host**. When that origin is a public front end the rk host cannot resolve for itself (Tailscale Service names, split-horizon DNS, a reverse proxy only reachable from outside), the dial fails and the tile shows "can't be reached — tunnel connection failed". `rk present` — the primary way agents show visual content to the user — is therefore broken for every desktop user connected through such a front end, while the same tab works in a browser viewer.

**Consequence of not fixing.** Remote-host desktop users cannot view presented artifacts in the native tile at all; the only workaround is opening the tab in a browser. It also likely affects SSH remote hosts (see § Impact › SSH remote hosts): their shell origin is `http://127.0.0.1:<local_port>` (the `ssh -L` local end, 3100–3199), a port that need not be listening on the rk host.

**Why this approach.** The native engine's own contract (`toNativeSrc` docstring) is already "in direct/proxy the guest session resolves loopback on the rk host"; `/proxy/{port}` slots honor it, relative rk paths simply never got the same treatment. Resolving them against the daemon's loopback origin — the exact `127.0.0.1:<listen port>` target the shell's capability probe already proved dialable through the tunnel — makes the guest's request independent of any DNS name. The backend tunnel short-circuit was rejected (TLS: the guest's CONNECT to `runner2:443` expects a TLS server; substituting plain-HTTP loopback underneath breaks the handshake). Fixing it at the URL-resolution seam is a pure, unit-testable frontend change.

## What Changes

### Port source — health `tunnel` (already present; no backend change)

`app/backend/api/health.go` `handleHealth` already returns `"tunnel": s.listenPort` — the daemon's startup-bound listen port, **always present** as a JSON number on current builds (test: `TestHealthEndpointTunnel` in `health_test.go`). The shell's `probeTunnel` (`app/desktop/src/main.ts`) gates `proxy` mode on exactly this field AND a WebSocket round-trip through `/ws/tunnel?target=127.0.0.1:<tunnel>` answering `GET /api/health` with `HTTP/1.1 200`. Therefore **`proxy` mode implies `http://127.0.0.1:<tunnel>` is proven dialable from the rk host through the tunnel.** No backend change is needed.

### Seam — the SPA reads its own `/api/health` (frontend-only)

The SPA learns the port from its own same-origin `GET /api/health` (`getHealth()` in `app/frontend/src/api/client.ts`, which uses `deduplicatedFetch`), not from the shell:

- Add `tunnel?: number` to `HealthResponse` in `app/frontend/src/api/client.ts` (documented as the daemon's startup-bound listen port; optional in the type so an unexpected/older response degrades rather than throws).
- Derive a **daemon loopback origin** `http://127.0.0.1:<tunnel>` when `tunnel` is an integer in `1..65535`; otherwise `null`.
- Memoize the derivation at module level (one in-flight/settled promise per SPA lifetime is acceptable: the listen port is startup-bound and the SPA is served by that daemon — a daemon restart on a new port reloads/reconnects the SPA anyway). Exact placement (a small helper in `lib/shell.ts` beside `shellWebMode`, or in `web-frame-native.tsx`) is an apply-time call; it MUST be fetched only when `mode === "proxy"` so `direct`/`legacy`/browser viewers pay nothing.

Rationale for SPA-side over extending the shell's `web:mode` envelope with the port: the SPA and the rk backend are the same build (the SPA is served by the rk host), so `tunnel` is guaranteed; the Electron shell is a separately installed binary that may lag — a `web:mode`-carried port would need a fallback path for every shell that reports `proxy` but predates the new field. The SPA-side seam works with every shell that already reports `proxy`, and touches no `app/desktop/src/` file. (Alternative kept on record: thread the port the probe already parsed through `settleHostProxy` → `HostProxyState` → `WebModeResult { ok, mode, loopbackOrigin }` → `isWebModeOk` narrowing; rejected for the skew reason above, not for correctness.)

### `toNativeSrc` — resolve rk-relative paths against the daemon loopback origin in `proxy` mode

`app/frontend/src/lib/web-url.ts` stays pure/DOM-free. Extend `toNativeSrc` with the daemon loopback origin as an input:

```ts
export function toNativeSrc(
  url: string,
  mode: WebNativeMode,
  daemonOrigin: string | null = null,
): string {
  if (mode === "legacy") return toProxySrc(url);
  const target = toWebAddTarget(url);            // /proxy/{port} → http://localhost:{port}/…
  if (mode === "proxy" && daemonOrigin !== null && isRootRelative(target)) {
    return new URL(target, daemonOrigin).href;   // /present/… → http://127.0.0.1:3000/present/…
  }
  return target;
}
```

(`isRootRelative` = starts with a single `/`, not `//` — the existing `isAllowedUrl` rule; reuse/extract rather than duplicate.)

Behavior matrix (daemon origin `http://127.0.0.1:3000`):

| Stored address | `direct` | `proxy` (origin known) | `proxy` (origin `null`) | `legacy` |
|---|---|---|---|---|
| `/proxy/6000/docs?x=1` | `http://localhost:6000/docs?x=1` | `http://localhost:6000/docs?x=1` (unchanged) | same | `/proxy/6000/docs?x=1` |
| `/present/runKit/f65b8ea5966f/agents-settings-mock.html?v=1` | unchanged (relative) | `http://127.0.0.1:3000/present/runKit/f65b8ea5966f/agents-settings-mock.html?v=1` | unchanged (today's behavior) | unchanged |
| `/board/runKit` | unchanged | `http://127.0.0.1:3000/board/runKit` | unchanged | unchanged |
| `http://localhost:6000/x` | unchanged | unchanged | unchanged | `/proxy/6000/x` |
| `https://shll.ai/rk/skill` | unchanged | unchanged | unchanged | unchanged |

- `direct` is deliberately unchanged: there `window.location.origin` IS the local daemon, so the caller's `new URL(…, window.location.origin)` already lands on loopback.
- `legacy` is exactly `toProxySrc` — out of scope, unchanged.
- `null` origin (health fetch failed, field absent/invalid) degrades to today's behavior — never a thrown error or a blank tile.
- Update the module header's item 6 and the `toNativeSrc` docstring to state the new `proxy` arm.

### Caller — `web-frame-native.tsx`

At the create site (~line 296–305), after `const mode = await shellWebMode()`: when `mode === "proxy"`, await the memoized daemon loopback origin, then `new URL(toNativeSrc(url, mode, daemonOrigin), window.location.origin).href` (the base still resolves the `direct`/null-origin relative case). Respect the existing `cancelled` check after every await. This is the only `toNativeSrc` call site.

### Reverse mapping — `toTracked` must fold the daemon loopback origin back to root-relative

`toTracked` (web-frame-native.tsx ~line 99) maps a guest's navigated URL to root-relative only when `parsed.origin === window.location.origin`. After this change a proxy-mode guest on a `/present/…` page reports `http://127.0.0.1:3000/present/…`, which would (a) show a raw loopback URL in the address bar and (b) break the `↗` open-external action (`iframe-window.tsx` `window.open(trackedLocation ?? url)` — on the viewer's Mac `127.0.0.1:3000` is the wrong machine), and (c) leak an absolute loopback URL into the edit-reveal/commit path. `toTracked` MUST treat the daemon loopback origin (when known) as same-origin too, returning `pathname + search + hash`. Prefer a pure helper in `web-url.ts` (e.g. `toTrackedLocation(absolute, viewerOrigin, daemonOrigin)`) so it is vitest-covered.

### Tests

- **vitest — `app/frontend/src/lib/web-url.test.ts`**: the existing case "direct/proxy: every other address kind passes through unchanged" asserts `/present/…` and `/board/runKit` pass through in `proxy` — split it: `direct` keeps the pass-through assertions; `proxy` with a daemon origin asserts the loopback-absolute results above (incl. query/hash preservation, `/present/@320/…` form); `proxy` with `null` origin asserts pass-through; `/proxy/{port}` and absolute URLs unchanged in every mode; `//evil.example/x` (scheme-relative) is NOT rewritten. Plus cases for the reverse-mapping helper (daemon-origin URL → root-relative; viewer-origin URL → root-relative; foreign origin → absolute; unparsable → raw).
- **vitest — health/daemon-origin derivation**: `tunnel` valid → `http://127.0.0.1:<n>`; absent, non-integer, `0`, `65536` → `null`.
- **No `node --test` change expected** — no `app/desktop/src/` pure module is touched under the chosen seam.

### PR evidence — shell recording simulating an rk-host-unresolvable origin

Constitution § PR Evidence: this changes the native web-tile engine (a shell-only SPA code path) ⇒ `just demo` shell recording with a spec under `app/desktop/tests/demo/`, Before (base branch, `--before` pass) and After. The bug needs a host origin the **shell** resolves but the **rk server** cannot. Proposed rig:

- Launch the demo shell with a Chromium switch mapping a fake name to the rig: `--host-resolver-rules=MAP rk-demo.test 127.0.0.1` (extend `launchShell` in `app/desktop/tests/e2e/_shell.ts` with optional extra args, applied on both the current-tree and `--before`/`appDir` launch paths).
- Seed the host as `http://rk-demo.test:<rig port>` — not loopback and not `localDaemonOrigin()`, so `webProxyModeFor` classifies it remote → probe (`net.fetch` honors the resolver rule; the probe's tunnel target is `127.0.0.1:<tunnel>`, so it passes) → `proxy`.
- Stamp a web tab with an `rk present`-style relative address (or any root-relative rk path). Before: the guest dials `rk-demo.test` from the Go server → unresolvable → "tunnel connection failed". After: the guest loads via `127.0.0.1:<port>`.
- Also re-run the existing `web-tile-native` demo/e2e lanes to confirm `direct` mode is unaffected. The web (iframe) engine path is unchanged, so no web-viewer recording is required beyond stating so.

If the resolver-rule rig proves infeasible at apply time, the PR body MUST state the limitation and the missing evidence per § PR Evidence (not silently skip).

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) the native engine and Address model (`lib/web-url.ts`) entries — `toNativeSrc`'s `proxy` arm now resolves root-relative rk paths against the daemon loopback origin (`http://127.0.0.1:<health.tunnel>`), the null-origin fallback, and `toTracked`'s reverse mapping of the daemon loopback origin.
- `run-kit/desktop-shell`: (modify) the `proxy`-mode description — note that guest URLs for rk-relative addresses target the daemon's loopback origin (not the viewer-side host origin), why (rk host may not resolve its own public front-end name), and the rejected tunnel short-circuit (TLS).

## Impact

- **Code**: `app/frontend/src/lib/web-url.ts` (+ `web-url.test.ts`), `app/frontend/src/components/web-frame-native.tsx`, `app/frontend/src/api/client.ts` (`HealthResponse.tunnel`), possibly `app/frontend/src/lib/shell.ts` (memoized daemon-origin helper). Demo: new spec under `app/desktop/tests/demo/` and an optional-args extension to `app/desktop/tests/e2e/_shell.ts` `launchShell`. No backend change, no new route, no `app/desktop/src/` change.
- **Engines**: native engine only. The iframe engine (browser viewer, and `legacy` mode) is untouched.
- **SSH remote hosts** (likely also fixed — unverified): an SSH host's shell origin is `http://127.0.0.1:<local_port>` (3100–3199, the `ssh -L` local end; `docs/memory/run-kit/remote-hosts.md`), and in `proxy` mode a relative path currently resolves to that port **on the rk host**, where the daemon generally listens on a different port. Using `health.tunnel` targets the remote daemon's real port.
- **Guest origin change**: in `proxy` mode, rk-relative pages now load with origin `http://127.0.0.1:<port>` instead of the public front end. Same-origin relative subresources resolve correctly. Pages that open WebSockets/API calls back to rk now present `Origin: http://127.0.0.1:<port>` — expected to pass the daemon's Origin policy (loopback), but apply should confirm against `api-and-sockets` WebSocket Origin policy if an rk SPA route is loaded in a tile. Cookies/localStorage are keyed per guest partition (per host id), so the origin shift only re-keys storage within that partition.
- **Security**: no new dial capability — the tunnel already accepts `127.0.0.1:<port>` targets (the probe uses it). The SPA does not trust any viewer-supplied input for the origin; it comes from the rk daemon's own health response and is validated as an integer port.

## Open Questions

- Should `proxy` mode also rewrite **absolute** URLs on the viewer's own origin (e.g. a user-typed `https://runner2.bat-ordinal.ts.net/present/…`) to the daemon loopback origin? They fail the same way today; stored addresses are normally root-relative, so this is a scope extension, left out pending confirmation.
- Does the `--host-resolver-rules` rig reproduce the failure end to end in `just demo` (both the `--before` base-tree launch and the current tree)?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause is relative rk paths resolved against the viewer-side origin and dialed from the rk host in `proxy` mode | Verified in-session (getent, stored `@rk_win_web_1`, code path at web-frame-native.tsx:301); re-confirmed by reading `toNativeSrc`/`web-proxy.ts` | S:95 R:85 A:95 D:95 |
| 2 | Certain | Reject the backend tunnel short-circuit (redirect own-public-hostname dials to loopback) | Discussed — guest speaks TLS to `:443`; plain-HTTP loopback underneath breaks the handshake | S:90 R:80 A:90 D:90 |
| 3 | Certain | Port source is the existing health `tunnel` field — no backend change | Code read: `handleHealth` always emits `"tunnel": s.listenPort`; `TestHealthEndpointTunnel` covers it | S:85 R:90 A:95 D:90 |
| 4 | Certain | `direct` mode unchanged; `legacy` (`toProxySrc`) unchanged and out of scope | Discussed — in `direct` `window.location.origin` is the local daemon; legacy explicitly out of scope | S:90 R:90 A:90 D:90 |
| 5 | Certain | `/proxy/{port}` slots keep mapping to `http://localhost:{port}` via `toWebAddTarget` | Existing behavior, already correct per the agreed principle | S:90 R:90 A:95 D:95 |
| 6 | Confident | Seam: SPA reads its own `/api/health` `tunnel` (frontend-only) rather than extending the shell's `web:mode` envelope | SPA + backend ship as one build so the field is guaranteed; shell may lag and would need a fallback; user delegated "pick the cleanest seam" | S:60 R:80 A:65 D:50 |
| 7 | Confident | Daemon loopback origin is `http://127.0.0.1:<tunnel>` (not `localhost`) | Exactly the target `probeTunnel` proves dialable through the tunnel before `proxy` is granted; avoids `localhost` → `::1` ambiguity on the rk host | S:55 R:85 A:75 D:60 |
| 8 | Certain | Null/invalid daemon origin degrades to today's behavior | Matches the shell bridge's never-throw degrade convention (`shellWebMode` → `legacy`) | S:60 R:90 A:85 D:80 |
| 9 | Confident | `toTracked` folds the daemon loopback origin back to root-relative | Otherwise the address bar shows a raw loopback URL and `↗` open-external targets the viewer's own 127.0.0.1 | S:55 R:85 A:80 D:75 |
| 10 | Certain | Keep `web-url.ts` pure: pass the daemon origin into `toNativeSrc` as a parameter; tests in `web-url.test.ts` | Module contract is DOM-free with colocated tests; code-quality requires tests for bug fixes | S:70 R:90 A:85 D:75 |
| 11 | Confident | Memoize the health-derived origin once per SPA lifetime, fetched only in `proxy` mode | Listen port is startup-bound (health.go comment); a daemon restart reconnects the SPA | S:50 R:85 A:70 D:65 |
| 12 | Confident | Shell recording rig simulates the unresolvable front end via Chromium `--host-resolver-rules=MAP rk-demo.test 127.0.0.1` on the demo shell launch, host seeded as `http://rk-demo.test:<port>` | Plausible (Chromium switch reaches `net.fetch`; Go server cannot resolve `.test`), but unverified; needs a `launchShell` args extension | S:45 R:80 A:45 D:45 |
| 13 | Confident | Absolute URLs on the viewer's own origin are NOT rewritten (scope limited to root-relative paths) | Description scopes the fix to paths beginning with `/`; extension listed in Open Questions | S:50 R:85 A:40 D:40 |
| 14 | Confident | SSH remote hosts in `proxy` mode share the bug and are fixed by the same change | Remote local_port (3100–3199) ≠ remote daemon port per remote-hosts memory; not reproduced | S:35 R:85 A:55 D:55 |

14 assumptions (7 certain, 7 confident, 0 tentative, 0 unresolved).
