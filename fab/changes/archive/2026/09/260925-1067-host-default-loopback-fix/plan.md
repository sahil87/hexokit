# Plan: Host Default Loopback Fix

**Change**: 260925-1067-host-default-loopback-fix
**Intake**: `intake.md`

## Requirements

### Dev Tooling: Bind Host Default

#### R1: Dev rigs bind loopback by default
Every dev-tooling path that sets `RK_HOST` SHALL default to `127.0.0.1`: the committed `.env` (`RK_HOST=127.0.0.1`), the `scripts/dev.sh` fallback (`${RK_HOST:-127.0.0.1}`), and both spawns of the `scripts/test-e2e.sh` multi-rig lane. The env var name `RK_HOST` MUST NOT change (plan rule D2).

- **GIVEN** a fresh checkout where `just setup` copies `.env` to `.env.local`
- **WHEN** the developer runs `just dev`
- **THEN** Vite (on `RK_PORT`) and the Go backend (on `RK_PORT+1`) listen on `127.0.0.1` only
- **AND** `curl http://<lan-ip>:<port>` from another host is refused

- **GIVEN** a shell with no direnv and no `RK_HOST` set (CI)
- **WHEN** `scripts/dev.sh` runs (directly or via `just test-e2e`'s single-rig lane)
- **THEN** `RK_HOST` resolves to `127.0.0.1`

- **GIVEN** `RK_E2E_WORKERS=2`
- **WHEN** `scripts/test-e2e.sh` spawns rigs
- **THEN** each rig's backend and Vite get `RK_HOST=127.0.0.1` and the harness's readiness probe and Playwright still reach them over `localhost`

#### R2: LAN binding stays a documented opt-in
The committed `.env` SHALL carry `RK_HOST=0.0.0.0` as a commented example, with a comment explaining that run-kit has no auth and an all-interfaces bind exposes the relay, the API, and `/proxy`, and naming the one-off `just dev --host 0.0.0.0` form. The orphaned `RK_PORT` comment ("The port you open in your browser…") SHALL be removed; the `RK_CODE_SERVER_PORT` block stays unchanged.

- **GIVEN** a developer who wants phone testing over LAN
- **WHEN** they read `.env`
- **THEN** they find the commented `RK_HOST=0.0.0.0` line and the `just dev --host 0.0.0.0` alternative
- **AND** `just dev --host 0.0.0.0` still binds all interfaces (dev.sh `--host` flag unchanged)

### Frontend: Web-tile Address Model

#### R3: Portless `http:` loopback URLs are proxied as port 80
`app/frontend/src/lib/web-url.ts` SHALL treat an absolute `http:` URL on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) with no port — including an explicit `:80`, which the WHATWG URL parser elides — as the proxy kind on port 80, mirroring Go `internal/present` (`KindLocalURL`, default port 80). Portless `https:` loopback URLs SHALL remain `external`. `toProxySrc` SHALL use the same port resolution as `classifyAddress`/`proxyPortOf` (no duplicated inline check). `displayForm` and `webTabTitle` SHALL render the resolved port.

- **GIVEN** the address `http://localhost/x`
- **WHEN** `classifyAddress`, `proxyPortOf`, `toProxySrc`, `displayForm`, `webTabTitle` run
- **THEN** they return `"proxy"`, `80`, `"/proxy/80/x"`, `"localhost:80/x"`, `"localhost:80/x"` respectively

- **GIVEN** `http://localhost:80/x` or `http://127.0.0.1/x?a=1`
- **WHEN** classified / mapped
- **THEN** both are `proxy` on port 80 (`/proxy/80/x`, `/proxy/80/x?a=1`)

- **GIVEN** `https://localhost/`
- **WHEN** classified / mapped
- **THEN** it is `external` and `toProxySrc` passes it through unchanged

- **GIVEN** an explicit-port loopback URL (`http://localhost:8080/docs`)
- **WHEN** mapped
- **THEN** behavior is unchanged (`/proxy/8080/docs`)

### Plan Bookkeeping

#### R4: Rebrand plan reflects the change
`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL mark row P2's status (in progress / this change), update the Status paragraph's "P1/P2/P3 not started", and drop the "`.env` (delete the orphaned `RK_PORT` comment)" item from row C5.

- **GIVEN** the plan doc
- **WHEN** this change ships
- **THEN** P2 names this change and C5 no longer lists the `.env` comment deletion

### Non-Goals

- `https://localhost:<port>` handling (frontend proxies it, Go attaches verbatim) — separate row; not portless
- Bare `localhost` address-bar input without a port (`LOOPBACK_INPUT_RE`) — still rejected
- Go `present.go` behavior — already the target rule
- Existing gitignored `.env.local` copies — outside the repo; remediation one-liner given to the user at ship
- A doctor warning for `RK_HOST=0.0.0.0`

### Design Decisions

