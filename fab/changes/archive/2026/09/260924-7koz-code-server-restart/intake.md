# Intake: Code-Server Restart — Lens Button + CLI Verb

**Change**: 260924-7koz-code-server-restart
**Created**: 2026-09-24

## Origin

Adopted from the branch `hewn-harrier` (no PR yet). The code was authored off-pipeline in a conversational session and is being brought into the pipeline via `/fab-adopt`; apply is skipped.

The user's request, verbatim (with a screenshot of the code lens empty state `code-server not running — check rk doctor`):

> The server doesn't run. I get this error and there is no way to retry and fix it. Can you help me add a button here which can be a possible fix for this? One of the main reasons is maybe some file, `brew`, doesn't load sometimes so in retry have some deterministic way where we can actually fix it. Or a way where we can just restart it, that also works.

Follow-up after the button shipped in the working tree:

> rk code-server restart --> this is also helpful

## Why

The `/code` lens's not-running empty state was a dead end: a terse `code-server not running — check rk doctor` line with no action. The daemon ensures the `rk-code-server` session only at daemon start, and that ensure is **idempotent on session existence** — so once code-server is wedged, nothing in the UI can recover it:

1. **Stale/hung session**: a live `rk-code-server` session whose process no longer serves the port (hung, or spawned from a binary path that has since vanished — the brew-upgrade case the user named: the brew prefix symlink or Cellar path the session was launched from is gone) makes every later ensure a silent `EnsureAlreadyRunning` skip.
2. **Dead session**: code-server exited; the session is gone, but no supervisor loop re-ensures it until the next daemon start (Constitution VI — no supervisor loop).
3. **Missing binary**: the install job failed or never ran.

The only recoveries were CLI-side and manual (`tmux -L rk-daemon kill-session -t '=rk-code-server' && rk code-server start`, or `rk daemon restart`). The deterministic fix is **kill + re-ensure from scratch**: killing the session defeats the session-exists skip, and re-running the ensure ladder re-resolves the binary (managed install → PATH) and `RK_BIN` fresh, so a vanished brew path is replaced by whatever resolves now. Exposing the same primitive as a CLI verb gives terminal users the identical recovery.

Alternatives rejected: a bare re-ensure (no kill) cannot fix the stale-session case; a supervisor loop violates Constitution VI; routing through `rk daemon restart` bounces the whole dashboard for an editor problem.

## What Changes

### Backend — daemon primitive (`app/backend/internal/daemon/codeserver.go`)

- New sentinel `errCodeServerMissing` (same message as before: ``code-server binary not found — install it with `rk code-server install` ``) returned by `ensureCodeServerCore`'s CLI-posture missing-binary branch, so callers can branch on it with `errors.Is`.
- New `var codeServerPortUpTimeout = 15 * time.Second` (var so tests shrink it).
- New exported `RestartCodeServer() (EnsureOutcome, error)`:
  1. Daemon gate first (`jobDaemonRunning`) — a down daemon is an error naming `rk serve -d` (no tmux command on a dead socket).
  2. `KillCodeServerSession()` — exact-match kill, release-synchronous (waits for the port to free), absent session is a no-op.
  3. `ensureCodeServerCore(true)` — full ladder re-run.
  4. `errCodeServerMissing` ⇒ `spawnCodeServerInstallJob(ctx)` and return `EnsureInstallJobSpawned, nil` (the daemon's missing-binary posture, not an error).
  5. On `EnsureStarted`, poll `codeServerPortBusy()` every `codeServerPortFreePoll` until the port serves or `codeServerPortUpTimeout` expires → error ``code-server did not come up within 15s — attach the rk-code-server tmux session or run `rk doctor` ``. Other outcomes (`EnsureExternallyManaged`, `EnsureNoPort` error) return as-is.
- Tests (`codeserver_test.go`): missing binary spawns the install job; spawn waits past down probes until up; never-up returns the did-not-come-up error.

### Backend — HTTP route (`app/backend/api/codeserver.go`, `api/router.go`)

- `POST /api/code-server/restart` → `handleCodeServerRestart` behind the package seam `restartCodeServerFn = daemon.RestartCodeServer`.
- 409 on dev builds (`s.version == devVersion`): the dev serve process resolves the DEV code-server port, so a restart would kill the real daemon's session and respawn on the dev port (mirrors `handleRestart`'s dev guard).
- 500 with the error text on failure; 200 `{"status":"started"|"installing"|"external"}` mapped from `EnsureStarted` / `EnsureInstallJobSpawned` / `EnsureExternallyManaged`.

### Backend — CLI verb (`app/backend/cmd/rk/code_server.go`)

- New `rk code-server restart` child (with `Long:` help; `Args: cobra.NoArgs`, re-wrapped by the existing `usageArgs` loop) over the seam `codeServerRestartFn = daemon.RestartCodeServer`.
- Outcome lines via `sink.Dataf`: `Restarted code-server (rk-code-server session).`, the externally-managed line, or `code-server binary not found; spawned the code-server-install job in rk-jobs.`; errors return (exit 1).

### Frontend — client + lens (`app/frontend/src/`)

