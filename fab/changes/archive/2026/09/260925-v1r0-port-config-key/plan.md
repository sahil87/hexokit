# Plan: Daemon Port Config Key

**Change**: 260925-v1r0-port-config-key
**Intake**: `intake.md`

## Requirements

### Settings: `port` registry key

#### R1: `port` is a config.yaml key in the settings registry
`internal/settings` SHALL carry a `Port int` field and one registry entry `port` with: kind `port`, default text `"3000"`, category `connectivity`, `ui: false`, `live: false`, and a description naming the restart requirement and that `RK_PORT` wins. `Port == 0` means unset. The default port SHALL come from the port policy's `portpolicy.DaemonDefault` (3000, from `ports.env`), the same source `internal/config`'s defaults read. The registry `def` text derives from it via `strconv.Itoa`, never from a second literal. <!-- rebased onto the ports-policy PR: originally a `settings.DefaultPort` constant -->

- **GIVEN** a config.yaml containing `port: 4000`
- **WHEN** `settings.Load()` runs
- **THEN** `Port == 4000`
- **AND** `settings.Registry()` lists a `port` row with `Kind: "port"`, `Default: "3000"`, `UI: false`, `Live: false`

#### R2: Tolerant parse, pin-preserving serialize
Parse SHALL quote-strip, trim, and `strconv.Atoi` the value, keeping it only when it is 1–65535. Any other value leaves `Port == 0` and never errors. Serialize SHALL emit `port: <n>\n` whenever `Port != 0`, **including a value equal to `DefaultPort`**, and SHALL emit nothing when `Port == 0`.

- **GIVEN** config.yaml `port: 3000`
- **WHEN** the file is loaded and saved back through `settings.Save`
- **THEN** the saved file still contains `port: 3000`
- **GIVEN** config.yaml `port: 70000` or `port: abc`
- **WHEN** loaded
- **THEN** `Port == 0`
- **GIVEN** a Settings value with `Port == 0`
- **WHEN** serialized
- **THEN** the output has no `port:` line, so untouched files round-trip byte-identically

#### R3: API read/apply shapes
`ReadValue(s, "port")` SHALL return the value as a JSON-number-shaped `int` when set, and a nil (JSON `null`) when `Port == 0`. `ApplyValue(s, "port", v)` SHALL follow Constitution IX partial-merge semantics: JSON `null` unsets (`Port = 0`); a JSON integer in 1–65535 sets it; anything else (strings included, out of range, fractional, bool) returns a validation error without mutating `s`.

- **GIVEN** `Port == 0`
- **WHEN** GET `/api/settings`
- **THEN** the `port` row's `value` is `null`
- **GIVEN** POST `/api/settings` `{"port": 4000}`
- **WHEN** applied
- **THEN** `Port == 4000` and config.yaml contains `port: 4000`
- **GIVEN** POST `{"port": 0}`, `{"port": 70000}`, or `{"port": "4000"}`
- **WHEN** applied
- **THEN** a 400-class validation error is returned and nothing changes

### Config: port resolution

#### R4: Port precedence code default < config.yaml < RK_PORT
`config.Load()` SHALL resolve `Port` as: `portpolicy.DaemonDefault` → overridden by a valid `settings.Load().Port` → overridden by a valid `RK_PORT`. An invalid `RK_PORT` (non-numeric or out of range) SHALL be ignored, so the config.yaml or default rung applies. `RK_HOST` and `RK_CODE_SERVER_PORT` resolution SHALL be unchanged. `ResolvedCodeServerPort()` keeps its `Port + 2` fallback, now computed from the resolved port.

- **GIVEN** no `RK_PORT` and config.yaml `port: 4000`
- **WHEN** `config.Load()` runs
- **THEN** `Port == 4000` and `ResolvedCodeServerPort() == 4002`
- **GIVEN** `RK_PORT=5000` and config.yaml `port: 4000`
- **THEN** `Port == 5000`
- **GIVEN** `RK_PORT=junk` and config.yaml `port: 4000`
- **THEN** `Port == 4000`
- **GIVEN** neither
- **THEN** `Port == 3000`

#### R5: `resolveOrigin` rung 1 stays caller-env only
A config.yaml `port` SHALL NOT count as explicit env in `cmd/rk/origin.go` `resolveOrigin`. It reaches the result only through the rung-3 `config.Load()` fallback, below the covering tmux server's `@rk_srv_origin`.

