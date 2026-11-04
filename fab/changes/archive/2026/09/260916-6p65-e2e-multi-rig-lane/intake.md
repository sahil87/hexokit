# Intake: E2E Multi-Rig Lane — Two Playwright Workers per CI Shard

**Change**: 260916-6p65-e2e-multi-rig-lane
**Created**: 2026-09-16

## Origin

Adopted from https://github.com/sahil87/run-kit/pull/1007 via `/fab-adopt`. The code was authored off-pipeline as a spike during the 2026-09-16 `/fab-discuss` session and is being brought into the pipeline late: intake reconstructed from the branch diff and the PR body, apply skipped, review/hydrate/ship run for real before merge.

> The tests say "Running 124 tests using 1 worker, shard 3 of 4". Does this mean we are not using parallelism? (This is in GitHub Actions CI/CD — I know we are using VMs with 4 cores.)
>
> We could be running parallel tests based on the number of CPUs by creating multiple tmux servers to run these tests on. Do you think that would work? (Only for CI/CD — not the user's environment.)
>
> Agreed — create a spike PR just to run this test and observe how it runs (2 workers is the right call, not 3).

Conversational mode. Key decisions from the conversation: parallelism inside a shard needs one complete rig per Playwright worker (two workers on one rig would see each other's tmux sessions over the SSE broadcast); two workers per shard, not three, sized to the runner's cores; the lane is CI-only; the shard matrix stays at 4 so the spike's shard wall-clock is directly comparable with `main`; the spike's CI run was observed green before adoption, and the user then asked to adopt and merge.

## Why

**Problem.** Every Playwright spec targets one shared tmux server and one dev server, and rk's state stream broadcasts session changes to every connected client. Two Playwright workers on that one rig would therefore see each other's sessions appear in their sidebars — a correctness race, not a load problem — so `playwright.config.ts` pinned `workers: 1` and CI's only parallelism was the 4-shard matrix. Each shard's Playwright phase took 4.4–6.4 min serially on a runner that (measured on this change's CI run) has 4 vCPUs and 15 GB — half the cores sat idle while the suite's timing gates waited on one Chromium at a time.

**Consequence of not fixing it.** CI wall-clock stays around 8 minutes per run and grows with every spec added; the 4-shard matrix is the only knob, and each extra shard pays ~50 s of fixed setup (checkout, pnpm, browser cache, Go build) before it runs a single test, so more shards has diminishing returns.

**Why this approach.** Give each Playwright worker its own complete rig — tmux server, Go backend, Vite dev server, code-server stub port, state home — so the pool can widen without any two workers sharing a server. The isolation primitives already exist per worktree (the derived port triple, the `rk-test-e2e-<token>-` socket family, `RK_SERVER_ALLOWLIST`, the per-run `XDG_STATE_HOME`/`RK_CONFIG_DIR`); this change applies them one level down, per rig. Rejected alternatives: more shards (free minutes on a public repo, but the fixed setup dominates and shards and workers stack anyway — this change keeps both knobs); in-process workers on a shared rig (the SSE cross-talk race); serving the production build from the Go binary instead of Vite per rig (changes what is under test — specs rely on the dev proxy). Measured result on CI run 35126903069 vs `main` run 35125032891: Playwright phase 5.8/4.4/~4.9/6.4 min → 4.3/3.4/3.4/4.2 min per shard (about 25–30% off), 0 flaky and 0 failed across all four shards. Not 2× — two Chromium + Vite + Go trios contend for four cores.

## What Changes

### 1. `scripts/test-e2e.sh` — the multi-rig lane behind `RK_E2E_WORKERS`

`RK_E2E_WORKERS=N` (default 1; anything else non-numeric or < 1 collapses to 1) selects the lane. With N=1 the script behaves as before: one derived triple, one primary `rk-test-e2e-<token>-0`, one `just dev` in its own process group. With N>1:

- **Rig table.** Four parallel bash arrays indexed by Playwright parallel index — `RIG_PORT`, `RIG_SERVER`, `RIG_FAMILY`, `RIG_STATE`. Rig *i* takes the *i*-th port triple after the derived one (Vite / backend +1 / stub +2), wrapping inside the 100-triple 3400–3699 block so a worktree that hashes to the last triple still gets a valid rig 1 (a preset out-of-block `RK_E2E_PORT` gets plain +3 per rig); rig 0's triple is reclaimed and stepped by the existing logic, the extra triples are only probed (`kill_triple`/`triple_busy` take a base-port argument), never killed or stepped — in the 3400–3699 block they are other worktrees' derived triples, so a busy one is a hard error naming `RK_E2E_WORKERS=1` for shared dev boxes.
- **Socket sub-families.** Every rig, rig 0 included, gets primary `${E2E_TMUX_FAMILY}w<i>-0` and family `${E2E_TMUX_FAMILY}w<i>-`. Spec secondaries then land at `rk-test-e2e-<token>-w<i>-<role>-<pid>-<epoch>`, so `parseTestSocketPID` still reads the PID from the second-to-last field. The worktree anchor `rk-test-e2e-<token>-` prefixes every sub-family, so the EXIT-trap glob and `global-teardown.ts`'s prefix scan reap all rigs unchanged. `-w1-` cannot prefix `-w10-`.
- **Per-rig allowlist.** Each rig's backend runs with `RK_SERVER_ALLOWLIST` set to exactly its sub-family, so rig A's `ListServers` never lists rig B's servers — the load-bearing isolation.
- **Per-rig state.** `make_state_home <root>` lays out `config/` (settings) and `data/code-server/extensions/…/package.json` (the code-bridge `installed: true` fixture); rig *i* gets `$E2E_STATE_HOME/rig<i>`, all removed by the existing trap's `rm -rf`.
- **Seeding.** `seed_tmux_server <server>` wraps the former inline block (the `e2e-init` session, `@rk_srv_ephemeral`/`@rk_srv_managed` marks, the legacy-option pre-seed) and runs once per rig primary.
- **Launch.** `spawn_group <cmd>` wraps the former inline `set -m` launch plus its PGID-isolation check (abort if the child shares the harness's group) and appends to `DEV_PGIDS` (replacing the scalar `DEV_PGID`; cleanup kills every recorded group, bash-3.2-safe on an empty array). The multi lane cannot run `just dev` twice — every air instance builds to the same `app/backend/tmp/rk` — so it copies `tmux.conf` for the Go embed, builds the backend ONCE into `$E2E_STATE_HOME/rk`, then per rig spawns the binary (cwd `app/backend`, `RK_PORT=<port+1>`, `RK_HOST=0.0.0.0`, `LOG_LEVEL=debug`, the sub-family allowlist, `RK_CODE_SERVER_PORT=<port+2>`, `XDG_STATE_HOME`/`XDG_DATA_HOME`/`RK_CONFIG_DIR` under the rig state) and Vite (`cd app/frontend && RK_PORT=<port> RK_HOST=0.0.0.0 VITE_CACHE_DIR=<rig state>/vite exec pnpm dev --port <port>`), each in its own process group.
- **Readiness.** `wait_ready <port>` (frontend + `/api/health`, 90 s) runs per rig.
- **Hand-off.** `E2E_RIGS` is a JSON array of `{port, codeServerPort, tmuxServer, tmuxFamily, stateHome}` rows in worker-index order (`codeServerPort` is the harness's value verbatim — the derived +2, or a preset `RK_CODE_SERVER_PORT` in the single-rig lane — so the worker side never re-derives it); `run_playwright` exports it plus `RK_E2E_WORKERS`. In the multi lane the harness-level vars describe rig 0 (`E2E_PORT`, `E2E_TMUX_SERVER`, `RK_CODE_SERVER_PORT`, `XDG_STATE_HOME`, `RK_CONFIG_DIR`), while `E2E_TMUX_FAMILY` stays the worktree anchor so global teardown sweeps every rig.

### 2. `app/frontend/tests/e2e/_rig.ts` (new) and `app/frontend/playwright.config.ts`

`applyWorkerRig()` runs first thing in the config. When `E2E_RIGS` and `TEST_PARALLEL_INDEX` are both set it rewrites the harness env vars in the worker process to that worker's rig row (`E2E_PORT`, `RK_PORT`, `RK_CODE_SERVER_PORT` from the row's `codeServerPort`, `E2E_TMUX_SERVER`, `E2E_TMUX_FAMILY`, `XDG_STATE_HOME`, `RK_CONFIG_DIR=<stateHome>/config`); a missing row throws (worker count and rig count disagree). Playwright sets `TEST_PARALLEL_INDEX` in each worker and re-evaluates the config there before loading spec files, so the rewrite lands ahead of every module-level env read (`_tmux.ts`, `_ports.ts`, `_settings.ts`, `_gui.ts`, `_boards.ts`, the three specs that read `E2E_PORT`) and ahead of `use.baseURL`, which the worker also takes from its own loaded config. The main process has no index and keeps rig 0 (reporter, `webServer` probe, global teardown's primary). No spec file changes.

`workers` is the `E2E_RIGS` row count (1 when the harness passed no table), never `RK_E2E_WORKERS` by itself, so an inherited value cannot put two workers on one rig; `fullyParallel` stays off so tests within a file remain serial on the file's rig. Comments updated: serial-within-a-rig rationale; the timeout comment now names the 4-vCPU runner.

### 3. `app/frontend/vite.config.ts` — `cacheDir`

`cacheDir: process.env.VITE_CACHE_DIR || undefined` — unset keeps Vite's default `node_modules/.vite`; the multi lane gives each rig its own dir so two dev servers from one checkout never race on the dep pre-bundle.

### 4. `.github/workflows/ci.yml` — two rigs per shard

The e2e matrix job gains a `Runner shape` step (`nproc`, `free -g`) and sets `RK_E2E_WORKERS: 2` on the `Run e2e tests` step. The shard matrix stays at 4. Comments describe the multi-rig lane and the measured 4-vCPU runner; the air install steps remain (harmless, cached, and still needed if the workers env is ever set back to 1).

## Affected Memory

- `run-kit/test-sockets`: (modify) the e2e family section and the `RK_SERVER_ALLOWLIST` harness-wiring section — per-rig sub-families `rk-test-e2e-<token>-w<i>-`, the allowlist set per rig rather than per worktree, `RK_CONFIG_DIR`/state home per rig, the worktree anchor still owning teardown, `E2E_RIGS`
- `run-kit/architecture/testing`: (modify) the Playwright E2E section — the `RK_E2E_WORKERS` multi-rig lane and its run lifecycle (build once, per-rig backend + Vite, `spawn_group`, `wait_ready`), the `_rig.ts` per-worker env remap and its ordering contract, `workers` = rig count, `VITE_CACHE_DIR`, and CI's 4 shards × 2 workers wiring with the measured runner shape

## Impact

- Files: `scripts/test-e2e.sh` (restructured launch/seed/wait into functions plus the lane), `app/frontend/tests/e2e/_rig.ts` (new, ~50 lines), `app/frontend/playwright.config.ts`, `app/frontend/vite.config.ts`, `.github/workflows/ci.yml`. Roughly +240/−60 lines, no Go changes, no product behavior change.
- Test coverage: no new automated test of the harness itself. Verified by running it — locally `RK_E2E_WORKERS=2` over six spec files (22 tests across both workers, covering secondary tmux servers, the settings file and the code-server stub) and the default lane over two spec files, with no leaked sockets or listeners; in CI, run 35126903069 green on all four shards.
- Operational: `just test-e2e` on a developer box is unchanged (lane 1). `just pw` is untouched.

## Open Questions

- None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Change type is `ci` | The diff touches the e2e harness scripts, Playwright/Vite config and the CI workflow only — no product code or tests of product behavior | S:80 R:90 A:90 D:85 |
| 2 | Certain | Two workers per shard, not three, with the shard matrix left at 4 | User decision in the conversation, sized to the measured 4-vCPU runner; a comparable matrix made the spike measurable against main | S:90 R:95 A:80 D:90 |
| 3 | Confident | In the multi lane the backend is built once and run directly instead of through air | air cannot run twice in one worktree (shared tmp/rk); a test run never edits Go sources so live-reload buys nothing. Alternative: per-rig air tmp dirs, more moving parts | S:70 R:85 A:85 D:70 |
| 4 | Confident | Per-worker rig selection is an env remap in the config module, not a worker fixture threaded through the specs | Playwright 1.59.1 sets TEST_PARALLEL_INDEX in each worker and re-evaluates the config there before loading spec files (verified in workerMain.js / configLoader.js); this avoids touching ~35 specs that read the env at module load | S:75 R:70 A:80 D:65 |
| 5 | Confident | The air install steps stay in the CI e2e job | Cached and cheap; the single-rig lane still needs air if RK_E2E_WORKERS is ever set back to 1 | S:60 R:95 A:80 D:70 |
| 6 | Confident | Flake rate under two rigs is acceptable | One CI run showed 0 flaky and 0 failed on four shards against 1 flaky on main's run; a single run is not a rate measurement, and RK_E2E_WORKERS=1 reverts instantly | S:50 R:85 A:45 D:50 |
| 7 | Certain | The multi-rig lane is CI-only by design | The extra port triples (the next triples in the 3400–3699 block, wrapping) belong to other worktrees' derivations on a shared dev box; the script says so and fails loud on a busy extra triple | S:85 R:90 A:90 D:85 |
| 8 | Confident | Affected memory is exactly test-sockets and architecture/testing; no spec change | Both files document the e2e socket family, allowlist wiring and the run lifecycle this change extends; no docs/specs file covers the harness | S:65 R:90 A:80 D:75 |

8 assumptions (3 certain, 5 confident, 0 tentative, 0 unresolved).
