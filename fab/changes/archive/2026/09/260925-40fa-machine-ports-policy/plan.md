# Plan: Machine-Only Ports + Ports Policy

**Change**: 260925-40fa-machine-ports-policy
**Intake**: `intake.md`

## Requirements

### Backend: Port policy package

#### R1: One embedded policy file is the single source of truth
A committed file `app/backend/internal/portpolicy/ports.env` MUST hold every reserved/default port value as bash-sourceable `KEY=integer` lines (plus `#` comments), with these values: daemon default `3000`, rig block `21000`–`21299`, tunnel block `3100`–`3199`, sentinel `21999`. Keys MUST NOT start with `RK_` and are never exported (they are not an env-var surface). Package `internal/portpolicy` (NOT `internal/ports`) MUST embed the file via `//go:embed`, parse it once at package init, and panic on a missing/malformed key (programmer error). It MUST expose `DaemonDefault int`, `Rig Block`, `Tunnel Block`, `Sentinel int` (where `Block{Name string; Start, End int}` is inclusive), `Reserved() []Block` (rig, tunnel, and the sentinel as a one-port block), and `Collisions(port, codeServerPort int) []Block`.

- **GIVEN** the committed `ports.env`
- **WHEN** the package initializes
- **THEN** `DaemonDefault == 3000`, `Rig == {21000, 21299}`, `Tunnel == {3100, 3199}`, `Sentinel == 21999`
- **AND** `(Rig.End - Rig.Start + 1) % 3 == 0` (100 triples), the sentinel and daemon default lie outside `Rig`, and `Tunnel` does not overlap `Rig`

#### R2: Collisions reports reserved blocks hit by the daemon footprint
`Collisions(port, codeServerPort)` MUST return every reserved block containing `port` or `codeServerPort` (the resolved code-server port — `port+2` by convention or the explicit override; a `0` code-server port is ignored). Each block is reported at most once.

- **GIVEN** port 3000, code-server 3002 → **THEN** no collisions
- **GIVEN** port 3098, code-server 3100 → **THEN** the tunnel block
- **GIVEN** port 21999 → **THEN** the sentinel block
- **GIVEN** port 21000 (or 21299) → **THEN** the rig block

### Backend: Consumers read the policy

#### R3: Config default and tunnel range read from the policy, values unchanged
`internal/config` `defaults.Port` MUST come from `portpolicy.DaemonDefault` (still 3000). `internal/remote`'s tunnel range MUST come from `portpolicy.Tunnel` (still 3100–3199); every existing call site (`AssignPort`, `store.go` validation, `cmd/rk/remote.go` flag help, tests) keeps its behavior. The stale `internal/remote/ports.go` comment naming `3000/3020/3333` is replaced by a pointer to the policy.

- **GIVEN** no `RK_PORT` → **WHEN** `config.Load()` → **THEN** Port 3000
- **GIVEN** an empty remotes file → **WHEN** `AssignPort(f, nil, 0)` → **THEN** 3100; an explicit 3050 errors naming `3100-3199`

### Harness: Scripts derive the rig block from the policy

#### R4: e2e-env.sh and test-e2e.sh read the policy file
`scripts/e2e-env.sh` MUST source `ports.env` (path resolved from its own script dir) and derive `E2E_PORT = RIG_START + (hash % TRIPLES) * 3` with `TRIPLES = (RIG_END - RIG_START + 1) / 3`, staying pure (no probing, no mutation), leaving policy variables unexported and unsetting its temporaries at the end. Its hand-maintained avoid-list comment is replaced by a pointer to the policy file. `scripts/test-e2e.sh` MUST derive every rig-block literal (the `RK_E2E_WORKERS` cap and its message, the step-forward bound, the multi-rig wrap/alignment arithmetic, and their error texts) from the policy values; no `3400`/`3697`/`3699` literal remains. `RK_E2E_PORT` stays the override.

- **GIVEN** a worktree with no `RK_E2E_PORT`
- **WHEN** `e2e-env.sh` is sourced
- **THEN** `E2E_PORT` is in `[21000, 21297]` and `(E2E_PORT - 21000) % 3 == 0`
- **AND** re-sourcing yields the same value; `RK_E2E_PORT=21333` is honored verbatim

