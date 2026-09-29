# Plan: Code-Server Restart — Lens Button + CLI Verb

**Change**: 260924-7koz-code-server-restart
**Intake**: `intake.md`

> Adopted change — code authored off-pipeline. Apply was skipped; this plan is reverse-engineered from the branch diff to feed hydrate.

## Requirements

### Daemon: code-server restart primitive

`daemon.RestartCodeServer()` is the single recovery primitive behind both the lens button and the CLI verb. It first gates on the daemon running (a down daemon is an error naming `rk serve -d`, and no tmux command runs on the dead socket). It then kills the `rk-code-server` session via the existing release-synchronous `KillCodeServerSession` (absent session is a no-op; a killed session's port is awaited free), and re-runs `ensureCodeServerCore(true)` so the whole ladder — session-exists, port resolution, externally-managed carve-out, binary resolution (managed install, then PATH) and the `RK_BIN` self-path — is re-derived from scratch. This is what makes the fix deterministic for a stale session spawned from a since-removed binary path (e.g. after `brew upgrade`): the session-exists skip that previously made every ensure a no-op is defeated by the kill.

A missing binary is not an error on this path: `ensureCodeServerCore`'s CLI-posture missing-binary branch now returns the sentinel `errCodeServerMissing` (message unchanged), and `RestartCodeServer` responds by spawning the `code-server-install` rk-jobs job (the daemon posture) and returning `EnsureInstallJobSpawned`. The spawn runs on a FRESH `cmdTimeout` context (the kill may have spent the shared one on a hung session's port-free wait), and `spawnCodeServerInstallJob` now returns its failure (still logged; the daemon ignores it) so a failed spawn is reported as an error rather than a false "installing". When the ensure outcome is `EnsureStarted`, the call blocks until the code-server port serves, polling `codeServerPortBusy` at `codeServerPortFreePoll`, bounded by `codeServerPortUpTimeout` (15s, a var for tests); on expiry it errors with ``code-server did not come up within 15s — attach the rk-code-server tmux session or run `rk doctor` ``. Externally-managed and no-port outcomes return unchanged.

### HTTP: POST /api/code-server/restart

A new POST route (Constitution IX) calls `daemon.RestartCodeServer` through the `restartCodeServerFn` package seam. It refuses with 409 on dev builds (`version == "dev"`), because the dev serve process resolves the dev code-server port and a restart would kill the real daemon's session and respawn it on the dev port. Failures are 500 with the error text (handler tests in `api/codeserver_test.go` cover the 409, 500, and status mapping); success is 200 `{"status": "started" | "installing" | "external"}` mapped from `EnsureStarted` / `EnsureInstallJobSpawned` / `EnsureExternallyManaged`.

### CLI: rk code-server restart

`rk code-server` gains a fourth child, `restart` (with `Long:` help, `cobra.NoArgs` re-wrapped by the existing `usageArgs` loop), calling `daemon.RestartCodeServer` through the `codeServerRestartFn` seam. Outcome lines are `Dataf` on stdout: `Restarted code-server (rk-code-server session).`, the externally-managed respect line, or `code-server binary not found; spawned the code-server-install job in rk-jobs.`; errors return as operational failures (exit 1).

### UI: code lens not-running empty state

The client gains `restartCodeServer()` and the `CodeServerRestartResult` type. `CodeSurface` takes an optional injected `onRestart` (keeping the component free of the API client import graph); when present, the unreachable state renders the existing `code-server not running — check rk doctor` line, a **Restart code-server** button, and a restart-note line (`data-testid="code-surface-restart-note"`). While the POST is in flight the button reads `restarting…` and is disabled. On `started` it stays `restarting…` until the reachability probe flips the surface to the iframe (within the ~5s probe TTL); `installing` and `external` show an explanatory note and re-enable; an error shows its message and re-enables for retry. The restart state resets on every reachability change. `SurfaceLayout` threads `onCodeServerRestart` to `CodeSurface`'s `onRestart`; `app.tsx` supplies `restartCodeServer`.

### Palette: Code: Restart code-server

For Constitution V parity, `buildCodeActions` emits `Code: Restart code-server` (id `code-restart-server`) when the code tile is open and code-server is unreachable. `app.tsx` wires its body to the same `restartCodeServer()` call, surfacing `installing`/`external` outcomes as toasts and errors as error toasts, since the row runs outside the tile.

### Docs

`docs/specs/right-panel.md` records the button on the not-running empty state; `docs/memory/run-kit/architecture/cli.md` records the four-child `code-server` tree and the `restart` semantics.

## Tasks

- [x] Adopted: implementation authored outside the pipeline (see branch `hewn-harrier`).

## Acceptance

- [x] Adopted: code already authored; a diff-only review runs in this pipeline.

## Assumptions

0 assumptions.