#### Frontend adopts the backend's portless-loopback rule
**Decision**: A portless `http:` loopback URL means port 80 in the web-tile address model, riding `/proxy/80/…`, matching `internal/present`.
**Why**: `http:` without a port is port 80 by definition; the backend already stores `/proxy/80/…` for `rk present http://localhost/x`; classifying it external makes the iframe load the viewer's own machine, wrong for every remote viewer; and the URL parser elides `:80`, so explicit `:80` was misclassified too.
**Rejected**: Making Go treat portless loopback as external — it would store a URL that silently targets the viewer's machine.
*Introduced by*: 260925-1067-host-default-loopback-fix

#### Dev tooling binds loopback, LAN is opt-in
**Decision**: `.env`, `dev.sh`, and the e2e multi-rig lane default `RK_HOST` to `127.0.0.1`; `0.0.0.0` is a commented `.env` example and the `just dev --host 0.0.0.0` one-off.
**Why**: run-kit has no auth; an all-interfaces dev bind exposed the terminal relay, API, and `/proxy` (any loopback port) to the LAN. The Go binary already defaults to loopback, and Tailscale Serve proxies to loopback.
**Rejected**: Changing only `.env` — `dev.sh`'s fallback and the multi-rig lane would keep binding all interfaces on CI and non-direnv shells.
*Introduced by*: 260925-1067-host-default-loopback-fix

## Tasks

### Phase 1: Core Implementation

- [x] T001 [P] Rewrite the `RK_HOST` block in `.env` (loopback default, commented `0.0.0.0` example with the no-auth warning and `just dev --host 0.0.0.0`; drop the orphaned `RK_PORT` comment); change `scripts/dev.sh` fallback to `${RK_HOST:-127.0.0.1}`; change both `RK_HOST=0.0.0.0` spawns in `scripts/test-e2e.sh` multi-rig lane to `127.0.0.1` <!-- R1 R2 -->
- [x] T002 [P] In `app/frontend/src/lib/web-url.ts`: make `loopbackPortOf` return 80 for portless `http:` loopback; route `toProxySrc` through `loopbackPortOf`; use the resolved port in `displayForm`/`webTabTitle` proxy branches; update doc comments. Update `app/frontend/src/lib/web-url.test.ts` per the intake's assertion table <!-- R3 -->

### Phase 2: Verification & Bookkeeping

- [x] T003 Run gates: `just test-frontend` (full Vitest), `cd app/frontend && npx tsc --noEmit`, `go test ./internal/present/...`; e2e: one spec on the default lane (`just test-e2e <name>.spec`) and one spec with `RK_E2E_WORKERS=2`, gating on the `N passed` line; confirm a dev-rig listener binds `127.0.0.1` (e.g. `ss -ltn`) <!-- R1 R3 -->
- [x] T004 Update `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`: P2 row status, Status paragraph, C5 `.env` item removed <!-- R4 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `.env` sets `RK_HOST=127.0.0.1`; `scripts/dev.sh` falls back to `127.0.0.1`; no `RK_HOST=0.0.0.0` remains in `scripts/test-e2e.sh`
- [x] A-002 R2: `.env` contains a commented `# RK_HOST=0.0.0.0` example with the no-auth explanation and the `just dev --host 0.0.0.0` alternative; the orphaned port comment is gone; the `RK_CODE_SERVER_PORT` block is unchanged
- [x] A-003 R3: `classifyAddress`/`proxyPortOf`/`toProxySrc`/`displayForm`/`webTabTitle` treat portless and `:80` `http:` loopback as proxy port 80
- [x] A-004 R4: Plan doc P2 row, Status line, and C5 row are updated

### Behavioral Correctness

- [x] A-005 R3: `https://localhost/` stays external and passes through `toProxySrc`; explicit-port loopback URLs behave as before
- [x] A-006 R1: `RK_HOST` is not renamed anywhere (D2)

### Scenario Coverage

- [x] A-007 R3: `web-url.test.ts` covers portless `http://localhost/`, explicit `:80`, `127.0.0.1` portless with query, portless `https://localhost/`, and the display/title forms
- [x] A-008 R1: An e2e run on the default lane and one with `RK_E2E_WORKERS=2` pass with the loopback bind

### Edge Cases & Error Handling

- [x] A-009 R3: `[::1]` portless `http:` resolves to port 80 like `localhost` (same host set)

### Code Quality

- [x] A-010 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-011 No unnecessary duplication: `toProxySrc` reuses `loopbackPortOf` instead of an inline duplicate port check
- [x] A-012: Named constant for the default http port rather than a bare `80` magic number
- [x] A-013: Comments state constraints (why port 80, the Go mirror) without narration or change IDs

### Security

- [x] A-014 R1: No dev-tooling path binds `0.0.0.0` unless the developer opts in explicitly

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — the change's only removal (the inline port check in `toProxySrc` and the orphaned `RK_PORT` comment in `.env`) was deleted by the apply diff itself; no surviving code is made redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Introduce a named constant for the http default port in web-url.ts | code-quality.md forbids magic numbers; Go uses a bare literal but the frontend module names its other constants | S:60 R:95 A:80 D:80 |
| 2 | Confident | E2E verification uses one spec per lane, not the full suite | The change touches only bind host; a single spec proves reachability; memory notes one full e2e run per worktree and CI runs the full suite | S:65 R:90 A:80 D:75 |

2 assumptions (0 certain, 2 confident, 0 tentative).
