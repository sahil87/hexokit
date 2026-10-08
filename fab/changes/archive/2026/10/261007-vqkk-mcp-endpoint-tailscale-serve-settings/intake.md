# Intake: MCP Endpoint Behind Tailscale Serve + Settings Row

**Change**: 261007-vqkk-mcp-endpoint-tailscale-serve-settings
**Created**: 2026-10-08

## Origin

Conversational — a `/fab-discuss` session. The user asked whether the MCP server is exposed on a URL, then:

> Can you show this URL in Settings/General. Also - right now what I access it I get "Invalid host header"

followed by:

> Can run-kit know which URL it was accessed from and use that - to provide an accurate URL

and approved the four-part plan below with "yes - proceed".

Key decisions from the discussion:
- Root cause of the 403 was diagnosed live (see Why) — fix it by disabling the SDK's localhost protection, not by changing the bind or the proxy.
- The displayed URL comes from the **browser's own origin** (`window.location.origin + "/mcp"`), not from `rk url --mcp` (which prints `http://127.0.0.1:3000/mcp` — box-local and wrong for remote viewers) and not from server-side `Host`/`X-Forwarded-*` reconstruction (proxy-dependent; unverified whether `tailscale serve` sets `X-Forwarded-Proto`).
- Add the `https://<tailnet DNSName>` origin to the allowlist (user did not drop item 2).

## Why

**The bug.** On the user's box the daemon binds `127.0.0.1:3000` and is fronted by `tailscale serve`:

```
https://dev-ws-sahil02.bat-ordinal.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:3000
```

Every request therefore arrives on a **loopback local address** carrying `Host: dev-ws-sahil02.bat-ordinal.ts.net`. The pinned `github.com/modelcontextprotocol/go-sdk v1.7.0` streamable handler has a built-in DNS-rebinding guard (`mcp/streamable.go:327-333`):

```go
if !h.opts.DisableLocalhostProtection && disablelocalhostprotection != "1" {
    if localAddr, ok := req.Context().Value(http.LocalAddrContextKey).(net.Addr); ok && localAddr != nil {
        if util.IsLoopback(localAddr.String()) && !util.IsLoopback(req.Host) {
            http.Error(w, fmt.Sprintf("Forbidden: invalid Host header %q", req.Host), http.StatusForbidden)
            return
        }
    }
}
```

`internal/mcp/http.go` leaves `DisableLocalhostProtection` false, with a comment (and memory text) claiming "a tailnet request arrives on the tailnet address, so it never trips for legitimate clients". That premise only holds when the daemon binds the tailnet interface directly. Behind any local reverse proxy — `tailscale serve`, the supported/default deployment since the daemon binds `127.0.0.1` — **every** `/mcp` request is 403'd. The route is unusable from the tailnet.

**Why disabling is safe.** `originGuard` (`internal/mcp/origin.go`) is already the transport's DNS-rebinding defense, and `docs/specs/mcp.md` § Transports explicitly says the `Host` header is never the reference ("under DNS rebinding … both headers carry the attacker's name, so `Origin == Host` defends nothing"). Under rebinding, a browser's `POST` (needed to `initialize` a session) carries the attacker's `Origin` → 403 from `originGuard`; a session-less `GET` gets the SDK's `400 GET requires an Mcp-Session-Id header` and can do nothing. Non-browser clients (Claude Code) send no `Origin` and were never the rebinding threat.

**The allowlist gap.** `DeriveAllowedOrigins` emits `http://…:<port>` entries only. A browser-based MCP client reaching the daemon via `tailscale serve` sends `Origin: https://<box>.<tailnet>.ts.net` (port 443), which is not in the list → 403 from `originGuard`. Current memory records this as deliberately not derived ("the daemon serves plain HTTP and the spec defines no config key"). The tailnet DNS name is already probed, so adding its `https` form at the default port is cheap and covers the common `tailscale serve` shape.

**The discoverability gap.** Users have no in-UI way to find the endpoint, and the CLI form (`rk url --mcp`) prints the daemon's bind address, which is wrong from any other device. The browser's origin is, by construction, the URL that reached the daemon from that device (all frontend API calls are relative), so it is the accurate thing to show.

## What Changes

### 1. Disable the SDK's localhost protection — `app/backend/internal/mcp/http.go`

In `(*Server).HTTPHandler`, set `DisableLocalhostProtection: true` in the `mcpsdk.StreamableHTTPOptions`:

```go
&mcpsdk.StreamableHTTPOptions{
    SessionTimeout:             HTTPSessionIdleTimeout,
    Logger:                     logger,
    DisableLocalhostProtection: true,
},
```

