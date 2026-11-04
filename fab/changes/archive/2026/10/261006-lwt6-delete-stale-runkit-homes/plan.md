# Plan: Delete the Stale run-kit Homes

**Change**: 261006-lwt6-delete-stale-runkit-homes
**Intake**: `intake.md`

## Requirements

### Daemon start: Legacy-home deletion

#### R1: Delete each stale run-kit home at release daemon start
At release daemon start, after `homemigrate.Migrate` and `homemigrate.MoveRKTenants`, rk SHALL delete the legacy config home (`$HOME/.config/run-kit`) and the legacy state home (`${XDG_STATE_HOME:-$HOME/.local/state}/run-kit`) with `os.RemoveAll`, each independently, when every guard (R2) holds for that home. The deletion SHALL share the migration's call-site gates (skipped on dev builds where `version == "dev"`, deferred while the daemon port is busy) and SHALL be skipped under the `RK_CONFIG_DIR` test override. It is best-effort and non-fatal: every failure logs a warning and the daemon keeps starting. A legacy home that is itself a symlink SHALL have only the link removed (its target untouched); symlinks inside the tree are removed as links and their targets are untouched. Each deletion and each hold-back SHALL be logged.

- **GIVEN** a migrated install (`~/.config/hexokit/` and `<state>/hexokit/` exist) with stale `~/.config/run-kit/` and `<state>/run-kit/` present and no guard holding
- **WHEN** the release daemon starts
- **THEN** both legacy homes are gone and both hexokit homes are untouched
- **AND** a `~/.config/run-kit/config.yaml` that is a symlink into a dotfiles repo is removed as a link; its target file still exists

- **GIVEN** `<state>/run-kit` is a symlink to another directory
- **WHEN** the deletion runs with no guard holding
- **THEN** the symlink is removed and the directory it pointed to (and its contents) still exists

- **GIVEN** `RK_CONFIG_DIR` is set
- **WHEN** the deletion runs
- **THEN** nothing on disk changes

