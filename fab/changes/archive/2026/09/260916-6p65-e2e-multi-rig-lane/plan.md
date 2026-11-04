# Plan: E2E Multi-Rig Lane — Two Playwright Workers per CI Shard

**Change**: 260916-6p65-e2e-multi-rig-lane
**Intake**: `intake.md`

> Adopted change — code authored off-pipeline. Apply was skipped; this plan is reverse-engineered from the branch diff to feed hydrate.

## Requirements

### Harness: the multi-rig lane in `scripts/test-e2e.sh`

`RK_E2E_WORKERS=N` selects the lane; the default (1, or any non-numeric or sub-1 value) is the unchanged single-rig lane: one derived port triple, one primary `rk-test-e2e-<token>-0`, one `just dev` in its own process group, a serial Playwright run.

With N greater than 1 the harness starts N complete rigs, one per Playwright parallel index, described by four parallel arrays (`RIG_PORT`, `RIG_SERVER`, `RIG_FAMILY`, `RIG_STATE`). Rig *i* owns the *i*-th port triple after the derived one, wrapping inside the 100-triple 3400–3699 block so the last derived triple still gets a valid rig 1 (a preset out-of-block `RK_E2E_PORT` gets plain +3 per rig; rig 0's triple is reclaimed and stepped by the existing logic; extra triples are only probed, never killed or stepped — they are other worktrees' derived triples in the 3400–3699 block, so a busy one is a hard error), the tmux primary `${E2E_TMUX_FAMILY}w<i>-0` inside the sub-family `${E2E_TMUX_FAMILY}w<i>-`, and a state home `$E2E_STATE_HOME/rig<i>` laid out by `make_state_home` (a `config/` dir for settings and the code-bridge extension fixture under `data/`). Every rig, rig 0 included, uses a sub-family so that no rig's `RK_SERVER_ALLOWLIST` prefixes another rig's servers; the worktree anchor `rk-test-e2e-<token>-` still prefixes all of them, so the EXIT-trap socket glob and `global-teardown.ts`'s prefix scan reap every rig without change, and secondaries named under a sub-family keep the PID in the second-to-last hyphen field.

Each rig's primary is seeded identically by `seed_tmux_server` (the `e2e-init` session, the `@rk_srv_ephemeral` and `@rk_srv_managed` marks, the legacy-option pre-seed). Long-lived server launches go through `spawn_group`, which runs the command in its own process group, aborts if the child shares the harness's group, and records the group in `DEV_PGIDS` for cleanup (safe on an empty array under bash 3.2). Because `just dev` cannot run twice in one worktree — every air instance builds to the same `app/backend/tmp/rk` — the multi lane copies the tmux.conf for the Go embed, builds the backend once into `$E2E_STATE_HOME/rk`, and per rig spawns that binary (cwd `app/backend`; `RK_PORT` = port+1, `RK_HOST=0.0.0.0`, `LOG_LEVEL=debug`, `RK_SERVER_ALLOWLIST` = the sub-family, `RK_CODE_SERVER_PORT` = port+2, `XDG_STATE_HOME`/`XDG_DATA_HOME`/`RK_CONFIG_DIR` under the rig state) plus one Vite dev server on the rig's port with `VITE_CACHE_DIR` under the rig state. `wait_ready` gates on the frontend and `/api/health` for every rig.

The Playwright run receives `E2E_RIGS` (a JSON array of `{port, codeServerPort, tmuxServer, tmuxFamily, stateHome}` in worker-index order; `codeServerPort` is the harness's value verbatim — the derived +2, or a preset `RK_CODE_SERVER_PORT` in the single-rig lane) and `RK_E2E_WORKERS`. In the multi lane the harness-level vars (`E2E_PORT`, `E2E_TMUX_SERVER`, `RK_CODE_SERVER_PORT`, `XDG_STATE_HOME`, `RK_CONFIG_DIR`) describe rig 0, while `E2E_TMUX_FAMILY` stays the worktree anchor so global teardown sweeps every rig's sub-family.

### Playwright: per-worker rig selection and pool size

`app/frontend/tests/e2e/_rig.ts` exports `applyWorkerRig()`, called first thing in `playwright.config.ts`. When both `E2E_RIGS` and `TEST_PARALLEL_INDEX` are set, it rewrites the harness env vars in the worker process to that worker's rig row — `E2E_PORT`, `RK_PORT`, `RK_CODE_SERVER_PORT` (the row's `codeServerPort`), `E2E_TMUX_SERVER`, `E2E_TMUX_FAMILY`, `XDG_STATE_HOME`, `RK_CONFIG_DIR` (`<stateHome>/config`) — and throws when the index has no row. Ordering contract: Playwright sets `TEST_PARALLEL_INDEX` in each worker and re-evaluates the config file there before loading spec files, so the rewrite precedes every module-level env read in the helpers and specs and also feeds the worker's own `use.baseURL`. The main process has no index and keeps rig 0 for the reporter, the webServer probe and global teardown. Spec files are unchanged.

The config's `workers` is the `E2E_RIGS` row count (1 when the harness passed no table — a bare `playwright test` or `just pw`), never `RK_E2E_WORKERS` by itself, so an inherited value cannot put two workers on one rig; `fullyParallel` stays off so a file's tests run serially on that file's rig, since a file's `beforeAll` seeds tmux state its tests share.

### Vite: per-instance dep cache

`vite.config.ts` sets `cacheDir` from `VITE_CACHE_DIR` when set (unset keeps the default `node_modules/.vite`), so several dev servers from one checkout never race on the dep pre-bundle.

### CI: two rigs per shard

The e2e matrix job runs a `Runner shape` step (`nproc`, `free -g`) so the runner's real shape is visible in the log, and sets `RK_E2E_WORKERS: 2` on the `Run e2e tests` step. The shard matrix stays at 4; the air install steps remain for the single-rig fallback. Comments state the measured 4-vCPU runner and the multi-rig rationale. Measured on the first run: Playwright phase per shard 4.3/3.4/3.4/4.2 min against 5.8/4.4/~4.9/6.4 min on main, 0 flaky.

## Tasks

- [x] Adopted: implementation authored outside the pipeline (see https://github.com/sahil87/run-kit/pull/1007).

## Acceptance

- [x] Adopted: code already authored and CI-verified (run 35126903069 green on four shards; local two-rig and single-rig runs clean); a diff-only review runs in this pipeline.

## Assumptions

0 assumptions.