Rewrite the doc comment's `DisableLocalhostProtection` clause: it is disabled because the SDK's guard keys on the `Host` header, which the spec forbids as a reference, and it 403s every request behind a loopback-terminating reverse proxy (`tailscale serve`); `originGuard` is the DNS-rebinding guard. Keep comment density/style matching the file (no change IDs).

Test (`http_test.go`, `httptest`-based like the existing transport tests): a request whose local address is loopback and whose `Host` is non-loopback (e.g. `box.tail1234.ts.net`) with no `Origin` header must NOT be 403'd — e.g. a session-less `GET` answers `400` (the mounted signature), and/or an `initialize` `POST` succeeds. Note `httptest.NewServer` listens on `127.0.0.1`, so setting `req.Host` to a non-loopback name reproduces the bug before the fix. Existing origin-rejection tests must still pass.

### 2. Add the `https` tailnet origin — `app/backend/internal/mcp/origin.go`

In `DeriveAllowedOrigins`, when `tailnet.DNSName` is non-empty, additionally emit `https://<DNSName without trailing dot>:443` (normalized the same way `normalizeOrigin` normalizes — scheme lowercased, default port filled — so `Allows("https://box.tail1234.ts.net")` matches). Everything else stays `http://…:<port>`. Only the tailnet DNS name gets an `https` entry (it is the name `tailscale serve` certificates are issued for); hostname/IP entries do not. Non-443 `tailscale serve --https=<port>` setups are out of scope.

Update `origin_test.go`: the existing worked example (`http://100.64.1.2:3000`, `http://box.tail1234.ts.net:3000`, `http://box:3000`) gains `https://box.tail1234.ts.net:443`; a zero `TailnetIdentity` yields no `https` entry; `Allows("https://box.tail1234.ts.net")` passes against the derived policy.

### 3. Settings → General → "This host": read-only MCP endpoint row — `app/frontend/src/components/settings-dialog.tsx`

In `GeneralPanel`, inside the "This host" section (after "SSH host" — the two connection-identity rows sit together; before "Auto-name tabs"), add a read-only `PreferenceRow`:

- **Label**: `MCP endpoint`
- **Sublabel**: short hint, e.g. `Streamable-HTTP URL for MCP clients on your tailnet (Claude Code). Claude Desktop uses ssh <box> rk mcp.`
- **Value**: `${window.location.origin}/mcp` rendered in a `<code>` (monospace, selectable, `break-all` so it wraps at 375px — no horizontal page scroll).
- **Copy button**: follow the existing `ConfigYamlFooter` precedent in `settings-all-panel.tsx` — `copyToClipboard` from `@/lib/clipboard`, `Tip` with label `Copy MCP endpoint`, button text toggles `Copy` → `Copied` for 1500 ms with the timer cleared on unmount. If the two copy-button copies would now duplicate meaningfully, extracting a small shared `CopyButton` is acceptable but not required.

It is display-only — no registry key, no commit. Derive the origin in one small helper (e.g. `mcpEndpointUrl()` in an appropriate `lib/` module) so the settings row and the palette entry share it.

**Palette (Constitution V)**: register a `Copy: MCP Endpoint` palette entry using the existing `copyPaletteEntry(id, label, …, value)` helper in `app.tsx` (siblings: `Copy: Server Name`, `Copy: Host Name` around `app.tsx:5098`), id `copy-mcp-endpoint`, value from the shared helper. Check whether the board route shell's palette list needs the same entry (the memory notes both shells resolve layout-global entries over a merged list).

