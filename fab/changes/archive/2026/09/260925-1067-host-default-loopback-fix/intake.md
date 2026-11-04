# Intake: Host Default Loopback Fix

**Change**: 260925-1067-host-default-loopback-fix
**Created**: 2026-09-25

## Origin

> Host default fix (P2 of fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md). Committed .env sets RK_HOST=0.0.0.0 while the Go default is 127.0.0.1, and `just setup` copies it to .env.local, so every dev rig exposes the unauthenticated relay and the open /proxy route on all interfaces. Make the committed default 127.0.0.1 with 0.0.0.0 as a commented LAN/phone-testing example. Also reconcile portless loopback URLs: Go present.go proxies http://localhost/x as port 80 while the frontend web-url.ts classifies it external. This is a security fix — do not wait for anything. Read the whole plan file first for the rules table (D2 etc — rk/RK_*/@rk_*/rk-* are never renamed) and this row's full text.

One-shot `/fab-new` invocation. The plan row P2 (in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`) is the source: "Security fix — do not wait for anything", no dependencies, size XS. Binding rules from that plan: **D2** — every `RK_*` env var (incl. `RK_HOST`) is substrate and never renamed; rule **P** — `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` stay the only env forms. This change touches the *value* of `RK_HOST` in dev tooling, never its name.

## Why

1. **The problem.** The Go binary defaults to a loopback bind (`app/backend/internal/config/config.go:41` — `Host: "127.0.0.1"`; `rk serve --help` documents `RK_HOST … (default "127.0.0.1")`; `docs/specs/api.md:27` says the same). But every dev path overrides that to all-interfaces:
   - the committed `.env` sets `RK_HOST=0.0.0.0`; `.envrc` (direnv) loads `.env` then `.env.local`; `just setup` runs `[ -f .env.local ] || cp .env .env.local`, so every developer's `.env.local` inherits `0.0.0.0` too;
   - `scripts/dev.sh:27` falls back to `export RK_HOST="${RK_HOST:-0.0.0.0}"` when nothing is set (the CI / no-direnv path, which is what `just test-e2e`'s single-rig lane runs through `just dev`);
   - `scripts/test-e2e.sh:400–401` (multi-rig lane) hardcodes `RK_HOST=0.0.0.0` on both the per-rig Go backend and the per-rig Vite server.

   The run-kit backend has **no authentication**: the terminal relay (`/ws/terminals`), the whole `/api` surface, and the `/proxy/{port}/` route (which forwards to *any* loopback port on the box) are open to whoever can reach the socket. Bound to `0.0.0.0`, every dev rig (Vite on `RK_PORT` and the Go backend on `RK_PORT+1`) hands a shell and an SSRF-to-localhost pivot to anyone on the same LAN / café Wi-Fi.
2. **If we don't fix it.** Every `just dev` / `just test-e2e` rig on every developer machine keeps exposing a remote shell on all interfaces. The installed daemon is fine (Go default), so the exposure is purely a dev-tooling default — which is exactly why it is cheap and urgent.
3. **Why this approach.** Match the dev default to the binary's already-documented secure default, and keep LAN/phone testing a deliberate one-line opt-in (`.env.local` edit or `just dev --host 0.0.0.0`, which `dev.sh` already supports). Tailscale Serve (the documented remote-access path) proxies to loopback, so it keeps working with a loopback bind.

The second half — **portless loopback reconciliation** — is a correctness bug in the same `/proxy` family: the backend and frontend disagree on what `http://localhost/x` is.

- Go `internal/present/present.go` (`ParseTargetWithOrigins`, the `KindLocalURL` branch ~line 136–153): `http://` + host in `{localhost, 127.0.0.1, ::1}` → port from the URL, **else 80** → slot value `/proxy/80/x`. Pinned by `present_test.go:115` (`{"http://localhost/app", 80, "/app", "/proxy/80/app"}`). `https://` loopback is never rewritten (attached verbatim, external).
- Frontend `app/frontend/src/lib/web-url.ts` `loopbackPortOf(u)`: loopback host AND an explicit port → proxy; portless → `null` → **external**. Pinned by `web-url.test.ts` ("treats portless loopback absolute URLs as external", `proxyPortOf("http://localhost/")` → null, `toProxySrc("http://localhost/")` passthrough). `toProxySrc` has its own duplicate inline check with the same rule.

Consequence of the frontend rule: a stored/typed `http://localhost/x` is loaded by the iframe engine *verbatim*, i.e. against the **viewer's** machine, not the rk host — wrong for every remote (phone / Tailscale) viewer, and inconsistent with what `rk present http://localhost/x` stores. Worse, the WHATWG `URL` parser elides a default port, so `new URL("http://localhost:80/x").port === ""` — the frontend misclassifies even an **explicit** `:80` as external today.

**Direction: the frontend adopts the Go rule.** An `http:` URL with no port *means* port 80 by definition; the backend is the enforcement/storage side and already produces `/proxy/80/…`, which the frontend already classifies as proxy. Rejected alternative: make Go treat portless loopback as external — that would store a URL that silently targets the viewer's own machine, the exact remote-viewer bug above.

## What Changes

### 1. Committed `.env` — loopback default, LAN bind as a commented example

Current file:

```sh
# run-kit configuration
# Override locally via .env.local (gitignored)

# The port you open in your browser.
# Dev mode: Vite serves on this port, Go backend on PORT+1.
# Prod mode: Go backend serves on this port directly.
RK_HOST=0.0.0.0

# Optional OVERRIDE: point rk at an externally managed code-server …
# RK_CODE_SERVER_PORT=8080
```

The three "The port you open in your browser…" lines are an orphaned `RK_PORT` comment (no `RK_PORT=` line exists) sitting directly above `RK_HOST`, so they misdescribe the security-relevant line. Replace that block with an accurate `RK_HOST` block; keep the `RK_CODE_SERVER_PORT` block unchanged. Target shape (exact wording may be polished at apply, substance fixed):

```sh
# run-kit configuration
# Override locally via .env.local (gitignored)

# Interface to bind. Loopback only by default — run-kit has no auth, so an
# all-interfaces bind exposes the terminal relay, the API, and the /proxy
# route to anyone on your network. Remote access from your own devices goes
# through Tailscale Serve, which proxies to loopback.
RK_HOST=127.0.0.1
# LAN / phone testing without Tailscale (only on a network you trust); or
# one-off: just dev --host 0.0.0.0
# RK_HOST=0.0.0.0

# Optional OVERRIDE: … (unchanged)
# RK_CODE_SERVER_PORT=8080
```

Deleting the orphaned `RK_PORT` comment is also listed in plan row **C5** ("`.env` (delete the orphaned `RK_PORT` comment)"); this change does it now because it rewrites that block, and the plan's C5 row drops that item (see § 5).

### 2. `scripts/dev.sh` — loopback fallback

Line 27: `export RK_HOST="${RK_HOST:-0.0.0.0}"` → `export RK_HOST="${RK_HOST:-127.0.0.1}"`. The `--host HOST` flag (line 16) stays as the explicit opt-in. Update the usage comment on line 3 if helpful (`[--host HOST]` already documented). This is the path CI and any non-direnv shell take, so without it the `.env` edit alone leaves the no-direnv default open.

### 3. `scripts/test-e2e.sh` — multi-rig lane binds loopback

Lines 400–401: both `RK_HOST=0.0.0.0` → `RK_HOST=127.0.0.1` (backend `RK_PORT=$((_p+1))` spawn and the Vite `pnpm dev --port $_p` spawn). The comment above (line ~393: "The env mirrors what dev.sh gives `just dev` (RK_HOST, …)") stays true. Everything in the harness reaches the rigs over loopback: `wait_ready` curls `http://localhost:$port` + `/api/health`; Playwright `baseURL` is `http://localhost:${port}`; Vite's proxy targets `http://127.0.0.1:{RK_PORT+1}`. Chromium and curl try both `::1` and `127.0.0.1` for `localhost`, so a `127.0.0.1` bind is reachable — but **apply must verify with a real e2e run** (single spec in the default lane, plus one multi-rig run with `RK_E2E_WORKERS=2` on one spec) rather than assume it.

`app/frontend/vite.config.ts` already falls back to `host: process.env.RK_HOST ?? "127.0.0.1"` — no change.

### 4. Frontend `web-url.ts` — portless `http:` loopback is port 80

In `app/frontend/src/lib/web-url.ts`:

- `loopbackPortOf(u: URL)`: for a loopback hostname, return `Number(u.port)` when a port is present; when `u.port === ""` return **80 iff `u.protocol === "http:"`**, else `null` (portless `https:` loopback stays external — it matches Go, which attaches all `https://` verbatim). Update its doc comment ("Portless loopback is not proxied" is no longer true).
- `toProxySrc(url)`: stop duplicating the port check inline — route through `loopbackPortOf` so `http://localhost/x` → `/proxy/80/x` and `http://localhost` → `/proxy/80/`. Update the module header / function doc wording accordingly.
- `displayForm` and `webTabTitle` proxy branches currently build `` `localhost:${abs.port}…` `` from the raw `URL.port`; with a portless/elided-`:80` URL that would render `localhost:/x`. Use the resolved port (`loopbackPortOf(abs)`) so `http://localhost/x` displays `localhost:80/x`.
- `proxyPortOf("http://localhost/")` → `80` (falls out of `loopbackPortOf`).
- `classifyAddress("http://localhost/")` → `"proxy"`; `classifyAddress("https://localhost/")` → `"external"`.
- Out of scope, unchanged: `LOOPBACK_INPUT_RE` (bare `localhost:port` address-bar input still requires a port — a bare `localhost` word still rejects); `toNativeSrc` (absolute URLs pass through in `direct`/`proxy` mode — the native guest resolves loopback on the rk host, so port-80 semantics already hold); `toWebAddTarget` (only rewrites root-relative `/proxy/…`).

Tests in `app/frontend/src/lib/web-url.test.ts` flip to the new spec (Test Integrity — tests follow the spec):

| Current assertion | New assertion |
|---|---|
| `classifyAddress("http://localhost/")` → `"external"` ("treats portless loopback … as external") | → `"proxy"`; add `classifyAddress("http://localhost:80/x")` → `"proxy"` and `classifyAddress("https://localhost/")` → `"external"`; rename the `it()` |
| `proxyPortOf("http://localhost/")` → `null` | → `80` (move out of the "returns null for non-proxy" block) |
| `toProxySrc("http://localhost/")` → passthrough | → `"/proxy/80/"`; add `toProxySrc("http://127.0.0.1/x?a=1")` → `"/proxy/80/x?a=1"`; keep an `https://localhost/` passthrough case |
| (new) | `displayForm("http://localhost/x")` → `"localhost:80/x"`; `webTabTitle("http://localhost/x")` → `"localhost:80/x"` |

Go `present.go` needs **no behavior change** — it already is the rule. Optionally tighten its comment near `port := 80` to say the frontend mirrors it; `present_test.go:115` stays.

### 5. Plan doc bookkeeping (`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`)

Per the plan's pickup protocol ("Update the row and the Status line here when you start or finish"): mark row **P2** with this change's PR and status; update the Status paragraph's "P1/P2/P3 not started"; and remove the "`.env` (delete the orphaned `RK_PORT` comment)" item from row **C5**'s scope since this change does it.

### 6. Not in the repo: existing `.env.local` copies

`just setup` only copies when `.env.local` is absent, so already-created `.env.local` files keep `RK_HOST=0.0.0.0` (33 worktrees on this machine do). They are gitignored per-checkout files outside the change's reach; the change's ship summary tells the user, with a one-liner to fix them (e.g. `sed -i 's/^RK_HOST=0\.0\.0\.0$/RK_HOST=127.0.0.1/'` over the `.env.local` files). No doctor row is added (plan row doesn't ask for one; a deliberate LAN bind would warn forever).

## Affected Memory

- `run-kit/architecture/overview`: (modify) the Configuration paragraph (~line 17) and the `.env` Design Decision (~line 146) say `.env` defines `RK_PORT` and `RK_HOST`; make them present-true — `.env` commits `RK_HOST=127.0.0.1` (loopback; `0.0.0.0` a commented LAN opt-in), `dev.sh` falls back to `127.0.0.1`, `--host` is the one-off opt-in
- `run-kit/configuration`: (modify) the env-forms paragraph (~line 81) — note the committed dev default binds loopback, matching the code default
- `run-kit/ui/lenses-and-layout`: (modify) Address model (~line 54: `proxy` kind now includes portless `http:` loopback as port 80) and Proxy URL conversion (~line 68: "Portless loopback … pass through unchanged" → portless `http:` loopback maps to `/proxy/80/…`, portless `https:` passes through)
- `run-kit/architecture/testing`: (modify) the multi-rig lane paragraph (~line 52) only if it states the rig bind host; it currently says "env mirroring what `dev.sh` gives `just dev`", which stays true — check and leave if no host is stated

## Impact

- **Files**: `.env`, `scripts/dev.sh`, `scripts/test-e2e.sh`, `app/frontend/src/lib/web-url.ts`, `app/frontend/src/lib/web-url.test.ts`, optionally a comment in `app/backend/internal/present/present.go`; plan doc row edits.
- **No Go behavior change**, no API/route change, no env var renamed (D2 holds).
- **Behavior change (dev only)**: dev rigs are no longer reachable from other hosts on the LAN by default. Phone testing now needs Tailscale Serve, `just dev --host 0.0.0.0`, or `RK_HOST=0.0.0.0` in `.env.local`.
- **Behavior change (frontend)**: `http://localhost/x` / `http://localhost:80/x` addresses in a web tile ride `/proxy/80/x` (rk host's port 80) instead of loading from the viewer's machine; header badge shows proxy, display `localhost:80/x`.
- **Test gates**: `just test-frontend` (full Vitest, per project memory — scoped runs miss cross-file assertions); `go test ./internal/present/...` (unchanged, sanity); an e2e smoke on the default lane and one multi-rig run to prove the loopback bind is reachable by the harness.
- **Risk**: IPv6-first `localhost` resolution against a `127.0.0.1`-only bind. Chromium, curl, and Node ≥20 (happy-eyeballs) all fall back to IPv4; the e2e verification in § 3 settles it empirically.

## Open Questions

None blocking. The https-with-port divergence (frontend proxies `https://localhost:3000` → `/proxy/3000`, Go attaches it verbatim as external) is adjacent but outside this row's scope; left as-is and noted as a Non-Goal.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Committed `.env` sets `RK_HOST=127.0.0.1` with `RK_HOST=0.0.0.0` as a commented LAN/phone example | Stated verbatim in the user's request and plan row P2 | S:95 R:90 A:95 D:95 |
| 2 | Certain | `RK_HOST` keeps its name; only its dev-tooling value changes | Plan rules D2 and P: `RK_*` env vars are substrate, never renamed | S:90 R:85 A:95 D:95 |
| 3 | Confident | `scripts/dev.sh` fallback `${RK_HOST:-0.0.0.0}` also becomes `127.0.0.1` | Without it, CI and non-direnv shells still bind all interfaces — the row's goal ("every dev rig") is unmet by `.env` alone | S:70 R:90 A:85 D:85 |
| 4 | Confident | `scripts/test-e2e.sh` multi-rig lane `RK_HOST=0.0.0.0` (backend + Vite) becomes `127.0.0.1` | Same exposure; harness reaches rigs only over loopback; the lane's own comment says it mirrors dev.sh; verified by an e2e run at apply | S:65 R:90 A:80 D:80 |
| 5 | Confident | Reconcile direction: frontend adopts Go's rule (portless `http:` loopback = port 80); Go unchanged | http default port is 80 by definition; backend already stores `/proxy/80/…`; the external classification loads from the viewer's machine (wrong for remote viewers); WHATWG URL elides `:80`, so explicit `:80` is misclassified today too | S:70 R:85 A:80 D:70 |
| 6 | Confident | Portless `https:` loopback stays external in the frontend | Matches Go, which attaches every `https://` URL verbatim; only the portless `http:` case is in this row | S:60 R:90 A:80 D:75 |
| 7 | Confident | The https-with-explicit-port divergence (frontend proxies, Go attaches verbatim) is out of scope | The row names only portless URLs; changing https handling alters existing address-bar behavior and deserves its own row | S:55 R:85 A:70 D:65 |
| 8 | Confident | Delete the orphaned `RK_PORT` comment in `.env` now and drop that item from plan row C5 | This change rewrites that block and the comment misdescribes the security-relevant line; C5 already lists its deletion | S:55 R:95 A:80 D:75 |
| 9 | Confident | Existing gitignored `.env.local` copies are not touched by the change; user gets a remediation one-liner at ship | Per-checkout, untracked files are outside the repo; `just setup` never overwrites; no doctor row (not asked for, would nag a deliberate LAN bind) | S:60 R:90 A:75 D:70 |
| 10 | Confident | `displayForm` / `webTabTitle` use the resolved port so portless URLs render `localhost:80/x` | Raw `URL.port` is empty for portless/`:80` URLs and would render `localhost:/x` once they classify as proxy | S:60 R:95 A:85 D:85 |
| 11 | Certain | web-url.test.ts assertions pinning portless-as-external flip to the new rule | Constitution Test Integrity: tests conform to the spec, and this change changes the spec | S:80 R:90 A:95 D:90 |

11 assumptions (3 certain, 8 confident, 0 tentative, 0 unresolved).
