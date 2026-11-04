# Intake: Machine-Only Ports + Ports Policy

**Change**: 260925-40fa-machine-ports-policy
**Created**: 2026-09-25

## Origin

> Machine-only ports + the ports policy (P1 of fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md). New policy package holds the daemon default, rig block, tunnel block, sentinel — exposed as a new `rk ports` verb (no such verb exists today) so scripts/e2e-env.sh, test-e2e.sh, playwright.config.ts read the ranges instead of hardcoding; e2e rig triples 3400-3699 -> 21000-21299, Playwright fail-closed sentinel 3333 -> 21999 (collapse the literal, now in 12 files, into one helper); refuse or warn when the configured daemon port lands inside a reserved block; doctor row. Name the package internal/portpolicy, not internal/ports (internal/ports already exists as the listening-TCP-port collector). The remote tunnel range constants live in internal/remote/ports.go (PortRangeStart/End) and should read from the policy too, keeping their 3100-3199 values — only a later C4 change may move them. Nothing persists rig ports, so this is disruption-free and independent of the rebrand. Read the whole plan file first for the rules table (D2 etc — rk/RK_*/@rk_*/rk-* are never renamed) and this row's full text.

Interaction mode: one-shot `/fab-new`, with two questions asked during intake (both answered with the recommended option):

1. **Policy source.** Asked: how do in-repo scripts and Playwright read the ranges, given that `scripts/e2e-env.sh` is sourced by `dev.sh`, `pw.sh`, and `test-e2e.sh` *before* any binary is built (`test-e2e.sh` sources it at line 16 and builds `rk` at line 397), and the `rk` on PATH is the brew install, which has no `ports` verb until a release ships? **User chose: an embedded data file.** One committed file holds the values. Go reads it via `//go:embed`. `rk ports [--json]` shows it to users and to scripts outside the repo. The in-repo shell scripts and the TS helper read the file directly. Rejected: scripts shelling out to `rk ports`, which means a `go run` compile on every `just dev`/`just pw`, needs the tmux.conf embed staged first, or breaks against an older installed binary. Also rejected: Go constants plus generated shell/TS copies with a drift test, which has more moving parts than one shared file.
2. **Collision posture.** Asked: what happens when the configured daemon port lands inside a reserved block? **User chose: warn only.** `rk serve` logs a warning at startup, the doctor row flags it with a note, and nothing refuses to start. Rejected: refusing in `serve`, which would stop a daemon that works today (e.g. `RK_PORT=3150` inside the tunnel range), and a split posture (refuse in the new block, warn in the legacy tunnel range).

Binding rules from the plan (Certain, do not re-open): **D2** — `rk`, every `RK_*` env var, `@rk_*` tmux option, and `rk-*` socket/session name are never renamed, and this change introduces **no new env var names**. **Rule P** — machine-only ports move to a 5-digit block humans never type: e2e rig triples 21000–21299, Playwright sentinel 21999, remote tunnels 21500–21599 **later (C4 only)**. The daemon default stays 3000 here; C5 moves it to 6123. GUI ports are unchanged.

## Why

1. **The problem.** Port knowledge is scattered as bare literals with no owner. The e2e rig block `3400–3699` is hardcoded in `scripts/e2e-env.sh` (the derivation formula), in `scripts/test-e2e.sh` (six-plus sites: the worker cap error, the step-forward bound `3699`, the multi-rig wrap `3400`/`3697`), and in comments. The Playwright fail-closed sentinel `3333` appears as a code literal in 8 places across two packages, plus comments in about 5 more files (12 files in total). The tunnel range `3100–3199` is a pair of Go constants in `internal/remote/ports.go`, and the daemon default `3000` sits in `internal/config` `defaults`. No single place says "these blocks are reserved and why", so the e2e-env.sh comment carries an ad-hoc avoid list (3000/3001, 3020/3021, 3100–3199, 3333, 3939) by hand.
2. **The consequence of not fixing it.** The rebrand's rule P moves machine-only ports into a 5-digit block (21000–21999), and later C4/C5 move the tunnel range and daemon default. Without a single policy, every one of those moves is a grep-and-pray across shell, Go, and TS, and a missed literal silently points a Playwright run at a live `rk serve` (the exact failure the sentinel exists to prevent). Also, today nothing tells a user that their `RK_PORT` collides with a reserved block. A daemon on 3150 would silently fight `rk remote` tunnel assignment.
3. **Why this approach.** One embedded data file is the only design that is readable by all three consumers (bash sourced pre-build, Go, Playwright TS) without a build step or a dependency on the installed binary's version. The `rk ports` verb gives the policy a user-visible surface. Moving the rig block and sentinel now is disruption-free because nothing persists rig ports: they are re-derived every run. The tunnel range is persisted in `remotes.yaml`, so it keeps its values here and only C4 moves it.

