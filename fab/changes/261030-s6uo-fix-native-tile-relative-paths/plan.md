# Plan: Fix native web tile rk-relative addresses in proxy mode

**Change**: 261030-s6uo-fix-native-tile-relative-paths
**Intake**: `intake.md`

## Requirements

### Web tile: native engine load target

#### R1: Daemon loopback origin derivation
The SPA SHALL derive the rk daemon's loopback origin as `http://127.0.0.1:<tunnel>` from its own same-origin `GET /api/health` response's `tunnel` field, when `tunnel` is an integer in `1..65535`; otherwise the derived origin SHALL be `null`. `HealthResponse` SHALL declare `tunnel?: number`. The derivation SHALL be a pure, DOM-free function, and the fetch SHALL be memoized once per SPA lifetime and performed only when the native engine's mode is `proxy`. A failed fetch SHALL resolve `null`, never throw.

- **GIVEN** a health response `{ tunnel: 3000, … }`
- **WHEN** the daemon origin is derived
- **THEN** it is `http://127.0.0.1:3000`
- **AND** `tunnel` absent, non-integer, `0`, `65536`, or a fetch failure yields `null`

#### R2: `toNativeSrc` resolves root-relative rk paths against the daemon origin in `proxy` mode
`toNativeSrc(url, mode, daemonOrigin = null)` in `app/frontend/src/lib/web-url.ts` SHALL, in `proxy` mode with a non-null `daemonOrigin`, return the absolute URL of a root-relative address (single leading `/`, not `//`) resolved against `daemonOrigin`, preserving path, query, and hash. `/proxy/{port}` addresses SHALL keep mapping to `http://localhost:{port}/…` (via `toWebAddTarget`). Absolute URLs SHALL pass through unchanged in `direct`/`proxy`. `direct` mode SHALL be unchanged; `legacy` SHALL remain exactly `toProxySrc`. With a `null` daemon origin, `proxy` SHALL behave exactly as today.

- **GIVEN** stored address `/present/runKit/f65b8ea5966f/agents-settings-mock.html?v=1` and daemon origin `http://127.0.0.1:3000`
- **WHEN** `toNativeSrc` runs in `proxy` mode
- **THEN** it returns `http://127.0.0.1:3000/present/runKit/f65b8ea5966f/agents-settings-mock.html?v=1`
- **AND** in `direct` mode, or `proxy` with a `null` origin, it returns the stored address unchanged
- **AND** `//evil.example/x` is never rewritten against the daemon origin

#### R3: The native engine create site uses the daemon origin in `proxy` mode
`WebFrameNative` (`app/frontend/src/components/web-frame-native.tsx`) SHALL, after `shellWebMode()` resolves `proxy`, await the memoized daemon origin and pass it to `toNativeSrc`; the result SHALL still be resolved with `new URL(…, window.location.origin)` so the `direct`/null-origin relative case is unchanged. The existing `cancelled` check SHALL be honored after every await.

- **GIVEN** the desktop shell connected to a remote host whose public origin the rk host cannot resolve, in `proxy` mode
- **WHEN** a web tab with a stored `/present/…` address mounts
- **THEN** the guest loads `http://127.0.0.1:<tunnel>/present/…` through the tunnel and the page renders (no "tunnel connection failed")

#### R4: Tracked location folds the daemon origin back to root-relative
The guest's navigated URL SHALL be mapped to its root-relative form (`pathname + search + hash`) when its origin equals either `window.location.origin` or the known daemon loopback origin; any other origin SHALL be kept absolute; an unparsable string SHALL be kept raw. The mapping SHALL be a pure helper in `web-url.ts` used by `toTracked`.