#### R2: Per-home guards
A legacy home SHALL be left whole this boot (and the reason logged) unless all of these hold:
1. The corresponding hexokit home exists as a directory.
2. The hexokit home does not resolve into the legacy tree (its real path is neither the legacy home's real path nor inside it).
3. No symlink anywhere inside the hexokit home resolves (lexically — relative targets against the link's own dir) to the legacy home or a path inside it.

- **GIVEN** a legacy config home and no `~/.config/hexokit/` (the migration failed)
- **WHEN** the deletion runs
- **THEN** the legacy config home is untouched and the hold reason names the missing hexokit home

- **GIVEN** `~/.config/hexokit/tmux.d/x.conf` is a symlink with absolute target `~/.config/run-kit/tmux.d/x.conf`
- **WHEN** the deletion runs
- **THEN** `~/.config/run-kit/` is untouched and the hold reason names the link
- **AND** the legacy state home is still evaluated (and deleted) on its own guards

#### R3: Live legacy code-bridge host keeps only `cb/`
For the state home only: when a live code-bridge host (pid alive AND socket answers `__ping`, per `codebridge.LiveHosts`) is registered under `<legacy state>/cb/hosts/`, rk SHALL delete every other entry of the legacy state home and keep `cb/`. A later boot whose check finds no live host there SHALL remove the rest (the whole legacy state home). This guard never holds back the rest of the legacy state home. When the legacy state root is itself a symlink and a live host is registered, the whole home SHALL be left alone this boot (removing the link would pull `cb/` out from under the host).

- **GIVEN** a legacy state home holding `cron/`, `snapshots/`, `prstatus.json`, `cb/hosts/h1.json` where h1 is live
- **WHEN** the deletion runs
- **THEN** only `<legacy state>/cb/` remains
- **AND** on a later run where h1 is dead, `<legacy state>/` is gone

### rk doctor: Legacy-home rows

#### R4: One row per legacy home
`rk doctor` SHALL report a row per legacy home — `legacy config home` and `legacy state home` — always OK-shaped (informational; doctor diagnoses, the daemon start heals). The note SHALL read `absent` when the home is gone; otherwise it SHALL name the path and either the guard that holds it back, the retained `cb/` (a live code-bridge host), or that it will be deleted at the next daemon start. The existing `port pin` row is unchanged.

- **GIVEN** no legacy homes exist
- **WHEN** `rk doctor` runs
- **THEN** both rows read `absent`

- **GIVEN** a legacy config home whose deletion is held back by a hexokit-home symlink into it
- **WHEN** `rk doctor` runs
- **THEN** the `legacy config home` row's note names that link

### Code bridge: Legacy read window closes

#### R5: Go-side discovery reads only the resolved cb dir
`ReadRecordsMerged`, `ReadBootMarkersMerged`, `LiveHostsMerged`, `readMergedDirs`, and `discoveryDirs` SHALL be removed; their callers (`api/codebridge.go`, `cmd/rk/code.go` `codeLiveHosts`, `cmd/rk/doctor.go` `codeBridgeLiveHostCount`) SHALL resolve `codebridge.HostsDir()` / `codebridge.BootsDir()` and call the single-dir `ReadRecords` / `ReadBootMarkers` / `LiveHosts`.

- **GIVEN** a migrated state home and a host record only under `<state>/run-kit/cb/hosts/`
- **WHEN** `rk code hosts` (or the tab-state API) enumerates hosts
- **THEN** the legacy record is not seen

#### R6: Extension resolves only the hexokit cb dir
`app/code-bridge/src/state-dir.ts` `stateDir()` SHALL return `<$XDG_STATE_HOME or ~/.local/state>/hexokit/cb` unconditionally; `LEGACY_HOME_DIR_NAME` and the legacy branch SHALL be removed.

- **GIVEN** only `<base>/run-kit` exists
- **WHEN** `stateDir()` is called
- **THEN** it returns `<base>/hexokit/cb`

### Skip-release migration code is kept

#### R7: Keep the skip-release path
`homemigrate.Migrate`, `apphome`'s dual-read `resolve()` legacy branch, and `apphome.UnmigratedExistingInstall` (and config's virtual port pin) SHALL be kept. Their doc comments SHALL describe them as the skip-release path (a pre-rename install jumping straight to this release) rather than a one-release window, and SHALL no longer claim the legacy trees stay byte-unchanged.

- **GIVEN** a pre-rename install (only `~/.config/run-kit/` with `config.yaml`, and `<state>/run-kit/` with `cron/`)
- **WHEN** one daemon start runs `Migrate`, then the deletion
- **THEN** `~/.config/hexokit/config.yaml` holds the user's config plus the port pin, `<state>/hexokit/cron/` holds the cron entries, and both legacy homes are gone

### Non-Goals

- Retiring the desktop app's old userData — separate change `261006-gy29-retire-runkit-desktop-userdata`.
- Removing `homemigrate`, apphome dual-read, or the virtual port pin — kept for skip-release users (R7).

### Design Decisions

#### Deletion lives in `homemigrate`, guard evaluation shared with doctor
**Decision**: A new `internal/homemigrate/legacyhomes.go` exports a read-only guard evaluation (`LegacyHomes`) that both `DeleteLegacyHomes` and `rk doctor` consume.
**Why**: The doctor row must report exactly the guard the deletion would hit; one evaluator means they cannot drift (the `RKTenants` table posture).
**Rejected**: A separate package — `homemigrate` already owns the legacy-home lifecycle and imports `codebridge`.
*Introduced by*: 261006-lwt6-delete-stale-runkit-homes

#### Go cb discovery keeps resolving through `apphome.StateDir`
**Decision**: `codebridge.StateDir` keeps the resolved state home; only the extra legacy leaf is dropped.
**Why**: In the (narrow) unmigrated window an old VSIX still writes the resolved legacy `cb/`, and the resolved rule keeps it reachable; in every migrated install resolved == hexokit, matching the extension.
**Rejected**: Pinning Go to `apphome.NewStateDir()` — would break the old-VSIX case without fixing any migrated case.
*Introduced by*: 261006-lwt6-delete-stale-runkit-homes

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `app/backend/internal/homemigrate/legacyhomes.go`: `LegacyHomeState` (home label, path, present, symlinked-root, hold reason, keep-cb), `LegacyHomes(ctx)` read-only guard evaluation for config + state (R2 guards; R3 live-host check via a `legacyLiveHostsFn` seam defaulting to `codebridge.LiveHosts` over `<legacy state>/cb/hosts`), and `DeleteLegacyHomes(logger)` (RK_CONFIG_DIR skip, RemoveAll / link-only removal, keep-`cb/` partial delete, logging). <!-- R1 R2 R3 -->
- [x] T002 Add `app/backend/internal/homemigrate/legacyhomes_test.go` covering: happy path both homes; missing hexokit home; hexokit symlink into legacy (absolute and relative); hexokit home itself a symlink into legacy; inner `config.yaml` symlink target survives; symlinked legacy root removes link only; live legacy cb host keeps only `cb/` then later boot removes all; symlinked legacy state root + live host left whole; `RK_CONFIG_DIR` skip; skip-release path (`Migrate` then `DeleteLegacyHomes` on one run). <!-- R1 R2 R3 R7 -->
- [x] T003 Wire `deleteLegacyHomes = homemigrate.DeleteLegacyHomes` seam into `app/backend/cmd/rk/serve.go` `migrateHomesUnlessDev`, after `moveRKTenants`; extend `app/backend/cmd/rk/serve_migrate_test.go` call-order/gate assertions. <!-- R1 -->
- [x] T004 Remove the code-bridge legacy read window: delete `discoveryDirs` (`internal/codebridge/state.go`), `ReadRecordsMerged`/`readMergedDirs` (`record.go`), `ReadBootMarkersMerged` (`boots.go`), `LiveHostsMerged` (`resolve.go`), and `internal/codebridge/dualread_test.go`; restore single-dir callers in `app/backend/api/codebridge.go`, `app/backend/cmd/rk/code.go` (`codeLiveHosts`), `app/backend/cmd/rk/doctor.go` (`codeBridgeLiveHostCount`); fix any tests referencing the removed functions. <!-- R5 -->
- [x] T005 [P] Drop the legacy branch from `app/code-bridge/src/state-dir.ts` (and `LEGACY_HOME_DIR_NAME`); update `app/code-bridge/test/state-dir.test.ts` (legacy-only home now resolves hexokit). <!-- R6 -->

### Phase 2: Integration & Polish

- [x] T006 Add the two `rk doctor` rows (`legacy config home`, `legacy state home`) in `app/backend/cmd/rk/doctor.go` via a seam over `homemigrate.LegacyHomes`, placed next to the `~/.rk` row; pure note formatter with table tests in `app/backend/cmd/rk/doctor_test.go`. <!-- R4 -->
- [x] T007 Update doc comments: `internal/homemigrate/homemigrate.go` package doc (no more "byte-unchanged"/downgrade claim; the deletion follows on the same boot), `internal/apphome/apphome.go` (dual-read + `LegacyName` kept as the skip-release path), `internal/homemigrate/rkhome.go` comment naming "change lwt6" (no change IDs in comments), `internal/codebridge/state.go` `StateDir` comment if it references dual-read. <!-- R7 -->

## Execution Order

- T001 blocks T002, T003, T006
- T004 and T005 are independent of T001

## Acceptance

### Functional Completeness

- [x] A-001 R1: `DeleteLegacyHomes` runs in `migrateHomesUnlessDev` after `migrateHomes` and `moveRKTenants`, inheriting the dev-build skip and port-busy deferral
- [x] A-002 R1: Legacy homes are removed with `os.RemoveAll` / link-only removal; failures only log
- [x] A-003 R2: All three per-home guards are evaluated independently per home, and a held home is logged with its reason
- [x] A-004 R3: A live legacy cb host retains exactly `cb/` and the rest of the legacy state home is deleted
- [x] A-005 R4: `rk doctor` emits `legacy config home` and `legacy state home` rows, OK-shaped, with absent / held-reason / retained-cb / pending-deletion notes
- [x] A-006 R5: No Go code reads `<state>/run-kit/cb`; the `*Merged` readers and `discoveryDirs` are gone
- [x] A-007 R6: `stateDir()` returns `<base>/hexokit/cb` regardless of a legacy home
- [x] A-008 R7: `homemigrate.Migrate`, apphome dual-read `resolve()`, and `UnmigratedExistingInstall` are unchanged in behavior

### Behavioral Correctness

- [x] A-009 R5: `rk code hosts`/`rk code exec`, the tab code-state API, and doctor's code-bridge host count enumerate only the resolved cb dir
- [x] A-010 R7: Package docs no longer claim the legacy trees stay byte-unchanged or that dual-read lasts one release

### Removal Verification

- [x] A-011 R5: `dualread_test.go` and every reference to the removed functions are gone; `go build ./...` and `go vet ./...` pass
- [x] A-012 R6: `LEGACY_HOME_DIR_NAME` is gone from the extension sources

### Scenario Coverage

- [x] A-013 R1: Tests cover happy path, inner-symlink target survival, symlinked legacy root, and the `RK_CONFIG_DIR` skip
- [x] A-014 R2: Tests cover missing hexokit home, hexokit-home symlink into legacy (absolute + relative), and hexokit home resolving into legacy
- [x] A-015 R3: Tests cover live cb host (keep `cb/`), later boot with dead host (full delete), and symlinked legacy state root + live host (left whole)
- [x] A-016 R7: A test runs `Migrate` then `DeleteLegacyHomes` on a pre-rename layout and asserts the migrated content plus pin and both legacy homes gone
- [x] A-017 R4: Doctor note formatter has table tests for each note shape

### Edge Cases & Error Handling

- [x] A-018 R2: An unresolvable home path or unreadable hexokit tree holds the home back rather than deleting
- [x] A-019 R3: An error reading the legacy cb hosts dir (other than not-exist) is treated as a live host (keep `cb/`), never as "no host"

### Code Quality

- [x] A-020 Pattern consistency: New code follows `homemigrate`'s seam-var, logging, and best-effort posture and the doctor's OK-shaped row pattern
- [x] A-021 No unnecessary duplication: Existing helpers (`exists`, `isDir`, `linkStaysInside`, `codebridge.LiveHosts`, `apphome` resolvers) are reused
- [x] A-022 Readability: No god functions (>50 lines without clear reason); guard evaluation and deletion are separate functions
- [x] A-023 Tests: New behavior is covered by Go unit tests and the extension's node tests
- [x] A-024 Comments: No comment narration and no change IDs / PR numbers in comments

### Security

- [x] A-025 R1: Deletion never follows a symlink out of the legacy tree (top-level link removed as a link; `RemoveAll` does not traverse inner links)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — apply already removed the code this change made redundant (`discoveryDirs`, `ReadRecordsMerged`/`readMergedDirs`, `ReadBootMarkersMerged`, `LiveHostsMerged`, `internal/codebridge/dualread_test.go`, the extension's `LEGACY_HOME_DIR_NAME` legacy branch, and the e2e test's `hmHashTrees` byte-unchanged digest helper). No further dead code found; `homemigrate`, apphome dual-read, and the port pin stay deliberately (R7 skip-release path).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Deletion + guard evaluation live in a new `internal/homemigrate/legacyhomes.go`; `rk doctor` consumes the same evaluator | Intake names homemigrate "or a sibling package"; one evaluator keeps doctor and deletion in lockstep | S:75 R:80 A:85 D:80 |
| 2 | Confident | Added a guard: the hexokit home's real path must not resolve into the legacy tree | A user symlinking `~/.config/hexokit` → `run-kit` would otherwise lose everything; same intent as intake guard 2 | S:60 R:40 A:85 D:80 |
| 3 | Confident | Symlinked legacy state root + live legacy cb host → leave the whole home alone this boot | Intake: symlinked root removes the link only; removing it under a live host contradicts guard 3 | S:55 R:70 A:80 D:75 |
| 4 | Confident | Error reading the legacy cb hosts dir counts as a live host (keep `cb/`) | Conservative under a deleting operation; costs at most one more boot | S:55 R:75 A:85 D:80 |
| 5 | Confident | Go cb discovery keeps resolving via `apphome.StateDir`; merged readers replaced by single-dir reads at the three call sites (pre-rename shape) | Keeps an old VSIX reachable in the unmigrated window; migrated installs resolve hexokit either way | S:65 R:80 A:80 D:75 |
| 6 | Confident | Doctor rows named `legacy config home` / `legacy state home`, always OK-shaped | Intake asks for a row per home; matches the `~/.rk` row's informational posture | S:70 R:90 A:85 D:70 |
| 7 | Tentative | A new VSIX installed while the legacy state home is still active (migration failed + manual `rk code-server update`) creates `<state>/hexokit/cb`, which satisfies guard 1 and lets the legacy state home (unmigrated cron/snapshots) be deleted; accepted, not mitigated | Requires a failed migration plus a manual extension update; the intake explicitly drops the extension's legacy branch. Flagged for the user | S:40 R:30 A:60 D:55 |

7 assumptions (0 certain, 6 confident, 1 tentative).