## What Changes

### 1. New package `app/backend/internal/portpolicy` + the policy data file

- **Package name is `internal/portpolicy`**, NOT `internal/ports`. `internal/ports` already exists as the listening-TCP-port collector (`NewCollector`/`Snapshot`) and is unrelated.
- A committed data file in the package directory (suggested name `ports.env`) is the **single source of truth**. It uses a bash-sourceable `KEY=integer` line format, because no script in `scripts/` depends on `jq`, `e2e-env.sh` must stay pure bash, and a `KEY=VALUE` file is trivial to parse in Go and TS. Comments (`#`) explain each block. Values:

  ```sh
  # run-kit port policy — the ONE source of truth for reserved/default ports.
  # Read by: Go (internal/portpolicy, //go:embed), scripts/e2e-env.sh +
  # scripts/test-e2e.sh (sourced), Playwright helpers (parsed).
  # Machine-only ports live in a 5-digit block humans never type.

  # Daemon default (Vite/serve port). Dev backend = +1, code-server = +2.
  PORTPOLICY_DAEMON_DEFAULT=3000
  # e2e rig block: 100 triples (Vite, Go backend, code-server stub).
  PORTPOLICY_RIG_START=21000
  PORTPOLICY_RIG_END=21299
  # rk remote SSH-tunnel local ports (persisted in remotes.yaml — only C4 moves them).
  PORTPOLICY_TUNNEL_START=3100
  PORTPOLICY_TUNNEL_END=3199
  # Playwright fail-closed sentinel: a bare `playwright test` connects here and finds nothing.
  PORTPOLICY_SENTINEL=21999
  ```

  The key names are shell *variables* in a sourced file, never exported env vars. They are not an env-var surface and add nothing to constitution IV's env list (`RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` stay the only env forms). The plan may pick the exact key prefix. It must not start with `RK_`, so the keys do not read as new `RK_*` env vars.
- Go API, parsed once from the embedded file at package init. A malformed or missing key is a programmer error, so panic at init, backed by a unit test that parses the committed file. Sketch:

  ```go
  package portpolicy

  //go:embed ports.env
  var raw string

  type Block struct{ Name string; Start, End int } // inclusive

  var (
      DaemonDefault int   // 3000
      Rig           Block // 21000–21299
      Tunnel        Block // 3100–3199
      Sentinel      int   // 21999
  )

  // Reserved returns every block a daemon must not land in, sentinel included as a 1-port block.
  func Reserved() []Block

  // Collisions reports which reserved blocks the daemon footprint [port, port+2] overlaps
  // (the +2 is the RK_PORT+2 code-server convention; also check an explicit code-server port).
  func Collisions(port, codeServerPort int) []Block
  ```

- Rig-block invariant (unit-tested): `(RigEnd - RigStart + 1) % 3 == 0`, which gives exactly 100 triples for 21000–21299. `Sentinel` and `DaemonDefault` lie outside `Rig`. `Tunnel` does not overlap `Rig`.

### 2. Consumers read the policy (no more hardcoded ranges)

- **`internal/config`**: `defaults.Port` comes from `portpolicy.DaemonDefault`, so the value stays 3000. `TestDefaults` continues to assert 3000.
- **`internal/remote/ports.go`**: `PortRangeStart`/`PortRangeEnd` read from `portpolicy.Tunnel.Start`/`.End`, **keeping 3100–3199**. The existing call sites (`AssignPort`, `store.go` validation, the `rk remote add --local-port` flag help, `name_test.go`) keep working unchanged. Go `const` cannot hold a package-init value, so these become `var`s, or the call sites read `portpolicy.Tunnel` directly. The plan decides which, preferring the smallest diff. The stale comment ("clear of the dev/e2e ports (3000/3020/3333)") is updated to point at the policy.
- **`scripts/e2e-env.sh`**: sources the policy file (path resolved from `_e2e_script_dir`, e.g. `$_e2e_script_dir/../app/backend/internal/portpolicy/ports.env`) and derives `E2E_PORT="${RK_E2E_PORT:-$(( RIG_START + (_e2e_hash % TRIPLES) * 3 ))}"`, where `TRIPLES = (RIG_END - RIG_START + 1) / 3`. The avoid-list comment is replaced by a pointer to the policy file. It stays **pure** (no probing, no mutation) and keeps the sourced variables unexported, per its header contract. Temporary `_e2e_*`/policy vars are unset at the end, like today's.
- **`scripts/test-e2e.sh`**: every `3400`/`3697`/`3699`/`100`-triple literal is derived from the policy values: the `RK_E2E_WORKERS > triples` cap and its error text, the step-forward bound, and the multi-rig wrap arithmetic (`RIG_START + ((E2E_PORT - RIG_START)/3 + i) % TRIPLES * 3`, with the in-block alignment test using `RIG_START`/`RIG_END - 2`). The `:3333` comment at line ~448 is updated.
- **`scripts/pw.sh`**, **`scripts/dev.sh`**: they already source `e2e-env.sh`, so no logic change is needed. The comment `:3333` in `pw.sh` is updated.
- **`justfile`**: comments naming `3400–3699` are updated (recipes stay one-liners per constitution VIII). The `${RK_PORT:-3000}` default literals are **out of scope**. The value is unchanged, and C5 owns every place that states the daemon default.