- **GIVEN** no `RK_HOST`/`RK_PORT` in the caller env, config.yaml `port: 4000`, and a valid `@rk_srv_origin` on the pane's server
- **WHEN** `resolveOrigin` runs
- **THEN** it returns the `@rk_srv_origin` value
- **AND** with no pane/option it returns `http://127.0.0.1:4000`

### Daemon: resolved deployment binding reaches the daemon

#### R6: `startSession` passes the resolved binding into the rk-daemon session
`internal/daemon` `startSession` SHALL add `-e RK_PORT=<config.Load().Port>` and `-e RK_HOST=<config.Load().Host>` to its `new-session`, always, beside the existing `RK_DAEMON_LOG` pin. It SHALL add `-e RK_CODE_SERVER_PORT=<n>` only when an explicit override is set (`Config.CodeServerPort != 0`). Passing a `+2` value would turn the convention into an override. Values are resolved in the calling process at call time. Env key names SHALL come from named constants in `internal/config` (`PortEnvVar`, `HostEnvVar`, `CodeServerPortEnvVar`), which `config.Load` also uses. No other magic strings.

- **GIVEN** a live rk-daemon tmux server born with `RK_PORT=A` in its environment
- **WHEN** `startSession` runs from a process whose resolved port is `B`
- **THEN** the spawned serve's environment has `RK_PORT=B`

#### R7: Sibling sessions stay consistent with the last start
Before the `new-session`, `startSession` SHALL sync the rk-daemon server's **global** environment to the caller's explicit deployment env, best-effort. For each of `RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT`: `set-environment -g KEY VALUE` when the caller has it set non-empty, otherwise `set-environment -gu KEY`. It is skipped silently when no server is running (a birth takes the caller env verbatim anyway). Failures are logged at Debug and never fail the start. Reason: `rk-jobs` windows (the UI update/restart buttons, `rk daemon run`) build their environment from the server's global env, not from the calling client. Without the sync, a later `rk update` job would re-resolve with the stale born-with `RK_PORT` and move the daemon back. Mirroring the caller's **raw** env, rather than the resolved value, keeps config-only installs config-driven (a later config.yaml edit still applies from a job window), while an env-only install keeps its env port across updates.

- **GIVEN** a live rk-daemon server whose global env has `RK_PORT=A`
- **WHEN** `startSession` runs from a caller with no `RK_PORT`
- **THEN** afterwards `show-environment -g RK_PORT` reports the variable removed/unset
- **GIVEN** a caller with `RK_PORT=B`
- **THEN** afterwards the global env has `RK_PORT=B`

#### R8: The born-with-environment hazard is empirically proven
The change SHALL include a real-tmux test on an isolated test socket. It asserts that a `new-session` **without** `-e`, issued against a server born with `RK_PORT=A` from a client whose env has `RK_PORT=B`, yields a pane env of `A` (the hazard), and that `startSession` yields `B` (the fix). If the hazard assertion does not hold on this tmux, the test and the memory hydrate SHALL record the observed behavior instead. `-e` stays as defense in depth.

- **GIVEN** the isolated socket and the fake-serve stub writing `$RK_PORT` to a file
- **WHEN** both variants run
- **THEN** the files read `A` and `B` respectively

#### R9: Port-in-use refusal names both homes
`guardPortAvailable`'s error SHALL keep the substrings `already serving on`, `not under the rk-daemon`, and `RK_PORT`, and SHALL name the config.yaml `port` key as the durable alternative, e.g. `… Stop it first, or set a different port (port: in ~/.config/run-kit/config.yaml, or RK_PORT).`

- **GIVEN** the configured port is held by a non-daemon listener
- **WHEN** `daemon start` runs
- **THEN** the error contains all three substrings and `port:`

### CLI help

#### R10: Help text documents the key and precedence
`rk serve` Long help SHALL state the port resolution order (default 3000 < `port:` in `~/.config/run-kit/config.yaml` < `RK_PORT`) and keep the existing examples. `rk daemon start` and `rk daemon restart` Long help SHALL each carry one line stating that the daemon resolves the port from config.yaml + env at start time, so editing either and running `rk daemon restart` moves it. Help edits SHALL conform to `shll standards` help rules.

- **GIVEN** `rk serve --help`
- **THEN** the output names `port:`, `RK_PORT`, and the default 3000

### Governance and docs

