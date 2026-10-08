# Plan: MCP Endpoint Behind Tailscale Serve + Settings Row

**Change**: 261007-vqkk-mcp-endpoint-tailscale-serve-settings
**Intake**: `intake.md`

## Requirements

### MCP Transport: Host Handling

#### R1: The SDK's Host-based localhost protection is disabled
`(*Server).HTTPHandler` MUST construct the streamable handler with `StreamableHTTPOptions.DisableLocalhostProtection: true`. The `/mcp` route SHALL NOT reject a request because its local address is loopback and its `Host` header is non-loopback; `originGuard` remains the sole DNS-rebinding guard and the `Host` header is never consulted.

- **GIVEN** the daemon bound to `127.0.0.1` behind a reverse proxy (`tailscale serve`) that forwards `Host: box.tail1234.ts.net`
- **WHEN** an MCP client with no `Origin` header sends a session-less `GET /mcp` (`Accept: text/event-stream`)
- **THEN** the response is the SDK's `400` (`GET requires an Mcp-Session-Id header`), not `403 Forbidden: invalid Host header`
- **AND** a full `initialize` → `ListTools` round trip over that `Host` succeeds

#### R2: Origin rejection is unchanged
A request carrying a non-allowlisted `Origin` MUST still be rejected `403 {"error":"origin not allowed"}` regardless of its `Host`.

- **GIVEN** a request with `Host: box.tail1234.ts.net` and `Origin: http://evil.example:3000`
- **WHEN** it reaches `/mcp`
- **THEN** `originGuard` answers 403 with the JSON body

### MCP Transport: Origin Allowlist

#### R3: The tailnet DNS name contributes an https origin
`DeriveAllowedOrigins` MUST, when `tailnet.DNSName` is non-empty, also emit `https://<DNSName without trailing dot>:443` (the normalized form `normalizeOrigin` produces for `https://<name>`). Hostname, IP, and bind-host entries stay `http://…:<port>` only. A zero `TailnetIdentity` yields no `https` entry.

- **GIVEN** `TailnetIdentity{DNSName: "box.tail1234.ts.net.", IPs: ["100.64.1.2"]}` and port 3000
- **WHEN** the allowlist is derived
- **THEN** it contains `https://box.tail1234.ts.net:443` in addition to the existing `http://…:3000` entries
- **AND** `NewOriginPolicy(list).Allows("https://box.tail1234.ts.net")` is true

### Frontend: MCP Endpoint Discovery

#### R4: Settings → General shows the MCP endpoint
The General tab's **This host** section MUST render a read-only **MCP endpoint** row (after SSH host, before Auto-name tabs) whose value is `window.location.origin + "/mcp"` in a monospace `<code>` that wraps (`break-all`), with a Copy button that writes that exact string via `copyToClipboard` and flips `Copy` → `Copied` for 1500 ms (timer cleared on unmount). The row commits nothing and reads no registry key.

- **GIVEN** the dashboard opened at `https://box.tail1234.ts.net`
- **WHEN** the user opens Settings → General
- **THEN** the row shows `https://box.tail1234.ts.net/mcp`
- **AND** clicking Copy calls `copyToClipboard("https://box.tail1234.ts.net/mcp")`

#### R5: The copy action is in the command palette
A `Copy: MCP Endpoint` palette entry (id `copy-mcp-endpoint`) MUST be registered via the existing `copyPaletteEntry` helper beside `Copy: Host Name`, copying the same value from the same shared helper (Constitution V).

- **GIVEN** the command palette is open
- **WHEN** the user selects `Copy: MCP Endpoint`
- **THEN** `<origin>/mcp` is copied and the `MCP endpoint copied` toast shows

#### R6: The dev rig forwards /mcp
`app/frontend/vite.config.ts` MUST proxy `/mcp` to the Go backend so the URL the row shows under `just dev` resolves.