Tests: extend `settings-dialog.test.tsx` — the General tab renders the `MCP endpoint` row whose value equals `window.location.origin + "/mcp"` (jsdom's origin), and clicking Copy calls the clipboard helper with that string. A palette test for the new entry if the existing `Copy:` entries have one.

### 4. Vite dev proxy forwards `/mcp` — `app/frontend/vite.config.ts`

The dev proxy currently forwards `/api`, `/ws`, `/proxy`, `/code` — **not** `/mcp`, so under `just dev` the displayed URL (the Vite origin) would 404. Add:

```ts
"/mcp": {
  target: backendTarget,
},
```

Decide `changeOrigin` deliberately: after fix 1 the `Host` no longer matters to `/mcp`, and a browser-origin request in dev carries a loopback `Origin` (passes the loopback exception). SSE (`GET` stream) must pass through unbuffered. Add a one-line comment in the file's style.

### 5. Docs

- `docs/specs/mcp.md` § Transports (`/mcp` streamable HTTP): state that the SDK's Host-based localhost protection is disabled (the Host header is never the reference; it breaks loopback-terminating proxies such as `tailscale serve`), that the allowlist includes the tailnet DNS name's `https` origin at 443, and that the dashboard surfaces the endpoint in Settings → General from the browser origin.
- Check `docs/specs/api.md` § MCP for any statement contradicting the above and align it.

## Affected Memory

- `run-kit/mcp`: (modify) `HTTPHandler` options — `DisableLocalhostProtection` now `true` with the corrected rationale (replace the "never trips a tailnet request" claim + its Design Decision); `DeriveAllowedOrigins` gains the `https://<tailnet DNSName>:443` entry (update the requirement, the worked-example scenario, and the "https allowlist entries … are not derived" line in the trailing notes); mention the Settings row as a consumer alongside `rk url --mcp`.
- `run-kit/ui/dialogs-and-state`: (modify) the Settings tab table's **General** row gains the read-only **MCP endpoint** (This host) row — browser-origin derived, copy button.
- `run-kit/ui/status-signals`: (modify) only if it is where the `Copy:` palette entries are inventoried — add `Copy: MCP Endpoint`; otherwise whichever `ui/` file owns the palette `Copy:` inventory (e.g. `ui/keyboard-and-palette`).

## Impact

- **Backend**: `app/backend/internal/mcp/http.go`, `origin.go`, plus `http_test.go`, `origin_test.go`. No API/route surface change; no new config key. `rk doctor` `mcp route` probe is loopback→loopback and unaffected. `rk url --mcp` unchanged.
- **Frontend**: `app/frontend/src/components/settings-dialog.tsx` (+ test), `app/frontend/src/app.tsx` (palette entry), possibly a board-page palette list, a small `lib/` helper, `app/frontend/vite.config.ts`.
- **Security**: the SDK guard is removed deliberately; `originGuard` remains the DNS-rebinding defense per spec. Posture unchanged otherwise — tailnet-only, no auth (spec non-goal).
- **Verification**: `just test-backend` (scoped first to the `internal/mcp` package via the just recipe's mechanism), `just test-frontend` for the settings/palette tests; manual check against the live box: `curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/event-stream' https://dev-ws-sahil02.bat-ordinal.ts.net/mcp` should return `400` (was `403`) after `rk daemon restart`.

## Open Questions

- Does `tailscale serve` set `X-Forwarded-Proto`/`X-Forwarded-Host`? Not needed for this design (browser origin is used), recorded only so nobody reintroduces server-side reconstruction without checking.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause is the go-sdk v1.7.0 loopback-arrival/non-loopback-Host 403; fix is `DisableLocalhostProtection: true` | Diagnosed in discussion: `ss` shows bind 127.0.0.1:3000, `tailscale serve status` shows the proxy, SDK source read; user approved | S:95 R:85 A:95 D:95 |
| 2 | Certain | `originGuard` alone is sufficient DNS-rebinding defense | Spec § Transports already names Origin (never Host) as the reference; rebinding POST carries attacker Origin, session-less GET is inert | S:90 R:80 A:90 D:90 |
| 3 | Certain | Displayed URL = `window.location.origin + "/mcp"`, not `rk url --mcp` nor header reconstruction | Discussed — user asked for the URL "it was accessed from"; frontend API calls are relative so the origin is the daemon as seen by the viewer | S:95 R:90 A:90 D:95 |
| 4 | Certain | Add `https://<tailnet DNSName>:443` to the allowlist | Proposed as item 2; user approved all four without dropping it | S:90 R:85 A:85 D:85 |
| 5 | Confident | Row lives in General → "This host", after SSH host, read-only with a copy button following `ConfigYamlFooter` | User named Settings/General; endpoint is a host fact; existing copy-button precedent | S:80 R:90 A:85 D:75 |
| 6 | Confident | Register `Copy: MCP Endpoint` palette entry via `copyPaletteEntry` | Constitution V requires every UI-control action in the palette; `Copy: Server Name`/`Copy: Host Name` are the sibling pattern | S:70 R:90 A:85 D:80 |
| 7 | Confident | Add `/mcp` to the Vite dev proxy | Verified the proxy lacks it; without it the row's URL 404s under `just dev` | S:75 R:90 A:85 D:85 |
| 8 | Confident | Only the tailnet DNS name gets an `https` entry, at port 443 only | That is the name `tailscale serve` certs cover; non-443 serve ports need config the spec declines | S:70 R:85 A:75 D:75 |
| 9 | Tentative | Memory file owning the palette `Copy:` inventory is `ui/status-signals` | grep hit `Copy: Host Name` there; hydrate should confirm the right owner | S:50 R:95 A:60 D:60 |

9 assumptions (4 certain, 4 confident, 1 tentative, 0 unresolved).