### 3. Playwright sentinel 3333 → 21999, collapsed into one helper

Today's code-literal sites (each is `process.env.E2E_PORT ?? "3333"` or equivalent):

| File | Site |
|------|------|
| `app/frontend/playwright.config.ts:13` | `const port = Number(process.env.E2E_PORT ?? "3333")` |
| `app/frontend/tests/e2e/_boards.ts:109` | `` baseURL ?? `http://localhost:${process.env.E2E_PORT ?? 3333}` `` |
| `app/frontend/tests/e2e/_gui.ts:29` | `RIG_ORIGIN` |
| `app/frontend/tests/e2e/echo-latency.spec.ts:59` | `const port = …` |
| `app/frontend/tests/e2e/mobile-touch-scroll.spec.ts:22` | `const port = …` |
| `app/frontend/tests/e2e/session-reorder.spec.ts:91` | inline URL |
| `app/frontend/tests/e2e/touch-focus-gate.spec.ts:23` | `const port = …` |
| `app/desktop/tests/e2e/_shell.ts:42` | `export const E2E_PORT = …` |

Comment-only mentions: `app/desktop/playwright.config.ts:7`, `app/frontend/tests/e2e/server-reorder.spec.ts:25`, `_boards.ts:104-105`, `_gui.ts:28`, `_shell.ts:39`, `scripts/pw.sh:8`, `scripts/test-e2e.sh:448`, `scripts/e2e-env.sh:45`, and `internal/remote/ports.go:6`.

- One frontend helper owns the harness-port read. It is the natural home next to `_rig.ts`/`_ports.ts` in `app/frontend/tests/e2e/`, e.g. `export const E2E_PORT: number` and `rigOrigin()`, with the fallback being the policy's sentinel read from the policy file (parsed with `node:fs`, no new deps). Every frontend site above imports it. `playwright.config.ts` must still call `applyWorkerRig()` **before** the first env read (the `_rig.ts` ordering contract). The helper must therefore read `process.env.E2E_PORT` lazily or at a point after `applyWorkerRig()`, never capture it at an import that precedes the rewrite. The plan must honor this.
- `app/desktop/tests/e2e/_shell.ts` is a separate package. It either imports the frontend helper by relative path or reads the same policy file with its own few-line parse. The plan picks whichever works with the desktop Playwright/tsconfig setup. The literal `3333` must not survive in either package.
- The helper keeps the documented rule: **never** read the ambient `RK_PORT` (direnv exports it on this box).
- After the change, `git grep -n '3333'` over `app/` and `scripts/` (excluding CSS keyframe percentages, the transcript testdata UUID, and byobu.conf colors) returns nothing port-related.

### 4. New `rk ports` verb

- A new top-level cobra command `rk ports`, registered like the other verbs in `app/backend/cmd/rk/` (new file `ports.go` + `ports_test.go`). It prints the policy: daemon default (with its +1 dev backend / +2 code-server arithmetic), the rig block (range + triple count), the tunnel block, and the sentinel. It also prints the **effective** daemon port (`config.Load()`: env over default) and any collision warning.
- `--json` emits the machine-readable form through the existing output/envelope helpers (`output.go`), consistent with the other verbs' `--json` shape. The help text says this is the port *policy*, not a listing of listening ports (that is the `internal/ports` collector / Ports tile). The CLI surface must be checked against `shll standards` (constitution § Toolkit Standards) before finalizing flags, help, and README/docs listing.
- Adding a verb touches the help dump (`help_dump.go` / `help_dump_test.go`) and any command inventory in README / `docs/site/` / memory `architecture/cli.md`. Those update in the same change.