- **GIVEN** `just dev` on the Vite origin
- **WHEN** a client hits `<vite origin>/mcp`
- **THEN** the request reaches the backend's `/mcp` route

### Docs

#### R7: The spec reflects the transport stance
`docs/specs/mcp.md` § Transports (`/mcp`) MUST state that the SDK's Host-based localhost protection is disabled and why, that the allowlist includes the tailnet DNS name's `https` origin at 443, and that the dashboard surfaces the endpoint in Settings → General from the browser origin.

- **GIVEN** a reader of the spec
- **WHEN** they read § Transports
- **THEN** the Host-check stance and https entry are documented, with no contradiction in `docs/specs/api.md` § MCP

### Non-Goals

- Server-side reconstruction of the public URL from `Host`/`X-Forwarded-*` — the browser origin is exact; proxy headers are unverified.
- `https` entries for non-443 `tailscale serve --https=<port>` setups or for hostname/IP names — would need a config key the spec declines.
- Changing `rk url --mcp` — it remains the box-local bind-derived form.
- An accurate shareable URL in the desktop shell over an SSH-tunneled host (origin is a loopback tunnel; correct for that viewer only).

### Design Decisions

#### Disable the SDK localhost protection rather than allowlisting Hosts
**Decision**: `DisableLocalhostProtection: true`; `originGuard` stays the only rebinding guard.
**Why**: the SDK check keys on `Host`, which the spec forbids as a reference, and it 403s every request behind a loopback-terminating proxy (`tailscale serve`, the default deployment since the daemon binds `127.0.0.1`). Rebinding POSTs carry the attacker Origin (403); a session-less GET is inert (400).
**Rejected**: a Host allowlist wrapper — reintroduces Host as a reference and duplicates `originGuard`; binding the daemon to the tailnet address — changes deployment posture for one route.
*Introduced by*: 261007-vqkk-mcp-endpoint-tailscale-serve-settings

#### Display URL derives from the browser origin
**Decision**: `window.location.origin + "/mcp"`, shared by the Settings row and the palette entry.
**Why**: frontend API calls are relative, so the origin is exactly the URL that reached the daemon from this device.
**Rejected**: `rk url --mcp` (bind-derived, `127.0.0.1` — wrong off-box); server-side `X-Forwarded-*` reconstruction (proxy-dependent).
*Introduced by*: 261007-vqkk-mcp-endpoint-tailscale-serve-settings

## Tasks

### Phase 2: Core Implementation

- [x] T001 [P] `app/backend/internal/mcp/http.go`: set `DisableLocalhostProtection: true` in `StreamableHTTPOptions` and rewrite the `HTTPHandler` doc comment's rationale; add `http_test.go` tests — a session-less `GET` with `Host: box.tail1234.ts.net` (httptest listens on 127.0.0.1) answers 400 not 403, an SDK client round-trip with that Host succeeds, and a non-allowlisted Origin with that Host still answers 403 <!-- R1 R2 -->
- [x] T002 [P] `app/backend/internal/mcp/origin.go`: `DeriveAllowedOrigins` emits `https://<DNSName>:443` when the tailnet DNS name is set; update its doc comment; update `origin_test.go` (`TestDeriveAllowedOriginsFull` want-list, zero-identity case has no https, `Allows("https://box.tail1234.ts.net")` true) <!-- R3 -->
- [x] T003 Frontend: add an `mcpEndpointUrl()` helper (in `app/frontend/src/lib/`), the read-only **MCP endpoint** row in `GeneralPanel` (`components/settings-dialog.tsx`) with a Copy button following `ConfigYamlFooter`, and the `Copy: MCP Endpoint` (`copy-mcp-endpoint`) entry beside `copy-host-name` in `app.tsx` `serverActions`; extend `components/settings-dialog.test.tsx` (row value = jsdom origin + `/mcp`, Copy writes it) <!-- R4 R5 -->
- [x] T004 [P] `app/frontend/vite.config.ts`: add a `/mcp` proxy entry to `backendTarget` with a one-line comment <!-- R6 -->

