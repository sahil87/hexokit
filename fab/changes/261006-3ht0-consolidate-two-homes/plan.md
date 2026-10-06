# Plan: Move ~/.rk into the hexokit State Home

**Change**: 261006-3ht0-consolidate-two-homes
**Intake**: `intake.md`

All paths below are relative to the repo root. Go code lives under `app/backend/`. `<state>` means `apphome.NewStateDir()` = `${XDG_STATE_HOME:-~/.local/state}/hexokit`.

## Requirements

### Homes: State-home leaf resolvers

#### R1: Every former `~/.rk` tenant resolves through `internal/apphome`
`internal/apphome` SHALL expose resolvers for the state-home leaves, and every consumer SHALL use them instead of `filepath.Join(home, ".rk", …)`:

| Leaf | Path | Consumer |
|---|---|---|
| VAPID keypair | `<state>/vapid.json` | `internal/push/store.go` `vapidPath` |
| Push subscriptions | `<state>/push-subscriptions.json` | `internal/push/store.go` `subscriptionsPath` |
| code-server managed install | `<state>/code-server/bin` | `internal/codeserver/codeserver.go` `BinDir` |
| code-server profile | `<state>/code-server/profile` | `internal/daemon/codeserver.go` `codeServerProfileDir` |
| Job logs | `<state>/logs/<window>.log` | `internal/daemon/jobs.go` tee path |
| Linux desktop install root | `<state>/desktop` | `internal/desktop/desktop.go` default root (Linux only; macOS stays `/Applications`) |

The resolvers SHALL use the *resolved* state home (`apphome.StateDir()`), so a fresh install and a migrated install agree. Writers create parent dirs as today (`MkdirAll`), keeping `vapid.json` at mode `0600`. `~/.rk` path literals SHALL remain only as migration *sources* (the new move step, `internal/settings`' `~/.rk/settings.yaml` fallback, and `internal/tmux/managedconf.go`'s existing legacy migration).

- **GIVEN** a fresh install with no `~/.rk`
- **WHEN** the push store first generates a VAPID keypair
- **THEN** it is written to `<state>/vapid.json` with mode `0600`
- **AND** no `~/.rk` directory is created

- **GIVEN** `XDG_STATE_HOME=/x`
- **WHEN** `codeserver.BinDir` is resolved
- **THEN** it returns `/x/hexokit/code-server/bin`