- **GIVEN** a proxy-mode guest on `http://127.0.0.1:3000/present/x/y.html?v=1#h` with daemon origin `http://127.0.0.1:3000`
- **WHEN** the shell reports the guest URL
- **THEN** the tracked location is `/present/x/y.html?v=1#h` (address bar shows the pretty present form; `↗` open-external targets the viewer-side origin, not the viewer's own loopback)

### Non-Goals

- Rewriting absolute URLs on the viewer's own public origin (e.g. a typed `https://runner2…/present/…`) — scope is root-relative stored addresses (intake Open Question; left out).
- Any change to `legacy` mode, the iframe engine, the backend, or `app/desktop/src/` runtime code.
- A backend tunnel short-circuit for the server's own public hostname — rejected (TLS).

### Design Decisions

#### Daemon origin comes from the SPA's own health read
**Decision**: The SPA reads `health.tunnel` from its own same-origin `/api/health` and derives `http://127.0.0.1:<tunnel>`; the shell's `web:mode` envelope is not extended.
**Why**: The SPA and the rk backend ship as one build, so the field is guaranteed; `proxy` mode is only granted after the shell's probe proved `127.0.0.1:<tunnel>` dialable through `/ws/tunnel`, so the target is known-good.
**Rejected**: Carrying the port in `web:mode` — the Electron shell is installed separately and can lag, requiring a fallback for every shell that reports `proxy` without the field. Backend short-circuit of own-hostname tunnel dials — the guest speaks TLS to `:443`, so plain-HTTP loopback underneath breaks the handshake.
*Introduced by*: 261030-s6uo-fix-native-tile-relative-paths

## Tasks

### Phase 1: Setup

- [x] T001 Add `tunnel?: number` (documented: the daemon's startup-bound listen port) to `HealthResponse` in `app/frontend/src/api/client.ts`; add a pure `daemonLoopbackOrigin(tunnel: unknown): string | null` to `app/frontend/src/lib/web-url.ts` (integer 1..65535 → `http://127.0.0.1:<n>`, else `null`) <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Extend `toNativeSrc(url, mode, daemonOrigin = null)` in `app/frontend/src/lib/web-url.ts` per R2 (reuse the `isAllowedUrl` root-relative rule — extract a small shared `isRootRelative` rather than duplicating); update the module header item 6 and the `toNativeSrc` docstring <!-- R2 -->
- [x] T003 Add a pure `toTrackedLocation(absolute, viewerOrigin, daemonOrigin)` helper to `app/frontend/src/lib/web-url.ts` per R4 <!-- R4 -->
- [x] T004 Add a memoized, never-throwing `shellDaemonOrigin(): Promise<string | null>` (one settled promise per SPA lifetime, `getHealth()` → `daemonLoopbackOrigin`) beside `shellWebMode` in `app/frontend/src/lib/shell.ts` (or the closest existing home if a better one is evident) <!-- R1 -->
- [x] T005 Wire `app/frontend/src/components/web-frame-native.tsx`: at the create site, when `mode === "proxy"` await `shellDaemonOrigin()` (honor `cancelled`), pass it to `toNativeSrc`, and keep it in a ref; make `toTracked` delegate to `toTrackedLocation(absolute, window.location.origin, daemonOriginRef.current)` <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T006 [P] Vitest: in `app/frontend/src/lib/web-url.test.ts` split the "direct/proxy: every other address kind passes through unchanged" case — `direct` keeps the pass-through assertions; `proxy` + origin asserts loopback-absolute results (`/present/…` incl. query/hash and the `/present/@320/…` form, `/board/runKit`); `proxy` + `null` passes through; `/proxy/{port}` and absolute URLs unchanged in every mode; `//evil.example/x` not rewritten. Add `daemonLoopbackOrigin` cases (3000 → origin; absent/`"3000"`/`1.5`/`0`/`65536` → null) and `toTrackedLocation` cases (daemon origin → relative, viewer origin → relative, foreign → absolute, unparsable → raw). Add a vitest for `shellDaemonOrigin` memoization + fetch-failure → `null` in the existing shell test file. Run via `just test-frontend` <!-- R1 R2 R4 -->
- [x] T007 Desktop e2e regression in `app/desktop/tests/e2e/web-tunnel.spec.ts` (or a sibling spec reusing its reverse-proxy rig): seed a remote host whose origin hostname the SHELL resolves but the rig's rk server cannot (e.g. Chromium `--host-resolver-rules` for the renderer/`net.fetch` plus whatever the main-process Node tunnel client needs — note undici/Node DNS does NOT honor Chromium resolver rules; investigate e.g. `HOSTALIASES` on the Electron env or an equivalent), stamp a web tab with a root-relative rk address (an `rk present`-style `/present/…` path or another rk-served root-relative page), and assert the guest renders. Extend `launchShell` in `app/desktop/tests/e2e/_shell.ts` with optional extra args/env as needed (both current-tree and `appDir` launch paths). Must carry the Constitution § Test Intent Comments JSDoc. If the unresolvable-origin shape proves infeasible on the rig, record why in plan `## Assumptions` and fall back to a test that asserts the guest URL targets `127.0.0.1:<tunnel>` in proxy mode <!-- R3 R4 -->

### Phase 4: Polish

- [x] T008 Shell demo for PR evidence: `app/desktop/tests/demo/<name>.demo.ts` (reusing T007's rig mechanism) showing a proxy-mode remote host loading a root-relative rk address in the native tile; verify `just demo <name> --before` produces before (failure) / after (renders) shell recordings. Run `just test-e2e` scoped to the touched desktop specs plus the existing `web-tile-native` lane to confirm `direct` mode is unaffected <!-- R3 -->

## Execution Order

- T001 blocks T002–T005; T002–T004 block T005; T005 blocks T007–T008
- T006 can run once T001–T004 exist
- T007 establishes the rig mechanism T008 reuses

## Acceptance

### Functional Completeness

- [x] A-001 R1: `HealthResponse.tunnel` is declared and `daemonLoopbackOrigin` returns `http://127.0.0.1:<n>` only for integer ports 1..65535
- [x] A-002 R1: The daemon-origin fetch is memoized, invoked only in `proxy` mode, and resolves `null` on failure
- [x] A-003 R2: `toNativeSrc` in `proxy` mode with a daemon origin returns root-relative rk addresses as daemon-loopback absolute URLs with path/query/hash preserved
- [x] A-004 R3: The native engine create site passes the daemon origin to `toNativeSrc` in `proxy` mode and honors `cancelled` after each await
- [x] A-005 R4: `toTracked` maps daemon-origin and viewer-origin guest URLs to root-relative form via the pure `toTrackedLocation` helper

### Behavioral Correctness

- [x] A-006 R2: `direct` mode output is unchanged for every address kind; `legacy` is still exactly `toProxySrc`; `/proxy/{port}` still maps to `http://localhost:{port}/…`

### Scenario Coverage

- [x] A-007 R2: `web-url.test.ts` covers the R2 matrix (direct, proxy+origin, proxy+null, legacy) including the split of the former pass-through case
- [x] A-008 R3: A desktop e2e exercises a proxy-mode remote host loading a root-relative rk address in the native tile (or the documented fallback assertion), with Test Intent JSDoc
- [x] A-009 R3: A shell demo spec exists under `app/desktop/tests/demo/` suitable for `just demo --before` PR evidence

### Edge Cases & Error Handling

- [x] A-010 R2: A `null` daemon origin (health failure, missing/invalid `tunnel`) degrades to today's behavior — no throw, no blank tile
- [x] A-011 R2: Scheme-relative `//host/x` is never rewritten against the daemon origin
- [x] A-012 R4: Foreign-origin guest URLs stay absolute; unparsable strings are stored raw

### Code Quality

- [x] A-013 Pattern consistency: New code follows naming and structural patterns of surrounding code (`web-url.ts` stays pure/DOM-free; shell bridge helpers keep the never-throw degrade convention)
- [x] A-014 No unnecessary duplication: the root-relative check is shared with `isAllowedUrl`; `getHealth()` is reused
- [x] A-015 Type narrowing over type assertions: the `tunnel` value is narrowed with guards, not `as` casts
- [x] A-016 Tests: the bug fix ships with unit tests covering the changed behavior (code-quality principle)
- [x] A-017 Comment discipline: comments state constraints/why only — no narration, no change IDs or PR numbers
- [x] A-018 No client polling: the daemon origin is a one-shot memoized read, not an interval fetch

### Security

- [x] A-019 R1: The daemon origin is built only from a validated integer port from the daemon's own health response; no viewer-supplied input reaches it, and no new tunnel dial target class is introduced (the probe already dials `127.0.0.1:<tunnel>`)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- PR evidence (Constitution § PR Evidence): the shell recording from T008 is attached at PR time via `gh pr edit --attach`; the web (iframe) engine is unchanged, so no web-lane recording is required — the PR body states so.

## Deletion Candidates

- `app/frontend/src/components/web-frame-native.tsx` `toTracked` — already removed by this change (superseded by `toTrackedLocation`); no further existing code made redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Pure derivation helpers (`daemonLoopbackOrigin`, `toTrackedLocation`) live in `web-url.ts` | Module contract is pure/DOM-free with colocated tests; intake decision 10 | S:80 R:90 A:85 D:80 |
| 2 | Confident | Memoized `shellDaemonOrigin()` sits beside `shellWebMode` in `lib/shell.ts` | Same never-throw bridge-adjacent helper family; intake left placement to apply | S:55 R:90 A:70 D:60 |
| 3 | Confident | `toTracked` reads the daemon origin from a ref set at create time | `toTracked` runs in the shell event handler after create; a ref avoids re-subscribing | S:60 R:90 A:75 D:70 |
| 4 | Confident | The rig makes the shell resolve a `.test` hostname the rk server cannot via TWO mappings: Chromium `--host-resolver-rules=MAP rk-demo.test 127.0.0.1` (renderer, `net.fetch` probe) plus a `-r` main-process preload (`tests/e2e/_host-map.cjs`) patching Node's `dns.lookup` for the undici tunnel client | Verified in apply: the e2e passes with the fix and, with the fix disabled, fails with the server log `tunnel: dial failed target=rk-demo.test:… no such host` — the exact production failure; `HOSTALIASES` was not needed (it ignores dotted names anyway). Documented fallback unused | S:85 R:80 A:80 D:70 |
| 5 | Confident | Desktop regression test extends the existing `web-tunnel.spec.ts` reverse-proxy rig rather than a new harness | That spec already establishes remote `proxy` mode on the rig | S:60 R:85 A:70 D:60 |

| 6 | Confident | A failed/unusable health read is not memoized (only a successful derivation is), so a later tile mount retries | R1 asks for one read per SPA lifetime but also `null` on failure; caching a transient failure would pin every later tile to the broken viewer-origin load until reload | S:60 R:90 A:75 D:65 |
| 7 | Confident | The shell-demo fixture gains two option fixtures (`extraHosts`, `launchExtras`) and `seedHosts`/`launchShell` gain optional extras; defaults leave every existing demo/e2e launch unchanged | Needed to seed the `.test` host and its launch extras on the demo lane; `web-tile-native` demo and `web-native`/`web-tunnel` e2e re-run green | S:70 R:85 A:80 D:70 |

7 assumptions (1 certain, 6 confident, 0 tentative).