### Phase 4: Polish

- [x] T005 [P] `docs/specs/mcp.md` § Transports `/mcp`: document the disabled SDK Host check + rationale, the tailnet `https` origin, and the Settings → General surface; align `docs/specs/api.md` § MCP if it contradicts <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `HTTPHandler` passes `DisableLocalhostProtection: true`; the doc comment states the Host-check rationale
- [x] A-002 R3: `DeriveAllowedOrigins` emits `https://<tailnet DNSName>:443` only when the DNS name is non-empty
- [x] A-003 R4: General → This host renders the read-only MCP endpoint row with value `window.location.origin + "/mcp"` and a working Copy button
- [x] A-004 R5: `Copy: MCP Endpoint` is registered via `copyPaletteEntry` using the shared helper
- [x] A-005 R6: `vite.config.ts` proxies `/mcp` to `backendTarget`
- [x] A-006 R7: `docs/specs/mcp.md` § Transports documents the Host-check stance, the https entry, and the Settings surface

### Behavioral Correctness

- [x] A-007 R1: a loopback-arrival request with a non-loopback `Host` and no `Origin` is no longer 403'd (test proves 400 for session-less GET and a successful client round trip)

### Scenario Coverage

- [x] A-008 R2: a test proves a disallowed `Origin` with a non-loopback `Host` still gets `403 {"error":"origin not allowed"}`
- [x] A-009 R3: `origin_test.go` covers the https entry, its absence for a zero identity, and `Allows` on the bare https origin
- [x] A-010 R4: `settings-dialog.test.tsx` asserts the row value and the Copy write

### Edge Cases & Error Handling

- [x] A-011 R4: the endpoint value wraps at 375px (no horizontal overflow) and the copied-state timer is cleared on unmount

### Code Quality

- [x] A-012 Pattern consistency: new code follows the surrounding patterns (`ConfigYamlFooter` copy button, `copyPaletteEntry`, `PreferenceRow`, test helpers)
- [x] A-013 No unnecessary duplication: one shared endpoint helper feeds both the row and the palette entry
- [x] A-014 Comments state constraints, not narration; no change IDs / PR numbers in code comments
- [x] A-015 Frontend type narrowing over `as` casts; no magic strings beyond the named route constant
- [x] A-016 New behavior is covered by tests (Go + Vitest)

### Security

- [x] A-017 R1: `originGuard` still runs on every method and remains the DNS-rebinding guard; no Host-based allow logic is introduced

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The one duplicated block it touched (`ConfigYamlFooter`'s inline copy button) was consolidated into the new shared `CopyValueButton` in-diff rather than left behind.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `httptest.NewServer` (127.0.0.1) + a non-loopback `req.Host` reproduces the bug in-test | The SDK keys on `http.LocalAddrContextKey` (loopback) vs `req.Host`; verified in SDK source | S:90 R:95 A:90 D:90 |
| 2 | Confident | Palette entry goes in `serverActions` beside `copy-host-name`, unconditionally | The endpoint is a host fact like Host Name; `window.location.origin` is always available | S:75 R:95 A:85 D:80 |
| 3 | Confident | Settings row and palette copy merged into one task (T003) | Both consume the same helper and are one focused frontend edit | S:70 R:95 A:85 D:80 |
| 4 | Confident | Vite `/mcp` proxy uses `backendTarget` without `ws`; `changeOrigin` left default | Streamable HTTP is plain HTTP + SSE; after R1 Host no longer matters | S:70 R:95 A:80 D:75 |
| 5 | Confident | No new palette test unless an existing `Copy:` entry test exists to extend | Mirror existing coverage depth; Settings test covers the copy path | S:65 R:95 A:75 D:70 |

5 assumptions (1 certain, 4 confident, 0 tentative).