#### R2: Constitution Principle II is amended (PATCH)
`fab/project/constitution.md` Principle II SHALL gain a clarifying paragraph (and a PATCH version bump per the constitution's own amendment rules) stating: terminal session data and rk's own session state are derived from tmux and the filesystem; integrations such as code-server keep their own state by their own means; rk-managed assets (the VAPID keypair and push subscriptions, downloaded binaries, job logs) live in the state home alongside the two named carve-outs; none of these is a state store in the principle's sense.

- **GIVEN** the amended constitution
- **WHEN** a reader checks where the VAPID keypair lives
- **THEN** Principle II accounts for it without contradicting the "no state store" rule

### Migration: One-shot `~/.rk` move at daemon start

#### R3: The move runs inside the existing home-migration gate
A new one-shot step (`internal/homemigrate`, e.g. `MoveRKTenants(logger)`, or a sibling package if cleaner) SHALL run from `cmd/rk/serve.go` `migrateHomesUnlessDev`, immediately **after** `migrateHomes(...)`. It therefore inherits: the dev-build skip (`version == "dev"`), the port-busy deferral (a live old daemon may still be using `~/.rk`), and the `RK_CONFIG_DIR` skip (`settings.ConfigRootOverridden()`, checked inside the step as `Migrate` does). The target is always `apphome.NewStateDir()`; if that dir does not exist after `migrateHomes` (state-home migration failed this boot), the whole step SHALL be skipped and logged.

- **GIVEN** a dev build (`version == "dev"`)
- **WHEN** `rk serve` starts
- **THEN** `~/.rk` is not touched

- **GIVEN** the daemon port is already bound
- **WHEN** `rk serve` starts
- **THEN** neither the home migration nor the `~/.rk` move runs this boot

- **GIVEN** `~/.local/state/hexokit` does not exist after `migrateHomes`
- **WHEN** the move step runs
- **THEN** nothing is moved and a warning is logged

#### R4: Tenant moves
The step SHALL move each tenant present in `~/.rk`:

| Source | Destination |
|---|---|
| `~/.rk/vapid.json` | `<new state>/vapid.json` (mode `0600` preserved) |
| `~/.rk/push-subscriptions.json` | `<new state>/push-subscriptions.json` |
| `~/.rk/code-server-bin/` | `<new state>/code-server/bin/` |
| `~/.rk/code-server-profile/` | `<new state>/code-server/profile/` |
| `~/.rk/code-server/` (pre-260813 profile path) | `<new state>/code-server/profile/` — only when `~/.rk/code-server-profile/` is absent; this folds `migrateCodeServerProfile` into the move |
| `~/.rk/<window>.log` (every `*.log` at the top level) | `<new state>/logs/<window>.log` |
| `~/.rk/desktop/` (Linux only) | `<new state>/desktop/` |

And SHALL delete the breadcrumbs `~/.rk/settings.yaml.migrated` and `~/.rk/tmux.d.migrated/`. It SHALL leave every other file in place (notably a hand-edited `~/.rk/tmux.conf` and a not-yet-migrated `~/.rk/settings.yaml`).

**Ordering hazard**: the old profile path `~/.rk/code-server/` and the new grouping dir `<state>/code-server/` share a name but live in different trees; moving `~/.rk/code-server/` lands at `<state>/code-server/profile/`, never at `<state>/code-server/`.

- **GIVEN** `~/.rk/vapid.json`, `~/.rk/code-server-bin/4.139.1/`, `~/.rk/code-server-bin/current -> 4.139.1`, `~/.rk/update.log`
- **WHEN** the step runs
- **THEN** `<state>/vapid.json`, `<state>/code-server/bin/4.139.1/`, `<state>/code-server/bin/current -> 4.139.1` (still relative, still resolving) and `<state>/logs/update.log` exist
- **AND** the sources are gone

- **GIVEN** `~/.rk/code-server/` exists and `~/.rk/code-server-profile/` does not
- **WHEN** the step runs
- **THEN** its contents are at `<state>/code-server/profile/`

#### R5: Safe-move mechanics
Each move SHALL try `os.Rename` first. On `EXDEV` (cross-device), it SHALL copy (preserving modes, and recreating symlinks verbatim rather than following them), verify the copy (same set of relative paths and file sizes), then remove the source. If the destination already exists, the source SHALL be left in place and logged (never overwrite). Every failure is logged and non-fatal; the daemon always continues to start.

- **GIVEN** `<state>/vapid.json` already exists and `~/.rk/vapid.json` also exists
- **WHEN** the step runs
- **THEN** both files are unchanged and a warning names the conflict

- **GIVEN** a rename that fails with `EXDEV`
- **WHEN** the step moves `code-server-bin/`
- **THEN** the tree is copied with the `current` symlink preserved as a relative link, verified, and the source removed

#### R6: code-server is stopped across the move, and the bridge extension is reinstalled
Before moving `code-server-bin/` or a profile dir, if the `rk-code-server` tmux session is running, the step SHALL stop it (`daemon.KillCodeServerSession`, or the same underlying kill). After the moves, it SHALL call the idempotent `codeserver.InstallBridgeExtension` with the bundled VSIX (the same inputs `cmd/rk/code_server.go` `installBridgeExtension` uses), so the code-bridge extension comes up on the bundled version, which uses the hexokit state home. Install failure is logged and non-fatal. The session is then respawned by the normal daemon-start `ensureCodeServer` (`internal/daemon/daemon.go`), which resolves the binary and profile from the new paths. If code-server was not running, the step just moves (the extension install still runs when a managed binary exists).

- **GIVEN** a running `rk-code-server` session spawned from `~/.rk/code-server-bin/current/bin/code-server`
- **WHEN** the daemon starts this release
- **THEN** the session is killed before the move, the bundled VSIX is installed with the managed binary at its new path, and `ensureCodeServer` later spawns code-server with `--user-data-dir <state>/code-server/profile`

- **GIVEN** no managed binary after the move
- **WHEN** the extension step runs
- **THEN** it is skipped with a debug/warn log, never an error

#### R7: Linux desktop integration is regenerated after the move
After moving `~/.rk/desktop/` on Linux, the step SHALL re-run the desktop integration (`internal/desktop/integrate.go`) so the `.desktop` entry's `Exec=` and the `~/.local/bin` symlink point at `<state>/desktop/current/...`. Failure is logged and non-fatal.

- **GIVEN** a Linux install at `~/.rk/desktop/current`
- **WHEN** the step moves it
- **THEN** the `.desktop` entry and `~/.local/bin` link reference `<state>/desktop/current`

#### R8: `~/.rk` ends empty-and-removed, or with `MOVED.md`
After the moves, if `~/.rk` is empty it SHALL be removed. Otherwise the step SHALL write `~/.rk/MOVED.md` (never overwriting an identical file needlessly; rewriting is fine) that: names the two homes (config `~/.config/hexokit/`, state `<state>`); lists what moved where; explains that a `port:` line in `~/.config/hexokit/config.yaml` is the rename pin and may be deleted to adopt the default 6123, with the caveats (desktop `hosts.json` entries stored as `http://127.0.0.1:3000`, per-viewer localStorage preferences / PWA installs / Web Push subscriptions scoped to the old address start empty, a `tailscale serve` or reverse proxy forwarding to `:3000`, bookmarks); and says the remaining files are the user's and the folder is safe to delete once handled.

- **GIVEN** `~/.rk` holds only movable tenants
- **WHEN** the step completes
- **THEN** `~/.rk` no longer exists

- **GIVEN** `~/.rk/tmux.conf` is hand-edited
- **WHEN** the step completes
- **THEN** `~/.rk/tmux.conf` is untouched and `~/.rk/MOVED.md` exists

### Pruning: managed install versions

#### R9: Keep current + previous versions
A shared helper (e.g. in a small internal package both callers can import) SHALL delete every `<root>/<version>/` dir except the `current` symlink's target and the "previous" version. "Previous" is the version `current` pointed at before the flip, passed by the caller; with no flip history (the one-shot run during the move, or a caller without a prior target), it is the highest-semver version strictly below current. The helper SHALL never delete the `current` target, SHALL ignore non-version entries (e.g. `current` itself, temp/staging dirs it does not recognize as versions), and SHALL be best-effort (log and continue). It SHALL run:
- after `rk code-server install`/`update` flips `current` (`internal/codeserver/install.go` or its caller), on `<state>/code-server/bin`;
- after `rk desktop` install/update flips `current` on Linux, on `<state>/desktop`;
- once during the move step, on both roots.

- **GIVEN** versions 4.134.0 … 4.139.1 with `current -> 4.139.1` and no flip history
- **WHEN** the helper runs
- **THEN** only `4.139.1/` and `4.138.x/` (the highest below current) remain

- **GIVEN** an update flips `current` from 4.139.1 to 4.140.0
- **WHEN** the helper runs with previous = 4.139.1
- **THEN** only `4.140.0/` and `4.139.1/` remain

### Surfaces

#### R10: `rk doctor` reports `~/.rk`
`cmd/rk/doctor.go` SHALL add a `~/.rk` row: absent (ok); present with `MOVED.md` and the remaining user-owned files listed; or present with a tenant held back because its destination already existed (warn, naming it). The existing `port pin` row and the legacy `~/.rk/tmux.conf` recipe stay. Rows that describe the managed code-server install SHALL name the new path.

- **GIVEN** `~/.rk` does not exist
- **WHEN** `rk doctor` runs
- **THEN** the `~/.rk` row reports it absent without a warning

#### R11: Help text and comments name the new paths
Help text and comments describing current behavior SHALL name the state-home paths instead of `~/.rk`: `cmd/rk/code_server.go`, `cmd/rk/desktop.go` (including the `--path` flag defaults on Linux), `cmd/rk/upgrade.go`, `cmd/rk/daemon_run.go` (log tee path), `internal/codeserver/{codeserver,install}.go` package docs, `internal/daemon/{codeserver,jobs}.go`, `internal/push/store.go`, `api/restart.go`, `api/waiting_push.go`, and `app/frontend/src/hooks/use-global-palette-actions.ts` ("failures land in ~/.rk logs"). Help text follows the toolkit standards (`shll standards`) per the constitution — wording tweaks only, no flag changes. Display strings use `~/.local/state/hexokit/...` (the default) in prose.

- **GIVEN** `rk desktop install --help` on Linux
- **WHEN** a user reads the `--path` default
- **THEN** it names `~/.local/state/hexokit/desktop`

### Non-Goals

- Deleting `~/.config/run-kit/` or `~/.local/state/run-kit/`, or dropping the code-bridge legacy readers — change `261006-lwt6-delete-stale-runkit-homes`.
- Retiring the `run-kit-desktop` Electron userData — change `261006-gy29-retire-runkit-desktop-userdata`.
- Changing `internal/settings`' `~/.rk/settings.yaml` fallback or `internal/tmux/managedconf.go`'s legacy migration — they remain migration sources.
- Downgrade support — the move is one-way (user: "no one is going to downgrade").
- Moving code-server's extensions dir — it stays at code-server's default (`$XDG_DATA_HOME/code-server/extensions`), owned by code-server.

### Design Decisions

#### Run the `~/.rk` move inside `migrateHomesUnlessDev`
**Decision**: Call the move right after `migrateHomes` in `cmd/rk/serve.go` `migrateHomesUnlessDev`.
**Why**: It inherits the dev-build skip and the port-busy deferral. A live old daemon (same `rk-daemon` session after a brew upgrade) still reads `~/.rk/vapid.json`, so moving while it runs would make it regenerate a keypair.
**Rejected**: A separate call site in the serve `RunE` — duplicates the gates and risks drift.
*Introduced by*: 261006-3ht0-consolidate-two-homes

#### Let `ensureCodeServer` respawn code-server after the move
**Decision**: The move step only kills the `rk-code-server` session and installs the bundled VSIX; the existing daemon-start `ensureCodeServer` respawns it from the new paths.
**Why**: `RestartCodeServer` requires a running daemon and re-runs the ensure ladder the daemon start runs anyway; one spawn path is simpler and cannot disagree with itself.
**Rejected**: Calling `RestartCodeServer` from the move step — double spawn logic during startup.
*Introduced by*: 261006-3ht0-consolidate-two-homes

#### Group code-server files under `<state>/code-server/`
**Decision**: `code-server/bin/` and `code-server/profile/` instead of flat `code-server-bin/` and `code-server-profile/`.
**Why**: User preference — all code-server files in one folder.
**Rejected**: Keeping the leaf names unchanged (flat) — slightly simpler move, but scatters code-server across the state root.
*Introduced by*: 261006-3ht0-consolidate-two-homes

## Tasks

### Phase 1: Setup

- [x] T001 Add state-home leaf resolvers to `app/backend/internal/apphome/apphome.go` (e.g. `VAPIDPath`, `PushSubscriptionsPath`, `CodeServerBinDir`, `CodeServerProfileDir`, `LogsDir`, `DesktopDir`, or a single `StateLeaf(parts...)` helper — follow the package's existing style), each built on `StateDir()`; unit tests in `apphome_test.go` under a temp `$HOME`/`$XDG_STATE_HOME` <!-- R1 -->
- [x] T002 [P] Amend Principle II in `fab/project/constitution.md` with the clarifying paragraph and a PATCH version bump per its amendment rules <!-- R2 -->

### Phase 2: Core Implementation

- [x] T003 [P] Point `internal/push/store.go` `vapidPath`/`subscriptionsPath` at the apphome resolvers (drop `rkDir`; create the state dir as needed; keep `0600` on the keypair); update its tests <!-- R1 -->
- [x] T004 [P] Point `internal/codeserver/codeserver.go` `BinDir` at `<state>/code-server/bin`; update package docs and tests (`internal/codeserver/*_test.go`) <!-- R1 -->
- [x] T005 [P] Point `internal/daemon/codeserver.go` `codeServerProfileDir` at `<state>/code-server/profile`; remove `migrateCodeServerProfile`/`codeServerLegacyProfileDir` and its call in `ensureCodeServerCore` (folded into the move); update tests <!-- R1, R4 -->
- [x] T006 [P] Point `internal/daemon/jobs.go` tee path at `<state>/logs/<window>.log` (create `logs/`); update tests <!-- R1 -->
- [x] T007 [P] Point `internal/desktop/desktop.go` Linux default root at `<state>/desktop`; update tests <!-- R1 -->
- [x] T008 Implement the pruning helper (keep current + previous; semver fallback; ignores non-version entries; best-effort) with unit tests <!-- R9 -->
- [x] T009 Implement the move step in `internal/homemigrate` (new file, e.g. `rkhome.go`): gating (RK_CONFIG_DIR skip, new state dir must exist), tenant table, breadcrumb deletion, safe-move helper (rename → EXDEV copy+verify+remove, symlink-preserving, never overwrite), `~/.rk` empty-removal or `MOVED.md` writing <!-- R3, R4, R5, R8 -->
- [x] T010 Add the code-server stop + bridge-extension install around the move: kill the `rk-code-server` session before moving bin/profile (expose a seam so tests stub it), then `codeserver.InstallBridgeExtension` with the bundled VSIX and managed binary; injected as funcs to avoid an import cycle if needed <!-- R6 -->
- [x] T011 Re-run Linux desktop integration (`internal/desktop/integrate.go`) after moving `desktop/`; seam for tests <!-- R7 -->
- [x] T012 Run the pruning helper once on both roots at the end of the move step <!-- R9 -->

### Phase 3: Integration & Edge Cases

- [x] T013 Wire the move into `app/backend/cmd/rk/serve.go` `migrateHomesUnlessDev` right after `migrateHomes(...)`, behind a package var seam like `migrateHomes`; extend the dev-gate/port-busy tests so the move is skipped exactly when the migration is <!-- R3 -->
- [x] T014 Call the pruning helper after the `current` flip in `rk code-server install`/`update` (pass the pre-flip target as previous) and in Linux `rk desktop` install/update <!-- R9 -->
- [x] T015 Go tests for the move step over temp `$HOME`/`$XDG_STATE_HOME`: each tenant (incl. pre-260813 profile, `push-subscriptions.json`, logs), relative `current` link still resolving, EXDEV fallback (inject the rename func), never-overwrite, skip when new state dir is missing, RK_CONFIG_DIR skip, empty-removal vs `MOVED.md`, kill → move → extension-install ordering, prune on both roots <!-- R3, R4, R5, R6, R8, R9 -->
- [x] T016 Add the `~/.rk` row to `app/backend/cmd/rk/doctor.go` (absent / MOVED.md + remaining files / held-back tenant) and update the code-server source row's path text; tests <!-- R10 -->

### Phase 4: Polish

- [x] T017 [P] Update help text and comments to the new paths: `cmd/rk/{code_server,desktop,upgrade,daemon_run}.go`, `internal/codeserver/install.go`, `internal/daemon/{codeserver,jobs}.go`, `internal/push/store.go`, `api/restart.go`, `api/waiting_push.go`, `app/frontend/src/hooks/use-global-palette-actions.ts`; run `shll standards` (if available) for help-text conventions <!-- R11 -->
- [x] T018 Final sweep: `grep -rn '\.rk' app/backend --include='*.go'` shows only migration sources (move step, `internal/settings`, `internal/tmux/managedconf.go`) and tests; run `go build ./...`, `go vet ./...`, and the affected package tests (`internal/apphome`, `internal/homemigrate`, `internal/push`, `internal/codeserver`, `internal/daemon`, `internal/desktop`, `cmd/rk`) <!-- R1, R11 -->

## Execution Order

- T001 blocks T003–T007 and T009.
- T008 blocks T012 and T014.
- T009 blocks T010–T013 and T015.

## Acceptance

### Functional Completeness

- [x] A-001 R1: All six leaves resolve through `internal/apphome`; no consumer builds a `~/.rk` path except the listed migration sources
- [x] A-002 R2: Principle II carries the clarifying paragraph and the constitution version is PATCH-bumped
- [x] A-003 R3: The move is invoked only from `migrateHomesUnlessDev`, after `migrateHomes`, and skips under RK_CONFIG_DIR and when the new state dir is missing
- [x] A-004 R4: Every tenant in the table moves to its destination, breadcrumbs are deleted, user-owned files stay
- [x] A-005 R5: Moves are rename-first with a verified EXDEV copy fallback and never overwrite
- [x] A-006 R6: The code-server session is stopped before moving bin/profile and the bundled VSIX install runs after
- [x] A-007 R7: Linux desktop integration is regenerated after moving `desktop/`
- [x] A-008 R8: `~/.rk` is removed when empty, else `MOVED.md` is written with the homes, the move map, the port-pin note and caveats
- [x] A-009 R9: The prune helper keeps exactly current + previous and runs after code-server and Linux desktop flips and once in the move
- [x] A-010 R10: `rk doctor` has a `~/.rk` row covering the three states
- [x] A-011 R11: Help text and comments name the state-home paths

### Behavioral Correctness

- [x] A-012 R1: A fresh install never creates `~/.rk`
- [x] A-013 R6: After the move, code-server is spawned with `--user-data-dir <state>/code-server/profile` and the managed binary under `<state>/code-server/bin/current`

### Removal Verification

- [x] A-014 R4: `migrateCodeServerProfile` and `codeServerLegacyProfileDir` are gone; the pre-260813 path is handled only by the move step

### Scenario Coverage

- [x] A-015 R4: Tests cover each tenant move, including the relative `current` link still resolving
- [x] A-016 R3: Tests cover the dev-build skip, port-busy deferral, RK_CONFIG_DIR skip and missing-state-dir skip
- [x] A-017 R9: Tests cover prune with and without flip history

### Edge Cases & Error Handling

- [x] A-018 R5: A destination conflict leaves both sides untouched and is logged; EXDEV is exercised through an injected rename
- [x] A-019 R6: A missing managed binary or a failed VSIX install never fails the daemon start
- [x] A-020 R4: `~/.rk/code-server/` (old profile) never lands at `<state>/code-server/` itself

### Code Quality

- [x] A-021 Pattern consistency: New code follows the naming, seam (package-var) and best-effort logging patterns of `internal/homemigrate` and `cmd/rk/serve.go`
- [x] A-022 No unnecessary duplication: One shared prune helper and one safe-move helper; resolvers live only in `internal/apphome`

### Security

- [x] A-023 R5: The VAPID keypair keeps mode `0600` through rename and EXDEV copy; symlinks are recreated, never followed during copy

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None discovered — the planned removals (`migrateCodeServerProfile`/`codeServerLegacyProfileDir` in `internal/daemon/codeserver.go`, `pruneLinuxVersions` in `internal/desktop/linux.go`, the `jobUserHomeDir`/`rkDir` seams) were all executed by apply and are covered by `### Removal Verification` (A-014). No other existing code was made redundant: the `~/.rk` literals that remain (`internal/settings`, `internal/tmux/managedconf.go`) are deliberate migration sources per Non-Goals.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `push-subscriptions.json` moves with `vapid.json` | Not in the intake's inventory, but `internal/push/store.go` keeps it in `~/.rk`; leaving it behind loses every subscription | S:60 R:60 A:90 D:85 |
| 2 | Confident | The move runs inside `migrateHomesUnlessDev`, inheriting the dev gate and port-busy deferral | A live old daemon still uses `~/.rk`; the deferral exists for exactly this hazard | S:70 R:70 A:85 D:80 |
| 3 | Confident | Kill the session and let daemon-start `ensureCodeServer` respawn it, rather than calling `RestartCodeServer` | `RestartCodeServer` requires a running daemon and duplicates the ensure ladder the daemon start runs anyway | S:60 R:75 A:80 D:70 |
| 4 | Confident | Resolvers use the resolved `apphome.StateDir()`; the move targets `apphome.NewStateDir()` | Resolved dir equals the new dir once the move has run (the move requires the new dir to exist) | S:70 R:70 A:80 D:75 |
| 5 | Confident | code-server's extensions dir is not moved | It is code-server's own default location, pinned so user extensions stay visible | S:60 R:80 A:85 D:85 |

5 assumptions (0 certain, 5 confident, 0 tentative).