### 5. Collision warning (warn only, never refuse)

- **`rk serve` startup**: after resolving config, compute `portpolicy.Collisions(cfg.Port, cfg.ResolvedCodeServerPort())`. For each hit, log one `slog.Warn` naming the port, the block name and range, and the remedy (set `RK_PORT` outside it). The server still starts.
- The footprint checked is the daemon port and its resolved code-server port (`port+2` by convention, or the explicit `RK_CODE_SERVER_PORT`). The dev-only `+1` backend is not checked at serve time. It is a dev-rig concern.
- Tests: a unit test on `Collisions` covers edges (the exact block start/end, the +2 straddling into a block, the sentinel single port, no-hit for the default 3000), plus a serve-side test via whatever seam the serve startup exposes, if one exists cheaply.

### 6. Doctor row

- New `doctorCheck{Name: "ports"}` appended in `runDoctorChecks` (`app/backend/cmd/rk/doctor.go`). It is **OK-shaped with a note**, like the other advisory rows (`legacyOptionsCheck`, `ephemeralServersCheck`), and is **not** a verdict flipper, consistent with warn-only:
  - No collision: note, e.g. `daemon :3000 (default); reserved: rig 21000–21299, tunnel 3100–3199, sentinel 21999`.
  - Collision: note starts with a warning naming the block and the fix (move `RK_PORT` outside it).
- Written as a pure function over the resolved config, for a table test in `doctor_test.go`.

### Non-goals

- Daemon default 3000 → 6123 (C5). The tunnel range move 3100–3199 → 21500–21599 and any `remotes.yaml` reassignment (C4). The `port` config.yaml key (P3). The host default fix (P2).
- Renaming any `RK_*` env var (`RK_E2E_PORT` stays the rig-base override), tmux option, or socket name (D2).
- The `${RK_PORT:-3000}` literals in `justfile`, `scripts/perf-idle-cpu.*`, `scripts/dev-desktop.sh` comments, and `serve`/`url` help text. The value is unchanged, and C5 sweeps them.
- `app/desktop/src/web-proxy.test.ts`'s `localhost:3400`. It is an arbitrary host URL fixture, not a rig port.

## Affected Memory

- `run-kit/architecture/backend-packages`: (modify) add `internal/portpolicy` (policy data file + embed + `Collisions`). Note that `internal/remote` tunnel constants and `internal/config` default read from it.
- `run-kit/architecture/cli`: (modify) the new `rk ports` verb, its human and `--json` output.
- `run-kit/architecture/testing`: (modify) the rig block 3400–3699 → 21000–21299, derived from the policy file. The sentinel helper.
- `run-kit/test-sockets`: (modify) the sentinel `3333` → `21999` and its one helper. Update the Decision entry on the `E2E_PORT ?? sentinel` read.
- `run-kit/remote-hosts`: (modify) the tunnel range values unchanged (3100–3199), now sourced from `portpolicy`. Only C4 moves them.
- `run-kit/configuration`: (modify) the daemon default sourced from the policy. The warn-only collision rule at serve start and in the doctor row.
- `run-kit/ui/dialogs-and-state`: (modify) the incidental `3400–3699` mention → `21000–21299`.

Also update (not memory, but a stated fact): `fab/project/context.md` § Testing mentions `3400–3699` and the "fallback port is 3333" paragraph. Update both to the new values and point at the policy file.

## Impact

- **Go**: new `app/backend/internal/portpolicy/` (data file, parser, tests). `internal/config/config.go` (default). `internal/remote/ports.go` (+ possibly `store.go`, `cmd/rk/remote.go` if the constants become vars or call sites switch). `cmd/rk/ports.go` (new verb). `cmd/rk/serve.go` (startup warning). `cmd/rk/doctor.go` (row). `help_dump` golden.
- **Shell**: `scripts/e2e-env.sh`, `scripts/test-e2e.sh`, and comments in `scripts/pw.sh`/`justfile`.
- **TS**: `app/frontend/playwright.config.ts`, the new or extended helper in `app/frontend/tests/e2e/`, 6 frontend spec/helper sites, and `app/desktop/tests/e2e/_shell.ts` + the `app/desktop/playwright.config.ts` comment.
- **Behavior**: every e2e rig now lands in 21000–21299. Running a live `just dev` or another tool on 3400–3699 no longer matters to e2e. The sentinel moves, so a bare `playwright test` connects to :21999 (nothing listening, fail-closed). No persisted state changes, no user-visible port moves.
- **Tests / gate**: `env -u TMUX -u TMUX_PANE go test ./...` (the memory note on the tmux env), `just test-frontend`, and a full `just test-e2e` run to prove the new rig block boots end-to-end, including `RK_E2E_WORKERS=2` multi-rig wrap arithmetic if feasible locally. Desktop lane: at least one desktop spec (`RK_E2E_LANE=desktop`) to prove `_shell.ts` reads the helper.
- **Cross-worktree transition**: sibling worktrees on older branches still derive 3400–3699 until they rebase. The two blocks do not overlap, so old and new rigs cannot collide.