#### R11: Constitution IV amended to v1.15.0
`fab/project/constitution.md` Principle IV SHALL state that the daemon port is also a config.yaml key (`port`) that keeps its `RK_PORT` env form, and that `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` remain the only keys with env forms. Version 1.14.0 → **1.15.0**, Last Amended 2026-09-25. No other principle changes.

- **GIVEN** the amended constitution
- **THEN** IV names `port` as a config.yaml key, the env-form sentence is intact, and the footer reads `1.15.0`

#### R12: Present-truth docs updated, defaults untouched
`README.md`, `docs/site/install.md`, and `fab/project/context.md` (and `docs/specs/*`/`docs/site/skill.md` only where they claim port is env-only) SHALL describe the config.yaml form alongside `RK_PORT`, keeping 3000 as the stated default. Plan row P3 in `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL have its version text corrected to "v1.14.0 → 1.15.0" and its status set to in progress.

- **GIVEN** the README's port instructions
- **THEN** they show both `port: <n>` in config.yaml + `rk daemon restart` and `RK_PORT`, and still say default 3000

### Serve: startup-resolved ports

#### R13: Request handlers use the startup-resolved ports
The serve process SHALL resolve the listen port and the code-server port once, at startup. `handleCode` (`/code/*`) SHALL proxy to the startup-resolved `Server.codeServerPort`, which the SSE hub already uses. `GET /api/health`'s `tunnel` field SHALL report a startup-resolved listen port (a new `Server` field seeded from the same startup `config.Load()`). Neither handler may call `config.Load()` per request. Now that config.yaml feeds the port, a per-request read costs a disk read on every code-server asset request, and a mid-run `port:` edit or settings POST would make the advertised tunnel port and the `/code/` target diverge from the listener that is actually bound. A serve without `RK_PORT` (foreground `rk serve`) is exposed to this; the daemon is covered by the `-e` pin.

- **GIVEN** a running serve that started with resolved port 4000 (code-server 4002)
- **WHEN** config.yaml is edited to `port: 5000` and `/api/health` and `/code/` are requested
- **THEN** `tunnel` is still 4000 and `/code/` still proxies to 4002
- **AND** the `handleCode` comment no longer claims per-request env resolution

### Non-Goals

- `rk serve --port` flag — user decision at intake; the port chain is code default < config.yaml < `RK_PORT`
- Settings-dialog control for `port` — `ui: false` by user decision; the frontend panel is untouched
- Config keys for `RK_HOST` / `RK_CODE_SERVER_PORT` — they stay env-only (Constitution IV, plan rule P)
- Changing the default to 6123, the `.env` orphaned comment, doctor rows, reserved-block warnings, `~/.config/hexokit` paths — owned by C5 / P1 / C4
- Renaming any `RK_*` variable (plan D2)

### Design Decisions

#### Serialize-when-set for a pin key
**Decision**: `port` serializes whenever explicitly set, even when equal to the code default; 0 = unset is omitted.
**Why**: the key exists to pin an install (C4 writes `port: 3000`). `Save` rewrites the whole file, so omit-at-default would drop the pin on any settings save and silently move the install when C5 flips the default.
**Rejected**: the omit-at-default convention the other scalars use — it cannot tell "pinned at 3000" apart from "unset".
*Introduced by*: 260925-v1r0-port-config-key

#### `-e` for the daemon, raw-env mirror for the server's global env
**Decision**: the daemon session gets the resolved binding via `-e`. The rk-daemon server's global env is synced to the caller's raw `RK_*` deployment env (`set -g` when set, `-gu` when not).
**Why**: tmux builds a new session's env from the server's global env, fixed at birth, and ignores client env outside `update-environment`. `-e` fixes the serve itself. The global sync keeps `rk-jobs` windows (UI update/restart) from re-resolving with a stale born-with value and moving the daemon back.
**Rejected**: `-e` alone (update jobs flip-flop the port); setting the resolved value globally (turns a config-derived value into env, so later config edits never apply from job windows); unsetting globally always (env-only installs would lose their port on `rk update`); a `serve --port` argv flag (every in-process `config.Load()` would need separate plumbing).
*Introduced by*: 260925-v1r0-port-config-key

#### Default daemon port is single-sourced from the port policy
**Decision**: `portpolicy.DaemonDefault` is the code default; `internal/config` and the settings registry's default text both read it.
**Why**: the port policy (`ports.env`) is the one source of truth for reserved and default ports; `internal/portpolicy` imports only the standard library, so both packages can depend on it without a cycle.
**Rejected**: a `settings.DefaultPort` constant (the pre-rebase design — a second home beside `ports.env`); duplicating the literal in both packages (magic-number anti-pattern; the two could drift at C5).
*Introduced by*: 260925-v1r0-port-config-key

## Tasks

### Phase 1: Core

- [x] T001 Add `DefaultPort` constant, `Port int` field, and the `port` registry entry (kind `port`, def `strconv.Itoa(DefaultPort)`, category `connectivity`, `ui: false`, `live: false`) with parse/serialize/read/apply hooks per R1–R3. Place it among the scalar keys right after `ssh_host`. Update the package doc comment on env forms. Files: `app/backend/internal/settings/settings.go` <!-- R1 -->
- [x] T002 Settings tests: parse valid/invalid/out-of-range/quoted, serialize-when-set including `port: 3000` round-trip through `Save`/`Load`, omitted-when-unset, `ReadValue` nil vs int, `ApplyValue` null/int/string/0/70000/fractional/bool, registry row metadata; update any registry key-count or order assertions. Files: `app/backend/internal/settings/settings_test.go`, `app/backend/internal/settings/registry_test.go` <!-- R2 -->
- [x] T003 `config.Load()` middle rung from `settings.Load().Port`; `defaults.Port = settings.DefaultPort`; add `PortEnvVar`/`HostEnvVar`/`CodeServerPortEnvVar` constants and use them in `Load`; update doc comments. Tests (isolate with `t.Setenv(settings.ConfigDirEnv, t.TempDir())`): config-only, env-over-config, invalid-env-falls-to-config, neither, `ResolvedCodeServerPort` = config port + 2. Files: `app/backend/internal/config/config.go`, `app/backend/internal/config/config_test.go` <!-- R4 -->

### Phase 2: Daemon wiring

- [x] T004 `startSession`: add `-e RK_PORT=<cfg.Port>`, `-e RK_HOST=<cfg.Host>`, and `-e RK_CODE_SERVER_PORT=<cfg.CodeServerPort>` (only when non-zero) using the config constants. Before `new-session`, call a new helper (e.g. `syncServerDeploymentEnv(ctx)`) that probes whether the server is alive and mirrors the caller's raw env for the three keys via `set-environment -g` / `-gu` through `runTmux`, best-effort with Debug logging, following the codeserver/gui seam style if a test seam is needed. Update `guardPortAvailable`'s message per R9 and the `startSession` doc comment ("config is env-only" is no longer true). Files: `app/backend/internal/daemon/daemon.go` <!-- R6 -->
- [x] T005 Real-tmux tests on the package's isolated test socket (`useTestSocket`/`withServerSocket`/`testutil.WriteStub`, skip without tmux / in `-short`; settings root isolated): (a) hazard: birth the server via a placeholder session with `t.Setenv("RK_PORT", A)`, switch to `RK_PORT=B`, run a plain `new-session` without `-e` running a stub that writes `$RK_PORT` to a file → reads A; (b) fix: same setup, `startSession(stub)` → reads B; (c) config-only caller (no `RK_PORT`, config.yaml `port: C`) → reads C; (d) global sync: after (b) `show-environment -g RK_PORT` is `RK_PORT=B`; after a config-only start it is unset (`-RK_PORT` or absent); (e) `guardPortAvailable` message substrings. If (a) does not hold, assert the observed value and add a comment stating the observed tmux behavior. Files: `app/backend/internal/daemon/daemon_test.go` <!-- R8 -->
- [x] T006 `resolveOrigin` test: config.yaml `port: 4000`, no caller env → rung 2 option wins when present, rung-3 fallback is `http://127.0.0.1:4000` when absent. Files: `app/backend/cmd/rk/origin_test.go` <!-- R5 -->

### Phase 3: Help, governance, docs

- [x] T007 Help text per R10 after reading `shll standards` (help-output entries): `serve` Long (port resolution line, keep examples), `daemon start` / `daemon restart` Long (one line each). Update any help-dump golden tests if present. Files: `app/backend/cmd/rk/serve.go`, `app/backend/cmd/rk/daemon_start.go`, `app/backend/cmd/rk/daemon_restart.go` <!-- R10 -->
- [x] T008 Amend Constitution IV per R11 (insert the `port` clause after the env-forms parenthetical); bump the footer to `1.15.0`, Last Amended 2026-09-25. Files: `fab/project/constitution.md` <!-- R11 -->
- [x] T009 [P] Docs per R12: `README.md`, `docs/site/install.md`, `fab/project/context.md` Backend "Config" bullet; grep `docs/specs/` and `docs/site/skill.md` for env-only claims and update only those; plan row P3 version text + status. Files: `README.md`, `docs/site/install.md`, `fab/project/context.md`, `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` <!-- R12 -->

- [x] T011 Seed a startup listen-port field on `Server` from the existing startup `cfg := config.Load()` in `NewRouter` (`app/backend/api/router.go`, beside `codeServerPort`). Switch `handleCode` (`app/backend/api/proxy.go`) to `s.codeServerPort` and `handleHealth` (`app/backend/api/health.go`) `tunnel` to the new field. Rewrite the stale `handleCode` comment, and drop the now-redundant per-request `config.Load()` (which also removes the double settings read in health). Update test Server constructions/fixtures that relied on per-request resolution, and add a test proving a mid-run config.yaml change does not move `tunnel` or the `/code/` target. <!-- rework: per-request config.Load() on hot /code/* path + tunnel/listener divergence (orchestrator triage; reviewer should-fix proxy.go:219) --> <!-- R13 -->
- [x] T012 Review polish: replace `waitForFileContent` in `app/backend/internal/daemon/daemon_test.go` with a closure over the existing `testutil.MustWaitUntil`/`WaitUntil`; extend the `startSession` tests to cover `-e RK_HOST` always-pass, `-e RK_CODE_SERVER_PORT` only-when-overridden, and the corresponding `syncServerDeploymentEnv` set/unset arms (table-driven where natural). <!-- rework: reviewer should-fix daemon_test.go:1427 + nice-to-have daemon.go:421-427 coverage --> <!-- R6 -->

### Phase 4: Verification

- [x] T010 Gates: `just _ensure-tmux-conf` if needed, then `cd app/backend && env -u TMUX -u TMUX_PANE go test ./...` (full, not piped through tail), `go vet ./...`; `pnpm install --frozen-lockfile` in `app/frontend` if `node_modules` is absent, then `just test-frontend` (catches any `/api/settings` row snapshots). No e2e run is needed (no UI/route change); run `just test-e2e settings` only if a spec asserts the settings row list. <!-- R3 -->

## Execution Order

- T001 → T002; T001 → T003 (config imports `settings.DefaultPort`); T003 → T004 → T005; T003 → T006
- T007–T009 are independent of Phase 2; T010 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `settings.Registry()` has a `port` row (kind `port`, default `"3000"`, category `connectivity`, `UI: false`, `Live: false`); `settings.DefaultPort` is the single source of the 3000 literal for both packages
- [x] A-002 R2: `port: 3000` survives a `Load` → `Save` round-trip; `Port == 0` emits no line; invalid values parse to 0
- [x] A-003 R3: `ReadValue` returns nil when unset and the int when set; `ApplyValue` accepts null and in-range integers only, erroring without mutation otherwise
- [x] A-004 R4: `config.Load()` resolves default < config.yaml < valid `RK_PORT`, ignores invalid `RK_PORT`, and `ResolvedCodeServerPort` follows the resolved port + 2
- [x] A-005 R6: `startSession`'s `new-session` carries `-e RK_PORT=`, `-e RK_HOST=`, and `-e RK_CODE_SERVER_PORT=` only when overridden, with names from config constants
- [x] A-006 R7: `startSession` mirrors the caller's raw `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` into the live server's global env (`-g` set / `-gu` unset), best-effort, and never fails the start
- [x] A-007 R9: the port-in-use error keeps `already serving on`, `not under the rk-daemon`, `RK_PORT` and names `port:` in config.yaml
- [x] A-008 R10: `serve`, `daemon start`, `daemon restart` help text document the key and precedence
- [x] A-009 R11: Constitution IV names `port` as a config.yaml key with its env form kept; footer `1.15.0`, Last Amended 2026-09-25
- [x] A-010 R12: README, install page, and context.md show the config.yaml form beside `RK_PORT` with default still 3000; plan row P3 version text reads 1.14.0 → 1.15.0

### Behavioral Correctness

- [x] A-011 R4: an existing install with no `port` key resolves exactly as before (env or 3000); nobody's port changes
- [x] A-012 R5: `resolveOrigin` rung 1 still triggers only on caller `RK_HOST`/`RK_PORT`; a config `port` never jumps `@rk_srv_origin`

### Scenario Coverage

- [x] A-013 R8: a real-tmux test proves the hazard (no `-e` → born-with value) and the fix (`startSession` → caller-resolved value) on an isolated socket, or records the observed tmux behavior if the hazard does not reproduce
- [x] A-014 R7: a real-tmux test shows the global env set after an env-carrying start and unset after a config-only start

### Edge Cases & Error Handling

- [x] A-015 R2: `port: 0`, `port: -1`, `port: 65536`, `port: "abc"`, `port: ""` all parse to unset without error
- [x] A-016 R7: the global-env sync against a dead/absent server is a silent no-op, and a failed `set-environment` does not fail `startSession`

### Code Quality

- [x] A-017 Pattern consistency: new registry entry, hooks, and daemon helper follow the surrounding file idioms (registry entry shape, seam vars, `runTmux` wrapper, `slog` levels)
- [x] A-018 No unnecessary duplication: env key names and the default port each exist once; existing test helpers (`useTestSocket`, `withServerSocket`, `WriteStub`) are reused
- [x] A-019: all subprocess calls go through `exec.CommandContext` with timeouts via the existing tmux wrappers; no shell strings; the `-e` values are argv elements
- [x] A-020: no magic strings or numbers — `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` and 3000 come from named constants
- [x] A-021: new behavior is covered by tests (settings, config, daemon, origin); comments state constraints, never narrate or cite change IDs
- [x] A-022: the full Go suite (`env -u TMUX -u TMUX_PANE go test ./...`) and `just test-frontend` pass

### Security

- [x] A-023 R3: port values are validated to 1–65535 on parse and apply; the `-e` values are formatted integers or the already-validated host, passed as argv elements (no shell interpolation)

### Rework Coverage

- [x] A-024 R13: `handleCode` and `/api/health` use startup-resolved ports (no per-request `config.Load()`); a test shows a mid-run config.yaml edit does not move `tunnel` or the `/code/` target
- [x] A-025 R6: tests cover `-e RK_HOST` always-pass, `-e RK_CODE_SERVER_PORT` only when overridden, and both `syncServerDeploymentEnv` arms for those keys; the daemon test uses `testutil` polling helpers (no bespoke wait helper)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (re-verified on re-review: the per-request `config.Load()` calls in `handleCode`/`handleHealth` were removed by the change itself; no zero-call-site symbols or newly-duplicated logic remain)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Default constant lives in `internal/settings` (`DefaultPort`), not `internal/config` | `config` imports `settings`, so the reverse import would cycle; supersedes intake #8's "one exported constant" location | S:80 R:90 A:95 D:90 |
| 2 | Confident | Sync the rk-daemon server's global env to the caller's raw `RK_*` deployment env before `new-session` | Verified that UI update/restart run `rk` in `rk-jobs` windows (`api/update.go` `runJobFn`), whose env is the server's global env; `-e` alone would let a job move the port back | S:60 R:80 A:75 D:65 |
| 3 | Confident | Pass `-e RK_HOST` always and `-e RK_CODE_SERVER_PORT` only when overridden (intake #15 adopted) | Same born-with staleness class; passing a `+2` value would convert the convention into an override | S:55 R:85 A:75 D:70 |
| 4 | Confident | `ApplyValue` for `port` accepts JSON integers only (no numeric strings) | Stricter write mirrors the registry's strict-write/tolerant-read posture; the intake left the choice to apply | S:45 R:90 A:75 D:65 |
| 5 | Confident | Registry category `connectivity`, placed right after `ssh_host` | Sits beside the other reachability key; cosmetic with `ui: false` | S:40 R:95 A:70 D:60 |
| 6 | Confident | No e2e run in the gate; unit + frontend Vitest suffice | No UI surface, route, or rig behavior changes; the e2e harness sets `RK_PORT` explicitly, so env wins | S:60 R:85 A:80 D:75 |
| 7 | Confident | The `docs/specs/api.md` Base Configuration table dropped the nonexistent `CLI -port` / `-host` rungs while gaining the config.yaml `port` rung | No port/host CLI flag exists (intake decision); leaving the false rung beside the new one in a row this change touches would contradict R10/R12 | S:50 R:85 A:70 D:60 |

6 assumptions (1 certain, 5 confident, 0 tentative).