### Harness: Playwright sentinel

#### R5: One helper owns the harness-port read with sentinel fallback 21999
A single frontend helper MUST own the `E2E_PORT` read: a function (read lazily at call time, so `playwright.config.ts`'s `applyWorkerRig()`-first ordering contract is preserved) returning `Number(process.env.E2E_PORT)` when set, else the policy's sentinel parsed from `ports.env` (via `node:fs`, no new deps). It MUST never consult the ambient `RK_PORT`. Every code site that today reads `process.env.E2E_PORT ?? "3333"` / `?? 3333` — `app/frontend/playwright.config.ts`, `tests/e2e/_boards.ts`, `_gui.ts`, `echo-latency.spec.ts`, `mobile-touch-scroll.spec.ts`, `session-reorder.spec.ts`, `touch-focus-gate.spec.ts`, and `app/desktop/tests/e2e/_shell.ts` (by relative import, as desktop specs already import `../../../frontend/tests/e2e/_tmux`) — MUST use it. Port-related `3333` comments are updated.

- **GIVEN** no `E2E_PORT` → **WHEN** a bare `playwright test` resolves the base URL → **THEN** it is `http://localhost:21999`
- **GIVEN** `E2E_PORT=21042` → **THEN** the helper returns 21042
- **AND** `git grep -n 3333 -- app scripts` shows no port-related hit (CSS keyframes, the transcript testdata UUID, and byobu colors excepted)

### CLI: `rk ports`

#### R6: A new `rk ports` verb prints the policy
A top-level `rk ports` command (`cmd/rk/ports.go`, registered in `root.go`, `Args: cobra.NoArgs`, `SilenceUsage`) MUST print, on stdout via the output sink: the daemon default with its `+1` dev backend / `+2` code-server arithmetic, the rig block with its triple count, the tunnel block, the sentinel, the effective daemon port (`config.Load()`, with resolved code-server port), and any collision warning. `--json` MUST emit one `{"ok":true,"result":…}` envelope via `newSink(cmd).JSONResult` with a stable shape (daemon default, effective port/code-server port, blocks with name/start/end, sentinel, collisions list — empty array, never null). Help text MUST say this is the port *policy*, not a listening-port listing, and include an example. Exit 0 always (warn-only). The README command table gains a `rk ports` row.

- **GIVEN** no `RK_PORT` → **WHEN** `rk ports --json` → **THEN** exit 0, one envelope, `collisions: []`, effective port 3000
- **GIVEN** `RK_PORT=3150` → **WHEN** `rk ports` → **THEN** exit 0 and the output names the tunnel block collision

### Daemon: Collision warning and doctor row

#### R7: `rk serve` warns (never refuses) on a reserved-block port
After `config.Load()` in `serve`'s `RunE`, for each block in `portpolicy.Collisions(cfg.Port, cfg.ResolvedCodeServerPort())` the server MUST emit one `slog.Warn` naming the port, the block name and range, and the remedy (set `RK_PORT` outside it), then continue starting. The warning logic SHOULD be a small helper testable without starting the server.

- **GIVEN** `RK_PORT=21000` → **WHEN** `rk serve` starts → **THEN** a warning names the rig block and the server still starts
- **GIVEN** the default 3000 → **THEN** no warning
- **GIVEN** a dev build (`version == "dev"`: `just dev`/air, the e2e rig's `go build`) on a rig-block port → **THEN** no rig-block warning (the rig block is where worktree dev and e2e rigs live by design); a released build on the same port still warns, and tunnel/sentinel hits warn for every build

The dev-build rig-block exemption MUST be one helper in `cmd/rk` (e.g. `reservedCollisions(cfg config.Config) []portpolicy.Block`) shared by `serve` (R7), the doctor row (R8), and `rk ports` (R6), so the three surfaces never disagree.

#### R8: Doctor gains an OK-shaped `ports` row
`runDoctorChecks` MUST append a `doctorCheck{Name: "ports", OK: true}` whose `Note` lists the effective daemon port and the reserved blocks, and — on collision — leads with a warning naming the block(s) and the fix. The row MUST never flip the doctor verdict. It is built by a pure function over the resolved config for table testing.

- **GIVEN** the default config → **THEN** OK, note like `daemon :3000 (default); reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999`
- **GIVEN** `RK_PORT=3150` → **THEN** OK, note starts with a warning naming the tunnel block; `report.OK` unaffected

### Docs: Stated facts

#### R9: Present-tense statements of the old values are updated
`fab/project/context.md` § Testing (the `3400–3699` block and the "fallback port is 3333" paragraph), `justfile` comments naming `3400–3699`, `scripts/pw.sh` / `scripts/test-e2e.sh` `:3333` comments, and `app/desktop/playwright.config.ts` / `server-reorder.spec.ts` comments MUST state the new values or point at the policy file. (`docs/memory/` is updated at hydrate, not here.)

- **GIVEN** the change applied → **WHEN** `git grep -n '3400–3699\|3400-3699'` over `app/ scripts/ justfile fab/project/` → **THEN** no hits

### Consistency: Tunnel range and block summary have one source

#### R10: No tunnel-range literal survives outside the policy
`cmd/rk/remote.go`'s `--local-port` flag help (and any `rk remote` help text) MUST derive its range from `portpolicy.Tunnel` (or the remote `PortRange*` vars that alias it); `internal/remote/store.go` comments stating `3100-3199` MUST point at the policy instead of restating the values.

- **GIVEN** the change applied → **WHEN** `git grep -n '3100-3199\|3100–3199' -- app/backend ':!*_test.go' ':!*ports.env'` → **THEN** no hits

#### R11: One formatter renders the reserved-block summary
`internal/portpolicy` MUST expose one formatter (e.g. `Summary() string` → `rig 21000–21299, tunnel 3100–3199, sentinel 21999`) used by both `rk ports` human output and the doctor `ports` note; neither formats the blocks independently.

- **GIVEN** `rk ports` and `rk doctor` → **THEN** both render the reserved-block list via the same function

### Non-Goals

- Daemon default 3000 → 6123 (C5); tunnel range move / `remotes.yaml` reassignment (C4); the `port` config.yaml key (P3); host default fix (P2)
- Any `RK_*` / `@rk_*` / `rk-*` rename or new env var (D2)
- `${RK_PORT:-3000}` literals in `justfile`, `scripts/perf-idle-cpu.*`, `scripts/dev-desktop.sh`, and `serve`/`url` help text — value unchanged; C5 sweeps default-stating sites
- `app/desktop/src/web-proxy.test.ts`'s `localhost:3400` (arbitrary host fixture)
- MCP exposure of `rk ports` (the MCP allowlist is explicit; not adding it)

### Design Decisions

#### Policy as an embedded data file, not a verb the scripts call
**Decision**: `ports.env` is committed, embedded by Go, sourced by bash, parsed by the Playwright helper; `rk ports` is the user-facing view.
**Why**: `e2e-env.sh` is sourced by `dev.sh`/`pw.sh`/`test-e2e.sh` before any build, and PATH `rk` is the brew install (no `ports` verb until release) — a verb-based read would need a `go run` per `just dev` or break on version skew.
**Rejected**: scripts calling `rk ports --json` (compile cost, tmux.conf embed prerequisite, version skew); Go constants + generated shell/TS copies with a drift test (more moving parts).
*Introduced by*: 260925-40fa-machine-ports-policy

#### Reserved-block collisions warn, never refuse
**Decision**: `rk serve` logs `slog.Warn`; doctor notes it on an OK row; `rk ports` reports it; nothing refuses to start.
**Why**: disruption-free — a working daemon may already sit inside 3100–3199.
**Rejected**: refusing in `serve` (breaks working installs); split refuse-new/warn-legacy (asymmetric for little gain).
*Introduced by*: 260925-40fa-machine-ports-policy

## Tasks

### Phase 1: Setup

- [x] T001 Create `app/backend/internal/portpolicy/ports.env` (commented `KEY=integer` lines, non-`RK_` key prefix e.g. `PORTPOLICY_`) and `app/backend/internal/portpolicy/portpolicy.go` (package doc, `//go:embed`, init-time parse that panics on missing/malformed keys, `Block`, `DaemonDefault`, `Rig`, `Tunnel`, `Sentinel`, `Reserved()`, `Collisions()`), plus `portpolicy_test.go` covering committed values, invariants (100 triples, sentinel/default outside rig, tunnel∩rig empty), parse errors on a malformed input (test the parser function directly), and the `Collisions` edge table from R2 <!-- R1 --> <!-- R2 -->

### Phase 2: Core Implementation

- [x] T002 [P] Point `app/backend/internal/config/config.go` `defaults.Port` at `portpolicy.DaemonDefault`; in `app/backend/internal/remote/ports.go` source `PortRangeStart`/`PortRangeEnd` from `portpolicy.Tunnel` (as package `var`s — Go `const` cannot take an init value — keeping every call site unchanged) and replace the stale `3000/3020/3333` comment with a policy pointer; confirm `internal/config` and `internal/remote` tests still pass <!-- R3 -->
- [x] T003 [P] Rewrite the derivation in `scripts/e2e-env.sh` to source `app/backend/internal/portpolicy/ports.env` (resolved from `_e2e_script_dir`) and compute the triple from `RIG_START`/`RIG_END`; replace the avoid-list comment; unset temporaries. In `scripts/test-e2e.sh` replace every `3400`/`3697`/`3699`/`100`-triple literal (worker cap + message, step-forward bound + message, multi-rig wrap/alignment, comments) with policy-derived values (source the file there too if e2e-env.sh unsets them, or have e2e-env.sh expose the derived `E2E_RIG_START`/`E2E_RIG_END`/`E2E_RIG_TRIPLES` unexported shell vars). Update the `:3333` comments in `scripts/pw.sh` and `scripts/test-e2e.sh` and the `3400–3699` comments in `justfile` <!-- R4 --> <!-- R9 -->
- [x] T004 [P] Add the harness-port helper to `app/frontend/tests/e2e/` (e.g. `harnessPort()` + `harnessOrigin()` in a new `_harness.ts`, or in `_rig.ts`), resolving `ports.env` relative to the helper via the ESM idiom (`fileURLToPath(new URL(…, import.meta.url))` — package is `"type": "module"`; match whatever existing e2e helpers use), reading `E2E_PORT` lazily. Switch `app/frontend/playwright.config.ts` (after `applyWorkerRig()`), `_boards.ts`, `_gui.ts`, `echo-latency.spec.ts`, `mobile-touch-scroll.spec.ts`, `session-reorder.spec.ts`, `touch-focus-gate.spec.ts`, and `app/desktop/tests/e2e/_shell.ts` (relative import from `../../../frontend/tests/e2e/…`; confirm desktop's Playwright loader resolves it) to the helper; update the comment-only `3333` mentions (`_boards.ts`, `_gui.ts`, `_shell.ts`, `server-reorder.spec.ts`, `app/desktop/playwright.config.ts`). Keep Test Intent Comments intact (constitution) <!-- R5 --> <!-- R9 -->
- [x] T005 Add `app/backend/cmd/rk/ports.go` (`portsCmd`, human output + `--json` via `newSink(cmd).JSONResult`, layered help with example, exit 0) and `ports_test.go` (default JSON shape incl. `collisions: []`, `RK_PORT=3150` human + JSON collision, help text names "policy"); register in `root.go` and add `"ports"` to `root_test.go`'s expected subcommands; add a `rk ports` row to the `README.md` command table <!-- R6 -->

### Phase 3: Integration & Edge Cases

- [x] T006 In `app/backend/cmd/rk/serve.go` call a small helper (e.g. `warnReservedPort(cfg)`) right after `config.Load()` that emits one `slog.Warn` per collision and never errors; add a `doctor.go` `portsDoctorCheck(cfg config.Config) doctorCheck` (OK-shaped, note per R8) appended in `runDoctorChecks`; table-test both (serve helper via a captured slog handler; doctor row in `doctor_test.go`, asserting it never flips `report.OK`) <!-- R7 --> <!-- R8 -->

### Phase 4: Polish

- [x] T007 Update `fab/project/context.md` § Testing (rig block 21000–21299 from the policy file; Playwright fallback 21999) <!-- R9 -->
- [x] T008 Verification gates: `just _ensure-tmux-conf` then `cd app/backend && env -u TMUX -u TMUX_PANE go test ./...` and `go vet ./...`; `pnpm install --frozen-lockfile` in `app/frontend` if `node_modules` is absent, then `just test-frontend` and `cd app/frontend && npx tsc --noEmit`; desktop typecheck if it has one; `bash -n` both scripts and source `e2e-env.sh` in a subshell to print `E2E_PORT` (assert range/alignment); run at least one frontend e2e spec via `just test-e2e <name>.spec` (confirm the rig binds in 21000–21299) and one desktop spec via the desktop lane; run `git grep` checks from R5/R9 <!-- R4 --> <!-- R5 --> <!-- R6 -->

### Phase 5: Rework (cycle 1 — review should-fix findings)

- [x] T009 Add a shared `reservedCollisions(cfg config.Config) []portpolicy.Block` helper in `app/backend/cmd/rk/` that returns `portpolicy.Collisions(cfg.Port, cfg.ResolvedCodeServerPort())` minus the rig block when `version == "dev"` (make the version read a seam so tests can flip it); route `warnReservedPorts` (serve.go), the doctor `ports` row, and `rk ports` collisions through it; extend `serve_warn_test.go`, `doctor_test.go`, `ports_test.go` for dev-build rig-port (no rig hit) vs released-build rig-port (hit) vs dev-build tunnel-port (hit). Update the helper/serve comments to state why the rig block is exempt for dev builds <!-- R7 --> <!-- R8 --> <!-- R6 -->
- [x] T010 [P] Derive `app/backend/cmd/rk/remote.go`'s `--local-port` help text range from the policy (the `remote.PortRangeStart/End` vars already alias `portpolicy.Tunnel`), and repoint `app/backend/internal/remote/store.go` comments that restate `3100-3199` at the policy; confirm the R10 `git grep` is clean <!-- R10 -->
- [x] T011 [P] Add `portpolicy.Summary()` (reserved-block one-liner, tested in `portpolicy_test.go`) and use it from `cmd/rk/ports.go` human output and `cmd/rk/doctor.go`'s `ports` note, deleting their independent formatting <!-- R11 -->
- [x] T012 Re-run gates: `cd app/backend && env -u TMUX -u TMUX_PANE go test ./...` + `go vet ./...`; one `just test-e2e api-integration.spec` run, confirming the rig backend log NO LONGER carries the reserved-block warning and the spec passes <!-- R7 -->

## Execution Order

- T001 blocks T002, T005, T006 (they import `portpolicy`); T003 and T004 depend only on `ports.env` from T001
- T008 runs last in the initial pass; T009–T011 then T012 in the rework cycle (T009 and T011 both touch ports.go/doctor.go — do them sequentially)

## Acceptance

### Functional Completeness

- [x] A-001 R1: `internal/portpolicy` embeds `ports.env`, exposes the values/types/functions named in R1, and its tests assert the committed values and invariants
- [x] A-002 R2: `Collisions` returns the tunnel/rig/sentinel blocks for the R2 edge inputs and nothing for 3000/3002
- [x] A-003 R3: `config.Load()` default is 3000 via the policy; remote tunnel range is 3100–3199 via the policy; existing remote/config tests pass unchanged
- [x] A-004 R4: `e2e-env.sh` and `test-e2e.sh` contain no `3400`/`3697`/`3699` literal and derive from `ports.env`; a sourced `E2E_PORT` lands in 21000–21297, 3-aligned, deterministic
- [x] A-005 R5: one helper owns the `E2E_PORT` read with sentinel fallback from the policy file; all 8 code sites use it; no port-related `3333` remains in `app/` or `scripts/`
- [x] A-006 R6: `rk ports` and `rk ports --json` print the policy, effective port, and collisions; registered on root; README row present
- [x] A-007 R7: `rk serve` emits one `slog.Warn` per collision after `config.Load()` and still starts
- [x] A-008 R8: doctor has an OK-shaped `ports` row with the specified note and it never flips the verdict
- [x] A-009 R9: `context.md`, `justfile`, script, and spec comments state the new values or point at the policy

### Behavioral Correctness

- [x] A-010 R4: an e2e run (`just test-e2e <name>.spec`) boots its rig on a 21000–21299 triple and passes
- [x] A-011 R5: a bare Playwright base URL (no `E2E_PORT`) resolves to `:21999`, not a live server

### Scenario Coverage

- [x] A-012 R2: unit tests cover block start, block end, +2 straddling into the tunnel block, the sentinel, and the no-hit default
- [x] A-013 R6: `ports_test.go` covers default JSON (`collisions: []`) and an `RK_PORT=3150` collision in both human and JSON output
- [x] A-014 R8: `doctor_test.go` table covers default and collision notes

### Edge Cases & Error Handling

- [x] A-015 R1: the parser rejects a missing key and a non-integer value (tested via the parse function), and init panics rather than silently defaulting
- [x] A-016 R4: `RK_E2E_PORT` still overrides the derivation verbatim; the multi-rig wrap stays inside the block (last triple wraps to 21000)
- [x] A-017 R2: a zero code-server port is ignored by `Collisions`

### Rework (cycle 1)

- [x] A-024 R7: a dev build on a rig-block port logs no rig-block warning; a released build does; tunnel/sentinel hits warn for any build — covered by tests
- [x] A-025 R7: serve, doctor, and `rk ports` all derive collisions from the one shared helper
- [x] A-026 R10: no `3100-3199`/`3100–3199` literal in non-test backend source outside `ports.env`; `rk remote add --help` still names the range
- [x] A-027 R11: `portpolicy.Summary()` exists, is tested, and is the only reserved-block formatter used by `rk ports` and doctor
- [x] A-028 R7: an `api-integration.spec` e2e run passes and its rig backend log has no reserved-block warning

### Code Quality

- [x] A-018 Pattern consistency: new verb, doctor row, and helper follow sibling patterns (`url.go`/`daemon_status.go` output sink + envelope, advisory doctor rows, e2e helper module style)
- [x] A-019 No unnecessary duplication: every port value exists only in `ports.env`; Go, shell, and TS all read it
- [x] A-020 Tests included: new behavior (policy, verb, serve warning, doctor row, helper) has tests
- [x] A-021 No magic numbers: no new bare port literal outside `ports.env` (tests asserting committed values excepted)
- [x] A-022 Comment discipline: comments state constraints/why only — no narration, no change IDs or PR numbers
- [x] A-023 Constitution: justfile recipes stay one-liners (VIII); no new env vars (IV/D2); Playwright Test Intent Comments preserved

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The scattered `E2E_PORT ?? "3333"` reads, the e2e-env.sh avoid-list comment, and the stale `internal/remote/ports.go` comment it replaced were removed inline in the same diff; nothing unused survives.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Remote `PortRangeStart`/`End` become package `var`s initialized from `portpolicy.Tunnel` | Smallest diff; keeps every call site and test unchanged; Go const cannot hold an init value | S:60 R:90 A:75 D:65 |
| 2 | Certain | Desktop `_shell.ts` imports the frontend helper by relative path | Desktop specs already import `../../../frontend/tests/e2e/_tmux` | S:80 R:90 A:90 D:85 |
| 3 | Confident | Key prefix `PORTPOLICY_` in `ports.env` | Not `RK_` (D2 / constitution IV env list); self-describing when sourced | S:55 R:90 A:75 D:65 |
| 4 | Confident | `rk ports` is not added to the MCP allowlist | MCP policy is an explicit allowlist; exposure is scope creep | S:55 R:90 A:75 D:70 |
| 5 | Confident | Only README gains a `rk ports` row; `docs/site/skill.md` untouched | README carries the full command table; the skill bundle lists agent-relevant verbs only | S:50 R:90 A:65 D:60 |
| 6 | Confident | Init-time parse panics on malformed policy | The file is committed and embedded — a bad value is a build-time defect; unit test on the committed file catches it before ship | S:60 R:85 A:80 D:70 |

| 7 | Confident | Dev-build rig-block exemption keys on `version == "dev"` rather than a new env marker | Dev and e2e rigs always run un-ldflagged builds; a released daemon in the block still warns; no new env var (D2/constitution IV) and no script change; `E2E_HARNESS` already means "launched by test-e2e" and cannot be reused for plain `just dev` | S:60 R:85 A:70 D:60 |

7 assumptions (1 certain, 6 confident, 0 tentative).