## Open Questions

- Should `internal/remote`'s `PortRangeStart`/`PortRangeEnd` survive as `var` aliases (smallest diff) or be replaced by direct `portpolicy.Tunnel` reads at the four call sites? (Plan-time. Either satisfies "read from the policy".)
- Does the desktop Playwright package import the frontend helper by relative path cleanly, or does it need its own policy-file parse? (Plan-time, from the desktop tsconfig/Playwright setup.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Package is `internal/portpolicy`, not `internal/ports` | User and plan state it explicitly; `internal/ports` is the existing listening-port collector | S:95 R:85 A:95 D:95 |
| 2 | Certain | Tunnel range stays 3100–3199, sourced from the policy; only C4 moves it | User and plan explicit; persisted in `remotes.yaml` | S:95 R:80 A:95 D:95 |
| 3 | Certain | Rig block 21000–21299 (100 triples), sentinel 21999, daemon default stays 3000 | User and plan rule P explicit; C5 owns the 6123 move | S:95 R:85 A:95 D:95 |
| 4 | Certain | No `RK_*` / `@rk_*` / `rk-*` renames and no new env var names; `RK_E2E_PORT` stays the rig override | Plan D2 + constitution IV (only three env forms) | S:90 R:80 A:95 D:90 |
| 5 | Certain | Policy lives in one committed data file embedded by Go and read directly by shell and TS; `rk ports` is the user-visible surface, not the scripts' read path | Asked — user chose the embedded data file over scripts calling `rk ports` (pre-build sourcing, installed-binary version skew) | S:90 R:70 A:85 D:85 |
| 6 | Certain | Collision is warn-only: `slog.Warn` at `rk serve` start plus a doctor note; never refuses to start | Asked — user chose warn only (disruption-free; a daemon could already sit in 3100–3199) | S:90 R:85 A:85 D:85 |
| 7 | Confident | Data file is bash-sourceable `KEY=integer` lines with non-`RK_` keys, never exported | No `jq` dependency in scripts/; e2e-env.sh stays pure bash; keeps D2/constitution IV env list untouched | S:65 R:85 A:75 D:70 |
| 8 | Confident | Collision footprint is daemon port + resolved code-server port (+2 or explicit), not the dev-only +1 | Mirrors `ResolvedCodeServerPort`; +1 exists only in `just dev` rigs | S:55 R:85 A:70 D:65 |
| 9 | Confident | Doctor `ports` row is OK-shaped with a note, never a verdict flipper | Matches warn-only choice and the advisory-row pattern (`legacyOptionsCheck`, `ephemeralServersCheck`) | S:60 R:90 A:80 D:75 |
| 10 | Confident | `rk ports` prints policy blocks plus the effective daemon port and collisions, with `--json` via the existing envelope helpers | Follows the other verbs' output pattern; toolkit standards govern the final surface | S:60 R:85 A:70 D:70 |
| 11 | Confident | One frontend helper in `app/frontend/tests/e2e/` owns the E2E_PORT read, reading the env lazily to honor `_rig.ts`'s applyWorkerRig ordering | User asked to collapse the literal into one helper; `_rig.ts` ordering contract is documented and load-bearing | S:75 R:80 A:70 D:70 |
| 12 | Confident | `${RK_PORT:-3000}` literals in justfile, perf scripts, and serve/url help are out of scope | Value unchanged here; plan assigns every default-stating site to C5 | S:60 R:90 A:80 D:70 |
| 13 | Confident | Desktop `_shell.ts` imports the frontend helper by relative path, else reads the policy file with its own parse | Separate package; depends on desktop tsconfig/Playwright resolution, not yet inspected | S:50 R:85 A:50 D:55 |
| 14 | Confident | Remote `PortRangeStart`/`End` become `var`s initialized from the policy (smallest diff) rather than call-site rewrites | Go const cannot take an init-time value; either shape satisfies the requirement | S:45 R:90 A:60 D:50 |

14 assumptions (6 certain, 8 confident, 0 tentative, 0 unresolved).