- `api/client.ts`: `type CodeServerRestartResult = { status: "started" | "installing" | "external" }` and `restartCodeServer()` POSTing the route (throws on non-2xx via `throwOnError`).
- `components/code-surface.tsx`: new optional prop `onRestart?: () => Promise<CodeServerRestartResult>`. The unreachable state becomes a column: the existing `code-server not running — check rk doctor` line, a **Restart code-server** button (label `restarting…` + disabled while in flight), and a `data-testid="code-surface-restart-note"` line for outcomes/errors. `started` keeps `restarting…` until the reachability probe flips (≤ the ~5s probe TTL); `installing` shows `installing code-server — the editor appears when the download finishes`; `external` shows `port already serving an externally managed code-server`; an error shows its message and re-enables the button. Both state bits reset on every `reachable` change. The component stays free of the API client import graph — the fetcher is injected.
- `components/surface-layout.tsx`: new prop `onCodeServerRestart`, passed to `CodeSurface` as `onRestart`; `app.tsx` passes the client's `restartCodeServer`.
- `lib/palette/code.ts`: `buildCodeActions` gains `unreachable` + `onRestartServer` and emits `Code: Restart code-server` (id `code-restart-server`) when the code tile is open AND code-server is unreachable — Constitution V palette parity for the empty state's button (added at the adoption checkpoint on the user's confirmation). `app.tsx` wires it to `restartCodeServer()` with toasts (installing/external notes; errors as `error` toasts) since the row runs outside the tile. `code.test.ts` covers the gating + body.
- Tests: `code-surface.test.tsx` covers button → `onRestart` → error note + re-enabled button. `tests/e2e/code-surface.spec.ts` not-running assertion loosened from `toHaveText` to `toContainText` (the empty state now also contains the button label).

### Docs

- `docs/specs/right-panel.md`: the not-running empty state now carries the Restart code-server button (route, semantics, 409 on dev).
- `docs/memory/run-kit/architecture/cli.md`: the `code-server` row now lists four children and describes `restart` (edited in the working tree off-pipeline; hydrate reconciles).

## Affected Memory

- `run-kit/daemon-lifecycle`: (modify) `RestartCodeServer` — daemon-gated kill + re-ensure, install-job fallback on a missing binary, bounded port-up wait (`codeServerPortUpTimeout`), `errCodeServerMissing` sentinel
- `run-kit/api-and-sockets`: (modify) new `POST /api/code-server/restart` route (dev-build 409, status mapping)
- `run-kit/architecture/cli`: (modify) `rk code-server restart` child (already hand-edited; hydrate verifies)
- `run-kit/ui/lenses-and-layout`: (modify) code lens not-running empty state gains the Restart code-server button and restart note; `onRestart` / `onCodeServerRestart` seam
- `run-kit/toolkit-standards`: (modify) `code-server` help-dump/P9 new-surface coverage now includes `restart`

## Impact

- 15 files: backend `internal/daemon/codeserver.go` (+test), `api/codeserver.go` (new), `api/router.go`, `cmd/rk/code_server.go`; frontend `api/client.ts`, `app.tsx`, `components/code-surface.tsx` (+test), `components/surface-layout.tsx`, `lib/palette/code.ts` (+test), `tests/e2e/code-surface.spec.ts`; docs `docs/specs/right-panel.md`, `docs/memory/run-kit/architecture/cli.md`.
- New HTTP route (POST, Constitution IX compliant) and new CLI verb.
- The HTTP handler blocks up to ~5s (kill's port-free wait) + 15s (port-up wait) — longer than the review rule's 5s tmux budget, though each tmux command itself keeps `cmdTimeout`.
- Verified in-session: `go test ./internal/daemon ./api ./cmd/rk` green; frontend `vitest run` 245 files / 5217 tests green; `tsc --noEmit` clean. e2e not run. No live manual test against a wedged code-server.

## Open Questions

None — the palette-parity question was resolved at the adoption checkpoint (user: add the palette entry).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Recovery primitive is kill + full re-ensure (not a bare re-ensure) | The session-exists skip makes a bare ensure a no-op on the stale-session case; user asked for a deterministic fix or restart | S:90 R:85 A:90 D:85 |
| 2 | Confident | Missing binary on restart spawns the install job rather than erroring | Matches the daemon posture; a button that says "install it with the CLI" is not a fix | S:70 R:85 A:80 D:70 |
| 3 | Confident | Restart blocks until the port serves (15s budget) and errors otherwise | Gives honest feedback instead of a silent success when the spawn dies on boot | S:65 R:85 A:75 D:70 |
| 4 | Confident | 409 on dev builds | The dev serve process's config resolves the dev port; restarting would hijack the real daemon's session | S:60 R:90 A:85 D:80 |
| 5 | Confident | Outcome/error shown inline in the empty state, not as a toast | CodeSurface is injected-seam only; inline note matches the gui empty state's inline "gui turned off" pattern | S:55 R:90 A:75 D:65 |
| 6 | Confident | `rk code-server restart` shares `daemon.RestartCodeServer` with the button | User explicitly asked for the CLI verb; one implementation for both doors | S:90 R:90 A:90 D:85 |
| 7 | Certain | Register `Code: Restart code-server` in the command palette, gated on tile open + unreachable, toasting outcomes | Asked — user confirmed at the adoption checkpoint; Constitution V requires palette parity | S:90 R:85 A:90 D:85 |

7 assumptions (2 certain, 5 confident, 0 tentative, 0 unresolved).
